"""分析 API 共用的設定、PostgreSQL 與快取基礎設施。 / Shared configuration, PostgreSQL, and cache infrastructure."""

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
    """載入並快取設定；檔案異動時自動失效。 / Load and cache config, invalidating it after file changes."""
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
    """將名稱表轉為 ID 對名稱字典。 / Convert a lookup table into an ID-to-name dictionary."""
    cursor.execute(
        f"SELECT {id_column}, {name_column} FROM public.{table_name} ORDER BY {id_column}"
    )
    rows = cursor.fetchall()
    if rows and isinstance(rows[0], dict):
        return {str(row[id_column]): str(row[name_column]) for row in rows}
    return {str(item_id): str(item_name) for item_id, item_name in rows}


def _refresh_name_lookup(lookup_name):
    """以獨立交易從 pro_central 更新本機名稱表。 / Refresh one local lookup in its own transaction."""
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
    """檢查呼叫端需要的 ID 是否未在快取中。 / Check whether requested IDs are missing from a lookup."""
    return bool({str(item_id) for item_id in (required_ids or ()) if item_id is not None} - lookup.keys())


def get_game_names(cursor=None, required_ids=None):
    """回傳遊戲名稱；缺少指定 ID 時最多刷新一次。 / Return game names, refreshing once for missing IDs."""
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
    """回傳 Agent 名稱；缺少指定 ID 時最多刷新一次。 / Return agent names, refreshing once for missing IDs."""
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
    """取得本機 PostgreSQL 連線設定副本。 / Return a copy of local PostgreSQL settings."""
    return load_config()["localDB"].copy()


def _initialize_pool():
    """延遲建立程序共用的資料庫連線池。 / Lazily initialize the process-wide connection pool."""
    global _db_pool
    config = get_local_db_config()
    _db_pool = ThreadedConnectionPool(
        minconn=1, maxconn=10, host=config["host"], port=config["port"],
        database=config["database"], user=config["user"], password=config["password"],
        connect_timeout=5
    )


def get_db_connection():
    """從連線池借用一條連線。 / Borrow one connection from the pool."""
    global _db_pool
    if _db_pool is None:
        with _pool_lock:
            if _db_pool is None:
                _initialize_pool()
    connection = _db_pool.getconn()
    connection.autocommit = False
    return connection


def release_db_connection(connection):
    """安全回收連線；無法回收時關閉。 / Safely return a connection, closing it on pool errors."""
    if not _db_pool or not connection:
        return
    try:
        if not connection.closed:
            connection.rollback()
    except Exception as error:
        print(f"Unable to reset database connection: {error}", file=sys.stderr)
    _db_pool.putconn(connection)


def apply_query_timeout(cursor):
    """為目前交易套用查詢逾時。 / Apply the statement timeout to the current transaction."""
    cursor.execute("SET LOCAL statement_timeout = %s", (QUERY_TIMEOUT_MS,))


def db_error_response(error):
    """記錄資料庫例外並建立一致的 HTTP 500 回應。 / Log a DB exception and build a consistent HTTP 500 response."""
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


def is_player_daily_available(cursor):
    """確認精簡玩家日彙總表是否存在。 / Return whether the compact player/day aggregate table exists."""
    cursor.execute("""
        SELECT COALESCE((SELECT c.relkind IN ('r', 'p')
                         FROM pg_class c WHERE c.oid = to_regclass(%s)), false)
    """, (PLAYER_DAILY,))
    row = cursor.fetchone()
    value = next(iter(row.values())) if isinstance(row, dict) else row[0]
    return bool(value)


class TtlCache:
    """適用於讀取密集儀表板的小型程序內 TTL 快取。 / Small process-local TTL cache for read-heavy responses."""

    def __init__(self, ttl_seconds, max_entries=None):
        """建立具可選容量上限的快取。 / Create a cache with an optional entry limit."""
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._values = {}
        self._lock = Lock()

    def get(self, key):
        """取得未過期值；過期時同步移除。 / Return a live value and remove it when expired."""
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
        """寫入值並在超過容量時淘汰最舊項目。 / Store a value and evict the oldest item at capacity."""
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
        """清除全部快取值。 / Remove every cached value."""
        with self._lock:
            self._values.clear()

    def set_ttl_seconds(self, ttl_seconds):
        """更新後續寫入採用的 TTL。 / Update the TTL used by future writes."""
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        with self._lock:
            self.ttl_seconds = ttl_seconds
