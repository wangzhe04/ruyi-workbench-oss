"""Behavioral smoke test for v1.8.3 —— 评审挖出的四 bug 修复 + 审计值脱敏 + 写护栏补齐.

修复清单 (对应如意工作台 v1.7 评审 B 表 ACC 侧):
  B1 read_file        —— max_bytes 从「字符数」修正为真字节预算 (二进制读 +1 探测截断再解码)。
  B2 list_directory   —— 递归分支 1000 条封顶原本只 break 内层循环, 条目可超限; 现硬停并如实报 capped。
  B3 ocr_click        —— nth 越界原返回 ok:true + error 的自矛盾包络 (_normalize 信任显式 ok 键,
                        调用方会把失败的消歧当成成功); 现 ok:false (执行拒绝) + found:true (查询有果)。
  B4 launch_application —— wait=True 原本复用 2 秒 ready_timeout 当进程等待上限; 新增独立
                        wait_timeout (默认 120s, 钳 [1,600])。
  S1 audit            —— 值级脱敏: command/content 等良性键名的值里出现 password=/Bearer/sk-/JWT/ghp_
                        也会被擦除 (原先只按【键名】脱敏, 命令行口令原文落审计)。
  S2 window_screenshot / get_clipboard_image —— 输出路径补 protected 护栏 (与 write_file 族同一闸)。
  S3 installer/update.bat —— 双布局探测 (新 runtime\\python 优先, 旧 venv 兜底), 静态断言防回退。

Run with UTF-8:  python -X utf8 tests/smoke_v183.py
"""

import asyncio
import os
import sys
import tempfile
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = os.path.join(_ROOT, "src")
sys.path.insert(0, _SRC)

_DATA = os.path.join(tempfile.gettempdir(), "acc_smoke_v183_data")
os.makedirs(_DATA, exist_ok=True)
os.environ["WCW_DATA_DIR"] = _DATA

import ai_computer_control.server as server  # noqa: E402

_FNS = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
_FAILURES: list[str] = []


def check(cond: bool, msg: str):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def main() -> int:
    # ============================================================ ① read_file 字节语义
    print("== ① read_file: max_bytes 是真字节预算, truncated 不再误报 ==")
    cn = os.path.join(_DATA, "中文.txt")
    with open(cn, "w", encoding="utf-8") as f:
        f.write("汉" * 60)  # 60 字 = 180 字节 (UTF-8)

    r = _FNS["read_file"](path=cn, max_bytes=150)
    check(r.get("truncated") is True and len(r.get("content", "")) == 50,
          f"CJK 150 字节预算 → 50 字 + truncated (got {len(r.get('content', ''))} chars, trunc={r.get('truncated')})")

    r2 = _FNS["read_file"](path=cn, max_bytes=1_000_000)
    check(r2.get("truncated") is False and len(r2.get("content", "")) == 60,
          f"小 CJK 文件不再误报截断 (got trunc={r2.get('truncated')})")

    asc = os.path.join(_DATA, "ascii.txt")
    with open(asc, "w") as f:
        f.write("x" * 500)
    r3 = _FNS["read_file"](path=asc, max_bytes=100)
    check(r3.get("truncated") is True and len(r3.get("content", "")) == 100, "ASCII 语义不变 (截断)")
    r4 = _FNS["read_file"](path=asc, max_bytes=500)
    check(r4.get("truncated") is False and len(r4.get("content", "")) == 500, "恰好装满不误报截断")

    # ============================================================ ② list_directory 封顶
    print("\n== ② list_directory: 递归 1000 条硬封顶 + capped 如实标注 ==")
    big = os.path.join(_DATA, "big_tree")
    for d in range(5):
        os.makedirs(os.path.join(big, f"d{d}"), exist_ok=True)
        for i in range(300):
            with open(os.path.join(big, f"d{d}", f"f{i}.txt"), "w") as f:
                f.write("x")

    lr = _FNS["list_directory"](path=big, recursive=True)
    check(len(lr.get("entries", [])) == 1000 and lr.get("total") == 1000,
          f"递归封顶硬停于 1000 (got total={lr.get('total')})")
    check(lr.get("capped") is True, "递归封顶如实报 capped=true")

    lg = _FNS["list_directory"](path=big, pattern="*.txt", recursive=True)
    check(len(lg.get("entries", [])) == 1000 and lg.get("capped") is True,
          f"glob 分支封顶 + capped (got total={lg.get('total')})")

    small = _FNS["list_directory"](path=os.path.join(big, "d0"))
    check(small.get("capped") is None and small.get("total") == 300, "未封顶不带 capped 键")

    # An exactly-full tree is complete, not partial: root contributes one directory entry and its
    # child contributes 999 files. The recursive loop must only set capped after seeing item 1001.
    exact = os.path.join(_DATA, "exactly_1000")
    leaf = os.path.join(exact, "leaf")
    os.makedirs(leaf, exist_ok=True)
    for i in range(999):
        with open(os.path.join(leaf, f"f{i}.txt"), "w") as f:
            f.write("x")
    le = _FNS["list_directory"](path=exact, recursive=True)
    check(le.get("total") == 1000 and le.get("capped") is None,
          f"exactly 1000 entries are not falsely marked capped (got total={le.get('total')}, capped={le.get('capped')})")

    # ============================================================ ③ ocr_click nth 包络
    print("\n== ③ ocr_click: nth 越界 = ok:false 执行拒绝 + found:true 查询有果 ==")
    import ai_computer_control.tools.ocr as ocr_mod

    async def _fake_ocr_screen(region=None, lang=None):
        return {"success": True, "words": [
            {"text": "保存", "left": 10, "top": 10, "width": 20, "height": 10, "center": [20, 15]},
            {"text": "另存为", "left": 10, "top": 30, "width": 30, "height": 10, "center": [25, 35]},
        ]}

    old_avail, old_screen = ocr_mod._AVAILABLE, ocr_mod.ocr_screen
    ocr_mod._AVAILABLE = True
    ocr_mod.ocr_screen = _fake_ocr_screen
    try:
        r5 = asyncio.run(_FNS["ocr_click"](text="存", nth=7))
        check(r5.get("ok") is False, f"nth 越界 ok:false (got {r5.get('ok')})")
        check(r5.get("found") is True and r5.get("clicked") is None and r5.get("count") == 2,
              f"查询结果字段保留 (found/count/clicked) (got {r5})")
        check(bool(r5.get("error")) and "out of range" in r5["error"], f"人话错 (got {r5.get('error')!r})")
    finally:
        ocr_mod._AVAILABLE, ocr_mod.ocr_screen = old_avail, old_screen

    # ============================================================ ④ launch_application wait_timeout
    print("\n== ④ launch_application: wait 用独立 wait_timeout, 不再被 2 秒 ready_timeout 卡死 ==")
    t0 = time.monotonic()
    r6 = _FNS["launch_application"](path=sys.executable, args='-c "import time; time.sleep(3)"',
                                    wait=True, wait_timeout=15, ready_timeout=0)
    dt = time.monotonic() - t0
    check(r6.get("success") is True and r6.get("return_code") == 0 and dt >= 3,
          f"3 秒进程等到退出 ({dt:.1f}s, rc={r6.get('return_code')}) —— 旧码 2 秒必 timed_out")

    r7 = _FNS["launch_application"](path=sys.executable, args='-c "import time; time.sleep(30)"',
                                    wait=True, wait_timeout=2, ready_timeout=0)
    check(r7.get("timed_out") is True and r7.get("wait_timeout") == 2,
          f"wait_timeout=2 如实超时并回显预算 (got {r7})")
    try:  # 不泄漏 30 秒睡眠进程
        import psutil
        psutil.Process(r7["pid"]).kill()
    except Exception:
        pass

    # ============================================================ ⑤ audit 值脱敏
    print("\n== ⑤ audit: 值级脱敏 (命令行里的口令不进日志), 良性值不动 ==")
    from ai_computer_control.tools.audit import _summarize_args, _scrub_value

    cmd = ('net use \\\\srv\\c$ /user:admin password=Sup3rSecret! && '
           'curl -H "Authorization: Bearer abcdef1234567890" -d key=sk-livekey123456789')
    s = _summarize_args({"command": cmd})
    check("Sup3rSecret!" not in s, "password= 的值被擦除")
    check("abcdef1234567890" not in s, "Bearer 令牌被擦除 (generic key=value 不得先吃掉 Bearer 字样)")
    check("sk-livekey123456789" not in s, "sk- 密钥被擦除")
    check("password=***" in s and "Authorization=***" in s, f"键形状保留可读 (got {s})")

    jwt = _scrub_value("t=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5cE")
    check("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in jwt, "JWT 被擦除")
    gh = _scrub_value("git clone https://ghp_AbCdEfGh0123456789@github.com/x/y")
    check("ghp_AbCdEfGh0123456789" not in gh, "ghp_ 被擦除")

    s2 = _summarize_args({"path": "normal.txt", "content": "hello world"})
    check("hello world" in s2 and "normal.txt" in s2, "良性值原样保留")
    s3 = _summarize_args({"api_key": "whatever"})
    check("whatever" not in s3 and "***" in s3, "键名脱敏仍整值 ***")

    # ============================================================ ⑥ 输出路径 protected 护栏 (best-effort)
    print("\n== ⑥ window_screenshot / get_clipboard_image: 输出路径过 protected 护栏 ==")
    sysroot = os.environ.get("SystemRoot", r"C:\Windows")
    refuse_at = os.path.join(sysroot, "wcw_should_refuse.png")

    ws = _FNS["window_screenshot"](title_substring="", output_path=refuse_at)
    if ws.get("error") and "no visible window" in ws["error"]:
        print("  [skip] 无可见窗口 (headless?) —— 护栏接线不断言")
    else:
        check(ws.get("ok") is False and "refused" in (ws.get("error") or ""),
              f"window_screenshot 写 SystemRoot 被拒 (got {ws.get('error')!r})")
        check(not os.path.exists(refuse_at), "被拒后无落盘文件")

    # 剪贴板有图才能测 save_path 护栏: 先放一张图 (STA PowerShell, 无桌面会话则 skip)
    png = os.path.join(_DATA, "clip.png")
    from PIL import Image
    Image.new("RGB", (8, 8), (1, 2, 3)).save(png)
    sc = _FNS["set_clipboard_image"](path=png)
    if not sc.get("success"):
        print(f"  [skip] 无剪贴板环境 ({sc.get('error')}) —— get_clipboard_image 护栏不断言")
    else:
        gc = _FNS["get_clipboard_image"](save_path=refuse_at)
        check(bool(gc.get("error")) and "refused" in gc["error"],
              f"get_clipboard_image 写 SystemRoot 被拒 (got {gc.get('error')!r})")
        check(not os.path.exists(refuse_at), "被拒后无落盘文件")

    # ============================================================ ⑦ update.bat 双布局 (静态)
    print("\n== ⑦ installer/update.bat: 新旧两种安装布局探测 (静态锁) ==")
    bat = os.path.join(_ROOT, "installer", "update.bat")
    with open(bat, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    check("runtime\\python\\python.exe" in src, "探测新布局 runtime\\python")
    check("venv\\Scripts\\python.exe" in src, "保留旧布局 venv 兜底")
    check("runtime\\python\\Lib\\site-packages\\ai_computer_control" in src,
          "新布局 site-packages 路径正确")

    # ---------------------------------------------------------------- summary
    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        print("ACC-V183 SMOKE: FAIL")
        return 1
    print("ACC-V183 SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
