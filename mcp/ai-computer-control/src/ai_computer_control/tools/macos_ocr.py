"""Offline Vision OCR with image-pixel observations and guarded Mac logical-point clicks."""
import os
import asyncio
import math
import tempfile
import threading

from ai_computer_control.server import mcp
from ai_computer_control.utils import macos
from ai_computer_control.utils.macos_visual import VisualFrame, capture_frame, select_match
from ai_computer_control.utils.ocr_match import _phrase_matches, _miss_details

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


@mcp.tool()
async def ocr_image(path: str, lang: str | None = None) -> dict:
    """Recognize a local image with offline Vision, returning top-left image-pixel text boxes.

    The first decoded image frame is recognized with its raw pixel orientation. Input is limited to
    50MB, 32 million pixels and 16384 pixels per side. Default language hints are Chinese and English.
    Explicit unsupported languages fail. Confidence values belong to the whole line candidate.
    First-use system model compilation shares a bounded sixty-second native recognition deadline.
    The returned word list is capped at 500 with words_total and truncated; text and lines remain complete.
    """
    return _cap(await asyncio.to_thread(_gated, _recognize, path, lang))


@mcp.tool()
async def ocr_available_languages() -> dict:
    """List languages supported by the installed offline Vision revision, including exact BCP-47 tags.

    Local image OCR and this query operate independently of desktop input and screen permissions.
    """
    return await asyncio.to_thread(macos.request, {"op": "ocr.languages"})


@mcp.tool()
async def ocr_screen(region: str | None = None, lang: str | None = None) -> dict:
    """OCR a Mac primary display or global logical-point region through ScreenCaptureKit and Vision.

    region is x,y,width,height in global logical points. Actual clipped capture bounds and each native
    pixel axis determine the word coordinate mapping. Returned boxes/centers are global logical points.
    Black captures fail explicitly. The model response includes at most 500 words with a truncation flag.
    """
    return _cap(await asyncio.to_thread(_gated, _screen, region, lang))


def _screen(region, lang):
    frame = capture_frame(region)
    return _mapped(_frame_result(frame, lang), frame)


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


def _locate(text, region, lang, target):
    if not isinstance(text, str) or not text.strip() or len(text) > 2048:
        raise macos.DesktopError("invalid_args", "Search text must be nonempty and at most 2048 characters")
    frame = capture_frame(region, target)
    recognized = _frame_result(frame, lang)
    matches = _phrase_matches(recognized.get("words", []), text)
    return frame, recognized, matches


@mcp.tool(audit=True)
async def ocr_find_text(text: str, region: str | None = None, click: bool = False,
                  lang: str | None = None, target: dict | None = None) -> dict:
    """Find OCR words/phrases, returning global logical-point geometry and the full match count.

    Query-only calls return the first reading-order match and count. Clicking requires exactly one match
    and the complete current active-window target. The search is clipped to that target. Stable matched
    pixels are recaptured before native guarded input, with a ten-second observation dispatch budget.
    Native events being posted leaves the application's actual effect unconfirmed for later observation.
    """
    if click and target is None:
        raise macos.DesktopError("target_required", "OCR clicks require the complete active-window target")
    frame, recognized, matches = await asyncio.to_thread(_gated, _locate, text, region, lang, target)
    if not matches:
        return {"ok": True, "found": False, "text": text, **_miss_details(_cap(_mapped(recognized, frame)), text)}
    chosen = matches[0]
    mapped = frame.screen_box(chosen["rect"])
    out = {"ok": True, "found": True, "count": len(matches), "center": {"x": mapped["center"][0], "y": mapped["center"][1]},
           "rect": {key: mapped[key] for key in ("left", "top", "width", "height")},
           "matched_text": chosen["matched_text"], "match_type": chosen["match_type"], "coordinate_space": "macos_global_points"}
    if click:
        if len(matches) != 1:
            return {**out, "ok": False, "code": "ocr_ambiguous", "error": "OCR click requires a unique match", "clicked": False}
        out.update(await frame.click_async(chosen["rect"]), clicked=True)
    return out


@mcp.tool(audit=True)
async def ocr_click(text: str, region: str | None = None, lang: str | None = None,
              nth: int | None = None, nearest_to: dict | None = None, return_candidates: bool = False,
              target: dict | None = None) -> dict:
    """Locate OCR text and click through a complete active Mac window target with fresh-pixel guards.

    return_candidates observes all matches without clicking. Multiple matches require explicit nth (0-based)
    or nearest_to {x,y} in global logical points. Exact nearest-distance ties are refused. The complete list
    is searched before response caps. Recheck actual application state after posted events.
    """
    if not return_candidates and target is None:
        raise macos.DesktopError("target_required", "OCR clicks require the complete active-window target")
    frame, recognized, matches = await asyncio.to_thread(_gated, _locate, text, region, lang, target)
    candidates = [{"text": item["matched_text"], **frame.screen_box(item["rect"]), "match_type": item["match_type"]} for item in matches]
    if not matches:
        return {"ok": True, "found": False, "not_found": True, "clicked": None, **_miss_details(_cap(_mapped(recognized, frame)), text)}
    if return_candidates:
        return {"ok": True, "found": True, "count": len(matches), "candidates": candidates[:100], "truncated": len(matches) > 100, "clicked": None}
    index = select_match(candidates, nth, nearest_to, code="ocr_ambiguous")
    sent = await frame.click_async(matches[index]["rect"])
    return {**sent, "success": True, "found": True, "clicked": candidates[index], "count": len(matches)}
