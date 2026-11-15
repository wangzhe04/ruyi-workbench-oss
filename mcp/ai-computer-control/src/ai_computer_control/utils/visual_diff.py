"""Shared pixel-difference and internal evidence-image utilities."""
import itertools
import os
import re
import time

_KEEP_SHOTS = 40           # newest before-/after- files kept in <data>/shots

_SHOT_WIDTH = 960          # saved shots are downscaled to this width

_SHOT_RE = re.compile(r"^(before|after)-.*\.(png|jpg)$")

_shot_counter = itertools.count(1)

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


_POLL_MS = 80              # poll interval while waiting for the ROI to change / settle

_MIN_CHANGE_PX = 8         # fewer changed pixels than this in a poll is treated as ambient noise

_MAX_SETTLE_MS = 5000      # hard cap on settle_ms

def wait_settled(grab_roi, before_roi, settle_ms, sleep=time.sleep, clock=time.monotonic,
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
