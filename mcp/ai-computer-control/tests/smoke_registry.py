"""Registration smoke test: import the server and assert the FastMCP tool registry looks right.

Run with UTF-8 to avoid Windows GBK console failures:
    python -X utf8 tests/smoke_registry.py
or  set PYTHONIOENCODING=utf-8 && python tests/smoke_registry.py

Exits non-zero on any failed assertion.
"""

import os
import sys

# Make `src/` importable when run from the repo root without installing.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_ROOT, "src"))

import ai_computer_control.server as server  # noqa: E402

# Tools that MUST be present (baseline + v1.3 additions).
_EXPECTED = {
    # baseline / earlier iterations
    "screenshot", "mouse_click", "type_text", "press_key", "hotkey", "get_clipboard",
    "set_clipboard", "list_windows", "focus_window", "launch_application", "kill_process",
    "read_file", "write_file", "delete_file", "move_file", "copy_file", "run_command",
    "get_system_info", "list_monitors", "get_dpi_info", "get_pixel_color", "batch_actions",
    "macro_run", "ui_inspect", "ui_find", "ui_invoke", "ocr_screen", "ocr_click",
    "find_template", "mouse_drag", "mouse_scroll",
    # v1.3
    "diagnostics", "version_info", "safety_info", "audit_tail", "window_screenshot",
    "ocr_find_text", "vision_click", "wait_for_pixel", "scroll_at",
    # v1.4
    "observe", "act_and_verify", "record_start", "record_stop", "macro_list",
    # v1.5
    "write_pdf",
    # v1.6 Office 模板驱动
    "excel_beautify", "excel_chart", "write_pptx", "chart_image",
    # v1.8 补齐盲操作痛点: 结构化读表 / 分页读 PDF / 图片信息+缩放
    "excel_read", "pdf_read_pages", "image_info", "image_resize",
}


def main() -> int:
    tools = server.mcp._tool_manager.list_tools()
    names = {t.name for t in tools}

    print(f"server VERSION = {server.VERSION}")
    print(f"registered tool count = {len(names)}")

    failures = []

    # 1) version bumped
    if server.VERSION != "1.8.0":
        failures.append(f"VERSION expected 1.8.0, got {server.VERSION}")

    # 2) exact count (v1.5 was 89; +4 v1.6 Office tools = 93; v1.7 upgrades existing, no new = 93;
    #    v1.8 adds 4 read/image tools = 97: excel_read, pdf_read_pages, image_info, image_resize)
    if len(names) != 97:
        failures.append(f"tool count {len(names)} != expected 97 (v1.8: +excel_read/pdf_read_pages/image_info/image_resize)")

    # 3) all expected tools present
    missing = sorted(_EXPECTED - names)
    if missing:
        failures.append(f"missing expected tools: {missing}")

    # 4) every tool has a non-empty description (F9)
    no_desc = sorted(t.name for t in tools if not (t.description or "").strip())
    if no_desc:
        failures.append(f"tools missing description: {no_desc}")

    # 5) no duplicate names
    if len(names) != len(tools):
        failures.append("duplicate tool names detected")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print("  -", f)
        return 1

    print("\nOK: all registry assertions passed.")
    print("v1.4 new tools present:", sorted(n for n in names if n in {
        "observe", "act_and_verify", "record_start", "record_stop", "macro_list"}))
    print("v1.5 new tools present:", sorted(n for n in names if n in {"write_pdf"}))
    print("v1.6 new tools present:", sorted(n for n in names if n in {
        "excel_beautify", "excel_chart", "write_pptx", "chart_image"}))
    print("v1.8 new tools present:", sorted(n for n in names if n in {
        "excel_read", "pdf_read_pages", "image_info", "image_resize"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
