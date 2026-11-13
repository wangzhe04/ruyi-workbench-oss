"""Graph and isolated private-blob qualification; no MCP/native, state recovery or replay."""
import copy
import hashlib
import json
import os
import tempfile
from unittest.mock import patch
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from ai_computer_control.utils.execution_receipt_validation import validate_committed_receipts, read_validated_receipts
from ai_computer_control.utils.execution_arguments import arguments_digest
from ai_computer_control.utils import execution_journal as journal
from ai_computer_control.utils.execution_journal import ExecutionJournalError


def trace():
    root, tool, native, worker = (char * 32 for char in 'bcde')
    def row(stage, operation, **fields):
        return {'schema': 1, 'invocation_id': 'a'*32, 'operation_id': operation, 'sequence': 0,
                'stage': stage, 'acc_worker_id': worker, 'acc_pid': 100, 'at': '2026-11-11T12:00:00+00:00', **fields}
    def ref(operation, codec='python-json-sorted-utf8-v1'):
        return {'args_ref': 'args-'+operation+'.json', 'args_sha256': 'f'*64, 'args_bytes': 10, 'args_codec': codec}
    identity = {'parent_operation_id': tool, 'worker_id': '1'*32, 'frame_id': 2}
    rows = [row('acc_request_accepted', root, tool='get_mouse_position', session_id='s_fixture', turn_seq=1,
                call_id_hash='2'*64, caller_args_sha256='3'*64, caller_args_codec='javascript-json-utf8-v1',
                caller_semantic_sha256='4'*64, received_semantic_sha256='4'*64, args_semantic_codec='ruyi-sdk-json-v1', **ref(root)),
            row('tool_entered', tool, parent_operation_id=root, tool='get_mouse_position', **ref(tool)),
            row('native_prepared', native, **identity, worker_pid=101, op='mouse.position', frame_sha256='f'*64,
                helper_identity=['1','2','300','123456789'], **ref(native, 'exact-native-frame')),
            row('native_frame_sent', native, **identity),
            row('native_entered', native, **identity, worker_pid=101, op='mouse.position', frame_sha256='f'*64, challenge='5'*32),
            row('native_continue_intent', native, **identity, challenge='5'*32),
            row('native_continue_sent', native, **identity),
            row('native_terminal', native, **identity, ok=True),
            row('tool_terminal', tool, tool='get_mouse_position', ok=True),
            row('acc_request_terminal', root, ok=True)]
    for index, value in enumerate(rows, 1): value['sequence'] = index
    return {'schema': 1, 'invocation_id': 'a'*32, 'records': rows, 'incomplete': False,
            'request_terminal_observed': True}


def resequence(value):
    for index, row in enumerate(value['records'], 1): row['sequence'] = index
    return value


class ReceiptValidation(unittest.TestCase):
    def reject(self, value):
        with self.assertRaises(ExecutionJournalError): validate_committed_receipts(value)

    def test_full_causal_trace_and_unknown_prefixes(self):
        full = trace()
        self.assertFalse(validate_committed_receipts(full)['lifecycle_unknown'])
        for count in range(10):
            value = copy.deepcopy(full); value['records'] = value['records'][:count]
            result = validate_committed_receipts(value)
            self.assertFalse(result['request_terminal_observed'])
            self.assertTrue(result['lifecycle_unknown'])
        full['incomplete'] = True
        self.assertTrue(validate_committed_receipts(full)['lifecycle_unknown'])

    def test_accepted_trace_is_bound_to_all_host_preparation_fields(self):
        expected = {'invocation_id': 'a'*32, 'tool_name': 'get_mouse_position', 'session_id': 's_fixture',
                    'turn_seq': 1, 'call_id_hash': '2'*64, 'args_sha256': '3'*64,
                    'args_codec': 'javascript-json-utf8-v1', 'args_semantic_sha256': '4'*64,
                    'args_semantic_codec': 'ruyi-sdk-json-v1'}
        self.assertFalse(validate_committed_receipts(trace(), expected=expected)['lifecycle_unknown'])
        for field in expected:
            altered = dict(expected); altered[field] = 'mismatch'
            with self.subTest(field=field), self.assertRaises(ExecutionJournalError):
                validate_committed_receipts(trace(), expected=altered)

    def test_strict_types_fields_and_snapshot_references(self):
        changes = [(0, 'turn_seq', True), (0, 'received_semantic_sha256', '0'*64), (0, 'args_bytes', -1),
                   (0, 'args_ref', '../outside'), (0, 'args_codec', 'other'), (0, 'unexpected', True),
                   (0, 'at', '2026-11-11T12:00:00'), (0, 'acc_pid', True), (0, 'session_id', '../'),
                   (1, 'batch_step', True), (1, 'tool', []), (2, 'worker_pid', 0), (2, 'helper_identity', ['1']),
                   (2, 'frame_sha256', '0'*64), (4, 'challenge', 'bad'), (7, 'ok', 1), (8, 'confirmed', 1),
                   (8, 'outcome', 'success'), (9, 'stage', []), (9, 'schema', True)]
        for index, key, altered in changes:
            value = trace(); value['records'][index][key] = altered
            with self.subTest(index=index, key=key): self.reject(value)

    def test_missing_required_fields_are_not_defaulted(self):
        for index in range(10):
            for key in list(trace()['records'][index]):
                value = trace(); del value['records'][index][key]
                if index == 8 and key == 'ok':
                    self.assertTrue(validate_committed_receipts(value)['lifecycle_unknown']); continue
                with self.subTest(index=index, key=key): self.reject(value)

    def test_cross_incarnation_and_moved_native_identities(self):
        for index, field, value in [(4,'worker_id','6'*32), (4,'worker_pid',102), (4,'frame_id',3),
                                    (4,'frame_sha256','6'*64), (4,'op','mouse.move'), (5,'challenge','6'*32),
                                    (7,'parent_operation_id','6'*32), (8,'acc_worker_id','6'*32), (8,'acc_pid',102)]:
            candidate=trace(); candidate['records'][index][field]=value
            with self.subTest(index=index, field=field): self.reject(candidate)

    def test_out_of_order_missing_and_duplicate_stages(self):
        for index in (0,1,2,3,4,5,6):
            value=trace(); del value['records'][index]; self.reject(resequence(value))
        for index in range(10):
            value=trace(); value['records'].insert(index, copy.deepcopy(value['records'][index]))
            self.reject(resequence(value))
        value=trace(); value['records'][4],value['records'][5]=value['records'][5],value['records'][4]
        self.reject(resequence(value))

    def test_explicit_handshake_refusal_is_valid_without_continue_but_success_is_not(self):
        value=trace(); value['records']=[row for row in value['records'] if row['stage'] not in ('native_continue_intent','native_continue_sent')]
        terminal=next(row for row in value['records'] if row['stage']=='native_terminal')
        self.reject(resequence(value))
        terminal.update(ok=False, outcome='not_dispatched', action_sent=False, acted=False)
        self.assertFalse(validate_committed_receipts(resequence(value))['lifecycle_unknown'])
        for field in ('outcome','action_sent','acted'):
            changed=copy.deepcopy(value); del next(row for row in changed['records'] if row['stage']=='native_terminal')[field]
            self.reject(changed)

    def test_sdk_transport_return_does_not_mean_tool_success_or_resolved_native_effects(self):
        value=trace(); value['records'][-2]['ok']=False
        result=validate_committed_receipts(value)
        self.assertTrue(result['request_transport_returned'])
        value['records'][-2]['outcome']='unknown'
        result=validate_committed_receipts(value)
        self.assertFalse(result['lifecycle_unknown'])
        self.assertEqual(result['reported_unknown_operation_ids'], ['c'*32])
        self.assertEqual(result['terminal_flags']['c'*32]['flags']['outcome'], 'unknown')
        value=trace(); value['records']=[row for row in value['records'] if row['stage']!='native_terminal']
        self.assertTrue(validate_committed_receipts(resequence(value))['lifecycle_unknown'])
        value=trace(); del value['records'][-2]['ok']
        self.assertTrue(validate_committed_receipts(value)['lifecycle_unknown'])

    def test_returned_sdk_without_top_level_tool_is_incomplete(self):
        value=trace(); value['records']=[value['records'][0],value['records'][-1]]
        result=validate_committed_receipts(resequence(value))
        self.assertTrue(result['request_terminal_observed'])
        self.assertFalse(result['top_level_tool_observed'])
        self.assertTrue(result['lifecycle_unknown'])
        value['records'][-1].update(ok=False,outcome='not_dispatched')
        self.assertFalse(validate_committed_receipts(value)['lifecycle_unknown'])
        del value['records'][-1]['outcome']
        self.assertTrue(validate_committed_receipts(value)['lifecycle_unknown'])

    def test_descendant_facts_cannot_follow_any_ancestor_terminal(self):
        base=trace()
        # Insert a real outer wrapper between SDK acceptance and the original tool wrapper.
        outer=copy.deepcopy(base['records'][1]); outer['operation_id']='9'*32
        outer['args_ref']='args-'+('9'*32)+'.json'
        base['records'][1]['parent_operation_id']='9'*32
        base['records'].insert(1,outer)
        for child_stage in ('native_prepared','native_entered','native_continue_intent','native_terminal','tool_terminal'):
            value=copy.deepcopy(base)
            close={key:val for key,val in outer.items() if not key.startswith('args_') and key!='parent_operation_id'}
            close.update(stage='tool_terminal',ok=True)
            index=next(i for i,row in enumerate(value['records']) if row['stage']==child_stage)
            value['records'].insert(index,close)
            with self.subTest(stage=child_stage): self.reject(resequence(value))

    def test_root_nondispatch_cannot_follow_any_actual_tool_wrapper(self):
        value=trace(); value['records'][-1].update(ok=False,outcome='not_dispatched')
        self.reject(value)
        # Even a wrapper with an explicitly refused native action was entered.
        value['records'][7].update(ok=False,outcome='not_dispatched',action_sent=False,acted=False)
        self.reject(value)

    def test_native_receipts_cannot_follow_parent_terminal(self):
        value=trace(); row=value['records'].pop(-2); value['records'].insert(6,row)
        self.reject(resequence(value))

    def test_parent_kind_top_level_wrapper_and_frame_reuse_are_checked(self):
        value=trace(); value['records'][2]['parent_operation_id']='b'*32; self.reject(value)
        value=trace(); value['records'][1]['tool']='other'; self.reject(value)
        value=trace(); duplicate=copy.deepcopy(value['records'][2]); duplicate['operation_id']='7'*32
        duplicate['args_ref']='args-'+('7'*32)+'.json'; value['records'].insert(3,duplicate)
        self.reject(resequence(value))


@unittest.skipUnless(sys.platform in ('darwin', 'linux'), 'POSIX private-blob reader')
class PrivateBlobValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ruyi-receipt-validation-')
        self.root = Path(self.tmp.name)
        env = {key: str(self.root/key) for key in ('HOME','USERPROFILE','APPDATA','LOCALAPPDATA')}
        env['WCW_DATA_DIR'] = str(self.root/'data')
        self.env = patch.dict(os.environ, env); self.env.start()
        self.writer = journal.ReceiptJournal('a'*32)
        self.addCleanup(self.writer.close); self.addCleanup(self.env.stop); self.addCleanup(self.tmp.cleanup)
        self.base = self.root/'data/logs/execution-receipts'/('a'*32)

    def populate(self, *, bad_semantic=False, bad_native=False, feature=None):
        value = trace()
        if feature:
            row=copy.deepcopy(value['records'][2]); row['operation_id']='8'*32; row['stage']='native_features'
            row.update(frame_id=1, receipt_version=1)
            for key in ('worker_id','op','frame_sha256','helper_identity'): del row[key]
            row['args_ref']='args-'+row['operation_id']+'.json'
            value['records'].insert(2,row)
        args = {'text': 'private-你好', 'probe': 1000000000000000100}
        digest = arguments_digest(args)
        native_digest = None
        for row in value['records']:
            fields = {key: val for key,val in row.items() if key not in
                ('schema','invocation_id','operation_id','sequence','stage','acc_worker_id','acc_pid','at')}
            operation = row['operation_id']
            if row['stage'] == 'acc_request_accepted':
                fields.update(self.writer.snapshot(operation,args))
                fields.update(caller_semantic_sha256='0'*64 if bad_semantic else digest,
                              received_semantic_sha256='0'*64 if bad_semantic else digest)
            elif row['stage'] == 'tool_entered':
                fields.update(self.writer.snapshot(operation, {}))
            elif row['stage'] == 'native_features':
                frame={'id':1,'version':1,'op':'session.features'}
                if feature == 'extra': frame['unused']=True
                fields.update(self.writer.snapshot(operation,json.dumps(frame).encode(),raw=True))
            elif row['stage'] == 'native_prepared':
                actual={'id':2,'version':1,'op':'mouse.move' if bad_native is True else 'mouse.position',
                    '_ruyi_receipt':{'schema':1,'invocation_id':'a'*32,'operation_id':operation,'worker_id':'1'*32}}
                if bad_native == 'reserved_receipt': actual['receipt']=None
                frame=json.dumps(actual,separators=(',',':')).encode()
                if bad_native == 'raw_lf': frame=b'\n'+frame
                if bad_native == 'oversize': frame+=b' '*(65537-len(frame))
                fields.update(self.writer.snapshot(operation,frame,raw=True))
                native_digest=hashlib.sha256(frame).hexdigest(); fields['frame_sha256']=native_digest
            elif row['stage'] == 'native_entered':
                fields['frame_sha256']=native_digest
            self.writer.append(row['stage'],operation,**fields)

    def test_complete_private_blobs_validate_without_exposing_contents(self):
        self.populate()
        result=read_validated_receipts('a'*32)
        self.assertFalse(result['semantic_validation']['lifecycle_unknown'])
        self.assertNotIn('private-你好',json.dumps(result,ensure_ascii=False))
        missing=read_validated_receipts('f'*32)
        self.assertTrue(missing['semantic_validation']['lifecycle_unknown'])

    def test_blob_missing_or_corrupted_never_invents_a_terminal(self):
        self.populate(); file=self.base/('args-'+('b'*32)+'.json')
        original=file.read_bytes(); file.write_bytes(b'x'*len(original))
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)
        file.unlink()
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)

    def test_leaf_symlink_fifo_and_hardlink_are_refused(self):
        self.populate(); file=self.base/('args-'+('b'*32)+'.json')
        external=self.root/'external'; file.rename(external)
        file.symlink_to(external)
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)
        file.unlink(); os.mkfifo(file)
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)
        file.unlink(); os.link(external,file)
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)
        self.assertTrue(external.read_bytes())

    def test_declared_matching_semantic_hash_cannot_replace_actual_blob_comparison(self):
        self.populate(bad_semantic=True)
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)

    def test_matching_frame_digest_cannot_replace_actual_native_identity_comparison(self):
        self.populate(bad_native=True)
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)

    def test_exact_feature_request_is_validated_without_claiming_a_native_body_entry(self):
        self.populate(feature='valid')
        result=read_validated_receipts('a'*32)['semantic_validation']
        self.assertFalse(result['lifecycle_unknown'])
        self.assertNotIn('8'*32,result['terminal_flags'])

    def test_noncanonical_feature_envelope_is_refused_even_with_matching_hash(self):
        self.populate(feature='extra')
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)

    def test_reserved_receipt_key_is_not_a_valid_native_request_even_with_matching_hash(self):
        self.populate(bad_native='reserved_receipt')
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)

    def test_raw_newline_is_not_one_native_frame_even_with_matching_hash(self):
        self.populate(bad_native='raw_lf')
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)

    def test_oversize_raw_request_is_not_a_native_frame_even_with_matching_hash(self):
        self.populate(bad_native='oversize')
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)

    def test_changed_blob_extent_and_stale_frame_snapshot_are_refused(self):
        self.populate(); file=self.base/('args-'+('d'*32)+'.json')
        file.write_bytes(file.read_bytes()+b' ')
        with self.assertRaises(ExecutionJournalError): read_validated_receipts('a'*32)


if __name__ == '__main__': unittest.main()
