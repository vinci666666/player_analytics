\set ON_ERROR_STOP on

-- 清除重複來源鍵，優先保留 custom_fields 仍含 JSON 的版本，再於同一交易重建衍生表。
-- Remove duplicate source keys, prefer rows retaining custom_fields JSON, and rebuild derived tables atomically.
BEGIN;

SET LOCAL statement_timeout = 0;
SELECT pg_advisory_xact_lock(2000002);
LOCK TABLE public.slot_parent_bet IN ACCESS EXCLUSIVE MODE;

DO $validation$
BEGIN
    IF (SELECT COUNT(*) FROM public._utc7_agent_name_stage) = 0 THEN
        RAISE EXCEPTION 'agent-name staging table is empty';
    END IF;
    IF (SELECT COUNT(*) FROM public._utc7_game_name_stage) = 0 THEN
        RAISE EXCEPTION 'game-name staging table is empty';
    END IF;
END
$validation$;

WITH duplicate_keys AS MATERIALIZED (
    SELECT id, bet_at
    FROM public.slot_parent_bet
    GROUP BY id, bet_at
    HAVING COUNT(*) > 1
),
ranked_duplicates AS (
    SELECT
        facts.ctid,
        ROW_NUMBER() OVER (
            PARTITION BY facts.id, facts.bet_at
            ORDER BY (facts.custom_fields IS NOT NULL) DESC, facts.ctid DESC
        ) AS duplicate_rank
    FROM public.slot_parent_bet AS facts
    JOIN duplicate_keys USING (id, bet_at)
)
DELETE FROM public.slot_parent_bet AS target
USING ranked_duplicates AS duplicate
WHERE target.ctid = duplicate.ctid
  AND duplicate.duplicate_rank > 1;

TRUNCATE TABLE
    public.agent_daily_game_retention,
    public.agent_name,
    public.casino_retention,
    public.game_name,
    public.game_retention,
    public.player_daily,
    public.player_stats;

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

\ir refresh_agent_retention.sql

DROP TABLE public._utc7_agent_name_stage;
DROP TABLE public._utc7_game_name_stage;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_slot_parent_bet_bet_at_id
ON public.slot_parent_bet (bet_at, id);
