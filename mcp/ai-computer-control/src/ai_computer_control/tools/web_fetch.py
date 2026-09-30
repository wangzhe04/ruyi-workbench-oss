"""Web fetch tool — v1.9 addition.

Standalone hosts (Claude Desktop etc.) have no web access through this toolkit; the Ruyi
workbench has its own native web_fetch. This closes the gap for the standalone scenario.

Security: SSRF guard mirrors the workbench's native 11-native-tools.js pattern —
scheme allowlist + DNS resolution + private/loopback/link-local/reserved IP rejection
(incl. IPv4-mapped IPv6) + PER-HOP redirect re-validation (a redirect to 127.0.0.1 must
not bypass the guard) + byte budget.
"""

import codecs
import ipaddress
import re
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request

from html.parser import HTMLParser

from ai_computer_control.server import mcp

_MAX_REDIRECTS = 5
_DEFAULT_MAX_BYTES = 200_000
_HARD_MAX_BYTES = 2_000_000
_DEFAULT_MAX_CHARS = 30_000   # 返回给模型的文本上限(宿主 60KB 会硬切,这里先按页给出续读偏移)
_HARD_MAX_CHARS = 200_000
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


def _build_opener() -> urllib.request.OpenerDirector:
    """Opener that never follows redirects and verifies TLS with the default context.

    NOTE: ``OpenerDirector.open()`` has NO ``context`` argument (only ``urlopen()`` does) — the
    SSL context must ride on an HTTPSHandler. Passing ``context=`` to ``open`` was a TypeError
    that failed every fetch (and stubbed-_fetch_once tests hid it).
    """
    return urllib.request.build_opener(
        _NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def _fetch_once(url: str, timeout: float, max_bytes: int):
    """One HTTP GET without following redirects. Returns (status, headers, body_bytes, error)."""
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "*/*"})
    opener = _build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
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


def _header(headers: dict, name: str) -> str:
    for k, v in headers.items():
        if k.lower() == name:
            return v
    return ""


_BINARY_MAIN = ("image/", "audio/", "video/", "font/")
_BINARY_TYPES = (
    "application/pdf", "application/zip", "application/gzip", "application/x-gzip", "application/x-tar",
    "application/x-7z-compressed", "application/x-rar-compressed", "application/msword",
    "application/vnd.ms-", "application/vnd.openxmlformats-", "application/x-msdownload",
    "application/x-sqlite3", "application/wasm",
)
_META_CHARSET_RE = re.compile(rb"""<meta[^>]+?charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)""", re.I)
_GB_ALIASES = {"gb2312", "gbk", "gb_2312-80", "x-gbk", "cp936", "gb18030"}


def _is_html(ctype: str, body: bytes) -> bool:
    main = ctype.split(";")[0].strip().lower()
    if main in ("text/html", "application/xhtml+xml"):
        return True
    if main in ("", "application/octet-stream", "text/plain"):
        head = body[:512].lstrip().lower()
        return head.startswith((b"<!doctype html", b"<html"))
    return False


def _is_binary(ctype: str, body: bytes) -> bool:
    main = ctype.split(";")[0].strip().lower()
    if main.startswith(_BINARY_MAIN) or main.startswith(_BINARY_TYPES):
        return True
    if body[:5] == b"%PDF-":
        return True
    return b"\x00" in body[:2048] and not body.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE))


def _decode(body: bytes, headers: dict) -> str:
    """Decode with the best available charset: HTTP header > BOM > <meta charset> (first 2 KB)
    > UTF-8 strict > gb18030 (Chinese pages without any declaration) > UTF-8 with replacement."""
    ctype = _header(headers, "content-type")
    charset = ""
    if "charset=" in ctype.lower():
        charset = ctype.lower().split("charset=", 1)[1].split(";")[0].strip().strip("\"'")
    if not charset:
        if body.startswith(codecs.BOM_UTF8):
            return body[3:].decode("utf-8", errors="replace")
        if body.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
            return body.decode("utf-16", errors="replace")
        m = _META_CHARSET_RE.search(body[:2048])
        if m:
            charset = m.group(1).decode("ascii", "ignore").strip().lower()
    if not charset:
        try:
            return body.decode("utf-8")
        except UnicodeDecodeError:
            return body.decode("gb18030", errors="replace")
    if charset in _GB_ALIASES:
        charset = "gb18030"  # superset: gb2312/gbk-declared pages routinely contain GBK-only chars
    try:
        return body.decode(charset, errors="replace")
    except (LookupError, ValueError):
        try:
            return body.decode("utf-8")
        except UnicodeDecodeError:
            return body.decode("gb18030", errors="replace")


# ---------------------------------------------------------------------------- HTML -> text
_SKIP_ALWAYS = {"script", "style", "noscript", "template", "svg", "canvas", "iframe", "head", "select", "object"}
_SKIP_CHROME = {"nav", "footer"}
_BLOCK = {"p", "div", "section", "article", "main", "header", "aside", "table", "tr", "ul", "ol", "dl",
          "blockquote", "pre", "form", "fieldset", "figure", "figcaption", "details", "summary", "hr",
          "address", "dd", "dt"}


class _TextExtractor(HTMLParser):
    """Visible-text extraction with light structure: headings as '#', list items as '- ', links as
    '[text](url)', table cells separated by ' | '. Script/style/nav/footer chrome dropped."""

    def __init__(self, base_url: str, skip: set):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.skip = skip
        self.skip_depth = 0
        self.title = ""
        self._in_title = False
        self._pre = 0
        self.out: list[str] = []
        self._link: tuple[str, int] | None = None

    def _nl(self, n: int = 1):
        """Ensure the output ends with at least n newlines (no stacking of adjacent block breaks)."""
        tail = "".join(self.out[-6:]).rstrip(" \t")
        have = len(tail) - len(tail.rstrip("\n"))
        if have < n:
            self.out.append("\n" * (n - have))

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
            return
        if tag == "body":
            self.skip_depth = 0  # sloppy pages may leave <head> unclosed; the body always shows
            return
        if tag in self.skip:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._nl(2)
            self.out.append("#" * int(tag[1]) + " ")
        elif tag == "li":
            self._nl()
            self.out.append("- ")
        elif tag == "br":
            self._nl()
        elif tag in ("td", "th"):
            self.out.append(" | ")
        elif tag in _BLOCK:
            self._nl(2 if tag in ("p", "blockquote", "table", "ul", "ol", "pre") else 1)
            if tag == "pre":
                self._pre += 1
        elif tag == "a" and self._link is None:
            href = dict(attrs).get("href") or ""
            if href and not href.startswith(("#", "javascript:", "mailto:", "tel:")):
                self._link = (urllib.parse.urljoin(self.base, href), len(self.out))
        elif tag == "img":
            alt = dict(attrs).get("alt") or ""
            if alt.strip():
                self.out.append("[图: %s]" % alt.strip())

    def handle_startendtag(self, tag, attrs):
        if tag in self.skip:
            return  # <svg/> etc. self-closed: nothing to skip
        self.handle_starttag(tag, attrs)
        if tag in ("li", "td", "th", "a") or tag in _BLOCK:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
            return
        if tag in self.skip:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._nl(2)
        elif tag == "a" and self._link is not None:
            href, start = self._link
            self._link = None
            text = re.sub(r"\s+", " ", "".join(self.out[start:])).strip()
            del self.out[start:]
            self.out.append("[%s](%s)" % (text, href) if text else "")
        elif tag in _BLOCK:
            self._nl(2 if tag in ("p", "blockquote", "table", "ul", "ol", "pre") else 1)
            if tag == "pre" and self._pre:
                self._pre -= 1
        elif tag == "tr":
            self._nl()

    def handle_data(self, data):
        if self._in_title:
            self.title += data
            return
        if self.skip_depth:
            return
        if self._pre:
            self.out.append(data)
        else:
            self.out.append(re.sub(r"\s+", " ", data))

    def text(self) -> str:
        t = "".join(self.out)
        t = re.sub(r"[ \t]*\n[ \t]*", "\n", t)          # trim around newlines
        t = re.sub(r"[ \t]{2,}", " ", t)
        t = re.sub(r"(?m)^ ?\| ", "| ", t)
        t = re.sub(r"\n{3,}", "\n\n", t)
        return t.strip()


def _html_to_text(html: str, base_url: str) -> tuple[str, str]:
    """(visible_text, title). Retries without nav/footer dropping when a chrome tag was left
    unclosed (which would otherwise swallow the rest of the page)."""
    for skip in (_SKIP_ALWAYS | _SKIP_CHROME, _SKIP_ALWAYS):
        p = _TextExtractor(base_url, skip)
        try:
            p.feed(html)
            p.close()
        except Exception:
            pass
        if p.skip_depth == 0 or skip is _SKIP_ALWAYS:
            return p.text(), re.sub(r"\s+", " ", p.title).strip()
    return "", ""


@mcp.tool()
def fetch(url: str, max_bytes: int = _DEFAULT_MAX_BYTES, timeout: int = 15,
          format: str = "text", offset: int = 0, max_chars: int = _DEFAULT_MAX_CHARS) -> dict:
    """Fetch a web page / API endpoint over HTTP(S) with SSRF protection.

    何时用: 需要读一个公网 URL 的内容(文档页、API 响应、raw 文件),本机又没有浏览器自动化必要。
    何时别用: 内网/本机地址(127.0.0.1、192.168.x、localhost 等会被 SSRF 防护拒绝);
        需要登录态/JS 渲染的页面(改用 browser_* 工具);大文件下载(有字节预算,非下载器)。

    Args:
        url: http(s) URL. Every redirect hop is re-validated (max 5).
        max_bytes: Body byte budget (default 200KB, cap 2MB).
        timeout: Per-request seconds (1-60, default 15).
        format: "text" (default) — HTML reduced to visible text (script/style/nav/footer dropped; '#' headings,
            '- ' items, [text](url) links); JSON/plain text as is. "raw" — decoded body untouched.
        offset: Character offset into the extracted text; continue a long page with the previous 'next_offset'
            (each call re-fetches).
        max_chars: Max characters returned per call (default 30000, cap 200000).

    Returns:
        dict with 'ok', 'url' (final), 'status', 'content_type', 'content', 'title' (HTML only), 'bytes',
        'total_chars', 'truncated' (download cut OR more text remains), 'next_offset' (only when more text
        remains), 'redirects'. Binary responses -> ok with 'binary': true + hint. Failure -> 'error'.
        Charset: header > BOM > <meta> > UTF-8 > GBK.
    """
    budget = max(1, min(int(max_bytes), _HARD_MAX_BYTES))
    tmo = max(1, min(int(timeout), 60))
    cap = max(1, min(int(max_chars), _HARD_MAX_CHARS))
    start = max(0, int(offset))
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
        ctype = _header(headers, "content-type")
        if _is_binary(ctype, body):
            return {
                "ok": True, "url": current, "status": status, "content_type": ctype,
                "binary": True, "bytes": len(body), "truncated": truncated, "redirects": hops,
                "hint": "二进制内容,未按文本返回。PDF 先用 run_command 下载到本地再用 pdf_read_pages;"
                        "图片/压缩包同理下载后处理。",
            }
        text = _decode(body, headers)
        title = ""
        if str(format).lower() != "raw" and _is_html(ctype, body):
            text, title = _html_to_text(text, current)
        total = len(text)
        piece = text[start:start + cap]
        more = start + cap < total
        out = {
            "ok": True,
            "url": current,
            "status": status,
            "content_type": ctype,
            "content": piece,
            "bytes": len(body),
            "total_chars": total,
            "truncated": truncated or more,
            "redirects": hops,
        }
        if title:
            out["title"] = title
        if more:
            out["next_offset"] = start + cap
        if truncated:
            out["body_truncated"] = True  # 下载字节预算已到: 调大 max_bytes 才能看到更后面的内容
        return out
    return {"error": f"重定向超过 {_MAX_REDIRECTS} 跳,放弃(防重定向循环)。", "url": current}
