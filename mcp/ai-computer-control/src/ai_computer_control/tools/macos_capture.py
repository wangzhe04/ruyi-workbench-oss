"""Mac ScreenCaptureKit tools. All actionable desktop coordinates are global logical points."""
import os

from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason
from ai_computer_control.tools.office_io import atomic_save
from ai_computer_control.utils import macos
from ai_computer_control.utils.macos_visual import capture_fields as _fields


@mcp.tool()
def screenshot(region: str | None = None, window_title: str | None = None, max_width: int = 1280,
               format: str = "png", quality: int = 80, monitor: str | None = None) -> dict:
    """Capture a Mac display, region or uniquely matching window using ScreenCaptureKit.

    Coordinates use global logical points, top-left origin, including negative secondary-display coordinates.
    region is x,y,width,height in logical points. Partial desktop overflow is clipped. monitor is 'all' or an
    index from list_monitors, default is primary. window_title takes precedence and must match uniquely.
    Return image, width/height, origin, scale and scale_y. Map image pixels using
    x_screen = origin.x + x_image / scale and y_screen = origin.y + y_image / scale_y.
    Native source_pixel_scale records Retina scaling separately. Permission denial and black captures fail.
    """
    parsed = None
    if region and not window_title:
        try:
            parsed = tuple(int(value.strip()) for value in region.split(","))
        except ValueError:
            raise macos.DesktopError("invalid_args", "region must contain four integers") from None
        if len(parsed) != 4 or parsed[2] <= 0 or parsed[3] <= 0:
            raise macos.DesktopError("invalid_args", "region must contain x,y and positive width,height")
    image, info = macos.capture(region=parsed, monitor=monitor, window_title=window_title)
    return _fields(image, info, max_width, format, quality)


@mcp.tool()
def screenshot_region(x: int, y: int, width: int, height: int,
                      max_width: int = 1280, format: str = "png", quality: int = 80) -> dict:
    """Capture a rectangular Mac desktop region in global logical points. Negative coordinates are valid.

    Returns the screenshot envelope with origin, scale and scale_y for exact image-pixel to logical-point
    conversion. Entirely off-display regions fail, partial overflow is clipped before capture.
    """
    if width <= 0 or height <= 0:
        raise macos.DesktopError("invalid_args", "width and height must be positive")
    image, info = macos.capture(region=(x, y, width, height))
    return _fields(image, info, max_width, format, quality)


def _screen_info():
    status = macos.request({"op": "status"}, timeout=3)
    primary = next((display for display in status["monitors"] if display["is_primary"]), None)
    return {**status, "primary": primary}


@mcp.tool()
def get_screen_info() -> dict:
    """Return Mac display logical bounds, backing scales, virtual bounds and current screen permission.

    Display indices are shared with list_monitors and screenshot(monitor=...). Display x/y/width/height use
    global logical points, while each scale gives backing pixels per point. This query never requests TCC.
    """
    return _screen_info()


@mcp.tool()
def list_monitors() -> dict:
    """List Mac active monitors with stable display IDs, current indices, logical bounds and backing scales."""
    info = _screen_info()
    return {**info, "count": len(info["monitors"])}


@mcp.tool()
def get_dpi_info() -> dict:
    """Report Mac logical-point coordinate space and primary backing scale. No screen permission is requested."""
    info = _screen_info()
    return {"ok": True, "coordinate_space": info["coordinate_space"], "awareness": "logical_points",
            "primary_scale": (info.get("primary") or {}).get("scale"), "monitors": info["monitors"]}


@mcp.tool(audit=True)
def window_screenshot(title_substring: str, output_path: str | None = None, max_width: int = 1280,
                      format: str = "png", quality: int = 80, allow_protected: bool = False) -> dict:
    """Capture one uniquely matching Mac window, including a covered window, without changing focus.

    output_path optionally saves full-resolution PNG through the protected-path guard. Without a path the
    result contains image_base64. Coordinates are global logical points, with actual scale and scale_y for
    converting image pixels back to the desktop. A missing, ambiguous or uncapturable window fails.
    """
    if output_path:
        reason = protected_path_reason(output_path)
        if reason and not allow_protected:
            return {"ok": False, "code": "path_protected", "error": f"refused to write: destination {reason}"}
    image, info = macos.capture(window_title=title_substring)
    out = _fields(image, info, 0 if output_path else max_width, format, quality)
    if output_path:
        absolute = os.path.abspath(output_path)
        atomic_save(absolute, lambda temporary: image.save(temporary, "PNG"), suffix=".png")
        out.pop("image")
        out.update(path=absolute, output_path=absolute, format="png")
    else:
        out["image_base64"] = out.pop("image")
    return out
