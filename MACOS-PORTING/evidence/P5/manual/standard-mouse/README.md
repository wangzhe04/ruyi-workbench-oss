# 标准鼠标投影与实体示范

状态：当前主机选定范围验收通过，实现 `1500b82b9d8ee54f285d1b316d87067a7b430c52`，parent 为严格模式实现 `0d054b04`；P5 整体仍为 `in_progress`。[提交绑定](commit-binding.json)与[独立提交绑定](independent-commit-binding.json)核对 34 份来源、16 份实际变更和 3 份核心产物。

用户明确选择“支持标准点击和拖拽，压力手势明确不支持”。普通触控板按下也会携带 Pressure 设备能力位，因此不能将它称为原硬件事件保真重放。调用 `record_start(source='native_window_events', pointer_profile='standard_mouse')` 生成 schema 3，同时要求 `pointer_profile='standard_mouse'` 与 `replay_scope='keyboard_and_standard_mouse'`。完成只表示这一选定投影完整；压力手势、stage 1/2 遥测、多点触摸原始手势、tablet 及压力驱动应用状态均不在范围，也不承诺自动检测所有压力手势。

保存/派发指针行使用 subtype 0，按下/拖动的鼠标按钮 pressure 为 1，抬起/移动为 0。`source_subtype` 和 `associated_events_mask` 仅作来源信息，不被写回设备属性。全部行及 profile 在首输入前预检，schema 1 不能借 action 覆盖根级 exact；受控录制遇显式标准投影调用会将录制标为 incomplete，调用本身仍按其显式参数执行。默认受控来源/schema 1 与手动 exact/schema 2 兼容保留。

标准投影忽略窗口外无按钮按下的悬停。已记录按钮 ownership 或 combined 按钮 0–2 中任一按下时不得忽略；drag/down/up 仍检查每点命中并拒绝越界。前台、PID/window 身份、几何和输入源门保持有效。

| 证据 | 结果与独立性 |
|---|---|
| [v1 源码复核](code-review-v1.json) / [v2 最终复核](code-review-v2.json) | schema1/profile 降级和原始 pressure/subtype 未归一化两项已修；启动前缺源收据可能误报 unchanged 的 P3 亦闭合。无未关闭具体源码 finding。审查者未执行 GUI。 |
| [v1 独立离线](independent-offline-v1/report.json) | 87 场景各一次；exact 50、projection 20 case 匹配；56 组 native/Python 字段一致；11 个 schema/兼容/降级案例及 3 个原生整段 action override 拒绝。Python 170/0 skip。语法 1151、构建新鲜度、单元 2499/18 既有跳过、静态 80/7 实弹跳过通过。 |
| [v2 最终独立桌面](independent-final-v2/report.json) | GUI 88、App exact 17、App standard 19 各一次，0 fail/skip/retry。exact 保存 schema2，standard 保存 schema3；记录目录、重放、真实 audit、输入/源/观察到的进程清理通过。v2 只变诊断/断言 JS，33 份 runtime/fixture 源不变，native/Python/完整工程日志按 hash 明确复用 v1；最终语法和构建另跑。 |
| [主执行实体记录](development/physical-v1/report.json) / [保存宏](development/physical-v1/saved-recording.json) | 用户真实输入“你好”并拖拽，6 actions、57 events；保存、清空、重放同文本和拖拽，输入与输入源清理通过。不是独立 agent 再次操控真人。 |
| [实体独立来源核验](physical-evidence-review-v1.json) | 保存字节=采集对象实际序列化=回放对象；capture 只有 record_stop、538 state 和 1 title，manualPointerTick 全为 0，无 controller/fixture 键鼠注入。45 个物理 pointer 为 subtype3，按钮 mask 17179869254；保存为 canonical 投影，45 个回放 pointer 为 subtype0、按钮 mask70，顺序/坐标/button/click/flags 逐行一致。两阶段“你好”、35 次 drag 与累计 70 次 drag、平衡及清理收据互证。只做记录来源审查，不冒充执行或压力验收。 |

开发 [GUI v1](development/gui-v1.txt) 在进入 MCP 前因新工作树缺进程 helper 失败，补建后 [GUI v2](development/gui-v2.txt) 87 项通过；最终 [GUI v3](development/gui-v3.txt) 增加 schema1 真实拒绝断言后 88 项通过。[主执行 App](development/app-v1.txt) 19 项通过。早期严格模式的三次实体失败、GUI 历史超时和脚本中断继续在父目录保留，不能称开发全过程零重跑。最终独立桌面各自首跑，无自动或手动重跑。

当前默认 helper raw SHA 为 `1cc945ded67ff7b8bc487abeb7b7017aa07ca3256b8229f875e71bc249185dc5`，与独立 `49b6b385...` 和开发 `a9cdfdb5...` 不同。[完整 Mach-O 比较](helper-build-equivalence.json)只排除 UUID 16 字节及签名分配区 848 字节，其余全部字节相等；签名分配区含结构化 Superblob 826 和 22 个尾字节。独立解析、CodeDirectory 安全元数据/其余签名 slots、无 entitlements、三份 strict 签名均通过。此为限定代码/数据等价，不是 raw/TCC identity 或默认 helper 新增 GUI 验收。[默认只读状态](default-helper-status.json)单列；App executable/build.json 未重建或重签。

正常审批 allow/deny/cancel、真实 session/turn 图片检查点回滚、实际 TCC 撤权恢复、动作中系统锁屏、当前候选应用场景与物理多屏/macOS14/Windows/正式身份等原范围仍开放。见[原需求审计](../../remaining-audit.json)；该历史审计中的手动功能缺口由本切片在用户确认的标准投影范围内补齐，不改变其他项状态。
