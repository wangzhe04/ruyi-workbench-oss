'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { backgroundLedgerFixture } = require('../lib/background-ledger-fixture');
const privateError = error => String(error?.code || '').startsWith('work_data');
const job = (id = 'job1', sessionId = 'sess_ledger') => ({ id, sessionId, kind: 'agent', name: 'Synthetic receipt', status: 'succeeded', output: 'PRIVATE-LEDGER-😀', completedAt: '2026-10-24T12:00:00Z' });

test('OFF compact bytes, submission snapshot, parallel RMW and old 100 row bound', async t => {
  const f = backgroundLedgerFixture(t); f.session();
  const value = job(), pending = f.api.persistBackgroundJob(value), original = JSON.stringify([value]); value.output = 'changed';
  assert.equal(await pending, true); assert.equal(fs.readFileSync(f.file(), 'utf8'), original);
  assert.equal(f.state.acquires, 0);
  await Promise.all(Array.from({ length: 105 }, (_, n) => f.api.persistBackgroundJob(job('j' + n))));
  const rows = await f.api.readBackgroundJobs('sess_ledger'); assert.equal(rows.length, 100);
  assert.equal(rows[0].id, 'j5'); assert.equal(rows[99].id, 'j104'); assert.equal(new Set(rows.map(row => row.id)).size, 100);
  assert.equal(f.state.acquires, 0);
});

test('sealed large Unicode roundtrip, fixed session binding, one released lease per RMW', async t => {
  const f = backgroundLedgerFixture(t); const session = f.session(); f.state.enabled = true;
  const value = job(); value.output = '合成😀'.repeat(250000); assert.equal(await f.api.persistBackgroundJob(value), true);
  const bytes = fs.readFileSync(f.file(), 'utf8'); assert.equal(JSON.parse(bytes.split('\n')[0]).workData, 3); assert.ok(!bytes.includes('合成'));
  assert.equal(f.state.acquires, 1); assert.equal(f.state.releases, 1);
  assert.equal((await f.api.readBackgroundJobs(session.id))[0].output, value.output);
  await f.api.EventStreamHooks.mergeBackgroundJobs(session); assert.equal(session.messages.length, 1);
  f.session('sess_other'); fs.writeFileSync(f.file('sess_other'), bytes);
  await assert.rejects(f.api.readBackgroundJobs('sess_other'), privateError);
  assert.equal(f.state.acquires, f.state.releases);
});

test('missing key on legacy/empty ON ledger precedes new mail delivery and never signals queued', async t => {
  const f = backgroundLedgerFixture(t); const session = f.session(); f.api.activeChildren.set(session.id, { session });
  f.state.enabled = true; f.state.keyError = Object.assign(Error('SYNTHETIC SECRET'), { code: 'work_data_key.absent' });
  assert.equal(await f.api.EventStreamHooks.notifyAgentMessage({ sessionId: session.id, sourceSessionId: 'source', messageId: 'm1', text: 'PRIVATE MAIL' }), false);
  assert.equal(session.messages.length, 0); assert.equal(f.state.events.length, 0); assert.equal(fs.existsSync(f.file()), false);
  assert.equal(await f.api.EventStreamHooks.pendingAgentMessages(session.id), false); // absent sidecar discloses no receipt
  fs.mkdirSync(require('node:path').dirname(f.file()), { recursive: true }); fs.writeFileSync(f.file(), '[]');
  await assert.rejects(f.api.EventStreamHooks.pendingAgentMessages(session.id), privateError);
  assert.ok(f.state.diagnostics.every(row => !JSON.stringify(row).includes('SYNTHETIC SECRET')));
});

test('completed shell receipt failure reports original outcome exactly once and never replays action', async t => {
  const f = backgroundLedgerFixture(t); const session = f.session(); f.api.activeChildren.set(session.id, { session });
  f.state.enabled = true; f.state.keyError = Object.assign(Error('key'), { code: 'work_data_key.absent' });
  const shell = { mode: 'background', sessionId: session.id, jobId: 'shell1', name: 'done', exitCode: 0, buf: 'ALREADY COMPLETED', baseOffset: 0 };
  await f.api.completeBackgroundJob('sh_1', shell); await f.api.completeBackgroundJob('sh_1', shell);
  assert.equal(f.state.events.length, 1); assert.equal(f.state.events[0].persisted, false); assert.equal(f.state.events[0].status, 'succeeded');
  assert.equal(session.messages.length, 1); assert.ok(session.messages[0].content.includes('ALREADY COMPLETED')); assert.equal(shell.notified, true);
});

test('tamper, wrong instance, unavailable config and OFF downgrade never replace sealed bytes', async t => {
  const f = backgroundLedgerFixture(t); f.session(); f.state.enabled = true; await f.api.persistBackgroundJob(job());
  const original = fs.readFileSync(f.file(), 'utf8');
  for (const broken of [original.slice(0, -30), '{"workData":3,"format":']) {
    fs.writeFileSync(f.file(), broken); await assert.rejects(f.api.readBackgroundJobs('sess_ledger'), privateError);
    assert.equal(await f.api.persistBackgroundJob(job('later')), false); assert.equal(fs.readFileSync(f.file(), 'utf8'), broken);
  }
  fs.writeFileSync(f.file(), original); f.state.instance = 'different'; await assert.rejects(f.api.readBackgroundJobs('sess_ledger'), privateError);
  f.state.instance = null; f.state.enabled = false; assert.equal(await f.api.persistBackgroundJob(job('later')), false);
  assert.equal(fs.readFileSync(f.file(), 'utf8'), original);
  f.state.degraded = true; await assert.rejects(f.api.readBackgroundJobs('sess_ledger'), { code: 'work_data_store.switch_unavailable' });
  assert.equal(fs.readFileSync(f.file(), 'utf8'), original);
});

test('drains serialize seen after async authentication, delivery receipt failure cannot duplicate text', async t => {
  const f = backgroundLedgerFixture(t), session = f.session(); f.state.enabled = true;
  await f.api.EventStreamHooks.notifyAgentMessage({ sessionId: session.id, sourceSessionId: 'source', messageId: 'm1', text: 'PRIVATE MAIL' });
  f.state.failRename = true;
  await Promise.all([f.api.EventStreamHooks.drainBackgroundJobs(session), f.api.EventStreamHooks.drainBackgroundJobs(session)]);
  assert.equal(session.providerHistory.length, 1); assert.equal(session.backgroundJobSeen.length, 1);
  f.state.failRename = false;
  await f.api.persistBackgroundJob(job('agent2'));
  const text = await Promise.all([f.api.EventStreamHooks.drainAgentEnvelopesText(session), f.api.EventStreamHooks.drainAgentEnvelopesText(session)]);
  assert.equal(text.filter(Boolean).length, 1);
});

test('rewind admission fails before file effects, failed replacement does not report successful rollback', async t => {
  const f = backgroundLedgerFixture(t); f.session(); f.state.enabled = true; await f.api.persistBackgroundJob(job());
  const original = fs.readFileSync(f.file(), 'utf8'); let effects = 0;
  f.state.enabled = false;
  await assert.rejects(f.api.EventStreamHooks.rewindBackgroundJobs('sess_ledger', ['job1'], async () => { effects++; }), { code: 'work_data_store.downgrade_refused' });
  assert.equal(effects, 0); f.state.enabled = true; f.state.failRename = true;
  await assert.rejects(f.api.EventStreamHooks.rewindBackgroundJobs('sess_ledger', ['job1'], async () => { effects++; }), { code: 'EIO' });
  assert.equal(effects, 1); assert.equal(fs.readFileSync(f.file(), 'utf8'), original);
  f.state.failRename = false; assert.equal((await f.api.readBackgroundJobs('sess_ledger')).length, 1);
});

test('delete waits for in-flight owner, late writes and drains cannot resurrect deleted ledger', async t => {
  const f = backgroundLedgerFixture(t), session = f.session();
  f.api.activeChildren.set(session.id, { session }); let wakes = 0;
  f.api.EventStreamHooks.onAgentEnvelopePersisted = () => { wakes++; };
  let entered, resume; const waiting = new Promise(resolve => { entered = resolve; }), paused = new Promise(resolve => { resume = resolve; });
  f.state.onRename = async () => { entered(); await paused; };
  const pending = f.api.persistBackgroundJob({ ...job(), wakeParent: true }); await waiting;
  f.api.sessionDeleteTombstones.set(session.id, { at: Date.now() }); const deletion = f.api.EventStreamHooks.deleteBackgroundJobs(session.id);
  resume(); await pending; await deletion; assert.equal(fs.existsSync(f.file()), false);
  assert.equal(session.messages.length, 0); assert.equal(wakes, 0);
  f.state.onRename = null; assert.equal(await f.api.persistBackgroundJob(job('late')), false);
  await f.api.EventStreamHooks.drainBackgroundJobs(session); assert.equal(session.providerHistory.length, 0); assert.equal(fs.existsSync(f.file()), false);
});
