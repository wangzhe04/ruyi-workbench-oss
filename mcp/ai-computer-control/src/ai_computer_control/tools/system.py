"""System information and utility tools."""

import os
import time
import platform
import psutil
from ai_computer_control.server import mcp


@mcp.tool()
def get_system_info() -> dict:
    """Get comprehensive system information including OS, CPU, memory, and disk.

    Returns:
        dict with os, cpu, memory, and disk information.
    """
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")

    return {
        "os": {
            "system": platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "machine": platform.machine(),
            "hostname": platform.node(),
        },
        "cpu": {
            "physical_cores": psutil.cpu_count(logical=False),
            "logical_cores": psutil.cpu_count(logical=True),
            "usage_percent": psutil.cpu_percent(interval=0.5),
            "frequency_mhz": psutil.cpu_freq().current if psutil.cpu_freq() else None,
        },
        "memory": {
            "total_gb": round(mem.total / (1024**3), 1),
            "available_gb": round(mem.available / (1024**3), 1),
            "used_percent": mem.percent,
        },
        "disk": {
            "total_gb": round(disk.total / (1024**3), 1),
            "free_gb": round(disk.free / (1024**3), 1),
            "used_percent": round(disk.percent, 1),
        },
    }


@mcp.tool()
def wait(seconds: float) -> dict:
    """Wait for a specified number of seconds.

    Args:
        seconds: Number of seconds to wait (max 300).

    Returns:
        dict with 'success' and actual wait time.
    """
    seconds = min(seconds, 300)
    time.sleep(seconds)
    return {"success": True, "waited_seconds": seconds}


@mcp.tool()
def get_environment_variable(name: str) -> dict:
    """Get the value of an environment variable.

    Args:
        name: Environment variable name.

    Returns:
        dict with 'value' or 'error' if not found.
    """
    value = os.environ.get(name)
    if value is None:
        return {"error": f"Environment variable not found: {name}"}
    return {"name": name, "value": value}
