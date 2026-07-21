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
import time

from ai_computer_control.paths import data_dir
from ai_computer_control.server import mcp

_MAX_ENTRIES = 500
_MAX_CONTENT_CHARS = 4000
_MAX_KEY_CHARS = 120


def _store_path() -> str:
    return os.path.join(data_dir(), "memory.json")


def _load() -> dict:
    path = _store_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("entries"), dict):
            return data
    except FileNotFoundError:
        pass
    except Exception:
        # Corrupt store: quarantine once, rebuild empty. Never raise into the tool path.
        try:
            os.replace(path, path + ".corrupt")
        except Exception:
            pass
    return {"entries": {}}


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
        key: Short slug identifying the memory (e.g. "user-editor-preference"). Reusing a key
            overwrites the old content (that IS the update path).
        content: Free-text memory body (max 4000 chars; longer is truncated with a marker).
        tags: Optional comma-separated labels for later filtering (e.g. "preference,editor").

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
    store = _load()
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
    entry = _load()["entries"].get((key or "").strip())
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
    entries = _load()["entries"]
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
    store = _load()
    key = (key or "").strip()
    deleted = store["entries"].pop(key, None) is not None
    if deleted:
        try:
            _save(store)
        except Exception as e:
            return {"error": f"写入记忆库失败: {e}"}
    return {"success": True, "deleted": deleted, "key": key}
