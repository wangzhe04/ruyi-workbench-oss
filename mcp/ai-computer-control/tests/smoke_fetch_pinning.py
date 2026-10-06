"""fetch 的 DNS 重绑定防护冒烟 —— 校验与连接必须用同一次解析。

背景: _check_url 先 getaddrinfo 校验,urllib 连接时又会解析一次;恶意 DNS 可以第一次答公网地址、第二次答
127.0.0.1 / 169.254.169.254(DNS 重绑定),校验形同虚设。修法是直连时用 _pinned_connect:解析一次、逐个校验、
只连校验过的 IP 字面量(Host 头 / SNI / 证书校验仍用原主机名);走环境代理的请求由代理解析,保持原 opener。

本测试起一个【真实】本机 http.server(127.0.0.1,零外网),用打桩的 socket.getaddrinfo 演出重绑定剧本,断言:
  ① IP 字面量的回环目标:即使 _check_url 被绕过,连接时的闸门仍拒绝,服务器一个请求都没收到
  ② 重绑定剧本(首次解析公网、再次解析回环):真 _check_url 放行、连接时被拦,服务器零请求;
     对照组:同一剧本下旧的 stock opener 确实会连上回环(证明这条断言有牙)
  ③ 解析结果里混有一个非公网地址就整体拒绝;只解析一次(同一主机名的 getaddrinfo 恰好 1 次)
  ④ 放行回环后:Host 头保持原主机名、响应正常(固定 IP 不改写请求)
  ⑤ HTTPS:TLS 握手用原主机名做 SNI/校验(不是 IP);pinned opener 禁用环境代理且校验证书
  ⑥ 代理:有代理且不在 NO_PROXY 时用 stock opener,否则用 pinned opener

Run with UTF-8:  python -X utf8 tests/smoke_fetch_pinning.py
"""

import http.server
import os
import socket
import ssl
import sys
import tempfile
import threading
import urllib.request

# 本机回环不许走系统/环境代理(开发机常有),与 smoke_fetch_transport 同口径。
for _k in [k for k in os.environ if k.lower().endswith("_proxy")]:
    del os.environ[_k]
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost,pin.example,rebind.example"

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))
os.environ.setdefault("WCW_DATA_DIR", os.path.join(tempfile.gettempdir(), "acc_smoke_fetch_pinning"))
os.makedirs(os.environ["WCW_DATA_DIR"], exist_ok=True)

import ai_computer_control.server as server  # noqa: E402
import ai_computer_control.tools.web_fetch as wf  # noqa: E402

_FNS = {t.name: t.fn for t in server.mcp._tool_manager.list_tools()}
_FAILURES: list[str] = []
SEEN: list[dict] = []   # requests that actually reached the local server


def check(cond: bool, msg: str):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


class _H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        SEEN.append({"path": self.path, "host": self.headers.get("Host")})
        body = b"hello from the local server"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


PUBLIC = "93.184.216.34"   # a global address: passes _is_public_ip


class FakeDNS:
    """socket.getaddrinfo replacement: scripted answers per host name, everything else goes to the real resolver."""

    def __init__(self, real):
        self.real = real
        self.script = {}      # host -> list of answers (each a tuple of ips); the last one repeats
        self.calls = {}       # host -> number of lookups

    def __call__(self, host, port, *a, **k):
        if host in self.script:
            n = self.calls.get(host, 0)
            self.calls[host] = n + 1
            answers = self.script[host]
            ips = answers[min(n, len(answers) - 1)]
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0)) for ip in ips]
        return self.real(host, port, *a, **k)


def main() -> int:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    real_getaddrinfo = socket.getaddrinfo
    dns = FakeDNS(real_getaddrinfo)
    socket.getaddrinfo = dns
    real_allowed = wf._connect_allowed
    # Environment-only proxy discovery: a developer's Windows registry proxy must not change which opener is chosen.
    real_getproxies, real_bypass = urllib.request.getproxies, urllib.request.proxy_bypass
    urllib.request.getproxies = urllib.request.getproxies_environment
    urllib.request.proxy_bypass = lambda host: urllib.request.proxy_bypass_environment(host)
    try:
        print("== ① IP 字面量: 连接时的闸门独立于 _check_url ==")
        orig_check = wf._check_url
        wf._check_url = lambda url: None          # 假设预检被绕过 / 被重绑定骗过
        try:
            SEEN.clear()
            r = _FNS["fetch"](url=f"http://127.0.0.1:{port}/secret")
            check(r.get("ok") is False and "refused" in (r.get("error") or "") and not SEEN,
                  f"预检放行也拒绝回环 IP,服务器零请求 (got {r.get('error')!r}, seen {SEEN})")
        finally:
            wf._check_url = orig_check

        print("\n== ② DNS 重绑定: 首次解析公网、连接时解析回环 ==")
        dns.script["rebind.example"] = [(PUBLIC,), ("127.0.0.1",)]
        dns.calls.clear()
        SEEN.clear()
        check(wf._check_url(f"http://rebind.example:{port}/x") is None, "第一次解析(预检)得到公网地址,真 _check_url 放行")
        dns.calls.clear()                          # 重新开剧本: 预检 = 第 1 次(公网), 连接 = 第 2 次(回环)
        r = _FNS["fetch"](url=f"http://rebind.example:{port}/x")
        check(r.get("ok") is False and "refused" in (r.get("error") or "") and "127.0.0.1" in (r.get("error") or "")
              and not SEEN,
              f"连接时解析到回环 => 被拦,服务器零请求 (got {r.get('error')!r}, seen {SEEN})")

        # 对照组: 同一剧本下 stock opener(修前行为)会连上回环 —— 证明上面的断言不是空转。
        dns.calls.clear()
        SEEN.clear()
        orig_proxy = wf._proxy_in_effect
        wf._proxy_in_effect = lambda url: True          # 强制走旧的 stock opener;预检仍是真 _check_url(第 1 次=公网)
        try:
            r = _FNS["fetch"](url=f"http://rebind.example:{port}/x")
        finally:
            wf._proxy_in_effect = orig_proxy
        check(r.get("ok") is True and len(SEEN) == 1,
              f"对照组: 旧 opener 在同一剧本下确实被重绑定到回环 (seen {len(SEEN)}) —— 这就是被修的洞")

        print("\n== ③ 混合答案整体拒绝 / 只解析一次 ==")
        dns.script["mixed.example"] = [(PUBLIC, "10.0.0.5")]
        try:
            wf._pinned_connect("mixed.example", port, 3)
            check(False, "混有 10.0.0.5 的解析结果应被拒绝")
        except OSError as e:
            check("refused" in str(e) and "10.0.0.5" in str(e), f"混有内网地址 => 整体拒绝 ({e})")
        dns.script["pin.example"] = [("127.0.0.1",)]
        dns.calls.clear()
        wf._connect_allowed = lambda ip: ip == "127.0.0.1" or real_allowed(ip)
        s = wf._pinned_connect("pin.example", port, 3)
        s.close()
        check(dns.calls.get("pin.example") == 1, f"_pinned_connect 对同一主机名只解析 1 次 (got {dns.calls.get('pin.example')})")

        print("\n== ④ 放行回环后: Host 头保持原主机名 ==")
        orig_check = wf._check_url
        wf._check_url = lambda url: None
        try:
            SEEN.clear()
            r = _FNS["fetch"](url=f"http://pin.example:{port}/hello")
            check(r.get("ok") is True and r.get("content") == "hello from the local server"
                  and SEEN == [{"path": "/hello", "host": f"pin.example:{port}"}],
                  f"固定 IP 连接,请求头仍是原主机名 (got {r.get('error') or r.get('content')!r}, seen {SEEN})")
        finally:
            wf._check_url = orig_check
            wf._connect_allowed = real_allowed

        print("\n== ⑤ HTTPS: SNI / 校验用原主机名; pinned opener 不走代理且校验证书 ==")
        wrapped = []

        class FakeCtx:
            def wrap_socket(self, sock, server_hostname=None):
                wrapped.append(server_hostname)
                return sock

        raw = socket.create_connection(("127.0.0.1", port), 3)
        orig_pc = wf._pinned_connect
        wf._pinned_connect = lambda host, p, timeout, src=None: raw
        try:
            conn = wf._PinnedHTTPSConnection("pin.example", port, timeout=3, context=FakeCtx())
            conn.connect()
            check(wrapped == ["pin.example"], f"TLS 握手的 server_hostname 是原主机名而非 IP (got {wrapped})")
        finally:
            wf._pinned_connect = orig_pc
            raw.close()
        op = wf._build_pinned_opener()
        https = [h for h in op.handlers if isinstance(h, wf._PinnedHTTPSHandler)]
        check(len(https) == 1 and https[0]._context.verify_mode == ssl.CERT_REQUIRED and https[0]._context.check_hostname,
              "pinned HTTPS handler 带校验证书的默认上下文")
        # ProxyHandler({}) registers no <scheme>_open methods, so the opener drops it: no proxy handler at all, and
        # build_opener skips its default (environment-driven) one because an instance was passed.
        check(not any(isinstance(h, urllib.request.ProxyHandler) for h in op.handlers),
              "pinned opener 里没有任何 ProxyHandler(环境代理被禁用)")
        check(not any(type(h) is urllib.request.HTTPHandler or type(h) is urllib.request.HTTPSHandler for h in op.handlers),
              "pinned opener 里没有留着 stock HTTP/HTTPS handler(否则可能绕过固定)")

        print("\n== ⑥ 代理: 有代理用 stock opener, 否则 pinned ==")
        picked = []

        class FakeOpener:
            def open(self, req, timeout=None):
                raise RuntimeError("stop")

        orig_b, orig_p = wf._build_opener, wf._build_pinned_opener
        wf._build_opener = lambda: (picked.append("stock"), FakeOpener())[1]
        wf._build_pinned_opener = lambda: (picked.append("pinned"), FakeOpener())[1]
        saved = {k: os.environ.get(k) for k in ("HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy")}
        try:
            os.environ["NO_PROXY"] = os.environ["no_proxy"] = ""
            wf._fetch_once("http://example.com/", 3, 1000)
            check(picked == ["pinned"], f"无代理 -> pinned (got {picked})")
            picked.clear()
            os.environ["HTTP_PROXY"] = os.environ["http_proxy"] = "http://127.0.0.1:9"
            check(wf._proxy_in_effect("http://example.com/") is True, "配了 HTTP_PROXY => _proxy_in_effect")
            wf._fetch_once("http://example.com/", 3, 1000)
            check(picked == ["stock"], f"有代理 -> stock opener (代理自己解析) (got {picked})")
            picked.clear()
            os.environ["NO_PROXY"] = os.environ["no_proxy"] = "example.com"
            check(wf._proxy_in_effect("http://example.com/") is False, "命中 NO_PROXY => 直连")
            wf._fetch_once("http://example.com/", 3, 1000)
            check(picked == ["pinned"], f"NO_PROXY 命中 -> pinned (got {picked})")
            check(wf._proxy_in_effect("not a url") is False, "畸形 URL 不抛异常")
            # 功能性确认: 环境里配了(不可达的)代理时, pinned opener 仍直连目标,根本不碰代理。
            os.environ["NO_PROXY"] = os.environ["no_proxy"] = ""
            wf._connect_allowed = lambda ip: ip == "127.0.0.1" or real_allowed(ip)
            SEEN.clear()
            with orig_p().open(urllib.request.Request(f"http://pin.example:{port}/direct"), timeout=5) as resp:
                body = resp.read()
            check(body == b"hello from the local server" and SEEN and SEEN[-1]["path"] == "/direct",
                  "pinned opener 在配了代理的环境里仍直连(没有被代理接管)")
        finally:
            wf._build_opener, wf._build_pinned_opener = orig_b, orig_p
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
    finally:
        socket.getaddrinfo = real_getaddrinfo
        urllib.request.getproxies, urllib.request.proxy_bypass = real_getproxies, real_bypass
        wf._connect_allowed = real_allowed
        srv.shutdown()

    print()
    if _FAILURES:
        print(f"FETCH PINNING SMOKE: FAIL ({len(_FAILURES)})")
        for m in _FAILURES:
            print("  -", m)
        return 1
    print("FETCH PINNING SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
