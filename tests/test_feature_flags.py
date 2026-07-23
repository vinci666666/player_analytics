import sys
import unittest
from pathlib import Path


PYTHON_DIR = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(PYTHON_DIR))

from feature_flags import is_sync_and_scheduling_enabled


class SyncAndSchedulingConfigTests(unittest.TestCase):
    def test_defaults_to_enabled_when_setting_is_missing(self):
        self.assertTrue(is_sync_and_scheduling_enabled({}))

    def test_can_be_disabled(self):
        self.assertFalse(
            is_sync_and_scheduling_enabled({"syncAndSchedulingEnabled": False})
        )

    def test_rejects_non_boolean_value(self):
        with self.assertRaisesRegex(ValueError, "must be a boolean"):
            is_sync_and_scheduling_enabled({"syncAndSchedulingEnabled": "false"})


if __name__ == "__main__":
    unittest.main()
