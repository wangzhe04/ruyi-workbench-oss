"""MCP Server entry point for AI Computer Control.

Registration goes through a thin wrapper (`mcp.tool`) that gives every tool a uniform response
envelope and a safety net:

  * the return value always carries a boolean ``ok`` key (derived from existing
    success/error/found/state semantics — legacy keys are preserved for back-compat);
  * an uncaught exception becomes ``{"ok": False, "error": ...}`` instead of a raw MCP protocol
    error (much friendlier for the calling agent);
  * mutating tools opt into the audit log via ``@mcp.tool(audit=True)``.
"""

import functools
import inspect

from mcp.server.fastmcp import FastMCP

VERSION = "1.9.0"

mcp = FastMCP(
    "AI Computer Control",
    instructions="A comprehensive toolkit for AI agents to control Windows computers. "
    "Provides screen capture, mouse/keyboard control, window management, "
    "file operations, browser automation, document editing, and more. "
    "Every tool returns a dict with a boolean 'ok' field.",
)

# The original FastMCP decorator; our wrapper below registers through it.
_raw_tool = mcp.tool


def _normalize(result):
    """Guarantee the result is a dict carrying a boolean 'ok', preserving existing keys.

    'ok' reflects ONLY whether the tool *executed* without error — never the query outcome.
    A tool that ran fine but found nothing (found/has_image=False, not_found/matched=... ) is a
    successful call with a negative *result*, so ok stays True. This matters downstream: a native
    tool loop must not read ok:false (execution failed) as "found nothing" and blindly retry.

    ok is False only when there is a genuine execution error:
      * 'error' key is truthy, OR
      * explicit 'success' is falsy, OR
      * 'state' == 'error' (e.g. wait_for_window_idle failed to open the process).
    Result fields 'found' / 'has_image' / 'not_found' / 'matched' are left untouched and do NOT
    drive 'ok'.
    """
    if not isinstance(result, dict):
        return {"ok": True, "result": result}
    if "ok" in result:
        result["ok"] = bool(result["ok"])
        return result
    if result.get("error"):
        result["ok"] = False
    elif "success" in result:
        result["ok"] = bool(result["success"])
    elif result.get("state") == "error":
        result["ok"] = False
    else:
        # No error signal -> the call executed. Query fields like found/has_image/not_found
        # describe the *outcome*, not a failure, so ok stays True.
        result["ok"] = True
    return result


def tool(*d_args, audit: bool = False, **d_kwargs):
    """Drop-in replacement for ``mcp.tool`` adding response normalization + optional audit.

    Usage: ``@mcp.tool()`` or ``@mcp.tool(audit=True)``. Extra args/kwargs pass through to FastMCP.
    """

    def decorator(fn):
        tool_name = getattr(fn, "__name__", "tool")
        try:
            sig = inspect.signature(fn)
        except (TypeError, ValueError):
            sig = None

        def _bind(args, kwargs):
            """Best-effort map of the actual call args to a {param: value} dict for the audit log."""
            if sig is not None:
                try:
                    b = sig.bind_partial(*args, **kwargs)
                    return dict(b.arguments)
                except TypeError:
                    pass
            return kwargs or ({"_args": list(args)} if args else {})

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def wrapper(*args, **kwargs):
                try:
                    result = await fn(*args, **kwargs)
                except Exception as e:  # noqa: BLE001 — clean envelope, never a protocol error
                    out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                    if audit:
                        _audit_safe(tool_name, _bind(args, kwargs), False)
                    return out
                out = _normalize(result)
                if audit:
                    _audit_safe(tool_name, _bind(args, kwargs), out.get("ok", True))
                return out
        else:
            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                try:
                    result = fn(*args, **kwargs)
                except Exception as e:  # noqa: BLE001 — clean envelope, never a protocol error
                    out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                    if audit:
                        _audit_safe(tool_name, _bind(args, kwargs), False)
                    return out
                out = _normalize(result)
                if audit:
                    _audit_safe(tool_name, _bind(args, kwargs), out.get("ok", True))
                return out

        return _raw_tool(*d_args, **d_kwargs)(wrapper)

    return decorator


def _audit_safe(tool_name, args, ok):
    """Call the audit logger without ever letting it raise into the tool path."""
    try:
        from ai_computer_control.tools.audit import log_action
        log_action(tool_name, args, ok)
    except Exception:
        pass


# Install the wrapper as the module-level decorator every tool file imports.
mcp.tool = tool  # type: ignore[assignment]


# Import and register all tool modules
# v1.9 (49d, 03 Phase B #3): ACC_TOOLSETS 环境变量按能力子集注册 —— 逗号分隔的能力名
# (如 "filesystem,shell,office"),未设置=全开(向后兼容)。审计/诊断/文件基础永远注册。
# 价值:100+ 工具全量 schema 是 token 主来源(03 方案 T9),独立部署按宿主需求裁剪首 token 成本。
import os as _os  # noqa: E402

_TOOLSET_MODULES = {
    "desktop":   ["screen", "mouse", "keyboard", "clipboard", "window", "application", "system", "desktop_extra", "dialog"],
    "office":    ["document", "office_excel", "office_pptx", "office_chart", "office_read"],
    "browser":   ["browser"],
    "filesystem": ["filesystem", "editing", "image_tools"],
    "shell":     ["shell"],
    "uia":       ["uia"],
    "ocr":       ["ocr"],
    "vision":    ["vision", "capture"],
    "macro":     ["record", "batch"],
    "memory":    ["memory"],
    "web":       ["web_fetch"],
    "thinking":  ["thinking"],
    "observe":   ["observe", "act_and_verify"],
    "audio":     ["audio"],
    "sync":      ["sync"],
}
_ALWAYS_MODULES = ["audit", "diagnostics"]


def _active_modules() -> list[str]:
    raw = _os.environ.get("ACC_TOOLSETS", "").strip()
    if not raw:
        mods = []
        for group in _TOOLSET_MODULES.values():
            mods.extend(group)
        return _ALWAYS_MODULES + mods
    mods = list(_ALWAYS_MODULES)
    unknown = []
    for name in (p.strip().lower() for p in raw.split(",")):
        if not name:
            continue
        if name in _TOOLSET_MODULES:
            mods.extend(_TOOLSET_MODULES[name])
        else:
            unknown.append(name)
    if unknown:
        import sys as _sys
        print(f"[ai-computer-control] ACC_TOOLSETS: unknown toolset(s) ignored: {', '.join(unknown)}", file=_sys.stderr)
    # preserve order, drop dupes
    seen, out = set(), []
    for m in mods:
        if m not in seen:
            seen.add(m)
            out.append(m)
    return out


import importlib as _importlib  # noqa: E402

for _mod in _active_modules():
    _importlib.import_module(f"ai_computer_control.tools.{_mod}")
del _mod


def main():
    """Run the MCP server."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    # `python -m ai_computer_control.server` loads this file as __main__ AND (via tool modules doing
    # `from ai_computer_control.server import mcp`) re-imports it as ai_computer_control.server — two
    # module objects, two FastMCP instances. Tools register on the canonical one; delegate to it so we
    # run the populated instance, not this empty __main__ copy.
    from ai_computer_control.server import main as _main
    _main()
