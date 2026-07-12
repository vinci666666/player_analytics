CREATE TABLE IF NOT EXISTS player_daily (
    date DATE,
    player_id INT8,
    slot_id INT8,
    
    -- bet_type 1
    bet_1_spin_count INT8 DEFAULT 0,
    total_bet_1_amount NUMERIC(18, 4) DEFAULT 0,
    total_win_1_amount NUMERIC(18, 4) DEFAULT 0,
    free_game_count_1 INT8 DEFAULT 0,
    bet_1_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_1_odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    -- bet_type 2
    bet_2_spin_count INT8 DEFAULT 0,
    total_bet_2_amount NUMERIC(18, 4) DEFAULT 0,
    total_win_2_amount NUMERIC(18, 4) DEFAULT 0,
    free_game_count_2 INT8 DEFAULT 0,
    bet_2_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_2_odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    -- bet_type 3
    bet_3_spin_count INT8 DEFAULT 0,
    total_bet_3_amount NUMERIC(18, 4) DEFAULT 0,
    total_win_3_amount NUMERIC(18, 4) DEFAULT 0,
    bet_3_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_3_odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    PRIMARY KEY (date, player_id, slot_id)
);