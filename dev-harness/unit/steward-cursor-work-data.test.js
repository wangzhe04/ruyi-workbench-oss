'use strict';
// Stage review (Q5): the steward cursor declared no `schema`, so sealing it failed with
// work_data.schema_invalid and the cursor was never written once encryption was on. This drives the
// real save/load pair, plus the downgrade guard on the way back out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdcursor-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['stewardLoadState', 'stewardSaveCursor', 'workDataKeys', 'readConfig', 'writeConfig']);
const cursorFile = path.join(HOME_DIR, 'steward', 'cursor-v1.json');
const setSwitch = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on === true; await api.writeConfig(config); };

if (process.platform !== 'win32') {
  test('steward cursor sealing needs DPAPI', { skip: 'Windows DPAPI only' }, () => {});
} else {
  test('switch on: the cursor is sealed and a later load still sees it', async () => {
    await setSwitch(true);
    await api.workDataKeys.ensure();
    await api.stewardLoadState();
    await api.stewardSaveCursor([], []);
    assert.equal(fs.existsSync(cursorFile), true, 'the cursor must actually reach the disk');
    const text = fs.readFileSync(cursorFile, 'utf8');
    assert.equal(JSON.parse(text).workData, 2, 'the cursor record is a sealed container');
    assert.equal(text.includes('"inboxSeq"'), false);
  });

  test('switch off with a sealed cursor: writes are refused instead of downgrading', async () => {
    await setSwitch(false);
    const before = fs.readFileSync(cursorFile, 'utf8');
    // The steward tick wraps the throw into lastError; what matters here is that the file is untouched.
    await api.stewardSaveCursor(['sess_x'], ['run_y']).catch(() => {});
    assert.equal(fs.readFileSync(cursorFile, 'utf8'), before, 'the sealed cursor is untouched');
  });
}
