"""Mouse control tools."""

import ctypes
import pyautogui
from ai_computer_control.server import mcp
from ai_computer_control.utils import geometry

# Disable pyautogui fail-safe. NOTE: this is process-wide and intentional — the agent may legitimately
# need to reach a screen corner, which pyautogui's default FAILSAFE would abort with an exception.
pyautogui.FAILSAFE = False

_WHEEL_DELTA = 120
_MOUSEEVENTF_HWHEEL = 0x01000


def _pos() -> tuple[int, int]:
    p = pyautogui.position()
    return int(p.x), int(p.y)


def _virtual_bounds() -> tuple[int, int, int, int]:
    """Virtual-desktop rect (all monitors) — the same space get_screen_info reports as 'virtual'."""
    return geometry.virtual_desktop_bounds()


def _off_desktop(what: str, *points) -> dict | None:
    """Refusal dict if any (x, y) in `points` is outside the virtual desktop, else None."""
    bounds = _virtual_bounds()
    for x, y in points:
        if not geometry.point_in_bounds(x, y, bounds):
            return geometry.outside_error(what, x, y, bounds)
    return None


def _reached(x: int, y: int, tol: int = 2) -> dict:
    """Read back the real cursor position after a move so a clamped/off-screen target is visible."""
    ax, ay = _pos()
    return {"actual_x": ax, "actual_y": ay, "reached": abs(ax - x) <= tol and abs(ay - y) <= tol}


def _move_for_scroll(x: int, y: int) -> dict | None:
    """Park the cursor at (x, y) before a wheel event; a refusal dict if the wheel must NOT be sent.

    The wheel goes to whatever window is under the cursor, so scrolling after a clamped/off-screen move would
    scroll an unrelated window at the screen edge. Same two guards as click/move/drag: refuse a target outside
    the virtual desktop before moving, and read the cursor back after moving.
    """
    refused = _off_desktop("scroll", (x, y))
    if refused:
        return refused
    pyautogui.moveTo(x, y)
    landed = _reached(x, y)
    if not landed["reached"]:
        return {"ok": False,
                "error": (f"cursor did not land on ({x},{y}) (it is at {landed['actual_x']},{landed['actual_y']}); "
                          f"not scrolling, the wheel would hit another window"),
                **landed}
    return None


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
        x: X coordinate.
        y: Y coordinate.
        button: "left", "right", or "middle".
        clicks: Number of clicks (1 single, 2 double).
        interval: Seconds between multiple clicks.

    Returns:
        dict with 'ok', the requested position, and the ACTUAL cursor position ('actual_x/y', 'reached') so a
        clamped target does not read as success. Targets outside the virtual desktop (see get_screen_info
        'virtual') are refused.
    """
    try:
        # b2-P1: 越界预校验 —— 先于点击拦截,避免「先点后报」在屏边缘真实误点
        # F2: 边界用虚拟桌面(与 get_screen_info 一致),副屏(含负坐标)可点。
        refused = _off_desktop("click", (x, y))
        if refused:
            return refused
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
        refused = _off_desktop("move", (x, y))
        if refused:
            return refused
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
        refused = _off_desktop("drag", (start_x, start_y), (end_x, end_y))
        if refused:
            return refused
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
        clicks: Wheel notches. Positive = up/right, negative = down/left.
        x: Optional X to scroll at (default: current position).
        y: Optional Y to scroll at (default: current position).
        direction: "vertical" (default) or "horizontal" (a real WM_MOUSEHWHEEL event; pyautogui's hscroll is a
            no-op on Windows).

    Returns:
        dict with 'ok' and scroll details. With x/y, a target outside the virtual desktop (see get_screen_info
        'virtual') or a cursor that does not land there is refused BEFORE any wheel event.
    """
    try:
        if x is not None and y is not None:
            refused = _move_for_scroll(x, y)
            if refused:
                return refused
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
        dict with 'ok', position, and amount. A target outside the virtual desktop, or a cursor that does not
        land there, is refused before any wheel event.
    """
    try:
        refused = _move_for_scroll(x, y)
        if refused:
            return refused
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
