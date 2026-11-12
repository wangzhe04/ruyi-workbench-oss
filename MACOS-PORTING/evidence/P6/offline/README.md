# P6-01 arm64 离线依赖与包布局

2026-11-12 开始。基线 `eee68512`，实施分支 `codex/p6-01-macos-offline`。当前主机 macOS27.0.1 arm64、开发 Node24.15.0；准备工具 Python3.14，包内独立 Python3.12.13。此工作包交付自包含 Full/Slim 开发候选，正式签名、公证、干净用户安装、最低系统实际运行及升级回退不计为本包已验。

## 实现

- App 从自身 Resources/workbench 定位程序与 Node，不读取开发源码根；开发宿主入口继续保留。
- Node24.15.0、ripgrep15.1.0、独立 CPython3.12.13、Chromium156.0.8078.4/revision1248、64项运行 wheels 和2项构建 wheels 的版本、上游来源及 hash 锁定。准备器显式联网，装配器只读资产缓存、离线构建并安装当前 ACC wheel。
- Full 非 editable ACC 与 Office/图表/视觉/Playwright、完整 arm64 Chromium 随包；Slim 不含这些依赖，能力清单相应区分。无官方 Agent CLI、Git、用户配置或模型权重。
- 原生文件审计验证 arm64、最低部署声明及实际入口对应的动态库/rpath闭包；Python、浏览器与第三方依赖许可随包。
- 完整性清单包含每项文件字节、模式、相对链接及源码指纹；拒绝损坏、额外/缺失文件和外部链接。候选仍为 ad-hoc，未公证。

使用说明见 [OFFLINE-PACKAGING.md](../../../../ruyi-workbench/desktop-macos/OFFLINE-PACKAGING.md)。

## 开发与修复证据

[代码独立复核](code-review.json)记录九项发现及处理；实际源码绑定以该报告时间和最终候选的完整 manifest 为准。缺库、错误 executable/rpath 上下文、系统路径前缀逃逸、超时/非零退出后同组后代、App 根外部链接及构建环境污染分别修正并加入回归。准备器的 [六项负控制](review-probes/prepare-negative.json)和原始失败探针保留。

实包发现工作台 MCP 代理 EOF 后桥接进程不退出，已修复为停止接收新消息、排空已接收请求并关闭桥；未使用强制退出掩盖子进程。独立纯 Node 回归验证已完成调用及真实在途调用的 EOF，两场景14项通过；[第一次独立执行](mcp-eof-independent-first.txt)、[当前源码复验](mcp-eof-current.txt)分别归档。

旧宿主回归另发现相对 `RUYI_HOME` 被传入 P5 执行账本而违反其绝对路径要求。[诊断](relative-service-diagnostic.txt)保留；数据根统一 resolve 后，[真实搬移启动](runtime-start-final.txt)与[宿主第三轮32项](development-host-third.txt)通过。前两轮的 relative/LaunchServices 失败不删除。LaunchServices 成功使用临时目录下有逐文件 hash 绑定的同字节程序快照，排除了新 ad-hoc 身份访问真实 Documents 的依赖；不宣称 Documents 授权恢复或正式安装验收通过。

早期实包测试还保留 `/var` 与 `/private/var` 比较误判、空 `PLAYWRIGHT_NODEJS_PATH` 夹具错误、EOF 超时及原生审计对 dylib 自身 ID/括号文件名的误判。对应原始日志均在本目录，不把失败轮次计为通过。

## 已完成的开发验证

- 从全部本地缓存在不带 `--download` 的模式下重新准备资产；五组件目录摘要及66个 wheel逐项匹配锁，未复用开发 venv。
- [Full第五轮候选](development-candidate.json)的[真实实包专项](acceptance-full-third.txt)19项通过：复制到中文/空格/emoji路径、只读载荷、sandbox实际拒绝源码/开发依赖目录和公网、实际 Node/Python/rg 来源、相对 console入口、五类文档写读和检查点、真实 Chromium、本地页面、EOF、实际 AppKit/WKWebView与载荷不变。该开发候选早于相对数据根修正，最终提交绑定候选另记，不扩大历史证据。
- [完整工程门](fast-final.txt)单元2638通过、18既有跳过；静态首轮79/80，唯一失败为新增 EOF fixture 的扫描清册/显式 env 展开登记；[定向修复复验](fixture-final.txt)通过，其余79范围未变，不声称另有一次完整80/80运行。
- [语法检查](syntax-final.txt)及构建新鲜度通过；路由/模块契约按实际生成并验证。额外 CLI发现、Python监督探针、Windows overlay拒绝边界均有本目录日志。

## 最终候选

固定提交下的 Full/Slim 候选及独立实包复验仍待登记。完成时更新本节、TASKS.json 与执行看板；不会因已有开发验证而跳过最终候选绑定。

首次固定 `d46d1469` 的禁公网构建在 lipo 180秒超时后真实失败并回收自有组，未发布输出，[日志](build-full-final.txt)保留。后续[四个最小对照](lipo-sandbox-controls.txt)均成功，未确认唯一根因。审计工具随后改为先用 xcrun 解析真实工具路径再传递 fd，减少选择器移交；独立增量复核通过，[相关11项](unit-native-tool-selection.txt)通过。最终候选必须绑定后续修正提交重新构建，不将失败轮次改写为成功。

`b33d1c6a` 的 Full/Slim 已在仓库外禁公网构建，独立功能分别19/7项通过、ZIP解压完整性通过；这些作为中间候选保留。独立对原文稿路径额外原生审计再次超时并确认自有组回收，[记录](independent-original-path-audit.json)明确第一次工具选择器调整并未消除问题。随后[同一最终二进制对照](lipo-final-path-controls.txt)稳定复现：真实工具使用普通文件路径成功、`/dev/fd/3`超时。现已移除描述符入口：普通路径直接检查，括号路径用私有无括号同字节别名，跨卷复制需 hash 核对，rpath仍按原路径解析。修正后的[原文稿目录209项检查](native-original-path-fixed.txt)通过。最终交付只绑定这次修正后的提交，前述失败和中间候选均不覆盖。

## 保留边界

本包不是 P6 整阶段验收。正式 Developer ID/公证/Gatekeeper、分发来源首次启动、干净标准用户、正式身份的 Keychain/TCC、macOS14实际运行、同候选 Windows实机/CI、升级/回退与 P5 原未验环境门继续按原计划保留。未修改系统防护、网络、登录项或真实用户配置。
