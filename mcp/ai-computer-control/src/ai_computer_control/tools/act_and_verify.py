"""`act_and_verify` — perform one UI action and measure whether the screen actually changed.

Pattern: capture BEFORE -> execute the action (click / type / key) -> brief settle wait -> capture
AFTER -> compute the fraction of pixels that differ inside a region of interest. Returns the
before/after image paths and a `changed_ratio` so an agent can tell "did my click do anything?"
without a second round-trip and its own diffing.
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


def _changed_ratio(before, after) -> float:
    """Fraction of pixels whose RGB differs beyond a small tolerance (0.0-1.0). Best-effort."""
    try:
        from PIL import Image, ImageChops
        if before.size != after.size:
            after = after.resize(before.size, Image.NEAREST)
        diff = ImageChops.difference(before.convert("RGB"), after.convert("RGB"))
        # Collapse RGB to a single per-pixel magnitude, then count pixels over a tolerance.
        gray = diff.convert("L")
        hist = gray.histogram()
        total = before.size[0] * before.size[1]
        if total <= 0:
            return 0.0
        tol = 16  # ignore sub-16 lvl noise (font AA, cursor blink)
        changed = sum(hist[tol:])
        return round(changed / float(total), 4)
    except Exception:
        return 0.0


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
                         use_clipboard=bool(action.get("use_clipboard", False)))
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
        region: Optional "x,y,width,height" limiting the diff to a region of interest; omit to diff
            the whole screen. (Screen coords.)
        settle_ms: Milliseconds to wait after the action before the AFTER capture (UI settle).
        save_shots: Persist before/after PNGs under <data>/shots and return their paths.

    Returns:
        dict with ok, changed_ratio (0.0-1.0 fraction of region pixels that changed),
        action_result (the underlying tool's result), and before_path/after_path when save_shots.
        A high changed_ratio means the action visibly took effect; ~0.0 means nothing happened.
    """
    region_tuple = None
    if region:
        try:
            x, y, w, h = (int(v.strip()) for v in region.split(","))
            region_tuple = (x, y, w, h)
        except Exception:
            return {"ok": False, "error": "region must be 'x,y,width,height'"}

    try:
        before = _grab(region_tuple)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"before-capture failed: {e}"}

    action_result = _do_action(action or {})
    if not action_result.get("ok", False):
        return {"ok": False, "error": "action failed", "action_result": action_result}

    time.sleep(max(0, int(settle_ms)) / 1000.0)

    try:
        after = _grab(region_tuple)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"after-capture failed: {e}", "action_result": action_result}

    ratio = _changed_ratio(before, after)
    out = {"ok": True, "changed_ratio": ratio, "action_result": action_result,
           "region": region_tuple}
    if save_shots:
        try:
            ts = time.strftime("%Y%m%d-%H%M%S")
            d = _shots_dir()
            bpath = os.path.join(d, f"before-{ts}.png")
            apath = os.path.join(d, f"after-{ts}.png")
            before.save(bpath, "PNG")
            after.save(apath, "PNG")
            out["before_path"] = bpath
            out["after_path"] = apath
        except Exception as e:  # noqa: BLE001
            out["shot_error"] = str(e)
    return out
