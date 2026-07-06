"""Offline OCR via the built-in Windows.Media.Ocr engine (no network, no tesseract binary).

Requires the `winsdk` package. If unavailable, the tools return an install hint instead of failing
server startup. Verify on the target box: winsdk OCR is async COM and version-sensitive.
"""

import io
import os

from ai_computer_control.server import mcp

try:
    import winsdk.windows.media.ocr as _ocr  # type: ignore
    import winsdk.windows.graphics.imaging as _imaging  # type: ignore
    import winsdk.windows.storage.streams as _streams  # type: ignore
    import winsdk.windows.globalization as _glob  # type: ignore
    _AVAILABLE = True
    _IMPORT_ERROR = ""
except Exception as e:  # noqa: BLE001 — optional dependency
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)


def _unavailable() -> dict:
    return {"error": "winsdk not installed", "hint": "Add 'winsdk' to the offline package and reinstall "
            "(update.bat --deps), or rebuild the offline package.", "detail": _IMPORT_ERROR}


async def _recognize(png_bytes: bytes, lang: str | None) -> dict:
    stream = _streams.InMemoryRandomAccessStream()
    writer = _streams.DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(list(png_bytes))
    await writer.store_async()
    await writer.flush_async()
    stream.seek(0)
    decoder = await _imaging.BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()

    engine = None
    if lang:
        try:
            engine = _ocr.OcrEngine.try_create_from_language(_glob.Language(lang))
        except Exception:
            engine = None
    if engine is None:
        engine = _ocr.OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        return {"error": "no OCR language pack available", "needs_language_pack": True,
                "hint": "Add a language including its optional OCR feature via Settings > Language "
                        "(e.g. en-US or zh-Hans), then retry."}

    result = await engine.recognize_async(bitmap)
    words = []
    for line in result.lines:
        for w in line.words:
            r = w.bounding_rect
            words.append({"text": w.text, "left": int(r.x), "top": int(r.y),
                          "width": int(r.width), "height": int(r.height),
                          "center": [int(r.x + r.width / 2), int(r.y + r.height / 2)]})
    return {"success": True, "text": result.text, "lines": [ln.text for ln in result.lines], "words": words}


async def _run_ocr(png_bytes: bytes, lang: str | None) -> dict:
    try:
        return await _recognize(png_bytes, lang)
    except Exception as e:  # noqa: BLE001
        out = {"error": f"{type(e).__name__}: {e}"}
        if "language" in str(e).lower():
            out["needs_language_pack"] = True
            out["hint"] = ("Add a language including its optional OCR feature via Settings > Language "
                           "(e.g. en-US or zh-Hans), then retry.")
        return out


def _png_bytes_from_path(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _screenshot_png(region=None) -> bytes:
    from PIL import ImageGrab
    img = ImageGrab.grab(bbox=region) if region else ImageGrab.grab()
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@mcp.tool()
async def ocr_image(path: str, lang: str | None = None) -> dict:
    """Run OCR on an image file. Returns recognized text + per-word bounding boxes (image coords)."""
    if not _AVAILABLE:
        return _unavailable()
    if not os.path.exists(path):
        return {"error": f"file not found: {path}"}
    return await _run_ocr(_png_bytes_from_path(path), lang)


@mcp.tool()
async def ocr_screen(region: str | None = None, lang: str | None = None) -> dict:
    """Run OCR on the whole screen, or a region "x,y,width,height".

    Word 'center' coordinates are SCREEN coordinates (region offset added), ready for mouse_click.
    """
    if not _AVAILABLE:
        return _unavailable()
    bbox = None
    ox = oy = 0
    if region:
        try:
            x, y, w, h = (int(v) for v in region.split(","))
            bbox = (x, y, x + w, y + h)
            ox, oy = x, y
        except Exception:
            return {"error": "region must be 'x,y,width,height'"}
    res = await _run_ocr(_screenshot_png(bbox), lang)
    if res.get("success") and (ox or oy):
        for w in res.get("words", []):
            w["left"] += ox
            w["top"] += oy
            w["center"] = [w["center"][0] + ox, w["center"][1] + oy]
    return res


@mcp.tool(audit=True)
async def ocr_click(text: str, region: str | None = None, lang: str | None = None,
                    nth: int | None = None, nearest_to: dict | None = None,
                    return_candidates: bool = False) -> dict:
    """OCR the screen (or region), find `text` (case-insensitive substring), and click its center.

    Disambiguation when several words match:
      * return_candidates=True: DO NOT click; return every match so the caller can choose.
      * nearest_to={"x":..,"y":..}: click the match whose center is closest to that point.
      * nth: click the nth match (0-based) in reading order (top-to-bottom, then left-to-right).
      * default (none of the above): click the first match in reading order.

    Args:
        text: Text to find (case-insensitive substring of a single OCR word).
        region: Optional "x,y,width,height" to restrict the search.
        lang: Optional OCR language tag.
        nth: 0-based index into the (reading-order-sorted) matches to click.
        nearest_to: {"x","y"} — click the match closest to this screen point.
        return_candidates: If True, return all matches without clicking.

    Returns dict with 'success'+'clicked' (the matched word), 'candidates' (when return_candidates
    or ambiguous), 'not_found', or 'error'.
    """
    if not _AVAILABLE:
        return _unavailable()
    res = await ocr_screen(region=region, lang=lang)
    if not res.get("success"):
        return res
    target = text.lower()
    # Keep the OCR engine's native reading order (result.lines -> line.words), which is already
    # top-to-bottom / left-to-right and DPI-correct — a fixed-pixel row band mis-sorts at high DPI.
    matches = [w for w in res.get("words", []) if target in w["text"].lower()]
    if not matches:
        return {"not_found": True, "text": text, "clicked": None}

    if return_candidates:
        return {"ok": True, "found": True, "count": len(matches), "candidates": matches,
                "clicked": None}

    chosen = None
    if nearest_to and "x" in nearest_to and "y" in nearest_to:
        px, py = int(nearest_to["x"]), int(nearest_to["y"])
        chosen = min(matches, key=lambda w: (w["center"][0] - px) ** 2 + (w["center"][1] - py) ** 2)
    elif nth is not None:
        if not (0 <= int(nth) < len(matches)):
            return {"ok": True, "found": True, "error": f"nth={nth} out of range (0..{len(matches) - 1})",
                    "count": len(matches), "candidates": matches}
        chosen = matches[int(nth)]
    else:
        chosen = matches[0]

    try:
        import pyautogui
        pyautogui.click(chosen["center"][0], chosen["center"][1])
        out = {"success": True, "clicked": chosen, "count": len(matches)}
        if len(matches) > 1:
            out["candidates"] = matches  # surface the alternatives for follow-up disambiguation
        return out
    except Exception as e:  # noqa: BLE001
        return {"error": str(e), "match": chosen}


def _find_phrase(words: list[dict], text: str) -> dict | None:
    """Find `text` (case-insensitive) within a run of consecutive words; span their boxes.

    First tries a single word (fast path), then greedily joins consecutive words to match a phrase
    that spans word boundaries. Returns a dict with rect/center/matched_text, or None.
    """
    target = " ".join(text.lower().split())
    if not target:
        return None
    # Fast path: contained within one word.
    for w in words:
        if target in w["text"].lower():
            return {"rect": {"left": w["left"], "top": w["top"], "width": w["width"], "height": w["height"]},
                    "center": w["center"], "matched_text": w["text"]}
    # Phrase path: join consecutive words with single spaces and look for the target substring.
    n = len(words)
    for i in range(n):
        joined = words[i]["text"].lower()
        if target in joined:
            grp = [words[i]]
            return _span(grp, words[i]["text"])
        for j in range(i + 1, n):
            joined = joined + " " + words[j]["text"].lower()
            if target in joined:
                grp = words[i:j + 1]
                return _span(grp, " ".join(x["text"] for x in grp))
            if len(joined) > len(target) + 40:  # give up early; can't be this run
                break
    return None


def _span(group: list[dict], matched: str) -> dict:
    left = min(w["left"] for w in group)
    top = min(w["top"] for w in group)
    right = max(w["left"] + w["width"] for w in group)
    bottom = max(w["top"] + w["height"] for w in group)
    return {"rect": {"left": left, "top": top, "width": right - left, "height": bottom - top},
            "center": [int((left + right) / 2), int((top + bottom) / 2)], "matched_text": matched}


@mcp.tool(audit=True)
async def ocr_find_text(text: str, region: str | None = None, click: bool = False,
                        lang: str | None = None) -> dict:
    """OCR the screen (or a region) and locate `text`, spanning across adjacent words if needed.

    Coordinates are SCREEN coordinates (region offset already applied by ocr_screen), so 'center'
    is directly clickable. Set click=True to click the match center.

    Args:
        text: Text to find (case-insensitive; may span multiple OCR words).
        region: Optional "x,y,width,height" to restrict the search.
        click: If True, click the center of the match.
        lang: Optional OCR language tag (e.g. "en", "zh-Hans").

    Returns:
        dict with ok, found, and on success center:{x,y}, rect, matched_text (+ clicked if click).
    """
    if not _AVAILABLE:
        return _unavailable()
    res = await ocr_screen(region=region, lang=lang)
    if not res.get("success"):
        return res
    match = _find_phrase(res.get("words", []), text)
    if match is None:
        return {"ok": True, "found": False, "text": text}
    out = {"ok": True, "found": True, "center": {"x": match["center"][0], "y": match["center"][1]},
           "rect": match["rect"], "matched_text": match["matched_text"]}
    if click:
        try:
            import pyautogui
            pyautogui.click(match["center"][0], match["center"][1])
            out["clicked"] = True
        except Exception as e:  # noqa: BLE001
            out["clicked"] = False
            out["click_error"] = str(e)
    return out
