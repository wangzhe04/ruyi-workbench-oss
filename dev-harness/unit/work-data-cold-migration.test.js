'use strict';
// Concrete ordinary host + actual snapshot, control, manifest and V3 owners.
// DPAPI, manifest publication, native IDs and cold verification are simulated
// adapters here. Real process/native acceptance is a separate serial gate.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {fixture}=require('../lib/work-data-migration-host-fixture'),draft=path.resolve(__dirname,'../../ruyi-workbench/app/src'),password='synthetic cold operation password only';
async function setup(t,options={}){
 const f=await fixture(t);f.context.VERSION='3.0.1';f.context.MigrationHooks={createBackupOwner:value=>f.special.api.hooks.createBackupOwner({...value,native:f.special.native})};
 // Actual manifest logic, with only publication durability explicitly simulated.
 f.api.WorkDataManifest.Hooks.publish=async request=>fsp.rename(request.stage,request.target);
 vm.runInContext(['13aj-work-data-control.js','01ae-work-data-maintenance-result.js','13ak-work-data-cold-operations.js'].map(file=>fs.readFileSync(path.join(draft,file),'utf8')).join('\n'),f.context);
 const api=vm.runInContext('({WorkDataColdOperations,WorkDataMaintenanceResult,WorkDataTree})',f.context),owners=new Set(),backupDirectory=path.join(f.root,'external-backups');await fsp.mkdir(backupDirectory);
 const sourceOwner=f.ownership,context={id:'c'.repeat(48),base:f.base,operation:'enable',password,expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},paths:{backupDirectory,targetDirectory:null,uploadFile:null,uploadSha256:null},ownership:sourceOwner,assertExclusive:owner=>owner===sourceOwner};
 const host={acquire:async roots=>{const owner={roots,release:async()=>owners.delete(owner)};owners.add(owner);return owner;},flush:async()=>{},
  async verifyFresh(value){const owner={roots:[value.target]},full=f.api.WorkDataFullSnapshot.create({base:value.target,ownership:owner,assertExclusive:()=>true,protector:f.protector,externalOwner:opts=>f.api.ExternalBotCredentials.create(opts)});await full.seal({password:value.password,appVersion:'3.0.1',generation:value.generation??0});return true;},
  verifyDisposableNativeTree:async()=>true,progress:()=>{},helperMayStillRun:()=>false,
  async captureRehearsal({target}){const tree=api.WorkDataTree.create(),captured=await tree.capture(target);return {...captured,async verify(){await tree.verify(captured);return true;}};},
  fullSnapshot:(base,ownership,assertExclusive,{onNativeCause})=>f.api.WorkDataFullSnapshot.create({base,ownership,assertExclusive,protector:{supported:()=>f.protector.supported(),async run(...args){try{return await f.protector.run(...args);}catch(cause){onNativeCause(cause);throw cause;}}},externalOwner:opts=>f.api.ExternalBotCredentials.create(opts)}),
  migrationFactory(value){const actual=f.api.WorkDataMigrationHost.create(value);return options.wrap?options.wrap(actual):actual;},
 };
 await f.write('config.json','{ "workDataEncryptionV1": false, "private":"ORIGINAL_PRIVATE" }');await f.write('sessions/sess_one.json','{"id":"sess_one","private":"SESSION_PRIVATE"}');
 return{f,api,context,host,owners,operation:api.WorkDataColdOperations.create(host)};
}
test('real ordinary pipeline backs up, authenticates, publishes, writes durable result then removes only complete intent',async t=>{
 const x=await setup(t),original=await fsp.readFile(path.join(x.f.base,'sessions/sess_one.json')),result=await x.operation.execute(x.context),active=await x.f.api.WorkDataManifest.create({base:x.f.base}).readActive();
 assert.equal(result.state,'published');assert.equal(active.generation,1);assert.equal(active.mode,'encrypted');assert.equal(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-v1.json')),false);
 assert.deepEqual(await fsp.readFile(path.join(x.f.base,'sessions/sess_one.json')),original);assert.ok(!(await fsp.readFile(path.join(active.root,'sessions/sess_one.json'),'utf8')).includes('SESSION_PRIVATE'));
 const raw=await fsp.readFile(path.join(x.f.base,'.work-data/maintenance-result-v1.json')),record=x.api.WorkDataMaintenanceResult.decode(raw);assert.equal(record.state,'published');assert.equal(record.authority.id,active.id);assert.equal(record.authority.sha256,active.proof.sha256);assert.ok(fs.existsSync(record.backup.path));assert.equal(raw.includes(Buffer.from(password)),false);assert.equal(x.owners.size,0);
});
test('invalid final proof retains complete selected generation and source intent; no false completion result',async t=>{
 const x=await setup(t,{wrap:actual=>({...actual,verifyPublished:async()=>({readOnly:true})})});
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.transition_requires_recovery'&&error.operationMayHaveExecuted===true&&error.sourceIntentRetained===true);
 assert.equal((await x.f.api.WorkDataManifest.create({base:x.f.base}).readActive()).generation,1);assert.ok(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-v1.json')));assert.equal(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-result-v1.json')),false);
});
test('intent binds the candidate bytes before commit and a different pointer cannot complete',async t=>{
 const x=await setup(t,{wrap:actual=>({...actual,async publish(prepared){
  const file=path.join(x.f.base,'.work-data','maintenance-v1.json');
  const intent=JSON.parse(await fsp.readFile(file,'utf8'));
  assert.equal(intent.phase,'key-ready');
  assert.equal(intent.candidate.pointerSha256,prepared.candidate.pointerProof.sha256);
  const result=await actual.publish(prepared);
  assert.equal(result.active.proof.raw,prepared.candidate.pointerProof.raw);
  const raw=result.active.proof.raw.replace('"schema":1','"schema": 1');
  await fsp.writeFile(path.join(x.f.base,'.work-data','active-v1.json'),raw);
  return result;
 }})});
 await assert.rejects(x.operation.execute(x.context),{code:'work_data_setup.transition_requires_recovery'});
 const intent=JSON.parse(await fsp.readFile(path.join(x.f.base,'.work-data','maintenance-v1.json'),'utf8'));
 const selected=await x.f.api.WorkDataManifest.create({base:x.f.base}).readActive();
 assert.equal(intent.phase,'published');
 assert.equal(selected.id,intent.candidate.id);
 assert.notEqual(selected.proof.sha256,intent.candidate.pointerSha256);
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data','maintenance-result-v1.json')),false);
});

test('one cold enable authenticates, backs up and transforms every ordinary required family together',async t=>{
 const {wholeTextCases}=require('../lib/work-data-migration-corpus');
 const {fixture:imageFixture}=require('../lib/media-image-contract-fixture');
 const {gzipSync}=require('node:zlib');
 const preparedRows=[];
 const x=await setup(t,{wrap:actual=>({...actual,async prepare(input){
  const prepared=await actual.prepare(input);preparedRows.push(...prepared.transformed);return prepared;
 }})});
 vm.runInContext(fs.readFileSync(path.join(draft,'13bb-media-derived-store.js'),'utf8'),x.f.context);
 const records=[
  ...['messages','provider','interventions','changes'].map(kind=>['session-'+kind,'sessions/sess_one.'+kind+'.ndjson']),
  ['steward-inbox','steward/inbox-v1.ndjson'],['steward-decisions','steward/decisions-v1.ndjson'],
  ['scheduler-fires','scheduler/fires-v1.ndjson'],['audit-log','logs/workbench-2026-10-24.ndjson'],
  ['agent-run-events','agent-runs/sess_one/run_one.events.ndjson'],
 ];
 const textCases=[...wholeTextCases,
  ['session-fulltext-state','sessions/_fulltext-index-v1/state.json'],
  ['session-fulltext-manifest','sessions/_fulltext-index-v1/sess_one/manifest.json'],
  ['session-fulltext-shard','sessions/_fulltext-index-v1/sess_one/'+'a'.repeat(32)+'.0.json'],
 ];
 const marker='SYNTHETIC_M3_ALL_FAMILIES_PRIVATE';
 const makeText=(family,shape)=>{
  if(shape==='markdown')return '# '+marker+'\r\n';
  const extra=family==='session-head'?{id:'sess_one',storageVersion:2,messageCount:1,providerHistoryCount:1}
   :family==='session-index'?{id:'sess_one'}:family==='agent-run-snapshot'?{id:'run_one',sessionId:'sess_one'}:{};
  const value={...extra,private:marker+family};
  return JSON.stringify(shape==='array'?[value]:value)+'\r\n';
 };
 const seed=new Map(textCases.map(([family,file,shape])=>[file,Buffer.from(makeText(family,shape))]));
 for(const [family,file] of records)seed.set(file,Buffer.from(makeText(family)));
 seed.set('sessions/sess_one.messages.ndjson.prevbody',Buffer.from(makeText('previous-session-messages')));
 seed.set('checkpoints/sess_one/history-1.json.gz',gzipSync(makeText('journal-history'),{level:0}));
 seed.set('agent-runs/sess_one/run_one.events.ndjson.gz',gzipSync(makeText('archive-agent-run-events'),{level:0}));
 const image=imageFixture(),token=await image.pipeline.prepare(),preview=image.pipeline.borrow(token);
 const scope='b'.repeat(32),id='mimg_'+'c'.repeat(32);
 try{
  seed.set('media-derived-v1/'+scope+'/'+id+'.json',Buffer.from(JSON.stringify({
   schema:1,id,sourceId:'synthetic',issuedAt:1000,revocationRevision:'r1',manifest:{...preview.manifest,scope},
   data:preview.bytes.toString('base64'),
  })));
 }finally{preview.release();image.pipeline.release(token);}
 for(const [file,bytes] of seed)await x.f.write(file,bytes);
 const result=await x.operation.execute(x.context),active=result.authority.active;
 const freeze=require('../../docs/architecture/encrypted-storage-freeze.json');
 const separateOwners=new Set(['uploads-attachment','uploads-tool-image','migration-skill-backups']);
 const expected=freeze.entries.filter(row=>row.encryption==='required'&&!separateOwners.has(row.id)).map(row=>row.id).sort();
 assert.deepEqual([...new Set(preparedRows.map(row=>row.family))].sort(),expected);
 assert.deepEqual(preparedRows.map(row=>row.path).sort(),[...seed.keys()].sort());
 assert.equal(active.mode,'encrypted');
 for(const [file,bytes] of seed){
  assert.deepEqual(await fsp.readFile(path.join(x.f.base,file)),bytes,file);
  const sealed=await fsp.readFile(path.join(active.root,file));
  assert.notDeepEqual(sealed,bytes,file);
  assert.equal(sealed.includes(marker),false,file);
 }
});
