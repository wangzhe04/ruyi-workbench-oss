"""Shared OpenCV matching algorithm. Backends are explicit to preserve callers' test substitutes."""
import time

_MULTISCALE = [1.0, 1.25, 1.5, 0.8, 0.667, 1.75, 2.0, 0.5, 0.9, 1.1, 0.75]

def match_templates(screen, templ, confidence, scales, find_all, early_exit=0.97, *,
                    cv_backend, np_backend, max_hits=None, deadline=None):
    """Template-match `templ` over `screen` at each scale. Returns (hits, best).

    hits: [(score, x, y, w, h)] at/above `confidence`. best: (score, scale) of the strongest match seen
    at ANY scale (None if no scale fit), so a miss can still report how close it was. In single-match
    mode the scale loop stops as soon as one scale scores >= max(confidence, early_exit)."""
    hits = []
    best = None
    sh, sw = screen.shape[:2]
    for scale in scales:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("Template matching exceeded its deadline")
        th, tw = templ.shape[:2]
        nw, nh = int(tw * scale), int(th * scale)
        if nw < 8 or nh < 8 or nw > sw or nh > sh:
            continue
        resized = cv_backend.resize(templ, (nw, nh)) if scale != 1.0 else templ
        res = cv_backend.matchTemplate(screen, resized, cv_backend.TM_CCOEFF_NORMED)
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("Template matching exceeded its deadline")
        if find_all:
            mask = res >= confidence
            if max_hits is not None and len(hits) + int(np_backend.count_nonzero(mask)) > max_hits:
                raise OverflowError("Template matching exceeds its raw-hit capacity")
            ys, xs = np_backend.where(mask)
            for (x, y) in zip(xs.tolist(), ys.tolist()):
                hits.append((float(res[y, x]), x, y, nw, nh))
            if res.size:
                top = float(res.max())
                if best is None or top > best[0]:
                    best = (top, scale)
        else:
            _minv, maxv, _minl, maxl = cv_backend.minMaxLoc(res)
            if best is None or float(maxv) > best[0]:
                best = (float(maxv), scale)
            if maxv >= confidence:
                hits.append((float(maxv), maxl[0], maxl[1], nw, nh))
                if maxv >= max(confidence, early_exit):
                    break
    return hits, best


def dedupe_hits(hits, min_dist=12):
    hits.sort(key=lambda h: h[0], reverse=True)
    kept = []
    for score, x, y, w, h in hits:
        cx, cy = x + w // 2, y + h // 2
        if all(abs(cx - (k[1] + k[3] // 2)) > min_dist or abs(cy - (k[2] + k[4] // 2)) > min_dist for k in kept):
            kept.append((score, x, y, w, h))
    return kept



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
