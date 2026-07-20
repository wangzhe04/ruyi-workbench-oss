# 01 · 前端 UI 大迭代方案（现代毛玻璃质感 / 简洁清爽 / 明暗双模式）

> 对应所有者确定方向 1。视觉目标已由所有者明确：**现代、带精致毛玻璃（Glassmorphism）质感的界面与图标，告别现在"大片纯主色调平铺"的旧态**。
> 核心判断：**视觉资产已经够用（token 体系 + `color-mix` 全覆盖 + currentColor 图标集，做毛玻璃只需加材质层，不用推倒重来），架构债才是真正的拦路虎**。正确顺序是"先收敛设计基线 → 架构拆分 → 视觉焕新 → 自动化守护上线"。

---

## 1. 现状盘点

### 1.1 可复用资产（这次迭代的家底）

- **完整设计 token 体系**（`styles.css:65-176`）：间距 `--sp-1..8`、字号 `--fs-xs..2xl`（rem 阶梯）、圆角、动效三档、`--elev-1/2/3`、语义色 `-bg/-fg/-veil` 全部 `color-mix` 派生；`[data-density]` 密度联动 `--tap-min`。
- **明暗双主题键集完全对称**：`<html data-theme>` + `index.html:14-39` 内联预绘防闪 + `localStorage wcw.theme` 持久 + hljs 深浅联动（`app.js:159-167`）。青花蓝 + 鎏金品牌，"墨夜"/"月白"双底。
- **SVG 图标集**：`js/icons.js` 约 28 枚 currentColor 线性图标，换肤零成本。
- **三代设计稿与 6 个双主题 mockup**：`UI-ORCHESTRATION-REDESIGN.md`（已落地）、`UI-DESIGN-V3.md`（波次表已清空）、`UI-DESIGN-P3-WORKBENCH.md` + `R2-NOTES`（已落地，§6 十条验收全过）、`UI-VNEXT-CONCEPT.md`（**唯一未落地的概念稿**，含 70% 渲染资产可平移评估与三步渐进置换路线）。
- **机械化护栏**：`theme.e2e.js` 双主题 token 键集一致 + WCAG 对比度红线；`ui-v3-p1/p2/p3a/p3b` 五件静态锁；`dom-contract.e2e.js` 92 项关键 id 契约。

### 1.2 主要问题（按对"现代化大迭代"的阻碍程度排序）

| # | 问题 | 证据 | 阻碍 |
|---|------|------|------|
| P1 | app.js 8175 行 / 442 函数共处一个模块作用域，跨域互调；FE Phase 1 只拆出 5 个小模块 | `app.js`、`js/state.js:7` 注释自承"纯搬家" | 任何视觉重构都要跨全文件摸石过河 |
| P2 | 整树重建渲染：`renderCurrentSession` innerHTML 全清；`renderAgentRuns` 每 2s 全量重建靠前序快照保展开态 | `app.js:887`、`3245-3252`、`3620` | 新 UI 组件越丰富越卡 |
| P3 | i18n 未竟：约 60 处硬编码中文 toast；`wbSteerBox`/`wbPoolBody`/`wbMailBody` 整段硬编码中文；`TOOL_VERB_MAP` 中文硬编码 | `app.js:4195-4270`、`2695-2711` | 英文界面露中文，"清爽"无从谈起 |
| P4 | 可访问性缺口：消息流无 `role="log"`/aria-live；大量 `div+cursor:pointer` 键盘不可达；模态框 focus-trap 缺失 | `styles.css:1145/1185/1750`、roadmap:337 | 现代化 UI 的基本面 |
| P5 | 视觉细节旧态：emoji 按钮字符（🧸🔧🌙）、popover/modal 两套浮层原语、仍有 `prompt()`/`confirm()` 原生弹窗 | `app.js:165/191`、`7292`、`2580`、`3220` | 直接拉低"现代感" |
| P6 | 死令牌与漂移：`--density-scale`/`--gold-soft`/`--sp-7` 零引用；mockup token 停留在 px 时代快照 | `styles.css:50/58/59`、mockups | 设计系统可信度受损 |
| P7 | 双主题靠人肉守护：无截图对比回归、无 AA 自动校验 | 分区 B/H 报告 | 改版后无人兜底 |
| P8 | 布局脆弱史：grid + `display:none` 曾致轨道错位/输入框消失 | `styles.css:289-295` 注释 | 增删子元素需谨慎模式化 |

## 2. 总体策略：四步战役

```
Step 0  设计基线收敛（文档与 token，1 波）
Step 1  架构还债 FE Phase 2（1–2 波，与视觉解耦）
Step 2  视觉焕新（1–2 波，明暗双模式同步）
Step 3  守护上线 + 精修（1 波，含 vNext 决策点）
```

---

## 3. Step 0 · 设计基线收敛

1. **文档生命周期标注**：在 `docs/README.md` 给五份 UI 设计稿标注状态（ORCHESTRATION=已竣工、V3=已竣工、P3-WORKBENCH+R2=已竣工、VNEXT=概念待立项），消除"定稿与概念不分"（当前新贡献者必须交叉 140KB roadmap 才能确认状态）。
2. **确立本轮视觉方向**（所有者已明确：**现代毛玻璃质感**，写进一份 `UI-DESIGN-V4.md` 定稿后再动工；以下为施工级设计规格）：

   ### 3.2-A 总体语言：从"纯色平铺"到"分层磨砂"

   现状问题是"大片纯主色调"：面与面之间靠纯色块切割，厚重、平、旧。新语言改为三层材质体系——**底层有景、中层磨砂、上层点睛**：

   - **底层（Scene）**：应用背景不再是单一平色。暗主题用"墨夜深空"微渐变（藏蓝墨 → 深空灰对角缓变，可加极轻噪点/云纹 mask 防色带）；亮主题用"月白晨雾"微渐变（月白 → 淡青灰）。**底层有内容，毛玻璃的模糊才有意义**——这是玻璃感成立的前提。
   - **中层（Glass）**：侧栏、顶栏、composer 容器、右栏面板、浮层（modal/popover/toast/命令面板）统一改用半透明磨砂材质：`backdrop-filter: blur()` + 半透明底色 + 1px 半透明描边 + 顶部 1px 内高光（玻璃的边缘光）。
   - **上层（Accent）**：青花蓝从"大片铺底"收敛为**点色**——只用于主按钮、激活态、焦点环、关键数据；鎏金仅保留授权/信任语义。语义色（成功/警告/危险）降饱和一档。

   ### 3.2-B 玻璃材质 token 化（双主题对称，全部 `color-mix` 派生）

   新增材质 token 族（命名示意，值在设计稿标定，明暗双主题对称落盘，沿用 `styles.css:65-176` 的现有结构）：

   | token | 用途 | 暗主题方向 | 亮主题方向 |
   |-------|------|-----------|-----------|
   | `--glass-bg-1/2/3` | 三档玻璃底色（面板/浮层/卡片） | `color-mix(white 4%~8%, transparent)` 系 | `color-mix(white 55%~75%, transparent)` 系 |
   | `--glass-border` | 玻璃描边 | 半透明白（8%~12%） | 半透明墨（8%~10%） |
   | `--glass-highlight` | 顶部内高光（inset shadow 实现） | 白 6%~10% | 白 60%~80% |
   | `--glass-blur-1/2/3` | 三档模糊半径（如 8/16/24px）+ saturate(1.2~1.4) | 同左 | 同左 |
   | `--glass-shadow` | 浮起投影（比 `--elev` 更柔更远） | 黑 30%~40% | 墨 8%~14% |
   | `--scene-bg` | 底层微渐变（含云纹/噪点 mask 引用） | 深空渐变 | 晨雾渐变 |

   纪律：玻璃材质**只能写在 token 与组件类上**，禁散写 `backdrop-filter` 字面量（token 静态锁机械约束）。

   ### 3.2-C 材质分档：哪里用玻璃，哪里不用

   | 档 | 表面 | 材质 |
   |----|------|------|
   | 玻璃一档（blur 大） | 浮层族：modal、popover、命令面板、toast、右键菜单 | `--glass-bg-2` + blur-3 + `--glass-shadow` |
   | 玻璃二档（blur 中） | 框架族：顶栏、侧栏、右栏、composer 容器 | `--glass-bg-1` + blur-2，贴边侧无圆角 |
   | 玻璃三档（blur 小或无） | 卡片族：消息卡、tool 卡、工作台节点卡、设置卡 | `--glass-bg-3` + blur-1（列表内大量出现时降级为半透明纯色，见性能节） |
   | 非玻璃 | 正文阅读区、代码块、diff 区 | 实色（阅读面不磨砂，保证长时间阅读舒适与对比度稳定） |

   克制原则：玻璃是"框与浮"的材质，**内容阅读区一律不实心磨砂**；同屏玻璃表面数量有限制（见 3.2-E）。

   ### 3.2-D 图标与细节精致化

   - **图标规范升级**（`js/icons.js` 现有 28 枚 currentColor 线性图标为基座）：统一描边粗细（1.5px @16 网格）、圆角线帽线脚、统一视觉重心；高频动作图标（发送/停止/主题/设置）精修；状态图标补"线性→填充"双态；新增图标必须走同一网格规范并过静态锁。
   - **emoji 清零**：按钮字符 emoji（🧸🔧🌙 等，`app.js:165/191`）全部替换为 SVG；v3 §2.15 的 emoji 保留区（playbook/toast）一并评估替换，最终"界面控件零 emoji"。
   - **圆角与动效**：圆角统一 `--r` 阶梯（玻璃表面圆角与模糊半径成比例，大浮层大圆角）；hover 微交互统一原语（translateY(-1px) + 阴影加深 + 玻璃底色微提亮，三档 `--dur`）；焦点环用青花蓝外发光式 ring（`--glow-accent` 推广）。
   - **字阶与数字**：`.num` 仪表数字推广到用量/指标处；正文/辅助两级灰阶拉开；中文排版行高与段距按"清爽"目标重标定。

   ### 3.2-E 性能与降级（毛玻璃的头号工程约束）

   - **模糊预算**：同屏 `backdrop-filter` 表面 ≤ 6 个（框架族 3-4 + 浮层 1-2）；卡片族在消息流/列表场景**自动降级为半透明纯色**（`--glass-bg-3` 不带 blur），由容器类 `data-glass="off"` 统一切换。
   - **合成层纪律**：玻璃元素禁滥用 `will-change`；浮层动画只动 transform/opacity；blur 半径三档封顶 24px。
   - **降级路径**：`@supports not (backdrop-filter)` 或用户开"低性能模式"时，token 级回退为近似实色（`color-mix` 提高不透明度），视觉差异可接受、布局零变化；`prefers-reduced-transparency` 媒体查询同样回退实色。
   - **对比度兜底**：玻璃上文字对比度按"最坏背景"（渐变最亮/最暗端）合成后断言 WCAG AA，纳入 theme.e2e.js 红线族——玻璃材质的可访问性不能靠运气。

   ### 3.2-F 配套刷新

   - **色彩纪律**：亮主题整体提亮背景层级、暗主题压掉纯黑底（`color-mix` 已全覆盖，改 token 即可）；语义色降饱和；青花蓝收敛点色后，现有"大片主色"区域（侧栏选中态、按钮族、chip 族）逐一改为"玻璃底 + 点色描边/文字"的新范式。
   - **mockup 先行**：新增 `docs/mockups/v4-glass-home.html` 与 `v4-glass-workbench.html` 双主题毛玻璃原型（**已产出并经 Chromium 双主题截图验证**，预览图 `_preview_v4-glass-*_{dark,light}.png`），token 值在原型上调好后回写 `styles.css`；旧 6 个 mockup 同步刷新到 rem 基线并加 CI 漂移校验。
3. **token 清障**：删除或启用 `--density-scale`、`--gold-soft`、`--sp-7`；把 4 处硬编码 `#fff`（`styles.css:222/505/1157/1435`）token 化。
4. **mockup 刷新**：6 个 mockup 的 token 块更新到 rem 基线并加 CI 漂移校验（mockup 自称"照抄 app token"，正好机械断言）。
5. **CSS 分层拆分**：2225 行单文件按 `tokens / base / components / views / themes` 拆分（构建期拼接或直接多文件引入，与 server.js 的 manifest 拼接同款思路）。

**验收**：`UI-DESIGN-V4.md` 定稿（含 §3.2-A~F 全部 token 值与分档表）；两个 v4 毛玻璃 mockup 双主题评审通过；token 静态锁全绿且无零引用令牌；mockup 漂移锁上线。

## 4. Step 1 · 架构还债（FE Phase 2）

> 原则：**纯搬家、零视觉变化**，用 dom-contract 与静态锁保证行为不变。先做这轮，视觉焕新才不会变成"在泥地上盖楼"。

1. **按域拆模块**（建议边界，沿用现有 `js/` 目录）：
   - `js/chat/`（消息流渲染、流式、markdown、tool-card）
   - `js/composer/`（输入区、附件、技能、拖放）
   - `js/workbench/`（DAG 画布、三段板、插话框、任务池、邮箱）
   - `js/settings/`（7 页签）、`js/sidebar/`、`js/panels/`（右栏 12 页签）
   - 拆分顺序建议：先体量大且相对独立的 workbench（`app.js:3818` 起的画布族）与 settings，再 chat。
2. **state 集中化 + 最小订阅**：消灭散布的模块级单例（`activeTurns`、`sessionAllow`、`steeredSeen`、`wbState`、`usageState`）与 12 个 `wcw.*` localStorage 键的散读写；做一个 30 行的事件 emitter（订阅/发布），替换 `i18n:change` 手动枚举 20+ 重绘调用（`app.js:46-86`）的脆弱模式。
3. **渲染优化**（为 Step 2 的更丰富 UI 预备性能）：
   - `renderAgentRuns` 改 digest 驱动增量渲染（`loadAgentRuns` 已有 digest 概念，`app.js:7996-7999` 注释）；
   - 静态消息 markdown 渲染结果缓存（`renderMarkdown` 不再每次全量 parse）；
   - 长列表（会话/审计/文件树）引入轻量虚拟化或分页；
   - 轮询按页面可见性降频（`agentRunsPollWanted` 开关雏形已在 `app.js:3614`），中期可合并为 SSE。
4. **原语合一**：popover 与 buildModal 两套浮层合并为一套（含 focus-trap、ESC、焦点归还）；`prompt()`/`confirm()` 原生弹窗全部替换为应用内 modal。
5. **测试契约升级**：`dom-contract.e2e.js` 从"正则断言源码字面"逐步改为 `data-testid` 语义契约，解放后续重构（否则每一步搬家都被文本级断言绑死）。

**验收**：app.js 降至 3000 行以下、各域模块边界清晰；全量 e2e 绿；dom-contract 迁移至少覆盖 chat 与 workbench 两域。

## 5. Step 2 · 视觉焕新（明暗双模式同步）

1. **落地顺序（玻璃材质的工程铺法）**：
   1. 先铺底层 `--scene-bg` 微渐变（双主题）——玻璃之"景"，纯 token 改动，风险零；
   2. 再上浮层族玻璃一档（modal/popover/命令面板/toast）——数量少、视觉冲击最大、性能风险最小；
   3. 然后框架族玻璃二档（顶栏/侧栏/右栏/composer）——需处理贴边圆角与滚动条穿玻问题；
   4. 最后卡片族玻璃三档 + 列表降级逻辑（`data-glass="off"`）；
   5. 青花蓝"点色化"收口：逐区域把大片主色铺底改为"玻璃底 + 点色描边/文字"。
2. **主题体验升级**：
   - 主题切换从"⋯"菜单提升为顶栏可见控件（SVG 太阳/月亮）；
   - 新增"跟随系统"档：`prefers-color-scheme` 监听 + 预绘脚本已留 `color-scheme`（`index.html:6`），三态（明/暗/系统）持久化到 `wcw.theme`；
   - **双主题玻璃差异化走查**：暗主题玻璃靠"提亮"（白 4%~8% + 亮描边），亮主题玻璃靠"留白 + 柔影"（白 55%~75% + `--glass-shadow`）——两种模式各自标定，禁止一套值双边复用；`--glow-accent` 亮主题更克制（`styles.css:171`）这类差异化实践整理成走查表逐组件过。
3. **简易/专业双模式一致性**：`data-ui-mode` 双界面（`styles.css:1300-1358`）在设置弹窗/体检/错误文案全线对齐（roadmap 遗留的"漏收敛"项）；简易模式是"非程序员"门面，玻璃材质与清爽度优先在此模式验收。
4. **信息架构精修**：顶栏 chip 群降噪、右栏 12 页签分组或收敛、命令面板入口提权；消息流卡片（thinking/tool/diff/plan）视觉层级按新设计稿统一（注意：diff/代码块保持实色阅读面）。
5. **营销与文档同步**：README hero 明暗截图、docs/screenshots 全套、`marketing/render_campaign.py`（:139/238 直接粘贴 hero 图）随新 UI 重拍——毛玻璃质感是营销素材的核心卖点，截图必须体现层次感，列入改版验收。

**验收**：双主题走查表逐项过；截图全套更新；简易/专业模式不一致项清零。

## 6. Step 3 · 守护上线与 vNext 决策

1. **视觉回归门（本轮必做，"两种颜色模式都要"的机械化保障）**：
   - 双主题截图对比 e2e：Playwright 已捆绑（fake-mcp 旁注显示"浏览器自动化运行环境恢复后补跑"是 i18n 的既有待办），可先静态页（设置/工作台/技能库）后动态流；
   - WCAG AA 对比度自动断言扩展到全部语义色组合（theme.e2e.js:94-112 已有红线范式）；
   - "新组件两主题对称"写入静态锁与贡献指南。
2. **i18n 清零**：60 处硬编码中文 toast、`wbSteerBox`/`wbPoolBody`/`wbMailBody`、`TOOL_VERB_MAP` 全部走 `t()`；index.html 静态区补 `data-i18n`；伪本地化截图回归重跑（i18n/README.md:115 既有待办）。
3. **可访问性 P0**：消息流 `role="log"` + aria-live 流式播报策略；`div+cursor:pointer` 交互元素改 `<button>` 或补 tabindex/keydown；模态框 focus-trap；hover-only 操作的键盘等价路径。
4. **vNext 决策点**：是否启动「交办台」三步置换（V1 坞与案头 → V2 任务单 → V3 需要你+叙事）。已知前提：
   - §5 评估 70% 渲染资产可平移，但 vnext mockup 类名体系（`coin-char/nd/ld-*`）与现行 `.wb-*` 零共享，须先解合并；
   - 「需要你」收件箱需后端 `/api/missions` 聚合 + 权限 prompt 状态化，成本中等偏大；
   - §6.5 预警"双壳并存维护税"：并存死线 ≤2 个 release，开关退役机制先设计。
   - **建议**：本轮大迭代先不动壳层范式；vNext 作为 W49+ 独立立项，以"反悔柄"三原语中价值最高的先做概念验证。

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 架构拆分引入回归 | 纯搬家纪律 + 141 件 e2e 全量 + dom-contract 语义化先行 |
| **毛玻璃性能塌方**（backdrop-filter 同屏过多致滚动/动画掉帧） | §3.2-E 模糊预算（同屏 ≤6）+ 卡片族列表场景自动降级半透明纯色 + blur 三档封顶 24px；性能 e2e（perf.e2e.js）加滚动帧率抽查 |
| **玻璃上文字对比度不达标**（半透明合成后不可控） | 按"最坏背景"合成后做 WCAG AA 断言并入 theme.e2e.js 红线族；阅读区（正文/代码/diff）禁用磨砂 |
| **玻璃感过头变"花哨"**（与简洁清爽目标冲突） | §3.2-A 克制原则写入设计稿：玻璃只用于"框与浮"，青花蓝只作点色；设计评审以"长时间使用不疲劳"为准绳 |
| 旧浏览器/低性能机器无 backdrop-filter | token 级实色回退 + `prefers-reduced-transparency` + 低性能模式开关，布局零变化 |
| 布局脆弱史重演（grid/display:none 事故） | 布局模式写进贡献指南：主区域显隐用 `data-main-view` 状态机（`styles.css:1899-1905` 既有模式），禁新增 grid 轨道变量 |
| 双主题改版后无人兜底 | Step 3 视觉回归门与改版同步上线，不留窗口期 |
| 截图/营销资产过期 | 改版验收单含 README/screenshots/render_campaign 重拍项 |
| vNext 与本轮迭代范围混淆 | 本轮明确"视觉与架构，不动壳层范式"，vNext 独立立项 |

## 8. 工作量与波次建议

- Step 0：0.5–1 波（设计与 token，无代码风险）
- Step 1：1–2 波（纯搬家，e2e 兜底）
- Step 2：1–2 波（视觉+双主题走查+资产重拍）
- Step 3：1 波（守护+i18n+a11y；vNext 决策不计入）
- **合计约 4–6 波**，建议置于 W46–W49（W45 先做 Steer/安全/ACC 快赢，互不冲突）。
