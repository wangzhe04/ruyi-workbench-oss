"""Shared bound for the poll-until-condition tools (wait_for_pixel / wait_for_window / dialog waits).

A wait that holds the server for minutes is indistinguishable from a hang to the bridge (its only
remedy is killing the whole ACC process), so every wait clamps its timeout to MAX_WAIT_S and says so.
"""

MAX_WAIT_S = 120.0


def clamp_wait_s(value, default: float = 10.0) -> tuple[float, bool]:
    """(seconds, capped) — `value` coerced to a float in [0, MAX_WAIT_S]; `capped` when it was cut."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = default
    if v != v or v < 0:  # NaN / negative
        v = 0.0
    if v > MAX_WAIT_S:
        return MAX_WAIT_S, True
    return v, False


def capped_fields(requested, capped: bool) -> dict:
    """Result fields telling the model its timeout was reduced."""
    if not capped:
        return {}
    return {"capped": True, "requested_timeout": requested,
            "note": f"timeout capped at the {int(MAX_WAIT_S)}s maximum; call again to keep waiting."}
