"""Screen capture and display information tools."""

import ctypes
import pyautogui

from ai_computer_control.server import mcp
from ai_computer_control.utils.image import capture_fields, encode_with_budget, grab_screen


@mcp.tool()
def screenshot(
    region: str | None = None,
    window_title: str | None = None,
    max_width: int = 1280,
    format: str = "png",
    quality: int = 80,
    monitor: str | None = None,
) -> dict:
    """Take a screenshot of the primary screen, a region, a monitor, or a specific window.

    Coordinates are VIRTUAL-SCREEN coordinates (as for clicks, UIA, OCR; monitors left of / above the primary are
    negative). A region wholly outside the desktop is an error; partly outside is clipped ('clipped': true).

    Args:
        region: Optional "x,y,width,height" (e.g. "100,200,800,600"); may lie on any monitor.
        window_title: Capture this window (exact title, else a unique substring; ambiguous -> candidates) via PrintWindow, so a covered window works;
            falls back to a screen crop ('occluded_possible': true) if it renders blank. Minimized -> error with a
            hint (window_screenshot auto-restores).
        max_width: If >0, downscale to this width; 0 = original. x_screen = origin.x + x_in_image / scale.
        format: 'png' (default) or 'jpeg' (smaller; uses 'quality').
        quality: JPEG quality 1-100 (ignored for PNG).
        monitor: 'all' (whole virtual desktop) or an index from list_monitors. Default: primary only. Ignored when
            region or window_title is given.

    Returns:
        dict with 'ok', 'image' (base64), 'width', 'height', 'scale', 'format', 'origin' {x,y}; for a window also
        'matched_title' and 'method'. 'blank': true + 'warning'/'hint' = completely black frame (do not trust it as
        "the screen is empty").
    """
    try:
        if window_title:
            from ai_computer_control.utils import wincap

            cap = wincap.capture_window(window_title, restore_minimized=False, disambiguate=True)
            if not cap.get("ok"):
                if cap.get("found") is False:
                    cap["error"] = f"Window not found: {window_title}"
                return cap
            img = cap.pop("img")
            enc = encode_with_budget(img, max_width=max_width, fmt=format, quality=quality)
            cap.pop("window_rect", None)
            return {"ok": True, **enc, **cap}
        elif region:
            try:
                parts = [int(x.strip()) for x in region.split(",")]
            except ValueError:
                return {"ok": False, "error": "Region must be 'x,y,width,height' with integers"}
            if len(parts) != 4:
                return {"ok": False, "error": "Region must be 'x,y,width,height'"}
            if parts[2] <= 0 or parts[3] <= 0:
                return {"ok": False, "error": "Region width and height must be positive"}
            img, info = grab_screen(region=tuple(parts))
        else:
            img, info = grab_screen(monitor=monitor)
        enc = encode_with_budget(img, max_width=max_width, fmt=format, quality=quality)
        return {"ok": True, **enc, **capture_fields(img, info)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool()
def screenshot_region(x: int, y: int, width: int, height: int,
                      max_width: int = 1280, format: str = "png", quality: int = 80) -> dict:
    """Take a screenshot of a rectangular region (virtual-screen coordinates, any monitor).

    Args:
        x: Left coordinate (negative on a monitor left of the primary).
        y: Top coordinate.
        width: Region width.
        height: Region height.
        max_width: If >0, downscale to this width (0 = original). Map an image point to screen:
            x_screen = origin.x + x_in_image / scale.
        format: 'png' (default) or 'jpeg'.
        quality: JPEG quality 1-100 (ignored for PNG).

    Returns:
        dict with 'ok', 'image' (base64), 'width', 'height', 'scale', 'format', 'origin' {x,y} (+ 'clipped' /
        'blank' + 'warning'). A region wholly outside the virtual desktop is an error.
    """
    try:
        if width <= 0 or height <= 0:
            return {"ok": False, "error": "width and height must be positive"}
        img, info = grab_screen(region=(x, y, width, height))
        enc = encode_with_budget(img, max_width=max_width, fmt=format, quality=quality)
        return {"ok": True, **enc, **capture_fields(img, info)}
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

    Note: confidence matching requires OpenCV; without it, matching falls back to exact-pixel search
    (the result then carries 'matched_exact_only': true and a 'note' - the confidence threshold was
    NOT applied, so a scaled/anti-aliased icon will read as not found; use find_template/vision_click).

    Args:
        template_path: Path to the template image file to search for.
        confidence: Matching confidence threshold (0.0-1.0, default 0.8).

    Returns:
        dict with 'ok', 'found' bool, and if found: 'x', 'y', 'width', 'height' of the match center.
    """
    exact_note: dict = {}
    try:
        try:
            location = pyautogui.locateOnScreen(template_path, confidence=confidence)
        except (NotImplementedError, ValueError):
            # OpenCV missing -> confidence unsupported; retry exact match.
            exact_note = {"matched_exact_only": True,
                          "note": "OpenCV is unavailable, so the confidence threshold was ignored and only an "
                                  "exact pixel match was searched; a scaled or anti-aliased template will not match."}
            location = pyautogui.locateOnScreen(template_path)
        if location:
            center = pyautogui.center(location)
            return {
                **exact_note,
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
        return {"ok": True, "found": False, **exact_note}
    except pyautogui.ImageNotFoundException:
        return {"ok": True, "found": False, **exact_note}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
