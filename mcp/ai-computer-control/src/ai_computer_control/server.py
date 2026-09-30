"""MCP Server entry point for AI Computer Control.

Registration goes through a thin wrapper (`mcp.tool`) that gives every tool a uniform response
envelope and a safety net:

  * the return value always carries a boolean ``ok`` key (derived from existing
    success/error/found/state semantics — legacy keys are preserved for back-compat);
  * an uncaught exception becomes ``{"ok": False, "error": ...}`` instead of a raw MCP protocol
    error (much friendlier for the calling agent);
  * mutating tools opt into the audit log via ``@mcp.tool(audit=True)`` (or by name in
    ``_AUDITED_BY_NAME`` — the single choke point for tools whose module is edited elsewhere);
  * a tool module that fails to import does not take the server down: the failure is logged to stderr and
    surfaced by ``diagnostics().load_errors`` while every other tool stays registered;
  * failures carry a non-empty message and (where an obvious next step exists) a ``hint``.
"""

import sys

# ``uiautomation`` imports comtypes while tools are registered.  comtypes defaults the importing
# thread to STA, but this process runs WinRT OCR awaits on asyncio's Windows Proactor event-loop
# thread, which has no Win32 message pump.  On affected Windows/WinSDK combinations that leaves
# BitmapDecoder/OCR completion callbacks undelivered.  Declare the server thread as MTA before any
# dependency can import comtypes; UIA worker threads initialize COM for themselves where needed.
if sys.platform == "win32":
    sys.coinit_flags = 0x0  # COINIT_MULTITHREADED — hint read by comtypes when IT later inits COM
    # ``sys.coinit_flags`` is only a *hint* to comtypes; it does not initialize COM itself.  A
    # transitive dependency (winsdk WinRT OCR, a comtypes auto-init path, etc.) can implicitly
    # CoInitialize the main thread as STA before comtypes reads the flag, and an apartment mode is
    # immutable once chosen for the thread.  That silently left the live thread as STA on clean
    # Windows Server images (CI: CoGetApartmentType != MTA) and starved WinRT OCR callbacks.  Make
    # the MTA choice authoritative by explicitly calling CoInitializeEx(MTA) here, before any
    # FastMCP/tool/winsdk import runs.  ctypes/ole32 only — no pywin32 import (which would itself
    # touch COM and reintroduce the ordering problem).
    import ctypes as _ctypes
    _ole32 = _ctypes.windll.ole32
    # COINIT_MULTITHREADED = 0x0; ignore RPC_E_CHANGED_MODE (0x80010106) — already inited, and the
    # coinit_flags hint above keeps comtypes' own re-init consistent wherever possible.
    _hr = _ole32.CoInitializeEx(None, 0x0)
    if _hr < 0 and _hr & 0xFFFFFFFF != 0x80010106 and _hr & 0xFFFFFFFF != 0x00000001:
        # 0x00000001 (S_FALSE) = already MTA-inited on this thread; that's fine.
        import warnings as _warnings
        _warnings.warn(f"CoInitializeEx(MTA) returned 0x{_hr & 0xFFFFFFFF:08X}; COM apartment may not be MTA")

import functools
import inspect
import time

from mcp.server.fastmcp import FastMCP

from ai_computer_control.utils.errors import exc_text, hint_for

VERSION = "1.9.1"

mcp = FastMCP(
    "AI Computer Control",
    instructions="A comprehensive toolkit for AI agents to control Windows computers. "
    "Provides screen capture, mouse/keyboard control, window management, "
    "file operations, browser automation, document editing, and more. "
    "Every tool returns a dict with a boolean 'ok' field.",
)

# The original FastMCP decorator; our wrapper below registers through it.
_raw_tool = mcp.tool


def _slim_schema(node):
    """Strip pydantic boilerplate from a JSON-schema node in place (semantics-preserving for a model).

    Removes the auto-generated ``title`` of every schema node (never a *property named* "title"), collapses
    ``anyOf: [T, {type: null}]`` (Optional[T]) into T and drops the then-redundant ``default: null``.
    Validation is unaffected: FastMCP validates against the pydantic model, not this advertised schema, so an
    explicit null is still accepted. Measured ~40% of the tool-list schema characters.
    """
    if not isinstance(node, dict):
        return node
    node.pop("title", None)
    any_of = node.get("anyOf")
    if isinstance(any_of, list):
        rest = [m for m in any_of if not (isinstance(m, dict) and m.get("type") == "null")]
        if len(rest) == 1 and len(rest) < len(any_of) and isinstance(rest[0], dict):
            node.pop("anyOf")
            for k, v in rest[0].items():
                node.setdefault(k, v)
            if node.get("default", 0) is None:
                node.pop("default")
        elif len(any_of) > 1 and all(isinstance(m, dict) and set(m) == {"type"} and isinstance(m["type"], str)
                                     for m in any_of):
            # 纯原子类型并集(如表格单元格 str|int|float|bool|None)收成一个 type 数组:语义不变、更短,且保住 null。
            node.pop("anyOf")
            node["type"] = [m["type"] for m in any_of]
    for key in ("anyOf", "oneOf", "allOf"):
        if isinstance(node.get(key), list):
            for m in node[key]:
                _slim_schema(m)
    props = node.get("properties")
    if isinstance(props, dict):
        for child in props.values():
            _slim_schema(child)
    for key in ("items", "additionalProperties", "not"):
        if isinstance(node.get(key), dict):
            _slim_schema(node[key])
    for key in ("$defs", "definitions"):
        if isinstance(node.get(key), dict):
            for child in node[key].values():
                _slim_schema(child)
    return node


def _slim_registered_schema(name: str) -> None:
    """Post-process the advertised input schema of the tool just registered under ``name`` (best effort)."""
    try:
        t = mcp._tool_manager.get_tool(name)
        if t is not None and isinstance(t.parameters, dict):
            _slim_schema(t.parameters)
    except Exception:  # noqa: BLE001 — cosmetic; never block registration
        pass


_EMPTY_ERROR_TEXT = "unknown error (the tool returned an empty error message)"


def _normalize(result, tool: str | None = None):
    """Guarantee the result is a dict carrying a boolean 'ok', preserving existing keys.

    'ok' reflects ONLY whether the tool *executed* without error — never the query outcome.
    A tool that ran fine but found nothing (found/has_image=False, not_found/matched=... ) is a
    successful call with a negative *result*, so ok stays True. This matters downstream: a native
    tool loop must not read ok:false (execution failed) as "found nothing" and blindly retry.

    ok is False only when there is a genuine execution error:
      * an 'error' key is PRESENT with a value other than None — even "" (``str(e)`` is "" for
        TimeoutError()/KeyError()/some OSErrors; an empty message used to read as success), OR
      * explicit 'success' is falsy, OR
      * 'state' == 'error' (e.g. wait_for_window_idle failed to open the process).
    Result fields 'found' / 'has_image' / 'not_found' / 'matched' are left untouched and do NOT
    drive 'ok'. A failure always ends up with a non-empty 'error' string, and gets a 'hint' with the obvious
    next step when the message matches a known failure class and the tool did not supply its own hint.
    """
    if not isinstance(result, dict):
        return {"ok": True, "result": result}
    if "ok" in result:
        result["ok"] = bool(result["ok"])
    elif result.get("error") is not None:
        result["ok"] = False
    elif "success" in result:
        result["ok"] = bool(result["success"])
    elif result.get("state") == "error":
        result["ok"] = False
    else:
        # No error signal -> the call executed. Query fields like found/has_image/not_found
        # describe the *outcome*, not a failure, so ok stays True.
        result["ok"] = True
    if not result["ok"] and "error" in result:
        err = result["error"]
        if err is None or (isinstance(err, str) and not err.strip()):
            result["error"] = err = _EMPTY_ERROR_TEXT
        if isinstance(err, str) and "hint" not in result:
            h = hint_for(err, tool)
            if h:
                result["hint"] = h
    return result


def _fail_envelope(e: BaseException, tool: str | None = None) -> dict:
    """Envelope for an exception that escaped a tool: 'Type: message' + a hint when one applies."""
    text = exc_text(e)
    out = {"ok": False, "error": text}
    h = hint_for(text, tool)
    if h:
        out["hint"] = h
    return out


# Mutating / exfiltrating tools that are audited without carrying ``audit=True`` at their definition.
# Kept here so one file owns the policy and the tool modules stay untouched (many are edited concurrently):
# the Office writers (also in the workbench's snapshot table), network egress (fetch), browser actions that
# change page state, secret reads, and user-visible popups.
_AUDITED_BY_NAME = frozenset({
    "write_document", "write_excel", "write_pdf",
    "fetch",
    "browser_open", "browser_click", "browser_type", "browser_navigate", "browser_switch_tab", "browser_close",
    "get_environment_variable",
    "message_box", "show_notification", "notify_attention",
})


def tool(*d_args, audit: bool = False, **d_kwargs):
    """Drop-in replacement for ``mcp.tool`` adding response normalization + optional audit.

    Usage: ``@mcp.tool()`` or ``@mcp.tool(audit=True)``. Extra args/kwargs pass through to FastMCP.
    """

    def decorator(fn):
        tool_name = getattr(fn, "__name__", "tool")
        do_audit = audit or tool_name in _AUDITED_BY_NAME
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

        def _record(out, args, kwargs, t0):
            if do_audit:
                _audit_safe(tool_name, _bind(args, kwargs), out.get("ok", True),
                            None if out.get("ok", True) else out.get("error"),
                            int((time.monotonic() - t0) * 1000))

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def wrapper(*args, **kwargs):
                t0 = time.monotonic()
                try:
                    out = _normalize(await fn(*args, **kwargs), tool_name)
                except Exception as e:  # noqa: BLE001 — clean envelope, never a protocol error
                    out = _fail_envelope(e, tool_name)
                _record(out, args, kwargs, t0)
                return out
        else:
            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                t0 = time.monotonic()
                try:
                    out = _normalize(fn(*args, **kwargs), tool_name)
                except Exception as e:  # noqa: BLE001 — clean envelope, never a protocol error
                    out = _fail_envelope(e, tool_name)
                _record(out, args, kwargs, t0)
                return out

        registered = _raw_tool(*d_args, **d_kwargs)(wrapper)
        _slim_registered_schema(d_kwargs.get("name") or (d_args[0] if d_args and isinstance(d_args[0], str)
                                                         else tool_name))
        return registered

    return decorator


def _audit_safe(tool_name, args, ok, error=None, ms=None):
    """Call the audit logger without ever letting it raise into the tool path."""
    try:
        from ai_computer_control.tools.audit import log_action
        log_action(tool_name, args, ok, error, ms)
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
    hide_memory = _os.environ.get("ACC_HIDE_MEMORY", "").strip().lower() in {"1", "true", "yes", "on"}
    raw = _os.environ.get("ACC_TOOLSETS", "").strip()
    if not raw:
        mods = []
        for group in _TOOLSET_MODULES.values():
            mods.extend(group)
        return _ALWAYS_MODULES + [m for m in mods if not (hide_memory and m == "memory")]
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
    return [m for m in out if not (hide_memory and m == "memory")]


import importlib as _importlib  # noqa: E402

# Tool modules that failed to import: {module: "ExcType: message"}. One broken hard dependency (a pywin32 DLL,
# pyautogui without a display, psutil) must not take out unrelated tools (filesystem/office/fetch), so each
# module is imported on its own. The failure is never silent: one stderr line here and
# diagnostics().load_errors (which the workbench probe reads).
_LOAD_ERRORS: dict[str, str] = {}


def _load_tool_modules() -> None:
    for mod in _active_modules():
        try:
            _importlib.import_module(f"ai_computer_control.tools.{mod}")
        except Exception as e:  # noqa: BLE001 — degrade, don't die
            _LOAD_ERRORS[mod] = exc_text(e)
            print(f"[ai-computer-control] tool module '{mod}' failed to load and its tools are unavailable: "
                  f"{_LOAD_ERRORS[mod]}", file=sys.stderr)


_load_tool_modules()


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
