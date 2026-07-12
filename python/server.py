import os
import sys
import json
import calendar
from datetime import datetime, timedelta
from flask import Flask, jsonify, request, send_from_directory
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool

# 初始化 Flask 應用，設定靜態檔案目錄為專案的 web 資料夾
app = Flask(__name__, static_folder=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'web')))

# 設定資料庫配置檔案的絕對路徑
CONFIG_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'config.json'))

def load_db_config():
    """載入資料庫連線配置。如果 config.json 遺失，則會建立預設配置。"""
    default_config = {
        "host": "localhost",
        "port": 5432,
        "database": "analytics",
        "user": "postgres",
        "password": "postgres"
    }
    
    # 若配置檔不存在，則自動寫入預設配置
    if not os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
                json.dump(default_config, f, indent=4)
            print(f"已於 {CONFIG_PATH} 建立預設資料庫設定檔")
        except Exception as e:
            print(f"警告：無法建立設定檔 config.json: {e}", file=sys.stderr)
        return default_config

    # 讀取現有的配置並補齊可能遺失的鍵值
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            config = json.load(f)
            for key, val in default_config.items():
                if key not in config:
                    config[key] = val
            return config
    except Exception as e:
        print(f"讀取 config.json 發生錯誤：{e}。將使用預設設定值。", file=sys.stderr)
        return default_config

def get_game_names():
    """Return the slot_id-to-name mapping configured in config.json."""
    config = load_db_config()
    game_names = config.get("game_name", {})
    return {str(slot_id): str(name) for slot_id, name in game_names.items()}

db_pool = None
dates_cache = {
    "expires_at": None,
    "dates": None,
}
DATES_CACHE_TTL_SECONDS = 300
QUERY_TIMEOUT_MS = 30000
PLAYER_DAILY_SUMMARY = "public.player_daily_summary"

def init_db_pool():
    """初始化資料庫連線池，並自動確認/建立索引。"""
    global db_pool
    config = load_db_config()
    try:
        db_pool = ThreadedConnectionPool(
            minconn=1,
            maxconn=10,
            host=config["host"],
            port=config["port"],
            database=config["database"],
            user=config["user"],
            password=config["password"],
            connect_timeout=5
        )
        print("資料庫連線池初始化成功")
        
        # 自動檢查並建立索引以提升效能
        conn = db_pool.getconn()
        conn.autocommit = True
        cursor = conn.cursor()
        try:
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_slot_parent_bet_player_id ON public.slot_parent_bet (player_id);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_slot_parent_bet_bet_at_date ON public.slot_parent_bet ((bet_at::date));")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_slot_parent_bet_bet_at_player_id ON public.slot_parent_bet (bet_at, player_id);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_slot_parent_bet_player_id_bet_at ON public.slot_parent_bet (player_id, bet_at);")
            print("資料庫效能索引確認與建立完成")
        except Exception as idx_err:
            print(f"警告：自動建立索引失敗: {idx_err}", file=sys.stderr)
        finally:
            conn.autocommit = False
            db_pool.putconn(conn)
    except Exception as e:
        print("\n=== 資料庫連線錯誤 (DATABASE CONNECTION ERROR) ===", file=sys.stderr)
        print(f"無法建立連線池: {config}", file=sys.stderr)
        print(f"錯誤原因: {e}", file=sys.stderr)
        raise e

def get_db_connection():
    """從連線池獲取 PostgreSQL 連線。"""
    global db_pool
    if db_pool is None:
        init_db_pool()
    conn = db_pool.getconn()
    conn.autocommit = False
    return conn

def release_db_connection(conn):
    """將連線釋放回連線池。"""
    global db_pool
    if db_pool and conn:
        try:
            if not conn.closed:
                conn.rollback()
        except Exception as rollback_err:
            print(f"Failed to reset database connection before returning it to the pool: {rollback_err}", file=sys.stderr)
        db_pool.putconn(conn)

def apply_query_timeout(cursor):
    cursor.execute("SET LOCAL statement_timeout = %s", (QUERY_TIMEOUT_MS,))

def db_error_response(error):
    error_text = str(error)
    if "statement timeout" in error_text or "canceling statement due to statement timeout" in error_text:
        return jsonify({"error": "查詢超過 30 秒，請縮小範圍或重新送出請求"}), 504
    return jsonify({"error": error_text}), 500

def first_column(row):
    if isinstance(row, dict):
        return next(iter(row.values()))
    return row[0]

def is_player_daily_summary_available(cursor):
    cursor.execute("""
        SELECT COALESCE((
            SELECT c.relkind = 'm' AND c.relispopulated
            FROM pg_class c
            WHERE c.oid = to_regclass(%s)
        ), false) AS is_available;
    """, (PLAYER_DAILY_SUMMARY,))
    return bool(first_column(cursor.fetchone()))

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
    if dates_cache["dates"] is not None and dates_cache["expires_at"] and datetime.utcnow() < dates_cache["expires_at"]:
        return jsonify(dates_cache["dates"])

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
        dates_cache["dates"] = dates
        dates_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=DATES_CACHE_TTL_SECONDS)
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
                bet_1_player_count, bet_1_spin_count, bet_1_total_bet_amount, bet_1_total_win_amount,
                bet_2_player_count, bet_2_spin_count, bet_2_total_bet_amount, bet_2_total_win_amount,
                bet_3_player_count, bet_3_spin_count, bet_3_total_bet_amount, bet_3_total_win_amount
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
