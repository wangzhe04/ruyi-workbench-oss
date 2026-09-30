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

import threading

_MAX_NODES = 5000          # tree-walk node cap shared by ui_find / ui_invoke
_DEFAULT_DEPTH = 8         # default tree depth for ui_find / ui_invoke (kept identical on purpose)
_CANDIDATE_CAP = 10        # ui_invoke: how many matches it collects to report ambiguity
_ACTION_TIMEOUT_S = 10     # bound for a single pattern action (Invoke/SetValue/Toggle/...)

# A single ctrl.GetChildren() (or Invoke/SetValue/SendKeys) on an unresponsive window is a
# synchronous COM call with no per-call timeout. SetGlobalSearchTimeout only bounds search ops, not
# tree walks or pattern actions. Run such calls in a daemon thread with a join deadline so a hung
# window degrades to a clean error at `timeout` instead of hanging until the 120s bridge kill.
# NOTE: the COM WORK runs off the calling thread, but the tool functions here are sync, so the
# calling (event-loop) thread still waits up to `timeout` in join() — the bound limits the damage of
# a hung window (<=15s/10s per call), it does not keep the loop free meanwhile.
_TIMEOUT_SENTINEL = object()


def _run_bounded(fn, timeout, *args, **kwargs):
    """Run fn in a daemon thread, join with `timeout` seconds.

    Returns the fn result, raises any exception fn raised, or returns _TIMEOUT_SENTINEL on timeout.
    COM safety: uiautomation/comtypes need CoInitialize on each worker thread; we do it here so
    tree walks and pattern actions can run on a worker thread (pywin32 is a hard dependency).
    """
    holder = {}

    def _run():
        co_inited = False
        try:
            try:
                import pythoncom
                pythoncom.CoInitialize()
                co_inited = True
            except Exception:
                pass
            holder["r"] = fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            holder["e"] = e
        finally:
            if co_inited:
                try:
                    import pythoncom
                    pythoncom.CoUninitialize()
                except Exception:
                    pass
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        return _TIMEOUT_SENTINEL
    if "e" in holder:
        raise holder["e"]
    return holder.get("r")



def _center(control) -> list[int] | None:
    try:
        r = control.BoundingRectangle
        if r is None:
            return None
        return [int((r.left + r.right) / 2), int((r.top + r.bottom) / 2)]
    except Exception:
        return None


def _actionable_state(control) -> tuple[bool, bool, bool]:
    """(enabled, offscreen, empty_rect) for a control; each read is guarded (unknown -> not excluded)."""
    enabled, offscreen, empty = True, False, False
    try:
        enabled = bool(getattr(control, "IsEnabled", True))
    except Exception:
        pass
    try:
        offscreen = bool(getattr(control, "IsOffscreen", False))
    except Exception:
        pass
    try:
        r = control.BoundingRectangle
        empty = r is not None and (r.right <= r.left or r.bottom <= r.top)
    except Exception:
        pass
    return enabled, offscreen, empty


def _node(control, include_center: bool = True, include_state: bool = False) -> dict:
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
    if include_state:
        # Only the notable states, to keep the payload small: a disabled or offscreen control is
        # a poor click target and the model should see that before choosing among matches.
        enabled, offscreen, empty = _actionable_state(control)
        if not enabled:
            d["enabled"] = False
        if offscreen or empty:
            d["offscreen"] = True
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
        tree = _run_bounded(lambda: walk(root, 0), 15)
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}
    if tree is _TIMEOUT_SENTINEL:
        return {"error": "UIA tree walk timed out (>15s); the window may be unresponsive",
                "window": _window_identity(root)}
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


def _find_controls(root, name=None, control_type=None, automation_id=None, max_results=20,
                   max_depth=_DEFAULT_DEPTH, max_nodes=_MAX_NODES, visible_only=False,
                   enabled_only=False) -> dict:
    """ONE depth-first walk shared by ui_find and ui_invoke (so invoke never walks twice).

    Returns {controls: [live control objects], control_types, nodes_scanned, more, node_cap, depth_cut,
    skipped_offscreen, skipped_disabled}. `more` = at least one further match exists beyond max_results;
    `node_cap`/`depth_cut` = the walk was cut short by the node/depth limit (results may be incomplete).
    Must run inside _run_bounded by the caller (COM calls on an unresponsive window can hang).
    """
    name_l = name.lower() if name else None
    type_l = control_type.lower() if control_type else None
    have_selector = name_l is not None or type_l is not None or automation_id is not None
    controls: list = []
    control_types: set[str] = set()
    st = {"nodes": 0, "more": False, "node_cap": False, "depth_cut": False,
          "offscreen": 0, "disabled": 0}

    def stop() -> bool:
        return st["more"] or st["node_cap"]

    def walk(ctrl, depth):
        if stop():
            return
        if st["nodes"] >= max_nodes:
            st["node_cap"] = True
            return
        st["nodes"] += 1
        try:
            tp = (getattr(ctrl, "ControlTypeName", "") or "")
            if tp:
                control_types.add(tp)
            ok = have_selector
            if ok and type_l is not None:
                ok = type_l in tp.lower()
            if ok and name_l is not None:
                ok = name_l in (getattr(ctrl, "Name", "") or "").lower()
            if ok and automation_id is not None:
                ok = automation_id == (getattr(ctrl, "AutomationId", "") or "")
            if ok:
                enabled, offscreen, empty = _actionable_state(ctrl)
                if visible_only and (offscreen or empty):
                    st["offscreen"] += 1
                elif enabled_only and not enabled:
                    st["disabled"] += 1
                elif len(controls) >= max_results:
                    st["more"] = True
                    return
                else:
                    controls.append(ctrl)
        except Exception:
            pass
        try:
            kids = ctrl.GetChildren()
        except Exception:
            return
        if depth >= max_depth:
            if kids:
                st["depth_cut"] = True
            return
        for ch in kids:
            if stop():
                break
            walk(ch, depth + 1)

    walk(root, 0)
    return {"controls": controls, "control_types": control_types, "nodes_scanned": st["nodes"],
            "more": st["more"], "node_cap": st["node_cap"], "depth_cut": st["depth_cut"],
            "skipped_offscreen": st["offscreen"], "skipped_disabled": st["disabled"]}


def _walk_report(found: dict) -> dict:
    """Truncation / scan stats to merge into a ui_find / ui_invoke answer."""
    by = [k for k, on in (("node_cap", found["node_cap"]), ("max_depth", found["depth_cut"]),
                          ("max_results", found["more"])) if on]
    out = {"nodes_scanned": found["nodes_scanned"], "truncated": bool(by)}
    if by:
        out["truncated_by"] = by
    skipped = {}
    if found["skipped_offscreen"]:
        skipped["offscreen"] = found["skipped_offscreen"]
    if found["skipped_disabled"]:
        skipped["disabled"] = found["skipped_disabled"]
    if skipped:
        out["skipped"] = skipped
    return out


def _locate(root, **kw):
    """Run _find_controls bounded. Returns (found, error_dict); exactly one is None."""
    try:
        found = _run_bounded(lambda: _find_controls(root, **kw), 15)
    except Exception as e:  # noqa: BLE001
        return None, {"error": f"{type(e).__name__}: {e}"}
    if found is _TIMEOUT_SENTINEL:
        return None, {"error": "UIA tree walk timed out (>15s); the window may be unresponsive",
                      "window": _window_identity(root)}
    return found, None


@mcp.tool()
def ui_find(name: str | None = None, control_type: str | None = None, automation_id: str | None = None,
            window_title: str | None = None, max_results: int = 20, max_depth: int = _DEFAULT_DEPTH,
            visible_only: bool = False, enabled_only: bool = False) -> dict:
    """Find controls by name / control type / automation id within a window.

    Args:
        name: Substring of the control name (case-insensitive).
        control_type: Substring of the control type, e.g. "Button", "Edit".
        automation_id: Exact automation id.
        window_title: Substring of the window title; omit for the foreground window.
        max_results: Stop after this many matches.
        max_depth: Tree depth limit (default 8).
        visible_only: Skip offscreen / zero-size controls.
        enabled_only: Skip disabled controls.

    Returns:
        dict with 'matches': [{name,type,automation_id,center}] (click via center; disabled -> enabled:false,
        offscreen -> offscreen:true), 'nodes_scanned', and 'truncated' (+ 'truncated_by') when a limit cut the
        search short.
    """
    if not _AVAILABLE:
        return _unavailable()
    root = _root(window_title)
    if root is None:
        return {"error": "window not found", "searched": window_title,
                "hint": "use wait_for_window(title) if the app was just launched"}
    found, err = _locate(root, name=name, control_type=control_type,
                         automation_id=automation_id, max_results=max_results, max_depth=max_depth,
                         visible_only=visible_only, enabled_only=enabled_only)
    if err:
        return err
    matches = [_node(c, include_state=True) for c in found["controls"]]
    out = {"success": True, "count": len(matches), "matches": matches,
           "window": _window_identity(root), **_walk_report(found)}
    if not matches:
        limitation = _browser_accessibility_status(root, found["nodes_scanned"], found["control_types"])
        if limitation:
            out.update(limitation)
        elif out["truncated"]:
            out["hint"] = ("no match, but the search was cut short (see truncated_by); narrow it with "
                           "window_title / automation_id, or raise max_depth.")
    return out


def _timeout_note(what: str, seconds: int = _ACTION_TIMEOUT_S) -> str:
    return (f"{what} did not return within {seconds}s. The action may ALREADY have been delivered "
            f"(e.g. a modal dialog opened and is holding the call) — check the current state "
            f"(screenshot / ui_find) BEFORE retrying, or you may act twice.")


def _read_back_value(ctrl):
    """(value, source) read through ValuePattern -> LegacyIAccessible -> TextPattern; (None, None) if unreadable."""
    for source, getter in (
        ("value_pattern", lambda: ctrl.GetValuePattern().Value),
        ("legacy_accessible", lambda: ctrl.GetLegacyIAccessiblePattern().Value),
        ("text_pattern", lambda: ctrl.GetTextPattern().DocumentRange.GetText(-1)),
    ):
        try:
            v = getter()
        except Exception:
            continue
        if isinstance(v, str):
            return v, source
    return None, None


def _norm_text(v: str) -> str:
    return v.replace("\r\n", "\n").replace("\r", "\n")


def _confirm_set_value(ctrl, text: str) -> dict:
    """Did set_value take? Compares ONLY against a real readable value (never the control's Name).

    Returns {"confirmed": True|False|None, "read_back_via": ..., "actual": ...}. None = the control
    exposes no readable value (or is a password field), i.e. UNVERIFIABLE — not a failure.
    """
    try:
        if bool(getattr(ctrl, "IsPassword", False)):
            return {"confirmed": None, "note": "password field: value not read back"}
    except Exception:
        pass
    value, source = _read_back_value(ctrl)
    if value is None:
        return {"confirmed": None,
                "note": "value set; the control does not expose a readable value, so it could not be confirmed"}
    a, b = _norm_text(value), _norm_text(text)
    if source == "text_pattern":  # document ranges often carry a trailing newline
        a, b = a.rstrip("\n"), b.rstrip("\n")
    if a == b:
        return {"confirmed": True, "read_back_via": source}
    return {"confirmed": False, "read_back_via": source, "actual": value}


def _write_value(ctrl, text: str) -> str:
    """Set a control's value; returns the method used. Runs bounded (see _perform)."""
    try:
        ctrl.GetValuePattern().SetValue(text)
        return "value_pattern"
    except Exception:
        pass
    # No ValuePattern: prefer a non-keystroke setter (no SendKeys syntax parsing, so
    # braces/parens in JSON/code/paths are not corrupted).
    try:
        ctrl.GetLegacyIAccessiblePattern().SetValue(text)
        return "legacy_accessible"
    except Exception:
        pass
    # SendKeys fallback: escape braces in the VALUE only, NOT the select-all literal.
    safe = text.replace("{", "{{}").replace("}", "{}}")
    ctrl.SendKeys("{Ctrl}a" + safe)
    return "sendkeys"


def _bounded_action(fn, what: str):
    """Run one pattern action with the action timeout. Returns (result, timeout_error_dict|None)."""
    r = _run_bounded(fn, _ACTION_TIMEOUT_S)
    if r is _TIMEOUT_SENTINEL:
        return None, {"error": _timeout_note(what)}
    return r, None


def _perform(act: str, ctrl, text: str, info: dict) -> dict:
    """Carry out `act` on the resolved control. Every COM action is bounded (a hung window must not
    freeze the server); exceptions propagate to the caller's handler."""
    if act in ("invoke", "click"):
        try:
            inv, tmo = _bounded_action(lambda: ctrl.GetInvokePattern().Invoke(), "Invoke()")
            if tmo:
                # Deliberately NOT falling back to a click here: the invoke may have gone through.
                return {**tmo, "control": info}
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
            _, tmo = _bounded_action(lambda: ctrl.Click(), "Click()")
            if tmo:
                return {**tmo, "control": info}
            return {"success": True, "action": act, "control": info,
                    "method": "mouse_click_fallback", "verified": False}
    if act == "set_value":
        method, tmo = _bounded_action(lambda: _write_value(ctrl, text), "set_value")
        if tmo:
            return {**tmo, "control": info}
        conf = _confirm_set_value(ctrl, text)
        if conf["confirmed"] is False:
            return {"success": False, "error": "set_value not confirmed", "expected": text,
                    "actual": conf.get("actual"), "read_back_via": conf.get("read_back_via"),
                    "method": method, "control": info}
        out = {"success": True, "action": act, "control": info, "method": method,
               "confirmed": conf["confirmed"], "verified": conf["confirmed"] is True}
        if conf.get("note"):
            out["note"] = conf["note"]
        if conf.get("read_back_via"):
            out["read_back_via"] = conf["read_back_via"]
        return out
    if act == "focus":
        _, tmo = _bounded_action(lambda: ctrl.SetFocus(), "SetFocus()")
        if tmo:
            return {**tmo, "control": info}
    elif act == "toggle":
        def _toggle():
            p = ctrl.GetTogglePattern()
            if p is None:
                return False
            p.Toggle()
            return True
        done, tmo = _bounded_action(_toggle, "Toggle()")
        if tmo:
            return {**tmo, "control": info}
        if not done:
            return {"error": "control does not support toggle", "control": info,
                    "hint": "fall back to clicking 'center' with mouse_click"}
    elif act == "expand":
        def _expand():
            p = ctrl.GetExpandCollapsePattern()
            if p is None:
                return False
            p.Expand()
            return True
        done, tmo = _bounded_action(_expand, "Expand()")
        if tmo:
            return {**tmo, "control": info}
        if not done:
            return {"error": "control does not support expand", "control": info,
                    "hint": "fall back to clicking 'center' with mouse_click"}
    else:
        return {"error": f"unknown action: {act}", "target": info}
    return {"success": True, "action": act, "control": info}


@mcp.tool(audit=True)
def ui_invoke(action: str = "invoke", name: str | None = None, control_type: str | None = None,
              automation_id: str | None = None, window_title: str | None = None, text: str = "",
              nth: int = 0) -> dict:
    """Act on a control matching the given selectors (the first ACTIONABLE match unless `nth` is given).

    Enabled, on-screen matches are preferred. With several matches the answer lists them ('candidates',
    'matched_count') so you can re-call with `nth` or tighter selectors.

    Args:
        action: invoke | click | set_value | focus | toggle | expand.
        name/control_type/automation_id/window_title: selectors (see ui_find).
        text: value for action="set_value".
        nth: 0-based index into the ordered matches (actionable first).

    Returns dict with 'success' and the acted-on control, or an error (with its center for a pixel fallback).
    set_value adds 'confirmed' (true / false / null = no readable value, unverifiable). If a timeout error says
    the action may already have been delivered, check state before retrying.
    """
    if not _AVAILABLE:
        return _unavailable()
    # b2-P2: selector 全空会静默匹配一切 —— 显式要求至少一个定位条件
    if not any([name, control_type, automation_id, window_title]):
        return {"error": "至少提供 name / control_type / automation_id / window_title 之一作为定位条件"}
    root = _root(window_title)   # the ONLY root resolution for this call
    if root is None:
        return {"error": "window not found", "searched": window_title,
                "hint": "use wait_for_window(title) if the app was just launched"}
    found, err = _locate(root, name=name, control_type=control_type,
                         automation_id=automation_id, max_results=_CANDIDATE_CAP)  # the ONLY tree walk
    if err:
        return err
    report = _walk_report(found)
    if not found["controls"]:
        out = {"error": "no control matched the selectors", **report}
        limitation = _browser_accessibility_status(root, found["nodes_scanned"], found["control_types"])
        if limitation:
            for key in ("accessibilityLimited", "reason", "observedNodes", "fallback", "hint"):
                if key in limitation:
                    out[key] = limitation[key]
        return out

    # Rank: enabled + on-screen first (stable within each group), then the rest.
    ranked = []
    for c in found["controls"]:
        enabled, offscreen, empty = _actionable_state(c)
        ranked.append((c, enabled and not offscreen and not empty))
    ranked.sort(key=lambda t: not t[1])
    total = len(ranked)
    try:
        idx = int(nth)
    except (TypeError, ValueError):
        idx = 0
    if not (0 <= idx < total):
        return {"error": f"nth={nth} out of range (0..{total - 1})", "matched_count": total, **report}
    ctrl, actionable = ranked[idx]
    info = _node(ctrl)
    extra = {}
    if total > 1 or found["more"]:
        extra["matched_count"] = total
        if found["more"]:
            extra["matched_more"] = True   # capped at _CANDIDATE_CAP: at least this many
        extra["candidates"] = [dict(_node(c, include_state=True), nth=i)
                               for i, (c, _a) in enumerate(ranked[:5])]
        extra["note"] = (f"{total}{'+' if found['more'] else ''} controls matched; acted on nth={idx}. "
                         f"Pass `nth` or tighter selectors (automation_id / control_type) to choose another.")
    if not actionable:
        extra["warning"] = "the chosen control is disabled or offscreen; the action may have no effect"
    if report["truncated"]:
        extra["truncated"] = True
        extra["truncated_by"] = report["truncated_by"]
    try:
        out = _perform(action.lower(), ctrl, text, info)
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}", "control": info, **extra,
                "hint": "fall back to clicking 'center' with mouse_click"}
    for k, v in extra.items():
        out.setdefault(k, v)
    return out
