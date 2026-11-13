"""Offline Mac template matching with bounded read-only workers and cancellable guarded input."""
import asyncio
import time

from ai_computer_control.server import mcp
from ai_computer_control.utils import macos_vision
from ai_computer_control.utils.macos import DesktopError
from ai_computer_control.utils.macos_visual import select_match
from ai_computer_control.utils.template_match import _miss, _MULTISCALE
from ai_computer_control.utils.waits import clamp_wait_s

try:
    import cv2
    import numpy
    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False


def _observe(*args):
    if not _AVAILABLE:
        raise DesktopError('dependency_missing', 'Install the prepared offline OpenCV and NumPy wheels')
    with macos_vision.operation():
        return macos_vision.observe(*args)


async def _find(template_path, template_b64, confidence, scales, region, max_results=None):
    if max_results is not None and (type(max_results) is not int or not 1 <= max_results <= 100):
        raise DesktopError('invalid_args', 'max_results must be an integer from 1 to 100')
    _frame, raw, matches = await asyncio.to_thread(_observe, template_path, template_b64, confidence, scales, region)
    if max_results is not None:
        return {'ok': True, 'count': len(matches[:max_results]), 'matches_total': len(matches),
                'matches': matches[:max_results], 'truncated': len(matches) > max_results,
                'coordinate_space': 'macos_global_points'}
    if not matches:
        return {'ok': True, **_miss(confidence, raw['best'])}
    return {'ok': True, 'found': True, 'match': max(matches, key=lambda match: match['confidence']),
            'coordinate_space': 'macos_global_points'}


@mcp.tool()
async def find_template(template_path: str | None = None, template_b64: str | None = None,
                        confidence: float = .8, multiscale: bool = True, region: str | None = None) -> dict:
    """Find a local or base64 image template on a Mac primary display or x,y,width,height region.

    Coordinates and returned centers use global logical points. The actual captured pixel dimensions
    determine both scale axes. OpenCV runs offline in an eight-second worker with bounded image/hit sizes.
    Template orientation is its first frame's raw decoded pixel orientation, ignoring EXIF rotation.
    """
    return await _find(template_path, template_b64, confidence, list(_MULTISCALE) if multiscale else [1.], region)


@mcp.tool()
async def find_all_templates(template_path: str | None = None, template_b64: str | None = None,
                             confidence: float = .85, multiscale: bool = False, max_results: int = 50,
                             region: str | None = None) -> dict:
    """Find deduplicated template occurrences in Mac global logical points. max_results is 1–100.

    matches_total counts the full bounded result before the response cap. Templates require a nonflat
    grayscale pattern, at most 8MB and 4 million pixels. Matching refuses more than 4096 raw hits.
    """
    return await _find(template_path, template_b64, confidence, [1., .9, 1.1] if multiscale else [1.], region, max_results)


@mcp.tool(audit=True)
async def vision_click(template_path: str | None = None, template_b64: str | None = None,
                        threshold: float = .8, click: bool = True, multiscale: bool = True,
                        region: str | None = None, target: dict | None = None,
                        nth: int | None = None, nearest_to: dict | None = None) -> dict:
    """Find a template and optionally click through a complete current active Mac window target.

    threshold must be finite from .05 to 1. Every requested scale is searched. Multiple occurrences need
    explicit nth (0-based confidence order) or uniquely nearest_to {x,y} in global logical points.
    Clicking rechecks exact window identity, geometry, matched pixels and a ten-second dispatch-age budget.
    Native posted events leave the application's actual effect unconfirmed for later observation.
    """
    if click and target is None:
        raise DesktopError('target_required', 'Visual clicks require the complete active-window target')
    frame, raw, matches = await asyncio.to_thread(_observe, template_path, template_b64, threshold,
                                                 list(_MULTISCALE) if multiscale else [1.], region, target)
    if not matches:
        return {'ok': True, **_miss(threshold, raw['best'])}
    index = select_match(matches, nth, nearest_to, code='vision_ambiguous') if click else 0
    best = matches[index] if click else max(matches, key=lambda match: match['confidence'])
    out = {'ok': True, 'found': True, 'confidence': best['confidence'], 'count': len(matches),
           'center': {'x': best['center'][0], 'y': best['center'][1]},
           'rect': {key: best[key] for key in ('left', 'top', 'width', 'height')},
           'coordinate_space': 'macos_global_points'}
    if click:
        hit = raw['hits'][index]
        out.update(await frame.click_async({'left': hit[1], 'top': hit[2], 'width': hit[3], 'height': hit[4]}), clicked=True)
    return out


@mcp.tool()
async def wait_for_image(template_path: str | None = None, template_b64: str | None = None,
                          confidence: float = .8, timeout: float = 10., poll_ms: int = 400,
                          region: str | None = None) -> dict:
    """Poll the Mac screen asynchronously until a template appears or the bounded wait expires.

    timeout is capped at 120 seconds. An unfinished read-only worker retains its gate until cleanup.
    Coordinates are global logical points. Cancellation leaves no background input posting.
    """
    try:
        requested = float(timeout)
    except (ValueError, TypeError):
        requested = 10.
    timeout, clamped = clamp_wait_s(requested)
    poll_ms = max(50, int(poll_ms))
    started = time.monotonic()
    deadline = started + timeout
    best_seen = None
    while time.monotonic() < deadline:
        try:
            result = await asyncio.wait_for(_find(template_path, template_b64, confidence, [1.], region),
                                             timeout=max(0, deadline - time.monotonic()))
        except TimeoutError:
            break
        if time.monotonic() >= deadline:
            break
        if result.get('found'):
            return result
        score = result.get('best_confidence')
        if score is not None and (best_seen is None or score > best_seen):
            best_seen = score
        await asyncio.sleep(min(poll_ms / 1000, max(0, deadline - time.monotonic())))
    out = {'ok': True, 'found': False, 'timeout': timeout,
           'waited_ms': int((time.monotonic() - started) * 1000), 'best_confidence': best_seen}
    if clamped:
        out.update(timeout_clamped=True, requested_timeout=requested)
    return out
