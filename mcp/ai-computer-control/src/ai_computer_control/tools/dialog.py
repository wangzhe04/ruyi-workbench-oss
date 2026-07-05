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


@mcp.tool()
def message_box(
    title: str,
    message: str,
    buttons: str = "ok",
    icon: str = "info",
) -> dict:
    """Show a Windows message box and return the user's response.

    Args:
        title: Message box title.
        message: Message text.
        buttons: Button style - "ok", "okcancel", "yesno", "yesnocancel".
        icon: Icon type - "info", "warning", "error", "question".

    Returns:
        dict with 'ok' and 'result' indicating which button was pressed.
    """
    try:
        style = _BUTTON_MAP.get(buttons, MB_OK) | _ICON_MAP.get(icon, MB_ICONINFO)
        result = ctypes.windll.user32.MessageBoxW(0, message, title, style)
        return {"ok": True, "result": _RESULT_MAP.get(result, str(result))}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
