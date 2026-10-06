"""Shell command execution tools."""

import ctypes
import locale
import os
import re
import subprocess
import tempfile
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import dangerous_command_reason
from ai_computer_control.utils.errors import exc_text


# Per-stream character budget returned to the model. The host cuts a tool result at ~60K chars from the
# HEAD, which would drop the tail (where a build/test failure lives) and every field serialized after
# stdout, so the budget is kept far below that: head+tail with an explicit omitted-marker, status fields first.
_DEFAULT_OUTPUT_CHARS = 16000
_MIN_OUTPUT_CHARS = 1000
_MAX_OUTPUT_CHARS = 200000
_HEAD_SHARE = 4  # head gets 1/4 of the budget, tail 3/4 (errors are at the end)
_TRUNCATION_HINT = ("output was truncated (head + tail kept, middle omitted). Redirect to a file and read_file it, "
                    "filter at the source (findstr / Select-String / | Select-Object -Last 50), or raise "
                    "max_output_chars (max 200000).")


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


# PowerShell encodes its stdout/stderr with the console code page. On a non-Chinese Windows (OEM 437 / ANSI 1252)
# every Chinese character is written as "?" at the source, which no decoder can bring back. Same one-liner (and
# same reasoning) as the workbench's own PowerShell tools: UTF-8 without BOM, and $OutputEncoding in step.
# A failed assignment (no console) is swallowed and leaves the old behaviour; the child restores the code page on exit.
_PS_UTF8_PREAMBLE = ("try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)}catch{};"
                     "$OutputEncoding=[Console]::OutputEncoding;")

_PS_EXE_RX = re.compile(r'^\s*(?:"[^"]*[\\/]|[^\s"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?=\s|$)', re.I)
_PS_FLAG_RX = re.compile(r'\s+-{1,2}([A-Za-z]+)(?=\s|$)')
_PS_VALUE_RX = re.compile(r'\s+("[^"]*"|\S+)')
# Startup switches whose arity we know; anything else (-File, -EncodedCommand, -Version, ...) means "leave the
# command alone". -Command may be abbreviated to any prefix (-c, -co, ...).
_PS_FLAGS_NOARG = frozenset({"noprofile", "nop", "noninteractive", "noni", "nologo", "nol", "noexit", "noe",
                             "sta", "mta"})
_PS_FLAGS_ARG = frozenset({"executionpolicy", "ep", "windowstyle", "w", "inputformat", "outputformat"})


def _powershell_utf8_command(command: str) -> str | None:
    """`command` with the UTF-8 output preamble spliced in, or None when it is not a plain PowerShell call.

    Handles a command that STARTS with powershell/pwsh (optionally a quoted or full path to it) followed by only
    known startup switches and then -Command <text> (or bare command text). Everything else - -File,
    -EncodedCommand, a script block, `-Command -`, PowerShell behind `cmd /c` or `&&` - returns None and runs
    exactly as written. Pure string work (testable off Windows); the splice goes right after the opening quote
    of a quoted -Command text, or in front of unquoted text.
    """
    m = _PS_EXE_RX.match(command)
    if not m:
        return None
    pos = m.end()
    while True:
        f = _PS_FLAG_RX.match(command, pos)
        if f:
            name = f.group(1).lower()
            if "command".startswith(name):                 # -c / -co / ... / -command
                pos = f.end()
                break
            if name in _PS_FLAGS_NOARG:
                pos = f.end()
                continue
            if name in _PS_FLAGS_ARG:
                v = _PS_VALUE_RX.match(command, f.end())
                if not v:
                    return None
                pos = v.end()
                continue
            return None
        break                                              # no more switches: bare command text follows
    rest = command[pos:]
    stripped = rest.lstrip()
    if not stripped or stripped[0] in "{-":                # nothing to run / script block / `-` (stdin) / other switch
        return None
    at = pos + (len(rest) - len(stripped))
    if stripped[0] == '"':
        return command[:at + 1] + _PS_UTF8_PREAMBLE + command[at + 1:]
    return command[:at] + _PS_UTF8_PREAMBLE + " " + command[at:]


def _maybe_powershell_utf8(command: str, encoding: str | None, is_windows: bool | None = None) -> str | None:
    """The spliced command when run_command should force PowerShell to UTF-8, else None.

    Only on Windows, and not when the caller forced an output encoding (their encoding must keep decoding the bytes
    exactly as the program writes them).
    """
    if encoding or not (os.name == "nt" if is_windows is None else is_windows):
        return None
    return _powershell_utf8_command(command)


def _decode(b, enc: str, cut_start: bool = False, cut_end: bool = False, enc_first: bool = False) -> str:
    """Decode bytes: strict UTF-8 first, then the console/OEM code page, then a lossy replace.

    UTF-8 goes first because valid UTF-8 text (git, node, python -X utf8, PowerShell 7, chcp 65001) is very
    often ALSO a valid GBK byte string and would decode as mojibake there, whereas real GBK text almost never
    validates as UTF-8. ``cut_start`` / ``cut_end`` mark a chunk sliced out of a larger stream, so a
    character split at the boundary is trimmed instead of pushing the whole chunk into lossy replace.
    ``enc_first`` honours an encoding the caller asked for explicitly (tried before UTF-8).
    """
    if b is None:
        return ""
    if isinstance(b, str):
        return b
    order = ((enc, 2), ("utf-8", 4)) if enc_first else (("utf-8", 4), (enc, 2))
    for codec, span in order:
        if not codec:
            continue
        for s0 in (range(span) if cut_start else (0,)):
            for e0 in (range(span) if cut_end else (0,)):
                chunk = b[s0:len(b) - e0] if e0 else b[s0:]
                try:
                    return chunk.decode(codec)
                except (UnicodeDecodeError, LookupError):
                    continue
    return b.decode(enc or "utf-8", errors="replace")


def _clip_text(text: str, max_chars: int) -> tuple[str, bool]:
    """Keep a head and a (larger) tail of ``text`` with an explicit omitted-chars marker."""
    if len(text) <= max_chars:
        return text, False
    head_n = max_chars // _HEAD_SHARE
    tail_n = max_chars - head_n
    omitted = len(text) - head_n - tail_n
    return f"{text[:head_n]}\n[…{omitted} chars omitted…]\n{text[len(text) - tail_n:]}", True


def _read_capture(stream, enc: str, max_chars: int = _DEFAULT_OUTPUT_CHARS,
                  enc_first: bool = False) -> tuple[str, bool, int]:
    """Read a bounded head+tail from a seekable temporary capture file.

    Returns ``(text, truncated, total_bytes)``. Real commands occasionally print a downloaded image or an
    unbounded build log; the text is cut to ``max_chars`` characters (head + larger tail + marker) and the
    file is never read whole when it is much bigger than that.
    """
    stream.flush()
    stream.seek(0, os.SEEK_END)
    size = stream.tell()
    stream.seek(0)
    window = max_chars * 4  # worst case: 4 bytes per character
    if size <= window:
        text, cut = _clip_text(_decode(stream.read(), enc, enc_first=enc_first), max_chars)
        return text, cut, size
    head_n = max_chars // _HEAD_SHARE
    tail_n = max_chars - head_n
    head_b = stream.read(head_n * 4)
    stream.seek(max(0, size - tail_n * 4))
    tail_b = stream.read()
    head = _decode(head_b, enc, cut_end=True, enc_first=enc_first)[:head_n]
    tail_text = _decode(tail_b, enc, cut_start=True, enc_first=enc_first)
    tail = tail_text[len(tail_text) - tail_n:] if len(tail_text) > tail_n else tail_text
    omitted = max(0, size - len(head_b) - len(tail_b))
    return f"{head}\n[…~{omitted} bytes omitted (stream is {size} bytes)…]\n{tail}", True, size


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
    max_output_chars: int = _DEFAULT_OUTPUT_CHARS,
) -> dict:
    """Execute a shell command and return its output.

    何时用: builds, git, scripts, one-off system queries. 何时别用: reading/writing files (read_file /
    write_file / edit_file), starting GUI apps (launch_application).
    The child gets NO stdin (EOF), so a command waiting for input fails fast instead of hanging.

    Args:
        command: The command to execute.
        working_dir: Working directory.
        timeout: Seconds (default 60, cap 600); on expiry the whole process tree is killed.
        shell: Run through the shell (default True).
        encoding: Force an output encoding. Default: strict UTF-8, then the OEM/console code page (cp936 on zh-CN);
            `powershell -Command ...` is made to emit UTF-8 so Chinese survives non-Chinese Windows code pages.
        allow_dangerous: Override the destructive-command denylist.
        max_output_chars: Per-stream budget (stderr gets half, min 2000), default 16000, max 200000; longer output
            keeps head + tail with an "[…N chars omitted…]" marker.

    Returns:
        dict: status first (ok, return_code, timed_out, *_truncated, hint), then stderr, then stdout, encoding.
    """
    reason = dangerous_command_reason(command)
    if reason and not allow_dangerous:
        return {"error": f"refused: {reason}. Pass allow_dangerous=true to override."}
    try:
        timeout = max(1, min(int(timeout), 600))
    except (TypeError, ValueError):
        timeout = 60
    try:
        max_chars = max(_MIN_OUTPUT_CHARS, min(int(max_output_chars), _MAX_OUTPUT_CHARS))
    except (TypeError, ValueError):
        max_chars = _DEFAULT_OUTPUT_CHARS
    err_chars = min(max_chars, max(2000, max_chars // 2))
    enc = encoding or _default_console_encoding()
    # PowerShell on a non-Chinese code page would write "?" for Chinese; make it emit UTF-8 (skipped when the caller
    # forces an encoding, and for anything that is not a plain `powershell -Command ...` invocation).
    patched = _maybe_powershell_utf8(command, encoding)
    run_cmd, ps_utf8 = (command, False) if patched is None else (patched, True)
    try:
        # Pipes make subprocess.run()/communicate() wait for EOF from every descendant that inherited the
        # handles. A launcher may exit successfully while its detached child keeps those handles open, leaving
        # the MCP request stuck in "running". Seekable temporary captures let us wait only for the command
        # process, then read the bytes already produced without depending on descendant pipe closure.
        with tempfile.TemporaryFile() as stdout_capture, tempfile.TemporaryFile() as stderr_capture:
            popen_kwargs = {
                "shell": shell,
                "cwd": working_dir,
                # Never inherit our stdin: it is the MCP JSON-RPC pipe. A child that reads stdin would block
                # until the timeout AND swallow the next protocol requests (they'd never be answered).
                "stdin": subprocess.DEVNULL,
                "stdout": stdout_capture,
                "stderr": stderr_capture,
            }
            if os.name == "nt":
                popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                popen_kwargs["start_new_session"] = True
            proc = subprocess.Popen(run_cmd, **popen_kwargs)
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
            stdout, stdout_truncated, stdout_bytes = _read_capture(stdout_capture, enc, max_chars, bool(encoding))
            stderr, stderr_truncated, stderr_bytes = _read_capture(stderr_capture, enc, err_chars, bool(encoding))
            # Field order matters: the host cuts a long serialized result from the head, so status and
            # truncation flags come first and the (shorter, more diagnostic) stderr before stdout.
            result = {"ok": (not timed_out) and return_code == 0}
            if timed_out:
                result["error"] = f"Command timed out after {timeout} seconds; process tree terminated"
                result["timed_out"] = True
            elif return_code != 0:
                result["error"] = f"Command exited with code {return_code}"
            result["return_code"] = return_code
            if stdout_truncated:
                result["stdout_truncated"] = True
                result["stdout_bytes"] = stdout_bytes
            if stderr_truncated:
                result["stderr_truncated"] = True
                result["stderr_bytes"] = stderr_bytes
            if stdout_truncated or stderr_truncated:
                result["hint"] = _TRUNCATION_HINT
            result["stderr"] = stderr
            result["stdout"] = stdout
            result["encoding"] = enc
            if ps_utf8:
                result["powershell_utf8"] = True
            return result
    except Exception as e:
        return {"ok": False, "error": exc_text(e)}
