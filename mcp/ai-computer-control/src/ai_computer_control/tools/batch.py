"""Batch execution + macro replay — run several tool calls in one MCP round-trip.

Reduces latency/overhead when an agent needs a short deterministic sequence (e.g. focus window ->
type -> press enter -> screenshot). Dispatches to the LIVE FastMCP tool registry so it always tracks
the real tool set; steps are isolated with per-step try/except.
"""

import asyncio
from ai_computer_control.server import mcp

# Tools that must never be invoked from inside a batch (prevents recursion / round-trip storms).
_NON_BATCHABLE = {"batch_actions", "macro_run"}


def _tool_map() -> dict:
    return {t.name: t for t in mcp._tool_manager.list_tools() if t.name not in _NON_BATCHABLE}


async def _invoke(tool, args: dict):
    fn = tool.fn
    if getattr(tool, "is_async", False):
        return await fn(**args)
    return fn(**args)


async def _run_batch(actions: list[dict], on_error: str, delay_ms: int) -> dict:
    tools = _tool_map()
    results, completed, failed = [], 0, 0
    for i, step in enumerate(actions or []):
        step = step or {}
        name = step.get("tool") or step.get("name")
        args = step.get("args") or step.get("arguments") or {}
        if not isinstance(args, dict):
            results.append({"step": i, "tool": name, "ok": False, "error": "args must be an object"})
            failed += 1
            if on_error == "stop":
                break
            continue
        if name not in tools:
            results.append({"step": i, "tool": name, "ok": False, "error": f"unknown or non-batchable tool: {name}"})
            failed += 1
            if on_error == "stop":
                break
            continue
        try:
            res = await _invoke(tools[name], args)
            # Prefer the tool's own normalized 'ok'; fall back to absence of an 'error' key.
            if isinstance(res, dict) and "ok" in res:
                ok = bool(res["ok"])
            else:
                ok = not (isinstance(res, dict) and res.get("error"))
            results.append({"step": i, "tool": name, "ok": ok, "result": res})
            if ok:
                completed += 1
            else:
                failed += 1
                if on_error == "stop":
                    break
        except Exception as e:  # noqa: BLE001 — isolate each step
            results.append({"step": i, "tool": name, "ok": False, "error": f"{type(e).__name__}: {e}"})
            failed += 1
            if on_error == "stop":
                break
        if delay_ms:
            await asyncio.sleep(delay_ms / 1000.0)
    return {"success": failed == 0, "completed": completed, "failed": failed, "results": results}


@mcp.tool(audit=True)
async def batch_actions(actions: list[dict], on_error: str = "stop", delay_ms: int = 0) -> dict:
    """Run several tool calls in ONE round-trip.

    Args:
        actions: list of steps, each {"tool": "<tool_name>", "args": {...}}.
        on_error: "stop" (default) halts on the first failing step; "continue" runs all steps.
        delay_ms: optional pause between steps (ms).

    Returns:
        dict with 'success', 'completed', 'failed', and 'results' (per-step {tool, ok, result|error}).
    """
    return await _run_batch(actions, on_error, delay_ms)


@mcp.tool(audit=True)
async def macro_run(steps: list[dict], on_error: str = "stop", delay_ms: int = 120) -> dict:
    """Replay a Claude-authored macro (a JSON list of tool steps) in one round-trip.

    Same shape as batch_actions but with a small default inter-step delay suited to UI automation
    (focus -> type -> click sequences). See batch_actions for the step schema.
    """
    return await _run_batch(steps, on_error, delay_ms)
