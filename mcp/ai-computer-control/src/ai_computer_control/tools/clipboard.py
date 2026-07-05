"""Clipboard TEXT tools (剪贴板文本一等公民).

文本剪贴板的读 (get_clipboard) / 写 (set_clipboard) —— 图片剪贴板另见 desktop_extra 的
get_clipboard_image / set_clipboard_image。诊断: diagnostics() 的工具注册表即含这两个工具 (无需额外上报)。
"""

import pyperclip
from ai_computer_control.server import mcp


@mcp.tool()
def get_clipboard() -> dict:
    """读取系统剪贴板里的【文本】内容 (用户刚复制的文字)。

    什么时候用: 用户说「我复制了…你看一下」「把我剪贴板里的内容…」，或你刚让某个 App 执行了「复制」
    (Ctrl+C / 菜单复制) 后想拿到结果。只读文本；若剪贴板里是图片/文件，本工具会明确告知 (has_image /
    has_files)，此时改用 get_clipboard_image。

    Returns:
        dict with ok, text；并区分四种状态: 有文本 / has_image / has_files / empty，避免「空串」把
        「真没内容」和「其实是图片」混为一谈。
    """
    try:
        text = pyperclip.paste()
    except Exception as e:  # noqa: BLE001
        text = None
        text_err = str(e)
    else:
        text_err = None

    has_image = has_files = False
    files = None
    try:
        from PIL import ImageGrab
        data = ImageGrab.grabclipboard()
        if isinstance(data, list):
            has_files = True
            files = [str(p) for p in data]
        elif data is not None:
            has_image = True
    except Exception:
        pass

    out = {"ok": True, "text": text or ""}
    if has_image:
        out["has_image"] = True
        out["note"] = "剪贴板里是图片，用 get_clipboard_image 读取。"
    if has_files:
        out["has_files"] = True
        out["files"] = files
        out["note"] = "剪贴板里是文件路径列表 (见 files)。"
    if not text and not has_image and not has_files:
        out["empty"] = True
        if text_err:
            out["text_error"] = text_err
    return out


@mcp.tool(audit=True)
def set_clipboard(text: str) -> dict:
    """把一段【文本】写入系统剪贴板，供其它程序粘贴 (Ctrl+V)。

    什么时候用: 你算好/写好了一段内容，想让用户直接粘贴；或需要把长文本喂进某个不方便逐字输入的输入框
    (先 set_clipboard 再在目标里按 Ctrl+V，比 type_text 逐字敲更快更稳)。写图片请用 set_clipboard_image。
    注意: 写入会覆盖用户当前剪贴板 (含已复制的图片/文件)。

    Args:
        text: 要放进剪贴板的文本。

    Returns:
        dict with ok, length (写入的字符数)。
    """
    try:
        pyperclip.copy(text)
        out = {"ok": True, "length": len(text)}
        if text == "":
            out["note"] = "写入了空串，等于清空了剪贴板。"
        return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
