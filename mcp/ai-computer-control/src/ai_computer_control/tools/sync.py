"""Automation synchronization primitives (poll-until-condition)."""

import time

from ai_computer_control.server import mcp


def _parse_hex(color_hex: str) -> tuple[int, int, int] | None:
    s = color_hex.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return None
    try:
        return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except ValueError:
        return None


@mcp.tool()
def wait_for_pixel(x: int, y: int, color_hex: str, timeout_ms: int = 10000,
                   tolerance: int = 10, poll_ms: int = 100) -> dict:
    """Poll the pixel at (x, y) until it matches color_hex (within tolerance) or timeout.

    A synchronization primitive: block until the screen visibly changes to an expected color.

    Args:
        x, y: Screen coordinates to sample.
        color_hex: Target color like "#3399ff" (or "39f").
        timeout_ms: Max time to wait, in milliseconds.
        tolerance: Per-channel absolute tolerance (0-255).
        poll_ms: Poll interval in milliseconds.

    Returns:
        dict with ok, matched (bool), waited_ms, and the last observed 'rgb'/'hex'.
    """
    target = _parse_hex(color_hex)
    if target is None:
        return {"ok": False, "error": f"invalid color_hex: {color_hex!r} (want e.g. '#3399ff')"}
    try:
        import pyautogui
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"pyautogui not available: {e}"}

    tr, tg, tb = target
    tol = max(0, int(tolerance))
    deadline = time.monotonic() + max(0, int(timeout_ms)) / 1000.0
    start = time.monotonic()
    last = None
    while True:
        try:
            r, g, b = pyautogui.pixel(int(x), int(y))
            last = (r, g, b)
            if abs(r - tr) <= tol and abs(g - tg) <= tol and abs(b - tb) <= tol:
                waited = int((time.monotonic() - start) * 1000)
                return {"ok": True, "matched": True, "waited_ms": waited,
                        "x": x, "y": y, "rgb": [r, g, b], "hex": f"#{r:02x}{g:02x}{b:02x}"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"pixel read failed: {e}", "x": x, "y": y}
        if time.monotonic() >= deadline:
            waited = int((time.monotonic() - start) * 1000)
            res = {"ok": True, "matched": False, "waited_ms": waited, "x": x, "y": y}
            if last is not None:
                res["rgb"] = [last[0], last[1], last[2]]
                res["hex"] = f"#{last[0]:02x}{last[1]:02x}{last[2]:02x}"
            return res
        time.sleep(max(0.0, poll_ms / 1000.0))
