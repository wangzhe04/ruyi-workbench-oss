"""Edge-case smoke for the desktop/file/OCR/shell tools (second review wave: items 13-17 and the PowerShell UTF-8 fix).

  13  launch_application: an existing document (C:\\x\\a.docx) goes to the default handler instead of Popen (WinError
      193); a drive-letter path (D:\\x\\y.xlsx) is a path, not a URL scheme; real foreign schemes are still refused
  14  move_file: a case-only rename (readme.md -> README.md) is the same file on Windows, not "already exists"
  15  type_text: a single-line non-ASCII text ending in "\\n" pastes the body and presses Enter (like ASCII "ls\\n")
  16  mouse_scroll(x, y) / scroll_at: off-desktop target refused before any wheel event; clamped cursor => no scroll
  17  ocr_click / ocr_find_text match against EVERY recognized word; only ocr_screen / ocr_image responses are capped
  E   run_command: `powershell -Command ...` gets the UTF-8 output preamble spliced in (pure string rules + a real
      Windows run that needs no Chinese code page)

Pure logic: the win32 / pyautogui / WinRT layers are replaced by fakes (stubbed modules only when the real ones do not
import, i.e. on Linux), so every check runs on Linux and Windows alike. The Windows-only checks at the end use the real
file system / PowerShell and are skipped elsewhere. Temp files live in one mkdtemp dir that is removed on exit.

Run with UTF-8:  python -X utf8 tests/smoke_desktop_edges.py
"""

import asyncio
import ctypes
import os
import shutil
import sys
import tempfile
import types
from unittest import mock

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))

_TMP = tempfile.mkdtemp(prefix="acc_desktop_edges_")
os.environ.setdefault("WCW_DATA_DIR", os.path.join(_TMP, "data"))
os.makedirs(os.environ["WCW_DATA_DIR"], exist_ok=True)


class _AnyModule(types.ModuleType):
    """Stand-in for a Windows-only module that does not import here: any attribute is a MagicMock."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return mock.MagicMock(name=f"{self.__name__}.{name}")


class _Dll:
    """Stand-in for ctypes.windll off Windows: every attribute chain is callable and returns 0."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Dll()

    def __call__(self, *a, **k):
        return 0


for _name in ("pyautogui", "win32gui", "win32process", "win32con", "winsound"):
    try:
        __import__(_name)
    except Exception:  # noqa: BLE001 - Linux / headless: use the permissive stand-in
        sys.modules[_name] = _AnyModule(_name)
if not hasattr(ctypes, "windll"):
    ctypes.windll = _Dll()

import ai_computer_control.server as server  # noqa: E402
from ai_computer_control.tools import application, filesystem, keyboard, mouse, ocr, shell  # noqa: E402

_FAILURES: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


class Patch:
    """Context manager: set (obj, attr, value) triples and restore them (attributes that did not exist are removed)."""

    _MISSING = object()

    def __init__(self, *triples):
        self._triples = triples
        self._saved = []

    def __enter__(self):
        for obj, attr, value in self._triples:
            self._saved.append((obj, attr, getattr(obj, attr, self._MISSING)))
            setattr(obj, attr, value)
        return self

    def __exit__(self, *exc):
        for obj, attr, old in reversed(self._saved):
            if old is self._MISSING:
                delattr(obj, attr)
            else:
                setattr(obj, attr, old)
        return False


def touch(path: str, data: bytes = b"x") -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return path


# ------------------------------------------------------------------------------------------------ 13
def test_launch_application():
    print("13 launch_application: documents, drive letters, schemes")
    check(application._document_scheme(r"D:\x\y.xlsx") == "" and application._document_scheme("c:foo.txt") == "",
          "a drive letter is not a URL scheme (D:\\x\\y.xlsx, c:foo.txt)")
    check(application._document_scheme("https://example.com/a") == "https"
          and application._document_scheme("javascript:alert(1)") == "javascript"
          and application._document_scheme(r"\\server\share\a.docx") == "",
          "real schemes keep their name; a UNC path has none")

    doc = touch(os.path.join(_TMP, "docs", "a.docx"))
    exe = touch(os.path.join(_TMP, "bin", "tool.exe"))
    cmd = touch(os.path.join(_TMP, "bin", "run.cmd"))
    check(application._resolve_executable(doc) is None, "an existing .docx is NOT an executable")
    check(application._resolve_executable(exe) == os.path.abspath(exe)
          and application._resolve_executable(cmd) == os.path.abspath(cmd),
          ".exe / .cmd files still resolve to themselves")

    opened, spawned = [], []

    class FakeProc:
        pid = 4242
        returncode = None

        def poll(self):
            return None

    def fake_popen(argv, **kw):
        spawned.append(argv)
        return FakeProc()

    with Patch((os, "startfile", lambda p: opened.append(p)), (application.subprocess, "Popen", fake_popen)):
        r = application.launch_application(doc)
        check(r.get("ok") is True and r.get("launched_via") == "shell-association" and opened == [doc] and not spawned,
              f"an existing document opens via the default handler, no Popen (got {r})")

        opened.clear()
        missing = r"Q:\acc-smoke-missing-dir\y.xlsx"
        r = application.launch_application(missing)
        check(r.get("ok") is True and opened == [missing] and "scheme" not in str(r),
              f"a drive-letter document path is handed to the handler, not refused as scheme 'q' (got {r})")

        opened.clear()
        for bad in ("javascript:alert(1)", "ms-settings:network", "vbscript:msgbox(1)"):
            r = application.launch_application(bad)
            check(r.get("ok") is False and "refused to open scheme" in r.get("error", "") and not opened,
                  f"foreign scheme still refused: {bad}")
        r = application.launch_application("https://example.com/")
        check(r.get("ok") is True and opened == ["https://example.com/"], "https URL still opens")

        r = application.launch_application(doc, args="-x")
        check(r.get("ok") is False and "document" in r.get("error", "") and not spawned,
              f"a document with args is refused with a message that says it is a document (got {r.get('error')!r})")

        r = application.launch_application(exe, args='"a b" c', ready_timeout=0)
        check(r.get("ok") is True and r.get("pid") == 4242 and spawned == [[os.path.abspath(exe), "a b", "c"]],
              f"an .exe is still spawned directly with split args (got {spawned})")
        spawned.clear()
        r = application.launch_application(cmd, ready_timeout=0)
        check(r.get("ok") is True and spawned == [[os.path.abspath(cmd)]], "a .cmd is still spawned directly")

    def not_found(_p):
        raise FileNotFoundError(2, "no such file", _p)

    with Patch((os, "startfile", not_found)):
        r = application.launch_application(r"Q:\acc-smoke-missing-dir\y.xlsx")
        check(r.get("ok") is False and "could not open" in r.get("error", "") and "scheme" not in r.get("error", ""),
              f"a missing drive-letter file is a real 'could not open' error (got {r.get('error')!r})")


# ------------------------------------------------------------------------------------------------ 14
def test_move_file_case_only():
    print("14 move_file: case-only rename")
    d = os.path.join(_TMP, "mv")
    src = touch(os.path.join(d, "readme.md"))
    dst = os.path.join(d, "README.md")
    moved = []
    real_exists = os.path.exists

    def fake_move(a, b):
        moved.append((a, b))

    # Simulated case-insensitive volume: the upper-case name "exists" (it is the source itself) and normcase folds case.
    with Patch((os.path, "normcase", lambda p: p.lower()),
               (os.path, "exists", lambda p: real_exists(p) or p == dst),
               (filesystem.shutil, "move", fake_move)):
        r = filesystem.move_file(src, dst)
        check(r.get("ok") is True and moved == [(src, dst)],
              f"case-only rename is not refused as 'destination already exists' (got {r})")
        moved.clear()
        other = touch(os.path.join(d, "other.txt"))
        r = filesystem.move_file(src, other)
        check(r.get("ok") is False and "already exists" in r.get("error", "") and not moved,
              "a different existing destination is still refused")

    if os.path.normcase("A") == "A":   # case-sensitive platform: README.md would be a DIFFERENT file
        with Patch((os.path, "exists", lambda p: real_exists(p) or p == dst), (filesystem.shutil, "move", fake_move)):
            moved.clear()
            r = filesystem.move_file(src, dst)
            check(r.get("ok") is False and not moved, "on a case-sensitive FS a differently-cased existing file still blocks")

    # Real file system (Windows / macOS default volumes are case-insensitive; skipped where it is not).
    probe = touch(os.path.join(d, "probe.txt"))
    if real_exists(os.path.join(d, "PROBE.TXT")):
        real_src = touch(os.path.join(d, "readme2.md"))
        real_dst = os.path.join(d, "README2.md")
        r = filesystem.move_file(real_src, real_dst)
        names = os.listdir(d)
        check(r.get("ok") is True and "README2.md" in names and "readme2.md" not in names,
              f"real case-insensitive volume: readme2.md -> README2.md renamed (names {sorted(names)})")
    else:
        print("  [skip] real case-only rename (this temp volume is case-sensitive)")
    os.remove(probe)


# ------------------------------------------------------------------------------------------------ 15
def test_type_text_trailing_enter():
    print("15 type_text: trailing newline on pasted single-line text")
    f = keyboard._split_trailing_enter
    check(f("搜索词\n", "non_ascii") == ("搜索词", 1), "CJK + LF -> body + 1 Enter")
    check(f("搜索词\r\n", "non_ascii") == ("搜索词", 1), "CJK + CRLF -> body + 1 Enter")
    check(f("搜索词\r", "non_ascii") == ("搜索词", 1), "CJK + bare CR -> body + 1 Enter")
    check(f("搜索词\n\n", "non_ascii") == ("搜索词", 2), "CJK + two LF -> 2 Enters")
    check(f("搜索词", "non_ascii") == ("搜索词", 0), "no trailing newline -> untouched")
    check(f("第一行\n第二行\n", "non_ascii") == ("第一行\n第二行\n", 0), "multi-line CJK keeps its newlines verbatim")
    check(f("x" * 300 + "\n", "long") == ("x" * 300, 1), "long ASCII line keeps its old behaviour")
    check(f("搜索词\n", "explicit") == ("搜索词\n", 0) and f("ls\n", "short_ascii") == ("ls\n", 0),
          "explicit use_clipboard and short ASCII routes are untouched")

    events = []
    pyag = keyboard.pyautogui
    fake_clip = types.SimpleNamespace(paste=lambda: "OLD", copy=lambda t: events.append(("copy", t)))
    with Patch((keyboard, "pyperclip", fake_clip), (keyboard, "_clipboard_has_nontext", lambda: False),
               (keyboard, "_clipboard_seq", lambda: 1),
               (pyag, "hotkey", lambda *k: events.append(("hotkey", k))),
               (pyag, "press", lambda k: events.append(("press", k))),
               (pyag, "typewrite", lambda t, interval=0: events.append(("typewrite", t))),
               (pyag, "sleep", lambda s: None)):
        r = keyboard.type_text("搜索词\n")
        check(r.get("ok") is True and r.get("route") == "non_ascii" and r.get("trailing_enter") == 1
              and ("copy", "搜索词") in events and events.count(("press", "enter")) == 1
              and events.index(("hotkey", ("ctrl", "v"))) < events.index(("press", "enter")),
              f"'搜索词\\n' pastes the body, then presses Enter once (events {events})")
        events.clear()
        r = keyboard.type_text("搜索词")
        check(r.get("ok") is True and "trailing_enter" not in r and ("press", "enter") not in events,
              "'搜索词' alone presses no Enter")
        events.clear()
        r = keyboard.type_text("ls\n")
        check(r.get("method") == "typewrite" and events == [("typewrite", "ls\n")], "ASCII 'ls\\n' is still typed key by key")


# ------------------------------------------------------------------------------------------------ 16
def test_scroll_bounds():
    print("16 mouse_scroll / scroll_at: virtual-desktop bounds and landing check")
    calls = []
    cur = {"x": 0, "y": 0}
    clamp = {"on": False}
    pyag = mouse.pyautogui

    def move_to(x, y, *a, **k):
        calls.append(("move", x, y))
        if not clamp["on"]:
            cur.update(x=x, y=y)

    fake_dll = types.SimpleNamespace(user32=types.SimpleNamespace(
        mouse_event=lambda *a: calls.append(("hwheel", a))))
    with Patch((mouse, "_virtual_bounds", lambda: (-1920, 0, 3840, 1080)),
               (pyag, "moveTo", move_to),
               (pyag, "position", lambda: types.SimpleNamespace(x=cur["x"], y=cur["y"])),
               (pyag, "scroll", lambda n: calls.append(("scroll", n))),
               (mouse, "ctypes", types.SimpleNamespace(windll=fake_dll))):
        r = mouse.mouse_scroll(-3, x=5000, y=100)
        check(r.get("ok") is False and "virtual desktop" in r.get("error", "") and not calls,
              f"mouse_scroll at an off-desktop point is refused before moving or scrolling (got {r})")
        r = mouse.scroll_at(-9999, 10, 3)
        check(r.get("ok") is False and "virtual desktop" in r.get("error", "") and not calls,
              "scroll_at at an off-desktop point is refused before moving or scrolling")
        r = mouse.mouse_scroll(2, x=100, y=-5, direction="horizontal")
        check(r.get("ok") is False and not calls, "horizontal scroll off-desktop is refused too (no wheel event)")

        r = mouse.mouse_scroll(2, x=-500, y=100)
        check(r.get("ok") is True and calls == [("move", -500, 100), ("scroll", 2)],
              f"a secondary-display point scrolls after moving there (calls {calls})")
        calls.clear()
        r = mouse.scroll_at(300, 200, -4)
        check(r.get("ok") is True and calls == [("move", 300, 200), ("scroll", -4)], "scroll_at on-desktop scrolls")
        calls.clear()
        r = mouse.mouse_scroll(1, x=10, y=10, direction="horizontal")
        check(r.get("ok") is True and ("hwheel", (0x01000, 0, 0, 120, 0)) in calls, "horizontal scroll sends the wheel event")
        calls.clear()
        r = mouse.mouse_scroll(5)
        check(r.get("ok") is True and calls == [("scroll", 5)], "no x/y: scrolls where the cursor already is")

        calls.clear()
        cur.update(x=0, y=0)
        clamp["on"] = True    # the OS keeps the cursor elsewhere (locked / clamped)
        r = mouse.mouse_scroll(-3, x=100, y=100)
        check(r.get("ok") is False and r.get("reached") is False and "did not land" in r.get("error", "")
              and ("scroll", -3) not in calls and r.get("actual_x") == 0,
              f"a cursor that does not land on the target gets NO wheel event (got {r}, calls {calls})")
        calls.clear()
        r = mouse.scroll_at(100, 100, 3)
        check(r.get("ok") is False and ("scroll", 3) not in calls, "scroll_at refuses likewise when the cursor did not land")


# ------------------------------------------------------------------------------------------------ 17
def _words(n):
    out = []
    for i in range(n):
        left = 10 + (i % 40) * 45
        top = 10 + (i // 40) * 24
        out.append({"text": "w%04d" % i, "left": left, "top": top, "width": 40, "height": 20,
                    "center": [left + 20, top + 10], "line": i // 40})
    return out


def test_ocr_full_matching():
    print("17 OCR: match against all words, cap only the response")
    n = 700
    words = _words(n)
    target = words[650]

    async def fake_recognize(_png, _lang):
        return {"success": True, "text": " ".join(w["text"] for w in words),
                "lines": [], "words": [dict(w, center=list(w["center"])) for w in words], "words_total": n}

    clicks = []
    pyag = sys.modules["pyautogui"]
    img = touch(os.path.join(_TMP, "ocr.png"), b"\x89PNG fake")
    with Patch((ocr, "_AVAILABLE", True), (ocr, "_screenshot_png", lambda region=None: b"png"),
               (ocr, "_recognize", fake_recognize), (pyag, "click", lambda x, y: clicks.append((x, y)))):
        r = asyncio.run(ocr.ocr_screen())
        check(r.get("success") and len(r["words"]) == 500 and r.get("truncated") is True and r.get("words_total") == n
              and r.get("hint") and r["text"].endswith("w0699"),
              "ocr_screen still returns at most 500 words, flags truncated/words_total, keeps the full text")
        small = ocr._cap_words({"success": True, "words": [1, 2, 3], "words_total": 3}, cap=5)
        check(small == {"success": True, "words": [1, 2, 3]}, "_cap_words leaves a short list alone (no truncated/words_total)")
        failed = ocr._cap_words({"ok": False, "error": "x"})
        check(failed == {"ok": False, "error": "x"}, "_cap_words leaves a failure result alone")

        r = asyncio.run(ocr.ocr_find_text("w0650"))
        check(r.get("found") is True and r.get("center") == {"x": target["center"][0], "y": target["center"][1]}
              and r.get("count") == 1,
              f"ocr_find_text finds a word past the 500th (got {r})")
        r = asyncio.run(ocr.ocr_find_text("w0650", click=True))
        check(r.get("clicked") is True and clicks == [tuple(target["center"])], "...and clicks it")
        clicks.clear()
        r = asyncio.run(ocr.ocr_click("w0650"))
        check(r.get("success") is True and clicks == [tuple(target["center"])],
              f"ocr_click clicks a word past the 500th (got {r.get('error') or r.get('clicked')})")
        r = asyncio.run(ocr.ocr_click("w0001"))
        check(r.get("success") is True and clicks[-1] == tuple(words[1]["center"]), "early words still match")

        r = asyncio.run(ocr.ocr_find_text("no-such-word"))
        check(r.get("found") is False and r.get("words_seen") == n and "truncated" not in r,
              f"a miss reports every word it searched (words_seen {r.get('words_seen')}), not a truncated list")

    async def fake_image(_png, _lang):
        return await fake_recognize(_png, _lang)

    with Patch((ocr, "_AVAILABLE", True), (ocr, "_recognize", fake_image)):
        r = asyncio.run(ocr.ocr_image(img))
        check(r.get("success") and len(r["words"]) == 500 and r.get("words_total") == n,
              f"ocr_image caps the same way (got {len(r.get('words', []))} words)")


# ------------------------------------------------------------------------------------------------ E
PRE = shell._PS_UTF8_PREAMBLE


def test_powershell_utf8_splice():
    print("E  run_command: PowerShell UTF-8 output preamble")
    f = shell._powershell_utf8_command
    check('"' not in PRE and "%" not in PRE and "&" not in PRE and "|" not in PRE and "^" not in PRE,
          "the preamble has no character cmd.exe or a quoted -Command text would trip over")
    check(f('powershell -NoProfile -Command "Get-ChildItem"') == 'powershell -NoProfile -Command "' + PRE + 'Get-ChildItem"',
          "quoted -Command text: preamble goes right after the opening quote")
    check(f('powershell.exe -c "x"') == 'powershell.exe -c "' + PRE + 'x"', "powershell.exe -c")
    check(f('POWERSHELL -command "x"') == 'POWERSHELL -command "' + PRE + 'x"', "case-insensitive")
    check(f('pwsh -NoLogo -NonInteractive -ExecutionPolicy Bypass -Command "x | y"')
          == 'pwsh -NoLogo -NonInteractive -ExecutionPolicy Bypass -Command "' + PRE + 'x | y"',
          "pwsh with several known switches (one takes a value)")
    check(f('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "x"')
          == '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "' + PRE + 'x"', "quoted full path to pwsh")
    check(f('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command "x"')
          == 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command "' + PRE + 'x"', "unquoted full path")
    check(f("powershell -Command Get-Date") == "powershell -Command " + PRE + " Get-Date", "unquoted -Command text")
    check(f("powershell Get-Date") == "powershell " + PRE + " Get-Date", "bare command text (implicit -Command)")
    check(f("powershell -NoProfile -WindowStyle Hidden -Command \"x\"")
          == "powershell -NoProfile -WindowStyle Hidden -Command \"" + PRE + "x\"", "-WindowStyle Hidden value skipped")
    for untouched in ("powershell -File a.ps1", "powershell -NoProfile -EncodedCommand AAAA",
                      "powershell -Command {Get-Date}", "powershell -Command -", "powershell -Command",
                      "powershell", "powershell -NoProfile", 'powershell -Version 2 -Command "x"',
                      'cmd /c powershell -Command "x"', 'cd x && powershell -Command "x"', "echo powershell",
                      "dir", "powershellx -Command x", "mypowershell -c x", "git status", ""):
        check(f(untouched) is None, f"left alone: {untouched!r}")

    g = shell._maybe_powershell_utf8
    cmd = 'powershell -Command "x"'
    check(g(cmd, None, is_windows=True) is not None, "Windows, no forced encoding: spliced")
    check(g(cmd, "gbk", is_windows=True) is None, "a forced encoding wins: command untouched")
    check(g(cmd, None, is_windows=False) is None, "not Windows: command untouched")

    # The workbench's own PowerShell tools use the same one-liner; keep the two from drifting.
    boot = os.path.join(_ROOT, "..", "..", "ruyi-workbench", "app", "src", "00-boot.js")
    if os.path.isfile(boot):
        import re
        m = re.search(r"const PS_UTF8_OUTPUT_PREAMBLE = '([^']*)';", open(boot, encoding="utf-8").read())
        check(bool(m) and m.group(1) == PRE, "same one-liner as the workbench's PS_UTF8_OUTPUT_PREAMBLE (00-boot.js)")
    else:
        print("  [skip] workbench source not next to this package")

    with Patch((shell, "_default_console_encoding", lambda: "utf-8")):
        r = shell.run_command("echo ACC-EDGE-OK")
        check(r.get("ok") is True and "ACC-EDGE-OK" in r.get("stdout", "") and "powershell_utf8" not in r,
              f"an ordinary command runs unchanged (got {r})")
    if os.name == "nt":
        r = shell.run_command('powershell -NoProfile -NonInteractive -Command "Write-Output ([string][char]0x4e2d)"')
        check(r.get("ok") is True and "中" in r.get("stdout", "") and r.get("powershell_utf8") is True,
              f"real PowerShell: a CJK character comes back as itself, not '?' (got {r})")
    else:
        print("  [skip] real PowerShell run (Windows only)")


def main() -> int:
    print("# desktop/file/OCR/shell edge-case smoke")
    try:
        test_launch_application()
        test_move_file_case_only()
        test_type_text_trailing_enter()
        test_scroll_bounds()
        test_ocr_full_matching()
        test_powershell_utf8_splice()
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)
    print()
    if _FAILURES:
        print(f"DESKTOP EDGES SMOKE: FAIL ({len(_FAILURES)})")
        for m in _FAILURES:
            print("  -", m)
        return 1
    print("DESKTOP EDGES SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
