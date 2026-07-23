"""Pure helpers for validating application feature flags."""


def is_sync_and_scheduling_enabled(config):
    """Return whether background data sync and scheduled jobs may start."""
    enabled = config.get("syncAndSchedulingEnabled", True)
    if not isinstance(enabled, bool):
        raise ValueError("config.json syncAndSchedulingEnabled must be a boolean")
    return enabled
