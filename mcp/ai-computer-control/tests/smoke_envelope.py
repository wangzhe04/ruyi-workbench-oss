"""Envelope / audit / run_command-output smoke (server-surface hardening, audit report acc-server A5/A13 + F7).

Pins, all in-process and offline:
  ① error envelope: ``{"error": ""}`` is a FAILURE with a non-empty message (used to read as ok:true); an
     exception with an empty ``str(e)`` still names its type; failures get a next-step ``hint``;
  ② audit log: ok/error/ms recorded, args stored as a JSON object (not double-encoded), size-based rotation
     and bounded retention, tail reads across rotated files, by-name audit of the previously unaudited
     mutators (write_document/write_excel/write_pdf/fetch/browser_*);
  ③ run_command output: UTF-8 decodes as UTF-8 even when the console code page is GBK (and real GBK still
     falls back), a runaway stream comes back bounded (head + tail + omitted marker, status first, stderr
     before stdout), chunk cuts never split a character;
  ④ launch_application never polls for a window unboundedly;
  ⑤ playwright / reportlab are NOT imported at server start, yet ``_AVAILABLE`` still reports them truthfully.

Run with UTF-8:  python -X utf8 tests/smoke_envelope.py
"""

import io
import json
import os
import shlex
import subprocess
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))

_DATA = os.path.join(tempfile.gettempdir(), "acc_smoke_envelope_data")
os.makedirs(_DATA, exist_ok=True)
os.environ["WCW_DATA_DIR"] = _DATA

import ai_computer_control.server as server  # noqa: E402
import ai_computer_control.tools.audit as audit  # noqa: E402
import ai_computer_control.tools.shell as shell  # noqa: E402
from ai_computer_control.paths import logs_dir  # noqa: E402

_FAILURES: list[str] = []


def check(cond, msg):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def _cmd(args):
    return subprocess.list2cmdline(args) if os.name == "nt" else shlex.join(args)


def _clean_logs():
    d = logs_dir()
    for fn in os.listdir(d):
        if fn.startswith("audit-"):
            os.remove(os.path.join(d, fn))
    getattr(audit, "_pruned_dirs", set()).discard(d)


def envelope():
    print("== ① 错误信封 ==")

    @server.mcp.tool()
    def zz_empty_error() -> dict:
        """probe"""
        return {"error": ""}

    @server.mcp.tool()
    def zz_none_error() -> dict:
        """probe"""
        return {"error": None, "value": 1}

    @server.mcp.tool()
    def zz_raises_empty() -> dict:
        """probe"""
        raise KeyError()

    @server.mcp.tool()
    def zz_denied() -> dict:
        """probe"""
        return {"error": "PermissionError: [WinError 5] Access is denied: 'C:\\\\x'"}

    @server.mcp.tool()
    def zz_own_hint() -> dict:
        """probe"""
        return {"error": "Access is denied", "hint": "mine"}

    r = zz_empty_error()
    check(r.get("ok") is False and bool(str(r.get("error", "")).strip()),
          f'{{"error": ""}} is a failure with a non-empty message (got {r})')
    r = zz_none_error()
    check(r.get("ok") is True and r.get("value") == 1, f'"error": None (no error) stays ok:true (got {r})')
    r = zz_raises_empty()
    check(r.get("ok") is False and r.get("error", "").startswith("KeyError"),
          f"exception with empty str(e) still names its type (got {r})")
    r = zz_denied()
    check(r.get("ok") is False and "Access denied" in r.get("hint", ""),
          f"access-denied failure gets a next-step hint (got {r.get('hint')!r})")
    check(zz_own_hint().get("hint") == "mine", "a tool's own hint is never overwritten")

    from ai_computer_control.utils.errors import _HINTS, exc_text, hint_for
    check(len(_HINTS) >= 15, f"central hint table covers >=15 failure classes (has {len(_HINTS)})")
    samples = {
        "Window not found: Notepad": "list_windows",
        "screen grab failed": "locked",
        "FailSafeException: fail-safe triggered": "fail-safe",
        "PermissionError: [WinError 32] The process cannot access the file because it is being used by another process": "Close it",
        "PermissionError: [Errno 13] Permission denied": "Access denied",
        "ModuleNotFoundError: No module named 'pptx'": "diagnostics",
        "FileNotFoundError: [Errno 2] No such file or directory: 'a'": "list_directory",
        "IsADirectoryError: [Errno 21] Is a directory": "folder",
        "NotADirectoryError: [WinError 267]": "directory",
        "UnicodeDecodeError: 'utf-8' codec can't decode byte": "encoding",
        "zipfile.BadZipFile: File is not a zip file": "valid Office",
        "Target page, context or browser has been closed": "browser_open",
        "TimeoutError: timed out": "retry",
        "coordinates out of range": "get_screen_info",
        "OSError: [Errno 28] No space left on device": "full",
    }
    bad = [k for k, want in samples.items() if want.lower() not in (hint_for(k) or "").lower()]
    check(not bad, f"every hint class fires on a representative message (miss: {bad})")
    # table-driven: (tool, error text) -> substring the hint must contain, or None for "no hint at all"
    table = [
        (None, "nth=5 out of range (0..2)", None),
        (None, "page 9 out of range (1..3)", None),
        (None, "Sheet index out of range", None),
        (None, "tab index 3 out of range (0..1)", None),
        (None, "x=99999 out of range for the screen", "get_screen_info"),
        (None, "click target (9999,9999) is outside the virtual desktop (x 0..1919)", "get_screen_info"),
        ("fetch", "fetch failed: Connection closed by remote host", None),
        ("browser_click", "Connection closed while waiting", "browser_open"),
        ("browser_click", "Target page, context or browser has been closed", "browser_open"),
        ("ocr_text", "ocr recognize timed out (>45s); the language pack may be corrupt or the image too large.",
         "timed out"),
        ("read_document", "file contains 12 corrupt rows", None),
        ("read_document", "zipfile.BadZipFile: File is not a zip file", "valid Office"),
        ("read_document", "the workbook is corrupt", "valid Office"),
        (None, "network is not available", None),
        (None, "OCR language pack not available for 'ja'", None),
        (None, "ModuleNotFoundError: No module named 'pptx'", "Retrying will not help"),
    ]
    wrong = []
    for tool, text, want in table:
        got = hint_for(text, tool)
        if (want is None and got) or (want is not None and want.lower() not in (got or "").lower()):
            wrong.append((tool, text[:40], (got or "-")[:30]))
    check(not wrong, f"hint_for is anchored: no misleading hints on look-alike messages (wrong: {wrong})")
    check("retrying will not help" not in (hint_for("service not available, try later") or "").lower(),
          "a transient 'not available' never says retrying will not help")
    r = server._normalize({"error": "fetch failed: Connection closed by remote host"}, "fetch")
    check("hint" not in r, f"_normalize passes the tool name through to the hint table (got {r.get('hint')!r})")
    check(exc_text(TimeoutError()) == "TimeoutError" and exc_text(ValueError("x")) == "ValueError: x",
          "exc_text names the type and never yields an empty string")


def audit_log():
    print("== ② 审计日志 ==")
    _clean_logs()
    audit.log_action("write_file", {"path": "a.txt", "content": "x", "password": "hunter2"}, False,
                     error="PermissionError: nope password=abc123", ms=42)
    recs = server_tail(5)
    r = recs[-1] if recs else {}
    check(r.get("tool") == "write_file" and r.get("ok") is False and r.get("ms") == 42,
          f"record carries tool/ok/ms (got {r})")
    check("error" in r and "abc123" not in r["error"] and "PermissionError" in r["error"],
          f"failure reason recorded and scrubbed (error={r.get('error')!r})")
    check(isinstance(r.get("args"), dict) and r["args"].get("path") == "a.txt" and r["args"].get("password") == "***",
          f"args stored as a redacted object, not a JSON string (args={r.get('args')!r})")

    # by-name audit of the previously unaudited mutators — through the real wrapper, not a copy.
    must = {"write_document", "write_excel", "write_pdf", "fetch", "browser_open", "browser_click",
            "browser_type", "browser_navigate", "get_environment_variable", "message_box", "show_notification"}
    check(must <= set(server._AUDITED_BY_NAME), f"policy set covers {sorted(must - set(server._AUDITED_BY_NAME))} missing")
    names = {t.name for t in server.mcp._tool_manager.list_tools()}
    check(server._AUDITED_BY_NAME <= names, f"no stale names in the audit policy: {sorted(server._AUDITED_BY_NAME - names)}")

    server._AUDITED_BY_NAME = frozenset(server._AUDITED_BY_NAME | {"zz_by_name"})

    @server.mcp.tool()
    def zz_by_name(path: str = "p") -> dict:
        """probe"""
        return {"error": "boom"}

    _clean_logs()
    zz_by_name(path="q.docx")
    recs = server_tail(5)
    check(any(x.get("tool") == "zz_by_name" and x.get("ok") is False and x.get("error") == "boom"
              and x.get("args", {}).get("path") == "q.docx" for x in recs),
          f"a tool audited only by name is logged with outcome (got {recs})")

    # rotation + retention
    _clean_logs()
    old_max, old_keep = audit._MAX_FILE_BYTES, audit._KEEP_FILES
    audit._MAX_FILE_BYTES, audit._KEEP_FILES = 600, 3
    try:
        for i in range(60):
            audit.log_action("edit_file", {"path": f"f{i}.txt"}, True, ms=1)
        files = audit._audit_files(logs_dir())
        check(1 < len(files) <= 3, f"log rotates by size and keeps only the newest N files (files={files})")
        recs = server_tail(1000)
        check(recs and recs[-1]["args"]["path"] == "f59.txt", "audit_tail returns the newest record after rotation")
        check(all(os.path.getsize(os.path.join(logs_dir(), f)) < 2000 for f in files), "no file grows unbounded")
    finally:
        audit._MAX_FILE_BYTES, audit._KEEP_FILES = old_max, old_keep
    # tail across several files, in chronological order
    _clean_logs()
    audit._MAX_FILE_BYTES = 400
    try:
        for i in range(30):
            audit.log_action("edit_file", {"path": f"g{i:02d}"}, True)
    finally:
        audit._MAX_FILE_BYTES = old_max
    recs = server_tail(12)
    paths = [x["args"]["path"] for x in recs]
    check(paths == [f"g{i:02d}" for i in range(18, 30)], f"tail spans rotated files in order (got {paths})")
    _clean_logs()


def server_tail(n):
    fn = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}["audit_tail"]
    return fn(n=n).get("records", [])


def run_command_output():
    print("== ③ run_command 输出 ==")
    check(shell._decode("构建成功".encode("utf-8"), "cp936") == "构建成功",
          "UTF-8 output decodes as UTF-8 even when the console code page is cp936")
    check(shell._decode("中文内容".encode("gbk"), "cp936") == "中文内容", "real GBK bytes still fall back to the OEM page")
    check(shell._decode("中文".encode("gbk"), "cp936", enc_first=True) == "中文", "explicit encoding is honoured first")

    orig = shell._default_console_encoding
    shell._default_console_encoding = lambda: "cp936"
    try:
        fn = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}["run_command"]
        r = fn(command=_cmd([sys.executable, "-c",
                             "import sys; sys.stdout.buffer.write('构建成功'.encode('utf-8'))"]), timeout=20)
        check("构建成功" in r.get("stdout", ""), f"UTF-8 child output is not mojibake (got {r.get('stdout')!r})")
        r = fn(command=_cmd([sys.executable, "-c",
                             "import sys; sys.stdout.buffer.write('中文内容'.encode('gbk'))"]), timeout=20)
        check("中文内容" in r.get("stdout", ""), f"GBK child output still decodes via the OEM page (got {r.get('stdout')!r})")

        code = ("import sys\n"
                "for i in range(5000): print('line %06d of a very long build log' % i)\n"
                "sys.stderr.write('ERR-LINE-AT-END\\n')\n"
                "print('TAIL-MARKER-LINE')\n")
        r = fn(command=_cmd([sys.executable, "-c", code]), timeout=60)
        blob = json.dumps(r, ensure_ascii=False)
        keys = list(r)
        check(len(blob) < 40000, f"runaway output stays well under the host cut ({len(blob)} chars)")
        check("TAIL-MARKER-LINE" in r.get("stdout", "") and "ERR-LINE-AT-END" in r.get("stderr", ""),
              "the tail (where errors live) survives")
        check("omitted" in r.get("stdout", "") and r.get("stdout_truncated") is True and r.get("hint"),
              "explicit omitted-marker, truncation flag and hint present")
        check(keys.index("ok") < keys.index("stdout_truncated") < keys.index("stderr") < keys.index("stdout"),
              f"status fields first, stderr before stdout (order={keys})")
        r2 = fn(command=_cmd([sys.executable, "-c", code]), timeout=60, max_output_chars=200000)
        check("omitted" not in r2.get("stdout", "") and len(r2["stdout"]) > 100000,
              "max_output_chars raises the budget")
    finally:
        shell._default_console_encoding = orig

    # A cut in the middle of a multibyte character must not poison the chunk.
    data = ("汉字构建输出" * 5000).encode("utf-8")  # 180 KB -> far beyond the read window of a 1000-char budget
    text, cut, size = shell._read_capture(io.BytesIO(data), "cp936", 1000)
    check(cut and "\ufffd" not in text and "bytes omitted" in text and size == len(data),
          "large stream: head/tail cut on character boundaries, no U+FFFD")


def launch_bounds():
    print("== ④ launch_application 有界 ==")
    import ai_computer_control.tools.application as app
    seen = []
    orig = app._find_window_for_pid
    app._find_window_for_pid = lambda pid, timeout: seen.append(timeout)
    try:
        fn = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}["launch_application"]
        r = fn(path=sys.executable, args="-c pass", ready_timeout=1e9)
        check(seen and seen[0] <= 60, f"window poll is clamped (asked 1e9s, used {seen}) result={str(r)[:80]}")
    finally:
        app._find_window_for_pid = orig


def lazy_imports():
    print("== ⑤ 重依赖惰性导入 ==")
    # playwright / reportlab are this surface's; matplotlib / pptx (Office modules) and cv2 (vision; pyautogui's
    # pyscreeze imports cv2 eagerly anyway) are made lazy by their owners — reported here, not enforced.
    heavy = [m for m in ("playwright", "reportlab") if m in sys.modules]
    check(not heavy, f"server import 不再加载 {heavy or 'playwright/reportlab'}")
    late = [m for m in ("matplotlib", "pptx", "cv2") if m in sys.modules]
    if late:
        print(f"  [info] 仍在 import 时加载: {late} (各模块 owner 负责惰性化)")
    import importlib.util as iu
    import ai_computer_control.tools.browser as browser
    check(browser._AVAILABLE == (iu.find_spec("playwright") is not None),
          f"playwright: _AVAILABLE 与安装状态一致 ({browser._AVAILABLE})")
    check(browser.async_playwright is None, "async_playwright 在首次启动浏览器前未导入(惰性)")


def main():
    for step in (lazy_imports, envelope, audit_log, run_command_output, launch_bounds):
        step()
    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        print("ACC-ENVELOPE SMOKE: FAIL")
        return 1
    print("ACC-ENVELOPE SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
