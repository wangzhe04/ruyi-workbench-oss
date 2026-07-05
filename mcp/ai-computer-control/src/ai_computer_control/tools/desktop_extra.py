"""Extra desktop helpers implemented with ctypes + pyautogui + PIL (no pywin32 dependency).

Covers: DPI awareness (set once at import so coordinates are consistent), pixel sampling, clipboard
image read, monitor enumeration, and wait-for-window / wait-for-window-idle primitives.
"""

import base64
import ctypes
import io
import os
import time
from ctypes import wintypes

from ai_computer_control.server import mcp

_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32

# Declare signatures so 64-bit HANDLEs aren't truncated to 32-bit ints (default ctypes restype=c_int).
try:
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _user32.WaitForInputIdle.restype = wintypes.DWORD
    _user32.WaitForInputIdle.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _user32.GetWindowTextLengthW.restype = ctypes.c_int
    _user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
except Exception:
    pass


def _set_dpi_awareness() -> str:
    # Per-Monitor-Aware v2 (-4) is best; fall back to older modes. Idempotent/no-op if already set.
    try:
        fn = _user32.SetProcessDpiAwarenessContext
        fn.restype = wintypes.BOOL
        fn.argtypes = [ctypes.c_void_p]
        if fn(ctypes.c_void_p(-4)):
            return "per-monitor-v2"
    except Exception:
        pass
    try:
        if ctypes.windll.shcore.SetProcessDpiAwareness(2) == 0:
            return "per-monitor"
    except Exception:
        pass
    try:
        if _user32.SetProcessDPIAware():
            return "system"
    except Exception:
        pass
    return "unset"


_DPI_MODE = _set_dpi_awareness()


@mcp.tool()
def get_dpi_info() -> dict:
    """Return the process DPI-awareness mode and the primary monitor's scale factor."""
    scale = None
    try:
        dpi = _user32.GetDpiForSystem()
        scale = round(dpi / 96.0, 3)
    except Exception:
        pass
    return {"awareness": _DPI_MODE, "primary_scale": scale}


@mcp.tool()
def get_pixel_color(x: int, y: int) -> dict:
    """Get the RGB color of the screen pixel at (x, y).

    Returns dict with 'rgb' [r,g,b] and 'hex'.
    """
    try:
        import pyautogui
        r, g, b = pyautogui.pixel(int(x), int(y))
        return {"success": True, "x": x, "y": y, "rgb": [r, g, b], "hex": f"#{r:02x}{g:02x}{b:02x}"}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


@mcp.tool()
def get_clipboard_image(save_path: str | None = None) -> dict:
    """Read an image currently on the clipboard (e.g. a screenshot the user copied).

    Args:
        save_path: Optional PNG path to save to. If omitted, a base64 PNG is returned.

    Returns:
        dict with 'has_image', and either 'path'+size or 'image_base64', or 'files' if the clipboard
        holds file paths instead of a bitmap.
    """
    try:
        from PIL import ImageGrab
        data = ImageGrab.grabclipboard()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
    if data is None:
        return {"has_image": False}
    if isinstance(data, list):
        return {"has_image": False, "files": [str(p) for p in data]}
    # data is a PIL Image
    width, height = data.size
    if save_path:
        data.save(save_path, "PNG")
        # v1.5.1: 补 output_path(== path)供产物收割。
        return {"has_image": True, "path": os.path.abspath(save_path), "output_path": os.path.abspath(save_path), "width": width, "height": height}
    buf = io.BytesIO()
    data.save(buf, "PNG")
    return {"has_image": True, "width": width, "height": height,
            "image_base64": base64.b64encode(buf.getvalue()).decode("ascii")}


@mcp.tool(audit=True)
def set_clipboard_image(path: str) -> dict:
    """Put an image file onto the clipboard (so it can be pasted into other apps)."""
    import subprocess
    if not os.path.exists(path):
        return {"error": f"file not found: {path}"}
    # Pass the path out-of-band via env (no string interpolation) to avoid PowerShell injection and
    # to handle paths containing quotes/apostrophes.
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
        "$img=[System.Drawing.Image]::FromFile($env:WCW_CLIP_IMG); "
        "[System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()"
    )
    try:
        env = dict(os.environ, WCW_CLIP_IMG=os.path.abspath(path))
        r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps],
                           capture_output=True, text=True, timeout=15, env=env)
        if r.returncode != 0:
            return {"error": (r.stderr or "powershell failed").strip()}
        return {"success": True, "path": os.path.abspath(path)}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


@mcp.tool()
def list_monitors() -> dict:
    """Enumerate physical monitors with their pixel bounds and which is primary."""
    monitors = []
    MonitorEnumProc = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM
    )

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    def _cb(hmon, hdc, lprc, lparam):
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if _user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            r = mi.rcMonitor
            monitors.append({
                "index": len(monitors),
                "left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom,
                "width": r.right - r.left, "height": r.bottom - r.top,
                "primary": bool(mi.dwFlags & 1),
            })
        return True

    try:
        _user32.EnumDisplayMonitors(0, 0, MonitorEnumProc(_cb), 0)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
    return {"count": len(monitors), "monitors": monitors}


def _enum_windows():
    out = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, lparam):
        if not _user32.IsWindowVisible(hwnd):
            return True
        n = _user32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        _user32.GetWindowTextW(hwnd, buf, n + 1)
        out.append((hwnd, buf.value))
        return True

    _user32.EnumWindows(EnumWindowsProc(_cb), 0)
    return out


def _window_rect(hwnd) -> dict:
    r = wintypes.RECT()
    _user32.GetWindowRect(hwnd, ctypes.byref(r))
    return {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom,
            "width": r.right - r.left, "height": r.bottom - r.top}


@mcp.tool()
def wait_for_window(title: str, timeout: float = 10.0, poll_ms: int = 250, exact: bool = False) -> dict:
    """Wait until a top-level window whose title matches `title` appears.

    Args:
        title: Substring (default) or exact title (exact=True), case-insensitive.
        timeout: Max seconds to wait (wall-clock bounded).
        poll_ms: Poll interval in ms.
        exact: Require an exact (case-insensitive) title match.

    Returns:
        dict with 'found', and on success 'hwnd', 'title', 'rect'.
    """
    target = title.lower()
    deadline = time.monotonic() + max(0.0, float(timeout))
    while True:
        for hwnd, wtitle in _enum_windows():
            wl = wtitle.lower()
            if (wl == target) if exact else (target in wl):
                return {"found": True, "hwnd": int(hwnd), "title": wtitle, "rect": _window_rect(hwnd)}
        if time.monotonic() >= deadline:
            return {"found": False, "title": title, "timeout": timeout}
        time.sleep(poll_ms / 1000.0)


@mcp.tool()
def wait_for_window_idle(pid: int, timeout_ms: int = 5000) -> dict:
    """Wait until a process's UI message queue is idle (WaitForInputIdle).

    Useful right after launching an app before driving its UI. Returns dict with 'state'
    (idle | timeout | error).
    """
    PROCESS_QUERY_INFORMATION = 0x0400
    SYNCHRONIZE = 0x00100000
    h = _kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | SYNCHRONIZE, False, int(pid))
    if not h:
        return {"state": "error", "error": f"OpenProcess failed for pid {pid}"}
    try:
        res = _user32.WaitForInputIdle(h, int(timeout_ms))
    finally:
        _kernel32.CloseHandle(h)
    if res == 0:
        return {"state": "idle"}
    if res == 0x102:
        return {"state": "timeout"}
    return {"state": "error", "code": res}
