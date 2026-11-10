"""Pure routing and Mac input-tool contracts. No native event posting or clipboard reads."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from ai_computer_control.utils import text_input


class TextRouting(unittest.TestCase):
    def test_windows_compatible_routing(self):
        for text, forced, expected in (("short",None,(False,"short_ascii")), ("中文",None,(True,"non_ascii")),
                                       ("a"*201,None,(True,"long")), ("a\nb",None,(True,"multiline")),
                                       ("a\n",None,(False,"short_ascii")), ("中文",False,(False,"explicit")),
                                       ("abc",True,(True,"explicit"))):
            with self.subTest(text=text, forced=forced):
                self.assertEqual(text_input._route_clipboard(text, forced), expected)

    def test_trailing_enter_contract(self):
        for text, route, expected in (("搜索\n","non_ascii",("搜索",1)), ("abc\r","long",("abc",1)),
                                      ("代码\n下一行\n","non_ascii",("代码\n下一行\n",0)),
                                      ("搜索\n","explicit",("搜索\n",0)), ("\n","non_ascii",("\n",0))):
            with self.subTest(text=text, route=route):
                self.assertEqual(text_input._split_trailing_enter(text, route), expected)

    def test_paste_wait_remains_bounded(self):
        self.assertEqual(text_input._paste_wait_s(""), 0.4)
        self.assertEqual(text_input._paste_wait_s("x"*100000), 2)


@unittest.skipUnless(sys.platform == "darwin", "Mac event tool contracts")
class EventTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="p5-event-tools-")
        cls.env = patch.dict(os.environ, {"WCW_DATA_DIR":cls.directory.name,"ACC_TOOLSETS":"desktop","ACC_HIDE_TOOLS":""})
        cls.env.start()
        import ai_computer_control.server as server
        from ai_computer_control.tools import macos_events, macos_application
        from ai_computer_control.utils import macos
        cls.server, cls.events, cls.apps, cls.macos = server, macos_events, macos_application, macos
        cls.target = {"ref":"controlled"}

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.directory.cleanup()

    def test_text_routing_reaches_the_native_session_with_target(self):
        with patch.object(self.events,"request",return_value={"ok":True}) as request:
            result = self.events.type_text("搜索\n", target=self.target)
        self.assertEqual(request.call_args.args[0], {"op":"keyboard.text","target":self.target,
                         "text":"搜索","paste":True,"interval":0.02,"enters":1})
        self.assertEqual(result["length"], 3)
        self.assertEqual(result["method"], "clipboard")
        self.assertEqual(result["trailing_enter"], 1)

    def test_direct_chinese_is_preserved_for_unicode_events(self):
        with patch.object(self.events,"request",return_value={"ok":True}) as request:
            result = self.events.type_text("中文😀", target=self.target, use_clipboard=False, interval=0)
        self.assertEqual(request.call_args.args[0]["text"], "中文😀")
        self.assertFalse(request.call_args.args[0]["paste"])
        self.assertEqual(result["method"], "typewrite")

    def test_explicit_paste_keeps_trailing_newlines_verbatim(self):
        with patch.object(self.events,"request",return_value={"ok":True}) as request:
            self.events.type_text("代码\n", target=self.target, use_clipboard=True)
        self.assertEqual(request.call_args.args[0]["text"], "代码\n")
        self.assertEqual(request.call_args.args[0]["enters"], 0)

    def test_empty_chord_components_never_start_native_work(self):
        with patch.object(self.events,"request") as request:
            for keys in ("cmd++", "", [], ["cmd", ""]):
                result = self.events.hotkey(keys=keys,target=self.target)
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "invalid_args")
        request.assert_not_called()

    def test_partial_action_and_restore_metadata_reach_the_mcp_envelope(self):
        error = self.macos.DesktopError("input_cancelled","controlled",{"acted":True,"action_sent":True,
                                      "outcome":"unconfirmed","restore":"skipped_changed"})
        with patch.object(self.events,"request",side_effect=error):
            result = self.events.type_text("中文",target=self.target)
        self.assertEqual(result["code"], "input_cancelled")
        self.assertEqual(result["restore"], "skipped_changed")
        self.assertTrue(result["action_sent"])

    def test_pointer_failure_preserves_finite_actual_position(self):
        details = self.macos._failure_details({"actual_x":12.5,"actual_y":34,"reached":False})
        self.assertEqual(details, {"actual_x":12.5,"actual_y":34,"reached":False})
        self.assertEqual(self.macos._failure_details({"actual_x":float("nan"),"actual_y":True}), {})

    def test_scroll_requires_both_coordinates(self):
        with patch.object(self.events,"request") as request:
            result = self.events.mouse_scroll(1, target=self.target, x=10)
        self.assertFalse(result["ok"])
        request.assert_not_called()

    def test_default_scroll_uses_observed_pointer_then_guarded_target(self):
        with patch.object(self.events,"request",side_effect=[{"x":12,"y":34},{"ok":True}]) as request:
            result = self.events.mouse_scroll(-2,target=self.target)
        self.assertTrue(result["ok"])
        self.assertEqual(request.call_args.args[0], {"op":"mouse.scroll","target":self.target,
                         "x":12,"y":34,"amount":-2,"direction":"vertical"})

    def test_application_args_keep_posix_quoted_boundaries(self):
        with patch.object(self.apps,"request",return_value={"ok":True}) as request:
            result = self.apps.launch_application("/Applications/Controlled.app",args='--file "中文 空格.txt"',ready_timeout=1)
        self.assertTrue(result["ok"])
        self.assertEqual(request.call_args.args[0]["args"], ["--file","中文 空格.txt"])

    def test_invalid_gui_launch_options_fail_before_native_work(self):
        with patch.object(self.apps,"request") as request:
            for options in ({"wait":True},{"working_dir":"/tmp"},{"args":"'unclosed"}):
                result = self.apps.launch_application("Controlled",**options)
                self.assertFalse(result["ok"])
        request.assert_not_called()

    def test_discovery_tracks_each_input_family(self):
        for enabled in ("inputReady","pointerQueryReady","applicationReady",None):
            with patch.object(self.macos,"capability",return_value={"ready":False,enabled:True}):
                names = {tool.name for tool in asyncio.run(self.server.mcp.list_tools())}
            self.assertEqual("mouse_click" in names, enabled == "inputReady")
            self.assertEqual("type_text" in names, enabled == "inputReady")
            self.assertEqual("get_mouse_position" in names, enabled == "pointerQueryReady")
            self.assertEqual("launch_application" in names, enabled == "applicationReady")

    def test_native_ready_flags_cannot_override_denied_input_authorization(self):
        status = {"ok":True,"protocolVersion":1,"ready":True,"authorization":"granted","locked":False,
                  "coordinate_space":"macos_global_points","monitors":[{"index":0}],
                  "windowReady":True,"inputReady":True,"windowAuthorization":"granted","eventAuthorization":"granted"}
        with patch.object(self.macos,"_identity",return_value=(1,2,3)), patch.object(self.macos,"request",return_value=status):
            self.assertTrue(self.macos.capability()["inputReady"])
            status["eventAuthorization"] = "denied"
            self.assertFalse(self.macos.capability()["inputReady"])
            self.assertTrue(self.macos.capability()["windowReady"])
            status["windowAuthorization"] = "denied"
            self.assertFalse(self.macos.capability()["windowReady"])
            self.assertEqual(self.macos.capability()["windowAuthorization"], "denied")


if __name__ == "__main__":
    unittest.main(verbosity=2)
