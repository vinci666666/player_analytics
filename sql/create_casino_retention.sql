-- 建立全站每日營運與 D1/D3/D7 留存表。 / Create daily casino operations and D1/D3/D7 retention storage.

CREATE TABLE IF NOT EXISTS casino_retention (
    date DATE PRIMARY KEY,
    player_count INT8 DEFAULT 0,
    DNU INT8 DEFAULT 0, -- 每日新玩家數。 / Daily new users.
    retention_1 NUMERIC(12, 6) DEFAULT 0,
    retention_3 NUMERIC(12, 6) DEFAULT 0,
    retention_7 NUMERIC(12, 6) DEFAULT 0,
    
    -- 不分投注類型的整體指標。 / Overall metrics across wager types.
    total_spin_count INT8 DEFAULT 0,
    total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    total_win_amount NUMERIC(18, 4) DEFAULT 0,
    rtp NUMERIC(12, 6) DEFAULT 0,
    odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    -- bet_type 1 指標。 / Wager-type 1 metrics.
    bet_1_player_count INT8 DEFAULT 0,
    bet_1_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_1_spin_count INT8 DEFAULT 0,
    bet_1_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_1_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_1_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_1_odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    -- bet_type 2 指標。 / Wager-type 2 metrics.
    bet_2_player_count INT8 DEFAULT 0,
    bet_2_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_2_spin_count INT8 DEFAULT 0,
    bet_2_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_2_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_2_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_2_odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    -- bet_type 3 指標。 / Wager-type 3 metrics.
    bet_3_player_count INT8 DEFAULT 0,
    bet_3_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_3_spin_count INT8 DEFAULT 0,
    bet_3_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_3_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_3_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_3_odd_rtp NUMERIC(12, 6) DEFAULT 0
);
