WITH source_aggregated AS (
    SELECT 
        s.player_id,
        MAX(s.player_username) AS player_username,
        MIN(s.bet_at)::date AS first_spin_date,
        SUM(s.bet_amount) AS new_bet_amount,
        SUM(s.total_prize) AS new_win_amount,
        MAX(s.bet_at) AS last_spin_at
    FROM public.slot_parent_bet s
    LEFT JOIN public.player_stats p ON s.player_id = p.player_id
    WHERE p.last_spin_at IS NULL          -- 情況 A：玩家不存在，撈取該玩家全量歷史資料
       OR s.bet_at > p.last_spin_at       -- 情況 B：玩家已存在，僅撈取最後一次spin時間之後的全新資料
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
    new_bet_amount, 
    new_win_amount, 
    last_spin_at
FROM source_aggregated

-- 💡 核心：當 player_id 衝突時（代表玩家已存在），執行累加與覆蓋更新
ON CONFLICT (player_id) 
DO UPDATE SET 
    player_username = EXCLUDED.player_username, -- 更新可能變更的名稱
    total_bet_amount = player_stats.total_bet_amount + EXCLUDED.total_bet_amount, -- 累加全新的 bet_amount
    total_win_amount = player_stats.total_win_amount + EXCLUDED.total_bet_amount, -- 累加全新的 win_amount (對應原表的 total_prize)
    last_spin_at = EXCLUDED.last_spin_at; -- 更新最後一次 spin 時間