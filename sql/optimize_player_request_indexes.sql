\set ON_ERROR_STOP on

-- Supports /api/data lifetime-spin lookup without scanning slot_parent_bet.
-- Run directly with psql; CONCURRENTLY must not be wrapped in a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_player_daily_player_date
ON public.player_daily (player_id, date)
INCLUDE (bet_1_spin_count, bet_2_spin_count, bet_3_spin_count);

ANALYZE public.player_daily;
