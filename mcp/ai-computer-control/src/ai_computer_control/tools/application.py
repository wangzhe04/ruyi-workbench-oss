"""Application launch and process management tools."""

import os
import shlex
import subprocess
import time
import psutil
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import is_critical_process


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
    sub = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\\" + key
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
    """Launch an application and report whether it actually started.

    Unlike a naive shell launch, this resolves the target to a real executable, spawns it WITHOUT a
    shell (so the returned pid is the application itself, not a transient cmd.exe), and confirms the
    process is alive — a bad path returns an error instead of a false success.

    Args:
        path: Executable path ("notepad.exe", "C:/Program Files/app/app.exe"), a name on PATH, a
              registered app name (calc, mspaint, msedge, chrome, code), OR a document/URL to open
              with its default handler.
        args: Optional command-line arguments (quoted paths with spaces are handled).
        working_dir: Optional working directory.
        wait: If True, block until the process exits and capture its output (for console programs;
              meaningless for GUI apps — use wait=False + the returned 'window'/wait_for_window).
        ready_timeout: Seconds to wait for the app's main window to appear (0 to skip). The window
              info is returned so you can focus/click it immediately without a separate poll.
        wait_timeout: Seconds to wait for process exit when wait=True (default 120, clamped to
              [1, 600]). Previously the 2-second ready_timeout was (mis)reused as this cap, so a
              synchronous wait almost always "timed_out" — the two budgets are now independent.

    Returns:
        dict with 'success' + real 'pid' + 'name'; plus 'window' {hwnd,title,rect} and 'ready' when
        a window was found. On a bad launch: {success: False, ...} or {error: ...}.
    """
    exe = _resolve_executable(path)

    # Not a resolvable executable -> treat as a document/URL association (os.startfile).
    if exe is None:
        if args:
            return {"error": f"could not resolve executable '{path}' (not a file, not on PATH, not a registered app). "
                             f"Provide a full path, or drop args if you meant to open a document/URL."}
        try:
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
            stdout=subprocess.PIPE if wait else subprocess.DEVNULL,
            stderr=subprocess.PIPE if wait else subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception as e:  # noqa: BLE001 — bad path / permission / bad args
        return {"error": f"failed to launch '{path}': {type(e).__name__}: {e}"}

    if wait:
        try:
            cap = max(1, min(600, int(wait_timeout)))
            stdout, stderr = proc.communicate(timeout=cap)
            out = {
                "success": proc.returncode == 0,
                "pid": proc.pid,
                "name": os.path.basename(exe),
                "return_code": proc.returncode,
                "stdout": stdout or "",
                "stderr": stderr or "",
            }
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
        return {"success": True, "killed": killed, "skipped": skipped}

    return {"error": "Provide either pid or name."}
