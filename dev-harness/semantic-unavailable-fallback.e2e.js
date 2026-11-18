'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:语义运行时起不来时对话与线程搜索照常(150 号文 S1)。真工作台 + 假 provider,断网可跑。
//
// RUYI_SEMANTIC_RUNTIME_ROOT 指向一个只有 package.json、没有模型资产的根:legacy worker 报 ready ok:false 后立即退出,
// 往往在 Get-Process 观测之前 —— 修前这一下写进永久 startingFailure,之后每条要重排的消息整轮只回 error
// semantic.owner_identity、一次都不发给模型,非 preview 的线程搜索一律 500。
//   S1a 命中多条记忆(会走语义重排)的回合全部到达 provider、正常结束;
//   S1b 运行时失败落定后,回执 memoryCheck.semantic.status === 'unavailable'(关键词基线照常);
//   S1c 非 preview 线程搜索不再 500,关键词结果照常返回,索引照常建完。
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-semantic-down-'));
const t = createRunner('SEMANTIC UNAVAILABLE FALLBACK');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch { /* raw */ } resolve({ status: res.statusCode, json, raw: out }); });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
function stream(port, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { if (line.trim()) events.push(JSON.parse(line)); } catch { /* partial */ } } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
async function waitFor(fn, tries = 150, gap = 100) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}
async function startWorkbench(home, extraEnv) {
  const port = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, ...(extraEnv || {}) } });
  let log = ''; wb.stdout.on('data', d => { log += d; }); wb.stderr.on('data', d => { log += d; });
  const stop = () => { try { killOwnTree(wb); } catch { /* gone */ } };
  const up = await waitFor(() => request(port, 'GET', '/health').then(r => r.status === 200).catch(() => null), 100, 150);
  if (!up) { stop(); throw new Error('workbench did not start: ' + log.slice(-800)); }
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }));
  const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
  return { port, stop, headers: { 'x-wcw-token': token }, log: () => log };
}
const userTextOf = m => (typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => (p && p.type === 'text') ? String(p.text || '') : '').join('\n') : ''));

(async () => {
  let fake = null, wb = null;
  try {
    const WORK = path.join(ROOT, 'work'); fs.mkdirSync(WORK, { recursive: true });
    const semanticRoot = path.join(ROOT, 'semantic-root-without-assets'); fs.mkdirSync(semanticRoot, { recursive: true });
    fs.writeFileSync(path.join(semanticRoot, 'package.json'), '{}');
    fake = await startFakeProvider({ handler: () => textFrames('ok') });
    const home = path.join(ROOT, 'home'); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      configSchema: 12, permissionMode: 'bypass', defaultWorkspace: WORK, stewardThreadBriefV1: false, autoImportClaudeCodeMcp: false,
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake',
    }));
    wb = await startWorkbench(home, { RUYI_SEMANTIC_RUNTIME_ROOT: semanticRoot, RUYI_DISABLE_SEMANTIC: '0' });
    const saved = [];
    for (let i = 0; i < 3; i++) saved.push(await request(wb.port, 'POST', '/api/memory', { memory: { id: `hit${i}`, scope: 'project', type: 'lesson', name: `deploy pipeline step ${i}`, description: `deploy pipeline release workflow detail ${i}`, body: 'x' }, cwd: WORK }, wb.headers));
    ok(saved.every(r => r.json && r.json.ok), 'S1-0 三条会命中的记忆落盘(命中 ≥2 条才会走语义重排)');

    const Q = 'how to run the deploy pipeline release';
    const turns = [];
    let sid = '';
    // The boot prewarm fails within a few seconds; keep sending until the failure has settled and been observed.
    for (let i = 0; i < 8; i++) {
      const marker = `semdown-${i}`;
      const events = await stream(wb.port, { message: `${Q} [${marker}]`, cwd: WORK, ...(sid ? { sessionId: sid } : {}) });
      sid = sid || ((events.find(e => e.type === 'session') || {}).session || {}).id || '';
      const meta = events.find(e => e.type === 'meta') || {};
      const reached = fake.requests.some(b => b && Array.isArray(b.messages) && b.messages.some(m => m.role === 'user' && userTextOf(m).includes(marker)));
      turns.push({ marker, reached, result: !!(events.find(e => e.type === 'result') || {}).ok, errors: events.filter(e => e.type === 'error').map(e => String(e.error || e.message || '')), semantic: meta.memoryCheck && meta.memoryCheck.semantic && meta.memoryCheck.semantic.status, matches: meta.memoryCheck && meta.memoryCheck.matchCount });
      if (turns.filter(x => x.semantic === 'unavailable').length >= 2) break;
      await sleep(1500);
    }
    const summary = JSON.stringify(turns.map(x => [x.reached, x.result, x.semantic, x.errors.join('|').slice(0, 60)]));
    ok(turns.length >= 2 && turns.every(x => x.reached && x.result && !x.errors.length), `S1a 每个回合都到达 provider、正常结束(修前运行时失败后整轮 error semantic.owner_identity)${summary}`);
    ok(turns.filter(x => x.semantic === 'unavailable').length >= 2, `S1b 运行时失败落定后回执 semantic.status=unavailable(关键词基线照常)${summary}`);
    ok(turns.every(x => x.matches >= 2), `S1b2 关键词命中照常进本轮记忆(matchCount=${turns.map(x => x.matches).join(',')})`);

    await sleep(1000);
    const searches = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(wb.port, 'GET', `/api/sessions/search?q=${encodeURIComponent('deploy pipeline')}&limit=30`, null, wb.headers);
      searches.push({ status: r.status, ok: !!(r.json && r.json.ok), code: r.json && r.json.code, results: r.json && Array.isArray(r.json.results) ? r.json.results.length : null, complete: !!(r.json && r.json.coverage && r.json.coverage.complete), semantic: r.json && r.json.semantic && r.json.semantic.status });
      if (searches[searches.length - 1].complete || searches[searches.length - 1].status !== 200) break;
      await sleep(300);
    }
    const last = searches[searches.length - 1];
    ok(searches.every(s => s.status === 200 && s.ok), `S1c 非 preview 线程搜索不再 500(${JSON.stringify(searches.map(s => [s.status, s.code || '', s.semantic || '']))})`);
    ok(last.complete && last.results >= 1, `S1c2 索引照常建完、关键词结果照常返回(complete=${last.complete}, results=${last.results})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (wb) wb.stop();
    if (fake) await fake.close();
    if (!t.failures) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } }
    else console.log('[kept for inspection] ' + ROOT);
  }
  t.done({ exit: true });
})();
