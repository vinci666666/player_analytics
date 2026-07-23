\set ON_ERROR_STOP on

-- 支援 /api/data 查詢生命週期 Spin，避免掃描 slot_parent_bet。
-- Supports /api/data lifetime-spin lookup without scanning slot_parent_bet.
-- 請直接由 psql 執行；CONCURRENTLY 不可包在交易內。 / Run directly with psql outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_player_daily_player_date
ON public.player_daily (player_id, date)
INCLUDE (bet_1_spin_count, bet_2_spin_count, bet_3_spin_count);

ANALYZE public.player_daily;
