"""玩家篩選與日期邊界的單元測試。 / Unit tests for player filters and date boundaries."""

import unittest
from datetime import date

from python.player_filters import (
    add_one_calendar_month,
    add_one_calendar_year,
    get_date_range_values,
    parse_player_filters,
    parse_optional_slot_id,
    validate_date_range,
)


class PlayerFilterTests(unittest.TestCase):
    """涵蓋 ID、布林值、Spin 與曆法邊界。 / Cover IDs, booleans, spins, and calendar edges."""
    def test_optional_slot_id_accepts_all_or_numeric_value(self):
        """ALL 與數字 ID 皆可解析。 / Accept ALL and numeric IDs."""
        self.assertIsNone(parse_optional_slot_id(None))
        self.assertIsNone(parse_optional_slot_id("ALL"))
        self.assertEqual(parse_optional_slot_id("123"), 123)

    def test_optional_slot_id_rejects_invalid_value(self):
        """拒絕無效或負數 ID。 / Reject invalid and negative IDs."""
        with self.assertRaises(ValueError):
            parse_optional_slot_id("invalid")
        with self.assertRaises(ValueError):
            parse_optional_slot_id("-1")

    def test_invalid_and_negative_spin_values_use_safe_defaults(self):
        """無效 Spin 值使用安全預設。 / Use safe defaults for invalid spin values."""
        filters = parse_player_filters({"min_spins": "bad", "max_spins": "-1"})
        self.assertEqual(filters["min_spins"], 0)
        self.assertEqual(filters["max_spins"], 10_000)

    def test_max_spins_is_never_lower_than_min_spins(self):
        """上限自動夾到不低於下限。 / Clamp the maximum at the minimum."""
        filters = parse_player_filters({"min_spins": "20", "max_spins": "10"})
        self.assertEqual(filters["min_spins"], 20)
        self.assertEqual(filters["max_spins"], 20)

    def test_boolean_filters_require_explicit_true(self):
        """只有字串 true 啟用布林條件。 / Require the literal true string."""
        filters = parse_player_filters({"new_player": "true", "win_player": "1"})
        self.assertTrue(filters["new_player"])
        self.assertFalse(filters["win_player"])

    def test_calendar_month_clamps_end_of_month(self):
        """跨月時正確截斷月底。 / Clamp correctly at month-end."""
        self.assertEqual(add_one_calendar_month(date(2024, 1, 31)), date(2024, 2, 29))
        self.assertEqual(add_one_calendar_month(date(2024, 12, 31)), date(2025, 1, 31))

    def test_calendar_year_clamps_leap_day(self):
        """閏日跨年改為 2 月 28 日。 / Clamp leap day to February 28."""
        self.assertEqual(add_one_calendar_year(date(2024, 2, 29)), date(2025, 2, 28))
        self.assertEqual(add_one_calendar_year(date(2026, 7, 22)), date(2027, 7, 22))

    def test_date_range_validation(self):
        """涵蓋順序、格式與一年上限。 / Cover ordering, format, and one-year limit."""
        self.assertIsNone(validate_date_range("2026-07-22", "2027-07-22"))
        self.assertIsNotNone(validate_date_range("2026-07-22", "2027-07-23"))
        self.assertIsNone(validate_date_range("2026-07-22", "2028-07-22", enforce_max_year=False))
        self.assertIsNotNone(validate_date_range("2026-07-02", "2026-07-01"))
        self.assertIsNotNone(validate_date_range("07/01/2026", "2026-07-02"))

    def test_date_range_values_include_exclusive_upper_bound(self):
        """SQL 上界為結束日次日。 / Use the day after end as SQL's exclusive bound."""
        self.assertEqual(
            get_date_range_values("2026-07-01", "2026-07-02"),
            (date(2026, 7, 1), date(2026, 7, 2), date(2026, 7, 3)),
        )


if __name__ == "__main__":
    unittest.main()
