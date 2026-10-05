"""ACC_TOOLSETS subset-registration smoke — v1.9 (49d, 03 Phase B #3).

子进程隔离验证:
  ① 默认(不设 env)注册全部 108 件;
  ② ACC_TOOLSETS="filesystem,shell" 只注册该两族 + 常驻(audit/diagnostics)= 15 件;
  ③ 未知 toolset 名忽略并 stderr 提醒,不炸;
  ④ 单族 "office" 含 write_document/excel_read 等且无 desktop 族工具;
  ⑤ 调用 diagnostics() 不得再注册任何工具(它曾 import 全部可选模块: 15 -> 51 件,ACC_TOOLSETS 被悄悄撤销);
  ⑥ 某个工具模块 import 失败(如 psutil DLL 坏了)不拖垮服务: 其余工具照常,
     diagnostics().load_errors 点名失败的模块,stderr 留一行。
  ⑦ ACC_HIDE_TOOLS(逗号分隔的确切工具名,工作台的能力总闸用)把点名的工具从注册表摘掉: tools/list 没有它们,
     batch_actions / macro_run 经实时注册表也转调不到;未知名字忽略;diagnostics().hidden_tools 如实报出;
     名单外的工具一个不少。

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
d = s.mcp._tool_manager.get_tool("diagnostics").fn()
print("COUNT_AFTER_DIAG=" + str(len(s.mcp._tool_manager.list_tools())))
print("REPORTED=" + str(d.get("tool_count")))
print("LOAD_ERRORS=" + ",".join(sorted(d.get("load_errors", {}))))
""" % os.path.join(_ROOT, "src").replace("\\", "\\\\")

# Same, but `psutil` fails to import the way a broken pywin32/psutil DLL does.
_BROKEN_PSUTIL = "import importlib.abc\nclass _B(importlib.abc.MetaPathFinder):\n    def find_spec(self, name, path, target=None):\n        if name == 'psutil' or name.startswith('psutil.'):\n            raise ImportError('DLL load failed while importing _psutil_windows')\nsys.meta_path.insert(0, _B())\n"
_CHILD_CODE_BROKEN = _CHILD_CODE.replace("import ai_computer_control.server as s", _BROKEN_PSUTIL + "import ai_computer_control.server as s")
# ⑦: also report what batch_actions could dispatch to, and the hidden list diagnostics() reports.
# (Only used with the default toolsets, where the batch module is already loaded — importing it here registers nothing.)
_CHILD_CODE_HIDE = _CHILD_CODE + """
import ai_computer_control.tools.batch as _b
print("BATCHABLE=" + ",".join(sorted(_b._tool_map())))
print("HIDDEN=" + ",".join(d.get("hidden_tools", [])))
"""

_FAILURES: list[str] = []


def check(cond, msg):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {msg}")
    if not cond:
        _FAILURES.append(msg)


def run_child(env_extra=None, code=None):
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    env.pop("ACC_TOOLSETS", None)
    env.pop("ACC_HIDE_MEMORY", None)
    env.pop("ACC_HIDE_TOOLS", None)
    if env_extra:
        env.update(env_extra)
    r = subprocess.run([sys.executable, "-X", "utf8", "-c", code or _CHILD_CODE],
                       cwd=_ROOT, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120)
    count, names, stderr = -1, [], r.stderr or ""
    run_child.extra = {}
    for line in (r.stdout or "").splitlines():
        if line.startswith(("COUNT_AFTER_DIAG=", "REPORTED=", "LOAD_ERRORS=", "BATCHABLE=", "HIDDEN=")):
            k, _, v = line.partition("=")
            run_child.extra[k] = v
        elif line.startswith("COUNT="):
            count = int(line[6:])
        elif line.startswith("NAMES="):
            names = line[6:].split(",") if line[6:] else []
    return r.returncode, count, names, stderr


def main() -> int:
    print("== ACC_TOOLSETS 子集注册 ==")

    rc, count, names, _ = run_child()
    check(rc == 0 and count == 108, f"默认全开 108 件 (got rc={rc} count={count})")

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

    rc, count, names, _ = run_child({"ACC_TOOLSETS": "filesystem,shell"})
    check(rc == 0 and run_child.extra.get("COUNT_AFTER_DIAG") == "15",
          f"diagnostics() 不再注册工具: 调用后仍 15 件 (got {run_child.extra.get('COUNT_AFTER_DIAG')})")
    check(run_child.extra.get("REPORTED") == "15", "diagnostics 自报 tool_count 与实际一致")

    rc, count, names, err = run_child(code=_CHILD_CODE_BROKEN)
    check(rc == 0 and count >= 80, f"psutil 导入失败: 服务照常起来,其余工具照常注册 (rc={rc}, count={count})")
    check("run_command" in names and "read_file" in names and "launch_application" not in names,
          "无关工具(shell/filesystem)在,依赖 psutil 的 application 工具缺席")
    le = set(filter(None, run_child.extra.get("LOAD_ERRORS", "").split(",")))
    check({"application", "system"} <= le, f"diagnostics().load_errors 点名失败模块 (got {sorted(le)})")
    check("failed to load" in err and "psutil" in err.lower() or "_psutil_windows" in err,
          "失败在 stderr 留一行,不静默")

    rc, count, names, _ = run_child({"ACC_TOOLSETS": "memory,web,thinking", "ACC_HIDE_MEMORY": "1"})
    check(rc == 0 and "memory_save" not in names and "memory_read" not in names
          and {"fetch", "sequential_thinking"}.issubset(set(names)),
          f"Workbench can hide only the legacy ACC memory family after migration (got {count})")

    # ⑦ ACC_HIDE_TOOLS: exact-name hiding (spaces tolerated, unknown names ignored).
    rc, count, names, err = run_child({"ACC_HIDE_TOOLS": "run_command, screenshot,mouse_click,,no_such_tool"},
                                      code=_CHILD_CODE_HIDE)
    check(rc == 0 and count == 105, f"ACC_HIDE_TOOLS 摘掉 3 件已注册工具: 108 -> 105 (got rc={rc} count={count})")
    check(not {"run_command", "screenshot", "mouse_click"} & set(names)
          and {"read_document", "batch_actions", "screenshot_region", "ocr_image"}.issubset(set(names)),
          "点名的工具不在 tools/list,名单外的(含同模块的 screenshot_region)照常")
    batchable = set(filter(None, run_child.extra.get("BATCHABLE", "").split(",")))
    check(batchable and not {"run_command", "screenshot", "mouse_click"} & batchable and "read_file" in batchable,
          f"batch_actions 经实时注册表也转调不到被摘掉的工具 (batchable={len(batchable)})")
    check(run_child.extra.get("HIDDEN") == "mouse_click,run_command,screenshot",
          f"diagnostics().hidden_tools 如实报出且忽略未知名 (got {run_child.extra.get('HIDDEN')!r})")
    check(run_child.extra.get("REPORTED") == "105", "diagnostics 自报 tool_count 与摘掉后的实际一致")

    rc, count, names, _ = run_child({"ACC_HIDE_TOOLS": ""}, code=_CHILD_CODE_HIDE)
    check(rc == 0 and count == 108 and run_child.extra.get("HIDDEN") == "",
          f"ACC_HIDE_TOOLS 为空 = 什么都不摘 (got count={count} hidden={run_child.extra.get('HIDDEN')!r})")

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
