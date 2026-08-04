# Pretender 交办台/任务单 视觉审查清单（第 89–91 波）

本文件供视觉 QA 用。第 89/90/91 波 + sp-7 修复已提交（HEAD `8c09e18`，工作区干净），连续 4 波改了图标系统和 CSS 但未做肉眼验证。下面把**每一处该看的**列清楚。

## 0. 如何访问

- **服务器已在跑**：`http://127.0.0.1:8765`（PID 11212）。若已停，重启：
  `cd ruyi-workbench && node app/server.js serve`（默认端口 8765；只改了 `app/public/`，无需 build）
- **两个主视图**：
  1. **交办台首页**（home/交办控制台）— 默认视图。含：交办 composer、续办卡列表、剧本卡、首跑引导（无任务时）。
  2. **任务单详情**（task sheet）— 点任一续办卡进入。含：车钟、lens 标签页、班组/原始镜头、账本、底部动作。
  - ⚠️ 任务单详情需要有至少一个 mission；若无任务，只能看到交办台首页。审查任务单前先发一条交办或确认有历史 mission。
- **主题**：用顶栏「⋯」→「主题」切深/浅色。品牌云标和图标颜色走 `--brand-qh`/`--brand-au` + `currentColor`，**两种主题都要看**。
- **界面模式**：顶栏「⋯」→「界面」切精简/完整（uiModeToggle）。

## 1. 全局 chrome（index.html，静态 `[data-icon]`）

启动时 `icons.js` 的 `iconizeStatic()` 扫描 `[data-icon]` 把 SVG prepend 进元素。**每个按钮应显示图标 + 文字（或纯图标）**，不应是空白或残留 emoji。

| 位置 | file:line | 期望 | 重点看 |
|---|---|---|---|
| 侧栏品牌主标 | index.html:77 | 24×24 单线云头 + 鎏金小圆点，~22px，随主题青花蓝/鎏金色 | 是否糊成一团；鎏金点是否可见 |
| 空状态 logo | index.html:258 | 同上云标，48px | 与侧栏几何是否一致 |
| uiModeToggle | index.html:154 | toolbox 图标（原 🔧） | 是否双 SVG（themeToggle 运行时会换标，确认无重复） |
| themeToggle | index.html:156 | theme 图标（原 🌙） | 同上 |
| moreMenuBtn | index.html:158 | more（三点）图标 | |
| toggleToolsBtn | index.html:159 | toolbox 图标 | |
| missionBar 图标 | index.html:174 | target 图标 15px（原 🎯） | 仅活动 Mission 时显示 |
| autonomyBar 图标 | index.html:186 | ticket 图标 15px（原 🎟️） | 仅自主性授权书激活时显示 |
| jumpLatest | index.html:270 | down 箭头（原 ↓） | 仅有新消息且未在底时显示 |

## 2. 交办台首页（preview-shell.js，JS 动态构建）

| 元素 | file:line | 期望 | 重点看 |
|---|---|---|---|
| 交办 composer 标记 | preview-shell.js:1028 | send 图标 15px，青花热色，居左在 46px 列内（原 `›` 字符） | 图标是否过大/过小；与 textarea 顶部对齐 |
| quick 按钮 | preview-shell.js:1036 | quickask 图标 + 文字，inline-flex | 图标文字间距 |
| review 按钮 | preview-shell.js:1037 | dispatch 图标 + 文字（primary） | primary 底色下图标颜色是否可辨 |
| 续办卡 enter 箭头 | preview-shell.js:903 | open 图标 13px，hover 右上移（原 `↗`） | |
| 续办卡进度条 | preview-shell.js:896 附近 | `<progress>` aria-hidden，标签在按钮 aria-label | 读屏不双播报（a11y，非视觉） |
| 剧本卡图标 | preview-shell.js:1118 | 有 pb.icon 用其值，否则 playbook SVG（原 `◆`） | 回退图标是否正常 |
| 剧本卡 enter | preview-shell.js:1119 | open 图标 13px | |
| 首跑引导第1步 | preview-shell.js:968 区 | 未选工作圈=可点按钮；已选=`is-ready` 态显示就绪文案 | 状态切换 |
| 首跑引导第2步 | preview-shell.js:991 | 真按钮接 openSafetyControl（原假控件） | 点击是否开安全档弹层 |
| 首跑引导第3步 | 引擎未就绪=按钮；就绪=`is-ready` | | |

## 3. 任务单详情（preview-shell.js）

⚠️ 需要进入一个 mission 才能看到。

| 元素 | file:line | 期望 | 重点看 |
|---|---|---|---|
| 头部 eyebrow | preview-shell.js:1983 | 「任务单」（原误标「原始镜头」） | 文案正确 |
| 加载态 eyebrow | preview-shell.js:1271 | 同上「任务单」 | |
| **车钟 pause** | preview-shell.js:1857 | pause 图标 + 标签 + scope chip（column-flex：图标标签一行，chip 下行） | **column-flex 下图标对齐** |
| 车钟 continue | preview-shell.js:1858 | resume 图标（primary） | primary 底色下图标颜色 |
| 车钟 takeover | preview-shell.js:1859 | takeover 图标（单人人形） | 人形是否可辨；与 agents（双人）区分 |
| 车钟 stop | preview-shell.js:1862 | stop 图标（danger-ghost） | danger 色下图标配色 |
| 车钟 retry | preview-shell.js:1863 | refresh 图标（环形箭头） | |
| lens 标签页 narrative | preview-shell.js:1796 | narrative 图标 + 文字，13px | **3 个 tab 加图标后窄屏是否溢出** |
| lens 标签页 crew | 同上 | agents 图标 | |
| lens 标签页 raw | 同上 | raw 图标 | |
| 班组 run pause/resume/stop | preview-shell.js:1436-1440 | 三按钮带图标（按钮已 inline-flex+gap） | 对齐 |
| 底部 backHome | preview-shell.js:2060 | back 图标 + 文字 | |
| 底部 openMissionClassic | preview-shell.js:2061 | open 图标（primary） | |
| 底部 refresh | preview-shell.js:2062 | refresh 图标 | |

## 4. sp-7 死令牌修复（tokens.css + preview-shell.css）

`--sp-7` 此前未定义，7 处 `var(--sp-7)` 声明失效塌成 0。现重定义为 32px。**这 7 处的间距应恢复正常**（之前上下内边距/外边距是 0）：

| file:line | 元素 | 期望（修复后） |
|---|---|---|
| preview-shell.css:734 | `.preview-needs-empty` | padding 上下 32px、左右 16px（原上下塌 0） |
| preview-shell.css:755 | 响应式 clamp padding | clamp(20px, 4vw, 32px) 生效（原整条失效） |
| preview-shell.css:762 | 响应式 inset clamp | 生效 |
| preview-shell.css:790 | section margin-top | 32px（原 0） |
| preview-shell.css:1126 | `.preview-dispatch-home` 响应式 padding | 底部 32px |
| preview-shell.css:1128 | `.preview-home-intro` 响应式 padding | 底部 32px |
| preview-shell.css:1159 | `.preview-archive` 响应式 padding | 底部 32px |

**重点看**：needs-you/空 needs 区块、各 section 之间间距、窄屏（拉窄浏览器触发响应式）下交办台/归档页的内边距。

## 5. 已知风险 / 重点排查

1. **lens 标签页窄屏溢出**：3 个 tab 各加 13px 图标 + 6px gap ≈ +57px。`preview-lens-tab` 有 `white-space:nowrap`，窄屏可能挤出。看 `.preview-lens-switch` 是否有横向滚动/换行兜底。
2. **车钟 column-flex 图标对齐**：按钮 `flex-direction:column; align-items:flex-start`。图标+标签包在 `.preview-control-btn-label`（inline-flex）里，scope chip 在下行。看图标与标签是否在同一行、左对齐是否自然。
3. **primary / danger-ghost 按钮图标颜色**：图标 `stroke=currentColor`，跟随按钮文字色。primary 按钮底色深、文字浅；danger-ghost 文字 danger 色。确认图标在这些底色下可辨。
4. **dispatch mark 图标尺寸**：原是 2.4rem 大字符，现 15px send 图标。看是否太小/不协调（46px 列里）。
5. **themeToggle 双 SVG**：themeToggle 运行时 JS 可能自行换标，与静态 `data-icon="theme"` 叠加。确认只有一个 SVG。
6. **icons.js 图标几何**：新增 `pause`（圆+双竖条）、`takeover`（单人人形）路径是否正确渲染、与 `resume`/`agents` 风格一致。
7. **`rawLens` 死键**：i18n 键 `previewShell.rawLens` 现已无 JS 引用（留作无害死键未删）。若 UI 某处仍显示「原始镜头」且不该显示，可能是遗漏的引用点。

## 6. 图标全集（icons.js，49 枚）

`folder shield toolbox paperclip sparkles trace agents send stop settings stethoscope help menu more collapse compress theme wrench plus search refresh trash pin edit close monitor dispatch sheet resume playbook archive needs narrative ledger raw done back go open bell quickask mail cloud target ticket down minus pause takeover`

新增（89-91 波）：全部 49 枚为 89 波新建的线性集 + 90 波 `pause` + 91 波 `takeover`。风格：24×24 viewBox、stroke=currentColor、stroke-width 1.5、圆角线帽/连接。若任一图标几何畸形/描边不一致，记录图标名。

---

**审查产出建议**：按上表逐项标 ✅/❌，❌ 注明 file:line + 现象 + 截图。重点关注第 5 节风险项。
