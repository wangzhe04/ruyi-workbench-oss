"""Execution correlation from reserved MCP metadata through actual Python tool entries.

Metadata is correlation, not authorization. It supplies no paths. Model arguments cannot enable
this transport context. The host must separately persist its actual dispatch preparation.
"""
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
import functools
import os
import re
import uuid

from ai_computer_control.utils.execution_journal import ReceiptJournal, ExecutionJournalError, current_operation, operation_scope, current_batch_step
from ai_computer_control.utils.errors import ToolCancelled
from ai_computer_control.utils.execution_arguments import arguments_digest
from ai_computer_control.utils.macos import DesktopError

META_KEY = 'org.ruyi.workbench/execution-v1'
_FIELDS = frozenset({'schema', 'invocation_id', 'session_id', 'turn_seq', 'call_id_hash', 'args_sha256', 'args_codec',
                     'args_semantic_sha256', 'args_semantic_codec', 'tool_name'})
_request = ContextVar('ruyi_execution_request', default=None)


# Enabled explicitly only for the host-owned receipt path. Legacy standalone ACC remains unchanged.
_SAFE_CONTEXTLESS_TOOLS = frozenset({'execution_receipt'})


def execution_context_required():
    return os.environ.get('RUYI_EXECUTION_CONTEXT_REQUIRED') == '1'


def require_execution_context(tool=None):
    if execution_context_required() and tool not in _SAFE_CONTEXTLESS_TOOLS and current_operation() is None:
        raise DesktopError('execution_metadata_required', 'Host execution correlation is required before tool execution',
                           {'action_sent': False, 'outcome': 'not_dispatched'})


def parse_metadata(meta):
    if meta is None:
        return None
    if hasattr(meta, 'model_dump'):
        meta = meta.model_dump(by_alias=True)
    if not isinstance(meta, dict) or META_KEY not in meta:
        return None
    value = meta[META_KEY]
    if not isinstance(value, dict) or set(value) != _FIELDS \
            or type(value.get('schema')) is not int or value['schema'] != 1 \
            or not isinstance(value.get('invocation_id'), str) or not re.fullmatch(r'[0-9a-f]{32}', value['invocation_id']) \
            or not isinstance(value.get('session_id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['session_id']) \
            or type(value.get('turn_seq')) is not int or not 1 <= value['turn_seq'] <= 9007199254740991 \
            or any(not isinstance(value.get(key), str) or not re.fullmatch(r'[0-9a-f]{64}', value[key]) for key in ('call_id_hash', 'args_sha256', 'args_semantic_sha256')) \
            or value.get('args_codec') != 'javascript-json-utf8-v1' or value.get('args_semantic_codec') != 'ruyi-sdk-json-v1' \
            or not isinstance(value.get('tool_name'), str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,99}', value['tool_name']):
        raise DesktopError('execution_metadata_invalid', 'Invalid host execution correlation metadata',
                           {'action_sent': False, 'outcome': 'not_dispatched'})
    return dict(value)


def _flags(result):
    out = {}
    if not isinstance(result, dict):
        return out
    for key in ('ok', 'action_sent', 'acted', 'cancelled'):
        if type(result.get(key)) is bool:
            out[key] = result[key]
    if 'confirmed' in result and (result['confirmed'] is None or type(result['confirmed']) is bool):
        out['confirmed'] = result['confirmed']
    if result.get('outcome') in ('unknown', 'unconfirmed', 'not_dispatched', 'rolled_back'):
        out['outcome'] = result['outcome']
    if isinstance(result.get('code'), str):
        out['code'] = result['code'][:100]
    return out


def _journal_failure(error, *, entered):
    return DesktopError('execution_receipt_failed', 'Cannot preserve execution evidence',
                        {'outcome': 'unknown' if entered else 'not_dispatched',
                         **({} if entered else {'action_sent': False})})


class RequestExecution:
    def __init__(self, metadata, tool, arguments):
        try:
            received = arguments_digest(arguments)
        except (ValueError, TypeError, OverflowError, RecursionError):
            raise DesktopError('execution_arguments_invalid', 'Cannot fingerprint actual received arguments',
                               {'action_sent': False, 'outcome': 'not_dispatched'}) from None
        if metadata['tool_name'] != tool or received != metadata['args_semantic_sha256']:
            raise DesktopError('execution_arguments_mismatch', 'Actual tool or arguments differ from host execution preparation',
                               {'action_sent': False, 'outcome': 'not_dispatched'})
        self.journal = ReceiptJournal(metadata['invocation_id'])
        self.operation_id = uuid.uuid4().hex
        self.entered = False
        self.finished = False
        try:
            reference = self.journal.snapshot(self.operation_id, arguments)
            self.journal.append('acc_request_accepted', self.operation_id, tool=tool,
                session_id=metadata['session_id'], turn_seq=metadata['turn_seq'], call_id_hash=metadata['call_id_hash'],
                caller_args_sha256=metadata['args_sha256'], caller_args_codec=metadata['args_codec'],
                caller_semantic_sha256=metadata['args_semantic_sha256'], received_semantic_sha256=received,
                args_semantic_codec=metadata['args_semantic_codec'], **reference)
        except BaseException:
            self.journal.close()
            raise

    def finish(self, *, returned):
        if self.finished:
            raise ExecutionJournalError('execution_journal_shape', 'Duplicate request terminal')
        # This describes the SDK request lifecycle, not the tool's success or native effect.
        self.journal.append('acc_request_terminal', self.operation_id, ok=returned,
                            **({} if returned else {'outcome': 'unknown' if self.entered else 'not_dispatched'}))
        self.finished = True


@contextmanager
def request_scope(meta, tool, arguments):
    value = parse_metadata(meta)
    if value is None:
        require_execution_context(tool)
        yield None
        return
    if current_operation() is not None:
        raise DesktopError('execution_metadata_invalid', 'Nested MCP execution contexts are not permitted',
                           {'outcome': 'unknown'})
    execution = None
    token = None
    try:
        execution = RequestExecution(value, tool, arguments)
        token = _request.set(execution)
        with operation_scope(execution.journal, execution.operation_id):
            yield execution
    except ExecutionJournalError as error:
        raise _journal_failure(error, entered=bool(execution and execution.entered)) from error
    finally:
        if token is not None:
            _request.reset(token)
        if execution is not None:
            execution.journal.close()


@contextmanager
def tool_scope(tool, signature, args, kwargs):
    parent = current_operation()
    if parent is None:
        require_execution_context(tool)
        yield None
        return
    journal = parent['journal']
    operation_id = uuid.uuid4().hex
    entered = False
    try:
        if signature is None:
            raise DesktopError('execution_receipts_unavailable', 'Tool signature cannot be bound', {'action_sent': False, 'outcome': 'not_dispatched'})
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        reference = journal.snapshot(operation_id, dict(bound.arguments))
        fields = {'parent_operation_id': parent['operation_id'], 'tool': tool, **reference}
        step = current_batch_step()
        if step is not None:
            fields['batch_step'] = step
        journal.append('tool_entered', operation_id, **fields)
        entered = True
        request = _request.get()
        if request:
            request.entered = True
        with operation_scope(journal, operation_id, parent['operation_id']):
            yield (journal, operation_id)
    except ExecutionJournalError as error:
        raise _journal_failure(error, entered=entered) from error


def wrap_tool(fn, tool, signature, failure):
    """Wrap the existing normalized/audited function without changing legacy signatures."""
    def finish(execution, result):
        if execution is not None:
            journal, operation_id = execution
            try:
                journal.append('tool_terminal', operation_id, tool=tool, **_flags(result))
            except ExecutionJournalError as error:
                raise _journal_failure(error, entered=True) from error

    if asyncio.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            try:
                with tool_scope(tool, signature, args, kwargs) as execution:
                    try:
                        result = await fn(*args, **kwargs)
                    except asyncio.CancelledError as error:
                        result = error.result if isinstance(error, ToolCancelled) and error.tool_name == tool else {
                            'ok': False, 'cancelled': True, 'outcome': 'unknown'}
                        try:
                            finish(execution, result)
                        except DesktopError:
                            pass  # cancellation stays cancellation; absent receipt remains unknown
                        raise
                    finish(execution, result)
                    return result
            except DesktopError as error:
                return failure(error, tool)
        return async_wrapper
    @functools.wraps(fn)
    def sync_wrapper(*args, **kwargs):
        try:
            with tool_scope(tool, signature, args, kwargs) as execution:
                result = fn(*args, **kwargs)
                finish(execution, result)
                return result
        except DesktopError as error:
            return failure(error, tool)
    return sync_wrapper


def metadata_transport_supported(server):
    """Feature-detect the installed SDK; no assumption about all mcp>=1,<2 releases."""
    try:
        from mcp.types import RequestParams
        context = server.get_context().request_context
        if not hasattr(context, 'meta'):
            return False
        marker = {'schema': 1, 'probe': 'transport-shape-only'}
        value = RequestParams.Meta(**{META_KEY: marker})
        return value.model_dump(by_alias=True).get(META_KEY) == marker
    except (AttributeError, ValueError, LookupError, TypeError):
        return False


def metadata_transport_probe(server, probe_values):
    """Echo only a reserved transport nonce with the actual SDK-decoded probe fingerprint.

    The caller uses a safe read; this does not create a journal or prove native readiness.
    A dropped extension, old SDK, invalid marker or altered decoded probe fails closed.
    """
    try:
        meta = server.get_context().request_context.meta
        if hasattr(meta, 'model_dump'):
            meta = meta.model_dump(by_alias=True)
        marker = meta.get('org.ruyi.workbench/execution-probe-v1') if isinstance(meta, dict) else None
        if not isinstance(marker, dict) or set(marker) != {'schema', 'nonce'} \
                or type(marker.get('schema')) is not int or marker['schema'] != 1 \
                or not isinstance(marker.get('nonce'), str) or not re.fullmatch(r'[0-9a-f]{32}', marker['nonce']):
            return None
        from ai_computer_control.utils.execution_journal import _worker_incarnation
        import os
        return {'schema': 1, 'nonce': marker['nonce'], 'args_semantic_codec': 'ruyi-sdk-json-v1',
                'received_semantic_sha256': arguments_digest(probe_values),
                'acc_worker_id': _worker_incarnation, 'acc_pid': os.getpid(),
                'context_required': execution_context_required()}
    except (AttributeError, ValueError, LookupError, TypeError, OverflowError, RecursionError):
        return None
