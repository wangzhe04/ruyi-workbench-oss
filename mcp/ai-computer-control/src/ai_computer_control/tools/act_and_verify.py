"""`act_and_verify` — perform one UI action and measure whether the screen actually changed.

Pattern: capture BEFORE -> execute the action (click / type / key) -> poll the region of interest until
it changes and then stops changing (bounded by settle_ms) -> capture AFTER -> compute the fraction of
pixels that differ. Everything is diffed in memory; shots are written to disk only when asked (or when
nothing changed, as evidence), downscaled, with collision-free names, and the directory is pruned. To keep the signal meaningful, a click with no
explicit region is diffed inside a tight box around the click point (whole-screen ambient churn — a
blinking clock, a toast — would otherwise swamp a small real change, or a one-char edit would read as
"nothing happened"). A whole-screen `changed_ratio_full` is always returned too so a change that
lands elsewhere (a dropdown, a dialog) is never missed.
"""

import itertools
import os
import re
import time

from ai_computer_control.server import mcp
from ai_computer_control.paths import data_dir
from ai_computer_control.utils import geometry

_POLL_MS = 80              # poll interval while waiting for the ROI to change / settle
_MIN_CHANGE_PX = 8         # fewer changed pixels than this in a poll is treated as ambient noise
_MAX_SETTLE_MS = 5000      # hard cap on settle_ms
_KEEP_SHOTS = 40           # newest before-/after- files kept in <data>/shots
_SHOT_WIDTH = 960          # saved shots are downscaled to this width
_SHOT_RE = re.compile(r"^(before|after)-.*\.(png|jpg)$")
_shot_counter = itertools.count(1)

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
    return geometry.virtual_desktop_bounds()


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


def _clip_box(img, region):
    """`region` (x, y, w, h in screen coords) clipped to `img` (a primary-screen grab, origin 0,0) as an
    (x, y, w, h) box, or None when the clipped box is degenerate/off this grab."""
    try:
        x, y, w, h = region
        L, T = max(0, x), max(0, y)
        R, B = min(img.width, x + w), min(img.height, y + h)
        if R - L < 2 or B - T < 2:
            return None
        return (L, T, R - L, B - T)
    except Exception:
        return None


def _crop(img, region):
    """Crop `img` to `region`, clamped to the image. Returns the cropped image, or None if degenerate."""
    box = _clip_box(img, region)
    if box is None:
        return None
    try:
        return img.crop((box[0], box[1], box[0] + box[2], box[1] + box[3]))
    except Exception:
        return None


def _wait_settled(grab_roi, before_roi, settle_ms, sleep=time.sleep, clock=time.monotonic,
                  poll_ms=_POLL_MS):
    """Poll the region of interest until it differs from `before_roi` and then stops changing.

    Replaces a fixed sleep: a fast app returns as soon as the frame is stable. We wait up to
    2*settle_ms for the FIRST change (so an app that reacts after ~700ms is not read as "no effect"
    under the default settle_ms=500), then up to settle_ms more for it to stop changing. An action with
    no visible effect therefore costs 2*settle_ms. Returns (last_frame, waited_ms, changed, settled)
    where `settled` means two consecutive frames were equal (or nothing ever changed within the budget).
    """
    budget = max(0, min(int(settle_ms), _MAX_SETTLE_MS)) / 1000.0
    poll = max(10, int(poll_ms)) / 1000.0
    if budget <= 0:
        return grab_roi(), 0, False, True
    start = clock()
    first_deadline = start + 2 * budget
    frame, changed, prev = None, False, None
    stable_deadline = None
    while True:
        sleep(poll)
        frame = grab_roi()
        if not changed:
            _, px, _ = _changed_stats(before_roi, frame)
            if px >= _MIN_CHANGE_PX:
                changed, prev = True, frame
                stable_deadline = clock() + budget
            elif clock() >= first_deadline:
                return frame, int((clock() - start) * 1000), False, True
        else:
            _, px, _ = _changed_stats(prev, frame)
            if px < _MIN_CHANGE_PX:
                return frame, int((clock() - start) * 1000), True, True
            prev = frame
            if clock() >= stable_deadline:
                return frame, int((clock() - start) * 1000), True, False


def _prune_shots(directory: str, keep: int = _KEEP_SHOTS) -> int:
    """Delete all but the newest `keep` before-/after- shot files (legacy PNGs included). Returns #deleted."""
    try:
        names = [n for n in os.listdir(directory) if _SHOT_RE.match(n)]
        stamped = []
        for n in names:
            try:
                stamped.append((os.path.getmtime(os.path.join(directory, n)), n))
            except OSError:
                pass
        stamped.sort(reverse=True)
        gone = 0
        for _, n in stamped[max(0, int(keep)):]:
            try:
                os.remove(os.path.join(directory, n))
                gone += 1
            except OSError:
                pass
        return gone
    except Exception:
        return 0


def _save_shots(before, after, directory: str, keep: int = _KEEP_SHOTS) -> dict:
    """Write downscaled JPEG shots with collision-free names, then prune the directory."""
    os.makedirs(directory, exist_ok=True)
    stem = f"{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 10**9:09d}-{next(_shot_counter)}"
    out = {}
    for label, img in (("before", before), ("after", after)):
        if img is None:
            continue
        im = img.convert("RGB")
        if im.width > _SHOT_WIDTH:
            im = im.resize((_SHOT_WIDTH, max(1, round(im.height * _SHOT_WIDTH / im.width))))
        path = os.path.join(directory, f"{label}-{stem}.jpg")
        im.save(path, "JPEG", quality=70)
        out[f"{label}_path"] = path
    _prune_shots(directory, keep)
    return out


def _diff_bbox(before, after, pad: int = 12):
    """Bounding box (l, t, r, b) of the changed pixels between two same-origin frames, padded; None if identical."""
    try:
        from PIL import Image, ImageChops
        if before.size != after.size:
            after = after.resize(before.size, Image.NEAREST)
        gray = ImageChops.difference(before.convert("RGB"), after.convert("RGB")).convert("L")
        box = gray.point(lambda v: 255 if v >= 16 else 0).getbbox()
        if not box:
            return None
        l, t, r, b = box
        return (max(0, l - pad), max(0, t - pad), min(before.width, r + pad), min(before.height, b + pad))
    except Exception:
        return None


def _result_image(mode: str, before_full, after_full) -> dict:
    """Small image payload for return_image='after'|'diff' (same keys as the screenshot tool)."""
    from ai_computer_control.utils.image import encode_with_budget
    img, note = after_full, None
    if mode == "diff":
        box = _diff_bbox(before_full, after_full)
        if box is None:
            return {"image_note": "nothing changed; no diff region to return"}
        img = after_full.crop(box)
        note = {"diff_region": {"x": box[0], "y": box[1], "width": box[2] - box[0], "height": box[3] - box[1]}}
    enc = encode_with_budget(img, max_width=640, fmt="png")
    return {**enc, **(note or {})}


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
                   save_shots: bool = False, return_image: str = "") -> dict:
    """Do one UI action and report how much the screen changed as a result.

    Args:
        action: {"type": "click"|"type"|"key", ...}. click -> x, y (physical screen coords; optional button,
            clicks). type -> text (optional use_clipboard, better for CJK). key -> key (e.g. "enter", "ctrl+s").
        region: Optional "x,y,width,height" limiting the diff. Default: ~200x200 around a click, the foreground
            window for type/key — pass the target field's rect for the tightest signal.
        settle_ms: Time the UI gets to react (cap 5000): waits up to 2*settle_ms for a change, then up to settle_ms
            for it to stop; a no-op waits the full 2*settle_ms. Raise for slow apps.
        save_shots: Also write before/after JPEGs under <data>/shots (newest 40 kept) and return their paths;
            written automatically when NOTHING changed.
        return_image: "" (default) | "after" (small after-screenshot) | "diff" (changed region only), returned in
            screenshot's image/width/height/scale/format keys.

    Returns:
        dict with ok, changed_ratio (fraction changed inside the region), changed_pixels, changed_ratio_full (whole
        screen), action_result, region, settled, waited_ms, before_path/after_path when shots were saved.
        Both ratios ~0 => the action had no effect; region ~0 but full >0 => the change landed OUTSIDE the region.
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
        out = {"ok": False, "error": "action failed", "action_result": action_result}
        try:  # on failure keep the BEFORE frame as evidence (downscaled, pruned)
            out.update(_save_shots(before_full, None, _shots_dir()))
        except Exception as e:  # noqa: BLE001
            out["shot_error"] = str(e)
        return out

    # Poll the region of interest (small grab) instead of a fixed sleep; fall back to the plain wait
    # when the ROI is off the primary grab (nothing to poll against).
    waited_ms, settled = None, None
    # Poll EXACTLY the box before_roi was cut from: pyautogui pads an unclipped off-screen region with
    # black at full size, and frames of different sizes would always read as "changed".
    poll_box = _clip_box(before_full, region_tuple) if region_tuple else None
    before_roi = _crop(before_full, poll_box) if poll_box else None
    if poll_box and before_roi is not None:
        try:
            _, waited_ms, _changed, settled = _wait_settled(lambda: _grab(poll_box), before_roi, settle_ms)
        except Exception:  # noqa: BLE001 — polling is best-effort; the final capture below decides
            waited_ms, settled = None, None
    if waited_ms is None:
        pre = time.monotonic()
        time.sleep(max(0, min(int(settle_ms), _MAX_SETTLE_MS)) / 1000.0)
        waited_ms = int((time.monotonic() - pre) * 1000)

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
           "changed_ratio_full": ratio_full, "action_result": action_result, "region": region_tuple,
           "waited_ms": waited_ms}
    if settled is not None:
        out["settled"] = settled
    if region_auto:
        out["region_auto"] = region_auto
    no_change = px == 0 and ratio_full == 0
    if save_shots or no_change:
        try:
            out.update(_save_shots(before_full, after_full, _shots_dir()))
            if no_change and not save_shots:
                out["shots_reason"] = "no_change"
        except Exception as e:  # noqa: BLE001
            out["shot_error"] = str(e)
    if str(return_image or "").lower() in ("after", "diff"):
        try:
            out.update(_result_image(str(return_image).lower(), before_full, after_full))
        except Exception as e:  # noqa: BLE001
            out["image_error"] = str(e)
    return out
