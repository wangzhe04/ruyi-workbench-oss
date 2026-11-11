# 当前源码的选定应用场景补验

已按 `5e246343` 的运行源码、`76248e2b` 的执行 HEAD 补验既有选定场景，独立三组共 **74 项**通过，各执行一次，0 fail/skip/retry。P5 与 P5-03 仍为 `in_progress`。没有修改产品或原有应用夹具源码，也没有重复旧 350 条全部核心套件。[独立聚合](independent-v1/aggregate-v2.json) · [源码绑定](current-source-binding.json) · [独立绑定](independent-source-binding.json)。

| 场景 | 独立结果与边界 |
|---|---|
| TextEdit + 默认 CFT AX | 31 项。TextEdit 自有文档中文/emoji 多行 AXValue、Cmd+S 与磁盘精确读回；CFT 原生地址栏 AXValue 与 URL 读回、默认页面树缺失提示；已有粘贴、可信点击、双轴滚轮、同几何歧义拒绝及清理断言保留。[独立报告](independent-v1/acceptance-review.json) |
| TextEdit + renderer CFT AX | 33 项。隔离实例启用 `--force-renderer-accessibility=complete` 后可观察 AXWebArea；页面 AXValue/AXPress 仍因双向成员关系校验返回 `element_stale`，DOM 值和事件计数不变。这是明确的不支持行为验收，没有将 renderer 操作改成成功。[独立报告](independent-v1/acceptance-review.json) |
| Finder | 10 项。无已有内容窗口的基线、精确两个自有内容 URL/无额外 tab、四项归属负控；AXPress 后由独立原生 AXValue 确认视图改变，仅关闭重新证明归属的测试窗口，共享 Finder PID 692 前后保持。[Finder 独立报告](independent-v1/finder-acceptance-review.json) |

应用版本为 TextEdit 1.21、CFT 148.0.7778.96、Finder 27.0/build1865，均是当前主机的限定场景。各测试实际编译临时原生 helper，不直接执行默认 raw `1cc945…`。旁路只读观测壳在夹具删除临时目录前将签名通过的实际 helper 复制到 Git 外，并保留原路径、raw hash、签名和完整 Mach-O 比较结果。各份仅排 UUID 16 字节及尾部签名分配区 848 字节后，其余全部字节与默认 helper 相同，normalized hash 为 `8b1819c2…`。这不是 raw binary 或 TCC identity 相同的声明。

106 份实际原生源/header、Python、后端运行产物、构建脚本和夹具来源，在六个成功场景的前后共 12 份列表逐项一致，且与 `5e246343`、仅增加文档证据的 `76248e2b` 原始 Git blob/OID 和当前工作文件一致。旧应用场景的 AX 叶层历史证据保持有效；本次在含后续公共输入/会话改动的新 helper 上实际运行这三个场景，取消/录制专项沿用各自已绑定报告，不将旧 helper `a5d755…` 直接视为新 helper。

观测壳只观察和复制自有临时产物，不注入输入或关闭窗口。根进程出生身份固定；完整 TextEdit fixture tag 与命令前后相同的 birth 才计入观察。采样可能遗漏瞬时或已重挂的进程，因此只声明已采样身份退出，夹具的独立 ownership、MCP/native、剪贴板与 profile 清理收据另列。源码与四项产物前后摘要、比较器原始输出及失败终局报告均保留。[观测壳源码审查](observer-code-review-v1.json)。

实施者默认 31、renderer 33 通过后，首次 Finder 在创建目录和构建 automation helper 前被有界探针拒绝：现有用户 Finder 内容窗口的树超过 1000 节点上限。只读浅层诊断确认一个已有 AXWindow；代理未关闭它。用户选择自行关闭后，再次只读诊断确认仅桌面 AXScrollArea 和五个无标题/offscreen 内部窗口，主执行 Finder-v2 10 项通过，之后独立 Finder 首跑 10 项通过。原拒绝保留，不称开发全过程零失败或源码修复。[首次拒绝](development/finder-v1/output.txt) · [浅层诊断](development/finder-baseline-diagnostic/shallow-baseline.json) · [用户回应后基线](development/finder-baseline-diagnostic/after-user-response.json) · [实施者聚合](development/report.json)。

本次没有新的 App LaunchServices、实际 TCC 撤权、动作中系统锁屏、物理显示器/macOS14/Windows 或正式身份验收。Chromium renderer 约束以及其他 P5 剩余门继续保留。
