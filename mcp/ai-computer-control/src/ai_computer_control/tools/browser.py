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
_lock = asyncio.Lock()  # Py3.10+: not bound to a loop at construction; safe at module import.


def _unavailable() -> dict:
    """Uniform degraded response when the Playwright package OR its browser is missing."""
    out = {"ok": False, "error": "playwright not installed",
           "hint": "pip install playwright && playwright install chromium"}
    if _IMPORT_ERROR:
        out["detail"] = _IMPORT_ERROR
    return out


async def _ensure_browser():
    """Ensure the browser is launched and return the active page.

    Raises RuntimeError with an install hint if the Chromium binary is absent (package imported but
    `playwright install chromium` never run) so the caller can convert it to a graceful envelope.
    """
    global _browser, _page, _playwright
    if _page is None or _page.is_closed():
        if _playwright is None:
            _playwright = await async_playwright().start()
        if _browser is None or not _browser.is_connected():
            try:
                _browser = await _playwright.chromium.launch(headless=False)
            except Exception as e:  # noqa: BLE001 — most often: browser not installed
                raise RuntimeError(
                    "chromium browser not available (run 'playwright install chromium'): " + str(e)
                ) from e
        _page = await _browser.new_page()
    return _page


def _all_pages():
    """Every open Page across all contexts — Playwright's own tab bookkeeping (single source of truth)."""
    pages = []
    if _browser and _browser.is_connected():
        for ctx in _browser.contexts:
            pages.extend(ctx.pages)
    return pages


@mcp.tool()
async def browser_open(url: str, new_tab: bool = False) -> dict:
    """Open a URL in the browser.

    Args:
        url: URL to navigate to.
        new_tab: If True, open in a new tab instead of the current one.

    Returns:
        dict with 'success', 'url', 'title'.
    """
    if not _AVAILABLE:
        return _unavailable()
    global _page
    async with _lock:
        try:
            if new_tab and _browser and _browser.is_connected():
                _page = await _browser.new_page()
            else:
                await _ensure_browser()
            await _page.goto(url, wait_until="domcontentloaded", timeout=30000)
            return {"success": True, "url": _page.url, "title": await _page.title()}
        except Exception as e:
            return {"error": str(e)}


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
    if not _AVAILABLE:
        return _unavailable()
    global _browser, _page, _playwright
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
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}
