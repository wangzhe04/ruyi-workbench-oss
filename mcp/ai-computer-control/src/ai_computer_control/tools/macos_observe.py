"""Mac snapshots sharing one native capture between the returned image and offline OCR."""
import asyncio
import json
import time

from ai_computer_control.server import mcp
from ai_computer_control.utils import macos
from ai_computer_control.utils import macos_ocr as ocr_backend
from ai_computer_control.utils.macos_session import request
from ai_computer_control.utils.macos_visual import VisualFrame, capture_frame, capture_fields, require_active


def _same_target(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def _selected_window(title):
    if not isinstance(title, str) or not title or len(title) > 1024:
        raise macos.DesktopError('invalid_args', 'window_title must contain 1–1024 characters')
    windows = request({'op': 'window.list'})['windows']
    exact = [row for row in windows if row.get('title', '').casefold() == title.casefold()]
    matches = exact or [row for row in windows if title.casefold() in row.get('title', '').casefold()]
    if not matches:
        raise macos.DesktopError('window_not_found', 'No observed window matches the requested title')
    if len(matches) != 1:
        raise macos.DesktopError('window_ambiguous', 'Multiple observed windows match the requested title')
    return matches[0]


def _prepare(window_title, target, region, include_screenshot, include_ocr=False):
    if window_title and (target is not None or region):
        raise macos.DesktopError('invalid_args', 'Use window_title independently of target and region')
    state = macos.capability()
    focused = {'present': False}
    if state.get('windowReady'):
        try:
            focused = {'present': True, **request({'op': 'window.active'})['window']}
        except macos.DesktopError as error:
            focused.update(code=error.code, error=str(error))
    selected = _selected_window(window_title) if window_title else focused if focused.get('present') else None
    if target is not None:
        require_active(target)
        selected = {'target': target, 'pid': target['pid'], 'handle': target['handle']}
    frame = None
    need_frame = include_screenshot or (include_ocr and state.get('ocrReady'))
    if need_frame:
        try:
            if window_title:
                started = time.monotonic()
                image, info = macos.capture(window_title=selected['title'])
                observed = selected['target']
                if info.get('window_id') != observed['handle'] or info.get('pid') != observed['pid'] \
                        or info['logical_bounds'] != observed['bounds']:
                    raise macos.DesktopError('window_changed', 'Captured window differs from its observed identity or geometry')
                current = request({'op': 'window.list'})['windows']
                if not any(_same_target(row['target'], observed) for row in current):
                    raise macos.DesktopError('target_changed', 'The selected window changed during capture')
                frame = VisualFrame(image.convert('RGB'), info, None, started, observed)
            else:
                frame = capture_frame(region, target)
        except macos.DesktopError as error:
            if include_screenshot:
                raise
            state = {**state, '_frame_error': {'code': error.code, 'error': str(error), **error.details}}
    return state, focused, selected, frame


def _flatten(node):
    nodes = [node]
    for child in node.get('children', []):
        nodes.extend(_flatten(child))
    return nodes


async def _ax_snapshot(selected):
    if selected is None:
        raise macos.DesktopError('window_not_found', 'No accessible window is available for AX observation')
    result = await asyncio.to_thread(request, {'op': 'ax.inspect', 'target': selected['target'],
                                              'scope': 'window', 'max_depth': 8, 'max_nodes': 80})
    elements = []
    for node in _flatten(result['tree'])[:80]:
        item = {key: value for key, value in node.items() if key not in ('children', 'bounds')}
        if node.get('bounds'):
            bounds = node['bounds']
            item['rect'] = {'left': bounds['x'], 'top': bounds['y'], 'width': bounds['width'], 'height': bounds['height']}
        elements.append(item)
    out = {'uia_elements': elements, 'uia_visited': result['nodes'], 'uia_truncated': bool(result.get('truncated')),
           'uia_scope': {'kind': 'window', 'target': selected['target']}}
    if result.get('truncated_by'):
        out['uia_truncated_by'] = result['truncated_by']
    if result.get('accessibility_limited'):
        out['uia_accessibility'] = {key: result[key] for key in ('accessibility_limited', 'reason_code', 'reason', 'hint')
                                    if key in result}
    return out


async def _ocr_snapshot(frame, lang, window_title, target):
    result = await ocr_backend.ocr_frame(frame.image, lang=lang, logical_bounds=frame.info['logical_bounds'])
    words = result['words']
    bounds = frame.info['logical_bounds']
    return {'ocr_words': [{'text': word['text'], 'rect': {key: word[key] for key in ('left', 'top', 'width', 'height')},
                           'center': word['center']} for word in words[:200]],
            'ocr_total': len(words), 'ocr_truncated': len(words) > 200,
            'ocr_scope': {'kind': 'window' if window_title else 'target_region' if target else 'screen',
                          'origin': {'x': bounds['x'], 'y': bounds['y']}, 'logical_bounds': bounds,
                          'coordinate_space': 'macos_global_points'}}


async def _optional(operation):
    try:
        return await operation
    except Exception as error:
        return {'backend_error': {'code': getattr(error, 'code', 'observation_backend_failed'),
                                  'error': str(error)[:1024], **getattr(error, 'details', {})}}


async def _observe(max_width, window_title, include_uia, include_ocr, format, quality, lang,
                   include_screenshot, target, region):
    state, focused, selected, frame = await asyncio.to_thread(_prepare, window_title, target, region,
                                                             include_screenshot, include_ocr)
    out = {'ok': True, 'focused_window': focused, 'coordinate_space': 'macos_global_points'}
    if include_screenshot:
        out['screenshot'] = await asyncio.to_thread(capture_fields, frame.image, frame.info, max_width, format, quality)
    operations, labels = [], []
    degraded = []
    if include_uia:
        if state.get('axReady'):
            operations.append(_optional(_ax_snapshot(selected))); labels.append('uia')
        else:
            degraded.append('uia')
    if include_ocr:
        if state.get('ocrReady') and frame is not None:
            operations.append(_optional(_ocr_snapshot(frame, lang, window_title, target))); labels.append('ocr')
        else:
            degraded.append('ocr')
            if state.get('_frame_error'):
                out.setdefault('backend_errors', {})['ocr'] = state['_frame_error']
    for label, result in zip(labels, await asyncio.gather(*operations)):
        if 'backend_error' in result:
            degraded.append(label)
            out.setdefault('backend_errors', {})[label] = result['backend_error']
        else:
            out.update(result)
    if degraded:
        out['degraded'] = degraded
    if frame:
        out['logical_bounds'] = dict(frame.info['logical_bounds'])
        out['observation_age_ms'] = round((time.monotonic() - frame.started) * 1000)
    return out


@mcp.tool()
async def observe(max_width: int = 1280, window_title: str | None = None,
                   include_uia: bool = True, include_ocr: bool = True, format: str = 'png', quality: int = 80,
                   lang: str | None = None, include_screenshot: bool = True,
                   target: dict | None = None, region: str | None = None) -> dict:
    """Observe a Mac screen or selected window with one shared screenshot/OCR frame and bounded AX metadata.

    All element and word rectangles/centers use global logical points. Screenshot scale and scale_y map
    returned image pixels to those points. AX is observed separately and includes up to 80 native nodes.
    OCR includes up to 200 words with the full count and truncation flag. Missing optional backends are
    reported under degraded. The complete read-only snapshot has an eighty-second outer deadline.
    window_title selects one uniquely identified visible window, including covered contents. target
    requires the complete current active-window target and clips the shared capture to that window.
    region is x,y,width,height in global logical points. include_screenshot=False omits encoded pixels.
    """
    try:
        return await asyncio.wait_for(_observe(max_width, window_title, include_uia, include_ocr, format, quality,
                                                lang, include_screenshot, target, region), timeout=80)
    except TimeoutError:
        raise macos.DesktopError('observation_timeout', 'The snapshot exceeded its eighty-second deadline') from None
