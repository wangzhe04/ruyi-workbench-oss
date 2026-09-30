"""Pure-logic smoke for the desktop ACTION tools (F2 mouse bounds, F5/F11 UIA, F6 window candidates,
F8 bounded waits, F12 act_and_verify, F14 batch images, F16 type_text routing, F17 record steps).

The win32 / UIA / pyautogui layers are faked; only this repo's own decision logic is under test, so the
checks run on Linux and Windows alike (no real display or UIA needed beyond importing the modules).

Run: python -X utf8 tests/smoke_action_tools.py
"""

import asyncio
import os
import sys
import tempfile
import time
import types

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))
os.environ.setdefault("WCW_DATA_DIR", os.path.join(tempfile.gettempdir(), "acc_smoke_action_data"))

import ai_computer_control.server as server  # noqa: E402
from ai_computer_control.tools import (act_and_verify, batch, desktop_extra, dialog, keyboard,  # noqa: E402
                                       mouse, record, sync, uia, window)
from ai_computer_control.utils import geometry, waits  # noqa: E402

_FAILURES: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


# --------------------------------------------------------------------------------------------- F2
def test_virtual_bounds():
    print("F2 virtual-desktop bounds")
    metrics = {76: -1920, 77: 0, 78: 3840, 79: 1080}
    b = geometry.virtual_desktop_bounds(get_metric=lambda i: metrics[i])
    check(b == (-1920, 0, 3840, 1080), "bounds come from SM_*VIRTUALSCREEN (negative origin kept)")
    check(geometry.point_in_bounds(-500, 100, b) and geometry.point_in_bounds(1919, 1079, b),
          "a secondary-monitor point (-500,100) and the far corner are inside")
    check(not geometry.point_in_bounds(1920, 0, b) and not geometry.point_in_bounds(-1921, 0, b)
          and not geometry.point_in_bounds(0, 1080, b), "one pixel past every edge is outside")
    fb = geometry.virtual_desktop_bounds(get_metric=lambda i: 0, primary_size=lambda: (1280, 720))
    check(fb == (0, 0, 1280, 720), "unusable metrics fall back to the primary screen at the origin")

    calls = []
    old = (mouse._virtual_bounds, mouse.pyautogui.click, mouse.pyautogui.moveTo, mouse.pyautogui.drag,
           mouse.pyautogui.position)
    mouse._virtual_bounds = lambda: (-1920, 0, 3840, 1080)
    mouse.pyautogui.click = lambda **kw: calls.append(("click", kw["x"], kw["y"]))
    mouse.pyautogui.moveTo = lambda *a, **kw: calls.append(("move", a, kw))
    mouse.pyautogui.drag = lambda *a, **kw: calls.append(("drag", a))
    cur = {"x": -500, "y": 100}
    mouse.pyautogui.position = lambda: types.SimpleNamespace(x=cur["x"], y=cur["y"])
    try:
        r = mouse.mouse_click(-500, 100)
        check(r.get("ok") is True and ("click", -500, 100) in calls, "mouse_click on display 2 (-500,100) is allowed")
        calls.clear()
        r = mouse.mouse_click(5000, 100)
        check(r.get("ok") is False and "virtual desktop" in r.get("error", "") and not calls,
              "mouse_click outside the virtual desktop is refused before any click")
        r = mouse.mouse_move(-3000, 10)
        check(r.get("ok") is False and not calls, "mouse_move outside the virtual desktop is refused")
        r = mouse.mouse_drag(-100, 10, 9999, 10)
        check(r.get("ok") is False and not calls, "mouse_drag with an off-desktop end is refused")
        cur.update(x=-100, y=10)
        r = mouse.mouse_drag(-100, 10, -100, 10)
        check(r.get("ok") is True, "mouse_drag inside the desktop (secondary display) is allowed")
    finally:
        (mouse._virtual_bounds, mouse.pyautogui.click, mouse.pyautogui.moveTo, mouse.pyautogui.drag,
         mouse.pyautogui.position) = old


# ------------------------------------------------------------------------------------- F5 / F11
class _R:
    left, top, right, bottom = 0, 0, 10, 10


class Ctl:
    """Fake UIA control. `value_pattern`/`legacy` decide which read/write patterns exist."""
    ClassName = ""
    AutomationId = ""
    BoundingRectangle = _R()
    IsEnabled = True
    IsOffscreen = False

    def __init__(self, name="", ctype="EditControl", children=(), aid=""):
        self.Name, self.ControlTypeName, self._kids, self.AutomationId = name, ctype, list(children), aid
        self.stored = ""
        self.legacy_store = None
        self.no_value_pattern = True
        self.ignores_set = False
        self.invoked = 0
        self.legacy_readable = True

    def GetChildren(self):
        return self._kids

    def GetValuePattern(self):
        if self.no_value_pattern:
            return None            # uiautomation returns None when the pattern is unsupported
        outer = self

        class P:
            @property
            def Value(_s):
                return outer.stored

            def SetValue(_s, t):
                if not outer.ignores_set:
                    outer.stored = t
        return P()

    def GetLegacyIAccessiblePattern(self):
        outer = self

        class L:
            @property
            def Value(_s):
                if not outer.legacy_readable:
                    raise RuntimeError("no value")
                return outer.legacy_store

            def SetValue(_s, t):
                if not outer.ignores_set:
                    outer.legacy_store = t
        return L()

    def GetInvokePattern(self):
        outer = self

        class P:
            def Invoke(_s):
                outer.invoked += 1
        return P()


def _patch_uia(root_fn):
    old = (uia._AVAILABLE, uia._root, uia._browser_accessibility_status)
    uia._AVAILABLE = True
    uia._root = root_fn
    uia._browser_accessibility_status = lambda *a, **k: None
    return old


def _unpatch_uia(old):
    uia._AVAILABLE, uia._root, uia._browser_accessibility_status = old


def test_uia_set_value():
    print("F5 ui_invoke(set_value) read-back")
    # (a) no ValuePattern, LegacyIAccessible sets but its value is unreadable, Name is a LABEL.
    e = Ctl(name="Search")
    e.legacy_readable = False
    old = _patch_uia(lambda t: e)
    try:
        r = uia.ui_invoke("set_value", name="Search", text="hello world")
        check(r.get("success") is True and r.get("confirmed") is None and r.get("note"),
              "unreadable value -> success True, confirmed null + note (never compared with Name)")
        check(e.legacy_store == "hello world", "the value really was set through LegacyIAccessible")
        # (b) readable via legacy: confirmed True, CRLF normalisation
        e2 = Ctl(name="Search")
        uia._root = lambda t: e2
        r = uia.ui_invoke("set_value", name="Search", text="a\nb")
        e2.legacy_store = "a\r\nb"
        r2 = uia._confirm_set_value(e2, "a\nb")
        check(r.get("success") is True and r2["confirmed"] is True, "CRLF vs LF is not a mismatch")
        # (c) a control that ignores SetValue but exposes its value: still a failure
        e3 = Ctl(name="Search")
        e3.no_value_pattern = False
        e3.ignores_set = True
        e3.stored = "old"
        uia._root = lambda t: e3
        r = uia.ui_invoke("set_value", name="Search", text="new")
        check(r.get("success") is False and r.get("actual") == "old", "a value that did NOT take is still reported as failure")
        # (d) ValuePattern that works
        e4 = Ctl(name="Q")
        e4.no_value_pattern = False
        uia._root = lambda t: e4
        r = uia.ui_invoke("set_value", name="Q", text="ok")
        check(r.get("success") is True and r.get("confirmed") is True and r.get("read_back_via") == "value_pattern",
              "ValuePattern set_value confirms through the same pattern")
    finally:
        _unpatch_uia(old)


def test_uia_find_invoke():
    print("F11 ui_find / ui_invoke walk once, report truncation and ambiguity")
    walk = {"root": 0, "names": 0}

    class Counting(Ctl):
        @property
        def Name(self):
            walk["names"] += 1
            return self._n

        @Name.setter
        def Name(self, v):
            self._n = v

    def build():
        kids = [Counting(name=f"n{i}", ctype="ButtonControl") for i in range(6)]
        kids[4].Name = "Target"
        return Counting(name="root", ctype="WindowControl", children=kids)

    root = build()

    def _root(t):
        walk["root"] += 1
        return root
    old = _patch_uia(_root)
    try:
        r = uia.ui_invoke("invoke", name="Target", window_title="W")
        check(r.get("success") is True and walk["root"] == 1, "ui_invoke resolves the window root exactly once")
        check(walk["names"] <= 2 * 7, f"one tree walk per invoke (Name reads={walk['names']}, 7 nodes)")
        check(root._kids[4].invoked == 1, "the found control itself is invoked (no re-resolution)")

        # ambiguity + nth + actionable preference
        kids = [Ctl(name="OK", ctype="ButtonControl") for _ in range(3)]
        kids[0].IsEnabled = False
        kids[1].IsOffscreen = True
        amb_root = Ctl(name="root", ctype="WindowControl", children=kids)
        uia._root = lambda t: amb_root
        r = uia.ui_invoke("invoke", name="OK")
        check(r.get("success") is True and kids[2].invoked == 1 and kids[0].invoked == 0,
              "an enabled on-screen match is preferred over disabled/offscreen ones")
        check(r.get("matched_count") == 3 and len(r.get("candidates", [])) == 3 and "nth" in r.get("note", ""),
              "ambiguity is reported: matched_count + candidates + note")
        r = uia.ui_invoke("invoke", name="OK", nth=1)
        check(r.get("success") is True and kids[0].invoked == 1, "nth selects another candidate (ranked list order)")
        r = uia.ui_invoke("invoke", name="OK", nth=7)
        check("out of range" in r.get("error", ""), "nth out of range is an error")

        f = uia.ui_find(name="OK", visible_only=True, enabled_only=True)
        check(f.get("count") == 1 and f.get("skipped") == {"offscreen": 1, "disabled": 1},
              "visible_only/enabled_only filter and count what they skipped")

        # truncation: a wide tree beyond the node cap
        wide = Ctl(name="root", ctype="WindowControl",
                   children=[Ctl(name=f"x{i}", ctype="TextControl") for i in range(uia._MAX_NODES + 50)])
        uia._root = lambda t: wide
        f = uia.ui_find(name="nomatch")
        check(f.get("truncated") is True and "node_cap" in f.get("truncated_by", []) and f.get("count") == 0
              and f.get("nodes_scanned") == uia._MAX_NODES, "a >5000-node tree reports truncated:true (node_cap)")
        deep = Ctl(name="d0", ctype="PaneControl")
        cur = deep
        for i in range(1, 12):
            nxt = Ctl(name=f"d{i}", ctype="PaneControl")
            cur._kids = [nxt]
            cur = nxt
        uia._root = lambda t: deep
        f = uia.ui_find(name="d11", max_depth=3)
        check(f.get("count") == 0 and "max_depth" in f.get("truncated_by", []), "depth cut is reported (max_depth)")

        # Invoke timeout must not invite a double action and must not fall back to a click
        hung = Ctl(name="Hang", ctype="ButtonControl")
        clicked = []
        hung.Click = lambda: clicked.append(1)
        release = []

        class Slow:
            def Invoke(_s):
                while not release:
                    time.sleep(0.01)
        hung.GetInvokePattern = lambda: Slow()
        uia._root = lambda t: hung
        uia._ACTION_TIMEOUT_S, saved = 0.2, uia._ACTION_TIMEOUT_S
        try:
            r = uia.ui_invoke("invoke", name="Hang")
        finally:
            uia._ACTION_TIMEOUT_S = saved
            release.append(1)
        txt = r.get("error", "")
        check("BEFORE retrying" in txt and "ALREADY" in txt and not clicked,
              "invoke timeout says 'check state before retrying' and does not click as a fallback")
        # F8: SetFocus/Toggle are bounded too
        hf = Ctl(name="Foc", ctype="ButtonControl")
        hf.SetFocus = lambda: time.sleep(0.6)
        uia._root = lambda t: hf
        uia._ACTION_TIMEOUT_S = 0.15
        t0 = time.monotonic()
        try:
            r = uia.ui_invoke("focus", name="Foc")
        finally:
            uia._ACTION_TIMEOUT_S = saved
        check("did not return" in r.get("error", "") and time.monotonic() - t0 < 0.5,
              "SetFocus is bounded by the action timeout instead of hanging")
    finally:
        _unpatch_uia(old)


# --------------------------------------------------------------------------------------------- F6
def test_window_candidates():
    print("F6 needs_confirm carries handles")
    g = window.win32gui
    saved = {k: getattr(g, k, None) for k in ("FindWindow", "IsWindowVisible", "GetWindowText", "EnumWindows",
                                              "GetForegroundWindow")}
    wins = {101: "Untitled - Notepad", 202: "notes.txt - Notepad++"}
    g.FindWindow = lambda *a: 0
    g.IsWindowVisible = lambda h: True
    g.GetWindowText = lambda h: wins[h]
    g.GetForegroundWindow = lambda: 202

    def enum(cb, x):
        for h in wins:
            cb(h, x)
    g.EnumWindows = enum
    old_pn = window._process_name
    window._process_name = lambda h: {101: "notepad.exe", 202: "notepad++.exe"}[h]
    try:
        for fn, verb in ((window.focus_window, "focus"), (window.close_window, "close")):
            r = fn(title="notepad")
            m = r.get("matches", [])
            check(r.get("needs_confirm") is True and len(m) == 2
                  and all(isinstance(c["handle"], int) and isinstance(c["title"], str) for c in m),
                  f"{verb}_window needs_confirm lists [{{handle:int, title:str}}]")
            check([c["handle"] for c in m] == [101, 202] and m[0]["process"] == "notepad.exe",
                  f"{verb}_window candidates carry the real handles and process names")
        check(window._amb([(101, "a"), (202, "b")]).get("candidates", [{}])[0].get("handle") == 101,
              "the ambiguity note on other window tools also carries handles")
    finally:
        window._process_name = old_pn
        for k, v in saved.items():
            if v is not None:
                setattr(g, k, v)


# --------------------------------------------------------------------------------------------- F8
def test_waits():
    print("F8 bounded / non-blocking waits")
    check(waits.clamp_wait_s(10**6) == (waits.MAX_WAIT_S, True) and waits.clamp_wait_s(-3) == (0.0, False)
          and waits.clamp_wait_s("x", 7) == (7.0, False), "clamp_wait_s bounds, floors and coerces")
    tools = {t.name: t for t in server.mcp._tool_manager.list_tools()}
    check(all(asyncio.iscoroutinefunction(tools[n].fn) for n in ("wait_for_pixel", "wait_for_window", "message_box")),
          "wait_for_pixel / wait_for_window / message_box are async (they yield instead of blocking the loop)")

    import pyautogui
    old_pixel = pyautogui.pixel
    pyautogui.pixel = lambda x, y: (10, 20, 30)
    try:
        r = asyncio.run(sync.wait_for_pixel(1, 1, "#0a141e", timeout_ms=10**8))
        check(r.get("matched") is True and r.get("capped") is True and r.get("requested_timeout") == 10**8,
              "wait_for_pixel clamps a huge timeout and says so")

        async def race():
            ticks = []

            async def ticker():
                for _ in range(5):
                    await asyncio.sleep(0.02)
                    ticks.append(1)
            t = asyncio.create_task(ticker())
            r = await sync.wait_for_pixel(1, 1, "#ffffff", timeout_ms=400, poll_ms=20)
            await t
            return r, len(ticks)
        r, n = asyncio.run(race())
        check(r.get("matched") is False and n == 5, "another coroutine runs while wait_for_pixel polls")
    finally:
        pyautogui.pixel = old_pixel

    # wait_for_window: clamp + yield
    old_enum = desktop_extra._enum_windows
    desktop_extra._enum_windows = lambda: [(7, "Calculator")]
    old_rect = desktop_extra._window_rect
    desktop_extra._window_rect = lambda h: {"left": 0}
    try:
        r = asyncio.run(desktop_extra.wait_for_window("calc", timeout=99999))
        check(r.get("found") is True and r.get("capped") is True, "wait_for_window clamps a huge timeout and says so")
    finally:
        desktop_extra._enum_windows, desktop_extra._window_rect = old_enum, old_rect

    # message_box: the join must not hold the loop
    def slow_box(hwnd, text, caption, style, lang, ms):
        time.sleep(0.4)
        return 1
    fake_ctypes = types.SimpleNamespace(
        windll=types.SimpleNamespace(user32=types.SimpleNamespace(MessageBoxTimeoutW=slow_box)),
        c_int=int, c_wchar_p=lambda s: s)
    old_ct = dialog.ctypes
    dialog.ctypes = fake_ctypes

    async def box_race():
        ticks = []

        async def ticker():
            for _ in range(8):
                await asyncio.sleep(0.02)
                ticks.append(1)
        t = asyncio.create_task(ticker())
        r = await dialog.message_box("t", "m", timeout_ms=1000)
        await t
        return r, len(ticks)
    try:
        r, n = asyncio.run(box_race())
        check(r.get("result") == "ok" and n == 8,
              "the event loop keeps ticking while message_box waits on its worker thread")
    finally:
        dialog.ctypes = old_ct


# -------------------------------------------------------------------------------------------- F12
def test_act_and_verify():
    print("F12 act_and_verify settle / shots / pruning")
    from PIL import Image
    a = act_and_verify
    base = Image.new("RGB", (200, 100), (0, 0, 0))
    changed = Image.new("RGB", (200, 100), (0, 0, 0))
    changed.paste((255, 255, 255), (20, 20, 120, 70))

    # frame sequence: unchanged until 700ms, then changed and stable
    clock = {"t": 0.0}
    frames = []

    def sleep(s):
        clock["t"] += s

    def grab():
        frames.append(clock["t"])
        return base if clock["t"] < 0.7 else changed
    frame, waited, did_change, settled = a._wait_settled(grab, base, 500, sleep=sleep, clock=lambda: clock["t"])
    ratio, px, _ = a._changed_stats(base, frame)
    check(did_change and settled and ratio > 0 and 0.7 <= clock["t"] < 1.3,
          f"a change landing at 700ms is caught with the default settle_ms=500 (waited {waited}ms)")

    clock["t"] = 0.0
    frame, waited, did_change, settled = a._wait_settled(lambda: base, base, 500, sleep=sleep, clock=lambda: clock["t"])
    check(not did_change and settled and 0.95 <= clock["t"] <= 1.2, "a no-op action stops polling at ~2*settle_ms")
    clock["t"] = 0.0
    n_before = len(frames)
    a._wait_settled(lambda: base, base, 0, sleep=sleep, clock=lambda: clock["t"])
    check(clock["t"] == 0.0, "settle_ms=0 does not sleep")

    # collision-free names + pruning (files saved within the same second)
    with tempfile.TemporaryDirectory() as d:
        paths = []
        for _ in range(6):
            r = a._save_shots(base, changed, d, keep=8)
            paths += [r["before_path"], r["after_path"]]
        check(len(set(paths)) == 12, "12 shots in the same second have 12 distinct names")
        files = sorted(os.listdir(d))
        check(len(files) == 8 and all(f.endswith(".jpg") for f in files), f"directory pruned to the newest 8 (has {len(files)})")
        # legacy PNGs are pruned too; unrelated files are kept
        for i in range(5):
            open(os.path.join(d, f"before-2020010{i}-000000.png"), "wb").write(b"x")
        open(os.path.join(d, "keep-me.txt"), "w").write("x")
        a._prune_shots(d, 8)
        left = os.listdir(d)
        check("keep-me.txt" in left and len([f for f in left if f != "keep-me.txt"]) == 8,
              "prune keeps unrelated files and at most N shot files")
        im = Image.open(paths[-1])
        check(im.format == "JPEG" and im.width <= a._SHOT_WIDTH, "saved shots are JPEG and bounded in width")

    bbox = a._diff_bbox(base, changed)
    check(bbox is not None and bbox[0] <= 20 and bbox[2] >= 120, "diff region bounds the changed pixels")
    img = a._result_image("diff", base, changed)
    check(img.get("image") and img["width"] <= 640 and "diff_region" in img, "return_image=diff yields a small cropped image")
    check("image_note" in a._result_image("diff", base, base), "no diff region when nothing changed")

    # the tool end to end with faked grab / action: default writes NO files, no-change writes evidence
    with tempfile.TemporaryDirectory() as d:
        old = (a._grab, a._do_action, a._shots_dir, a._foreground_rect, a.time.sleep)
        seq = iter([base, base, changed, changed, changed, changed])
        state = {"after": changed}
        a._grab = lambda region=None: (a._crop(state["after"], region) if region else state["after"]) if state.get("phase") else base
        a._do_action = lambda act: (state.update(phase=1) or {"ok": True})
        a._shots_dir = lambda: d
        a._foreground_rect = lambda: None
        a.time.sleep = lambda s: None
        try:
            r = a.act_and_verify({"type": "click", "x": 50, "y": 50}, region="0,0,200,100", settle_ms=100)
            check(r.get("ok") and r["changed_ratio"] > 0 and "before_path" not in r and os.listdir(d) == [],
                  "by default the tool saves no shots (in-memory diff only)")
            state["after"] = base
            state.pop("phase")
            r = a.act_and_verify({"type": "click", "x": 50, "y": 50}, region="0,0,200,100", settle_ms=100)
            check(r.get("shots_reason") == "no_change" and len(os.listdir(d)) == 2,
                  "a no-change result keeps downscaled before/after evidence")
            state.pop("phase", None)
            state["after"] = changed
            r = a.act_and_verify({"type": "click", "x": 50, "y": 50}, region="0,0,200,100", settle_ms=100,
                                 return_image="after")
            check(r.get("image") and r.get("width") and r.get("format") == "png", "return_image='after' returns the screenshot keys")
        finally:
            a._grab, a._do_action, a._shots_dir, a._foreground_rect, a.time.sleep = old


# -------------------------------------------------------------------------------------------- F14
def test_batch_images():
    print("F14 batch_actions lifts step images to the top-level channel")
    big = lambda c: c * 5000
    out = {"success": True, "results": [
        {"step": 0, "tool": "screenshot", "ok": True,
         "result": {"ok": True, "image": big("A"), "width": 10, "height": 5, "scale": 0.5, "format": "png"}},
        {"step": 1, "tool": "mouse_click", "ok": True, "result": {"ok": True}},
        {"step": 2, "tool": "screenshot", "ok": True,
         "result": {"ok": True, "image": big("B"), "width": 20, "height": 9, "scale": 1.0, "format": "png"}},
        {"step": 3, "tool": "screenshot", "ok": True,
         "result": {"ok": True, "image_base64": big("C"), "width": 30, "height": 9, "scale": 1.0, "format": "png"}},
    ]}
    batch.lift_batch_images(out)
    check(out.get("image") == big("C") and out.get("width") == 30 and out.get("image_base64") == big("B"),
          "newest image -> top-level `image` (+ its width/height/scale/format), previous -> `image_base64`")
    check([e["step"] for e in out["lifted_images"]] == [3, 2], "lifted_images records the source steps")
    r0 = out["results"][0]["result"]
    check("image" not in r0 and r0.get("image_omitted") is True, "images beyond the cap are dropped and marked image_omitted")
    check("image_base64" not in out["results"][3]["result"] and out["results"][3]["result"].get("image_lifted") is True,
          "lifted images are removed from the nested result (no double payload)")
    check(len(repr(out["results"])) < 2000, "the nested results no longer carry base64")

    # same shape the workbench's extractToolImages reads (top-level image / image_base64 / screenshot.image)
    nested = {"results": [{"step": 0, "tool": "observe", "ok": True,
                           "result": {"ok": True, "screenshot": {"image": big("Z"), "width": 1}}}]}
    batch.lift_batch_images(nested)
    check(nested.get("image") == big("Z") and "image" not in nested["results"][0]["result"]["screenshot"],
          "screenshot.image inside a step result is lifted too")
    small = {"results": [{"step": 0, "tool": "x", "ok": True, "result": {"image": "tiny"}}]}
    batch.lift_batch_images(small)
    check("image" not in small, "short strings named 'image' are not mistaken for pictures")

    # end to end through the real dispatcher with a fake tool
    class FakeTool:
        is_async = False

        def __init__(self, res):
            self.fn = lambda **kw: res

    old_map = batch._tool_map
    batch._tool_map = lambda: {"shot": FakeTool({"ok": True, "image": big("Q"), "width": 4, "height": 4,
                                                 "scale": 1.0, "format": "png"})}
    try:
        res = asyncio.run(batch._run_batch([{"tool": "shot", "args": {}}], "stop", 0))
        check(res.get("image") == big("Q") and res["success"] is True, "batch_actions output carries the lifted image")
    finally:
        batch._tool_map = old_map


# -------------------------------------------------------------------------------------------- F16
def test_type_text():
    print("F16 type_text routing + clipboard restore")
    rc = keyboard._route_clipboard
    check(rc("hello", None) == (False, "short_ascii"), "short single-line ASCII is typed key by key")
    check(rc("x" * 500, None)[0] is True, "500 ASCII chars go through the clipboard")
    check(rc("def f():\n    return 1\n", None) == (True, "multiline"), "multi-line code goes through the clipboard (no auto-indent)")
    check(rc("ls -la\n", None)[0] is False, "'text' + one trailing newline is still typed then Enter")
    check(rc("你好", None) == (True, "non_ascii"), "non-ASCII still uses the clipboard")
    check(rc("x" * 500, False) == (False, "explicit") and rc("a", True)[0] is True, "explicit use_clipboard wins")

    calls = []
    saved = (keyboard.pyautogui.typewrite, keyboard.pyautogui.hotkey, keyboard.pyautogui.press,
             keyboard.pyperclip.copy, keyboard.pyperclip.paste, keyboard._clipboard_has_nontext)
    clip = {"v": "OLD"}
    keyboard.pyautogui.typewrite = lambda t, interval=0: calls.append(("type", t))
    keyboard.pyautogui.hotkey = lambda *k: calls.append(("hotkey", k))
    keyboard.pyautogui.press = lambda k: calls.append(("press", k))
    keyboard.pyperclip.copy = lambda t: (clip.update(v=t), calls.append(("copy", t)))
    keyboard.pyperclip.paste = lambda: clip["v"]
    keyboard._clipboard_has_nontext = lambda: False
    try:
        r = keyboard.type_text("a" * 300)
        check(r.get("method") == "clipboard" and r.get("route") == "long" and not [c for c in calls if c[0] == "type"],
              "type_text(300 chars) chooses method:clipboard")
        r = keyboard.type_text("line1\nline2")
        check(r.get("method") == "clipboard" and r.get("route") == "multiline", "type_text(multi-line) chooses clipboard")
        r = keyboard.type_text("short")
        check(r.get("method") == "typewrite", "type_text(short) types key by key")
        calls.clear()
        r = keyboard.type_text("b" * 300 + "\n")
        check(("press", "enter") in calls and r.get("trailing_enter") == 1 and ("copy", "b" * 300) in calls,
              "a long text ending in a newline pastes the body and presses Enter (not a dropped pasted newline)")

        # restore waits for the paste to land, and yields to a third-party clipboard write
        events = []
        seqs = iter([10, 10])
        clip["v"] = "OLD"
        keyboard.pyperclip.copy = lambda t: (clip.update(v=t), events.append(("copy", t)))
        res = keyboard._type_via_clipboard("NEW", sleep=lambda s: events.append(("sleep", s)), seq=lambda: next(seqs))
        kinds = [e[0] for e in events]
        check(res["restore"] == "done" and kinds == ["copy", "sleep", "copy"] and events[1][1] >= 0.4 and clip["v"] == "OLD",
              "the clipboard is restored only AFTER a >=0.4s wait for the paste")
        events.clear()
        seqs = iter([10, 11])
        clip["v"] = "OLD"
        res = keyboard._type_via_clipboard("NEW", sleep=lambda s: None, seq=lambda: next(seqs))
        check(res["restore"] == "skipped_changed" and clip["v"] == "NEW",
              "a clipboard write by someone else during the paste is not clobbered by the restore")
    finally:
        (keyboard.pyautogui.typewrite, keyboard.pyautogui.hotkey, keyboard.pyautogui.press,
         keyboard.pyperclip.copy, keyboard.pyperclip.paste, keyboard._clipboard_has_nontext) = saved


# -------------------------------------------------------------------------------------------- F17
def test_record_steps():
    print("F17 record: chords + pacing")
    ev = [(0.00, "key", {"key": "h"}), (0.10, "key", {"key": "i"}),
          (1.00, "key", {"key": "ctrlleft"}), (1.05, "key", {"key": "\x03"}),
          (1.10, "keyup", {"key": "\x03"}), (1.12, "keyup", {"key": "ctrlleft"}),
          (1.20, "click", {"x": 5, "y": 6, "button": "left"}),
          (1.30, "key", {"key": "winleft"}), (1.40, "keyup", {"key": "winleft"}),
          (1.45, "key", {"key": "shiftleft"}), (1.5, "key", {"key": "A"}), (1.55, "keyup", {"key": "shiftleft"}),
          (1.6, "key", {"key": "shiftleft"}), (1.65, "key", {"key": "tab"}), (1.7, "keyup", {"key": "tab"}),
          (1.75, "keyup", {"key": "shiftleft"})]
    steps = record._events_to_steps(ev)
    tools = [(s["tool"], s["args"]) for s in steps]
    check(tools[0] == ("type_text", {"text": "hi"}), "printable keys coalesce into type_text")
    check(tools[1] == ("wait", {"seconds": 0.9}), "a 0.9s pause becomes a wait step")
    check(tools[2] == ("hotkey", {"keys": ["ctrl", "c"]}), "Ctrl+C is ONE hotkey step (not press_key ctrlleft + \\x03)")
    check(tools[3][0] == "mouse_click", "no wait for gaps under 0.3s")
    check(tools[4] == ("press_key", {"key": "winleft"}), "a lone modifier press is a plain press_key")
    check(tools[5] == ("type_text", {"text": "A"}), "Shift+letter stays a typed character (no spurious shift press)")
    check(tools[6] == ("hotkey", {"keys": ["shift", "tab"]}) and len(tools) == 7, "Shift+Tab is a hotkey step")
    check(record._events_to_steps([(0, "key", {"key": "a"}), (30, "key", {"key": "enter"})])[1]
          == {"tool": "wait", "args": {"seconds": 5.0}}, "long idle gaps are capped at 5s")


def main() -> int:
    for fn in (test_virtual_bounds, test_uia_set_value, test_uia_find_invoke, test_window_candidates,
               test_waits, test_act_and_verify, test_batch_images, test_type_text, test_record_steps):
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            _FAILURES.append(f"{fn.__name__} crashed: {type(e).__name__}: {e}")
    if _FAILURES:
        print(f"\nFAILED ({len(_FAILURES)}):")
        for f in _FAILURES:
            print("  -", f)
        return 1
    print("\nALL PASS: action-tool logic (bounds, UIA, window candidates, waits, act_and_verify, batch, type_text, record).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
