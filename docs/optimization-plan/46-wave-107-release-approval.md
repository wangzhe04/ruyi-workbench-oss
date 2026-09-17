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
| 引擎 | 105h、#13a／13a-t、#1 G1、111 五项 | 关 | 105h 无净收益、#1 G1 未过门、#13a 只有合成读数；**111 五项的真模型读数已到手，见 §5 E1**（111d／111e／111b 过门并建议默认开、111a 主指标反向、111c 量不出来；E1 只报不翻） | 实验（111 三项待拍板是否翻默认） |
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

### F6 · scheduler-ui.browser 病历（2026-09-18）

⓪ F5 收尾时留下的唯一阻碍（本文 §5 ⓪ 末条：「107 退出门『全量真回归 0』剩下的唯一阻碍，下一刀先按机制取证」）。本刀**按机制取证、不按次数处置**；结论是**两个真产品竞态**，所以改的是产品（`app/public/js` 两片叶子），**夹具判据一个字没动** —— 它等的那两件事，产品该做到而没做到。`src/`／`app/src/` 零改动。

**症状（HEAD `e533f76`，主树空闲直跑 5 跑 3 红）**：两个形状，正是 42 号文 §5-decies 与 45 号文 §9.3 登记过的那两个 ——

- `FAIL B1 schedule.changed 帧到达之后口袋角标变 1`（2 跑）；
- `FAIL B3 展开「最近几次」出恰好一行` ＋ `FAIL B4 那一行的触发模式是「准时」（实得 mode=undefined 文案「undefined」）`（1 跑）。

绿的一跑 12 s、B1 红 34 s、B3 红 48–50 s —— 差的正好是那两条 `waitForEval` 的预算：**红的不是「慢」，是它等的那件事永远不会发生**。

**负载怎么造的**：三路常驻循环**直跑** 18 件非浏览器服务件（A steward-guardrails／steward-tools／steward-runner／scheduler-steward／workbench-memory／subagent，B autonomy-grant／team-pool-mailbox／failover／mission-threads／event-stream／session-search，C context-compact-v2／tools-v3／checkpoint／mcp-config／usage-ledger／steward-decisions；共跑 95 趟、全部退出码 0），CPU 37–90%。**不用 `run-all` 造负载**：它 `main()` 开头无条件 `stopRuyiTestBrowsers()`，每起一轮就把候选件的 Edge 一起杀了（F5 那批全是非浏览器件才没踩到）。负载下 HEAD 8 跑 2 红（两发都是 B1）—— **空闲比负载下更红**，因为这两个窗口是毫秒级的**次序**窗口，负载只是把次序整体挪开。

**探针**（scratchpad 临时副本，跑完已删）：A＋B 段原样，外加三样仪器 ——

- 页内录音机：包 `fetch` 记每一发的起止／状态；把 `/api/events/stream` 的响应 `clone()` 出来逐帧打时间戳；每 50 ms 采一次 DOM（口袋文本／表行徽标／runs 行数／「接下来」行数），只记变化；
- node 侧：`/health` 每 100 ms、`/api/status` 每 1 s 记延迟；一条常驻 PowerShell 循环每 300 ms 列服务进程的子进程（桌面 MCP 的 python 在不在）；
- **受控阶梯**：`--delay-memory=N`／`--delay-tasks=N` 只推迟【消费者看到答复】那一刻（不碰服务端、不碰请求），把「两条答复谁先回来」从抖动变成受控变量。

**形状 ①（B1，两跑一字不差）**：一次到点派四帧 —— `registered` 383 ms／`dispatched` 395／`inbox.appended` 410／`reconciled` 653。口袋在第一帧开的那一发：`GET /api/scheduler/tasks` 382→408（读到的是 reconcile 之前的事实，两条都还有下次触发）→ `GET /api/steward/memory` 408→654。**`reconciled` 那一帧落在这一发里**（帧 653、那条读 654，差 1 ms），被 `refresh()` 的串行合并并进在飞那一发 → 丢掉。此后再没有帧：**口袋在整段 19 s 等待里恒是「2」**，而同一时刻设置块徽标已经是 `succeeded/ontime`、焦点栏「接下来」已经 2→1、服务端只剩 1 条有下次触发。另一跑同形（帧 296、memory 的 fetch 295 回来 —— `res.json()` 还没读完，仍在飞）。

**形状 ②（B3/B4，两跑同形）**：B2 按下刷新键（一发 `GET /api/scheduler/tasks` 在飞）→ 紧接着点「最近几次」（`GET …/runs`）。一跑：tasks 313→334、runs 316→331 —— **runs 的答复早 3 ms 回来**，那一行画上，随即被 tasks 那一发的整表重画扔掉；另一跑同形、窗口 200 ms（tasks 443→645、runs 445→641）。绿的那跑次序正好相反（tasks 18988、runs 18990），`liveRunsHost` 那一半兜住了。**B4 打出来的 `mode=undefined 文案「undefined」` 是夹具自己的空对象兜底**（`runs[0] || {}`）—— 42 号文 §5-decies 留的第二个可能「这条路本来就会渲染 undefined」**不成立**：界面从来没渲染过 `undefined`，它是**压根没有那一行**。

**机制分类：两条都是真产品竞态**（不是「测试读早了」、不是墙钟、不是连不上）——

1. `rail-pocket.js` 的 `refresh()` 串行合并**丢更新**：在飞那一发的两条读都发生在帧之前，把帧的答复交给它等于交旧事实；本模块零计时器、除推送没有第二条通道 ⇒ 丢掉就**永远不纠正**。
2. `steward-settings.js` 的整表重画**扔掉在飞期间的展开**：40 号文 P0③ 只把「展开着哪一条」记在 `loadSchedule` **起跑时**，护住的是「按下这一帧之前就展开着的」；在飞那几百毫秒里展开的照样被扔，而 `liveRunsHost` 只兜住相反的次序。

**桌面 MCP 那条假设：证伪**（A/B 交替、同树同机、探针各 6 跑）：A 臂（配置照原样）**3 红**（B1×2、B3×1）；B 臂（`desktopMcp` 钉死关）**4 红（全是 B1）**。B 臂确实关住了：服务进程零 python 子进程、`/api/capabilities` 的 `desktopMcp.present=false`；A 臂每跑在 2.2–2.9 s 起一个 python ACC、`toolCount=104`。两臂 `/api/status` 延迟 200–460 ms（A 臂那发 3.58 s 的离群值出现在一跑**绿的**里）、`/health` 峰值 249–591 ms，**分不出来**。⓪ F5 末条那句「不含 `mcp/` 的 HEAD 副本 3/3 绿」是小样本巧合，budget-guard E30 的机制在这一件上不适用。

**治法（产品侧两处，判据各只一处）**：

- `ruyi-workbench/app/public/js/rail-pocket.js:265-283`：加 `missedWhileInflight` —— 在飞期间来过帧就记一笔，等这一发落地之后补刷一次；帧连着来也只补一次（收敛，不成风暴）。`let inflight = null;` 与 `if (inflight) return inflight;` 两行原样保留，**零计时器纪律一个字没动**。
- `ruyi-workbench/app/public/js/steward-settings.js:939-963`、`:1289`：`loadSchedule` 把「展开着哪一条」**读在重画这一刻**、重画完 `reopenRuns()` 展开回来；`refreshScheduleFromPush` 删掉（它就是第二处判据），推送、按刷新键、做完一个动作三条路都走 `loadSchedule` 这一处。**顺带改了一处行为，明说**：按刷新键时展开着的那一格现在**不收起来了** —— 40 号文 P0③ 当初把「按刷新键＝收起来重来」记成可接受，把判据收成一处的代价就是这个，方向上也是用户要的（刷新键是「把数据刷新」，不是「把我正看的收走」）。
- 锁跟着改（都钉行为、不钉文本）：`dev-harness/rail-pocket.static.e2e.js:58-63` 新增 **A2b**（在飞期间到达的帧要记一笔并在落地后补刷）；`dev-harness/steward-settings.static.e2e.js:495-510` **L4** 改口（订阅直接走 `loadSchedule`）、**L4e** 改成钉「`await` 之后才读 openId ＋ 重画完 `reopenRuns`」、新增 **L4e2** 钉「展开态只有 `loadSchedule` 与 `toggleRuns` 两处清空」（防再长出第二处判据）。

**反向（都做在最终文件上，按文件备份还原、核 sha256；没用 `git checkout --`）**：

- **R1（受控，口袋）**：探针 `--lostupdate --delay-memory=2000` —— 先建第三条（口袋先变「3」，证明那一发已经读完任务表、正卡在被按住的那条读上），250 ms 后建第四条（帧必然落在在飞期间）。HEAD `rail-pocket.js`：等满 10 s，**实得口袋「3」而服务端 4 条**；换回修后：**实得「4」**。
- **R2（受控，设置块）**：`--delay-tasks=150`（runs 的答复必然早回来）。HEAD `steward-settings.js`：终态 **`runRows=0`**（服务端 1 条 run）；修后：**`runRows=1、mode=ontime`**。
- **R3（真件，统计）**：只把 `steward-settings.js` 换回 HEAD（口袋保持修后），空闲 4 跑 **2 红、逐字是登记的那句** `FAIL B4 那一行的触发模式是「准时」（实得 mode=undefined 文案「undefined」）`，2 绿。
- sha256：修后 `a240ea0c…`（rail-pocket.js）／`8ec113e9…`（steward-settings.js）；HEAD 基线 `bc022ab3…`／`95cce1bc…`。三次换回与三次还原后都逐字节核过。

**稳定**：空闲 **8/8 ALL PASS**（12–14 s／跑）；上面那三路负载下 **6/6 ALL PASS**（13–16 s／跑）。同一负载下 HEAD 8 跑 2 红、同一台机器空闲 HEAD 5 跑 3 红。

**生成器链与门**：`src/`／`app/src/` **零改动**（改的是 `app/public/js` 两片叶子与两个静态件）→ 依赖图 `--write`／`build.js`／契约快照／`facts-generate`／`route-inventory` 都不跑。`build --check` 新鲜、依赖图 `--check` PASS（53 模块／420 边）、`--fast` **73/73**（7 skipped 为既有 live probe）。改动的 4 个文件 0x00–0x1f（除 LF／TAB）／CR／U+FFFD 扫描全 **0**。

**逐件直跑（派单点名的六件＋两把改过的锁，空闲、逐件收尸）**：scheduler-ui.static 38/0、scheduler-steward 100/0、scheduler-api 52/0、steward-settings 73/0、rail-pocket.browser 53/0（**含 H1「12 秒静置期内 `/api/scheduler/tasks` 零新请求」** —— 补刷那一笔不会变成第二条节拍）、dom-smoke 53/0、rail-pocket.static 22/0（含新 A2b）、steward-settings.static 103/0（含改口的 L4／L4e 与新 L4e2）。

**全量回归（主树、修后未提交，`--parallel 4`，02:30:06 → 02:56，约 26 min）**：退出码 **0**，**356 pass / 0 fail / 0 known-fail / 0 unexpected-pass / 2 flaky / 356 ran / 7 skipped**。开跑前 CPU 6%、三路负载循环已停、调过 `stopRuyiTestBrowsers()`；回归期间没改任何文件、没跑别的件。**`scheduler-ui.browser` 在独占桶里首跑即过（12119 ms）**；`rail-pocket.browser`（29941 ms）、`steward-settings`、`dom-smoke`、`scheduler-api`／`scheduler-steward`／`scheduler-ready-queue`／`scheduler-ui.static` 也全是首跑即过。

| 件 | 回归里 | 串行复跑与对照 | 归类 |
|---|---|---|---|
| `steward-conversation.e2e.js`（flaky） | 首跑「没抓到 FAIL 行（多半是超时或进程被杀）」、重跑过（那一趟 146 s） | 修后串行 **10 跑 1 红**：`FAIL G4 线程回退到递话前（这句话视为没发出去，剩余消息 2 条）`；**换回 HEAD 前端两文件 4 跑 0 红**（样本太小，不足以归因） | 既有时序族，两个形状都与本刀改的两片叶子零交集：① 回归里那一发属 45 号文 §9.3 第 4 条的超时族（本件从 121 波起就在 flaky 名单上）；② G4 那一发是「撤回 vs 在途回合收尾」的次序 —— 45 号文 §9.5 ② 登记的那条真产品竞态（`activeChildren.delete` → 推助手消息 → `saveSession`），rewind 落定之后在途那一发又把消息写回来 |
| `steward-quick-ask.e2e.js`（flaky） | 首跑「没抓到 FAIL 行」、重跑过 | 串行复跑 **64/0 ALL PASS** | 同一超时族，与本刀零交集 |

**真回归 0。**

**(c) harness 级默认值的评估（派单要求只评估、本刀不实施）**：

- 起服的运行时 e2e **228 件**：**23 件**已把 `desktopMcp` 钉死关；**2 件**显式开着但接的是**假** ACC（`capabilities` → `fake-mcp.js`、`kimi-agent-cli` → `fake-acc-server.js`）；**203 件**留着 autodetect，其中 **19 件**是 `.browser`。这 203 件每起一个栈都会从仓里的 `mcp/ai-computer-control` 桥接真 ACC（本机实测：python 子进程在 spawn 后 2.2–2.9 s 出现、104 个工具）。
- **一件都不需要真 ACC**：读 `desktopMcp.present/detected/toolCount` 的 6 个文件里，`playbooks` ② 判的是「ocr-scan 可用性与 caps 一致」（关了照样一致）、`boot-listen-budget` 只钉字段形状（`detected,enabled,resolved`）、`vision-loop`／`capabilities`／`kimi-agent-cli` 用的是假 ACC、两个 static 件喂的是合成 caps。
- **代价**：F5 ③ 实测九栈的 budget-guard 约 76 s → 约 52 s；本刀**单栈** A/B 在 `/api/status`／`/health` 延迟上看不出差别，代价主要是**每栈一个 python 进程**（4 路并行回归 ⇒ 同时多到 4 个）。
- **落地方式没有便宜的**：`AI_COMPUTER_CONTROL_HOME` 覆盖**关不掉**（`01-config.js` `desktopMcpRootPlan` 的 (a) 之后仍扫 (b) 的仓内候选），`run-all` 的临时家也不下发 config.json（每件自己写自己的）—— 要么加一个共享的夹具配置口再 codemod 203 件（外加一把「没钉的件数」计数锁，否则下一个新件照样漏），要么加产品侧开关。
- **建议：不翻全局默认，也不要顺手一刀翻**。今天的证据说真 ACC 不是这一件的因；值得钉的只有两类件 —— ① **逐字节比能力文本**的（budget-guard 那一族，F5 已钉）、② **一趟起 ≥3 个栈**的。要翻全局就单开一刀，并在翻前后各跑一轮全量记墙钟与 python 进程峰值。

**登记（发现但没治）**：

1. `steward-drawer.js:1694-1700` 的 `refreshUpNext` 是**同一个模具**（`if (upNextInflight) return upNextInflight;`）：它只有一条读、窗口窄，本刀 12 跑采样里焦点栏「接下来」每次都收敛到 1 —— **没复现，不改**（它哪天红了，这份病历直接能用）。
2. `run-all` 的 `runWithRetry` 在「重跑仍红」时只留首跑末 8 行（F5 登记的第 5 条）：本刀能把两个形状分清全靠**直跑**，不靠回归日志。
3. 探针那条常驻 PowerShell 在仓根留下过一个 `Microsoft/Windows/PowerShell/ModuleAnalysisCache`（隔离家目录下 `%LOCALAPPDATA%` 解析失败时它退回 cwd）—— 已删，记着：**在仓根 spawn PowerShell 会往树里掉东西**。

**主会话独立复核（提交前）**：ListAgents 确认实现 agent 已 completed；工作区零未跟踪文件（仓根无 `Microsoft/` 残留）、`app/src` 零改动、改动只在两个前端文件与两把静态锁。审过两处修法：角标那处保留「在飞就合并」的原语义、只多记一笔并在落地后补刷一次（帧连着来也只补一次，零新增计时器）；设置页那处把「展开着哪一条」改成在**重画这一刻**读、并把判据收成 `loadSchedule` 一处（推送、按刷新键、做完动作三条路同口径），`refreshScheduleFromPush` 整个删掉。独立复跑：`build --check` 新鲜；**`scheduler-ui.browser` 空闲连跑 5 次 39/0 ×5**（施工前主会话在同一台机器上也见过 3 连红，见 45 号文 §9.5 那条被推翻的「环境问题」定性）；rail-pocket.browser 53/0、rail-pocket.static 22/0、steward-settings 73/0、steward-settings.static 103/0、scheduler-ui.static 38/0、scheduler-steward 100/0、scheduler-api 52/0、steward-board 111/0、dom-smoke 53/0；5 个改动文件控制字节 0。

**一条行为变化如实登记**：按下「刷新」时，正展开着的「最近几次」不再收起来（40 号文 P0③ 当初接受的是「按刷新键会收起」）。理由：那条口径要区分「推送来的帧」与「用户按的键」，而两处判据分家正是 B3/B4 的缝；收成一处之后，两者都保留展开。

### E1 · 111 五开关真模型读数（2026-09-18）

> **授权**：2026-09-17 拍板 3「实测就行，也可以多测几次」→ 跑真模型、**只报不翻**；本刀一个默认值都没动，`app/src/`／`app/public/` **零改动**（只新增 `dev-harness/` 三个 live 件与一份读数）。
> **机读读数**：[`107-e1-readings.json`](107-e1-readings.json)（逐开关 × 逐臂 × 逐次，外加环境、运行清单、由数据算出的汇总）。
> **脚本**：`dev-harness/111-compaction-live.js`（五开关配对 A/B）、`dev-harness/steward-delegation-latency-live.js`（代批延迟）、`dev-harness/asr-endpoint-probe-live.js`（ASR 端点确认）。三个都叫 `*-live.js` 而不是 `*.e2e.js` —— `run-all.js:248` 只收 `.e2e.js`，真花钱的件一律不进全量。
> **配对次数**：每个开关 **6 对**（门要 ≥3），repeat 之间交替先后顺序；111c 因为夹具被自己的摘要污染，另外重跑了两轮（共 18 对）。

#### E1.0 隔离与四次指纹（派单要三次，代批那一件起了真服务，所以多取了一次）

配方照 [45 号文 §9.6](45-wave-127-service-catalog-and-voice.md) 那一套：数据家 `%TEMP%\ruyi-e1-20260918\home`、用户家 `…\user`（`USERPROFILE`／`HOME`／`HOMEDRIVE`／`HOMEPATH`／`LOCALAPPDATA`／`APPDATA`／`KIMI_CODE_HOME` 全指过去），启动即自检「数据家与用户家都不许等于真机家」，脚本经 `node --require dev-harness/lib/fixture-home-guard.js` 起。副本配置 `autoImportClaudeCodeMcp:false`、`externalMcpServers:[]`、`claudePath:''`、`killPortOnStart:false`、`allowDesktopTools:false`、`stewardEnabledV1:false`、`stewardAutoActions` 全关、工作区指向 sim 目录。**五开关那一件不起 HTTP 服务、不开任何端口**（进程内 `require(server.js)`，§9.6.2 (d) 实测它不起计时器）；代批那一件必须起服务，端口走 `getFreePort()` 并显式拒绝 8765。**用户自己的 8765 实例一次没碰。**

| 文件 | ① 开工前 03:31:21 | ② 首次 require ＋首个真模型调用之后 03:31:46 | ③ 五开关收尾 04:59:18 | ④ 代批与 ASR 两轮之后 05:24:19 |
|---|---|---|---|---|
| `~\.win-claude-workbench\config.json` | `c76e8a1cedc0` | 同 | 同 | 同 |
| `~\.win-claude-workbench\scheduler\tasks-v1.json` | `59ac3175f036` | 同 | 同 | 同 |
| `~\.kimi-code\mcp.json` | `5de1f802c112` | 同 | 同 | 同 |
| `~\.claude.json` | `122f5872bb95`（mtime 21:45:41.073） | 同 | **`d91569c13d0f`，mtime 03:45:40.791，61349→61583 B** | 同 ③（mtime 不变，之后再没被写过） |

④ 那一列是**多取的一次**：代批那一件会**真起两个服务实例**，而启动期正是 `syncMcpServersToClaude`／`syncMcpServersToKimi` 往用户全局 CLI 配置写东西的那条路（[32 号文 §4 纪律 15](32-handoff-next-cuts.md) 的病根，`dev-harness/lib/self-isolate-home.js` 头注记着实际泄漏过 14＋9 条）。两个实例跑完，`~\.claude.json` 与 `~\.kimi-code\mcp.json` 的哈希与 mtime **一个字节都没动** —— 副本里 `claudePath:''`＋`externalMcpServers:[]`＋用户家改道这三件确实把两个方向都断住了。

（三次读数之外另有一次手工预读，03:15:50 —— 四个文件的哈希与 ① 逐字节相同，也与 §9.6.1 收尾那一列相同。）

`.claude.json` 那一次变化**归因于 Claude Code 宿主进程，不是本刀**（归因＋一条证伪）：上一次写入 21:45:41.073、这一次 03:45:40.791 —— **差 6 小时不到 0.3 秒**，与 §9.6.1 记下的「整 6 小时 ＋ 11 ms」自写节拍同形（那一轮也是 :45:41 这个秒位）；证伪那一条是**全文搜不到本刀四个 sim 目录名**（`ruyi-e1` / `ruyi-e1-20260918` / `ruyi-e1-smoke` / `ruyi-e1-probe` 全 false），`mcpServers` 仍是既有 17 条（含 §9.6 发现 9 点名的 9 条 `fake-mcp` 夹具）。本刀这一侧：`claudePath:''`、`autoImportClaudeCodeMcp:false`、`os.homedir()` 是 sim 目录、五开关那一件根本没起服务。

**密钥**：副本 config 里那一把 key 落盘即用即删，收尾删掉 `config.json` 与 `config.json.prev`，再**整目录复扫**（按 key 全串比对，命中即删）→ `rescanHits: 0`。读数文件里只有 host／模型／状态码，`keyTail` 只留末四位。

#### E1.1 口径与保真度边界（先说清楚量的是什么，再看数）

- **进程内跑真源码**：`require(ruyi-workbench/app/server.js)` 后直调导出的压缩原语（`evaporateHistory`／`CompactionPlan`／`providerSummaryCall`／`calibratedEstimate`／`recentFileReads`…），**开关在调用点按产品自己的判定函数把门**（`evaporateBudgetBoundaryEnabled()` 等），与生产同一处。
- **两级驱动循环是照抄的**：`maybeAutoCompact` 没导出，脚本按 `10-context-governance.js:2218-2309` 的顺序逐行转写（预算／窗口／`rearmMargin`／`armedBudget`／before → L1 → after1 → L2 → reseed）。**没抄的三处都记在读数里**：`repairProviderHistoryPairing` 未导出 → 自做孤儿检查（按设计它一条都不该修，实测两臂 `orphansMax` 全 0）；`writeHistorySnapshot` 未导出 → `rawRefPrefix` 用合成串（缩减算法一字不差，只是 `observation_recall` 回读不到盘上快照，不影响任何一条本刀要量的算术）；`recordCompactUsage`／`maybeWriteSessionNotes` 是 session 副作用，本刀无 session → **花费逐次从 `sc.usage` 自行累加**，不从 `usage/` 台账读。
- **窗口等比缩小以控成本**：`provider.contextWindow = 30000`（`resolveContextWindow` 的 manual 档）→ 预算 24000、尾预算 12000、L1 保护区 6000、摘要单发输入预算 20392（reserve 9608）。机制一字不变，一次 L2 约 ¥0.02 而不是 ¥1；夹具按这把尺子搭「贴着窗口的长密历史」。
- **模型真参与三处**：① L2 摘要本身（`providerSummaryCall`，真调用、结构校验由它自己判）；② 压缩后拿真模型答一个**可确定性核对**的问题（事实标记串出现没出现，不用模型判模型）；③ 111c 的「首个动作」探针（挂工具看它先干什么）。③ 的**工具 schema 与系统提示是本刀写的**（产品 `MCP_TOOLS`／`buildOpenAiTools` 未导出），两臂同一份 —— 配对成立，**绝对比率不等于产品实测**。
- **先分类再算比例**：每次运行按 `ok`／`timeout`／`empty`／`refusal`／`truncated`／`harness_bug` 归类，非 ok 一律不进分母。本轮非 ok 共 4 次（2 个 `empty`、1 个 `truncated`、1 轮 111c 整体作废重跑），逐条见下。
- 模型：`deepseek-v4-flash` @ `api.deepseek.com`（拍板 5 里没要求换强模型；本刀没有任何指标需要更强的模型才量得出来，所以 **`deepseek-v4-pro` 一次都没用**）。

---

#### E1.2 `runtimeSummaryPromptI18nV1`（111d）· **建议默认开**

**案例怎么搭**：两份**内容一一对应**的长密对话（中／英各十条可确定性核对的事实标记），填充倍数 30 → zh ≈ 13.9K、en ≈ 17.3K token，都贴着摘要单发预算 20392 却**都还塞得进一次调用**（再大一档 38，英文那份就 `needsMapReduce` 并丢掉中段 38 条 —— 那时量的是截断不是摘要质量，配对当场失效，这一档是量出来才定的）。直接过 L2 摘要内核 `providerSummaryCall`：111d 唯一改的就是**写摘要那一头的 prompt**，再往上的两级驱动与它无关。三臂：`zh_off`（今天的中文用户）、`en_off`（今天的英文用户）、`en_on`（开关开）。**通过率由 `providerSummaryCall` 自己判** —— 结构校验不过它直接返回 `structured summary validation failed`，判据与生产同一处，不是本刀另写的。

| 臂 | n | 校验通过率 | 摘要语言与 locale 一致 | CJK 比 | 事实保留（/10） | 五节 | 墙钟均值 | 6 次费用 |
|---|---|---|---|---|---|---|---|---|
| `zh_off` | 6/6 | **1.000** | 6/6 | 0.78 | 9.50 | 5/5 | 4.4 s | ¥0.0150 |
| `en_off` | 6/6 | **1.000** | **0/6** | 0.43 | 9.33 | 5/5 | 19.6 s | ¥0.1668 |
| `en_on` | 6/6 | **1.000** | **6/6** | **0** | **10.00** | 5/5 | 10.6 s | ¥0.1316 |

**门（EN 通过率 ≥ ZH）达标 —— 但这条门不辨别**：三臂通过率都是 1.000。理由也清楚：`en_off` 的 prompt 是中文，模型就按中文写，而中文标题本来就在别名表里，当然过。**真正被 111d 改变的是摘要语言**：关臂 **6/6** 给英文 locale 的用户发中文摘要（CJK 比 0.38–0.50），开臂 6/6 英文（CJK 比 0）。这正是 [45 号文 §1.4](45-wave-127-service-catalog-and-voice.md) 记的那个现成缺陷，**6/6 复现、6/6 修好**。

**建议 delivered（默认开）**：修的是实打实的缺陷；每一项非劣信号都不差，而且事实保留 10/10 反而**更好**（关臂 9.33）、更快（10.6 s vs 19.6 s）、更便宜（¥0.132 vs ¥0.167）。翻默认的代价只有一条要写进 CHANGELOG：`locale=en-US` 的存量用户从此拿到英文摘要（`auto` 与 `zh-CN` 逐字节不变）。

#### E1.3 `runtimeHistoryReadDedupV1`（111e）· **建议默认开**

**案例怎么搭**：去重只作用在 **L1 边界之后**（[44 号文 §7 ②](44-wave-126-memory-scope-and-compaction-v2.md) 那条设计判断：冷区已经缩过，重复读取还占位置的地方是受保护的尾部）。所以搭了两个子案，都真的走进 `dedupeRepeatedReads`：

- **legacy-tail**（111a 关，今天的默认边界「倒数第 2 条 assistant」）：四次**同一文件同一内容**的读取放进**一条 assistant 的并行 `tool_calls`** —— OpenAI 形并行工具调用的真实形状，四条 tool 回复全落在尾部窗口内。
- **with-111a**（111a 一起开，尾部按 token 预算撑开）：四次读取分散在最近四个回合里，都落在保护区内 —— 「一条线程里同一个文件读了三四遍」的真实形状。

夹具规模 27.7K／28.1K token > 预算 24000，L1 **真的被调用**（`pad=9` 是量出来的：`pad=6` 只有 20.8K，两臂都 `fired:false`，那种读数没有意义、生产里也不出现）。

| 子案 | n | 关臂 L1 释放 | 开臂 L1 释放 | Δ | 去重指针 | L2 | 答出两个事实 |
|---|---|---|---|---|---|---|---|
| legacy-tail | 6+6 | 7076 | 12030 | **+70.0%** | 0 → 3 | 两臂都没触发（L1 够了） | 6/6 与 6/6 |
| with-111a | 6+6 | 8090 | 11393 | **+40.8%** | 0 → 2 | 同上 | 6/6 与 6/6 |

**门（释放 token +10%）达标，两个子案都远超。** 一条口径要讲明白:**L1 这一趟是确定性算术**（不调模型），所以 6 次 repeat 的释放 token **逐次相同**（离散 0）；6 次重复加的是模型问答那一半的方差，不是指标本身的方差。B 类非劣**过得很干净**：12/12 都答出 `RETRY_LIMIT=7` 与 `RC-8842` —— 指针文本把模型指到后文那一条（带 `tool_call_id`），信息真的没丢。

**建议 delivered（默认开）**：门过、方向一致、零误报键（44 号文 ② 的 B 组八条）、B 类非劣。

#### E1.4 `runtimeReseedTailUnitsV1`（111b）· **建议默认开**

**案例怎么搭**：一条**只有一个 user 回合**的长线程（这正是 111b 要打的形状：一个 user 回合里带几十个工具往来是常态，而它整条都装不进尾预算 12000 → 今天必然 `kept=[]`）。从贴窗口的密历史起步，之后每一轮追加「一个写族单元（`file_edit`，`protectedObservation` 按设计**不许蒸发**它 —— 不可压的那一半，逼出 L2）＋一个搜索单元（可压的那一半）」，每追加一轮就按生产顺序跑一次两级压缩 —— 这正是 `maybeAutoCompact` 在真回合里被调用的位置。30 轮是量出来的（18 轮一臂只摊到 1 次 L2，指标没有分母）。

| 读数 | 关臂 | 开臂 |
|---|---|---|
| 重播种次数（6 次 repeat 合计） | 11 | 21 |
| **其中尾部为空** | **11（100%）** | **0（0%）** |
| 每次 repeat 的空尾比例 | 1,1,1,1,1,1 | 0,0,0,0,0,0 |
| L2 次数均值 | 1.83 | 3.50 |
| 配对孤儿最大值 | 0 | **0** |
| 摘要费用（6 次 repeat） | ¥1.681 | ¥2.687 |
| 答出两个事实 | 5/5 有效样本全 2/2 | 6/6 全 2/2 |

**门（空尾比例 −80%）达标：实测 −100%**，6 对全部同向、零离散。配对铁律也真的成立：开关开时才调的 `repairProviderHistoryPairing` **按设计一条都没修到**（两臂 `orphansMax` 都是 0）。

**两条如实写明的限制**：① **「答对了」这一栏不算功劳** —— 尾部标记 `pkg<i>` 在**两臂的摘要里都出现过**（6/6），所以问答分不出答案是尾部给的还是摘要转述的；辨别力全在结构指标上（`markerInKeptTail` 关臂 0/6、开臂 6/6 才是那条真差别）。② **代价要写进 Brief**：保住尾部让重播种后的历史更大，L2 次数 1.83 → 3.50、摘要费用 **+60%**。

**建议 delivered（默认开）**，并在 Brief 写明费用代价。非 ok 1 次（关臂 #6 问答 `empty`），不进分母。

#### E1.5 `runtimeEvaporateBudgetBoundaryV1`（111a）· **needs more，先别翻默认**

**案例怎么搭**：与 111b 同一台增长循环，只是回合有正常的 user 边界（多 user 回合），30 轮，两臂追加的单元逐字节相同。指标 = 整条会话里 `mode==='summary'` 的次数。

| 读数 | 关臂 | 开臂 |
|---|---|---|
| **L2 次数**（逐次） | 4,4,4,4,5,4（均值 **4.17**） | 4,6,6,7,4,6（均值 **5.50**） |
| L1 次数均值 | 8.00 | 7.33 |
| L1 释放总量均值 | 32150 | 31818 |
| L2 调用失败（摘要不完整） | 1 | 2 |
| 摘要费用（6 次 repeat） | ¥1.653 | **¥2.253（+36%）** |
| 答出两个事实 | 6/6 全 2/2 | 5/5 全 2/2（另 1 次 `truncated`） |

**门（L2 次数 −20%）不达标，而且方向是反的：+32.0%**，6 次里 5 次开臂 ≥ 关臂。**机制是自洽的**：111a 把尾部按 token 预算护起来 → L1 少蒸发（44 号文 ① 的单测读数「老边界蒸发 59/60、新边界 50/60」说的就是同一件事的另一面）→ 更常兜到 L2。也就是说 25 号文 §1.3 给 111a 挑的这条指标，**与 111a 的机制方向相反** —— 这是派单稿的判断需要修，不是实现坏了。

**建议 needs more**：主指标反向、释放总量两臂相同（32150 vs 31818，在噪声内）、费用 +36%，质量非劣。要它默认开，得先换一条能说清「护住尾部观测」收益的指标（例如压缩后重读率、跨块正确率），现在这条 L2 次数门它过不去。**本刀不改派单稿也不翻默认，只把读数与这条结论交上去。**

#### E1.6 `runtimeReseedReattachFilesV1`（111c）· **needs more（量不出来，不是量出来没用）**

**案例怎么搭**：会话读过 `billing/queue.js` 与 `billing/invoice.js`（要用的常量落在头 40 行内 —— 重附块只带头 40 行，事实不在里面这条判据就是空的），历史涨到越预算、L2 重播种；重播种之后给真模型挂上四个工具（`file_read`／`file_edit`／`file_search`／`powershell_run`），派一件**必须知道那个常量当前值**的活，量 25 号文那条指标「压缩后首个工具调用为『重读已知文件』的比率」。

**结构面全绿（12/12）**：开臂 `reattachedInPrompt` 11/11、`recentFiles` 恒为 `["billing/invoice.js","billing/queue.js"]`（按 path 去重、最近优先）、头 40 行里带着事实 12/12、关臂**一次都没注入**、`orphans` 0、`kept` 31 条、没有两条连着的 user。

**行为面量不出来**：

| 轮 | 事实 | 关臂重读率 | 开臂重读率 | 有效 n |
|---|---|---|---|---|
| 首轮 | `RETRY_LIMIT = 7`（高显著度） | 5/6 | **5/5（100%）** | off 6 / on 5（1 次 `empty`） |
| 第二轮 | `SHARD_SALT = 'Q7X-LUMEN'`（低显著度）+ 探针上限 500 | **无有效分母** | — | off 0/6（4 次 `empty`、2 次污染）→ **整轮作废** |
| 第三轮 | 同上 + 探针上限 1500 | **5/6（83.3%）** | **5/6（83.3%）** | off 6 / on 6 |

**门（重读率 −50%）不达标：实测 0%。** 最直白的说法是：**文件节选原样贴在摘要旁边，deepseek-v4-flash 动手前照样先把文件重读一遍**（开臂两轮合计 10/11 重读）。

**但这个读数带一个已知污染，必须一起写**：**真模型写的 L2 摘要会把它读过的那个文件里的常量原文抄进【关键文件与上下文】** —— 于是关臂手上也有答案（`factAnywhere` 两轮都是 6/6 true）。换低显著度常量（分片盐值）**没能绕开**，因为夹具的任务本身就在说「核一遍常量」。两臂唯一的差别因此只剩「有没有那一段 `--- 路径 ---` 的文件节选」。所以本刀的结论是**「量不出来」而不是「量出来没用」**，两者都不该当成过门。

**建议 needs more**：结构面该注的都注了，但它承诺的行为收益没出现；要一个干净的读数，需要换一条**既是任务必需、又不会被摘要抄走**的事实（本轮两次尝试都没做到），并且很可能要换一个更信任上下文的模型再看一次。

---

#### E1.7 管家代批延迟（真管家模型，第二份样本）

[45 号文 §9.6.5 (d)](45-wave-127-service-catalog-and-voice.md) 的真模型代批延迟只有**一个样本** 37.0 s；`steward-exempt-delegation.e2e.js` 的 R 段有 15 个样本但那是**假管家**（12.5–17.6 s，量到的几乎全是 15 s 轮询节拍）。本刀补中间那一块：**线程侧用进程内 fake**（脚本化 `powershell_run Remove-Item .\tmpN -Recurse`，于是**待决出现的时刻是确定的**，重复之间可比 —— 线程也用真模型的话起点会随模型啰嗦程度漂移几十秒，那正是 §9.6 只拿到一个样本的原因），**管家侧是真模型**（`stewardProviderId`/`stewardModel` → `deepseek/deepseek-v4-flash`）。计时口径与 e2e 的 R 段逐字相同：待决行 `requestedAt` → 终态行 `decidedAt`（只认 `INTERVENTION_TERMINAL`）。

| 轮询档 | n | 均值 | 最小 | **最大** | 占 `permissionTimeoutMs=120 s` |
|---|---|---|---|---|---|
| 5000 ms（用户真机值，与 §9.6 那个 37.0 s 同档） | 3 | 17.7 s | 10.2 s | **30.6 s** | 25.5% |
| 15000 ms（出厂值，存量用户拿到的） | 2 | 31.5 s | 20.4 s | **42.7 s** | 35.6% |

5 次**全部代批成功**（`status:allowed`、`decidedBy:steward`），非 ok 0；`steward_exempt_delegated` 审计行 3+2 = 5，与代批次数**逐条对上**；量具自检 `stewardHitFakeProvider = 0`（管家一次都没打到那个假端点，用的确实是真 provider）。两个实例收尾 `work` 目录都是空的 —— **五个 tmp 真被删掉了**。§9.6 的 37.0 s 落在两档之间，三档读数**都远低于 120 s 超时**，余量 2.8–11.8 倍。花费（按预设定价，见 E1.8）≈ ¥0.18，3 条管家 aux 账本行、输入 157,496／输出 12,388 token。

**结论**：拍板 2「代批默认开」在延迟这一面**没有新的反对证据**。§9.6 已登记的那条债（管家被节流时非定时线程可能等过 120 s）本刀没去碰 —— 本轮 `stewardMaxTurnsPerHour` 按 e2e 惯例开到 500，**没有量节流下的延迟**。

#### E1.8 ASR 真端点再确认

`dev-harness/asr-endpoint-probe-live.js` 对四个候选各打一发，出站请求按 `transcribeAudioViaProvider`（`05-claude-engine.js:1640-1658`）**逐字段照搬**（同一个 URL 拼法、同一组 multipart 字段、同一个 Bearer 头），音频是脚本自己合成的 0.5 s／16 kHz／16 bit 单声道 WAV。**不建适配器、不换 base 重试、不走 chat 协议。**

| 模型 | host | HTTP | 耗时 |
|---|---|---|---|
| `mimo-v2.5-asr` | api.xiaomimimo.com | **404** | 141 ms |
| `qwen3-asr-flash-2026-02-10` | ws-jzt3p0a4t04g585c.cn-beijing.maas.aliyuncs.com | **404** | 100 ms |
| `fun-asr-flash-2026-06-15` | 同上 | **404** | 100 ms |
| `hy-asr-3.0-preview` | tokenhub.tencentmaas.com | **404** | 48 ms |

与 §9.6.3 的读数一致（那一轮是经产品路由打的，读到的是产品把上游 404 映射成的 502＋`asr.upstream`；本刀直连上游，读到的是上游自己的 404 —— 同一件事的两端）。**外加一条 §9.6 没记的事实**：真机 config 里 `asrProviderId` 与 `asrModel` **都是空的** —— 产品侧 `/api/audio/transcribe` 走 409 `asr.not_configured`、前端麦克风**根本不渲染**。也就是说这四个 404 在用户这台机器上今天**够不着**：§9.6 是在 sim 副本里把这两个键填上之后才打到的。Release Brief 写「语音开箱不可用」时这两层要分开说：**未配置（今天）** 与 **配置了也 404（协议不兼容）**。

#### E1.9 花费

| 运行 | 调用 | 金额 |
|---|---|---|
| 五开关主轮（111d/111e/111c-retry/111a/111b × 6 对） | 211 | ¥10.1899 |
| 111c 第二轮（作废） | 24 | ¥0.7879 |
| 111c 第三轮 | 24 | ¥0.7957 |
| 代批延迟（按预设定价折算，见下） | 3 条账本行 | ≈¥0.1823 |
| ASR 端点（上游 404，不计费、不进账本） | 4 | ¥0 |
| **合计** | **262** | **≈¥11.96 / 上限 ¥25** |

主轮的逐阶段账在读数文件 `spend.byPhase` 里（最贵的两项是 111b 与 111a 的摘要调用：¥2.687＋¥2.253）。全部用 `deepseek-v4-flash`，**`deepseek-v4-pro` 一次没用**（没有任何一条指标需要更强的模型才量得出来）。

#### E1.10 没量到的（照实登记）

1. **子代理那条压缩路**（`maybeCompactSubHistory`）：五个开关在 25 号文 §1.2 都写了「同步」，本刀只量了主回合那一条。
2. **forced-400 路径**：44 号文 ① 已写明 111a 有意不覆盖它，本刀也没量。
3. **管家被节流时的代批延迟**（§9.6 已登记的那条债）：本轮把 `stewardMaxTurnsPerHour` 开到 500，没造节流。
4. **111c 的干净读数**：见 E1.6，两次尝试都被真摘要污染。
5. **105 总门那套 overall 指标**（跨块正确率／实体保留率整套）：本刀量的是各开关自己的主指标＋可确定性核对的事实标记，没有重跑 23 号文 §4 的总门夹具。
6. **产品的真工具目录与真系统提示**（111c 探针用的是本刀写的四个 schema）。

#### E1.11 发现登记（都只记，不修 —— 本刀是量的，不是修的）

| # | 类别 | 发现 | 证据 |
|---|---|---|---|
| 1 | **派单稿要改** | 25 号文 §1.3 给 111a 挑的指标「L2 次数 −20%」**与 111a 的机制方向相反**：护住尾部 → L1 少蒸发 → 更常兜到 L2。实测 +32.0%（6 对） | E1.5 |
| 2 | **产品观察（削弱 111c 的前提）** | 真模型写的 L2 摘要会把它读过的文件里的常量**原文抄进**【关键文件与上下文】。好处是事实没丢，副作用是「重附文件节选」的边际收益被摘要自己吃掉了一部分，也让 111c 的行为指标难以配对量 | E1.6，两轮各 6/6 `factAnywhere` |
| 3 | **产品瑕疵（新）** | `recentFileReads` 在 L1 之后取到的往往是**已被 105a 缩减过的视图**：实测那条 `file_read` 的 `content` 被缩到 1828 字符、里面夹着 `[...N chars omitted...]`，于是重附块的「头 40 行」实际是「头一截 ＋ 省略标记 ＋ 文件尾部」，**并不连续**。块头写的是「节选…需要全文请重新读」，所以不算说谎，但「头 40 行」这个界的语义与注释里说的不是一回事 | 零成本复核脚本：`invoice 读取是否已被缩减: true`、重附 head 含 `chars omitted`、末行是 `function step112(...)` |
| 4 | **产品瑕疵（小）** | `summarySingleShotReserveTokens(config)` 返回**小数**（实测 `9608.277777777777`），它是拿来当 token 预算减的 | E1.1 环境读数 |
| 5 | 量具（本刀自己的，已修） | 四处：① `chat()` 的 `ms` 打在 `fetch` 之后 = TTFB 不是全程（首轮 111d/111e/111c 的 `answer.ms` 是那个口径，逐次 `wallMs` 一直是全程）；② 问答上限 700 被思维链吃光 → 111a #5 ON 正文 4 字、命中 0/2 被**误记成质量失分**（现归 `truncated`、上限抬到 1200）；③ 111c 探针上限 500 → 关臂 4/6 `empty`（上限抬到 1500）；④ 代批脚本把账本筛成 `*.ndjson`（真名 `2026-09.jsonl`）又没抄 provider 的 `pricing` → 花费报成 0（两处都修了，本文的 ¥0.18 是事后直读账本按预设定价折算的） | 三个脚本的头注与行内注释都留了病历 |
| 7 | 量具（本刀自己的，已修） | **第十个「补丁脚本静默损坏文件」样本**：ASR 那个脚本里正则字面量的两个转义序列落盘时变成了**两个真的控制字节**（NUL 与 0x1F）——运行时等价所以跑起来一切正常，是**交付前的控制字节扫描**抓到的，不是测试抓到的；而且**第一次修的时候，写进注释里描述那两个转义的字又被落成了同样的控制字节**（同一刀里同一个坑踩两次）。修法：正则改成 `new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']+', 'g')`，注释改成纯文字描述，**源码里一个控制字符都不留**；改完原样重跑一次，四个 404 逐条复现 | 三个脚本＋两份读数＋本文复扫：`NUL 0 / 其它控制字节 0 / U+FFFD 0` |
| 6 | 归因（非本刀） | `~\.claude.json` 在跑动期间变了一次（+234 B），**是 Claude Code 宿主的 6 小时自写节拍**；证伪：全文搜不到本刀四个 sim 目录名 | E1.0 |

**收尾**：五开关那一件不起服务、不开端口；代批那一件两个实例都 `taskkill /T /F` 收掉，收尾**三小时内启动的 `node` 进程 0 个**（在跑的 27 个全是宿主与用户自己的）。本刀**零浏览器件**：收尾时 7 个 `msedge` 都启动于 9/17 23:58–23:59、3 个 `explorer` 启动于 9/16–9/17 17:57，**全部早于本刀开工（9/18 03:15）**，一个都不是本刀起的。两个带 key 的副本配置已删，**所有 `ruyi-e1*` 目录整体复扫真 key 全串 → 0 命中**；指纹 ④ 证明代批那两个真服务实例跑完之后真机四个文件仍旧没动。证据目录保留在 `%TEMP%\ruyi-e1-20260918\`（`evidence\readings.json`／`delegation-latency.json`／`asr-endpoints.json`）与 `…-c2`／`…-c3`，**里面没有密钥**。

### D1 · 文档与迁移（2026-09-18）

> **性质**：纯文档刀。`ruyi-workbench/app/`、`dev-harness/`、`ruyi-workbench/tools/` **零改动**，`facts.json`／生成物／locale 一个字节没碰 —— 所以**不跑生成器链、不跑全量回归**（这一条按派单要求显式写出来）。改动 5 个文档 ＋ 本节。
> **一处派单要求没做，给理由**：§1.4 让「顺手改 `CONFIG_SCHEMA = 11` 注释里那个会被误读的『v2.8』措辞」—— 那是 `app/src/00-boot.js:36` 的代码注释，改它就破「零代码改动」这条硬约束，**留给 R1 那一刀**（它本来就要动版本三角，同一刀里顺手改最省一轮门）。本轮改为在文档里把这件事说清：ARCHITECTURE 头注与管理员手册 §7.4 都写明「`CONFIG_SCHEMA` 自 2.7.0 未变（11），2.8.0 **不 bump**」。

#### 改了什么（逐文件一句话）

| 文件 | 改动 |
|---|---|
| `CHANGELOG.md` | 「未发布」节里写进 **2.8.0 候选**的完整条目（中英各 17 条），覆盖 123–127 波用户可见变化 ＋ 107 波的 S0／S0b／F6；**发布日期留白**：节首一行「未发布 · 发布日期待填」＋一条 HTML 注释写明 R1／R2 各该填什么、标题该改成什么形状。2.7.0 条目**原文一字不改**，在它标题下加一条「更正（2026-09-18 补记）」双语提示，指向 2.8.0 节末那两条更正 |
| `ruyi-workbench/docs/manuals/USER-GUIDE_CN.md` | ① 新增 `## 9. 语音输入 / 定时任务 / 服务入口 / 管家替你批`，四小节一律「怎么做 → 你会看到什么 → 不成的时候怎么办」，含两张失败对照表；② 修掉 §5「管家」页签那句**已经过时的「默认关着」**（第 121 波起默认开）。**没有重排任何 `##` 编号** —— 理由见下「为什么新开 §9 而不是插在中间」 |
| `ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md` | ① §3.4「密钥掩码」按 S0／S0b 重写（新进掩码面的两类、`env`／`headers` 全遮的口径与代价、「同一启动目标才还原」那道闸、sanitize 兜底、**仍已知未掩的两处**）；② 新增 §3.9「2.8.0 的其余安全改动与已知缺口」（执行 cwd、脱敏表补齐 ＋ 六条债）；③ 新增 §7「2.8.0 默认启用清单、升级与回滚」：7.1 引擎已交付表、7.2 产品已交付表、7.3 实验表（含 E1 五个开关的逐条读数与结论）、7.4 升级、**7.5 回滚最小步骤** |
| `ruyi-workbench/docs/ARCHITECTURE_CN.md` | 头注版本基线 `2.5.0/configSchema 9` → **`configSchema 11` / 2.8.0 候选**，并列出四处结构性变化；「界面」注补「一台两视」；「模块化构建」17 → **53 模块**并按编号层序逐族说明（**13 族 20 个文件**单独点名）；原生工具 52 → **97** 并写明 63＋33＋1 的构成与单一事实源；新增「v2.6–v2.8 新增的路由族」概览表（七族 ＋ `GET /api/status` 是 `open` 档这件事）；工具清单补 `audio_transcribe`；数据目录补 `steward/*` 与 `scheduler/*` 两个新持久面 |
| `docs/OPTIMIZATION-ROADMAP.md` | 「当前状态」由 **09-02 / v2.6.2** 改到 **09-18**，四行：Escapade 发布线（2.8.0 候选冻结中、tag 仍在 v2.6.2）、2.7.0 之后已交付的五波、**第 107 波逐刀进度**（已出门七刀／在排五刀）、回归基线；顺带修掉发布线表里「CHANGELOG 最后归档条目为 v2.6.2」与两处「107 排在 108–110 之后」的过期说法 |

#### 每条可能被质疑的事实，出处在哪

**版本与门**
- 版本号 **2.8.0**、代批默认开（含升级用户）、111 只报不翻：本文 §3 的 2026-09-17 用户拍板逐条原话。
- `CONFIG_SCHEMA = 11` 且本波不 bump：`ruyi-workbench/app/src/00-boot.js:36` 实读 ＋ 本文 §1.4。
- `package.json` 仍是 `2.7.0`：`ruyi-workbench/package.json:3` 实读。
- **没有 `v2.7.0` 标签**：`git tag` 实跑，最新是 `v2.6.2`（与本文 §1.1 ② 一致）。
- 回归基线 356/0/2flaky、真回归 0：本文 §5 F6 的「全量回归」段。`--fast` 73/73：本轮亲自跑（见下「门读数」）。
- 路由判定点 137、`ROUTE_AUTH` 125：`docs/architecture/route-inventory.json` 实读（`decisionPoints` 137、`routeAuth` 125）。
- 53 模块 / 420 边：`ls app/src/*.js` 实数 53 ＋ 本文 §5 各刀的依赖图读数。
- 原生工具 **97 = 63 ＋ 33 steward_* ＋ 1 audio_transcribe**：`facts.json:nativeTools` 实读 ＋ `dev-harness/steward-tools.static.e2e.js:133` 那条锁的断言原文（**这一条我先写成「另有 26 个 steward 工具、不计入这一轴」，两处都错，按锁的原文改正**）。
- ACC 108 工具 / v1.9.1：`facts.json` ＋ `mcp/.../server.py:45` `VERSION = "1.9.1"`（meta-guard C 段就是对这两处的）。

**默认值（全部逐行实读 `app/src/01-config.js`）**
- `stewardEnabledV1: true`（`:326`）、`schedulerEnabledV1: true`（`:393`）、`stewardExemptDelegationV1: true`（`:338`）、`newThreadEngine: 'last'`（`:9`）、`asrProviderId`／`asrModel` 两空（`:84-85`）、`runtimeMemoryVectorRecallV1: true`（`:228`）、111 五个开关全 `false`（`:117`／`:121`／`:124`／`:128`／`:131`）、`stewardPollMs: 15000` 钳 [5000,120000]（`:352`＋`:1127-1131`）、`stewardMaxTurnsPerHour: 30`（`:362`）。
- 引擎那一批默认开的读数（−81.0%、88.9%/¥0.1352 对 77.8%/¥0.1945、+56.2pp 与总门混合 66.7 对 77.8、+23.9pp、311→112 ms、+17–24pp、Recall@3 90→95）：本文 §1.3 那张表 ＋ `01-config.js` 各开关的行内注释（两处互相对得上）。
- 调度器两个窗口：`askWaitMinutesDefault: 30`、`graceMinutesDefault: 720`（**12 小时**）—— `app/src/06j-scheduler-core.js:94`／`:83` 实读。用户手册那句「出厂 12 小时」就是这一条。
- 代批每小时 6 次、八道闸、底线项清单、「读过网页不代批对外发送/推送」：45 号文 §2-quater.2 B2 ＋ 运行时文案 `locales/zh-CN.json:2472-2473`（设置页那一项的原文，手册里「开关在哪儿」逐字引它）。

**语音那一条（最需要说准的）**
- 只走 OpenAI 形 `/audio/transcriptions`：45 号文 §8 ② 的出站描述 ＋ 本文 §1.5 ①。
- **四个端点全 404**：本文 §5 E1.8 的表（`asr-endpoint-probe-live.js` 直连上游实测）＋ 45 号文 §9.6.3（经产品路由那一端的同一件事）。CHANGELOG 与两本手册都写成「**开发者自己那台机器上实测的四个候选模型全部 404**」，**不对任何服务商作可用性承诺**。
- 25 MB 闸、120 s 超时、`kind:'aux', note:'asr'` 记账与 `estimated` 标记：45 号文 §8 ②。
- 3 分钟上限、插在光标处、永不自动发送、失败七种文案：45 号文 §8 ⑦ 的判据读数 ＋ `locales/zh-CN.json:2797-2813` 逐条对照（手册里的失败表就是这张键表的人话版）。
- 桌面壳麦克风**没验过**：45 号文 §8 ⑦「已知限制」1（`RuyiDesktop.cs:210-211` 只声明槽位、没注册处理器）。手册写的是「**还没有验证过**……如果点下去走的是『没有拿到麦克风权限』那一条，改用浏览器」，**没有断言桌面壳一定不行**。

**服务目录**
- 六类白名单与 13＋1 个模板的归类、`service` 允许为空：45 号文 §8 ③。
- 「最多一条配置引导」＝ `SERVICE_GUIDANCE_MAX = 1` 硬顶数组长度、超出记 `guidanceDropped`：45 号文 §8 ⑥。
- 四态与「未知就说未知」：45 号文 §8 ⑧ ＋ `app/public/js/skills-memory.js:164-175`（`playbookStatusText`）与 `:225-245`（服务条计数）实读；手册里那四句原文取自 `locales/zh-CN.json:1251-1262`。

**安全三条 ＋ MCP 掩码**
- `GET /api/status` 是 `open` 档（只有 host 门）：`app/src/01b-route-auth.js:4`（本文 §5 S0b 的坐标，本轮复核仍对）。
- 掩码面、「同一启动目标才还原」、sanitize 兜底、`env`/`headers` 全遮的口径与代价（`PYTHONUTF8=1` → `••••1`）：本文 §5 S0b「改了什么」与「口径决定」。
- 仍未掩的两处（`import-config/scan`、远程 `url`）：本文 §5 S0b「发现但没修」1／2。
- 执行 cwd 解析链与「会话 cwd 被删 → fail-closed 但报错是 spawn 原话」：本文 §5 S0「改了什么」② ＋「发现但没修」4。
- 脱敏表补齐的两类与三条已知边界（PEM 只抹第一段、>4096 字尾部不抹、单引号收口）：本文 §5 S0 ③ ＋「发现但没修」3。
- git 族仍落家目录、管家决策日志不回溯清洗、providers 还原没有启动向量闸、界面没有 MCP env 编辑器：本文 §5 S0「发现但没修」2 与 S0b「发现但没修」3／4／5。

**两条债（派单点名要写进管理员手册的）**
- **ASR 出网面没有 URL 准入校验**：45 号文 §1.6（那套「与 `baseUrl` 相同的校验」**并不存在**）＋ §9.2 末行（26 号文 §1.6 记进 107 Brief 的那一条）。手册里显式把它与 `web_fetch` 的 `ssrfCheck` 分开说 —— 一个收的是管理员配的端点，一个收的是模型给的不可信 url。
- **没有每会话并发上限**：本文 §3 拍板 4 (b)。
- **`needs_you` 无事件唤醒**：45 号文 §9.2（B2 行）＋ 本文 §5 E1.7 的三档延迟读数（5 s 档 17.7/30.6 s、15 s 档 31.5/42.7 s、§9.6 那个 37.0 s），并照实写明「**这组读数是在管家没被节流时取的**」（E1.10 ③ 登记的「没量到」）。

**回滚那一节（派单要求的最小步骤）**
- 会被抹掉的四类字段与机制：本文 §1.1 ④。本轮**另做了两处实读复核**，把手册的措辞收紧：
  1. `git show eac1424:app/src/05-claude-engine.js` 里 `sanitizeProvider` 是**白名单重建**，`models[]` 只留 `{id,label}`，且 `hiddenModels`／`audioBaseUrl` 在 2.7.0 的源码里**整个不存在**（grep 零命中）→ 这两个**嵌套**字段确实会被抹。
  2. `git show eac1424:app/src/01-config.js:526` 的 `normalizeConfig` 是 `{ ...defaultConfig(), ...raw }` —— **顶层未知键原样留着**。所以「`asrProviderId`／`asrModel`／`stewardExemptDelegationV1` 会被 normalize 丢掉」是**错的**（我第一版就这么写了，实读后当场改掉）。手册现在明确区分：**被抹的只有 providers 的嵌套字段与管家记忆的 `expiresAt`／`scope`**，顶层键只是「没人读」。
- 2.7.0 里**没有调度器**（`git ls-tree eac1424 app/src/` 里 `06j`／`13s` 零命中）→ 手册写明降级期间 `scheduler/` 原样留盘、一次都不触发。
- `config.json.prev` 只留一代：`app/src/01-config.js:1515` 的注释与实现。
- `steward/` 下的文件名 `memory-v1.json`／`decisions-v1.ndjson`：`app/src/13j-steward-tool-base.js:44-45`、目录名 `13i-steward-inbox.js:35`。

**E1 五个开关的读数**：全部取自本文 §5 E1.2–E1.6 与机读 `107-e1-readings.json`，逐条照抄不改口径 —— 包括三条「不好看」的：111d 那条门「达标但不辨别」、111b 的**摘要费用 +60%**、111a 的**方向反 +32.0%**、111c 的**读数带污染所以是「量不出来」**。管理员手册 §7.3 把这四句原样写进表里。

#### 为什么新开 §9 而不是插在中间（一条会咬人的约束，登记）

用户手册的 `##` 编号**不能重排**：`locales/{zh-CN,en-US}.json` 里有四个锚点键按**标题原文**跳章节 —— `help.anchor.settings`＝「5. 设置指南（用户视角）」、`help.anchor.power`＝「6. 用得更顺手（…）」、`help.anchor.faq`＝「7. 常见问题」、`help.anchor.localModels`＝「8. 用本机模型（Ollama / LM Studio）」，另有 `health.anchor.faq` 同值（`zh-CN.json:290`／`:340-343`）。把新内容插在 §6 之后再顺延编号，会让**体检项的「怎么办」按钮与设置页各分区的「?」跳空**，而改锚点键就是改 locale＝改代码。所以新内容一律**追加成 §9**，前八节的标题一个字没动。`manuals.e2e` (b) 还要求 USER-GUIDE_CN 里存在「任务台布局／不是数据迁移／返回经典布局」三串（§5 那一段），本轮也没碰它们。

#### 门读数（本轮亲自跑，逐件直跑，`tail` 判定行）

| 件 | 读数 |
|---|---|
| `eol-policy.static` | **ALL PASS** —— 928 个跟踪文本文件全部符合声明的 EOL（5 个改动文件都是纯 LF） |
| `copy-terms.static` | **ALL PASS** |
| `i18n.static` | **ALL PASS** |
| `i18n-en-terms.static` | **ALL PASS** |
| `facts.static` | **ALL PASS**（README 的门面数字与 `facts.json` 仍一致 —— 本轮没动任何计数） |
| `manuals.e2e` | **ALL PASS**（两手册 ≥4000 字节、关键词齐、无密钥形态／旧品牌／`TODO`／`待补`、README 双链接可达） |
| `meta-guard.e2e` | **ALL PASS**（含 C 段「ADMIN-GUIDE 引用的 ACC 版本 === `server.py` VERSION」——本轮没新写任何 `ACC vX.Y.Z`） |
| `repo-hygiene.e2e` | **ALL PASS**（含 (b) 全仓密钥形态零命中与「活文档无真实用户名」；`ARCHITECTURE_CN.md` 在那张活文档表里） |
| `help-viewer.e2e` | **ALL PASS**（手册经 `GET /api/help/doc` 真读得出来、`bytes` 与磁盘一致、未超 512 KB 上限、`##` 目录取材面仍在） |
| `run-all.js --fast` | **73 pass / 0 fail / 0 known-fail / 0 unexpected-pass / 0 flaky / 73 ran（7 skipped 为既有 live probe）** |
| 控制字节扫描（node，5 个改动文件） | `NUL 0 / CR 0 / 其它 0x00–0x1f 0`；`U+FFFD` 仅 `OPTIMIZATION-ROADMAP.md` **1 处**，**与 HEAD 逐字相同**（它是 106 波那条「中文被管道切两半」病历里故意写的样本，不是新增） |

**没跑全量回归**：这一刀零代码改动（`app/`／`dev-harness/`／`tools/` 一个字节没碰，`git status` 里只有 5 个 `.md` ＋ 本文），全量回归的输入面完全没变。冻结树上那一轮由 **⑦ Q1** 跑。

#### 故意留给后面几刀的

1. **发布日期与版本三角** → **R1**：`CHANGELOG.md` 的「未发布」节首与那条 HTML 注释里写明了要改成什么形状；`package.json`／`00-boot.js`／`facts.json`／README 版本行都没动。**顺带把 `00-boot.js:36` 那句会被误读的「v2.8」注释改掉**（本节开头那条理由）。
2. **Release Brief 一页纸** → **D2**：22 号文 §8 四项 ＋ 路线图 :47 四问。本轮的管理员手册 §7 是**给部署者看的操作面**（怎么关、怎么升、怎么退），**不是 Brief**；Brief 要的「完整开关清单从 `01-config.js` 默认值区逐条核对」（本文 §1.3 末行点名的那件事）也**没做** —— 手册 §7 开头已写明「这一节只列 2.8.0 要点名的那些，不是默认值区的全表」。另：43 号文 §2 给 126／127 的退出门 J12／J13／J03 仍**没有人报过读数**（本文 §4 点名由 D2 补），本轮没替它补。
3. **111 三项是否翻默认** → **D2／用户拍板**：E1 只报不翻，手册 §7.3 写的是「建议默认开」「再看」，**没有把任何一个写成已交付**。
4. **英文手册**（`USER-GUIDE_EN.md`／`ADMIN-GUIDE_EN.md`／`ARCHITECTURE_EN.md`）**没同步**：本轮只动中文三本（派单点名的就是 CN 三本；`manuals.e2e` 对 EN 只要求 §5 那三串仍在，仍绿）。英文手册因此落后一个版本，**登记，交主会话定是否单开一刀**。
5. **打包与覆盖升级的文档面**：管理员手册 §1.3 的 overlay 套用步骤本轮没改；P0 那一刀把覆盖包从 154 条补到 203 条（加了 playbook／内置技能／内置命令），**覆盖升级的老用户拿不到新模板**这件事只写进了路线图与本文，**没有写进手册的 overlay 一节** —— 等 **⑧ P1** 真跑完覆盖与回滚演练，拿到实际读数再写，免得写成推测。

#### 本轮自己抓到的两处错（照实记）

1. **「另有 26 个 steward 工具、不计入 97 这一轴」** —— 两处都错。26 是第 116 波后半的历史数字，今天是 **33**；而且它们**就在** `TOOL_HANDLERS` 里、**计入** 97。按 `dev-harness/steward-tools.static.e2e.js:133` 那条锁的断言原文（`97(63 + 33 steward_* + 1 audio_transcribe)`）改正。教训与 [手攒的名单要配机械锁] 同族：**门面数字别照抄老 CHANGELOG，去读那把锁**。
2. **「降级后 `asrProviderId`／`asrModel` 会被 normalize 丢掉」** —— 错。2.7.0 的 `normalizeConfig` 是「默认值铺底 ＋ 磁盘覆盖」，顶层未知键原样留着（`eac1424:01-config.js:526` 实读）。真正会被抹的只有 **providers 的嵌套字段**与**管家记忆的两个字段**。这一条直接决定用户该备份什么，**写错了就是让人白备份或漏备份** —— 所以回滚那一节的每一条都回到 2.7.0 的源码上读过一遍，而不是照 §1.1 ④ 的摘要转述。
