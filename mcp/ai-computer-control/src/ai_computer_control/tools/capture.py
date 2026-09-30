"""Per-window screenshot via PrintWindow (captures occluded/background windows), screen-crop fallback.

`window_screenshot(title_substring)` finds a top-level window by case-insensitive substring, then
tries ctypes PrintWindow with PW_RENDERFULLCONTENT (works for most windows even when covered). If
that fails or yields an empty (all-black) frame, it falls back to a virtual-desktop-aware crop of the
window's visible frame. The capture core lives in utils/wincap.py (shared with screenshot(window_title=)).
"""

import os

from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason
from ai_computer_control.utils import wincap
# Re-exported for callers/tests that reached for these names on this module.
from ai_computer_control.utils.wincap import _find_hwnd, _printwindow_to_pil  # noqa: F401


@mcp.tool(audit=True)
def window_screenshot(title_substring: str, output_path: str | None = None,
                      max_width: int = 1280, format: str = "png", quality: int = 80,
                      allow_protected: bool = False) -> dict:
    """Screenshot a specific window by (case-insensitive) title substring.

    Tries PrintWindow (captures even background/occluded windows); if that fails or returns an
    all-black frame (GPU-composited windows), falls back to cropping the virtual desktop to the
    window's frame (then 'occluded_possible' is true: other windows may cover it). Restores the
    window first if minimized ('restored': true).

    Args:
        title_substring: Part of the target window's title.
        output_path: Optional path to write. If omitted, returns base64 (image_base64).
        max_width: If >0, proportionally downscale the returned base64 image to this width (default
            1280, same as screenshot; 0 = original). Ignored when output_path is given (the saved
            file is always full-resolution PNG). Returned 'scale' (<1.0 when downscaled) maps a point
            in the base64 image back to the window: x_screen = origin.x + x_img / scale.
        format: 'png' (default) or 'jpeg' for the returned base64 (ignored when saving to a path).
        quality: JPEG quality 1-100 (ignored for PNG / when saving to a path).
        allow_protected: Override the protected-system-root guard on output_path (default off).

    Returns:
        dict with ok, matched_title, method ('printwindow'|'screen_crop'), width, height, scale,
        format, origin {x,y} (virtual-screen coordinates of the image's top-left pixel; the saved
        file has scale 1), and either 'path' or 'image_base64'. A 'blank': true + 'warning' means the
        frame is completely black and should not be trusted.
    """
    # Validate the write destination before inspecting or manipulating a window. Besides making the safety
    # decision deterministic in headless/zero-size desktop sessions, this avoids doing unnecessary capture
    # work for a request that is guaranteed to be refused.
    if output_path:
        reason = protected_path_reason(output_path)
        if reason and not allow_protected:
            return {"ok": False,
                    "error": f"refused to write: destination {reason}. Pass allow_protected=true to override."}

    try:
        cap = wincap.capture_window(title_substring, restore_minimized=True)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"capture failed: {e}"}
    if not cap.get("ok"):
        return cap
    img = cap.pop("img")

    out = {k: v for k, v in cap.items() if k != "window_rect"}
    out.update({"width": img.width, "height": img.height, "scale": 1.0})
    if output_path:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            img.save(output_path, "PNG")
            out["path"] = os.path.abspath(output_path)
            out["output_path"] = os.path.abspath(output_path)  # v1.5.1: 产物收割键(与 path 同值)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"could not save: {e}", "matched_title": cap.get("matched_title")}
    else:
        from ai_computer_control.utils.image import encode_with_budget
        enc = encode_with_budget(img, max_width=max_width, fmt=format, quality=quality)
        out["image_base64"] = enc["image"]
        out["width"] = enc["width"]
        out["height"] = enc["height"]
        out["scale"] = enc["scale"]
        out["format"] = enc["format"]
    return out
