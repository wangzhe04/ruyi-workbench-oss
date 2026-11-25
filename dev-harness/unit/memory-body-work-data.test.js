'use strict';
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock, functionBlock } = require('../lib/source-slice'), { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const src = path.resolve(__dirname, '../../ruyi-workbench/app/src'), draft = process.env.RUYI_MEMORY_BODY_SOURCE_DIR || src;
const read = name => fs.readFileSync(fs.existsSync(path.join(draft, name)) ? path.join(draft, name) : path.join(src, name), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-body-unit-')), masters = [];
after(() => { masters.forEach(key => key.fill(0)); assert.ok(path.basename(root).startsWith('ruyi-memory-body-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'memory-')), fx = loadWorkDataChunks();
  const state = { enabled: false, key: crypto.randomBytes(32), instanceId: 'memory-unit', acquires: 0, releases: 0, opens: 0, writes: 0, plan: [] }; masters.push(state.key);
  const io = { ...fsp, open: async (...args) => { state.opens++; return fsp.open(...args); } };
  const store = vm.runInNewContext(constBlock(read('01p-work-data-store.js'), 'WorkDataStore') + '\nWorkDataStore;', { require, Buffer, WorkDataCrypto: fx.crypto, WorkDataChunks: fx.chunks });
  store.Hooks.keys = { snapshot: async () => { state.acquires++; if (state.missing) throw Object.assign(new Error('missing'), { code: 'work_data_key.absent' }); const key = Buffer.from(state.key); return { key, instanceId: state.instanceId, release: () => { state.releases++; key.fill(0); } }; } };
  const functions = ['memoryMapLimit', 'memoryRegistryShared', 'memoryStatIsRacy', 'fmVal', 'memoryGlobalDir', 'projectKeyForCwd', 'memoryProjectDir', 'fmBool', 'cleanMemoryDate', 'memoryBodyScope', 'memoryBodyStore', 'memoryBodyAuthority', 'readMemoryDir', 'readMemoryItem', 'saveMemory', 'migrateMemory', 'renderAgentInstructionMemory', 'writeAgentInstructionEntries', 'inspectAgentInstructionEntries'];
  const context = { require, Buffer, crypto, path, process, fsp: io, WorkDataStore: store, paths: { memory: dir }, SKILL_ID_RE: /^[A-Za-z0-9_-]{1,64}$/, MEMORY_TYPES: new Set(['preference','convention','lesson','reference']), MEMORY_HEAD_CACHE: new Map(), MEMORY_HEAD_CACHE_MAX: 2000, MEMORY_ENTRY_STAT: new WeakMap(), MEMORY_DIR_IO_CONCURRENCY: 8, memoryLibraryWriteGeneration: 0, MEMORY_SNAPSHOT_RACY_MS: 0, MEMORY_METADATA_READ_CAP: 16 * 1024, CORE_MEMORY_SUMMARY_CAP: 520,
    memoryBodyIsWorkDataError: error => String(error?.code || '').startsWith('work_data'), readConfig: async () => ({ workDataEncryptionV1: state.enabled }), nowIso: () => '2026-10-23T00:00:00.000Z', makeId: () => 'mem_synthetic', writeMemoryMeta: async () => {}, mutateMemoryUsageState: async callback => callback({}), planAgentInstructionEntries: () => state.plan, sha256Hex: text => crypto.createHash('sha256').update(text).digest('hex'),
    atomicWriteJson: async (...args) => { state.writes++; if (state.failWrite) throw state.failWrite; return fx.atomicWriteJson(...args); },
  };
  const code = functions.map(name => functionBlock(read('06d-memory-domain.js'), name)).concat(['stripLeadingBom','foldFrontmatterBlock','parseFrontmatter','firstParaDesc'].map(name => functionBlock(read('12-tool-dispatch.js'), name)));
  code.forEach(part => assert.ok(part.length > 20)); const api = vm.runInNewContext(code.join('\n') + '\n({' + functions.join(',') + '})', context);
  return { ...api, context, state, dir, fx, store, file: id => path.join(dir, 'global', id + '.md'), projectFile: (cwd,id) => path.join(api.memoryProjectDir(cwd),id+'.md') };
}
const input = (id='one', body='MEMORY-PRIVATE😀') => ({ id, scope:'global', name:'Name', description:'Description', type:'reference', body });
const privateError = error => String(error?.code || '').startsWith('work_data');

// A fresh NTFS timestamp can be ahead of Date.now(). Set only the test VM's
// read clock, at a known distance from the newest real file timestamp.
function setFileReadTime(f, offsetMs, ...ids) {
  const stamps = ids.map(id => {
    const { mtimeMs, ctimeMs } = fs.statSync(f.file(id));
    return Math.max(mtimeMs, ctimeMs);
  });
  const nowMs = Math.floor(Math.max(...stamps)) + offsetMs;
  f.context.Date = class extends Date { static now() { return nowMs; } };
  return nowMs;
}

test('OFF keeps generated Markdown bytes, prior metadata and warm header memo with zero key access', async () => {
  const f=fixture(); await f.saveMemory(input(), f.dir); const original=fs.readFileSync(f.file('one'),'utf8');
  assert.equal(original,'---\nname: Name\ndescription: Description\ntype: reference\ncreatedAt: 2026-10-23T00:00:00.000Z\nupdatedAt: 2026-10-23T00:00:00.000Z\ncore: false\nimportance: normal\ncoreSummary: Description\n---\n\nMEMORY-PRIVATE😀\n');
  assert.equal((await f.readMemoryItem('one','global',f.dir)).memory.body,'MEMORY-PRIVATE😀\n');
  setFileReadTime(f, 1, 'one');
  assert.equal((await f.readMemoryDir(f.memoryGlobalDir(),'global')).get('one').name,'Name'); const opens=f.state.opens;
  assert.equal((await f.readMemoryDir(f.memoryGlobalDir(),'global')).size,1); assert.equal(f.state.opens,opens); assert.equal(f.state.acquires,0);
});

test('Markdown literal workData snippets survive OFF and sealed reads; other text hosts retain fail-closed marker rules', async () => {
  const f=fixture(), body='Documentation\n```json\n{"workData":3,"ciphertext":"example"}\n```';
  await f.saveMemory(input('markers',body),f.dir); assert.ok((await f.readMemoryItem('markers','global',f.dir)).memory.body.includes(body));
  f.state.enabled=true; await f.saveMemory(input('markers',body),f.dir); assert.ok(!fs.readFileSync(f.file('markers'),'utf8').includes('Documentation')); assert.ok((await f.readMemoryItem('markers','global',f.dir)).memory.body.includes(body));
  const file=path.join(f.dir,'default.txt');await fsp.writeFile(file,'Description: "workData":2');
  const plain=f.store.createText({file:()=>file,purpose:'memory',schema:1,scopeId:'global',recordId:'default',enabled:async()=>false,writeJson:f.fx.atomicWriteJson});
  await assert.rejects(plain.read(),{code:'work_data_store.corrupt'});await assert.rejects(()=>plain.write('new'),{code:'work_data_store.corrupt'});
});

test('encrypted registry checks 260KiB plaintext admission, decrypts full record, then uses only the original 16KiB metadata window', async () => {
  const f=fixture(); f.state.enabled=true; const body='x'.repeat(250*1024);assert.equal((await f.saveMemory(input('large',body),f.dir)).ok,true);
  assert.ok(fs.statSync(f.file('large')).size>260*1024); assert.equal((await f.readMemoryDir(f.memoryGlobalDir(),'global')).get('large').description,'Description');
  const tooBig='---\nname: outside\n---\n'+'x'.repeat(261*1024); await f.memoryBodyStore(f.memoryGlobalDir(),'outside').write(tooBig);
  assert.equal((await f.readMemoryDir(f.memoryGlobalDir(),'global')).has('outside'),false); assert.equal((await f.readMemoryItem('outside','global',f.dir)).ok,true,'the registry cap never becomes a new direct-item read cap');
});

test('sealed and ON-plain warm memo never bypass current key/instance authority', async () => {
  for(const initiallySealed of [false,true]){
    const f=fixture();f.state.enabled=initiallySealed;await f.saveMemory(input(),f.dir);f.state.enabled=true;await f.readMemoryDir(f.memoryGlobalDir(),'global');const original=fs.readFileSync(f.file('one'));
    f.state.missing=true;await assert.rejects(()=>f.readMemoryDir(f.memoryGlobalDir(),'global'),{code:'work_data_key.absent'});assert.ok(fs.readFileSync(f.file('one')).equals(original));f.state.missing=false;
    f.state.instanceId='another-instance';if(initiallySealed)await assert.rejects(()=>f.readMemoryDir(f.memoryGlobalDir(),'global'),privateError);else assert.equal((await f.readMemoryDir(f.memoryGlobalDir(),'global')).size,1);
  }
});

test('missing keys, truncated headers and bad sealed blocks cannot become absence or be overwritten by save/import', async () => {
  const f=fixture();f.state.enabled=true;await f.saveMemory(input(),f.dir);const original=fs.readFileSync(f.file('one'));
  f.state.missing=true;await assert.rejects(()=>f.readMemoryItem('one','global',f.dir),{code:'work_data_key.absent'});await assert.rejects(()=>f.saveMemory(input('one','new'),f.dir),{code:'work_data_key.absent'});assert.ok(fs.readFileSync(f.file('one')).equals(original));f.state.missing=false;
  for(const invalid of ['{"workData":3,"ciphertext":','{"workData":2,"ciphertext":']){
    await fsp.writeFile(f.file('one'),invalid);await assert.rejects(()=>f.readMemoryItem('one','global',f.dir),privateError);await assert.rejects(()=>f.saveMemory(input('one','new'),f.dir),privateError);assert.equal(fs.readFileSync(f.file('one'),'utf8'),invalid);
  }
  await fsp.writeFile(f.file('one'),original);const lines=original.toString('utf8').trimEnd().split('\n');lines[1]=lines[1].slice(0,-4);const bad=lines.join('\n')+'\n';await fsp.writeFile(f.file('one'),bad);await assert.rejects(()=>f.readMemoryDir(f.memoryGlobalDir(),'global'),privateError);assert.equal(fs.readFileSync(f.file('one'),'utf8'),bad);
});

test('scope and filename identities bind records, and migration re-seals before deleting its source', async () => {
  const f=fixture();f.state.enabled=true;const from=path.join(f.dir,'old-workspace'),to=path.join(f.dir,'new-workspace');await f.saveMemory({...input('move'),scope:'project'},from);
  const source=f.projectFile(from,'move'),before=fs.readFileSync(source);await fsp.mkdir(f.memoryProjectDir(to),{recursive:true});await fsp.writeFile(f.projectFile(to,'copied'),before);
  await assert.rejects(()=>f.readMemoryItem('copied','project',to),privateError);await fsp.unlink(f.projectFile(to,'copied'));
  assert.equal((await f.migrateMemory('move',f.projectKeyForCwd(from),to)).ok,true);assert.equal(fs.existsSync(source),false);assert.ok((await f.readMemoryItem('move','project',to)).memory.body.includes('MEMORY-PRIVATE'));
  await f.saveMemory({...input('fail'),scope:'project'},from);const sourceFail=f.projectFile(from,'fail'),prior=fs.readFileSync(sourceFail);f.state.failWrite=Object.assign(new Error('disk full'),{code:'ENOSPC'});await assert.rejects(()=>f.migrateMemory('fail',f.projectKeyForCwd(from),to),{code:'ENOSPC'});assert.ok(fs.readFileSync(sourceFail).equals(prior));assert.equal(fs.existsSync(f.projectFile(to,'fail')),false);
});

test('agent instruction imports hash decrypted content and preserve imported identity under sealing', async () => {
  const f=fixture();f.state.enabled=true;f.state.plan=[{id:'agentmd-test-1',name:'imported',description:'source',core:true,coreSummary:'summary',part:'1/1',body:'IMPORTED-PRIVATE'}];
  const result=await f.writeAgentInstructionEntries({key:'test'}, {file:'synthetic.md',hash:'hash'},'synthetic.md');assert.equal((await f.inspectAgentInstructionEntries(result)).modified,0);assert.ok(!fs.readFileSync(f.file('agentmd-test-1'),'utf8').includes('IMPORTED-PRIVATE'));
  f.state.missing=true;await assert.rejects(()=>f.inspectAgentInstructionEntries(result),{code:'work_data_key.absent'});
});

test('150 S3: sealed headers hit the head cache while file identity and key authority are unchanged; ctime-only rewrites re-authenticate and reject altered chunk ciphertext', async () => {
  const f=fixture();f.state.enabled=true;
  const ids=['s-one','s-two','s-three'];
  for(const id of ids)await f.saveMemory(input(id,'SEALED-'+id),f.dir);
  setFileReadTime(f, 1, ...ids);
  const dir=f.memoryGlobalDir(),first=await f.readMemoryDir(dir,'global');assert.deepEqual([...first.keys()],fs.readdirSync(dir).filter(name=>name.endsWith('.md')).map(name=>name.slice(0,-3)),'readdir order is kept under bounded concurrency');
  assert.ok(!fs.readFileSync(f.file('s-one'),'utf8').includes('SEALED-s-one'),'fixture is really sealed');
  const opens=f.state.opens,second=await f.readMemoryDir(dir,'global');
  assert.equal(f.state.opens,opens,'unchanged sealed files are served from the head cache (no reopen/decrypt)');
  assert.equal(second.get('s-two'),first.get('s-two'));
  // Same bytes rewritten with the original mtime restored: size and mtime match, ctime does not -> re-authenticated.
  // mtime is pinned to a whole second first (utimes cannot restore sub-ms precision), so only ctime differs.
  const file=f.file('s-two'),whole=new Date(Math.floor(fs.statSync(file).mtimeMs/1000)*1000);fs.utimesSync(file,whole,whole);
  setFileReadTime(f, 1, ...ids);
  await f.readMemoryDir(dir,'global');const pinnedOpens=f.state.opens,bytes=fs.readFileSync(file);
  async function rewriteWithNewCtime(content) {
    const before = fs.statSync(file);
    const deadline = performance.now() + 3000;
    for (;;) {
      await fsp.writeFile(file, content);
      await fsp.utimes(file, whole, whole);
      const after = fs.statSync(file);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
      if (after.ctimeMs !== before.ctimeMs) break;
      assert.ok(performance.now() < deadline, 'fixture needs a distinct ctime for this rewrite');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    setFileReadTime(f, 1, ...ids);
  }
  await rewriteWithNewCtime(bytes);
  await f.readMemoryDir(dir,'global');assert.equal(f.state.opens,pinnedOpens+1,'a ctime-only change re-reads exactly that sealed file');
  // Tampered ciphertext of identical size is never served from the cache.
  const lines = bytes.toString('utf8').split('\n');
  const chunk = JSON.parse(lines[1]);
  const ciphertext = Buffer.from(chunk.e.envelope.ciphertext, 'base64');
  assert.ok(ciphertext.length > 0);
  ciphertext[0] ^= 1;
  chunk.e.envelope.ciphertext = ciphertext.toString('base64');
  lines[1] = JSON.stringify(chunk);
  await rewriteWithNewCtime(Buffer.from(lines.join('\n')));
  await assert.rejects(() => f.readMemoryDir(dir, 'global'), { code: 'work_data_chunk.authenticate_failed' });
  fs.writeFileSync(file,bytes);
  // A different key instance invalidates every cached sealed header before any cached plaintext is used.
  f.state.instanceId='rotated-instance';await assert.rejects(()=>f.readMemoryDir(dir,'global'),privateError);
  f.state.instanceId='memory-unit';f.state.missing=true;await assert.rejects(()=>f.readMemoryDir(dir,'global'),{code:'work_data_key.absent'});
  // A missing directory stays the zero-cost empty result: no key access, no throw, even with the key absent.
  const acquires=f.state.acquires;assert.equal((await f.readMemoryDir(path.join(f.dir,'no-such-dir'),'global')).size,0);assert.equal(f.state.acquires,acquires);
});
test('2A review F1: with the encryption toggle OFF a cached sealed header still needs the current key; a missing key throws instead of serving cached plaintext', async () => {
  const f=fixture();f.state.enabled=true;await f.saveMemory(input('sealed-off','SEALED-OFF-BODY'),f.dir);
  assert.ok(!fs.readFileSync(f.file('sealed-off'),'utf8').includes('SEALED-OFF-BODY'),'fixture is really sealed');
  f.state.enabled=false;const dir=f.memoryGlobalDir();
  setFileReadTime(f, 1, 'sealed-off');
  const first=(await f.readMemoryDir(dir,'global')).get('sealed-off');
  assert.equal(first.name,'Name','toggle off, key present: the sealed file is still readable');
  const opens=f.state.opens;
  assert.equal((await f.readMemoryDir(dir,'global')).get('sealed-off'),first,'toggle off, same key: reuse the authenticated entry');
  assert.equal(f.state.opens,opens,'toggle off, same key: served from the head cache');
  f.state.missing=true;await assert.rejects(()=>f.readMemoryDir(dir,'global'),{code:'work_data_key.absent'},'toggle off, key gone: the cached sealed header is not served');
  f.state.missing=false;f.state.instanceId='other-instance';await assert.rejects(()=>f.readMemoryDir(dir,'global'),privateError,'toggle off, different key: re-authenticated and refused');
  // A plain file under the OFF toggle keeps its zero-key-access cache.
  f.state.instanceId='memory-unit';const plain=fixture();await plain.saveMemory(input('plain-off'),plain.dir);await plain.readMemoryDir(plain.memoryGlobalDir(),'global');
  const acquires=plain.state.acquires;await plain.readMemoryDir(plain.memoryGlobalDir(),'global');assert.equal(plain.state.acquires,acquires,'plain files under OFF never touch the key');
});

test('2A review F3: a file written within the timestamp-granularity window is neither cached nor trusted as a stat baseline', async () => {
  const f=fixture();await f.saveMemory(input('fresh'),f.dir);const dir=f.memoryGlobalDir();
  const settledTime=setFileReadTime(f, 1, 'fresh');
  f.context.MEMORY_SNAPSHOT_RACY_MS=60*60*1000; // every file counts as "just written"
  let wholeReads=0;const realReadFile=f.context.fsp.readFile;f.context.fsp.readFile=async(...args)=>{wholeReads++;return realReadFile(...args);};
  const first=await f.readMemoryDir(dir,'global'),reads=wholeReads;await f.readMemoryDir(dir,'global');
  assert.equal(wholeReads,reads+1,'racy file is re-read in full (content fingerprint), not served from the head cache');
  assert.match(String(f.context.MEMORY_ENTRY_STAT.get(first.get('fresh'))),/^racy:[a-f0-9]{64}$/,'racy file gets a content-hash baseline, never a stat-identity one');
  assert.equal(f.memoryStatIsRacy({mtimeMs:settledTime-10,ctimeMs:settledTime-10}),true);
  f.context.MEMORY_SNAPSHOT_RACY_MS=0;
  const settled=(await f.readMemoryDir(dir,'global')).get('fresh'),settledOpens=f.state.opens;
  assert.equal((await f.readMemoryDir(dir,'global')).get('fresh'),settled);
  assert.equal(f.state.opens,settledOpens,'outside the window the header is cached again');
  assert.equal(f.memoryStatIsRacy({mtimeMs:settledTime-10,ctimeMs:0}),false,'window 0 trusts past stamps');
  setFileReadTime(f, -1, 'fresh');
  const beforeFuture=wholeReads, future=(await f.readMemoryDir(dir,'global')).get('fresh');
  assert.equal(wholeReads,beforeFuture+1,'a future stamp bypasses even a warmed cache');
  assert.match(f.context.MEMORY_ENTRY_STAT.get(future),/^racy:[a-f0-9]{64}$/);
});
