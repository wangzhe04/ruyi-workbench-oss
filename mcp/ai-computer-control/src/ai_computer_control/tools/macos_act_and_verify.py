"""Target-bound Mac actions followed by bounded screen-change observations."""
import asyncio
import math
import os
import threading
import time

from ai_computer_control.server import mcp
from ai_computer_control.paths import data_dir
from ai_computer_control.utils.errors import ToolCancelled
from ai_computer_control.utils import macos
from ai_computer_control.utils.macos_session import request
from ai_computer_control.utils.macos_visual import capture_frame, capture_fields, parse_region
from ai_computer_control.utils.text_input import _route_clipboard, _split_trailing_enter, parse_macos_keys
from ai_computer_control.utils.visual_diff import _changed_stats, _diff_bbox, _save_shots, _MIN_CHANGE_PX

_ACT_GATE = threading.Lock()
_VERIFICATION_TIMEOUT_S = 45


def _action_payload(action, target):
    if not isinstance(target, dict):
        raise macos.DesktopError('target_required', 'Pass the complete current active-window target')
    if not isinstance(action, dict):
        raise macos.DesktopError('invalid_args', 'action must be an object')
    kind = action.get('type')
    fields = {'click': {'type', 'x', 'y', 'button', 'clicks', 'interval'},
              'type': {'type', 'text', 'use_clipboard', 'interval'}, 'key': {'type', 'key'}}
    if not isinstance(kind, str) or kind not in fields or set(action) - fields[kind]:
        raise macos.DesktopError('invalid_args', 'Use click, type or key with supported action fields')
    if kind == 'click':
        if any(type(action.get(key)) not in (int, float) or not math.isfinite(action[key]) for key in ('x', 'y')):
            raise macos.DesktopError('invalid_args', 'click requires finite global logical-point x and y')
        return {'op': 'mouse.click', 'target': target, 'x': action['x'], 'y': action['y'],
                'button': action.get('button', 'left'), 'clicks': action.get('clicks', 1), 'interval': action.get('interval', .1)}
    if kind == 'key':
        keys = parse_macos_keys(action.get('key'))
        if isinstance(keys, dict):
            raise macos.DesktopError('invalid_args', keys['error'])
        return {'op': 'keyboard.chord', 'target': target, 'keys': keys}
    text, explicit = action.get('text'), action.get('use_clipboard')
    if not isinstance(text, str) or (explicit is not None and type(explicit) is not bool):
        raise macos.DesktopError('invalid_args', 'type requires text and an optional boolean use_clipboard')
    paste, route = _route_clipboard(text, explicit)
    body, enters = _split_trailing_enter(text, route) if paste else (text, 0)
    return {'op': 'keyboard.text', 'target': target, 'text': body, 'paste': paste,
            'interval': action.get('interval', .02), 'enters': enters}


def _region_box(frame, region, action):
    bounds = frame.info['logical_bounds']
    requested = parse_region(region)
    if requested is None:
        requested = (math.floor(action['x'] - 100), math.floor(action['y'] - 100), 200, 200) \
            if action['type'] == 'click' else (bounds['x'], bounds['y'], bounds['width'], bounds['height'])
    x, y, width, height = requested
    left, top = max(bounds['x'], x), max(bounds['y'], y)
    right, bottom = min(bounds['x'] + bounds['width'], x + width), min(bounds['y'] + bounds['height'], y + height)
    if right <= left or bottom <= top:
        raise macos.DesktopError('region_outside_target', 'Verification region does not intersect the captured target')
    sx, sy = frame.image.width / bounds['width'], frame.image.height / bounds['height']
    pixels = (max(0, math.floor((left - bounds['x']) * sx)), max(0, math.floor((top - bounds['y']) * sy)),
              min(frame.image.width, math.ceil((right - bounds['x']) * sx)),
              min(frame.image.height, math.ceil((bottom - bounds['y']) * sy)))
    return pixels, {'x': left, 'y': top, 'width': right - left, 'height': bottom - top}


def _click_box(frame, action):
    bounds = frame.info['logical_bounds']
    x, y = action['x'], action['y']
    if not bounds['x'] <= x < bounds['x'] + bounds['width'] or not bounds['y'] <= y < bounds['y'] + bounds['height']:
        raise macos.DesktopError('point_outside_target', 'Click point is outside the captured target')
    px = min(frame.image.width - 1, math.floor((x - bounds['x']) * frame.image.width / bounds['width']))
    py = min(frame.image.height - 1, math.floor((y - bounds['y']) * frame.image.height / bounds['height']))
    return {'left': px, 'top': py, 'width': 1, 'height': 1}


def _after(before, crop, settle_ms):
    last = [None]
    def grab():
        frame = capture_frame(None, before.target)
        if frame.image.size != before.image.size or frame.info['logical_bounds'] != before.info['logical_bounds']:
            raise macos.DesktopError('observation_changed', 'Target capture geometry changed after the action')
        last[0] = frame
        return frame.image.crop(crop)
    # The shared Windows polling algorithm only observes. All Mac grabs retain exact geometry checks.
    from ai_computer_control.utils.visual_diff import wait_settled
    _image, waited_ms, changed, settled = wait_settled(grab, before.image.crop(crop), settle_ms)
    return last[0], waited_ms, changed, settled


def _return_image(after, before, mode):
    image = after.image
    info = dict(after.info)
    if mode == 'diff':
        box = _diff_bbox(before.image, image)
        if box is None:
            return {'image_note': 'No changed region was observed'}
        image = image.crop(box)
        bounds = after.info['logical_bounds']
        sx, sy = after.image.width / bounds['width'], after.image.height / bounds['height']
        info['logical_bounds'] = {'x': bounds['x'] + box[0] / sx, 'y': bounds['y'] + box[1] / sy,
                                  'width': (box[2] - box[0]) / sx, 'height': (box[3] - box[1]) / sy}
    return capture_fields(image, info, 640, 'png', 80)


def _release_gate(task):
    try:
        task.result()
    except (Exception, asyncio.CancelledError):
        pass
    _ACT_GATE.release()


def _action_status(result):
    sent = bool(result and (result.get('action_sent') or result.get('acted')))
    outcome = 'not_dispatched'
    if sent:
        outcome = 'unconfirmed'
    if result and result.get('outcome') == 'unknown':
        outcome = 'unknown'
    return {'action_sent': sent, 'outcome': outcome}


async def _act(action, target, region, settle_ms, save_shots, return_image, state):
    payload = _action_payload(action, target)
    if type(settle_ms) is not int or not 0 <= settle_ms <= 5000 or return_image not in ('', 'after', 'diff'):
        raise macos.DesktopError('invalid_args', 'settle_ms must be 0–5000 and return_image must be empty, after or diff')
    if not _ACT_GATE.acquire(blocking=False):
        raise macos.DesktopError('verification_busy', 'Another action verification is running')
    pending = None
    async def background(function, *args):
        nonlocal pending
        pending = asyncio.create_task(asyncio.to_thread(function, *args))
        result = await asyncio.shield(pending)
        pending = None
        return result
    try:
        before = await background(capture_frame, None, target)
        crop, logical_region = _region_box(before, region, action)
        if action['type'] == 'click':
            await background(before.prepare_click, _click_box(before, action))
        await asyncio.sleep(0)
        before.require_fresh()
        try:
            action_result = request(payload)
        except macos.DesktopError as error:
            action_result = {'ok': False, 'code': error.code, 'error': str(error), **error.details}
        state['action_result'] = action_result
        if not action_result.get('ok'):
            return {'ok': False, 'code': action_result.get('code', 'action_failed'), 'error': 'The guarded action failed',
                    'action_result': action_result, 'confirmed': None, **_action_status(action_result)}
        after, waited_ms, observed, settled = await background(_after, before, crop, settle_ms)
        ratio, pixels, _ = _changed_stats(before.image.crop(crop), after.image.crop(crop))
        full_ratio, full_pixels, _ = _changed_stats(before.image, after.image)
        out = {'ok': True, 'action_result': action_result, 'confirmed': None, 'verification': 'screen_change_observation',
               'outcome': 'unconfirmed', 'action_sent': bool(action_result.get('action_sent') or action_result.get('acted')),
               'effect_observed': observed or pixels >= _MIN_CHANGE_PX, 'changed_ratio': ratio, 'changed_pixels': pixels,
               'changed_ratio_full': full_ratio, 'full_scope': 'captured_target_window', 'region': logical_region,
               'coordinate_space': 'macos_global_points', 'waited_ms': waited_ms, 'settled': settled}
        no_change = pixels == 0 and full_pixels == 0
        if save_shots or no_change:
            try:
                out.update(await background(_save_shots, before.image, after.image, os.path.join(data_dir(), 'shots')))
                if no_change and not save_shots:
                    out['shots_reason'] = 'no_change'
            except (OSError, ValueError) as error:
                out['shot_error'] = type(error).__name__
        if return_image:
            out.update(await background(_return_image, after, before, return_image))
        return out
    finally:
        if pending is None:
            _ACT_GATE.release()
        elif pending.done():
            _release_gate(pending)
        else:
            pending.add_done_callback(_release_gate)


@mcp.tool(audit=True)
async def act_and_verify(action: dict, target: dict, region: str | None = None, settle_ms: int = 500,
                          save_shots: bool = False, return_image: str = '') -> dict:
    """Perform one guarded Mac click/type/key action and observe pixel changes inside the bound target.

    Pass the complete current active-window target. Click x/y and region x,y,width,height use global
    logical points. A click's matched point pixels are recaptured before input. type/key retain the
    original ten-second capture age and native focus/identity guards. settle_ms is 0–5000.
    changed_ratio measures the selected ROI, while changed_ratio_full covers the captured target window.
    effect_observed reports observed ROI changes of at least eight native pixels. Application semantics remain for subsequent AX/OCR observation.
    confirmed is null. A verification failure preserves the result of input already posted.
    return_image is empty, after or diff, with exact image-to-logical-point metadata. Evidence images are
    saved to the internal shots directory on request or when no change is seen, with at most 40 retained.
    Cancellation leaves background observations only. The operation has a forty-five-second outer deadline.
    """
    state = {}
    try:
        return await asyncio.wait_for(_act(action, target, region, settle_ms, save_shots, return_image, state), timeout=_VERIFICATION_TIMEOUT_S)
    except asyncio.CancelledError as error:
        action_result = state.get('action_result')
        raise ToolCancelled('act_and_verify', {'ok': False, 'code': 'cancelled', 'error': 'Action verification cancelled',
            'cancelled': True, 'action_result': action_result, 'confirmed': None, **_action_status(action_result)}) from error
    except TimeoutError:
        action_result = state.get('action_result')
        return {'ok': False, 'code': 'verification_timeout', 'error': 'Action verification exceeded its deadline',
                'action_result': action_result, 'confirmed': None, **_action_status(action_result)}
    except Exception as error:
        if state.get('action_result') is None:
            raise
        return {'ok': False, 'code': getattr(error, 'code', 'verification_failed'),
                'error': str(error)[:1024], 'action_result': state['action_result'],
                'action_sent': bool(state['action_result'].get('action_sent') or state['action_result'].get('acted')),
                'confirmed': None, 'outcome': 'unconfirmed'}
