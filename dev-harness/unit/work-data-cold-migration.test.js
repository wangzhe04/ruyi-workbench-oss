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
