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

VERSION = "1.8.1"

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

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                result = fn(*args, **kwargs)
            except Exception as e:  # noqa: BLE001 — convert to a clean envelope, never a protocol error
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
from ai_computer_control.tools import screen      # noqa: E402, F401
from ai_computer_control.tools import mouse       # noqa: E402, F401
from ai_computer_control.tools import keyboard    # noqa: E402, F401
from ai_computer_control.tools import clipboard   # noqa: E402, F401
from ai_computer_control.tools import window      # noqa: E402, F401
from ai_computer_control.tools import application # noqa: E402, F401
from ai_computer_control.tools import filesystem  # noqa: E402, F401
from ai_computer_control.tools import shell       # noqa: E402, F401
from ai_computer_control.tools import system      # noqa: E402, F401
from ai_computer_control.tools import browser     # noqa: E402, F401
from ai_computer_control.tools import document    # noqa: E402, F401
from ai_computer_control.tools import dialog      # noqa: E402, F401
# v1.1 additions
from ai_computer_control.tools import batch          # noqa: E402, F401
from ai_computer_control.tools import audio          # noqa: E402, F401
from ai_computer_control.tools import desktop_extra  # noqa: E402, F401
from ai_computer_control.tools import uia            # noqa: E402, F401 (optional: graceful if lib absent)
# v1.2 additions (optional: graceful if lib absent)
from ai_computer_control.tools import ocr            # noqa: E402, F401
from ai_computer_control.tools import vision         # noqa: E402, F401
# v1.3 additions
from ai_computer_control.tools import audit          # noqa: E402, F401
from ai_computer_control.tools import diagnostics    # noqa: E402, F401
from ai_computer_control.tools import capture        # noqa: E402, F401
from ai_computer_control.tools import sync           # noqa: E402, F401
# v1.4 additions
from ai_computer_control.tools import observe        # noqa: E402, F401
from ai_computer_control.tools import act_and_verify # noqa: E402, F401
from ai_computer_control.tools import record         # noqa: E402, F401 (optional: pynput graceful)
# v1.6 additions — Office 模板驱动 (design-token beautify/generate). excel tools use core openpyxl;
# pptx/matplotlib are optional (guarded import in-module) and degrade gracefully if absent.
from ai_computer_control.tools import office_excel    # noqa: E402, F401
from ai_computer_control.tools import office_pptx      # noqa: E402, F401 (optional: python-pptx graceful)
from ai_computer_control.tools import office_chart     # noqa: E402, F401 (optional: matplotlib graceful)
# v1.8 additions — 补齐「AI 盲操作」痛点: 结构化读表 / 分页读 PDF / 图片信息+缩放.
# office_read (excel_read/pdf_read_pages): openpyxl/pdfplumber 核心依赖，缺失时工具内人话降级 (import 守护)。
# image_tools (image_info/image_resize): Pillow 核心依赖；image_resize 是写族 (output_path 契约 + protected 护栏).
from ai_computer_control.tools import office_read      # noqa: E402, F401
from ai_computer_control.tools import image_tools      # noqa: E402, F401


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
