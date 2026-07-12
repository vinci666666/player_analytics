CREATE TABLE IF NOT EXISTS casino_retention (
    date DATE PRIMARY KEY,
    player_count INT8 DEFAULT 0,
    DNU INT8 DEFAULT 0, -- 每日新玩家數
    retention_1 NUMERIC(12, 6) DEFAULT 0,
    retention_3 NUMERIC(12, 6) DEFAULT 0,
    retention_7 NUMERIC(12, 6) DEFAULT 0,
    
    -- 整體數據 (不分 bet_type)
    total_spin_count INT8 DEFAULT 0,
    total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    total_win_amount NUMERIC(18, 4) DEFAULT 0,
    rtp NUMERIC(12, 6) DEFAULT 0,
    odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    -- bet_type 1 數據
    bet_1_player_count INT8 DEFAULT 0,
    bet_1_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_1_spin_count INT8 DEFAULT 0,
    bet_1_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_1_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_1_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_1_odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    -- bet_type 2 數據
    bet_2_player_count INT8 DEFAULT 0,
    bet_2_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_2_spin_count INT8 DEFAULT 0,
    bet_2_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_2_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_2_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_2_odd_rtp NUMERIC(12, 6) DEFAULT 0,
    
    -- bet_type 3 數據
    bet_3_player_count INT8 DEFAULT 0,
    bet_3_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_3_spin_count INT8 DEFAULT 0,
    bet_3_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_3_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_3_rtp NUMERIC(12, 6) DEFAULT 0,
    bet_3_odd_rtp NUMERIC(12, 6) DEFAULT 0
);