---
name: Office 自动化
description: 离线处理 Word/Excel/PPT/CSV/PDF 与 COM 自动化
---

# Office Automation

Use this skill for offline Windows Office work: Word, Excel, PowerPoint, CSV, PDF handoff, and COM automation.

Recommended approach:

1. Inspect files with `file_list` and `file_read` first.
2. Use `office_open` to open a document for visual/manual review.
3. Use `script_run` with PowerShell for COM automation when Office is installed.
4. Use Python scripts for CSV, JSON, text reports, and non-Office formats.
5. Write generated outputs into the project workspace or `%USERPROFILE%\.win-claude-workbench\generated`.

PowerShell COM examples:

```powershell
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $true
$wb = $excel.Workbooks.Open("C:\path\book.xlsx")
```

Always close or save Office COM objects deliberately when running unattended scripts.
