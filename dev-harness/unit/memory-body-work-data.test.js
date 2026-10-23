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
  const functions = ['fmVal', 'memoryGlobalDir', 'projectKeyForCwd', 'memoryProjectDir', 'fmBool', 'cleanMemoryDate', 'memoryBodyScope', 'memoryBodyStore', 'memoryBodyAuthority', 'readMemoryDir', 'readMemoryItem', 'saveMemory', 'migrateMemory', 'renderAgentInstructionMemory', 'writeAgentInstructionEntries', 'inspectAgentInstructionEntries'];
  const context = { require, Buffer, crypto, path, process, fsp: io, WorkDataStore: store, paths: { memory: dir }, SKILL_ID_RE: /^[A-Za-z0-9_-]{1,64}$/, MEMORY_TYPES: new Set(['preference','convention','lesson','reference']), MEMORY_HEAD_CACHE: new Map(), MEMORY_HEAD_CACHE_MAX: 2000, MEMORY_METADATA_READ_CAP: 16 * 1024, CORE_MEMORY_SUMMARY_CAP: 520,
    memoryBodyIsWorkDataError: error => String(error?.code || '').startsWith('work_data'), readConfig: async () => ({ workDataEncryptionV1: state.enabled }), nowIso: () => '2026-10-23T00:00:00.000Z', makeId: () => 'mem_synthetic', writeMemoryMeta: async () => {}, mutateMemoryUsageState: async callback => callback({}), planAgentInstructionEntries: () => state.plan, sha256Hex: text => crypto.createHash('sha256').update(text).digest('hex'),
    atomicWriteJson: async (...args) => { state.writes++; if (state.failWrite) throw state.failWrite; return fx.atomicWriteJson(...args); },
  };
  const code = functions.map(name => functionBlock(read('06d-memory-domain.js'), name)).concat(['stripLeadingBom','foldFrontmatterBlock','parseFrontmatter','firstParaDesc'].map(name => functionBlock(read('12-tool-dispatch.js'), name)));
  code.forEach(part => assert.ok(part.length > 20)); const api = vm.runInNewContext(code.join('\n') + '\n({' + functions.join(',') + '})', context);
  return { ...api, context, state, dir, fx, store, file: id => path.join(dir, 'global', id + '.md'), projectFile: (cwd,id) => path.join(api.memoryProjectDir(cwd),id+'.md') };
}
const input = (id='one', body='MEMORY-PRIVATE😀') => ({ id, scope:'global', name:'Name', description:'Description', type:'reference', body });
const privateError = error => String(error?.code || '').startsWith('work_data');

test('OFF keeps generated Markdown bytes, prior metadata and warm header memo with zero key access', async () => {
  const f=fixture(); await f.saveMemory(input(), f.dir); const original=fs.readFileSync(f.file('one'),'utf8');
  assert.equal(original,'---\nname: Name\ndescription: Description\ntype: reference\ncreatedAt: 2026-10-23T00:00:00.000Z\nupdatedAt: 2026-10-23T00:00:00.000Z\ncore: false\nimportance: normal\ncoreSummary: Description\n---\n\nMEMORY-PRIVATE😀\n');
  assert.equal((await f.readMemoryItem('one','global',f.dir)).memory.body,'MEMORY-PRIVATE😀\n');
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
