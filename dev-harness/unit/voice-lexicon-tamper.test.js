'use strict';
// Review finding H1 (data loss): a reader that swallows a decrypt failure turns "unreadable" into
// "empty", and the very next update writes that empty state over the ciphertext. This drives the real
// product functions to prove both halves: the read rejects, and the update refuses without touching a
// single byte of the undecryptable file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdlex-tamper-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['voiceLexiconRead', 'voiceLexiconUpdate', 'workDataKeys', 'readConfig', 'writeConfig']);
const file = path.join(HOME_DIR, 'voice-lexicon.json');
const setSwitch = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on === true; await api.writeConfig(config); };

if (process.platform !== 'win32') {
  test('voice lexicon tamper handling needs DPAPI', { skip: 'Windows DPAPI only' }, () => {});
} else {
  test('a tampered container is never read as an empty lexicon, and never overwritten', async () => {
    await setSwitch(true);
    await api.workDataKeys.ensure();
    await api.voiceLexiconUpdate(state => ({ ...state, learn: true }));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.workData, 2);
    parsed.keyId = parsed.keyId.slice(0, -1) + (parsed.keyId.endsWith('1') ? '2' : '1');
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
    const tampered = fs.readFileSync(file, 'utf8');
    await assert.rejects(() => api.voiceLexiconRead(), error => String(error.code).startsWith('work_data'));
    await assert.rejects(() => api.voiceLexiconUpdate(state => ({ ...state, learn: false })),
      error => /^(work_data|voice\.lexicon_unreadable)/.test(String(error.code)));
    assert.equal(fs.readFileSync(file, 'utf8'), tampered, 'the undecryptable file is left byte-for-byte in place');
  });
}
