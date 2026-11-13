"""Audit cancellation without consuming it, including Mac already-dispatched input."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class _AuditFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.TemporaryDirectory(prefix='p5-cancel-audit-')
        cls.environment = patch.dict(os.environ, {'HOME': cls.root.name, 'USERPROFILE': cls.root.name,
            'LOCALAPPDATA': cls.root.name, 'APPDATA': cls.root.name, 'WCW_DATA_DIR': cls.root.name,
            'ACC_TOOLSETS': 'thinking', 'ACC_HIDE_TOOLS': '', 'RUYI_MACOS_AUTOMATION_HELPER': str(Path(cls.root.name) / 'absent')})
        cls.environment.start()
        import ai_computer_control.server as server
        from ai_computer_control.tools import audit
        from ai_computer_control.utils.errors import ToolCancelled
        cls.server, cls.audit, cls.Cancelled = server, audit, ToolCancelled

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.root.cleanup()

    def setUp(self):
        self.data = tempfile.TemporaryDirectory(prefix='case-', dir=self.root.name)
        self.data_environment = patch.dict(os.environ, {'WCW_DATA_DIR': self.data.name})
        self.data_environment.start()
        self.addCleanup(self.data.cleanup)
        self.addCleanup(self.data_environment.stop)

    def records(self):
        return self.audit.audit_tail(100)['records']


class CancellationAudit(_AuditFixture):
    def test_generic_cancel_is_audited_once_with_unknown_effects(self):
        async def run():
            entered = asyncio.Event()
            @self.server.mcp.tool(audit=True)
            async def cancel_audit_generic(password: str) -> dict:
                """Owned cancellation probe."""
                entered.set()
                await asyncio.sleep(30)
                return {'ok': True}
            task = asyncio.create_task(cancel_audit_generic(password='secret-owned-value'))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        asyncio.run(run())
        records = self.records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['tool'], 'cancel_audit_generic')
        self.assertFalse(records[0]['ok'])
        self.assertTrue(records[0]['cancelled'])
        self.assertEqual(records[0]['outcome'], 'unknown')
        self.assertEqual(records[0]['args']['password'], '***')
        self.assertNotIn('action_sent', records[0])
        self.assertIn('cancelled', records[0]['error'])

    def test_non_audited_cancellation_stays_unlogged(self):
        @self.server.mcp.tool()
        async def cancel_audit_readonly() -> dict:
            """Owned readonly cancellation probe."""
            raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(cancel_audit_readonly())
        self.assertEqual(self.records(), [])

    def test_cancellation_cannot_claim_success_in_its_typed_result(self):
        @self.server.mcp.tool(audit=True)
        async def cancel_audit_false_success() -> dict:
            """Owned incorrectly supplied status probe."""
            raise self.Cancelled('cancel_audit_false_success', {'ok': True, 'cancelled': False,
                'error': 'cancelled', 'outcome': 'unknown'})
        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(cancel_audit_false_success())
        self.assertFalse(self.records()[0]['ok'])
        self.assertTrue(self.records()[0]['cancelled'])

    def test_nested_audited_calls_each_record_their_own_cancellation_once(self):
        @self.server.mcp.tool(audit=True)
        async def cancel_audit_inner() -> dict:
            """Owned inner probe."""
            raise self.Cancelled('cancel_audit_inner', {'ok': False, 'cancelled': True, 'action_sent': True,
                'confirmed': None, 'outcome': 'unconfirmed', 'error': 'cancelled'})
        @self.server.mcp.tool(audit=True)
        async def cancel_audit_outer() -> dict:
            """Owned outer probe."""
            return await cancel_audit_inner()
        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(cancel_audit_outer())
        records = self.records()
        self.assertEqual([r['tool'] for r in records], ['cancel_audit_inner', 'cancel_audit_outer'])
        self.assertTrue(all(r['cancelled'] and r['ok'] is False for r in records))
        self.assertTrue(records[0]['action_sent'])
        self.assertNotIn('action_sent', records[1])
        self.assertEqual(records[1]['outcome'], 'unknown')

    def test_outer_cancel_never_reuses_inner_not_dispatched_after_an_earlier_action(self):
        posted = []
        @self.server.mcp.tool(audit=True)
        async def cancel_audit_second_step() -> dict:
            """Owned second-step cancellation probe."""
            raise self.Cancelled('cancel_audit_second_step', {'ok': False, 'cancelled': True,
                'action_sent': False, 'outcome': 'not_dispatched', 'error': 'cancelled'})
        @self.server.mcp.tool(audit=True)
        async def cancel_audit_sequence() -> dict:
            """Owned previously dispatched sequence."""
            posted.append('first step')
            return await cancel_audit_second_step()
        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(cancel_audit_sequence())
        self.assertEqual(posted, ['first step'])
        records = self.records()
        self.assertFalse(records[0]['action_sent'])
        self.assertEqual(records[0]['outcome'], 'not_dispatched')
        self.assertNotIn('action_sent', records[1])
        self.assertEqual(records[1]['outcome'], 'unknown')

    def test_audit_failure_never_replaces_cancellation(self):
        @self.server.mcp.tool(audit=True)
        async def cancel_audit_failed_writer() -> dict:
            """Owned failed-audit probe."""
            raise asyncio.CancelledError()
        with patch.object(self.audit, 'log_action', side_effect=OSError('controlled log failure')) as log:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(cancel_audit_failed_writer())
        self.assertEqual(log.call_count, 1)

    def test_outcome_is_a_small_typed_allowlist_and_never_copies_result_payloads(self):
        self.audit.log_action('owned', {'token': 'secret-owned'}, False, 'cancelled', 1,
            outcome={'cancelled': True, 'action_sent': True, 'confirmed': None, 'outcome': 'unconfirmed',
                     'image': 'private-pixels', 'action_result': {'text': 'private-result'}, 'password': 'private-password'})
        record = self.records()[0]
        self.assertEqual(set(record), {'ts', 'tool', 'ok', 'args', 'error', 'ms', 'cancelled', 'action_sent', 'confirmed', 'outcome'})
        self.assertEqual(record['args'], {'token': '***'})
        self.audit.log_action('bad-types', {}, True, outcome={'cancelled': 1, 'action_sent': 'yes',
            'confirmed': 'false', 'outcome': 'private-result'})
        self.assertFalse(set(self.records()[-1]) & {'cancelled', 'action_sent', 'confirmed', 'outcome'})

    def test_legacy_positional_writer_call_and_normal_wrapper_remain_compatible(self):
        self.audit.log_action('legacy', {'path': 'owned'}, True, None, 5)
        self.assertEqual(set(self.records()[0]), {'ts', 'tool', 'ok', 'args', 'ms'})
        @self.server.mcp.tool(audit=True)
        async def cancel_audit_normal() -> dict:
            """Owned normal result probe."""
            return {'ok': True, 'action_sent': True, 'confirmed': None, 'outcome': 'unconfirmed'}
        self.assertTrue(asyncio.run(cancel_audit_normal())['ok'])
        record = self.records()[-1]
        self.assertTrue(record['ok'])
        self.assertTrue(record['action_sent'])
        self.assertNotIn('cancelled', record)


@unittest.skipUnless(sys.platform == 'darwin', 'Mac dispatched-input cancellation audit')
class MacCancellationAudit(_AuditFixture):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from ai_computer_control.tools import macos_act_and_verify
        from ai_computer_control.utils import macos_visual
        from PIL import Image
        cls.act, cls.visual, cls.Image = macos_act_and_verify, macos_visual, Image
        cls.target = {'ref': 'owned', 'pid': 123, 'process_start': '1:1', 'handle': 12,
                      'bounds': {'x': 20, 'y': 30, 'width': 100, 'height': 60}}

    def frame(self):
        return self.visual.VisualFrame(self.Image.new('RGB', (200, 120), 'white'),
            {'logical_bounds': self.target['bounds'], 'coordinate_space': 'macos_global_points'},
            (20, 30, 100, 60), time.monotonic(), self.target)

    async def wait_gate(self):
        for _ in range(200):
            if not self.act._ACT_GATE.locked():
                return
            await asyncio.sleep(.005)
        self.fail('Background observer gate did not release')

    def test_cancel_after_dispatch_retains_sent_state_and_audits_before_observer_finishes(self):
        async def run():
            entered, release = threading.Event(), threading.Event()
            def after(*args):
                entered.set()
                release.wait(5)
                return self.frame(), 0, False, True
            with patch.object(self.act, 'capture_frame', return_value=self.frame()), \
                    patch.object(self.visual.VisualFrame, 'require_fresh', return_value=0), \
                    patch.object(self.act, 'request', return_value={'ok': True, 'action_sent': True}) as dispatch, \
                    patch.object(self.act, '_after', side_effect=after):
                task = asyncio.create_task(self.act.act_and_verify({'type': 'key', 'key': 'escape'}, self.target))
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    self.assertTrue(self.act._ACT_GATE.locked())
                    self.assertEqual(dispatch.call_count, 1)
                    records = self.records()
                    self.assertEqual(len(records), 1)
                    self.assertTrue(records[0]['action_sent'])
                    self.assertTrue(records[0]['cancelled'])
                    self.assertIsNone(records[0]['confirmed'])
                    self.assertEqual(records[0]['outcome'], 'unconfirmed')
                finally:
                    release.set()
                    await self.wait_gate()
        asyncio.run(run())

    def test_cancel_before_capture_audits_not_dispatched_and_posts_nothing(self):
        async def run():
            entered, release = threading.Event(), threading.Event()
            def capture(*args):
                entered.set()
                release.wait(5)
                return self.frame()
            with patch.object(self.act, 'capture_frame', side_effect=capture), patch.object(self.act, 'request') as dispatch:
                task = asyncio.create_task(self.act.act_and_verify({'type': 'key', 'key': 'escape'}, self.target))
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    record = self.records()[0]
                    self.assertFalse(record['action_sent'])
                    self.assertTrue(record['cancelled'])
                    self.assertEqual(record['outcome'], 'not_dispatched')
                    dispatch.assert_not_called()
                finally:
                    release.set()
                    await self.wait_gate()
        asyncio.run(run())

    def test_timeout_after_dispatch_audits_known_sent_state(self):
        async def run():
            release = threading.Event()
            def after(*args):
                release.wait(5)
                return self.frame(), 0, False, True
            with patch.object(self.act, 'capture_frame', return_value=self.frame()), \
                    patch.object(self.visual.VisualFrame, 'require_fresh', return_value=0), \
                    patch.object(self.act, 'request', return_value={'ok': True, 'action_sent': True}), \
                    patch.object(self.act, '_after', side_effect=after), patch.object(self.act, '_VERIFICATION_TIMEOUT_S', .05):
                try:
                    result = await self.act.act_and_verify({'type': 'key', 'key': 'escape'}, self.target)
                    self.assertEqual(result['code'], 'verification_timeout')
                    self.assertTrue(self.records()[0]['action_sent'])
                    self.assertNotIn('cancelled', self.records()[0])
                finally:
                    release.set()
                    await self.wait_gate()
        asyncio.run(run())

    def test_uncertain_native_failure_preserves_dispatch_state_in_result_and_audit(self):
        from ai_computer_control.utils.macos import DesktopError
        error = DesktopError('input_session_timeout', 'controlled uncertain dispatch', {'action_sent': True, 'outcome': 'unknown'})
        with patch.object(self.act, 'capture_frame', return_value=self.frame()), \
                patch.object(self.visual.VisualFrame, 'require_fresh', return_value=0), \
                patch.object(self.act, 'request', side_effect=error):
            result = asyncio.run(self.act.act_and_verify({'type': 'key', 'key': 'escape'}, self.target))
        self.assertFalse(result['ok'])
        self.assertTrue(result['action_sent'])
        self.assertEqual(result['outcome'], 'unknown')
        record = self.records()[0]
        self.assertTrue(record['action_sent'])
        self.assertEqual(record['outcome'], 'unknown')
        self.assertNotIn('cancelled', record)


if __name__ == '__main__':
    unittest.main(verbosity=2)
