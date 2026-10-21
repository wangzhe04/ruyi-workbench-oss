# 界面原型与历史夹具

更新：2026-10-21。这里保留视觉基线、原型和仍被测试消费的历史夹具；HTML 原型不是产品入口，也不代表当前界面已经实现其中的每个设想。现行视觉约束见 [V4 设计](../UI-DESIGN-V4.md)，当前产品范围见 [86 号路线](../optimization-plan/86-3.1-completion-and-privacy-roadmap.md)。

| 文件 | 用途与保留原因 |
|---|---|
| [v4-glass-home](v4-glass-home.html)、[v4-glass-workbench](v4-glass-workbench.html) | V4 视觉基线；同目录 `_preview_v4-glass-*.png` 为配套预览图 |
| [one-workbench-two-views](one-workbench-two-views.html)、[steward-shell](steward-shell.html) | 两视角与管家视觉设计来源；生产 CSS／JS 注释仍引用这些固定路径 |
| [p2-refinements-r2](p2-refinements-r2.html)、[p3-workbench-r2](p3-workbench-r2.html) | 历史视觉来源，仍被生产注释与对应静态测试引用；原型中的布局不自动成为当前产品契约 |
| [vnext-poc](vnext-poc.html) | 旧交办台只读概念验证；`dev-harness/mission-index-gate.e2e.js` 仍读取此固定路径，保留为回归夹具 |
| [vnext-home](vnext-home.html)、[vnext-mission](vnext-mission.html) | 与 PoC 配套的历史设计；概念正文已归入 [历史文档](../archive/UI-VNEXT-CONCEPT.md) |
| [v4-turn-narrative](v4-turn-narrative.html) | [回合叙事历史设计](../archive/UI-ESCAPADE-TURN-NARRATIVE.md)的配套原型 |

本轮归档文档时保留这些资源路径，避免破坏实际测试消费者或视觉来源定位。若以后迁移，先更新消费者并执行相关回归；不要单凭文件名中的版本号删除它们。
