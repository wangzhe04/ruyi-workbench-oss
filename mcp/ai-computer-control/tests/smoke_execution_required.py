"""Required-context refusal qualification without native processes or desktop effects."""
import contextvars
import asyncio
import inspect
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from ai_computer_control.utils import execution_context as context
from ai_computer_control.utils.execution_journal import operation_scope
from ai_computer_control.utils.execution_arguments import arguments_digest
from ai_computer_control.utils import macos, macos_session


class ExecutionRequired(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'RUYI_EXECUTION_CONTEXT_REQUIRED': '1'}); self.env.start()
        self.addCleanup(self.env.stop)

    def assert_refusal(self, runner):
        with self.assertRaises(macos.DesktopError) as caught: runner()
        self.assertEqual(caught.exception.code, 'execution_metadata_required')
        self.assertEqual(caught.exception.details, {'action_sent': False, 'outcome': 'not_dispatched'})

    def test_transport_missing_or_unrelated_metadata_refuses_before_request_journal(self):
        for meta in (None, {}, {'progressToken': 'host'}, {'arguments': {context.META_KEY: {}}}):
            with self.subTest(meta=meta), patch.object(context, 'ReceiptJournal') as journal:
                def run():
                    with context.request_scope(meta, 'wait', {'seconds': 0}): self.fail('entered body')
                self.assert_refusal(run); journal.assert_not_called()

    def test_unregistered_read_like_names_do_not_implicitly_bypass_requirement(self):
        for name in ('wait', 'get_mouse_position', 'diagnostics', 'audit_tail', 'macro_run', 'not_registered'):
            with self.subTest(name=name): self.assert_refusal(lambda: context.require_execution_context(name))

    def test_only_explicit_receipt_control_read_can_execute_without_trace_context(self):
        with patch.object(context, 'ReceiptJournal') as journal:
            with context.request_scope(None, 'execution_receipt', {'invocation_id': 'a'*32}) as active:
                self.assertIsNone(active)
            with context.tool_scope('execution_receipt', None, (), {}) as active:
                self.assertIsNone(active)
            journal.assert_not_called()

    def test_registered_body_wrapper_refuses_lost_context_before_running_function(self):
        calls = []
        def body(seconds=0): calls.append(seconds); return {'ok': True}
        def failure(error, tool): return {'ok': False, 'code': error.code, **error.details}
        wrapper=context.wrap_tool(body, 'wait', inspect.signature(body), failure)
        self.assertEqual(wrapper(seconds=0)['code'], 'execution_metadata_required')
        self.assertFalse(calls)

    def test_session_and_one_shot_routes_refuse_before_helper_resolution_or_native_spawn(self):
        with patch.object(macos_session, '_session') as session, patch.object(macos, 'helper_path') as helper:
            self.assert_refusal(lambda: macos_session.request({'op': 'mouse.position'}))
            for payload in ({'op': 'capture'}, {'op': 'status', 'extra': True}, {'op': 'keyboard.chord'}):
                self.assert_refusal(lambda: macos.request(payload))
            session.assert_not_called(); helper.assert_not_called()

    def test_exact_internal_status_is_the_only_native_contextless_probe(self):
        class ReachedProbe(Exception): pass
        with patch.object(macos, 'helper_path', side_effect=ReachedProbe):
            with self.assertRaises(ReachedProbe): macos.request({'op': 'status'})

    def test_actual_context_delegates_to_receipt_adapter_and_never_legacy_session(self):
        from ai_computer_control.utils import macos_receipt_session
        with operation_scope(object(), 'a'*32), patch.object(macos_receipt_session, 'request', return_value={'ok': True}) as receipt, \
                patch.object(macos_session, '_session') as legacy:
            self.assertEqual(macos_session.request({'op': 'mouse.position'}), {'ok': True})
            receipt.assert_called_once(); legacy.assert_not_called()

    def test_one_shot_active_context_preserves_payload_and_deadline_on_negotiated_route(self):
        from ai_computer_control.utils import macos_receipt_session
        for payload, timeout in [({'op': 'status'}, 3), ({'op': 'capture', 'region': [0, 0, 30, 30]}, 15),
                                 ({'op': 'ocr.image', 'path': 'owned.png', 'lang': ''}, 65)]:
            with operation_scope(object(), 'a'*32), patch.object(macos_receipt_session, 'request', return_value={'ok': True}) as receipt, \
                    patch.object(macos, 'helper_path') as legacy:
                self.assertEqual(macos.request(payload, timeout=timeout), {'ok': True})
                receipt.assert_called_once_with(payload, timeout, generic=True)
                legacy.assert_not_called()

    def metadata(self):
        return {context.META_KEY: {'schema': 1, 'invocation_id': 'b'*32, 'session_id': 'owned', 'turn_seq': 1,
            'call_id_hash': 'c'*64, 'args_sha256': 'd'*64, 'args_codec': 'javascript-json-utf8-v1',
            'args_semantic_sha256': arguments_digest({}), 'args_semantic_codec': 'ruyi-sdk-json-v1', 'tool_name': 'owned'}}

    def test_copied_thread_context_observes_real_sdk_request_closure(self):
        with patch.object(context, 'ReceiptJournal'):
            with context.request_scope(self.metadata(), 'owned', {}):
                event, lock = context.request_cancellation()
                copied = contextvars.copy_context()
                self.assertFalse(event.is_set())
            self.assertTrue(event.is_set())
            self.assertIs(copied.run(context.request_cancellation)[0], event)
            self.assertIs(copied.run(context.request_cancellation)[1], lock)
            self.assertEqual(context.request_cancellation(), (None, None))

    def test_async_cancellation_signals_before_tool_terminal_persistence(self):
        async def scenario():
            started = asyncio.Event()
            async def body():
                started.set()
                await asyncio.Future()
            with patch.object(context, 'ReceiptJournal') as factory:
                with context.request_scope(self.metadata(), 'owned', {}):
                    event, _ = context.request_cancellation()
                    signals = []
                    factory.return_value.append.side_effect = lambda stage, *args, **kwargs: signals.append(event.is_set()) if stage == 'tool_terminal' else None
                    wrapped = context.wrap_tool(body, 'owned', inspect.signature(body), lambda error, tool: self.fail(str(error)))
                    task = asyncio.create_task(wrapped())
                    await started.wait(); task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task
                    self.assertEqual(signals, [True])
                    self.assertTrue(event.is_set())
        asyncio.run(scenario())

    def test_raw_thread_context_loss_refuses_but_copied_context_preserves_admission(self):
        outputs = []
        def run():
            try: context.require_execution_context(); outputs.append('admitted')
            except macos.DesktopError as error: outputs.append(error.code)
        with operation_scope(object(), 'a'*32):
            lost=threading.Thread(target=run); lost.start(); lost.join()
            copied=contextvars.copy_context()
            kept=threading.Thread(target=copied.run,args=(run,)); kept.start(); kept.join()
        self.assertEqual(outputs, ['execution_metadata_required', 'admitted'])

    def test_legacy_default_remains_untraced_and_probe_reports_actual_requirement(self):
        server=SimpleNamespace(get_context=lambda:SimpleNamespace(request_context=SimpleNamespace(meta={
            'org.ruyi.workbench/execution-probe-v1': {'schema':1,'nonce':'a'*32}})))
        self.assertTrue(context.metadata_transport_probe(server,{})['context_required'])
        with patch.dict(os.environ, {'RUYI_EXECUTION_CONTEXT_REQUIRED': '0'}):
            context.require_execution_context('wait')
            with context.request_scope(None, 'wait', {}) as active: self.assertIsNone(active)
            self.assertFalse(context.metadata_transport_probe(server,{})['context_required'])


if __name__ == '__main__': unittest.main()
