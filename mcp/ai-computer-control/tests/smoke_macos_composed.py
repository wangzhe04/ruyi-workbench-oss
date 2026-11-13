"""Pure Mac shared-frame observation and action-verification contracts. No real desktop access."""
import asyncio
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


@unittest.skipUnless(sys.platform == 'darwin', 'Mac composed contracts')
class ComposedContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='p5-composed-contract-')
        root = Path(cls.directory.name)
        cls.env = patch.dict(os.environ, {'HOME': str(root / 'home'), 'USERPROFILE': str(root / 'home'),
            'LOCALAPPDATA': str(root / 'local'), 'APPDATA': str(root / 'roaming'), 'WCW_DATA_DIR': str(root / 'data'),
            'RUYI_MACOS_AUTOMATION_HELPER': str(root / 'absent'), 'ACC_TOOLSETS': 'desktop,observe,macro,ocr', 'ACC_HIDE_TOOLS': ''})
        cls.env.start()
        import ai_computer_control.server as server
        from ai_computer_control.tools import macos_observe, macos_act_and_verify, batch
        from ai_computer_control.utils import macos, macos_visual
        from PIL import Image
        cls.server, cls.observe, cls.act, cls.batch = server, macos_observe, macos_act_and_verify, batch
        cls.macos, cls.visual, cls.Image = macos, macos_visual, Image
        cls.target = {'ref': 'owned', 'handle': 12, 'pid': 123, 'process_start': '42:1',
                      'bounds': {'x': -100, 'y': 20, 'width': 100, 'height': 60}}
        cls.row = {'title': 'Owned Window', 'pid': 123, 'handle': 12, 'target': cls.target}
        cls.state = {'ready': True, 'windowReady': True, 'axReady': True, 'ocrReady': True, 'inputReady': True}

    @classmethod
    def tearDownClass(cls):
        cls.env.stop(); cls.directory.cleanup()

    def frame(self, color='white'):
        return self.visual.VisualFrame(self.Image.new('RGB', (200, 180), color),
            {'logical_bounds': dict(self.target['bounds']), 'coordinate_space': 'macos_global_points'},
            (-100, 20, 100, 60), time.monotonic(), self.target)

    def test_observe_reuses_exact_frame_for_screenshot_and_ocr(self):
        frame = self.frame()
        recognized = {'words': [{'text': '中文', 'left': -90, 'top': 30, 'width': 10, 'height': 5, 'center': [-85, 32.5]}]}
        with patch.object(self.observe, '_prepare', return_value=(self.state, {'present': True}, self.row, frame)), \
                patch.object(self.observe.ocr_backend, 'ocr_frame', new_callable=AsyncMock, return_value=recognized) as ocr:
            result = asyncio.run(self.observe.observe(max_width=100, include_uia=False, target=self.target))
        self.assertTrue(result['ok'])
        self.assertIs(ocr.call_args.args[0], frame.image)
        self.assertEqual(ocr.call_args.kwargs['logical_bounds'], self.target['bounds'])
        self.assertEqual((result['screenshot']['scale'], result['screenshot']['scale_y']), (1., 1.5))
        self.assertEqual(result['ocr_words'][0]['center'], [-85, 32.5])
        self.assertEqual(result['coordinate_space'], 'macos_global_points')

    def test_optional_backend_failure_preserves_the_screenshot(self):
        frame = self.frame()
        error = self.macos.DesktopError('ocr_busy', 'controlled overlap')
        with patch.object(self.observe, '_prepare', return_value=(self.state, {}, self.row, frame)), \
                patch.object(self.observe, '_ax_snapshot', new_callable=AsyncMock, side_effect=error), \
                patch.object(self.observe.ocr_backend, 'ocr_frame', new_callable=AsyncMock, side_effect=error):
            result = asyncio.run(self.observe.observe())
        self.assertTrue(result['ok']); self.assertIn('screenshot', result)
        self.assertEqual(set(result['degraded']), {'uia', 'ocr'})
        self.assertEqual(result['backend_errors']['ocr']['code'], 'ocr_busy')

    def test_text_only_observation_omits_encoded_image(self):
        with patch.object(self.observe, '_prepare', return_value=(self.state, {}, self.row, None)) as prepare:
            result = asyncio.run(self.observe.observe(include_screenshot=False, include_ocr=False, include_uia=False))
        self.assertNotIn('screenshot', result)
        self.assertFalse(prepare.call_args.args[-1])

    def test_unavailable_optional_ocr_does_not_capture_for_text_only_request(self):
        state = {**self.state, 'ocrReady': False}
        with patch.object(self.macos, 'capability', return_value=state), \
                patch.object(self.observe, 'request', return_value={'window': self.row}), \
                patch.object(self.observe, 'capture_frame') as capture:
            prepared = self.observe._prepare(None, None, None, False, True)
        self.assertIsNone(prepared[-1]); capture.assert_not_called()

    def test_optional_ocr_capture_denial_can_return_ax_only_observation(self):
        error = self.macos.DesktopError('permission_denied', 'controlled screen denial')
        with patch.object(self.macos, 'capability', return_value=self.state), \
                patch.object(self.observe, 'request', return_value={'window': self.row}), \
                patch.object(self.observe, 'capture_frame', side_effect=error), \
                patch.object(self.observe, '_ax_snapshot', new_callable=AsyncMock, return_value={'uia_elements': [{'name': 'owned'}]}):
            result = asyncio.run(self.observe.observe(include_screenshot=False))
        self.assertTrue(result['ok']); self.assertEqual(result['degraded'], ['ocr'])
        self.assertEqual(result['uia_elements'], [{'name': 'owned'}])
        self.assertEqual(result['backend_errors']['ocr']['code'], 'permission_denied')

    def test_named_window_capture_checks_identity_geometry_and_post_capture_target(self):
        frame = self.frame(); info = {**frame.info, 'window_id': 12, 'pid': 123}
        replies = [{'window': self.row}, {'windows': [self.row]}, {'windows': [self.row]}]
        with patch.object(self.macos, 'capability', return_value=self.state), \
                patch.object(self.observe, 'request', side_effect=replies), \
                patch.object(self.macos, 'capture', return_value=(frame.image, info)):
            result = self.observe._prepare('Owned Window', None, None, True)
        self.assertEqual(result[-1].image.size, (200, 180))
        changed = copy.deepcopy(self.row); changed['target']['process_start'] = '43:0'
        replies = [{'window': self.row}, {'windows': [self.row]}, {'windows': [changed]}]
        with patch.object(self.macos, 'capability', return_value=self.state), \
                patch.object(self.observe, 'request', side_effect=replies), \
                patch.object(self.macos, 'capture', return_value=(frame.image, info)), self.assertRaises(self.macos.DesktopError):
            self.observe._prepare('Owned Window', None, None, True)

    def test_observe_toolset_does_not_register_direct_ocr_or_capture_tools(self):
        code = "import json;import ai_computer_control.server as s;print(json.dumps([t.name for t in s.mcp._tool_manager.list_tools()]))"
        env = {**os.environ, 'ACC_TOOLSETS': 'observe', 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')}
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, env=env, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        names = set(json.loads(result.stdout))
        self.assertTrue({'observe', 'act_and_verify'} <= names)
        self.assertFalse({'ocr_image', 'screenshot', 'ui_find', 'type_text'} & names)

    def test_action_payload_uses_existing_text_routing_and_mac_chords(self):
        payload = self.act._action_payload({'type': 'type', 'text': '中文\n'}, self.target)
        self.assertTrue(payload['paste']); self.assertEqual((payload['text'], payload['enters']), ('中文', 1))
        payload = self.act._action_payload({'type': 'key', 'key': 'cmd+shift+s'}, self.target)
        self.assertEqual(payload['keys'], ['cmd', 'shift', 's'])
        for action in ({'type': 'bogus'}, {'type': 'click', 'x': float('nan'), 'y': 30},
                       {'type': 'type', 'text': 'a', 'use_clipboard': 'yes'}, {'type': 'click', 'target': {}}):
            with self.subTest(action=action), self.assertRaises(self.macos.DesktopError):
                self.act._action_payload(action, self.target)

    def test_verification_roi_maps_both_axes_and_rejects_nonintersecting_region(self):
        crop, logical = self.act._region_box(self.frame(), '-90,30,20,10', {'type': 'key'})
        self.assertEqual(crop, (20, 30, 60, 60))
        self.assertEqual(logical, {'x': -90, 'y': 30, 'width': 20, 'height': 10})
        with self.assertRaises(self.macos.DesktopError):
            self.act._region_box(self.frame(), '100,100,10,10', {'type': 'key'})

    def test_zero_settle_budget_observes_immediate_pixel_change_with_one_dispatch(self):
        before, after = self.frame(), self.frame()
        for x in range(20, 40):
            for y in range(30, 60): after.image.putpixel((x, y), (0, 0, 0))
        with patch.object(self.act, 'capture_frame', side_effect=[before, after]), \
                patch.object(self.visual.VisualFrame, 'prepare_click'), \
                patch.object(self.visual.VisualFrame, 'require_fresh', return_value=0), \
                patch.object(self.act, 'request', return_value={'ok': True, 'action_sent': True}) as dispatch:
            result = asyncio.run(self.act.act_and_verify({'type': 'click', 'x': -85, 'y': 35}, self.target, settle_ms=0, return_image='after'))
        self.assertTrue(result['ok']); self.assertTrue(result['effect_observed'])
        self.assertGreater(result['changed_ratio'], 0); self.assertIsNone(result['confirmed'])
        self.assertEqual(result['outcome'], 'unconfirmed'); self.assertEqual(dispatch.call_count, 1)
        self.assertEqual((result['scale'], result['scale_y']), (2., 3.))

    def test_post_action_verification_failure_preserves_posted_action_result(self):
        error = self.macos.DesktopError('target_changed', 'controlled focus change')
        with patch.object(self.act, 'capture_frame', return_value=self.frame()), \
                patch.object(self.visual.VisualFrame, 'require_fresh', return_value=0), \
                patch.object(self.act, 'request', return_value={'ok': True, 'action_sent': True}), \
                patch.object(self.act, '_after', side_effect=error):
            result = asyncio.run(self.act.act_and_verify({'type': 'key', 'key': 'enter'}, self.target))
        self.assertFalse(result['ok']); self.assertEqual(result['code'], 'target_changed')
        self.assertTrue(result['action_sent']); self.assertTrue(result['action_result']['action_sent'])
        self.assertFalse(self.act._ACT_GATE.locked())

    def test_cancelled_before_capture_cannot_post_input_and_gate_waits_for_worker(self):
        async def run():
            entered, release = threading.Event(), threading.Event()
            def capture(*args): entered.set(); release.wait(2); return self.frame()
            with patch.object(self.act, 'capture_frame', side_effect=capture), patch.object(self.act, 'request') as dispatch:
                task = asyncio.create_task(self.act.act_and_verify({'type': 'key', 'key': 'enter'}, self.target))
                await asyncio.to_thread(entered.wait, 1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                self.assertTrue(self.act._ACT_GATE.locked())
                release.set()
                for _ in range(100):
                    if not self.act._ACT_GATE.locked(): break
                    await asyncio.sleep(.005)
                self.assertFalse(self.act._ACT_GATE.locked()); dispatch.assert_not_called()
        asyncio.run(run())

    def test_timeout_after_action_preserves_result_and_retains_gate_until_observer_stops(self):
        async def run():
            entered, release = threading.Event(), threading.Event()
            def after(*args): entered.set(); release.wait(2); return self.frame(), 0, False, True
            with patch.object(self.act, 'capture_frame', return_value=self.frame()), \
                    patch.object(self.visual.VisualFrame, 'require_fresh', return_value=0), \
                    patch.object(self.act, 'request', return_value={'ok': True, 'action_sent': True}) as dispatch, \
                    patch.object(self.act, '_after', side_effect=after), patch.object(self.act, '_VERIFICATION_TIMEOUT_S', .05):
                result = await self.act.act_and_verify({'type': 'key', 'key': 'enter'}, self.target)
                self.assertEqual(result['code'], 'verification_timeout')
                self.assertTrue(result['action_result']['action_sent'])
                self.assertTrue(self.act._ACT_GATE.locked())
                release.set()
                for _ in range(100):
                    if not self.act._ACT_GATE.locked(): break
                    await asyncio.sleep(.005)
                self.assertFalse(self.act._ACT_GATE.locked()); self.assertEqual(dispatch.call_count, 1)
        asyncio.run(run())

    def test_discovery_and_diagnostics_separate_observation_from_input_readiness(self):
        state = {**self.state, 'installed': True, 'axSupported': True, 'ocrSupported': True, 'inputReady': False}
        with patch.object(self.macos, 'capability', return_value=state):
            names = {tool.name for tool in asyncio.run(self.server.mcp.list_tools())}
            self.assertIn('observe', names); self.assertNotIn('act_and_verify', names)
            diagnostic = self.server.mcp._tool_manager.get_tool('diagnostics').fn()
        self.assertTrue(diagnostic['optional']['ocr']); self.assertTrue(diagnostic['optional']['uia'])
        self.assertTrue(diagnostic['capabilities']['desktop.observe']['ready'])
        self.assertFalse(diagnostic['capabilities']['desktop.action_verification']['ready'])
        self.assertTrue(diagnostic['capabilities']['desktop.macro_replay']['ready'])

    def test_macro_query_and_async_wait_work_without_native_helper(self):
        result = asyncio.run(self.batch.macro_run([
            {'tool': 'version_info', 'args': {}}, {'tool': 'wait', 'args': {'seconds': 0}}], delay_ms=0))
        self.assertTrue(result['ok']); self.assertEqual(result['completed'], 2)
        async def run():
            task = asyncio.create_task(self.batch.wait(300))
            await asyncio.sleep(.01)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        asyncio.run(run())

    def test_nested_batch_image_lifts_actual_image_geometry(self):
        shot = {'image': 'a' * 1100, 'width': 100, 'height': 60, 'scale': 1., 'scale_y': 1.5,
                'origin': {'x': -100, 'y': 20}, 'logical_bounds': self.target['bounds'], 'coordinate_space': 'macos_global_points'}
        result = self.batch.lift_batch_images({'results': [{'step': 0, 'tool': 'observe', 'result': {'screenshot': shot, 'width': 999}}]})
        self.assertEqual(result['width'], 100)
        self.assertEqual(result['scale_y'], 1.5)
        self.assertEqual(result['origin'], {'x': -100, 'y': 20})
        self.assertEqual(result['lifted_images'][0]['logical_bounds'], self.target['bounds'])
        self.assertNotIn('image', result['results'][0]['result']['screenshot'])


if __name__ == '__main__':
    unittest.main()
