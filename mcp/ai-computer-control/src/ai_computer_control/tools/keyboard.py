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


# type_text routing: key-by-key typing is 20ms/char (200 chars = 4s of loop-blocking typing), and every
# "\n" is a real Enter that editors answer with auto-indent / auto-closing brackets (corrupting pasted
# code). So long or multi-line text goes through the clipboard, which pastes verbatim.
_CLIPBOARD_MIN_CHARS = 200


def _route_clipboard(text: str, use_clipboard: bool | None) -> tuple[bool, str]:
    """(use_clipboard, reason) — the auto-routing decision, kept pure so it can be unit-tested."""
    if use_clipboard is not None:
        return bool(use_clipboard), "explicit"
    if not text.isascii():
        return True, "non_ascii"
    # A trailing newline alone ("ls\n" = type it, then press Enter) is not multi-line content.
    if "\n" in text.rstrip("\r\n") or "\r" in text.rstrip("\r\n"):
        return True, "multiline"
    if len(text) > _CLIPBOARD_MIN_CHARS:
        return True, "long"
    return False, "short_ascii"


def _clipboard_seq() -> int | None:
    """Windows clipboard sequence number (changes on every clipboard write); None if unavailable."""
    try:
        return int(ctypes.windll.user32.GetClipboardSequenceNumber())
    except Exception:
        return None


def _paste_wait_s(text: str) -> float:
    """How long to let the target read the clipboard before restoring it (slow/remote/Electron targets
    read it late and would otherwise paste the OLD text): 0.4s, growing with size, capped at 2s."""
    return min(2.0, 0.4 + len(text) / 20000.0)


def _type_via_clipboard(text: str, sleep=None, seq=None) -> dict:
    """Paste `text` via the clipboard, preserving the user's prior TEXT clipboard.

    If the clipboard holds an image/files we still paste but cannot restore it (a text 'restore' would
    only destroy it further) — reported via 'displaced'. After Ctrl+V we wait for the paste to land and
    only restore if nobody else wrote the clipboard meanwhile (sequence number unchanged).
    Returns {"displaced": bool, "restore": "done" | "skipped_changed" | "failed" | "none"}.
    """
    sleep = sleep or pyautogui.sleep
    seq = seq or _clipboard_seq
    displaced = _clipboard_has_nontext()
    old = None
    if not displaced:
        try:
            old = pyperclip.paste()
        except Exception:
            old = None
    pyperclip.copy(text)
    mine = seq()
    pyautogui.hotkey("ctrl", "v")
    sleep(_paste_wait_s(text))
    restore = "none"
    if old is not None and not displaced:
        now = seq()
        if mine is not None and now is not None and now != mine:
            restore = "skipped_changed"   # someone else copied while we pasted: don't clobber that
        else:
            try:
                pyperclip.copy(old)
                restore = "done"
            except Exception:
                restore = "failed"
    return {"displaced": displaced, "restore": restore}


@mcp.tool(audit=True)
def type_text(text: str, interval: float = 0.02, use_clipboard: bool | None = None) -> dict:
    """Type a string of text using the keyboard.

    Args:
        text: The text to type.
        interval: Seconds between keystrokes (ignored for clipboard paste).
        use_clipboard: None (default) = auto: clipboard paste for non-ASCII/CJK, multi-line or long (>200 chars)
            text (verbatim, no editor auto-indent), key-by-key only for short single-line ASCII. True = force
            paste. False = force key-by-key (cannot produce CJK; editors may auto-indent multi-line text).

    Returns:
        dict with 'ok', 'length', and the 'method' used ('route' says why, 'restore' how the previous clipboard
        text was put back). Forced key-by-key with non-ASCII text adds a 'warning' naming untypable characters.
    """
    try:
        # b2-P2: 超长文本禁止逐键 typewrite(百万字符可阻塞数分钟)—— 强制走剪贴板路由
        if len(text) > 20000 and use_clipboard is False:
            return {"ok": False, "error": "text exceeds 20000 chars and use_clipboard=false would block for minutes; call with use_clipboard=true instead"}
        route_clipboard, reason = _route_clipboard(text, use_clipboard)
        if route_clipboard:
            # A long single-line text ending in newline(s) meant "type it, then press Enter"; a pasted
            # trailing newline would be dropped by a one-line field, so paste the body and press Enter.
            body, enters = text, 0
            if reason == "long":
                body = text.rstrip("\r\n")
                enters = text[len(body):].count("\n") or (1 if len(body) < len(text) else 0)
            res = _type_via_clipboard(body)
            for _ in range(enters):
                pyautogui.press("enter")
            out = {"ok": True, "length": len(text), "method": "clipboard", "route": reason,
                   "restore": res["restore"]}
            if enters:
                out["trailing_enter"] = enters
            if res["displaced"]:
                out["clipboard_displaced_nontext"] = True
                out["note"] = ("the clipboard held an image/files; it was replaced to paste this text and "
                               "could not be restored — re-copy that content if you still need it.")
            elif res["restore"] == "skipped_changed":
                out["note"] = ("the clipboard changed while pasting (another copy), so the previous "
                               "clipboard text was NOT restored over it.")
            return out
        pyautogui.typewrite(text, interval=interval)
        out = {"ok": True, "length": len(text), "method": "typewrite", "route": reason}
        n = sum(1 for c in text if ord(c) > 127)
        if n:
            out["warning"] = (f"{n} non-ASCII character(s) cannot be typed key-by-key and were dropped; "
                              f"call again with use_clipboard=true to enter them.")
        if "\n" in text:
            out["note"] = ("multi-line text was typed key by key: each newline is a real Enter, so the "
                           "editor may have auto-indented / auto-closed brackets. Use use_clipboard=true "
                           "to paste verbatim.")
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _validate_keys(parts: list[str]) -> list[str]:
    """Return the subset of key names pyautogui does not recognize (it silently ignores unknowns)."""
    try:
        valid = set(pyautogui.KEYBOARD_KEYS)
    except Exception:
        # b2-P2: 校验器异常时保守返回全部键名(调用方会全部拒绝),不再静默放行未知键
        return list(parts)
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
    """
    try:
        k = key.strip().lower()
        if _validate_keys([k]):
            return {"ok": False, "error": f"unknown key name: {key}"}
        pyautogui.keyUp(k)
        return {"ok": True, "key": key, "state": "up"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
