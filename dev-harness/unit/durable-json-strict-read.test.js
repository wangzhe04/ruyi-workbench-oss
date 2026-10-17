'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { constBlock } = require('../lib/source-slice');
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/01-config.js'), 'utf8');
function fixture() {
  let content, error, writes = 0, copies = 0;
  const read = () => { if (error) throw error; if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return content; };
  const context = vm.createContext({ fs: { readFileSync: read, copyFileSync() { copies++; } },
    fsp: { readFile: async () => read(), mkdir: async () => {} }, path,
    atomicWriteJson: async (_file, value) => { writes++; if (error) throw error; content = JSON.stringify(value); } });
  vm.runInContext(constBlock(source, 'DurableJsonStore') + ';globalThis.storeApi=DurableJsonStore;', context);
  const create = extra => context.storeApi.create({ id: 'strict', file: 'state.json', schemaVersion: 1,
    defaultValue: () => ({ schema: 1, entries: [] }), cache: false, strictRead: true,
    validate: value => Array.isArray(value.entries) && value.entries.every(row => typeof row === 'string'), ...extra });
  return { create, set: value => { content = value; }, error: value => { error = value; }, counts: () => ({ writes, copies }) };
}
test('strict read permits a missing initial file without writing, but rejects malformed/schema-less/unknown/invalid state without quarantine or fallback', async () => {
  const f = fixture(); const store = f.create();
  assert.equal(JSON.stringify(await store.read()), '{"schema":1,"entries":[]}');
  assert.equal(JSON.stringify(store.readSync()), '{"schema":1,"entries":[]}');
  for (const value of ['{', '[]', '{"entries":[]}', '{"schema":2,"entries":[]}', '{"schema":1,"entries":[null]}']) {
    f.set(value); await assert.rejects(store.read()); assert.throws(() => store.readSync());
  }
  assert.deepEqual(f.counts(), { writes: 0, copies: 0 });
});
test('strict read rejects transient failures and retries the real file next time; default stores retain their recovery behavior', async () => {
  const f = fixture(); const store = f.create();
  f.set('{"schema":1,"entries":["known"]}');
  for (const code of ['EACCES', 'EBUSY', 'EMFILE']) {
    f.error(Object.assign(new Error('unreadable'), { code })); await assert.rejects(store.read(), { code }); assert.throws(() => store.readSync(), { code });
    f.error(null); assert.equal(JSON.stringify(await store.read()), '{"schema":1,"entries":["known"]}');
  }
  f.set('{'); const old = f.create({ strictRead: false });
  assert.equal(JSON.stringify(await old.read()), '{"schema":1,"entries":[]}');
  assert.equal(f.counts().copies, 1);
});
test('a failed strict uncached write cannot become a committed inbox or dedupe record on the next read', async () => {
  const f = fixture(); const store = f.create(); f.set('{"schema":1,"entries":["committed"]}');
  f.error(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  await assert.rejects(store.write({ schema: 1, entries: ['uncommitted'] }), { code: 'ENOSPC' });
  f.error(null); assert.equal(JSON.stringify(await store.read()), '{"schema":1,"entries":["committed"]}');
});
