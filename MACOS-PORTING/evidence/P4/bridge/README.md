# P4-02 受控系统桥与交互

2026-11-07，当前 macOS27.0.1 arm64 开发环境。实现及独立协议验收已完成，当前剩余真实文件/目录拖放补验。基线 `d97db57b`，修改保存在未提交工作树。

## 实现与验证

- 原生桥限制为精确来源的主 frame，校验版本、UUID、消息字段与大小。选择器支持并发拒绝、取消和 AbortSignal。
- 共享 `net.apiRaw` 接入原生选择器，覆盖域模块直接导入 `net.api` 的入口。普通浏览器与既有 Windows HTTP 入口继续由相同传输契约测试覆盖。
- 原生通知读取实际系统权限，授权回调与页面刷新有乱序保护，关闭通知的最新用户意图优先。
- Cmd-N、Cmd-O、Cmd-comma、菜单栏状态项、Finder 定位与已知编辑器通过 AppKit/LaunchServices 接入。外链限受信主 frame 的点击与固定协议白名单。

独立桥接 e2e 35 项、通知相关单元 31 项通过。已有编辑器回归 18 项通过。该批完整单元 2491 通过、18 跳过，静态 80/80 通过。[桥接](protocol-independent.txt) [相关单元](independent-unit.txt) [编辑器](editor-regression.txt) [工程门](fast-final.txt)

CUA 已实际确认中文文件夹与文件选择、Cmd-N/O/comma、Finder 选中目标对象、VS Code 展示 `answer = 42`、通知拒绝与系统设置状态。相应初次失败和修复记录保留。[界面记录](ui-progress.json)

## 启动回归失败与修复

独立宿主回归在 24 项通过后，LaunchServices 启动超时。tccd 记录 Node 的文稿目录访问归属开发 App，并指出缺少 `NSDocumentsFolderUsageDescription`。App 从文稿目录加载本地源码，Finder 启动的权限身份需要单独授权。[原失败](host-regression-first.txt) [TCC 记录](launchservices-tcc.txt)

已补访问用途、超时恢复指引，以及验收失败后的一次性正常退出。复跑中新增用途和失败退出检查通过，LaunchServices 就绪检查仍失败，其他已执行断言通过。失败后的 App 与服务正常退出，保留原失败判定。[复跑](host-after-tcc-fix.txt)

最终组合候选的独立宿主回归为 30 项通过、1 项失败，唯一失败仍为 `service_start_timeout`，App 与服务均已退出。该轮 TCC 日志确认责任归属及 AllFiles preflight，未再次捕获明确文稿授权提示，本轮超时原因仍需解锁后继续定位。[最终回归](host-combined-final.txt) [该轮 TCC](host-ls-tcc-final.txt)

## 当时待验事项（历史快照，最新状态见末节）

- Mac 手动解锁后，完成通知允许、拒绝恢复与实际投递。
- 菜单栏点击、安全外链正向打开及 IDE 实际双栏 Diff。
- 用户确认文稿访问授权后，完成真实 LaunchServices 授权与启动复验。
- 最终候选整包独立复跑及相关 Windows 阶段门。
- 路径别名收藏去重已通过本地增量修复和独立 50 项验收，包含存量重复、权限保留、特殊字符与异步选择。最终可见复验待解锁。[目录别名](workspace-alias/README.md)

正式签名身份、升级 Keychain/TCC 与 macOS14 实际运行按已有用户决定及阶段交接保留。P4-02 继续登记 `in_progress`。

## 2026-11-08 解锁后增量

用户已解锁并明确允许此次开发 App 文稿访问。TCC 记录文稿授权通过，LaunchServices 真实启动正常就绪并退出，独立宿主整件 31/31 通过。通知开关已由拒绝恢复为开启，原生桥返回 granted，系统日志确认验收通知投递并呈现横幅。原失败保留。[系统验收增量](unlocked-recovery/README.md)

后续检查 IDE Diff 时 Mac 再次锁屏，双栏 Diff、菜单栏、正向外链和物理录音继续待验。上文的解锁与文稿待授权描述为本次恢复前的状态。

## 最新可见交互结果

上述菜单、外链和Diff待验状态已有更新。用户辅助选择菜单“设置…”后，CUA确认面板及原生激活变化。真实WK外链交给默认Safari。正常差异API实际打开Code双栏41到42，截图经独立查看。短HOME避免旧夹具的IPC socket长度限制，临时Code辅助模式读取超时原记录保留。[真实差异](editor-diff/README.md) [菜单与外链](../lifecycle/physical-system/README.md)

当前冻结原生候选独立桥接47项通过，通知已允许使三个拒绝条件分支未执行，旧50项保留原候选归属。独立宿主31项通过。[当前工程验证](../current-candidate/README.md)

## V10拖放审计缺口

完整阶段审计尚未找到Finder到WK的真实文件或目录拖放记录。app.js已有正常文件附件与目录指纹解析路径，HTTP解析回归不足以验证DataTransfer/entry读取，后续分别实测文件附件及目录确认/取消、cwd和配置持久化。此项保留未验。
