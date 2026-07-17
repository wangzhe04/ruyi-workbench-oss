"""Per-window screenshot via PrintWindow (captures occluded/background windows), PIL fallback.

`window_screenshot(title_substring)` finds a top-level window by case-insensitive substring, then
tries ctypes PrintWindow with PW_RENDERFULLCONTENT (works for most windows even when covered). If
that fails or yields an empty frame, it falls back to GetWindowRect + a full-screen crop.
"""

import ctypes
import os
import time
from ctypes import wintypes

from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason

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


def _find_hwnd(title_sub: str):
    """Return (hwnd, matched_title) for the first visible top-level window matching the substring."""
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
            return False
        return True

    _user32.EnumWindows(EnumProc(_cb), 0)
    if found:
        return found[0]
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


@mcp.tool(audit=True)
def window_screenshot(title_substring: str, output_path: str | None = None,
                      max_width: int = 0, format: str = "png", quality: int = 80,
                      allow_protected: bool = False) -> dict:
    """Screenshot a specific window by (case-insensitive) title substring.

    Tries PrintWindow (captures even background/occluded windows); falls back to cropping the
    full-screen grab to the window rect. Restores the window first if minimized.

    Args:
        title_substring: Part of the target window's title.
        output_path: Optional path to write. If omitted, returns base64 (image_base64).
        max_width: If >0, proportionally downscale the returned base64 image to this width (0 =
            original). Ignored when output_path is given (the saved file is always full-resolution
            PNG). Returned 'scale' (<1.0 when downscaled) maps a point in the base64 image back to
            the window's pixels.
        format: 'png' (default) or 'jpeg' for the returned base64 (ignored when saving to a path).
        quality: JPEG quality 1-100 (ignored for PNG / when saving to a path).
        allow_protected: Override the protected-system-root guard on output_path (default off).

    Returns:
        dict with ok, matched_title, width, height, scale, and either 'path' or 'image_base64'.
    """
    try:
        from PIL import ImageGrab
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"PIL not available: {e}"}

    hwnd, matched = _find_hwnd(title_substring)
    if not hwnd:
        return {"ok": False, "found": False, "error": f"no visible window matches '{title_substring}'"}

    # Restore if minimized so we can capture real content.
    try:
        if _user32.IsIconic(hwnd):
            _user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.2)
    except Exception:
        pass

    rect = wintypes.RECT()
    _user32.GetWindowRect(hwnd, ctypes.byref(rect))
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        return {"ok": False, "error": "window has zero size", "matched_title": matched}

    img = None
    method = "printwindow"
    try:
        img = _printwindow_to_pil(hwnd, width, height)
    except Exception:
        img = None

    if img is None:
        # Fallback: bring forward and crop the desktop grab.
        method = "screen_crop"
        try:
            _user32.SetForegroundWindow(hwnd)
            time.sleep(0.15)
        except Exception:
            pass
        try:
            full = ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom))
            img = full
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"capture failed: {e}", "matched_title": matched}

    out = {"ok": True, "matched_title": matched, "width": img.width, "height": img.height,
           "method": method, "scale": 1.0}
    if output_path:
        # Same protected-destination guard as the write_file family — a screenshot output path is
        # a file write and must not bypass it just because it arrives via a capture tool.
        reason = protected_path_reason(output_path)
        if reason and not allow_protected:
            return {"ok": False, "matched_title": matched,
                    "error": f"refused to write: destination {reason}. Pass allow_protected=true to override."}
        try:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            img.save(output_path, "PNG")
            out["path"] = os.path.abspath(output_path)
            out["output_path"] = os.path.abspath(output_path)  # v1.5.1: 产物收割键(与 path 同值)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"could not save: {e}", "matched_title": matched}
    else:
        from ai_computer_control.utils.image import encode_with_budget
        enc = encode_with_budget(img, max_width=max_width, fmt=format, quality=quality)
        out["image_base64"] = enc["image"]
        out["width"] = enc["width"]
        out["height"] = enc["height"]
        out["scale"] = enc["scale"]
        out["format"] = enc["format"]
    return out
