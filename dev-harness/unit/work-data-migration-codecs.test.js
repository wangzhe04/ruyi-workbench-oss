'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), syncFs = require('node:fs'), path = require('node:path');
const os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto'), zlib = require('node:zlib');
const REPO = process.env.RUYI_MIGRATION_REPO_ROOT || path.resolve(__dirname, '../..');
const SOURCE = process.env.RUYI_MIGRATION_CODEC_SOURCE || path.join(REPO, 'ruyi-workbench/app/src/01x-work-data-migration-codecs.js');
const actual = require(path.join(REPO, 'dev-harness/lib/work-data-journals-fixture')).loadWorkDataJournals();
const load = (overrides = {}) => vm.runInNewContext(syncFs.readFileSync(SOURCE, 'utf8') + '\nWorkDataMigrationCodecs;', {
  ...actual, ...(overrides.records ? { WorkDataRecords: overrides.records } : {}),
  require: name => name === 'node:fs/promises' && overrides.fs ? overrides.fs : require(name), Buffer, process,
});
const codecs = load(), hash = value => crypto.createHash('sha256').update(value).digest('hex');
const roots = [];
test.after(async () => {
  for (const root of roots) {
    const target = path.resolve(root), temp = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(target.startsWith(temp) && path.basename(target).startsWith('ruyi-migration-codec-unit-'));
    await fs.rm(target, { recursive: true, force: true });
  }
});
function keySet(id) {
  const master = crypto.randomBytes(32), original = Buffer.from(master), state = { acquires: 0, releases: 0, copies: [] };
  return { master, instanceId: id.repeat(32), state, assertReleased() {
    assert.equal(state.acquires, state.releases); assert.deepEqual(master, original);
    for (const copy of state.copies) assert.ok(copy.every(byte => byte === 0));
  }, async snapshot() {
    state.acquires++; const key = Buffer.from(master); state.copies.push(key);
    return { key, instanceId: id.repeat(32), release() { state.releases++; key.fill(0); if (state.failRelease) throw Error('synthetic release failed'); } };
  } };
}
async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-migration-codec-unit-')); roots.push(root);
  const source = path.join(root, 'source'), target = path.join(root, 'shadow'), restore = path.join(root, 'restore');
  await fs.mkdir(source); await fs.mkdir(target); await fs.mkdir(restore);
  const a = keySet('a'), b = keySet('b'), c = keySet('c');
  const base = { writeJson: actual.atomicWriteJson, maxLogicalBytes: 4 * 1024 * 1024, ...options };
  return { root, source, target, restore, a, b, c, bridge: (options.module || codecs).create({
    ...base, sourceRoot: source, targetRoot: target, sourceKeys: a, targetKeys: b,
  }), reverse(extra = {}) { return codecs.create({ ...base, sourceRoot: target, targetRoot: restore, sourceKeys: b, targetKeys: c, ...extra }); },
  async put(relative, data) { const file = path.join(source, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return file; },
  targetFile: relative => path.join(target, ...relative.split('/')), restoredFile: relative => path.join(restore, ...relative.split('/')) };
}
const rejection = code => error => error.code === 'work_data_migration.' + code;
const payload = '{ "schema":1, "number":9007199254740993, "duplicate":1, "duplicate":2, "text":"中文😀", "unknown":{"workData":3} }\r\n';
const cases = [
  ['session-head','sessions/sess_one.json'], ['session-scratchpad','sessions/sess_one.scratchpad.json'],
  ['session-index','sessions/index.json','array'], ['session-v1-backup','sessions/sess_one.json.v1bak'],
  ['journal-index','checkpoints/sess_one/index.json','array'], ['journal-reverts','checkpoints/sess_one/reverts.json'],
  ['mission-container','missions/mission_one.json'], ['pretender-index','sessions/.pretender/projection-index.json'],
  ['memory-body','memory/global/note.md','markdown'], ['memory-meta','memory/project/0123456789abcdef/meta.json'],
  ['memory-usage','memory/_usage-v1.json'], ['memory-relations','memory/project/0123456789abcdef/_relations.json','array'],
  ['memory-proposals','memory/proposals/sess_one.json'], ['agent-instructions-import','memory/.agent-instructions-import-v1.json'],
  ['steward-memory','steward/memory-v1.json'], ['steward-visits','steward/visits/2026-10-24T12-00-00-000Z.json'],
  ['voice-lexicon','voice-lexicon.json'], ['steward-cursor','steward/cursor-v1.json'],
  ['external-bots','external-bots/state-v1.json'], ['scheduler-tasks','scheduler/tasks-v1.json'],
  ['agent-run-snapshot','agent-runs/sess_one/run_one.json'], ['background-job-ledger','sessions/background-jobs/sess_one.json','array'],
  ['personal-workflows','agent-workflows/Display 不同.json'], ['playbooks','playbooks/Display 不同.json'],
  ['session-search-index','sessions/_search-index-v1.json'], ['web-cache','webcache/'+'e'.repeat(64)+'.json'],
  ['proxy-models-cache','proxy-models-cache.json'], ['engine-transcript-index','engine-transcripts.json'],
  ['migration-log','migrations/2026-10-24T12-00-00-000Z.json'], ['skill-import-record','skills/tool_one/.ruyi-import.json'],
];

test('fixed catalog covers exactly the 41 required families with honest special-owner status', () => {
  const freeze = JSON.parse(syncFs.readFileSync(path.join(REPO, 'docs/architecture/encrypted-storage-freeze.json')));
  const expected = freeze.entries.filter(row => row.encryption === 'required').map(row => row.id).sort();
  assert.deepEqual(Array.from(codecs.catalog(), row => row.family).sort(), expected);
  assert.equal(codecs.catalog().filter(row => row.support === 'special-owner-required').length, 1);
  assert.equal(codecs.catalog().find(row => row.family === 'migration-skill-backups').codec, 'special-owner-required');
  assert.equal(codecs.describe('external-bots/state-v1.json').chunked, true);
  assert.equal(codecs.describe('memory/project/0123456789abcdef/note.md').scopeId, 'project:0123456789abcdef');
  assert.equal(codecs.describe('memory/project/0123456789abcdef/note.md').recordId, 'memory:note');
});

test('all 30 whole-text family bindings round-trip exact logical bytes without JSON sanitization', async () => {
  const f = await fixture();
  for (const [family, relative, shape] of cases) {
    const raw = shape === 'markdown' ? '\uFEFF# 用户原文\r\n正文含 "workData":3 示例\n' : shape === 'array' ? '[' + payload.trimEnd() + ']\r\n' : payload;
    const input = await f.put(relative, raw), before = await fs.readFile(input);
    const result = await f.bridge.transform({ relative, targetMode: 'encrypted', purpose: 'wrong-caller-purpose', recordId: 'wrong-caller-id' });
    assert.equal(result.family, family); assert.equal(result.logicalHash, hash(before)); assert.equal(result.logicalBytes, before.length);
    assert.deepEqual(await fs.readFile(input), before); assert.ok(Object.isFrozen(result));
    const reverse = await f.reverse().transform({ relative, targetMode: 'plain' });
    assert.equal(reverse.logicalHash, result.logicalHash); assert.deepEqual(await fs.readFile(f.restoredFile(relative)), before);
    const encoded = await fs.readFile(f.targetFile(relative), 'utf8');
    let head; try { head = JSON.parse(encoded); } catch { head = JSON.parse(encoded.split('\n')[0]); }
    assert.equal(head.purpose, codecs.describe(relative).purpose);
    assert.equal(head.recordId, codecs.describe(relative).recordId);
  }
  f.a.assertReleased(); f.b.assertReleased(); f.c.assertReleased(); assert.equal(f.c.state.acquires, 0);
});

test('a real source session-head owner reads the encrypted bridge output', async () => {
  const f = await fixture(), relative = 'sessions/sess_one.json'; await f.put(relative, payload);
  await f.bridge.transform({ relative, targetMode: 'encrypted' });
  const { functionBlock } = require(path.join(REPO, 'dev-harness/lib/source-slice'));
  const code = functionBlock(syncFs.readFileSync(path.join(REPO, 'ruyi-workbench/app/src/02-session-store.js'), 'utf8'), 'sessionHeadStore');
  const factory = vm.runInNewContext(code+'\nsessionHeadStore', { WorkDataStore: actual.WorkDataStore,
    sessionPath: () => f.targetFile(relative), SESSION_HEAD_ADAPTER_SCHEMA: 2, workDataKeys: f.b,
    atomicWriteJson: actual.atomicWriteJson, readConfig: async () => ({ workDataEncryptionV1: true }) });
  assert.equal(await factory('sess_one').read(), payload); f.b.assertReleased();
});

test('plaintext to plaintext never acquires either key or changes logical bytes', async () => {
  const f = await fixture(), relative = 'memory/global/note.md'; const raw = '# 文档\r\n文档不是 JSON，示例 "workData":3\r\n';
  await f.put(relative, raw); await f.bridge.transform({ relative, targetMode: 'plain' });
  assert.equal(await fs.readFile(f.targetFile(relative), 'utf8'), raw);
  assert.equal(f.a.state.acquires,0); assert.equal(f.b.state.acquires,0);
});

test('real skill import owner and bridge open each other with mixed case native identity', async () => {
  const { functionBlock } = require(path.join(REPO, 'dev-harness/lib/source-slice'));
  const code = functionBlock(syncFs.readFileSync(path.join(REPO, 'ruyi-workbench/app/src/12-tool-dispatch.js'), 'utf8'), 'skillImportRecordStore');
  const factory = vm.runInNewContext(code + '\nskillImportRecordStore', { WorkDataStore: actual.WorkDataStore,
    path, process, Buffer, SKILL_ID_RE: /^[A-Za-z0-9_-]{1,64}$/, SKILL_IMPORT_RECORD: '.ruyi-import.json',
    SKILL_IMPORT_SOURCES: ['claude-code', 'codex', 'kimi', 'claude-plugin'],
    safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    atomicWriteJson: actual.atomicWriteJson, readConfig: async () => ({ workDataEncryptionV1: true }) });
  const relative = 'skills/Tool_One/.ruyi-import.json';
  const plain = JSON.stringify({ schema: 1, source: 'codex', plugin: '', sourcePath: 'C:/skills/Tool_One',
    importedAt: '2026-10-24T00:00:00.000Z', sourceTreeHash: 'a'.repeat(64), copyTreeHash: 'b'.repeat(64) }, null, 2) + '\r\n';
  const previous = actual.WorkDataStore.Hooks.keys;
  try {
    const f = await fixture(); await f.put(relative, plain);
    await f.bridge.transform({ relative, targetMode: 'encrypted' });
    actual.WorkDataStore.Hooks.keys = f.b;
    assert.equal(await factory(path.dirname(f.targetFile(relative)), 'Tool_One').read(), plain);
    assert.equal(codecs.describe(relative).recordId, 'skill-import:' + (process.platform === 'win32' ? 'tool_one' : 'Tool_One'));
    const g = await fixture(); const source = await g.put(relative, plain);
    actual.WorkDataStore.Hooks.keys = g.a;
    await factory(path.dirname(source), 'Tool_One').write(plain);
    const sealed = await fs.readFile(source);
    await g.bridge.transform({ relative, targetMode: 'encrypted' });
    assert.deepEqual(await fs.readFile(source), sealed);
    actual.WorkDataStore.Hooks.keys = g.b;
    assert.equal(await factory(path.dirname(g.targetFile(relative)), 'Tool_One').read(), plain);
    await g.reverse().transform({ relative, targetMode: 'plain' });
    assert.equal(await fs.readFile(g.restoredFile(relative), 'utf8'), plain);
    f.a.assertReleased(); f.b.assertReleased(); g.a.assertReleased(); g.b.assertReleased(); g.c.assertReleased();
  } finally { actual.WorkDataStore.Hooks.keys = previous; }
});

test('missing explicit migration keys never fall through to the global active-key hook', async () => {
  const f = await fixture(), relative = 'sessions/sess_one.json'; await f.put(relative, payload);
  const previous = actual.WorkDataStore.Hooks.keys; actual.WorkDataStore.Hooks.keys = f.c;
  try {
    const bridge = codecs.create({ sourceRoot:f.source, targetRoot:f.target, writeJson:actual.atomicWriteJson });
    await assert.rejects(bridge.transform({ relative, targetMode:'encrypted' }), rejection('keys_required'));
    assert.equal(f.c.state.acquires,0); assert.equal(syncFs.existsSync(f.targetFile(relative)),false);
    assert.equal(await fs.readFile(path.join(f.source,relative),'utf8'),payload);
  } finally { actual.WorkDataStore.Hooks.keys = previous; }
});

test('an ambiguous reserved chunk marker in a legacy first line stays an owner error, never an authentication claim', async () => {
  const f = await fixture(), relative = 'memory/global/note.md', raw = '文档示例 "workData":3\r\n';
  const input = await f.put(relative, raw);
  await assert.rejects(f.bridge.transform({ relative, targetMode: 'encrypted' }), { code: 'work_data_store.corrupt' });
  assert.equal(await fs.readFile(input, 'utf8'), raw); assert.equal(f.a.state.acquires, 0);
  assert.equal(syncFs.existsSync(f.targetFile(relative)), false);
});

test('all four session record kinds use actual ordinal-bound format and preserve CRLF logical rows', async () => {
  const f = await fixture();
  for (const kind of ['messages','provider','interventions','changes']) {
    const relative='sessions/sess_one.'+kind+'.ndjson', plain='{"id":"one","text":"用户😀"}\r\n{"id":"two","nested":{"w":2}}\n';
    await f.put(relative, plain); await f.bridge.transform({relative,targetMode:'encrypted'});
    const sealed=await fs.readFile(f.targetFile(relative),'utf8');
    assert.equal(actual.WorkDataRecords.decodeBody(sealed,f.b.master,{instanceId:f.b.instanceId,sessionId:'sess_one',kind}),plain);
    await f.reverse().transform({relative,targetMode:'plain'}); assert.equal(await fs.readFile(f.restoredFile(relative),'utf8'),plain);
  }
  f.a.assertReleased(); f.b.assertReleased();
});

test('mixed session rows are authenticated at their physical ordinal before re-encryption with an independent key', async () => {
  const f=await fixture(),relative='sessions/sess_one.messages.ndjson'; const first='{"text":"legacy"}',second='{"text":"sealed"}';
  const encoded=actual.WorkDataRecords.encodeLine(second,f.a.master,{instanceId:f.a.instanceId,sessionId:'sess_one',kind:'messages',ordinal:1});
  const input=await f.put(relative,first+'\n'+encoded+'\n'),before=await fs.readFile(input);
  await f.bridge.transform({relative,targetMode:'encrypted'}); assert.deepEqual(await fs.readFile(input),before);
  const target=await fs.readFile(f.targetFile(relative),'utf8');
  assert.equal(actual.WorkDataRecords.decodeBody(target,f.b.master,{instanceId:f.b.instanceId,sessionId:'sess_one',kind:'messages'}),first+'\n'+second+'\n');
  assert.throws(()=>actual.WorkDataRecords.decodeBody(target,f.a.master,{instanceId:f.a.instanceId,sessionId:'sess_one',kind:'messages'}));
  f.a.assertReleased();f.b.assertReleased();
});

const auxiliaries=[['steward/inbox-v1.ndjson','steward-inbox','steward'],['steward/decisions-v1.ndjson','steward-decisions','steward'],
 ['scheduler/fires-v1.ndjson','scheduler-fires','scheduler-global'],['logs/workbench-2026-10-24.ndjson','audit-log','2026-10-24'],
 ['agent-runs/sess_one/run_one.events.ndjson','agent-run-events','sess_one','run_one']];
test('all five auxiliary journal forms use the real fixed-purpose record codec',async()=>{
 const f=await fixture();for(const[relative,kind,sid,rid]of auxiliaries){const plain='{"seq":1,"text":"一"}\n{"seq":2,"text":"二"}\r\n';
 await f.put(relative,plain);await f.bridge.transform({relative,targetMode:'encrypted'});const rows=(await fs.readFile(f.targetFile(relative),'utf8')).trimEnd().split('\n');
 const decoded=[];for(let ordinal=0;ordinal<rows.length;ordinal++)decoded.push(await actual.WorkDataRecords.decodeRecordLine(rows[ordinal],f.b.master,{instanceId:f.b.instanceId,sessionId:sid,runId:rid,kind,ordinal},4*1024*1024));
 assert.equal(decoded.join('\n')+'\n',plain);await f.reverse().transform({relative,targetMode:'plain'});assert.equal(await fs.readFile(f.restoredFile(relative),'utf8'),plain);}
 f.a.assertReleased();f.b.assertReleased();
});

test('large auxiliary rows use authenticated chunked records without changing their logical bytes',async()=>{
 const f=await fixture(),relative='logs/workbench-2026-10-24.ndjson';const plain=JSON.stringify({text:'中'.repeat(400000)})+'\n';
 await f.put(relative,plain);await f.bridge.transform({relative,targetMode:'encrypted'});const row=await fs.readFile(f.targetFile(relative),'utf8');assert.equal(JSON.parse(row).w,3);
 await f.reverse().transform({relative,targetMode:'plain'});assert.equal(await fs.readFile(f.restoredFile(relative),'utf8'),plain);
});

test('checkpoint gzip preserves arbitrary original gzip bytes and never mistakes embedded markers for authentication',async()=>{
 const f=await fixture(),relative='checkpoints/sess_one/1-1.gz';const body=Buffer.concat([Buffer.from([255,0,1]),Buffer.from('"workData":3')]);const gzip=zlib.gzipSync(body,{level:0});
 assert.equal(gzip.includes(Buffer.from('"workData":3')),true);await f.put(relative,gzip);await f.bridge.transform({relative,targetMode:'encrypted'});
 await f.reverse().transform({relative,targetMode:'plain'});assert.deepEqual(await fs.readFile(f.restoredFile(relative)),gzip);assert.equal(f.a.state.acquires,0);
});

test('event gzip archives convert both the outer carrier and mixed inner journal records in reverse migration',async()=>{
 const f=await fixture(),relative='agent-runs/sess_one/run_one.events.ndjson.gz';const first='{"seq":1,"text":"plain"}',second='{"seq":2,"text":"秘密"}';
 const factory=actual.WorkDataRecords.encodeRecordFactory(second,f.a.master,{instanceId:f.a.instanceId,sessionId:'sess_one',runId:'run_one',kind:'agent-run-events',ordinal:1},4*1024*1024);
 let encoded='';try{for await(const part of factory())encoded+=part;}finally{factory.dispose();}const gzip=zlib.gzipSync(Buffer.from(first+'\n'+encoded)),input=await f.put(relative,gzip);
 const result=await f.bridge.transform({relative,targetMode:'encrypted'});assert.equal(result.codec,'nested-gzip-journal');assert.deepEqual(await fs.readFile(input),gzip);
 await f.reverse().transform({relative,targetMode:'plain'});const restored=await fs.readFile(f.restoredFile(relative));assert.equal(zlib.gunzipSync(restored).toString('utf8'),first+'\n'+second+'\n');
 assert.equal(f.c.state.acquires,0);f.a.assertReleased();f.b.assertReleased();
});

test('blank, invalid and no-LF rows require their original owner and leave every source byte intact',async()=>{
 for(const relative of ['sessions/sess_one.messages.ndjson','steward/inbox-v1.ndjson'])for(const raw of ['{"text":1}\n\n','{"text":1}','{broken}\n','[]\n']){
 const f=await fixture(),input=await f.put(relative,raw);await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('special_owner_required'));
 assert.equal(await fs.readFile(input,'utf8'),raw);assert.equal(syncFs.existsSync(f.targetFile(relative)),false);}
});

test('incorrect ordinal, missing key and wrong source instance fail without quarantining or overwriting',async()=>{
 const f=await fixture(),relative='sessions/sess_one.messages.ndjson';const encoded=actual.WorkDataRecords.encodeLine('{"text":1}',f.a.master,{instanceId:f.a.instanceId,sessionId:'sess_one',kind:'messages',ordinal:1});
 const input=await f.put(relative,encoded+'\n');await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}));assert.equal(await fs.readFile(input,'utf8'),encoded+'\n');
 const correct=actual.WorkDataRecords.encodeLine('{"text":1}',f.a.master,{instanceId:f.a.instanceId,sessionId:'sess_one',kind:'messages',ordinal:0});await fs.writeFile(input,correct+'\n');
 const wrong=codecs.create({sourceRoot:f.source,targetRoot:f.target,sourceKeys:f.c,targetKeys:f.b,writeJson:actual.atomicWriteJson});
 await assert.rejects(wrong.transform({relative,targetMode:'encrypted'}));assert.equal(syncFs.existsSync(input+'.corrupt'),false);assert.equal(syncFs.existsSync(f.targetFile(relative)),false);
 f.a.assertReleased();f.b.assertReleased();f.c.assertReleased();
});

test('invalid UTF8 and engineering limits refuse migration without changing OFF source files',async()=>{
 const f=await fixture(),relative='sessions/sess_one.json',raw=Buffer.from([123,34,120,34,58,34,255,34,125]);const input=await f.put(relative,raw);
 await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('utf8_invalid'));assert.deepEqual(await fs.readFile(input),raw);
 await fs.writeFile(input,payload);const limited=codecs.create({sourceRoot:f.source,targetRoot:f.target,sourceKeys:f.a,targetKeys:f.b,writeJson:actual.atomicWriteJson,maxLogicalBytes:4,maxPhysicalBytes:4});
 await assert.rejects(limited.transform({relative,targetMode:'plain'}),rejection('engineering_limit'));assert.equal(await fs.readFile(input,'utf8'),payload);
});

test('NTFS capsules, quarantined copies and unfinished owner artifacts are explicit special cases',async()=>{
 const f=await fixture();for(const relative of ['migrations/skill-backups/2026-10-24/tool_one/archive','sessions/sess_one.json.corrupt','sessions/sess_one.messages.ndjson.prevbody','memory/global/a.md.sealed-stage-abc']){
 await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('special_owner_required'));}
 for(const relative of ['../config.json','sessions/../config.json','sessions\\sess_one.json','sessions/a.json:stream','config.json'])assert.throws(()=>f.bridge.describe(relative));
 assert.deepEqual(await fs.readdir(f.target),[]);
});

test('existing hardlink targets and aliased source/target roots cannot be overwritten',async()=>{
 const f=await fixture(),relative='sessions/sess_one.json',input=await f.put(relative,payload);await fs.mkdir(path.dirname(f.targetFile(relative)));await fs.link(input,f.targetFile(relative));
 await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('target_exists'));assert.equal(await fs.readFile(input,'utf8'),payload);
 const alias=path.join(f.root,'alias');await fs.symlink(f.source,alias,'junction');const bridge=codecs.create({sourceRoot:f.source,targetRoot:alias,sourceKeys:f.a,targetKeys:f.b,writeJson:actual.atomicWriteJson});
 await assert.rejects(bridge.transform({relative,targetMode:'encrypted'}),rejection('path_alias'));
});

test('target verification requires actual authentication, never just matching plaintext or a marker',async()=>{
 const raw='{"text":"PRIVATE","example":"workData"}\n';
 for(const relative of ['sessions/sess_one.json','sessions/sess_one.messages.ndjson']){
 const f=await fixture({writeJson:async(file)=>{await fs.writeFile(file,raw);}}),input=await f.put(relative,raw);
 await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('verification_failed'));
 assert.equal(await fs.readFile(input,'utf8'),raw);assert.equal(syncFs.existsSync(f.targetFile(relative)),false);
 f.a.assertReleased();f.b.assertReleased();}
});

test('gzip target verification refuses an unencrypted carrier even when its bytes match',async()=>{
 const gzip=zlib.gzipSync(Buffer.from('PRIVATE BINARY'));
 const f=await fixture({writeJson:async file=>{await fs.writeFile(file,gzip);}}),relative='checkpoints/sess_one/1-1.gz',input=await f.put(relative,gzip);
 await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('verification_failed'));
 assert.deepEqual(await fs.readFile(input),gzip);assert.equal(syncFs.existsSync(f.targetFile(relative)),false);f.a.assertReleased();f.b.assertReleased();
});

test('nested archive verification refuses authenticated outer gzip with unencrypted inner records',async()=>{
 const faulty={...actual.WorkDataRecords,encodeRecordFactory(plain,key,context,max){
  if(context.kind!=='agent-run-events')return actual.WorkDataRecords.encodeRecordFactory(plain,key,context,max);
  const factory=async function*(){yield plain+'\n';};factory.dispose=()=>{};return factory;
 }};
 const f=await fixture({module:load({records:faulty})}),relative='agent-runs/sess_one/run_one.events.ndjson.gz';const gzip=zlib.gzipSync(Buffer.from('{"seq":1,"text":"PRIVATE"}\n'));
 const input=await f.put(relative,gzip);await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('verification_failed'));
 assert.deepEqual(await fs.readFile(input),gzip);assert.equal(syncFs.existsSync(f.targetFile(relative)),false);f.a.assertReleased();f.b.assertReleased();
});

test('a second encrypted generation authenticates only with the new independent instance and master',async()=>{
 const f=await fixture(),relative='sessions/sess_one.json';await f.put(relative,payload);await f.bridge.transform({relative,targetMode:'encrypted'});
 const rotated=f.reverse();await rotated.transform({relative,targetMode:'encrypted'});
 const descriptor=codecs.describe(relative),read=keys=>actual.WorkDataStore.createText({...descriptor,file:()=>f.restoredFile(relative),keys,enabled:()=>true,writeJson:actual.atomicWriteJson}).read();
 assert.equal(await read(f.c),payload);await assert.rejects(read(f.b));f.a.assertReleased();f.b.assertReleased();f.c.assertReleased();
});

test('an oversized legacy session row remains intact when the real v2 record engineering bound refuses sealing',async()=>{
 const f=await fixture(),relative='sessions/sess_one.messages.ndjson',raw=JSON.stringify({text:'中'.repeat(400000)})+'\n',input=await f.put(relative,raw);
 await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}));assert.equal(await fs.readFile(input,'utf8'),raw);
 assert.equal(syncFs.existsSync(f.targetFile(relative)),false);f.a.assertReleased();f.b.assertReleased();
});

test('both key owners release even when one cleanup fails after shadow publication',async()=>{
 const f=await fixture(),relative='sessions/sess_one.json';await f.put(relative,payload);
 const sourceStore=actual.WorkDataStore.createText({file:()=>path.join(f.source,relative),purpose:'session',schema:2,scopeId:'sessions',recordId:'sess_one',keys:f.a,enabled:()=>true,writeJson:actual.atomicWriteJson});
 await sourceStore.write(payload);const before=await fs.readFile(path.join(f.source,relative));f.a.state.failRelease=true;
 await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),error=>rejection('key_release_failed')(error)&&error.targetRetained===true);
 assert.deepEqual(await fs.readFile(path.join(f.source,relative)),before);assert.equal(syncFs.existsSync(f.targetFile(relative)),true);
 f.a.assertReleased();f.b.assertReleased();
});

test('a changed source refuses publication even when stat-based metadata is irrelevant',async()=>{
 let changed=false;const f=await fixture({writeJson:async(...args)=>{await actual.atomicWriteJson(...args);if(!changed){changed=true;await fs.writeFile(path.join(f.source,'sessions/sess_one.json'),payload+' ');}}});
 const relative='sessions/sess_one.json';await f.put(relative,payload);await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('source_changed'));
 assert.equal(syncFs.existsSync(f.targetFile(relative)),false);assert.equal(await fs.readFile(path.join(f.source,relative),'utf8'),payload+' ');f.a.assertReleased();f.b.assertReleased();
});

test('an existing destination raced at publication survives exclusive hard-link failure',async()=>{
 const io=new Proxy(fs,{get(target,key){if(key==='link')return async(stage,output)=>{await fs.writeFile(output,'RACED TARGET',{flag:'wx'});return target.link(stage,output);};return target[key];}});
 const f=await fixture({module:load({fs:io})}),relative='sessions/sess_one.json';const input=await f.put(relative,payload);
 await assert.rejects(f.bridge.transform({relative,targetMode:'encrypted'}),rejection('io_failed'));assert.equal(await fs.readFile(f.targetFile(relative),'utf8'),'RACED TARGET');assert.equal(await fs.readFile(input,'utf8'),payload);
});
