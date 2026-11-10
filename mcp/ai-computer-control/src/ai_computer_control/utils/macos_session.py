"""Owned native input session. Window references live only in this worker and are never replayed."""
import atexit
import json
import os
import selectors
import subprocess
import threading
import time

from ai_computer_control.utils.macos import DesktopError, helper_path, _identity, _request_bytes, _failure_details, _OUTPUT_LIMIT

_LOCK = threading.Lock()
_SESSION = None


def close_input_session():
    # Share the request lock so shutdown cannot close/reuse a descriptor while a
    # request is reading it. A frame is bounded by its native and Python deadlines.
    with _LOCK:
        _close_input_session()


def _close_input_session():
    global _SESSION
    session = _SESSION
    _SESSION = None
    if session is None:
        return
    session["closing"] = True
    child = session["child"]
    try:
        child.stdin.close()
    except OSError:
        pass
    try:
        child.wait(timeout=0.3)
    except subprocess.TimeoutExpired:
        child.terminate()
        try:
            child.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    child.stdout.close()


def _session():
    global _SESSION
    path = helper_path()
    try:
        identity = _identity(path)
    except OSError:
        _close_input_session()
        raise DesktopError("dependency_missing", "Build or install the macOS automation helper") from None
    if _SESSION is not None:
        if _SESSION["identity"] != identity or _SESSION["path"] != path or _SESSION["child"].poll() is not None:
            _close_input_session()
    if _SESSION is None:
        try:
            child = subprocess.Popen([str(path), "--input-session"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}, bufsize=0)
        except OSError:
            raise DesktopError("input_session_failed", "Cannot start the native input session") from None
        os.set_blocking(child.stdin.fileno(), False)
        _SESSION = {"child": child, "path": path, "identity": identity, "next_id": 0, "closing": False}
    return _SESSION


def request(payload, timeout=15):
    """Send one frame, close an uncertain worker, and return a typed result without retrying a mutation."""
    if not _LOCK.acquire(blocking=False):
        raise DesktopError("desktop_busy", "Another native input request is already running")
    sent = False
    try:
        session = _session()
        child = session["child"]
        session["next_id"] += 1
        identifier = session["next_id"]
        data = _request_bytes({**payload, "id": identifier}) + b"\n"
        written = 0
        output = bytearray()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as streams:
            streams.register(child.stdin, selectors.EVENT_WRITE)
            streams.register(child.stdout, selectors.EVENT_READ)
            while b"\n" not in output:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DesktopError("input_session_timeout", "Native input request exceeded its deadline")
                for key, _ in streams.select(min(remaining, 0.25)):
                    if key.fileobj is child.stdin:
                        written += os.write(child.stdin.fileno(), data[written:written + 4096])
                        if written == len(data):
                            streams.unregister(child.stdin)
                            sent = True
                    else:
                        chunk = os.read(child.stdout.fileno(), 65536)
                        if not chunk:
                            raise DesktopError("input_session_failed", "Native input session exited before its response")
                        output.extend(chunk)
                        if len(output) > _OUTPUT_LIMIT:
                            raise DesktopError("input_session_capacity", "Native input response exceeds its capacity")
        line, remainder = bytes(output).split(b"\n", 1)
        if remainder or session["closing"] or _SESSION is not session:
            raise DesktopError("input_session_protocol", "Native input session response is no longer current")
        try:
            result = json.loads(line)
            current_identity = _identity(session["path"])
        except (ValueError, OSError):
            raise DesktopError("input_session_protocol", "Invalid native input response") from None
        if current_identity != session["identity"]:
            raise DesktopError("dependency_changed", "Native input helper changed during the request")
        if not isinstance(result, dict) or type(result.get("id")) is not int or result["id"] != identifier \
            or type(result.get("ok")) is not bool:
            raise DesktopError("input_session_protocol", "Native input response does not match the request")
        if not result["ok"]:
            raise DesktopError(str(result.get("code") or "input_failed"), str(result.get("error") or "Native input operation failed"), _failure_details(result))
        if type(result.get("protocolVersion")) is not int or result["protocolVersion"] != 1:
            raise DesktopError("input_session_protocol", "Unsupported native input session protocol")
        result.pop("id")
        return result
    except (DesktopError, OSError) as error:
        if isinstance(error, OSError):
            error = DesktopError("input_session_failed", "Native input session communication failed")
        uncertain = error.code.startswith("input_session_") or error.code == "dependency_changed"
        if uncertain:
            _close_input_session()
            if sent and payload.get("op") not in {"window.list", "window.active", "clipboard.get", "clipboard.image.get"}:
                error.details.update(action_sent=True, outcome="unknown")
        raise error
    finally:
        _LOCK.release()


atexit.register(close_input_session)
