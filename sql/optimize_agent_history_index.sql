\set ON_ERROR_STOP on

-- 請直接由 psql 且在交易外執行；CONCURRENTLY 建索引時仍允許一般讀寫。
-- Run directly with psql outside a transaction; CONCURRENTLY keeps normal reads and writes available.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_agent_player_bet_at_utc7
ON public.slot_parent_bet (parent_agent_id, agent_id, player_id, bet_at_utc7);

ANALYZE public.slot_parent_bet;
