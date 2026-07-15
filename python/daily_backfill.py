"""Daily aggregate-table completeness check and one-day backfill."""

import sys
import threading
import traceback
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

if __package__:
    from .infrastructure import get_db_connection, release_db_connection
else:
    from infrastructure import get_db_connection, release_db_connection


TIME_ZONE = ZoneInfo("Asia/Taipei")
RUN_AT = time(2, 0, 0)
TARGET_TABLES = (
    "player_daily",
    "casino_retention",
    "game_retention",
    "agent_daily_retention",
)
ADVISORY_LOCK_KEY = 2_000_002

_start_lock = threading.Lock()
_backfill_thread = None


def _log(message, *, error=False):
    timestamp = datetime.now(TIME_ZONE).isoformat(timespec="seconds")
    print(
        f"[{timestamp}] [daily backfill] {message}",
        file=sys.stderr if error else sys.stdout,
        flush=True,
    )


PLAYER_DAILY_SQL = """
INSERT INTO public.player_daily (
    date, player_id, slot_id,
    bet_1_spin_count, total_bet_1_amount, total_win_1_amount,
    free_game_count_1, bet_1_rtp, bet_1_odd_rtp,
    bet_2_spin_count, total_bet_2_amount, total_win_2_amount,
    free_game_count_2, bet_2_rtp, bet_2_odd_rtp,
    bet_3_spin_count, total_bet_3_amount, total_win_3_amount,
    bet_3_rtp, bet_3_odd_rtp
)
SELECT
    bet_at::date, player_id, slot_id,
    COUNT(*) FILTER (WHERE bet_type = 1),
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 1), 0),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 1), 0),
    COUNT(*) FILTER (WHERE bet_type = 1 AND has_free_game),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 1)
        / NULLIF(SUM(bet_amount) FILTER (WHERE bet_type = 1), 0), 0),
    COALESCE(AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 1), 0),
    COUNT(*) FILTER (WHERE bet_type = 2),
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 2), 0),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 2), 0),
    COUNT(*) FILTER (WHERE bet_type = 2 AND has_free_game),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 2)
        / NULLIF(SUM(bet_amount) FILTER (WHERE bet_type = 2), 0), 0),
    COALESCE(AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 2), 0),
    COUNT(*) FILTER (WHERE bet_type = 3),
    COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 3), 0),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 3), 0),
    COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 3)
        / NULLIF(SUM(bet_amount) FILTER (WHERE bet_type = 3), 0), 0),
    COALESCE(AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 3), 0)
FROM public.slot_parent_bet
WHERE bet_at >= %(target_date)s
  AND bet_at < %(target_date)s + 1
GROUP BY bet_at::date, player_id, slot_id;
"""


CASINO_RETENTION_SQL = """
INSERT INTO public.casino_retention (
    date, player_count, dnu, retention_1, retention_3, retention_7,
    total_spin_count, total_bet_amount, total_win_amount, rtp, odd_rtp,
    bet_1_player_count, bet_1_player_avg_bet_count, bet_1_spin_count,
    bet_1_total_bet_amount, bet_1_total_win_amount, bet_1_rtp, bet_1_odd_rtp,
    bet_2_player_count, bet_2_player_avg_bet_count, bet_2_spin_count,
    bet_2_total_bet_amount, bet_2_total_win_amount, bet_2_rtp, bet_2_odd_rtp,
    bet_3_player_count, bet_3_player_avg_bet_count, bet_3_spin_count,
    bet_3_total_bet_amount, bet_3_total_win_amount, bet_3_rtp, bet_3_odd_rtp
)
WITH first_dates AS (
    SELECT player_id, MIN(date) AS first_date
    FROM public.player_daily
    GROUP BY player_id
),
cohort AS (
    SELECT player_id FROM first_dates WHERE first_date = %(target_date)s
),
retention AS (
    SELECT
        COUNT(*)::INT8 AS dnu,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.player_daily p
            WHERE p.player_id = c.player_id AND p.date = %(target_date)s + 1
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_1,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.player_daily p
            WHERE p.player_id = c.player_id AND p.date = %(target_date)s + 3
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_3,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.player_daily p
            WHERE p.player_id = c.player_id AND p.date = %(target_date)s + 7
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_7
    FROM cohort c
),
f AS (
    SELECT
        date,
        COUNT(DISTINCT player_id)::INT8 AS players,
        SUM(bet_1_spin_count + bet_2_spin_count + bet_3_spin_count)::INT8 AS spins,
        SUM(total_bet_1_amount + total_bet_2_amount + total_bet_3_amount) AS bet,
        SUM(total_win_1_amount + total_win_2_amount + total_win_3_amount) AS win,
        (SUM(bet_1_spin_count * bet_1_odd_rtp)
         + SUM(bet_2_spin_count * bet_2_odd_rtp)
         + SUM(bet_3_spin_count * bet_3_odd_rtp))
            / NULLIF(SUM(bet_1_spin_count + bet_2_spin_count + bet_3_spin_count), 0) AS odd_rtp,
        COUNT(DISTINCT player_id) FILTER (WHERE bet_1_spin_count > 0)::INT8 AS b1_players,
        SUM(bet_1_spin_count)::INT8 AS b1_spins,
        SUM(total_bet_1_amount) AS b1_bet,
        SUM(total_win_1_amount) AS b1_win,
        SUM(bet_1_spin_count * bet_1_odd_rtp) / NULLIF(SUM(bet_1_spin_count), 0) AS b1_odd,
        COUNT(DISTINCT player_id) FILTER (WHERE bet_2_spin_count > 0)::INT8 AS b2_players,
        SUM(bet_2_spin_count)::INT8 AS b2_spins,
        SUM(total_bet_2_amount) AS b2_bet,
        SUM(total_win_2_amount) AS b2_win,
        SUM(bet_2_spin_count * bet_2_odd_rtp) / NULLIF(SUM(bet_2_spin_count), 0) AS b2_odd,
        COUNT(DISTINCT player_id) FILTER (WHERE bet_3_spin_count > 0)::INT8 AS b3_players,
        SUM(bet_3_spin_count)::INT8 AS b3_spins,
        SUM(total_bet_3_amount) AS b3_bet,
        SUM(total_win_3_amount) AS b3_win,
        SUM(bet_3_spin_count * bet_3_odd_rtp) / NULLIF(SUM(bet_3_spin_count), 0) AS b3_odd
    FROM public.player_daily
    WHERE date = %(target_date)s
    GROUP BY date
)
SELECT
    f.date, f.players, COALESCE(r.dnu, 0),
    COALESCE(r.retention_1, 0), COALESCE(r.retention_3, 0), COALESCE(r.retention_7, 0),
    f.spins, f.bet, f.win, COALESCE(f.win / NULLIF(f.bet, 0), 0), COALESCE(f.odd_rtp, 0),
    f.b1_players, COALESCE(f.b1_spins::NUMERIC / NULLIF(f.b1_players, 0), 0),
    f.b1_spins, f.b1_bet, f.b1_win, COALESCE(f.b1_win / NULLIF(f.b1_bet, 0), 0), COALESCE(f.b1_odd, 0),
    f.b2_players, COALESCE(f.b2_spins::NUMERIC / NULLIF(f.b2_players, 0), 0),
    f.b2_spins, f.b2_bet, f.b2_win, COALESCE(f.b2_win / NULLIF(f.b2_bet, 0), 0), COALESCE(f.b2_odd, 0),
    f.b3_players, COALESCE(f.b3_spins::NUMERIC / NULLIF(f.b3_players, 0), 0),
    f.b3_spins, f.b3_bet, f.b3_win, COALESCE(f.b3_win / NULLIF(f.b3_bet, 0), 0), COALESCE(f.b3_odd, 0)
FROM f CROSS JOIN retention r;
"""


GAME_RETENTION_SQL = """
INSERT INTO public.game_retention (
    date, slot_id, player_count, dnu, retention_1, retention_3, retention_7,
    total_spin_count, total_bet_amount, total_win_amount,
    bet_1_player_count, bet_1_player_avg_bet_count, bet_1_spin_count,
    bet_1_total_bet_amount, bet_1_total_win_amount, bet_1_avg_amount,
    bet_2_player_count, bet_2_player_avg_bet_count, bet_2_spin_count,
    bet_2_total_bet_amount, bet_2_total_win_amount, bet_2_avg_amount,
    bet_3_player_count, bet_3_player_avg_bet_count, bet_3_spin_count,
    bet_3_total_bet_amount, bet_3_total_win_amount, bet_3_avg_amount,
    dist_0_10, dist_10_20, dist_20_50, dist_50_100,
    dist_100_300, dist_300_500, dist_500_1000, dist_1000_plus
)
WITH first_dates AS (
    SELECT slot_id, player_id, MIN(date) AS first_date
    FROM public.player_daily
    GROUP BY slot_id, player_id
),
retention AS (
    SELECT
        c.slot_id,
        COUNT(*)::INT8 AS dnu,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.player_daily p
            WHERE p.slot_id = c.slot_id AND p.player_id = c.player_id
              AND p.date = %(target_date)s + 1
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_1,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.player_daily p
            WHERE p.slot_id = c.slot_id AND p.player_id = c.player_id
              AND p.date = %(target_date)s + 3
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_3,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.player_daily p
            WHERE p.slot_id = c.slot_id AND p.player_id = c.player_id
              AND p.date = %(target_date)s + 7
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_7
    FROM first_dates c
    WHERE c.first_date = %(target_date)s
    GROUP BY c.slot_id
),
f AS (
    SELECT
        date, slot_id, COUNT(DISTINCT player_id)::INT8 AS players,
        SUM(bet_1_spin_count + bet_2_spin_count + bet_3_spin_count)::INT8 AS spins,
        SUM(total_bet_1_amount + total_bet_2_amount + total_bet_3_amount) AS bet,
        SUM(total_win_1_amount + total_win_2_amount + total_win_3_amount) AS win,
        COUNT(*) FILTER (WHERE bet_1_spin_count > 0)::INT8 AS b1_players,
        SUM(bet_1_spin_count)::INT8 AS b1_spins,
        SUM(total_bet_1_amount) AS b1_bet, SUM(total_win_1_amount) AS b1_win,
        COUNT(*) FILTER (WHERE bet_2_spin_count > 0)::INT8 AS b2_players,
        SUM(bet_2_spin_count)::INT8 AS b2_spins,
        SUM(total_bet_2_amount) AS b2_bet, SUM(total_win_2_amount) AS b2_win,
        COUNT(*) FILTER (WHERE bet_3_spin_count > 0)::INT8 AS b3_players,
        SUM(bet_3_spin_count)::INT8 AS b3_spins,
        SUM(total_bet_3_amount) AS b3_bet, SUM(total_win_3_amount) AS b3_win,
        COUNT(*) FILTER (WHERE bet_1_spin_count > 0 AND bet_1_spin_count < 10)::NUMERIC AS d1,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 10 AND bet_1_spin_count < 20)::NUMERIC AS d2,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 20 AND bet_1_spin_count < 50)::NUMERIC AS d3,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 50 AND bet_1_spin_count < 100)::NUMERIC AS d4,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 100 AND bet_1_spin_count < 300)::NUMERIC AS d5,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 300 AND bet_1_spin_count < 500)::NUMERIC AS d6,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 500 AND bet_1_spin_count < 1000)::NUMERIC AS d7,
        COUNT(*) FILTER (WHERE bet_1_spin_count >= 1000)::NUMERIC AS d8
    FROM public.player_daily
    WHERE date = %(target_date)s
    GROUP BY date, slot_id
)
SELECT
    f.date, f.slot_id, f.players, COALESCE(r.dnu, 0),
    COALESCE(r.retention_1, 0), COALESCE(r.retention_3, 0), COALESCE(r.retention_7, 0),
    f.spins, f.bet, f.win,
    f.b1_players, COALESCE(f.b1_spins::NUMERIC / NULLIF(f.b1_players, 0), 0),
    f.b1_spins, f.b1_bet, f.b1_win, COALESCE(f.b1_bet / NULLIF(f.b1_spins, 0), 0),
    f.b2_players, COALESCE(f.b2_spins::NUMERIC / NULLIF(f.b2_players, 0), 0),
    f.b2_spins, f.b2_bet, f.b2_win, COALESCE(f.b2_bet / NULLIF(f.b2_spins, 0), 0),
    f.b3_players, COALESCE(f.b3_spins::NUMERIC / NULLIF(f.b3_players, 0), 0),
    f.b3_spins, f.b3_bet, f.b3_win, COALESCE(f.b3_bet / NULLIF(f.b3_spins, 0), 0),
    COALESCE(f.d1 / NULLIF(f.b1_players, 0), 0), COALESCE(f.d2 / NULLIF(f.b1_players, 0), 0),
    COALESCE(f.d3 / NULLIF(f.b1_players, 0), 0), COALESCE(f.d4 / NULLIF(f.b1_players, 0), 0),
    COALESCE(f.d5 / NULLIF(f.b1_players, 0), 0), COALESCE(f.d6 / NULLIF(f.b1_players, 0), 0),
    COALESCE(f.d7 / NULLIF(f.b1_players, 0), 0), COALESCE(f.d8 / NULLIF(f.b1_players, 0), 0)
FROM f LEFT JOIN retention r USING (slot_id);
"""


AGENT_RETENTION_SQL = """
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
WITH target_players AS (
    SELECT DISTINCT parent_agent_id, agent_id, player_id
    FROM public.slot_parent_bet
    WHERE bet_at >= %(target_date)s AND bet_at < %(target_date)s + 1
),
cohort AS (
    SELECT t.*
    FROM target_players t
    WHERE NOT EXISTS (
        SELECT 1 FROM public.slot_parent_bet p
        WHERE p.parent_agent_id = t.parent_agent_id
          AND p.agent_id = t.agent_id
          AND p.player_id = t.player_id
          AND p.bet_at < %(target_date)s
    )
),
retention AS (
    SELECT
        c.parent_agent_id, c.agent_id, COUNT(*)::INT8 AS dnu,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.slot_parent_bet p
            WHERE p.parent_agent_id = c.parent_agent_id AND p.agent_id = c.agent_id
              AND p.player_id = c.player_id
              AND p.bet_at >= %(target_date)s + 1 AND p.bet_at < %(target_date)s + 2
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_1,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.slot_parent_bet p
            WHERE p.parent_agent_id = c.parent_agent_id AND p.agent_id = c.agent_id
              AND p.player_id = c.player_id
              AND p.bet_at >= %(target_date)s + 3 AND p.bet_at < %(target_date)s + 4
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_3,
        COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.slot_parent_bet p
            WHERE p.parent_agent_id = c.parent_agent_id AND p.agent_id = c.agent_id
              AND p.player_id = c.player_id
              AND p.bet_at >= %(target_date)s + 7 AND p.bet_at < %(target_date)s + 8
        ))::NUMERIC / NULLIF(COUNT(*), 0) AS retention_7
    FROM cohort c
    GROUP BY c.parent_agent_id, c.agent_id
),
f AS (
    SELECT
        bet_at::date AS date, parent_agent_id, agent_id,
        COUNT(DISTINCT player_id)::INT8 AS players, COUNT(*)::INT8 AS spins,
        SUM(bet_amount) AS bet, SUM(total_prize) AS win,
        AVG(total_prize / NULLIF(bet_amount, 0)) AS odd_rtp,
        COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 1)::INT8 AS b1_players,
        COUNT(*) FILTER (WHERE bet_type = 1)::INT8 AS b1_spins,
        COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 1), 0) AS b1_bet,
        COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 1), 0) AS b1_win,
        AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 1) AS b1_odd,
        COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 2)::INT8 AS b2_players,
        COUNT(*) FILTER (WHERE bet_type = 2)::INT8 AS b2_spins,
        COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 2), 0) AS b2_bet,
        COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 2), 0) AS b2_win,
        AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 2) AS b2_odd,
        COUNT(DISTINCT player_id) FILTER (WHERE bet_type = 3)::INT8 AS b3_players,
        COUNT(*) FILTER (WHERE bet_type = 3)::INT8 AS b3_spins,
        COALESCE(SUM(bet_amount) FILTER (WHERE bet_type = 3), 0) AS b3_bet,
        COALESCE(SUM(total_prize) FILTER (WHERE bet_type = 3), 0) AS b3_win,
        AVG(total_prize / NULLIF(bet_amount, 0)) FILTER (WHERE bet_type = 3) AS b3_odd
    FROM public.slot_parent_bet
    WHERE bet_at >= %(target_date)s AND bet_at < %(target_date)s + 1
    GROUP BY bet_at::date, parent_agent_id, agent_id
)
SELECT
    f.date, f.parent_agent_id, f.agent_id, f.players, COALESCE(r.dnu, 0),
    COALESCE(r.retention_1, 0), COALESCE(r.retention_3, 0), COALESCE(r.retention_7, 0),
    f.spins, f.bet, f.win, COALESCE(f.win / NULLIF(f.bet, 0), 0), COALESCE(f.odd_rtp, 0),
    f.b1_players, COALESCE(f.b1_spins::NUMERIC / NULLIF(f.b1_players, 0), 0),
    f.b1_spins, f.b1_bet, f.b1_win, COALESCE(f.b1_win / NULLIF(f.b1_bet, 0), 0), COALESCE(f.b1_odd, 0),
    f.b2_players, COALESCE(f.b2_spins::NUMERIC / NULLIF(f.b2_players, 0), 0),
    f.b2_spins, f.b2_bet, f.b2_win, COALESCE(f.b2_win / NULLIF(f.b2_bet, 0), 0), COALESCE(f.b2_odd, 0),
    f.b3_players, COALESCE(f.b3_spins::NUMERIC / NULLIF(f.b3_players, 0), 0),
    f.b3_spins, f.b3_bet, f.b3_win, COALESCE(f.b3_win / NULLIF(f.b3_bet, 0), 0), COALESCE(f.b3_odd, 0)
FROM f LEFT JOIN retention r USING (parent_agent_id, agent_id);
"""


BACKFILL_SQL = {
    "player_daily": PLAYER_DAILY_SQL,
    "casino_retention": CASINO_RETENTION_SQL,
    "game_retention": GAME_RETENTION_SQL,
    "agent_daily_retention": AGENT_RETENTION_SQL,
}


def run_daily_backfill(target_date=None):
    """Check and atomically fill missing aggregate rows for one local date."""
    target_date = target_date or (datetime.now(TIME_ZONE).date() - timedelta(days=1))
    if isinstance(target_date, datetime):
        target_date = target_date.date()
    if not isinstance(target_date, date):
        raise TypeError("target_date must be a date")

    connection = get_db_connection()
    result = {"target_date": target_date.isoformat(), "tables": {}}
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = 0")
            cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", (ADVISORY_LOCK_KEY,))
            if not cursor.fetchone()[0]:
                connection.rollback()
                result["status"] = "locked"
                return result

            cursor.execute(
                """
                SELECT COUNT(*)
                FROM public.slot_parent_bet
                WHERE bet_at >= %s AND bet_at < %s + 1
                """,
                (target_date, target_date),
            )
            source_rows = cursor.fetchone()[0]
            result["source_rows"] = source_rows
            if not source_rows:
                connection.rollback()
                result["status"] = "source_missing"
                return result

            missing_tables = []
            for table_name in TARGET_TABLES:
                cursor.execute(
                    f"SELECT EXISTS (SELECT 1 FROM public.{table_name} WHERE date = %s)",
                    (target_date,),
                )
                if cursor.fetchone()[0]:
                    result["tables"][table_name] = {"status": "present", "rows": 0}
                else:
                    missing_tables.append(table_name)

            if not missing_tables:
                connection.rollback()
                result["status"] = "complete"
                return result

            params = {"target_date": target_date}
            for table_name in TARGET_TABLES:
                if table_name not in missing_tables:
                    continue
                cursor.execute(BACKFILL_SQL[table_name], params)
                inserted_rows = cursor.rowcount
                if inserted_rows <= 0:
                    raise RuntimeError(
                        f"Backfill produced no {table_name} rows for {target_date}"
                    )
                result["tables"][table_name] = {
                    "status": "backfilled",
                    "rows": inserted_rows,
                }

            connection.commit()
            result["status"] = "backfilled"
            return result
    except Exception:
        connection.rollback()
        raise
    finally:
        release_db_connection(connection)


def _find_pending_dates(through_date):
    """Find source dates that are absent from at least one aggregate table."""
    connection = get_db_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT source.date
                FROM (
                    SELECT DISTINCT bet_at::date AS date
                    FROM public.slot_parent_bet
                    WHERE bet_at IS NOT NULL AND bet_at::date <= %s
                ) AS source
                WHERE NOT EXISTS (
                          SELECT 1 FROM public.player_daily t WHERE t.date = source.date
                      )
                   OR NOT EXISTS (
                          SELECT 1 FROM public.casino_retention t WHERE t.date = source.date
                      )
                   OR NOT EXISTS (
                          SELECT 1 FROM public.game_retention t WHERE t.date = source.date
                      )
                   OR NOT EXISTS (
                          SELECT 1 FROM public.agent_daily_retention t WHERE t.date = source.date
                      )
                ORDER BY source.date
                """,
                (through_date,),
            )
            return [row[0] for row in cursor.fetchall()]
    finally:
        release_db_connection(connection)


def run_pending_backfills(through_date=None):
    """Backfill all known gaps through yesterday and always check yesterday."""
    through_date = through_date or (datetime.now(TIME_ZONE).date() - timedelta(days=1))
    if isinstance(through_date, datetime):
        through_date = through_date.date()
    if not isinstance(through_date, date):
        raise TypeError("through_date must be a date")
    pending_dates = _find_pending_dates(through_date)
    if through_date not in pending_dates:
        pending_dates.append(through_date)
    return [run_daily_backfill(target_date) for target_date in sorted(pending_dates)]


def _seconds_until_next_run(now=None):
    now = now or datetime.now(TIME_ZONE)
    next_run = datetime.combine(now.date(), RUN_AT, tzinfo=TIME_ZONE)
    if next_run <= now:
        next_run += timedelta(days=1)
    return (next_run - now).total_seconds(), next_run


def _run_scheduler():
    while True:
        wait_seconds, next_run = _seconds_until_next_run()
        _log(f"next check: {next_run.isoformat(timespec='seconds')}")
        threading.Event().wait(wait_seconds)
        target_date = datetime.now(TIME_ZONE).date() - timedelta(days=1)
        try:
            results = run_pending_backfills(target_date)
            _log(f"check results: {results}")
        except Exception as error:
            _log(f"check failed for {target_date}: {error}", error=True)
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()


def start_daily_backfill_scheduler():
    """Start one 02:00 Asia/Taipei scheduler per Python process."""
    global _backfill_thread
    with _start_lock:
        if _backfill_thread is not None and _backfill_thread.is_alive():
            return _backfill_thread
        _backfill_thread = threading.Thread(
            target=_run_scheduler,
            name="daily-aggregate-backfill",
            daemon=True,
        )
        _backfill_thread.start()
        return _backfill_thread
