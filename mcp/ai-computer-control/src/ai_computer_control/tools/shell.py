"""Shell command execution tools."""

import ctypes
import locale
import os
import subprocess
import tempfile
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import dangerous_command_reason


_MAX_CAPTURE_BYTES = 1024 * 1024


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


def _read_capture(stream, enc: str) -> tuple[str, bool, int]:
    """Read a bounded head+tail from a seekable temporary capture file.

    Real commands occasionally print a downloaded image or an unbounded build log. Returning megabytes of
    binary-looking text through MCP makes the tool card appear frozen while JSON is encoded and rendered, so
    keep useful evidence from both ends and report the truncation explicitly.
    """
    stream.flush()
    stream.seek(0, os.SEEK_END)
    size = stream.tell()
    stream.seek(0)
    if size <= _MAX_CAPTURE_BYTES:
        return _decode(stream.read(), enc), False, size
    half = _MAX_CAPTURE_BYTES // 2
    head = stream.read(half)
    stream.seek(max(0, size - half))
    tail = stream.read(half)
    omitted = max(0, size - len(head) - len(tail))
    marker = f"\n...[{omitted} output bytes omitted]...\n"
    return _decode(head, enc) + marker + _decode(tail, enc), True, size


def _terminate_process_tree(proc: subprocess.Popen) -> None:
    """Best-effort bounded teardown for a timed-out command and its descendants."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
            return
        except Exception:
            pass
    else:
        try:
            os.killpg(proc.pid, 9)
            return
        except Exception:
            pass
    try:
        proc.kill()
    except Exception:
        pass


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
        dict with an explicit 'ok', 'stdout', 'stderr', 'return_code' (and the 'encoding' actually used).
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
        # Pipes make subprocess.run()/communicate() wait for EOF from every descendant that inherited the
        # handles. A launcher may exit successfully while its detached child keeps those handles open, leaving
        # the MCP request stuck in "running". Seekable temporary captures let us wait only for the command
        # process, then read the bytes already produced without depending on descendant pipe closure.
        with tempfile.TemporaryFile() as stdout_capture, tempfile.TemporaryFile() as stderr_capture:
            popen_kwargs = {
                "shell": shell,
                "cwd": working_dir,
                "stdout": stdout_capture,
                "stderr": stderr_capture,
            }
            if os.name == "nt":
                popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                popen_kwargs["start_new_session"] = True
            proc = subprocess.Popen(command, **popen_kwargs)
            timed_out = False
            try:
                return_code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                _terminate_process_tree(proc)
                try:
                    return_code = proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    return_code = proc.poll()
            stdout, stdout_truncated, stdout_bytes = _read_capture(stdout_capture, enc)
            stderr, stderr_truncated, stderr_bytes = _read_capture(stderr_capture, enc)
            if timed_out:
                return {
                    "ok": False,
                    "error": f"Command timed out after {timeout} seconds; process tree terminated",
                    "timed_out": True,
                    "stdout": stdout,
                    "stderr": stderr,
                    "return_code": return_code,
                    "encoding": enc,
                    "stdout_truncated": stdout_truncated,
                    "stderr_truncated": stderr_truncated,
                    "stdout_bytes": stdout_bytes,
                    "stderr_bytes": stderr_bytes,
                }
            result = {
                "ok": return_code == 0,
                "stdout": stdout,
                "stderr": stderr,
                "return_code": return_code,
                "encoding": enc,
            }
            if stdout_truncated:
                result["stdout_truncated"] = True
                result["stdout_bytes"] = stdout_bytes
            if stderr_truncated:
                result["stderr_truncated"] = True
                result["stderr_bytes"] = stderr_bytes
            if return_code != 0:
                result["error"] = f"Command exited with code {return_code}"
            return result
    except Exception as e:
        return {"ok": False, "error": str(e)}
