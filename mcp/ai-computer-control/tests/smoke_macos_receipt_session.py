"""Opt-in real product adapter + strict journal, read-only native queries and injected I/O faults.

Context is supplied by the fixture: this is not ACC metadata/wrapper or Node recovery acceptance.
No event posting, clipboard/window changes, held-state fault, TCC changes, or App launch.
"""
from contextvars import Context, copy_context
import asyncio
import inspect
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from ai_computer_control.utils import execution_journal as journal
from ai_computer_control.utils import macos_session as native
from ai_computer_control.utils import macos_receipt_session as adapter
from ai_computer_control.utils import macos
from ai_computer_control.utils import execution_context
from ai_computer_control.utils.execution_arguments import arguments_digest
from ai_computer_control.utils.macos import DesktopError


@unittest.skipUnless(sys.platform == 'darwin' and os.environ.get('RUYI_RECEIPT_SESSION_REQUIRED') == '1', 'opt-in read-only product receipt adapter')
class NativeReceiptAdapter(unittest.TestCase):
    def setUp(self):
        native.close_input_session()
        self.directory = tempfile.TemporaryDirectory(prefix='ruyi-receipt-adapter-')
        self.root = Path(self.directory.name)
        self.helper = os.environ['RUYI_RECEIPT_SESSION_HELPER']
        self.env = patch.dict(os.environ, {'HOME': str(self.root/'h'), 'USERPROFILE': str(self.root/'h'),
            'APPDATA': str(self.root/'a'), 'LOCALAPPDATA': str(self.root/'l'), 'WCW_DATA_DIR': str(self.root/'data'),
            'RUYI_MACOS_AUTOMATION_HELPER': self.helper})
        self.env.start()
        self.trace = journal.ReceiptJournal(uuid.uuid4().hex)
        self.operation = uuid.uuid4().hex
        self.trace.append('tool_entered', self.operation, tool='get_mouse_position')
        self.scope = journal.operation_scope(self.trace, self.operation)
        self.scope.__enter__()

    def tearDown(self):
        native.close_input_session()
        self.scope.__exit__(None, None, None)
        self.trace.close(); self.env.stop(); self.directory.cleanup()

    def rows(self):
        return journal.read_receipts(self.trace.invocation_id)['records']

    def stages(self):
        return [row['stage'] for row in self.rows()]

    def until(self, read):
        deadline = time.monotonic() + 2.
        while time.monotonic() < deadline:
            value = read()
            if value: return value
            time.sleep(.01)
        self.fail('Owned helper observation exceeded deadline')

    def test_real_request_uses_journal_barrier_and_exact_native_frame(self):
        result = native.request({'op': 'mouse.position'})
        self.assertTrue(result['ok']); self.assertNotIn('receipt', result)
        rows = self.rows()
        stages = [row['stage'] for row in rows]
        for name in ['native_features', 'native_prepared', 'native_frame_sent', 'native_entered', 'native_continue_intent', 'native_continue_sent', 'native_terminal']:
            self.assertIn(name, stages)
        self.assertLess(stages.index('native_entered'), stages.index('native_continue_intent'))
        self.assertLess(stages.index('native_continue_intent'), stages.index('native_continue_sent'))
        prepared = next(row for row in rows if row['stage'] == 'native_prepared')
        entered = next(row for row in rows if row['stage'] == 'native_entered')
        self.assertEqual(prepared['frame_sha256'], entered['frame_sha256'])
        self.assertEqual(prepared['operation_id'], entered['operation_id'])
        self.assertEqual(prepared['parent_operation_id'], self.operation)
        file = self.root/'data/logs/execution-receipts'/self.trace.invocation_id/prepared['args_ref']
        payload = json.loads(file.read_bytes())
        self.assertEqual(payload['_ruyi_receipt']['invocation_id'], self.trace.invocation_id)
        self.assertEqual(payload['_ruyi_receipt']['operation_id'], prepared['operation_id'])

    def test_multiple_frames_and_worker_restart_have_distinct_identity(self):
        native.request({'op': 'mouse.position'}); native.request({'op': 'mouse.position'})
        first = [row for row in self.rows() if row['stage'] == 'native_entered']
        self.assertEqual(first[0]['worker_id'], first[1]['worker_id'])
        self.assertNotEqual(first[0]['frame_id'], first[1]['frame_id'])
        native.close_input_session()
        native.request({'op': 'mouse.position'})
        last = [row for row in self.rows() if row['stage'] == 'native_entered'][-1]
        self.assertNotEqual(first[0]['worker_id'], last['worker_id'])
        self.assertEqual(len({row['operation_id'] for row in self.rows() if row['stage'] == 'native_entered'}), 3)

    def test_negotiated_generic_status_and_async_languages_share_owned_worker(self):
        native.request({'op': 'mouse.position'})
        status = macos.request({'op': 'status'}, timeout=3)
        languages = macos.request({'op': 'ocr.languages'})
        self.assertTrue(status['ok']); self.assertTrue(languages['ok'])
        self.assertEqual(status['coordinate_space'], 'macos_global_points')
        self.assertTrue(languages['languages'])
        entered = [row for row in self.rows() if row['stage'] == 'native_entered']
        self.assertEqual([row['op'] for row in entered], ['mouse.position', 'status', 'ocr.languages'])
        self.assertEqual(len({row['worker_id'] for row in entered}), 1)
        self.assertEqual(sum(row['stage'] == 'native_terminal' for row in self.rows()), 3)

    def test_old_input_only_receipt_worker_cannot_dispatch_generic_or_fallback(self):
        old = os.environ['RUYI_RECEIPT_LEGACY_HELPER']
        self.assertNotEqual(Path(old).resolve(), Path(self.helper).resolve())
        with patch.dict(os.environ, {'RUYI_MACOS_AUTOMATION_HELPER': old}):
            with self.assertRaises(DesktopError) as caught:
                macos.request({'op': 'status'}, timeout=3)
        self.assertEqual(caught.exception.code, 'execution_receipts_unsupported')
        self.assertEqual(caught.exception.details, {'action_sent': False, 'outcome': 'not_dispatched'})
        self.assertIn('native_features', self.stages())
        self.assertNotIn('native_prepared', self.stages())

    def test_generic_entry_commit_failure_never_sends_continue(self):
        original = self.trace.append
        def reject(stage, *args, **kwargs):
            if stage == 'native_entered':
                raise journal.ExecutionJournalError('execution_journal_io', 'generic entry fault')
            return original(stage, *args, **kwargs)
        with patch.object(self.trace, 'append', side_effect=reject):
            with self.assertRaises(DesktopError) as caught: macos.request({'op': 'status'})
        self.assertEqual(caught.exception.code, 'execution_receipt_failed')
        self.assertIsNone(native._SESSION)
        self.assertNotIn('native_continue_sent', self.stages())

    def test_generic_caller_deadline_does_not_extend_after_slow_entry_commit(self):
        native.request({'op': 'mouse.position'})  # prime the same actual owned worker/features
        before = len(self.rows())
        original = self.trace.append
        entered = []
        def slow_entry(stage, *args, **kwargs):
            result = original(stage, *args, **kwargs)
            if stage == 'native_entered':
                entered.append(result)
                time.sleep(.35)
            return result
        start = time.monotonic()
        with patch.object(self.trace, 'append', side_effect=slow_entry):
            with self.assertRaises(DesktopError) as caught:
                macos.request({'op': 'status'}, timeout=.2)
        self.assertEqual(caught.exception.code, 'input_session_timeout')
        self.assertEqual(caught.exception.details['outcome'], 'unknown')
        self.assertEqual(len(entered), 1)
        self.assertLess(time.monotonic() - start, 1.8)
        self.assertIsNone(native._SESSION)
        self.assertFalse(any(row['stage'] == 'native_continue_sent' for row in self.rows()[before:]))

    def test_generic_capture_channel_and_input_queries_share_one_real_busy_worker(self):
        entered, release = threading.Event(), threading.Event()
        results, errors = [], []
        original = self.trace.append
        def gate(stage, *args, **kwargs):
            result = original(stage, *args, **kwargs)
            if stage == 'native_entered' and not entered.is_set():
                entered.set()
                if not release.wait(1.): raise RuntimeError('bounded shared worker release missing')
            return result
        def run():
            try: results.append(macos.request({'op': 'status'}, timeout=3))
            except BaseException as error: errors.append(error)
        copied = copy_context()
        with patch.object(self.trace, 'append', side_effect=gate):
            worker = threading.Thread(target=copied.run, args=(run,)); worker.start()
            try:
                self.assertTrue(entered.wait(1.))
                owned = native._SESSION['child']
                with self.assertRaises(DesktopError) as caught: native.request({'op': 'mouse.position'})
                self.assertEqual(caught.exception.code, 'desktop_busy')
                self.assertIs(native._SESSION['child'], owned)
                self.assertEqual(sum(row['stage'] == 'native_prepared' for row in self.rows()), 1)
            finally:
                release.set(); worker.join(2.)
        self.assertFalse(worker.is_alive()); self.assertFalse(errors); self.assertTrue(results[0]['ok'])
        self.assertTrue(native.request({'op': 'mouse.position'})['ok'])
        self.assertIs(native._SESSION['child'], owned)
        self.assertEqual(sum(row['stage'] == 'native_terminal' for row in self.rows()), 2)

    def test_unknown_generic_operation_refuses_before_worker_creation(self):
        with patch.object(native, '_session') as spawn:
            with self.assertRaises(DesktopError) as caught: macos.request({'op': 'ocr.recognize'})
            spawn.assert_not_called()
        self.assertEqual(caught.exception.code, 'execution_receipts_unsupported')

    def test_delayed_old_cancel_observer_cannot_reuse_or_terminate_successor_worker(self):
        cancel, lock = threading.Event(), threading.Lock()
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        terminated = []
        def delayed_terminate():
            entered.set()
            try:
                if not release.wait(3.): raise RuntimeError('bounded observer test release missing')
                terminated.append('old')
            finally: finished.set()
        old_child = SimpleNamespace(poll=lambda: None, terminate=delayed_terminate)
        new_child = SimpleNamespace(poll=lambda: None, terminate=lambda: terminated.append('new'))
        features = {'worker_id': 'c'*32, 'worker_pid': 123, 'schema': 1, 'request_operations': ('status',)}
        old = {'child': old_child, 'closing': False, 'receipt_features': features}
        new = {'child': new_child, 'closing': False, 'receipt_features': features}
        closed = []
        def close():
            closed.append(native._SESSION)
            native._SESSION['closing'] = True
            native._SESSION = None
        def exchange(session, *args, **kwargs):
            if session is old:
                with lock: cancel.set()
                self.assertTrue(entered.wait(1.))
            return {'ok': True, 'protocolVersion': 1}, 1, b'owned-test-frame'
        native._SESSION = old
        try:
            with patch.object(native, '_session', side_effect=lambda: native._SESSION), \
                    patch.object(native, '_close_input_session', side_effect=close), \
                    patch.object(adapter, '_exchange', side_effect=exchange):
                with self.assertRaises(DesktopError) as caught:
                    adapter.request({'op': 'status'}, cancel_event=cancel, cancel_lock=lock, generic=True)
                self.assertEqual(caught.exception.details['outcome'], 'unknown')
                self.assertIsNone(native._SESSION); self.assertEqual(closed, [old])
                native._SESSION = new
                self.assertTrue(adapter.request({'op': 'status'}, generic=True)['ok'])
                release.set(); self.assertTrue(finished.wait(1.))
                self.assertEqual(terminated, ['old'])
                self.assertIs(native._SESSION, new)
        finally:
            release.set(); finished.wait(1.); native._SESSION = None

    def test_real_request_scope_cancellation_stops_generic_worker_while_thread_is_blocked(self):
        invocation = uuid.uuid4().hex
        meta = {execution_context.META_KEY: {'schema': 1, 'invocation_id': invocation, 'session_id': 'owned', 'turn_seq': 1,
            'call_id_hash': 'c'*64, 'args_sha256': 'd'*64, 'args_codec': 'javascript-json-utf8-v1',
            'args_semantic_sha256': arguments_digest({}), 'args_semantic_codec': 'ruyi-sdk-json-v1', 'tool_name': 'owned'}}
        entered, release, worker_done = threading.Event(), threading.Event(), threading.Event()
        original = journal.ReceiptJournal.append
        def append(trace, stage, *args, **kwargs):
            result = original(trace, stage, *args, **kwargs)
            if trace.invocation_id == invocation and stage == 'native_entered':
                entered.set()
                if not release.wait(3.): raise RuntimeError('bounded generic cancellation release missing')
            return result
        def native_body():
            try: return macos.request({'op': 'status'}, timeout=3)
            finally: worker_done.set()
        async def body(): return await asyncio.to_thread(native_body)
        wrapped = execution_context.wrap_tool(body, 'owned', inspect.signature(body), lambda error, tool: self.fail(str(error)))
        async def actual_request():
            with execution_context.request_scope(meta, 'owned', {}) as request:
                try: result = await wrapped()
                except BaseException:
                    request.finish(returned=False)
                    raise
                request.finish(returned=True)
                return result
        async def wait_for(read):
            deadline = time.monotonic() + 2.
            while time.monotonic() < deadline:
                if read(): return
                await asyncio.sleep(.01)
            self.fail('bounded generic cancellation observation timed out')
        async def scenario():
            task = asyncio.create_task(actual_request())
            try:
                await wait_for(entered.is_set)
                child = native._SESSION['child']
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                await wait_for(lambda: child.poll() is not None)
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                    try: await task
                    except asyncio.CancelledError: pass
            await wait_for(worker_done.is_set)
        with patch.object(journal.ReceiptJournal, 'append', new=append):
            Context().run(asyncio.run, scenario())
        self.assertIsNone(native._SESSION)
        rows = journal.read_receipts(invocation)['records']
        self.assertTrue(any(row['stage'] == 'native_entered' for row in rows))
        self.assertFalse(any(row['stage'] in ('native_continue_sent', 'native_terminal') for row in rows))
        self.assertEqual(rows[-1]['stage'], 'acc_request_terminal')
        self.assertEqual(rows[-1]['outcome'], 'unknown')

    def test_entered_persistence_failure_closes_worker_without_continue(self):
        original = self.trace.append
        def fail(stage, *args, **kwargs):
            if stage == 'native_entered':
                raise journal.ExecutionJournalError('execution_journal_io', 'synthetic entry failure')
            return original(stage, *args, **kwargs)
        with patch.object(self.trace, 'append', side_effect=fail):
            with self.assertRaises(DesktopError) as value: native.request({'op': 'mouse.position'})
        self.assertEqual(value.exception.code, 'execution_receipt_failed')
        self.assertEqual(value.exception.details['outcome'], 'unknown')
        self.assertIsNone(native._SESSION)
        self.assertNotIn('native_continue_sent', self.stages())

    def test_terminal_persistence_failure_does_not_report_success(self):
        original = self.trace.append
        def fail(stage, *args, **kwargs):
            if stage == 'native_terminal': raise journal.ExecutionJournalError('execution_journal_io', 'synthetic terminal failure')
            return original(stage, *args, **kwargs)
        with patch.object(self.trace, 'append', side_effect=fail):
            with self.assertRaises(DesktopError) as value: native.request({'op': 'mouse.position'})
        self.assertEqual(value.exception.details['outcome'], 'unknown')
        self.assertIsNone(native._SESSION)
        self.assertIn('native_continue_sent', self.stages()); self.assertNotIn('native_terminal', self.stages())

    def test_real_journal_fsync_failure_hides_the_uncommitted_entry(self):
        original = self.trace.append
        sync = os.fsync
        def append(stage, *args, **kwargs):
            if stage != 'native_entered': return original(stage, *args, **kwargs)
            def fail(fd):
                if fd == self.trace.fd: raise OSError('synthetic data fsync failure')
                return sync(fd)
            with patch.object(journal.os, 'fsync', side_effect=fail): return original(stage, *args, **kwargs)
        with patch.object(self.trace, 'append', side_effect=append):
            with self.assertRaises(DesktopError): native.request({'op': 'mouse.position'})
        value = journal.read_receipts(self.trace.invocation_id)
        self.assertTrue(value['incomplete'])
        self.assertNotIn('native_entered', [row['stage'] for row in value['records']])
        self.assertNotIn('native_continue_sent', [row['stage'] for row in value['records']])
        self.assertIsNone(native._SESSION)

    def test_cancel_observer_terminates_owned_worker_while_journal_thread_is_blocked(self):
        original = self.trace.append
        blocked, release = threading.Event(), threading.Event()
        cancel, cancel_lock = threading.Event(), threading.Lock()
        errors = []
        def append(stage, *args, **kwargs):
            if stage == 'native_entered':
                blocked.set()
                if not release.wait(2.): raise RuntimeError('test release timeout')
            return original(stage, *args, **kwargs)
        def run():
            try: native.request({'op': 'mouse.position'}, cancel_event=cancel, cancel_lock=cancel_lock)
            except Exception as error: errors.append(error)
        context = copy_context()
        with patch.object(self.trace, 'append', side_effect=append):
            worker = threading.Thread(target=context.run, args=(run,)); worker.start()
            try:
                self.assertTrue(blocked.wait(2.))
                owned = native._SESSION['child']
                with cancel_lock: cancel.set()
                self.until(lambda: owned.poll() is not None)
            finally:
                release.set(); worker.join(3.)
        self.assertFalse(worker.is_alive()); self.assertTrue(errors)
        self.assertIsInstance(errors[0], DesktopError)
        self.assertNotIn('native_continue_sent', self.stages())
        self.assertIsNone(native._SESSION)

    def test_pre_cancel_does_not_spawn_or_send_a_native_frame(self):
        event, lock = threading.Event(), threading.Lock(); event.set()
        with self.assertRaises(DesktopError) as value: native.request({'op': 'mouse.position'}, cancel_event=event, cancel_lock=lock)
        self.assertEqual(value.exception.details['outcome'], 'not_dispatched')
        self.assertIsNone(native._SESSION); self.assertNotIn('native_prepared', self.stages())

    def test_cancel_after_intent_cannot_complete_continue(self):
        event, lock = threading.Event(), threading.Lock()
        original = self.trace.append
        def append(stage, *args, **kwargs):
            result = original(stage, *args, **kwargs)
            if stage == 'native_continue_intent':
                with lock: event.set()
            return result
        with patch.object(self.trace, 'append', side_effect=append):
            with self.assertRaises(DesktopError): native.request({'op': 'mouse.position'}, cancel_event=event, cancel_lock=lock)
        self.assertNotIn('native_continue_sent', self.stages()); self.assertIsNone(native._SESSION)

    def test_changed_helper_identity_refuses_before_continue(self):
        original, identity = self.trace.append, adapter._identity
        changed = []
        def append(stage, *args, **kwargs):
            result = original(stage, *args, **kwargs)
            if stage == 'native_entered': changed.append(True)
            return result
        def replacement(path):
            value = identity(path)
            return (*value[:-1], value[-1]+1) if changed else value
        with patch.object(self.trace, 'append', side_effect=append), patch.object(adapter, '_identity', side_effect=replacement):
            with self.assertRaises(DesktopError) as value: native.request({'op': 'mouse.position'})
        self.assertEqual(value.exception.code, 'dependency_changed')
        self.assertNotIn('native_continue_sent', self.stages()); self.assertIsNone(native._SESSION)

    def test_monitor_start_failure_cleans_owned_worker_and_releases_global_lock(self):
        cancel, lock = threading.Event(), threading.Lock()
        with patch.object(adapter.threading.Thread, 'start', side_effect=RuntimeError('synthetic thread resource failure')):
            with self.assertRaises(DesktopError) as value:
                native.request({'op': 'mouse.position'}, cancel_event=cancel, cancel_lock=lock)
        self.assertEqual(value.exception.details['outcome'], 'unknown')
        self.assertIsNone(native._SESSION)
        self.assertTrue(native._LOCK.acquire(blocking=False)); native._LOCK.release()
        self.assertTrue(native.request({'op': 'mouse.position'})['ok'])

    def test_unexpected_decoder_exception_is_typed_unknown_with_cleanup(self):
        with patch.object(adapter.ReceiptDecoder, 'feed', side_effect=RecursionError('synthetic nested JSON')):
            with self.assertRaises(DesktopError) as value: native.request({'op': 'mouse.position'})
        self.assertEqual(value.exception.details['outcome'], 'unknown')
        self.assertIsNone(native._SESSION)
        self.assertTrue(native._LOCK.acquire(blocking=False)); native._LOCK.release()
        self.assertTrue(native.request({'op': 'mouse.position'})['ok'])

    def test_failed_cleanup_keeps_worker_quarantined_and_does_not_spawn_replacement(self):
        native.request({'op': 'mouse.position'})
        owned = native._SESSION['child']
        with patch.object(owned, 'wait', side_effect=OSError('synthetic wait failure')):
            with self.assertRaises(DesktopError): native.close_input_session()
            self.assertIs(native._SESSION['child'], owned); self.assertTrue(native._SESSION['closing'])
            with patch.object(native.subprocess, 'Popen', side_effect=AssertionError('must not spawn')) as spawn:
                with self.assertRaises(DesktopError) as value: native.request({'op': 'mouse.position'})
                self.assertTrue(value.exception.details['cleanup_unconfirmed'])
                spawn.assert_not_called()
            self.assertTrue(native._LOCK.acquire(blocking=False)); native._LOCK.release()
        native.close_input_session()
        self.assertIsNone(native._SESSION)

    def test_legacy_cancel_cleanup_failure_always_releases_the_shared_lock(self):
        original = native._session
        event, lock = threading.Event(), threading.Lock()
        patches = []
        def setup():
            value = original()
            wait = patch.object(value['child'], 'wait', side_effect=OSError('synthetic legacy cleanup failure'))
            wait.start(); patches.append(wait)
            event.set()
            return value
        try:
            with patch.object(native, '_session', side_effect=setup):
                with self.assertRaises(DesktopError) as error:
                    Context().run(lambda: native.request({'op': 'mouse.position'}, cancel_event=event, cancel_lock=lock))
            self.assertTrue(error.exception.details['cleanup_unconfirmed'])
            self.assertTrue(native._LOCK.acquire(blocking=False)); native._LOCK.release()
            self.assertTrue(native._SESSION['closing'])
        finally:
            for item in patches: item.stop()
            native.close_input_session()
        self.assertIsNone(native._SESSION)
        self.assertNotIn('native_prepared', self.stages())

    def test_descriptor_setup_failure_does_not_lose_the_owned_child(self):
        original = native.subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            child = original(*args, **kwargs); children.append(child); return child
        with patch.object(native.subprocess, 'Popen', side_effect=spawn), patch.object(native.os, 'set_blocking', side_effect=OSError('synthetic descriptor failure')):
            with self.assertRaises(DesktopError): Context().run(lambda: native.request({'op': 'mouse.position'}))
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertIsNone(native._SESSION)
        self.assertTrue(native._LOCK.acquire(blocking=False)); native._LOCK.release()
        self.assertNotIn('native_prepared', self.stages())

    def test_old_helper_is_refused_before_the_receipt_business_request(self):
        legacy = os.environ['RUYI_RECEIPT_SESSION_LEGACY_HELPER']
        with patch.dict(os.environ, {'RUYI_MACOS_AUTOMATION_HELPER': legacy}):
            with self.assertRaises(DesktopError) as value: native.request({'op': 'mouse.position'})
        self.assertEqual(value.exception.code, 'execution_receipts_unsupported')
        self.assertEqual(value.exception.details['outcome'], 'not_dispatched')
        self.assertNotIn('native_prepared', self.stages())
        self.assertEqual(next(row for row in self.rows() if row['stage'] == 'native_features')['receipt_version'], 0)


if __name__ == '__main__':
    unittest.main()
