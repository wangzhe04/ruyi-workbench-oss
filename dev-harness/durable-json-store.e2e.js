'use strict';
// 103c: fault-injection contract for the composable small-JSON lifecycle.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-durable-json-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
const srv = require(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));

let failures = 0;
function ok(value, label) {
  if (value) console.log('PASS ' + label);
  else { failures++; console.error('FAIL ' + label); }
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

(async () => {
  try {
    const file = path.join(HOME, 'fixture.json');
    const corruptEvents = [];
    const makeStore = () => srv.DurableJsonStore.create({
      id: 'fixture',
      file,
      schemaVersion: 3,
      defaultValue: () => ({ schema: 3, entries: {}, recent: [] }),
      sanitize(value) {
        const entries = value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries) ? value.entries : {};
        for (const [key, item] of Object.entries(entries)) if (!item || !Number.isFinite(Number(item.score))) delete entries[key];
        return { schema: 3, entries, recent: Array.isArray(value.recent) ? value.recent : [] };
      },
      validate: value => value.schema === 3 && value.entries && Array.isArray(value.recent),
      capacity: [{ path: 'entries', max: 2 }, { path: 'recent', max: 2 }],
      onCorrupt: error => corruptEvents.push(error.code || error.name),
    });

    const store = makeStore();
    ok(Object.keys(store.readSync().entries).length === 0 && !fs.existsSync(file), 'missing file returns defaults without an unnecessary rewrite');

    const concurrentWrites = [
      store.write({ entries: { first: { score: 1 } }, recent: [1] }),
      store.write({ entries: { first: { score: 1 }, second: { score: 2 } }, recent: [1, 2] }),
      store.write({ entries: { first: { score: 1 }, second: { score: 2 }, third: { score: 3 } }, recent: [1, 2, 3] }),
    ];
    ok(Object.keys(store.readSync().entries).join(',') === 'second,third', 'write-through cache advances when the newest write is enqueued');
    await Promise.all(concurrentWrites);
    const concurrent = readJson(file);
    ok(concurrent.schema === 3 && Object.keys(concurrent.entries).join(',') === 'second,third' && concurrent.recent.join(',') === '2,3',
      'serialized concurrent writes preserve the latest complete snapshot and apply capacity eviction');
    ok(fs.readdirSync(HOME).filter(name => name.endsWith('.tmp')).length === 0, 'atomic writes leave no temporary orphan');

    fs.writeFileSync(file, JSON.stringify({ schema: 3, entries: { external: { score: 9 } }, recent: [] }));
    ok(!store.readSync().entries.external, 'process cache remains stable until explicit invalidation');
    store.invalidate();
    ok(store.readSync().entries.external.score === 9, 'explicit invalidation observes an external replacement');

    fs.writeFileSync(file, '{"schema":3,"entries":');
    store.invalidate();
    ok(Object.keys(store.readSync().entries).length === 0, 'torn JSON recovers to sanitized defaults');
    ok(fs.readFileSync(file + '.corrupt', 'utf8') === '{"schema":3,"entries":', 'torn JSON is quarantined byte-for-byte');

    fs.writeFileSync(file, JSON.stringify({ schema: 99, entries: {}, recent: [] }));
    store.invalidate();
    ok(store.readSync().schema === 3 && corruptEvents.includes('EDURABLE_SCHEMA'), 'invalid schema is rejected and reported');

    await store.write({ entries: { bad: { score: 'nope' }, good: { score: 4 } }, recent: ['a'] });
    const recovered = readJson(file);
    ok(!recovered.entries.bad && recovered.entries.good.score === 4, 'sanitizer removes malformed entries during recovery write');
    store.invalidate();
    ok(store.readSync().entries.good.score === 4, 'store remains readable after corruption recovery');
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
