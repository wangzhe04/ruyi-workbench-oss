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

function kimiWireFile(nativeSessionId) {
  try {
    const indexFile = path.join(kimiCodeHome(), 'session_index.jsonl');
    const lines = fs.readFileSync(indexFile, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = safeJsonParse(lines[i]);
      if (row && row.sessionId === nativeSessionId && row.sessionDir) return path.join(row.sessionDir, 'agents', 'main', 'wire.jsonl');
    }
  } catch { /* absent native index */ }
  return '';
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

function watchKimiWire(nativeSessionId, onEvent, contextWindow) {
  const file = kimiWireFile(nativeSessionId);
  if (!file || !fs.existsSync(file)) return () => {};
  let offset = fs.statSync(file).size;
  let pending = '';
  let reading = false;
  const timer = setInterval(async () => {
    if (reading) return;
    reading = true;
    try {
      const size = (await fsp.stat(file)).size;
      if (size < offset) { offset = 0; pending = ''; }
      if (size > offset) {
        const handle = await fsp.open(file, 'r');
        try {
          const buffer = Buffer.alloc(size - offset);
          await handle.read(buffer, 0, buffer.length, offset);
          offset = size;
          const lines = (pending + buffer.toString('utf8')).split(/\r?\n/);
          pending = lines.pop() || '';
          for (const line of lines) {
            const event = parseKimiWireCompaction(safeJsonParse(line), contextWindow);
            if (event) onEvent(event);
          }
        } finally { await handle.close(); }
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
  const write = payload => {
    if (closed || !child.stdin || child.stdin.destroyed) throw new Error('Kimi ACP input channel is closed');
    child.stdin.write(JSON.stringify(payload) + '\n', 'utf8');
  };
  const rejectPending = error => {
    for (const [, item] of pending) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
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
      Promise.resolve().then(() => handlers.onRequest ? handlers.onRequest(message.method, message.params || {}) : {})
        .then(result => write({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result }))
        .catch(error => {
          try { write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error && error.message || error) } }); } catch { /* transport gone */ }
        });
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
    return allow
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } };
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
  const spawn = prepareAgentCliSpawn('kimi', claude, ['acp']);
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
        if (update.title) record.name = String(update.title);
        if (update.rawInput && typeof update.rawInput === 'object') record.input = update.rawInput;
      }
      const status = String(update.status || '');
      if ((status === 'completed' || status === 'failed') && !record.__settled) {
        record.__settled = true;
        record.result = update.rawOutput !== undefined ? update.rawOutput : kimiAcpContentText(update.content);
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
      resumeRecoveryAttempt: false, agentRoles: [], agentRolesOmitted: [], agentDriver: 'kimi-acp',
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
      onNotification: (method, params) => { if (method === 'session/update') emitUpdate(params); },
      onRequest: (method, params) => {
        markActivity();
        if (method === 'session/request_permission') return handleKimiAcpPermissionRequest(params, reverseContext);
        throw new Error(`Unsupported Kimi ACP reverse request: ${method}`);
      },
    });
    reg.abort = () => {
      reg.exited = true;
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
        auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false,
        planCapabilities: {},
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
    stopKimiWireWatch = watchKimiWire(nativeSessionId, reg.onEvent, session.kimiContextStatus && session.kimiContextStatus.contextWindow);

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
