-- 建立本機 Agent 與遊戲名稱對照表。 / Create local Agent and game-name lookup tables.
-- 名稱由 pro_central 同步，分析 API 僅讀取本機表。 / Names sync from pro_central; analytics APIs read local tables only.

CREATE TABLE IF NOT EXISTS public.agent_name (
    agent_id INTEGER PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL,
    parent_agent INTEGER NOT NULL
);

ALTER TABLE public.agent_name
    ADD COLUMN IF NOT EXISTS parent_agent INTEGER;

CREATE TABLE IF NOT EXISTS public.game_name (
    game_id INTEGER PRIMARY KEY,
    game_name VARCHAR(255) NOT NULL
);

COMMENT ON TABLE public.agent_name IS
    'Agent ID and display name synchronized from pro_central.public.client.';

COMMENT ON TABLE public.game_name IS
    'English (en-US) game names synchronized from pro_central.public.slot_game_name.';
