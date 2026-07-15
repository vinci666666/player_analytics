import os
import argparse
import pandas as pd
import numpy as np
import plotly.graph_objects as go

def generate_mock_data():
    """產生老虎機旋轉紀錄的合成模擬數據，用於本地開發測試。"""
    print("正在產生模擬數據...")
    np.random.seed(42)
    
    records = []
    player_id = 888001
    
    # 第 1 天：2026-06-25
    base_time = pd.Timestamp("2026-06-25 10:00:00")
    current_slot = 7001
    
    for seq in range(32):
        # 每隔大約 35 秒進行一次旋轉
        bet_at = base_time + pd.Timedelta(seconds=seq * 35 + np.random.randint(-10, 10))
        if seq == 15:
            current_slot = 7002  # 在第 15 次旋轉時模擬切換遊戲
        has_free_game = 22 <= seq <= 26  # 模擬觸發免費遊戲區間
        bet_amount = 5000.0
        
        # 免費遊戲不扣投注額，但有較高機會獲得大獎
        if has_free_game:
            bet_amount = 0.0
            total_prize = np.random.choice([0.0, 10000.0, 100000.0], p=[0.4, 0.4, 0.2])
        else:
            total_prize = np.random.choice([0.0, 5000.0, 15000.0], p=[0.7, 0.2, 0.1])
            
        records.append({
            'player_id': player_id,
            'bet_at': bet_at,
            'slot_id': current_slot,
            'bet_type': 1 if not has_free_game else 3,  # 模擬投注類型 (1: 一般, 3: 特色)
            'has_free_game': has_free_game,
            'bet_amount': bet_amount,
            'total_prize': total_prize
        })
        
    return pd.DataFrame(records)

def load_data_from_db(player_id=None, date_filter=None):
    """自本地 PostgreSQL 資料庫讀取投注流水紀錄，並在 SQL 層進行高效過濾。"""
    print("正在建立 PostgreSQL 資料庫連線 (localhost:5432)...")
    try:
        import psycopg2
    except ImportError:
        print("錯誤：未安裝 'psycopg2' 套件。請執行：pip install psycopg2-binary")
        exit(1)
        
    # 預設連線配置
    config_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'config.json'))
    config = {
        "host": "localhost",
        "port": 5432,
        "database": "analytics",
        "user": "postgres",
        "password": "postgres"
    }
    
    # 讀取共用配置檔案 config.json
    if os.path.exists(config_path):
        try:
            import json
            with open(config_path, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
                local_db = loaded.get("localDB", {})
                if not isinstance(local_db, dict):
                    raise ValueError("config.json localDB must contain a JSON object")
                for key in config:
                    if key in local_db:
                        config[key] = local_db[key]
        except Exception as e:
            print(f"警告：載入 config.json 失敗: {e}")
            
    conn = psycopg2.connect(
        host=config["host"],
        port=config["port"],
        database=config["database"],
        user=config["user"],
        password=config["password"]
    )
    
    # 基礎查詢 SQL，納入 bet_type 欄位
    query = """
    SELECT 
        player_id, 
        bet_at, 
        slot_id, 
        bet_type,
        has_free_game, 
        bet_amount, 
        total_prize 
    FROM 
        public.slot_parent_bet
    """
    
    conditions = []
    params = []
    
    # SQL 條件動態過濾，以防加載整張千萬級別的資料表
    if player_id:
        conditions.append("player_id = %s")
        params.append(player_id)
        
    if date_filter:
        conditions.append("bet_at::date = %s")
        params.append(date_filter)
        
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
        
    query += " ORDER BY bet_at ASC;"
    
    print(f"正在從 public.slot_parent_bet 讀取資料 (過濾條件: player_id={player_id}, date={date_filter})...")
    df = pd.read_sql_query(query, conn, params=params)
    conn.close()
    print(f"成功自資料庫載入 {len(df)} 筆投注紀錄。")
    return df

def analyze_player_data(df):
    """使用 Pandas 對玩家投注明細進行行為特徵與財務指標分析（即時排序與統計）。"""
    df = df.copy()
    
    # 確保數值欄位為 float 類型，避免 Decimal 等類型引起 cumsum() 計算報錯
    for col in ['bet_amount', 'total_prize']:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0.0).astype(float)
            
    # 處理時間戳記與日期分區
    df['bet_at'] = pd.to_datetime(df['bet_at'])
    if not df.empty:
        df['play_date'] = df['bet_at'].dt.date
    else:
        df['play_date'] = pd.Series(dtype='object')
    
    # 按玩家、日期及時間升序排序，確保視窗函數邏輯正確
    df = df.sort_values(by=['player_id', 'play_date', 'bet_at']).reset_index(drop=True)
    
    # 1. 投注序號 (針對個別玩家與日期分區編號，從 1 開始)
    df['play_seq'] = df.groupby(['player_id', 'play_date']).cumcount() + 1
    
    # 2. 遊戲切換檢測 (LAG() 同步：比對當前與前一次老虎機 ID 是否不同)
    df['prev_slot_id'] = df.groupby(['player_id', 'play_date'])['slot_id'].shift(1)
    df['is_game_changed'] = (df['slot_id'] != df['prev_slot_id']) & df['prev_slot_id'].notna()
    
    # 3. 計算單次旋轉淨利 (派彩額 - 投注額)
    df['net_profit'] = df['total_prize'] - df['bet_amount']
    
    # 4. 計算每日累計利潤曲線 (Running Sum)
    df['daily_cum_profit'] = df.groupby(['player_id', 'play_date'])['net_profit'].cumsum()
    
    return df

def generate_interactive_chart(df, player_id=888001, date_filter=None, output_path="player_profit_curve.html"):
    """使用 Plotly 建立精緻的互動式折線圖 HTML 報表。"""
    # 過濾特定玩家
    p_df = df[df['player_id'].astype(str) == str(player_id)].copy()
    if p_df.empty:
        print(f"查無玩家 ID {player_id} 的數據")
        return
        
    # 過濾特定日期，否則預設套用第一個可用日期
    if date_filter:
        p_df = p_df[p_df['play_date'].astype(str) == str(date_filter)]
        if p_df.empty:
            print(f"查無玩家 ID {player_id} 於日期 {date_filter} 的數據")
            return
    else:
        available_dates = p_df['play_date'].unique()
        if len(available_dates) > 0:
            date_filter = available_dates[0]
            p_df = p_df[p_df['play_date'] == date_filter]
            print(f"未指定日期。預設套用該玩家首個可用日期: {date_filter}")
            
    p_df = p_df.sort_values(by='play_seq')
    
    # 格式化數值以利 Tooltips 顯示（防範科學記號）
    p_df['daily_cum_profit_fmt'] = p_df['daily_cum_profit'].apply(lambda x: f"{int(x):,} IDR")
    p_df['net_profit_fmt'] = p_df['net_profit'].apply(lambda x: f"{int(x):,} IDR")
    p_df['bet_amount_fmt'] = p_df['bet_amount'].apply(lambda x: f"{int(x):,} IDR")
    p_df['total_prize_fmt'] = p_df['total_prize'].apply(lambda x: f"{int(x):,} IDR")
    
    # 映射投注類型編碼為易讀字串
    def map_bet_type(b_type):
        if pd.isna(b_type) or b_type is None:
            return "--"
        try:
            val = int(b_type)
            if val == 1:
                return "normal bet"
            elif val == 2:
                return "ante bet"
            elif val == 3:
                return "buy feature"
            else:
                return f"unknown ({val})"
        except (ValueError, TypeError):
            return str(b_type)
            
    p_df['bet_type_name'] = p_df['bet_type'].apply(map_bet_type) if 'bet_type' in p_df.columns else "--"
    
    # 初始化圖表
    fig = go.Figure()
    
    # 繪製主折線圖 (每日累計利潤)
    fig.add_trace(go.Scatter(
        x=p_df['play_seq'],
        y=p_df['daily_cum_profit'],
        mode='lines+markers',
        name='Daily Cumulative Profit',
        line=dict(color='#6366f1', width=3),
        marker=dict(size=6, color='#818cf8'),
        customdata=np.stack((
            p_df['net_profit_fmt'],
            p_df['bet_amount_fmt'],
            p_df['total_prize_fmt'],
            p_df['slot_id'],
            p_df['bet_at'].dt.strftime('%H:%M:%S'),
            p_df['bet_type_name']
        ), axis=-1),
        hovertemplate=(
            "<b>Spin Sequence:</b> #%{x}<br>"
            "<b>Time:</b> %{customdata[4]}<br>"
            "<b>Bet Type:</b> %{customdata[5]}<br>"
            "<b>Game Slot ID:</b> %{customdata[3]}<br>"
            "<b>Cumulative Profit:</b> %{y:,.0f} IDR<br>"
            "<b>Spin Net Profit:</b> %{customdata[0]}<br>"
            "<b>Wager (Bet):</b> %{customdata[1]} | <b>Payout (Prize):</b> %{customdata[2]}<br>"
            "<extra></extra>"
        )
    ))
    
    # 標記免費遊戲旋轉紀錄 (has_free_game = True)
    fg_df = p_df[p_df['has_free_game'] == True]
    if not fg_df.empty:
        fig.add_trace(go.Scatter(
            x=fg_df['play_seq'],
            y=fg_df['daily_cum_profit'],
            mode='markers',
            name='Free Game Spin',
            marker=dict(
                symbol='star',
                size=12,
                color='#10b981',
                line=dict(color='#ffffff', width=1.5)
            ),
            hovertemplate=(
                "<b>⭐ Free Game Feature</b><br>"
                "Spin Sequence: #%{x}<br>"
                "Cumulative Profit: %{y:,.0f} IDR<br>"
                "<extra></extra>"
            )
        ))
        
    # 標記遊戲切換點 (is_game_changed = True)
    gc_df = p_df[p_df['is_game_changed'] == True]
    if not gc_df.empty:
        fig.add_trace(go.Scatter(
            x=gc_df['play_seq'],
            y=gc_df['daily_cum_profit'],
            mode='markers',
            name='Game Switched',
            marker=dict(
                symbol='diamond',
                size=11,
                color='#f59e0b',
                line=dict(color='#ffffff', width=1.5)
            ),
            hovertemplate=(
                "<b>🔄 Game Switched</b><br>"
                "Spin Sequence: #%{x}<br>"
                "New Slot ID: %{text}<br>"
                "Cumulative Profit: %{y:,.0f} IDR<br>"
                "<extra></extra>"
            ),
            text=gc_df['slot_id']
        ))

    # 套用高級暗色調主題樣式
    fig.update_layout(
        title=dict(
            text=f"Player {player_id} Financial Curve - Date: {date_filter}",
            font=dict(size=20, color='#f3f4f6')
        ),
        paper_bgcolor='#0f172a',  # 外圍深藍灰色背景
        plot_bgcolor='#1e293b',   # 畫布背景色
        xaxis=dict(
            title=dict(
                text="Play Sequence Number (play_seq)",
                font=dict(color='#94a3b8')
            ),
            tickfont=dict(color='#94a3b8'),
            gridcolor='#334155',
            zerolinecolor='#475569',
            dtick=5 if len(p_df) > 10 else 1
        ),
        yaxis=dict(
            title=dict(
                text="Daily Cumulative Profit (IDR)",
                font=dict(color='#94a3b8')
            ),
            tickfont=dict(color='#94a3b8'),
            gridcolor='#334155',
            zerolinecolor='#475569',
            tickformat=","  # 大金額整齊千分位格式化
        ),
        legend=dict(
            font=dict(color='#f3f4f6'),
            bgcolor='rgba(15, 23, 42, 0.8)',
            bordercolor='#334155',
            borderwidth=1,
            x=0.02,
            y=0.98
        ),
        margin=dict(l=60, r=40, t=80, b=60),
        hovermode="x unified"
    )
    
    # 輸出儲存為 HTML
    fig.write_html(output_path)
    print(f"互動式圖表已成功輸出至：{output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Analyze iGaming slot player spin sequence sequences.")
    parser.add_argument("--db", action="store_true", help="Load player spin logs from the local PostgreSQL DB.")
    parser.add_argument("--csv", type=str, help="Path to custom CSV input file matching schema.")
    parser.add_argument("--player", type=str, default="888001", help="Player ID to filter and chart.")
    parser.add_argument("--date", type=str, help="Specific Date (YYYY-MM-DD) to chart.")
    parser.add_argument("--out", type=str, default="player_profit_curve.html", help="Path to save output HTML chart.")
    
    args = parser.parse_args()
    
    # 判斷數據加載管道
    if args.db:
        df = load_data_from_db(player_id=args.player, date_filter=args.date)
    elif args.csv:
        if not os.path.exists(args.csv):
            print(f"錯誤：找不到指定的 CSV 檔案：{args.csv}")
            exit(1)
        df = pd.read_csv(args.csv)
    else:
        df = generate_mock_data()
        
    # 執行主運算分析
    analyzed_df = analyze_player_data(df)
    
    # 繪製並匯出 HTML 圖表
    generate_interactive_chart(analyzed_df, player_id=args.player, date_filter=args.date, output_path=args.out)
