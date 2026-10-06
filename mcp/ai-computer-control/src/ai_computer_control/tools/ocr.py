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
import contextvars
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


def _png_size(data: bytes):
    """(width, height) from a PNG's IHDR chunk without decoding, or None if `data` is not a PNG."""
    try:
        if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
            return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    except Exception:
        pass
    return None


def _maybe_upscale(png_bytes: bytes, min_dim: int = 900, max_factor: float = 2.0):
    """LANCZOS-upscale small images so Chinese OCR has enough pixels. Returns (bytes, scale).

    scale==1.0 means no upscaling. When scale>1.0 the caller MUST divide bounding-box coordinates by
    `scale` to return them in the ORIGINAL image space (we do this inside _recognize).
    """
    try:
        # Big frames (a full screen) never need upscaling: read the size from the PNG IHDR instead of
        # decoding the whole image just to look at it (observe/ocr_screen hit this on every call).
        hdr = _png_size(png_bytes)
        if hdr is not None and min(hdr) >= min_dim:
            return png_bytes, 1.0
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
    for line_no, line in enumerate(result.lines):
        for w in line.words:
            r = w.bounding_rect
            left = int(r.x * inv)
            top = int(r.y * inv)
            width = int(r.width * inv)
            height = int(r.height * inv)
            words.append({"text": w.text, "left": left, "top": top,
                          "width": width, "height": height,
                          "center": [left + width // 2, top + height // 2],
                          "line": line_no})
    # The FULL word list goes back to the callers: ocr_click / ocr_find_text must match against every word on
    # screen (a target past the 500th word used to read "not found"). Only the tool responses that hand the
    # list to the model are capped, by _cap_words().
    out = {"success": True, "text": result.text, "lines": [ln.text for ln in result.lines], "words": words,
           "words_total": len(words)}
    if lang_used:
        out["lang_used"] = lang_used
    if fallback_from:
        out["lang_fallback"] = {"requested": fallback_from, "used": lang_used}
    if scale and scale > 1.0:
        out["upscaled"] = scale
    # NOTE: Windows.Media.Ocr's OcrResult exposes no confidence (only Lines/Text/TextAngle), so none is
    # reported; ocr_click / ocr_find_text report 'match_type' (word|phrase) and near_matches instead.
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
    _IMG_READ_CAP = 50_000_000  # 50MB:防超大图整文件读 OOM;OCR pipeline 超时再兜底
    try:
        sz = os.path.getsize(path)
    except OSError:
        sz = 0
    if sz > _IMG_READ_CAP:
        raise ValueError(f"image too large ({sz} bytes > {_IMG_READ_CAP}); OCR 不支持超大图,请先用 image_resize 缩小")
    with open(path, "rb") as f:
        return f.read()


# Set by _screenshot_png (worker thread, inside the OCR gate) so ocr_screen can tell "OCR found no text"
# from "the frame it was given was all black". ocr_screen clears it before each capture.
_CAPTURE_STATE: dict = {}


def _png_bytes(img) -> bytes:
    """PNG-encode a frame for WinRT. compress_level=1: ~2x faster than the default at similar size."""
    buf = io.BytesIO()
    img.save(buf, "PNG", compress_level=1)
    return buf.getvalue()


def _screenshot_png(region=None) -> bytes:
    """Grab the screen (primary) or `region` bbox (x0,y0,x1,y1 in virtual-screen coords, any monitor)."""
    from ai_computer_control.utils.image import grab_screen, is_blank_frame
    if region:
        x0, y0, x1, y1 = region
        img, _info = grab_screen(region=(x0, y0, x1 - x0, y1 - y0))
    else:
        img, _info = grab_screen()
    _CAPTURE_STATE["blank"] = is_blank_frame(img)
    return _png_bytes(img)


# Words handed to the model per OCR tool response (ocr_screen / ocr_image). Matching tools search the full list:
# ocr_click / ocr_find_text call ocr_screen through _screen_words_uncapped, which flips this switch for the call.
_WORDS_CAP = 500
_UNCAPPED = contextvars.ContextVar("acc_ocr_uncapped", default=False)


def _cap_words(res: dict, cap: int | None = None) -> dict:
    """Cut the word list of a successful OCR result to `cap` (default _WORDS_CAP) and say so; in place.

    'text' and 'lines' stay complete. Adds truncated / words_total / hint only when words were dropped.
    """
    cap = _WORDS_CAP if cap is None else cap
    words = res.get("words")
    if res.get("success") and isinstance(words, list) and len(words) > cap:
        total = len(words)
        res["words"] = words[:cap]
        res["truncated"] = True
        res["words_total"] = total
        res["hint"] = f"仅返回前 {cap} 个词(共 {total} 个);缩小 region 或用 ocr_find_text 定位特定文本"
    else:
        res.pop("words_total", None)
    return res


@mcp.tool()
async def ocr_image(path: str, lang: str | None = None) -> dict:
    """Run OCR on an image file. Returns recognized text + per-word bounding boxes (image coords).

    Args:
        path: Image file to OCR.
        lang: Optional language hint: "zh"/"chinese"/"zh-CN" -> zh-Hans, "zh-TW"/"zh-Hant" -> zh-Hant, "ja", "ko",
            "en". Omit to auto-detect from the system locale.
    """
    if not _AVAILABLE:
        return _unavailable()
    if not os.path.exists(path):
        return {"error": f"file not found: {path}"}
    return _cap_words(await _run_ocr_loader(lambda: _png_bytes_from_path(path), lang, "image read"))


def _offset_words(res: dict, ox: int, oy: int) -> None:
    """Shift word coordinates from image space to screen space (in place)."""
    if res.get("success") and (ox or oy):
        for w in res.get("words", []):
            w["left"] += ox
            w["top"] += oy
            w["center"] = [w["center"][0] + ox, w["center"][1] + oy]


@mcp.tool()
async def ocr_screen(region: str | None = None, lang: str | None = None) -> dict:
    """Run OCR on the whole primary screen, or a region "x,y,width,height".

    Word 'center' coordinates are SCREEN coordinates (region offset added), ready for mouse_click. A region may lie
    on any monitor (negative x/y are valid); wholly outside the desktop is an error, partly outside is clipped.

    Args:
        region: Optional "x,y,width,height".
        lang: Optional language hint (zh/chinese/zh-CN, zh-TW/zh-Hant, ja, ko, en); omit to auto-detect from the
            system locale.

    Returns:
        dict with success, text, lines, words (each: text,left,top,width,height,center,line), origin {x,y} of the
        OCR'd area; 'truncated'/'words_total' when the word list was capped; 'blank': true for a completely black
        frame.
    """
    res = await _ocr_screen_words(region, lang)
    return res if _UNCAPPED.get() else _cap_words(res)


async def _screen_words_uncapped(region: str | None, lang: str | None) -> dict:
    """ocr_screen with the response cap off: every recognized word, for the tools that search by text."""
    token = _UNCAPPED.set(True)
    try:
        return await ocr_screen(region=region, lang=lang)
    finally:
        _UNCAPPED.reset(token)


async def _ocr_screen_words(region: str | None, lang: str | None) -> dict:
    """The capture + recognize + origin/blank bookkeeping behind ocr_screen (full word list)."""
    if not _AVAILABLE:
        return _unavailable()
    bbox = None
    ox = oy = 0
    if region:
        try:
            x, y, w, h = (int(v) for v in region.split(","))
        except Exception:
            return {"error": "region must be 'x,y,width,height'"}
        if w <= 0 or h <= 0:
            return {"error": "region width and height must be positive"}
        from ai_computer_control.utils.image import clip_to_virtual
        clipped, bounds = clip_to_virtual((x, y, w, h))
        if clipped is None:
            b = "unknown" if bounds is None else \
                f"x={bounds[0]}..{bounds[0] + bounds[2]}, y={bounds[1]}..{bounds[1] + bounds[3]}"
            return {"ok": False, "error": f"region ({x},{y},{w},{h}) is outside the virtual desktop ({b}); "
                                          "see get_screen_info/list_monitors for the valid coordinate space"}
        x, y, w, h = clipped
        bbox = (x, y, x + w, y + h)
        ox, oy = x, y
    _CAPTURE_STATE.clear()
    res = await _run_ocr_loader(lambda: _screenshot_png(bbox), lang, "screen capture")
    _offset_words(res, ox, oy)
    if res.get("success"):
        res["origin"] = {"x": ox, "y": oy}
        if _CAPTURE_STATE.get("blank"):
            from ai_computer_control.utils.image import BLANK_FRAME_HINT, BLANK_FRAME_WARNING
            res["blank"] = True
            res["warning"] = BLANK_FRAME_WARNING
            res["hint"] = BLANK_FRAME_HINT
    return res


async def ocr_frame(img, origin=(0, 0), lang: str | None = None) -> dict:
    """OCR an ALREADY-CAPTURED PIL frame (no second screen grab); words come back in SCREEN coordinates.

    `origin` is the virtual-screen coordinate of the frame's top-left pixel. Used by `observe` so the OCR
    words and the returned screenshot come from the same frame and the screen is grabbed only once.
    Not a tool.
    """
    if not _AVAILABLE:
        return _unavailable()
    from ai_computer_control.utils.image import is_blank_frame

    blank = is_blank_frame(img)
    res = await _run_ocr_loader(lambda: _png_bytes(img), lang, "frame encode")
    _offset_words(res, int(origin[0]), int(origin[1]))
    if res.get("success"):
        res["origin"] = {"x": int(origin[0]), "y": int(origin[1])}
        if blank:
            res["blank"] = True
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


def _is_cjk(s: str) -> bool:
    """True if `s` contains CJK ideographs (used to decide no-space phrase joining)."""
    for ch in s:
        o = ord(ch)
        if 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF or 0x3040 <= o <= 0x30FF \
                or 0xAC00 <= o <= 0xD7AF or 0xFF00 <= o <= 0xFFEF:
            return True
    return False


def _line_groups(words: list[dict]) -> list[list[int]]:
    """Indices of `words` grouped by text line, in reading order.

    Uses the engine's own 'line' index when every word carries one; otherwise (hand-built lists, older
    callers) infers lines geometrically: a new line starts when the next word's vertical centre leaves
    the previous word's box band or it starts left of where the previous word ended.
    """
    if not words:
        return []
    if all("line" in w for w in words):
        groups: dict = {}
        for idx, w in enumerate(words):
            groups.setdefault(w["line"], []).append(idx)
        return [groups[k] for k in sorted(groups, key=lambda k: groups[k][0])]
    out: list[list[int]] = [[0]]
    for idx in range(1, len(words)):
        prev, cur = words[idx - 1], words[idx]
        prev_cy = prev["top"] + prev["height"] / 2.0
        cur_cy = cur["top"] + cur["height"] / 2.0
        band = max(1.0, 0.6 * max(prev["height"], cur["height"]))
        backwards = cur["left"] < prev["left"] + prev["width"] - max(2, 0.5 * min(prev["width"], cur["width"]))
        if abs(cur_cy - prev_cy) > band or backwards:
            out.append([idx])
        else:
            out[-1].append(idx)
    return out


def _stream_hits(stream: list[tuple[int, str]], needle: str, joiner: str) -> list[tuple[int, int]]:
    """Non-overlapping occurrences of `needle` in the words of `stream` joined by `joiner`.

    Returns (first_pos, last_pos) stream positions of the words each occurrence overlaps - exactly the
    words that carry the match, no unrelated neighbours.
    """
    spans, parts, cursor = [], [], 0
    for pos, (_idx, txt) in enumerate(stream):
        if parts:
            cursor += len(joiner)
        spans.append((cursor, cursor + len(txt)))
        parts.append(txt)
        cursor += len(txt)
    hay = joiner.join(parts)
    hits, start = [], 0
    while needle:
        at = hay.find(needle, start)
        if at < 0:
            break
        end = at + len(needle)
        covered = [pos for pos, (a, b) in enumerate(spans) if b > at and a < end and b > a]
        if covered:
            hits.append((covered[0], covered[-1]))
        start = end
    return hits


def _phrase_matches(words: list[dict], text: str) -> list[dict]:
    """Every match of `text` (case-insensitive) in reading order, each spanning exactly its own words.

    1. Single-word matches: `text` contained in one OCR word (CJK: also ignoring spaces).
    2. If there are none, phrase matches: consecutive words of ONE LINE whose joined text contains `text`
       (Latin: joined with a space; CJK: ALSO joined without, so "系统设置" matches ["系统","设置"]).
       Lines are never joined with each other unless `text` itself contains a line break.
    Each match is {rect, center, matched_text, match_type: 'word'|'phrase', word_count}; the rect is the
    union box of only the matched words and `center` is that box's centre (the click point).
    """
    raw = str(text or "")
    target = " ".join(raw.lower().split())
    if not target:
        return []
    cjk = _is_cjk(raw)
    target_ns = target.replace(" ", "") if cjk else None

    singles = []
    for w in words:
        wt = str(w.get("text", "")).lower()
        if target in wt or (target_ns and target_ns in wt.replace(" ", "")):
            singles.append(_span([w], w["text"], "word"))
    if singles:
        return singles

    if "\n" in raw or "\r" in raw:
        groups = [list(range(len(words)))]  # the phrase itself spans lines: one stream over the page
    else:
        groups = _line_groups(words)
    found: list[tuple[int, int]] = []  # (first_word_idx, last_word_idx)
    for grp in groups:
        stream = [(idx, str(words[idx].get("text", "")).lower()) for idx in grp
                  if str(words[idx].get("text", "")).strip()]
        if len(stream) < 2:
            continue
        hits = _stream_hits(stream, target, " ")
        if cjk:
            ns_stream = [(idx, t.replace(" ", "")) for idx, t in stream]
            hits += _stream_hits(ns_stream, target_ns, "")
        for a, b in hits:
            pair = (stream[a][0], stream[b][0])
            if pair[0] != pair[1] and pair not in found:
                found.append(pair)
    found.sort()
    out = []
    for first, last in found:
        grp_words = [words[k] for k in range(first, last + 1)
                     if str(words[k].get("text", "")).strip()]
        out.append(_span(grp_words, " ".join(str(x["text"]) for x in grp_words), "phrase"))
    return out


def _find_phrase(words: list[dict], text: str) -> dict | None:
    """First match of `text` in reading order (see _phrase_matches), or None.

    The returned rect/center cover exactly the matched words (never unrelated leading words), so the
    centre is a safe click point; a phrase never spans two text lines unless `text` has a line break.
    """
    hits = _phrase_matches(words, text)
    return hits[0] if hits else None


def _span(group: list[dict], matched: str, match_type: str = "phrase") -> dict:
    left = min(w["left"] for w in group)
    top = min(w["top"] for w in group)
    right = max(w["left"] + w["width"] for w in group)
    bottom = max(w["top"] + w["height"] for w in group)
    if len(group) == 1 and group[0].get("center"):
        center = list(group[0]["center"])
    else:
        center = [int((left + right) / 2), int((top + bottom) / 2)]
    return {"rect": {"left": left, "top": top, "width": right - left, "height": bottom - top},
            "center": center, "matched_text": matched, "match_type": match_type,
            "word_count": len(group)}


def _near_matches(words: list[dict], text: str, limit: int = 5, min_score: float = 0.6) -> list[dict]:
    """Closest OCR candidates for a missed query: single words plus 2-3 word joins within a line."""
    import difflib
    target = " ".join(str(text or "").lower().split())
    if not target:
        return []
    cands = []
    for grp in _line_groups(words):
        ws = [words[i] for i in grp if str(words[i].get("text", "")).strip()]
        for n in (1, 2, 3):
            for k in range(0, len(ws) - n + 1):
                chunk = ws[k:k + n]
                cands.append((" ".join(str(c["text"]) for c in chunk), chunk))
    scored = []
    sm = difflib.SequenceMatcher(autojunk=False)
    sm.set_seq2(target)
    for label, chunk in cands:
        sm.set_seq1(label.lower())
        if sm.real_quick_ratio() < min_score or sm.quick_ratio() < min_score:
            continue
        score = sm.ratio()
        if score >= min_score:
            scored.append((score, label, chunk))
    scored.sort(key=lambda t: -t[0])
    out, seen = [], set()
    for score, label, chunk in scored:
        m = _span(chunk, label, "fuzzy")
        key = (label.lower(), tuple(m["center"]))
        if key in seen:
            continue
        seen.add(key)
        out.append({"text": label, "center": m["center"], "rect": m["rect"], "score": round(score, 3)})
        if len(out) >= limit:
            break
    return out


def _miss_details(res: dict, text: str) -> dict:
    """Diagnostics for an OCR search miss: what OCR saw, near matches, and what to try next."""
    words = res.get("words", [])
    out = {"words_seen": len(words)}
    if res.get("lang_used"):
        out["lang_used"] = res["lang_used"]
    if res.get("truncated"):
        out["truncated"] = True
        out["words_total"] = res.get("words_total")
    if res.get("blank"):
        out["blank"] = True
    near = _near_matches(words, text)
    if near:
        out["near_matches"] = near
    if not words:
        out["hint"] = ("OCR read no text at all: the captured area may be blank/black or on another "
                       "monitor (check screenshot / get_screen_info), or the OCR language pack does not "
                       "match the text (try lang=).")
    else:
        out["hint"] = ("Text not found. Try lang= for the screen's language, a smaller region, ocr_screen "
                       "to read what OCR actually sees, or ui_find for UI Automation controls."
                       + (" 'near_matches' lists the closest candidates." if near else ""))
    return out


@mcp.tool(audit=True)
async def ocr_click(text: str, region: str | None = None, lang: str | None = None,
                    nth: int | None = None, nearest_to: dict | None = None,
                    return_candidates: bool = False) -> dict:
    """OCR the screen (or region), find `text` (case-insensitive), and click its center.

    `text` may be part of one OCR word or a multi-word phrase (CJK needs no spaces: "系统设置" matches OCR words
    ["系统","设置"]); a phrase never spans two lines. The click lands on the centre of exactly the matched words.
    Several matches: default = first in reading order (top-to-bottom, left-to-right); nth = the nth (0-based);
    nearest_to = closest to a point; return_candidates=True clicks nothing and returns every match.

    Args:
        text: Text to find (word/substring or phrase).
        region: Optional "x,y,width,height".
        lang: Optional OCR language tag (zh/chinese/ja/ko/en).
        nth: 0-based index into the reading-order matches.
        nearest_to: {"x","y"}; click the closest match.
        return_candidates: Return all matches without clicking.

    Returns dict with 'success'+'clicked' (matched word/phrase, 'match_type'), 'candidates' (when
    return_candidates or ambiguous); on a miss 'not_found' + 'found': false + 'words_seen', 'near_matches'
    (closest OCR text with score) + 'hint'; or 'error'.
    """
    if not _AVAILABLE:
        return _unavailable()
    res = await _screen_words_uncapped(region, lang)  # full word list: match everything on screen, not the first 500
    if not res.get("success"):
        return res
    # Keep the OCR engine's native reading order (result.lines -> line.words), which is already
    # top-to-bottom / left-to-right and DPI-correct - a fixed-pixel row band mis-sorts at high DPI.
    matches = []
    for m in _phrase_matches(res.get("words", []), text):
        left, top = m["rect"]["left"], m["rect"]["top"]
        matches.append({"text": m["matched_text"], "left": left, "top": top,
                        "width": m["rect"]["width"], "height": m["rect"]["height"],
                        "center": m["center"], "match_type": m["match_type"]})
    if not matches:
        return {"ok": True, "not_found": True, "found": False, "text": text, "clicked": None,
                **_miss_details(res, text)}

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


@mcp.tool(audit=True)
async def ocr_find_text(text: str, region: str | None = None, click: bool = False,
                        lang: str | None = None) -> dict:
    """OCR the screen (or a region) and locate `text`, spanning adjacent words if needed.

    Coordinates are SCREEN coordinates (region offset applied), so 'center' is directly clickable. A multi-word
    phrase matches consecutive words of one line only; center/rect cover exactly the matched words.

    Args:
        text: Text to find (case-insensitive; may span several OCR words; CJK needs no spaces).
        region: Optional "x,y,width,height".
        click: If True, click the center of the match.
        lang: Optional OCR language tag (e.g. "en", "zh", "zh-Hans", "ja").

    Returns:
        dict with ok, found, and on success center:{x,y}, rect, matched_text, match_type ('word'|'phrase'), count
        (matches on screen; the first in reading order is returned) (+ clicked). On a miss: found false +
        words_seen, near_matches and a hint.
    """
    if not _AVAILABLE:
        return _unavailable()
    res = await _screen_words_uncapped(region, lang)  # full word list: match everything on screen, not the first 500
    if not res.get("success"):
        return res
    all_matches = _phrase_matches(res.get("words", []), text)
    if not all_matches:
        return {"ok": True, "found": False, "text": text, **_miss_details(res, text)}
    match = all_matches[0]
    out = {"ok": True, "found": True, "center": {"x": match["center"][0], "y": match["center"][1]},
           "rect": match["rect"], "matched_text": match["matched_text"],
           "match_type": match["match_type"], "count": len(all_matches)}
    if click:
        try:
            import pyautogui
            pyautogui.click(match["center"][0], match["center"][1])
            out["clicked"] = True
        except Exception as e:  # noqa: BLE001
            out["clicked"] = False
            out["click_error"] = str(e)
    return out
