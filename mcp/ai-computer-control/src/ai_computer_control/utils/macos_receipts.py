"""Pure negotiated native receipt framing. No file writes, desktop calls, or retry policy.

The digest covers the exact UTF-8 request bytes before its terminating newline. Receipt metadata is
transport-only: the native worker removes it before entering any business/recording function.
An entered receipt is not permission, event submission, release, or an application outcome.
"""
import hashlib
import json
import math
import re

from ai_computer_control.utils.macos import DesktopError, _OUTPUT_LIMIT

_TOKEN = re.compile(r'^[0-9a-f]{32}$')
_KEYS = frozenset({'schema', 'phase', 'invocation_id', 'operation_id', 'worker_id', 'worker_pid',
                   'frame_id', 'frame_sha256', 'op', 'challenge'})


def _protocol(message):
    return DesktopError('input_session_protocol', message)


def _json(line):
    def reject(_):
        raise ValueError('non-finite JSON')
    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('non-finite JSON number')
        return number
    def unique(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ValueError('duplicate JSON field')
            out[key] = value
        return out
    try:
        return json.loads(line, parse_constant=reject, parse_float=finite, object_pairs_hook=unique)
    except (ValueError, UnicodeError, TypeError):
        raise _protocol('Invalid native receipt JSON') from None


def validate_features(result, child_pid):
    """Only the exact legacy unsupported contract means absent, not denial/malformed/EOF."""
    if isinstance(result, dict) and result.get('ok') is False and result.get('code') == 'invalid_args' \
            and result.get('error') == 'Unsupported desktop operation':
        return None
    if not isinstance(result, dict) or result.get('ok') is not True \
            or type(result.get('protocolVersion')) is not int or result['protocolVersion'] != 1 \
            or type(result.get('executionReceiptVersion')) is not int or result['executionReceiptVersion'] != 1 \
            or type(result.get('worker_pid')) is not int or result['worker_pid'] != child_pid \
            or not isinstance(result.get('worker_id'), str) or not _TOKEN.fullmatch(result['worker_id']):
        raise DesktopError('execution_receipts_unavailable', 'Native receipt feature could not be established',
                           {'action_sent': False, 'outcome': 'not_dispatched'})
    return {'worker_id': result['worker_id'], 'worker_pid': child_pid, 'schema': 1}


class ReceiptDecoder:
    """At most one entered and one terminal, bound to one immutable native frame."""
    def __init__(self, frame, *, invocation_id, operation_id, worker_id, worker_pid, frame_id, op):
        for value in (invocation_id, operation_id, worker_id):
            if not isinstance(value, str) or not _TOKEN.fullmatch(value):
                raise _protocol('Invalid native receipt correlation token')
        if type(worker_pid) is not int or worker_pid <= 0 or type(frame_id) is not int or not 1 <= frame_id <= 9007199254740991:
            raise _protocol('Invalid native receipt process/frame identity')
        if not isinstance(op, str) or not 0 < len(op) <= 100 or not isinstance(frame, bytes) or frame.endswith(b'\n'):
            raise _protocol('Invalid native receipt frame snapshot')
        self.expected = {'schema': 1, 'invocation_id': invocation_id, 'operation_id': operation_id,
                         'worker_id': worker_id, 'worker_pid': worker_pid, 'frame_id': frame_id,
                         'frame_sha256': hashlib.sha256(frame).hexdigest(), 'op': op}
        self.buffer = bytearray()
        self.total_bytes = 0
        self.entered = None
        self.terminal = None
        self.entry_persisted = False
        self.continue_sent = False

    def feed(self, data):
        if not isinstance(data, bytes) or self.terminal is not None:
            raise _protocol('Unexpected bytes after native terminal')
        self.total_bytes += len(data)
        if self.total_bytes > _OUTPUT_LIMIT:
            raise DesktopError('input_session_capacity', 'Native receipt response exceeds its capacity')
        self.buffer.extend(data)
        out = []
        while b'\n' in self.buffer:
            line, _, rest = self.buffer.partition(b'\n')
            self.buffer = bytearray(rest)
            result = _json(bytes(line))
            receipt = result.get('receipt') if isinstance(result, dict) else None
            if not isinstance(result, dict) or type(result.get('id')) is not int or result['id'] != self.expected['frame_id'] \
                    or not isinstance(receipt, dict) or set(receipt) != _KEYS:
                raise _protocol('Native receipt envelope does not match the request')
            if type(receipt.get('schema')) is not int or type(receipt.get('worker_pid')) is not int \
                    or type(receipt.get('frame_id')) is not int \
                    or any(receipt.get(key) != value for key, value in self.expected.items()) \
                    or not isinstance(receipt.get('challenge'), str) or not _TOKEN.fullmatch(receipt['challenge']):
                raise _protocol('Native receipt identity or frame digest mismatch')
            phase = receipt.get('phase')
            if phase == 'handler_entered' and self.entered is None and self.terminal is None and set(result) == {'id', 'receipt'}:
                self.entered = dict(receipt)
                out.append(('handler_entered', dict(receipt)))
            elif phase == 'terminal' and self.entered is not None and self.terminal is None \
                    and receipt['challenge'] == self.entered['challenge'] and type(result.get('ok')) is bool:
                if result['ok'] and (type(result.get('protocolVersion')) is not int or result['protocolVersion'] != 1):
                    raise _protocol('Unsupported native terminal protocol')
                # A failed handshake may terminalize without continue; it must explicitly refuse
                # this frame. Successful/effectful terminals require our complete continue write.
                refused = result.get('ok') is False and result.get('outcome') == 'not_dispatched' \
                    and result.get('action_sent') is False and result.get('acted') is False
                if not self.continue_sent and not refused:
                    raise _protocol('Native terminal arrived before committed continue')
                if self.buffer:
                    raise _protocol('Unexpected trailing native receipt bytes')
                self.terminal = dict(result)
                out.append(('terminal', dict(result)))
            else:
                raise _protocol('Duplicate or out-of-order native receipt')
        return out

    def mark_entry_persisted(self):
        if self.entered is None or self.terminal is not None:
            raise _protocol('Cannot commit an absent or terminalized native entry')
        self.entry_persisted = True

    def continuation(self):
        if not self.entry_persisted or self.continue_sent or self.terminal is not None or self.buffer:
            raise _protocol('Native entry has not been durably committed')
        receipt = {**self.entered, 'phase': 'continue'}
        return json.dumps({'id': self.expected['frame_id'], 'receipt': receipt}, ensure_ascii=False,
                          allow_nan=False, separators=(',', ':')).encode('utf-8') + b'\n'

    def mark_continue_sent(self):
        if not self.entry_persisted or self.continue_sent or self.terminal is not None or self.buffer:
            raise _protocol('Unexpected native continue write state')
        self.continue_sent = True

    def finish(self):
        if self.terminal is None or self.buffer:
            raise _protocol('Native session ended without a complete terminal')
        return dict(self.terminal)
