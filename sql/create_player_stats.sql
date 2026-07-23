-- 建立玩家生命週期快速摘要，避免每次掃描原始投注。 / Create lifetime player summaries to avoid repeated raw-wager scans.

CREATE TABLE public.player_stats (
    player_id int8 PRIMARY KEY,                   -- 玩家 ID。 / Player ID.
    player_username varchar(50),                  -- 玩家名稱。 / Player name.
    first_spin_date date,                         -- 首次 Spin 日期。 / First spin date.
    total_bet_amount numeric(18, 4) DEFAULT 0,    -- 累積投注額。 / Lifetime wager amount.
    total_win_amount numeric(18, 4) DEFAULT 0,    -- 累積派彩額。 / Lifetime payout amount.
    last_spin_at timestamp                        -- 最後 Spin 時間。 / Latest spin timestamp.
);
