"""Shared configuration and PostgreSQL infrastructure for the analytics API."""

import json
import os
import sys
from datetime import datetime
from threading import Lock

from flask import jsonify
from psycopg2.pool import ThreadedConnectionPool


CONFIG_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'config.json'))
QUERY_TIMEOUT_MS = 30_000
PLAYER_DAILY_SUMMARY = "public.player_daily_summary"
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


def get_game_names(cursor=None):
    """Return the game ID/name lookup from localDB.public.game_name."""
    owns_connection = cursor is None
    connection = None
    try:
        if owns_connection:
            connection = get_db_connection()
            cursor = connection.cursor()
            apply_query_timeout(cursor)
        cursor.execute("""
            SELECT game_id, game_name
            FROM public.game_name
            ORDER BY game_id;
        """)
        rows = cursor.fetchall()
        if rows and isinstance(rows[0], dict):
            return {str(row["game_id"]): str(row["game_name"]) for row in rows}
        return {str(game_id): str(game_name) for game_id, game_name in rows}
    finally:
        if owns_connection and connection:
            release_db_connection(connection)


def get_agent_names(cursor=None):
    """Return the agent ID/name lookup from localDB.public.agent_name."""
    owns_connection = cursor is None
    connection = None
    try:
        if owns_connection:
            connection = get_db_connection()
            cursor = connection.cursor()
            apply_query_timeout(cursor)
        cursor.execute("""
            SELECT agent_id, agent_name
            FROM public.agent_name
            ORDER BY agent_id;
        """)
        rows = cursor.fetchall()
        if rows and isinstance(rows[0], dict):
            return {str(row["agent_id"]): str(row["agent_name"]) for row in rows}
        return {str(agent_id): str(agent_name) for agent_id, agent_name in rows}
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


class TtlCache:
    """Small process-local TTL cache for read-heavy dashboard responses."""

    def __init__(self, ttl_seconds):
        self.ttl_seconds = ttl_seconds
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
            self._values[key] = (datetime.utcnow().timestamp() + self.ttl_seconds, value)
