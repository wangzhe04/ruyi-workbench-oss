(async () => {
'use strict';
// E2E(第 116 波 116-pre · 27 号文 §8.12「递话：交给线程的交互」/ §11.1 第 3 项/ §11.3):
// GET /api/steward/preroute —— 真服务、真会话、零模型判定路径的端到端验证。
//
// 覆盖:
//  (A) 开关关:GET /api/steward/preroute -> 409 steward.disabled(稳定信封),无 token -> 403。
//  (B) 开关开:建 6 条会话(3 条 floor 要求之上多建 3 条,专为 unsure/needs_you/done 场景各留一条
//      干净的事实源;标题互不相同,除两条刻意同前缀外),覆盖六种 kind:
//        steward(空串)/ schedule(定时意图优先于线程命中)/ question(疑问句)/
//        thread(单线程 title 命中 与 「」短语命中两例)/ unsure(两条标题同前缀的线程打平)/
//        new(与任何线程都不相关的陈述句)。
//  (C) 无 token -> 403(ROUTE_AUTH token 级)。
//  (D) 性能:缓存命中后连续 20 次同 q 请求,p50 tookMs ≤ 50ms。
//  (E) 不写盘:先停轮询(POST /api/steward/stop)避免收件箱后台 tick 干扰,快照 <data>/steward
//      目录的文件集合(路径+字节数),跑完 (B)(D) 的全部请求后再快照一次,前后必须完全一致。
//
// 端口全部 getFreePort() 动态取。判定行:`STEWARD PREROUTE E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-preroute-'));
const PROVIDER_PORT = await getFreePort(), WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
async function waitToken() { // 117q:预算 60×100ms=6s 小于本机冷启动实测 4.6-6.3s,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { const t = readToken(); if (t) return t; await sleep(100); } return ''; }
// 117q-P1-32:上面的 waitToken 只等「非空」,在重启点不够 —— server.listen 先让 /health 答 200,
// runtime.json 里的新 token 要晚一步才落盘,窗口期内 waitToken() 会读到【上一个进程】的旧 token(非空,
// 但已失效)。重启点改用这个:轮询到 readToken() 与旧值不同再返回(token 每次 boot 都是新的
// randomBytes(16),必然会变);预算与 waitToken/waitHealth 同量级(300×100ms)。
async function waitTokenRotated(oldToken) {
  for (let i = 0; i < 300; i++) { const t = readToken(); if (t && t !== oldToken) return t; await sleep(100); } return readToken(); }

function request(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: pathname, method, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
const get = (p, token) => request('GET', p, null, token);
const post = (p, body, token) => request('POST', p, body == null ? {} : body, token);
const preroute = (q, token) => get('/api/steward/preroute?q=' + encodeURIComponent(q), token);

async function waitHealth() { // 117q:预算 80×100ms=8s 小于本机冷启动实测 4.6-6.3s 且余量过窄,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) {
    const r = await get('/health').catch(() => null);
    if (r && r.status === 200) return true;
    await sleep(100);
  }
  return false;
}

function writeConfig(stewardOn) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'default', // file_write(edit 层)必须走 permission_request,才能造出 needs_you 事实
    permissionTimeoutMs: 5000, // 下限:sidNeedsYou 故意不放行,靠超时自动收尾好让测试跑得快
    includeWorkbenchMcp: true, defaultWorkspace: HOME, recentWorkspaces: [],
    stewardEnabledV1: stewardOn, stewardPollMs: 120000, // 拉满上限,测试窗口内不会自己 tick
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }), 'utf8');
}

function spawnWb() {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true,
  });
  child.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  return child;
}

// fake-openai:内容寻址,不依赖请求顺序(6 条会话的聊天回合可能并发到达)。
//   · 最后一条 user 消息含 __PERM__ -> 回一个 file_write 工具调用(触发 permission_request,故意不放行)。
//   · 否则含 __REPLY__<text>__ -> 原样回 <text> 当最终助手文本(用于验证「不同标题与最后助手文本」)。
function startProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url === '/health' ? '{"ok":true}' : '{"data":[{"id":"fake-model"}]}'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body = null; try { body = JSON.parse(raw); } catch { /* 形状不重要 */ }
    const messages = Array.isArray(body && body.messages) ? body.messages : [];
    let lastUserText = '';
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i] && messages[i].role === 'user') { lastUserText = String(messages[i].content || ''); break; } }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = v => res.write('data: ' + JSON.stringify(v) + '\n\n');
    if (lastUserText.includes('__PERM__')) {
      const args = JSON.stringify({ path: path.join(HOME, 'preroute-perm-target.txt'), content: 'x' });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_p1', type: 'function', function: { name: 'file_write', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      const m = lastUserText.match(/__REPLY__([\s\S]*?)__/);
      const reply = m ? m[1] : '好的。';
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}

// 起一个流式回合,等它跑完(不管 permission_request 与否——需要放行的场景另有专门流程,这里的
// needs_you 用例故意【不放行】,让它停在待决状态)。
function streamChat(body, token) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token,
    } }, res => { let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve(buf)); });
    req.on('error', reject); req.write(raw); req.end();
  });
}

async function newTitledSession(title, token) {
  const r = await post('/api/sessions', { title }, token);
  const sid = r.json && r.json.session && r.json.session.id;
  if (!sid) throw new Error('failed to create session: ' + title);
  return sid;
}

// 递归列出目录下所有文件的相对路径+字节数(排序后拼成一个可比较的字符串)——「不写盘」断言的快照口径。
function snapshotDir(dir) {
  const out = [];
  const walk = base => {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(base, ent.name);
      if (ent.isDirectory()) walk(full);
      else { let size = -1; try { size = fs.statSync(full).size; } catch { /* race, ignore */ } out.push(path.relative(dir, full).replace(/\\/g, '/') + ':' + size); }
    }
  };
  walk(dir);
  out.sort();
  return out.join('\n');
}

readServerSource(); // 顺带验证 src/ 与产物新鲜度
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
const provider = await startProvider();
let wb = null;

try {
  /* ═════════════ (A) 开关关:409 steward.disabled + 无 token 403 ═════════════ */
  writeConfig(false);
  wb = spawnWb();
  ok(await waitHealth(), '(A) workbench up(开关关)');
  const tokOff = await waitToken();
  ok(!!tokOff, '(A) runtime token 可读');
  const offResp = await preroute('随便', tokOff);
  ok(offResp.status === 409 && offResp.json && offResp.json.error && offResp.json.error.code === 'steward.disabled',
    '(A) 开关关:GET /api/steward/preroute -> 409 steward.disabled(稳定信封)');
  ok((await preroute('随便')).status === 403, '(A) 开关关:无 token -> 403(ROUTE_AUTH token 级)');
  kill(wb); wb = null; await sleep(400);

  /* ═════════════ (B)(C)(D)(E) 开关开 ═════════════ */
  writeConfig(true);
  wb = spawnWb();
  ok(await waitHealth(), '(B) workbench up(开关开)');
  // 117q-P1-32:waitHealth 只证明 listen 已起来,不证明新 token 已落盘——用 waitTokenRotated 等到跟
  // (A) 阶段的旧 token(tokOff)不同,不然带旧 token 的后续请求会全数 403。
  const tok = await waitTokenRotated(tokOff);
  ok(!!tok, '(B) runtime token 可读');

  ok((await preroute('随便')).status === 403, '(C) 开关开:无 token 依旧 403');

  // ── 建 6 条会话(标题互不相同,除刻意留的一对同前缀用于 unsure)──────────────────────────
  const sidPay = await newTitledSession('支付网关重构', tok);
  const sidReport = await newTitledSession('周报-W36', tok);
  const sidNeedsYou = await newTitledSession('成本复盘', tok);
  const sidDone = await newTitledSession('月度对账', tok);
  const sidTieA = await newTitledSession('预算评审甲组', tok);
  const sidTieB = await newTitledSession('预算评审乙组', tok);

  await streamChat({ sessionId: sidPay, message: '进度怎么样__REPLY__已经完成接口联调__' }, tok);
  await streamChat({ sessionId: sidReport, message: '进度怎么样__REPLY__本周结项，等待复核__' }, tok);
  await streamChat({ sessionId: sidTieA, message: '看看__REPLY__甲组已提交__' }, tok);
  await streamChat({ sessionId: sidTieB, message: '看看__REPLY__乙组已提交__' }, tok);
  // sidNeedsYou:故意触发 permission_request 且不放行,让它停在待决(需要你)状态。
  await streamChat({ sessionId: sidNeedsYou, message: '帮我处理一下__PERM__' }, tok);
  // sidDone:走既有 mission 路径,里程碑标全 done -> 结果章 complete -> 五态 done。
  await post('/api/mission', { sessionId: sidDone, action: 'start', mission: { goal: '对账收尾', milestones: [{ id: 'm1', desc: '第一步' }] } }, tok);
  await post('/api/mission', { sessionId: sidDone, action: 'update', patch: { milestones: [{ id: 'm1', status: 'done' }] } }, tok);
  await sleep(300); // 让投影(13e)与会话头落定

  // 先各跑一次确认基本形状(status/字段),再进 (D) 的 p50 批量测。
  const rSteward = await preroute('', tok);
  ok(rSteward.status === 200 && rSteward.json.ok === true && rSteward.json.kind === 'steward' && Array.isArray(rSteward.json.hits) && rSteward.json.hits.length === 0,
    '(B) 空串 -> kind:steward');
  ok(typeof rSteward.json.tookMs === 'number' && rSteward.json.tookMs >= 0, '(B) 响应带 tookMs(数值,非负)');

  const rSchedule = await preroute('明天9点提醒我交周报', tok);
  ok(rSchedule.status === 200 && rSchedule.json.kind === 'schedule',
    `(B) 交付物原例「明天9点提醒我交周报」-> kind:schedule,不因「周报-W36」命中线程(实测 ${rSchedule.json.kind})`);

  const rQuestion = await preroute('现在哪条最烧钱', tok);
  ok(rQuestion.status === 200 && rQuestion.json.kind === 'question',
    `(B) 交付物原例「现在哪条最烧钱」-> kind:question(实测 ${rQuestion.json.kind})`);

  const rThread = await preroute('支付网关重构', tok);
  ok(rThread.status === 200 && rThread.json.kind === 'thread' && rThread.json.hits[0] && rThread.json.hits[0].sessionId === sidPay,
    `(B) title 精确命中 -> kind:thread,命中的是「支付网关重构」那条(实测 ${JSON.stringify(rThread.json)})`);
  ok(typeof rThread.json.hits[0].reason === 'string' && rThread.json.hits[0].reason.length > 0, '(B) thread hit 带非空 reason');

  const rPhrase = await preroute('帮我看下「周报-W36」的情况', tok);
  ok(rPhrase.status === 200 && rPhrase.json.kind === 'thread' && rPhrase.json.hits[0] && rPhrase.json.hits[0].sessionId === sidReport,
    `(B) 「」短语整段命中 -> kind:thread,命中的是「周报-W36」那条(实测 ${JSON.stringify(rPhrase.json)})`);
  ok(rPhrase.json.hits[0].reason.includes('短语命中'), '(B) 短语命中的 reason 标注「短语命中」');

  const rUnsure = await preroute('预算评审', tok);
  ok(rUnsure.status === 200 && rUnsure.json.kind === 'unsure' && Array.isArray(rUnsure.json.hits) && rUnsure.json.hits.length === 2,
    `(B) 两条同前缀线程打平 -> kind:unsure,给两条候选(实测 ${JSON.stringify(rUnsure.json)})`);
  if (rUnsure.json.kind === 'unsure') {
    const gotIds = rUnsure.json.hits.map(h => h.sessionId).sort();
    const wantIds = [sidTieA, sidTieB].sort();
    ok(JSON.stringify(gotIds) === JSON.stringify(wantIds), '(B) unsure 的两条候选恰好是「预算评审甲组/乙组」那两条');
  }

  const rNew = await preroute('今天天气不错随便逛逛', tok);
  ok(rNew.status === 200 && rNew.json.kind === 'new' && rNew.json.hits.length === 0,
    `(B) 与任何线程都不相关的陈述句 -> kind:new(实测 ${rNew.json.kind})`);

  /* ═════════════ (D) 性能:缓存命中后 p50 ≤ 50ms ═════════════ */
  await preroute('支付网关重构', tok); // 预热一次,让 index 装配的缓存先建好(revision 命中路径)
  const timings = [];
  for (let i = 0; i < 20; i++) {
    const r = await preroute('支付网关重构', tok);
    ok(r.status === 200, `(D) 第 ${i + 1} 次请求 200`);
    timings.push(Number(r.json.tookMs) || 0);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length / 2)];
  ok(p50 <= 50, `(D) 缓存命中后 p50 tookMs ≤ 50ms(实测 p50=${p50}ms,全量=${JSON.stringify(timings)})`);

  /* ═════════════ (E) 不写盘 ═════════════ */
  await post('/api/steward/stop', {}, tok); // 停轮询,消除后台 tick 的时序干扰
  await sleep(200);
  const stewardDir = path.join(HOME, 'steward');
  const before = snapshotDir(stewardDir);
  for (const q of ['', '明天9点提醒我交周报', '现在哪条最烧钱', '支付网关重构', '预算评审', '今天天气不错随便逛逛']) {
    await preroute(q, tok);
  }
  const after = snapshotDir(stewardDir);
  ok(before === after, '(E) 跑完全部 preroute 请求后,<data>/steward 目录的文件集合(路径+字节数)前后一致(零写入)');
} catch (e) {
  fail++; console.log('FAIL 未捕获异常: ' + ((e && e.stack) || e));
} finally {
  kill(wb);
  try { provider.close(); } catch { /* already down */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fail === 0 ? 'STEWARD PREROUTE E2E: ALL PASS' : `STEWARD PREROUTE E2E: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
})();
