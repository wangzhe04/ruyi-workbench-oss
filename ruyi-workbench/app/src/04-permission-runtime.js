// ── v0.9-S7 视觉回路 (§0.9-S7 / 总纲 §7.5) ────────────────────────────────────────────────────────────
// Image-part plumbing for the provider (OpenAI-compat) engine. Two entry points feed the model images:
//   (1) image ATTACHMENTS on a user turn (buildUserContentParts, runOpenAiTurn) — vision=true only;
//   (2) tool SCREENSHOTS surfaced by a bridged desktop tool (extractToolImages + the tool-loop tail).
// Both obey the pairing/continuity铁律: an image is ONLY ever added inside a `role:'user'` message, and a
// tool screenshot's user message is appended AFTER the whole tool batch closes (never wedged in a block).
// HISTORY保图≤2 (pruneOldImages) bounds visual-history膨胀 by demoting the OLDEST image parts to text.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;   // attachment extensions we send as image parts
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const IMAGE_ATTACH_MAX = 5 * 1024 * 1024;   // ≤5MB/张; larger → text占位 (avoid history膨胀 / request bloat)
const HISTORY_IMAGE_KEEP = 2;               // 保图≤2: at most this many image_url parts survive in history

function attachmentMime(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && IMAGE_MIME[m[1]]) || 'image/png';
}
// Build the OpenAI `content` PARTS array for a user turn that carries image attachments (vision path).
// Text part first (the same string buildAttachmentPrompt produced), then one image_url part per image
// attachment whose file reads back ≤5MB. An oversize/unreadable image degrades to an inline text占位 (so
// the model still knows an image was attached but nothing bloats the request). Non-image attachments are
// already described in the text part; they are NOT re-read here. Returns a parts array. Never throws.
async function buildUserContentParts(textContent, attachments) {
  const parts = [{ type: 'text', text: String(textContent || '') }];
  for (const a of (attachments || [])) {
    if (!a || !a.path || !IMAGE_EXT_RE.test(String(a.name || a.path))) continue;
    try {
      const st = await fsp.stat(a.path);
      if (st.size > IMAGE_ATTACH_MAX) { parts[0].text += `\n[图片过大未发送:${a.name || path.basename(a.path)}]`; continue; }
      const buf = await fsp.readFile(a.path);
      const uri = `data:${attachmentMime(a.name || a.path)};base64,${buf.toString('base64')}`;
      parts.push({ type: 'image_url', image_url: { url: uri } });
    } catch { parts[0].text += `\n[图片读取失败:${a.name || path.basename(a.path)}]`; }
  }
  return parts;
}
// Does a user turn carry at least one image attachment worth sending as a part? (Gate for parts-vs-string.)
function hasImageAttachment(attachments) {
  return Array.isArray(attachments) && attachments.some(a => a && a.path && IMAGE_EXT_RE.test(String(a.name || a.path)));
}
// Pull screenshot image(s) out of a bridged tool result. Desktop MCP (ACC v1.4) may surface a screenshot as
// `image` / `image_base64` (base64 or data URI) or nested under `screenshot.image`. Returns an array of data
// URIs (0..n). The base64 is assumed PNG unless it is already a data: URI. Pure read — does NOT mutate result.
function extractToolImages(resultObj) {
  if (!resultObj || typeof resultObj !== 'object') return [];
  const out = [];
  const push = v => {
    if (typeof v !== 'string' || !v) return;
    out.push(v.startsWith('data:') ? v : `data:image/png;base64,${v}`);
  };
  push(resultObj.image);
  push(resultObj.image_base64);
  if (resultObj.screenshot && typeof resultObj.screenshot === 'object') push(resultObj.screenshot.image);
  return out;
}
// Strip the heavy image field(s) out of a tool result BEFORE it is serialized into a `role:'tool'` message,
// replacing each with a compact占位 so the tool-result JSON stays精简 (the actual pixels ride in a separate
// user image message, appended after the batch). Returns a SHALLOW clone with the image fields占位ed; the
// original object (used for the UI event) is untouched. Only called when we DID extract ≥1 image AND vision是开的.
function stripToolImageFields(resultObj) {
  if (!resultObj || typeof resultObj !== 'object') return resultObj;
  const clone = { ...resultObj };
  if (typeof clone.image === 'string') clone.image = '[截图见随后的图片消息]';
  if (typeof clone.image_base64 === 'string') clone.image_base64 = '[截图见随后的图片消息]';
  if (clone.screenshot && typeof clone.screenshot === 'object' && typeof clone.screenshot.image === 'string') {
    clone.screenshot = { ...clone.screenshot, image: '[截图见随后的图片消息]' };
  }
  return clone;
}
// 保图≤2 (§0.9-S7): after injecting a new image message, walk providerHistory and demote the OLDEST
// image_url parts down to a text占位 so at most HISTORY_IMAGE_KEEP(2) survive. We ONLY rewrite parts INSIDE a
// user message's content array — we NEVER delete a message, so the pairing铁律 (every tool_call_id answered)
// is untouched. Idempotent: an already-demoted slot is a plain text part and no longer counts as an image.
// Returns the number of images demoted this pass (0 = under the cap). Mirrors evaporateHistory's cache-safety
// note: this rewrites old content, so it runs ONLY right after a new image lands (never speculatively).
function pruneOldImages(history) {
  if (!Array.isArray(history)) return 0;
  // Collect every (messageIndex, partIndex) that is currently an image_url part, oldest-first.
  const slots = [];
  for (let mi = 0; mi < history.length; mi++) {
    const c = history[mi] && history[mi].content;
    if (!Array.isArray(c)) continue;
    for (let pi = 0; pi < c.length; pi++) {
      const p = c[pi];
      if (p && (p.type === 'image_url' || p.image_url || p.type === 'image')) slots.push([mi, pi]);
    }
  }
  if (slots.length <= HISTORY_IMAGE_KEEP) return 0;
  const demoteCount = slots.length - HISTORY_IMAGE_KEEP;
  let demoted = 0;
  for (let k = 0; k < demoteCount; k++) {
    const [mi, pi] = slots[k];
    history[mi].content[pi] = { type: 'text', text: `[截图已淘汰:${k + 1}]` };
    demoted++;
  }
  return demoted;
}

async function makeAttachmentRecord(input) {
  await ensureDirs();
  const id = makeId('file');
  const safeName = path.basename(input.name || 'upload.bin').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const targetDir = path.join(paths.uploads, id);
  await fsp.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, safeName);
  const base64 = String(input.data || '').includes(',')
    ? String(input.data).split(',').pop()
    : String(input.data || '');
  const buffer = Buffer.from(base64, 'base64');
  await fsp.writeFile(target, buffer);

  let textPreview = '';
  const textLike = /\.(txt|md|json|js|ts|tsx|jsx|py|ps1|bat|cmd|csv|xml|html|css|yaml|yml|ini|log)$/i.test(safeName);
  if (textLike && buffer.length <= 256 * 1024) {
    textPreview = buffer.toString('utf8').slice(0, 12000);
  }
  return {
    id,
    name: safeName,
    path: target,
    size: buffer.length,
    createdAt: nowIso(),
    textPreview,
  };
}

// --- Secret redaction (unconditional, CLI-independent). Redacts DISPLAY copy only, never the
// executed string. Purpose-built patterns, not the quoted-only code_review_scan regex. ---
const REDACT_PATTERNS = [
  /\b(sk-[A-Za-z0-9]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
  /\b((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)\s*[:=]\s*)([^\s"']{6,})/gi,
  /\b([A-Fa-f0-9]{40,})\b/g, // long hex blobs
];
function redact(input) {
  let s = String(input == null ? '' : input);
  for (const re of REDACT_PATTERNS) {
    re.lastIndex = 0;
    // replace passes (match, p1, …, pN, offset, string). For a label+value pattern (2 capture groups: the
    // `apiKey=`-style label and the secret value) we keep the label and redact only the value. For a
    // single-capture secret pattern (sk-…, ghp_…, JWT, hex blob) we replace the WHOLE match with the marker.
    // (Bugfix: the old `(m,a,b)=> b===undefined?…:`${a}…`` treated the numeric offset as a 2nd group, so
    // single-group secrets leaked as `secret«redacted»`. Detecting group count via arguments fixes it.)
    s = s.replace(re, function () {
      const args = Array.from(arguments);
      // Trailing args are offset(number) then optionally the full string; strip them to get capture groups.
      let end = args.length;
      if (typeof args[end - 1] === 'string' && typeof args[end - 2] === 'number') end -= 2; // …, offset, string
      else if (typeof args[end - 1] === 'number') end -= 1;                                  // …, offset
      const groups = args.slice(1, end); // capture groups only (args[0] is the full match)
      // Two capture groups → label + value: keep the label, redact the value.
      if (groups.length >= 2 && groups[1] !== undefined) return `${groups[0]}«redacted»`;
      return '«redacted»';
    });
  }
  return s;
}

// --- Structured NDJSON logging: record lengths/metadata, never raw content. ---
let logStream = null;
let logStreamDay = '';
function logEvent(record) {
  try {
    const day = nowIso().slice(0, 10);
    if (day !== logStreamDay && logStream) {
      logStream.end();
      logStream = null;
    }
    if (!logStream) {
      logStreamDay = day;
      logStream = fs.createWriteStream(path.join(paths.logs, `workbench-${day}.ndjson`), { flags: 'a' });
      logStream.on('error', () => { logStream = null; });
    }
    logStream.write(`${JSON.stringify({ ts: nowIso(), ...record })}\n`);
  } catch {
    // logging must never break a turn
  }
}

// --- Active claude child registry keyed by session id, for stop/restart/interrupt + disconnect kill. ---
const activeChildren = new Map(); // sessionId -> { child, pid, state, startedAt, lastEventAt, interactive, onEvent }
// --- Pending tool-permission prompts awaiting a UI decision (v3 bridge). ---
const pendingPermissions = new Map(); // requestId -> { resolve, sessionId, timer }
// Questions are a real turn boundary, not a fire-and-forget notification. Both the Provider tool loop and
// the Claude MCP bridge wait on this registry; /api/chat/answer settles exactly one matching entry.
const pendingQuestions = new Map(); // questionId -> { sessionId, questions, timer, deliver }
// v0.9-S5: pending PLAN approvals awaiting a UI decision (真流程 plan mode). Mirrors pendingPermissions:
// planId -> { resolve, sessionId, timer }. runOpenAiTurn (plan mode, provider engine) emits a `plan` event
// after the model's first PLAN: message and PAUSES the turn awaiting /api/plan/decision. resolve() settles
// with { decision:'approve'|'reject', note? }; the timeout auto-rejects (same permissionTimeoutMs budget).
const pendingPlans = new Map(); // planId -> { resolve, sessionId, timer }
// 第27f波:当前处于【无人值守(driverAuto)回合】的会话集 —— provider 路径直接用闭包 driverAuto,但 CLI 桥(Claude 子进程
// loopback 的 /api/permission/request)拿不到 driverAuto,故用此集判定。runClaudeTurn 的 driverAuto 回合进出维护。纯内存。
const driverAutoSessions = new Set();

function killChildTree(pid) {
  if (!pid) return;
  try {
    // Windows: child.kill()/SIGTERM does not reap the grandchildren (MCP servers, shells).
    // taskkill /T kills the whole tree, /F forces it.
    cp.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// 47b 桥超时契约:按工具声明式超时表(裸名小写)。默认 120s;长时工具按其自身参数上限放宽 ——
// ACC run_command timeout cap 600s / launch_application wait_timeout cap 600s,桥给 650s(含网络缓冲),
// 消灭"桥先 120s 死、ACC 侧 600s 任务变僵尸"的契约错位(03 方案 Phase A 核心项)。
// WCW_BRIDGED_TIMEOUT_OVERRIDE='name:ms,name:ms' 是测试缝(e2e 把秒级超时打进 fake 工具)。
const BRIDGED_TOOL_TIMEOUTS = {
  run_command: 650000,
  launch_application: 650000,
  macro_run: 300000,
};
const BRIDGED_TOOL_TIMEOUT_DEFAULT_MS = 120000;
function bridgedToolTimeoutMs(name) {
  const bare = String(name || '').toLowerCase();
  const ov = String(process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE || '');
  for (const pair of ov.split(',')) {
    const [k, v] = pair.split(':').map(s => String(s || '').trim());
    if (k && k.toLowerCase() === bare && Number(v) > 0) return Number(v);
  }
  return BRIDGED_TOOL_TIMEOUTS[bare] || BRIDGED_TOOL_TIMEOUT_DEFAULT_MS;
}

function clearPendingPermissions(sessionId, message) {
  for (const [rid, p] of pendingPermissions) {
    if (p.sessionId === sessionId) {
      clearTimeout(p.timer);
      pendingPermissions.delete(rid);
      try { p.resolve({ behavior: 'deny', message: message || 'session ended' }); } catch { /* already settled */ }
    }
  }
}

function normalizeUserQuestions(raw) {
  const source = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.questions) ? raw.questions : [raw]);
  return source.filter(q => q && typeof q === 'object').slice(0, 3).map((q, index) => ({
    header: String(q.header || '').trim().slice(0, 80),
    question: String(q.question || q.header || `Question ${index + 1}`).trim().slice(0, 1000),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 12).map(opt => {
      if (typeof opt === 'string') return { label: opt.slice(0, 200) };
      return {
        label: String((opt && (opt.label || opt.value)) || '').trim().slice(0, 200),
        description: String((opt && opt.description) || '').trim().slice(0, 500),
      };
    }).filter(opt => opt.label),
  })).filter(q => q.question);
}

function normalizeQuestionAnswer(body) {
  const answers = (Array.isArray(body && body.answers) ? body.answers : []).slice(0, 3).map(row => ({
    question: String((row && row.question) || '').slice(0, 1000),
    answer: (Array.isArray(row && row.answer) ? row.answer : [row && row.answer])
      .filter(v => v != null && String(v).trim()).slice(0, 12).map(v => String(v).slice(0, 2000)),
  }));
  const content = String((body && body.content) ?? answers.map(a => `${a.question}: ${a.answer.join(', ')}`).join('\n')).slice(0, 12000);
  return { ok: !(body && body.isError), answers, content };
}

function formatQuestionGuidance(answer) {
  const text = String((answer && answer.content) || '').trim() || '(user supplied no answer)';
  return `<workbench_user_answer>\n${text}\n</workbench_user_answer>\nContinue the current task using this answer. Do not ask the same question again.`;
}

function registerUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs, deliver) {
  // Provider call ids are often reused as "call_1" across sessions, so never use them as registry keys.
  const sourceId = String(questionId || '');
  const id = makeId('question');
  const normalized = normalizeUserQuestions(questions);
  if (!normalized.length) return null;
  const entry = { sessionId, questions: normalized, timer: null, deliver: null };
  entry.deliver = answer => {
    if (pendingQuestions.get(id) !== entry) return false;
    let accepted = false;
    try { accepted = deliver(answer) !== false; } catch { accepted = false; }
    if (!accepted) return false;
    clearTimeout(entry.timer);
    pendingQuestions.delete(id);
    return true;
  };
  entry.timer = setTimeout(() => {
    if (pendingQuestions.get(id) !== entry) return;
    entry.deliver({ ok: false, answers: [], content: '(question timed out)' });
  }, Math.max(5000, Number(timeoutMs) || 120000));
  pendingQuestions.set(id, entry);
  onEvent({ type: 'ask_user', id, questionId: id, toolUseId: sourceId || undefined, questions: normalized });
  return id;
}

function requestUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs) {
  return new Promise(resolve => {
    const id = registerUserQuestion(sessionId, questionId, questions, onEvent, timeoutMs, answer => { resolve(answer); return true; });
    if (!id) resolve({ ok: false, answers: [], content: '', error: 'no valid questions' });
  });
}

function clearPendingQuestions(sessionId, message) {
  for (const [qid, q] of pendingQuestions) {
    if (q.sessionId !== sessionId) continue;
    try { q.deliver({ ok: false, answers: [], content: message || 'session ended' }); } catch { /* already settled */ }
    clearTimeout(q.timer);
    pendingQuestions.delete(qid);
  }
}

// 47a(Steer Phase A 分流纪律):会话当前是否有等待回答的 AskUser 提问。Claude 引擎的提问答案与插话同走
// stdin user envelope —— 提问挂起期间注入插话,CLI 可能把插话误收为答案(串扰)。/api/steer 据此拒绝。
function hasPendingQuestionForSession(sessionId) {
  for (const [, q] of pendingQuestions) if (q.sessionId === sessionId) return true;
  return false;
}

// v0.9-S5: clear any pending PLAN approvals for a session (abort/stop/turn-end), resolving each as a REJECT
// so the paused runOpenAiTurn unblocks and finishes cleanly (never left hanging). Mirrors
// clearPendingPermissions — called from stopSession (abort/stop) and at turn end.
function clearPendingPlans(sessionId, message) {
  for (const [pid, p] of pendingPlans) {
    if (p.sessionId === sessionId) {
      clearTimeout(p.timer);
      pendingPlans.delete(pid);
      try { p.resolve({ decision: 'reject', note: message || 'session ended' }); } catch { /* already settled */ }
    }
  }
}

// ===================================================================================================
// v0.7d — zero-dependency MCP stdio client. Bridges an external stdio MCP server (e.g. the user's
// ai-computer-control desktop MCP) into the workbench so the NATIVE provider tool loop can call it.
// Protocol: JSON-RPC 2.0 over newline-delimited stdout (MCP 2024-11-05). All errors are internalized;
// a crashing/hung child can never take down the web server.
// ===================================================================================================
class McpStdioClient {
  constructor({ id, command, args, cwd, env }) {
    this.id = id;
    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.cwd = cwd || undefined;
    this.env = env || {};
    this.child = null;
    this.pid = null;
    this.dead = false;
    this.started = false;
    this.tools = [];
    this._buf = '';
    this._nextId = 1;
    this._pending = new Map();   // rpc id -> { resolve, timer }
    this._stderr = '';
  }

  // Send one JSON-RPC request and await its result (by id). Rejects on timeout/child death.
  _rpc(method, params, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (this.dead || !this.child || !this.child.stdin || !this.child.stdin.writable) {
        return reject(new Error('mcp client not running'));
      }
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // 47b 桥 cancel 契约:tools/call 超时先按 MCP 标准发 notifications/cancelled(对端若实现协作式取消
        // 可收手);真正的兜底是 callTool catch 里的 kill 进程树(ACC 侧不响应取消也不留僵尸执行)。
        if (method === 'tools/call') { try { this._notify('notifications/cancelled', { requestId: id, reason: 'timeout' }); } catch { /* best-effort */ } }
        reject(new Error(`mcp ${method} timed out`));
      }, Math.max(1000, timeoutMs));
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n', 'utf8');
      } catch (e) {
        clearTimeout(timer); this._pending.delete(id); reject(e);
      }
    });
  }
  // Fire-and-forget notification (no id, no response expected).
  _notify(method, params) {
    if (this.dead || !this.child || !this.child.stdin || !this.child.stdin.writable) return;
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n', 'utf8'); } catch { /* ignore */ }
  }
  _onLine(line) {
    line = line.trim();
    if (!line) return;
    const msg = safeJsonParse(line);
    if (!msg || msg.id == null) return;          // notifications/logs from the server: ignore
    const p = this._pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || 'mcp error'));
    else p.resolve(msg.result);
  }
  _failAllPending(err) {
    for (const [, p] of this._pending) { clearTimeout(p.timer); try { p.reject(err); } catch { /* settled */ } }
    this._pending.clear();
  }

  // Spawn + handshake (initialize -> notifications/initialized -> tools/list). Throws on failure and
  // leaves the client marked dead (caller caches the failure so it won't respawn in a tight loop).
  async start() {
    if (this.started) return;
    this.started = true;
    const s = batchSafeSpawn(this.command, this.args);   // transparently wrap .cmd/.bat
    let child;
    try {
      child = cp.spawn(s.command, s.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...s.opts,
      });
    } catch (e) {
      this.dead = true;
      throw new Error(`spawn failed: ${e && e.message ? e.message : e}`);
    }
    this.child = child;
    this.pid = child.pid;
    // Don't let the live MCP child keep the event loop from exiting on a clean shutdown; we reap it
    // explicitly via killAllMcpClients()/killChildTree on exit.
    try { child.unref(); } catch { /* ignore */ }
    child.on('error', e => { this.dead = true; this._failAllPending(new Error('mcp child error: ' + (e && e.message))); });
    child.on('exit', () => { this.dead = true; this._failAllPending(new Error('mcp child exited')); });
    // EPIPE on stdin must not crash the process.
    if (child.stdin) child.stdin.on('error', () => { /* ignore broken pipe */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this._buf += chunk;
      let nl;
      while ((nl = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, nl);
        this._buf = this._buf.slice(nl + 1);
        try { this._onLine(line); } catch { /* never let a bad line throw */ }
      }
      if (this._buf.length > 4 * 1024 * 1024) this._buf = this._buf.slice(-1024 * 1024); // bound a runaway line
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { if (this._stderr.length < 8000) this._stderr += d; });

    try {
      const init = await this._rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'win-claude-workbench', version: VERSION }, // 【存量兼容标识】MCP 客户端标识名保持旧名(与 server id 一致)
      }, 8000);
      this.serverInfo = (init && init.serverInfo) || {};
      this._notify('notifications/initialized', {});
      const listed = await this._rpc('tools/list', {}, 8000);
      this.tools = (listed && Array.isArray(listed.tools)) ? listed.tools : [];
    } catch (e) {
      this.kill();
      this.dead = true;
      throw new Error(`handshake failed: ${e && e.message ? e.message : e}${this._stderr ? ' | stderr: ' + this._stderr.slice(0, 300) : ''}`);
    }
    return this;
  }

  listTools() { return this.tools; }

  // Call a tool and normalize the MCP result into a workbench result object. Never throws.
  // 47b:超时走契约化处理 —— notifications/cancelled(_rpc 内已发)+ kill 客户端进程树(无僵尸执行),
  // 下次调用由 mcpClients 惰性重 spawn。错误文本如实告知"已杀进程树"。
  async callTool(name, args, timeoutMs) {
    const limit = Math.max(1000, Number(timeoutMs) || bridgedToolTimeoutMs(name));
    try {
      const res = await this._rpc('tools/call', { name, arguments: args || {} }, limit);
      const isError = !!(res && res.isError);
      // Prefer the first text content block; parse it as JSON when it is JSON (desktop MCP returns {ok,...}).
      let textOut = '';
      if (res && Array.isArray(res.content)) {
        const t = res.content.find(c => c && c.type === 'text' && typeof c.text === 'string');
        if (t) textOut = t.text;
      }
      if (textOut) {
        const parsed = safeJsonParse(textOut, undefined);
        if (parsed && typeof parsed === 'object') {
          // Respect an explicit ok flag from the tool; otherwise derive from isError.
          if (typeof parsed.ok === 'boolean') return parsed;
          return { ok: !isError, ...parsed };
        }
        return { ok: !isError, text: textOut };
      }
      return { ok: !isError, content: (res && res.content) || [] };
    } catch (e) {
      const m = (e && e.message) ? e.message : String(e);
      if (/timed out/.test(m)) {
        // 47b:超时即杀桥进程树 —— 旧行为是桥先超时、ACC 继续僵尸执行(用户"纠偏"后旧命令仍在后台写文件,
        // 比不能打断更危险)。cancelled 通知已在 _rpc 超时点发出;此处保证无论对端是否协作取消都不留活口。
        try { this.kill(); } catch { /* already dead */ }
        return { ok: false, error: `tool timed out after ${Math.round(limit / 1000)}s; 桥接进程树已终止(防僵尸执行),下次调用将自动重连` };
      }
      return { ok: false, error: m };
    }
  }

  kill() {
    this.dead = true;
    this._failAllPending(new Error('mcp client killed'));
    try { if (this.child && this.child.stdin) this.child.stdin.end(); } catch { /* ignore */ }
    if (this.pid) killChildTree(this.pid);
    this.child = null;
  }
}

// Live bridged-client registry (shared across turns). Lazy start; a failed start is cached as a
// negative entry (with a timestamp) so we don't respawn a broken server on every single turn.
const mcpClients = new Map();       // serverId -> McpStdioClient
const mcpClientFailures = new Map(); // serverId -> { at, error }
const MCP_FAILURE_COOLDOWN_MS = 60000;

// ============================================================================
// v1.1-W2 (T2) — MCP drop-in 自动扫描。
// ============================================================================
// 扫描两个位置的 `*/ruyi-mcp.json` 清单并「运行时合并」进 externalMcpServers 视图(见 resolveExternalMcpServers):
//   ① <repo>/mcp/*/ruyi-mcp.json      —— 随发行包分发的即插即用连接器(externalRoot()/mcp)。
//   ② <dataRoot>/mcp/*/ruyi-mcp.json  —— 用户自装(dataRoot()/mcp)。
// 与 /api/mcp/import-folder(v1.0.2-S5)的关系【互补,非重复】:
//   • import-folder 走「持久化」路径 —— 把清单写进 config.externalMcpServers(删条目=卸载,重启保留)。
//   • drop-in 走「运行时合并」路径 —— 绝不写回 config;存在性由文件夹本身表达,删文件夹即卸载。
//   两者互不覆盖:id 冲突时 config 里的显式条目(含 import-folder 写入的)优先,drop-in 跳过并审计一条 warn。
// cwd 缺省 = 清单所在文件夹(与 import-folder 同语义)。drop-in 数量上限 10。
// 同步 I/O(readdirSync/readFileSync):调用点是请求期且频繁,故加 2s 缓存;扫描量小(≤两目录各 ≤10 子文件夹)。
const MCP_DROPIN_MAX = 10;
let _dropInCache = { at: 0, list: null };
const MCP_DROPIN_CACHE_MS = 2000;
function mcpDropInDirs() {
  return [
    { root: path.join(externalRoot(), 'mcp'), source: 'repo' },
    { root: path.join(dataRoot(), 'mcp'), source: 'dataRoot' },
  ];
}
// 扫描并返回清洗后的 drop-in 条目数组 [{id,label,command,args,cwd,env,enabled,_dropInSource}]。纯读盘,不改 config。
// 坏清单(缺失/超限/解析失败/清洗后无效)静默跳过(审计一条 warn),绝不抛。总数封顶 MCP_DROPIN_MAX。
function scanMcpDropIns() {
  const now = Date.now();
  if (_dropInCache.list && (now - _dropInCache.at) < MCP_DROPIN_CACHE_MS) return _dropInCache.list;
  const out = [];
  const seen = new Set();
  for (const { root, source } of mcpDropInDirs()) {
    let subdirs;
    try { subdirs = fs.readdirSync(root, { withFileTypes: true }); }
    catch { continue; } // mcp/ 目录不存在 → 正常,跳过
    for (const ent of subdirs) {
      if (out.length >= MCP_DROPIN_MAX) break;
      if (!ent.isDirectory()) continue;
      const folder = path.join(root, ent.name);
      const manifestPath = path.join(folder, 'ruyi-mcp.json');
      let raw = null;
      try {
        const st = fs.statSync(manifestPath);
        if (!st.isFile() || st.size > 32 * 1024) throw new Error('too large / not a file');
        raw = safeJsonParse(fs.readFileSync(manifestPath, 'utf8'), null);
      } catch { continue; } // 无清单 → 该文件夹不是 drop-in,跳过(不审计,常态)
      if (!raw || typeof raw !== 'object') { logEvent({ kind: 'mcp_dropin_skip', reason: 'bad-manifest', folder, source }); continue; }
      // cwd 缺省 = 清单所在文件夹(与 import-folder 同)。
      const withCwd = { ...raw, cwd: (typeof raw.cwd === 'string' && raw.cwd.trim()) ? raw.cwd : folder };
      const cleaned = sanitizeExternalMcpServer(withCwd);
      if (!cleaned) { logEvent({ kind: 'mcp_dropin_skip', reason: 'invalid', folder, source }); continue; }
      if (cleaned.enabled === false) continue; // 清单显式禁用 → 跳过
      if (seen.has(cleaned.id)) { logEvent({ kind: 'mcp_dropin_skip', reason: 'dup-dropin-id', id: cleaned.id, folder, source }); continue; }
      seen.add(cleaned.id);
      out.push({ ...cleaned, _dropInSource: source, _dropInFolder: folder });
    }
    if (out.length >= MCP_DROPIN_MAX) break;
  }
  _dropInCache = { at: now, list: out };
  return out;
}
// 测试可用:强制下次扫描重读盘(e2e 造完清单后调用)。
function invalidateMcpDropInCache() { _dropInCache = { at: 0, list: null }; }

// Merge the desktop MCP (detected/explicit) + user externalMcpServers (enabled) into one list of
// {id,label,command,args,cwd,env}. desktopMcp always uses id 'ai-computer-control'.
// v1.1-W2 (T2): also merges drop-in connectors scanned from <repo>/mcp/*/ and <dataRoot>/mcp/*/ (runtime
// merge, never written back to config). config/desktop entries win on id collision; drop-in is skipped+warned.
function resolveExternalMcpServers(config) {
  const out = [];
  const dm = config && config.desktopMcp;
  if (dm && dm.enabled) {
    let command = String(dm.command || '').trim();
    let args = Array.isArray(dm.args) ? dm.args.slice() : [];
    let cwd = String(dm.cwd || '').trim() || undefined;
    let env = {};
    let pythonSource = '';
    if (command) {
      // Explicit override — trust the user's command/args/cwd; default UTF-8 for a python launch.
      env = { PYTHONUTF8: '1' };
    } else if (dm.autodetect) {
      const det = detectDesktopMcp();
      if (det) { command = det.command; args = det.args; cwd = det.cwd; env = det.env || {}; pythonSource = det.pythonSource || ''; }
    }
    if (command) {
      const browser = (config && config.browserAutomation) || {};
      env = { ...env,
        ACC_BROWSER_MODE: String(browser.mode || 'system'),
        ACC_BROWSER_EXECUTABLE: String(browser.executable || ''),
        ACC_BROWSER_CDP_URL: String(browser.cdpUrl || 'http://127.0.0.1:9222'),
      };
      out.push({ id: 'ai-computer-control', label: '桌面控制 (ai-computer-control)', command, args, cwd, env,
      pythonSource });
    }
  }
  const ext = (config && Array.isArray(config.externalMcpServers)) ? config.externalMcpServers : [];
  for (const s of ext) {
    if (!s || s.enabled === false || !s.command) continue;
    if (out.some(o => o.id === s.id)) continue;   // desktop entry wins on id collision
    out.push({ id: s.id, label: s.label || s.id, command: s.command, args: s.args || [], cwd: s.cwd || undefined, env: s.env || {} });
  }
  // v1.1-W2 (T2): merge drop-in connectors LAST → any id already claimed by a desktop/config entry wins;
  // the drop-in is skipped and a warn is audited (config 显式条目优先，与 import-folder 持久化路径互补)。
  // enableMcpDropIn 缺省开;显式 false 可关(normalizeConfig 清洗后的布尔)。
  if (!config || config.enableMcpDropIn !== false) {
    for (const d of scanMcpDropIns()) {
      if (out.some(o => o.id === d.id)) { logEvent({ kind: 'mcp_dropin_skip', reason: 'id-conflict-config-wins', id: d.id, folder: d._dropInFolder, source: d._dropInSource }); continue; }
      out.push({ id: d.id, label: d.label || d.id, command: d.command, args: d.args || [], cwd: d.cwd || undefined, env: d.env || {} });
    }
  }
  return out;
}

// 48c: MCP 配置导入器 v1 -- 从 Claude Code .mcp.json / ~/.claude.json / Codex config.toml 导入(03 §4.1)。
// 零依赖:JSON 直解;TOML 用行级状态机迷你 parser(只解 [mcp_servers.X] 段的 command/args/env/cwd,够 Codex 用)。
// ${VAR}/%VAR% 双向插值(从 process.env,未定义保留原样)。sse/http 标 unsupported(远程 transport 03 §4.2 后续波)。
function _expandMcpVar(s) {
  return String(s == null ? '' : s)
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, n) => (process.env[n] != null ? String(process.env[n]) : '${' + n + '}'))
    .replace(/%([A-Z_][A-Z0-9_]*)%/gi, (_, n) => (process.env[n] != null ? String(process.env[n]) : '%' + n + '%'));
}
function _parseTomlMcpServers(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let cur = null;
  const unquote = v => { v = v.trim(); return /^["'].*["']$/.test(v) ? v.slice(1, -1) : v; };
  for (const line of lines) {
    const sec = line.match(/^\s*\[\s*mcp_servers\.([^\]\s]+)\s*\]\s*$/);
    if (sec) { const id = sec[1].replace(/^["']|["']$/g, ''); cur = { id, label: id, type: 'stdio', command: '', args: [], env: {}, cwd: '' }; out.push(cur); continue; }
    if (!cur) continue;
    if (/^\s*\[/.test(line)) { cur = null; continue; } // 进入其它段,结束当前 mcp_servers 段
    const km = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!km) continue;
    const k = km[1], v = km[2];
    if (k === 'command') cur.command = unquote(v);
    else if (k === 'cwd') cur.cwd = unquote(v);
    else if (k === 'args') {
      const arr = v.match(/^\[(.*)\]$/s);
      if (arr) cur.args = [...arr[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map(m => m[1] != null ? m[1] : m[2]);
    } else if (k === 'env') {
      const tbl = v.match(/^\{(.*)\}$/s);
      if (tbl) for (const e of tbl[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)) cur.env[e[1]] = e[2];
    }
  }
  return out.filter(s => s.command);
}
// 解析单个 MCP 配置文件。返回 { servers, error? }。从不抛(缺失/格式错 -> error,供 UI 明示)。
function parseMcpConfigFile(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) { return { servers: [], error: '读失败: ' + (e.code === 'ENOENT' ? '文件不存在' : e.message) }; }
  if (text.length > 256 * 1024) return { servers: [], error: '文件过大(>256KB,跳过)' };
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json')) {
    let j; try { j = JSON.parse(text); } catch (e) { return { servers: [], error: 'JSON 解析失败: ' + e.message }; }
    const ms = (j && j.mcpServers && typeof j.mcpServers === 'object') ? j.mcpServers : null;
    if (!ms) return { servers: [], error: '未找到 mcpServers 字段' };
    const servers = [];
    for (const [id, raw] of Object.entries(ms)) {
      if (!raw || typeof raw !== 'object') continue;
      const type = String(raw.type || 'stdio').toLowerCase();
      // 48c:解析即插值规范化(${VAR}/%VAR%),apply 拿到的已是终值。
      const srv = { id: String(id), label: String(id), type, command: _expandMcpVar(String(raw.command || '')), args: Array.isArray(raw.args) ? raw.args.map(a => _expandMcpVar(String(a))) : [], env: {}, cwd: _expandMcpVar(String(raw.cwd || '')) };
      if (raw.env && typeof raw.env === 'object') for (const [k, v] of Object.entries(raw.env)) srv.env[k] = _expandMcpVar(String(v));
      if (type === 'sse' || type === 'http') { srv.url = String(raw.url || ''); srv.unsupported = '远程 transport(sse/http) 暂不支持,后续波落地'; }
      servers.push(srv);
    }
    return { servers };
  }
  if (lower.endsWith('.toml') || /\[mcp_servers\./.test(text)) {
    return { servers: _parseTomlMcpServers(text).map(s => ({ ...s, command: _expandMcpVar(s.command), args: s.args.map(_expandMcpVar), env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, _expandMcpVar(v)])), cwd: _expandMcpVar(s.cwd) })) };
  }
  return { servers: [], error: '未知格式(需 .json 含 mcpServers,或 .toml 含 [mcp_servers.X])' };
}
// 扫描多个源文件,插值 + 标冲突。返回 { servers, errors }。servers 每条带 source + conflict(撞 config 已有 id)。
async function scanMcpSources(filePaths, config) {
  const servers = [], errors = [];
  const existingIds = new Set((Array.isArray(config && config.externalMcpServers) ? config.externalMcpServers : []).map(s => s && s.id).filter(Boolean));
  for (const fp of filePaths) {
    const r = parseMcpConfigFile(fp);
    for (const s of r.servers) {
      s.source = fp;
      s.conflict = existingIds.has(s.id);
      servers.push(s);
    }
    if (r.error) errors.push({ path: fp, error: r.error });
  }
  return { servers, errors };
}

function safeMcpInventory(config) {
  return resolveExternalMcpServers(config).map(entry => ({
    id: entry.id, label: entry.label || entry.id, command: entry.command, args: entry.args || [],
    cwd: entry.cwd || '', envKeys: Object.keys(entry.env || {}),
    builtin: entry.id === 'ai-computer-control',
  }));
}

function invalidateMcpRuntime(id) {
  invalidateMcpDropInCache();
  bridgedCatalogCache = { key: '', expiresAt: 0, value: null };
  if (id) {
    const client = mcpClients.get(id);
    if (client) { try { client.kill(); } catch { /* ignore */ } mcpClients.delete(id); }
    mcpClientFailures.delete(id);
  }
}

async function configureMcpFromTool(args, currentConfig) {
  const operation = String(args && args.operation || '').trim();
  const config = currentConfig || await readConfig();
  if (operation === 'set-browser') {
    const raw = (args && args.browser && typeof args.browser === 'object') ? args.browser : {};
    const next = await writeConfig({ ...config, browserAutomation: {
      mode: raw.mode, executable: raw.executable, cdpUrl: raw.cdpUrl,
    } });
    invalidateMcpRuntime('ai-computer-control');
    return { ok: true, operation, browserAutomation: next.browserAutomation,
      note: '浏览器目标已保存；当前桌面 MCP 连接已刷新，下一次工具发现会按新策略启动。' };
  }
  const id = String(args && (args.id || (args.server && args.server.id)) || '').trim();
  if (!id || id === 'ai-computer-control') return { ok: false, error: '外部 MCP 需要合法 id；内置 ai-computer-control 只能用 set-browser 调整浏览器目标。' };
  const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
  const index = list.findIndex(s => s && s.id === id);
  if (operation === 'remove') {
    if (index < 0) return { ok: false, error: `未找到外部 MCP: ${id}` };
    list.splice(index, 1);
  } else if (operation === 'set-enabled') {
    if (index < 0) return { ok: false, error: `未找到外部 MCP: ${id}` };
    list[index] = { ...list[index], enabled: args.enabled !== false };
  } else if (operation === 'upsert') {
    const server = sanitizeExternalMcpServer({ ...(args.server || {}), id });
    if (!server) return { ok: false, error: 'MCP 配置无效：upsert 至少需要 id 与 command，args 必须是字符串数组。' };
    if (index >= 0) list[index] = server; else list.push(server);
  } else {
    return { ok: false, error: 'operation 必须是 upsert、remove、set-enabled 或 set-browser' };
  }
  const next = await writeConfig({ ...config, externalMcpServers: list });
  invalidateMcpRuntime(id);
  const saved = (next.externalMcpServers || []).find(s => s.id === id);
  return { ok: true, operation, id, removed: operation === 'remove',
    server: saved ? { id: saved.id, label: saved.label, command: saved.command, args: saved.args, cwd: saved.cwd, enabled: saved.enabled, envKeys: Object.keys(saved.env || {}) } : null,
    note: '配置已原子保存并刷新工具目录；若工具仍不可用，请读取 MCP 列表与启动诊断。' };
}

// Get (lazily starting) a live client for one server entry, or null if it can't start. Caches failures.
async function getMcpClient(entry) {
  const existing = mcpClients.get(entry.id);
  if (existing && !existing.dead) return existing;
  if (existing && existing.dead) mcpClients.delete(entry.id);
  const fail = mcpClientFailures.get(entry.id);
  if (fail && (Date.now() - fail.at) < MCP_FAILURE_COOLDOWN_MS) return null;   // in cooldown
  const client = new McpStdioClient(entry);
  try {
    await client.start();
    mcpClients.set(entry.id, client);
    mcpClientFailures.delete(entry.id);
    return client;
  } catch (e) {
    mcpClientFailures.set(entry.id, { at: Date.now(), error: (e && e.message) || String(e) });
    logEvent({ kind: 'mcp_bridge_start_failed', serverId: entry.id, error: (e && e.message) || String(e) });
    return null;
  }
}

// Kill every live bridged client (called on process exit / cleanup).
function killAllMcpClients() {
  for (const [, c] of mcpClients) { try { c.kill(); } catch { /* ignore */ } }
  mcpClients.clear();
}

// 47b:桥客户端获取的统一入口 —— 活则直给;死/缺则按 config 的服务器条目经 getMcpClient 惰性重 spawn。
// 此前三处分发点(12-tool-dispatch / 08 / 09)直接 mcpClients.get,47b 超时杀客户端后永远 'not available'
// 无法自愈;统一走这里后,"超时杀 → 下次调用自动重连"的契约闭环。
async function getBridgedClient(serverId, config) {
  const live = mcpClients.get(serverId);
  if (live && !live.dead) return live;
  const list = resolveExternalMcpServers(config || await readConfig());
  const entry = (list || []).find(s => s.id === serverId);
  if (!entry || !entry.command) return null;
  return getMcpClient(entry);
}

// Stable, reversible-ish server-id sanitizer for the bridged tool-name prefix. Non [A-Za-z0-9_] -> _.
function sanitizeServerId(id) { return String(id || '').replace(/[^A-Za-z0-9_]/g, '_'); }

// v0.7d line 2: collect bridged tools for THIS turn (once). Returns { tools:[openai fn schema], route }.
// route maps bridgedName -> { serverId, toolName }. Any server that fails to start/list is skipped;
// never throws, never blocks the main flow.
let bridgedCatalogCache = { key: '', expiresAt: 0, value: null };
async function collectBridgedTools(config, force = false) {
  if (!config || config.bridgeExternalToolsToProvider === false) return { tools: [], route: {} };
  const entries = resolveExternalMcpServers(config);
  const cacheKey = JSON.stringify(entries.map(e => [e.id, e.command, e.args || [], e.cwd || '', e.env || {}]));
  if (!force && bridgedCatalogCache.value && bridgedCatalogCache.key === cacheKey && Date.now() < bridgedCatalogCache.expiresAt) {
    return bridgedCatalogCache.value;
  }
  const tools = [];
  const route = {};
  for (const entry of entries) {
    let client;
    try { client = await getMcpClient(entry); } catch { client = null; }
    if (!client) continue;
    const prefix = sanitizeServerId(entry.id);
    for (const t of client.listTools()) {
      if (!t || typeof t.name !== 'string' || !t.name) continue;
      const bridgedName = `${prefix}__${t.name}`;
      // Never overwrite an already-claimed name (defensive; prefixes make collisions unlikely).
      if (route[bridgedName]) continue;
      route[bridgedName] = { serverId: entry.id, toolName: t.name };
      tools.push({
        type: 'function',
        function: {
          name: bridgedName,
          description: t.description || t.name,
          parameters: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} },
        },
      });
    }
  }
  const value = { tools, route };
  bridgedCatalogCache = {
    key: cacheKey,
    expiresAt: Date.now() + Math.max(5000, Number(config.toolCatalogCacheTtlMs) || 60000),
    value,
  };
  return value;
}

// v1.4.1: 桥接工具带 `<serverId>__` 前缀(如 ai_computer_control__excel_read)。部分 provider 模型(实测 qwen)
// 会【丢掉前缀】直接调裸名 `excel_read` → 命不中 bridgedRoute → 落到内建兜底报「Unknown tool: excel_read」。
// 宽容解析:①精确前缀名优先;②内建工具名绝不被桥接遮蔽(返回 null 走内建路径);③裸名在所有桥接工具里
// 【唯一】命中某 toolName 时路由过去(≥2 个同名歧义则不猜、返回 null)。纯加法:精确前缀路径行为不变。
let _nativeToolNameSet = null;
function isNativeToolName(name) {
  if (!_nativeToolNameSet) { try { _nativeToolNameSet = new Set(MCP_TOOLS.map(t => t && t.name)); } catch { _nativeToolNameSet = new Set(); } }
  return _nativeToolNameSet.has(name);
}
function resolveBridge(bridgedRoute, name) {
  if (!name || !bridgedRoute) return null;
  if (bridgedRoute[name]) return bridgedRoute[name];       // ① 精确前缀名
  if (isNativeToolName(name)) return null;                 // ② 内建优先,不被桥接遮蔽
  let hit = null, count = 0;                               // ③ 裸名唯一命中桥接工具 → 容错路由
  for (const k in bridgedRoute) {
    const r = bridgedRoute[k];
    if (r && r.toolName === name) { hit = r; if (++count > 1) return null; }
  }
  return count === 1 ? hit : null;
}

function stopSession(sessionId, reason = 'stopped') {
  const entry = activeChildren.get(sessionId);
  clearPendingPermissions(sessionId, `turn ${reason}`);
  clearPendingQuestions(sessionId, `turn ${reason}`);
  clearPendingPlans(sessionId, `turn ${reason}`); // v0.9-S5: unblock a paused plan-mode turn on abort/stop (reject semantics)
  if (!entry) return false;
  entry.state = reason;
  // Prefer the live ChildProcess handle; only fall back to taskkill by pid while the child is alive,
  // so we never force-kill a recycled PID.
  if (typeof entry.abort === 'function') {
    // Native (openai) engine: no child process — abort the in-flight fetch instead of taskkill.
    entry.exited = true;
    try { entry.abort(); } catch { /* ignore */ }
  } else if (!entry.exited && entry.child && entry.child.exitCode === null) {
    entry.exited = true;
    killChildTree(entry.pid);
  }
  activeChildren.delete(sessionId);
  logEvent({ kind: 'turn_kill', sessionId, reason });
  return true;
}

// --- F3: defensive, side-effect-free event parser. Maps one raw stream-json event to a list of
// normalized events {kind, ...}. Unknown shapes fall through to {kind:'unknown', raw}. Every stream
// feature (text, thinking, tool cards, usage) plugs into this single seam. ---
function deltaOf(streamEvent) {
  // Tolerate both {event:{delta}} and {event:{event:{delta}}} nestings seen across CLI versions.
  if (!streamEvent || typeof streamEvent !== 'object') return null;
  if (streamEvent.delta) return streamEvent;
  if (streamEvent.event) return deltaOf(streamEvent.event);
  return null;
}
function parseClaudeEvent(evt) {
  const out = [];
  if (!evt || typeof evt !== 'object') return [{ kind: 'unknown', raw: evt }];
  const sid = evt.session_id || evt.sessionId;

  if (evt.type === 'system') {
    if (sid) out.push({ kind: 'init', sessionId: sid, subtype: evt.subtype });
    return out.length ? out : [{ kind: 'unknown', raw: evt }];
  }

  if (evt.type === 'stream_event' || evt.type === 'content_block_delta' || evt.event) {
    // Per-API-CALL usage (message_start carries the input breakdown; message_delta the output).
    // This is NOT the cumulative turn total, so it reflects true context-window occupancy.
    const inner = evt.event || evt;
    const mu = (inner && inner.message && inner.message.usage) || (inner && inner.usage);
    if (mu && typeof mu === 'object' && ('input_tokens' in mu || 'output_tokens' in mu || 'cache_read_input_tokens' in mu || 'cache_creation_input_tokens' in mu)) {
      out.push({ kind: 'msg_usage', usage: mu });
    }
    const holder = deltaOf(evt.event || evt);
    const delta = holder && holder.delta;
    if (delta) {
      const dt = delta.type || '';
      if (dt === 'text_delta' && typeof delta.text === 'string') {
        out.push({ kind: 'text', text: delta.text, partial: true, index: holder.index });
      } else if (/thinking|reasoning/i.test(dt) || typeof delta.thinking === 'string' || typeof delta.reasoning === 'string') {
        // Tolerate old (thinking_delta) + new adaptive/reasoning shapes and varying text fields.
        const t = [delta.thinking, delta.reasoning, delta.text].find(v => typeof v === 'string') || '';
        if (t) out.push({ kind: 'thinking', text: t, partial: true, index: holder.index });
      }
      // signature_delta and other unknown deltas are intentionally ignored
    }
    if (out.length) return out;
    // fall through to structural handling below if it wasn't a recognized delta
  }

  if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
    if (evt.message.usage) out.push({ kind: 'msg_usage', usage: evt.message.usage }); // complete per-call usage
    for (const block of evt.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ kind: 'text', text: block.text, partial: false });
      } else if (block.type === 'redacted_thinking') {
        out.push({ kind: 'thinking', text: '[redacted thinking]', partial: false, redacted: true });
      } else if (/thinking|reasoning/i.test(block.type || '') || typeof block.thinking === 'string' || typeof block.reasoning === 'string') {
        // Robust across thinking(enabled)/thinking(adaptive)/reasoning block variants + text field names.
        const t = [block.thinking, block.reasoning, block.text, (typeof block.content === 'string' ? block.content : null)].find(v => typeof v === 'string') || '';
        out.push({ kind: 'thinking', text: t, partial: false });
      } else if (block.type === 'tool_use') {
        out.push({ kind: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return out.length ? out : [{ kind: 'unknown', raw: evt }];
  }

  if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (block && block.type === 'tool_result') {
        out.push({ kind: 'tool_result', id: block.tool_use_id, content: block.content, isError: Boolean(block.is_error) });
      }
    }
    return out.length ? out : [{ kind: 'unknown', raw: evt }];
  }

  if (evt.type === 'result') {
    return [{
      kind: 'result',
      sessionId: sid,
      ok: evt.subtype === 'success' || (!evt.is_error && evt.subtype !== 'error'),
      subtype: evt.subtype,
      result: typeof evt.result === 'string' ? evt.result : undefined,
      usage: evt.usage,
      costUsd: evt.total_cost_usd ?? evt.cost_usd,
      durationMs: evt.duration_ms,
      numTurns: evt.num_turns,
    }];
  }

  return [{ kind: 'unknown', raw: evt }];
}

// Claude CLI's native Agent/Task tool returns the child agent's final answer as the parent
// tool_result.  Unlike workbench-managed sub-turns, the CLI does not expose that child's
// intermediate events, so this result is the only inspectable evidence of what it did.  Keep a
// bounded, display-safe copy for the UI instead of reducing it to a character count.
const NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS = 100000;
function nativeClaudeAgentResultInfo(content, isError) {
  const textOf = value => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
    if (typeof value === 'object') {
      // Anthropic accepts both a plain string and content-block arrays for tool_result.
      if (typeof value.text === 'string') return value.text;
      if (typeof value.content === 'string') return value.content;
      if (Array.isArray(value.content)) return textOf(value.content);
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    }
    return String(value);
  };
  const fullText = textOf(content);
  const result = fullText.length > NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS
    ? fullText.slice(0, NATIVE_CLAUDE_AGENT_RESULT_MAX_CHARS)
    : fullText;
  // Some Anthropic-compatible endpoints send a failed Task result as ordinary text rather than
  // setting tool_result.is_error.  Classify only unmistakable, leading transport/task failures so
  // a normal review that merely *mentions* an API error is not marked failed.
  const looksLikeFailure = /^(?:api\s+error\b|error\s*:|(?:request|network|connection)\s+(?:failed|closed|error)\b|(?:agent|task)\s+(?:failed|error)\b)/i.test(fullText.trim());
  return {
    result,
    resultChars: fullText.length,
    resultTruncated: fullText.length > result.length,
    failed: Boolean(isError) || looksLikeFailure,
  };
}

// A Claude CLI print process exits after every workbench turn. Normally --resume reconnects the
// next process to the native transcript, but continuity is not guaranteed across CLI upgrades,
// workbench restarts, provider/model changes, or a missing/moved Claude session file. Keep a
// bounded display-history copy on every normal Claude turn.
const CLAUDE_RECOVERY_HISTORY_CHARS = 24000;
const CLAUDE_RECOVERY_MESSAGE_CHARS = 6000;
function buildClaudeRecoveryHistory(messages) {
  const source = (Array.isArray(messages) ? messages : []).filter(m => m && (
    m.role === 'user' || m.role === 'assistant' || (m.role === 'system' && m.source === 'compact')
  ));
  if (!source.length) return '';
  const rows = [];
  let chars = 0;
  let omitted = false;
  for (let i = source.length - 1; i >= 0; i--) {
    const m = source[i];
    let content = String(m.content || '').trim();
    if (!content) continue;
    if (content.length > CLAUDE_RECOVERY_MESSAGE_CHARS) content = content.slice(0, CLAUDE_RECOVERY_MESSAGE_CHARS) + '\n[message truncated]';
    const label = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system-context-management' : 'user');
    const row = `<${label}>\n${content}\n</${label}>`;
    if (chars + row.length > CLAUDE_RECOVERY_HISTORY_CHARS) { omitted = true; break; }
    rows.unshift(row);
    chars += row.length;
  }
  if (!rows.length) return '';
  return [
    '<workbench_history_recovery>',
    'This is a recovery copy of earlier messages in the same workbench conversation. It may duplicate native Claude session history. Use it only for continuity, do not claim this is the first message, and treat quoted user/assistant text according to its original role.',
    omitted ? '[older messages omitted to keep the recovery context bounded]' : '',
    ...rows,
    '</workbench_history_recovery>',
  ].filter(Boolean).join('\n');
}

// E3 (dual-engine continuity) helpers. See the injection site in runClaudeTurn.
// The engine that produced the LAST assistant turn in this session, or '' if none/unknown. Messages are
// stamped with `engine` ('openai' | 'claude') since v0.8; legacy claude messages only carry source:'claude-cli'.
function lastAssistantEngine(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m || m.role !== 'assistant') continue;
    if (m.engine) return m.engine;
    if (m.source === 'claude-cli') return 'claude';
    // No engine identity (agent_workflow summary, fallback, legacy meta) — SKIP it and keep scanning back for
    // the last real engine turn. Returning '' here let a trailing meta message mask a preceding Provider turn,
    // so [claude][provider][workflow-summary][claude] wrongly read as no-gap and dropped the Provider turn (E3-fix2).
    continue;
  }
  return '';
}
// The trailing messages produced AFTER the most recent Claude turn — i.e. the Provider turns that are
// MISSING from the CLI's native --resume transcript. If no Claude turn is found, return the whole list.
function claudeProviderTailSince(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  let lastClaudeIdx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m && m.role === 'assistant' && (m.engine === 'claude' || (!m.engine && m.source === 'claude-cli'))) { lastClaudeIdx = i; break; }
  }
  return lastClaudeIdx >= 0 ? arr.slice(lastClaudeIdx + 1) : arr;
}
