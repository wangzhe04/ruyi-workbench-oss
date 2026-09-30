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


# F14: a screenshot/observe step inside a batch returns its base64 in results[i].result.image, which the
# Ruyi workbench never sees (extractToolImages only reads TOP-LEVEL `image` / `image_base64` /
# `screenshot.image`), so the pixels were paid for and thrown away. We lift the newest images into
# those top-level keys (same names as the single screenshot tool) and cap them so a batch of many
# screenshots cannot flood the context.
_MAX_LIFTED_IMAGES = 2
_MIN_IMAGE_B64 = 1000          # anything shorter is not a real image payload
_LIFT_KEYS = ("image", "image_base64")   # top-level keys the workbench reads, in its order
_META_KEYS = ("width", "height", "scale", "format")


def _find_step_image(res):
    """(container_dict, key, b64) of the image payload inside one step result, or None."""
    if not isinstance(res, dict):
        return None
    for k in _LIFT_KEYS:
        v = res.get(k)
        if isinstance(v, str) and len(v) >= _MIN_IMAGE_B64:
            return res, k, v
    shot = res.get("screenshot")
    if isinstance(shot, dict):
        v = shot.get("image")
        if isinstance(v, str) and len(v) >= _MIN_IMAGE_B64:
            return shot, "image", v
    return None


def lift_batch_images(out: dict, max_images: int = _MAX_LIFTED_IMAGES) -> dict:
    """Move image payloads out of out['results'][i]['result'] into the top-level image channel.

    The NEWEST image lands in `image` (with its width/height/scale/format at top level, exactly like the
    screenshot tool); a second one, if any, in `image_base64`. `lifted_images` records which step each
    came from. Older images are dropped with `image_omitted: true` so the batch stays small.
    """
    results = out.get("results") if isinstance(out, dict) else None
    if not isinstance(results, list):
        return out
    found = []   # (result_index, container, key, b64)
    for i, r in enumerate(results):
        hit = _find_step_image(r.get("result")) if isinstance(r, dict) else None
        if hit:
            found.append((i, *hit))
    if not found:
        return out
    keep = found[-max(0, int(max_images)):] if max_images > 0 else []
    keep_ids = {f[0] for f in keep}
    lifted = []
    for slot, (i, cont, key, b64) in zip(_LIFT_KEYS, reversed(keep)):   # newest first
        res = results[i]["result"]
        entry = {"step": results[i].get("step", i), "tool": results[i].get("tool"), "key": slot}
        entry.update({k: res[k] for k in _META_KEYS if k in res})
        if slot == "image":
            out.update({k: res[k] for k in _META_KEYS if k in res})
        out[slot] = b64
        lifted.append(entry)
    for i, cont, key, b64 in found:
        clean = dict(results[i]["result"])
        if cont is not results[i]["result"]:   # nested screenshot.image
            clean["screenshot"] = {k: v for k, v in cont.items() if k != "image"}
        else:
            clean.pop(key, None)
        if i in keep_ids:
            clean["image_lifted"] = True
        else:
            clean["image_omitted"] = True
            clean["hint"] = f"only the last {max_images} batch images are returned; call screenshot separately"
        results[i]["result"] = clean
    out["lifted_images"] = lifted
    return out


async def _invoke(tool, args: dict):
    fn = tool.fn
    if getattr(tool, "is_async", False):
        return await fn(**args)
    return fn(**args)


async def _run_batch(actions: list[dict], on_error: str, delay_ms: int) -> dict:
    tools = _tool_map()
    # b2-P1: on_error 白名单 + delay_ms 钳制
    # b2-P2: 批量上限(防一次性提交数千条副作用步骤)
    if len(actions or []) > 200:
        return {"error": "actions 超过 200 条上限;请拆成多次 batch_actions 调用", "success": False}
    if on_error not in ("stop", "continue"):
        return {"error": f"on_error must be 'stop' or 'continue', got {on_error!r}; refusing to guess (a typo would silently become continue and run all steps)", "success": False}
    try:
        delay_ms = max(0, int(delay_ms))
    except (TypeError, ValueError):
        delay_ms = 0
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
    return lift_batch_images({"success": failed == 0, "completed": completed, "failed": failed,
                              "results": results})


@mcp.tool(audit=True)
async def batch_actions(actions: list[dict], on_error: str = "stop", delay_ms: int = 0) -> dict:
    """Run several tool calls in ONE round-trip.

    Args:
        actions: list of steps, each {"tool": "<tool_name>", "args": {...}}.
        on_error: "stop" (default) halts on the first failing step; "continue" runs all steps.
        delay_ms: optional pause between steps (ms).

    Returns:
        dict with 'success', 'completed', 'failed', and 'results' (per-step {tool, ok, result|error}).
        Screenshots taken by steps are returned in the top-level 'image' (newest; plus 'image_base64'
        for the one before it) — at most the last 2 — and marked image_lifted/image_omitted in 'results'.
    """
    return await _run_batch(actions, on_error, delay_ms)


@mcp.tool(audit=True)
async def macro_run(steps: list[dict], on_error: str = "stop", delay_ms: int = 120) -> dict:
    """Replay a Claude-authored macro (a JSON list of tool steps) in one round-trip.

    Same shape as batch_actions but with a small default inter-step delay suited to UI automation
    (focus -> type -> click sequences). See batch_actions for the step schema.
    """
    return await _run_batch(steps, on_error, delay_ms)
