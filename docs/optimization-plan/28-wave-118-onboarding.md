# 28 · 第 118 波实施方案（新手配置与引导：零命令行、人话、可重触发、壳无关）

> **状态（2026-09-03）**：用户当日立项——「现在对新手太不友好，尤其电脑小白用户」，要求排在 Pretender 门（107）之前。编号 118 顺延自 27 号的 117。执行位置建议见 §6。
> **性质**：用户可见功能与文案；不改模型行为、不改权限判定语义；新增配置键只做加法（normalize 默认值），不 bump `CONFIG_SCHEMA`；新增路由走 `ROUTE_AUTH` 与 route-inventory。沿用 24 号 §0 纪律。
> **关联**：[27 号 管家壳](27-waves-115-117-steward.md)（117 上线后由管家承接引导对话，本波向导模块须壳无关）、`docs/manuals/USER-GUIDE_CN.md`／`_EN.md`（现成新手手册）、`Start-Workbench.cmd`、`desktop/RuyiDesktop.cs`。

---

## 1. 摸底结论（2026-09-03，HEAD `a91448f`）

**已经有的（要露出，不要重做）**
- 两套首跑引导卡：经典壳 `buildFirstRunState()`（`session-experience.js:902-913`，Logo＋拖放选文件夹＋引擎状态卡＋Playbook 网格）；预览壳 `buildFirstRunGuide()`（`preview-shell.js:1034-1066`，三步进度条：文件夹／安全档／引擎）。触发条件 `isFirstRun()`（`:781-788`，会话空且 `recentWorkspaces` 空，纯派生不落盘）。
- 14 个内置中文 Playbook 任务卡（`resources/playbooks/*.json`）；`onboarding.*` 文案键中英已就位。
- 测试连接 `POST /api/provider/test`（`13-http-router.js:264-286`）已把 401/403、404、超时映射成人话＋下一步；`ERROR_CLASSES` 有 zh＋next 文案。
- 新手手册 `docs/manuals/USER-GUIDE_CN.md`（292 行，「面向不写代码的日常用户」，三分钟上手＋人话概念＋Playbook 对应＋界面导览＋设置指南）与英文版并存，已打进离线包。
- 启动器 `Start-Workbench.cmd` 优先 `RuyiDesktop.exe`（无黑窗），包不完整时有中英提示；ACC 安装器有可行动错误与进度输出。

**缺口（§8 原文十二条归并）**
1. 应用内零入口指向手册（`index.html`／`js/*.js` 无任何帮助链接）。
2. 两壳首跑引导不一致（经典壳不讲安全档），且可被直接跳过、无法事后重开。
3. 体检（`computeHealth` 七项 id／detail 英文技术短语，`renderDoctor` 原样输出）深藏设置 Tab，首页无红点摘要；CLI `doctor` 打印原始 JSON。
4. 桌面控制（ACC）可用性无应用内人话状态（`computeHealth` 无 desktop-control 项），只在解压前 txt 提过一句。
5. 6 个 Provider 预设全部要手填 baseUrl＋apiKey＋model，无前置格式校验，无本地零配置预设（Ollama／LM Studio）。
6. 端口占用等启动错误只打终端（`listenWithFallback` `:1309`），浏览器没开时用户看不到；无 exe 的 node 回落路径露黑色控制台；WebView2 失败原因是 `0x` 错误码。
7. `README.md` 快速启动面向开发者（命令行），未提双击启动器；仓库无「新手从这里开始」入口。
8. 首跑引导无专属回归测试。

## 2. 目标与验收指标

> **UX 红线（用户 2026-09-03 拍板，全项目适用）：不做「给路径／给命令，让用户自己去打开」的交互。** 用户不应为了完成一件事而离开如意。手册在应用内阅读、文件夹在应用内打开、日志在应用内查看、设置在应用内改。只能给出路径的地方，先补一个真正可点的动作再谈文案。本条同时写入 27 号 §8.1 与 `docs/ENGINEERING-SPEC.md` §7。

- **零命令行**：从解压到第一条成功回复，全程不打开终端。
- **五分钟**：已有云端 API Key 的用户 ≤ 5 分钟完成首次配置并得到第一条回复；本地 Ollama 用户 ≤ 3 分钟（无 key）。
- **人话＋下一步**：所有启动／配置／体检错误在应用内可见，每条含「怎么办」。
- **两次点击可达帮助**：任何界面 ≤ 2 次点击打开手册对应章节。
- **可重触发**：向导可跳过、可从帮助菜单重开、两壳共用同一模块。
- **走查**：以「电脑小白」脚本（不懂 API／端口／路径）做双主题＋390px＋键盘走查，记录卡点数 ≤ 2。

## 3. 切片

| 切片 | 内容 | 门 |
|---|---|---|
| **118a · 欢迎向导（壳无关模块）** | 新增 `js/onboarding-wizard.js`，复用 `interaction-prompts.js` 的 `buildModal` 表单构建器；步骤：①语言（默认自动探测）②引擎三选一：云端 API 预设／本地端点（Ollama、LM Studio 预设，无 key）／Claude·Kimi CLI（折叠为「已装命令行工具的用户」）③预设卡（DeepSeek／DashScope／GLM／火山方舟／自定义）只要求填 **API Key**，baseUrl 与默认模型由预设带出（「高级」可展开改）；填写时做前置校验（key 形状、URL 形状、空白）；「测试连接」复用 `/api/provider/test`，成功后自动拉模型列表让用户选或用默认 ④选工作文件夹（拖放／挑选，说明「AI 只在这个文件夹里干活」）⑤安全档（人话四档：每步都问／改文件不问／只做计划／全自动；默认每步都问；一句话风险说明）⑥完成页：三张最通用的 Playbook 任务卡（清理下载文件夹、整理会议纪要、翻译文档）＋「打开手册」（**应用内阅读器，见 §7 的 118a-fix；不给路径、不给复制按钮**）＋「以后再说」。状态：`config.onboarding = { completedAt, version, skipped }`（normalize 默认 null，不 bump schema）；`isFirstRun()` 改为「未完成向导 或 原判定」；两壳同一入口；帮助菜单「重新打开向导」 | 新增 `onboarding.e2e.js`（首跑判定、跳过／完成持久化、重开、预设校验、测试连接人话映射、模型列表回填）＋ `onboarding.static.e2e.js`（两壳共用同一模块、i18n 键四文件、零 innerHTML、reduced-motion）；`provider-*` e2e 只加；真实浏览器走查截图 |
| **118b · 人话体检与状态** | 前端映射表 `health-i18n.js`：`computeHealth` 七项 id → `label/hint/next`（中英）；新增服务端健康项 `desktop-control`（ACC 已就绪／未安装／Python 缺失／正在准备中，取自 `caps.desktopMcp` 与安装器日志 `acc-install-latest.log` 尾部状态）；首页与首跑卡显示摘要红点「有 N 项需要处理」→ 一键打开体检；体检行加「怎么办」按钮（直达设置项或手册章节）；CLI `doctor` 增 `--human` 人话输出（保留 JSON 默认，避免破坏脚本） | `capabilities.e2e.js` 只加（health 项数与 desktop-control 三态）；`ui-*` 静态锁；`facts`（若 doctor 参数计入门面）；`meta-guard` |
| **118c · 启动体验** | ① 启动失败（端口被非工作台占用、数据目录不可写、WebView2 初始化失败）统一写 `<data>/last-start-error.json`（人话＋下一步）并：桌面壳弹原生消息框；node 回落路径由 `Start-Workbench.cmd` 改为 `powershell -WindowStyle Hidden` 启动并在失败时用 `msg`／`mshta` 弹窗，不再露黑窗（`.cmd` 保持纯 ASCII）；② WebView2 失败原因映射人话（缺 Runtime → 给安装指引；被策略禁用 → 给 IT 说明）；③ 端口被占时自动改用下一可用端口并在页面顶部提示「已改用 8766」（默认端口 8765 仍优先）；④ `README-START-HERE.txt` 精简为 10 行「双击 Start-Workbench.cmd → 按向导做 → 遇到问题看 docs/manuals」 | 新增 `start-error-surface.e2e.js`（端口占用夹具 → `last-start-error.json` 形状与人话键）；`eol-policy`（.cmd CRLF）；`repo-hygiene`；`durable-state-inventory --write`（新文件登记，regenerable-exemption）；桌面壳 C# 改动以静态锁＋人工走查 |
| **118d · 应用内帮助（核心已随 118a-fix 提前）** | 核心已提前：`GET /api/help/doc?id=`（token 级、白名单 id、无路径入参）＋ `js/help-viewer.js` 应用内 Markdown 阅读器（见 §7 交付记录）。本切片剩余：帮助菜单聚合（手册／重新打开向导／查看日志／打开数据目录）——**「打开日志／数据目录」必须是真动作**：新增 token 级 `POST /api/open-path`，只接受枚举值（`data`／`logs`／`workspace`／`manuals`），服务端映射到绝对路径后用既有启动方式打开资源管理器，**不接受客户端传路径**；日志另提供应用内查看（尾部 N 行滚动）以便无图形环境也可用；上下文帮助：设置各 Tab 的「？」跳手册对应章节锚点；`README.md` 增「新手从这里开始」段（双击启动器 → 向导 → 手册），开发者命令下沉 | `route-inventory.static`；新增 `help-route.e2e.js`（白名单、穿越拒绝、zh/en 切换、404）；`token-bootstrap-csp.e2e.js` 不受影响（open 路由不发 token）；`repo-hygiene` |
| **118e · 本地零配置预设** | `PROVIDER_PRESETS` 增 `ollama`（`http://127.0.0.1:11434/v1`，无 key，自动探测 `/v1/models`）与 `lmstudio`（`http://127.0.0.1:1234/v1`）；预设卡带「去哪里拿 Key／怎么装 Ollama」的纯文字指引（不联网、不外链自动打开）；探测失败给人话（「本机没在运行 Ollama，请先启动它」） | `provider-*` e2e 只加；`capabilities.e2e`；`i18n.static` |
| **118g · 剩余 copy-path 同族点** | `provider-settings.js` 的 MCP 模板「复制」改为「一键应用到配置」（写入前展示 diff 与目标文件，失败给人话）；全仓再扫一遍「请打开／自行打开／复制以下内容」类文案并逐个改成真动作或删除 | 新增静态锁：全仓 `app/public/**` 不得出现「复制路径」类出口（白名单例外须写明理由） |
| **118f · 小白走查与出门** | 以「电脑小白」脚本走三条路径（云端 key／本地 Ollama／CLI）各一遍，双主题、390px、键盘；记录卡点与修法；离线包解压后双击实测（Full／Slim 各一次） | 走查记录入本文 §5；Release Brief |

顺序：118a → 118b → 118d → 118c → 118e → 118f。118a 与 118b 是最小闭环。

## 4. 与管家（117）的衔接
向导做成壳无关模块并以数据（步骤定义）驱动；117 上线后，管家用同一份步骤定义以对话形式引导（「先告诉我你想用哪家模型」→ 填 key 卡片 → 测试），完成状态同一个 `config.onboarding`；两条路径任一完成即视为完成。

## 5. 走查记录

- **118a 首轮走查（2026-09-03，主会话亲跑）**：临时数据目录起真服务，浏览器走完六步。确认：首跑卡出现「开始引导」主按钮；第 1 步语言下拉与「当前生效语言 zh-CN」回显；第 2 步引擎三选一文案人话；第 3 步预设卡（DeepSeek／Qwen／GLM／自定义）只要求填 Key、密码型带显示切换、写明「密钥只发给本机服务保存，界面不会再显示它」、baseUrl 与模型收进「高级」、可「先跳过」；**前置校验命中**——输入含空格的 key 立即红字「密钥里有空格或换行，通常是复制多了，请重新粘贴」；第 4 步工作文件夹拖放区＋当前路径回显；第 5 步安全档四选一带一句话风险说明、默认最保守档；第 6 步三张 Playbook 卡。完成后 `config.onboarding = {completedAt, version:1, skipped:false}` 正确落盘，语言与安全档同时持久化，跳过 Key 时不写空 provider；设置内「重新打开引导」可达；390px 首屏与按钮布局正常。**发现问题**：完成页用「路径＋复制路径按钮」引导用户自己去开手册，违反 §2 UX 红线 → 立 118a-fix（见 §7）。另：向导弹层无遮罩，背后首跑卡透出，聚焦感弱 → 记入 118f 视觉待办。

（118f 交付时补全）

## 7. 交付记录

- **118a（2026-09-03，opus 实现／主会话亲核与走查）**：新增 `js/onboarding-wizard.js`（六步、数据驱动 `onboardingStepsFor(config)`、纯函数 `validateApiKeyShape`／`validateBaseUrlShape`、117 管家可复用）、`css/components/onboarding.css`；`01-config.js` 加法默认 `onboarding:null`（未 bump `CONFIG_SCHEMA`）；`provider-settings.js` 抽出 `providerDraftFromPreset()` 供向导与设置页共用（逐字搬家）；经典壳首跑卡加「开始引导」、预览壳最小改动同款按钮、设置页「重新打开引导」；四个 locale 文件各 +94 行；overlay 载荷登记；D51 SHA 重钉。新增 `onboarding.e2e.js` 与 `onboarding.static.e2e.js`（`facts` e2eCount 265→267）。门：两件新测试 ALL PASS、`run-all --fast` 49/49、`facts.static`／`i18n.static`／`frontend-domains.static` 全绿、`build --check` 新鲜、依赖图零新增边；全量 `--parallel 4` 258/2/4，两件 FAIL（`claude-resume-recovery`、`plan-mode`）与 perf 冷启动均因主会话走查服务器同时占用 CPU 与端口，**串行复跑三件全部 ALL PASS**，归因非 118a。
- **118a-fix（2026-09-03，opus 实现／主会话亲核）**：按 §2 UX 红线，完成页的路径文本与复制按钮整体删除，改为**应用内手册阅读器**——`GET /api/help/doc?id=&lang=`（token 级，`01b-route-auth.js` 登记；**白名单查表**，只有源码常量文件名进 `path.join`，请求串永不触达文件系统；缺文件返回 200 降级由 UI 在应用内解释，不回退成给路径；512KB 上限按整行收口）＋ `js/help-viewer.js`（复用既有 `marked`＋`sanitizeNode` 管线、`##` 目录跳转、中英切换）。**真机走查另修三处**：① Esc 叠层语义——阅读器叠在向导上时，全局 Esc 会把向导误写成 `skipped:true`，改为阅读器在 `document` 捕获相位自持 Esc 并 `stopPropagation`；② 手册正文里的相对链接（`ADMIN-GUIDE_EN.md`、`../../../SECURITY.md`）点击会整页离开如意 404，改为手册互引变应用内切换、其余相对链接摘 href、真外链才开新标签页；③ ≤720px 时目录与正文重叠（带 `max-height` 的 grid 项不把高度贡献回行）。反模式从 i18n 键、类名、剪贴板调用三处一起锁死。门：`--fast` 49/49、新增 `help-viewer.e2e.js`（穿越 7 例全 404、无效 token 403、缺文件降级）、`route-inventory` 判定点 101→102 由生成器自产、`facts` e2eCount 268、九件定向 e2e 全绿。**118a 与 118a-fix 合并提交 `8a0330f`**（fix 直接改写了 118a 完成页的实现，分开提交会先入库一版违规交互）。
- **118a 后续三项（2026-09-03 登记）**：① **手册缺常驻入口**——目前只有向导完成页能打开，`admin-guide` 通道已就绪但无 UI；并入 118d 帮助菜单。② **`app.js` 行数护栏 D45 只剩 1 行余量**（1239/1240）——118a 已把阅读器实例挂在 `session-experience.js` 以避开，后续任何组合根接线前必须先按 SPEC §6「重钉」纪律正式上调护栏并注明来源，或先瘦身组合根；列为 118d 前置。③ **其它 copy-path 同族点**——`provider-settings.js` 的 MCP 模板「复制」按钮是真正的「复制走去别处粘」交接，应改为「一键应用到配置」，列入 118g（新增切片）；`file.reveal`／产物展开的「在资源管理器中显示」是**如意替用户打开**，属 §2 红线允许的真动作，保留。

## 6. 排期建议（待拍板）
用户要求「Pretender 门前」；建议**提前到 110 之后立即做**：改动面小、纯前端与文案为主、对现有用户零风险，收益立竿见影，且 118a 的步骤定义可被 117 直接复用，不会返工。若采纳，执行序变为 **110 → 118 → 112a–c → 113a/b → 115 → 116 → 117 → 114 → 111 → 107**。
