"""Mac window targets and clipboard tools, with current process and window identity checks."""
import os

from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason
from ai_computer_control.tools.office_io import atomic_save
from ai_computer_control.utils import macos
from ai_computer_control.utils.macos_session import request
from ai_computer_control.utils.image import encode_with_budget


@mcp.tool()
def list_windows() -> dict:
    """List visible Mac windows in global logical points, with a target binding for subsequent actions.

    Each target includes window handle, owner PID, process start identity and observed bounds.
    Pass the complete target object to Mac window actions. Observe again after the window moves or changes.
    """
    return request({"op": "window.list"})


@mcp.tool()
def get_active_window() -> dict:
    """Return the actual focused accessible Mac window and its current target binding.

    Requires Accessibility authorization. An ambiguous or unsupported focused window produces an error.
    """
    return request({"op": "window.active"})


@mcp.tool(audit=True)
def focus_window(target: dict) -> dict:
    """Focus one Mac window identified by the complete target from list_windows or get_active_window.

    Validates owner PID, process start identity and observed geometry, then verifies actual foreground focus.
    A stale or moved window is rejected. A minimized target may be restored as part of focusing it.
    """
    return request({"op": "window.focus", "target": target})


@mcp.tool(audit=True)
def minimize_window(target: dict) -> dict:
    """Minimize the bound Mac window and verify its actual minimized state.

    Requires the complete target returned by a current observation. The response includes the resulting window.
    """
    return request({"op": "window.minimize", "target": target})


@mcp.tool(audit=True)
def close_window(target: dict) -> dict:
    """Request closure of one bound Mac window and verify it left its owner's accessible window list.

    Requires the current target binding. A save dialog or refused action returns an unconfirmed result.
    """
    return request({"op": "window.close", "target": target})


@mcp.tool(audit=True)
def move_window(x: int, y: int, target: dict) -> dict:
    """Move the bound Mac window to global logical-point x/y and verify its actual position.

    The requested window must retain a visible intersection with an active display.
    """
    return request({"op": "window.move", "target": target, "x": x, "y": y})


@mcp.tool(audit=True)
def resize_window(width: int, height: int, target: dict) -> dict:
    """Resize the bound Mac window in logical points and verify its actual dimensions.

    The response reports an unconfirmed action when the application clamps or refuses the requested size.
    """
    return request({"op": "window.resize", "target": target, "width": width, "height": height})


@mcp.tool(audit=True)
def maximize_window(target: dict) -> dict:
    """Fit the bound Mac window to its display's visible work area, then verify the actual bounds."""
    return request({"op": "window.maximize", "target": target})


@mcp.tool()
def get_clipboard() -> dict:
    """Read Mac clipboard text and report image/file presence, empty state and change count.

    The text read limit is one MiB. Reading a locked desktop is refused.
    """
    return request({"op": "clipboard.get"})


@mcp.tool(audit=True)
def set_clipboard(text: str) -> dict:
    """Replace the Mac clipboard with text for Cmd+V, up to 48000 UTF-8 bytes.

    This explicit write replaces existing clipboard text, images and file references.
    """
    result = request({"op": "clipboard.set", "text": text})
    return {**result, "length": len(text)}


@mcp.tool(audit=True)
def get_clipboard_image(save_path: str | None = None, allow_protected: bool = False,
                        max_width: int = 1280, format: str = "png", quality: int = 80) -> dict:
    """Read the Mac clipboard image, optionally saving a full-resolution PNG to a guarded path.

    Without save_path, return image_base64, dimensions and thumbnail scale. A black bitmap is valid clipboard
    content. The native decode and response are bounded by the desktop helper's pixel and byte limits.
    """
    if save_path and not allow_protected:
        reason = protected_path_reason(save_path)
        if reason:
            return {"ok": False, "code": "path_protected", "error": f"refused to write: destination {reason}"}
    result = request({"op": "clipboard.image.get"})
    if not result["has_image"]:
        return result
    image, metadata = macos.image_response(result)
    if save_path:
        target = os.path.abspath(save_path)
        atomic_save(target, lambda temporary: image.save(temporary, "PNG"), suffix=".png")
        return {**metadata, "path": target, "output_path": target}
    encoded = encode_with_budget(image, max_width=max_width, fmt=format, quality=quality)
    encoded["image_base64"] = encoded.pop("image")
    return {**metadata, **encoded, "original_width": image.width, "original_height": image.height}


@mcp.tool(audit=True)
def set_clipboard_image(path: str) -> dict:
    """Replace the Mac clipboard with a bounded image file, ready for Cmd+V in a target application."""
    absolute = os.path.abspath(os.path.expanduser(path))
    result = request({"op": "clipboard.image.set", "path": absolute})
    return {**result, "path": absolute}
