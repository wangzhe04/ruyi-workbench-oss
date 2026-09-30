"""Append-only audit log for mutating tool calls (NDJSON, one file per day, size-rotated).

`log_action(tool, args, ok, error=None, ms=None)` appends a single JSON line to
<data>/logs/audit-YYYYMMDD.ndjson (a day file that grows past ~5 MB is renamed to
audit-YYYYMMDD.HHMMSS.ndjson and a fresh one started; only the newest 30 files are kept). Each record
carries the redacted args as a JSON object (not a pre-encoded string), the ok/error outcome and the
duration. It is deliberately best-effort: any failure to serialize or write is swallowed so auditing can
NEVER break the tool it is auditing. `audit_tail(n)` reads the most recent n records back (seeking from
the end of the newest files, never reading whole logs).

Sensitive-looking fields (password/token/secret/key/...) are redacted by KEY name, and string
VALUES are scrubbed for inline credential shapes (``password=...``, ``Bearer ...``, ``sk-...``,
JWTs, ...) so e.g. a run_command line carrying a password does not land in the log verbatim.
The args summary is truncated to <=500 characters.
"""

import datetime
import json
import os
import re

from ai_computer_control.server import mcp
from ai_computer_control.paths import logs_dir
from ai_computer_control.utils.errors import exc_text

_MAX_ARGS_CHARS = 500
_MAX_ERROR_CHARS = 200
_MAX_FILE_BYTES = 5 * 1024 * 1024   # rotate a log file once it grows past this
_KEEP_FILES = 30                    # newest N audit files survive pruning
_SECRET_HINTS = ("password", "passwd", "secret", "token", "api_key", "apikey",
                 "access_key", "private_key", "credential", "auth")

# Inline credential shapes scrubbed from every string VALUE (keys like "command" or "content"
# aren't secret-looking, but the command line / file body can still carry a credential).
# Mirrors the workbench-side redact() coverage so both audit sources follow one policy.
# ORDER MATTERS: token shapes run BEFORE the generic key=value shape — otherwise
# "Authorization: Bearer abc123" loses "Bearer" to the generic shape and leaks the token.
_SECRET_VALUE_PATTERNS = (
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{6,}"), "Bearer ***"),
    (re.compile(r"(?i)\b(sk|pk|xox[baprs])-[A-Za-z0-9-]{8,}\b"), r"\1-***"),
    (re.compile(r"\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b"), "***"),
    # JWT (header always starts with eyJ = base64 of `{"`)
    (re.compile(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}\b"), "***"),
    # key=value / key: value forms, LAST (see order note above)
    (re.compile(r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|"
                r"private[_-]?key|credential|authorization)\b\s*[:=]\s*(\"[^\"]*\"|'[^']*'|\S+)"),
     r"\1=***"),
)


def _looks_secret(key: str) -> bool:
    k = key.lower()
    return any(h in k for h in _SECRET_HINTS)


def _scrub_value(v: str) -> str:
    for rx, rep in _SECRET_VALUE_PATTERNS:
        v = rx.sub(rep, v)
    return v


def _redact_args(args):
    """Secret-scrubbed, size-bounded view of the call args.

    A dict stays a dict (so the log holds real JSON, not a JSON string inside JSON); if the redacted dict
    would exceed ``_MAX_ARGS_CHARS`` once serialized it degrades to a truncated string. Anything that is not
    a dict becomes a scrubbed string.
    """
    try:
        if isinstance(args, dict):
            safe = {}
            for k, v in args.items():
                if _looks_secret(str(k)):
                    safe[k] = "***"
                elif isinstance(v, str):
                    v = _scrub_value(v)
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
            if len(s) <= _MAX_ARGS_CHARS:
                return safe
        else:
            s = _scrub_value(str(args))
    except Exception:
        try:
            s = str(args)
        except Exception:
            s = "<unserializable>"
    if len(s) > _MAX_ARGS_CHARS:
        s = s[:_MAX_ARGS_CHARS] + "...(truncated)"
    return s


def _summarize_args(args) -> str:
    """The redacted args as a string capped at 500 chars (kept for callers that want text)."""
    red = _redact_args(args)
    if isinstance(red, str):
        return red
    try:
        return json.dumps(red, ensure_ascii=False, default=str)
    except Exception:
        return "<unserializable>"


def _audit_files(d: str) -> list[str]:
    """Audit file names in chronological order (rotated ``.HHMMSS`` files sort before the day's live file)."""
    try:
        return sorted(fn for fn in os.listdir(d) if fn.startswith("audit-") and fn.endswith(".ndjson"))
    except OSError:
        return []


def _prune(d: str) -> None:
    """Keep only the newest ``_KEEP_FILES`` audit files."""
    files = _audit_files(d)
    for fn in files[:max(0, len(files) - _KEEP_FILES)]:
        try:
            os.remove(os.path.join(d, fn))
        except OSError:
            pass


_pruned_dirs: set[str] = set()


def _rotate_if_needed(path: str) -> bool:
    """Rename an oversized live file to a timestamped sibling. Returns True if a rotation happened."""
    try:
        if os.path.getsize(path) < _MAX_FILE_BYTES:
            return False
    except OSError:
        return False
    stem = path[:-len(".ndjson")]
    rotated = f"{stem}.{datetime.datetime.now().strftime('%H%M%S')}.ndjson"
    n = 0
    while os.path.exists(rotated):  # same-second rotation: keep names unique and ordered
        n += 1
        rotated = f"{stem}.{datetime.datetime.now().strftime('%H%M%S')}{n:02d}.ndjson"
    try:
        os.replace(path, rotated)
        return True
    except OSError:
        return False


def log_action(tool: str, args_summary, ok: bool = True, error: str | None = None, ms: int | None = None) -> None:
    """Append one audit record. Never raises — auditing must not break the audited tool."""
    try:
        rec = {
            "ts": datetime.datetime.now().isoformat(timespec="seconds"),
            "tool": tool,
            "ok": bool(ok),
            "args": _redact_args(args_summary),
        }
        if error:
            e = _scrub_value(str(error))
            rec["error"] = e if len(e) <= _MAX_ERROR_CHARS else e[:_MAX_ERROR_CHARS] + "..."
        if ms is not None:
            rec["ms"] = int(ms)
        line = json.dumps(rec, ensure_ascii=False, default=str)
        d = logs_dir()
        fname = "audit-" + datetime.datetime.now().strftime("%Y%m%d") + ".ndjson"
        path = os.path.join(d, fname)
        rotated = _rotate_if_needed(path)
        first_in_dir = d not in _pruned_dirs
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        if rotated or first_in_dir:
            _pruned_dirs.add(d)
            _prune(d)
    except Exception:
        # Auditing is best-effort; swallow everything.
        pass


def _tail_lines(path: str, n: int) -> list[str]:
    """Last ``n`` non-empty lines of a file, reading blocks backwards from the end."""
    block = 64 * 1024
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        data = b""
        while pos > 0 and data.count(b"\n") <= n:
            step = min(block, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data
    lines = data.split(b"\n")
    if pos > 0:
        lines = lines[1:]  # first element is a partial line cut by the block boundary
    return [ln.decode("utf-8", errors="replace") for ln in lines if ln.strip()][-n:]


@mcp.tool()
def audit_tail(n: int = 50) -> dict:
    """Return the most recent audit-log records (mutating tool calls).

    Args:
        n: Number of most-recent records to return (1-1000, default 50).

    Returns:
        dict with ok, count, and 'records' (newest last), reading across day-rolled/rotated log files.
        Each record: ts, tool, ok, args (redacted object), and error/ms when known.
    """
    try:
        n = max(1, min(1000, int(n)))
        d = logs_dir()
        files = _audit_files(d)
        lines: list[str] = []
        # Walk newest files first, collecting lines until we have >= n.
        for fn in reversed(files):
            try:
                flines = _tail_lines(os.path.join(d, fn), n)
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
        return {"ok": False, "error": exc_text(e)}
