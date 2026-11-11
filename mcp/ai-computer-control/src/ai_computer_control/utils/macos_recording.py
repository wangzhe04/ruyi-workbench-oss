"""Validate and rebind bounded native semantic recordings before macro dispatch."""
import json
import math
from contextlib import contextmanager
import threading
import copy

from ai_computer_control.utils.macos import DesktopError
from ai_computer_control.utils.macos_session import request
from ai_computer_control.utils.macos_sequence import validate_events
from ai_computer_control.utils.text_input import parse_macos_keys, MACOS_RECORDED_KEY_FLAGS

_FIELDS = {
    'input.sequence': {'events'},
    'keyboard.text': {'text', 'paste', 'interval', 'enters'},
    'keyboard.chord': {'keys'},
    'mouse.click': {'x', 'y', 'button', 'clicks', 'interval'},
    'mouse.move': {'x', 'y', 'duration'},
    'mouse.drag': {'start_x', 'start_y', 'x', 'y', 'duration', 'button'},
    'mouse.scroll': {'x', 'y', 'amount', 'direction'},
}
_RECORDING_GATE = threading.Lock()


@contextmanager
def recording_gate():
    """Keep start and timed replay mutually exclusive across replay's asynchronous waits."""
    if not _RECORDING_GATE.acquire(blocking=False):
        raise DesktopError('recording_busy', 'Another recording start or replay is running')
    try:
        yield
    finally:
        _RECORDING_GATE.release()


def _require(condition):
    if not condition:
        raise DesktopError('recording_invalid', 'Pass a complete bounded Mac recording from record_stop')


def _number(value, low, high, integer=False):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high \
        and (not integer or value == int(value))


def _bounds(bounds):
    _require(isinstance(bounds, dict) and set(bounds) == {'x', 'y', 'width', 'height'})
    _require(all(_number(bounds[key], -1000000, 1000000) for key in bounds))
    _require(bounds['width'] > 0 and bounds['height'] > 0)


def _input_source(value):
    _require(isinstance(value, dict) and set(value) == {'id', 'type'})
    _require(isinstance(value['id'], str) and 0 < len(value['id']) <= 512
             and value['type'] in ('TISTypeKeyboardLayout', 'TISTypeKeyboardInputMode'))


def _validate_action(action, bounds, previous_end):
    _require(isinstance(action, dict) and isinstance(action.get('op'), str))
    fields = _FIELDS.get(action['op'])
    optional = {'input_source'} if action['op'].startswith('keyboard.') or action['op'] == 'input.sequence' else set()
    if action['op'] == 'keyboard.chord':
        optional.add('event_flags')
    _require(fields is not None and set(action) - optional == fields | {'op', 'at', 'ended'})
    if 'input_source' in action:
        _input_source(action['input_source'])
    _require(_number(action['at'], previous_end, 300) and _number(action['ended'], action['at'], 300))
    if 'x' in fields:
        _require(_number(action['x'], bounds['x'], bounds['x'] + bounds['width'])
                 and _number(action['y'], bounds['y'], bounds['y'] + bounds['height'])
                 and action['x'] < bounds['x'] + bounds['width'] and action['y'] < bounds['y'] + bounds['height'])
    if 'start_x' in fields:
        _require(_number(action['start_x'], bounds['x'], bounds['x'] + bounds['width'])
                 and _number(action['start_y'], bounds['y'], bounds['y'] + bounds['height'])
                 and action['start_x'] < bounds['x'] + bounds['width'] and action['start_y'] < bounds['y'] + bounds['height'])
    if action['op'] == 'input.sequence':
        try:
            validate_events(action['events'], bounds)
        except DesktopError:
            _require(False)
        _require(action['ended'] - action['at'] + .000002 >= action['events'][-1]['at_us'] / 1000000)
    if 'button' in fields:
        _require(action['button'] in ('left', 'right', 'middle'))
    if 'duration' in fields:
        _require(_number(action['duration'], 0, 2))
    if action['op'] == 'mouse.click':
        _require(_number(action['clicks'], 1, 5, True) and _number(action['interval'], 0, .5))
    if action['op'] == 'mouse.scroll':
        _require(_number(action['amount'], -100, 100, True) and action['direction'] in ('vertical', 'horizontal'))
    if action['op'] == 'keyboard.text':
        _require(isinstance(action['text'], str) and len(action['text'].encode('utf-8')) <= 48000
                 and type(action['paste']) is bool and _number(action['interval'], 0, .2)
                 and _number(action['enters'], 0, 20, True))
        if not action['paste']:
            _require(len(action['text'].encode('utf-16-le')) / 2 * max(action['interval'], .001) <= 5)
    if action['op'] == 'keyboard.chord':
        keys = parse_macos_keys(action['keys'])
        _require(isinstance(keys, list) and keys == action['keys'] and 1 <= len(keys) <= 8
                 and len(set(keys)) == len(keys) and all(len(key) <= 32 for key in keys))
        if 'event_flags' in action:
            flags = action['event_flags']
            _require(type(flags) is int and flags >= 0 and not flags & ~MACOS_RECORDED_KEY_FLAGS)


def validate_recording(recording):
    """Validate the whole untrusted document before any replay request or input."""
    try:
        _require(len(json.dumps(recording, ensure_ascii=False, allow_nan=False).encode('utf-8')) <= 64000)
        _require(isinstance(recording, dict))
        manual = recording.get('source') == 'native_window_events'
        required = {
            'schema', 'platform', 'coordinate_space', 'source', 'application', 'bounds',
            'complete', 'end_reason', 'actions'}
        if manual:
            required.add('input_source')
        _require(set(recording) == required)
        _require(type(recording['schema']) is int and recording['schema'] == (2 if manual else 1)
                 and recording['platform'] == 'darwin' and recording['coordinate_space'] == 'macos_global_points'
                 and recording['source'] in ('controlled_native_requests', 'native_window_events')
                 and recording['complete'] is True and recording['end_reason'] == 'stopped')
        if manual:
            _input_source(recording['input_source'])
        app = recording['application']
        _require(isinstance(app, dict) and set(app) == {'bundle_id', 'executable'})
        _require(isinstance(app['bundle_id'], str) and len(app['bundle_id']) <= 256
                 and isinstance(app['executable'], str) and app['executable'].startswith('/')
                 and len(app['executable']) <= 4096)
        _bounds(recording['bounds'])
        _require(isinstance(recording['actions'], list) and len(recording['actions']) <= 100)
        ended = 0
        for action in recording['actions']:
            _validate_action(action, recording['bounds'], ended)
            if manual:
                _require(action['op'] == 'input.sequence' and 'input_source' not in action)
            elif action['op'] == 'input.sequence':
                _require('input_source' in action)
            ended = action['ended']
    except (TypeError, ValueError, UnicodeError, RecursionError, OverflowError):
        raise DesktopError('recording_invalid', 'Recording contains invalid JSON or field values') from None


def _action_steps(action, target, old_bounds, input_source=None):
    op = action['op']
    args = {key: action[key] for key in _FIELDS[op]}
    if op.startswith('keyboard.') or op == 'input.sequence':
        expected_source = action.get('input_source', input_source)
        if expected_source is not None:
            args['input_source'] = expected_source
    if 'event_flags' in action:
        args['event_flags'] = action['event_flags']
    for key, axis in (('x', 'x'), ('y', 'y'), ('start_x', 'x'), ('start_y', 'y')):
        if key in args:
            args[key] += target['bounds'][axis] - old_bounds[axis]
    if op == 'input.sequence':
        for event in args['events']:
            if 'x' in event:
                event['x'] += target['bounds']['x'] - old_bounds['x']
                event['y'] += target['bounds']['y'] - old_bounds['y']
        validate_events(args['events'], target['bounds'])
        return [{'tool': 'input_sequence', 'args': {**args, 'target': target}}]
    if op == 'keyboard.text':
        enters = int(args.pop('enters'))
        args['use_clipboard'] = args.pop('paste')
        enter_args = {'key': 'enter', 'target': target}
        if 'input_source' in args:
            enter_args['input_source'] = args['input_source']
        return [{'tool': 'type_text', 'args': {**args, 'target': target}}] + [
            {'tool': 'press_key', 'args': dict(enter_args)} for _ in range(enters)]
    if op == 'keyboard.chord':
        name = 'hotkey'
    else:
        name = op.replace('.', '_')
        if op == 'mouse.scroll':
            args['clicks'] = args.pop('amount')
        if op == 'mouse.drag':
            args['end_x'], args['end_y'] = args.pop('x'), args.pop('y')
    return [{'tool': name, 'args': {**args, 'target': target}}]


def prepare_recording(recording, target):
    """Bind fresh native window identity, app and size. Translate points if the window moved."""
    recording = copy.deepcopy(recording)
    validate_recording(recording)
    payload = {'op': 'record.target', 'target': target, 'actions': recording['actions']}
    input_source = recording.get('input_source')
    if input_source is not None:
        payload['input_source'] = input_source
    if any(action['op'] == 'input.sequence' for action in recording['actions']):
        payload['sequence_bounds'] = recording['bounds']
    current = request(payload)
    if current.get('recording_pending'):
        raise DesktopError('recording_exists', 'Collect the active recording before replay')
    if current.get('application') != recording['application']:
        raise DesktopError('application_changed', 'Replay requires the same application executable and bundle identity')
    target = current['target']
    bounds = recording['bounds']
    if any(target['bounds'][key] != bounds[key] for key in ('width', 'height')):
        raise DesktopError('window_changed', 'Replay requires the recorded window size')
    steps, previous_end = [], 0
    for action in recording['actions']:
        gap = action['at'] - previous_end
        if steps and input_source is not None and gap > 0:
            steps.append({'tool': 'wait', 'args': {'seconds': gap}})
        elif steps and gap > .3:
            steps.append({'tool': 'wait', 'args': {'seconds': round(min(5., gap), 1)}})
        steps.extend(_action_steps(action, target, bounds, input_source))
        previous_end = action['ended']
    if len(steps) > 200:
        raise DesktopError('recording_capacity', 'Expanded recording exceeds the 200-step replay limit')
    return steps
