# P5 桌面执行回执阶段记录

当前实现提交 `f671a00461450b3b144fb6fd93b52badb4141b80` 已集成，`RUYI_DESKTOP_EXECUTION_RECEIPTS` 默认关闭。P5 整体仍进行中。

本切片支持真实主回合与活跃主回合下的正回合前台 Provider 子代理：精确运行身份、实际 ACC 派发关联、逐结果与图片历史严格保存，以及不确定执行的持久屏障。实际原生回执目前验证等待与鼠标位置查询；图片交付测试使用固定 PNG。

[独立验收](evidence/independent-foreground-subagent-v1/report.json) 的13条命令全部通过，零失败、跳过或重试；122份源码和3份产物共26次前后绑定一致。[源码审查](evidence/foreground-subagent-source-review-v3.json)与[累计生产覆盖](evidence/foreground-subagent-review-coverage-v1.json)保留范围及发现处理。默认关闭兼容的5组85项通过。

[当前状态](current-state.json)记录源码归档、证据索引、先前失败及下一阶段；历史 checkpoint、freeze、报告和原10项本地/4项外部要求全部保留。源码归档保存122份源码与3份产物精确字节，不能将哈希清单当作功能通过。

后台/API0/恢复/CLI与手工API准入、真实截图/OCR回执、完整子代理transcript重启回放、历史reconciliation、ACK及全局容量回收、held故障与原环境门仍开放。下一步补真实原生捕获与OCR，继续保持默认关闭。自动锁屏原idleTime为300，目前0；待P5整体验收后恢复，并只停止确认身份的自有保持唤醒进程。
