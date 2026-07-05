"""Keyboard control tools."""

import pyautogui
import pyperclip
from ai_computer_control.server import mcp


@mcp.tool(audit=True)
def type_text(text: str, interval: float = 0.02, use_clipboard: bool = False) -> dict:
    """Type a string of text using the keyboard.

    For CJK characters (Chinese, Japanese, Korean) or special characters,
    set use_clipboard=True to paste via clipboard instead of typing key by key.

    Args:
        text: The text to type.
        interval: Seconds between each keystroke (ignored if use_clipboard=True).
        use_clipboard: If True, uses clipboard paste method (better for non-ASCII text).

    Returns:
        dict with 'ok' and the length typed.
    """
    try:
        if use_clipboard or not text.isascii():
            _type_via_clipboard(text)
        else:
            pyautogui.typewrite(text, interval=interval)
        return {"ok": True, "length": len(text)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _type_via_clipboard(text: str):
    """Type text via clipboard paste, restoring the previous clipboard afterward."""
    old_clipboard = pyperclip.paste()
    pyperclip.copy(text)
    pyautogui.hotkey("ctrl", "v")
    pyautogui.sleep(0.1)
    pyperclip.copy(old_clipboard)


@mcp.tool(audit=True)
def press_key(key: str) -> dict:
    """Press a single key or key combination.

    Args:
        key: Key name (e.g. "enter", "tab", "escape", "f5", "delete")
             or combination with + (e.g. "ctrl+c", "alt+f4", "ctrl+shift+s").

    Returns:
        dict with 'ok' and the key pressed.
    """
    try:
        if "+" in key:
            keys = [k.strip().lower() for k in key.split("+")]
            pyautogui.hotkey(*keys)
        else:
            pyautogui.press(key.strip().lower())
        return {"ok": True, "key": key}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def hotkey(*keys: str) -> dict:
    """Press a keyboard shortcut (multiple keys held simultaneously).

    Args:
        keys: Keys to press simultaneously (e.g. "ctrl", "shift", "s").

    Returns:
        dict with 'ok' and the keys pressed.
    """
    try:
        if not keys:
            return {"ok": False, "error": "provide at least one key"}
        pyautogui.hotkey(*[k.strip().lower() for k in keys])
        return {"ok": True, "keys": list(keys)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def key_down(key: str) -> dict:
    """Hold down a key (useful for drag operations or key combinations).

    Args:
        key: Key to hold down.

    Returns:
        dict with 'ok'.
    """
    try:
        pyautogui.keyDown(key.strip().lower())
        return {"ok": True, "key": key, "state": "down"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def key_up(key: str) -> dict:
    """Release a held key.

    Args:
        key: Key to release.

    Returns:
        dict with 'ok'.
    """
    try:
        pyautogui.keyUp(key.strip().lower())
        return {"ok": True, "key": key, "state": "up"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
