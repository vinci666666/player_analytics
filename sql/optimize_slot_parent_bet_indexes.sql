\set ON_ERROR_STOP on

-- Keep one index per active query pattern. Run outside a transaction because
-- CONCURRENTLY minimizes blocking for the live API and synchronizer.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_slot_parent_bet_bet_at_id
ON public.slot_parent_bet (bet_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_utc7_date
ON public.slot_parent_bet ((bet_at_utc7::date));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_utc7_player_id
ON public.slot_parent_bet (bet_at_utc7, player_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_id_bet_at_utc7
ON public.slot_parent_bet (player_id, bet_at_utc7);

-- Supports Agent new-player/history existence checks without fetching every
-- historical row for a player and filtering parent/agent IDs from the heap.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_agent_player_bet_at_utc7
ON public.slot_parent_bet (parent_agent_id, agent_id, player_id, bet_at_utc7);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_id
ON public.slot_parent_bet (player_id);

-- Legacy UTC reporting indexes were replaced by UTC+7 reporting indexes. The
-- new unique cursor index above also replaces the old id-first unique index.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_slot_parent_bet_player_id_bet_at;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_slot_parent_bet_bet_at_player_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_slot_parent_bet_bet_at_date;
DROP INDEX CONCURRENTLY IF EXISTS public.ux_slot_parent_bet_id_bet_at;

REINDEX INDEX CONCURRENTLY public.idx_slot_parent_bet_player_id;
ANALYZE public.slot_parent_bet;
