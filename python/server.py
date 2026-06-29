import os
import sys
import json
import calendar
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory
import psycopg2
from psycopg2.extras import RealDictCursor

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

def get_db_connection():
    """依據 config.json 的配置建立並回傳 PostgreSQL 連線。"""
    config = load_db_config()
    try:
        return psycopg2.connect(
            host=config["host"],
            port=config["port"],
            database=config["database"],
            user=config["user"],
            password=config["password"],
            connect_timeout=5  # 設定超時為 5 秒
        )
    except psycopg2.OperationalError as e:
        # 連線失敗時輸出詳細偵錯建議
        print("\n=== 資料庫連線錯誤 (DATABASE CONNECTION ERROR) ===", file=sys.stderr)
        print(f"無法使用設定連線至 PostgreSQL: {config}", file=sys.stderr)
        print(f"錯誤原因: {e}", file=sys.stderr)
        print("請確認 PostgreSQL 服務是否正常運行，且 config.json 中的連線資訊是否正確。\n", file=sys.stderr)
        raise e

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
    """獲取資料表中有投注紀錄的所有不重複日期清單（遞減排序）。"""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        query = """
        SELECT DISTINCT bet_at::date AS play_date
        FROM public.slot_parent_bet
        WHERE bet_at IS NOT NULL
        ORDER BY play_date DESC;
        """
        cursor.execute(query)
        rows = cursor.fetchall()
        # 格式化日期為 YYYY-MM-DD 字串陣列
        dates = [row[0].strftime('%Y-%m-%d') for row in rows]
        return jsonify(dates)
    except Exception as e:
        print(f"獲取日期清單失敗: {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()

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

def build_filtered_players_subquery(start_date, end_date, filters):
    """Build the reusable filtered-player subquery and params."""
    query = """
        SELECT p.player_id
        FROM public.slot_parent_bet p
        LEFT JOIN public.player_stats s ON p.player_id = s.player_id
        WHERE p.bet_at::date >= %s AND p.bet_at::date <= %s
    """
    params = [start_date, end_date]

    # 新玩家：首次 spin 日期落在篩選日期範圍內；舊玩家：首次 spin 日期早於篩選開始日。
    if filters["new_player"] and not filters["old_player"]:
        query += " AND s.first_spin_date >= %s AND s.first_spin_date <= %s"
        params.extend([start_date, end_date])
    elif filters["old_player"] and not filters["new_player"]:
        query += " AND s.first_spin_date < %s"
        params.append(start_date)

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

        subquery, params = build_filtered_players_subquery(start_date, end_date, filters)
        query = f"SELECT player_id FROM ({subquery}) filtered_players ORDER BY player_id;"
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        # 回傳字串化的玩家 ID 陣列
        players = [str(row[0]) for row in rows]
        return jsonify(players)
    except Exception as e:
        print(f"查詢特定條件玩家清單失敗 ({start_date} ~ {end_date}): {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()

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

        subquery, subparams = build_filtered_players_subquery(start_date, end_date, filters)

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
                GROUP BY player_id
            ) stats_spin_counts ON d.player_id = stats_spin_counts.player_id
            WHERE 
                d.bet_at::date >= %s AND d.bet_at::date <= %s
                AND d.player_id IN ({subquery})
                AND d.player_id = %s
            ORDER BY 
                d.bet_at ASC;
        """
        params = [start_date, end_date] + subparams + [player_id]
            
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        
        # 將 datetime 物件轉換為格式化字串以利 JSON 序列化
        for row in rows:
            if row['bet_at']:
                row['bet_at'] = row['bet_at'].strftime('%Y-%m-%d %H:%M:%S')
            if row.get('stats_first_spin_date'):
                row['stats_first_spin_date'] = row['stats_first_spin_date'].strftime('%Y-%m-%d')
            if row.get('stats_last_spin_at'):
                row['stats_last_spin_at'] = row['stats_last_spin_at'].strftime('%Y-%m-%d %H:%M:%S')
                
        return jsonify(rows)
    except Exception as e:
        print(f"獲取玩家 {player_id} 於日期區間 {start_date} ~ {end_date} 的投注明細失敗: {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()

if __name__ == '__main__':
    print("----------------------------------------------------------------")
    print(" 正在啟動 API 與靜態伺服器：http://localhost:5000")
    print(f" 目前使用的資料庫設定檔：{CONFIG_PATH}")
    print("----------------------------------------------------------------")
    app.run(host='0.0.0.0', port=5000, debug=True)
