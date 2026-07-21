"""Behavioral smoke test for v1.9.0 —— 生态工具首批 (第49波 49a).

新增 7 工具:
  edit_file            —— 局部精确替换 (唯一性安全闸 / replace_all / 编码回环 / protected 护栏)
  fetch                —— http(s) 抓取 + SSRF 防护 (私网/回环拒绝, 逐跳重定向重校验, 字节预算)
  memory_save/read/list/delete —— 独立持久记忆 (tmp+rename, 腐败隔离, 上限/截断)
  sequential_thinking  —— 链式思考记录 (修订/分支/参数校验)

fetch 网络层零外网依赖: SSRF 判定 (_check_url/_is_public_ip) 直接单测; 重定向/截断/解码
用 monkeypatched _fetch_once 剧本; 本机回环真实 server 仅在 _check_url 被替换后验证传输路径。

Run with UTF-8:  python -X utf8 tests/smoke_v19.py
"""

import json
import os
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = os.path.join(_ROOT, "src")
sys.path.insert(0, _SRC)

_DATA = os.path.join(tempfile.gettempdir(), "acc_smoke_v19_data")
os.makedirs(_DATA, exist_ok=True)
os.environ["WCW_DATA_DIR"] = _DATA

import ai_computer_control.server as server  # noqa: E402
import ai_computer_control.tools.web_fetch as wf  # noqa: E402
import ai_computer_control.tools.thinking as think  # noqa: E402

_FNS = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
_FAILURES: list[str] = []


def check(cond: bool, msg: str):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def main() -> int:
    # ============================================================ ① edit_file
    print("== ① edit_file: 唯一替换 / 不唯一拒 / replace_all / 编码回环 / protected ==")
    target = os.path.join(_DATA, "edit_me.py")
    with open(target, "w", encoding="utf-8") as f:
        f.write("def foo():\n    return 1\n\ndef bar():\n    return 1\n")

    r = _FNS["edit_file"](path=target, old_string="def foo():\n    return 1", new_string="def foo():\n    return 42")
    check(r.get("success") is True and r.get("replacements") == 1, f"唯一替换成功 (got {r})")
    with open(target, encoding="utf-8") as f:
        body = f.read()
    check("return 42" in body and "def bar():\n    return 1" in body, "只改了目标段, 其余原样")

    # 不唯一/replace_all 用独立文件 (target 首次编辑后 "return 1" 已只剩 1 处)
    dup = os.path.join(_DATA, "dup.txt")
    with open(dup, "w", encoding="utf-8") as f:
        f.write("x = 1\ny = 0\nx = 1\n")
    r2 = _FNS["edit_file"](path=dup, old_string="x = 1", new_string="x = 2")
    check(r2.get("ok") is False and "不唯一" in (r2.get("error") or ""), f"不唯一拒绝 (got {r2.get('error')!r})")

    r3 = _FNS["edit_file"](path=dup, old_string="x = 1", new_string="x = 2", replace_all=True)
    check(r3.get("success") is True and r3.get("replacements") == 2, f"replace_all 全替换 2 处 (got {r3})")
    with open(dup, encoding="utf-8") as f:
        check(f.read() == "x = 2\ny = 0\nx = 2\n", "replace_all 后其余行原样")

    r4 = _FNS["edit_file"](path=target, old_string="不存在的字符串xyz", new_string="y")
    check(r4.get("ok") is False and "未出现" in (r4.get("error") or ""), f"0 次出现拒绝 (got {r4.get('error')!r})")

    r5 = _FNS["edit_file"](path=os.path.join(_DATA, "nope.txt"), old_string="a", new_string="b")
    check(r5.get("ok") is False and "not found" in (r5.get("error") or ""), "缺失文件人话拒 + 指向 write_file")

    r6 = _FNS["edit_file"](path=target, old_string="x", new_string="x")
    check(r6.get("ok") is False and "完全相同" in (r6.get("error") or ""), "old==new 空改动拒")

    # CJK 内容编辑回环 (编码不丢字)
    cjk = os.path.join(_DATA, "中文编辑.txt")
    with open(cjk, "w", encoding="utf-8") as f:
        f.write("标题: 旧名字\n正文保持\n")
    r7 = _FNS["edit_file"](path=cjk, old_string="旧名字", new_string="新名字")
    with open(cjk, encoding="utf-8") as f:
        cjk_body = f.read()
    check(r7.get("success") is True and "新名字" in cjk_body and "正文保持" in cjk_body, "CJK 编辑编码回环")

    sysroot = os.environ.get("SystemRoot", r"C:\Windows")
    r8 = _FNS["edit_file"](path=os.path.join(sysroot, "x.ini"), old_string="a", new_string="b")
    check(r8.get("ok") is False and "refused" in (r8.get("error") or ""), f"protected 护栏 (got {r8.get('error')!r})")

    # ============================================================ ② fetch SSRF 判定 (直测, 零网络)
    print("\n== ② fetch: SSRF 判定 (私网/回环/映射地址拒绝, 公网放行) ==")
    for bad in ("http://127.0.0.1/x", "http://localhost/x", "http://192.168.1.1/",
                "http://10.0.0.5/", "http://169.254.1.1/", "http://[::1]/",
                "http://[::ffff:127.0.0.1]/", "ftp://example.com/f", "file:///c:/windows/win.ini"):
        err = wf._check_url(bad)
        check(err is not None, f"refused: {bad}")

    check(wf._is_public_ip("8.8.8.8") is True, "8.8.8.8 判公网")
    check(wf._is_public_ip("1.1.1.1") is True and wf._is_public_ip("203.0.113.7") is False,
          "203.0.113.0/24 (TEST-NET-3 保留段) 判非公网")

    # ============================================================ ③ fetch 行为 (monkeypatch 剧本)
    print("\n== ③ fetch: 重定向逐跳重校验 / 截断 / 解码 / 错误包络 ==")
    # 公网判定放行 (example.com 是保留域名, _check_url 会 DNS; 直接 stub _check_url 放行)
    old_check, old_once = wf._check_url, wf._fetch_once
    calls = []

    def fake_check(url):
        calls.append(url)
        # 模拟: 重定向到内网的 hop 必须被拒 —— 第 3 跳回到 127.0.0.1
        if "127.0.0.1" in url:
            return "refused: 目标主机 127.0.0.1 指向本机/内网(SSRF 防护)。"
        return None

    def fake_once(url, timeout, max_bytes):
        if url.endswith("/step1"):
            return 302, {"Location": "http://example.com/step2"}, b"", None
        if url.endswith("/step2"):
            return 302, {"Location": "http://127.0.0.1/steal"}, b"", None
        if url.endswith("/big"):
            return 200, {"Content-Type": "text/plain; charset=utf-8"}, b"x" * (max_bytes + 50), None
        if url.endswith("/gbk"):
            return 200, {"Content-Type": "text/html; charset=gbk"}, "中文标题".encode("gbk"), None
        if url.endswith("/404"):
            return 404, {"Content-Type": "text/html"}, b"not here", None
        return 200, {"Content-Type": "text/plain; charset=utf-8"}, b"hello", None

    wf._check_url, wf._fetch_once = fake_check, fake_once
    try:
        r9 = _FNS["fetch"](url="http://example.com/step1")
        check(r9.get("ok") is False and "refused" in (r9.get("error") or ""),
              f"重定向到内网被第 3 跳拦截 (got {r9.get('error')!r})")
        check("http://127.0.0.1/steal" in calls, "每一跳都过了 _check_url 重校验")

        r10 = _FNS["fetch"](url="http://example.com/big", max_bytes=1000)
        check(r10.get("ok") is True and r10.get("truncated") is True and len(r10.get("content", "")) == 1000,
              f"字节预算截断 (got bytes={r10.get('bytes')}, truncated={r10.get('truncated')})")

        r11 = _FNS["fetch"](url="http://example.com/gbk")
        check(r11.get("ok") is True and "中文标题" in r11.get("content", ""), "gbk charset 按声明解码")

        r12 = _FNS["fetch"](url="http://example.com/404")
        check(r12.get("ok") is True and r12.get("status") == 404, "HTTP 错误状态如实回传 (非执行失败)")

        r13 = _FNS["fetch"](url="http://example.com/plain")
        check(r13.get("ok") is True and r13.get("content") == "hello" and r13.get("redirects") == 0, "直通 200")
    finally:
        wf._check_url, wf._fetch_once = old_check, old_once

    # ============================================================ ④ memory
    print("\n== ④ memory: save/read/list/delete 全路径 + 覆盖 + 搜索 ==")
    mpath = os.path.join(_DATA, "memory.json")
    if os.path.exists(mpath):
        os.remove(mpath)

    r = _FNS["memory_save"](key="editor-pref", content="用户偏好 VS Code, 深色主题", tags="preference,editor")
    check(r.get("success") is True and r.get("overwritten") is False, f"首存 (got {r})")
    r = _FNS["memory_save"](key="editor-pref", content="用户改用浅色主题", tags="preference")
    check(r.get("success") is True and r.get("overwritten") is True, "同键覆盖 = 更新路径")

    r = _FNS["memory_read"](key="editor-pref")
    check(r.get("found") is True and "浅色" in r.get("content", ""), "read 取回覆盖后内容")
    r = _FNS["memory_read"](key="no-such-key")
    check(r.get("found") is False and r.get("ok") is True, "缺失键 found:false 但 ok:true (查询无果≠失败)")

    _FNS["memory_save"](key="project-convention", content="提交信息用中文, 结尾署名", tags="project,git")
    r = _FNS["memory_list"](query="主题")
    check(r.get("total") == 1 and r["entries"][0]["key"] == "editor-pref", f"内容搜索命中 (got {r.get('total')})")
    r = _FNS["memory_list"](query="git")
    check(r.get("total") == 1 and r["entries"][0]["key"] == "project-convention", "tag 搜索命中")
    r = _FNS["memory_list"]()
    check(r.get("total") == 2, "空 query 列全部")

    r = _FNS["memory_delete"](key="editor-pref")
    check(r.get("success") is True and r.get("deleted") is True, "删除存在键")
    r = _FNS["memory_delete"](key="editor-pref")
    check(r.get("success") is True and r.get("deleted") is False, "重复删除如实 deleted:false")

    # 腐败隔离: 写坏文件, read 不炸且隔离
    with open(mpath, "w", encoding="utf-8") as f:
        f.write("{not json!!!")
    r = _FNS["memory_list"]()
    check(r.get("ok") is True and r.get("total") == 0, "腐败库重建为空不炸")
    check(os.path.exists(mpath + ".corrupt"), "腐败文件隔离 .corrupt")

    # 上限与截断
    r = _FNS["memory_save"](key="big", content="y" * 5000)
    check(r.get("success") is True and r.get("truncated") is True, "4000 字截断标注")
    r = _FNS["memory_save"](key="", content="x")
    check(r.get("ok") is False, "空 key 拒")

    # ============================================================ ⑤ sequential_thinking
    print("\n== ⑤ sequential_thinking: 链 / 修订 / 分支 / 参数校验 ==")
    r = _FNS["sequential_thinking"](thought="先拆问题", thought_number=1, total_thoughts=3, next_thought_needed=True)
    check(r.get("thought_history_length") == 1 and r.get("branches") == [], f"链开局 (got {r})")
    r = _FNS["sequential_thinking"](thought="第二步", thought_number=2, total_thoughts=3, next_thought_needed=True)
    check(r.get("thought_history_length") == 2, "链推进")
    r = _FNS["sequential_thinking"](thought="第二步其实不对", thought_number=3, total_thoughts=4,
                                    next_thought_needed=True, is_revision=True, revises_thought=2)
    check(r.get("ok") is True and r.get("total_thoughts") == 4, "修订 + 上调总步数")
    r = _FNS["sequential_thinking"](thought="分支试另一方案", thought_number=3, total_thoughts=4,
                                    next_thought_needed=True, branch_from_thought=2, branch_id="alt")
    check("alt" in r.get("branches", []) and r.get("thought_history_length") == 3, "分支不计入主链")
    r = _FNS["sequential_thinking"](thought="", thought_number=1, total_thoughts=1, next_thought_needed=False)
    check(r.get("ok") is False, "空 thought 拒")
    r = _FNS["sequential_thinking"](thought="x", thought_number=2, total_thoughts=2,
                                    next_thought_needed=False, is_revision=True)
    check(r.get("ok") is False and "revises_thought" in (r.get("error") or ""), "修订缺 revises_thought 拒")
    r = _FNS["sequential_thinking"](thought="新链", thought_number=1, total_thoughts=1, next_thought_needed=False)
    check(r.get("thought_history_length") == 1, "thought_number=1 重开新链")

    # ---------------------------------------------------------------- summary
    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        print("ACC-V19 SMOKE: FAIL")
        return 1
    print("ACC-V19 SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
