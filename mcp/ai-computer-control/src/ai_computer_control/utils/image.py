"""Image encoding utilities."""

import base64
import io
from PIL import Image


def pil_to_base64(image: Image.Image, format: str = "PNG", quality: int = 85) -> str:
    """Convert a PIL Image to a base64-encoded string."""
    buffer = io.BytesIO()
    if format.upper() == "JPEG":
        image = image.convert("RGB")
        image.save(buffer, format=format, quality=quality)
    else:
        image.save(buffer, format=format)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def encode_with_budget(image: Image.Image, max_width: int = 0, fmt: str = "png",
                       quality: int = 80) -> dict:
    """Encode a PIL image under a size budget, returning payload + the scale that was applied.

    Downscaling is what shrinks the base64 an agent must read; the returned `scale` lets a caller
    map a coordinate found in the *scaled* image back to physical pixels of the CAPTURED area:
    x_screen = origin_x + x_img / scale, where origin_x is the capture origin (left edge of the
    captured area in virtual-screen coordinates; 0 for a full primary-screen capture). Region /
    window captures report that origin as `origin:{x,y}` next to this dict.

    IMPORTANT coordinate contract: `scale` describes the RETURNED IMAGE only. Any rect/center this
    server reports elsewhere (observe's uia_elements/ocr_words, ocr_find_text, ui_find …) is always
    in UNSCALED physical screen coordinates and is directly clickable — it is NOT multiplied by scale.

    Args:
        image: source PIL image (physical pixels).
        max_width: if >0 and narrower than the image, the image is proportionally resized to this
            width; 0 keeps the original size (scale=1.0).
        fmt: 'png' (lossless) or 'jpeg' (uses `quality`).
        quality: JPEG quality 1-100 (ignored for PNG).

    Returns:
        dict with 'image' (base64), 'width'/'height' (of the returned image), 'scale'
        (returned_width / original_width; <1.0 means downscaled), and 'format'.
    """
    fmt = (fmt or "png").lower()
    orig_w, orig_h = image.width, image.height
    scale = 1.0
    out_img = image
    try:
        mw = int(max_width or 0)
    except Exception:
        mw = 0
    if mw > 0 and orig_w > 0 and mw < orig_w:
        scale = mw / float(orig_w)
        new_h = max(1, int(round(orig_h * scale)))
        out_img = image.resize((mw, new_h), Image.LANCZOS)
    pil_fmt = "JPEG" if fmt in ("jpeg", "jpg") else "PNG"
    buffer = io.BytesIO()
    if pil_fmt == "JPEG":
        rgb = out_img.convert("RGB")
        rgb.save(buffer, format="JPEG", quality=max(1, min(100, int(quality))))
    else:
        out_img.save(buffer, format="PNG")
    return {
        "image": base64.b64encode(buffer.getvalue()).decode("utf-8"),
        "width": out_img.width,
        "height": out_img.height,
        "scale": round(scale, 4),
        "format": "jpeg" if pil_fmt == "JPEG" else "png",
    }


# --- screen capture (virtual desktop aware) -------------------------------------------------------
#
# Every capture used to go through pyautogui.screenshot(region=...) / ImageGrab.grab(bbox=...), which on
# Windows only sees the PRIMARY monitor: a region on a second display was cropped out of nothing and
# came back as a silent all-black image with ok:true. grab_screen() is the one place that knows about
# the virtual desktop (GetSystemMetrics 76..79: origin can be negative), validates the region against it,
# and reports the capture origin so the caller can map image pixels back to screen coordinates.


def _sys_metric(index: int):
    """GetSystemMetrics(index) as a real int, or None when unavailable (non-Windows / stubbed ctypes)."""
    try:
        import ctypes
        v = ctypes.windll.user32.GetSystemMetrics(index)
    except Exception:
        return None
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def virtual_screen_rect():
    """(left, top, width, height) of the whole virtual desktop, or None when it cannot be determined."""
    left, top, w, h = (_sys_metric(i) for i in (76, 77, 78, 79))
    if None in (left, top, w, h) or w <= 0 or h <= 0:
        return None
    return left, top, w, h


def primary_screen_size():
    """(width, height) of the primary monitor (its origin is always 0,0), or None."""
    w, h = _sys_metric(0), _sys_metric(1)
    if w is None or h is None or w <= 0 or h <= 0:
        return None
    return w, h


def monitor_rects():
    """[(left, top, width, height)] per monitor in EnumDisplayMonitors order (== list_monitors index)."""
    try:
        import ctypes
        from ctypes import wintypes
        out = []
        proc_t = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC,
                                    ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

        def _cb(_hmon, _hdc, lprc, _lparam):
            r = lprc.contents
            out.append((int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top)))
            return True

        ctypes.windll.user32.EnumDisplayMonitors(0, 0, proc_t(_cb), 0)
        return out
    except Exception:
        return []


def clip_to_virtual(region):
    """Clip region (x, y, w, h) to the virtual desktop.

    Returns (clipped_region_or_None, bounds_or_None). clipped is None when the region does not intersect
    the desktop at all; when the desktop size is unknown the region is returned unchanged (no validation).
    """
    bounds = virtual_screen_rect()
    x, y, w, h = (int(v) for v in region)
    if bounds is None:
        return (x, y, w, h), None
    bl, bt, bw, bh = bounds
    left, top = max(x, bl), max(y, bt)
    right, bottom = min(x + w, bl + bw), min(y + h, bt + bh)
    if right <= left or bottom <= top:
        return None, bounds
    return (left, top, right - left, bottom - top), bounds


def is_blank_frame(image: Image.Image) -> bool:
    """True when every pixel is black (0,0,0) - the signature of a failed/blocked screen capture."""
    try:
        extrema = image.getextrema()
    except Exception:
        return False
    if not extrema:
        return False
    bands = extrema if isinstance(extrema[0], tuple) else (extrema,)
    color_bands = bands[:3]  # ignore alpha
    return all(hi == 0 for (_lo, hi) in color_bands)


BLANK_FRAME_WARNING = (
    "the captured frame is completely black - it does not show the real screen content")
BLANK_FRAME_HINT = (
    "Possible causes: a region/window on another display or off the desktop, a locked screen or secure "
    "desktop (UAC), a minimized or GPU/DRM-protected window, or a display that is off. Check "
    "get_screen_info/list_monitors for the coordinate space, try window_screenshot for one window, or "
    "use ocr_screen / UI automation tools instead of trusting this image.")


def capture_fields(image: Image.Image, info: dict) -> dict:
    """Result keys describing a grab_screen() capture: origin, clipped flag, blank-frame warning."""
    out = {"origin": dict(info.get("origin") or {"x": 0, "y": 0})}
    if info.get("clipped"):
        out["clipped"] = True
        out["requested_region"] = info.get("requested_region")
    if info.get("monitor") is not None:
        out["monitor"] = info["monitor"]
    if is_blank_frame(image):
        out["blank"] = True
        out["warning"] = BLANK_FRAME_WARNING
        out["hint"] = BLANK_FRAME_HINT
    return out


def grab_screen(region=None, monitor=None):
    """Capture the screen, honouring the virtual desktop. Returns (PIL image, info).

    Args:
        region: optional (x, y, w, h) in VIRTUAL-SCREEN coordinates (negative x/y are valid on a
            secondary display left of / above the primary). Partly off-desktop regions are clipped
            (info['clipped']); a region wholly outside raises ValueError instead of returning black.
        monitor: optional 'all' (whole virtual desktop) or a monitor index (list_monitors order).
            Ignored when `region` is given.

    With neither argument the PRIMARY monitor is captured (keeps the default image size / token cost
    unchanged on multi-monitor rigs).

    info: {'origin': {'x','y'}} - virtual-screen coordinates of the image's top-left pixel; plus
    'clipped'/'requested_region' when a region was clipped and 'monitor' when one was selected.
    """
    from PIL import ImageGrab

    info: dict = {}
    if region is None and monitor is not None:
        m = str(monitor).strip().lower()
        if m in ("all", "virtual"):
            rect = virtual_screen_rect()
            if rect is None:
                raise ValueError("cannot determine the virtual desktop bounds for monitor='all'")
            region = rect
            info["monitor"] = "all"
        else:
            try:
                idx = int(m)
            except ValueError:
                raise ValueError("monitor must be 'all' or a monitor index (see list_monitors)") from None
            rects = monitor_rects()
            if not (0 <= idx < len(rects)):
                raise ValueError(f"monitor {idx} not found (have {len(rects)}; see list_monitors)")
            region = rects[idx]
            info["monitor"] = idx

    if region is None:
        img = ImageGrab.grab()
        info["origin"] = {"x": 0, "y": 0}
        return img, info

    x, y, w, h = (int(v) for v in region)
    clipped, bounds = clip_to_virtual((x, y, w, h))
    if clipped is None:
        b = "unknown" if bounds is None else f"x={bounds[0]}..{bounds[0] + bounds[2]}, y={bounds[1]}..{bounds[1] + bounds[3]}"
        raise ValueError(f"region ({x},{y},{w},{h}) is outside the virtual desktop ({b}); "
                         f"see get_screen_info/list_monitors for the valid coordinate space")
    if clipped != (x, y, w, h):
        info["clipped"] = True
        info["requested_region"] = {"x": x, "y": y, "width": w, "height": h}
    cx, cy, cw, ch = clipped
    prim = primary_screen_size()
    inside_primary = prim is not None and cx >= 0 and cy >= 0 and cx + cw <= prim[0] and cy + ch <= prim[1]
    # Only pay for the whole-desktop BitBlt when the region leaves the primary monitor.
    img = ImageGrab.grab(bbox=(cx, cy, cx + cw, cy + ch), all_screens=not inside_primary)
    info["origin"] = {"x": cx, "y": cy}
    return img, info


def pil_to_bytes(image: Image.Image, format: str = "PNG") -> bytes:
    """Convert a PIL Image to bytes."""
    buffer = io.BytesIO()
    image.save(buffer, format=format)
    return buffer.getvalue()
