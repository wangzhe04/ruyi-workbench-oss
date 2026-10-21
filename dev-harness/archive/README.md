# 历史迁移工具与临时复现

归档日期：2026-10-21。以下五份脚本从 `dev-harness/` 原样迁入，文件字节未改。没有运行它们，也未将历史冒烟列入正式回归。当前测试入口见 [harness 说明](../README.md)，实施方向见 [86 号规划](../../docs/optimization-plan/86-3.1-completion-and-privacy-roadmap.md)。

| 文件 | 原用途与适用时期 |
|---|---|
| [codemod-toolcall-table.js](codemod-toolcall-table.js) | 第 41 波，一次性将旧 `toolCall` switch 转为注册表；按当时源码形状工作 |
| [codemod-slice-modules.js](codemod-slice-modules.js) | 第 43 波，按固定行号将 18,485 行旧单体切为 15 模块；会删除并重建 `app/src`，不能用于当前源码 |
| [migrate-ports.js](migrate-ports.js) | V1.8-A 第一轮，将当时 e2e 固定端口迁为动态分配 |
| [migrate-ports-v2.js](migrate-ports-v2.js) | V1.8-A 第二轮，补第一轮遗漏的单行端口声明 |
| [v25-smoke.js](v25-smoke.js) | v2.5 临时复现：Claude Code 技能源、MCP 自动导入和删除技能；原文件明确不进正式套件 |

这些文件的 `__dirname` 仍描述原始目录布局，**不作为可在归档位置直接运行的维护工具**。需要复现时，从 Git 历史找到对应波次版本，在独立历史检出中恢复原 `dev-harness/<文件名>` 布局；先核对源码和路径，再判断是否适合执行。旧冒烟会启动服务并在用户家目录下创建测试技能，不能把它当安全的只读检查。

第 41／43 波的历史交付证据见 [早期路线记录](../../docs/archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)。现行回归中的 [技能注册表](../skills-registry.e2e.js)、[MCP 配置导入](../mcp-import-config.e2e.js)、[导入来源](../mcp-import-origin.e2e.js)和 [MCP 配置变更](../config-mutate-mcp-parity.e2e.js)承接相关领域，但本次未声称与旧冒烟逐条等价；原复现完整保留。

五份脚本平放在此目录，以继续被 `syntax-gate.js` 对 `dev-harness` 的深度 1 扫描覆盖。根目录 `*.e2e.js` 发现集合仍为 539 件，未变更正式 runner、生成器或生产构建入口。
