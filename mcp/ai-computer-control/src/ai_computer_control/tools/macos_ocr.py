"""Offline Vision OCR with image-pixel observations and guarded Mac logical-point clicks."""
import asyncio

from ai_computer_control.server import mcp
from ai_computer_control.utils import macos
from ai_computer_control.utils.macos_visual import capture_frame, select_match
from ai_computer_control.utils.ocr_match import _phrase_matches, _miss_details

from ai_computer_control.utils.macos_ocr import (
    _recognize, _frame_result, _cap, _mapped, _gated, _OCR_GATE, ocr_frame,
)


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
