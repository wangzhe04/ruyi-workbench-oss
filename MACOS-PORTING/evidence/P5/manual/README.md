# P5 手动示范录制切片

状态：严格模式 `0d054b04b7cd7d97fe163ca7177c165a38020693` 和用户确认的标准鼠标投影 `1500b82b9d8ee54f285d1b316d87067a7b430c52` 已分别提交、独立验收并完成提交绑定。P5 仍为 `in_progress`。严格模式冻结源为 [v6 清单](development/sequence/current-source-v6.json)，34 份文件；[严格提交绑定](commit-binding.json)与[独立绑定复核](independent-commit-binding.json)保留当时产物范围。标准投影在其后新增 16 份变更，当前主机实体“你好”与触控板拖拽已保存并回放，[标准模式完整记录](standard-mouse/README.md)保留明确的投影范围、独立自动验收和真人来源审查。

`record_start` 保留默认 `controlled_native_requests`，新增 `native_window_events`，在一个已绑定、保持前台的精确窗口内监听输入。默认 exact 模式的手动来源保存 schema 2，受控来源仍为 schema 1；两者严格配对。显式 standard_mouse 手动模式保存 schema 3，见上方标准模式完整记录。`input_sequence` 与 `macro_run` 保留原始键码、左右修饰键、按下/抬起、重复、必要 Unicode override、输入源和时间，以及普通鼠标/触控板鼠标路径、点击次数、多轴滚动和阶段。

每组最多 5 秒、512 事件、48000 JSON 字节；每次录制最多 300 秒、100 动作、48000 动作字节。首个输入前预检完整录制和所有平移后的指针点，执行中重复核对焦点、目标、权限及输入源。指针应保持在窗口范围内。tablet、multitouch、Force Touch 压力阶段不在本切片范围。下述为 exact 严格模式的规则：无法重建的指针关联语义使录制变为 incomplete，不能保存为成功示范。普通 mouse-touch subtype 3 被显式保存与重建。

协作取消使用独立线程和完成收据，写入边界与取消原子化；真实已派发状态进入 ACC 审计。原生输入清理仅移除已确认释放的自有项，失败时保留 pending 并拒绝新 mutation。信号和 stdin EOF 独立于主线程 AX 阻塞释放输入。EOF watcher 初始化失败在接收 frame 前退出，运行期错误有确定的失败退出和期限。

## 验证记录

| 候选/场景 | 结果与边界 |
|---|---|
| v3 离线 | [36 场景报告](independent-offline-v3/report.json)：Python 166；单元 2499/18 既有跳过；静态 80/7 实弹跳过；语法 1151、构建新鲜度通过。仅覆盖 v3。 |
| v3 GUI 与 App | [GUI v5](development/sequence/gui-v5.txt) 75 项、[App v1](development/app-manual-v1.txt) 17 项通过。App 由 LaunchServices 启动已授权宿主，显式运行候选 server。示范输入来自独立 MCP 合成事件，不能算实体用户示范。 |
| 异常收尾 | [direct](development/sequence/cleanup-fault-direct-v1.txt) 与 [nested](development/sequence/cleanup-fault-nested-v1.txt) 各仅 1 项故意注入 FAIL；随后 receiver/HID 平衡、四份 MCP 树及输入源/剪贴板恢复通过。它们是预期失败测试。 |
| v4 离线 | [54 场景报告](independent-offline-v4/report.json)：新增 pointer subtype 20 个重建/拒绝 case、15 种 native/Python 字段值一致；Python 167 与工程四门通过。压力值 0.5 的验收脚本假设被系统量化读回证据纠正，原中断记录保留，无已执行命令重跑。 |
| v4 GUI | [GUI v6](development/sequence/gui-v6.txt)：新增 subtype 3 click/drag/up/move，经真实 target tap 捕获并回放通过。 |
| 实体 v1 | [原始记录](development/physical-v1/report.json)：用户实体输入“你好”和拖拽到达；非零指针 subtype 被拒绝，未保存。不能算通过。 |
| 实体 v2 | [原始记录](development/physical-v2/report.json)：实际 mouse subtype 为 3；文本有末尾换行，controller 严格文本条件未及时结束，之后指针越出窗口，录制拒绝，最终超时。不能算通过。 |
| 实体 v3 | [原始记录](development/physical-v3/report.json)：实体“你好”和拖拽到达；按键后的无按钮悬停先越界，严格录制结束为 `point_outside_target`。原始按钮事件的 association mask 为 17179869254，含 Pressure 设备能力位；即使不先越界，这些按钮事件仍超出严格模式。不能算通过。 |
| 压力关联 guard 开发 | AppKit 对 MouseMoved 的 `associatedEventsMask` 访问抛异常，[诊断](development/sequence/pressure-guard-native-v1-error.json) 保留。已限制 button events 读取该字段，异常明确拒绝；[修订后原生 50 case](development/sequence/pressure-guard-native-v3.json) 及 pressure association 拒绝通过。该日志不替代 v5 独立验收。 |
| v5 独立离线 | [54 场景报告](independent-offline-v5/report.json)：native subtype 50/50 与 pressure association 拒绝、15 种字段值一致；Python 167、工程四门通过。testing-only JSON number 1 与 Python `is True` 的脚本期望差异被纠正，保留中断，未重复已执行命令。 |
| v6 最终严格子集 | [源码复核](code-review-v6.json)、[工程与 v5 逐字复用绑定](independent-offline-v6/report.json)、[独立 GUI/App](independent-gui-v6/report.json)完成。GUI 78 项、App 17 项均独立首跑通过；完整单元 2499/18 既有跳过、静态 80/7 实弹跳过、语法 1151 与构建通过。native/Python 明确按 33 份未变源码及 v5 产物复用，未重复执行。 |

早期 GUI v2 发现 Darwin `poll(events=0)` 不能可靠观察 pipe EOF，随后改为独立 kqueue。失败后的已知自有 Shift/left 状态按精确签名与当前坐标恢复；[恢复源及收据](development/sequence/eof-recovery/ruyi-p5-eof-owned-recovery.log) 保留，恢复动作不再执行。它不证明找回历史剪贴板内容。

开发 GUI v7 在嵌套取消等待 held 收据时超时，清理通过但根因未定。v6 增加 pending 请求的实际返回与最终审计收据后，主执行 GUI v8 通过；这是一次显式诊断复跑，不能称开发全过程零重跑或据此认定旧超时原因。独立 v6 的 GUI/App 各自仅执行一次。

严格切片当时从主仓提交源重建的默认 helper raw SHA 为 `29f180b6708a22e2f43c436387d69ca6066aac1a954f31472c71ea3855691f4e`，与独立 helper `7e600a4f...` 不同。三份完整 Mach-O 在仅排除 UUID 16 字节及签名分配区 848 字节后逐字一致，各自严格签名通过；签名区含结构化 Superblob 826 字节和尾部 22 字节。[比较器与范围](helper-build-equivalence.json)和独立绑定报告保留精确的历史边界，不把它称为 raw identity 或默认 helper 新增 GUI 验收。标准投影更新后的当前产物另见其绑定；App executable/build.json 始终保持原产物，未重新签名。

2026-11-11 用户明确选择“支持标准点击和拖拽，压力手势明确不支持”。`standard_mouse` 以 schema 3 的 profile 和 replay_scope 标明键盘/标准鼠标投影；原始 association mask 只作来源信息，不代表被重放。压力手势、stage 1/2 遥测和依赖压力的应用状态不在该投影内，也不承诺自动检测所有压力手势。该功能已提交 `1500b82b`，独立 GUI 88 项、App exact 17 项、App standard 19 项通过；170 项 Python 和工程门按 v1/v2 逐字绑定明确复用。真人主执行通过，独立来源核验与自动执行分别标明，不互称对方执行。

## 独立性与剩余范围

源码由 `/root/p5_review_resumed` 独立复核，离线验收由 `/root/p5_acceptance` 执行。主执行的 GUI/App/实体证据与独立离线证据分别标明，不能互称对方执行。历史开发失败和因测试环境/脚本错误中断的记录保留，不以最终通过覆盖。

本切片不关闭正常审批 allow/deny/cancel、真实 session/turn 图片文件检查点与 rollback、实际 TCC 撤权恢复、动作中系统锁屏、当前候选选定应用重新绑定、物理多屏/non-Retina、macOS 14、同候选 Windows 和正式签名发行门。完整原范围继续见 [剩余需求审计](../remaining-audit.json)。用户此前的 P3/P4 Windows 范围决定不自动适用于 P5。

按用户要求，测试期间屏幕保护程序闲置时间设为 0，并运行 12 小时 `caffeinate -d -i -u`；这些设置不代替实际解锁。已授权的 App 不因本切片测试重新签名，测试使用 `--workbench-root` 指向候选源码。
