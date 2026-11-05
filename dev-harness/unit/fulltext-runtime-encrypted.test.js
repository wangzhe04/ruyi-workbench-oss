'use strict';
// Runtime evidence for the three fulltext surfaces: with work-data encryption on,
// the production index writes sealed carriers and never leaves plaintext rows.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const sid = 'Sess_Runtime_Encrypted';
test('runtime fulltext index writes sealed state, manifest and shards', async t => {
  const producer = await fixture({ enabled: true });
  t.after(() => producer.close());
  await producer.put(sid, [{ id: 'm_runtime', role: 'user', turnSeq: 1, content: 'RUNTIME_PRIVATE_FULLTEXT' }], { head: { title: 'runtime', providerHistoryCount: 0 } });
  await producer.index.step(1, {});
  const root = path.join(producer.sessions, '_fulltext-index-v1');
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else files.push(full); } };
  walk(root);
  assert.ok(files.length >= 2, 'state plus at least one manifest/shard file');
  const names = files.map(file => path.relative(root, file).replace(/\\/g, '/'));
  assert.ok(names.includes('state.json'));
  assert.ok(names.some(name => name.endsWith('/manifest.json')));
  assert.ok(names.some(name => /\/[a-f0-9]{32}\.0\.json$/.test(name)));
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const first = JSON.parse(bytes.toString('utf8').split('\n')[0]);
    assert.equal(first.workData, 3, `${path.relative(root, file)} is a sealed carrier`);
    assert.equal(bytes.includes(Buffer.from('RUNTIME_PRIVATE_FULLTEXT')), false, `${path.relative(root, file)} has no plaintext`);
  }
});
