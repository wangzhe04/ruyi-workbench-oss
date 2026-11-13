# P1 执行入口分类

2026-11-03，HEAD 0a430880 的未提交工作区。依据当前 app/src 的 child_process 导入、spawn/exec 调用及调用者逐项检查。源码指纹保存在 execution-entry-hashes.json。最终交付 SHA 仍待登记。

| 类别 | 入口 | Mac 处理 |
|---|---|---|
| 通用受管执行 | 01h ProcessRuntime start/spawn/capture/probe/probeSync | 固定 native helper 及 v2 监督协议；执行、输出和清理结果分开确认 |
| 引导内部命令 | 01g ServerOwnership | 固定 /bin/pwd 与 /usr/bin/lockf，用于路径和内核锁；不执行用户命令 |
| helper 自检与兼容清理 | 01h helperCapability、04 killPosixChildTree | 固定 helper 能力探针；旧 ChildProcess 清理需真实对象和内核父身份，裸 PID 拒绝 |
| Claude/Kimi/子代理 | 05、05b、07 的 CLI 启动 | ProcessRuntime.spawn，携带 owner；Kimi 模型发现的 13 HTTP 分支也已接入 |
| MCP/toolbox | 04 permission runtime、04f toolbox | ProcessRuntime.spawn 登记与停止 |
| 一次性及常驻 shell | 04 DesktopShell、11 shell 会话 | ProcessRuntime.start/spawn，Mac 默认 bash，显式语言保持，私有协议与取消收尾 |
| Git/worktree | 11 runGit、07 gitExec | Mac capture，worktree 经延迟 hooks 复用受管 Git |
| 文档/媒体 | 11c document、11d MediaInspection | Mac capture/spawn；旧 execFile/spawn 仅留在非 Mac 分支 |
| rg/运行时探针 | 11 搜索、01 配置探针 | Mac capture、probe、probeSync；异步 Python import probe 使用 capture |
| 宿主委托 | 00 spawnDetachedChecked、03 launchCodeEditor、04/12 文件浏览器、05b 已授权网址、13 路由 | 文件和默认浏览器使用 /usr/bin/open 完成语义与 5 秒 launcher 预算；代码编辑器沿既有显式宿主委托策略，Kimi 已授权 HTTP(S) 网址复用浏览器入口 |
| Windows 专用 | 01 resolveClaudeLauncher、01j LocalSecretCrypto、03 windowsRegistryString、04 Windows 清理及 reveal、06 sampleProcessRss | platform 分支阻止 Mac 执行 Windows CLI、DPAPI、注册表及 tasklist |
| Windows overlay | 13c 更新路由 | Mac 入口返回 platform_unsupported；鉴权保持，阻止 PowerShell 和解压/写入执行 |
| 旧端口恢复工具 | 13 pidsOnPort/processImage/processCommandLine/freeStalePort | 当前产品源码没有 freeStalePort 的生产调用点；保留定义和测试兼容，不作为 Mac 启动恢复路径 |

检查同时覆盖 require('child_process') 和 require('node:child_process')。04j 的 child_process 文本仅为命名注释，不是执行入口。DesktopShell 经 ProcessRuntime.start，不能仅搜索 cp.spawn 来判定覆盖。

## 证据边界

表中分类来自当前源码分支及现有对应专项。当前未发现需要再接入监督的可达 Mac 用户命令入口。此结论需绑定最终交付源码，并由冻结版本 V03/V04 回归补齐。不同模块的受管执行、宿主委托与固定内部命令各自保留其既定完成语义。

observed-only 与单 helper 故障模型持续适用。Windows 分支保留不等同于 Windows 实机通过。未知归属 socket 保守拒绝符合已冻结边界。

独立复核者 `/root/ownership_review` 已核对入口分类和原有 18 份指纹，并建议补全代码编辑器及 Kimi 已授权网址委托。建议已落实，另补入 12-tool-dispatch 指纹。
