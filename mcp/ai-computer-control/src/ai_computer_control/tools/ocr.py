"""Offline OCR via the built-in Windows.Media.Ocr engine (no network, no tesseract binary).

Requires the `winsdk` package. If unavailable, the tools return an install hint instead of failing
server startup. Verify on the target box: winsdk OCR is async COM and version-sensitive.

Chinese (CJK) hardening (v1.9.1):
  * Language-tag normalization -- bare "zh"/"chinese"/"zh-CN" are mapped to the BCP-47 tags
    Windows.Media.Ocr actually ships OCR packs for ("zh-Hans-CN"/"zh-Hant-TW"). Without this,
    try_create_from_language silently returns None for "zh" and the engine falls back to English,
    turning every Chinese character into mojibake.
  * Chinese auto-preference -- on a zh-CN/zh-TW system with no explicit lang, we probe the system
    locale and prefer a Chinese engine before the generic user-profile fallback, so a developer
    machine whose display language is English still recognizes Chinese screen text.
  * Small-text upscaling -- Chinese OCR is weak on low-DPI / small-region captures. Images whose
    shorter side is below a threshold are LANCZOS-upscaled before recognition; bounding boxes are
    scaled back so callers still receive coordinates in the ORIGINAL image space.
  * CJK phrase matching -- ocr_find_text now joins consecutive words WITHOUT spaces too, so a search
    for "系统设置" matches adjacent OCR words ["系统","设置"] (Windows segments CJK into 2-4 char units).
  * Internal timeout -- recognize_async is wrapped in asyncio.wait_for so a stuck COM call returns a
    clean error instead of hanging until the 120s bridge kills the whole ACC process.
"""

import asyncio
import io
import os
import threading

from ai_computer_control.server import mcp

try:
    import winsdk.windows.media.ocr as _ocr  # type: ignore
    import winsdk.windows.graphics.imaging as _imaging  # type: ignore
    import winsdk.windows.storage.streams as _streams  # type: ignore
    import winsdk.windows.globalization as _glob  # type: ignore
    _AVAILABLE = True
    _IMPORT_ERROR = ""
except Exception as e:  # noqa: BLE001 - optional dependency
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)


# OCR language tag normalization. Windows.Media.Ocr ships packs for specific BCP-47 tags; the common
# user-facing aliases ("zh", "chinese", "zh-CN") are NOT among them and make try_create_from_language
# return None, which silently falls back to English -> Chinese becomes mojibake.
_LANG_ALIASES = {
    "zh": "zh-Hans-CN",
    "chinese": "zh-Hans-CN",
    "zh-cn": "zh-Hans-CN",
    "zh-s": "zh-Hans-CN",
    "zh-hans": "zh-Hans-CN",
    "zh-hans-cn": "zh-Hans-CN",
    "zh-tw": "zh-Hant-TW",
    "zh-hk": "zh-Hant-TW",
    "zh-hant": "zh-Hant-TW",
    "zh-hant-tw": "zh-Hant-TW",
    "ja": "ja",
    "japanese": "ja",
    "ja-jp": "ja",
    "ko": "ko",
    "korean": "ko",
    "ko-kr": "ko",
    "en": "en-US",
    "english": "en-US",
    "en-us": "en-US",
}

# Per-call internal timeouts (seconds).  The complete capture/read + decode + recognize path must
# finish comfortably before Ruyi's outer MCP bridge deadline.  Windows.Media.Ocr is also serialized:
# concurrent WinRT recognizers can starve one another on slower/offline desktops and used to make every
# caller wait until the bridge killed the warm ACC process.
_OCR_RECOGNIZE_TIMEOUT_S = 45
_OCR_DECODE_TIMEOUT_S = 20
_OCR_INPUT_TIMEOUT_S = 10
_OCR_PIPELINE_TIMEOUT_S = 60
_OCR_QUEUE_TIMEOUT_S = 5
_OCR_GATE = asyncio.Lock()


async def _run_blocking_bounded(fn, timeout: float):
    """Run a potentially blocking image operation in a daemon thread with a hard async deadline.

    ``asyncio.to_thread`` uses the loop's non-daemon executor.  A wedged network-file read or
    ``ImageGrab.grab`` would therefore keep the ACC child alive even after the MCP bridge timed out.
    This narrow helper lets the caller return a useful timeout while an irrecoverably stuck worker can
    no longer block process teardown.
    """
    loop = asyncio.get_running_loop()
    done = loop.create_future()

    def settle(value=None, error=None):
        if done.done():
            return
        if error is not None:
            done.set_exception(error)
        else:
            done.set_result(value)

    def worker():
        try:
            value = fn()
        except BaseException as exc:  # noqa: BLE001 - forward the original loader/preprocessor error
            try:
                loop.call_soon_threadsafe(settle, None, exc)
            except RuntimeError:
                pass  # event loop already closed after cancellation/process shutdown
        else:
            try:
                loop.call_soon_threadsafe(settle, value, None)
            except RuntimeError:
                pass

    threading.Thread(target=worker, daemon=True, name="acc-ocr-input").start()
    return await asyncio.wait_for(done, timeout=max(0.01, float(timeout)))


def _unavailable() -> dict:
    return {"error": "winsdk not installed", "hint": "Add 'winsdk' to the offline package and reinstall "
            "(update.bat --deps), or rebuild the offline package.", "detail": _IMPORT_ERROR}


def _coerce_bytes(value) -> bytes:
    """Normalize binary inputs across Pillow/winsdk versions without lossy list conversion."""
    if isinstance(value, bytes):
        return value
    if isinstance(value, (bytearray, memoryview)):
        return bytes(value)
    if hasattr(value, "read"):
        data = value.read()
        if isinstance(data, (bytes, bytearray, memoryview)):
            return bytes(data)
    raise TypeError(f"OCR image input must be bytes-like, got {type(value).__name__}")


def _write_bytes_compat(writer, payload: bytes) -> None:
    """winsdk releases disagree on DataWriter.write_bytes' accepted Python shape.

    Current builds require a bytes-like object; a few older projections accepted a sequence of
    integers.  Prefer the correct zero-copy shape and retain a narrow compatibility fallback.
    """
    try:
        writer.write_bytes(payload)
    except TypeError as first_error:
        try:
            writer.write_bytes(list(payload))
        except TypeError:
            raise first_error


def _normalize_lang_tag(lang: str | None) -> str | None:
    """Map a user-supplied lang alias to a BCP-47 tag Windows.Media.Ocr ships an OCR pack for."""
    if not lang:
        return None
    key = str(lang).strip().lower()
    if not key:
        return None
    return _LANG_ALIASES.get(key, str(lang).strip())


def _candidate_lang_tags(lang: str | None) -> list[str]:
    """Ordered tags to try for a requested lang: the normalized tag first, then close siblings.

    For Chinese we try Simplified then Traditional (and vice-versa) so a user who passes "zh" on a
    Traditional-only box still gets a Chinese engine instead of an English fallback.
    """
    norm = _normalize_lang_tag(lang)
    if not norm:
        return []
    tags = [norm]
    low = norm.lower()
    if low.startswith("zh-hans"):
        if "zh-Hant-TW" not in tags:
            tags.append("zh-Hant-TW")
    elif low.startswith("zh-hant"):
        if "zh-Hans-CN" not in tags:
            tags.append("zh-Hans-CN")
    elif low in ("ja", "ja-jp"):
        tags.append("ja-JP")
    elif low in ("ko", "ko-kr"):
        tags.append("ko-KR")
    elif low in ("en-us",):
        tags.append("en-GB")
    # De-dup preserving order.
    seen, out = set(), []
    for t in tags:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _system_locale_hint() -> str | None:
    """Best-effort system locale (e.g. "zh-CN") via GetUserDefaultLocaleName. None if not Chinese."""
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(85)
        if ctypes.windll.kernel32.GetUserDefaultLocaleName(buf, 85):
            tag = buf.value
            low = tag.lower()
            if low.startswith("zh-hans") or low.startswith("zh-cn") or low == "zh":
                return "zh-Hans-CN"
            if low.startswith("zh-hant") or low.startswith("zh-tw") or low.startswith("zh-hk"):
                return "zh-Hant-TW"
            return tag
    except Exception:
        pass
    return None


def _available_lang_tags() -> list[str]:
    """BCP-47 tags of installed OCR recognizer language packs.

    winsdk exposes installed recognizer languages as the PROPERTY
    `OcrEngine.available_recognizer_languages` (an IVectorView<Language>); the method-shaped
    `get_available_recognizer_languages()` does not exist and raised AttributeError, which this
    function swallowed into an empty list -- breaking ocr_available_languages AND the
    "any installed Chinese engine" fallback inside _resolve_engine. getattr tolerates both shapes.
    """
    try:
        langs = getattr(_ocr.OcrEngine, "available_recognizer_languages", None)
        if langs is None:
            langs = getattr(_ocr.OcrEngine, "get_available_recognizer_languages", lambda: [])()
        return [str(l.language_tag) for l in langs]
    except Exception:
        return []


def _resolve_engine(lang: str | None):
    """Pick the best OcrEngine for the request. Returns (engine, lang_used, fallback_from).

    `fallback_from` is the originally-requested tag when we could NOT honor it and fell back to
    something else (None when we honored the request or no lang was requested). Callers surface this
    so the model knows its lang was ignored rather than getting silent English mojibake.
    """
    requested_norm = _normalize_lang_tag(lang)

    # Explicit lang: try the candidate chain.
    if requested_norm:
        for tag in _candidate_lang_tags(lang):
            try:
                eng = _ocr.OcrEngine.try_create_from_language(_glob.Language(tag))
            except Exception:
                eng = None
            if eng:
                return eng, tag, None
        # Could not honor the explicit request -- fall back to user profile, but flag it.
        try:
            eng = _ocr.OcrEngine.try_create_from_user_profile_languages()
            if eng:
                return eng, "user-profile", requested_norm
        except Exception:
            pass
        # Last resort for an explicit Chinese request: any installed Chinese engine.
        if requested_norm.lower().startswith("zh"):
            for tag in _available_lang_tags():
                if tag.lower().startswith("zh"):
                    try:
                        eng = _ocr.OcrEngine.try_create_from_language(_glob.Language(tag))
                        if eng:
                            return eng, tag, requested_norm
                    except Exception:
                        pass
        return None, None, None

    # No lang requested: prefer the system-locale hint (Chinese on a zh-CN box), then user profile,
    # then any installed Chinese engine, so a dev machine with English display still reads Chinese.
    hint = _system_locale_hint()
    if hint:
        for tag in _candidate_lang_tags(hint):
            try:
                eng = _ocr.OcrEngine.try_create_from_language(_glob.Language(tag))
            except Exception:
                eng = None
            if eng:
                return eng, tag, None
    try:
        eng = _ocr.OcrEngine.try_create_from_user_profile_languages()
        if eng:
            return eng, "user-profile", None
    except Exception:
        pass
    for tag in _available_lang_tags():
        if tag.lower().startswith("zh"):
            try:
                eng = _ocr.OcrEngine.try_create_from_language(_glob.Language(tag))
                if eng:
                    return eng, tag, None
            except Exception:
                pass
    return None, None, None


def _maybe_upscale(png_bytes: bytes, min_dim: int = 900, max_factor: float = 2.0):
    """LANCZOS-upscale small images so Chinese OCR has enough pixels. Returns (bytes, scale).

    scale==1.0 means no upscaling. When scale>1.0 the caller MUST divide bounding-box coordinates by
    `scale` to return them in the ORIGINAL image space (we do this inside _recognize).
    """
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(png_bytes))
        img.load()
        w, h = img.size
        m = min(w, h)
        if m >= min_dim or m <= 0:
            return png_bytes, 1.0
        factor = min(max_factor, max(1.5, float(min_dim) / float(m)))
        new_w = max(1, int(round(w * factor)))
        new_h = max(1, int(round(h * factor)))
        img = img.convert("RGB").resize((new_w, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue(), float(factor)
    except Exception:
        return png_bytes, 1.0


async def _recognize(png_bytes: bytes, lang: str | None) -> dict:
    payload = _coerce_bytes(png_bytes)

    # Upscale small captures for better Chinese recognition. Coordinates are scaled back below so
    # every caller still sees the original image coordinate space.
    payload, scale = await _run_blocking_bounded(
        lambda: _maybe_upscale(payload), _OCR_INPUT_TIMEOUT_S
    )

    stream = _streams.InMemoryRandomAccessStream()
    writer = _streams.DataWriter(stream.get_output_stream_at(0))
    _write_bytes_compat(writer, payload)
    await asyncio.wait_for(writer.store_async(), timeout=_OCR_DECODE_TIMEOUT_S)
    try:
        await asyncio.wait_for(writer.flush_async(), timeout=5)
    except asyncio.TimeoutError:
        pass
    try:
        writer.detach_stream()
    except Exception:
        pass
    stream.seek(0)
    decoder = await asyncio.wait_for(_imaging.BitmapDecoder.create_async(stream), timeout=_OCR_DECODE_TIMEOUT_S)
    bitmap = await asyncio.wait_for(decoder.get_software_bitmap_async(), timeout=_OCR_DECODE_TIMEOUT_S)

    engine, lang_used, fallback_from = _resolve_engine(lang)
    if engine is None:
        avail = _available_lang_tags()
        return {"error": "no OCR language pack available", "needs_language_pack": True,
                "available_languages": avail,
                "hint": "Add a language including its optional OCR feature via Settings > Language "
                        "(e.g. en-US or zh-Hans), then retry. Call ocr_available_languages to list "
                        "installed packs."}

    try:
        result = await asyncio.wait_for(engine.recognize_async(bitmap), timeout=_OCR_RECOGNIZE_TIMEOUT_S)
    except asyncio.TimeoutError:
        return {"ok": False, "error": f"ocr recognize timed out (>{_OCR_RECOGNIZE_TIMEOUT_S}s); "
                                      "the language pack may be corrupt or the image too large."}

    words = []
    inv = 1.0 / scale if scale and scale > 0 else 1.0
    for line in result.lines:
        for w in line.words:
            r = w.bounding_rect
            left = int(r.x * inv)
            top = int(r.y * inv)
            width = int(r.width * inv)
            height = int(r.height * inv)
            words.append({"text": w.text, "left": left, "top": top,
                          "width": width, "height": height,
                          "center": [left + width // 2, top + height // 2]})
    out = {"success": True, "text": result.text, "lines": [ln.text for ln in result.lines], "words": words}
    if lang_used:
        out["lang_used"] = lang_used
    if fallback_from:
        out["lang_fallback"] = {"requested": fallback_from, "used": lang_used}
    if scale and scale > 1.0:
        out["upscaled"] = scale
    try:
        conf = result.confidence
        if conf is not None:
            out["confidence"] = str(conf)
    except Exception:
        pass
    return out


async def _run_ocr_loader(loader, lang: str | None, input_stage: str) -> dict:
    acquired = False
    try:
        try:
            await asyncio.wait_for(_OCR_GATE.acquire(), timeout=_OCR_QUEUE_TIMEOUT_S)
            acquired = True
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "error": f"ocr busy (waited >{_OCR_QUEUE_TIMEOUT_S}s); retry shortly",
                "stage": "queue",
                "retryable": True,
            }

        try:
            payload = await _run_blocking_bounded(loader, _OCR_INPUT_TIMEOUT_S)
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "error": f"ocr {input_stage} timed out (>{_OCR_INPUT_TIMEOUT_S}s)",
                "stage": input_stage,
                "retryable": True,
            }

        try:
            return await asyncio.wait_for(
                _recognize(_coerce_bytes(payload), lang), timeout=_OCR_PIPELINE_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "error": f"ocr pipeline timed out (>{_OCR_PIPELINE_TIMEOUT_S}s)",
                "stage": "pipeline",
                "retryable": True,
            }
    except Exception as e:  # noqa: BLE001
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        message = str(e).lower()
        if "bytes-like" in message or "write_bytes" in message:
            out["hint"] = (
                "OCR could not pass the captured image to Windows.Media.Ocr. Ensure winsdk is "
                "current and retry; the tool now accepts bytes, bytearray, memoryview, and binary streams."
            )
        elif "language" in message:
            out["needs_language_pack"] = True
            out["hint"] = ("Add a language including its optional OCR feature via Settings > Language "
                           "(e.g. en-US or zh-Hans), then retry. Call ocr_available_languages to list packs.")
        return out
    finally:
        if acquired:
            _OCR_GATE.release()


async def _run_ocr(png_bytes: bytes, lang: str | None) -> dict:
    return await _run_ocr_loader(lambda: _coerce_bytes(png_bytes), lang, "input")


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
    """Run OCR on an image file. Returns recognized text + per-word bounding boxes (image coords).

    Args:
        path: Image file to OCR.
        lang: Optional language hint. Accepts friendly aliases: "zh"/"chinese"/"zh-CN" -> zh-Hans,
              "zh-TW"/"zh-Hant" -> zh-Hant, "ja", "ko", "en". Omit to auto-detect from the system locale.
    """
    if not _AVAILABLE:
        return _unavailable()
    if not os.path.exists(path):
        return {"error": f"file not found: {path}"}
    return await _run_ocr_loader(lambda: _png_bytes_from_path(path), lang, "image read")


@mcp.tool()
async def ocr_screen(region: str | None = None, lang: str | None = None) -> dict:
    """Run OCR on the whole screen, or a region "x,y,width,height".

    Word 'center' coordinates are SCREEN coordinates (region offset added), ready for mouse_click.

    Args:
        region: Optional "x,y,width,height" to restrict the search.
        lang: Optional language hint (zh/chinese/zh-CN -> zh-Hans, zh-TW/zh-Hant -> zh-Hant, ja, ko, en).
              Omit to auto-detect from the system locale (prefers Chinese on a zh-CN box).
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
    res = await _run_ocr_loader(lambda: _screenshot_png(bbox), lang, "screen capture")
    if res.get("success") and (ox or oy):
        for w in res.get("words", []):
            w["left"] += ox
            w["top"] += oy
            w["center"] = [w["center"][0] + ox, w["center"][1] + oy]
    return res


@mcp.tool()
async def ocr_available_languages() -> dict:
    """List installed OCR language packs (BCP-47 tags + display names).

    Use this to confirm whether Chinese OCR (zh-Hans-CN / zh-Hant-TW) is installed before relying on
    ocr_screen for Chinese text. If a tag is missing, add the language with its OCR feature via
    Settings > Time & Language > Language.
    """
    if not _AVAILABLE:
        return _unavailable()
    try:
        langs = getattr(_ocr.OcrEngine, "available_recognizer_languages", None)
        if langs is None:
            langs = getattr(_ocr.OcrEngine, "get_available_recognizer_languages", lambda: [])()
        items = [{"tag": str(l.language_tag), "name": str(l.display_name)} for l in langs]
        return {"ok": True, "languages": items, "count": len(items)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


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
        lang: Optional OCR language tag (zh/chinese/ja/ko/en accepted).
        nth: 0-based index into the (reading-order-sorted) matches to click.
        nearest_to: {"x","y"} - click the match closest to this screen point.
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
    # top-to-bottom / left-to-right and DPI-correct - a fixed-pixel row band mis-sorts at high DPI.
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
            # Usage error = execution refused (nothing was clicked), so ok MUST be False. The old
            # ok:True + error shape was self-contradictory: _normalize trusts an explicit ok key,
            # so callers saw a failed disambiguation reported as a successful call.
            return {"ok": False, "found": True, "clicked": None,
                    "error": f"nth={nth} out of range (0..{len(matches) - 1})",
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


def _is_cjk(s: str) -> bool:
    """True if `s` contains CJK ideographs (used to decide no-space phrase joining)."""
    for ch in s:
        o = ord(ch)
        if 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF or 0x3040 <= o <= 0x30FF \
                or 0xAC00 <= o <= 0xD7AF or 0xFF00 <= o <= 0xFFEF:
            return True
    return False


def _find_phrase(words: list[dict], text: str) -> dict | None:
    """Find `text` (case-insensitive) within a run of consecutive words; span their boxes.

    First tries a single word (fast path), then greedily joins consecutive words to match a phrase
    that spans word boundaries. For CJK text (no inter-word spaces) the joined string is ALSO matched
    without spaces, so a search for "系统设置" matches adjacent OCR words ["系统","设置"]. Returns a
    dict with rect/center/matched_text, or None.
    """
    target = " ".join(text.lower().split())
    if not target:
        return None
    cjk = _is_cjk(text)
    target_nospace = target.replace(" ", "") if cjk else None
    # Fast path: contained within one word.
    for w in words:
        wt = w["text"].lower()
        if target in wt or (target_nospace and target_nospace in wt.replace(" ", "")):
            return {"rect": {"left": w["left"], "top": w["top"], "width": w["width"], "height": w["height"]},
                    "center": w["center"], "matched_text": w["text"]}
    # Phrase path: join consecutive words with single spaces and look for the target substring.
    n = len(words)
    for i in range(n):
        joined = words[i]["text"].lower()
        joined_nospace = joined.replace(" ", "") if cjk else None
        if target in joined or (joined_nospace and target_nospace in joined_nospace):
            grp = [words[i]]
            return _span(grp, words[i]["text"])
        for j in range(i + 1, n):
            joined = joined + " " + words[j]["text"].lower()
            if cjk:
                joined_nospace = joined.replace(" ", "")
            if target in joined or (joined_nospace and target_nospace in joined_nospace):
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
        text: Text to find (case-insensitive; may span multiple OCR words; CJK needs no spaces).
        region: Optional "x,y,width,height" to restrict the search.
        click: If True, click the center of the match.
        lang: Optional OCR language tag (e.g. "en", "zh", "zh-Hans", "ja").

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
