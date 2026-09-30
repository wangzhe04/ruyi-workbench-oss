"""Virtual-desktop geometry shared by the pointer tools.

`get_screen_info` advertises the virtual desktop (all monitors combined, origin may be negative)
as "the coordinate space clicks live in", so every pointer bound check must use the same rect
instead of the primary screen (`pyautogui.size()`), which rejected every secondary-monitor target.
"""

# GetSystemMetrics indexes for the virtual screen.
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 76, 77, 78, 79


def _default_metric():
    import ctypes
    return ctypes.windll.user32.GetSystemMetrics


def virtual_desktop_bounds(get_metric=None, primary_size=None) -> tuple[int, int, int, int]:
    """(x, y, width, height) of the whole virtual desktop.

    `get_metric` is GetSystemMetrics (injectable for tests). If the metrics are unusable (non-Windows,
    zero size) fall back to the primary screen at the origin (`primary_size()` -> (w, h)).
    """
    try:
        gm = get_metric or _default_metric()
        x, y = int(gm(SM_XVIRTUALSCREEN)), int(gm(SM_YVIRTUALSCREEN))
        w, h = int(gm(SM_CXVIRTUALSCREEN)), int(gm(SM_CYVIRTUALSCREEN))
        if w > 0 and h > 0:
            return x, y, w, h
    except Exception:
        pass
    try:
        if primary_size is None:
            import pyautogui
            primary_size = pyautogui.size
        w, h = primary_size()
        return 0, 0, int(w), int(h)
    except Exception:
        return 0, 0, 100000, 100000


def point_in_bounds(x, y, bounds) -> bool:
    bx, by, bw, bh = bounds
    return bx <= int(x) < bx + bw and by <= int(y) < by + bh


def outside_error(what: str, x, y, bounds) -> dict:
    """The refusal dict for a pointer target outside the virtual desktop."""
    bx, by, bw, bh = bounds
    return {"ok": False,
            "error": (f"{what} target ({x},{y}) is outside the virtual desktop "
                      f"(x {bx}..{bx + bw - 1}, y {by}..{by + bh - 1}); refusing to act off-screen. "
                      f"Check the coordinates against get_screen_info 'virtual' "
                      f"(a secondary display can have negative coordinates)."),
            "virtual_desktop": {"x": bx, "y": by, "width": bw, "height": bh}}
