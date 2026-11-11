"""Offline Python invocation-boundary contracts. No desktop access or native dispatch claim."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class BatchInvocation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='ruyi-batch-invocation-')
        root = Path(cls.directory.name)
        cls.env = patch.dict(os.environ, {'HOME': str(root / 'home'), 'USERPROFILE': str(root / 'home'),
            'LOCALAPPDATA': str(root / 'local'), 'APPDATA': str(root / 'roaming'), 'WCW_DATA_DIR': str(root / 'data'),
            'ACC_TOOLSETS': 'macro', 'ACC_HIDE_TOOLS': ''})
        cls.env.start()
        from ai_computer_control.tools import batch
        cls.batch = batch

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.directory.cleanup()

    def run_steps(self, actions, tools, on_error='continue'):
        with patch.object(self.batch, '_tool_map', return_value=tools):
            return asyncio.run(self.batch._run_batch(actions, on_error, 0))

    def test_prevalidation_is_explicitly_not_attempted(self):
        result = self.run_steps([{'tool': 'click', 'args': ['bad']}, {'tool': 'missing'}], {})
        self.assertEqual(result['step_invocation_schema'], 1)
        self.assertEqual([row['invocation_attempted'] for row in result['results']], [False, False])
        self.assertTrue(all('result' not in row for row in result['results']))

    def test_success_and_exception_both_cross_python_attempt_boundary(self):
        def good():
            return {'ok': True, 'action_sent': True}
        def bad():
            raise RuntimeError('synthetic effect status unknown')
        tools = {'good': SimpleNamespace(fn=good, is_async=False), 'bad': SimpleNamespace(fn=bad, is_async=False)}
        result = self.run_steps([{'tool': 'good'}, {'tool': 'bad'}], tools)
        self.assertEqual([row['invocation_attempted'] for row in result['results']], [True, True])
        self.assertTrue(result['results'][0]['result']['action_sent'])
        self.assertNotIn('result', result['results'][1])
        self.assertEqual((result['completed'], result['failed']), (1, 1))

    def test_stop_keeps_only_returned_prefix(self):
        calls = []
        def good():
            calls.append('good')
            return {'ok': True}
        tools = {'good': SimpleNamespace(fn=good, is_async=False)}
        result = self.run_steps([{'tool': 'good'}, {'tool': 'missing'}, {'tool': 'good'}], tools, 'stop')
        self.assertEqual(calls, ['good'])
        self.assertEqual([row['step'] for row in result['results']], [0, 1])
        self.assertEqual([row['invocation_attempted'] for row in result['results']], [True, False])

    def test_outer_validation_rejects_before_any_invocation(self):
        for actions, mode in [([{}] * 201, 'stop'), ([], 'typo')]:
            result = self.run_steps(actions, {}, mode)
            self.assertFalse(result['invocation_attempted'])
            self.assertEqual(result['step_invocation_schema'], 1)

    def test_cancellation_before_invoke_does_not_enter_function_or_return_fabricated_prefix(self):
        calls = []
        async def cancelled_sleep(_):
            raise asyncio.CancelledError()
        tools = {'input': SimpleNamespace(fn=lambda: calls.append('called'), is_async=False)}
        with patch.object(self.batch, '_tool_map', return_value=tools), patch.object(self.batch.asyncio, 'sleep', cancelled_sleep):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.batch._run_batch([{'tool': 'input'}], 'stop', 0))
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
