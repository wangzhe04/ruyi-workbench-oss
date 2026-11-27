'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const { releaseEnvironment } = require('../lib/release-checks');
const { loadServerInternals } = require('../lib/server-internals');

test('a settings change before the first search after restart removes existing session vectors', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-disabled-restart-'));
  const data = path.join(root, 'data');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), data));
  const prior = await fixture({ directory: data });
  const sid = 'Existing';
  const files = path.join(prior.sessions, '_fulltext-index-v1', sid);
  try {
    await prior.put(sid, [{ id: 'row', role: 'user', content: 'notes on the garden' }]);
    const descriptor = { available: true, modelId: 'embeddinggemma-2-text-q4', modelFingerprint: 'fixture' };
    const encoder = { descriptor: () => descriptor, async encode(texts, options) {
      await options.beforeEncode();
      const vector = Array(768).fill(0);
      vector[0] = 1;
      return { ok: true, modelFingerprint: 'fixture', vectors: texts.map(() => vector) };
    } };
    const formerOwner = vm.runInContext('SessionFullTextIndex', prior.hookContext).create({
      ...prior.host, vectors: true, encoder, backgroundPolicy: async () => ({ semantic: true, index: true }),
    });
    for (let n = 0; n < 10; n++) if (!(await formerOwner.backgroundTick()).again) break;
    assert.ok(fs.existsSync(path.join(files, 'vectors.json')), 'previous owner persisted a vector file');
  } finally { await prior.close(); }

  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    privacyModeV1: 'off', credentialEncryptionV1: false, workDataEncryptionV1: false,
    semanticRetrievalV1: true, sessionSearchIndexV1: true, providers: [], externalMcpServers: [],
    desktopMcp: { enabled: false, autodetect: false }, stewardEnabledV1: false, schedulerEnabledV1: false,
  }));
  const app = loadServerInternals(['readConfig', 'mutateConfig', 'sessionFullTextOwner']);
  assert.equal(app.sessionFullTextOwner, null, 'fresh module has no existing index owner');
  assert.equal((await app.readConfig()).semanticRetrievalV1, true);
  const publication = await app.mutateConfig(config => {
    config.semanticRetrievalV1 = false;
    config.sessionSearchIndexV1 = false;
  });
  assert.ok(publication.ok);
  const file = path.join(files, 'vectors.json');
  const until = Date.now() + 5000;
  while (fs.existsSync(file) && Date.now() < until) await delay(25);
  assert.equal(fs.existsSync(file), false, 'disabling through settings wakes the cleanup without a search');
  assert.ok(fs.existsSync(path.join(files, 'manifest.json')), 'the lexical index is retained');
});
