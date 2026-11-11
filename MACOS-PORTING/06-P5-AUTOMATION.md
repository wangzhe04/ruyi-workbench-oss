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
