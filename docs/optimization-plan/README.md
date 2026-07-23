# 如意 Ruyi 工作台 · 下一轮优化规划（总览）

> 本文档由 8 路并行只读分析（路线图文档 / UI 设计文档 / 产品与营销文档 / 后端代码 / 前端代码 / ACC-MCP 代码 / 提示词体系 / 测试与工程化）汇总而成，基线版本 v1.6.7（2026-07-20）。
> 分析全程只读，未改动任何现有文档与代码。行号对应分析时的 `app/src/*.js`（合计约 1.88 万行）、`app/public/app.js`（8175 行）、`styles.css`（2225 行）当前版本，改动后会漂移，请以就近搜索为准。

> **状态说明（2026-07-24）**：这是 v1.6.7 后、Escapade 2.0 立项前的分析存档；第 46–52 波已纳入 **如意 Ruyi Escapade 2.0 (`v2.0.0`)**。当前执行中的发布规则、内部波次和 Escapade / Pretender 后续计划，以 [`../OPTIMIZATION-ROADMAP.md`](../OPTIMIZATION-ROADMAP.md) 的「发布线、产品代号与内部波次」与第53波起章节为准。
> 本规划不取代 `../OPTIMIZATION-ROADMAP.md`，而是其续篇：那份记录第 6–45 波的"已发生"，这份规划第 46 波之后的"应发生"。

> **2026-07-21 重基线**：规划落笔后两波已交付——**第44波**（Claude 模型列表 API 化 + 自定义模型可删，用户并行插入）、**第45波**（上下文压缩 v2 全量：摘要预算化 / 400 强压重试 / 子代理超窗兜底 / 估算自校准 / 结构化摘要 + 45f 对抗轮）；01 方案 Step 0 的 v4-glass 双主题 mockup 也已产出（含第 2 轮质感迭代）。原 W45–W49 编号与 roadmap 波次的映射已按实际重排，见 §2。

---

## 0. 一句话结论

四大确定方向全部"地基已好、只差临门一脚"，且彼此高度耦合，应按一个整体战役推进：

1. **UI 大迭代**方向已明确为**现代毛玻璃质感（Glassmorphism）**：底层微渐变、中层分层磨砂、青花蓝收敛为点色，告别"大片纯主色平铺"。项目不缺实现底座（token 体系 + `color-mix` 全覆盖 + currentColor 图标集），缺的是**前端架构还债**（app.js 8175 行未组件化）和**明暗双模式的自动化守护**（截图回归缺失）。顺序必须是：先定毛玻璃设计稿 → 拆架构 → 分层铺玻璃 → 同步上视觉回归门与模糊性能预算。
2. **Steer** 是四个方向里"性价比最高"的：provider 引擎链路已完整，Claude 引擎的 stdin 注入通道（`05-claude-engine.js:387-389` 的 AskUser 应答）已实战验证，缺口只是路由放行与注入纪律。对标 Codex 还需补"打断执行中工具"（MCP cancellation）。
3. **工具库（ACC/MCP）**最痛的不是缺工具，而是**桥接超时契约错位**（桥 120s 超时后 ACC 侧僵尸执行）与**生态互通只有出口没有入口**（能导出给 Claude CLI，不能从 Claude Code/Codex 配置导入）。
4. **提示词/工作流**体系功能完备但工程化不足：散在 6+ 文件硬编码、全中文无 i18n、易变层自破 prefix cache、无快照测试。改动风险高，必须"先建评测与快照，再动提示词文本"。

另识别出 6 个高价值附加方向：安全收尾（token 注入、沙箱 L2/L3）、上下文压缩 v2 收尾（**✅ 第45波已交付**）、性能低垂果实（PF4/PF5/轮询合并）、测试基建（test-kit/浏览器视觉回归/ACC 回归）、文档治理（门面数字单一事实源、文档生命周期标注）、发布体验（overlay 更新 GUI）。

## 1. 方向清单与优先级矩阵

| # | 方向 | 价值 | 成本 | 风险 | 状态(07-21) | 建议波次 | 详细方案 |
|---|------|------|------|------|------|----------|----------|
| 1 | UI 大迭代（现代毛玻璃质感，明暗双模式） | 高 | 大 | 中（依赖架构前置） | Step 0 mockup 已产出 | 第48/50波 | [01-ui-modernization.md](01-ui-modernization.md) |
| 2 | 对话中 Steer（全引擎） | 高 | 中 | 中（Claude stdin 交互假设需探针） | 未动，**性价比最高** | 第47波 | [02-steer.md](02-steer.md) |
| 3 | ACC 优化 + MCP 生态兼容 | 高 | 中 | 低–中 | 未动 | 第47–49波 | [03-tools-mcp.md](03-tools-mcp.md) |
| 4 | 提示词与模型工作流规范化 | 高 | 中 | 高（行为漂移）→ 先建护栏 | 未动 | 第48/51波 | [04-prompts-workflow.md](04-prompts-workflow.md) |
| 5 | 安全收尾（token/沙箱/CSP） | 高 | 小–中 | 低 | 未动 | 第47波(S1/S3)、48波(S2) | [05-other-directions.md](05-other-directions.md#安全) |
| 6 | 上下文压缩 v2 收尾 | 中 | 中 | 中 | **✅ 第45波已交付** | — | [05-other-directions.md](05-other-directions.md#稳定性) |
| 7 | 性能低垂果实 | 中 | 小 | 低 | 未动 | 第48波 | [05-other-directions.md](05-other-directions.md#性能) |
| 8 | 测试与工程化基建 | 中 | 中 | 低 | 部分（unit/ 仍未接 runner/CI） | 第46波起贯穿 | [05-other-directions.md](05-other-directions.md#测试与工程化) |
| 9 | 文档治理 | 中 | 小 | 低 | 未动（五口径仍并存） | 每个波次顺带 | [05-other-directions.md](05-other-directions.md#文档治理) |
| 10 | 发布与产品扩展（overlay GUI 等） | 中 | 中 | 中 | 未动 | 第52波+ | [05-other-directions.md](05-other-directions.md#发布与产品扩展) |

## 2. 后续波次路线图（2026-07-21 重排，编号对齐 roadmap）

> 编号原则：roadmap 波次是唯一序号（下一波 = 第46波）；原 W45–W49 为规划草稿编号，映射如下。
> 每波沿用既有纪律：对抗轮 + 行为锁 e2e + KNOWN_FAILURE 空表 + 双语键同交 + 主会话亲自验收。

**第46波 · V2.0 封版（既定收口，原"封版波"顺移至此）**
- 浏览器 DOM 冒烟 v1：Playwright 渲染真实前端（DAG 编辑器 + 设置/工作台静态页）——同时是 01 方案 Step 3 视觉回归门的脚手架，一次投入两次复用
- ACC 离线回归：fake-mcp 从 4 占位扩到关键 20 工具契约（03 Phase B 验收项提前共建）；ACC pytest 统一入口进 CI（E6）
- 编排盲区补测：跨节点资源死锁、loop×retry、双引擎 tier 等价、双冷 resume 窄窗
- 工程化顺手：unit/ 接 run-all 快通道 + CI（E2）；失败自动重试一次并标 `[flaky]`（E3）
- 封版：CHANGELOG（v2.0 总账）、路线图回填、全量 + live 三层全绿；`facts.json` 单一事实源起步（D1，封版数字口径正好需要）

**第47波 · 快赢波（Steer 主打 + 安全/桥契约）**
- 47a **Steer Phase A**：Claude 引擎对话 steer 打通（fake-claude 交互剧本探针先行 → `/api/steer` 放行按引擎分派 → 前端去静默 return → 双引擎参数化 e2e；与 AskUser 应答按消息类型分流防串扰）——02 方案，全规划性价比最高项
- 47b **桥 cancel/超时契约**（03 Phase A）：`notifications/cancelled` + 按工具声明式超时表 + 超时即 kill ACC 进程树——与 47a 共享 stdin/cancel 基础设施，且是 Steer Phase B（打断语义）的前置
- 47c 安全快赢：S1 token 改 sessionStorage/Bootstrap 通道、S3 CSP meta
- 47d X2 overlay 载荷漂移锁（PAYLOAD_FILES vs 实际文件集，白屏事故整类消失）
- Steer Phase B（批次边界打断 + 执行中工具取消）视 47a/47b 落地情况同波收尾或顺移 48

**第48波 · 地基波（为 UI/提示词两个大战役铺路）**
- 01 Step 1：FE Phase 2 架构拆分启动（先 workbench/settings 两域，纯搬家零视觉变化；P3 digest 增量渲染随做）
- 04 Phase A：提示词护栏（分层快照测试 + FAKE_CAPTURE_DIR 推广到四类辅助提示词 + A/B 基准集 10+ 任务）
- 03 §4.1：MCP 配置导入器 v1（`~/.claude.json` / 项目 `.mcp.json` / Codex `config.toml` 三源）+ MCP 管理面板
- 性能：P1 readConfig 缓存、P2 verifyManifest 降频、P5 剩余固定端口 e2e 迁 `getFreePort()`
- 安全/稳定填充：S2 沙箱 L2（package.json scripts 透明化）、R2 Retry-After 尊重、R3 权限暂停 Windows toast 通知

**第49波 · 生态与工具波**
- 03 Phase B：ACC 质量战役（新旧读取栈收敛、100 工具 description 审计、ACC_TOOLSETS 子集注册、pyproject/离线包/仓库卫生）
- 03 子命题二：新工具首批——edit_file/apply_patch（P0）、fetch（P0）、memory（P1）、sequential-thinking（P1），过入库纪律全部门
- 03 §4.2：远程 MCP transport（SSE/streamable-HTTP）+ 协议 2025-03-26 升级 + `tools/list_changed`
- A1：后端巨函数同域拆分（handleApi 按 steer/agent-runs/mcp/checkpoint 分组，与 47 改动同域顺手）
- E4：CI 扩展（ubuntu 静态件 job、release-dryrun 打包验证、action 钉 SHA + `permissions: contents: read`）

**第50波 · UI 视觉焕新波（01 Step 0 收尾 + Step 2/3）**
- Step 0 收尾：`UI-DESIGN-V4.md` 定稿、v4-glass mockup token 值回写 `styles.css`、token 清障（死令牌/硬编码 `#fff`）、CSS 分层拆分、docs/README 设计稿生命周期标注（D3）
- Step 2：`--scene-bg` 微渐变 → 浮层族玻璃一档 → 框架族二档 → 卡片族三档（列表 `data-glass="off"` 降级）→ 青花蓝点色化收口；主题三态（明/暗/跟随系统）；模糊预算同屏 ≤6
- Step 3：视觉回归门（双主题截图对比 + WCAG AA 扩展全语义色）、i18n 清零（60 处硬编码中文 + wbSteerBox/wbPoolBody/wbMailBody + TOOL_VERB_MAP）、a11y P0（role=log/focus-trap/键盘等价）、营销截图重拍（D1 联动）

**第51波 · 提示词与工作流规范化波（04 Phase B/C/D）**
- 提示词外置 `app/prompts/`（按层一文件、中英双份）+ registry 单一注册点 + `PROMPT_PACK_VERSION` 入会话元数据
- Phase C：system 首条逐字节稳定化分层（易变层移 user 侧，保 prefix cache）+ Provider 侧总预算闸（降级事件 UI 可见）+ `orchestrate_agents` 等常驻 description 瘦身
- Phase D：语义 loop-guard（结果指纹无进展，探索类宽阈值）、预算口径统一（[1,200] vs 300 拉齐）、Claude 子代理角色 prompt 注入、《模型工作流规范》文档双语

**第52波+ · 发布与范式（可选，视 50/51 反馈）**
- X1 overlay 更新 GUI v1（应用内上传 zip + check/preview/verify + 向导；Manage-Overlay 端口读配置）
- vNext「交办台」立项决策（01 Step 3 决策点：70% 资产可平移但类名零共享，双壳并存死线 ≤2 release）
- X3 产品扩展逐项评估（定时任务与自主推进调度器同根，成本最低者优先）
- D4 ARCHITECTURE_EN 补齐、D5 CHANGELOG 全时间线

### 依赖关系（重排后）

```
46 封版(测试基建) ──→ 47 快赢(Steer+桥cancel) ──→ 48 地基(FE架构+提示词护栏+导入器)
                                                        │                │
                                              49 生态工具 ←───────────────┘
                                                        │
                                              50 UI焕新(01 Step2/3) ──→ 51 提示词规范化(04 B/C/D)
                                                        │
                                              52+ 发布/vNext/产品扩展
```

- 47a Steer 与 47b 桥 cancel 共享 stdin/cancel 基础设施，必须同波或紧邻；
- 48 的 FE 架构拆分是 50 视觉焕新的硬前置；04 Phase A 护栏是 51 一切文本改动的硬前置；
- 50 与 51 顺序可互换（互不依赖），但同波合并超量，故拆开；
- 49 新工具上线后，04 的工具 description/能力层话术（51）需同步刷新，故 49 在 51 前。

## 3. 全局验收与度量

每个波次沿用项目既有纪律：`KNOWN_FAILURE={}` 空表、行为锁 e2e、静态锁、双语键同交 lint。新增三条全局门：

1. **视觉回归门**：UI 相关波次必须过双主题截图对比 + token 对称静态锁 + WCAG AA 对比度断言（theme.e2e.js 已有对比度红线范式）。第46波 DOM 冒烟 v1 即其脚手架，第50波全量上线。
2. **提示词回归门**：提示词相关改动必须过快照测试 + fake-openai 请求体落盘断言 + `model-tier-probe.js` 跨模型抽测。第48波建门，第51波全量适用。
3. **门面数字门**：README/marketing/文档中的工具数、版本号、测试数由单一事实源（`facts.json`）生成，发布前机械校验（消除当前"39/40/43/99/100 五口径并存"的现状）。第46波起步。

## 4. 文档索引

- [01-ui-modernization.md](01-ui-modernization.md) — 前端 UI 大迭代详细方案
- [02-steer.md](02-steer.md) — 对话中 Steer（类 Codex）详细方案
- [03-tools-mcp.md](03-tools-mcp.md) — ACC 工具库优化 + MCP 生态兼容详细方案
- [04-prompts-workflow.md](04-prompts-workflow.md) — 提示词与模型工作流规范化详细方案
- [05-other-directions.md](05-other-directions.md) — 安全 / 稳定性 / 性能 / 架构 / 测试 / 文档 / 发布等附加方向
