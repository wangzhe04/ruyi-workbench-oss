"""Persistent memory tools — v1.9 addition.

A small standalone key/content store so an agent can remember durable facts across sessions
when this server is used by a standalone host (Claude Desktop etc.). Stored as a single JSON
file under the ACC data dir — deliberately SEPARATE from the Ruyi workbench's own memory bank
(互补而非冲突).

Design notes:
  * tmp-write + rename for crash safety; a corrupt store is quarantined to memory.json.corrupt
    and rebuilt empty rather than killing every memory call (mirror of the workbench lesson).
  * Keys are short slugs; content is free text. Tags are a comma-separated string for filtering.
"""

import json
import os
import threading
import time

from ai_computer_control.paths import data_dir
from ai_computer_control.server import mcp

_MAX_ENTRIES = 500
_MAX_CONTENT_CHARS = 4000
_MAX_KEY_CHARS = 120


def _store_path() -> str:
    return os.path.join(data_dir(), "memory.json")


class _StoreBusy(OSError):
    """The store exists but could not be read right now (AV / OneDrive / sharing violation)."""


_BUSY_MSG = "记忆库暂时被占用(可能被杀毒/网盘同步锁住),原文件未动,请稍后重试。"


def _quarantine(path: str) -> None:
    dst = path + ".corrupt"
    if os.path.exists(dst):  # 不覆盖更早的隔离副本
        dst = "%s.corrupt-%s" % (path, time.strftime("%Y%m%d%H%M%S"))
    try:
        os.replace(path, dst)
    except Exception:
        pass


def _load() -> dict:
    """Read the store. Only a real parse/shape failure quarantines the file; a transient OSError
    (PermissionError / sharing violation) is retried briefly and then raised as _StoreBusy — a healthy
    store must never be renamed away (that used to make every memory vanish)."""
    path = _store_path()
    last_err = None
    for attempt in range(4):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return {"entries": {}}
        except ValueError:  # JSONDecodeError / UnicodeDecodeError: the content really is bad
            _quarantine(path)
            return {"entries": {}}
        except OSError as e:
            last_err = e
            if attempt < 3:
                time.sleep(0.05)
            continue
        if isinstance(data, dict) and isinstance(data.get("entries"), dict):
            return data
        _quarantine(path)  # valid JSON but not a store
        return {"entries": {}}
    raise _StoreBusy(str(last_err))


# b3-P2: 读-改-写串行锁 —— ACC 的同步工具由 FastMCP 放进线程池执行,两个并发 memory_save/delete
# 会同时 _load() 同一份 store 再各自写回,后写者覆盖先写者(丢更新)。一把模块级锁把 [load→修改→save]
# 包成临界区;memory 是低频操作,锁竞争可忽略,收益是 memory_save 不再静默丢条目。
_MEMORY_LOCK = threading.Lock()


def _save(store: dict) -> None:
    path = _store_path()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


@mcp.tool(audit=True)
def memory_save(key: str, content: str, tags: str = "") -> dict:
    """Save or update a durable memory entry (upsert by key).

    何时用: 跨会话需要记住的事实/偏好/决定(用户偏好、项目约定、环境细节)。
    何时别用: 大段文档/代码(有 4000 字上限,放文件里只存路径);一次性临时信息。

    Args:
        key: Short slug (e.g. "user-editor-preference"); reusing a key overwrites (that IS the update path).
        content: Free-text body (max 4000 chars; longer is truncated with a marker).
        tags: Optional comma-separated labels for filtering (e.g. "preference,editor").

    Returns:
        dict with 'success', 'key', 'updated' (iso time), 'overwritten' (bool).
    """
    key = (key or "").strip()
    if not key:
        return {"error": "key 为空 —— 每条记忆需要一个短 slug 作为键。"}
    if len(key) > _MAX_KEY_CHARS:
        return {"error": f"key 过长({len(key)} > {_MAX_KEY_CHARS} 字符)。"}
    truncated = False
    if len(content) > _MAX_CONTENT_CHARS:
        content = content[:_MAX_CONTENT_CHARS]
        truncated = True
    with _MEMORY_LOCK:
        try:
            store = _load()
        except _StoreBusy:
            return {"error": _BUSY_MSG}
        entries = store["entries"]
        if key not in entries and len(entries) >= _MAX_ENTRIES:
            return {"error": f"记忆库已满({_MAX_ENTRIES} 条)—— 先 memory_delete 清理不再需要的条目。"}
        overwritten = key in entries
        entries[key] = {
            "content": content,
            "tags": [t.strip() for t in (tags or "").split(",") if t.strip()],
            "updated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        try:
            _save(store)
        except Exception as e:
            return {"error": f"写入记忆库失败: {e}"}
    out = {"success": True, "key": key, "updated": entries[key]["updated"], "overwritten": overwritten}
    if truncated:
        out["truncated"] = True
    return out


@mcp.tool()
def memory_read(key: str) -> dict:
    """Read one memory entry by its exact key.

    何时用: 已知道键名,要取回完整内容。
    何时别用: 不确定键名时(用 memory_list 搜索)。

    Args:
        key: The exact slug used at memory_save time.

    Returns:
        dict with 'found', and when found 'key'/'content'/'tags'/'updated'.
    """
    try:
        entry = _load()["entries"].get((key or "").strip())
    except _StoreBusy:
        return {"error": _BUSY_MSG}
    if entry is None:
        return {"found": False, "key": key}
    return {"found": True, "key": key, "content": entry["content"], "tags": entry["tags"], "updated": entry["updated"]}


@mcp.tool()
def memory_list(query: str = "", limit: int = 50) -> dict:
    """List memory entries, optionally filtered by a case-insensitive substring.

    何时用: 浏览/搜索记忆(匹配 key、content、tags 任意一处)。
    何时别用: 已知确切键名(直接 memory_read 更准)。

    Args:
        query: Substring filter (empty = list all). Case-insensitive.
        limit: Max entries returned (1-200, default 50). Results are newest-updated first.

    Returns:
        dict with 'entries' ([{key, preview, tags, updated}]), 'total' (matching count).
    """
    q = (query or "").strip().lower()
    cap = max(1, min(int(limit), 200))
    try:
        entries = _load()["entries"]
    except _StoreBusy:
        return {"error": _BUSY_MSG}
    matched = []
    for k, v in entries.items():
        if q:
            hay = k.lower() + "\n" + v["content"].lower() + "\n" + " ".join(v["tags"]).lower()
            if q not in hay:
                continue
        matched.append({
            "key": k,
            "preview": v["content"][:120],
            "tags": v["tags"],
            "updated": v["updated"],
        })
    matched.sort(key=lambda e: e["updated"], reverse=True)
    return {"entries": matched[:cap], "total": len(matched), "capped": len(matched) > cap}


@mcp.tool(audit=True)
def memory_delete(key: str) -> dict:
    """Delete a memory entry by key.

    何时用: 记忆已过时/错误,需要移除。
    何时别用: 只是想改内容(直接 memory_save 同键覆盖)。

    Args:
        key: The exact slug to delete.

    Returns:
        dict with 'success', 'deleted' (bool — False when the key did not exist).
    """
    key = (key or "").strip()
    with _MEMORY_LOCK:
        try:
            store = _load()
        except _StoreBusy:
            return {"error": _BUSY_MSG}
        deleted = store["entries"].pop(key, None) is not None
        if deleted:
            try:
                _save(store)
            except Exception as e:
                return {"error": f"写入记忆库失败: {e}"}
    return {"success": True, "deleted": deleted, "key": key}
