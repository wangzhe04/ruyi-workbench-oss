"""ACC_TOOLSETS subset-registration smoke — v1.9 (49d, 03 Phase B #3).

子进程隔离验证:
  ① 默认(不设 env)注册全部 107 件;
  ② ACC_TOOLSETS="filesystem,shell" 只注册该两族 + 常驻(audit/diagnostics)= 15 件;
  ③ 未知 toolset 名忽略并 stderr 提醒,不炸;
  ④ 单族 "office" 含 write_document/excel_read 等且无 desktop 族工具。

Run with UTF-8:  python -X utf8 tests/smoke_toolsets.py
"""

import os
import subprocess
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CHILD_CODE = """
import sys
sys.path.insert(0, r"%s")
import ai_computer_control.server as s
names = sorted(t.name for t in s.mcp._tool_manager.list_tools())
print("COUNT=" + str(len(names)))
print("NAMES=" + ",".join(names))
""" % os.path.join(_ROOT, "src").replace("\\", "\\\\")

_FAILURES: list[str] = []


def check(cond, msg):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def run_child(env_extra=None):
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    env.pop("ACC_TOOLSETS", None)
    if env_extra:
        env.update(env_extra)
    r = subprocess.run([sys.executable, "-X", "utf8", "-c", _CHILD_CODE],
                       cwd=_ROOT, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120)
    count, names, stderr = -1, [], r.stderr or ""
    for line in (r.stdout or "").splitlines():
        if line.startswith("COUNT="):
            count = int(line[6:])
        elif line.startswith("NAMES="):
            names = line[6:].split(",") if line[6:] else []
    return r.returncode, count, names, stderr


def main() -> int:
    print("== ACC_TOOLSETS 子集注册 ==")

    rc, count, names, _ = run_child()
    check(rc == 0 and count == 107, f"默认全开 107 件 (got rc={rc} count={count})")

    rc, count, names, _ = run_child({"ACC_TOOLSETS": "filesystem,shell"})
    check(rc == 0 and count == 15, f"filesystem+shell = 15 件(含 audit/diagnostics 常驻) (got {count})")
    check("edit_file" in names and "run_command" in names and "screenshot" not in names,
          "子集含 filesystem/shell 工具,不含 desktop 族")

    rc, count, names, err = run_child({"ACC_TOOLSETS": "office,nonsense"})
    check(rc == 0 and "write_document" in names and "excel_read" in names and "mouse_click" not in names,
          f"office 族注册正确 (got {count})")
    check("unknown toolset" in err, "未知 toolset 名 stderr 提醒不炸")

    rc, count, names, _ = run_child({"ACC_TOOLSETS": "memory,web,thinking"})
    check(rc == 0 and {"memory_save", "fetch", "sequential_thinking"}.issubset(set(names)),
          f"v1.9 新工具族独立可裁 (got {count})")

    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        print("ACC-TOOLSETS SMOKE: FAIL")
        return 1
    print("ACC-TOOLSETS SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
