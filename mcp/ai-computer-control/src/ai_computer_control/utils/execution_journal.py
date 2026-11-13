"""Strict, bounded execution evidence, separate from best-effort audit logs.

This module does not execute or retry tools. Callers must append/fsync entry evidence before
continuing an operation and preserve unknown state if a post-effect append fails. Files survive
process death; this is not a guarantee against hardware failure. fsync has no promised wall-time
bound. Unresolved traces are never silently pruned. All paths derive from trusted data_dir plus
validated random identifiers, never from MCP metadata paths.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import hashlib
try:
    import fcntl
except ImportError:  # default non-receipt tool paths remain importable on Windows
    fcntl = None
import json
import math
import os
from pathlib import Path
import re
import stat
import threading
import time
import uuid

from ai_computer_control.paths import logs_dir

_TOKEN = re.compile(r'^[a-f0-9]{32}$')
_STAGES = frozenset({'acc_request_accepted', 'tool_entered', 'tool_terminal', 'native_features',
                     'native_prepared', 'native_frame_sent', 'native_entered', 'native_continue_intent',
                     'native_continue_sent', 'native_terminal', 'acc_request_terminal'})
_FIELDS = frozenset({'tool', 'parent_operation_id', 'batch_step', 'frame_id', 'worker_id', 'worker_pid',
                     'op', 'frame_sha256', 'challenge', 'receipt_version', 'code', 'ok', 'outcome', 'acted',
                     'action_sent', 'cancelled', 'confirmed', 'args_ref', 'args_sha256', 'args_bytes',
                     'args_codec', 'helper_identity', 'session_id', 'turn_seq', 'call_id_hash',
                     'caller_args_sha256', 'caller_args_codec', 'caller_semantic_sha256', 'received_semantic_sha256', 'args_semantic_codec'})
MAX_EVENTS = 4096
MAX_EVENT_BYTES = 8192
MAX_BLOB_BYTES = 8 * 1024 * 1024
MAX_TRACE_BYTES = 32 * 1024 * 1024
MAX_TRACES = 256
_worker_incarnation = uuid.uuid4().hex
_current = ContextVar('ruyi_execution_operation', default=None)
_batch_step = ContextVar('ruyi_execution_batch_step', default=None)


class ExecutionJournalError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _token(value):
    if not isinstance(value, str) or not _TOKEN.fullmatch(value):
        raise ExecutionJournalError('execution_journal_identity', 'Invalid execution evidence identity')
    return value


def _encoded(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                          separators=(',', ':')).encode('utf-8')
    except (ValueError, TypeError, UnicodeError):
        raise ExecutionJournalError('execution_journal_shape', 'Execution evidence must be finite UTF-8 JSON') from None


def _strict_json(data):
    def reject(_):
        raise ValueError('non-finite execution evidence JSON')
    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            reject(value)
        return number
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate execution evidence JSON field')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique, parse_constant=reject, parse_float=finite)


def _regular(fd):
    value = os.fstat(fd)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != os.geteuid():
        raise ExecutionJournalError('execution_journal_path', 'Execution evidence is not an owned regular file')
    return value


def _write_all(fd, data):
    offset = 0
    while offset < len(data):
        try:
            count = os.write(fd, data[offset:])
        except InterruptedError:
            continue
        if count <= 0:
            raise OSError('Short execution evidence write')
        offset += count


@contextmanager
def _file_lock(fd, exclusive):
    deadline = time.monotonic() + 1.
    operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    while True:
        try:
            fcntl.flock(fd, operation | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise ExecutionJournalError('execution_journal_busy', 'Execution evidence is busy')
            time.sleep(.01)
    try:
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)


def _read_marker(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
    try:
        size = _regular(fd).st_size
        if size > 512:
            raise ValueError('oversized commit marker')
        data = bytearray()
        while len(data) < size:
            part = os.read(fd, size - len(data))
            if not part:
                break
            data.extend(part)
        value = _strict_json(data)
        if not isinstance(value, dict) or set(value) != {'schema', 'sequence', 'bytes', 'sha256'} \
                or type(value.get('schema')) is not int or value['schema'] != 1 \
                or type(value.get('sequence')) is not int or not 0 <= value['sequence'] <= MAX_EVENTS \
                or type(value.get('bytes')) is not int or not 0 <= value['bytes'] <= MAX_TRACE_BYTES \
                or not isinstance(value.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', value['sha256']):
            raise ValueError('invalid commit marker')
        return value
    finally:
        os.close(fd)


def _base_directory():
    # The current handshake implementation is native Mac/POSIX. Decline unavailable safe
    # descriptor operations rather than silently substituting an unchecked path traversal.
    if fcntl is None or not hasattr(os, 'O_NOFOLLOW') or os.open not in os.supports_dir_fd:
        raise ExecutionJournalError('execution_journal_unsupported', 'Safe execution evidence storage is unavailable')
    base = Path(logs_dir()) / 'execution-receipts'
    base.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    value = os.fstat(fd)
    if value.st_uid != os.geteuid():
        os.close(fd)
        raise ExecutionJournalError('execution_journal_path', 'Execution evidence directory is not owned')
    return base, fd


class ReceiptJournal:
    """One exclusive invocation directory; serialized complete writes and strict fsync."""
    def __init__(self, invocation_id):
        self.invocation_id = _token(invocation_id)
        self.sequence = 0
        self.bytes = 0
        self.failed = False
        self.closed = False
        self._lock = threading.RLock()
        self._digest = hashlib.sha256()
        self.committed_bytes = 0
        self.parent_fd = self.directory_fd = self.fd = None
        allocation = None
        try:
            self.base, self.parent_fd = _base_directory()
            # Directory creation is exclusive: a caller cannot reuse another call's receipts.
            # A later retention owner may remove explicitly acknowledged terminal traces;
            # this primitive never removes evidence or guesses that an unresolved call is safe.
            allocation = os.open('.allocation.lock', os.O_WRONLY | os.O_NONBLOCK | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=self.parent_fd)
            _regular(allocation)
            deadline = time.monotonic() + 1.
            while True:
                try:
                    fcntl.flock(allocation, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ExecutionJournalError('execution_journal_busy', 'Execution evidence allocation is busy')
                    time.sleep(.01)
            names = [name for name in os.listdir(self.parent_fd) if _TOKEN.fullmatch(name)]
            if len(names) >= MAX_TRACES:
                raise ExecutionJournalError('execution_journal_capacity', 'Execution evidence capacity is exhausted')
            os.mkdir(self.invocation_id, mode=0o700, dir_fd=self.parent_fd)
            self.directory_fd = os.open(self.invocation_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                        dir_fd=self.parent_fd)
            os.fsync(self.parent_fd)
            self.fd = os.open('events.ndjson', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_NOFOLLOW,
                              0o600, dir_fd=self.directory_fd)
            _regular(self.fd)
            os.fsync(self.fd)
            os.fsync(self.directory_fd)
            self._commit(0, 0, self._digest.hexdigest())
        except Exception as error:
            self.failed = True
            self.close()
            if isinstance(error, ExecutionJournalError):
                raise
            code = 'execution_journal_duplicate' if isinstance(error, FileExistsError) else 'execution_journal_io'
            raise ExecutionJournalError(code, 'Cannot prepare durable execution evidence') from error
        finally:
            if allocation is not None:
                os.close(allocation)

    def _commit(self, sequence, length, digest):
        # Keep the previous committed watermark while publishing. If the final directory
        # fsync fails after rename, readers must still expose only that previous prefix.
        previous = _encoded({'schema': 1, 'sequence': self.sequence, 'bytes': self.committed_bytes,
                             'sha256': self._digest.hexdigest()})
        guard = None
        try:
            guard = os.open('pending.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                            0o600, dir_fd=self.directory_fd)
            _regular(guard)
            _write_all(guard, previous); os.fsync(guard); os.fsync(self.directory_fd)
        finally:
            if guard is not None:
                os.close(guard)
        marker = _encoded({'schema': 1, 'sequence': sequence, 'bytes': length, 'sha256': digest})
        temporary = '.commit-' + uuid.uuid4().hex
        fd = None
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.directory_fd)
            _regular(fd)
            _write_all(fd, marker)
            os.fsync(fd)
            os.close(fd); fd = None
            os.replace(temporary, 'commit.json', src_dir_fd=self.directory_fd, dst_dir_fd=self.directory_fd)
            os.fsync(self.directory_fd)
            # Publication is this final successful unlink. No fallible durability syscall
            # follows it. Process death preserves the visible namespace; after power loss,
            # a reappearing guard only makes recovery conservative (power loss is not this gate).
            os.unlink('pending.json', dir_fd=self.directory_fd)
        finally:
            if fd is not None:
                os.close(fd)

    def _reserve(self, size):
        if self.failed or self.closed:
            raise ExecutionJournalError('execution_journal_unavailable', 'Execution evidence is no longer writable')
        if self.bytes + size > MAX_TRACE_BYTES:
            raise ExecutionJournalError('execution_journal_capacity', 'Execution evidence trace exceeds its capacity')

    def snapshot(self, operation_id, value, *, raw=False):
        """Persist exact actual arguments/payload, returning only a safe content reference."""
        operation_id = _token(operation_id)
        if raw and not isinstance(value, bytes):
            raise ExecutionJournalError('execution_journal_shape', 'Native evidence requires exact request bytes')
        data = value if raw else _encoded(value)
        if len(data) > MAX_BLOB_BYTES:
            raise ExecutionJournalError('execution_journal_capacity', 'Execution arguments exceed evidence capacity')
        name = 'args-' + operation_id + '.json'
        with self._lock:
            self._reserve(len(data))
            fd = None
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.directory_fd)
                _regular(fd)
                _write_all(fd, data)
                os.fsync(fd)
                os.fsync(self.directory_fd)
                self.bytes += len(data)
            except Exception as error:
                self.failed = True
                raise ExecutionJournalError('execution_journal_io', 'Cannot persist actual execution arguments') from error
            finally:
                if fd is not None:
                    os.close(fd)
        return {'args_ref': name, 'args_sha256': hashlib.sha256(data).hexdigest(), 'args_bytes': len(data),
                'args_codec': 'exact-native-frame' if raw else 'python-json-sorted-utf8-v1'}

    def append(self, stage, operation_id, **fields):
        operation_id = _token(operation_id)
        if stage not in _STAGES or set(fields) - _FIELDS:
            raise ExecutionJournalError('execution_journal_shape', 'Unknown execution evidence fields')
        if fields.get('parent_operation_id') is not None:
            _token(fields['parent_operation_id'])
        with self._lock:
            self._reserve(0)
            with _file_lock(self.fd, True):
                if self.sequence >= MAX_EVENTS:
                    raise ExecutionJournalError('execution_journal_capacity', 'Execution evidence event capacity is exhausted')
                value = {'schema': 1, 'invocation_id': self.invocation_id, 'operation_id': operation_id,
                         'sequence': self.sequence + 1, 'stage': stage, 'acc_worker_id': _worker_incarnation,
                         'acc_pid': os.getpid(), 'at': datetime.now(timezone.utc).isoformat(), **fields}
                line = _encoded(value) + b'\n'
                if len(line) > MAX_EVENT_BYTES:
                    raise ExecutionJournalError('execution_journal_capacity', 'Execution evidence event exceeds capacity')
                self._reserve(len(line))
                try:
                    _write_all(self.fd, line)
                    os.fsync(self.fd)
                    digest = self._digest.copy(); digest.update(line)
                    self._commit(self.sequence + 1, self.committed_bytes + len(line), digest.hexdigest())
                    self._digest = digest
                    self.committed_bytes += len(line)
                    self.bytes += len(line)
                    self.sequence += 1
                except Exception as error:
                    self.failed = True
                    raise ExecutionJournalError('execution_journal_io', 'Cannot persist execution evidence') from error
                return value

    def close(self):
        with self._lock:
            self.closed = True
            for key in ('fd', 'directory_fd', 'parent_fd'):
                fd = getattr(self, key, None)
                setattr(self, key, None)
                if fd is not None:
                    os.close(fd)


def read_receipts(invocation_id):
    """A coherent committed prefix. Uncommitted/failed records never invent a terminal."""
    invocation_id = _token(invocation_id)
    parent = directory = fd = None
    try:
        _, parent = _base_directory()
        directory = os.open(invocation_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        fd = os.open('events.ndjson', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        _regular(fd)  # NONBLOCK prevents a FIFO from hanging before this check.
        with _file_lock(fd, False):
            pending = False
            try:
                marker = _read_marker(directory, 'pending.json')
                pending = True
            except FileNotFoundError:
                marker = _read_marker(directory, 'commit.json')
            # Marker selection precedes size and is protected by the same file lock as
            # append. A normal concurrent commit cannot resemble corruption.
            value = _regular(fd)
            if value.st_size > MAX_TRACE_BYTES or marker['bytes'] > value.st_size:
                raise ValueError('invalid committed byte extent')
            chunks = []
            left = marker['bytes']
            while left:
                chunk = os.read(fd, min(left, 65536))
                if not chunk:
                    break
                chunks.append(chunk); left -= len(chunk)
            data = b''.join(chunks)
            if left or hashlib.sha256(data).hexdigest() != marker['sha256']:
                raise ValueError('committed prefix digest mismatch')
            rows, incomplete = [], pending or value.st_size != marker['bytes']
            lines = data.split(b'\n')
            if lines[-1]:
                incomplete = True
            for line in lines[:-1]:
                if len(rows) >= MAX_EVENTS or len(line) + 1 > MAX_EVENT_BYTES:
                    incomplete = True; break
                try:
                    row = _strict_json(line)
                    if not isinstance(row, dict) or type(row.get('schema')) is not int or row['schema'] != 1 \
                            or row.get('invocation_id') != invocation_id or type(row.get('sequence')) is not int \
                            or row['sequence'] != len(rows) + 1 or row.get('stage') not in _STAGES \
                            or not _TOKEN.fullmatch(row.get('operation_id', '')):
                        raise ValueError('invalid evidence sequence')
                except (ValueError, TypeError, UnicodeError):
                    incomplete = True; break
                rows.append(row)
            if len(rows) != marker['sequence']:
                incomplete = True
            return {'schema': 1, 'invocation_id': invocation_id, 'records': rows, 'incomplete': incomplete,
                    'request_terminal_observed': any(row['stage'] == 'acc_request_terminal' for row in rows)}
    except FileNotFoundError:
        return {'schema': 1, 'invocation_id': invocation_id, 'records': [], 'incomplete': True,
                'request_terminal_observed': False}
    except ExecutionJournalError:
        raise
    except (OSError, ValueError, TypeError, UnicodeError) as error:
        raise ExecutionJournalError('execution_journal_io', 'Cannot read execution evidence') from error
    finally:
        for handle in (fd, directory, parent):
            if handle is not None:
                os.close(handle)


@contextmanager
def operation_scope(journal, operation_id, parent_operation_id=None):
    operation_id = _token(operation_id)
    token = _current.set({'journal': journal, 'operation_id': operation_id,
                          'parent_operation_id': parent_operation_id, 'batch_step': _batch_step.get()})
    try:
        yield _current.get()
    finally:
        _current.reset(token)


@contextmanager
def batch_step(index):
    if type(index) is not int or not 0 <= index < 200:
        raise ExecutionJournalError('execution_journal_identity', 'Invalid execution step')
    token = _batch_step.set(index)
    try:
        yield
    finally:
        _batch_step.reset(token)


def current_operation():
    return _current.get()


def current_batch_step():
    return _batch_step.get()
