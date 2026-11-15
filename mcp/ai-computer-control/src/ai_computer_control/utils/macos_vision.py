"""Bounded Mac template observations sharing the existing OpenCV matcher."""
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
from contextlib import contextmanager

from ai_computer_control.utils.macos import DesktopError
from ai_computer_control.utils.macos_visual import capture_frame

GATE = threading.Lock()


@contextmanager
def operation():
    if not GATE.acquire(blocking=False):
        raise DesktopError("vision_busy", "Another visual matching operation is running")
    try:
        yield
    finally:
        GATE.release()


def match_frame(frame, template_path, template_b64, confidence, scales):
    if type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0.05 <= confidence <= 1:
        raise DesktopError("invalid_args", "Template confidence must be finite and between 0.05 and 1")
    if not template_path and not template_b64:
        raise DesktopError("invalid_args", "Provide a template path or encoded template")
    if template_b64 is not None and len(template_b64) > 12000000:
        raise DesktopError("vision_capacity", "Encoded template exceeds its byte capacity")
    child = None
    with tempfile.TemporaryDirectory(prefix="ruyi-macos-template-") as directory:
        path = os.path.join(directory, "screen.png")
        frame.image.save(path, "PNG", compress_level=1)
        payload = {"screen_path": path, "template_path": template_path, "template_b64": template_b64,
                   "confidence": confidence, "scales": scales}
        try:
            child = subprocess.Popen([sys.executable, "-m", "ai_computer_control.utils.macos_vision_worker"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                output, _ = child.communicate(json.dumps(payload, allow_nan=False).encode("utf-8"), timeout=8)
            except subprocess.TimeoutExpired:
                raise DesktopError("vision_timeout", "Template worker exceeded its eight-second deadline") from None
            if len(output) > 2000000:
                raise DesktopError("vision_capacity", "Template worker output exceeds its capacity")
            try:
                result = json.loads(output)
            except (ValueError, UnicodeError):
                raise DesktopError("vision_failed", "Invalid template worker response") from None
            if not isinstance(result, dict) or type(result.get("ok")) is not bool:
                raise DesktopError("vision_failed", "Invalid template worker envelope")
            if child.returncode != 0 or not result["ok"]:
                raise DesktopError(result.get("code", "vision_failed"), result.get("error", "Template worker failed"))
            if (result.get("width"), result.get("height")) != frame.image.size \
                    or not isinstance(result.get("hits"), list) or len(result["hits"]) > 4096:
                raise DesktopError("vision_failed", "Invalid template image geometry or result count")
            for hit in result["hits"]:
                if not isinstance(hit, list) or len(hit) != 5 or any(type(value) not in (int, float) or not math.isfinite(value) for value in hit):
                    raise DesktopError("vision_failed", "Invalid template match geometry")
                frame.screen_box({"left": hit[1], "top": hit[2], "width": hit[3], "height": hit[4]})
            return result
        finally:
            if child is not None:
                if child.poll() is None:
                    child.kill()
                child.wait()
                for stream in (child.stdin, child.stdout):
                    stream.close()


def observe(template_path, template_b64, confidence, scales, region, target=None):
    frame = capture_frame(region, target)
    result = match_frame(frame, template_path, template_b64, confidence, scales)
    matches = [{"confidence": min(1.0, hit[0]), **frame.screen_box(
        {"left": hit[1], "top": hit[2], "width": hit[3], "height": hit[4]})} for hit in result["hits"]]
    return frame, result, matches
