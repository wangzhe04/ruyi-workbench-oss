"""Shell command execution tools."""

import subprocess
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import dangerous_command_reason


@mcp.tool(audit=True)
def run_command(
    command: str,
    working_dir: str | None = None,
    timeout: int = 60,
    shell: bool = True,
    encoding: str = "utf-8",
    allow_dangerous: bool = False,
) -> dict:
    """Execute a shell command and return its output.

    Args:
        command: The command to execute.
        working_dir: Optional working directory.
        timeout: Maximum execution time in seconds (default 60).
        shell: If True (default), execute through the shell.
        encoding: Output encoding (default utf-8).
        allow_dangerous: Override the destructive-command denylist (default off).

    Returns:
        dict with 'stdout', 'stderr', 'return_code'.
    """
    reason = dangerous_command_reason(command)
    if reason and not allow_dangerous:
        return {"error": f"refused: {reason}. Pass allow_dangerous=true to override."}
    try:
        result = subprocess.run(
            command,
            shell=shell,
            cwd=working_dir,
            capture_output=True,
            timeout=timeout,
            text=True,
            encoding=encoding,
            errors="replace",
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "return_code": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"error": f"Command timed out after {timeout} seconds"}
    except Exception as e:
        return {"error": str(e)}
