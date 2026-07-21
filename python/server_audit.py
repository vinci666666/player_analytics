"""Persistent UTC+7 server activity logging."""

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
    """Return the originating IP reported by the proxy or direct connection."""
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.remote_addr or "unknown"


def initialize_server_action_log():
    """Create the log table and indexes; safe to call on every startup."""
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
    """Write one event in a separate transaction so application rollbacks keep it."""
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
        # A database outage cannot be written to that same database.
        print(f"Unable to persist server action: {error}", file=sys.stderr)
        return False
    finally:
        if connection is not None:
            release_db_connection(connection)


def configure_server_action_logging(app):
    """Register request, response and uncaught-exception audit hooks."""
    initialize_server_action_log()

    @app.before_request
    def remember_request_start():
        g.server_action_started_at = time.monotonic()

    @app.after_request
    def log_response(response):
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
