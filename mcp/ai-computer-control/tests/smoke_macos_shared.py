"""P3-01: real Mac shared registry, dependency isolation, and filesystem identities.

No desktop permissions, external services, or system writes. Run with the installed
Python 3.12 environment. Windows registry assertions remain in smoke_registry.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


@unittest.skipUnless(sys.platform == "darwin", "Mac filesystem/registration contract")
class MacShared(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix="ruyi-acc-macos-")
        cls.home = Path(cls.fixture.name)
        cls.env = patch.dict(os.environ, {
            "HOME": str(cls.home), "USERPROFILE": str(cls.home),
            "WCW_DATA_DIR": str(cls.home / "data"),
            "ACC_TOOLSETS": "", "ACC_HIDE_TOOLS": "", "ACC_HIDE_MEMORY": "",
        })
        cls.env.start()
        import ai_computer_control.server as server
        from ai_computer_control.tools import safety
        cls.server, cls.safety = server, safety

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.fixture.cleanup()

    def test_registry_and_diagnostics_are_truthful(self):
        s = self.server
        names = {t.name for t in s.mcp._tool_manager.list_tools()}
        self.assertTrue({"read_file", "edit_file", "write_document", "excel_read", "write_pptx",
                         "chart_image", "browser_open", "diagnostics"} <= names)
        self.assertFalse({"screenshot", "mouse_click", "ocr_image", "ui_inspect", "macro_run",
                          "wait_for_pixel", "beep", "observe"} & names)
        d = s.mcp._tool_manager.get_tool("diagnostics").fn()
        self.assertEqual(d["load_errors"], {})
        self.assertIn("uia", d["unsupported_modules"])
        self.assertFalse(d["optional"]["ocr"])
        self.assertFalse(d["optional"]["uia"])
        self.assertFalse(d["optional"]["pynput"])
        self.assertEqual(names, {t.name for t in s.mcp._tool_manager.list_tools()})
        # Pure registration selection retains all Windows groups. No Windows backend
        # is imported or executed by this assertion.
        with patch.object(s, "_UNSUPPORTED_MODULES", {}):
            self.assertIn("screen", s._active_modules())
            self.assertIn("ocr", s._active_modules())

    def test_explicit_toolsets_cannot_enable_mac_desktop(self):
        with patch.dict(os.environ, {"ACC_TOOLSETS": "desktop,uia,ocr,office,browser"}):
            active = self.server._active_modules()
        self.assertIn("document", active)
        self.assertIn("browser", active)
        self.assertNotIn("screen", active)
        self.assertNotIn("uia", active)

    def test_system_roots_aliases_and_temporary_workspaces(self):
        guard = self.safety.protected_path_reason
        for target in ("/", "/System", "/system/ruyi-never-write", "/dev/null", "/usr/bin/x",
                       "/etc/hosts", "/private/etc/hosts", "/var/db/x", "/private/var/log/x",
                       "/Users", "/Volumes", "/tmp", str(self.home),
                       str(self.home / "Library/Keychains/x")):
            # /system aliases /System on the default volume. On a case-sensitive
            # volume it is a distinct, nonexistent root and must not be conflated.
            if target.startswith("/system/") and not os.path.exists("/system"):
                continue
            with self.subTest(target=target):
                self.assertIsNotNone(guard(target))
        self.assertIsNone(guard(str(self.home / "普通 空格😀/new.txt")))
        self.assertIsNone(guard("/private/var/tmp/ruyi-test/new.txt"))
        link = self.home / "system-link"
        link.symlink_to("/etc", target_is_directory=True)
        self.assertIsNotNone(guard(str(link / "hosts")))
        volume_alias = Path("/System/Volumes/Data") / str(self.home).lstrip("/") / "new.txt"
        if volume_alias.parent.exists():
            self.assertIsNone(guard(str(volume_alias)))

    def test_custom_paths_use_identity_without_lowercasing(self):
        protected = self.home / "CaseSensitive"
        protected.mkdir()
        alias = self.home / "protected-link"
        alias.symlink_to(protected, target_is_directory=True)
        custom = {"protected_paths": [str(alias)], "denied_commands": [],
                  "denied_kill_names": [], "allowed_kill_names": []}
        with patch.object(self.safety, "_CUSTOM", custom):
            self.assertIsNotNone(self.safety.protected_path_reason(str(protected / "new.txt")))
            swapped = self.home / "casesensitive"
            self.assertEqual(self.safety.protected_path_reason(str(swapped / "new.txt")) is not None,
                             swapped.exists())
            self.assertIsNone(self.safety.protected_path_reason(str(self.home / "CaseSensitive-other/a")))

    def test_import_failure_is_local_and_diagnosed(self):
        code = """
import importlib.abc, json, sys
class Broken(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name == 'ai_computer_control.tools.office_chart':
            raise ImportError('P3 injected optional backend failure')
sys.meta_path.insert(0, Broken())
import ai_computer_control.server as s
d = s.mcp._tool_manager.get_tool('diagnostics').fn()
print(json.dumps({'names': [t.name for t in s.mcp._tool_manager.list_tools()], 'diag': d}))
"""
        env = dict(os.environ, PYTHONPATH=str(ROOT / "src"), ACC_TOOLSETS="office,filesystem")
        result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True,
                                text=True, timeout=30, check=True)
        data = json.loads(result.stdout)
        self.assertIn("read_document", data["names"])
        self.assertIn("write_file", data["names"])
        self.assertNotIn("chart_image", data["names"])
        self.assertEqual(set(data["diag"]["load_errors"]), {"office_chart"})
        self.assertIn("P3 injected", result.stderr)

    def test_future_protection_root_obeys_volume_case_semantics(self):
        parent = self.home / "ExistingParent"
        parent.mkdir()
        future = parent / "FutureProtected"
        custom = {"protected_paths": [str(future)]}
        insensitive = os.pathconf(str(parent), 11) == 0
        with patch.object(self.safety, "_CUSTOM", custom):
            self.assertIsNotNone(self.safety.protected_path_reason(str(future / "new.txt")))
            changed_parent = self.home / "existingparent" / "FutureProtected/new.txt"
            self.assertEqual(self.safety.protected_path_reason(str(changed_parent)) is not None, insensitive)
            changed_future = parent / "futureprotected/new.txt"
            self.assertEqual(self.safety.protected_path_reason(str(changed_future)) is not None, insensitive)
            # Both roots are absent, so this assertion exercises volume semantics
            # without relying on the case behavior of an already existing alias.
            with patch.object(self.safety.os, "pathconf", return_value=1):
                self.assertIsNone(self.safety.protected_path_reason(str(changed_future)))
            with patch.object(self.safety.os, "pathconf", side_effect=OSError("unavailable volume metadata")):
                self.assertIsNotNone(self.safety.protected_path_reason(str(changed_future)))

    def test_clean_install_contains_no_windows_desktop_packages(self):
        for name in ("win32api", "pyautogui", "uiautomation", "winsdk", "pynput"):
            with self.subTest(module=name):
                self.assertIsNone(importlib.util.find_spec(name))

    def test_case_sensitive_apfs_volume_keeps_distinct_future_roots(self):
        image = self.home / "case.sparseimage"
        mount = self.home / "case-volume"
        mount.mkdir()
        def disk(*args):
            return subprocess.run(["/usr/bin/hdiutil", *map(str, args)], capture_output=True,
                                  text=True, timeout=60, check=True)
        disk("create", "-size", "64m", "-fs", "Case-sensitive APFS", "-volname", "RuyiP3Case",
             "-type", "SPARSE", "-quiet", image)
        try:
            disk("attach", "-nobrowse", "-noautoopen", "-mountpoint", mount, "-quiet", image)
            self.assertEqual(os.pathconf(str(mount), 11), 1)
            upper, lower = mount / "Project", mount / "project"
            upper.mkdir(); lower.mkdir()
            self.assertNotEqual(upper.stat().st_ino, lower.stat().st_ino)
            with patch.object(self.safety, "_CUSTOM", {"protected_paths": [str(upper / "Future")]}):
                self.assertIsNotNone(self.safety.protected_path_reason(str(upper / "Future/x")))
                self.assertIsNone(self.safety.protected_path_reason(str(upper / "future/x")))
                self.assertIsNone(self.safety.protected_path_reason(str(lower / "Future/x")))
            # APFSX preserves case distinctions but still aliases canonical Unicode
            # spellings. The protection root deliberately does not exist yet.
            with patch.object(self.safety, "_CUSTOM", {"protected_paths": [str(upper / "Caf\u00e9")]}):
                self.assertIsNotNone(self.safety.protected_path_reason(str(upper / "Cafe\u0301/x")))
        finally:
            if mount.stat().st_dev != self.home.stat().st_dev:
                try:
                    disk("detach", "-quiet", mount)
                except subprocess.CalledProcessError:
                    disk("detach", "-force", "-quiet", mount)


if __name__ == "__main__":
    unittest.main(verbosity=2)
