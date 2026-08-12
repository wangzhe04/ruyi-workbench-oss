"""Local (partial) file editing tools — v1.9 addition.

The toolkit historically only had whole-file ``write_file``: every small change meant
re-emitting the entire file (token-expensive, and dangerous when the model truncates).
``edit_file`` does exact-string replacement in place, mirroring the familiar
"old_string must be unique" edit contract agents already know.
"""

import os
import tempfile
import codecs
import difflib
import re
import unicodedata
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason

_MAX_EDIT_BYTES = 10 * 1024 * 1024  # refuse to load files >10MB into memory for editing


@mcp.tool(audit=True)
def edit_file(path: str, old_string: str, new_string: str, replace_all: bool = False,
              encoding: str = "utf-8", allow_protected: bool = False) -> dict:
    """Replace an exact string inside a file, in place (partial edit).

    何时用: 改动一个已有文件的一小段(几行代码、一处配置、一句话) —— 比 write_file 整文件重写
        更省 token、更安全(不会意外截断/丢内容)。
    何时别用: 新建文件、整文件重写、或 old_string 在文件里根本不存在时(先用 read_file 看清
        现状再改);二进制文件别用(按文本解码)。

    Args:
        path: File path to edit (must already exist).
        old_string: The exact text to find. Must match byte-for-byte INCLUDING indentation and
            newlines; read the file first to copy it verbatim.
        new_string: The replacement text (may be empty to delete).
        replace_all: False (default) requires old_string to occur EXACTLY once — a 0 or >1
            match is an error, which is the safety catch against ambiguous edits. True replaces
            every occurrence.
        encoding: Text encoding used for both read and write (default utf-8). The file is
            re-written with the same encoding it was decoded with.
        allow_protected: Override the protected-system-root guard (default off).

    Returns:
        dict with 'success', 'replacements' (occurrences replaced), 'output_path'. On failure a
        dict with 'error' (人话说明: not found / not unique / decode failure / protected).
    """
    reason = protected_path_reason(path)
    if reason and not allow_protected:
        return {"error": f"refused to edit: destination {reason}. Pass allow_protected=true to override."}
    if old_string == new_string:
        return {"error": "old_string 与 new_string 完全相同 —— 没有可应用的改动。"}
    if not old_string:
        return {"error": "old_string 为空 —— 本工具只做替换;要插入内容请把插入点前后的原文一起放进 old_string。"}
    try:
        size = os.path.getsize(path)
    except FileNotFoundError:
        return {"error": f"file not found: {path}(要新建文件请用 write_file)"}
    except Exception as e:
        return {"error": str(e)}
    if size > _MAX_EDIT_BYTES:
        return {"error": f"file too large to edit in memory ({size} bytes > {_MAX_EDIT_BYTES}); 请分段处理或用 write_file 重写。"}
    try:
        with open(path, "r", encoding=encoding) as f:
            text = f.read()
    except UnicodeDecodeError as e:
        return {"error": f"按 {encoding} 解码失败({e})—— 文件可能是别的编码(如 gbk)或二进制;换 encoding 参数重试。"}
    except Exception as e:
        return {"error": str(e)}

    occurrences = text.count(old_string)
    if occurrences == 0:
        file_crlf = _file_uses_crlf(path)
        diag = _diagnose_mismatch(text, old_string, file_crlf)
        return {"error": "old_string 在文件中未出现(0 次)。" + diag}
    if occurrences > 1 and not replace_all:
        return {"error": f"old_string 出现 {occurrences} 次,不唯一 —— 请把前后文多带几行使它唯一,或确认后传 replace_all=true 全部替换。"}

    replaced = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)
    n = occurrences if replace_all else 1
    # b2-P0: 原子写 —— 先写同目录临时文件再 os.replace,任何写失败(编码/磁盘满)都不会截断原文。
    # 同时保留原 UTF-8 BOM(文本读取剥 BOM,写回恢复),避免旧文件 BOM 被无声丢弃。
    try:
        has_bom = False
        try:
            with open(path, "rb") as _rb:
                has_bom = _rb.read(3) == codecs.BOM_UTF8
        except Exception:
            has_bom = False
        encoded = replaced.encode(encoding)
        if has_bom and encoding.lower() in ("utf-8", "utf8"):
            encoded = codecs.BOM_UTF8 + encoded
        dirn = os.path.dirname(os.path.abspath(path)) or "."
        fd, tmp = tempfile.mkstemp(dir=dirn, prefix=".edit-", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(encoded)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass
            raise
    except Exception as e:
        return {"error": f"写入失败: {e}(原文件未被修改 —— 本工具采用原子写,不会留下截断文件)。"}
    # Echo output_path so the workbench 产物收割 (ARTIFACT_OUTPUT_PATH_KEYS) picks the edit up.
    return {"success": True, "replacements": n, "output_path": os.path.abspath(path)}

def _codepoint_name(ch: str) -> str:
    """U+XXXX 'c' (UNICODE NAME) — visible even when the character itself renders like ASCII."""
    try:
        name = unicodedata.name(ch)
    except ValueError:
        name = "<unnamed>"
    return "U+%04X %r (%s)" % (ord(ch), ch, name)


def _find_closest_single_line(text: str, old_string: str):
    """For a single-line old_string, scan text line by line with a sliding window.

    Returns (line_no, col, got_char, want_char, ratio) or None. Line-level comparison beats a
    whole-text SequenceMatcher because unrelated surrounding text dilutes the ratio and the
    first opcode often points at the window start instead of the real difference.
    """
    lines = text.split("\n")
    long_toks = [t for t in re.findall(r"\S+", old_string) if len(t) >= 2]
    single_toks = [ch for ch in old_string if ch.isalnum() and ch not in " \t\r\n"]
    # Phase 1: filter by long tokens (e.g. words). Phase 2 falls back to single chars only when
    # phase 1 matches nothing — the differing char is often itself the only long token.
    toks = long_toks
    best = None
    def scan(toks):
        nonlocal best
        for ln, line in enumerate(lines, 1):
            if not line.strip() or len(line) < 2:
                continue
            if not any(tok in line for tok in toks):
                continue
            if len(line) > 1000:
                continue
            step = max(1, len(line) // 400)
            for off in range(0, max(1, len(line) - len(old_string) + 1), step):
                seg = line[off:off + len(old_string)]
                ratio = difflib.SequenceMatcher(None, seg, old_string).ratio()
                if best is None or ratio > best[0]:
                    best = (ratio, ln, off, seg)
    scan(toks)
    if best is None and single_toks:
        scan(single_toks)
    if not best or best[0] < 0.25:
        return None
    ratio, ln, off, seg = best
    for k, (a, b) in enumerate(zip(seg, old_string)):
        if a != b:
            return (ln, off + k + 1, a, b, ratio)
    if len(seg) != len(old_string):
        return (ln, off + min(len(seg), len(old_string)) + 1,
                seg[min(len(seg), len(old_string))] if len(seg) > len(old_string) else "<EOF>",
                old_string[min(len(seg), len(old_string))] if len(old_string) > len(seg) else "<END>",
                ratio)
    return (ln, off + 1, "<same>", "<same>", ratio)


def _file_uses_crlf(path: str) -> bool:
    """True when the file on disk uses CRLF line endings (binary probe — the in-memory text was
    already normalized by universal newlines, so \"\\r\\n\" in text is always False)."""
    try:
        with open(path, "rb") as f:
            return b"\r\n" in f.read(65536)
    except Exception:
        return False


def _diagnose_mismatch(text: str, old_string: str, file_crlf: bool = False) -> str:
    """Human-readable diagnosis when old_string is not found in text.

    Ordered for actionability: (1) common invisible traps, (2) the closest position in the file,
    (3) the first differing character with codepoints on both sides.
    """
    parts = []
    # --- (1) common traps ---
    traps = []
    if "\r\n" in old_string:
        if file_crlf:
            traps.append("old_string 含 CRLF 换行——文本模式读取已把磁盘上的 CRLF 归一化为 LF,old_string 应改用 LF 或先 read_file 复制原文")
        else:
            traps.append("old_string 含 CRLF 换行,文件是 LF")
    if unicodedata.normalize("NFC", old_string) != old_string:
        traps.append("old_string 含组合字符(NFD 形式),文件可能是预组合 NFC")
    for ch in set(old_string):
        cp = ord(ch)
        if 0xFF01 <= cp <= 0xFF5E:
            traps.append("old_string 含全角字符 %s,文件里可能是半角" % _codepoint_name(ch))
            break
    non_ascii = [ch for ch in old_string if ord(ch) > 127]
    if non_ascii:
        shown = ", ".join(_codepoint_name(ch) for ch in non_ascii[:8])
        traps.append("old_string 含非 ASCII 字符: %s——文件对应位置可能是 ASCII 形近字符(或反之),逐字节必然不匹配" % shown)
    if traps:
        parts.append("常见陷阱:" + ";".join(traps) + "。")
    # --- (2) closest position ---
    if "\n" not in old_string.strip():
        hit = _find_closest_single_line(text, old_string)
        if hit:
            ln, col, got, want, ratio = hit
            if got == "<same>":
                parts.append("最接近的匹配在第 %d 行第 %d 列附近(相似度 %d%%)。" % (ln, col, int(ratio * 100)))
            else:
                parts.append("最接近的匹配在第 %d 行第 %d 列附近(相似度 %d%%);首个差异:文件是 %s,old_string 是 %s。" % (
                    ln, col, int(ratio * 100), _codepoint_name(got), _codepoint_name(want)))
            return "\n".join(parts)
    else:
        # multi-line old_string: anchored window search
        anchors = []
        stripped = old_string.strip()
        if stripped:
            anchors.append(stripped[:16])
        for tok in re.findall(r"\S+", old_string):
            if len(tok) >= 2:
                anchors.append(tok)
        positions = set()
        seen = set()
        for a in anchors:
            if a in seen:
                continue
            seen.add(a)
            start = 0
            cnt = 0
            while True:
                i2 = text.find(a, start)
                if i2 < 0 or cnt >= 2:
                    break
                positions.add(i2)
                start = i2 + 1
                cnt += 1
                if len(positions) >= 6:
                    break
            if len(positions) >= 6:
                break
        best = None
        for pos in positions:
            wstart = max(0, pos - len(old_string))
            wend = min(len(text), pos + 2 * len(old_string) + 64)
            window = text[wstart:wend]
            sm = difflib.SequenceMatcher(None, window, old_string)
            ratio = sm.ratio()
            if best is None or ratio > best[0]:
                best = (ratio, wstart, sm)
        if best and best[0] >= 0.25:
            ratio, wstart, sm = best
            for tag, i1, i2, j1, j2 in sm.get_opcodes():
                if tag == "equal":
                    continue
                abs_pos = wstart + i1
                line_start = text.rfind("\n", 0, abs_pos) + 1
                line = text.count("\n", 0, abs_pos) + 1
                col = abs_pos - line_start + 1
                got = text[abs_pos] if abs_pos < len(text) else "<EOF>"
                want = old_string[j1] if j1 < len(old_string) else "<END>"
                parts.append("最接近的匹配在第 %d 行第 %d 列附近(相似度 %d%%);首个差异:文件是 %s,old_string 是 %s。" % (
                    line, col, int(ratio * 100), _codepoint_name(got), _codepoint_name(want)))
                break
            else:
                parts.append("最接近的匹配在第 %d 行附近(相似度 %d%%)。" % (
                    text.count("\n", 0, wstart) + 1, int(ratio * 100)))
            return "\n".join(parts)
    parts.append("文件里找不到与 old_string 相似的内容——整个片段可能都不存在(内容/编码完全不符),建议重新 read_file 核对。")
    return "\n".join(parts)
