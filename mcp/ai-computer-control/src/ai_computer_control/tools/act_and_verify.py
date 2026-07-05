"""`act_and_verify` — perform one UI action and measure whether the screen actually changed.

Pattern: capture BEFORE -> execute the action (click / type / key) -> brief settle wait -> capture
AFTER -> compute the fraction of pixels that differ. To keep the signal meaningful, a click with no
explicit region is diffed inside a tight box around the click point (whole-screen ambient churn — a
blinking clock, a toast — would otherwise swamp a small real change, or a one-char edit would read as
"nothing happened"). A whole-screen `changed_ratio_full` is always returned too so a change that
lands elsewhere (a dropdown, a dialog) is never missed.
"""

import os
import time

from ai_computer_control.server import mcp
from ai_computer_control.paths import data_dir

_VALID_ACTIONS = ("click", "type", "key")


def _shots_dir() -> str:
    d = os.path.join(data_dir(), "shots")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


def _grab(region_tuple):
    import pyautogui
    return pyautogui.screenshot(region=region_tuple) if region_tuple else pyautogui.screenshot()


def _virtual_bounds():
    """(x, y, w, h) of the whole virtual desktop (all monitors)."""
    import ctypes
    u = ctypes.windll.user32
    return (u.GetSystemMetrics(76), u.GetSystemMetrics(77),
            u.GetSystemMetrics(78), u.GetSystemMetrics(79))


def _clamp_roi(x, y, w, h):
    """Clamp a region of interest to the virtual-desktop bounds so an edge/negative-coord click box
    can't crash the grab/crop."""
    try:
        vx, vy, vw, vh = _virtual_bounds()
    except Exception:
        vx, vy, vw, vh = 0, 0, 100000, 100000
    x = max(vx, min(int(x), vx + vw - 2))
    y = max(vy, min(int(y), vy + vh - 2))
    w = max(2, min(int(w), vx + vw - x))
    h = max(2, min(int(h), vy + vh - y))
    return (x, y, w, h)


def _foreground_rect():
    """(x, y, w, h) of the foreground window, or None."""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    try:
        hwnd = u.GetForegroundWindow()
        if not hwnd:
            return None
        r = wintypes.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        if w <= 0 or h <= 0:
            return None
        return (r.left, r.top, w, h)
    except Exception:
        return None


def _changed_stats(before, after):
    """(ratio, changed_pixels, total_pixels) over a small tolerance. Best-effort -> (0.0, 0, 0)."""
    try:
        from PIL import Image, ImageChops
        if before.size != after.size:
            after = after.resize(before.size, Image.NEAREST)
        gray = ImageChops.difference(before.convert("RGB"), after.convert("RGB")).convert("L")
        hist = gray.histogram()
        total = before.size[0] * before.size[1]
        if total <= 0:
            return 0.0, 0, 0
        tol = 16  # ignore sub-16 level noise (font AA, cursor blink)
        changed = sum(hist[tol:])
        return round(changed / float(total), 4), int(changed), int(total)
    except Exception:
        return 0.0, 0, 0


def _crop(img, region):
    """Crop `img` (a primary-screen grab, origin 0,0) to `region` (screen coords), clamped to the
    image. Returns the cropped image, or None if the clamped box is degenerate/off this grab."""
    try:
        x, y, w, h = region
        L, T = max(0, x), max(0, y)
        R, B = min(img.width, x + w), min(img.height, y + h)
        if R - L < 2 or B - T < 2:
            return None
        return img.crop((L, T, R, B))
    except Exception:
        return None


def _do_action(action: dict) -> dict:
    """Execute a single {type: click|type|key, ...} action via the existing tool functions."""
    atype = (action.get("type") or "").lower()
    if atype not in _VALID_ACTIONS:
        return {"ok": False, "error": f"action.type must be one of {_VALID_ACTIONS}, got {atype!r}"}
    if atype == "click":
        from ai_computer_control.tools.mouse import mouse_click
        x, y = action.get("x"), action.get("y")
        if x is None or y is None:
            return {"ok": False, "error": "click action requires x and y"}
        return mouse_click(int(x), int(y), button=action.get("button", "left"),
                           clicks=int(action.get("clicks", 1)))
    if atype == "type":
        from ai_computer_control.tools.keyboard import type_text
        return type_text(str(action.get("text", "")),
                         use_clipboard=action.get("use_clipboard", None))
    # key
    from ai_computer_control.tools.keyboard import press_key
    key = action.get("key")
    if not key:
        return {"ok": False, "error": "key action requires 'key'"}
    return press_key(str(key))


@mcp.tool(audit=True)
def act_and_verify(action: dict, region: str | None = None, settle_ms: int = 500,
                   save_shots: bool = True) -> dict:
    """Do one UI action and report how much the screen changed as a result.

    Args:
        action: {"type": "click"|"type"|"key", ...}.
            click -> requires x, y (physical screen coords); optional button, clicks.
            type  -> requires text; optional use_clipboard (better for CJK).
            key   -> requires key (e.g. "enter", "ctrl+s").
        region: Optional "x,y,width,height" limiting the diff (screen coords). If omitted, a click is
            diffed in a ~200x200 box around the click point and a type/key in the foreground window
            rect — pass the target field's rect here for the tightest, most reliable signal.
        settle_ms: Milliseconds to wait after the action before the AFTER capture (UI settle).
        save_shots: Persist before/after PNGs under <data>/shots and return their paths.

    Returns:
        dict with ok, changed_ratio (fraction changed inside the region of interest), changed_pixels
        (raw count), changed_ratio_full (whole-screen — catches effects that land elsewhere),
        action_result, region, and before_path/after_path when save_shots. A near-zero changed_ratio
        with a near-zero changed_ratio_full strongly implies the action had no effect; a near-zero
        region ratio but nonzero full ratio means something changed OUTSIDE the region of interest.
    """
    # Determine a region of interest. Explicit region wins; otherwise narrow to the action locus so a
    # small real change is distinguishable from ambient churn (and from "nothing happened").
    region_tuple = None
    region_auto = None
    if region:
        try:
            x, y, w, h = (int(v.strip()) for v in region.split(","))
            region_tuple = (x, y, w, h)
        except Exception:
            return {"ok": False, "error": "region must be 'x,y,width,height'"}
    else:
        atype = (action or {}).get("type", "").lower()
        if atype == "click" and action.get("x") is not None and action.get("y") is not None:
            region_tuple = _clamp_roi(int(action["x"]) - 100, int(action["y"]) - 100, 200, 200)
            region_auto = "click-box"
        elif atype in ("type", "key"):
            fr = _foreground_rect()
            if fr:
                region_tuple = _clamp_roi(*fr)
                region_auto = "foreground-window"

    # One before/after pair brackets the single action; we derive BOTH the whole-screen ratio and the
    # region ratio from it (never executing the action twice).
    try:
        before_full = _grab(None)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"before-capture failed: {e}"}

    action_result = _do_action(action or {})
    if not action_result.get("ok", False):
        return {"ok": False, "error": "action failed", "action_result": action_result}

    time.sleep(max(0, int(settle_ms)) / 1000.0)

    try:
        after_full = _grab(None)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"after-capture failed: {e}", "action_result": action_result}

    ratio_full, px_full, _ = _changed_stats(before_full, after_full)
    if region_tuple:
        bcrop, acrop = _crop(before_full, region_tuple), _crop(after_full, region_tuple)
        if bcrop is not None and acrop is not None:
            ratio, px, _ = _changed_stats(bcrop, acrop)
        else:
            # Region is off the primary grab (e.g. a secondary monitor) — fall back to whole-screen.
            ratio, px = ratio_full, px_full
            region_auto = (region_auto or "region") + " (off primary; used full screen)"
    else:
        ratio, px = ratio_full, px_full

    out = {"ok": True, "changed_ratio": ratio, "changed_pixels": px,
           "changed_ratio_full": ratio_full, "action_result": action_result, "region": region_tuple}
    if region_auto:
        out["region_auto"] = region_auto
    if save_shots:
        try:
            ts = time.strftime("%Y%m%d-%H%M%S")
            d = _shots_dir()
            bpath = os.path.join(d, f"before-{ts}.png")
            apath = os.path.join(d, f"after-{ts}.png")
            before_full.save(bpath, "PNG")
            after_full.save(apath, "PNG")
            out["before_path"] = bpath
            out["after_path"] = apath
        except Exception as e:  # noqa: BLE001
            out["shot_error"] = str(e)
    return out
