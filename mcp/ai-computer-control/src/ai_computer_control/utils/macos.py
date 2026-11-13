"""Bounded IPC to the offline macOS automation helper, shared by Mac tool modules."""
import base64
import io
import json
import math
import os
from pathlib import Path
import selectors
import subprocess
import threading
import time

from PIL import Image

_SLOTS = threading.BoundedSemaphore(2)
_OUTPUT_LIMIT = 68 * 1024 * 1024
CAPTURE_TOOLS = frozenset({"screenshot", "screenshot_region", "window_screenshot"})
DISPLAY_TOOLS = frozenset({"get_screen_info", "list_monitors", "get_dpi_info"})
WINDOW_TOOLS = frozenset({"get_active_window", "focus_window", "minimize_window", "close_window",
                          "move_window", "resize_window", "maximize_window"})
WINDOW_QUERY_TOOLS = frozenset({"list_windows"})
CLIPBOARD_TOOLS = frozenset({"get_clipboard", "set_clipboard", "get_clipboard_image", "set_clipboard_image"})
INPUT_TOOLS = frozenset({"type_text", "press_key", "hotkey", "input_sequence", "mouse_click", "mouse_move", "mouse_drag", "mouse_scroll", "scroll_at"})
POINTER_QUERY_TOOLS = frozenset({"get_mouse_position"})
APPLICATION_TOOLS = frozenset({"launch_application"})
AX_TOOLS = frozenset({"ui_inspect", "ui_find", "ui_invoke"})
OCR_LOCAL_TOOLS = frozenset({"ocr_image", "ocr_available_languages"})
OCR_SCREEN_TOOLS = frozenset({"ocr_screen", "ocr_find_text", "ocr_click"})
VISION_TOOLS = frozenset({"find_template", "find_all_templates", "vision_click", "wait_for_image"})


class DesktopError(RuntimeError):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def helper_path():
    explicit = os.environ.get("RUYI_MACOS_AUTOMATION_HELPER")
    if explicit:
        return Path(explicit)
    # Source checkout fallback. Installed/release layouts supply the explicit path.
    return Path(__file__).resolve().parents[5] / "ruyi-workbench/runtime/macos/ruyi-automation-helper"


def _identity(path):
    stat = path.stat()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise OSError("helper is not executable")
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def _request_bytes(payload):
    try:
        data = json.dumps({**payload, "version": 1}, allow_nan=False, ensure_ascii=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError):
        raise DesktopError("invalid_args", "Desktop request must be valid UTF-8 JSON") from None
    if len(data) > 65536:
        raise DesktopError("invalid_args", "Desktop request exceeds the input limit")
    return data


def _failure_details(result):
    details = {}
    if isinstance(result.get("candidates"), list):
        details["candidates"] = result["candidates"][:20]
    if isinstance(result.get("available_languages"), list):
        details["available_languages"] = [tag for tag in result["available_languages"]
            if isinstance(tag, str) and len(tag) <= 64][:128]
    for key in ("acted", "action_sent", "restored", "reached", "confirmed"):
        if type(result.get(key)) is bool:
            details[key] = result[key]
    for key in ("actual_x", "actual_y"):
        if type(result.get(key)) in (int, float) and math.isfinite(result[key]):
            details[key] = result[key]
    if result.get("outcome") in ("unknown", "unconfirmed", "rolled_back", "not_dispatched"):
        details["outcome"] = result["outcome"]
    for key in ("actual_bounds", "window", "control"):
        if isinstance(result.get(key), dict):
            details[key] = result[key]
    if result.get("restore") in ("none", "done", "failed", "skipped_changed", "unconfirmed"):
        details["restore"] = result["restore"]
    return details


def request(payload, timeout=15):
    """Run a child with bounded input, output, concurrency and lifetime. Never return native stderr."""
    # Exact status is the only contextless native readiness probe. Other native routes must
    # not silently regain legacy behavior if a raw thread/task lost the host operation context.
    if payload != {'op': 'status'}:
        from ai_computer_control.utils.execution_context import require_execution_context
        require_execution_context()
    from ai_computer_control.utils.execution_journal import current_operation
    if current_operation() is not None:
        # Only the explicitly negotiated receipt route may carry an active host
        # operation. It shares the owned worker/lock with input; never fall back
        # to an untraced one-shot after a feature or receipt failure.
        from ai_computer_control.utils.macos_receipt_session import request as receipt_request
        return receipt_request(payload, timeout, generic=True)
    path = helper_path()
    try:
        identity = _identity(path)
    except OSError:
        raise DesktopError("dependency_missing", "Build or install the macOS automation helper") from None
    data = _request_bytes(payload)
    if not _SLOTS.acquire(blocking=False):
        raise DesktopError("capture_busy", "Two native desktop requests are already running")
    child = None
    timeout_code = "ocr_timeout" if str(payload.get("op", "")).startswith("ocr.") else "capture_timeout"
    try:
        child = subprocess.Popen([str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
        output = bytearray()
        stderr_size = 0
        deadline = time.monotonic() + timeout
        written = 0
        os.set_blocking(child.stdin.fileno(), False)
        with selectors.DefaultSelector() as streams:
            streams.register(child.stdin, selectors.EVENT_WRITE)
            streams.register(child.stdout, selectors.EVENT_READ)
            streams.register(child.stderr, selectors.EVENT_READ)
            while streams.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DesktopError(timeout_code, "Native desktop request timed out")
                for key, _ in streams.select(min(remaining, 0.25)):
                    if key.fileobj is child.stdin:
                        written += os.write(child.stdin.fileno(), data[written:written + 4096])
                        if written == len(data):
                            streams.unregister(child.stdin)
                            child.stdin.close()
                        continue
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        streams.unregister(key.fileobj)
                    elif key.fileobj is child.stdout:
                        output.extend(chunk)
                        if len(output) > _OUTPUT_LIMIT:
                            raise DesktopError("capture_capacity", "Native desktop response exceeds its limit")
                    else:
                        stderr_size += len(chunk)
                        if stderr_size > 8192:
                            raise DesktopError("capture_failed", "Native desktop diagnostics exceed their limit")
        try:
            status = child.wait(timeout=max(0.01, deadline - time.monotonic()))
            result = json.loads(output)
        except (ValueError, subprocess.TimeoutExpired):
            raise DesktopError("capture_failed", "Invalid native desktop response") from None
        try:
            unchanged = _identity(path) == identity
        except OSError:
            unchanged = False
        if not unchanged:
            raise DesktopError("dependency_changed", "The native helper changed during the request")
        if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
            raise DesktopError("capture_failed", "Invalid native desktop response envelope")
        if status != 0 or not result["ok"]:
            raise DesktopError(str(result.get("code") or "capture_failed"), str(result.get("error") or "Native desktop request failed"), _failure_details(result))
        if type(result.get("protocolVersion")) is not int or result["protocolVersion"] != 1:
            raise DesktopError("capture_failed", "Unsupported native desktop protocol")
        return result
    except (OSError, BrokenPipeError):
        raise DesktopError("capture_failed", "Cannot communicate with the native desktop helper") from None
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.wait()
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()
        _SLOTS.release()


def capability():
    out = {"supported": True, "installed": False, "authorization": "unknown", "ready": False}
    try:
        _identity(helper_path())
        out["installed"] = True
        status = request({"op": "status"}, timeout=3)
        if not isinstance(status.get("monitors"), list) or status.get("coordinate_space") != "macos_global_points":
            raise DesktopError("capture_failed", "Invalid desktop status metadata")
        out["queryReady"] = True
        out.update(windowReady=bool(status.get("windowReady") and status.get("windowAuthorization") == "granted"
                                   and status.get("locked") is False),
                   windowQueryReady=bool(status.get("windowListReady") and status.get("locked") is False),
                   clipboardReady=bool(status.get("clipboardReady") and status.get("locked") is False))
        out.update(inputReady=bool(status.get("inputReady") and status.get("windowAuthorization") == "granted"
                                  and status.get("eventAuthorization") == "granted" and status.get("locked") is False),
                   pointerQueryReady=bool(status.get("pointerQueryReady") and status.get("locked") is False),
                   applicationReady=bool(status.get("applicationReady") and status.get("locked") is False),
                   windowAuthorization=status.get("windowAuthorization", "unknown"),
                   eventAuthorization=status.get("eventAuthorization", "unknown"))
        out.update(axSupported=status.get("axSupported") is True,
                   axReady=bool(status.get("axSupported") is True and status.get("axReady")
                                and status.get("windowAuthorization") == "granted" and status.get("locked") is False))
        out.update(ocrSupported=status.get("ocrSupported") is True,
                   ocrReady=bool(status.get("ocrSupported") is True and status.get("ocrReady")),
                   ocrRevision=status.get("ocrRevision"))
        out.update(recordSupported=status.get("recordSupported") is True,
                   recordReady=bool(status.get("recordSupported") is True and status.get("recordReady")
                                    and out.get("inputReady")), recordSource=status.get("recordSource"))
        out.update(inputSequenceSupported=status.get('inputSequenceSupported') is True,
                   inputSequenceReady=bool(status.get('inputSequenceSupported') is True and status.get('inputSequenceReady')
                                           and out.get('inputReady')))
        out.update(manualRecordSupported=status.get('manualRecordSupported') is True,
                   manualRecordReady=bool(status.get('manualRecordSupported') is True and status.get('manualRecordReady')
                                         and out.get('recordReady')),
                   listenAuthorization=status.get('listenAuthorization', 'unknown'),
                   recordSources=status.get('recordSources', []), recordInputSource=status.get('recordInputSource'),
                   manualPointerProfiles=status.get('manualPointerProfiles', []))
        out.update(authorization=status.get("authorization", "unknown"), locked=status.get("locked"),
                   ready=bool(status.get("ready") and status.get("authorization") == "granted"
                              and status.get("locked") is False and status["monitors"]))
        out["reasonCode"] = "" if out["ready"] else ("session_locked" if status.get("locked") else
            "permission_denied" if status.get("authorization") != "granted" else "display_unavailable")
        return out
    except (OSError, DesktopError) as error:
        out["reasonCode"] = getattr(error, "code", "dependency_missing")
        return out


def image_response(result):
    """Decode the bounded native PNG envelope shared by screen and clipboard observations."""
    result = dict(result)
    try:
        raw = base64.b64decode(result.pop("png"), validate=True)
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > 32000000:
            raise ValueError("image capacity")
        image.load()
        if image.format != "PNG" or image.size != (result["width"], result["height"]):
            raise ValueError("image metadata")
    except (KeyError, TypeError, ValueError, OSError, Image.DecompressionBombError):
        raise DesktopError("capture_failed", "Invalid native capture image or geometry") from None
    return image, result


def capture(region=None, monitor=None, window_title=None):
    payload = {"op": "capture"}
    if region is not None:
        payload["region"] = list(region)
    elif monitor is not None:
        value = str(monitor).strip().lower()
        if value not in ("all", "virtual"):
            try:
                value = int(value)
            except ValueError:
                raise DesktopError("invalid_args", "monitor must be 'all' or a monitor index") from None
        payload["monitor"] = value
    if window_title is not None:
        payload = {"op": "capture", "window_title": window_title}
    image, result = image_response(request(payload))
    bounds = result.get("logical_bounds")
    valid_bounds = isinstance(bounds, dict) and all(type(bounds.get(key)) in (int, float)
        and math.isfinite(bounds[key]) for key in ("x", "y", "width", "height"))
    if not valid_bounds or result.get("coordinate_space") != "macos_global_points" \
        or bounds["width"] <= 0 or bounds["height"] <= 0:
        raise DesktopError("capture_failed", "Invalid native capture geometry")
    return image, result
