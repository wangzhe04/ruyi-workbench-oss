#!/usr/bin/env node
'use strict';

// 第79波数据面 E2E：全类型流水无重无漏、缺号/损坏显式降级、changes API 边界稳定。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), `wcw-pretender-return-archive-${process.pid}`);
const PORT = await getFreePort();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };
function killTree(child) {
  if (!child || !child.pid) return;
  try { if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); } catch {}
}
function request(pathname, token = '') {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, headers: token ? { 'x-wcw-token': token } : {}, timeout: 2500 }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => {
        let json = null; try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function waitHealth() { for (let i = 0; i < 100; i++) { const result = await request('/health'); if (result?.status === 200) return true; await sleep(60); } return false; }

fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME; process.env.HOME = HOME; process.env.USERPROFILE = HOME;
const core = require(path.join(WB, 'app', 'server.js'));
const types = ['mission_started', 'progress', 'failure', 'budget', 'intervention_pending',
  'intervention_resolved', 'result', 'rewind', 'run_deleted'];

let server = null;
try {
  const session = await core.createSession({ title: 'Wave 79 journal', cwd: ROOT });
  session.kind = 'mission';
  session.mission = { goal: 'cover all changes', autoMode: 'off', changeSeq: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), milestones: [] };
  await core.saveSession(session);
  for (let index = 0; index < types.length; index++) {
    const revision = await core.bumpMissionChangeSeq(session.id, {
      type: types[index], cursor: { source: types[index], ordinal: index + 1 }, detail: { ordinal: index + 1 },
    });
    ok(revision === index + 1, `A1 ${types[index]} advances exactly one revision`);
  }
  const folded = await core.readMissionChangesWithMeta(session.id);
  ok(!folded.degraded && folded.records.length === types.length, 'A2 all change types fold without degradation');
  ok(JSON.stringify(folded.records.map(row => row.type)) === JSON.stringify(types), 'A3 change order is stable and duplicate-free');
  ok(folded.records.every((row, index) => row.seq === index + 1 && row.cursor.source === row.type), 'A4 every row retains monotonic seq and raw source cursor');

  const migration = core.foldMissionChangeJournalText(JSON.stringify({ seq: 42, type: 'progress' }) + '\n', 42);
  ok(!migration.degraded && migration.baseRevision === 41, 'A5 missing legacy prefix becomes an explicit migration baseline');
  const internalGap = core.foldMissionChangeJournalText([
    JSON.stringify({ seq: 1, type: 'progress' }), JSON.stringify({ seq: 3, type: 'result' }), '',
  ].join('\n'), 3);
  ok(internalGap.degraded && internalGap.gap?.expected === 2 && internalGap.gap?.actual === 3, 'A6 internal sequence gap degrades with expected/actual evidence');
  const corrupt = core.foldMissionChangeJournalText('{bad json}\n' + JSON.stringify({ seq: 1, type: 'progress' }) + '\n', 1);
  ok(corrupt.degraded && corrupt.corruptLines === 1, 'A7 corrupt line remains visible as integrity degradation');

  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true,
  });
  server.stderr.on('data', data => String(data).trim() && console.error('[wb] ' + String(data).trim()));
  ok(await waitHealth(), 'B1 workbench starts on seeded journal');
  let token = '';
  for (let i = 0; i < 40 && !token; i++) { try { token = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch {} if (!token) await sleep(50); }
  ok(Boolean(token), 'B2 runtime token available');
  const noToken = await request(`/api/missions/${session.id}/changes?after=0`);
  ok(noToken?.status === 403, 'B3 changes API is token protected');
  const all = await request(`/api/missions/${session.id}/changes?after=0`, token);
  ok(all?.status === 200 && all.json?.changes?.length === types.length && all.json?.currentRevision === types.length, 'B4 API returns exact (0,currentRevision] interval');
  ok(all.json.changes.every((row, index) => row.seq === index + 1), 'B5 API interval is ordered with no duplicate or rollback');
  const caughtUp = await request(`/api/missions/${session.id}/changes?after=${types.length}`, token);
  ok(caughtUp?.status === 200 && caughtUp.json?.changes?.length === 0 && caughtUp.json?.degraded === false, 'B6 current cursor returns an empty healthy delta');
  const invalid = await request(`/api/missions/${session.id}/changes?after=-1`, token);
  ok(invalid?.status === 400, 'B7 invalid read cursor is rejected');

  const journal = core.missionChangeFilePath(session.id);
  const original = fs.readFileSync(journal, 'utf8');
  fs.writeFileSync(journal, original.split('\n').slice(1).join('\n'), 'utf8');
  const prefixGap = await request(`/api/missions/${session.id}/changes?after=0`, token);
  ok(prefixGap?.json?.degraded === true && prefixGap.json.gap?.prefix === true, 'B8 missing requested prefix triggers explicit degraded response');
  fs.writeFileSync(journal, original + '{corrupt-tail}\n', 'utf8');
  const badJournal = await request(`/api/missions/${session.id}/changes?after=${types.length}`, token);
  ok(badJournal?.json?.degraded === true && badJournal.json.integrity?.corruptLines === 1, 'B9 corrupt journal cannot silently advance a client cursor');
} finally {
  killTree(server);
  await sleep(120);
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(`\nPRETENDER RETURN/ARCHIVE E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
