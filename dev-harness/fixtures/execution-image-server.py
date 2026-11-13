"""Synthetic image payloads through the real ACC SDK/context/journal, never desktop I/O."""
import hashlib
import json
import os
import time
from pathlib import Path

from ai_computer_control import server
from ai_computer_control.utils.execution_context import _request

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="


@server.mcp.tool()
def fixture_image(label: str) -> dict:
    """Return a fixed one-pixel PNG; this is not a screenshot."""
    if "NODE_FOREGROUND_DISPATCH_GAP worker0" in label:
        root = Path(os.environ["RUYI_FIXTURE_DATA"]).parent
        invocation = _request.get().journal.invocation_id
        (root / "node-acc-blocked.json").write_text(json.dumps({"invocationId": invocation}))
        deadline = time.monotonic() + 5
        while not (root / "node-acc-release").exists():
            if time.monotonic() > deadline:
                return {"ok": False, "error": "bounded synthetic ACC payload wait timed out"}
            time.sleep(0.01)
    return {"ok": True, "label": label, "image_base64": PNG, "format": "png", "width": 1, "height": 1}


@server.mcp.tool()
def fixture_observe(label: str) -> dict:
    """Observe only the fixture's own durable history before the next tool body."""
    root = Path(os.environ["RUYI_FIXTURE_DATA"])
    request = _request.get()
    # The trusted SDK scope owns the session metadata; no model path argument is accepted.
    state = json.loads((root / "desktop-executions-v1/state.json").read_text())
    invocation = request.journal.invocation_id
    current = next(row for row in state["entries"] if row["invocationId"] == invocation)
    session_id = current["sessionId"]
    raw = (root / "sessions" / (session_id + ".provider.ndjson")).read_bytes()
    lines = raw.splitlines()
    history = [json.loads(line) for line in lines]
    digest = hashlib.sha256(b"[" + b",".join(lines) + b"]").hexdigest()
    images = [row for row in history if row.get("role") == "user" and isinstance(row.get("content"), list)
              and any(part.get("type") == "image_url" for part in row["content"])]
    delivered = [row for row in state["entries"] if row["sessionId"] == session_id
                 and row["toolName"] == "fixture_image" and row.get("deliverySha256")]
    return {"ok": True, "label": label, "images": len(images), "deliveredImages": len(delivered),
            "lastImageDeliveryMatchesSnapshot": bool(delivered) and delivered[-1]["deliverySha256"] == digest,
            "roles": [row["role"] for row in history]}


@server.mcp.tool()
def fixture_observe_node(label: str) -> dict:
    """Read this actual node's prior acknowledged image snapshot, never the parent transcript."""
    root = Path(os.environ["RUYI_FIXTURE_DATA"])
    request = _request.get()
    state = json.loads((root / "desktop-executions-v1/state.json").read_text())
    current = next(row for row in state["entries"] if row["invocationId"] == request.journal.invocation_id)
    images = [row for row in state["entries"] if row["admissionId"] == current["admissionId"]
              and row["toolName"] == "fixture_image" and row.get("deliverySha256")]
    previous = images[-1] if images else None
    if previous is None:
        return {"ok": False, "error": "No acknowledged image in the actual node"}
    saved = json.loads((root / "desktop-executions-v1" / previous["nodeDelivery"]["file"]).read_text())
    history = saved["history"]
    compact = json.dumps(history, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    digest = hashlib.sha256(compact).hexdigest()
    image_count = sum(row.get("role") == "user" and isinstance(row.get("content"), list)
                      and any(part.get("type") == "image_url" for part in row["content"]) for row in history)
    return {"ok": True, "label": label, "images": image_count, "deliveredImages": len(images),
            "lastImageDeliveryMatchesSnapshot": digest == saved["historySha256"] == previous["deliverySha256"],
            "sameNodeAdmission": saved["admissionId"] == current["admissionId"], "nodeId": saved["binding"]["nodeId"],
            "toolIds": [row["tool_call_id"] for row in history if row.get("role") == "tool"]}


server.main()
