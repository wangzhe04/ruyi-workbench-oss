"""Behavioral smoke test for v1.5: the write_pdf tool.

Covers the three contracted paths:
  (1) reportlab AVAILABLE  -> write_pdf renders a Chinese title + body + table into a real PDF;
      assert the file exists, starts with the %PDF- magic, pdfplumber reads the Chinese markers
      back (proving the CJK font chain actually rendered glyphs, not tofu boxes), pages>=1, and
      font is a real CJK font (not the Helvetica last-resort fallback — this box ships msyh.ttc).
  (2) reportlab MISSING    -> write_pdf degrades to {error: <install guidance>} without crashing.
      Simulated in a child process via a sys.meta_path finder that blocks `import reportlab`.
  (3) path not ending .pdf -> {error: ...}.

Run with UTF-8:  python -X utf8 tests/smoke_v15.py

Uses a throwaway data dir (WCW_DATA_DIR) so it never touches real logs/config.
Prints per-check PASS/FAIL, an exact verdict line, and exits non-zero on any failure.
"""

import os
import subprocess
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = os.path.join(_ROOT, "src")
sys.path.insert(0, _SRC)

# Isolate data dir BEFORE importing the server (safety.json + audit log live here).
_DATA = os.path.join(tempfile.gettempdir(), "acc_smoke_v15_data")
os.makedirs(_DATA, exist_ok=True)
os.environ["WCW_DATA_DIR"] = _DATA

import ai_computer_control.server as server  # noqa: E402

_FNS = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
_FAILURES: list[str] = []

# Unique Chinese markers we will look for on readback — presence proves the CJK font chain
# actually rendered these glyphs (a broken/absent font would emit tofu / drop them).
_MARK_TITLE = "如意测试报告"
_MARK_SECTION = "第一节"
_MARK_TABLE = "数据表列"


def check(cond: bool, msg: str):
    status = "ok  " if cond else "FAIL"
    print(f"  [{status}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def main() -> int:
    print("== write_pdf is registered (v1.5) ==")
    check("write_pdf" in _FNS, "write_pdf present in the tool registry")
    if "write_pdf" not in _FNS:
        print("\nACC-V15 SMOKE: FAIL (write_pdf not registered)")
        return 1

    # Confirm reportlab is importable in THIS process (path 1 requires it). If it is genuinely
    # absent here, path 1 can't run — report and skip it rather than falsely fail.
    try:
        import reportlab  # noqa: F401
        reportlab_present = True
    except Exception:
        reportlab_present = False

    print("\n== (1) reportlab AVAILABLE: Chinese title + body + table render into a real PDF ==")
    if not reportlab_present:
        print("  SKIP path (1) — reportlab not importable in this process (install it to exercise the render path).")
    else:
        out_pdf = os.path.join(_DATA, "ruyi_v15_report.pdf")
        if os.path.exists(out_pdf):
            os.remove(out_pdf)
        res = _FNS["write_pdf"](
            path=out_pdf,
            title=_MARK_TITLE,
            content=(
                f"# {_MARK_SECTION}\n"
                "这是正文，用于验证中文字体链真的把汉字渲染成字形而不是方块。\n"
                "- 圆点条目：离线导出\n"
                "1. 编号条目：中文断行\n"
                "\n"
                "## 小节标题\n"
                "结尾正文。"
            ),
            table_headers=[_MARK_TABLE, "数值"],
            table_data=[["收入", "1234"], ["支出", "567"]],
            page_size="A4",
        )
        check(isinstance(res, dict) and res.get("ok") is True and res.get("success") is True,
              f"write_pdf -> ok/success True (got {res})")
        check(res.get("error") is None, f"write_pdf carried no error (got {res.get('error')})")
        check(os.path.exists(out_pdf), "output .pdf file exists on disk")

        # %PDF- magic number.
        magic_ok = False
        if os.path.exists(out_pdf):
            with open(out_pdf, "rb") as fh:
                magic_ok = fh.read(5) == b"%PDF-"
        check(magic_ok, "output file starts with the %PDF- magic")

        check(isinstance(res.get("pages"), int) and res.get("pages") >= 1,
              f"pages >= 1 (got {res.get('pages')})")
        # This box ships msyh.ttc, so we must NOT be on the Helvetica last-resort fallback.
        check(res.get("font") and res.get("font") != "Helvetica",
              f"font is a real CJK font, not the Helvetica fallback (got {res.get('font')})")
        check("warning" not in res,
              f"no font warning when a CJK font is available (got {res.get('warning')})")

        # pdfplumber readback: the Chinese markers must come back out — proof of real glyph rendering.
        try:
            import pdfplumber
            with pdfplumber.open(out_pdf) as pdf:
                text = "".join((p.extract_text() or "") for p in pdf.pages)
                page_count = len(pdf.pages)
            check(_MARK_TITLE in text, f"readback contains the Chinese TITLE '{_MARK_TITLE}'")
            check(_MARK_SECTION in text, f"readback contains the Chinese SECTION '{_MARK_SECTION}'")
            check(_MARK_TABLE in text, f"readback contains the Chinese TABLE header '{_MARK_TABLE}'")
            check("收入" in text and "支出" in text, "readback contains the table body cells (收入/支出)")
            check(page_count >= 1, f"pdfplumber sees >= 1 page (got {page_count})")
            print("     font used:", res.get("font"), "| pages:", res.get("pages"),
                  "| readback sample:", repr(text[:60]))
        except Exception as e:  # noqa: BLE001
            check(False, f"pdfplumber readback raised: {e}")

    # (1b) 把关人加断言:用户文本里的 & / < / > 必须被转义后按字面渲染(reportlab Paragraph 解析
    # mini-HTML,未转义的 "R&D"/"<url>" 会异常或被吞)。gate-fix 与断言同批落地,防回潮。
    print("\n== (1b) special characters (& < >) are escaped and render literally ==")
    if not reportlab_present:
        print("  SKIP path (1b) — reportlab not importable in this process.")
    else:
        sp_pdf = os.path.join(_DATA, "ruyi_v15_special.pdf")
        if os.path.exists(sp_pdf):
            os.remove(sp_pdf)
        sp = _FNS["write_pdf"](
            path=sp_pdf,
            title="特殊字符 R&D",
            content="# 含标记的正文\n访问 <url> 与 R&D 部门，3>2 且 1<2。",
            table_headers=["项目 A&B", "值"],
            table_data=[["<比较>", "3>2"]],
        )
        check(isinstance(sp, dict) and sp.get("success") is True,
              f"write_pdf with &/</> -> success, not error (got {sp})")
        try:
            import pdfplumber
            with pdfplumber.open(sp_pdf) as pdf:
                sp_text = "".join((p.extract_text() or "") for p in pdf.pages)
            check("R&D" in sp_text, "readback contains literal 'R&D'")
            check("<url>" in sp_text, "readback contains literal '<url>'")
            check("A&B" in sp_text, "readback contains table header literal 'A&B'")
        except Exception as e:  # noqa: BLE001
            check(False, f"special-char readback raised: {e}")

    print("\n== (2) reportlab MISSING: write_pdf degrades to an install-guiding error, never crashes ==")
    # Run the tool in a child process where `import reportlab` is blocked by a meta_path finder.
    child = r'''
import os, sys, tempfile
# Block reportlab (and submodules) at import time to simulate an offline box without it.
class _Block:
    def find_module(self, name, path=None):
        if name == "reportlab" or name.startswith("reportlab."):
            return self
        return None
    def load_module(self, name):
        raise ImportError("blocked for test: " + name)
    # importlib (find_spec) path too, for completeness.
    def find_spec(self, name, path=None, target=None):
        if name == "reportlab" or name.startswith("reportlab."):
            raise ImportError("blocked for test: " + name)
        return None
sys.meta_path.insert(0, _Block())
sys.modules.pop("reportlab", None)

os.environ["WCW_DATA_DIR"] = tempfile.mkdtemp(prefix="acc_v15_noreportlab_")
import ai_computer_control.server as server
fns = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
out = os.path.join(os.environ["WCW_DATA_DIR"], "should_not_exist.pdf")
res = fns["write_pdf"](path=out, content="# 标题\n正文")
err = res.get("error", "")
ok = (isinstance(res, dict)
      and res.get("ok") is False
      and bool(err)
      and ("reportlab" in err)
      and ("installer" in err or "pip install" in err))
print("DEGRADE_OK" if ok else "DEGRADE_FAIL")
print("ERR=" + str(err))
'''
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [sys.executable, "-X", "utf8", "-c", child],
        capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    stdout = proc.stdout or ""
    degrade_ok = "DEGRADE_OK" in stdout
    check(degrade_ok, "write_pdf without reportlab -> ok:False with install guidance (no crash)")
    if not degrade_ok:
        print("     child stdout:", stdout.strip()[:400])
        print("     child stderr:", (proc.stderr or "").strip()[:400])
    else:
        # Echo the degraded error line for the record.
        for line in stdout.splitlines():
            if line.startswith("ERR="):
                print("    ", line[:200])

    print("\n== (3) path not ending in .pdf -> error, no file written ==")
    bad = _FNS["write_pdf"](path=os.path.join(_DATA, "not_a_pdf.txt"), content="# x")
    check(isinstance(bad, dict) and bad.get("ok") is False and bool(bad.get("error")),
          f"non-.pdf path -> ok:False + error (got {bad})")
    check(".pdf" in str(bad.get("error", "")).lower(),
          f"error mentions the .pdf requirement (got {bad.get('error')})")

    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        print("ACC-V15 SMOKE: FAIL")
        return 1
    print("ACC-V15 SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
