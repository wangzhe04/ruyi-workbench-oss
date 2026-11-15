"""Pure OCR, visual-frame and bounded worker contracts. Never operates the real desktop."""
import asyncio
import copy
import io
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


@unittest.skipUnless(sys.platform == 'darwin', 'Mac visual contracts')
class VisualContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='p5-visual-contract-')
        root = Path(cls.directory.name)
        cls.env = patch.dict(os.environ, {'HOME': str(root / 'home'), 'USERPROFILE': str(root / 'home'),
            'LOCALAPPDATA': str(root / 'local'), 'APPDATA': str(root / 'roaming'), 'WCW_DATA_DIR': str(root / 'data'),
            'RUYI_MACOS_AUTOMATION_HELPER': str(root / 'absent'), 'ACC_TOOLSETS': 'ocr,vision', 'ACC_HIDE_TOOLS': ''})
        cls.env.start()
        import ai_computer_control.server as server
        from ai_computer_control.tools import macos_ocr, macos_vision as vision
        from ai_computer_control.utils import macos, macos_visual, macos_vision, macos_vision_worker, macos_ocr as ocr_backend
        from PIL import Image
        cls.server, cls.ocr, cls.vision = server, macos_ocr, vision
        cls.ocr_backend = ocr_backend
        cls.macos, cls.visual, cls.matcher, cls.worker, cls.Image = macos, macos_visual, macos_vision, macos_vision_worker, Image
        cls.target = {'ref': 'owned-window', 'pid': 12, 'birth': 42,
                      'bounds': {'x': -100, 'y': 20, 'width': 100, 'height': 60}}
        cls.box = {'left': 20, 'top': 20, 'width': 60, 'height': 20}

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.directory.cleanup()

    def frame(self, *, size=(200, 120), age=0, target=True):
        return self.visual.VisualFrame(self.Image.new('RGB', size, 'white'),
            {'logical_bounds': dict(self.target['bounds'])}, (-100, 20, 100, 60), time.monotonic() - age,
            self.target if target else None)

    def native_result(self):
        return {'ok': True, 'success': True, 'width': 200, 'height': 120, 'coordinate_space': 'image_pixels',
                'text': '中文', 'lines': ['中文'], 'words_total': 1, 'words': [
                    {'text': '中文', 'left': 20, 'top': 20, 'width': 60, 'height': 20, 'center': [50, 30], 'line': 0}]}

    def test_both_axes_and_negative_origins_are_mapped(self):
        mapped = self.frame(size=(200, 180)).screen_box(self.box)
        self.assertEqual(mapped['left'], -90)
        self.assertAlmostEqual(mapped['top'], 20 + 20 / 3)
        self.assertEqual(mapped['width'], 30)
        self.assertAlmostEqual(mapped['height'], 20 / 3)

    def test_bad_and_partially_outside_boxes_fail(self):
        for changes in ({'left': -1}, {'width': 0}, {'left': 199}, {'top': float('nan')}, {'width': True}):
            with self.subTest(changes=changes), self.assertRaises(self.macos.DesktopError):
                self.frame().screen_box({**self.box, **changes})

    def test_click_needs_bound_target(self):
        with self.assertRaisesRegex(self.macos.DesktopError, 'target'):
            self.frame(target=False).click(self.box)

    def test_success_rechecks_focus_and_posts_only_native_event(self):
        frame = self.frame()
        with patch.object(self.visual, 'require_active', return_value=self.target) as active, \
                patch.object(self.visual, 'capture_frame', return_value=self.frame()), \
                patch.object(self.visual, 'input_request', return_value={'ok': True}) as dispatch:
            result = frame.click(self.box)
        self.assertEqual(active.call_count, 2)
        self.assertEqual(dispatch.call_args.args[0]['op'], 'mouse.click')
        self.assertEqual((dispatch.call_args.args[0]['x'], dispatch.call_args.args[0]['y']), (-75, 35))
        self.assertIsNone(result['confirmed'])
        self.assertEqual(result['outcome'], 'unconfirmed')

    def test_changed_pixels_geometry_and_stale_observations_never_dispatch(self):
        for mode in ('pixels', 'size', 'bounds', 'stale', 'expired_after_capture', 'focus'):
            old, current = self.frame(), self.frame()
            if mode == 'pixels': current.image.putpixel((30, 25), (0, 0, 0))
            if mode == 'size': current.image = self.Image.new('RGB', (201, 120), 'white')
            if mode == 'bounds': current.info['logical_bounds']['x'] += 1
            if mode == 'stale': old.started -= 11
            def recapture(*args):
                if mode == 'expired_after_capture': old.started -= 11
                return current
            active = self.macos.DesktopError('target_changed', 'focus changed') if mode == 'focus' else None
            with self.subTest(mode=mode), patch.object(self.visual, 'require_active', side_effect=active), \
                    patch.object(self.visual, 'capture_frame', side_effect=recapture), \
                    patch.object(self.visual, 'input_request') as dispatch:
                with self.assertRaises(self.macos.DesktopError): old.click(self.box)
                dispatch.assert_not_called()

    def test_exact_target_includes_identity_bounds_and_reference(self):
        with patch.object(self.visual, 'input_request', return_value={'window': {'target': self.target}}):
            self.assertEqual(self.visual.require_active(copy.deepcopy(self.target)), self.target)
            for key in self.target:
                changed = copy.deepcopy(self.target); changed.pop(key)
                with self.subTest(key=key), self.assertRaises(self.macos.DesktopError):
                    self.visual.require_active(changed)

    def test_capture_clips_roi_to_current_target(self):
        with patch.object(self.visual, 'require_active', return_value=self.target), \
                patch.object(self.macos, 'capture', return_value=(self.frame().image, self.frame().info)) as capture:
            self.visual.capture_frame('-200,40,150,100', self.target)
        self.assertEqual(capture.call_args.kwargs['region'], (-100, 40, 50, 40))

    def test_outside_roi_is_refused_before_capture(self):
        with patch.object(self.visual, 'require_active', return_value=self.target), patch.object(self.macos, 'capture') as capture:
            with self.assertRaises(self.macos.DesktopError): self.visual.capture_frame('100,100,10,10', self.target)
        capture.assert_not_called()

    def test_selection_requires_explicit_disambiguation_and_refuses_ties(self):
        candidates = [{'center': [0, 0]}, {'center': [10, 0]}]
        for options in ({}, {'nearest_to': {'x': 5, 'y': 0}}, {'nth': True}, {'nth': -1},
                        {'nth': 0, 'nearest_to': {'x': 1, 'y': 2}}, {'nearest_to': {'x': float('inf'), 'y': 0}}):
            with self.subTest(options=options), self.assertRaises(self.macos.DesktopError):
                self.visual.select_match(candidates, **options)
        self.assertEqual(self.visual.select_match(candidates, nth=1), 1)
        self.assertEqual(self.visual.select_match(candidates, nearest_to={'x': 9, 'y': 0}), 1)

    def test_native_response_validates_metadata_tokens_centers_and_bounds(self):
        good = self.native_result()
        with patch.object(self.macos, 'request', return_value=good):
            self.assertEqual(self.ocr._recognize('/tmp/image.png', None), good)
        cases = []
        for key, value in [('width', True), ('words_total', True), ('text', 'x' * 67537), ('lines', ['x' * 4097])]:
            item = copy.deepcopy(good); item[key] = value; cases.append(item)
        for key, value in [('left', -1), ('center', [0, 0]), ('line', True), ('width', float('nan')), ('text', '')]:
            item = copy.deepcopy(good); item['words'][0][key] = value; cases.append(item)
        for item in cases:
            with self.subTest(item=str(item)[:80]), patch.object(self.macos, 'request', return_value=item), \
                    self.assertRaises(self.macos.DesktopError): self.ocr._recognize('/tmp/image.png', None)

    def test_response_word_cap_preserves_full_matching_data(self):
        result = {'words': [{'text': str(index)} for index in range(600)], 'text': 'complete', 'lines': ['complete']}
        capped = self.ocr._cap(result)
        self.assertEqual((len(capped['words']), capped['words_total'], capped['truncated']), (500, 600, True))
        self.assertEqual(len(result['words']), 600)

    def test_internal_async_ocr_yields_while_worker_runs(self):
        async def run():
            def recognize(*args): time.sleep(0.08); return self.native_result()
            with patch.object(self.ocr_backend, '_frame_result', side_effect=recognize):
                task = asyncio.create_task(self.ocr.ocr_frame(self.frame().image))
                await asyncio.sleep(0.01)
                self.assertFalse(task.done())
                self.assertTrue(self.ocr._OCR_GATE.locked())
                await task
            self.assertFalse(self.ocr._OCR_GATE.locked())
        asyncio.run(run())

    def test_cancelled_ocr_observation_retains_gate_until_worker_finishes_without_clicking(self):
        async def run():
            entered, release = threading.Event(), threading.Event()
            def locate(*args):
                entered.set(); release.wait(2)
                return self.frame(), self.native_result(), []
            with patch.object(self.ocr, '_locate', side_effect=locate), \
                    patch.object(self.visual.VisualFrame, 'click_async', new_callable=AsyncMock) as click:
                task = asyncio.create_task(self.ocr.ocr_click('owned', target=self.target))
                await asyncio.to_thread(entered.wait, 1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                self.assertTrue(self.ocr._OCR_GATE.locked())
                release.set()
                for _ in range(100):
                    if not self.ocr._OCR_GATE.locked(): break
                    await asyncio.sleep(.005)
                self.assertFalse(self.ocr._OCR_GATE.locked())
                click.assert_not_called()
        asyncio.run(run())

    def test_cancel_during_click_recapture_cannot_leave_background_input(self):
        async def run():
            entered, release = threading.Event(), threading.Event()
            def prepare(*args):
                entered.set(); release.wait(2)
                return self.frame().screen_box(self.box)
            frame = self.frame()
            with patch.object(self.visual.VisualFrame, 'prepare_click', side_effect=prepare), \
                    patch.object(self.visual.VisualFrame, 'dispatch_click') as dispatch:
                task = asyncio.create_task(frame.click_async(self.box))
                await asyncio.to_thread(entered.wait, 1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                release.set(); await asyncio.sleep(.02)
                dispatch.assert_not_called()
        asyncio.run(run())

    def test_wait_deadline_refuses_late_hits_and_retains_worker_gate(self):
        async def run():
            entered, release = threading.Event(), threading.Event()
            def observe(*args):
                entered.set(); release.wait(2)
                return self.frame(), {'best': [1., 1.], 'hits': []}, [{'confidence': 1., **self.frame().screen_box(self.box)}]
            with patch.object(self.matcher, 'observe', side_effect=observe):
                task = asyncio.create_task(self.vision.wait_for_image(template_path='/tmp/t.png', timeout=.05))
                await asyncio.to_thread(entered.wait, 1)
                result = await task
                self.assertFalse(result['found'])
                self.assertTrue(self.matcher.GATE.locked())
                release.set()
                for _ in range(100):
                    if not self.matcher.GATE.locked(): break
                    await asyncio.sleep(.005)
                self.assertFalse(self.matcher.GATE.locked())
        asyncio.run(run())

    def test_ocr_gate_rejects_overlap_and_recovers_after_failure(self):
        with patch.object(self.macos, 'request', side_effect=self.macos.DesktopError('ocr_failed', 'controlled')):
            self.assertFalse(asyncio.run(self.ocr.ocr_image('/tmp/image.png'))['ok'])
        self.assertFalse(self.ocr._OCR_GATE.locked())
        self.ocr._OCR_GATE.acquire()
        try: self.assertEqual(asyncio.run(self.ocr.ocr_image('/tmp/image.png'))['code'], 'ocr_busy')
        finally: self.ocr._OCR_GATE.release()

    def test_query_readiness_is_separate_from_screen_and_input(self):
        for ocr_ready, screen_ready in ((True, False), (False, True), (True, True)):
            state = {'ocrReady': ocr_ready, 'ready': screen_ready, 'inputReady': False}
            with self.subTest(state=state), patch.object(self.macos, 'capability', return_value=state):
                names = {tool.name for tool in asyncio.run(self.server.mcp.list_tools())}
                self.assertEqual(self.macos.OCR_LOCAL_TOOLS <= names, ocr_ready)
                self.assertEqual(self.macos.OCR_SCREEN_TOOLS <= names, ocr_ready and screen_ready)
                self.assertEqual(self.macos.VISION_TOOLS <= names, screen_ready)

    def test_missing_opencv_hides_vision_and_diagnostics_separates_input_readiness(self):
        state = {'ocrReady': True, 'ocrSupported': True, 'ready': True, 'inputReady': False, 'authorization': 'granted'}
        with patch.object(self.macos, 'capability', return_value=state), patch.object(self.vision, '_AVAILABLE', False):
            names = {tool.name for tool in asyncio.run(self.server.mcp.list_tools())}
            self.assertFalse(self.macos.VISION_TOOLS & names)
        diagnostic = self.server.mcp._tool_manager.get_tool('diagnostics').fn
        with patch.object(self.macos, 'capability', return_value=state):
            result = diagnostic()['capabilities']['desktop.template_matching']
        self.assertTrue(result['ready'])
        self.assertFalse(result['inputReady'])

    def test_recognized_frame_dimensions_must_equal_actual_capture(self):
        result = self.native_result(); result['width'] += 1
        with patch.object(self.ocr_backend, '_recognize', return_value=result), self.assertRaises(self.macos.DesktopError):
            self.ocr._frame_result(self.frame(), None)

    def test_vision_queries_use_bounded_worker_and_logical_mapping(self):
        raw = {'hits': [[0.99, 20, 20, 60, 20]], 'best': [0.99, 1]}
        with patch.object(self.matcher, 'observe', return_value=(self.frame(), raw, [{'confidence': .99, **self.frame().screen_box(self.box)}])):
            result = asyncio.run(self.vision.find_template(template_path='/tmp/template.png', multiscale=False))
        self.assertTrue(result['found'])
        self.assertEqual(result['match']['center'], [-75, 35])

    def test_vision_click_refuses_missing_target_and_ambiguous_matches(self):
        self.assertEqual(asyncio.run(self.vision.vision_click(template_path='/tmp/t.png'))['code'], 'target_required')
        boxes = [self.frame().screen_box(self.box)] * 2
        with patch.object(self.matcher, 'observe', return_value=(self.frame(), {'hits': [], 'best': None}, boxes)), \
                patch.object(self.visual.VisualFrame, 'click') as click:
            result = asyncio.run(self.vision.vision_click(template_path='/tmp/t.png', target=self.target))
        self.assertEqual(result['code'], 'vision_ambiguous'); click.assert_not_called()

    def test_vision_gate_rejects_concurrent_workers(self):
        with self.matcher.operation():
            with self.assertRaises(self.macos.DesktopError):
                with self.matcher.operation(): pass
        self.assertFalse(self.matcher.GATE.locked())

    def test_worker_finds_two_synthetic_patterns_and_rejects_flat_template(self):
        import numpy as np
        rng = np.random.default_rng(42)
        template = self.Image.fromarray(rng.integers(0, 256, (20, 30, 3), dtype=np.uint8))
        screen = self.Image.new('RGB', (180, 100), 'white')
        screen.paste(template, (10, 10)); screen.paste(template, (100, 50))
        screen_path, template_path = Path(self.directory.name) / 'screen.png', Path(self.directory.name) / 'template.png'
        screen.save(screen_path); template.save(template_path)
        payload = {'screen_path': str(screen_path), 'template_path': str(template_path), 'confidence': .99, 'scales': [1.]}
        result = self.worker.run(payload)
        self.assertEqual(len(result['hits']), 2)
        self.assertEqual({(hit[1], hit[2]) for hit in result['hits']}, {(10, 10), (100, 50)})
        frame = self.visual.VisualFrame(screen, {'logical_bounds': {'x': -90, 'y': 15, 'width': 90, 'height': 50}},
                                        None, time.monotonic(), None)
        child_result = self.matcher.match_frame(frame, str(template_path), None, .99, [1.])
        self.assertEqual(len(child_result['hits']), 2)
        self.Image.new('RGB', (20, 20), 'white').save(template_path)
        with self.assertRaises(ValueError): self.worker.run(payload)

    def test_raw_hit_capacity_precedes_result_collection(self):
        import numpy as np
        from ai_computer_control.utils.template_match import match_templates
        import cv2
        screen, template = np.ones((80, 80), dtype=np.uint8), np.ones((10, 10), dtype=np.uint8)
        with self.assertRaises(OverflowError):
            match_templates(screen, template, .5, [1.], True, cv_backend=cv2, np_backend=np, max_hits=10)

    def test_worker_rejects_non_regular_and_oversized_input(self):
        with self.assertRaises(ValueError): self.worker.read_file('/dev/null', 100)
        path = Path(self.directory.name) / 'large'; path.write_bytes(b'large')
        with self.assertRaises(ValueError): self.worker.read_file(str(path), 4)


if __name__ == '__main__':
    unittest.main()
