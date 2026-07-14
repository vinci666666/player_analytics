-- Database structure optimizations for player_analytics.
-- Run during a low-traffic window. The CONCURRENTLY indexes avoid long table
-- write locks, but they can still consume CPU, IO, and disk while building.
--
-- Recommended execution:
--   psql -d <database> -f sql/db_structure_optimization.sql
--
-- Do not wrap this file in BEGIN/COMMIT because CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block.

-- 1) Keep planner statistics fresh after large imports.
ANALYZE public.slot_parent_bet;
ANALYZE public.player_stats;
ANALYZE public.player_daily;
ANALYZE public.game_retention;
ANALYZE public.casino_retention;

-- Runtime startup should only establish connections. Keep schema changes in
-- this explicit migration so deploys remain fast and predictable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_id
ON public.slot_parent_bet (player_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_date
ON public.slot_parent_bet ((bet_at::date));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_player_id
ON public.slot_parent_bet (bet_at, player_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_id_bet_at
ON public.slot_parent_bet (player_id, bet_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_player_daily_date_player
ON public.player_daily (date, player_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_game_retention_date_slot
ON public.game_retention (date, slot_id);

-- 2) Speeds up new/old player filters when PostgreSQL can prefilter
-- player_stats by first_spin_date before joining player_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_player_stats_first_spin_player
ON public.player_stats (first_spin_date, player_id);

-- 3) Optional covering index for player detail pages:
-- Query pattern: one player + date range + ORDER BY bet_at, selecting these
-- columns. This can reduce heap reads if the visibility map is healthy.
--
-- Existing index idx_slot_parent_bet_player_id_bet_at is smaller. Keep both
-- until EXPLAIN shows this covering index is used, then consider dropping the
-- smaller duplicate in a separate maintenance window.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_bet_at_cover
ON public.slot_parent_bet (player_id, bet_at)
INCLUDE (slot_id, bet_type, has_free_game, bet_amount, total_prize);

-- 4) Optional covering index for filter/player-list pages:
-- Query pattern: date range GROUP BY player_id with spin count and win/lose
-- filters. Including amount columns lets PostgreSQL calculate SUMs with fewer
-- heap visits.
--
-- Existing index idx_slot_parent_bet_bet_at_player_id is smaller. Keep both
-- until EXPLAIN confirms this covering index helps under your real filters.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_player_cover
ON public.slot_parent_bet (bet_at, player_id)
INCLUDE (bet_amount, total_prize);

-- 5) High-impact summary structure for filter/player-list queries.
-- This reduces repeated date-range aggregation from slot_parent_bet rows to
-- one row per player per day. Refresh this after loading new betting records.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.player_daily_summary AS
SELECT
    player_id,
    bet_at::date AS play_date,
    COUNT(*) AS spin_count,
    SUM(bet_amount) AS total_bet_amount,
    SUM(total_prize) AS total_prize,
    SUM(total_prize - bet_amount) AS net_profit,
    COUNT(*) FILTER (WHERE has_free_game) AS free_game_count
FROM public.slot_parent_bet
GROUP BY player_id, bet_at::date
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_daily_summary_date_player
ON public.player_daily_summary (play_date, player_id);

CREATE INDEX IF NOT EXISTS idx_player_daily_summary_player_date
ON public.player_daily_summary (player_id, play_date);

-- First fill cannot use CONCURRENTLY because the materialized view starts as
-- unpopulated. Later refreshes can use:
--   REFRESH MATERIALIZED VIEW CONCURRENTLY public.player_daily_summary;
-- Refreshing still reads the base table, so schedule it after imports.
REFRESH MATERIALIZED VIEW public.player_daily_summary;

-- 6) Maintenance commands to run after big imports or refreshes.
ANALYZE public.player_daily_summary;
ANALYZE public.slot_parent_bet;
ANALYZE public.player_stats;
ANALYZE public.player_daily;
ANALYZE public.game_retention;
ANALYZE public.casino_retention;
