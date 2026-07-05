"""Shared safety guardrails for destructive operations.

Config-light, hard "always-block" floor that protects against the most common foot-guns:
- killing critical OS processes,
- deleting protected system roots,
- running obviously destructive shell commands.

These are display/decision helpers only; callers decide how to surface the refusal.
"""

import json
import os

# ---------------------------------------------------------------------------------------------
# Optional user overrides (data-dir safety.json). Guardrails may only be TIGHTENED, never loosened:
#   protected_paths     -> extra directory trees to protect (added to the built-in floor)
#   denied_commands     -> extra literal substrings that cause run_command to refuse
#   denied_kill_names   -> extra process basenames that kill_process always refuses
#   allowed_kill_names  -> advisory only; does NOT remove any built-in critical-process protection
# A malformed file is ignored entirely and the built-in floor is used (surfaced via safety_info()).
# ---------------------------------------------------------------------------------------------
_CUSTOM = {"protected_paths": [], "denied_commands": [], "denied_kill_names": [],
           "allowed_kill_names": []}
_CUSTOM_SOURCE = {"loaded": False, "path": None, "error": None}


def _load_custom() -> None:
    global _CUSTOM, _CUSTOM_SOURCE
    try:
        from ai_computer_control.paths import safety_config_path
        path = safety_config_path()
    except Exception as e:  # noqa: BLE001
        _CUSTOM_SOURCE = {"loaded": False, "path": None, "error": f"paths error: {e}"}
        return
    _CUSTOM_SOURCE = {"loaded": False, "path": path, "error": None}
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("safety.json must be a JSON object")
        out = {"protected_paths": [], "denied_commands": [], "denied_kill_names": [],
               "allowed_kill_names": []}
        for key in out:
            vals = data.get(key, [])
            if isinstance(vals, list):
                out[key] = [str(v) for v in vals if isinstance(v, (str, int))]
        _CUSTOM = out
        _CUSTOM_SOURCE = {"loaded": True, "path": path, "error": None}
    except Exception as e:  # noqa: BLE001 — malformed config: ignore, keep built-in floor
        _CUSTOM = {"protected_paths": [], "denied_commands": [], "denied_kill_names": [],
                   "allowed_kill_names": []}
        _CUSTOM_SOURCE = {"loaded": False, "path": path, "error": str(e)}


_load_custom()


def _custom_protected_norm() -> list[str]:
    out = []
    for p in _CUSTOM.get("protected_paths", []):
        try:
            out.append(os.path.normcase(os.path.abspath(p)).rstrip(os.sep))
        except Exception:
            continue
    return sorted(set(out))


# Processes whose termination can crash or hang Windows. Matched by exact basename (lowercased).
CRITICAL_PROCESSES = {
    "system", "system idle process", "registry", "smss.exe", "csrss.exe", "wininit.exe",
    "winlogon.exe", "services.exe", "lsass.exe", "lsm.exe", "svchost.exe", "fontdrvhost.exe",
    "dwm.exe", "sihost.exe", "ctfmon.exe", "spoolsv.exe", "audiodg.exe",
    "memcompression", "ntoskrnl.exe", "wudfhost.exe",
}

# System TREES: the directory itself AND everything inside it is protected (deleting C:\Windows\System32
# would break the OS). ROOT-ONLY: only the exact location is protected (don't wipe the whole drive or
# the whole user profile), but files *inside* them are the user's to manage.
def _system_trees() -> list[str]:
    out = []
    for env in ("SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
        v = os.environ.get(env)
        if v:
            out.append(os.path.normcase(os.path.abspath(v)).rstrip(os.sep))
    return sorted(set(out))


def _root_only() -> list[str]:
    out = []
    sysdrive = os.environ.get("SystemDrive", "C:")
    out.append(os.path.normcase(os.path.abspath(sysdrive + os.sep)))  # drive root C:\ (keep trailing sep)
    up = os.environ.get("USERPROFILE")
    if up:
        out.append(os.path.normcase(os.path.abspath(up)).rstrip(os.sep))
    return sorted(set(out))


# Destructive command signatures. Substring/prefix checks on a normalized command string.
import re

# NOTE: a substring denylist over an arbitrary shell string is fundamentally bypassable; this is a
# best-effort floor, not a security boundary. Patterns are order-independent where flags matter.
_DANGEROUS_CMD = [
    # Disk format: fire on 'format' + any drive-letter / volume-GUID / format switch anywhere.
    (re.compile(r"\bformat\b(?=.*(?:\b[a-z]:|\\\\[?.]\\volume|/fs:|/q\b|/y\b))", re.I), "disk format"),
    (re.compile(r"\bdiskpart\b", re.I), "diskpart"),
    (re.compile(r"\b(rd|rmdir)\b.*\s/s", re.I), "recursive rmdir"),
    (re.compile(r"\b(del|erase)\b.*\s/s", re.I), "recursive del"),
    # Remove-Item (or aliases ri/rm) with -Recurse in any order (with or without -Force).
    (re.compile(r"\b(remove-item|ri|rm)\b(?=.*(?:-recurse|-r\b))", re.I), "Remove-Item -Recurse"),
    # Unix-style recursive rm (-r/-rf/-fr), e.g. via WSL/git-bash.
    (re.compile(r"\brm\b\s+-[a-z]*r", re.I), "recursive rm"),
    (re.compile(r"\bclear-content\b", re.I), "Clear-Content"),
    (re.compile(r"\[(?:system\.)?io\.(?:directory|file)\]::delete", re.I), ".NET IO delete"),
    (re.compile(r"\bcipher\s+/w", re.I), "cipher wipe"),
    # Registry delete: cmd 'reg delete' + all hive abbreviations/full names, and the PS drive form.
    (re.compile(r"\breg\s+delete\s+(hklm|hkcu|hkcr|hku|hkcc|hkey_local_machine|hkey_current_user|hkey_classes_root|hkey_users|hkey_current_config)\b", re.I), "registry delete"),
    (re.compile(r"\bremove-item(property)?\b.*\bhk(lm|cu|cr|u|cc):", re.I), "PowerShell registry delete"),
    (re.compile(r"\b(shutdown|restart-computer|stop-computer)\b", re.I), "shutdown/restart"),
    (re.compile(r"\b(vssadmin\s+delete|wbadmin\s+delete)\b", re.I), "backup/shadow-copy delete"),
    (re.compile(r"\bbcdedit\b", re.I), "boot configuration edit"),
    (re.compile(r":\(\)\s*\{\s*:\|:", re.I), "fork bomb"),
]


def is_critical_process(name: str | None) -> bool:
    if not name:
        return False
    base = name.strip().lower()
    if base in CRITICAL_PROCESSES:
        return True
    # Custom denied names (tightening only): match on full name or extension-stripped basename.
    denied = {d.strip().lower() for d in _CUSTOM.get("denied_kill_names", [])}
    if denied:
        stem = os.path.splitext(base)[0]
        if base in denied or stem in denied:
            return True
    return False


def protected_path_reason(path: str) -> str | None:
    """Return a reason if `path` is a protected system tree (or inside one), a protected root itself,
    or an ancestor of any protected location; else None."""
    try:
        target = os.path.normcase(os.path.abspath(os.path.realpath(path)))
    except Exception:
        target = os.path.normcase(os.path.abspath(path))
    target = target.rstrip(os.sep)
    trees = _system_trees() + _custom_protected_norm()
    roots = _root_only()
    # 1) System trees: the tree itself or anything inside it (built-in + custom protected paths).
    for r in trees:
        if target == r or target.startswith(r + os.sep):
            return f"'{path}' is inside a protected location"
    # 2) Root-only: only the exact drive root / profile root (not their contents).
    for r in roots:
        rr = r.rstrip(os.sep)
        if target == rr or target == r:
            return f"'{path}' is a protected root"
    # 3) Ancestor of any protected location -> deleting it would take the protected location with it.
    for r in trees + [x.rstrip(os.sep) for x in roots]:
        if r.startswith(target + os.sep):
            return f"'{path}' contains a protected system location"
    return None


def dangerous_command_reason(command: str) -> str | None:
    """Return a reason string if the command matches a known destructive pattern, else None."""
    if not command:
        return None
    for pattern, label in _DANGEROUS_CMD:
        if pattern.search(command):
            return f"blocked destructive command pattern: {label}"
    # Custom denied substrings (tightening only), case-insensitive.
    low = command.lower()
    for sub in _CUSTOM.get("denied_commands", []):
        s = str(sub).strip().lower()
        if s and s in low:
            return f"blocked by custom denied_commands rule: {sub!r}"
    return None


def safety_config_summary() -> dict:
    """Return the effective guardrail configuration and where custom rules came from."""
    return {
        "builtin": {
            "critical_processes": sorted(CRITICAL_PROCESSES),
            "system_trees": _system_trees(),
            "root_only": _root_only(),
            "dangerous_command_patterns": [label for _p, label in _DANGEROUS_CMD],
        },
        "custom": {
            "protected_paths": _CUSTOM.get("protected_paths", []),
            "denied_commands": _CUSTOM.get("denied_commands", []),
            "denied_kill_names": _CUSTOM.get("denied_kill_names", []),
            "allowed_kill_names": _CUSTOM.get("allowed_kill_names", []),
        },
        "custom_source": _CUSTOM_SOURCE,
        "note": "Guardrails only tighten. allowed_kill_names is advisory and does NOT remove "
                "built-in critical-process protection.",
    }
