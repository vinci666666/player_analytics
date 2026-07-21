\set ON_ERROR_STOP on

-- Run directly with psql and outside a transaction. CONCURRENTLY keeps normal
-- reads and writes available while PostgreSQL builds the index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_agent_player_bet_at_utc7
ON public.slot_parent_bet (parent_agent_id, agent_id, player_id, bet_at_utc7);

ANALYZE public.slot_parent_bet;
