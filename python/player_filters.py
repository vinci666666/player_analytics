"""玩家分析請求的純解析與驗證工具。 / Pure parsing and validation for player analysis."""

import calendar
from datetime import datetime, timedelta
from typing import Mapping, TypedDict


DEFAULT_MAX_SPINS = 10_000
DATE_FORMAT = "%Y-%m-%d"


class PlayerFilters(TypedDict):
    """標準化後的玩家篩選條件。 / Normalized player-filter fields."""
    new_player: bool
    old_player: bool
    win_player: bool
    lose_player: bool
    min_spins: int
    max_spins: int


def _non_negative_integer(value, default):
    """解析非負整數，無效時回退預設值。 / Parse a non-negative integer or use the default."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def parse_player_filters(args: Mapping[str, str]) -> PlayerFilters:
    """不依賴 Flask 全域狀態地正規化玩家篩選。 / Normalize filters without Flask globals."""
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
    """解析遊戲 ID；選擇全部遊戲時回傳 ``None``。 / Parse a slot ID, or ``None`` for all games."""
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
    """取得下個月同日，超出月底時取月底。 / Return the same day next month, clamped to month-end."""
    month = date_value.month + 1
    year = date_value.year
    if month > 12:
        month = 1
        year += 1

    max_day = calendar.monthrange(year, month)[1]
    return date_value.replace(year=year, month=month, day=min(date_value.day, max_day))


def add_one_calendar_year(date_value):
    """取得明年同日，閏日改為 2 月 28 日。 / Return the same day next year, clamping leap day."""
    try:
        return date_value.replace(year=date_value.year + 1)
    except ValueError:
        return date_value.replace(year=date_value.year + 1, month=2, day=28)


def validate_date_range(start_date, end_date, enforce_max_year=True):
    """驗證日期順序與一年上限；有效時回傳 ``None``。 / Validate ordering and the one-year limit."""
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
    """解析含首尾日期的範圍並產生不含上界。 / Parse an inclusive range and its exclusive upper bound."""
    start = datetime.strptime(start_date, DATE_FORMAT).date()
    end = datetime.strptime(end_date, DATE_FORMAT).date()
    return start, end, end + timedelta(days=1)
