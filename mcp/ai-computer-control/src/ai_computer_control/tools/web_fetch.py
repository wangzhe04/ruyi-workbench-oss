"""Web fetch tool — v1.9 addition.

Standalone hosts (Claude Desktop etc.) have no web access through this toolkit; the Ruyi
workbench has its own native web_fetch. This closes the gap for the standalone scenario.

Security: SSRF guard mirrors the workbench's native 11-native-tools.js pattern —
scheme allowlist + DNS resolution + private/loopback/link-local/reserved IP rejection
(incl. IPv4-mapped IPv6) + PER-HOP redirect re-validation (a redirect to 127.0.0.1 must
not bypass the guard) + byte budget.
"""

import ipaddress
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request

from ai_computer_control.server import mcp

_MAX_REDIRECTS = 5
_DEFAULT_MAX_BYTES = 200_000
_HARD_MAX_BYTES = 2_000_000
_UA = "ai-computer-control/1.9 (+https://localhost; fetch tool)"


def _is_public_ip(ip_str: str) -> bool:
    """True only for genuinely public, routable IPs. IPv4-mapped IPv6 is unwrapped first."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if ip.version == 6 and getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    # is_global covers private/loopback/link-local/reserved/multicast/unspecified in one check.
    return ip.is_global


def _check_url(url: str) -> str | None:
    """Return an error string if the URL must be refused, else None."""
    try:
        parts = urllib.parse.urlsplit(url)
    except Exception as e:
        return f"URL 解析失败: {e}"
    if parts.scheme not in ("http", "https"):
        return f"仅支持 http/https(收到 {parts.scheme or '(空)'})。"
    host = parts.hostname
    if not host:
        return "URL 缺少主机名。"
    # Block obvious local hostnames before DNS (also covers 'localhost.' etc.).
    h = host.lower().rstrip(".")
    if h in ("localhost", "localhost.localdomain") or h.endswith(".localhost") or h.endswith(".local") or h.endswith(".internal"):
        return f"refused: 目标主机 {host} 指向本机/内网(SSRF 防护)。"
    # If the host is already an IP literal, validate directly; otherwise resolve.
    try:
        ipaddress.ip_address(host)
        ips = [host]
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror as e:
            return f"DNS 解析失败: {e}"
        ips = sorted({info[4][0] for info in infos})
        if not ips:
            return "DNS 解析无结果。"
    for ip in ips:
        if not _is_public_ip(ip):
            return f"refused: 目标 {host} 解析到非公网地址 {ip}(SSRF 防护,防内网/回环穿透)。"
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Turn every redirect into a captured response so we can re-validate each hop."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def _fetch_once(url: str, timeout: float, max_bytes: int):
    """One HTTP GET without following redirects. Returns (status, headers, body_bytes, error)."""
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "*/*"})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout, context=ssl.create_default_context()) as resp:
            body = resp.read(max_bytes + 1)
            return resp.status, dict(resp.headers), body, None
    except urllib.error.HTTPError as e:
        # Redirect statuses arrive here because _NoRedirect declined them.
        if e.code in (301, 302, 303, 307, 308):
            return e.code, dict(e.headers or {}), b"", None
        # Real HTTP errors still carry a useful body — read within budget.
        try:
            body = e.read(max_bytes + 1)
        except Exception:
            body = b""
        return e.code, dict(e.headers or {}), body, None
    except Exception as e:
        return None, {}, b"", f"{type(e).__name__}: {e}"


def _decode(body: bytes, headers: dict) -> str:
    ctype = ""
    for k, v in headers.items():
        if k.lower() == "content-type":
            ctype = v
            break
    charset = "utf-8"
    if "charset=" in ctype:
        charset = ctype.split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except (LookupError, ValueError):
        return body.decode("utf-8", errors="replace")


@mcp.tool()
def fetch(url: str, max_bytes: int = _DEFAULT_MAX_BYTES, timeout: int = 15) -> dict:
    """Fetch a web page / API endpoint over HTTP(S) with SSRF protection.

    何时用: 需要读一个公网 URL 的内容(文档页、API 响应、raw 文件),本机又没有浏览器自动化必要。
    何时别用: 内网/本机地址(127.0.0.1、192.168.x、localhost 等会被 SSRF 防护拒绝);
        需要登录态/JS 渲染的页面(改用 browser_* 工具);大文件下载(有字节预算,非下载器)。

    Args:
        url: http(s) URL. Every redirect hop is re-validated (max 5 hops).
        max_bytes: Body byte budget (default 200KB, hard cap 2MB). Truncated bodies are marked.
        timeout: Per-request timeout in seconds (1-60, default 15).

    Returns:
        dict with 'ok', 'url' (final URL after redirects), 'status', 'content_type',
        'content', 'bytes', 'truncated', 'redirects'. On refusal/failure a dict with 'error'.
    """
    budget = max(1, min(int(max_bytes), _HARD_MAX_BYTES))
    tmo = max(1, min(int(timeout), 60))
    current = url
    hops = 0
    for _ in range(_MAX_REDIRECTS + 1):
        err = _check_url(current)
        if err:
            return {"error": err, "url": current}
        status, headers, body, ferr = _fetch_once(current, tmo, budget)
        if ferr:
            return {"error": ferr, "url": current}
        if status in (301, 302, 303, 307, 308):
            loc = headers.get("Location") or headers.get("location")
            if not loc:
                return {"error": f"收到 {status} 重定向但无 Location 头。", "url": current}
            current = urllib.parse.urljoin(current, loc)
            hops += 1
            continue
        truncated = len(body) > budget
        if truncated:
            body = body[:budget]
        text = _decode(body, headers)
        ctype = next((v for k, v in headers.items() if k.lower() == "content-type"), "")
        return {
            "ok": True,
            "url": current,
            "status": status,
            "content_type": ctype,
            "content": text,
            "bytes": len(body),
            "truncated": truncated,
            "redirects": hops,
        }
    return {"error": f"重定向超过 {_MAX_REDIRECTS} 跳,放弃(防重定向循环)。", "url": current}
