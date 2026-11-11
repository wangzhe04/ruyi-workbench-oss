"""Pure receipt parser qualification. Synthetic protocol bytes; no helper or desktop access."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from ai_computer_control.utils.macos import DesktopError
from ai_computer_control.utils.macos_receipts import ReceiptDecoder, validate_features


class NativeReceiptParser(unittest.TestCase):
    def setUp(self):
        self.frame = b'{"id":2,"version":1,"op":"window.list"}'
        self.args = dict(invocation_id='a' * 32, operation_id='b' * 32, worker_id='c' * 32,
                         worker_pid=123, frame_id=2, op='window.list')
        self.decoder = ReceiptDecoder(self.frame, **self.args)
        self.receipt = {**self.decoder.expected, 'phase': 'handler_entered', 'challenge': 'd' * 32}
        self.entered = {'id': 2, 'receipt': self.receipt}
        self.terminal = {'id': 2, 'receipt': {**self.receipt, 'phase': 'terminal'}, 'ok': True, 'protocolVersion': 1}

    def encoded(self, result):
        return json.dumps(result, separators=(',', ':')).encode() + b'\n'

    def ready(self):
        self.decoder.feed(self.encoded(self.entered))
        self.decoder.mark_entry_persisted()
        self.decoder.mark_continue_sent()

    def test_fragmented_entry_and_terminal(self):
        data = self.encoded(self.entered)
        for byte in data[:-1]:
            self.assertEqual(self.decoder.feed(bytes([byte])), [])
        self.assertEqual(self.decoder.feed(data[-1:])[0][0], 'handler_entered')
        with self.assertRaises(DesktopError):
            self.decoder.continuation()
        self.decoder.mark_entry_persisted()
        continuation = json.loads(self.decoder.continuation())
        self.assertEqual(continuation['receipt']['phase'], 'continue')
        self.decoder.mark_continue_sent()
        self.assertEqual(self.decoder.feed(self.encoded(self.terminal))[0][0], 'terminal')
        self.assertTrue(self.decoder.finish()['ok'])

    def test_digest_uses_exact_received_request_bytes(self):
        self.assertEqual(self.receipt['frame_sha256'], hashlib.sha256(self.frame).hexdigest())
        changed = ReceiptDecoder(b'{ "id":2,"version":1,"op":"window.list"}', **self.args)
        with self.assertRaises(DesktopError):
            changed.feed(self.encoded(self.entered))

    def test_all_binding_fields_and_boolean_identity_are_checked(self):
        for key, value in [('invocation_id', 'f' * 32), ('operation_id', 'f' * 32), ('worker_id', 'f' * 32),
                           ('worker_pid', 456), ('frame_id', 3), ('op', 'mouse.move'), ('frame_sha256', '0' * 64), ('schema', True)]:
            with self.subTest(key=key):
                decoder = ReceiptDecoder(self.frame, **self.args)
                wrong = copy.deepcopy(self.entered)
                wrong['receipt'][key] = value
                with self.assertRaises(DesktopError):
                    decoder.feed(self.encoded(wrong))

    def test_duplicate_entry_is_rejected(self):
        self.decoder.feed(self.encoded(self.entered))
        with self.assertRaises(DesktopError):
            self.decoder.feed(self.encoded(self.entered))

    def test_terminal_before_entry_or_continue_is_rejected(self):
        with self.assertRaises(DesktopError):
            self.decoder.feed(self.encoded(self.terminal))
        decoder = ReceiptDecoder(self.frame, **self.args)
        with self.assertRaises(DesktopError):
            decoder.feed(self.encoded(self.entered) + self.encoded(self.terminal))

    def test_combined_entry_and_explicit_handshake_refusal_is_not_success(self):
        refusal = {**self.terminal, 'ok': False, 'acted': False, 'action_sent': False, 'outcome': 'not_dispatched'}
        events = self.decoder.feed(self.encoded(self.entered) + self.encoded(refusal))
        self.assertEqual([row[0] for row in events], ['handler_entered', 'terminal'])
        self.assertFalse(self.decoder.finish()['ok'])
        with self.assertRaises(DesktopError):
            self.decoder.continuation()

    def test_wrong_challenge_and_unknown_fields_are_rejected(self):
        self.ready()
        wrong = copy.deepcopy(self.terminal)
        wrong['receipt']['challenge'] = 'f' * 32
        with self.assertRaises(DesktopError):
            self.decoder.feed(self.encoded(wrong))
        decoder = ReceiptDecoder(self.frame, **self.args)
        wrong = copy.deepcopy(self.entered)
        wrong['receipt']['extra'] = 'not allowed'
        with self.assertRaises(DesktopError):
            decoder.feed(self.encoded(wrong))

    def test_trailing_data_or_duplicate_terminal_is_rejected(self):
        self.ready()
        with self.assertRaises(DesktopError):
            self.decoder.feed(self.encoded(self.terminal) + b'junk')
        decoder = ReceiptDecoder(self.frame, **self.args)
        decoder.feed(self.encoded(self.entered))
        decoder.mark_entry_persisted(); decoder.mark_continue_sent()
        decoder.feed(self.encoded(self.terminal))
        with self.assertRaises(DesktopError):
            decoder.feed(self.encoded(self.terminal))

    def test_incomplete_line_or_eof_cannot_create_a_terminal(self):
        self.decoder.feed(self.encoded(self.entered)[:-1])
        with self.assertRaises(DesktopError):
            self.decoder.finish()

    def test_only_exact_legacy_unsupported_is_a_negative_feature(self):
        self.assertIsNone(validate_features({'ok': False, 'code': 'invalid_args', 'error': 'Unsupported desktop operation'}, 123))
        for value in [{'ok': False, 'code': 'permission_denied'}, {'ok': False, 'code': 'session_locked'}, {}, None,
                      {'ok': True, 'protocolVersion': 1, 'executionReceiptVersion': True, 'worker_pid': 123, 'worker_id': 'c' * 32}]:
            with self.assertRaises(DesktopError):
                validate_features(value, 123)

    def test_feature_identity_is_per_worker(self):
        value = {'ok': True, 'protocolVersion': 1, 'executionReceiptVersion': 1, 'worker_pid': 123, 'worker_id': 'c' * 32}
        self.assertEqual(validate_features(value, 123)['worker_id'], 'c' * 32)
        with self.assertRaises(DesktopError):
            validate_features(value, 124)

    def test_success_terminal_requires_strict_protocol_version(self):
        for version in [None, 2, True]:
            decoder = ReceiptDecoder(self.frame, **self.args)
            decoder.feed(self.encoded(self.entered)); decoder.mark_entry_persisted(); decoder.mark_continue_sent()
            wrong = {**self.terminal, 'protocolVersion': version}
            with self.assertRaises(DesktopError):
                decoder.feed(self.encoded(wrong))

    def test_unconsumed_output_prevents_continue(self):
        self.decoder.feed(self.encoded(self.entered) + b'junk')
        self.decoder.mark_entry_persisted()
        with self.assertRaises(DesktopError):
            self.decoder.continuation()
        with self.assertRaises(DesktopError):
            self.decoder.mark_continue_sent()

    def test_nonfinite_or_invalid_json_is_rejected(self):
        for data in [b'{"id":NaN}\n', b'{"id":1e999}\n', b'{"id":2,"id":2}\n', b'\xff\n', b'[]\n']:
            with self.assertRaises(DesktopError):
                ReceiptDecoder(self.frame, **self.args).feed(data)


if __name__ == '__main__':
    unittest.main()
