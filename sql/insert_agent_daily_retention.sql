-- Rebuild agent_daily_retention from slot_parent_bet.
-- Calculation follows the existing retention scripts, partitioned by
-- parent_agent_id and agent_id.
BEGIN;

SET LOCAL statement_timeout = 0;

CREATE TEMP TABLE _agent_player_daily ON COMMIT DROP AS
SELECT
    bet_at::date AS date,
    parent_agent_id,
    agent_id,
    player_id,
    COUNT(*)::INT8 AS spin_count,
    COALESCE(SUM(bet_amount), 0) AS bet_amount,
    COALESCE(SUM(total_prize), 0) AS win_amount,
    COALESCE(SUM(total_prize / NULLIF(bet_amount, 0)), 0) AS odd_ratio_sum,
    COUNT(*) FILTER (WHERE bet_amount <> 0)::INT8 AS odd_ratio_count,
    COUNT(*) FILTER (WHERE bet_type = 1)::INT8 AS b1_spin,
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 1), 0) AS b1_bet,
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 1), 0) AS b1_win,
    COALESCE(SUM(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 1), 0) AS b1_odd_sum,
    COUNT(*) FILTER (WHERE bet_type = 1 AND bet_amount <> 0)::INT8 AS b1_odd_count,
    COUNT(*) FILTER (WHERE bet_type = 2)::INT8 AS b2_spin,
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 2), 0) AS b2_bet,
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 2), 0) AS b2_win,
    COALESCE(SUM(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 2), 0) AS b2_odd_sum,
    COUNT(*) FILTER (WHERE bet_type = 2 AND bet_amount <> 0)::INT8 AS b2_odd_count,
    COUNT(*) FILTER (WHERE bet_type = 3)::INT8 AS b3_spin,
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 3), 0) AS b3_bet,
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 3), 0) AS b3_win,
    COALESCE(SUM(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 3), 0) AS b3_odd_sum,
    COUNT(*) FILTER (WHERE bet_type = 3 AND bet_amount <> 0)::INT8 AS b3_odd_count
FROM public.slot_parent_bet
WHERE bet_at IS NOT NULL
  AND parent_agent_id IS NOT NULL
  AND agent_id IS NOT NULL
  AND player_id IS NOT NULL
GROUP BY bet_at::date, parent_agent_id, agent_id, player_id;

CREATE UNIQUE INDEX ON _agent_player_daily
    (parent_agent_id, agent_id, player_id, date);
ANALYZE _agent_player_daily;

TRUNCATE TABLE public.agent_daily_retention;

INSERT INTO public.agent_daily_retention (
    date, parent_agent_id, agent_id,
    player_count, dnu, retention_1, retention_3, retention_7,
    total_spin_count, total_bet_amount, total_win_amount, rtp, odd_rtp,
    bet_1_player_count, bet_1_player_avg_bet_count, bet_1_spin_count,
    bet_1_total_bet_amount, bet_1_total_win_amount, bet_1_rtp, bet_1_odd_rtp,
    bet_2_player_count, bet_2_player_avg_bet_count, bet_2_spin_count,
    bet_2_total_bet_amount, bet_2_total_win_amount, bet_2_rtp, bet_2_odd_rtp,
    bet_3_player_count, bet_3_player_avg_bet_count, bet_3_spin_count,
    bet_3_total_bet_amount, bet_3_total_win_amount, bet_3_rtp, bet_3_odd_rtp
)
WITH first_dates AS (
    SELECT parent_agent_id, agent_id, player_id, MIN(date) AS first_date
    FROM _agent_player_daily
    GROUP BY parent_agent_id, agent_id, player_id
),
retention_stats AS (
    SELECT
        f.first_date AS date,
        f.parent_agent_id,
        f.agent_id,
        COUNT(*)::INT8 AS dnu_count,
        COUNT(r1.player_id)::NUMERIC / NULLIF(COUNT(*), 0) AS retention_1,
        COUNT(r3.player_id)::NUMERIC / NULLIF(COUNT(*), 0) AS retention_3,
        COUNT(r7.player_id)::NUMERIC / NULLIF(COUNT(*), 0) AS retention_7
    FROM first_dates f
    LEFT JOIN _agent_player_daily r1
      ON r1.parent_agent_id = f.parent_agent_id
     AND r1.agent_id = f.agent_id
     AND r1.player_id = f.player_id
     AND r1.date = f.first_date + 1
    LEFT JOIN _agent_player_daily r3
      ON r3.parent_agent_id = f.parent_agent_id
     AND r3.agent_id = f.agent_id
     AND r3.player_id = f.player_id
     AND r3.date = f.first_date + 3
    LEFT JOIN _agent_player_daily r7
      ON r7.parent_agent_id = f.parent_agent_id
     AND r7.agent_id = f.agent_id
     AND r7.player_id = f.player_id
     AND r7.date = f.first_date + 7
    GROUP BY f.first_date, f.parent_agent_id, f.agent_id
),
daily_financial_agg AS (
    SELECT
        date,
        parent_agent_id,
        agent_id,
        COUNT(*)::INT8 AS player_count,
        SUM(spin_count)::INT8 AS total_spin_count,
        SUM(bet_amount) AS total_bet_amount,
        SUM(win_amount) AS total_win_amount,
        SUM(odd_ratio_sum) / NULLIF(SUM(odd_ratio_count), 0) AS odd_rtp,
        COUNT(*) FILTER (WHERE b1_spin > 0)::INT8 AS b1_players,
        SUM(b1_spin)::INT8 AS b1_spin,
        SUM(b1_bet) AS b1_bet,
        SUM(b1_win) AS b1_win,
        SUM(b1_odd_sum) / NULLIF(SUM(b1_odd_count), 0) AS b1_odd_rtp,
        COUNT(*) FILTER (WHERE b2_spin > 0)::INT8 AS b2_players,
        SUM(b2_spin)::INT8 AS b2_spin,
        SUM(b2_bet) AS b2_bet,
        SUM(b2_win) AS b2_win,
        SUM(b2_odd_sum) / NULLIF(SUM(b2_odd_count), 0) AS b2_odd_rtp,
        COUNT(*) FILTER (WHERE b3_spin > 0)::INT8 AS b3_players,
        SUM(b3_spin)::INT8 AS b3_spin,
        SUM(b3_bet) AS b3_bet,
        SUM(b3_win) AS b3_win,
        SUM(b3_odd_sum) / NULLIF(SUM(b3_odd_count), 0) AS b3_odd_rtp
    FROM _agent_player_daily
    GROUP BY date, parent_agent_id, agent_id
)
SELECT
    f.date,
    f.parent_agent_id,
    f.agent_id,
    f.player_count,
    COALESCE(r.dnu_count, 0),
    COALESCE(r.retention_1, 0),
    COALESCE(r.retention_3, 0),
    COALESCE(r.retention_7, 0),
    f.total_spin_count,
    f.total_bet_amount,
    f.total_win_amount,
    COALESCE(f.total_win_amount / NULLIF(f.total_bet_amount, 0), 0),
    COALESCE(f.odd_rtp, 0),
    f.b1_players,
    COALESCE(f.b1_spin::NUMERIC / NULLIF(f.b1_players, 0), 0),
    f.b1_spin,
    f.b1_bet,
    f.b1_win,
    COALESCE(f.b1_win / NULLIF(f.b1_bet, 0), 0),
    COALESCE(f.b1_odd_rtp, 0),
    f.b2_players,
    COALESCE(f.b2_spin::NUMERIC / NULLIF(f.b2_players, 0), 0),
    f.b2_spin,
    f.b2_bet,
    f.b2_win,
    COALESCE(f.b2_win / NULLIF(f.b2_bet, 0), 0),
    COALESCE(f.b2_odd_rtp, 0),
    f.b3_players,
    COALESCE(f.b3_spin::NUMERIC / NULLIF(f.b3_players, 0), 0),
    f.b3_spin,
    f.b3_bet,
    f.b3_win,
    COALESCE(f.b3_win / NULLIF(f.b3_bet, 0), 0),
    COALESCE(f.b3_odd_rtp, 0)
FROM daily_financial_agg f
LEFT JOIN retention_stats r
  USING (date, parent_agent_id, agent_id);

ANALYZE public.agent_daily_retention;

COMMIT;
