'use strict';
// Small-cap source VM regressions: real crypto/gzip/filesystem, synthetic keys,
// no server loading, DPAPI, external provider, or large allocation.
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), vm = require('node:vm');
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), zlib = require('node:zlib');
const repo = process.env.JOURNAL_REPO || path.resolve(__dirname, '../..');
const { constBlock, functionBlock } = require(path.join(repo, 'dev-harness/lib/source-slice'));
const fx = require(path.join(repo, 'dev-harness/lib/work-data-chunks-fixture')).loadWorkDataChunks();
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-journal-admission-'));
const source = name => {
  const draft = path.join(__dirname, 'src', name);
  return fs.readFileSync(fs.existsSync(draft) ? draft : path.join(repo, 'ruyi-workbench/app/src', name), 'utf8');
};
after(() => { assert.equal(path.dirname(root), tempBase); fs.rmSync(root, { recursive: true, force: true }); });
const workError = error => String(error && error.code || '').startsWith('work_data');
function fixture(cap = 1024) {
  const dir = fs.mkdtempSync(path.join(root, 'case-')), state = { enabled: true, leases: 0, releases: 0 };
  const master = crypto.randomBytes(32), keys = { snapshot: async () => {
    state.leases++; const key = Buffer.from(master);
    return { key, instanceId: 'a'.repeat(32), release: () => { state.releases++; key.fill(0); } };
  } };
  const store = vm.runInNewContext(constBlock(source('01p-work-data-store.js'), 'WorkDataStore') + '\nWorkDataStore;', {
    require, Buffer, WorkDataCrypto: fx.crypto, WorkDataChunks: fx.chunks,
  }); store.Hooks.keys = keys;
  const binary = name => store.createBinary({ file: () => path.join(dir, name), keys, purpose: 'session', schema: 1,
    scopeId: 'sid', recordId: name, chunked: true, maxBinaryBytes: cap, maxPlaintextBytes: cap,
    enabled: () => state.enabled, writeJson: fx.atomicWriteJson,
    validateLegacyBinary: bytes => { zlib.gunzipSync(bytes); return true; },
  });
  const names = ['journalArtifactFailure', 'withJournalArtifactOperation', 'journalDir', 'journalIndexPath', 'journalJsonStore', 'journalGzipIdentity',
    'journalGzipStore', 'journalReadBefore', 'journalReadHistory', 'journalAssertWritable', 'journalPreflightIndex', 'journalPreflightMutation',
    'journalReadIndex', 'journalReadIndexForWrite', 'journalWriteIndex', 'journalDropEntriesUnlocked', 'journalRollbackContents'];
  const context = vm.createContext({ require, Buffer, crypto, zlib, path, fs, fsp, WorkDataStore: store,
    readConfig: async () => ({ workDataEncryptionV1: state.enabled }), assertSessionIdForPath: sid => sid,
    paths: { checkpoints: dir }, safeJsonParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
    atomicWriteJson: fx.atomicWriteJson, sessionHeadIsWorkDataError: workError,
    JOURNAL_ARTIFACT_ENGINEERING_BYTES: cap, JOURNAL_MAX_BEFORE_BYTES: 5 * 1024 * 1024, SESSION_HEAD_ADAPTER_SCHEMA: 2,
    sessionPath: sid => path.join(dir, sid, 'head.json'), nowIso: () => new Date(0).toISOString(), journalBytesAdjust: () => {},
    withJournalWriteLock: (sid, work) => work(), journalGc: async () => {},
  });
  const code = names.map(name => { const body = functionBlock(source('02-session-store.js'), name); assert.ok(body, name); return body; }).join('\n');
  const api = vm.runInContext(code + '\nfunction journalRevertLogPath(sid){return path.join(journalDir(sid),"reverts.json");}\n' +
    'function journalRevertLogRead(){return Promise.resolve([]);}\n' + functionBlock(source('10-context-governance.js'), 'writeHistorySnapshot') +
    '\n({' + names.join(',') + ',writeHistorySnapshot})', context);
  return { dir, state, keys, binary, api, store };
}

test('failed gzip cannot hide an intact literal or escaped sealed carrier on read or either write mode', async () => {
  for (const escaped of [false, true]) for (const enabled of [false, true]) {
    const f = fixture(), file = path.join(f.dir, 'before.gz'), store = f.binary('before.gz');
    await store.write(zlib.gzipSync('original'));
    let text = fs.readFileSync(file, 'utf8'); if (escaped) text = text.replace('"workData"', '"\\u0077orkData"');
    const damaged = Buffer.concat([Buffer.from([0x1f, 0x8b, 8]), Buffer.from(text)]); fs.writeFileSync(file, damaged);
    f.state.enabled = enabled;
    await assert.rejects(store.read(), workError);
    await assert.rejects(store.write(zlib.gzipSync('replacement')), workError);
    assert.deepEqual(fs.readFileSync(file), damaged);
  }
});

test('OFF preflight recognizes escaped authenticated index/reverts/head through real bindings before effects', async () => {
  for (const kind of ['index', 'reverts', 'head']) {
    const f = fixture(), dir = path.join(f.dir, 'sid'); fs.mkdirSync(dir);
    const file = path.join(dir, kind + '.json'), head = kind === 'head';
    const store = f.store.createText({ file: () => file, keys: f.keys, purpose: 'session', schema: head ? 2 : 1,
      scopeId: head ? 'sessions' : 'sid', recordId: head ? 'sid' : 'journal-' + kind,
      enabled: () => true, writeJson: fx.atomicWriteJson });
    const value = kind === 'index' ? [] : kind === 'reverts' ? { schema: 1, items: [] } : { id: 'sid', messages: [] };
    await store.write(JSON.stringify(value)); const escaped = fs.readFileSync(file, 'utf8').replace('"workData"', '"\\u0077orkData"');
    fs.writeFileSync(file, escaped); f.state.enabled = false;
    await assert.rejects(f.api.withJournalArtifactOperation(op => f.api.journalAssertWritable('sid', [kind], op)),
      { code: 'work_data.journal_downgrade_refused' });
    assert.equal(fs.readFileSync(file, 'utf8'), escaped); assert.equal(f.state.leases, f.state.releases);
  }
});

test('OFF history and incompressible gzip retain old capacity while ON refuses before replacing authority', async () => {
  const f = fixture(), large = zlib.gzipSync(crypto.randomBytes(1800)); assert.ok(large.length > 1024);
  f.state.enabled = false; const store = f.binary('large.gz'); await store.write(large);
  assert.deepEqual(await store.read(), large); assert.equal(f.state.leases, 0);
  const history = [{ role: 'tool', content: 'ordinary old history'.repeat(300) }];
  assert.equal(await f.api.writeHistorySnapshot('sid', 1, history), 'history:1');
  assert.deepEqual(JSON.parse(JSON.stringify(await f.api.journalReadHistory('sid', 'history-1.json.gz'))), history);
  const old = fs.readFileSync(path.join(f.dir, 'sid', 'history-1.json.gz'));
  f.state.enabled = true; assert.equal(await f.api.writeHistorySnapshot('sid', 1, history), '');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'sid', 'history-1.json.gz')), old);
  await assert.rejects(store.write(zlib.gzipSync('small replacement')), workError);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'large.gz')), large);
});

test('complete valid gzip is never marker-searched even when its legacy history domain shape is bad', async () => {
  const f = fixture(), dir = path.join(f.dir, 'sid'); fs.mkdirSync(dir); f.state.enabled = false;
  const file = path.join(dir, 'history-2.json.gz'), gz = zlib.gzipSync('{"workData":3}', { level: 0 });
  assert.ok(gz.includes(Buffer.from('"workData"'))); fs.writeFileSync(file, gz);
  assert.equal(await f.api.writeHistorySnapshot('sid', 2, [{ role: 'tool', content: 'replacement' }]), 'history:2');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(file))), [{ role: 'tool', content: 'replacement' }]);
  assert.equal(f.state.leases, 0);
});

test('ON oversize compact index refuses drop and rollback before old data changes; OFF old drop remains legal', async () => {
  const f = fixture(), dir = path.join(f.dir, 'sid'); fs.mkdirSync(dir);
  const rows = [{ turnSeq: 1, entrySeq: 0, tool: 'edit', path: 'drop', op: 'modify' },
    { turnSeq: 2, entrySeq: 0, tool: 'edit', path: 'keep', op: 'modify', legacyExtra: 'x'.repeat(3000) }];
  const index = path.join(dir, 'index.json'), before = path.join(dir, '1-0.gz');
  fs.writeFileSync(index, JSON.stringify(rows)); fs.writeFileSync(before, zlib.gzipSync('old original'));
  const originalIndex = fs.readFileSync(index), originalBefore = fs.readFileSync(before);
  const drop = await f.api.withJournalArtifactOperation(op => f.api.journalDropEntriesUnlocked('sid', 1, 'edit', ['drop'], undefined, op));
  assert.equal(drop.ok, false); assert.deepEqual(fs.readFileSync(index), originalIndex); assert.deepEqual(fs.readFileSync(before), originalBefore);
  await assert.rejects(f.api.withJournalArtifactOperation(op => f.api.journalRollbackContents('sid', 1, null, op, null)),
    { code: 'work_data.journal_index_limit' });
  assert.deepEqual(fs.readFileSync(index), originalIndex); assert.deepEqual(fs.readFileSync(before), originalBefore);
  f.state.enabled = false; const off = await f.api.withJournalArtifactOperation(op => f.api.journalDropEntriesUnlocked('sid', 1, 'edit', ['drop'], undefined, op));
  assert.equal(off.ok, true); assert.equal(fs.existsSync(before), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(index)), rows.slice(1));
});
