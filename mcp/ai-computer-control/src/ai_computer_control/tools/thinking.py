"""Sequential thinking tool — v1.9 addition.

A reasoning-aid tool mirroring the widely-used community sequential-thinking MCP contract:
the model externalizes a step-by-step thought chain, may revise earlier thoughts or branch,
and the server tracks the chain state (per server process). Pure text protocol, zero deps.
"""

from ai_computer_control.server import mcp

# Process-local chain state. A server process serves one host session, so module state is fine;
# a new chain is started by simply calling with thought_number=1 again.
_history: list[dict] = []
_branches: dict[str, list[dict]] = {}


@mcp.tool()
def sequential_thinking(thought: str, thought_number: int, total_thoughts: int,
                        next_thought_needed: bool, is_revision: bool = False,
                        revises_thought: int | None = None,
                        branch_from_thought: int | None = None,
                        branch_id: str | None = None) -> dict:
    """Record one step of an explicit step-by-step reasoning chain.

    何时用: 复杂多步问题(规划、调试根因、方案权衡)需要把推理链外化、允许中途修正/分支时;
        链式记录让思考过程可审计、可回退。
    何时别用: 简单一步能答的问题(徒增往返);真正的计算/检索(这不是执行工具,只记录思考)。

    Args:
        thought: The content of this thinking step.
        thought_number: 1-based sequence number of this step (can exceed total_thoughts when the
            chain legitimately needs more steps than first estimated).
        total_thoughts: Current estimate of how many steps the chain needs (may be revised up/down).
        next_thought_needed: True if another step should follow; False ends the chain.
        is_revision: True when this step rethinks a previous one.
        revises_thought: Which thought_number this revises (required when is_revision=True).
        branch_from_thought: Start a side branch from this step number (optional).
        branch_id: Identifier for the branch (required when branch_from_thought is set).

    Returns:
        dict with 'thought_number', 'total_thoughts', 'next_thought_needed',
        'thought_history_length', 'branches' (known branch ids).
    """
    global _history, _branches
    if not (thought or "").strip():
        return {"error": "thought 为空 —— 每个思考步都需要内容。"}
    if thought_number < 1:
        return {"error": "thought_number 必须从 1 开始。"}
    if total_thoughts < 1:
        return {"error": "total_thoughts 必须 ≥ 1(之后可以上调/下调估计)。"}
    if is_revision and not revises_thought:
        return {"error": "is_revision=true 时必须给出 revises_thought(修订哪一步)。"}
    if branch_from_thought is not None and not branch_id:
        return {"error": "branch_from_thought 与 branch_id 必须同时提供。"}

    # Starting over at step 1 without revision/branch semantics = a fresh chain.
    if thought_number == 1 and not is_revision and branch_from_thought is None:
        _history = []
        _branches = {}

    entry = {
        "thought": thought,
        "thought_number": thought_number,
        "total_thoughts": total_thoughts,
        "is_revision": is_revision,
        "revises_thought": revises_thought,
        "branch_from_thought": branch_from_thought,
        "branch_id": branch_id,
    }
    if branch_id:
        _branches.setdefault(branch_id, []).append(entry)
    else:
        _history.append(entry)

    return {
        "thought_number": thought_number,
        "total_thoughts": total_thoughts,
        "next_thought_needed": bool(next_thought_needed),
        "thought_history_length": len(_history),
        "branches": sorted(_branches.keys()),
    }
