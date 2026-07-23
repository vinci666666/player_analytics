"""應用程式功能開關的純驗證工具。 / Pure validators for application feature flags."""


def is_sync_and_scheduling_enabled(config):
    """判斷是否允許啟動背景同步與排程。 / Return whether sync and scheduled jobs may start."""
    enabled = config.get("syncAndSchedulingEnabled", True)
    if not isinstance(enabled, bool):
        raise ValueError("config.json syncAndSchedulingEnabled must be a boolean")
    return enabled
