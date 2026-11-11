"""Strict portable Mac event rows, validated in full before native dispatch."""
import json
import math

from ai_computer_control.utils.macos import DesktopError

_MODIFIERS = {54: 0x100000, 55: 0x100000, 56: 0x20000, 60: 0x20000,
              58: 0x80000, 61: 0x80000, 59: 0x40000, 62: 0x40000, 63: 0x800000}
_DEVICE_MODIFIERS = {54: 0x10, 55: 0x8, 56: 0x2, 60: 0x4, 58: 0x20, 61: 0x40, 59: 0x1, 62: 0x2000}
_FLAGS = 0xffffffff
_MODIFIER_FLAGS = 0x9e0000


def _require(condition):
    if not condition:
        raise DesktopError('invalid_args', 'Pass a balanced sequence of 1-512 supported events over at most five seconds')


def _number(value, low, high, integer=False):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high \
        and (not integer or value == int(value))


def validate_events(events, bounds=None):
    """Reject an invalid suffix before any event is posted, including unmatched input and scroll phases."""
    try:
        _require(isinstance(events, list) and 1 <= len(events) <= 512)
        _require(len(json.dumps(events, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')) <= 48000)
        keys, buttons = set(), set()
        previous, scrolling, momentum = 0, 0, False
        for index, event in enumerate(events):
            _require(isinstance(event, dict) and isinstance(event.get('type'), str))
            kind = event['type']
            fields = {'type', 'at_us', 'flags'}
            _require(_number(event.get('at_us'), previous, 5000000, True) and (index != 0 or event['at_us'] == 0))
            _require(type(event.get('flags')) is int and event['flags'] >= 0 and not event['flags'] & ~_FLAGS)
            previous = event['at_us']
            if kind in ('key_down', 'key_up', 'flags'):
                fields |= {'keycode', 'keyboard_type'}
                _require(_number(event.get('keycode'), 0, 127, True) and _number(event.get('keyboard_type'), 0, 65535, True))
                code = event['keycode']
                if kind == 'flags':
                    _require(code in _MODIFIERS or code == 57)
                    if code != 57:
                        keys.symmetric_difference_update({code})
                else:
                    fields.add('repeat')
                    _require(_number(event.get('repeat'), 0, 1, True) and code not in _MODIFIERS and code != 57)
                    if 'unicode' in event:
                        fields.add('unicode')
                        _require(isinstance(event['unicode'], str) and len(event['unicode'].encode('utf-16-le')) <= 40)
                    if kind == 'key_down':
                        _require(bool(event['repeat']) == (code in keys))
                        keys.add(code)
                    else:
                        _require(event['repeat'] == 0 and code in keys)
                        keys.remove(code)
            else:
                fields |= {'x', 'y'}
                _require(_number(event.get('x'), -1000000, 1000000) and _number(event.get('y'), -1000000, 1000000))
                if bounds is not None:
                    _require(bounds['x'] <= event['x'] < bounds['x'] + bounds['width']
                             and bounds['y'] <= event['y'] < bounds['y'] + bounds['height'])
                if kind == 'scroll':
                    fields |= {'delta', 'fixed', 'point', 'continuous', 'phase', 'momentum', 'scroll_count'}
                    _require(type(event.get('continuous')) is bool and _number(event.get('phase'), 0, 255, True)
                             and not int(event['phase']) & ~143 and _number(event.get('momentum'), 0, 3, True)
                             and _number(event.get('scroll_count'), 0, 2147483647, True))
                    for name in ('delta', 'fixed', 'point'):
                        values = event.get(name)
                        _require(isinstance(values, list) and len(values) == 3
                                 and all(_number(value, -32767, 32767, name != 'fixed') for value in values))
                    phase, stage = int(event['phase']), event['momentum']
                    if phase & 128:
                        _require(not scrolling and not phase & ~128)
                        scrolling = 128
                    if phase & 1:
                        _require(scrolling != 1 and not momentum)
                        scrolling = 1
                    if phase & 2:
                        _require(scrolling == 1)
                    if phase & (4 | 8):
                        _require(scrolling and not (phase & 4 and phase & 8))
                        scrolling = 0
                    if stage == 1:
                        _require(not momentum and not scrolling)
                        momentum = True
                    if stage == 2:
                        _require(momentum)
                    if stage == 3:
                        _require(momentum)
                        momentum = False
                else:
                    _require(kind in ('mouse_down', 'mouse_up', 'drag', 'move'))
                    fields |= {'button', 'click_state', 'pressure', 'delta_x', 'delta_y'}
                    if 'subtype' in event:
                        fields.add('subtype')
                        _require(_number(event['subtype'], 0, 3, True) and event['subtype'] in (0, 3))
                    _require(_number(event.get('button'), 0, 2, True) and _number(event.get('click_state'), 0, 5, True)
                             and _number(event.get('pressure'), 0, 1)
                             and _number(event.get('delta_x'), -2147483648, 2147483647, True)
                             and _number(event.get('delta_y'), -2147483648, 2147483647, True))
                    button = event['button']
                    if kind == 'mouse_down':
                        _require(button not in buttons)
                        buttons.add(button)
                    elif kind == 'mouse_up':
                        _require(button in buttons)
                        buttons.remove(button)
                    elif kind == 'drag':
                        _require(button in buttons)
            _require(set(event) == fields)
            expected, expected_device = 0, 0
            for code in keys:
                expected |= _MODIFIERS.get(code, 0)
                expected_device |= _DEVICE_MODIFIERS.get(code, 0)
            _require(event['flags'] & _MODIFIER_FLAGS == expected)
            device = event['flags'] & 0x207f
            _require(not device or device == expected_device)
        _require(not keys and not buttons and not scrolling and not momentum)
    except (TypeError, ValueError, UnicodeError, RecursionError, OverflowError, KeyError):
        raise DesktopError('invalid_args', 'Sequence contains invalid JSON or field values') from None
