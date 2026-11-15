"""LaunchServices application entry point for Mac."""
import os
import shlex

from ai_computer_control.server import mcp
from ai_computer_control.utils.macos_session import request


@mcp.tool(audit=True)
def launch_application(path: str, args: str = "", working_dir: str | None = None, wait: bool = False,
                       ready_timeout: float = 2.0, wait_timeout: float = 120.0) -> dict:
    """Launch or activate a Mac GUI application through LaunchServices and confirm its process identity.

    path accepts an absolute .app path, bundle ID such as com.apple.TextEdit, or an unambiguous installed
    name such as TextEdit. args uses POSIX quoting and supports up to 64 arguments, each at most 4096 bytes.
    Existing applications may be activated with empty args. Arguments require a new application process.
    ready_timeout is 0..3 seconds to observe a visible window, reported separately from successful launch.
    working_dir and wait=True require run_command. This GUI entry returns pid, process_start and a current
    window target when observed. Application termination is handled separately by close_window.
    """
    if working_dir is not None or wait:
        return {"ok":False, "code":"invalid_args", "error":"Use run_command for a working directory or synchronous process output"}
    try:
        arguments = shlex.split(args, posix=True)
    except ValueError:
        return {"ok":False, "code":"invalid_args", "error":"Application arguments have unmatched POSIX quotes"}
    if path.startswith("~"):
        path = os.path.expanduser(path)
    return request({"op":"application.launch", "path":path, "args":arguments, "ready_timeout":ready_timeout})
