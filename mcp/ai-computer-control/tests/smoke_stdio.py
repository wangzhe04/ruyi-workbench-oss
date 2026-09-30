"""End-to-end stdio smoke test: launch the server as a subprocess and drive the real MCP JSON-RPC
handshake (newline-delimited: initialize -> notifications/initialized -> tools/list).

This is the ONLY test that exercises the actual stdio transport the way Claude launches the server.
It exists because an in-process `from ai_computer_control.server import mcp` check CANNOT catch the
`python -m ...server` double-import trap (two FastMCP instances; the empty __main__ one is what
mcp.run() would serve). Both supported launch forms must return the full tool set:

    python -X utf8 -m ai_computer_control.server     (module-as-__main__ form)
    python -X utf8 -m ai_computer_control            (package __main__.py form)

It also pins two protocol-level guarantees that only show up over the real pipe:
  * a child spawned by run_command gets NO stdin (it must never inherit the MCP JSON-RPC pipe, or it
    hangs until the timeout and eats the next requests);
  * the advertised tool input schemas carry no pydantic ``title`` / ``anyOf:[T,null]`` boilerplate.

Run:  python -X utf8 tests/smoke_stdio.py
Exits non-zero on any failure.
"""

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
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


class _Session:
    """A live server over stdio with a reader thread, so a lost response times out instead of blocking."""

    def __init__(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
        env["PYTHONIOENCODING"] = "utf-8"
        env["WCW_DATA_DIR"] = os.path.join(tempfile.gettempdir(), "acc_smoke_stdio_data")
        self.proc = subprocess.Popen(
            [sys.executable, "-X", "utf8", "-m", "ai_computer_control.server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, cwd=_ROOT, text=True, encoding="utf-8", bufsize=1)
        self.q: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        self.seen: dict = {}

    def _pump(self):
        for line in self.proc.stdout:
            try:
                self.q.put(json.loads(line))
            except json.JSONDecodeError:
                pass

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def call(self, rid, name, arguments):
        self.send({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                   "params": {"name": name, "arguments": arguments}})

    def wait_ids(self, ids, timeout):
        """Collect responses until every id in ``ids`` arrived (or the timeout); returns {id: msg}."""
        deadline = time.monotonic() + timeout
        want = set(ids)
        while want - set(self.seen) and time.monotonic() < deadline:
            try:
                msg = self.q.get(timeout=max(0.05, min(0.5, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if "id" in msg:
                self.seen[msg["id"]] = msg
        return self.seen

    def handshake(self):
        self.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "smoke_stdio", "version": "0"}}})
        if 1 not in self.wait_ids([1], 30):
            raise RuntimeError("no initialize response")
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def _tool_json(msg):
    """The tool's dict payload from a tools/call response (FastMCP wraps it as one JSON text block)."""
    try:
        return json.loads(msg["result"]["content"][0]["text"])
    except Exception:  # noqa: BLE001
        return {}


def _child_cmd(code: str) -> str:
    args = [sys.executable, "-c", code]
    if os.name == "nt":
        return subprocess.list2cmdline(args)
    import shlex
    return shlex.join(args)


def _check_stdin_isolation() -> bool:
    """A run_command child must get EOF on stdin instead of the server's JSON-RPC pipe."""
    print("== run_command children do not inherit the MCP stdin pipe ==")
    ok = True
    s = _Session()
    try:
        s.handshake()
        # (a) deterministic: a stdin-reading child must see EOF at once. Before the fix it inherited the
        # (silent) pipe and blocked until run_command's own timeout.
        t0 = time.monotonic()
        s.call(2, "run_command", {"command": _child_cmd("import sys; print(repr(sys.stdin.readline()))"),
                                  "timeout": 20})
        s.wait_ids([2], 25)
        dt = time.monotonic() - t0
        r = _tool_json(s.seen.get(2, {}))
        if 2 not in s.seen or dt > 8 or "''" not in (r.get("stdout") or ""):
            print(f"  [FAIL] stdin child did not get EOF promptly (answered={2 in s.seen}, {dt:.1f}s, result={r})")
            ok = False
        else:
            print(f"  [ok  ] stdin-reading child got EOF in {dt:.1f}s (stdout={r.get('stdout')!r})")
        # (b) requests sent while a child is reading stdin must all be answered (before the fix the child
        # swallowed some of them and they were never answered).
        s.call(3, "run_command", {"command": _child_cmd(
            "import sys\nfor _ in range(5): sys.stdin.readline()"), "timeout": 20})
        time.sleep(0.5)
        ids = list(range(4, 10))
        for rid in ids:
            s.call(rid, "version_info", {})
            time.sleep(0.2)
        s.wait_ids([3] + ids, 25)
        missing = sorted(set([3] + ids) - set(s.seen))
        if missing:
            print(f"  [FAIL] requests never answered (stolen by the child?): {missing}")
            ok = False
        else:
            print("  [ok  ] all follow-up requests answered while a child polled stdin")
    except Exception as e:  # noqa: BLE001
        print(f"  [FAIL] {type(e).__name__}: {e}")
        ok = False
    finally:
        s.close()
    return ok


def _check_schema_slim() -> bool:
    """tools/list input schemas carry no pydantic title / Optional-null boilerplate."""
    print("== advertised tool schemas are slim ==")
    s = _Session()
    try:
        s.handshake()
        s.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        s.wait_ids([2], 30)
        tools = s.seen[2]["result"]["tools"]
    except Exception as e:  # noqa: BLE001
        print(f"  [FAIL] tools/list: {type(e).__name__}: {e}")
        return False
    finally:
        s.close()
    blob = json.dumps([t.get("inputSchema") for t in tools], separators=(",", ":"))
    bad = []
    if '"title":"' in blob.replace('"title":{', ''):
        bad.append("title")
    if '{"type":"null"}' in blob:
        bad.append("anyOf-null")
    props_titles = [t["name"] for t in tools if "title" in (t.get("inputSchema") or {})]
    if bad or props_titles:
        print(f"  [FAIL] schema boilerplate left: {bad} top-level title on {props_titles[:3]}")
        return False
    rc = next((t for t in tools if t["name"] == "run_command"), {})
    if (rc.get("inputSchema", {}).get("properties", {}).get("working_dir") or {}).get("type") != "string":
        print("  [FAIL] Optional[str] parameter was not collapsed to type=string")
        return False
    print(f"  [ok  ] {len(tools)} tools, input schemas total {len(blob)} chars, no title/anyOf-null")
    return True


def main() -> int:
    results = []
    results.append(_check("module-as-__main__ form", ["-m", "ai_computer_control.server"]))
    results.append(_check("package __main__.py form", ["-m", "ai_computer_control"]))
    results.append(_check_stdin_isolation())
    results.append(_check_schema_slim())
    print()
    if all(results):
        print("ALL PASS: both launch forms expose the full tool set over stdio.")
        return 0
    print("FAILED: at least one launch form did not expose the full tool set over stdio.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
