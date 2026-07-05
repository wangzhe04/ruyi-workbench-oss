"""End-to-end stdio smoke test: launch the server as a subprocess and drive the real MCP JSON-RPC
handshake (newline-delimited: initialize -> notifications/initialized -> tools/list).

This is the ONLY test that exercises the actual stdio transport the way Claude launches the server.
It exists because an in-process `from ai_computer_control.server import mcp` check CANNOT catch the
`python -m ...server` double-import trap (two FastMCP instances; the empty __main__ one is what
mcp.run() would serve). Both supported launch forms must return the full tool set:

    python -X utf8 -m ai_computer_control.server     (module-as-__main__ form)
    python -X utf8 -m ai_computer_control            (package __main__.py form)

Run:  python -X utf8 tests/smoke_stdio.py
Exits non-zero on any failure.
"""

import json
import os
import subprocess
import sys
import tempfile
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = os.path.join(_ROOT, "src")
_MIN_TOOLS = 88
_REQUIRED = {"diagnostics", "screenshot", "window_screenshot", "observe", "act_and_verify"}


def _handshake_list_tools(launch_args: list[str], timeout: float = 30.0) -> list[str]:
    """Start the server with `launch_args`, perform the MCP handshake, return the tool-name list."""
    env = dict(os.environ)
    # Ensure src/ is importable and the child speaks UTF-8; isolate the data dir.
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    env["WCW_DATA_DIR"] = os.path.join(tempfile.gettempdir(), "acc_smoke_stdio_data")

    proc = subprocess.Popen(
        [sys.executable, "-X", "utf8", *launch_args],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, cwd=_ROOT, text=True, encoding="utf-8", bufsize=1,
    )

    def send(obj):
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    def recv_result(expect_id, deadline):
        """Read newline-delimited JSON until a response with id==expect_id arrives (or timeout)."""
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if line == "":
                return None  # EOF
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == expect_id:
                return msg
        return None

    try:
        deadline = time.monotonic() + timeout
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "smoke_stdio", "version": "0"}}})
        init = recv_result(1, deadline)
        if init is None:
            raise RuntimeError("no initialize response (server did not start or crashed)")
        send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        resp = recv_result(2, deadline)
        if resp is None:
            raise RuntimeError("no tools/list response")
        tools = resp.get("result", {}).get("tools", [])
        return [t.get("name") for t in tools]
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def _check(label: str, launch_args: list[str]) -> bool:
    print(f"== {label}: {' '.join(launch_args)} ==")
    try:
        names = _handshake_list_tools(launch_args)
    except Exception as e:  # noqa: BLE001
        print(f"  [FAIL] handshake error: {e}")
        return False
    count = len(names)
    print(f"  tools returned over stdio: {count}")
    ok = True
    if count < _MIN_TOOLS:
        print(f"  [FAIL] expected >= {_MIN_TOOLS} tools, got {count}")
        ok = False
    missing = sorted(_REQUIRED - set(names))
    if missing:
        print(f"  [FAIL] missing required tools: {missing}")
        ok = False
    if ok:
        print(f"  [ok  ] >= {_MIN_TOOLS} tools and required {sorted(_REQUIRED)} all present")
    return ok


def main() -> int:
    results = []
    results.append(_check("module-as-__main__ form", ["-m", "ai_computer_control.server"]))
    results.append(_check("package __main__.py form", ["-m", "ai_computer_control"]))
    print()
    if all(results):
        print("ALL PASS: both launch forms expose the full tool set over stdio.")
        return 0
    print("FAILED: at least one launch form did not expose the full tool set over stdio.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
