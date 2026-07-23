"""持久化 UTC+7 伺服器活動紀錄。 / Persistent UTC+7 server activity logging."""

import sys
import time
from datetime import datetime, timedelta, timezone

from flask import g, got_request_exception, request

if __package__:
    from .infrastructure import get_db_connection, release_db_connection
else:
    from infrastructure import get_db_connection, release_db_connection


INFO = 1
WARNING = 2
ERROR = 3
AUTHENTICATION = 4
UTC_PLUS_7 = timezone(timedelta(hours=7))

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS public.server_action_log (
    time_utc7 TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    message_type_id SMALLINT NOT NULL,
    message_content TEXT NOT NULL,
    CONSTRAINT server_action_log_message_type_check
        CHECK (message_type_id IN (1, 2, 3, 4))
);
CREATE INDEX IF NOT EXISTS idx_server_action_log_time_utc7
    ON public.server_action_log (time_utc7 DESC);
CREATE INDEX IF NOT EXISTS idx_server_action_log_type_time
    ON public.server_action_log (message_type_id, time_utc7 DESC);
"""


def client_ip():
    """取得代理轉送或直接連線的來源 IP。 / Return the originating proxy or direct-client IP."""
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.remote_addr or "unknown"


def initialize_server_action_log():
    """建立紀錄表與索引，可在每次啟動安全重跑。 / Create the log table and indexes idempotently."""
    connection = None
    try:
        connection = get_db_connection()
        with connection.cursor() as cursor:
            cursor.execute(_CREATE_TABLE_SQL)
        connection.commit()
        return True
    except Exception as error:
        if connection is not None:
            connection.rollback()
        print(f"Unable to initialize server action log: {error}", file=sys.stderr)
        return False
    finally:
        if connection is not None:
            release_db_connection(connection)


def write_server_action(message_type_id, message_content):
    """以獨立交易寫入事件，避免應用交易回滾時遺失。 / Write in a separate transaction so app rollbacks preserve it."""
    connection = None
    try:
        connection = get_db_connection()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO public.server_action_log
                    (time_utc7, message_type_id, message_content)
                VALUES (%s, %s, %s)
                """,
                (
                    datetime.now(UTC_PLUS_7).replace(tzinfo=None),
                    int(message_type_id),
                    str(message_content),
                ),
            )
        connection.commit()
        return True
    except Exception as error:
        if connection is not None:
            connection.rollback()
        # 資料庫中斷無法再寫回同一資料庫，只能輸出 stderr。 / A DB outage cannot be logged to that same DB, so use stderr.
        print(f"Unable to persist server action: {error}", file=sys.stderr)
        return False
    finally:
        if connection is not None:
            release_db_connection(connection)


def configure_server_action_logging(app):
    """註冊請求、回應與未捕捉例外的稽核掛鉤。 / Register request, response, and uncaught-exception hooks."""
    initialize_server_action_log()

    @app.before_request
    def remember_request_start():
        """保存高精度開始時間供延遲計算。 / Save a high-resolution request start time."""
        g.server_action_started_at = time.monotonic()

    @app.after_request
    def log_response(response):
        """記錄回應狀態、路徑、IP 與耗時。 / Log response status, path, IP, and latency."""
        started_at = getattr(g, "server_action_started_at", None)
        duration_ms = (
            round((time.monotonic() - started_at) * 1000, 1)
            if started_at is not None
            else None
        )
        if response.status_code >= 500:
            message_type = ERROR
        elif response.status_code >= 400:
            message_type = WARNING
        else:
            message_type = INFO
        write_server_action(
            message_type,
            f"HTTP {request.method} {request.path} status={response.status_code} "
            f"ip={client_ip()} duration_ms={duration_ms}",
        )
        return response

    def log_unhandled_exception(sender, exception, **extra):
        """將未捕捉例外寫入持久化稽核。 / Persist uncaught exceptions in the audit log."""
        write_server_action(
            ERROR,
            f"Unhandled exception during {request.method} {request.path} "
            f"ip={client_ip()}: {exception}",
        )

    got_request_exception.connect(
        log_unhandled_exception,
        sender=app,
        weak=False,
    )
