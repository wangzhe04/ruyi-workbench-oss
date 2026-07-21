"""Description-convention audit + lock — v1.9 (49d, 03 Phase B #2).

工具 description 就是提示词面:审 107 件的 docstring 是否具备
  (a) 非空首行(一句话干嘛);
  (b) Args: 段(有参数的件);
  (c) 新约定标记「何时用 / 何时别用」(v1.9 起新工具必须遵守)。

输出全量覆盖率报告;【硬锁】v1.9 新 7 件 + read_document(收敛标注)必须符合新约定,
其余件的覆盖率以报告呈现(全量改造按 03 Phase B 后续波推进,不在本锁内强转)。

Run with UTF-8:  python -X utf8 tests/smoke_descriptions.py
"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))

import ai_computer_control.server as server  # noqa: E402

_FAILURES: list[str] = []

# v1.9 起必须遵守「何时用/何时别用」约定的件(新工具 + 本轮收敛标注的 read_document)。
_CONVENTION_REQUIRED = {
    "edit_file", "fetch", "memory_save", "memory_read", "memory_list", "memory_delete",
    "sequential_thinking", "read_document",
}


def main() -> int:
    tools = server.mcp._tool_manager.list_tools()
    total = 0
    have_args_doc = 0
    have_convention = 0
    missing_args_doc = []
    legacy_no_convention = []

    for t in tools:
        total += 1
        desc = (t.description or "").strip()
        name = t.name
        if not desc:
            _FAILURES.append(f"{name}: description 为空")
            continue
        has_args = "args:" in desc.lower()
        # 参数数>0 的件应有 Args 段(FastMCP description 来自 docstring 首段+全文的拼接,
        # 这里直接查全文标记)。
        try:
            import inspect
            n_params = len([p for p in inspect.signature(t.fn).parameters.values()
                            if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)])
        except (TypeError, ValueError):
            n_params = 0
        if n_params > 0 and has_args:
            have_args_doc += 1
        elif n_params > 0:
            missing_args_doc.append(name)
        conv = ("何时用" in desc and "何时别用" in desc)
        if conv:
            have_convention += 1
        elif name in _CONVENTION_REQUIRED:
            _FAILURES.append(f"{name}: 缺「何时用/何时别用」约定(v1.9 起硬要求)")
        else:
            legacy_no_convention.append(name)

    print(f"# description 审计: {total} 件")
    print(f"#   Args 段覆盖: {have_args_doc}/{total - len([t for t in tools if True])} "
          f"(缺: {len(missing_args_doc)})")
    print(f"#   新约定(何时用/别用)覆盖: {have_convention}/{total}")
    if missing_args_doc:
        print("#   缺 Args 段(存量, 后续波改造): " + ", ".join(sorted(missing_args_doc)))
    if legacy_no_convention:
        print(f"#   未上新约定(存量 {len(legacy_no_convention)} 件, 报告不强制): "
              + ", ".join(sorted(legacy_no_convention)[:12]) + (" ..." if len(legacy_no_convention) > 12 else ""))

    # 硬锁:v1.9 约定件必须全部带标记 + 非空
    for name in sorted(_CONVENTION_REQUIRED):
        t = next((x for x in tools if x.name == name), None)
        if t is None:
            _FAILURES.append(f"{name}: 约定件未注册")
        elif not (t.description or "").strip():
            _FAILURES.append(f"{name}: description 为空")

    print()
    if _FAILURES:
        print(f"FAILED: {len(_FAILURES)} assertion(s)")
        for f in _FAILURES:
            print("  -", f)
        print("ACC-DESCRIPTIONS AUDIT: FAIL")
        return 1
    print("ACC-DESCRIPTIONS AUDIT: ALL PASS (硬锁 8 件约定合规)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
