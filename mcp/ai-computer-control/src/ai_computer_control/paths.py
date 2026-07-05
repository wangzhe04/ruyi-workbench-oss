"""Shared data-directory resolution for logs, config, and other runtime state.

The data directory holds the audit log (logs/audit-YYYYMMDD.ndjson) and the optional
safety.json overrides. It is created lazily and never raises to callers: if it cannot be
created, helpers fall back to returning a path anyway (writes will fail softly at the call site).
"""

import os

_APP_NAME = "ai-computer-control"


def data_dir() -> str:
    """Return the writable data directory, creating it if possible.

    Order of preference:
      1. $WCW_DATA_DIR (explicit override, e.g. for tests),
      2. %LOCALAPPDATA%\\ai-computer-control\\data (matches the installed layout),
      3. ~/.ai-computer-control (last resort).
    """
    override = os.environ.get("WCW_DATA_DIR")
    if override:
        base = override
    else:
        local = os.environ.get("LOCALAPPDATA")
        if local:
            base = os.path.join(local, _APP_NAME, "data")
        else:
            base = os.path.join(os.path.expanduser("~"), "." + _APP_NAME)
    try:
        os.makedirs(base, exist_ok=True)
    except Exception:
        pass
    return base


def logs_dir() -> str:
    """Return (and create) the logs subdirectory under the data directory."""
    d = os.path.join(data_dir(), "logs")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


def safety_config_path() -> str:
    """Return the path to the optional safety.json overrides file (may not exist)."""
    return os.path.join(data_dir(), "safety.json")
