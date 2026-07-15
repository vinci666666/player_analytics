CREATE TABLE IF NOT EXISTS public.agent_name (
    agent_id INTEGER PRIMARY KEY,
    agent_name VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.game_name (
    game_id INTEGER PRIMARY KEY,
    game_name VARCHAR(255) NOT NULL
);

COMMENT ON TABLE public.agent_name IS
    'Agent ID and display name synchronized from pro_central.public.client.';

COMMENT ON TABLE public.game_name IS
    'English (en-US) game names synchronized from pro_central.public.slot_game_name.';
