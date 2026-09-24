function defaultConfig() {
  return {
    configSchema: CONFIG_SCHEMA,
    // 128a(48 号文 §2):用户(或产品代用户)真正改过的键。盘上只落这些键 ＋ 簿记键 ＋ 本版不认识的键,
    // 没碰过的设置跟随产品当前默认 —— 否则装过一次的机器上每个默认值都会被冻在盘上(见 normalizeConfig 头注)。
    configExplicitKeysV1: [],
    version: VERSION,
    agentCliType: 'claude',       // claude | kimi — native Agent CLI driver
    // 123-N2(用户 2026-09-13 真机:「新开线程会默认开 Kimi code cli,我希望改成默认上一次用的」):
    // 新线程的缺省引擎【不再写死跟全局】。'last' = 跟「上一次用的」(见 lastUsedEngineRoute),
    // 'global' = 老行为(跟 activeProvider / agentCliType / model 那三项全局设置)。默认 'last'。
    newThreadEngine: 'last',      // last | global
    // 「上一次用的引擎路由」。**只记用户自己的选择与用户自己发起的回合**(线程头切引擎 = 02 的
    // applySessionMetaPatch;工作台发起的回合 = 10 的 runSessionTurn source==='http'),管家/调度器
    // 派出去的回合一概不记 —— 那不是用户的意思表示。形状与会话头上的 engineRoute 逐字一致
    // ({engine:'openai',providerId,model} | {engine:'agent',agentCliType,model});没有记录时是 null。
    lastUsedEngineRoute: null,
    claudePath: detectClaudePath(),
    kimiPath: detectKimiPath(),
    defaultWorkspace: os.homedir(),
    permissionMode: 'default',
    includeWorkbenchMcp: true,
    autoResumeClaudeSessions: true,
    model: '',
    // Universal compaction model. Empty provider/model means "follow the current engine": Claude and
    // Kimi use their native compactor, while an OpenAI-compatible provider uses its active model.
    compactProviderId: '',
    compactModel: '',
    // Conversation limits are route/model scoped; never use the selected summarizer's window here.
    contextWindowOverrides: {},
    maxTurns: '',
    extraClaudeArgs: [],
    allowCommandTools: true,
    allowDesktopTools: true,
    // --- v0.3 additions ---
    theme: 'dark',
    // UI language preference. `auto` is resolved to the browser language on first successful UI boot,
    // then persisted as a concrete supported locale so later launches do not unexpectedly change language.
    locale: 'auto',
    includePartialMessages: true, // real-time token streaming via --include-partial-messages
    thinkingBudget: '',           // sets MAX_THINKING_TOKENS when non-empty
    claudeThinkingEffort: '',     // '' inherits the CLI config; otherwise passed via --effort
    betaInterleavedThinking: false, // adds --betas interleaved-thinking (probe first; may be rejected by older CLI)
    mcpCommandMode: 'auto',       // auto | node | exe — which command the generated MCP config points at
    killOnDisconnect: true,       // taskkill the claude child when the UI aborts/disconnects
    killPortOnStart: true,        // on startup, if the port is held by a STALE workbench, free it and retry
    // --- v0.4 additions (interactive engine + permission bridge) ---
    engineMode: 'interactive',    // legacy (stdin closed, safe) | interactive (stdin kept open: AskUserQuestion + permission bridge)
    permissionBridge: true,       // route tool-permission prompts to the UI via --permission-prompt-tool (needs a non-bypass permission mode)
    // 2026-09-24 用户拍板:提问/权限默认【不限时】(0)—— 一直挂着等人处理,弹窗过一会儿自己收进右下角小窗。
    // >0 为毫秒上限,到时权限按拒绝、提问按取消(老语义);定时任务派的无人值守回合另有自己的等待表(07)。
    permissionTimeoutMs: 0,       // 0 = no limit; >0 = ms before a permission prompt auto-denies
    questionTimeoutMs: 0,         // 0 = no limit; >0 = ms a request_user_input question waits (UI heartbeat extends it while open)
    // 第27f波:权限超时→存档暂停(opt-in,默认 false=保持"超时即拒杀"的安全默认,零行为变化)。开启后:无人值守(driverAuto)
    // 回合里权限弹窗超时【不再立即拒杀】,而是打检查点 + 通知 + 延长到 autonomyPauseTtlMs 的有界窗口等人决定;窗口内无决定
    // 则回落 deny(fail-closed,防通知未达时无声僵尸挂起)。改的是【超时默认路径】,故 security-sensitive、默认关。
    autonomyPauseOnTimeout: false,
    autonomyPauseTtlMs: 2700000,  // 暂停等待上界(默认 45min;clamp [5min, 6h])——超时后 fail-closed deny
    // 第29波(§29 监控与运营):增量监控总开关(默认开——纯传输优化,快照仍是唯一权威状态源;关闭则前端
    // 回到 2s 全量轮询)。autonomyAutoResume 是 boot 自动恢复(opt-in,默认 false=重启只诚实标死、零行为
    // 变化;开启后仅 auto_resumable 的 run 自动续跑,含 exec/已确认写副作用的 run 停在暂停态等人,见
    // classifyRunResumeTier)。
    monitorIncremental: true,
    autonomyAutoResume: false,
    // 第30波(编排按难度选模型):后端按 toolTier 自动为【未指定 model 的节点】兜底挑档位(read→快/edit→均衡/
    // exec→强)。默认关=零行为变化(未指定即继承)。AI 编排者【显式】设的 model 始终优先且不受此开关影响 ——
    // 本开关只管"AI 没设时后端要不要替它按 tier 挑一个"。
    agentAutoModelTiering: false,
    // v1.9 数据管家: 保留策略(专家界面「存储」页签可配)。默认保守:logs 按文件名日期保 30 天;
    // 真终态 run 的事件日志 14 天后 gzip(仍可读,体积 ÷~10);webcache 默认【不】自动清 —— v0.9-S9
    // 的设计承诺是"离线无价,旧副本仍有用",条目上限留作用户 opt-in(0=不限)。
    storagePolicy: { logsKeepDays: 30, agentRunEventsCompressDays: 14, webcacheMaxEntries: 0, engineTranscriptDays: 30 },
    turnIdleTimeoutMs: 600000,    // watchdog: kill a turn idle (no events) longer than this
    // --- v0.4.4: model list discovery ---
    knownModels: [],              // models actually selected/used — remembered so they stay in the list
    extraModels: [],              // manual entries, each "id" or "id|Label"
    discoverModelsFromProxy: true,// best-effort GET {base}/v1/models to list live models (falls back offline)
    modelsApiBase: '',            // base URL override (else ANTHROPIC_BASE_URL / ANTHROPIC_BASE env) — also
                                   // drives the ACTUAL Claude CLI child's ANTHROPIC_BASE_URL (buildClaudeCliEnv)
    modelsApiKey: '',             // auth override (else ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY env) — ditto
    claudeAuthMode: 'auto',       // 'auto' | 'bearer' (ANTHROPIC_AUTH_TOKEN, e.g. Ark Coding Plan) | 'x-api-key'
                                   // (ANTHROPIC_API_KEY, Anthropic official) — see buildClaudeCliEnv
    // --- v0.5: multi-provider engine (native OpenAI-compatible: DeepSeek / DashScope / local vLLM/Ollama) ---
    activeProvider: '',           // '' | 'claude-cli' -> Anthropic via the claude CLI (default). Else a providers[].id -> native engine.
    providers: [],                // [{ id,label,type:'openai-compat',baseUrl,apiKey,model,models,reasoning,systemPrompt,temperature,extraHeaders }]
    // 114a(45 号文 §7): 语音识别(ASR)端点选择 —— provider id + 模型 id。两值皆非空才算「已配置」
    // (26 号文冻结边界:未配置=麦克风不可见)。纯增量 + normalizeConfig 消毒形状,CONFIG_SCHEMA 故意
    // 不 bump(45 号文 §6.1 对 26 号文的显式改判:无旧值要改写,读回空串即「未配置」)。
    asrProviderId: '',
    asrModel: '',
    // 130(51 号文):实时识别(流式小模型,边说边出字)。与上面那对同口径:两个都非空才算「已配置」;
    // 上面那对从此兼任「第二遍校正」—— 两遍都可选,各自独立。
    asrStreamProviderId: '',
    asrStreamModel: '',
    // 131b(52 号文 §5;用户 2026-09-21 拍板「加进设置里可以配置,重新设计选项方式」):句尾改错的方式与「大模型改字」用哪个端点。
    //   asrFixMode:'auto'(有整段识别就重听、再有大模型就合成 —— 评测里两者合成最好)| 'audio'(只重听)| 'llm'(只让大模型改字)| 'off'
    //   asrFixProviderId:'' = 跟随对话主端点(activeProvider;只认 OpenAI 兼容端点,claude-cli 不算);asrFixModel:'' = 该端点的缺省模型。
    asrFixMode: 'auto',
    asrFixProviderId: '',
    asrFixModel: '',
    openaiMaxToolIterations: 100, // v1.6.3: standard base budget 1..200; long turns start at 200 and may extend to hard cap 300 while progressing
    // --- v0.7d: external / desktop MCP integration ---
    // Convenience entry for the user's own ai-computer-control desktop MCP (Windows control). When
    // enabled + command empty + autodetect, detectDesktopMcp() locates it; blank command => absent => graceful.
    desktopMcp: { enabled: true, command: '', args: [], cwd: '', autodetect: true },
    // Browser target shared with ai-computer-control. `system` opens the user's configured browser and
    // continues via screenshot/UIA/OCR; Playwright-owned Chrome for Testing is an explicit `bundled` choice.
    browserAutomation: { mode: 'system', executable: '', cdpUrl: 'http://127.0.0.1:9222' },
    // Extra user-defined stdio MCP servers: [{ id,label,command,args:[],cwd,env:{},enabled }]. Capped at 10.
    externalMcpServers: [],
    // 启动时自动把本机 Claude Code(~/.claude.json 的 mcpServers)中 Ruyi 还没有的 stdio/远程条目映射进
    // externalMcpServers。默认开;关掉则完全不扫。dismissedMcpIds 记录用户已从 Ruyi 删除的 id,自动导入跳过
    // 它们(避免「删了又自动回来」的循环);用户经 import-config/apply 显式再导入会从 dismissed 移除。
    autoImportClaudeCodeMcp: true,
    dismissedMcpIds: [],
    // Master switch for line 2: also expose external/desktop MCP tools to the NATIVE provider tool loop
    // (bridged via an in-process MCP stdio client). Off => providers see only the workbench's own tools.
    bridgeExternalToolsToProvider: true,
    // Adaptive tool loading keeps only task-relevant schemas in the model context. `full` is the
    // compatibility escape hatch; `auto` pre-routes common packs and exposes compact discovery tools.
    toolLoadingMode: 'auto',       // auto | full
    toolCatalogCacheTtlMs: 60000,  // bridged catalog reuse; clamp 5s..10min
    // 20-T1/20-C1/20-F1 runtime-optimization slices. The master shadow flag is on by default: it evaluates
    // candidates and emits redacted comparison metrics, but never changes a tool result, history content,
    // retry, permission, or memory decision. Tool retrieval remains opt-in; the reducer/recall pair passed
    // real-history adoption gates and defaults on, with explicit false preserving the legacy behavior.
    runtimeOptimizationShadowV1: true,
    runtimeToolRetrievalV1: false,
    runtimeObservationReducerV1: true,
    // 126-111a(25 号文 §1.2): L1 蒸发的边界从「倒数第 2 条 assistant」改为【token 预算】。
    // 默认关;显式 false / 缺省 = 逐字节等价今天的 assistantsSeen===2 边界。
    runtimeEvaporateBudgetBoundaryV1: false,
    // 126-111e(25 号文 §1.2): 历史内重复读取去重 —— 同一份文件内容在受保护的尾部里躺着好几份
    // 全文时,较早那几份换成指针(指向后文那一条,并带 rawRef 可回查原件),最新一次留全文。
    // 107-T1(46 号文 §5)起【默认开】:真模型配对 A/B 里 L1 单趟释放 token +70.0%/+40.8%,
    // B 类非劣 12/12。**缺省不再等价旧行为** —— 只有【显式 false】才回到零改写;而且 schema<12
    // 的存量配置会被 normalizeConfig 里那段一次性迁移把显式 false 翻成 true(2.8.0 之后再关的不动)。
    runtimeHistoryReadDedupV1: true,
    // 126-111d(25 号文 §1.2): 摘要 prompt 双语。开关开且 locale 是 en-US 时用英文那份
    // (判据与 06b 的 getPromptPack 同一条,不另立第二套语言口径)。
    // 107-T1(46 号文 §5)起【默认开】:关臂 6/6 给英文界面发中文摘要,开臂 6/6 英文。
    // **缺省不再等价旧行为** —— 只有【显式 false】才逐字节仍是中文;schema<12 的存量配置里
    // 显式的 false 会被 normalizeConfig 那段一次性迁移翻成 true。locale=auto/zh-CN 逐字节不变。
    runtimeSummaryPromptI18nV1: true,
    // 126-111b(25 号文 §1.2): L2 尾部按【单元】保留 —— 最新一整个 user 回合放不下时,不再一条不留,
    // 而是按「assistant(tool_calls)＋其全部 tool 回复」这样的完整单元从尾部装;保留段以 assistant
    // 打头时插一条桥接 user 消息。
    // 107-T1(46 号文 §5)起【默认开】:空尾重播种 11 次 → 0 次(门 −80%,实测 −100%);
    // 代价是 L2 次数 1.83 → 3.50、摘要费用 +60%,已写进 2.8.0 发行说明。
    // **缺省不再等价旧行为** —— 只有【显式 false】才回到「装不下就 kept=[]」;schema<12 的存量
    // 配置里显式的 false 会被 normalizeConfig 那段一次性迁移翻成 true。
    runtimeReseedTailUnitsV1: true,
    // 126-111c(25 号文 §1.2): 重播种后把【最近读过的文件】有界地重附回去。默认关;
    // 显式 false / 缺省 = reseed 结果逐字节不变(零注入)。
    runtimeReseedReattachFilesV1: false,
    // 105a: observation_recall 工具外壳 —— 让模型按缩减视图内嵌的 rawRef 回读原始工具结果。
    // 仅在 runtimeObservationReducerV1 同时开启时生效(rawRef 只由 reducer 产生);真实历史门后默认开启。
    runtimeObservationRecallV1: true,
    // 105b: session-notes.md 状态外置 —— L2 摘要成功后把【已确认的决定】/【未完成事项】/
    // 【关键文件与上下文】三节确定性切出,整写到 sessions/<id>.session-notes.md 旁车副本。
    // 摘要保留叙事职责;回注上下文由 105d 的 runtimeSessionNotesInjectV1 单独把门(它自 105d 起默认开)。
    // 105b 真实历史门通过后默认开启，仍可显式关闭。
    runtimeSessionNotesV1: true,
    // 105d-A: session notes 回注 —— 开关开时每回合读一次旁车 notes,有界、非持久地贴到最后一条
    // user 消息(去重守门:历史首条 user 已含压缩摘要时跳过)。真实历史+端到端采用门通过后默认开启;
    // 显式 false = 零注入、零文件读取,完整回退到 105b 只写不回注。
    runtimeSessionNotesInjectV1: true,
    // 105d-B: session notes 增量合并 —— 开关开时 L2 成功后 read→merge→write(决定/关键文件并集
    // 去重、未完成事项以最新摘要为准),而非每次整体重写。真实历史+端到端采用门通过后默认开启;
    // 显式 false = 105b 整体重写语义逐字节不变。
    runtimeSessionNotesMergeV1: true,
    // 105c: 摘要实体确定性抽检 —— L2 摘要产出后对路径/版本/带量级数字/日期/代号做确定性抽检,
    // 缺失时给出缺失清单并【恰好一次】定向修补(不无界重试)。真实历史+DeepSeek 门通过后默认开启;
    // 显式 false 可回退到零检查、零修补、零事件的旧行为。
    runtimeSummaryEntityCheckV1: true,
    // 105e: 估算因子分桶 —— 开关开时 estimateTextTokens 先按 JSON/代码/散文分类再套桶因子
    // (json ÷2.8、code ÷3.2、text 维持 ÷3.6;CJK 各桶恒 ÷1.5),因子与阈值由
    // context-governance-rules.json 的 estimation 块持有。A/B 回放 + 夹具修复后默认开启;
    // 显式 false 回退两桶(行为逐字节不变)。EMA 校准回路(noteEstimateSample)不变。
    runtimeEstimateBucketsV1: true,
    // 105f: 摘要单发优先 —— 开关开时摘要输入预算由「窗口 × 50%」改为「窗口 − reserve」(reserve =
    // system＋摘要 prompt＋预期输出＋校准误差上界,分量在 rules 的 summary.singleShotReserve),估算 ≤
    // 单发上限(summarySingleShotMaxTokensV1)时先单发,仅当返回可识别的上下文超窗 400 才自动降级到
    // 现有 map-reduce。历史派生的 20–28K 配对模拟与 400 降级门通过后默认开启;
    // 显式 false = 45a/22-S0 现状逐字节不变。
    runtimeSummarySingleShotV1: true,
    // 105f: 单发估算上限 —— UI 三档 16K/32K/64K(默认 32K,22-S0 实测 60K 输入 p50≈45–51s,远程摘要
    // 超时 180s,64K 档贴近超时线);可按 provider/模型/引擎覆盖(summarySingleShotMaxOverridesV1),
    // sanitize 钳位 [8192, 131072]。不提供无限档,不自动改远程超时。仅 runtimeSummarySingleShotV1 开时生效。
    summarySingleShotMaxTokensV1: 32768,
    summarySingleShotMaxOverridesV1: {},
    // 105g(4.3 首项): map-reduce 全局事实表 —— 开关开且真实分块(chunks>1)时,从完整历史确定性
    // 抽取全局实体表(复用 105c 抽取器,零新增 LLM 调用),作为一条 user 消息注入每个分段摘要与
    // 各轮汇总调用,缓解跨块约束丢失。真实 history-24 配对 A/B 门通过(实体保留 18.8%→75.0%,
    // 调用数零增加)后默认开启;显式 false = 分段与汇总请求体逐字节回退现状。
    runtimeSummaryFactTableV1: true,
    // 事实表条数甜点位实验参数。超长 history-24 真实门显示 64 条在可接受成本/延迟内
    // 仍有净收益;运行时钳位 [4,64],仅在 fact-table 开启时生效。
    summaryFactTableMaxSamplesV1: 64,
    // 105h(4.3 第二项): <=4 块顺序 refine —— 用首块摘要作为累计状态,后续块逐次修订;
    // 任一步请求或五节结构校验失败,整条从原始历史回退现有 map-reduce。105 总门无净收益,默认关;
    // 显式 false = 105g 现状请求序列与请求体逐字节不变。
    runtimeSummaryRefineV1: false,
    // 106 #13a: 预算保护基础层 —— 开关开且 budgetGuardTurnTokensV1 >0 时,对每个原生回合的累计
    // token(provider 实报 usage 逐调用累加)把门:预警(达 budgetGuardWarnRatioV1 一次性提示)、
    // 预留(发起下一次模型调用前把该调用估算输入计入在途额度,花不下就不再发起)、停止新增调用
    // (触顶即结束回合,历史/进度完整保留;until-done 任务降为 supervised 等指示,不自动降模型、
    // 不激进摘要)。106 波逐项取证纪律:默认关;显式 false / 缺省 / 预算 0 = 零判定零事件。
    runtimeBudgetGuardV1: false,
    budgetGuardTurnTokensV1: 0,
    budgetGuardWarnRatioV1: 0.8,
    // 106 #13a-t: 长命令时间预算 —— 仅作用于 INTERRUPTIBLE_NATIVE_TOOLS(powershell_run/script_run,
    // 已有 steer 中断与进程树回收路径,不造第二套控制器)。shadow 开关只统计「本应触发」的脱敏
    // 事件(零行为变化,上线前校准阈值用);主动开关 = 软警告(tool_progress 有界告警)+ 硬终态
    // (沿既有取消路径杀树、写合法配对 tool_result、回合继续)。两开关独立、默认关。
    runtimeToolTimeBudgetShadowV1: false,
    runtimeToolTimeBudgetV1: false,
    // 13a-t: 软警告/硬终态毫秒 —— 0 = 该级不启用;非零时 warn 钳位 [1000,3600000]、hard 钳位
    // [5000,7200000]。不动 MCP 第三方工具的既有超时契约(范围红线)。
    toolTimeBudgetWarnMsV1: 0,
    toolTimeBudgetHardMsV1: 0,
    // 13a-t 字节轴【只计数,不改写】:interruptible 工具的 stdout+stderr 超过本阈值时落一条脱敏
    // 计数事件,供校准未来的截断预算;20-C1 三个 High 阻断解除前不做任何结果引用改写。0 = 不计数。
    toolByteBudgetShadowBytesV1: 0,
    // 106 #1 G1: 易变层尾部布局(21-E4 §7.1)—— 开时 turnVolatile 从「前插历史首条 user」改为
    // 「追加当前最新 user 尾部」(与 recall/notes 注入同位)。前插布局下易变内容跨回合变化会让
    // 前缀缓存从 messages[1] 起全断(探针证实逐字节敏感、纪律差 ~9× 费用);尾部布局跨回合只
    // 追加不重写。默认关,E4 §7.3 shadow 计量 + 质量非劣验收后才谈 flip;显式 false/缺省 =
    // 请求体与现状逐字节一致。
    runtimeVolatileTailLayoutV1: false,
    // 106 #1 G2: tools schema 冻结+只追加(21-E4 §7.2)—— DeepSeek v4-pro Responses 真实 A/B
    // cached-input 提升约 23.9pp、质量 4/4，故默认开；显式 false 仍回退现状。会话首个回合冻结 schema 顺序,之后
    // tool_load/pack 重分类引入的新工具只追加尾部,既有条目不因分类变化重排或移除(探针 S5:
    // tools 计入缓存前缀,中间插入全前缀命中归零、尾部追加保留 ~77%)。catalog 缺失(MCP 离线/
    // 撤权)时保留名义位置、记 cache break 原因。显式 false = catalog 序过滤现状。
    runtimeAppendOnlyToolSchemasV1: true,
    // 106 #2a: 受限执行结果缓存(22 号文 §6.1)—— 白名单(首批仅 file_read)只读结果的按会话缓存:
    // 身份 = 工具+规范化参数+解析后绝对路径;资源版本 = mtimeMs+size(读取前后双 stat 夹逼,
    // 命中时重新 stat 比对,不一致即 miss+失效;外部写入/删除/重建/重命名由此覆盖)。权限守卫
    // 在缓存查找之前先跑,命中仍重新验权。命中结果带 cacheHit 诚实标记(不冒称重新执行);
    // 错误/中断/读写竞态结果不缓存。4×2MB 文件、12 次真实重复读取的 DeepSeek v4-flash
    // A/B 中命中 8 次、工具阶段耗时约 311ms→112ms、12/12 正确，故默认开；显式 false
    // 仍回退现状。
    runtimeExecResultCacheV1: true,
    // #2a: 每会话缓存条数上限(LRU 淘汰),钳位 [0,2000];0 = 不缓存(开关双门的第二道)。
    execResultCacheMaxEntriesV1: 200,
    runtimeFailureTelemetryV1: false,
    // 113a: 记忆召回的离线向量层（特征哈希 + TF-IDF + 余弦）与词法层的 RRF 融合。
    // 合成门实测 Recall@3 90% -> 95%（+5pp），未达 25 号预设的 +10pp 自动翻默认条件；
    // 2026-09-04 用户明确拍板默认打开（证据是正收益且无回归，门槛是自动翻牌线、不是否决线）。
    // 显式 false = 回到纯词法排序，结果集与开关引入前逐字节相同。
    runtimeMemoryVectorRecallV1: true,
    // 以下四条是记忆容量的真正治理旋钮（2026-09-04 用户：「记忆数量上限才 24…拓展到尽可能大」）。
    // 原本全是模块常量，现在可配且默认大幅抬高。成本实话：核心胶囊走【易变层】，不进前缀缓存，
    // 每一回合都按实际字数付输入 token——但它只装用户【主动标为 core】的条目，没标就不花钱，
    // 所以把天花板抬高本身是安全的，真正的闸门是字符预算。
    coreMemoryMaxItemsV1: 200,      // 核心胶囊席位数（旧常量 24）;钳位 [0, 2000]
    coreMemoryCharBudgetV1: 16000,  // 核心胶囊字符预算（旧常量 4200）;钳位 [0, 200000]
    memoryRelevanceMaxV1: 8,        // 默认检索每轮注入条数（旧常量 3）;钳位 [0, 64]
    memoryFixedSelectionMaxV1: 64,  // 会话固定选择上限（旧常量 12）;钳位 [1, 1024]
    memoryIndexCharCapV1: 6000,     // 相关记忆索引整段字符上限（旧常量 2600）;钳位 [500, 100000]
    // 113b: 会话内容搜索索引。侧栏搜索此前只能模 title/summary/cwd 三个字段的子串，
    // 搜不到正文——“我上周让它改过那个文件”这类回忆式查找完全无法完成。
    // 默认开：新能力，旧子串过滤作为回退保留；显式 false 即整条路径关闭（回到今天）。
    sessionSearchIndexV1: true,
    // 21-E0/E1: 三层调用账本(modelCallId → assistantBatchId → toolCallId)与工具经济性 shadow。
    // 只追加脱敏观测事件(model_call_started/completed、assistant_tool_batch、tool_call_completed、
    // tool_phase_completed),不改 prompt/调度/history。默认开但带采样与每回合事件上限;false 则零事件。
    toolEconomicsShadowV1: true,
    // 21-E2: 有界只读批次调度器 —— >8 纯 read 批用 worker pool 限流并发,混合批提取只读并行岛。
    // 主动开关默认 false;并发 clamp 1..8(决策点 B: 并发 = min(8, max(4, batchWidth)),≤8 保留现状全量)。
    boundedReadSchedulerV1: false,
    boundedReadConcurrencyV1: 4,
    // 21-E5: 元工具链收敛 —— tool_search 紧凑调用提示(requiredArgs/callHint/state)、todo_write 内容
    // 去重(unchanged 语义)、discoverySeq 链路关联。默认 false(行为零变化);false 时只有 E0 账本照常,
    // 不加 hint 字段、todo 重复写入照常。discoverySeq 观测字段跟随 toolEconomicsShadowV1。
    metaToolHintsV1: false,
    // 21-E3: 已执行动作的参数历史双视图 —— 完整参数只用于执行与审计(session.actionAudit),后续请求的
    // model view 投影为紧凑 action envelope(_ruyiActionRef/target/payload/status),大参数不再重复携带。
    // 默认 false(行为零变化);投影只对 status=completed 且 sha256 可校验的动作生效,失败/中断/待审批
    // 不瘦身;原始 arguments 保留在 providerHistory 原消息与 audit 中,可还原、零证据损失。
    actionArgumentModelViewV1: false,
    // v1.1-W2 (T2): auto-scan drop-in MCP connectors from <repo>/mcp/*/ruyi-mcp.json and
    // <dataRoot>/mcp/*/ruyi-mcp.json and runtime-merge them (never written to config; delete the folder to
    // uninstall). Default on. Off => only config.externalMcpServers + desktopMcp are used.
    enableMcpDropIn: true,
    // ruyi-toolbox 组件自动发现(用户 2026-09-21:「开箱即用」)。登记文件住 ~/.ruyi-toolbox/components/(04 scanToolboxComponents)。
    //   autoDiscover —— 总开关,缺省开;关掉 = 一个登记的组件都不拉起、不接入。
    //   disabled     —— 逐个停用的组件 id(停用是如意一侧的事,不删登记文件;卸载才删)。
    //   seen         —— 已经接入过的组件 id。只用来保证「自动选成语音识别端点」对每个组件【只发生一次】:
    //                   用户后来手动关掉或换走,下次启动绝不再替他选回来。
    // 这三项都【不含命令】:命令只来自磁盘上的登记文件,API 改得了的只有「接不接」。
    toolbox: { autoDiscover: true, disabled: [], seen: [] },
    // v0.8-S0: per-tool permission-tier overrides for BRIDGED (external/desktop MCP) tools, keyed by the
    // UNPREFIXED tool name. Merges over BRIDGED_TOOL_TIERS defaults. Values: 'read' | 'edit' | 'exec'.
    bridgedToolTiers: {},
    // v0.8-S2: max concurrent persistent shell sessions (shell_start). Clamped 1..8 in normalizeConfig.
    // Sessions live ONLY in the serve process (provider engine); the MCP child path returns a guiding error.
    shellSessionMax: 3,
    // v0.8-S4b B3: persistent fine-grained allow rules for NATIVE tools, {toolName:'allow'}. Consulted by
    // the provider tool loop BEFORE prompting (a gate:'ask' that matches → allow). normalizeConfig cleanses
    // this HARD: only tools whose native tier is 'read' or 'edit' survive — exec/desktop tools can NEVER be
    // persistently allowed (only session-scoped, held in the front-end). A bad entry is dropped silently.
    toolAllowRules: {},
    // v0.8-S5: auto-compaction trigger — when est(history) > autoCompactThreshold × provider.contextWindow
    // at an iteration boundary, the two-level compactor runs (evaporate → summary). Clamped 0.5..0.95.
    autoCompactThreshold: 0.8,
    // v0.8-S6: network-probe target for the capability matrix (§7.2). '' = probe the active provider's
    // baseUrl (HEAD, 3s, cached 60s). A non-empty value overrides it (useful when no provider is set, or
    // for an air-gapped intranet health endpoint). normalizeConfig trims + length-caps it.
    capabilityProbeUrl: '',
    // v0.8-S6: TEST HOOK — enable the (otherwise inert) testOnly TOOL_REQUIRES entry so the capabilities
    // e2e can exercise the requires→filter→「当前不可用」 pipeline. Default false → zero production effect.
    enableToolRequiresProbe: false,
    // v0.9-S1 (C1): UI density mode. 'pro' = full three-pane developer surface; 'simple' = the 人人可用
    // surface (debug/mcp tabs + composer advanced buttons hidden via CSS, humanized tool cards, +1px font).
    // Front-end drives it via document.documentElement[data-ui-mode]; normalizeConfig cleanses to the enum.
    uiMode: 'simple',
    // v0.9-S1 (C1): reply verbosity style, injected as a prompt style layer (buildProviderSystemPrompt).
    // 'detailed' = current behavior (no injection); 'concise' = ask the model for short, direct answers.
    outputStyle: 'detailed',
    // Skills that are available in every chat without requiring a per-session toggle. Entries keep the
    // source lock used by session.skills so a project skill cannot silently replace a resident built-in.
    // Empty by default: the UI highlights suitable built-ins, while the user decides what deserves the
    // small always-on prompt cost for their own work.
    residentSkills: [],
    // v0.9-S3 (C3): most-recently-used working folders (absolute paths, ≤10 LRU). Front-inserted on a
    // successful workspace switch (top-bar picker / folder-drag resolve). Also seeds the /api/workspace/
    // resolve candidate roots so a folder the user has worked in before is found even if it lives off the
    // drive-root/home fingerprint set. normalizeConfig cleanses to a de-duped string array truncated to 10.
    recentWorkspaces: [],
    // 118a: welcome-wizard completion record. null = never finished and never skipped (the wizard may
    // still be offered). Shape once written: { completedAt: ISO|null, version: <int>, skipped: bool }.
    // Purely additive: normalizeConfig sanitizes the shape and CONFIG_SCHEMA is deliberately NOT bumped,
    // so an older config simply reads back null and the wizard stays available.
    onboarding: null,
    // v2.7 (workspace permissions): trusted workspaces with per-workspace read/write/execute flags.
    // Priority = array order (index 0 = primary/current default). Each entry { path, read, write, execute },
    // all defaulting to true. Seeded from defaultWorkspace + recentWorkspaces on first load so existing
    // users keep full access. defaultWorkspace stays in sync with workspaces[0].path (backward compat).
    workspaces: [],
    // v2.7: escape hatch for the file-tool workspace boundary. true = the native file tools may read AND
    // write outside any configured workspace (still audit-logged; sensitive control-plane paths stay denied).
    allowOutsideWorkspace: false,
    // Sub-agent orchestration limits. maxConcurrent controls one parallel stage; maxPerTurn controls all
    // stages combined (an ad hoc spawn_agent/orchestrate_agents fan-out WITHIN one chat turn — NOT the
    // same budget as a persisted Agent 工作流 DAG's node count, see agentWorkflowMaxNodes below).
    // 0 total disables spawn_agent entirely. v1.4.4: defaults raised to the top of each clamp range
    // (subagentMaxConcurrent 1..8, subagentMaxPerTurn 0..32) — most real workflows were hitting these.
    subagentMaxConcurrent: 8,
    subagentMaxPerTurn: 32,
    // 52x: 子 agent 优先端点+模型。spawn_agent/orchestrate 的 openai 节点默认用此 provider+model(可跨 provider);
    //   模型仍可经 spawn_agent.model 参数选同端点下别的模型(如 Pro 版),或 omit 继承默认。未配置 -> fallback 主 provider + provider.subagentModel。
    subagentPreferredProvider: '',
    subagentPreferredModel: '',
    // 第 116 波 116a(27 号文 §11.3):管家总开关。第 121 波 K0(34 号文 §8.4 拍板③)默认关→开:管家视角成为默认入口。
    stewardEnabledV1: true,
    // 第 116 波 116a(27 号文 §11.3):管家专用端点/模型,空值="跟随主端点"(照抄 subagentPreferredProvider/Model)。
    stewardProviderId: '',
    stewardModel: '',
    // 第 116 波 116-5a(27 号文 §11.8「线程自动摘要」):每开一条新线程自动生成一个 ≤24 字的名字与
    // 一句 ≤80 字的概括,写进会话头 threadBrief。**默认开,且【不】随 stewardEnabledV1**(用户
    // 2026-09-07 拍板,§11.8.10 第 1 条):消费面一半在经典壳(侧栏会话列表、113b 会话搜索),
    // 管家关着也该有名字。关掉 = 零调用、零字段、零记账。
    stewardThreadBriefV1: true,
    // 第 127 波 2-quater B2(45 号文 §2-quater.2 B2 / §2-quater.3 拍板 2):管家代批。「智能自动」档里线程因为命令
    // 正文命中永久豁免而停下来问时,管家在十道闸(06i stewardExemptDelegationVerdict)全过、并写下理由的前提下
    // 替用户放行。**默认开**(用户拍板),设置页可关;管家自己改不了(06i 的 forbidden 档,不是 confirm)。
    stewardExemptDelegationV1: true,
    // 第 117 波 117l(27 号文 §11.9 D7;用户 2026-09-07 走查第 7 条「设置的管家页里可以默认配置新开线程
    // 的端点和模型:一个针对复杂任务的强模型、一个简单任务的快速模型」):管家新开线程时按 tier 选端点。
    // 两档都留空 = 全部跟随全局主端点(= 116a 起的既有行为,存量用户零变化)。判定单点在 06i 的
    // stewardThreadEngineRoute;**这两个键不进 steward_config_set 白名单**(模型不能自己换模型)。
    stewardThreadModels: { strong: { providerId: '', model: '' }, fast: { providerId: '', model: '' } },
    // 第 117 波 117w-W1 提交②(27 号文 §11.19.2/§11.19.5 推荐 A):Ruyi 默认工作区【根】。
    // 管家开线程时若省略 cwd,工作台在这个根下派生一条属于那个线程自己的子工作区(<root>/<slug(标题)>)
    // 并把它登记进 workspaces[]。放 ~/Ruyi 而不是 <dataRoot>/workspace 的理由(§11.19.5):这些目录里
    // 放的是【用户的工作产物】(报告、抓下来的数据),不是 Ruyi 的运行数据 —— 用户要在资源管理器里
    // 一眼找得到。它是主目录的【子目录】,不是主目录本身,所以 03 的 cwdWarning 对它静默。
    // 围栏类键:按 06i 的 fail-closed 语义自动落 forbidden(管家改不了它,用户在设置里能改)。
    stewardWorkspaceRoot: path.join(os.homedir(), 'Ruyi'),
    // 第 116 波 116a(27 号文 §11.3):管家收件箱轮询间隔(ms),clamp [5000,120000]。
    stewardPollMs: 15000,
    // 第 121 波 K3(34 号文 §4.1/§4.2「噪音用窗口解决,不用能力解决」):任务索引的「最近 N 条」窗口。
    // 一条既不在途、今天也没动静、管家也不盯的旧线程,只有排在最近 N 条里才进索引 —— 几百条存量
    // 普通会话因此不会把左栏淹掉,但它们仍在搜索里找得到。clamp [10,200],判据单点在 06i 的
    // threadVisible(三个数也定在那里:THREAD_INDEX_RECENT_DEFAULT/MIN/MAX)。
    threadIndexRecent: THREAD_INDEX_RECENT_DEFAULT,
    // 第 116 波 116a(27 号文 §11.3):管家每小时最多替用户执行的回合数,clamp [1,120]。
    // 117m-A1:12 → 30。12 是 116a 拍脑袋的保守值,真机上被「代批风暴」15 分钟吃光(见 13h
    // stewardCircuitCheck 的注释)。**不迁移存量配置** —— normalizeConfig 早已把 12 显式写进老用户的
    // config.json,静默抬高别人的花钱上限不合适;只改默认,老用户在设置·管家页自己调。
    stewardMaxTurnsPerHour: 30,
    // 第 116 波 116a(27 号文 §11.3):管家自身每日花费上限(USD),clamp [0,1000]。
    stewardMaxCostPerDay: 1,
    // 第 116 波 116a(27 号文 §11.3):管家「可以自己做的事」自理清单;resume:null=跟随 autonomyAutoResume。
    // 136(用户 2026-09-23「管家不够省心」):relay 默认 false → true —— 把用户的话递给对的线程是管家的
    // 本职,默认只提议等于每句话都多问一遍。answer(代答)仍默认关:那是唯一【替用户说话】的一格(129g)。
    // 不迁移存量:config.json 里已显式落 relay:false 的老用户原样保留(与 117m-A1 同一条纪律)。
    stewardAutoActions: { retry: true, resume: null, relay: true, newThread: true, answer: false },
    // 第 116 波 116a(27 号文 §11.3):一次到访内管家上下文预算(token),clamp [16000,2000000]。
    stewardContextBudgetTokens: 200000,
    // 136(同上「上下文太紧」):预算的几成触发 L2 压缩,clamp [0.3,0.95],非法回默认 0.6。
    // 大窗口模型(百万级)下 0.6 偏保守,可调高;代价是管家每回合更贵、压缩更少触发。
    // 管家自己改不了它:confirm 档(会花钱),只能递按钮等用户按;tokens 键则撞密钥正则仍 forbidden。
    stewardContextBudgetRatio: 0.6,
    // 第 116 波 116a(27 号文 §11.3):管家按需深读单次到访合计字符预算,clamp [4000,400000]。
    stewardReadBudgetChars: 48000,
    // 129f(31 号文 §2.4):管家一小时最多主动叫你几次。6 次是原文定的数 —— 一小时六次已经是
    // 「有事就说」的上限,再多就是噪音。静默时段与总开关复用既有的通知设置,不在这里另开一套。
    stewardNotifyPerHour: 6,
    // 第 116 波 116a(27 号文 §11.3):判定「一次到访」结束的静默分钟数,clamp [5,1440]。
    stewardVisitIdleMinutes: 60,
    // 第 116 波 116a(27 号文 §11.3):管家会话历史保留策略,visit|24h|forever。
    // 136(用户 2026-09-23「不记事」):默认 visit → 24h —— 「到访即忘」(60 分钟静默就整段归档清空)是
    // 「管家不像个熟人」观感的最大来源;跨到访的长期连续性仍走管家记忆库,24h 只是把【今天】留住。
    // 不迁移存量(同上一条纪律);normalizeConfig 的兜底值同步是 '24h',两处必须同一个值。
    stewardConversationRetention: '24h',
    // 136(同上「言行不够拟人」):管家人设。两键皆空 = 用 stable 层的默认自称「如意」与默认口吻。
    // 名字 ≤20 字、口吻偏好 ≤200 字(01-config 归一截断);进提示词的【易变层】(13o 的 personaBlock),
    // 不进 stable —— 用户级变量,进了稳定层就破前缀缓存纪律。free 档:改错了一眼看得见、一键清空。
    stewardPersonaName: '',
    stewardPersonaStyle: '',
    // 第 123 波 M2(37 号文 §3.5):安静卡「稍后」推迟多少分钟,clamp [1,1440]。
    // 它建的是一条【真的】 once reminder(而不是把卡藏起来),所以这个数就是「多久之后再提醒我」;
    // 上限 24 小时:再长就不该由一枚「稍后」来表达了,那是一条新的定时任务。
    quietCardSnoozeMinutes: 30,
    // 第 116 波 116h(27 号文 §3.1 116h 行 / §8.10「并发上限就地可调」;用户 2026-09-03 拍板默认 5):
    // 线程间仲裁的三个全局闸。**只在 stewardEnabledV1 开时生效**(关时 runSessionTurn 根本不问仲裁器),
    // 121 波 K0 之前总开关默认关,所以对存量用户(配置里已显式落 false)仍是纯形状扩张;新装默认开即生效。
    //   stewardMaxParallelThreads —— 同时最多几条线程在跑回合,clamp [1,32];
    //   stewardGlobalMaxTurnsPerHour —— 全部线程合计每小时可开始的回合数,clamp [1,2000];
    //   stewardGlobalMaxCostPerDay —— 全部线程合计当日花费上限(USD),clamp [0,10000],0 = 不限。
    // 与 stewardMaxTurnsPerHour / stewardMaxCostPerDay 的区别:那两个只管【管家自己】的回合与开销
    // (熔断,见 13h stewardCircuitCheck),这两个管【全部线程】(排队,不拒绝)。
    stewardMaxParallelThreads: 5,
    stewardGlobalMaxTurnsPerHour: 120,
    stewardGlobalMaxCostPerDay: 20,
    // 第 123 波 M1(37 号文 §3.2/§3.4;设计权威 29 号文 §4「开关」):定时任务调度器总开关。
    // 默认【开】,但**没有任何任务时零开销**:13s 的 startScheduler 在零任务时不起 interval,
    // 关掉(显式 false)时更是一个字节都不写 —— 不建 <data>/scheduler/ 目录、不读盘、六条路由一律 409。
    schedulerEnabledV1: true,
    // 第 123 波 M1 §3.2「无人值守的 ask」:定时任务派出去的回合遇到要人批准的动作时等多久(分钟),
    // clamp [1,240]。它【只】换掉决定窗口的长度,不改判定 —— 到时仍然是拒(29 号文 §10 红线二:
    // 无人值守遇 ask 绝不自动放行),本次记 needs_you,用户回来「立即运行」重跑。
    schedulerAskWaitMinutes: 30,
    // v1.4.4: max nodes a persisted Agent 工作流 DAG may have (both a fresh /api/agent-workflow/launch and
    // a resumed run). Previously the fresh-launch path wrongly reused subagentMaxPerTurn (a per-CHAT-TURN
    // ad hoc fan-out budget) as the DAG's node-count ceiling — a 4-node default rejected any real pipeline
    // with 5+ nodes outright, while resuming the SAME run used a hardcoded 32. 第23波起 Clamp 1..64、默认 48
    // (64 is also the hard systemic cap in runAgentWorkflow's own `.slice(0, 64)` and the orchestrate_agents
    // schema's maxItems — 第36波(v1.7) 三方对齐, 此前注释与 schema 仍写 32 是漂移)。
    agentWorkflowMaxNodes: 48,
    // Long-running model nodes receive one bounded "wrap up now" instruction after this duration. Separate
    // workflow heartbeats keep the parent turn informed while the node works. 0 disables automatic wrap-up.
    agentNodeWrapUpMs: 480000,
    // 团队模式 v2 (A2): 共享任务池审批策略。manual=UI 运行卡逐条批准(默认);auto-capped=自动批准直到 poolAutoCap
    // 用尽后转 manual;off=不注册 propose_task 工具。物化仍受 agentWorkflowMaxNodes(上限 64)复检(见 materializePoolItem)。
    agentTaskPoolPolicy: 'manual',
    agentTaskPoolAutoCap: 3,
    // Global role overrides/custom roles. Built-ins are merged at read time; project roles live in
    // <workspace>/.ruyi/agents.json so the same definition works with Claude CLI and OpenAI providers.
    agentRoleOverrides: [],
    // v0.9-S9 (D6): web-search backend for the web_search tool. baseUrl = the searxng/custom endpoint (an
    // admin-configured, TRUSTED endpoint — its outbound request is exempt from the SSRF check; only
    // web_fetch's model-supplied url is untrusted). apiKey goes through the SAME mask/unmask体系 as
    // providers[].apiKey (never emitted plaintext).
    // v1.1-W1a (T3): default is now 'builtin' — a ZERO-config, no-key HTML search (Bing CN → 百度 fallback)
    // so a fresh install can search out of the box without anyone applying for an API key. Users who want a
    // proper API (searxng/bing/tavily/…) still pick it in 设置. NOTE: per the T3 migration policy, a stored
    // 'none' is folded to 'builtin' on load (it was only ever the *historical* default, never an active
    // choice) — so search is ON out of the box for both fresh and upgraded installs.
    searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' },
    // --- v1.4.3 additions (CLI capability alignment) ---
    appendSystemPrompt: '',       // non-empty -> --append-system-prompt flag to Claude CLI
    additionalDirectories: [],    // extra dirs passed via multiple --add-dir flags
    // v1.4-OSS 用量看板: optional soft monthly budget. null (default) = no budget. Shape {monthly:Number>0,
    // currency:'USD'|'CNY'|...}. Data-only: /api/usage/summary returns spentThisMonth so the front-end can
    // show a soft warning; the back-end never blocks a turn on it.
    usageBudget: null,
    // v1.4-OSS 用量看板: optional Claude-side pricing {inputPerM, outputPerM, currency}. When set it drives the
    // Claude ledger cost (tokens×price) for BOTH Anthropic-direct AND third-party endpoints (Ark 等) — the CLI's
    // total_cost_usd is Anthropic-priced and only a notional fallback. null (default) = fall back to that USD
    // estimate for Anthropic-direct, and tokens-only (plan-based) for a third-party endpoint.
    claudePricing: null,
  };
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypass'];
const CLAUDE_THINKING_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_ROLE_PERMISSION_MODES = ['inherit', 'default', 'acceptEdits', 'dontAsk', 'bypass', 'plan', 'auto'];
// v1.4.3: Canonical mapping from workbench-internal mode names to Claude CLI mode names.
// 'bypass' -> 'bypassPermissions'; 'auto' is a CLI-native name (no alias needed).
// Used by BOTH the --permission-mode flag construction AND syncClaudeCliSettings (single source of truth).
const CLAUDE_PERMISSION_MODE_MAP = { bypass: 'bypassPermissions', default: 'default', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', dontAsk: 'dontAsk' };
// Accept these CLI-native names as aliases when loading config (so users / external tools that write
// 'bypassPermissions' directly into config.json are not silently reset to 'bypass').
const PERMISSION_MODE_ALIASES = { bypassPermissions: 'bypass' };
// 116-2a(27 号文 §8.6「任何地方切到全自动都要二次确认」):需要二次确认才能【切到】的档。
// 这是「服务端的那一半」——UI 弹窗是另一半,但服务端不能只信 UI:任何调用方(含脚本/管家/117 壳)
// 想把某条线程放到全自动,都必须显式带 confirm:true。收紧与清除不在此列(二次确认防的是「不知不觉
// 被放开」,不是防止用户收紧)。含 CLI 原生内部名 bypassPermissions,即使它不在 PERMISSION_MODES 里
// (白名单会先把它挡成 400)——名单按语义列全,不依赖另一张表的取值范围。
const PERMISSION_MODES_REQUIRING_CONFIRM = Object.freeze(['auto', 'bypass', 'bypassPermissions']);

// 116-2a(27 号文 §3.3「线程权限即管家边界」):权限档的三层解析。纯函数,零副作用,零 I/O。
// 优先级【固定】,高 → 低:
//   ① 请求级临时覆盖(第 78 波:交办确认卡为「这一单当前执行链」收紧,绝不回写任何持久化);
//   ② 会话级 session.permissionMode(116-2a 新增的会话头可选字段;不写 = 跟随全局,故没有「显式
//      等于全局」与「未设」之分的歧义 —— UI 的权限 chip 靠这个区分「这条线程自己定了档」与「跟着走」);
//   ③ 全局 config.permissionMode(§3.3「新线程用全局默认权限」)。
// 每一层都【只认 PERMISSION_MODES 白名单】,非法/缺失一律【静默】回落到下一层(与第 78 波的原语义
// 逐字一致:不报错、不回写、不影响其余层)。三层全空 → 'default'(normalizeConfig 已保证全局档合法,
// 这个兜底只在传了个裸对象/半截 config 的调用方身上生效)。
// 入参三项都既接受「对象」(读它的 .permissionMode)也接受「字符串」(就是档本身),这样测试可以直接
// 喂三个字符串,而 runSessionTurn 可以直接喂 body.permissionMode / session / config。
function permissionModeFrom(value) {
  if (value == null) return '';
  const raw = (typeof value === 'object') ? value.permissionMode : value;
  const mode = raw == null ? '' : String(raw);
  return PERMISSION_MODES.includes(mode) ? mode : '';
}
function resolvePermissionMode(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return permissionModeFrom(src.request)
    || permissionModeFrom(src.session)
    || permissionModeFrom(src.config)
    || 'default';
}
const BUILTIN_AGENT_ROLES = Object.freeze([
  { id: 'explorer', label: 'Explorer', description: '快速探索代码、文档和现状，不修改文件。', prompt: '你是 Explorer。先建立准确的项目地图，查找相关文件、约束和风险；只读，不修改，不执行有副作用的操作。输出简洁、可引用的发现。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'blue' },
  { id: 'worker', label: 'Worker', description: '按明确任务实现改动并完成基础验证。', prompt: '你是 Worker。严格围绕交办任务实施，先理解现状再修改；保持改动聚焦，运行必要验证，最后报告改动、验证和遗留风险。', toolTier: 'exec', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: [], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, color: 'green' },
  { id: 'coder', label: 'Coder', description: '面向代码实现、调试和测试闭环的工程角色。', prompt: '你是 Coder。负责把明确的软件任务落实为可验证的代码：先阅读相关实现、测试和项目约束，定位最小且完整的改动面；遵循现有架构与风格实施，不做无关重构；补充或更新能复现问题、证明行为的测试，运行与风险相称的检查。遇到失败先诊断根因并迭代修复，不把未验证的改动宣称为完成。最后报告修改、测试结果与仍存在的风险。', toolTier: 'exec', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: [], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 150, claude: 150 }, color: 'green' },
  { id: 'reviewer', label: 'Reviewer', description: '独立审查实现的正确性、安全性和回归风险。', prompt: '你是 Reviewer。以证据为准独立审查，不代替实现者辩护。优先找会导致错误、数据损坏、安全问题和缺失测试的具体缺陷；给出文件位置和可执行建议。默认不改文件。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'orange' },
  { id: 'verifier', label: 'Verifier', description: '运行测试并核验结果，不擅自修改产品代码。', prompt: '你是 Verifier。根据验收标准运行测试、检查日志和产物，区分已验证事实与推断。不要修改产品代码；若失败，给出最小复现、实际结果和预期结果。', toolTier: 'exec', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, color: 'purple' },
  // 第23波: 新增 5 个角色,覆盖「规划 → 研究 → 批判 → 综合 → 数据分析」的常见协作分工,并据此拓宽内置模板。
  { id: 'planner', label: 'Planner', description: '把复杂任务拆解为清晰的计划/设计，不实现。', prompt: '你是 Planner。把交办的复杂目标拆解成可执行的计划或设计：明确目标与非目标、硬约束、分步方案及其依赖顺序、每步的交付物与验收点、主要风险与应对。只规划不实现，也不执行有副作用的操作。输出结构化、可直接据以行动的计划。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'teal' },
  { id: 'researcher', label: 'Researcher', description: '联网检索并阅读来源，产出有来源支撑的发现。', prompt: '你是 Researcher。围绕问题联网检索、阅读来源，就每个子问题给出有来源支撑的发现：结论 + 来源(标题/URL) + 置信度，区分事实与观点，主动寻找反面证据。只记录有来源支撑的内容，查不到就如实说明，绝不编造来源或数据。只读不改。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'cyan' },
  { id: 'critic', label: 'Critic', description: '对抗式审查：主动找漏洞、反例和无据主张。', prompt: '你是 Critic（红队）。对交办的内容做对抗式审查：主动寻找漏洞、反例、未覆盖的场景、逻辑跳跃和无证据支撑的主张；默认怀疑，写不出具体触发/反例的疑点予以降级或剔除。区分「确证的问题」与「存疑」，给出可执行的反驳或修正建议。默认不改文件。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'red' },
  { id: 'synthesizer', label: 'Synthesizer', description: '把多个上游结果综合成连贯、结构化的成稿。', prompt: '你是 Synthesizer。把多个上游节点的结果综合成一份连贯、结构化的输出（报告/结论/文档）：合并重复、消解冲突、按主题组织、保留关键依据与出处。只依据上游【已确认】的内容，不引入未经核验的新主张；证据不足处如实标注。默认只产出文本，不改文件（需要落盘时按节点指派的工具面执行）。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'amber' },
  { id: 'analyst', label: 'Analyst', description: '分析数据/日志/指标，跑必要脚本，产出发现。', prompt: '你是 Analyst。对交办的数据、日志或指标做分析：必要时运行只读查询或脚本来统计、聚合、交叉验证；区分已验证的观察与推断，给出关键发现、异常点及其证据。不修改源数据；产出结论时说明口径与不确定性。', toolTier: 'exec', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'Bash'], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, color: 'indigo' },
]);

function normalizeAgentRole(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || raw.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!id) return null;
  const strArr = (value, max = 64) => [...new Set((Array.isArray(value) ? value : []).filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))].slice(0, max);
  const models0 = raw.models && typeof raw.models === 'object' ? raw.models : {};
  const budgets0 = raw.budgets && typeof raw.budgets === 'object' ? raw.budgets : {};
  const permissionMode = AGENT_ROLE_PERMISSION_MODES.includes(raw.permissionMode) ? raw.permissionMode : 'inherit';
  const role = {
    id,
    label: String(raw.label || raw.name || id).trim().slice(0, 80) || id,
    description: String(raw.description || '').trim().slice(0, 500),
    prompt: String(raw.prompt || raw.systemPrompt || '').trim().slice(0, 8000),
    toolTier: ['read', 'edit', 'exec'].includes(raw.toolTier) ? raw.toolTier : 'read',
    models: {
      openai: String(models0.openai != null ? models0.openai : (raw.openaiModel || '')).trim().slice(0, 160),
      claude: String(models0.claude != null ? models0.claude : (raw.claudeModel || 'inherit')).trim().slice(0, 160) || 'inherit',
    },
    openaiTools: strArr(raw.openaiTools || (raw.tools && raw.driver !== 'claude' ? raw.tools : []), 128),
    claudeTools: strArr(raw.claudeTools || (raw.driver === 'claude' ? raw.tools : []), 128),
    mcpServers: strArr(raw.mcpServers, 32),
    permissionMode,
    budgets: {
      openai: Math.min(300, Math.max(1, Math.round(Number(budgets0.openai != null ? budgets0.openai : (raw.maxIters || 100))) || 100)),
      claude: Math.min(300, Math.max(1, Math.round(Number(budgets0.claude != null ? budgets0.claude : (raw.maxTurns || 100))) || 100)),
    },
    isolation: raw.isolation === 'worktree' ? 'worktree' : 'none',
    color: String(raw.color || '').trim().slice(0, 32),
  };
  if (opts.source) role.source = opts.source;
  if (opts.builtin) role.builtin = true;
  return role;
}
function mergeAgentRole(base, override, source) {
  const merged = normalizeAgentRole({ ...base, ...override, models: { ...(base.models || {}), ...(override.models || {}) }, budgets: { ...(base.budgets || {}), ...(override.budgets || {}) } }, { source: source || override.source || base.source, builtin: !!base.builtin });
  if (merged && base.builtin) merged.builtin = true;
  return merged;
}

// Windows Explorer's "Copy as path" includes wrapping quotes. The picker already strips them for new UI
// input, but older configs can retain both C:\\x and "C:\\x" as distinct recent/favorite entries. Clean at
// the persistence boundary as well so every client and upgraded install converges on one canonical string.
// 117w-W1 提交②(27 号文 §11.19.2):workspaces[].note 的字数上限。备注是给管家的候选表投影用的
// 一句话标签(「股票资料」「客户合同」),不是说明文档 —— 80 字够写清楚,又不至于把到访层撑爆。
const WORKSPACE_NOTE_MAX = 80;
// 117w-W1④(27 号文 §11.19.8 债表第一行的裁决):workspaces[] 的行数上限。
// 20 是 UI 时代手工加文件夹的上限:那时表只会被人一行一行地敲进去,20 已经够多了。117w-W1②
// 起工作台【自己】会往表里追加行(省略 cwd 时在 Ruyi 根下派生子工作区并登记),表因此会自己长
// —— 20 那道帽子于是从「够用的上限」变成一把静默的刀:用户手上已有 20 个工作区时,派生出来的
// 那一行会在下一次 normalizeConfig 时被截掉,而目录已经建好、线程照跑,cwd 于是指向一个【表外】
// 目录,再拿它当 cwd 会被 13k 拒。「目录建了、行没了」是最坏的形状。
// 抬到 64 的两条理由:① 派生根在 ~/Ruyi 下,是 Ruyi 自己的地盘,在那里放宽是有意的;
// ② 06i 的 STEWARD_WORKSPACE_TABLE_MAX(候选表投影的行数上限)保持 20 不动 —— 表能长到 21..64
// 行之后,13o 那句「…另有 N 个工作区未列出」才在【生产形状】下可达、可测。
// 帽子只挡「表长到放不下」,不挡「派生」:13k 在派生【之前】自己算一次追加后会不会超帽,会超就
// fail-closed 拒开线程(见 13k stewardWorkspaceTableFull),绝不允许目录建了而行落不下。
const WORKSPACE_TABLE_CAP = 64;

// 第 121 波 K3(34 号文 §4.1/§4.2):任务索引「最近 N 条」窗口的缺省与钳位区间。三个数只有这一份,
// defaultConfig() 与下面的清洗块都读它们(stewardPollMs 那种「默认表与清洗块各写一遍字面量」的
// 写法是本仓的旧账,新键不再复制)。判据本体在 06i 的 threadVisible —— 它只收一个算好的布尔,
// N 在 13e 建索引时用(01 拼在 06i/13e 之前,数字放这里不制造任何前向边)。
const THREAD_INDEX_RECENT_DEFAULT = 30;
const THREAD_INDEX_RECENT_MIN = 10;
const THREAD_INDEX_RECENT_MAX = 200;

function normalizeWorkspacePathString(value) {
  let s = String(value == null ? '' : value).trim();
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (let guard = 0; guard < 3; guard++) {
    const pair = pairs.find(([open, close]) => s.length >= 2 && s.startsWith(open) && s.endsWith(close));
    if (!pair) break;
    s = s.slice(pair[0].length, s.length - pair[1].length).trim();
  }
  return s.slice(0, 1000);
}

// 123-N2:config.lastUsedEngineRoute 的【形状】清洗。见 normalizeConfig 里调用点上方那段头注 ——
// 语义判据(providerId 还在不在、CLI 还检得到吗)不在这里,那是 02 读侧的事。
// 参数名 rawRoute 而不是 raw/route:纪律 12(依赖图把裸参数名当跨模块符号,撞上更早模块的顶层
// 符号会凭空生出一条前向边并把本模块拽进 SCC)。
function sanitizeLastUsedEngineRoute(rawRoute) {
  if (!rawRoute || typeof rawRoute !== 'object' || Array.isArray(rawRoute)) return null;
  const model = String(rawRoute.model || '').trim().slice(0, 256);
  if (rawRoute.engine === 'openai') {
    const providerId = String(rawRoute.providerId || '').trim().slice(0, 128);
    return providerId ? { engine: 'openai', providerId, model } : null;
  }
  if (rawRoute.engine === 'agent' || rawRoute.engine === 'claude') {
    return { engine: 'agent', agentCliType: rawRoute.agentCliType === 'kimi' ? 'kimi' : 'claude', model };
  }
  return null;
}

// ── 128a(48 号文 §2):配置只落「改过的键」 ─────────────────────────────────────────────────────
// 修前 normalizeConfig 是 { ...defaultConfig(), ...raw },而任一次写盘都把【整份合并配置】落下去 ⇒ 装过一次的
// 机器上每个键都写着当年的默认值,此后产品改任何默认值,存量安装一个也吃不到(107-T1 只能靠一次性迁移补三个键;
// P1 又测出降级再升级会把用户关掉的开关重新打开)。现在:
//   · 显式键集合 configExplicitKeysV1 ＝ 被改过的键(经 mutateConfig 的写入里值变了的;读盘时盘上出现且不等于
//     当前默认的 —— 手改 config.json 与旧版本写下的整份配置都走这条);
//   · 落盘投影 ＝ 簿记键 ＋ 显式键 ＋ 本版不认识的键(更新的版本写下的键,降级时不能被我们抹掉);
//   · 迁移按显式键判:用户明确设过的键,schema 号被旧版写回去之后也不会再被迁移改掉。
// 内存视图照旧是整份(defaults ＋ 盘上),消费方零改动。
const CONFIG_BOOKKEEPING_KEYS = Object.freeze(['configSchema', 'version', 'configExplicitKeysV1']);
const CONFIG_EXPLICIT_KEY_MAX = 400;
// claudePath 的「用户给的值」:normalizeConfig 会把 npm shim 解析成真身 exe(下面 P1 那段),而落盘与「是否被改过」
// 都必须按用户给的原值判 —— 否则真身路径被写进盘,exe 以后消失时就回落不了 shim。Symbol 键:JSON 永不序列化它,
// 对象展开({ ...current })会带上它。
const CONFIG_GIVEN_CLAUDE_PATH = Symbol('configGivenClaudePath');
function configCanonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(configCanonicalJson).join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + configCanonicalJson(value[k])).join(',') + '}';
}
function configValueEquals(a, b) { return configCanonicalJson(a) === configCanonicalJson(b); }
function configExplicitKeysOf(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.configExplicitKeysV1) ? raw.configExplicitKeysV1 : [];
  return new Set(list.filter(k => typeof k === 'string' && k && k.length <= 120 && !CONFIG_BOOKKEEPING_KEYS.includes(k)));
}
// 「这个键此刻的值」—— 判是否被改过、以及落盘时用。唯一的特例是 claudePath(见 CONFIG_GIVEN_CLAUDE_PATH)。
function configComparableValue(config, key) {
  if (key === 'claudePath' && typeof config[CONFIG_GIVEN_CLAUDE_PATH] === 'string') return config[CONFIG_GIVEN_CLAUDE_PATH];
  return config[key];
}
// 落盘投影:唯一的写口(readConfig 的迁移回写、writeConfig)都写它。
function persistableConfig(config, base) {
  const explicit = new Set(Array.isArray(config.configExplicitKeysV1) ? config.configExplicitKeysV1 : []);
  const out = {};
  for (const key of Object.keys(config)) {
    if (CONFIG_BOOKKEEPING_KEYS.includes(key)) out[key] = config[key];
    else if (explicit.has(key) || !Object.prototype.hasOwnProperty.call(base, key)) out[key] = configComparableValue(config, key);
  }
  out.configSchema = CONFIG_SCHEMA;
  out.version = VERSION;
  return out;
}
function finalizeConfigExplicitKeys(config, explicit) {
  config.configExplicitKeysV1 = [...explicit]
    .filter(k => Object.prototype.hasOwnProperty.call(config, k) && !CONFIG_BOOKKEEPING_KEYS.includes(k))
    .sort()
    .slice(0, CONFIG_EXPLICIT_KEY_MAX);
}

// Fold older config files onto the current schema. Returns { config, changed, persisted }.
//   config    —— 整份内存视图(defaults ＋ 盘上),全部消费方读它;
//   persisted —— 该落盘的投影(128a);changed ＝ 投影与传进来的 raw 不同(＝该写盘)。
//   opts.inferExplicit(缺省 true):把 raw 里「不等于当前默认」的已知键记成显式 —— 读盘的语义。
//     writeConfig 传 false:它手上是整份内存视图,显式与否由它按「这次写入里值变了没有」自己判。
function normalizeConfig(raw, opts = {}) {
  const base = defaultConfig();
  const config = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const incomingConfigSchema = Number(raw && raw.configSchema) || 0;
  const rawExplicit = configExplicitKeysOf(raw);
  let changed = !raw || raw.configSchema !== CONFIG_SCHEMA;
  // P1(cmd8191 根治): npm shim(claude.cmd)→ 真身 claude.exe 的运行时解析(见 resolveClaudeLauncher)。
  // 收拢在这一个咽喉点 = 全部消费方(runClaudeTurn/子代理/mcp add-json/doctor)一致受益。不置 changed:
  // 解析是纯运行时升级,配置里保留用户原值,exe 消失时下一次解析自动回落 shim。结果 memoize,热路径零探测。
  // 128a:传进来的若是一份已经解析过的内存视图(它带着 CONFIG_GIVEN_CLAUDE_PATH),且 claudePath 没被改过
  // (仍等于原值的解析结果),原值沿用那份;否则 claudePath 本身就是新的原值。
  {
    const carried = raw && typeof raw === 'object' ? raw[CONFIG_GIVEN_CLAUDE_PATH] : undefined;
    const given = typeof carried === 'string' && config.claudePath === resolveClaudeLauncher(carried) ? carried : config.claudePath;
    config[CONFIG_GIVEN_CLAUDE_PATH] = given;
    config.claudePath = resolveClaudeLauncher(given);
  }
  if (!['claude', 'kimi'].includes(config.agentCliType)) {
    config.agentCliType = 'claude';
    changed = true;
  }
  // 123-N2:新线程缺省引擎的两个字段。
  if (!['last', 'global'].includes(config.newThreadEngine)) {
    config.newThreadEngine = 'last';
    changed = true;
  }
  {
    // 01 够不着 02 的 normalizeSessionEngineRoute(那是后面的模块,本仓是拼接单作用域但依赖图按
    // 声明序判前向边),所以这里只做【形状】清洗:非对象/野 engine/超长字符串一律回落 null。
    // 【语义】清洗仍在 02 的读侧(createSession 用 normalizeSessionEngineRoute 再过一遍),
    // 两边不一致时以 02 为准 —— 它才是回合路由的判据。写侧(02 rememberLastUsedEngineRoute)
    // 落盘前也已经过了同一个归一器,所以这一段在正常路径上是恒等的,它防的是手改配置文件。
    const clean = sanitizeLastUsedEngineRoute(config.lastUsedEngineRoute);
    if (JSON.stringify(clean) !== JSON.stringify(config.lastUsedEngineRoute ?? null)) {
      config.lastUsedEngineRoute = clean;
      changed = true;
    }
  }
  for (const key of ['kimiPath']) {
    if (typeof config[key] !== 'string') { config[key] = ''; changed = true; }
    else config[key] = config[key].trim().slice(0, 2000);
  }
  {
    const cleanDefaultWorkspace = normalizeWorkspacePathString(config.defaultWorkspace) || os.homedir();
    if (cleanDefaultWorkspace !== config.defaultWorkspace) { config.defaultWorkspace = cleanDefaultWorkspace; changed = true; }
  }
  // v2.6.0 initially exposed backend model ids copied from the old Claude endpoint history. Kimi Code's
  // native --model flag requires the configured alias key, which adds the managed-provider namespace.
  // Migrate only the four known official legacy values; arbitrary/custom aliases remain untouched.
  if (config.agentCliType === 'kimi' && ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k'].includes(config.model)) {
    config.model = `kimi-code/${config.model}`;
    changed = true;
  }
  // v1.4.3: accept CLI-native mode name 'bypassPermissions' as alias for 'bypass'
  if (PERMISSION_MODE_ALIASES[config.permissionMode]) {
    config.permissionMode = PERMISSION_MODE_ALIASES[config.permissionMode];
    changed = true;
  }
  if (!PERMISSION_MODES.includes(config.permissionMode)) {
    config.permissionMode = 'default';
    changed = true;
  }
  if (!['auto', 'zh-CN', 'en-US'].includes(config.locale)) {
    config.locale = 'auto';
    changed = true;
  }
  // Schema 9 makes interactive the effective default for upgraded installs too. Older configs could
  // indefinitely retain legacy/print even though new installs already defaulted to interactive, leaving the
  // composer advertising a steer action that the live CLI process could not accept. Migrate once; after the
  // schema stamp, a user may still explicitly switch back to legacy from Settings and that choice is retained.
  // 128a:显式设过 engineMode 的(configExplicitKeysV1 里有它)不迁 —— schema 号可能被旧版写回去过。
  if (incomingConfigSchema < 9 && !rawExplicit.has('engineMode') && ['legacy', 'print'].includes(config.engineMode)) {
    config.engineMode = 'interactive';
    changed = true;
  } else if (config.engineMode === 'print') {
    config.engineMode = 'legacy'; // tolerate the historical internal alias
    changed = true;
  } else if (!['legacy', 'interactive'].includes(config.engineMode)) {
    config.engineMode = 'interactive';
    changed = true;
  }
  // Only string args reach cp.spawn — filter out anything else (prevents a spawn TypeError/DoS and
  // stops a config-injection from smuggling non-string payloads).
  if (!Array.isArray(config.extraClaudeArgs) || config.extraClaudeArgs.some(a => typeof a !== 'string')) {
    config.extraClaudeArgs = Array.isArray(config.extraClaudeArgs) ? config.extraClaudeArgs.filter(a => typeof a === 'string') : [];
    changed = true;
  }
  // Claude CLI owns the concrete effort semantics. Keep the workbench value to the CLI's documented
  // enum so a malformed config can never turn into an invalid spawn argument.
  if (!CLAUDE_THINKING_EFFORTS.includes(config.claudeThinkingEffort)) {
    config.claudeThinkingEffort = '';
    changed = true;
  }
  // Clamp numeric timeouts to sane ranges (a non-numeric value must never disable the watchdog).
  const pt = Number(config.permissionTimeoutMs);
  config.permissionTimeoutMs = Number.isFinite(pt) && pt > 0 ? Math.min(600000, Math.max(5000, pt)) : 0;   // 0 = 不限时
  const qt = Number(config.questionTimeoutMs);
  config.questionTimeoutMs = Number.isFinite(qt) && qt > 0 ? Math.min(3600000, Math.max(60000, qt)) : 0;   // 0 = 不限时
  const it = Number(config.turnIdleTimeoutMs);
  config.turnIdleTimeoutMs = Number.isFinite(it) ? Math.min(3600000, Math.max(60000, it)) : 600000;
  const aw = Number(config.agentNodeWrapUpMs);
  config.agentNodeWrapUpMs = Number.isFinite(aw) ? (aw <= 0 ? 0 : Math.min(7200000, Math.max(60000, aw))) : 480000;
  // 第27f波:autonomyPauseOnTimeout 布尔(默认 false=安全默认);autonomyPauseTtlMs clamp [5min, 6h] 默认 45min。
  config.autonomyPauseOnTimeout = config.autonomyPauseOnTimeout === true;
  const apt = Number(config.autonomyPauseTtlMs);
  config.autonomyPauseTtlMs = Number.isFinite(apt) ? Math.min(6 * 3600000, Math.max(300000, apt)) : 2700000;
  // 第29波:monitorIncremental 默认 true(!==false 归一,纯传输优化);autonomyAutoResume 默认 false(===true
  // 归一,安全默认——boot 自动续跑消耗 token 且无人在场,必须显式开启)。
  config.monitorIncremental = config.monitorIncremental !== false;
  config.autonomyAutoResume = config.autonomyAutoResume === true;
  config.agentAutoModelTiering = config.agentAutoModelTiering === true; // 第30波:后端按 tier 兜底挑模型(opt-in,默认关)
  // v1.9 数据管家: 保留策略归一(逐项 clamp,见 normalizeStoragePolicy)。
  {
    const sp = normalizeStoragePolicy(config.storagePolicy);
    if (JSON.stringify(sp) !== JSON.stringify(config.storagePolicy)) { config.storagePolicy = sp; changed = true; }
    else config.storagePolicy = sp;
  }
  // Model lists must be arrays of strings; knownModels is capped so it can't grow unbounded.
  for (const k of ['knownModels', 'extraModels']) {
    if (!Array.isArray(config[k]) || config[k].some(a => typeof a !== 'string')) {
      config[k] = Array.isArray(config[k]) ? config[k].filter(a => typeof a === 'string') : [];
      changed = true;
    }
  }
  if (config.knownModels.length > 50) { config.knownModels = config.knownModels.slice(-50); changed = true; }
  if (typeof config.modelsApiBase !== 'string') { config.modelsApiBase = ''; changed = true; }
  else if (config.modelsApiBase.length > 500) { config.modelsApiBase = config.modelsApiBase.slice(0, 500); changed = true; }
  if (typeof config.modelsApiKey !== 'string') { config.modelsApiKey = ''; changed = true; }
  else if (config.modelsApiKey.length > 500) { config.modelsApiKey = config.modelsApiKey.slice(0, 500); changed = true; }
  // 107-S2 最后一道闸:走到这里还带着掩码的不是真值(能还原的 unmaskSecrets 已经还原,写口另有
  // maskedSecretConflicts 整份拒绝)。与 sanitizeProvider 的同名两个 helper 是同一条规则,清空而不是留着。
  if (configUrlOrCleared(config.modelsApiBase) !== config.modelsApiBase) { config.modelsApiBase = ''; changed = true; }
  if (configSecretValueOrCleared(config.modelsApiKey) !== config.modelsApiKey) { config.modelsApiKey = ''; changed = true; }
  if (!['auto', 'bearer', 'x-api-key'].includes(config.claudeAuthMode)) { config.claudeAuthMode = 'auto'; changed = true; }
  config.discoverModelsFromProxy = config.discoverModelsFromProxy !== false;
  config.killPortOnStart = config.killPortOnStart !== false;
  // v0.5: providers (native OpenAI-compatible engines). Sanitize each, drop malformed, dedupe by id, cap count.
  {
    const rawArr = Array.isArray(config.providers) ? config.providers : [];
    const seen = new Set();
    const clean = [];
    for (const p of rawArr) {
      const sp = sanitizeProvider(p);
      if (sp && !seen.has(sp.id)) { seen.add(sp.id); clean.push(sp); }
    }
    config.providers = clean.slice(0, 20);
    if (!Array.isArray(raw && raw.providers) || JSON.stringify(config.providers) !== JSON.stringify(raw.providers)) changed = true;
  }
  if (typeof config.activeProvider !== 'string') { config.activeProvider = ''; changed = true; }
  if (config.activeProvider && config.activeProvider !== 'claude-cli' && !config.providers.some(p => p.id === config.activeProvider)) {
    config.activeProvider = ''; changed = true;
  }
  // 114a(45 号文 §7): asrProviderId/asrModel —— 与 compactProviderId 同口径(下方 :914-925 那段):
  // 字符串形状消毒(trim + 截 400);指向的 provider 没了就清成「未配置」(两个都空 = 麦克风不可见),
  // 不静默改指别的端点。单有 asrModel 没有 asrProviderId 时保留原值(惰性,不构成「已配置」)。
  for (const key of ['asrProviderId', 'asrModel', 'asrStreamProviderId', 'asrStreamModel', 'asrFixProviderId', 'asrFixModel']) {
    const clean = typeof config[key] === 'string' ? config[key].trim().slice(0, 400) : '';
    if (clean !== config[key]) { config[key] = clean; changed = true; }
  }
  // 131b:句尾改错方式只认四个值;别的一律回 'auto'(缺省)。指着的大模型端点没了就清成「跟随主端点」。
  if (!['auto', 'audio', 'llm', 'off'].includes(config.asrFixMode)) { config.asrFixMode = 'auto'; changed = true; }
  if (config.asrFixProviderId && !config.providers.some(p => p && p.id === config.asrFixProviderId)) {
    config.asrFixProviderId = '';
    config.asrFixModel = '';
    changed = true;
  }
  if (config.asrProviderId && !config.providers.some(p => p && p.id === config.asrProviderId)) {
    config.asrProviderId = '';
    config.asrModel = '';
    changed = true;
  }
  // 130:实时识别那一对同一条清洗 —— 指着的服务商没了就清成「未配置」(麦克风退回按停顿切段那条路)。
  if (config.asrStreamProviderId && !config.providers.some(p => p && p.id === config.asrStreamProviderId)) {
    config.asrStreamProviderId = '';
    config.asrStreamModel = '';
    changed = true;
  }
  {
    const mi = Number(config.openaiMaxToolIterations);
    const clamped = Number.isFinite(mi) ? Math.min(200, Math.max(1, Math.round(mi))) : 100;
    if (clamped !== config.openaiMaxToolIterations) { config.openaiMaxToolIterations = clamped; changed = true; }
  }
  // v0.7d: desktopMcp — coerce field types; a malformed/absent value falls back to the enabled+autodetect default.
  {
    const raw0 = (config.desktopMcp && typeof config.desktopMcp === 'object') ? config.desktopMcp : {};
    const d = {
      enabled: raw0.enabled !== false,
      command: typeof raw0.command === 'string' ? raw0.command.slice(0, 1000) : '',
      args: Array.isArray(raw0.args) ? raw0.args.filter(a => typeof a === 'string').slice(0, 50) : [],
      cwd: typeof raw0.cwd === 'string' ? raw0.cwd.slice(0, 1000) : '',
      autodetect: raw0.autodetect !== false,
    };
    if (JSON.stringify(d) !== JSON.stringify(config.desktopMcp)) { config.desktopMcp = d; changed = true; }
    else config.desktopMcp = d;
  }
  {
    const raw0 = (config.browserAutomation && typeof config.browserAutomation === 'object' && !Array.isArray(config.browserAutomation)) ? config.browserAutomation : {};
    const modes = ['system', 'managed', 'custom', 'cdp', 'bundled'];
    const b = {
      mode: modes.includes(raw0.mode) ? raw0.mode : 'system',
      executable: typeof raw0.executable === 'string' ? raw0.executable.trim().slice(0, 1000) : '',
      cdpUrl: typeof raw0.cdpUrl === 'string' && raw0.cdpUrl.trim() ? raw0.cdpUrl.trim().slice(0, 1000) : 'http://127.0.0.1:9222',
    };
    if (JSON.stringify(b) !== JSON.stringify(config.browserAutomation)) { config.browserAutomation = b; changed = true; }
    else config.browserAutomation = b;
  }
  // v0.7d: externalMcpServers — sanitize each, drop malformed, dedupe by id, cap 10.
  {
    const rawArr = Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [];
    const seen = new Set();
    const clean = [];
    for (const s of rawArr) {
      const ss = sanitizeExternalMcpServer(s);
      if (ss && !seen.has(ss.id)) { seen.add(ss.id); clean.push(ss); }
    }
    config.externalMcpServers = clean.slice(0, 10);
    if (!Array.isArray(raw && raw.externalMcpServers) || JSON.stringify(config.externalMcpServers) !== JSON.stringify(raw.externalMcpServers)) changed = true;
  }
  // autoImportClaudeCodeMcp: 布尔,默认 true(显式 !== false 才为 true)。dismissedMcpIds: 字符串数组,去重 + 截 50。
  {
    const b = config.autoImportClaudeCodeMcp !== false;
    if (b !== config.autoImportClaudeCodeMcp) { config.autoImportClaudeCodeMcp = b; changed = true; }
    const rawArr = Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds : [];
    const seen = new Set(); const cleanIds = [];
    for (const x of rawArr) {
      const s = String(typeof x === 'string' ? x : (x && x.id) || '').trim().slice(0, 64);
      if (s && !seen.has(s)) { seen.add(s); cleanIds.push(s); }
    }
    config.dismissedMcpIds = cleanIds.slice(0, 50);
    if (!Array.isArray(raw && raw.dismissedMcpIds) || JSON.stringify(config.dismissedMcpIds) !== JSON.stringify(raw.dismissedMcpIds)) changed = true;
  }
  if (config.bridgeExternalToolsToProvider !== false) config.bridgeExternalToolsToProvider = true;
  else config.bridgeExternalToolsToProvider = false;
  if (!['auto', 'full'].includes(config.toolLoadingMode)) { config.toolLoadingMode = 'auto'; changed = true; }
  // Runtime-optimization flags accept only JSON booleans. A truthy string such as "true" must not silently
  // enable either shadow telemetry or active behavior in a hand-edited config file.
  for (const key of ['runtimeOptimizationShadowV1', 'runtimeToolRetrievalV1', 'runtimeObservationReducerV1', 'runtimeEvaporateBudgetBoundaryV1', 'runtimeHistoryReadDedupV1', 'runtimeSummaryPromptI18nV1', 'runtimeReseedTailUnitsV1', 'runtimeReseedReattachFilesV1', 'runtimeObservationRecallV1', 'runtimeSessionNotesV1', 'runtimeSummaryEntityCheckV1', 'runtimeSessionNotesInjectV1', 'runtimeSessionNotesMergeV1', 'runtimeEstimateBucketsV1', 'runtimeSummarySingleShotV1', 'runtimeSummaryFactTableV1', 'runtimeSummaryRefineV1', 'runtimeBudgetGuardV1', 'runtimeToolTimeBudgetShadowV1', 'runtimeToolTimeBudgetV1', 'runtimeVolatileTailLayoutV1', 'runtimeAppendOnlyToolSchemasV1', 'runtimeExecResultCacheV1', 'runtimeFailureTelemetryV1', 'runtimeMemoryVectorRecallV1', 'sessionSearchIndexV1', 'boundedReadSchedulerV1', 'metaToolHintsV1', 'actionArgumentModelViewV1']) {
    const b = config[key] === true;
    if (b !== config[key]) { config[key] = b; changed = true; }
  }
  // 107-T1(46 号文 §5): 126-111b/111d/111e 三个开关在 2.8.0 翻成默认开 —— 但【光翻 defaultConfig 没用】。
  // 上面 :591 是 { ...defaultConfig(), ...raw },raw 永远赢;而 readConfig 只要 changed 为真就把【整份
  // 合并后的配置】落盘,于是当年那批默认值被原样冻在盘上 —— 所有写过一次 config.json 的安装(= 全部
  // 存量用户)盘上都实打实写着 false,新默认一个也吃不到。故走 incomingConfigSchema 阶梯做一次性迁移。
  // 【必须写 = true,不能 delete】:delete 之后本函数这一趟返回的 config 里这三个键是 undefined,
  // 而判定函数一律是 `=== true` —— 当前这条命的进程里三个开关全是关的(要等下一次读配置才生效)。
  // 判据在 unit/config-schema-12-migration.test.js 的 [A],它断的是 === true,delete 当场红。
  // 放在严格布尔循环【之后】:非布尔脏值(比如字符串 "false")先被压成 false,再统一迁移。
  // 只迁一次 —— 落盘时 configSchema 被盖成 12(见下文 config.configSchema = CONFIG_SCHEMA),用户在
  // 2.8.0 之后自己关掉的那些,升级不会再动。
  // 128a(Brief §4.2 第 24 条,P1 实测):降级到 2.7.0 会把 configSchema 写回 11,回来时这道迁移又跑一遍,
  // 把用户在新版里显式关掉的开关重新打开。2.7.0 保留不认识的顶层键 ⇒ configExplicitKeysV1 活过降级,schema 号
  // 活不过 —— 所以按显式键判:在集合里的键是用户明确设过的,不迁。
  if (incomingConfigSchema < 12) {
    for (const key of ['runtimeHistoryReadDedupV1', 'runtimeSummaryPromptI18nV1', 'runtimeReseedTailUnitsV1']) {
      if (config[key] === false && !rawExplicit.has(key)) { config[key] = true; changed = true; }
    }
  }
  { // 105f: 单发估算上限 —— JSON number,clamp [8192, 131072],缺省 32768(与 rules singleShotCap 同界)。
    const n = Number(config.summarySingleShotMaxTokensV1);
    const clamped = Number.isFinite(n) ? Math.min(131072, Math.max(8192, Math.round(n))) : 32768;
    if (clamped !== config.summarySingleShotMaxTokensV1) { config.summarySingleShotMaxTokensV1 = clamped; changed = true; }
    // 覆盖表:{ "providerId" | "providerId/model" | "style:chat|responses" → tokens };非法键/值整条丢弃,
    // 坏覆盖绝不静默放宽上限。
    const rawOv = (config.summarySingleShotMaxOverridesV1 && typeof config.summarySingleShotMaxOverridesV1 === 'object' && !Array.isArray(config.summarySingleShotMaxOverridesV1)) ? config.summarySingleShotMaxOverridesV1 : {};
    const cleanOv = {};
    for (const [k, v] of Object.entries(rawOv)) {
      const key = String(k || '').trim().slice(0, 160);
      const val = Number(v);
      if (key && Number.isFinite(val)) cleanOv[key] = Math.min(131072, Math.max(8192, Math.round(val)));
    }
    if (JSON.stringify(cleanOv) !== JSON.stringify(config.summarySingleShotMaxOverridesV1)) { config.summarySingleShotMaxOverridesV1 = cleanOv; changed = true; }
  }
  { // 105g: 事实表条数上限 —— JSON number,clamp [4,64],缺省 64;坏值不放宽请求体。
    const n = Number(config.summaryFactTableMaxSamplesV1);
    const clamped = Number.isFinite(n) ? Math.min(64, Math.max(4, Math.round(n))) : 64;
    if (clamped !== config.summaryFactTableMaxSamplesV1) { config.summaryFactTableMaxSamplesV1 = clamped; changed = true; }
  }
  { // 106 #13a: 回合 token 预算 —— 0 = 不设(不开门);非零钳位 [1, 10000000];坏值落回 0(关门),
    // 绝不因手抖配置静默放宽。warn 比例钳位 [0.1, 0.99],缺省 0.8。
    const n = Number(config.budgetGuardTurnTokensV1);
    const clamped = Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(10000000, Math.round(n))) : 0;
    if (clamped !== config.budgetGuardTurnTokensV1) { config.budgetGuardTurnTokensV1 = clamped; changed = true; }
    const r = Number(config.budgetGuardWarnRatioV1);
    const rc = Number.isFinite(r) ? Math.min(0.99, Math.max(0.1, r)) : 0.8;
    if (rc !== config.budgetGuardWarnRatioV1) { config.budgetGuardWarnRatioV1 = rc; changed = true; }
  }
  { // 106 #13a-t: 工具时间预算毫秒 —— 0 = 该级关闭;非零时 warn 钳位 [1000, 3600000]、
    // hard 钳位 [5000, 7200000];坏值落回 0(该级关闭)。字节计数阈值 0 = 不计数,上限 100MB。
    const w = Number(config.toolTimeBudgetWarnMsV1);
    const wc = Number.isFinite(w) ? (w <= 0 ? 0 : Math.min(3600000, Math.max(1000, Math.round(w)))) : 0;
    if (wc !== config.toolTimeBudgetWarnMsV1) { config.toolTimeBudgetWarnMsV1 = wc; changed = true; }
    const h = Number(config.toolTimeBudgetHardMsV1);
    const hc = Number.isFinite(h) ? (h <= 0 ? 0 : Math.min(7200000, Math.max(5000, Math.round(h)))) : 0;
    if (hc !== config.toolTimeBudgetHardMsV1) { config.toolTimeBudgetHardMsV1 = hc; changed = true; }
    const b = Number(config.toolByteBudgetShadowBytesV1);
    const bc = Number.isFinite(b) ? (b <= 0 ? 0 : Math.min(104857600, Math.round(b))) : 0;
    if (bc !== config.toolByteBudgetShadowBytesV1) { config.toolByteBudgetShadowBytesV1 = bc; changed = true; }
  }
  { // 113a-后续(2026-09-04 用户拍板): 记忆容量五旋钮统一钳位。坏值/非数字一律落回默认。
    const clampInt = (value, lo, hi, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
    };
    for (const [key, lo, hi, fallback] of [
      ['coreMemoryMaxItemsV1', 0, 2000, 200],
      ['coreMemoryCharBudgetV1', 0, 200000, 16000],
      ['memoryRelevanceMaxV1', 0, 64, 8],
      ['memoryFixedSelectionMaxV1', 1, 1024, 64],
      ['memoryIndexCharCapV1', 500, 100000, 6000],
    ]) {
      const next = clampInt(config[key], lo, hi, fallback);
      if (next !== config[key]) { config[key] = next; changed = true; }
    }
  }
  { // 106 #2a: 执行结果缓存每会话条数上限 —— 0 = 不缓存;钳位 [0, 2000],坏值落回默认 200。
    const n = Number(config.execResultCacheMaxEntriesV1);
    const nc = Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(2000, Math.round(n))) : 200;
    if (nc !== config.execResultCacheMaxEntriesV1) { config.execResultCacheMaxEntriesV1 = nc; changed = true; }
  }
  { // 21-E2: bounded read concurrency — JSON number, clamp 1..8.
    const n = Number(config.boundedReadConcurrencyV1);
    const clamped = Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 4;
    if (clamped !== config.boundedReadConcurrencyV1) { config.boundedReadConcurrencyV1 = clamped; changed = true; }
  }
  {
    const ttl = Number(config.toolCatalogCacheTtlMs);
    const clamped = Number.isFinite(ttl) ? Math.min(600000, Math.max(5000, Math.round(ttl))) : 60000;
    if (clamped !== config.toolCatalogCacheTtlMs) { config.toolCatalogCacheTtlMs = clamped; changed = true; }
  }
  // toolbox:形状清洗。id 只认登记约定里的那个字符集,各自去重、封顶 50。
  {
    const raw0 = (config.toolbox && typeof config.toolbox === 'object' && !Array.isArray(config.toolbox)) ? config.toolbox : {};
    const ids = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x || '')).filter(x => /^[a-z0-9][a-z0-9-]{0,39}$/.test(x)))].slice(0, 50);
    const tb = { autoDiscover: raw0.autoDiscover !== false, disabled: ids(raw0.disabled), seen: ids(raw0.seen) };
    if (JSON.stringify(tb) !== JSON.stringify(config.toolbox)) { config.toolbox = tb; changed = true; }
    else config.toolbox = tb;
  }
  // v1.1-W2 (T2): enableMcpDropIn — boolean, default true unless explicitly false (mirror bridge switch).
  { const b = config.enableMcpDropIn !== false; if (b !== config.enableMcpDropIn) { config.enableMcpDropIn = b; changed = true; } }
  // v0.8-S0: bridgedToolTiers — object of {unprefixedToolName: 'read'|'edit'|'exec'}. Drop any non-object
  // input and any entry whose value isn't a valid tier (a bad override must never widen permissions silently).
  {
    const raw0 = (config.bridgedToolTiers && typeof config.bridgedToolTiers === 'object' && !Array.isArray(config.bridgedToolTiers)) ? config.bridgedToolTiers : {};
    const clean = {};
    for (const [k, v] of Object.entries(raw0)) {
      if (typeof k === 'string' && k && (v === 'read' || v === 'edit' || v === 'exec')) clean[k] = v;
    }
    if (JSON.stringify(clean) !== JSON.stringify(config.bridgedToolTiers)) { config.bridgedToolTiers = clean; changed = true; }
    else config.bridgedToolTiers = clean;
  }
  // v0.8-S2: shellSessionMax — concurrency cap for persistent shell sessions. Clamp 1..8; a non-numeric
  // value must never disable the cap (defaults to 3).
  {
    const sm = Number(config.shellSessionMax);
    const clamped = Number.isFinite(sm) ? Math.min(8, Math.max(1, Math.round(sm))) : 3;
    if (clamped !== config.shellSessionMax) { config.shellSessionMax = clamped; changed = true; }
  }
  // v0.8-S4b: toolAllowRules — {nativeToolName:'allow'} persistent fine-grained allowlist. HARD cleanse:
  //  - value must be exactly 'allow';
  //  - the tool's NATIVE tier must be 'read' or 'edit' — exec/desktop tools are NEVER persistable (a
  //    persistent auto-allow on powershell_run / a desktop action is exactly the class of blanket grant
  //    this feature must not enable; those get session-scoped allow in the front-end only).
  // Any entry failing either check is dropped silently (a bad rule must never widen permissions).
  {
    const raw0 = (config.toolAllowRules && typeof config.toolAllowRules === 'object' && !Array.isArray(config.toolAllowRules)) ? config.toolAllowRules : {};
    const clean = {};
    for (const [k, v] of Object.entries(raw0)) {
      if (typeof k !== 'string' || !k || v !== 'allow') continue;
      const tier = nativeToolTier(k);
      if (tier === 'read' || tier === 'edit') clean[k] = 'allow';
    }
    if (JSON.stringify(clean) !== JSON.stringify(config.toolAllowRules)) { config.toolAllowRules = clean; changed = true; }
    else config.toolAllowRules = clean;
  }
  // v0.8-S5: autoCompactThreshold — fraction of the context window that triggers auto-compaction. Clamp
  // 0.5..0.95; a non-numeric value must never disable compaction (defaults to 0.8).
  {
    const at = Number(config.autoCompactThreshold);
    const clamped = Number.isFinite(at) ? Math.min(0.95, Math.max(0.5, at)) : 0.8;
    if (clamped !== config.autoCompactThreshold) { config.autoCompactThreshold = clamped; changed = true; }
  }
  // Persist the meter's manual limits for server-side auto-compaction. Zero explicitly selects Auto.
  {
    const raw = config.contextWindowOverrides;
    const clean = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw).slice(-200)) {
        let route; try { route = JSON.parse(key); } catch { continue; }
        if (!Array.isArray(route) || route.length !== 3 || !['agent', 'openai'].includes(route[0])
          || route.some(v => typeof v !== 'string' || v.length > 400) || !route[1]) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
        clean[JSON.stringify(route)] = value === 0 ? 0 : Math.round(Math.min(2000000, Math.max(8000, value)));
      }
    }
    if (JSON.stringify(raw) !== JSON.stringify(clean)) changed = true;
    config.contextWindowOverrides = clean;
  }
  // The selected compactor is deliberately independent from activeProvider/model so switching chat
  // engines does not silently change a user's preferred local summarizer. Missing providers are retained
  // as an empty/default selection instead of guessing another endpoint.
  for (const key of ['compactProviderId', 'compactModel']) {
    const clean = typeof config[key] === 'string' ? config[key].trim().slice(0, 400) : '';
    if (clean !== config[key]) { config[key] = clean; changed = true; }
  }
  if (config.compactProviderId && !(config.providers || []).some(p => p && p.id === config.compactProviderId)) {
    config.compactProviderId = '';
    config.compactModel = '';
    changed = true;
  }
  // v0.8-S6: capabilityProbeUrl — string; trim + cap length. A non-string coerces to '' (probe the active
  // provider's baseUrl instead). No scheme validation here: getCapabilities guards the HEAD fetch itself.
  {
    const raw0 = typeof config.capabilityProbeUrl === 'string' ? config.capabilityProbeUrl.trim().slice(0, 400) : '';
    if (raw0 !== config.capabilityProbeUrl) { config.capabilityProbeUrl = raw0; changed = true; }
  }
  { const b = config.enableToolRequiresProbe === true; if (b !== config.enableToolRequiresProbe) { config.enableToolRequiresProbe = b; changed = true; } }
  // v0.9-S1 (C1): uiMode / outputStyle — cleanse to their enums. An unknown value falls back to the
  // default ('simple' / 'detailed') so a corrupt config can never leave the UI in an undefined density/style.
  // 第36波(v1.7): uiMode 回退值与 defaultConfig 对齐('simple' = 人人可用面是产品默认;此前回退 'pro' 与
  // defaultConfig 的 'simple' 两处默认不一致,损坏配置会把普通用户扔进开发者面)。
  { const v = (config.uiMode === 'simple' || config.uiMode === 'pro') ? config.uiMode : 'simple'; if (v !== config.uiMode) { config.uiMode = v; changed = true; } }
  { const v = (config.outputStyle === 'concise' || config.outputStyle === 'detailed') ? config.outputStyle : 'detailed'; if (v !== config.outputStyle) { config.outputStyle = v; changed = true; } }
  // Resident skills are a small, source-locked global set. Existence and capability are checked against
  // the current workspace registry at use time; normalization only protects the config shape.
  {
    const rawArr = Array.isArray(config.residentSkills) ? config.residentSkills : [];
    const seen = new Set(), clean = [];
    for (const rawSkill of rawArr) {
      const id = String(typeof rawSkill === 'string' ? rawSkill : (rawSkill && rawSkill.id) || '').trim();
      const source = String(typeof rawSkill === 'object' && rawSkill ? rawSkill.source || '' : '').trim();
      if (!SKILL_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id); clean.push({ id, source: ['builtin', 'user', 'project'].includes(source) ? source : '' });
      if (clean.length >= 8) break;
    }
    if (JSON.stringify(clean) !== JSON.stringify(config.residentSkills)) { config.residentSkills = clean; changed = true; }
    else config.residentSkills = clean;
  }
  // v0.9-S3 (C3): recentWorkspaces — de-duped array of non-empty absolute-path strings, ≤10 (LRU: the
  // front is most-recent). Drop non-strings/empties; a duplicate (case-insensitive) keeps only the first
  // occurrence (so the front-inserted entry wins). A non-array coerces to []. Never widens anything.
  {
    const rawArr = Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [];
    const seen = new Set();
    const clean = [];
    for (const w of rawArr) {
      if (typeof w !== 'string') continue;
      const s = normalizeWorkspacePathString(w);
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(s);
      if (clean.length >= 10) break;
    }
    if (JSON.stringify(clean) !== JSON.stringify(config.recentWorkspaces)) { config.recentWorkspaces = clean; changed = true; }
    else config.recentWorkspaces = clean;
  }
  // 118a: onboarding, the welcome-wizard completion record. Additive default null; any non-object (or array)
  // collapses back to null. A written record is cleansed to exactly three fields so a hand-edited config
  // cannot smuggle extra keys into the UI. Fields: completedAt (trimmed ISO-ish string or null), version (integer
  // 0..1000) and skipped (strict boolean). Nothing here widens behavior: the record only decides whether
  // the wizard offers itself again.
  {
    const rawOnboarding = config.onboarding;
    let clean = null;
    if (rawOnboarding && typeof rawOnboarding === 'object' && !Array.isArray(rawOnboarding)) {
      const completedAtRaw = typeof rawOnboarding.completedAt === 'string' ? rawOnboarding.completedAt.trim() : '';
      const versionNumber = Number(rawOnboarding.version);
      clean = {
        completedAt: completedAtRaw ? completedAtRaw.slice(0, 64) : null,
        version: Number.isFinite(versionNumber) ? Math.max(0, Math.min(1000, Math.round(versionNumber))) : 0,
        skipped: rawOnboarding.skipped === true,
      };
    }
    if (JSON.stringify(clean) !== JSON.stringify(config.onboarding)) { config.onboarding = clean; changed = true; }
    else config.onboarding = clean;
  }
  // v2.7 (workspace permissions): workspaces — priority-ordered array of {path, read, write, execute}; all
  // flags default true (read !== false / write !== false / execute !== false). One-time seed (schema < 10)
  // from defaultWorkspace + recentWorkspaces so an existing install keeps read/write/execute on every folder
  // it already trusts. Cleanse: trimmed string path (≤1000), boolean flags, case-insensitive de-dupe,
  // capped at WORKSPACE_TABLE_CAP rows (117w-W1④ raised it 20 -> 64; see that constant for why).
  // defaultWorkspace is kept in sync with the highest-priority (first) workspace for backward compat.
  {
    const rawArr = Array.isArray(config.workspaces) ? config.workspaces : [];
    const seen = new Set();
    const clean = [];
    const pushWs = (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const p = normalizeWorkspacePathString(raw.path);
      if (!p) return;
      const key = p.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const entry = { path: p, read: raw.read !== false, write: raw.write !== false, execute: raw.execute !== false };
      // 117w-W1 提交②(§11.19.2):可选备注 —— 用户在设置里给工作区写一句「股票资料」之类,管家的
      // 候选表投影按「末段名 + 备注」渲染(见 13o stewardWorkspaceTableBlock)。空/非字符串一律【不写字段】
      // (缺省不写而不是写空串:老配置逐字节不变,JSON.stringify 比较不会因为多一个 "" 就判成 changed)。
      const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, WORKSPACE_NOTE_MAX) : '';
      if (note) entry.note = note;
      clean.push(entry);
    };
    for (const e of rawArr) { pushWs(e); if (clean.length >= WORKSPACE_TABLE_CAP) break; }
    if (!clean.length && incomingConfigSchema < 10) {
      const seed = [];
      if (typeof config.defaultWorkspace === 'string' && config.defaultWorkspace.trim()) seed.push(config.defaultWorkspace);
      for (const w of (Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) if (typeof w === 'string') seed.push(w);
      for (const s of seed) { pushWs({ path: s }); if (clean.length >= WORKSPACE_TABLE_CAP) break; }
    }
    if (JSON.stringify(clean) !== JSON.stringify(config.workspaces)) { config.workspaces = clean; changed = true; }
    else config.workspaces = clean;
    const primary = clean.length ? clean[0].path : (typeof config.defaultWorkspace === 'string' && config.defaultWorkspace.trim() ? config.defaultWorkspace : os.homedir());
    if (config.defaultWorkspace !== primary) { config.defaultWorkspace = primary; changed = true; }
    const ab = config.allowOutsideWorkspace === true;
    if (ab !== config.allowOutsideWorkspace) { config.allowOutsideWorkspace = ab; changed = true; }
    // 117w-W1 提交②(§11.19.2):Ruyi 根。清洗与 defaultWorkspace 同一口径(剥「复制为路径」的引号 +
    // trim + 截 1000),外加两条:必须是【绝对路径】(相对路径会被 path.resolve 按服务进程的 cwd 补全,
    // 那是一条无声的越权路),空/非绝对一律回落出厂默认 ~/Ruyi。这里【不】做 path.resolve —— 与
    // normalizeWorkspacePathString 处理 workspaces[].path 时同形(表里存的就是用户敲进去的原样),
    // resolve 由消费侧(13k stewardCanonWorkspacePath)统一补。
    const rootRaw = normalizeWorkspacePathString(config.stewardWorkspaceRoot);
    const root = (rootRaw && path.isAbsolute(rootRaw)) ? rootRaw : path.join(os.homedir(), 'Ruyi');
    if (root !== config.stewardWorkspaceRoot) { config.stewardWorkspaceRoot = root; changed = true; }
  }
  // Sub-agent limits: concurrency is configurable but bounded; total 0 disables the feature.
  // v1.4.4: fallback defaults raised to the top of each range (8 / 32) — see defaultConfig() note.
  {
    const sc = Number(config.subagentMaxConcurrent);
    const clamped = Number.isFinite(sc) ? Math.min(8, Math.max(1, Math.round(sc))) : 8;
    if (clamped !== config.subagentMaxConcurrent) { config.subagentMaxConcurrent = clamped; changed = true; }
  }
  {
    let sm = Number(config.subagentMaxPerTurn);
    // 第23波: 一次性迁移旧默认 4 → 新默认 32(v1.4.4 已把默认调到 32,但存量配置里的 4 从不被上调,导致回合内多代理
    // 扇出/编排被卡在 4)。仅迁移【恰为旧默认 4】的值;显式设成别的低值(1/2/3)视为用户有意,不动。flag 防重复迁移
    // (置位后用户再设 4 会被尊重)。上限从 32 放宽到 64。
    if (config.subagentBudgetMigrated !== true && sm === 4) sm = 32;
    const clamped = Number.isFinite(sm) ? Math.min(64, Math.max(0, Math.round(sm))) : 32;
    if (clamped !== config.subagentMaxPerTurn) { config.subagentMaxPerTurn = clamped; changed = true; }
  }
  if (config.subagentBudgetMigrated !== true) { config.subagentBudgetMigrated = true; changed = true; }
  // 52x: 子 agent 优先端点+模型规范化(字符串 trim + 长度截断,与 UI 保存口径一致)
  {
    const sp = String(config.subagentPreferredProvider || '').trim().slice(0, 120);
    if (sp !== config.subagentPreferredProvider) { config.subagentPreferredProvider = sp; changed = true; }
    const sm = String(config.subagentPreferredModel || '').trim().slice(0, 160);
    if (sm !== config.subagentPreferredModel) { config.subagentPreferredModel = sm; changed = true; }
  }
  // 第 116 波 116a(27 号文 §11.3):管家总开关,严格布尔(=== true),防手改配置文件把垃圾值当成开(121 波 K0 只改默认值,不改这条归一)。
  {
    const b = config.stewardEnabledV1 === true;
    if (b !== config.stewardEnabledV1) { config.stewardEnabledV1 = b; changed = true; }
  }
  // 第 116 波 116a(27 号文 §11.3):管家专用端点/模型,规范化口径与 subagentPreferredProvider/Model 一致
  // (trim + 截断),空值="跟随主端点"。
  {
    const sp = String(config.stewardProviderId || '').trim().slice(0, 120);
    if (sp !== config.stewardProviderId) { config.stewardProviderId = sp; changed = true; }
    const sm = String(config.stewardModel || '').trim().slice(0, 160);
    if (sm !== config.stewardModel) { config.stewardModel = sm; changed = true; }
  }
  // 第 116 波 116-5a(27 号文 §11.8):线程自动摘要开关。它一直默认【开】(121 波 K0 后总开关也默认开,
  // 但两者的严格布尔方向仍相反):只有显式写 false 才算关(!== false),别的垃圾值一律归一成 true ——
  // 这样手改坏了配置文件不会静默丢掉一个默认开的能力。
  {
    const b = config.stewardThreadBriefV1 !== false;
    if (b !== config.stewardThreadBriefV1) { config.stewardThreadBriefV1 = b; changed = true; }
  }
  // 第 127 波 2-quater B2:代批开关。默认开,与 stewardThreadBriefV1 同方向的严格布尔(!== false):只有显式写
  // false 才算关,垃圾值一律归一成 true —— 规范化之后恒为布尔,13l 那一侧按 === true 判(读到非布尔就当关,fail-closed)。
  {
    const b = config.stewardExemptDelegationV1 !== false;
    if (b !== config.stewardExemptDelegationV1) { config.stewardExemptDelegationV1 = b; changed = true; }
  }
  // 第 117 波 117l(27 号文 §11.9 D7):新开线程的两档端点/模型。形状归一 —— 缺键补空、非对象整体回默认、
  // 未知键丢弃;providerId ≤120、model ≤160(与 stewardProviderId/stewardModel 同一口径),两者都 trim。
  // 这里【不】校验 provider 是否真的存在:设置页可能先配 id 后建端点,存在性由 06i 的
  // stewardThreadEngineRoute 在用的那一刻判(不存在就回落全局并记一条审计),不在这里静默清空用户输入。
  {
    const DEF_TM = { strong: { providerId: '', model: '' }, fast: { providerId: '', model: '' } };
    const rawTm = (config.stewardThreadModels && typeof config.stewardThreadModels === 'object' && !Array.isArray(config.stewardThreadModels)) ? config.stewardThreadModels : null;
    const slot = raw => {
      const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
      return { providerId: String(s.providerId || '').trim().slice(0, 120), model: String(s.model || '').trim().slice(0, 160) };
    };
    const tm = rawTm ? { strong: slot(rawTm.strong), fast: slot(rawTm.fast) } : { ...DEF_TM };
    if (JSON.stringify(tm) !== JSON.stringify(config.stewardThreadModels)) { config.stewardThreadModels = tm; changed = true; }
    else config.stewardThreadModels = tm;
  }
  // 第 116 波 116a(27 号文 §11.3):管家收件箱轮询间隔(ms),非法值(非有限数)回默认 15000,clamp [5000,120000]。
  {
    const n = Number(config.stewardPollMs);
    const clamped = Number.isFinite(n) ? Math.min(120000, Math.max(5000, Math.round(n))) : 15000;
    if (clamped !== config.stewardPollMs) { config.stewardPollMs = clamped; changed = true; }
  }
  // 第 121 波 K3(34 号文 §4.1):任务索引「最近 N 条」窗口,非法值(非有限数)回默认 30,
  // clamp [10,200]。三个数都取自上面那组常量,不在这里重写字面量。
  {
    const n = Number(config.threadIndexRecent);
    const clamped = Number.isFinite(n)
      ? Math.min(THREAD_INDEX_RECENT_MAX, Math.max(THREAD_INDEX_RECENT_MIN, Math.round(n)))
      : THREAD_INDEX_RECENT_DEFAULT;
    if (clamped !== config.threadIndexRecent) { config.threadIndexRecent = clamped; changed = true; }
  }
  // 第 116 波 116a(27 号文 §11.3):管家每小时最多替用户执行的回合数,clamp [1,120],非法回默认 30
  // (117m-A1 把默认值 12 → 30,这里的兜底值与默认表同步;clamp 区间一字未动)。
  {
    const n = Number(config.stewardMaxTurnsPerHour);
    const clamped = Number.isFinite(n) ? Math.min(120, Math.max(1, Math.round(n))) : 30;
    if (clamped !== config.stewardMaxTurnsPerHour) { config.stewardMaxTurnsPerHour = clamped; changed = true; }
  }
  // 第 116 波 116a(27 号文 §11.3):管家自身每日花费上限(USD),clamp [0,1000],非法回默认 1(允许小数,不取整)。
  {
    const n = Number(config.stewardMaxCostPerDay);
    const clamped = Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : 1;
    if (clamped !== config.stewardMaxCostPerDay) { config.stewardMaxCostPerDay = clamped; changed = true; }
  }
  // 第 116 波 116a(27 号文 §11.3):管家「可以自己做的事」自理清单——retry/relay/newThread/answer 严格布尔
  // (非布尔值回该键自身默认);resume 三态 true/false/null(null=跟随 autonomyAutoResume,非三态值回 null);
  // 未知键丢弃;整体非对象回全部默认。
  // 129g(31 号文 §2.5):answer =「线程停下来问用户话时,管家替他答」。**默认关**,而且是独立一格 ——
  // 修前它搭在 relay 上:用户勾「事项内自动交接」是要让上一条线程的结论流到下一条,顺带却把
  // 「替我回答」也给了出去。一格两权,用户按的时候看不出第二个。
  {
    const DEF_AA = { retry: true, resume: null, relay: true, newThread: true, answer: false };   // 136:relay 默认开,与默认表同值(两处必须同值,否则缺省与填垃圾落到不同行为)
    const raw0 = (config.stewardAutoActions && typeof config.stewardAutoActions === 'object' && !Array.isArray(config.stewardAutoActions)) ? config.stewardAutoActions : null;
    const aa = raw0 ? {
      retry: typeof raw0.retry === 'boolean' ? raw0.retry : DEF_AA.retry,
      resume: (raw0.resume === true || raw0.resume === false || raw0.resume === null) ? raw0.resume : DEF_AA.resume,
      relay: typeof raw0.relay === 'boolean' ? raw0.relay : DEF_AA.relay,
      newThread: typeof raw0.newThread === 'boolean' ? raw0.newThread : DEF_AA.newThread,
      answer: typeof raw0.answer === 'boolean' ? raw0.answer : DEF_AA.answer,
    } : { ...DEF_AA };
    if (JSON.stringify(aa) !== JSON.stringify(config.stewardAutoActions)) { config.stewardAutoActions = aa; changed = true; }
    else config.stewardAutoActions = aa;
  }
  // 第 116 波 116a(27 号文 §11.3):一次到访内管家上下文预算(token),clamp [16000,2000000],非法回默认 200000。
  {
    const n = Number(config.stewardContextBudgetTokens);
    const clamped = Number.isFinite(n) ? Math.min(2000000, Math.max(16000, Math.round(n))) : 200000;
    if (clamped !== config.stewardContextBudgetTokens) { config.stewardContextBudgetTokens = clamped; changed = true; }
  }
  // 136(用户 2026-09-23「上下文太紧」):压缩触发线系数,clamp [0.3,0.95],非法回默认 0.6
  // (允许小数、不取整 —— 0.65 是合法值;与 stewardMaxCostPerDay 同一口径)。
  {
    const n = Number(config.stewardContextBudgetRatio);
    const clamped = Number.isFinite(n) ? Math.min(0.95, Math.max(0.3, n)) : 0.6;
    if (clamped !== config.stewardContextBudgetRatio) { config.stewardContextBudgetRatio = clamped; changed = true; }
  }
  // 第 116 波 116a(27 号文 §11.3):管家按需深读(steward_thread_read 等)单次到访合计字符预算,clamp [4000,400000],
  // 非法回默认 48000。
  {
    const n = Number(config.stewardReadBudgetChars);
    const clamped = Number.isFinite(n) ? Math.min(400000, Math.max(4000, Math.round(n))) : 48000;
    if (clamped !== config.stewardReadBudgetChars) { config.stewardReadBudgetChars = clamped; changed = true; }
  }
  {
    // 129f:一小时叫人次数上限。1..60 —— 0 不是「不叫」(那是通知总开关的事),下限 1 才讲得通。
    const n = Number(config.stewardNotifyPerHour);
    const clamped = Number.isFinite(n) ? Math.min(60, Math.max(1, Math.round(n))) : 6;
    if (clamped !== config.stewardNotifyPerHour) { config.stewardNotifyPerHour = clamped; changed = true; }
  }
  // 第 116 波 116a(27 号文 §11.3):判定「一次到访」结束的静默分钟数,clamp [5,1440],非法回默认 60。
  {
    const n = Number(config.stewardVisitIdleMinutes);
    const clamped = Number.isFinite(n) ? Math.min(1440, Math.max(5, Math.round(n))) : 60;
    if (clamped !== config.stewardVisitIdleMinutes) { config.stewardVisitIdleMinutes = clamped; changed = true; }
  }
  // 第 123 波 M2(37 号文 §3.5):安静卡「稍后」的推迟分钟数,clamp [1,1440],非法回默认 30。
  {
    const n = Number(config.quietCardSnoozeMinutes);
    const clamped = Number.isFinite(n) ? Math.min(1440, Math.max(1, Math.round(n))) : 30;
    if (clamped !== config.quietCardSnoozeMinutes) { config.quietCardSnoozeMinutes = clamped; changed = true; }
  }
  // 第 116 波 116a(27 号文 §11.3):管家会话历史保留策略,枚举 visit|24h|forever,非法回默认。
  // 136:默认 visit → 24h,兜底同步改(两处必须同一个值,否则缺省与填垃圾落到不同策略)。
  {
    const norm = ['visit', '24h', 'forever'].includes(config.stewardConversationRetention) ? config.stewardConversationRetention : '24h';
    if (norm !== config.stewardConversationRetention) { config.stewardConversationRetention = norm; changed = true; }
  }
  // 136(用户 2026-09-23「言行不够拟人」):管家人设两个字符串键 —— trim + 上限截断(名字 20 字 /
  // 口吻 200 字),与 stewardModel 同一口径(非字符串先 String(),未知类型不留原值)。
  {
    const name = String(config.stewardPersonaName || '').trim().slice(0, 20);
    if (name !== config.stewardPersonaName) { config.stewardPersonaName = name; changed = true; }
    const style = String(config.stewardPersonaStyle || '').trim().slice(0, 200);
    if (style !== config.stewardPersonaStyle) { config.stewardPersonaStyle = style; changed = true; }
  }
  // 第 116 波 116h(27 号文 §3.1 116h 行 / §8.10):线程间仲裁的三个全局闸。夹取口径与上面 116a 的
  // 各键一致(非有限数回该键自身默认;整数键取整,金额键保留小数)。
  {
    const n = Number(config.stewardMaxParallelThreads);
    const clamped = Number.isFinite(n) ? Math.min(32, Math.max(1, Math.round(n))) : 5;
    if (clamped !== config.stewardMaxParallelThreads) { config.stewardMaxParallelThreads = clamped; changed = true; }
  }
  {
    const n = Number(config.stewardGlobalMaxTurnsPerHour);
    const clamped = Number.isFinite(n) ? Math.min(2000, Math.max(1, Math.round(n))) : 120;
    if (clamped !== config.stewardGlobalMaxTurnsPerHour) { config.stewardGlobalMaxTurnsPerHour = clamped; changed = true; }
  }
  {
    const n = Number(config.stewardGlobalMaxCostPerDay);
    const clamped = Number.isFinite(n) ? Math.min(10000, Math.max(0, n)) : 20;
    if (clamped !== config.stewardGlobalMaxCostPerDay) { config.stewardGlobalMaxCostPerDay = clamped; changed = true; }
  }
  // 第 123 波 M1:调度器总开关。与 stewardThreadBriefV1 同方向的严格布尔(!== false)——
  // 它默认【开】,只有显式写 false 才算关;别的垃圾值一律归一成 true,这样手改坏了配置文件
  // 不会静默丢掉一个默认开的能力。(stewardEnabledV1 那条是 === true 方向,两者刻意不同,见各自注释。)
  {
    const b = config.schedulerEnabledV1 !== false;
    if (b !== config.schedulerEnabledV1) { config.schedulerEnabledV1 = b; changed = true; }
  }
  // 第 123 波 M1 §3.2:无人值守 ask 的等待窗口(分钟),clamp [1,240],非法回默认 30。
  // 区间上下界与默认值的单一事实源是 06j 的 SCHEDULER_LIMITS —— 但 06j 拼在 01 【之后】,
  // 这里引用它会是一条前向边,所以这三个数在这里写成字面量,并由 unit/scheduler-core.test.js
  // 与 scheduler-api.e2e.js 两头对账(任何一边改了数,另一边当场红)。
  {
    const n = Number(config.schedulerAskWaitMinutes);
    const clamped = Number.isFinite(n) ? Math.min(240, Math.max(1, Math.round(n))) : 30;
    if (clamped !== config.schedulerAskWaitMinutes) { config.schedulerAskWaitMinutes = clamped; changed = true; }
  }
  // v1.4.4: agentWorkflowMaxNodes — persisted Agent 工作流 DAG node-count ceiling (see defaultConfig())。第23波上限 32→64。
  {
    const am = Number(config.agentWorkflowMaxNodes);
    const clamped = Number.isFinite(am) ? Math.min(64, Math.max(1, Math.round(am))) : 48;
    if (clamped !== config.agentWorkflowMaxNodes) { config.agentWorkflowMaxNodes = clamped; changed = true; }
  }
  {
    // 团队模式 v2 (A2): 清洗任务池策略与 auto cap。
    const pp = String(config.agentTaskPoolPolicy || '').trim();
    const normPp = ['manual', 'auto-capped', 'off'].includes(pp) ? pp : 'manual';
    if (normPp !== config.agentTaskPoolPolicy) { config.agentTaskPoolPolicy = normPp; changed = true; }
    const cap = Number(config.agentTaskPoolAutoCap);
    const capN = Number.isFinite(cap) ? Math.min(16, Math.max(0, Math.round(cap))) : 3;
    if (capN !== config.agentTaskPoolAutoCap) { config.agentTaskPoolAutoCap = capN; changed = true; }
  }
  {
    const rawRoles = Array.isArray(config.agentRoleOverrides) ? config.agentRoleOverrides : [];
    const seen = new Set(), clean = [];
    for (const rawRole of rawRoles) {
      const role = normalizeAgentRole(rawRole, { source: 'global' });
      if (!role || seen.has(role.id)) continue;
      seen.add(role.id); clean.push(role);
      if (clean.length >= 32) break;
    }
    if (JSON.stringify(clean) !== JSON.stringify(config.agentRoleOverrides)) { config.agentRoleOverrides = clean; changed = true; }
    else config.agentRoleOverrides = clean;
  }
  // v0.9-S9 (D6): searchBackend — {type,baseUrl,apiKey}. Cleanse type to the enum (unknown → 'none'), and
  // baseUrl/apiKey to length-capped strings. An unknown/absent value falls back to a disabled backend so a
  // corrupt config can never leave web_search pointing at garbage. apiKey is masked on the way OUT (see
  // maskSecrets) and unmasked on SAVE (unmaskSecrets), same as providers[].apiKey.
  {
    const raw0 = (config.searchBackend && typeof config.searchBackend === 'object' && !Array.isArray(config.searchBackend)) ? config.searchBackend : {};
    // v1.0-S6 (A): +tavily +bocha. v1.1-W1a (T3): +builtin. New枚举 values are OPTIONAL/缺省安全 — an
    // absent/unknown type still falls back to 'builtin' (the zero-config default), so configSchema stays 7.
    let type = ['none', 'builtin', 'searxng', 'bing', 'brave', 'tavily', 'bocha', 'custom'].includes(raw0.type) ? raw0.type : 'builtin';
    // v1.1-W1a (T3): MIGRATE存量 'none' → 'builtin'. Rationale: 'none' was the *historical default* (nobody
    // ever actively chose "disable search" — the old default just left web_search off). Folding it to the new
    // zero-config backend turns search ON for every upgraded install, matching the 开箱即用 decision.
    // 审计 P2 (修 v1.1-W1a 的过度折叠): 旧版【无条件】折叠 'none'→'builtin' → UI 新增的「不启用」选项永不生效(每次
    // load 又被折回 builtin),对气隙产品是「联网关不掉」的合规缺陷。改为【一次性】迁移:仅当从未迁移过
    // (searchBackendMigrated 缺失,即老配置/新装首读)才折叠;置位后用户显式选择的 'none' 正常持久化。只折 'none',
    // 其它 backend 从不改动。迁移标记随 readConfig 首次即写回磁盘,并经 POST /api/config 的 {...current,...body}
    // 合并稳定存活(current 恒含 true),故保存往返不会重新折叠。
    if (raw0.type === 'none' && config.searchBackendMigrated !== true) { type = 'builtin'; }
    if (config.searchBackendMigrated !== true) { config.searchBackendMigrated = true; changed = true; }
    const sb = {
      type,
      // 107-S2 最后一道闸(同 sanitizeProvider):掩码永不落盘。
      baseUrl: typeof raw0.baseUrl === 'string' ? configUrlOrCleared(raw0.baseUrl.trim().slice(0, 1000)) : '',
      apiKey: typeof raw0.apiKey === 'string' ? configSecretValueOrCleared(raw0.apiKey.slice(0, 2048)) : '',
    };
    if (JSON.stringify(sb) !== JSON.stringify(config.searchBackend)) { config.searchBackend = sb; changed = true; }
    else config.searchBackend = sb;
  }
  config.configSchema = CONFIG_SCHEMA;
  config.version = VERSION;
  // v1.4.3: sanitize new config fields
  if (typeof config.appendSystemPrompt !== 'string') { config.appendSystemPrompt = ''; changed = true; }
  else if (config.appendSystemPrompt.length > 8000) { config.appendSystemPrompt = config.appendSystemPrompt.slice(0, 8000); changed = true; }
  if (!Array.isArray(config.additionalDirectories) || config.additionalDirectories.some(a => typeof a !== 'string')) {
    config.additionalDirectories = Array.isArray(config.additionalDirectories) ? config.additionalDirectories.filter(a => typeof a === 'string').slice(0, 20) : [];
    changed = true;
  }
  // v1.4-OSS 用量看板: usageBudget — optional {monthly:Number>0, currency:short string} soft budget, else null.
  // A malformed value coerces to null (never leaves a garbage budget in config). ADDITIVE/optional field.
  {
    const raw0 = (config.usageBudget && typeof config.usageBudget === 'object' && !Array.isArray(config.usageBudget)) ? config.usageBudget : null;
    let ub = null;
    if (raw0) {
      const monthly = Number(raw0.monthly);
      const currency = (typeof raw0.currency === 'string') ? raw0.currency.trim().slice(0, 8) : '';
      if (Number.isFinite(monthly) && monthly > 0 && currency) ub = { monthly, currency };
    }
    if (JSON.stringify(ub) !== JSON.stringify(config.usageBudget)) { config.usageBudget = ub; changed = true; }
    else config.usageBudget = ub;
  }
  // v1.4-OSS 用量看板: claudePricing — optional {inputPerM, outputPerM, currency} for Claude cost estimation
  // (see defaultConfig). Validated via the shared normalizePricing; a malformed value coerces to null.
  {
    const cp = normalizePricing(config.claudePricing);
    if (JSON.stringify(cp) !== JSON.stringify(config.claudePricing)) { config.claudePricing = cp; changed = true; }
    else config.claudePricing = cp;
  }
  // 128a:显式键集合与落盘投影。读盘语义下,raw 里出现、归一化后不等于当前默认的已知键 = 显式
  // (手改 config.json、旧版本写下的整份配置)。等于默认又不在集合里的键不落盘 —— 而且第一次读就清掉,
  // 否则下次默认一变,它们会被这条规则误认成「手改」、又冻住。
  // 旧格式(schema < 当前,含全新安装与降级往返)那一次读要看【全部】键,不只看 raw 里出现过的:上面那些
  // `incomingConfigSchema < N` 的迁移会给 raw 里【没有】的键造出值(例如 <10 从 defaultWorkspace 给工作区表
  // 播种),而 schema 一抬到当前,它们再也不会跑 —— 这一次不落盘,造出来的值就永远丢了(128a 第一轮全量逮到:
  // 工作区表被清空,管家开线程一律 invalid_request)。当前格式的文件只看 raw 里的键(手改)。
  const explicit = new Set(rawExplicit);
  if (opts.inferExplicit !== false) {
    const migrationRead = incomingConfigSchema < CONFIG_SCHEMA;
    const candidates = migrationRead ? Object.keys(config) : (raw && typeof raw === 'object' ? Object.keys(raw) : []);
    for (const key of candidates) {
      if (CONFIG_BOOKKEEPING_KEYS.includes(key) || !Object.prototype.hasOwnProperty.call(base, key)) continue;
      if (!configValueEquals(configComparableValue(config, key), base[key])) explicit.add(key);
    }
  }
  finalizeConfigExplicitKeys(config, explicit);
  const persisted = persistableConfig(config, base);
  // 是否写盘 = 投影与盘上内容是否不同(不再看归一化途中的内部标记):派生值(比如没设工作区时 defaultWorkspace
  // 取家目录)每次读都重算、但不在投影里,不会造成每读必写。
  changed = !raw || typeof raw !== 'object' || !configValueEquals(persisted, raw);
  return { config, changed, persisted };
}

// 110-2b: 运行时开关判定函数抽至 01c-runtime-flags.js。

// ============================================================================
// 第25波 25.1(AUTONOMY-PLAN §4):原子 JSON 写【统一入口】。此前四种手写变体各缺一角——
// saveSession/writeConfigAtomic 无 rename 重试、saveAgentRun 的 tmp 名无随机、journalWriteIndex/
// saveUserPlaybook 用固定 '.tmp' 名——全部收编到这里,一处修对处处对:
//   ① 唯一 tmp 名(pid+随机):固定名下两个并发写者写同一临时文件、交错字节 → rename 出损坏 JSON;
//   ② rename 瞬时锁重试:Windows 上并发读者/杀软/备份持目标句柄致 EPERM/EBUSY/EACCES/EEXIST,毫秒级即释,
//      重试 8 次(15→155ms 退避)——saveAgentRun 实战验证过的参数,推广到所有 JSON 落盘;
//   ③ 最终失败必 unlink tmp:唯一名没有"下次覆写自愈"路径,不清会无界累积孤儿;
//   ④ value 传字符串视为已序列化(saveSession 需要同步快照语义:序列化与索引快照同一 tick)。
async function atomicWriteJson(finalPath, value, opts = {}) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const tmpPath = finalPath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  // 对抗轮修(第25波): writeFile 自身失败(ENOSPC 典型——目录项已建、写入失败)同样必须清 tmp,否则
  // 节流重试每 1.5s 造一个新孤儿(唯一名无覆写自愈路径)。不变量③对 write 与 rename 两个失败点都成立。
  try { await fsp.writeFile(tmpPath, payload, 'utf8'); }
  catch (e) { fsp.unlink(tmpPath).catch(() => {}); throw e; }
  const retries = Number.isFinite(opts.retries) ? opts.retries : 8;
  for (let attempt = 0; ; attempt++) {
    try { await fsp.rename(tmpPath, finalPath); return; }
    catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EEXIST');
      if (transient && attempt < retries) { await new Promise(r => setTimeout(r, 15 + attempt * 20)); continue; }
      try { await fsp.unlink(tmpPath); } catch { /* best-effort tmp cleanup */ }
      throw e;
    }
  }
}

// 117q-B6(30 号文 P2-10):「读文件末尾 N 字节」原语【统一入口】。此前四处独立手写同一套动作
// (stat 拿 size -> 算尾窗起点 -> open -> 分配 buffer -> read -> finally 关 fd):02-session-store.js 的
// repairMissionChangeTornTail/repairInterventionTornTail 两处【不检查 bytesRead】——直接对整段已分配
// buffer 取最后一字节 / lastIndexOf,若 fd.read 实际读到的字节数少于请求量(stat 与 read 之间文件被
// 截短等罕见竞态),就会对 buffer 里未被写入的那一截(未初始化或陈旧内存)算截断点——而这个截断点
// 会被直接拿去 fsp.truncate()。算错就是真的截错数据。08-agent-runs.js/13g-steward.js 的两处已经在
// 检查 bytesRead,行为不变,只是把手写的 open/alloc/read/close 换成本函数。
// 返回 { buf, bytesRead, size }：size < 0 表示文件不存在(或 stat 失败,与原四处"stat 出错即当无文件"
// 同口径)；buf.length === 请求要读的字节数(= min(maxBytes, size) 且已 clamp 到 >=0),但【只有
// buf[0..bytesRead) 是本次 read 实际写入的有效数据】——调用方必须按 bytesRead 定界(取最后一个有效
// 字节要用 buf[bytesRead-1],扫 \n 要把 lastIndexOf 的搜索起点钉在 bytesRead-1),不能假设 bytesRead
// === buf.length。空文件(size===0)与「尾窗一字节都不用读」的退化情形直接返回 bytesRead:0,不开 fd。
async function readFileTail(file, maxBytes) {
  let size = -1;
  try { size = (await fsp.stat(file)).size; } catch { return { buf: Buffer.alloc(0), bytesRead: 0, size: -1 }; }
  const max = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const start = Math.max(0, size - max);
  const want = size - start;
  if (!want) return { buf: Buffer.alloc(0), bytesRead: 0, size };
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, start);
    return { buf, bytesRead, size };
  } finally { if (fh) await fh.close().catch(() => {}); }
}

// ── 103c: composable lifecycle for small durable JSON state ──────────────────
// This is deliberately narrower than a database abstraction. NDJSON append logs, session v2 bodies,
// exit-time synchronous snapshots and externally-owned files keep their dedicated protocols. The helper
// below only centralizes the lifecycle that small workbench-owned JSON stores were independently rebuilding:
// schema admission, sanitization, corruption quarantine, bounded collections, serialized atomic writes and
// an explicit process cache/invalidation contract.
const DurableJsonStore = ((fsModule, fspModule, pathModule, atomicWriteFn) => {
  function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function storeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function resolvePath(root, dottedPath) {
    let value = root;
    for (const key of String(dottedPath || '').split('.').filter(Boolean)) {
      if (!value || typeof value !== 'object') return null;
      value = value[key];
    }
    return value;
  }

  function applyCapacity(value, rules) {
    for (const rule of Array.isArray(rules) ? rules : []) {
      const target = resolvePath(value, rule && rule.path);
      const max = Math.max(0, Math.floor(Number(rule && rule.max) || 0));
      if (!target || !max) continue;
      if (Array.isArray(target) && target.length > max) target.splice(0, target.length - max);
      else if (typeof target === 'object') {
        const keys = Object.keys(target);
        for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete target[key];
      }
    }
    return value;
  }

  function create(options = {}) {
    if (!options.file) throw new TypeError('durable JSON store requires file');
    const id = String(options.id || 'durable-json');
    const schemaKey = String(options.schemaKey || 'schema');
    const schemaVersion = Number.isFinite(options.schemaVersion) ? options.schemaVersion : null;
    const cacheEnabled = options.cache !== false;
    let cached = null;
    let hasCache = false;
    let writeChain = Promise.resolve();

    const filePath = () => String(typeof options.file === 'function' ? options.file() : options.file);
    const fallback = () => cloneJson(typeof options.defaultValue === 'function' ? options.defaultValue() : options.defaultValue);

    function prepare(raw, forWrite) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw storeError('EDURABLE_SHAPE', id + ': root must be an object');
      }
      const actualSchema = raw[schemaKey];
      if (schemaVersion !== null && actualSchema !== undefined && actualSchema !== schemaVersion) {
        throw storeError('EDURABLE_SCHEMA', id + ': unsupported ' + schemaKey + ' ' + String(actualSchema));
      }
      let value = cloneJson(raw);
      if (typeof options.sanitize === 'function') value = options.sanitize(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw storeError('EDURABLE_SANITIZE', id + ': sanitizer returned a non-object');
      }
      if (schemaVersion !== null) value[schemaKey] = schemaVersion;
      applyCapacity(value, options.capacity);
      if (typeof options.validate === 'function' && options.validate(value) !== true) {
        throw storeError('EDURABLE_VALIDATE', id + ': validation failed');
      }
      return value;
    }

    function freshDefault() {
      const value = fallback();
      return prepare(value && typeof value === 'object' ? value : {}, false);
    }

    function quarantine(error) {
      const file = filePath();
      const corruptPath = file + '.corrupt';
      try { fsModule.copyFileSync(file, corruptPath); } catch { /* best effort: original remains untouched */ }
      if (typeof options.onCorrupt === 'function') {
        try { options.onCorrupt(error, { id, file, corruptPath }); } catch { /* diagnostics never block recovery */ }
      }
    }

    function readSync() {
      if (cacheEnabled && hasCache) return cached;
      let value;
      try {
        value = prepare(JSON.parse(fsModule.readFileSync(filePath(), 'utf8')), false);
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) quarantine(error);
        value = freshDefault();
      }
      if (cacheEnabled) { cached = value; hasCache = true; }
      return value;
    }

    function write(value) {
      let snapshot;
      try { snapshot = prepare(value, true); }
      catch (error) { return Promise.reject(error); }
      // Advance the write-through cache at enqueue time. Updating it on I/O completion lets an older queued
      // write temporarily replace newer in-memory state while the next atomic write is still awaiting disk.
      if (cacheEnabled) { cached = snapshot; hasCache = true; }
      const pending = writeChain.catch(() => {}).then(async () => {
        const file = filePath();
        await fspModule.mkdir(pathModule.dirname(file), { recursive: true });
        await atomicWriteFn(file, snapshot);
        return snapshot;
      });
      writeChain = pending;
      return pending;
    }

    function invalidate() {
      cached = null;
      hasCache = false;
    }

    return { id, readSync, write, invalidate, filePath };
  }

  return { create, applyCapacity };
})(fs, fsp, path, atomicWriteJson);


// v1.4.1 (audit #4): config.json 原子写 —— 此前用裸 fsp.writeFile,崩溃/断电中途会留下截断文件,下次读
// safeJsonParse→null → normalizeConfig 把【整份用户配置静默重置为默认】(密钥/服务商/工作区全丢)。
// 第25波 25.1: 写体收编进 atomicWriteJson;对抗轮修: 全局写链串行化并发 config 写(同 saveSession 理由——
// 重试窗口下旧载荷不得迟到覆写新载荷)。
let configWriteChain = Promise.resolve();
async function writeConfigAtomic(data) {
  const thisWrite = configWriteChain.catch(() => {}).then(async () => {
    // 2026-09-06 对抗审查 P2-1：覆盖前把即将被替换的那份原样留成 config.json.prev（只留最近一份）。
    // 这是 readConfig 在文件丢失/写坏时的第一恢复源；首次写入或旧文件不可读时跳过，失败不阻塞。
    try { await fsp.copyFile(paths.config, `${paths.config}.prev`); } catch { /* 首次写入或不可读 */ }
    return atomicWriteJson(paths.config, data);
  });
  configWriteChain = thisWrite;
  await thisWrite;
}
async function readConfigPrev() {
  try {
    const parsed = safeJsonParse(await fsp.readFile(`${paths.config}.prev`, 'utf8'), null);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch { return null; }
}
// 2026-09-06 对抗审查 P0-2：此前 readConfig 把「任何读失败」都当「全新安装」并立刻把默认配置写回磁盘——
// 杀毒/备份软件短暂锁文件、瞬时 I/O 错误、外部写坏 JSON，任何一次背景 GET /api/status 都能把用户的密钥/
// 服务商/工作区静默冲成默认值。现在：只有 ENOENT（文件确实不存在）且没有 .prev 可恢复时才算全新安装；
// 其它读失败与 JSON 损坏一律不写盘，先用上一次读成功的内存副本，没有就进入【降级】：读到默认值只用于
// 本次请求，writeConfig 在降级期间拒绝落盘（config.read_degraded），直到某次读成功为止。
let configDegraded = false;
let lastGoodConfig = null;
// 48b(P1) readConfig 内存缓存 -- 经对抗验证【回退】。根因:5 件 e2e(usage-ledger/skills-registry/
// workbench-memory/vision-loop/subagent)直接 fs 写 config.json 切换 provider/配置,依赖 readConfig 每次
// 读盘拾取(usage-ledger:137 注释明述"readConfig is uncached -> picked up");缓存让这些直接写不可见。
// 生产环境 config 变更走 POST /api/config(writeConfig 可失效缓存)故缓存对生产正确,但测试直接写是合法
// 提速捷径,且 mutate 别名隐患(structuredClone 仅治标),perf 收益(小 config + OS 已缓存磁盘读)不抵
// 5 件回归 + 风险。05 方案 P1 留作后续:若重做须先把 e2e 改用 POST /api/config(镜像生产)或加 mtime 失效。
async function readConfig() {
  await ensureDirs();
  let text = null; let readError = null;
  try { text = await fsp.readFile(paths.config, 'utf8'); } catch (e) { readError = e; }
  let raw = null; let recoveredFrom = '';
  const degrade = code => {
    try { logEvent({ kind: 'config_read_failed', code, degraded: !lastGoodConfig }); } catch { /* 日志是旁路 */ }
    if (lastGoodConfig) return lastGoodConfig;
    configDegraded = true;
    return normalizeConfig(null).config;   // 只供本次请求使用，绝不落盘
  };
  if (readError) {
    if (readError.code !== 'ENOENT') return degrade(String(readError.code || 'EREAD'));
    // 文件确实不存在：有上一版就恢复它，没有才是全新安装。
    const prev = await readConfigPrev();
    if (prev) { raw = prev; recoveredFrom = 'prev'; }
  } else {
    raw = safeJsonParse(text, null);
    if (raw === null && String(text).trim()) {
      // 文件在但不是合法 JSON（截断/被外部写坏）：不覆盖它；能从 .prev 恢复就恢复，否则降级。
      const prev = await readConfigPrev();
      if (prev) { raw = prev; recoveredFrom = 'prev'; }
      else return degrade('EJSON');
    }
  }
  const { config, changed, persisted } = normalizeConfig(raw);
  configDegraded = false;
  lastGoodConfig = config;
  if (recoveredFrom) { try { logEvent({ kind: 'config_recovered', from: recoveredFrom }); } catch { /* 日志是旁路 */ } }
  // Only rewrite when a migration actually mutated the file (avoid racy write-on-every-read)；恢复自 .prev 时也落盘。
  // 128a:写的是投影(显式键 ＋ 簿记键 ＋ 不认识的键),不是整份内存视图。
  if (changed || recoveredFrom) await writeConfigAtomic(JSON.stringify(persisted, null, 2)).catch(() => {});
  return config;
}

// 128a:before ＝ 这次写入之前的内存视图(mutateConfig 在 mutator 动手前拍的快照)。next 里归一化后值与它
// 不同的键记成显式 —— 「被改过」的唯一口径,设置页、API、管家改设置、产品代用户记的状态一视同仁。
// 没有 before 的调用(只剩单测)退回读盘语义:next 里不等于默认的键都算显式。
async function writeConfig(next, before = null) {
  await ensureDirs();
  if (configDegraded) {
    // 读失败/JSON 损坏期间拿到的「当前配置」是默认值：在它上面合并再落盘 = 把用户配置冲成默认。拒绝。
    const err = new Error('config.read_degraded: config.json 当前读不出来，拒绝在默认值之上落盘');
    err.code = 'config.read_degraded';
    throw err;
  }
  if (!before) {
    const { config, persisted } = normalizeConfig(next);
    await writeConfigAtomic(JSON.stringify(persisted, null, 2));
    return config;
  }
  const { config } = normalizeConfig(next, { inferExplicit: false });
  const explicit = new Set([...configExplicitKeysOf(before), ...configExplicitKeysOf(config)]);
  const base = defaultConfig();
  for (const key of Object.keys(config)) {
    if (CONFIG_BOOKKEEPING_KEYS.includes(key)) continue;
    // next 上被 delete 掉的已知键 = 「恢复默认」:从显式集合里拿掉,回到跟随产品默认。
    if (Object.prototype.hasOwnProperty.call(base, key) && !Object.prototype.hasOwnProperty.call(next, key)) { explicit.delete(key); continue; }
    if (!configValueEquals(configComparableValue(config, key), configComparableValue(before, key))) explicit.add(key);
  }
  finalizeConfigExplicitKeys(config, explicit);
  await writeConfigAtomic(JSON.stringify(persistableConfig(config, base), null, 2));
  return config;
}

// ── 117n-M2:配置「读-改-写」的唯一临界区 ────────────────────────────────────────────────────
// writeConfigAtomic 的 configWriteChain(上面)只串行化【物理写】,不保护「读-改」:两个并发请求
// 各自 readConfig() 读到同一份旧值、各自 merge 后 writeConfig,后写者会静默吞掉先写者的字段
// (真机形态:一边保存设置一边启停连接器,其中一次的改动凭空消失)。此前有 9 处这样的裸
// read-modify-write 绕过了 applyConfigPatch;mutateConfig 把「读 -> mutator -> writeConfig」整段
// 占住一条队列,丢失更新在这里根除。
// 为什么另开 configMutateChain 而不复用 configWriteChain:readConfig 自己在迁移/从 .prev 恢复时会
// 调 writeConfigAtomic,复用同一条队列会自锁。两条队列职责不同,物理写仍由 configWriteChain 串行。
//
// mutator(current) 在锁内执行,current 是刚从盘上读到并归一化的配置(可就地改)。返回值形状:
//   undefined / {}   -> 落盘 current
//   { next }         -> 落盘 next(调用方自己拼了新对象,而不是就地改)
//   { value }        -> 随行数据,原样回给调用方
//   { abort: X }     -> 不落盘(校验没过/没什么可写),结果 { ok:false, config: current, value: X }
// 结果统一为 { ok, config, value }:ok=true 时 config 是 writeConfig 之后已归一化的 next。
// mutator 抛出的异常照常向调用方冒泡(与此前直接 await writeConfig 抛出等价),且不毒化队列。
let configMutateChain = Promise.resolve();
function mutateConfig(mutator) {
  const run = configMutateChain.catch(() => {}).then(async () => {
    const current = await readConfig();
    // 128a:mutator 可以就地改 current,所以「改之前」必须先深拷一份(Symbol 键 structuredClone 不带,手补)。
    const before = structuredClone(current);
    before[CONFIG_GIVEN_CLAUDE_PATH] = current[CONFIG_GIVEN_CLAUDE_PATH];
    const decision = await mutator(current);
    const d = (decision && typeof decision === 'object') ? decision : {};
    if (Object.prototype.hasOwnProperty.call(d, 'abort')) return { ok: false, config: current, value: d.abort };
    const next = await writeConfig(Object.prototype.hasOwnProperty.call(d, 'next') ? d.next : current, before);
    return { ok: true, config: next, value: d.value };
  });
  configMutateChain = run.then(() => {}, () => {});
  return run;
}

// v1.4.3: Sync workbench settings to ~/.claude/settings.json so the Claude CLI's own config stays
// aligned with what the user selected in the Ruyi UI. This is a MERGE: existing keys are preserved.
// Covers: permissionMode, model, thinkingBudget, appendSystemPrompt.
async function syncClaudeCliSettings(config) {
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    try {
      settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
      if (!settings || typeof settings !== 'object') settings = {};
    } catch { /* file doesn't exist or invalid JSON */ }

    // 1. Permission mode
    const cliMode = CLAUDE_PERMISSION_MODE_MAP[config.permissionMode] || config.permissionMode;
    settings.permissions = { ...(settings.permissions || {}), defaultMode: cliMode };
    // 2. Model. 第36波(v1.7): 只删【自己写过的】model —— settings.json 是用户自己的配置,工作台未设模型时
    // 无条件 delete 会把用户手写的 settings.model 一并抹掉(越权接管,与本函数 "MERGE: existing keys are
    // preserved" 的契约直接冲突)。权属用工作台侧 sidecar(dataRoot, 非用户 ~/.claude)追踪:记住上次同步写入的
    // 值,仅当 settings.model 仍等于该值时才删除(证明是我们写的);否则原样保留。sidecar 缺失(老版本首次升级)
    // 时宁可留一次陈旧值也不误删。
    const sidecarPath = path.join(paths.data, 'claude-settings-sync.json');
    let prevSyncedModel = null;
    try {
      const sc = safeJsonParse(await fsp.readFile(sidecarPath, 'utf8'), null);
      if (sc && typeof sc.model === 'string') prevSyncedModel = sc.model;
    } catch { /* no sidecar yet */ }
    if (config.model && typeof config.model === 'string') settings.model = config.model;
    else if (prevSyncedModel && settings.model === prevSyncedModel) delete settings.model;
    // 3. Thinking budget -> env.MAX_THINKING_TOKENS
    if (config.thinkingBudget) {
      settings.env = { ...(settings.env || {}), MAX_THINKING_TOKENS: String(config.thinkingBudget) };
    } else { if (settings.env) delete settings.env.MAX_THINKING_TOKENS; }
    // 4. Append-system-prompt: intentionally NOT written to settings.json (E2). The official Claude Code
    // settings schema has no top-level `appendSystemPrompt` key, so writing it was a dead config at best and
    // a double-injection risk at worst (it is already, reliably, passed as the --append-system-prompt spawn
    // flag on every runClaudeTurn). Keep the flag as the single channel and actively strip any stale key a
    // prior workbench version may have written.
    delete settings.appendSystemPrompt;

    await fsp.mkdir(claudeDir, { recursive: true }).catch(() => {});
    await atomicWriteJson(settingsPath, JSON.stringify(settings, null, 2));   // 25.1 收编
    // 第36波: 记录本次同步的 model 权属(见上方 "2. Model");null 表示本工作台当前无 model 可声明。
    await atomicWriteJson(sidecarPath, JSON.stringify({
      model: (config.model && typeof config.model === 'string') ? config.model : null,
    })).catch(() => {});
  } catch { /* non-fatal: CLI flag --permission-mode is the primary mechanism */ }
}

// v1.4.3: Write workbench-managed agent roles to ~/.claude/agents/*.md so they are available
// when running `claude` directly (not just via the workbench's --agents flag).
async function syncAgentRolesToClaude(cwd, config) {
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const agentsDir = path.join(claudeDir, 'agents');
    await fsp.mkdir(agentsDir, { recursive: true }).catch(() => {});
    const roles = await getAgentRoleLibrary(cwd, config);
    for (const role of roles) {
      if (role.nativeClaude) continue;
      const cliMode = claudePermissionMode(role.permissionMode);
      var fm = ['---'];
      fm.push('description: ' + JSON.stringify(role.description || role.label));
      if (cliMode) fm.push('permissionMode: ' + cliMode);
      if (role.models && role.models.claude && role.models.claude !== 'inherit') fm.push('model: ' + role.models.claude);
      if (role.claudeTools && role.claudeTools.length) fm.push('tools: ' + JSON.stringify(role.claudeTools));
      fm.push('---');
      var body = role.prompt || role.description || role.label;
      var md = fm.join('\n') + '\n\n' + body + '\n';
      var file = path.join(agentsDir, role.id + '.md');
      await atomicWriteJson(file, md);   // 25.1 收编(md 字符串直接透传)
    }
  } catch { /* non-fatal */ }
}

// v1.4.3: Sync external MCP servers to Claude CLI's user-level config so they are available
// when running `claude` directly. Uses `claude mcp add-json` (idempotent).
async function syncMcpServersToClaude(config) {
  try {
    if (!config.claudePath || !(await existsExecutableAsync(config.claudePath))) return;   // 128f-⑬:不钉事件循环
    var servers = resolveExternalMcpServers(config);
    // v2.7.1 (boot fix): claude mcp add-json 每次最多 10s,10 个串行可达 100s,await 会拖死 boot。
    // 加总预算(15s):超预算的余量丢弃 -- add-json 幂等,下次 boot 自动补齐。boot 调用点已改 fire-and-forget,
    // API/CLI 路径仍 await 也被预算兜底(最多 15s 而非 100s)。
    const SYNC_BUDGET_MS = 15000;
    // 122-§2.6:从 Claude Code 导进来的条目【不再同步回 Claude Code】。判据取自 config.externalMcpServers
    // 上的 origin(resolveExternalMcpServers 的输出不带这个字段,故按 id 回查),缺省视为 'ruyi'。
    // 桌面内置连接器与 drop-in 没有 origin,照旧同步 —— 它们不是从 Claude Code 来的,不构成「删了又回来」的闭环。
    const fromClaudeCode = new Set((Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [])
      .filter(item => item && item.origin === 'claude-code').map(item => String(item.id)));
    const skippedIds = [];
    const t0 = Date.now();
    for (var s of servers) {
      if (!s.id || !s.command) continue;
      if (fromClaudeCode.has(String(s.id))) { skippedIds.push(String(s.id)); continue; }
      // ruyi-toolbox 登记的 MCP 组件只在如意运行时存在(04:绝不写回 config),也不写进 Claude CLI 的用户级配置 ——
      // 写过去,下次启动就会被下面的自动导入当成「Claude Code 里的连接器」导回来、固化进 externalMcpServers,
      // 于是删掉登记文件／关掉总开关都撤不走它(toolbox-discovery.e2e F3 实测抓到的闭环)。
      if (s._toolbox) continue;
      const remain = SYNC_BUDGET_MS - (Date.now() - t0);
      if (remain <= 0) break;
      var sc = { type: 'stdio', command: s.command, args: s.args || [], env: s.env || {} };
      if (s.cwd) sc.cwd = s.cwd;
      try { await DesktopShell.runProcess(config.claudePath, ['mcp', 'add-json', s.id, JSON.stringify(sc), '-s', 'user'], { timeoutMs: Math.min(remain, 10000) }); } catch {}
    }
    // 跳过了谁要能查:否则「为什么这个连接器没同步过去」在真机上无从定位。
    if (skippedIds.length) logEvent({ kind: 'mcp_sync_skip_origin', origin: 'claude-code', ids: skippedIds });
  } catch { /* non-fatal */ }
}

// v2.8: Kimi Code reads user MCP declarations from $KIMI_CODE_HOME/mcp.json (default ~/.kimi-code/mcp.json) and currently has no
// per-invocation --mcp-config flag. Merge Ruyi's declarations into that file without removing unrelated
// user entries. Turn-specific loopback fields are inherited from the spawned Kimi process environment.
async function syncMcpServersToKimi(config) {
  try {
    await ensureDirs();
    const kimiDir = String(process.env.KIMI_CODE_HOME || '').trim() || path.join(os.homedir(), '.kimi-code');
    const target = path.join(kimiDir, 'mcp.json');
    const sidecar = path.join(paths.data, 'kimi-mcp-sync.json');
    let current = {};
    try { current = safeJsonParse(await fsp.readFile(target, 'utf8'), {}) || {}; } catch { current = {}; }
    if (!current.mcpServers || typeof current.mcpServers !== 'object') current.mcpServers = {};
    let ownership = { managedIds: [], previous: {} };
    try { ownership = { ...ownership, ...(safeJsonParse(await fsp.readFile(sidecar, 'utf8'), {}) || {}) }; } catch { /* first sync */ }
    if (!Array.isArray(ownership.managedIds)) ownership.managedIds = [];
    if (!ownership.previous || typeof ownership.previous !== 'object') ownership.previous = {};
    let generatedServers = {};
    if (config.includeWorkbenchMcp !== false) {
      const generatedPath = await generateMcpConfig(config.mcpCommandMode);
      const generated = safeJsonParse(await fsp.readFile(generatedPath, 'utf8'), {}) || {};
      generatedServers = generated.mcpServers || {};
    }
    const resolvedServers = new Map(resolveExternalMcpServers(config).map(server => [String(server.id), server]));
    const nextIds = new Set(Object.keys(generatedServers));
    // Restore entries that existed before Ruyi took ownership when a server is disabled or removed.
    for (const id of ownership.managedIds) {
      if (nextIds.has(id)) continue;
      if (ownership.previous[id] == null) delete current.mcpServers[id];
      else current.mcpServers[id] = ownership.previous[id];
      delete ownership.previous[id];
    }
    for (const [id, server] of Object.entries(generatedServers)) {
      if (!ownership.managedIds.includes(id)) {
        ownership.previous[id] = Object.prototype.hasOwnProperty.call(current.mcpServers, id) ? current.mcpServers[id] : null;
      }
      // Kimi infers transport from `command`/`url`; Claude's legacy `type: stdio` field is unnecessary.
      const kimiServer = { ...server };
      delete kimiServer.type;
      const resolved = resolvedServers.get(id);
      if (resolved) {
        for (const key of ['startupTimeoutMs', 'toolTimeoutMs', 'enabledTools', 'disabledTools']) {
          if (resolved[key] !== undefined) kimiServer[key] = resolved[key];
        }
        if (resolved.bearerTokenEnvVar) kimiServer.bearerTokenEnvVar = resolved.bearerTokenEnvVar;
      }
      // Kimi's MCP transport defaults to 60 s per tool call. Ruyi's own long-running bridge and ACC
      // both intentionally support longer operations, so advertise a matching transport budget.
      if (id === 'win-claude-workbench') {
        kimiServer.startupTimeoutMs = Math.max(Number(kimiServer.startupTimeoutMs) || 0, 60000);
        kimiServer.toolTimeoutMs = Math.max(Number(kimiServer.toolTimeoutMs) || 0, 900000);
      } else if (id === 'ai-computer-control') {
        kimiServer.startupTimeoutMs = Math.max(Number(kimiServer.startupTimeoutMs) || 0, 60000);
        kimiServer.toolTimeoutMs = Math.max(Number(kimiServer.toolTimeoutMs) || 0, 650000);
      }
      current.mcpServers[id] = kimiServer;
    }
    ownership.managedIds = [...nextIds];
    await fsp.mkdir(kimiDir, { recursive: true });
    await atomicWriteJson(target, JSON.stringify(current, null, 2));
    await atomicWriteJson(sidecar, JSON.stringify(ownership, null, 2));
  } catch { /* non-fatal: Kimi still retains its built-in tools */ }
}

// 启动时自动映射本机 Claude Code 的 MCP(读 ~/.claude.json 的 mcpServers)进 Ruyi 的 externalMcpServers。
// 与 syncMcpServersToClaude(把 Ruyi 的同步到 Claude)互为逆方向:这里是把 Claude 原生注册的拉回 Ruyi。
// 安全约束:① 只加 missing(已存在 id 跳过,不覆盖用户在 Ruyi 里的显式配置);② dismissedMcpIds 里的 id 跳过
// (用户已从 Ruyi 删除,不自动回来);③ unsupported 条目跳过;④ 尊重 ≤10 上限;⑤ 全程 try/catch,失败仅审计不阻断 boot。
// 幂等:第二次启动时已导入的 id 都成 conflict -> 跳过,零写入。
async function autoImportClaudeCodeMcp(config) {
  try {
    if (!config || config.autoImportClaudeCodeMcp === false) return { added: 0, config };
    // Ruyi 保留 id:绝不能作为外部服务器导入(否则与内部桥/桌面内置连接器同 id 冲突)。
    //   win-claude-workbench = 工作台自有权限桥(generateMcpConfig 永远单独注入,不在 externalMcpServers);
    //   ai-computer-control   = 桌面控制内置连接器(detectDesktopMcp 单独探测,mcpConnectorMutateError 视为 builtin)。
    const RESERVED_IDS = new Set(['win-claude-workbench', 'ai-computer-control']);
    const claudeJson = path.join(os.homedir(), '.claude.json');
    // 117n-M2:扫描 + 合并 + 落盘整段进 mutateConfig 的临界区(此前是裸 readConfig 之外的
    // read-modify-write:boot 期这一写与并发的 /api/config 保存互相吞字段)。conflict/dismissed
    // 的判据一律用锁内刚读到的 current,不用调用方传进来的可能已陈旧的 config。
    const r = await mutateConfig(async (current) => {
      const { servers, errors } = await scanMcpSources([claudeJson], current);
      // scanMcpSources 把"文件不存在/无 mcpServers 字段"也作为 error 返回 -- 这两者是预期情况
      // (用户没装 Claude Code 或没配 MCP),静默合理。但"文件过大(>256KB)/JSON 解析失败"是真问题,
      // 静默吞掉会让自动导入不工作且零诊断(重度用户的 ~/.claude.json projects 字段可超 256KB)。
      // 故:非预期 error 走审计,让用户/开发者能定位"为什么没自动导入"。
      if (Array.isArray(errors)) {
        for (const e of errors) {
          const msg = String((e && e.error) || '');
          if (!msg || msg.includes('文件不存在') || msg.includes('未找到 mcpServers')) continue; // 预期,跳过
          try { logEvent({ kind: 'mcp_auto_import_scan_error', path: String((e && e.path) || claudeJson), error: msg }); } catch { /* logging must never re-throw */ }
        }
      }
      const dismissed = new Set(Array.isArray(current.dismissedMcpIds) ? current.dismissedMcpIds : []);
      const list = Array.isArray(current.externalMcpServers) ? current.externalMcpServers.slice() : [];
      const added = [];
      for (const raw of servers) {
        if (!raw || raw.unsupported) continue; // 远程缺 url 等无效条目
        if (raw.conflict) continue; // 已在 config -> 不覆盖
        if (RESERVED_IDS.has(raw.id)) continue; // Ruyi 保留 id -> 跳过
        if (String(raw.id || '').startsWith('toolbox-')) continue; // toolbox- 前缀归自动发现所有:老版本同步过去的残留不导回来
        if (dismissed.has(raw.id)) continue; // 用户已删 -> 不自动回来
        if (list.length >= 10) break; // 上限:list 已含 existing+added(归一化也 cap 10,这里先停避免白加后被丢)
        // 122-§2.6:打来源标记。这一条是「从 Claude Code 导进来的」,syncMcpServersToClaude 据此跳过它 ——
        // 否则用户在 Claude 里删掉一个连接器,下次启动 Ruyi 又 `claude mcp add-json` 把它写回去(§13.17 真机
        // ~/.claude.json 被夹具污染三次,病根就是这条闭环)。import-folder / import-config 是用户主动导,不打标。
        const srv = sanitizeExternalMcpServer({ ...raw, origin: 'claude-code' });
        if (!srv) continue;
        list.push(srv); added.push(srv.id);
      }
      if (!added.length) return { abort: null }; // 零新增 -> 不落盘(与修前 return 前不写盘等价)
      current.externalMcpServers = list;
      return { value: added };
    });
    if (!r.ok) return { added: 0, config: r.config };
    const next = r.config; const added = r.value;
    // 122-§2.5:这里原本 `await generateMcpConfig(next.mcpCommandMode)` —— 它内部 resolveExternalMcpServers
    // → detectDesktopMcp → pickPython 会在【listen 之前】付一整轮探针(冷缓存本机实测 ~2 s),而本函数是 boot
    // 唯一被 await 的调用点。已挪到 13-http-router 的 listen 之后那个 setImmediate 段里统一重生成;
    // 其余调用方(/api/status、/api/mcp、起 claude 前)本来就各自现调 generateMcpConfig,不依赖这一发。
    logEvent({ kind: 'mcp_auto_import', source: claudeJson, added: added.length, ids: added });
    return { added: added.length, ids: added, config: next };
  } catch (e) {
    try { logEvent({ kind: 'mcp_auto_import_error', error: (e && e.message) || String(e) }); } catch { /* logging must never re-throw */ }
    return { added: 0, error: (e && e.message) || String(e), config };
  }
}

// Node >=18.20/20.12/22/24 refuse to spawn a .cmd/.bat with shell:false and throw "spawn EINVAL"
// (CVE-2024-27980). The intranet `claude` is almost always claude.cmd, so route batch launchers
// through cmd.exe with verbatim, manually-quoted args (the cross-spawn-proven pattern).
function isBatchLauncher(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
}
function quoteWinArg(a) {
  a = String(a);
  if (a === '') return '""';
  if (!/[\s"^&|<>()%!]/.test(a)) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}
// Returns { command, args, opts } ready for cp.spawn/spawnSync — transparently wrapping .cmd/.bat.
function batchSafeSpawn(command, args) {
  if (!isBatchLauncher(command)) return { command, args, opts: {} };
  const comspec = process.env.ComSpec || 'cmd.exe';
  const line = '"' + [command, ...args].map(quoteWinArg).join(' ') + '"'; // outer quotes stripped by /s
  return { command: comspec, args: ['/d', '/s', '/c', line], opts: { windowsVerbatimArguments: true } };
}

// ============================================================================
// cmd8191 防线(技能索引把 Claude CLI 命令行顶爆事故的根治): Windows 上 .cmd/.bat 启动器(claude.cmd)经
// cmd.exe /d /s /c 执行,cmd 对整条命令行有 8191 字符硬上限 —— 超限直接报「命令行太长。」退出码 1,claude
// 进程根本没启动。历史上 --append-system-prompt 钳 8000、--agents 钳 6000,两个各自合理的局部钳制相加
// (14000)远超整行预算 —— 局部钳制 ≠ 全局不变量。这里的防线把不变量收拢到一个汇合点:组装完 args 后用与
// batchSafeSpawn【严格同构】的构造核算整行长度,超限走确定性降级阶梯(见 runClaudeTurn 组装段)。
const CMD_EXE_LINE_LIMIT = 8191;          // cmd.exe /c 命令行硬上限(文档值)
const CMD_LINE_SAFE_BUDGET = 7900;        // 整行(含 comspec 路径与 /d /s /c 前缀)安全预算,留本地化/引号余量
const DIRECT_SPAWN_LINE_BUDGET = 32000;   // 直启(.exe/node)走 CreateProcess,上限 32767
const CMD_LINE_QUOTE_MARGIN = 48;         // quoteWinArg 引号翻倍等二阶效应的预留
// Off-by-default 测试缝: 强制预算值并让长度核算一律走 cmd 公式(即使启动器不是 .cmd)——e2e 借此在
// WCW_FAKE_CLAUDE(node 直启)下精确演练降级阶梯,无需真实 cmd.exe。
function cmdLineBudgetSeam() {
  const v = Number(process.env.WCW_CLAUDE_CMDLINE_BUDGET);
  return Number.isFinite(v) && v > 200 ? Math.floor(v) : 0;
}
// 本次 spawn 适用的整行字符预算;0 = 不设防(非 Windows: execve 上限 ~2MB,无 cmd 路径,保持行为逐字节不变)。
function cmdLineBudgetFor(command) {
  const seam = cmdLineBudgetSeam();
  if (seam) return Math.min(seam, CMD_EXE_LINE_LIMIT);
  if (process.platform !== 'win32') return 0;
  return isBatchLauncher(command) ? CMD_LINE_SAFE_BUDGET : DIRECT_SPAWN_LINE_BUDGET;
}
// 与 batchSafeSpawn 的行构造严格同构(改 batchSafeSpawn 必须同步改这里;e2e 有断言)。核算的就是 cmd.exe
// 实际解析的那一整行: "<comspec>" /d /s /c "<quoted join>"。测试缝开启时一律走 cmd 公式(模拟包装)。
function spawnCmdLineLength(command, args) {
  if (isBatchLauncher(command) || cmdLineBudgetSeam()) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const line = '"' + [command, ...args].map(quoteWinArg).join(' ') + '"';
    return `${comspec} /d /s /c ${line}`.length;
  }
  // 直启粗估(Node 自行 quoting): 只用于 32K 量级的宽松判断,无需精确。
  return String(command).length + args.reduce((n, a) => n + String(a).length + 3, 1);
}

// ============================================================================
// P1(cmd8191 根治): npm 版 Claude Code 的 claude.cmd 只是 4 行 shim —— 内容即转发到同目录
// node_modules/@anthropic-ai/claude-code/bin/claude.exe(真身,Bun 单文件原生二进制)。经 cmd.exe
// 启动有 8191 字符整行硬上限(技能索引事故根因);直启 exe 走 CreateProcess(32767,4 倍余量),
// 且 %VAR%/! 延迟展开被 cmd 吃掉、cmd 层 GBK 错误面、taskkill 多一层遗孤窗口整类消失(实测:
// 事故规模 11K append 直启逐字回传 %USERPROFILE%/!DELAYED! 未展开;同参 cmd 包装 25ms 内复现
// 「命令行太长。」)。凡是要 spawn 的 claude 启动器,若指向可解析的 npm shim 就换成真身 exe;
// 解析不出(老布局/非 npm 安装/探测失败)原样返回 —— 行为逐字节不变,纯升级。cmdLineBudgetFor
// 按扩展名分档,解析到 .exe 后整行预算自动 7900 → 32000,cmdlineGuard 降级阶梯自然近乎不再触发。
// 运行时解析,调用方不改写持久化配置:配置里仍是 claude.cmd,exe 消失时下次解析自动回落 shim,
// 不留死配置。结果按启动器字符串 memoize(与 detectClaudePath 同 TTL),normalizeConfig 热路径零探测。
const CLAUDE_NPM_EXE_REL = path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
let _launcherResolveCache = new Map(); // launcher 字符串 → { at, value }
// 定位 shim 同目录下的真身 claude.exe(纯文件系统,不起进程):含目录分隔符的按路径 resolve;裸名字(claude.cmd)
// 沿 PATH 逐目录找。找不到返回空串。
function claudeShimExeFor(p) {
  let shim = '';
  if (/[\\/]/.test(p) || path.isAbsolute(p)) {
    shim = path.resolve(p);
  } else {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const cand = path.join(dir, p);
      if (fs.existsSync(cand)) { shim = cand; break; }
    }
  }
  if (!shim || !fs.existsSync(shim)) return '';
  const exe = path.join(path.dirname(shim), CLAUDE_NPM_EXE_REL);
  return fs.existsSync(exe) ? exe : '';
}
function rememberClaudeLauncher(p, value) {
  if (_launcherResolveCache.size > 32) _launcherResolveCache = new Map(); // 防无界(实际路径集合极小)
  _launcherResolveCache.set(p, { at: Date.now(), value });
}
function resolveClaudeLauncher(launcher) {
  const p = String(launcher || '').trim();
  if (!p || process.platform !== 'win32' || !isBatchLauncher(p)) return launcher;
  const hit = _launcherResolveCache.get(p);
  if (hit) {
    // 128f-⑬:过期【不再当场重探】—— normalizeConfig 在每一次 readConfig 里都走到这里,当场 spawnSync 就是把整个
    // 服务钉住一发「claude.exe --version」。先答上一次的结果,后台重探,探完换上(见 detectClaudePath 头注)。
    if ((Date.now() - hit.at) >= CLAUDEPATH_CACHE_MS) refreshInBackground('launcher:' + p, () => resolveClaudeLauncherAsync(launcher, { force: true }));
    return hit.value;
  }
  let value = launcher; // 默认:原样返回(解析不出 = 保持现状)
  try {
    const exe = claudeShimExeFor(p);
    if (exe) {
      // 真身探测:--version 能跑通才接管(防半截 npm 安装留下坏 exe);失败保持 shim 回退。
      const ok = cp.spawnSync(exe, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 4000 });
      if (!ok.error && ok.status !== null) value = exe;
    }
  } catch { /* 解析失败 = 保持原启动器 */ }
  rememberClaudeLauncher(p, value);
  return value;
}
// 同一件事的异步版(后台重探用):判据逐字相同,只是「--version」那一发不占事件循环。
async function resolveClaudeLauncherAsync(launcher, { force = false } = {}) {
  const p = String(launcher || '').trim();
  if (!p || process.platform !== 'win32' || !isBatchLauncher(p)) return launcher;
  const hit = _launcherResolveCache.get(p);
  if (hit && !force && (Date.now() - hit.at) < CLAUDEPATH_CACHE_MS) return hit.value;
  const generation = _cliProbeGeneration;
  let value = launcher;
  try {
    const exe = claudeShimExeFor(p);
    if (exe) {
      const ok = await spawnProbeAsync(exe, ['--version']);
      if (!ok.error && ok.status !== null) value = exe;
    }
  } catch { /* 同上 */ }
  if (generation === _cliProbeGeneration) rememberClaudeLauncher(p, value);
  return value;
}

function claudeInstallCandidates() {
  const home = os.homedir();
  const env = process.env;
  const dirs = [
    env.APPDATA && path.join(env.APPDATA, 'npm'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'claude'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'claude-code'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Claude'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs'),
    home && path.join(home, '.claude', 'local'),
    home && path.join(home, 'AppData', 'Roaming', 'npm'),
  ].filter(Boolean);
  const names = ['claude.cmd', 'claude.exe', 'claude.bat', 'claude'];
  const out = [];
  for (const dir of dirs) {
    for (const n of names) out.push(path.join(dir, n));
  }
  return out;
}

// v1.0-S7 (perf): detectClaudePath spawnSync-probes for `claude` (up to several launches, each with a 4s
// timeout). It was called from defaultConfig(), which normalizeConfig() spreads on EVERY readConfig() — so
// the (blocking) probe ran repeatedly, twice per startup (readConfig + generateMcpConfig) and on every
// config read thereafter. The RESULT is stable within a process run, so memoize it. This collapses the
// startup cost to a single probe and makes all later readConfig() calls probe-free. A short TTL lets a
// long-lived server re-detect a claude installed after boot without ever re-probing on the hot path.
// (baseline S7: ~27ms/call on this machine where claude.cmd resolves; the worst case — a hung claude.cmd —
// would otherwise cost up to ~4s PER readConfig; memoization bounds it to once per TTL window.)
//
// 128f-⑬(mission-index-scale (e)/(f) 取证时 CPU 剖面挖出来的;用户 2026-09-19「删除线程没有及时的界面反馈」那一刻
// 真机上也撞见了它 —— DELETE 与同时在飞的四发请求一起卡了 1.9 s):上面那句「once per TTL window」就是毛病所在。
// 过期之后的第一次 readConfig 仍然【同步】探一整轮(claude 与 kimi 两支,每个候选一次 node 冷启动,最多 4 s),
// 这期间事件循环被整个占住 —— 于是【大约每分钟一次】,赶上的那个请求以及同时在飞的所有请求、推送、计时器一起等。
// 修法:只有进程里还没有任何结果时同步探(启动那一次;设置里改了 CLI 路径之后那一次 —— 两处都要当场的答案);
// 过期之后先答旧值,后台异步重探(spawnProbeAsync,判据与同步那支逐字相同),探完换上。后台重探每一支同时只有一发,
// 探的途中又被「作废」(invalidate)了的那一发,结果不许回写(_cliProbeGeneration)。
// 测试口 WCW_TEST_CLI_PROBE_TTL_MS 把记忆期缩短(cli-probe-stall.e2e);产品里恒为 60 s。
let _claudePathProbe = null; // { at:number, value:string }
const CLAUDEPATH_CACHE_MS = (() => {
  const raw = Number(process.env.WCW_TEST_CLI_PROBE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
})();
let _cliProbeGeneration = 0;   // 每次作废 +1;后台重探回来时代数变了就丢掉结果
const _cliProbeRefreshing = new Set();   // 正在后台重探的键(同一个键同时只有一发)
function refreshInBackground(key, probe) {
  if (_cliProbeRefreshing.has(key)) return false;
  _cliProbeRefreshing.add(key);
  Promise.resolve().then(probe).catch(() => {}).finally(() => { _cliProbeRefreshing.delete(key); });
  return true;
}
// 异步版的「跑一发 <cmd> --version 看退出码」:与各处 spawnSync 同一组参数(stdio 全忽略、隐藏窗口、超时即杀
// 直接子进程),回同形 { error, status } —— 超时被杀时 status 为 null,与 spawnSync 超时同判。
function spawnProbeAsync(command, args, spawnOpts = {}, timeout = 4000) {
  return new Promise(resolve => {
    let settled = false;
    const done = result => { if (!settled) { settled = true; resolve(result); } };
    let child = null;
    try {
      child = cp.spawn(command, args, { stdio: 'ignore', windowsHide: true, timeout, ...spawnOpts });
    } catch (error) { done({ error, status: null }); return; }
    child.once('error', error => done({ error, status: null }));
    child.once('close', code => done({ error: null, status: code }));
  });
}
function claudeProbeCandidates() {
  // 先 PATH 上的裸名(快、常见),再常见安装位置(必须真的存在才探)。
  const onPath = [process.env.CLAUDE_CLI_PATH, 'claude.cmd', 'claude.exe', 'claude'].filter(Boolean).map(command => ({ command, mustExist: false }));
  return [...onPath, ...claudeInstallCandidates().map(command => ({ command, mustExist: true }))];
}
function detectClaudePathUncached() {
  for (const { command, mustExist } of claudeProbeCandidates()) {
    try {
      if (mustExist && !fs.existsSync(command)) continue;
      const s = batchSafeSpawn(command, ['--version']);
      const ok = cp.spawnSync(s.command, s.args, { stdio: 'ignore', windowsHide: true, timeout: 4000, ...s.opts });
      // P1: shim(claude.cmd)命中时优先解析出真身 claude.exe(绕过 cmd.exe 8191 上限);解析不出原样返回。
      if (!ok.error && ok.status !== null) return resolveClaudeLauncher(command);
    } catch {
      // keep scanning
    }
  }
  return '';
}
async function detectClaudePathUncachedAsync() {
  for (const { command, mustExist } of claudeProbeCandidates()) {
    try {
      if (mustExist && !fs.existsSync(command)) continue;
      const s = batchSafeSpawn(command, ['--version']);
      const ok = await spawnProbeAsync(s.command, s.args, s.opts);
      if (!ok.error && ok.status !== null) return await resolveClaudeLauncherAsync(command);
    } catch {
      // keep scanning
    }
  }
  return '';
}
function detectClaudePath() {
  if (_claudePathProbe) {
    if ((Date.now() - _claudePathProbe.at) >= CLAUDEPATH_CACHE_MS) {
      refreshInBackground('claude', async () => {
        const generation = _cliProbeGeneration;
        const value = await detectClaudePathUncachedAsync();
        if (generation === _cliProbeGeneration) _claudePathProbe = { at: Date.now(), value };
      });
    }
    return _claudePathProbe.value;
  }
  const value = detectClaudePathUncached();
  _claudePathProbe = { at: Date.now(), value };
  return value;
}
// v1.0-S7: let a settings save / explicit "re-detect CLI" action force a fresh probe (e.g. the user just
// installed the CLI). Exported for the doctor/status path — a no-op if never called.
function invalidateClaudePathCache() { _claudePathProbe = null; _cliProbeGeneration += 1; }

// v2.8: the historical "Claude engine" is now an Agent CLI host. Keep claudePath and the engine id for
// session/API compatibility, while selecting a protocol-specific launcher here. Kimi uses the official
// interactive ACP JSON-RPC stream (including reverse permission/question requests).
const AGENT_CLI_TYPES = Object.freeze({
  claude: { id: 'claude', label: 'Claude Code', pathKey: 'claudePath', detectedKey: 'detectedClaudePath', streaming: true, interactive: true, mcp: 'argument' },
  kimi: { id: 'kimi', label: 'Kimi Code', pathKey: 'kimiPath', detectedKey: 'detectedKimiPath', streaming: true, interactive: true, mcp: 'user-config' },
});
let _agentCliPathProbe = new Map(); // type -> { at, value }

function agentCliProbeSpawn(command) {
  const isScript = /\.cjs$/i.test(command);
  const kimiEntry = isScript ? '' : resolveKimiNpmEntry(command);
  const nodeExe = kimiEntry ? bundledNodeExe() : '';
  return isScript ? { command: process.execPath, args: [command, '--version'], opts: {} }
    : (kimiEntry && nodeExe ? { command: nodeExe, args: [kimiEntry, '--version'], opts: {} } : batchSafeSpawn(command, ['--version']));
}
function probeAgentCliLauncher(command) {
  if (!command) return false;
  try {
    const s = agentCliProbeSpawn(command);
    const ok = cp.spawnSync(s.command, s.args, { stdio: 'ignore', windowsHide: true, timeout: 4000, ...s.opts });
    return !ok.error && ok.status === 0;
  } catch { return false; }
}
async function probeAgentCliLauncherAsync(command) {   // 128f-⑬:后台重探用,判据与上面逐字相同
  if (!command) return false;
  try {
    const s = agentCliProbeSpawn(command);
    const ok = await spawnProbeAsync(s.command, s.args, s.opts);
    return !ok.error && ok.status === 0;
  } catch { return false; }
}
function agentCliInstallCandidates(type) {
  const env = process.env;
  const home = os.homedir();
  const npmDir = home && path.join(home, 'AppData', 'Roaming', 'npm');
  if (type === 'kimi') return [
    env.KIMI_CLI_PATH, 'kimi.cmd', 'kimi.exe', 'kimi',
    npmDir && path.join(npmDir, 'kimi.cmd'),
    home && path.join(home, '.local', 'bin', 'kimi.exe'),
    home && path.join(home, '.local', 'bin', 'kimi'),
  ].filter(Boolean);
  return [];
}
function agentCliProbeable(candidate) {
  // Explicit/absolute candidates must exist; bare commands are resolved by the launcher/PATH.
  return !((path.isAbsolute(candidate) || /[\\/]/.test(candidate)) && !fs.existsSync(candidate));
}
function detectAgentCliPath(type) {
  const cached = _agentCliPathProbe.get(type);
  if (cached) {
    // 128f-⑬:过期先答旧值、后台重探(同 detectClaudePath 头注)。
    if (Date.now() - cached.at >= CLAUDEPATH_CACHE_MS) {
      refreshInBackground('agent:' + type, async () => {
        const generation = _cliProbeGeneration;
        let fresh = '';
        for (const candidate of agentCliInstallCandidates(type)) {
          if (!agentCliProbeable(candidate)) continue;
          if (await probeAgentCliLauncherAsync(candidate)) { fresh = candidate; break; }
        }
        if (generation === _cliProbeGeneration) _agentCliPathProbe.set(type, { at: Date.now(), value: fresh });
      });
    }
    return cached.value;
  }
  let value = '';
  for (const candidate of agentCliInstallCandidates(type)) {
    if (!agentCliProbeable(candidate)) continue;
    if (probeAgentCliLauncher(candidate)) { value = candidate; break; }
  }
  _agentCliPathProbe.set(type, { at: Date.now(), value });
  return value;
}
function detectKimiPath() { return detectAgentCliPath('kimi'); }
function selectedAgentCli(config) {
  const type = config && AGENT_CLI_TYPES[config.agentCliType] ? config.agentCliType : 'claude';
  const meta = AGENT_CLI_TYPES[type];
  const detected = type === 'claude' ? detectClaudePath() : detectKimiPath();
  return { ...meta, path: String(config && config[meta.pathKey] || detected || ''), detected };
}
function resolveKimiNpmEntry(command) {
  const raw = String(command || '').trim();
  if (!/(?:^|[\\/])kimi(?:\.(?:cmd|ps1))?$/i.test(raw)) return '';
  let shim = raw;
  if (!path.isAbsolute(shim) && !/[\\/]/.test(shim)) {
    const names = [...new Set([shim, 'kimi.cmd', 'kimi.ps1'])];
    outer: for (const rawDir of String(process.env.PATH || '').split(path.delimiter)) {
      const dir = rawDir.trim().replace(/^"|"$/g, '');
      if (!dir) continue;
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) { shim = candidate; break outer; }
      }
    }
  }
  const dir = path.dirname(path.resolve(shim));
  const entries = [
    path.resolve(dir, '..', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'),
    path.resolve(dir, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'),
  ];
  return entries.find(candidate => fs.existsSync(candidate)) || '';
}
function prepareAgentCliSpawn(type, command, args) {
  const argv = Array.isArray(args) ? args : [];
  if (type === 'kimi') {
    // npm's shim goes through cmd.exe (8191-char ceiling). Resolve its deterministic package-relative entry
    // and launch with Node directly, matching the Claude shim escape hatch's intent. This also handles
    // PowerShell's `kimi.ps1` shim, so a saved terminal launcher behaves the same as `kimi.cmd`.
    const entry = resolveKimiNpmEntry(command);
    const nodeExe = bundledNodeExe();
    // In a packaged release process.execPath is Ruyi.exe, not Node. The offline packages deliberately ship
    // runtime/node/node.exe; use that runtime so the same direct-entry launch works in both source and ZIP builds.
    if (entry && nodeExe) return { command: nodeExe, args: [entry, ...argv], opts: {} };
  }
  return batchSafeSpawn(command, argv);
}
// 128f-⑬:健康检查那一项「选中的 CLI 起不起得来」。修前 computeHealth 每一次都【同步】跑一遍「<cli> --version」、不记忆 ——
// 而 /api/status 每换一次线程就调一次(session-experience openSession),于是换线程这个动作每次都把整个服务钉住一次
// CLI 冷启动。改成异步、按启动器记 60 s(与路径探测同一个记忆期、同一个作废口)。
const _agentCliLauncherOk = new Map();   // command -> { at, value }
async function probeAgentCliLauncherRemembered(command) {
  const generation = _cliProbeGeneration;
  const value = await probeAgentCliLauncherAsync(command);
  if (generation === _cliProbeGeneration) {
    if (_agentCliLauncherOk.size > 32) _agentCliLauncherOk.clear();
    _agentCliLauncherOk.set(command, { at: Date.now(), value });
  }
  return value;
}
async function agentCliLauncherOk(command) {
  if (!command) return false;
  const hit = _agentCliLauncherOk.get(command);
  if (hit) {
    // 过期同样先答上一次的结果、后台重探(与路径探测同一条纪律):/api/status 自己也不该每分钟慢一次 CLI 冷启动。
    if (Date.now() - hit.at >= CLAUDEPATH_CACHE_MS) refreshInBackground('launcher-ok:' + command, () => probeAgentCliLauncherRemembered(command));
    return hit.value;
  }
  return probeAgentCliLauncherRemembered(command);
}
function invalidateAgentCliPathCaches() { invalidateClaudePathCache(); _agentCliPathProbe = new Map(); _agentCliLauncherOk.clear(); }

// Claude Code normally writes UTF-8, but its Windows launcher can forward a local
// command failure in the active ANSI code page.  Decode GB18030 only after UTF-8
// proves invalid; this keeps normal CLI diagnostics byte-for-byte unchanged while
// making the actionable error readable for Chinese Windows installs.
function decodeClaudeCliText(chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
  if (!bytes.length) return '';
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const decoded = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    return decoded || utf8;
  } catch {
    return utf8;
  }
}

// Kimi's official Claude Code setup uses the /coding/ endpoint (including its trailing
// slash) and requires Claude's internal role aliases to resolve to a Kimi model.  Do
// not apply this to generic Anthropic-compatible endpoints: their aliases can have
// vendor-specific meanings.
function isKimiCodingEndpoint(base) {
  try {
    const url = new URL(String(base || '').trim());
    return url.hostname.toLowerCase() === 'api.kimi.com' && url.pathname.replace(/\/+$/, '') === '/coding';
  } catch {
    return false;
  }
}

// Third-party Anthropic-compatible endpoint (e.g. 火山方舟 Ark Coding Plan) config → env overrides.
// Only returns keys the user actually configured in modelsApiBase/modelsApiKey/model — an unconfigured
// field leaves whatever the OS/shell env already has untouched, so an install with no third-party setup
// behaves exactly as before. Config wins over a stale inherited env var so a hot model/endpoint switch in
// the UI can't be silently shadowed by an old `setx`-set value (previously these fields only fed the
// model-LIST discovery probe, never the actually-spawned CLI child — this is the fix for that gap).
// authMode picks which auth header the CLI sees: 'bearer' -> ANTHROPIC_AUTH_TOKEN only (required by Ark
// Coding Plan), 'x-api-key' -> ANTHROPIC_API_KEY only (Anthropic official protocol), 'auto' sets both (a
// safe hedge for an unspecified vendor, matching this function's pre-existing dual-header behavior). When
// a key is configured, the OTHER header is force-cleared — per this project's own admin guide, having both
// present at once makes the CLI pick the wrong auth scheme.
function buildClaudeCliEnv(config) {
  const env = {};
  // Preserve a trailing slash: Kimi's documented Claude Code endpoint is /coding/.
  const base = String((config && config.modelsApiBase) || '').trim();
  const kimiCoding = isKimiCodingEndpoint(base);
  if (base) {
    env.ANTHROPIC_BASE_URL = base;
    // A custom endpoint is moot if the CLI is routed to Bedrock/Vertex instead — both ignore
    // ANTHROPIC_BASE_URL entirely. Clear them so a configured third-party endpoint always wins.
    env.CLAUDE_CODE_USE_BEDROCK = '';
    env.CLAUDE_CODE_USE_VERTEX = '';
  }
  const key = String((config && config.modelsApiKey) || '').trim();
  if (key) {
    const configuredMode = ['bearer', 'x-api-key'].includes(config && config.claudeAuthMode) ? config.claudeAuthMode : 'auto';
    // Kimi documents ANTHROPIC_API_KEY; sending a second auth scheme can make a
    // newer Claude CLI pick a credential path the proxy does not expect.
    const mode = kimiCoding && configuredMode === 'auto' ? 'x-api-key' : configuredMode;
    if (mode === 'bearer') { env.ANTHROPIC_AUTH_TOKEN = key; env.ANTHROPIC_API_KEY = ''; }
    else if (mode === 'x-api-key') { env.ANTHROPIC_API_KEY = key; env.ANTHROPIC_AUTH_TOKEN = ''; }
    else { env.ANTHROPIC_AUTH_TOKEN = key; env.ANTHROPIC_API_KEY = key; }
  }
  const model = String((config && config.model) || '').trim();
  if (model) {
    env.ANTHROPIC_MODEL = model;
    if (kimiCoding) {
      // A native Agent may ask Claude Code for a fast/default family even when the
      // primary model is overridden.  Route every family to the user's selected
      // entitled Kimi model instead of falling back to an unavailable Claude id.
      env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      env.ANTHROPIC_SMALL_FAST_MODEL = model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    }
  }
  return env;
}
// The full env a Claude CLI child (or the model-discovery probe) should see: the process's own env,
// overlaid with the config-driven overrides above. Single source of truth so runClaudeTurn (the real
// spawn) and fetchProxyModels (the model-list probe) can never drift apart on which endpoint is "live".
function effectiveAnthropicEnv(config) {
  return { ...process.env, ...buildClaudeCliEnv(config) };
}

function externalServerJs() {
  const p = path.join(externalRoot(), 'app', 'server.js');
  return fs.existsSync(p) ? p : '';
}

function bundledNodeExe() {
  const p = path.join(externalRoot(), 'runtime', 'node', 'node.exe');
  if (fs.existsSync(p)) return p;
  // When we are already running under node (not the pkg exe), process.execPath IS a node binary.
  if (!isPkg()) return process.execPath;
  return '';
}

// Decide which command a spawned "mcp" stdio server should use. Preferring the node runtime +
// external server.js keeps the MCP server on the *overlaid* source, so new tools (e.g. the
// permission bridge) work without rebuilding the baked exe. mode: auto | node | exe.
function commandForSelfMcp(mode = 'auto') {
  const serverJs = externalServerJs();
  const nodeExe = bundledNodeExe();
  const canNode = Boolean(serverJs && nodeExe);
  if (mode === 'node' && canNode) return { command: nodeExe, args: [serverJs, 'mcp'], via: 'node' };
  if (mode === 'exe') {
    if (isPkg()) return { command: process.execPath, args: ['mcp'], via: 'exe' };
    return { command: process.execPath, args: [path.resolve(__filename), 'mcp'], via: 'node' };
  }
  // auto: prefer node+server.js overlay, then baked exe, then this script under node.
  if (canNode) return { command: nodeExe, args: [serverJs, 'mcp'], via: 'node' };
  if (isPkg()) return { command: process.execPath, args: ['mcp'], via: 'exe' };
  return { command: process.execPath, args: [path.resolve(__filename), 'mcp'], via: 'node' };
}

// --- v0.7d: locate the user's ai-computer-control desktop MCP (Windows control FastMCP). ---
// A python.exe merely existing is not enough: older offline bundles can contain a raw embedded interpreter
// without the MCP package. Verify imports once, cache the result, and prefer a Full runtime whose WinSDK
// OCR projections really import. A core-only source environment remains a last-resort degraded fallback.
const DESKTOP_PYTHON_PROBE_TIMEOUT_MS = 5000;
const DESKTOP_PYTHON_OK_CACHE_MS = 5 * 60 * 1000;
const DESKTOP_PYTHON_MISS_CACHE_MS = 15000;
const DESKTOP_PYTHON_IMPORT_PROBE = [
  'from mcp.server.fastmcp import FastMCP',
  'import ai_computer_control.server',
  'full = True',
  'try:',
  ' import winsdk.windows.media.ocr',
  ' import winsdk.windows.graphics.imaging',
  ' import winsdk.windows.storage.streams',
  ' import winsdk.windows.globalization',
  'except Exception:',
  ' full = False',
  "print('__RUYI_ACC_FULL__' if full else '__RUYI_ACC_CORE__')",
].join('\n');
const desktopPythonCache = new Map(); // repo/root -> { at, value:{command,args,source}|null }
// 128f-③:pickPython 的「只读缓存」模式(深度计数,可嵌套)与「这一轮遇到过未命中」位 —— 见 desktopMcpDetectionPending。
let desktopMcpCacheOnlyDepth = 0;
let desktopMcpCacheMissed = false;
// 121 换机器实测(34 号文 §13.8/§13.10):上面这张表只活在【本进程】。这台机器 python / python3 / py -3
// 三个候选每个要 ~1.7 s 才答得出来(系统 Python 起得慢),而本函数为了优先选 Full 会把候选【全部】探完
// (前两个 miss、第三个 core),于是每个新进程首启都同步阻塞 ~5 s 在 listen 之前;e2e 每件各起一个服务
// 就每件各付 5 s,8 路并发下更慢,66 件在启动预算内起不来。这里把整轮的结果(选中了谁,或整轮没有)
// 跨进程记到 os.tmpdir() 的一个小 JSON,TTL 与进程内那张表同一对数字(肯定 5 分钟、否定 10 分钟——
// 否定放长一点是因为「没装」比「刚装好」常见得多,进程内 15 s 的 miss TTL 到期后会再来读一次磁盘,
// 磁盘条目过期才真探)。肯定结果只在命令是绝对路径且仍存在时才信(被卸载了就当没缓存)。
// 键里带 PATH / PYTHON 环境、根目录、PYTHONPATH、候选清单与探针脚本原文——任何一样变了都是新键。
// 读写都是 best-effort,坏文件/并发写丢条目的后果只是多探一次。
// 测试口(options.probe / options.noCache)一律绕过,与进程内那张表同一条规则。
const DESKTOP_PYTHON_DISK_MISS_CACHE_MS = 10 * 60 * 1000;
const DESKTOP_PYTHON_DISK_CACHE_FILE = 'ruyi-desktop-python-probe.v1.json';
function desktopPythonDiskCachePath() {
  return path.join(os.tmpdir(), DESKTOP_PYTHON_DISK_CACHE_FILE);
}
function desktopPythonDiskCacheId(root, desktopEnv, candidates) {
  const digest = crypto.createHash('sha1');
  digest.update(JSON.stringify([
    String(root || ''),
    String((desktopEnv && desktopEnv.PYTHONPATH) || ''),
    String(process.env.PATH || ''),
    String(process.env.PYTHON || ''),
    DESKTOP_PYTHON_IMPORT_PROBE,
    (Array.isArray(candidates) ? candidates : []).map(candidate => [
      String((candidate && candidate.command) || ''),
      Array.isArray(candidate && candidate.args) ? candidate.args.map(String) : [],
    ]),
  ]));
  return digest.digest('hex');
}
function desktopPythonDiskEntryFresh(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return false;
  const at = Number(entry.at);
  if (!Number.isFinite(at)) return false;
  const ttl = entry.value ? DESKTOP_PYTHON_OK_CACHE_MS : DESKTOP_PYTHON_DISK_MISS_CACHE_MS;
  return (nowMs - at) < ttl;
}
function readDesktopPythonDiskEntries() {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopPythonDiskCachePath(), 'utf8'));
    return parsed && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
  } catch { return {}; }
}
// 返回 { value } 表示命中(value 可以是 null=整轮没有),返回 null 表示没有可信的缓存。
function readDesktopPythonDiskEntry(cacheId) {
  if (!cacheId) return null;
  const entry = readDesktopPythonDiskEntries()[cacheId];
  if (!desktopPythonDiskEntryFresh(entry, Date.now())) return null;
  const value = entry.value && typeof entry.value === 'object' ? entry.value : null;
  if (value) {
    const command = String(value.command || '');
    if (!command) return null;
    try { if (path.isAbsolute(command) && !fs.existsSync(command)) return null; } catch { return null; }
    return { value: { command, args: Array.isArray(value.args) ? value.args.map(String) : [], source: String(value.source || 'unknown'), capability: value.capability === 'full' ? 'full' : 'core' } };
  }
  return { value: null };
}
function writeDesktopPythonDiskEntry(cacheId, value) {
  if (!cacheId) return false;
  try {
    const file = desktopPythonDiskCachePath();
    const entries = readDesktopPythonDiskEntries();
    const nowMs = Date.now();
    for (const id of Object.keys(entries)) {
      if (!desktopPythonDiskEntryFresh(entries[id], nowMs)) delete entries[id];
    }
    entries[cacheId] = { at: nowMs, value: value ? { command: value.command, args: value.args, source: value.source, capability: value.capability } : null };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function desktopPythonCandidates(root) {
  const candidates = [];
  const seen = new Set();
  const addPath = (command, source) => {
    const key = path.resolve(String(command || '')).toLowerCase();
    if (!command || seen.has(key)) return;
    seen.add(key);
    candidates.push({ command, args: [], source, requireExisting: true });
  };
  if (root) {
    // Distribution invariant: a portable Full package must use the CPython 3.12 runtime shipped beside
    // ACC by default. Machine-local venvs/runtimes are compatibility fallbacks, never prerequisites for
    // a package copied to a clean target computer.
    addPath(path.join(root, 'python_embed', 'python.exe'), 'offline-embedded-runtime');
    addPath(path.join(root, 'runtime', 'python', 'python.exe'), 'bundled-runtime');
    addPath(path.join(root, '.venv', 'Scripts', 'python.exe'), 'repo-venv');
    addPath(path.join(root, 'venv', 'Scripts', 'python.exe'), 'installed-venv');
    addPath(path.join(root, 'py-embed', 'python.exe'), 'embedded-runtime');
    addPath(path.join(root, 'python', 'python.exe'), 'repo-python');
  }
  // Source checkouts normally do not carry a Python runtime. Reuse the verified Full installer runtime
  // with PYTHONPATH pointed at the checkout, so development still runs current code without silently
  // dropping OCR just because an unrelated system Python happens to import the core ACC package.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installedRoot = path.join(process.env.LOCALAPPDATA, 'ai-computer-control');
    addPath(path.join(installedRoot, 'runtime', 'python', 'python.exe'), 'installed-full-runtime');
    addPath(path.join(installedRoot, 'venv', 'Scripts', 'python.exe'), 'installed-full-venv');
  }
  const envPython = String(process.env.PYTHON || '').trim();
  if (envPython) candidates.push({ command: envPython, args: [], source: 'PYTHON', requireExisting: path.isAbsolute(envPython) });
  if (process.platform === 'win32') {
    candidates.push(
      { command: 'python', args: [], source: 'system-path', requireExisting: false },
      { command: 'python3', args: [], source: 'system-path', requireExisting: false },
      { command: 'py', args: ['-3'], source: 'python-launcher', requireExisting: false },
    );
  } else {
    candidates.push(
      { command: 'python3', args: [], source: 'system-path', requireExisting: false },
      { command: 'python', args: [], source: 'system-path', requireExisting: false },
    );
  }
  return candidates;
}

function probeDesktopPython(candidate, cwd, desktopEnv) {
  try {
    const result = cp.spawnSync(candidate.command, [...(candidate.args || []), '-X', 'utf8', '-c', DESKTOP_PYTHON_IMPORT_PROBE], {
      cwd: cwd || undefined,
      env: { ...process.env, ...(desktopEnv || {}) },
      windowsHide: true,
      timeout: DESKTOP_PYTHON_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    });
    if (!result || result.error || result.status !== 0) return '';
    return String(result.stdout || '').includes('__RUYI_ACC_FULL__') ? 'full' : 'core';
  } catch { return ''; }
}

// 39 号文:同步探针的异步孪生 —— 同一发 python、同一套超时/解析口径,只是不占住事件循环。
// 用 execFile 而不是 spawn:它与上面那发 spawnSync 一样【不过 shell】(Windows 上对 PATH 里的 .cmd
// 同样 ENOENT,两条路的答案不会分家),而且原生支持 timeout/maxBuffer/encoding,三个口径逐字对齐。
function probeDesktopPythonAsync(candidate, cwd, desktopEnv) {
  return new Promise(resolve => {
    let settled = false;
    const finish = probed => { if (!settled) { settled = true; resolve(probed); } };
    try {
      cp.execFile(candidate.command, [...(candidate.args || []), '-X', 'utf8', '-c', DESKTOP_PYTHON_IMPORT_PROBE], {
        cwd: cwd || undefined,
        env: { ...process.env, ...(desktopEnv || {}) },
        windowsHide: true,
        timeout: DESKTOP_PYTHON_PROBE_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
      }, (err, stdout) => {
        if (err) return finish('');            // 非 0 退出/超时/ENOENT —— 与 spawnSync 那支同判
        finish(String(stdout || '').includes('__RUYI_ACC_FULL__') ? 'full' : 'core');
      });
    } catch { finish(''); }
  });
}

// 下面三件是同步/异步两条选路【共用】的判断,单独抽出来是为了不让两条路在语义上悄悄分家
// (33 号文的老主题:第二份实现迟早与第一份不一样)。
// ① 候选归一 + 「要求存在」那道门;返回 null 表示这个候选直接跳过。
function normalizeDesktopPythonCandidate(raw) {
  const candidate = raw && typeof raw === 'object' ? raw : { command: String(raw || ''), args: [], source: 'unknown', requireExisting: true };
  if (!candidate.command) return null;
  if (candidate.requireExisting !== false) {
    try { if (!fs.existsSync(candidate.command)) return null; } catch { return null; }
  }
  return candidate;
}
// ② 「优先 Full、core 兜底、拿到 Full 就收工」这条挑人规则的唯一实现。offer 返回 true = 可以收工。
function desktopPythonPicker() {
  let selected = null;
  let coreFallback = null;
  return {
    offer(candidate, probed) {
      const capability = probed === 'core' ? 'core' : (probed ? 'full' : '');
      if (!capability) return false;
      const match = { command: candidate.command, args: Array.isArray(candidate.args) ? candidate.args : [], source: candidate.source || 'unknown', capability };
      if (capability === 'full') { selected = match; return true; }
      if (!coreFallback) coreFallback = match;
      return false;
    },
    result() { return selected || coreFallback; },
  };
}
// ③ 两张缓存的读(命中就不必探)与写。跨进程那张见 DESKTOP_PYTHON_DISK_MISS_CACHE_MS 头注:上一轮
// (本进程或别的进程)探过同一把键且还在 TTL 内,就照那一轮的答案;命中也写进进程内表,15 s/5 min
// 内连磁盘都不用读。测试口(options.probe / options.noCache)一律绕过两张表。
function desktopPythonSelectionPlan(repoRoot, desktopEnv, options = {}) {
  const root = String(repoRoot || '');
  const bypassCache = options.noCache === true || typeof options.probe === 'function';
  const cacheKey = root + '\n' + String((desktopEnv && desktopEnv.PYTHONPATH) || '');
  const cached = !bypassCache && desktopPythonCache.get(cacheKey);
  const now = Date.now();
  const ttl = cached && cached.value ? DESKTOP_PYTHON_OK_CACHE_MS : DESKTOP_PYTHON_MISS_CACHE_MS;
  if (cached && (now - cached.at) < ttl) return { hit: true, value: cached.value };

  const candidates = Array.isArray(options.candidates) ? options.candidates : desktopPythonCandidates(root);
  const diskCacheId = bypassCache ? '' : desktopPythonDiskCacheId(root, desktopEnv, candidates);
  const diskHit = diskCacheId ? readDesktopPythonDiskEntry(diskCacheId) : null;
  if (diskHit) {
    desktopPythonCache.set(cacheKey, { at: now, value: diskHit.value });
    return { hit: true, value: diskHit.value };
  }
  return { hit: false, value: null, root, candidates, cacheKey, diskCacheId, bypassCache, at: now };
}
function desktopPythonSelectionStore(selectionPlan, selected) {
  if (selectionPlan.bypassCache) return selected;
  desktopPythonCache.set(selectionPlan.cacheKey, { at: selectionPlan.at, value: selected });
  writeDesktopPythonDiskEntry(selectionPlan.diskCacheId, selected);
  return selected;
}

// Returns the first Full candidate; if none exists, returns the first candidate that can at least import
// the FastMCP server. `options.probe` is a deterministic test seam and may return true/false or full/core.
function pickPython(repoRoot, desktopEnv, options = {}) {
  const selectionPlan = desktopPythonSelectionPlan(repoRoot, desktopEnv, options);
  if (selectionPlan.hit) return selectionPlan.value;
  // 128f-③:「只读缓存」模式(desktopMcpDetectionPending)下缓存未命中只记一笔、不探 —— 调用方据此知道「探测还在飞」。
  if (desktopMcpCacheOnlyDepth > 0) { desktopMcpCacheMissed = true; return null; }
  const probe = typeof options.probe === 'function' ? options.probe : probeDesktopPython;
  const picker = desktopPythonPicker();
  for (const raw of selectionPlan.candidates) {
    const candidate = normalizeDesktopPythonCandidate(raw);
    if (!candidate) continue;
    if (picker.offer(candidate, probe(candidate, selectionPlan.root, desktopEnv))) break;
  }
  return desktopPythonSelectionStore(selectionPlan, picker.result());
}
// 与 pickPython 逐行同形的异步版:同一张计划、同一个 picker、同一处写缓存,只有「怎么问那发 python」
// 不同。写进的缓存就是同步那支读的那两张,所以预热一趟之后同步调用者一发探针都不用付。
async function pickPythonAsync(repoRoot, desktopEnv, options = {}) {
  const selectionPlan = desktopPythonSelectionPlan(repoRoot, desktopEnv, options);
  if (selectionPlan.hit) return selectionPlan.value;
  // TEST HOOK(128f-③):env WCW_TEST_DESKTOP_PROBE_DELAY_MS 只在【真要探】(缓存未命中)时先等一段 —— 「探测在飞」的窗口
  // 因此确定性地存在,而缓存热时照旧零开销(与真机同形:热缓存的预热是瞬时的)。desktop-probe-status／-follow 两件用它;
  // 件里另把 TMP 指到新目录绕开跨进程磁盘缓存。不设即零开销。
  const testDelay = Number(process.env.WCW_TEST_DESKTOP_PROBE_DELAY_MS) || 0;
  if (testDelay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(testDelay, 60000)));
  const probe = typeof options.probe === 'function' ? options.probe : probeDesktopPythonAsync;
  const picker = desktopPythonPicker();
  for (const raw of selectionPlan.candidates) {
    const candidate = normalizeDesktopPythonCandidate(raw);
    if (!candidate) continue;
    if (picker.offer(candidate, await probe(candidate, selectionPlan.root, desktopEnv))) break;
  }
  return desktopPythonSelectionStore(selectionPlan, picker.result());
}
// True when a directory looks like the ai-computer-control repo (has the src package).
function isDesktopMcpRepo(dir) {
  try { return !!dir && fs.existsSync(path.join(dir, 'src', 'ai_computer_control', 'server.py')); }
  catch { return false; }
}
// 环境与产出形状同样是同步/异步共用的单一 owner(见 normalizeDesktopPythonCandidate 头注)。
function desktopMcpRepoEnv(repoRoot) {
  const desktopEnv = { PYTHONPATH: path.join(repoRoot, 'src'), PYTHONUTF8: '1' };
  // Offline releases keep Playwright's browser payload beside the embedded Python runtime. Without
  // this variable Playwright falls back to the user's cache and reports Chromium missing even though
  // the package contains it.
  const bundledBrowsers = path.join(repoRoot, 'playwright_browsers');
  try { if (fs.existsSync(bundledBrowsers)) desktopEnv.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers; }
  catch { /* optional payload; browser tools will degrade gracefully */ }
  return desktopEnv;
}
function desktopMcpEntryFor(selected, cwd, desktopEnv) {
  if (!selected) return null;
  return {
    command: selected.command,
    args: [...selected.args, '-X', 'utf8', '-m', 'ai_computer_control.server'],
    cwd,
    env: desktopEnv,
    via: 'python-module',
    pythonSource: selected.source,
    pythonCapability: selected.capability || 'core',
  };
}
function desktopMcpFromRepo(repoRoot) {
  const desktopEnv = desktopMcpRepoEnv(repoRoot);
  return desktopMcpEntryFor(pickPython(repoRoot, desktopEnv), repoRoot, desktopEnv);
}
async function desktopMcpFromRepoAsync(repoRoot) {
  const desktopEnv = desktopMcpRepoEnv(repoRoot);
  return desktopMcpEntryFor(await pickPythonAsync(repoRoot, desktopEnv), repoRoot, desktopEnv);
}

// The bundled ACC installer writes this layout to %LOCALAPPDATA%\ai-computer-control. It contains an
// installed package rather than a checkout with src/, so it needs its own recognizer.
function desktopMcpInstalledEnv(root) {
  const desktopEnv = { PYTHONUTF8: '1' };
  const bundledBrowsers = path.join(root, 'playwright_browsers');
  try { if (fs.existsSync(bundledBrowsers)) desktopEnv.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers; }
  catch { /* optional payload; browser tools will degrade gracefully */ }
  return desktopEnv;
}
function desktopMcpInstalledPickOptions(root, options) {
  const installedCandidates = [
    { command: path.join(root, 'runtime', 'python', 'python.exe'), args: [], source: 'installed-runtime', requireExisting: true },
    { command: path.join(root, 'venv', 'Scripts', 'python.exe'), args: [], source: 'installed-venv', requireExisting: true },
  ];
  return {
    candidates: Array.isArray(options.candidates) ? options.candidates : installedCandidates,
    probe: typeof options.probe === 'function' ? options.probe : undefined,
    noCache: options.noCache === true,
  };
}
function desktopMcpFromInstalledRoot(installRoot, options = {}) {
  const root = String(installRoot || '').trim();
  if (!root) return null;
  const desktopEnv = desktopMcpInstalledEnv(root);
  return desktopMcpEntryFor(pickPython(root, desktopEnv, desktopMcpInstalledPickOptions(root, options)), root, desktopEnv);
}
async function desktopMcpFromInstalledRootAsync(installRoot, options = {}) {
  const root = String(installRoot || '').trim();
  if (!root) return null;
  const desktopEnv = desktopMcpInstalledEnv(root);
  return desktopMcpEntryFor(await pickPythonAsync(root, desktopEnv, desktopMcpInstalledPickOptions(root, options)), root, desktopEnv);
}
// 39 号文:(a)(b)(c) 三段【看哪些根目录、按什么顺序看】—— 纯枚举,只碰 fs.existsSync,一发探针都不放。
// 同步 detectDesktopMcp 与异步孪生 detectDesktopMcpAsync 走同一份,免得两条路在「先看谁」上分家:
// 预热那趟暖热的必须正好是同步那趟会问的那几把缓存键,否则预热白做。
function desktopMcpRootPlan() {
  const steps = [];
  try {
    const env = process.env;
    const home = os.homedir();
    // (a) explicit env override.
    const envHome = env.AI_COMPUTER_CONTROL_HOME && String(env.AI_COMPUTER_CONTROL_HOME).trim();
    if (envHome) {
      const root = path.resolve(envHome);
      if (isDesktopMcpRepo(root)) steps.push({ kind: 'repo', root });
      steps.push({ kind: 'installed', root });
    }
    // (b) common repo locations. Bundled monorepo copies come first (release layout ships the MCP
    // at <repo>/mcp/ai-computer-control with python_embed beside it and the app at
    // <repo>/ruyi-workbench/app, or flattened with app/ at the package root), so the portable runtime
    // beats both a stale user checkout and any machine-local Python on a clean distribution target.
    const repoCandidates = [
      // In a pkg executable __dirname points into the read-only compile snapshot, while the bundled
      // MCP lives beside Ruyi.exe. externalRoot() resolves that real release directory.
      path.join(externalRoot(), 'mcp', 'ai-computer-control'),
      path.join(__dirname, '..', '..', 'mcp', 'ai-computer-control'),
      path.join(__dirname, '..', 'mcp', 'ai-computer-control'),
      home && path.join(home, 'Documents', 'Claude Code', 'ai-computer-control'),
      home && path.join(home, 'Documents', 'ai-computer-control'),
      home && path.join(home, 'ai-computer-control'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'ai-computer-control'),
      env.USERPROFILE && path.join(env.USERPROFILE, 'Documents', 'Claude Code', 'ai-computer-control'),
    ].filter(Boolean);
    for (const dir of repoCandidates) {
      if (!isDesktopMcpRepo(dir)) continue;
      steps.push({ kind: 'repo', root: path.resolve(dir) });
    }
    // (c) ACC's verified offline installer writes runtime\python; older releases used venv\Scripts.
    const installedRoots = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'ai-computer-control'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'ai-computer-control'),
    ].filter(Boolean);
    for (const root of installedRoots) steps.push({ kind: 'installed', root });
  } catch { /* never throw */ }
  return steps;
}

// (d) 最后一段:PATH 与常见安装目录里的控制台脚本(不需要 checkout)。纯 fs,同步/异步共用。
function desktopMcpConsoleScript() {
  try {
    const env = process.env;
    const home = os.homedir();
    // (d) a console script on PATH or common install dirs (no repo checkout needed).
    const scriptDirs = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'ai-computer-control'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Scripts'),
      env.APPDATA && path.join(env.APPDATA, 'Python', 'Scripts'),
      home && path.join(home, '.local', 'bin'),
    ].filter(Boolean);
    // Also honor PATH entries.
    const pathDirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    const scriptNames = ['ai-computer-control.exe', 'ai-computer-control.cmd', 'ai-computer-control.bat', 'ai-computer-control'];
    for (const dir of [...scriptDirs, ...pathDirs]) {
      for (const n of scriptNames) {
        const full = path.join(dir, n);
        try { if (fs.existsSync(full)) return { command: full, args: [], cwd: undefined, env: { PYTHONUTF8: '1' }, via: 'console-script' }; }
        catch { /* keep scanning */ }
      }
    }
  } catch { /* never throw */ }
  return null;
}

// 同步签名【保留】(39 号文 §2 的拍板):它的调用方是 resolveExternalMcpServers 一族,那一族散在 8 个模块
// 12 处、连静态件都同步调,全改 async 是一次跨模块大手术,而要治的病(探针占住事件循环)靠「预热走异步、
// 同步这支只吃缓存」就治得掉。冷缓存时它仍会同步探一轮 —— 那是兜底路径,不是正常路径。
function detectDesktopMcp() {
  try {
    for (const step of desktopMcpRootPlan()) {
      const detected = step.kind === 'repo' ? desktopMcpFromRepo(step.root) : desktopMcpFromInstalledRoot(step.root);
      if (detected) return detected;
    }
    return desktopMcpConsoleScript();
  } catch { /* never throw */ }
  return null;
}
// 异步孪生:同一份根目录计划、同一套挑人规则,只是每发探针都让出事件循环。它写进的两张缓存
// 正是同步那支要读的,所以预热跑完之后,同步调用者一发 spawnSync 都不用付。
async function detectDesktopMcpAsync() {
  try {
    for (const step of desktopMcpRootPlan()) {
      const detected = step.kind === 'repo' ? await desktopMcpFromRepoAsync(step.root) : await desktopMcpFromInstalledRootAsync(step.root);
      if (detected) return detected;
    }
    return desktopMcpConsoleScript();
  } catch { /* never throw */ }
  return null;
}
// 只有「会走 autodetect」的配置才值得预热:显式 command 覆盖、或整块停用时,两条读路
// (resolveExternalMcpServers 与 buildMcpConnectorInventory)本来就一发探针都不放 ——
// 预热更不该放(04 的 55a 注释:「禁用时不应阻塞 GET 清单」)。两条读路的门一严一松
// (一处 `dm.enabled`、一处 `dm.enabled !== false`),这里取松的那个,才不会漏热。
function desktopMcpAutodetectWanted(config) {
  const dm = config && config.desktopMcp;
  if (!dm || dm.enabled === false) return false;
  if (String(dm.command || '').trim()) return false;
  return !!dm.autodetect;
}
// 唯一一处「主动去探」的入口。并发调用共用同一趟(启动预热与首个 /api/status 常常撞在一起)。
// 缓存还热时它连 spawn 都不会发生,所以可以随手 await,不必自己判「该不该预热了」。
// 拿不到 config 时一律不预热:退回旧的同步兜底,绝不因为「没人告诉我」就多探一轮。
let desktopMcpWarmInFlight = null;
function ensureDesktopMcpWarm(config) {
  if (!desktopMcpAutodetectWanted(config)) return Promise.resolve(null);
  if (desktopMcpWarmInFlight) return desktopMcpWarmInFlight;
  desktopMcpWarmInFlight = detectDesktopMcpAsync()
    .catch(() => null)
    .then(detected => { desktopMcpWarmInFlight = null; return detected; });
  return desktopMcpWarmInFlight;
}
// 128f-③(48 号文 §2-c):「桌面组件的 Python 探测此刻还在飞吗」—— 不另写一套判据,就用同一个 detectDesktopMcp()
// 在【只读缓存】模式下跑一遍:pickPython 遇到缓存未命中只记一笔、不探(见它开头那两行)。记到了 = 在飞(缓存冷),
// 顺手踢一脚预热(幂等,与启动那一趟共用同一个 Promise)。/api/status 据此不等、也不走同步探针 ——
// 修前它三处 await 预热,Full 包里那一趟是内嵌 Python 导入 FastMCP,整个界面跟着等 3–9 s(隔 5 分钟以上的每次启动都要付)。
function desktopMcpDetectionPending(config) {
  if (!desktopMcpAutodetectWanted(config)) return false;
  desktopMcpCacheOnlyDepth += 1;
  desktopMcpCacheMissed = false;
  try { detectDesktopMcp(); }
  finally { desktopMcpCacheOnlyDepth -= 1; }
  const pending = desktopMcpCacheMissed;
  desktopMcpCacheMissed = false;
  if (pending) void ensureDesktopMcpWarm(config);
  return pending;
}

// Runtime coordinates for loopback callbacks (permission bridge). Set in startServer().
// v0.8-S2: isMcpChild is set true only in startMcp() — the one-shot MCP subprocess the Claude CLI spawns.
// Shell-session tools guard on it: their state lives in the serve process, so the child cannot serve them.
const RUNTIME = { port: DEFAULT_PORT, host: '127.0.0.1', token: '', isMcpChild: false };

// v0.7d: mutate an mcpServers map in place, adding the desktop MCP (id 'ai-computer-control') and every
// enabled user externalMcpServers entry. Back-compat: when nothing is detected/configured, the map is
// left exactly as it was, so the generated config equals the pre-0.7d output.
function addExternalMcpServersToMap(mcpServers, config) {
  if (!config) return;
  try {
    for (const entry of resolveExternalMcpServers(config)) {
      if (mcpServers[entry.id]) continue;    // never clobber win-claude-workbench or an earlier entry
      let server;
      if (entry.transport === 'sse' || entry.transport === 'http') {
        server = { type: entry.transport, url: entry.url };
        if (entry.headers && Object.keys(entry.headers).length) server.headers = entry.headers;
        if (entry.bearerTokenEnvVar) server.bearerTokenEnvVar = entry.bearerTokenEnvVar;
      } else {
        server = { type: 'stdio', command: entry.command, args: entry.args || [] };
        if (entry.cwd) server.cwd = entry.cwd;
        if (entry.env && Object.keys(entry.env).length) server.env = entry.env;
      }
      mcpServers[entry.id] = server;
    }
  } catch { /* detection must never break config generation */ }
}

// 生成的 MCP 配置文件路径(唯一一处拼它)。128f-③:探测在飞时 /api/status 只回这条路径、不重新生成。
function mcpConfigFilePath() { return path.join(paths.generated, 'workbench.mcp.json'); }
async function generateMcpConfig(mode) {
  await ensureDirs();
  const cfg = await readConfig().catch(() => null);
  // 39 号文:本函数下面 addExternalMcpServersToMap → resolveExternalMcpServers → detectDesktopMcp 是
  // 【同步】的,冷缓存时会把整个进程钉住一轮探针。它自己是 async,所以先等那趟异步预热——
  // 实测就是这一处:只在 /api/status 的 desktopMcp 那一段等预热不够,mcpConfigPath 排在它【前面】,
  // 同一个响应里先被这一处堵住(boot-listen-budget 的「探针在飞时 /health 秒答」因此偶红)。
  // 排在 readConfig 之后,是因为「该不该预热」要看 config(停用/显式覆盖时一发都不放)。
  await ensureDesktopMcpWarm(cfg);
  if (!mode) mode = cfg?.mcpCommandMode || 'auto';
  const self = commandForSelfMcp(mode);
  const configPath = mcpConfigFilePath();
  const mcp = {
    mcpServers: {
      // 【存量兼容标识 — 发布后至少保留一个大版本】MCP server id 'win-claude-workbench' 已写进用户的
      // .mcp.json;硬改会断存量接入。v1.0-S9 发布确认:保持不变(建议 v2.0 评估加别名 ruyi-workbench 双写后收口)。
      'win-claude-workbench': {
        type: 'stdio',
        command: self.command,
        args: self.args,
        env: {
          // 【存量兼容标识】env 变量名保持旧名(子进程/桥接照常工作),值=已解析 dataRoot。
          WIN_CLAUDE_WORKBENCH_HOME: paths.data,
        },
      },
    },
  };
  addExternalMcpServersToMap(mcp.mcpServers, cfg);
  await atomicWriteJson(configPath, mcp);
  return configPath;
}

// Per-session MCP config that injects the session id + loopback port/token into the MCP child's env,
// so the permission-bridge tool (running in that child) can call back and be routed to the right UI stream.
async function generateSessionMcpConfig(sessionId, mode, toolPacks) {
  await ensureDirs();
  const cfg = await readConfig().catch(() => null);
  if (!mode) mode = cfg?.mcpCommandMode || 'auto';
  const self = commandForSelfMcp(mode);
  const configPath = path.join(paths.generated, `workbench.mcp.${sessionId}.json`);
  const mcp = {
    mcpServers: {
      // 【存量兼容标识 — 发布后至少保留一个大版本】同 generateMcpConfig:MCP server id 保持 'win-claude-workbench'(v1.0-S9 确认)。
      'win-claude-workbench': {
        type: 'stdio',
        command: self.command,
        args: self.args,
        env: {
          WIN_CLAUDE_WORKBENCH_HOME: paths.data, // 【存量兼容标识】env 变量名保持旧名
          WCW_SESSION_ID: sessionId,
          WCW_PORT: String(RUNTIME.port),
          WCW_HOST: RUNTIME.host,
          WCW_TOKEN: RUNTIME.token,
          WCW_TOOL_LOADING_MODE: cfg?.toolLoadingMode || 'auto',
          WCW_TOOL_PACKS: Array.isArray(toolPacks) ? toolPacks.join(',') : '',
        },
      },
    },
  };
  // In adaptive mode external schemas stay behind the typed invoke proxies, so a simple Claude turn
  // does not ingest an entire desktop/Office catalog. Full mode retains the historical direct servers.
  if (!cfg || cfg.toolLoadingMode === 'full') addExternalMcpServersToMap(mcp.mcpServers, cfg);
  await atomicWriteJson(configPath, mcp);
  return configPath;
}

// One-shot analog of generateSessionMcpConfig for a DAG node's Claude-engine spawn (runClaudeSubAgentOnce)
// — same content, keyed by subagentId instead of a session id. When allowedServerIds is a non-empty array
// (role.mcpServers) the config is narrowed to just those server ids, mirroring the OpenAI subagent path's
// own rule (runSubAgentCore): an explicit mcpServers list restricts which bridged servers a node can reach;
// leaving it unset/empty means "everything the workbench has configured" for exec-tier nodes.
async function generateAgentNodeMcpConfig(subagentId, mode, allowedServerIds) {
  const configPath = await generateSessionMcpConfig(subagentId, mode, Object.keys(TOOL_PACK_DESCRIPTIONS));
  try {
    const raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    const own = raw.mcpServers && raw.mcpServers['win-claude-workbench'];
    if (own) own.env = { ...(own.env || {}), WCW_DISABLE_USER_INPUT: '1' };
    // This helper is used only for exec-tier Claude nodes. Preserve their explicit direct-MCP contract;
    // the main interactive Claude path uses adaptive proxies instead.
    addExternalMcpServersToMap(raw.mcpServers, await readConfig().catch(() => null));
    if (Array.isArray(allowedServerIds) && allowedServerIds.length) {
      const allowed = new Set(allowedServerIds);
      raw.mcpServers = Object.fromEntries(Object.entries(raw.mcpServers || {}).filter(([id]) => allowed.has(id)));
    }
    await atomicWriteJson(configPath, raw);
  } catch { /* best-effort — fall through with the unfiltered config rather than fail the node */ }
  return configPath;
}

// --- Interactive stream-json envelopes (defensive; exact shapes are underdocumented). ---
function buildUserEnvelope(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text || '') }] } };
}
function writeToChild(sessionId, obj) {
  const reg = activeChildren.get(sessionId);
  if (!reg || !reg.child || !reg.child.stdin.writable) return false;
  try { reg.child.stdin.write(JSON.stringify(obj) + '\n', 'utf8'); return true; } catch { return false; }
}
// Tools the workbench OWNS the interactive answer for (never intercept tools the CLI runs itself).
function isAskUserTool(name) {
  return typeof name === 'string' && name.replace(/[^a-z]/gi, '').toLowerCase().includes('askuserquestion');
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function send(res, response) {
  res.writeHead(response.status || 200, response.headers || {});
  res.end(response.body || '');
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  send(res, apiFailure('api.internal_error', {}, err.message || String(err), status));
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';
}

function staticBase() {
  const ext = path.join(externalRoot(), 'app', 'public');
  if (fs.existsSync(ext)) return ext;
  return path.join(__dirname, 'public');
}

async function serveStatic(urlPath, req) {
  const base = staticBase();
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.normalize(path.join(base, rel));
  // 第36波(v1.7): 改用 pathWithinRoot 的段比较 —— 此前 startsWith 前缀判定与 pathWithinRoot 注释里批评的
  // classic prefix bug 同款(public-evil/ 这类同级兄弟目录可越界)。
  if (!pathWithinRoot(full, path.normalize(base))) return text('Forbidden', 403);
  try {
    // Inject the per-server token into the HTML shell so the UI can authenticate its /api calls.
    if (full.toLowerCase().endsWith('index.html')) {
      // 47c(S1):浏览器导航不再随 HTML 明文下发 token(token 只在内存 + sessionStorage,view-source/
      // 缓存/抓包 HTML 均不可得)—— 改 bootstrap 握手(app.js 启动时 POST /api/bootstrap 换取)。
      // 非浏览器调用方(curl/node e2e/MCP child:无 Sec-Fetch、无 Origin、非 Mozilla UA)保持 meta
      // 注入兼容。浏览器导航信号任一命中即判浏览器:Sec-Fetch-Dest / Origin / Mozilla UA。
      const h = (req && req.headers) || {};
      const browserNav = Boolean(h['sec-fetch-dest']) || Boolean(h.origin) || /mozilla/i.test(String(h['user-agent'] || ''));
      const html = (await fsp.readFile(full, 'utf8')).replace('__WCW_TOKEN__', browserNav ? '' : (RUNTIME.token || ''));
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: html };
    }
    const body = await fsp.readFile(full);
    // v1.0.2 返修二:静态资产此前【零缓存头】—— 浏览器可能沿用缓存的旧 app.js/styles.css,用户换了新包
    // 却仍跑旧前端,一切修复"看起来都没修"(真机反馈坐实的怀疑路径)。产品模型是 overlay 增量更新,
    // 静态资产必须即时生效:与 index.html 一致,一律 no-store(本地回环,重取零网络成本)。
    return { status: 200, headers: { 'content-type': contentTypeFor(full), 'cache-control': 'no-store' }, body };
  } catch {
    return text('Not found', 404);
  }
}

// CSRF/local-RCE defense. Same-origin browser requests carry a matching Origin; cross-site pages
// carry a foreign Origin (reject). Non-browser callers (curl, the MCP child) carry no Origin.
// v1.4.6-S1 (DNS-rebinding defense): the Host header MUST be exactly this local server's loopback
// authority. A DNS-rebinding page reaches us with Host = attacker-domain:port (its own Origin would then
// "self-match" that Host, which is why the old self-consistency check let it through). By pinning Host to
// 127.0.0.1/localhost/[::1] : RUNTIME.port we reject any rebound name outright. Node/CLI callers connect
// straight to 127.0.0.1:port, so their Host header already matches — no legitimate caller is affected.
function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const p = RUNTIME.port;
  return host === `127.0.0.1:${p}` || host === `localhost:${p}` || host === `[::1]:${p}`;
}
function originOk(req) {
  // Host allowlist FIRST — this is the DNS-rebinding gate and applies even when no Origin is present.
  if (!hostAllowed(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // no Origin => not a browser cross-site request
  const host = req.headers.host || `${RUNTIME.host}:${RUNTIME.port}`;
  try { return new URL(origin).host === host; } catch { return false; }
}
function tokenOk(req) {
  return Boolean(RUNTIME.token) && req.headers['x-wcw-token'] === RUNTIME.token;
}
// 第33波:声明式 auth 路由表 + deny-by-default(治 S0 教训 opt-in 名单根因 + 第29波 backlog #0 GET 面)。
// authorizeRoute 对 handleApi 每个路由按 ROUTE_AUTH first-match 判定鉴权级别;未匹配 -> 拒(403)。
// 级别:open(低敏读)/origin(同源或 loopback 非浏览器)/token(始终 tokenOk)/
//      token-browser(浏览器须 token,loopback 须同源,与 v1.4.6-S1 纪律一致)/body-token(handler 自查 body token)。
// 14 处 handler 内 tokenOk 自查保留作纵深(表为主、自查兜底误分类);Host 门在 HTTP handler 顶层 hostAllowed(全请求)。
// 110-2a: ROUTE_AUTH 路由鉴权表抽至 01b-route-auth.js。
function authorizeRoute(req, method, pathname) {
  const m = method === 'HEAD' ? 'GET' : method;
  const browser = Boolean(req.headers.origin) || Boolean(req.headers['sec-fetch-site']) || Boolean(req.headers['sec-fetch-mode']);
  for (const r of ROUTE_AUTH) {
    if (r.m !== '*' && r.m !== m) continue;
    const match = r.prefix ? pathname.startsWith(r.p) : pathname === r.p;
    if (!match) continue;
    switch (r.auth) {
      case 'open': return null;
      case 'origin': return originOk(req) ? null : 'cross-origin request rejected';
      case 'token': return tokenOk(req) ? null : 'missing or invalid workbench token';
      case 'token-browser':
        if (browser) return tokenOk(req) ? null : 'missing or invalid workbench token';
        return originOk(req) ? null : 'cross-origin request rejected';
      case 'body-token': return null;
      default: return 'unknown auth level';
    }
  }
  return 'route not authorized';
}
// F4 (安全·消毒): accept only a well-formed session id. Returns the id unchanged when it matches the
// canonical shape (letters/digits/_/-, 1..64), else null. Real ids look like `session_<hex>` → pass
// naturally. Callers treat null as a 400. Blocks path-ish / oversized / control-char ids from ever
// reaching loadSession / journal / activeChildren lookups.
function safeSessionId(raw) {
  const s = String(raw == null ? '' : raw);
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

function sessionPath(id) {
  return path.join(paths.sessions, `${id}.json`);
}
// 第25波对抗轮: per-session 写链(见 saveSession)—— 与 agentRunWriteChains 同范式。
const sessionWriteChains = new Map();
