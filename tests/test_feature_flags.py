"""同步功能開關的單元測試。 / Unit tests for synchronization feature flags."""

import sys
import unittest
from pathlib import Path


PYTHON_DIR = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(PYTHON_DIR))

from feature_flags import is_sync_and_scheduling_enabled


class SyncAndSchedulingConfigTests(unittest.TestCase):
    """驗證預設值、停用與型別錯誤。 / Verify defaults, disabling, and type errors."""
    def test_defaults_to_enabled_when_setting_is_missing(self):
        """缺少設定時預設啟用。 / Default to enabled when absent."""
        self.assertTrue(is_sync_and_scheduling_enabled({}))

    def test_can_be_disabled(self):
        """明確 false 時停用。 / Disable when explicitly false."""
        self.assertFalse(
            is_sync_and_scheduling_enabled({"syncAndSchedulingEnabled": False})
        )

    def test_rejects_non_boolean_value(self):
        """拒絕非布林設定。 / Reject non-boolean values."""
        with self.assertRaisesRegex(ValueError, "must be a boolean"):
            is_sync_and_scheduling_enabled({"syncAndSchedulingEnabled": "false"})


if __name__ == "__main__":
    unittest.main()
