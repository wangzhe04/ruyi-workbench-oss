'use strict';
// 体验门量具的【工作进程】(151 号文 §4.2,阶段 0)。由 dev-harness/experience-gates.js 逐个拉起,不直接跑。
//
// 一个进程只测一种场景(argv[2] = mode,argv[3] = JSON 选项),在本进程里用 loadServerInternals 装【真】server.js
// (ruyi-workbench/app/server.js 全文,不是切片)并起一份真 serve,假 provider 用 lib/fake-openai-provider.js 跑在同一进程里。
// 同进程的好处:monitorEventLoopDelay 量到的就是服务本身的事件循环;provider 收到请求体的时刻与发请求的时刻同一时钟。
//
// 隔离(不满足就拒跑,退出码 3,不加载 server.js):USERPROFILE/HOME/APPDATA/LOCALAPPDATA/TEMP/TMP/RUYI_HOME/
// CLAUDE_CONFIG_DIR/KIMI_CODE_HOME/CODEX_HOME 与 os.homedir()/os.tmpdir()/cwd 都必须是绝对路径、落在 XG_RUN_ROOT 之内、
// 且不等于真机家(XG_REAL_HOME);WCW_TEST_NO_NET_ANCHORS 必须为 1(不探 baidu/bing)。配置里只有假 provider 与假密钥。
//
// 输出协议(stdout,一行一条):`XG_PARTIAL <json>` 中途进度(宿主超时杀进程时用最后一条);`XG_RESULT <json>` 结果;
// `XG_DONE` 收尾。打完 XG_DONE 后本进程【不自己退】:宿主要趁根进程还活着按创建时间认子孙(语义 worker、假 MCP、
// CLI 探测子进程),再用 killOwnTree 收掉整棵树。自退只是兜底(XG_SELF_EXIT_MS,默认 120 s)。
//
// 各 mode 的测量方法与已知误差写在 experience-gates.js 头注(一处写全,这里不重复)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { performance, monitorEventLoopDelay } = require('perf_hooks');

const REPO = path.resolve(__dirname, '..', '..');
const MODE = process.argv[2] || '';
const OPTS = (() => { try { return JSON.parse(process.argv[3] || '{}'); } catch { return {}; } })();
const emit = (tag, value) => process.stdout.write(tag + (value === undefined ? '' : ' ' + JSON.stringify(value)) + '\n');
const log = (...args) => process.stderr.write('[xg-worker ' + MODE + '] ' + args.join(' ') + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

// ── 隔离判据 ──────────────────────────────────────────────────────────────────────────────────
function within(root, target) {
  if (!target || !path.isAbsolute(target)) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function sameDir(a, b) {
  const norm = value => { let s = path.resolve(String(value || '')); if (process.platform === 'win32') s = s.toLowerCase(); return s.replace(/[\\/]+$/, ''); };
  return !!a && !!b && norm(a) === norm(b);
}
function isolationProblems(env = process.env) {
  const problems = [];
  const root = env.XG_RUN_ROOT || '';
  const realHome = env.XG_REAL_HOME || '';
  if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) problems.push('XG_RUN_ROOT missing or not absolute');
  if (!realHome || !path.isAbsolute(realHome)) problems.push('XG_REAL_HOME missing');
  const keys = ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'RUYI_HOME', 'WIN_CLAUDE_WORKBENCH_HOME', 'CLAUDE_CONFIG_DIR', 'KIMI_CODE_HOME', 'CODEX_HOME'];
  for (const key of keys) {
    const value = env[key] || '';
    if (!value) { problems.push(key + ' empty'); continue; }
    if (!path.isAbsolute(value)) problems.push(key + ' not absolute');
    else if (root && !within(root, value)) problems.push(key + ' outside run root');
    if (realHome && sameDir(value, realHome)) problems.push(key + ' equals real home');
  }
  for (const [label, value] of [['os.homedir()', os.homedir()], ['os.tmpdir()', os.tmpdir()], ['cwd', process.cwd()]]) {
    if (root && !within(root, value)) problems.push(label + ' outside run root');
    if (realHome && sameDir(value, realHome)) problems.push(label + ' equals real home');
  }
  if (env.WCW_TEST_NO_NET_ANCHORS !== '1') problems.push('WCW_TEST_NO_NET_ANCHORS != 1');
  if (env.NODE_OPTIONS) problems.push('NODE_OPTIONS set');
  return problems;
}

// ── HTTP 小件 ─────────────────────────────────────────────────────────────────────────────────
function request(port, method, route, { body, headers = {}, timeoutMs = 60000 } = {}) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const t0 = performance.now();
    const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: timeoutMs,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, ms: performance.now() - t0, bytes: Buffer.byteLength(text) });
      });
    });
    req.on('error', error => resolve({ status: 0, json: null, ms: performance.now() - t0, error: String(error && error.code || error) }));
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'XG_TIMEOUT' })); });
    if (raw) req.write(raw);
    req.end();
  });
}

// 失败信封的码与一句去掉路径的说明(报告里不留本机路径)。
function failureOf(r) {
  if (!r) return null;
  if (r.error) return { transport: r.error };
  const e = r.json && r.json.error;
  if (!e && r.status >= 200 && r.status < 300) return null;
  const code = e && typeof e === 'object' ? e.code : (typeof e === 'string' ? 'raw-string' : null);
  const message = String((e && typeof e === 'object' ? e.message : e) || '')
    .replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>').replace(/\/[^\s'"/]+\/[^\s'"]*/g, '<path>').slice(0, 160);
  return { status: r.status, code: code || null, message };
}

// 一回合:POST /api/chat/stream,读 NDJSON 事件到 result/流尾;provider 侧到达时刻由 arrivals 给。
function chatTurn(port, body, timeoutMs = 90000) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const events = [];
    const t0 = performance.now();
    let settled = false;
    const done = extra => { if (settled) return; settled = true; clearTimeout(timer); resolve({ t0, events, ...extra }); };
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          try { const e = JSON.parse(line); events.push({ t: performance.now(), type: e.type, e }); } catch { /* partial line */ }
        }
      });
      res.on('end', () => done({ status: res.statusCode }));
      res.on('error', error => done({ error: String(error && error.message || error) }));
    });
    const timer = setTimeout(() => { req.destroy(); done({ error: 'turn_timeout' }); }, timeoutMs);
    req.on('error', error => done({ error: String(error && error.message || error) }));
    req.write(raw);
    req.end();
  });
}

// ── 夹具:假 provider、黑洞锚点、配置 ─────────────────────────────────────────────────────────────
const MARK = /xgm-(\d+)-xg/g;
let markerSeq = 0;
function lastUserText(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])].reverse().find(m => m && m.role === 'user');
  if (!last) return '';
  const c = last.content;
  return Array.isArray(c) ? c.map(part => (typeof part === 'string' ? part : (part && part.text) || '')).join('\n') : String(c || '');
}
async function startProvider() {
  const { startFakeProvider, textFrames, usageFrame } = require(path.join(REPO, 'dev-harness', 'lib', 'fake-openai-provider.js'));
  const arrivals = [];
  const fake = await startFakeProvider({
    handler(req) {
      const t = performance.now();
      const markers = new Set([...String(req.raw || '').matchAll(MARK)].map(m => m[0]));
      const last = lastUserText(req.messages);
      const lastMarker = (last.match(/xgm-\d+-xg/) || [''])[0];
      arrivals.push({ t, stream: req.stream, markers, lastMarker, bytes: Buffer.byteLength(req.raw || ''), tools: req.tools.length });
      return [...textFrames('ok'), usageFrame(8, 2)];
    },
  });
  return { fake, arrivals };
}
function arrivalFor(arrivals, marker, t0) {
  const main = arrivals.find(a => a.t >= t0 && a.stream !== false && a.lastMarker === marker);
  const any = arrivals.filter(a => a.t >= t0 && a.markers.has(marker));
  return { main: main || null, related: any.length };
}
async function startBlackHole() {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}
function workspaceDir() {
  const dir = path.join(process.env.XG_RUN_ROOT, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function baseConfig(fakeUrl, extra = {}) {
  return {
    permissionMode: 'bypass', defaultWorkspace: workspaceDir(), autoImportClaudeCodeMcp: false,
    // 线程摘要(首回合并行的一发非流式调用)关掉:它不挡主请求,只给假 provider 的到达序列添噪声(走查 B 线同口径)。
    stewardThreadBriefV1: false,
    providers: [{ id: 'xg-fake', label: 'Fake', type: 'openai-compat', baseUrl: fakeUrl, apiKey: 'xg-placeholder-not-a-key', model: 'fake-model' }],
    activeProvider: 'xg-fake',
    ...extra,
  };
}
function writeConfigFile(config) {
  fs.mkdirSync(process.env.RUYI_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify(config, null, 2));
}
function loadServer(names) {
  const { loadServerInternals } = require(path.join(REPO, 'dev-harness', 'lib', 'server-internals.js'));
  return loadServerInternals(names);
}
async function serve(api) {
  const { getFreePort } = require(path.join(REPO, 'dev-harness', 'free-port.js'));
  const port = await getFreePort();
  const t0 = performance.now();
  await api.startWorkbenchServe({ _: ['serve'], port });
  return { port: (api.RUNTIME && api.RUNTIME.port) || port, token: (api.RUNTIME && api.RUNTIME.token) || '', serveMs: performance.now() - t0 };
}

// 发一条消息,返回「POST 发出 → 假 provider 收到这条消息的主请求体」的毫秒数与回合摘要。
async function measuredTurn(ctx, { q, sessionId, timeoutMs }) {
  const marker = `xgm-${++markerSeq}-xg`;
  const turn = await chatTurn(ctx.port, { message: `${q} [${marker}]`, cwd: ctx.work, ...(sessionId ? { sessionId } : {}) }, timeoutMs);
  const { main, related } = arrivalFor(ctx.arrivals, marker, turn.t0);
  const ev = type => turn.events.find(e => e.type === type);
  const meta = ev('meta');
  const result = ev('result');
  const sess = ev('session');
  const errors = turn.events.filter(e => e.type === 'error').map(e => String((e.e && (e.e.error || e.e.message)) || '').slice(0, 160));
  const mc = meta && meta.e && meta.e.memoryCheck;
  return {
    ms: main ? round(main.t - turn.t0) : null,
    reached: !!main,
    metaMs: meta ? round(meta.t - turn.t0) : null,
    resultMs: result ? round(result.t - turn.t0) : null,
    resultOk: result ? result.e.ok !== false : null,
    requestBytes: main ? main.bytes : null,
    relatedRequests: related,
    semantic: mc && mc.semantic ? mc.semantic.status : null,
    memory: mc ? { candidates: mc.candidateCount, matches: mc.matchCount, core: mc.coreActiveCount, mode: mc.mode } : null,
    errors,
    transportError: turn.error || null,
    sessionId: (sess && sess.e && sess.e.session && sess.e.session.id) || sessionId || '',
  };
}

// ── G-send:热态发消息时延 ──────────────────────────────────────────────────────────────────────
const WORDS = ['alpha', 'build', 'cache', 'docker', 'eslint', 'fetch', 'git', 'http', 'index', 'json', 'kafka', 'lint', 'mysql', 'nginx', 'oauth', 'python', 'queue', 'redis', 'schema', 'token', 'unit', 'vite', 'webpack', 'yaml', 'zip', '数据库', '前端', '接口', '日志', '性能', '权限', '测试', '缓存', '配置', '文档'];
function memorySpec(i) {
  // 与走查 B 线 bench-child 同一生成器:约 10% 提到 deploy pipeline(给命中查询留词法候选),前 5 条是核心记忆。
  const w1 = WORDS[i % WORDS.length], w2 = WORDS[(i * 7 + 3) % WORDS.length], w3 = WORDS[(i * 13 + 5) % WORDS.length];
  const deploy = i % 10 === 0;
  const type = i < 5 ? 'preference' : i < 8 ? 'convention' : (i % 3 === 0 ? 'reference' : 'lesson');
  return {
    id: `xgmem${String(i).padStart(4, '0')}`, scope: 'project', type, core: i < 5,
    name: `${w1} ${w2} note ${i}${deploy ? ' deploy pipeline' : ''}`.slice(0, 110),
    description: `${w3} ${w1} details for case ${i}${deploy ? '; the deploy pipeline must run release workflow first' : ''}`,
    body: `Body ${i}: ${w1} ${w2} ${w3}. `.repeat(6),
  };
}
const HIT_QUERY = 'how to run the deploy pipeline release';
const NOHIT_QUERY = '今天天气怎么样';

async function setSemantic(api, on) {
  const cfg = await api.readConfig();
  if ((cfg.semanticRetrievalV1 !== false) === on) return { changed: false };
  await api.writeConfig({ ...cfg, semanticRetrievalV1: on });
  if (on && typeof api.SemanticRuntimeHooks.prewarm === 'function') {
    const t0 = performance.now();
    const state = await Promise.race([api.SemanticRuntimeHooks.prewarm().then(v => (v && (v.state || (v.available ? 'ready' : v.reason))) || 'ok', e => 'error:' + String(e && (e.code || e.message) || e).slice(0, 80)), sleep(20000).then(() => 'prewarm_wait_cap')]);
    return { changed: true, prewarm: state, prewarmMs: round(performance.now() - t0) };
  }
  return { changed: true };
}
function semanticDescriptor(api) {
  try {
    const stats = api.SemanticRuntimeHooks.stats ? api.SemanticRuntimeHooks.stats() : null;
    const d = api.SemanticRuntimeHooks.descriptor ? api.SemanticRuntimeHooks.descriptor() : null;
    return { state: (d && d.state) || (stats && stats.state) || null, available: d ? d.available === true : null, diagnosticCode: (d && d.diagnosticCode) || null };
  } catch (e) { return { error: String(e && e.message || e).slice(0, 120) }; }
}

async function runSend() {
  const sizes = Array.isArray(OPTS.sizes) ? OPTS.sizes : [0, 200, 1000];
  const samples = Number(OPTS.samples) || 5;
  const order = Array.isArray(OPTS.semanticOrder) ? OPTS.semanticOrder : null;
  const { fake, arrivals } = await startProvider();
  const work = workspaceDir();
  writeConfigFile(baseConfig(fake.url, OPTS.encrypted ? { workDataEncryptionV1: true } : {}));
  const api = loadServer(['startWorkbenchServe', 'saveMemory', 'readConfig', 'writeConfig', 'SemanticRuntimeHooks', 'RUNTIME', 'workDataKeys']);
  const out = { mode: 'send', encrypted: !!OPTS.encrypted, samplesPerCondition: samples, conditions: [], notes: [] };
  if (OPTS.encrypted) {
    const t0 = performance.now();
    await api.workDataKeys.ensure();
    out.keyEnsureMs = round(performance.now() - t0);
    out.encryptionConfigured = (await api.readConfig()).workDataEncryptionV1 === true;
  }
  const s = await serve(api);
  out.serveMs = round(s.serveMs);
  const ctx = { port: s.port, work, arrivals };
  // 开机首条(不计入 G-send;冷态由 G-first 单独测)。
  const boot = await measuredTurn(ctx, { q: NOHIT_QUERY, timeoutMs: 120000 });
  out.bootTurn = boot;
  let seeded = 0;
  // 语义开关的切换次序:同一 N 下先测与当前状态相同的那一档,少一次冷重启(关→开要重起常驻 worker)。
  let semanticNow = (await api.readConfig()).semanticRetrievalV1 !== false;
  for (const n of sizes) {
    if (n > seeded) {
      const t0 = performance.now();
      for (let i = seeded; i < n; i++) {
        const r = await api.saveMemory(memorySpec(i), work);
        if (!r || !r.ok) throw new Error('seed memory ' + i + ' failed: ' + (r && r.error));
      }
      out.notes.push(`seeded ${n - seeded} memories in ${Math.round(performance.now() - t0)} ms (N=${n})`);
      if (OPTS.encrypted && seeded === 0) {
        // 核一下真封印了:盘上第一条记忆文件里不该出现正文明文(否则「加密 200 条」量的是明文路径)。
        const dir = path.join(process.env.RUYI_HOME, 'memory', 'project');
        let sample = '';
        try { for (const d of fs.readdirSync(dir)) { const file = path.join(dir, d, 'xgmem0000.md'); if (fs.existsSync(file)) { sample = fs.readFileSync(file, 'utf8'); break; } } } catch { /* 记 false */ }
        out.sealedVerified = !!sample && !sample.includes('Body 0:');
      }
      seeded = n;
    }
    const semList = order || (semanticNow ? [true, false] : [false, true]);
    for (const sem of semList) {
      const toggle = await setSemantic(api, sem);
      semanticNow = sem;
      // 每个条件一条新会话:首回合(建会话)当预热丢掉,随后 samples 回合计数。
      const warm = await measuredTurn(ctx, { q: HIT_QUERY, timeoutMs: 180000 });
      const sid = warm.sessionId;
      const turns = [];
      for (let k = 0; k < samples; k++) {
        turns.push(await measuredTurn(ctx, { q: HIT_QUERY, sessionId: sid, timeoutMs: 180000 }));
        emit('XG_PARTIAL', { condition: { n, semantic: sem }, done: k + 1 });
      }
      out.conditions.push({ n, semantic: sem, toggle, warmup: { ms: warm.ms, reached: warm.reached, semantic: warm.semantic }, turns, runtime: semanticDescriptor(api) });
      log(`N=${n} semantic=${sem ? 'on' : 'off'}: ${turns.map(t => t.ms).join(', ')} ms`);
    }
  }
  out.providerRequests = arrivals.length;
  await fake.close();
  return out;
}

// ── G-first:开机首条 ──────────────────────────────────────────────────────────────────────────
async function runFirst() {
  const condition = OPTS.condition || 'baseline';
  const { fake, arrivals } = await startProvider();
  const work = workspaceDir();
  let hole = null;
  const extra = {};
  if (condition === 'anchor-hang') { hole = await startBlackHole(); extra.capabilityProbeUrl = hole.url; }
  if (condition === 'mcp-hang') {
    extra.externalMcpServers = [{ id: 'xg-hang', label: 'xg hang', command: process.execPath,
      args: [path.join(REPO, 'dev-harness', 'fake-mcp.js')], env: { FAKE_MCP_HANG_INIT: '1' }, cwd: '', enabled: true }];
  }
  writeConfigFile(baseConfig(fake.url, extra));
  const tLoad = performance.now();
  const api = loadServer(['startWorkbenchServe', 'invalidateCapabilityCache', 'RUNTIME']);
  const loadMs = performance.now() - tLoad;
  const s = await serve(api);
  const ctx = { port: s.port, work, arrivals };
  const first = await measuredTurn(ctx, { q: NOHIT_QUERY, timeoutMs: 120000 });
  await sleep(1500);
  const second = await measuredTurn(ctx, { q: NOHIT_QUERY, sessionId: first.sessionId, timeoutMs: 120000 });
  api.invalidateCapabilityCache();   // 模拟能力缓存 60 s TTL 过期
  const expired = await measuredTurn(ctx, { q: NOHIT_QUERY, sessionId: first.sessionId, timeoutMs: 120000 });
  await fake.close();
  if (hole) hole.close();
  return { mode: 'first', condition, moduleLoadMs: round(loadMs), serveMs: round(s.serveMs), first, second, afterCapExpiry: expired };
}

// ── 会话夹具(直接写会话头 + 正文 ndjson,与 session-search.e2e 同形;另补空 provider.ndjson) ──────────
function writeSession(dir, { id, title, cwd, updatedAt, messages }) {
  const head = { id, storageVersion: 2, title, summary: '', cwd, pinned: false, createdAt: updatedAt, updatedAt, turnSeq: 1,
    messageCount: messages.length, providerHistoryCount: 0, messages: [], providerHistory: [] };
  const headFile = path.join(dir, `${id}.json`);
  fs.writeFileSync(headFile, JSON.stringify(head));
  fs.writeFileSync(path.join(dir, `${id}.messages.ndjson`), messages.map(m => JSON.stringify({ ...m, createdAt: updatedAt, turnSeq: 1 })).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, `${id}.provider.ndjson`), '');
  const at = new Date(updatedAt);
  for (const f of [headFile, path.join(dir, `${id}.messages.ndjson`), path.join(dir, `${id}.provider.ndjson`)]) fs.utimesSync(f, at, at);
}
const TOPICS = ['灰度发布', '数据库迁移', '前端打包', '日志轮转', '权限模型', '缓存失效', '接口限流', '证书续期'];
function seedSearchCorpus({ sessions, today, shared, bigBytes = 0 }) {
  const dir = path.join(process.env.RUYI_HOME, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const work = workspaceDir();
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < sessions; i++) {
    const id = `sess_xgs${String(i).padStart(4, '0')}`;   // 13e 只认 sess_ 前缀的会话头
    // 前 today 条是「今天」的线程(有卡片),其余按天往前排(较早线程,threadVisible 窗口之外)。
    const updatedAt = new Date(i < today ? now - (i + 1) * 60000 : now - (2 + i) * 86400000).toISOString();
    const topic = TOPICS[i % TOPICS.length];
    const sharedHit = i % shared === 0;   // 共享关键词「回滚预案」:较早线程为主
    const messages = [
      { role: 'user', content: `第 ${i} 号线程:帮我整理${topic}的步骤${sharedHit ? ',并写一份回滚预案' : ''}` },
      { role: 'assistant', content: `好的,${topic}分三步:准备、执行、验证。${sharedHit ? '回滚预案见附录。' : ''}` },
      { role: 'user', content: `再补充${topic}的常见问题,标识码 XGK${String(i).padStart(4, '0')}` },
      { role: 'assistant', content: `已补充${topic}常见问题三条。` },
    ];
    writeSession(dir, { id, title: `线程 ${i} · ${topic}`, cwd: work, updatedAt, messages });
    ids.push(id);
  }
  let bigInfo = null;
  if (bigBytes > 0) {
    const unit = '工作台在大文本下建立全文索引需要分片处理这是一段用于压力测量的中文正文内容。';
    let text = '';
    while (Buffer.byteLength(text, 'utf8') < bigBytes) text += unit;
    while (Buffer.byteLength(text, 'utf8') > bigBytes) text = text.slice(0, -1);
    const id = 'sess_xgbig0000';
    writeSession(dir, { id, title: '大文本线程', cwd: work, updatedAt: new Date(now - 30 * 60000).toISOString(),
      messages: [{ role: 'user', content: text + ' 大文本独有词甲乙丙丁' }, { role: 'assistant', content: '收到。' }] });
    bigInfo = { id, chars: text.length, bytes: Buffer.byteLength(text, 'utf8') };
  }
  return { ids, bigInfo };
}

// ── G-search-api ───────────────────────────────────────────────────────────────────────────────
async function runSearch() {
  const sessions = Number(OPTS.sessions) || 200;
  const today = Number(OPTS.today) || 10;
  const { fake } = await startProvider();
  writeConfigFile(baseConfig(fake.url, OPTS.config || {}));
  seedSearchCorpus({ sessions, today, shared: 4 });
  const api = loadServer(['startWorkbenchServe', 'RUNTIME']);
  const s = await serve(api);
  const auth = { 'x-wcw-token': s.token };
  const searchRoute = (keyword, preview) => `/api/sessions/search?q=${encodeURIComponent(keyword)}&limit=30${preview ? '&preview=1' : ''}`;
  const coverageOf = json => (json && json.coverage ? { phase: json.coverage.phase, complete: json.coverage.complete, indexed: json.coverage.indexedSessions, pending: json.coverage.pendingSessions } : null);
  const out = { mode: 'search', sessions, today, serveMs: round(s.serveMs), firstScreen: [], ratios: [], index: null };
  const shot = async (keyword, label) => {
    const r = await request(s.port, 'GET', searchRoute(keyword, true), { headers: auth, timeoutMs: 60000 });
    const results = r.json && Array.isArray(r.json.results) ? r.json.results : null;
    out.firstScreen.push({ label, keyword, ms: round(r.ms), status: r.status, results: results ? results.length : null,
      lexicalPreview: r.json ? r.json.lexicalPreview === true : null, coverage: coverageOf(r.json), failure: failureOf(r) });
    return results;
  };
  // U1 机制:后端命中 N 条 vs 左栏能画的行 = 主列表页(GET /api/missions)∪ 按 id 补取(?sessionIds=,前端 loadSearchExtras 同口径)。
  const ratioFor = async (results, label) => {
    const hits = (results || []).map(r => String(r && r.id || '')).filter(Boolean);
    const page = await request(s.port, 'GET', '/api/missions', { headers: auth, timeoutMs: 60000 });
    const pageIds = new Set(((page.json && page.json.missions) || []).map(row => String(row.sessionId || '')));
    const missing = hits.filter(id => !pageIds.has(id)).slice(0, 60);
    const extra = missing.length
      ? await request(s.port, 'GET', '/api/missions?sessionIds=' + encodeURIComponent(missing.join(',')), { headers: auth, timeoutMs: 60000 })
      : { json: { missions: [] }, ms: 0 };
    const extraIds = new Set(((extra.json && extra.json.missions) || []).map(row => String(row.sessionId || '')));
    const drawn = hits.filter(id => pageIds.has(id) || extraIds.has(id)).length;
    return { label, hits: hits.length, mainPageRows: pageIds.size, missingFromPage: missing.length, sessionIdsReturned: extraIds.size, drawn,
      ratio: hits.length ? round(drawn / hits.length, 3) : null, missionsMs: round(page.ms), sessionIdsMs: round(extra.ms) };
  };
  if (OPTS.firstScreen !== false) {
    // 冷 = 开机后第一次搜索;之后每个新词各一次(前端每换一个查询词先发 preview=1);再把前三个词重发一次(热)。
    // 「灰度发布」等是标题里也有的词;「回滚预案」「XGK0007」「常见问题」只在正文里(索引没建好时首屏是空的)。
    const titleKeyword = '灰度发布';
    const coldResults = await shot(titleKeyword, 'cold');
    const words = Array.isArray(OPTS.words) ? OPTS.words : ['数据库迁移', '前端打包', '日志轮转', '权限模型', '回滚预案', 'XGK0007', '常见问题'];
    for (const w of words) await shot(w, 'new-query');
    for (const w of [titleKeyword, ...words.slice(0, 2)]) await shot(w, 'repeat');
    emit('XG_PARTIAL', { firstScreen: out.firstScreen.length });
    out.ratios.push(await ratioFor(coldResults, 'preview'));
    const full = await request(s.port, 'GET', searchRoute(titleKeyword, false), { headers: auth, timeoutMs: 90000 });
    out.ratios.push({ ...(await ratioFor(full.json && full.json.results, 'continue')), searchMs: round(full.ms), searchStatus: full.status, failure: failureOf(full), coverage: coverageOf(full.json) });
  }
  if (Number(OPTS.indexCapMs) > 0) {
    // 后台索引:按前端节奏(上一发回来后 500 ms)连发非 preview 搜索,直到 coverage.complete 或到上限。
    const capMs = Number(OPTS.indexCapMs);
    const t0 = performance.now();
    const polls = [];
    let completeAtMs = null;
    while (performance.now() - t0 < capMs) {
      const r = await request(s.port, 'GET', searchRoute('回滚预案', polls.length === 0), { headers: auth, timeoutMs: capMs + 30000 });
      const cov = coverageOf(r.json);
      polls.push({ atMs: round(performance.now() - t0), ms: round(r.ms), status: r.status, results: r.json && Array.isArray(r.json.results) ? r.json.results.length : null, ...(cov || {}), failure: failureOf(r) });
      emit('XG_PARTIAL', { indexPolls: polls.length, indexed: cov && cov.indexed });
      if (cov && cov.complete === true) { completeAtMs = round(performance.now() - t0); break; }
      await sleep(500);
    }
    // 151 阶段 4A:「首次搜索只付词法成本」—— 第一发非 preview 搜索的耗时,以及建索引期间每发搜索耗时的中位数/最大值
    // (修前每发要在请求里建 1.5 s 的片;改后建索引在后台,每发只是一次词法检索)。
    const full = polls.filter((p, i) => i > 0 && p.status === 200).map(p => p.ms).sort((x, y) => x - y);
    const pick = q => full.length ? full[Math.min(full.length - 1, Math.floor(q * full.length))] : null;
    out.index = { capMs, completeAtMs, polls: polls.length, firstFullMs: polls[1] ? polls[1].ms : null, requestMsP50: pick(0.5), requestMsMax: full.length ? full[full.length - 1] : null, last: polls[polls.length - 1] || null, trace: polls.filter((p, i) => i % 5 === 0 || i === polls.length - 1) };
  }
  await fake.close();
  return out;
}

// ── G-bigtext ──────────────────────────────────────────────────────────────────────────────────
async function runBigtext() {
  const bigBytes = OPTS.bigBytes === undefined ? 1048576 : Number(OPTS.bigBytes);
  const others = Number(OPTS.others) || 30;
  const capMs = Number(OPTS.capMs) || 45000;
  const { fake } = await startProvider();
  writeConfigFile(baseConfig(fake.url, OPTS.config || {}));
  const { bigInfo } = seedSearchCorpus({ sessions: others, today: others, shared: 1, bigBytes });
  const api = loadServer(['startWorkbenchServe', 'RUNTIME']);
  const bootHist = monitorEventLoopDelay({ resolution: 5 }); bootHist.enable();
  const s = await serve(api);
  bootHist.disable();
  const auth = { 'x-wcw-token': s.token };
  // 独立对照:20 ms 定时器的最大迟到(与直方图同期),防直方图分辨率/口径误读。
  let lagMax = 0, expected = performance.now() + 20;
  const lagTimer = setInterval(() => { const now = performance.now(); lagMax = Math.max(lagMax, now - expected); expected = now + 20; }, 20);
  const hist = monitorEventLoopDelay({ resolution: 5 }); hist.enable();
  const t0 = performance.now();
  const requests = [];
  let complete = false, last = null, preview = true;
  while (performance.now() - t0 < capMs) {
    const r = await request(s.port, 'GET', `/api/sessions/search?q=${encodeURIComponent('回滚预案')}&limit=30${preview ? '&preview=1' : ''}`, { headers: auth, timeoutMs: capMs + 30000 });
    const cov = r.json && r.json.coverage;
    last = cov || null;
    requests.push({ preview, ms: round(r.ms), status: r.status, results: r.json && Array.isArray(r.json.results) ? r.json.results.length : null,
      phase: cov ? cov.phase : null, complete: cov ? cov.complete : null, indexed: cov ? cov.indexedSessions : null, pending: cov ? cov.pendingSessions : null, maxSoFarMs: round(hist.max / 1e6), failure: failureOf(r) });
    emit('XG_PARTIAL', { requests: requests.length, histMaxMs: round(hist.max / 1e6), lagMaxMs: round(lagMax) });
    preview = false;
    if (cov && cov.complete === true) { complete = true; break; }
    await sleep(500);
  }
  hist.disable(); clearInterval(lagTimer);
  // 「不挡其他会话建索引」:只搜小会话里才有的词,看它们是否都已能被搜到。
  const small = await request(s.port, 'GET', `/api/sessions/search?q=${encodeURIComponent('常见问题')}&limit=60`, { headers: auth, timeoutMs: 90000 });
  const smallHits = small.json && Array.isArray(small.json.results) ? small.json.results.filter(r => String(r.id || '').startsWith('sess_xgs')).length : null;
  await fake.close();
  return {
    mode: 'bigtext', big: bigInfo, others, capMs, serveMs: round(s.serveMs),
    bootMaxBlockMs: round(bootHist.max / 1e6),
    loop: { maxMs: round(hist.max / 1e6), p99Ms: round(hist.percentile(99) / 1e6), p50Ms: round(hist.percentile(50) / 1e6), meanMs: round(hist.mean / 1e6), timerLagMaxMs: round(lagMax), windowMs: round(performance.now() - t0) },
    requests, indexComplete: complete, lastCoverage: last,
    othersSearchable: { hits: smallHits, of: others, ms: round(small.ms) },
  };
}

// ── G-semantic-down:语义运行时不可用时对话是否照常 ────────────────────────────────────────────────
async function runSemdown() {
  const { fake, arrivals } = await startProvider();
  const work = workspaceDir();
  writeConfigFile(baseConfig(fake.url, OPTS.config || {}));
  const api = loadServer(['startWorkbenchServe', 'saveMemory', 'SemanticRuntimeHooks', 'RUNTIME']);
  for (let i = 0; i < 3; i++) {
    const r = await api.saveMemory({ id: `xghit${i}`, scope: 'project', type: 'lesson', name: `deploy pipeline step ${i}`, description: `deploy pipeline release workflow detail ${i}`, body: 'deploy pipeline body' }, work);
    if (!r || !r.ok) throw new Error('seed hit ' + i + ' failed');
  }
  const s = await serve(api);
  const ctx = { port: s.port, work, arrivals };
  const boot = await measuredTurn(ctx, { q: NOHIT_QUERY, timeoutMs: 120000 });
  // 等开机预热落定(成功或失败),再测「真实运行时」那一档。
  await Promise.race([Promise.resolve(api.SemanticRuntimeHooks.prewarm ? api.SemanticRuntimeHooks.prewarm() : null).catch(() => null), sleep(20000)]);
  const natural = { runtime: semanticDescriptor(api), turns: [] };
  for (const q of [HIT_QUERY, NOHIT_QUERY, HIT_QUERY]) natural.turns.push(await measuredTurn(ctx, { q, sessionId: boot.sessionId, timeoutMs: 120000 }));
  // 同一状态下的线程搜索「继续搜索」(非 preview,会走到语义那一段):是否照常返回。
  natural.search = [];
  await sleep(1000);   // 让刚落盘的回合写完,免得撞上 source_changed(那是另一种失败,不是这里要量的)
  for (const word of ['deploy pipeline', '天气', 'release workflow']) {
    const r = await request(s.port, 'GET', `/api/sessions/search?q=${encodeURIComponent(word)}&limit=30`, { headers: { 'x-wcw-token': s.token }, timeoutMs: 60000 });
    natural.search.push({ word, ms: round(r.ms), status: r.status, ok: r.status === 200 && !!(r.json && r.json.ok), failure: failureOf(r) });
  }
  // 注入:与 06hb 的 startingFailure 同形 —— prepare/encode 直接抛 semantic.* 错误(走查 S1 的现场)。
  const fault = code => Object.assign(new Error(code), { code });
  const saved = { prepare: api.SemanticRuntimeHooks.prepare, encode: api.SemanticRuntimeHooks.encode };
  api.SemanticRuntimeHooks.prepare = async () => { throw fault('semantic.owner_identity'); };
  api.SemanticRuntimeHooks.encode = async () => { throw fault('semantic.owner_identity'); };
  const injected = { fault: 'semantic.owner_identity(prepare/encode throw)', turns: [] };
  for (const q of [HIT_QUERY, NOHIT_QUERY, HIT_QUERY]) injected.turns.push(await measuredTurn(ctx, { q, sessionId: boot.sessionId, timeoutMs: 120000 }));
  Object.assign(api.SemanticRuntimeHooks, saved);
  await fake.close();
  return { mode: 'semdown', natural, injected };
}

// ── G-privacy-trunc ────────────────────────────────────────────────────────────────────────────
function cnIdNumber(seed) {
  const area = String(110101 + (seed % 50) * 2);
  const birth = `19${String(70 + (seed % 25)).padStart(2, '0')}${String(1 + (seed % 12)).padStart(2, '0')}${String(1 + (seed % 28)).padStart(2, '0')}`;
  const body = area + birth + String(100 + (seed % 899)).padStart(3, '0');
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(body[i]), 0);
  return body + '10X98765432'[sum % 11];
}
function privacyCorpus(cut, from, to) {
  // 每类值起始于规范化空白之后的第 from..to 字(逐字);两种语境:带中文标签(「身份证号:」)与不带标签(前面一个空格)。
  // 带标签时,截断后的残段可能仍被「标签 + 值」类规则认出(如「密钥:sk-…」);不带标签才是纯靠值形状识别的那一路。
  const kinds = [
    { kind: 'cn_id', value: i => cnIdNumber(i + 3), label: '身份证号' },
    { kind: 'email', value: i => `zhang.wei${i}@example-corp.cn`, label: '邮箱' },
    { kind: 'sk_key', value: i => `sk-${'A1b2C3d4E5f6G7h8J9k0'.slice(i % 5)}QrStUvWxYz0123456789abcd`, label: '密钥' },
    { kind: 'cn_mobile', value: i => `13${String(800138000 + i * 7919).slice(0, 9)}`, label: '手机号' },
  ];
  const filler = '请帮我核对一下这份客户资料里的联系方式与证件信息是否填写正确并整理成表格发给财务同事复核谢谢';
  const cases = [];
  for (const k of kinds) {
    for (const context of ['labelled', 'plain']) {
      for (let offset = from; offset <= to; offset++) {
        const value = k.value(offset);
        const lead = context === 'labelled' ? k.label + ':' : ' ';
        let prefix = '';
        while (prefix.length < offset) prefix += filler;
        prefix = prefix.slice(0, offset - lead.length) + lead;
        const text = prefix + value + ',麻烦尽快处理,后面还有一些补充说明不重要。';
        const kept = Math.max(0, Math.min(value.length, cut - prefix.length));
        cases.push({ kind: k.kind, context, offset: prefix.length, cut, value, text, straddles: kept > 0 && kept < value.length });
      }
    }
  }
  return cases;
}
function residualFragment(output, value, offset, cut) {
  // 截断后残留在窗口里的那一段原值:value.slice(0, cut - offset)。只认 ≥4 字的残段(更短的段携带的信息可以忽略)。
  const kept = Math.max(0, Math.min(value.length, cut - offset));
  if (kept < 4) return null;
  const frag = value.slice(0, kept);
  return output.includes(frag) ? { kept, frag: kept === value.length ? 'full' : 'partial' } : null;
}
async function runPrivacy() {
  // 150 P1 修复后三个引擎的标题/摘要共用 02 的 sessionAutoTitle / sessionAutoSummary(真函数可直调);修前的检出里
  // 没有这两个名字,照旧用照抄的行内表达式 —— 同一把尺子量修前修后。网关按 enhanced 档配置(与产品同一个入口),
  // 修前的检出里配置它不影响任何截断(修前截断不看策略)。
  const productionCut = /\nfunction sessionAutoTitle\(/.test(fs.readFileSync(process.env.RUYI_TEST_SERVER_JS || path.join(REPO, 'ruyi-workbench', 'app', 'server.js'), 'utf8'));
  const api = loadServer(['PrivacyCore', 'PrivacyGateway', 'sessionRecentUserRequest', ...(productionCut ? ['sessionAutoTitle', 'sessionAutoSummary'] : [])]);
  const core = api.PrivacyCore;
  api.PrivacyGateway.configure({ privacyModeV1: 'enhanced', privacyTechnicalV1: false, privacyRulesV1: [], providers: [] });
  // 03a options(config) 在 enhanced 档的取值:personal:true、confidential:false、technical 用默认 false。
  const detectorOptions = { personal: true, confidential: false, technical: false, knownSecrets: [], rules: [] };
  const norm = text => text.replace(/\s+/g, ' ').trim();
  const sites = [
    productionCut
      ? { site: 'thread-title', cut: 60, where: '02-session-store.js sessionAutoTitle (real function; 05 / 05b / 09 call it)', truncate: t => api.sessionAutoTitle(t), from: 40, to: 66 }
      : { site: 'thread-title', cut: 60, where: '09-workflow.js / 05-claude-engine.js / 05b-kimi-bridge.js: message.replace(/\\s+/g,\' \').trim().slice(0,60)', truncate: t => norm(t).slice(0, 60), from: 40, to: 66 },
    productionCut
      ? { site: 'thread-summary', cut: 160, where: '02-session-store.js sessionAutoSummary (real function; 05 / 05b / 09 call it)', truncate: t => api.sessionAutoSummary(t), from: 140, to: 166 }
      : { site: 'thread-summary', cut: 160, where: '09-workflow.js / 05 / 05b: (text).replace(/\\s+/g,\' \').trim().slice(0,160)', truncate: t => norm(t).slice(0, 160), from: 140, to: 166 },
    { site: 'recent-user-request', cut: 240, where: '02-session-store.js sessionRecentUserRequest (real function)', truncate: t => { const r = api.sessionRecentUserRequest({ messages: [{ role: 'user', content: t }] }); return r ? r.text : ''; }, from: 220, to: 246 },
  ];
  const out = { mode: 'privacy', detectorOptions: { personal: true, confidential: false, technical: false }, minFragmentChars: 4, sites: [] };
  for (const site of sites) {
    const cases = privacyCorpus(site.cut, site.from, site.to);
    const tally = { site: site.site, cut: site.cut, where: site.where, offsets: [site.from, site.to], cases: cases.length, straddling: 0, controlMissed: 0,
      truncateThenDetect: { fresh: 0, learned: 0, worst: 0, keptAtLeast8: 0 }, detectThenTruncate: 0, byKind: {}, examples: [] };
    for (const c of cases) {
      const key = c.kind + '/' + c.context;
      const by = tally.byKind[key] || (tally.byKind[key] = { cases: 0, straddling: 0, truncateThenDetect: 0, detectThenTruncate: 0, controlMissed: 0 });
      by.cases++;
      if (c.straddles) { tally.straddling++; by.straddling++; }
      // 对照:整段识别能否认出这个值(认不出 = 检测器本身漏检,不归截断的账,单独计数)。
      const control = core.createScope({ scopeId: 'xg-control', detector: core.createDetector(detectorOptions) });
      const whole = control.protectRaw(c.text).text;
      if (whole.includes(c.value)) { tally.controlMissed++; by.controlMissed++; continue; }
      // A. 生产顺序:先截断,再把残片交给识别。fresh = 新 scope;learned = 同一 scope 先识别过整段原文(主回合已经外发过全文的情形)。
      const cut = site.truncate(c.text);
      const fresh = core.createScope({ scopeId: 'xg-fresh', detector: core.createDetector(detectorOptions) }).protectRaw(cut).text;
      const learnedScope = core.createScope({ scopeId: 'xg-learned', detector: core.createDetector(detectorOptions) });
      learnedScope.protectRaw(c.text);
      const learned = learnedScope.protectRaw(cut).text;
      const rf = residualFragment(fresh, c.value, c.offset, site.cut);
      const rl = residualFragment(learned, c.value, c.offset, site.cut);
      if (rf) tally.truncateThenDetect.fresh++;
      if (rl) tally.truncateThenDetect.learned++;
      const worst = rf || rl;
      if (worst) { tally.truncateThenDetect.worst++; by.truncateThenDetect++; if (worst.kept >= 8) tally.truncateThenDetect.keptAtLeast8++; }
      // B. 先识别整段、再截断识别后的文本(期望 0 残片;代号可能被截半,那是 150 P6 的另一笔账,不在这里计)。
      const protectedCut = norm(whole).slice(0, site.cut);
      if (residualFragment(protectedCut, c.value, c.offset, site.cut)) { tally.detectThenTruncate++; by.detectThenTruncate++; }
      if (worst && tally.examples.length < 8) tally.examples.push({ kind: c.kind, context: c.context, offset: c.offset, keptChars: worst.kept, of: c.value.length });
    }
    out.sites.push(tally);
  }
  return out;
}

// 151 §4.2「隐私」后半句 + 150 P12/P13(3.1 阶段 4 补的量具)。两件事都在进程里装真 server.js:
// ① 短学习值:enhanced 档真网关(映射照常落盘、加密走本机 DPAPI),每个短值一个线程:第一回合「token: <值>」/「密码：<值>」,
//    第二回合带历史、普通问句与 file_read 工具定义再发一次;记第二回合被整轮拒掉的数目(期望 0)。
// ② 检出语料:privacy-31 下全部语料(合成目录、校验、混合、第二/三场景、格式缺口、阶段 4)过真 PrivacyCore,
//    记正例完整覆盖数与反例误报数;RUYI_TEST_SERVER_JS 指到修前产物即可同尺量修前。
async function runPrivacyLearned() {
  const api = loadServer(['PrivacyCore', 'PrivacyGateway']);
  const config = { privacyModeV1: 'enhanced', privacyTechnicalV1: false, privacyRulesV1: [], providers: [], credentialEncryptionV1: true };
  api.PrivacyGateway.configure(config);
  const values = ['on', 'a', '1', 'ok', 'x', 'id', 'no', 'read', 'role', 'type', 'content', 'user', 'string', 'name', 'Qz7k'];
  const tools = [{ type: 'function', function: { name: 'file_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } } }];
  const rows = [];
  for (const [index, value] of values.entries()) for (const lead of ['token: ', '密码：']) {
    const scopeId = 'xg-short-' + index + '-' + (lead === 'token: ' ? 't' : 'p'), first = lead + value;
    const row = { value, lead: lead.trim(), first: 'ok', second: 'ok' };
    try { await api.PrivacyGateway.run(scopeId, config, () => api.PrivacyGateway.beforeModelRequest({ model: 'fixture', messages: [{ role: 'user', content: first }], tools })); }
    catch (error) { row.first = String(error && error.code || error); }
    try {
      await api.PrivacyGateway.run(scopeId, config, () => api.PrivacyGateway.beforeModelRequest({ model: 'fixture', tools, messages: [
        { role: 'user', content: first }, { role: 'assistant', content: 'ok, noted.' },
        { role: 'user', content: 'Please read the file and summarise its content for the user; the name and type of each record matter.' }] }));
    } catch (error) { row.second = String(error && error.code || error); }
    rows.push(row);
  }
  return { mode: 'privacy-learned', rows, cases: rows.length, failedSecond: rows.filter(row => row.second !== 'ok').length, failedFirst: rows.filter(row => row.first !== 'ok').length };
}
async function runPrivacyDetect() {
  const api = loadServer(['PrivacyCore']);
  const core = api.PrivacyCore, dir = path.join(REPO, 'dev-harness', 'privacy-31');
  const all = { personal: true, technical: true, confidential: true }, personal = { personal: true };
  const tier = name => name === 'basic' ? {} : name === 'technical' ? { personal: true, technical: true } : personal;
  const sets = {};
  const bucket = name => sets[name] ||= { positives: 0, covered: 0, negatives: 0, falsePositives: 0, missed: [], falseSamples: [] };
  const positive = (name, id, sample, secret, options) => {
    const b = bucket(name), start = sample.indexOf(secret); b.positives++;
    if (start >= 0 && core.createDetector(options).detect(sample).some(m => m.start <= start && m.end >= start + secret.length)) b.covered++; else b.missed.push(id);
  };
  const negative = (name, sample, options) => { const b = bucket(name); b.negatives++; if (core.createDetector(options).detect(sample).length) { b.falsePositives++; b.falseSamples.push(sample.length); } };
  const { createCorpus, createMixedCorpus } = require(path.join(dir, 'synthetic-catalog-corpus.js'));
  for (const row of createCorpus('experience-gate')) positive('synthetic-catalog', row.id, row.sample, row.secret, all);
  for (const row of createMixedCorpus().rows) for (const secret of row.secrets || [row.secret]) positive('mixed', row.id, row.sample, secret, tier(row.tier));
  const second = require(path.join(dir, 'second-scenario-corpus.js')).createSecondCorpus();
  for (const row of second.cases) positive('second', row.id, row.sample, row.secret, row.tier === 'basic' ? {} : personal);
  for (const sample of second.negatives) negative('second', sample, { personal: true, confidential: true });
  const third = require(path.join(dir, 'third-scenario-corpus.js')).createThirdCorpus();
  for (const row of third.cases) positive('third', row.id, row.sample, row.secret, row.tier === 'basic' ? {} : personal);
  for (const sample of third.negatives) negative('third', sample, personal);
  const gap = require(path.join(dir, 'format-gap-corpus.js')).createFormatGapCorpus();
  for (const row of gap.cases) positive('format-gap', row.id, row.sample, row.secret, row.tier === 'basic' ? {} : personal);
  for (const sample of gap.negatives) negative('format-gap', sample, personal);
  const phase4 = require(path.join(dir, 'phase4-detection-corpus.js')).createPhase4Corpus();
  for (const row of phase4.cases) positive('phase4', row.id, row.sample, row.secret, tier(row.tier));
  for (const row of phase4.negatives) negative('phase4', row.sample, tier(row.tier));
  const total = Object.values(sets).reduce((t, b) => ({ positives: t.positives + b.positives, covered: t.covered + b.covered, negatives: t.negatives + b.negatives, falsePositives: t.falsePositives + b.falsePositives }), { positives: 0, covered: 0, negatives: 0, falsePositives: 0 });
  return { mode: 'privacy-detect', ruleCatalogVersion: core.ruleCatalogVersion, sets, total };
}

// ── 入口 ─────────────────────────────────────────────────────────────────────────────────────
const MODES = { send: runSend, first: runFirst, search: runSearch, bigtext: runBigtext, semdown: runSemdown, privacy: runPrivacy, 'privacy-learned': runPrivacyLearned, 'privacy-detect': runPrivacyDetect };
if (require.main === module) (async () => {
  const problems = isolationProblems();
  if (problems.length) { emit('XG_REFUSED', { problems }); process.exitCode = 3; return; }
  const run = MODES[MODE];
  if (!run) { emit('XG_REFUSED', { problems: ['unknown mode ' + MODE] }); process.exitCode = 2; return; }
  const t0 = performance.now();
  let result;
  try { result = await run(); }
  catch (error) { result = { mode: MODE, fatal: String(error && error.stack || error).slice(0, 2000) }; }
  result.workerMs = round(performance.now() - t0);
  result.pid = process.pid;
  emit('XG_RESULT', result);
  emit('XG_DONE');
  // 等宿主按树收尸(它要趁根还活着认子孙);兜底自退。不 unref:没有服务的 mode(privacy)也得活到宿主来收。
  setTimeout(() => process.exit(0), Number(process.env.XG_SELF_EXIT_MS) || 120000);
})();

module.exports = { isolationProblems, within };
