CREATE TABLE public.player_stats (
    player_id int8 PRIMARY KEY,                   -- 玩家ID
    player_username varchar(50),                  -- 玩家名稱
    first_spin_date date,                         -- 玩家第一次spin日期
    total_bet_amount numeric(18, 4) DEFAULT 0,    -- 目前累積bet amount
    total_win_amount numeric(18, 4) DEFAULT 0,    -- 目前累積win amount
    last_spin_at timestamp                        -- 最後一次spin時間
);