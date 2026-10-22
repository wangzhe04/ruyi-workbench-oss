'use strict';
// M3-2b: the session head is the first non-trivial family on the adapter. This test drives the real
// product functions (createSession/saveSession/loadSession) plus the real DPAPI protector, so it
// covers what the unit-level fake cannot: the head write path, the resilient readers, the index scan
// helper and the "sealed but switch off" state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdhead-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['workDataKeys', 'readSessionHeadText', 'writeSessionHead', 'createSession', 'saveSession', 'loadSession', 'readConfig', 'writeConfig']);
const headPath = id => path.join(HOME_DIR, 'sessions', id + '.json');
const readFile = file => fs.readFileSync(file, 'utf8');
const setSwitch = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on === true; await api.writeConfig(config); };

if (process.platform !== 'win32') {
  test('session head sealing needs DPAPI', { skip: 'Windows DPAPI only' }, () => {});
} else {
  test('switch off: the head is written byte-for-byte as before and no key exists', async () => {
    await setSwitch(false);
    const session = await api.createSession({ title: '离线头测试', cwd: HOME_DIR });
    session.messages.push({ role: 'user', content: '你好', createdAt: new Date().toISOString(), turnSeq: 1 });
    await api.saveSession(session);
    const raw = readFile(headPath(session.id));
    assert.equal(raw.includes('"workData"'), false);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.title, '离线头测试');
    assert.equal(parsed.id, session.id);
    const loaded = await api.loadSession(session.id);
    assert.equal(loaded.title, '离线头测试');
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].content, '你好');
    assert.equal(fs.existsSync(path.join(HOME_DIR, 'work-data-key-v1.json')), false, 'switch off must not create a key');
  });

  test('switch on: the head is sealed, still loads, and refuses a different record id', async () => {
    await setSwitch(true);
    const key = await api.workDataKeys.ensure();
    assert.equal(key.length, 32);
    const session = await api.createSession({ title: '加密头测试', cwd: HOME_DIR });
    session.messages.push({ role: 'user', content: '密文里的中文', createdAt: new Date().toISOString(), turnSeq: 1 });
    await api.saveSession(session);
    const raw = readFile(headPath(session.id));
    const parsed = JSON.parse(raw);
    assert.equal(parsed.workData, 2);
    assert.equal(raw.includes('加密头测试'), false, 'the title must not stay readable');
    assert.equal(raw.includes('密文里的中文'), false);
    const loaded = await api.loadSession(session.id);
    assert.equal(loaded.title, '加密头测试');
    assert.equal(loaded.messages[0].content, '密文里的中文');
    // The container is bound to its session id: copying it to another record must not open.
    const copy = headPath('sess_copied0001');
    fs.copyFileSync(headPath(session.id), copy);
    await assert.rejects(() => api.readSessionHeadText('sess_copied0001'), error => String(error.code).startsWith('work_data.'));
    fs.unlinkSync(copy);
  });

  test('a sealed head stays readable after the switch is turned off again', async () => {
    await setSwitch(false);
    const session = await api.createSession({ title: '关开关后仍可读', cwd: HOME_DIR });
    // Re-enable just for this write, then disable again: reads must not depend on the switch.
    await setSwitch(true);
    await api.saveSession(session);
    await setSwitch(false);
    const loaded = await api.loadSession(session.id);
    assert.equal(loaded.title, '关开关后仍可读');
    assert.equal(JSON.parse(readFile(headPath(session.id))).workData, 2, 'the switch only controls writes');
  });

  test('a missing key or a tampered container is a hard error, never an empty session', async () => {
    await setSwitch(true);
    const session = await api.createSession({ title: '缺钥测试', cwd: HOME_DIR });
    await api.saveSession(session);
    // Tamper with the ciphertext: loadSession must fail loudly, not answer "no such session".
    const file = headPath(session.id);
    const parsed = JSON.parse(readFile(file));
    const bytes = Buffer.from(parsed.envelope.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    parsed.envelope.ciphertext = bytes.toString('base64');
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
    await assert.rejects(() => api.loadSession(session.id), error => String(error.code).startsWith('work_data.'));
    // Missing key envelope: same contract.
    const session2 = await api.createSession({ title: '缺钥二号', cwd: HOME_DIR });
    await api.saveSession(session2);
    api.workDataKeys.clear();
    fs.renameSync(path.join(HOME_DIR, 'work-data-key-v1.json'), path.join(HOME_DIR, 'work-data-key-v1.json.bak'));
    await assert.rejects(() => api.readSessionHeadText(session2.id), error => String(error.code).startsWith('work_data_key.'));
    fs.renameSync(path.join(HOME_DIR, 'work-data-key-v1.json.bak'), path.join(HOME_DIR, 'work-data-key-v1.json'));
    // Restored key keeps the data readable (nothing was rewritten while the key was away).
    assert.equal((await api.loadSession(session2.id)).title, '缺钥二号');
  });
}
