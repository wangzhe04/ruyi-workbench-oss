# 如意 Ruyi 工作台 · 下一轮优化规划（总览）

> 本文档由 8 路并行只读分析（路线图文档 / UI 设计文档 / 产品与营销文档 / 后端代码 / 前端代码 / ACC-MCP 代码 / 提示词体系 / 测试与工程化）汇总而成，基线版本 v1.6.7（2026-07-20）。
> 分析全程只读，未改动任何现有文档与代码。行号对应分析时的 `app/src/*.js`（合计约 1.88 万行）、`app/public/app.js`（8175 行）、`styles.css`（2225 行）当前版本，改动后会漂移，请以就近搜索为准。
> 本规划不取代 `../OPTIMIZATION-ROADMAP.md`，而是其续篇：那份记录第 6–44 波的"已发生"，这份规划第 45 波之后的"应发生"。

---

## 0. 一句话结论

四大确定方向全部"地基已好、只差临门一脚"，且彼此高度耦合，应按一个整体战役推进：

1. **UI 大迭代**方向已明确为**现代毛玻璃质感（Glassmorphism）**：底层微渐变、中层分层磨砂、青花蓝收敛为点色，告别"大片纯主色平铺"。项目不缺实现底座（token 体系 + `color-mix` 全覆盖 + currentColor 图标集），缺的是**前端架构还债**（app.js 8175 行未组件化）和**明暗双模式的自动化守护**（截图回归缺失）。顺序必须是：先定毛玻璃设计稿 → 拆架构 → 分层铺玻璃 → 同步上视觉回归门与模糊性能预算。
2. **Steer** 是四个方向里"性价比最高"的：provider 引擎链路已完整，Claude 引擎的 stdin 注入通道（`05-claude-engine.js:387-389` 的 AskUser 应答）已实战验证，缺口只是路由放行与注入纪律。对标 Codex 还需补"打断执行中工具"（MCP cancellation）。
3. **工具库（ACC/MCP）**最痛的不是缺工具，而是**桥接超时契约错位**（桥 120s 超时后 ACC 侧僵尸执行）与**生态互通只有出口没有入口**（能导出给 Claude CLI，不能从 Claude Code/Codex 配置导入）。
4. **提示词/工作流**体系功能完备但工程化不足：散在 6+ 文件硬编码、全中文无 i18n、易变层自破 prefix cache、无快照测试。改动风险高，必须"先建评测与快照，再动提示词文本"。

另识别出 6 个高价值附加方向：安全收尾（token 注入、沙箱 L2/L3）、上下文压缩 v2 收尾、性能低垂果实（PF4/PF5/轮询合并）、测试基建（test-kit/浏览器视觉回归/ACC 回归）、文档治理（门面数字单一事实源、文档生命周期标注）、发布体验（overlay 更新 GUI）。

## 1. 方向清单与优先级矩阵

| # | 方向 | 价值 | 成本 | 风险 | 建议波次 | 详细方案 |
|---|------|------|------|------|----------|----------|
| 1 | UI 大迭代（现代毛玻璃质感，明暗双模式） | 高 | 大 | 中（依赖架构前置） | W46–W49 | [01-ui-modernization.md](01-ui-modernization.md) |
| 2 | 对话中 Steer（全引擎） | 高 | 中 | 中（Claude stdin 交互假设需探针） | W45 | [02-steer.md](02-steer.md) |
| 3 | ACC 优化 + MCP 生态兼容 | 高 | 中 | 低–中 | W45–W47 | [03-tools-mcp.md](03-tools-mcp.md) |
| 4 | 提示词与模型工作流规范化 | 高 | 中 | 高（行为漂移）→ 先建护栏 | W46–W48 | [04-prompts-workflow.md](04-prompts-workflow.md) |
| 5 | 安全收尾（token/沙箱/CSP） | 高 | 小–中 | 低 | W45 | [05-other-directions.md](05-other-directions.md#安全) |
| 6 | 上下文压缩 v2 收尾 | 中 | 中 | 中（已在途） | W45 | [05-other-directions.md](05-other-directions.md#稳定性) |
| 7 | 性能低垂果实 | 中 | 小 | 低 | W46 | [05-other-directions.md](05-other-directions.md#性能) |
| 8 | 测试与工程化基建 | 中 | 中 | 低 | 贯穿全程 | [05-other-directions.md](05-other-directions.md#测试与工程化) |
| 9 | 文档治理 | 中 | 小 | 低 | 每个波次顺带 | [05-other-directions.md](05-other-directions.md#文档治理) |
| 10 | 发布与产品扩展（overlay GUI 等） | 中 | 中 | 中 | W48+ | [05-other-directions.md](05-other-directions.md#发布与产品扩展) |

## 2. 建议波次路线图

**W45 · 快赢波（小切口高价值，互不冲突）**
- Steer：Claude 引擎对话插话打通（02 §2）+ fake-claude 交互剧本扩展
- 安全：token 注入改 sessionStorage/Bootstrap 通道、CSP meta
- ACC：桥接超时契约修复（超时即 cancel + kill 进程树）
- 上下文压缩 v2 在途项收尾（子代理重试 + 摘要质量度量）

**W46 · 地基波（为大战役铺路）**
- 前端 FE Phase 2 架构拆分启动（chat-stream / workbench / settings 域）
- 提示词护栏建设：快照测试 + 请求体落盘断言 + 跨模型 A/B 评测夹具
- MCP 配置导入器 v1（`~/.claude.json` / 项目 `.mcp.json` / Codex `config.toml`）
- 性能：readConfig 缓存、verifyManifest 降频、agent-runs digest 增量渲染

**W47 · 生态与工具波**
- ACC 工具质量战役（PDF 分页、新旧工具收敛、description 审计、ACC_TOOLSETS 子集注册）
- 新增 MCP 工具首批：edit_file/补丁、fetch、memory、sequential-thinking
- 远程 MCP transport（SSE/streamable-HTTP）评估与落地
- Claude 引擎角色 prompt 注入补齐

**W48 · UI 视觉大迭代波**
- 设计基线收敛（现代化视觉语言、token 刷新、emoji→SVG、系统跟随主题）
- 视觉回归门上线（双主题截图对比 + WCAG AA 断言）
- i18n 未竟项清零、可访问性 P0 修复
- 提示词外置与 i18n、系统提示稳定化分层

**W49 · 范式升级波（可选，视 W48 反馈）**
- vNext「交办台」三步渐进置换第一步（V1 坞与案头）
- 提示词版本化/A-B 实验机制
- overlay 更新 GUI v1

## 3. 全局验收与度量

每个波次沿用项目既有纪律：`KNOWN_FAILURE={}` 空表、行为锁 e2e、静态锁、双语键同交 lint。新增三条全局门：

1. **视觉回归门**：UI 相关波次必须过双主题截图对比 + token 对称静态锁 + WCAG AA 对比度断言（theme.e2e.js 已有对比度红线范式）。
2. **提示词回归门**：提示词相关改动必须过快照测试 + fake-openai 请求体落盘断言 + `model-tier-probe.js` 跨模型抽测。
3. **门面数字门**：README/marketing/文档中的工具数、版本号、测试数由单一事实源生成，发布前机械校验（消除当前"39/40/43/99/100 五口径并存"的现状）。

## 4. 文档索引

- [01-ui-modernization.md](01-ui-modernization.md) — 前端 UI 大迭代详细方案
- [02-steer.md](02-steer.md) — 对话中 Steer（类 Codex）详细方案
- [03-tools-mcp.md](03-tools-mcp.md) — ACC 工具库优化 + MCP 生态兼容详细方案
- [04-prompts-workflow.md](04-prompts-workflow.md) — 提示词与模型工作流规范化详细方案
- [05-other-directions.md](05-other-directions.md) — 安全 / 稳定性 / 性能 / 架构 / 测试 / 文档 / 发布等附加方向
