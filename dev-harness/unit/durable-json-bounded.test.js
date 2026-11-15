'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-durable-bound-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR']) process.env[key] = path.join(root, key);
process.env.RUYI_HOME = path.join(root, 'data'); process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
const { loadServerInternals } = require('../lib/server-internals');
const { DurableJsonStore, atomicWriteJson } = loadServerInternals(['DurableJsonStore', 'atomicWriteJson']);
after(() => fs.rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function store(extra = {}) {
  const file = path.join(root, 'state-' + (++sequence) + '.json');
  return { file, store: DurableJsonStore.create({ id: 'bounded-evidence', file, schemaVersion: 1, cache: false,
    strictRead: true, quarantine: false, maxBytes: 256, canonicalRead: true,
    ownedRegular: process.platform !== 'win32', mode: 0o600,
    defaultValue: () => ({ schema: 1, entries: [] }), validate: value => Array.isArray(value.entries), ...extra }) };
}
async function refuseBoth(item, code) {
  await assert.rejects(item.store.read(), code ? { code } : undefined);
  assert.throws(() => item.store.readSync(), code ? { code } : undefined);
  assert.equal(fs.existsSync(item.file + '.corrupt'), false);
}

test('bounded strict private file roundtrips using the shared store and exact canonical formatter', async () => {
  const item=store(); assert.deepEqual(await item.store.read(), { schema: 1, entries: [] });
  await item.store.write({ schema: 1, entries: ['private-你好'] });
  assert.deepEqual(await item.store.read(), item.store.readSync());
  assert.equal(fs.readFileSync(item.file, 'utf8'), JSON.stringify({ schema: 1, entries: ['private-你好'] }, null, 2));
  if (process.platform !== 'win32') assert.equal(fs.statSync(item.file).mode & 0o777, 0o600);
});
test('read/write capacity refuses while preserving the previously committed state', async () => {
  const item=store(); await item.store.write({ schema: 1, entries: ['committed'] });
  const before=fs.readFileSync(item.file);
  await assert.rejects(item.store.write({ schema: 1, entries: ['x'.repeat(300)] }), { code:'EDURABLE_CAPACITY' });
  assert.ok(fs.readFileSync(item.file).equals(before));
  fs.writeFileSync(item.file, 'x'.repeat(300), { mode:0o600 }); await refuseBoth(item,'EDURABLE_CAPACITY');
});
test('duplicate fields, alternate numeric tokens and discarded whitespace are rejected without normalization', async () => {
  for (const text of ['{"schema":0,"schema":1,"entries":[]}', '{"schema":1,"entries":[]}',
    '{\n  "schema": 1.0,\n  "entries": []\n}', JSON.stringify({ schema:1, entries:[] },null,2)+'\n']) {
    const item=store(); fs.writeFileSync(item.file,text,{ mode:0o600 });
    await refuseBoth(item,'EDURABLE_CANONICAL'); assert.equal(fs.readFileSync(item.file,'utf8'),text);
  }
});
test('invalid UTF-8 is rejected before JSON parsing can replace damaged bytes', async () => {
  const item=store(); fs.writeFileSync(item.file,Buffer.from([123,34,120,34,58,34,255,34,125]),{mode:0o600});
  await refuseBoth(item,'EDURABLE_ENCODING');
});
test('symlinks, hardlinks and nonprivate leaf permissions are refused', { skip:process.platform==='win32' }, async () => {
  const source=store(); await source.store.write({schema:1,entries:[]});
  const link=store(); fs.symlinkSync(source.file,link.file); await refuseBoth(link);
  fs.unlinkSync(link.file); fs.linkSync(source.file,link.file); await refuseBoth(link,'EDURABLE_OWNER');
  fs.unlinkSync(link.file); fs.chmodSync(source.file,0o644); await refuseBoth(source,'EDURABLE_OWNER');
});
test('non-regular files are refused without a blocking read', { skip:process.platform==='win32' }, async () => {
  const item=store(); fs.mkdirSync(item.file,{mode:0o700}); await refuseBoth(item,'EDURABLE_CAPACITY');
});
test('invalid byte bounds cannot accidentally enable an unbounded owned reader', () => {
  for (const maxBytes of [0,-1,NaN,Infinity,1.5,65*1024*1024]) assert.throws(()=>store({maxBytes}));
  assert.throws(()=>store({maxBytes:undefined,ownedRegular:true}));
});

test('ordinary-JSON evidence remains immutable and never invokes inherited hooks during queued write or canonical read', async () => {
  const item=store({ordinaryJson:true}); const value={schema:1,entries:['pending-secret']};
  const expected=JSON.stringify(value,null,2), pending=item.store.write(value);
  const beforeArray=Object.getOwnPropertyDescriptor(Array.prototype,'toJSON');
  const beforeObject=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');
  let invoked=0;
  try {
    Object.defineProperty(Array.prototype,'toJSON',{configurable:true,value(){invoked++;return [];}});
    Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){invoked++;return {schema:1,entries:[]};}});
    value.entries[0]='mutated-after-enqueue';
    await pending;
    assert.equal(fs.readFileSync(item.file,'utf8'),expected);
    const read=await item.store.read();
    assert.equal(JSON.stringify(read,null,2),expected);
    assert.equal(Object.getPrototypeOf(read),null);
    assert.equal(Object.getPrototypeOf(read.entries),null);
    assert.ok(Object.isFrozen(read) && Object.isFrozen(read.entries));
    assert.equal(invoked,0);
  } finally {
    if(beforeArray)Object.defineProperty(Array.prototype,'toJSON',beforeArray);else delete Array.prototype.toJSON;
    if(beforeObject)Object.defineProperty(Object.prototype,'toJSON',beforeObject);else delete Object.prototype.toJSON;
  }
});
test('ordinary-JSON storage refuses getters and own serialization functions without running them', async () => {
  const item=store({ordinaryJson:true}); let invoked=0;
  const input={schema:1};Object.defineProperty(input,'entries',{enumerable:true,get(){invoked++;return [];}});
  await assert.rejects(item.store.write(input));
  await assert.rejects(item.store.write({schema:1,entries:[],toJSON(){invoked++;return {};}}));
  assert.equal(invoked,0);assert.equal(fs.existsSync(item.file),false);
});
test('FIFO leaves are rejected by both APIs under an independent process deadline', {skip:process.platform==='win32'}, () => {
  const {spawnSync}=require('node:child_process'); const item=store();
  const fifo=spawnSync('/usr/bin/mkfifo',[item.file],{encoding:'utf8',timeout:2000});assert.equal(fifo.status,0,fifo.stderr);
  const script=`
    const {loadServerInternals}=require(${JSON.stringify(path.resolve(__dirname,'../lib/server-internals'))});
    const {DurableJsonStore}=loadServerInternals(['DurableJsonStore']);
    const store=DurableJsonStore.create({file:process.argv[1],schemaVersion:1,strictRead:true,cache:false,quarantine:false,maxBytes:256,ownedRegular:true});
    (async()=>{let count=0;try{store.readSync();}catch(e){if(e.code==='EDURABLE_CAPACITY')count++;}
    try{await store.read();}catch(e){if(e.code==='EDURABLE_CAPACITY')count++;}process.exitCode=count===2?0:1;})();
  `;
  const child=spawnSync(process.execPath,['-e',script,item.file],{env:{...process.env},encoding:'utf8',timeout:3000});
  assert.equal(child.error,undefined,child.error?.message);assert.equal(child.status,0,child.stderr);
});

test('ordinary JSON rejects a schema getter before it can execute', async () => {
  const item=store({ordinaryJson:true}); let invoked=0;
  const value={entries:[]};Object.defineProperty(value,'schema',{enumerable:true,get(){invoked++;return 1;}});
  await assert.rejects(item.store.write(value));assert.equal(invoked,0);assert.equal(fs.existsSync(item.file),false);
});
test('bounded queued write publishes its fixed enqueue bytes even if a mutable legacy cache is changed', async () => {
  const item=store({cache:true}); const expected=JSON.stringify({schema:1,entries:['committed']},null,2);
  const pending=item.store.write({schema:1,entries:['committed']});
  item.store.readSync().entries.push('x'.repeat(500));
  await pending;assert.equal(fs.readFileSync(item.file,'utf8'),expected);
  assert.ok(fs.statSync(item.file).size<=256);
});

test('owned writes always create private regular files even without an explicit mode', {skip:process.platform==='win32'}, async () => {
  const item=store({mode:undefined});await item.store.write({schema:1,entries:[]});
  assert.equal(fs.statSync(item.file).mode&0o777,0o600);await item.store.read();
  assert.throws(()=>store({mode:0o644}));
});
test('an exclusive temporary-name collision preserves both the foreign inode and previous committed target', async () => {
  const item=store();const before=JSON.stringify({schema:1,entries:['previous']},null,2);fs.writeFileSync(item.file,before,{mode:0o600});
  const realOpen=fs.promises.open;let collision;
  try {
    fs.promises.open=async(file,flags,...rest)=>{
      if(flags==='wx' && String(file).startsWith(item.file+'.')) {collision=file;fs.writeFileSync(file,'foreign-inode',{flag:'wx',mode:0o600});}
      return realOpen.call(fs.promises,file,flags,...rest);
    };
    await assert.rejects(atomicWriteJson(item.file,{schema:1,entries:['changed']},{mode:0o600,exclusiveTemp:true}),{code:'EEXIST'});
    assert.equal(fs.readFileSync(collision,'utf8'),'foreign-inode');assert.equal(fs.readFileSync(item.file,'utf8'),before);
  } finally {fs.promises.open=realOpen;}
});
