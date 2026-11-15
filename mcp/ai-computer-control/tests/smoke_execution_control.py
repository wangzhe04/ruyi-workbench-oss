"""Fixed receipt-readiness control with mocked native status. No native processes or input."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from ai_computer_control.utils import macos
# Avoid native readiness during platform registry import. Actual SDK/native qualification is separate.
with patch.object(macos, 'capability', return_value={}):
    from ai_computer_control.tools import diagnostics, audit
from ai_computer_control.utils import execution_context


class ExecutionControl(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ruyi-control-'); self.addCleanup(self.tmp.cleanup)
        env = {key: self.tmp.name for key in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'WCW_DATA_DIR')}
        env['RUYI_EXECUTION_CONTEXT_REQUIRED'] = '1'
        scope = patch.dict(os.environ, env); scope.start(); self.addCleanup(scope.stop)

    def test_fixed_control_skips_registered_monitor_dpi_and_browser_dispatch(self):
        with patch.object(macos, 'capability', return_value={'installed': True, 'ready': True}) as status, \
             patch.object(diagnostics, '_monitors_summary', side_effect=AssertionError('monitor tool called')) as monitors, \
             patch.object(diagnostics, '_dpi_summary', side_effect=AssertionError('dpi tool called')) as dpi:
            result = diagnostics.execution_readiness_snapshot()
            self.assertTrue(result['ok']); self.assertIsNone(result['monitors']['count'])
            if sys.platform == 'darwin': status.assert_called_once_with()
            else: status.assert_not_called()
            monitors.assert_not_called(); dpi.assert_not_called()

    @unittest.skipUnless(sys.platform == 'darwin', 'Mac exact native status control')
    def test_control_uses_only_existing_exact_status_exception(self):
        status = {'monitors': [], 'coordinate_space': 'macos_global_points', 'locked': False}
        with patch.object(macos, 'helper_path', return_value='/not-launched'), patch.object(macos, '_identity', return_value={}), \
             patch.object(macos, 'request', return_value=status) as request:
            result = diagnostics.execution_readiness_snapshot()
            self.assertTrue(result['ok']); request.assert_called_once_with({'op': 'status'}, timeout=3)

    def test_only_fixed_control_value_is_accepted_before_reader_or_readiness(self):
        with patch('ai_computer_control.utils.execution_receipt_validation.read_validated_receipts') as reader, \
             patch.object(diagnostics, 'execution_readiness_snapshot') as readiness:
            for control in ('diagnostics', 'browser', {}, [], True, 1):
                value = audit.execution_receipt('0' * 32, control=control)
                self.assertFalse(value['ok']); self.assertEqual(value['code'], 'execution_control_invalid')
            reader.assert_not_called(); readiness.assert_not_called()

    def test_receipt_control_preserves_strict_reader_and_adds_readiness_without_new_contextless_tools(self):
        with patch('ai_computer_control.utils.execution_receipt_validation.read_validated_receipts', return_value={'ok': True, 'records': [], 'incomplete': True}) as reader, \
             patch.object(diagnostics, 'execution_readiness_snapshot', return_value={'ok': True, 'optional': {}}) as readiness:
            result = audit.execution_receipt('0' * 32, control='readiness')
            self.assertTrue(result['ok']); self.assertTrue(result['incomplete']); self.assertTrue(result['readiness']['ok'])
            reader.assert_called_once_with('0' * 32); readiness.assert_called_once_with()
        for name in ('diagnostics', 'browser_backend_status', 'list_monitors', 'get_dpi_info'):
            with self.assertRaises(macos.DesktopError): execution_context.require_execution_context(name)


if __name__ == '__main__': unittest.main(verbosity=2)
