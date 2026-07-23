import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from flask import Flask, jsonify, request, send_from_directory
from psycopg2.extras import RealDictCursor

if __package__:
    from .infrastructure import (
        CONFIG_PATH,
        TtlCache,
        apply_query_timeout,
        db_error_response,
        get_db_connection,
        get_agent_names,
        get_game_names,
        is_player_daily_available,
        load_config,
        release_db_connection,
    )
    from .daily_backfill import start_daily_backfill_scheduler
    from .feature_flags import is_sync_and_scheduling_enabled
    from .player_filters import (
        get_date_range_values,
        parse_optional_slot_id,
        parse_player_filters,
        validate_date_range,
    )
    from .security import configure_authentication
    from .server_audit import INFO, configure_server_action_logging, write_server_action
    from .slot_parent_bet_sync import start_slot_parent_bet_sync
else:
    from infrastructure import (
        CONFIG_PATH,
        TtlCache,
        apply_query_timeout,
        db_error_response,
        get_db_connection,
        get_agent_names,
        get_game_names,
        is_player_daily_available,
        load_config,
        release_db_connection,
    )
    from daily_backfill import start_daily_backfill_scheduler
    from feature_flags import is_sync_and_scheduling_enabled
    from player_filters import (
        get_date_range_values,
        parse_optional_slot_id,
        parse_player_filters,
        validate_date_range,
    )
    from security import configure_authentication
    from server_audit import INFO, configure_server_action_logging, write_server_action
    from slot_parent_bet_sync import start_slot_parent_bet_sync

# 初始化 Flask 應用，設定靜態檔案目錄為專案的 web 資料夾
app = Flask(__name__, static_folder=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'web')))
configure_server_action_logging(app)
configure_authentication(app)

dates_cache = TtlCache(ttl_seconds=300)


def get_home_dashboard_cache_ttl():
    """Keep the overview cache aligned with the configured DB sync cadence."""
    try:
        sync_config = load_config().get("slotParentBetSync", {})
        return max(60, int(sync_config.get("interval_seconds", 60)))
    except (AttributeError, TypeError, ValueError):
        return 60


home_dashboard_cache = TtlCache(ttl_seconds=get_home_dashboard_cache_ttl())
# Player filters are commonly submitted repeatedly while navigating back to the
# analysis page. Keep this cache short because today's betting rows are live.
players_cache = TtlCache(ttl_seconds=30, max_entries=256)
player_games_cache = TtlCache(ttl_seconds=60, max_entries=128)

LOCAL_TIME_ZONE = ZoneInfo("Asia/Taipei")

CASINO_DAILY_METRICS_CTE = """
    WITH raw_available AS (
        SELECT EXISTS (
            SELECT 1
            FROM public.slot_parent_bet
            WHERE bet_at_utc7 >= %(today)s AND bet_at_utc7 < %(today)s + 1
        ) AS has_rows
    ),
    today_players AS (
        SELECT
            p.player_id,
            NOT EXISTS (
                SELECT 1
                FROM public.slot_parent_bet previous
                WHERE previous.player_id = p.player_id
                  AND previous.bet_at_utc7 < %(today)s
            ) AS is_new
        FROM public.slot_parent_bet p
        WHERE p.bet_at_utc7 >= %(today)s AND p.bet_at_utc7 < %(today)s + 1
          AND %(today)s BETWEEN %(start_day)s AND %(end_day)s
        GROUP BY p.player_id
    ),
    raw_today AS (
        SELECT
            %(today)s::date AS date,
            COUNT(DISTINCT p.player_id)::INT8 AS player_count,
            (SELECT COUNT(*)::INT8 FROM today_players WHERE is_new) AS dnu,
            0::NUMERIC AS retention_1,
            0::NUMERIC AS retention_3,
            0::NUMERIC AS retention_7,
            COUNT(*)::INT8 AS total_spin_count,
            COALESCE(SUM(p.bet_amount), 0) AS total_bet_amount,
            COALESCE(SUM(p.total_prize), 0) AS total_win_amount,
            COALESCE(SUM(p.total_prize) / NULLIF(SUM(p.bet_amount), 0), 0) AS rtp,
            COALESCE(AVG(p.total_prize / NULLIF(p.bet_amount, 0)), 0) AS odd_rtp,
            COUNT(DISTINCT p.player_id) FILTER (WHERE p.bet_type = 1)::INT8 AS bet_1_player_count,
            COALESCE(COUNT(*) FILTER (WHERE p.bet_type = 1)::NUMERIC
                / NULLIF(COUNT(DISTINCT p.player_id) FILTER (WHERE p.bet_type = 1), 0), 0)
                AS bet_1_player_avg_bet_count,
            COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 1)
                / NULLIF(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 1), 0), 0) AS bet_1_rtp,
            COUNT(DISTINCT p.player_id) FILTER (WHERE p.bet_type = 2)::INT8 AS bet_2_player_count,
            COALESCE(COUNT(*) FILTER (WHERE p.bet_type = 2)::NUMERIC
                / NULLIF(COUNT(DISTINCT p.player_id) FILTER (WHERE p.bet_type = 2), 0), 0)
                AS bet_2_player_avg_bet_count,
            COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 2)
                / NULLIF(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 2), 0), 0) AS bet_2_rtp,
            COUNT(DISTINCT p.player_id) FILTER (WHERE p.bet_type = 3)::INT8 AS bet_3_player_count,
            COALESCE(COUNT(*) FILTER (WHERE p.bet_type = 3)::NUMERIC
                / NULLIF(COUNT(DISTINCT p.player_id) FILTER (WHERE p.bet_type = 3), 0), 0)
                AS bet_3_player_avg_bet_count,
            COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 3)
                / NULLIF(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 3), 0), 0) AS bet_3_rtp
        FROM public.slot_parent_bet p
        WHERE p.bet_at_utc7 >= %(today)s AND p.bet_at_utc7 < %(today)s + 1
          AND %(today)s BETWEEN %(start_day)s AND %(end_day)s
        HAVING COUNT(*) > 0
    ),
    combined AS (
        SELECT
            date, player_count, dnu, retention_1, retention_3, retention_7,
            total_spin_count, total_bet_amount, total_win_amount, rtp, odd_rtp,
            bet_1_player_count, bet_1_player_avg_bet_count, bet_1_rtp,
            bet_2_player_count, bet_2_player_avg_bet_count, bet_2_rtp,
            bet_3_player_count, bet_3_player_avg_bet_count, bet_3_rtp
        FROM public.casino_retention
        WHERE date BETWEEN %(start_day)s AND %(end_day)s
          AND (date <> %(today)s OR NOT (SELECT has_rows FROM raw_available))
        UNION ALL
        SELECT * FROM raw_today
    )
"""

GAME_DAILY_METRICS_CTE = """
    WITH raw_available AS (
        SELECT EXISTS (
            SELECT 1
            FROM public.slot_parent_bet
            WHERE bet_at_utc7 >= %(today)s AND bet_at_utc7 < %(today)s + 1
        ) AS has_rows
    ),
    raw_players AS (
        SELECT
            slot_id,
            player_id,
            COUNT(*)::INT8 AS spins,
            COALESCE(SUM(bet_amount), 0) AS bet,
            COALESCE(SUM(total_prize), 0) AS win,
            COUNT(*) FILTER (WHERE bet_type = 1)::INT8 AS b1_spins,
            COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 1), 0) AS b1_bet,
            COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 1), 0) AS b1_win,
            COUNT(*) FILTER (WHERE bet_type = 2)::INT8 AS b2_spins,
            COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 2), 0) AS b2_bet,
            COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 2), 0) AS b2_win,
            COUNT(*) FILTER (WHERE bet_type = 3)::INT8 AS b3_spins,
            COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 3), 0) AS b3_bet,
            COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 3), 0) AS b3_win
        FROM public.slot_parent_bet
        WHERE bet_at_utc7 >= %(today)s AND bet_at_utc7 < %(today)s + 1
          AND %(today)s BETWEEN %(start_day)s AND %(end_day)s
        GROUP BY slot_id, player_id
    ),
    raw_today AS (
        SELECT
            %(today)s::date AS date,
            p.slot_id,
            COUNT(*)::INT8 AS player_count,
            COUNT(*) FILTER (WHERE NOT EXISTS (
                SELECT 1
                FROM public.slot_parent_bet previous
                WHERE previous.slot_id = p.slot_id
                  AND previous.player_id = p.player_id
                  AND previous.bet_at_utc7 < %(today)s
            ))::INT8 AS dnu,
            0::NUMERIC AS retention_1,
            0::NUMERIC AS retention_3,
            0::NUMERIC AS retention_7,
            SUM(p.spins)::INT8 AS total_spin_count,
            SUM(p.bet) AS total_bet_amount,
            SUM(p.win) AS total_win_amount,
            COUNT(*) FILTER (WHERE p.b1_spins > 0)::INT8 AS bet_1_player_count,
            SUM(p.b1_spins)::INT8 AS bet_1_spin_count,
            SUM(p.b1_bet) AS bet_1_total_bet_amount,
            SUM(p.b1_win) AS bet_1_total_win_amount,
            COUNT(*) FILTER (WHERE p.b2_spins > 0)::INT8 AS bet_2_player_count,
            SUM(p.b2_spins)::INT8 AS bet_2_spin_count,
            SUM(p.b2_bet) AS bet_2_total_bet_amount,
            SUM(p.b2_win) AS bet_2_total_win_amount,
            COUNT(*) FILTER (WHERE p.b3_spins > 0)::INT8 AS bet_3_player_count,
            SUM(p.b3_spins)::INT8 AS bet_3_spin_count,
            SUM(p.b3_bet) AS bet_3_total_bet_amount,
            SUM(p.b3_win) AS bet_3_total_win_amount,
            COALESCE(COUNT(*) FILTER (WHERE p.b1_spins > 0 AND p.b1_spins < 10)::NUMERIC
                / NULLIF(COUNT(*) FILTER (WHERE p.b1_spins > 0), 0), 0) AS dist_0_10,
            COALESCE(COUNT(*) FILTER (WHERE p.b1_spins >= 10 AND p.b1_spins < 20)::NUMERIC
                / NULLIF(COUNT(*) FILTER (WHERE p.b1_spins > 0), 0), 0) AS dist_10_20,
            COALESCE(COUNT(*) FILTER (WHERE p.b1_spins >= 20 AND p.b1_spins < 50)::NUMERIC
                / NULLIF(COUNT(*) FILTER (WHERE p.b1_spins > 0), 0), 0) AS dist_20_50,
            COALESCE(COUNT(*) FILTER (WHERE p.b1_spins >= 50 AND p.b1_spins < 100)::NUMERIC
                / NULLIF(COUNT(*) FILTER (WHERE p.b1_spins > 0), 0), 0) AS dist_50_100,
            COALESCE(COUNT(*) FILTER (WHERE p.b1_spins >= 100 AND p.b1_spins < 300)::NUMERIC
                / NULLIF(COUNT(*) FILTER (WHERE p.b1_spins > 0), 0), 0) AS dist_100_300,
            COALESCE(COUNT(*) FILTER (WHERE p.b1_spins >= 300 AND p.b1_spins < 500)::NUMERIC
                / NULLIF(COUNT(*) FILTER (WHERE p.b1_spins > 0), 0), 0) AS dist_300_500,
            COALESCE(COUNT(*) FILTER (WHERE p.b1_spins >= 500 AND p.b1_spins < 1000)::NUMERIC
                / NULLIF(COUNT(*) FILTER (WHERE p.b1_spins > 0), 0), 0) AS dist_500_1000,
            COALESCE(COUNT(*) FILTER (WHERE p.b1_spins >= 1000)::NUMERIC
                / NULLIF(COUNT(*) FILTER (WHERE p.b1_spins > 0), 0), 0) AS dist_1000_plus
        FROM raw_players p
        GROUP BY p.slot_id
    ),
    combined AS (
        SELECT
            date, slot_id, player_count, dnu, retention_1, retention_3, retention_7,
            total_spin_count, total_bet_amount, total_win_amount,
            bet_1_player_count, bet_1_spin_count, bet_1_total_bet_amount, bet_1_total_win_amount,
            bet_2_player_count, bet_2_spin_count, bet_2_total_bet_amount, bet_2_total_win_amount,
            bet_3_player_count, bet_3_spin_count, bet_3_total_bet_amount, bet_3_total_win_amount,
            dist_0_10, dist_10_20, dist_20_50, dist_50_100,
            dist_100_300, dist_300_500, dist_500_1000, dist_1000_plus
        FROM public.game_retention
        WHERE date BETWEEN %(start_day)s AND %(end_day)s
          AND (date <> %(today)s OR NOT (SELECT has_rows FROM raw_available))
        UNION ALL
        SELECT * FROM raw_today
    )
"""

AGENT_DAILY_METRICS_CTE = """
    WITH raw_available AS (
        SELECT EXISTS (
            SELECT 1
            FROM public.slot_parent_bet
            WHERE bet_at_utc7 >= %(today)s AND bet_at_utc7 < %(today)s + 1
        ) AS has_rows
    ),
    raw_players AS (
        SELECT
            p.parent_agent_id,
            p.agent_id,
            p.player_id,
            NOT EXISTS (
                SELECT 1
                FROM public.slot_parent_bet previous
                WHERE previous.parent_agent_id = p.parent_agent_id
                  AND previous.agent_id = p.agent_id
                  AND previous.player_id = p.player_id
                  AND previous.bet_at_utc7 < %(today)s
            ) AS is_new,
            COUNT(*)::INT8 AS spins,
            COALESCE(SUM(p.bet_amount), 0) AS bet,
            COALESCE(SUM(p.total_prize), 0) AS win,
            COUNT(*) FILTER (WHERE p.bet_type = 1)::INT8 AS b1_spins,
            COALESCE(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 1), 0) AS b1_bet,
            COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 1), 0) AS b1_win,
            COUNT(*) FILTER (WHERE p.bet_type = 2)::INT8 AS b2_spins,
            COALESCE(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 2), 0) AS b2_bet,
            COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 2), 0) AS b2_win,
            COUNT(*) FILTER (WHERE p.bet_type = 3)::INT8 AS b3_spins,
            COALESCE(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 3), 0) AS b3_bet,
            COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 3), 0) AS b3_win
        FROM public.slot_parent_bet p
        WHERE p.bet_at_utc7 >= %(today)s AND p.bet_at_utc7 < %(today)s + 1
          AND %(today)s BETWEEN %(start_day)s AND %(end_day)s
        GROUP BY p.parent_agent_id, p.agent_id, p.player_id
    ),
    raw_today AS (
        SELECT
            %(today)s::date AS date,
            parent_agent_id,
            agent_id,
            COUNT(*)::INT8 AS player_count,
            COUNT(*) FILTER (WHERE is_new)::INT8 AS dnu,
            SUM(spins)::INT8 AS total_spin_count,
            SUM(bet) AS total_bet_amount,
            SUM(win) AS total_win_amount,
            COUNT(*) FILTER (WHERE b1_spins > 0)::INT8 AS bet_1_player_count,
            SUM(b1_spins)::INT8 AS bet_1_spin_count,
            SUM(b1_bet) AS bet_1_total_bet_amount,
            SUM(b1_win) AS bet_1_total_win_amount,
            COUNT(*) FILTER (WHERE b2_spins > 0)::INT8 AS bet_2_player_count,
            SUM(b2_spins)::INT8 AS bet_2_spin_count,
            SUM(b2_bet) AS bet_2_total_bet_amount,
            SUM(b2_win) AS bet_2_total_win_amount,
            COUNT(*) FILTER (WHERE b3_spins > 0)::INT8 AS bet_3_player_count,
            SUM(b3_spins)::INT8 AS bet_3_spin_count,
            SUM(b3_bet) AS bet_3_total_bet_amount,
            SUM(b3_win) AS bet_3_total_win_amount
        FROM raw_players
        GROUP BY parent_agent_id, agent_id
    ),
    combined AS MATERIALIZED (
        SELECT
            date, parent_agent_id, agent_id,
            SUM(player_count)::INT8 AS player_count,
            SUM(dnu)::INT8 AS dnu,
            SUM(total_spin_count)::INT8 AS total_spin_count,
            SUM(total_bet_amount) AS total_bet_amount,
            SUM(total_win_amount) AS total_win_amount,
            SUM(bet_1_player_count)::INT8 AS bet_1_player_count,
            SUM(bet_1_spin_count)::INT8 AS bet_1_spin_count,
            SUM(bet_1_total_bet_amount) AS bet_1_total_bet_amount,
            SUM(bet_1_total_win_amount) AS bet_1_total_win_amount,
            SUM(bet_2_player_count)::INT8 AS bet_2_player_count,
            SUM(bet_2_spin_count)::INT8 AS bet_2_spin_count,
            SUM(bet_2_total_bet_amount) AS bet_2_total_bet_amount,
            SUM(bet_2_total_win_amount) AS bet_2_total_win_amount,
            SUM(bet_3_player_count)::INT8 AS bet_3_player_count,
            SUM(bet_3_spin_count)::INT8 AS bet_3_spin_count,
            SUM(bet_3_total_bet_amount) AS bet_3_total_bet_amount,
            SUM(bet_3_total_win_amount) AS bet_3_total_win_amount
        FROM public.agent_daily_game_retention
        WHERE date BETWEEN %(start_day)s AND %(end_day)s
          AND (date <> %(today)s OR NOT (SELECT has_rows FROM raw_available))
        GROUP BY date, parent_agent_id, agent_id
        UNION ALL
        SELECT * FROM raw_today
    )
"""

# ----------------------------------------------------
# 靜態網頁檔案託管路由
# ----------------------------------------------------
@app.route('/')
def index():
    """託管首頁 index.html。"""
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    """託管 CSS、JS、圖片等靜態資源檔案。"""
    return send_from_directory(app.static_folder, path)

# ----------------------------------------------------
# API 連線端點
# ----------------------------------------------------
@app.route('/api/dates', methods=['GET'])
def get_dates():
    """獲取資料表中有投注紀錄的所有不重複日期清單（遞減排序），使用遞迴 CTE 鬆散索引掃描優化。"""
    cached_dates = dates_cache.get("available_dates")
    if cached_dates is not None:
        return jsonify(cached_dates)

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        apply_query_timeout(cursor)
        query = """
        WITH RECURSIVE t AS (
           (SELECT (bet_at_utc7::date) AS play_date FROM public.slot_parent_bet WHERE bet_at_utc7 IS NOT NULL ORDER BY 1 DESC LIMIT 1)
           UNION ALL
           SELECT (SELECT (bet_at_utc7::date) FROM public.slot_parent_bet WHERE bet_at_utc7 IS NOT NULL AND (bet_at_utc7::date) < t.play_date ORDER BY 1 DESC LIMIT 1)
           FROM t
           WHERE t.play_date IS NOT NULL
        )
        SELECT play_date FROM t WHERE play_date IS NOT NULL;
        """
        cursor.execute(query)
        rows = cursor.fetchall()
        # 格式化日期為 YYYY-MM-DD 字串陣列
        dates = [row[0].strftime('%Y-%m-%d') for row in rows]
        dates_cache.set("available_dates", dates)
        return jsonify(dates)
    except Exception as e:
        print(f"獲取日期清單失敗: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/monthly', methods=['GET'])
def get_monthly_data():
    """Return daily casino metrics used by the monthly dashboard charts."""
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')

    if not start_date or not end_date:
        return jsonify({"error": "start_date and end_date are required"}), 400

    try:
        start_day = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_day = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"error": "Dates must use YYYY-MM-DD format"}), 400

    if start_day > end_day:
        return jsonify({"error": "start_date must not be later than end_date"}), 400

    month_span = (end_day.year - start_day.year) * 12 + end_day.month - start_day.month + 1
    if month_span > 12:
        return jsonify({"error": "Monthly date range must not exceed 12 calendar months"}), 400

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        cursor.execute(CASINO_DAILY_METRICS_CTE + """
            SELECT
                date,
                player_count,
                dnu,
                retention_1,
                retention_3,
                retention_7,
                total_spin_count,
                total_bet_amount,
                total_win_amount,
                rtp,
                odd_rtp,
                bet_1_player_count,
                bet_1_player_avg_bet_count,
                bet_1_rtp,
                bet_2_player_count,
                bet_2_player_avg_bet_count,
                bet_2_rtp,
                bet_3_player_count,
                bet_3_player_avg_bet_count,
                bet_3_rtp
            FROM combined
            ORDER BY date;
        """, {
            "start_day": start_day,
            "end_day": end_day,
            "today": datetime.now(LOCAL_TIME_ZONE).date(),
        })
        rows = cursor.fetchall()
        return jsonify([
            {**row, "date": row["date"].isoformat() if row.get("date") else None}
            for row in rows
        ])
    except Exception as e:
        print(f"Failed to load monthly metrics ({start_date} ~ {end_date}): {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/game', methods=['GET'])
def get_game_data():
    """Return daily game metrics grouped by date and slot_id."""
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    slot_id = request.args.get('slot_id')

    if not start_date or not end_date:
        return jsonify({"error": "start_date and end_date are required"}), 400

    try:
        start_day = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_day = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"error": "Dates must use YYYY-MM-DD format"}), 400

    if start_day > end_day:
        return jsonify({"error": "start_date must not be later than end_date"}), 400

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        query = GAME_DAILY_METRICS_CTE + """
            SELECT
                date, slot_id, player_count, dnu, retention_1, retention_3, retention_7,
                total_spin_count, total_bet_amount, total_win_amount,
                CASE
                    WHEN total_bet_amount > 0 THEN total_win_amount / total_bet_amount
                    ELSE 0
                END AS rtp,
                bet_1_player_count, bet_1_spin_count, bet_1_total_bet_amount, bet_1_total_win_amount,
                bet_2_player_count, bet_2_spin_count, bet_2_total_bet_amount, bet_2_total_win_amount,
                bet_3_player_count, bet_3_spin_count, bet_3_total_bet_amount, bet_3_total_win_amount
                , dist_0_10, dist_10_20, dist_20_50, dist_50_100,
                  dist_100_300, dist_300_500, dist_500_1000, dist_1000_plus
            FROM combined
            WHERE TRUE
        """
        params = {
            "start_day": start_day,
            "end_day": end_day,
            "today": datetime.now(LOCAL_TIME_ZONE).date(),
        }
        if slot_id and slot_id.upper() != 'ALL':
            try:
                params["slot_id"] = int(slot_id)
            except ValueError:
                return jsonify({"error": "slot_id must be numeric"}), 400
            query += " AND slot_id = %(slot_id)s"
        query += " ORDER BY date, slot_id"
        cursor.execute(query, params)
        rows = cursor.fetchall()
        game_names = get_game_names(cursor, [row["slot_id"] for row in rows])
        return jsonify([
            {
                **row,
                "date": row["date"].isoformat() if row.get("date") else None,
                "game_name": game_names.get(str(row["slot_id"]), str(row["slot_id"]))
            }
            for row in rows
        ])
    except Exception as e:
        print(f"Failed to load game metrics ({start_date} ~ {end_date}, slot={slot_id}): {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/game-spin-medians', methods=['GET'])
def get_game_spin_medians():
    """Return daily medians of per-player spin counts for one selected game."""
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    slot_id = request.args.get('slot_id')
    if not start_date or not end_date or not slot_id:
        return jsonify({"error": "start_date, end_date, and slot_id are required"}), 400
    try:
        start_day = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_day = datetime.strptime(end_date, "%Y-%m-%d").date()
        selected_slot = int(slot_id)
    except ValueError:
        return jsonify({"error": "Dates must use YYYY-MM-DD format and slot_id must be numeric"}), 400
    if start_day > end_day:
        return jsonify({"error": "start_date must not be later than end_date"}), 400

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        cursor.execute("""
            WITH player_spins AS (
                SELECT bet_at_utc7::date AS date,
                       player_id,
                       COUNT(*)::INT8 AS spin_count
                FROM public.slot_parent_bet
                WHERE bet_at_utc7 >= %(start_day)s::date
                  AND bet_at_utc7 < %(end_day)s::date + 1
                  AND slot_id = %(slot_id)s
                GROUP BY bet_at_utc7::date, player_id
            )
            SELECT date,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (
                       ORDER BY spin_count::DOUBLE PRECISION
                   ) AS median_player_spin_count
            FROM player_spins
            GROUP BY date
            ORDER BY date;
        """, {"start_day": start_day, "end_day": end_day, "slot_id": selected_slot})
        return jsonify([{
            "date": row["date"].isoformat(),
            "median_player_spin_count": float(row["median_player_spin_count"] or 0)
        } for row in cursor.fetchall()])
    except Exception as e:
        print(f"Failed to load game spin medians ({start_date} ~ {end_date}, slot={slot_id}): {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)


@app.route('/api/game-hourly-players', methods=['GET'])
def get_game_hourly_players():
    """Return 24 hourly player counts, averaged by day for multi-day ranges."""
    date_value = request.args.get('date')
    start_value = request.args.get('start_date') or date_value
    end_value = request.args.get('end_date') or date_value
    slot_id = request.args.get('slot_id')
    if not start_value or not end_value:
        return jsonify({"error": "start_date and end_date are required"}), 400
    try:
        start_day = datetime.strptime(start_value, "%Y-%m-%d").date()
        end_day = datetime.strptime(end_value, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"error": "Dates must use YYYY-MM-DD format"}), 400
    if start_day > end_day:
        return jsonify({"error": "start_date must not be later than end_date"}), 400

    selected_slot = None
    if slot_id and slot_id.upper() != 'ALL':
        try:
            selected_slot = int(slot_id)
        except ValueError:
            return jsonify({"error": "slot_id must be numeric"}), 400

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        cursor.execute("""
            WITH days AS (
                SELECT generate_series(
                    %(start_day)s::date,
                    %(end_day)s::date,
                    INTERVAL '1 day'
                )::date AS play_date
            ), hours AS (
                SELECT generate_series(0, 23) AS hour_number
            ), day_hours AS (
                SELECT d.play_date, h.hour_number
                FROM days d
                CROSS JOIN hours h
            ), hourly AS (
                SELECT bet_at_utc7::date AS play_date,
                       EXTRACT(HOUR FROM bet_at_utc7)::INT AS hour_number,
                       COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 1)::INT8 AS bet_1_player_count,
                       COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 2)::INT8 AS bet_2_player_count,
                       COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 3)::INT8 AS bet_3_player_count
                FROM public.slot_parent_bet
                WHERE bet_at_utc7 >= %(start_day)s::date
                  AND bet_at_utc7 < %(end_day)s::date + 1
                  AND (%(slot_id)s::BIGINT IS NULL OR slot_id = %(slot_id)s)
                GROUP BY bet_at_utc7::date, EXTRACT(HOUR FROM bet_at_utc7)::INT
            )
            SELECT dh.hour_number,
                   AVG(COALESCE(p.bet_1_player_count, 0)) AS bet_1_player_count,
                   AVG(COALESCE(p.bet_2_player_count, 0)) AS bet_2_player_count,
                   AVG(COALESCE(p.bet_3_player_count, 0)) AS bet_3_player_count
            FROM day_hours dh
            LEFT JOIN hourly p USING (play_date, hour_number)
            GROUP BY dh.hour_number
            ORDER BY dh.hour_number;
        """, {"start_day": start_day, "end_day": end_day, "slot_id": selected_slot})
        return jsonify([{
            "hour": f'{row["hour_number"]:02d}:00',
            "bet_1_player_count": float(row["bet_1_player_count"] or 0),
            "bet_2_player_count": float(row["bet_2_player_count"] or 0),
            "bet_3_player_count": float(row["bet_3_player_count"] or 0)
        } for row in cursor.fetchall()])
    except Exception as e:
        print(f"Failed to load hourly game players ({start_value} ~ {end_value}, slot={slot_id}): {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)


@app.route('/api/game-ranking', methods=['GET'])
def get_game_ranking():
    """Return game totals for the selected monthly-analysis period."""
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    if not start_date or not end_date:
        return jsonify({"error": "start_date and end_date are required"}), 400
    try:
        start_day = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_day = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"error": "Dates must use YYYY-MM-DD format"}), 400
    if start_day > end_day:
        return jsonify({"error": "start_date must not be later than end_date"}), 400
    month_span = (end_day.year - start_day.year) * 12 + end_day.month - start_day.month + 1
    if month_span > 12:
        return jsonify({"error": "Game ranking range must not exceed 12 calendar months"}), 400

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        cursor.execute(GAME_DAILY_METRICS_CTE + """
            SELECT slot_id, COUNT(DISTINCT date) AS days,
                   SUM(player_count) AS player_count,
                   SUM(total_spin_count)::NUMERIC / NULLIF(SUM(player_count), 0) AS avg_spin_count,
                   SUM(total_bet_amount) / NULLIF(SUM(total_spin_count), 0) AS avg_bet_amount,
                   SUM(total_spin_count) AS total_spin_count,
                   SUM(total_bet_amount) AS total_bet_amount,
                   SUM(total_win_amount) AS total_win_amount,
                   SUM(total_bet_amount) - SUM(total_win_amount) AS ggr
            FROM combined
            GROUP BY slot_id
            ORDER BY total_spin_count DESC;
        """, {
            "start_day": start_day,
            "end_day": end_day,
            "today": datetime.now(LOCAL_TIME_ZONE).date(),
        })
        ranking_rows = cursor.fetchall()
        game_names = get_game_names(cursor, [row["slot_id"] for row in ranking_rows])
        return jsonify([{
            **row,
            "game_name": game_names.get(str(row["slot_id"]), str(row["slot_id"]))
        } for row in ranking_rows])
    except Exception as e:
        print(f"Failed to load game ranking ({start_date} ~ {end_date}): {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/agent-options', methods=['GET'])
def get_agent_options():
    """Return parent-agent and agent pairs used by the agent analysis filters."""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        today = datetime.now(LOCAL_TIME_ZONE).date()
        cursor.execute("""
            SELECT DISTINCT parent_agent_id, agent_id
            FROM (
                SELECT parent_agent_id, agent_id
                FROM public.agent_daily_game_retention
                UNION ALL
                SELECT parent_agent_id, agent_id
                FROM public.slot_parent_bet
                WHERE bet_at_utc7 >= %s AND bet_at_utc7 < %s + 1
            ) available_agents
            ORDER BY parent_agent_id, agent_id;
        """, (today, today))
        rows = cursor.fetchall()
        agent_names = get_agent_names(
            cursor,
            [item for row in rows for item in (row["parent_agent_id"], row["agent_id"])],
        )
        named_rows = [{
            **row,
            "parent_agent_name": agent_names.get(str(row["parent_agent_id"]), str(row["parent_agent_id"])),
            "agent_name": agent_names.get(str(row["agent_id"]), str(row["agent_id"]))
        } for row in rows]
        return jsonify({
            "parent_agents": sorted({row["parent_agent_id"] for row in rows}),
            "agents": named_rows
        })
    except Exception as e:
        print(f"Failed to load agent options: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/agent-dates', methods=['GET'])
def get_agent_dates():
    """Return the dates available in the local Agent retention snapshot."""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        apply_query_timeout(cursor)
        today = datetime.now(LOCAL_TIME_ZONE).date()
        cursor.execute("""
            SELECT DISTINCT date
            FROM (
                SELECT date
                FROM public.agent_daily_game_retention
                WHERE date IS NOT NULL
                UNION ALL
                SELECT bet_at_utc7::date AS date
                FROM public.slot_parent_bet
                WHERE bet_at_utc7 >= %s AND bet_at_utc7 < %s + 1
            ) available_dates
            WHERE date IS NOT NULL
            ORDER BY date DESC;
        """, (today, today))
        return jsonify([row[0].isoformat() for row in cursor.fetchall()])
    except Exception as e:
        print(f"Failed to load agent dates: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/agent-analysis', methods=['GET'])
def get_agent_analysis():
    """Return Agent totals and daily details from the local Agent snapshot."""
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    parent_agent_id = request.args.get('parent_agent_id', 'ALL')
    agent_id = request.args.get('agent_id', 'ALL')
    bet_type = request.args.get('bet_type', 'ALL').upper()
    if not start_date or not end_date:
        return jsonify({"error": "start_date and end_date are required"}), 400
    try:
        start_day = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_day = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return jsonify({"error": "Dates must use YYYY-MM-DD format"}), 400
    if start_day > end_day:
        return jsonify({"error": "start_date must not be later than end_date"}), 400
    if (end_day - start_day).days > 366:
        return jsonify({"error": "Agent analysis range must not exceed 366 days"}), 400
    if bet_type not in {'ALL', '1', '2', '3'}:
        return jsonify({"error": "bet_type must be ALL, 1, 2, or 3"}), 400

    filters = ["date BETWEEN %(start_day)s AND %(end_day)s"]
    params = {
        "start_day": start_day,
        "end_day": end_day,
        "today": datetime.now(LOCAL_TIME_ZONE).date(),
    }
    for column, value in (("parent_agent_id", parent_agent_id), ("agent_id", agent_id)):
        if value and value.upper() != 'ALL':
            try:
                params[column] = int(value)
            except ValueError:
                return jsonify({"error": f"{column} must be numeric"}), 400
            filters.append(f"{column} = %({column})s")
    where_clause = " AND ".join(filters)
    if bet_type == 'ALL':
        player_expr = "player_count"
        spin_expr = "total_spin_count"
        bet_expr = "total_bet_amount"
        win_expr = "total_win_amount"
        detail_bet_type = "bt.bet_type"
        detail_player_expr = "bt.player_count"
        detail_spin_expr = "bt.spin_count"
        detail_bet_expr = "bt.bet_amount"
        detail_win_expr = "bt.win_amount"
        detail_join = """
            CROSS JOIN LATERAL (VALUES
                (1, bet_1_player_count, bet_1_spin_count, bet_1_total_bet_amount, bet_1_total_win_amount),
                (2, bet_2_player_count, bet_2_spin_count, bet_2_total_bet_amount, bet_2_total_win_amount),
                (3, bet_3_player_count, bet_3_spin_count, bet_3_total_bet_amount, bet_3_total_win_amount)
            ) AS bt(bet_type, player_count, spin_count, bet_amount, win_amount)
        """
        detail_group = "date, parent_agent_id, agent_id, bt.bet_type"
    else:
        player_expr = f"bet_{bet_type}_player_count"
        spin_expr = f"bet_{bet_type}_spin_count"
        bet_expr = f"bet_{bet_type}_total_bet_amount"
        win_expr = f"bet_{bet_type}_total_win_amount"
        detail_bet_type = bet_type
        detail_player_expr = player_expr
        detail_spin_expr = spin_expr
        detail_bet_expr = bet_expr
        detail_win_expr = win_expr
        detail_join = ""
        detail_group = "date, parent_agent_id, agent_id"

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        cursor.execute(AGENT_DAILY_METRICS_CTE + f"""
            , cube AS (
                SELECT parent_agent_id, agent_id,
                       SUM({player_expr}) AS player_count,
                       SUM(dnu) AS dnu,
                       SUM({spin_expr}) AS spin_count,
                       SUM({bet_expr}) AS total_bet_amount,
                       SUM({win_expr}) AS total_win_amount,
                       SUM({bet_expr}) - SUM({win_expr}) AS ggr
                FROM combined
                WHERE {where_clause}
                GROUP BY parent_agent_id, agent_id
            ),
            details AS (
                SELECT date, parent_agent_id, agent_id, {detail_bet_type} AS bet_type,
                       SUM({detail_player_expr}) AS player_count,
                       SUM({detail_spin_expr}) AS spin_count,
                       SUM({detail_bet_expr}) AS total_bet_amount,
                       SUM({detail_win_expr}) AS total_win_amount,
                       SUM({detail_bet_expr}) - SUM({detail_win_expr}) AS ggr
                FROM combined
                {detail_join}
                WHERE {where_clause}
                GROUP BY {detail_group}
            )
            SELECT *
            FROM (
                SELECT 'cube' AS result_set, NULL::DATE AS date,
                       parent_agent_id, agent_id, NULL::INT AS bet_type,
                       player_count, dnu, spin_count,
                       total_bet_amount, total_win_amount, ggr
                FROM cube
                UNION ALL
                SELECT 'details' AS result_set, date,
                       parent_agent_id, agent_id, bet_type,
                       player_count, NULL::NUMERIC AS dnu, spin_count,
                       total_bet_amount, total_win_amount, ggr
                FROM details
            ) results
            ORDER BY result_set,
                     CASE WHEN result_set = 'cube' THEN ggr END DESC NULLS LAST,
                     date NULLS FIRST, parent_agent_id, agent_id, bet_type;
        """, params)
        result_rows = cursor.fetchall()
        cube = []
        details = []
        for result_row in result_rows:
            result_set = result_row.pop("result_set")
            if result_set == "cube":
                result_row.pop("date", None)
                result_row.pop("bet_type", None)
                cube.append(result_row)
            else:
                result_row.pop("dnu", None)
                details.append(result_row)

        games = []
        game_details = []
        if parent_agent_id.upper() != 'ALL':
            if bet_type != 'ALL':
                params["selected_bet_type"] = int(bet_type)
            snapshot_filters = [
                "date BETWEEN %(start_day)s AND %(end_day)s",
                "date <> %(today)s",
                "parent_agent_id = %(parent_agent_id)s",
            ]
            raw_scope_filters = [
                "p.bet_at_utc7 >= %(today)s",
                "p.bet_at_utc7 < %(today)s + 1",
                "%(today)s BETWEEN %(start_day)s AND %(end_day)s",
                "p.parent_agent_id = %(parent_agent_id)s",
            ]
            if agent_id and agent_id.upper() != 'ALL':
                snapshot_filters.append("agent_id = %(agent_id)s")
                raw_scope_filters.append("p.agent_id = %(agent_id)s")
            if bet_type != 'ALL':
                raw_scope_filters.append("p.bet_type = %(selected_bet_type)s")
            snapshot_where = " AND ".join(snapshot_filters)
            raw_scope_where = " AND ".join(raw_scope_filters)
            cursor.execute(f"""
                WITH game_details_source AS MATERIALIZED (
                    SELECT date, slot_id,
                           SUM({player_expr})::INT8 AS player_count,
                           SUM({spin_expr})::INT8 AS spin_count,
                           SUM({bet_expr}) AS total_bet_amount,
                           SUM({win_expr}) AS total_win_amount
                    FROM public.agent_daily_game_retention
                    WHERE {snapshot_where}
                    GROUP BY date, slot_id
                    UNION ALL
                    SELECT p.bet_at_utc7::date AS date, p.slot_id,
                           COUNT(DISTINCT p.player_id)::INT8 AS player_count,
                           COUNT(*)::INT8 AS spin_count,
                           COALESCE(SUM(p.bet_amount), 0) AS total_bet_amount,
                           COALESCE(SUM(p.total_prize), 0) AS total_win_amount
                    FROM public.slot_parent_bet p
                    WHERE {raw_scope_where}
                    GROUP BY p.bet_at_utc7::date, p.slot_id
                )
                SELECT * FROM (
                    SELECT 'games' AS result_set, NULL::DATE AS date, slot_id,
                           SUM(player_count) AS player_count,
                           SUM(spin_count) AS spin_count,
                           SUM(total_bet_amount) AS total_bet_amount,
                           SUM(total_win_amount) AS total_win_amount,
                           SUM(total_bet_amount) - SUM(total_win_amount) AS ggr
                    FROM game_details_source
                    GROUP BY slot_id
                    UNION ALL
                    SELECT 'game_details' AS result_set, date, slot_id,
                           player_count, spin_count, total_bet_amount, total_win_amount,
                           total_bet_amount - total_win_amount AS ggr
                    FROM game_details_source
                ) raw_game_results
                ORDER BY result_set, date NULLS FIRST, spin_count DESC, slot_id;
            """, params)
            game_rows = cursor.fetchall()
            game_names = get_game_names(cursor, [row["slot_id"] for row in game_rows])
            for row in game_rows:
                result_set = row.pop("result_set")
                row["date"] = row["date"].isoformat() if row.get("date") else None
                row["game_name"] = game_names.get(str(row["slot_id"]), str(row["slot_id"]))
                if result_set == "games":
                    row.pop("date", None)
                    games.append(row)
                else:
                    game_details.append(row)
        agent_names = get_agent_names(
            cursor,
            [item for row in cube + details for item in (row["parent_agent_id"], row["agent_id"])],
        )
        def serialize(row):
            return {
                **row,
                "date": row["date"].isoformat() if row.get("date") else None,
                "parent_agent_name": agent_names.get(
                    str(row["parent_agent_id"]), str(row["parent_agent_id"])
                ),
                "agent_name": agent_names.get(str(row["agent_id"]), str(row["agent_id"]))
            }
        return jsonify({
            "cube": [serialize(row) for row in cube],
            "details": [serialize(row) for row in details],
            "games": games,
            "game_details": game_details
        })
    except Exception as e:
        print(f"Failed to load agent analysis: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)


@app.route('/api/agent-game-performance', methods=['GET'])
def get_agent_game_performance():
    """Return game-performance data scoped to one parent agent and sub agent."""
    try:
        start_day = datetime.strptime(request.args.get('start_date', ''), "%Y-%m-%d").date()
        end_day = datetime.strptime(request.args.get('end_date', ''), "%Y-%m-%d").date()
        parent_id = int(request.args.get('parent_agent_id', ''))
        selected_agent = int(request.args.get('agent_id', ''))
        selected_slot = int(request.args.get('slot_id', ''))
    except ValueError:
        return jsonify({"error": "Valid dates, parent_agent_id, agent_id, and slot_id are required"}), 400
    if start_day > end_day:
        return jsonify({"error": "start_date must not be later than end_date"}), 400
    if (end_day - start_day).days > 366:
        return jsonify({"error": "Agent game range must not exceed 366 days"}), 400

    today = datetime.now(LOCAL_TIME_ZONE).date()
    params = {
        "start_day": start_day, "end_day": end_day, "today": today,
        "parent_agent_id": parent_id, "agent_id": selected_agent, "slot_id": selected_slot,
    }
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        cursor.execute("""
            WITH raw_players AS (
                SELECT p.player_id,
                       COUNT(*)::INT8 AS spins,
                       COALESCE(SUM(p.bet_amount), 0) AS bet,
                       COALESCE(SUM(p.total_prize), 0) AS win,
                       COUNT(*) FILTER (WHERE p.bet_type = 1)::INT8 AS b1_spins,
                       COALESCE(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 1), 0) AS b1_bet,
                       COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 1), 0) AS b1_win,
                       COUNT(*) FILTER (WHERE p.bet_type = 2)::INT8 AS b2_spins,
                       COALESCE(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 2), 0) AS b2_bet,
                       COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 2), 0) AS b2_win,
                       COUNT(*) FILTER (WHERE p.bet_type = 3)::INT8 AS b3_spins,
                       COALESCE(SUM(p.bet_amount) FILTER (WHERE p.bet_type = 3), 0) AS b3_bet,
                       COALESCE(SUM(p.total_prize) FILTER (WHERE p.bet_type = 3), 0) AS b3_win,
                       NOT EXISTS (
                           SELECT 1 FROM public.slot_parent_bet previous
                           WHERE previous.parent_agent_id = p.parent_agent_id
                             AND previous.agent_id = p.agent_id
                             AND previous.slot_id = p.slot_id
                             AND previous.player_id = p.player_id
                             AND previous.bet_at_utc7 < %(today)s
                       ) AS is_new
                FROM public.slot_parent_bet p
                WHERE p.bet_at_utc7 >= %(today)s AND p.bet_at_utc7 < %(today)s + 1
                  AND %(today)s BETWEEN %(start_day)s AND %(end_day)s
                  AND p.parent_agent_id = %(parent_agent_id)s
                  AND p.agent_id = %(agent_id)s AND p.slot_id = %(slot_id)s
                GROUP BY p.parent_agent_id, p.agent_id, p.slot_id, p.player_id
            ), raw_today AS (
                SELECT %(today)s::date AS date, %(slot_id)s::BIGINT AS slot_id,
                       COUNT(*)::INT8 AS player_count,
                       COUNT(*) FILTER (WHERE is_new)::INT8 AS dnu,
                       0::NUMERIC AS retention_1, 0::NUMERIC AS retention_3, 0::NUMERIC AS retention_7,
                       SUM(spins)::INT8 AS total_spin_count, SUM(bet) AS total_bet_amount, SUM(win) AS total_win_amount,
                       COUNT(*) FILTER (WHERE b1_spins > 0)::INT8 AS bet_1_player_count,
                       SUM(b1_spins)::INT8 AS bet_1_spin_count, SUM(b1_bet) AS bet_1_total_bet_amount, SUM(b1_win) AS bet_1_total_win_amount,
                       COUNT(*) FILTER (WHERE b2_spins > 0)::INT8 AS bet_2_player_count,
                       SUM(b2_spins)::INT8 AS bet_2_spin_count, SUM(b2_bet) AS bet_2_total_bet_amount, SUM(b2_win) AS bet_2_total_win_amount,
                       COUNT(*) FILTER (WHERE b3_spins > 0)::INT8 AS bet_3_player_count,
                       SUM(b3_spins)::INT8 AS bet_3_spin_count, SUM(b3_bet) AS bet_3_total_bet_amount, SUM(b3_win) AS bet_3_total_win_amount,
                       COALESCE(COUNT(*) FILTER (WHERE b1_spins > 0 AND b1_spins < 10)::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE b1_spins > 0), 0), 0) AS dist_0_10,
                       COALESCE(COUNT(*) FILTER (WHERE b1_spins >= 10 AND b1_spins < 20)::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE b1_spins > 0), 0), 0) AS dist_10_20,
                       COALESCE(COUNT(*) FILTER (WHERE b1_spins >= 20 AND b1_spins < 50)::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE b1_spins > 0), 0), 0) AS dist_20_50,
                       COALESCE(COUNT(*) FILTER (WHERE b1_spins >= 50 AND b1_spins < 100)::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE b1_spins > 0), 0), 0) AS dist_50_100,
                       COALESCE(COUNT(*) FILTER (WHERE b1_spins >= 100 AND b1_spins < 300)::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE b1_spins > 0), 0), 0) AS dist_100_300,
                       COALESCE(COUNT(*) FILTER (WHERE b1_spins >= 300 AND b1_spins < 500)::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE b1_spins > 0), 0), 0) AS dist_300_500,
                       COALESCE(COUNT(*) FILTER (WHERE b1_spins >= 500 AND b1_spins < 1000)::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE b1_spins > 0), 0), 0) AS dist_500_1000,
                       COALESCE(COUNT(*) FILTER (WHERE b1_spins >= 1000)::NUMERIC / NULLIF(COUNT(*) FILTER (WHERE b1_spins > 0), 0), 0) AS dist_1000_plus
                FROM raw_players HAVING COUNT(*) > 0
            ), combined AS (
                SELECT date, slot_id, player_count, dnu, retention_1, retention_3, retention_7,
                       total_spin_count, total_bet_amount, total_win_amount,
                       bet_1_player_count, bet_1_spin_count, bet_1_total_bet_amount, bet_1_total_win_amount,
                       bet_2_player_count, bet_2_spin_count, bet_2_total_bet_amount, bet_2_total_win_amount,
                       bet_3_player_count, bet_3_spin_count, bet_3_total_bet_amount, bet_3_total_win_amount,
                       dist_0_10, dist_10_20, dist_20_50, dist_50_100,
                       dist_100_300, dist_300_500, dist_500_1000, dist_1000_plus
                FROM public.agent_daily_game_retention
                WHERE date BETWEEN %(start_day)s AND %(end_day)s AND date <> %(today)s
                  AND parent_agent_id = %(parent_agent_id)s
                  AND agent_id = %(agent_id)s AND slot_id = %(slot_id)s
                UNION ALL SELECT * FROM raw_today
            )
            SELECT *, COALESCE(total_win_amount / NULLIF(total_bet_amount, 0), 0) AS rtp
            FROM combined ORDER BY date;
        """, params)
        rows = cursor.fetchall()

        cursor.execute("""
            WITH days AS (
                SELECT generate_series(%(start_day)s::date, %(end_day)s::date, INTERVAL '1 day')::date AS play_date
            ), hours AS (SELECT generate_series(0, 23) AS hour_number),
            day_hours AS (SELECT play_date, hour_number FROM days CROSS JOIN hours),
            hourly AS (
                SELECT bet_at_utc7::date AS play_date, EXTRACT(HOUR FROM bet_at_utc7)::INT AS hour_number,
                       COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 1)::INT8 AS bet_1_player_count,
                       COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 2)::INT8 AS bet_2_player_count,
                       COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 3)::INT8 AS bet_3_player_count
                FROM public.slot_parent_bet
                WHERE bet_at_utc7 >= %(start_day)s AND bet_at_utc7 < %(end_day)s + 1
                  AND parent_agent_id = %(parent_agent_id)s AND agent_id = %(agent_id)s AND slot_id = %(slot_id)s
                GROUP BY bet_at_utc7::date, EXTRACT(HOUR FROM bet_at_utc7)::INT
            )
            SELECT hour_number,
                   AVG(COALESCE(bet_1_player_count, 0)) AS bet_1_player_count,
                   AVG(COALESCE(bet_2_player_count, 0)) AS bet_2_player_count,
                   AVG(COALESCE(bet_3_player_count, 0)) AS bet_3_player_count
            FROM day_hours LEFT JOIN hourly USING (play_date, hour_number)
            GROUP BY hour_number ORDER BY hour_number;
        """, params)
        hourly = cursor.fetchall()

        cursor.execute("""
            WITH player_spins AS (
                SELECT bet_at_utc7::date AS date, player_id, COUNT(*)::INT8 AS spin_count
                FROM public.slot_parent_bet
                WHERE bet_at_utc7 >= %(start_day)s AND bet_at_utc7 < %(end_day)s + 1
                  AND parent_agent_id = %(parent_agent_id)s AND agent_id = %(agent_id)s AND slot_id = %(slot_id)s
                GROUP BY bet_at_utc7::date, player_id
            )
            SELECT date, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY spin_count::DOUBLE PRECISION) AS median_player_spin_count
            FROM player_spins GROUP BY date ORDER BY date;
        """, params)
        medians = cursor.fetchall()
        game_name = get_game_names(cursor, [selected_slot]).get(str(selected_slot), str(selected_slot))
        return jsonify({
            "rows": [{**row, "date": row["date"].isoformat(), "game_name": game_name} for row in rows],
            "hourly_players": [{
                "hour": f'{row["hour_number"]:02d}:00',
                "bet_1_player_count": float(row["bet_1_player_count"] or 0),
                "bet_2_player_count": float(row["bet_2_player_count"] or 0),
                "bet_3_player_count": float(row["bet_3_player_count"] or 0),
            } for row in hourly],
            "medians": [{
                "date": row["date"].isoformat(),
                "median_player_spin_count": float(row["median_player_spin_count"] or 0),
            } for row in medians],
        })
    except Exception as e:
        print(f"Failed to load scoped Agent game performance: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/home-dashboard', methods=['GET'])
def get_home_dashboard():
    """Return the latest operations overview used by the home dashboard."""
    cached_dashboard = home_dashboard_cache.get("overview")
    if cached_dashboard is not None:
        return jsonify(cached_dashboard)

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)

        cursor.execute("""
            SELECT COALESCE(
                (SELECT MAX(bet_at_utc7::date) FROM public.slot_parent_bet),
                (SELECT MAX(date) FROM public.casino_retention)
            ) AS latest_date;
        """)
        latest_row = cursor.fetchone()
        latest_date = latest_row.get("latest_date") if latest_row else None
        if not latest_date:
            return jsonify({"error": "No operating data is available"}), 404

        # Dashboard "current day" means the latest available data partition,
        # which may lag behind the application server's calendar date.
        reference_date = latest_date
        current_month_start = reference_date.replace(day=1)
        previous_month_end = current_month_start - timedelta(days=1)
        previous_month_start = previous_month_end.replace(day=1)
        previous_compare_end = min(
            previous_month_start + timedelta(days=reference_date.day - 1),
            previous_month_end
        )
        ggr_start = reference_date - timedelta(days=29)
        seven_day_start = reference_date - timedelta(days=6)
        historical_end = reference_date - timedelta(days=1)

        cursor.execute("""
            SELECT
                COALESCE(SUM(total_spin_count) FILTER (WHERE date BETWEEN %s AND %s), 0) AS current_spins,
                COALESCE(SUM(total_bet_amount) FILTER (WHERE date BETWEEN %s AND %s), 0) AS current_bet,
                COALESCE(SUM(total_win_amount) FILTER (WHERE date BETWEEN %s AND %s), 0) AS current_win,
                COALESCE(SUM(total_spin_count) FILTER (WHERE date BETWEEN %s AND %s), 0) AS previous_spins,
                COALESCE(SUM(total_bet_amount) FILTER (WHERE date BETWEEN %s AND %s), 0) AS previous_bet,
                COALESCE(SUM(total_win_amount) FILTER (WHERE date BETWEEN %s AND %s), 0) AS previous_win
            FROM public.casino_retention
            WHERE date BETWEEN %s AND %s;
        """, (
            current_month_start, historical_end,
            current_month_start, historical_end,
            current_month_start, historical_end,
            previous_month_start, previous_compare_end,
            previous_month_start, previous_compare_end,
            previous_month_start, previous_compare_end,
            previous_month_start, historical_end
        ))
        totals = cursor.fetchone()
        cursor.execute("""
            SELECT
                COUNT(DISTINCT player_id)::INT8 AS player_count,
                COUNT(*)::INT8 AS spin_count,
                COALESCE(SUM(bet_amount), 0) AS total_bet_amount,
                COALESCE(SUM(total_prize), 0) AS total_win_amount
            FROM public.slot_parent_bet
            WHERE bet_at_utc7 >= %s AND bet_at_utc7 < %s + 1;
        """, (reference_date, reference_date))
        raw_today = cursor.fetchone()
        current_month = {
            "total_spin_count": totals["current_spins"] + raw_today["spin_count"],
            "total_bet_amount": totals["current_bet"] + raw_today["total_bet_amount"],
            "total_win_amount": totals["current_win"] + raw_today["total_win_amount"],
            "ggr": (totals["current_bet"] + raw_today["total_bet_amount"])
                   - (totals["current_win"] + raw_today["total_win_amount"])
        }
        previous_month = {
            "total_spin_count": totals["previous_spins"],
            "total_bet_amount": totals["previous_bet"],
            "total_win_amount": totals["previous_win"],
            "ggr": totals["previous_bet"] - totals["previous_win"]
        }
        today = {
            "player_count": raw_today["player_count"],
            "total_spin_count": raw_today["spin_count"],
            "total_bet_amount": raw_today["total_bet_amount"],
            "total_win_amount": raw_today["total_win_amount"],
            "ggr": raw_today["total_bet_amount"] - raw_today["total_win_amount"]
        }
        cursor.execute("""
            SELECT date, total_bet_amount - total_win_amount AS ggr,
                   player_count AS dau
            FROM public.casino_retention
            WHERE date >= %s AND date <= %s
            ORDER BY date;
        """, (ggr_start, historical_end))
        ggr_30d = cursor.fetchall()
        ggr_30d.append({
            "date": reference_date,
            "ggr": raw_today["total_bet_amount"] - raw_today["total_win_amount"],
            "dau": raw_today["player_count"]
        })
        cursor.execute("""
            WITH bounds AS (
                SELECT date_trunc('hour', MAX(bet_at_utc7)) AS end_hour
                FROM public.slot_parent_bet
            ), hours AS (
                SELECT generate_series(
                    end_hour - INTERVAL '23 hours',
                    end_hour,
                    INTERVAL '1 hour'
                ) AS hour_start
                FROM bounds
                WHERE end_hour IS NOT NULL
            ), hourly AS (
                SELECT date_trunc('hour', bet_at_utc7) AS hour_start,
                       COUNT(*)::INT8 AS spin_count
                FROM public.slot_parent_bet, bounds
                WHERE bet_at_utc7 >= end_hour - INTERVAL '23 hours'
                  AND bet_at_utc7 < end_hour + INTERVAL '1 hour'
                GROUP BY date_trunc('hour', bet_at_utc7)
            )
            SELECT h.hour_start, COALESCE(s.spin_count, 0) AS spin_count
            FROM hours h
            LEFT JOIN hourly s USING (hour_start)
            ORDER BY h.hour_start;
        """)
        hourly_spins_24h = cursor.fetchall()

        def load_game_rankings(start_day, end_day, limit):
            cursor.execute("""
                WITH combined AS (
                    SELECT slot_id, total_spin_count, total_bet_amount, total_win_amount
                    FROM public.game_retention
                    WHERE date >= %s AND date <= %s AND date <> %s
                    UNION ALL
                    SELECT slot_id, COUNT(*)::INT8,
                           COALESCE(SUM(bet_amount), 0),
                           COALESCE(SUM(total_prize), 0)
                    FROM public.slot_parent_bet
                    WHERE bet_at_utc7 >= %s AND bet_at_utc7 < %s + 1
                      AND %s BETWEEN %s AND %s
                    GROUP BY slot_id
                )
                SELECT slot_id, SUM(total_spin_count) AS total_spin_count,
                       SUM(total_bet_amount) AS total_bet_amount,
                       SUM(total_win_amount) AS total_win_amount,
                       SUM(total_bet_amount) - SUM(total_win_amount) AS ggr
                FROM combined
                GROUP BY slot_id
                ORDER BY total_spin_count DESC
                LIMIT %s;
            """, (
                start_day, end_day, reference_date,
                reference_date, reference_date,
                reference_date, start_day, end_day, limit
            ))
            ranking_rows = cursor.fetchall()
            game_names = get_game_names(
                cursor, [row["slot_id"] for row in ranking_rows]
            )
            return [{
                **row,
                "game_name": game_names.get(str(row["slot_id"]), str(row["slot_id"]))
            } for row in ranking_rows]

        def load_player_alerts(start_day, end_day, limit):
            cursor.execute("""
                SELECT player_id, COUNT(*)::INT8 AS spin_count,
                       COALESCE(SUM(bet_amount), 0) AS total_bet,
                       COALESCE(SUM(total_prize), 0) AS total_win,
                       COALESCE(SUM(total_prize), 0)
                         - COALESCE(SUM(bet_amount), 0) AS profit
                FROM public.slot_parent_bet
                WHERE bet_at_utc7 >= %s AND bet_at_utc7 < %s + 1
                GROUP BY player_id
                HAVING COALESCE(SUM(total_prize), 0)
                         - COALESCE(SUM(bet_amount), 0) > 0
                ORDER BY profit DESC
                LIMIT %s;
            """, (start_day, end_day, limit))
            rows = cursor.fetchall()
            player_ids = [row["player_id"] for row in rows]
            if not player_ids:
                return rows
            cursor.execute("""
                SELECT player_id, player_username
                FROM public.player_stats
                WHERE player_id = ANY(%s)
            """, (player_ids,))
            usernames = {
                row["player_id"]: row.get("player_username")
                for row in cursor.fetchall()
            }
            return [{
                **row,
                "username": usernames.get(row["player_id"]) or str(row["player_id"])
            } for row in rows]

        games_7d = load_game_rankings(seven_day_start, reference_date, 10)
        games_today = load_game_rankings(reference_date, reference_date, 5)

        def load_agent_performance(start_day, end_day):
            cursor.execute("""
                WITH combined AS (
                    SELECT parent_agent_id, agent_id,
                           SUM(player_count)::INT8 AS player_count,
                           SUM(total_spin_count)::INT8 AS total_spin_count,
                           SUM(total_bet_amount) AS total_bet_amount,
                           SUM(total_win_amount) AS total_win_amount
                    FROM public.agent_daily_game_retention
                    WHERE date BETWEEN %s AND %s AND date <> %s
                    GROUP BY date, parent_agent_id, agent_id
                    UNION ALL
                    SELECT parent_agent_id, agent_id,
                           COUNT(DISTINCT player_id)::INT8,
                           COUNT(*)::INT8,
                           COALESCE(SUM(bet_amount), 0),
                           COALESCE(SUM(total_prize), 0)
                    FROM public.slot_parent_bet
                    WHERE bet_at_utc7 >= %s AND bet_at_utc7 < %s + 1
                      AND %s BETWEEN %s AND %s
                    GROUP BY parent_agent_id, agent_id
                )
                SELECT parent_agent_id, agent_id,
                       SUM(player_count) AS player_count,
                       SUM(total_spin_count) AS total_spin_count,
                       SUM(total_bet_amount) AS total_bet_amount,
                       SUM(total_win_amount) AS total_win_amount,
                       SUM(total_bet_amount) - SUM(total_win_amount) AS ggr
                FROM combined
                GROUP BY parent_agent_id, agent_id
                ORDER BY ggr DESC, parent_agent_id, agent_id;
            """, (
                start_day, end_day, reference_date,
                reference_date, reference_date,
                reference_date, start_day, end_day
            ))
            rows = cursor.fetchall()
            agent_names = get_agent_names(
                cursor,
                [item for row in rows for item in (row["parent_agent_id"], row["agent_id"])],
            )
            return [{
                **row,
                "parent_agent_name": agent_names.get(str(row["parent_agent_id"]), str(row["parent_agent_id"])),
                "agent_name": agent_names.get(str(row["agent_id"]), str(row["agent_id"]))
            } for row in rows]

        agents_7d = load_agent_performance(seven_day_start, reference_date)
        agents_today = load_agent_performance(reference_date, reference_date)
        players_7d = load_player_alerts(seven_day_start, reference_date, 10)
        players_today = load_player_alerts(reference_date, reference_date, 5)

        def normalize_player_rows(rows):
            return [{
                **row,
                "total_spin_count": row.get("spin_count", 0),
                "total_bet_amount": row.get("total_bet", 0),
                "total_win_amount": row.get("total_win", 0)
            } for row in rows]

        normalized_players_7d = normalize_player_rows(players_7d)
        normalized_players_today = normalize_player_rows(players_today)
        payload = {
            "as_of_date": latest_date.isoformat(),
            "latest_date": latest_date.isoformat(),
            "reference_date": reference_date.isoformat(),
            "current_month_start": current_month_start.isoformat(),
            "previous_month_start": previous_month_start.isoformat(),
            "previous_month_end": previous_compare_end.isoformat(),
            "current_month": current_month,
            "previous_month": previous_month,
            "today": today,
            "current_day": today,
            "ggr_30d": [{**row, "date": row["date"].isoformat()} for row in ggr_30d],
            "hourly_spins_24h": [{
                "hour": row["hour_start"].isoformat(),
                "spin_count": row["spin_count"]
            } for row in hourly_spins_24h],
            "games_7d": games_7d,
            "games_today": games_today,
            "players_7d": players_7d,
            "players_today": players_today,
            "game_rankings": {"seven_day": games_7d, "current_day": games_today},
            "agent_performance": {"seven_day": agents_7d, "current_day": agents_today},
            "player_alerts": {"seven_day": normalized_players_7d, "current_day": normalized_players_today}
        }
        home_dashboard_cache.set("overview", payload)
        return jsonify(payload)
    except Exception as e:
        print(f"Failed to load home dashboard: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

def refresh_home_dashboard_cache(inserted_count=0, affected_dates=frozenset()):
    """Rebuild the cached overview after startup or a successful DB sync."""
    home_dashboard_cache.set_ttl_seconds(get_home_dashboard_cache_ttl())
    previous_payload = home_dashboard_cache.get("overview")
    home_dashboard_cache.clear()
    with app.app_context():
        result = get_home_dashboard()
        response = result[0] if isinstance(result, tuple) else result
        status_code = result[1] if isinstance(result, tuple) else response.status_code
    if status_code >= 400:
        if previous_payload is not None:
            home_dashboard_cache.set("overview", previous_payload)
        write_server_action(
            INFO,
            f"Home dashboard cache refresh failed status={status_code}",
        )
        return False
    reason = "startup" if not inserted_count else f"sync rows={inserted_count:,}"
    date_text = ",".join(sorted(date.isoformat() for date in affected_dates))
    write_server_action(
        INFO,
        f"Home dashboard cache refreshed reason={reason} dates={date_text or '-'}",
    )
    return True


def build_filtered_players_subquery(
    start_date,
    end_date,
    filters,
    player_id_filter=None,
    slot_id_filter=None,
    use_summary=False,
):
    """Build the reusable filtered-player subquery and params."""
    start_day, end_day, end_exclusive = get_date_range_values(start_date, end_date)

    # 僅在有指定新/舊玩家篩選條件時才進行與 player_stats 表的 LEFT JOIN
    use_stats_join = (filters["new_player"] and not filters["old_player"]) or (filters["old_player"] and not filters["new_player"])

    if use_summary:
        today = datetime.now(LOCAL_TIME_ZONE).date()
        # Historical dates come from the compact daily aggregate. Only the
        # current local day reads raw spins, so live data stays current without
        # forcing historical searches through slot_parent_bet.
        sources = []
        params = []
        if start_day < today:
            historical_end = min(end_day, today - timedelta(days=1))
            sources.append("""
                SELECT player_id,
                       (bet_1_spin_count + bet_2_spin_count + bet_3_spin_count)::INT8 AS spin_count,
                       (total_win_1_amount + total_win_2_amount + total_win_3_amount
                        - total_bet_1_amount - total_bet_2_amount - total_bet_3_amount) AS net_profit
                FROM public.player_daily
                WHERE date >= %s AND date <= %s
            """)
            params.extend([start_day, historical_end])
        if start_day <= today <= end_day:
            sources.append("""
                SELECT player_id, COUNT(*)::INT8 AS spin_count,
                       COALESCE(SUM(total_prize - bet_amount), 0) AS net_profit
                FROM public.slot_parent_bet
                WHERE bet_at_utc7 >= %s AND bet_at_utc7 < %s + 1
                GROUP BY player_id
            """)
            params.extend([today, today])
        if not sources:
            sources.append("""
                SELECT NULL::INT8 AS player_id, 0::INT8 AS spin_count,
                       0::NUMERIC AS net_profit
                WHERE FALSE
            """)

        period_sources = " UNION ALL ".join(sources)
        query = f"""
            SELECT p.player_id
            FROM (
                SELECT player_id,
                       SUM(spin_count)::INT8 AS spin_count,
                       SUM(net_profit) AS net_profit
                FROM ({period_sources}) period_rows
                GROUP BY player_id
            ) p
        """
        if use_stats_join:
            query += " LEFT JOIN public.player_stats s ON p.player_id = s.player_id"
        query += " WHERE TRUE"

        if player_id_filter is not None:
            query += " AND p.player_id = %s"
            params.append(player_id_filter)

        if filters["new_player"] and not filters["old_player"]:
            query += " AND s.first_spin_date >= %s AND s.first_spin_date <= %s"
            params.extend([start_day, end_day])
        elif filters["old_player"] and not filters["new_player"]:
            query += " AND s.first_spin_date < %s"
            params.append(start_day)

        if filters["win_player"] and not filters["lose_player"]:
            query += " AND p.net_profit > 0"
        elif filters["lose_player"] and not filters["win_player"]:
            query += " AND p.net_profit <= 0"

        query += " AND p.spin_count >= %s"
        params.append(filters["min_spins"])
        query += " AND p.spin_count <= %s"
        params.append(filters["max_spins"])
        return query, params
    
    if use_stats_join:
        query = """
            SELECT p.player_id
            FROM public.slot_parent_bet p
            LEFT JOIN public.player_stats s ON p.player_id = s.player_id
            WHERE p.bet_at_utc7 >= %s AND p.bet_at_utc7 < %s
        """
    else:
        query = """
            SELECT p.player_id
            FROM public.slot_parent_bet p
            WHERE p.bet_at_utc7 >= %s AND p.bet_at_utc7 < %s
        """
    params = [start_day, end_exclusive]

    if player_id_filter is not None:
        query += " AND p.player_id = %s"
        params.append(player_id_filter)

    if slot_id_filter is not None:
        query += " AND p.slot_id = %s"
        params.append(slot_id_filter)

    # 新玩家：首次 spin 日期落在篩選日期範圍內；舊玩家：首次 spin 日期早於篩選開始日。
    if filters["new_player"] and not filters["old_player"]:
        query += " AND s.first_spin_date >= %s AND s.first_spin_date <= %s"
        params.extend([start_day, end_day])
    elif filters["old_player"] and not filters["new_player"]:
        query += " AND s.first_spin_date < %s"
        params.append(start_day)

    query += " GROUP BY p.player_id"

    having_clauses = []
    if filters["win_player"] and not filters["lose_player"]:
        having_clauses.append("SUM(p.total_prize - p.bet_amount) > 0")
    elif filters["lose_player"] and not filters["win_player"]:
        having_clauses.append("SUM(p.total_prize - p.bet_amount) <= 0")

    having_clauses.append("COUNT(*) >= %s")
    params.append(filters["min_spins"])
    having_clauses.append("COUNT(*) <= %s")
    params.append(filters["max_spins"])

    query += " HAVING " + " AND ".join(having_clauses)
    return query, params


@app.route('/api/player-games', methods=['GET'])
def get_player_games():
    """Return the game-name lookup without scanning the raw betting table."""
    cache_key = ("all",)
    cached_games = player_games_cache.get(cache_key)
    if cached_games is not None:
        return jsonify(cached_games)

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        apply_query_timeout(cursor)
        game_names = get_game_names(cursor)
        games = sorted(
            ({"slot_id": slot_id, "game_name": game_name}
             for slot_id, game_name in game_names.items()),
            key=lambda game: game["game_name"].casefold(),
        )
        player_games_cache.set(cache_key, games)
        return jsonify(games)
    except Exception as e:
        print(f"查詢玩家分析遊戲清單失敗: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)


@app.route('/api/players', methods=['GET'])
def get_players():
    """獲取在特定日期或時間區間投注的玩家 ID 清單，支援多維度篩選（新/老玩家、贏/輸錢玩家、最大旋轉數）。"""
    start_date = request.args.get('start_date') or request.args.get('date')
    end_date = request.args.get('end_date') or request.args.get('date')
    filters = parse_player_filters(request.args)
    try:
        selected_slot = parse_optional_slot_id(request.args.get('slot_id'))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    
    if not start_date or not end_date:
        return jsonify({"error": "缺少必要參數 'start_date' 或 'end_date'"}), 400

    range_error = validate_date_range(start_date, end_date)
    if range_error:
        return jsonify({"error": range_error}), 400

    cache_key = (
        start_date,
        end_date,
        filters["new_player"],
        filters["old_player"],
        filters["win_player"],
        filters["lose_player"],
        filters["min_spins"],
        filters["max_spins"],
        selected_slot,
    )
    cached_players = players_cache.get(cache_key)
    if cached_players is not None:
        return jsonify(cached_players)
        
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        apply_query_timeout(cursor)

        use_summary = selected_slot is None and is_player_daily_available(cursor)
        subquery, params = build_filtered_players_subquery(
            start_date,
            end_date,
            filters,
            slot_id_filter=selected_slot,
            use_summary=use_summary,
        )
        query = f"SELECT player_id FROM ({subquery}) filtered_players ORDER BY player_id;"
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        # 回傳字串化的玩家 ID 陣列
        players = [str(row[0]) for row in rows]
        players_cache.set(cache_key, players)
        return jsonify(players)
    except Exception as e:
        print(f"查詢特定條件玩家清單失敗 ({start_date} ~ {end_date}): {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/data', methods=['GET'])
def get_data():
    """獲取指定日期區間 and 玩家的完整投注流水明細（包含 bet_type 欄位，照時間排序）。"""
    start_date = request.args.get('start_date') or request.args.get('date')
    end_date = request.args.get('end_date') or request.args.get('date')
    player_id = request.args.get('player_id')
    player_name = (request.args.get('player_name') or '').strip()
    is_name_lookup = bool(player_name)
    filters = parse_player_filters(request.args)
    try:
        selected_slot = parse_optional_slot_id(request.args.get('slot_id'))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    
    if not start_date or not end_date or (not player_id and not player_name):
        return jsonify({"error": "缺少開始日期、結束日期，或玩家 ID／玩家名稱"}), 400

    # 單獨玩家名稱查詢不限期間；玩家篩選分析維持一年上限。
    range_error = validate_date_range(start_date, end_date, enforce_max_year=not bool(player_name))
    if range_error:
        return jsonify({"error": range_error}), 400

    if player_id and player_id.upper() == 'ALL':
        return jsonify({"error": "已移除所有玩家功能，請選擇單一玩家 ID"}), 400
        
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)

        if not player_id:
            cursor.execute("""
                SELECT player_id, player_username
                FROM public.player_stats
                WHERE LOWER(BTRIM(player_username)) = LOWER(%s)
                ORDER BY player_id
                LIMIT 2
            """, (player_name,))
            matches = cursor.fetchall()
            if not matches:
                return jsonify({"error": f"找不到玩家名稱：{player_name}"}), 404
            if len(matches) > 1:
                return jsonify({"error": "此玩家名稱對應多個帳號，請改用玩家 ID 查詢"}), 409
            player_id = str(matches[0]['player_id'])
            player_name = matches[0]['player_username']

        if is_name_lookup:
            # 名稱已解析成唯一 ID，不必再掃描並聚合整段期間的玩家清單。
            subquery, subparams = "SELECT %s::BIGINT", [player_id]
        else:
            use_summary = selected_slot is None and is_player_daily_available(cursor)
            subquery, subparams = build_filtered_players_subquery(
                start_date,
                end_date,
                filters,
                player_id,
                slot_id_filter=selected_slot,
                use_summary=use_summary,
            )
        start_day, _, end_exclusive = get_date_range_values(start_date, end_date)
        today = datetime.now(LOCAL_TIME_ZONE).date()
        if start_day <= today < end_exclusive:
            spin_stats_query = """
                SELECT player_id, SUM(total_spins)::INT8 AS total_spins
                FROM (
                    SELECT player_id,
                           SUM(bet_1_spin_count + bet_2_spin_count + bet_3_spin_count)::INT8
                               AS total_spins
                    FROM public.player_daily
                    WHERE player_id = %s AND date < %s
                    GROUP BY player_id
                    UNION ALL
                    SELECT player_id, COUNT(*)::INT8 AS total_spins
                    FROM public.slot_parent_bet
                    WHERE player_id = %s
                      AND bet_at_utc7 >= %s AND bet_at_utc7 < %s + 1
                    GROUP BY player_id
                ) spin_sources
                GROUP BY player_id
            """
            spin_stats_params = [player_id, today, player_id, today, today]
        else:
            spin_stats_query = """
                SELECT player_id,
                       SUM(bet_1_spin_count + bet_2_spin_count + bet_3_spin_count)::INT8
                           AS total_spins
                FROM public.player_daily
                WHERE player_id = %s
                GROUP BY player_id
            """
            spin_stats_params = [player_id]

        slot_condition = "AND d.slot_id = %s" if selected_slot is not None else ""
        query = f"""
            SELECT 
                d.player_id,
                d.bet_at_utc7,
                d.slot_id,
                d.bet_type,
                d.has_free_game,
                d.bet_amount,
                d.total_prize,
                s.player_username,
                s.first_spin_date AS stats_first_spin_date,
                s.total_bet_amount AS stats_total_bet_amount,
                s.total_win_amount AS stats_total_win_amount,
                s.last_spin_at AS stats_last_spin_at,
                stats_spin_counts.total_spins AS stats_spin_count
            FROM 
                public.slot_parent_bet d
            LEFT JOIN
                public.player_stats s ON d.player_id = s.player_id
            LEFT JOIN ({spin_stats_query}) stats_spin_counts
                ON d.player_id = stats_spin_counts.player_id
            WHERE 
                d.bet_at_utc7 >= %s AND d.bet_at_utc7 < %s
                AND d.player_id IN ({subquery})
                AND d.player_id = %s
                {slot_condition}
            ORDER BY 
                d.bet_at_utc7 ASC;
        """
        params = spin_stats_params + [start_day, end_exclusive] + subparams + [player_id]
        if selected_slot is not None:
            params.append(selected_slot)
            
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        game_names = get_game_names(cursor, [row["slot_id"] for row in rows])
        
        # 將 datetime 物件轉換為格式化字串以利 JSON 序列化
        for row in rows:
            row['game_name'] = game_names.get(str(row['slot_id']), str(row['slot_id']))
            if row['bet_at_utc7']:
                row['bet_at_utc7'] = row['bet_at_utc7'].strftime('%Y-%m-%d %H:%M:%S')
            if row.get('stats_first_spin_date'):
                row['stats_first_spin_date'] = row['stats_first_spin_date'].strftime('%Y-%m-%d')
            if row.get('stats_last_spin_at'):
                row['stats_last_spin_at'] = row['stats_last_spin_at'].strftime('%Y-%m-%d %H:%M:%S')
                
        return jsonify(rows)
    except Exception as e:
        print(f"獲取玩家 {player_id} 於日期區間 {start_date} ~ {end_date} 的投注明細失敗: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

if __name__ == '__main__':
    print("----------------------------------------------------------------")
    print(" 正在啟動 API 與靜態伺服器：http://localhost:5000")
    print(f" 目前使用的資料庫設定檔：{CONFIG_PATH}")
    print("----------------------------------------------------------------")
    write_server_action(INFO, "Analytics server starting host=0.0.0.0 port=5000")
    refresh_home_dashboard_cache()
    if is_sync_and_scheduling_enabled(load_config()):
        start_slot_parent_bet_sync(on_data_updated=refresh_home_dashboard_cache)
        start_daily_backfill_scheduler()
    else:
        print("Data synchronization and scheduling are disabled by config.json")
        write_server_action(INFO, "Data synchronization and scheduling disabled by configuration")
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
