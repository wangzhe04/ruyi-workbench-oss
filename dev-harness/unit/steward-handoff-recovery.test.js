'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/steward-handoff-recovery.js')).href;
const row = id => ({ attemptId: 'recovery-' + id, sessionId: 'sess-same-title-' + id, text: '原话\n新任务:保持标点。', attachments: [{ id: 'upload-1', name: '新表.csv' }] });
const storage = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }; };
test('reload recovers independent attempts including text and upload identity; settlement removes only its own row', async () => {
  const { createHandoffRecoveryStore } = await import(moduleUrl), disk = storage();
  const first = createHandoffRecoveryStore(disk); first.put(row('0001')); first.put(row('0002'));
  const reload = createHandoffRecoveryStore(disk);
  assert.deepEqual(reload.list(), [row('0001'), row('0002')]);
  reload.remove(row('0001').attemptId); assert.deepEqual(reload.list(), [row('0002')]);
});
test('full, corrupt and unavailable storage never silently discard unresolved records', async () => {
  const { createHandoffRecoveryStore } = await import(moduleUrl), disk = storage(), cache = createHandoffRecoveryStore(disk);
  for (let i = 0; i < 20; i++) cache.put(row(String(i).padStart(4, '0')));
  assert.throws(() => cache.put(row('0021'))); assert.equal(cache.list().length, 20);
  const broken = { getItem: () => '{broken', setItem: () => assert.fail('must not overwrite corrupt records') };
  assert.throws(() => createHandoffRecoveryStore(broken).put(row('0001')));
  assert.throws(() => createHandoffRecoveryStore({ getItem: () => null, setItem() { throw new Error('quota'); } }).put(row('0001')));
});
