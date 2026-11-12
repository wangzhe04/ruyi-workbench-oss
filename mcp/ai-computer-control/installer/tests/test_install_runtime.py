"""Stdlib tests: real installer entry paths, mocked imports, real owned rollback files.

No ACC imports or executable payload is launched. --installer selects the actual
module for an old/new counterexample run; the default is the adjacent installer.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

INSTALLER = Path(__file__).resolve().parents[1] / "install.py"
if "--installer" in sys.argv:
    index = sys.argv.index("--installer")
    if index + 1 >= len(sys.argv):
        raise ValueError("--installer requires an absolute existing file")
    INSTALLER = Path(sys.argv[index + 1])
    if not INSTALLER.is_absolute() or not INSTALLER.is_file():
        raise ValueError("--installer requires an absolute existing file")
    del sys.argv[index:index + 2]

EXPECTED_IMPORTS = (
    "mcp.server.fastmcp", "ai_computer_control.server", "pyautogui", "playwright",
    "openpyxl", "xlsxwriter", "docx", "pptx", "pdfplumber", "reportlab", "numpy",
    "PIL", "pandas", "pypdf", "PyPDF2", "requests", "bs4",
    "winsdk.windows.media.ocr", "winsdk.windows.graphics.imaging",
    "winsdk.windows.storage.streams", "winsdk.windows.globalization",
)
SECRET = "IMPORT_EXCEPTION_PRIVATE_PAYLOAD"


class InstallerRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ruyi-installer-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        spec = importlib.util.spec_from_file_location("acc_installer_under_test", INSTALLER)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        m = self.module
        m.INSTALL_DIR = str(self.root / "installed")
        m.RUNTIME_DIR = str(self.root / "installed" / "runtime" / "python")
        m.INSTALL_STATE_FILE = str(self.root / "installed" / "install-state.json")
        m.PYTHON_EMBED_DIR = str(self.root / "payload" / "python")
        m.PLAYWRIGHT_DIR = str(self.root / "absent-browsers")
        m.MANIFEST_FILE = str(self.root / "payload" / "offline-manifest.json")
        self.source = Path(m.PYTHON_EMBED_DIR)
        self.source.mkdir(parents=True)
        (self.source / "python.exe").write_bytes(b"owned-unit-placeholder-not-executable")
        (self.source / "new.bin").write_bytes(b"new runtime bytes")
        Path(m.MANIFEST_FILE).write_text('{"fixture":"payload-identity"}', encoding="utf-8")
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))

    def success(self):
        return types.SimpleNamespace(returncode=0)

    def assert_call(self, call, command, timeout, full=True):
        args, kwargs = call
        code = "; ".join("import " + name for name in EXPECTED_IMPORTS) if full else "import sys; assert sys.version_info >= (3, 12)"
        self.assertEqual(args, ([str(command), "-I", "-B", "-X", "utf8", "-c", code],))
        self.assertEqual(kwargs, {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "timeout": timeout})

    def old_runtime(self):
        runtime = Path(self.module.RUNTIME_DIR)
        runtime.mkdir(parents=True)
        (runtime / "python.exe").write_bytes(b"old python")
        (runtime / "kept" ).mkdir()
        (runtime / "kept" / "old.bin").write_bytes(b"old nested data")
        return self.snapshot(runtime)

    def snapshot(self, root):
        return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}

    def assert_no_staging(self):
        parent = Path(self.module.RUNTIME_DIR).parent
        self.assertEqual(list(parent.glob("python.new-*")), [])

    def assert_failure_metadata(self, error, phase, kind):
        self.assertEqual(error.phase, phase)
        self.assertEqual(error.failure_kind, kind)
        self.assertEqual(error.timeout_seconds, 60)
        self.assertNotIn(SECRET, str(error))
        self.assertNotIn(SECRET, repr(vars(error)))
        self.assertIsNone(error.__cause__)
        self.assertIsNone(error.__context__)

    def test_warm_boolean_and_exact_import_contract(self):
        m = self.module
        self.assertEqual(m.REQUIRED_FULL_IMPORTS, EXPECTED_IMPORTS)
        with mock.patch.object(m.subprocess, "run", return_value=self.success()) as run:
            self.assertTrue(m._python_ok("warm-python", require_acc=True))
            self.assertTrue(m._python_ok("version-python"))
        self.assert_call(run.call_args_list[0], "warm-python", 20)
        self.assert_call(run.call_args_list[1], "version-python", 20, full=False)
        with mock.patch.object(m.subprocess, "run", return_value=types.SimpleNamespace(returncode=9)) as run:
            self.assertFalse(m._python_ok("warm-python", require_acc=True))
            self.assertEqual(run.call_count, 1)

    def test_warm_failures_remain_boolean_without_retry(self):
        m = self.module
        errors = [subprocess.TimeoutExpired("private", 20, output=SECRET, stderr=SECRET),
                  FileNotFoundError(2, SECRET), RuntimeError(SECRET)]
        for error in errors:
            with self.subTest(error=type(error).__name__), mock.patch.object(m.subprocess, "run", side_effect=error) as run:
                self.assertFalse(m._python_ok("warm-python", require_acc=True))
                self.assertEqual(run.call_count, 1)
                self.assert_call(run.call_args, "warm-python", 20)

    def test_source_and_installed_ready_checks_keep_twenty_seconds(self):
        m = self.module
        Path(m.INSTALL_DIR).mkdir(parents=True)
        m.write_install_state(str(Path(m.RUNTIME_DIR) / "python.exe"))
        with mock.patch.object(m.subprocess, "run", return_value=self.success()) as run:
            self.assertEqual(m.bundled_python(), str(self.source / "python.exe"))
            self.assertEqual(m.installed_runtime_ready(), str(Path(m.RUNTIME_DIR) / "python.exe"))
        self.assertEqual(run.call_count, 2)
        self.assert_call(run.call_args_list[0], self.source / "python.exe", 20)
        self.assert_call(run.call_args_list[1], Path(m.RUNTIME_DIR) / "python.exe", 20)

    def test_cold_copy_can_complete_after_warm_budget_without_retry(self):
        m = self.module
        self.old_runtime()
        def cold(args, **kwargs):
            if kwargs["timeout"] < 60:
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            return self.success()
        with mock.patch.object(m.subprocess, "run", side_effect=cold) as run:
            result = m.install_bundled_runtime(str(self.source / "python.exe"))
        self.assertEqual(result, str(Path(m.RUNTIME_DIR) / "python.exe"))
        self.assertEqual(self.snapshot(Path(m.RUNTIME_DIR)), self.snapshot(self.source))
        self.assertEqual(run.call_count, 2)
        staging_command = run.call_args_list[0].args[0][0]
        self.assertTrue(Path(staging_command).parent.name.startswith("python.new-"))
        self.assert_call(run.call_args_list[0], staging_command, 60)
        self.assert_call(run.call_args_list[1], result, 60)
        self.assert_no_staging()
        self.assertFalse((Path(m.RUNTIME_DIR).parent / "python.previous").exists())

    def staging_failure(self, outcome, kind):
        m = self.module
        old = self.old_runtime()
        backup = Path(m.RUNTIME_DIR).parent / "python.previous"
        backup.mkdir()
        (backup / "preexisting.bin").write_bytes(b"preexisting backup")
        original_replace = m.os.replace
        options = {"side_effect": outcome} if isinstance(outcome, BaseException) else {"return_value": outcome}
        with mock.patch.object(m.subprocess, "run", **options) as run, mock.patch.object(m.os, "replace", wraps=original_replace) as replace:
            with self.assertRaises(RuntimeError) as raised:
                m.install_bundled_runtime(str(self.source / "python.exe"))
        self.assert_failure_metadata(raised.exception, "copied-staging", kind)
        self.assertEqual(run.call_count, 1)
        self.assert_call(run.call_args, run.call_args.args[0][0], 60)
        replace.assert_not_called()
        self.assertEqual(self.snapshot(Path(m.RUNTIME_DIR)), old)
        self.assertEqual((backup / "preexisting.bin").read_bytes(), b"preexisting backup")
        self.assert_no_staging()
        return raised.exception

    def test_staging_nonzero_does_not_activate(self):
        error = self.staging_failure(types.SimpleNamespace(returncode=7), "nonzero")
        self.assertEqual(error.returncode, 7)
        self.assertIsNone(error.errno)

    def test_staging_timeout_does_not_activate(self):
        self.staging_failure(subprocess.TimeoutExpired("private", 60, output=SECRET, stderr=SECRET), "timeout")

    def test_staging_spawn_failure_does_not_activate(self):
        error = self.staging_failure(FileNotFoundError(2, SECRET), "spawn")
        self.assertEqual(error.errno, 2)

    def final_failure(self, outcome, kind):
        m = self.module
        old = self.old_runtime()
        with mock.patch.object(m.subprocess, "run", side_effect=[self.success(), outcome]) as run:
            with self.assertRaises(RuntimeError) as raised:
                m.install_bundled_runtime(str(self.source / "python.exe"))
        self.assert_failure_metadata(raised.exception, "first-activation", kind)
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assert_call(call, call.args[0][0], 60)
        self.assertEqual(self.snapshot(Path(m.RUNTIME_DIR)), old)
        self.assertFalse((Path(m.RUNTIME_DIR).parent / "python.previous").exists())
        self.assert_no_staging()
        return raised.exception

    def test_final_nonzero_restores_old_runtime(self):
        error = self.final_failure(types.SimpleNamespace(returncode=11), "nonzero")
        self.assertEqual(error.returncode, 11)

    def test_final_timeout_restores_old_runtime(self):
        self.final_failure(subprocess.TimeoutExpired("private", 60, output=SECRET, stderr=SECRET), "timeout")

    def test_final_spawn_failure_restores_old_runtime(self):
        self.final_failure(FileNotFoundError(2, SECRET), "spawn")

    def test_ensure_success_preserves_registration_and_state_order(self):
        m = self.module
        order = []
        real_browsers, real_configure, real_state = m.install_playwright_payload, m.configure_mcp, m.write_install_state
        def browsers():
            order.append("browsers")
            return real_browsers()
        def configure(python):
            order.append("mcp")
            return real_configure(python)
        def state(python):
            order.append("state")
            return real_state(python)
        def probe(args, **kwargs):
            if len(order) == 0 and Path(args[0]).parent == Path(m.RUNTIME_DIR) and kwargs["timeout"] == 20:
                raise FileNotFoundError(2, SECRET)
            return self.success()
        with mock.patch.object(m.sys, "argv", ["install.py", "--ensure"]), mock.patch.dict(os.environ, {"APPDATA": str(self.root / "no-desktop")}), mock.patch.object(m, "verify_offline_payload", return_value=True) as verify, mock.patch.object(m.subprocess, "run", side_effect=probe) as run, mock.patch.object(m, "install_playwright_payload", side_effect=browsers), mock.patch.object(m, "configure_mcp", side_effect=configure), mock.patch.object(m, "write_install_state", side_effect=state):
            m.main()
        verify.assert_called_once_with()
        self.assertEqual(order, ["browsers", "mcp", "state"])
        self.assertEqual([call.kwargs["timeout"] for call in run.call_args_list], [20, 20, 60, 60])
        for call in run.call_args_list:
            self.assert_call(call, call.args[0][0], call.kwargs["timeout"])
        python = str(Path(m.RUNTIME_DIR) / "python.exe")
        state = json.loads(Path(m.INSTALL_STATE_FILE).read_text(encoding="utf-8"))
        self.assertEqual(state, {"schema": 1, "payloadSha256": hashlib.sha256(Path(m.MANIFEST_FILE).read_bytes()).hexdigest(), "python": python.replace("\\", "/")})
        config = json.loads((Path(m.INSTALL_DIR) / "mcp_config.json").read_text(encoding="utf-8"))
        self.assertEqual(config["mcpServers"]["ai-computer-control"]["command"], state["python"])
        self.assertEqual(config["mcpServers"]["ai-computer-control"]["args"], ["-X", "utf8", "-m", "ai_computer_control.server"])
        self.assertTrue((Path(m.INSTALL_DIR) / "start_server.bat").is_file())

    def test_unexpected_probe_failure_is_closed_before_registration_or_state(self):
        m = self.module
        with mock.patch.object(m.sys, "argv", ["install.py"]), mock.patch.object(m, "verify_offline_payload", return_value=True), mock.patch.object(m.subprocess, "run", side_effect=[self.success(), RuntimeError(SECRET)]) as run, mock.patch.object(m, "install_playwright_payload") as browsers, mock.patch.object(m, "configure_mcp") as configure, mock.patch.object(m, "write_install_state") as state:
            with self.assertRaises(RuntimeError) as raised:
                m.main()
        self.assert_failure_metadata(raised.exception, "copied-staging", "probe_error")
        self.assertEqual([call.kwargs["timeout"] for call in run.call_args_list], [20, 60])
        browsers.assert_not_called()
        configure.assert_not_called()
        state.assert_not_called()
        self.assertFalse(Path(m.INSTALL_STATE_FILE).exists())
        self.assert_no_staging()
        self.assertNotIn(SECRET, self.output.getvalue())


if __name__ == "__main__":
    print("INSTALLER_SOURCE_SHA256 " + hashlib.sha256(INSTALLER.read_bytes()).hexdigest(), flush=True)
    unittest.main(verbosity=2)
