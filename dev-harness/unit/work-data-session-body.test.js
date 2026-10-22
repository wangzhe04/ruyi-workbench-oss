'use strict';
// M3-2c-2: the messages/provider bodies are append-only NDJSON with line hashes, byte-offset truncation
// and crash windows. This drives the real product functions (createSession/saveSession/loadSession) with
// the real DPAPI key so the four risky behaviours are measured, not assumed:
//   1. switch off  = byte-identical plaintext lines;
//   2. switch on   = every line is a per-record envelope and still loads;
//   3. torn tail   = truncated at a record boundary, the rest still loads;
//   4. missing key = a hard error, and neither the body nor the head is renamed to .corrupt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdbody-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['workDataKeys', 'createSession', 'saveSession', 'loadSession', 'readConfig', 'writeConfig', 'readSessionBodyFile']);
const bodyPath = (id, kind = 'messages') => path.join(HOME_DIR, 'sessions', `${id}.${kind}.ndjson`);
const headPath = id => path.join(HOME_DIR, 'sessions', id + '.json');
const readBody = (id, kind) => fs.readFileSync(bodyPath(id, kind), 'utf8');
const lines = text => text.split('\n').filter(Boolean);
const setSwitch = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on === true; await api.writeConfig(config); };
const message = (text, turnSeq = 1) => ({ role: 'user', content: text, createdAt: new Date().toISOString(), turnSeq });

if (process.platform !== 'win32') {
  test('session body sealing needs DPAPI', { skip: 'Windows DPAPI only' }, () => {});
} else {
  test('switch off: body lines stay plain JSON, byte-identical to the old writer', async () => {
    await setSwitch(false);
    const session = await api.createSession({ title: '正文-明文', cwd: HOME_DIR });
    session.messages.push(message('第一条'));
    await api.saveSession(session);
    const text = readBody(session.id);
    assert.equal(text.includes('"w":2'), false);
    assert.equal(lines(text)[0], JSON.stringify(JSON.parse(text.split('\n')[0])));
    assert.equal(JSON.parse(text.split('\n')[0]).content, '第一条');
    const loaded = await api.loadSession(session.id);
    assert.deepEqual(loaded.messages.map(m => m.content), ['第一条']);
  });

  test('switch on: every body line is a record, appends continue the ordinals, and it still loads', async () => {
    await setSwitch(true);
    await api.workDataKeys.ensure();
    const session = await api.createSession({ title: '正文-加密', cwd: HOME_DIR });
    session.messages.push(message('第一条密文'));
    await api.saveSession(session);
    // A second and third save exercise the fast append path (ordinals continue from the line count).
    session.messages.push({ role: 'assistant', content: '第二条密文', createdAt: new Date().toISOString(), turnSeq: 1 });
    await api.saveSession(session);
    session.messages.push(message('第三条密文', 2));
    await api.saveSession(session);
    const body = readBody(session.id);
    const rows = lines(body);
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(JSON.parse(row).w, 2);
    assert.equal(body.includes('密文'), false, 'the body must not keep the plaintext');
    const loaded = await api.loadSession(session.id);
    assert.deepEqual(loaded.messages.map(m => m.content), ['第一条密文', '第二条密文', '第三条密文']);
  });

  test('a torn tail is truncated at a record boundary and the rest still loads', async () => {
    const session = await api.createSession({ title: '正文-撕裂', cwd: HOME_DIR });
    session.messages.push(message('完整一行'));
    await api.saveSession(session);
    fs.appendFileSync(bodyPath(session.id), '{"w":2,"e":{"version":2', 'utf8');   // no trailing newline
    const loaded = await api.loadSession(session.id);
    assert.deepEqual(loaded.messages.map(m => m.content), ['完整一行']);
    const after = readBody(session.id);
    assert.equal(after.endsWith('\n'), true, 'the file ends on a record boundary');
    assert.equal(lines(after).length, 1, 'the torn fragment is gone');
  });

  test('a missing key makes the body a hard error and never renames the files to .corrupt', async () => {
    const session = await api.createSession({ title: '正文-缺钥', cwd: HOME_DIR });
    session.messages.push(message('还在盘上'));
    await api.saveSession(session);
    api.workDataKeys.clear();
    const keyFile = path.join(HOME_DIR, 'work-data-key-v1.json');
    fs.renameSync(keyFile, keyFile + '.bak');
    try {
      // The sealed head fails first (same work_data class); the body reader must report "locked", not
      // "corrupt" — otherwise loadSession would quarantine both files and the data would be gone.
      await assert.rejects(() => api.loadSession(session.id), error => String(error.code).startsWith('work_data'));
      const body = await api.readSessionBodyFile(bodyPath(session.id));
      assert.equal(body && body.locked, true, 'the body reader reports locked');
      assert.equal(body && body.corrupt, undefined);
      assert.equal(fs.existsSync(bodyPath(session.id) + '.corrupt'), false);
      assert.equal(fs.existsSync(headPath(session.id) + '.corrupt'), false);
    } finally {
      fs.renameSync(keyFile + '.bak', keyFile);
    }
    const loaded = await api.loadSession(session.id);
    assert.deepEqual(loaded.messages.map(m => m.content), ['还在盘上']);
  });

  test('a body written before enabling stays readable, and later appends are sealed', async () => {
    await setSwitch(false);
    const session = await api.createSession({ title: '正文-混合', cwd: HOME_DIR });
    session.messages.push(message('启用前'));
    await api.saveSession(session);
    await setSwitch(true);
    session.messages.push(message('启用后', 2));
    await api.saveSession(session);
    const rows = lines(readBody(session.id));
    assert.equal(rows.length, 2);
    assert.equal(JSON.parse(rows[0]).w, undefined, 'the first line stays legacy plaintext');
    assert.equal(JSON.parse(rows[1]).w, 2, 'the appended line is sealed');
    const loaded = await api.loadSession(session.id);
    assert.deepEqual(loaded.messages.map(m => m.content), ['启用前', '启用后']);
  });

  test('a full rewrite after an edit re-seals every line from ordinal 0', async () => {
    const session = await api.createSession({ title: '正文-重写', cwd: HOME_DIR });
    session.messages.push(message('一'), message('二', 1));
    await api.saveSession(session);
    session.messages[0].content = '一（已编辑）';   // breaks the prefix → slow path full rewrite
    await api.saveSession(session);
    const rows = lines(readBody(session.id));
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(JSON.parse(row).w, 2);
    assert.equal(readBody(session.id).includes('已编辑'), false);
    const loaded = await api.loadSession(session.id);
    assert.deepEqual(loaded.messages.map(m => m.content), ['一（已编辑）', '二']);
  });
}
