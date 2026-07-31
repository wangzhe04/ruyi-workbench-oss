(async () => {
'use strict';
// E2E(第75c波):可重建 Mission/Intervention 物化索引、revision cursor、ETag、压缩与规模门。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-pretender-75c-e2e');
const SESSION_COUNT = 300, IV_PER_SESSION = 100, USAGE_ROWS = 100000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const percentile95 = values => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)];

function kill(child) { if (child && child.pid) { try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
function runtimeToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function request(pathname, token, opts = {}) {
  return new Promise((resolve, reject) => {
    const raw = opts.body == null ? '' : JSON.stringify(opts.body);
    const started = performance.now();
    const req = http.request({ host: '127.0.0.1', port: opts.port, path: pathname, method: opts.method || (raw ? 'POST' : 'GET'), headers: {
      ...(token ? { 'x-wcw-token': token } : {}),
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(opts.headers || {}),
    } }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => { let body = null; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, body, text, ms: performance.now() - started }); });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitHealth(port) {
  for (let i = 0; i < 80; i++) { const r = await request('/health', '', { port }).catch(() => null); if (r && r.status === 200) return true; await sleep(100); }
  return false;
}

function sessionId(i) { return 'sess_scale_' + String(i).padStart(3, '0'); }
function iso(i) { return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(); }
function indexPath() { return path.join(HOME, 'sessions', '.pretender', 'projection-index.json'); }
function invalidateIndex(mode = 'delete') {
  const file = indexPath();
  if (mode === 'corrupt') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken-index', 'utf8'); }
  else { try { fs.unlinkSync(file); } catch {} }
}

function seedScaleDataset() {
  const sessionsDir = path.join(HOME, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (let i = 0; i < SESSION_COUNT; i++) {
    const sid = sessionId(i), stamp = iso(i);
    const head = {
      schemaVersion: 4, storageVersion: 2, id: sid, missionId: sid, kind: 'mission',
      title: 'Scale mission ' + i, summary: '', cwd: ROOT, pinned: false,
      createdAt: stamp, updatedAt: stamp, turnSeq: i, messageCount: 0, providerHistoryCount: 0,
      mission: {
        goal: 'Process scale mission ' + i, createdAt: stamp, updatedAt: stamp,
        autoMode: 'off', changeSeq: i,
        milestones: [{ id: 'm1', desc: 'scale item', status: i % 3 === 0 ? 'done' : 'pending', evidence: '', check: null }],
        budget: { maxAutoTurns: 10, maxTokens: 100000 }, spent: { autoTurns: i % 10, tokens: i * 10 },
        stall: { lastSignature: '', sameCount: 0 }, result: null,
      },
    };
    fs.writeFileSync(path.join(sessionsDir, sid + '.json'), JSON.stringify(head), 'utf8');
    fs.writeFileSync(path.join(sessionsDir, sid + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(sessionsDir, sid + '.provider.ndjson'), '', 'utf8');
    const rows = [];
    for (let j = 0; j < IV_PER_SESSION; j++) {
      const id = `iv_${i}_${j}`;
      const base = { id, type: j % 4 === 0 ? 'permission' : (j % 4 === 1 ? 'question' : (j % 4 === 2 ? 'plan' : 'pool')), sessionId: sid, requestedAt: iso((i + j) % 300), decidedAt: '', decidedBy: '', interventionVersion: 0, toolName: 'Bash', tier: 'exec', revertible: false };
      rows.push(JSON.stringify({ ...base, status: 'pending' }));
      if (i === 0) {
        rows.push(JSON.stringify({ ...base, status: 'applying', interventionVersion: 1 }));
        rows.push(JSON.stringify({ ...base, status: 'approved', interventionVersion: 2, decidedAt: stamp, decidedBy: 'seed' }));
        rows.push(JSON.stringify({ ...base, status: 'approved', interventionVersion: 3, decidedAt: stamp, decidedBy: 'seed' }));
      } else if (i === 1) {
        // 200 rows (< automatic threshold) for explicit compaction equivalence below.
        rows.push(JSON.stringify({ ...base, status: 'pending', interventionVersion: 1 }));
      }
    }
    fs.writeFileSync(path.join(sessionsDir, sid + '.interventions.ndjson'), rows.join('\n') + '\n', 'utf8');
  }
  const usageDir = path.join(HOME, 'usage'); fs.mkdirSync(usageDir, { recursive: true });
  const usage = [];
  for (let i = 0; i < USAGE_ROWS; i++) usage.push(JSON.stringify({
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 600)).toISOString(),
    sessionId: sessionId(i % SESSION_COUNT), engine: 'openai', provider: 'scale', model: 'scale-model',
    inTok: 10, outTok: 5, cost: 0.00001, currency: 'USD', costTrusted: true, estimated: false,
    turnSeq: Math.floor(i / SESSION_COUNT), kind: i % 10 === 0 ? 'subagent' : 'turn',
  }));
  fs.writeFileSync(path.join(usageDir, '2026-01.jsonl'), usage.join('\n') + '\n', 'utf8');
}

const WB_PORT = await getFreePort();
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, includeWorkbenchMcp: false }), 'utf8');
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, RUYI_TEST_HOOKS: '1' }, windowsHide: true });
let stderr = ''; wb.stderr.on('data', d => stderr += String(d));

try {
  ok(await waitHealth(WB_PORT), 'workbench up');
  const token = runtimeToken(); ok(!!token, 'runtime token');
  seedScaleDataset();

  // 标准档:300 Mission / 30k unique Intervention / 100k usage rows.
  const coldList = await request('/api/missions?limit=37', token, { port: WB_PORT });
  ok(coldList.status === 200 && coldList.body?.page?.total === SESSION_COUNT, `(a) 冷列表300 Mission(${Math.round(coldList.ms)}ms)`);
  ok(coldList.ms <= 1500, `(a) 列表冷门≤1500ms(实 ${Math.round(coldList.ms)}ms)`);
  ok(coldList.body?.missions?.length === 37 && coldList.body?.nextCursor, '(a) cursor 首页面37条+nextCursor');
  ok(coldList.body?.index?.estimatedBytes <= 50 * 1024 * 1024, `(a) 索引估算常驻≤50MB(实 ${Math.round((coldList.body?.index?.estimatedBytes || 0) / 1024 / 1024)}MB)`);
  ok(coldList.body?.missions?.every(m => m.freshness && m.freshness.persistentRevision && m.freshness.liveOverlay === false), '(a) persistent facts 与 live overlay freshness 分层');

  const cursor = coldList.body.nextCursor;
  const page2 = await request('/api/missions?cursor=' + encodeURIComponent(cursor), token, { port: WB_PORT });
  const ids1 = new Set(coldList.body.missions.map(m => m.missionId));
  ok(page2.status === 200 && page2.body?.missions?.length === 37, '(b) 同 revision 第二页可读');
  ok(page2.body.missions.every(m => !ids1.has(m.missionId)), '(b) 稳定分页无重复');
  const etag = coldList.headers.etag;
  const notModified = await request('/api/missions?limit=37', token, { port: WB_PORT, headers: { 'if-none-match': etag } });
  ok(!!etag && notModified.status === 304, '(b) ETag 命中 -> 304');

  const hotList = [];
  for (let i = 0; i < 12; i++) hotList.push((await request('/api/missions?limit=50', token, { port: WB_PORT })).ms);
  ok(percentile95(hotList) <= 300, `(c) 列表热P95≤300ms(实 ${Math.round(percentile95(hotList))}ms)`);

  // Explicit journal compaction: facts and projection revision must remain byte-for-byte equivalent.
  const beforeCompact = await request('/api/interventions/' + sessionId(1) + '?limit=200', token, { port: WB_PORT });
  const beforeLines = fs.readFileSync(path.join(HOME, 'sessions', sessionId(1) + '.interventions.ndjson'), 'utf8').trim().split(/\r?\n/).length;
  const compact = await request('/api/_test/pretender-maintenance', token, { port: WB_PORT, method: 'POST', body: { action: 'compact', sessionId: sessionId(1) } });
  const afterCompact = await request('/api/interventions/' + sessionId(1) + '?limit=200', token, { port: WB_PORT });
  const afterLines = fs.readFileSync(path.join(HOME, 'sessions', sessionId(1) + '.interventions.ndjson'), 'utf8').trim().split(/\r?\n/).length;
  ok(compact.status === 200 && compact.body?.compacted === true && beforeLines === 200 && afterLines === 100, '(d) NDJSON 200→100行原子压缩');
  ok(beforeCompact.body?.projectionRevision === afterCompact.body?.projectionRevision && JSON.stringify(beforeCompact.body?.interventions) === JSON.stringify(afterCompact.body?.interventions), '(d) 压缩前后事实+revision等价');

  // Cold detail rebuild (usage aggregate must come from index, not a per-request 100k scan).
  const detailCold = [];
  let detail = null;
  for (let i = 0; i < 3; i++) { invalidateIndex(); detail = await request('/api/missions/' + sessionId(2), token, { port: WB_PORT }); detailCold.push(detail.ms); }
  ok(detail?.status === 200 && detail.body?.snapshot?.usage?.turns >= 333, '(e) 详情 usage 聚合覆盖10万账本');
  ok(percentile95(detailCold) <= 800, `(e) 详情冷P95≤800ms(实 ${Math.round(percentile95(detailCold))}ms)`);
  const detailEtag = detail.headers.etag;
  const detail304 = await request('/api/missions/' + sessionId(2), token, { port: WB_PORT, headers: { 'if-none-match': detailEtag } });
  ok(!!detailEtag && detail304.status === 304, '(e) 详情 ETag -> 304');

  const inboxCold = [];
  let inbox = null;
  for (let i = 0; i < 3; i++) { invalidateIndex(); inbox = await request('/api/interventions?limit=50', token, { port: WB_PORT }); inboxCold.push(inbox.ms); }
  ok(inbox?.status === 200 && inbox.body?.counts?.total === 29900 && inbox.body?.pending?.length === 50, '(f) 全局收件箱29,900 pending分页');
  ok(percentile95(inboxCold) <= 1200, `(f) 收件箱冷P95≤1200ms(实 ${Math.round(percentile95(inboxCold))}ms)`);
  const inboxHot = [];
  for (let i = 0; i < 12; i++) inboxHot.push((await request('/api/interventions?limit=50', token, { port: WB_PORT })).ms);
  ok(percentile95(inboxHot) <= 250, `(f) 收件箱热P95≤250ms(实 ${Math.round(percentile95(inboxHot))}ms)`);
  ok(percentile95(hotList) <= 600 && percentile95(detailCold) <= 1600 && percentile95(inboxHot) <= 500, '(g) 低配×2预算余量全绿');

  // Cursor must explicitly fail when revision changes between pages.
  const changedHeadPath = path.join(HOME, 'sessions', sessionId(299) + '.json');
  const changedHead = JSON.parse(fs.readFileSync(changedHeadPath, 'utf8')); changedHead.updatedAt = new Date().toISOString();
  fs.writeFileSync(changedHeadPath, JSON.stringify(changedHead), 'utf8'); invalidateIndex();
  const staleCursor = await request('/api/missions?cursor=' + encodeURIComponent(cursor), token, { port: WB_PORT });
  ok(staleCursor.status === 409 && staleCursor.body?.error?.code === 'projection.snapshot_changed' && staleCursor.body?.error?.params?.restartCursor === null, '(h) 跨页 revision 变化 -> 409 明确重开快照');

  // Missing/corrupt/interrupted index rebuilds from authority and keeps the same facts.
  const staleTmp = indexPath() + '.interrupted.tmp'; fs.writeFileSync(staleTmp, '{partial', 'utf8');
  invalidateIndex('corrupt');
  const recovered = await request('/api/missions?limit=37', token, { port: WB_PORT });
  ok(recovered.status === 200 && recovered.body?.page?.total === SESSION_COUNT && fs.existsSync(indexPath()), '(i) 坏索引/中断tmp -> 自动原子重建');

  // Damaged authority is readable but explicitly degraded; rebuilding must not launder the corrupt line.
  fs.appendFileSync(path.join(HOME, 'sessions', sessionId(2) + '.interventions.ndjson'), '{bad-authority-row\n', 'utf8'); invalidateIndex();
  const degraded = await request('/api/interventions/' + sessionId(2) + '?limit=200', token, { port: WB_PORT });
  ok(degraded.status === 200 && degraded.body?.integrity?.degraded === true && degraded.body?.integrity?.corruptLines === 1, '(j) journal有损显式 degraded，不以重建成功掩盖');

  const src = readServerSource();
  ok(/function getPretenderProjectionIndex\(\)/.test(src) && /projection\.snapshot_changed/.test(src), '(k) 静态锁:单一索引加载器+revision cursor冲突');
  ok(/async function compactInterventionJournal\(sessionId, opts = \{\}\)/.test(src) && /if \(folded\.degraded\)/.test(src), '(k) 静态锁:压缩不清洗损坏权威账');
  ok(/persistentRevision/.test(src) && /liveOverlay/.test(src), '(k) 静态锁:live overlay freshness分层');
} finally {
  kill(wb); await sleep(250); fs.rmSync(HOME, { recursive: true, force: true });
}

console.log('\nPRETENDER INDEX SCALE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
