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


def _screen_gray():
    from PIL import ImageGrab
    img = ImageGrab.grab().convert("RGB")
    arr = np.array(img)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)


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


def _match(screen, templ, confidence, scales, find_all):
    hits = []
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
        else:
            _minv, maxv, _minl, maxl = cv2.minMaxLoc(res)
            if maxv >= confidence:
                hits.append((float(maxv), maxl[0], maxl[1], nw, nh))
    return hits


def _dedupe(hits, min_dist=12):
    hits.sort(key=lambda h: h[0], reverse=True)
    kept = []
    for score, x, y, w, h in hits:
        cx, cy = x + w // 2, y + h // 2
        if all(abs(cx - (k[1] + k[3] // 2)) > min_dist or abs(cy - (k[2] + k[4] // 2)) > min_dist for k in kept):
            kept.append((score, x, y, w, h))
    return kept


def _boxes(hits):
    return [{"confidence": round(s, 3), "left": x, "top": y, "width": w, "height": h,
             "center": [x + w // 2, y + h // 2]} for (s, x, y, w, h) in hits]


@mcp.tool()
def find_template(template_path: str | None = None, template_b64: str | None = None,
                  confidence: float = 0.8, multiscale: bool = True) -> dict:
    """Locate a template image on screen (multi-scale). Returns best match with 'center' for clicking."""
    if not _AVAILABLE:
        return _unavailable()
    templ, err = _load_template_gray(template_path, template_b64)
    if err:
        return err
    scales = [1.0, 0.9, 1.1, 0.8, 1.25, 0.75, 1.5] if multiscale else [1.0]
    hits = _match(_screen_gray(), templ, confidence, scales, find_all=False)
    if not hits:
        return {"found": False}
    best = max(hits, key=lambda h: h[0])
    return {"found": True, "match": _boxes([best])[0]}


@mcp.tool()
def find_all_templates(template_path: str | None = None, template_b64: str | None = None,
                       confidence: float = 0.85, multiscale: bool = False, max_results: int = 50) -> dict:
    """Find all occurrences of a template on screen (deduped)."""
    if not _AVAILABLE:
        return _unavailable()
    templ, err = _load_template_gray(template_path, template_b64)
    if err:
        return err
    scales = [1.0, 0.9, 1.1] if multiscale else [1.0]
    hits = _dedupe(_match(_screen_gray(), templ, confidence, scales, find_all=True))
    return {"count": len(hits[:max_results]), "matches": _boxes(hits[:max_results])}


@mcp.tool(audit=True)
def vision_click(template_path: str | None = None, template_b64: str | None = None,
                 threshold: float = 0.8, click: bool = True, multiscale: bool = True) -> dict:
    """Locate a template on screen (multi-scale) and optionally click its center.

    Args:
        template_path: Path to the template image (or pass template_b64).
        template_b64: Base64-encoded template image (alternative to template_path).
        threshold: Match confidence threshold (0.0-1.0).
        click: If True (default), click the match center.
        multiscale: Try several scales for robustness to DPI/zoom differences.

    Returns:
        dict with ok, found, and on success center:{x,y}, confidence, rect (+ clicked if click).
    """
    if not _AVAILABLE:
        return _unavailable()
    templ, err = _load_template_gray(template_path, template_b64)
    if err:
        return {"ok": False, **err}
    scales = [1.0, 0.9, 1.1, 0.8, 1.25, 0.75, 1.5] if multiscale else [1.0]
    hits = _match(_screen_gray(), templ, threshold, scales, find_all=False)
    if not hits:
        return {"ok": True, "found": False}
    best = _boxes([max(hits, key=lambda h: h[0])])[0]
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
                   confidence: float = 0.8, timeout: float = 10.0, poll_ms: int = 400) -> dict:
    """Poll the screen until a template appears (or timeout). Returns the match for clicking."""
    if not _AVAILABLE:
        return _unavailable()
    deadline = time.monotonic() + max(0.0, float(timeout))
    while True:
        res = find_template(template_path=template_path, template_b64=template_b64, confidence=confidence, multiscale=False)
        if res.get("error"):
            return res  # bad template path/b64 — surface immediately instead of polling to timeout
        if res.get("found"):
            return res
        if time.monotonic() >= deadline:
            return {"found": False, "timeout": timeout}
        time.sleep(poll_ms / 1000.0)
