#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// E2E(第 117 波 117m-A5 · 27 号文 §11.10):「看全文」要真的看得到东西 —— 在途回合的正文。
//
// 用户第六轮走查①「现在点开线程的看全文,还是啥也看不到」。根因不是渲染,是【数据根本不在盘上】:
// 助手消息在回合收尾时才落盘,而管家派出去的回合没有任何客户端挂在它的流上 —— 用户真机上那条线程
// 跑了 15 分钟、53 次工具调用,sessions/<id>.messages.ndjson 只有那条 user 消息一行。
// 修法:04 的 appendLiveTail 从「最后 600 字的尾巴」扩成「本回合正文 + 最近工具名」(仍然只在内存),
// 13d 把它挂在既有 GET /api/sessions/:id 的信封上,经典壳据此画一张临时气泡。
//
// 覆盖:
//   (A) 活回合:信封带 liveTail.full(非空、是真流出来的文本)、tools 有工具名与状态、iterations ≥ 1,
//       且【liveTail 里不含任何工具参数与工具结果】—— 那两样可能带密钥。先用 A7a 证明这两个记号
//       确实在本回合里流过(它们在会话自己的 providerHistory 里,那是本波之前就有的既有载荷),
//       A7/A8 才不是空断言。
//   (B) 回合结束:liveTail 这个键消失(不落盘),正文这时候才出现在 messages.ndjson 里。
//   (C) full 超顶(12000 字)时从【头部】截断且 truncated:true —— 用户要看的是「它现在在说什么」。
//   (D) 117l 的老语义一字未动:text 仍然 ≤600 字,且是 full 的尾巴。
//
// 117o-A7(用户第七轮走查,两张截图对照:「为啥这个查看全文,不能像 2.0 那样显示呢?第二张图是 2.0 的」):
// A5 只送了一段拼好的纯文本,渲染层再怎么写也画不出思考块 / 过程记录 / 工具卡 —— 差距的根子是数据形状。
// 服务端早就有 02c 的 createTurnSegmentBuilder 那份【有序叙事账本】(回合落盘后经典壳重建叙事靠的就是它),
// 只是从没在途下发过。本波把它作为一个【新键】liveTurn 挂上同一个信封,前端用同一个渲染器画。新增覆盖:
//   (E) liveTurn:段的顺序与真实事件顺序一致(文字 → 工具 → 文字)、工具段带 name/status、
//       toolCalls 每行恰好 {id,name,inputPreview,status} 四个键、inputPreview 是真参数(带 ARG 记号),
//       且【一个工具结果字节都没有】(RESULT 记号 0 次);回合结束后这个键消失,落盘消息的段序与它一致
//       (证明在途与落盘是同一份账本,不是两套数据);liveTail 那几个老键一个字没被动。
//   (F) liveTurn 超顶:单段硬顶 12000,超顶从【头部】丢弃并置 truncated:true(与 full 同方向)。
//
// 判定行:`LIVE FULL TEXT E2E: ALL PASS`。
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-live-full-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* gone */ } } }

// 工具【参数】与工具【结果】各埋一个可辨认的记号。信封里出现任何一个都算泄密。
const ARG_MARKER = 'SECRET-ARG-MARKER';
const RESULT_MARKER = 'SECRET-RESULT-MARKER';
let probeFile = '';   // 本轮 file_read 真正要读的那个文件(绝对路径,文件名里就带 ARG_MARKER)
const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();
const sessionsDir = path.join(HOME, 'sessions');
const configFile = path.join(HOME, 'config.json');

// ── fake provider ────────────────────────────────────────────────────────────────────────────
// 按最后一条 user 消息里的暗号分流:
//   'LIVEFULL' → 先流一段正文 → 调一次 file_read(read 档 → 自动放行,不弹权限) → 收到结果后再流一段
//                正文,睡 2.5s 再收尾(给轮询留出「回合还活着」的窗口)。
//   'LIVEBIG'  → 一口气流 13000+ 字(头尾各埋一个记号)再睡 4s,用来看 full 的截断方向。
const providerServer = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if ((req.url || '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"data":[{"id":"fake-model"}]}');
  }
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const users = messages.filter(m => m && m.role === 'user').map(m => String(m.content || ''));
  const lastUser = users.length ? users[users.length - 1] : '';
  const toolAnswered = messages.some(m => m && m.role === 'tool');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
  const delta = text => sse({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  const stop = () => {
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ }
  };

  if (/LIVEBIG/.test(lastUser)) {
    delta('HEADMARK-开头这一段应该被砍掉。');
    delta('填充'.repeat(6600));   // 13200 字,连头带尾必定超过 12000 的硬顶
    delta('结尾这一段必须留下-TAILMARK');
    await sleep(4000);
    return stop();
  }
  if (/LIVEFULL/.test(lastUser) && !toolAnswered) {
    delta('第一段:我先看一眼这件事的现场。');
    const args = JSON.stringify({ path: probeFile });
    sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_live_1', type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ }
    return;
  }
  if (/LIVEFULL/.test(lastUser)) {
    delta('第二段:看完了,现在我把结论写下来。');
    await sleep(2500);
    delta('第三段:这就是全部结论。');
    return stop();
  }
  delta('好的,记下了。');
  return stop();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(configFile, JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', permissionTimeoutMs: 120000, questionTimeoutMs: 120000,
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
  subagentMaxPerTurn: 0, killOnDisconnect: false, locale: 'zh-CN',
  autoImportClaudeCodeMcp: false,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');

function request(method, p, body, headers) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: p, method, timeout: 60000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(headers || {}) },
    }, res => {
      // 117o-A7:攒 Buffer 再一次性解码。修前是 `b += c`(逐块 toString),一个三字节汉字被 chunk 边界
      // 劈开就会变成两个 U+FFFD —— 本件的载荷是两万多个汉字,必踩,读出来的字数会凭空多几个,
      // 于是「硬顶 12000 字」这类长度断言会假红(实测 12002)。这是夹具的读法错,不是被测代码错。
      const chunks = []; res.on('data', c => { chunks.push(Buffer.from(c)); });
      res.on('end', () => {
        const b = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(b); } catch { json = null; }
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}
async function waitUp() { // 117q:预算 150×120ms=18s 低于 30 号文 P1-31 建议的 300×同款间隔量级,为同批口径统一一并抬高(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { const h = await request('GET', '/health'); if (h.status === 200) return true; await sleep(120); }
  return false;
}
async function tokenOf() {
  const html = await new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); });
    r.on('error', () => resolve(''));
  });
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}
const sessionMessages = id => {
  try {
    return fs.readFileSync(path.join(sessionsDir, id + '.messages.ndjson'), 'utf8').split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

let hdr = {};
let wb = null;
try {
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stdout.on('data', () => {});
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  ok(await waitUp(), '工作台启动');
  hdr = { 'x-wcw-token': await tokenOf() };

  let wsSeq = 0;
  const newThread = async title => {
    const cwd = path.join(HOME, 'ws', 'w' + (++wsSeq));
    fs.mkdirSync(cwd, { recursive: true });
    // 工具【结果】里的记号:file_read 真读到的内容。信封里出现它就是结果泄漏。
    probeFile = path.join(cwd, `${ARG_MARKER}.txt`);
    fs.writeFileSync(probeFile, `${RESULT_MARKER} 这是工具结果,绝不该出现在信封里。`, 'utf8');
    const created = await request('POST', '/api/sessions', { title, cwd }, hdr);
    return { id: created.json && created.json.session && created.json.session.id, cwd };
  };
  // 不等回合结束地起一个回合(模拟「别处起的回合」:发起方把流读掉但不渲染)。
  const fireTurn = (sessionId, message, cwd) => {
    const body = JSON.stringify({ sessionId, message, cwd });
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...hdr },
    }, res => { res.on('data', () => {}); res.on('end', () => {}); });
    r.on('error', () => {});
    r.write(body); r.end();
    return r;
  };

  /* ═════════ (A) 活回合的正文与工具名 ═════════ */
  console.log('── (A) 活回合:full / tools / iterations,且零工具参数与结果 ──');
  let sidA = '';
  let tailA = null;          // A 段抓到的那一份活文本(C6 的 companion 要用它)
  let turnA = null;          // 117o-A7:A 段抓到的那一份【叙事账本】(E 段用)
  let rawA = '';             // 117o-A7:A 段那一整份信封的原始 JSON(扫记号用)
  let midFlightA = [];       // 回合还活着时盘上的样子(B0 用;在 A 段当场取,不留时间窗)
  {
    const th = await newThread('看全文');
    sidA = th.id;
    ok(!!sidA, `A0 线程建起来了(got ${sidA})`);
    fireTurn(sidA, 'LIVEFULL 请看一眼', th.cwd);
    let env = null;   // 整份信封(原始 JSON 文本一起留着,用来扫记号)
    for (let i = 0; i < 400; i++) {
      const s = await request('GET', `/api/sessions/${sidA}`, undefined, hdr);
      const lt = s.json && s.json.liveTail;
      // 117o-A7:等到【两份东西都齐】才取样 —— 文本尾巴有工具行,且叙事账本里那一段工具已经收尾。
      const seg = s.json && s.json.liveTurn && Array.isArray(s.json.liveTurn.segments) ? s.json.liveTurn.segments : [];
      const toolDone = seg.some(x => x && x.type === 'tool' && x.status === 'done');
      // 128f 取证修正（ede0e1d 全量首现、负载 6×3 复现 4–6/18；A7a-DIAG 现场：取样那一刻盘上历史只有 ["user"]、叙事账本
      // 只到 ["text","tool:done"]）：修前「工具收尾」一出现就取样，而 E2/A7a 要的是再往后一步的东西 —— 工具之后那一段
      // 文字、以及回合中途存盘落下的工具结果。这两样与「工具收尾」之间本来就隔着回合起跑时那次能力探测；128f-⑬ 把探测里
      // 两发 git 从同步改异步之后，服务不再被它钉住，这一段空当就变得可观测（只把那两发改回同步 → 18/18 绿，坐实）。
      // 所以等到【工具之后那一段文字也到了】再取样：假模型在「第二段」之后停 2.5 s 才收尾，活回合的窗口足够。
      // 这不是放宽：产品若不在回合中途落工具结果，A7a 照样红；段序不对，E2 照样红。
      const toolAt = seg.findIndex(x => x && x.type === 'tool' && x.status === 'done');
      const textAfterTool = toolAt >= 0 && seg.slice(toolAt + 1).some(x => x && x.type === 'text' && /第二段/.test(String(x.text || '')));
      if (lt && String(lt.full || '') && Array.isArray(lt.tools) && lt.tools.length && toolDone && textAfterTool) { env = s; midFlightA = sessionMessages(sidA); break; }
      await sleep(60);
    }
    const tail = env && env.json && env.json.liveTail;
    tailA = tail;
    turnA = env && env.json ? env.json.liveTurn : null;
    rawA = String((env && env.raw) || '');
    ok(!!tail, `A1 活回合时 GET /api/sessions/:id 带 liveTail(got ${tail ? 'yes' : 'no'})`);
    ok(!!(tail && /第一段/.test(String(tail.full || ''))),
      `A2 liveTail.full 是这一回合真流出来的正文(got ${tail && String(tail.full).slice(0, 40)})`);
    ok(!!(tail && Array.isArray(tail.tools) && tail.tools.some(x => x && x.name === 'file_read')),
      `A3 liveTail.tools 里有工具名(got ${JSON.stringify(tail && tail.tools)})`);
    ok(!!(tail && Array.isArray(tail.tools) && tail.tools.every(x => x && typeof x.status === 'string' && x.status && typeof x.startedAt === 'string')),
      'A4 每条工具行都带状态与起点');
    ok(!!(tail && Array.isArray(tail.tools) && tail.tools.some(x => x && x.status === 'done' && x.endedAt)),
      `A4b 工具跑完后那一行按 id 配对收尾(status=done + endedAt;got ${JSON.stringify(tail && tail.tools)})`);
    ok(!!(tail && Number(tail.iterations) >= 1), `A5 iterations 记到了这一轮工具(got ${tail && tail.iterations})`);
    ok(!!(tail && typeof tail.startedAt === 'string' && tail.startedAt), `A6 startedAt 是回合起点(got ${tail && tail.startedAt})`);
    // 本条是本切片的安全线:信封只许有工具【名字】,不许有工具参数与工具结果。
    const rawEnvelope = String((env && env.raw) || '');
    const rawTail = JSON.stringify(tail || null);
    // 先证明这两个记号【确实在这一回合里流过】(它们在会话自己的 providerHistory 里,那是 117l 之前
    // 就有的既有载荷,本波一个字没动),否则下面两条就是空断言。
    ok(rawEnvelope.includes(ARG_MARKER) && rawEnvelope.includes(RESULT_MARKER),
      'A7a 前提:工具参数与工具结果确实在这一回合里流过(会话自己的 providerHistory 里有)');
    if (!(rawEnvelope.includes(ARG_MARKER) && rawEnvelope.includes(RESULT_MARKER))) {
      // 现场(A7a-DIAG):取样那一刻信封里的会话历史长什么样、叙事账本各段是什么状态。
      const sj = env && env.json && env.json.session;
      const ph = sj && Array.isArray(sj.providerHistory) ? sj.providerHistory : [];
      const segs = env && env.json && env.json.liveTurn && Array.isArray(env.json.liveTurn.segments) ? env.json.liveTurn.segments : [];
      console.log('A7a-DIAG ' + JSON.stringify({
        hasArg: rawEnvelope.includes(ARG_MARKER), hasResult: rawEnvelope.includes(RESULT_MARKER),
        providerHistory: ph.map(m => (m && m.role) + (m && m.tool_calls ? '+calls' : '')),
        messages: sj && Array.isArray(sj.messages) ? sj.messages.length : null,
        segments: segs.map(x => x && (x.type + ':' + (x.status || ''))),
        updatedAt: sj && sj.updatedAt,
      }));
    }
    ok(!rawTail.includes(ARG_MARKER),
      `A7 liveTail 不含任何工具【参数】(${ARG_MARKER} 在 liveTail 里出现 ${rawTail.split(ARG_MARKER).length - 1} 次)`);
    ok(!rawTail.includes(RESULT_MARKER),
      `A8 liveTail 不含任何工具【结果】(${RESULT_MARKER} 在 liveTail 里出现 ${rawTail.split(RESULT_MARKER).length - 1} 次)`);
    ok(!!(tail && Array.isArray(tail.tools) && tail.tools.every(x => x && !('input' in x) && !('args' in x) && !('result' in x) && !('content' in x) && !('id' in x))),
      'A9 tools 的每一行只有 name/status/startedAt/endedAt 四个键(连工具调用 id 都不下发)');
    // 117l 的老语义:text 仍是 ≤600 字的尾巴,且就是 full 的尾巴(不是另一份文本)。
    ok(!!(tail && String(tail.text || '').length <= 600), `A10 text 仍然 ≤600 字(got ${tail && String(tail.text || '').length})`);
    ok(!!(tail && String(tail.full || '').endsWith(String(tail.text || ''))), 'A11 text 就是 full 的尾巴(两份文本同源)');
  }

  /* ═════════ (B) 回合结束:键消失,正文这时才落盘 ═════════ */
  console.log('── (B) 回合结束:liveTail 消失、正文落盘 ──');
  {
    // 回合活着的时候盘上【只有】那条 user 消息 —— 这就是用户看到的空白(本波要修的正是它)。
    ok(midFlightA.length >= 1 && midFlightA.every(m => m && m.role !== 'assistant'),
      `B0 回合还活着时盘上没有助手消息(实测 ${midFlightA.length} 行,角色 ${midFlightA.map(m => m.role).join('/')})`);
    let gone = false;
    for (let i = 0; i < 400; i++) {
      const s = await request('GET', `/api/sessions/${sidA}`, undefined, hdr);
      if (s.json && !s.json.liveTail) { gone = true; break; }
      await sleep(100);
    }
    ok(gone, 'B1 回合结束后 liveTail 不再下发(始终不落盘)');
    let landed = [];
    for (let i = 0; i < 100; i++) {
      landed = sessionMessages(sidA).filter(m => m && m.role === 'assistant');
      if (landed.length) break;
      await sleep(100);
    }
    ok(landed.some(m => /第三段/.test(String(m.content || ''))),
      `B2 回合结束后正文落盘(实测 ${landed.length} 条助手消息)`);
    const after = await request('GET', `/api/sessions/${sidA}`, undefined, hdr);
    ok(!!(after.json && !(after.json.resumable && after.json.resumable.live === true)),
      `B3 回合结束后 resumable.live 不是 true(got ${JSON.stringify(after.json && after.json.resumable)})`);
  }

  /* ═════════ (C) full 超顶:从头部截断 ═════════ */
  console.log('── (C) full 超顶时从【头部】丢弃 ──');
  let bigTurn = null;   // 117o-A7:同一回合的叙事账本(F 段用)
  {
    const th = await newThread('超长');
    fireTurn(th.id, 'LIVEBIG 说很多话', th.cwd);
    let tail = null;
    for (let i = 0; i < 400; i++) {
      const s = await request('GET', `/api/sessions/${th.id}`, undefined, hdr);
      const lt = s.json && s.json.liveTail;
      if (lt && String(lt.full || '').length >= 12000) { tail = lt; bigTurn = s.json.liveTurn || null; break; }
      await sleep(60);
    }
    ok(!!tail, `C1 拿到了超顶的活文本(got ${tail ? String(tail.full).length + ' 字' : 'null'})`);
    ok(!!(tail && String(tail.full).length === 12000), `C2 full 硬顶 12000 字(实测 ${tail && String(tail.full).length})`);
    ok(!!(tail && tail.truncated === true), `C3 超顶时 truncated:true(got ${tail && tail.truncated})`);
    ok(!!(tail && !String(tail.full).includes('HEADMARK')), 'C4 砍掉的是【开头】那一段');
    ok(!!(tail && String(tail.full).includes('TAILMARK')), 'C5 留下的是【刚说的】那一段');
    // companion:没超顶的那一回合 truncated 必须是 false —— 这个键不能一律置真,否则前端每张气泡
    // 都会在开头无中生有一个「…」。
    ok(!!tailA && tailA.truncated === false, `C6 companion:没超顶的回合 truncated 是 false(got ${tailA && tailA.truncated})`);
  }

  /* ═════════ (E) 117o-A7:在途回合的【有序叙事账本】 ═════════ */
  console.log('── (E) liveTurn:段序、工具行、零工具结果 ──');
  {
    ok(!!turnA, `E1 活回合时信封上有【新键】liveTurn(got ${turnA ? 'yes' : 'no'})`);
    const segs = Array.isArray(turnA && turnA.segments) ? turnA.segments : [];
    const types = segs.map(x => x && x.type);
    // 段序就是真实事件顺序:先说第一段 → 调 file_read → 再说第二段。修前前端只有一坨拼好的纯文本,
    // 这个顺序信息根本不在数据里,画不出工具卡夹在两段话中间的样子。
    ok(JSON.stringify(types) === JSON.stringify(['text', 'tool', 'text']),
      `E2 段序与真实事件顺序一致(文字→工具→文字;实测 ${JSON.stringify(types)})`);
    ok(/第一段/.test(String(segs[0] && segs[0].text || '')) && /第二段/.test(String(segs[2] && segs[2].text || '')),
      'E2b 两段文字就是这一回合真流出来的话');
    const toolSeg = segs.find(x => x && x.type === 'tool');
    ok(!!(toolSeg && toolSeg.name === 'file_read' && toolSeg.status === 'done'),
      `E3 工具段带 name 与 status(got ${JSON.stringify(toolSeg)})`);
    const rows = Array.isArray(turnA && turnA.toolCalls) ? turnA.toolCalls : [];
    ok(rows.length === 1 && rows[0].name === 'file_read' && rows[0].status === 'done',
      `E4 toolCalls 与段一一对应(got ${JSON.stringify(rows)})`);
    ok(rows.every(r => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['id', 'inputPreview', 'name', 'status'])),
      `E5 每行恰好 {id,name,inputPreview,status} 四个键(got ${JSON.stringify(rows.map(r => Object.keys(r).sort()))})`);
    // inputPreview 必须是【真参数】—— 否则 E7 那条「不含结果」会因为字段本来就是空的而成为空断言。
    ok(rows.some(r => String(r.inputPreview || '').includes(ARG_MARKER)),
      `E6 inputPreview 是这一回合真正传给工具的那个参数(got ${JSON.stringify(rows.map(r => r.inputPreview))})`);
    // 本切片的安全线:工具【结果】一个字节都不许进这个信封(结果可能是整份文件、可能含密钥)。
    // 前提由 A7a 已证:这两个记号确实在这一回合里流过。
    const rawTurn = JSON.stringify(turnA || null);
    ok(!rawTurn.includes(RESULT_MARKER),
      `E7 liveTurn 不含任何工具【结果】(${RESULT_MARKER} 在 liveTurn 里出现 ${rawTurn.split(RESULT_MARKER).length - 1} 次)`);
    ok(rawA.includes(RESULT_MARKER),
      'E7a 前提:这一份信封里【别处】确实有那个结果记号(会话自己的 providerHistory),所以 E7 不是空断言');
    ok(!/"result"|"content"|"output"/.test(rawTurn),
      `E8 liveTurn 里没有任何叫 result/content/output 的字段(got ${rawTurn.slice(0, 0) || 'clean'})`);
    ok(!!(turnA && turnA.startedAt === (tailA && tailA.startedAt) && turnA.iterations === (tailA && tailA.iterations)),
      `E9 startedAt/iterations 与 liveTail 同源(got ${JSON.stringify({ s: turnA && turnA.startedAt, i: turnA && turnA.iterations })})`);
    ok(!!(turnA && turnA.truncated === false), `E10 没超顶时 truncated 是 false(got ${turnA && turnA.truncated})`);
    // 老键一个字没被动:新键是【加】不是改(抽屉的「它正在说」在读 liveTail)。
    ok(!!(tailA && typeof tailA.full === 'string' && typeof tailA.text === 'string' && Array.isArray(tailA.tools)),
      'E11 liveTail 那几个老键仍然原样在(新键是加不是改)');
    // 在途与落盘是【同一份账本】:回合结束后落盘消息的段序必须与在途看到的一致。
    let landedSegs = null;
    for (let i = 0; i < 100; i++) {
      const msg = sessionMessages(sidA).filter(m => m && m.role === 'assistant').pop();
      if (msg && Array.isArray(msg.segments) && msg.segments.length) { landedSegs = msg.segments; break; }
      await sleep(100);
    }
    const landedTypes = (landedSegs || []).map(x => x && x.type);
    ok(JSON.stringify(landedTypes) === JSON.stringify(['text', 'tool', 'text']),
      `E12 落盘消息的段序与在途看到的一致(同一份账本;实测 ${JSON.stringify(landedTypes)})`);
    ok(!(landedSegs || []).some(x => x && 'inputPreview' in x),
      'E13 落盘的段上【没有】inputPreview —— 参数摘要只旁挂在内存,落盘形状一个字节没变');
    const gone = await request('GET', `/api/sessions/${sidA}`, undefined, hdr);
    ok(!!(gone.json && !gone.json.liveTurn), 'E14 回合结束后 liveTurn 这个键也消失(与 liveTail 同进同出,始终不落盘)');
  }

  /* ═════════ (F) 117o-A7:liveTurn 超顶也从【头部】丢弃 ═════════ */
  console.log('── (F) liveTurn 超顶时从【头部】丢弃 ──');
  {
    ok(!!bigTurn, `F1 超长回合也带回了 liveTurn(got ${bigTurn ? 'yes' : 'no'})`);
    const seg = Array.isArray(bigTurn && bigTurn.segments) ? bigTurn.segments : [];
    const text = String((seg[0] && seg[0].text) || '');
    ok(text.length === 12000, `F2 单段硬顶 12000 字(实测 ${text.length})`);
    ok(!!(bigTurn && bigTurn.truncated === true), `F3 超顶时 truncated:true(got ${bigTurn && bigTurn.truncated})`);
    ok(!text.includes('HEADMARK'), 'F4 砍掉的是【开头】那一段');
    ok(text.includes('TAILMARK'), 'F5 留下的是【刚说的】那一段');
  }

  console.log(fail === 0 ? 'LIVE FULL TEXT E2E: ALL PASS' : `LIVE FULL TEXT E2E: ${fail} FAILED`);
} catch (e) {
  console.log('FAIL 未捕获异常: ' + (e && e.stack || e));
  fail++;
} finally {
  kill(wb);
  try { providerServer.close(); } catch { /* already closed */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 留着无妨 */ }
  process.exit(fail === 0 ? 0 : 1);
}
})();
