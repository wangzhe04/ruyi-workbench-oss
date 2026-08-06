# 如意 Ruyi 优化路线图（当前版）

> 本文只保留**当前发布线、发布准入与后续计划**；已交付波次历史移入 [`archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md`](archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md)（第46–86波）与 [`archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md`](archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)（第1–45波）。
> 当前要排期或实施的工作，以本文「后续计划」与 `docs/PRETENDER-PLAN.md` v4 为准。

---

## 发布线、产品代号与内部波次（2026-07-24 起）

对外发布与内部交付分开管理：**版本号告诉用户可安装、可回退、可比较的产品版本；波次只服务于研发拆解、验证和路线图追踪。**两者不再一一映射。

| 对外产品线 | 技术版本与 Git tag | 面向用户的写法 | 状态 |
|---|---|---|---|
| **Escapade** | `v2.x.y` | **如意 Ruyi Escapade 2.0**；修订版写作 Escapade 2.0.1、2.1 … | 当前大版本；`v2.4.1` 为当前发布版（2026-08-03） |
| **Pretender** | `v3.0.0` | **如意 Ruyi Pretender 3.0** | 已立项（第56波评审 GO）；五层门 P1✅ / P2✅ / P3 工程✅（正式人因验证待办），P4 3.0.0 默认切换与发布待办（第87–91波已用于交办台 UX 打磨，因人因验证未做暂缓） |

- Release 标题使用产品名与主次版本，不加冗余的 `V`；技术 tag 保持短、稳定且可供脚本解析（当前为 `v2.4.1`）。离线包也继续用短文件名（如 `Ruyi-v2.4.1-full.zip`），避免 Full 包在 Windows Explorer 的路径预算中失效。
- `第N波`、`Nx` 等只表示内部工作切片；一个 Release 可以汇总多波，一个波也可只在后续补丁版发布。只有范围冻结、测试与打包门通过后，才决定是 `2.0.x` 补丁、`2.x` 功能版本或下一主版本。
- 每个对外大版本以一个产品代号统摄体验目标；Pretender 3.0.0 发布前不把 Pretender 名/3.0 版本号混入用户界面、下载名或兼容承诺（PRETENDER-PLAN v4 §2.2）。

---

## 当前状态（2026-08-06）

| 线 | 状态 | 依据 |
|---|---|---|
| **Escapade 发布线** | `v2.4.1` 已发布（2026-08-03，含 wave 86 硬化、交办台 UX 第87–91波与 ACC v1.9.1） | `CHANGELOG.md`、git tag `v2.4.1` |
| **Pretender 3.0 交付线** | P1 Data & Contract Ready ✅；P2 Preview Ready ✅；P3 工程切片 81–85 全部收口 ✅，**正式外部受试者人因验证未执行**；P4 第86波硬化切片已交付，第87–91波用于交办台/任务单 UX 打磨并随 2.4.1 发布，3.0.0 默认切换因人因验证未做而暂缓 | `docs/PRETENDER-PLAN.md` v4、`docs/PRETENDER-METRICS.md` |
| **Traveler 4.0** | 概念稿 v0.1（非承诺） | `docs/TRAVELER-CONCEPT.md` |

---

## 发布准入（现行）

### Escapade 通用发布准入

每个候选版本至少通过以下门槛：

- **版本与构建**：版本三角（`package.json` / `00-boot.js` / `facts.json`）、构建新鲜度、源码 manifest 映射和生成物差异检查。
- **行为回归**：相关单元、E2E、DOM/IA、提示词快照与 A/B、权限和恢复路径回归；KNOWN_FAILURE 不得被静默扩张。
- **视觉与无障碍**：涉及 UI 的版本必须完成双主题、支持的界面模式、键盘和焦点验收。
- **离线交付**：Full/Slim 包完整性、checksum、全新目录启动、覆盖升级和回滚演练。
- **外部探针**：真实 provider、Claude CLI、远程 MCP/connector 明确标注通过、失败或未配置；skip 不能伪装为通过。
- **文档与迁移**：CHANGELOG、用户/管理员手册、兼容说明、数据迁移与恢复步骤和实现同步。

建议在每次范围冻结时给出一页 Release Brief，只回答四个问题：解决谁的什么问题、明确不做什么、怎样证明完成、失败后怎样恢复。


---

## 后续计划（第92波起）

> 第87–91波已用于交办台/任务单 UX 打磨（图标系统重设计、控件图标化、auto-grow、迷你进度条、metrics pill 化、间距令牌修复等），并随 Escapade 2.4.1 发布；3.0.0 默认切换未做，因正式外部受试者人因验证尚未执行（用户 2026-08-03 决定暂缓）。

### 第92波 · Pretender P4 第二切片 — 3.0.0 默认切换与发布（待办，暂缓）

按 `docs/PRETENDER-PLAN.md` v4 P4：新壳层默认开（经典可切）、版本三角 bump `3.0.0`（`00-boot.js` / `package.json` / `facts.json`）、CHANGELOG / USER-GUIDE / 发布物正名（解除 §2.2 品牌冻结）、发布门同 2.2/2.3 三门（范围冻结 / 测试 / 打包）。
前置条件：**P3 出门** — 正式外部受试者人因验证（打开任务到正确复述「离开后发生了什么」≤10s；可回滚/部分恢复/不可逆判断正确率 ≥90%，见 `docs/PRETENDER-PLAN.md` §3）；以及 **P4 硬化终审剩余项**（安全红队终审、性能终验、双主题/双语/a11y 终审、离线升级、数据迁移与恢复演练，第86波只交付了工程硬化切片）。

### post-3.0 退出线（不计入 3.0 交付工期）

新壳默认后第 1 个公开 Release 保留经典；最迟第 2 个公开 Release 且不晚于 3.0.0 后 6 个月进入强制退出评审（`docs/PRETENDER-PLAN.md` v4 §4 post-3.0 / C2）。门绿退出；仍有 P0/P1 红项则恢复经典默认或阻断下一公开 Release 并成文整改，不得按日历强删安全退路。

### Traveler 4.0（概念稿）

`docs/TRAVELER-CONCEPT.md` v0.1 已立（可迁移的任务旅程 / Portable Missions），非范围、版本或发布时间承诺；其实施不得抢占或稀释 Pretender 3.0 收口。

---
