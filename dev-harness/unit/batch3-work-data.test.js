'use strict';
// M3-2d batch 3: engine-transcript-index and steward-memory. Both are read-modify-write stores, so the
// test pins the H1 property as hard as the happy path: a read that failed must never lead to a write of
// the empty in-memory result over the sealed file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdbatch3-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['recordEngineTranscript', 'stewardMutateMemory', 'workDataKeys', 'readConfig', 'writeConfig']);
const ledgerFile = path.join(HOME_DIR, 'engine-transcripts.json');
const memoryFile = path.join(HOME_DIR, 'steward', 'memory-v1.json');
const setSwitch = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on === true; await api.writeConfig(config); };
const keyFile = path.join(HOME_DIR, 'work-data-key-v1.json');
const withKeyAway = async fn => {
  api.workDataKeys.clear();
  fs.renameSync(keyFile, keyFile + '.bak');
  try { await fn(); } finally { fs.renameSync(keyFile + '.bak', keyFile); }
};

if (process.platform !== 'win32') {
  test('work-data store sealing needs DPAPI', { skip: 'Windows DPAPI only' }, () => {});
} else {
  test('engine transcript ledger: plaintext when off, sealed when on', async () => {
    await setSwitch(false);
    await api.recordEngineTranscript('sess_ledger0001', 'C:/work');
    const plain = fs.readFileSync(ledgerFile, 'utf8');
    assert.equal(plain.includes('"workData"'), false);
    assert.equal(JSON.parse(plain).known.sess_ledger0001.cwd, 'C:/work');
    // Byte-for-byte with the pre-M3-2d writer (pretty JSON, no invented schema key, no trailing newline).
    assert.equal(plain, JSON.stringify({ version: 1, known: { sess_ledger0001: { cwd: 'C:/work', firstSeen: JSON.parse(plain).known.sess_ledger0001.firstSeen } } }, null, 2));

    await setSwitch(true);
    await api.workDataKeys.ensure();
    await api.recordEngineTranscript('sess_ledger0002', 'C:/work2');
    const sealed = fs.readFileSync(ledgerFile, 'utf8');
    assert.equal(JSON.parse(sealed).workData, 2);
    assert.equal(sealed.includes('sess_ledger0002'), false);
  });

  test('engine transcript ledger: a missing key freezes writes instead of overwriting', async () => {
    const before = fs.readFileSync(ledgerFile, 'utf8');
    await withKeyAway(async () => {
      await api.recordEngineTranscript('sess_ledger0003', 'C:/work3').catch(() => {});
      assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before, 'the sealed ledger is untouched');
    });
  });

  test('steward memory: plaintext when off, sealed when on, and it round-trips', async () => {
    await setSwitch(false);
    const off = await api.stewardMutateMemory(store => {
      store.entries.push({ id: 'm-off', text: '记忆一', state: 'active', at: new Date().toISOString() });
      return { persist: true, result: 'ok' };
    });
    assert.equal(off, 'ok');
    const plain = fs.readFileSync(memoryFile, 'utf8');
    assert.equal(plain.includes('"workData"'), false);
    assert.equal(plain.includes('记忆一'), true);
    assert.equal(plain, JSON.stringify(JSON.parse(plain), null, 2), 'switch off keeps the legacy pretty JSON bytes');

    await setSwitch(true);
    await api.workDataKeys.ensure();
    const on = await api.stewardMutateMemory(store => {
      store.entries.push({ id: 'm-on', text: '记忆二', state: 'active', at: new Date().toISOString() });
      return { persist: true, result: 'ok' };
    });
    assert.equal(on, 'ok');
    const sealed = fs.readFileSync(memoryFile, 'utf8');
    assert.equal(JSON.parse(sealed).workData, 2);
    assert.equal(sealed.includes('记忆二'), false);
  });

  test('steward memory: a missing key rejects the mutation and leaves the file alone', async () => {
    const before = fs.readFileSync(memoryFile, 'utf8');
    await withKeyAway(async () => {
      await assert.rejects(() => api.stewardMutateMemory(store => {
        store.entries.push({ id: 'm-fail', text: '不该落盘', state: 'active', at: new Date().toISOString() });
        return { persist: true, result: 'ok' };
      }), error => String(error.code).startsWith('work_data'));
      assert.equal(fs.readFileSync(memoryFile, 'utf8'), before, 'the sealed memory file is untouched');
    });
  });
}
