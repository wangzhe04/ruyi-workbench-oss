"""Shared write-path plumbing for the Office writers (write_document / write_excel / write_pdf /
write_pptx / chart_image / excel_beautify / excel_chart).

Two jobs:

* 原子落盘 + 失败人话:先写同目录临时文件再 os.replace,目标被 Excel/Word/WPS 占用(Windows 上
  PermissionError / WinError 5|32|33)时返回 ok:false 带恢复提示,并且原文件字节不变。
* 缺可选依赖(python-docx / openpyxl / python-pptx / matplotlib / reportlab)时给安装提示信封,
  而不是裸 ModuleNotFoundError。

无第三方依赖(stdlib only),也不注册任何 MCP 工具。
"""

import errno
import os
import tempfile

_LOCK_WINERRORS = (5, 32, 33)
_LOCK_ERRNOS = (errno.EACCES, errno.EPERM, errno.EBUSY)

_INSTALL_HINTS = {
    "docx": ("python-docx", "Word 文档读写需要 python-docx"),
    "openpyxl": ("openpyxl", "Excel 读写需要 openpyxl"),
    "pptx": ("python-pptx", "PPTX 生成需要 python-pptx"),
    "matplotlib": ("matplotlib", "制图需要 matplotlib"),
    "reportlab": ("reportlab", "PDF 导出需要 reportlab"),
}


def is_locked_error(e: BaseException) -> bool:
    """True for 「文件被别的进程占用 / 无权写入」class errors (Windows sharing violation included)."""
    if isinstance(e, PermissionError):
        return True
    if isinstance(e, OSError):
        if getattr(e, "winerror", None) in _LOCK_WINERRORS:
            return True
        if e.errno in _LOCK_ERRNOS:
            return True
    return False


def alt_path_hint(path: str) -> str:
    stem, ext = os.path.splitext(os.path.basename(str(path)))
    return f"{stem or 'output'}_v2{ext}"


def io_failure(e: BaseException, path: str | None = None, prefix: str = "") -> dict:
    """Map an exception raised while writing `path` to a tool error envelope.

    Locked / permission errors -> code 'file_locked' + a recovery hint (关闭 Excel/WPS 或换路径).
    Other OSErrors keep their text but carry code 'io_error'. Anything else is just the message.
    """
    if is_locked_error(e):
        alt = alt_path_hint(path) if path else "新文件名"
        hint = (f"文件可能正被 Excel/Word/WPS 打开,或该位置没有写入权限。请关闭该文件后重试,"
                f"或换一个新文件名(如 {alt})。"
                f" (close the file in Excel/WPS or choose another path)")
        return {"error": f"{prefix}无法写入目标文件:{e}。{hint}",
                "code": "file_locked", "hint": hint, "path": str(path) if path else None}
    if isinstance(e, ModuleNotFoundError) and getattr(e, "name", None):
        top = str(e.name).split(".")[0]
        if top in _INSTALL_HINTS:
            return missing_dependency(top)
    out = {"error": f"{prefix}{e}"}
    if isinstance(e, OSError):
        out["code"] = "io_error"
    return out


def missing_dependency(module: str, detail: str = "") -> dict:
    pip_name, what = _INSTALL_HINTS.get(module, (module, f"需要 {module}"))
    out = {"error": f"{what}。离线包已含,可运行 installer 重装;或 pip install {pip_name}",
           "code": "missing_dependency", "hint": f"pip install {pip_name}"}
    if detail:
        out["detail"] = detail
    return out


def require(module: str):
    """Import `module` lazily. Returns (module, None) or (None, install-hint-envelope)."""
    import importlib
    try:
        return importlib.import_module(module), None
    except Exception as e:  # noqa: BLE001 — optional dependency
        return None, missing_dependency(module, str(e))


def atomic_save(path: str, writer, *, suffix: str | None = None) -> None:
    """Run writer(tmp_path) into a same-directory temp file, then os.replace onto `path`.

    A failure at any point (writer crash, target locked by Excel) removes the temp file and leaves the
    original bytes untouched. The exception propagates so the caller can map it with io_failure().
    """
    target = os.path.abspath(path)
    dirn = os.path.dirname(target) or "."
    os.makedirs(dirn, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dirn, prefix=".ruyi-", suffix=suffix or ".tmp")
    os.close(fd)
    try:
        writer(tmp)
        # mkstemp makes a 0600 file; keep the old file's mode (or a normal 0644) so POSIX users are not
        # surprised. On Windows chmod only toggles read-only, and 0644 keeps the file writable.
        try:
            mode = os.stat(target).st_mode & 0o777
        except OSError:
            mode = 0o644
        try:
            os.chmod(tmp, mode | 0o200)
        except OSError:
            pass
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
