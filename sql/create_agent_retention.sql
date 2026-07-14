CREATE TABLE IF NOT EXISTS public.agent_daily_retention (
    parent_agent_id INT8 NOT NULL,
    agent_id INT8 NOT NULL,
    LIKE public.casino_retention INCLUDING DEFAULTS INCLUDING GENERATED,
    PRIMARY KEY (date, parent_agent_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_daily_retention_agent_date
    ON public.agent_daily_retention (agent_id, date);

CREATE INDEX IF NOT EXISTS idx_agent_daily_retention_parent_date
    ON public.agent_daily_retention (parent_agent_id, date);

COMMENT ON TABLE public.agent_daily_retention IS
    'Daily casino retention and wagering metrics grouped by parent agent and agent.';

CREATE TABLE IF NOT EXISTS public.agent_daily_game_retention (
    parent_agent_id INT8 NOT NULL,
    agent_id INT8 NOT NULL,
    LIKE public.game_retention INCLUDING DEFAULTS INCLUDING GENERATED,
    PRIMARY KEY (date, parent_agent_id, agent_id, slot_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_daily_game_retention_agent_date
    ON public.agent_daily_game_retention (agent_id, date);

CREATE INDEX IF NOT EXISTS idx_agent_daily_game_retention_parent_date
    ON public.agent_daily_game_retention (parent_agent_id, date);

CREATE INDEX IF NOT EXISTS idx_agent_daily_game_retention_slot_date
    ON public.agent_daily_game_retention (slot_id, date);

COMMENT ON TABLE public.agent_daily_game_retention IS
    'Daily game retention and wagering metrics grouped by parent agent, agent, and game.';
