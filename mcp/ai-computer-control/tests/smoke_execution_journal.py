"""Strict storage primitive qualification; no MCP dispatch, native operations, or replay."""
import contextvars
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from ai_computer_control.utils import execution_journal as journal


@unittest.skipUnless(sys.platform == 'darwin' or sys.platform == 'linux', 'POSIX descriptor journal primitive')
class ExecutionJournalContracts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='ruyi-execution-journal-')
        self.root = Path(self.directory.name)
        self.env = patch.dict(os.environ, {'HOME': str(self.root/'h'), 'USERPROFILE': str(self.root/'h'),
            'APPDATA': str(self.root/'a'), 'LOCALAPPDATA': str(self.root/'l'), 'WCW_DATA_DIR': str(self.root/'data')})
        self.env.start()
        self.trace = journal.ReceiptJournal('a' * 32)
        self.addCleanup(self.trace.close)
        self.addCleanup(self.env.stop)
        self.addCleanup(self.directory.cleanup)

    def base(self):
        return self.root/'data/logs/execution-receipts'/('a'*32)

    def test_actual_arguments_are_exact_private_blobs_not_summary_text(self):
        value = {'target': {'bounds': {'x': -12, 'width': 480}}, 'text': '你好', 'secret': 'private-source'}
        ref = self.trace.snapshot('b'*32, value)
        blob = (self.base()/ref['args_ref']).read_bytes()
        self.assertEqual(json.loads(blob), value)
        self.assertEqual(hashlib.sha256(blob).hexdigest(), ref['args_sha256'])
        self.trace.append('tool_entered', 'b'*32, **ref, tool='input_sequence')
        records = journal.read_receipts('a'*32)
        self.assertFalse(records['incomplete'])
        self.assertNotIn('private-source', json.dumps(records))
        self.assertEqual((self.base()/ref['args_ref']).stat().st_mode & 0o777, 0o600)

    def test_complete_trace_survives_writer_close(self):
        self.trace.append('acc_request_accepted', 'b'*32, tool='macro_run')
        self.trace.append('acc_request_terminal', 'b'*32, ok=True)
        self.trace.close()
        value = journal.read_receipts('a'*32)
        self.assertEqual([row['sequence'] for row in value['records']], [1, 2])
        self.assertTrue(value['request_terminal_observed'])
        self.assertFalse(value['incomplete'])

    def test_short_writes_are_completed_before_commit(self):
        original = os.write
        with patch.object(journal.os, 'write', side_effect=lambda fd, data: original(fd, data[:7])):
            self.trace.append('tool_entered', 'b'*32, tool='mouse_click')
        self.assertEqual(len(journal.read_receipts('a'*32)['records']), 1)

    def test_failed_data_fsync_never_publishes_apparent_terminal(self):
        self.trace.append('tool_entered', 'b'*32)
        before = json.loads((self.base()/'commit.json').read_text())
        with patch.object(journal.os, 'fsync', side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(journal.ExecutionJournalError):
                self.trace.append('acc_request_terminal', 'b'*32, ok=True)
        self.assertEqual(json.loads((self.base()/'commit.json').read_text()), before)
        value = journal.read_receipts('a'*32)
        self.assertEqual(len(value['records']), 1)
        self.assertFalse(value['request_terminal_observed'])
        self.assertTrue(value['incomplete'])
        with self.assertRaises(journal.ExecutionJournalError):
            self.trace.append('tool_terminal', 'b'*32)

    def test_failed_marker_rename_does_not_advance_committed_prefix(self):
        self.trace.append('tool_entered', 'b'*32)
        with patch.object(journal.os, 'replace', side_effect=OSError('synthetic rename failure')):
            with self.assertRaises(journal.ExecutionJournalError):
                self.trace.append('acc_request_terminal', 'b'*32, ok=True)
        value = journal.read_receipts('a'*32)
        self.assertEqual(len(value['records']), 1)
        self.assertFalse(value['request_terminal_observed'])
        self.assertTrue(value['incomplete'])

    def test_partial_uncommitted_last_line_is_not_a_terminal(self):
        self.trace.append('tool_entered', 'b'*32)
        with (self.base()/'events.ndjson').open('ab') as f:
            f.write(b'{"stage":"acc_request_terminal"')
        value = journal.read_receipts('a'*32)
        self.assertTrue(value['incomplete']); self.assertEqual(len(value['records']), 1)
        self.assertFalse(value['request_terminal_observed'])

    def test_corrupt_committed_prefix_is_not_guessed(self):
        self.trace.append('tool_entered', 'b'*32)
        data = (self.base()/'events.ndjson').read_bytes()
        (self.base()/'events.ndjson').write_bytes(data.replace(b'tool_entered', b'tool_altered'))
        with self.assertRaises(journal.ExecutionJournalError):
            journal.read_receipts('a'*32)

    def test_duplicate_or_path_identity_cannot_replace_old_evidence(self):
        self.trace.append('tool_entered', 'b'*32)
        before = (self.base()/'events.ndjson').read_bytes()
        with self.assertRaises(journal.ExecutionJournalError):
            journal.ReceiptJournal('a'*32)
        with self.assertRaises(journal.ExecutionJournalError):
            journal.ReceiptJournal('../outside')
        self.assertEqual((self.base()/'events.ndjson').read_bytes(), before)

    def test_symlink_trace_and_blob_are_refused(self):
        external = self.root/'untouched'; external.write_text('preserve')
        base = self.base().parent
        (base/('c'*32)).symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(journal.ExecutionJournalError):
            journal.read_receipts('c'*32)
        (self.base()/('args-'+('b'*32)+'.json')).symlink_to(external)
        with self.assertRaises(journal.ExecutionJournalError):
            self.trace.snapshot('b'*32, {'text': 'changed'})
        self.assertEqual(external.read_text(), 'preserve')

    def test_capacity_refuses_without_erasing_unknown(self):
        self.trace.append('tool_entered', 'b'*32)
        before = (self.base()/'events.ndjson').read_bytes()
        with patch.object(journal, 'MAX_TRACES', 1):
            with self.assertRaises(journal.ExecutionJournalError):
                journal.ReceiptJournal('c'*32)
        with patch.object(journal, 'MAX_TRACE_BYTES', 1):
            with self.assertRaises(journal.ExecutionJournalError):
                self.trace.append('tool_terminal', 'b'*32)
        self.assertEqual((self.base()/'events.ndjson').read_bytes(), before)

    def test_threads_share_a_serial_sequence_and_context_resets(self):
        errors = []
        def run():
            try:
                for _ in range(5): self.trace.append('native_prepared', 'b'*32)
            except Exception as error:
                errors.append(error)
        threads = [threading.Thread(target=run) for _ in range(3)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertFalse(errors)
        self.assertEqual([row['sequence'] for row in journal.read_receipts('a'*32)['records']], list(range(1, 16)))
        self.assertIsNone(journal.current_operation())
        captured = []
        with journal.batch_step(2), journal.operation_scope(self.trace, 'b'*32):
            context = contextvars.copy_context()
            worker = threading.Thread(target=context.run, args=(lambda: captured.append(journal.current_operation()),))
            worker.start(); worker.join()
        self.assertIsNone(journal.current_operation())
        self.assertEqual(captured[0]['batch_step'], 2)
        self.assertEqual(captured[0]['operation_id'], 'b'*32)

    def test_directory_fsync_failure_after_marker_rename_keeps_previous_prefix(self):
        self.trace.append('tool_entered', 'b'*32)
        original = os.fsync
        calls = []
        def failing(fd):
            if fd == self.trace.directory_fd:
                calls.append(fd)
                if len(calls) == 2:
                    raise OSError('synthetic post-rename directory fsync failure')
            return original(fd)
        with patch.object(journal.os, 'fsync', side_effect=failing):
            with self.assertRaises(journal.ExecutionJournalError):
                self.trace.append('acc_request_terminal', 'b'*32, ok=True)
        self.assertEqual(json.loads((self.base()/'commit.json').read_text())['sequence'], 2)
        self.assertTrue((self.base()/'pending.json').exists())
        value = journal.read_receipts('a'*32)
        self.assertEqual(len(value['records']), 1)
        self.assertFalse(value['request_terminal_observed']); self.assertTrue(value['incomplete'])

    def test_fifo_names_are_refused_before_any_blocking_open(self):
        self.trace.close()
        parent = self.base().parent
        (parent/'.allocation.lock').unlink(); os.mkfifo(parent/'.allocation.lock')
        with self.assertRaises(journal.ExecutionJournalError):
            journal.ReceiptJournal('c'*32)
        for name in ['events.ndjson', 'commit.json']:
            file = self.base()/name
            original = file.read_bytes()
            file.unlink(); os.mkfifo(file)
            with self.assertRaises(journal.ExecutionJournalError):
                journal.read_receipts('a'*32)
            file.unlink(); file.write_bytes(original)

    def test_reader_waits_for_a_coherent_concurrent_commit(self):
        self.trace.append('tool_entered', 'b'*32)
        original = os.fsync
        writing, release, reading, finished = (threading.Event() for _ in range(4))
        errors, values = [], []
        def pause(fd):
            if fd == self.trace.fd:
                writing.set()
                if not release.wait(1.): raise OSError('test release timeout')
            return original(fd)
        def writer():
            try: self.trace.append('acc_request_terminal', 'b'*32, ok=True)
            except Exception as error: errors.append(error)
        def reader():
            reading.set()
            try: values.append(journal.read_receipts('a'*32))
            except Exception as error: errors.append(error)
            finally: finished.set()
        with patch.object(journal.os, 'fsync', side_effect=pause):
            a = threading.Thread(target=writer); a.start()
            self.assertTrue(writing.wait(1.))
            b = threading.Thread(target=reader); b.start()
            self.assertTrue(reading.wait(1.)); self.assertFalse(finished.wait(.02))
            release.set(); a.join(2.); b.join(2.)
        self.assertFalse(errors)
        self.assertEqual(len(values[0]['records']), 2)
        self.assertTrue(values[0]['request_terminal_observed']); self.assertFalse(values[0]['incomplete'])

    def test_duplicate_terminal_keys_in_hash_matching_prefix_are_not_a_terminal(self):
        self.trace.append('acc_request_accepted', 'b'*32, tool='wait')
        self.trace.append('acc_request_terminal', 'b'*32, ok=True)
        file=self.base()/'events.ndjson'; data=file.read_bytes().replace(b'"ok":true',b'"ok":false,"ok":true')
        file.write_bytes(data)
        marker={'schema':1,'sequence':2,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        (self.base()/'commit.json').write_text(json.dumps(marker))
        result=journal.read_receipts('a'*32)
        self.assertTrue(result['incomplete']); self.assertFalse(result['request_terminal_observed'])
        self.assertEqual(len(result['records']),1)

    def test_duplicate_marker_keys_and_nonfinite_json_are_refused(self):
        marker=self.base()/'commit.json'
        marker.write_bytes(marker.read_bytes().replace(b'"schema":1',b'"schema":0,"schema":1'))
        with self.assertRaises(journal.ExecutionJournalError): journal.read_receipts('a'*32)
        for text in ('{"value":NaN}','{"value":Infinity}','{"value":1e999}'):
            with self.assertRaises(ValueError): journal._strict_json(text)

    def test_closed_writer_has_a_structured_refusal(self):
        self.trace.close()
        with self.assertRaises(journal.ExecutionJournalError):
            self.trace.append('tool_entered', 'b'*32)

    def test_raw_snapshot_requires_bytes_and_missing_receipts_stay_unknown(self):
        with self.assertRaises(journal.ExecutionJournalError):
            self.trace.snapshot('b'*32, {'not': 'raw'}, raw=True)
        missing = journal.read_receipts('f'*32)
        self.assertTrue(missing['incomplete']); self.assertFalse(missing['request_terminal_observed'])
        self.assertEqual(missing['records'], [])


if __name__ == '__main__':
    unittest.main()
