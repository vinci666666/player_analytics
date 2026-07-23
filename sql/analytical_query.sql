-- 玩家投注行為與損益曲線分析查詢。 / Player wagering behavior and financial-curve query.
-- 目標資料表：public.slot_parent_bet。 / Target table: public.slot_parent_bet.
-- 核心邏輯 / Key logic:
--   1. 依 UTC+7 日期分區，每日重設序號與累積值。 / Partition by UTC+7 date; reset sequence and cumulative values daily.
--   2. 依時間建立從 1 起算的投注序號。 / Number wagers chronologically from 1.
--   3. slot_id 改變時標記遊戲切換。 / Mark a game switch when slot_id changes.
--   4. 每日累計 IDR 淨利。 / Calculate daily cumulative net profit in IDR.

WITH partitioned_data AS (
    SELECT 
        player_id,
        bet_at_utc7,
        bet_at_utc7::date AS play_date,
        slot_id,
        has_free_game,
        bet_amount,
        total_prize,
        -- 單次淨利＝派彩－投注。 / Per-spin net profit equals payout minus wager.
        (total_prize - bet_amount) AS net_profit,
        -- 取得同玩家同日上一筆 slot_id。 / Read the preceding slot_id for the same player and day.
        LAG(slot_id) OVER(
            PARTITION BY player_id, bet_at_utc7::date
            ORDER BY bet_at_utc7 ASC
        ) AS prev_slot_id,
        -- 為玩家每日投注建立時間序號。 / Assign a chronological daily sequence per player.
        ROW_NUMBER() OVER(
            PARTITION BY player_id, bet_at_utc7::date
            ORDER BY bet_at_utc7 ASC
        ) AS play_seq
    FROM 
        public.slot_parent_bet
),
analyzed_data AS (
    SELECT
        player_id,
        bet_at_utc7,
        play_date,
        slot_id,
        has_free_game,
        bet_amount,
        total_prize,
        net_profit,
        play_seq,
        -- 前後 slot_id 不同即為切換；每日第一筆不算切換。
        -- A differing slot_id marks a switch; the first spin of each day does not.
        CASE 
            WHEN prev_slot_id IS NULL THEN false
            WHEN prev_slot_id <> slot_id THEN true
            ELSE false
        END AS is_game_changed,
        -- 依玩家每日時間順序累加淨利；ROWS frame 確保逐筆累積。
        -- Accumulate net profit per player/day; the ROWS frame enforces physical-row accumulation.
        SUM(net_profit) OVER(
            PARTITION BY player_id, play_date 
            ORDER BY bet_at_utc7 ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS daily_cum_profit
    FROM 
        partitioned_data
)
SELECT 
    player_id,
    bet_at_utc7,
    play_date,
    slot_id,
    has_free_game,
    -- 大額 IDR 先 CAST，避免呈現層顯示科學記號。 / CAST large IDR values to prevent scientific notation.
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
