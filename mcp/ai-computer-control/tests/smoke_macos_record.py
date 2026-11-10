"""Pure native controlled-recording contracts. All desktop requests are mocked."""
import asyncio
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


@unittest.skipUnless(sys.platform == 'darwin', 'Mac controlled recording contracts')
class RecordingContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='p5-record-contract-')
        root = Path(cls.directory.name)
        cls.env = patch.dict(os.environ, {'HOME': str(root / 'home'), 'USERPROFILE': str(root / 'home'),
            'LOCALAPPDATA': str(root / 'local'), 'APPDATA': str(root / 'roaming'), 'WCW_DATA_DIR': str(root / 'data'),
            'RUYI_MACOS_AUTOMATION_HELPER': str(root / 'absent'), 'ACC_TOOLSETS': 'desktop,macro', 'ACC_HIDE_TOOLS': ''})
        cls.env.start()
        from ai_computer_control.tools import macos_record, batch
        from ai_computer_control.utils import macos_recording, macos
        cls.record, cls.batch, cls.core, cls.macos = macos_record, batch, macos_recording, macos
        cls.target = {'ref': 'fresh', 'pid': 123, 'process_start': '123:1', 'handle': 10,
                      'bounds': {'x': 120, 'y': 30, 'width': 200, 'height': 100}}

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.directory.cleanup()

    def recording(self, actions=None):
        return {'schema': 1, 'platform': 'darwin', 'coordinate_space': 'macos_global_points',
                'source': 'controlled_native_requests', 'complete': True, 'end_reason': 'stopped',
                'application': {'executable': '/owned/Fixture', 'bundle_id': ''},
                'bounds': {'x': -80, 'y': 20, 'width': 200, 'height': 100},
                'actions': actions if actions is not None else [self.click()]}

    def click(self, **changes):
        return {'op': 'mouse.click', 'at': .1, 'ended': .2, 'x': -50, 'y': 40,
                'button': 'left', 'clicks': 1, 'interval': .1, **changes}

    def current(self, **changes):
        return {'ok': True, 'target': copy.deepcopy(self.target),
                'application': self.recording()['application'], 'recording_pending': False, **changes}

    def test_rebind_translates_global_points_and_drops_old_private_identity(self):
        with patch.object(self.core, 'request', return_value=self.current()) as native:
            steps = self.core.prepare_recording(self.recording(), self.target)
        self.assertEqual(native.call_args.args[0], {'op': 'record.target', 'target': self.target, 'actions': self.recording()['actions']})
        self.assertEqual(steps, [{'tool': 'mouse_click', 'args': {'target': self.target,
            'x': 150, 'y': 50, 'button': 'left', 'clicks': 1, 'interval': .1}}])

    def test_text_preserves_chinese_and_separates_trailing_enter(self):
        action = {'op': 'keyboard.text', 'at': .1, 'ended': .6, 'text': '中文😀', 'paste': True, 'interval': 0, 'enters': 2}
        with patch.object(self.core, 'request', return_value=self.current()):
            steps = self.core.prepare_recording(self.recording([action]), self.target)
        self.assertEqual(steps[0]['args']['text'], '中文😀')
        self.assertTrue(steps[0]['args']['use_clipboard'])
        self.assertEqual([step['tool'] for step in steps], ['type_text', 'press_key', 'press_key'])
        self.assertEqual(steps[1]['args']['key'], 'enter')

    def test_all_pointer_and_chord_operations_use_existing_tools(self):
        actions = [
            {'op': 'mouse.move', 'at': 0, 'ended': .2, 'x': -50, 'y': 40, 'duration': .2},
            {'op': 'mouse.drag', 'at': .2, 'ended': .4, 'start_x': -50, 'start_y': 40,
             'x': -40, 'y': 50, 'duration': .2, 'button': 'right'},
            {'op': 'mouse.scroll', 'at': .4, 'ended': .5, 'x': -50, 'y': 40, 'amount': -2, 'direction': 'horizontal'},
            {'op': 'keyboard.chord', 'at': .5, 'ended': .6, 'keys': ['cmd', 'shift', 's']}]
        with patch.object(self.core, 'request', return_value=self.current()):
            steps = self.core.prepare_recording(self.recording(actions), self.target)
        self.assertEqual([s['tool'] for s in steps], ['mouse_move', 'mouse_drag', 'mouse_scroll', 'hotkey'])
        self.assertEqual((steps[1]['args']['start_x'], steps[1]['args']['end_x'], steps[1]['args']['end_y']), (150, 160, 60))
        self.assertEqual(steps[2]['args']['clicks'], -2)

    def test_idle_gaps_use_ended_time_and_cap_at_five_seconds(self):
        with patch.object(self.core, 'request', return_value=self.current()):
            steps = self.core.prepare_recording(self.recording([self.click(), self.click(at=20, ended=21)]), self.target)
        self.assertEqual(steps[1], {'tool': 'wait', 'args': {'seconds': 5.}})

    def test_wrong_application_size_and_pending_recording_refuse_binding(self):
        resized = self.current()
        resized['target']['bounds']['width'] += 1
        for current in [resized, self.current(application={'executable': '/other', 'bundle_id': ''}),
                        self.current(recording_pending=True)]:
            with self.subTest(current=current), patch.object(self.core, 'request', return_value=current), \
                    self.assertRaises(self.macos.DesktopError):
                self.core.prepare_recording(self.recording(), self.target)

    def test_all_bad_documents_refused_before_native_request(self):
        bad = []
        for changes in ({'schema': True}, {'platform': 'win32'}, {'coordinate_space': 'physical_pixels'},
                        {'complete': False}, {'end_reason': 'deadline'}, {'source': 'physical'},
                        {'unexpected': 1}, {'actions': [self.click()] * 101}, {'actions': 'wrong'}):
            bad.append({**self.recording(), **changes})
        bad.extend([self.recording([self.click(x=float('nan'))]), self.recording([self.click(x=5000)]),
                    self.recording([self.click(x=120)]), self.recording([self.click(y=120)]),
                    self.recording([self.click(clicks=True)]), self.recording([self.click(interval=-1)]),
                    self.recording([self.click(target=self.target)]),
                    self.recording([self.click(), self.click(at=.1)]), self.recording([self.click(op='clipboard.set')])])
        for recording in bad:
            with self.subTest(recording=recording), patch.object(self.core, 'request') as native, \
                    self.assertRaises(self.macos.DesktopError):
                self.core.prepare_recording(recording, self.target)
            native.assert_not_called()

    def test_oversized_and_invalid_text_refused(self):
        for text in ('x' * 65000, '\ud800'):
            action = {'op': 'keyboard.text', 'at': 0, 'ended': .5, 'text': text, 'paste': True, 'interval': 0, 'enters': 0}
            with self.subTest(text_length=len(text)), self.assertRaises(self.macos.DesktopError):
                self.core.validate_recording(self.recording([action]))

    def test_expanded_step_limit_is_checked_before_dispatch(self):
        actions = [{'op': 'keyboard.text', 'at': i, 'ended': i + .5, 'text': '',
                    'paste': True, 'interval': 0, 'enters': 20} for i in range(10)]
        with patch.object(self.core, 'request', return_value=self.current()), self.assertRaises(self.macos.DesktopError):
            self.core.prepare_recording(self.recording(actions), self.target)

    def test_native_start_is_synchronous_and_explicitly_target_bound(self):
        with patch.object(self.record, 'request', return_value={'ok': True}) as native:
            result = self.record.record_start(self.target, max_seconds=30)
        self.assertTrue(result['ok'])
        self.assertEqual(native.call_args.args[0], {'op': 'record.start', 'target': self.target, 'max_seconds': 30})

    def test_saved_complete_recording_is_atomic_and_listed(self):
        recording = self.recording()
        with patch.object(self.record, 'request', return_value={'ok': True, 'recording': recording}):
            result = self.record.record_stop('中文 test')
        path = Path(result['path'])
        self.assertEqual(json.loads(path.read_text()), recording)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(path.parent.glob('*.tmp')))
        listing = self.record.macro_list()
        self.assertTrue(any(m['name'] == '中文 test' and m['valid'] and m['steps'] == 1 for m in listing['macros']))

    def test_save_failure_retains_collected_recording(self):
        recording = self.recording()
        with patch.object(self.record, 'request', return_value={'ok': True, 'recording': recording}), \
                patch.object(self.record, '_save', side_effect=OSError('controlled failure')):
            result = self.record.record_stop('retry')
        self.assertEqual(result['recording'], recording)
        self.assertFalse(result['saved'])
        self.assertEqual(result['save_error'], 'controlled failure')

    def test_interrupted_recordings_are_returned_but_refuse_save(self):
        recording = {**self.recording(), 'complete': False, 'end_reason': 'focus_changed'}
        with patch.object(self.record, 'request', return_value={'ok': True, 'recording': recording}), \
                patch.object(self.record, '_save') as save:
            result = self.record.record_stop('interrupted')
        self.assertFalse(result['complete'])
        self.assertIn('save_error', result)
        save.assert_not_called()

    def test_invalid_name_does_not_consume_recording(self):
        for name in ('../outside', '/outside', 'C:\\outside', '.', '   ', 'a' * 81):
            with self.subTest(name=name), patch.object(self.record, 'request') as native:
                result = self.record.record_stop(name)
            self.assertEqual(result['code'], 'invalid_args')
            native.assert_not_called()

    def test_listing_never_follows_symlinks_or_opens_fifo_blocking(self):
        path, descriptor = self.record._directory()
        os.close(descriptor)
        outside = Path(self.directory.name) / 'outside.json'
        outside.write_text(json.dumps(self.recording()))
        (path / 'link.json').symlink_to(outside)
        os.mkfifo(path / 'fifo.json')
        entries = {m['name']: m for m in self.record.macro_list()['macros']}
        self.assertFalse(entries['link']['valid'])
        self.assertFalse(entries['fifo']['valid'])

    def test_symlink_directory_refuses_save(self):
        with tempfile.TemporaryDirectory(prefix='p5-record-link-') as root:
            base = Path(root)
            (base / 'elsewhere').mkdir()
            (base / 'macros').symlink_to(base / 'elsewhere', target_is_directory=True)
            with patch.object(self.record, 'data_dir', return_value=root), self.assertRaises(OSError):
                self.record._save('blocked.json', self.recording())
            self.assertEqual(list((base / 'elsewhere').iterdir()), [])

    def test_failed_temporary_cleanup_still_closes_anchored_directory(self):
        close = self.record.os.close
        with patch.object(self.record.os, 'unlink', side_effect=PermissionError('controlled cleanup failure')), \
                patch.object(self.record.os, 'close', wraps=close) as closed, self.assertRaises(PermissionError):
            self.record._save('cleanup.json', self.recording())
        self.assertEqual(closed.call_count, 1)

    def test_post_replace_durability_failure_reports_unknown_save_state(self):
        recording = self.recording()
        fsync = self.record.os.fsync
        def sync(descriptor):
            import stat
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError('controlled directory sync failure')
            return fsync(descriptor)
        with patch.object(self.record, 'request', return_value={'ok': True, 'recording': recording}), \
                patch.object(self.record.os, 'fsync', side_effect=sync):
            result = self.record.record_stop('durability')
        self.assertIsNone(result['saved'])
        self.assertIn('directory sync failure', result['save_error'])
        self.assertEqual(json.loads((Path(os.environ['WCW_DATA_DIR']) / 'macros/durability.json').read_text()), recording)

    def test_recording_replay_uses_live_registry_and_preserves_plain_steps(self):
        steps = [{'tool': 'mouse_click', 'args': {'target': self.target, 'x': 150, 'y': 50}}]
        with patch.object(self.core, 'prepare_recording', return_value=steps), \
                patch.object(self.batch, '_run_batch', new_callable=AsyncMock, return_value={'success': True}) as run:
            result = asyncio.run(self.batch.macro_run(recording=self.recording(), target=self.target))
        self.assertTrue(result['success'])
        run.assert_awaited_once_with(steps, 'stop', 0)
        with patch.object(self.batch, '_run_batch', new_callable=AsyncMock) as run:
            asyncio.run(self.batch.macro_run(steps=steps, delay_ms=0))
        run.assert_awaited_once_with(steps, 'stop', 0)

    def test_missing_hidden_input_and_windows_recording_refuse_dispatch(self):
        with patch.object(self.core, 'prepare_recording', return_value=[{'tool': 'mouse_click', 'args': {}}]), \
                patch.object(self.batch, '_tool_map', return_value={}), patch.object(self.batch, '_run_batch') as run:
            result = asyncio.run(self.batch.macro_run(recording=self.recording(), target=self.target))
        self.assertEqual(result['code'], 'tool_unavailable')
        run.assert_not_called()
        with patch.object(self.batch.sys, 'platform', 'win32'), patch.object(self.core, 'prepare_recording') as prepare:
            result = asyncio.run(self.batch.macro_run(recording=self.recording(), target=self.target))
        self.assertFalse(result['ok'])
        prepare.assert_not_called()

    def test_mixed_or_unbound_recordings_refuse_dispatch(self):
        for args in ({'recording': self.recording()}, {'steps': [], 'recording': self.recording(), 'target': self.target},
                     {'steps': [], 'target': self.target}):
            with self.subTest(args=args), patch.object(self.batch, '_run_batch') as run:
                result = asyncio.run(self.batch.macro_run(**args))
            self.assertFalse(result['ok'])
            run.assert_not_called()

    def test_native_preflight_sees_all_text_and_chord_actions(self):
        actions = [{'op': 'keyboard.text', 'at': 0, 'ended': .2, 'text': '中文', 'paste': False, 'interval': 0, 'enters': 0},
                   {'op': 'keyboard.chord', 'at': .2, 'ended': .3, 'keys': ['cmd', 'a']}]
        with patch.object(self.core, 'request', return_value=self.current()) as native:
            steps = self.core.prepare_recording(self.recording(actions), self.target)
        self.assertEqual(native.call_args.args[0]['actions'], actions)
        actions[1]['keys'].append('b')
        self.assertEqual(steps[1]['args']['keys'], ['cmd', 'a'])

    def test_missing_both_macro_inputs_refuses_but_explicit_empty_steps_succeeds(self):
        self.assertEqual(asyncio.run(self.batch.macro_run())['code'], 'invalid_args')
        self.assertTrue(asyncio.run(self.batch.macro_run(steps=[]))['success'])

    def test_zero_delay_replay_yields_before_every_synchronous_dispatch(self):
        dispatched = []
        async def scenario():
            def synchronous():
                dispatched.append('sent')
                asyncio.get_running_loop().call_soon(task.cancel)
                return {'ok': True}
            class Tool:
                fn = staticmethod(synchronous)
                is_async = False
            with patch.object(self.batch, '_tool_map', return_value={'owned': Tool()}):
                task = asyncio.create_task(self.batch._run_batch([{'tool': 'owned'}, {'tool': 'owned'}], 'stop', 0))
                with self.assertRaises(asyncio.CancelledError):
                    await task
        asyncio.run(scenario())
        self.assertEqual(dispatched, ['sent'])

    def test_replay_gate_refuses_start_and_releases_after_cancellation(self):
        async def scenario():
            entered = asyncio.Event()
            async def waiting(*args):
                entered.set()
                await asyncio.sleep(30)
            with patch.object(self.core, 'prepare_recording', return_value=[]), \
                    patch.object(self.batch, '_run_batch', side_effect=waiting):
                task = asyncio.create_task(self.batch.macro_run(recording=self.recording(), target=self.target))
                await entered.wait()
                with patch.object(self.record, 'request') as native:
                    result = self.record.record_start(self.target)
                self.assertEqual(result['code'], 'recording_busy')
                native.assert_not_called()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            with patch.object(self.record, 'request', return_value={'ok': True}):
                self.assertTrue(self.record.record_start(self.target)['ok'])
        asyncio.run(scenario())


if __name__ == '__main__':
    unittest.main(verbosity=2)
