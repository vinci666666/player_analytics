-- player_analytics 資料庫結構最佳化。 / Database structure optimizations for player_analytics.
-- 請於低流量執行；CONCURRENTLY 降低寫入鎖定，但仍消耗 CPU、IO 與磁碟。
-- Run during low traffic; CONCURRENTLY reduces write locking but still consumes CPU, IO, and disk.
--
-- 建議執行方式 / Recommended execution:
--   psql -d <database> -f sql/db_structure_optimization.sql
--
-- 不可包在 BEGIN/COMMIT，因 CREATE INDEX CONCURRENTLY
-- 無法在交易區塊內執行。 / cannot run inside a transaction block.

-- 1) 大量匯入後更新查詢規劃統計。 / 1) Refresh planner statistics after large imports.
ANALYZE public.slot_parent_bet;
ANALYZE public.player_stats;
ANALYZE public.player_daily;
ANALYZE public.game_retention;
ANALYZE public.casino_retention;

-- 執行期啟動只建立連線；結構變更集中於明確遷移，使部署快速且可預測。
-- Runtime startup only establishes connections; explicit migrations keep deploys predictable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_id
ON public.slot_parent_bet (player_id);

-- 保證來源鍵唯一並支援增量游標查詢。 / Enforce source-key uniqueness and support the incremental cursor query:
-- ORDER BY bet_at DESC, id DESC LIMIT 1.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_slot_parent_bet_bet_at_id
ON public.slot_parent_bet (bet_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_utc7_date
ON public.slot_parent_bet ((bet_at_utc7::date));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_utc7_player_id
ON public.slot_parent_bet (bet_at_utc7, player_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_id_bet_at_utc7
ON public.slot_parent_bet (player_id, bet_at_utc7);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_agent_player_bet_at_utc7
ON public.slot_parent_bet (parent_agent_id, agent_id, player_id, bet_at_utc7);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_player_daily_date_player
ON public.player_daily (date, player_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_player_daily_player_date
ON public.player_daily (player_id, date)
INCLUDE (bet_1_spin_count, bet_2_spin_count, bet_3_spin_count);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_game_retention_date_slot
ON public.game_retention (date, slot_id);

-- 2) 讓 PostgreSQL 先依 first_spin_date 過濾 player_stats，加速新／舊玩家條件。
-- 2) Prefilter player_stats by first_spin_date to speed up new/old-player filters.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_player_stats_first_spin_player
ON public.player_stats (first_spin_date, player_id);

-- 3) 玩家明細頁選用 covering index：玩家＋日期＋bet_at_utc7 排序。
-- 3) Optional covering index for player detail queries ordered by bet_at_utc7.
-- visibility map 健康時可降低 heap 讀取。 / A healthy visibility map can reduce heap reads.
--
-- 既有索引較小；先並存，待 EXPLAIN 證實 covering index 有效後再於維護時段移除重複索引。
-- Keep the smaller existing index until EXPLAIN proves the covering index useful, then drop separately.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_bet_at_utc7_cover
ON public.slot_parent_bet (player_id, bet_at_utc7)
INCLUDE (slot_id, bet_type, has_free_game, bet_amount, total_prize);

-- 4) 玩家列表選用 covering index：日期範圍、player_id 分組、Spin 與盈虧條件。
-- 4) Optional covering index for date-range player lists grouped by player_id.
-- INCLUDE 金額欄可減少 SUM 所需 heap 存取。 / Included amounts reduce heap visits for SUM calculations.
--
-- 先保留較小既有索引，待真實條件的 EXPLAIN 確認後再決定。
-- Keep the smaller existing index until EXPLAIN confirms benefits under real filters.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_utc7_player_cover
ON public.slot_parent_bet (bet_at_utc7, player_id)
INCLUDE (bet_amount, total_prize);

-- 5) 玩家篩選高效日彙總：將原始投注壓縮為每玩家每日一列。
-- 5) High-impact daily summary: reduce raw wagers to one row per player per day.
-- 載入新投注後必須刷新。 / Refresh after loading new wager records.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.player_daily_summary AS
SELECT
    player_id,
    bet_at_utc7::date AS play_date,
    COUNT(*) AS spin_count,
    SUM(bet_amount) AS total_bet_amount,
    SUM(total_prize) AS total_prize,
    SUM(total_prize - bet_amount) AS net_profit,
    COUNT(*) FILTER (WHERE has_free_game) AS free_game_count
FROM public.slot_parent_bet
GROUP BY player_id, bet_at_utc7::date
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_daily_summary_date_player
ON public.player_daily_summary (play_date, player_id);

CREATE INDEX IF NOT EXISTS idx_player_daily_summary_player_date
ON public.player_daily_summary (player_id, play_date);

-- 首次填入不可用 CONCURRENTLY；後續刷新可使用：
-- The first fill cannot use CONCURRENTLY; later refreshes may use:
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.player_daily_summary;
-- 刷新仍會讀取基礎表，應安排在匯入後。 / Refresh still reads the base table, so schedule it after imports.
REFRESH MATERIALIZED VIEW public.player_daily_summary;

-- 6) 大量匯入或刷新後的維護命令。 / 6) Maintenance after large imports or refreshes.
ANALYZE public.player_daily_summary;
ANALYZE public.slot_parent_bet;
ANALYZE public.player_stats;
ANALYZE public.player_daily;
ANALYZE public.game_retention;
ANALYZE public.casino_retention;
