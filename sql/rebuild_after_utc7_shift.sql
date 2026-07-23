\set ON_ERROR_STOP on

-- 一次性遷移：將既有 UTC+7 時間拆為來源 UTC bet_at 與報表時間 bet_at_utc7，再重建衍生表。
-- One-time migration: split UTC+7 timestamps into source-UTC bet_at and reporting-time bet_at_utc7, then rebuild derivatives.
-- 執行前需填入 Agent／遊戲名稱暫存表；空暫存表會安全中止。
-- Populate the Agent/game name staging tables first; empty staging tables abort safely.
BEGIN;

SET LOCAL statement_timeout = 0;
SELECT pg_advisory_xact_lock(2000002);
LOCK TABLE public.slot_parent_bet IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.slot_parent_bet
    ADD COLUMN IF NOT EXISTS bet_at_utc7 timestamp without time zone;

DO $validation$
BEGIN
    IF (
        SELECT col_description(
            'public.slot_parent_bet'::regclass,
            (SELECT attnum
             FROM pg_attribute
             WHERE attrelid = 'public.slot_parent_bet'::regclass
               AND attname = 'bet_at_utc7')
        ) = 'UTC+7 reporting time derived from source bet_at.'
    ) THEN
        RAISE EXCEPTION 'slot_parent_bet already uses separate UTC and UTC+7 columns';
    END IF;
    IF (SELECT COUNT(*) FROM public._utc7_agent_name_stage) = 0 THEN
        RAISE EXCEPTION 'agent-name staging table is empty';
    END IF;
    IF (SELECT COUNT(*) FROM public._utc7_game_name_stage) = 0 THEN
        RAISE EXCEPTION 'game-name staging table is empty';
    END IF;
END
$validation$;

TRUNCATE TABLE
    public.agent_daily_game_retention,
    public.agent_name,
    public.casino_retention,
    public.game_name,
    public.game_retention,
    public.player_daily,
    public.player_stats;

UPDATE public.slot_parent_bet
SET bet_at_utc7 = bet_at,
    bet_at = bet_at - INTERVAL '7 hours'
WHERE bet_at IS NOT NULL;

COMMENT ON COLUMN public.slot_parent_bet.bet_at IS
    'UTC timestamp copied directly from sourceDB.';
COMMENT ON COLUMN public.slot_parent_bet.bet_at_utc7 IS
    'UTC+7 reporting time derived from source bet_at.';

ALTER TABLE public.slot_parent_bet
    ALTER COLUMN bet_at_utc7 SET NOT NULL;

\ir insert_player_stats.sql
\ir insert_player_dialy.sql
\ir inster_casino_retention.sql
\ir insert_game_retention.sql

INSERT INTO public.agent_name (agent_id, agent_name, parent_agent)
SELECT agent_id, agent_name, parent_agent
FROM public._utc7_agent_name_stage;

INSERT INTO public.game_name (game_id, game_name)
SELECT game_id, game_name
FROM public._utc7_game_name_stage;

ANALYZE public.slot_parent_bet;
ANALYZE public.player_stats;
ANALYZE public.player_daily;
ANALYZE public.casino_retention;
ANALYZE public.game_retention;

COMMIT;

-- This script owns its transaction and rebuilds the Agent-by-game snapshot.
\ir refresh_agent_retention.sql

DROP TABLE public._utc7_agent_name_stage;
DROP TABLE public._utc7_game_name_stage;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_utc7_date
ON public.slot_parent_bet ((bet_at_utc7::date));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_bet_at_utc7_player_id
ON public.slot_parent_bet (bet_at_utc7, player_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slot_parent_bet_player_id_bet_at_utc7
ON public.slot_parent_bet (player_id, bet_at_utc7);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_slot_parent_bet_bet_at_id
ON public.slot_parent_bet (bet_at, id);
