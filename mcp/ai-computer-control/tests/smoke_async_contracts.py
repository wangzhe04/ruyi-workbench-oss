"""Regression checks for MCP argument binding and async tool dispatch.

Run: python -X utf8 tests/smoke_async_contracts.py
"""

import asyncio
import inspect
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))

import ai_computer_control.server as server  # noqa: E402
from ai_computer_control.tools import browser, keyboard, ocr  # noqa: E402


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"  [ok] {message}")


async def check_async_tools(tools: dict) -> None:
    # The browser backend need not be installed for this dispatch check. The important contract is
    # that FastMCP sees and awaits an async callable instead of trying to serialize a coroutine.
    old_browser_available = browser._AVAILABLE
    browser._AVAILABLE = False
    try:
        result = await tools["browser_open"].fn(url="https://example.invalid")
        check(result.get("ok") is False and "playwright" in result.get("error", ""),
              "async wrapper awaits browser tools and normalizes their result")
        batch_result = await tools["batch_actions"].fn(actions=[{
            "tool": "browser_open", "args": {"url": "https://example.invalid"}
        }])
        check(batch_result.get("failed") == 1 and "playwright" in str(batch_result),
              "batch_actions awaits async tools and reports their normalized failure")
    finally:
        browser._AVAILABLE = old_browser_available

    old_ocr_available = ocr._AVAILABLE
    old_screenshot = ocr._screenshot_png
    old_recognize = ocr._recognize

    async def fake_recognize(_png: bytes, _lang: str | None) -> dict:
        await asyncio.sleep(0)
        return {
            "success": True,
            "text": "SAO launcher",
            "lines": ["SAO launcher"],
            "words": [
                {"text": "SAO", "left": 10, "top": 20, "width": 30, "height": 10,
                 "center": [25, 25]},
                {"text": "launcher", "left": 45, "top": 20, "width": 55, "height": 10,
                 "center": [72, 25]},
            ],
        }

    ocr._AVAILABLE = True
    ocr._screenshot_png = lambda _region=None: b"fake-png"
    ocr._recognize = fake_recognize
    try:
        result = await tools["ocr_find_text"].fn(text="SAO", click=False)
        check(result.get("ok") is True and result.get("found") is True,
              "OCR runs on FastMCP's existing event loop without nested asyncio.run")
        check(result.get("center") == {"x": 25, "y": 25},
              "ocr_find_text preserves screen coordinates")
    finally:
        ocr._AVAILABLE = old_ocr_available
        ocr._screenshot_png = old_screenshot
        ocr._recognize = old_recognize


def main() -> int:
    tools = {tool.name: tool for tool in server.mcp._tool_manager.list_tools()}

    async_names = {
        name for name, tool in tools.items() if inspect.iscoroutinefunction(tool.fn)
    }
    expected_async = {
        "batch_actions", "macro_run",
        "browser_open", "browser_click", "browser_type", "browser_screenshot",
        "browser_get_text", "browser_execute_js", "browser_navigate", "browser_get_elements",
        "browser_list_tabs", "browser_switch_tab", "browser_close",
        "ocr_image", "ocr_screen", "ocr_click", "ocr_find_text", "observe",
    }
    check(expected_async <= async_names, "all async-backed tools remain async after registration")

    schema = tools["hotkey"].parameters["properties"]["keys"]
    check("anyOf" in schema, "hotkey schema accepts a shortcut string or key-name list")
    calls = []
    old_hotkey = keyboard.pyautogui.hotkey
    keyboard.pyautogui.hotkey = lambda *keys: calls.append(keys)
    try:
        one = tools["hotkey"].fn(keys="ctrl+l")
        two = tools["hotkey"].fn(keys=["ctrl", "shift", "s"])
    finally:
        keyboard.pyautogui.hotkey = old_hotkey
    check(one.get("ok") is True and calls[0] == ("ctrl", "l"),
          "hotkey binds the MCP keys keyword and parses ctrl+l")
    check(two.get("ok") is True and calls[1] == ("ctrl", "shift", "s"),
          "hotkey also accepts an explicit key-name list")

    asyncio.run(check_async_tools(tools))
    print("ALL PASS: MCP argument and async contracts are valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
