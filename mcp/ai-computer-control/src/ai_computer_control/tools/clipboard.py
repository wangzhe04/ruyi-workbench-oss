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
    (Ctrl+C / 菜单复制) 后想拿到结果。只读文本；若剪贴板里是图片，请改用 get_clipboard_image。

    Returns:
        dict with ok, text (剪贴板文本；剪贴板为空或非文本时通常是空串 '')。
    """
    try:
        text = pyperclip.paste()
        return {"ok": True, "text": text}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@mcp.tool(audit=True)
def set_clipboard(text: str) -> dict:
    """把一段【文本】写入系统剪贴板，供其它程序粘贴 (Ctrl+V)。

    什么时候用: 你算好/写好了一段内容，想让用户直接粘贴；或需要把长文本喂进某个不方便逐字输入的输入框
    (先 set_clipboard 再在目标里按 Ctrl+V，比 type_text 逐字敲更快更稳)。写图片请用 set_clipboard_image。

    Args:
        text: 要放进剪贴板的文本。

    Returns:
        dict with ok, length (写入的字符数)。
    """
    try:
        pyperclip.copy(text)
        return {"ok": True, "length": len(text)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
