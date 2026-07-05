"""Audio cues — useful for grabbing an away-from-desk operator's attention."""

import winsound
from ai_computer_control.server import mcp

_BEEP_ALIASES = {
    "asterisk": winsound.MB_ICONASTERISK,
    "info": winsound.MB_ICONASTERISK,
    "exclamation": winsound.MB_ICONEXCLAMATION,
    "warning": winsound.MB_ICONEXCLAMATION,
    "hand": winsound.MB_ICONHAND,
    "error": winsound.MB_ICONHAND,
    "question": winsound.MB_ICONQUESTION,
    "ok": winsound.MB_OK,
    "default": winsound.MB_OK,
}


@mcp.tool()
def beep(frequency: int = 800, duration_ms: int = 250) -> dict:
    """Play a tone through the PC speaker / default device.

    Args:
        frequency: Tone frequency in Hz (37-32767).
        duration_ms: Duration in milliseconds.
    """
    try:
        winsound.Beep(max(37, min(32767, int(frequency))), max(1, int(duration_ms)))
        return {"success": True}
    except Exception as e:  # noqa: BLE001 — RDP/headless sessions may lack a device
        return {"error": str(e)}


@mcp.tool()
def notify_attention(sound: str = "asterisk") -> dict:
    """Play a standard Windows notification sound to get the operator's attention.

    Args:
        sound: one of asterisk|info|exclamation|warning|hand|error|question|ok|default.
    """
    try:
        winsound.MessageBeep(_BEEP_ALIASES.get(sound.lower(), winsound.MB_OK))
        return {"success": True, "sound": sound}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


@mcp.tool()
def play_sound(path: str | None = None, alias: str | None = None) -> dict:
    """Play a .wav file or a named Windows system sound (async, non-blocking).

    Args:
        path: Absolute path to a .wav file.
        alias: A system sound alias, e.g. "SystemAsterisk", "SystemExclamation".
    """
    try:
        if path:
            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
            return {"success": True, "played": path}
        if alias:
            winsound.PlaySound(alias, winsound.SND_ALIAS | winsound.SND_ASYNC)
            return {"success": True, "played": alias}
        return {"error": "provide path or alias"}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
