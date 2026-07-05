"""Shell command execution tools."""

import ctypes
import locale
import subprocess
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import dangerous_command_reason


def _default_console_encoding() -> str:
    """The OEM/console code page of the current Windows session (cp936 on zh-CN).

    A child console program writes bytes in this code page, NOT UTF-8, so hard-wiring utf-8 turns all
    Chinese output into U+FFFD mojibake. GetOEMCP matches a no-console child better than the parent's
    GetConsoleOutputCP.
    """
    try:
        return f"cp{ctypes.windll.kernel32.GetOEMCP()}"
    except Exception:
        try:
            return locale.getpreferredencoding(False) or "utf-8"
        except Exception:
            return "utf-8"


def _decode(b, enc: str) -> str:
    """Decode bytes trying the OEM code page first, then UTF-8 (for programs that emit UTF-8, e.g.
    git configured for UTF-8), and only then fall back to a lossy replace so nothing ever raises."""
    if b is None:
        return ""
    if isinstance(b, str):
        return b
    for e in (enc, "utf-8"):
        if not e:
            continue
        try:
            return b.decode(e)
        except (UnicodeDecodeError, LookupError):
            continue
    return b.decode(enc or "utf-8", errors="replace")


@mcp.tool(audit=True)
def run_command(
    command: str,
    working_dir: str | None = None,
    timeout: int = 60,
    shell: bool = True,
    encoding: str | None = None,
    allow_dangerous: bool = False,
) -> dict:
    """Execute a shell command and return its output.

    Args:
        command: The command to execute.
        working_dir: Optional working directory.
        timeout: Maximum execution time in seconds (default 60; capped at 600 so a hung command can't
                 wedge the server).
        shell: If True (default), execute through the shell.
        encoding: Output encoding. Default (None) auto-decodes with the Windows OEM/console code page
                  (cp936 on zh-CN) then UTF-8 — pass "utf-8" to force it for a UTF-8-emitting program.
        allow_dangerous: Override the destructive-command denylist (default off).

    Returns:
        dict with 'stdout', 'stderr', 'return_code' (and the 'encoding' actually used).
    """
    reason = dangerous_command_reason(command)
    if reason and not allow_dangerous:
        return {"error": f"refused: {reason}. Pass allow_dangerous=true to override."}
    try:
        timeout = max(1, min(int(timeout), 600))
    except (TypeError, ValueError):
        timeout = 60
    enc = encoding or _default_console_encoding()
    try:
        result = subprocess.run(
            command,
            shell=shell,
            cwd=working_dir,
            capture_output=True,
            timeout=timeout,
            text=False,  # capture bytes and decode ourselves so encoding auto-detection can try both
        )
        return {
            "stdout": _decode(result.stdout, enc),
            "stderr": _decode(result.stderr, enc),
            "return_code": result.returncode,
            "encoding": enc,
        }
    except subprocess.TimeoutExpired:
        return {"error": f"Command timed out after {timeout} seconds"}
    except Exception as e:
        return {"error": str(e)}
