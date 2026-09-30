"""Shared error-envelope helpers so a failure never reaches the model with an empty message.

``str(e)`` is ``""`` for ``TimeoutError()``, ``KeyError()``, some ``OSError`` variants and more, which used
to produce ``{"error": ""}`` (falsy -> reported as success). Always render with :func:`exc_text`.
"""


def exc_text(e: BaseException) -> str:
    """``"TypeName: message"`` (or just ``"TypeName"`` when the exception carries no message)."""
    name = type(e).__name__
    try:
        msg = str(e)
    except Exception:  # noqa: BLE001 — a broken __str__ must not mask the original failure
        msg = ""
    msg = msg.strip()
    return f"{name}: {msg}" if msg else name


def fail(e: BaseException | str, hint: str | None = None, **extra) -> dict:
    """Uniform failure dict: ``{"ok": False, "error": ..., ["hint": ...], **extra}``."""
    if isinstance(e, BaseException):
        msg = exc_text(e)
    else:
        msg = str(e) if e else "unknown error"
    out = {"ok": False, "error": msg}
    if hint:
        out["hint"] = hint
    out.update(extra)
    return out


# ---------------------------------------------------------------------------------------------------
# Central next-step hints. ~300 error returns exist but only a handful carry a "hint"; rather than edit every
# site (and collide with the tool files other people are changing) the wrapper in server.py attaches the
# first matching hint to any failure that does not already have one. The patterns are the failures a
# desktop-automation agent hits most often; each maps to one obvious recovery action.
# ---------------------------------------------------------------------------------------------------
import re as _re

_HINTS: tuple[tuple["_re.Pattern[str]", str], ...] = tuple(
    (_re.compile(rx, _re.I), hint) for rx, hint in (
        (r"window not found|no window (?:found|matching)|invalid window handle",
         "Call list_windows() for the exact titles/hwnds (titles change); use wait_for_window(title) if the "
         "app was just launched."),
        (r"screen ?grab|cannot identify (?:image|display)|no display|failed to (?:take|capture) screenshot|"
         r"screenshot failed",
         "The desktop may be locked, on the UAC secure desktop, or the RDP session is disconnected; unlock/"
         "reconnect and retry. get_screen_info() shows what is capturable."),
        (r"fail-?safe",
         "pyautogui's fail-safe fired (pointer in a screen corner). Move the mouse to the middle of the "
         "screen and retry."),
        (r"winerror 32|being used by another process|sharing violation",
         "The file is open in another program (Excel/Word/an editor). Close it, or write to a different path."),
        (r"permissionerror|access is denied|permission denied|winerror 5\b|operation not permitted",
         "Access denied: the path/process is protected, read-only or needs elevation. Check "
         "diagnostics().is_admin, pick another location, or close the program holding it."),
        (r"no module named|modulenotfounderror|importerror|dll load failed|not installed|not available",
         "An optional dependency is missing or failed to load; call diagnostics() (optional / load_errors) to "
         "see what is available. Retrying will not help."),
        (r"filenotfounderror|no such file|file not found|文件不存在|源文件不存在|cannot find the (?:file|path)",
         "Check the path (absolute Windows path, correct extension) with list_directory / file_info."),
        (r"isadirectoryerror|is a directory",
         "That path is a folder, not a file; use list_directory for folders or pass a file path."),
        (r"notadirectoryerror|not a directory",
         "The directory does not exist or is a file; check it with file_info / list_directory."),
        (r"unicodedecodeerror|codec can't decode|解码失败",
         "The file is not in that encoding; pass encoding='gbk' / 'utf-8-sig', or treat it as binary."),
        (r"badzipfile|not a zip file|zipfile|corrupt|损坏|非 xlsx",
         "The file is not a valid Office document (corrupt, renamed, or partially written); check it with "
         "file_info and re-create it."),
        (r"target (?:page|closed)|browser has been closed|context or browser has been closed|"
         r"connection closed|has been closed",
         "The browser/page was closed; call browser_open to start a fresh session."),
        (r"timed? ?out|timeouterror",
         "The operation timed out. Check the current state with screenshot/observe, then retry once with a "
         "narrower scope or a longer timeout."),
        (r"out of range|outside (?:the )?screen|off-?screen|coordinates?.*(?:invalid|bounds)",
         "Call get_screen_info() for the screen bounds and re-target inside them."),
        (r"no space left|disk full|winerror 112",
         "The disk is full; free space or write to another drive."),
    )
)


def hint_for(error_text: str) -> str | None:
    """First matching next-step hint for an error message, or None."""
    if not error_text:
        return None
    for rx, hint in _HINTS:
        if rx.search(error_text):
            return hint
    return None
