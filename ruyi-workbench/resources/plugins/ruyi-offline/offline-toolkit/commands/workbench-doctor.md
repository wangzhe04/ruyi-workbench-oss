---
name: 工作台体检
description: 运行本地工作台体检命令并总结结果
---

平台分支：下面 EXE / PowerShell 例子只适用于 Windows。macOS 源码环境在 ruyi-workbench 中执行 node app/server.js doctor --human（shell_run 或 script_run 的 bash/Node 路径）；使用自己的隔离数据目录，不把 Mac 结果当成 Windows 验收或正式安装包证明。

# Workbench Doctor

Run the local workbench health check and summarize the result.

Inside a workbench session the most direct check is the `workbench_self_status` tool with `section: "health"` (`section: "identity"` adds version, install location, and data folder).

From a terminal, run doctor in the extracted offline package folder. Plain `doctor` prints only environment JSON; add `--human` for the readable health check:

```powershell
.\Ruyi.exe doctor --human
```

A package without `Ruyi.exe` (source runner) uses its bundled Node instead:

```powershell
.\runtime\node\node.exe .\app\server.js doctor --human
```

Summarize every item that is not OK together with its suggested next step. From the command line, desktop control may show "preparing" only because its capability probe has not run yet; that alone is not a fault.

`workbench_self_status` is a Ruyi Workbench MCP tool (in Claude Code: `mcp__ruyi__workbench_self_status`); without it, use the commands above.
