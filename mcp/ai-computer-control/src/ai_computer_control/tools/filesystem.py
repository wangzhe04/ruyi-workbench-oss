"""File system operation tools."""

import os
import shutil
import datetime
import codecs
import ctypes
import unicodedata
from ai_computer_control.server import mcp
from ai_computer_control.tools.office_io import replace_with_retry as _replace_with_retry
from ai_computer_control.tools.safety import protected_path_reason


def _system_acp() -> str:
    """The system ANSI code page (cp936 on zh-CN). GBK fallback for non-UTF-8 text files."""
    try:
        return f"cp{ctypes.windll.kernel32.GetACP()}"
    except Exception:
        return "gbk"


def _sniff_bom(raw: bytes) -> tuple[str, int] | None:
    """(codec, bom_length) for a Unicode BOM at the start of raw, else None. UTF-32 first (its LE BOM
    starts with the UTF-16 LE BOM)."""
    if raw.startswith(codecs.BOM_UTF32_LE) or raw.startswith(codecs.BOM_UTF32_BE):
        return "utf-32", 4
    if raw.startswith(codecs.BOM_UTF8):
        return "utf-8-sig", 3
    if raw.startswith(codecs.BOM_UTF16_LE) or raw.startswith(codecs.BOM_UTF16_BE):
        return "utf-16", 2
    return None


def _guess_bomless_utf16(raw: bytes) -> str | None:
    """utf-16-le / utf-16-be when NUL bytes sit almost only on one parity of an ASCII-heavy sample
    (Windows tools sometimes write UTF-16 without BOM); None otherwise."""
    sample = raw[:4096]
    if len(sample) < 4:
        return None
    half = len(sample) // 2
    even_nul = sum(1 for i in range(0, len(sample) - 1, 2) if sample[i] == 0)
    odd_nul = sum(1 for i in range(1, len(sample), 2) if sample[i] == 0)
    if odd_nul > half * 0.3 and even_nul < half * 0.05:
        return "utf-16-le"
    if even_nul > half * 0.3 and odd_nul < half * 0.05:
        return "utf-16-be"
    return None


def _looks_binary(raw: bytes) -> bool:
    """NUL byte in the first 8 KB (text in any ASCII-compatible encoding has none)."""
    return b"\x00" in raw[:8192]


def _trim_partial_utf8(b: bytes) -> bytes:
    """Drop an incomplete UTF-8 sequence at the END of `b` (a byte-budget cut can land mid-character).
    Complete data, or a tail that is not a truncated multi-byte character, is returned unchanged."""
    n = len(b)
    for k in range(1, min(4, n) + 1):
        c = b[n - k]
        if c & 0xC0 == 0x80:          # continuation byte: keep looking for its lead byte
            continue
        need = 1 if c < 0x80 else 2 if c >> 5 == 0b110 else 3 if c >> 4 == 0b1110 else 4 if c >> 3 == 0b11110 else 1
        return b[:n - k] if need > k else b
    return b


def _decode_text(raw: bytes, encoding: str | None, truncated: bool = False) -> tuple[str, str, str | None]:
    """Decode bytes to text. Returns (content, encoding_used, fallback_from).

    Default/'auto'/'utf-8' sniffs a Unicode BOM first (UTF-8 BOM is stripped, UTF-16/32 decoded),
    then tries UTF-8 strict; on UnicodeDecodeError it falls back to the system ANSI code page
    (cp936 on zh-CN), and to gb18030 when that code page is unusable. Native Chinese apps
    (Notepad ANSI, legacy editors, exported configs) write GBK/cp936, and the old errors="replace"
    silently turned every multi-byte GBK char into U+FFFD mojibake. `fallback_from` is set when a
    fallback was applied. `truncated` = the bytes were cut at a byte budget: a dangling partial UTF-8
    character is dropped before the strict attempt (it must not flip the WHOLE file to GBK). Raises ValueError("binary") for NUL-bearing non-UTF-16 data.
    """
    enc = (encoding or "utf-8").strip().lower() or "utf-8"
    if enc in ("auto", "utf-8", "utf8"):
        bom = _sniff_bom(raw)
        if bom:
            codec, n = bom
            data = raw[n:] if codec == "utf-8-sig" else raw
            return data.decode("utf-8" if codec == "utf-8-sig" else codec, errors="replace"), codec, None
        guess = _guess_bomless_utf16(raw)
        if guess:
            return raw.decode(guess, errors="replace"), guess, None
        if _looks_binary(raw):
            raise ValueError("binary")
        try:
            return (_trim_partial_utf8(raw) if truncated else raw).decode("utf-8"), "utf-8", None
        except UnicodeDecodeError:
            for acp in (_system_acp(), "gb18030"):
                try:
                    return raw.decode(acp, errors="replace"), acp, "utf-8"
                except (LookupError, UnicodeDecodeError):
                    continue
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


def _is_cjk_letter(ch: str) -> bool:
    """Ideographs, kana, hangul and CJK symbols/punctuation (、。「」 U+3000-303F): ordinary text in a
    Chinese/Japanese/Korean document, not an edit hazard."""
    cp = ord(ch)
    return (0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0x20000 <= cp <= 0x2FA1F
            or 0xF900 <= cp <= 0xFAFF or 0x3000 <= cp <= 0x30FF or 0x31F0 <= cp <= 0x31FF
            or 0xAC00 <= cp <= 0xD7AF or 0x1100 <= cp <= 0x11FF)


def _non_ascii_report(content: str, max_samples: int = 20) -> dict:
    """List SUSPICIOUS non-ASCII characters (line/column/codepoint/name/context), highest-risk first.

    Meant for exact-match edit hazards (fullwidth punctuation next to ASCII, nbsp, dashes, arrows).
    Ordinary CJK text is NOT listed (it made a 125-byte Chinese doc carry a 2.7 KB report): CJK
    letters/kana/hangul/CJK punctuation are only counted in `cjk_ordinary`, and fullwidth forms
    that sit inside CJK text (，：（） between Chinese characters) count as ordinary too. Samples are
    de-duplicated per character (first position + `count`). `total` counts every non-ASCII char.
    """
    hits: dict[str, dict] = {}
    total = 0
    ordinary = 0
    n = len(content)
    for i, ch in enumerate(content):
        cp = ord(ch)
        if cp <= 127:
            continue
        total += 1
        if _is_cjk_letter(ch):
            ordinary += 1
            continue
        if 0xFF01 <= cp <= 0xFF5E and (
                (i > 0 and _is_cjk_letter(content[i - 1])) or (i + 1 < n and _is_cjk_letter(content[i + 1]))):
            ordinary += 1
            continue
        h = hits.get(ch)
        if h is not None:
            h["count"] += 1
            continue
        if len(hits) >= max_samples * 4:  # bounded bookkeeping on pathological input
            continue
        line_start = content.rfind("\n", 0, i) + 1
        try:
            name = unicodedata.name(ch)
        except ValueError:
            name = "<unnamed>"
        hits[ch] = {"line": content.count("\n", 0, i) + 1, "column": i - line_start + 1, "char": ch,
                    "codepoint": "U+%04X" % cp, "name": name, "context": content[max(0, i - 8):i + 9],
                    "count": 1}
    samples = sorted(hits.values(), key=lambda h: _non_ascii_priority(ord(h["char"][0])))[:max_samples]
    out = {"total": total, "samples": samples}
    if ordinary:
        out["cjk_ordinary"] = ordinary
    return out


@mcp.tool()
def read_file(path: str, encoding: str = "utf-8", max_bytes: int = 1_000_000,
              annotate_non_ascii: bool = False) -> dict:
    """Read the text content of a file.

    Args:
        path: File path to read.
        encoding: Text encoding (default utf-8). "auto" detects: UTF-8 first, then the system ANSI code page
            (cp936 on zh-CN). The default also falls back this way so a GBK file never becomes silent mojibake;
            the encoding used is reported as 'encoding_used' (plus 'encoding_fallback' when a fallback occurred).
        max_bytes: Maximum bytes to read (default 1MB) — a BYTE budget (binary read then decode), so a UTF-8
            Chinese file (~3 bytes/char) returns at most ~max_bytes/3 characters.

    Returns:
        dict with 'content', 'size', 'truncated', 'encoding_used' (and 'encoding_fallback').
    """
    try:
        size = os.path.getsize(path)
        # Read max_bytes+1 raw bytes so truncation is detected from the read itself (a getsize
        # race or a grow-while-reading file can't fool a size comparison). Decode afterwards:
        # a multi-byte char split at the cut boundary is trimmed by _decode_text (truncated=True).
        limit = min(max(0, int(max_bytes)), 10_000_000)  # 10MB 硬顶:防 max_bytes 传超大值导致 OOM(下游 truncateToolResult 60KB 再截)
        with open(path, "rb") as f:
            raw = f.read(limit + 1)
        truncated = len(raw) > limit
        if truncated:
            raw = raw[:limit]
        try:
            content, enc_used, fallback_from = _decode_text(raw, encoding, truncated)
        except ValueError:
            return {"error": "看起来是二进制文件(含 NUL 字节),不按文本读取。", "binary": True, "size": size,
                    "hint": "用 file_info 看类型;文档类用 read_document / pdf_read_pages / excel_read;"
                            "确需字节内容可用 run_command(如 certutil -encodehex / PowerShell Format-Hex);"
                            "若确认是特殊编码文本,传 encoding 参数强制解码。"}
        non_ascii = None
        if annotate_non_ascii:
            # 已逐字标注码点,不再重复附报告。
            content = "".join("⟨U+%04X⟩" % ord(c) if ord(c) > 127 else c for c in content)
        else:
            # 报告只在有"易被当成 ASCII 的可疑字符"时附带;普通中文不再产生噪声(见 _non_ascii_report)。
            non_ascii = _non_ascii_report(content)
        out = {"content": content, "size": size, "truncated": truncated, "encoding_used": enc_used}
        if non_ascii and non_ascii["samples"]:
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
        content: Text content.
        encoding: Text encoding (default utf-8).
        append: If True, append instead of overwriting.
        allow_protected: Bypass the protected-path guard on the destination (default off).

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
                _replace_with_retry(tmp, path)
        except Exception:
            try: os.unlink(tmp)
            except Exception: pass
            raise
        # v1.5.1: echo output_path so the workbench 产物收割 (ARTIFACT_OUTPUT_PATH_KEYS) picks this
        # file up. 此前只回 bytes_written / success, 产出的文件从不进产物页签。
        return {"success": True, "bytes_written": len(content.encode(encoding)), "output_path": os.path.abspath(path)}
    except Exception as e:
        return {"error": str(e)}


_LIST_CAP = 1000


@mcp.tool()
def list_directory(
    path: str = ".",
    pattern: str | None = None,
    recursive: bool = False,
    include_hidden: bool = False,
    limit: int = _LIST_CAP,
) -> dict:
    """List files and directories in a path.

    Args:
        path: Directory path to list.
        pattern: Optional glob filter (e.g. "*.txt").
        recursive: If True, list recursively.
        include_hidden: If True, include dot-files/dirs; when False, hidden directories (e.g. .git) are not
            descended into either.
        limit: Max entries (default and hard max 1000), for every mode.

    Returns:
        dict with 'total' (entries returned), 'capped' (only when cut — narrow with pattern/path), 'skipped' (only
        when >0: entries that could not be stat-ed, e.g. broken symlinks), then 'entries' (name, path, type, size).
        Summary keys come BEFORE the entries so a host-side text cut cannot hide them.
    """
    import glob as glob_module

    try:
        cap = max(1, min(int(limit), _LIST_CAP))
        entries = []
        capped = False
        skipped = 0

        def _entry(name: str, full: str):
            nonlocal skipped
            try:
                st = os.stat(full)
            except OSError:  # broken symlink / locked file: skip, don't fail the whole listing
                skipped += 1
                return None
            return {
                "name": name,
                "path": os.path.abspath(full),
                "type": "directory" if os.path.isdir(full) else "file",
                "size": st.st_size,
            }

        if pattern:
            if recursive:
                search = os.path.join(path, "**", pattern)
            else:
                search = os.path.join(path, pattern)
            matches = glob_module.glob(search, recursive=recursive, include_hidden=include_hidden)
            for match in matches:
                # Looking at a (cap+1)th item proves the response is partial.
                if len(entries) >= cap:
                    capped = True
                    break
                e = _entry(os.path.relpath(match, path), match)
                if e:
                    entries.append(e)
        elif recursive:
            # The cap must stop os.walk itself (a bare `break` only exits the inner loop).
            for root, dirs, files in os.walk(path):
                if not include_hidden:
                    dirs[:] = [d for d in dirs if not d.startswith(".")]  # prune .git etc.
                for name in dirs + files:
                    if not include_hidden and name.startswith("."):
                        continue
                    if len(entries) >= cap:
                        capped = True
                        break
                    full = os.path.join(root, name)
                    e = _entry(os.path.relpath(full, path), full)
                    if e:
                        entries.append(e)
                if capped:
                    break
        else:
            for name in sorted(os.listdir(path)):
                if not include_hidden and name.startswith("."):
                    continue
                if len(entries) >= cap:
                    capped = True
                    break
                e = _entry(name, os.path.join(path, name))
                if e:
                    entries.append(e)

        out = {"total": len(entries)}
        if capped:
            # Honest partial-result marker so the caller knows the listing is truncated.
            out["capped"] = True
        if skipped:
            out["skipped"] = skipped
        out["entries"] = entries
        return out
    except Exception as e:
        return {"error": str(e) or type(e).__name__}


@mcp.tool(audit=True)
def copy_file(source: str, destination: str, allow_protected: bool = False) -> dict:
    """Copy a file or directory.

    Args:
        source: Source path.
        destination: Destination path.
        allow_protected: Override the protected-system-root guard on the destination (default off).
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
