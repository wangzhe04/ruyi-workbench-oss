// E2E (v1.9 数据管家 Storage Steward): 统一保留策略 + 各仓占用统计 + sweep 清理。
// 两层:
//   (A) 单元(require server.js,临时 RUYI_HOME):
//       ① normalizeStoragePolicy clamp(越界/非数/缺省);
//       ② logs 按文件名日期保留(2020 老文件删,今日文件留);
//       ③ 真终态 run 事件日志 gzip 归档(.gz 生成、原文删除、readAgentRunEvents 经 gz 回退仍可读);
//       ④ paused / 新终态 run 不被压缩(interrupted 可续跑语义);
//       ⑤ webcache LRU 上限(opt-in);
//       ⑥ collectStorageStats 各仓 bytes/files。
//   (B) 集成(真 boot 子进程): /api/storage/summary 无 token → 403、有 token → stores 齐;
//       /api/storage/policy clamp 回显并持久; /api/storage/clean target 校验; POST 无 token → 403。
// Judgement line (exact): STORAGE-STEWARD E2E: ALL PASS
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-storage-steward-e2e');
const { getFreePort } = require('./free-port.js');

// Env MUST be set before requiring server.js (paths.* derives from RUYI_HOME at module load).
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME;
const srv = require(path.join(WB, 'app', 'server.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const todayName = () => `workbench-${new Date().toISOString().slice(0, 10)}.ndjson`;

// ---- fixtures -------------------------------------------------------------------------------------------
function seedFixtures() {
  // logs: 老(2020,必删) + 今日(必留)
  fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'logs', 'workbench-2020-01-01.ndjson'), '{"kind":"old"}\n'.repeat(50));
  fs.writeFileSync(path.join(HOME, 'logs', todayName()), '{"kind":"new"}\n');
  // agent-runs: 终态老 run(必压)、paused 老 run(不压)、终态新 run(不压)
  const sid = 'sess_steward';
  const dir = path.join(HOME, 'agent-runs', sid);
  fs.mkdirSync(dir, { recursive: true });
  const mkRun = (id, status, updatedAt) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ schemaVersion: 4, id, sessionId: sid, status, updatedAt, nodes: [] }));
  const mkEvents = id => fs.writeFileSync(path.join(dir, `${id}.events.ndjson`),
    [1, 2, 3].map(seq => JSON.stringify({ seq, ts: '2020-01-01T00:00:00Z', runId: id, type: 'node_event', data: { seq } })).join('\n') + '\n');
  mkRun('run_done', 'completed', '2020-01-01T00:00:00.000Z'); mkEvents('run_done');
  mkRun('run_pause', 'paused', '2020-01-01T00:00:00.000Z'); mkEvents('run_pause');
  mkRun('run_fresh', 'completed', new Date().toISOString()); mkEvents('run_fresh');
  // webcache: 3 条,mtime 递增(a 最老)
  fs.mkdirSync(path.join(HOME, 'webcache'), { recursive: true });
  for (const [name, age] of [['a.json', 3000], ['b.json', 2000], ['c.json', 1000]]) {
    const p = path.join(HOME, 'webcache', name);
    fs.writeFileSync(p, JSON.stringify({ url: 'https://x/' + name, title: name, text: 'x'.repeat(200), ts: '2020-01-01' }));
    const t = new Date(Date.now() - age);
    fs.utimesSync(p, t, t);
  }
}

// ---- http helpers ---------------------------------------------------------------------------------------
function reqJson(port, method, p, headers, body) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(headers || {}), ...(body ? { 'content-type': 'application/json' } : {}) }, timeout: 4000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const getJson = (port, p, headers) => reqJson(port, 'GET', p, headers);
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
async function startServer(port) {
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, RUYI_HOME: HOME },
  });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let h = null; for (let i = 0; i < 40 && !(h && h.body && h.body.ok); i++) { await sleep(150); h = await getJson(port, '/health'); }
  return { wb, h };
}
async function stopServer(wb) { if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } await sleep(300); }

(async () => {
  let fail = 0;
  let wb = null;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  try {
    // ============================== (A) 单元层 ==============================
    // A1: clamp —— 越界/非数/缺省
    const p1 = srv.normalizeStoragePolicy({ logsKeepDays: 1, agentRunEventsCompressDays: -5, webcacheMaxEntries: 1e9 });
    ok(p1.logsKeepDays === 7 && p1.agentRunEventsCompressDays === 0 && p1.webcacheMaxEntries === 100000,
      '(A1) 越界值 clamp — ' + JSON.stringify(p1));
    const p2 = srv.normalizeStoragePolicy(undefined);
    ok(p2.logsKeepDays === 30 && p2.agentRunEventsCompressDays === 14 && p2.webcacheMaxEntries === 0,
      '(A2) 缺省策略(30 天 / 14 天 / 不限)— ' + JSON.stringify(p2));
    const p3 = srv.normalizeStoragePolicy({ logsKeepDays: 'abc' });
    ok(p3.logsKeepDays === 30, '(A3) 非数值回落默认 30');

    seedFixtures();

    // A2: 全目标 sweep(默认策略:logs 30 天 / 压缩 14 天 / webcache 不限)
    const sweepRes = await srv.storageSweep(undefined, null);
    ok(sweepRes.ok === true, '(A-sweep) storageSweep ok');
    ok(!fs.existsSync(path.join(HOME, 'logs', 'workbench-2020-01-01.ndjson')), '(A4) 2020 老日志已删');
    ok(fs.existsSync(path.join(HOME, 'logs', todayName())), '(A5) 今日日志保留');
    // A3: 终态老 run → gzip 归档
    const doneEvents = path.join(HOME, 'agent-runs', 'sess_steward', 'run_done.events.ndjson');
    ok(!fs.existsSync(doneEvents) && fs.existsSync(doneEvents + '.gz'), '(A6) 终态老 run 事件日志已 gzip 归档(原文删,.gz 在)');
    // A4: gz 回退读取 —— 归档后事件仍完整可读
    const ev = await srv.readAgentRunEvents('sess_steward', 'run_done', 0, 500);
    ok(Array.isArray(ev.events) && ev.events.length === 3 && Number(ev.events[0].seq) === 1 && Number(ev.events[2].seq) === 3,
      '(A7) readAgentRunEvents 经 gz 回退读出全部 3 条事件');
    // A5: paused 与新终态不被压缩
    ok(fs.existsSync(path.join(HOME, 'agent-runs', 'sess_steward', 'run_pause.events.ndjson')), '(A8) paused run 事件日志未被压缩');
    ok(fs.existsSync(path.join(HOME, 'agent-runs', 'sess_steward', 'run_fresh.events.ndjson')), '(A9) 新终态 run(<14 天)未被压缩');
    // A6: webcache 默认(0=不限)→ 3 条全留
    ok(fs.readdirSync(path.join(HOME, 'webcache')).length === 3, '(A10) webcache 默认不限,3 条全留(尊重"离线无价"设计)');
    ok(sweepRes.freedBytes > 0 && sweepRes.actions.length >= 2, '(A11) sweep 报告释放字节与动作数(freed=' + sweepRes.freedBytes + ', actions=' + sweepRes.actions.length + ')');

    // A7: webcache LRU(opt-in:上限 2 → 删最老的 a.json)
    const lru = await srv.storageSweep({ webcacheMaxEntries: 2 }, new Set(['webcache']));
    const rest = fs.readdirSync(path.join(HOME, 'webcache')).sort();
    ok(rest.length === 2 && !rest.includes('a.json') && rest.includes('c.json'), '(A12) webcache LRU 删最老留最新 — ' + rest.join(','));
    ok(lru.freedBytes > 0, '(A13) LRU sweep 释放字节>0');

    // A8: 单目标 sweep 不碰其它仓(再跑 logs-only,webcache 应不动)
    await srv.storageSweep(undefined, new Set(['logs']));
    ok(fs.readdirSync(path.join(HOME, 'webcache')).length === 2, '(A14) logs-only sweep 不碰 webcache');

    // A9: collectStorageStats
    const stats = await srv.collectStorageStats({ storagePolicy: p2 });
    ok(stats.ok === true && stats.stores && Number(stats.stores.logs.files) >= 1 && Number(stats.stores.agentRuns.files) >= 3,
      '(A15) collectStorageStats 各仓统计(logs.files=' + (stats.stores.logs && stats.stores.logs.files) + ', agentRuns.files=' + (stats.stores.agentRuns && stats.stores.agentRuns.files) + ')');
    ok(stats.policy && stats.policy.logsKeepDays === 30, '(A16) stats 携带归一后策略');

    // A10: 归档幂等 —— 再 sweep 一次,.gz 不被重复处理,无错误
    const again = await srv.storageSweep(undefined, null);
    ok(again.ok === true && fs.existsSync(doneEvents + '.gz'), '(A17) 重复 sweep 幂等(.gz 仍在,无重复压缩)');

    // ============================== (B) 集成层 ==============================
    const PORT = await getFreePort();
    ({ wb } = await startServer(PORT));
    ok(wb && wb.pid, '(B0) server booted :' + PORT);
    const token = await getToken(PORT);
    ok(!!token, '(B1) UI token scraped');

    const noTok = await getJson(PORT, '/api/storage/summary');
    ok(noTok && noTok.status === 403, '(B2) GET /api/storage/summary 无 token → 403');
    const sum = await getJson(PORT, '/api/storage/summary', { 'x-wcw-token': token });
    ok(sum && sum.status === 200 && sum.body && sum.body.ok === true && sum.body.stores && sum.body.stores.logs,
      '(B3) summary 有 token → stores 齐(totalBytes=' + (sum.body && sum.body.totalBytes) + ')');
    ok(sum.body.policy && Number(sum.body.policy.logsKeepDays) === 30, '(B4) summary 携带默认策略 30 天');

    const polBad = await reqJson(PORT, 'POST', '/api/storage/policy', { 'x-wcw-token': token }, { logsKeepDays: 1, webcacheMaxEntries: 50 });
    ok(polBad && polBad.status === 200 && polBad.body.policy.logsKeepDays === 7 && polBad.body.policy.webcacheMaxEntries === 50,
      '(B5) policy 更新:越界 1 天 clamp 到 7,合法 50 生效 — ' + JSON.stringify(polBad && polBad.body.policy));
    const sum2 = await getJson(PORT, '/api/storage/summary', { 'x-wcw-token': token });
    ok(sum2.body.policy.logsKeepDays === 7 && sum2.body.policy.webcacheMaxEntries === 50, '(B6) 策略已持久(config 落盘后 summary 回读一致)');

    const badTarget = await reqJson(PORT, 'POST', '/api/storage/clean', { 'x-wcw-token': token }, { target: 'bogus' });
    ok(badTarget && badTarget.status === 400, '(B7) clean 未知 target → 400');
    const noTokPost = await reqJson(PORT, 'POST', '/api/storage/clean', {}, { target: 'all' });
    ok(noTokPost && noTokPost.status === 403, '(B8) POST /api/storage/clean 无 token → 403');
    // boot sweep 可能仍 in-flight(并发第二次会被拒)—— 容忍一次重试
    let clean = await reqJson(PORT, 'POST', '/api/storage/clean', { 'x-wcw-token': token }, { target: 'logs' });
    for (let i = 0; i < 10 && clean && clean.body && /already running/.test(String(clean.body.error || '')); i++) { await sleep(300); clean = await reqJson(PORT, 'POST', '/api/storage/clean', { 'x-wcw-token': token }, { target: 'logs' }); }
    ok(clean && clean.status === 200 && clean.body && clean.body.ok === true, '(B9) clean target=logs → ok');
  } catch (e) {
    console.log('ERROR ' + (e && e.stack || e.message || e)); fail++;
  } finally {
    await stopServer(wb);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSTORAGE-STEWARD E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
