"""Template matching on screen via OpenCV (multi-scale, grayscale).

Requires `opencv-python-headless` + `numpy` (~50MB of wheels). Optional: if unavailable, the tools
return an install hint. Complements the built-in `find_on_screen` with multi-scale + find-all + wait.
"""

import base64
import io
import time

from ai_computer_control.server import mcp

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    _AVAILABLE = True
    _IMPORT_ERROR = ""
except Exception as e:  # noqa: BLE001 — optional dependency
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)


def _unavailable() -> dict:
    return {"error": "opencv/numpy not installed", "hint": "Add 'opencv-python-headless' and 'numpy' to "
            "requirements_offline.txt and reinstall (update.bat --deps + rebuild).", "detail": _IMPORT_ERROR}


# Scale ladder for multi-scale matching, most likely first (early exit stops at the first strong hit):
# 100/125/150/175/200% DPI ratios in both directions plus a few zoom steps.
_MULTISCALE = [1.0, 1.25, 1.5, 0.8, 0.667, 1.75, 2.0, 0.5, 0.9, 1.1, 0.75]
# A match this good ends the scale search early (a 1.0 exact hit costs 1 scale instead of all of them).
_EARLY_EXIT = 0.97


def _parse_region(region):
    """'x,y,width,height' (or a 4-sequence) -> (x, y, w, h) ints, or a ValueError with a human message."""
    if region is None or region == "":
        return None
    try:
        parts = [int(str(v).strip()) for v in (region.split(",") if isinstance(region, str) else region)]
    except (TypeError, ValueError):
        raise ValueError("region must be 'x,y,width,height' with integers") from None
    if len(parts) != 4 or parts[2] <= 0 or parts[3] <= 0:
        raise ValueError("region must be 'x,y,width,height' with positive width and height")
    return tuple(parts)


def _screen_gray(region=None):
    """Grayscale screen frame and its origin (virtual-screen x, y of the top-left pixel).

    Default: primary monitor. `region` (x,y,w,h in virtual-screen coordinates) may lie on any monitor
    and makes matching several times cheaper; a region outside the desktop raises ValueError."""
    from ai_computer_control.utils.image import grab_screen
    img, info = grab_screen(region=_parse_region(region))
    arr = np.array(img.convert("RGB"))
    o = info.get("origin") or {"x": 0, "y": 0}
    return cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY), (int(o["x"]), int(o["y"]))


def _load_template_gray(template_path: str | None, template_b64: str | None):
    """Return (image, error). error is a dict when loading fails; image is None only when no arg given."""
    if template_b64:
        try:
            raw = base64.b64decode(template_b64.split(",").pop())
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        except Exception as e:  # noqa: BLE001
            return None, {"error": f"invalid template_b64: {e}"}
        if img is None:
            return None, {"error": "template_b64 did not decode to an image"}
        return img, None
    if template_path:
        img = cv2.imread(template_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return None, {"error": f"could not load template image: {template_path}"}
        return img, None
    return None, {"error": "provide template_path or template_b64"}


def _match(screen, templ, confidence, scales, find_all, early_exit=_EARLY_EXIT):
    """Template-match `templ` over `screen` at each scale. Returns (hits, best).

    hits: [(score, x, y, w, h)] at/above `confidence`. best: (score, scale) of the strongest match seen
    at ANY scale (None if no scale fit), so a miss can still report how close it was. In single-match
    mode the scale loop stops as soon as one scale scores >= max(confidence, early_exit)."""
    hits = []
    best = None
    sh, sw = screen.shape[:2]
    for scale in scales:
        th, tw = templ.shape[:2]
        nw, nh = int(tw * scale), int(th * scale)
        if nw < 8 or nh < 8 or nw > sw or nh > sh:
            continue
        resized = cv2.resize(templ, (nw, nh)) if scale != 1.0 else templ
        res = cv2.matchTemplate(screen, resized, cv2.TM_CCOEFF_NORMED)
        if find_all:
            ys, xs = np.where(res >= confidence)
            for (x, y) in zip(xs.tolist(), ys.tolist()):
                hits.append((float(res[y, x]), x, y, nw, nh))
            if res.size:
                top = float(res.max())
                if best is None or top > best[0]:
                    best = (top, scale)
        else:
            _minv, maxv, _minl, maxl = cv2.minMaxLoc(res)
            if best is None or float(maxv) > best[0]:
                best = (float(maxv), scale)
            if maxv >= confidence:
                hits.append((float(maxv), maxl[0], maxl[1], nw, nh))
                if maxv >= max(confidence, early_exit):
                    break
    return hits, best


def _dedupe(hits, min_dist=12):
    hits.sort(key=lambda h: h[0], reverse=True)
    kept = []
    for score, x, y, w, h in hits:
        cx, cy = x + w // 2, y + h // 2
        if all(abs(cx - (k[1] + k[3] // 2)) > min_dist or abs(cy - (k[2] + k[4] // 2)) > min_dist for k in kept):
            kept.append((score, x, y, w, h))
    return kept


def _boxes(hits, origin=(0, 0)):
    """Hit boxes in SCREEN coordinates (`origin` = virtual-screen position of the searched frame)."""
    ox, oy = origin
    return [{"confidence": round(s, 3), "left": x + ox, "top": y + oy, "width": w, "height": h,
             "center": [x + ox + w // 2, y + oy + h // 2]} for (s, x, y, w, h) in hits]


def _miss(confidence, best, extra=None):
    """The not-found payload: how close the best candidate was, so 'nearly' is distinguishable from 'absent'."""
    out = {"found": False, "threshold": confidence}
    if best is not None and best[0] != best[0]:  # NaN (flat template/region): no usable score
        best = None
    if best is None:
        out["best_confidence"] = None
        out["hint"] = "the template is larger than the searched area at every scale tried; widen the region"
    else:
        out["best_confidence"] = round(best[0], 3)
        out["best_scale"] = best[1]
        if best[0] >= confidence - 0.15:
            out["hint"] = (f"a near match exists (score {best[0]:.2f} < threshold {confidence:.2f}); lower the "
                           f"threshold slightly, re-capture the template at the current DPI, or narrow region")
        else:
            out["hint"] = ("no similar pixels found; the template is probably not visible (other monitor? "
                           "pass region=; or use ocr_find_text / ui_find)")
    if extra:
        out.update(extra)
    return out


@mcp.tool()
def find_template(template_path: str | None = None, template_b64: str | None = None,
                  confidence: float = 0.8, multiscale: bool = True, region: str | None = None) -> dict:
    """Locate a template image on screen (multi-scale). Returns best match with 'center' for clicking.

    region: optional "x,y,width,height" (virtual-screen coordinates, any monitor) - much faster than a
    full-screen search and the only way to search a non-primary monitor. Without it the primary monitor
    is searched. Returned coordinates are screen coordinates either way. A miss carries
    'best_confidence' (how close the best candidate was) and a hint.
    """
    if not _AVAILABLE:
        return _unavailable()
    templ, err = _load_template_gray(template_path, template_b64)
    if err:
        return err
    scales = list(_MULTISCALE) if multiscale else [1.0]
    try:
        screen, origin = _screen_gray(region)
    except ValueError as e:
        return {"error": str(e)}
    hits, best = _match(screen, templ, confidence, scales, find_all=False)
    if not hits:
        return _miss(confidence, best)
    top = max(hits, key=lambda h: h[0])
    return {"found": True, "match": _boxes([top], origin)[0]}


@mcp.tool()
def find_all_templates(template_path: str | None = None, template_b64: str | None = None,
                       confidence: float = 0.85, multiscale: bool = False, max_results: int = 50,
                       region: str | None = None) -> dict:
    """Find all occurrences of a template on screen (deduped). Optional region "x,y,width,height"
    (virtual-screen coordinates) restricts and speeds up the search; matches are in screen coordinates."""
    if not _AVAILABLE:
        return _unavailable()
    templ, err = _load_template_gray(template_path, template_b64)
    if err:
        return err
    scales = [1.0, 0.9, 1.1] if multiscale else [1.0]
    try:
        screen, origin = _screen_gray(region)
    except ValueError as e:
        return {"error": str(e)}
    hits, _best = _match(screen, templ, confidence, scales, find_all=True)
    hits = _dedupe(hits)
    return {"count": len(hits[:max_results]), "matches": _boxes(hits[:max_results], origin)}


@mcp.tool(audit=True)
def vision_click(template_path: str | None = None, template_b64: str | None = None,
                 threshold: float = 0.8, click: bool = True, multiscale: bool = True,
                 region: str | None = None) -> dict:
    """Locate a template on screen (multi-scale) and optionally click its center.

    Args:
        template_path: Path to the template image (or pass template_b64).
        template_b64: Base64-encoded template image (alternative to template_path).
        threshold: Match confidence threshold (0.0-1.0; clamped to [0.05, 1.0]).
        click: If True (default), click the match center.
        multiscale: Try several scales (0.5x-2x, covering 100-200% DPI ratios) for robustness to
            DPI/zoom differences; stops early once a scale matches >= 0.97.
        region: Optional "x,y,width,height" in virtual-screen coordinates. Without it only the PRIMARY
            monitor is searched; pass a region to search another monitor (also much faster).

    Returns:
        dict with ok, found, and on success center:{x,y} (screen coordinates), confidence, rect (+ clicked
        if click). On a miss: found false + best_confidence / best_scale (how close the closest candidate
        was) + hint.
    """
    if not _AVAILABLE:
        return _unavailable()
    templ, err = _load_template_gray(template_path, template_b64)
    if err:
        return {"ok": False, **err}
    # b2-P1: threshold 钳制到 [0.05, 1.0] —— 传 0.0 会几乎全命中导致随机误点
    try:
        threshold = float(threshold)
    except (TypeError, ValueError):
        threshold = 0.8
    threshold = max(0.05, min(1.0, threshold))
    scales = list(_MULTISCALE) if multiscale else [1.0]
    try:
        screen, origin = _screen_gray(region)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    hits, best_seen = _match(screen, templ, threshold, scales, find_all=False)
    if not hits:
        return {"ok": True, **_miss(threshold, best_seen)}
    best = _boxes([max(hits, key=lambda h: h[0])], origin)[0]
    out = {"ok": True, "found": True, "confidence": best["confidence"],
           "center": {"x": best["center"][0], "y": best["center"][1]},
           "rect": {"left": best["left"], "top": best["top"],
                    "width": best["width"], "height": best["height"]}}
    if click:
        try:
            import pyautogui
            pyautogui.click(best["center"][0], best["center"][1])
            out["clicked"] = True
        except Exception as e:  # noqa: BLE001
            out["clicked"] = False
            out["click_error"] = str(e)
    return out


@mcp.tool()
def wait_for_image(template_path: str | None = None, template_b64: str | None = None,
                   confidence: float = 0.8, timeout: float = 10.0, poll_ms: int = 400,
                   region: str | None = None) -> dict:
    """Poll the screen until a template appears (or timeout). Returns the match for clicking.

    region: optional "x,y,width,height" (virtual-screen coordinates) to poll a smaller/other-monitor area.
    On timeout the result has waited_ms and best_confidence (the closest score seen while polling)."""
    if not _AVAILABLE:
        return _unavailable()
    started = time.monotonic()
    deadline = started + max(0.0, float(timeout))
    best_seen = None
    while True:
        res = find_template(template_path=template_path, template_b64=template_b64, confidence=confidence,
                            multiscale=False, region=region)
        if res.get("error"):
            return res  # bad template path/b64/region — surface immediately instead of polling to timeout
        if res.get("found"):
            return res
        bc = res.get("best_confidence")
        if bc is not None and (best_seen is None or bc > best_seen):
            best_seen = bc
        if time.monotonic() >= deadline:
            out = {"found": False, "timeout": timeout,
                   "waited_ms": int((time.monotonic() - started) * 1000), "best_confidence": best_seen}
            if best_seen is not None and best_seen >= confidence - 0.15:
                out["hint"] = (f"closest score {best_seen:.2f} < threshold {confidence:.2f}; the template may "
                               "differ slightly (DPI/theme) - lower confidence or re-capture it")
            return out
        time.sleep(poll_ms / 1000.0)
