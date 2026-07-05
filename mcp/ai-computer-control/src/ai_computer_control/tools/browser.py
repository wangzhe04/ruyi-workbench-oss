"""Browser automation tools via Playwright.

Playwright is an OPTIONAL backend (both the Python package AND its Chromium browser must be present).
If either the import fails or — more commonly on a fresh box — `playwright install chromium` was never
run, the nine browser_* tools degrade gracefully: they return
``{ok:false, error:'playwright not installed', hint:'pip install playwright && playwright install chromium'}``
instead of crashing server startup or the tool call. This mirrors ocr.py / vision.py / uia.py.
"""

import base64
import io

from ai_computer_control.server import mcp

try:
    from playwright.sync_api import sync_playwright, Browser, Page  # type: ignore
    _AVAILABLE = True
    _IMPORT_ERROR = ""
except Exception as e:  # noqa: BLE001 — optional dependency; server must still start
    sync_playwright = None  # type: ignore
    Browser = Page = None  # type: ignore
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)

# Global browser state (only ever touched once _AVAILABLE is True).
_browser = None
_page = None
_playwright = None


def _unavailable() -> dict:
    """Uniform degraded response when the Playwright package OR its browser is missing."""
    out = {"ok": False, "error": "playwright not installed",
           "hint": "pip install playwright && playwright install chromium"}
    if _IMPORT_ERROR:
        out["detail"] = _IMPORT_ERROR
    return out


def _ensure_browser():
    """Ensure browser is launched and return the active page.

    Raises RuntimeError with an install hint if the Chromium browser binary is absent (the package
    imported fine but `playwright install chromium` was never run) so the calling tool can convert it
    to a graceful `{ok:false, ...}` envelope instead of a raw stack trace.
    """
    global _browser, _page, _playwright
    if _page is None or _page.is_closed():
        if _playwright is None:
            _playwright = sync_playwright().start()
        if _browser is None or not _browser.is_connected():
            try:
                _browser = _playwright.chromium.launch(headless=False)
            except Exception as e:  # noqa: BLE001 — most often: browser not installed
                raise RuntimeError(
                    "chromium browser not available (run 'playwright install chromium'): " + str(e)
                ) from e
        _page = _browser.new_page()
    return _page


@mcp.tool()
def browser_open(url: str, new_tab: bool = False) -> dict:
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
    try:
        if new_tab and _browser and _browser.is_connected():
            _page = _browser.new_page()
        else:
            _ensure_browser()

        _page.goto(url, wait_until="domcontentloaded", timeout=30000)
        return {"success": True, "url": _page.url, "title": _page.title()}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def browser_click(
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
    try:
        page = _ensure_browser()
        if selector:
            page.click(selector, timeout=5000)
        elif text:
            page.click(f"text={text}", timeout=5000)
        elif x is not None and y is not None:
            page.mouse.click(x, y)
        else:
            return {"error": "Provide selector, text, or x/y coordinates"}
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def browser_type(
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
    try:
        page = _ensure_browser()
        if clear:
            page.fill(selector, text, timeout=5000)
        else:
            page.type(selector, text, timeout=5000)
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def browser_screenshot() -> dict:
    """Take a screenshot of the current browser page.

    Returns:
        dict with 'image' (base64 PNG), 'width', 'height', 'url', 'title'.
    """
    if not _AVAILABLE:
        return _unavailable()
    try:
        from PIL import Image
        page = _ensure_browser()
        screenshot_bytes = page.screenshot(type="png")
        image = Image.open(io.BytesIO(screenshot_bytes))
        return {
            "image": base64.b64encode(screenshot_bytes).decode("utf-8"),
            "width": image.width,
            "height": image.height,
            "url": page.url,
            "title": page.title(),
        }
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def browser_get_text(selector: str | None = None) -> dict:
    """Extract text content from the page or a specific element.

    Args:
        selector: Optional CSS selector. If None, returns full page text.

    Returns:
        dict with 'text'.
    """
    if not _AVAILABLE:
        return _unavailable()
    try:
        page = _ensure_browser()
        if selector:
            element = page.query_selector(selector)
            text = element.inner_text() if element else ""
        else:
            text = page.inner_text("body")
        return {"text": text, "url": page.url}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def browser_execute_js(script: str) -> dict:
    """Execute JavaScript code in the browser page context.

    Args:
        script: JavaScript code to execute. The result of the last expression is returned.

    Returns:
        dict with 'result' containing the return value.
    """
    if not _AVAILABLE:
        return _unavailable()
    try:
        page = _ensure_browser()
        result = page.evaluate(script)
        return {"result": result}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def browser_navigate(action: str) -> dict:
    """Navigate the browser (back, forward, reload).

    Args:
        action: One of "back", "forward", or "reload".

    Returns:
        dict with 'success', 'url', 'title'.
    """
    if not _AVAILABLE:
        return _unavailable()
    try:
        page = _ensure_browser()
        if action == "back":
            page.go_back(wait_until="domcontentloaded")
        elif action == "forward":
            page.go_forward(wait_until="domcontentloaded")
        elif action == "reload":
            page.reload(wait_until="domcontentloaded")
        else:
            return {"error": f"Unknown action: {action}. Use 'back', 'forward', or 'reload'"}
        return {"success": True, "url": page.url, "title": page.title()}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def browser_get_elements(selector: str) -> dict:
    """Get information about elements matching a CSS selector.

    Args:
        selector: CSS selector to query.

    Returns:
        dict with 'elements' list containing tag, text, attributes.
    """
    if not _AVAILABLE:
        return _unavailable()
    try:
        page = _ensure_browser()
        elements = page.query_selector_all(selector)
        results = []
        for el in elements[:50]:
            results.append({
                "tag": el.evaluate("e => e.tagName.toLowerCase()"),
                "text": el.inner_text()[:200] if el.inner_text() else "",
                "id": el.get_attribute("id") or "",
                "class": el.get_attribute("class") or "",
                "href": el.get_attribute("href") or "",
                "value": el.get_attribute("value") or "",
                "visible": el.is_visible(),
            })
        return {"elements": results, "count": len(results)}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def browser_close() -> dict:
    """Close the browser instance.

    Returns:
        dict with 'success'.
    """
    if not _AVAILABLE:
        return _unavailable()
    global _browser, _page, _playwright
    try:
        if _page and not _page.is_closed():
            _page.close()
        if _browser and _browser.is_connected():
            _browser.close()
        if _playwright:
            _playwright.stop()
        _browser = None
        _page = None
        _playwright = None
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}
