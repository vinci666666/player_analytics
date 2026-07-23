-- 全量重建玩家生命週期統計。 / Fully rebuild lifetime player statistics.
-- 先彙總來源再 upsert，避免同一玩家多次更新。 / Aggregate first, then upsert each player once.

WITH source_aggregated AS (
    SELECT 
        s.player_id,
        MAX(s.player_username) AS player_username,
        MIN(s.bet_at_utc7)::date AS first_spin_date,
        COALESCE(SUM(s.bet_amount), 0) AS total_bet_amount,
        COALESCE(SUM(s.total_prize), 0) AS total_win_amount,
        MAX(s.bet_at_utc7) AS last_spin_at
    FROM public.slot_parent_bet s
    GROUP BY s.player_id
)
INSERT INTO public.player_stats (
    player_id, 
    player_username, 
    first_spin_date, 
    total_bet_amount, 
    total_win_amount, 
    last_spin_at
)
SELECT 
    player_id, 
    player_username, 
    first_spin_date, 
    total_bet_amount,
    total_win_amount,
    last_spin_at
FROM source_aggregated

ON CONFLICT (player_id) 
DO UPDATE SET 
    player_username = EXCLUDED.player_username,
    first_spin_date = EXCLUDED.first_spin_date,
    total_bet_amount = EXCLUDED.total_bet_amount,
    total_win_amount = EXCLUDED.total_win_amount,
    last_spin_at = EXCLUDED.last_spin_at;
