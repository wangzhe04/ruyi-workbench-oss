# P5：Mac 桌面自动化

状态：进行中（P5-04 OCR 与模板匹配当前主机独立验收通过，P5-01 后续环境验收，P5-02 输入切片与 P5-03 AX核心/真实应用功能当前主机独立验收通过，最终工程及独立终审通过） · 前置：P4 · 基础工作量：**16–26 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

## 目标

为明确列出的 Mac 应用场景提供可验证的观察和操作链路，不追求 Win32/UIA 语义逐项照搬。

## 入口条件

前置阶段已验收或明确仅开展不依赖其结果的探针；读取架构约定和当前基线。开始时核对源码变化，复用现有函数和测试，不根据旧行号盲改。

## 涉及文件与调用链

- [`mcp/ai-computer-control/src/ai_computer_control/tools/screen.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/screen.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/capture.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/capture.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/desktop_extra.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/desktop_extra.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/mouse.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/mouse.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/keyboard.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/keyboard.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/window.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/window.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/uia.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/uia.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/ocr.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/ocr.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/observe.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/observe.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/act_and_verify.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/act_and_verify.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/record.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/record.py)
- [`ruyi-workbench/app/src/12-tool-dispatch.js`](../ruyi-workbench/app/src/12-tool-dispatch.js)

## 工作包与推荐顺序

同阶段工作包按下表顺序推进；已冻结接口下可分工，但共享源文件的改动需串行集成。

| ID | 工作包 | 人日 | 具体交付 |
|---|---|---:|---|
| P5-01 | 屏幕/窗口捕获与坐标 | 3–5 | 使用适合最低系统版本的截图后端；建立逻辑点/像素/缩放/原点契约；处理 Retina、多屏、负坐标和权限拒绝。 |
| P5-02 | 输入、剪贴板与窗口操作 | 3–4 | Mac 键位、Cmd 粘贴、中文输入、鼠标/滚轮、文本与图片剪贴板、应用启动和窗口动作；保护焦点和目标身份。 |
| P5-03 | AX 元素后端 | 5–8 | 实现元素查询、定位、支持的动作；处理失效元素、超时/深度/数量上限与应用不支持；替代 UIA 特定属性映射。 |
| P5-04 | OCR 与视觉组合 | 3–5 | Vision 或验证通过的离线引擎；中英识别、文字定位、坐标回映射与点击；保留图像算法，改接 Mac 截图。 |
| P5-05 | 宏录制和执行后验证 | 2–4 | 受控输入录制/停止/重放与组合动作；串联 observe/act_and_verify；测试焦点变化、锁屏/权限撤销；同步工具目录和能力状态。 |

## 阶段验收

- [ ] V11/V12 通过；每项 advertised ready 能力均有实际成功与失败路径证据。
- [x] 当前主机已验证受控测试窗口、TextEdit 1.21、Finder 27.0、CFT 148.0.7778.96 的选定场景，应用限制分别登记。[场景与版本](evidence/P5/ax/apps/README.md)
- [ ] 完成 AX/OCR/截图到动作再验证的闭环；错误焦点、失效元素和权限缺失不会假报成功。
- [ ] 保留原审批与审计；新增文件写工具列入检查点路径表；不可逆动作分类一致。

- [ ] 相关 Windows 回归、构建新鲜度与代码契约通过；独立复核发现均有处理记录。

- [ ] TASKS.json 与执行看板已登记真实状态、提交 SHA、日志、已知限制。

2026-11-10 真实应用切片已完成当前主机功能独立验收。350 条 E2E、8 项 focused unit、62 项 Python 及三项预期负向通过。默认 CFT 未观察到 WebArea，配置 renderer 后可观察页面，页面 AX 动作因公开父子关系不对称被成员校验拒绝。Node 与 Python 的独立测试夹具差异逐项绑定，最终 63 文件工程门与独立终审通过，实现提交 `649556f0` 的63份文件已逐项绑定。[应用场景记录](evidence/P5/ax/apps/README.md)

P5-04 当前主机独立验收通过，215 条真实 E2E 与 87 项 Python、默认 helper 和真实如意 App HTTP 视觉链均通过。完整单元 2499 项通过及 18 项既有跳过，静态 80/80、语法 1147 文件与构建新鲜度通过。80 份源码文档及 3 份运行产物全程匹配。P5-05 和原环境门继续推进。[OCR 工作包](evidence/P5/ocr/README.md)

P5-05 组合切片已通过当前主机独立验收。共享帧 observe、受控 act_and_verify、宏重放及异步等待共 244 条 E2E、103 项 Python 通过，工程四门通过。原生录制继续下一切片。[组合记录](evidence/P5/composed/README.md)

## 回退与失败处理

每组桌面能力可独立关闭并撤下工具目录；M2 的普通聊天/文档能力继续可用。不得要求关闭 SIP/TCC 来维持功能，不把 Windows 旧工具名虚挂到失败实现。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。

P5-05 受控原生录制切片已通过当前主机独立验收，二十一条命令各一次，303 项 Node 与 127 项 Python 通过，零失败、零跳过。工程四门通过，单元 2499 通过/18 既有跳过、静态 80/80、语法 1149 文件。来源为 controlled_native_requests，手动输入监听继续单列，原有环境门保持开放。[录制记录](evidence/P5/record/README.md)

2026-11-11 剩余需求审计确认手动示范录制仍是本机功能缺口，并发现已派发动作后的协作取消可能跳过 ACC 审计。取消审计修复通过当前主机独立验收，24 条命令各一次，326 项 Node E2E、147 项 Python 通过。工程门为语法 1150、构建新鲜度、单元 2499 通过/18 既有跳过、静态 80/80。正常审批、真实检查点、IME、撤权和动作中锁屏等继续按原范围推进。[取消审计](evidence/P5/audit/README.md) [需求矩阵](evidence/P5/remaining-audit.json)

手动事件严格模式受支持子集 `0d054b04` 与用户确认的标准鼠标投影 `1500b82b` 均已提交并完成对应当前主机范围独立验收。标准投影独立 GUI 88 项、App exact 17 项、standard 19 项通过，170 项 Python 和工程门按冻结来源登记。真人“你好”及触控板拖拽保存回放通过，独立来源核验通过。schema3 的 profile/scope 明确仅覆盖键盘/标准鼠标投影，不采集/回放压力阶段，不保证检测所有压力手势，不外推压力驱动应用状态。[手动录制记录](evidence/P5/manual/README.md)

正常会话入口切片 `5e246343` 已通过当前主机独立验收：默认审批允许、拒绝和待审批取消；真实 `window_screenshot`/`get_clipboard_image` 各自新建与覆盖的同 session/turn 检查点和实际回滚。离线 13、真实桌面 31、静态 80/80，单元 2499/18 既有跳过；最终冻结独立各一次、无自动重试。修复普通 provider 代理桥接图片写入遗漏当前会话检查点的问题。Node 服务启动范围、开发失败/清册修复历史及 App/锁屏/撤权/Windows 未验边界见 [入口记录](evidence/P5/entry/README.md)。P5 仍为 `in_progress`。

当前源码选定应用场景已补验：独立默认31/renderer33/Finder10，共74项各一次，106来源绑定5e246343/76248e2b及六次成功场景前后快照。实际临时helper与默认1cc限定字节等价，不称raw/TCC身份相同；Chromium renderer动作拒绝边界保留。Finder用户窗口前置拒绝与关闭后通过分别归档。[当前应用记录](evidence/P5/selected-current/README.md)。

229a9021新增实际能力状态与嵌套策略回归，独立40项通过：Node/ACC缺helper状态及目录、真实registry隐藏input_sequence后的保存宏/batch拒绝、Node两总闸普通会话拒绝及实际生成CLI隐藏配置。产品源码未变；最终工程四门和14源/2产物绑定通过。CLI运行、TCC拒权/撤权、系统锁屏、真实布局过渡与原环境门不在该切片。[记录](evidence/P5/readiness/README.md)。

1b03da04新增真实自有窗口水平平移期间的生产helper捕获测试，独立18项通过；8次有actual CG位置变化见证的window_changed拒绝，静止前后exact bounds/backingScale2/PNG色点通过独立解码。仅测试/夹具/清册变化，12源/2产物和工程门绑定通过；不覆盖resize、物理display布局或移动成功瞬时origin。[记录](evidence/P5/transition/README.md)。

96db15f6新增零输入根进程强杀校准，主执行与独立各12项通过：原5个已观察身份退出、输入中性、GET重启不重放。权限请求名/参数及allow意图仍在；dispatch/ACC wait-entry与执行终局持久归属未确认，完整hard-abort门保持开放。仅测试/夹具/清册变化。[记录](evidence/P5/hard-abort/README.md)。

7f95d654修复普通Provider主回合工具意图/逐结果持久化及严格保存屏障，未知与确未派发收尾分开，恢复并行展示有界并支持原生图片数组附件。独立新unit9/offline11/零输入12/入口31通过，最终工程语法1158、单元2508/18既有skip、fast80/80；初次保存普查79/80失败及修正保留。请求记录不等于实际ACC派发/入口/终局或held门通过，Node范围未新验App。[记录](evidence/P5/durable-history/README.md)。

75c593e3修复已执行宏内部动作漏入不可逆摘要的问题：在展示压缩前提取有界返回步骤，保留reported/unknown、call/step及incomplete，经跨回合折叠和API不丢失；等待/只读/本地拒绝不虚报已执行。独立unit13/Python5/离线16/真实入口34通过，工程语法1161、单元2521/18既有跳过、fast80/80。首次独立Python因runner缺加载环境未进测试，修正后执行一次；开发初败、审查修正及旧静态锁失败均保留。208来源/2实际产物绑定，不代表native派发/终局、held释放或整体验收。按用户要求继续无人值守，P5整体验收后恢复自动锁屏。[分类记录](evidence/P5/tool-effect-audit/README.md) [最新剩余映射](evidence/P5/remaining-resolution-2026-11-11-effects.json)。

2026-11-12 默认关闭的桌面执行回执与前台 Provider 子代理切片已在 `f671a004` 提交并集成。真实 root/ACC/原生输入 worker 身份关联、主回合与正回合前台节点的逐结果/图片历史保存、存储失败后的 unknown 屏障通过独立验收。13 条命令各一次、零失败/跳过/重试；子代理117、主图片26、主派发32、上下文38、Python控制4、相关单元78及清册/构建通过，122源码与3产物共26次前后绑定一致。默认关闭兼容5组85项通过；完整单元2626通过/18既有跳过、语法1178、静态80通过/12显式live跳过。真实图片测试使用固定PNG，未外推原生截图/OCR；后台/API0/恢复/CLI/manual admission、reconciliation/retention及原环境门继续开放。源码、全部失败历史和独立报告已归档。[当前状态](evidence/P5/execution-receipts-wip/current-state.json)。按用户要求继续无人值守，P5整体仍进行中，整体验收后恢复自动锁屏。

2026-11-12 原生截图与 Vision 回执切片 `b7930bde` 已在默认关闭状态提交并集成（候选源码提交 `56c970cf`）。Node serve 与冻结 helper 的独立18条命令全部通过，无失败/跳过/重试；真实截图/OCR及故障87、原生协议51、适配器23，另含上下文/主图像/派发/子代理回归与清册。125源码/4产物共36次前后绑定匹配。实际小图子代理保存、下一模型请求与冷重启复开通过；真实大图触发16MiB快照拒绝时保持未交付并阻断后继操作，未丢图假报成功。实际Stop证明精确进程清理与未确认终局的unknown，不等同于捕获body被中断；forced callback和原生OCR长时限分支仍仅源码证明。完整单元2626通过/18既有跳过、静态80通过/13明确live跳过、语法1179及构建新鲜度通过。所有开发失败保留，包括第一次Stop过早采样、图片展示附件误断与一次因实施者校验中改测试导致的指纹失效；最终冻结重新验证通过。本切片无输入投递/held故障或App身份复验，P5整体和原10本地/4外部门仍开放。[当前归档](evidence/P5/execution-receipts-wip/current-state.json)。
