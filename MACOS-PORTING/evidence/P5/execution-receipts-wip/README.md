# P5 桌面执行回执阶段记录

核心提交 `f671a004` 与原生捕获/OCR 后续提交 `b7930bde` 均已集成，`RUYI_DESKTOP_EXECUTION_RECEIPTS` 默认关闭。P5 整体仍进行中。

核心阶段 f671a004 支持真实主回合与活跃主回合下的正回合前台 Provider 子代理：精确运行身份、实际 ACC 派发关联、逐结果与图片历史严格保存，以及不确定执行的持久屏障。该核心阶段当时的原生回执验证等待与鼠标位置查询，图片交付测试使用固定 PNG；后续真实捕获/Vision范围见下文 b7930bde。

[核心阶段独立验收](evidence/independent-foreground-subagent-v1/report.json) 的13条命令全部通过，零失败、跳过或重试；122份源码和3份产物共26次前后绑定一致。[源码审查](evidence/foreground-subagent-source-review-v3.json)与[累计生产覆盖](evidence/foreground-subagent-review-coverage-v1.json)保留范围及发现处理。默认关闭兼容的5组85项通过。

[当前状态](current-state.json)记录源码归档、证据索引、先前失败及下一阶段；历史 checkpoint、freeze、报告和原10项本地/4项外部要求全部保留。核心历史归档保存122份源码与3份产物，当前原生切片归档保存125份源码与4份产物精确字节；不能将哈希清单当作功能通过。

后台/API0/恢复/CLI与手工API准入、完整子代理transcript重启回放、历史reconciliation、ACK及全局容量回收、balanced输入正常链、held故障与原环境门仍开放。该核心阶段后的原生捕获/OCR已按下述切片补验，继续保持默认关闭。自动锁屏原idleTime为300，目前0；待P5整体验收后恢复，并只停止确认身份的自有保持唤醒进程。

原生捕获/OCR 后续切片已在 `b7930bde` 集成，仍默认关闭；源码候选 `56c970cf`。 [冻结源码审查](evidence/native-capture-source-review-v2.json)与[独立运行报告](evidence/independent-native-capture-v1/report.json)分别限定125源码/4产物及18命令的实际范围。实际自有窗口、Vision、普通小图节点保存复开和选定Stop/存储/大图拒绝通过；没有输入投递或held资格。 [设计14场景的证明等级](evidence/native-capture-source-review-v2.json)明确 forced callback 与长OCR仍为源码证明，不把选定当前主机场景当作所有环境/功能通过。最新下一步为审查后的 balanced-only 原生输入正常链与独立救援准备，完整剩余范围以 current-state.json 为准。
