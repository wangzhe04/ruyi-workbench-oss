"""Application launch and process management tools."""

import os
import shlex
import subprocess
import time
import psutil
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import is_critical_process
from ai_computer_control.tools.shell import _clip_text, _decode, _default_console_encoding, _DEFAULT_OUTPUT_CHARS
from ai_computer_control.utils.errors import exc_text


def _split_args(args: str) -> list[str]:
    """Split a command-line argument string into clean tokens for a no-shell argv list.

    Uses shlex(posix=False) so Windows backslashes survive, then strips a single pair of
    surrounding quotes from each token. subprocess/list2cmdline re-quotes as needed, so a
    spaced path like  "C:\\Program Files\\x.txt"  round-trips correctly.
    """
    if not args or not args.strip():
        return []
    try:
        toks = shlex.split(args, posix=False)
    except ValueError:
        toks = args.split()
    out = []
    for t in toks:
        if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'":
            t = t[1:-1]
        out.append(t)
    return out


def _resolve_app_path(name: str) -> str | None:
    """Resolve a bare app name via the Windows 'App Paths' registry (e.g. msedge, chrome, code).

    These are launchable by name through the shell but are NOT on PATH, so shutil.which misses them.
    """
    try:
        import winreg
    except Exception:
        return None
    key = name if name.lower().endswith(".exe") else name + ".exe"
    sub = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + key
    for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(root, sub) as k:
                val, _ = winreg.QueryValueEx(k, None)  # default value = full exe path
        except OSError:
            continue
        if val:
            val = os.path.expandvars(val.strip().strip('"'))
            if os.path.isfile(val):
                return val
    return None


def _resolve_executable(path: str) -> str | None:
    """Best-effort resolve `path` to a concrete executable file, or None if it isn't one."""
    import shutil
    if os.path.isfile(path):
        return os.path.abspath(path)
    found = shutil.which(path)
    if found and os.path.isfile(found):
        return found
    return _resolve_app_path(path)


def _find_window_for_pid(pid: int, timeout: float) -> dict | None:
    """Poll up to `timeout` s for a visible, titled top-level window owned by `pid`.

    Returns {hwnd,title,rect} or None. Best-effort readiness signal so the caller does not have
    to hand-assemble a wait_for_window loop after every launch. Note: shim/UWP launchers (calc,
    Win11 notepad) show a window under a DIFFERENT pid, so None here does NOT mean launch failed —
    fall back to wait_for_window(title).
    """
    try:
        import win32gui
        import win32process
    except Exception:
        return None
    deadline = time.monotonic() + max(0.0, float(timeout))
    while True:
        found: list[tuple[int, str]] = []

        def _cb(hwnd, _):
            try:
                if not win32gui.IsWindowVisible(hwnd):
                    return True
                _, wpid = win32process.GetWindowThreadProcessId(hwnd)
                if wpid == pid:
                    t = win32gui.GetWindowText(hwnd)
                    if t:
                        found.append((hwnd, t))
            except Exception:
                pass
            return True

        try:
            win32gui.EnumWindows(_cb, None)
        except Exception:
            return None
        if found:
            hwnd, title = found[0]
            try:
                r = win32gui.GetWindowRect(hwnd)
                rect = {"x": r[0], "y": r[1], "width": r[2] - r[0], "height": r[3] - r[1]}
            except Exception:
                rect = None
            return {"hwnd": int(hwnd), "title": title, "rect": rect}
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.1)


@mcp.tool(audit=True)
def launch_application(
    path: str,
    args: str = "",
    working_dir: str | None = None,
    wait: bool = False,
    ready_timeout: float = 2.0,
    wait_timeout: float = 120.0,
) -> dict:
    """Launch an application and confirm it really started (real pid, main window when one appears).

    何时用: open a GUI/console program or a document/URL. 何时别用: shell pipelines, builds, scripts whose
    output you need (use run_command); killing/closing (kill_process / close_window).
    Spawned WITHOUT a shell, so the pid is the app itself; a bad path is an error, not a false success.
    The child gets no stdin (EOF).

    Args:
        path: Executable path ("notepad.exe", "C:/Program Files/app/app.exe"), a name on PATH, a registered
              app name (calc, mspaint, msedge, chrome, code), or a document/URL for its default handler.
        args: Command-line arguments (quoted paths with spaces are handled). Not allowed with a document/URL.
        working_dir: Working directory.
        wait: Block until exit and capture output (console programs only; for GUI apps use wait=False).
        ready_timeout: Seconds to wait for the main window (0 skips, max 60); its hwnd/title/rect come back
              so you can focus/click at once.
        wait_timeout: Seconds to wait for exit when wait=True (default 120, clamped to [1, 600]).

    Returns:
        dict with success, pid, name; plus window {hwnd,title,rect} and ready when a window was found.
        A bad launch gives {success: False, ...} or {error: ...}.
    """
    exe = _resolve_executable(path)
    try:
        ready_timeout = max(0.0, min(float(ready_timeout), 60.0))  # bounded: never poll for windows forever
    except (TypeError, ValueError):
        ready_timeout = 2.0

    # Not a resolvable executable -> treat as a document/URL association (os.startfile).
    if exe is None:
        if args:
            return {"error": f"could not resolve executable '{path}' (not a file, not on PATH, not a registered app). "
                             f"Provide a full path, or drop args if you meant to open a document/URL."}
        try:
            # b2-P2: 仅放行已知安全协议 —— 任意 URL 协议会触发系统处理程序(如 javascript: 或自定义协议)
            import urllib.parse as _up
            _scheme = _up.urlparse(path).scheme.lower()
            if _scheme and _scheme not in ("http", "https", "file"):
                return {"error": "refused to open scheme " + repr(_scheme) + " via shell association; only http(s)/file and plain paths are allowed"}
            os.startfile(path)  # raises FileNotFoundError on a bad path -> real error, not false success
        except Exception as e:  # noqa: BLE001
            return {"error": f"could not open '{path}': {type(e).__name__}: {e}"}
        return {
            "success": True, "pid": None, "launched_via": "shell-association",
            "note": "opened with the default handler; pid is not tracked — correlate the window via wait_for_window(title).",
        }

    try:
        proc = subprocess.Popen(
            [exe] + _split_args(args),
            cwd=working_dir,
            # Never inherit our stdin: it is the MCP JSON-RPC pipe (a child reading it would swallow the
            # next requests and hang until killed).
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if wait else subprocess.DEVNULL,
            stderr=subprocess.PIPE if wait else subprocess.DEVNULL,
            # Bytes, decoded below with run_command's rules (strict UTF-8 first, then the OEM code page
            # cp936/GBK, then replace) so both UTF-8 and GBK console programs come out readable.
        )
    except Exception as e:  # noqa: BLE001 — bad path / permission / bad args
        return {"error": f"failed to launch '{path}': {exc_text(e)}"}

    if wait:
        try:
            cap = max(1, min(600, int(wait_timeout)))
            raw_out, raw_err = proc.communicate(timeout=cap)
            enc = _default_console_encoding()
            stdout, out_cut = _clip_text(_decode(raw_out, enc), _DEFAULT_OUTPUT_CHARS)
            stderr, err_cut = _clip_text(_decode(raw_err, enc), _DEFAULT_OUTPUT_CHARS // 2)
            out = {
                "success": proc.returncode == 0,
                "pid": proc.pid,
                "name": os.path.basename(exe),
                "return_code": proc.returncode,
            }
            if out_cut or err_cut:
                out["output_truncated"] = True
            out["stderr"] = stderr
            out["stdout"] = stdout
            if cap != int(wait_timeout):
                out["wait_timeout_capped"] = cap
            return out
        except subprocess.TimeoutExpired:
            return {"success": True, "pid": proc.pid, "name": os.path.basename(exe),
                    "timed_out": True, "wait_timeout": cap,
                    "note": "still running; not killed. Use run_command for bounded console capture."}

    # Non-wait: quick liveness check — a program that exits non-zero almost immediately did NOT launch.
    time.sleep(0.25)
    rc = proc.poll()
    if rc is not None and rc != 0:
        return {"success": False, "pid": proc.pid, "name": os.path.basename(exe), "return_code": rc,
                "error": f"'{os.path.basename(exe)}' exited immediately with code {rc}"}

    out = {"success": True, "pid": proc.pid, "name": os.path.basename(exe)}
    if ready_timeout and ready_timeout > 0:
        win = _find_window_for_pid(proc.pid, ready_timeout)
        if win:
            out["ready"] = True
            out["window"] = win
        else:
            out["ready"] = False
            out["note"] = "no window found under this pid yet (a shim/UWP launcher may host the UI under another pid) — use wait_for_window(title) to confirm."
    return out


@mcp.tool()
def list_processes(name_filter: str | None = None) -> dict:
    """List running processes.

    Args:
        name_filter: Optional filter to match process names (case-insensitive partial match).

    Returns:
        dict with 'processes' list containing name, pid, cpu_percent, memory_mb.
    """
    processes = []
    for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_info"]):
        try:
            info = proc.info
            if name_filter and name_filter.lower() not in info["name"].lower():
                continue
            memory_mb = info["memory_info"].rss / (1024 * 1024) if info["memory_info"] else 0
            processes.append({
                "pid": info["pid"],
                "name": info["name"],
                "cpu_percent": info["cpu_percent"] or 0,
                "memory_mb": round(memory_mb, 1),
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    processes.sort(key=lambda p: p["memory_mb"], reverse=True)
    return {"processes": processes[:100]}


@mcp.tool(audit=True)
def kill_process(
    pid: int | None = None,
    name: str | None = None,
    force: bool = False,
    contains: bool = False,
    confirm: bool = False,
    allow_critical: bool = False,
) -> dict:
    """Kill a running process by PID or name — with safety guards.

    Args:
        pid: Process ID to kill.
        name: Process name to kill. By default matches the EXACT basename
              (case-insensitive, ".exe" optional), NOT a substring. This prevents
              e.g. name="s" from killing every process containing "s".
        force: If True, force kill (SIGKILL). Otherwise graceful terminate.
        contains: Opt in to substring matching (dangerous — use with confirm).
        confirm: Required when a name matches more than one process.
        allow_critical: Override the critical-OS-process denylist (default off).

    Returns:
        dict with 'success'/'killed', plus 'skipped' (critical) and 'needs_confirm' when relevant.
    """
    def _term(proc):
        proc.kill() if force else proc.terminate()

    if pid is not None:
        try:
            proc = psutil.Process(pid)
            pname = proc.name()
        except psutil.NoSuchProcess:
            return {"error": f"Process not found: PID {pid}"}
        if is_critical_process(pname) and not allow_critical:
            return {"error": f"refused to kill critical process '{pname}' (pid {pid}); pass allow_critical=true to override"}
        try:
            _term(proc)
        except psutil.AccessDenied:
            return {"error": f"Access denied killing PID {pid} ('{pname}')"}
        return {"success": True, "killed": [{"pid": pid, "name": pname}]}

    if name and name.strip():
        stripped = name.strip()
        # Reject over-broad matches that could tear down the whole session.
        if contains and len(stripped) < 3:
            return {"error": "with contains=true, name must be at least 3 characters"}
        if not contains and len(stripped) < 1:
            return {"error": "name must be a specific process name"}
        base_t = os.path.splitext(stripped.lower())[0]
        matches, skipped = [], []
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                pn = proc.info["name"] or ""
                pnl = pn.lower()
                hit = (stripped.lower() in pnl) if contains else (os.path.splitext(pnl)[0] == base_t)
                if not hit:
                    continue
                if is_critical_process(pn) and not allow_critical:
                    skipped.append({"pid": proc.info["pid"], "name": pn, "reason": "critical"})
                else:
                    matches.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        if not matches:
            return {"error": f"No killable processes match '{name}'", "skipped": skipped}
        if len(matches) > 1 and not confirm:
            return {
                "needs_confirm": True,
                "matches": [{"pid": p.info["pid"], "name": p.info["name"]} for p in matches],
                "skipped": skipped,
                "message": f"{len(matches)} processes match '{name}'. Pass confirm=true to kill all, or target a single pid.",
            }
        killed = []
        for p in matches:
            try:
                _term(p)
                killed.append({"pid": p.info["pid"], "name": p.info["name"]})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        if not killed and not skipped:
            return {"success": False, "killed": [], "skipped": skipped,
                    "error": "all matching processes failed to terminate (AccessDenied/NoSuchProcess); nothing was killed"}
        return {"success": True, "killed": killed, "skipped": skipped}

    return {"error": "Provide either pid or name."}
