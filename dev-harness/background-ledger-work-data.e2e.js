'use strict';
require('./lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-ledger-dpapi-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const { loadServerInternals } = require('./lib/server-internals'), t = require('./lib/harness').createRunner('BACKGROUND LEDGER WORK DATA');
const names = ['readConfig', 'writeConfig', 'workDataKeys', 'paths', 'createSession', 'saveSession', 'loadSession', 'deleteSession', 'rewindSession',
  'backgroundJobFile', 'readBackgroundJobs', 'persistBackgroundJob', 'completeBackgroundJob', 'EventStreamHooks', 'handleApi', 'sendError',
  'stopStewardInbox', 'stopScheduler', 'pretenderIndexRuntime', 'flushWorkbenchLogs', 'toolCall'];
const runtimes = [], load = () => { const api = loadServerInternals(names, { withEval: true }); runtimes.push(api); return api; };
const privateError = error => String(error?.code || '').startsWith('work_data');
let server, address;
const toggle = async (api, value) => { const config = await api.readConfig(); config.workDataEncryptionV1 = value; config.agentAutoWake = false; await api.writeConfig(config); };
const job = (sid, id, output = 'DPAPI-LEDGER-SECRET-😀') => ({ id, sessionId: sid, kind: 'agent', runId: id, name: 'Synthetic receipt', status: 'succeeded', output, completedAt: new Date().toISOString(), wakeParent: true });
(async () => {
  const api = load(); await toggle(api, false);
  const session = await api.createSession({ title: 'Synthetic ledger', cwd: root }), sid = session.id;
  const originalJob = job(sid, 'off'); await api.persistBackgroundJob(originalJob);
  assert.equal(fs.readFileSync(api.backgroundJobFile(sid), 'utf8'), JSON.stringify([originalJob]));
  assert.equal((await api.loadSession(sid)).messages.filter(row => row.backgroundJobId === 'off').length, 1);
  t.ok(true, 'OFF original compact bytes and real session merge');
  if (process.platform !== 'win32') { console.log('SKIP real DPAPI ledger: Windows only'); return; }
  await toggle(api, true); await api.workDataKeys.ensure();
  const large = 'PRIVATE-LARGE-LEDGER-' + '加密😀'.repeat(190000);
  await Promise.all([api.persistBackgroundJob(job(sid, 'large', large)), ...Array.from({ length: 6 }, (_, n) => api.persistBackgroundJob(job(sid, 'parallel' + n)))]);
  const file = api.backgroundJobFile(sid), sealed = fs.readFileSync(file);
  assert.equal(JSON.parse(sealed.toString('utf8').split('\n')[0]).workData, 3); assert.equal(sealed.includes(Buffer.from('PRIVATE-LARGE-LEDGER-')), false);
  for (const runtime of runtimes) runtime.workDataKeys.clear(); const cold = load();
  const rows = await cold.readBackgroundJobs(sid); assert.equal(rows.length, 8); assert.equal(rows.find(row => row.id === 'large').output, large);
  assert.ok((await cold.EventStreamHooks.recentBackgroundAgentJobSessions(Date.now() - 60000)).includes(sid));
  t.ok(true, 'real DPAPI concurrent chunked receipts survive cold reads and boot discovery');
  cold.__eval("RUNTIME.token = 'ledger-test-token'");
  server = http.createServer(async (req, res) => { try { await cold.handleApi(req, res, new URL(req.url, 'http://x').pathname); } catch (error) { cold.sendError(res, error); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); address = 'http://127.0.0.1:' + server.address().port;
  const request = etag => fetch(address + '/api/sessions/' + sid, { headers: { 'x-wcw-token': 'ledger-test-token', ...(etag ? { 'if-none-match': etag } : {}) } });
  let response = await request(); assert.equal(response.status, 200); const body = await response.json();
  assert.ok(body.session.messages.some(row => row.backgroundJobId === 'large' && row.content.includes(large)));
  const etag = response.headers.get('etag'); assert.ok(etag); response = await request(etag); assert.equal(response.status, 304);
  const keyFile = path.join(cold.paths.data, 'work-data-key-v1.json'), keyBytes = fs.readFileSync(keyFile);
  for (const runtime of runtimes) runtime.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.missing');
  try {
    await assert.rejects(cold.readBackgroundJobs(sid), { code: 'work_data_key.absent' });
    response = await request(etag); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'work_data_key.absent');
    assert.equal(await cold.persistBackgroundJob(job(sid, 'failed')), false); assert.deepEqual(fs.readFileSync(file), sealed);
  } finally { fs.renameSync(keyFile + '.missing', keyFile); for (const runtime of runtimes) runtime.workDataKeys.clear(); }
  t.ok(true, 'HTTP decrypts receipts and conditional cached reads reauthenticate current keys');
  const copiedSession = await cold.createSession({ title: 'Other synthetic session', cwd: root }); fs.writeFileSync(cold.backgroundJobFile(copiedSession.id), sealed);
  await assert.rejects(cold.readBackgroundJobs(copiedSession.id), privateError);
  const wrong = JSON.parse(keyBytes); wrong.instanceId = 'f'.repeat(32); fs.writeFileSync(keyFile, JSON.stringify(wrong));
  for (const runtime of runtimes) runtime.workDataKeys.clear();
  try { await assert.rejects(cold.readBackgroundJobs(sid), privateError); }
  finally { fs.writeFileSync(keyFile, keyBytes); for (const runtime of runtimes) runtime.workDataKeys.clear(); }
  fs.writeFileSync(file, sealed.subarray(0, -25));
  try { await assert.rejects(cold.loadSession(sid), privateError); assert.equal(await cold.persistBackgroundJob(job(sid, 'tamper-write')), false); }
  finally { fs.writeFileSync(file, sealed); }
  await toggle(cold, false); assert.equal(await cold.persistBackgroundJob(job(sid, 'downgrade')), false); assert.deepEqual(fs.readFileSync(file), sealed); await toggle(cold, true);
  t.ok(true, 'session scope, current instance, tamper and OFF downgrade all fail closed');
  const mailbox = await cold.createSession({ title: 'Synthetic mail', cwd: root });
  assert.equal(await cold.EventStreamHooks.notifyAgentMessage({ sessionId: mailbox.id, sourceSessionId: sid, messageId: 'm1', text: 'DPAPI-PRIVATE-MAIL' }), true);
  assert.equal((await cold.EventStreamHooks.agentMessageStatus(sid, mailbox.id, 'm1')).status, 'queued');
  await Promise.all([cold.EventStreamHooks.drainBackgroundJobs(mailbox), cold.EventStreamHooks.drainBackgroundJobs(mailbox)]);
  assert.equal(mailbox.providerHistory.length, 1); assert.equal((await cold.EventStreamHooks.agentMessageStatus(sid, mailbox.id, 'm1')).status, 'delivered');
  assert.equal(await cold.EventStreamHooks.pendingAgentMessages(mailbox.id), false);
  t.ok(true, 'encrypted mail enqueues, drains once and reports delivered status');
  const rewind = await cold.createSession({ title: 'Synthetic rewind', cwd: root });
  rewind.turnSeq = 1; rewind.messages.push({ role: 'user', content: 'one turn', turnSeq: 1 }); await cold.saveSession(rewind);
  const checkpointFile = path.join(root, 'synthetic-rollback.txt'); fs.writeFileSync(checkpointFile, 'ORIGINAL CHECKPOINT');
  const writeResult = await cold.toolCall('file_write', { path: checkpointFile, content: 'CHANGED CHECKPOINT' }, { sessionId: rewind.id, turnSeq: 1, session: rewind, config: { permissionMode: 'bypass' } });
  assert.equal(writeResult.ok, true);
  await cold.persistBackgroundJob(job(rewind.id, 'rewind-receipt'));
  const result = await cold.rewindSession(rewind.id, 1, true); assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(checkpointFile, 'utf8'), 'ORIGINAL CHECKPOINT');
  assert.equal((await cold.readBackgroundJobs(rewind.id)).length, 0); assert.equal((await cold.loadSession(rewind.id)).messages.length, 0);
  await cold.deleteSession(mailbox.id); assert.equal(fs.existsSync(cold.backgroundJobFile(mailbox.id)), false);
  assert.equal(await cold.EventStreamHooks.notifyAgentMessage({ sessionId: mailbox.id, sourceSessionId: sid, messageId: 'late', text: 'late' }), false);
  t.ok(true, 'actual checkpoint rewind restores files, forgets sealed receipts and explicit delete removes the owned ledger');
})().catch(error => t.fail(error?.stack || String(error))).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const api of runtimes) { await api.flushWorkbenchLogs({ allowFailure: true }); api.stopStewardInbox(); api.stopScheduler(); clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer); api.workDataKeys.clear(); }
  assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
