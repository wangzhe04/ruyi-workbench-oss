"""UI Automation accessibility-tree tools — reliable native-app control by semantics, not pixels.

Requires the pure-Python `uiautomation` package (pulls in `comtypes`). If it is not present, the
tools load but return a clear install hint instead of crashing server startup. "Semantic-first,
pixel-fallback": every located control also returns its center point so callers can click it.
"""

from ai_computer_control.server import mcp

try:
    import uiautomation as auto  # type: ignore
    _AVAILABLE = True
    _IMPORT_ERROR = ""
    try:
        auto.SetGlobalSearchTimeout(2)
    except Exception:
        pass
except Exception as e:  # noqa: BLE001 — optional dependency
    auto = None
    _AVAILABLE = False
    _IMPORT_ERROR = str(e)


def _unavailable() -> dict:
    return {"error": "uiautomation not installed", "hint": "Add 'uiautomation' (+comtypes) to the offline "
            "package (requirements_offline.txt) and reinstall, or run update.bat --deps.",
            "detail": _IMPORT_ERROR}


def _center(control) -> list[int] | None:
    try:
        r = control.BoundingRectangle
        if r is None:
            return None
        return [int((r.left + r.right) / 2), int((r.top + r.bottom) / 2)]
    except Exception:
        return None


def _node(control, include_center: bool = True) -> dict:
    d = {}
    for attr, key in (("Name", "name"), ("ControlTypeName", "type"), ("AutomationId", "automation_id"),
                      ("ClassName", "class")):
        try:
            v = getattr(control, attr, "")
            if v:
                d[key] = v
        except Exception:
            pass
    if include_center:
        c = _center(control)
        if c:
            d["center"] = c
    return d


def _root(window_title: str | None):
    if not window_title:
        try:
            return auto.GetForegroundControl()
        except Exception:
            return auto.GetRootControl()
    # match a top-level window by (sub)string
    try:
        win = auto.WindowControl(searchDepth=1, SubName=window_title)
        if win.Exists(1, 0):
            return win
    except Exception:
        pass
    try:
        win = auto.WindowControl(searchDepth=1, Name=window_title)
        if win.Exists(1, 0):
            return win
    except Exception:
        pass
    return None


@mcp.tool()
def ui_inspect(window_title: str | None = None, max_depth: int = 4, max_nodes: int = 200) -> dict:
    """Dump the UI Automation tree of a window (or the foreground window) as nested nodes.

    Args:
        window_title: Substring of the target window title; omit for the foreground window.
        max_depth: Tree depth limit.
        max_nodes: Hard cap on nodes returned (prevents huge dumps).

    Returns:
        dict with 'tree' (nested {name,type,automation_id,center,children}) or an error.
    """
    if not _AVAILABLE:
        return _unavailable()
    root = _root(window_title)
    if root is None:
        return {"error": f"window not found: {window_title!r}"}
    count = [0]

    def walk(ctrl, depth):
        if count[0] >= max_nodes or depth > max_depth:
            return None
        count[0] += 1
        node = _node(ctrl)
        children = []
        if depth < max_depth:
            try:
                for ch in ctrl.GetChildren():
                    if count[0] >= max_nodes:
                        break
                    cn = walk(ch, depth + 1)
                    if cn:
                        children.append(cn)
            except Exception:
                pass
        if children:
            node["children"] = children
        return node

    try:
        tree = walk(root, 0)
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}
    return {"success": True, "nodes": count[0], "truncated": count[0] >= max_nodes, "tree": tree}


@mcp.tool()
def ui_find(name: str | None = None, control_type: str | None = None, automation_id: str | None = None,
            window_title: str | None = None, max_results: int = 20, max_depth: int = 8) -> dict:
    """Find controls by name / control type / automation id within a window.

    Returns dict with 'matches': [{name,type,automation_id,center}], each clickable via its center.
    """
    if not _AVAILABLE:
        return _unavailable()
    root = _root(window_title)
    if root is None:
        return {"error": f"window not found: {window_title!r}"}
    name_l = name.lower() if name else None
    type_l = control_type.lower() if control_type else None
    matches, count = [], [0]

    def walk(ctrl, depth):
        if len(matches) >= max_results or depth > max_depth or count[0] > 5000:
            return
        count[0] += 1
        try:
            nm = (getattr(ctrl, "Name", "") or "")
            tp = (getattr(ctrl, "ControlTypeName", "") or "")
            aid = (getattr(ctrl, "AutomationId", "") or "")
            ok = True
            if name_l is not None:
                ok = ok and name_l in nm.lower()
            if type_l is not None:
                ok = ok and type_l in tp.lower()
            if automation_id is not None:
                ok = ok and automation_id == aid
            if ok and (name_l is not None or type_l is not None or automation_id is not None):
                matches.append(_node(ctrl))
        except Exception:
            pass
        try:
            for ch in ctrl.GetChildren():
                if len(matches) >= max_results:
                    break
                walk(ch, depth + 1)
        except Exception:
            pass

    try:
        walk(root, 0)
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}
    return {"success": True, "count": len(matches), "matches": matches}


@mcp.tool(audit=True)
def ui_invoke(action: str = "invoke", name: str | None = None, control_type: str | None = None,
              automation_id: str | None = None, window_title: str | None = None, text: str = "") -> dict:
    """Act on the first control matching the given selectors.

    Args:
        action: invoke | click | set_value | focus | toggle | expand.
        name/control_type/automation_id/window_title: selectors (see ui_find).
        text: value for action="set_value".

    Returns dict with 'success' and the acted-on control, or an error (with its center for a pixel fallback).
    """
    if not _AVAILABLE:
        return _unavailable()
    found = ui_find(name=name, control_type=control_type, automation_id=automation_id,
                    window_title=window_title, max_results=1)
    if found.get("error"):
        return found
    if not found.get("matches"):
        return {"error": "no control matched the selectors"}
    root = _root(window_title)

    # Re-resolve the concrete control to act on (ui_find returns plain dicts).
    def first(ctrl, depth=0):
        if depth > 12:
            return None
        try:
            nm = (getattr(ctrl, "Name", "") or "").lower()
            tp = (getattr(ctrl, "ControlTypeName", "") or "").lower()
            aid = (getattr(ctrl, "AutomationId", "") or "")
            ok = True
            if name:
                ok = ok and name.lower() in nm
            if control_type:
                ok = ok and control_type.lower() in tp
            if automation_id:
                ok = ok and automation_id == aid
            if ok and (name or control_type or automation_id):
                return ctrl
            for ch in ctrl.GetChildren():
                r = first(ch, depth + 1)
                if r:
                    return r
        except Exception:
            return None
        return None

    ctrl = first(root)
    if ctrl is None:
        return {"error": "control disappeared before action", "target": found["matches"][0]}
    info = _node(ctrl)
    try:
        act = action.lower()
        if act in ("invoke", "click"):
            try:
                ctrl.GetInvokePattern().Invoke()
            except Exception:
                ctrl.Click()
        elif act == "set_value":
            try:
                ctrl.GetValuePattern().SetValue(text)
            except Exception:
                ctrl.SendKeys("{Ctrl}a" + text)
        elif act == "focus":
            ctrl.SetFocus()
        elif act == "toggle":
            ctrl.GetTogglePattern().Toggle()
        elif act == "expand":
            ctrl.GetExpandCollapsePattern().Expand()
        else:
            return {"error": f"unknown action: {action}", "target": info}
        return {"success": True, "action": act, "control": info}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}", "control": info,
                "hint": "fall back to clicking 'center' with mouse_click"}
