'use strict';
// Actual generated runtime, cold instances and real Windows DPAPI. All data is synthetic.
const path = require('node:path'), repo = process.env.RUYI_DERIVED_INDEX_REPO || process.cwd();
require(path.join(repo, 'dev-harness/lib/self-isolate-home'));
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-derived-index-e2e-'));
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const t = require(path.join(repo, 'dev-harness/lib/harness')).createRunner('DERIVED INDEX WORK DATA');
const { loadServerInternals } = require(path.join(repo, 'dev-harness/lib/server-internals'));
const names = ['createSession', 'saveSession', 'loadSession', 'readConfig', 'mutateConfig', 'workDataKeys', 'paths',
  'searchSessionsByContent', 'sessionSearchIndexPath', 'readSessionSearchIndex', 'sessionSearchIndexStore', 'sessionSearchRows',
  'getPretenderProjectionIndex', 'pretenderIndexRuntime', 'pretenderIndexPath', 'readPretenderIndexDisk', 'writePretenderIndexFile',
  'sessionWriteChains', 'flushSessionIndex', 'sessionBodyPaths'];
const runtimes = [], load = () => { const api = loadServerInternals(names); runtimes.push(api); return api; };
const privateError = error => String(error && error.code || '').startsWith('work_data');
const mode = (api, flag) => api.mutateConfig(config => { config.workDataEncryptionV1 = flag; return {}; });
const settle = async api => { await Promise.all([...api.sessionWriteChains.values()].map(p => p.catch(() => {}))); await api.flushSessionIndex(); await api.pretenderIndexRuntime.writeChain; };
const stopTimers = api => { clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer); };

(async () => {
  const api = load(); await mode(api, false);
  const session = await api.createSession({ cwd: root, title: 'Synthetic derived metadata' });
  session.messages = [{ role: 'user', content: 'LEGACY_SEARCH_NEEDLE 在这里' }];
  await api.saveSession(session); await settle(api);
  assert.ok((await api.searchSessionsByContent('LEGACY_SEARCH_NEEDLE', 5)).results.some(row => row.id === session.id));
  const plainSearch = fs.readFileSync(api.sessionSearchIndexPath(), 'utf8');
  assert.equal(plainSearch, JSON.stringify(JSON.parse(plainSearch)));
  const offProjection = await api.getPretenderProjectionIndex();
  await api.writePretenderIndexFile(offProjection);
  const plainProjection = fs.readFileSync(api.pretenderIndexPath(), 'utf8');
  assert.equal(plainProjection, JSON.stringify(JSON.parse(plainProjection)));
  t.ok(true, 'OFF search and projection retain compact JSON and working content search');
  if (process.platform !== 'win32') { console.log('SKIP encrypted index DPAPI lifecycle: Windows only'); return; }

  await mode(api, true); await api.workDataKeys.ensure();
  session.messages.push({ role: 'user', content: 'ENCRYPTED_SEARCH_NEEDLE 新增加密内容' },
    ...Array.from({ length: 750 }, (_, i) => ({ role: 'assistant', content: 'private-body-' + i + ':' + '中'.repeat(650) })));
  session.title = 'PRIVATE_DERIVED_TITLE';
  await api.saveSession(session); await settle(api);
  const bodyFile = api.sessionBodyPaths(session.id).messages;
  assert.ok(fs.statSync(bodyFile).size > 1048576);
  assert.equal((await api.sessionSearchRows(session.id)).length, session.messages.length);
  const found = await api.searchSessionsByContent('ENCRYPTED_SEARCH_NEEDLE', 5);
  assert.ok(found.results.some(row => row.id === session.id));
  const searchBytes = fs.readFileSync(api.sessionSearchIndexPath());
  assert.equal(JSON.parse(searchBytes.toString('utf8').split('\n')[0]).purpose, 'search-index');
  assert.equal(searchBytes.includes(Buffer.from('ENCRYPTED_SEARCH_NEEDLE')), false);
  const projection = await api.getPretenderProjectionIndex(); await api.writePretenderIndexFile(projection);
  assert.ok(projection.sessions.some(row => row.sessionId === session.id));
  const projectionBytes = fs.readFileSync(api.pretenderIndexPath());
  assert.equal(JSON.parse(projectionBytes.toString('utf8').split('\n')[0]).purpose, 'search-index');
  assert.equal(projectionBytes.includes(Buffer.from('PRIVATE_DERIVED_TITLE')), false);
  t.ok(true, 'real DPAPI seals both derived indexes; mixed and large encrypted session bodies remain searchable');

  stopTimers(api); const cold = load();
  assert.ok((await cold.searchSessionsByContent('ENCRYPTED_SEARCH_NEEDLE', 5)).results.some(row => row.id === session.id));
  assert.ok((await cold.getPretenderProjectionIndex()).sessions.some(row => row.sessionId === session.id));
  await settle(cold); stopTimers(cold);
  const coldSearch = fs.readFileSync(cold.sessionSearchIndexPath()), coldProjection = fs.readFileSync(cold.pretenderIndexPath()), bodyBefore = fs.readFileSync(bodyFile);
  const keyFile = path.join(cold.paths.data, 'work-data-key-v1.json');
  for (const runtime of runtimes) runtime.workDataKeys.clear();
  fs.renameSync(keyFile, keyFile + '.missing');
  try {
    await assert.rejects(cold.readSessionSearchIndex, privateError);
    await assert.rejects(cold.readSessionSearchIndex, privateError);
    await assert.rejects(() => cold.getPretenderProjectionIndex(), privateError);
    await assert.rejects(() => cold.sessionSearchRows(session.id), privateError);
    assert.deepEqual(fs.readFileSync(cold.sessionSearchIndexPath()), coldSearch);
    assert.deepEqual(fs.readFileSync(cold.pretenderIndexPath()), coldProjection);
    assert.deepEqual(fs.readFileSync(bodyFile), bodyBefore);
  } finally { fs.renameSync(keyFile + '.missing', keyFile); }
  t.ok(true, 'a cold instance restores indexes; warm key loss rejects search/projection/body reads without mutation');

  await mode(cold, false);
  assert.ok((await cold.searchSessionsByContent('ENCRYPTED_SEARCH_NEEDLE', 5)).results.some(row => row.id === session.id));
  await assert.rejects(() => cold.sessionSearchIndexStore().write(JSON.stringify({ version: 2, entries: {} })), privateError);
  assert.equal(await cold.writePretenderIndexFile({ ...(await cold.readPretenderIndexDisk()), builtAt: 'must-not-downgrade' }), false);
  assert.deepEqual(fs.readFileSync(cold.sessionSearchIndexPath()), coldSearch);
  assert.deepEqual(fs.readFileSync(cold.pretenderIndexPath()), coldProjection);
  t.ok(true, 'OFF continues to read sealed data with its key and refuses plaintext index downgrade');

  await mode(cold, true);
  fs.writeFileSync(cold.sessionSearchIndexPath(), coldSearch.subarray(0, coldSearch.length - 12));
  const damaged = fs.readFileSync(cold.sessionSearchIndexPath());
  await assert.rejects(cold.readSessionSearchIndex, privateError);
  await assert.rejects(() => cold.searchSessionsByContent('ENCRYPTED_SEARCH_NEEDLE', 5), privateError);
  assert.deepEqual(fs.readFileSync(cold.sessionSearchIndexPath()), damaged);
  fs.writeFileSync(cold.sessionSearchIndexPath(), coldSearch);
  fs.writeFileSync(cold.pretenderIndexPath(), coldSearch);
  await assert.rejects(cold.readPretenderIndexDisk, privateError);
  assert.deepEqual(fs.readFileSync(cold.pretenderIndexPath()), coldSearch);
  fs.writeFileSync(cold.pretenderIndexPath(), coldProjection);
  t.ok(true, 'truncated and cross-record index ciphertext fails closed and is never rebuilt over unreadable authority');
})().catch(error => t.fail(error && error.stack || String(error))).finally(async () => {
  for (const api of runtimes) { stopTimers(api); await settle(api); stopTimers(api); api.workDataKeys.clear(); }
  assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('ruyi-derived-index-e2e-'));
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});
