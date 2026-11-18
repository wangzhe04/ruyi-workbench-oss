'use strict';
// Actual migration host/Tree with a modeled settlement seam; file mutations are
// real. This is not a native or encrypted-enable claim.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{fixture}=require('../lib/work-data-migration-host-fixture');
for(const kind of ['bytes','same-byte-new-id','extra-directory'])test('preflight-to-target '+kind+' mutation refuses publication',async t=>{
 const f=await fixture(t,{preserved:true});await f.write('config.json','{}');await f.write('sessions/one.json','{"id":"one"}');const expected=await f.manifest.readActive(),backup=await f.backupFirst();
 f.state.afterSettlement=async({candidate})=>{const file=path.join(candidate.root,'config.json');if(kind==='bytes')await fs.writeFile(file,'changed');else if(kind==='same-byte-new-id'){const content=await fs.readFile(file);await fs.rename(file,path.join(f.root,'retained-original'));await fs.writeFile(file,content);}else await fs.mkdir(path.join(candidate.root,'unplanned'));};
 await assert.rejects(()=>f.host.prepare({...backup,expected,targetMode:'encrypted'}),error=>error.operationMayHaveExecuted===true&&/candidate_settlement\.proof|target_verification/.test(error.code||''));
 assert.equal((await f.manifest.readActive()).generation,0);assert.equal(await fs.readFile(path.join(f.base,'config.json'),'utf8'),'{}');
});
test('unplanned file present before preflight refuses before modeled root settlement',async t=>{
 const f=await fixture(t,{preserved:true});await f.write('config.json','{}');const expected=await f.manifest.readActive(),backup=await f.backupFirst();
 f.state.beforeSettlement=async({candidate})=>fs.writeFile(path.join(candidate.root,'unplanned'),'extra');
 await assert.rejects(()=>f.host.prepare({...backup,expected,targetMode:'encrypted'}),e=>/candidate_settlement\.proof/.test(e.code||''));assert.equal(f.state.settlementRootCalls||0,0);assert.equal((await f.manifest.readActive()).generation,0);
});
