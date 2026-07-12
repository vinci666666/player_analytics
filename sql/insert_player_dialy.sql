INSERT INTO player_daily (
    date, player_id, slot_id,
    bet_1_spin_count, total_bet_1_amount, total_win_1_amount, free_game_count_1, bet_1_rtp, bet_1_odd_rtp,
    bet_2_spin_count, total_bet_2_amount, total_win_2_amount, free_game_count_2, bet_2_rtp, bet_2_odd_rtp,
    bet_3_spin_count, total_bet_3_amount, total_win_3_amount, bet_3_rtp, bet_3_odd_rtp
)
SELECT 
    bet_at::date AS date,
    player_id,
    slot_id,
    
    -- bet_type 1
    COUNT(*) FILTER (WHERE bet_type = 1),
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 1), 0),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 1), 0),
    COUNT(*) FILTER (WHERE bet_type = 1 AND has_free_game = TRUE),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 1) / NULLIF(SUM(bet_amount) FILTER (WHERE bet_type = 1), 0), 0) AS bet_1_rtp,
    COALESCE(AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 1), 0) AS bet_1_odd_rtp,

    -- bet_type 2
    COUNT(*) FILTER (WHERE bet_type = 2),
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 2), 0),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 2), 0),
    COUNT(*) FILTER (WHERE bet_type = 2 AND has_free_game = TRUE),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 2) / NULLIF(SUM(bet_amount) FILTER (WHERE bet_type = 2), 0), 0) AS bet_2_rtp,
    COALESCE(AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 2), 0) AS bet_2_odd_rtp,

    -- bet_type 3 (依需求未加入 free_game_count)
    COUNT(*) FILTER (WHERE bet_type = 3),
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 3), 0),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 3), 0),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 3) / NULLIF(SUM(bet_amount) FILTER (WHERE bet_type = 3), 0), 0) AS bet_3_rtp,
    COALESCE(AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 3), 0) AS bet_3_odd_rtp

FROM slot_parent_bet
GROUP BY bet_at::date, player_id, slot_id;