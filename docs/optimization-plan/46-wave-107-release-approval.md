# 46 · 第 107 波 · 发布批准点（2.8.0 候选）

> **触发**：[43 号文 §2](43-merge-114-111-107-into-product-line.md) 把 107 排在 127 之后；127 已收波并推远端（[45 号文 §9](45-wave-127-service-catalog-and-voice.md)，远端 `64d8d29`）。
>
> **本文的性质**：派单稿。**不重写** [23 号文 §6](23-architecture-repayment-sequence.md) 的 107 定义与 [22 号文 §8](22-agent-soc-microarchitecture.md) 的 Release Brief 口径，只补三样：**今天这棵树离「能批」还差什么**、**按什么序做**、**哪些必须用户拍板**。取证来自 2026-09-17 一次只读摸底（主会话抽查了承重的三条：覆盖包漏 playbook、2.7.0 降级会抹字段、没有 `v2.7.0` 标签）。
>
> **与正在跑的「真端点＋历史数据实测」的关系**：那一轮（结果入 45 号文 §9.6）顺带产出本波 E1 需要的两组读数——管家代批在真模型下的延迟与行为、真 ASR 端点的可用性与准确率。E1 只补它没覆盖的部分。

## 0. 一句话

**2.7.0 之后五个波次（123–127）的用户可见变化全都没进 CHANGELOG，也一次都没打过包**；要批的不只是代码，是「装得上、升得上、退得回、说得清」。

## 1. 取证（2026-09-17，HEAD `64d8d29`）

### 1.1 五件会改变派单形状的事实

1. **111 五个开关没有任何真模型读数，也没有产读数的脚本**。43 号文 §2 的 107 行要求「111 五开关……实测读数」；44 号文 §6 ③ 把 B 类评测推到了 107 之前，至今没跑。
2. **2.7.0 之后没打过包**：`ruyi-workbench/dist/Ruyi-slim.zip`／`Ruyi-full.zip`（09-16）里的 `server.js` 与 `e780cbc`（126 末）逐字节相同却标着 2.7.0——是中途产物，**不能当发布物**；`v2.7.0` 的正式 zip 不在仓里，本地也**没有 `v2.7.0` 标签**（只到 `v2.6.2`）。
3. **覆盖升级漏装 playbook**：`tools/build-overlay.js` 的 `PAYLOAD_FILES` 不含 `resources/playbooks/*.json`，而运行时从那里读内置模板（`06-provider-engine.js:868`）。127-S01 改了 13 个模板（加 `service`）并新增 `scheduled-digest.json`——覆盖升级的老用户拿不到。守着清单的 `overlay-payload-lock.static` ③ 也不扫 `resources/` 与 `app/public/css`，同一个盲区。
4. **退回 2.7.0 会静默抹数据**：2.7.0 的 `sanitizeProvider` 把 `models[]` 重建成 `{id,label}`（`eac1424:05-claude-engine.js:1159-1163`，主会话实读），首读即回写 `config.json`，抹掉 `models[].caps`／`audioBaseUrl`／`hiddenModels`；2.7.0 的管家记忆规范化丢 `expiresAt`／`scope`，下一次写就整库回写。`.prev` 只留一代。**没有文档化的降级前备份步骤。**
5. **`stewardExemptDelegationV1` 默认开且放宽了一条安全红线，证据只有 fake provider**（45 号文 §9.2 B2）；从 2.7.0 升级的「智能自动」用户会自动获得。§9.6 的真模型读数回来前，这一条的 Release Brief 行是空的。

### 1.2 六类通用发布门（定义在 `docs/OPTIMIZATION-ROADMAP.md:40-45`，23 号文 §6 只点名未列）

| 门 | 今天 | 演练方式 | 会写盘吗 |
|---|---|---|---|
| G1 版本与构建 | **新鲜**：版本三角一致在 2.7.0；build 新鲜、依赖图 53/420 | `build.js --check`、依赖图 `--check`、`route-inventory --check`、facts.static／meta-guard／overlay-payload-lock.static | `--check` 与静态件不写 |
| G2 行为回归 | **新鲜**：`eb7334f` 全量 356/0/2flaky（45 号文 §9.5）。**过期**：提示词 A/B 停在 108，而管家规则文本在 `f4db5ab` 改过、`PROMPT_PACK_VERSION` 仍是 `'2026-w108-1'` | `run-all --parallel 4`＋flaky 串行复跑；prompt-benchmark | 临时家与 `last-run.log` |
| G3 视觉与无障碍 | **部分**：127 UI 有真浏览器件；真读屏未听、置灰行 toast 文案未换 | dom-screenshot／a11y-walkthrough／composer-voice／service-match 浏览器件＋人工键盘与读屏一轮 | 临时文件 |
| G4 离线交付 | **过期**：最后一次真打包是 2.7.0（slim 只做了 `/health` 冒烟，36 号文 §6）；Full 双击从未跑过（28 号文 118f）；覆盖升级与回滚演练停在 67/73 波 | `tools/package-offline.ps1`（slim／full `-IncludeAcc`）；`release-dryrun.js [--pkg]`；`build-overlay.js`＋`Manage-Overlay.ps1 apply/rollback` | **写 `dist/`**（约 850 MB） |
| G5 外部探针 | **过期**：最近一次真模型是 125-P4（09-15）；真 ASR 从未调用（§9.6 在补） | `release-dryrun.js` A5；各 live 脚本 | 花 API 费用 |
| G6 文档与迁移 | **过期**：CHANGELOG「未发布」为空；用户／管理员手册 09-07 以后没动，语音／定时任务／代批／服务目录零提及；`ARCHITECTURE_CN.md` 仍写 2.5.0／configSchema 9 | 文档 | 只写文档 |

**22 号文 §8 另点名「安全终审」不在六门里**——本波补一刀只读安全审（§2 ⑦b）。

### 1.3 默认启用清单的候选（Release Brief 第一张表的原料）

按 43 号文 §4 推荐口径（有实测读数且已默认开 → 已交付；默认关 → 实验）：

| 类 | 开关 | 默认 | 读数所在 | 归类 |
|---|---|---|---|---|
| 引擎 | 105a 观察缩减＋召回 | 开 | 23 号文 §4：真历史 −81.0%、回读逐字节一致、召回采纳 5/5 | 已交付（2.7.0 已带出，CHANGELOG 漏写） |
| 引擎 | 105b／d 会话笔记与注入 | 开 | 定性＋⚠ fake 端到端 | 已交付（证据弱） |
| 引擎 | 105c 实体校验、105f 单发摘要 | 开 | 23 号文：修复后漏实体 0；总门 88.9%／¥0.1352 vs 77.8%／¥0.1945 | 已交付 |
| 引擎 | 105e 估算分桶 | 开 | 只有确定性读数 | 已交付（证据弱） |
| 引擎 | 105g 事实表 | 开 | 单项 +56.2pp，**但总门混合**（66.7 vs 77.8） | 已交付，**Brief 必须写明混合读数** |
| 引擎 | 106 #1 G2 追加式工具 schema、#2a 结果缓存 | 开 | 缓存命中 +17–24pp；工具阶段 −64% | 已交付 |
| 引擎 | 105h、#13a／13a-t、#1 G1、111 五项 | 关 | 105h 无净收益、#1 G1 未过门、#13a 只有合成读数、111 零读数 | 实验 |
| 产品 | 管家、委托书、会话搜索、113a 向量召回（用户拍板翻开） | 开 | e2e＋走查；113a ⚠ 合成 +5pp 未过 +10pp 门 | 已交付（产品），113a 标「用户拍板」 |
| 产品 | 定时任务 `schedulerEnabledV1`、新线程跟随上次引擎 `newThreadEngine:'last'` | 开 | ⚠ 假时钟 e2e；**后者改变了存量用户的默认行为** | 已交付（产品），CHANGELOG 点名行为变化 |
| 产品 | **管家代批 `stewardExemptDelegationV1`** | **开** | ⚠ fake 46 条；真模型读数待 §9.6 | **待拍板 2** |
| 产品 | ASR（未配置＝不可见） | —— | ⚠ fake 桩；真端点待 §9.6 | 已交付「未配置零行为」；功能声明待 §9.6 |

完整清单（含 `runtimeOptimizationShadowV1` 等 22 号文 §8 范围内的早期开关）由 D2 那一刀从 `01-config.js` 默认值区逐条核对后落进 Release Brief，不在本文重抄。

### 1.4 迁移与回滚（Release Brief 第五项的原料）

- `CONFIG_SCHEMA = 11`（`00-boot.js`）自 2.7.0 未变，**本波不 bump**；注释里写的「v2.8」在发 2.8.0 时会让人误读，顺手改措辞。
- 从 2.7.0 升级：新键取默认值——**升级用户会自动获得代批开、定时任务开、新线程跟随上次引擎**。
- 退回 2.7.0：见 §1.1 ④。**要写进管理员手册的最小步骤**：降级前备份 `config.json` 与 `steward/`。

### 1.5 真端点＋历史数据实测带进来的（[45 号文 §9.6](45-wave-127-service-catalog-and-voice.md)，2026-09-17）

**好消息先说**：管家代批在真管家模型下 **37.0 s 落定**（两发模型调用 31.5 s，远低于 120 s 权限超时），污染与底线两类真模型**自己就拒了**；`shell_send` 真模型下无害命令零询问、删除命令恰问一次；定时任务快档与固定文件夹真跑通过。拍板 2（代批默认开）的前提成立。

**会改变 2.8.0 内容的**：

1. **语音在用户这台机器上开箱不可用**：用户配的四个 ASR 模型（MiMo `mimo-v2.5-asr`、百炼 `qwen3-asr-flash`／`fun-asr-flash`、混元 `hy-asr-3.0-preview`）**全部 404**——如意只走 OpenAI 形 `/audio/transcriptions`，而 MiMo 与百炼的文档写的是「chat-completions 带音频入参」。经 sim 目录里的临时适配器，同一链路 4/4 准确、附件围栏与 `audio_transcribe` 全通；**MiMo 另外拒收 webm**（只收 wav/mp3），而麦克风只录 webm/opus。→ 拍板 9。
2. **三个产品缺陷（主会话已逐条实读核实）**，按「门里发现真问题才开 `src/` 刀」开一刀 **S0**：
   - `/api/status` **明文下发 `modelsApiKey`**：`maskSecrets`（`05:1304-1319`）只遮 providers 与 searchBackend；真机该字段非空。
   - `shell_start` 缺省 `cwd` 是**家目录**（`11:63`），执行闸却按 `session.cwd` 判（`03:657`）——模型以为在线程工作夹里，相对路径实际落在家目录。
   - 引号 JSON 形态的 `"apiKey": "…"` **脱敏漏网**（真机会话文件里 58 个密钥值有 39 个过得去 `redact`）——它同时是管家命令摘录、审计、会话搜索摘录的脱敏表。
3. **用户侧（不改代码，交用户）**：真机如意配置里 10 个外部 MCP 有 9 个是 `fake-mcp.js` 测试夹具遗留（冷启动首个状态请求 8.3 s、审计里 29 次 MCP 启动失败），Claude Code 与 Kimi Code 的配置里同样挂着；5 条历史会话里有明文 provider 密钥。→ 拍板 10。

**记债不修**：启动探针偶发把机器判成离线并缓存 60 s（两次启动见到一次、机制未证）；管家拒代批时非定时线程仍干等 120 s 再问 600 s；尖括号中和让管家看到 `2>&1` 变成 `2]&1`。

## 2. 切片与出门序

> **2026-09-17 插刀**：§1.5 ② 的 **S0 安全修三处**（`maskSecrets` 补 `modelsApiKey`＋保存路径还原；`shell_start` 缺省 `cwd` 取会话工作目录；`REDACT_PATTERNS` 补引号 JSON 键值形态）排在 ⓪ **之前**——泄密与「删错目录」比 flaky 急。拍板 9 若选「补 chat-audio 协议」，再插一刀 **A1**（在 ⑤ Release Brief 之前）。

| 序 | 刀 | 产出 | 为什么排这儿 | 要拍板 |
|---|---|---|---|---|
| ⓪ | **F5** flaky 第五批（只动测试）：`agent-deadlock-watchdog` 会合点回落时报「不适用」；写死秒数墙钟窗口的件进独占桶并配锁；`budget-guard` E30 | 三处改动＋反向＋一轮全量 | 43 号文 §2 退出门「并行回归偶发治理已收」；这两件是 42 号文 §5-undecies 点名留给 107 的 | 否 |
| ① | **G1** 版本与构建门读数（只读命令） | 门读数表 | 最便宜，冻结前先确认基线 | 否 |
| ② | **P0** 覆盖包补 `resources/playbooks`；`overlay-payload-lock.static` ③ 扩到 `resources/playbooks` 与 `app/public/css` | `tools/`＋`dev-harness/` 改动＋反向 | 覆盖演练（⑧）的前提 | 否（除非拍板 6 选「本版不支持覆盖升级」） |
| ③ | **E1** 真模型读数：111 五开关 B 类（25 号文 §1.3，≥3 次配对，**只报不翻**）；§9.6 没覆盖到的代批／ASR 补测 | `docs/optimization-plan/107-*.json` 读数 | 与 ②④ 并行；D2 依赖它 | **拍板 3、4** |
| ④ | **D1** 文档与迁移：CHANGELOG 新节（123–127，并补记 103–106 在 2.7.0 已默认开的那几项）；用户／管理员手册（语音、定时任务、服务入口、代批与如何关掉、降级前备份）；ARCHITECTURE 基线；路线图现状 | 文档 | 可并行；版本号标题留到 ⑥ 填 | 拍板 5 |
| ⑤ | **D2** Release Brief 一页纸（22 号文 §8 四项＋路线图 :47 四问；§1.3 两张表） | 新文 | 依赖 ③ 的读数与 §9.6 | 拍板 1、2 |
| ⑥ | **R1** 版本号 bump＋生成器链（`package.json`／`00-boot`／`facts`／README 版本行／build／facts-generate） | 一个提交 | 之后一切在冻结树上跑 | 拍板 5 |
| ⑦ | **Q1** 冻结树全量回归＋G3 浏览器与 a11y 件＋G5 探针表；**⑦b 只读安全终审**（ASR 出网面、代批八道闸、2-bis 豁免放宽） | 基线读数＋审查记录 | 必须跑在要打包的那棵树上 | 否 |
| ⑧ | **P1** 打包演练（原生 PowerShell，别在 Git Bash 里跑——会拿到 GNU tar 失败，36 号文 §6）：slim／full、SHA256SUMS、全新目录冒烟（slim 走 node，full 双击 → ACC → 桌面壳麦克风）、2.7.0 解包后覆盖升级再回滚、降级配置演练、`release-dryrun [--pkg]` | `dist/` 产物＋读数 | 批准前最后一步，写 `dist/` | 拍板 6、7 |
| ⑨ | **R2** 批准点：打 `v2.8.0` 标签（补打 `v2.7.0`？）、推送、发布 | 标签与发布 | **用户动作** | 拍板 8 |

**本波 `src/` 原则上不动**：只有 ② 动 `tools/`，门里发现真问题才开 `src/` 刀，且单独过全量。

## 3. 要拍板的八件（推荐写在括号里）

> **2026-09-17 用户拍板（逐条原话）**：
> - **拍板 5 版本号**：「可以」→ **2.8.0**。
> - **拍板 2 代批默认开**：「开」→ **升级用户也默认开**（不加迁移分支）。主会话原推荐里「以 §9.6 真模型读数为前提」那半句随之取消；§9.6 若读出不合规行为，照实报给用户，不自行改默认。
> - **拍板 3 111 B 类读数**：「实测就行，也可以多测几次」→ **跑真模型实测，只报不翻**；配对次数不设上限在 3 次，按预算多测（E1 那一刀给出每开关的次数与置信区间）。
> - 其余五件（1、4、6、7、8）用户未回，**按推荐走**；**拍板 8 (b) 打标签与推送仍等用户明说**（推标签即公开）。

1. **默认开的怎么归类**（推荐分两张表：引擎优化按 43 号文 §4 口径；产品功能按 e2e＋走查判已交付，证据只有 fake 的打 ⚠）。代价：Brief 两张表，产品功能没有 A/B 数字。
2. **代批要不要对升级用户也默认开**（推荐保持默认开——用户明确要这个能力——并在 CHANGELOG 与 Brief 写明「是什么、怎么关」；**以 §9.6 真模型读数为前提**：若真模型下行为不合规或延迟普遍逼近 120 s 超时，改推荐为「新装默认开、升级用户默认关」）。代价：保持开＝2.7.0 的「智能自动」用户不经确认就获得；只对新装开＝要在 `src/` 加一条迁移分支。
3. **111 B 类读数在 107 里跑不跑**（推荐跑一次、只报不翻）。代价：要新写 live 脚本、真 API 费用（105 总门同量级为每策略 ¥0.14–0.22、158–307 s／3 例，111 要真工具回合会更多）、数小时墙钟。不跑＝五个开关以「实验、无读数」出门。
4. **ASR**：(a) 真端点核对（**§9.6 在跑**）；(b) 26 号文 §4 的「每会话 ≤1／队列 3」并发上限今天不存在（推荐记为未完成项，与 URL 准入缺口一起写进 Brief——本地单用户、token 门后面，风险低）。代价：实现 (b) 要动 `src/`＋一轮全量。
5. **版本号**（推荐 **2.8.0**：新功能＋默认行为变化、无 schema bump、无数据格式破坏、不含 3.0 正名）。
6. **本版支不支持覆盖升级**（推荐支持：做 ②，跑覆盖与回滚演练——G4 要求）。代价：约 1 小时＋工具与锁的改动。
7. **打包范围**（推荐 `-SkipExeBuild`（与 2.7.0 同）＋ Full 双击演练＋降级演练）。代价：1–2 小时、`dist/` 约 850 MB；打 exe 可能要联网下 node24 基础包。
8. **已知产品问题与标签**：(a) 回合收尾「先清 live 后落盘」竞态、冷缓存能力探测钉住事件循环 2.5–2.7 s（推荐记为未完成项不修——前者要动三个引擎的收尾次序）；(b) 补打 `v2.7.0`（`eac1424`）并打、推 `v2.8.0`（推荐做；**推标签即公开，是用户的决定**）。

9. **语音协议要不要在 2.8.0 里补**（推荐**补**：provider 级加一个 ASR 协议选择——`transcriptions`（今天的 OpenAI 形，缺省）｜`chat-audio`（chat-completions 带 `input_audio` 入参，MiMo／百炼文档形）；麦克风录完在浏览器里把 webm 解码转成 16 kHz 单声道 WAV 再上传（3 分钟约 5.7 MB，仍在 25 MB 闸内），一并解掉 MiMo 拒 webm）。代价：一刀 `src/`＋前端改动、真浏览器件扩展、一轮全量；按用户这台机器的配置用真端点再验一次（约十几次 ASR 调用）。**不补**＝2.8.0 的语音只对提供 `/audio/transcriptions` 的服务商可用，CHANGELOG 必须写明，用户自己这台机器上用不了。
10. **清理用户真机配置里的测试夹具 MCP**（推荐清：如意配置 `externalMcpServers` 里 9 个 `fake-mcp.js` 条目、`~/.claude.json` 与 `~/.kimi-code/mcp.json` 里同源的条目；清前备份三个文件）。**这是改用户的持久配置，必须用户明确同意**；另建议用户自行轮换那 5 条历史会话里出现过的明文密钥。

## 4. 与老文档的关系

- **23 号文 §6**：107 的内容不变；「六类通用发布门」的出处补记为路线图 :40-45。
- **43 号文 §2**：107 行的退出门「全量真回归 0；并行回归偶发治理已收；离线包启动冒烟；Release Brief 一页纸落盘」原样沿用；本文 §2 ⓪ 与 ⑧ 分别兑现后两条。另：**43 号文 §2 给 126／127 的退出门 J12／J13／J03 在 44／45 号文里都没报过**——D2 那一刀补读。
- **45 号文 §9**：本波的「未完成项」直接取它的债表（§9.2）与 flaky 候选（§9.3），不重抄。

## 5. 交付记录

### S0 · 安全修三处（2026-09-17）

**开工前重核的坐标**（HEAD `c406961`，全对）：`maskSecrets` 在 `05-claude-engine.js:1304-1319`、`unmaskSecrets` 紧跟其后 `:1324-1362`；保存路径的还原在 `13-http-router.js:193-197`（`applyConfigPatch`）；`shell_start` 缺省 cwd 在 `11-native-tools.js:63`；执行闸的有效目录在 `03-bridge-guard.js:657`；`REDACT_PATTERNS` 在 `04-permission-runtime.js:44-61`。

**改了什么**：

- **① `modelsApiKey` 明文下发**
  - `05-claude-engine.js:1318-1322` `maskSecrets` 补一行：`modelsApiKey` 走同一个 `maskKey`（`••••末四位`）。**没加 `has…` 布尔**——设置页那个框（`index.html:1513` `#cfgModelsApiKey`，`type=password`）与 `providers[].apiKey` 同一模具：`provider-settings.js:409` 原样播种掩码、`:684` 原样回传，用不上它；多一个顶层键反而会进 `steward_config_get` 的键表。
  - `05-claude-engine.js:1366-1369` `unmaskSecrets`：来件仍以掩码前缀开头 → 取磁盘真值；新明文、空串直通。
  - `13-http-router.js:193-201` `applyConfigPatch`：进入还原分支的条件加 `typeof body.modelsApiKey === 'string'`，并把还原值写回 `merged.modelsApiKey`。
  - 其它下发面逐个核过：`GET /api/status`（`13:304`）与 `POST /api/config` 回包（`13:492`）都经 `maskProviders`＝`maskSecrets`，一处修两处生效；`steward_config_get`（`13l:653`）也经它，且 `modelsApiKey` 是 forbidden 档、连掩码都不回；`workbench_self_status`（`12:368-380`）只回白名单标量；`GET /api/config` 不存在。顶层配置键里像密钥的只有 `modelsApiKey` 一个（`claudeAuthMode` 是枚举）。
- **② 执行工具缺省 cwd 落家目录**
  - `03-bridge-guard.js:645-676`：新增 `resolveExecCwd(cwd, ctx, config)`（`:653`），链为「显式 cwd → `ctx.workingDir` → 会话 cwd → `defaultWorkspace` → 家目录」；`guardWorkspaceExecute` 先解析、再判，**把解析结果随 `ok` 一并交回**（`{ ok: true, cwd }`，`:669`／`:676`）。
  - `12-tool-dispatch.js:1018-1073`：`powershell_run`（`:1021`）、`script_run` 三种语言（`:1049`／`:1054`／`:1059`）、`shell_start`（`:1073`，`shellStart({ ...args, cwd: g.cwd }, cfg)`）一律只用闸交回的 `g.cwd`，不各自再推一遍。
  - `13f-native-tool-schemas.js:132`：`shell_start.cwd` 的描述从「defaults to home」改成「defaults to the current working folder of this conversation」（不改就是对模型说假话）。
  - `11-native-tools.js:63` 只加一行注释：家目录兜底只剩「不经分发的直接调用方」（仓内没有）。
  - MCP 子进程路径核过：`shell_*` 先过闸、再回引导错误（`12:1069` 不变），闸里没有 session/workingDir 时按 `defaultWorkspace` 判，与修前一致；`powershell_run` 在子进程里现在跑在它被判的那个目录（修前判 `defaultWorkspace`、跑家目录）。Kimi 桥（`05b:1526`）传显式 cwd，不受影响。
- **③ 引号键值脱敏漏网**
  - `04-permission-runtime.js:45-47`：`sk-` 那条放宽为 `sk-` 后跟 `[A-Za-z0-9][A-Za-z0-9_-]{15,}`——修前在第一个 `-` 处断，`sk-proj-…`／`sk-ant-api03-…` 这类分段真 key 整把漏（§9.6 发现 5 点名的「含非字母数字字符的那一把」）。
  - `04-permission-runtime.js:63-72`：新增一条「值带引号的标签＋值」，两组（标签留、值抹），沿用 `redact()` 的组数口径。标签＝以 `api key／access key／secret key／private key／secret／token／password／passwd／authorization` **结尾**的键，词后紧跟（可选反斜杠＋）引号或直接 `:`／`=`，所以 `"maxTokens"`／`"tokenCount"`／`"token_type"` 不算；值必须以引号开头（数字、null、对象不碰），`Bearer／Basic／Token ` 前缀留在标签里；值只收可打印 ASCII、不含空格／引号／反斜杠——一层、三层转义的 JSON（会话文件里 `file_read` 结果的样子）都在转义引号处收口，中文文案值不误伤。量词全部有界（反斜杠 ≤8、空白 ≤8、值 6–4096），值之后没有需要回溯的成分。
- **测试**（**零新文件**，e2eCount 不变）：
  - `repo-hygiene.e2e.js` (e) 加 ④⑤⑥（`:179-185` 夹具、`:223-246` 断言）；失败只打前 6 个字符。
  - `shell-session.e2e.js`：(a) 的序列改成 `shell_start` **不传 cwd**、回合 cwd＝`SESS_CWD`、打 `(Get-Location).Path` 整行比对（8.3 短名经 `realpathSync.native` 展开）；新增 (f) 段 f1–f7（`:151-184`）；配置加 `workspaces`（WORK 首行＝defaultWorkspace，`no-exec` 行 `execute:false`）。
  - `unit/steward-exempt.test.js` ⑦ 段、B1 脱敏表之后（`:360-455`）：27 种正形状、16 条负形状、三段计时。假 key 全部运行时拼出，不在源码里留长串。

**与派单稿不同之处（逐条给理由）**：

1. **② 修了三个工具，不只 `shell_start`**。派单稿让「对照 `powershell_run`／`script_run` 的缺省值、复用那份单点解析」——实读发现**那两个也是 `args.cwd || os.homedir()`**（`12:1020` 经 `04-desktop-shell.js:105`、`12:1048/1053/1058`），与 `shell_start` 同一个「判一个目录、跑另一个」，并不存在可复用的解析。三个工具共用同一个闸调用，只修一个等于把洞留在更常用的那个上（`Remove-Item .\tmp -Recurse` 走 `powershell_run` 不传 cwd，一样删到家目录）。另一个佐证：授权书的 `grantRoot` 判据（`06f:183`）只在**显式**给 cwd 时核「须在 grantRoot 内」，不传 cwd 就放行——修前这条命令实际跑在家目录。f3／f4 与反向 ㈡b 专门钉这两个。
2. **解析链多了 `ctx.workingDir`（排在会话 cwd 前）**。原生回合把它注入 ctx（`09:1245`：请求级 cwd，缺省会话 cwd），提示词里的「工作目录」、文件工具根（`12:78-92`）、资源租约（`06g:189`）用的都是它；闸不认它的话，请求级 cwd 与会话头不同时判的又是另一个目录。没有 `workingDir` 的调用方（Kimi 桥、`/api/tools` 直调、MCP 子进程）判法逐字节同修前。
3. **闸交回 `cwd` 而不是导出一个解析函数给三处各调**：派单稿说「reuse the single resolution rather than re-deriving it」——闸在 `ctx.config` 缺席时自己 `readConfig()`，三处再调一次解析就可能拿到另一份配置；直接用闸算出来的那个值，判的就一定是跑的。
4. **③ 同时放宽了 `sk-` 那条**：派单稿列的是带标签的形态；§9.6 发现 5 明说漏网的里有一把「含非字母数字字符的 `sk-` key」，裸出现时新标签式咬不到它。
5. **① 没加 `hasModelsApiKey`**：见上，界面用不上。
6. **判据 ① 的「设置页输入框」没有现成件可跑**：仓里没有任何件打开设置弹窗点「保存」（`saveConfigBtn` 只在 `dom-contract.e2e.js:84` 的 id 清单里查存在、不点）。另做了一次**不进仓**的真浏览器探针（无头 Edge、真按钮），读数见下；没有为它新建 e2e（会顶 e2eCount 与 fixture-home 的 spawn 锁，而服务端往返已由 repo-hygiene (e) 钉住）。

**判据读数**：

- **① modelsApiKey**（`repo-hygiene.e2e.js` 直跑 ALL PASS，36 PASS）：夹具 key 形如 `mk-tes…`（16 字）。
  - ④ `GET /api/status` → `config.modelsApiKey` 实得 `••••wx…`；整个响应体搜明文 **0 处**。
  - ⑤ 设置页形状回传 `{modelsApiBase, modelsApiKey: 掩码, providers: 掩码过的}` → 200；磁盘 `modelsApiKey` 与原值**逐字节相等**；同一次保存里 provider key 也在；回包无明文。
  - ⑥ 回传新明文 `mk-liv…` → 磁盘更新；回包是 `••••ab…`（新值的掩码）；回传 `""` → 磁盘清空。
  - 真浏览器探针（不进仓，13 PASS）：`window.state.config.modelsApiKey` 到达即 `••••wx…`；设置页 Agent CLI 页签 `#cfgModelsApiKey` 播种为同一个掩码、`type=password`；**不动那个框按真「保存」** → 状态栏 ✓、磁盘 key 逐字节不变、provider key 也在；清空后 `Input.insertText` 输入新值再按保存 → 磁盘是新值、`state.config` 刷新成 `••••98…`、`JSON.stringify(window.state)` 里新旧明文都搜不到。
- **② 执行 cwd**（`shell-session.e2e.js` 直跑 ALL PASS，29 PASS；四个目录两两不同：会话 cwd `…\wcw-shell-session-e2e\sess-cwd`、显式 `…\explicit-cwd`、`defaultWorkspace`＝`…\work`、家目录＝自隔离临时家 `…\Temp\ruyi-e2e-home-*`）：
  - (a) 原生回合（fake provider 真工具回合）`shell_start{shellId:'s1'}` 不传 cwd → 工具结果 `cwd` 与 `(Get-Location).Path` 整行都是 `…\sess-cwd`。
  - f1 `/api/tools/shell_start` 带 `sessionId`、不传 cwd → `cwd`＝会话 cwd，`(Get-Location).Path` 同；f2 显式 `cwd` → 打出 `…\explicit-cwd`。
  - f3 `powershell_run` 不传 cwd → stdout `…\sess-cwd`；f4 `script_run`（node，`process.cwd()`）→ 同；f5 `powershell_run` 显式 cwd → `…\explicit-cwd`。
  - f6 会话 cwd 就是 `execute:false` 的工作区 → `shell_start` 实得 `{"ok":false,…,"code":"not-allowed"}`、`powershell_run` 同拒、`shell_list` 里没有 `s8`；f7 允许的会话里显式把 cwd 指进该工作区 → 同拒。
- **③ 脱敏**（`unit/steward-exempt.test.js` 直跑 ALL PASS，111 PASS）：
  - 正形状 **27/27** 全抹且标签留着：JSON `apiKey`／`api_key`（无空格）／`token`（JWT）／`password`／`secret`／`authorization: Bearer`（长、短各一）／`accessToken`／`client_secret`／`x-api-key`／`refresh_token`／`secretKey`／`private_key`／`passwd`；Python dict 单引号；JS 字面量单、双引号；YAML；TOML／Python 赋值；`.env` 词中带引号；PowerShell `$env:… = '…'`；会话文件一层、三层转义；整份 provider 配置（两把 key 都没了）；裸 `sk-proj-…`、裸 `sk-ant-api03-…`、裸 48 位 `sk-`。假值覆盖 48 位字母数字、JWT、32／64 位十六进制、带 `+/=` 的 base64、带 `&` 的口令。
  - 负形状 **16/16** 逐字节不变：`"maxTokens": 4096`、`tokenCount／inputTokens`、usage 块、含 token／password 字样的散文、`token_type`、空值与 `hasKey`、null 与数字值、中文文案值（`"settings.endpointApiKey": "端点密钥…"`）、schema 里的键名数组、嵌套对象值、普通 provider JSON、`tokenizer`、`secretary`、`password_hint`、短值（`none`／`abc`）、`max_tokens=4096`。
  - 计时（上界 3000 ms）：1.00 MB JSON 味文本 **24 ms**（真形状全抹、数字字段原样）；0.74 MB 近似标签对抗串（`token` + 8 反斜杠 + 引号 + 8 空格 + `=` + 8 空格 + 8 反斜杠，重复 2 万次）**9 ms**；1.00 MB 超长值 **6 ms**，开头 4096 字被抹。
  - 既有件原样全绿：B1 脱敏表 8 种、不误伤 5 条（同文件）；`audit`、`session-search`、`steward-exempt-no-swap`、`steward-exempt-shell-send`（见下串行表）。

**反向（改源码 → 重建 → 确认红并打出实得 → 文件备份还原 → sha256 逐字节校验）**：

- **㈠a 摘掉 `maskSecrets` 那一行** → `repo-hygiene` 4 红：`(e④) … masked to ••••wxyz (got "mk-tes…")`、`(e④) full /api/status response contains NO plaintext modelsApiKey (leaked "mk-tes…")`、`(e⑤) POST /api/config response contains NO plaintext modelsApiKey`、`(e⑥) … echoes the NEW key masked, not plaintext (got "mk-liv…")`。
- **㈠b 摘掉 `applyConfigPatch` 里写回还原值那一行**（掩码照下发、保存不还原）→ 恰 1 红：`(e⑤) disk modelsApiKey byte-identical after masked round-trip (got "••••wx…")`——**真密钥被写成了掩码**，正是派单稿要防的那一下。
- **㈡a `shell_start` 分发改回 `shellStart(args, cfg)`**（家目录缺省）→ `shell-session` 4 红：(a)／f1 的 `cwd` 实得 `…\Temp\ruyi-e2e-home-j64HUY`，`(Get-Location).Path` 实得同一个家目录；f3／f4 保持绿（证明各钉各的）。
- **㈡b `powershell_run`／`script_run` 改回 `args.cwd`／`args.cwd || os.homedir()`**（`shell_start` 保持修后）→ 恰 2 红：f3 `powershell_run` 实得 `…\ruyi-e2e-home-BMrFvI`、f4 `script_run` 实得同。
- **㈢a 删掉新的引号键值那一条** → unit 3 红：正形状表点名漏 **17 种**（JSON apiKey｜api_key 无空格｜password｜secret｜Authorization Bearer 短｜accessToken｜client_secret｜x-api-key｜secretKey｜passwd｜Python dict｜JS 单引号｜JS 双引号｜YAML｜一层转义｜三层转义｜整份 provider 配置），1 MB 计时件的「真形状全抹」红，超长值那条红。其余 10 种保持绿是因为旧表别的条目本来就咬得到（JWT、≥40 位十六进制、≥16 字 Bearer、`sk-`）——如实记，不算判据不承重。
- **㈢b `sk-` 那条改回纯字母数字** → unit 恰 1 红，点名 `裸 sk-proj(分段) | 裸 sk-ant-api03(分段)`。
- 六次均按文件备份整组还原（`04`／`05`／`12`／`manifest.json`／`server.js`，㈠b 起加 `13`），`sha256sum -c` 全 OK：`04` `3bf7246b…`、`05` `3e5d8e80…`、`12` `09e7672b…`、`13` `947f2d29…`、`manifest.json` `58debb53…`、`server.js` `37f9976f…`；还原后 `build --check` 新鲜、unit 复跑 ALL PASS。插曲：㈢b 第一次用 `node -e` 带反斜杠的字符串做替换，Git Bash 吃掉一层反斜杠、匹配 0 处、文件未变（sha256 当场核过全 OK）——纪律 7 又一例，改用 Edit 工具重做。

**生成器链与门**：

- `module-dependency-graph --write`：53 模块／**420 边**／1 SCC，**零新增边**（逐边集合比对 HEAD：added `[]`、removed `[]`）；顶层符号 2361 → 2362（03 +1 `resolveExecCwd`）；`module-contracts.json` 03 提供表 +1。
- `build.js`：55441 行（manifest 行区间回填 47 处漂移）。`architecture-contract-snapshots.js --write`：无变化。
- `facts-generate.js` **不跑**：零新 e2e 文件，e2eCount 不变。
- `route-inventory.js`：137 判定点、ROUTE_AUTH 125、告警 0；只有 13 路由行号下移。
- 计数锁重钉：**无**（零新件、零新 spawn、零 CSS、零前端 JS）。
- `build --check` ✓、依赖图 `--check` ✓（53/420）、`--fast` **73/73**（unit 快通道 ALL PASS）。
- 17 个改动文件 NUL／CR／0x00–0x1f 扫描 0；U+FFFD 仅 `server.js` 2 处，与 HEAD 相同。
- 逐件串行（`run-all` 列名，unit 快通道 ALL PASS）**27/27、0 flaky**：repo-hygiene、shell-session、audit、audit-w23、session-search、tool-dispatch、steward-exempt-no-swap、steward-exempt-shell-send、steward-exempt-delegation、config-read-safety、provider-custom-headers、workbench-self-status、dom-smoke、steward-settings（真浏览器）、shell-mcp-guard、autonomy-grant、tools-v3、session-permission-mode、budget-guard、todo-summary、mission-result、websearch、steward-config-tools、steward-decisions、config-providers-guard、steward-presence-gate、kimi-agent-cli。

**全量回归（S0）**：`run-all.js --parallel 4` 退出码 **0**，**356 pass / 0 fail / 1 flaky / 356 ran（7 skipped 为既有 live probe），真回归 0**，unit 全绿、build freshness 一致，用时约 22.5 min（22:30:14 → 22:52:46）。唯一 flaky 是 `perm-v2.e2e.js`：首跑红在 `④ turn did NOT wait out the ~6s permission timeout (elapsed 5683ms)`——④ 那条会话级 plan 档把 `file_write` 判成 block，run-all 打出的首跑 FAIL 行只有这一条（同段「无 `permission_request`」「文件没写」两条没红），红的是「5000 ms 以内返回」这条墙钟上限；回归内重跑绿。回归后串行直跑 3 次 **24/24 ×3**，④ elapsed 2370／2374／2372 ms、① 8468／8414／8419 ms。与本刀零交集：④ 走 edit 档 `file_write` 的 block 门，不经执行闸、不碰掩码；件内 `powershell_run` 只出现在 ③ 的 `toolAllowRules` 规范化。按「并行负载下的墙钟上限断言」登记，不归功于也不归咎于本刀。回归期间没有改 `src/`、没跑别的件（只在 docs 里写本段）；回归前后各调过一次 `stopRuyiTestBrowsers()`。

**发现但没修（登记，交主会话定）**：

1. **`externalMcpServers[].env` 与远程条目的 `headers` 在 `GET /api/status` 里原样下发**：`maskSecrets` 不碰 `externalMcpServers`。进程内实测 `maskSecrets({externalMcpServers:[{…,env:{GITHUB_TOKEN:<假值>}},{…,headers:{Authorization:'Bearer <假值>'}}]})` 两个值原样返回。MCP 运维页的连接器清单（`04:1752`、`13b:54`）早就把 env 全掩了，只有 `/api/status` 的 config 这一份没掩。不在本刀：它不是顶层键，修法要在保存路径按 id＋键名还原（两种形状），前端不回传这一键、今天没有写回风险；Claude Code 自动导入（`autoImportClaudeCodeMcp` 默认开）会把 `~/.claude.json` 里带 token 的 env 原样搬进来，所以真机上是实在的暴露面。
2. **git 族工具缺省 cwd 仍是家目录**（`11:559` `resolveGitCwd`，注释写的是「session/home workspace」）。它们不过执行闸，不是「判的与跑的不一致」这一类，本刀没动。
3. **脱敏的已知边界**：PEM 私钥（值里带空格与转义换行）只抹得到第一段；单个值超过 4096 字时尾部不抹；值里带单引号的双引号串（`"password": "it's…"`）在单引号处收口、短于 6 字就不抹。
4. **会话 cwd 指向已被删掉的目录时**：三个执行工具现在会在那个不存在的目录上起进程并失败（修前落家目录「成功」）。这是 fail-closed，但报错是 spawn 的原话，不是人话。

### S0b · MCP 服务器密钥掩码（2026-09-17）

**开工前重核的坐标**（HEAD `8201336`，全对）：`maskSecrets` 在 `05-claude-engine.js:1304-1324`、`unmaskSecrets` 在 `:1329-1371`、`maskKey`／`KEY_MASK_PREFIX` 在 `:1280-1286`、`sanitizeExternalMcpServer` 在 `:1424-1464`；保存路径的还原在 `13-http-router.js:193-201`。另核出三件派单稿没写、但决定修法形状的事实：

- **`GET /api/status` 的鉴权档是 `open`**（`01b-route-auth.js:4`）——修前本机任何进程不带 UI token 一个 `curl` 就拿到全部 MCP 密钥，不只是浏览器。
- **管家侧两处回显**：`steward_config_get`（`13l:652`）经 `maskProviders` 下发，`externalMcpServers` 是 confirm 档所以**连值带密钥**回给管家模型；`steward_config_set`（`13l:673`）把 `before`／`applied` 原样写进 `undoRef` —— 决策日志（`steward/decisions-v1.ndjson`，`GET /api/steward/decisions` 原样下发 `undoRef`，`13j:280`）与模型的工具结果各一份明文。
- **能力探测会先把连接器拉起来**：`workbench_self_status` 的 counts → `getCapabilities` → `probeDesktopMcp` → `collectBridgedTools`（`06:189`）启动全部外部 MCP；判据 ③「经正常路径起一个子进程看 env」必须先让活客户端失效，否则看到的是保存之前起的那个。

**改了什么**：

- **① 掩码**（`05-claude-engine.js:1300-1413` 一段新 helper，`maskSecrets` 在 `:1437-1438` 调它）
  - `maskExternalMcpServerForDisplay`（`:1329`）：`env` 与 `headers` 的**每一个值**走 `maskKey`（`maskMcpSecretValues`，`:1324`）；键名原样。`args` 走 `mcpArgsForDisplay`（`:1309`）做**显示脱敏**；`command`／`url`／`cwd`／`id`／`label`／`enabled` 原样。
  - `mcpArgsForDisplay` 用 04 的 `redact()` —— **零新边**：`05 → 04` 这条边早就存在且符号表里本来就有 `redact`。旗标与值分在两个元素里（`'--token'`,`'xyz'`）时把前一个元素接上一起过表再切回来；某条规则跨过了两个元素的边界切不回去时，整个元素按脱敏处理（`'Bearer'`,`'<长串>'` 就是这种）。`postgres://user:pw@host` 这类由表里的 URL userinfo 那条抹掉。
- **② 保存路径还原**（`unmaskSecrets` `:1486-1489` → `restoreExternalMcpServersSecrets` `:1397`；`13-http-router.js:195-204` 进入条件加 `Array.isArray(body.externalMcpServers)` 并写回 `merged.externalMcpServers`）
  - 按 **id**（与 sanitize 同口径 trim＋截 64，`mcpEntryIdKey` `:1394`）找磁盘上那一条；`env`／`headers` 里仍以 `••••` 开头的值取**同一个键**的真值（`restoreMcpSecretValues` `:1353`）；新明文直通；来件里没有的键自然删掉；没有匹配 → `''`。
  - `args` 里仍带 `«redacted»` 的元素：原位显示形对得上 → 取原位真值；挪了位置 → 显示形**唯一**对得上才取，歧义或对不上 → `''`（`restoreMcpArgs` `:1365`）。
  - **启动向量闸**（`restoreExternalMcpServerSecrets` `:1378`，见「与派单稿不同之处」1）：stdio 的 `command`＋`cwd` 相同才还原 `args`，还原后的 `args` 整串也相同才还原 `env`；远程比 `url`。
- **③ 最后一道闸**（`mcpSecretValueOrCleared` `:1411`，`sanitizeExternalMcpServer` 里 `headers` `:1556`、`args` `:1569`、`env` `:1573`）：仍是掩码的值、仍带脱敏标记的 arg 一律清空。sanitize 在每次读／写配置（`01:775`）、`import-folder`（`13b:30`）、`import-config/apply`（`13b:84`）、`mcp_configure upsert`（`04:1429`）、Claude Code 自动导入（`01:1828`）、drop-in 运行时合并（`04:1129`）上都过一遍，所以掩码到不了磁盘、`.mcp.json`、Claude／Kimi 同步产物与子进程 env。
- **④ 其它写口与回显面**
  - `04-permission-runtime.js:1427-1429` `mutateMcpConnector` 的 upsert 先按同一条规则还原再 sanitize（模型把 `mcp_list`／`steward_config_get` 读到的掩码原样 upsert 回来时不抹密钥；改了启动向量就清空）。
  - `04:1349` `safeMcpInventory`（`mcp_list`）与 `04:1483` `mcp_configure` 回包的 `args` 显示脱敏（修前原样）。
  - `13b-api-domain-routes.js:52-54` `import-folder` 回包改用同一个 `maskExternalMcpServerForDisplay`（修前只遮 env，远程清单的 `headers` 原样回显）。
  - `13l-steward-ops.js:711-716` `steward_config_set` 的 sanitize 探针先 `unmaskSecrets` 再比（否则管家原样回传掩码会被 ③ 清空、误判成「没活过 sanitize」而整份拒绝）；`:721-725`／`:735-737` `before`／`applied` 过 `maskProviders`。
  - 同步目标核过、不用改：`applyConfigPatch` 调 `syncMcpServersToClaude(next)`／`syncMcpServersToKimi(next)` 时的 `next` 是 `mutateConfig` 落盘后的那份（已还原、已 normalize）；启动期同步（`13:1909-1910`）、`generateMcpConfig`（`01:2706`）、子进程 `resolveExternalMcpServers` 都从 `readConfig` 读盘。
- **测试**（**零新文件**，e2eCount 不变）：
  - `repo-hygiene.e2e.js` 新增 (f) 段（`:256` 起，独立实例＋假 `claude.cmd` 记实参＋`KIMI_CODE_HOME` 指进夹具＋进程内假远程 MCP 记 `Authorization`），`postJson` 加可选超时参数。
  - `steward-config-tools.e2e.js` 新增 (I) 段（`:172` 起；夹具加一个**停用**的带密钥 MCP，停用＝不起子进程不同步、掩码照样要盖住）。
  - `config-mutate-mcp-parity.e2e.js` T12（`:161` 起，工具面 upsert 往返）；`mcp-import-config.e2e.js` H13；`mcp-config.e2e.js` import-folder 段加远程清单两条（`:122` 起）。
  - `fake-mcp.js:74-82` 加可选 env 捕获（`FAKE_MCP_ENV_CAPTURE`＋`FAKE_MCP_ENV_CAPTURE_KEYS`，启动时写一行 JSON；工具表不变）。
  - 假值全部运行时拼出，失败信息只打前 6 个字符，沿用 S0 口径。

**口径决定：env／headers 全遮，不按键名挑**。名字白名单一定漏：MCP 的 env 名是各家服务自己起的（`GITHUB_PERSONAL_ACCESS_TOKEN`、`X_KEY`、`DB_URL`、`NOTION_INTEGRATION`……），而且 MCP 这一格的常态恰恰是「值就是凭据」——与 `providers[].extraHeaders` 反过来（那里绝大多数是 `X-Organization` 这类非密钥头，所以 S0 之前那份按名字挑）。按值猜「像不像密钥」同样不可靠（S0 的脱敏表 27／16 形状就是为此攒的，仍有已知边界）。代价，照实记：非密钥值也看不见了（`PYTHONUTF8=1` 显示成 `••••1`——`maskKey` 的「末四位」对 ≤4 字的值等于全显，与 providers 同规则，这么短的不是凭据）；远程头里的 `${VAR}` 引用也被遮成 `••••KEN}`（往返照常还原）。键名全可见，用户与管家看得出配了哪几个变量；换值 = 回传新明文。**界面上今天没有 MCP env／headers 的编辑器**（设置页运维面板只显示 `commandOrUrl`，`settings-operations.js`），所以「看见键、换值」目前只经 API（`POST /api/config`）或管家 `steward_config_set`／模型 `mcp_configure`。

**与派单稿不同之处（逐条给理由）**：

1. **还原多了一道「启动向量没变」的闸**。派单稿只要求「同 id＋同键」。只按 id 还原的话，一份回传的掩码就成了「**看不见密钥也能把它改接到别的程序／端点上**」的把手：管家提议一份把 `command` 换掉、`env` 仍是掩码的 patch，用户随手一按；或普通线程的模型经 `mcp_configure` upsert 同一个 id（exec 档，全自动下不问）——密钥跟着去了新程序。`npx -y <包名>` 这类启动器下只比 `command` 不够，所以 `args` 也要整串相同。代价：同一次保存里改了命令／参数／地址，就得重填那几个值。providers 那一套没有这道闸（见「发现但没修」3）。
2. **加了 sanitize 那道闸（③）**，派单稿没要求。写 `externalMcpServers` 的口子有六个、还有 drop-in 与每次读配置，逐个补「清空」就是又一份手攒名单；放在 sanitize 里一处全覆盖，将来新增写口也逃不掉。它的副作用有两个，都照实处理了：`steward_config_set` 的探针必须先还原再比（改了 `13l`）；反向 ㈡ 只摘还原时磁盘上看到的是 `''` 不是掩码——另做了 ㈡b（连闸一起摘）才看到掩码落盘。
3. **两个导入口不还原、只清空**（`import-folder`、`import-config/apply`）。它们的值来自外部清单或客户端，不存在「合法地回传掩码」的流程（设置页那张「一键应用」卡发的是 `env: {}`），闸 ③ 清空即可；`mcp_configure upsert` 会还原（模型读到掩码再写回同一条是常态）。
4. **多修了派单稿没点名的回显面**：`steward_config_set` 的 `applied`／`undoRef`（进决策日志与模型）、`import-folder` 回包的 `headers`、`mcp_list` 与 `mcp_configure` 回包的 `args`。
5. **判据 ③ 的子进程**：测试里先 `connectors/toggle` 停用再启用（同一个 `invalidateMcpRuntime` 杀活客户端）再 `connectors/health`，理由见上面坐标第三条。
6. **`url` 按派单稿原样不掩**，但它确实能带密钥，记进「发现但没修」2。

**判据读数**（`<头6字>…` 为失败信息口径；假值形如 `ghp_S0…`、`fakeBe…`）：

- **① 下发面**（`repo-hygiene.e2e.js` 直跑 ALL PASS，66 PASS）
  - `GET /api/status` 全文搜四个假值（stdio 的 `GITHUB_TOKEN`、远程的 Bearer、args 里 `--token` 的值、postgres 口令）**0 处**；`env` 键名 `["GITHUB_TOKEN","FAKE_MCP_ENV_CAPTURE","FAKE_MCP_ENV_CAPTURE_KEYS","DROP_ME"]` 全可见、四个值全是 `••••` 开头（`GITHUB_TOKEN` 实得 `••••WX…`）；远程 `headers.Authorization` 实得 `••••xy…`；`args` 实得 `["--token","«redacted»","postgres://svc:«redacted»@127.0.0.1/db"]`；`id`／`command`／`url`／`enabled` 原样。
  - `POST /api/config` 回包、`GET /api/mcp/connectors`、`/api/tools/workbench_self_status`、`/api/tools/mcp_list`（`args[2]` 为 `«redacted»`）全文 **0 处**。
  - `steward_config_get`（`steward-config-tools.e2e.js` 直跑 ALL PASS，60 PASS）：`env.GITHUB_TOKEN` 实得 `••••MN…`、`args[3]` 为 `«redacted»`、返回体 0 处明文。
- **② 保存往返**
  - 把 status 拿到的掩码数组原样 `POST /api/config` → 200，磁盘 `externalMcpServers` 与启动后 normalize 的那份 **`JSON.stringify` 逐字节相等**。
  - 同一份里把 `GITHUB_TOKEN` 换成新明文、删掉 `DROP_ME` → 磁盘是新值（`ghp_S0…` 新串）、`DROP_ME` 没了、其余掩码值与 `args` 还原成真值；回包不含新明文。
  - 追加一个带别人掩码的新 id `hyg-new`、一个改了 id 的远程 `hyg-remote-renamed` → 磁盘 `env.GITHUB_TOKEN` 实得 `""`、两个脱敏 arg 实得 `""`、`Authorization` 实得 `""`；原条目同一次保存里仍是真值；`config.json` 全文无 `••••`／`«redacted»`。
  - 同 id 改 `command`／`url` 回传掩码 → `env` 实得 `""`、header 实得 `""`，磁盘不含任何假值。
  - 管家：`steward_config_set` 原样回传掩码（`userPressed`）→ `ok`，磁盘逐字节不变；`applied`／`undoRef` 与磁盘决策日志里 0 处明文。工具面（`config-mutate-mcp-parity.e2e.js` 直跑 ALL PASS，32 PASS）：只改 label 的掩码 upsert → 真值逐字节还原；改 `command` 的 → 清空、无掩码落盘。导入口：`import-config/apply` 收到 `••••abcd`／`«redacted»` → 值清空（`mcp-import-config.e2e.js` 直跑 33 PASS）；`import-folder` 远程清单回包 `Authorization` 为掩码、磁盘真值、清单里残留的 `••••abcd` 被清空（`mcp-config.e2e.js` 直跑 37 PASS）。
- **③ 掩码到不了的地方**（repo-hygiene (f)，都是「掩码回传保存」之后、先清掉启动期产物再看）
  - `config.json` 无掩码无标记；重生成的 `generated/workbench.mcp.json` 里 `env.GITHUB_TOKEN`／`args[2]`／`headers.Authorization` 是真值。
  - Kimi 同步（这次保存重写的 `KIMI_CODE_HOME/mcp.json`）三处真值、无掩码。
  - 假 `claude.cmd` 记下的 `mcp add-json hyg-stdio …`（1 次）实参里含真 token、真 arg、真口令。
  - `connectors/health` 新起的 fake-mcp 子进程自报 `GITHUB_TOKEN` 实得 `ghp_S0…`（真值）、`DROP_ME` 在；远程探测 3 个请求全部带真 `Authorization`（实得 `Bearer…`）。

**反向（改源码 → 重建 → 确认红并打出实得 → 文件备份还原 → sha256 逐字节校验）**：

- **㈠ 摘掉 env 掩码那一行**（`maskExternalMcpServerForDisplay` 里的 `out.env = …`）→ `repo-hygiene` 6 红：`(f①) GET /api/status body has 0 plaintext MCP secrets (leaked GH)`、`every env value masked (got "ghp_S0…")`、`POST /api/config response … (leaked GH)`，以及三条 ② 连带红（回显变成明文后回传的就是明文，按「新明文照存」走——新 id 与改了 command 的条目实得 `ghp_S0…`，正说明这两条判据咬的是掩码）；`steward-config-tools` 4 红：I2（实得 `ghp_St…`）、I3、I6、I7。
- **㈡a 摘掉 `applyConfigPatch` 里写回 `merged.externalMcpServers` 那一行** → 8 红，头一条 `(f②) disk externalMcpServers byte-identical after masked round-trip (GITHUB_TOKEN "")`——**一次保存把真密钥抹成了空**（闸 ③ 把残留掩码清了）；③ 的 `.mcp.json`／Kimi／`add-json`／子进程（实得 `undefined`：捕获文件里没有新行——捕获路径 `FAKE_MCP_ENV_CAPTURE` 本身也是一个被回传成掩码、再被清空的 env 值）／远程头（实得 `null`）全红。
- **㈡b 在 ㈡a 基础上再摘掉闸 ③** → 12 红，`(f②) … byte-identical … (GITHUB_TOKEN "••••WX…")`——**掩码写进了 `config.json`**，`(f③) config.json contains no mask` 红；新 id 实得 `••••QR…`、header 实得 `••••xy…`。插曲：这一轮 fake-mcp 的 `FAKE_MCP_ENV_CAPTURE` 也成了掩码，子进程在工作目录里建了一个名叫 `••••json` 的文件、内容 `{"env":{"••••P_ME":null}}`——掩码一路流进子进程 env 的现场样本；已删。
- **㈢ 摘掉启动向量闸**（`sameTarget` 只看有没有同 id 条目、`sameArgs` 恒等于它）→ `repo-hygiene` 恰 1 红：`(f②) same id but changed command/url → … NOT re-attached (env "ghp_S0…", header "Bearer…")`——密钥跟着改了 command／url 的条目走了；`config-mutate-mcp-parity` 恰 1 红：T12e。
- **㈣ 只摘闸 ③**（还原保留）→ `mcp-import-config` 恰 1 红 H13、`mcp-config` 恰 1 红（远程清单残留掩码）；进程内读 sanitize 实得 `{"env":{"TOKEN":"••••abcd"},"args":["x.js","--token","«redacted»"],"headers":{"Authorization":"••••wxyz"}}`；`repo-hygiene` **仍 ALL PASS**——`/api/config` 那条路由还原自己兜得住，闸 ③ 钉的是导入口，各钉各的。
- **㈤a `steward_config_set` 探针改回拿原样 patch 比** → I4 红（实得 `invalid_request`，管家原样回传掩码被整份拒绝）、I7 连带红（没写就没有决策行）。**㈤b `before`／`applied` 改回不掩** → 恰 I6、I7 红（明文进了回包与磁盘决策日志）。
- 七次均按文件备份整组还原（`04`／`05`／`13`／`13b`／`13l`／`manifest.json`／`server.js`），`sha256sum -c` 全 OK：`05` `28b31c4a…`、`04` `a8898b95…`、`13` `ff880b63…`、`13b` `e1b23dad…`、`13l` `56a1290a…`、`server.js` `06e5ce45…`、`manifest.json` `73ae1460…`。

**生成器链与门**：

- `module-dependency-graph --write`：53 模块／**420 边**／1 SCC，**零新增边**（逐边集合比对 HEAD：added `[]`、removed `[]`）；顶层符号 2362 → 2375（05 +13）；三条既有边的符号表变了：`04→05` +`mcpArgsForDisplay`／`restoreExternalMcpServerSecrets`，`13b→05` +`maskExternalMcpServerForDisplay` −`maskKey`，`13l→05` +`unmaskSecrets`。
- `build.js`：55574 行。`architecture-contract-snapshots.js --write`：无变化（`--check` current）。
- `facts-generate.js` **不跑**：零新 e2e 文件。
- `route-inventory.js`：137 判定点、ROUTE_AUTH 125、告警 0；只有 13 路由行号下移。
- `build --check` ✓、依赖图 `--check` ✓（53/420）、`route-inventory --check` ✓、`--fast` **73/73**。
- 19 个改动文件（含本文）NUL／CR／0x00–0x1f 扫描 0；U+FFFD 仅 `server.js` 2 处，与 HEAD 相同。
- 逐件串行（`run-all` 列名，unit 快通道 ALL PASS、build 新鲜）**28/28、0 flaky**：repo-hygiene、steward-config-tools、config-mutate-mcp-parity、mcp-config、mcp-import-config、mcp-import-origin、mcp-ops-closure、mcp-remote-transport、mcp-bridge、fake-mcp-contract、checkpoint-mcpchild、shell-mcp-guard、config-read-safety、provider-custom-headers、workbench-self-status、dom-smoke、steward-settings（真浏览器）、steward-decisions、kimi-agent-cli、capabilities、tools-v3、desktop-mcp-smoke、bridged-read-noprompt、bridged-prefix-tolerance、config-providers-guard、steward-tools、mcp-ops-gui.static、browser-mcp.static。跑完无残留测试 Edge／node。

**全量回归（S0b）**：`run-all.js --parallel 4` 退出码 **0**，**356 pass / 0 fail / 1 flaky / 356 ran（7 skipped 为既有 live probe），真回归 0**，unit 全绿、build freshness 一致，用时约 21.5 min（23:30:02 → 23:51:39）。唯一 flaky 是 `checkpoint.e2e.js`：首跑红在 (c) 段两条——`(c) rollback turn 3 ok` 与紧跟的 `(c) after rolling back turn 3, a.txt content = the turn-2 version (v2-recreated)`；同段前面「journal 有 turn-2 create／turn-3 modify 两条」没红，件内 `postJson` 不设超时、解析失败才抛，所以首跑是**真拿到了一个 `ok !== true` 的回滚回包**、文件随之没回到 v2（run-all 只留标题，首跑回包原文没保留，具体错误码无从得知，如实记）。回归内重跑绿；回归后串行直跑 3 次 **38/38 ×3**。与本刀零交集：该件夹具不配 `externalMcpServers`、不调 `/api/config`，走的是 `/api/tools` 的 `file_write`／`file_edit` 与 `/api/checkpoints/rollback`，不经掩码、还原与 sanitize 闸。按「并行负载下的回滚时序」登记，不归功于也不归咎于本刀。回归期间没有改 `src/`、没跑别的件（只在 docs 里写本段）；回归前后各调过一次 `stopRuyiTestBrowsers()`。

**发现但没修（登记，交主会话定）**：

1. **`POST /api/mcp/import-config/scan` 仍原样回显 `~/.claude.json`／`~/.codex/config.toml` 里的 env 与 headers**（`13b:61-72`，token 档）。不在本刀：scan → apply 的契约是客户端把 scan 拿到的整条原样交给 apply，扫描结果一掩，apply 就得回头按 `source` 重读源文件才拿得到真值——要改契约；前端今天没有调用方（只有 e2e）。
2. **远程条目的 `url` 不掩**（按派单稿）。`https://user:pass@…` 与 `?api_key=…` 形态会经 `GET /api/status`、`steward_config_get`、`mcp_list` 明文下发（`/api/mcp/connectors` 用 `safeUrlForDisplay` 只剥 userinfo）。要掩得先定一件事：`url` 是远程条目活过 sanitize 的必备字段，「无匹配清空」会让整条连接器静默消失。
3. **providers 的还原没有启动向量闸**：同一次保存里改了 `baseUrl`、`apiKey` 仍是掩码，照样还原真 key（`05` `unmaskSecrets` 的 providers 段、`unmaskProviders`）——与本刀给 MCP 关上的是同一类口子。
4. **本刀之前写下的管家决策日志不回溯清洗**：若管家曾用 `steward_config_set` 改过 `externalMcpServers`，`steward/decisions-v1.ndjson` 里已有明文，`GET /api/steward/decisions` 原样下发 `undoRef`。
5. **没有 MCP env／headers 的界面编辑器**（见「口径决定」），「看见键、换值」只经 API／管家／模型工具。
6. **（主会话复核补记）管家配置改动的 `undoRef.before` 现在是掩码**：全仓没有任何代码自动消费 `{kind:'config'}` 的 undoRef（前端 `undoHandOff` 只处理递话回退），它只是给管家「照着改回去」的参考。于是有一个窄场景：管家删掉一条带密钥的连接器、之后再照 `before` 手动加回来——掩码按 id 在当前配置里找不到原值，env／headers 会被清成空串。换来的是决策日志与回给模型的结果不再带明文；要两全得把 `before` 的明文另存在只落盘不下发的位置，本刀不做。

**主会话独立复核（提交前）**：ListAgents 确认实现 agent 已 completed；工作区零未跟踪文件（反向 ㈡b 期间落进仓里的 `••••json` 已删、复查无残留）。实读确认 `GET /api/status` 的 ROUTE_AUTH 是 `open`（`01b-route-auth.js:4`，只有 host 门）——修前本机任何进程不带 token 就能读到全部 MCP 密钥与 `modelsApiKey`，**本刀与 S0 合起来关掉的是一个无鉴权的本机泄密面**。审 `05` 新增的掩码／还原与「同一启动目标才还原」判据、`13l` 的 before／applied 掩码，并按上面第 6 条核了 undoRef 的消费面。独立复跑：`build --check` 新鲜、依赖图 `--check` 53/420、19 个改动文件控制字节 0；repo-hygiene 66/0、steward-config-tools 60/0、config-mutate-mcp-parity 32/0、mcp-import-config 33/0、mcp-config 37/0、mcp-bridge 9/0、mcp-import-origin 17/0、mcp-ops-closure 101/0、mcp-ops-gui.static 54/0、mcp-remote-transport 23/0、config-read-safety 18/0、provider-custom-headers 23/0、workbench-self-status 47/0、dom-smoke 53/0、steward-settings 73/0、checkpoint 38/0（回归里的 flaky 件）、steward-guardrails 193/0。

### ⓪ F5 · flaky 第五批（2026-09-17）

**只动测试与 `run-all.js`**：`src/` 零改动，`ruyi-workbench/app/src/` 一个字节没碰。三件每件都**先在负载下复现、拿到失败那一刻的形状、分了类才动手**（45 号文 §9.5 的纪律）；反向都做在最终文件上，按文件备份还原并核 sha256。

**负载怎么造的**：两路常驻 `run-all --parallel 3` 循环 —— A 路 12 件（steward-guardrails／steward-tools／steward-runner／scheduler-steward／workbench-memory／subagent／autonomy-grant／team-pool-mailbox／failover／mission-threads／event-stream／session-search，跑了 40 轮）、B 路 10 件（context-compact-v2／steward-board／tools-v3／checkpoint／mcp-config／repo-hygiene／usage-ledger／capabilities／steward-decisions／shell-session，28 轮）；候选件同时单跑作第三路（下称「双负载」，CPU 采样 17–96%）。「冷能力缓存」＝每跑给服务进程的 PATH 追加一段不存在的目录换一把缓存键（§9.5 同法，不碰缓存文件）。探针都是 scratchpad 里的临时副本，不进仓。

#### ① `agent-deadlock-watchdog.e2e.js` Section 2 —— 分类：**前提没成立**（不是「会合点回落」）：冷能力探针钉住事件循环，本件给 Section 3 用的 3 s 节点看门狗先把两条节点杀了

- **病历先重读**：42 号文 §5-undecies 那份病历的原文是「会合点到齐:一发都没到」。修前 `rendezvousNote()` 只分「回落／到齐」两支，**一发都没到的时候也打「到齐」**；那一节把它读成「会合点在如实报告它回落了」是读反了 —— 会合点根本没被碰到。
- **复现**：探针只跑 Section 1/1b/2，逐发记 provider 到达、打出两条节点的终态与进度。单负载 5/5 绿（「获得资源 → 子代理初始化中」约 2 s）。**双负载＋冷缓存 6 跑 5 红，签名与登记的一字不差**；再交替跑 5 对：原件 4/5 红，「起跑前先等预热」的变体 5/5 绿。
- **形状**（红的那 9 跑一模一样）：`fellBack=false`、provider **一发请求都没收到**；两条节点都是 `failed/idle_timeout`、`节点空闲超时（>3秒无进展）`；进度（例）：两条「获得资源」27.307／27.370 → **7.0 s 空白** → 两条「子代理初始化中」落在**同一毫秒** 34.353（解钉后同一拍）→「子 Agent 启动」34.843／34.846 →「子 Agent 失败 · 0 字」。红的那几跑空白 5.1–12.6 s；也有一跑空白 6.0 s 却没被杀 —— 解钉后看门狗与初始化心跳谁先跑是时序决定的。
- **机制**：子代理初始化里第一发 `getCapabilities`（`08-agent-runs.js:518`）冷缓存时同步 spawnSync 探桌面 python，把事件循环钉住（§9.5 ① 登记的同一笔产品债，双负载下从 2.5 s 拉到 5–12 s）；本件设了 `WCW_AGENT_NODE_IDLE_MS=3000`（给 Section 3 的挂死节点用），解钉后节点看门狗那一拍（`09-workflow.js:284`）跑在初始化心跳前面，两条节点在发 provider 请求之前就被判空闲杀掉。生产上节点看门狗下限 60 s，这个钉住杀不到人 —— 是本件测试缝太紧。
- **治法**（`agent-deadlock-watchdog.e2e.js`）：
  - `:73-99` 会合点加 `paired`（两发 round-0 真的凑成过一对才置位），`rendezvousNote()` 分三支：回落／到齐／**没凑齐**。
  - `:258-274` Section 2 起跑前先 `GET /api/status`（它 `await ensureDesktopMcpWarm`，异步探针不占事件循环），答复回来＝冷探针已付完；等的是这一发答复，60 s 只是它自己的防挂死预算，耗时打进日志。
  - `:296-307` 两条争用断言**只在 `paired` 时照常判**；没凑成对时打 `SKIP 不适用 <标签>（前提没成立,两把节点租约没有同时握住:<会合点现场>；节点 alpha=…，beta=…）`，不报红、不假装撞上过。「跑到终态」那条不受这个前提约束，照判。
- **反向**：
  - R1 去掉预热（其余不动），双负载＋冷缓存 5 跑：**3 跑打 `SKIP 不适用 …（…会合点没凑齐:一发都没到；节点 alpha=failed/idle_timeout，beta=failed/idle_timeout）`**、2 跑凑成对照常 PASS；5 跑退出码全 0 —— 登记的那个形状现在如实报「不适用」。
  - R2 `subagentMaxConcurrent: 1`（强制回落）2 跑：两条都是 `SKIP 不适用 …（…会合点回落:alpha+0ms／beta+1247ms,等不到第二发,1200ms 后单发放行；节点 alpha=succeeded，beta=succeeded）`。
  - R3（**凑成对时照样咬**）：只改构建产物 `app/server.js`（`resourceBlockers` 开头插 `return [];`，租约永不冲突；`src/` 不动），空闲跑：`FAIL a node recorded a resource wait …（会合点到齐:alpha+0ms／beta+0ms）`、`FAIL a node recorded a failed tool result …（会合点到齐:…）`，连带 Section 1/1b 五条红，`FAIL (7)`。还原后 `server.js` sha256 `06e5ce45…` 逐字节相同、`build --check` 新鲜。
  - 测试文件在 R1／R2 后按备份还原，sha256 `b21976c8…` 逐字节相同（之后只加了 2 行豁免注释，diff 已核）。
- **稳定**：双负载＋冷缓存 **8/8 ALL PASS，8 跑全部凑成对**（预热 3.3–11.6 s）；空闲直跑 27 PASS。

#### ② 写死墙钟窗口的件 —— 机械锁 ＋ 逐件分类（42 号文 §5-undecies 留给 107 的第二件）

- **扫描形状**（`dev-harness/lib/wallclock-window-scan.js`，新 lib 模块，不是 e2e）：`ok(…)`／`assert(…)` 的条件里有**上界**比较（`量 < 界`、`量 <= 界` 或镜像），「量」是时钟减法得来的时长（就地的 `Date.now()／performance.now()／process.hrtime／Date.parse(` 减法，或本文件里由它赋值、再沿赋值传下去的名字，含 `function latencyMs(f)` 这种），「界」里不再出现任何量出来的值（两边都是量出来的算相对／次序判据，不算）。下界不算（负载只会把耗时拉长）。注释、字符串、模板串、正则字面量先抹成空白再扫。**首跑 22 件 43 处，静态件 0 处误报**；§9.5 手扫的「`elapsed <` 8 件」全在其中。
- **逐件分类**（读数是双负载实得，括号里是空闲直跑）：
  - **墙钟本身就是被测量 → 进独占桶（6 件，`run-all.js:131-150`）**：`perf`（冷启动 1526 ms／门 7500、会话加载 14.4 ms／门 2000 —— 性能预算，108 波红过）；`boot-listen-budget`（spawn → /health **2287 ms／门 2500**，离门 9%）；`event-stream`（八条延迟 0–1 ms／门 1000 —— 34 号文 §6.3 的预算本身，与已在桶里的 event-stream-client.browser 同理由）；`steward-board`（R4「下一拍复核 ≤ 12 s」量的是 5 s 节拍，R8／S7 点一下 ≤ 5 s，真 Edge＋CDP，123／125 两波上过榜）；`scheduler-ready-queue`（总时长 **7905 ms／门 15000，只剩 1.9 倍**）；`autonomy-durability`（MTTR **12264 ms／门 30000**，产品 SLO）。
  - **已在桶里（4 件）**：event-stream-client.browser（7 处）、focus-rail.browser、one-workbench-frame.browser、mission-index-scale。
  - **墙钟只是代理的紧界 → 改判（2 处）**：
    - `perm-v2.e2e.js:150-161` ④：原 `elapsed < 5000` 代理「是被拦下的、不是问了没人答」（S0 全量 5683 ms、125 干净基线 6152 ms 两次首跑红；双负载 3943 ms，空闲 2384 ms）。探针打出两条路的事件流：① 问的那条是 `tool_use → permission_request → permission_decision(deny) → tool_result{ok:false,"permission prompt timed out"}`；④ 拦下的那条是 `tool_use → tool_result{ok:false,"计划模式:…"}`，两个 permission 事件都没有。新判据＝**tool_use 之后是一条 ok:false 的工具结果、且全流没有 permission_decision**；耗时只进标签。反向 P1（④ 的 PATCH 改成 `default`，走问的那条路）→ 新判据红，实得 `got {"ok":false,"error":"permission prompt timed out"}; elapsed 9014ms`。稳定：双负载 5/5（④ 读数 2540–2878 ms）、空闲 24 PASS。
    - `thread-arbiter.e2e.js:315-325` ④：原 `pendElapsed < TURN_MS*2`（1800 ms），双负载 5 跑 951–989 ms、收读数那一跑（又叠了一路）**1608 ms（1.1 倍）**，§9.5 红过 2006／2806。改判次序，与 ① 同一推理：等了并发位的话，它的首段正文至少比占位者晚 `TURN_MS`；判「晚不到 900 ms」。**反向 A1**（不写那条待决干预，让它真去排队）→ 新判据红「只比占位者晚 **936ms**」，**同一跑耗时 1740 ms —— 旧界 1800 在这一跑里照样是绿的**，旧判据根本没咬住「等了位」。稳定：双负载 5/5（晚 141–171 ms）、空闲 103 PASS（172 ms）。
  - **防挂死宽界、或次序判据本身 → 就地「墙钟上界豁免」（11 件 15 处）**：agent-deadlock-watchdog ×2（305／0 ms，界 3000／300，进程内原语）、agent-loop（34 ms（28），界 500；标签补了读数）、boot-resume-parallel ×2（U2 92 ms（91）／280、L1 2100（1561）／30000）、bridge-cancel-timeout（2330（1967）／25000）、budget-guard E18（5587（5444）／25000）、long-tool-liveness-steer ×2（1197／1064（1141／982）／10000）、session-permission-mode ⑥（11（8）／1500）、steward-guardrails L3（194（176）／6000）、summary-parallel-cap B3（26（19）／5000）、thread-arbiter ①④（次序判据：跨度 16（5）ms、晚 141–171（172）ms，界 900）、workspace-resolve ⑦（1015（1009）／4000）。每句豁免写「正常实得／界／失败形态多长」。
- **锁**（`fixture-home.static.e2e.js:305-363`，与 percentile、一次性浏览器两条同一块）：
  - 先钉 owner：扫到的**文件数钉成常量 21**（首跑 22，perm-v2 ④ 改判后该件不再有这个形状），另加「≥ 15 件」下限；
  - 每一处：所在文件在 `PARALLEL_EXCLUSIVE`（照既有写法从 run-all 源码里抠名单）**或**断言行／紧挨着的上方注释行里有 `墙钟上界豁免：<≥12 字理由>`；
  - **反向也锁**：每句「墙钟上界豁免」都必须挂在一处真被扫到的断言上，孤儿当场红（断言改掉后留下的旧理由不能替新紧界背书）。
- **锁的反向**（静态，逐次备份还原、sha256 全 OK）：L1 从桶里拿掉 `event-stream.e2e.js` → 红并逐条点名 `event-stream.e2e.js:290「latencyMs(say) <= 1000」…`；L2 删掉 workspace-resolve 那句豁免 → 红点名 `workspace-resolve.e2e.js:138「elapsed < 4000」`；L3 在 perm-v2 一条非墙钟断言上加豁免 → 孤儿红点名 `perm-v2.e2e.js:161`；L4 把 perm-v2 换回 HEAD → 件数 22≠21 红 ＋ 点名 `perm-v2.e2e.js:150「elapsed < 5000」`；L5 让扫描器 `Date.now()` 那一支失明 → 下限红（实得 6 件 20 处）、件数红、15 句豁免全成孤儿。
- **`thread-arbiter` ⑩（派单点名）没改**：双负载下 11 跑（收读数 1 ＋ 专跑 5 ＋ 稳定性 5）⑩ 全绿，**没复现**；§9.5 那两发红在 27 个资源管理器窗口拖慢的作废轮里。它的窗口是 `sleep(150)`／`sleep(200)` 之后假设「B 已经在排队」—— 这类「睡固定毫秒后假设某事已发生」没有零误报的机械形状，扫描器头注里登记为扫不到，下次再红先拿病历。
- **扫不到的（登记）**：经 CDP 字符串带回来的时长（ec-d-performance，已由 percentile 那条钉进桶）；自己算百分位的（同）；sleep 窗口（上一条）。

#### ③ `budget-guard.e2e.js` E30 —— 分类：**两台服务的环境不同**，不是 44 号文猜的「normalizeCapText 漏了墙钟字段」

- **复现**：探针＝原件＋「E30／E4 不等时把两份归一化请求体落盘、打出首个差异」。**双负载 6 跑：4 红 E30、1 红 E4、1 绿。**
- **形状**：两份请求体逐行比，**唯一的差别**是易变层第一行 `当前能力：在线；桌面操控工具 0 个；…` 对 `… 104 个；…`（哪个栈是 0 每跑不同）；`tools` 两边都是 24 个，其余逐字节相同。
- **机制**：`launchStack` 的配置没关桌面 MCP，九个栈每个都从仓里自动探到真的 ai-computer-control（python）并桥接（`probeDesktopMcp → collectBridgedTools`，`06-provider-engine.js:186-201`）；负载下哪个栈在回合时没连完，它的 `deskN` 就是 0。与预算保护无关。
- **治法**（`budget-guard.e2e.js:50-56`）：`launchStack` 配置里钉 `desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false }`（同 `bridge-cancel-timeout.e2e.js` 的写法）。**不放宽逐字节比较、不动 `normalizeCapText`**。
- **反向**：删掉那一行、双负载 4 跑 → 3 红（E4 ×2、E30 ×1）；按备份还原 sha256 `dcb0e95b…` 逐字节相同（之后只加了 E18 那句豁免）。
- **稳定**：双负载 **6/6 ALL PASS，每跑 E4／E30 都 identical**；空闲直跑 57 PASS。顺带：九个栈不再各起一个 python ACC，同档负载下单件约 76 s → 约 52 s（逐跑起始时刻差）。

**生成器链与门**：

- `src/` 零改动 → 依赖图 `--write`／`build.js`／`architecture-contract-snapshots` 不跑；`build --check` 新鲜、依赖图 `--check` 53/420、`syntax-gate` 582/0。
- **零新 e2e 文件**（`lib/wallclock-window-scan.js` 不计 e2eCount）→ `facts-generate.js` 不跑、README 计数不动、fixture-home ① 的 spawn 锁仍 148（`facts.static` ALL PASS）。
- **`route-inventory.js` 重生成**：`--fast` 首跑 `route-inventory.static` 红 —— agent-deadlock-watchdog 新出现 `/api/status` 字面量，覆盖列 41 → 42 件；重生成后 json／md 只动这一格与 `generatedAt`，`--check` OK。
- `--fast` **73/73**；改动 20 个文件（含新 lib、route-inventory 两件与本文）NUL／CR／0x00–0x1f 扫描 0、U+FFFD 0。
- **逐件直跑（空闲）12/12**：agent-deadlock-watchdog 27、agent-loop 25、boot-resume-parallel 15、bridge-cancel-timeout 20、budget-guard 57、long-tool-liveness-steer 15、perm-v2 24、session-permission-mode 90、steward-guardrails 193、summary-parallel-cap 17、thread-arbiter 103、workspace-resolve 37（1 SKIP 为既有「pick-folder 真对话框」）；**静态件 run-all 列名 17/17**：fixture-home（28 PASS）、overlay-payload-lock（13 PASS）、facts、route-inventory、module-dependency-graph，以及读 `build-overlay.js` 的 copy-path-guard／desktop-dpi／frontend-domains／health-i18n／mermaid-render／onboarding／steward-avatar／steward-board／steward-conversation／steward-drawer／steward-settings／steward-shell。

**全量回归（⓪＋② 合跑，主树 `c94dc7a`＋本批未提交改动）**：`run-all.js --parallel 4` 退出码 **1**，**355 pass / 1 fail / 0 known-fail / 1 flaky / 356 ran / 7 skipped**；unit 全绿、build 新鲜、端口审计零撞车；独占桶 27 件；用时约 24.5 min（09-18 01:08:40 → 01:33:17）。开跑前 CPU 3%、负载循环已停、调过 `stopRuyiTestBrowsers()`；回归期间没改 e2e／src、没跑别的件（只在 scratchpad 起草本段）。**本批动过的件全部首跑即过**（结尾 flaky 名单是权威）；新进独占桶的六件首跑即过：autonomy-durability 29.0 s、boot-listen-budget 4.5 s、event-stream 8.2 s、perf 2.1 s、scheduler-ready-queue 11.8 s、steward-board 24.3 s。

| 件 | 回归里 | 串行复跑与对照 | 归类 |
|---|---|---|---|
| `scheduler-ui.browser.e2e.js`（红；本来就在独占桶） | 首跑红（首跑那次只留末 8 行，红在哪一条没留下）；重跑红 `B1 schedule.changed 帧到达之后口袋角标变 1` | 主树直跑 3 跑 2 红（B1）、再 3 跑 1 红（B1）。**对照：`git stash -u` 掉本批改动、主树回到 HEAD，直跑 6 跑 3 红**（B1 ×1；B3＋B4「实得 mode=undefined 文案「undefined」」×2 —— 42 号文 §5-decies 登记过的同一个形状）；`stash pop` 后 19 个文件 sha256 逐字节相同。`run-all` 列名串行 1 跑过。另：`git archive c94dc7a` 解到 scratchpad（不含 `mcp/`）直跑 3/3 过 | **既有，与本批无关**：HEAD 在这台机器的主树上约一半红；它读的文件本批一个没碰。「不含 `mcp/` 的树 3/3 过」只是线索（真 ACC 在不在会改变启动期时序），没证 |
| `steward-settings.e2e.js`（flaky） | 首跑没抓到 FAIL 行（超时或被杀），重跑过 | 直跑 3/3（`A5 browser target available` 过），`run-all` 列名 1 跑过 | 既有超时族（45 号文 §9.3 第 4 条），与本批改动零交集 |

**真回归 0**。回归前后各调过一次 `stopRuyiTestBrowsers()`；复跑的浏览器件跑完也收过。`scheduler-ui.browser` 这一回拿到了「HEAD 在空闲主树上 6 跑 3 红」的读数 —— 45 号文 §9.5 主会话复核那次「39/0 ×2」不能再当它好了的证据，应单开病历。

**发现但没修（登记，交主会话定）**：

1. **冷能力缓存下子代理初始化钉住事件循环**：双负载 5–12 s（§9.5 ① 同一笔债在子代理入口的读数）。解钉后节点看门狗与初始化心跳谁先跑是时序决定的；生产下限 60 s 今天兜得住，但「解钉后看门狗先判」这个次序本身没人保证。
2. **能力行在桌面 MCP 没连完时如实说「0 个」**：模型读到的是确定的「0」而不是「未知」—— 与 45 号文 §9.2 ⑧「未知被并进确定值」同族，这次出现在提示词易变层。
3. **agent-deadlock-watchdog 的第二条标签写「rejected by cycle detection」，判据只看「有一条工具失败」**：按源码推断，环检测坏了时 1500 ms 超时兜底同样会产出「工具返回 错误」让它绿（本批没为此跑反向，如实记）。
4. **扫描器的已知盲区**：见 ② 末条。
5. **`run-all` 重跑仍红时，首跑只留末 8 行**（`runWithRetry` 的 `tailLines(first.out, 8)`）：本轮 scheduler-ui 首跑红在哪一条因此丢了。flaky 件已经留全部 FAIL 行（125 波），「重跑仍失败」这一支没跟上。
6. **`scheduler-ui.browser` 在 HEAD 上空闲约一半红**（见上表），两个形状（B1 角标、B3/B4 `mode=undefined`）。

### ② P0 · 覆盖包补 playbook（2026-09-17）

**开工前重核的坐标**（HEAD `c94dc7a`，全对）：`tools/build-overlay.js` 的 `PAYLOAD_FILES` 里 `resources/playbooks` **0 条**；`06-provider-engine.js:868` `builtinPlaybooksDir()` → `readPlaybooksFromDir` 整目录 readdir `*.json`；`overlay-payload-lock.static` ③ 的 `sensitiveDirs` 只有 `app/public/js|locales|vendor`、`app/src` 四项。

**普查**：服务端 `path.join(externalRoot(), 'resources', …)` 读口 5 处 —— `kimi-acp-compat-register.mjs`（`05b:2177`，已登记）、`playbooks`（`06:868`，**漏**）、`plugins/win-workbench-offline/offline-toolkit`（`12:1637`，其下 `skills/<id>/SKILL.md`（`:1641`）与 `commands/*.md`（`:1671`）建技能库，**漏**）、`scripts/install-workbench.ps1`（`13:2320`，已登记）、`resources` 根（`13:2435`，doctor 的 `resourcesRoot` 只打印路径，不读）。同插件下 `agents/*.md` 与 `.claude-plugin/*.json` 服务端不读（只有 `install-workbench.ps1` 把整个 marketplace 交给 Claude CLI），`scripts/launch-workbench.ps1` 全仓零引用、`resources/offline-manifest.json` 是打包说明 —— 这三样不加。

**改了什么**：

- `build-overlay.js:165-222`：`PAYLOAD_FILES` +49 条 —— 16 个 playbook、20 个内置技能 `SKILL.md`、13 个内置命令；**154 → 203**。逐条列、不按目录收：锁 ③ 扫这些目录，新文件忘登记当场红；按目录收会让 ③ 对这几个目录恒真，目录里混进一个临时文件也会被静默发出去。
- `overlay-payload-lock.static.e2e.js:67-110`：
  - ③ 扫描面改成 **`app/public` 整棵**（替掉原来的 js／locales／vendor 三项，css 与将来新增的子目录一并进判据）＋ `app/src` ＋ `resources` 下运行时读的三个目录；先断言每个目录都扫到了文件（实得 app/public 87、app/src 57、playbooks 16、skills 20、commands 13），防目录改名后对空目录恒绿。
  - **③b**（那张目录表本身也是手攒的，所以对账）：从 `srcModules` 抠出所有 `path.join(externalRoot(), 'resources', …)` 读口（实得 4 处，`resources` 根按上条剔除），每一处要么是已登记的单文件、要么落在 ③ 在扫的目录上／下。服务端下次新开一个 resources 读口而没人来补，本条红并点名。

**与派单稿不同之处**：

1. **多补了技能与命令**：派单稿只点名 playbook；普查发现 `loadSkillRegistry` 同一个漏法（这两个目录最近一次改动是 `0aa48ee`，2026-07-16 —— 下次改就会漏发）。
2. **③ 扫 `app/public` 整棵，不是只加 `app/public/css`**：css 24 个文件里 23 个是 `index.html` 直接 `<link>` 的、① 本来就看得见；**`css/views/chat.css` 是兼容路由（`read-frontend-css.js:57`）、`index.html` 不引用**，修前 ①③ 都看不见它 —— 见反向 (b′)。整棵扫把这类一并收进来。
3. **加了 ③b**。

**判据读数与反向**（静态件，逐次按备份还原，`build-overlay.js` `e6488162…`、锁 `661b7026…` sha256 全 OK）：

- 修后 ALL PASS（13 PASS）。
- (a) 删掉 `'resources/playbooks/scheduled-digest.json'` → `FAIL ③ …(漏登记: resources/playbooks/scheduled-digest.json)`。
- (b) 删掉 `'app/public/css/views/quiet-card.css'` → ① 与 ③ 双红点名它。
- (b′) 删掉 `'app/public/css/views/chat.css'` → 新锁 ③ 红点名它；**同一份 build-overlay 拿 HEAD 版的锁跑是 ALL PASS**（修前的盲区实证）。
- (c) 从锁的 `RESOURCE_DIRS` 里删掉 `resources/playbooks` → ③ 仍绿（文件都登记了），**③b 红**：`没覆盖: resources/playbooks`。
- (d) `build-overlay.js` 换回 HEAD → ③ 红，漏登记 49 条（playbook 16、技能 20、命令 13，别的 0）。

**真打包**：`build-overlay.js` **没有输出目录参数**（`outRoot` 写死 `dist/overlay`，开跑先 `rmSync` 整个目录；`argv[2]` 不校验，谁传 `--check` 就把它当版本号）。仓里已有一份 `dist/overlay`（2026-08-11，93 个文件，manifest 版本号就是 `"--check"`）—— 先整目录挪到 `dist/overlay.bak-f5p0-20260918`，再 `node tools/build-overlay.js 0.0.0-f5p0`：`build --check` 新鲜，`Payload files: 203 (+0 optional)`，`Wrote update-manifest.json: 203 files`。核对（scratchpad 脚本）：manifest 203 条全量 sha256 对账 **mismatch 0／missing 0**，payload 盘上 203 个文件全在 manifest 里；**playbooks 16/16、skills 20/20、commands 13/13、css 24/24 在 manifest 里且与源文件逐字节相同**；`scheduled-digest.json` `93771dbb…` 1269 字节；`minHostVersion` 2.7.0。之后删掉这次打出来的 `dist/overlay`、把原目录挪回 —— 93 个文件的 sha256 清单与挪走前逐字节相同，`dist/` 条目数 91 不变；manifest 副本只留在 scratchpad。**没跑 `Manage-Overlay.ps1 apply/rollback`**（那是 ⑧ P1 的活）。

**发现但没修**：

1. `build-overlay.js` 没有输出目录参数、`argv[2]` 不校验（`dist/overlay` 里那份「版本 `--check`」就是这么来的）；`release-dryrun.js` 也写同一个 `dist/overlay`。⑧ 打包演练前值得补一个 `--out` 并拒收 `-` 开头的版本号。
2. `offline-toolkit/agents/*.md` 与 `.claude-plugin/*.json` 不在覆盖包里（服务端不读，见普查）；它们一改，覆盖升级用户重跑 `install-workbench.ps1` 装到的还是旧插件。

**主会话独立复核（⓪＋② 提交前）**：ListAgents 确认实现 agent 已 completed；`git stash list` 为空（施工期 A/B 用过 stash，已 pop 并按哈希核过）、`app/src` 零改动、`dist/overlay` 93 个文件已原样放回。独立复跑 16 件：fixture-home.static 28/0（含新墙钟窗口锁）、overlay-payload-lock.static 13/0、facts.static 24/0、route-inventory.static 12/0、agent-deadlock-watchdog 27/0、budget-guard 57/0、perm-v2 24/0、thread-arbiter 103/0、agent-loop 25/0、boot-resume-parallel 15/0、bridge-cancel-timeout 20/0、long-tool-liveness-steer 15/0、session-permission-mode 90/0、steward-guardrails 193/0、summary-parallel-cap 17/0、workspace-resolve 37/0；20 个改动文件控制字节 0。**主会话自做反向（第一发做错了，如实记）**：第一发按「第一处出现 `scheduled-digest.json` 的行」删——删到的是 `build-overlay.js:167` 的注释，锁照样绿；这是 [反向验证本身会做错] 的又一个样本（锚点匹配到了错位置）。第二发精确匹配清单条目那一行（`:182`）删 → overlay-payload-lock.static 退出码 1，点名「漏登记: resources/playbooks/scheduled-digest.json」；备份还原 sha256 OK、复跑 ALL PASS。

**回归里唯一的红 `scheduler-ui.browser`**：施工 agent 在 HEAD 上直跑 6 次红 3 次（B1 一次、B3/B4 `mode=undefined` 两次），与本刀无关；它的对照「去掉 `mcp/` 的 HEAD 副本 3/3 绿」与 ⓪ 里 budget-guard E30 的机制同形（每个栈自动桥接真机桌面 MCP、负载下连不齐）。**这是 107 退出门「全量真回归 0」剩下的唯一阻碍，下一刀先按机制取证**，不按次数处置。
