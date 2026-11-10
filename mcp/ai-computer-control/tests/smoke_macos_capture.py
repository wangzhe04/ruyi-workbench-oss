"""P5 capture contracts. Synthetic image/IPC tests never capture the user's desktop."""
import asyncio
import base64
import io
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from PIL import Image
from ai_computer_control.utils import macos


@unittest.skipUnless(sys.platform == "darwin", "Mac native IPC contract")
class NativeIPC(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="p5-ipc-")
        self.root = Path(self.directory.name)
        self.helper = self.root / "helper"
        self.env = patch.dict(os.environ, {"RUYI_MACOS_AUTOMATION_HELPER": str(self.helper)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.directory.cleanup()

    def script(self, body):
        self.helper.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        self.helper.chmod(0o700)

    def reply(self, value):
        self.script("cat >/dev/null\nprintf '%s' " + shlex.quote(json.dumps(value)))

    def test_missing_helper_is_a_typed_dependency(self):
        self.assertEqual(macos.capability()["reasonCode"], "dependency_missing")
        with self.assertRaisesRegex(macos.DesktopError, "Build or install"):
            macos.request({"op": "status"})

    def test_invalid_envelope_and_protocol_fail_closed(self):
        for value in (None, [], {"ok": 1}, {"ok": True, "protocolVersion": 2}):
            self.reply(value)
            with self.subTest(value=value), self.assertRaises(macos.DesktopError) as caught:
                macos.request({"op": "status"})
            self.assertEqual(caught.exception.code, "capture_failed")

    def test_permission_lock_and_query_capabilities_remain_distinct(self):
        for granted, locked in ((False, False), (True, True), (True, False)):
            self.reply({"ok": True, "protocolVersion": 1, "authorization": "granted" if granted else "denied",
                        "ready": granted and not locked, "locked": locked, "monitors": [{"index":0}], "coordinate_space": "macos_global_points"})
            state = macos.capability()
            self.assertTrue(state["supported"] and state["installed"] and state["queryReady"])
            self.assertEqual(state["ready"], granted and not locked)

    def test_timeout_and_output_limits_reap_the_child(self):
        self.script("exec /bin/sleep 10")
        with self.assertRaises(macos.DesktopError) as caught:
            macos.request({"op": "capture"}, timeout=0.05)
        self.assertEqual(caught.exception.code, "capture_timeout")
        started = time.monotonic()
        with self.assertRaises(macos.DesktopError) as caught:
            macos.request({"op": "capture", "padding":"x" * 64000}, timeout=0.05)
        self.assertEqual(caught.exception.code, "capture_timeout")
        self.assertLess(time.monotonic() - started, 2)
        self.script("exec /usr/bin/yes x")
        with patch.object(macos, "_OUTPUT_LIMIT", 4096), self.assertRaises(macos.DesktopError) as caught:
            macos.request({"op": "capture"})
        self.assertEqual(caught.exception.code, "capture_capacity")
        self.reply({"ok": True, "protocolVersion": 1})
        self.assertTrue(macos.request({"op": "status"})["ok"])

    def test_replacing_the_helper_cannot_publish_stale_readiness(self):
        report = {"ok": True, "protocolVersion": 1}
        marker = self.root / "started"
        self.script("cat >/dev/null\nprintf started > " + shlex.quote(str(marker))
                    + "\nsleep 0.25\nprintf '%s' " + shlex.quote(json.dumps(report)))
        def replace():
            deadline = time.monotonic() + 2
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.005)
            replacement = self.root / "replacement"
            replacement.write_text("#!/bin/sh\nexit 1")
            replacement.chmod(0o700)
            replacement.replace(self.helper)
        timer = threading.Thread(target=replace)
        timer.start()
        try:
            with self.assertRaises(macos.DesktopError) as caught:
                macos.request({"op": "status"})
            self.assertEqual(caught.exception.code, "dependency_changed")
        finally:
            timer.join()


@unittest.skipUnless(sys.platform == "darwin", "Mac registry contracts")
class CaptureTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="p5-tools-")
        cls.env = patch.dict(os.environ, {"WCW_DATA_DIR": cls.directory.name, "ACC_TOOLSETS": "desktop,vision",
                                         "ACC_HIDE_TOOLS": ""})
        cls.env.start()
        import ai_computer_control.server as server
        from ai_computer_control.tools import macos_capture
        cls.server, cls.tools = server, macos_capture

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.directory.cleanup()

    def frame(self, size=(202, 102), bounds=None):
        image = Image.new("RGB", size, "white")
        info = {"ok": True, "logical_bounds": bounds or {"x": -101, "y": -51, "width": 101, "height": 51},
                "coordinate_space": "macos_global_points"}
        return image, info

    def test_retina_thumbnail_has_exact_separate_axis_scales(self):
        image, info = self.frame()
        with patch.object(macos, "capture", return_value=(image, info)):
            result = self.tools.screenshot(max_width=31)
        self.assertTrue(result["ok"])
        decoded = Image.open(io.BytesIO(base64.b64decode(result["image"])))
        self.assertEqual(decoded.size, (result["width"], result["height"]))
        self.assertEqual(result["origin"], {"x": -101, "y": -51})
        self.assertEqual(result["source_pixel_scale"], {"x": 2, "y": 2})
        self.assertEqual(result["width"] / result["scale"], 101)
        self.assertEqual(result["height"] / result["scale_y"], 51)
        self.assertNotEqual(result["scale"], result["scale_y"])

    def test_invalid_regions_do_not_start_native_capture(self):
        with patch.object(macos, "capture") as capture:
            for region in ("1,2", "1,x,4,5", "0,0,0,4", "0,0,2,-4"):
                result = self.tools.screenshot(region=region)
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "invalid_args")
            capture.assert_not_called()

    def test_black_image_is_a_failed_observation(self):
        image, info = self.frame()
        with patch.object(macos, "capture", return_value=(Image.new("RGB", image.size), info)):
            result = self.tools.screenshot()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "capture_blank")

    def test_protected_output_is_rejected_before_observation(self):
        with patch.object(macos, "capture") as capture:
            result = self.tools.window_screenshot("controlled fixture", output_path="/System/p5-test.png")
            self.assertFalse(result["ok"])
            capture.assert_not_called()

    def test_window_memory_and_file_results_preserve_mapping(self):
        image, info = self.frame()
        target = Path(self.directory.name) / "中文 空格" / "window.png"
        with patch.object(macos, "capture", return_value=(image, info)):
            memory = self.tools.window_screenshot("fixture", max_width=31)
            self.assertIn("image_base64", memory)
            self.assertNotIn("path", memory)
            result = self.tools.window_screenshot("fixture", output_path=str(target))
        self.assertTrue(result["ok"])
        self.assertEqual(result["scale"], 2)
        self.assertEqual(result["scale_y"], 2)
        with Image.open(target) as saved:
            self.assertEqual(saved.size, image.size)

    def test_failed_window_save_preserves_existing_file(self):
        image, info = self.frame()
        target = Path(self.directory.name) / "existing.png"
        target.write_bytes(b"existing content")
        with patch.object(macos, "capture", return_value=(image, info)), \
             patch.object(image, "save", side_effect=OSError("injected full disk")):
            result = self.tools.window_screenshot("fixture", output_path=str(target))
        self.assertFalse(result["ok"])
        self.assertEqual(target.read_bytes(), b"existing content")
        self.assertFalse(list(target.parent.glob(".ruyi-*")))

    def test_invalid_native_geometry_is_a_typed_failure(self):
        image, _ = self.frame()
        buffer = io.BytesIO()
        image.save(buffer,"PNG")
        base = {"png":base64.b64encode(buffer.getvalue()).decode(),"width":image.width,"height":image.height,
                "coordinate_space":"macos_global_points"}
        for bounds in ({"x":0,"y":0,"width":float("nan"),"height":51},
                       {"x":None,"y":0,"width":101,"height":51}, {"x":0,"y":0,"width":0,"height":51}):
            with patch.object(macos,"request",return_value={**base,"logical_bounds":bounds}), \
                 self.assertRaises(macos.DesktopError) as caught:
                macos.capture()
            self.assertEqual(caught.exception.code,"capture_failed")

    def test_discovery_tracks_authorization_and_dependency_changes(self):
        for state in ({"ready": True, "queryReady": True}, {"ready": False, "queryReady": True},
                      {"ready": False, "queryReady": False}):
            with patch.object(macos, "capability", return_value=state):
                names = {tool.name for tool in asyncio.run(self.server.mcp.list_tools())}
            self.assertEqual("screenshot" in names, state["ready"])
            self.assertEqual("get_screen_info" in names, state["queryReady"])
            self.assertNotIn("mouse_click", names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
