"""Shared read-only Vision pipeline. Importing it never registers MCP tools."""
import asyncio
import math
import os
import tempfile
import threading

from ai_computer_control.utils import macos
from ai_computer_control.utils.macos_visual import VisualFrame

_OCR_GATE = threading.Lock()
_WORDS_CAP = 500


def _recognize(path, lang):
    if lang is not None and not isinstance(lang, str):
        raise macos.DesktopError("invalid_args", "lang must be a language string or omitted")
    result = macos.request({"op": "ocr.image", "path": os.path.abspath(path), "lang": lang or ""}, timeout=65)
    width, height = result.get("width"), result.get("height")
    words, lines = result.get("words"), result.get("lines")
    valid = result.get("success") is True and result.get("coordinate_space") == "image_pixels" \
        and type(width) is int and type(height) is int and 0 < width <= 16384 and 0 < height <= 16384 \
        and width * height <= 32000000 and isinstance(words, list) and len(words) <= 10000 \
        and isinstance(lines, list) and len(lines) <= 2000 \
        and all(isinstance(line, str) and len(line) <= 4096 for line in lines) \
        and isinstance(result.get("text"), str) and len(result["text"]) <= 67536 \
        and type(result.get("words_total")) is int and result["words_total"] == len(words)
    if not valid:
        raise macos.DesktopError("ocr_failed", "Invalid native OCR response metadata")
    for word in words:
        if not isinstance(word, dict) or not isinstance(word.get("text"), str) or not 0 < len(word["text"]) <= 4096:
            raise macos.DesktopError("ocr_failed", "Invalid recognized token")
        values = [word.get(key) for key in ("left", "top", "width", "height")]
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
            raise macos.DesktopError("ocr_failed", "Invalid recognized token geometry")
        x, y, w, h = values
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width or y + h > height \
                or word.get("center") != [x + w / 2, y + h / 2] \
                or type(word.get("line")) is not int or not 0 <= word["line"] < len(lines):
            raise macos.DesktopError("ocr_failed", "Recognized token leaves its image or line")
    return result

def _frame_result(frame, lang):
    with tempfile.TemporaryDirectory(prefix="ruyi-macos-ocr-") as directory:
        path = os.path.join(directory, "frame.png")
        frame.image.save(path, "PNG", compress_level=1)
        result = _recognize(path, lang)
        if (result["width"], result["height"]) != frame.image.size:
            raise macos.DesktopError("ocr_failed", "OCR dimensions differ from the captured frame")
        return result

def _cap(result):
    result = dict(result)
    total = len(result.get("words", []))
    result["words_total"] = total
    result["truncated"] = total > _WORDS_CAP
    result["words"] = result.get("words", [])[:_WORDS_CAP]
    return result

def _mapped(result, frame):
    out = dict(result)
    out["words"] = [{**word, **frame.screen_box(word)} for word in result.get("words", [])]
    bounds = frame.info["logical_bounds"]
    out.update(coordinate_space="macos_global_points", origin={"x": bounds["x"], "y": bounds["y"]},
               logical_bounds=dict(bounds), source_pixel_scale={"x": frame.image.width / bounds["width"],
                                                              "y": frame.image.height / bounds["height"]})
    return out

def _enter():
    if not _OCR_GATE.acquire(blocking=False):
        raise macos.DesktopError("ocr_busy", "Another OCR operation is running")

def _gated(operation, *args):
    _enter()
    try:
        return operation(*args)
    finally:
        _OCR_GATE.release()

async def ocr_frame(img, origin=(0, 0), lang=None, *, logical_bounds=None):
    """Recognize an existing frame. Pass logical_bounds to map native Retina pixels to Mac points."""
    # The worker owns the gate through completion, including after caller cancellation.
    return await asyncio.to_thread(_ocr_frame, img, origin, lang, logical_bounds)

def _ocr_frame(img, origin, lang, logical_bounds):
    _enter()
    try:
        bounds = logical_bounds or {"x": origin[0], "y": origin[1], "width": img.width, "height": img.height}
        frame = VisualFrame(img.convert("RGB"), {"logical_bounds": bounds}, None, 0, None)
        return _mapped(_frame_result(frame, lang), frame)
    finally:
        _OCR_GATE.release()
