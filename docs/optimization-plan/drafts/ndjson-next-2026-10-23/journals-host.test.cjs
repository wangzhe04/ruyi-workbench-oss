'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const repo=process.cwd(),{loadWorkDataChunks}=require(path.join(repo,'dev-harness/lib/work-data-chunks-fixture'));
const {constBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const bDir=String.raw`C:\Users\87179\AppData\Local\Temp\ruyi-work-keys-B-5b890aa746cf4898b4c7557a69001c12`;
const base=loadWorkDataChunks(),root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-journal-host-'));
after(()=>{assert.ok(path.basename(root).startsWith('ruyi-journal-host-'));fs.rmSync(root,{recursive:true,force:true});});
function fixture(kind='steward-inbox'){
 const dir=fs.mkdtempSync(path.join(root,'f-')),file=path.join(dir,'events.ndjson'),key=crypto.randomBytes(32),leased=[];
 const state={enabled:true,instanceId:'c'.repeat(32),acquires:0,releases:0};
 const context={sessionId:'steward',kind,...kind==='agent-run-events'?{runId:'run_test'}:{}};
 const keys={snapshot:async()=>{state.acquires++;if(state.keyError)throw state.keyError;const owned=Buffer.from(key);leased.push(owned);return {key:owned,instanceId:state.instanceId,release:()=>{state.releases++;owned.fill(0);}};}};
 const records=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'src/01q-work-data-records.js'),'utf8')+'\nWorkDataRecords;',{require,Buffer,WorkDataCrypto:base.crypto,WorkDataChunks:base.chunks});
 const store=vm.runInNewContext(constBlock(fs.readFileSync(path.join(bDir,'01p-work-data-store.js'),'utf8'),'WorkDataStore')+'\nWorkDataStore;',{require,Buffer,WorkDataCrypto:base.crypto,WorkDataChunks:base.chunks});
 const io={...fsp,truncate:async(...args)=>{state.truncates=(state.truncates||0)+1;if(state.failTruncate)throw Object.assign(Error('rollback truncate denied'),{code:'EIO'});return fsp.truncate(...args);},open:async(name,mode,...args)=>{
  const handle=await fsp.open(name,mode,...args);
  if(name===(state.appendTarget||file)&&mode==='a'&&state.failAppend){let writes=0;return new Proxy(handle,{get(target,property){if(property==='write')return async(...writeArgs)=>{if(++writes>1)throw Object.assign(Error('injected disk failure'),{code:'ENOSPC'});return target.write(...writeArgs);};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});}
  return handle;
 }};
 const codec={...records,encodeRecordFactory:(...args)=>{if(state.encodeError)throw state.encodeError;if(state.onEncode)state.onEncode();return records.encodeRecordFactory(...args);}};
 const journals=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'src/01s-work-data-journals.js'),'utf8')+'\nWorkDataJournals;',{require:name=>name==='node:fs/promises'?io:require(name),Buffer,WorkDataStore:store,WorkDataRecords:codec,WorkDataChunks:base.chunks});
 const journal=journals.create({file,context,keys,enabled:async()=>state.enabled,writeJson:base.atomicWriteJson});
 const append=rows=>journal.append(rows,async()=>{let raw='';try{raw=await fsp.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}const cut=raw.lastIndexOf('\n')+1;await fsp.writeFile(file,raw.slice(0,cut)+rows.join('\n')+'\n');});
 const released=()=>{assert.equal(state.releases,leased.length);leased.forEach(k=>assert.ok(k.equals(Buffer.alloc(32))));};
 const encode=(text,ordinal)=>records.encodeLine(text,key,{...context,instanceId:state.instanceId,ordinal});
 return {state,key,dir,file,journal,journals,append,released,encode,records,context,io,store,base};
}
test('OFF original writer bytes and already-read plain window do not acquire keys',async()=>{
 const f=fixture();f.state.enabled=false;f.state.keyError=Error('must not acquire');await f.append(['{"ordinary":1}']);assert.equal(await fsp.readFile(f.file,'utf8'),'{"ordinary":1}\n');
 const result=await f.journal.decodeLegacyWindow({text:'半行\n{"ordinary":2}\n',droppedHead:true},20,10);assert.equal(result.text,'半行\n{"ordinary":2}\n');assert.equal(result.droppedHead,true);assert.equal(f.state.acquires,0);
});
module.exports={fixture};
test('all three kinds stage large rows into one physical line and restore original logical bytes',async()=>{
 for(const kind of ['steward-inbox','steward-decisions','agent-run-events']){
  const f=fixture(kind),rows=[JSON.stringify({seq:400,secret:'密文😀'.repeat(180000)}),'{"seq":901}'];await f.append(rows);
  const raw=await fsp.readFile(f.file,'utf8');assert.equal(raw.split('\n').length,3);assert.equal(raw.includes('密文😀'),false);
  const result=await f.journal.readWindow(Infinity,1024);assert.equal(result.text,rows.join('\n')+'\n');assert.equal(result.count,2);assert.ok(result.authStamp);f.released();
 }
});
test('physical ordinals include blank/bad legacy rows and repair a multi-window torn suffix only after staging',async()=>{
 const f=fixture();await fsp.writeFile(f.file,'\nnot-json\n'+f.encode('{"seq":19}',2)+'\n'+'x'.repeat(150000));await f.append(['{"seq":20}']);
 const raw=await fsp.readFile(f.file,'utf8'),lines=raw.trimEnd().split('\n');assert.equal(lines.length,4);assert.equal(JSON.parse(lines[3]).e.seq,3);
 assert.equal((await f.journal.readWindow(Infinity,1)).text,'\nnot-json\n{"seq":19}\n{"seq":20}\n');f.released();
});
test('encode/key failure cannot cut the old torn tail or publish staging files',async()=>{
 const f=fixture();await fsp.writeFile(f.file,f.encode('{"old":1}',0)+'\n'+'t'.repeat(90000));const before=await fsp.readFile(f.file);
 f.state.encodeError=Object.assign(Error('capacity preflight'),{code:'work_data_chunk.limit'});await assert.rejects(f.append(['{"new":2}']),{code:'work_data_chunk.limit'});assert.ok((await fsp.readFile(f.file)).equals(before));assert.equal(f.state.truncates||0,0);assert.deepEqual((await fsp.readdir(f.dir)).filter(n=>n.includes('sealed-stage')),[]);
 f.state.encodeError=null;f.state.keyError=Object.assign(Error('missing'),{code:'work_data_key.absent'});await assert.rejects(f.append(['{"new":3}']),{code:'work_data_key.absent'});assert.ok((await fsp.readFile(f.file)).equals(before));f.released();
});
test('warm count cache reauthenticates key and instance; OFF downgrade refuses without unlock',async()=>{
 const f=fixture();await f.append(['{"old":1}']);const before=await fsp.readFile(f.file);f.state.instanceId='d'.repeat(32);await assert.rejects(f.append(['{"new":1}']),e=>String(e.code).startsWith('work_data'));assert.ok((await fsp.readFile(f.file)).equals(before));
 f.state.enabled=false;const count=f.state.acquires;await assert.rejects(f.append(['{"new":2}']),{code:'work_data_journal.downgrade_refused'});assert.equal(f.state.acquires,count);assert.ok((await fsp.readFile(f.file)).equals(before));f.released();
});
test('reordered committed ciphertext and malformed escaped reserved key cannot become legacy empty data',async()=>{
 const f=fixture();await fsp.writeFile(f.file,f.encode('{"one":1}',1)+'\n');await assert.rejects(f.journal.readWindow(Infinity,100),{code:'work_data_record.ordinal_mismatch'});
 await fsp.writeFile(f.file,'{"\\u0077":2,"e":\n');await assert.rejects(f.journal.readWindow(Infinity,100),{code:'work_data_record.corrupt'});f.released();
});
test('encrypted windows are chosen using decoded byte counts and retain legacy complete no-LF suffix',async()=>{
 const f=fixture(),rows=Array.from({length:70},(_,i)=>JSON.stringify({seq:i,text:'字'.repeat(40)}));await f.append(rows);const logical=Buffer.from(rows.join('\n')+'\n');
 const result=await f.journal.readWindow(2000,1200);assert.equal(result.droppedHead,true);assert.equal(result.text,logical.subarray(-1200).toString('utf8'));
 await fsp.appendFile(f.file,'{"legacy":"suffix"}');const all=await f.journal.readWindow(Infinity,1);assert.ok(all.text.endsWith('{"legacy":"suffix"}'));assert.equal(all.count,70);f.released();
});
test('source replacement during staging is refused before destructive repair',async()=>{
 const f=fixture();await fsp.writeFile(f.file,'{"legacy":1}\nTorn');const external='{"external":2}\n';f.state.onEncode=()=>{fs.appendFileSync(f.file,external);f.state.onEncode=null;};
 await assert.rejects(f.append(['{"new":3}']),{code:'work_data_journal.source_changed'});assert.equal(await fsp.readFile(f.file,'utf8'),'{"legacy":1}\nTorn'+external);assert.equal(f.state.truncates||0,0);f.released();
});
test('partial batch append rolls back complete first records before retry can duplicate them',async()=>{
 const f=fixture();await f.append(['{"old":1}']);const before=await fsp.readFile(f.file);f.state.failAppend=true;
 await assert.rejects(f.append(['{"small":1}',JSON.stringify({large:'z'.repeat(200000)})]),{code:'ENOSPC'});assert.ok((await fsp.readFile(f.file)).equals(before));f.state.failAppend=false;
 await f.append(['{"small":1}','{"retry":2}']);assert.equal((await f.journal.readWindow(Infinity,1)).text,'{"old":1}\n{"small":1}\n{"retry":2}\n');f.released();
});
test('replacement authenticates old rows then resets ordinals with atomic encrypted publication',async()=>{
 const f=fixture();await f.append(['{"one":1}','{"two":2}']);await f.journal.replace(['{"keep":2}'],()=>{throw Error('must not invoke plain writer');});
 assert.equal(JSON.parse((await fsp.readFile(f.file,'utf8')).trim()).e.seq,0);assert.equal((await f.journal.readWindow(Infinity,1)).text,'{"keep":2}\n');f.released();
 const before=await fsp.readFile(f.file);f.state.keyError=Object.assign(Error('key gone'),{code:'work_data_key.absent'});await assert.rejects(f.journal.replace(['{"bad":3}'],()=>{}),{code:'work_data_key.absent'});assert.ok((await fsp.readFile(f.file)).equals(before));
});
test('double filesystem failure gates later appends until explicit unchanged authenticated recovery',async()=>{
 const f=fixture();await f.append(['{"seq":1}']);f.state.failAppend=true;f.state.failTruncate=true;
 await assert.rejects(f.append(['{"seq":2}',JSON.stringify({seq:3,large:'x'.repeat(200000)})]),{code:'work_data_journal.recovery_required'});
 const partial=await fsp.readFile(f.file);assert.ok(partial.length>1000);assert.equal(f.journal.recoveryPending(),true);f.state.failAppend=false;f.state.failTruncate=false;
 await assert.rejects(f.append(['{"seq":4}']),{code:'work_data_journal.recovery_required'});
 const uiRead=await f.journal.readWindow(Infinity,1);assert.equal(uiRead.text,'{"seq":1}\n{"seq":2}\n');assert.equal(f.journal.recoveryPending(),true);
 await assert.rejects(f.append(['{"seq":4}']),{code:'work_data_journal.recovery_required'});assert.ok((await fsp.readFile(f.file)).equals(partial));
 await assert.rejects(f.journal.acknowledgeRecovery({}),{code:'work_data_journal.recovery_ticket'});
 await f.journal.acknowledgeRecovery(uiRead.recoveryTicket);assert.equal(f.journal.recoveryPending(),false);
 await f.append(['{"seq":3}']);assert.equal((await f.journal.readWindow(Infinity,1)).text,'{"seq":1}\n{"seq":2}\n{"seq":3}\n');f.released();
});
