-- 建立 Agent × 遊戲 × 日期留存快照及查詢索引。 / Create the Agent-by-game daily retention snapshot and indexes.
-- 可重複執行；LIKE 會沿用 game_retention 的指標欄位。 / Idempotent; LIKE inherits metric columns from game_retention.

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

CREATE INDEX IF NOT EXISTS idx_agent_daily_game_retention_scope
    ON public.agent_daily_game_retention (parent_agent_id, agent_id, date, slot_id);

COMMENT ON TABLE public.agent_daily_game_retention IS
    'Daily game retention and wagering metrics grouped by parent agent, agent, and game.';
