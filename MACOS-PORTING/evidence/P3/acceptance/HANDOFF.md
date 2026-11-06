# P3 剩余阶段验收交接

2026-11-07。四包 Mac 本地实现/逐包验收已完成；当前候选 `e8445972`（最终生产实现 `2f45aba4`），分支 `codex/p3-macos-documents`。后续仅补充交接/部署目标审计时，运行方仍须记录实际完整 HEAD SHA，不把旧候选结果冒充新候选。

## Windows 同候选回归

用户已授权推送与创建fork内草稿PR。GitHub Desktop已发布候选 `e8445972f2961b2dbcf430fc4e1c8fbc0c8b65cd`，并创建 [PR #1](https://github.com/Sonata17inD/ruyi-workbench-mac/pull/1)，目标为该fork的master；未合并或创建upstream PR。fork master仍为 `6e31c1f8468554e9da8419c7a79e6fd7c66fa1ae`。

首轮本候选 [e2e CI](https://github.com/Sonata17inD/ruyi-workbench-mac/actions/runs/42293298968)：Linux static与Windows release dry-run通过，Windows ACC smoke在CI子集失败，Windows e2e在credential IPC smoke失败，后续单元/完整e2e跳过。另一个 [平台基线CI](https://github.com/Sonata17inD/ruyi-workbench-mac/actions/runs/42293298887)的Windows子集失败；macos-14 job取消，注解为 `The configuration 'macos-14-arm64-us-default' is not supported`，未运行测试。上述失败待读取具体日志归因并修复，不能登记Windows通过。

日志读取暂待用户解锁Mac（公开日志API403，连接器诊断不可用）。期间独立复现并以 `fecd3262` 修复新增浏览器测试的宿主路径夹具：POSIX/ntpath模拟均通过、真实Mac 8/8通过，无生产修改；尚未推送、未确认远端ACC完整根因。步骤快照与复核见 [首轮Windows记录](windows-e844/README.md)。

该旧 P2 [CI](https://github.com/Sonata17inD/ruyi-workbench-mac/actions/runs/42187345469)的 ACC smoke、Linux static、Windows release dryrun 通过；Windows e2e 在凭据 IPC smoke 失败，后续完整单元和 e2e 未跑。它既不是 P3 候选，也不是 Windows 整套绿灯。新失败须以同一失败项和实际日志归因；不能因基线失败就自动豁免 P3。

后续沿用此草稿PR补充修复与回归，不更新master、不合并、不向upstream新建PR。每轮记录实际head SHA与运行ID；不把e844的检查冒充后续提交的验证。CLI Git凭据不可用时继续用已登录的GitHub Desktop正常发布，不读取或输出token。不要把Mac上的Windows模拟断言当作实机。

Windows runner 使用 Node24/Python3.12，保持独立检出/用户配置隔离，串行运行：

1. 现有 Windows e2e workflow：syntax、build freshness、凭据 IPC、完整单元、默认完整 e2e、失败日志；另外 ACC CI subset + tools事实对账及 Windows release dryrun。记录所有 skipped 与 failure，不只截取绿色子任务。
2. 为受本轮改动影响的可选依赖另做准备：ACC 安装 `browser,pptx,charts,pdf-export` extras；准备对应 Playwright 浏览器。准备阶段可下载，离线执行阶段不得下载。不要使用 Mac arm64 wheel 锁安装 Windows。
3. 在隔离 HOME/USERPROFILE/APPDATA/LOCALAPPDATA 和 WCW_DATA_DIR 的子进程中运行 ACC `smoke_office_v2`、`smoke_office_read_v2`、`smoke_v192_chart_types`、`smoke_browser_runtime`，保留每项实际通过/跳过。`smoke_browser_runtime` 的真实 Mac launcher 取消探针在 Windows 会跳过，不能记为 Windows 真实浏览器生命周期通过。
4. 相关 Node 专项：`playbooks.e2e.js`、`capabilities.e2e.js`、`acc-capability-gates.e2e.js`、`playbook-skill-tools.e2e.js`、`browser-mcp.static.e2e.js`、`checkpoint-coverage.e2e.js`，沿用仓库 HOME 隔离件。Mac-only件跳过不构成 Windows 功能验证。
5. 记录候选SHA、OS/架构、Node/Python、依赖版本、命令、退出码、原始日志、真实失败/skip与修复复测。独立复核剩余发现与 Windows 新失败处理后，再决定 P3 整体验收，不自动登记 M1。

## macOS14 与发行边界

P0 决策 O2 要求按 macOS14 目标审查 wheels，并在后续对应真实系统/runner执行。当前实际系统为 macOS27.0.1 arm64；wheel标签、Mach-O最低部署版本或编译target都不能证明已经在14运行。补验 `d95cce74` 已完成64个wheel与完整Chromium的98个arm64二进制声明审计（最高14.0），并验证无ffmpeg/headless-shell缓存的26项真实浏览器测试；原缓存可选ffmpeg声明15.0，负向证据保留。详见 [最低部署审计](minimum/README.md)。该结果不覆盖系统符号或Python/Node完整发行闭包。正式签名、干净机离线闭包仍按P4/P6原计划验收。

默认有界面浏览器用户可见交互未验证；已有真实浏览器测试使用隔离的headless受控本地页面。Mac桌面/OCR待P5，废纸篓能力待P6。尚不称为正式 Mac 离线安装包。
