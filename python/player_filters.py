"""Pure validation and parsing helpers for player-analysis requests."""

import calendar
from datetime import datetime, timedelta
from typing import Mapping, TypedDict


DEFAULT_MAX_SPINS = 10_000
DATE_FORMAT = "%Y-%m-%d"


class PlayerFilters(TypedDict):
    new_player: bool
    old_player: bool
    win_player: bool
    lose_player: bool
    min_spins: int
    max_spins: int


def _non_negative_integer(value, default):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def parse_player_filters(args: Mapping[str, str]) -> PlayerFilters:
    """Normalize player filter parameters without depending on Flask globals."""
    min_spins = _non_negative_integer(args.get("min_spins", 0), 0)
    max_spins = _non_negative_integer(
        args.get("max_spins", DEFAULT_MAX_SPINS), DEFAULT_MAX_SPINS
    )
    max_spins = max(min_spins, max_spins)

    return {
        "new_player": args.get("new_player") == "true",
        "old_player": args.get("old_player") == "true",
        "win_player": args.get("win_player") == "true",
        "lose_player": args.get("lose_player") == "true",
        "min_spins": min_spins,
        "max_spins": max_spins,
    }


def parse_optional_slot_id(value):
    """Return a numeric slot ID, or ``None`` when all games are selected."""
    if value is None or str(value).strip() == "" or str(value).upper() == "ALL":
        return None
    try:
        slot_id = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("slot_id must be numeric or ALL") from exc
    if slot_id < 0:
        raise ValueError("slot_id must be non-negative")
    return slot_id


def add_one_calendar_month(date_value):
    """Return the same day next month, clamped to that month's last day."""
    month = date_value.month + 1
    year = date_value.year
    if month > 12:
        month = 1
        year += 1

    max_day = calendar.monthrange(year, month)[1]
    return date_value.replace(year=year, month=month, day=min(date_value.day, max_day))


def add_one_calendar_year(date_value):
    """Return the same day next year, clamping leap day to February 28."""
    try:
        return date_value.replace(year=date_value.year + 1)
    except ValueError:
        return date_value.replace(year=date_value.year + 1, month=2, day=28)


def validate_date_range(start_date, end_date, enforce_max_year=True):
    """Return a user-facing validation error, or ``None`` for a valid range."""
    try:
        start = datetime.strptime(start_date, DATE_FORMAT).date()
        end = datetime.strptime(end_date, DATE_FORMAT).date()
    except (TypeError, ValueError):
        return "日期格式錯誤，請使用 YYYY-MM-DD"

    if start > end:
        return "開始日期必須小於或等於結束日期"
    if enforce_max_year and end > add_one_calendar_year(start):
        return "時間區間不可超過一年"
    return None


def get_date_range_values(start_date, end_date):
    """Parse an inclusive date range and return its exclusive upper bound."""
    start = datetime.strptime(start_date, DATE_FORMAT).date()
    end = datetime.strptime(end_date, DATE_FORMAT).date()
    return start, end, end + timedelta(days=1)
