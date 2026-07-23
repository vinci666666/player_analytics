-- 產生全站每日 KPI 與 D1/D3/D7 留存。 / Build daily casino KPIs and D1/D3/D7 retention.
-- 檔名保留既有 inster 拼字以避免破壞外部腳本引用。 / The historical inster filename is retained for compatibility.

INSERT INTO casino_retention (
    date, player_count, DNU, retention_1, retention_3, retention_7,
    total_spin_count, total_bet_amount, total_win_amount, rtp, odd_rtp,
    bet_1_player_count, bet_1_player_avg_bet_count, bet_1_spin_count, bet_1_total_bet_amount, bet_1_total_win_amount, bet_1_rtp, bet_1_odd_rtp,
    bet_2_player_count, bet_2_player_avg_bet_count, bet_2_spin_count, bet_2_total_bet_amount, bet_2_total_win_amount, bet_2_rtp, bet_2_odd_rtp,
    bet_3_player_count, bet_3_player_avg_bet_count, bet_3_spin_count, bet_3_total_bet_amount, bet_3_total_win_amount, bet_3_rtp, bet_3_odd_rtp
)
WITH player_first_dates AS (
    -- 找出每位玩家首日，作為 DNU 來源。 / Find each player's first day as the DNU source.
    SELECT player_id, MIN(date) as first_date
    FROM player_daily
    GROUP BY player_id
),
daily_active_players AS (
    -- 每日不重複活躍玩家，不分遊戲。 / Daily distinct active players across games.
    SELECT DISTINCT date, player_id
    FROM player_daily
),
retention_stats AS (
    -- 計算 DNU cohort 及其留存。 / Calculate DNU cohorts and their retention.
    SELECT 
        pfd.first_date AS date,
        COUNT(DISTINCT pfd.player_id) AS dnu_count,
        COUNT(DISTINCT r1.player_id) AS ret1_cnt,
        COUNT(DISTINCT r3.player_id) AS ret3_cnt,
        COUNT(DISTINCT r7.player_id) AS ret7_cnt
    FROM player_first_dates pfd
    LEFT JOIN daily_active_players r1 ON pfd.player_id = r1.player_id AND r1.date = pfd.first_date + INTERVAL '1 day'
    LEFT JOIN daily_active_players r3 ON pfd.player_id = r3.player_id AND r3.date = pfd.first_date + INTERVAL '3 day'
    LEFT JOIN daily_active_players r7 ON pfd.player_id = r7.player_id AND r7.date = pfd.first_date + INTERVAL '7 day'
    GROUP BY pfd.first_date
),
daily_financial_agg AS (
    -- 從 player_daily 彙總每日整體與分類指標。 / Aggregate overall and wager-type metrics from player_daily.
    SELECT 
        date,
        COUNT(DISTINCT player_id) AS active_player_count,
        -- 整體指標。 / Overall metrics.
        SUM(bet_1_spin_count + bet_2_spin_count + bet_3_spin_count) AS t_spin,
        SUM(total_bet_1_amount + total_bet_2_amount + total_bet_3_amount) AS t_bet,
        SUM(total_win_1_amount + total_win_2_amount + total_win_3_amount) AS t_win,
        -- 使用 NULLIF 防止除以零，三類 odd RTP 取算術平均。 / NULLIF prevents division by zero; average odd RTP across three types.

    (sum(bet_1_spin_count*bet_1_odd_rtp  )+sum(bet_2_spin_count*bet_2_odd_rtp  )+sum(bet_3_spin_count*bet_3_odd_rtp  ))/(sum(bet_1_spin_count)+sum(bet_2_spin_count)+sum(bet_3_spin_count))
 AS t_odd_rtp,


        -- 一般投注。 / Normal wager (Bet Type 1).
        COUNT(DISTINCT player_id) FILTER (WHERE bet_1_spin_count > 0) AS b1_p_cnt,
        SUM(bet_1_spin_count) AS b1_spin,
        SUM(total_bet_1_amount) AS b1_bet,
        SUM(total_win_1_amount) AS b1_win,
        sum(bet_1_spin_count*bet_1_odd_rtp)/sum(bet_1_spin_count) FILTER (WHERE bet_1_spin_count > 0) AS b1_odd_rtp,

        -- 加注投注。 / Ante wager (Bet Type 2).
        COUNT(DISTINCT player_id) FILTER (WHERE bet_2_spin_count > 0) AS b2_p_cnt,
        SUM(bet_2_spin_count) AS b2_spin,
        SUM(total_bet_2_amount) AS b2_bet,
        SUM(total_win_2_amount) AS b2_win,
        sum(bet_2_spin_count*bet_2_odd_rtp)/sum(bet_2_spin_count) AS b2_odd_rtp,

        -- 購買功能。 / Buy Feature wager (Bet Type 3).
        COUNT(DISTINCT player_id) FILTER (WHERE bet_3_spin_count > 0) AS b3_p_cnt,
        SUM(bet_3_spin_count) AS b3_spin,
        SUM(total_bet_3_amount) AS b3_bet,
        SUM(total_win_3_amount) AS b3_win,
        sum(bet_3_spin_count*bet_3_odd_rtp)/sum(bet_3_spin_count) FILTER (WHERE bet_3_spin_count > 0) AS b3_odd_rtp

    FROM player_daily
    GROUP BY date
)
SELECT 
    f.date,
    f.active_player_count,
    COALESCE(r.dnu_count, 0),
    COALESCE(r.ret1_cnt::NUMERIC / NULLIF(r.dnu_count, 0), 0),
    COALESCE(r.ret3_cnt::NUMERIC / NULLIF(r.dnu_count, 0), 0),
    COALESCE(r.ret7_cnt::NUMERIC / NULLIF(r.dnu_count, 0), 0),
    
    f.t_spin, f.t_bet, f.t_win,
    COALESCE(f.t_win / NULLIF(f.t_bet, 0), 0) AS rtp,
    COALESCE(f.t_odd_rtp, 0) AS odd_rtp,

    -- 一般投注衍生比率。 / Normal-wager derived ratios.
    f.b1_p_cnt,
    COALESCE(f.b1_spin::NUMERIC / NULLIF(f.b1_p_cnt, 0), 0),
    f.b1_spin, f.b1_bet, f.b1_win,
    COALESCE(f.b1_win / NULLIF(f.b1_bet, 0), 0), -- bet_1_rtp
    COALESCE(f.b1_odd_rtp, 0),

    -- 加注投注衍生比率。 / Ante-wager derived ratios.
    f.b2_p_cnt,
    COALESCE(f.b2_spin::NUMERIC / NULLIF(f.b2_p_cnt, 0), 0),
    f.b2_spin, f.b2_bet, f.b2_win,
    COALESCE(f.b2_win / NULLIF(f.b2_bet, 0), 0), -- bet_2_rtp
    COALESCE(f.b2_odd_rtp, 0),

    -- 購買功能衍生比率。 / Buy-Feature derived ratios.
    f.b3_p_cnt,
    COALESCE(f.b3_spin::NUMERIC / NULLIF(f.b3_p_cnt, 0), 0),
    f.b3_spin, f.b3_bet, f.b3_win,
    COALESCE(f.b3_win / NULLIF(f.b3_bet, 0), 0), -- bet_3_rtp
    COALESCE(f.b3_odd_rtp, 0)

FROM daily_financial_agg f
LEFT JOIN retention_stats r ON f.date = r.date;
