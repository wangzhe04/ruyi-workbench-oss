"""File system operation tools."""

import os
import shutil
import datetime
import ctypes
import unicodedata
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason


def _system_acp() -> str:
    """The system ANSI code page (cp936 on zh-CN). GBK fallback for non-UTF-8 text files."""
    try:
        return f"cp{ctypes.windll.kernel32.GetACP()}"
    except Exception:
        return "gbk"


def _decode_text(raw: bytes, encoding: str | None) -> tuple[str, str, str | None]:
    """Decode bytes to text. Returns (content, encoding_used, fallback_from).

    Default/'auto'/'utf-8' tries UTF-8 strict first; on UnicodeDecodeError it falls back to the
    system ANSI code page (cp936 on zh-CN). Native Chinese apps (Notepad ANSI, legacy editors,
    exported configs) write GBK/cp936, and the old errors="replace" silently turned every multi-byte
    GBK char into U+FFFD mojibake. `fallback_from` is set when a fallback was applied.
    """
    enc = (encoding or "utf-8").strip().lower() or "utf-8"
    if enc in ("auto", "utf-8", "utf8"):
        try:
            return raw.decode("utf-8"), "utf-8", None
        except UnicodeDecodeError:
            acp = _system_acp()
            try:
                return raw.decode(acp, errors="replace"), acp, "utf-8"
            except (LookupError, UnicodeDecodeError):
                return raw.decode("utf-8", errors="replace"), "utf-8", None
    try:
        return raw.decode(enc, errors="replace"), enc, None
    except LookupError:
        return raw.decode("utf-8", errors="replace"), "utf-8", enc


def _non_ascii_priority(cp: int) -> int:
    """0 = most likely to be mistaken for ASCII (fullwidth / nbsp / dashes / arrows / operators)."""
    if 0xFF01 <= cp <= 0xFF5E or cp in (0x00A0, 0x2009, 0x202F):
        return 0
    if 0x2010 <= cp <= 0x2027 or 0x2190 <= cp <= 0x21FF or 0x00B7 <= cp <= 0x00F7:
        return 1
    return 2


def _non_ascii_report(content: str, max_samples: int = 20) -> dict:
    """List non-ASCII characters (line/column/codepoint/name/context), highest-risk first.

    The JSON payload stays small: at most max_samples samples + a total count, sorted so
    characters that render nearly identically to ASCII (fullwidth, en/em dashes, arrows,
    non-breaking space) come first — those are the ones an exact-match edit silently misses.
    """
    hits = []
    total = 0
    for i, ch in enumerate(content):
        cp = ord(ch)
        if cp <= 127:
            continue
        total += 1
        if len(hits) < max_samples:
            line_start = content.rfind("\n", 0, i) + 1
            line = content.count("\n", 0, i) + 1
            col = i - line_start + 1
            try:
                name = unicodedata.name(ch)
            except ValueError:
                name = "<unnamed>"
            hits.append({"line": line, "column": col, "char": ch, "codepoint": "U+%04X" % cp,
                         "name": name, "context": content[max(0, i - 8):i + 9]})
    hits.sort(key=lambda h: _non_ascii_priority(ord(h["char"][0])))
    return {"total": total, "samples": hits[:max_samples]}


@mcp.tool()
def read_file(path: str, encoding: str = "utf-8", max_bytes: int = 1_000_000,
              annotate_non_ascii: bool = False) -> dict:
    """Read the text content of a file.

    Args:
        path: File path to read.
        encoding: Text encoding (default utf-8). Pass "auto" to detect: tries UTF-8 first, then the
            system ANSI code page (cp936 on zh-CN) for files from native Chinese apps. The default
            (utf-8) ALSO applies this fallback so a GBK file no longer silently becomes mojibake;
            the encoding actually used is reported as 'encoding_used' (and 'encoding_fallback' when
            a fallback occurred).
        max_bytes: Maximum bytes to read (default 1MB). This is a BYTE budget: the file is read
            in binary and decoded, so a UTF-8 Chinese file (1 char ~= 3 bytes) returns at most
            ~max_bytes/3 characters — never max_bytes *characters* (~3x the promised bytes).

    Returns:
        dict with 'content', 'size', 'truncated', 'encoding_used' (and 'encoding_fallback'
        if a fallback was applied).
    """
    try:
        size = os.path.getsize(path)
        # Read max_bytes+1 raw bytes so truncation is detected from the read itself (a getsize
        # race or a grow-while-reading file can't fool a size comparison). Decode afterwards:
        # a multi-byte char split at the cut boundary becomes U+FFFD via errors="replace".
        limit = min(max(0, int(max_bytes)), 10_000_000)  # 10MB 硬顶:防 max_bytes 传超大值导致 OOM(下游 truncateToolResult 60KB 再截)
        with open(path, "rb") as f:
            raw = f.read(limit + 1)
        truncated = len(raw) > limit
        if truncated:
            raw = raw[:limit]
        content, enc_used, fallback_from = _decode_text(raw, encoding)
        if annotate_non_ascii:
            content = "".join("⟨U+%04X⟩" % ord(c) if ord(c) > 127 else c for c in content)
        non_ascii = _non_ascii_report(content)
        out = {"content": content, "size": size, "truncated": truncated, "encoding_used": enc_used}
        if non_ascii["total"]:
            out["non_ascii"] = non_ascii
        if fallback_from:
            out["encoding_fallback"] = {"requested": fallback_from, "used": enc_used}
        return out
    except Exception as e:
        return {"error": str(e)}


@mcp.tool(audit=True)
def write_file(path: str, content: str, encoding: str = "utf-8", append: bool = False,
               allow_protected: bool = False) -> dict:
    """Write or append text content to a file. Creates parent directories if needed.

    Args:
        path: File path to write.
        content: Text content to write.
        encoding: Text encoding (default utf-8).
        append: If True, append to existing file instead of overwriting.
        allow_protected: Override the protected-system-root guard on the destination (default off).

    Returns:
        dict with 'success' and 'bytes_written'.
    """
    reason = protected_path_reason(path)
    if reason and not allow_protected:
        return {"error": f"refused to write: destination {reason}. Pass allow_protected=true to override."}
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        mode = "a" if append else "w"
        if not append and os.path.exists(path):
            return {"error": f"refused: '{path}' already exists. write_file would overwrite it. Delete it first, use append=true, or pass the merged content."}
        import tempfile
        encoded = content.encode(encoding)
        dirn = os.path.dirname(os.path.abspath(path)) or "."
        fd, tmp = tempfile.mkstemp(dir=dirn, prefix=".write-", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(encoded)
            if append:
                with open(path, "ab") as f:
                    f.write(encoded)
                try: os.unlink(tmp)
                except Exception: pass
            else:
                os.replace(tmp, path)
        except Exception:
            try: os.unlink(tmp)
            except Exception: pass
            raise
        # v1.5.1: echo output_path so the workbench 产物收割 (ARTIFACT_OUTPUT_PATH_KEYS) picks this
        # file up. 此前只回 bytes_written / success, 产出的文件从不进产物页签。
        return {"success": True, "bytes_written": len(content.encode(encoding)), "output_path": os.path.abspath(path)}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def list_directory(
    path: str = ".",
    pattern: str | None = None,
    recursive: bool = False,
    include_hidden: bool = False,
) -> dict:
    """List files and directories in a path.

    Args:
        path: Directory path to list.
        pattern: Optional glob pattern filter (e.g. "*.txt", "*.py").
        recursive: If True, list recursively.
        include_hidden: If True, include hidden files (starting with .).

    Returns:
        dict with 'entries' list containing name, type, size.
    """
    import glob as glob_module

    try:
        entries = []
        capped = False

        if pattern:
            if recursive:
                search = os.path.join(path, "**", pattern)
            else:
                search = os.path.join(path, pattern)
            matches = glob_module.glob(search, recursive=recursive)
            capped = len(matches) > 1000
            for match in matches[:1000]:
                stat = os.stat(match)
                entries.append({
                    "name": os.path.relpath(match, path),
                    "path": os.path.abspath(match),
                    "type": "directory" if os.path.isdir(match) else "file",
                    "size": stat.st_size,
                })
        else:
            items = os.listdir(path) if not recursive else []
            if recursive:
                # The 1000-entry cap must stop os.walk itself: a bare `break` only exits the
                # inner per-directory loop, so every further directory appended one more entry
                # before breaking again (entries could exceed 1000 by the remaining dir count).
                for root, dirs, files in os.walk(path):
                    for name in dirs + files:
                        # Looking at a 1001st item proves the response is partial. Checking before
                        # appending avoids reporting capped=True for an exactly-1000-entry tree.
                        if len(entries) >= 1000:
                            capped = True
                            break
                        full = os.path.join(root, name)
                        if not include_hidden and name.startswith("."):
                            continue
                        stat = os.stat(full)
                        entries.append({
                            "name": os.path.relpath(full, path),
                            "path": os.path.abspath(full),
                            "type": "directory" if os.path.isdir(full) else "file",
                            "size": stat.st_size,
                        })
                    if capped:
                        break
            else:
                for name in sorted(items):
                    if not include_hidden and name.startswith("."):
                        continue
                    full = os.path.join(path, name)
                    try:
                        stat = os.stat(full)
                        entries.append({
                            "name": name,
                            "path": os.path.abspath(full),
                            "type": "directory" if os.path.isdir(full) else "file",
                            "size": stat.st_size,
                        })
                    except OSError:
                        continue

        out = {"entries": entries, "total": len(entries)}
        if capped:
            # Honest partial-result marker so the caller knows the listing is truncated.
            out["capped"] = True
        return out
    except Exception as e:
        return {"error": str(e)}


@mcp.tool(audit=True)
def copy_file(source: str, destination: str, allow_protected: bool = False) -> dict:
    """Copy a file or directory.

    Args:
        source: Source path.
        destination: Destination path.
        allow_protected: Override the protected-system-root guard on the destination (default off).

    Returns:
        dict with 'success'.
    """
    reason = protected_path_reason(destination)
    if reason and not allow_protected:
        return {"error": f"refused: destination {reason}. Pass allow_protected=true to override."}
    try:
        if os.path.isdir(source):
            shutil.copytree(source, destination)
        else:
            os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
            if os.path.exists(destination):
                return {"error": f"refused: destination '{destination}' already exists. Delete it first or pick a different destination."}
            shutil.copy2(source, destination)
        return {"success": True, "source": source, "destination": destination}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool(audit=True)
def move_file(source: str, destination: str, allow_protected: bool = False) -> dict:
    """Move or rename a file or directory.

    Args:
        source: Source path.
        destination: Destination path.
        allow_protected: Override the protected-system-root guard (default off).

    Returns:
        dict with 'success'.
    """
    reason = protected_path_reason(source) or protected_path_reason(destination)
    if reason and not allow_protected:
        return {"error": f"refused: {reason}. Pass allow_protected=true to override."}
    try:
        os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
        if os.path.exists(destination) and os.path.abspath(source) != os.path.abspath(destination):
            return {"error": f"refused: destination '{destination}' already exists. Delete it first or pick a different destination."}
        shutil.move(source, destination)
        return {"success": True, "source": source, "destination": destination}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool(audit=True)
def delete_file(path: str, allow_protected: bool = False, confirm: bool = False) -> dict:
    """Delete a file or directory.

    Args:
        path: Path to delete.
        allow_protected: Override the protected-system-root guard (default off).

    Returns:
        dict with 'success'.
    """
    reason = protected_path_reason(path)
    if reason and not allow_protected:
        return {"error": f"refused to delete: {reason}. Pass allow_protected=true to override."}
    try:
        if os.path.isdir(path):
            if not confirm:
                return {"error": f"refused: '{path}' is a directory; recursive delete is irreversible and has no recycle bin. Pass confirm=true to proceed, or delete files individually."}
            failed = []
            def _onerror(fn, p, exc):
                failed.append(str(p))
            shutil.rmtree(path, onerror=_onerror)
            if failed:
                return {"success": False, "path": path, "error": f"partial delete: {len(failed)} path(s) could not be removed (read-only/locked), e.g. {failed[:5]}"}
        else:
            os.remove(path)
        return {"success": True, "path": path}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool()
def file_info(path: str) -> dict:
    """Get detailed file metadata.

    Args:
        path: File path.

    Returns:
        dict with size, type, created, modified, extension, etc.
    """
    try:
        stat = os.stat(path)
        return {
            "path": os.path.abspath(path),
            "exists": True,
            "type": "directory" if os.path.isdir(path) else "file",
            "size": stat.st_size,
            "size_human": _human_size(stat.st_size),
            "created": datetime.datetime.fromtimestamp(stat.st_ctime).isoformat(),
            "modified": datetime.datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "extension": os.path.splitext(path)[1],
            "is_readonly": not os.access(path, os.W_OK),
        }
    except FileNotFoundError:
        return {"path": os.path.abspath(path), "exists": False}
    except Exception as e:
        return {"error": str(e)}


def _human_size(size: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} PB"
