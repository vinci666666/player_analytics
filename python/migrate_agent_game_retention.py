"""建立並重建 Agent 遊戲快照，再移除舊表。 / Build the Agent-by-game snapshot and remove the legacy table."""

from pathlib import Path

if __package__:
    from .infrastructure import get_db_connection, release_db_connection
else:
    from infrastructure import get_db_connection, release_db_connection


ROOT = Path(__file__).resolve().parent.parent


def _read_sql(name):
    """讀取 SQL 並移除僅供 psql 使用的 include 指令。 / Read SQL while removing psql-only include directives."""
    text = (ROOT / "sql" / name).read_text(encoding="utf-8")
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("\\ir ")
    )


def run():
    """在可回滾交易內依序執行建表與完整刷新。 / Run table creation and full refresh in a rollback-safe transaction."""
    connection = get_db_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute(_read_sql("create_agent_daily_game_retention.sql"))
            connection.commit()
            cursor.execute(_read_sql("refresh_agent_retention.sql"))
            connection.commit()
            cursor.execute(
                """
                SELECT COUNT(*), MIN(date), MAX(date)
                FROM public.agent_daily_game_retention
                """
            )
            row_count, first_date, last_date = cursor.fetchone()
            cursor.execute("SELECT to_regclass('public.agent_daily_retention')")
            legacy_table = cursor.fetchone()[0]
            return {
                "rows": row_count,
                "first_date": first_date.isoformat() if first_date else None,
                "last_date": last_date.isoformat() if last_date else None,
                "legacy_table": legacy_table,
            }
    except Exception:
        connection.rollback()
        raise
    finally:
        release_db_connection(connection)


if __name__ == "__main__":
    print(run())
