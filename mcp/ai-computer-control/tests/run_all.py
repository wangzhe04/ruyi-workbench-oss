#!/usr/bin/env python
"""Unified entry for all ACC smoke tests (zero-dependency, stdlib only).

第46波46d: 11 个 smoke_*.py 此前无统一入口(E6),发版靠人肉逐跑。本脚本逐个以子进程跑
(与手工 `python tests/smoke_xx.py` 完全同构),汇总通过/失败,任一失败退出码 1。
刻意不用 pytest:ACC 主打离线部署,stdlib 方案零安装即可在任何环境(含离线包)跑,
门禁语义不打折。需要 pytest 生态时可平行再包一层,本入口是事实源。

用法:
    python -X utf8 tests/run_all.py           # 全量
    python -X utf8 tests/run_all.py --ci      # CI 子集(无显示依赖的件)
    python -X utf8 tests/run_all.py smoke_registry smoke_stdio   # 指定件
"""
import os
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_VENV_PY = os.path.join(_ROOT, ".venv", "Scripts", "python.exe")
# 优先用仓库 venv(依赖已装),不在则用当前解释器(离线包/CI setup-python 场景)。
PYTHON = _VENV_PY if os.path.exists(_VENV_PY) else sys.executable

# CI(windows runner, 无真实显示会话)只跑确认无显示依赖的件;本地全量。
# 判定依据:import pyautogui 即需要显示会话(windows runner 有虚拟桌面,pyautogui 可用,
# 但 OCR/UIA 依赖具体窗口/字体渲染,实测后再放行)。smoke_registry/stdio/async_contracts
# 经本地与 CI 双验证为纯协议/注册表面,稳定。
CI_SUBSET = ("smoke_registry", "smoke_stdio", "smoke_async_contracts", "smoke_toolsets", "smoke_descriptions")

TIMEOUT_S = 300


def discover():
    names = []
    for f in sorted(os.listdir(_HERE)):
        if f.startswith("smoke_") and f.endswith(".py"):
            names.append(f[:-3])
    return names


def run_one(name):
    script = os.path.join(_HERE, name + ".py")
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    t0 = time.time()
    try:
        r = subprocess.run(
            [PYTHON, "-X", "utf8", script],
            cwd=_ROOT, env=env, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=TIMEOUT_S,
        )
        return name, r.returncode == 0, time.time() - t0, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or "") if isinstance(e.stdout, str) else ""
        return name, False, time.time() - t0, out + "\n[TIMEOUT >%ds]" % TIMEOUT_S


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("-")]
    ci_mode = "--ci" in sys.argv
    if argv:
        names = argv
    elif ci_mode:
        names = [n for n in discover() if n in CI_SUBSET]
    else:
        names = discover()
    print("# ACC smoke runner (stdlib, zero-dep)")
    print("# python: %s" % PYTHON)
    print("# pieces: %d%s" % (len(names), " (CI subset)" if ci_mode else ""))
    fails = []
    for i, n in enumerate(names, 1):
        print("(%d/%d) %s ... " % (i, len(names), n), end="", flush=True)
        name, ok, ms, out = run_one(n)
        print("%s (%.1fs)" % ("PASS" if ok else "FAIL", ms))
        if not ok:
            fails.append((name, out))
    print("\n# summary: %d pass / %d fail / %d ran" % (len(names) - len(fails), len(fails), len(names)))
    for name, out in fails:
        tail = "\n".join((out or "").splitlines()[-25:])
        print("\n=== %s FAIL tail ===\n%s" % (name, tail))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
