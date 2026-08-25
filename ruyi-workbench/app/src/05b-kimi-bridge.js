// Kimi Code integration. Turns use the official ACP JSON-RPC/NDJSON protocol; the local Server API remains
// operation-scoped for native compaction, and the documented wire transcript supplements ACP's usage update
// with exact compaction/failure state. A separate ACP process is kept for the whole Ruyi turn so reverse RPC
// (permissions/questions) and queued follow-up steering share one live native Kimi session.
const kimiBridgeState = { child: null, port: 0, token: '', starting: null, signalHooked: false, modelWindows: new Map(), modelsAt: 0 };

function kimiCodeHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function kimiHttp(port, token, method, pathname, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  const payload = raw ? safeJsonParse(raw) : null;
  if (!response.ok) {
    const detail = payload && (payload.msg || payload.message || payload.detail);
    throw new Error(`Kimi Server HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (payload && Number(payload.code) !== 0) throw new Error(payload.msg || payload.message || `Kimi Server code ${payload.code}`);
  return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

async function ensureKimiServer(config) {
  if (kimiBridgeState.port && kimiBridgeState.token) {
    try {
      await kimiHttp(kimiBridgeState.port, kimiBridgeState.token, 'GET', '/api/v1/sessions');
      return kimiBridgeState;
    } catch { /* restart below */ }
  }
  if (kimiBridgeState.starting) return kimiBridgeState.starting;
  kimiBridgeState.starting = (async () => {
    const tokenFile = path.join(kimiCodeHome(), 'server.token');
    let token = '';
    try { token = String(await fsp.readFile(tokenFile, 'utf8')).trim(); } catch { /* login/server may create it */ }
    const driver = selectedAgentCli({ ...config, agentCliType: 'kimi' });
    if (!driver.path || !probeAgentCliLauncher(driver.path)) throw new Error('未检测到 Kimi Code CLI');
    const port = await freeLoopbackPort();
    const launch = prepareAgentCliSpawn('kimi', driver.path, ['web', '--port', String(port), '--no-open', '--log-level', 'warn']);
    const child = cp.spawn(launch.command, launch.args, {
      cwd: normalizeCwd(config.defaultWorkspace, os.homedir()), env: process.env,
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], ...launch.opts,
    });
    child.on('error', () => {});
    kimiBridgeState.child = child;
    kimiBridgeState.port = port;
    if (!kimiBridgeState.signalHooked) {
      kimiBridgeState.signalHooked = true;
      // startServer owns the actual process.exit signal handlers. This listener only closes the direct
      // Node child first; spawning taskkill from process 'exit' is unsafe in libuv's closing phase.
      const closeOnSignal = () => { try { if (kimiBridgeState.child) kimiBridgeState.child.kill(); } catch { /* ignore */ } };
      process.once('SIGINT', closeOnSignal);
      process.once('SIGTERM', closeOnSignal);
    }
    let lastError = null;
    for (let i = 0; i < 80; i++) {
      if (!token) { try { token = String(await fsp.readFile(tokenFile, 'utf8')).trim(); } catch { /* retry */ } }
      if (token) {
        try {
          await kimiHttp(port, token, 'GET', '/api/v1/sessions');
          kimiBridgeState.token = token;
          return kimiBridgeState;
        } catch (error) { lastError = error; }
      }
      if (child.exitCode != null) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    try { if (child.pid) killChildTree(child.pid); } catch { /* ignore */ }
    kimiBridgeState.child = null; kimiBridgeState.port = 0; kimiBridgeState.token = '';
    throw lastError || new Error('Kimi Server 启动超时；请先运行 kimi login');
  })();
  try { return await kimiBridgeState.starting; } finally { kimiBridgeState.starting = null; }
}

async function stopKimiServer() {
  const child = kimiBridgeState.child;
  kimiBridgeState.child = null; kimiBridgeState.port = 0; kimiBridgeState.token = '';
  if (!child || child.exitCode != null) return;
  await new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      try { if (child.pid) killChildTree(child.pid); } catch { /* ignore */ }
      done();
    }, 2000);
    child.once('close', done);
    try { child.kill(); } catch { done(); }
  });
}

async function kimiApi(config, method, pathname, body) {
  const bridge = await ensureKimiServer(config);
  return kimiHttp(bridge.port, bridge.token, method, pathname, body);
}

async function syncKimiTurnPreferences(config) {
  const effort = String(config && config.claudeThinkingEffort || '');
  if (!['low', 'high', 'max'].includes(effort)) return false;
  try {
    await kimiApi(config, 'POST', '/api/v1/config', { thinking: { enabled: true, effort } });
    return true;
  } finally { await stopKimiServer(); }
}

function normalizeKimiStatus(data) {
  const contextTokens = Number(data && data.context_tokens) || 0;
  const contextWindow = Number(data && data.max_context_tokens) || 0;
  return {
    busy: Boolean(data && data.busy),
    model: String(data && data.model || ''),
    thinkingLevel: String(data && data.thinking_level || ''),
    permission: String(data && data.permission || ''),
    planMode: Boolean(data && data.plan_mode),
    contextTokens,
    contextWindow,
    contextUsage: Number(data && data.context_usage) || (contextWindow > 0 ? contextTokens / contextWindow : 0),
  };
}

async function readKimiWireRuntime(nativeSessionId) {
  const file = kimiWireFile(nativeSessionId);
  if (!file) return null;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, 1024 * 1024);
    const offset = stat.size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (offset > 0) lines.shift(); // first tail fragment is not a complete JSON row
    let tokens = 0;
    let busy = false;
    let compactionBegins = 0;
    let compactionCompletes = 0;
    for (const line of lines) {
      const row = safeJsonParse(line);
      if (!row) continue;
      if (row.type === 'turn.prompt') busy = true;
      else if (row.type === 'full_compaction.begin') { busy = true; compactionBegins++; }
      else if (row.type === 'turn.ended') busy = false;
      else if (row.type === 'full_compaction.complete') { busy = false; compactionCompletes++; }
      else if (row.type === 'full_compaction.cancel' || row.type === 'full_compaction.cancelled') { busy = false; compactionCompletes++; }
      if ((row.type === 'token_counting.measured' || row.type === 'token_counting.rebased') && Number(row.tokens) > 0) tokens = Number(row.tokens);
      else if (row.type === 'context.apply_compaction' && Number(row.tokensAfter) > 0) tokens = Number(row.tokensAfter);
    }
    return tokens > 0 ? { tokens, busy, file, size: stat.size, compactionBegins, compactionCompletes } : null;
  } catch { return null; } finally { if (handle) await handle.close().catch(() => {}); }
}

async function kimiContextWindow(config, model) {
  const id = String(model || config && config.model || '').trim();
  const lower = id.toLowerCase();
  if (/(^|\/)k3$/.test(lower)) return 1048576;
  if (/k3-256k|kimi-for-coding/.test(lower)) return 262144;
  if (Date.now() - kimiBridgeState.modelsAt > 60000 || !kimiBridgeState.modelWindows.has(id)) {
    try {
      const discovered = await discoverKimiModels(config);
      if (discovered && Array.isArray(discovered.models)) {
        for (const item of discovered.models) if (item && item.id && Number(item.contextLength) > 0) kimiBridgeState.modelWindows.set(item.id, Number(item.contextLength));
        kimiBridgeState.modelsAt = Date.now();
      }
    } catch { /* use conservative fallback */ }
  }
  return kimiBridgeState.modelWindows.get(id) || 262144;
}

async function kimiSessionStatus(config, nativeSessionId, modelHint) {
  if (!nativeSessionId) return { ok: false, error: 'Kimi 原生会话尚未建立' };
  const wire = await readKimiWireRuntime(nativeSessionId);
  if (wire) {
    const model = String(modelHint || config && config.model || '');
    const contextWindow = await kimiContextWindow(config, model);
    return {
      ok: true, busy: wire.busy, model, thinkingLevel: String(config && config.claudeThinkingEffort || ''),
      permission: String(config && config.permissionMode || ''), planMode: config && config.permissionMode === 'plan',
      contextTokens: wire.tokens, contextWindow, contextUsage: contextWindow > 0 ? wire.tokens / contextWindow : 0,
      source: 'kimi-wire',
    };
  }
  try {
    const data = await kimiApi(config, 'GET', `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}/status`);
    return { ok: true, ...normalizeKimiStatus(data) };
  } catch (error) { return { ok: false, error: (error && error.message) || '读取 Kimi 状态失败' }; }
  finally { await stopKimiServer(); }
}

function kimiUsageFromStatus(status) {
  return {
    usage: {},
    contextTokens: Number(status && status.contextTokens) || 0,
    contextWindow: Number(status && status.contextWindow) || 0,
    model: String(status && status.model || ''),
    contextEngine: 'agent',
    contextAgentCliType: 'kimi',
    contextModel: String(status && status.model || ''),
    source: 'kimi-native',
  };
}

function applyKimiStatusToSession(session, status) {
  if (!session || !status || !status.ok) return null;
  const usage = kimiUsageFromStatus(status);
  session.kimiContextStatus = { ...status, updatedAt: nowIso() };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') { messages[i].usage = usage; break; }
  }
  return usage;
}

async function syncKimiSessionUsage(session, config, onEvent) {
  const status = await kimiSessionStatus(config, session && session.claudeSessionId, session && session.claudeSessionModel);
  if (!status.ok) return null;
  const usage = applyKimiStatusToSession(session, status);
  if (usage && onEvent) onEvent({ type: 'usage', ...usage });
  return usage;
}

async function compactKimiNative(config, nativeSessionId, instruction, onEvent) {
  const before = await kimiSessionStatus(config, nativeSessionId);
  if (!before.ok) return before;
  const beforeWire = await readKimiWireRuntime(nativeSessionId);
  if (onEvent) onEvent({ type: 'compact', mode: 'kimi-native', phase: 'started', trigger: 'manual', beforeTokens: before.contextTokens, contextWindow: before.contextWindow });
  try {
    // A long-lived Kimi Web process caches the session snapshot it loaded. Always start this operation
    // from a fresh process so compaction includes turns appended by Ruyi's separate CLI child.
    await stopKimiServer();
    await kimiApi(config, 'POST', `/api/v1/sessions/${encodeURIComponent(nativeSessionId)}:compact`, instruction ? { instruction } : {});
  } catch (error) {
    const message = (error && error.message) || 'Kimi 压缩请求失败';
    if (onEvent) onEvent({ type: 'compact', mode: 'kimi-native', phase: 'failed', error: message });
    await stopKimiServer();
    return { ok: false, error: message };
  }
  let after = before;
  let sawBusy = false;
  let operationDone = false;
  for (let i = 0; i < 360; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    after = await kimiSessionStatus(config, nativeSessionId);
    if (!after.ok) continue;
    if (after.busy) sawBusy = true;
    const wireNow = await readKimiWireRuntime(nativeSessionId);
    const completedAfterStart = Boolean(wireNow && beforeWire && wireNow.compactionCompletes > beforeWire.compactionCompletes);
    const tokensChanged = after.contextTokens > 0 && after.contextTokens !== before.contextTokens;
    if (!after.busy && (sawBusy || completedAfterStart || tokensChanged)) { operationDone = true; break; }
    if (onEvent && i > 0 && i % 10 === 0) onEvent({ type: 'compact', mode: 'kimi-native', phase: 'running', elapsedMs: (i + 1) * 500, beforeTokens: before.contextTokens });
  }
  if (!operationDone || !after.ok || after.busy) { await stopKimiServer(); return { ok: false, error: 'Kimi 压缩等待超时' }; }
  if (onEvent) onEvent({ type: 'compact', mode: 'kimi-native', phase: 'completed', beforeTokens: before.contextTokens, afterTokens: after.contextTokens, contextWindow: after.contextWindow });
  await stopKimiServer();
  return { ok: true, mode: 'kimi-native', beforeTokens: before.contextTokens, afterTokens: after.contextTokens, contextWindow: after.contextWindow, status: after };
}

async function runKimiCompact(sessionId, configOverride, trigger = 'manual', onEvent) {
  const config = configOverride || await readConfig();
  let session;
  try { session = await loadSession(String(sessionId || '')); } catch { return { ok: false, error: 'session not found' }; }
  if (!session) return { ok: false, error: 'session not found' };
  if (config.compactProviderId) return runAgentExternalCompact(session.id, config, trigger);
  if (!session.claudeSessionId) return { ok: false, error: 'Kimi 原生会话尚未建立，暂无可压缩上下文' };
  const result = await compactKimiNative(config, session.claudeSessionId, '', onEvent);
  if (!result.ok) return result;
  applyKimiStatusToSession(session, result.status);
  session.messages.push({
    role: 'system',
    content: `🗜 Kimi ${trigger === 'auto' ? '自动' : '手动'}压缩已完成：${fmtTokensServer(result.beforeTokens)}→${fmtTokensServer(result.afterTokens)}（原生会话实测）`,
    createdAt: nowIso(), source: 'compact',
  });
  await saveSession(session);
  logEvent({ kind: 'kimi_compact', trigger, sessionId: session.id, nativeSessionId: session.claudeSessionId, beforeTokens: result.beforeTokens, afterTokens: result.afterTokens });
  return result;
}

async function replaceSessionObject(target, fresh) {
  if (!target || !fresh) return;
  for (const key of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(fresh, key)) delete target[key];
  Object.assign(target, fresh);
}

// Called before an Agent CLI turn. Kimi uses its authoritative status; Claude can opt into an external
// model and uses the latest measured CLI usage. The default Claude path remains Claude's own auto-compact.
async function maybeAutoCompactAgentSession(session, config, agentCliType, onEvent) {
  try {
    const threshold = Number(config.autoCompactThreshold) || 0.8;
    if (config.compactProviderId) {
      let used = lastSessionContextTokens(session);
      let limit = 0;
      if (agentCliType === 'kimi' && session.claudeSessionId) {
        const status = await kimiSessionStatus(config, session.claudeSessionId, session.claudeSessionModel);
        if (status.ok) { used = status.contextTokens; limit = status.contextWindow; applyKimiStatusToSession(session, status); }
      }
      if (!limit) limit = Number((await agentConversationContextMeta(config, session)).contextWindow) || resolveContextWindow(null, config.model).value;
      if (used > 0 && limit > 0 && used >= threshold * limit) {
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'started', trigger: 'auto', beforeTokens: used, contextWindow: limit });
        const result = await runAgentExternalCompact(session.id, config, 'auto');
        if (!result.ok) { onEvent({ type: 'compact', mode: 'external-summary', phase: 'failed', error: result.error }); return false; }
        const fresh = await loadSession(session.id);
        await replaceSessionObject(session, fresh);
        onEvent({ type: 'compact', mode: 'external-summary', phase: 'completed', trigger: 'auto', beforeTokens: result.beforeTokens, afterTokens: result.afterTokens });
        return true;
      }
      return false;
    }
    if (agentCliType !== 'kimi' || !session.claudeSessionId) return false;
    const status = await kimiSessionStatus(config, session.claudeSessionId, session.claudeSessionModel);
    if (!status.ok) return false;
    applyKimiStatusToSession(session, status);
    onEvent({ type: 'usage', ...kimiUsageFromStatus(status) });
    if (status.contextWindow > 0 && status.contextTokens >= threshold * status.contextWindow) {
      const result = await runKimiCompact(session.id, config, 'auto', onEvent);
      if (!result.ok) { onEvent({ type: 'compact', mode: 'kimi-native', phase: 'failed', error: result.error }); return false; }
      const fresh = await loadSession(session.id);
      await replaceSessionObject(session, fresh);
      return true;
    }
    return false;
  } catch (error) {
    try { onEvent({ type: 'compact', mode: agentCliType === 'kimi' ? 'kimi-native' : 'external-summary', phase: 'failed', error: (error && error.message) || String(error) }); } catch { /* ignore */ }
    return false;
  }
}

function kimiWireSessionDir(nativeSessionId) {
  try {
    const indexFile = path.join(kimiCodeHome(), 'session_index.jsonl');
    const lines = fs.readFileSync(indexFile, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = safeJsonParse(lines[i]);
      if (row && row.sessionId === nativeSessionId && row.sessionDir) return String(row.sessionDir);
    }
  } catch { /* absent native index */ }
  return '';
}

function kimiWireFile(nativeSessionId) {
  const dir = kimiWireSessionDir(nativeSessionId);
  return dir ? path.join(dir, 'agents', 'main', 'wire.jsonl') : '';
}

function parseKimiWireCompaction(row, contextWindow) {
  if (!row || typeof row !== 'object') return null;
  if (row.type === 'full_compaction.begin') return { type: 'compact', mode: 'kimi-native', phase: 'started', trigger: row.source || 'auto' };
  if (row.type === 'context.apply_compaction') return { type: 'compact', mode: 'kimi-native', phase: 'applied', beforeTokens: Number(row.tokensBefore) || 0, afterTokens: Number(row.tokensAfter) || 0, compactedCount: Number(row.compactedCount) || 0 };
  if (row.type === 'token_counting.rebased') return { type: 'usage', usage: {}, contextTokens: Number(row.tokens) || 0, contextWindow: Number(contextWindow) || undefined, source: 'kimi-wire' };
  if (row.type === 'full_compaction.complete') return { type: 'compact', mode: 'kimi-native', phase: 'completed' };
  if (row.type === 'full_compaction.cancel' || row.type === 'full_compaction.cancelled') return { type: 'compact', mode: 'kimi-native', phase: 'failed', error: row.reason || 'Kimi 压缩已取消' };
  return null;
}

function kimiWireLoopEvent(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.type === 'context.append_loop_event' && row.event && typeof row.event === 'object') return row.event;
  return row;
}

function kimiWireSubagentId(nativeId) {
  return `kimi:${String(nativeId || '').trim()}`;
}

function ensureKimiWireSubagent(state, nativeId, patch = {}) {
  const key = String(nativeId || '').trim();
  if (!key) return { agent: null, created: false };
  if (!state.subagents) state.subagents = new Map();
  let agent = state.subagents.get(key);
  const created = !agent;
  if (!agent) {
    agent = {
      id: kimiWireSubagentId(key), nativeId: key, name: '', description: '', parentToolCallId: '', parentAgentId: '',
      runInBackground: false, model: '', thinkingEffort: '', startedAt: Date.now(), running: true, settled: false, lastProgressAt: 0,
    };
    state.subagents.set(key, agent);
  }
  for (const [name, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null && value !== '') agent[name] = value;
  }
  return { agent, created };
}

function kimiWireSubagentStart(agent) {
  return {
    type: 'subagent', id: agent.id, state: 'start', task: agent.description || agent.name || `Kimi 子代理 ${agent.nativeId}`,
    roleId: agent.name || 'subagent', roleLabel: agent.name || 'Kimi 子代理', model: agent.model || undefined,
    thinkingEffort: agent.thinkingEffort || undefined, engine: 'kimi', native: true, agentId: agent.nativeId,
    parentToolCallId: agent.parentToolCallId || undefined, parentAgentId: agent.parentAgentId || undefined,
  };
}

// ACP's session/update schema deliberately has no subagent variants. Kimi does persist those native events
// in every agent's wire.jsonl, including the child tool lifecycle. Translate that authoritative local stream
// into Ruyi's existing subagent/card event contract rather than inventing a parallel UI protocol.
function parseKimiWireAgentEvents(row, wireAgentId, state = {}) {
  const event = kimiWireLoopEvent(row);
  if (!event || typeof event !== 'object') return [];
  const out = [];
  const type = String(event.type || '');
  const startIfNeeded = (agent, created) => { if (agent && created) out.push(kimiWireSubagentStart(agent)); };
  if (type === 'subagent.spawned') {
    const { agent, created } = ensureKimiWireSubagent(state, event.subagentId, {
      name: String(event.subagentName || ''), description: String(event.description || ''),
      parentToolCallId: String(event.parentToolCallId || ''), parentAgentId: String(event.parentAgentId || ''),
      runInBackground: event.runInBackground === true, model: String(event.model || ''), thinkingEffort: String(event.thinkingEffort || ''),
    });
    startIfNeeded(agent, created);
    if (agent && event.runInBackground === true) out.push({ type: 'subagent', id: agent.id, state: 'background', task: agent.description || agent.name, engine: 'kimi', native: true, agentId: agent.nativeId });
    return out;
  }
  if (type === 'subagent.started' || type === 'subagent.suspended' || type === 'subagent.completed' || type === 'subagent.failed') {
    const { agent, created } = ensureKimiWireSubagent(state, event.subagentId);
    if (!agent) return out;
    startIfNeeded(agent, created);
    if (type === 'subagent.started') {
      agent.running = true; agent.lastProgressAt = Date.now();
      out.push({ type: 'subagent_progress', subagentId: agent.id, state: 'running', note: 'Kimi 子代理运行中', engine: 'kimi', native: true, agentId: agent.nativeId });
    } else if (type === 'subagent.suspended') {
      agent.running = true;
      out.push({ type: 'subagent_progress', subagentId: agent.id, state: 'waiting', note: `Kimi 子代理已暂停：${String(event.reason || '等待继续')}`, engine: 'kimi', native: true, agentId: agent.nativeId });
    } else if (!agent.settled) {
      agent.running = false; agent.settled = true;
      const ok = type === 'subagent.completed';
      const result = ok ? String(event.resultSummary || '') : String(event.error || 'Kimi 子代理执行失败');
      out.push({
        type: 'subagent', id: agent.id, state: 'end', ok, task: agent.description || agent.name || '', result,
        resultChars: result.length, usage: event.usage || undefined, contextTokens: Number(event.contextTokens) || undefined,
        engine: 'kimi', native: true, agentId: agent.nativeId,
      });
    }
    return out;
  }
  // Main-agent tools already arrive through ACP. Child wires are the missing half: nest their native
  // Glob/Grep/Bash/etc. cards under the corresponding subagent without duplicating the parent tool stream.
  const childId = String(wireAgentId || '');
  if (!childId || childId === 'main' || (type !== 'tool.call' && type !== 'tool.result')) return out;
  if (!state.childTools) state.childTools = new Map();
  const { agent, created } = ensureKimiWireSubagent(state, childId);
  if (!agent) return out;
  startIfNeeded(agent, created);
  const nativeToolId = String(event.toolCallId || '');
  if (!nativeToolId) return out;
  const key = `${childId}\u0000${nativeToolId}`;
  let tool = state.childTools.get(key);
  if (type === 'tool.call') {
    const input = event.args && typeof event.args === 'object' ? event.args : {};
    if (!tool) {
      tool = { id: `kimi:${childId}:${nativeToolId}`, name: String(event.name || 'KimiTool'), input, settled: false };
      state.childTools.set(key, tool);
      out.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input, subagentId: agent.id, engine: 'kimi', native: true });
    } else if (tool.name !== event.name || tool.input !== input) {
      tool.name = String(event.name || tool.name); tool.input = input;
      out.push({ type: 'tool_use_update', id: tool.id, name: tool.name, input: tool.input, subagentId: agent.id, engine: 'kimi', native: true });
    }
  } else if (!tool || !tool.settled) {
    if (!tool) {
      tool = { id: `kimi:${childId}:${nativeToolId}`, name: 'KimiTool', input: {}, settled: false };
      state.childTools.set(key, tool);
      out.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input, subagentId: agent.id, engine: 'kimi', native: true });
    }
    tool.settled = true;
    const result = event.result;
    out.push({
      type: 'tool_result', id: tool.id, subagentId: agent.id,
      content: result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'output') ? result.output : result,
      isError: Boolean(event.isError || (result && result.isError)), engine: 'kimi', native: true,
    });
  }
  return out;
}

function watchKimiWire(nativeSessionId, onEvent, contextWindow, state = {}) {
  const sessionDir = kimiWireSessionDir(nativeSessionId);
  const agentsDir = sessionDir && path.join(sessionDir, 'agents');
  if (!agentsDir || !fs.existsSync(agentsDir)) return () => {};
  const files = new Map();
  const addWireFile = (file, agentId, replay) => {
    if (!file || files.has(file) || !fs.existsSync(file)) return;
    try { files.set(file, { file, agentId, offset: replay ? 0 : fs.statSync(file).size, pending: '' }); } catch { /* race with child cleanup */ }
  };
  const discover = replayNew => {
    let entries = [];
    try { entries = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(agentsDir, entry.name, 'wire.jsonl');
      addWireFile(file, entry.name, replayNew);
    }
  };
  discover(false);
  let reading = false;
  const timer = setInterval(async () => {
    if (reading) return;
    reading = true;
    try {
      discover(true);
      for (const track of files.values()) {
        const size = (await fsp.stat(track.file)).size;
        if (size < track.offset) { track.offset = 0; track.pending = ''; }
        if (size <= track.offset) continue;
        const handle = await fsp.open(track.file, 'r');
        try {
          const buffer = Buffer.alloc(size - track.offset);
          await handle.read(buffer, 0, buffer.length, track.offset);
          track.offset = size;
          const lines = (track.pending + buffer.toString('utf8')).split(/\r?\n/);
          track.pending = lines.pop() || '';
          for (const line of lines) {
            const row = safeJsonParse(line);
            if (!row) continue;
            if (track.agentId === 'main') {
              const compact = parseKimiWireCompaction(row, contextWindow);
              if (compact) onEvent(compact);
            }
            for (const event of parseKimiWireAgentEvents(row, track.agentId, state)) onEvent(event);
          }
        } finally { await handle.close(); }
      }
      const now = Date.now();
      for (const agent of state.subagents instanceof Map ? state.subagents.values() : []) {
        if (agent.running && !agent.settled && now - agent.lastProgressAt >= 2000) {
          agent.lastProgressAt = now;
          onEvent({ type: 'subagent_progress', subagentId: agent.id, state: 'running', note: `Kimi 子代理运行中 · ${Math.max(1, Math.round((now - agent.startedAt) / 1000))}s`, engine: 'kimi', native: true, agentId: agent.nativeId });
        }
      }
    } catch { /* wire updates are best-effort */ } finally { reading = false; }
  }, 250);
  return () => clearInterval(timer);
}

function kimiAcpContentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(kimiAcpContentText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);
  if (typeof value.text === 'string') return value.text;
  if (value.content !== undefined) return kimiAcpContentText(value.content);
  if (value.rawOutput !== undefined) return kimiAcpContentText(value.rawOutput);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function kimiAcpRpcError(payload, method) {
  const detail = payload && payload.error || payload || {};
  const error = new Error(String(detail.message || `Kimi ACP ${method} failed`));
  error.code = detail.code;
  error.data = detail.data;
  error.method = method;
  return error;
}

// ACP uses one JSON-RPC object per line. This small client deliberately keeps reverse requests on the same
// transport: Kimi can pause session/prompt, ask Ruyi for permission/input, then continue after our response.
function createKimiAcpRpc(child, handlers = {}) {
  let nextId = 0;
  let buffer = '';
  let closed = false;
  const pending = new Map();
  const reversePending = new Map();
  const write = payload => {
    if (closed || !child.stdin || child.stdin.destroyed) throw new Error('Kimi ACP input channel is closed');
    child.stdin.write(JSON.stringify(payload) + '\n', 'utf8');
  };
  const rejectPending = error => {
    for (const [, item] of pending) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    for (const [, item] of reversePending) item.controller.abort(error);
    reversePending.clear();
  };
  const dispatch = message => {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && !message.method) {
      const item = pending.get(String(message.id));
      if (!item) return;
      pending.delete(String(message.id));
      clearTimeout(item.timer);
      if (message.error) item.reject(kimiAcpRpcError(message, item.method));
      else item.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      const key = String(message.id);
      const controller = new AbortController();
      reversePending.set(key, { controller, method: message.method });
      Promise.resolve().then(() => handlers.onRequest
        ? handlers.onRequest(message.method, message.params || {}, { requestId: message.id, signal: controller.signal }) : {})
        .then(result => {
          if (controller.signal.aborted) {
            const cancelled = new Error('Kimi ACP reverse request cancelled'); cancelled.code = -32800; throw cancelled;
          }
          write({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result });
        })
        .catch(error => {
          const cancelled = controller.signal.aborted;
          const code = cancelled ? -32800 : (Number.isInteger(error && error.code) ? error.code : -32603);
          const errorMessage = cancelled ? 'Request cancelled' : String(error && error.message || error);
          try { write({ jsonrpc: '2.0', id: message.id, error: { code, message: errorMessage } }); } catch { /* transport gone */ }
        })
        .finally(() => reversePending.delete(key));
      return;
    }
    if (message.method === '$/cancel_request') {
      const requestId = String(message.params && message.params.requestId);
      const item = reversePending.get(requestId);
      if (item) item.controller.abort(new Error('remote cancellation'));
      if (handlers.onCancel) handlers.onCancel(message.params && message.params.requestId, item && item.method);
      return;
    }
    if (message.method && handlers.onNotification) handlers.onNotification(message.method, message.params || {});
  };
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      if (handlers.onLine) handlers.onLine(line);
      const message = safeJsonParse(line);
      if (message) dispatch(message);
    }
  });
  child.once('error', error => { closed = true; rejectPending(error); });
  child.once('close', code => {
    closed = true;
    rejectPending(new Error(`Kimi ACP process exited${code == null ? '' : ` (${code})`}`));
  });
  return {
    request(method, params, timeoutMs = 30000) {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Kimi ACP ${method} timed out`));
        }, timeoutMs) : null;
        pending.set(id, { resolve, reject, timer, method });
        try { write({ jsonrpc: '2.0', id, method, params }); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    notify(method, params) {
      try { write({ jsonrpc: '2.0', method, params }); return true; } catch { return false; }
    },
    cancelReverseRequests(reason) {
      for (const [, item] of reversePending) item.controller.abort(reason || new Error('ACP connection closing'));
      reversePending.clear();
    },
    isClosed: () => closed,
  };
}

function kimiAcpMode(permissionMode) {
  if (permissionMode === 'plan') return 'plan';
  if (permissionMode === 'bypass') return 'yolo';
  if (permissionMode === 'auto' || permissionMode === 'acceptEdits') return 'auto';
  return 'default';
}

function kimiAcpToolTier(toolCall) {
  const kind = String(toolCall && toolCall.kind || '').toLowerCase();
  if (kind === 'read' || kind === 'search' || kind === 'fetch') return 'read';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit';
  const name = String(toolCall && toolCall.title || '').replace(/^.+?__/, '').toLowerCase();
  if (/^(read|glob|grep|readmediafile|websearch|fetchurl|tasklist|taskoutput|todolist|getgoal)$/.test(name)) return 'read';
  if (/^(write|edit)$/.test(name)) return 'edit';
  return 'exec';
}

function kimiAcpQuestionKind(params) {
  const options = Array.isArray(params && params.options) ? params.options : [];
  const ids = options.map(option => String(option && option.optionId || ''));
  const title = String(params && params.toolCall && params.toolCall.title || '');
  if (title === 'AskUserQuestion' || ids.some(id => /^q\d+_(?:opt_\d+|skip)$/.test(id))) return 'question';
  if (ids.some(id => /^plan_(?:opt_\d+|approve|revise|reject_and_exit)$/.test(id))) return 'plan';
  return 'permission';
}

async function handleKimiAcpPermissionRequest(params, context) {
  const options = (Array.isArray(params && params.options) ? params.options : []).filter(Boolean);
  const toolCall = params && params.toolCall || {};
  const kind = kimiAcpQuestionKind(params);
  context.reg.pausePending = true;
  context.reg.lastEventAt = Date.now();
  try {
    if (kind === 'question' || kind === 'plan') {
      const text = kimiAcpContentText(toolCall.content).trim()
        || (kind === 'plan' ? '请选择如何处理 Kimi 的计划。' : 'Kimi 需要你的选择。');
      const answer = await requestUserQuestion(
        context.session.id,
        String(toolCall.toolCallId || makeId('kimi_question')),
        [{
          id: kind === 'plan' ? 'kimi_plan' : 'kimi_question',
          header: kind === 'plan' ? 'Kimi 计划确认' : 'Kimi 提问',
          question: text,
          answerMode: 'single',
          allowOther: false,
          options: options.map(option => ({
            id: String(option.optionId || ''),
            label: String(option.name || option.optionId || ''),
            description: String(option.description || ''),
          })).filter(option => option.id && option.label),
        }],
        context.onEvent,
        context.config.permissionTimeoutMs,
        context.state.assistantText,
      );
      const selected = answer && answer.ok !== false && answer.answers && answer.answers[0]
        && answer.answers[0].selectedOptionIds && answer.answers[0].selectedOptionIds[0];
      return selected
        ? { outcome: { outcome: 'selected', optionId: selected } }
        : { outcome: { outcome: 'cancelled' } };
    }
    const title = String(toolCall.title || 'KimiTool');
    const input = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {};
    const decision = await requestNativePermission(
      context.session.id, title, input, context.onEvent, context.config.permissionTimeoutMs, kimiAcpToolTier(toolCall)
    );
    if (!decision || decision.behavior !== 'allow') {
      const reject = options.find(option => String(option.kind || '').startsWith('reject'))
        || options.find(option => String(option.optionId || '') === 'reject');
      return reject
        ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    const wantedKind = decision.scope === 'session' ? 'allow_always' : 'allow_once';
    const allow = options.find(option => option.kind === wantedKind)
      || options.find(option => String(option.kind || '').startsWith('allow'));
    if (!allow) return { outcome: { outcome: 'cancelled' } };
    if (!Array.isArray(context.reg.kimiAcpApprovals)) context.reg.kimiAcpApprovals = [];
    context.reg.kimiAcpApprovals.push({
      title: title.toLowerCase(), tier: kimiAcpToolTier(toolCall), input,
      scope: decision.scope === 'session' ? 'session' : 'once', at: Date.now(),
    });
    if (context.reg.kimiAcpApprovals.length > 32) context.reg.kimiAcpApprovals.splice(0, context.reg.kimiAcpApprovals.length - 32);
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  } finally {
    context.reg.pausePending = false;
    context.reg.lastEventAt = Date.now();
  }
}

function kimiAcpRequestError(code, message) {
  const error = new Error(String(message || 'Kimi ACP request failed'));
  error.code = code;
  return error;
}

function kimiAcpAssertSession(params, context) {
  const expected = String(context && context.reg && context.reg.nativeSessionId || '');
  const actual = String(params && params.sessionId || '');
  if (!actual) throw kimiAcpRequestError(-32602, 'sessionId is required');
  if (expected && actual !== expected) throw kimiAcpRequestError(-32602, 'sessionId does not match the active Kimi session');
}

function kimiAcpApprovalValue(input, kind) {
  if (!input || typeof input !== 'object') return '';
  if (kind === 'terminal') return String(input.command || input.cmd || '').trim();
  return String(input.path || input.file_path || input.filePath || '').trim();
}

function consumeKimiAcpApproval(context, kind, input) {
  const approvals = Array.isArray(context.reg.kimiAcpApprovals) ? context.reg.kimiAcpApprovals : [];
  const wanted = kimiAcpApprovalValue(input, kind);
  const titlePattern = kind === 'terminal' ? /bash|shell|terminal/ : /write|edit|file/;
  for (let index = approvals.length - 1; index >= 0; index--) {
    const row = approvals[index];
    if (!row || Date.now() - Number(row.at || 0) > 10 * 60 * 1000 || !titlePattern.test(String(row.title || ''))) continue;
    const granted = kimiAcpApprovalValue(row.input, kind);
    let sameValue = granted === wanted;
    if (kind === 'write' && granted && wanted) {
      const grantedPath = path.resolve(granted);
      const wantedPath = path.resolve(wanted);
      sameValue = process.platform === 'win32'
        ? grantedPath.toLowerCase() === wantedPath.toLowerCase()
        : grantedPath === wantedPath;
    }
    if (row.scope !== 'session' && wanted && granted && !sameValue) continue;
    if (row.scope !== 'session') approvals.splice(index, 1);
    return true;
  }
  return false;
}

async function ensureKimiAcpOperationPermission(context, kind, input) {
  const mode = String(context.config && context.config.permissionMode || 'default');
  if (mode === 'bypass' || mode === 'auto' || (mode === 'acceptEdits' && kind === 'write')) return;
  if (mode === 'plan') throw kimiAcpRequestError(-32000, `Kimi ${kind === 'terminal' ? 'terminal execution' : 'file write'} is disabled in plan mode`);
  if (consumeKimiAcpApproval(context, kind === 'write' ? 'write' : 'terminal', input)) return;
  const decision = await requestNativePermission(
    context.session.id, kind === 'terminal' ? 'Bash' : 'Write', input,
    context.onEvent, context.config.permissionTimeoutMs, kind === 'terminal' ? 'exec' : 'edit'
  );
  if (!decision || decision.behavior !== 'allow') throw kimiAcpRequestError(-32000, 'Operation denied by user');
  if (decision.scope === 'session') {
    if (!Array.isArray(context.reg.kimiAcpApprovals)) context.reg.kimiAcpApprovals = [];
    context.reg.kimiAcpApprovals.push({
      title: kind === 'terminal' ? 'bash' : 'write', tier: kind === 'terminal' ? 'exec' : 'edit',
      input, scope: 'session', at: Date.now(),
    });
  }
}

function kimiAcpTerminal(context, params) {
  kimiAcpAssertSession(params, context);
  const id = String(params && params.terminalId || '');
  const terminal = context.reg.kimiAcpTerminals && context.reg.kimiAcpTerminals.get(id);
  if (!terminal || terminal.released) throw kimiAcpRequestError(-32602, `Unknown or released terminalId: ${id}`);
  if (terminal.sessionId !== String(params.sessionId)) throw kimiAcpRequestError(-32602, 'terminalId belongs to a different session');
  return terminal;
}

function kimiAcpTerminalRef(value) {
  const pending = [value];
  const seen = new Set();
  for (let visited = 0; pending.length && visited < 64; visited++) {
    const row = pending.shift();
    if (!row || typeof row !== 'object' || seen.has(row)) continue;
    seen.add(row);
    if (row.type === 'terminal' && row.terminalId) return String(row.terminalId);
    if (Array.isArray(row)) pending.push(...row.slice(0, 32));
    else if (row.content) pending.push(row.content);
  }
  return '';
}

function kimiAcpTerminalDisplayResult(reg, terminalId) {
  if (!reg || !terminalId) return null;
  const active = reg.kimiAcpTerminals && reg.kimiAcpTerminals.get(terminalId);
  const snapshot = active || (reg.kimiAcpTerminalResults && reg.kimiAcpTerminalResults.get(terminalId));
  if (!snapshot) return null;
  const output = String(snapshot.output || '');
  if (output) return output;
  const code = snapshot.exitCode;
  const signal = snapshot.signal;
  return signal ? `[terminal exited: ${signal}]` : `[terminal exited: ${code == null ? 'unknown' : code}; no output]`;
}

function rememberKimiAcpTerminal(reg, terminal) {
  if (!reg || !terminal) return;
  if (!reg.kimiAcpTerminalResults) reg.kimiAcpTerminalResults = new Map();
  reg.kimiAcpTerminalResults.set(terminal.id, {
    output: terminal.output, truncated: terminal.truncated, exitCode: terminal.exitCode, signal: terminal.signal, at: Date.now(),
  });
  while (reg.kimiAcpTerminalResults.size > 32) reg.kimiAcpTerminalResults.delete(reg.kimiAcpTerminalResults.keys().next().value);
}

function appendKimiAcpTerminalOutput(terminal, text) {
  if (!text) return;
  terminal.output += text;
  let bytes = Buffer.from(terminal.output, 'utf8');
  if (bytes.length <= terminal.outputByteLimit) return;
  let start = bytes.length - terminal.outputByteLimit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  terminal.output = bytes.subarray(start).toString('utf8');
  terminal.truncated = true;
}

function settleKimiAcpTerminal(terminal, exitCode, signal) {
  if (!terminal || terminal.exited) return;
  try { appendKimiAcpTerminalOutput(terminal, terminal.stdoutDecoder.end()); } catch { /* already drained */ }
  try { appendKimiAcpTerminalOutput(terminal, terminal.stderrDecoder.end()); } catch { /* already drained */ }
  terminal.exited = true;
  terminal.exitCode = Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : null;
  terminal.signal = signal == null ? null : String(signal);
  terminal.resolveExit({ exitCode: terminal.exitCode, signal: terminal.signal });
}

async function killKimiAcpTerminal(terminal) {
  if (!terminal || terminal.exited) return;
  try { if (terminal.child && terminal.child.pid) killChildTree(terminal.child.pid); } catch { /* best effort */ }
  await Promise.race([terminal.waitPromise, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (!terminal.exited) {
    try { terminal.child.kill('SIGKILL'); } catch { /* already gone */ }
    await Promise.race([terminal.waitPromise, new Promise(resolve => setTimeout(resolve, 500))]);
  }
  if (!terminal.exited) settleKimiAcpTerminal(terminal, null, 'SIGKILL');
}

function awaitKimiAcpWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(kimiAcpRequestError(-32800, 'Request cancelled'));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(kimiAcpRequestError(-32800, 'Request cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

async function handleKimiAcpTerminalCreate(params, context, requestMeta) {
  kimiAcpAssertSession(params, context);
  const command = String(params && params.command || '');
  const args = Array.isArray(params && params.args) ? params.args.map(value => String(value)).slice(0, 128) : [];
  if (!command || command.length > 4096 || command.includes('\0') || args.some(arg => arg.length > 32768 || arg.includes('\0'))) {
    throw kimiAcpRequestError(-32602, 'Invalid terminal command or arguments');
  }
  const cwd = params && params.cwd ? String(params.cwd) : String(context.session.cwd || context.config.defaultWorkspace || os.homedir());
  if (!path.isAbsolute(cwd)) throw kimiAcpRequestError(-32602, 'terminal cwd must be an absolute path');
  const stat = await fsp.stat(cwd).catch(() => null);
  if (!stat || !stat.isDirectory()) throw kimiAcpRequestError(-32602, 'terminal cwd does not exist or is not a directory');
  const execGuard = await guardWorkspaceExecute(cwd, { session: context.session, config: context.config });
  if (!execGuard.ok) throw kimiAcpRequestError(-32000, execGuard.error);
  const shellCommand = args.length === 2 && args[0] === '-c' ? args[1] : [command, ...args].join(' ');
  await awaitKimiAcpWithSignal(
    ensureKimiAcpOperationPermission(context, 'terminal', { command: shellCommand, cwd }),
    requestMeta && requestMeta.signal,
  );
  const env = { ...process.env };
  for (const item of (Array.isArray(params.env) ? params.env.slice(0, 128) : [])) {
    const name = String(item && item.name || '');
    const value = String(item && item.value || '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value.length <= 32768 && !value.includes('\0')) env[name] = value;
  }
  const outputByteLimit = Math.min(8 * 1024 * 1024, Math.max(4096, Number(params.outputByteLimit) || 1024 * 1024));
  const terminalId = makeId('kimi_terminal');
  let child;
  try {
    child = cp.spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { throw kimiAcpRequestError(-32000, `Failed to create terminal: ${error && error.message || error}`); }
  let resolveExit;
  const waitPromise = new Promise(resolve => { resolveExit = resolve; });
  const terminal = {
    id: terminalId, sessionId: String(params.sessionId), child, output: '', outputByteLimit, truncated: false,
    exited: false, released: false, exitCode: null, signal: null, resolveExit, waitPromise,
    stdoutDecoder: new StringDecoder('utf8'), stderrDecoder: new StringDecoder('utf8'),
  };
  context.reg.kimiAcpTerminals.set(terminalId, terminal);
  child.stdout.on('data', chunk => { appendKimiAcpTerminalOutput(terminal, terminal.stdoutDecoder.write(chunk)); context.reg.lastEventAt = Date.now(); });
  child.stderr.on('data', chunk => { appendKimiAcpTerminalOutput(terminal, terminal.stderrDecoder.write(chunk)); context.reg.lastEventAt = Date.now(); });
  child.once('error', error => {
    appendKimiAcpTerminalOutput(terminal, `\n[terminal error] ${String(error && error.message || error)}\n`);
    settleKimiAcpTerminal(terminal, null, 'ERROR');
  });
  child.once('close', (code, signal) => settleKimiAcpTerminal(terminal, code, signal));
  await new Promise((resolve, reject) => {
    if (terminal.exited && terminal.signal === 'ERROR') return reject(kimiAcpRequestError(-32000, terminal.output.trim() || 'Failed to create terminal'));
    const onSpawn = () => { child.removeListener('error', onError); resolve(); };
    const onError = error => { child.removeListener('spawn', onSpawn); reject(kimiAcpRequestError(-32000, `Failed to create terminal: ${error && error.message || error}`)); };
    child.once('spawn', onSpawn); child.once('error', onError);
  }).catch(error => { context.reg.kimiAcpTerminals.delete(terminalId); throw error; });
  if (requestMeta && requestMeta.signal && requestMeta.signal.aborted) {
    context.reg.kimiAcpTerminals.delete(terminalId);
    await killKimiAcpTerminal(terminal);
    throw kimiAcpRequestError(-32800, 'Request cancelled');
  }
  return { terminalId };
}

async function handleKimiAcpTerminalRequest(method, params, context, requestMeta) {
  if (method === 'terminal/create') return handleKimiAcpTerminalCreate(params, context, requestMeta);
  const terminal = kimiAcpTerminal(context, params);
  if (method === 'terminal/output') {
    return {
      output: terminal.output, truncated: terminal.truncated,
      ...(terminal.exited ? { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } } : {}),
    };
  }
  if (method === 'terminal/wait_for_exit') return awaitKimiAcpWithSignal(terminal.waitPromise, requestMeta && requestMeta.signal);
  if (method === 'terminal/kill') { await killKimiAcpTerminal(terminal); return {}; }
  if (method === 'terminal/release') {
    terminal.released = true;
    context.reg.kimiAcpTerminals.delete(terminal.id);
    await killKimiAcpTerminal(terminal);
    rememberKimiAcpTerminal(context.reg, terminal);
    return {};
  }
  throw kimiAcpRequestError(-32601, `Unsupported terminal method: ${method}`);
}

async function cleanupKimiAcpTerminals(reg) {
  const terminals = reg && reg.kimiAcpTerminals ? [...reg.kimiAcpTerminals.values()] : [];
  if (reg && reg.kimiAcpTerminals) reg.kimiAcpTerminals.clear();
  await Promise.all(terminals.map(async terminal => { terminal.released = true; await killKimiAcpTerminal(terminal); }));
}

function kimiAcpTextLines(text) {
  return String(text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
}

async function handleKimiAcpFsRequest(method, params, context) {
  kimiAcpAssertSession(params, context);
  const rawPath = String(params && params.path || '');
  if (!rawPath || !path.isAbsolute(rawPath)) throw kimiAcpRequestError(-32602, 'ACP filesystem path must be absolute');
  const write = method === 'fs/write_text_file';
  const guard = await guardFileToolPath(rawPath, { session: context.session, config: context.config }, { tool: write ? 'kimi_acp_write' : 'kimi_acp_read', write });
  if (!guard.ok) throw kimiAcpRequestError(-32000, guard.error);
  if (!write) {
    const stat = await fsp.stat(guard.absPath).catch(() => null);
    if (!stat || !stat.isFile()) throw kimiAcpRequestError(-32002, 'Resource not found');
    if (stat.size > 50 * 1024 * 1024) throw kimiAcpRequestError(-32000, 'Text file is larger than the 50 MB ACP read limit');
    const text = await fsp.readFile(guard.absPath, 'utf8');
    if (params.line == null && params.limit == null) return { content: text };
    const line = Math.max(1, Math.trunc(Number(params.line) || 1));
    const limit = params.limit == null ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.trunc(Number(params.limit) || 0));
    return { content: kimiAcpTextLines(text).slice(line - 1, line - 1 + limit).join('') };
  }
  const content = String(params && params.content || '');
  if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) throw kimiAcpRequestError(-32602, 'ACP file content exceeds the write limit');
  await ensureKimiAcpOperationPermission(context, 'write', { path: guard.absPath });
  const result = await toolCall('file_write', { path: guard.absPath, content, createDirs: true }, {
    session: context.session, config: context.config, workingDir: context.session.cwd,
  });
  if (!result || result.ok === false) throw kimiAcpRequestError(-32000, result && result.error || 'File write failed');
  return {};
}

function kimiAcpElicitationOptions(schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(row => ({ value: String(row && row.const || ''), label: String(row && row.title || row && row.const || ''), description: String(row && row.description || '') }));
  if (Array.isArray(schema.enum)) return schema.enum.map(value => ({ value: String(value), label: String(value), description: '' }));
  const items = schema.items && typeof schema.items === 'object' ? schema.items : {};
  if (Array.isArray(items.anyOf)) return items.anyOf.map(row => ({ value: String(row && row.const || ''), label: String(row && row.title || row && row.const || ''), description: String(row && row.description || '') }));
  if (Array.isArray(items.enum)) return items.enum.map(value => ({ value: String(value), label: String(value), description: '' }));
  return [];
}

function kimiAcpElicitationQuestion(key, schema, required, message, fieldIndex) {
  const type = String(schema && schema.type || 'string');
  const title = String(schema && schema.title || key);
  const description = [String(schema && schema.description || ''), schema && schema.default != null ? `默认值：${JSON.stringify(schema.default)}` : ''].filter(Boolean).join('\n');
  const row = { key, type, schema, required, values: new Map(), skipId: `kimi_skip_${key}` };
  let choices = kimiAcpElicitationOptions(schema);
  if (type === 'boolean') choices = [{ value: true, label: '是', description: '' }, { value: false, label: '否', description: '' }];
  const options = choices.slice(0, 11).map((choice, index) => {
    const id = `kimi_${key}_${index}`.slice(0, 80);
    row.values.set(id, choice.value);
    return { id, label: choice.label, description: choice.description };
  });
  if (!required) options.push({ id: row.skipId.slice(0, 80), label: '跳过此项', description: '不提交这个可选字段' });
  const hasChoices = options.length > (required ? 0 : 1);
  row.ui = {
    id: `kimi_field_${fieldIndex}`.slice(0, 80), header: title.slice(0, 80),
    question: [message, title, description].filter(Boolean).join('\n').slice(0, 1000),
    answerMode: type === 'array' ? 'multiple' : (hasChoices || !required ? 'single' : 'text'),
    allowOther: !hasChoices && !required, options,
  };
  return row;
}

function kimiAcpElicitationValue(row, answer) {
  if (!answer || typeof answer !== 'object') {
    if (!row.required) return { present: false };
    throw kimiAcpRequestError(-32602, `${row.key} is required`);
  }
  const selected = Array.isArray(answer && answer.selectedOptionIds) ? answer.selectedOptionIds : [];
  if (selected.includes(row.skipId.slice(0, 80))) return { present: false };
  let value;
  if (row.type === 'array') value = selected.filter(id => row.values.has(id)).map(id => row.values.get(id));
  else if (selected.length && row.values.has(selected[0])) value = row.values.get(selected[0]);
  else value = String(answer && answer.otherText || (answer && answer.answer && answer.answer[0]) || '');
  if (row.type !== 'array' && row.values.size && !selected.some(id => row.values.has(id))) {
    throw kimiAcpRequestError(-32602, `${row.key} must use one of the offered values`);
  }
  const schema = row.schema || {};
  if (row.type === 'number' || row.type === 'integer') {
    const number = Number(value);
    if (!Number.isFinite(number) || (row.type === 'integer' && !Number.isInteger(number))) throw kimiAcpRequestError(-32602, `${row.key} must be a valid ${row.type}`);
    if (schema.minimum != null && number < Number(schema.minimum)) throw kimiAcpRequestError(-32602, `${row.key} is below its minimum`);
    if (schema.maximum != null && number > Number(schema.maximum)) throw kimiAcpRequestError(-32602, `${row.key} exceeds its maximum`);
    value = number;
  } else if (row.type === 'string') {
    value = String(value);
    if (schema.minLength != null && value.length < Number(schema.minLength)) throw kimiAcpRequestError(-32602, `${row.key} is shorter than minLength`);
    if (schema.maxLength != null && value.length > Number(schema.maxLength)) throw kimiAcpRequestError(-32602, `${row.key} exceeds maxLength`);
    if (schema.pattern) { let pattern; try { pattern = new RegExp(String(schema.pattern)); } catch { pattern = null; } if (pattern && !pattern.test(value)) throw kimiAcpRequestError(-32602, `${row.key} does not match the requested pattern`); }
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw kimiAcpRequestError(-32602, `${row.key} must be an email address`);
    if (schema.format === 'uri') { try { new URL(value); } catch { throw kimiAcpRequestError(-32602, `${row.key} must be a URI`); } }
    if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) throw kimiAcpRequestError(-32602, `${row.key} must be a date`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) throw kimiAcpRequestError(-32602, `${row.key} must be a date-time`);
  } else if (row.type === 'boolean') {
    if (value !== true && value !== false) throw kimiAcpRequestError(-32602, `${row.key} must be a boolean`);
  } else if (row.type === 'array') {
    if (schema.minItems != null && value.length < Number(schema.minItems)) throw kimiAcpRequestError(-32602, `${row.key} has too few selections`);
    if (schema.maxItems != null && value.length > Number(schema.maxItems)) throw kimiAcpRequestError(-32602, `${row.key} has too many selections`);
  }
  return { present: true, value };
}

async function handleKimiAcpElicitation(params, context, requestMeta) {
  const mode = String(params && params.mode || 'form');
  const message = String(params && params.message || 'Kimi 需要你的输入。');
  if (params && params.sessionId != null) kimiAcpAssertSession(params, context);
  else if (!params || params.requestId == null) throw kimiAcpRequestError(-32602, 'Elicitation requires sessionId or requestId scope');
  context.reg.pausePending = true;
  context.reg.lastEventAt = Date.now();
  try {
    if (mode === 'url') {
      let url;
      try { url = new URL(String(params.url || '')); } catch { throw kimiAcpRequestError(-32602, 'Invalid elicitation URL'); }
      if (!/^https?:$/.test(url.protocol)) throw kimiAcpRequestError(-32602, 'Only HTTP(S) elicitation URLs are supported');
      const answer = await awaitKimiAcpWithSignal(requestUserQuestion(
        context.session.id, String(params.elicitationId || makeId('kimi_elicitation')),
        [{ id: 'kimi_url_elicitation', header: 'Kimi 外部授权', question: `${message}\n\n完整地址：${url.href}`, answerMode: 'single', allowOther: false,
          options: [{ id: 'open', label: '同意并打开', description: `将在系统浏览器打开 ${url.hostname}` }, { id: 'decline', label: '拒绝', description: '不打开此地址' }] }],
        context.onEvent, context.config.permissionTimeoutMs, context.state.assistantText
      ), requestMeta && requestMeta.signal);
      const selected = answer && answer.ok !== false && answer.answers && answer.answers[0] && answer.answers[0].selectedOptionIds && answer.answers[0].selectedOptionIds[0];
      if (selected !== 'open') return { action: selected === 'decline' ? 'decline' : 'cancel' };
      try { const open = buildOpenSpawn(url.href); cp.spawn(open.command, open.args, { detached: true, windowsHide: false, stdio: 'ignore' }).unref(); }
      catch (error) { throw kimiAcpRequestError(-32000, `Unable to open elicitation URL: ${error && error.message || error}`); }
      context.reg.kimiAcpElicitations.set(String(params.elicitationId || ''), { url: url.href, at: Date.now() });
      return { action: 'accept' };
    }
    if (mode !== 'form') throw kimiAcpRequestError(-32602, `Unsupported elicitation mode: ${mode}`);
    const requested = params && params.requestedSchema && typeof params.requestedSchema === 'object' ? params.requestedSchema : {};
    const required = new Set(Array.isArray(requested.required) ? requested.required.map(String) : []);
    const properties = Object.entries(requested.properties && typeof requested.properties === 'object' ? requested.properties : {});
    if (properties.length > 60) throw kimiAcpRequestError(-32602, 'Elicitation form exceeds the 60-field Ruyi limit');
    const rows = properties.map(([key, schema], index) => kimiAcpElicitationQuestion(key, schema || {}, required.has(key), message, index));
    const content = Object.create(null);
    for (let start = 0; start < rows.length; start += 3) {
      const batch = rows.slice(start, start + 3);
      const answer = await awaitKimiAcpWithSignal(requestUserQuestion(
        context.session.id, String(params.toolCallId || makeId('kimi_elicitation')), batch.map(row => row.ui),
        context.onEvent, context.config.permissionTimeoutMs, context.state.assistantText
      ), requestMeta && requestMeta.signal);
      if (!answer || answer.ok === false) return { action: 'cancel' };
      for (const row of batch) {
        const result = kimiAcpElicitationValue(row, (answer.answers || []).find(item => item && item.questionId === row.ui.id));
        if (result.present) content[row.key] = result.value;
      }
    }
    return { action: 'accept', content };
  } finally {
    context.reg.pausePending = false;
    context.reg.lastEventAt = Date.now();
  }
}

function kimiAcpApplyPlan(update, session, onEvent) {
  // Stable ACP `plan` carries entries at the update root; the experimental `plan_update` shape nests
  // them under plan:{type:'items', entries}. Preserve the complete native shape even when Ruyi cannot
  // project a future file/markdown plan into its todo list yet.
  const plan = update && update.sessionUpdate === 'plan_update' && update.plan && typeof update.plan === 'object'
    ? update.plan : update;
  session.kimiAcpPlan = plan && typeof plan === 'object' ? plan : null;
  const rows = Array.isArray(plan && plan.entries) ? plan.entries
    : (Array.isArray(plan && plan.items) ? plan.items : []);
  if (!rows.length) {
    if ((update && update.sessionUpdate === 'plan') || (plan && plan.type === 'items')) {
      session.todos = [];
      onEvent({ type: 'todo', items: [], source: 'kimi-acp' });
    }
    return;
  }
  const items = normalizeTodoItems(rows.map((row, index) => ({
    id: row && (row.id || row.planEntryId) || `kimi-plan-${index + 1}`,
    text: row && (row.content || row.text || row.title) || '',
    status: /complete|done/i.test(String(row && row.status || '')) ? 'done'
      : /progress|active/i.test(String(row && row.status || '')) ? 'in_progress' : 'pending',
  })));
  session.todos = items;
  onEvent({ type: 'todo', items, source: 'kimi-acp' });
}

function kimiAcpWireCheckpoint(nativeSessionId) {
  const file = kimiWireFile(nativeSessionId);
  if (!file) return { file: '', size: 0 };
  try { return { file, size: fs.statSync(file).size }; } catch { return { file, size: 0 }; }
}

async function kimiAcpWireOutcome(nativeSessionId, checkpoint) {
  const file = kimiWireFile(nativeSessionId) || checkpoint && checkpoint.file;
  if (!file) return null;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const stat = await handle.stat();
    let offset = checkpoint && checkpoint.file === file ? Math.min(Number(checkpoint.size) || 0, stat.size) : 0;
    if (stat.size - offset > 2 * 1024 * 1024) offset = stat.size - 2 * 1024 * 1024;
    const buffer = Buffer.alloc(stat.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (offset > 0) lines.shift();
    let ended = null;
    for (const line of lines) {
      const row = safeJsonParse(line);
      if (row && row.type === 'turn.ended') ended = row;
    }
    if (!ended) return null;
    const error = ended.error && typeof ended.error === 'object' ? ended.error : {};
    return {
      reason: String(ended.reason || ''),
      error: String(error.message || error.detail || ended.message || error.code || ''),
      code: String(error.code || ''),
    };
  } catch { return null; } finally { if (handle) await handle.close().catch(() => {}); }
}

async function closeKimiAcpProcess(child, rpc, nativeSessionId) {
  if (rpc && nativeSessionId && !rpc.isClosed()) {
    await rpc.request('session/close', { sessionId: nativeSessionId }, 3000).catch(() => {});
  }
  try { if (child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch { /* ignore */ }
  if (child.exitCode != null) return;
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, 350);
    child.once('close', finish);
  });
  if (child.exitCode == null) { try { killChildTree(child.pid); } catch { /* ignore */ } }
}

function friendlyKimiAcpError(error) {
  const raw = String(error && error.message || error || 'Kimi ACP 回合失败');
  const detailCode = String(error && error.data && (error.data.code || error.data.errorCode) || '');
  if (/auth(?:entication)?[._ -]?(?:required|error)|login[._ -]?required|token[._ -]?(?:missing|unauthorized)|not authenticated|unauthorized|provisioning_required|model_not_resolved/i.test(`${detailCode}\n${raw}`)) {
    return `Kimi Code 尚未登录或登录已失效。请先在终端运行 kimi login，再重试。\n原始错误：${raw}`;
  }
  return raw;
}

function prepareKimiAcpSpawn(command) {
  const base = prepareAgentCliSpawn('kimi', command, ['acp']);
  const entry = String(base.args && base.args[0] || '');
  const register = path.join(externalRoot(), 'resources', 'kimi-acp-compat-register.mjs');
  // Only direct npm-package launches can use Node's ESM loader. Native Kimi executables retain their
  // upstream behavior rather than guessing at a binary patch, and the loader itself still verifies the
  // exact source helper before changing anything.
  if (!fs.existsSync(register) || !path.isAbsolute(entry) || !/[\\/]@moonshot-ai[\\/]kimi-code[\\/]dist[\\/]main\.mjs$/i.test(entry)) return base;
  return { ...base, args: ['--import', pathToFileURL(register).href, ...base.args], kimiAcpCompat: true };
}

async function runKimiAcpTurnPrepared(context) {
  const {
    session, message, onEvent, config, cliDriver, agentCliLabel, claude, workingDir, fullPrompt,
    additionalDirectories, turnStartedAt, turnSegments, activeTraceId, currentClaudeModel,
    currentResumeRouteKey, historyRecoveryInjected, indexInjection, indexPayloadHash, memoryPreflight,
    resumeResetReason, promptTaskContext, agentRecoverySummary,
  } = context;
  let workspaceTurnBaseline = context.workspaceTurnBaseline;
  const env = {
    ...process.env,
    WIN_CLAUDE_WORKBENCH_HOME: paths.data,
    WCW_PERMISSION_TIMEOUT_MS: String(config.permissionTimeoutMs || 120000),
    WCW_SESSION_ID: session.id,
    WCW_PORT: String(RUNTIME.port),
    WCW_HOST: RUNTIME.host,
    WCW_TOKEN: RUNTIME.token,
  };
  if (config.includeWorkbenchMcp) await syncMcpServersToKimi(config);
  const spawn = prepareKimiAcpSpawn(claude);
  if (spawn.kimiAcpCompat) env.RUYI_KIMI_ACP_COMPAT = '1';
  const cwdWarn = cwdWarning(workingDir);
  const state = {
    assistantText: '', thinkingText: '', usage: null, model: String(config.model || ''),
    usageTick: 0, turnUsage: null, planTouched: false, toolCalls: [], toolMap: new Map(), availableCommands: [], error: null, stopReason: '',
  };
  let rawSeq = 0;
  let stderrText = '';
  let nativeSessionId = '';
  let stopKimiWireWatch = () => {};
  let watchdog = null;
  let child = null;
  let rpc = null;
  let reg = null;
  const markActivity = () => { if (reg) reg.lastEventAt = Date.now(); };
  const emitUpdate = params => {
    markActivity();
    const update = params && params.update || {};
    const type = String(update.sessionUpdate || '');
    if (type === 'agent_message_chunk') {
      const text = kimiAcpContentText(update.content);
      if (text) { state.assistantText += text; if (reg) reg.questionContext = state.assistantText; onEvent({ type: 'assistant_delta', text }); }
    } else if (type === 'agent_thought_chunk') {
      const text = kimiAcpContentText(update.content);
      if (text) { state.thinkingText += text; onEvent({ type: 'thinking_delta', text }); }
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      const id = String(update.toolCallId || '');
      if (!id) return;
      let record = state.toolMap.get(id);
      if (!record) {
        record = { id, name: String(update.title || 'KimiTool'), input: update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : {} };
        state.toolMap.set(id, record); state.toolCalls.push(record);
        onEvent({ type: 'tool_use', id, name: record.name, input: record.input });
      } else {
        const previousName = record.name;
        const previousInput = record.input;
        if (update.title) record.name = String(update.title);
        if (update.rawInput && typeof update.rawInput === 'object') record.input = update.rawInput;
        if (record.name !== previousName || record.input !== previousInput) {
          onEvent({ type: 'tool_use_update', id, name: record.name, input: record.input });
        }
      }
      const status = String(update.status || '');
      if ((status === 'completed' || status === 'failed') && !record.__settled) {
        record.__settled = true;
        const terminalId = kimiAcpTerminalRef(update.rawOutput) || kimiAcpTerminalRef(update.content);
        const terminalResult = terminalId ? kimiAcpTerminalDisplayResult(reg, terminalId) : null;
        record.result = terminalResult != null
          ? terminalResult
          : (update.rawOutput !== undefined ? update.rawOutput : kimiAcpContentText(update.content));
        onEvent({ type: 'tool_result', id, content: record.result, isError: status === 'failed' });
      }
    } else if (type === 'usage_update') {
      const used = Number(update.used) || 0;
      const size = Number(update.size) || 0;
      state.usage = {
        usage: {}, contextTokens: used, contextWindow: size, model: state.model,
        contextEngine: 'agent', contextAgentCliType: 'kimi', contextModel: state.model, source: 'kimi-acp',
      };
      state.usageTick += 1;
      session.kimiContextStatus = {
        ok: true, busy: false, model: state.model, contextTokens: used, contextWindow: size,
        contextUsage: size > 0 ? used / size : 0, source: 'kimi-acp', updatedAt: nowIso(),
      };
      onEvent({ type: 'usage', ...state.usage });
    } else if (type === 'config_option_update') {
      const opts = Array.isArray(update.configOptions) ? update.configOptions : [];
      for (const option of opts) {
        if (option && option.id === 'model' && option.currentValue != null) {
          state.model = String(option.currentValue); session.claudeSessionModel = state.model;
        }
      }
      session.kimiAcpConfigOptions = opts;
    } else if (type === 'current_mode_update') {
      session.kimiAcpMode = String(update.currentModeId || '');
    } else if (type === 'available_commands_update') {
      state.availableCommands = Array.isArray(update.availableCommands) ? update.availableCommands
        : (Array.isArray(update.commands) ? update.commands : []);
      session.kimiAcpCommands = state.availableCommands;
    } else if (type === 'session_info_update') {
      session.kimiNativeTitle = update.title == null ? '' : String(update.title);
    } else if (type === 'plan' || type === 'plan_update') {
      state.planTouched = true;
      kimiAcpApplyPlan(update, session, onEvent);
    } else if (type === 'plan_removed') {
      state.planTouched = true;
      session.kimiAcpPlan = null;
      session.todos = [];
      onEvent({ type: 'todo', items: [], source: 'kimi-acp' });
    }
  };

  try {
    await fsp.mkdir(workingDir, { recursive: true }).catch(() => {});
    if (!workspaceTurnBaseline && softwareEngineeringTaskProfile(promptTaskContext).relevant) {
      workspaceTurnBaseline = await captureWorkspaceTurnBaseline(workingDir).catch(() => null);
    }
    onEvent({
      type: 'meta', command: claude, args: ['acp'], cwd: workingDir, model: config.model || '(default)',
      thinkingEffort: config.claudeThinkingEffort || 'default', permissionMode: config.permissionMode,
      historyRecoveryInjected, indexInjected: Boolean(indexInjection), indexHash: indexPayloadHash || undefined,
      memoryCheck: memoryPreflight.status, resumeResetReason: resumeResetReason || undefined,
      resumeRecoveryAttempt: false, agentRoles: [], agentRolesOmitted: [], agentDriver: 'kimi-acp', kimiAcpCompat: Boolean(spawn.kimiAcpCompat),
      agentCliType: 'kimi', agentCliLabel, experimental: Boolean(cliDriver.experimental), cwdWarning: cwdWarn || undefined,
    });
    logEvent({ kind: 'turn_start', traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude', agentDriver: 'kimi-acp', model: config.model || 'default', promptLen: fullPrompt.length });
    await dispatchAgentLoopHooks('beforeModelCall', {
      traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude',
      model: currentClaudeModel || 'default', iteration: 0, resumeRecoveryAttempt: false,
    });
    child = cp.spawn(spawn.command, spawn.args, { cwd: workingDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...spawn.opts });
    reg = {
      child, pid: child.pid, exited: false, pausePending: false, state: 'running', startedAt: Date.now(),
      lastEventAt: Date.now(), interactive: true, onEvent: null, session, kind: 'kimi-acp', traceId: activeTraceId,
      questionContext: '', steerQueue: [], acceptingSteer: true, abort: null,
      nativeSessionId: '', kimiAcpApprovals: [], kimiAcpTerminals: new Map(), kimiAcpTerminalResults: new Map(), kimiAcpElicitations: new Map(),
      kimiAcpWire: { subagents: new Map(), childTools: new Map() },
    };
    reg.onEvent = event => { reg.lastEventAt = Date.now(); onEvent(event); };
    activeChildren.set(session.id, reg);
    onEvent({ type: 'process', state: 'running', pid: child.pid, interactive: true, protocol: 'acp' });
    child.stderr.on('data', chunk => {
      const text = decodeClaudeCliText(chunk);
      stderrText += text;
      markActivity();
      if (text.trim()) onEvent({ type: 'stderr', text: redact(text) });
    });
    const reverseContext = { session, config, onEvent: reg.onEvent, reg, state };
    rpc = createKimiAcpRpc(child, {
      onLine: line => { markActivity(); onEvent({ type: 'raw_line', line, seq: rawSeq++ }); },
      onNotification: (method, params) => {
        if (method === 'session/update') emitUpdate(params);
        else if (method === 'elicitation/complete') {
          const id = String(params && params.elicitationId || '');
          if (id) reg.kimiAcpElicitations.delete(id);
          markActivity();
        }
      },
      onRequest: (method, params, requestMeta) => {
        markActivity();
        if (method === 'session/request_permission') return handleKimiAcpPermissionRequest(params, reverseContext);
        if (method === 'fs/read_text_file' || method === 'fs/write_text_file') return handleKimiAcpFsRequest(method, params, reverseContext);
        if (method.startsWith('terminal/')) return handleKimiAcpTerminalRequest(method, params, reverseContext, requestMeta);
        if (method === 'elicitation/create') return handleKimiAcpElicitation(params, reverseContext, requestMeta);
        throw kimiAcpRequestError(-32601, `Unsupported Kimi ACP reverse request: ${method}`);
      },
      onCancel: (_requestId, method) => {
        markActivity();
        if (method === 'session/request_permission') {
          clearPendingPermissions(session.id, 'Kimi cancelled the permission request');
          clearPendingQuestions(session.id, 'Kimi cancelled the question');
          clearPendingPlans(session.id, 'Kimi cancelled the plan request');
        } else if (method === 'elicitation/create') {
          clearPendingQuestions(session.id, 'Kimi cancelled the elicitation');
        } else if (method === 'terminal/create' || method === 'fs/write_text_file') {
          clearPendingPermissions(session.id, 'Kimi cancelled the operation');
        }
      },
    });
    reg.abort = () => {
      reg.exited = true;
      clearPendingPermissions(session.id, 'Ruyi turn cancelled');
      clearPendingQuestions(session.id, 'Ruyi turn cancelled');
      clearPendingPlans(session.id, 'Ruyi turn cancelled');
      rpc.cancelReverseRequests(new Error('Ruyi turn cancelled'));
      reg.kimiAcpCleanupPromise = cleanupKimiAcpTerminals(reg);
      if (nativeSessionId) rpc.notify('session/cancel', { sessionId: nativeSessionId });
      setTimeout(() => { if (child && child.exitCode == null) killChildTree(child.pid); }, 1200);
    };
    const idleLimitMs = Math.max(1000, Number(process.env.WCW_TURN_IDLE_MS) || config.turnIdleTimeoutMs);
    watchdog = setInterval(() => {
      if (reg.exited || reg.pausePending || Date.now() - reg.lastEventAt <= idleLimitMs) return;
      reg.state = 'watchdog-timeout';
      reg.abort();
    }, Math.min(5000, Math.max(500, Math.floor(idleLimitMs / 4))));

    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'Ruyi Workbench', version: '2.6' },
      clientCapabilities: {
        auth: { terminal: false }, fs: { readTextFile: true, writeTextFile: true }, terminal: true,
        plan: {}, elicitation: { form: {}, url: {} },
      },
    }, 15000);
    session.kimiAcpAgentInfo = initialized && initialized.agentInfo || null;
    session.kimiAcpCapabilities = initialized && initialized.agentCapabilities || null;
    const lifecycle = {
      cwd: workingDir,
      mcpServers: [],
      additionalDirectories: [...new Set((additionalDirectories || []).filter(Boolean))],
    };
    let activated;
    if (config.autoResumeClaudeSessions && session.claudeSessionId) {
      nativeSessionId = String(session.claudeSessionId);
      try {
        activated = await rpc.request('session/resume', { sessionId: nativeSessionId, ...lifecycle }, 30000);
      } catch (error) {
        session.claudeSessionId = null;
        session.injectedIndexHash = null;
        onEvent({ type: 'resume_recovery', reason: 'kimi-session-unavailable', automatic: true });
        activated = await rpc.request('session/new', lifecycle, 30000);
        nativeSessionId = String(activated && activated.sessionId || '');
      }
    } else {
      activated = await rpc.request('session/new', lifecycle, 30000);
      nativeSessionId = String(activated && activated.sessionId || '');
    }
    if (!nativeSessionId) throw new Error('Kimi ACP did not return a sessionId');
    reg.nativeSessionId = nativeSessionId;
    session.claudeSessionId = nativeSessionId;
    session.claudeSessionCwd = workingDir;
    session.claudeSessionRouteKey = currentResumeRouteKey;
    session.kimiAcpConfigOptions = activated && activated.configOptions || [];
    await saveSession(session);
    const applyOption = async (configId, value) => {
      if (value == null || value === '') return;
      try {
        const response = await rpc.request('session/set_config_option', { sessionId: nativeSessionId, configId, value }, 15000);
        if (response && response.configOptions) session.kimiAcpConfigOptions = response.configOptions;
        if (configId === 'model') { state.model = String(value); session.claudeSessionModel = state.model; }
        else if (configId === 'mode') session.kimiAcpMode = String(value);
        else if (configId === 'thinking') session.kimiAcpThinking = String(value);
      } catch (error) {
        onEvent({ type: 'stderr', text: `[Kimi ACP 设置 ${configId}] ${redact(String(error && error.message || error))}` });
      }
    };
    await applyOption('mode', kimiAcpMode(config.permissionMode));
    await applyOption('model', config.model);
    await applyOption('thinking', ['low', 'high', 'max'].includes(config.claudeThinkingEffort) ? config.claudeThinkingEffort : '');
    if (!state.model) state.model = String(config.model || '');
    session.claudeSessionModel = state.model;
    stopKimiWireWatch = watchKimiWire(nativeSessionId, reg.onEvent, session.kimiContextStatus && session.kimiContextStatus.contextWindow, reg.kimiAcpWire);

    const prompts = [fullPrompt];
    while (prompts.length && reg.state === 'running') {
      const prompt = prompts.shift();
      const checkpoint = kimiAcpWireCheckpoint(nativeSessionId);
      const usageTickBefore = state.usageTick;
      const response = await rpc.request('session/prompt', {
        sessionId: nativeSessionId,
        prompt: [{ type: 'text', text: prompt }],
      }, 0);
      if (response && response.usage && typeof response.usage === 'object') state.turnUsage = response.usage;
      state.stopReason = String(response && response.stopReason || 'end_turn');
      // Kimi sends the prompt response as soon as turn.ended settles, then computes usage asynchronously.
      // Give that authoritative update a short event-driven grace before closing the native session.
      for (let attempt = 0; attempt < 10 && state.usageTick === usageTickBefore && reg.state === 'running'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      const wireOutcome = await kimiAcpWireOutcome(nativeSessionId, checkpoint);
      if (wireOutcome && (wireOutcome.reason === 'failed' || wireOutcome.reason === 'blocked')) {
        throw new Error(wireOutcome.error || `Kimi turn ${wireOutcome.reason}`);
      }
      if (state.stopReason === 'cancelled') { if (reg.state === 'running') reg.state = 'cancelled'; break; }
      if (state.stopReason === 'refusal') throw new Error('Kimi 拒绝了本次请求');
      if (reg.steerQueue.length) {
        const steers = reg.steerQueue.splice(0, reg.steerQueue.length);
        for (const text of steers) {
          session.messages.push({ role: 'user', content: text, turnSeq: session.turnSeq, steered: true, createdAt: nowIso() });
          onEvent({ type: 'steered', text, queued: false, protocol: 'kimi-acp-followup' });
          prompts.push(`[用户插话] ${text}\n\n请在同一会话中结合刚才已完成的工作继续处理这条补充指令。`);
        }
        await saveSession(session);
      } else reg.acceptingSteer = false;
    }
  } catch (error) {
    state.error = error;
  } finally {
    if (watchdog) clearInterval(watchdog);
    stopKimiWireWatch();
    clearPendingPermissions(session.id, 'turn ended');
    clearPendingQuestions(session.id, 'turn ended');
    clearPendingPlans(session.id, 'turn ended');
    if (rpc) rpc.cancelReverseRequests(new Error('Kimi ACP turn ended'));
    if (reg && reg.kimiAcpCleanupPromise) await reg.kimiAcpCleanupPromise;
    if (reg) await cleanupKimiAcpTerminals(reg);
    if (child) await closeKimiAcpProcess(child, rpc, nativeSessionId);
    if (activeChildren.get(session.id) === reg) activeChildren.delete(session.id);
  }

  const wasStopped = Boolean(reg && reg.state !== 'running');
  // ACP 0.37+ emits authoritative used/size after every turn. Only fall back to wire/Server API when an
  // older adapter omitted that update; otherwise starting a separate Web bridge adds latency and can read a
  // stale pre-close snapshot.
  if (nativeSessionId && !state.usage) {
    const measured = await syncKimiSessionUsage(session, config, onEvent).catch(() => null);
    if (measured) state.usage = measured;
  }
  if (state.turnUsage) {
    if (state.usage) state.usage.usage = state.turnUsage;
    else state.usage = {
      usage: state.turnUsage, model: state.model,
      contextEngine: 'agent', contextAgentCliType: 'kimi', contextModel: state.model, source: 'kimi-acp',
    };
  }
  const errorText = state.error ? friendlyKimiAcpError(state.error) : '';
  const finalText = state.assistantText.trim() || (errorText ? `${agentCliLabel} ACP 调用失败：\n${errorText}` : '');
  await reconcileWorkspaceTurnBaseline(workspaceTurnBaseline, session.id, session.turnSeq).catch(() => {});
  const turnJournal = (await journalReadIndex(session.id)).filter(entry => entry && Number(entry.turnSeq) === Number(session.turnSeq));
  const cleanToolCalls = state.toolCalls.map(({ __settled, ...toolCall }) => toolCall);
  const turnSummary = buildTurnSummary(session.turnSeq, cleanToolCalls, 'claude', turnJournal);
  const turnOk = !state.error && !wasStopped;
  if (agentRecoverySummary && turnOk) { delete session.agentRecoverySummary; delete session.agentRecoverySource; }
  turnSegments.finalizeAll(wasStopped ? '回合被停止,进行中的工具已中断' : '回合结束,进行中的工具未完成');
  session.messages.push({
    role: 'assistant', content: finalText, turnSeq: session.turnSeq, thinking: state.thinkingText.trim() || undefined,
    toolCalls: cleanToolCalls.length ? cleanToolCalls : undefined, segments: turnSegments.snapshot(), turnSummary,
    usage: state.usage || undefined, traceId: activeTraceId, createdAt: nowIso(),
    source: wasStopped ? 'aborted' : 'kimi-acp', engine: 'claude', agentCliType: 'kimi', agentCliLabel,
    model: state.model || config.model || '', exitCode: turnOk ? 0 : 1,
  });
  if (stderrText.trim()) session.messages.push({ role: 'system', content: redact(stderrText.trim()), createdAt: nowIso(), source: 'stderr' });
  if (isUntitledSessionTitle(session.title)) session.title = message.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Session';
  session.summary = finalText.replace(/\s+/g, ' ').trim().slice(0, 160) || session.summary || '';
  try {
    const onDisk = await loadSession(session.id);
    if (!state.planTouched && onDisk && Array.isArray(onDisk.todos)) session.todos = onDisk.todos;
    if (onDisk && Array.isArray(onDisk.skills)) session.skills = onDisk.skills;
    if (onDisk && Array.isArray(onDisk.memories)) session.memories = onDisk.memories;
    if (onDisk && typeof onDisk.memoriesExplicit === 'boolean') session.memoriesExplicit = onDisk.memoriesExplicit;
    if (onDisk && Array.isArray(onDisk.memoryExclusions)) session.memoryExclusions = onDisk.memoryExclusions;
    if (onDisk && onDisk.mission && typeof onDisk.mission === 'object') session.mission = onDisk.mission;
  } catch { /* keep in-memory */ }
  if (session.__missionFinalizeHow) {
    const how = session.__missionFinalizeHow; delete session.__missionFinalizeHow;
    try { if (await finalizeMissionAfterTurn(session, how)) onEvent({ type: 'mission', mission: session.mission }); } catch { /* ignore */ }
  }
  await saveSession(session);
  if (session.mission) await bumpMissionChangeSeq(session.id, {
    type: turnOk || wasStopped ? 'progress' : 'failure', cursor: { turnSeq: session.turnSeq, engine: 'claude' },
    detail: { ok: turnOk, aborted: wasStopped, errorClass: turnOk || wasStopped ? '' : 'kimi_acp_error', filesChanged: turnSummary.filesChanged.length, artifacts: turnSummary.artifacts.length, commands: Number(turnSummary.commands) || 0 },
  });
  if (!turnOk && !wasStopped) await dispatchAgentLoopHooks('onError', {
    traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude',
    model: state.model || currentClaudeModel || 'default', exitCode: 1, errorClass: 'kimi_acp_error', error: redact(errorText).slice(0, 1000),
  });
  await dispatchAgentLoopHooks('onTurnEnd', {
    traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude',
    model: state.model || currentClaudeModel || 'default', ok: turnOk, aborted: wasStopped, exitCode: turnOk ? 0 : 1,
    durationMs: Date.now() - turnStartedAt, replyLength: finalText.length, toolCalls: cleanToolCalls.length,
    usage: state.usage && state.usage.usage ? { ...state.usage.usage } : undefined,
  });
  logEvent({ kind: 'turn_end', traceId: activeTraceId, sessionId: session.id, turnSeq: session.turnSeq, engine: 'claude', agentDriver: 'kimi-acp', ok: turnOk, exitCode: turnOk ? 0 : 1, replyLen: finalText.length, tools: cleanToolCalls.length, aborted: wasStopped, durationMs: Date.now() - turnStartedAt });
  onEvent({ type: 'turn_summary', ...turnSummary });
  onEvent({ type: 'process', state: wasStopped ? 'stopped' : 'idle' });
  onEvent({ type: 'result', ok: turnOk, exitCode: turnOk ? 0 : 1, aborted: wasStopped, error: !turnOk && !wasStopped ? redact(errorText).slice(0, 2000) : undefined });
}
