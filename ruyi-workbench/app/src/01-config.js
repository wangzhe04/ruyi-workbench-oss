function defaultConfig() {
  return {
    configSchema: CONFIG_SCHEMA,
    version: VERSION,
    claudePath: detectClaudePath(),
    defaultWorkspace: os.homedir(),
    permissionMode: 'default',
    includeWorkbenchMcp: true,
    autoResumeClaudeSessions: true,
    model: '',
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
    betaInterleavedThinking: false, // adds --betas interleaved-thinking (probe first; may be rejected by older CLI)
    mcpCommandMode: 'auto',       // auto | node | exe — which command the generated MCP config points at
    killOnDisconnect: true,       // taskkill the claude child when the UI aborts/disconnects
    killPortOnStart: true,        // on startup, if the port is held by a STALE workbench, free it and retry
    // --- v0.4 additions (interactive engine + permission bridge) ---
    engineMode: 'interactive',    // legacy (stdin closed, safe) | interactive (stdin kept open: AskUserQuestion + permission bridge)
    permissionBridge: true,       // route tool-permission prompts to the UI via --permission-prompt-tool (needs a non-bypass permission mode)
    permissionTimeoutMs: 120000,  // how long a permission/question prompt waits before auto-deny
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
    // Master switch for line 2: also expose external/desktop MCP tools to the NATIVE provider tool loop
    // (bridged via an in-process MCP stdio client). Off => providers see only the workbench's own tools.
    bridgeExternalToolsToProvider: true,
    // Adaptive tool loading keeps only task-relevant schemas in the model context. `full` is the
    // compatibility escape hatch; `auto` pre-routes common packs and exposes compact discovery tools.
    toolLoadingMode: 'auto',       // auto | full
    toolCatalogCacheTtlMs: 60000,  // bridged catalog reuse; clamp 5s..10min
    // v1.1-W2 (T2): auto-scan drop-in MCP connectors from <repo>/mcp/*/ruyi-mcp.json and
    // <dataRoot>/mcp/*/ruyi-mcp.json and runtime-merge them (never written to config; delete the folder to
    // uninstall). Default on. Off => only config.externalMcpServers + desktopMcp are used.
    enableMcpDropIn: true,
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
    // v1.4.4: max nodes a persisted Agent 工作流 DAG may have (both a fresh /api/agent-workflow/launch and
    // a resumed run). Previously the fresh-launch path wrongly reused subagentMaxPerTurn (a per-CHAT-TURN
    // ad hoc fan-out budget) as the DAG's node-count ceiling — a 4-node default rejected any real pipeline
    // with 5+ nodes outright, while resuming the SAME run used a hardcoded 32. 第23波起 Clamp 1..64、默认 48
    // (64 is also the hard systemic cap in runAgentWorkflow's own `.slice(0, 64)` and the orchestrate_agents
    // schema's maxItems — 第36波(v1.7) 三方对齐, 此前注释与 schema 仍写 32 是漂移)。
    agentWorkflowMaxNodes: 48,
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
const AGENT_ROLE_PERMISSION_MODES = ['inherit', 'default', 'acceptEdits', 'dontAsk', 'bypass', 'plan', 'auto'];
// v1.4.3: Canonical mapping from workbench-internal mode names to Claude CLI mode names.
// 'bypass' -> 'bypassPermissions'; 'auto' is a CLI-native name (no alias needed).
// Used by BOTH the --permission-mode flag construction AND syncClaudeCliSettings (single source of truth).
const CLAUDE_PERMISSION_MODE_MAP = { bypass: 'bypassPermissions', default: 'default', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', dontAsk: 'dontAsk' };
// Accept these CLI-native names as aliases when loading config (so users / external tools that write
// 'bypassPermissions' directly into config.json are not silently reset to 'bypass').
const PERMISSION_MODE_ALIASES = { bypassPermissions: 'bypass' };
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

// Fold older config files onto the current schema. Returns { config, changed }.
function normalizeConfig(raw) {
  const config = { ...defaultConfig(), ...(raw && typeof raw === 'object' ? raw : {}) };
  let changed = !raw || raw.configSchema !== CONFIG_SCHEMA;
  // P1(cmd8191 根治): npm shim(claude.cmd)→ 真身 claude.exe 的运行时解析(见 resolveClaudeLauncher)。
  // 收拢在这一个咽喉点 = 全部消费方(runClaudeTurn/子代理/mcp add-json/doctor)一致受益。不置 changed:
  // 解析是纯运行时升级,配置里保留用户原值,exe 消失时下一次解析自动回落 shim。结果 memoize,热路径零探测。
  config.claudePath = resolveClaudeLauncher(config.claudePath);
  // v1.4.3: accept CLI-native mode name 'bypassPermissions' as alias for 'bypass'
  if (PERMISSION_MODE_ALIASES[config.permissionMode]) {
    config.permissionMode = PERMISSION_MODE_ALIASES[config.permissionMode];
    changed = true;
  }
  if (!PERMISSION_MODES.includes(config.permissionMode)) {
    config.permissionMode = 'bypass';
    changed = true;
  }
  if (!['auto', 'zh-CN', 'en-US'].includes(config.locale)) {
    config.locale = 'auto';
    changed = true;
  }
  // Only string args reach cp.spawn — filter out anything else (prevents a spawn TypeError/DoS and
  // stops a config-injection from smuggling non-string payloads).
  if (!Array.isArray(config.extraClaudeArgs) || config.extraClaudeArgs.some(a => typeof a !== 'string')) {
    config.extraClaudeArgs = Array.isArray(config.extraClaudeArgs) ? config.extraClaudeArgs.filter(a => typeof a === 'string') : [];
    changed = true;
  }
  // Clamp numeric timeouts to sane ranges (a non-numeric value must never disable the watchdog).
  const pt = Number(config.permissionTimeoutMs);
  config.permissionTimeoutMs = Number.isFinite(pt) ? Math.min(600000, Math.max(5000, pt)) : 120000;
  const it = Number(config.turnIdleTimeoutMs);
  config.turnIdleTimeoutMs = Number.isFinite(it) ? Math.min(3600000, Math.max(60000, it)) : 600000;
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
  if (config.bridgeExternalToolsToProvider !== false) config.bridgeExternalToolsToProvider = true;
  else config.bridgeExternalToolsToProvider = false;
  if (!['auto', 'full'].includes(config.toolLoadingMode)) { config.toolLoadingMode = 'auto'; changed = true; }
  {
    const ttl = Number(config.toolCatalogCacheTtlMs);
    const clamped = Number.isFinite(ttl) ? Math.min(600000, Math.max(5000, Math.round(ttl))) : 60000;
    if (clamped !== config.toolCatalogCacheTtlMs) { config.toolCatalogCacheTtlMs = clamped; changed = true; }
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
      const s = w.trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(s.slice(0, 1000));
      if (clean.length >= 10) break;
    }
    if (JSON.stringify(clean) !== JSON.stringify(config.recentWorkspaces)) { config.recentWorkspaces = clean; changed = true; }
    else config.recentWorkspaces = clean;
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
      baseUrl: typeof raw0.baseUrl === 'string' ? raw0.baseUrl.trim().slice(0, 1000) : '',
      apiKey: typeof raw0.apiKey === 'string' ? raw0.apiKey.slice(0, 2048) : '',
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
  return { config, changed };
}

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

// v1.4.1 (audit #4): config.json 原子写 —— 此前用裸 fsp.writeFile,崩溃/断电中途会留下截断文件,下次读
// safeJsonParse→null → normalizeConfig 把【整份用户配置静默重置为默认】(密钥/服务商/工作区全丢)。
// 第25波 25.1: 写体收编进 atomicWriteJson;对抗轮修: 全局写链串行化并发 config 写(同 saveSession 理由——
// 重试窗口下旧载荷不得迟到覆写新载荷)。
let configWriteChain = Promise.resolve();
async function writeConfigAtomic(data) {
  const thisWrite = configWriteChain.catch(() => {}).then(() => atomicWriteJson(paths.config, data));
  configWriteChain = thisWrite;
  await thisWrite;
}
// 48b(P1) readConfig 内存缓存 -- 经对抗验证【回退】。根因:5 件 e2e(usage-ledger/skills-registry/
// workbench-memory/vision-loop/subagent)直接 fs 写 config.json 切换 provider/配置,依赖 readConfig 每次
// 读盘拾取(usage-ledger:137 注释明述"readConfig is uncached -> picked up");缓存让这些直接写不可见。
// 生产环境 config 变更走 POST /api/config(writeConfig 可失效缓存)故缓存对生产正确,但测试直接写是合法
// 提速捷径,且 mutate 别名隐患(structuredClone 仅治标),perf 收益(小 config + OS 已缓存磁盘读)不抵
// 5 件回归 + 风险。05 方案 P1 留作后续:若重做须先把 e2e 改用 POST /api/config(镜像生产)或加 mtime 失效。
async function readConfig() {
  await ensureDirs();
  let raw = null;
  try {
    raw = safeJsonParse(await fsp.readFile(paths.config, 'utf8'), null);
  } catch {
    raw = null;
  }
  const { config, changed } = normalizeConfig(raw);
  // Only rewrite when a migration actually mutated the file (avoid racy write-on-every-read).
  if (changed) await writeConfigAtomic(JSON.stringify(config, null, 2)).catch(() => {});
  return config;
}

async function writeConfig(next) {
  await ensureDirs();
  const { config } = normalizeConfig(next);
  await writeConfigAtomic(JSON.stringify(config, null, 2));
  return config;
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
    if (!config.claudePath || !existsExecutable(config.claudePath)) return;
    var servers = resolveExternalMcpServers(config);
    for (var s of servers) {
      if (!s.id || !s.command) continue;
      var sc = { type: 'stdio', command: s.command, args: s.args || [], env: s.env || {} };
      if (s.cwd) sc.cwd = s.cwd;
      try { await runProcess(config.claudePath, ['mcp', 'add-json', s.id, JSON.stringify(sc), '-s', 'user'], { timeoutMs: 10000 }); } catch {}
    }
  } catch { /* non-fatal */ }
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
function resolveClaudeLauncher(launcher) {
  const p = String(launcher || '').trim();
  if (!p || process.platform !== 'win32' || !isBatchLauncher(p)) return launcher;
  const now = Date.now();
  const hit = _launcherResolveCache.get(p);
  if (hit && (now - hit.at) < CLAUDEPATH_CACHE_MS) return hit.value;
  let value = launcher; // 默认:原样返回(解析不出 = 保持现状)
  try {
    // 定位 shim 实体:含目录分隔符的按路径 resolve;裸名字(claude.cmd)沿 PATH 逐目录找。
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
    if (shim && fs.existsSync(shim)) {
      const exe = path.join(path.dirname(shim), CLAUDE_NPM_EXE_REL);
      if (fs.existsSync(exe)) {
        // 真身探测:--version 能跑通才接管(防半截 npm 安装留下坏 exe);失败保持 shim 回退。
        const ok = cp.spawnSync(exe, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 4000 });
        if (!ok.error && ok.status !== null) value = exe;
      }
    }
  } catch { /* 解析失败 = 保持原启动器 */ }
  if (_launcherResolveCache.size > 32) _launcherResolveCache = new Map(); // 防无界(实际路径集合极小)
  _launcherResolveCache.set(p, { at: now, value });
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
let _claudePathProbe = null; // { at:number, value:string }
const CLAUDEPATH_CACHE_MS = 60000;
function detectClaudePathUncached() {
  const onPath = [process.env.CLAUDE_CLI_PATH, 'claude.cmd', 'claude.exe', 'claude'].filter(Boolean);
  // First try PATH-resolvable names (fast, common case).
  for (const c of onPath) {
    try {
      const s = batchSafeSpawn(c, ['--version']);
      const ok = cp.spawnSync(s.command, s.args, { stdio: 'ignore', windowsHide: true, timeout: 4000, ...s.opts });
      // P1: shim(claude.cmd)命中时优先解析出真身 claude.exe(绕过 cmd.exe 8191 上限);解析不出原样返回。
      if (!ok.error && ok.status !== null) return resolveClaudeLauncher(c);
    } catch {
      // keep scanning
    }
  }
  // Then scan common install locations (bounded, best-effort).
  for (const full of claudeInstallCandidates()) {
    try {
      if (!fs.existsSync(full)) continue;
      const s = batchSafeSpawn(full, ['--version']);
      const ok = cp.spawnSync(s.command, s.args, { stdio: 'ignore', windowsHide: true, timeout: 4000, ...s.opts });
      if (!ok.error && ok.status !== null) return resolveClaudeLauncher(full);
    } catch {
      // keep scanning
    }
  }
  return '';
}
function detectClaudePath() {
  const now = Date.now();
  if (_claudePathProbe && (now - _claudePathProbe.at) < CLAUDEPATH_CACHE_MS) return _claudePathProbe.value;
  const value = detectClaudePathUncached();
  _claudePathProbe = { at: now, value };
  return value;
}
// v1.0-S7: let a settings save / explicit "re-detect CLI" action force a fresh probe (e.g. the user just
// installed the CLI). Exported for the doctor/status path — a no-op if never called.
function invalidateClaudePathCache() { _claudePathProbe = null; }

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
// without the MCP package. Verify imports once, cache the result, and fall back to a usable system runtime.
const DESKTOP_PYTHON_PROBE_TIMEOUT_MS = 5000;
const DESKTOP_PYTHON_OK_CACHE_MS = 5 * 60 * 1000;
const DESKTOP_PYTHON_MISS_CACHE_MS = 15000;
const DESKTOP_PYTHON_IMPORT_PROBE = 'from mcp.server.fastmcp import FastMCP; import ai_computer_control.server';
const desktopPythonCache = new Map(); // repo/root -> { at, value:{command,args,source}|null }

function desktopPythonCandidates(root) {
  const candidates = [];
  const addPath = (command, source) => candidates.push({ command, args: [], source, requireExisting: true });
  if (root) {
    // A real venv is normally the installer output, so prefer it over a bundled interpreter.
    addPath(path.join(root, '.venv', 'Scripts', 'python.exe'), 'repo-venv');
    addPath(path.join(root, 'venv', 'Scripts', 'python.exe'), 'installed-venv');
    addPath(path.join(root, 'runtime', 'python', 'python.exe'), 'bundled-runtime');
    addPath(path.join(root, 'python_embed', 'python.exe'), 'offline-embedded-runtime');
    addPath(path.join(root, 'py-embed', 'python.exe'), 'embedded-runtime');
    addPath(path.join(root, 'python', 'python.exe'), 'repo-python');
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
    return !!(result && !result.error && result.status === 0);
  } catch { return false; }
}

// Returns the first candidate that can actually import the FastMCP server, or null. `options.probe` is a
// deterministic test seam; normal callers use a short-lived cache so status polling never repeats probes.
function pickPython(repoRoot, desktopEnv, options = {}) {
  const root = String(repoRoot || '');
  const bypassCache = options.noCache === true || typeof options.probe === 'function';
  const cacheKey = root + '\n' + String((desktopEnv && desktopEnv.PYTHONPATH) || '');
  const cached = !bypassCache && desktopPythonCache.get(cacheKey);
  const now = Date.now();
  const ttl = cached && cached.value ? DESKTOP_PYTHON_OK_CACHE_MS : DESKTOP_PYTHON_MISS_CACHE_MS;
  if (cached && (now - cached.at) < ttl) return cached.value;

  const candidates = Array.isArray(options.candidates) ? options.candidates : desktopPythonCandidates(root);
  const probe = typeof options.probe === 'function' ? options.probe : probeDesktopPython;
  let selected = null;
  for (const raw of candidates) {
    const candidate = raw && typeof raw === 'object' ? raw : { command: String(raw || ''), args: [], source: 'unknown', requireExisting: true };
    if (!candidate.command) continue;
    if (candidate.requireExisting !== false) {
      try { if (!fs.existsSync(candidate.command)) continue; } catch { continue; }
    }
    if (probe(candidate, root, desktopEnv)) {
      selected = { command: candidate.command, args: Array.isArray(candidate.args) ? candidate.args : [], source: candidate.source || 'unknown' };
      break;
    }
  }
  if (!bypassCache) desktopPythonCache.set(cacheKey, { at: now, value: selected });
  return selected;
}
// True when a directory looks like the ai-computer-control repo (has the src package).
function isDesktopMcpRepo(dir) {
  try { return !!dir && fs.existsSync(path.join(dir, 'src', 'ai_computer_control', 'server.py')); }
  catch { return false; }
}
function desktopMcpFromRepo(repoRoot) {
  const src = path.join(repoRoot, 'src');
  const desktopEnv = { PYTHONPATH: src, PYTHONUTF8: '1' };
  // Offline releases keep Playwright's browser payload beside the embedded Python runtime. Without
  // this variable Playwright falls back to the user's cache and reports Chromium missing even though
  // the package contains it.
  const bundledBrowsers = path.join(repoRoot, 'playwright_browsers');
  try { if (fs.existsSync(bundledBrowsers)) desktopEnv.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers; }
  catch { /* optional payload; browser tools will degrade gracefully */ }
  const python = pickPython(repoRoot, desktopEnv);
  if (!python) return null;
  return {
    command: python.command,
    args: [...python.args, '-X', 'utf8', '-m', 'ai_computer_control.server'],
    cwd: repoRoot,
    env: desktopEnv,
    via: 'python-module',
    pythonSource: python.source,
  };
}

// The bundled ACC installer writes this layout to %LOCALAPPDATA%\ai-computer-control. It contains an
// installed package rather than a checkout with src/, so it needs its own recognizer.
function desktopMcpFromInstalledRoot(installRoot, options = {}) {
  const root = String(installRoot || '').trim();
  if (!root) return null;
  const desktopEnv = { PYTHONUTF8: '1' };
  const bundledBrowsers = path.join(root, 'playwright_browsers');
  try { if (fs.existsSync(bundledBrowsers)) desktopEnv.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers; }
  catch { /* optional payload; browser tools will degrade gracefully */ }
  const installedCandidates = [
    { command: path.join(root, 'runtime', 'python', 'python.exe'), args: [], source: 'installed-runtime', requireExisting: true },
    { command: path.join(root, 'venv', 'Scripts', 'python.exe'), args: [], source: 'installed-venv', requireExisting: true },
  ];
  const selected = pickPython(root, desktopEnv, {
    candidates: Array.isArray(options.candidates) ? options.candidates : installedCandidates,
    probe: typeof options.probe === 'function' ? options.probe : undefined,
    noCache: options.noCache === true,
  });
  if (!selected) return null;
  return {
    command: selected.command,
    args: [...selected.args, '-X', 'utf8', '-m', 'ai_computer_control.server'],
    cwd: root,
    env: desktopEnv,
    via: 'python-module',
    pythonSource: selected.source,
  };
}
function detectDesktopMcp() {
  try {
    const env = process.env;
    const home = os.homedir();
    // (a) explicit env override.
    const envHome = env.AI_COMPUTER_CONTROL_HOME && String(env.AI_COMPUTER_CONTROL_HOME).trim();
    if (envHome) {
      const root = path.resolve(envHome);
      if (isDesktopMcpRepo(root)) { const detected = desktopMcpFromRepo(root); if (detected) return detected; }
      const installed = desktopMcpFromInstalledRoot(root); if (installed) return installed;
    }
    // (b) common repo locations. Bundled monorepo copies come first (release layout ships the MCP
    // at <repo>/mcp/ai-computer-control with the app at <repo>/ruyi-workbench/app, or flattened
    // with app/ at the package root) so a shipped copy beats a stale user checkout.
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
      const detected = desktopMcpFromRepo(path.resolve(dir));
      if (detected) return detected;
    }
    // (c) ACC's verified offline installer writes runtime\python; older releases used venv\Scripts.
    const installedRoots = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'ai-computer-control'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'ai-computer-control'),
    ].filter(Boolean);
    for (const root of installedRoots) {
      const detected = desktopMcpFromInstalledRoot(root);
      if (detected) return detected;
    }
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
      const server = { type: 'stdio', command: entry.command, args: entry.args || [] };
      if (entry.cwd) server.cwd = entry.cwd;
      if (entry.env && Object.keys(entry.env).length) server.env = entry.env;
      mcpServers[entry.id] = server;
    }
  } catch { /* detection must never break config generation */ }
}

async function generateMcpConfig(mode) {
  await ensureDirs();
  const cfg = await readConfig().catch(() => null);
  if (!mode) mode = cfg?.mcpCommandMode || 'auto';
  const self = commandForSelfMcp(mode);
  const configPath = path.join(paths.generated, 'workbench.mcp.json');
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
  await fsp.writeFile(configPath, JSON.stringify(mcp, null, 2), 'utf8');
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
  await fsp.writeFile(configPath, JSON.stringify(mcp, null, 2), 'utf8');
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
    await fsp.writeFile(configPath, JSON.stringify(raw, null, 2), 'utf8');
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
const ROUTE_AUTH = [
  // open: 低敏读(host 门已过,无 token 需求)
  { m: 'GET', p: '/api/status', auth: 'open' },
  { m: 'GET', p: '/api/capabilities', auth: 'open' },
  { m: 'GET', p: '/api/models', auth: 'open' },
  // 47c(S1):bootstrap 握手 —— 浏览器拿 token 的【唯一】通道(HTML 不再明文下发)。open 级的安全性 =
  // 顶层 host 门(rebinding 的 Host 是攻击域,直接被拒)+ 与旧 GET / 明文下发完全同等的信任面。
  { m: 'POST', p: '/api/bootstrap', auth: 'open' },
  // body-token: MCP 子进程 / 跨源 loopback(handler 自查 body token,豁免 originOk)
  { m: 'POST', p: '/api/permission/request', auth: 'body-token' },
  { m: 'POST', p: '/api/question/request', auth: 'body-token' },
  { m: 'POST', p: '/api/todo', auth: 'body-token' },
  { m: '*', p: '/api/mission', auth: 'body-token' },
  { m: 'POST', p: '/api/agent-workflow/launch', auth: 'body-token' },
  // token-browser: 敏感内容型 GET + UI 变更型(浏览器须 token;loopback 非浏览器须同源,无需 token)
  { m: 'GET', p: '/api/sessions', auth: 'token-browser' },
  { m: 'GET', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'GET', p: '/api/skills', auth: 'token-browser' },
  { m: 'GET', p: '/api/agent-roles', auth: 'token-browser' },
  { m: 'GET', p: '/api/agent-workflows', auth: 'token-browser' },
  { m: 'GET', p: '/api/playbooks', auth: 'token-browser' },
  { m: 'POST', p: '/api/chat/stream', auth: 'token-browser' },
  { m: 'POST', p: '/api/upload', auth: 'token-browser' },
  { m: 'POST', p: '/api/sessions', auth: 'token-browser' },
  { m: 'POST', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'PATCH', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'DELETE', p: '/api/sessions/', auth: 'token-browser', prefix: true },
  { m: 'POST', p: '/api/session/skills', auth: 'token-browser' },
  { m: 'POST', p: '/api/session/memories', auth: 'token-browser' },
  { m: 'POST', p: '/api/memory', auth: 'token-browser' },
  { m: 'POST', p: '/api/memory/', auth: 'token-browser', prefix: true },
  { m: 'DELETE', p: '/api/memory/', auth: 'token-browser', prefix: true },
  { m: 'POST', p: '/api/stop', auth: 'token-browser' },
  { m: 'POST', p: '/api/provider/compact', auth: 'token-browser' },
  { m: 'POST', p: '/api/permission/decision', auth: 'token-browser' },
  { m: 'POST', p: '/api/chat/answer', auth: 'token-browser' },
  // origin: UI 变更但仅同源基线(现状保持,不收紧)
  // token: 始终 tokenOk(敏感变更 + 内容型 GET,handler 多有自查作纵深)
  { m: 'POST', p: '/api/tools/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/config', auth: 'token' },
  { m: 'POST', p: '/api/provider/test', auth: 'token' },
  { m: 'POST', p: '/api/workspace/resolve', auth: 'token' },
  { m: 'POST', p: '/api/pick-folder', auth: 'token' },
  { m: 'POST', p: '/api/plan/decision', auth: 'token' },
  { m: 'POST', p: '/api/steer', auth: 'token' },
  { m: 'DELETE', p: '/api/steer', auth: 'token' },
  { m: 'POST', p: '/api/session/rewind', auth: 'token' },
  { m: 'POST', p: '/api/checkpoints/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/file/reveal', auth: 'token' },
  { m: 'POST', p: '/api/mcp/import-folder', auth: 'token' },
  // 48c:MCP 配置导入器(scan 发现+冲突检测 / apply 勾选写回),token 级同 import-folder。
  { m: 'POST', p: '/api/mcp/import-config/scan', auth: 'token' },
  { m: 'POST', p: '/api/mcp/import-config/apply', auth: 'token' },
  { m: 'POST', p: '/api/playbooks/draft', auth: 'token' },
  { m: 'POST', p: '/api/playbooks', auth: 'token' },
  { m: 'POST', p: '/api/playbooks/', auth: 'token', prefix: true },
  { m: 'DELETE', p: '/api/playbooks/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/agent-roles', auth: 'token' },
  { m: 'POST', p: '/api/agent-workflows', auth: 'token' },
  { m: 'POST', p: '/api/agent-workflows/', auth: 'token', prefix: true },
  { m: 'DELETE', p: '/api/agent-workflows/', auth: 'token', prefix: true },
  { m: 'POST', p: '/api/autonomy/', auth: 'token', prefix: true },
  { m: '*', p: '/api/autonomy/grants', auth: 'token' },
  { m: 'POST', p: '/api/agent-runs/', auth: 'token', prefix: true },
  { m: 'DELETE', p: '/api/agent-runs/', auth: 'token', prefix: true },
  { m: 'GET', p: '/api/agent-runs', auth: 'token', prefix: true },
  { m: 'GET', p: '/api/memory', auth: 'token' },
  { m: 'GET', p: '/api/memory/item', auth: 'token' },
  { m: 'GET', p: '/api/usage/summary', auth: 'token' },
  { m: 'GET', p: '/api/ops/metrics', auth: 'token' },
  { m: 'GET', p: '/api/checkpoints', auth: 'token' },
  { m: 'GET', p: '/api/checkpoints/', auth: 'token', prefix: true },
  { m: 'GET', p: '/api/file/preview', auth: 'token' },
  { m: 'GET', p: '/api/audit', auth: 'token' },
  { m: 'GET', p: '/api/storage/summary', auth: 'token' },
  { m: 'POST', p: '/api/storage/policy', auth: 'token' },
  { m: 'POST', p: '/api/storage/clean', auth: 'token' },
  { m: 'GET', p: '/api/metrics', auth: 'token' },
];
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
