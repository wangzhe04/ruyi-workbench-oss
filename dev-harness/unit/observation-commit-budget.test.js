'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {functionBlock}=require('../lib/source-slice'),{loadWorkDataJournals}=require('../lib/work-data-journals-fixture');
const source=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/02-session-store.js'),'utf8');
const hash=rows=>crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
async function fixture(t){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-observation-budget-'));
 t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fsp.rm(root,{recursive:true,force:true});});
 const file=path.join(root,'sid.provider.ndjson'),fx=loadWorkDataJournals(),key=crypto.randomBytes(32),instanceId='a'.repeat(32),state={reads:0,closes:0,acquires:0,releases:0,readHook:null,releaseError:null,closeError:null,acquireError:null};
 const io={...fsp,readFile(){throw Error('unbounded readFile forbidden');},async open(...args){const handle=await fsp.open(...args);return{stat:(...args)=>handle.stat(...args),async read(...args){state.reads++;const result=await handle.read(...args);if(state.readHook)await state.readHook(state.reads,result);return result;},async close(){state.closes++;await handle.close();if(state.closeError)throw state.closeError;}};}};
 const context={require,Buffer,crypto,path,fsp:io,process,SESSION_STORAGE_VERSION:2,WorkDataRecords:fx.WorkDataRecords,workDataKeys:{},WorkDataStore:{async acquireSnapshot(){state.acquires++;if(state.acquireError)throw state.acquireError;return{key:Buffer.from(key),instanceId,async release(){state.releases++;if(state.releaseError)throw state.releaseError;}};}},sessionBodyPaths:()=>({provider:file}),journalArtifactFailure:s=>Object.assign(Error(s),{code:'work_data.journal_'+s})};
 const verify=vm.runInNewContext(functionBlock(source,'journalObservationSnapshotCommitted')+'\njournalObservationSnapshotCommitted;',context);
 const head=count=>({id:'sid',storageVersion:2,providerHistoryCount:count});
 const write=async(rows,{encrypted=false}={})=>{const lines=rows.map((row,ordinal)=>{const line=JSON.stringify(row);return encrypted?fx.WorkDataRecords.encodeLine(line,key,{instanceId,sessionId:'sid',kind:'provider',ordinal}):line;});await fsp.writeFile(file,lines.join('\n')+'\n');};
 return {root,file,fx,key,instanceId,state,io,verify,head,write};
}
test('committed hash streams across UTF8/chunk boundaries and excludes a verified uncommitted tail',async t=>{
 const f=await fixture(t),committed=[{role:'tool',content:'证据🙂'.repeat(25000)},{role:'assistant',content:'unchanged'}],tail={role:'user',content:'not committed'};
 await f.write([...committed,tail],{encrypted:true});assert.equal(await f.verify('sid',f.head(2),hash(committed)),true);assert.ok(f.state.reads>2);assert.equal(f.state.acquires,1);assert.equal(f.state.releases,1);assert.equal(f.state.closes,1);
 assert.equal(await f.verify('sid',f.head(2),hash([...committed,tail])),false);
});
test('raw, decoded, canonical and record ceilings reject without signing a truncated prefix',async t=>{
 const f=await fixture(t),rows=[{role:'tool',content:'x'.repeat(500)}];await f.write(rows,{encrypted:true});
 await assert.rejects(f.verify('sid',f.head(1),hash(rows),{maxRawBytes:128}),{code:'work_data.journal_observation_source_limit',resource:'raw-bytes',limit:128});assert.equal(f.state.reads,0);assert.equal(f.state.acquires,0);
 await assert.rejects(f.verify('sid',f.head(1),hash(rows),{maxDecodedBytes:100}),{code:'work_data.journal_observation_source_limit',resource:'decoded-bytes',limit:100});assert.equal(f.state.releases,1);assert.equal(f.state.closes,1);
 await fsp.writeFile(f.file,'1e20\n');await assert.rejects(f.verify('sid',f.head(1),hash([1e20]),{maxDecodedBytes:10}),{code:'work_data.journal_observation_source_limit',resource:'canonical-bytes',limit:10});
 await f.write([null,null]);await assert.rejects(f.verify('sid',f.head(1),hash([null]),{maxRecords:1}),{code:'work_data.journal_observation_source_limit',resource:'records',limit:1});
 await assert.rejects(f.verify('sid',f.head(1),hash([null]),{maxRawBytes:32*1024*1024+1}),{code:'work_data.journal_observation_source_limit'});
});
test('corrupt, torn and unauthenticated extra suffixes cannot authorize an intact committed prefix',async t=>{
 const f=await fixture(t),rows=[{role:'tool',content:'original'}];
 for(const suffix of ['{broken\n','\n','{"role":"tool"}',Buffer.from([0xff,10])]){await f.write(rows);await fsp.appendFile(f.file,suffix);await assert.rejects(f.verify('sid',f.head(1),hash(rows)),{code:'work_data.journal_observation_source_unverified'});}
 await f.write([...rows,{role:'tool',content:'tail'}],{encrypted:true});const lines=(await fsp.readFile(f.file,'utf8')).trimEnd().split('\n');await fsp.writeFile(f.file,lines[0]+'\n'+lines[0]+'\n');await assert.rejects(f.verify('sid',f.head(1),hash(rows)),{code:'work_data_record.ordinal_mismatch'});assert.equal(f.state.releases,1);
});
test('source mutation and aliases are rejected without repairing the provider body',async t=>{
 const f=await fixture(t),rows=[{role:'tool',content:'x'.repeat(70000)}];await f.write(rows);const original=await fsp.readFile(f.file);
 f.state.readHook=async count=>{if(count===1)await fsp.appendFile(f.file,'null\n');};await assert.rejects(f.verify('sid',f.head(1),hash(rows)),{code:'work_data.journal_observation_source_unverified'});assert.equal((await fsp.readFile(f.file)).length,original.length+5);
 f.state.readHook=null;await fsp.writeFile(f.file,original);const alias=path.join(f.root,'alias');await fsp.link(f.file,alias);await assert.rejects(f.verify('sid',f.head(1),hash(rows)),{code:'work_data.journal_observation_source_alias'});
});
test('permission/key and key/fd cleanup failures retain typed errors and release all acquired resources',async t=>{
 const f=await fixture(t),rows=[{role:'tool',content:'secret'}];await f.write(rows,{encrypted:true});
 f.io.open=async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});};await assert.rejects(f.verify('sid',f.head(1),hash(rows)),{code:'EACCES'});assert.equal(f.state.acquires,0);
 const g=await fixture(t);await g.write(rows,{encrypted:true});g.state.acquireError=Object.assign(Error('key unavailable'),{code:'work_data_key.unavailable'});await assert.rejects(g.verify('sid',g.head(1),hash(rows)),{code:'work_data_key.unavailable'});assert.equal(g.state.closes,1);assert.equal(g.state.releases,0);
 g.state.acquireError=null;g.state.releaseError=Object.assign(Error('key release refused'),{code:'work_data_key.release_failed'});g.state.closeError=Object.assign(Error('close refused'),{code:'ECLOSE'});
 await assert.rejects(g.verify('sid',g.head(1),hash(rows)),error=>error.code==='work_data_key.release_failed'&&error.errors.length===2&&error.errors[1].code==='ECLOSE');assert.equal(g.state.closes,2);assert.equal(g.state.releases,1);
});
test('legacy in-memory provider history retains exact hashing but obeys signer budget',async t=>{
 const f=await fixture(t),history=[{role:'tool',content:'legacy'}],head={id:'sid',providerHistory:history};assert.equal(await f.verify('sid',head,hash(history)),true);
 await assert.rejects(f.verify('sid',head,hash(history),{maxDecodedBytes:4}),{code:'work_data.journal_observation_source_limit',resource:'canonical-bytes'});assert.equal(f.state.reads,0);
});
