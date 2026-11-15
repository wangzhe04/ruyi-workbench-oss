"""Semantic validation of committed receipt graphs and their private argument/frame blobs.

The product execution_receipt tool uses this reader. The pure graph validator checks typed
fields and causal identities; the descriptor reader also verifies each immutable private blob.
It does not infer application consumption, authorize a continuation, or replay any operation.
"""
from datetime import datetime
import re

from ai_computer_control.utils.execution_journal import ExecutionJournalError, MAX_EVENTS, MAX_BLOB_BYTES

_TOKEN = re.compile(r'[a-f0-9]{32}')
_HASH = re.compile(r'[a-f0-9]{64}')
_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.-]{0,99}')
_BASE = frozenset({'schema', 'invocation_id', 'operation_id', 'sequence', 'stage', 'acc_worker_id', 'acc_pid', 'at'})
_REF = frozenset({'args_ref', 'args_sha256', 'args_bytes', 'args_codec'})
_PARENT = frozenset({'parent_operation_id'})
_NATIVE = frozenset({'frame_id', 'worker_id'})
_FLAGS = frozenset({'ok', 'action_sent', 'acted', 'cancelled', 'confirmed', 'outcome', 'code'})
_REQUIRED = {
    'acc_request_accepted': _REF | {'tool', 'session_id', 'turn_seq', 'call_id_hash', 'caller_args_sha256',
        'caller_args_codec', 'caller_semantic_sha256', 'received_semantic_sha256', 'args_semantic_codec'},
    'tool_entered': _REF | _PARENT | {'tool'},
    'tool_terminal': frozenset({'tool'}),
    'native_features': _REF | _PARENT | {'frame_id', 'worker_pid', 'receipt_version'},
    'native_prepared': _REF | _PARENT | _NATIVE | {'worker_pid', 'op', 'frame_sha256', 'helper_identity'},
    'native_frame_sent': _PARENT | _NATIVE,
    'native_entered': _PARENT | _NATIVE | {'worker_pid', 'op', 'frame_sha256', 'challenge'},
    'native_continue_intent': _PARENT | _NATIVE | {'challenge'},
    'native_continue_sent': _PARENT | _NATIVE,
    'native_terminal': _PARENT | _NATIVE | {'ok'},
    'acc_request_terminal': frozenset({'ok'}),
}
_OPTIONAL = {'tool_entered': {'batch_step'}, 'tool_terminal': _FLAGS,
             'native_terminal': _FLAGS, 'acc_request_terminal': {'outcome'}}


def _require(condition, message):
    if not condition:
        raise ExecutionJournalError('execution_receipt_semantics', message)


def _match(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _integer(value, low=1, high=9007199254740991):
    return type(value) is int and low <= value <= high


def _shape(row):
    _require(isinstance(row, dict) and isinstance(row.get('stage'), str) and row['stage'] in _REQUIRED, 'Unknown receipt stage')
    stage = row['stage']
    required = _BASE | _REQUIRED[stage]
    _require(required <= row.keys() <= required | _OPTIONAL.get(stage, set()), 'Unexpected receipt fields')
    _require(type(row['schema']) is int and row['schema'] == 1, 'Invalid receipt schema')
    for field in ('invocation_id', 'operation_id', 'acc_worker_id', 'parent_operation_id', 'worker_id', 'challenge'):
        if field in row:
            _require(_match(_TOKEN, row[field]), 'Invalid receipt identity: ' + field)
    for field in ('acc_pid', 'worker_pid', 'frame_id', 'sequence', 'turn_seq'):
        if field in row:
            _require(_integer(row[field]), 'Invalid receipt integer: ' + field)
    for field in ('tool', 'op'):
        if field in row:
            _require(_match(_NAME, row[field]), 'Invalid receipt name: ' + field)
    for field in ('args_sha256', 'frame_sha256', 'caller_args_sha256', 'call_id_hash', 'caller_semantic_sha256', 'received_semantic_sha256'):
        if field in row:
            _require(_match(_HASH, row[field]), 'Invalid receipt digest: ' + field)
    for field in ('ok', 'action_sent', 'acted', 'cancelled'):
        if field in row:
            _require(type(row[field]) is bool, 'Invalid receipt flag: ' + field)
    if 'confirmed' in row:
        _require(row['confirmed'] is None or type(row['confirmed']) is bool, 'Invalid confirmation flag')
    if 'outcome' in row:
        _require(row['outcome'] in ('unknown', 'unconfirmed', 'not_dispatched', 'rolled_back'), 'Invalid outcome')
    if row.get('outcome') == 'not_dispatched':
        _require(row.get('ok') is not True and row.get('action_sent') is not True
                 and row.get('acted') is not True and row.get('confirmed') is not True, 'Conflicting non-dispatch flags')
    if stage == 'acc_request_terminal' and 'outcome' in row:
        _require(row['ok'] is False and row['outcome'] in ('unknown', 'not_dispatched'), 'Conflicting request terminal')
    if 'code' in row:
        _require(isinstance(row['code'], str) and len(row['code']) <= 100, 'Invalid outcome code')
    if 'batch_step' in row:
        _require(_integer(row['batch_step'], 0, 199), 'Invalid batch step')
    if 'receipt_version' in row:
        _require(type(row['receipt_version']) is int and row['receipt_version'] in (0, 1), 'Invalid native feature version')
    _require(isinstance(row['at'], str) and 20 <= len(row['at']) <= 40, 'Invalid receipt timestamp')
    try:
        stamp = datetime.fromisoformat(row['at'])
    except ValueError:
        _require(False, 'Invalid receipt timestamp')
    _require(stamp.tzinfo is not None, 'Receipt timestamp lacks timezone')
    if 'args_ref' in row:
        _require(row['args_ref'] == 'args-' + row['operation_id'] + '.json', 'Invalid argument reference')
        _require(_integer(row['args_bytes'], 0, MAX_BLOB_BYTES), 'Invalid argument extent')
        codec = 'exact-native-frame' if stage.startswith('native_') else 'python-json-sorted-utf8-v1'
        _require(row['args_codec'] == codec, 'Invalid actual-argument codec')
    if 'helper_identity' in row:
        identity = row['helper_identity']
        _require(isinstance(identity, list) and len(identity) == 4
                 and all(isinstance(v, str) and re.fullmatch(r'[0-9]{1,30}', v) for v in identity), 'Invalid helper identity')
    if stage == 'acc_request_accepted':
        _require(isinstance(row['session_id'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', row['session_id']), 'Invalid session')
        _require(row['caller_args_codec'] == 'javascript-json-utf8-v1'
                 and row['args_semantic_codec'] == 'ruyi-sdk-json-v1'
                 and row['caller_semantic_sha256'] == row['received_semantic_sha256'], 'Unbound actual argument digest')


def validate_committed_receipts(value, *, expected=None):
    """Validate an entire published prefix; a valid prefix may still have an incomplete lifecycle.

    `expected` is optional already-validated host preparation metadata. Private blob contents and
    their semantic digests must also be checked by the later descriptor-based reader integration.
    A terminal is derived from the graph, never trusted from the input's summary boolean.
    lifecycle_unknown=False proves a complete receipt lifecycle, not effects, application
    consumption or permission to replay. Reported flags are a separate axis: even a complete
    lifecycle can explicitly report outcome=unknown. Missing flags never imply no dispatch.
    A failed tool may have already caused effects.
    """
    _require(isinstance(value, dict) and type(value.get('schema')) is int and value['schema'] == 1
             and _match(_TOKEN, value.get('invocation_id')) and type(value.get('incomplete')) is bool
             and isinstance(value.get('records'), list) and len(value['records']) <= MAX_EVENTS, 'Invalid receipt prefix')
    rows = value['records']
    operations, native_frames, native_workers = {}, set(), {}
    root = None
    request_terminal = None
    worker = None

    def ancestors_open(parent_id):
        while parent_id is not None:
            parent = operations.get(parent_id)
            _require(parent is not None and parent['terminal'] is None, 'Missing or terminal ancestor')
            parent_id = parent['entry'].get('parent_operation_id')

    for index, row in enumerate(rows, 1):
        _shape(row)
        _require(row['invocation_id'] == value['invocation_id'] and row['sequence'] == index, 'Receipt prefix is not contiguous')
        identity = (row['acc_worker_id'], row['acc_pid'])
        _require(worker is None or identity == worker, 'ACC incarnation changed within an invocation')
        worker = identity
        _require(request_terminal is None, 'Receipt follows request terminal')
        stage, operation = row['stage'], row['operation_id']
        previous = operations.get(operation)
        if stage == 'acc_request_accepted':
            _require(index == 1 and root is None, 'Request acceptance is not the unique first receipt')
            root = row
            operations[operation] = {'entry': row, 'last': stage, 'terminal': None}
            if expected is not None:
                fields = {'invocation_id': 'invocation_id', 'tool_name': 'tool', 'session_id': 'session_id',
                    'turn_seq': 'turn_seq', 'call_id_hash': 'call_id_hash', 'args_sha256': 'caller_args_sha256',
                    'args_codec': 'caller_args_codec', 'args_semantic_sha256': 'received_semantic_sha256',
                    'args_semantic_codec': 'args_semantic_codec'}
                _require(all(key in expected and expected[key] == row[target] for key, target in fields.items()),
                         'Receipt does not match host preparation')
        else:
            _require(root is not None, 'Receipt lacks request acceptance')
            if stage in ('tool_entered', 'native_features', 'native_prepared'):
                _require(previous is None, 'Duplicate operation identity')
                ancestors_open(row['parent_operation_id'])
                parent = operations[row['parent_operation_id']]
                parent_stage = parent['entry']['stage']
                _require(parent_stage in (('acc_request_accepted', 'tool_entered') if stage == 'tool_entered' else ('tool_entered',)),
                         'Invalid operation parent kind')
                if stage == 'tool_entered' and parent_stage == 'acc_request_accepted':
                    _require(row['tool'] == root['tool'] and not any(v['entry']['stage'] == 'tool_entered'
                        and v['entry']['parent_operation_id'] == root['operation_id'] for v in operations.values()),
                        'Invalid top-level tool wrapper')
                if stage.startswith('native_'):
                    frame_key = (row['worker_pid'], row['frame_id'])
                    if stage == 'native_prepared':
                        frame_key = (row['worker_id'], row['frame_id'])
                        _require(row['frame_sha256'] == row['args_sha256'], 'Native frame and snapshot digests disagree')
                        _require(row['worker_id'] not in native_workers or native_workers[row['worker_id']] == row['worker_pid'],
                                 'Native incarnation changed PID')
                        native_workers[row['worker_id']] = row['worker_pid']
                    _require(frame_key not in native_frames, 'Duplicate native frame')
                    native_frames.add(frame_key)
                operations[operation] = {'entry': row, 'last': stage, 'terminal': row if stage == 'native_features' else None}
            elif stage == 'tool_terminal':
                _require(previous is not None and previous['entry']['stage'] == 'tool_entered'
                         and previous['terminal'] is None and previous['entry']['tool'] == row['tool'], 'Unbound tool terminal')
                ancestors_open(previous['entry']['parent_operation_id'])
                previous['terminal'] = row
            elif stage == 'acc_request_terminal':
                _require(operation == root['operation_id'] and previous['terminal'] is None, 'Unbound request terminal')
                if row.get('outcome') == 'not_dispatched':
                    _require(not any(op['entry']['stage'] == 'tool_entered' for op in operations.values()),
                             'Request claims non-dispatch after a tool wrapper entered')
                previous['terminal'] = request_terminal = row
            else:
                _require(previous is not None and previous['entry']['stage'] == 'native_prepared'
                         and previous['terminal'] is None, 'Unbound native receipt')
                entry = previous['entry']
                ancestors_open(entry['parent_operation_id'])
                _require(all(row[key] == entry[key] for key in ('parent_operation_id', 'worker_id', 'frame_id')), 'Native receipt identity changed')
                order = {'native_frame_sent': 'native_prepared', 'native_entered': 'native_frame_sent',
                         'native_continue_intent': 'native_entered', 'native_continue_sent': 'native_continue_intent'}
                if stage == 'native_terminal':
                    refused = row['ok'] is False and row.get('outcome') == 'not_dispatched' \
                        and row.get('action_sent') is False and row.get('acted') is False
                    _require(previous['last'] == 'native_continue_sent' or
                             (previous['last'] in ('native_entered', 'native_continue_intent') and refused),
                             'Native terminal lacks continued entry or explicit refusal')
                    previous['terminal'] = row
                else:
                    _require(previous['last'] == order.get(stage), 'Native receipt transition is out of order')
                if stage == 'native_entered':
                    _require(all(row[key] == entry[key] for key in ('worker_pid', 'op', 'frame_sha256')), 'Native entered frame changed')
                    previous['challenge'] = row['challenge']
                elif stage == 'native_continue_intent':
                    _require(row['challenge'] == previous.get('challenge'), 'Native challenge changed')
                previous['last'] = stage
    unresolved = [key for key, op in operations.items() if op['terminal'] is None
                  or (op['entry']['stage'] == 'tool_entered' and 'ok' not in op['terminal'])]
    top = next((op for op in operations.values() if op['entry']['stage'] == 'tool_entered'
                and op['entry']['parent_operation_id'] == root['operation_id']), None) if root else None
    missing_tool = bool(request_terminal and (top is None or top['terminal'] is None)
                        and not (request_terminal['ok'] is False and request_terminal.get('outcome') == 'not_dispatched'))
    terminals = {key: {'stage': op['terminal']['stage'],
                      'flags': {field: op['terminal'][field] for field in _FLAGS if field in op['terminal']}}
                 for key, op in operations.items() if op['terminal'] is not None and op['entry']['stage'] != 'native_features'}
    return {'semantic_version': 1, 'invocation_id': value['invocation_id'], 'records_validated': len(rows),
            'request_terminal_observed': request_terminal is not None,
            'request_transport_returned': request_terminal['ok'] if request_terminal else None,
            'unresolved_operation_ids': unresolved,
            'top_level_tool_observed': top is not None,
            'lifecycle_unknown': value['incomplete'] or request_terminal is None or bool(unresolved) or missing_tool,
            'reported_unknown_operation_ids': [key for key, terminal in terminals.items() if terminal['flags'].get('outcome') == 'unknown'],
            'terminal_flags': terminals}



def read_validated_receipts(invocation_id, *, expected=None):
    """Read and validate immutable argument/frame blobs without returning their private contents.

    The product receipt tool uses this reader. A missing/altered blob refuses
    validation, never supplies a false terminal. Retention must tolerate this same fail-closed race.
    """
    import hashlib
    import os
    from ai_computer_control.utils import execution_journal as journal
    from ai_computer_control.utils.execution_arguments import arguments_digest
    from ai_computer_control.utils.macos import DesktopError
    from ai_computer_control.utils.macos_receipts import _json
    value = journal.read_receipts(invocation_id)
    summary = validate_committed_receipts(value, expected=expected)
    if not value['records']:
        return {**value, 'semantic_validation': summary}
    parent = directory = None
    try:
        _, parent = journal._base_directory()
        directory = os.open(invocation_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        _require(os.fstat(directory).st_uid == os.geteuid(), 'Receipt directory is not owned')
        total = 0
        for row in value['records']:
            if 'args_ref' not in row:
                continue
            total += row['args_bytes']
            _require(total <= journal.MAX_TRACE_BYTES, 'Referenced arguments exceed trace capacity')
            fd = os.open(row['args_ref'], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
            try:
                before = journal._regular(fd)
                _require(before.st_size == row['args_bytes'], 'Argument extent changed')
                data = bytearray()
                while len(data) < before.st_size:
                    chunk = os.read(fd, min(65536, before.st_size - len(data)))
                    _require(bool(chunk), 'Argument blob truncated')
                    data.extend(chunk)
                after = journal._regular(fd)
                _require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                         == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                         and not os.read(fd, 1), 'Argument blob changed during validation')
            finally:
                os.close(fd)
            _require(hashlib.sha256(data).hexdigest() == row['args_sha256'], 'Argument blob digest mismatch')
            if row['args_codec'] == 'exact-native-frame':
                _require(0 < len(data) <= 65536 and b'\n' not in data, 'Native snapshot violates single-frame transport bounds')
            actual = _json(bytes(data))
            _require(isinstance(actual, dict), 'Argument snapshot is not an object')
            if row['stage'] == 'acc_request_accepted':
                _require(arguments_digest(actual) == row['received_semantic_sha256'], 'Actual argument binding changed')
            elif row['stage'] in ('native_prepared', 'native_features'):
                _require('receipt' not in actual, 'Native request contains a reserved continue envelope')
                _require(type(actual.get('id')) is int and actual['id'] == row['frame_id']
                         and type(actual.get('version')) is int and actual['version'] == 1,
                         'Actual native frame identity changed')
                if row['stage'] == 'native_features':
                    _require(actual.get('op') == 'session.features' and set(actual) == {'id', 'version', 'op'},
                             'Actual feature request changed')
                else:
                    _require(actual.get('op') == row['op'] and actual.get('_ruyi_receipt') == {
                        'schema': 1, 'invocation_id': invocation_id,
                        'operation_id': row['operation_id'], 'worker_id': row['worker_id']}, 'Actual native frame binding changed')
                    control = actual['_ruyi_receipt']
                    _require(type(control.get('schema')) is int, 'Actual native receipt schema changed')
        return {**value, 'semantic_validation': summary}
    except ExecutionJournalError:
        raise
    except (OSError, ValueError, TypeError, UnicodeError, DesktopError, OverflowError, RecursionError) as error:
        raise ExecutionJournalError('execution_receipt_semantics', 'Cannot validate private argument/frame evidence') from error
    finally:
        for fd in (directory, parent):
            if fd is not None:
                os.close(fd)
