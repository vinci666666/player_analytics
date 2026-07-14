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

_db_pool = None
_config_cache = None
_config_mtime = None
_pool_lock = Lock()


def load_config():
    """Load and cache project configuration, invalidating when the file changes."""
    global _config_cache, _config_mtime
    defaults = {
        "host": "localhost", "port": 5432, "database": "analytics",
        "user": "postgres", "password": "postgres", "game_name": {}
    }
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
        if _config_cache is not None and mtime == _config_mtime:
            return _config_cache
        with open(CONFIG_PATH, 'r', encoding='utf-8') as config_file:
            config = {**defaults, **json.load(config_file)}
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


def get_game_names():
    return {str(slot_id): str(name) for slot_id, name in load_config().get("game_name", {}).items()}


def _initialize_pool():
    global _db_pool
    config = load_config()
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
