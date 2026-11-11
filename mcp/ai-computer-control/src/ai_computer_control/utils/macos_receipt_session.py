"""Journal-backed input-session exchange. Activated only by a real execution operation context.

The original untraced session remains available for legacy callers. Neither route retries a
mutation. A continue is written only after the entered evidence and continue intent were committed.
"""
import hashlib
import os
import selectors
import threading
import time
import uuid

from ai_computer_control.utils import macos_session as native
from ai_computer_control.utils.execution_journal import current_operation, ExecutionJournalError, _encoded
from ai_computer_control.utils.macos import DesktopError, _request_bytes, _identity, _failure_details, _OUTPUT_LIMIT
from ai_computer_control.utils.macos_receipts import ReceiptDecoder, validate_features, _json, GENERIC_OPERATIONS


def _current(session, *, alive=True):
    if native._SESSION is not session or session['closing']:
        raise DesktopError('input_session_protocol', 'Native receipt session is no longer current')
    if alive and session['child'].poll() is not None:
        raise DesktopError('input_session_failed', 'Native receipt worker exited')
    try:
        identity = _identity(session['path'])
    except OSError:
        raise DesktopError('dependency_changed', 'Native receipt helper is no longer available') from None
    if identity != session['identity']:
        raise DesktopError('dependency_changed', 'Native receipt helper changed')


def _close_owned(expected=None):
    if expected is not None and native._SESSION is not expected:
        return {'cleanup_unconfirmed': True}
    try:
        native._close_input_session()
        return {}
    except Exception:
        # The core session keeps a failed cleanup quarantined. Future callers must
        # confirm that exact worker exited before a replacement can be spawned.
        return {'cleanup_unconfirmed': True}


def _cancelled(event):
    return event is not None and event.is_set()


def _exchange(session, payload, deadline, cancel_event, cancel_lock, *, operation=None, features=None, progress=None):
    child = session['child']
    session['next_id'] += 1
    identifier = session['next_id']
    request = {**payload, 'id': identifier}
    decoder = None
    journal = operation['journal'] if operation else None
    operation_id = uuid.uuid4().hex
    parent_id = operation['operation_id'] if operation else None
    if operation:
        request['_ruyi_receipt'] = {'schema': 1, 'invocation_id': journal.invocation_id,
                                    'operation_id': operation_id, 'worker_id': features['worker_id']}
    frame = _request_bytes(request)
    data, offset, kind = frame + b'\n', 0, 'request'
    output = bytearray()
    result = None
    if operation:
        decoder = ReceiptDecoder(frame, invocation_id=journal.invocation_id, operation_id=operation_id,
            worker_id=features['worker_id'], worker_pid=child.pid, frame_id=identifier, op=payload['op'])
        reference = journal.snapshot(operation_id, frame, raw=True)
        journal.append('native_prepared', operation_id, parent_operation_id=parent_id, frame_id=identifier,
                       op=payload['op'], worker_id=features['worker_id'], worker_pid=child.pid,
                       frame_sha256=hashlib.sha256(frame).hexdigest(), helper_identity=[str(v) for v in session['identity']], **reference)
    with selectors.DefaultSelector() as streams:
        streams.register(child.stdin, selectors.EVENT_WRITE)
        streams.register(child.stdout, selectors.EVENT_READ)
        while result is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DesktopError('input_session_timeout', 'Native receipt request exceeded its deadline')
            # Prefer observed output to a newly queued continue. A timed-out/refused handshake
            # may already have returned while a strict filesystem write was in progress.
            ready = sorted(streams.select(min(remaining, .025)), key=lambda pair: pair[0].fileobj is child.stdin)
            for key, _ in ready:
                if result is not None:
                    break
                if key.fileobj is child.stdin:
                    _current(session)
                    if _cancelled(cancel_event):
                        streams.unregister(child.stdin)
                        continue
                    try:
                        if cancel_lock is None:
                            offset += os.write(child.stdin.fileno(), data[offset:offset + 4096])
                        else:
                            with cancel_lock:
                                if _cancelled(cancel_event):
                                    streams.unregister(child.stdin)
                                    continue
                                offset += os.write(child.stdin.fileno(), data[offset:offset + 4096])
                    except BlockingIOError:
                        continue
                    if offset == len(data):
                        streams.unregister(child.stdin)
                        if progress is not None:
                            progress[kind + '_sent'] = True
                        if decoder:
                            if kind == 'continue':
                                decoder.mark_continue_sent()
                                journal.append('native_continue_sent', operation_id, parent_operation_id=parent_id,
                                               frame_id=identifier, worker_id=features['worker_id'])
                            else:
                                journal.append('native_frame_sent', operation_id, parent_operation_id=parent_id,
                                               frame_id=identifier, worker_id=features['worker_id'])
                else:
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        raise DesktopError('input_session_failed', 'Native receipt worker exited before terminal')
                    _current(session, alive=False)
                    if decoder:
                        events = decoder.feed(chunk)
                        for phase, value in events:
                            if phase == 'handler_entered':
                                fields = {key: value[key] for key in ('frame_id', 'worker_id', 'worker_pid', 'op', 'frame_sha256', 'challenge')}
                                journal.append('native_entered', operation_id, parent_operation_id=parent_id, **fields)
                                if decoder.terminal is not None:
                                    continue  # entry + explicit refusal can arrive in one read
                                decoder.mark_entry_persisted()
                                if _cancelled(cancel_event):
                                    continue
                                _current(session)
                                journal.append('native_continue_intent', operation_id, parent_operation_id=parent_id,
                                               frame_id=identifier, worker_id=features['worker_id'], challenge=value['challenge'])
                                data, offset, kind = decoder.continuation(), 0, 'continue'
                                streams.register(child.stdin, selectors.EVENT_WRITE)
                            else:
                                fields = {key: value[key] for key in ('ok', 'code', 'action_sent', 'acted', 'cancelled', 'confirmed', 'outcome') if key in value}
                                journal.append('native_terminal', operation_id, parent_operation_id=parent_id,
                                               frame_id=identifier, worker_id=features['worker_id'], **fields)
                                result = decoder.finish()
                    else:
                        output.extend(chunk)
                        if len(output) > _OUTPUT_LIMIT:
                            raise DesktopError('input_session_capacity', 'Native feature response exceeds capacity')
                        if b'\n' in output:
                            line, remainder = bytes(output).split(b'\n', 1)
                            if remainder:
                                raise DesktopError('input_session_protocol', 'Unexpected feature response tail')
                            result = _json(line)
                            if not isinstance(result, dict) or type(result.get('id')) is not int or result['id'] != identifier:
                                raise DesktopError('input_session_protocol', 'Native feature response does not match request')
    _current(session, alive=False)
    return result, identifier, frame


def request(payload, timeout=15, cancel_event=None, cancel_lock=None, *, generic=False):
    operation = current_operation()
    if operation is None:
        raise DesktopError('input_session_protocol', 'Missing execution context for receipt exchange')
    if generic and payload.get('op') not in GENERIC_OPERATIONS:
        raise DesktopError('execution_receipts_unsupported', 'Native operation has no negotiated receipt route',
                           {'action_sent': False, 'outcome': 'not_dispatched'})
    if generic and cancel_event is None:
        from ai_computer_control.utils.execution_context import request_cancellation
        cancel_event, cancel_lock = request_cancellation()
    if cancel_event is not None and cancel_lock is None:
        raise DesktopError('invalid_args', 'Cancellable receipt requests require their write lock',
                           {'action_sent': False, 'outcome': 'not_dispatched'})
    if not native._LOCK.acquire(blocking=False):
        raise DesktopError('desktop_busy', 'Another native input request is already running')
    monitor = None
    monitor_started = False
    stopped = threading.Event()
    progress = {'request_sent': False, 'continue_sent': False}
    try:
        if _cancelled(cancel_event):
            raise DesktopError('input_cancelled', 'Native input cancelled before receipt dispatch',
                               {'action_sent': False, 'outcome': 'not_dispatched'})
        session = native._session()
        child = session['child']
        if cancel_event is not None:
            def observe_cancel():
                # Filesystem fsync may block the request thread. Owned native cleanup must
                # observe cancellation independently, without waiting for that thread's lock.
                while not stopped.wait(.01):
                    if _cancelled(cancel_event):
                        if native._SESSION is session and not session['closing'] and child.poll() is None:
                            try: child.terminate()
                            except ProcessLookupError: pass
                        break
            monitor = threading.Thread(target=observe_cancel, name='ruyi-native-receipt-cancel', daemon=True)
            monitor.start()
            monitor_started = True
        deadline = time.monotonic() + timeout
        if 'receipt_features' not in session:
            result, identifier, frame = _exchange(session, {'op': 'session.features'}, min(deadline, time.monotonic() + 3.),
                                                   cancel_event, cancel_lock)
            feature = validate_features(result, child.pid)
            probe_id = uuid.uuid4().hex
            reference = operation['journal'].snapshot(probe_id, frame, raw=True)
            operation['journal'].append('native_features', probe_id, parent_operation_id=operation['operation_id'],
                frame_id=identifier, worker_pid=child.pid, receipt_version=1 if feature else 0, **reference)
            session['receipt_features'] = feature
        features = session['receipt_features']
        if features is None:
            raise DesktopError('execution_receipts_unsupported', 'Update the native helper to use execution receipts',
                               {'action_sent': False, 'outcome': 'not_dispatched'})
        if generic and payload['op'] not in features['request_operations']:
            raise DesktopError('execution_receipts_unsupported', 'Update the native helper for this receipt operation',
                               {'action_sent': False, 'outcome': 'not_dispatched'})
        result, _, _ = _exchange(session, payload, deadline, cancel_event, cancel_lock,
                                 operation=operation, features=features, progress=progress)
        if result['ok'] is not True:
            raise DesktopError(str(result.get('code') or 'input_failed'), str(result.get('error') or 'Native input operation failed'), _failure_details(result))
        result.pop('id', None); result.pop('receipt', None)
        return result
    except ExecutionJournalError as error:
        # Even a complete-looking line is not published when the strict writer fails.
        # Cleanup precedes reporting unknown; no mutation is retried here.
        cleanup = _close_owned()
        raise DesktopError('execution_receipt_failed', str(error), {'outcome': 'unknown', **cleanup}) from error
    except (DesktopError, OSError) as error:
        if isinstance(error, OSError):
            error = DesktopError('input_session_failed', 'Native receipt communication failed', {'outcome': 'unknown'})
        if error.code.startswith('input_session_') or error.code in ('dependency_changed', 'execution_receipt_failed') or _cancelled(cancel_event):
            error.details.update(_close_owned())
            if progress['request_sent'] and error.details.get('outcome') != 'not_dispatched':
                error.details['outcome'] = 'unknown'
        raise error
    except Exception as error:
        cleanup = _close_owned()
        raise DesktopError('input_session_failed', 'Native receipt exchange failed', {'outcome': 'unknown', **cleanup}) from error
    except BaseException:
        _close_owned()
        raise
    finally:
        stopped.set()
        try:
            if monitor_started:
                try:
                    monitor.join(timeout=.25)
                    observer_alive = monitor.is_alive()
                except Exception as error:
                    cleanup = _close_owned()
                    raise DesktopError('input_session_failed', 'Native cancellation observer cleanup failed', {'outcome': 'unknown', **cleanup}) from error
                if observer_alive:
                    # A delayed observer may already be inside terminate().
                    # Retire this exact Popen before releasing the request
                    # lock; it must never observe a newly reused worker.
                    cleanup = _close_owned(session)
                    raise DesktopError('input_session_failed', 'Native cancellation observer did not stop',
                                       {'outcome': 'unknown', **cleanup})
        finally:
            native._LOCK.release()
