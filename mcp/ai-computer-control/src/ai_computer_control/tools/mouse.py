"""Mouse control tools."""

import pyautogui
from ai_computer_control.server import mcp

# Disable pyautogui fail-safe (moving to corner won't abort)
pyautogui.FAILSAFE = False


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
        dict with 'ok' and the click position.
    """
    try:
        pyautogui.click(x=x, y=y, button=button, clicks=clicks, interval=interval)
        return {"ok": True, "x": x, "y": y, "button": button, "clicks": clicks}
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
        dict with 'ok' and the target position.
    """
    try:
        pyautogui.moveTo(x=x, y=y, duration=duration)
        return {"ok": True, "x": x, "y": y}
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
        dict with 'ok' and start/end positions.
    """
    try:
        pyautogui.moveTo(start_x, start_y)
        pyautogui.drag(
            end_x - start_x,
            end_y - start_y,
            duration=duration,
            button=button,
        )
        return {
            "ok": True,
            "start": {"x": start_x, "y": start_y},
            "end": {"x": end_x, "y": end_y},
        }
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
        clicks: Number of scroll units. Positive = up/right, negative = down/left.
        x: Optional X coordinate to scroll at (defaults to current position).
        y: Optional Y coordinate to scroll at (defaults to current position).
        direction: "vertical" (default) or "horizontal".

    Returns:
        dict with 'ok' and scroll details.
    """
    try:
        if x is not None and y is not None:
            pyautogui.moveTo(x, y)
        if direction == "horizontal":
            pyautogui.hscroll(clicks)
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
