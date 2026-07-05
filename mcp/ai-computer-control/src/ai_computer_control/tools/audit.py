"""Append-only audit log for mutating tool calls (NDJSON, one file per day).

`log_action(tool, args_summary, ok)` appends a single JSON line to
<data>/logs/audit-YYYYMMDD.ndjson. It is deliberately best-effort: any failure to serialize
or write is swallowed so auditing can NEVER break the tool it is auditing. `audit_tail(n)` reads
the most recent n records back for inspection.

Sensitive-looking fields (password/token/secret/key/...) are redacted, and the args summary is
truncated to <=500 characters.
"""

import datetime
import json
import os

from ai_computer_control.server import mcp
from ai_computer_control.paths import logs_dir

_MAX_ARGS_CHARS = 500
_SECRET_HINTS = ("password", "passwd", "secret", "token", "api_key", "apikey",
                 "access_key", "private_key", "credential", "auth")


def _looks_secret(key: str) -> bool:
    k = key.lower()
    return any(h in k for h in _SECRET_HINTS)


def _summarize_args(args) -> str:
    """Turn an args dict/obj into a short, secret-scrubbed string capped at 500 chars."""
    try:
        if isinstance(args, dict):
            safe = {}
            for k, v in args.items():
                if _looks_secret(str(k)):
                    safe[k] = "***"
                elif isinstance(v, str):
                    safe[k] = v if len(v) <= 120 else v[:120] + "..."
                elif isinstance(v, (int, float, bool)) or v is None:
                    safe[k] = v
                elif isinstance(v, (list, tuple)):
                    safe[k] = f"<{type(v).__name__} len={len(v)}>"
                elif isinstance(v, dict):
                    safe[k] = f"<dict keys={len(v)}>"
                else:
                    safe[k] = f"<{type(v).__name__}>"
            s = json.dumps(safe, ensure_ascii=False, default=str)
        else:
            s = str(args)
    except Exception:
        try:
            s = str(args)
        except Exception:
            s = "<unserializable>"
    if len(s) > _MAX_ARGS_CHARS:
        s = s[:_MAX_ARGS_CHARS] + "...(truncated)"
    return s


def log_action(tool: str, args_summary, ok: bool = True) -> None:
    """Append one audit record. Never raises — auditing must not break the audited tool."""
    try:
        rec = {
            "ts": datetime.datetime.now().isoformat(timespec="seconds"),
            "tool": tool,
            "ok": bool(ok),
            "args": _summarize_args(args_summary),
        }
        line = json.dumps(rec, ensure_ascii=False, default=str)
        fname = "audit-" + datetime.datetime.now().strftime("%Y%m%d") + ".ndjson"
        path = os.path.join(logs_dir(), fname)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        # Auditing is best-effort; swallow everything.
        pass


@mcp.tool()
def audit_tail(n: int = 50) -> dict:
    """Return the most recent audit-log records (mutating tool calls).

    Args:
        n: Number of most-recent records to return (1-1000, default 50).

    Returns:
        dict with ok, count, and 'records' (newest last), reading across day-rolled log files.
    """
    try:
        n = max(1, min(1000, int(n)))
        d = logs_dir()
        try:
            files = sorted(fn for fn in os.listdir(d)
                           if fn.startswith("audit-") and fn.endswith(".ndjson"))
        except FileNotFoundError:
            files = []
        lines: list[str] = []
        # Walk newest files first, collecting lines until we have >= n.
        for fn in reversed(files):
            try:
                with open(os.path.join(d, fn), "r", encoding="utf-8", errors="replace") as f:
                    flines = [ln for ln in f.read().splitlines() if ln.strip()]
            except Exception:
                continue
            lines = flines + lines
            if len(lines) >= n:
                break
        tail = lines[-n:]
        records = []
        for ln in tail:
            try:
                records.append(json.loads(ln))
            except Exception:
                records.append({"raw": ln})
        return {"ok": True, "count": len(records), "records": records, "log_dir": d}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
