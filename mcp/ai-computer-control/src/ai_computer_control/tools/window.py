"""Window management tools for Windows OS."""

import win32gui
import win32con
import win32process
import ctypes
from ai_computer_control.server import mcp


def _get_window_info(hwnd: int) -> dict | None:
    """Get information about a window handle."""
    if not win32gui.IsWindowVisible(hwnd):
        return None
    title = win32gui.GetWindowText(hwnd)
    if not title:
        return None
    rect = win32gui.GetWindowRect(hwnd)
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    return {
        "handle": hwnd,
        "title": title,
        "pid": pid,
        "x": rect[0],
        "y": rect[1],
        "width": rect[2] - rect[0],
        "height": rect[3] - rect[1],
    }


def _resolve(title: str | None, handle: int | None) -> int | None:
    """Resolve a window handle from an explicit handle or a title (exact, then partial match)."""
    if handle:
        return handle
    if not title:
        return None
    hwnd = win32gui.FindWindow(None, title)
    if hwnd:
        return hwnd
    results = []

    def callback(h, _):
        try:
            if title.lower() in win32gui.GetWindowText(h).lower():
                results.append(h)
        except Exception:
            pass
        return True

    win32gui.EnumWindows(callback, None)
    return results[0] if results else None


@mcp.tool()
def list_windows() -> dict:
    """List all visible windows with their titles, handles, and positions.

    Returns:
        dict with 'ok' and 'windows' list containing window info.
    """
    try:
        windows = []

        def callback(hwnd, _):
            info = _get_window_info(hwnd)
            if info:
                windows.append(info)
            return True

        win32gui.EnumWindows(callback, None)
        return {"ok": True, "windows": windows, "count": len(windows)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool()
def get_active_window() -> dict:
    """Get information about the currently focused/active window.

    Returns:
        dict with 'ok' and window info (handle, title, position, size).
    """
    try:
        hwnd = win32gui.GetForegroundWindow()
        info = _get_window_info(hwnd)
        if info:
            info["ok"] = True
            return info
        return {"ok": False, "error": "No active window found"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def focus_window(title: str | None = None, handle: int | None = None) -> dict:
    """Bring a window to the foreground by title or handle.

    Args:
        title: Window title (partial match supported).
        handle: Window handle (takes priority over title).

    Returns:
        dict with 'ok' and window info.
    """
    try:
        hwnd = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}

        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)

        win32gui.SetForegroundWindow(hwnd)
        return {"ok": True, **(_get_window_info(hwnd) or {})}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def resize_window(
    width: int,
    height: int,
    title: str | None = None,
    handle: int | None = None,
) -> dict:
    """Resize a window.

    Args:
        width: New width in pixels.
        height: New height in pixels.
        title: Window title to find.
        handle: Window handle (takes priority).

    Returns:
        dict with 'ok'.
    """
    try:
        hwnd = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        rect = win32gui.GetWindowRect(hwnd)
        win32gui.MoveWindow(hwnd, rect[0], rect[1], width, height, True)
        return {"ok": True, "width": width, "height": height}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def move_window(
    x: int,
    y: int,
    title: str | None = None,
    handle: int | None = None,
) -> dict:
    """Move a window to a new position.

    Args:
        x: New X coordinate.
        y: New Y coordinate.
        title: Window title to find.
        handle: Window handle (takes priority).

    Returns:
        dict with 'ok'.
    """
    try:
        hwnd = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        rect = win32gui.GetWindowRect(hwnd)
        width = rect[2] - rect[0]
        height = rect[3] - rect[1]
        win32gui.MoveWindow(hwnd, x, y, width, height, True)
        return {"ok": True, "x": x, "y": y}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def minimize_window(title: str | None = None, handle: int | None = None) -> dict:
    """Minimize a window.

    Args:
        title: Window title to find.
        handle: Window handle.

    Returns:
        dict with 'ok'.
    """
    try:
        hwnd = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def maximize_window(title: str | None = None, handle: int | None = None) -> dict:
    """Maximize a window.

    Args:
        title: Window title to find.
        handle: Window handle.

    Returns:
        dict with 'ok'.
    """
    try:
        hwnd = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def close_window(title: str | None = None, handle: int | None = None) -> dict:
    """Close a window.

    Args:
        title: Window title to find.
        handle: Window handle.

    Returns:
        dict with 'ok'.
    """
    try:
        hwnd = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def set_window_topmost(
    topmost: bool = True,
    title: str | None = None,
    handle: int | None = None,
) -> dict:
    """Set a window to always stay on top (or remove topmost).

    Args:
        topmost: True to pin on top, False to unpin.
        title: Window title to find.
        handle: Window handle.

    Returns:
        dict with 'ok' and topmost state.
    """
    try:
        hwnd = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}

        flag = win32con.HWND_TOPMOST if topmost else win32con.HWND_NOTOPMOST
        rect = win32gui.GetWindowRect(hwnd)
        ctypes.windll.user32.SetWindowPos(
            hwnd, flag, rect[0], rect[1],
            rect[2] - rect[0], rect[3] - rect[1],
            win32con.SWP_SHOWWINDOW,
        )
        return {"ok": True, "topmost": topmost}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
