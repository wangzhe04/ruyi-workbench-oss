'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const repo=process.cwd(),{loadWorkDataChunks}=require(path.join(repo,'dev-harness/lib/work-data-chunks-fixture'));
const {constBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const base=loadWorkDataChunks(),root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-journal-host-'));
after(()=>{assert.ok(path.basename(root).startsWith('ruyi-journal-host-'));fs.rmSync(root,{recursive:true,force:true});});
function fixture(kind='steward-inbox'){
 const dir=fs.mkdtempSync(path.join(root,'f-')),file=path.join(dir,'events.ndjson'),key=crypto.randomBytes(32),leased=[];
 const state={enabled:true,instanceId:'c'.repeat(32),acquires:0,releases:0};
 const context={sessionId:'steward',kind,...kind==='agent-run-events'?{runId:'run_test'}:{}};
 const keys={snapshot:async()=>{state.acquires++;if(state.keyError)throw state.keyError;const owned=Buffer.from(key);leased.push(owned);return {key:owned,instanceId:state.instanceId,release:()=>{state.releases++;owned.fill(0);}};}};
 const records=vm.runInNewContext(fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/01q-work-data-records.js'),'utf8')+'\nWorkDataRecords;',{require,Buffer,WorkDataCrypto:base.crypto,WorkDataChunks:base.chunks});
 const store=vm.runInNewContext(constBlock(fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/01p-work-data-store.js'),'utf8'),'WorkDataStore')+'\nWorkDataStore;',{require,Buffer,WorkDataCrypto:base.crypto,WorkDataChunks:base.chunks});
 const io={...fsp,stat:async(name,options)=>name===file&&state.frozenStat?state.frozenStat:fsp.stat(name,options),truncate:async(...args)=>{state.truncates=(state.truncates||0)+1;if(state.failTruncate)throw Object.assign(Error('rollback truncate denied'),{code:'EIO'});return fsp.truncate(...args);},open:async(name,mode,...args)=>{
  const handle=await fsp.open(name,mode,...args);
  if((name===(state.appendTarget||file)||state.appendTargets?.has(name))&&mode==='a'&&state.failAppend){let writes=0;return new Proxy(handle,{get(target,property){if(property==='write')return async(...writeArgs)=>{if(++writes>1)throw Object.assign(Error('injected disk failure'),{code:'ENOSPC'});return target.write(...writeArgs);};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});}
  return new Proxy(handle,{get(target,property){if(property==='stat'&&name===file&&state.frozenStat)return async()=>state.frozenStat;const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
 }};
 const codec={...records,encodeRecordFactory:(...args)=>{if(state.encodeError)throw state.encodeError;if(state.onEncode)state.onEncode();return records.encodeRecordFactory(...args);}};
 const journals=vm.runInNewContext(fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/01s-work-data-journals.js'),'utf8')+'\nWorkDataJournals;',{require:name=>name==='node:fs/promises'?io:require(name),Buffer,WorkDataStore:store,WorkDataRecords:codec,WorkDataChunks:base.chunks});
 const journal=journals.create({file,context,keys,enabled:async()=>state.enabled,writeJson:async(...args)=>{if(state.writeError)throw state.writeError;return base.atomicWriteJson(...args);},validateSealedLine:(plain,ordinal)=>state.validate?state.validate(plain,ordinal):true});
 const append=rows=>journal.append(rows,async()=>{let raw='';try{raw=await fsp.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}const cut=raw.lastIndexOf('\n')+1;await fsp.writeFile(file,raw.slice(0,cut)+rows.join('\n')+'\n');});
 const released=()=>{assert.equal(state.releases,leased.length);leased.forEach(k=>assert.ok(k.equals(Buffer.alloc(32))));};
 const encode=(text,ordinal)=>JSON.stringify({w:2,e:base.crypto.seal(text,key,{purpose:kind==='agent-run-events'?'task':'queue',instanceId:state.instanceId,schema:2,scopeId:context.sessionId,recordId:kind+(kind==='agent-run-events'?':'+context.runId:'')+':'+ordinal,seq:ordinal})});
 return {state,key,keys,dir,file,journal,journals,append,released,encode,records,context,io,store,base};
}
test('OFF original writer bytes and warm plain legacy window do not acquire keys',async()=>{
 const f=fixture();f.state.enabled=false;f.state.keyError=Error('must not acquire');await f.append(['{"ordinary":1}']);assert.equal(await fsp.readFile(f.file,'utf8'),'{"ordinary":1}\n');
 const result=await f.journal.readWindow(20,10,null,false,async()=>({text:'half\n{"ordinary":2}\n',droppedHead:true}));assert.equal(result.text,'half\n{"ordinary":2}\n');assert.equal(result.droppedHead,true);assert.equal(f.state.acquires,0);
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
 const rebuilt=await f.journal.readWindow(0,0,()=>{});
 await f.journal.acknowledgeRecovery(rebuilt.recoveryTicket);assert.equal(f.journal.recoveryPending(),false);
 await f.append(['{"seq":3}']);assert.equal((await f.journal.readWindow(Infinity,1)).text,'{"seq":1}\n{"seq":2}\n{"seq":3}\n');f.released();
});

test('same complete stat tuple never authorizes tampered sealed append or plaintext downgrade',async()=>{
 const f=fixture();await f.append(['{"secret":"committed"}']);const raw=await fsp.readFile(f.file,'utf8');f.state.frozenStat=await fsp.stat(f.file,{bigint:true});
 const row=JSON.parse(raw),cipher=row.e.envelope.ciphertext;row.e.envelope.ciphertext=(cipher[0]==='A'?'B':'A')+cipher.slice(1);const tampered=JSON.stringify(row)+'\n';assert.equal(Buffer.byteLength(tampered),Buffer.byteLength(raw));await fsp.writeFile(f.file,tampered);
 await assert.rejects(f.append(['{"new":1}']),{code:'work_data_record.authenticate_failed'});assert.equal(await fsp.readFile(f.file,'utf8'),tampered);f.released();
 const g=fixture(),sealed=g.encode('{"secret":"external"}',0)+'\n';g.state.enabled=false;const legacy=JSON.stringify({padding:'x'.repeat(Buffer.byteLength(sealed)-15)})+'\n';assert.equal(Buffer.byteLength(legacy),Buffer.byteLength(sealed));await fsp.writeFile(g.file,legacy);await g.journal.readWindow(10000,100,null,false,async()=>({text:legacy,droppedHead:false}));g.state.frozenStat=await fsp.stat(g.file,{bigint:true});await fsp.writeFile(g.file,sealed);
 await assert.rejects(g.append(['{"new":2}']),{code:'work_data_journal.downgrade_refused'});const read=await g.journal.readWindow(10000,100,null,false,async()=>({text:sealed,droppedHead:false}));assert.equal(read.text,'{"secret":"external"}\n');assert.equal(await fsp.readFile(g.file,'utf8'),sealed);g.released();
});
test('cold large OFF discovers a hidden complete sealed row outside the physical tail',async()=>{
 const f=fixture(),first=JSON.stringify({seq:1,secret:'z'.repeat(900000)});await fsp.writeFile(f.file,f.encode(first,0)+'\n');const plain=Buffer.from(first+'\n');assert.ok((await fsp.stat(f.file)).size>1024*1024);f.state.enabled=false;
 const result=await f.journal.readWindow(1024*1024,100000,null,false,async()=>({text:(await fsp.readFile(f.file)).subarray(-100000).toString('utf8'),droppedHead:true}));assert.equal(result.droppedHead,false);assert.equal(result.text,plain.toString('utf8'));f.released();
});
test('giant ordinary OFF row is classified without materializing its bytes in the owner',async()=>{
 const f=fixture();f.state.enabled=false;f.state.keyError=Error('no key');await fsp.writeFile(f.file,'{"text":"'+'x'.repeat(12*1024*1024)+'"}\n');let reads=0;const original=f.io.open;f.io.open=async(...args)=>{if(args[1]==='r')reads++;return original(...args);};
 for(let i=0;i<2;i++){const result=await f.journal.readWindow(1024*1024,1000,null,false,async()=>({text:'x'.repeat(996)+'"}\n',droppedHead:true}));assert.equal(result.droppedHead,true);assert.equal(result.text.length,999);}
 assert.equal(reads,2,'one constant-memory metadata pass per read, including warm stat collisions');assert.equal(f.state.acquires,0);
});

test('sealed domain shape fails before publication while ordinary legacy skip policy is unchanged',async()=>{
 const f=fixture();await f.append(['{"wrong":1}']);f.state.validate=plain=>Number.isSafeInteger(JSON.parse(plain).seq);const before=await fsp.readFile(f.file);await assert.rejects(f.journal.readWindow(Infinity,1),{code:'work_data_journal.shape'});await assert.rejects(f.append(['{"seq":2}']),{code:'work_data_journal.shape'});assert.ok((await fsp.readFile(f.file)).equals(before));
 await fsp.writeFile(f.file,'not-json\n');assert.equal((await f.journal.readWindow(Infinity,1)).text,'not-json\n');f.released();
});
test('borrowed operation spans preflight/read/append and releases exactly one key lease',async()=>{
 const f=fixture();await f.journal.withOperation(async operation=>{await f.journal.preflight(operation);await f.journal.readWindow(Infinity,1,null,false,null,operation);await f.journal.append(['{"seq":1}'],()=>{},operation);assert.equal(f.state.releases,0);});assert.equal(f.state.acquires,1);assert.equal(f.state.releases,1);f.released();
});
test('recovery acknowledgement refuses a changed full stream even under an identical stat tuple',async()=>{
 const f=fixture();await f.append(['{"seq":1}']);f.state.failAppend=true;f.state.failTruncate=true;await assert.rejects(f.append(['{"seq":2}',JSON.stringify({seq:3,large:'x'.repeat(200000)})]),{code:'work_data_journal.recovery_required'});f.state.failAppend=false;f.state.failTruncate=false;
 const rebuilt=await f.journal.readWindow(0,0,()=>{});f.state.frozenStat=await fsp.stat(f.file,{bigint:true});const raw=await fsp.readFile(f.file,'utf8');const first=raw.indexOf('\n');const changed=f.encode('{"seq":9}',0)+raw.slice(first);assert.equal(Buffer.byteLength(changed),Buffer.byteLength(raw));await fsp.writeFile(f.file,changed);
 await assert.rejects(f.journal.acknowledgeRecovery(rebuilt.recoveryTicket),{code:'work_data_journal.recovery_changed'});assert.equal(f.journal.recoveryPending(),true);f.released();
});

test('a complete sealed suffix without LF cannot be repaired into OFF plaintext',async()=>{
 const f=fixture(),raw=f.encode('{"seq":1}',0);await fsp.writeFile(f.file,raw);assert.equal((await f.journal.readWindow(Infinity,1)).text,'{"seq":1}');f.state.enabled=false;
 await assert.rejects(f.append(['{"seq":2}']),{code:'work_data_journal.downgrade_refused'});assert.equal(await fsp.readFile(f.file,'utf8'),raw);assert.equal(f.state.truncates||0,0);f.released();
});

test('ON empty authority proof still requires current key and stage validates only sealed writes',async()=>{
 const f=fixture();f.state.keyError=Object.assign(Error('gone'),{code:'work_data_key.absent'});await assert.rejects(f.journal.checkAuthority(''),{code:'work_data_key.absent'});f.state.keyError=null;f.state.validate=()=>false;
 await assert.rejects(f.append(['{"wrong":1}']),{code:'work_data_journal.shape'});assert.equal(fs.existsSync(f.file),false);assert.deepEqual((await fsp.readdir(f.dir)).filter(name=>name.includes('stage')),[]);
 f.state.enabled=false;await f.append(['not-json']);assert.equal(await fsp.readFile(f.file,'utf8'),'not-json\n');f.released();
});

test('ON authenticated complete sealed no-LF suffix is readable but never silently retired by mutation',async()=>{
 const f=fixture(),raw=f.encode('{"seq":1}',0);await fsp.writeFile(f.file,raw);assert.equal((await f.journal.readWindow(Infinity,1)).text,'{"seq":1}');
 await assert.rejects(f.append(['{"seq":2}']),{code:'work_data_journal.sealed_tail_uncommitted'});await assert.rejects(f.journal.replace(['{"seq":2}'],()=>{}),{code:'work_data_journal.sealed_tail_uncommitted'});assert.equal(await fsp.readFile(f.file,'utf8'),raw);assert.equal(f.state.truncates||0,0);
 await fsp.appendFile(f.file,'\n');await f.append(['{"seq":2}']);assert.equal((await f.journal.readWindow(Infinity,1)).text,'{"seq":1}\n{"seq":2}\n');f.released();
});

test('independent writers reserve the final recovery slot before asynchronous staging',async()=>{
 const f=fixture(),targets=Array.from({length:65},(_,index)=>path.join(f.dir,'slot-'+index+'.ndjson'));
 f.state.failAppend=true;f.state.failTruncate=true;f.state.appendTargets=new Set(targets);
 const journal=file=>f.journals.create({file,context:f.context,keys:f.keys,enabled:async()=>true,writeJson:f.base.atomicWriteJson});
 const rows=[JSON.stringify({text:'x'.repeat(50000)})];
 for(let index=0;index<63;index++)await assert.rejects(journal(targets[index]).append(rows,()=>{}),{code:'work_data_journal.recovery_required'});
 let atA,atB,release;const reachedA=new Promise(resolve=>{atA=resolve;}),reachedB=new Promise(resolve=>{atB=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const original=f.io.open;f.io.open=async(name,mode,...args)=>{if(mode==='wx'&&(name.startsWith(targets[63]+'.sealed-stage-')||name.startsWith(targets[64]+'.sealed-stage-'))){if(name.startsWith(targets[63]))atA();else atB('entered-stage');await gate;}return original(name,mode,...args);};
 const a=journal(targets[63]).append(rows,()=>{}).catch(error=>error);await reachedA;
 const b=journal(targets[64]).append(rows,()=>{}).catch(error=>error);let observed;
 try{observed=await Promise.race([b,reachedB]);}finally{release();}
 const [aResult,bResult]=await Promise.all([a,b]);assert.equal(observed.code,'work_data_journal.recovery_capacity');assert.equal(aResult.code,'work_data_journal.recovery_required');assert.equal(bResult.code,'work_data_journal.recovery_capacity');assert.equal(fs.existsSync(targets[64]),false);f.released();
});

test('replacement releases its reservation on success, staging failure and publication failure',async()=>{
 for(const phase of ['success','stage','publish']){
  const f=fixture();await f.append(['{"old":1}']);
  if(phase==='stage')f.state.encodeError=Object.assign(Error('stage rejected'),{code:'work_data_chunk.limit'});
  if(phase==='publish')f.state.writeError=Object.assign(Error('publish rejected'),{code:'ENOSPC'});
  if(phase==='success')await f.journal.replace(['{"first":1}'],()=>{});
  else await assert.rejects(f.journal.replace(['{"first":1}'],()=>{}),{code:phase==='stage'?'work_data_chunk.limit':'ENOSPC'});
  f.state.encodeError=null;f.state.writeError=null;
  await f.journal.replace(['{"second":2}'],()=>{});await f.append(['{"after":3}']);
  assert.equal((await f.journal.readWindow(Infinity,1)).text,'{"second":2}\n{"after":3}\n');assert.deepEqual((await fsp.readdir(f.dir)).filter(name=>name.includes('stage')),[]);f.released();
 }
});
