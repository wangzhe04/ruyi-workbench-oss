"""Environment / self-diagnostics: version, admin, monitors, DPI, optional-module availability."""

import ctypes
import importlib.util
import platform
import sys

from ai_computer_control import server as _server
from ai_computer_control.server import mcp, VERSION
from ai_computer_control.utils.errors import exc_text

# Diagnostics must OBSERVE, never load: importing a tool module registers its tools, which used to defeat
# ACC_TOOLSETS (15 -> 51 tools after one diagnostics() call). Availability of a third-party package is
# therefore probed with find_spec (no import, no side effects); tool modules are only inspected when the
# server already loaded them.
_TOOLS_PKG = "ai_computer_control.tools."


def _has_module(mod: str) -> bool:
    """True if ``mod`` is importable, decided without importing it."""
    loaded = sys.modules.get(mod)
    if loaded is not None:
        return True
    if mod in sys.modules:  # explicitly blocked (None entry)
        return False
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def _is_admin() -> bool | None:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return None


def _optional_modules() -> dict:
    """Report which optional backends are importable (drives graceful-degradation behavior)."""
    out = {}
    for key, mod in (("uiautomation", "uiautomation"), ("winsdk_ocr", "winsdk"),
                     ("cv2", "cv2"), ("numpy", "numpy"), ("playwright", "playwright"),
                     ("win10toast", "win10toast"), ("pynput", "pynput"),
                     ("pptx", "pptx"), ("matplotlib", "matplotlib")):
        out[key] = _has_module(mod)
    return out


def _optional() -> dict:
    """Compact optional-backend availability with the exact keys the workbench probe scans.

    The Win Claude Workbench `probeDesktopMcp` reads `diagnostics().optional` for the boolean keys
    {ocr, uia, cv2, playwright}. Keep this shape and these names in lockstep with that probe.
    Prefer each tool module's own `_AVAILABLE` flag (which reflects the true degrade decision) and
    fall back to a bare import check.
    """
    def flag(module_path: str, mod_name: str) -> bool:
        m = sys.modules.get(module_path)  # only if the server already loaded it (never import here)
        if m is not None and hasattr(m, "_AVAILABLE"):
            return bool(m._AVAILABLE)
        return _has_module(mod_name)

    return {
        "ocr": flag("ai_computer_control.tools.ocr", "winsdk"),
        "uia": flag("ai_computer_control.tools.uia", "uiautomation"),
        "cv2": flag("ai_computer_control.tools.vision", "cv2"),
        "playwright": flag("ai_computer_control.tools.browser", "playwright"),
        "pynput": flag("ai_computer_control.tools.record", "pynput"),
        # v1.6 Office 模板驱动 optional backends.
        "pptx": flag("ai_computer_control.tools.office_pptx", "pptx"),
        "matplotlib": flag("ai_computer_control.tools.office_chart", "matplotlib"),
    }


def _monitors_summary() -> dict:
    try:
        mod = sys.modules.get(_TOOLS_PKG + "desktop_extra")
        if mod is None:  # toolset not loaded (ACC_TOOLSETS) — don't load it just to report
            return {"count": None, "monitors": []}
        m = mod.list_monitors()
        if m.get("count") is not None:
            return {"count": m.get("count"), "monitors": m.get("monitors", [])}
    except Exception:
        pass
    return {"count": None, "monitors": []}


def _dpi_summary() -> dict:
    try:
        mod = sys.modules.get(_TOOLS_PKG + "desktop_extra")
        if mod is None:
            return {"awareness": None, "primary_scale": None}
        return mod.get_dpi_info()
    except Exception:
        return {"awareness": None, "primary_scale": None}


@mcp.tool()
def diagnostics() -> dict:
    """Report server version, Python, admin status, monitors, DPI, and optional-module availability.

    Returns:
        dict with ok, version, python, is_admin, monitors, dpi, optional (compact {ocr,uia,cv2,playwright,pynput}
        booleans that the workbench probe reads), optional_modules (full import-level map), tool_count, and
        load_errors ({module: error} for tool modules that failed to import — their tools are missing).
    """
    try:
        tool_count = len(mcp._tool_manager.list_tools())
    except Exception:
        tool_count = None
    return {
        "ok": True,
        "version": VERSION,
        "python": sys.version.split()[0],
        "python_full": sys.version,
        "platform": platform.platform(),
        "is_admin": _is_admin(),
        "monitors": _monitors_summary(),
        "dpi": _dpi_summary(),
        # Compact, probe-aligned availability (top-level, boolean) — read by workbench probeDesktopMcp.
        "optional": _optional(),
        # Fuller import-level map kept for humans / debugging.
        "optional_modules": _optional_modules(),
        "tool_count": tool_count,
        # Tool modules that failed to import (their tools are NOT registered). Empty dict = all loaded.
        "load_errors": dict(_server._LOAD_ERRORS),
        # Tools the host removed via ACC_HIDE_TOOLS (sorted). Empty list = nothing hidden.
        "hidden_tools": list(getattr(_server, "HIDDEN_TOOLS", [])),
    }


@mcp.tool()
def safety_info() -> dict:
    """Report the effective safety guardrails (built-in floor + any data-dir safety.json overrides).

    Returns:
        dict with ok, builtin (critical processes / protected trees / command patterns),
        custom (protected_paths / denied_commands / denied_kill_names / allowed_kill_names),
        and custom_source (whether safety.json loaded, its path, and any parse error).
    """
    try:
        from ai_computer_control.tools.safety import safety_config_summary
        summary = safety_config_summary()
        summary["ok"] = True
        return summary
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": exc_text(e)}


@mcp.tool()
def version_info() -> dict:
    """Return the server version and tool count (compact companion to `diagnostics`)."""
    try:
        tool_count = len(mcp._tool_manager.list_tools())
    except Exception:
        tool_count = None
    return {"ok": True, "version": VERSION, "tool_count": tool_count,
            "python": sys.version.split()[0]}
