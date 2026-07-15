"""Periodic incremental synchronization for public.slot_parent_bet."""

import sys
import threading
import time
import traceback
from datetime import datetime, timedelta

import psycopg2
from psycopg2 import sql
from psycopg2.extras import Json, execute_values

if __package__:
    from .infrastructure import load_config
else:
    from infrastructure import load_config


DEFAULT_SYNC_INTERVAL_SECONDS = 5 * 60
DEFAULT_SYNC_BATCH_SIZE = 10_000
TABLE_SCHEMA = "public"
TABLE_NAME = "slot_parent_bet"

_start_lock = threading.Lock()
_sync_thread = None


def _log(message, *, error=False):
    timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
    print(
        f"[{timestamp}] [slot_parent_bet sync] {message}",
        file=sys.stderr if error else sys.stdout,
        flush=True,
    )


def _connect(database_config):
    connection_config = database_config.copy()
    connection_config.setdefault("connect_timeout", 5)
    return psycopg2.connect(**connection_config)


def _positive_integer(value, setting_name):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{setting_name} must be a positive integer")
    return value


def _load_sync_settings():
    sync_config = load_config().get("slotParentBetSync", {})
    if not isinstance(sync_config, dict):
        raise ValueError("config.json slotParentBetSync must contain a JSON object")
    interval_seconds = _positive_integer(
        sync_config.get("interval_seconds", DEFAULT_SYNC_INTERVAL_SECONDS),
        "slotParentBetSync.interval_seconds",
    )
    batch_size = _positive_integer(
        sync_config.get("batch_size", DEFAULT_SYNC_BATCH_SIZE),
        "slotParentBetSync.batch_size",
    )
    return interval_seconds, batch_size


def _common_columns(source_cursor, local_cursor):
    source_cursor.execute(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = %s
          AND table_name = %s
          AND is_generated = 'NEVER'
        ORDER BY ordinal_position
        """,
        (TABLE_SCHEMA, TABLE_NAME),
    )
    source_columns = [row[0] for row in source_cursor.fetchall()]

    local_cursor.execute(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = %s
          AND table_name = %s
          AND is_generated = 'NEVER'
        ORDER BY ordinal_position
        """,
        (TABLE_SCHEMA, TABLE_NAME),
    )
    local_column_types = {row[0]: row[1] for row in local_cursor.fetchall()}
    local_columns = set(local_column_types)
    common_columns = [column for column in source_columns if column in local_columns]

    if not common_columns:
        raise RuntimeError("sourceDB and localDB slot_parent_bet have no common columns")
    if "bet_at" not in common_columns:
        raise RuntimeError("slot_parent_bet.bet_at is required in both databases")

    source_cursor.execute(
        """
        SELECT kcu.column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.constraint_schema = tc.constraint_schema
         AND kcu.table_name = tc.table_name
        WHERE tc.table_schema = %s
          AND tc.table_name = %s
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position
        """,
        (TABLE_SCHEMA, TABLE_NAME),
    )
    primary_key_columns = [
        row[0] for row in source_cursor.fetchall() if row[0] in common_columns
    ]
    cursor_columns = ["bet_at"] + [
        column for column in primary_key_columns if column != "bet_at"
    ]
    json_columns = {
        column
        for column in common_columns
        if local_column_types[column] in {"json", "jsonb"}
    }
    return common_columns, cursor_columns, json_columns


def _read_local_cursor(local_cursor, cursor_columns):
    selected_columns = sql.SQL(", ").join(map(sql.Identifier, cursor_columns))
    order_columns = sql.SQL(", ").join(
        sql.SQL("{} DESC NULLS LAST").format(sql.Identifier(column))
        for column in cursor_columns
    )
    local_cursor.execute(
        sql.SQL("SELECT {} FROM {}.{} ORDER BY {} LIMIT 1").format(
            selected_columns,
            sql.Identifier(TABLE_SCHEMA),
            sql.Identifier(TABLE_NAME),
            order_columns,
        )
    )
    return local_cursor.fetchone()


def _refresh_player_stats(local_cursor, player_ids):
    """Rebuild exact player_stats totals for players touched by a sync batch."""
    unique_player_ids = sorted(set(player_ids))
    if not unique_player_ids:
        return 0
    local_cursor.execute(
        """
        WITH source_aggregated AS (
            SELECT
                player_id,
                MAX(player_username) AS player_username,
                MIN(bet_at)::date AS first_spin_date,
                COALESCE(SUM(bet_amount), 0) AS total_bet_amount,
                COALESCE(SUM(total_prize), 0) AS total_win_amount,
                MAX(bet_at) AS last_spin_at
            FROM public.slot_parent_bet
            WHERE player_id = ANY(%s)
            GROUP BY player_id
        )
        INSERT INTO public.player_stats (
            player_id, player_username, first_spin_date,
            total_bet_amount, total_win_amount, last_spin_at
        )
        SELECT
            player_id, player_username, first_spin_date,
            total_bet_amount, total_win_amount, last_spin_at
        FROM source_aggregated
        ON CONFLICT (player_id) DO UPDATE SET
            player_username = EXCLUDED.player_username,
            first_spin_date = EXCLUDED.first_spin_date,
            total_bet_amount = EXCLUDED.total_bet_amount,
            total_win_amount = EXCLUDED.total_win_amount,
            last_spin_at = EXCLUDED.last_spin_at
        """,
        (unique_player_ids,),
    )
    return local_cursor.rowcount


def sync_one_batch(batch_size):
    """Copy at most one incremental batch and return the inserted row count."""
    config = load_config()
    source_config = config.get("sourceDB")
    local_config = config.get("localDB")
    if not isinstance(source_config, dict):
        raise RuntimeError("config.json sourceDB must contain a JSON object")
    if not isinstance(local_config, dict):
        raise RuntimeError("config.json localDB must contain a JSON object")

    source_connection = None
    local_connection = None
    try:
        source_connection = _connect(source_config)
        local_connection = _connect(local_config)
        source_connection.autocommit = False
        local_connection.autocommit = False

        with source_connection.cursor() as source_cursor, local_connection.cursor() as local_cursor:
            columns, cursor_columns, json_columns = _common_columns(
                source_cursor, local_cursor
            )
            local_cursor_values = _read_local_cursor(local_cursor, cursor_columns)

            selected_columns = sql.SQL(", ").join(map(sql.Identifier, columns))
            source_query = sql.SQL("SELECT {} FROM {}.{}").format(
                selected_columns,
                sql.Identifier(TABLE_SCHEMA),
                sql.Identifier(TABLE_NAME),
            )
            params = []
            source_query += sql.SQL(" WHERE bet_at IS NOT NULL")
            fallback_offset = None
            if local_cursor_values is not None and local_cursor_values[0] is not None:
                if len(cursor_columns) == 1:
                    local_cursor.execute(
                        sql.SQL("SELECT COUNT(*) FROM {}.{} WHERE bet_at = %s").format(
                            sql.Identifier(TABLE_SCHEMA), sql.Identifier(TABLE_NAME)
                        ),
                        (local_cursor_values[0],),
                    )
                    fallback_offset = local_cursor.fetchone()[0]
                    source_query += sql.SQL(" AND bet_at >= %s")
                    params.append(local_cursor_values[0])
                else:
                    compared_columns = sql.SQL(", ").join(map(sql.Identifier, cursor_columns))
                    placeholders = sql.SQL(", ").join(sql.Placeholder() for _ in cursor_columns)
                    source_query += sql.SQL(" AND ({}) > ({})").format(
                        compared_columns, placeholders
                    )
                    params.extend(local_cursor_values)

            if len(cursor_columns) == 1:
                source_query += sql.SQL(" ORDER BY bet_at ASC, ctid ASC")
            else:
                compared_columns = sql.SQL(", ").join(map(sql.Identifier, cursor_columns))
                source_query += sql.SQL(" ORDER BY {} ASC").format(compared_columns)
            source_query += sql.SQL(" LIMIT %s")
            params.append(batch_size)
            if fallback_offset is not None:
                source_query += sql.SQL(" OFFSET %s")
                params.append(fallback_offset)

            source_cursor.execute(source_query, tuple(params))
            rows = source_cursor.fetchall()
            if not rows:
                local_connection.rollback()
                source_connection.rollback()
                return 0

            if json_columns:
                json_indexes = {
                    index for index, column in enumerate(columns) if column in json_columns
                }
                rows = [
                    tuple(
                        Json(value) if index in json_indexes and value is not None else value
                        for index, value in enumerate(row)
                    )
                    for row in rows
                ]

            insert_query = sql.SQL("INSERT INTO {}.{} ({}) VALUES %s").format(
                sql.Identifier(TABLE_SCHEMA),
                sql.Identifier(TABLE_NAME),
                selected_columns,
            )
            execute_values(local_cursor, insert_query.as_string(local_connection), rows, page_size=1000)
            if "player_id" not in columns:
                raise RuntimeError("slot_parent_bet.player_id is required to update player_stats")
            player_id_index = columns.index("player_id")
            updated_player_count = _refresh_player_stats(
                local_cursor,
                [row[player_id_index] for row in rows],
            )
            local_connection.commit()
            source_connection.rollback()
            _log(f"player_stats updated for {updated_player_count:,} players")
            return len(rows)
    except Exception:
        if local_connection is not None:
            local_connection.rollback()
        if source_connection is not None:
            source_connection.rollback()
        raise
    finally:
        if local_connection is not None:
            local_connection.close()
        if source_connection is not None:
            source_connection.close()


def _run_sync_cycle():
    batch_number = 0
    _log("排程已啟動，立即執行第一次同步；後續週期與更新量由 config.json 控制")
    while True:
        batch_number += 1
        started_at = time.monotonic()
        try:
            interval_seconds, batch_size = _load_sync_settings()
        except Exception as error:
            interval_seconds = DEFAULT_SYNC_INTERVAL_SECONDS
            batch_size = DEFAULT_SYNC_BATCH_SIZE
            _log(
                f"同步設定無效：{error}；本批改用預設週期 "
                f"{interval_seconds} 秒、更新量 {batch_size:,} 筆",
                error=True,
            )
        _log(
            f"第 {batch_number} 批同步開始（週期 {interval_seconds} 秒，"
            f"上限 {batch_size:,} 筆）"
        )
        try:
            inserted_count = sync_one_batch(batch_size)
            if inserted_count:
                _log(f"第 {batch_number} 批同步成功，寫入 {inserted_count:,} 筆")
            else:
                _log(f"第 {batch_number} 批同步完成，目前沒有新資料")
        except Exception as error:
            _log(f"第 {batch_number} 批同步失敗：{error}", error=True)
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()

        remaining = started_at + interval_seconds - time.monotonic()
        if remaining > 0:
            next_run_at = datetime.now().astimezone() + timedelta(seconds=remaining)
            _log(f"下一次同步時間：{next_run_at.isoformat(timespec='seconds')}")
            time.sleep(remaining)


def start_slot_parent_bet_sync():
    """Start one periodic daemon synchronizer per Python process."""
    global _sync_thread
    with _start_lock:
        if _sync_thread is not None and _sync_thread.is_alive():
            return _sync_thread
        _sync_thread = threading.Thread(
            target=_run_sync_cycle,
            name="slot-parent-bet-sync",
            daemon=True,
        )
        _sync_thread.start()
        return _sync_thread
