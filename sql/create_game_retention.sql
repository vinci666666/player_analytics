-- 建立遊戲每日績效、投注類型與 Spin 分布表。 / Create daily game metrics, wager-type, and spin-distribution storage.

CREATE TABLE IF NOT EXISTS game_retention (
    date DATE,
    slot_id INT8,
    player_count INT8 DEFAULT 0,
    DNU INT8 DEFAULT 0, -- 該遊戲每日新玩家數。 / Daily new users for this game.
    retention_1 NUMERIC(12, 6) DEFAULT 0,
    retention_3 NUMERIC(12, 6) DEFAULT 0,
    retention_7 NUMERIC(12, 6) DEFAULT 0,
    
    total_spin_count INT8 DEFAULT 0,
    total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    total_win_amount NUMERIC(18, 4) DEFAULT 0,
    
    -- bet_type 1 指標。 / Wager-type 1 metrics.
    bet_1_player_count INT8 DEFAULT 0,
    bet_1_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_1_spin_count INT8 DEFAULT 0,
    bet_1_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_1_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_1_avg_amount NUMERIC(18, 4) DEFAULT 0,
    
    -- bet_type 2 指標。 / Wager-type 2 metrics.
    bet_2_player_count INT8 DEFAULT 0,
    bet_2_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_2_spin_count INT8 DEFAULT 0,
    bet_2_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_2_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_2_avg_amount NUMERIC(18, 4) DEFAULT 0,
    
    -- bet_type 3 指標。 / Wager-type 3 metrics.
    bet_3_player_count INT8 DEFAULT 0,
    bet_3_player_avg_bet_count NUMERIC(18, 4) DEFAULT 0,
    bet_3_spin_count INT8 DEFAULT 0,
    bet_3_total_bet_amount NUMERIC(18, 4) DEFAULT 0,
    bet_3_total_win_amount NUMERIC(18, 4) DEFAULT 0,
    bet_3_avg_amount NUMERIC(18, 4) DEFAULT 0,

    -- bet_type 1 玩家 Spin 次數分布。 / Wager-type 1 player spin-count distribution.
    dist_0_10 NUMERIC(12, 6) DEFAULT 0,
    dist_10_20 NUMERIC(12, 6) DEFAULT 0,
    dist_20_50 NUMERIC(12, 6) DEFAULT 0,
    dist_50_100 NUMERIC(12, 6) DEFAULT 0,
    dist_100_300 NUMERIC(12, 6) DEFAULT 0,
    dist_300_500 NUMERIC(12, 6) DEFAULT 0,
    dist_500_1000 NUMERIC(12, 6) DEFAULT 0,
    dist_1000_plus NUMERIC(12, 6) DEFAULT 0,
    
    PRIMARY KEY (date, slot_id)
);
