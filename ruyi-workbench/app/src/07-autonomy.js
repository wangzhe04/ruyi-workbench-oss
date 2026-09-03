// Best-effort model list from a provider's OpenAI-style GET /models. Never throws.
async function fetchOpenAiModels(provider, timeoutMs = 4000) {
  const base = providerBaseWithV1(provider && provider.baseUrl);
  if (!base || typeof fetch !== 'function') return { ok: false, error: base ? 'fetch unavailable' : 'no base URL', models: [] };
  const key = String((provider && provider.apiKey) || '').trim();
  const headers = { 'content-type': 'application/json' };
  if (key) headers['authorization'] = 'Bearer ' + key;
  if (provider && provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
  try {
    const res = await fetch(base + '/models', { headers, signal: ctrl ? ctrl.signal : undefined });
    if (!res || !res.ok) return { ok: false, error: 'HTTP ' + (res ? res.status : '?'), models: [] };
    const body = await res.json();
    const data = Array.isArray(body && body.data) ? body.data : (Array.isArray(body) ? body : []);
    // v1.0.2-S2: 同时保留上游条目里的 context_length 类字段(取第一个正数), 存为 contextLength,
    // 并按 provider+model 写入探测缓存(TTL 10 分钟), 供 providerContextWindow 解析激活模型时查用。
    const models = data
      .map(m => {
        if (typeof m === 'string') return { id: m, label: m };
        const id = String(m.id || m.model || '').trim();
        const out = { id, label: id };
        const ctx = extractContextLength(m);
        if (ctx) out.contextLength = ctx;
        return out;
      })
      .filter(m => m.id);
    // Ollama's OpenAI-compatible /v1/models omits context length, while its native /api/show reports
    // `<architecture>.context_length`. Probe the same configured origin (no new host) so local compactors
    // budget against their real window instead of the generic 64K fallback.
    let ollamaOrigin = '';
    try {
      const configured = new URL(String(provider && provider.baseUrl || ''));
      if (/ollama/i.test(String(provider && (provider.id + ' ' + provider.label) || '')) || configured.port === '11434') ollamaOrigin = configured.origin;
    } catch { /* non-URL base was already rejected above */ }
    if (ollamaOrigin) {
      await Promise.all(models.filter(m => !m.contextLength).slice(0, 32).map(async m => {
        try {
          const shown = await fetch(ollamaOrigin + '/api/show', {
            method: 'POST', headers, body: JSON.stringify({ model: m.id }), signal: ctrl ? ctrl.signal : undefined,
          });
          if (!shown || !shown.ok) return;
          const detail = await shown.json();
          const info = detail && detail.model_info;
          if (!info || typeof info !== 'object') return;
          const pair = Object.entries(info).find(([name, value]) => /(?:^|\.)context_length$/i.test(name) && Number(value) > 0);
          if (pair) m.contextLength = Math.round(Number(pair[1]));
        } catch { /* OpenAI-compatible but not native Ollama, or native probe unavailable */ }
      }));
    }
    const providerId = provider && provider.id;
    for (const m of models) if (m.contextLength) cacheContextLength(providerId, m.id, m.contextLength);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'fetch failed'), models: [] };
  } finally { if (timer) clearTimeout(timer); }
}
// v0.6: expose the workbench's own tools to a native provider as OpenAI function-calling schema.
// Same tools the MCP server exposes (minus the internal permission bridge), filtered by the
// command/desktop toggles. The native agent loop executes them in-process via toolCall().
// v0.9-S6: `opts` gates the two sub-agent-specific behaviors (all optional; the top-level provider turn
// passes none, preserving prior behavior):
//   opts.tierFilter : 'read' | 'edit' | 'exec' — keep only tools at or below this native tier (used by
//     runSubAgent to enforce toolTier: read=only read-tier, edit=read+edit, exec=all). Absent → no filter.
//   opts.noSpawnAgent : true → never include spawn_agent (禁嵌套: sub-turns pass this). The top-level turn
//     omits it and instead lets the subagentMaxPerTurn>0 check below decide.
function adaptiveMetaToolSchemas(includeInvoke = false) {
  const tools = [
    {
      name: 'list_tools',
      description: 'List the compact Ruyi tool directory when you are unsure what capability or tool name to search for. Returns names grouped by pack, without descriptions or schemas; use tool_search next for details and risk tier.',
      inputSchema: { type: 'object', properties: { pack: { type: 'string', description: 'Optional exact pack id to list.' }, cursor: { type: 'number', description: 'Optional zero-based cursor from a previous response.' }, limit: { type: 'number', description: 'Maximum names, 1..200. Defaults to 200 (normally the complete catalog).' } } },
    },
    {
      name: 'tool_search',
      description: 'Search the compact Ruyi tool catalog when the currently loaded tools do not cover the task. Returns matching names, packs, risk tiers, and short descriptions without injecting every schema.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Capability or operation to find, e.g. Excel chart, screenshot, git commit.' }, limit: { type: 'number', description: 'Maximum matches, 1..20.' } }, required: ['query'] },
    },
    {
      name: 'tool_load',
      description: 'Load one or more tool packs or exact tool names into the next model call. Use tool_search first when unsure; after this succeeds, call the newly available concrete tool.',
      inputSchema: { type: 'object', properties: { packs: { type: 'array', items: { type: 'string' }, description: 'Pack ids returned by tool_search.' }, tools: { type: 'array', items: { type: 'string' }, description: 'Exact tool names returned by tool_search.' } } },
    },
  ];
  if (includeInvoke) {
    for (const tier of ['read', 'edit', 'exec']) tools.push({
      name: `tool_invoke_${tier}`,
      description: `Invoke one discovered ${tier}-tier Ruyi tool by exact name. The workbench independently verifies the target risk tier and rejects mismatches.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Exact tool name from tool_search.' }, arguments: { type: 'object', description: 'Arguments matching that tool schema.' } }, required: ['name'] },
    });
  }
  return tools;
}

function buildOpenAiTools(config, caps, opts) {
  const allowCmd = config.allowCommandTools !== false;
  const allowDesk = config.allowDesktopTools !== false;
  const out = [];
  const SHELL_TOOLS = new Set(['shell_start', 'shell_send', 'shell_poll', 'shell_kill', 'shell_list']);
  const tierRank = { read: 0, edit: 1, exec: 2 };
  const tierFilter = opts && opts.tierFilter;
  const maxRank = (tierFilter && tierFilter in tierRank) ? tierRank[tierFilter] : null; // null → no tier filter
  const noSpawnAgent = !!(opts && opts.noSpawnAgent);
  // v0.9-S6: spawn_agent is offered only when the feature is enabled (subagentMaxPerTurn>0) AND not
  // explicitly suppressed (sub-turns pass noSpawnAgent → 禁嵌套). 0 = feature off → tool never registered.
  const spawnAgentEnabled = !noSpawnAgent && Number(config.subagentMaxPerTurn) > 0;
  // v0.8-S6: gate tools whose runtime requirements (TOOL_REQUIRES) are unmet by the capability matrix. The
  // testOnly entry only fires when config.enableToolRequiresProbe is set (see TOOL_REQUIRES note), so this
  // is inert in production until v0.9 populates the table. buildProviderSystemPrompt lists the filtered
  // tools under 「当前不可用」 so the model is told why they're absent.
  const toolRequiresEnabled = !!(config && config.enableToolRequiresProbe);
  for (const t of MCP_TOOLS) {
    if (t.name === 'list_tools' || t.name === 'tool_search' || t.name === 'tool_load' || t.name.startsWith('tool_invoke_')) continue;
    if (t.name === 'permission_prompt') continue;
    if (t.name === 'request_user_input' && noSpawnAgent) continue;
    if ((t.name === 'spawn_agent' || t.name === 'orchestrate_agents') && !spawnAgentEnabled) continue;
    if (!allowCmd && (t.name === 'powershell_run' || t.name === 'script_run' || SHELL_TOOLS.has(t.name))) continue;
    if (!allowDesk && (t.name === 'desktop_screenshot' || t.name === 'keyboard_send_keys')) continue;
    // 105a: observation_recall 仅在 recall+reducer 双开关生效时 offer;默认关 → 不出现在工具集。
    if (t.name === 'observation_recall' && !observationRecallEnabled(config)) continue;
    // v0.9-S6: toolTier filter for sub-turns — drop any tool above the requested tier. spawn_agent (exec)
    // is already suppressed for sub-turns via noSpawnAgent, so it never survives an 'exec' sub-turn either.
    if (maxRank !== null && (tierRank[nativeToolTier(t.name)] ?? 2) > maxRank) continue;
    if (caps && !toolRequirementsMet(t.name, caps, toolRequiresEnabled, config).met) continue; // requirement unmet → drop
    out.push({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } });
  }
  // Provider-turn control plane for background spawn_agent runs. It is intentionally not part of MCP_TOOLS:
  // the one-shot MCP child has no parent-turn closure, while persisted orchestrate_agents already owns its
  // separate synchronous/async launch route. Top-level Provider turns can collect by explicit runId or, more
  // conveniently, omit runIds to wait for the background agents launched earlier in the same turn.
  if (spawnAgentEnabled) {
    out.push({ type: 'function', function: {
      name: 'wait_agents',
      description: 'Collect results from background spawn_agent runs. Omit runIds to wait for every background Agent launched in the current chat turn, or pass launch-receipt runIds (including from an earlier turn). Waits at most timeoutMs and returns current persisted DAG state if work is still running.',
      parameters: { type: 'object', properties: {
        runIds: { type: 'array', items: { type: 'string' }, description: 'Optional spawn_agent runIds returned by background launch receipts (up to 16).' },
        timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds, 0..60000 (default 30000).' },
      } },
    } });
  }
  // v1 技能体系: skill_read(provider 引擎, read tier)—— 仅在本会话有启用技能时注册(offer 条件由调用方传
  // opts.skillsEnabled 决定,仿 spawn_agent 的 enable 门)。不入 MCP_TOOLS(否则会泄漏给 Claude CLI 且恒开)。
  // 子代理不传 skillsEnabled → 不注册。dispatch 在 toolCall 的 'skill_read' 分支;tier 在 NATIVE_TOOL_TIER。
  if (opts && opts.skillsEnabled) {
    out.push({ type: 'function', function: {
      name: 'skill_read',
      description: '读取一个已启用技能的说明与目录。默认(仅传 id)返回 SKILL.md 全文 + 该技能目录内的文件清单;需要读取清单中的某个文件时,再次调用本工具并额外传 file(相对该技能目录的路径),返回该文件内容。仅能读取当前会话已启用的技能;id 为系统提示技能索引里方括号内的技能 id。',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: '技能 id(见系统提示的技能索引)' },
        file: { type: 'string', description: '可选。技能目录内的相对路径(见清单)。提供后返回该文件内容而非清单;仅限该技能目录内。' },
      }, required: ['id'] },
    } });
  }
  // 团队模式 v2 (A1): propose_task —— 子代理提案追加节点(元工具,provider 引擎,read tier)。仅在工作流子回合且池
  // 策略非 off 时注册(offer 由调用方 opts.proposeTaskEnabled 门控,仿 skill_read/spawn_agent 的 enable 门)。不进
  // MCP_TOOLS(否则泄漏给 Claude CLI 且恒开)。dispatch 在 runSubAgentCore 的专用闭包分支,不走全局 toolCall。
  if (opts && opts.proposeTaskEnabled) {
    out.push({ type: 'function', function: {
      name: 'propose_task',
      description: '当你发现需要一个新的协作节点来完成某个子任务时,提交一个任务提案到本次运行的共享任务池,等待编排者审批。审批通过后它会作为一个新的工作流节点自动执行(走完整的资源/预算/记账管线)。这不会阻塞你——提交后立刻返回,你应继续完成自己当前的任务,不要等待它。',
      parameters: { type: 'object', properties: {
        task: { type: 'string', description: '新节点要完成的具体任务描述(必填)。' },
        roleId: { type: 'string', description: '可选。为新节点指定一个已有的 Agent 角色 id。' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '可选。新节点依赖的现有节点 id 列表;缺省依赖你自己(提案者)。' },
        resources: { type: 'array', items: { type: 'string' }, description: '可选。新节点声明的资源(用于并发排他/只读,格式同工作流节点)。' },
        toolTier: { type: 'string', enum: ['read', 'edit', 'exec'], description: '可选。新节点的工具级别,不得高于你自己的级别。' },
        model: { type: 'string', description: '可选。为新节点按任务难易指定模型 id(从系统提示里列出的、与新节点引擎匹配的可选模型中选;简单/大批量→快、复杂推理→强、其余→均衡;填错会让节点失败)。省略则继承你(提案者)的模型。' },
        reason: { type: 'string', description: '可选。给编排者看的一句话理由。' },
      }, required: ['task'] },
    } });
  }
  // 团队模式 v2 (B1): send_to_agent —— 单向异步节点间消息(元工具,provider 引擎,read tier)。offer 由
  // opts.sendToAgentEnabled 门控(工作流子回合注册)。不阻塞、不等回执;目标下一次调用前投递,投不了则丢弃。
  if (opts && opts.sendToAgentEnabled) {
    out.push({ type: 'function', function: {
      name: 'send_to_agent',
      description: '给同一次运行中的另一个节点发一条单向消息(异步、不阻塞、不等回执)。消息会在目标节点下一次模型调用前作为一条提示注入;若目标已结束/被跳过/是单发节点则被丢弃。用于把你发现的关键事实及时同步给并行的其他节点。',
      parameters: { type: 'object', properties: {
        targetNodeKey: { type: 'string', description: '目标节点的 id(必填)。' },
        message: { type: 'string', description: '要发送的消息内容(必填,最长约 2000 字符)。' },
      }, required: ['targetNodeKey', 'message'] },
    } });
  }
  if ((!opts || !opts.noAdaptiveMeta) && config && config.toolLoadingMode === 'auto') {
    // O1 (hb360): 注入含 tool_invoke_* 的完整 adaptive 元工具集 -- bridged 工具不自动注入 schema 后,
    // 模型需 tool_invoke_read/edit/exec 代理调用(按 tool_search 返回的 tier 选),否则 onDemand 引导的
    // 代理路径无工具可用。原 false 仅注入 list/search/load,OpenAI 引擎主回合缺 tool_invoke_*。
    for (const t of adaptiveMetaToolSchemas(true)) out.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } });
  }
  return out;
}
// Risk tier per tool → drives permission gating in the native loop (read = auto-allow).
const NATIVE_TOOL_TIER = {
  permission_prompt: 'exec', // CLI 权限桥(由 --permission-prompt-tool 触达);原靠 unknown→exec 兜底,第41波显式化
  workbench_memory_list: 'read', workbench_memory_read: 'read', workbench_memory_propose: 'read',
  workbench_memory_relation_propose: 'read', workbench_memory_revise: 'read', workbench_memory_relation_revoke: 'read',
  observation_recall: 'read', // 105a: 只读当前会话快照,授权来自 ctx 会话归属 → auto-allow
  list_tools: 'read', tool_search: 'read', tool_load: 'read', tool_invoke_read: 'read', tool_invoke_edit: 'edit', tool_invoke_exec: 'exec',
  propose_task: 'read', send_to_agent: 'read', // 团队模式 v2 (A1/B1) 编排元工具 → read tier(纯元数据/入队,不落盘)
  request_user_input: 'read', // waits for an explicit UI answer; no filesystem/exec side effect
  file_read: 'read', file_list: 'read', file_search: 'read', glob: 'read', project_snapshot: 'read', git_status: 'read',
  git_diff: 'read', git_log: 'read', // v1.0-S4: read-only git inspection → auto-allow
  git_commit: 'exec', // v1.0-S4: commit triggers .git/hooks (arbitrary code) → must be exec (never lower)
  dependency_inventory: 'read', code_review_scan: 'read', frontend_audit: 'read', claude_md_audit: 'read', docs_search: 'read', codebase_symbol_search: 'read', debug_hypothesis: 'read', data_profile: 'read',
  mcp_list: 'read', mcp_configure: 'exec',
  todo_write: 'read', // v0.8-S3: writing the task list is a planning act, not a filesystem/exec mutation → auto-allow
  mission_update: 'read', // 第26波b: 更新任务账本是规划/元数据写,非文件/exec 变更 → auto-allow
  workbench_self_status: 'read', // 108c: 只读自状态(版本/位置/端口/健康/计数/设置掩码),不触文件路径 → auto-allow
  skill_read: 'read', // v1 技能体系: 只读已启用技能的 SKILL.md + 目录清单(路径受限该技能目录内)→ auto-allow
  web_search: 'read', web_fetch: 'read', // v0.9-S9: read-only network reads (no local mutation) → auto-allow (SSRF-guarded)
  file_write: 'edit', file_edit: 'edit', file_delete: 'edit', // v0.8-S4a: delete is journaled (revertible) → edit tier
  // v1.1-W2 (T1): 移动/复制/压缩/解压/下载 —— 均落盘且经检查点(可撤销) → edit tier。
  file_move: 'edit', file_copy: 'edit', archive_zip: 'edit', archive_unzip: 'edit', http_download: 'edit',
  powershell_run: 'exec', script_run: 'exec', keyboard_send_keys: 'exec', browser_open: 'exec', office_open: 'exec',
  desktop_screenshot: 'exec', http_request: 'exec',
  spawn_agent: 'exec', // v0.9-S6: delegating a sub-turn is the highest-privilege native act → exec tier
  orchestrate_agents: 'exec',
  wait_agents: 'read',
  // v0.8-S2 shell session族: listing is read-only; start/send/poll/kill mutate state → exec.
  shell_list: 'read', shell_start: 'exec', shell_send: 'exec', shell_poll: 'exec', shell_kill: 'exec',
};
function nativeToolTier(name) { return NATIVE_TOOL_TIER[name] || 'exec'; } // unknown → safest (treat as exec)
// v2.6 (loop guard 分层): 同签名连击(连续相同 name+rawArgs)对「无副作用」工具不应 abort ——
// 轮询/等待原语(相同参数反复调用是其设计语义: wait_agents 等后台 run 结束、shell_poll 读增量输出)
// 完全豁免同签名连击(不累计/不 warn/不 abort),无进展由语义指纹判定;只读工具(重复读无害)只 warn
// 不 abort;有副作用工具(edit/exec)保持 5 次 abort(重复执行=重复破坏)。
const LOOP_POLLING_TOOLS = new Set(['wait_agents', 'shell_poll']);
function loopAbortExempt(name) { return LOOP_POLLING_TOOLS.has(String(name || '').replace(/^.+?__/, '')); } // 轮询原语: 完全豁免
function loopWarnOnly(name) { return nativeToolTier(String(name || '').replace(/^.+?__/, '')) === 'read'; } // 无副作用只读: 只 warn 不 abort

// v0.8-S0: risk tiers for BRIDGED (external/desktop MCP) tools, keyed by the UNPREFIXED tool name
// (the bridged name is `serverId__tool`; look up bridge.toolName). Replaces the old flat 'exec' so ACC's
// read-only family (screenshot/OCR/find/inspect/diagnostics/waits/reads) doesn't prompt in 'default' mode.
// Exact-name set below; a few prefix rules follow it. Anything unmatched defaults to 'exec'.
const BRIDGED_READ_TOOLS = new Set([
  'screenshot', 'screenshot_region', 'screenshot_full', 'window_screenshot',
  'ocr_image', 'ocr_screen',
  // 审计 P1: 'ocr_find_text' 有意【不在】read 级 —— 它带 click 参数(click=True 即 pyautogui.click 物理点击,见
  // ocr.py:227/253),被判 read 后 read 子代理可无人值守点击桌面,且 nativeToolGate 对 read 无条件 allow(任何模式
  // 不弹窗)。它落回默认 'exec':read/edit 子代理拿不到,非 bypass 模式点击前弹窗。纯只读文本定位仍可用 ocr_screen/
  // ocr_image(返回全部词+坐标)或 find_on_screen/find_template(模板匹配,无 click、均无 audit → 仍是 read)。
  'find_template', 'find_all_templates', 'find_on_screen',
  'ui_inspect', 'ui_find', 'diagnostics', 'version_info', 'safety_info', 'audit_tail',
  'read_file', 'file_info', 'clipboard_get', 'clipboard_read', 'get_clipboard',
]);
// Prefix rules for read-only families that share a common verb (e.g. get_windows, list_processes,
// wait_for_window_idle). Kept narrow so an 'exec'-shaped verb can't sneak in under a broad prefix.
const BRIDGED_READ_PREFIXES = ['get_', 'list_', 'wait_for_'];
// Resolve a bridged tool's tier: user override (config.bridgedToolTiers) wins, then the built-in table,
// then default 'exec'. `unprefixedName` is bridge.toolName (never the serverId__tool form).
function bridgedToolTier(unprefixedName, config) {
  const overrides = (config && config.bridgedToolTiers && typeof config.bridgedToolTiers === 'object') ? config.bridgedToolTiers : {};
  const ov = overrides[unprefixedName];
  if (ov === 'read' || ov === 'edit' || ov === 'exec') return ov;
  if (BRIDGED_READ_TOOLS.has(unprefixedName)) return 'read';
  if (BRIDGED_READ_PREFIXES.some(p => unprefixedName.startsWith(p))) return 'read';
  return 'exec';
}

const TOOL_PACK_DESCRIPTIONS = Object.freeze({
  core: 'planning, user questions, Workbench Memory, mission metadata and tool discovery',
  files_read: 'read, list, search and inspect workspace files',
  files_write: 'write, edit, delete, copy and move files',
  code: 'project inspection, code review and git operations',
  shell: 'PowerShell, scripts and persistent shell sessions',
  web: 'web search, fetch, HTTP requests and downloads',
  desktop: 'screenshots, UI inspection and desktop control',
  office: 'Excel, Word, PowerPoint and PDF document operations',
  archive: 'zip and unzip archives',
  agents: 'sub-agents and workflow orchestration',
  skills: 'read enabled skill instructions',
  integrations: 'inspect and configure MCP connectors and browser targets',
  memory: 'cross-session memory read/write/search (memory_save/read/list/delete)',
  thinking: 'step-by-step reasoning chains and sequential thinking',
});
const NATIVE_TOOL_PACKS = Object.freeze({
  permission_prompt: 'core', request_user_input: 'core', todo_write: 'core', mission_update: 'core',
  workbench_memory_list: 'core', workbench_memory_read: 'core', workbench_memory_propose: 'core',
  workbench_memory_relation_propose: 'core', workbench_memory_revise: 'core', workbench_memory_relation_revoke: 'core',
  observation_recall: 'core', workbench_self_status: 'core', // 108c: core 常驻,不依赖 classifyToolPacks 意图分类
  list_tools: 'core', tool_search: 'core', tool_load: 'core', tool_invoke_read: 'core', tool_invoke_edit: 'core', tool_invoke_exec: 'core',
  file_read: 'files_read', file_list: 'files_read', file_search: 'files_read', glob: 'files_read', project_snapshot: 'files_read',
  file_write: 'files_write', file_edit: 'files_write', file_delete: 'files_write', file_move: 'files_write', file_copy: 'files_write',
  dependency_inventory: 'code', code_review_scan: 'code', frontend_audit: 'code', claude_md_audit: 'code', docs_search: 'code', codebase_symbol_search: 'code', debug_hypothesis: 'code', data_profile: 'code',
  git_status: 'code', git_diff: 'code', git_log: 'code', git_commit: 'code',
  powershell_run: 'shell', script_run: 'shell', shell_start: 'shell', shell_send: 'shell', shell_poll: 'shell', shell_kill: 'shell', shell_list: 'shell',
  web_search: 'web', web_fetch: 'web', http_request: 'web', http_download: 'web', browser_open: 'web',
  desktop_screenshot: 'desktop', keyboard_send_keys: 'desktop', office_open: 'office',
  archive_zip: 'archive', archive_unzip: 'archive', spawn_agent: 'agents', orchestrate_agents: 'agents', wait_agents: 'agents', skill_read: 'skills',
  mcp_list: 'integrations', mcp_configure: 'integrations',
});

function toolPackForName(name, bridgedRoute) {
  if (NATIVE_TOOL_PACKS[name]) return NATIVE_TOOL_PACKS[name];
  const bridge = resolveBridge(bridgedRoute || {}, name);
  const raw = String(bridge ? bridge.toolName : name || '').toLowerCase();
  if (/(excel|spreadsheet|workbook|worksheet|word|docx|document|ppt|powerpoint|slide|pdf|chart_image)/.test(raw)) return 'office';
  if (/(screen|window|mouse|keyboard|click|clipboard|ocr|ui_|desktop|hotkey|type_text|scroll|drag)/.test(raw)) return 'desktop';
  if (/(archive|zip|unzip|compress|extract)/.test(raw)) return 'archive';
  if (/(search|fetch|http|url|browser|download|web)/.test(raw)) return 'web';
  if (/^memory_(save|read|list|delete)$/.test(raw)) return 'memory';
  if (/sequential_thinking/.test(raw)) return 'thinking';
  if (/(read|list|get_|find|inspect|status|info|diagnostic|wait_for_)/.test(raw)) return 'files_read';
  if (/(write|edit|delete|move|copy|create|save|upload)/.test(raw)) return 'files_write';
  return 'desktop'; // unknown external tools are conservative opt-in, never part of simple chat
}

// 20-T1: small, reviewable retrieval vocabulary for high-value native capabilities. This is deliberately
// not a second tool registry: tier/pack/schema remain sourced from their existing tables; these hints only
// bridge user language (especially Chinese) to a capability name. Unknown/bridged tools still receive
// deterministic fields derived from name, description and JSON Schema parameters.
const TOOL_RETRIEVAL_HINTS = Object.freeze({
  file_read: { capabilities: ['workspace.file.read'], aliases: ['读取文件', '查看文件', 'read workspace file'] },
  file_list: { capabilities: ['workspace.file.list'], aliases: ['列出目录', '查看目录', 'list directory'] },
  file_search: { capabilities: ['workspace.text.search'], aliases: ['搜索文件内容', '全文检索', 'search files'] },
  glob: { capabilities: ['workspace.path.glob'], aliases: ['按模式找文件', '文件通配符', 'find files by pattern'] },
  file_write: { capabilities: ['workspace.file.write'], aliases: ['写入文件', '创建文件', 'write file'] },
  file_edit: { capabilities: ['workspace.file.edit'], aliases: ['修改文件', '替换文本', 'edit file'] },
  codebase_symbol_search: { capabilities: ['code.symbol.definition', 'code.symbol.references'], aliases: ['查找符号定义', '查找代码引用', 'find definition references'] },
  docs_search: { capabilities: ['documentation.search'], aliases: ['搜索项目文档', '查文档', 'search documentation'] },
  git_status: { capabilities: ['git.status'], aliases: ['查看代码变更', '仓库状态', 'working tree status'] },
  git_diff: { capabilities: ['git.diff'], aliases: ['查看差异', '代码改动', 'show changes diff'] },
  powershell_run: { capabilities: ['shell.powershell.execute'], aliases: ['运行命令', '执行 powershell', 'run command'] },
  script_run: { capabilities: ['shell.script.execute'], aliases: ['运行脚本', '执行脚本', 'run script'] },
  web_search: { capabilities: ['web.search'], aliases: ['搜索互联网', '联网搜索', 'search the web'] },
  web_fetch: { capabilities: ['web.page.fetch'], aliases: ['抓取网页', '读取网页', 'fetch web page'] },
  http_request: { capabilities: ['network.http.request'], aliases: ['发送 http 请求', '调用接口', 'http api request'] },
  http_download: { capabilities: ['network.http.download', 'workspace.file.write'], aliases: ['下载文件', '从网址下载', 'download url to file'] },
  desktop_screenshot: { capabilities: ['desktop.screen.capture'], aliases: ['桌面截图', '屏幕截图', 'take screenshot'] },
  office_open: { capabilities: ['office.document.open'], aliases: ['打开办公文档', '打开 excel word ppt pdf', 'open office document'] },
  orchestrate_agents: { capabilities: ['agent.workflow.orchestrate'], aliases: ['编排多个代理', '多代理工作流', 'orchestrate agents'] },
  spawn_agent: { capabilities: ['agent.delegate'], aliases: ['派生子代理', '委派任务', 'delegate subagent'] },
  skill_read: { capabilities: ['skill.instructions.read'], aliases: ['读取技能说明', '加载技能', 'read skill instructions'] },
  workbench_memory_read: { capabilities: ['memory.read'], aliases: ['读取工作台记忆', '回忆信息', 'read memory'] },
  observation_recall: { capabilities: ['context.observation.recall'], aliases: ['回读原始工具结果', '取回被省略的观察', 'recall reduced observation', 'restore tool result'] },
  workbench_memory_propose: { capabilities: ['memory.propose'], aliases: ['提议保存记忆', '记住经验', 'propose memory'] },
});
const RUNTIME_TELEMETRY_KEY = crypto.randomBytes(32); // process-scoped HMAC key; raw queries/errors are never logged

function normalizeToolSearchText(value) {
  return String(value == null ? '' : value).normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_./\\:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeToolSearchText(value) {
  const normalized = normalizeToolSearchText(value);
  const out = new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  // Chinese has no whitespace boundaries in most queries/descriptions. Add bounded 2/3-grams while keeping
  // Latin words intact; this makes 「查找符号引用」 match 「查找代码引用」 without an embedding runtime.
  for (const segment of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    out.add(segment);
    for (const n of [2, 3]) for (let i = 0; i + n <= segment.length; i++) out.add(segment.slice(i, i + n));
  }
  return [...out].filter(t => t.length > 1 || /^\d+$/.test(t));
}

function toolSchemaSearchText(schema) {
  const out = []; const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return;
    seen.add(node);
    if (typeof node.title === 'string') out.push(node.title);
    if (typeof node.description === 'string') out.push(node.description.slice(0, 160));
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, child] of Object.entries(node.properties)) { out.push(key); walk(child, depth + 1); }
    }
    if (node.items) walk(node.items, depth + 1);
  };
  walk(schema, 0);
  return out.join(' ').slice(0, 1200);
}

function retrievalHintForTool(name, pack) {
  const exact = TOOL_RETRIEVAL_HINTS[name] || {};
  const nameWords = normalizeToolSearchText(name).split(' ').filter(Boolean);
  return {
    capabilities: [...new Set([...(exact.capabilities || []), `${pack}.${nameWords.join('.')}`])],
    aliases: [...new Set(exact.aliases || [])],
  };
}

function classifyToolPacks(message, attachments) {
  const s = String(message || '').toLowerCase();
  const packs = new Set(['core']);
  const add = (...xs) => xs.forEach(x => packs.add(x));
  if (Array.isArray(attachments) && attachments.length) add('files_read');
  if (/(文件|目录|路径|源码|代码|项目|repo|repository|file|folder|directory|source|workspace|read|读取|查看|搜索|查找|分析|审查)/i.test(s)) add('files_read');
  if (/(实现|修改|编辑|写入|创建|删除|移动|复制|修复|重构|更新|落盘|implement|modify|edit|write|create|delete|move|copy|fix|refactor|update)/i.test(s)) add('files_read', 'files_write', 'code');
  if (/(代码|编码|编程|bug|测试|构建|依赖|git|commit|push|pull request|typescript|javascript|python|java|rust|go\b|npm|pnpm|yarn|编译)/i.test(s)) add('files_read', 'code');
  if (/(运行|执行|命令|终端|shell|powershell|脚本|测试|构建|安装|启动|重启|部署|run|execute|command|terminal|script|test|build|install|start|restart|deploy)/i.test(s)) add('shell');
  if (/(联网|网页|网站|搜索网络|查新闻|最新|url|https?:|web|internet|online|search the web|fetch)/i.test(s)) add('web');
  if (/(excel|word|powerpoint|pptx?|docx?|pdf|表格|电子表格|工作簿|幻灯片|演示文稿|文档排版)/i.test(s)) add('office', 'files_read', 'files_write');
  if (/(截图|桌面|窗口|鼠标|键盘|点击|屏幕|ocr|screenshot|desktop|window|mouse|keyboard|click)/i.test(s)) add('desktop');
  if (/(压缩|解压|zip|archive|unzip)/i.test(s)) add('archive', 'files_read', 'files_write');
  if (/(子代理|多代理|工作流|并行|agent|orchestrat|delegate)/i.test(s)) add('agents');
  if (/(技能|skill)/i.test(s)) add('skills');
  if (/(mcp|连接器|工具配置|浏览器目标|browser target|connector|tool config)/i.test(s)) add('integrations');
  if (/(记住|记忆|偏好|以后别忘|remember|memorize|preference|recall)/i.test(s)) add('memory');
  if (/(思考|推理|分析|对比|决策|规划|方案|权衡|think|reason|analy|compare|decide|plan|strateg)/i.test(s)) add('thinking');
  return [...packs];
}

function buildToolCatalog(tools, bridgedRoute, config) {
  return (tools || []).map(t => {
    const fn = t && t.function || {};
    const bridge = resolveBridge(bridgedRoute || {}, fn.name);
    const pack = toolPackForName(fn.name, bridgedRoute);
    const hint = retrievalHintForTool(fn.name, pack);
    return {
      name: fn.name || '', pack,
      tier: bridge ? bridgedToolTier(bridge.toolName, config) : nativeToolTier(fn.name),
      bridged: !!bridge,
      description: String(fn.description || '').replace(/\s+/g, ' ').slice(0, 220), tool: t,
      capabilities: hint.capabilities, aliases: hint.aliases,
      parameterText: toolSchemaSearchText(fn.parameters),
    };
  }).filter(x => x.name);
}

function legacyToolCatalogSearch(catalog, query, limit, nameBoost) {
  const words = String(query || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  const scored = (catalog || []).map(x => {
    const hay = `${x.name} ${x.pack} ${x.description}`.toLowerCase();
    const score = words.reduce((n, w) => n + (hay.includes(w) ? (x.name.toLowerCase().includes(w) ? nameBoost : 1) : 0), 0);
    return { x, score };
  }).filter(r => !words.length || r.score > 0).sort((a, b) => b.score - a.score || a.x.name.localeCompare(b.x.name)).slice(0, limit);
  return { ok: true, query: String(query || ''), matches: scored.map(({ x }) => ({ name: x.name, pack: x.pack, tier: x.tier, description: x.description })), packs: TOOL_PACK_DESCRIPTIONS };
}

function runtimeToolBlockedReason(item, config) {
  const mode = config && config.permissionMode;
  if ((mode === 'plan' || mode === 'dontAsk') && item && item.tier !== 'read') return `permission mode '${mode}' blocks ${item.tier}-tier execution`;
  return '';
}

// 21-E5 (metaToolHintsV1): 紧凑调用提示 —— 只加字段,不改排序/内容。requiredArgs 只取必填参数名与基础
// 类型(有界 ≤4,不回传完整 schema);callHint 告诉模型「direct 直调 / tool_invoke_* 代理 / tool_load 先加载」;
// state=blocked 携带不泄漏敏感信息的原因码(复用 searchToolCatalog 的 blockedReason 文本)。
function buildCallHint(item, loadedNames, config, blockedReason) {
  if (!item) return {};
  const name = String(item.name || '');
  const loaded = !!(loadedNames && loadedNames.has(name));
  const fn = item.tool && item.tool.function;
  const params = fn && fn.parameters;
  const props = (params && params.properties && typeof params.properties === 'object') ? params.properties : {};
  const required = Array.isArray(params && params.required) ? params.required.filter(k => props[k]).slice(0, 4) : [];
  const argTypes = {};
  for (const k of required) {
    const p = props[k] || {};
    if (typeof p.type === 'string') argTypes[k] = p.type;
    else if (Array.isArray(p.enum) && p.enum.length) argTypes[k] = 'enum';
    else argTypes[k] = 'any';
  }
  let callHint;
  if (loaded) callHint = 'direct';
  else if (item.bridged) callHint = 'tool_invoke_' + (item.tier || 'read');
  else callHint = 'tool_load';
  const state = loaded ? 'loaded' : (blockedReason ? 'blocked' : 'callable');
  return { requiredArgs: required, argTypes, callHint, state, ...(blockedReason ? { blockedReason } : {}) };
}

function searchToolCatalog(catalog, args, config, opts) {
  const query = String(args && args.query || '');
  const limit = Math.min(20, Math.max(1, Number(args && args.limit) || 8));
  const forceV1 = !!(opts && opts.forceV1);
  if ((!config || config.runtimeToolRetrievalV1 !== true) && !forceV1) {
    return legacyToolCatalogSearch(catalog, query, limit, Math.max(1, Number(opts && opts.legacyNameBoost) || 1));
  }
  const startedAt = Date.now();
  const qNorm = normalizeToolSearchText(query);
  const qTokens = [...new Set(tokenizeToolSearchText(query))];
  const docs = (catalog || []).map(item => {
    const fields = {
      name: tokenizeToolSearchText(item.name),
      aliases: tokenizeToolSearchText((item.aliases || []).join(' ')),
      capabilities: tokenizeToolSearchText((item.capabilities || []).join(' ')),
      parameters: tokenizeToolSearchText(item.parameterText || ''),
      description: tokenizeToolSearchText(item.description || ''),
      pack: tokenizeToolSearchText(item.pack || ''),
    };
    const all = new Set(Object.values(fields).flat());
    return { item, fields, all };
  });
  const df = new Map();
  for (const token of qTokens) df.set(token, docs.reduce((n, d) => n + (d.all.has(token) ? 1 : 0), 0));
  const weights = { name: 9, aliases: 7, capabilities: 6, parameters: 3, description: 2, pack: 2 };
  const ranked = docs.map(doc => {
    const components = {}; const matchedOn = new Set(); let score = 0;
    const itemNameNorm = normalizeToolSearchText(doc.item.name);
    if (qNorm && (qNorm === itemNameNorm || qNorm === String(doc.item.name || '').toLowerCase())) { components.exactName = 100; score += 100; matchedOn.add('exact_name'); }
    for (const alias of doc.item.aliases || []) {
      const a = normalizeToolSearchText(alias);
      if (qNorm && a && (qNorm.includes(a) || a.includes(qNorm))) { components.aliasPhrase = (components.aliasPhrase || 0) + 14; score += 14; matchedOn.add('alias'); break; }
    }
    for (const [field, tokens] of Object.entries(doc.fields)) {
      const set = new Set(tokens); let subtotal = 0;
      for (const token of qTokens) {
        if (!set.has(token)) continue;
        const freq = Math.max(1, df.get(token) || 1);
        const idf = Math.log(1 + (docs.length + 1) / freq);
        subtotal += weights[field] * idf;
      }
      if (subtotal > 0) { components[field] = Number(subtotal.toFixed(3)); score += subtotal; matchedOn.add(field); }
    }
    return { doc, score, components, matchedOn: [...matchedOn] };
  }).filter(r => !qTokens.length || r.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.item.name.localeCompare(b.doc.item.name)).slice(0, limit);
  const loadedNames = opts && opts.loadedNames instanceof Set ? opts.loadedNames : null;
  return {
    ok: true, query, retrievalVersion: 'deterministic-v1',
    queryHash: crypto.createHmac('sha256', RUNTIME_TELEMETRY_KEY).update(qNorm).digest('hex').slice(0, 16),
    elapsedMs: Date.now() - startedAt,
    matches: ranked.map(r => {
      const x = r.doc.item; const blockedReason = runtimeToolBlockedReason(x, config);
      return {
        name: x.name, pack: x.pack, tier: x.tier, description: x.description,
        score: Number(r.score.toFixed(3)), matchedOn: r.matchedOn,
        loaded: loadedNames ? loadedNames.has(x.name) : undefined,
        blockedReason: blockedReason || undefined,
      };
    }),
    packs: TOOL_PACK_DESCRIPTIONS,
  };
}

function compareToolRetrievalShadow(baseline, candidate) {
  const baselineNames = Array.isArray(baseline && baseline.matches) ? baseline.matches.slice(0, 5).map(x => x.name) : [];
  const candidateNames = Array.isArray(candidate && candidate.matches) ? candidate.matches.slice(0, 5).map(x => x.name) : [];
  const candidateSet = new Set(candidateNames);
  const overlap = baselineNames.filter(name => candidateSet.has(name)).length;
  const denominator = Math.max(1, Math.min(5, Math.max(baselineNames.length, candidateNames.length)));
  return {
    retrievalVersion: candidate && candidate.retrievalVersion || 'deterministic-v1',
    queryHash: candidate && candidate.queryHash || '',
    baselineResultCount: Array.isArray(baseline && baseline.matches) ? baseline.matches.length : 0,
    candidateResultCount: Array.isArray(candidate && candidate.matches) ? candidate.matches.length : 0,
    baselineTopTools: baselineNames,
    candidateTopTools: candidateNames,
    top1Changed: (baselineNames[0] || '') !== (candidateNames[0] || ''),
    overlapAt5: Number((overlap / denominator).toFixed(3)),
    elapsedMs: Number(candidate && candidate.elapsedMs) || 0,
  };
}

// 20-F1 data gate: deterministic, read-only failure taxonomy. The caller may emit/log this result, but this
// function intentionally contains no retry or repair path. That keeps telemetry deployable before the local
// sample proves a bounded recovery loop is worth building.
//
// v2 is driven by real shadow shapes, not synthetic wording alone. Native process tools report failures through
// structured fields (`timedOut`, `interrupted`, `code`, `stderr`) while guards often use `hint`; v1 only read
// error/message/detail, which collapsed almost every real process failure into `unknown`. These fields are used
// in-memory for deterministic classification and the HMAC evidence fingerprint only. Raw stderr/hints are never
// returned or logged by this function.
const RUNTIME_FAILURE_CLASSIFIER_VERSION = 'deterministic-v2';
function classifyRuntimeToolFailure(toolName, result, meta) {
  if (!result || typeof result !== 'object' || result.ok === true || (result.ok !== false && !result.error)) return null;
  const disposition = String(meta && meta.disposition || 'executed');
  const tier = String(meta && meta.tier || 'read');
  const code = String(result.code == null ? '' : result.code).trim();
  const text = [result.errorClass, code, result.statusCode, result.error, result.message, result.detail, result.hint, result.stderr]
    .map(value => String(value == null ? '' : value).slice(0, 4000)).join(' ').slice(0, 12000);
  const mutating = tier !== 'read';
  const timedOut = result.timedOut === true || /timeout|timed out|etimedout|连接.{0,6}超时|超时/i.test(text);
  const interrupted = result.interrupted === true || result.steerInterrupted === true || /interrupted by user steer|用户插话中断|因用户.{0,8}中断/i.test(text);
  const transientTransport = timedOut || /econnreset|eai_again|econnrefused|enotfound|socket hang up|network error|connection (?:error|reset|refused|timeout)|remote host closed|\b429\b|\b50[234]\b|temporar|连接.{0,6}(重置|断开)|临时.{0,6}(错误|不可用)/i.test(text);
  const mutatingAmbiguity = transientTransport || interrupted || /operation aborted|effect unknown|outcome unknown|执行结果未知|副作用未知/i.test(text);
  const nonzeroExit = /^-?\d+$/.test(code) && Number(code) !== 0;
  let failureClass = 'unknown', recoverableHint = false, allowedRepair = 'diagnose_only';
  // A mutating call that timed out/lost transport/was interrupted may already have changed state. This safety
  // branch intentionally precedes every "repairable" text rule: never turn an ambiguous edit/exec into retry_once.
  if (mutating && (mutatingAmbiguity || disposition === 'steer_skipped')) {
    failureClass = 'side_effect_unknown'; allowedRepair = 'stop_for_effect_check';
  } else if (!mutating && transientTransport) {
    failureClass = 'transient_read'; recoverableHint = true; allowedRepair = 'retry_once';
  } else if (code === 'not-allowed' || /应用内部数据|已禁止文件工具访问|检测到脚本.{0,50}office|office.{0,40}工具层强制|请改用现成工具|use (?:a )?supported tool/i.test(text)) {
    failureClass = 'policy_blocked'; recoverableHint = true; allowedRepair = 'use_supported_tool';
  } else if (/permission|denied|拒绝|拒绝授权|无权限|not allowed|blocked by permission/i.test(text)) {
    failureClass = 'permission_denied'; allowedRepair = 'request_authority';
  } else if (/old[_ ]?text.{0,24}(not found|missing|匹配.{0,8}(?:0|不到)|未找到)|找不到.{0,16}old[_ ]?text|expected text.{0,16}not found/i.test(text)) {
    failureClass = 'edit_conflict'; recoverableHint = true; allowedRepair = 'refresh_then_modify';
  } else if (/invalid.{0,20}(argument|parameter|input)|schema.{0,20}(fail|invalid)|required.{0,20}(property|field)|\b[a-z_][\w.-]*\s+is\s+required\b|参数.{0,12}(错误|无效|缺少)|缺少.{0,8}(参数|字段)|unexpected.{0,8}(argument|field)/i.test(text)) {
    failureClass = 'invalid_arguments'; recoverableHint = true; allowedRepair = 'modify_arguments';
  } else if (/unknown\s+(?:shell|session|resource)(?:id)?|(?:shell|session|resource).{0,20}(?:not found|missing|不存在|已结束)|未知\s*(?:shellid|会话|资源)/i.test(text)) {
    failureClass = 'resource_not_found'; recoverableHint = true; allowedRepair = 'reacquire_resource';
  } else if (/unknown tool|tool not found|connector.{0,16}(offline|unavailable)|mcp server.{0,20}not available|工具.{0,8}(不存在|不可用)/i.test(text)) {
    failureClass = 'tool_unavailable'; recoverableHint = true; allowedRepair = 'retrieve_alternative_tool';
  } else if (result.loopAborted || disposition === 'loop_refused' || /no.?progress|semantic.?stall|死循环|无新(信息|进展)|相同工具调用/i.test(text)) {
    failureClass = 'no_progress'; recoverableHint = true; allowedRepair = 'replan';
  } else if (/verification|quality gate|coverage|evidence_missing|gate_(rejected|uncovered|unverified)|校验失败|验证失败|质量门/i.test(text)) {
    failureClass = 'verification_failed'; recoverableHint = true; allowedRepair = 'repair_then_verify';
  } else if (nonzeroExit || /traceback \(most recent call last\)|syntaxerror|parsererror|commandnotfoundexception|referenceerror|typeerror|uncaught exception/i.test(text)) {
    failureClass = 'execution_failed'; recoverableHint = true; allowedRepair = 'inspect_error_then_modify';
  }
  return {
    classifierVersion: RUNTIME_FAILURE_CLASSIFIER_VERSION,
    failureClass, recoverableHint, allowedRepair, deterministic: true,
    tier, disposition,
    evidenceHash: crypto.createHmac('sha256', RUNTIME_TELEMETRY_KEY).update(String(toolName || '') + '\0' + text).digest('hex').slice(0, 16),
  };
}

function listCompactTools(catalog, args) {
  const pack = String(args && args.pack || '').trim();
  const cursor = Math.max(0, Math.floor(Number(args && args.cursor) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(args && args.limit) || 200)));
  const available = (catalog || []).filter(x => !pack || x.pack === pack)
    .slice().sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
  const page = available.slice(cursor, cursor + limit);
  const groups = {};
  for (const item of page) {
    if (!groups[item.pack]) groups[item.pack] = [];
    groups[item.pack].push(item.name);
  }
  const nextCursor = cursor + page.length < available.length ? cursor + page.length : null;
  return {
    ok: true, pack: pack || null, total: available.length, cursor, count: page.length, nextCursor,
    groups, availablePacks: Object.keys(TOOL_PACK_DESCRIPTIONS),
    next: nextCursor === null ? 'Use tool_search with a capability or exact name for descriptions and risk tiers.' : `Call list_tools again with cursor ${nextCursor}.`,
  };
}

// 106 #1 G2(21-E4 §7.2): 会话级 schema 冻结表 —— appendOnlyToolSchemasV1 开时按 session 冻结
// tools 顺序,之后只追加不重排(探针 S5: 中间插入全前缀命中归零,尾部追加保留 ~77%)。
// 进程内 Map 不持久化:重启后按当次分类重建(等价于新会话的首建冻结),条目变化才记录。
// 上限 200 会话防常驻内存增长,淘汰最久未触碰。
const toolSchemaFreezeBySessionMap = new Map();
function toolSchemaFreezeFor(freezeKey) {
  let freeze = toolSchemaFreezeBySessionMap.get(freezeKey);
  if (!freeze) {
    freeze = { names: [], nameSet: new Set(), initLogged: false, missingKey: '' };
    toolSchemaFreezeBySessionMap.set(freezeKey, freeze);
    if (toolSchemaFreezeBySessionMap.size > 200) toolSchemaFreezeBySessionMap.delete(toolSchemaFreezeBySessionMap.keys().next().value);
  } else {
    // 触碰:提到最新位置,淘汰队首即最久未用
    toolSchemaFreezeBySessionMap.delete(freezeKey);
    toolSchemaFreezeBySessionMap.set(freezeKey, freeze);
  }
  return freeze;
}

function createToolLoadingState(config, message, attachments, tools, bridgedRoute, freezeKey) {
  const catalog = buildToolCatalog(tools, bridgedRoute, config);
  const full = config && config.toolLoadingMode === 'full';
  const activePacks = new Set(full ? Object.keys(TOOL_PACK_DESCRIPTIONS) : classifyToolPacks(message, attachments));
  const activeNames = new Set();
  const metaNames = new Set(['list_tools', 'tool_search', 'tool_load']);
  // 106 #1 G2: 冻结仅在有会话权属的主循环启用(freezeKey = session.id);子代理/一次性调用不传,
  // 保持现状逐字节一致。
  const freeze = (appendOnlyToolSchemasEnabled(config) && typeof freezeKey === 'string' && freezeKey) ? toolSchemaFreezeFor(freezeKey) : null;
  // O1 (hb360): auto 模式下桥接工具不按包自动注入 schema（走 tool_invoke_* 代理或 tool_load 显式拉入），
  // 避免单任务注入 100-280 个桥接 schema 导致 input 膨胀（实测均值 303K tokens）。full 模式与元工具/显式拉入不受影响。
  // O4 (hb360) 对抗验证回退: 高频白名单(file_read 始终注入)破坏 adaptive loading 的"按需注入"语义
  // (tool-loading e2e 断言 file_read 在 tool_load 前不注入);且真实任务 classifyToolPacks 已激活 files_read,
  // 白名单仅对纯闲聊任务有用(而闲聊不需要 file_read),收益不抵语义破坏,故回退。
  const liveList = () => catalog.filter(x => full || metaNames.has(x.name) || activeNames.has(x.name) || (!x.bridged && activePacks.has(x.pack)));
  const current = () => {
    const live = liveList();
    if (!freeze) return live.map(x => x.tool);
    // 冻结布局:输出 = 冻结序(仍在 catalog 的条目保位) + 本次新激活按 catalog 序追加尾部。
    const byName = new Map(catalog.map(x => [x.name, x]));
    const added = [];
    for (const x of live) {
      if (!freeze.nameSet.has(x.name)) { freeze.nameSet.add(x.name); freeze.names.push(x.name); added.push(x.name); }
    }
    const missing = freeze.names.filter(n => !byName.has(n));
    const missingKey = missing.join('');
    try {
      if (!freeze.initLogged && freeze.names.length) {
        freeze.initLogged = true;
        logEvent({ kind: 'tool_schema_freeze', state: 'init', sessionId: freezeKey, count: freeze.names.length });
      }
      if (added.length) logEvent({ kind: 'tool_schema_freeze', state: 'append', sessionId: freezeKey, added, count: freeze.names.length });
      if (missingKey !== freeze.missingKey) {
        freeze.missingKey = missingKey;
        // catalog 缺失(MCP 离线/撤权/caps 变化)= 必然缓存断裂,按 E4 §7.2 记录原因,不为命中率保留错误授权
        if (missing.length) logEvent({ kind: 'tool_schema_freeze', state: 'cache_break', reason: 'catalog_miss', sessionId: freezeKey, missing });
      }
    } catch { /* 遥测绝不阻断 */ }
    return freeze.names.filter(n => byName.has(n)).map(n => byName.get(n).tool);
  };
  const search = (query, limit) => {
    const loadedNames = new Set(current().map(t => t.function && t.function.name).filter(Boolean));
    const result = searchToolCatalog(catalog, { query, limit }, config, { legacyNameBoost: 3, loadedNames });
    // 21-E5 (metaToolHintsV1): 每个 Top-K 候选追加紧凑调用提示(requiredArgs/callHint/state/blockedReason)。
    // 只加字段,不改 legacy 排序、匹配、数量或 description —— 开关关时返回结构与现状逐字节一致。
    if (config && config.metaToolHintsV1 === true) {
      result.matches = (result.matches || []).map(m => {
        const item = catalog.find(c => c.name === m.name);
        return { ...m, ...buildCallHint(item, loadedNames, config, m.blockedReason) };
      });
    }
    return result;
  };
  const shadowSearch = (query, limit) => {
    const loadedNames = new Set(current().map(t => t.function && t.function.name).filter(Boolean));
    return searchToolCatalog(catalog, { query, limit }, config, { forceV1: true, legacyNameBoost: 3, loadedNames });
  };
  const load = args => {
    const before = new Set(current().map(t => t.function.name));
    for (const p of Array.isArray(args && args.packs) ? args.packs : []) if (TOOL_PACK_DESCRIPTIONS[p]) activePacks.add(p);
    for (const n of Array.isArray(args && args.tools) ? args.tools : []) if (catalog.some(x => x.name === n)) activeNames.add(n);
    const after = current().map(t => t.function.name);
    return { ok: true, loaded: after.filter(n => !before.has(n)), activePacks: [...activePacks], toolCount: after.length };
  };
  const list = args => listCompactTools(catalog, args);
  return { catalog, activePacks, current, list, search, shadowSearch, load, fullCount: catalog.length };
}

function estimateToolSchemaTokens(tools) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  return Math.round(estimateTextTokens(JSON.stringify(tools)));
}

// Decide gate for a tool call given the permission mode. Returns 'allow' | 'ask' | 'block'.
function nativeToolGate(mode, tier) {
  // v1.4.3: accept both 'bypass' (internal) and 'bypassPermissions' (CLI-native) as full-bypass
  if (mode === 'bypass' || mode === 'bypassPermissions') return 'allow';
  if (tier === 'read') return 'allow';
  if (mode === 'plan' || mode === 'dontAsk') return 'block';
  // v1.4.3: 'auto' mode — AI risk-classifier decides. In the native engine we approximate:
  // allow edit-tier (low-risk, reversible) and prompt for exec-tier.
  if (mode === 'auto' && tier === 'edit') return 'allow';
  if (mode === 'acceptEdits' && tier === 'edit') return 'allow';
  return 'ask';
}
// v0.8-S4b B3: which tools produce a change that the checkpoint journal can undo? Exactly the journaled
// file mutations (file_write/file_edit/file_delete → create/modify/delete `before` snapshots). Everything
// else (exec, desktop, network) leaves no journal entry → not auto-revertible. The permission popup shows
// this at the DECISION moment (「✓ 此操作可一键撤销」/「⚠ 此操作无法自动撤销」) — an after-the-fact undo
// card can't reassure a user who was scared off before allowing. Kept as a small set so the UI needn't
// duplicate the tier table; the event carries the boolean directly.
// v1.1-W2 (T1): move/copy/zip/unzip/download 全部走 journalRecord 存 before 快照 → 可撤销，进 REVERTIBLE。
// 名字级承诺(与内建文件工具同保真度):实际快照仍可能因越界/超限被跳过,届时该条在「本轮变更」卡上回落为不可撤销。
const REVERTIBLE_TOOLS = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download']);
function toolIsRevertible(toolName) {
  const n = String(toolName || '');
  if (REVERTIBLE_TOOLS.has(n)) return true;
  // v1.0.2-W1.5 把关补:bridged 写族(ACC write_docx/write_excel/write_pdf/write_file/delete_file)现已由
  // journalBridgedWrite 在分发前存 before 快照 → 权限弹窗的可撤销徽章与「本轮变更」卡(journal 驱动)对齐。
  // 与内建工具同保真度:名字级承诺(实际快照仍可能因越界/超限被跳过,届时该条在变更卡上回落为不可撤销)。
  return Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, unprefixedBridgedName(n));
}
// Ask the UI to approve a native tool call — reuses the pendingPermissions + /api/permission/decision bridge.
// v0.8-S4b: the permission_request event now also carries `tier` (read|edit|exec) and `revertible` (bool)
// so the popup can render a risk badge + a plain-language revertibility line without re-deriving them.
// 第27f波:pause = { enabled, ttlMs, onPause(requestId) } —— 无人值守回合的权限超时【存档暂停】。基础超时到点后不立即拒杀,
// 而是打检查点(onPause)+ 发 permission_paused 事件 + 把决定窗口延长到 ttlMs;窗口内仍可经 /api/permission/decision 决定,
// 到 ttlMs 无人应答则回落 deny(fail-closed)。entry.timer 在 Map 里被重赋为 TTL 定时器,故 clearPendingPermissions/decision 照常清对。
function requestNativePermission(sessionId, toolName, input, onEvent, timeoutMs, tier, pause) {
  return new Promise(resolve => {
    const requestId = makeId('perm');
    onEvent({ type: 'permission_request', requestId, toolName, input, tier: tier || 'exec', revertible: toolIsRevertible(toolName) });
    registerIntervention(sessionId, 'permission', requestId, {
      toolName: String(toolName || ''), tier: tier || 'exec', revertible: toolIsRevertible(toolName),
      // Wave 81: persist the concrete scope shown by the classic prompt so a cross-session
      // decision never degrades into a context-free approval.
      input: input && typeof input === 'object' && !Array.isArray(input) ? input : {},
    });
    let settled = false;
    const settle = (decision, opts = {}) => {
      if (settled) return;
      settled = true;
      // 75b command-core callers persist the CAS terminal row themselves. Automatic timeout/teardown
      // callers omit this flag and keep the legacy self-settling behavior.
      if (opts.skipInterventionSettle !== true) {
        settleIntervention(sessionId, requestId, decision && decision.behavior === 'allow' ? 'allowed' : 'denied', { decidedBy: decision && decision.behavior === 'allow' ? 'user' : 'auto', note: decision && decision.message ? String(decision.message).slice(0, 500) : '' });
      }
      try { onEvent({ type: 'permission_decision', requestId, behavior: decision && decision.behavior === 'allow' ? 'allow' : 'deny', message: decision && decision.message }); } catch { /* stream gone */ }
      resolve(decision);
    };
    const entry = { resolve: settle, sessionId, timer: null };
    const baseMs = Math.max(5000, Number(timeoutMs) || 120000);
    if (pause && pause.enabled) {
      entry.timer = setTimeout(() => {
        try { if (pause.onPause) pause.onPause(requestId); } catch { /* 检查点失败不阻断 */ }
        try { onEvent({ type: 'permission_paused', requestId, toolName, tier: tier || 'exec', ttlMs: pause.ttlMs }); } catch { /* stream gone */ }
        entry.timer = setTimeout(() => {
          const message = '权限已存档暂停但在时限内无人决定,已回落拒绝';
          runAutomaticInterventionDecision({
            missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
            idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
          }, () => {
            if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
            pendingPermissions.delete(requestId);
            settle({ behavior: 'deny', message, pausedTimeout: true });
          });
        }, Math.max(60000, Number(pause.ttlMs) || 2700000));
      }, baseMs);
    } else {
      entry.timer = setTimeout(() => {
        const message = 'permission prompt timed out';
        runAutomaticInterventionDecision({
          missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
          idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
        }, () => {
          if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
          pendingPermissions.delete(requestId);
          settle({ behavior: 'deny', message });
        });
      }, baseMs);
    }
    pendingPermissions.set(requestId, entry);
  });
}

// v0.9-S5: does a first assistant message look like a PLAN? Tolerant: strip leading whitespace, then accept
// `PLAN:` (any case) or the Chinese 「计划:」/「计划：」. Returns true so the caller enters the plan pause; a
// non-matching first answer falls back to the legacy hard-block plan behavior (backward compatible).
function looksLikePlan(text) {
  const t = String(text || '').replace(/^\s+/, '');
  return /^plan\s*[:：]/i.test(t) || /^计划\s*[:：]/.test(t);
}
// v0.9-S5: emit a `plan` event and PAUSE the turn until the UI decides (or the timeout auto-rejects). Mirrors
// requestNativePermission but on the plan channel. Resolves { decision:'approve'|'reject', note? }. The
// timeout is REJECT (per spec: 超时=permissionTimeoutMs → 视为 reject). clearPendingPlans (abort/stop/turn-end)
// also settles the promise as reject so the awaiting loop can never hang.
function requestPlanApproval(sessionId, markdown, onEvent, timeoutMs) {
  return new Promise(resolve => {
    const planId = makeId('plan');
    onEvent({ type: 'plan', planId, markdown: String(markdown || '') });
    registerIntervention(sessionId, 'plan', planId, { planSummary: String(markdown || '').slice(0, 500) });
    let settled = false;
    const settle = (decision, opts = {}) => {
      if (settled) return;
      settled = true;
      if (opts.skipInterventionSettle !== true) {
        settleIntervention(sessionId, planId, decision && decision.decision === 'approve' ? 'approved' : 'rejected', { decidedBy: decision && decision.decision === 'approve' ? 'user' : 'auto', note: decision && decision.note ? String(decision.note).slice(0, 500) : '' });
      }
      try { onEvent({ type: 'plan_decision', planId, decision: decision && decision.decision === 'approve' ? 'approve' : 'reject', note: decision && decision.note }); } catch { /* stream gone */ }
      resolve(decision);
    };
    const timer = setTimeout(() => {
      const note = 'plan approval timed out';
      const entry = pendingPlans.get(planId);
      runAutomaticInterventionDecision({
        missionId: sessionId, interventionId: planId, source: 'timeout_plan', decidedBy: 'timeout',
        idempotencyKey: `timeout:${planId}`, payload: { action: 'reject', feedback: note },
      }, () => {
        if (pendingPlans.get(planId) !== entry || (entry && entry.commandApplying)) return;
        pendingPlans.delete(planId);
        settle({ decision: 'reject', note });
      });
    }, Math.max(5000, Number(timeoutMs) || 120000));
    pendingPlans.set(planId, { resolve: settle, sessionId, timer });
  });
}

// v1.0-S6 (B): provider endpoint FAILOVER (备用端点故障转移). Strict boundary — we switch endpoints ONLY on a
// PRE-FIRST-BYTE failure, because a mid-stream re-issue would REPLAY already-emitted content (duplication).
//   • connect-class transport failure (the socket never delivered a usable response): ECONNREFUSED /
//     ETIMEDOUT / ENOTFOUND / EHOSTUNREACH / EAI_AGAIN / ECONNRESET / TLS handshake failure / a generic
//     "fetch failed" the runtime raised before any body byte;
//   • HTTP 502 / 503 / 504 observed at the RESPONSE-HEADER stage (upstream gateway unavailable).
// NOT a failover trigger (换端点无益 or would mask a real error): 400/401/403/404/422/429 (auth/request/
// rate-limit — see the caller), and ANY failure once the SSE body has begun streaming (handled by the
// caller's existing error path, never here).
const FAILOVER_HTTP_STATUSES = new Set([502, 503, 504]);
// Connect-class Node error codes worth failing over on (a fresh endpoint may succeed).
const FAILOVER_CONNECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'ECONNRESET']);
// Classify a caught fetch throw (pre-first-byte). Returns a short reason token when it is failover-eligible
// connect-class, else null. Inspects the error's `code` (Node/undici surfaces the syscall code on `.cause`
// too), plus TLS/"fetch failed" message fragments the runtime uses when no `code` is attached.
function failoverConnectReason(err) {
  if (!err) return null;
  const code = String((err && err.code) || (err && err.cause && err.cause.code) || '').toUpperCase();
  if (code && FAILOVER_CONNECT_CODES.has(code)) return 'connect';
  const msg = String((err && err.message) || '');
  if (/certificate|tls|ssl|self[- ]signed|handshake|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) return 'tls';
  // undici raises a bare "fetch failed" (with the real cause nested) for connect refusals/DNS — treat as connect.
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|network|socket hang up/i.test(msg)) return 'connect';
  return null;
}
// Session-scoped sticky endpoint memory: provider.id → last base that STREAMED successfully this serve
// process. Not persisted (in-memory only, per spec). Cleared implicitly on process exit.
const failoverStickyBase = new Map();

// v1.7 — OpenAI Responses API request shaping (DeepSeek /v1/responses, Codex/agent oriented).
// Ruyi's provider engine keeps ONE normalized chat-shaped providerHistory (roles user/assistant/tool +
// assistant.tool_calls). The Responses protocol wants `input` ITEMS instead of `messages`, so we translate
// at request time (never mutating the stored history — multi-round tool loops keep working identically):
//   user        → { type:'message', role:'user', content:[{type:'input_text', text}] }
//   assistant   → optional {type:'reasoning',content:[{type:'reasoning_text',text}]} then
//                 { type:'message', role:'assistant', content:[{type:'output_text', text}] } (+ function_call items)
//   tool        → { type:'function_call_output', call_id, output }
//   system      → folded into `instructions` (the Responses equivalent of a leading system message)
// function tools are ALSO flattened: Responses uses { type:'function', name, description, parameters }
// (chat's nested { type:'function', function:{...} } shape is NOT accepted there).
function toResponsesContent(content) {
  // String → single input_text block. Parts array (vision) → text parts only (Responses/DeepSeek has no image
  // input; image_url parts degrade to a visible placeholder instead of erroring the request).
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
      else if (part.type === 'input_text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
      else if (part.type === 'image_url' || part.type === 'input_image') parts.push({ type: 'input_text', text: '[图片输入：Responses API 不支持图像，已替换为占位文本]' });
    }
    return parts.length ? parts : [{ type: 'input_text', text: '' }];
  }
  return [{ type: 'input_text', text: String(content || '') }];
}
// Translate a chat-shaped providerHistory into Responses `input` items (see header note).
// 21-E3: 已执行动作的参数历史双视图 —— 纯函数(可 e2e 直测)。execution/audit view 保留完整 rawArgs
// (session.actionAudit + providerHistory 原消息),provider model view 投影为紧凑 envelope。
// 投影纪律:只投影 status=completed 且 sha256 与原始 arguments 可校验的动作;失败/中断/待审批不瘦身;
// 只加/换 arguments 字段,tool_call id/type/function.name 原样保留(pairing 铁律不破坏)。
const ACTION_VIEW_TOOLS = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download', 'script_run', 'powershell_run', 'tool_invoke_edit', 'tool_invoke_exec']);
const ACTION_VIEW_MIN_CHARS = 512;

function actionTargetMeta(toolName, args) {
  const input = (args && typeof args === 'object') ? args : {};
  const name = String(toolName || '');
  const pathKey = input.path || input.source || input.destination || input.dest || input.output || input.output_path || input.root || '';
  if (/^(script_run|file_)/.test(name) && pathKey) {
    return { kind: 'path', basename: path.basename(String(pathKey)) };
  }
  if (name === 'powershell_run') {
    const cmd = String(input.command || '');
    return { kind: 'cmd', basename: cmd.slice(0, 40) || 'powershell' };
  }
  if (/^tool_invoke_/.test(name)) {
    return { kind: 'proxy', basename: String(input.name || '') };
  }
  return { kind: 'path', basename: pathKey ? path.basename(String(pathKey)) : '' };
}

function buildActionEnvelope(toolName, args, rawArgs) {
  const sha256 = crypto.createHash('sha256').update(String(rawArgs || '')).digest('hex');
  const target = actionTargetMeta(toolName, args);
  return {
    _ruyiActionRef: 'action-v1:ref', // 占位;实际 ref 由 audit 条目给出(turnSeq:toolCallId)
    target: { ...target, pathHash: crypto.createHash('sha1').update(String(target.basename || '')).digest('hex').slice(0, 12) },
    operation: String(toolName || ''),
    payload: { chars: Buffer.byteLength(String(rawArgs || ''), 'utf8'), sha256 },
    status: 'completed',
  };
}

// 返回 { history, changed } —— 浅投影:只对命中 audit 且校验通过的 assistant.tool_calls 替换 arguments。
function projectActionModelView(history, auditMap) {
  if (!Array.isArray(history) || !(auditMap instanceof Map) || auditMap.size === 0) return { history, changed: false };
  let changed = false;
  const projected = history.map(m => {
    if (!m || typeof m !== 'object' || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
    let msgChanged = false;
    const toolCalls = m.tool_calls.map(tc => {
      if (!tc || tc.id == null) return tc;
      const entry = auditMap.get(String(tc.id));
      if (!entry || entry.status !== 'completed' || !entry.sha256) return tc;
      if (!ACTION_VIEW_TOOLS.has(entry.toolName)) return tc; // 防御双保险:仅投影白名单写动作
      const rawArgs = String((tc.function && tc.function.arguments) || '');
      if (Buffer.byteLength(rawArgs, 'utf8') < ACTION_VIEW_MIN_CHARS) return tc;
      if (crypto.createHash('sha256').update(rawArgs).digest('hex') !== entry.sha256) return tc; // 校验失败不投影
      let args; try { args = JSON.parse(rawArgs); } catch { return tc; } // 对抗:A4 malformed arguments 不投影(拒绝生成空 envelope)
      msgChanged = true;
      const env = buildActionEnvelope(entry.toolName, args, rawArgs);
      env._ruyiActionRef = entry.actionRef || env._ruyiActionRef;
      return { ...tc, function: { ...(tc.function || {}), arguments: JSON.stringify(env) } };
    });
    if (!msgChanged) return m;
    changed = true;
    return { ...m, tool_calls: toolCalls };
  });
  return { history: projected, changed };
}

function buildResponsesInputItems(history) {
  const items = [];
  const paired = responsesHistoryWithCompleteToolPairs(history).history;
  for (const m of paired) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') continue; // folded into instructions by the caller
    if (m.role === 'user') { items.push({ type: 'message', role: 'user', content: toResponsesContent(m.content) }); continue; }
    if (m.role === 'assistant') {
      // DeepSeek Responses is stateless and thinking mode is enabled by default. When tools are present it
      // requires every prior reasoning_text to be passed back; dropping it makes the next tool-loop request
      // fail with HTTP 400. Keep the normalized history chat-shaped, but project its reasoning_content into
      // a first-class Responses reasoning item immediately before the adjacent assistant/function_call items.
      const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
      if (reasoning) items.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoning }] });
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || tc.id == null) continue;
          items.push({ type: 'function_call', call_id: String(tc.id), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) || '' });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      if (m.tool_call_id != null) {
        items.push({ type: 'function_call_output', call_id: String(m.tool_call_id), output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '') });
      }
      continue;
    }
    items.push({ type: 'message', role: 'user', content: toResponsesContent(m.content) }); // unknown role → user
  }
  return items;
}
// Flatten chat-shaped function tools ({type:'function', function:{...}}) into Responses' flat shape.
// v1.8: Ruyi's local `web_search` function tool is MAPPED to the Responses SERVER-SIDE tool
// {type:'web_search'} (DeepSeek executes it; events web_search_call.* + output_item web_search_call) —
// but ONLY when the provider opts in via serverWebSearch:true (the DeepSeek preset ships it). This keeps
// the built-in LOCAL web_search (builtin/searxng/bing/brave/tavily/bocha/custom backends) as the FALLBACK
// for every other provider and for Responses endpoints that ignore server-side tool types (DeepSeek
// silently drops unsupported tools — an unconditional mapping would silently remove web_search there).
// DeepSeek ignores unknown builtin tool types, so only web_search is ever mapped; everything else keeps
// its historical flatten/passthrough behavior.
function toResponsesTools(tools, serverWebSearch) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const flatName = t.type === 'function' ? (t.name || (t.function && t.function.name) || '') : '';
    if (serverWebSearch === true && flatName === 'web_search') {
      out.push({ type: 'web_search' });
      continue;
    }
    if (t.type === 'function' && t.function && typeof t.function === 'object') {
      out.push({ type: 'function', name: t.function.name || '', description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } });
    } else if (t.type === 'function') {
      out.push({ type: 'function', name: t.name || '', description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } });
    } else {
      out.push(t); // web_search etc. pass through verbatim
    }
  }
  return out;
}

// One streaming chat/completions call. Emits assistant_delta / thinking_delta / raw_line live; returns
// { text, reasoning, toolCalls:[{id,name,rawArgs}], finishReason, httpError, toolsRejected }.
// v1.0-S6 (B): pre-first-byte failures are surfaced structurally so the caller can decide failover:
//   • a caught fetch throw BEFORE any body byte → { transportError, transportReason:<'connect'|'tls'>, ... }
//     (only when failover-eligible; a non-eligible throw — e.g. an AbortError — is re-thrown to the caller);
//   • a non-ok response whose status is 502/503/504 → the returned httpError object also carries
//     { failoverStatus:<502|503|504> } so the caller can advance. A throw that happens AFTER streaming has
//     started still propagates normally (caller's error path; no failover — 防重放).
// v1.7: ALSO speaks the OpenAI Responses API protocol when the request body carries `input` (not `messages`).
// DeepSeek added /v1/responses for Codex/agent loops (v4-flash now, v4-pro from 2026-08). The two protocols
// differ end-to-end (request shape, SSE event types, terminal condition), so `isResponses` selects a parallel
// parser inside — chat keeps its battle-tested path byte-for-byte; responses handles
// response.output_text.delta / response.reasoning_text.delta / response.function_call_arguments.delta /
// response.output_item.added / response.completed|incomplete|failed (NO `data: [DONE]` terminator).
async function openAiStreamOnce({ chatUrl, headers, body, ctrl, onEvent, markUsage, rawSeqRef, touch }) {
  const isResponses = !!(body && Array.isArray(body.input)); // Responses body uses `input` items, chat uses `messages`
  let providerResponseId = ''; // 21-E0: provider 侧响应 id(辅助字段,请求侧 modelCallId 为主键)
  const doFetch = b => fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(b), signal: ctrl ? ctrl.signal : undefined });
  let res;
  try {
    res = await doFetch(body);
  } catch (e) {
    // Pre-first-byte throw. An abort (user Stop / watchdog) is NOT a failover case — re-throw so the caller's
    // AbortError handling runs. A connect/TLS-class failure is surfaced structurally for the failover decision;
    // anything else is re-thrown to preserve the existing error path & attribution.
    if (e && e.name === 'AbortError') throw e;
    const reason = failoverConnectReason(e);
    if (reason) return { transportError: (e && e.message) ? e.message : String(e), transportReason: reason, text: '', reasoning: '', toolCalls: [] };
    throw e;
  }
  touch();
  // v0.9-S0 400 attribution (§0.9-S0): tighten the order in which we classify a 400.
  // The old code sniffed stream_options FIRST. But a provider that rejects a tools-bearing request
  // often phrases it as "tools are not supported here" / "function calling is not supported" — the
  // "not support" fragment matched the stream_options regex, so we stripped stream_options and RETRIED
  // WITH TOOLS, hitting the same 400 forever (v0.8-S6 收官遗留误判案例; caught while wiring FAKE_REJECT_TOOLS).
  // Fix: when the request CARRIES tools AND the error text has tool/function semantics, attribute it to
  // tools-rejected FIRST (caller retries once without tools). Only if it is NOT a tools/function 400 do we
  // fall back to the stream_options sniff. For requests WITHOUT tools the behavior is unchanged — the
  // requestHasTools guard means the tools-first branch never fires, so the stream_options path is preserved.
  const requestHasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (res && res.status === 400) {
    let t = ''; try { t = await res.text(); } catch { /* ignore */ }
    const toolsSemantics = /tool|function/i.test(t);
    // tools-rejected 仍最先(45f 对抗轮 P1-1 恢复既有存活路径):真实超窗报文一般不含 tool/function 字样,
    // 而 tools 拒绝报文可能带 "in this context" —— 顺序反了会把非超窗错误吸进破坏性压缩。
    if (requestHasTools && toolsSemantics) {
      // tools-rejected takes priority over the stream_options retry (§0.9-S0).
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, toolsRejected: true, text: '', reasoning: '', toolCalls: [] };
    }
    // 第45波:context-overflow 先于 stream_options 误判 —— "invalid_request_error" 是 OpenAI 系 400
    // 的标准 type(真实 DeepSeek 超限报文正是它),而 stream_options 嗅探的正则含裸 /invalid/,会把上下文
    // 超限误吸进「剥 stream_options 静默重试」(剥了也照样超窗,纯浪费一次调用还掩盖 45b 的强压入口)。
    // (45f P1-1:判定器已收紧为「上下文×长度共现」,裸 invalid/context 字样不再命中。)
    if (isContextOverflowError('HTTP 400: ' + t)) {
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, contextOverflow: true, text: '', reasoning: '', toolCalls: [] };
    }
    // Some servers reject stream_options — retry once without it before failing.
    if (body.stream_options && /stream_options|unsupported|unknown|invalid|not\s*support/i.test(t)) {
      const b2 = Object.assign({}, body); delete b2.stream_options; res = await doFetch(b2);
    } else {
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, toolsRejected: toolsSemantics, text: '', reasoning: '', toolCalls: [] };
    }
  }
  if (!res || !res.ok) {
    let d = ''; if (res) { try { d = await res.text(); } catch { /* ignore */ } }
    // v1.0-S6 (B): tag a gateway-unavailable status (502/503/504) so the caller can fail over to a backup
    // endpoint. This is still a pre-first-byte failure (we только read the error body, not an SSE stream).
    // Auth/request/rate-limit statuses (401/403/400/404/422/429) carry NO failoverStatus → caller won't switch.
    const failoverStatus = (res && FAILOVER_HTTP_STATUSES.has(res.status)) ? res.status : undefined;
    return { httpError: `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 500)) : ''}`, toolsRejected: /tool|function/i.test(d), failoverStatus, text: '', reasoning: '', toolCalls: [] };
  }
  // Non-streaming fallback: single JSON body.
  if (!res.body || typeof res.body.getReader !== 'function') {
    const j = await res.json().catch(() => null);
    // v1.7 (Responses API): a non-streamed response body is a `response` object with an `output` item list
    // (message / function_call / reasoning…), NOT chat's {choices:[{message}]}. Normalize it to the same
    // { text, reasoning, toolCalls } shape so every caller is protocol-agnostic.
    if (isResponses) {
      const out = Array.isArray(j && j.output) ? j.output : [];
      let respText = '', respReasoning = '';
      const tcs = [];
      for (const item of out) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'function_call') {
          tcs.push({ id: item.call_id || makeId('call'), name: item.name, rawArgs: (typeof item.arguments === 'string' && item.arguments) ? item.arguments : '{}' });
          continue;
        }
        if (item.type === 'reasoning') {
          const parts = Array.isArray(item.content) ? item.content : [];
          for (const part of parts) { if (part && part.type === 'reasoning_text' && typeof part.text === 'string') respReasoning += part.text; }
          continue;
        }
        if (item.type === 'message') {
          const parts = Array.isArray(item.content) ? item.content : [];
          for (const part of parts) { if (part && (part.type === 'output_text' || part.type === 'input_text') && typeof part.text === 'string') respText += part.text; }
        }
      }
      // E6 parity: surface reasoning before content, matching the streaming order.
      if (respReasoning) onEvent({ type: 'thinking_delta', text: respReasoning });
      if (respText) onEvent({ type: 'assistant_delta', text: respText });
      if (j && j.usage) markUsage(j.usage);
      return { text: respText, reasoning: respReasoning, toolCalls: tcs.filter(t => t.name), finishReason: (j && j.status === 'incomplete') ? 'length' : ((j && j.status === 'failed') ? 'error' : 'stop'), providerResponseId: (j && (j.id || (j.response && j.response.id))) || providerResponseId };
    }
    const ch = j && j.choices && j.choices[0];
    const msg = ch && ch.message;
    // E6: this branch previously returned reasoning_content but never surfaced it as a thinking_delta, so a
    // non-streaming endpoint's reasoning chain was invisible in the UI. Emit it here (before the content, to
    // match the streaming order) whether the provider spells it reasoning_content or reasoning.
    const reasoningText = (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content) || (msg && typeof msg.reasoning === 'string' && msg.reasoning) || '';
    if (reasoningText) onEvent({ type: 'thinking_delta', text: reasoningText });
    if (msg && typeof msg.content === 'string' && msg.content) onEvent({ type: 'assistant_delta', text: msg.content });
    if (j && j.usage) markUsage(j.usage);
    const tcs = Array.isArray(msg && msg.tool_calls) ? msg.tool_calls.map(tc => ({ id: tc.id || makeId('call'), name: tc.function && tc.function.name, rawArgs: (tc.function && tc.function.arguments) || '{}' })).filter(t => t.name) : [];
    return { text: (msg && msg.content) || '', reasoning: reasoningText, toolCalls: tcs, finishReason: ch && ch.finish_reason, providerResponseId: (j && (j.id || (j.response && j.response.id))) || providerResponseId };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', text = '', reasoning = '', finishReason = null, done = false, responsesFailedError = '';
  // E1: accumulate streamed tool_calls into SLOTS keyed primarily by tool_call id. A delta carrying a
  // non-empty id opens (or re-selects) that call's slot; a delta with only an index selects/creates the slot
  // for that index; a delta with neither keeps writing to the CURRENT slot. This "non-empty id => open/select
  // a slot, otherwise keep writing the current slot" state machine keeps multiple PARALLEL tool_calls
  // independent even when the provider omits `index` on the delta fragments (some vLLM/Ollama/self-hosted
  // endpoints do). The old code forced every index-less delta into acc[0], splicing distinct calls' names
  // ("file_readfile_write") and arguments into one corrupt, unparseable blob.
  const slots = []; // { id, index, name, args } in first-seen order
  let curSlot = null;
  const selectSlot = tc => {
    // Priority 1: an explicit, non-empty id is the authoritative call identity -> find-or-create by id
    // (idempotent whether the provider sends the id once at the start or repeats it on every fragment).
    if (typeof tc.id === 'string' && tc.id) {
      let s = slots.find(x => x.id === tc.id);
      if (!s) {
        // Adopt a slot previously opened for this same index that has not yet been assigned an id.
        if (tc.index != null) s = slots.find(x => !x.id && x.index === tc.index);
        if (s) s.id = tc.id;
        else { s = { id: tc.id, index: (tc.index != null ? tc.index : null), name: '', args: '' }; slots.push(s); }
      }
      curSlot = s; return s;
    }
    // Priority 2: no id but an explicit index -> find-or-create by index (the standard OpenAI shape where
    // continuation fragments carry only the index).
    if (tc.index != null) {
      let s = slots.find(x => x.index === tc.index);
      if (!s) { s = { id: '', index: tc.index, name: '', args: '' }; slots.push(s); }
      curSlot = s; return s;
    }
    // Priority 3: neither id nor index -> keep writing to the current slot (open a first default slot if this
    // is the very first fragment).
    if (!curSlot) { curSlot = { id: '', index: null, name: '', args: '' }; slots.push(curSlot); }
    return curSlot;
  };
  // Process ONE decoded SSE event object (already JSON-parsed). Mutates text/reasoning/finishReason/slots.
  // Returns true when this event terminates the stream (responses' completed/incomplete/failed; chat keeps
  // relying on the `[DONE]` sentinel inside handleEventBlock). v1.7: `isResponses` selects the Responses-API
  // event grammar — the two protocols share nothing structurally, so they get separate handlers.
  const processEvt = (evt, rawStr) => {
    onEvent({ type: 'raw_line', line: rawStr, seq: rawSeqRef.n++ });
    // 21-E0: 捕获 provider 侧响应 id 作辅助关联(请求侧 modelCallId 仍为主键;无 id 端点保持空串)。
    if (!providerResponseId) {
      if (evt && evt.response && typeof evt.response.id === 'string' && evt.response.id) providerResponseId = evt.response.id;
      else if (evt && typeof evt.id === 'string' && evt.id && evt.type !== 'response.created') providerResponseId = evt.id;
    }
    if (isResponses) {
      // ── OpenAI Responses API stream (DeepSeek /v1/responses) ────────────────────────────────────────
      // Events: response.created | response.in_progress | response.output_item.added/done |
      // response.content_part.added/done | response.reasoning_text.delta/done | response.output_text.delta/done |
      // response.function_call_arguments.delta/done | response.completed | response.incomplete | response.failed.
      // No `data: [DONE]` — the stream ends on response.completed/incomplete/failed.
      if (evt && evt.usage) markUsage(evt.usage); // some events carry usage directly
      const t = evt && evt.type;
      if (t === 'response.output_item.added' && evt.item && evt.item.type === 'function_call') {
        // A function_call output item opens/selects its slot (call_id + name), arguments stream separately.
        // 对抗轮(P1-2):以 call_id 为主键选槽 —— 并行 function_call 是常态(官方文档 parallel_tool_calls 忽略
        // = 始终开启),delta 事件自带 item_id,必须按 item_id 路由参数,不能依赖"最后 added 的槽"(交错事件序会错配)。
        const fc = evt.item;
        const id = fc.call_id || makeId('call');
        let s = slots.find(x => x.id === id);
        if (!s) { s = { id, index: null, name: fc.name || '', args: '', itemId: evt.item && evt.item.id || '' }; slots.push(s); }
        else if (fc.name) s.name += fc.name;
        curSlot = s;
        return false;
      }
      // v1.8: a web_search_call output item is a SERVER-SIDE tool invocation (DeepSeek /responses executes
      // the search itself). Surface it as a toolCall named 'web_search' with serverSide:true so the tool
      // loop knows NOT to execute it locally; the raw item is carried back to the next request's `input`
      // (DeepSeek restores the search results server-side). status/output arrive on the .done event.
      if (t === 'response.output_item.added' && evt.item && evt.item.type === 'web_search_call') {
        const ws = evt.item;
        const id = ws.id || makeId('call');
        let s = slots.find(x => x.id === id);
        if (!s) { s = { id, index: null, name: 'web_search', args: '', itemId: id, serverSide: true, item: ws }; slots.push(s); }
        curSlot = s;
        return false;
      }
      if (t === 'response.output_item.done' && evt.item && evt.item.type === 'web_search_call') {
        const ws = evt.item;
        const id = ws.id || '';
        let s = id ? slots.find(x => x.id === id) : curSlot;
        if (s) {
          s.item = ws; // keep the FULL item so it can be echoed back verbatim (server restores the results)
          // v1.8.1: DeepSeek's web_search_call carries the query under `action` (NOT the OpenAI-doc shape
          // `output.query`/`output.search_terms` — the real item has NO `output` field at all):
          //   { type:'web_search_call', id, status, action:{ type:'search', queries:[...] } }
          //   { type:'web_search_call', id, status, action:{ type:'open_page', url } }
          // Parse both so the UI shows the REAL search terms / opened URL instead of an empty placeholder.
          const action = ws.action && typeof ws.action === 'object' ? ws.action : null;
          let q = '';
          if (action) {
            if (Array.isArray(action.queries)) q = action.queries.filter(Boolean).join(' | ');
            else if (typeof action.url === 'string') q = action.url;
          }
          s.args = JSON.stringify({ status: ws.status || '', actionType: (action && action.type) || '', query: q });
        }
        return false;
      }
      if (t === 'response.function_call_arguments.delta' && typeof evt.delta === 'string' && evt.delta) {
        // 对抗轮(P1-2):优先按事件的 item_id 精确定位槽(并行时 arguments delta 按 item_id 路由,绝不串写);
        // item_id 缺失/未命中才回退到"最近 added 的槽"(串行单调用场景,与旧行为一致)。
        let target = null;
        const itemId = evt && evt.item_id;
        if (typeof itemId === 'string' && itemId) target = slots.find(x => x.itemId === itemId);
        if (!target) target = curSlot;
        if (!target) { target = { id: makeId('call'), index: null, name: '', args: '', itemId: '' }; slots.push(target); }
        target.args += evt.delta;
        curSlot = target;
        return false;
      }
      if (t === 'response.reasoning_text.delta' && typeof evt.delta === 'string' && evt.delta) {
        reasoning += evt.delta; onEvent({ type: 'thinking_delta', text: evt.delta }); return false;
      }
      if (t === 'response.output_text.delta' && typeof evt.delta === 'string' && evt.delta) {
        text += evt.delta; onEvent({ type: 'assistant_delta', text: evt.delta }); return false;
      }
      if (t === 'response.completed') {
        // Final event: the full response object (with usage) rides on the event.
        if (evt.response && evt.response.usage) markUsage(evt.response.usage);
        finishReason = 'stop';
        return true;
      }
      if (t === 'response.incomplete') { finishReason = 'length'; return true; } // truncated (e.g. max_output_tokens)
      if (t === 'response.failed') {
        // Terminal failure — surface the error detail to the caller's existing httpError path.
        // 对抗轮(P1-3/P2-1/P2-3):
        //  • 无 error 详情也置错误(否则 finishReason 无人消费 → 静默空转,见 P2-1);
        //  • 文本过 redact() 防恶意服务商在 error 里回显密钥(P2-3);
        //  • 错误含 context/length 语义时置 contextOverflow,让 45b 强压重试能识别(P1-3)。
        const err = evt.response && (evt.response.error || evt.response.last_error);
        const em = (err && (err.message || err.code)) || (err && typeof err === 'object' ? JSON.stringify(err) : String(err || ''));
        responsesFailedError = 'Responses failed' + (em ? ': ' + redact(String(em).slice(0, 400)) : ' (no error detail)');
        if (/context|length|token/i.test(responsesFailedError)) responsesFailedError = 'HTTP 400: ' + responsesFailedError;
        finishReason = 'error';
        return true;
      }
      return false; // created / in_progress / content_part.* / output_item.done / reasoning_text.done / output_text.done / … — non-terminal
    }
    // ── Chat Completions stream (classic path) ─────────────────────────────────────────────────────────
    if (evt.usage) markUsage(evt.usage);
    const ch = evt.choices && evt.choices[0];
    if (!ch) return false;
    if (ch.finish_reason) finishReason = ch.finish_reason;
    const delta = ch.delta;
    if (!delta) return false;
    const reason = (typeof delta.reasoning_content === 'string' && delta.reasoning_content) || (typeof delta.reasoning === 'string' && delta.reasoning) || '';
    if (reason) { reasoning += reason; onEvent({ type: 'thinking_delta', text: reason }); }
    if (typeof delta.content === 'string' && delta.content) { text += delta.content; onEvent({ type: 'assistant_delta', text: delta.content }); }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const slot = selectSlot(tc);
        if (tc.function) { if (tc.function.name) slot.name += tc.function.name; if (typeof tc.function.arguments === 'string') slot.args += tc.function.arguments; }
      }
    }
    return false;
  };
  // E5: standard SSE framing. Events are separated by a BLANK line; within one event, multiple `data:` field
  // lines concatenate (joined by '\n') into a single payload before parsing (per the WHATWG SSE spec). The
  // old parser split on every '\n' and JSON.parsed each `data:` line alone, so an endpoint that spread one
  // JSON object across several `data:` lines (some intranet proxies / self-hosted gateways do) lost the whole
  // frame. To stay backward compatible with the overwhelmingly common one-JSON-per-line shape, when a
  // multi-line event's combined payload does not parse we fall back to parsing each data line on its own.
  const handleEventBlock = block => {
    const dataLines = [];
    for (let rawLine of block.split('\n')) {
      rawLine = rawLine.replace(/\r$/, '');
      if (!rawLine || rawLine.startsWith(':')) continue;   // blank line or comment
      if (!rawLine.startsWith('data:')) continue;          // ignore event:/id:/retry: fields
      dataLines.push(rawLine.slice(5).replace(/^ /, ''));  // strip 'data:' + one optional leading space (SSE)
    }
    if (!dataLines.length) return false;
    const joined = dataLines.join('\n').trim();
    if (joined === '') return false;
    if (joined === '[DONE]') return true;
    const combined = safeJsonParse(joined);
    if (combined) return processEvt(combined, joined); // true = terminal event (responses completed/incomplete/failed)
    // Combined payload did not parse -> treat each data line as its own complete JSON (classic shape).
    for (const dl of dataLines) {
      const d = dl.trim();
      if (!d) continue;
      if (d === '[DONE]') return true;
      const evt = safeJsonParse(d);
      if (evt && processEvt(evt, d)) return true;
    }
    return false;
  };
  while (!done) {
    const r = await reader.read();
    if (r.done) break;
    touch();
    buf += decoder.decode(r.value, { stream: true });
    let m;
    // Consume every COMPLETE event (terminated by a blank line); leave any trailing partial in buf.
    while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (handleEventBlock(block)) { done = true; break; }
    }
  }
  // Flush a trailing event that arrived without a terminating blank line (some servers omit the final one).
  if (!done && buf.trim()) handleEventBlock(buf);
  // v1.8: serverSide toolCalls (web_search_call items) carry the raw item so the tool loop can echo it
  // back into the next request's `input` without executing anything locally.
  const toolCalls = slots.filter(t => t.name).map(t => {
    const base = { id: t.id || makeId('call'), name: t.name, rawArgs: t.args || '{}' };
    if (t.serverSide) { base.serverSide = true; if (t.item) base.item = t.item; }
    return base;
  });
  // v1.7 (Responses): a `response.failed` terminal event is a protocol-level failure with no HTTP error
  // status — surface it through the caller's existing httpError path so attribution/retry behaves uniformly.
  if (responsesFailedError) return { text, reasoning, finishReason, toolCalls, httpError: responsesFailedError, providerResponseId };
  return { text, reasoning, finishReason, toolCalls, providerResponseId };
}

// v0.8-S7: drain the steering queue at a SAFE injection point (§4 A3). Called ONLY at the iteration
// boundary (loop top, before the next API call). A steer is a plain user string queued by /api/steer
// while this turn is live. For each queued item we:
//   • push a `[用户插话] <text>` user message into providerHistory — this is legal ONLY at a boundary
//     where the previous assistant/tool block is COMPLETE AND CONTIGUOUS (an assistant.tool_calls message
//     followed immediately by all its role:'tool' replies, nothing wedged between). The loop top satisfies
//     that: it runs after `continue`, which followed the full tool batch + its tool messages. Draining
//     between tools of one batch would break contiguity (assistant → tool₁ → user → tool₂ = 400 on strict
//     providers) and buys nothing — a steer is only consumed by the NEXT API call anyway;
//   • mirror it into session.messages with steered:true (additive marker) so the UI + a reload show it;
//   • emit a `steered` event (§7.3) so a live UI can render/dedup it;
//   • saveSession so a crash mid-turn doesn't lose the injected instruction.
// Returns the number of items injected (0 when the queue was empty).
async function drainSteerQueue(reg, session, onEvent) {
  if (!reg || !Array.isArray(reg.steerQueue) || reg.steerQueue.length === 0) return 0;
  const items = reg.steerQueue.splice(0, reg.steerQueue.length);
  for (const text of items) {
    const t = String(text || '');
    session.providerHistory.push({ role: 'user', content: '[用户插话] ' + t });
    session.messages.push({ role: 'user', content: t, turnSeq: session.turnSeq, steered: true, createdAt: nowIso() });
    try { onEvent({ type: 'steered', text: t }); } catch { /* stream gone */ }
  }
  await saveSession(session);
  return items.length;
}

// v0.9-S6 (子代理): run a self-contained SUB-TURN for spawn_agent. It is a miniature of runOpenAiTurn's tool
// loop, deliberately WITHOUT: plan mode, auto-compaction, steering, session.messages/providerHistory writes,
// and (禁嵌套) spawn_agent in its own tool set. Key isolation properties:
//   • independent `subHistory` — the sub-turn NEVER reads or writes the parent's session.providerHistory, so
//     the parent's pairing铁律 is untouched (the parent sees exactly one spawn_agent tool_call ↔ one tool_result);
//   • system prompt = a sub-agent identity variant + the SAME capability layers (reuse buildProviderSystemPrompt),
//     with the first user message = the delegated task;
//   • tool set filtered by toolTier (read/edit/exec) AND with spawn_agent suppressed (noSpawnAgent) — a
//     sub-agent can therefore never spawn another sub-agent (double guard: the tool isn't offered here AND
//     the loop below refuses a spawn_agent call if the model somehow emits one);
//   • independent iteration budget maxIters (clamped 1..300); model = model || provider.subagentModel || main model;
//   • file tools run through the SAME journal ctx {sessionId, turnSeq} as the parent (the sub-turn is part of
//     the parent turn), so a sub-agent's file_write is journaled under the parent's turnSeq — naturally;
//   • events: a `subagent` start/end pair is forwarded; the sub-loop's tool_use/tool_result are forwarded too
//     but TAGGED with `subagentId` so the UI nests them (protocol semantics unchanged — additive field).
//     assistant_delta is deliberately NOT forwarded (keeps the parent bubble clean; the conclusion returns as
//     the tool_result to the parent).
// Returns { ok, result, iters, toolCalls } — result is the sub-turn's final assistant text. Errors/over-budget
// return { ok:false, error } but NEVER throw into the parent loop.
// v0.9 F4: `permModeOverride` lets the caller pass a per-turn effective permission mode. When the parent turn
// is in provider plan mode AND the user has approved the plan THIS turn, the parent passes 'default' so the
// sub-agents it spawns can actually do the approved work — instead of being hard-blocked by a stale 'plan'
// mode. It is a TURN-LOCAL override only; global config.permissionMode is never mutated. When absent (or the
// plan is not yet approved, in which case the parent still passes 'plan'), the gate falls back to
// config.permissionMode, so an UN-approved plan-mode turn still hard-blocks its sub-agents' edit/exec tools.
function agentRunDir(sessionId) { return path.join(paths.agentRuns, safeSessionId(sessionId)); }
function agentRunFile(sessionId, runId) { return path.join(agentRunDir(sessionId), `${safeSessionId(runId)}.json`); }
const agentRunWriteChains = new Map();
const activeAgentRuns = new Map(); // runId -> { run, ctrl, paused, stopRequested, resumeWaiters, steerQueues }
// 第46波46e(双冷 resume 窄窗修复):resume「在飞」标记。activeAgentRuns 只在 runtime 构造好才注册,
// 而 existingRun 分支从校验到注册之间有 await(getAgentRoleLibrary/cleanupAgentWorktree)——两个近同时
// 的 resume 会都穿过 activeAgentRuns.has 守卫。此集合在分支【入口同步】占位,成功注册或早退/异常即释,
// 把窄窗从「await 全程」关到「零」。只在 runAgentWorkflow 内使用(09-workflow.js)。
const resumeInFlight = new Set();
// v1 定向插话（steer 到指定运行中子代理节点）: per-node steer queue cap. Reused BOTH by the workflow node
// steer action and by /api/steer's per-turn cap so the two steering surfaces stay symmetric.
const STEER_QUEUE_MAX = 3;
// 团队模式 v2 (A/B): 任务池与 Agent 邮箱的硬上限。全部防御式——任何越限只拒绝该次调用,绝不 crash 调度循环。
const POOL_MAX_TOTAL = 8;      // 每 run 提案总数上限(防提案洪水)
const POOL_CHAIN_MAX = 2;      // proposedBy 链深上限(池生池只允许一层)
const MAIL_QUEUE_MAX = 3;      // 每目标邮箱队列 cap(与 steerQueues 分池,用户插话优先)
const MAIL_TEXT_MAX = 2000;    // 单条消息截断
const MAIL_PER_SENDER_MAX = 8; // 每发送者每 run 消息上限
const MAIL_GLOBAL_MAX = 24;    // 每 run 全局消息上限
// 收尾宽限窗:全节点终态但任务池有待批提案时,manual 策略延迟收尾的时长(env WCW_POOL_GRACE_MS 可缩短供测试)。
const POOL_GRACE_MS = Math.max(500, Number(process.env.WCW_POOL_GRACE_MS) || 60000);
// 团队模式 v2 (P2-2 消息围栏,原则4): 来自其它节点/提案的文本进入提示词前,把行首伪造的 [编排者插话] / [节点 …]
// 前缀中和为全角括号版本,阻断子代理冒充编排者(用户)或冒充别的节点消息。仅改行首匹配,正文其余内容原样保留;
// 任何异常都回退原文(围栏失败绝不阻断投递/执行)。调用点:邮箱注入(runSubAgentCore)与提案物化(materializePoolItem)。
function neutralizeInjectedPrefixes(s) {
  try {
    return String(s == null ? '' : s)
      .replace(/^([ \t]*)\[编排者插话\]/gm, '$1［编排者插话］')
      .replace(/^([ \t]*)\[节点 /gm, '$1［节点 ');
  } catch { return String(s == null ? '' : s); }
}

function gitExec(cwd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.gitStderr = String(stderr || '').trim(); reject(err); }
      else resolve(String(stdout || '').trim());
    });
  });
}
async function createAgentWorktree(cwd, runId, nodeId, attempt) {
  const repoRoot = await gitExec(cwd, ['rev-parse', '--show-toplevel']);
  const dirty = await gitExec(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) throw new Error('原工作区有未提交改动，无法从一致快照创建隔离节点；请先提交或移走这些改动');
  const baseCommit = await gitExec(repoRoot, ['rev-parse', 'HEAD']);
  const folder = `${safeSessionId(runId)}-${safeSessionId(nodeId)}-a${Math.max(1, Number(attempt) || 1)}`;
  const worktreePath = path.resolve(paths.agentWorktrees, folder);
  if (!pathWithinRoot(worktreePath, path.resolve(paths.agentWorktrees))) throw new Error('invalid agent worktree path');
  await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
  await gitExec(repoRoot, ['worktree', 'add', '--detach', worktreePath, baseCommit], 60000);
  return { mode: 'worktree', status: 'running', path: worktreePath, repoRoot: path.resolve(repoRoot), baseCommit, createdAt: nowIso() };
}
async function finalizeAgentWorktree(isolation, runId, nodeId) {
  if (!isolation || isolation.mode !== 'worktree') return isolation;
  const changes = await gitExec(isolation.path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!changes) {
    isolation.status = 'clean'; isolation.completedAt = nowIso();
    try { await gitExec(isolation.repoRoot, ['worktree', 'remove', '--force', isolation.path], 60000); } catch {}
    isolation.path = ''; return isolation;
  }
  await gitExec(isolation.path, ['add', '-A']);
  await gitExec(isolation.path, ['-c', 'user.name=Ruyi Agent', '-c', 'user.email=agent@ruyi.local', 'commit', '-m', `agent(${nodeId}): isolated result for ${runId}`], 60000);
  isolation.commit = await gitExec(isolation.path, ['rev-parse', 'HEAD']);
  isolation.status = 'ready'; isolation.completedAt = nowIso(); isolation.changeSummary = changes.split(/\r?\n/).slice(0, 100);
  return isolation;
}
async function applyAgentWorktree(run, nodeId) {
  const node = (run.nodes || []).find(n => n.id === nodeId);
  if (!node || !node.isolation || node.isolation.mode !== 'worktree' || !node.isolation.commit) return { ok: false, error: '该节点没有可应用的隔离提交' };
  if (node.isolation.status === 'applied') return { ok: true, alreadyApplied: true, commit: node.isolation.commit };
  const iso = node.isolation;
  const repoRoot = path.resolve(iso.repoRoot || '');
  const currentRoot = await gitExec(normalizeCwd(repoRoot), ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!currentRoot || path.resolve(currentRoot) !== repoRoot) return { ok: false, error: '原工作区已不可用' };
  const dirty = await gitExec(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) return { ok: false, error: '当前工作区有未提交改动；为避免覆盖，请先提交或移走这些改动' };
  try {
    await gitExec(repoRoot, ['cherry-pick', iso.commit], 120000);
  } catch (e) {
    try { await gitExec(repoRoot, ['cherry-pick', '--abort'], 30000); } catch {}
    return { ok: false, error: `隔离提交无法安全应用：${e.gitStderr || e.message || e}` };
  }
  iso.status = 'applied'; iso.appliedAt = nowIso();
  if (iso.path && pathWithinRoot(path.resolve(iso.path), path.resolve(paths.agentWorktrees))) {
    try { await gitExec(repoRoot, ['worktree', 'remove', '--force', iso.path], 60000); iso.path = ''; } catch {}
  }
  await saveAgentRun(run);
  return { ok: true, commit: iso.commit };
}
async function cleanupAgentWorktree(isolation) {
  if (!isolation || !isolation.path) return;
  const worktreePath = path.resolve(isolation.path);
  if (!pathWithinRoot(worktreePath, path.resolve(paths.agentWorktrees))) return;
  try { await gitExec(path.resolve(isolation.repoRoot), ['worktree', 'remove', '--force', worktreePath], 60000); }
  catch {
    try { await fsp.rm(worktreePath, { recursive: true, force: true }); } catch {}
    try { await gitExec(path.resolve(isolation.repoRoot), ['worktree', 'prune'], 30000); } catch {}
  }
  isolation.path = '';
}

function projectAgentRoleFile(cwd) { return path.join(path.resolve(cwd), '.ruyi', 'agents.json'); }
async function readProjectAgentRoles(cwd) {
  const file = projectAgentRoleFile(cwd);
  try {
    const st = await fsp.stat(file); if (!st.isFile() || st.size > 512 * 1024) return [];
    const parsed = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
    const rawRoles = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.roles) ? parsed.roles : []);
    return rawRoles.map(r => normalizeAgentRole(r, { source: 'project' })).filter(Boolean).slice(0, 32);
  } catch { return []; }
}
function parseSimpleYamlValue(value) {
  const s = String(value || '').trim();
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^\d+$/.test(s)) return Number(s);
  return s.replace(/^['"]|['"]$/g, '');
}
async function readClaudeProjectAgentRoles(cwd) {
  const dir = path.join(path.resolve(cwd), '.claude', 'agents');
  let files = []; try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const file of files.filter(f => /\.md$/i.test(f)).slice(0, 32)) {
    try {
      const raw = await fsp.readFile(path.join(dir, file), 'utf8'); if (raw.length > 128 * 1024) continue;
      const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/m.exec(raw); if (!m) continue;
      const fm = {};
      for (const line of m[1].split(/\r?\n/)) { const hit = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line); if (hit) fm[hit[1]] = parseSimpleYamlValue(hit[2]); }
      const role = normalizeAgentRole({
        id: fm.name || path.basename(file, '.md'), label: fm.name || path.basename(file, '.md'), description: fm.description || '', prompt: m[2].trim(),
        claudeModel: fm.model || 'inherit', claudeTools: Array.isArray(fm.tools) ? fm.tools : (typeof fm.tools === 'string' ? fm.tools.split(',').map(s => s.trim()) : []),
        permissionMode: fm.permissionMode === 'bypassPermissions' ? 'bypass' : fm.permissionMode, maxTurns: fm.maxTurns, mcpServers: Array.isArray(fm.mcpServers) ? fm.mcpServers : [], isolation: fm.isolation,
      }, { source: 'claude-project' });
      if (role) { role.nativeClaude = true; role.file = path.join(dir, file); out.push(role); }
    } catch { /* malformed native agent stays Claude's concern */ }
  }
  return out;
}
async function getAgentRoleLibrary(cwd, config) {
  const merged = new Map();
  for (const raw of BUILTIN_AGENT_ROLES) { const role = normalizeAgentRole(raw, { source: 'builtin', builtin: true }); merged.set(role.id, role); }
  for (const role of (Array.isArray(config.agentRoleOverrides) ? config.agentRoleOverrides : [])) {
    const current = merged.get(role.id); merged.set(role.id, current ? mergeAgentRole(current, role, 'global') : normalizeAgentRole(role, { source: 'global' }));
  }
  for (const role of await readProjectAgentRoles(cwd)) {
    const current = merged.get(role.id); merged.set(role.id, current ? mergeAgentRole(current, role, 'project') : role);
  }
  const claudeNative = await readClaudeProjectAgentRoles(cwd);
  for (const role of claudeNative) if (!merged.has(role.id)) merged.set(role.id, role);
  return [...merged.values()].filter(Boolean);
}
async function saveProjectAgentRoles(cwd, roles) {
  const file = projectAgentRoleFile(cwd), dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const payload = { schemaVersion: 1, roles: roles.map(r => normalizeAgentRole(r, { source: 'project' })).filter(Boolean).slice(0, 32) };
  await atomicWriteJson(file, payload);   // 25.1 收编
  return payload.roles;
}
function claudePermissionMode(mode) {
  // v1.4.3: use the unified CLAUDE_PERMISSION_MODE_MAP; 'inherit' maps to undefined (omit from agent JSON)
  if (mode === 'inherit') return undefined;
  return CLAUDE_PERMISSION_MODE_MAP[mode] || mode;
}
async function buildClaudeAgentDefinitions(cwd, config, jsonBudget = 6000) {
  const roles = (await getAgentRoleLibrary(cwd, config)).filter(r => !r.nativeClaude);
  const definitions = {};
  for (const role of roles) {
    const d = { description: role.description || role.label, prompt: role.prompt || role.description || role.label };
    if (role.claudeTools && role.claudeTools.length) d.tools = role.claudeTools;
    if (role.models && role.models.claude && role.models.claude !== 'inherit') d.model = role.models.claude;
    const pm = claudePermissionMode(role.permissionMode); if (pm) d.permissionMode = pm;
    if (role.mcpServers && role.mcpServers.length) d.mcpServers = role.mcpServers;
    if (role.budgets && role.budgets.claude) d.maxTurns = role.budgets.claude;
    if (role.isolation === 'worktree') d.isolation = 'worktree';
    if (role.color) d.color = role.color;
    definitions[role.id] = d;
  }
  // Windows .cmd launchers go through cmd.exe, whose command-line limit is small. Keep definitions
  // deterministic and bounded; project-native .claude/agents remain available independently.
  // cmd8191 防线: jsonBudget 由调用方按整行剩余预算动态给出(默认 6000 维持原契约);预算收紧时按角色
  // 库顺序确定性取舍,放不下的进 omitted(meta 事件上报,用户可见)。
  const budget = Math.max(0, Math.min(6000, Math.floor(Number(jsonBudget) || 0)));
  const selected = {}, omitted = [];
  for (const [id, def] of Object.entries(definitions)) {
    const candidate = { ...selected, [id]: def };
    if (JSON.stringify(candidate).length <= budget) selected[id] = def; else omitted.push(id);
  }
  return { definitions: selected, omitted, roles };
}

// Tool-tier → Claude native tool allowlist for a DAG node with no explicit role (or a role that leaves
// claudeTools empty), mirroring the OpenAI subagent's tierFilter hard cap (buildOpenAiTools): 'read' can
// never mutate, 'edit' adds file writes, 'exec' is intentionally unrestricted — the same shape as the
// built-in 'worker'/'verifier' roles, which leave claudeTools empty for their exec tier.
// 第22波(开放子代理工具面): read/edit 补 WebSearch/WebFetch——联网只读不落盘,与 OpenAI 侧 NATIVE_TOOL_TIER 把
// web_search/web_fetch 定为 read 级的既有裁定对齐(此前 Claude 引擎的研究/审查类 read 节点连检索都不行,两引擎
// 能力面不对称)。落盘/执行面(Write/Edit/Bash/MCP)分级不变。
const CLAUDE_SUBAGENT_TIER_TOOLS = { read: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], edit: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Write', 'Edit'], exec: [] };
// Permission modes that resolve without a human/bridge to answer a prompt: 'bypass' skips all asking,
// 'auto' is the CLI's own built-in risk classifier (v1.4.3, documented above at runClaudeTurn's
// usePermissionBridge computation), 'dontAsk' skips by name, and 'plan' never executes a mutating tool in
// the first place. Anything else ('default', 'acceptEdits') can still block on Bash/exec-tier calls with
// no one to answer — a one-shot unattended DAG node would hang forever, so those get coerced below.
const CLAUDE_SUBAGENT_SAFE_MODES = new Set(['bypass', 'auto', 'dontAsk', 'plan']);

// One-shot, session-free Claude CLI turn for a single DAG node: spawns `claude -p` with the node/role's
// own model + tool restriction, feeds stdout through the same parseClaudeEvent normalizer runClaudeTurn
// uses, and resolves once the CLI's own internal tool loop finishes. Unlike runClaudeTurn this owns no
// session state (no activeChildren/claudeSessionId/resume) — a DAG node is a bounded, addressable call, so
// runAgentWorkflow can gate/retry/loop on its return value exactly like it already does for the OpenAI
// HTTP path (runSubAgentCore), giving the DAG a real second (Claude-native) execution engine instead of
// always requiring an OpenAI-compatible Provider.
// v1.4.5: classify a Claude-engine sub-agent failure so runClaudeSubAgentOnce's bounded retry loop can
// decide whether to try again. The Claude CLI is a black box that does its OWN internal retry for
// 429/overload/network, but it still SURFACES a failure to us when its retry budget is exhausted or the
// process itself blips (startup/connect crash, OOM kill). Previously that single non-zero exit killed the
// node - and with the default failurePolicy 'block', the whole workflow (the "分发出去的子agent经常性失败"
// symptom). This classifier mirrors the OpenAI sub-agent path's transient set (transportError / 429 /
// 502/503/504 via failoverStatus, expressed here as CLI stderr text) plus the CLI-specific "died before
// producing anything" startup-crash case. Definitive errors (auth / model-not-found / context overflow /
// a clean error result the CLI emitted on exit 0) are NOT retried - retrying them only burns time.
function classifyClaudeSubagentFailure({ killed, exitCode, stderrText, assistantText, toolCallCount, gotResult, resultOk, resultText }) {
  if (killed) return { retry: false, reason: 'aborted' };
  // 防重放: the CLI already emitted assistant text or executed tools before failing. Re-running would
  // replay those side effects (file writes etc.), so never retry - matches runSubAgentCore's "mid-stream
  // errors are NOT retried" rule.
  if ((assistantText && String(assistantText).trim()) || toolCallCount > 0) return { retry: false, reason: 'progress_made' };
  // 第45波 45c:context overflow 从 definitive 拆出 —— 允许一次【缩载新鲜重试】。检查顺序保证安全:
  // progress_made 已先判(有 tool 调用/文本即不可重试),走到这里 = 零进展 → 无重放面。
  // 45f 对抗轮 P1-2:判定必须【先于】clean_error_result(CLI 执行期 API 错误常以 result 帧
  // subtype:error_during_execution 收尾,落不到 stderr),且扫描 stderr+result 合并文本;
  // 正则用 CONTEXT_OVERFLOW_PATTERNS(含真实 Anthropic 形态 "prompt is too long: N tokens > M maximum",
  // 作者假想形态 prompt_too_long 曾让整条分支成为死代码)。
  const combined = String(stderrText || '') + '\n' + String(resultText || '');
  if (CONTEXT_OVERFLOW_PATTERNS.test(combined) || /prompt_too_long/i.test(combined)) {
    return { retry: true, reason: 'over_window' };
  }
  // The CLI ran to a clean `result` event but reported is_error / subtype:error (e.g. an in-CLI tool
  // execution error). That is deterministic, not transient - retrying won't change it.
  if (gotResult && resultOk === false) return { retry: false, reason: 'clean_error_result' };
  const s = String(stderrText || '');
  // Definitive non-transient signatures (auth / model / bad request / cmd.exe 命令行超长——
  // 参数决定的确定性失败,重试同样的 args 只会原样再败;cmd8191 防线的预算哨兵应已拦截,此为兜底)。
  if (/invalid_api_key|authentication_error|auth.*fail|unauthor|\b401\b|permission_denied|\b403\b|model_not_found|not_found_error|\b404\b|invalid_request_error|命令行太长|command line is too long/i.test(s)) {
    return { retry: false, reason: 'definitive' };
  }
  // Transient signatures: rate limit / overload / 5xx / network / connect / TLS - the same set the OpenAI
  // path retries (transportError + 429 + 502/503/504), expressed as CLI stderr text.
  if (/rate_limit|rate.?limit|\b429\b|too many requests|overloaded|overloaded_error|\b5\d{2}\b|api_error|internal server|bad gateway|service unavailable|gateway timeout|fetch failed|failed to fetch|etimedout|econnreset|econnrefused|enotfound|eaddr|socket hang up|network error|connection (?:error|reset|refused|timeout)|und_err_|certificate|self-signed|tls error|getaddrinfo|timed out/i.test(s)) {
    return { retry: true, reason: 'transient' };
  }
  // Non-zero exit with no result event and no assistant text: the CLI died before doing any work (a
  // startup/connect blip its own retry budget couldn't ride out, or a process crash). Cautiously retry -
  // cheap, and a fresh process often succeeds; bounded by MAX_ATTEMPTS so a hard outage still fails fast.
  if (exitCode !== 0 && !gotResult) return { retry: true, reason: 'no_output_crash' };
  return { retry: false, reason: 'unknown' };
}
// v1.4.6 (C): a read/analysis Claude node emits almost no tool_use events, so its whole execution window
// looked frozen to the polling UI. Every N chars of streamed assistant text we fire a lightweight
// subagent_progress milestone (recordAgentNodeProgress folds it into node.progressLog as "生成中 · N 字").
const CLAUDE_PROGRESS_CHAR_STEP = 400;
async function runClaudeSubAgentOnce({ config, parentSession, task, displayTask, agentKey, dependsOn, toolTier, maxIters, model, onEvent, subagentId, ctrl, permModeOverride, roleDefinition, cwd, getSteer, steerReminder }) {
  const started = Date.now();
  const claude = config.claudePath || detectClaudePath();
  const fakeClaude = process.env.WCW_FAKE_CLAUDE || ''; // off-by-default test seam — see runClaudeTurn
  if (!fakeClaude && (!claude || !existsExecutable(claude))) {
    return { ok: false, error: 'Claude CLI 未找到，无法以 Claude 引擎运行该节点', iters: 0, toolCalls: 0 };
  }
  const role = roleDefinition || null;
  const tier = (toolTier === 'edit' || toolTier === 'exec') ? toolTier : 'read';
  const subModel = String(model || (role && role.models && role.models.claude !== 'inherit' && role.models.claude) || '').trim();

  const roleMode = role && role.permissionMode && role.permissionMode !== 'inherit' ? role.permissionMode : '';
  const requestedMode = roleMode || permModeOverride || config.permissionMode || 'bypass';
  const effMode = CLAUDE_SUBAGENT_SAFE_MODES.has(requestedMode) ? requestedMode : (tier === 'read' ? 'plan' : 'bypass');

  // Keep the print-mode process input channel open. Claude's documented stream-json input accepts additional
  // user envelopes while a turn is running, which lets the workflow orchestrator steer a long Claude node
  // directly instead of storing a note that only downstream nodes could see after it was already too late.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  const pm = claudePermissionMode(effMode); if (pm) args.push('--permission-mode', pm);
  if (subModel && subModel !== 'inherit') args.push('--model', subModel);
  if (config.claudeThinkingEffort) args.push('--effort', config.claudeThinkingEffort);
  const allowedTools = (role && role.claudeTools && role.claudeTools.length) ? role.claudeTools : CLAUDE_SUBAGENT_TIER_TOOLS[tier];
  if (allowedTools && allowedTools.length) args.push('--allowed-tools', allowedTools.join(','));
  const turnBudget = Number(maxIters) || (role && role.budgets && role.budgets.claude) || 0;
  if (turnBudget > 0) args.push('--max-turns', String(Math.min(300, Math.round(turnBudget))));
  // DAG subagents do not inherit the main turn's append prompt, so give them the same final language rule.
  args.push('--append-system-prompt', appendResponseLanguagePolicy('', config, 0, task));
  if (cwd) args.push('--add-dir', cwd);
  // 第28波(§28a):Claude 引擎【不适用】服务端子代理压缩(maybeCompactSubHistory)—— claude CLI 自管上下文窗口与压缩,
  // 服务端一次性 spawn 后只累积 assistantText/resultText 求聚合结果,不持有可压缩的 history 数组。与上文桥接分级不对称同源
  // (两引擎有意不对称)。故此函数【不】引入 subHistory/maybeCompactSubHistory —— 有意为之,非遗漏(e2e 源锁断言之)。
  // Bridged (external/desktop MCP) servers attach ONLY at 'exec' tier on the Claude path — 有意与 OpenAI 路径
  // 的分级开放**不对称**(第22波安全裁定): CLI 的 --allowed-tools 在 bypass 许可模式下不是硬限制(bypass 跳过一切
  // 许可),挂上 mcp-config 即意味着子进程可调用该服务器的任意工具(含桌面全控),无法像 runSubAgentCore 那样按
  // bridgedToolTier 逐工具硬过滤。在 CLI 提供逐工具硬白名单语义前,read/edit 维持不挂桥接面。An explicit
  // role.mcpServers narrows an exec-tier node to just those servers; empty/absent means everything the
  // workbench has configured (generateAgentNodeMcpConfig mirrors generateSessionMcpConfig, keyed by subagentId).
  const roleMcpServers = (role && role.mcpServers) || [];
  const mcpConfigPath = tier === 'exec' ? await generateAgentNodeMcpConfig(subagentId, config.mcpCommandMode, roleMcpServers) : '';
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);

  // cmd8191 防线(子代理): 子代理 args 小(无技能索引),但自定义 role.claudeTools/超长路径仍可能顶爆 cmd 上限。
  // 降级阶梯: ① 丢 --append-system-prompt(仅语言政策,可恢复性最低) ② 非 plan 模式丢 --allowed-tools
  // (bypass/auto 下它不是硬安全边界——bypass 跳过一切许可,见上方分级注释;plan 模式下它有意义,不丢)
  // ③ 仍超 → 明确报错(分类器把「命令行太长。」列为 definitive,不会无谓重试 3 次)。
  {
    const guardCmd = fakeClaude ? process.execPath : claude;
    const guardBudget = cmdLineBudgetFor(guardCmd);
    if (guardBudget > 0 && spawnCmdLineLength(guardCmd, args) > guardBudget) {
      const pi = args.indexOf('--append-system-prompt');
      if (pi >= 0) args.splice(pi, 2);
      if (spawnCmdLineLength(guardCmd, args) > guardBudget && effMode !== 'plan') {
        const ti = args.indexOf('--allowed-tools');
        if (ti >= 0) args.splice(ti, 2);
      }
      if (spawnCmdLineLength(guardCmd, args) > guardBudget) {
        return { ok: false, error: `Claude CLI 命令行超预算(${guardBudget} 字符):角色工具清单/路径过长,请精简该角色的 claudeTools 或缩短工作目录路径`, iters: 0, toolCalls: 0 };
      }
    }
  }

  const spawn = fakeClaude ? { command: process.execPath, args: [fakeClaude, ...args], opts: {} } : batchSafeSpawn(claude, args);
  const env = effectiveAnthropicEnv(config);
  if (fakeClaude) env.WCW_FAKE_INTERACTIVE = '1';

  onEvent({ type: 'subagent', id: subagentId, state: 'start', task: String(displayTask != null ? displayTask : task || ''), toolTier: tier, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', permissionMode: role && role.permissionMode || 'inherit', mcpServers: roleMcpServers, engine: 'claude' });

  const workingDir = cwd || process.cwd();
  await fsp.mkdir(workingDir, { recursive: true }).catch(() => {});
  const idleLimitMs = Math.min(Number(config.turnIdleTimeoutMs) || 600000, 600000);

  // v1.4.5: transient-error resilience parity with runSubAgentCore (OpenAI path) + streamWithFailover
  // (parent turn). The CLI is retried inline a bounded number of times when a failure is classified
  // transient by classifyClaudeSubagentFailure AND made no progress (防重放). One shared abort handler
  // kills whichever child is current; the watchdog is per-attempt.
  let killed = false;
  let currentChild = null;
  const onAbort = () => { killed = true; if (currentChild) { try { currentChild.stdin.end(); } catch { /* ignore */ } killChildTree(currentChild.pid); } };
  if (ctrl && ctrl.signal) { if (ctrl.signal.aborted) killed = true; else ctrl.signal.addEventListener('abort', onAbort, { once: true }); }

  // 45c:over_window 重试时的可变任务(缩载);初值 = 原任务。
  let taskForAttempt = task, overWindowShrunk = false;
  // One CLI spawn attempt -> collected exit/output state. Does NOT decide retry; the loop below does.
  const runOnce = () => new Promise(resolve => {
    const child = cp.spawn(spawn.command, spawn.args, { cwd: workingDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...spawn.opts });
    currentChild = child;
    let lastEventAt = Date.now();
    // Idle watchdog - a wedged CLI must not hang the whole DAG run forever (per-attempt).
    const watchdog = setInterval(() => { if (!killed && Date.now() - lastEventAt > idleLimitMs) onAbort(); }, 5000);
    child.stdin.on('error', () => {}); // ignore EPIPE if the child exits first
    let stdinClosed = false;
    const closeStdin = () => {
      if (stdinClosed) return;
      stdinClosed = true;
      try { child.stdin.end(); } catch { /* already closed */ }
    };
    const drainSteers = () => {
      if (stdinClosed || killed || typeof getSteer !== 'function') return 0;
      let steers = [];
      try { steers = getSteer() || []; } catch { steers = []; }
      let delivered = 0;
      for (const raw of steers) {
        const text = String(raw || '').trim();
        if (!text) continue;
        try {
          child.stdin.write(JSON.stringify(buildUserEnvelope('[编排者插话] ' + text + (steerReminder || ''))) + '\n', 'utf8');
          delivered += 1;
          lastEventAt = Date.now();
          onEvent({ type: 'subagent_steered', subagentId, text });
        } catch { /* the process may have completed between the queue drain and write */ }
      }
      return delivered;
    };
    try { child.stdin.write(JSON.stringify(buildUserEnvelope(String(taskForAttempt || ''))) + '\n', 'utf8'); } catch { /* ignore */ }
    // Polling is intentionally local to this child attempt. It supports both a user steering a live node and
    // the scheduler's automatic wrap-up instruction; queued messages are consumed in order and acknowledged
    // through the same subagent_steered event as Provider nodes.
    const steerTimer = setInterval(drainSteers, 250);
    if (steerTimer && steerTimer.unref) steerTimer.unref();
    let stderrText = '';
    child.stderr.on('data', chunk => { stderrText += decodeClaudeCliText(chunk); lastEventAt = Date.now(); });

    let assistantText = '';
    let progressChars = 0; // v1.4.6 (C): high-water mark of chars already reported via subagent_progress (resets per attempt)
    let toolCallCount = 0;
    let resultOk = true, resultText = '', gotResult = false;
    let stdoutRemainder = '';
    // v1.4-OSS 用量看板(补): per-attempt token accounting. The result frame's usage is the turn's CUMULATIVE
    // total — preferred when a field is populated. Absent it (an attempt that died before the result frame),
    // fall back to this attempt's msg_usage. The real CLI splits one multi-content-block assistant message into
    // several msg_usage events REPEATING the same usage, so summing虚计 2-3x; we take Math.max instead (帧内
    // 重复被 max 天然去重). Across API calls this max is a deliberate CONSERVATIVE lower bound (取最大一次调用) —
    // mirrors the main turn's maxCtxInput semantics.
    let resultUsage = null, resultCostUsd = NaN;
    let msgBillInMax = 0, msgBillOutMax = 0;
    // No --include-partial-messages here (a DAG node's aggregated result is all runAgentWorkflow consumes),
    // so parseClaudeEvent only ever emits whole (non-partial) text - no delta/whole dedup needed.
    const consumeLine = line => {
      if (!line.trim()) return;
      lastEventAt = Date.now();
      const evt = safeJsonParse(line);
      if (!evt) return;
      for (const ev of parseClaudeEvent(evt)) {
        if (ev.kind === 'text') {
          assistantText += ev.text;
          // v1.4.6 (C): emit a progress milestone each time streamed text crosses another
          // CLAUDE_PROGRESS_CHAR_STEP boundary so a long, tool-less generation shows live activity.
          if (assistantText.length - progressChars >= CLAUDE_PROGRESS_CHAR_STEP) {
            progressChars = assistantText.length;
            onEvent({ type: 'subagent_progress', subagentId, chars: assistantText.length, note: `生成中 · ${assistantText.length} 字` });
          }
        }
        else if (ev.kind === 'tool_use') { toolCallCount += 1; onEvent({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input, subagentId }); }
        else if (ev.kind === 'tool_result') onEvent({ type: 'tool_result', id: ev.id, content: ev.content, isError: ev.isError, subagentId });
        else if (ev.kind === 'result') {
          gotResult = true; resultOk = ev.ok !== false; if (ev.result) resultText = ev.result;
          if (ev.usage && typeof ev.usage === 'object') resultUsage = ev.usage;
          const c = Number(ev.costUsd); if (Number.isFinite(c)) resultCostUsd = c;
          // Drain a steer that raced the result frame before signalling EOF. Any already-written envelope
          // remains ahead of EOF and Claude processes it as the final turn; with no steer this closes normally.
          drainSteers();
          closeStdin();
        }
        else if (ev.kind === 'msg_usage' && ev.usage && typeof ev.usage === 'object') { msgBillInMax = Math.max(msgBillInMax, Number(ev.usage.input_tokens) || 0); const mo = Number(ev.usage.output_tokens) || 0; msgBillOutMax = Math.max(msgBillOutMax, mo > 0 ? mo : 0); }
      }
    };
    child.stdout.on('data', chunk => {
      stdoutRemainder += chunk.toString('utf8');
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    });
    let settled = false;
    const finish = exitCode => { if (settled) return; settled = true; clearInterval(watchdog); clearInterval(steerTimer); closeStdin(); if (stdoutRemainder.trim()) consumeLine(stdoutRemainder); currentChild = null; resolve({ exitCode, stderrText, assistantText, toolCallCount, resultOk, resultText, gotResult, resultUsage, resultCostUsd, msgBillInMax, msgBillOutMax }); };
    child.on('error', () => finish(-1));
    child.on('close', code => finish(code == null ? -1 : code));
  });

  const MAX_ATTEMPTS = 3;
  let lastFinalText = '', lastErr = '', lastToolCalls = 0;
  // v1.4-OSS 用量看板(补): accumulate token/cost across ALL attempts (a failed attempt still burned real tokens).
  // Written ONCE at every exit path via the finally below. Accounting is fully defensive — it can never change
  // the sub-agent's return value or throw (appendUsageLedger is itself fire-and-forget and skips zero-token rows).
  // ledgerCostUsd starts NaN, not 0: "no CLI cost frame ever seen" must reach claudeCostFields as non-finite
  // so it yields cost:null (unknown), never a false trusted-$0 row (mirrors the main turn's Number(undefined)).
  // ledgerEstimated flips true whenever an attempt fell back to the msg_usage max (保守下限, not the exact
  // cumulative result usage) so the row is honestly badged 估算.
  let ledgerIn = 0, ledgerOut = 0, ledgerCostUsd = NaN, ledgerEstimated = false;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (killed) break;
      const res = await runOnce();
      try {
        // FIELD-LEVEL source select (保守语义): trust the result frame's usage only when a field is actually
        // populated (>0). A result frame carrying an empty usage:{} must NOT record a bogus 0 — fall back to
        // this attempt's msg_usage max (帧内已去重) and flag the row estimated. Zero on both sides = nothing
        // billable this attempt.
        const ru = res.resultUsage;
        const ruIn = ru ? (Number(ru.input_tokens) || 0) : 0, ruOut = ru ? (Number(ru.output_tokens) || 0) : 0;
        if (ruIn > 0 || ruOut > 0) { ledgerIn += ruIn; ledgerOut += ruOut; }
        else if ((Number(res.msgBillInMax) || 0) > 0 || (Number(res.msgBillOutMax) || 0) > 0) {
          ledgerIn += Number(res.msgBillInMax) || 0; ledgerOut += Number(res.msgBillOutMax) || 0; ledgerEstimated = true;
        }
        if (Number.isFinite(res.resultCostUsd)) ledgerCostUsd = (Number.isFinite(ledgerCostUsd) ? ledgerCostUsd : 0) + res.resultCostUsd;
      } catch { /* never let accounting break the attempt */ }
      const finalText = (res.resultText || res.assistantText).trim();
      const ok = !killed && res.exitCode === 0 && res.resultOk && !!finalText;
      if (ok) {
        onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, resultChars: finalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
        return { ok: true, result: finalText, iters: 1, toolCalls: res.toolCallCount };
      }
      lastFinalText = finalText; lastToolCalls = res.toolCallCount;
      lastErr = killed ? '节点已中止或空闲超时' : (String(res.stderrText || '').trim().slice(0, 2000) || finalText || `claude 退出码 ${res.exitCode}`);
      const cls = classifyClaudeSubagentFailure({ killed, exitCode: res.exitCode, stderrText: res.stderrText, assistantText: res.assistantText, toolCallCount: res.toolCallCount, gotResult: res.gotResult, resultOk: res.resultOk, resultText: res.resultText });
      if (killed || !cls.retry || attempt >= MAX_ATTEMPTS) break;
      // 45c:over_window → 缩载后新鲜重试(一次性 spawn 无 resume,超窗 = 任务载荷本身过大;cap 60K 字符)。
      // 45f P3-7:任务本就不超 60K 时缩无可缩(超窗根因是系统提示/schema),重试必败 —— 不再白烧一次 spawn。
      if (cls.reason === 'over_window') {
        const raw = String(task || '');
        if (overWindowShrunk || raw.length <= 60000) break;
        overWindowShrunk = true;
        taskForAttempt = raw.slice(0, 60000) + `\n\n…(原任务 ${raw.length} 字符,上次因上下文超限失败已截断;请聚焦完成可达部分)`;
      }
      onEvent({ type: 'subagent', id: subagentId, state: 'retry', attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, reason: cls.reason, error: String(res.stderrText || '').trim().slice(0, 500) || `claude 退出码 ${res.exitCode}` });
      // Bounded backoff an abort can cut short (mirrors runSubAgentCore's transient-retry sleep).
      await new Promise(r => {
        const t = setTimeout(r, Math.min(2000, 300 * attempt));
        if (ctrl && ctrl.signal) ctrl.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
    }
    if (!killed && lastFinalText.trim().length >= 80 && lastToolCalls > 0) {
      onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, degraded: true, resultChars: lastFinalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
      return { ok: true, degraded: true, warning: lastErr || 'Claude CLI exited after producing usable output', result: lastFinalText, iters: 1, toolCalls: lastToolCalls };
    }
    onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: false, resultChars: lastFinalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
    return { ok: false, error: lastErr || '子代理未产出结论', result: lastFinalText, iters: 1, toolCalls: lastToolCalls };
  } finally {
    // v1.4-OSS 用量看板(补): ONE ledger row for the whole node (accumulated across attempts). Billing fields via
    // claudeCostFields (与主回合同源). No parentSession → nothing to anchor a row to; skip. Zero-token rows are
    // dropped inside appendUsageLedger, so the 'CLI 未找到' early-return above (never reaches here anyway) needs
    // no special case, and a purely-aborted node with no usage records nothing.
    try {
      if (parentSession) {
        const { provider: claudeProvider, cost, currency, costTrusted } = claudeCostFields(config, ledgerIn, ledgerOut, ledgerCostUsd);
        appendUsageLedger({
          sessionId: parentSession.id, engine: 'claude', provider: claudeProvider,
          // A workflow node can pass model:'inherit' straight through (subModel === 'inherit'); the model that
          // actually ran is then config.model — record that, never the literal 'inherit'.
          model: (subModel && subModel !== 'inherit') ? subModel : (config.model || ''), inTok: ledgerIn, outTok: ledgerOut,
          cost, currency, costTrusted, estimated: ledgerEstimated, turnSeq: parentSession.turnSeq,
          kind: 'subagent', agentKey, subagentId,
        });
        // 29c: 用量随事件上抛 —— DAG 节点的 nodeEvent 借此把 token/成本累进 run.usageTotals(前端画布迷你条
        // 与运行卡 chip 早已防御性读这些字段,"后端并行落地中"说的就是这里)。与 ledger 同源同值。
        onEvent({ type: 'subagent_usage', id: subagentId, agentKey, inTok: ledgerIn, outTok: ledgerOut, cost, currency, estimated: ledgerEstimated });
      }
    } catch { /* accounting must never break the sub-agent */ }
  }
}

// Responses strict pairing adapter. A bounded history projection (summary fitting, retry/reseed, or an
// interrupted subturn) can end after an assistant function_call but before its function_call_output.
// DeepSeek Responses rejects that otherwise useful prefix with HTTP 400 "No tool output found". Reuse the
// persisted-history repair primitive on a SHALLOW ARRAY COPY: missing outputs become explicit synthetic
// results before the next message/end, while the caller's auditable history stays byte-for-byte untouched.
// Function declarations are hoisted; keeping this adapter at the module tail minimizes generated line-map churn.
function responsesHistoryWithCompleteToolPairs(history) {
  const paired = Array.isArray(history) ? history.slice() : [];
  return { history: paired, repaired: repairProviderHistoryPairing(paired) };
}
