"""P5 input-session contracts using owned fake workers. Never injects input or reads the clipboard."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from ai_computer_control.utils import macos, macos_session


@unittest.skipUnless(sys.platform == "darwin", "Mac native input IPC")
class InputSession(unittest.TestCase):
    def setUp(self):
        macos_session.close_input_session()
        self.directory = tempfile.TemporaryDirectory(prefix="p5-input-ipc-")
        self.root = Path(self.directory.name)
        self.helper = self.root / "helper"
        self.env = patch.dict(os.environ, {"RUYI_MACOS_AUTOMATION_HELPER": str(self.helper)})
        self.env.start()

    def tearDown(self):
        macos_session.close_input_session()
        self.env.stop()
        self.directory.cleanup()

    def worker(self, body, startup=""):
        self.helper.write_text("#!/usr/bin/python3\nimport json, os, sys, time\n"
                               + startup + "\nfor line in sys.stdin:\n    request = json.loads(line)\n"
                               + "\n".join("    " + line for line in body.splitlines()) + "\n", encoding="utf-8")
        self.helper.chmod(0o700)

    def reply(self, expression):
        self.worker("print(json.dumps(" + expression + "), flush=True)")

    def assert_error(self, code, payload=None, timeout=2):
        with self.assertRaises(macos.DesktopError) as caught:
            macos_session.request(payload or {"op": "window.list"}, timeout=timeout)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_missing_dependency_is_typed(self):
        self.assert_error("dependency_missing")
        self.assertIsNone(macos_session._SESSION)

    def test_requests_reuse_one_worker_with_correlated_ids(self):
        self.reply("{'ok':True, 'protocolVersion':1, 'id':request['id'], 'pid':os.getpid()}")
        first = macos_session.request({"op": "window.list"})
        worker = macos_session._SESSION["child"]
        second = macos_session.request({"op": "window.active"})
        self.assertEqual(first["pid"], second["pid"])
        self.assertEqual(macos_session._SESSION["next_id"], 2)
        self.assertNotIn("id", first)
        macos_session.close_input_session()
        self.assertEqual(worker.poll(), 0)
        self.assertTrue(worker.stdin.closed and worker.stdout.closed)

    def test_malformed_response_invalidates_the_worker(self):
        for response in ("None", "[]", "{'ok':1,'id':request['id']}",
                         "{'ok':True,'protocolVersion':True,'id':request['id']}",
                         "{'ok':True,'protocolVersion':2,'id':request['id']}",
                         "{'ok':True,'protocolVersion':1,'id':True}",
                         "{'ok':True,'protocolVersion':1,'id':request['id']+1}"):
            with self.subTest(response=response):
                self.reply(response)
                self.assert_error("input_session_protocol")
                self.assertIsNone(macos_session._SESSION)
        self.worker("print('broken JSON', flush=True)")
        self.assert_error("input_session_protocol")

    def test_input_limit_and_unicode_are_checked_before_sending(self):
        self.reply("{'ok':True, 'protocolVersion':1, 'id':request['id'], 'text':request.get('text')}")
        for text in ("x" * 65536, "\ud800"):
            self.assert_error("invalid_args", {"op":"clipboard.set", "text":text})
        self.assert_error("invalid_args", {"op":"window.move", "x":float("nan")})
        value = "中文😀\nline"
        self.assertEqual(macos_session.request({"op":"clipboard.set", "text":value})["text"], value)

    def test_failure_metadata_survives_and_the_session_remains_usable(self):
        self.reply("{'ok':False, 'id':request['id'], 'code':'window_action_unconfirmed', 'error':'controlled', "
                   "'acted':True, 'action_sent':True, 'restored':False, 'outcome':'unconfirmed', "
                   "'actual_bounds':{'x':9}, 'window':{'handle':123}, 'unexpected':'private'}")
        error = self.assert_error("window_action_unconfirmed", {"op":"window.move"})
        self.assertEqual(error.details, {"acted":True, "action_sent":True, "restored":False,
                         "outcome":"unconfirmed", "actual_bounds":{"x":9}, "window":{"handle":123}})
        self.assertIsNotNone(macos_session._SESSION)
        error = self.assert_error("window_action_unconfirmed")
        self.assertEqual(macos_session._SESSION["next_id"], 2)

    def test_timeout_reaps_and_never_replays_a_mutation(self):
        marker = self.root / "sent"
        self.worker("if request['op'] == 'window.list':\n"
                    "    print(json.dumps({'ok':True, 'protocolVersion':1, 'id':request['id'], 'pid':os.getpid()}), flush=True)\n"
                    "    continue\n"
                    "with open(" + repr(str(marker)) + ", 'a') as record: record.write('sent\\n')\n"
                    "time.sleep(10)")
        ready = macos_session.request({"op":"window.list"})
        self.assertTrue(ready["ok"])
        worker = macos_session._SESSION["child"]
        self.assertEqual(ready["pid"], worker.pid)
        self.assertFalse(marker.exists())
        started = time.monotonic()
        error = self.assert_error("input_session_timeout", {"op":"window.move"}, timeout=0.5)
        self.assertEqual(error.details, {"action_sent":True, "outcome":"unknown"})
        self.assertEqual(marker.read_text(), "sent\n")
        self.assertIsNone(macos_session._SESSION)
        self.assertIsNotNone(worker.poll())
        self.assertLess(time.monotonic() - started, 2)
        self.reply("{'ok':True, 'protocolVersion':1, 'id':request['id']}")
        self.assertTrue(macos_session.request({"op":"window.list"})["ok"])
        self.assertEqual(marker.read_text(), "sent\n")

    def test_timeout_before_worker_consumes_frame_is_uncertain_without_replay(self):
        marker = self.root / "sent"
        self.worker("open(" + repr(str(marker)) + ", 'w').close()", startup="time.sleep(10)")
        worker = macos_session._session()["child"]
        started = time.monotonic()
        error = self.assert_error("input_session_timeout", {"op":"window.move"}, timeout=0.5)
        self.assertEqual(error.details, {"action_sent":True, "outcome":"unknown"})
        self.assertFalse(marker.exists())
        self.assertIsNone(macos_session._SESSION)
        self.assertIsNotNone(worker.poll())
        self.assertLess(time.monotonic() - started, 2)
        self.reply("{'ok':True, 'protocolVersion':1, 'id':request['id']}")
        self.assertTrue(macos_session.request({"op":"window.list"})["ok"])
        self.assertFalse(marker.exists())

    def test_read_timeout_has_no_mutation_metadata(self):
        self.worker("time.sleep(10)")
        error = self.assert_error("input_session_timeout", timeout=0.3)
        self.assertEqual(error.details, {})

    def test_ax_observation_failure_is_read_only_but_invoke_is_uncertain(self):
        for operation in ("ax.inspect", "ax.find", "ax.invoke"):
            with self.subTest(operation=operation):
                self.worker("sys.exit(0)")
                error = self.assert_error("input_session_failed", {"op": operation})
                self.assertEqual(error.details, {"action_sent": True, "outcome": "unknown"} if operation == "ax.invoke" else {})

    def test_eof_and_response_capacity_close_the_worker(self):
        self.worker("sys.exit(0)")
        error = self.assert_error("input_session_failed", {"op":"clipboard.set", "text":"controlled"})
        self.assertTrue(error.details["action_sent"])
        self.worker("print('x' * 8192, flush=True)")
        with patch.object(macos_session, "_OUTPUT_LIMIT", 4096):
            self.assert_error("input_session_capacity")
        self.assertIsNone(macos_session._SESSION)

    def test_extra_response_frames_are_rejected(self):
        self.worker("data = json.dumps({'ok':True,'protocolVersion':1,'id':request['id']})\n"
                    "os.write(1, (data + '\\n' + data + '\\n').encode())")
        self.assert_error("input_session_protocol")

    def test_concurrent_request_is_refused_without_another_send(self):
        self.reply("{'ok':True, 'protocolVersion':1, 'id':request['id']}")
        macos_session._LOCK.acquire()
        try:
            self.assert_error("desktop_busy")
            self.assertIsNone(macos_session._SESSION)
        finally:
            macos_session._LOCK.release()

    def test_replaced_worker_invalidates_refs_without_replaying(self):
        self.reply("{'ok':True, 'protocolVersion':1, 'id':request['id'], 'pid':os.getpid()}")
        first = macos_session.request({"op":"window.list"})
        original = macos_session._SESSION["child"]
        replacement = self.root / "replacement"
        replacement.write_text(self.helper.read_text().replace("'pid':os.getpid()", "'pid':os.getpid(),'changed':True"))
        replacement.chmod(0o700)
        replacement.replace(self.helper)
        second = macos_session.request({"op":"window.list"})
        self.assertNotEqual(first["pid"], second["pid"])
        self.assertTrue(second["changed"])
        self.assertIsNotNone(original.poll())

    def test_replacement_during_mutation_is_an_uncertain_result(self):
        marker = self.root / "sent"
        self.worker("open(" + repr(str(marker)) + ", 'w').close()\ntime.sleep(0.3)\n"
                    "print(json.dumps({'ok':True,'protocolVersion':1,'id':request['id']}), flush=True)")
        def replace():
            deadline = time.monotonic() + 2
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.005)
            replacement = self.root / "replacement"
            replacement.write_text("#!/bin/sh\nexit 1\n")
            replacement.chmod(0o700)
            replacement.replace(self.helper)
        changer = threading.Thread(target=replace)
        changer.start()
        try:
            error = self.assert_error("dependency_changed", {"op":"window.move"})
            self.assertTrue(error.details["action_sent"])
            self.assertIsNone(macos_session._SESSION)
        finally:
            changer.join()

    def test_shutdown_serializes_with_an_inflight_request(self):
        marker = self.root / "sent"
        self.worker("open(" + repr(str(marker)) + ", 'w').close()\ntime.sleep(0.2)\n"
                    "print(json.dumps({'ok':True,'protocolVersion':1,'id':request['id']}), flush=True)")
        results = []
        def request():
            try:
                results.append(macos_session.request({"op":"window.list"}, timeout=2))
            except Exception as error:
                results.append(error)
        thread = threading.Thread(target=request)
        thread.start()
        deadline = time.monotonic() + 2
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertTrue(marker.exists())
        child = macos_session._SESSION["child"]
        macos_session.close_input_session()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results, [{"ok":True,"protocolVersion":1}])
        self.assertIsNotNone(child.poll())
        self.assertTrue(child.stdout.closed)
        self.assertIsNone(macos_session._SESSION)


@unittest.skipUnless(sys.platform == "darwin", "Mac tool contracts")
class InputTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="p5-input-tools-")
        cls.env = patch.dict(os.environ, {"WCW_DATA_DIR":cls.directory.name, "ACC_TOOLSETS":"desktop", "ACC_HIDE_TOOLS":""})
        cls.env.start()
        import ai_computer_control.server as server
        from ai_computer_control.tools import macos_input
        cls.server, cls.tools = server, macos_input

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.directory.cleanup()

    def test_exception_envelope_preserves_side_effect_metadata(self):
        error = macos.DesktopError("window_action_unconfirmed", "controlled", {"acted":True, "outcome":"unconfirmed"})
        with patch.object(self.tools, "request", side_effect=error):
            result = self.tools.move_window(1, 2, {"ref":"controlled"})
        self.assertEqual(result["code"], error.code)
        self.assertTrue(result["acted"])
        self.assertEqual(result["outcome"], "unconfirmed")

    def test_discovery_retracts_each_input_family_independently(self):
        for enabled in ("windowReady", "windowQueryReady", "clipboardReady", None):
            with patch.object(macos, "capability", return_value={"ready":False, enabled:True}):
                names = {tool.name for tool in asyncio.run(self.server.mcp.list_tools())}
            self.assertEqual("focus_window" in names, enabled == "windowReady")
            self.assertEqual("list_windows" in names, enabled == "windowQueryReady")
            self.assertEqual("set_clipboard" in names, enabled == "clipboardReady")

    def test_protected_image_destination_does_not_start_native_work(self):
        with patch.object(self.tools, "request") as request:
            result = self.tools.get_clipboard_image(save_path="/System/ruyi-input-test.png")
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "path_protected")
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
