"""Keyboard control tools."""

import ctypes
import pyautogui
import pyperclip
from ai_computer_control.server import mcp


def _clipboard_has_nontext() -> bool:
    """True if the clipboard currently holds an image or file list (not text) — so we must not
    clobber it with a naive text 'restore'. Uses IsClipboardFormatAvailable (no clipboard open needed)."""
    try:
        u = ctypes.windll.user32
        CF_BITMAP, CF_DIB, CF_HDROP = 2, 8, 15
        return any(u.IsClipboardFormatAvailable(f) for f in (CF_BITMAP, CF_DIB, CF_HDROP))
    except Exception:
        return False


def _type_via_clipboard(text: str) -> bool:
    """Paste `text` via the clipboard, preserving the user's prior TEXT clipboard.

    If the clipboard holds an image/files, we still paste but do NOT overwrite it back with text
    afterwards would already have destroyed it — so instead we detect that case and report it rather
    than silently wiping the user's copied image. Returns True if a non-text payload was displaced.
    """
    displaced = _clipboard_has_nontext()
    old = None
    if not displaced:
        try:
            old = pyperclip.paste()
        except Exception:
            old = None
    pyperclip.copy(text)
    pyautogui.hotkey("ctrl", "v")
    pyautogui.sleep(0.15)
    if old is not None and not displaced:
        try:
            pyperclip.copy(old)
        except Exception:
            pass
    return displaced


@mcp.tool(audit=True)
def type_text(text: str, interval: float = 0.02, use_clipboard: bool | None = None) -> dict:
    """Type a string of text using the keyboard.

    Args:
        text: The text to type.
        interval: Seconds between each keystroke (ignored when the clipboard method is used).
        use_clipboard: None (default) = auto (clipboard for non-ASCII/CJK, key-by-key for ASCII);
                       True = force clipboard paste; False = force key-by-key (cannot produce CJK).

    Returns:
        dict with 'ok', 'length', and the 'method' actually used. On a forced key-by-key call with
        non-ASCII text, a 'warning' flags the characters that could not be typed.
    """
    try:
        route_clipboard = (not text.isascii()) if use_clipboard is None else bool(use_clipboard)
        if route_clipboard:
            displaced = _type_via_clipboard(text)
            out = {"ok": True, "length": len(text), "method": "clipboard"}
            if displaced:
                out["clipboard_displaced_nontext"] = True
                out["note"] = ("the clipboard held an image/files; it was replaced to paste this text and "
                               "could not be restored — re-copy that content if you still need it.")
            return out
        pyautogui.typewrite(text, interval=interval)
        out = {"ok": True, "length": len(text), "method": "typewrite"}
        n = sum(1 for c in text if ord(c) > 127)
        if n:
            out["warning"] = (f"{n} non-ASCII character(s) cannot be typed key-by-key and were dropped; "
                              f"call again with use_clipboard=true to enter them.")
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _validate_keys(parts: list[str]) -> list[str]:
    """Return the subset of key names pyautogui does not recognize (it silently ignores unknowns)."""
    try:
        valid = set(pyautogui.KEYBOARD_KEYS)
    except Exception:
        return []
    return [k for k in parts if k not in valid]


@mcp.tool(audit=True)
def press_key(key: str) -> dict:
    """Press a single key or key combination.

    Args:
        key: Key name (e.g. "enter", "tab", "escape", "f5", "delete")
             or combination with + (e.g. "ctrl+c", "alt+f4", "ctrl+shift+s").

    Returns:
        dict with 'ok' and the key pressed. Unknown key names return an error instead of a silent no-op.
    """
    try:
        parts = [k.strip().lower() for k in key.split("+")] if "+" in key else [key.strip().lower()]
        bad = _validate_keys(parts)
        if bad:
            return {"ok": False, "error": f"unknown key name(s): {bad}. Use names like enter, tab, esc, "
                                          f"space, f5, ctrl, alt, shift, win, delete, up/down/left/right."}
        if len(parts) > 1:
            pyautogui.hotkey(*parts)
        else:
            pyautogui.press(parts[0])
        return {"ok": True, "key": key}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def hotkey(keys: str | list[str]) -> dict:
    """Press a keyboard shortcut (multiple keys held simultaneously).

    Args:
        keys: Shortcut such as "ctrl+l" or a list such as ["ctrl", "shift", "s"].

    Returns:
        dict with 'ok' and the keys pressed. Unknown key names return an error instead of a silent no-op.
    """
    try:
        if isinstance(keys, str):
            parts = [k.strip().lower() for k in keys.split("+") if k.strip()]
        elif isinstance(keys, list):
            parts = [str(k).strip().lower() for k in keys if str(k).strip()]
        else:
            return {"ok": False, "error": "keys must be a '+'-separated string or a list of key names"}
        if not parts:
            return {"ok": False, "error": "provide at least one key"}
        bad = _validate_keys(parts)
        if bad:
            return {"ok": False, "error": f"unknown key name(s): {bad}. Use names like ctrl, alt, shift, "
                                          f"win, enter, tab, esc, f1-f12, a-z, 0-9."}
        pyautogui.hotkey(*parts)
        return {"ok": True, "keys": parts}
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
        k = key.strip().lower()
        if _validate_keys([k]):
            return {"ok": False, "error": f"unknown key name: {key}"}
        pyautogui.keyDown(k)
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
        k = key.strip().lower()
        if _validate_keys([k]):
            return {"ok": False, "error": f"unknown key name: {key}"}
        pyautogui.keyUp(k)
        return {"ok": True, "key": key, "state": "up"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
