"""Mouse control tools."""

import ctypes
import pyautogui
from ai_computer_control.server import mcp

# Disable pyautogui fail-safe. NOTE: this is process-wide and intentional — the agent may legitimately
# need to reach a screen corner, which pyautogui's default FAILSAFE would abort with an exception.
pyautogui.FAILSAFE = False

_WHEEL_DELTA = 120
_MOUSEEVENTF_HWHEEL = 0x01000


def _pos() -> tuple[int, int]:
    p = pyautogui.position()
    return int(p.x), int(p.y)


def _reached(x: int, y: int, tol: int = 2) -> dict:
    """Read back the real cursor position after a move so a clamped/off-screen target is visible."""
    ax, ay = _pos()
    return {"actual_x": ax, "actual_y": ay, "reached": abs(ax - x) <= tol and abs(ay - y) <= tol}


@mcp.tool(audit=True)
def mouse_click(
    x: int,
    y: int,
    button: str = "left",
    clicks: int = 1,
    interval: float = 0.1,
) -> dict:
    """Click the mouse at the specified coordinates.

    Args:
        x: X coordinate to click.
        y: Y coordinate to click.
        button: Mouse button - "left", "right", or "middle".
        clicks: Number of clicks (1 for single, 2 for double).
        interval: Seconds between multiple clicks.

    Returns:
        dict with 'ok', the requested position, and the ACTUAL cursor position ('actual_x/y',
        'reached') so an off-screen/clamped target does not read as a success.
    """
    try:
        pyautogui.click(x=x, y=y, button=button, clicks=clicks, interval=interval)
        out = {"ok": True, "x": x, "y": y, "button": button, "clicks": clicks, **_reached(x, y)}
        if not out["reached"]:
            out["note"] = "cursor did not land on the requested point (clamped/off-screen); the click may have missed."
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def mouse_move(x: int, y: int, duration: float = 0.2) -> dict:
    """Move the mouse cursor to the specified coordinates.

    Args:
        x: Target X coordinate.
        y: Target Y coordinate.
        duration: Time in seconds for the movement animation.

    Returns:
        dict with 'ok', the requested position, and the ACTUAL position reached.
    """
    try:
        pyautogui.moveTo(x=x, y=y, duration=duration)
        out = {"ok": True, "x": x, "y": y, **_reached(x, y)}
        if not out["reached"]:
            out["note"] = "cursor was clamped to the virtual desktop bounds; target is off-screen."
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def mouse_drag(
    start_x: int,
    start_y: int,
    end_x: int,
    end_y: int,
    duration: float = 0.5,
    button: str = "left",
) -> dict:
    """Drag the mouse from one position to another.

    Args:
        start_x: Starting X coordinate.
        start_y: Starting Y coordinate.
        end_x: Ending X coordinate.
        end_y: Ending Y coordinate.
        duration: Time in seconds for the drag operation.
        button: Mouse button to hold during drag.

    Returns:
        dict with 'ok', start/end positions, and the ACTUAL end position reached.
    """
    try:
        pyautogui.moveTo(start_x, start_y)
        pyautogui.drag(
            end_x - start_x,
            end_y - start_y,
            duration=duration,
            button=button,
        )
        out = {
            "ok": True,
            "start": {"x": start_x, "y": start_y},
            "end": {"x": end_x, "y": end_y},
            **_reached(end_x, end_y),
        }
        if not out["reached"]:
            out["note"] = "drag did not end on the requested point (clamped/off-screen)."
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def mouse_scroll(
    clicks: int,
    x: int | None = None,
    y: int | None = None,
    direction: str = "vertical",
) -> dict:
    """Scroll the mouse wheel.

    Args:
        clicks: Number of wheel notches. Positive = up/right, negative = down/left.
        x: Optional X coordinate to scroll at (defaults to current position).
        y: Optional Y coordinate to scroll at (defaults to current position).
        direction: "vertical" (default) or "horizontal".

    Returns:
        dict with 'ok' and scroll details. Horizontal uses a real WM_MOUSEHWHEEL event (pyautogui's
        hscroll is a no-op on Windows), so it actually scrolls sideways.
    """
    try:
        if x is not None and y is not None:
            pyautogui.moveTo(x, y)
        if direction == "horizontal":
            # pyautogui.hscroll delegates to the vertical wheel on Windows -> content moves the wrong
            # way. Send a genuine horizontal wheel event instead. dwData>0 = right.
            ctypes.windll.user32.mouse_event(_MOUSEEVENTF_HWHEEL, 0, 0, int(clicks) * _WHEEL_DELTA, 0)
        else:
            pyautogui.scroll(clicks)
        return {"ok": True, "clicks": clicks, "direction": direction}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def scroll_at(x: int, y: int, amount: int) -> dict:
    """Scroll the wheel by `amount` at screen position (x, y). Positive = up, negative = down.

    Convenience wrapper over mouse_scroll for the (x, y, amount) calling convention.

    Returns:
        dict with 'ok', position, and amount.
    """
    try:
        pyautogui.moveTo(x, y)
        pyautogui.scroll(amount)
        return {"ok": True, "x": x, "y": y, "amount": amount}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool()
def get_mouse_position() -> dict:
    """Get the current mouse cursor position.

    Returns:
        dict with 'x' and 'y' coordinates.
    """
    try:
        pos = pyautogui.position()
        return {"ok": True, "x": pos.x, "y": pos.y}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
