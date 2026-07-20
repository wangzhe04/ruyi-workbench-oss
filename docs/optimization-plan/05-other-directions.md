# 05 · 附加优化方向（安全 / 稳定性 / 性能 / 架构 / 测试 / 文档 / 发布）

> 四大确定方向之外，8 路分析识别出的高价值补充方向。按主题组织，每条均附证据与建议波次。

---

## 安全

> 对一个主打"政企可审计、气隙优先"的产品，安全项永远排在功能之前。好消息是 P0 级（DNS rebinding / 命令注入 / 文件工具边界）已在第 33 波前清零，以下是残余纵深。

| # | 事项 | 现状与证据 | 方案要点 | 建议 |
|---|------|-----------|----------|------|
| S1 | **token 随 HTML 明文注入** | `01-config.js:1357-1360` `__WCW_TOKEN__` 替换；WAVE33 §5 标"择期"。host 门已断主泄露链但残留 | 改 sessionStorage/Bootstrap 通道（先 POST 换一次性 bootstrap token 再注入页面）；前端 `net.js` 从 meta 读取改为启动握手 | W45 |
| S2 | **shell 沙箱只做了 L1** | L2（package.json scripts 变更→检查点标 `autoexec:true`+审计）与 L3（autoexec 分类表+UI 高亮）未实施；代码仅 L1 denylist（`03-bridge-guard.js:463-504`） | 按 WAVE31-SHELL-SANDBOX-DESIGN.md §6.3/6.4 施工；"潜伏 RCE 可视化"是政企卖点 | W46 |
| S3 | 前端无 CSP 头 | index.html 仅 meta token | 补 CSP meta（script-src 'self' 等，marked/hljs 为本地 vendor 无冲突） | W45 |
| S4 | 自写 `sanitizeNode` 白名单 | `app.js:99-142` | 评估换 DOMPurify（本地 vendor 化保持零运行时依赖），或至少跟进最新绕过模式的测试用例 | W47 |
| S5 | 14 处 handler tokenOk 自查冗余 | WAVE33 §5，ROUTE_AUTH 表已覆盖 | 清理波：删冗余纵深，防"表外自查"漂移成漏判 | W47 |
| S6 | SSRF 注释漂移 | `11-native-tools.js:898` 注释称 DNS-rebinding "已知限制 deferred"，下方其实已修（:1062-1085） | 注释修正（一行，但误导审计者） | 随手 |

## 稳定性与核心引擎

| # | 事项 | 现状与证据 | 方案要点 | 建议 |
|---|------|-----------|----------|------|
| R1 | **上下文压缩 v2 收尾**（最大在途项） | 4 缺陷中 44c 只修了子代理重试探针；摘要载荷无界死锁角、L2 失败=回合慢性死亡、Claude 超窗兜底、摘要质量无度量待第 45 波（roadmap:814-818/922）；`10-context-governance.js` 有未提交改动 | 按 roadmap §37.0 既定规格收尾 + 摘要质量评测夹具（与 04 方案 Phase A 共建） | W45 |
| R2 | **限流原语薄弱** | 无 Retry-After 解析、无自适应并发（roadmap §10 ⑤c） | provider 引擎 failover 链加 Retry-After 尊重 + 429/5xx 自适应并发降档 | W46 |
| R3 | **权限暂停无人感知** | AUTONOMY-PLAN.md:49 设计了 PowerShell 内建通知，只落地了 `permission_paused` 流事件（`07-autonomy.js:684`）；跨进程重启暂停不续（roadmap:471） | Windows toast 通知（PowerShell BurntToast 免依赖方案或 msg）；暂停状态持久化续传 | W46 |
| R4 | 双冷 resume 窄窗、事件文件无上限、digest 每 tick 全量读盘、autoResume 每 run 全量扫事件 | roadmap:487 #1/#3/#5/#20 | 长事件史场景的性能-稳定复合修复；事件文件加字节偏移续读 | W47 |
| R5 | 慢节点/关键路径/失败热点分析缺失 | 29c 只补了 errorClass 失败分类 | 编排分析面板：节点耗时分布/失败聚类，复用 `/api/metrics` 与 usage ledger | W48 |
| R6 | worktree 冲突无应用内 diff/合并 UI | 只 `cherry-pick --abort` + 回传 git stderr（`07-autonomy.js:1534-1539`），§10 ① 唯一缺口 | 冲突文件三栏 diff 查看器（复用消息流 diff 卡渲染）+ 手工解决后续跑 | W48 |

## 性能

| # | 事项 | 证据 | 方案要点 | 建议 |
|---|------|------|----------|------|
| P1 | `readConfig` 无缓存、每请求读盘 | `01-config.js:589-601`（PF4，自 roadmap:98 起"仍开放"） | 内存缓存 + 写时失效（`POST /api/config` 单写点，失效简单） | W46 |
| P2 | `verifyManifest` 全包 SHA-256 每请求 | `12-tool-dispatch.js:800`（PF5，同开放） | mtime+size 快路径 + 降频全量校验 | W46 |
| P3 | 前端轮询全量重建 | `renderAgentRuns` 2s 全清重建（`app.js:3620`） | digest 驱动增量渲染（digest 概念已在 `app.js:7996-7999`）；见 01 方案 Step 1 | 随 01 |
| P4 | 压缩校准数据不外露 | `context-calibration.json`（`10:81-143`） | 暴露给 UI 上下文电量表，让用户看见估算精度 | 随 01 |
| P5 | 剩余 46 件固定端口 e2e 迁 `getFreePort()` | dev-harness 端口审计 | 迁完后本地常态 `--parallel 4`，全量反馈 ~25min→个位数分钟 | W46 |

## 架构与代码健康

| # | 事项 | 证据 | 方案要点 | 建议 |
|---|------|------|----------|------|
| A1 | **后端巨函数/模块名实漂移**：`handleApi` 1262 行（13:1-1263）、`runOpenAiTurn` 895 行（09:796-1691）、`runAgentWorkflow` 675 行、`runClaudeTurn` 546 行、`runSubAgentCore` 446 行；01 内含鉴权表、05 尾部混入 provider preset、07 开头 700 行是记忆库、13 混路由+schema+启动 | 分区 D 报告 | 按域拆 handleApi（steer/agent-runs/mcp/checkpoint 各自成组）；模块按实重命名或拆分；`module.exports` 100+ 内部函数（14:25-251）与 reducer 源抽取机制是现成的重构安全网 | W47–W48（与 02/03 改动同域时顺手拆） |
| A2 | **前端巨文件**（app.js 8175 行） | 见 01 方案 §1.2 | FE Phase 2，见 01 方案 Step 1 | W46 |
| A3 | 坏味道清单：`createSession` 用 `arguments[0]`、`maskProviders/unmaskProviders` 兼容包装残留、`WCW_FAKE_CLAUDE` 测试缝散落三处、`MODEL_PRESETS` 空壳 | `02:931`、`05:764-765`、`13:1486-1488` | 随邻近改动顺手清理，设静态锁防复发 | 各波顺带 |
| A4 | 前端浮层双原语、原生 prompt/confirm | `app.js:7292/2580/3220` | 合一为带 focus-trap 的 modal 原语 | 随 01 |

## 测试与工程化

| # | 事项 | 证据 | 方案要点 | 建议 |
|---|------|------|----------|------|
| E1 | **共享 test-kit 抽取**：health/getToken/postJson/stream/writeConfig/taskkill 约 40–50 行在几十件 e2e 里逐字重复；内联 fake-openai SSE emitter 多处复制 | 分区 H 报告 | `dev-harness/kit.js` + fake 工厂 + 跨平台 killTree（顺带解 Windows-only 清理，为 Linux CI 铺路） | W46 |
| E2 | **unit/ 是孤儿**：5 件 node:test 未接 runner 与 CI；`port-audit.test.js` 测的是复制重实现的副本 | `unit/port-audit.test.js:11-40` | run-all 快通道前跑 `node --test`；portAudit/stripJsComments 抽成可 require 真身 | W45 |
| E3 | **flake 治理**：无重试机制，TIMEOUT 一刀切 120s；scheduler-ready-queue 疑似时序 flake | `run-all.js:21` | 失败自动重跑一次并标 `[flaky]`；按件超时表 | W45 |
| E4 | **CI 扩展**：无 Linux job、无打包验证 job、action 未钉 SHA、CI 注释与串行现实矛盾 | `.github/workflows/e2e.yml:27-33` | ubuntu 静态+进程内件 job；release-dryrun（build-overlay+gen-manifest+pkg 冒烟）；`permissions: contents: read` + 钉 SHA；注释对齐 | W46 |
| E5 | **浏览器渲染/截图回归缺失** | Playwright 已捆绑却零真实渲染验证（roadmap:151/849） | 见 01 方案 Step 3，视觉回归门 | 随 01 |
| E6 | **ACC 测试不入 runner**：5 件 smoke 脚本无统一入口 | mcp tests/ | pytest 收拢 + 发版门禁；fake-mcp 扩 20 工具契约 | 随 03 |
| E7 | **工程化空白**：无 eslint/prettier/类型检查；根目录无 package.json；`engines:>=20` 与 syntax-gate 需 Node≥22 不一致 | `package.json`、`syntax-gate.js:5` | 零依赖纪律下引入 dev-only eslint（devDependencies 不违背运行时零依赖）；Node≥22(dev)/≥20(runtime) 双轨写进 CONTRIBUTING | W47 |
| E8 | 仓库卫生：6 个 `.codex-e2e-failure-*` 残留目录未 ignore | 项目根 | .gitignore + 清理 | 随手 |

## 文档治理

| # | 事项 | 证据 | 方案要点 | 建议 |
|---|------|------|----------|------|
| D1 | **门面数字五口径并存**：原生工具数 39/40/43、ACC 99/100，README 内部即不一致，营销全套冻结在 v1.6.5 | README:35/95/122、COPYBOOK:75、TOOL-LOADING:19 等 | 建 `facts.json` 单一事实源（工具数/模板数/e2e 数/版本号/ACC 版本），构建或发布脚本注入校验；营销包随发版刷新列入检查单 | W45 起步，之后每发版自动 |
| D2 | **文档版本基线漂移**：ARCHITECTURE_CN 自称基线 1.6.1（落后 6 版，与会话存储 v2 矛盾）；OFFLINE_DEPLOYMENT 与 README 浏览器能力矛盾；mcp/README 与离线包现状矛盾；APPLY-OVERLAY.md 停在 v0.4.2 旧品牌 | 分区 C/H 报告 | 一轮"基线刷新"波：每份文档头部标版本基线 + 状态（当前/历史）；过期段落改写或标注 | W46 |
| D3 | **设计文档生命周期缺失**：五份 UI 设计稿四份已竣工仍自称"设计稿" | 分区 B 报告 | docs/README.md 状态标注（设计稿→已竣工→归档），附对应波次 | 随 01 Step 0 |
| D4 | **英文文档严重不对称**：ARCHITECTURE_EN 仅 2.8KB（CN 43KB 的摘要）；SKILLS-CATALOG/TOOL-LOADING 无英文版 | 分区 C 报告 | 至少补 ARCHITECTURE_EN 的引擎/信任层/数据目录三节 | W48 |
| D5 | CHANGELOG 对 v1.6.5 前 40+ 波只有一段指引 | CHANGELOG.md:66 | 补每版一行的时间线（从 roadmap 逐波日志提取） | W47 |
| D6 | README 目录结构未列 i18n/、marketing/ 与五份设计稿 | README:311-334 | 补齐 | 随 D1 |
| D7 | 行号引用大面积漂移（server.js 单体时代行号在 43 波模块化后失效） | OPTIMIZATION-ROADMAP 全文 | 新文档一律用"模块文件:行号 + 就近搜索"约定；旧文档不批量改，头部加漂移声明 | 立即（约定先行） |
| D8 | 营销审校口径：出现"Fable 5"个人化模型代称 | PLATFORM-CAMPAIGNS.md:45 | 统一对外审校标准，随 D1 数字刷新一并处理 | 随 D1 |

## 发布与产品扩展

| # | 事项 | 证据 | 方案要点 | 建议 |
|---|------|------|----------|------|
| X1 | **overlay 更新 GUI**（性价比最高的发布项） | 无 `/api/overlay` 路由；roadmap:237 有完整两阶段调研；当前靠 Manage-Overlay.ps1 手工且端口硬编码 8765/8799（:60/:101） | v1：应用内上传 zip + check/preview/verify API + 前端向导（一周内可落地）；v2：supervisor 父进程解决自举；Manage-Overlay 端口改读配置 | W48 |
| X2 | **overlay 载荷机械校验**：PAYLOAD_FILES 手工枚举，曾因漏发 js 模块白屏 | `build-overlay.js:29-45` 自承 | "实际文件集 vs 白名单"漂移即红的静态锁；APPLY-OVERLAY.md 模板化按版本生成 | W45 |
| X3 | 定时/周期任务、Hooks、语音输入输出、记忆导出/同步、Playbook SKILL.md 化、工作流节点技能注入 | roadmap:277/§8 产品扩展欠账 | 逐独立立项；其中"定时任务"与自主推进调度器同根，成本最低 | W49+ 评估 |
| X4 | Kimi Coding Plan 等新 provider 的提示词适配验证 | CHANGELOG v1.6.7 | 纳入 04 方案 A/B 基准集的模型矩阵 | 随 04 |

---

## 附：跨方向依赖关系图

```
W45 快赢 ─────────────────────────────────────────────
  Steer Phase A (02)          ┐
  桥 cancel/超时修复 (03) ─────┼─ 共享 stdin/cancel 基础设施
  安全 S1/S3、E2/E3、X2、D1   ┘

W46 地基 ─────────────────────────────────────────────
  01 Step 1 前端架构拆分 ──────→ 解锁 01 Step 2 视觉焕新
  04 Phase A 评测护栏 ─────────→ 解锁 04 Phase B/C 文本与结构改动
  03 配置导入器 v1              （独立）
  性能 P1/P2、S2、R2/R3        （小项填充）

W47 生态 ─────────────────────────────────────────────
  03 ACC 收敛 + 新工具首批 ────→ 04 工具 description/能力层话术需同步
  A1 后端拆分（与 02/03 同域顺手）

W48 焕新 ─────────────────────────────────────────────
  01 Step 2/3 视觉与守护 ──────→ 营销截图重拍（D1 联动）
  04 Phase B/C/D
  X1 overlay GUI v1

W49+ 范式 ────────────────────────────────────────────
  vNext 立项决策（01 Step 3 决策点）
  X3 产品扩展逐项评估
```
