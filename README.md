# iGaming 營運分析平台

以 Flask、PostgreSQL、原生 ES Modules 與 Plotly 組成的 Web 儀表板，涵蓋營運總覽、月度營運、遊戲績效及玩家行為分析。

## 專案結構

```text
player_analytics/
├── python/
│   ├── server.py           # API 路由與查詢
│   ├── infrastructure.py   # 設定快取、連線池、查詢逾時、TTL 快取
│   ├── security.py         # 密碼登入、Session、登入頻率限制
│   └── analyzer.py         # 離線 CSV 分析工具（Web 執行不依賴）
├── web/
│   ├── index.html
│   ├── style.css
│   ├── app.js              # 頁面狀態、資料載入與圖表協調
│   └── js/
│       ├── date-utils.js   # 日期與月份純函式
│       └── formatters.js   # 數字、貨幣、時間與 HTML 格式化
├── sql/
│   ├── analytical_query.sql
│   └── db_structure_optimization.sql
└── config.json             # PostgreSQL 與遊戲名稱設定
```

## 啟動

安裝依賴：

```bash
pip install flask psycopg2-binary
```

由專案根目錄啟動：

```bash
python python/server.py
```

瀏覽 `http://localhost:5000`。預設登入密碼為 `jp6vu cl3gj94`。

正式環境請用環境變數覆寫安全設定：

```text
DASHBOARD_PASSWORD=<登入密碼>
DASHBOARD_SESSION_SECRET=<固定且足夠長的隨機字串>
DASHBOARD_COOKIE_SECURE=true
```

`config.json` 保存資料庫連線及 `game_name` 對照。設定會快取，檔案異動時自動重新載入。

## 效能維護

API 使用 PostgreSQL 連線池及 30 秒查詢逾時；可重用的日期列表快取 5 分鐘，營運總覽快取 1 分鐘。資料庫索引不再於 Web 程式啟動時建立，請在低流量時段執行：

```bash
psql -d <database> -f sql/db_structure_optimization.sql
```

Agent 分析上線前請先建立依代理層級彙總的 retention 資料表：

```bash
psql -d <database> -f sql/create_agent_retention.sql
```

`agent_daily_retention` 以 `(date, parent_agent_id, agent_id)` 為主鍵；
`agent_daily_game_retention` 以 `(date, parent_agent_id, agent_id, slot_id)` 為主鍵。
兩張表分別沿用 `casino_retention` 與 `game_retention` 的指標欄位，供營運總覽與 Agent 分析 API 使用。

此腳本包含 `CREATE INDEX CONCURRENTLY`，不可包在 transaction 中。大量匯入後需刷新 `player_daily_summary` 並更新統計資訊。

## 架構說明

瀏覽器仍透過 Flask API 存取資料庫，不應讓前端直接連 PostgreSQL。`analyzer.py` 只是離線分析工具；若不需要匯入 CSV 或輸出獨立 HTML，可以不部署它，但 Web API 的 Python 服務仍需保留。
