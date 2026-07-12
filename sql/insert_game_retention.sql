INSERT INTO game_retention (
    date, slot_id, player_count, DNU, retention_1, retention_3, retention_7,
    total_spin_count, total_bet_amount, total_win_amount,
    bet_1_player_count, bet_1_player_avg_bet_count, bet_1_spin_count, bet_1_total_bet_amount, bet_1_total_win_amount, bet_1_avg_amount,
    bet_2_player_count, bet_2_player_avg_bet_count, bet_2_spin_count, bet_2_total_bet_amount, bet_2_total_win_amount, bet_2_avg_amount,
    bet_3_player_count, bet_3_player_avg_bet_count, bet_3_spin_count, bet_3_total_bet_amount, bet_3_total_win_amount, bet_3_avg_amount,
    dist_0_10, dist_10_20, dist_20_50, dist_50_100, dist_100_300, dist_300_500, dist_500_1000, dist_1000_plus
)
WITH game_first_dates AS (
    -- 1. 找出每位玩家在「各款遊戲」的初次遊玩日 (界定該遊戲的 DNU)
    SELECT slot_id, player_id, MIN(date) AS first_date
    FROM player_daily
    GROUP BY slot_id, player_id
),
retention_stats AS (
    -- 2. 針對 DNU 計算留存人數
    SELECT 
        gfd.first_date AS date,
        gfd.slot_id,
        COUNT(DISTINCT gfd.player_id) AS dnu_count,
        COUNT(DISTINCT r1.player_id) AS ret1_cnt,
        COUNT(DISTINCT r3.player_id) AS ret3_cnt,
        COUNT(DISTINCT r7.player_id) AS ret7_cnt
    FROM game_first_dates gfd
    LEFT JOIN player_daily r1 ON gfd.player_id = r1.player_id AND gfd.slot_id = r1.slot_id AND r1.date = gfd.first_date + INTERVAL '1 day'
    LEFT JOIN player_daily r3 ON gfd.player_id = r3.player_id AND gfd.slot_id = r3.slot_id AND r3.date = gfd.first_date + INTERVAL '3 day'
    LEFT JOIN player_daily r7 ON gfd.player_id = r7.player_id AND gfd.slot_id = r7.slot_id AND r7.date = gfd.first_date + INTERVAL '7 day'
    GROUP BY gfd.first_date, gfd.slot_id
),
financial_and_dist_agg AS (
    -- 3. 計算每日總體、分類財務數據與區間人數
    SELECT 
        date,
        slot_id,
        COUNT(DISTINCT player_id) AS d_player_count,
        
        -- 整體財務
        COALESCE(SUM(bet_1_spin_count + bet_2_spin_count + bet_3_spin_count), 0) AS t_spin,
        COALESCE(SUM(total_bet_1_amount + total_bet_2_amount + total_bet_3_amount), 0) AS t_bet,
        COALESCE(SUM(total_win_1_amount + total_win_2_amount + total_win_3_amount), 0) AS t_win,

        -- bet_type 1 詳情
        COUNT(*) FILTER (WHERE bet_1_spin_count > 0) AS b1_p_cnt,
        COALESCE(SUM(bet_1_spin_count), 0) AS b1_spin,
        COALESCE(SUM(total_bet_1_amount), 0) AS b1_bet,
        COALESCE(SUM(total_win_1_amount), 0) AS b1_win,

        -- bet_type 2 詳情
        COUNT(*) FILTER (WHERE bet_2_spin_count > 0) AS b2_p_cnt,
        COALESCE(SUM(bet_2_spin_count), 0) AS b2_spin,
        COALESCE(SUM(total_bet_2_amount), 0) AS b2_bet,
        COALESCE(SUM(total_win_2_amount), 0) AS b2_win,

        -- bet_type 3 詳情
        COUNT(*) FILTER (WHERE bet_3_spin_count > 0) AS b3_p_cnt,
        COALESCE(SUM(bet_3_spin_count), 0) AS b3_spin,
        COALESCE(SUM(total_bet_3_amount), 0) AS b3_bet,
        COALESCE(SUM(total_win_3_amount), 0) AS b3_win,

        -- bet_type 1 遊玩次數區間人數 (排除 0 次)
        COUNT(*) FILTER (WHERE bet_1_spin_count > 0 AND bet_1_spin_count < 10) AS d1,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 10 AND bet_1_spin_count < 20) AS d2,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 20 AND bet_1_spin_count < 50) AS d3,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 50 AND bet_1_spin_count < 100) AS d4,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 100 AND bet_1_spin_count < 300) AS d5,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 300 AND bet_1_spin_count < 500) AS d6,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 500 AND bet_1_spin_count < 1000) AS d7,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 1000) AS d8

    FROM player_daily
    GROUP BY date, slot_id
)
-- 4. 結合留存與財務，計算各項佔比與均值
SELECT 
    f.date, 
    f.slot_id, 
    f.d_player_count,
    COALESCE(r.dnu_count, 0) AS DNU,
    
    -- 留存率 (基於 DNU 計算)
    COALESCE(r.ret1_cnt::NUMERIC / NULLIF(r.dnu_count, 0), 0) AS retention_1,
    COALESCE(r.ret3_cnt::NUMERIC / NULLIF(r.dnu_count, 0), 0) AS retention_3,
    COALESCE(r.ret7_cnt::NUMERIC / NULLIF(r.dnu_count, 0), 0) AS retention_7,
    
    f.t_spin, f.t_bet, f.t_win,
    
    -- bet_type 1
    f.b1_p_cnt, 
    COALESCE(f.b1_spin::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0), 
    f.b1_spin, f.b1_bet, f.b1_win, 
    COALESCE(f.b1_bet / NULLIF(f.b1_spin, 0), 0),
    
    -- bet_type 2
    f.b2_p_cnt, 
    COALESCE(f.b2_spin::NUMERIC / NULLIF(f.b2_p_cnt, 0), 0), 
    f.b2_spin, f.b2_bet, f.b2_win, 
    COALESCE(f.b2_bet / NULLIF(f.b2_spin, 0), 0),
    
    -- bet_type 3
    f.b3_p_cnt, 
    COALESCE(f.b3_spin::NUMERIC / NULLIF(f.b3_p_cnt, 0), 0), 
    f.b3_spin, f.b3_bet, f.b3_win, 
    COALESCE(f.b3_bet / NULLIF(f.b3_spin, 0), 0),
    
    -- bet_type 1 次數分佈佔比 (分母為 bet_1_player_count)
    COALESCE(f.d1::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0),
    COALESCE(f.d2::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0),
    COALESCE(f.d3::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0),
    COALESCE(f.d4::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0),
    COALESCE(f.d5::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0),
    COALESCE(f.d6::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0),
    COALESCE(f.d7::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0),
    COALESCE(f.d8::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0)

FROM financial_and_dist_agg f
LEFT JOIN retention_stats r ON f.date = r.date AND f.slot_id = r.slot_id;