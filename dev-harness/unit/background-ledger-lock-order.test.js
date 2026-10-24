'use strict';
// Exercise the actual rollback/rewind source against the actual receipt owner.
// Only session persistence, checkpoint metadata and the path guard are fixture seams.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { functionBlock } = require('../lib/source-slice');
const { backgroundLedgerFixture } = require('../lib/background-ledger-fixture');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/02-session-store.js'), 'utf8');
const functions = ['withJournalWriteLock', 'journalRollback', 'journalRollbackContents', 'rewindSessionArtifactContents'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error(label), { code: 'FIXTURE_OWNER_DEADLOCK' })), 2000); })]); }
  finally { clearTimeout(timer); }
}
function fixture(t, transform = value => value) {
  const f = backgroundLedgerFixture(t), session = f.session();
  session.turnSeq = 2;
  session.messages = [{ role: 'user', content: 'first', turnSeq: 1 }, { role: 'assistant', content: 'first result' },
    { role: 'user', content: 'second', turnSeq: 2 }, { role: 'system', content: 'receipt', backgroundJobId: 'receipt' }];
  let saved = JSON.parse(JSON.stringify(session)), index = [], loads = 0, fileEffects = 0;
  const before = new Map(), journalChains = new Map(), loadEntered = deferred(), resumeLoad = deferred(), rewindQueued = deferred();
  for (const turnSeq of [1, 2]) {
    const file = path.join(f.root, 'external-' + turnSeq + '.txt');
    fs.writeFileSync(file, 'changed ' + turnSeq);
    before.set(turnSeq + '-1', Buffer.from('original ' + turnSeq));
    index.push({ turnSeq, entrySeq: 1, path: file, op: 'modify' });
  }
  const originalChain = f.context.runKeyedChain;
  let journalAdmissions = 0;
  Object.assign(f.context, {
    clearTimeout, journalWriteChains: journalChains,
    runKeyedChain: (chains, key, work) => {
      if (chains === journalChains && ++journalAdmissions === 2) rewindQueued.resolve();
      return originalChain(chains, key, work);
    },
    withJournalArtifactOperation: (work, operation) => work(operation || {}), journalDir: () => f.root,
    journalReadIndex: async () => index.slice(),
    journalPreflightMutation: async () => new Map([...before].map(([key, bytes]) => [key, crypto.createHash('sha256').update(bytes).digest('hex')])),
    journalReadBefore: async (id, turnSeq, entrySeq) => before.get(turnSeq + '-' + entrySeq),
    journalWriteIndex: async (id, rows) => { index = rows; },
    sessionHeadIsWorkDataError: error => String(error?.code || '').startsWith('work_data'),
    journalArtifactFailure: suffix => Object.assign(Error(suffix), { code: 'work_data.' + suffix }),
    resolvePermissionMode: () => 'default',
    guardFileToolPath: async (file, ctx) => {
      assert.equal(ctx.session.id, session.id);
      assert.equal(path.dirname(file), f.root);
      fileEffects++; return { ok: true };
    },
    loadSession: async () => {
      if (++loads === 1) { loadEntered.resolve(); await resumeLoad.promise; }
      const value = JSON.parse(JSON.stringify(saved));
      await f.api.EventStreamHooks.mergeBackgroundJobs(value);
      return value;
    },
    saveSession: async value => { await f.api.EventStreamHooks.mergeBackgroundJobs(value); saved = JSON.parse(JSON.stringify(value)); },
    SessionExecutionHooks: {}, turnSettlers: new Map(), journalRevertLogRead: async () => [], journalAssertWritable: async () => {},
    journalRevertLogPrune: async () => {}, cancelModelRunsOfDiscardedTurns: () => {}, bumpMissionChangeSeq: async () => {},
  });
  const code = transform(functions.map(name => functionBlock(source, name)).join('\n'));
  const api = vm.runInContext(code + '\n({journalRollback,rewindSessionArtifactContents});', f.context);
  return { f, session, api, loadEntered, resumeLoad, rewindQueued, journalChains,
    state: () => ({ saved, index, loads, fileEffects }) };
}
async function runConcurrent(t, transform) {
  const x = fixture(t, transform); x.f.state.enabled = true;
  await x.f.api.persistBackgroundJob({ id: 'receipt', sessionId: x.session.id, kind: 'agent', status: 'succeeded', output: 'completed' });
  const ordinary = x.api.journalRollback(x.session.id, 1); ordinary.catch(() => {});
  await bounded(x.loadEntered.promise, 'ordinary rollback did not reach its guarded session read');
  const rewind = x.api.rewindSessionArtifactContents(x.session.id, 2, true, { guarded: true }, {}, { registered: null, observedExecution: null }); rewind.catch(() => {});
  try { await bounded(x.rewindQueued.promise, 'rewind did not join the journal owner'); }
  finally { x.resumeLoad.resolve(); }
  const results = await bounded(Promise.all([ordinary, rewind]), 'journal and receipt owners did not drain');
  return { x, results };
}
test('normal rollback and rewind use J then ledger, restore both real files and forget only the discarded receipt', async t => {
  const { x, results } = await runConcurrent(t);
  assert.equal(results[0].ok, true); assert.equal(results[1].ok, true);
  assert.equal(fs.readFileSync(path.join(x.f.root, 'external-1.txt'), 'utf8'), 'original 1');
  assert.equal(fs.readFileSync(path.join(x.f.root, 'external-2.txt'), 'utf8'), 'original 2');
  assert.equal(x.state().fileEffects, 2); assert.equal(x.state().index.length, 0);
  assert.equal(x.state().loads, 3, 'rewind borrows its loaded guard view inside the ledger owner');
  assert.deepEqual(x.state().saved.messages.map(row => row.content), ['first', 'first result']);
  assert.equal((await x.f.api.readBackgroundJobs(x.session.id)).length, 0);
  assert.equal(x.f.state.acquires, x.f.state.releases);
});
test('negative control detects a normal J to ledger versus rewind ledger to J inversion without hanging CI', async t => {
  const transform = code => {
    const outer = 'await withJournalWriteLock(sessionId, async () => {';
    assert.ok(code.includes(outer));
    code = code.replace(outer, 'await (async () => {');
    const end = '\n  });\n\n  session.messages = messages.slice(0, cutIndex);';
    assert.ok(code.includes(end)); code = code.replace(end, '\n  })();\n\n  session.messages = messages.slice(0, cutIndex);');
    const direct = 'const r = await journalRollbackContents(sessionId, s, undefined, operation, preparedBefore, session);';
    assert.ok(code.includes(direct)); return code.replace(direct, 'const r = await journalRollback(sessionId, s, undefined, operation, preparedBefore, session);');
  };
  await assert.rejects(runConcurrent(t, transform), { code: 'FIXTURE_OWNER_DEADLOCK' });
});
test('negative control detects reloading a session while its ledger owner is already held', async t => {
  const transform = code => {
    const borrowed = 'if (preparedGuardSession?.id === sessionId) guardSession = preparedGuardSession;';
    assert.ok(code.includes(borrowed)); return code.replace(borrowed, 'if (false) guardSession = preparedGuardSession;');
  };
  await assert.rejects(runConcurrent(t, transform), { code: 'FIXTURE_OWNER_DEADLOCK' });
});
