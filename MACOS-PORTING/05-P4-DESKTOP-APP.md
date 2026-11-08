# P4：Mac 桌面壳

状态：已按用户批准的当前 Mac 范围完成四包开发与独立验收；Windows 后续待验，正式身份暂缓，macOS14 实际运行交接 O2/P6 · 前置：P2, P3 · 基础工作量：**10–16 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

## 目标

将已验证的浏览器工作台封装成独立 Mac App，补系统交互和稳定的后台生命周期。

## 入口条件

前置阶段已验收或明确仅开展不依赖其结果的探针；读取架构约定和当前基线。开始时核对源码变化，复用现有函数和测试，不根据旧行号盲改。

## 涉及文件与调用链

- [`ruyi-workbench/desktop/RuyiDesktop.cs`](../ruyi-workbench/desktop/RuyiDesktop.cs)
- [`ruyi-workbench/app/public/js/quiet-card.js`](../ruyi-workbench/app/public/js/quiet-card.js)
- [`ruyi-workbench/app/public/js/notify-policy.js`](../ruyi-workbench/app/public/js/notify-policy.js)
- [`ruyi-workbench/app/public/js/composer-voice.js`](../ruyi-workbench/app/public/js/composer-voice.js)
- [`ruyi-workbench/app/public/js/app-frame.js`](../ruyi-workbench/app/public/js/app-frame.js)
- [`ruyi-workbench/app/public/js/onboarding-wizard.js`](../ruyi-workbench/app/public/js/onboarding-wizard.js)
- [`ruyi-workbench/app/src/04-desktop-shell.js`](../ruyi-workbench/app/src/04-desktop-shell.js)
- [`ruyi-workbench/app/src/13-http-router.js`](../ruyi-workbench/app/src/13-http-router.js)

## 工作包与推荐顺序

同阶段工作包按下表顺序推进；已冻结接口下可分工，但共享源文件的改动需串行集成。

| ID | 工作包 | 人日 | 具体交付 |
|---|---|---:|---|
| P4-01 | App 宿主与服务管理 | 3–5 | 新增拟议 desktop-macos 宿主；窗口/WebView、单实例、Node 启动/健康、错误页面、窗口状态；按 P0 结论选一种技术栈。 |
| P4-02 | 受控系统桥与交互 | 2–3 | 原生文件选择器、Finder/编辑器、菜单栏、通知、Cmd 快捷键与安全的 URL 打开；验证页面来源/消息 schema。 |
| P4-03 | 麦克风与媒体兼容 | 2–3 | 按 WebView 实际能力选择录音格式或 PCM；测试授权、拒绝、重试、语音流式路径和资源释放，保留 ASR 协议与词库。 |
| P4-04 | 生命周期与签名身份复验 | 3–5 | 关闭窗口/退出/登录启动的明确设置；睡眠唤醒、调度恢复、MCP/CLI 回收；用拟发行身份验证 Keychain/TCC，提前准备签名。 |

## 阶段验收

2026-11-08 用户确认“本轮按 Mac 范围收尾，Windows 保留后续待验”。P4 及四包按当前 macOS27.0.1 arm64 开发 App 范围完成，以下记录区分本轮通过项与后续待验项。

- [x] 当前主机 V10 及开发身份范围通过，Finder 启动和终端启动找到受控运行依赖。
- [x] 关闭窗口与退出应用行为明确，退出后自有服务回收，默认关闭登录启动。
- [x] 普通浏览器入口回归通过，浏览器媒体通过范围为 CFT148，远程导航无法获取宿主执行桥。
- [x] 通知拒绝恢复、麦克风授权与有效短录音通过，麦克风真实拒绝重试证据限于 WebKit 来源层。
- [x] 构建新鲜度与代码契约通过，独立复核发现均已处理。
- [x] TASKS.json 与执行看板已登记范围、提交 SHA、日志及已知限制。
- [ ] V07 正式身份下的 Keychain/TCC 与升级访问复验，按用户决定暂缓并交接 P6。
- [ ] V14 Windows 同候选回归，按用户决定排除本轮，保留后续待验。
- [ ] macOS14 实际运行，按 O2/P6 交接继续待验。

原始系统日志与界面文本保留尾空白和末尾空行。源码及撰写文档的空白检查通过，完整证据范围的检查仍报告原始文本告警。证据提交批处理在告警后继续提交，后续收尾保留该记录及原始字节。[收尾检查范围](evidence/P4/local-closeout.json)

## 回退与失败处理

保留浏览器入口作为可用回退。宿主缓存与业务数据分离；回滚 App 不重置 Keychain 或会话数据，不自动恢复旧登录项。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。

## P1交接（2026-11-03）

P4-02/V10承接Finder实际窗口与选中对象的可见实机验收。P1已验证打开协议、鉴权、路径及受控启动布局；当前Finder自动化非交互预检为-1744，待本阶段取得相应权限后执行可见验收。证据见 [P1收尾记录](evidence/P1/closeout/README.md)。

## 2026-11-07 本地实施

P4-01 的真实 AppKit/WKWebView 宿主、受控服务管理、窗口状态与失败恢复已完成当前 Mac 范围的独立验收。默认入口和独立重跑各 27 项通过，完整单元 2491 通过、18 跳过，静态 80/80 通过，独立复核剩余发现为 0。下一包 P4-02。[P4-01 证据](evidence/P4/host/README.md)

用户明确选择先完成本地开发与独立验收，正式身份复验保留待办。当前使用开发 bundle ID 与 ad-hoc 身份，正式签名身份下的 Keychain/TCC、升级访问继续交接 P4-04/P6。macOS14 实际运行和相关 Windows 回归按既有阶段关口登记。

P4-02 桥接独立 35 项通过，Finder 可见选中对象已验证。通知允许恢复、菜单栏、外链与真实 IDE Diff 等待解锁后补验。早期宿主回归的 TCC 日志发现文稿目录用途说明缺失，已补用途说明和失败正常退出。最新 LaunchServices 启动仍超时，该轮未再次捕获明确文稿提示，待解锁后继续定位。[P4-02 证据](evidence/P4/bridge/README.md)

P4-03 已实现能力驱动录音格式、真实 MIME 回退、Mac 麦克风拒绝指引及资源回收修复。实际 WKWebView 合成音源覆盖 MP4/WAV、流式 PCM、拒绝重试、停止取消、初始化失败清理与解码中取消。物理麦克风权限及最长 3 秒短录音已获用户授权，等待手动解锁。[P4-03 证据](evidence/P4/media/README.md)

P4-04 已补可选登录启动、按数据根保存的关窗行为，以及暂停采集、唤醒服务复验和 SSE 恢复。组合候选独立生命周期 23 项、媒体 36 项、桥接 35 项通过。宿主回归 30 通过、LaunchServices 启动 1 项失败；真实系统睡眠、登录注册及系统权限仍待验。正式身份复验继续按用户决定暂缓。[P4-04 证据](evidence/P4/lifecycle/README.md)

后续目录别名增量已完成本地开发与独立 50 项验收，覆盖存量收藏去重、权威权限保留、真实特殊字符路径与已有会话 cwd 落盘、64 位目录身份和异步选择竞态。完整单元 2491 通过、18 跳过，静态 80/80。旧工作区解析件的 37/1 结果在独立 HEAD 基线同样复现，测试按平台路径契约修正后主代理与独立复跑各 38 项通过。原失败记录已归档。界面工具再次确认 Mac 锁屏，待手动解锁后继续可见验收。[目录别名增量](evidence/P4/bridge/workspace-alias/README.md)

2026-11-08 用户解锁并允许此次开发 App 文稿访问。真实 LaunchServices 启动与独立宿主31项通过，通知拒绝后恢复、系统投递与横幅呈现已有证据。检查真实编辑器差异窗口时再次锁屏，剩余可见验收继续保留。[解锁增量](evidence/P4/bridge/unlocked-recovery/README.md)

## 2026-11-08 交互与系统增量

本节更新此前锁屏待验快照。真实通知拒绝恢复、文稿授权及LaunchServices启动、Finder定位已通过。菜单设置动作由用户点击并由CUA及原生激活记录核对，真实WK外链由默认Safari打开，正常差异API在真实Code显示41到42的双栏比较。临时登录项已注册、在系统设置确认并取消，最终状态0。真实睡眠一次为约2.816秒Software Sleep/DarkWake，醒后原页面重新连通SSE并自动显示新增线程。深睡、长时间挂起与该物理周期的调度补偿仍未验证。[编辑器](evidence/P4/bridge/editor-diff/README.md) [系统交互](evidence/P4/lifecycle/physical-system/README.md)

当前冻结原生候选独立宿主31、媒体36、生命周期23、桥接47项通过，桥接本轮三个拒绝条件分支未执行。完整单元2491通过/18跳过、静态80/80、语法1134文件通过。已安装CFT148下完整语音98、流式39、预热58项独立通过，Chrome156原生采集等待仍保留。[候选验证](evidence/P4/current-candidate/README.md) [浏览器范围](evidence/P4/media/native-gum-stages/README.md)

首次真实麦克风WAV为1.01秒，转写成功且未自动发送，但原生结束边界严格判定失败。改进观察与停止保护后的LaunchServices实机候选正在等待系统授权处理，P4-03保持进行中。正式身份复验继续按用户决定暂缓，相关Windows及macOS14阶段门尚未通过。[物理麦克风](evidence/P4/media/physical/README.md)

随后验收专用原生停止观察与物理探针按公开WebKit停止完成语义修正。新候选媒体36、生命周期23、桥接47项独立通过，宿主30/1，TCC确认新ad-hoc代码要求与旧文稿授权不匹配并重新提示。旧候选31项宿主通过保留原归属；新候选等待解锁授权复跑，物理录音尚未通过。[新候选真实状态](evidence/P4/media/physical/reporting-delay/README.md)

## 全项收尾审计增量

独立逐项审计确认V10还缺真实Finder到WKWebView的文件与目录拖放证据。现有目录指纹HTTP解析测试不覆盖原生DataTransfer、entry权限和读取链路，需分别核对附件/本地上传与零发送，以及目录确认或取消、session cwd和配置落盘。此项尚未据静态源码认定存在实现缺陷。最新候选物理录音、授权后宿主复跑及最终证据绑定继续待办。正式身份用户暂缓，macOS14和P4同候选Windows保持未验收。

2026-11-08 当前原生停止回调修正候选已完成独立物理验收。真实LS麦克风取得647.5ms有效非零16kHz单声道16bit WAV，轨道1110ms结束、同run原生停止完成1417.118ms，独立保护未触发、最终none且无待完成stop。假ASR回填一次、发送0，App/Node正常回收。授权后同冻结宿主独立31/0通过。P4-03本地范围登记done，P4-02剩余真实拖放及阶段外部门继续保留。[独立复核](evidence/P4/media/physical/reporting-delay/review.json)

## 当前 Mac 本地交付收尾

2026-11-08，P4四个工作包在macOS27.0.1 arm64开发环境完成本地开发与独立验收。真实拖放由用户辅助操作，取得3个文件、3个目录的可信事件，正常上传和目录解析均成功，当前会话cwd及近期工作区已落盘，测试App、后端与临时窗口已回收。取消由用户报告和事件/提交数量及源码支持，取消前当前会话cwd快照缺失的局限保留。[原生拖放与独立复核](evidence/P4/bridge/native-drop/README.md)

最新独立宿主31、媒体36、生命周期23、桥接47、工作区解析38通过；单元2491通过/18跳过、静态80、语法1134文件与构建新鲜度通过。旧失败和候选指纹按原归属保留，CFT148的浏览器成功范围与Chrome156挂起继续区分。正式身份按用户决定暂缓，相关Windows同候选回归和macOS14实际运行维持未验。[本地收尾清单](evidence/P4/local-closeout.json)

## 用户批准的 Mac 范围最终收尾

2026-11-08 用户确认本轮按 Mac 范围收尾，Windows 保留后续待验。P4 及四包登记 done，实现提交 `0e9d5edb7b68e4cac8540654a5c8021bf59bd0eb`，证据提交 `f5c5d4c5`，分支 `codex/p4-macos-desktop`。本节及上方阶段验收更新此前历史快照中的进行中状态。正式身份、macOS14 实际运行和 Windows 同候选均保持未验收，真实拖放取消快照缺失、短时睡眠范围、CFT148/Chrome156 差异及通知条件分支限制继续保留。[最终范围复核](evidence/P4/final-scope-review.json)
