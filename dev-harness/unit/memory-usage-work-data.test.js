'use strict';
// M3-2d batch 2: memory usage accounting on the whole-file adapter. Three properties:
//   off   -> the same pretty JSON the old atomicWriteJson path wrote;
//   on    -> sealed, and readMemoryUsageState still returns the entries;
//   broken-> a decrypt failure is an ERROR (never an empty state), because the writer would otherwise
//            overwrite the sealed file with "{}" on its next touch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdusage-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['readMemoryUsageState', 'touchMemoryUsage', 'mutateMemoryUsageState', 'workDataKeys', 'readConfig', 'writeConfig']);
const usageFile = path.join(HOME_DIR, 'memory', '_usage-v1.json');
const setSwitch = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on === true; await api.writeConfig(config); };
const entry = { id: 'm1', scope: 'global' };
const touch = () => api.touchMemoryUsage([entry], HOME_DIR, 'relevant');
const bump = () => api.mutateMemoryUsageState(entries => { const prev = entries['global:m1'] || { useCount: 0 }; entries['global:m1'] = { ...prev, useCount: (prev.useCount || 0) + 1, lastUsedAt: new Date().toISOString(), lastImplicitUseAt: '' }; return true; });

if (process.platform !== 'win32') {
  test('memory usage sealing needs DPAPI', { skip: 'Windows DPAPI only' }, () => {});
} else {
  test('switch off: the usage file is the same pretty JSON as before', async () => {
    await setSwitch(false);
    await touch();
    const text = fs.readFileSync(usageFile, 'utf8');
    assert.equal(text.includes('"workData"'), false);
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2));
    const state = await api.readMemoryUsageState();
    assert.equal(state.entries['global:m1'].useCount, 1);
  });

  test('switch on: sealed, and the reader still returns the entries', async () => {
    await setSwitch(true);
    await api.workDataKeys.ensure();
    await bump();   // touchMemoryUsage 有防抖，用 mutate 强制一次写
    const text = fs.readFileSync(usageFile, 'utf8');
    assert.equal(JSON.parse(text).workData, 2);
    assert.equal(text.includes('global:m1'), false, 'the key must not stay readable');
    const state = await api.readMemoryUsageState();
    assert.equal(state.entries['global:m1'].useCount, 2);
  });

  test('a missing key is an error, and the next touch does not overwrite the sealed file', async () => {
    const before = fs.readFileSync(usageFile, 'utf8');
    const keyFile = path.join(HOME_DIR, 'work-data-key-v1.json');
    api.workDataKeys.clear();
    fs.renameSync(keyFile, keyFile + '.bak');
    try {
      await assert.rejects(() => api.readMemoryUsageState(), error => String(error.code).startsWith('work_data'));
      await touch();   // the write chain swallows the failure, but must not touch the file
      assert.equal(fs.readFileSync(usageFile, 'utf8'), before, 'the sealed file is untouched');
    } finally { fs.renameSync(keyFile + '.bak', keyFile); }
    const state = await api.readMemoryUsageState();
    assert.equal(state.entries['global:m1'].useCount, 2);
  });

  test('the cursor family is wired through the adapter (structural lock)', () => {
    const { constBlock } = require('../lib/source-slice');
    const src = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/13i-steward-inbox.js'), 'utf8');
    const store = constBlock(src, 'stewardCursorStore');
    assert.match(store, /WorkDataStore\.createText\(/);
    assert.match(store, /recordId: 'steward-cursor'/);
    assert.match(src, /const text = await stewardCursorStore\.read\(\)/);
    assert.match(src, /await stewardCursorStore\.write\(JSON\.stringify\(\{/);
    assert.doesNotMatch(src, /atomicWriteJson\(stewardCursorPath\(\)/);
  });
}
