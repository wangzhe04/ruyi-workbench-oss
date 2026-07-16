"""Browser automation tools via Playwright (async).

IMPORTANT — why async: this MCP server (mcp.server.fastmcp) dispatches sync tool functions directly on
its asyncio event-loop thread. Playwright's SYNC api refuses to run inside a running event loop
("It looks like you are using Playwright Sync API inside the asyncio loop"), so a sync implementation
is 100% dead in production. These tools therefore use playwright.async_api and are `async def`;
FastMCP awaits them natively on its own loop. A module-level asyncio.Lock serializes access so the
shared _browser/_page globals can't be corrupted by interleaved requests.

Playwright is an OPTIONAL backend (both the package AND its Chromium browser must be present). If the
import fails, or `playwright install chromium` was never run, the tools degrade gracefully to
``{ok:false, error:'playwright not installed', ...}`` instead of crashing.
"""

import asyncio
import base64
import io
import os
import re
import subprocess
import sys

from ai_computer_control.server import mcp

try:
    from playwright.async_api import async_playwright  # type: ignore
    _AVAILABLE = True
    _IMPORT_ERROR = ""
except Exception as e:  # noqa: BLE001 — optional dependency; server must still start
    async_playwright = None  # type: ignore
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)

# Global browser state (only ever touched under _lock, once _AVAILABLE is True).
_browser = None
_page = None
_playwright = None
_backend = ""
_lock = asyncio.Lock()  # Py3.10+: not bound to a loop at construction; safe at module import.

_MODES = {"system", "managed", "custom", "cdp", "bundled"}


def _configured_mode() -> str:
    mode = os.environ.get("ACC_BROWSER_MODE", "system").strip().lower()
    return mode if mode in _MODES else "system"


def _system_open(url: str, new_tab: bool) -> None:
    """Open through the user's browser without navigating the workbench's current tab."""
    if sys.platform == "win32":
        executable = _windows_default_browser_executable()
        if executable:
            # Chromium-family browsers accept --new-tab; Firefox uses -new-tab.  Starting the
            # browser directly is still shell-free and gives a stronger non-destructive contract
            # than handing the URL to the generic shell association.
            flag = "-new-tab" if "firefox" in os.path.basename(executable).lower() else "--new-tab"
            subprocess.Popen([executable, flag, url], start_new_session=True)
        else:
            # Association fallback: Windows normally opens a tab in the existing browser session,
            # but cannot provide an explicit tab-placement guarantee without its executable.
            os.startfile(url)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", url], start_new_session=True)
    else:
        subprocess.Popen(["xdg-open", url], start_new_session=True)


def _windows_default_browser_executable() -> str:
    """Best-effort resolve of the executable behind the user's HTTP association."""
    if sys.platform != "win32":
        return ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice") as key:
            prog_id = str(winreg.QueryValueEx(key, "ProgId")[0])
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog_id + r"\shell\open\command") as key:
            command = str(winreg.QueryValueEx(key, "")[0])
        match = re.match(r'^\s*"([^"]+\.exe)"|^\s*([^\s]+\.exe)', command, re.I)
        candidate = (match.group(1) or match.group(2)) if match else ""
        return candidate if candidate and os.path.isfile(candidate) else ""
    except Exception:
        return ""


def _managed_executable(mode: str) -> str:
    explicit = os.environ.get("ACC_BROWSER_EXECUTABLE", "").strip()
    if explicit:
        return explicit
    if mode == "managed":
        return _windows_default_browser_executable()
    return ""  # bundled deliberately lets Playwright select Chrome for Testing


def _unavailable(mode: str | None = None) -> dict:
    """Uniform degraded response when the Playwright package OR its browser is missing."""
    chosen = (mode or _configured_mode()).strip().lower()
    if chosen == "system":
        return {
            "ok": False,
            "error": "the user's system browser is not DOM-attached",
            "mode": "system",
            "hint": (
                "Use desktop screenshot plus UIA/OCR/keyboard tools. If UIA reports "
                "accessibilityLimited on a hardware-accelerated page, switch to OCR/screenshot; "
                "choose CDP/managed/custom mode when DOM access is required."
            ),
        }
    out = {"ok": False, "error": "playwright not installed",
           "hint": "pip install playwright && playwright install chromium"}
    if _IMPORT_ERROR:
        out["detail"] = _IMPORT_ERROR
    return out


async def _ensure_browser(mode: str | None = None):
    """Ensure the browser is launched and return the active page.

    Raises RuntimeError with an install hint if the Chromium binary is absent (package imported but
    `playwright install chromium` never run) so the caller can convert it to a graceful envelope.
    """
    global _browser, _page, _playwright, _backend
    chosen = (mode or _backend or _configured_mode()).strip().lower()
    if chosen == "system":
        raise RuntimeError(
            "the active browser uses the system/user session and is not Playwright-attached; "
            "use desktop screenshot + UIA/OCR tools, or choose managed/custom/CDP browser mode"
        )
    if _page is None or _page.is_closed():
        if _playwright is None:
            _playwright = await async_playwright().start()
        if _browser is None or not _browser.is_connected():
            try:
                if chosen == "cdp":
                    endpoint = os.environ.get("ACC_BROWSER_CDP_URL", "http://127.0.0.1:9222").strip()
                    _browser = await _playwright.chromium.connect_over_cdp(endpoint)
                else:
                    executable = _managed_executable(chosen)
                    if chosen in {"managed", "custom"} and not executable:
                        raise RuntimeError("no compatible browser executable was found; set a custom executable or use system mode")
                    launch_args = {"headless": False, "args": ["--force-renderer-accessibility"]}
                    if executable:
                        launch_args["executable_path"] = executable
                    _browser = await _playwright.chromium.launch(**launch_args)
                _backend = chosen
            except Exception as e:  # noqa: BLE001 — most often: browser not installed
                raise RuntimeError(
                    f"browser backend '{chosen}' is not available: " + str(e)
                ) from e
        pages = _all_pages()
        _page = pages[-1] if pages else await _browser.new_page()
    return _page


def _all_pages():
    """Every open Page across all contexts — Playwright's own tab bookkeeping (single source of truth)."""
    pages = []
    if _browser and _browser.is_connected():
        for ctx in _browser.contexts:
            pages.extend(ctx.pages)
    return pages


async def _is_workbench_page(page) -> bool:
    """Keep a connected Ruyi/Workbench page from becoming an automation navigation target."""
    try:
        url = str(page.url or "").lower()
        if not re.match(r"^https?://(127\.0\.0\.1|localhost)(?::\d+)?/", url):
            return False
        title = (await page.title()).lower()
        return "ruyi" in title or "如意" in title or "workbench" in title
    except Exception:
        return False


@mcp.tool()
async def browser_open(url: str, new_tab: bool = True, mode: str | None = None) -> dict:
    """Open a URL in the browser.

    Args:
        url: URL to navigate to.
        new_tab: Open in a new tab (default True). The tool never navigates a detected Ruyi/Workbench tab.

    Returns:
        dict with 'success', 'url', 'title'.
    """
    chosen = str(mode or _configured_mode()).strip().lower()
    if chosen not in _MODES:
        return {"error": f"unknown browser mode: {chosen}", "modes": sorted(_MODES)}
    if chosen == "system":
        try:
            _system_open(url, new_tab)
            return {
                "success": True, "url": url, "mode": "system", "control": "desktop",
                "hint": (
                    "Opened in the user's system browser. Continue with desktop_screenshot plus "
                    "UIA/OCR/keyboard tools. If UIA reports accessibilityLimited for an accelerated "
                    "page, use OCR/screenshot instead; browser DOM tools require managed/custom/CDP mode."
                ),
            }
        except Exception as e:
            return {"error": str(e), "mode": "system"}
    if not _AVAILABLE:
        return _unavailable(chosen)
    global _page, _backend
    async with _lock:
        try:
            if _backend and _backend != chosen:
                return {"error": f"browser backend already active as '{_backend}'; call browser_close before switching to '{chosen}'"}
            _backend = chosen
            page = await _ensure_browser(chosen)
            preserved_workbench = await _is_workbench_page(page)
            if new_tab or preserved_workbench:
                _page = await _browser.new_page()
            await _page.goto(url, wait_until="domcontentloaded", timeout=30000)
            return {
                "success": True, "url": _page.url, "title": await _page.title(), "mode": chosen,
                "control": "playwright", "newTab": bool(new_tab or preserved_workbench),
                "preservedWorkbench": preserved_workbench,
            }
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_backend_status() -> dict:
    """Show the configured browser target and whether browser_* automation is attached."""
    configured = _configured_mode()
    executable = os.environ.get("ACC_BROWSER_EXECUTABLE", "").strip()
    if configured == "managed" and not executable:
        executable = _windows_default_browser_executable()
    return {
        "configuredMode": configured,
        "activeMode": _backend or "",
        "executable": executable,
        "cdpUrl": os.environ.get("ACC_BROWSER_CDP_URL", "http://127.0.0.1:9222") if configured == "cdp" else "",
        "attached": bool(_browser and _browser.is_connected()),
        "systemControlHint": "system mode uses the user's browser and desktop UIA/OCR tools; managed/custom/CDP modes enable browser_* DOM automation",
    }


@mcp.tool()
async def browser_click(
    selector: str | None = None,
    text: str | None = None,
    x: int | None = None,
    y: int | None = None,
) -> dict:
    """Click an element in the browser page.

    Args:
        selector: CSS selector to click (e.g. "#submit", ".btn-primary").
        text: Click the first element containing this text.
        x: Click at specific X coordinate on the page.
        y: Click at specific Y coordinate on the page.

    Returns:
        dict with 'success'.
    """
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            page = await _ensure_browser()
            if selector:
                await page.click(selector, timeout=5000)
            elif text:
                await page.click(f"text={text}", timeout=5000)
            elif x is not None and y is not None:
                await page.mouse.click(x, y)
            else:
                return {"error": "Provide selector, text, or x/y coordinates"}
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_type(
    selector: str,
    text: str,
    clear: bool = True,
) -> dict:
    """Type text into an input element.

    Args:
        selector: CSS selector of the input element.
        text: Text to type.
        clear: If True, clear the field before typing.

    Returns:
        dict with 'success'.
    """
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            page = await _ensure_browser()
            if clear:
                await page.fill(selector, text, timeout=5000)
            else:
                await page.type(selector, text, timeout=5000)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_screenshot() -> dict:
    """Take a screenshot of the current browser page.

    Returns:
        dict with 'image' (base64 PNG), 'width', 'height', 'url', 'title'.
    """
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            from PIL import Image
            page = await _ensure_browser()
            screenshot_bytes = await page.screenshot(type="png")
            image = Image.open(io.BytesIO(screenshot_bytes))
            return {
                "image": base64.b64encode(screenshot_bytes).decode("utf-8"),
                "width": image.width,
                "height": image.height,
                "url": page.url,
                "title": await page.title(),
            }
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_get_text(selector: str | None = None) -> dict:
    """Extract text content from the page or a specific element.

    Args:
        selector: Optional CSS selector. If None, returns full page text.

    Returns:
        dict with 'text'.
    """
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            page = await _ensure_browser()
            if selector:
                element = await page.query_selector(selector)
                text = (await element.inner_text()) if element else ""
            else:
                text = await page.inner_text("body")
            return {"text": text, "url": page.url}
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_execute_js(script: str) -> dict:
    """Execute JavaScript code in the browser page context.

    Args:
        script: JavaScript code to execute. The result of the last expression is returned.

    Returns:
        dict with 'result' containing the return value.
    """
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            page = await _ensure_browser()
            result = await page.evaluate(script)
            return {"result": result}
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_navigate(action: str) -> dict:
    """Navigate the browser (back, forward, reload).

    Args:
        action: One of "back", "forward", or "reload".

    Returns:
        dict with 'success', 'url', 'title'.
    """
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            page = await _ensure_browser()
            if action == "back":
                await page.go_back(wait_until="domcontentloaded")
            elif action == "forward":
                await page.go_forward(wait_until="domcontentloaded")
            elif action == "reload":
                await page.reload(wait_until="domcontentloaded")
            else:
                return {"error": f"Unknown action: {action}. Use 'back', 'forward', or 'reload'"}
            return {"success": True, "url": page.url, "title": await page.title()}
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_get_elements(selector: str) -> dict:
    """Get information about elements matching a CSS selector.

    Args:
        selector: CSS selector to query.

    Returns:
        dict with 'elements' list containing tag, text, attributes.
    """
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            page = await _ensure_browser()
            elements = await page.query_selector_all(selector)
            results = []
            for el in elements[:50]:
                # One detached/stale element must not abort the whole scan — skip it instead.
                try:
                    txt = (await el.inner_text()) or ""
                    results.append({
                        "tag": await el.evaluate("e => e.tagName.toLowerCase()"),
                        "text": txt[:200],
                        "id": (await el.get_attribute("id")) or "",
                        "class": (await el.get_attribute("class")) or "",
                        "href": (await el.get_attribute("href")) or "",
                        "value": (await el.get_attribute("value")) or "",
                        "visible": await el.is_visible(),
                    })
                except Exception:
                    continue
            return {"elements": results, "count": len(results)}
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_list_tabs() -> dict:
    """List the open browser tabs (index, url, title). Use the index with browser_switch_tab."""
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            pages = _all_pages()
            tabs = []
            for i, p in enumerate(pages):
                try:
                    tabs.append({"index": i, "url": p.url, "title": await p.title(),
                                 "active": p is _page})
                except Exception:
                    tabs.append({"index": i, "url": "", "title": "", "active": p is _page})
            return {"ok": True, "tabs": tabs, "count": len(tabs)}
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_switch_tab(index: int) -> dict:
    """Make the tab at `index` (from browser_list_tabs) the active one for subsequent browser_* calls."""
    if not _AVAILABLE:
        return _unavailable()
    global _page
    async with _lock:
        try:
            pages = _all_pages()
            if not (0 <= int(index) < len(pages)):
                return {"error": f"tab index {index} out of range (0..{len(pages) - 1})", "count": len(pages)}
            _page = pages[int(index)]
            try:
                await _page.bring_to_front()
            except Exception:
                pass
            return {"success": True, "index": int(index), "url": _page.url, "title": await _page.title()}
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def browser_close() -> dict:
    """Close the browser instance.

    Returns:
        dict with 'success'.
    """
    global _browser, _page, _playwright, _backend
    if (_backend or _configured_mode()) == "system":
        return {"success": True, "mode": "system", "closed": False,
                "hint": "The user's browser is not owned by this tool and was left open."}
    if not _AVAILABLE:
        return _unavailable()
    async with _lock:
        try:
            if _page and not _page.is_closed():
                await _page.close()
            if _browser and _browser.is_connected():
                await _browser.close()
            if _playwright:
                await _playwright.stop()
            _browser = None
            _page = None
            _playwright = None
            _backend = ""
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}
