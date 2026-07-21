# iGaming 營運分析平台

## Server action log

The server creates `public.server_action_log` at startup and records timestamps
in UTC+7. `message_type_id` values are `1` (information), `2` (warning), `3`
(error), and `4` (authentication). HTTP requests, login/logout attempts including
client IP, background synchronization/backfill messages, warnings, and errors are
persisted. The table can also be created with `sql/create_server_action_log.sql`.

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

`config.json` 保存資料庫連線設定；遊戲與 Agent 名稱分別統一讀取
`localDB.public.game_name`、`localDB.public.agent_name`。

## 效能維護

API 使用 PostgreSQL 連線池及 30 秒查詢逾時；可重用的日期列表快取 5 分鐘，營運總覽快取 1 分鐘。資料庫索引不再於 Web 程式啟動時建立，請在低流量時段執行：

```bash
psql -d <database> -f sql/db_structure_optimization.sql
```

Agent 分析統一讀取 `localDB.public.agent_daily_game_retention`，再依畫面層級彙總 Parent Agent 或 Agent。上線前請先建立遊戲粒度的 Agent retention 資料表：

```bash
psql -d <database> -f sql/create_agent_daily_game_retention.sql
```

`agent_daily_game_retention` 以 `(date, parent_agent_id, agent_id, slot_id)` 為主鍵，
欄位結構仿照 `game_retention`。完整重建成功後，刷新腳本會移除舊的 `agent_daily_retention`。
此表只保存已結束日期；台北時區當日資料固定由 `slot_parent_bet` 即時計算。

從 `slot_parent_bet` 完整重建 Agent-by-game retention 表：

```bash
psql -d <database> -f sql/refresh_agent_retention.sql
```

刷新腳本會在單一 transaction 中重建完整快照；若中途失敗，原有資料不會被部分覆蓋。

此腳本包含 `CREATE INDEX CONCURRENTLY`，不可包在 transaction 中。大量匯入後需刷新 `player_daily_summary` 並更新統計資訊。

服務啟動後會在 `Asia/Taipei` 時區每天 `02:00:00` 自動檢查前一天的
`player_daily`、`casino_retention`、`game_retention` 與
`agent_daily_game_retention`。缺少的日期會從本機 `slot_parent_bet` 補算；四張表的補期在
同一個 transaction 中執行，失敗時會全部回滾。排程也會一併補上原始資料中已存在、
但四張彙總表仍有缺漏的較早日期。

每批 `slot_parent_bet` 同步完成前，服務會重新彙總該批涉及玩家的 `player_stats`，
並在同一個 transaction 中寫入；若 `player_stats` 更新失敗，該批同步也會回滾。
需要手動全量校正時可執行 `sql/insert_player_stats.sql`。

## 架構說明

瀏覽器仍透過 Flask API 存取資料庫，不應讓前端直接連 PostgreSQL。`analyzer.py` 只是離線分析工具；若不需要匯入 CSV 或輸出獨立 HTML，可以不部署它，但 Web API 的 Python 服務仍需保留。
