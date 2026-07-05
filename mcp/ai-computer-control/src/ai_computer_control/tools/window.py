"""Window management tools for Windows OS."""

import time
import win32gui
import win32con
import win32process
import ctypes
from ai_computer_control.server import mcp


def _get_window_info(hwnd: int, require_title: bool = True) -> dict | None:
    """Get information about a window handle.

    require_title=True (default, for listing) skips visible-but-untitled windows; set False when the
    caller already knows the handle is meaningful (e.g. the foreground window) and an empty title is
    still useful.
    """
    if not win32gui.IsWindowVisible(hwnd):
        return None
    title = win32gui.GetWindowText(hwnd)
    if require_title and not title:
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


def _resolve(title: str | None, handle: int | None) -> tuple[int | None, list]:
    """Resolve a window handle from an explicit handle or a title.

    Returns (hwnd, matches) where matches is the list of (hwnd, title) partial-title matches (empty
    for an explicit handle or an exact FindWindow hit). Callers surface len(matches) > 1 so the model
    knows it acted on one of several candidates rather than silently hitting an arbitrary window.
    """
    if handle:
        return handle, []
    if not title:
        return None, []
    hwnd = win32gui.FindWindow(None, title)
    if hwnd:
        return hwnd, []
    results = []

    def callback(h, _):
        try:
            if not win32gui.IsWindowVisible(h):
                return True
            t = win32gui.GetWindowText(h)
            if t and title.lower() in t.lower():
                results.append((h, t))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(callback, None)
    if not results:
        return None, []
    return results[0][0], results


def _amb(matches: list) -> dict:
    """Ambiguity fragment to merge into a return dict when a partial title matched > 1 window."""
    if len(matches) > 1:
        return {
            "matched_count": len(matches),
            "ambiguous": [t for _, t in matches[:8]],
            "note": f"{len(matches)} windows matched; acted on the first ('{matches[0][1]}'). "
                    f"Pass an explicit handle or a more specific title to disambiguate.",
        }
    return {}


def _is_foreground(hwnd: int) -> bool:
    try:
        return bool(hwnd) and win32gui.GetForegroundWindow() == hwnd
    except Exception:
        return False


def _activate(hwnd: int) -> tuple[bool, int]:
    """Bring `hwnd` to the foreground, defeating the Win32 foreground lock, then VERIFY.

    A bare SetForegroundWindow from a process that does not own the foreground is a documented no-op
    (it only flashes the taskbar) or raises. We restore-if-minimized, BringWindowToTop, try
    SetForegroundWindow, and — if still not foreground — do a bounded AttachThreadInput sandwich
    (always detached in finally, never fatal). We do NOT synthesize an ALT keystroke by default
    (that would leak into whatever currently has focus / an IME). Returns (focused, foreground_hwnd)
    reflecting the REAL post-state, not merely "the call did not raise".
    """
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    except Exception:
        pass
    try:
        win32gui.BringWindowToTop(hwnd)
    except Exception:
        pass
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    if _is_foreground(hwnd):
        return True, hwnd

    # Foreground lock still in effect — attach input queues so SetForegroundWindow is honored.
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    attached_fg = attached_tgt = False
    fg_thread = tgt_thread = 0
    try:
        cur = kernel32.GetCurrentThreadId()
        fg = win32gui.GetForegroundWindow()
        if fg:
            fg_thread, _ = win32process.GetWindowThreadProcessId(fg)
        tgt_thread, _ = win32process.GetWindowThreadProcessId(hwnd)
        if fg_thread and fg_thread != cur:
            attached_fg = bool(user32.AttachThreadInput(cur, fg_thread, True))
        if tgt_thread and tgt_thread != cur and tgt_thread != fg_thread:
            attached_tgt = bool(user32.AttachThreadInput(cur, tgt_thread, True))
        win32gui.BringWindowToTop(hwnd)
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    finally:
        try:
            if attached_fg:
                user32.AttachThreadInput(cur, fg_thread, False)
            if attached_tgt:
                user32.AttachThreadInput(cur, tgt_thread, False)
        except Exception:
            pass

    for _ in range(5):
        if _is_foreground(hwnd):
            return True, hwnd
        time.sleep(0.05)
    try:
        return False, win32gui.GetForegroundWindow()
    except Exception:
        return False, 0


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
        dict with 'ok' and window info (handle, title, position, size). A focused window with an
        empty title (splash/child/mid-launch) is still reported, with title:"".
    """
    try:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return {"ok": False, "error": "No foreground window (desktop has focus)"}
        info = _get_window_info(hwnd, require_title=False)
        if info:
            info["ok"] = True
            return info
        # Not visible / off — report the raw handle rather than claiming nothing is active.
        return {"ok": True, "handle": int(hwnd), "title": win32gui.GetWindowText(hwnd) or "",
                "note": "foreground window is not in the normal visible state"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def focus_window(title: str | None = None, handle: int | None = None) -> dict:
    """Bring a window to the foreground by title or handle, and confirm it actually took focus.

    Args:
        title: Window title (partial match supported).
        handle: Window handle (takes priority over title).

    Returns:
        dict with 'ok' (the activation was attempted) plus 'focused'/'foreground_verified' reflecting
        whether the target REALLY became the foreground window — if false, do NOT type/click yet.
    """
    try:
        hwnd, matches = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}

        focused, fg = _activate(hwnd)
        out = {"ok": True, "focused": focused, "foreground_verified": focused, **(_get_window_info(hwnd, require_title=False) or {})}
        out.update(_amb(matches))
        if not focused:
            out["foreground_handle"] = int(fg) if fg else None
            out["note"] = "activation did not take (foreground lock / modal owner). The target is NOT focused — " \
                          "retry, or click its taskbar/window first."
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _unmaximize_if_needed(hwnd: int) -> None:
    """Clear maximized/minimized state so MoveWindow can actually reposition/resize the window."""
    try:
        if win32gui.IsZoomed(hwnd) or win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    except Exception:
        pass


def _rect_dict(hwnd: int) -> dict:
    r = win32gui.GetWindowRect(hwnd)
    return {"x": r[0], "y": r[1], "width": r[2] - r[0], "height": r[3] - r[1]}


@mcp.tool(audit=True)
def resize_window(
    width: int,
    height: int,
    title: str | None = None,
    handle: int | None = None,
) -> dict:
    """Resize a window, then report its ACTUAL size (a maximized window is restored first).

    Returns:
        dict with 'ok', the achieved 'width'/'height' (re-read, not echoed), and 'requested'.
    """
    try:
        hwnd, matches = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        _unmaximize_if_needed(hwnd)
        rect = win32gui.GetWindowRect(hwnd)
        win32gui.MoveWindow(hwnd, rect[0], rect[1], width, height, True)
        actual = _rect_dict(hwnd)
        out = {"ok": True, "width": actual["width"], "height": actual["height"],
               "requested": {"width": width, "height": height},
               "matched": actual["width"] == width and actual["height"] == height}
        out.update(_amb(matches))
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def move_window(
    x: int,
    y: int,
    title: str | None = None,
    handle: int | None = None,
) -> dict:
    """Move a window to a new position, then report its ACTUAL position (a maximized window is restored first).

    Returns:
        dict with 'ok', the achieved 'x'/'y' (re-read, not echoed), and 'requested'.
    """
    try:
        hwnd, matches = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        _unmaximize_if_needed(hwnd)
        rect = win32gui.GetWindowRect(hwnd)
        width = rect[2] - rect[0]
        height = rect[3] - rect[1]
        win32gui.MoveWindow(hwnd, x, y, width, height, True)
        actual = _rect_dict(hwnd)
        out = {"ok": True, "x": actual["x"], "y": actual["y"],
               "requested": {"x": x, "y": y}, "matched": actual["x"] == x and actual["y"] == y}
        out.update(_amb(matches))
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def minimize_window(title: str | None = None, handle: int | None = None) -> dict:
    """Minimize a window. Returns 'ok' and the resulting 'minimized' state."""
    try:
        hwnd, matches = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
        out = {"ok": True, "minimized": bool(win32gui.IsIconic(hwnd))}
        out.update(_amb(matches))
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def maximize_window(title: str | None = None, handle: int | None = None) -> dict:
    """Maximize a window. Returns 'ok' and the resulting 'maximized' state."""
    try:
        hwnd, matches = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
        out = {"ok": True, "maximized": bool(win32gui.IsZoomed(hwnd))}
        out.update(_amb(matches))
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def close_window(title: str | None = None, handle: int | None = None) -> dict:
    """Ask a window to close, then confirm whether it actually closed.

    A modal 'save changes?' prompt can keep the window open — this reports closed:false and
    possibly_blocked_by_dialog:true rather than falsely claiming success. It never auto-confirms a
    save dialog (that would risk data loss).

    Returns:
        dict with 'ok' (the close was requested), 'closed' (actual), and 'possibly_blocked_by_dialog'.
    """
    try:
        hwnd, matches = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
        closed = False
        for _ in range(12):  # ~1.2s
            time.sleep(0.1)
            if not win32gui.IsWindow(hwnd) or not win32gui.IsWindowVisible(hwnd):
                closed = True
                break
        blocked = False
        if not closed:
            # A dialog-class (#32770) window owned by the same process appearing suggests a save prompt.
            def _cb(h, _):
                nonlocal blocked
                try:
                    if win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == "#32770":
                        _, ppid = win32process.GetWindowThreadProcessId(h)
                        if ppid == pid:
                            blocked = True
                except Exception:
                    pass
                return True
            win32gui.EnumWindows(_cb, None)
        out = {"ok": True, "closed": closed, "possibly_blocked_by_dialog": blocked}
        if not closed:
            out["note"] = "window still open" + (" — a modal dialog (e.g. unsaved changes) is likely holding it." if blocked else ".")
        out.update(_amb(matches))
        return out
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
        hwnd, matches = _resolve(title, handle)
        if not hwnd:
            return {"ok": False, "error": f"Window not found: {title or handle}"}

        flag = win32con.HWND_TOPMOST if topmost else win32con.HWND_NOTOPMOST
        rect = win32gui.GetWindowRect(hwnd)
        ctypes.windll.user32.SetWindowPos(
            hwnd, flag, rect[0], rect[1],
            rect[2] - rect[0], rect[3] - rect[1],
            win32con.SWP_SHOWWINDOW,
        )
        out = {"ok": True, "topmost": topmost}
        out.update(_amb(matches))
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
