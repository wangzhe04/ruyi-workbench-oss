# P3：文档、浏览器与模板

状态：进行中（四包Mac本地单独验收完成；Windows同候选实际回归待补） · 前置：P1 · 基础工作量：**6–10 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

## 目标

复用 ACC 的文件/Office/浏览器能力，形成首个浏览器内测版的工作产出闭环。M1 验收还需 P2 完成。

## 入口条件

前置阶段已验收或明确仅开展不依赖其结果的探针；读取架构约定和当前基线。开始时核对源码变化，复用现有函数和测试，不根据旧行号盲改。

## 涉及文件与调用链

- [`mcp/ai-computer-control/pyproject.toml`](../mcp/ai-computer-control/pyproject.toml)
- [`mcp/ai-computer-control/requirements_offline.txt`](../mcp/ai-computer-control/requirements_offline.txt)
- [`mcp/ai-computer-control/src/ai_computer_control/server.py`](../mcp/ai-computer-control/src/ai_computer_control/server.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/document.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/document.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/office_io.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/office_io.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/browser.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/browser.py)
- [`mcp/ai-computer-control/src/ai_computer_control/tools/safety.py`](../mcp/ai-computer-control/src/ai_computer_control/tools/safety.py)
- [`ruyi-workbench/resources/native-file-read.py`](../ruyi-workbench/resources/native-file-read.py)
- [`ruyi-workbench/resources/playbooks`](../ruyi-workbench/resources/playbooks)
- [`ruyi-workbench/resources/plugins`](../ruyi-workbench/resources/plugins)

## 工作包与推荐顺序

同阶段工作包按下表顺序推进；已冻结接口下可分工，但共享源文件的改动需串行集成。

| ID | 工作包 | 人日 | 具体交付 |
|---|---|---:|---|
| P3-01 | 拆分 ACC 平台依赖与注册 | 2–3 | pywin32/winsdk/UIA 条件化；共享模块可独立安装，失败隔离且报告真实能力；为 Mac 文件工具补保护规则。 |
| P3-02 | 文档与图表生成/读取 | 2–3 | 验证 docx/xlsx/pptx/pdf 与图片提取、图表、中文字体；把依赖清单和最小样例固定下来，保证检查点与写入审计。 |
| P3-03 | Playwright 与浏览器运行时 | 1–2 | 验证 Mac Chromium、独立 profile、离线浏览器缓存路径、标签页/输入/截图和退出清理；区别原生打开 URL 与浏览器自动化。 |
| P3-04 | 平台模板与能力文案 | 1–2 | 逐项检查 16 个 Playbook、离线技能/角色及示例命令；为 PowerShell/Windows 控制模板提供 Mac 路径或禁用条件；更新中英文说明。 |

## 阶段验收

- [ ] V08/V09 通过；无 pywin32 也能安装/启动 Mac 共享 ACC 子集。
- [ ] Office 文件经独立读取/渲染确认内容，缺依赖给准确提示；离线测试不临时下载。
- [ ] P0–P3 全部完成后才登记 M1；M1 是开发环境内测，不称为正式离线安装包。

- [ ] 相关 Windows 回归、构建新鲜度与代码契约通过；独立复核发现均有处理记录。

- [ ] TASKS.json 与执行看板已登记真实状态、提交 SHA、日志、已知限制。

## 回退与失败处理

按平台禁用失败的可选工具；保留 Windows extras 和工具名契约。浏览器 profile 与用户默认 profile 分离，回滚不删除用户浏览器数据。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。

## 2026-11-06 执行进度

P3-01实现 `f135bda1` 已完成Mac共享ACC开发与单独本地验收：真实43工具、14项MCP专项、8项Python专项（含真实APFSX）、断网wheel安装、独立复核均通过。首轮静态78/80，两个失败组修复复测通过；完整单元2490通过/18跳过，记录保留原失败。详见 [P3-01交付](evidence/P3/acc-shared/README.md)。

Windows实际同候选回归未执行，不沿用P1/P2的豁免，也不把标记/静态契约通过当作Windows实机结果。P3整体保持进行中；macOS14与正式发行验证维持原交接。下一包P3-02。

## 2026-11-07 P3-02单独本地验收

实现 `bd2eb093` 接入Mac中文字体、准确回退提示，修复短PDF省略页码时默认越界。真实工作台MCP/检查点回滚24项、独立产物24项、116 Office/98读取/43图表检查均通过；锁定60依赖的全新非editable环境断网重放通过。DOCX1、XLSX1、PPTX3及原生PDF1共六页经过独立渲染与目视检查。独立复核无剩余发现。

完整单元2490通过/18既有跳过；首轮静态78/80，新增测试引起的两个清册漂移修复复测通过，其余原证据复用。Windows同候选实际回归未执行且未获豁免，P3整体保持进行中。详见[P3-02交付](evidence/P3/office/README.md)；下一包P3-03。

## 2026-11-07 P3-03单独本地验收

实现 `35ce93b9` 验证Mac managed/bundled Chromium、隔离profile和离线缓存，明确system交接与DOM自动化边界；关闭/EOF与取消清理只处理自有资源。真实MCP与全新63依赖非editable断网重放各25项、8项生命周期和98读取回归通过，截图已目视检查。独立复核两项驱动泄漏修复复测通过。完整单元2490通过/18既有跳过；首轮静态78/80，两个工程门修正定向通过。Windows/minOS与发行仍未验证，整体保持进行中，下一包P3-04。详见[P3-03交付](evidence/P3/browser/README.md)。

## 2026-11-07 P3-04单独本地验收

实现 `2f45aba4` 完成71项资源独立内容审计，新增桌面/OCR/浏览器控制能力区分与Mac模板分支，修正中英文能力界面、URL交接、Office原生读取和Windows发行边界。真实模板38项、Playbooks94项、中英能力弹层18项等专项通过；独立复核三项状态/缓存发现全部修复复测。完整单元2491通过/18既有跳过；静态79/80，唯一旧枚举锁更新后定向通过，不宣称另一次完整80/80。详见[P3-04交付](evidence/P3/templates/README.md)。

四包Mac本地开发与单独验收均完成。Windows实际同候选回归未执行且未豁免，macOS14与正式发行仍未验证，因此P3整体保持进行中，不登记M1、不启动P4验收。
