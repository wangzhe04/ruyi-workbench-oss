#!/usr/bin/env node
'use strict';
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
// 判定行:`LIVE FULL TEXT E2E: ALL PASS`。
(async () => {
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-live-full-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } }

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
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { json = null; } resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}
async function waitUp() {
  for (let i = 0; i < 150; i++) { const h = await request('GET', '/health'); if (h.status === 200) return true; await sleep(120); }
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
      if (lt && String(lt.full || '') && Array.isArray(lt.tools) && lt.tools.length) { env = s; midFlightA = sessionMessages(sidA); break; }
      await sleep(60);
    }
    const tail = env && env.json && env.json.liveTail;
    tailA = tail;
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
  {
    const th = await newThread('超长');
    fireTurn(th.id, 'LIVEBIG 说很多话', th.cwd);
    let tail = null;
    for (let i = 0; i < 400; i++) {
      const s = await request('GET', `/api/sessions/${th.id}`, undefined, hdr);
      const lt = s.json && s.json.liveTail;
      if (lt && String(lt.full || '').length >= 12000) { tail = lt; break; }
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
