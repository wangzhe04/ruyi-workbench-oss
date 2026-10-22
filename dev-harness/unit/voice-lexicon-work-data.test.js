'use strict';
// M3-2d: the first whole-file JSON family wired through createJson. Byte-compat when off, sealed when
// on, and a failed write never silently degrades to plaintext.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdlexicon-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['voiceLexiconRead', 'voiceLexiconUpdate', 'workDataKeys', 'readConfig', 'writeConfig']);
const file = path.join(HOME_DIR, 'voice-lexicon.json');
const setSwitch = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on === true; await api.writeConfig(config); };
const addTerm = state => ({ ...state, terms: { ...(state.terms || {}), '测试词条': { term: '测试词条', n: 1, at: '2026-10-22T00:00:00.000Z' } } });

if (process.platform !== 'win32') {
  test('voice lexicon sealing needs DPAPI', { skip: 'Windows DPAPI only' }, () => {});
} else {
  test('switch off: the lexicon stays a plain pretty JSON file', async () => {
    await setSwitch(false);
    const state = await api.voiceLexiconUpdate(addTerm);
    assert.equal(state.terms['测试词条'].term, '测试词条');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('"workData"'), false);
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2));
    assert.equal(JSON.parse(text).terms['测试词条'].term, '测试词条');
    const read = await api.voiceLexiconRead();
    assert.equal(read.terms['测试词条'].term, '测试词条');
  });

  test('switch on: the lexicon is sealed and still round-trips', async () => {
    await setSwitch(true);
    await api.workDataKeys.ensure();
    const state = await api.voiceLexiconUpdate(addTerm);
    assert.equal(state.terms['测试词条'].term, '测试词条');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(text).workData, 2);
    assert.equal(text.includes('测试词条'), false, 'the term must not stay readable');
    const read = await api.voiceLexiconRead();
    assert.equal(read.terms['测试词条'].term, '测试词条');
  });

  test('switch off with sealed data: reads still work and writes are refused instead of downgrading', async () => {
    await setSwitch(false);
    const read = await api.voiceLexiconRead();
    assert.equal(read.terms['测试词条'].term, '测试词条', 'reads do not depend on the switch');
    const before = fs.readFileSync(file, 'utf8');
    // Turning the switch off must never rewrite a sealed record as plaintext: the write is refused
    // until M3-3 migrates the data (fail closed, and the sealed bytes stay untouched).
    await assert.rejects(() => api.voiceLexiconUpdate(state => ({ ...state, learn: false })), error => error.code === 'work_data_store.downgrade_refused');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the sealed file is untouched');
    assert.equal(JSON.parse(before).workData, 2);
  });

  test('a missing key is a hard error on write, never a plaintext fallback', async () => {
    await setSwitch(true);
    const keyFile = path.join(HOME_DIR, 'work-data-key-v1.json');
    const before = fs.readFileSync(file, 'utf8');
    api.workDataKeys.clear();
    fs.renameSync(keyFile, keyFile + '.bak');
    try { await assert.rejects(() => api.voiceLexiconUpdate(state => ({ ...state, learn: true })), error => /^(work_data|voice\.lexicon_unreadable)/.test(String(error.code))); }
    finally { fs.renameSync(keyFile + '.bak', keyFile); }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the failed write left the sealed file untouched');
  });
}
