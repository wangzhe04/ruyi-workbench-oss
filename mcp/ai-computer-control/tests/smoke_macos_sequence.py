"""Pure portable manual-event contracts. No desktop operation is performed."""
import asyncio
import copy
import os
from pathlib import Path
import sys
import threading
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


@unittest.skipUnless(sys.platform == 'darwin', 'Mac portable event contracts')
class SequenceContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='p5-sequence-contract-')
        root = Path(cls.directory.name)
        cls.env = patch.dict(os.environ, {key: str(root / key) for key in
            ('HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'WCW_DATA_DIR')})
        cls.env.start()
        from ai_computer_control.utils.macos_sequence import validate_events
        from ai_computer_control.utils.macos import DesktopError
        from ai_computer_control.tools import macos_events
        from ai_computer_control.utils import macos_recording
        cls.validate = staticmethod(validate_events)
        cls.error, cls.tools, cls.recording = DesktopError, macos_events, macos_recording

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.directory.cleanup()

    def key(self, kind, offset=0, code=0, flags=0, **changes):
        return {'type': kind, 'at_us': offset, 'keycode': code, 'flags': flags, 'keyboard_type': 91,
                **({} if kind == 'flags' else {'repeat': 0}), **changes}

    def events(self):
        return [self.key('key_down'), self.key('key_up', 100000)]

    def pointer(self, kind, offset=0, **changes):
        return {'type': kind, 'at_us': offset, 'flags': 0, 'x': -10, 'y': 30, 'button': 0,
                'click_state': 1, 'pressure': 0, 'delta_x': 0, 'delta_y': 0, **changes}

    def scroll(self, phase=0, momentum=0, offset=0, **changes):
        return {'type': 'scroll', 'at_us': offset, 'flags': 0, 'x': -10, 'y': 30, 'continuous': True,
                'delta': [2, -3, 0], 'point': [9, -14, 0], 'fixed': [2.25, -3.5, 0],
                'phase': phase, 'momentum': momentum, 'scroll_count': 1, **changes}

    def test_raw_overrides_and_full_twenty_utf16_units_are_preserved(self):
        for text in ('', 'z', '中文', '😀', '😀' * 10):
            self.validate([self.key('key_down', unicode=text), self.key('key_up', 100000)])
        for text in ('😀' * 11, '\ud800'):
            with self.assertRaises(self.error):
                self.validate([self.key('key_down', unicode=text), self.key('key_up', 100000)])

    def test_native_flag_bits_are_preserved_without_guessing_their_meaning(self):
        self.validate([self.key('key_down', flags=0x20000000), self.key('key_up', 100000, flags=0x20000000)])

    def test_overlapping_keys_and_repeat_are_complete(self):
        self.validate([self.key('key_down'), self.key('key_down', 10, code=1),
            self.key('key_down', 20, repeat=1), self.key('key_up', 30), self.key('key_up', 40, code=1)])

    def test_unmatched_missing_and_duplicate_keys_are_rejected(self):
        invalid = [[], self.events()[:1], self.events()[1:], [self.key('key_down', repeat=1)],
                   [self.key('key_down'), self.key('key_down', 10), self.key('key_up', 20)],
                   [self.key('key_down'), self.key('key_up', 10, repeat=1)]]
        for events in invalid:
            with self.subTest(events=events), self.assertRaises(self.error):
                self.validate(events)

    def test_left_and_right_modifiers_are_owned_independently(self):
        self.validate([self.key('flags', code=56, flags=1 << 17), self.key('flags', 10, code=60, flags=1 << 17),
                       self.key('flags', 20, code=56, flags=1 << 17), self.key('flags', 30, code=60)])
        with self.assertRaises(self.error):
            self.validate([self.key('flags', code=56, flags=1 << 17), self.key('flags', 10, code=60)])

    def test_supplied_device_modifier_bits_match_left_right_ownership(self):
        self.validate([self.key('flags', code=56, flags=(1 << 17) | 2), self.key('flags', 10, code=56)])
        for events in ([self.key('flags', code=56, flags=(1 << 17) | 4), self.key('flags', 10, code=56)],
                       [self.key('flags', code=56, flags=(1 << 17) | 2), self.key('flags', 10, code=56, flags=2)]):
            with self.subTest(events=events), self.assertRaises(self.error):
                self.validate(events)

    def test_modifier_flags_require_the_corresponding_owned_key(self):
        with self.assertRaises(self.error):
            self.validate([self.key('key_down', flags=1 << 17), self.key('key_up', 10)])
        with self.assertRaises(self.error):
            self.validate([self.key('key_down', code=56), self.key('key_up', 10, code=56)])

    def test_modified_drag_and_multiple_buttons_retain_balanced_ownership(self):
        self.validate([self.key('flags', code=56, flags=1 << 17), self.pointer('mouse_down', 10, flags=1 << 17),
            self.pointer('drag', 20, flags=1 << 17), self.pointer('mouse_up', 30, flags=1 << 17),
            self.key('flags', 40, code=56)])
        for events in ([self.pointer('drag')], [self.pointer('mouse_up')], [self.pointer('mouse_down')],
                       [self.pointer('mouse_down'), self.pointer('mouse_up', 10, button=1)]):
            with self.subTest(events=events), self.assertRaises(self.error):
                self.validate(events)

    def test_three_axis_scroll_and_momentum_preserve_complete_phases(self):
        self.validate([self.scroll(1), self.scroll(2, offset=10), self.scroll(4, offset=20),
                       self.scroll(momentum=1, offset=30), self.scroll(momentum=2, offset=40), self.scroll(momentum=3, offset=50)])
        self.validate([self.scroll(128), self.scroll(8, offset=10)])
        self.validate([self.scroll(1 | 2 | 4)])

    def test_mouse_touch_subtype_preserves_trackpad_gestures_and_refuses_tablets(self):
        self.validate([self.pointer('mouse_down', subtype=3), self.pointer('drag', 10, subtype=3),
                       self.pointer('mouse_up', 20, subtype=3)])
        self.validate([self.pointer('move', subtype=0)])
        for subtype in (1, 2, 4, -1, True, None, '3', 3.5):
            with self.subTest(subtype=subtype), self.assertRaises(self.error):
                self.validate([self.pointer('move', subtype=subtype)])

    def test_incomplete_scroll_and_missing_phase_prefix_are_rejected(self):
        for events in ([self.scroll(1)], [self.scroll(2), self.scroll(4, offset=10)], [self.scroll(4)],
                       [self.scroll(momentum=2), self.scroll(momentum=3, offset=10)],
                       [self.scroll(momentum=1)], [self.scroll(1), self.scroll(1, offset=10), self.scroll(4, offset=20)]):
            with self.subTest(events=events), self.assertRaises(self.error):
                self.validate(events)

    def test_bounds_include_left_top_and_exclude_right_bottom(self):
        bounds = {'x': -10, 'y': 30, 'width': 100, 'height': 50}
        self.validate([self.pointer('move')], bounds)
        for changes in ({'x': 90}, {'y': 80}, {'x': float('nan')}, {'y': True}):
            with self.subTest(changes=changes), self.assertRaises(self.error):
                self.validate([self.pointer('move', **changes)], bounds)

    def test_untrusted_fields_types_and_timestamps_reject_before_native_request(self):
        invalid = []
        for change in ({'at_us': True}, {'at_us': -1}, {'at_us': 1}, {'flags': True}, {'flags': 1 << 32},
                       {'keycode': 128}, {'keyboard_type': '91'}, {'repeat': True}, {'unicode': 1}, {'pid': 123}):
            invalid.append([{**self.events()[0], **change}, self.events()[1]])
        invalid += [[self.key('key_down'), self.key('key_up', 5000001)], self.events() * 257,
                    [self.scroll(continuous=1)], [self.scroll(fixed=[1, 2])]]
        with patch.object(self.tools, 'request') as native:
            for events in invalid:
                with self.subTest(events=events):
                    result = asyncio.run(self.tools.input_sequence(events, {'bounds': {'x': -10, 'y': 30, 'width': 100, 'height': 50}}, {}))
                    self.assertFalse(result['ok'])
                    self.assertEqual(result['code'], 'invalid_args')
        native.assert_not_called()

    def test_manual_recording_rebinds_every_pointer_point_without_mutating_document(self):
        target = {'ref': 'fresh', 'bounds': {'x': 40, 'y': 60, 'width': 100, 'height': 50}}
        recording = {'schema': 2, 'platform': 'darwin', 'coordinate_space': 'macos_global_points',
            'source': 'native_window_events', 'complete': True, 'end_reason': 'stopped',
            'application': {'executable': '/owned/Fixture', 'bundle_id': ''},
            'bounds': {'x': -10, 'y': 30, 'width': 100, 'height': 50},
            'input_source': {'id': 'com.apple.keylayout.ABC', 'type': 'TISTypeKeyboardLayout'},
            'actions': [{'op': 'input.sequence', 'at': 0, 'ended': 0, 'events': [self.pointer('move')]}]}
        before = copy.deepcopy(recording)
        with patch.object(self.recording, 'request', return_value={'target': target, 'application': recording['application']}):
            steps = self.recording.prepare_recording(recording, target)
        self.assertEqual(recording, before)
        self.assertEqual((steps[0]['args']['events'][0]['x'], steps[0]['args']['events'][0]['y']), (40, 60))
        self.assertEqual(steps[0]['args']['input_source'], recording['input_source'])

    def test_manual_idle_gaps_retain_duration_instead_of_using_controlled_request_cap(self):
        document = {'schema': 2, 'platform': 'darwin', 'coordinate_space': 'macos_global_points',
            'source': 'native_window_events', 'complete': True, 'end_reason': 'stopped',
            'application': {'executable': '/owned/Fixture', 'bundle_id': ''},
            'bounds': {'x': -10, 'y': 30, 'width': 100, 'height': 50},
            'input_source': {'id': 'com.apple.keylayout.ABC', 'type': 'TISTypeKeyboardLayout'},
            'actions': [{'op': 'input.sequence', 'at': at, 'ended': at + .1, 'events': self.events()} for at in (0, 8)]}
        target = {'bounds': document['bounds']}
        with patch.object(self.recording, 'request', return_value={'target': target, 'application': document['application']}):
            steps = self.recording.prepare_recording(document, target)
        self.assertAlmostEqual(steps[1]['args']['seconds'], 7.9)

    def test_async_cancellation_waits_for_the_request_worker_and_preserves_dispatch_state(self):
        entered, stopped = threading.Event(), threading.Event()

        def native(payload, cancel_event, cancel_lock):
            entered.set()
            if not cancel_event.wait(2):
                raise RuntimeError('Cancellation failed to signal its request worker')
            stopped.set()
            raise self.error('input_cancelled', 'Owned native cancellation', {'action_sent': True, 'outcome': 'unconfirmed'})

        async def cancel():
            task = asyncio.create_task(self.tools.input_sequence(self.events(), {}, {}))
            await asyncio.to_thread(entered.wait, 2)
            self.assertTrue(entered.is_set())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError) as caught:
                await task
            self.assertTrue(stopped.is_set())
            self.assertTrue(caught.exception.result['action_sent'])
            self.assertEqual(caught.exception.result['outcome'], 'unconfirmed')

        with patch.object(self.tools, 'request', side_effect=native):
            asyncio.run(cancel())

    def test_whole_document_preflight_rejects_a_bad_final_sequence(self):
        action = {'op': 'input.sequence', 'at': 0, 'ended': .1, 'events': self.events()}
        action['events'].append(self.key('key_up', 90000))
        document = {'schema': 2, 'platform': 'darwin', 'coordinate_space': 'macos_global_points',
            'source': 'native_window_events', 'complete': True, 'end_reason': 'stopped',
            'application': {'executable': '/owned/Fixture', 'bundle_id': ''},
            'bounds': {'x': -10, 'y': 30, 'width': 100, 'height': 50},
            'input_source': {'id': 'com.apple.keylayout.ABC', 'type': 'TISTypeKeyboardLayout'}, 'actions': [action]}
        with patch.object(self.recording, 'request') as native, self.assertRaises(self.error):
            self.recording.prepare_recording(document, {})
        native.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
