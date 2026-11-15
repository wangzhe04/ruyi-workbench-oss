"""Pure Mac AX routing, discovery and failure contracts. Never reads the real desktop."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


@unittest.skipUnless(sys.platform == "darwin", "Mac native AX contracts")
class AXTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="p5-ax-contract-")
        root = Path(cls.directory.name)
        cls.env = patch.dict(os.environ, {"HOME": str(root / "home"), "USERPROFILE": str(root / "home"),
            "LOCALAPPDATA": str(root / "local"), "APPDATA": str(root / "roaming"), "WCW_DATA_DIR": str(root / "data"),
            "RUYI_MACOS_AUTOMATION_HELPER": str(root / "absent-helper"), "ACC_TOOLSETS": "uia", "ACC_HIDE_TOOLS": ""})
        cls.env.start()
        import ai_computer_control.server as server
        from ai_computer_control.tools import macos_ax
        from ai_computer_control.utils import macos
        cls.server, cls.ax, cls.macos = server, macos_ax, macos
        cls.target = {"ref": "controlled-window"}

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.directory.cleanup()

    def test_inspection_routes_exact_target_and_bounded_options(self):
        with patch.object(self.ax, "request", return_value={"ok": True}) as request:
            self.assertTrue(self.ax.ui_inspect(self.target, max_depth=6, max_nodes=123, scope="menu_bar")["ok"])
        self.assertEqual(request.call_args.args[0], {"op": "ax.inspect", "target": self.target,
            "scope": "menu_bar", "max_depth": 6, "max_nodes": 123})

    def test_find_preserves_native_selectors_and_filters(self):
        with patch.object(self.ax, "request", return_value={"ok": True}) as request:
            self.ax.ui_find(self.target, name="中文", control_type="Button", automation_id="Exact-ID",
                            max_results=3, max_depth=7, max_nodes=80, visible_only=True, enabled_only=True)
        self.assertEqual(request.call_args.args[0], {"op": "ax.find", "target": self.target, "scope": "window",
            "name": "中文", "control_type": "Button", "automation_id": "Exact-ID", "max_results": 3,
            "max_depth": 7, "max_nodes": 80, "visible_only": True, "enabled_only": True})

    def test_invoke_uses_the_observed_reference_without_selector_search(self):
        with patch.object(self.ax, "request", return_value={"ok": True, "confirmed": True}) as request:
            result = self.ax.ui_invoke(self.target, "private-ref", action="set_value", text="直接中文😀")
        self.assertTrue(result["confirmed"])
        self.assertEqual(request.call_args.args[0], {"op": "ax.invoke", "target": self.target,
            "element_ref": "private-ref", "action": "set_value", "text": "直接中文😀"})

    def test_failure_retains_sent_action_readback_and_control_metadata(self):
        details = {"acted": True, "action_sent": True, "outcome": "unconfirmed", "confirmed": False,
                   "control": {"type": "AXButton"}}
        error = self.macos.DesktopError("element_action_unconfirmed", "controlled failure", details)
        with patch.object(self.ax, "request", side_effect=error):
            result = self.ax.ui_invoke(self.target, "private-ref")
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "element_action_unconfirmed")
        for key, value in details.items():
            self.assertEqual(result[key], value)

    def test_discovery_requires_current_ax_readiness(self):
        for ready in (True, False):
            with self.subTest(ready=ready), patch.object(self.macos, "capability", return_value={"axReady": ready}):
                names = {tool.name for tool in asyncio.run(self.server.mcp.list_tools())}
            self.assertEqual({"ui_inspect", "ui_find", "ui_invoke"} <= names, ready)
            self.assertEqual(bool({"ui_inspect", "ui_find", "ui_invoke"} & names), ready)

    def test_ax_ready_flag_requires_support_authorization_and_unlocked_state(self):
        status = {"ok": True, "protocolVersion": 1, "authorization": "denied", "ready": False,
                  "locked": False, "monitors": [{"index": 0}], "coordinate_space": "macos_global_points",
                  "axSupported": True, "axReady": True, "windowAuthorization": "granted"}
        with patch.object(self.macos, "_identity", return_value=(1, 2)), patch.object(self.macos, "request", return_value=status):
            self.assertTrue(self.macos.capability()["axReady"])
            self.assertFalse(self.macos.capability()["ready"])
            status["windowAuthorization"] = "denied"
            self.assertFalse(self.macos.capability()["axReady"])
            status["windowAuthorization"] = "granted"
            status["locked"] = True
            self.assertFalse(self.macos.capability()["axReady"])
            status["locked"] = False
            status["axSupported"] = False
            self.assertFalse(self.macos.capability()["axReady"])

    def test_platform_replacement_preserves_windows_uia_module(self):
        self.assertEqual(self.server._platform_modules(["uia"]), ["macos_ax"])
        with patch.object(self.server.sys, "platform", "win32"), patch.object(self.server, "_UNSUPPORTED_MODULES", {}):
            self.assertEqual(self.server._platform_modules(["uia"]), ["uia"])

    def test_diagnostics_separates_native_backend_from_optional_windows_package(self):
        status = {"supported": True, "installed": True, "axSupported": True, "axReady": False,
                  "windowAuthorization": "denied", "ready": False}
        diagnostic = self.server.mcp._tool_manager.get_tool("diagnostics").fn
        with patch.object(self.macos, "capability", return_value=status):
            result = diagnostic()
        self.assertTrue(result["optional"]["uia"])
        self.assertNotIn("uia", result["unsupported_modules"])
        self.assertEqual(result["capabilities"]["desktop.accessibility"], {"supported": True, "installed": True,
            "authorization": "denied", "ready": False, "backend": "AXUIElement", "coordinate_space": "macos_global_points"})


if __name__ == "__main__":
    unittest.main()
