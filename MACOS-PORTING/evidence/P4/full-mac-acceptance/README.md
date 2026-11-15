# P4 Mac 完整功能验收

2026-11-08，按用户“停止防休眠，完整验收P4 Mac端”执行。范围为当前 macOS27.0.1 arm64 开发 App 的 P4 四包。Windows、正式签名身份与 macOS14 实机继续按既有决定保留待验。

## 本轮执行

已停止本任务的 `caffeinate` 进程 6773，确认进程及其显示器、系统空闲防休眠断言消失。其他应用与系统断言按实测记录。[电源状态](power-state.json)

首发修正后的最终主轮串行运行 16 组专项，最终 630 项通过、0 失败。完整单元 2491 通过、18 既有跳过、0 失败，静态 80 组通过，语法 1134 文件与构建新鲜度通过。[逐件结果](validation.json) [工程命令及退出码](fixed-runs.json) [环境与签名](environment.json)

| 范围 | 本轮主轮通过项 |
|---|---:|
| AppKit/WK 宿主 | 31 |
| 系统桥与工作区，包括新增取消状态补验 | 53 |
| WK 合成媒体 | 36 |
| 生命周期与自有进程树 | 23 |
| 工作区解析 | 38 |
| ASR 转写 / 预热 | 41 / 34 |
| 服务端 SSE | 51 |
| 浏览器事件流 / 重放 / pageshow | 39 / 24 / 11 |
| 浏览器语音 / 流式 / 预热 | 98 / 39 / 58 |
| 语音设置 / 词库 | 32 / 22 |

## 新增取消补验

在真实 WK 完整页面向已绑定的 `document.body` 分发明确为 `isTrusted=false` 的目录事件。目录条目仅由夹具提供，正常页面处理器读取独特子文件指纹，经真实 HTTP 解析出目标并展示确认框。显式选定的当前会话原 cwd、默认目录、近期目录与目标不同。检查目标路径及未勾选默认选项，点击实际“取消”后，会话、完整服务端有效配置和前端状态均与前快照一致。没有 selectedPath 解析、会话/配置写入及发送。App 退出后再次核对会话 cwd 与完整稀疏配置投影。[原生报告](bridge-fixed-report.json)

这次自动化补验与之前用户辅助的真实 Finder 入口分别记录。原真实取消操作没有即时的当前会话 cwd 前快照，该历史局限继续保留。[真实拖放独立证据](../bridge/native-drop/review.json)

## 失败与修正

首次 19 条工程及专项命令中，三组浏览器事件流件未取得 CDP 页面目标。补齐现有浏览器夹具已使用的 Darwin 测试钥匙串隔离启动参数后，三件均可进入页面。语音媒体通过范围使用已安装 CFT148，Chrome156 原生假音源挂起继续保留，具体原因尚未确认。

重放件随后出现 20 通过、4 失败，在未改生产及测试源码的 `d97db57b` 隔离基线同样复现。夹具在启动暂态 classic 属性下提前返回，未执行明确的工作台视角选择，导致后续前提失效。修改为点击真实分段钮并等待视角/动画完成，选会话也同时核对视角。原 B/D/E 断言全部保留，最终 24 项通过。临时基线工作树已正常移除。[基线结果](event-stream-replay-baseline.json) [基线日志](event-stream-replay-baseline.txt) [原候选失败](event-stream-replay.browser-retest.txt) [最终通过](replay-final.txt)

取消补验开发中，页面状态断言已通过，外层检查先后遇到 JSON 键顺序及磁盘稀疏配置与 API 默认值展开表示不同的问题。最终复用 `normalizeConfig(..., { inferExplicit: false }).persisted` 和结构化比较。两轮原失败日志保留。[首次](bridge-cancel-main-first.txt) [第二轮](macos-desktop-bridge-retest.txt) [最终通过](bridge-final.txt)

## 独立验收发现的首发在场修正

独立 client 首次复跑为 37 通过、1 失败，首个 SSE 参数为临时 classic，页面随后落到 steward。保留默认动画，包装第一次真实 View Transition 并延迟其更新回调 800ms，可稳定复现旧实现的 A8 失败。负对照全程 37 通过、2 失败，另含 C1 的三次轮询计数。负对照源码和实际 SHA 单独归档，最终探针只改 A8c 文案以准确描述覆盖前提。[负对照](pending-transition-negative.json) [原日志](client-pending-transition-negative.txt)

生产修正只让组合根的 SSE 视角提供者复用既有 `shellModeController.intendedShellMode()`，报告在飞意图或落地值。DOM 写者及真实视角过渡沿用原控制器，`app.js` 仍为 1279 行。新增 A8c 断言首发发生在真实过渡待完成期间，原 A8/A8b 及后续存在性、性能、重放断言保留。最终冻结候选全量专项与工程重跑见[修正后运行](fixed-runs.json)。

## 候选绑定与复用范围

原生产实现基线为 `0e9d5edb`。本轮修改四个既有验收文件，并修正前端 SSE 首发视角参数的一处表达式，相关注释同步更新。冻结 App 六项构建输入与当前源码匹配，严格开发签名验证通过。53 项实现及相关用例指纹单独记录，历史指纹和原测试归属保留。[本轮源码指纹](source-fingerprint.json)

真实文件/目录拖放、通知拒绝恢复、Finder/选择器/快捷键、菜单设置、Code Diff、Safari 外链、647.5ms 物理 PCM、临时登录项注册后注销及一次短时睡眠/SSE，复用同冻结 App 的既有独立证据。本轮没有再次采集物理音频、修改系统通知授权、注册登录项或触发系统睡眠。具体来源与原范围见[结构化验收](validation.json)。

真实麦克风拒绝重试证据仍限 WebKit 来源层，OS TCC 拒绝恢复未验。物理睡眠仍仅短周期且该夹具调度关闭，长时/深睡与同周期物理调度补偿未验。本轮授权状态下，通知三个拒绝条件分支未执行。Windows、正式身份与 macOS14 实机均未记为通过。

## 独立验收

独立复核者在最终生产修正后串行复跑八件，client39、host31、bridge53、media36、lifecycle23、replay24、pageshow11、workspace38，共 255 项通过、0 失败，八件均自然退出0。每件53项源码指纹无漂移，观察到的自有进程创建身份均已消失。[独立执行](independent-fixed-runs.json) [最终复核](review.json)原始系统、终端和界面文本保留原始空白，源码及撰写文件的空白检查单独记录。
