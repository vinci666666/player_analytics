"""Shared configuration and PostgreSQL infrastructure for the analytics API."""

import json
import os
import sys
from datetime import datetime
from threading import Lock

import psycopg2
from flask import jsonify
from psycopg2.extras import execute_values
from psycopg2.pool import ThreadedConnectionPool


CONFIG_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'config.json'))
QUERY_TIMEOUT_MS = 30_000
PLAYER_DAILY_SUMMARY = "public.player_daily_summary"
PLAYER_DAILY = "public.player_daily"
LOCAL_DB_DEFAULTS = {
    "host": "localhost",
    "port": 5432,
    "database": "analytics",
    "user": "postgres",
    "password": "postgres",
}

_db_pool = None
_config_cache = None
_config_mtime = None
_pool_lock = Lock()
_lookup_refresh_lock = Lock()


def load_config():
    """Load and cache project configuration, invalidating when the file changes."""
    global _config_cache, _config_mtime
    defaults = {"localDB": LOCAL_DB_DEFAULTS.copy()}
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
        if _config_cache is not None and mtime == _config_mtime:
            return _config_cache
        with open(CONFIG_PATH, 'r', encoding='utf-8') as config_file:
            loaded = json.load(config_file)
        if not isinstance(loaded, dict):
            raise ValueError("config.json must contain a JSON object")
        local_db = loaded.get("localDB", {})
        if not isinstance(local_db, dict):
            raise ValueError("config.json localDB must contain a JSON object")
        config = {
            **defaults,
            **loaded,
            "localDB": {**LOCAL_DB_DEFAULTS, **local_db},
        }
        _config_cache, _config_mtime = config, mtime
        return config
    except FileNotFoundError:
        try:
            with open(CONFIG_PATH, 'w', encoding='utf-8') as config_file:
                json.dump(defaults, config_file, indent=4)
        except OSError as error:
            print(f"Unable to create {CONFIG_PATH}: {error}", file=sys.stderr)
        _config_cache = defaults
        return defaults
    except (OSError, ValueError) as error:
        print(f"Unable to read {CONFIG_PATH}: {error}", file=sys.stderr)
        return defaults


def _lookup_dict(cursor, table_name, id_column, name_column):
    cursor.execute(
        f"SELECT {id_column}, {name_column} FROM public.{table_name} ORDER BY {id_column}"
    )
    rows = cursor.fetchall()
    if rows and isinstance(rows[0], dict):
        return {str(row[id_column]): str(row[name_column]) for row in rows}
    return {str(item_id): str(item_name) for item_id, item_name in rows}


def _refresh_name_lookup(lookup_name):
    """Refresh one local lookup table from pro_central in its own transaction."""
    with _lookup_refresh_lock:
        config = load_config()
        source_config = config.get("pro_central")
        local_config = config.get("localDB")
        if not isinstance(source_config, dict) or not isinstance(local_config, dict):
            print(f"Unable to refresh {lookup_name}: database config is missing", file=sys.stderr)
            return False

        source_connection = None
        local_connection = None
        try:
            source_connection = psycopg2.connect(
                **{**source_config, "connect_timeout": source_config.get("connect_timeout", 5)}
            )
            local_connection = psycopg2.connect(
                **{**local_config, "connect_timeout": local_config.get("connect_timeout", 5)}
            )
            with source_connection.cursor() as source_cursor, local_connection.cursor() as local_cursor:
                if lookup_name == "game_name":
                    source_cursor.execute(
                        """
                        SELECT slot_id, game_name
                        FROM public.slot_game_name
                        WHERE language = 'en-US'
                        ORDER BY slot_id
                        """
                    )
                    rows = source_cursor.fetchall()
                    execute_values(
                        local_cursor,
                        """
                        INSERT INTO public.game_name (game_id, game_name) VALUES %s
                        ON CONFLICT (game_id) DO UPDATE
                        SET game_name = EXCLUDED.game_name
                        """,
                        rows,
                    )
                elif lookup_name == "agent_name":
                    source_cursor.execute(
                        "SELECT id, name, parent_id FROM public.client ORDER BY id"
                    )
                    rows = source_cursor.fetchall()
                    execute_values(
                        local_cursor,
                        """
                        INSERT INTO public.agent_name (agent_id, agent_name, parent_agent) VALUES %s
                        ON CONFLICT (agent_id) DO UPDATE SET
                            agent_name = EXCLUDED.agent_name,
                            parent_agent = EXCLUDED.parent_agent
                        """,
                        rows,
                    )
                else:
                    raise ValueError(f"Unsupported lookup: {lookup_name}")
            local_connection.commit()
            return True
        except Exception as error:
            if local_connection is not None:
                local_connection.rollback()
            print(f"Unable to refresh {lookup_name}: {error}", file=sys.stderr)
            return False
        finally:
            if local_connection is not None:
                local_connection.close()
            if source_connection is not None:
                source_connection.close()


def _required_ids_missing(lookup, required_ids):
    return bool({str(item_id) for item_id in (required_ids or ()) if item_id is not None} - lookup.keys())


def get_game_names(cursor=None, required_ids=None):
    """Return game names, refreshing once when a requested ID is missing."""
    owns_connection = cursor is None
    connection = None
    try:
        if owns_connection:
            connection = get_db_connection()
            cursor = connection.cursor()
            apply_query_timeout(cursor)
        lookup = _lookup_dict(cursor, "game_name", "game_id", "game_name")
        if _required_ids_missing(lookup, required_ids) and _refresh_name_lookup("game_name"):
            lookup = _lookup_dict(cursor, "game_name", "game_id", "game_name")
        return lookup
    finally:
        if owns_connection and connection:
            release_db_connection(connection)


def get_agent_names(cursor=None, required_ids=None):
    """Return agent names, refreshing once when a requested ID is missing."""
    owns_connection = cursor is None
    connection = None
    try:
        if owns_connection:
            connection = get_db_connection()
            cursor = connection.cursor()
            apply_query_timeout(cursor)
        lookup = _lookup_dict(cursor, "agent_name", "agent_id", "agent_name")
        if _required_ids_missing(lookup, required_ids) and _refresh_name_lookup("agent_name"):
            lookup = _lookup_dict(cursor, "agent_name", "agent_id", "agent_name")
        return lookup
    finally:
        if owns_connection and connection:
            release_db_connection(connection)


def get_local_db_config():
    """Return the local PostgreSQL connection settings from config.json."""
    return load_config()["localDB"].copy()


def _initialize_pool():
    global _db_pool
    config = get_local_db_config()
    _db_pool = ThreadedConnectionPool(
        minconn=1, maxconn=10, host=config["host"], port=config["port"],
        database=config["database"], user=config["user"], password=config["password"],
        connect_timeout=5
    )


def get_db_connection():
    global _db_pool
    if _db_pool is None:
        with _pool_lock:
            if _db_pool is None:
                _initialize_pool()
    connection = _db_pool.getconn()
    connection.autocommit = False
    return connection


def release_db_connection(connection):
    if not _db_pool or not connection:
        return
    try:
        if not connection.closed:
            connection.rollback()
    except Exception as error:
        print(f"Unable to reset database connection: {error}", file=sys.stderr)
    _db_pool.putconn(connection)


def apply_query_timeout(cursor):
    cursor.execute("SET LOCAL statement_timeout = %s", (QUERY_TIMEOUT_MS,))


def db_error_response(error):
    error_text = str(error)
    try:
        if __package__:
            from .server_audit import ERROR, write_server_action
        else:
            from server_audit import ERROR, write_server_action
        write_server_action(ERROR, f"Database operation failed: {error_text}")
    except Exception as log_error:
        print(f"Unable to record database error: {log_error}", file=sys.stderr)
    if "statement timeout" in error_text or "canceling statement due to statement timeout" in error_text:
        return jsonify({"error": "查詢超過 30 秒，請縮小範圍或重新送出請求"}), 504
    return jsonify({"error": error_text}), 500


def is_player_daily_summary_available(cursor):
    cursor.execute("""
        SELECT COALESCE((SELECT c.relkind = 'm' AND c.relispopulated
                         FROM pg_class c WHERE c.oid = to_regclass(%s)), false)
    """, (PLAYER_DAILY_SUMMARY,))
    row = cursor.fetchone()
    value = next(iter(row.values())) if isinstance(row, dict) else row[0]
    return bool(value)


def is_player_daily_available(cursor):
    """Return whether the compact player/day aggregate table is available."""
    cursor.execute("""
        SELECT COALESCE((SELECT c.relkind IN ('r', 'p')
                         FROM pg_class c WHERE c.oid = to_regclass(%s)), false)
    """, (PLAYER_DAILY,))
    row = cursor.fetchone()
    value = next(iter(row.values())) if isinstance(row, dict) else row[0]
    return bool(value)


class TtlCache:
    """Small process-local TTL cache for read-heavy dashboard responses."""

    def __init__(self, ttl_seconds, max_entries=None):
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._values = {}
        self._lock = Lock()

    def get(self, key):
        with self._lock:
            item = self._values.get(key)
            if not item:
                return None
            expires_at, value = item
            if datetime.utcnow().timestamp() >= expires_at:
                self._values.pop(key, None)
                return None
            return value

    def set(self, key, value):
        with self._lock:
            now = datetime.utcnow().timestamp()
            if self.max_entries is not None:
                self._values = {
                    cached_key: item
                    for cached_key, item in self._values.items()
                    if item[0] > now
                }
                if key not in self._values and len(self._values) >= self.max_entries:
                    oldest_key = min(self._values, key=lambda cached_key: self._values[cached_key][0])
                    self._values.pop(oldest_key, None)
            self._values[key] = (now + self.ttl_seconds, value)

    def clear(self):
        """Remove every cached value."""
        with self._lock:
            self._values.clear()

    def set_ttl_seconds(self, ttl_seconds):
        """Update the TTL used by future cache writes."""
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        with self._lock:
            self.ttl_seconds = ttl_seconds
