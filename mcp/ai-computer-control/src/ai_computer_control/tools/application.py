"""Application launch and process management tools."""

import os
import subprocess
import psutil
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import is_critical_process


@mcp.tool(audit=True)
def launch_application(
    path: str,
    args: str = "",
    working_dir: str | None = None,
    wait: bool = False,
) -> dict:
    """Launch an application by file path or registered name.

    Args:
        path: Application path (e.g. "notepad.exe", "C:/Program Files/app/app.exe")
              or a registered command (e.g. "calc", "mspaint").
        args: Optional command-line arguments.
        working_dir: Optional working directory for the application.
        wait: If True, wait for the application to finish.

    Returns:
        dict with 'success' and 'pid'.
    """
    try:
        cmd = path
        if args:
            cmd = f"{path} {args}"

        process = subprocess.Popen(
            cmd,
            shell=True,
            cwd=working_dir,
            stdout=subprocess.PIPE if wait else subprocess.DEVNULL,
            stderr=subprocess.PIPE if wait else subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        if wait:
            stdout, stderr = process.communicate()
            return {
                "success": True,
                "pid": process.pid,
                "return_code": process.returncode,
                "stdout": stdout or "",
                "stderr": stderr or "",
            }

        return {"success": True, "pid": process.pid}
    except Exception as e:
        return {"error": str(e)}


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

    if pid:
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
                hit = (name.strip().lower() in pnl) if contains else (os.path.splitext(pnl)[0] == base_t)
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
