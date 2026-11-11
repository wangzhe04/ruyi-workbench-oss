'use strict';
require('./lib/self-isolate-home');
// Opt-in transport qualification: real helper features + read-only mouse-position queries.
// No event posting, clipboard/window mutation, held-state fault, TCC change, or App launch.
// The test fsyncs an entry before continue; this is not the future product journal/Node recovery.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const t = createRunner('MACOS NATIVE RECEIPTS');
const records = [];
let root, helper, retained = false;
const active = new Set();
const token = () => crypto.randomBytes(16).toString('hex');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const alive = child => child.exitCode === null && child.signalCode === null;
function check(value, label) { t.ok(value, label); if (!value) throw new Error('Stopped after ' + label); }
async function until(read, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out: ' + label);
}
async function worker(label) {
  const env = { ...fixtureChildEnv(), HOME: path.join(root, 'h'), USERPROFILE: path.join(root, 'h'),
    APPDATA: path.join(root, 'a'), LOCALAPPDATA: path.join(root, 'l'), TMPDIR: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const dir of [env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
  const child = cp.spawn(helper, ['--input-session'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  const record = { label, pid: child.pid, rows: [], stderr: '' }; records.push(record);
  child.stderr.on('data', bytes => { record.stderr += String(bytes); });
  let buffer = '';
  child.stdout.on('data', bytes => {
    buffer += bytes; let end;
    if (buffer.length > 65536) { record.parseError = 'unexpected output size'; return; }
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { record.rows.push(JSON.parse(line)); } catch { record.parseError = 'invalid JSON'; }
    }
  });
  const birth = await until(() => snapshotProcessTable()?.find(row => row.pid === child.pid), 'owned helper birth');
  if (birth.ppid !== process.pid) throw new Error('Unexpected helper parent');
  record.birth = { ...birth, created: String(birth.created) };
  let next = 0;
  return { child, record,
    send(value) { child.stdin.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n'); },
    async row() { const index = next++; return until(() => { if (record.parseError) throw new Error(record.parseError); return record.rows[index]; }, label + ' row ' + index); },
    async ended() {
      await until(() => !alive(child), label + ' exit');
      const table = snapshotProcessTable();
      if (!table || table.some(row => row.pid === birth.pid && row.created === birth.created)) throw new Error('Helper exit identity not confirmed');
      active.delete(child); record.exitCode = child.exitCode; record.signalCode = child.signalCode;
      return record.exitCode;
    },
    async close() { if (alive(child)) child.stdin.end(); return this.ended(); },
  };
}
async function features(w) {
  w.send({ id: 1, version: 1, op: 'session.features' });
  const value = await w.row();
  if (value.id !== 1 || value.ok !== true || value.executionReceiptVersion !== 1 || value.worker_pid !== w.child.pid || !/^[a-f0-9]{32}$/.test(value.worker_id)) throw new Error('Feature negotiation failed');
  return value;
}
async function entered(w, feature, extra = '') {
  const payload = { id: 2, version: 1, op: 'mouse.position', _ruyi_receipt: { schema: 1, invocation_id: token(), operation_id: token(), worker_id: feature.worker_id } };
  const raw = JSON.stringify(payload); w.send(raw + '\n' + extra);
  const row = await w.row();
  check(row.receipt?.phase === 'handler_entered' && row.receipt.frame_sha256 === sha(raw)
    && row.receipt.worker_pid === w.child.pid && row.receipt.worker_id === feature.worker_id && row.receipt.op === payload.op
    && row.receipt.invocation_id === payload._ruyi_receipt.invocation_id && row.receipt.operation_id === payload._ruyi_receipt.operation_id
    && row.id === 2 && row.receipt.frame_id === 2 && /^[a-f0-9]{32}$/.test(row.receipt.challenge), w.record.label + ' entry binds actual body, worker, operation and exact raw frame');
  return { row, continueFrame: { id: 2, receipt: { ...row.receipt, phase: 'continue' } } };
}
(async () => {
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_NATIVE_RECEIPT_REQUIRED !== '1') { console.log('SKIP opt-in native receipt transport qualification'); return; }
    helper = process.env.RUYI_NATIVE_RECEIPT_HELPER;
    if (!helper || !fs.existsSync(helper)) throw new Error('A candidate receipt helper must be explicit');
    if (!snapshotProcessTable()?.some(row => row.pid === process.pid)) throw new Error('Build the owned-process helper first');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-native-receipts-'));
    const a = await worker('legacy'), fa = await features(a);
    a.send({ id: 2, version: 1, op: 'mouse.position' }); const legacy = await a.row();
    check(legacy.ok === true && legacy.protocolVersion === 1 && legacy.receipt === undefined, 'legacy request still returns a single ordinary terminal');
    check(await a.close() === 0 && a.record.rows.length === 2, 'legacy clean EOF exits zero with no extra receipt rows');
    const b = await worker('committed'), fb = await features(b);
    check(fa.worker_id !== fb.worker_id, 'worker incarnation changes across helper processes');
    const e = await entered(b, fb);
    const entryFile = path.join(root, 'qualified-entry.json');
    const fd = fs.openSync(entryFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(e.row)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    check(JSON.parse(fs.readFileSync(entryFile, 'utf8')).receipt.challenge === e.row.receipt.challenge, 'test entry is file-fsynced before the matching continue is sent');
    b.send(e.continueFrame); const terminal = await b.row();
    check(terminal.ok === true && terminal.receipt?.phase === 'terminal' && terminal.receipt.challenge === e.row.receipt.challenge,
      'committed continue permits the actual read-only query and correlated terminal');
    check(await b.close() === 0, 'committed worker has clean EOF cleanup');
    for (const mode of ['wrong-challenge', 'withheld', 'eof', 'prefetched-business']) {
      const w = await worker(mode), feature = await features(w);
      const extra = mode === 'prefetched-business' ? JSON.stringify({ id: 3, version: 1, op: 'mouse.position' }) + '\n' : '';
      const value = await entered(w, feature, extra);
      if (mode === 'wrong-challenge') w.send({ id: 2, receipt: { ...value.continueFrame.receipt, challenge: token() } });
      if (mode === 'eof') w.child.stdin.end();
      const result = await w.row();
      check(result.ok === false && result.code === 'execution_receipt_failed' && result.action_sent === false && result.outcome === 'not_dispatched', mode + ' refuses this body after entry');
      check(await w.ended() !== 0, mode + ' worker closes instead of reusing a stale confirmation');
    }
    const bad = await worker('wrong-worker'), feature = await features(bad);
    bad.send({ id: 2, version: 1, op: 'mouse.position', _ruyi_receipt: { schema: 1, invocation_id: token(), operation_id: token(), worker_id: token() } });
    const refused = await bad.row(); check(refused.ok === false && refused.receipt === undefined && feature.worker_id !== refused.worker_id, 'wrong worker binding is rejected before body entry');
    check(await bad.ended() !== 0, 'wrong worker closes the protocol session');
    for (const [label, data, expected] of [['oversized', 'x'.repeat(65537) + '\n', 65], ['truncated', '{"id":2', 70]]) {
      const w = await worker(label); w.send(data); w.child.stdin.end();
      check(await w.ended() === expected && w.record.rows.length === 0, label + ' input retains its nonzero framing exit');
    }
  } catch (error) { retained = true; t.fail(error.stack || String(error)); }
  finally {
    for (const child of active) {
      if (alive(child)) {
        try { child.stdin.end(); await until(() => !alive(child), 'remaining worker EOF', 5000); }
        catch { const receipt = killOwnTree(child); records.push({ emergencyCleanup: receipt }); if (receipt.incomplete || receipt.skipped) retained = true; }
      }
    }
    const evidence = process.env.RUYI_NATIVE_RECEIPT_EVIDENCE;
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ helper, helperSha256: helper && fs.existsSync(helper) ? sha(fs.readFileSync(helper)) : null, records, retained, retainedRoot: retained ? root : null }, null, 2) + '\n'); }
    if (root && !retained) fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
