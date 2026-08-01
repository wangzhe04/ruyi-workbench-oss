# Pretender 本机指标账

本文件只记录可复现的本机系统测量；不含遥测，也不把代理/自动化结果冒充真实用户的人因结论。指标定义以 [`PRETENDER-PLAN.md`](./PRETENDER-PLAN.md) §3 为准。

## 2026-08-01 · 第 79 波首测

| 指标 | 本次结果 | 证据与边界 |
|---|---:|---|
| 系统正确性 · change record 覆盖 | **9/9 类型，100%** | `pretender-return-archive.e2e.js` 依次播种 mission_started / progress / failure / budget / intervention pending+resolved / result / rewind / run_deleted；返回 9 条，重复 0、倒退 0、原始 cursor 保留 9/9。内部缺号、请求前缀缺失和损坏行均返回 degraded。 |
| 系统可达性 · 到待决任务事实 | **1 击，≤5s** | `pretender-shell.e2e.js` 从档案视图点击需要你的任务瓷章，任务单收活台在一次点击内显示真实 pending=1，并以浏览器 `performance.now()` 断言渲染 ≤5s。当前只是 Preview 的只读到达；直接决策仍按路线图留在第81波，不能据此宣称 Product Ready。 |
| 恢复可靠性 · 刷新/重启 | **2/2 场景，100%** | 数据面测试在服务进程启动后重读预先落盘的 9 条流水；浏览器测试验证 Preview/置顶/归档跨刷新恢复。故意破坏 UI-state 后 Mission 三张卡仍完整，只丢本机已读/置顶/归档位置。 |
| 人因理解 | **未测** | 按计划第80波前冻结受试者来源、脚本与问卷，第85波执行；本波没有外部受试者，不给出代理分数。 |

本次测量是 Wave 79 的首个系统基线，不是 P2/P3 放行结论。第80波需在规模数据集上复跑性能硬门；第85波才执行正式人因验证。

## 2026-08-01 · 第 80 波 Preview 放行复测

| 指标 | 本次结果 | 证据与边界 |
|---|---:|---|
| C1 · Preview 首次可交互 | **最大 1245.2ms** | `pretender-preview-performance.e2e.js` 在真实 Edge、禁用网络缓存、300 Mission / 200 可见任务卡下连续采样 3 次，结果为 1245.2 / 274.7 / 256.7ms，均低于 1500ms。服务启动即与配置及默认经典布局加载并行预热既有投影；空目录不缓存，后导入仍由首次权威读取发现。首批 40 卡同步出现，其余按帧补齐到 200 卡。 |
| C1 · Preview 视图切换 | **P95 66.6ms** | 同一真实浏览器在交办台与 200 行档案之间预热后采样 30 次，双 `requestAnimationFrame` 后强制布局，预算为 P95 <200ms；未变化的任务坞保持原 DOM，只同步选中态。 |
| C1 · 增量长输出 | **最大主线程间隙 66.8ms** | `pretender-task-sheet.e2e.js` 通过真实 fake-provider SSE 输出约 58KB，跨经典/Preview 切壳、上滑与终态重取；焦点、阅读锚稳定，>48KB 回答走有界纯文本收束，硬门 <750ms。 |
| 75c · 投影规模回归 | **全绿** | `pretender-index-scale.e2e.js` 复跑 300 Mission / 3万 Intervention / 10万 usage：列表冷 436ms、热 P95 1ms，详情冷 P95 295ms，全局收件箱冷 P95 255ms、热 P95 41ms，索引约 7MB。 |
| 恢复可靠性 · 投影故障 | **2/2 出口可用** | `pretender-shell.e2e.js` 用 CDP 阻断 Mission 投影请求，错误页同时提供重试和返回经典布局；返回后经典会话完整、布局偏好持久。关键 Preview 依赖缺失也 fail-closed 到经典布局。 |
| 响应式走查 | **1440 / 768 / 390 全绿** | 真实浏览器逐档覆盖 1440×1000、768×1024、390×844，断言无页面横向溢出、任务坞恢复按钮不被裁切、主视图保持可用尺寸。 |
| 人因理解 | **未测** | 本波只有脚本化 Preview 代理证据，不冒充外部受试者结论；正式理解速度与可逆性判断仍在第85波执行，因此不得宣称 Product Ready。 |

结论：第80波 C1、故障回退、文档和冻结命名门均通过，P2 可标记 **Preview Ready**；决策、反悔和完整控制面仍按第81–85波推进。

## 2026-08-01 · 第 81 波全局决策复测

| 指标 | 本次结果 | 证据与边界 |
|---|---:|---|
| 系统可达性 · 全局待决动作 | **1 击，4 类同一抽屉** | `pretender-needs-drawer.e2e.js` 在真实 Edge 从顶部事实一次点击进入全局抽屉；权限与 typed question 做真实送达，plan/pool 由同一渲染/统一命令静态门覆盖。待决列表按服务端 FIFO 投影，不建立第二份业务状态。 |
| 安全 · 批准确认 | **2 次明确动作，零默认批准** | 真实权限旅程第一次 Allow 只进入原位确认，权威 Intervention 仍为 pending；第二次 Confirm 才变为 allowed。问题卡初始 checked=0；静态门覆盖 permission/plan/pool 的 allow/approve 均走二次确认。 |
| 一致性 · 跨壳同步 | **2/2 实旅程通过** | 权限与问题均在经典布局产生、切到 Preview 决策；终态后隐藏的经典 modal 立即退场，回到经典无陈旧待决表面，provider 回合收到 typed answer 后继续。同步退场不触发 cancel 路径。 |
| 恢复语义 · 幂等与冲突 | **沿用 75b 全绿** | Preview 网络重试保存原 request 对象及 idempotencyKey；既有 `interventions-persist.e2e.js` 证明同 key 返回原响应，不同 key 命中终态 409，未重复执行。 |
| 停止恢复入口 | **3 个诚实动作** | 停工卡读取 `mission.result` 的未完成项；再试/换法子只打开经典布局并预填未发送草稿，先算了只改本机归档状态，不伪造 Mission 恢复。 |
| 响应式 | **390×844 全绿** | 真实浏览器在窄屏打开 typed question 抽屉，断言抽屉和页面均无横向溢出。 |
| 完整回归 | **185 pass / 0 fail / 0 flaky** | 全量串行门同时通过 unit、构建新鲜度和 22 个带内端口零冲突审计；另有 6 个真实外部环境 live probe 按清单跳过。 |
| 人因理解 | **未测** | 本波仍是脚本化系统证据；反悔柄、班组/叙事镜头、收工闭环与正式受试者验证未完成，因此不得宣称 Product Ready。 |

结论：第81波全局决策与停工卡闭环通过系统门；P3 仍需第82–85波全部完成后才能评估 Product Ready。
