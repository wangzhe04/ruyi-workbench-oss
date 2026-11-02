# P1：运行时与系统边界

状态：进行中（2026-11-03，P1-01/02/03/04 已进入实现与验收） · 前置：P0 · 基础工作量：**8–12 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

首批实现、测试结果与剩余验收见 [P1 实施记录](evidence/P1/README.md)。最新所有权恢复验证见 [补充记录](evidence/P1/ownership/README.md)。P1-04 已实现进程身份、清理基础与一次性执行监督入口，详见 [监督实现记录](evidence/P1/supervisor/README.md)。CLI/MCP/toolbox 已完成本批监督接入，见 [集成记录](evidence/P1/process-integration/README.md)。git 已完成监督捕获与工具 owner 接入，见 [git 记录](evidence/P1/git-runtime/README.md)。P1-03 已接入 Mac 一次性与常驻 shell，见 [shell 记录](evidence/P1/shell/README.md)。P1-02 已实现系统路径策略、卷大小写隔离与文件写入回滚，见 [文件策略记录](evidence/P1/files/README.md)。helper 运行时版本与能力门已接入，见 [能力门记录](evidence/P1/helper-gate/README.md)。单 helper 故障恢复已实现双层监督，见 [故障恢复记录](evidence/P1/helper-loss/README.md)。原生 provider 工具发现、提示词与体检已接入实时能力状态，见 [能力状态记录](evidence/P1/capabilities/README.md)。CLI/MCP 发现与能力弹层已完成本批接入和真实浏览器验证，见 [发现与界面记录](evidence/P1/discovery-ui/README.md)。隔离工作树 Git 已接入监督及失败恢复，见 [工作树记录](evidence/P1/worktree-runtime/README.md)。Kimi 模型发现探针已接入监督，见 [探针记录](evidence/P1/cli-model-probe/README.md)。当前执行入口清册、受控启动布局及文件失败恢复已补齐。阶段实际未闭合项与后续阶段边界见 [验收缺口审计](evidence/P1/acceptance-audit.md)，当前继续收集冻结源码回归、Finder 可见验收和 Windows 同版本证据。

## 目标

让服务在 Mac 上可靠启动、执行、停止，并保持现有文件和审批边界。

## 入口条件

前置阶段已验收或明确仅开展不依赖其结果的探针；读取架构约定和当前基线。开始时核对源码变化，复用现有函数和测试，不根据旧行号盲改。

## 涉及文件与调用链

- [`ruyi-workbench/app/src/00-boot.js`](../ruyi-workbench/app/src/00-boot.js)
- [`ruyi-workbench/app/src/01-config.js`](../ruyi-workbench/app/src/01-config.js)
- [`ruyi-workbench/app/src/01d-win-cmdline.js`](../ruyi-workbench/app/src/01d-win-cmdline.js)
- [`ruyi-workbench/app/src/03-bridge-guard.js`](../ruyi-workbench/app/src/03-bridge-guard.js)
- [`ruyi-workbench/app/src/04-desktop-shell.js`](../ruyi-workbench/app/src/04-desktop-shell.js)
- [`ruyi-workbench/app/src/04-permission-runtime.js`](../ruyi-workbench/app/src/04-permission-runtime.js)
- [`ruyi-workbench/app/src/11-native-tools.js`](../ruyi-workbench/app/src/11-native-tools.js)
- [`ruyi-workbench/app/src/12-tool-dispatch.js`](../ruyi-workbench/app/src/12-tool-dispatch.js)
- [`ruyi-workbench/app/src/13-http-router.js`](../ruyi-workbench/app/src/13-http-router.js)
- [`dev-harness/lib/kill-own-tree.js`](../dev-harness/lib/kill-own-tree.js)

## 工作包与推荐顺序

先确定 P1-01 的启动接口，P1-02 可独立推进；优先完成 P1-04 的进程登记和测试清理器，再做 P1-03 的大量 shell 执行/中断验收。已冻结接口下可分工，但共享源文件的改动需串行集成。下表编号用于追踪，不表示必须按数字顺序实施。

| ID | 工作包 | 人日 | 具体交付 |
|---|---|---:|---|
| P1-01 | 平台启动与依赖定位 | 2–3 | 新增集中平台层；Mac 启动入口、--open、Finder reveal、Node/Python/rg 探测；适配干净 PATH，不 source 用户 profile。 |
| P1-02 | 文件与系统路径策略 | 2–3 | 定义 Mac 受保护路径；复核 realpath、大小写敏感卷、符号链接、POSIX 绝对路径、原子写与回退；修复对应测试夹具。 |
| P1-03 | 一次性与常驻 shell | 2–3 | 实现平台默认 shell、显式脚本语言和非 TTY 常驻会话；同步 schema、bash 别名、命令长度、Unicode、输出上限与取消语义。 |
| P1-04 | 自有进程树治理 | 2–3 | 统一 CLI/MCP/shell/toolbox 的启动登记与停止；替代 /proc 假设；覆盖子孙、父进程先退出、身份校验；同步测试清理器。 |

## 阶段验收

- [ ] V02/V03/V04 通过；停止/超时后自有进程树不再继续工作且不误杀陌生进程。
- [ ] 终端和受控干净环境均能起服务；浏览器打开不调用 cmd.exe/Explorer。
- [ ] Windows 原 shell/引号/路径测试保持通过；明确不支持 TTY 交互式程序。

- [ ] 相关 Windows 回归、构建新鲜度与代码契约通过；独立复核发现均有处理记录。

- [ ] TASKS.json 与执行看板已登记真实状态、提交 SHA、日志、已知限制。

## 回退与失败处理

按能力开关关闭未通过的 Mac exec/desktop 能力，不改弱审批。回滚平台实现时保留原 Windows 分支与旧配置可读性；先停止新版本自有进程。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。
