"""Mac AX observations and actions bound to a current window and private element reference."""
from ai_computer_control.server import mcp
from ai_computer_control.utils.macos_session import request


@mcp.tool()
def ui_inspect(target: dict, max_depth: int = 4, max_nodes: int = 200, scope: str = "window") -> dict:
    """Inspect a bound Mac AX tree with roles, identifiers, states, logical-point bounds and element_ref.

    Pass the complete target from list_windows or get_active_window. Scope is window or menu_bar.
    max_depth is 0..20 and max_nodes is 1..1000. The result reports every traversal limit reached.
    Element references belong to this MCP worker and expire after 60 seconds of inactivity.
    Text values are omitted from observations. Native AX roles are returned, such as AXButton.
    """
    return request({"op": "ax.inspect", "target": target, "scope": scope,
                    "max_depth": max_depth, "max_nodes": max_nodes})


@mcp.tool()
def ui_find(target: dict, name: str | None = None, control_type: str | None = None,
            automation_id: str | None = None, max_results: int = 20, max_depth: int = 8,
            max_nodes: int = 1000, visible_only: bool = False, enabled_only: bool = False,
            scope: str = "window") -> dict:
    """Find Mac elements within the exact bound window or its owner's menu_bar tree.

    name and control_type match case-insensitive substrings. automation_id matches AXIdentifier exactly.
    Each match has a private element_ref for ui_invoke, plus role, states and available AX actions.
    Bounds and center use global logical points. visibility distinguishes geometric bounds from a confirmed
    current hit. visible_only requires hit confirmation within ancestor clips. A truncated search does not
    prove that no other matches exist.
    max_results is 1..100, max_depth is 0..20, and max_nodes is 1..1000.
    """
    return request({"op": "ax.find", "target": target, "scope": scope,
                    "name": name or "", "control_type": control_type or "", "automation_id": automation_id or "",
                    "max_results": max_results, "max_depth": max_depth, "max_nodes": max_nodes,
                    "visible_only": visible_only, "enabled_only": enabled_only})


@mcp.tool(audit=True)
def ui_invoke(target: dict, element_ref: str, action: str = "invoke", text: str = "") -> dict:
    """Act on one Mac element_ref returned by ui_find or ui_inspect for the same complete window target.

    Requires the exact window in foreground and rechecks process, tree membership, metadata, geometry and state.
    Actions are invoke/click (AXPress), focus, set_value, toggle (checkbox/switch), expand and collapse.
    Unsupported attributes/actions fail explicitly. set_value accepts up to 48000 UTF-8 bytes without NUL.
    Attribute actions require matching readback. AXPress reports acceptance with confirmed=null and outcome
    unconfirmed, so observe its effect before continuing. An uncertain sent action must not be blindly retried.
    """
    return request({"op": "ax.invoke", "target": target, "element_ref": element_ref, "action": action, "text": text})
