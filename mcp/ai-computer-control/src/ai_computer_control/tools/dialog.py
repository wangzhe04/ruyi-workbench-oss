"""Dialog and notification tools for Windows."""

import ctypes
from ai_computer_control.server import mcp

# PowerShell toast fallback. Title/message are passed via environment variables (never string-
# interpolated into the script) so quotes/newlines in the text can't break or inject into the script.
_TOAST_PS = (
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
    "ContentType = WindowsRuntime] | Out-Null; "
    "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent("
    "[Windows.UI.Notifications.ToastTemplateType]::ToastText02); "
    "$n=$t.GetElementsByTagName('text'); "
    "$n.Item(0).AppendChild($t.CreateTextNode($env:WCW_TOAST_TITLE)) | Out-Null; "
    "$n.Item(1).AppendChild($t.CreateTextNode($env:WCW_TOAST_MSG)) | Out-Null; "
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($t); "
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
    "'AI Computer Control').Show($toast)"
)


@mcp.tool()
def show_notification(title: str, message: str, duration: int = 5) -> dict:
    """Show a Windows toast notification.

    Args:
        title: Notification title.
        message: Notification message body.
        duration: Display duration in seconds (approximate).

    Returns:
        dict with 'ok'.
    """
    try:
        from win10toast import ToastNotifier
        toaster = ToastNotifier()
        toaster.show_toast(title, message, duration=duration, threaded=True)
        return {"ok": True, "method": "win10toast"}
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}

    # Fallback: PowerShell toast (text passed out-of-band via env to avoid injection).
    try:
        import os
        import subprocess
        env = dict(os.environ, WCW_TOAST_TITLE=str(title), WCW_TOAST_MSG=str(message))
        subprocess.Popen(
            ["powershell", "-NoProfile", "-Command", _TOAST_PS],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {"ok": True, "method": "powershell"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


# Message box button constants
MB_OK = 0x0
MB_OKCANCEL = 0x1
MB_YESNOCANCEL = 0x3
MB_YESNO = 0x4
MB_ICONINFO = 0x40
MB_ICONWARNING = 0x30
MB_ICONERROR = 0x10
MB_ICONQUESTION = 0x20

_BUTTON_MAP = {
    "ok": MB_OK,
    "okcancel": MB_OKCANCEL,
    "yesno": MB_YESNO,
    "yesnocancel": MB_YESNOCANCEL,
}

_ICON_MAP = {
    "info": MB_ICONINFO,
    "warning": MB_ICONWARNING,
    "error": MB_ICONERROR,
    "question": MB_ICONQUESTION,
}

_RESULT_MAP = {
    1: "ok",
    2: "cancel",
    6: "yes",
    7: "no",
}


IDTIMEOUT = 32000


@mcp.tool()
def message_box(
    title: str,
    message: str,
    buttons: str = "ok",
    icon: str = "info",
    timeout_ms: int = 30000,
) -> dict:
    """Show a Windows message box and return the user's response.

    IMPORTANT: this needs a human to click. It runs the (blocking) dialog on a background thread and
    auto-dismisses after `timeout_ms`, so an unattended call can never hang the server forever — a
    plain modal MessageBoxW on the server's event-loop thread would otherwise deadlock it permanently.

    Args:
        title: Message box title.
        message: Message text.
        buttons: Button style - "ok", "okcancel", "yesno", "yesnocancel".
        icon: Icon type - "info", "warning", "error", "question".
        timeout_ms: Auto-dismiss after this many ms if no one responds (default 30s).

    Returns:
        dict with 'ok' and 'result' ("ok"/"cancel"/"yes"/"no", or "timeout" if auto-dismissed).
    """
    import threading

    style = _BUTTON_MAP.get(buttons, MB_OK) | _ICON_MAP.get(icon, MB_ICONINFO)
    holder: dict = {}

    def _show():
        try:
            fn = getattr(ctypes.windll.user32, "MessageBoxTimeoutW", None)
            if fn is not None:
                # (hWnd, lpText, lpCaption, uType, wLanguageId, dwMilliseconds) — auto-dismisses.
                fn.restype = ctypes.c_int
                holder["r"] = fn(0, ctypes.c_wchar_p(message), ctypes.c_wchar_p(title),
                                 style, 0, int(timeout_ms))
            else:
                holder["r"] = ctypes.windll.user32.MessageBoxW(0, message, title, style)
        except Exception as e:  # noqa: BLE001
            holder["e"] = e

    t = threading.Thread(target=_show, daemon=True)
    t.start()
    # Bounded wait: the blocking C call releases the GIL, so the event loop is free during the join;
    # worst case we wait timeout_ms (+slack) instead of forever.
    t.join(timeout=(int(timeout_ms) / 1000.0) + 2.0)

    if "e" in holder:
        return {"ok": False, "error": str(holder["e"])}
    if "r" not in holder:
        return {"ok": True, "result": "pending",
                "note": "dialog still open (no MessageBoxTimeoutW support and no response yet); server not blocked."}
    r = holder["r"]
    if r == IDTIMEOUT:
        return {"ok": True, "result": "timeout", "note": "no user responded within timeout_ms; auto-dismissed."}
    return {"ok": True, "result": _RESULT_MAP.get(r, str(r))}
