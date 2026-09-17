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
