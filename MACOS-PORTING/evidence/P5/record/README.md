# P5-05 受控原生输入录制切片

2026-11-10，当前主机 macOS 27.0.1 arm64、Python 3.12.10、Node 24.15.0。`record_start(target)`、`record_stop(save_as?)`、`macro_list` 及 `macro_run(recording=..., target=...)` 已通过当前主机工程门与独立验收。P5 与 P5-05 继续进行中。

## 录制来源与边界

来源字段为 `controlled_native_requests`。原生 helper 记录同一 MCP worker 实际成功派发的文本、快捷键、点击、移动、拖拽与滚轮请求，组合工具的底层输入也进入同一缓冲。手动输入事件监听仍单列后续评估。中文保留原始 keyboard.text 的 body、paste 与 enters，临时 Cmd+V 的内部按键不会生成额外录制动作。

开始时必须提供当前活动窗口的完整 target。原生端验证进程出生身份、窗口引用、几何、AX 成员与焦点。录制上限为 1–300 秒、100 个动作及 48000 动作 JSON 字节。查询不进入动作列表。焦点、身份或几何变化，锁屏、辅助功能或事件发送撤权、安全输入、派发失败、期限或容量触顶会终止录制并保留明确原因。停止时返回 complete=false 的中断记录，持久化与重放拒绝该记录。

录制状态仅保存在自有原生 worker 内存。EOF、信号或 worker 退出后随进程释放，已有的输入释放与剪贴板恢复路径继续生效。录制期间允许观察，录制重放与新的 record_start 使用非阻塞互斥门覆盖整个异步重放生命周期。

## 重放

完整录制使用独立 recording 参数进入现有 macro_run。原有 steps 调用继续沿用工具注册表和默认 120ms 间隔。缺失两类输入均拒绝，显式 steps=[] 保留空宏行为。Windows 拒绝 Mac recording 参数。

重放先验证全部 schema、平台、坐标空间、来源、完整状态、操作及字段白名单、单调时间、字节量和步数。原生只读预检复用真实输入的快捷键与 Unicode 字素校验。无效后缀在首个输入之前拒绝。指针坐标使用窗口范围的半开边界。

调用方重新提供当前完整 target。应用 bundle 标识、解析后的 executable 路径与窗口尺寸必须匹配。窗口移动时按新旧原点平移全局逻辑点坐标，旧 private ref、PID 和出生身份不写入录制文件。每步继续执行已有的原生焦点、身份、几何与命中守卫。

原始文本以显式原剪贴板策略重放，尾部 Enter 拆为现有 press_key 调用。间隔取下个动作开始时间与前个动作结束时间之差，大于 0.3 秒时生成 wait，单次封顶五秒。录制默认额外延迟为零，显式 delay_ms 仍生效。每步派发前均真实让出异步事件循环，取消后停止后续输入，取消也释放录制互斥门。

## 内部文件

可选 save_as 只接受 1–80 字符的命名参数。文件写入内部 data/macros，目录 FD 使用 O_DIRECTORY 和 O_NOFOLLOW，随机临时文件以 O_EXCL 创建并使用 0600 权限。写入和文件同步后原子替换，再同步目录。所有临时清理结果均关闭目录 FD。失败响应保留完整录制，saved=null 表示保存结果未确认，宏列表可核对实际文件。

macro_list 返回至多 200 份有界 metadata。文件按目录 FD 打开，拒绝符号链接与非普通文件，以非阻塞 FD 读取至多 128001 字节并核对读取前后状态。旧 Windows 宏和损坏文件列为 invalid。save_as 沿用既有内部命名存储语义，未增加可写任意用户路径的工具。

## 当前主执行

- 录制真实 stdio E2E 23 项通过，覆盖六种语义动作、中文尾 Enter、临时剪贴板语义、保存/列表、窗口移动重绑、无效快捷键/Unicode 后缀、焦点、期限、真实安全输入、几何、容量与清理。[主执行](development/reviewed-live.txt)
- 真实 LaunchServices 如意 App 普通 HTTP 工具链 18 项通过，包含五动作录制、原子保存、新 target 重放、中文精确读回、平衡点击滚轮与剪贴板恢复。[App 主执行](development/app-reviewed.txt)
- 纯录制合约 24 项通过，包含取消、重放/录制互斥、跨平台和隐藏工具拒绝、半开坐标、全部动作校验、文件边界和失败清理。[纯合约](development/pure-final.txt)

## 开发失败与修复

首次纯测把正常工具错误封装误当作直接抛异常，六个非法名称子例因此失败。修正为通过公开工具封装检查错误结果，原非法输入及请求未消费断言保留。[初次纯测](development/pure-first.txt)

可读日志规范化时移除了第六行末尾一个空格，六个失败子例及其余内容完整保留。原始字节可由 Base64 文件精确还原，原始和规范化 SHA-256 分别记录在规范说明中。[原始字节](development/pure-first.raw.base64) [规范说明](development/log-normalization.json)

首轮真实执行暴露原生 complete 字段被装箱为 JSON 数字，以及工具模型把布尔时长转换为数字。完成字段改为显式 JSON 布尔，时长使用严格数字类型，原断言通过。[首轮](development/first-live.txt) [修复后](development/second-live.txt)

独立源码复核发现零额外延迟的同步输入序列缺少真实取消调度点、坏 Unicode 后缀缺少整段原生预检、宏参数缺失形状与保存失败时目录 FD 关闭边界。上述问题已修复并加入对应回归。后置目录同步失败以 saved=null 保留未确认保存状态。

第一次 App 录制运行在 Python 已改用 actions 预检字段而临时 helper 尚未重建的混合候选，原生端以 Unexpected recording field 拒绝重放，两个接收计数断言失败。完成相同源码 helper 重建后原断言通过。[混合候选失败](development/app-first.txt) [相同源码重建后](development/app-reviewed.txt)

## 后续环境门

实际 macOS 14、同候选 Windows 执行、物理多屏/非 Retina、正式签名与升级身份、真实 TCC 撤权和动作中锁屏、实际输入法切换继续保留。真实安全输入由自有夹具短时开启并释放，测试未切换用户输入源。当前录制来源为受控调用，手动输入监听尚未实现。历史 P5-02 剪贴板损失记录继续独立保留，本轮快照恢复只覆盖各次测试前的状态。

## 当前主机独立验收

二十一条测试命令各执行一次，十三组 Node E2E 共 303 项、八组 Python 共 127 项通过，零失败、零跳过、零自动重跑。94 份源码文档与 3 份产物每件前后及最终一致。五组 App 的 36、42、51、29、28 个创建身份均确认退出，额外受控路径残留为空，各次测试前剪贴板恢复断言通过。默认 helper 和 App 严格签名验证与 helper 状态探针通过。[独立报告](independent/report.json)

工程四门通过，语法 1149 文件、构建新鲜度、完整单元 2499 通过与 18 项既有跳过、静态 80/80、零 flaky、测试浏览器残留零。各门前后完整 97 项指纹一致。[工程记录](acceptance/engineering/results.json)

独立源码审查的四项发现全部关闭，Windows record 模块字节保持一致，通用 batch_actions/wait 入口及共享调度除新增取消检查点外的 AST 核对通过。验收后仅收口 README 中英文、TASKS、阶段文档与跟踪记录五份文档，功能源码和测试继续沿用执行候选。[源码审查](code-review.json) [最终交付指纹](source-fingerprint-final-delivery.json)

## 实施提交绑定

实施提交 `0585c5ca3ebd6682a2b0a7350c6c5f1434decfe6` 的 94 份完整原始 Git blob 共 10,935,192 字节，在提交后首次绑定快照中逐份匹配最终交付指纹和工作区字节。3 份运行产物指纹一致。[提交绑定](commit-binding.json)

独立复核再次完整读取该提交的 94 份 blob，核对当前工作区、3 份产物及 43 份关键证据均一致。[独立提交绑定](independent-commit-binding.json)
