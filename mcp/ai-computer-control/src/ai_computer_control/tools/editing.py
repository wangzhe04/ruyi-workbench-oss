"""Local (partial) file editing tools — v1.9 addition.

The toolkit historically only had whole-file ``write_file``: every small change meant
re-emitting the entire file (token-expensive, and dangerous when the model truncates).
``edit_file`` does exact-string replacement in place, mirroring the familiar
"old_string must be unique" edit contract agents already know.
"""

import os
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
        return {"error": "old_string 在文件中未出现(0 次)—— 注意缩进/换行/全半角必须与原文逐字节一致;先 read_file 核对。"}
    if occurrences > 1 and not replace_all:
        return {"error": f"old_string 出现 {occurrences} 次,不唯一 —— 请把前后文多带几行使它唯一,或确认后传 replace_all=true 全部替换。"}

    replaced = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)
    n = occurrences if replace_all else 1
    try:
        with open(path, "w", encoding=encoding) as f:
            f.write(replaced)
    except Exception as e:
        return {"error": str(e)}
    # Echo output_path so the workbench 产物收割 (ARTIFACT_OUTPUT_PATH_KEYS) picks the edit up.
    return {"success": True, "replacements": n, "output_path": os.path.abspath(path)}
