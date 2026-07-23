# iGaming 營運分析平台

以 Flask、PostgreSQL、原生 ES Modules 與 Plotly 建置的內部營運儀表板。瀏覽器只透過 Flask API 讀取資料，不會直接連線 PostgreSQL。

## 主要功能

- 營運總覽：當月與當日指標、遊戲排行、Agent 績效及高獲利玩家警示。
- 月度營運：單月、月份比較、季度、半年與年度趨勢，包含留存、RTP、GGR、DNU 與遊戲排行。
- 遊戲績效：依遊戲與日期查看玩家、投注類型、Spin 分布、留存、RTP、GGR，並支援雙遊戲比較。
- Agent 分析：依 Parent Agent、Agent、遊戲逐層下鑽，查看遊戲摘要、每日績效與留存。
- 玩家行為：支援最長一年的日期範圍、遊戲篩選、玩家條件及 Spin 區間篩選。
- 單獨玩家分析：可由玩家行為或營運總覽直接帶入 Player ID 與日期，查看投注序列與各遊戲押注摘要。
- 中英文介面：靜態標籤、動態表格、圖表、投注類型及載入狀態均支援即時切換。
- 全域載入遮罩：資料查詢期間置中顯示載入提示，並阻擋其他操作。

## 技術架構

- 後端：Python、Flask、psycopg2
- 資料庫：PostgreSQL
- 前端：HTML、CSS、原生 JavaScript ES Modules
- 圖表：Plotly.js 2.24.1（由 CDN 載入）
- 時區：營運日期使用 `Asia/Taipei`；Server action log 使用 UTC+7

```text
player_analytics/
├── python/
│   ├── server.py                 # Flask API 與靜態檔案服務
│   ├── infrastructure.py         # 設定、連線池、查詢逾時與 TTL 快取
│   ├── security.py               # 登入、Session 與登入頻率限制
│   ├── server_audit.py           # Server action log
│   ├── slot_parent_bet_sync.py   # 原始投注資料同步
│   ├── daily_backfill.py         # 每日彙總資料補算
│   ├── player_filters.py         # 玩家篩選與日期驗證
│   ├── feature_flags.py          # 背景同步功能開關
│   └── analyzer.py               # 選用的離線 CSV 分析工具
├── web/
│   ├── index.html
│   ├── style.css
│   ├── app.js                    # 頁面狀態、資料載入、語系與圖表協調
│   └── js/
│       ├── date-utils.js         # 日期與月份純函式
│       ├── formatters.js         # 數字、貨幣、時間與 HTML 格式化
│       └── text-fit.js           # 指標文字自動縮放
├── sql/                          # 建表、索引、補資料與維護腳本
├── tests/                        # Python 與前端來源回歸測試
├── config.json                   # 資料庫與背景同步設定
└── README.md
```

## 環境需求

- Python 3.9 以上（程式使用標準函式庫 `zoneinfo`）
- PostgreSQL
- 可連線 `https://cdn.plot.ly` 的瀏覽器
- Node.js（僅在執行 JavaScript 語法檢查時需要）

安裝 Web 服務依賴：

```bash
pip install flask psycopg2-binary
```

若要使用 `python/analyzer.py`，另外安裝：

```bash
pip install pandas numpy plotly
```

## 設定

### 資料庫與同步

`config.json` 包含來源資料庫、本機分析資料庫及同步參數。請使用實際環境的連線資訊，且不要將正式環境密碼提交至版本控制。

主要設定：

```json
{
  "sourceDB": {
    "host": "<source-host>",
    "port": 5432,
    "database": "<database>",
    "user": "<user>",
    "password": "<password>"
  },
  "localDB": {
    "host": "<local-host>",
    "port": 5432,
    "database": "<database>",
    "user": "<user>",
    "password": "<password>"
  },
  "pro_central": {
    "host": "<lookup-source-host>",
    "port": 5432,
    "database": "<database>",
    "user": "<user>",
    "password": "<password>"
  },
  "syncAndSchedulingEnabled": true,
  "slotParentBetSync": {
    "interval_seconds": 600,
    "batch_size": 10000
  }
}
```

將 `syncAndSchedulingEnabled` 設為 `false`，可保留 Web API 服務，但停止 `slot_parent_bet` 背景同步與每日補資料排程。此欄位未設定時預設為 `true`，且只能使用 JSON boolean。

`sourceDB` 是投注原始資料來源、`localDB` 是分析服務使用的本機資料庫，`pro_central` 用於更新遊戲與 Agent 名稱對照表。畫面上的顯示名稱最終讀取：

- `localDB.public.game_name`
- `localDB.public.agent_name`

### 登入安全

正式環境應設定下列環境變數：

```text
DASHBOARD_PASSWORD=<登入密碼>
DASHBOARD_SESSION_SECRET=<固定且足夠長的隨機字串>
DASHBOARD_COOKIE_SECURE=true
```

未設定 `DASHBOARD_SESSION_SECRET` 時，每次啟動會產生隨機 Session key，既有 Session 將在服務重啟後失效。若透過 HTTPS 提供服務，請將 `DASHBOARD_COOKIE_SECURE` 設為 `true`。

## 啟動服務

在專案根目錄執行：

```bash
python python/server.py
```

服務預設監聽 `0.0.0.0:5000`，可由本機瀏覽：

```text
http://localhost:5000
```

目前 `server.py` 以 Flask debug server 啟動；正式環境應改由適合的 WSGI server 提供服務。

## 測試與基本檢查

執行全部單元測試：

```bash
python -m unittest discover -s tests -v
```

檢查前端 JavaScript 語法：

```bash
node --check web/app.js
```

提交前檢查差異格式：

```bash
git diff --check
```

目前測試涵蓋功能開關、玩家篩選、最長一年日期驗證、遊戲 ID 驗證、語系鍵值、動態語系重新渲染及玩家頁面導向。

## 主要 API

| Endpoint | 用途 |
| --- | --- |
| `GET /api/home-dashboard` | 營運總覽 |
| `GET /api/monthly` | 月度營運資料 |
| `GET /api/game` | 遊戲每日績效 |
| `GET /api/game-hourly-players` | 每小時遊戲玩家數 |
| `GET /api/game-spin-medians` | 玩家 Spin 中位數 |
| `GET /api/game-ranking` | 遊戲績效排行 |
| `GET /api/agent-options` | Parent Agent 與 Agent 選項 |
| `GET /api/agent-analysis` | Agent 階層分析 |
| `GET /api/agent-game-performance` | Agent 指定遊戲績效 |
| `GET /api/player-games` | 玩家分析可用的全部遊戲 |
| `GET /api/players` | 依條件篩選玩家 |
| `GET /api/data` | 玩家投注明細與單獨玩家分析 |

API 使用 PostgreSQL 連線池與 30 秒查詢逾時。日期列表快取 5 分鐘；玩家列表快取 30 秒；玩家遊戲列表快取 60 秒；營運總覽快取時間至少 60 秒，並與 `slotParentBetSync.interval_seconds` 對齊。

## 資料庫建置與維護

資料庫索引不會在 Web 服務啟動時自動建立。請在低流量時段執行：

```bash
psql -d <database> -f sql/db_structure_optimization.sql
```

部分索引腳本包含 `CREATE INDEX CONCURRENTLY`，不可包在 transaction 中執行。

### Agent 遊戲留存

Agent 分析使用 `localDB.public.agent_daily_game_retention`，並在前端依 Parent Agent、Agent 或遊戲層級彙總。首次部署可依序執行：

```bash
psql -d <database> -f sql/create_agent_daily_game_retention.sql
psql -d <database> -f sql/refresh_agent_retention.sql
```

此表以 `(date, parent_agent_id, agent_id, slot_id)` 為主鍵，只保存已結束日期；台北時區當日資料由 `slot_parent_bet` 即時計算。刷新腳本會在單一 transaction 中重建完整快照，失敗時不會留下部分更新。

### 每日補資料

背景排程在 `Asia/Taipei` 時區每日 `02:00:00` 檢查：

- `player_daily`
- `casino_retention`
- `game_retention`
- `agent_daily_game_retention`

缺少的日期會由本機 `slot_parent_bet` 補算，四張彙總表在同一個 transaction 中更新，失敗時全部回滾。排程也會補上原始資料已存在、但彙總表仍缺少的歷史日期。

每批 `slot_parent_bet` 同步完成前，服務會重新彙總受影響玩家的 `player_stats`，並在相同 transaction 中寫入。需要手動全量校正時可執行：

```bash
psql -d <database> -f sql/insert_player_stats.sql
```

## Server action log

服務啟動時會建立 `public.server_action_log`，也可手動執行：

```bash
psql -d <database> -f sql/create_server_action_log.sql
```

記錄內容包含 HTTP 請求、登入與登出、Client IP、背景同步、補資料、警告及錯誤。`message_type_id` 定義如下：

| ID | 類型 |
| --- | --- |
| `1` | Information |
| `2` | Warning |
| `3` | Error |
| `4` | Authentication |

## 離線分析工具

`python/analyzer.py` 用於離線匯入 CSV、連線資料庫及輸出獨立 HTML 報告，不是 Web 服務的必要元件。不需要離線分析功能時可不部署，但 `python/server.py` 及其 Web API 相依模組仍必須保留。
