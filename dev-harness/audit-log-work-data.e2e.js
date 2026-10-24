'use strict';
// Generated runtime + real Windows DPAPI. No crypto/key stubs. Source units own
// disk faults, frozen-stat collisions, native Writable pressure and ALS controls.
const path = require('node:path'), repo = path.resolve(__dirname, '..');
require('./lib/self-isolate-home');
const fs = require('node:fs'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-audit-work-data-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const { loadServerInternals } = require('./lib/server-internals');
const t = require('./lib/harness').createRunner('AUDIT LOG WORK DATA');
const names = ['readConfig', 'writeConfig', 'workDataKeys', 'paths', 'logEvent', 'flushWorkbenchLogs', 'latestLogFile',
  'readLogTailSnapshot', 'readWorkbenchAudit', 'readWorkbenchLogFile', 'workbenchAuditJournal', 'buildOpsMetrics', 'sweepLogsStore',
  'handleApi', 'sendError', 'pretenderIndexRuntime', 'stopStewardInbox', 'stopScheduler'];
const runtimes = [], load = () => { const api = loadServerInternals(names, { withEval: true }); runtimes.push(api); return api; };
const privateError = error => String(error?.code || '').startsWith('work_data');
let server, address;
async function toggle(api, enabled) { const config = await api.readConfig(); config.workDataEncryptionV1 = enabled; await api.writeConfig(config); }
async function request(route, body) {
  const response = await fetch(address + route, { method: body ? 'POST' : 'GET', headers: { 'x-wcw-token': 'audit-e2e-token', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, value: await response.json() };
}
(async () => {
  const api = load(); await toggle(api, false); await api.flushWorkbenchLogs();
  for (const name of fs.readdirSync(api.paths.logs)) if (/^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)) fs.unlinkSync(path.join(api.paths.logs, name));
  const first = { ts: new Date().toISOString(), kind: 'intervention', source: 'e2e', value: 'OFF ORIGINAL 中文😀' };
  api.logEvent(first); await api.flushWorkbenchLogs();
  const file = api.latestLogFile(); assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(first) + '\n');
  // Full audit/metrics must still find this intervention beyond the tail's 2 MiB window.
  fs.appendFileSync(file, '{bad legacy\n' + JSON.stringify({ kind: 'mission_start', value: 'x'.repeat(2300000) }) + '\n');
  assert.equal((await api.readWorkbenchAudit(1, { kinds: new Set(['intervention']) }))[0].detail.value, first.value);
  assert.equal((await api.buildOpsMetrics(7)).interventions.total, 1);
  t.ok(true, 'OFF exact JSON bytes and full-file audit/metrics preserve filter-before-limit beyond 2 MiB');
  if (process.platform !== 'win32') { console.log('SKIP real DPAPI audit-log lifecycle: Windows only'); return; }
  await toggle(api, true); await api.workDataKeys.ensure();
  const large = 'AUDIT-PRIVATE-CONTENT-' + '密😀'.repeat(950000);
  api.logEvent({ kind: 'audit_large', value: large }); api.logEvent({ kind: 'audit_small', value: 'AUDIT-SMALL-SECRET' }); await api.flushWorkbenchLogs();
  const sealed = fs.readFileSync(file); assert.equal(sealed.includes(Buffer.from('AUDIT-PRIVATE-CONTENT-')), false);
  assert.equal(JSON.parse(sealed.toString('utf8').trimEnd().split('\n').at(-2)).w, 3);
  for (const runtime of runtimes) runtime.workDataKeys.clear(); const cold = load();
  assert.equal((await cold.readWorkbenchAudit(1, { kinds: new Set(['audit_large']) }))[0].detail.value, large);
  assert.ok((await cold.readLogTailSnapshot(10)).lines.some(line => line.includes('AUDIT-SMALL-SECRET')));
  t.ok(true, 'real DPAPI chunked Unicode rows stay encrypted and cold readers restore full audit plus logical tail');

  // The real serve path initializes policy with readConfig before opening HTTP.
  // A cold internal module has no implicit policy initialization from audit reads.
  await cold.readConfig();
  cold.__eval("RUNTIME.token = 'audit-e2e-token'");
  server = http.createServer(async (req, res) => { try { await cold.handleApi(req, res, new URL(req.url, 'http://x').pathname); } catch (error) { cold.sendError(res, error); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); address = 'http://127.0.0.1:' + server.address().port;
  const tail = await request('/api/logs/tail?lines=10'); assert.equal(tail.status, 200); assert.equal(tail.value.ok, true);
  const prepared = await request('/api/privacy/export', { kind: 'log-tail-copy', lines: 10 });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value)); assert.ok(prepared.value.proof);
  assert.equal((await request('/api/privacy/export', { op: 'validate', proof: prepared.value.proof, hash: prepared.value.hash })).status, 200);
  t.ok(true, 'real authenticated HTTP tail and log-copy prepare/validate use the encrypted log owner');

  const keyFile = path.join(cold.paths.data, 'work-data-key-v1.json'), keyBytes = fs.readFileSync(keyFile);
  for (const runtime of runtimes) runtime.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.missing');
  try {
    for (const read of [() => cold.readLogTailSnapshot(10), () => cold.readWorkbenchAudit(10), () => cold.buildOpsMetrics(7)]) await assert.rejects(read, { code: 'work_data_key.absent' });
    for (const route of ['/api/logs/tail', '/api/ops/metrics', '/api/audit?source=workbench']) {
      const response = await request(route); assert.equal(response.status, 503); assert.equal(response.value.error.code, 'work_data_key.absent');
    }
    const exported = await request('/api/privacy/export', { kind: 'log-tail-copy', lines: 10 }); assert.equal(exported.status, 503); assert.equal(exported.value.error.code, 'work_data_key.absent');
    assert.deepEqual(fs.readFileSync(file), sealed);
  } finally { fs.renameSync(keyFile + '.missing', keyFile); for (const runtime of runtimes) runtime.workDataKeys.clear(); }
  t.ok(true, 'missing current key propagates work_data through all audit/metrics/tail/export HTTP readers without empty success');

  const wrong = JSON.parse(keyBytes); wrong.instanceId = 'e'.repeat(32); fs.writeFileSync(keyFile, JSON.stringify(wrong));
  for (const runtime of runtimes) runtime.workDataKeys.clear();
  try { await assert.rejects(() => cold.readWorkbenchAudit(10), privateError); await assert.rejects(() => cold.workbenchAuditJournal(file).preflight(), privateError); }
  finally { fs.writeFileSync(keyFile, keyBytes); for (const runtime of runtimes) runtime.workDataKeys.clear(); }
  const copied = path.join(cold.paths.logs, 'workbench-9999-12-31.ndjson'); fs.writeFileSync(copied, sealed);
  try { await assert.rejects(() => cold.readWorkbenchAudit(10), privateError); } finally { fs.unlinkSync(copied); }
  const damaged = sealed.toString('utf8').replace(/("ciphertext":")([A-Za-z0-9+/])/, (_, prefix, char) => prefix + (char === 'A' ? 'B' : 'A'));
  assert.notEqual(damaged, sealed.toString('utf8')); fs.writeFileSync(file, damaged);
  try { await assert.rejects(() => cold.readWorkbenchAudit(10), privateError); await assert.rejects(() => cold.workbenchAuditJournal(file).preflight(), privateError); assert.equal(fs.readFileSync(file, 'utf8'), damaged); }
  finally { fs.writeFileSync(file, sealed); }
  t.ok(true, 'current wrong instance, copied day scope and tampered ciphertext cannot authorize audit bytes');

  fs.writeFileSync(file, sealed.subarray(0, -1));
  try { await cold.readLogTailSnapshot(10); await assert.rejects(() => cold.workbenchAuditJournal(file).preflight(), { code: 'work_data_journal.sealed_tail_uncommitted' }); }
  finally { fs.writeFileSync(file, sealed); }
  await toggle(cold, false); await cold.readWorkbenchAudit(10);
  await assert.rejects(() => cold.workbenchAuditJournal(file).preflight(), { code: 'work_data_journal.downgrade_refused' }); assert.deepEqual(fs.readFileSync(file), sealed);
  await toggle(cold, true);
  const proof = await cold.readLogTailSnapshot(10, { stable: true });
  cold.logEvent({ kind: 'later' }); await cold.flushWorkbenchLogs(); await assert.rejects(proof.check, privateError);
  t.ok(true, 'sealed no-LF tails remain readable but immutable; OFF refuses downgrade; stable copies revalidate current content');

  const old = path.join(cold.paths.logs, 'workbench-2020-01-01.ndjson'), journal = cold.workbenchAuditJournal(old);
  await journal.append(['{"kind":"old"}'], () => { throw Error('unexpected legacy writer'); }); const oldBytes = fs.readFileSync(old);
  await toggle(cold, false);
  await assert.rejects(() => cold.sweepLogsStore({ logsKeepDays: 7 }, { freedBytes: 0, actions: [] }), { code: 'work_data_journal.downgrade_refused' });
  assert.deepEqual(fs.readFileSync(old), oldBytes); await toggle(cold, true);
  fs.writeFileSync(old, oldBytes.subarray(0, -20)); const broken = fs.readFileSync(old), result = { freedBytes: 0, actions: [] };
  await assert.rejects(() => cold.sweepLogsStore({ logsKeepDays: 7 }, result), { code: 'work_data_journal.sealed_tail_uncommitted' });
  assert.deepEqual(fs.readFileSync(old), broken); assert.equal(result.actions.length, 0);
  fs.writeFileSync(old, oldBytes); await cold.sweepLogsStore({ logsKeepDays: 7 }, result); assert.equal(fs.existsSync(old), false); assert.equal(result.actions.length, 1);
  t.ok(true, 'retention refuses OFF sealed and unverified torn ciphertext; only a freshly authenticated ON old source is deleted');
})().catch(error => t.fail(error?.stack || String(error))).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const api of runtimes) { await api.flushWorkbenchLogs({ allowFailure: true }); api.stopStewardInbox(); api.stopScheduler(); clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer); api.workDataKeys.clear(); }
  assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('ruyi-audit-work-data-')); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
