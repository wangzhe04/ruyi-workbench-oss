# 45 · 第 127 波 · 服务目录与模板映射 ＋ 语音回填

> **用户触发（2026-09-16）**：「结束后帮我继续自主推进下一波吧，一直推进就行」。排期依据 [43 号文 §2](43-merge-114-111-107-into-product-line.md)（114a–114c 并入本波 B 道，S01／S02／F01 为 A 道）。
>
> **本文的性质**：派单稿。**不重写 [26 号文](26-wave-114-asr.md) 的 ASR 设计**（冻结边界、威胁模型、切片划分、记账口径全部原样有效），也**不重写 [41 号文 §5.9](41-personal-workbench-iteration-plan.md) 的服务目录裁决**（「不新建目录引擎、探针或模板 DSL」仍然成立）。本文只补三样它们没有的东西：**落在今天这棵树上的哪一行**、**按什么顺序出门**、**每一刀的反向怎么做**。
>
> **前一波**：[44 号文](44-wave-126-memory-scope-and-compaction-v2.md)（126 波，已收；B 道五刀全收、A 道两刀、M03 如实不过门）。

## 0. 一句话

两道并行：**A 道让用户知道如意到底能替他完成哪几件事**；**B 道让他能开口说，而不是打字**。两道文件零重叠。

## 1. 取证（2026-09-16 主树实读，HEAD `dc32e4d`）

### 1.1 26 号文的摸底做于 2026-09-03，十三天里五处全变了

**它的设计有效，它的坐标失效。** 照着老坐标施工会踩空：

| 26 号文当时写的 | 今天实测 |
|---|---|
| `CONFIG_SCHEMA=11`，114a 要 11→12 | 仍是 11，但**仓里后来确立了相反的约定** —— 见 §1.2，这是待拍板项 1 |
| 原生工具 63→64 | **96**（`facts.json.nativeTools`）。`audio_transcribe` 是 **96→97** |
| 「建议排在 110-1 `13f` 拆分之后」 | 110 已全收：`13f-native-tool-schemas.js` 在树上，13 族已拆成 `13b`–`13t` 共 19 件 |
| `makeAttachmentRecord` 在 `04-permission-runtime.js:1-27` | 现 `:10-36`。文本白名单 19 个扩展名（`txt|md|json|js|ts|…|log`），**无音频类**；`textPreview` 仅当 ≤256 KB 且命中白名单 |
| 附件上传在 `13-http-router.js:1136` | 现 `:1508` |

### 1.2 `caps` 这个词在本仓已经被占用了 —— 同名不同物

26 号文要给 `models[]` 加的是 **模型能力标签** `caps:['asr']`。但今天树上 `caps` 已经是**另一样东西**：`getCapabilities()` 返回的**运行环境能力矩阵**，贯穿 `toolRequirementsMet(toolName, caps, …)`（`06:38`）、`evalPlaybookAvailability(pb, caps)`（`06:891`），取值域是 `PLAYBOOK_REQUIRES = ['network','desktopMcp','vision']`（`06:822`）。

两者语义正交（一个说「这个模型会什么」，一个说「这台机器有什么」），但**同名**。读代码的人最容易在这种地方栽 —— 施工时字段就叫 `models[].caps`（26 号文冻结边界的原词，不改），但**必须在 normalize 处留一行注释点明它与能力矩阵无关**，并让静态锁钉住这两个取值域**不许互相引用**。

### 1.3 `CONFIG_SCHEMA` 要不要 bump —— 26 号文与现仓约定正面打架

26 号文 §3 明写 114a 做 `CONFIG_SCHEMA` 11→12。但 118a 之后仓里确立了相反的约定，原话就在 `01-config.js:298-299`：

> `// Purely additive: normalizeConfig sanitizes the shape and CONFIG_SCHEMA is deliberately NOT bumped,`
> `// so an older config simply reads back null and the wizard stays available.`

实测树上仅三条迁移分支（`01:642` 的 `incomingConfigSchema < 9`、`01:1020` 的 `< 10`），处理的**全是「旧值需要被改写」**的情形。而 `models[].caps` 与 `asrProviderId`／`asrModel` **没有任何旧值要改写**：读回空数组／空串即「未配置」，正是今天的行为。→ **待拍板项 1。**

### 1.4 A 道：15 个模板确实都在，但它们不知道自己属于哪一类服务

`ruyi-workbench/resources/playbooks/` 实测 **正好 15 个**。`normalizePlaybook`（`06:827`）的字段是 `id｜title｜icon｜desc｜inputs｜promptTemplate｜requires｜engineHint｜uiMode` —— **没有服务分类**。

**而目录引擎其实全都现成**：`evalPlaybookAvailability`（`06:891`）已按能力矩阵逐条评出 `available` ＋ `unavailableReason`，`listPlaybooksWithAvailability`（`06:906`）已把内置 ∪ 用户两套并起来，`GET /api/playbooks`（`13:366`）已经吐给前端。**S01 缺的只有「分类」这一个字段与缺项模板** —— 41 号文 §5.9「不新建目录引擎、探针或模板 DSL」的裁决今天仍然成立，且比当时更省。

**逐条实盘（15/15，按 title 与 desc 判，不是按文件名猜）**：

| 六类服务 | 现成模板 | 数 |
|---|---|---|
| 研究比较 | `compare-documents`（对比两份文档）、`pdf-summarize`（多份 PDF 逐份摘要并汇总总览） | 2 |
| 资料整理 | `archive-by-content`、`batch-rename`、`clean-csv`、`clean-downloads`、`folder-inventory`、`merge-excel`、`ocr-scan` | 7 |
| 产物撰写 | `weekly-report`、`meeting-minutes`、`presentation-outline`、`translate-document` | 4 |
| **代码任务** | —— | **0** |
| **定时汇总** | —— | **0** |
| **变化守望** | —— | **0** |
| **（不属于这六类）** | `desktop-open-app`、`web-form-fill` —— 它们是**动作**，不是「完成一件事」 | 2 |

**两条比「缺项」本身更要紧的取证结论**：

1. **15 个模板全压在前三类**，后三类一个都没有。41 号文写「前四类先盘点复用」—— 实盘之下**代码任务这一类也是空的**（一个代码模板都没有），这一条与 41 号文的假设不符，**如实记下**。
2. **六类这个分法本身盖不住现有模板**：`desktop-open-app` 与 `web-form-fill` 落不进任何一类。硬塞会让分类变成谎；**推荐让分类字段可以为空**（未分类 ≠ 不可用），详见待拍板项 2。

### 1.5 B 道：无头浏览器里没有麦克风 —— 114c ① 的真实风险

全仓浏览器 e2e **各自拼启动参数**（形如 `'--headless=new','--disable-gpu','--no-first-run',…`，例 `a11y-walkthrough.browser.e2e.js:297-300`），**没有任何一件用过 `--use-fake-device-for-media-stream`**。

114c ① 的判据要真的「按下麦克风按钮 → 拿到可转写的字节」，就得先证明这对 Chromium 开关在本仓这版 Edge 的 `--headless=new` 下真的给得出可录音轨。**这件事今天没有先例，不能假设它成立。**

→ **先验已做（2026-09-16，两组对照，探针不进回归）**：

| | **A 组（对照）** 不加任何 media 开关 | **B 组** `--use-fake-device-for-media-stream` ＋ `--use-fake-ui-for-media-stream` |
|---|---|---|
| `getUserMedia({audio:true})` | **`NotFoundError: Requested device not found`** | 拿到 `Fake Default Audio Input`，`readyState=live`、`muted=false` |
| `MediaRecorder` 产出 | —— | **12000 B**，头八字节 `1a 45 df a3 9f 42 86 81`（真 WebM EBML 魔数） |
| 解码回放 | —— | 时长 **1.200 s**，**peak 1.02 / meanAbs 0.018 —— 真有信号，不是静音轨** |

**结论：先验通过，114c ① 走真麦克风判据**（§4 ⑦ 的第一种形状）。A 组同时证明了风险是真的 —— **不加开关就是拿不到设备**，所以这两个开关必须写进夹具，并配一条静态锁钉住（否则以后有人「顺手清理启动参数」就会把它清成永远红）。

**探针顺带逮到 26 号文一处半错的设计**：`MediaRecorder.isTypeSupported('audio/wav')` 在这版 Edge 上实测 **`false`**。26 号文 §3 写的「不支持 `audio/webm;codecs=opus` 时回退 `audio/wav` 经 `AudioContext`」——**回退那一半用 `MediaRecorder` 走不通**，真要 wav 得自己从 `AudioContext` 的 PCM 手工封 WAV 头。而实测 `audio/webm;codecs=opus` **是支持的**（A、B 两组都 `true`）。→ **本波按「webm/opus 为唯一录制格式、不支持就不渲染麦克风按钮」实现**，不写一条跑不通的回退路径。

### 1.6 会被顶动的计数锁（提前登记，免得第四次被自己的锁拦住）

| 锁 | 现值 | 本波会怎么动 |
|---|---|---|
| `facts.json.nativeTools` ＋ README 两处措辞 | 96 | `audio_transcribe` → **97** |
| `facts.json.e2eCount` | 356 | 每加一件 `*.e2e.js` 都动 |
| `i18n.static.e2e.js:149` `skills.builtin.*` 键数 | 96（＝48 条记录 × 名称/描述） | **新增 playbook 就动**（每条 +2） |
| `route-inventory.js` 判定点 | —— | `POST /api/audio/transcribe` 必重算 |
| 原生工具四处登记 | —— | `13f` схема／`12` 派发／`13m` act 白名单／能力身份守卫（**漏 `13m` 已犯过三次**，已有机械锁 ①e） |

## 2. 切片与出门序

| 序 | 刀 | 道 | 为什么排这儿 |
|---|---|---|---|
| ① | **B-114a** 配置与模型能力标签（未配置时零行为） | B | 地基：`models[].caps` ＋ `asrProviderId`／`asrModel` ＋ 设置页选择器；②④⑤⑦ 全依赖它 |
| ② | **B-114b** 转写端点与零依赖 multipart | B | 全波**唯一出网面**，威胁模型集中在这一刀（26 号文 §4）；假 ASR 桩也在这刀立起来 |
| ③ | **A-S01** 服务分类字段 ＋ 六类映射 ＋ 缺项模板 | A | **不依赖 B 道任何东西**，排在 ② 的回归跑着时并行推进 |
| ④ | **B-114c-②** 音频附件转写（＋围栏中和） | B | 吃附件管线，与 ⑤⑦ 文件零重叠 |
| ⑤ | **B-114c-③** `audio_transcribe` 原生工具 | B | 吃工具注册表四处登记，独立一刀 |
| ⑥ | **A-S02** 自然语言进入不超过一次配置引导 | A | 依赖 ③ 的分类字段才有「进入哪一类」可言 |
| ⑦ | **B-114c-①** composer 麦克风回填 | B | **判据形状取决于 §1.5 先验结论**，排最后 |
| ⑧ | **A-F01** 服务状态（可用／需配置／不可用／**未知**）与离线降级文案 | A | 收口：把 ③⑥ 的分类与既有 `available` 合成用户看得懂的一句话 |

**114c 为什么拆成 ④⑤⑦ 三刀**：26 号文把三入口写成一个切片，但它们**吃三套完全不同的文件**（附件管线／工具注册表／前端 composer）。捏成一刀，回归一红就分不清是谁 —— 这正是 125 波「一刀只动一件事」那条纪律的由来。

**114d（本地 shim）／114e（桌面壳麦克风权限）不在本波**：43 号文 §2 已后置到 128+，理由是云端 ASR provider 就够跑通「语音能用」。

## 3. 独占文件与「绝不碰」

| | A 道吃 | B 道吃 |
|---|---|---|
| **独占** | `resources/playbooks/*.json`、`06-provider-engine.js` 的 `normalizePlaybook`／`listPlaybooksWithAvailability`、playbook 前端面、两份 locale 的 playbook 键 | `01-config.js`／`01c-runtime-flags.js`、新端点（`13b-api-domain-routes.js`）、`03-bridge-guard.js` 的 `buildAttachmentPrompt`、`04-permission-runtime.js` 的 `makeAttachmentRecord`、`11-native-tools.js`／`12-tool-dispatch.js`／`13f`、composer 前端 |
| **绝不碰** | ASR、附件管线、`01-config.js` | playbook、能力矩阵、`06-provider-engine.js` |

**唯一的理论交集是 `06-provider-engine.js`**（A 道要改 `normalizePlaybook`）。**判给 A 道**：B 道全程不碰它 —— `models[].caps` 落在 `01-config.js` 的 provider 规范化里，不在 provider-engine。

**与 126 波的交集为零**：本波不碰 `10-context-governance.js`、不碰管家记忆库。

## 4. 可证伪判据与反向（每一刀至少一条真反向）

- **① 114a**：未配置时**逐字节零变化** —— 提示词快照、`GET /api/status`、路由清册、设置页 DOM 三处快照断言；`caps` 白名单只认 `asr`／`embedding`，未知值静默丢弃且去重。
  **反向**：把白名单去掉 → 夹具里塞 `caps:['asr','rm -rf']` 应当红并打出实得数组。
- **② 114b**：鉴权 401／未配置 409／超限 413（25 MB，**早于** 128 MB 总闸）／成功 200／上游 5xx 走统一信封；记账落一条 `kind:'aux', note:'asr'`，上游无 usage 时 `estimated:true`；`audioBaseUrl` 过与 `baseUrl` **同一套** URL 校验。
  **反向**：把 25 MB 闸改成晚于总闸 → 24.9 MB 与 26 MB 两个夹具的返回码互换，红。**再一条**：让 `audioBaseUrl` 绕过 URL 校验 → 私网地址夹具应当红。
- **③ S01**：`GET /api/playbooks` 每条带 `service`；六类计数与 §1.4 实盘表**逐条相同**；未分类的两条 `service` 为空**且 `available` 不受影响**。
  **反向**：把 `service` 的枚举钳制摘掉 → 夹具里写 `service:'编造的一类'` 应当红。
- **④ 114c-②**：音频附件转写后进提示词必须**带围栏且经尖括号中和**（`<attachment kind="audio-transcript" untrusted>`）；原文件仍可下载。
  **反向**：摘掉中和 → 音频转写文本里含 `</attachment>` 的夹具应当红（这是 26 号文 §1 点名的「`buildAttachmentPrompt` 未做同款中和」那个现成缺口，本刀顺带补齐）。
- **⑤ 114c-③**：`audio_transcribe` 四处登记齐全（schema／派发／`13m` act 白名单／身份守卫）；tier `exec`、pack `files_read`；返回值标 `untrusted:true`。
  **反向**：抽掉 `13m` 那一处 → 既有机械锁 ①e 应当红并点名（**这条锁本身就是为「管家提了按钮、按下去 not_allowed」立的，第四次验它**）。
- **⑥ S02**：从自然语言进入一条可用服务，**必要配置引导 ≤1 次**（计数断言，不是文案断言）；不可用服务**不出现成功承诺**（扫返回文案中的承诺词）。
  **反向**：把引导计数上限提到 2 → 断言应当红并打出实得次数。
- **⑦ 114c-①**（**§1.5 先验已通过，走真麦克风形状**）：真浏览器件——点麦克风 → 录 ≥1 s → 停 → 拿到非空 webm/opus 字节 → 回填到**光标处** → **不自动发送**（发送计数为 0）；录音态可键盘到达、`aria-live` 有播报、双主题、390 px。夹具启动参数必须带 `--use-fake-device-for-media-stream` ＋ `--use-fake-ui-for-media-stream`，**并配一条静态锁钉住这两个开关**（A 组实证：不加就是 `NotFoundError`，以后谁「顺手清理启动参数」都会把它清成永远红）。
  **反向**：① 把「不自动发送」改成自动发送 → 发送计数断言红；② 从启动参数里拿掉那两个开关 → 静态锁红并点名该件。
- **⑧ F01**：能力**未知**时如实显示「未知」，**不得**通过文案映射升级成「已验证可用」（41 号文 §5.9 原话）。
  **反向**：把未知态并进可用态 → 夹具里能力探针返回 `undefined` 时应当红。

## 5. 每一刀出门的固定动作

沿 32 号文 §4 与 44 号文 §5：`build --check`／依赖图 `--check`／`--fast`／控制字符扫描；**`src/` 有改动就整条生成器链重跑**（`module-dependency-graph.js --write` → `build.js` → 文件数变了才 `facts-generate.js` → `route-inventory.js`）。一机一回归（纪律 14）、新 e2e 首行 `self-isolate-home`（纪律 15）、补丁不走 heredoc（纪律 7）、**每一刀至少一条真对抗反向**（改源码→确认红→按 sha256 逐字节还原）。

**本波多三条**：
- **新路由 ⇒ `route-inventory.js` 必重算**（②）。
- **新原生工具 ⇒ 四处登记 ＋ `facts-generate.js`（96→97）＋ README 两处措辞**（⑤）。
- **新 playbook ⇒ `i18n.static` 那把 96 键锁会动**（③，每条 +2）。

## 6. 四件要拍板的（**推荐已写在括号里，不回也按推荐走**）

1. **`CONFIG_SCHEMA` 要不要 11→12** —— 推荐 **不 bump**。26 号文写于 118a 之前；今天的约定是「纯增量 ＋ `normalizeConfig` 消毒 ⇒ 故意不 bump」（`01:298`），而三条既有迁移分支处理的都是「旧值要改写」，`caps`／`asrProviderId` 没有旧值要改写，bump 反而要凭空写一条什么也不做的迁移分支。**代价**：与 26 号文原文不一致 —— 本文 §1.3 已写明是**显式改判**，不是漏读。
2. **服务分类落在哪一侧** —— 推荐 **playbook JSON 加一个被枚举钳制的 `service` 字段**（六类白名单 ＋ 空），内置 15 个各填一个（两个动作类留空），用户 playbook 可选。理由：不新建目录引擎（41 号文裁决），只多一个与 `requires` 同模具的白名单字段；服务端一张 id→类映射表反而会让用户自己的 playbook 永远没有分类。**允许为空**是关键 —— §1.4 已实证六类盖不住现有模板，硬塞会让分类变成谎。
3. **代码任务／定时汇总／变化守望三类空缺怎么补** —— 推荐 **本波只补「定时汇总」一个模板，另两类如实标「暂无模板」**。理由：定时汇总的运行基座（123 波调度器）**已经落地**，补一个模板就能跑通一条完整成功路径；而「变化守望」缺的是守望基座（41 号文写明依赖 119），「代码任务」摊子最大（一个像样的代码模板要绑工作区权限与工具族）——两类都不是「填个 JSON」能了的，**硬补出来的模板跑不通，比空着更坏**。
4. **麦克风先验若不通过** —— 推荐 **按 §4 ⑦ 的降级形状出门，并在交付记录里写明「这一件没有真麦克风覆盖」**。理由：纪律 13 要的是「前端 JS 必须有真浏览器件」，不是「必须有真硬件」；假装有覆盖比承认没有更危险。**备选**（不推荐）：把 ⑦ 整刀推到 128+ —— 但那样 127 波的用户故事（「能开口说」）就断在半路。

## 7. 交付记录

（每一刀出门后按 44 号文 §7 的格式补：今天的毛病 → 与派单稿不同之处 → 判据读数 → 反向 → 生成器链与门。）
