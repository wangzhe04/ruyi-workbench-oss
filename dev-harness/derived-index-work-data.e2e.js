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
  'sessionWriteChains', 'flushSessionIndex', 'sessionBodyPaths', 'SessionFullTextHooks', 'refreshSessionSearchIndex', 'listSessions', 'WorkDataStore', 'atomicWriteJson'];
const runtimes = [], load = () => { const api = loadServerInternals(names); runtimes.push(api); return api; };
const privateError = error => String(error && error.code || '').startsWith('work_data');
const mode = (api, flag) => api.mutateConfig(config => { config.workDataEncryptionV1 = flag; return {}; });
const settle = async api => { await Promise.all([...api.sessionWriteChains.values()].map(p => p.catch(() => {}))); await api.flushSessionIndex(); await api.pretenderIndexRuntime.writeChain; };
const stopTimers = api => { clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer); };
const callers = new WeakMap(); let fixtureSessionId;
async function scopedSearch(api, query, limit) {
  let caller = callers.get(api);
  if (!caller) { caller = await api.loadSession(fixtureSessionId); assert.equal(caller.id, fixtureSessionId); callers.set(api, caller); }
  return api.SessionFullTextHooks.withModel({ session: caller, turnSeq: caller.turnSeq }, 'threads_search', null,
    () => api.searchSessionsByContent(query, limit));
}
function currentRecords(api, sid) {
  const directory = path.join(api.paths.sessions, '_fulltext-index-v1'), owned = path.join(directory, sid);
  const records = [{ sid: null, name: 'state.json', file: path.join(directory, 'state.json'), max: 1024 },
    { sid, name: 'manifest.json', file: path.join(owned, 'manifest.json'), max: 4 * 1024 * 1024 }];
  for (const name of fs.readdirSync(owned).sort()) if (/^[a-f0-9]{32}\.[0-9]+\.json$/.test(name)) records.push({ sid, name, file: path.join(owned, name), max: 256 * 1024 });
  assert.ok(records.length >= 3, 'current state/manifest/shard families actually exist'); return records;
}
function currentStore(api, row) {
  return api.WorkDataStore.createText({ file: () => row.file, purpose: 'search-index', schema: 1, scopeId: 'sessions',
    recordId: 'fulltext-index:' + (row.sid ? row.sid + ':' : '') + row.name.replace(/\.json$/, ''),
    chunked: true, maxPlaintextBytes: row.max, keys: api.workDataKeys,
    enabled: async () => (await api.readConfig()).workDataEncryptionV1 === true, writeJson: api.atomicWriteJson });
}
const snapshotCurrent = rows => new Map(rows.map(row => [row.file, fs.readFileSync(row.file)]));
const unchangedCurrent = before => { for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes); };
function assertOriginalReference(found, sid) {
  const hit = found.results.find(row => row.id === sid); assert.ok(hit); assert.equal(hit.reference.sessionId, sid);
  assert.equal(hit.reference.messageId, 'encrypted_search_source'); assert.equal(hit.reference.source, 'content');
  assert.equal(hit.reference.coordinate, 'utf16'); assert.equal(hit.reference.matchStart, 0); assert.equal(hit.reference.matchEnd, 'ENCRYPTED_SEARCH_NEEDLE'.length);
  assert.equal(found.coverage.complete, true); assert.equal(found.scope.sampling, false);
}

(async () => {
  const api = load(); await mode(api, false);
  const session = await api.createSession({ cwd: root, title: 'Synthetic derived metadata' });
  fixtureSessionId = session.id;
  session.messages = [{ id: 'legacy_search_source', role: 'user', content: 'LEGACY_SEARCH_NEEDLE 在这里' }];
  await api.saveSession(session); await settle(api);
  assert.ok((await scopedSearch(api, 'LEGACY_SEARCH_NEEDLE', 5)).results.some(row => row.id === session.id));
  await api.refreshSessionSearchIndex(await api.listSessions()); // Explicit real legacy adapter compatibility, not the production search owner.
  const plainSearch = fs.readFileSync(api.sessionSearchIndexPath(), 'utf8');
  assert.equal(plainSearch, JSON.stringify(JSON.parse(plainSearch)));
  const offProjection = await api.getPretenderProjectionIndex();
  await api.writePretenderIndexFile(offProjection);
  const plainProjection = fs.readFileSync(api.pretenderIndexPath(), 'utf8');
  assert.equal(plainProjection, JSON.stringify(JSON.parse(plainProjection)));
  t.ok(true, 'OFF search and projection retain compact JSON and working content search');
  if (process.platform !== 'win32') { console.log('SKIP encrypted index DPAPI lifecycle: Windows only'); return; }

  await mode(api, true); await api.workDataKeys.ensure();
  session.messages.push({ id: 'encrypted_search_source', role: 'user', content: 'ENCRYPTED_SEARCH_NEEDLE 新增加密内容' },
    ...Array.from({ length: 750 }, (_, i) => ({ role: 'assistant', content: 'private-body-' + i + ':' + '中'.repeat(650) })));
  session.title = 'PRIVATE_DERIVED_TITLE';
  await api.saveSession(session); await settle(api);
  const bodyFile = api.sessionBodyPaths(session.id).messages;
  assert.ok(fs.statSync(bodyFile).size > 1048576);
  assert.equal((await api.sessionSearchRows(session.id)).length, session.messages.length);
  const found = await scopedSearch(api, 'ENCRYPTED_SEARCH_NEEDLE', 5);
  assert.ok(found.results.some(row => row.id === session.id));
  assertOriginalReference(found, session.id);
  await api.refreshSessionSearchIndex(await api.listSessions());
  const searchBytes = fs.readFileSync(api.sessionSearchIndexPath());
  assert.equal(JSON.parse(searchBytes.toString('utf8').split('\n')[0]).purpose, 'search-index');
  assert.equal(searchBytes.includes(Buffer.from('ENCRYPTED_SEARCH_NEEDLE')), false);
  const projection = await api.getPretenderProjectionIndex(); await api.writePretenderIndexFile(projection);
  assert.ok(projection.sessions.some(row => row.sessionId === session.id));
  const projectionBytes = fs.readFileSync(api.pretenderIndexPath());
  assert.equal(JSON.parse(projectionBytes.toString('utf8').split('\n')[0]).purpose, 'search-index');
  assert.equal(projectionBytes.includes(Buffer.from('PRIVATE_DERIVED_TITLE')), false);
  t.ok(true, 'real DPAPI seals both derived indexes; mixed and large encrypted session bodies remain searchable');
  const records = currentRecords(api, session.id), currentSealed = snapshotCurrent(records);
  const sourceHeadBefore = fs.readFileSync(path.join(api.paths.sessions, session.id + '.json'));
  for (const row of records) {
    const bytes = currentSealed.get(row.file), header = JSON.parse(bytes.toString('utf8').split('\n')[0]);
    assert.equal(header.workData, 3); assert.equal(header.purpose, 'search-index'); assert.equal(header.schema, 1); assert.equal(header.scopeId, 'sessions');
    assert.equal(header.recordId, 'fulltext-index:' + (row.sid ? row.sid + ':' : '') + row.name.replace(/\.json$/, ''));
    assert.equal(bytes.includes(Buffer.from('ENCRYPTED_SEARCH_NEEDLE')), false); assert.equal(bytes.includes(Buffer.from('PRIVATE_DERIVED_TITLE')), false);
    assert.equal(typeof await currentStore(api, row).read(), 'string');
  }
  t.ok(true, 'current fulltext state, manifest and every shard use real sealed purpose/schema/scope/record carriers');

  stopTimers(api); const cold = load();
  await cold.readConfig(); // Real boot initializes privacy policy before issuing a disclosure guard.
  assert.ok((await scopedSearch(cold, 'ENCRYPTED_SEARCH_NEEDLE', 5)).results.some(row => row.id === session.id));
  assert.ok((await cold.getPretenderProjectionIndex()).sessions.some(row => row.sessionId === session.id));
  await settle(cold); stopTimers(cold);
  assertOriginalReference(await scopedSearch(cold, 'ENCRYPTED_SEARCH_NEEDLE', 5), session.id);
  unchangedCurrent(currentSealed);
  for (const row of records) assert.equal(typeof await currentStore(cold, row).read(), 'string');
  t.ok(true, 'fresh runtime cold reads current fulltext carriers and original reference without changing index bytes');
  const warmLegacy = await cold.readSessionSearchIndex(); assert.ok(warmLegacy.entries && warmLegacy.entries[session.id]);
  const coldSearch = fs.readFileSync(cold.sessionSearchIndexPath()), coldProjection = fs.readFileSync(cold.pretenderIndexPath()), bodyBefore = fs.readFileSync(bodyFile);
  const keyFile = path.join(cold.paths.data, 'work-data-key-v1.json');
  for (const runtime of runtimes) runtime.workDataKeys.clear();
  fs.renameSync(keyFile, keyFile + '.missing');
  try {
    await assert.rejects(cold.readSessionSearchIndex, privateError);
    await assert.rejects(cold.readSessionSearchIndex, privateError);
    await assert.rejects(() => cold.getPretenderProjectionIndex(), privateError);
    await assert.rejects(() => cold.sessionSearchRows(session.id), privateError);
    await assert.rejects(() => scopedSearch(cold, 'ENCRYPTED_SEARCH_NEEDLE', 5), privateError);
    for (const row of records) await assert.rejects(() => currentStore(cold, row).read(), privateError);
    unchangedCurrent(currentSealed);
    assert.deepEqual(fs.readFileSync(path.join(cold.paths.sessions, session.id + '.json')), sourceHeadBefore);
    assert.deepEqual(fs.readFileSync(cold.sessionSearchIndexPath()), coldSearch);
    assert.deepEqual(fs.readFileSync(cold.pretenderIndexPath()), coldProjection);
    assert.deepEqual(fs.readFileSync(bodyFile), bodyBefore);
  } finally { fs.renameSync(keyFile + '.missing', keyFile); }
  t.ok(true, 'a cold instance restores indexes; warm key loss rejects search/projection/body reads without mutation');

  await mode(cold, false);
  assert.ok((await scopedSearch(cold, 'ENCRYPTED_SEARCH_NEEDLE', 5)).results.some(row => row.id === session.id));
  await assert.rejects(() => cold.sessionSearchIndexStore().write(JSON.stringify({ version: 2, entries: {} })), privateError);
  assert.equal(await cold.writePretenderIndexFile({ ...(await cold.readPretenderIndexDisk()), builtAt: 'must-not-downgrade' }), false);
  assert.deepEqual(fs.readFileSync(cold.sessionSearchIndexPath()), coldSearch);
  assert.deepEqual(fs.readFileSync(cold.pretenderIndexPath()), coldProjection);
  t.ok(true, 'OFF continues to read sealed data with its key and refuses plaintext index downgrade');
  for (const row of records) { const plain = await currentStore(cold, row).read(); await assert.rejects(() => currentStore(cold, row).write(plain), privateError); }
  unchangedCurrent(currentSealed);
  assert.deepEqual(fs.readFileSync(bodyFile), bodyBefore);
  t.ok(true, 'OFF reads existing current fulltext with its key and refuses downgrade of state, manifest and all shards');

  await mode(cold, true);
  fs.writeFileSync(cold.sessionSearchIndexPath(), coldSearch.subarray(0, coldSearch.length - 12));
  const damaged = fs.readFileSync(cold.sessionSearchIndexPath());
  await assert.rejects(cold.readSessionSearchIndex, privateError);
  assertOriginalReference(await scopedSearch(cold, 'ENCRYPTED_SEARCH_NEEDLE', 5), session.id);
  assert.deepEqual(fs.readFileSync(cold.sessionSearchIndexPath()), damaged);
  fs.writeFileSync(cold.sessionSearchIndexPath(), coldSearch);
  const manifest = records.find(row => row.name === 'manifest.json'), manifestBytes = currentSealed.get(manifest.file);
  fs.writeFileSync(manifest.file, manifestBytes.subarray(0, manifestBytes.length - 12));
  const damagedManifest = fs.readFileSync(manifest.file);
  try { await assert.rejects(() => scopedSearch(cold, 'ENCRYPTED_SEARCH_NEEDLE', 5), privateError); assert.deepEqual(fs.readFileSync(manifest.file), damagedManifest); }
  finally { fs.writeFileSync(manifest.file, manifestBytes); }
  fs.writeFileSync(cold.pretenderIndexPath(), coldSearch);
  await assert.rejects(cold.readPretenderIndexDisk, privateError);
  assert.deepEqual(fs.readFileSync(cold.pretenderIndexPath()), coldSearch);
  fs.writeFileSync(cold.pretenderIndexPath(), coldProjection);
  for (const row of [manifest, records.find(row => row.name !== 'state.json' && row.name !== 'manifest.json')]) {
    const original = currentSealed.get(row.file); fs.writeFileSync(row.file, coldSearch);
    try { await assert.rejects(() => scopedSearch(cold, 'ENCRYPTED_SEARCH_NEEDLE', 5), privateError); assert.deepEqual(fs.readFileSync(row.file), coldSearch); }
    finally { fs.writeFileSync(row.file, original); }
  }
  unchangedCurrent(currentSealed); assert.deepEqual(fs.readFileSync(bodyFile), bodyBefore);
  assert.deepEqual(fs.readFileSync(path.join(cold.paths.sessions, session.id + '.json')), sourceHeadBefore);
  t.ok(true, 'truncated and cross-record index ciphertext fails closed and is never rebuilt over unreadable authority');
  t.ok(true, 'current manifest corruption and manifest/shard cross-AAD reject scoped production search without source or index repair');
})().catch(error => t.fail(error && error.stack || String(error))).finally(async () => {
  for (const api of runtimes) { stopTimers(api); await settle(api); stopTimers(api); api.workDataKeys.clear(); }
  assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('ruyi-derived-index-e2e-'));
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});
