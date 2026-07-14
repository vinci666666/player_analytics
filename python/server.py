import os
import sys
import calendar
from datetime import datetime, timedelta
from flask import Flask, jsonify, request, send_from_directory
from psycopg2.extras import RealDictCursor

if __package__:
    from .infrastructure import (
        CONFIG_PATH,
        TtlCache,
        apply_query_timeout,
        db_error_response,
        get_db_connection,
        get_game_names,
        is_player_daily_summary_available,
        release_db_connection,
    )
    from .security import configure_authentication
else:
    from infrastructure import (
        CONFIG_PATH,
        TtlCache,
        apply_query_timeout,
        db_error_response,
        get_db_connection,
        get_game_names,
        is_player_daily_summary_available,
        release_db_connection,
    )
    from security import configure_authentication

# 初始化 Flask 應用，設定靜態檔案目錄為專案的 web 資料夾
app = Flask(__name__, static_folder=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'web')))
configure_authentication(app)

dates_cache = TtlCache(ttl_seconds=300)
home_dashboard_cache = TtlCache(ttl_seconds=60)

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
           (SELECT (bet_at::date) AS play_date FROM public.slot_parent_bet WHERE bet_at IS NOT NULL ORDER BY 1 DESC LIMIT 1)
           UNION ALL
           SELECT (SELECT (bet_at::date) FROM public.slot_parent_bet WHERE bet_at IS NOT NULL AND (bet_at::date) < t.play_date ORDER BY 1 DESC LIMIT 1)
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
        cursor.execute("""
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
            FROM public.casino_retention
            WHERE date >= %s AND date <= %s
            ORDER BY date;
        """, (start_day, end_day))
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
        query = """
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
            FROM public.game_retention
            WHERE date >= %s AND date <= %s
        """
        params = [start_day, end_day]
        if slot_id and slot_id.upper() != 'ALL':
            try:
                params.append(int(slot_id))
            except ValueError:
                return jsonify({"error": "slot_id must be numeric"}), 400
            query += " AND slot_id = %s"
        query += " ORDER BY date, slot_id"
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        game_names = get_game_names()
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
        cursor.execute("""
            SELECT slot_id, COUNT(DISTINCT date) AS days,
                   SUM(player_count) AS player_count,
                   SUM(total_spin_count)::NUMERIC / NULLIF(SUM(player_count), 0) AS avg_spin_count,
                   SUM(total_bet_amount) / NULLIF(SUM(total_spin_count), 0) AS avg_bet_amount,
                   SUM(total_spin_count) AS total_spin_count,
                   SUM(total_bet_amount) AS total_bet_amount,
                   SUM(total_win_amount) AS total_win_amount,
                   SUM(total_bet_amount) - SUM(total_win_amount) AS ggr
            FROM public.game_retention
            WHERE date >= %s AND date <= %s
            GROUP BY slot_id
            ORDER BY total_spin_count DESC;
        """, (start_day, end_day))
        game_names = get_game_names()
        return jsonify([{**row, "game_name": game_names.get(str(row["slot_id"]), str(row["slot_id"]))} for row in cursor.fetchall()])
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
        cursor.execute("""
            SELECT DISTINCT parent_agent_id, agent_id
            FROM public.agent_daily_retention
            ORDER BY parent_agent_id, agent_id;
        """)
        rows = cursor.fetchall()
        return jsonify({
            "parent_agents": sorted({row["parent_agent_id"] for row in rows}),
            "agents": rows
        })
    except Exception as e:
        print(f"Failed to load agent options: {e}", file=sys.stderr)
        return db_error_response(e)
    finally:
        if conn:
            release_db_connection(conn)

@app.route('/api/agent-analysis', methods=['GET'])
def get_agent_analysis():
    """Return game cube and daily details for the selected agent filters."""
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

    filters = ["date BETWEEN %s AND %s"]
    params = [start_day, end_day]
    for column, value in (("parent_agent_id", parent_agent_id), ("agent_id", agent_id)):
        if value and value.upper() != 'ALL':
            try:
                params.append(int(value))
            except ValueError:
                return jsonify({"error": f"{column} must be numeric"}), 400
            filters.append(f"{column} = %s")
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
        detail_group = "date, slot_id, bt.bet_type"
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
        detail_group = "date, slot_id"

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)
        cursor.execute(f"""
            SELECT slot_id,
                   SUM({player_expr}) AS player_count,
                   SUM(dnu) AS dnu,
                   SUM({spin_expr}) AS spin_count,
                   SUM({bet_expr}) AS total_bet_amount,
                   SUM({win_expr}) AS total_win_amount,
                   SUM({bet_expr}) - SUM({win_expr}) AS ggr
            FROM public.agent_daily_game_retention
            WHERE {where_clause}
            GROUP BY slot_id
            ORDER BY ggr DESC, slot_id;
        """, tuple(params))
        cube = cursor.fetchall()
        cursor.execute(f"""
            SELECT date, slot_id, {detail_bet_type} AS bet_type,
                   SUM({detail_player_expr}) AS player_count,
                   SUM({detail_spin_expr}) AS spin_count,
                   SUM({detail_bet_expr}) AS total_bet_amount,
                   SUM({detail_win_expr}) AS total_win_amount,
                   SUM({detail_bet_expr}) - SUM({detail_win_expr}) AS ggr
            FROM public.agent_daily_game_retention
            {detail_join}
            WHERE {where_clause}
            GROUP BY {detail_group}
            ORDER BY date, slot_id, bet_type;
        """, tuple(params))
        details = cursor.fetchall()
        game_names = get_game_names()
        def serialize(row):
            return {
                **row,
                "date": row["date"].isoformat() if row.get("date") else None,
                "game_name": game_names.get(str(row["slot_id"]), str(row["slot_id"]))
            }
        return jsonify({
            "cube": [serialize(row) for row in cube],
            "details": [serialize(row) for row in details]
        })
    except Exception as e:
        print(f"Failed to load agent analysis: {e}", file=sys.stderr)
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

        cursor.execute("SELECT MAX(date) AS latest_date FROM public.casino_retention;")
        latest_row = cursor.fetchone()
        latest_date = latest_row.get("latest_date") if latest_row else None
        if not latest_date:
            return jsonify({"error": "No operating data is available"}), 404

        reference_date = datetime.now().date()
        current_month_start = reference_date.replace(day=1)
        previous_month_end = current_month_start - timedelta(days=1)
        previous_month_start = previous_month_end.replace(day=1)
        previous_compare_end = min(
            previous_month_start + timedelta(days=reference_date.day - 1),
            previous_month_end
        )
        ggr_start = reference_date - timedelta(days=29)
        seven_day_start = reference_date - timedelta(days=6)

        cursor.execute("""
            SELECT
                COALESCE(SUM(total_spin_count) FILTER (WHERE date BETWEEN %s AND %s), 0) AS current_spins,
                COALESCE(SUM(total_bet_amount) FILTER (WHERE date BETWEEN %s AND %s), 0) AS current_bet,
                COALESCE(SUM(total_win_amount) FILTER (WHERE date BETWEEN %s AND %s), 0) AS current_win,
                COALESCE(SUM(total_spin_count) FILTER (WHERE date BETWEEN %s AND %s), 0) AS previous_spins,
                COALESCE(SUM(total_bet_amount) FILTER (WHERE date BETWEEN %s AND %s), 0) AS previous_bet,
                COALESCE(SUM(total_win_amount) FILTER (WHERE date BETWEEN %s AND %s), 0) AS previous_win,
                COALESCE(SUM(total_spin_count) FILTER (WHERE date = %s), 0) AS today_spins,
                COALESCE(SUM(total_bet_amount) FILTER (WHERE date = %s), 0) AS today_bet,
                COALESCE(SUM(total_win_amount) FILTER (WHERE date = %s), 0) AS today_win
            FROM public.casino_retention
            WHERE date BETWEEN %s AND %s;
        """, (
            current_month_start, reference_date,
            current_month_start, reference_date,
            current_month_start, reference_date,
            previous_month_start, previous_compare_end,
            previous_month_start, previous_compare_end,
            previous_month_start, previous_compare_end,
            reference_date, reference_date, reference_date,
            previous_month_start, reference_date
        ))
        totals = cursor.fetchone()
        current_month = {
            "total_spin_count": totals["current_spins"],
            "total_bet_amount": totals["current_bet"],
            "total_win_amount": totals["current_win"],
            "ggr": totals["current_bet"] - totals["current_win"]
        }
        previous_month = {
            "total_spin_count": totals["previous_spins"],
            "total_bet_amount": totals["previous_bet"],
            "total_win_amount": totals["previous_win"],
            "ggr": totals["previous_bet"] - totals["previous_win"]
        }
        today = {
            "total_spin_count": totals["today_spins"],
            "total_bet_amount": totals["today_bet"],
            "total_win_amount": totals["today_win"],
            "ggr": totals["today_bet"] - totals["today_win"]
        }
        cursor.execute("""
            SELECT date, total_bet_amount - total_win_amount AS ggr
            FROM public.casino_retention
            WHERE date >= %s AND date <= %s
            ORDER BY date;
        """, (ggr_start, reference_date))
        ggr_30d = cursor.fetchall()

        def load_game_rankings(start_day, end_day, limit):
            cursor.execute("""
                SELECT slot_id, SUM(total_spin_count) AS total_spin_count,
                       SUM(total_bet_amount) AS total_bet_amount,
                       SUM(total_win_amount) AS total_win_amount,
                       SUM(total_bet_amount) - SUM(total_win_amount) AS ggr
                FROM public.game_retention
                WHERE date >= %s AND date <= %s
                GROUP BY slot_id
                ORDER BY total_spin_count DESC
                LIMIT %s;
            """, (start_day, end_day, limit))
            game_names = get_game_names()
            return [{**row, "game_name": game_names.get(str(row["slot_id"]), str(row["slot_id"]))} for row in cursor.fetchall()]

        def load_player_alerts(start_day, end_day, limit):
            if is_player_daily_summary_available(cursor):
                cursor.execute("""
                    SELECT player_id, SUM(spin_count) AS spin_count,
                           SUM(total_bet_amount) AS total_bet,
                           SUM(total_prize) AS total_win,
                           SUM(net_profit) AS profit
                    FROM public.player_daily_summary
                    WHERE play_date >= %s AND play_date <= %s
                    GROUP BY player_id
                    HAVING SUM(net_profit) > 0
                    ORDER BY profit DESC
                    LIMIT %s;
                """, (start_day, end_day, limit))
            else:
                cursor.execute("""
                    SELECT player_id,
                           SUM(bet_1_spin_count + bet_2_spin_count + bet_3_spin_count) AS spin_count,
                           SUM(total_bet_1_amount + total_bet_2_amount + total_bet_3_amount) AS total_bet,
                           SUM(total_win_1_amount + total_win_2_amount + total_win_3_amount) AS total_win,
                           SUM(total_win_1_amount + total_win_2_amount + total_win_3_amount)
                             - SUM(total_bet_1_amount + total_bet_2_amount + total_bet_3_amount) AS profit
                    FROM public.player_daily
                    WHERE date >= %s AND date <= %s
                    GROUP BY player_id
                    HAVING SUM(total_win_1_amount + total_win_2_amount + total_win_3_amount)
                             - SUM(total_bet_1_amount + total_bet_2_amount + total_bet_3_amount) > 0
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
                SELECT parent_agent_id, agent_id,
                       SUM(player_count) AS player_count,
                       SUM(total_bet_amount) AS total_bet_amount,
                       SUM(total_win_amount) AS total_win_amount,
                       SUM(total_bet_amount) - SUM(total_win_amount) AS ggr
                FROM public.agent_daily_retention
                WHERE date BETWEEN %s AND %s
                GROUP BY parent_agent_id, agent_id
                ORDER BY ggr DESC, parent_agent_id, agent_id;
            """, (start_day, end_day))
            return cursor.fetchall()

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

def get_filter_args():
    """Parse player filter query parameters shared by player list and data endpoints."""
    try:
        min_spins = int(request.args.get('min_spins', 0))
        if min_spins < 0:
            min_spins = 0
    except ValueError:
        min_spins = 0

    try:
        max_spins = int(request.args.get('max_spins', 10000))
        if max_spins < 0:
            max_spins = 10000
    except ValueError:
        max_spins = 10000

    if max_spins < min_spins:
        max_spins = min_spins

    return {
        "new_player": request.args.get('new_player') == 'true',
        "old_player": request.args.get('old_player') == 'true',
        "win_player": request.args.get('win_player') == 'true',
        "lose_player": request.args.get('lose_player') == 'true',
        "min_spins": min_spins,
        "max_spins": max_spins,
    }

def build_filtered_players_subquery(start_date, end_date, filters, player_id_filter=None, use_summary=False):
    """Build the reusable filtered-player subquery and params."""
    start_day, end_day, end_exclusive = get_date_range_values(start_date, end_date)

    # 僅在有指定新/舊玩家篩選條件時才進行與 player_stats 表的 LEFT JOIN
    use_stats_join = (filters["new_player"] and not filters["old_player"]) or (filters["old_player"] and not filters["new_player"])

    if use_summary:
        if use_stats_join:
            query = """
                SELECT p.player_id
                FROM public.player_daily_summary p
                LEFT JOIN public.player_stats s ON p.player_id = s.player_id
                WHERE p.play_date >= %s AND p.play_date <= %s
            """
        else:
            query = """
                SELECT p.player_id
                FROM public.player_daily_summary p
                WHERE p.play_date >= %s AND p.play_date <= %s
            """
        params = [start_day, end_day]

        if player_id_filter is not None:
            query += " AND p.player_id = %s"
            params.append(player_id_filter)

        if filters["new_player"] and not filters["old_player"]:
            query += " AND s.first_spin_date >= %s AND s.first_spin_date <= %s"
            params.extend([start_day, end_day])
        elif filters["old_player"] and not filters["new_player"]:
            query += " AND s.first_spin_date < %s"
            params.append(start_day)

        query += " GROUP BY p.player_id"

        having_clauses = []
        if filters["win_player"] and not filters["lose_player"]:
            having_clauses.append("SUM(p.net_profit) > 0")
        elif filters["lose_player"] and not filters["win_player"]:
            having_clauses.append("SUM(p.net_profit) <= 0")

        having_clauses.append("SUM(p.spin_count) >= %s")
        params.append(filters["min_spins"])
        having_clauses.append("SUM(p.spin_count) <= %s")
        params.append(filters["max_spins"])

        query += " HAVING " + " AND ".join(having_clauses)
        return query, params
    
    if use_stats_join:
        query = """
            SELECT p.player_id
            FROM public.slot_parent_bet p
            LEFT JOIN public.player_stats s ON p.player_id = s.player_id
            WHERE p.bet_at >= %s AND p.bet_at < %s
        """
    else:
        query = """
            SELECT p.player_id
            FROM public.slot_parent_bet p
            WHERE p.bet_at >= %s AND p.bet_at < %s
        """
    params = [start_day, end_exclusive]

    if player_id_filter is not None:
        query += " AND p.player_id = %s"
        params.append(player_id_filter)

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

def add_one_calendar_month(date_value):
    month = date_value.month + 1
    year = date_value.year
    if month > 12:
        month = 1
        year += 1

    max_day = calendar.monthrange(year, month)[1]
    return date_value.replace(year=year, month=month, day=min(date_value.day, max_day))

def validate_date_range(start_date, end_date):
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return "日期格式錯誤，請使用 YYYY-MM-DD"

    if start > end:
        return "開始日期必須小於或等於結束日期"

    if end > add_one_calendar_month(start):
        return "時間區間不可超過一個月"

    return None

def get_date_range_values(start_date, end_date):
    start = datetime.strptime(start_date, "%Y-%m-%d").date()
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    return start, end, end + timedelta(days=1)

@app.route('/api/players', methods=['GET'])
def get_players():
    """獲取在特定日期或時間區間投注的玩家 ID 清單，支援多維度篩選（新/老玩家、贏/輸錢玩家、最大旋轉數）。"""
    start_date = request.args.get('start_date') or request.args.get('date')
    end_date = request.args.get('end_date') or request.args.get('date')
    filters = get_filter_args()
    
    if not start_date or not end_date:
        return jsonify({"error": "缺少必要參數 'start_date' 或 'end_date'"}), 400

    range_error = validate_date_range(start_date, end_date)
    if range_error:
        return jsonify({"error": range_error}), 400
        
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        apply_query_timeout(cursor)

        use_summary = is_player_daily_summary_available(cursor)
        subquery, params = build_filtered_players_subquery(start_date, end_date, filters, use_summary=use_summary)
        query = f"SELECT player_id FROM ({subquery}) filtered_players ORDER BY player_id;"
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        # 回傳字串化的玩家 ID 陣列
        players = [str(row[0]) for row in rows]
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
    filters = get_filter_args()
    
    if not start_date or not end_date or not player_id:
        return jsonify({"error": "缺少參數 'start_date', 'end_date' 或 'player_id'"}), 400

    range_error = validate_date_range(start_date, end_date)
    if range_error:
        return jsonify({"error": range_error}), 400

    if player_id.upper() == 'ALL':
        return jsonify({"error": "已移除所有玩家功能，請選擇單一玩家 ID"}), 400
        
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        apply_query_timeout(cursor)

        use_summary = is_player_daily_summary_available(cursor)
        subquery, subparams = build_filtered_players_subquery(start_date, end_date, filters, player_id, use_summary=use_summary)
        start_day, _, end_exclusive = get_date_range_values(start_date, end_date)

        query = f"""
            SELECT 
                d.player_id,
                d.bet_at,
                d.slot_id,
                d.bet_type,
                d.has_free_game,
                d.bet_amount,
                d.total_prize,
                s.first_spin_date AS stats_first_spin_date,
                s.total_bet_amount AS stats_total_bet_amount,
                s.total_win_amount AS stats_total_win_amount,
                s.last_spin_at AS stats_last_spin_at,
                stats_spin_counts.total_spins AS stats_spin_count
            FROM 
                public.slot_parent_bet d
            LEFT JOIN
                public.player_stats s ON d.player_id = s.player_id
            LEFT JOIN (
                SELECT player_id, COUNT(*) AS total_spins
                FROM public.slot_parent_bet
                WHERE player_id = %s
                GROUP BY player_id
            ) stats_spin_counts ON d.player_id = stats_spin_counts.player_id
            WHERE 
                d.bet_at >= %s AND d.bet_at < %s
                AND d.player_id IN ({subquery})
                AND d.player_id = %s
            ORDER BY 
                d.bet_at ASC;
        """
        params = [player_id, start_day, end_exclusive] + subparams + [player_id]
            
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        game_names = get_game_names()
        
        # 將 datetime 物件轉換為格式化字串以利 JSON 序列化
        for row in rows:
            row['game_name'] = game_names.get(str(row['slot_id']), str(row['slot_id']))
            if row['bet_at']:
                row['bet_at'] = row['bet_at'].strftime('%Y-%m-%d %H:%M:%S')
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
    app.run(host='0.0.0.0', port=5000, debug=True)
