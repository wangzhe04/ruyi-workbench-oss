"""fetch 真传输冒烟(不 stub _fetch_once) —— 回归钉: OpenerDirector.open(..., context=) TypeError.

历史事故: web_fetch._fetch_once 调 ``opener.open(req, timeout=..., context=...)``, 但 OpenerDirector.open
没有 context 参数(只有 urlopen 有),于是每次 fetch(http 或 https)都在开 socket 前 TypeError,被
``except Exception`` 吞成 {"error": "TypeError: ..."}。smoke_v19 全程 stub 了 _fetch_once,所以没人发现。

本测试起一个【真实】本机 http.server(127.0.0.1,零外网),只把 SSRF 判定 _check_url 换成「放行本测试服务器、
其余仍走真判定」的包装,让请求走完整的 build_opener -> HTTPHandler -> socket -> 解码 -> HTML 抽文本 链路。
同时确认 SSRF 护栏没被削弱(真 _check_url 仍拒绝回环;重定向到内网的那一跳仍被拦)。

Run with UTF-8:  python -X utf8 tests/smoke_fetch_transport.py
"""

import http.server
import os
import ssl
import sys
import tempfile
import threading
import urllib.request

# 本机回环不许走系统/环境代理(开发机常有);NO_PROXY 令 urllib 直连 127.0.0.1(Windows 注册表代理同理被绕过)。
for _k in [k for k in os.environ if k.lower().endswith("_proxy")]:
    del os.environ[_k]
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))
os.environ.setdefault("WCW_DATA_DIR", os.path.join(tempfile.gettempdir(), "acc_smoke_fetch_transport"))
os.makedirs(os.environ["WCW_DATA_DIR"], exist_ok=True)

import ai_computer_control.server as server  # noqa: E402
import ai_computer_control.tools.web_fetch as wf  # noqa: E402

_FNS = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
_FAILURES: list[str] = []


def check(cond: bool, msg: str):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>如意 测试页</title>
<style>.x{color:red}</style><script>var junk = "<p>SCRIPT-JUNK</p>";</script></head>
<body><nav><a href="/menu">NAV-JUNK</a></nav>
<h1>主标题</h1><p>你好 <b>世界</b>,详见<a href="/docs/a.html">文档页</a>。</p>
<ul><li>第一项</li><li>第二项</li></ul>
<table><tr><th>名称</th><th>数量</th></tr><tr><td>苹果</td><td>3</td></tr></table>
<footer>FOOTER-JUNK</footer></body></html>"""

GBK_PAGE = ('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312">'
            '<title>中文标题</title></head><body><p>这是一段没有 HTTP 头字符集的中文页面。</p></body></html>').encode("gb18030")

LONG_BODY = "".join(("段落%04d:" % i) + "文字" * 20 + "\n" for i in range(600))  # ~ 600 * 30 chars


class _H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, ctype, body, extra=None):
        self.send_response(code)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        p = self.path
        if p == "/page.html":
            self._send(200, "text/html; charset=utf-8", PAGE.encode("utf-8"))
        elif p == "/gbk.html":
            self._send(200, "text/html", GBK_PAGE)          # 无 charset 头,只有 <meta>
        elif p == "/long.txt":
            self._send(200, "text/plain; charset=utf-8", LONG_BODY.encode("utf-8"))
        elif p == "/data.json":
            self._send(200, "application/json", b'{"a": 1, "b": [1, 2]}')
        elif p == "/doc.pdf":
            self._send(200, "application/pdf", b"%PDF-1.4\n" + bytes(range(256)) * 20)
        elif p == "/redir":
            self._send(302, None, b"", {"Location": "/page.html"})
        elif p == "/to-internal":
            self._send(302, None, b"", {"Location": "http://10.0.0.5/secret"})
        elif p == "/missing":
            self._send(404, "text/html", b"<html><body>nope</body></html>")
        else:
            self._send(200, "text/plain; charset=utf-8", b"hello")


def main() -> int:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    real_check = wf._check_url
    real_connect_allowed = wf._connect_allowed

    def allow_test_server_ip(ip):
        # 连接时的第二道闸(_pinned_connect)同样只放行本测试服务器的回环地址;其它地址仍走真判定。
        return ip == "127.0.0.1" or real_connect_allowed(ip)

    def allow_test_server(url):
        # 只放行本测试服务器;其它一切(含重定向到 10.0.0.5)仍走真实 SSRF 判定。
        if url.startswith(base + "/"):
            return None
        return real_check(url)

    try:
        print("== ① SSRF 护栏未被削弱 (真 _check_url, 不打补丁) ==")
        r = _FNS["fetch"](url=base + "/page.html")
        check(r.get("ok") is False and "refused" in (r.get("error") or ""),
              f"真 _check_url 仍拒绝回环服务器 (got {r.get('error')!r})")

        wf._check_url = allow_test_server
        wf._connect_allowed = allow_test_server_ip
        print("\n== ② 真传输: 不 stub _fetch_once, 走完整 opener ==")
        r = _FNS["fetch"](url=base + "/other")
        check(r.get("ok") is True and r.get("content") == "hello" and r.get("status") == 200,
              f"真 http.server 上 fetch 成功 (回归: 曾 100% TypeError) got={r}")
        check("TypeError" not in str(r), "没有 TypeError 'context' 残留")

        print("\n== ③ HTML -> 可见文本 (去 script/style/nav/footer, 保留标题/列表/链接/表格) ==")
        r = _FNS["fetch"](url=base + "/page.html")
        txt = r.get("content", "")
        check(r.get("ok") is True and "SCRIPT-JUNK" not in txt and "NAV-JUNK" not in txt
              and "FOOTER-JUNK" not in txt and "color:red" not in txt and "<" not in txt,
              f"script/style/nav/footer 被剥掉, 无标签残留 (got {txt!r})")
        check("# 主标题" in txt and "- 第一项" in txt and "- 第二项" in txt, "标题 '#' 与列表 '- ' 结构保留")
        check(f"[文档页]({base}/docs/a.html)" in txt, "链接保留为 [文本](绝对 URL)")
        check("| 名称 | 数量" in txt and "| 苹果 | 3" in txt, "表格保留为竖线行")
        check(r.get("title") == "如意 测试页", f"title 字段 (got {r.get('title')!r})")
        check(len(txt) < len(PAGE), "抽取后比原 HTML 短")
        raw = _FNS["fetch"](url=base + "/page.html", format="raw")
        check("<script>" in raw.get("content", "") and "NAV-JUNK" in raw.get("content", ""), "format=raw 保留原始 HTML")

        print("\n== ④ 字符集: <meta charset> / 无声明 GBK ==")
        r = _FNS["fetch"](url=base + "/gbk.html")
        check(r.get("ok") is True and "这是一段没有 HTTP 头字符集的中文页面" in r.get("content", ""),
              f"header 无 charset 时按 <meta charset=gb2312> 解 GBK (got {r.get('content')!r})")
        nometa = wf._decode("中文内容没有任何声明".encode("gbk"), {"Content-Type": "text/plain"})
        check(nometa == "中文内容没有任何声明", f"完全无声明的 GBK 字节 UTF-8 失败后回退 gb18030 (got {nometa!r})")
        check(wf._decode("héllo".encode("latin-1"), {"Content-Type": "text/plain; charset=latin-1"}) == "héllo",
              "header charset 仍然优先")

        print("\n== ⑤ 长文本续读 (max_chars + next_offset) ==")
        r1 = _FNS["fetch"](url=base + "/long.txt", max_chars=5000)
        check(r1.get("truncated") is True and r1.get("next_offset") == 5000 and len(r1.get("content", "")) == 5000,
              f"首段 5000 字符并给 next_offset (got next={r1.get('next_offset')})")
        got, off, guard = "", 0, 0
        while off is not None and guard < 50:
            rr = _FNS["fetch"](url=base + "/long.txt", max_chars=5000, offset=off)
            got += rr.get("content", "")
            off = rr.get("next_offset")
            guard += 1
        check(got == LONG_BODY, f"按 next_offset 续读拼回完整正文 ({len(got)}/{len(LONG_BODY)})")
        check(r1.get("total_chars") == len(LONG_BODY), "total_chars 报总长")

        print("\n== ⑥ 其它: JSON 原样 / 二进制不当文本 / 重定向 / 404 / 重定向到内网仍被拦 ==")
        r = _FNS["fetch"](url=base + "/data.json")
        check(r.get("content") == '{"a": 1, "b": [1, 2]}', "JSON 原样返回")
        r = _FNS["fetch"](url=base + "/doc.pdf")
        check(r.get("ok") is True and r.get("binary") is True and not r.get("content") and r.get("hint"),
              f"application/pdf 返回 binary + hint, 不是 200KB 乱码 (got keys={sorted(r)})")
        r = _FNS["fetch"](url=base + "/redir")
        check(r.get("ok") is True and r.get("redirects") == 1 and "# 主标题" in r.get("content", ""), "真 302 跟随一跳")
        r = _FNS["fetch"](url=base + "/missing")
        check(r.get("ok") is True and r.get("status") == 404 and "nope" in r.get("content", ""), "404 状态如实回传")
        r = _FNS["fetch"](url=base + "/to-internal")
        check(r.get("ok") is False and "refused" in (r.get("error") or ""),
              f"重定向到 10.0.0.5 的那一跳被 SSRF 护栏拦下 (got {r.get('error')!r})")

        print("\n== ⑦ TLS: opener 挂了带证书校验的 HTTPSHandler ==")
        op = wf._build_opener()
        https_handlers = [h for h in op.handlers if isinstance(h, urllib.request.HTTPSHandler)]
        check(len(https_handlers) == 1 and https_handlers[0]._context.verify_mode == ssl.CERT_REQUIRED
              and https_handlers[0]._context.check_hostname is True, "HTTPSHandler 带默认(校验)SSL 上下文")
    finally:
        wf._check_url = real_check
        wf._connect_allowed = real_connect_allowed
        srv.shutdown()

    print()
    if _FAILURES:
        print(f"FETCH TRANSPORT SMOKE: FAIL ({len(_FAILURES)})")
        for m in _FAILURES:
            print("  -", m)
        return 1
    print("FETCH TRANSPORT SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
