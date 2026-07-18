// E2E (第40波): /api/metrics 性能观测面。
//   (U) 单元(require server.js,临时 RUYI_HOME):
//       ① normalizeMetricsPath id 归一化;  ② recordRequestMetric 分桶/环形封顶;
//       ③ maybeRecordStorageTrend ≥1h 节流(连调两次只一点);  ④ readStorageTrend 缺文件 → 空史。
//   (B) 集成(真 boot 子进程):
//       ① 无 token → 403;  ② 有 token → memory/requests/children/storageTrend 字段齐;
//       ③ 请求计数:buckets 之和 == total 且 > 0;  ④ /health 不计数(探针不淹没真分布);
//       ⑤ metrics 调用后 storage-trend.json 落盘且再调不重复追点。
// Judgement line (exact): METRICS-PANEL E2E: ALL PASS
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-metrics-e2e');
const HOME2 = path.join(os.tmpdir(), 'wcw-metrics-e2e-live');
const { getFreePort } = require('./free-port.js');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME; // paths.* 在 module load 时定型,必须先设
const srv = require(path.join(WB, 'app', 'server.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ──────────────────────── (U) 单元层 ────────────────────────
  ok(srv.normalizeMetricsPath('/api/sessions/sess_ab12cd34/events') === '/api/sessions/:id/events',
    'U1 会话 id 归一化(got ' + srv.normalizeMetricsPath('/api/sessions/sess_ab12cd34/events') + ')');
  ok(srv.normalizeMetricsPath('/api/agent-runs/run_00000a01') === '/api/agent-runs/:id',
    'U1 run id 归一化');
  ok(srv.normalizeMetricsPath('/api/metrics') === '/api/metrics', 'U1 无 id 路径原样');
  {
    const before = srv.recordRequestMetric.length; // 引用存在性(函数已导出)
    ok(typeof srv.recordRequestMetric === 'function' && before >= 0, 'U2 recordRequestMetric 已导出');
    for (let i = 0; i < 320; i++) srv.recordRequestMetric('GET', '/api/sessions/sess_deadbeef0' + (i % 10), i % 6000);
    const payload = await srv.buildMetricsPayload({});
    ok(payload.requests.total >= 320, 'U2 total 累计(got ' + payload.requests.total + ')');
    ok(payload.requests.buckets.reduce((a, b) => a + b, 0) === payload.requests.total, 'U2 buckets 之和 == total');
    ok(payload.requests.slowest.length <= 8 && payload.requests.slowest[0].ms >= payload.requests.slowest[payload.requests.slowest.length - 1].ms,
      'U2 slowest ≤8 且降序');
    ok(payload.requests.slowest.every(s => !/sess_deadbeef/.test(s.p)), 'U2 slowest 路径已归一化(无会话 id 泄漏)');
  }
  {
    const trendFile = path.join(HOME, 'storage-trend.json');
    fs.rmSync(trendFile, { force: true }); // U2 的 buildMetricsPayload 已顺手追过一点,清掉再测
    const fakeStats = { totalBytes: 12345, stores: { logs: { bytes: 100 }, sessions: { bytes: 200 } }, engineTranscripts: { bytes: 300 } };
    await srv.maybeRecordStorageTrend(fakeStats);
    await srv.maybeRecordStorageTrend(fakeStats); // 间隔 <1h → 节流,不追第二点
    const trend = await srv.readStorageTrend();
    ok(trend.length === 1 && trend[0].totalBytes === 12345 && trend[0].engineBytes === 300,
      'U3 趋势追点 + 1h 节流(连调两次只一点,engineBytes=300)');
    ok(fs.existsSync(trendFile), 'U3 storage-trend.json 已落盘');
  }
  {
    fs.rmSync(path.join(HOME, 'storage-trend.json'), { force: true });
    const trend = await srv.readStorageTrend();
    ok(Array.isArray(trend) && trend.length === 0, 'U4 趋势文件缺失 → 空史(不硬失败)');
  }

  // ──────────────────────── (B) 集成层(真 boot) ────────────────────────
  fs.rmSync(HOME2, { recursive: true, force: true });
  fs.mkdirSync(HOME2, { recursive: true });
  fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify({ configSchema: 4, version: '0.7.0', permissionMode: 'bypass' }, null, 2));
  const PORT = await getFreePort();
  const childEnv = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME2 };
  delete childEnv.RUYI_HOME;
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: childEnv, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  function getJson(p, headers) {
    return new Promise(resolve => {
      const r = http.get({ host: '127.0.0.1', port: PORT, path: p, headers: headers || {}, timeout: 4000 }, resp => {
        let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: resp.statusCode, body: j }); });
      });
      r.on('error', () => resolve({ status: 0, body: null })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: null }); });
    });
  }
  function getToken() { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(250); const h = await getJson('/health'); up = h.status === 200; }
    ok(up, 'B1 workbench up on :' + PORT);
    const token = await getToken();
    ok(!!token, 'B1 UI token scraped');
    const noTok = await getJson('/api/metrics');
    ok(noTok.status === 403, 'B2 GET /api/metrics 无 token → 403(got ' + noTok.status + ')');
    // 先打几个 API 制造请求计数,再取 metrics
    await getJson('/api/storage/summary', { 'x-wcw-token': token });
    await getJson('/api/sessions', { 'x-wcw-token': token });
    const m = await getJson('/api/metrics', { 'x-wcw-token': token });
    ok(m.status === 200 && m.body && m.body.ok === true, 'B2 有 token → 200 ok');
    const b = m.body || {};
    ok(b.memory && Number(b.memory.rss) > 0 && Array.isArray(b.children) && Array.isArray(b.storageTrend) && b.requests,
      'B3 memory/children/storageTrend/requests 字段齐');
    const total1 = b.requests.total;
    const bucketSum = b.requests.buckets.reduce((a, x) => a + x, 0);
    ok(total1 > 0 && bucketSum === total1, 'B4 请求计数 total=' + total1 + ' 且 buckets 之和相等');
    ok(b.requests.buckets.length === 6, 'B4 六桶');
    // /health 不计数:连打 5 次再读 total 应只 +1(这次 metrics 自己)
    for (let i = 0; i < 5; i++) await getJson('/health');
    const m2 = await getJson('/api/metrics', { 'x-wcw-token': token });
    const total2 = m2.body && m2.body.requests && m2.body.requests.total;
    ok(total2 === total1 + 1, 'B5 /health 不计数(5 次 health 后 total ' + total1 + ' → ' + total2 + ',仅 metrics 自己 +1)');
    // 趋势文件:metrics 已触发追点;再调一次(间隔 <1h)点数不变
    const trendFile = path.join(HOME2, 'storage-trend.json');
    ok(fs.existsSync(trendFile), 'B6 storage-trend.json 已生成');
    const n1 = JSON.parse(fs.readFileSync(trendFile, 'utf8')).length;
    await getJson('/api/metrics', { 'x-wcw-token': token });
    const n2 = JSON.parse(fs.readFileSync(trendFile, 'utf8')).length;
    ok(n1 >= 1 && n2 === n1, 'B6 趋势节流(再调不追点,' + n1 + ' → ' + n2 + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(HOME2, { recursive: true, force: true });
    console.log('\nMETRICS-PANEL E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
