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
    # match a top-level window by (sub)string. SubName covers exact matches too,
    # so the separate Name probe is redundant — drop it to halve worst-case latency.
    # Use a real (non-zero) interval so a miss SLEEPS instead of spinning the CPU.
    try:
        win = auto.WindowControl(searchDepth=1, SubName=window_title)
        if win.Exists(1, 0.2):
            return win
    except Exception:
        pass
    return None


def _window_identity(root) -> dict:
    """Identity block for a resolved root; each property read is guarded (stale controls raise)."""
    ident = {}
    try:
        ident["name"] = getattr(root, "Name", "") or ""
    except Exception:
        pass
    try:
        ident["class"] = getattr(root, "ClassName", "") or ""
    except Exception:
        pass
    try:
        ident["handle"] = getattr(root, "NativeWindowHandle", 0) or 0
    except Exception:
        pass
    return ident


def _browser_accessibility_status(root, node_count: int, control_types: set[str]) -> dict | None:
    """Detect a browser whose accelerated page surface is absent from the UIA tree.

    Chromium/Edge/WebView and Firefox can expose only their native window chrome when renderer
    accessibility is unavailable.  Retrying UIA cannot reveal that Direct3D surface; callers need
    a deterministic signal to switch to DOM/CDP, OCR, or screenshot grounding.
    """
    ident = _window_identity(root)
    name = str(ident.get("name", "")).lower()
    class_name = str(ident.get("class", "")).lower()
    browser_window = (
        class_name.startswith("chrome_widgetwin_")
        or class_name == "mozillawindowclass"
        or any(token in name for token in ("chrome", "edge", "firefox", "browser"))
    )
    if not browser_window:
        return None
    normalized_types = {str(value).lower().replace("control", "") for value in control_types}
    has_document = any(value in {"document", "webarea"} for value in normalized_types)
    if has_document:
        return None
    return {
        "accessibilityLimited": True,
        "reason": (
            "The browser page surface is not exposed through UI Automation; this commonly occurs "
            "with Direct3D/hardware-accelerated rendering."
        ),
        "observedNodes": int(node_count),
        "fallback": ["browser DOM/CDP", "OCR text coordinates", "screenshot/vision coordinates"],
        "hint": (
            "Do not keep retrying UIA. Use browser_* DOM tools in CDP/managed mode when attached; "
            "otherwise use ocr_find_text/ocr_screen or screenshot-based coordinates."
        ),
    }


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
        return {"error": "window not found", "searched": window_title,
                "hint": "use wait_for_window(title) if the app was just launched"}
    count = [0]
    control_types: set[str] = set()

    def walk(ctrl, depth):
        if count[0] >= max_nodes or depth > max_depth:
            return None
        count[0] += 1
        node = _node(ctrl)
        if node.get("type"):
            control_types.add(str(node["type"]))
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
    out = {"success": True, "nodes": count[0], "truncated": count[0] >= max_nodes, "tree": tree,
           "window": _window_identity(root)}
    # A deliberately shallow/truncated request has not inspected enough of the tree to diagnose
    # renderer accessibility; avoid a false Direct3D warning in that case.
    limitation = None
    if max_depth >= 3 and count[0] < max_nodes:
        limitation = _browser_accessibility_status(root, count[0], control_types)
    if limitation:
        out.update(limitation)
    return out


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
        return {"error": "window not found", "searched": window_title,
                "hint": "use wait_for_window(title) if the app was just launched"}
    name_l = name.lower() if name else None
    type_l = control_type.lower() if control_type else None
    matches, count = [], [0]
    control_types: set[str] = set()

    def walk(ctrl, depth):
        if len(matches) >= max_results or depth > max_depth or count[0] > 5000:
            return
        count[0] += 1
        try:
            nm = (getattr(ctrl, "Name", "") or "")
            tp = (getattr(ctrl, "ControlTypeName", "") or "")
            if tp:
                control_types.add(tp)
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
    out = {"success": True, "count": len(matches), "matches": matches,
           "window": _window_identity(root)}
    if not matches:
        limitation = _browser_accessibility_status(root, count[0], control_types)
        if limitation:
            out.update(limitation)
    return out


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
        out = {"error": "no control matched the selectors"}
        for key in ("accessibilityLimited", "reason", "observedNodes", "fallback", "hint"):
            if key in found:
                out[key] = found[key]
        return out
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
                # 'verified' means the event was SENT, not that the effect is confirmed.
                return {"success": True, "action": act, "control": info,
                        "method": "invoke_pattern", "verified": False}
            except Exception:
                # Mouse-Click fallback pixel-clicks the control center; a zero/offscreen
                # rect makes the click a silent no-op, so re-check before clicking.
                r = None
                try:
                    r = ctrl.BoundingRectangle
                except Exception:
                    r = None
                empty = (r is None or (r.left == r.right and r.top == r.bottom)
                         or r.right <= r.left or r.bottom <= r.top
                         or r.right < 0 or r.bottom < 0)
                if empty:
                    return {"error": "control has empty/offscreen BoundingRectangle; not clicked",
                            "control": info}
                ctrl.Click()
                return {"success": True, "action": act, "control": info,
                        "method": "mouse_click_fallback", "verified": False}
        elif act == "set_value":
            confirmed = None
            try:
                ctrl.GetValuePattern().SetValue(text)
            except Exception:
                # No ValuePattern: prefer a non-keystroke setter (no SendKeys syntax parsing,
                # so braces/parens in JSON/code/paths are not corrupted).
                did_legacy = False
                try:
                    ctrl.GetLegacyIAccessiblePattern().SetValue(text)
                    did_legacy = True
                except Exception:
                    did_legacy = False
                if not did_legacy:
                    # SendKeys fallback: escape braces in the VALUE only, NOT the select-all
                    # literal. Paren-escaping is unnecessary for uiautomation SendKeys.
                    safe = text.replace("{", "{{}").replace("}", "{}}")
                    ctrl.SendKeys("{Ctrl}a" + safe)
            # Read back to make sure the value actually took (don't report a lie).
            try:
                confirmed = ctrl.GetValuePattern().Value
            except Exception:
                try:
                    confirmed = getattr(ctrl, "Name", None)
                except Exception:
                    confirmed = None
            if confirmed is not None and confirmed != text:
                return {"success": False, "error": "set_value not confirmed",
                        "expected": text, "actual": confirmed, "control": info}
            return {"success": True, "action": act, "control": info}
        elif act == "focus":
            ctrl.SetFocus()
        elif act == "toggle":
            p = ctrl.GetTogglePattern()
            if p is None:
                return {"error": "control does not support toggle", "control": info,
                        "hint": "fall back to clicking 'center' with mouse_click"}
            p.Toggle()
        elif act == "expand":
            p = ctrl.GetExpandCollapsePattern()
            if p is None:
                return {"error": "control does not support expand", "control": info,
                        "hint": "fall back to clicking 'center' with mouse_click"}
            p.Expand()
        else:
            return {"error": f"unknown action: {action}", "target": info}
        return {"success": True, "action": act, "control": info}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}", "control": info,
                "hint": "fall back to clicking 'center' with mouse_click"}
