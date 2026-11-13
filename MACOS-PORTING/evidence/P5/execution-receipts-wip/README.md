# P5 桌面执行回执阶段记录

核心提交 `f671a004`、原生捕获/OCR 后续提交 `b7930bde` 与正常输入验收切片 `2d3d725e` 均已集成，`RUYI_DESKTOP_EXECUTION_RECEIPTS` 默认关闭。P5 整体仍进行中。

核心阶段 f671a004 支持真实主回合与活跃主回合下的正回合前台 Provider 子代理：精确运行身份、实际 ACC 派发关联、逐结果与图片历史严格保存，以及不确定执行的持久屏障。该核心阶段当时的原生回执验证等待与鼠标位置查询，图片交付测试使用固定 PNG；后续真实捕获/Vision范围见下文 b7930bde。

[核心阶段独立验收](evidence/independent-foreground-subagent-v1/report.json) 的13条命令全部通过，零失败、跳过或重试；122份源码和3份产物共26次前后绑定一致。[源码审查](evidence/foreground-subagent-source-review-v3.json)与[累计生产覆盖](evidence/foreground-subagent-review-coverage-v1.json)保留范围及发现处理。默认关闭兼容的5组85项通过。

[当前状态](current-state.json)记录源码归档、证据索引、先前失败及下一阶段；历史 checkpoint、freeze、报告和原10项本地/4项外部要求全部保留。核心历史归档保存122份源码与3份产物，原生捕获切片归档保存125份源码与4份产物精确字节；当前正常输入验收归档保存127份源码与4份指定产物，接收器从冻结源码另行编译并保存实际字节；不能将哈希清单当作功能通过。

后台/API0/恢复/CLI与手工API准入、完整子代理transcript重启回放、历史reconciliation、ACK及全局容量回收、更广输入与held故障、原环境门仍开放；选定的balanced普通正常链已按下文独立验收。该核心阶段后的原生捕获/OCR已按下述切片补验，继续保持默认关闭。自动锁屏原idleTime为300，目前0；待P5整体验收后恢复，并只停止确认身份的自有保持唤醒进程。

原生捕获/OCR 后续切片已在 `b7930bde` 集成，仍默认关闭；源码候选 `56c970cf`。 [冻结源码审查](evidence/native-capture-source-review-v2.json)与[独立运行报告](evidence/independent-native-capture-v1/report.json)分别限定125源码/4产物及18命令的实际范围。实际自有窗口、Vision、普通小图节点保存复开和选定Stop/存储/大图拒绝通过；没有输入投递或held资格。 [设计14场景的证明等级](evidence/native-capture-source-review-v2.json)明确 forced callback 与长OCR仍为源码证明，不把选定当前主机场景当作所有环境/功能通过。该捕获切片之后的正常输入补验见下文；完整剩余范围以 current-state.json 为准。

正常输入回执验收切片 `2d3d725e`（候选 `f1feed3f`）只新增测试设施与清册，未改生产运行逻辑，仍默认关闭。[源码审查](evidence/root-input-harness-source-review-v4.json)、[接收器审查](evidence/balanced-input-window-source-review-v3.json)、[独立运行](evidence/independent-balanced-input-v1/report.json)及[双提交绑定](evidence/independent-balanced-input-v1/postqualification-commit-binding.json)分别记录范围。独立仅运行一次，51项通过，零失败/跳过/重试；真实默认审批允许一组中键按下/松开，拒绝与待审批取消零输入。实际worker与接收器来源、回执和保存历史、步骤0不可逆记录/事项API、跨回合聚合与冷重启不重放均通过。指定127源码/4产物前后匹配；独立编译的接收器与开发运行字节相同。40,000微秒是请求里的计划相对偏移，独立实际CG间隔28.221708毫秒，不声称40毫秒时序保证。

最终工程单元2626通过/18既有跳过、静态80通过/14明确live跳过、语法1180/0与构建新鲜度通过。首次就绪检查误将原生整数1当作布尔true拒绝，发生于GUI/输入前；静态清册首次漏增377→378而失败，现严格计数已独立复核；原日志和最终冻结重跑均保留。当前[下一步](evidence/next-implementation-plan-v12.json)为真实独立后台/API0/恢复工作流的版本化准入与历史持久化，随后继续CLI及其余原要求。本轮没有主动输入中断、held/强杀/救援、App身份或完整P5资格；不会无人值守撤权或故意锁屏，也不重复实体示范。

失败后停止新派发、保留未确认的armed观察窗口等分支，本轮仅完成源码审查；实际运行验证的是回合已结束且输入中立后的正常清理，没有演练主动输入故障或未确认活状态。工程记录保留8次前后校验的差异列表；完整131行的两份前后快照来自独立运行。
