# P5：Mac 桌面自动化

状态：进行中（P5-01 开发与验收） · 前置：P4 · 基础工作量：**16–26 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

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
- [ ] 至少验证受控测试窗口、TextEdit、Finder、Chromium 的选定场景；逐项列出应用/版本/限制。
- [ ] 完成 AX/OCR/截图到动作再验证的闭环；错误焦点、失效元素和权限缺失不会假报成功。
- [ ] 保留原审批与审计；新增文件写工具列入检查点路径表；不可逆动作分类一致。

- [ ] 相关 Windows 回归、构建新鲜度与代码契约通过；独立复核发现均有处理记录。

- [ ] TASKS.json 与执行看板已登记真实状态、提交 SHA、日志、已知限制。

## 回退与失败处理

每组桌面能力可独立关闭并撤下工具目录；M2 的普通聊天/文档能力继续可用。不得要求关闭 SIP/TCC 来维持功能，不把 Windows 旧工具名虚挂到失败实现。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。
