"""離線玩家投注分析與 HTML 圖表輸出工具。 / Offline wager analysis and HTML chart generator."""

import os
import argparse
import pandas as pd
import numpy as np
import plotly.graph_objects as go

def generate_mock_data():
    """產生本機開發用的合成 Spin 紀錄。 / Generate synthetic spin records for local development."""
    print("正在產生模擬數據...")
    np.random.seed(42)
    
    records = []
    player_id = 888001
    
    # 第 1 天：建立主要投注序列。 / Day 1: build the primary wager sequence.
    base_time = pd.Timestamp("2026-06-25 10:00:00")
    current_slot = 7001
    
    for seq in range(32):
        # 每隔約 35 秒建立一次 Spin。 / Generate one spin about every 35 seconds.
        bet_at_utc7 = base_time + pd.Timedelta(seconds=seq * 35 + np.random.randint(-10, 10))
        if seq == 15:
            current_slot = 7002  # 在第 15 次旋轉時模擬切換遊戲
        has_free_game = 22 <= seq <= 26  # 模擬觸發免費遊戲區間
        bet_amount = 5000.0
        
        # 免費遊戲不扣投注額，並提高派彩樣本。 / Free games cost no wager and use a higher payout sample.
        if has_free_game:
            bet_amount = 0.0
            total_prize = np.random.choice([0.0, 10000.0, 100000.0], p=[0.4, 0.4, 0.2])
        else:
            total_prize = np.random.choice([0.0, 5000.0, 15000.0], p=[0.7, 0.2, 0.1])
            
        records.append({
            'player_id': player_id,
            'bet_at_utc7': bet_at_utc7,
            'slot_id': current_slot,
            'bet_type': 1 if not has_free_game else 3,  # 模擬投注類型 (1: 一般, 3: 特色)
            'has_free_game': has_free_game,
            'bet_amount': bet_amount,
            'total_prize': total_prize
        })
        
    return pd.DataFrame(records)

def load_data_from_db(player_id=None, date_filter=None):
    """從 PostgreSQL 讀取投注流水並於 SQL 層篩選。 / Load wagers from PostgreSQL with SQL-side filtering."""
    print("正在建立 PostgreSQL 資料庫連線 (localhost:5432)...")
    try:
        import psycopg2
    except ImportError:
        print("錯誤：未安裝 'psycopg2' 套件。請執行：pip install psycopg2-binary")
        exit(1)
        
    # 無設定檔時使用本機預設連線。 / Use local connection defaults when config is unavailable.
    config_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'config.json'))
    config = {
        "host": "localhost",
        "port": 5432,
        "database": "analytics",
        "user": "postgres",
        "password": "postgres"
    }
    
    # 讀取 Web 服務共用的 config.json。 / Read config.json shared with the Web service.
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
    
    # 基礎查詢包含行為分析需要的 bet_type。 / Base query includes bet_type for behavior analysis.
    query = """
    SELECT 
        player_id, 
        bet_at_utc7,
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
    
    # 將條件下推 SQL，避免載入整張大型資料表。 / Push filters into SQL to avoid loading the full fact table.
    if player_id:
        conditions.append("player_id = %s")
        params.append(player_id)
        
    if date_filter:
        conditions.append("bet_at_utc7::date = %s")
        params.append(date_filter)
        
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
        
    query += " ORDER BY bet_at_utc7 ASC;"
    
    print(f"正在從 public.slot_parent_bet 讀取資料 (過濾條件: player_id={player_id}, date={date_filter})...")
    df = pd.read_sql_query(query, conn, params=params)
    conn.close()
    print(f"成功自資料庫載入 {len(df)} 筆投注紀錄。")
    return df

def analyze_player_data(df):
    """以 Pandas 計算行為與財務指標。 / Use Pandas to derive behavioral and financial metrics."""
    df = df.copy()
    
    # 轉為 float，避免 Decimal 與 cumsum 不相容。 / Convert to float so Decimal values do not break cumsum.
    for col in ['bet_amount', 'total_prize']:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0.0).astype(float)
            
    # 建立排序時間戳與每日分區鍵。 / Build sortable timestamps and daily partition keys.
    df['bet_at_utc7'] = pd.to_datetime(df['bet_at_utc7'])
    if not df.empty:
        df['play_date'] = df['bet_at_utc7'].dt.date
    else:
        df['play_date'] = pd.Series(dtype='object')
    
    # 先排序以確保序號、LAG 與累加語意正確。 / Sort first so sequence, LAG, and running sums are correct.
    df = df.sort_values(by=['player_id', 'play_date', 'bet_at_utc7']).reset_index(drop=True)
    
    # 1. 每位玩家每日從 1 起算投注序號。 / 1. Number wagers from 1 per player and day.
    df['play_seq'] = df.groupby(['player_id', 'play_date']).cumcount() + 1
    
    # 2. 比較前後 slot_id 偵測遊戲切換。 / 2. Detect game switches by comparing adjacent slot_id values.
    df['prev_slot_id'] = df.groupby(['player_id', 'play_date'])['slot_id'].shift(1)
    df['is_game_changed'] = (df['slot_id'] != df['prev_slot_id']) & df['prev_slot_id'].notna()
    
    # 3. 單次淨利＝派彩－投注。 / 3. Per-spin net profit equals payout minus wager.
    df['net_profit'] = df['total_prize'] - df['bet_amount']
    
    # 4. 依玩家與日期計算累積損益。 / 4. Compute running profit per player and day.
    df['daily_cum_profit'] = df.groupby(['player_id', 'play_date'])['net_profit'].cumsum()
    
    return df

def generate_interactive_chart(df, player_id=888001, date_filter=None, output_path="player_profit_curve.html"):
    """以 Plotly 輸出互動式累積損益 HTML。 / Export an interactive cumulative-profit HTML chart with Plotly."""
    # 套用指定玩家條件。 / Apply the requested player filter.
    p_df = df[df['player_id'].astype(str) == str(player_id)].copy()
    if p_df.empty:
        print(f"查無玩家 ID {player_id} 的數據")
        return
        
    # 套用指定日期，缺省時使用首個可用日期。 / Use the requested date or the first available date.
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
    
    # 預先格式化提示數值，避免科學記號。 / Preformat tooltip values to avoid scientific notation.
    p_df['daily_cum_profit_fmt'] = p_df['daily_cum_profit'].apply(lambda x: f"{int(x):,} IDR")
    p_df['net_profit_fmt'] = p_df['net_profit'].apply(lambda x: f"{int(x):,} IDR")
    p_df['bet_amount_fmt'] = p_df['bet_amount'].apply(lambda x: f"{int(x):,} IDR")
    p_df['total_prize_fmt'] = p_df['total_prize'].apply(lambda x: f"{int(x):,} IDR")
    
    # 將投注代碼映射為可讀名稱。 / Map wager codes to readable labels.
    def map_bet_type(b_type):
        """將數字投注類型轉為報表顯示文字。 / Map numeric wager types to report labels."""
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
    
    # 初始化可疊加多個事件 Trace 的圖表。 / Initialize a figure that can layer multiple event traces.
    fig = go.Figure()
    
    # 繪製每日累積損益主線。 / Draw the main daily cumulative-profit line.
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
            p_df['bet_at_utc7'].dt.strftime('%H:%M:%S'),
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
    
    # 疊加免費遊戲事件標記。 / Overlay free-game event markers.
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
        
    # 疊加遊戲切換事件標記。 / Overlay game-switch event markers.
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

    # 套用離線報表的深色主題。 / Apply the dark theme used by offline reports.
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
    
    # 輸出自包含互動 HTML。 / Write the interactive HTML output.
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
    
    # 依 CLI 參數選擇 CSV、資料庫或模擬資料。 / Select CSV, database, or mock input from CLI arguments.
    if args.db:
        df = load_data_from_db(player_id=args.player, date_filter=args.date)
    elif args.csv:
        if not os.path.exists(args.csv):
            print(f"錯誤：找不到指定的 CSV 檔案：{args.csv}")
            exit(1)
        df = pd.read_csv(args.csv)
    else:
        df = generate_mock_data()
        
    # 執行共用衍生欄位計算。 / Run the shared feature-derivation step.
    analyzed_df = analyze_player_data(df)
    
    # 繪製並匯出最終 HTML。 / Render and export the final HTML report.
    generate_interactive_chart(analyzed_df, player_id=args.player, date_filter=args.date, output_path=args.out)
