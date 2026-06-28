-- iGaming Player Betting Behavior & Financial Curve Analysis Query
-- Database Target Table: public.slot_parent_bet
-- Key logic:
--   1. Time Partitioning per day (bet_at::date). Cumulative values and sequence indices reset daily.
--   2. Play Sequence Numbering (1-based chronological index).
--   3. Game Switching (is_game_changed is true when slot_id changes from previous spin).
--   4. Daily Cumulative Profit (daily_cum_profit = sum of net_profit per day, in IDR).

WITH partitioned_data AS (
    SELECT 
        player_id,
        bet_at,
        bet_at::date AS play_date,
        slot_id,
        has_free_game,
        bet_amount,
        total_prize,
        -- Calculate individual spin profit: net_profit = total_prize - bet_amount
        (total_prize - bet_amount) AS net_profit,
        -- Get the slot_id from the immediate previous spin of the same player on the same day
        LAG(slot_id) OVER(
            PARTITION BY player_id, bet_at::date 
            ORDER BY bet_at ASC
        ) AS prev_slot_id,
        -- Assign a 1-based sequential index chronologically per day for the player
        ROW_NUMBER() OVER(
            PARTITION BY player_id, bet_at::date 
            ORDER BY bet_at ASC
        ) AS play_seq
    FROM 
        public.slot_parent_bet
),
analyzed_data AS (
    SELECT
        player_id,
        bet_at,
        play_date,
        slot_id,
        has_free_game,
        bet_amount,
        total_prize,
        net_profit,
        play_seq,
        -- is_game_changed is true if current slot_id differs from immediate previous slot_id.
        -- For the first spin of the day (prev_slot_id is NULL), we treat it as false.
        CASE 
            WHEN prev_slot_id IS NULL THEN false
            WHEN prev_slot_id <> slot_id THEN true
            ELSE false
        END AS is_game_changed,
        -- Running Total of net_profit chronologically per player per day.
        -- We specify ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW to force physical row accumulation
        SUM(net_profit) OVER(
            PARTITION BY player_id, play_date 
            ORDER BY bet_at ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS daily_cum_profit
    FROM 
        partitioned_data
)
SELECT 
    player_id,
    bet_at,
    play_date,
    slot_id,
    has_free_game,
    -- Using CAST to numeric/varchar when formatting large IDR integers to prevent scientific notation in presentation layers
    CAST(bet_amount AS numeric(20, 0)) AS bet_amount,
    CAST(total_prize AS numeric(20, 0)) AS total_prize,
    CAST(net_profit AS numeric(20, 0)) AS net_profit,
    play_seq,
    is_game_changed,
    CAST(daily_cum_profit AS numeric(20, 0)) AS daily_cum_profit
FROM 
    analyzed_data
ORDER BY 
    player_id ASC, 
    play_date ASC, 
    play_seq ASC;
