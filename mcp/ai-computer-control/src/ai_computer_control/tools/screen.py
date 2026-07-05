"""Screen capture and display information tools."""

import ctypes
import pyautogui

from ai_computer_control.server import mcp
from ai_computer_control.utils.image import encode_with_budget


@mcp.tool()
def screenshot(
    region: str | None = None,
    window_title: str | None = None,
    max_width: int = 0,
    format: str = "png",
    quality: int = 80,
) -> dict:
    """Take a screenshot of the entire screen, a specific region, or a specific window.

    Args:
        region: Optional region as "x,y,width,height" (e.g. "100,200,800,600").
        window_title: Optional window title to capture a specific window.
        max_width: If >0, proportionally downscale the returned image to this pixel width to save
            tokens; 0 = original size. The returned 'scale' (<1.0 when downscaled) maps a point in
            the returned image back to physical pixels (x_screen = x_in_image / scale).
        format: 'png' (lossless, default) or 'jpeg' (smaller; uses 'quality').
        quality: JPEG quality 1-100 (ignored for PNG).

    Returns:
        dict with 'ok', 'image' (base64), 'width', 'height', 'scale', 'format'.
    """
    try:
        if window_title:
            import win32gui

            hwnd = win32gui.FindWindow(None, window_title)
            if not hwnd:
                return {"ok": False, "error": f"Window not found: {window_title}"}

            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            width = right - left
            height = bottom - top
            img = pyautogui.screenshot(region=(left, top, width, height))
        elif region:
            try:
                parts = [int(x.strip()) for x in region.split(",")]
            except ValueError:
                return {"ok": False, "error": "Region must be 'x,y,width,height' with integers"}
            if len(parts) != 4:
                return {"ok": False, "error": "Region must be 'x,y,width,height'"}
            if parts[2] <= 0 or parts[3] <= 0:
                return {"ok": False, "error": "Region width and height must be positive"}
            img = pyautogui.screenshot(region=tuple(parts))
        else:
            img = pyautogui.screenshot()

        enc = encode_with_budget(img, max_width=max_width, fmt=format, quality=quality)
        return {"ok": True, **enc}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool()
def screenshot_region(x: int, y: int, width: int, height: int,
                      max_width: int = 0, format: str = "png", quality: int = 80) -> dict:
    """Take a screenshot of a specific rectangular region.

    Args:
        x: Left coordinate.
        y: Top coordinate.
        width: Width of the region.
        height: Height of the region.
        max_width: If >0, proportionally downscale the returned image to this width (0 = original).
        format: 'png' (default) or 'jpeg'.
        quality: JPEG quality 1-100 (ignored for PNG).

    Returns:
        dict with 'ok', 'image' (base64), 'width', 'height', 'scale', 'format'.
    """
    try:
        if width <= 0 or height <= 0:
            return {"ok": False, "error": "width and height must be positive"}
        img = pyautogui.screenshot(region=(x, y, width, height))
        enc = encode_with_budget(img, max_width=max_width, fmt=format, quality=quality)
        return {"ok": True, **enc}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool()
def get_screen_info() -> dict:
    """Get information about screen resolution, DPI, and multi-monitor setup.

    Returns:
        dict with 'ok', 'primary' (width, height, dpi) and 'monitors' list.
    """
    try:
        user32 = ctypes.windll.user32
        # DPI awareness is process-wide and first-setter-wins; pyautogui (imported earlier) usually
        # sets it first, so this call is a best-effort no-op for standalone use. Query get_dpi_info()
        # for the TRUE current awareness.
        user32.SetProcessDPIAware()

        primary_width = user32.GetSystemMetrics(0)
        primary_height = user32.GetSystemMetrics(1)

        # Scale factor: GetScaleFactorForDevice returns a percentage (e.g. 150 == 150%). Report both a
        # true LOGPIXELS 'dpi' and a 'scale' float so callers don't confuse the two.
        scale = None
        try:
            pct = ctypes.windll.shcore.GetScaleFactorForDevice(0)
            scale = round(pct / 100.0, 3)
        except Exception:
            pass
        try:
            dc = ctypes.windll.user32.GetDC(0)
            dpi = ctypes.windll.gdi32.GetDeviceCaps(dc, 88)  # LOGPIXELSX
            ctypes.windll.user32.ReleaseDC(0, dc)
        except Exception:
            dpi = int(round((scale or 1.0) * 96))
        if scale is None:
            scale = round(dpi / 96.0, 3)

        # Multi-monitor info
        monitors = []
        try:
            import win32api
            for i, monitor in enumerate(win32api.EnumDisplayMonitors()):
                info = win32api.GetMonitorInfo(monitor[0])
                rect = info["Monitor"]
                monitors.append({
                    "index": i,
                    "x": rect[0],
                    "y": rect[1],
                    "width": rect[2] - rect[0],
                    "height": rect[3] - rect[1],
                    "is_primary": info["Flags"] == 1,
                })
        except Exception:
            monitors.append({
                "index": 0,
                "x": 0,
                "y": 0,
                "width": primary_width,
                "height": primary_height,
                "is_primary": True,
            })

        # Virtual desktop bounds (all monitors combined) — the coordinate space clicks live in.
        virtual = {
            "x": user32.GetSystemMetrics(76), "y": user32.GetSystemMetrics(77),
            "width": user32.GetSystemMetrics(78), "height": user32.GetSystemMetrics(79),
        }

        return {
            "ok": True,
            "primary": {
                "width": primary_width,
                "height": primary_height,
                "dpi": dpi,
                "scale": scale,
            },
            "virtual": virtual,
            "monitors": monitors,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool()
def find_on_screen(
    template_path: str,
    confidence: float = 0.8,
) -> dict:
    """Find an image template on the screen using template matching.

    Note: confidence matching requires OpenCV; without it, matching falls back to exact-pixel search.

    Args:
        template_path: Path to the template image file to search for.
        confidence: Matching confidence threshold (0.0-1.0, default 0.8).

    Returns:
        dict with 'ok', 'found' bool, and if found: 'x', 'y', 'width', 'height' of the match center.
    """
    try:
        try:
            location = pyautogui.locateOnScreen(template_path, confidence=confidence)
        except (NotImplementedError, ValueError):
            # OpenCV missing -> confidence unsupported; retry exact match.
            location = pyautogui.locateOnScreen(template_path)
        if location:
            center = pyautogui.center(location)
            return {
                "ok": True,
                "found": True,
                "x": center.x,
                "y": center.y,
                "width": location.width,
                "height": location.height,
                "region": {
                    "left": location.left,
                    "top": location.top,
                    "width": location.width,
                    "height": location.height,
                },
            }
        return {"ok": True, "found": False}
    except pyautogui.ImageNotFoundException:
        return {"ok": True, "found": False}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
