// Best-effort model list from a provider's GET …/models. Never throws. 端点与请求头按协议问 04i 的登记表(与补全请求同一份)。
async function fetchOpenAiModels(provider, timeoutMs = 4000) {
  const wire = providerWireProtocol(provider);
  const modelsUrl = wire.modelsUrl(provider && provider.baseUrl);
  if (!modelsUrl || typeof fetch !== 'function') return { ok: false, error: modelsUrl ? 'fetch unavailable' : 'no base URL', models: [] };
  const headers = wire.requestHeaders(provider);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
  try {
    const res = await fetch(modelsUrl, { headers, signal: ctrl ? ctrl.signal : undefined });
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
//   opts.noAgentTools : true → never include the agent tools orchestrate_agents / wait_agents / agent_result
//     (禁嵌套: sub-turns pass this). The top-level turn omits it and lets the subagentMaxPerTurn>0 check decide.
// 代理模式 v2:模型侧的三个代理工具(单一启动入口 + 收件 + 取全文)。offer 门、禁嵌套压制、按需装载分类共用这张表。
const AGENT_TOOL_NAMES = new Set(['orchestrate_agents', 'wait_agents', 'agent_result']);
function adaptiveMetaToolSchemas(includeInvoke = false) {
  const tools = [
    {
      name: 'list_tools',
      description: 'List the compact Ruyi tool directory when you are unsure what capability or tool name to search for. Returns names grouped by pack, without descriptions or schemas; use tool_search next for details and risk tier.',
      inputSchema: { type: 'object', properties: { pack: { type: 'string', description: 'Optional exact pack id to list.' }, cursor: { type: 'number', description: 'Optional zero-based cursor from a previous response.' }, limit: { type: 'number', description: 'Maximum names, 1..200. Defaults to 200 (normally the complete catalog).' } } },
    },
    {
      name: 'tool_search',
      description: 'Search the compact Ruyi tool catalog when the currently loaded tools do not cover the task. Returns matching names, packs, risk tiers, short descriptions and argument outlines without injecting every schema.',
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
      // 2026-10:写明两层各放什么(真机失败几乎全是把目标名塞进 arguments / 把整次调用当参数),档位口径改成「不高于本档」。比修前短 13 字符。
      description: `Invoke one discovered Ruyi tool: name = its exact name, arguments = its own parameters. Targets above ${tier} tier are rejected.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Exact tool name from tool_search.' }, arguments: { type: 'object', description: 'Arguments matching that tool schema.' } }, required: ['name'] },
    });
  }
  return tools;
}

// 审计 N4:allowCommandTools / allowDesktopTools 不只是「不 offer」—— 分发点也按同一判据拒绝(bypass/auto 下 gate 恒 allow,
// 光藏 schema 拦不住模型直接吐出的 script_run)。offer 面(buildOpenAiTools)与分发面(09 主循环 / 08 子代理 / 12 toolCall)共用本函数。
// 返回空串 = 放行;否则是给模型看的中文原因。desktopOverride 语义同 buildOpenAiTools(null = 跟随全局)。
const NATIVE_COMMAND_TOOL_NAMES = new Set(['powershell_run', 'script_run', 'shell_start', 'shell_send', 'shell_poll', 'shell_kill', 'shell_list']);
const NATIVE_DESKTOP_TOOL_NAMES = new Set(['desktop_screenshot', 'keyboard_send_keys']);
// 桌面闸的唯一判法(原生与桥接共用):会话级覆盖 desktopOverride 非 null 时以它为准,否则跟随全局 allowDesktopTools。
function desktopToolsDisabledReason(cfg, desktopOverride) {
  const allowDesk = desktopOverride == null ? (cfg || {}).allowDesktopTools !== false : desktopOverride === true;
  if (allowDesk) return '';
  return desktopOverride === false ? 'desktopTools=false (this session)' : 'allowDesktopTools=false';
}
function nativeToolDisabledByPolicy(name, config, desktopOverride = null) {
  const cfg = config || {};
  if (NATIVE_COMMAND_TOOL_NAMES.has(name) && cfg.allowCommandTools === false) return 'allowCommandTools=false';
  if (NATIVE_DESKTOP_TOOL_NAMES.has(name)) return desktopToolsDisabledReason(cfg, desktopOverride);
  return '';
}
// 2026-10 能力总闸补上桥接面。设置页承诺「关掉之后,对应的工具在所有线程里既不提供给模型、也不会执行」,修前只兑现了上面
// 两张原生名单 —— 内置桌面 MCP(ACC:serverId 'ai-computer-control',桥接名前缀 ai_computer_control__)的 run_command /
// screenshot / mouse_click 等在两个开关都关掉之后照常提供、照常执行。下面按 ACC 的【裸工具名】补两族(逐个对过
// mcp/ai-computer-control/src/ai_computer_control/tools/*.py:108 件里收 55 件),【只认内置桌面 MCP】—— 外部 MCP 服务器
// 哪怕有同名工具也不受影响(它们的语义由用户接入时自己负责,工作台不替它猜)。判据收在 toolDisabledByPolicy 一个函数里,
// offer 面(09 目录 / 08 子代理 / 11 MCP 子进程目录 / 07 createToolLoadingState)与分发面(09 / 08 / 12 代理 / 13d CLI 权限桥)
// 都调它;CLI 直挂 ACC 的那一路(01 addExternalMcpServersToMap / syncMcpServersToClaude)按同一张表算出 ACC_HIDE_TOOLS 交给
// ACC 自己在注册表里摘掉。
//   命令族(随 allowCommandTools):起进程 / 跑命令 / 杀进程,与原生 powershell_run / script_run / shell_* 同一类能力。
//     list_processes 只读进程表、不执行任何东西,不收。
//   桌面族(随 allowDesktopTools 与会话级 desktopTools 覆盖,判法与 NATIVE_DESKTOP_TOOL_NAMES 是同一个 desktopToolsDisabledReason):
//     按「作用于真实桌面」归类 ——
//     · screen / capture / mouse / keyboard / window / uia / vision / sync / observe / act_and_verify 全族:读屏、点屏、动键鼠、摆窗口;
//     · ocr 只收读屏的 ocr_screen / ocr_click / ocr_find_text(后者内部就是 ocr_screen);ocr_image 读的是图片文件、
//       ocr_available_languages 只列语言包,不收;
//     · desktop_extra 的像素 / 窗口等待 / 显示器与 DPI 查询;它的 get_clipboard_image / set_clipboard_image 与 clipboard
//       模块一起按剪贴板算(剪贴板是桌面会话的共享状态,原生 keyboard_send_keys 同族);
//     · record 全族:record_start 装全局键鼠钩子录下用户的真实输入;macro_list 只列宏文件,但它唯一的用途是喂给 macro_run 回放,随宏族一起关。
//     名单外的(文件、Office、浏览器自动化、提示音 / 通知弹窗、系统信息、诊断、记忆、fetch)不受影响。
//   转调器(两个开关【任一】关掉都关):batch_actions / macro_run 按步骤名转调 ACC 实时注册表里的【任意】工具(batch.py
//     _tool_map,含 run_command / launch_application)—— 只随桌面闸关,它就是命令族的后门;只随命令闸关,反过来也一样。
const DESKTOP_MCP_SERVER_ID = 'ai-computer-control';
const ACC_POLICY_TOOL_FAMILIES = Object.freeze({
  command: Object.freeze(['run_command', 'launch_application', 'kill_process']),
  desktop: Object.freeze([
    'screenshot', 'screenshot_region', 'get_screen_info', 'find_on_screen',                                    // screen
    'window_screenshot',                                                                                       // capture
    'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'scroll_at', 'get_mouse_position',              // mouse
    'type_text', 'press_key', 'hotkey', 'key_down', 'key_up',                                                  // keyboard
    'list_windows', 'get_active_window', 'focus_window', 'resize_window', 'move_window',                       // window
    'minimize_window', 'maximize_window', 'close_window', 'set_window_topmost',
    'ui_inspect', 'ui_find', 'ui_invoke',                                                                      // uia
    'find_template', 'find_all_templates', 'vision_click', 'wait_for_image',                                   // vision
    'ocr_screen', 'ocr_click', 'ocr_find_text',                                                                // ocr(只收读屏的)
    'wait_for_pixel',                                                                                          // sync
    'get_pixel_color', 'wait_for_window', 'wait_for_window_idle', 'list_monitors', 'get_dpi_info',             // desktop_extra
    'observe', 'act_and_verify',                                                                               // observe / act_and_verify
    'record_start', 'record_stop', 'macro_list',                                                               // record
    'get_clipboard', 'set_clipboard', 'get_clipboard_image', 'set_clipboard_image',                            // clipboard
  ]),
  dispatcher: Object.freeze(['batch_actions', 'macro_run']),
});
const ACC_COMMAND_TOOL_NAMES = new Set(ACC_POLICY_TOOL_FAMILIES.command);
const ACC_DESKTOP_TOOL_NAMES = new Set(ACC_POLICY_TOOL_FAMILIES.desktop);
const ACC_DISPATCHER_TOOL_NAMES = new Set(ACC_POLICY_TOOL_FAMILIES.dispatcher);
// bridge = resolveBridge 的结果 { serverId, toolName }(toolName 是裸名)。不是内置桌面 MCP 的一律放行。
function bridgedToolDisabledByPolicy(bridge, config, desktopOverride = null) {
  if (!bridge || bridge.serverId !== DESKTOP_MCP_SERVER_ID) return '';
  const cfg = config || {};
  const bare = String(bridge.toolName || '');
  const commandOff = cfg.allowCommandTools === false;
  if (ACC_COMMAND_TOOL_NAMES.has(bare)) return commandOff ? 'allowCommandTools=false' : '';
  if (ACC_DESKTOP_TOOL_NAMES.has(bare)) return desktopToolsDisabledReason(cfg, desktopOverride);
  if (ACC_DISPATCHER_TOOL_NAMES.has(bare)) return desktopToolsDisabledReason(cfg, desktopOverride) || (commandOff ? 'allowCommandTools=false' : '');
  return '';
}
// 唯一入口:bridge 为空 = 原生工具(按名字判),否则按桥接目标判。返回空串 = 放行,否则是原因(给 toolDisabledResult)。
function toolDisabledByPolicy(name, config, desktopOverride = null, bridge = null) {
  return bridge ? bridgedToolDisabledByPolicy(bridge, config, desktopOverride) : nativeToolDisabledByPolicy(name, config, desktopOverride);
}
// 这份配置(+ 会话覆盖)下内置桌面 MCP 里被关掉的裸工具名(升序)—— 交给 ACC 的 ACC_HIDE_TOOLS 在注册表里摘掉(CLI 直挂面)。
function accPolicyHiddenToolNames(config, desktopOverride = null) {
  const names = [...ACC_POLICY_TOOL_FAMILIES.command, ...ACC_POLICY_TOOL_FAMILIES.desktop, ...ACC_POLICY_TOOL_FAMILIES.dispatcher];
  return names.filter(n => bridgedToolDisabledByPolicy({ serverId: DESKTOP_MCP_SERVER_ID, toolName: n }, config, desktopOverride)).sort();
}
// offer 面:从 [openai fn schema] 里去掉被设置关掉的【桥接】工具(原生工具由 buildOpenAiTools 自己滤)。route 不动 ——
// 分发面要靠它认出「这是被关掉的 ACC 工具」,回 tool-disabled 而不是 unknown-tool。
function dropPolicyDisabledBridgedTools(tools, bridgedRoute, config, desktopOverride = null) {
  return (Array.isArray(tools) ? tools : []).filter(t => {
    const name = t && t.function && t.function.name;
    const bridge = name ? resolveBridge(bridgedRoute || {}, name) : null;
    return !bridge || !bridgedToolDisabledByPolicy(bridge, config, desktopOverride);
  });
}
function toolDisabledResult(name, reason) {
  return { ok: false, code: 'tool-disabled', error: `tool '${name}' is disabled by settings (${reason})`, hint: '该工具已被设置关闭;请改用其它已提供的工具,或让用户在设置里开启后再试。' };
}
// 审计 N5:按名字取原生工具自己的 JSON schema(13f MCP_TOOLS),供分发前的入参校验(12 validateNativeToolArgs)。
// 放在 07 而不是 12:07 本就读 MCP_TOOLS,12 再读就是新增一条前向边(module-dependency-graph 的债务上限会红)。
// C2:13f 的 PROVIDER_SESSION_TOOL_SCHEMAS(只发给模型服务商主回合、不进 MCP_TOOLS 的 scratchpad_write)同走这道校验。
let _nativeToolSchemaByName = null;
function nativeToolSchema(name) {
  if (!_nativeToolSchemaByName) {
    _nativeToolSchemaByName = new Map();
    for (const t of MCP_TOOLS.concat(PROVIDER_SESSION_TOOL_SCHEMAS)) if (t && t.name && t.inputSchema) _nativeToolSchemaByName.set(t.name, t.inputSchema);
  }
  return _nativeToolSchemaByName.get(name) || null;
}
// 12 的「代理漏写目标名」错误按模型给的参数键猜候选目标(只做提示):给出的键全是该工具的参数、且该工具的必填全在其中。
// 返回 [{ name, tier, required }](required = 必填个数,越多越具体);放在 07 的理由同上(07 本就读 MCP_TOOLS)。
function nativeToolsAcceptingArgKeys(keys) {
  const want = (Array.isArray(keys) ? keys : []).filter(k => typeof k === 'string' && k);
  if (!want.length) return [];
  const out = [];
  for (const t of MCP_TOOLS) {
    const schema = t && t.inputSchema;
    const props = (schema && schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
    const required = Array.isArray(schema && schema.required) ? schema.required : [];
    if (!want.every(k => Object.prototype.hasOwnProperty.call(props, k))) continue;
    if (!required.every(k => want.includes(k))) continue;
    out.push({ name: t.name, tier: nativeToolTier(t.name), required: required.length });
  }
  return out;
}
function buildOpenAiTools(config, caps, opts) {
  // 116f: 管家会话标记。为 true 时本函数【只】返回 steward_*(收口在末尾的唯一出口,见那里的注释)。
  const stewardSession = !!(opts && opts.stewardSession === true);
  // 117z-E2 提交①(27 号文 §11.21.3):桌面工具从「全局唯一一把闸」变成「全局闸 + 会话级覆盖」。
  // 【全局闸一个字没动】—— config.allowDesktopTools 仍然是 forbidden 清册里那一个键(06i:776),
  // 管家改不了它。opts.desktopOverride 是【另一把钥匙】,由调用方从会话头 session.desktopTools 取:
  //   null / undefined -> 跟随全局(= 修前逐字行为,全部存量会话与所有不传该键的调用方都走这一支);
  //   true             -> 这条线程拿得到桌面工具;
  //   false            -> 这条线程拿不到。
  // 拿不到 session 的调用方(子代理 08-agent-runs、各类探针与 e2e 直调)传 null 或干脆不传 —— 它们
  // 没有「这一条线程」这个概念,一律跟随全局。
  const desktopOverride = (opts && opts.desktopOverride != null) ? opts.desktopOverride : null;
  const out = [];
  const tierRank = TOOL_TIER_RANK; // P2-9: 单一事实源见 00-boot.js(117q-B7 从本文件移出)
  const tierFilter = opts && opts.tierFilter;
  const maxRank = (tierFilter && tierFilter in tierRank) ? tierRank[tierFilter] : null; // null → no tier filter
  const noAgentTools = !!(opts && opts.noAgentTools);
  // 代理模式 v2:三个代理工具(orchestrate_agents 启动 / wait_agents 收件 / agent_result 取全文)只在功能开启
  // (subagentMaxPerTurn>0,语义已平移到 orchestrate:本回合累计启动的节点数上限)且未被显式压制(子回合传
  // noAgentTools → 禁嵌套)时 offer。0 = 功能关 → 三个工具都不注册。
  const agentToolsEnabled = !noAgentTools && Number(config.subagentMaxPerTurn) > 0;
  // v0.8-S6: gate tools whose runtime requirements (TOOL_REQUIRES) are unmet by the capability matrix. The
  // testOnly entry only fires when config.enableToolRequiresProbe is set (see TOOL_REQUIRES note), so this
  // is inert in production until v0.9 populates the table. buildProviderSystemPrompt lists the filtered
  // tools under 「当前不可用」 so the model is told why they're absent.
  const toolRequiresEnabled = !!(config && config.enableToolRequiresProbe);
  for (const t of MCP_TOOLS) {
    if (t.name === 'list_tools' || t.name === 'tool_search' || t.name === 'tool_load' || t.name.startsWith('tool_invoke_')) continue;
    if (t.name === 'permission_prompt') continue;
    if (t.name === 'request_user_input' && noAgentTools) continue;
    if (AGENT_TOOL_NAMES.has(t.name) && !agentToolsEnabled) continue;
    if (nativeToolDisabledByPolicy(t.name, config, desktopOverride)) continue; // allowCommandTools / allowDesktopTools(offer 与分发共用同一判据)
    // 105a: observation_recall 仅在 recall+reducer 双开关生效时 offer;默认关 → 不出现在工具集。
    if (t.name === 'observation_recall' && !observationRecallEnabled(config)) continue;
    // 116c(27 号文 §3.5「分离」):管家工具族只对 kind==='steward' 的管家会话 offer —— 这是四个 offer
    // 面之一(其余三面:MCP tools/list 桥、adaptive 目录、/api/status 工具清单)。fail-closed:调用方
    // 不显式传 opts.stewardSession 就一律不 offer,普通会话与子代理回合永远看不到 steward_*。
    if (isStewardToolName(t.name) && !(opts && opts.stewardSession === true)) continue;
    // v0.9-S6: toolTier filter for sub-turns — drop any tool above the requested tier. orchestrate_agents (exec)
    // is already suppressed for sub-turns via noAgentTools, so it never survives an 'exec' sub-turn either.
    if (maxRank !== null && (tierRank[nativeToolTier(t.name)] ?? 2) > maxRank) continue;
    if (caps && !toolRequirementsMet(t.name, caps, toolRequiresEnabled, config).met) continue; // requirement unmet → drop
    out.push({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } });
  }
  // C2(61 号文)会话草稿本:只在调用方显式传 opts.scratchpadEnabled 时 offer —— 09 主回合对非管家会话传;08 子代理、
  // 管家会话(末尾唯一出口只留 steward_*)、各类探针不传。schema 在 13f PROVIDER_SESSION_TOOL_SCHEMAS(不进 MCP_TOOLS,
  // 所以 Claude/Kimi CLI 的 MCP 面、/api/status、代理目录天然没有它)。read 档,tierFilter 也挡不住它,照常过一遍。
  if (opts && opts.scratchpadEnabled === true) {
    for (const t of PROVIDER_SESSION_TOOL_SCHEMAS) {
      if (maxRank !== null && (tierRank[nativeToolTier(t.name)] ?? 2) > maxRank) continue;
      out.push({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } });
    }
  }
  // 代理模式 v2:wait_agents / agent_result 现随 MCP_TOOLS 一起 offer(上面的 AGENT_TOOL_NAMES 门),不再在此手工追加 ——
  // MCP 子进程侧靠 /api/agent-workflow/wait|result 回环,两面同一份 schema。
  // v1 技能体系: skill_read(provider 引擎, read tier)—— 仅在本会话有启用技能时注册(offer 条件由调用方传
  // opts.skillsEnabled 决定,仿代理工具的 enable 门)。不入 MCP_TOOLS(否则会泄漏给 Claude CLI 且恒开)。
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
  // 策略非 off 时注册(offer 由调用方 opts.proposeTaskEnabled 门控,仿 skill_read/代理工具的 enable 门)。不进
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
  // 116f(27 号文 §3.5 硬边界「管家动如意,线程动世界」):管家会话的工具面【只有】steward_*。
  // 116c 的 isStewardToolName 门只解决了「普通会话拿不到管家工具」这半边;另半边同样是红线 ——
  // 管家会话【不得】拿到文件/shell/桌面/联网/编排/技能/元工具中的任何一个(tool_invoke_* 尤其危险:
  // 它是桥接工具的代理入口,漏一个就等于把整台电脑交给一个常在用户不在场时自主运行的回合)。
  // 收口放在唯一出口做一次,而不是给上面每一段(wait_agents/skill_read/propose_task/send_to_agent/
  // adaptive 元工具)各加一个门 —— 那样将来任何一段新增都可能漏门,这里漏的可能性为零。
  if (stewardSession) return out.filter(t => isStewardToolName(t && t.function && t.function.name));
  return out;
}
// Risk tier per tool → drives permission gating in the native loop (read = auto-allow).
const NATIVE_TOOL_TIER = {
  permission_prompt: 'exec', // CLI 权限桥(由 --permission-prompt-tool 触达);原靠 unknown→exec 兜底,第41波显式化
  workbench_memory_list: 'read', workbench_memory_read: 'read', workbench_memory_propose: 'read',
  workbench_memory_relation_propose: 'read', workbench_memory_revise: 'read', workbench_memory_relation_revoke: 'read',
  observation_recall: 'read', // 105a: 只读当前会话快照,授权来自 ctx 会话归属 → auto-allow
  checkpoint_list: 'read', // C4: 只读当前会话的检查点索引与撤销记录(会话取自 ctx,不触文件路径、不回滚;撤销只能由用户在界面做)→ auto-allow
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
  // C2(61 号文):会话草稿本与 todo_write 同类 —— 只写工作台自有的会话旁车(sessions/<id>.scratchpad.json),不碰用户文件、
  // 不执行任何东西,会话只取回合 ctx(12 handler) → read 档 auto-allow。计划阶段也放行(见 09 PLAN_DISCOVERY_BLOCKED_TOOLS 头注)。
  scratchpad_write: 'read',
  workbench_self_status: 'read', // 108c: 只读自状态(版本/位置/端口/健康/计数/设置掩码),不触文件路径 → auto-allow
  // 116c(27 号文 §3.5 tier 分档):管家工具族。观察族 read(只读如意自身账面,零副作用);线程族 edit
  // (建线程/递话/改名,全部返回 undoRef 可撤销);决策族 exec(替用户答复待决、控制班组运行,最高危)。
  // 记忆族按「管家记忆自由」定 edit —— 写的是管家自己的记忆文件,不触外部世界。
  steward_self_status: 'read', steward_threads_search: 'read', steward_thread_status: 'read',
  steward_thread_read: 'read', steward_runs_status: 'read', steward_inbox_read: 'read',
  steward_usage: 'read', steward_health: 'read', steward_audit_tail: 'read',
  // 116g: 事项级只读视图归观察族 read —— 它只读事项文件与既有投影,零副作用。
  steward_missions: 'read',
  // 129b: 三张「有哪些可选」的只读清单同归 read —— 只读如意自己的注册表/配置/模板目录,
  // 零副作用、零外部内容(与 129d 的「眼睛」那四件分界线就在这一句上)。
  steward_skills: 'read', steward_providers: 'read', steward_playbooks: 'read',
  // 129d: 眼睛四件也是 read —— 它们只读、不改世界。「读了之后不能再自己动手」由污染闸管,
  // 不是靠把它们归成 edit(归成 edit 只会让读本身变难,挡不住读完之后的那个写)。
  steward_web_search: 'read', steward_web_fetch: 'read', steward_file_read: 'read',
  steward_thread_artifact_read: 'read',
  // 129f: 叫人归 read —— 它不改世界,只是把一句话送到屏幕上(三档都可用)。
  steward_notify: 'read',
  steward_thread_new: 'edit', steward_thread_continue: 'edit', steward_thread_rename: 'edit',
  // 129e: 改工作目录归线程族 edit(它改的是线程元数据,不执行任何东西)。
  steward_thread_workspace: 'edit',
  // 116-2a: 线程权限收紧归线程族 edit —— 它只能【降】档(放宽是永久豁免第 2 条,机器上就走不通),
  // 收紧本身是保守动作,且返回 undoRef 可一键改回;给 exec 反而会让「先收紧再动手」在低档线程上失效。
  steward_thread_permission: 'edit',
  // 116-2b: 插话补充归线程族 edit —— 它只是往【已在跑】的回合里补一句上下文(不新起回合、不放宽
  // 任何权限,目标回合自己的权限门一字未动),与递话/改名同一档。
  steward_thread_note: 'edit',
  steward_thread_prioritize: 'edit',   // 116h:插队只动队列顺序,不改文件不动世界,归线程族 edit
  steward_decide: 'exec', steward_run_action: 'exec',
  // 117m-A4: 线程级停止与 run_action 同族(决策族 exec)—— 它真的去掐一个在跑的子进程/在途请求。
  // 归 exec 是按「动作强度」定档,不是按「危险方向」:它是收紧类,13g 内部对任何权限档都放行。
  steward_thread_stop: 'exec',
  // 记忆族整族 edit(含只读的 search):27 号文 §3.5「内容管理」按族定档,116c 交办单同口径。
  // search 本身零副作用,给 edit 只是让整族在权限面上同进同退,不额外放宽任何东西。
  steward_memory_write: 'edit', steward_memory_veto: 'edit', steward_memory_search: 'edit',
  // 116-2e(§3.5 工具面表「如意设置」/「内容管理」两行):config_get 只读掩码后的配置、零副作用,归
  // read(与观察族同档);config_set 真的改工作台的行为,exec。内容管理:playbook 起草只出草稿不落盘,
  // 归 edit;技能启停改的是那条线程下一回合的工具面与提示词、速查开的是一条真会动世界的线程,两者 exec。
  steward_config_get: 'read', steward_config_set: 'exec',
  steward_playbook_draft: 'edit', steward_skill_toggle: 'exec', steward_quick_ask: 'exec',
  // 123-M2(37 号文 §3.5):定时任务六件归「如意设置」族 —— list 只读、零副作用,归 read;
  // 另五件都改的是【如意自己账面上的一张表】(任务定义),不动文件、不动外部世界,归 edit。
  // 特别是 run_now:它自己不动世界,真正会动世界的是那一次回合,而那一次回合走的是任务自带的
  // permissionMode(天花板 = 全局档,永不含 bypass),边界在那儿,不在这张分档表上。
  steward_schedule_list: 'read',
  steward_schedule_create: 'edit', steward_schedule_pause: 'edit', steward_schedule_resume: 'edit',
  steward_schedule_run_now: 'edit', steward_schedule_delete: 'edit',
  skill_read: 'read', // v1 技能体系: 只读已启用技能的 SKILL.md + 目录清单(路径受限该技能目录内)→ auto-allow
  // 61 号文 C1:Playbook / 技能清单与 Playbook 步骤文本 —— 只读如意自己的注册表与模板目录,零副作用 → auto-allow。
  // 「读到模板」不等于「被授权照做」:照做须用户点名或明确同意,由结果 note + 系统提示尾行讲明,不靠把它们归成 edit。
  playbook_list: 'read', playbook_read: 'read', skill_list: 'read',
  web_search: 'read', web_fetch: 'read', // v0.9-S9: read-only network reads (no local mutation) → auto-allow (SSRF-guarded)
  file_write: 'edit', file_edit: 'edit', file_delete: 'edit', // v0.8-S4a: delete is journaled (revertible) → edit tier
  // v1.1-W2 (T1): 移动/复制/压缩/解压/下载 —— 均落盘且经检查点(可撤销) → edit tier。
  file_move: 'edit', file_copy: 'edit', archive_zip: 'edit', archive_unzip: 'edit', http_download: 'edit',
  powershell_run: 'exec', script_run: 'exec', keyboard_send_keys: 'exec', browser_open: 'exec', office_open: 'exec',
  desktop_screenshot: 'exec', http_request: 'exec',
  // 127-114c③(26 号文 §3):读本地音频后出网转写 —— 用户文件内容离开本进程,与「文件出网」同档 exec。
  audio_transcribe: 'exec',
  orchestrate_agents: 'exec', // 代理模式 v2:委派子代理是最高特权的原生动作 → exec 档(旧 spawn_agent 已并入)
  spawn_agent: 'exec', // 137 集成:兼容口仍在注册表(旧模型调它 → MCP 子进程翻译成单节点 orchestrate),档位必须与 orchestrate_agents 同为 exec,不能因缺声明落到低档
  wait_agents: 'read',
  agent_result: 'read',
  // v0.8-S2 shell session族: listing is read-only; start/send/poll/kill mutate state → exec.
  shell_list: 'read', shell_start: 'exec', shell_send: 'exec', shell_poll: 'exec', shell_kill: 'exec',
};
// P2-9(30号文§3 总表 + §8.9②): 工具分级排序表 TOOL_TIER_RANK 117q-B7 已迁往 00-boot.js —— 117q-B5 曾把它
// 落在本文件,但 09b-replan-ledger.js 此前从未消费本文件的任何符号,那次收编因此新增了一条循环边
// 09b-replan-ledger.js->07-autonomy.js,被迫登记进白名单;07/08/09b 三个消费者其实全部已经依赖
// 00-boot.js,落回那里新增边数为零。定义与说明见 00-boot.js。
function nativeToolTier(name) { return NATIVE_TOOL_TIER[name] || 'exec'; } // unknown → safest (treat as exec)
// v2.6 (loop guard 分层): 同签名连击(连续相同 name+rawArgs)对「无副作用」工具不应 abort ——
// 轮询/等待原语(相同参数反复调用是其设计语义: wait_agents 等后台 run 结束、shell_poll 读增量输出)
// 完全豁免同签名连击(不累计/不 warn/不 abort),无进展由语义指纹判定;只读工具(重复读无害)只 warn
// 不 abort;有副作用工具(edit/exec)保持 5 次 abort(重复执行=重复破坏)。
const LOOP_POLLING_TOOLS = new Set(['wait_agents', 'shell_poll']);
function loopAbortExempt(name) { return LOOP_POLLING_TOOLS.has(String(name || '').replace(/^.+?__/, '')); } // 轮询原语: 完全豁免
function loopWarnOnly(name) { return nativeToolTier(String(name || '').replace(/^.+?__/, '')) === 'read'; } // 无副作用只读: 只 warn 不 abort

// P2-14(30号文§3 总表): 死循环护栏数值 —— 主回合(09-workflow.js 的 LOOP_WARN_AT/LOOP_ABORT_AT/
// LOOP_RECOVERY_MAX)与子代理(08-agent-runs.js 的 SUB_LOOP_WARN_AT/SUB_LOOP_ABORT_AT/SUB_LOOP_RECOVERY_MAX)
// 各写一份完全相同的数值(3/5/2),两处注释互相点名「对称」。只抽这三个数值,不抽判定逻辑 —— 两边命中之后
// 的「配对铁律补答」各有必要差异(主回合数 toolCalls 数组、子代理数 subHistory 消息数组;主回合额外记
// mission 停滞账本、子代理不记;子代理事件带 subagentId/scope:'subagent'),强行合并成参数化大函数收益
// 不抵风险,明确不做。09/08 两处保留各自的局部变量名(LOOP_*/SUB_LOOP_*),只把右侧字面量改成引用这里。
const LOOP_GUARD_LIMITS = Object.freeze({ WARN_AT: 3, ABORT_AT: 5, RECOVERY_MAX: 2 });

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
  // 审计 A10:ACC 里其余【纯读、不点不敲不写】的工具(逐个对过 tools/*.py 的签名)。修前它们落到默认 exec,default 模式下
  // 每次调用都弹窗 —— 而 screenshot 不弹,推荐的「一步感知」observe(截图+UIA+OCR)反而每次弹。
  //   · observe(不动桌面;act_and_verify 会动 → 仍 exec);
  //   · 读文档族 read_document / excel_read / pdf_read_pages / image_info —— 路径读闸另有 BRIDGED_READ_PATH_ARGS
  //     (03-bridge-guard,三个分发点同一个函数),工作区外/数据目录照拒;
  //   · 浏览器只读族(状态/标签/文本/元素/截图;打开、点击、输入、执行 JS、导航仍 exec);
  //   · 记忆只读 memory_read / memory_list(save/delete 仍 exec)、macro_list、ocr_available_languages、
  //     wait(纯休眠)、sequential_thinking(只在进程内记推理链)。
  // 【刻意不进】ocr_find_text(click 参数会物理点击;且 tool_invoke_* 的档校验要求目录档=入参档,按入参降档会让代理路径自相矛盾)、
  // get_environment_variable(BRIDGED_NOT_READ 钉着)、beep/play_sound(出声)、fetch(联网)。
  'observe', 'read_document', 'excel_read', 'pdf_read_pages', 'image_info',
  'browser_backend_status', 'browser_list_tabs', 'browser_get_text', 'browser_get_elements', 'browser_screenshot',
  'memory_read', 'memory_list', 'macro_list', 'ocr_available_languages', 'wait', 'sequential_thinking',
]);
// Prefix rules for read-only families that share a common verb (e.g. get_windows, list_processes,
// wait_for_window_idle). Kept narrow so an 'exec'-shaped verb can't sneak in under a broad prefix.
const BRIDGED_READ_PREFIXES = ['get_', 'list_', 'wait_for_'];
// 安全修复(审计 A②):前缀规则会把「读出秘密」的工具也收进 read 档(任何模式都零弹窗放行)。
// get_environment_variable 能读出宿主进程环境里的任何值(令牌、密钥、代理口令)—— 它不是「看一眼桌面」,
// 按未知工具的缺省口径落回 exec(非 bypass/auto 模式下先问人)。
const BRIDGED_NOT_READ = new Set(['get_environment_variable']);
// 安全修复(审计 A③):同一个工具按入参有两副面孔 —— get_clipboard_image / window_screenshot 不带落盘参数时
// 只回图,带了就往任意路径写文件(allow_protected:true 还会绕过 ACC 自己的系统目录护栏)。它们的写路径
// 参数本来就登记在 BRIDGED_WRITE_PATH_ARGS(检查点要用),这里复用同一张表:给了写路径参数的这一次调用,
// 档位至少是 edit;再带 allow_protected:true 就是 exec。只抬不降,用户覆盖表也压不下这道地板。
// args 缺省(目录/清单等不看入参的调用方)= 修前口径。args 可以是对象或 JSON 字符串。
function bridgedCallTierFloor(unprefixedName, args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '';
  const spec = Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, unprefixedName) ? BRIDGED_WRITE_PATH_ARGS[unprefixedName] : null;
  if (!spec) return '';
  const fields = Array.isArray(spec.multi) ? spec.multi : [spec];
  const writes = fields.some(f => typeof a[f.field] === 'string' && a[f.field].trim());
  if (!writes) return '';
  return a.allow_protected === true ? 'exec' : 'edit';
}
// Resolve a bridged tool's tier: user override (config.bridgedToolTiers) wins, then the built-in table,
// then default 'exec'. `unprefixedName` is bridge.toolName (never the serverId__tool form).
// 第三参 args(可选):按本次调用的入参抬档(见 bridgedCallTierFloor)。
function bridgedToolTier(unprefixedName, config, args) {
  const base = bridgedToolTierByName(unprefixedName, config);
  const floor = args === undefined ? '' : bridgedCallTierFloor(unprefixedName, args);
  const rank = { read: 0, edit: 1, exec: 2 };
  return floor && rank[floor] > rank[base] ? floor : base;
}
function bridgedToolTierByName(unprefixedName, config) {
  const overrides = (config && config.bridgedToolTiers && typeof config.bridgedToolTiers === 'object') ? config.bridgedToolTiers : {};
  const ov = overrides[unprefixedName];
  if (ov === 'read' || ov === 'edit' || ov === 'exec') return ov;
  if (BRIDGED_NOT_READ.has(unprefixedName)) return 'exec';
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
  skills: 'list installed skills and Playbooks, read enabled skill instructions and Playbook steps',
  integrations: 'inspect and configure MCP connectors and browser targets',
  memory: 'Workbench Memory maintenance: propose relations between memories, revise a confirmed memory, revoke a relation (plus external memory_save/read/list/delete)',
  thinking: 'step-by-step reasoning chains and sequential thinking',
  // 116c: 管家专属包。只对 kind==='steward' 的会话 offer(四个 offer 面各自门控),普通会话永不进入。
  steward: 'workbench steward: observe threads, delegate work, decide pending items and keep steward memory',
});
// 2026-10 起手工具:模型服务商回合的按需装载里,不论这句话分到哪些包,第一发就带上的几个原生工具(相当于给 core 扩一小圈;
// 不改 core 包本身 —— core 同时决定 Claude CLI 的 MCP 工具清单,而 CLI 有自己的 Read/WebSearch/WebFetch/Bash)。
// 依据(本机 4 天真实调用):联网 web_search + web_fetch 占全部工具调用的六成多(147/230),3 个会话里 2 个用到;
// 命令行 3 个会话都用到(powershell_run 27 次、script_run 9 次)。开局没装、中途补装时,提供方的前缀缓存会整段失效
// (实测命中率 97%→3%、94%→8%,下一发几乎整段上下文按未缓存计);三个合计约 630 token,每发基本都命中缓存,比中途断一次便宜。
// file_read 不进:分包对文件类说法的召回本就高(文件/目录/路径/代码/项目/查看/搜索…),tool-loading e2e 也用它钉「按需注入」。
const PROVIDER_STARTER_TOOLS = Object.freeze(['web_search', 'web_fetch', 'powershell_run']);
const NATIVE_TOOL_PACKS = Object.freeze({
  permission_prompt: 'core', request_user_input: 'core', todo_write: 'core', mission_update: 'core',
  workbench_memory_list: 'core', workbench_memory_read: 'core', workbench_memory_propose: 'core',
  // N8: 三个记忆维护工具(关系边提议/修订/撤销边,合计 ≈3.1K 字符)很少用,不必每回合都带:归 memory 包,
  // 用户话里提到记忆/修订/关系时 classifyToolPacks 自动装载;没装时仍可 tool_load({packs:['memory']}) 或 tool_invoke_read 调用。
  workbench_memory_relation_propose: 'memory', workbench_memory_revise: 'memory', workbench_memory_relation_revoke: 'memory',
  observation_recall: 'core', workbench_self_status: 'core', // 108c: core 常驻,不依赖 classifyToolPacks 意图分类
  // C2(61 号文)会话草稿本归 core(开局即在):它的用处在压缩之后,而笔记得在压缩【之前】就记下 —— 放进按需包,模型要么不知道
  // 有它,要么中途 tool_load 一次,提供方前缀缓存整段失效(起手工具表头注的实测:97%→3%)。常驻的代价是 schema 约 710 字符
  // (≈200 token),每发基本命中缓存。core 同时决定 Claude CLI 的 MCP 工具清单,但它不在 MCP_TOOLS 里(13f 头注),CLI 那边不受影响。
  scratchpad_write: 'core',
  list_tools: 'core', tool_search: 'core', tool_load: 'core', tool_invoke_read: 'core', tool_invoke_edit: 'core', tool_invoke_exec: 'core',
  file_read: 'files_read', file_list: 'files_read', file_search: 'files_read', glob: 'files_read', project_snapshot: 'files_read',
  audio_transcribe: 'files_read', // 127-114c③:读本地音频文件转写,目录归 files_read(tier 仍是 exec)
  file_write: 'files_write', file_edit: 'files_write', file_delete: 'files_write', file_move: 'files_write', file_copy: 'files_write',
  // C4:检查点清单归 files_write 而不是 core / files_read —— 它回答的是「刚才那些写操作哪些能撤」,只有手里有写类工具时才有用,
  // 随写包一起装(写包本就按「修改/创建/删除…」意图装载,下面 classifyToolPacks 另补了撤销/回滚/检查点);放 core 会每回合常驻
  // 并泄给 Claude CLI 的 MCP 清单(CLI 自己有 Edit/Write),放 files_read 则读文件的回合白背一个用不上的 schema。
  checkpoint_list: 'files_write',
  dependency_inventory: 'code', code_review_scan: 'code', frontend_audit: 'code', claude_md_audit: 'code', docs_search: 'code', codebase_symbol_search: 'code', debug_hypothesis: 'code', data_profile: 'code',
  git_status: 'code', git_diff: 'code', git_log: 'code', git_commit: 'code',
  powershell_run: 'shell', script_run: 'shell', shell_start: 'shell', shell_send: 'shell', shell_poll: 'shell', shell_kill: 'shell', shell_list: 'shell',
  web_search: 'web', web_fetch: 'web', http_request: 'web', http_download: 'web', browser_open: 'web',
  desktop_screenshot: 'desktop', keyboard_send_keys: 'desktop', office_open: 'office',
  archive_zip: 'archive', archive_unzip: 'archive', spawn_agent: 'agents', orchestrate_agents: 'agents', wait_agents: 'agents', agent_result: 'agents', skill_read: 'skills',
  playbook_list: 'skills', playbook_read: 'skills', skill_list: 'skills', // 61 号文 C1:不进 PROVIDER_STARTER_TOOLS(起手工具影响前缀缓存),说到 Playbook/技能时 classifyToolPacks 带出
  mcp_list: 'integrations', mcp_configure: 'integrations',
  // 116c: 管家工具族全部归 steward 包 —— 普通会话的 classifyToolPacks 永远不会路由到这个包
  // (四个 offer 面在包路由【之前】就按 isStewardToolName 拦掉了,包只是目录归属的一致性声明)。
  steward_self_status: 'steward', steward_threads_search: 'steward', steward_thread_status: 'steward',
  steward_thread_read: 'steward', steward_runs_status: 'steward', steward_inbox_read: 'steward',
  steward_usage: 'steward', steward_health: 'steward', steward_audit_tail: 'steward',
  steward_missions: 'steward',
  steward_skills: 'steward', steward_providers: 'steward', steward_playbooks: 'steward',
  steward_web_search: 'steward', steward_web_fetch: 'steward', steward_file_read: 'steward',
  steward_thread_artifact_read: 'steward',
  steward_notify: 'steward',
  steward_thread_new: 'steward', steward_thread_continue: 'steward', steward_thread_rename: 'steward',
  steward_thread_workspace: 'steward',
  steward_thread_permission: 'steward', steward_thread_note: 'steward', steward_thread_prioritize: 'steward',
  steward_decide: 'steward', steward_run_action: 'steward',
  steward_thread_stop: 'steward',                                            // 117m-A4
  steward_memory_write: 'steward', steward_memory_veto: 'steward', steward_memory_search: 'steward',
  steward_config_get: 'steward', steward_config_set: 'steward',              // 116-2e
  steward_playbook_draft: 'steward', steward_skill_toggle: 'steward', steward_quick_ask: 'steward',
  // 123-M2:定时任务六件同归 steward 包(与上面 27 个同一条理由 —— 包只是目录归属的一致性声明)。
  steward_schedule_create: 'steward', steward_schedule_list: 'steward', steward_schedule_pause: 'steward',
  steward_schedule_resume: 'steward', steward_schedule_run_now: 'steward', steward_schedule_delete: 'steward',
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
  file_read: { capabilities: ['workspace.file.read'], aliases: ['读取文件', '查看文件', '读文件', 'read workspace file'] },
  file_list: { capabilities: ['workspace.file.list'], aliases: ['列出目录', '查看目录', 'list directory'] },
  file_search: { capabilities: ['workspace.text.search'], aliases: ['搜索文件内容', '全文检索', 'search files'] },
  glob: { capabilities: ['workspace.path.glob'], aliases: ['按模式找文件', '文件通配符', 'find files by pattern'] },
  file_write: { capabilities: ['workspace.file.write'], aliases: ['写入文件', '创建文件', 'write file'] },
  file_edit: { capabilities: ['workspace.file.edit'], aliases: ['修改文件', '替换文本', 'edit file'] },
  file_delete: { capabilities: ['workspace.file.delete'], aliases: ['删除文件', '移除文件', 'delete file'] },
  file_move: { capabilities: ['workspace.file.move'], aliases: ['移动文件', '重命名文件', 'move file'] },
  file_copy: { capabilities: ['workspace.file.copy'], aliases: ['复制文件', '拷贝文件', 'copy file'] },
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
  // 下面两件和桥接桌面服务器的 type_text/hotkey、browser_open 是同一件事;给中文叫法,中文检索时与桥接的同分、按原生优先排在前面。
  keyboard_send_keys: { capabilities: ['desktop.keyboard.send'], aliases: ['键盘输入', '发送按键', '按快捷键', 'send keystrokes'] },
  browser_open: { capabilities: ['browser.url.open'], aliases: ['打开网页', '浏览器打开', '打开网址', 'open url in browser'] },
  office_open: { capabilities: ['office.document.open'], aliases: ['打开办公文档', '打开 excel word ppt pdf', 'open office document'] },
  orchestrate_agents: { capabilities: ['agent.workflow.orchestrate'], aliases: ['编排多个代理', '多代理工作流', 'orchestrate agents'] },
  wait_agents: { capabilities: ['agent.workflow.wait'], aliases: ['等待代理完成', '收代理结果', 'wait for agents'] },
  agent_result: { capabilities: ['agent.workflow.result'], aliases: ['读取代理产出全文', '代理结果', 'read agent result'] },
  skill_read: { capabilities: ['skill.instructions.read'], aliases: ['读取技能说明', '加载技能', 'read skill instructions'] },
  playbook_list: { capabilities: ['playbook.catalog.list'], aliases: ['列出预置流程', '有哪些流程模板', '查看 playbook 清单', 'list playbooks'] },
  playbook_read: { capabilities: ['playbook.steps.read'], aliases: ['读取预置流程步骤', '流程模板填参', '查看 playbook 步骤', 'read playbook steps'] },
  skill_list: { capabilities: ['skill.catalog.list'], aliases: ['列出可用技能', '有哪些技能', '查看技能清单', 'list installed skills'] },
  workbench_memory_read: { capabilities: ['memory.read'], aliases: ['读取工作台记忆', '回忆信息', 'read memory'] },
  checkpoint_list: { capabilities: ['workspace.checkpoint.list'], aliases: ['查看检查点', '可撤销的修改', '哪些改动能撤销', '已撤销的修改', 'list checkpoints', 'what can be undone'] },
  observation_recall: { capabilities: ['context.observation.recall'], aliases: ['回读原始工具结果', '取回被省略的观察', 'recall reduced observation', 'restore tool result'] },
  workbench_memory_propose: { capabilities: ['memory.propose'], aliases: ['提议保存记忆', '记住经验', 'propose memory'] },
});
// 2026-10: 桥接(MCP)工具的中文检索词。桥接工具的名字和描述多是英文,模型用中文搜(「截图」「鼠标点击」「关闭窗口」)时
// 一个词都对不上 —— 实测内置桌面服务器 108 个工具,「截图」只搜出 set_clipboard_image,「鼠标点击」零命中。这两张表按【工具名里的
// 英文词】给中文说法,不按哪个服务器的清单逐个登记:别的 MCP 服务器里同名词的工具(browser_take_screenshot、list_tabs…)一样受益。
// 键是 normalizeToolSearchText 之后的词或词组(词组优先、最长匹配;单词再试去掉复数 s/es),值的第一项是主说法;认不出的词
// (for/on/at/take…)跳过。词组键只给中文语序或说法与逐词拼接对不上的少数工具。只喂 aliases,不碰 tier/pack/schema。
// 刻意不收 file/directory/folder:桥接服务器自带的 read_file/edit_file/delete_file 与原生 file_* 重复,原生的有工作区护栏、
// 不用代理,中文搜「删除文件」该排出原生的,不该把桥接的复本顶上去。
const BRIDGED_TOOL_NAME_TERMS = Object.freeze({
  // 屏幕 / 截图 / 识别
  screenshot: ['截图', '截屏', '屏幕截图', '截个图'], screen: ['屏幕'], region: ['区域'],
  monitor: ['显示器'], pixel: ['像素'], color: ['颜色'], dpi: ['缩放比例', '显示缩放'],
  'screen info': ['屏幕信息', '屏幕分辨率'], 'find on screen': ['屏幕找图', '在屏幕上找图'],
  observe: ['观察屏幕', '看屏幕', '屏幕快照'], ocr: ['文字识别', '识别文字'], language: ['语言'],
  template: ['模板', '找图'], vision: ['识图', '找图'],
  // 鼠标 / 键盘
  mouse: ['鼠标'], click: ['点击', '单击'], drag: ['拖拽', '拖动'], scroll: ['滚动', '滚轮'], position: ['位置', '坐标'],
  'mouse click': ['鼠标点击', '鼠标单击', '双击', '右键点击'],
  keyboard: ['键盘'], key: ['按键'], hotkey: ['快捷键', '组合键'], text: ['文字', '文本'],
  'type text': ['输入文字', '键盘输入', '打字', '输入文本'], 'key down': ['按住按键', '按住'], 'key up': ['松开按键', '松开'],
  // 窗口 / 程序 / 系统
  window: ['窗口'], topmost: ['置顶'], application: ['程序', '应用', '软件'], process: ['进程'], command: ['命令'],
  system: ['系统'], environment: ['环境'], variable: ['变量'], notification: ['通知'], notify: ['提醒'],
  'message box': ['消息框', '弹窗', '对话框'], sound: ['声音'], beep: ['蜂鸣', '提示音'], wait: ['等待'],
  // 剪贴板
  clipboard: ['剪贴板', '粘贴板'], 'set clipboard': ['复制到剪贴板', '写入剪贴板', '设置剪贴板'],
  // 浏览器 / 网页
  browser: ['浏览器', '网页'], page: ['页面'], tab: ['标签页'], navigate: ['导航', '后退', '前进', '刷新'],
  element: ['元素'], js: ['脚本'], url: ['网址'], fetch: ['抓取网页', '网页抓取', '请求网址'],
  // 办公文档 / 图片
  document: ['文档'], excel: ['表格', '电子表格', '工作簿'], chart: ['图表'], beautify: ['美化', '排版'],
  pdf: ['pdf', 'pdf文档'], pptx: ['ppt', '幻灯片', '演示文稿'], ppt: ['ppt', '幻灯片', '演示文稿'], image: ['图片', '图像'],
  // 录制 / 批量 / 记忆 / 杂项
  record: ['录制'], macro: ['宏'], batch: ['批量'], verify: ['验证', '确认'], memory: ['记忆'],
  sequential: ['逐步'], thinking: ['思考', '推理'], diagnostics: ['诊断', '自检'], audit: ['审计日志', '审计'],
  safety: ['安全'], version: ['版本'], ui: ['控件', '界面'],
});
// 通用动词与修饰词:只跟上表的词拼成整句,自己撑不起别名(否则「删除」会成为 delete_file 的整句别名,任何带「删除」的查询都加分)。
const BRIDGED_TOOL_NAME_MODIFIERS = Object.freeze({
  get: ['获取', '读取'], set: ['设置', '写入'], list: ['列出', '列表'], read: ['读取', '查看'], write: ['写入', '生成', '创建'],
  edit: ['修改', '编辑'], copy: ['复制'], move: ['移动'], delete: ['删除'], save: ['保存'], open: ['打开'],
  close: ['关闭'], show: ['显示', '弹出'], find: ['查找', '定位'], run: ['运行', '执行'], execute: ['执行'],
  start: ['开始'], stop: ['停止'], switch: ['切换'], launch: ['启动', '打开'], kill: ['结束', '杀掉'], play: ['播放'],
  capture: ['截取', '捕获'],   // capture_screen → 截取屏幕;packet_capture / capture_audio 不该叫「截图」
  press: ['按下'], type: ['输入'], input: ['输入'], focus: ['切换到', '激活'], resize: ['调整大小', '缩放'],
  minimize: ['最小化'], maximize: ['最大化'], active: ['活动', '当前'], idle: ['空闲', '就绪'], attention: ['注意'],
  inspect: ['检查', '结构'], invoke: ['操作', '触发'], act: ['操作'], action: ['操作'],
  info: ['信息'], status: ['状态'],
});
const BRIDGED_TOOL_NAME_TERM_MAX_WORDS = 3;
// 桥接工具名 → 中文别名。逐词查表后按「第 k 个说法」齐步拼成整句(mouse_click → 鼠标点击 / 鼠标单击 / 双击…),最多 4 句:
// 每个说法至少在一句里出现,整句又能吃到 v1 的整句/精确别名分。名字里一个 BRIDGED_TOOL_NAME_TERMS 的词都没有就不给别名(修前口径)。
function bridgedToolAliases(toolName) {
  const words = normalizeToolSearchText(toolName).split(' ').filter(Boolean);
  const own = (table, k) => Object.prototype.hasOwnProperty.call(table, k);
  const units = []; let anchored = false;
  for (let i = 0; i < words.length;) {
    let terms = null; let used = 1;
    for (let n = Math.min(BRIDGED_TOOL_NAME_TERM_MAX_WORDS, words.length - i); n >= 2 && !terms; n--) {
      const key = words.slice(i, i + n).join(' ');
      if (own(BRIDGED_TOOL_NAME_TERMS, key)) { terms = BRIDGED_TOOL_NAME_TERMS[key]; used = n; anchored = true; }
    }
    const w = words[i];
    const stems = [w, w.replace(/es$/, ''), w.replace(/s$/, '')].filter(Boolean);
    if (!terms) { const k = stems.find(s => own(BRIDGED_TOOL_NAME_TERMS, s)); if (k) { terms = BRIDGED_TOOL_NAME_TERMS[k]; anchored = true; } }
    if (!terms) { const k = stems.find(s => own(BRIDGED_TOOL_NAME_MODIFIERS, s)); if (k) terms = BRIDGED_TOOL_NAME_MODIFIERS[k]; }
    if (terms) units.push(terms);
    i += used;
  }
  if (!anchored) return [];
  const width = Math.min(4, Math.max(...units.map(u => u.length)));
  const out = new Set();
  for (let k = 0; k < width; k++) out.add(units.map(u => u[Math.min(k, u.length - 1)]).join(''));
  return [...out];
}
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
  // 中英混写不留空格(「读取pdf」「做个ppt」「写excel」)时整串是一个词,里面的英文词单独再记一份。
  for (const part of normalized.split(/[^\p{L}\p{N}]+|\p{Script=Han}+/u)) if (part) out.add(part);
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

// bridgedToolName:桥接工具去掉服务器前缀的名字(bridge.toolName);给了才按 BRIDGED_TOOL_NAME_TERMS 补中文别名。
function retrievalHintForTool(name, pack, bridgedToolName) {
  const exact = TOOL_RETRIEVAL_HINTS[name] || {};
  const nameWords = normalizeToolSearchText(name).split(' ').filter(Boolean);
  return {
    capabilities: [...new Set([...(exact.capabilities || []), `${pack}.${nameWords.join('.')}`])],
    aliases: [...new Set([...(exact.aliases || []), ...(bridgedToolName ? bridgedToolAliases(bridgedToolName) : [])])],
  };
}

function classifyToolPacks(message, attachments) {
  const s = String(message || '').toLowerCase();
  const packs = new Set(['core']);
  const add = (...xs) => xs.forEach(x => packs.add(x));
  if (Array.isArray(attachments) && attachments.length) add('files_read');
  if (/(文件|目录|路径|源码|代码|项目|repo|repository|file|folder|directory|source|workspace|read|读取|查看|搜索|查找|分析|审查)/i.test(s)) add('files_read');
  // 2026-10:泛化的动词(修改/编辑/更新/写入/创建/删除…)只带文件读写,不再顺带 code 包。code 包(git/依赖/审查/符号检索等
  // 12 个工具、约 2.3K token)本机 4 天 0 次使用,却被「file_edit」里的 edit、「更新」这类词带进来;而会话工具表只增不减,
  // 带进来就跟着整个会话。只有明确的代码意图(实现/修复/重构,或下一条的代码词)才装 code。
  if (/(实现|修改|编辑|写入|创建|删除|移动|复制|修复|重构|更新|落盘|撤销|回滚|检查点|implement|modify|edit|write|create|delete|move|copy|fix|refactor|update|undo|rollback|checkpoint)/i.test(s)) add('files_read', 'files_write');
  if (/(实现|修复|重构|implement|fix|refactor)/i.test(s)) add('code');
  // 「编码」多指「编码能力」或字符编码、「测试」多指「测一下」,都不再单独算代码意图(「测试」仍带 shell:跑测试要命令行);
  // 明确的「单测 / 单元测试」照旧算。
  if (/(代码|编程|bug|单测|单元测试|构建|依赖|git|commit|push|pull request|typescript|javascript|python|java|rust|go\b|npm|pnpm|yarn|编译)/i.test(s)) add('files_read', 'code');
  if (/(运行|执行|命令|终端|shell|powershell|脚本|测试|构建|安装|启动|重启|部署|run|execute|command|terminal|script|test|build|install|start|restart|deploy)/i.test(s)) add('shell');
  // 2026-10:补实时信息类说法(行情/走势/股/汇率/天气/新闻…)。修前「查一下美股这周与下周的走势」只分到 core,
  // 整个会话 36 次联网全绕 tool_invoke_read 代理(web 包 schema 合计不到 1K token)。
  if (/(联网|网页|网站|搜索网络|查新闻|新闻|最新|行情|走势|股价|股市|美股|港股|a股|汇率|天气|热搜|票房|url|https?:|web|internet|online|search the web|fetch)/i.test(s)) add('web');
  if (/(excel|word|powerpoint|pptx?|docx?|pdf|表格|电子表格|工作簿|幻灯片|演示文稿|文档排版)/i.test(s)) add('office', 'files_read', 'files_write');
  if (/(截图|桌面|窗口|鼠标|键盘|点击|屏幕|ocr|screenshot|desktop|window|mouse|keyboard|click)/i.test(s)) add('desktop');
  if (/(压缩|解压|zip|archive|unzip)/i.test(s)) add('archive', 'files_read', 'files_write');
  if (/(子代理|多代理|工作流|并行|agent|orchestrat|delegate)/i.test(s)) add('agents');
  // 61 号文 C1:Playbook / 预置流程 / 流程模板 / 操作流程 也带 skills 包(playbook_list / playbook_read / skill_list 住在那里)。
  if (/(技能|skill|playbook|预置流程|预置操作|流程模板|模板流程|操作流程)/i.test(s)) add('skills');
  if (/(mcp|连接器|工具配置|浏览器目标|browser target|connector|tool config)/i.test(s)) add('integrations');
  // 「偏好 / preference」不再单独装 memory 包:记下一条偏好用的是 core 里的 workbench_memory_propose,memory 包是关系边 /
  // 修订 / 撤销这几件维护工具;修前「这两家模型谁更强…偏好」这类话题词就把它带进来、跟着整个会话。
  if (/(记住|记忆|以后别忘|修订记忆|更正记忆|过时|关系边|remember|memorize|memory|memories|recall|outdated|supersede|contradict)/i.test(s)) add('memory');
  if (/(思考|推理|分析|对比|决策|规划|方案|权衡|think|reason|analy|compare|decide|plan|strateg)/i.test(s)) add('thinking');
  return [...packs];
}

function buildToolCatalog(tools, bridgedRoute, config) {
  return (tools || []).map(t => {
    const fn = t && t.function || {};
    const bridge = resolveBridge(bridgedRoute || {}, fn.name);
    const pack = toolPackForName(fn.name, bridgedRoute);
    const hint = retrievalHintForTool(fn.name, pack, bridge ? bridge.toolName : '');
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
  const matches = scored.map(({ x }) => ({ name: x.name, pack: x.pack, tier: x.tier, description: x.description }));
  return { ok: true, query: String(query || ''), matches, packs: packDescriptionsFor(matches) };
}
// tool_search 结果只带【命中条目所在的那几个包】的说明。修前每次都附整张 15 个包的表:实测一次检索结果 3302 B 里它占 1049 B,
// 一个会话检索几次就重复几次。整张表归 list_tools(它本来就是「不知道搜什么时先看目录」的入口)。
function packDescriptionsFor(matches) {
  const out = {};
  for (const m of Array.isArray(matches) ? matches : []) {
    const p = m && m.pack;
    if (p && !out[p] && Object.prototype.hasOwnProperty.call(TOOL_PACK_DESCRIPTIONS, p)) out[p] = TOOL_PACK_DESCRIPTIONS[p];
  }
  return out;
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

// 2026-10 代叫「叫得对」:把一个工具的 JSON Schema 压成一行参数骨架 —— `path*:string, mode?:a|b`(* 必填、? 可选)。
// 代叫不把完整说明书装进上下文,模型手里只有目录卡;骨架让它第一次就知道该传哪几个键、什么类型、哪些取值。
//   brief:目录卡用 —— 全部必填(至多 6 个)+ 至多 2 个可选,总长 ≤140 字符,超出的记成 …(+N);
//   full :代叫参数错时随错误递回(12 withToolArgsGuide)—— 至多 16 个,每个带 ≤60 字的用途说明。
// 认 pydantic 的可空写法(anyOf [T, null])、类型数组、$ref → $defs(FastMCP 的 Enum / 模型参数就是这么出的)、allOf 单包装、
// const;对象 / 数组只标 object / array<T>,不往里展开(展开就是把说明书搬回来了)。
// 返回值:'none' = 明确没有参数(properties 是空对象,也没有 $ref / allOf / 额外键这些说不清的形状);
//         ''     = 这份 schema 压不成骨架(根上是 $ref / allOf / 自由对象 / 没给)—— 调用方不加 args / argsGuide,不拿「无参」误导模型。
const TOOL_ARGS_BRIEF_CHARS = 140;
const TOOL_ARG_ENUM_VALUE_CHARS = 24;
function toolArgsResolveRef(p, root, depth) {
  let cur = p;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i += 1) {
    if (typeof cur.$ref === 'string') {
      const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(cur.$ref);
      const defs = m && root && root[m[1]];
      const next = defs && typeof defs === 'object' ? defs[m[2]] : null;
      if (!next) return cur;
      cur = next; continue;
    }
    if (Array.isArray(cur.allOf) && cur.allOf.length === 1 && !cur.type && !cur.enum) { cur = cur.allOf[0]; continue; }
    break;
  }
  return depth > 6 ? null : cur;
}
function toolArgEnumText(values) {
  const shown = values.slice(0, 5).map(v => {
    const s = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
    return s.length > TOOL_ARG_ENUM_VALUE_CHARS ? s.slice(0, TOOL_ARG_ENUM_VALUE_CHARS) + '…' : s;
  });
  return shown.join('|') + (values.length > 5 ? '|…' : '');
}
function toolArgTypeText(p0, root, depth = 0) {
  const p = toolArgsResolveRef(p0, root, depth);
  if (!p || typeof p !== 'object' || depth > 6) return 'any';
  if (Array.isArray(p.enum) && p.enum.length) return toolArgEnumText(p.enum);
  if (Object.prototype.hasOwnProperty.call(p, 'const')) return toolArgEnumText([p.const]);
  const alts = Array.isArray(p.anyOf) ? p.anyOf : (Array.isArray(p.oneOf) ? p.oneOf : null);
  if (alts && !p.type) {
    const nonNull = alts.filter(a => a && typeof a === 'object' && a.type !== 'null');
    const texts = [...new Set(nonNull.map(a => toolArgTypeText(a, root, depth + 1)))];
    return texts.length ? texts.join('/') : 'any';
  }
  let t = p.type;
  if (Array.isArray(t)) { t = t.filter(x => x !== 'null'); t = t.length === 1 ? t[0] : t.join('/'); }
  if (t === 'array') {
    const it = (p.items && typeof p.items === 'object' && !Array.isArray(p.items)) ? toolArgTypeText(p.items, root, depth + 1) : 'any';
    return it !== 'any' ? `array<${it}>` : 'array';
  }
  return (typeof t === 'string' && t) ? t : 'any';
}
function toolArgsSkeleton(schema0, mode) {
  const full = mode === 'full';
  const schema = toolArgsResolveRef(schema0, schema0, 0);
  if (!schema || typeof schema !== 'object') return '';
  const props = (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) ? schema.properties : null;
  const names = props ? Object.keys(props) : [];
  if (!names.length) {
    const opaque = !props || schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || (schema.additionalProperties && schema.additionalProperties !== false);
    return opaque ? '' : 'none';
  }
  const required = new Set((Array.isArray(schema.required) ? schema.required : []).filter(k => Object.prototype.hasOwnProperty.call(props, k)));
  const req = names.filter(n => required.has(n));
  const opt = names.filter(n => !required.has(n));
  const part = n => {
    const p = props[n] || {};
    let s = `${n}${required.has(n) ? '*' : '?'}:${toolArgTypeText(p, schema0)}`;
    if (full) {
      const d = String((toolArgsResolveRef(p, schema0, 0) || {}).description || p.description || '').replace(/\s+/g, ' ').trim();
      if (d) s += ` — ${d.length > 60 ? d.slice(0, 60) + '…' : d}`;
    }
    return s;
  };
  // 尾注:没列出来的个数,其中有必填时点明 —— 「…(+5, 3 required)」,模型就知道该去要完整说明而不是当它们可有可无。
  const tail = shownNames => {
    const hidden = names.filter(n => !shownNames.includes(n));
    if (!hidden.length) return '';
    const hiddenReq = hidden.filter(n => required.has(n)).length;
    return `…(+${hidden.length}${hiddenReq ? `, ${hiddenReq} required` : ''})`;
  };
  if (full) {
    const pick = req.concat(opt).slice(0, 16);
    const t = tail(pick);
    return pick.map(part).join('; ') + (t ? `; ${t}` : '');
  }
  // brief:必填在前、可选至多 2 个;总长(含尾注)守住 140 —— 只有第一个参数本身就超长时例外(参数名不能截,模型要原样传)。
  const order = req.slice(0, 6).concat(opt.slice(0, 2));
  const kept = [];
  for (const n of order) {
    const next = kept.concat(n);
    const t = tail(next);
    const text = next.map(part).join(', ') + (t ? `, ${t}` : '');
    if (kept.length && text.length > TOOL_ARGS_BRIEF_CHARS) break;
    kept.push(n);
  }
  const t = tail(kept);
  return kept.map(part).join(', ') + (t ? `, ${t}` : '');
}
// 检索结果统一出口:还没装进工具表的命中带上参数骨架(args)。已装的不带 —— 它的完整说明书本来就在工具表里。
// opts.loadedNames 只有模型服务商回合给(09 的 toolLoading.search);MCP / CLI 路径不知道 CLI 手里有什么,一律带。
// 与 metaToolHintsV1(requiredArgs / callHint / 待办去重)无关:那个开关仍管它自己那几样,这里默认开。
// 61-B1:排在最前的 3 个未装载命中给 full 骨架(全部参数 + 用途说明),其余仍是 brief。真机里 brief 有 41% 被截成「…(+N)」,
// 模型要么多一轮 tool_load、要么猜参数代叫;最可能被选中的那几个直接给全,文本落在 tool_result 里,不动工具表(缓存中性)。
const TOOL_SEARCH_FULL_ARGS_TOP = 3;
function withToolArgSkeletons(result, catalog, opts) {
  if (!result || !Array.isArray(result.matches) || !result.matches.length) return result;
  const loaded = (opts && opts.loadedNames instanceof Set) ? opts.loadedNames : null;
  const byName = new Map((catalog || []).map(x => [x && x.name, x]));
  let fullLeft = TOOL_SEARCH_FULL_ARGS_TOP;
  const matches = result.matches.map(m => {
    if (!m || m.args !== undefined || (loaded && loaded.has(m.name))) return m;
    const item = byName.get(m.name);
    const params = item && item.tool && item.tool.function && item.tool.function.parameters;
    const full = fullLeft > 0;
    const args = toolArgsSkeleton(params, full ? 'full' : 'brief');
    if (!args) return m;   // 压不成骨架的(根上是 $ref / 自由对象)不加,别拿「无参」误导
    if (full) fullLeft -= 1;
    return { ...m, args };
  });
  return { ...result, matches };
}
// 61-B3:桌面 MCP 里与内置工具同一件事的桥接工具(按桥接裸名)。只做目录标注:对应的内置工具在本回合目录里时,命中卡带
// preferred、排到同批未遮蔽项之后。不隐藏、不改 tier / 闸 / 分发 —— 桥接版有内置没有的能力(追加写、目录级 move/copy、
// cmd.exe 语义),模型确有需要时照样能用。内置版受工作区边界与写前检查点保护,这是首选的理由。
const BRIDGED_SHADOWED_BY_NATIVE = Object.freeze({
  read_file: 'file_read', write_file: 'file_write', edit_file: 'file_edit',
  delete_file: 'file_delete', move_file: 'file_move', copy_file: 'file_copy',
  list_directory: 'file_list', fetch: 'web_fetch', run_command: 'powershell_run',
});
function bridgedShadowNative(item, nativeNames) {
  if (!item || !item.bridged) return '';
  const raw = String(item.name || '').split('__').pop();
  const native = Object.prototype.hasOwnProperty.call(BRIDGED_SHADOWED_BY_NATIVE, raw) ? BRIDGED_SHADOWED_BY_NATIVE[raw] : '';
  return native && nativeNames.has(native) ? native : '';
}
function withShadowedBridgeHints(result, catalog) {
  if (!result || !Array.isArray(result.matches) || !result.matches.length) return result;
  const nativeNames = new Set((catalog || []).filter(x => x && !x.bridged).map(x => x.name));
  const byName = new Map((catalog || []).map(x => [x && x.name, x]));
  let any = false;
  const tagged = result.matches.map(m => {
    const native = m && bridgedShadowNative(byName.get(m.name), nativeNames);
    if (!native) return m;
    any = true;
    return { ...m, preferred: native };
  });
  if (!any) return result;
  // 稳定分区:同一批命中里未遮蔽的在前,被遮蔽的桥接项挪到后面(只在已截好的 Top-K 内重排,不动两套排序本身)。
  return { ...result, matches: tagged.filter(m => !m || !m.preferred).concat(tagged.filter(m => m && m.preferred)) };
}
// 61-A4:零命中不再只回一张空表 —— 模型分不清「措辞没对上」和「真没有这类工具」,于是换着说法连搜(真机搜「撤销/回滚」)。
const TOOL_SEARCH_EMPTY_NOTE = 'No dedicated tool matched. Try other capability words (Chinese or English) or browse with list_tools {pack}; if nothing fits, do it with the general tools you already have (e.g. powershell_run / script_run when available) or tell the user it is not supported.';
function searchToolCatalog(catalog, args, config, opts) {
  // 先分区再给骨架:full 骨架的 3 个名额先给未遮蔽项(被遮蔽的桥接项已挪到后面)。
  const result = withToolArgSkeletons(withShadowedBridgeHints(rankToolCatalog(catalog, args, config, opts), catalog), catalog, opts);
  if (result && Array.isArray(result.matches) && !result.matches.length && String(args && args.query || '').trim()) return { ...result, note: TOOL_SEARCH_EMPTY_NOTE };
  return result;
}

function rankToolCatalog(catalog, args, config, opts) {
  const query = String(args && args.query || '');
  // limit ≤ 0 / 非数字一律回默认(修前 0 → 默认、-5 → 1,同一参数两种口径)。
  const limitNum = Number(args && args.limit);
  const limit = limitNum > 0 ? Math.min(20, Math.max(1, limitNum)) : 8;
  const forceV1 = !!(opts && opts.forceV1);
  if ((!config || config.runtimeToolRetrievalV1 !== true) && !forceV1) {
    const legacySearch = () => legacyToolCatalogSearch(catalog, query, limit, Math.max(1, Number(opts && opts.legacyNameBoost) || 1));
    // 带汉字的查询不走子串匹配:中文不分词,整段说法只能原样撞上描述里的同一串字 —— 撞上的多半是噪声(「截图」只撞上
    // set_clipboard_image 描述里的「截图了一张图」),还挡掉了下面的别名排序。这类查询直接用带别名/能力词的分词排序。
    const legacy = /\p{Script=Han}/u.test(query) ? null : legacySearch();
    // 子串匹配零命中(或上面跳过了它)时,退到分词排序再试一次,而不是交回空表让模型以为没有这个工具。
    // 只交得分 > 0 的:单个汉字(「删」)切不出词,分词排序会把整张目录按 0 分垫满;一个都没得分就照旧交子串匹配的结果。
    // 不含汉字且有命中时排序与修前一致(出口另加 args 骨架,见上)。注:shadow 对比(compareToolRetrievalShadow)对这类查询是 v1 比 v1,恒一致。
    if (query.trim() && (!legacy || (Array.isArray(legacy.matches) && legacy.matches.length === 0))) {
      const v1 = rankToolCatalog(catalog, args, config, { ...(opts || {}), forceV1: true });
      const hits = (Array.isArray(v1.matches) ? v1.matches : []).filter(m => m.score > 0);
      if (hits.length) return { ...v1, matches: hits, packs: packDescriptionsFor(hits), fallback: 'alias_ranker' };
    }
    return legacy || legacySearch();
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
    // 整句别名:互相包含 +14;一字不差 +24(「截图」是 screenshot 的叫法,只是 browser_screenshot 叫法的一部分)。
    let aliasPhrase = 0;
    for (const alias of doc.item.aliases || []) {
      const a = normalizeToolSearchText(alias);
      if (!qNorm || !a) continue;
      if (qNorm === a) { aliasPhrase = 24; break; }
      if (!aliasPhrase && (qNorm.includes(a) || a.includes(qNorm))) aliasPhrase = 14;
    }
    if (aliasPhrase) { components.aliasPhrase = aliasPhrase; score += aliasPhrase; matchedOn.add('alias'); }
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
    // 同分时原生工具排在桥接工具前面(ACC 的 read_file 与原生 file_read 同叫「读取文件」时,原生的有工作区护栏、不用代理)。
    .sort((a, b) => b.score - a.score || (a.doc.item.bridged ? 1 : 0) - (b.doc.item.bridged ? 1 : 0) || a.doc.item.name.localeCompare(b.doc.item.name)).slice(0, limit);
  const loadedNames = opts && opts.loadedNames instanceof Set ? opts.loadedNames : null;
  const matches = ranked.map(r => {
    const x = r.doc.item; const blockedReason = runtimeToolBlockedReason(x, config);
    return {
      name: x.name, pack: x.pack, tier: x.tier, description: x.description,
      score: Number(r.score.toFixed(3)), matchedOn: r.matchedOn,
      loaded: loadedNames ? loadedNames.has(x.name) : undefined,
      blockedReason: blockedReason || undefined,
    };
  });
  return {
    ok: true, query, retrievalVersion: 'deterministic-v1',
    queryHash: crypto.createHmac('sha256', RUNTIME_TELEMETRY_KEY).update(qNorm).digest('hex').slice(0, 16),
    elapsedMs: Date.now() - startedAt,
    matches,
    packs: packDescriptionsFor(matches),
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
//
// v3 (2026-10) closes the network/policy gap v2 left. A real-machine replay of 52 failures still had 28 (54%) in
// `unknown` because v2 never read the STRUCTURED envelope the tools actually emit: `failClass` (web_fetch /
// http_request / http_download / web_search: dns|connect|proxy|reset|tls|timeout|aborted|http|network…), a numeric
// `statusCode`, `blocked` (SSRF / redirect guard), `argsInvalid` (truncated model arguments), `disposition`
// (plan_refused / args_invalid) and identifier-shaped codes carried in `code` or — for steward tools — in `error`
// (`not_found`, `budget_exceeded`…). It also had one false positive: web_fetch's "网站拒绝了请求(HTTP 403,可能反爬)"
// matched /拒绝/ and became permission_denied/request_authority although no user grant can help (a remote refusal is
// remote_blocked). v3 reads those fields first and keeps the text rules as the fallback. Rules are anchored to exact
// tokens / numeric statuses / error-or-message text — never to stderr or hints — so unrelated output that merely
// mentions "blocked" or "captcha" is not reclassified. The mutating-tool safety branch below still runs before every
// other rule, and nothing here retries or repairs anything.
const RUNTIME_FAILURE_CLASSIFIER_VERSION = 'deterministic-v3';
// failClass values (11-native-tools classifyFetchError / httpGetGuarded / web_search) that describe a broken
// transport: the request may or may not have reached the remote end. A mutating tool is therefore
// side_effect_unknown; a read tool is transient. (`dns` and `tls` fail before any request byte is sent and are
// handled separately; `aborted` is a user/steer interrupt, not a fault.)
const RUNTIME_FAILCLASS_TRANSPORT = new Set(['reset', 'connect', 'proxy', 'timeout', 'network']);
// Exact code / error tokens (lower-case) emitted by the native, proxy and steward tools. Equality only, no substring.
const RUNTIME_CODE_INVALID_ARGUMENTS = new Set(['invalid-arguments', 'invalid_args', 'invalid_request', 'invalid_target', 'invalid_ref', 'bad_path', 'bad_pattern', 'tier-mismatch']);
const RUNTIME_CODE_NOT_FOUND = new Set(['not_found', 'not_in_artifacts']);
const RUNTIME_CODE_BUDGET = new Set(['budget_exceeded', 'quota_exceeded']);
function classifyRuntimeToolFailure(toolName, result, meta) {
  if (!result || typeof result !== 'object' || result.ok === true || (result.ok !== false && !result.error)) return null;
  const disposition = String(meta && meta.disposition || 'executed');
  const tier = String(meta && meta.tier || 'read');
  const code = String(result.code == null ? '' : result.code).trim();
  const text = [result.errorClass, code, result.statusCode, result.error, result.message, result.detail, result.hint, result.stderr]
    .map(value => String(value == null ? '' : value).slice(0, 4000)).join(' ').slice(0, 12000);
  // v3 structured signals. `primary` is the tool's own error wording only (never stderr/hint), used by the anchored
  // text rules; the steward tools put their identifier-shaped code in `error` (`{ok:false, error:'not_found', message}`).
  const primary = [result.error, result.message, result.detail].map(value => String(value == null ? '' : value).slice(0, 2000)).join(' ');
  const failClass = String(result.failClass == null ? '' : result.failClass).trim().toLowerCase().slice(0, 24);
  const statusNum = Number(result.statusCode);
  const httpStatus = Number.isInteger(statusNum) ? statusNum : 0;
  const errToken = typeof result.error === 'string' && /^[a-z][a-z0-9_-]{2,40}$/i.test(result.error.trim()) ? result.error.trim().toLowerCase() : '';
  const tokenIs = tokens => tokens.has(code.toLowerCase()) || tokens.has(errToken);
  const mutating = tier !== 'read';
  const timedOut = result.timedOut === true || /timeout|timed out|etimedout|连接.{0,6}超时|超时/i.test(text);
  const interrupted = result.interrupted === true || result.steerInterrupted === true || failClass === 'aborted' || /interrupted by user steer|用户插话中断|因用户.{0,8}中断/i.test(text);
  // `request error` / `response error` is the fallback Node socket error with an empty message (11-native-tools): a
  // connection-level failure whose cause the tool could not name.
  const bareSocketError = /^(?:request|response) error$/i.test(String(result.error == null ? '' : result.error).trim());
  const transportFailure = RUNTIME_FAILCLASS_TRANSPORT.has(failClass) || (failClass === 'dns' && /当前疑似离线/.test(text)) || bareSocketError
    || httpStatus === 408 || httpStatus === 500;   // 429/502/503/504 are already matched by the text rule below (v2)
  const transientTransport = timedOut || transportFailure || /econnreset|eai_again|econnrefused|enotfound|socket hang up|network error|connection (?:error|reset|refused|timeout)|remote host closed|\b429\b|\b50[234]\b|temporar|连接.{0,6}(重置|断开)|临时.{0,6}(错误|不可用)/i.test(text);
  const mutatingAmbiguity = transientTransport || interrupted || /operation aborted|effect unknown|outcome unknown|执行结果未知|副作用未知/i.test(text);
  const nonzeroExit = /^-?\d+$/.test(code) && Number(code) !== 0;
  // A process result (non-zero exit or stderr) is the program's own output: its text must not be mistaken for a
  // tool-level HTTP/ENOENT/captcha signal.
  const processResult = nonzeroExit || (typeof result.stderr === 'string' && result.stderr.trim() !== '');
  const urlShapeRejected = /URL 无法解析|仅允许 http\/https 协议|url must start with http/i.test(primary);
  const planRefused = disposition === 'plan_refused' || /计划模式.{0,8}请先提交|请先提交\s*PLAN\s*:/i.test(primary);
  const budgetExhausted = tokenIs(RUNTIME_CODE_BUDGET) || /read budget exhausted|quota exhausted for this/i.test(primary);
  const guardBlocked = (typeof result.blocked === 'string' && result.blocked.trim() !== '') || failClass === 'blocked';
  const remoteRefused = !processResult && ((httpStatus === 401 || httpStatus === 403 || httpStatus === 451) || failClass === 'tls'
    || (guardBlocked && !urlShapeRejected)
    || /网站拒绝了请求|反爬|人机验证|验证码|\bcaptcha\b|\bcloudflare\b|just a moment|are you (?:a )?(?:human|robot)|bot (?:detection|protection|challenge)/i.test(primary));
  const pageOrHostMissing = !processResult && (httpStatus === 404 || httpStatus === 410 || failClass === 'dns' || /\benoent\b|no such file or directory/i.test(text));
  let failureClass = 'unknown', recoverableHint = false, allowedRepair = 'diagnose_only';
  // A mutating call that timed out/lost transport/was interrupted may already have changed state. This safety
  // branch intentionally precedes every "repairable" text rule: never turn an ambiguous edit/exec into retry_once.
  if (mutating && (mutatingAmbiguity || disposition === 'steer_skipped')) {
    failureClass = 'side_effect_unknown'; allowedRepair = 'stop_for_effect_check';
  } else if (!mutating && transientTransport) {
    failureClass = 'transient_read'; recoverableHint = true; allowedRepair = 'retry_once';
  } else if (code === 'not-allowed' || /应用内部数据|已禁止文件工具访问|检测到脚本.{0,50}office|office.{0,40}工具层强制|请改用现成工具|use (?:a )?supported tool/i.test(text)) {
    failureClass = 'policy_blocked'; recoverableHint = true; allowedRepair = 'use_supported_tool';
  } else if (planRefused) {
    // Plan mode refuses every non-discovery tool until a `PLAN:` message is submitted: the way out is to plan, not to retry.
    failureClass = 'policy_blocked'; recoverableHint = true; allowedRepair = 'replan';
  } else if (budgetExhausted) {
    // Per-visit / per-turn read budgets and quotas say "answer from what you have instead of retrying": nothing to repair.
    failureClass = 'policy_blocked';
  } else if (remoteRefused) {
    // Must precede permission_denied: "网站拒绝了请求(HTTP 403)" contains 拒绝 but no user grant can help. 401/403/451,
    // anti-bot/captcha wording, TLS failure, and the SSRF / redirect guard are all "this source is unusable for us".
    failureClass = 'remote_blocked'; recoverableHint = true; allowedRepair = 'use_alternative_source';
  } else if (/permission|denied|拒绝|拒绝授权|无权限|not allowed|blocked by permission/i.test(text)) {
    failureClass = 'permission_denied'; allowedRepair = 'request_authority';
  } else if (/old[_ ]?text.{0,24}(not found|missing|匹配.{0,8}(?:0|不到)|未找到)|找不到.{0,16}old[_ ]?text|expected text.{0,16}not found/i.test(text) || code === 'ambiguous') {
    // `ambiguous` = file_edit's oldText matches several places: re-read and give a longer, unique anchor.
    failureClass = 'edit_conflict'; recoverableHint = true; allowedRepair = 'refresh_then_modify';
  } else if (result.argsInvalid === true || disposition === 'args_invalid' || tokenIs(RUNTIME_CODE_INVALID_ARGUMENTS) || urlShapeRejected
    || /参数不是完整的 JSON 对象|工具调用参数被截断|control-plane tools cannot be invoked through a proxy|risk tier mismatch|tier mismatch \(bridged recheck\)/i.test(primary)
    || /invalid.{0,20}(argument|parameter|input)|schema.{0,20}(fail|invalid)|required.{0,20}(property|field)|\b[a-z_][\w.-]*\s+is\s+required\b|参数.{0,12}(错误|无效|缺少)|缺少.{0,8}(参数|字段)|unexpected.{0,8}(argument|field)/i.test(text)) {
    failureClass = 'invalid_arguments'; recoverableHint = true; allowedRepair = 'modify_arguments';
  } else if (/unknown\s+(?:shell|session|resource)(?:id)?|(?:shell|session|resource).{0,20}(?:not found|missing|不存在|已结束)|未知\s*(?:shellid|会话|资源)/i.test(text)
    || tokenIs(RUNTIME_CODE_NOT_FOUND) || pageOrHostMissing) {
    // Handles that expired, files/artifacts/observations that are gone (`not_found`, `not_in_artifacts`, ENOENT),
    // HTTP 404/410 and a DNS name that does not resolve. (A DNS failure that looks transient — EAI_AGAIN or the
    // "疑似离线" probe hint — was already taken by the transport branches above.)
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
  const limitNum = Math.floor(Number(args && args.limit));   // ≤ 0 / 非数字回默认 200(与 tool_search 同口径)
  const limit = limitNum > 0 ? Math.min(200, limitNum) : 200;
  const available = (catalog || []).filter(x => !pack || x.pack === pack)
    .slice().sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
  const page = available.slice(cursor, cursor + limit);
  const groups = {};
  // 61-B2:代叫要选对 tool_invoke_<tier>,修前 tier 只有 tool_search 给。这里只列非 read 的名字(read 是多数,省 token)。
  const tiers = {};
  for (const item of page) {
    if (!groups[item.pack]) groups[item.pack] = [];
    groups[item.pack].push(item.name);
    if (item.tier && item.tier !== 'read') (tiers[item.tier] || (tiers[item.tier] = [])).push(item.name);
  }
  const nextCursor = cursor + page.length < available.length ? cursor + page.length : null;
  return {
    ok: true, pack: pack || null, total: available.length, cursor, count: page.length, nextCursor,
    groups, tiers, availablePacks: Object.keys(TOOL_PACK_DESCRIPTIONS), packs: TOOL_PACK_DESCRIPTIONS,   // 包说明全表只在这里给(tool_search 只带命中的包)
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

// 会话头上的工具表(session.toolSchemaNames)只认工具名形状的字符串,去重、限长;不是数组 / 坏元素一律当没有。
const TOOL_SCHEMA_NAMES_MAX = 200;
function sanitizeToolSchemaNames(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const n of v) {
    if (typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(n) || seen.has(n)) continue;
    seen.add(n); out.push(n);
    if (out.length >= TOOL_SCHEMA_NAMES_MAX) break;
  }
  return out;
}

function createToolLoadingState(config, message, attachments, tools, bridgedRoute, freezeKey, opts) {
  // 2026-10 能力总闸:被设置关掉的内置桌面 MCP 工具不进目录 —— 于是 full 注入、tool_load 按名拉入、tool_search / list_tools
  // 都看不见它;冻结表里早先记下的名字按「目录里已经没有」处理(下方 current() 只输出仍在目录里的,与原生工具被关时同一条路)。
  // opts.desktopOverride 语义同 buildOpenAiTools(null = 跟随全局;09 传会话头上的 desktopTools)。
  const desktopOverride = (opts && opts.desktopOverride != null) ? opts.desktopOverride : null;
  const catalog = buildToolCatalog(dropPolicyDisabledBridgedTools(tools, bridgedRoute, config, desktopOverride), bridgedRoute, config);
  const full = config && config.toolLoadingMode === 'full';
  const activePacks = new Set(full ? Object.keys(TOOL_PACK_DESCRIPTIONS) : classifyToolPacks(message, attachments));
  // 116f: 目录里出现 steward 包 = 这是管家会话(四个 offer 面已经保证普通会话的目录里永远没有它们)。
  // 管家的工具面就是固定的 17 个,意图分类对它没有意义,而 classifyToolPacks 永远不会路由到 steward 包
  // —— 不置活跃的话管家在多数回合会一个工具都拿不到。auto 模式下这条就是管家的「按需装载豁免」。
  if (catalog.some(x => x && x.pack === 'steward')) activePacks.add('steward');
  const activeNames = new Set();
  const metaNames = new Set(['list_tools', 'tool_search', 'tool_load']);
  // 名字 → 它为什么进了工具表(starter / tool_load / proxy_promote;缺省 = 分包)。只给冻结表的追加日志分桶,不影响装载。
  const reasonOf = new Map();
  // 起手工具:目录里有、且不是桥接的才装(管家会话的目录里没有它们;被设置关掉的命令工具本来就不在目录里)。
  if (!full) for (const n of PROVIDER_STARTER_TOOLS) {
    const item = catalog.find(x => x && x.name === n);
    if (item && !item.bridged) { activeNames.add(n); reasonOf.set(n, 'starter'); }
  }
  // 106 #1 G2: 冻结仅在有会话权属的主循环启用(freezeKey = session.id);子代理/一次性调用不传,
  // 保持现状逐字节一致。
  const freeze = (appendOnlyToolSchemasEnabled(config) && typeof freezeKey === 'string' && freezeKey) ? toolSchemaFreezeFor(freezeKey) : null;
  // 2026-10:会话工具表跨重启。冻结表只在进程内存里,重启(或被 LRU 挤掉)后会话退回只按这一句话分包 —— 漏装的包要中途补,
  // 每补一次提供方的前缀缓存就整段失效;工具表顺序也和重启前不同,缓存哪怕没过期也接不上。这里在进程内冻结表还是空的时候,
  // 用会话头上记下的表(opts.restoredNames,由 09 每次变化后写回 session.toolSchemaNames)按原顺序恢复;目录里已经没有的名字
  // (桥接离线 / 被设置关掉)不恢复。
  if (freeze && !freeze.names.length) {
    const restored = sanitizeToolSchemaNames(opts && opts.restoredNames).filter(n => catalog.some(x => x && x.name === n));
    if (restored.length) {
      for (const n of restored) { freeze.nameSet.add(n); freeze.names.push(n); }
      try { logEvent({ kind: 'tool_schema_freeze', state: 'restore', sessionId: freezeKey, count: restored.length }); } catch { /* 遥测绝不阻断 */ }
    }
  }
  // O1 (hb360): auto 模式下桥接工具不按包自动注入 schema（走 tool_invoke_* 代理或 tool_load 显式拉入），
  // 避免单任务注入 100-280 个桥接 schema 导致 input 膨胀（实测均值 303K tokens）。full 模式与元工具/显式拉入不受影响。
  // O4 (hb360) 对抗验证回退: 高频白名单(file_read 始终注入)破坏 adaptive loading 的"按需注入"语义
  // (tool-loading e2e 断言 file_read 在 tool_load 前不注入);且真实任务 classifyToolPacks 已激活 files_read,
  // 白名单仅对纯闲聊任务有用(而闲聊不需要 file_read),收益不抵语义破坏,故回退。
  // 2026-10 的起手工具(PROVIDER_STARTER_TOOLS)是按另一笔账加的 —— 中途补装的缓存代价,见那张表的头注;file_read 仍不在里面。
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
      if (added.length) {
        const addedBy = {};
        for (const n of added) { const r = reasonOf.get(n) || 'classifier'; addedBy[r] = (addedBy[r] || 0) + 1; }
        logEvent({ kind: 'tool_schema_freeze', state: 'append', sessionId: freezeKey, added, addedBy, count: freeze.names.length });
      }
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
  // reason:这次装载的来由(模型调 tool_load = 'tool_load';09 的代理自动装载 = 'proxy_promote'),只进冻结追加日志。
  const load = (args, reason) => {
    const before = new Set(current().map(t => t.function.name));
    // packs/tools 收单个字符串也认;认不出的名字记下来如实交回(修前静默忽略,回 loaded:[] 的 ok:true)。
    const asList = v => (Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? [v.trim()] : []));
    const unknown = [];
    for (const p of asList(args && args.packs)) { if (TOOL_PACK_DESCRIPTIONS[p]) activePacks.add(p); else unknown.push(String(p)); }
    for (const n of asList(args && args.tools)) { if (catalog.some(x => x.name === n)) activeNames.add(n); else unknown.push(String(n)); }
    for (const x of liveList()) if (!before.has(x.name) && !reasonOf.has(x.name)) reasonOf.set(x.name, reason || 'tool_load');
    const after = current().map(t => t.function.name);
    // 61-A4:auto 模式下桥接工具不随包装载(见 liveList 头注)。修前 tool_load({packs:['desktop']}) 回 ok:true、loaded:[],
    // 模型以为装上了。这里如实点名:包里还有哪些桥接工具没装、该怎么拿(只在模型自己调 tool_load 时给,代理自动装载不需要)。
    const bridgedLeft = {};
    if (!full && reason !== 'proxy_promote') {
      for (const p of asList(args && args.packs)) {
        if (!TOOL_PACK_DESCRIPTIONS[p]) continue;
        const names = catalog.filter(x => x.bridged && x.pack === p && !activeNames.has(x.name)).map(x => x.name);
        if (names.length) bridgedLeft[p] = names.slice(0, 12).concat(names.length > 12 ? [`…(+${names.length - 12})`] : []);
      }
    }
    const hasBridgedLeft = Object.keys(bridgedLeft).length > 0;
    const hints = [];
    if (unknown.length) hints.push('这些 pack/工具名不存在;用 list_tools 看可用的 pack,或 tool_search 按用途找工具名');
    if (hasBridgedLeft) hints.push('桥接(桌面/MCP)工具不随包装载:要用时 tool_load {tools:[精确名]},或直接 tool_invoke_<tier> {name, arguments} 代叫');
    return { ok: true, loaded: after.filter(n => !before.has(n)), activePacks: [...activePacks], toolCount: after.length,
      ...(unknown.length ? { unknown } : {}), ...(hasBridgedLeft ? { bridgedNotLoaded: bridgedLeft } : {}),
      ...(hints.length ? { hint: hints.join(';') } : {}) };
  };
  const list = args => listCompactTools(catalog, args);
  // 冻结表的当前内容(按序),09 写回 session.toolSchemaNames 供重启后恢复;没开冻结时为 null。
  const frozenNames = () => (freeze ? freeze.names.slice(0, TOOL_SCHEMA_NAMES_MAX) : null);
  return { catalog, activePacks, current, list, search, shadowSearch, load, frozenNames, fullCount: catalog.length };
}

function estimateToolSchemaTokens(tools) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  // 每个 API 迭代前随整段历史估一遍,工具表多数回合一字不变 —— 走 09d 的按内容记忆(与直算逐位同值)。
  return Math.round(estimateTextTokensMemo(JSON.stringify(tools)));
}

// Decide gate for a tool call given the permission mode. Returns 'allow' | 'ask' | 'block'.
// 117m-A1(用户第六轮走查②「我已经默认线程全自动了,还是会有很多要求权限」):`auto` 档的 exec 分支
// 从「一律 ask」改成「高风险才 ask」。修前 `auto` 只放行 edit 档,exec 落到末尾的 `return 'ask'` ——
// 于是三处界面都把它叫「全自动」、管家壳的档位说明写「不再问你」,而线程每一步 script_run /
// http_request 仍旧弹权限,进收件箱、管家再起一个回合去「代批」(真机日志里 11 条
// intervention source:"steward_decision" action:"allow",两分钟一条,把每小时回合额度全吃光)。
// 高风险判据【复用既有单点】stewardToolPermanentlyExempt(06i):工具名正则 + 命令文本正则两道,
// 覆盖对外发送/支付/安装卸载/系统设置注册表/关机格式化/删除/git push。不另起一套判据 —— 那条
// 清单的纪律是「宁可误判成要人按,不可漏判成自动执行」,两个判据各写一份必然漂移。
// toolName 缺省(调用方没传)一律回落 'ask':保守优先,新调用面忘了传参不会静默放权。
// 模块方向:07 调 06i 是后向边(06i 在 manifest 里排 18,07 排 23),合法。
function nativeToolGate(mode, tier, toolName, input) {
  // v1.4.3: accept both 'bypass' (internal) and 'bypassPermissions' (CLI-native) as full-bypass
  if (mode === 'bypass' || mode === 'bypassPermissions') return 'allow';
  if (tier === 'read') return 'allow';
  if (mode === 'plan' || mode === 'dontAsk') return 'block';
  // v1.4.3: 'auto' mode — AI risk-classifier decides. In the native engine we approximate:
  // allow edit-tier (low-risk, reversible) and prompt for exec-tier.
  if (mode === 'auto' && tier === 'edit') return 'allow';
  if (mode === 'acceptEdits' && tier === 'edit') return 'allow';
  if (mode === 'auto') {
    if (!toolName) return 'ask';                                    // 调用方没给名字 = 保守问
    // 2026-10:命令是拼出来 / 编码出来 / 求值出来的(强信号,06i stewardAutoAskIndirect)也停下来问 ——
    // 字面量判据看不穿它真正要跑什么。管家对这一类不代批(13l),只能用户亲自按。
    return (stewardToolPermanentlyExempt(toolName, input) || stewardAutoAskIndirect(input)) ? 'ask' : 'allow';
  }
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
// ── 第 123 波 M1 §3.2「无人值守的 ask」(37 号文;29 号文 §10 红线二)────────────────────────────
// 定时任务派出去的回合没人守着,120 s 的决定窗口对它毫无意义 —— 用户可能几小时后才回来。
// 于是调度器(13s)在派单前后【成对】写/清这张表,把这一条会话的「等多久」换成
// config.schedulerAskWaitMinutes(默认 30 分钟,钳 [1,240];测试旗 WCW_SCHEDULER_ASK_WAIT_MS 压到毫秒)。
//
// **只改「等多久」,不改「等到了怎么判」**(子集律):到时仍然走下面那条既有的
// runAutomaticInterventionDecision(action:'deny') —— 无人值守遇 ask 永远是拒,绝不自动放行。
// 这张表也【不】参与 nativeToolGate 的任何判定:它够不着 gate,只够得着 setTimeout 的那个数。
// 表是进程内的,重启即空;调度器在 finally 里删,所以一条被换过窗口的会话不会把这个值带到
// 用户后来手动发起的回合上。
const schedulerAskWaitSessions = new Map();   // sessionId -> ms(只由 13s 写)
function schedulerAskWaitOverrideMs(schedAskSessionId) {
  const ms = Number(schedulerAskWaitSessions.get(String(schedAskSessionId || '')));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
// 128f-⑪:「等多久」的唯一判据在 04 的 permissionWaitMs;定时任务这一格在这里填上(04 拼在前面,够不着本文件)。
PermissionWaitHooks.scheduler = schedulerAskWaitOverrideMs;

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
    // 128f-⑪:调用方传进来的 timeoutMs 已经是 permissionWaitMs 的结果(09／05b);定时那一格在这里再认一次是双保险。
    const baseMs = schedulerAskWaitOverrideMs(sessionId) || promptWaitMs(timeoutMs);   // 0 = 不限时(04 promptWaitMs)
    // deadlineAt:13q 的 steward.deferred 要告诉用户「还等你多久」(存档暂停那一支延长后另算,见下)。
    const entry = { resolve: settle, sessionId, timer: null, deadlineAt: Date.now() + baseMs };
    if (pause && pause.enabled) {
      entry.timer = setTimeout(() => {
        try { if (pause.onPause) pause.onPause(requestId); } catch { /* 检查点失败不阻断 */ }
        try { onEvent({ type: 'permission_paused', requestId, toolName, tier: tier || 'exec', ttlMs: pause.ttlMs }); } catch { /* stream gone */ }
        entry.deadlineAt = Date.now() + Math.max(60000, Number(pause.ttlMs) || 2700000);   // 128f-⑪:存档暂停把窗口延长了
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
      // 123-M1:计划审批与权限请求同一条口径 —— 无人值守回合等 schedulerAskWaitMinutes,到时仍是【拒】。
    }, schedulerAskWaitOverrideMs(sessionId) || promptWaitMs(timeoutMs));   // 0 = 不限时(04 promptWaitMs)
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

// 58 号方案批 1:04i 协议登记表要用的四个环内工具在这里一次填好 —— 04i 直接引用它们会被拽进唯一大 SCC(见 04i 头注)。
// 单文件加载即执行,早于任何一次请求。
Object.assign(ProviderWireHooks, { makeId, redact, repairProviderHistoryPairing, repairProviderHistoryToolArgs });

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
    return { kind: 'path', basename: path.win32.basename(String(pathKey)) }; // win32:模型给的是 Windows 路径,\ 与 / 都认,非 Windows 主机上也只取尾段
  }
  if (name === 'powershell_run') {
    const cmd = String(input.command || '');
    return { kind: 'cmd', basename: cmd.slice(0, 40) || 'powershell' };
  }
  if (/^tool_invoke_/.test(name)) {
    return { kind: 'proxy', basename: String(input.name || '') };
  }
  return { kind: 'path', basename: pathKey ? path.win32.basename(String(pathKey)) : '' };
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

// One streaming chat/completions call. Emits assistant_delta / thinking_delta / raw_line live; returns
// { text, reasoning, toolCalls:[{id,name,rawArgs}], finishReason, httpError, toolsRejected }.
// v1.0-S6 (B): pre-first-byte failures are surfaced structurally so the caller can decide failover:
//   • a caught fetch throw BEFORE any body byte → { transportError, transportReason:<'connect'|'tls'>, ... }
//     (only when failover-eligible; a non-eligible throw — e.g. an AbortError — is re-thrown to the caller);
//   • a non-ok response whose status is 502/503/504 → the returned httpError object also carries
//     { failoverStatus:<502|503|504> } so the caller can advance. A throw that happens AFTER streaming has
//     started still propagates normally (caller's error path; no failover — 防重放).
// 协议(58 号批 1):请求体的形状与流式事件语法都住在 04i 的协议登记表 —— 这里只管传输:发请求、首字节前的传输失败与
// failover 判定、400 归因(工具被拒 / 超窗 / stream_options)、SSE 分帧(空行分事件、多行 data: 拼接、[DONE])、raw_line;
// 每一帧交给 protocol.createStreamDecoder 的解码器,非流式回体交给 protocol.decodeCompletion。调用方(09/08)显式传
// protocol;没传(老调用点、单测)时按请求体形状认(Responses 用 input 项,chat 用 messages)。
async function openAiStreamOnce({ chatUrl, headers, body, ctrl, onEvent, markUsage, rawSeqRef, touch, protocol }) {
  const wire = protocol || providerWireProtocolForBody(body);
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
    // 例外:报文带【确凿】的超窗信号(OpenAI 的 code context_length_exceeded / "maximum context length")时超窗优先。
    // OpenAI 的超窗报文会写 "…11000 in the functions. Please reduce the length of the messages or functions",
    // 按下面的 tools-first 顺序会被当成「工具被拒」:整回合去掉工具重打、永远不压缩。tools 拒绝报文不会带这两个短语。
    const definiteOverflow = /context_length_exceeded|maximum context length/i.test(t) && isContextOverflowError('HTTP 400: ' + t);
    if (definiteOverflow) {
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, contextOverflow: true, text: '', reasoning: '', toolCalls: [] };
    }
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
    // 58 号批 2:协议内的兼容重打(Anthropic:思考块签名校验失败 → 去掉思考块;网关不认 thinking / output_config 等 → 去掉点名字段)。
    // chat / responses 恒返回 null,走下面原有的 stream_options 分支,行为不变。
    const retryBody = wire.retryOn400(body, t);
    if (retryBody) {
      res = await doFetch(retryBody);
    } else if (body.stream_options && /stream_options|include_usage|unsupported|unknown|not\s*support/i.test(t)) {
      // 不再认裸 invalid:OpenAI 系所有 400 的 type 都是 invalid_request_error,认它等于把每个注定失败的 400
      // 都剥 stream_options 白打第二遍。真拒收 stream_options 的端点会点名它(或说 unsupported / unknown)。
      // Some servers reject stream_options — retry once without it before failing.
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
    // 「工具被拒」只在 400 / 422(请求体校验类)时才有意义:修前对【所有】非 ok 状态都按 /tool|function/ 打标,
    // 一发 500 的正文里带 "function dispatcher" 就让 09 整回合去掉工具重打、回合还报 ok:true。
    const toolsRejectedStatus = Boolean(res && (res.status === 400 || res.status === 422));
    // Retry-After(429 / 503 常带;秒或 HTTP 日期,封顶 30 s):带出给调用方的退避取 max(自己的退避, 它)。没有 / 认不出不带这个键。
    const retryAfterMs = res && res.headers && typeof res.headers.get === 'function' ? providerRetryAfterMs(name => res.headers.get(name), Date.now()) : 0;
    return { httpError: `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 500)) : ''}`, toolsRejected: toolsRejectedStatus && /tool|function/i.test(d), failoverStatus, ...(retryAfterMs > 0 ? { retryAfterMs } : {}), text: '', reasoning: '', toolCalls: [] };
  }
  // Non-streaming fallback: single JSON body. The protocol decoder normalizes it to the same
  // { text, reasoning, toolCalls } shape so every caller is protocol-agnostic.
  // 无视 stream:true、直接回一整份 application/json 的网关也走这里:按 SSE 分帧读它一行 data: 都找不到,
  // 修前返回空回答(工具调用、正文全丢)。content-type 声明了 event-stream 的仍按流读。
  const contentType = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '');
  const jsonBody = /\bjson\b/i.test(contentType) && !/event-stream/i.test(contentType);
  if (!res.body || typeof res.body.getReader !== 'function' || jsonBody) {
    const j = await res.json().catch(() => null);
    const d = wire.decodeCompletion(j, { requestModel: body.model });
    // 回体本身装着失败(200 + 顶层 error、Responses status:'failed'、Anthropic type:'error' / refusal):与流式分支一致地报 httpError。
    // 修前这里把 failed / failedDetail 全丢了,落成「空回复」,真因(额度用尽 / 拒答 / 服务端报错)用户看不到。用量照记(失败那一发也花了钱)。
    if (d.usage) markUsage(d.usage);
    if (d.failureText) {
      return { text: d.text, reasoning: d.reasoning, finishReason: 'error', toolCalls: [], httpError: redact(String(d.failureText).slice(0, 500)), providerResponseId: d.responseId };
    }
    // E6: surface reasoning before content, matching the streaming order (a non-streaming endpoint's reasoning
    // chain used to be invisible in the UI).
    if (d.reasoning) onEvent({ type: 'thinking_delta', text: d.reasoning });
    if (d.text) onEvent({ type: 'assistant_delta', text: d.text });
    return { text: d.text, reasoning: d.reasoning, toolCalls: d.toolCalls, finishReason: d.finishReason, providerResponseId: d.responseId, ...(d.providerBlocks ? { providerBlocks: d.providerBlocks } : {}) };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', done = false;
  const wireDecoder = wire.createStreamDecoder({ onEvent, markUsage, requestModel: body.model });
  // Process ONE decoded SSE event object (already JSON-parsed): raw_line first, then the protocol's event grammar.
  // Returns true when this event terminates the stream (responses' completed/incomplete/failed; chat keeps
  // relying on the `[DONE]` sentinel inside handleEventBlock).
  const processEvt = (evt, rawStr) => {
    onEvent({ type: 'raw_line', line: rawStr, seq: rawSeqRef.n++ });
    return wireDecoder.feed(evt);
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
    let r;
    try { r = await reader.read(); }
    catch (e) {
      // 流中途断线:undici 抛的是 TypeError('terminated'),真因(other side closed / UND_ERR_SOCKET / ECONNRESET)只挂在 e.cause。
      // 把它并进 message(原错误对象照旧上抛,name / cause / 栈都在):回合的 errorMsg 与 errorClass 才看得出这是掉线。
      // 中止(用户 Stop / 看门狗)原样上抛,09 靠 e.name === 'AbortError' 认它。
      if (e && e.name !== 'AbortError' && e.cause) { try { e.message = providerThrownErrorText(e); } catch { /* 只读 message:保持原样 */ } }
      throw e;
    }
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
  if (!done && buf.trim()) done = handleEventBlock(buf);
  const out = wireDecoder.finish();
  // 截断的流:连接干净地关了,却既没有终止信号([DONE] / responses 的 completed·incomplete·failed / anthropic 的
  // message_stop)也没有 finish_reason —— 上游中途断了。修前半截回答被当作完整的成功回复落盘;现在走 httpError
  // (不带状态码,调用方不会重打,防重放)。有 finish_reason 的(个别网关省掉 [DONE])照旧算完整。
  if (!done && !out.httpError && !out.finishReason) {
    out.httpError = 'stream ended unexpectedly (connection closed before a finish_reason or end-of-stream marker)';
  }
  return out;
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
function hasInterruptingSteer(reg) {
  // Legacy internal callers can still enqueue strings. API additions use explicit delivery modes.
  return !!(reg && Array.isArray(reg.steerQueue) && reg.steerQueue.some(item => typeof item === 'string' || item.mode === 'interrupt'));
}

async function drainSteerQueue(reg, session, onEvent) {
  if (!reg || !Array.isArray(reg.steerQueue) || reg.steerQueue.length === 0) return 0;
  const items = reg.steerQueue.splice(0, reg.steerQueue.length);
  for (const text of items) {
    const t = String((typeof text === 'string' ? text : text.text) || '');
    session.providerHistory.push({ role: 'user', content: '[用户插话] ' + t });
    session.messages.push({ role: 'user', content: t, turnSeq: session.turnSeq, steered: true, createdAt: nowIso() });
    try { onEvent({ type: 'steered', text: t }); } catch { /* stream gone */ }
  }
  await saveSession(session);
  return items.length;
}

// v0.9-S6 (子代理): run a self-contained SUB-TURN for an orchestrate_agents node. It is a miniature of runOpenAiTurn's
// tool loop, deliberately WITHOUT: plan mode, steering, session.messages/providerHistory writes, and (禁嵌套) the
// agent tools in its own tool set. Key isolation properties:
//   • independent `subHistory` — the sub-turn NEVER reads or writes the parent's session.providerHistory, so
//     the parent's pairing铁律 is untouched (the parent sees exactly one orchestrate_agents tool_call ↔ one envelope);
//   • system prompt = a sub-agent identity variant + the SAME capability layers (reuse buildProviderSystemPrompt),
//     with the first user message = the delegated task;
//   • tool set filtered by toolTier (read/edit/exec) AND with the agent tools suppressed (noAgentTools) — a
//     sub-agent can therefore never launch another sub-agent (double guard: the tools aren't offered here AND
//     the loop below refuses such a call if the model somehow emits one);
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
  if (iso.path && await agentWorktreePathOwned(iso.path)) {
    try { await gitExec(repoRoot, ['worktree', 'remove', '--force', iso.path], 60000); iso.path = ''; } catch {}
  }
  await saveAgentRun(run);
  return { ok: true, commit: iso.commit };
}
// 这个 worktree 路径是不是如意自己的 agent-worktrees 目录底下的。先按词法比;不在的话再按 realpath 比 ——
// 3.0 改名前起的 run 落盘的是旧前缀 ~/.win-claude-workbench/agent-worktrees/…,迁移后那是一个指回新目录的联接,
// 只按词法比会认成「外面的目录」,于是 worktree 永远不清。
async function agentWorktreePathOwned(p) {
  const target = path.resolve(String(p || ''));
  const root = path.resolve(paths.agentWorktrees);
  if (pathWithinRoot(target, root)) return true;
  try { return pathWithinRoot(await fsp.realpath(target), await fsp.realpath(root)); } catch { return false; }
}
async function cleanupAgentWorktree(isolation) {
  if (!isolation || !isolation.path) return;
  const worktreePath = path.resolve(isolation.path);
  if (!(await agentWorktreePathOwned(worktreePath))) return;
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
// Permission modes passed straight to the CLI: 'bypass' skips all asking, 'auto' is the CLI's own built-in
// risk classifier (v1.4.3, documented above at runClaudeTurn's usePermissionBridge computation), and 'plan'
// never executes a mutating tool in the first place. 'default'/'acceptEdits' would block on a prompt nobody
// can answer in a one-shot print-mode node, so they go through claudeSubagentPermission below.
const CLAUDE_SUBAGENT_PASSTHROUGH_MODES = new Set(['bypass', 'auto', 'plan']);
// 2026-10 拍板「两引擎都按权限档拒绝」:修前 default/acceptEdits 在 edit/exec 档被抬成 bypass —— 用户选了「每步都问」,
// 工作流里的 Claude 节点却全自动跑,而 OpenAI 路径同档是拒绝(runSubAgentCore 里 nativeToolGate !== 'allow' → 拒绝结果)。
// 现在与 nativeToolGate 同一条判据:default / dontAsk 只放 read 级,acceptEdits 再放 edit 级,exec 级(Bash/MCP)一律拒。
// CLI 侧用 dontAsk 落实 —— 不在 --allowed-tools 里的工具直接拒、不弹窗,子进程不会卡在没人按的那一步。
// capped=true 表示白名单就是授权本身(参数阶梯不能丢它,exec 档也不挂桥接 MCP:挂上去也全被拒)。
// 节点档位的硬上限(deny):--allowed-tools 在 auto / bypass 下不是硬边界(实测 auto 档 read 节点照样能 Write / PowerShell),
// 而 OpenAI 路径的 tierFilter 不管什么档都按节点档位封顶。所以 read / edit 档另给 --disallowed-tools,把改文件、跑命令、
// 起子代理、对外发布 / 定时这类内建工具从模型手里拿掉(实测 auto 与 bypassPermissions 下都生效)。用拒绝清单而不是
// --tools 允许清单,是为了兼容还不认 --tools 的旧版 CLI;exec 档不封。
const CLAUDE_SUBAGENT_EXEC_TOOLS = ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Task', 'Agent', 'Workflow', 'TaskStop',
  'SendMessage', 'PushNotification', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'Artifact', 'ArtifactData',
  'ArtifactComments', 'DesignSync', 'EnterWorktree', 'ExitWorktree'];
const CLAUDE_SUBAGENT_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const CLAUDE_SUBAGENT_TIER_DENY = {
  read: [...CLAUDE_SUBAGENT_EDIT_TOOLS, ...CLAUDE_SUBAGENT_EXEC_TOOLS],
  edit: CLAUDE_SUBAGENT_EXEC_TOOLS,
  exec: [],
};
const CLAUDE_SUBAGENT_TIER_RANK = { read: 0, edit: 1, exec: 2 };
function claudeSubagentPermission(requestedMode, tier, roleTools) {
  const declared = (Array.isArray(roleTools) && roleTools.length) ? roleTools : CLAUDE_SUBAGENT_TIER_TOOLS[tier];
  const deny = CLAUDE_SUBAGENT_TIER_DENY[tier] || [];
  if (CLAUDE_SUBAGENT_PASSTHROUGH_MODES.has(requestedMode)) return { mode: requestedMode, tools: declared, deny, capped: false };
  // 白名单上限取「档位许可」与「节点档位」里更窄的那个:acceptEdits + read 节点也不许 Write。
  const modeTier = requestedMode === 'acceptEdits' ? 'edit' : 'read';
  const ceiling = CLAUDE_SUBAGENT_TIER_TOOLS[CLAUDE_SUBAGENT_TIER_RANK[tier] < CLAUDE_SUBAGENT_TIER_RANK[modeTier] ? tier : modeTier];
  const base = declared.length ? declared : ceiling; // exec 档的空清单 = 不限 → 收到该档的上限
  return { mode: 'dontAsk', tools: base.filter(t => ceiling.includes(t)), deny, capped: true };
}

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
  if (!fakeClaude && (!claude || !(await existsExecutableAsync(claude)))) {   // 128f-⑬:子代理入口不钉事件循环
    // 61-C6:修前只回一句「未找到」,模型(和用户)不知道找的是哪、该怎么办 —— 真机上 claude.cmd 没装,模型只能猜。
    // 走到这里的是指定了 engine:'claude' 的节点,或会话里没有可用的模型服务商;provider 节点走 HTTP,不需要 Claude CLI。
    // 修法写进 error 本身:节点结果往上只带 error(编排信封、工作流节点卡都读它),另起的 hint 字段到不了模型。
    const where = claude ? `找过 ${claude}` : '没有配置 claudePath,PATH 里也找不到 claude';
    return { ok: false, error: `Claude CLI 未找到(${where}),无法以 Claude 引擎运行该节点。可以去掉该节点的 engine:'claude'(或不指定引擎)让它经模型服务商运行;或请用户在设置里填 Claude Code 的路径(claudePath)/安装 Claude Code 后重试`,
      iters: 0, toolCalls: 0 };
  }
  const role = roleDefinition || null;
  const tier = (toolTier === 'edit' || toolTier === 'exec') ? toolTier : 'read';
  const subModel = String(model || (role && role.models && role.models.claude !== 'inherit' && role.models.claude) || '').trim();

  const roleMode = role && role.permissionMode && role.permissionMode !== 'inherit' ? role.permissionMode : '';
  // 线程 / 工作流下发的只做计划档压过角色自带的档(与 OpenAI 路径 08 runSubAgentCoreBody 同一条优先级)。
  const requestedMode = permModeOverride === 'plan' ? 'plan' : (roleMode || permModeOverride || config.permissionMode || 'default');
  const grant = claudeSubagentPermission(requestedMode, tier, role && role.claudeTools);
  const effMode = grant.mode;

  // Keep the print-mode process input channel open. Claude's documented stream-json input accepts additional
  // user envelopes while a turn is running, which lets the workflow orchestrator steer a long Claude node
  // directly instead of storing a note that only downstream nodes could see after it was already too late.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  const pm = claudePermissionMode(effMode); if (pm) args.push('--permission-mode', pm);
  if (subModel && subModel !== 'inherit') args.push('--model', subModel);
  if (config.claudeThinkingEffort) args.push('--effort', config.claudeThinkingEffort);
  if (grant.tools.length) args.push('--allowed-tools', grant.tools.join(','));
  if (grant.deny.length) args.push('--disallowed-tools', grant.deny.join(',')); // 节点档位硬上限,下面的命令行阶梯永不丢它
  const turnBudget = Number(maxIters) || (role && role.budgets && role.budgets.claude) || 0;
  if (turnBudget > 0) args.push('--max-turns', String(Math.min(300, Math.round(turnBudget))));
  // DAG subagents do not inherit the main turn's append prompt, so give them the same final language rule.
  // 2026-10:角色提示词(role.prompt)也走这里 —— 修前 Claude 节点只带语言政策,Reviewer 不改文件、Verifier 不改产品代码、
  // Critic 默认怀疑这些靠提示词立的规矩在 Claude 引擎下全丢(OpenAI 路径 runSubAgentCoreBody 一直把它放进系统提示)。
  // 下面的命令行阶梯若丢掉 --append-system-prompt,角色提示改放进首条用户消息(stdin,不受命令行长度限制),不会丢。
  const roleBrief = role && role.prompt ? `角色：${role.label || role.id}\n${role.prompt}` : '';
  let roleBriefInTask = false;
  args.push('--append-system-prompt', appendResponseLanguagePolicy(roleBrief ? roleBrief + '\n\n' : '', config, 0, task));
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
  const mcpConfigPath = (tier === 'exec' && !grant.capped) ? await generateAgentNodeMcpConfig(subagentId, config.mcpCommandMode, roleMcpServers) : '';
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);

  // cmd8191 防线(子代理): 子代理 args 小(无技能索引),但自定义 role.claudeTools/超长路径仍可能顶爆 cmd 上限。
  // 降级阶梯: ① 先把角色提示挪进首条用户消息,仍超再丢整条 --append-system-prompt(语言政策) ② 非 plan 模式丢 --allowed-tools
  // (bypass/auto 下它不是硬安全边界——bypass 跳过一切许可,见上方分级注释;plan 模式与按档收紧的 dontAsk 下它就是授权,不丢)
  // ③ 仍超 → 明确报错(分类器把「命令行太长。」列为 definitive,不会无谓重试 3 次)。
  {
    const guardCmd = fakeClaude ? process.execPath : claude;
    const guardBudget = cmdLineBudgetFor(guardCmd);
    if (guardBudget > 0 && spawnCmdLineLength(guardCmd, args) > guardBudget) {
      const pi = args.indexOf('--append-system-prompt');
      // ①a 先只把角色提示挪进首条用户消息(角色提示可长达 8000 字,是最常见的超预算原因),语言 / 工程政策留在 argv;
      // ①b 仍超才整条丢掉(修前一步就整条丢,语言政策跟着没了)。
      if (pi >= 0 && roleBrief) { args[pi + 1] = appendResponseLanguagePolicy('', config, 0, task); roleBriefInTask = true; }
      if (pi >= 0 && spawnCmdLineLength(guardCmd, args) > guardBudget) args.splice(pi, 2);
      if (spawnCmdLineLength(guardCmd, args) > guardBudget && effMode !== 'plan' && !grant.capped) {
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
    try { child.stdin.write(JSON.stringify(buildUserEnvelope((roleBriefInTask ? roleBrief + '\n\n' : '') + String(taskForAttempt || ''))) + '\n', 'utf8'); } catch { /* ignore */ }
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
    // 117q-B1(30 号文 §4.1):与 05-claude-engine.js 逐字节相同的旧缺陷——走 createNdjsonLineFeeder 而非逐块
    // toString,chunk 边界不保证落在字符边界上,被切开的 CJK 字节不能各自独立解码。
    const stdoutFeeder = createNdjsonLineFeeder(consumeLine);
    child.stdout.on('data', chunk => { stdoutFeeder.push(chunk); });
    let settled = false;
    const finish = exitCode => { if (settled) return; settled = true; clearInterval(watchdog); clearInterval(steerTimer); closeStdin(); stdoutFeeder.flush(); currentChild = null; resolve({ exitCode, stderrText, assistantText, toolCallCount, resultOk, resultText, gotResult, resultUsage, resultCostUsd, msgBillInMax, msgBillOutMax }); };
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
  // P2-18(30号文§3 总表): ledgerCachedIn —— 同一批次三处「Claude 引擎从不写 cachedInTok」缺口之一,累加口径
  // 与 05-claude-engine.js 的主回合读法对齐(cache_read_input_tokens + cache_creation_input_tokens);只在
  // 「信任 result 帧」分支累加(与 ledgerIn/ledgerOut 同一 FIELD-LEVEL source select,msg_usage 兜底帧没有
  // cache 字段)。费用计算不受影响(claudeCostFields 走 CLI costUsd,不经 cachedInTok 定价路径)。
  // hunt2-engines#2:ledgerIn 记账本口径(输入 + 缓存读 + 缓存创建,与 05 主回合 recordTurnUsage 同一归一),
  // ledgerRawIn 留 CLI 原始 input_tokens 只给 claudeCostFields 定价(费用算法不变)。
  let ledgerIn = 0, ledgerRawIn = 0, ledgerOut = 0, ledgerCachedIn = 0, ledgerCostUsd = NaN, ledgerEstimated = false;
  try {
    // 架构还债批 2·A:重试骨架走 04h 的 withTransientRetry(与 08 的 OpenAI 子回合同一份)。本处口径原样:总共至多
    // MAX_ATTEMPTS 次(= MAX_ATTEMPTS-1 次重试);每次尝试前查 killed;失败先记账与 last*,再由 classifyClaudeSubagentFailure
    // 裁决;重试前发 retry 事件,再睡 min(2000, 300·attempt)(可被中止截断)。attempt = 本次之前已用掉的重试数 + 1。
    let okText = null, okToolCalls = 0, retryReason = '';
    await withTransientRetry({
      maxRetries: MAX_ATTEMPTS - 1,
      isAborted: () => killed,
      signal: ctrl && ctrl.signal,
      // Bounded backoff an abort can cut short (the same abortableDelay as runSubAgentCore's transient-retry sleep).
      backoffMs: attempt => Math.min(2000, 300 * attempt),
      attempt: async () => {
        const res = await runOnce();
        try {
          // FIELD-LEVEL source select (保守语义): trust the result frame's usage only when a field is actually
          // populated (>0). A result frame carrying an empty usage:{} must NOT record a bogus 0 — fall back to
          // this attempt's msg_usage max (帧内已去重) and flag the row estimated. Zero on both sides = nothing
          // billable this attempt.
          const ru = res.resultUsage;
          const ruIn = ru ? (Number(ru.input_tokens) || 0) : 0, ruOut = ru ? (Number(ru.output_tokens) || 0) : 0;
          const ruCachedIn = ru ? (Number(ru.cache_read_input_tokens) || 0) + (Number(ru.cache_creation_input_tokens) || 0) : 0;
          if (ruIn > 0 || ruOut > 0) { ledgerIn += ruIn + ruCachedIn; ledgerRawIn += ruIn; ledgerOut += ruOut; ledgerCachedIn += ruCachedIn; }
          else if ((Number(res.msgBillInMax) || 0) > 0 || (Number(res.msgBillOutMax) || 0) > 0) {
            ledgerIn += Number(res.msgBillInMax) || 0; ledgerRawIn += Number(res.msgBillInMax) || 0; ledgerOut += Number(res.msgBillOutMax) || 0; ledgerEstimated = true;
          }
          if (Number.isFinite(res.resultCostUsd)) ledgerCostUsd = (Number.isFinite(ledgerCostUsd) ? ledgerCostUsd : 0) + res.resultCostUsd;
        } catch { /* never let accounting break the attempt */ }
        return res;
      },
      classify: (res, { retries }) => {
        const attempt = retries + 1;
        const finalText = (res.resultText || res.assistantText).trim();
        const ok = !killed && res.exitCode === 0 && res.resultOk && !!finalText;
        if (ok) { okText = finalText; okToolCalls = res.toolCallCount; return 'done'; }
        lastFinalText = finalText; lastToolCalls = res.toolCallCount;
        lastErr = killed ? '节点已中止或空闲超时' : (String(res.stderrText || '').trim().slice(0, 2000) || finalText || `claude 退出码 ${res.exitCode}`);
        const cls = classifyClaudeSubagentFailure({ killed, exitCode: res.exitCode, stderrText: res.stderrText, assistantText: res.assistantText, toolCallCount: res.toolCallCount, gotResult: res.gotResult, resultOk: res.resultOk, resultText: res.resultText });
        if (killed || !cls.retry || attempt >= MAX_ATTEMPTS) return 'stop';
        // 45c:over_window → 缩载后新鲜重试(一次性 spawn 无 resume,超窗 = 任务载荷本身过大;cap 60K 字符)。
        // 45f P3-7:任务本就不超 60K 时缩无可缩(超窗根因是系统提示/schema),重试必败 —— 不再白烧一次 spawn。
        if (cls.reason === 'over_window') {
          const raw = String(task || '');
          if (overWindowShrunk || raw.length <= 60000) return 'stop';
          overWindowShrunk = true;
          taskForAttempt = raw.slice(0, 60000) + `\n\n…(原任务 ${raw.length} 字符,上次因上下文超限失败已截断;请聚焦完成可达部分)`;
        }
        retryReason = cls.reason;
        return 'retry';
      },
      onRetry: (res, attempt) => {
        onEvent({ type: 'subagent', id: subagentId, state: 'retry', attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, reason: retryReason, error: String(res.stderrText || '').trim().slice(0, 500) || `claude 退出码 ${res.exitCode}` });
      },
    });
    if (okText !== null) {
      onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, resultChars: okText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
      return { ok: true, result: okText, iters: 1, toolCalls: okToolCalls };
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
        const { provider: claudeProvider, cost, currency, costTrusted } = claudeCostFields(config, ledgerRawIn, ledgerOut, ledgerCostUsd);
        appendUsageLedger({
          sessionId: parentSession.id, engine: 'claude', provider: claudeProvider,
          // A workflow node can pass model:'inherit' straight through (subModel === 'inherit'); the model that
          // actually ran is then config.model — record that, never the literal 'inherit'.
          model: (subModel && subModel !== 'inherit') ? subModel : (config.model || ''), inTok: ledgerIn, outTok: ledgerOut,
          cachedInTok: ledgerCachedIn, cost, currency, costTrusted, estimated: ledgerEstimated, turnSeq: parentSession.turnSeq,
          kind: 'subagent', agentKey, subagentId,
        });
        // 29c: 用量随事件上抛 —— DAG 节点的 nodeEvent 借此把 token/成本累进 run.usageTotals(前端画布迷你条
        // 与运行卡 chip 早已防御性读这些字段,"后端并行落地中"说的就是这里)。与 ledger 同源同值。
        onEvent({ type: 'subagent_usage', id: subagentId, agentKey, inTok: ledgerIn, outTok: ledgerOut, cost, currency, estimated: ledgerEstimated });
      }
    } catch { /* accounting must never break the sub-agent */ }
  }
}
