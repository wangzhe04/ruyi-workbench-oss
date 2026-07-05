"""File system operation tools."""

import os
import shutil
import datetime
from ai_computer_control.server import mcp
from ai_computer_control.tools.safety import protected_path_reason


@mcp.tool()
def read_file(path: str, encoding: str = "utf-8", max_bytes: int = 1_000_000) -> dict:
    """Read the text content of a file.

    Args:
        path: File path to read.
        encoding: Text encoding (default utf-8).
        max_bytes: Maximum bytes to read (default 1MB).

    Returns:
        dict with 'content' and 'size'.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "r", encoding=encoding, errors="replace") as f:
            content = f.read(max_bytes)
        truncated = size > max_bytes
        return {"content": content, "size": size, "truncated": truncated}
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
        with open(path, mode, encoding=encoding) as f:
            f.write(content)
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

        if pattern:
            if recursive:
                search = os.path.join(path, "**", pattern)
            else:
                search = os.path.join(path, pattern)
            matches = glob_module.glob(search, recursive=recursive)
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
                for root, dirs, files in os.walk(path):
                    for name in dirs + files:
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
                        if len(entries) >= 1000:
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

        return {"entries": entries, "total": len(entries)}
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
        shutil.move(source, destination)
        return {"success": True, "source": source, "destination": destination}
    except Exception as e:
        return {"error": str(e)}


@mcp.tool(audit=True)
def delete_file(path: str, allow_protected: bool = False) -> dict:
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
            shutil.rmtree(path)
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
