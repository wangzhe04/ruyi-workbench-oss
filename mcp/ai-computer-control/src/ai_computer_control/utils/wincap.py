"""Window capture core shared by `window_screenshot` (capture.py) and `screenshot(window_title=)` (screen.py).

Lives under utils/ (not tools/) on purpose: importing a tools module registers its MCP tools, and the
`desktop` toolset must not gain `window_screenshot` just because `screenshot` reuses this code.

capture_window(title_substring) finds a top-level window by case-insensitive substring, then tries
ctypes PrintWindow with PW_RENDERFULLCONTENT (works for most windows even when covered). If that fails,
times out, or yields an all-black frame (GPU-composited windows often "succeed" with a blank bitmap),
it falls back to a virtual-desktop-aware screen crop of the window's visible frame.
"""

import ctypes
import time
from ctypes import wintypes

_user32 = ctypes.windll.user32
_gdi32 = ctypes.windll.gdi32

# --- ctypes signatures (avoid 64-bit HANDLE truncation to c_int) ---------------------------------
try:
    _user32.GetWindowDC.restype = wintypes.HDC
    _user32.GetWindowDC.argtypes = [wintypes.HWND]
    _user32.ReleaseDC.restype = ctypes.c_int
    _user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    _user32.PrintWindow.restype = wintypes.BOOL
    _user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
    _user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    _user32.IsIconic.argtypes = [wintypes.HWND]
    _user32.IsWindowVisible.argtypes = [wintypes.HWND]
    _user32.GetWindowTextLengthW.restype = ctypes.c_int
    _user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]

    _gdi32.CreateCompatibleDC.restype = wintypes.HDC
    _gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    _gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    _gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    _gdi32.SelectObject.restype = wintypes.HGDIOBJ
    _gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    _gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    _gdi32.DeleteDC.argtypes = [wintypes.HDC]
    _gdi32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
                                 ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
except Exception:
    pass

PW_RENDERFULLCONTENT = 2
_BI_RGB = 0
_DIB_RGB_COLORS = 0


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
    ]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", _BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def _enum_matches(title_sub: str) -> list:
    """[(hwnd, title)] of every visible, titled top-level window whose title contains the substring
    (case-insensitive), in Z-order."""
    target = title_sub.lower()
    found = []
    EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _):
        if not _user32.IsWindowVisible(hwnd):
            return True
        n = _user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        _user32.GetWindowTextW(hwnd, buf, n + 1)
        if target in buf.value.lower():
            found.append((hwnd, buf.value))
        return True

    _user32.EnumWindows(EnumProc(_cb), 0)
    return found


def _pick_window(title_sub: str, matches: list):
    """Choose among substring `matches`: an exact (case-insensitive, trimmed) title wins, else the only
    match. Returns (chosen (hwnd, title) | None, ambiguous matches list — non-empty only when several
    windows match and none is an exact title)."""
    if not matches:
        return None, []
    want = title_sub.strip().lower()
    for m in matches:
        if m[1].strip().lower() == want:
            return m, []
    if len(matches) == 1:
        return matches[0], []
    return None, matches


def _find_hwnd(title_sub: str):
    """Return (hwnd, matched_title): the exact-title window if there is one, else the first visible
    top-level window containing the substring (Z-order)."""
    matches = _enum_matches(title_sub)
    chosen, _amb = _pick_window(title_sub, matches)
    if chosen:
        return chosen
    if matches:
        return matches[0]
    return None, None


def _printwindow_to_pil(hwnd, width, height):
    """Capture a window via PrintWindow into a PIL image, or return None on failure."""
    from PIL import Image
    hdc_win = _user32.GetWindowDC(hwnd)
    if not hdc_win:
        return None
    mem_dc = _gdi32.CreateCompatibleDC(hdc_win)
    bmp = _gdi32.CreateCompatibleBitmap(hdc_win, width, height)
    if not mem_dc or not bmp:
        if bmp:
            _gdi32.DeleteObject(bmp)
        if mem_dc:
            _gdi32.DeleteDC(mem_dc)
        _user32.ReleaseDC(hwnd, hdc_win)
        return None
    old = _gdi32.SelectObject(mem_dc, bmp)
    try:
        ok = _user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)
        if not ok:
            # Some windows only respond to flags=0.
            ok = _user32.PrintWindow(hwnd, mem_dc, 0)
        if not ok:
            return None
        bmi = _BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = width
        bmi.bmiHeader.biHeight = -height  # top-down
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = _BI_RGB
        buf_len = width * height * 4
        buffer = (ctypes.c_char * buf_len)()
        got = _gdi32.GetDIBits(mem_dc, bmp, 0, height, buffer, ctypes.byref(bmi), _DIB_RGB_COLORS)
        if got == 0:
            return None
        img = Image.frombuffer("RGB", (width, height), bytes(buffer), "raw", "BGRX", 0, 1)
        return img
    finally:
        _gdi32.SelectObject(mem_dc, old)
        _gdi32.DeleteObject(bmp)
        _gdi32.DeleteDC(mem_dc)
        _user32.ReleaseDC(hwnd, hdc_win)


# --- small Win32 probes (module-level so tests can replace them) ----------------------------------

def _is_minimized(hwnd) -> bool:
    try:
        return bool(_user32.IsIconic(hwnd))
    except Exception:
        return False


def _restore(hwnd) -> None:
    try:
        _user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(0.2)
    except Exception:
        pass


def _bring_foreground(hwnd) -> None:
    try:
        _user32.SetForegroundWindow(hwnd)
        time.sleep(0.15)
    except Exception:
        pass


def _window_rect(hwnd):
    """(left, top, right, bottom) from GetWindowRect (includes the invisible resize frame on Win10/11)."""
    rect = wintypes.RECT()
    _user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect.left, rect.top, rect.right, rect.bottom


def _frame_rect(hwnd, fallback):
    """Visible frame via DWMWA_EXTENDED_FRAME_BOUNDS (excludes the ~7px invisible resize border).

    Used only for the screen-crop fallback; PrintWindow bitmaps are window-rect sized. Falls back to
    `fallback` (the GetWindowRect tuple) when DWM is unavailable."""
    try:
        dwm = ctypes.windll.dwmapi
        dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        r = wintypes.RECT()
        hr = dwm.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r))  # DWMWA_EXTENDED_FRAME_BOUNDS
        if hr == 0 and r.right > r.left and r.bottom > r.top:
            return int(r.left), int(r.top), int(r.right), int(r.bottom)
    except Exception:
        pass
    return fallback


def _printwindow_bounded(hwnd, width, height):
    """PrintWindow in a daemon thread with a hard 5s cap; returns a PIL image or None.

    PrintWindow sends a render message to the target window's message pump; a hung/crashed app or a
    suspended UWP never answers, blocking the (sync) call indefinitely and hanging the whole ACC
    event loop. Run it in a bounded daemon thread and fall through to the screen-crop fallback on
    timeout instead of waiting for the 120s bridge kill."""
    try:
        import threading
        holder: dict = {}
        def _cap():
            try:
                holder["img"] = _printwindow_to_pil(hwnd, width, height)
            except Exception as e:  # noqa: BLE001
                holder["err"] = e
        t = threading.Thread(target=_cap, daemon=True)
        t.start()
        t.join(timeout=5)
        if t.is_alive() or "img" not in holder:
            return None
        return holder["img"]
    except Exception:
        return None


def capture_window(title_substring: str, restore_minimized: bool = True, disambiguate: bool = False) -> dict:
    """Capture one window by title: an exact (case-insensitive) title wins, else a substring match.

    With `disambiguate=True` (screenshot(window_title=)) several substring matches and no exact title is an
    error listing `candidates` ({handle, title}) instead of capturing whichever is topmost.

    Order: PrintWindow (works while occluded) -> if it fails / times out / returns an all-black frame,
    bring the window forward and crop the virtual desktop (`occluded_possible` then flags that other
    windows may cover it). A minimized window is restored first (`restored: True`) or, with
    restore_minimized=False, reported as `minimized: True` + hint instead of returning a black image.

    Returns {ok: False, error, ...} or {ok: True, img: PIL.Image, matched_title, method, origin:{x,y},
    window_rect:{left,top,width,height}, [restored], [occluded_possible], [printwindow_blank],
    [blank/warning/hint]}. `origin` is the virtual-screen coordinate of img's top-left pixel.
    """
    from ai_computer_control.utils.image import (
        BLANK_FRAME_HINT, BLANK_FRAME_WARNING, grab_screen, is_blank_frame)

    if disambiguate:
        chosen, amb = _pick_window(title_substring, _enum_matches(title_substring))
        if amb:
            return {"ok": False, "ambiguous": True, "matched_count": len(amb),
                    "candidates": [{"handle": int(h), "title": t} for h, t in amb[:10]],
                    "error": f"{len(amb)} windows match '{title_substring}' and none has exactly that title",
                    "hint": "Retry with the full exact title of one of the candidates."}
        hwnd, matched = chosen if chosen else (None, None)
    else:
        hwnd, matched = _find_hwnd(title_substring)
    if not hwnd:
        return {"ok": False, "found": False, "error": f"no visible window matches '{title_substring}'"}

    restored = False
    if _is_minimized(hwnd):
        if not restore_minimized:
            return {"ok": False, "minimized": True, "matched_title": matched,
                    "error": f"window '{matched}' is minimized, so it has no capturable content",
                    "hint": "Restore it first (focus_window restores a minimized window) or call "
                            "window_screenshot, which restores minimized windows automatically."}
        _restore(hwnd)
        restored = True

    left, top, right, bottom = _window_rect(hwnd)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        return {"ok": False, "error": "window has zero size", "matched_title": matched}

    img = _printwindow_bounded(hwnd, width, height)
    method = "printwindow"
    origin = {"x": left, "y": top}
    printwindow_blank = False
    if img is not None and is_blank_frame(img):
        # PrintWindow "succeeded" but drew nothing (GPU-composited Chromium/Electron/UWP).
        printwindow_blank = True
        img = None

    out_extra: dict = {}
    if img is None:
        method = "screen_crop"
        _bring_foreground(hwnd)
        fl, ft, fr, fb = _frame_rect(hwnd, (left, top, right, bottom))
        try:
            img, info = grab_screen(region=(fl, ft, fr - fl, fb - ft))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"capture failed: {e}", "matched_title": matched}
        origin = info["origin"]
        out_extra["occluded_possible"] = True
        if info.get("clipped"):
            out_extra["clipped"] = True

    out = {"ok": True, "img": img, "matched_title": matched, "method": method, "origin": origin,
           "window_rect": {"left": left, "top": top, "width": width, "height": height}}
    out.update(out_extra)
    if restored:
        out["restored"] = True
    if printwindow_blank:
        out["printwindow_blank"] = True
    if is_blank_frame(img):
        out["blank"] = True
        out["warning"] = BLANK_FRAME_WARNING
        out["hint"] = BLANK_FRAME_HINT
    return out
