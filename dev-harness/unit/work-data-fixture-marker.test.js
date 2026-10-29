'use strict';
// Real fixture functions with an in-memory filesystem/process host only.
// No native process, IPC, service, network or existing fixture is touched.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {functionBlock}=require('../lib/source-slice'),core=require('../lib/work-data-production-upload-core');
const {publishJsonOnce,markerFailure}=require('../lib/work-data-fixture-marker');
const {safeProducerError}=require('../lib/work-data-owned-claim-fixture');
const lib=path.resolve(__dirname,'../lib'),fixturePath=path.join(lib,'work-data-owned-claim-fixture.js'),producerPath=path.join(lib,'work-data-completed-claim-producer.cjs');
const fixture=fs.readFileSync(fixturePath,'utf8'),producer=fs.readFileSync(producerPath,'utf8');
const final=path.resolve('MEMORY-ONLY','producer-ready.json'),nonce='a'.repeat(32),staging=final+'.stage-'+nonce;
function memory({before=()=>{},after=()=>{}}={}){
 const nodes=new Map(),handles=new Map(),calls=[];let next=1;
 const fail=code=>Object.assign(Error('SYNTHETIC private error body'),{code});
 const node=file=>{const value=nodes.get(file);if(!value)throw fail('ENOENT');return value;};
 const effect=(name,args,work)=>{calls.push({name,args});before(name,args);const value=work();after(name,args);return value;};
 const io={
  mkdirSync(){},
  openSync(file,flags,mode){return effect('open',[file,flags,mode],()=>{if(nodes.has(file))throw fail('EEXIST');const row={bytes:Buffer.alloc(0),closed:false,flushed:false};nodes.set(file,row);const fd=next++;handles.set(fd,row);return fd;});},
  writeFileSync(fd,payload){return effect('write',[fd],()=>{const value=handles.get(fd);assert.ok(value);const bytes=Buffer.from(payload);value.bytes=bytes.subarray(0,Math.floor(bytes.length/2));after('partial-write',[fd]);value.bytes=Buffer.from(bytes);});},
  fsyncSync(fd){return effect('flush',[fd],()=>{const value=handles.get(fd);assert.ok(value);value.flushed=true;});},
  closeSync(fd){return effect('close',[fd],()=>{const value=handles.get(fd);assert.ok(value);value.closed=true;handles.delete(fd);});},
  linkSync(from,to){return effect('link',[from,to],()=>{if(nodes.has(to))throw fail('EEXIST');const value=node(from);assert.equal(value.closed,true);assert.equal(value.flushed,true);nodes.set(to,value);});},
  unlinkSync(file){return effect('unlink',[file],()=>{node(file);nodes.delete(file);});},
  readFileSync(file,encoding){calls.push({name:'read',args:[file]});const bytes=Buffer.from(node(file).bytes);return encoding?bytes.toString(encoding):bytes;},
 };
 return{io,nodes,handles,calls,put(file,text){nodes.set(file,{bytes:Buffer.from(text),closed:true,flushed:true});}};
}
function reader(io){return vm.runInNewContext(functionBlock(fixture,'waitJson')+'\nwaitJson',{fs:io,path,Date,core,safeProducerError,pause:()=>assert.fail('invalid JSON must not retry')},{filename:fixturePath});}
function publish(file,value,f,extra={}){return publishJsonOnce(file,value,{io:f.io,nonce:()=>nonce,...extra});}
test('negative control: visible final creation before write lets the unchanged JSON reader fail on empty content',async()=>{
 let early,read;const f=memory({after(name){if(name==='open'){early=read(final,30000);early.catch(()=>{});}}});read=reader(f.io);
 // The two old writers both exposed the final name at this exact open boundary.
 const oldWrite=vm.runInNewContext("function write(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}\nwrite",{fs:f.io,JSON});
 oldWrite(final,{schema:1,pid:7240});await assert.rejects(early,error=>error.name==='SyntaxError');
 assert.deepEqual(JSON.parse(f.io.readFileSync(final,'utf8')),{schema:1,pid:7240});
 assert.equal(f.calls.filter(call=>call.name==='read'&&call.args[0]===final).length,2,'one failed read plus this explicit final evidence read');
});
test('open, partial write, complete write, flush and close expose only ENOENT; first publication exposes the complete closed payload',()=>{
 const stages=[],value={schema:1,pid:7240,synthetic:'PRIVATE payload'};
 const f=memory({after(name){if(['open','partial-write','write','flush','close'].includes(name)){
  stages.push(name);assert.throws(()=>f.io.readFileSync(final),{code:'ENOENT'});
 }else if(name==='link')assert.deepEqual(JSON.parse(f.io.readFileSync(final,'utf8')),value);}});
 publish(final,value,f);assert.deepEqual(stages,['open','partial-write','write','flush','close']);
 assert.deepEqual([...f.nodes.keys()],[final]);assert.equal(f.handles.size,0);
 assert.equal(f.calls.filter(call=>call.name==='link').length,1);
});
test('an existing marker keeps its bytes and identity, and an existing staging name is never removed',()=>{
 const f=memory();f.put(final,'ORIGINAL');const original=f.nodes.get(final);let error;
 assert.throws(()=>publish(final,{replace:'FORBIDDEN'},f),value=>{error=value;return value.code==='EEXIST';});
 assert.strictEqual(f.nodes.get(final),original);assert.equal(original.bytes.toString(),'ORIGINAL');assert.deepEqual([...f.nodes.keys()],[final]);
 assert.equal(markerFailure(error).stage,'publish');assert.equal(markerFailure(error).published,false);
 const g=memory();g.put(staging,'OTHER STAGE');const stage=g.nodes.get(staging);
 assert.throws(()=>publish(final,{schema:1},g),{code:'EEXIST'});assert.strictEqual(g.nodes.get(staging),stage);assert.equal(g.nodes.has(final),false);
 assert.equal(g.calls.some(call=>call.name==='unlink'),false,'an uncreated staging name has no cleanup authority');
});
test('two competing publishers keep the winner and fail the loser without replacement',()=>{
 let competing=false;const f=memory({before(name){if(name==='link'&&!competing){competing=true;publish(final,{winner:2},f,{nonce:()=> 'b'.repeat(32)});}}});
 assert.throws(()=>publish(final,{winner:1},f),{code:'EEXIST'});assert.deepEqual(JSON.parse(f.io.readFileSync(final,'utf8')),{winner:2});
 assert.deepEqual([...f.nodes.keys()],[final]);
});
for(const [operation,stage] of [['open','stage-open'],['write','stage-write'],['flush','stage-flush'],['close','stage-close'],['link','publish'],['unlink','stage-unlink']])test(operation+' failure preserves its exact first error, safe stage and publication fact',()=>{
 const original=Object.freeze(Object.assign(Error('SECRET body, token and password'),{code:'EIO'}));let attempts=0;
 const f=memory({before(name){if(name===operation){attempts++;throw original;}}});
 assert.throws(()=>publish(final,{password:'SECRET payload'},f),error=>error===original);
 const diagnostic=markerFailure(original);assert.equal(diagnostic.stage,stage);assert.equal(diagnostic.published,operation==='unlink');assert.equal(diagnostic.code,'EIO');
 assert.equal(attempts,1,'the failed syscall is never retried');assert.equal(JSON.stringify(diagnostic).includes('SECRET'),false);
 if(operation==='unlink'){assert.equal(f.nodes.has(staging),true);assert.deepEqual(JSON.parse(f.io.readFileSync(final,'utf8')),{password:'SECRET payload'});}
 else assert.equal(f.nodes.has(final),false);
});
test('cleanup failures are retained as metadata and cannot replace a write failure or report success',()=>{
 const first=Object.assign(Error('PRIVATE write body'),{code:'ENOSPC'}),secondary=Object.assign(Error('PRIVATE cleanup body'),{code:'EACCES'});
 const f=memory({before(name){if(name==='write')throw first;if(name==='close'||name==='unlink')throw secondary;}});
 assert.throws(()=>publish(final,{private:'PRIVATE'},f,{onFailure(){throw Error('diagnostic sink failed');}}),error=>error===first);
 assert.deepEqual(markerFailure(first).cleanup,[{operation:'close',code:'EACCES'},{operation:'unlink',code:'EACCES'}]);
 assert.equal(f.nodes.has(final),false);assert.equal(f.nodes.has(staging),true);assert.equal(JSON.stringify(markerFailure(first)).includes('PRIVATE'),false);
});
test('serialization failure opens no file and invalid marker paths disclose no arbitrary basename',()=>{
 const first=Error('SECRET serialization'),f=memory();assert.throws(()=>publish(final,{toJSON(){throw first;}},f),error=>error===first);
 assert.equal(f.calls.length,0);assert.equal(markerFailure(first).stage,'serialize');
 for(const file of [null,'relative.json',path.resolve('SECRET.json')]){let caught;assert.throws(()=>publish(file,{},f),error=>{caught=error;return error instanceof TypeError;});assert.equal(markerFailure(caught).file,null);}
});
test('the actual parent and producer wrappers share the same publisher for every Node handshake marker',()=>{
 const names=['request','producer-go','producer-crash','job-target','job-release','job-hold'];
 for(const [text,markers] of [[fixture,names],[producer,['producer-ready','producer-owned']]]){
  const f=memory(),seen=[];
  const write=vm.runInNewContext(functionBlock(text,'write')+'\nwrite',{publishJsonOnce(file,value){seen.push(path.basename(file));publish(file,value,f);}});
  for(const marker of markers)write(path.resolve('MEMORY-ONLY',marker+'.json'),{schema:1,marker});
  assert.deepEqual(seen,markers.map(name=>name+'.json'));assert.equal(f.nodes.size,markers.length);assert.equal(f.calls.filter(call=>call.name==='link').length,markers.length);
 }
});
test('target binding includes the new shared publisher in the executing input set and rechecks it',()=>{
 const reads=[],boundFiles=Array.from({length:146},(_,index)=>({file:path.resolve('input-'+index),bytes:1,sha256:core.H(Buffer.from(String(index)))}));let baseChecks=0;
 const mock={...core,loadProductTarget:()=>({boundFiles,recheck(){baseChecks++;}}),read(file,pin){reads.push(file);return{row:pin||{file,bytes:1,sha256:core.H(Buffer.from(file))}};}};
 const bind=vm.runInNewContext(functionBlock(fixture,'bindTarget')+'\nbindTarget',{core:mock,path,Buffer,__filename:fixturePath,__dirname:lib,PRODUCER:producerPath});
 const target=bind(path.dirname(lib),path.resolve('entry.e2e.js'));assert.equal(target.boundFiles.length,150);
 const marker=path.join(lib,'work-data-fixture-marker.js');assert.equal(target.boundFiles.filter(row=>row.file===marker).length,1);assert.equal(target.recheck().files,150);
 assert.equal(baseChecks,1);assert.equal(reads.filter(file=>file===marker).length,2);
});
test('safe errors retain only fixed source frames and marker metadata, never messages, assertion values or arbitrary stack paths',()=>{
 const error=Object.assign(new SyntaxError('SECRET JSON'),{actual:'SECRET actual',expected:'SECRET expected'});
 error.stack='SyntaxError: SECRET JSON\n    at waitJson (C:\\SECRET\\work-data-owned-claim-fixture.js:31:8)\n    at secret (C:\\SECRET\\untrusted.js:2:1)\n    at runActual (C:\\SECRET\\work-data-completed-intent-recovery.e2e.js:84:19)';
 const value=safeProducerError(error);assert.equal(value.errorName,'SyntaxError');assert.deepEqual(value.frames,[{file:'work-data-owned-claim-fixture.js',line:31,column:8},{file:'work-data-completed-intent-recovery.e2e.js',line:84,column:19}]);
 assert.equal(JSON.stringify(value).includes('SECRET'),false);assert.equal(value.marker,null);
});
for(const text of ['', '{"schema":'])test('the first invalid JSON capture keeps its original error, bytes/hash and no retry even if diagnostics fail: '+JSON.stringify(text),async()=>{
 const f=memory();f.put(final,text);let failure;
 await assert.rejects(reader(f.io)(final,30000,value=>{failure=value;throw Error('PRIVATE diagnostic sink');}),error=>error.name==='SyntaxError');
 assert.equal(failure.file,'producer-ready.json');assert.equal(failure.capturedBytes,Buffer.byteLength(text));assert.equal(failure.capturedSha256,core.H(Buffer.from(text)));
 assert.equal(f.calls.filter(call=>call.name==='read').length,1);assert.equal(failure.errorName,'SyntaxError');assert.equal(failure.rawBodiesOmitted,true);
});

function modeledProducer({malformed=false,identityError=null}={}){
 const f=memory(),events=[],world={ctx:{phase:'disable-seed-disable-verify',unknown:false},healthy(){},record:row=>events.push(row),absentByCim:async()=>true,
  cimIdentity:async()=>{if(identityError)throw identityError;assert.fail('identity must not follow malformed JSON');}};
 const processState={pid:7240,spawnSeen:true,exitSeen:false,closeSeen:false,exitCode:null,exitSignal:null,closeCode:null,closeSignal:null};
 const manager={start(command,args){const request=JSON.parse(f.io.readFileSync(args[1],'utf8'));f.put(path.join(request.commands,'producer-ready.json'),malformed?'':JSON.stringify({schema:1,pid:7240}));return{spawned:Promise.resolve()};},pid:()=>7240,inspect:()=>processState};
 const mockCore={...core,read:()=>({bytes:Buffer.from('pure modeled source'),row:{}})};
 const modules={'node:fs':f.io,'node:path':path,'node:child_process':{spawn(command,args,options){f.put(path.join(options.env.RUYI_PM_ROOT,'job-ready.json'),'{}');return{unref(){},exitCode:0};}},'node:assert/strict':assert,
  './work-data-production-upload-core':mockCore,'../work-data-production-upload.e2e':{loadPure:()=>({canonicalRoot:async value=>value})},
  './work-data-production-upload-process':{createProcesses:()=>manager,createStrictStop:()=>()=>assert.fail('no stop')},'./kill-own-tree':{snapshotProcessTable:()=>assert.fail('no real snapshot'),ownDescendants:()=>assert.fail('no real lineage')},
  './work-data-fixture-marker':{publishJsonOnce:(file,value)=>publish(file,value,f),markerFailure}};
 const context={require:name=>{assert.ok(Object.hasOwn(modules,name),name);return modules[name];},module:{exports:{}},__dirname:lib,__filename:fixturePath,process:{execPath:'PURE NODE'},Buffer,Date,setTimeout:()=>assert.fail('no deadline wait')};
 vm.runInNewContext(fixture,context,{filename:fixturePath});
 const root=path.resolve('MEMORY-ONLY'),api=context.module.exports.createProducer({world,target:{src:root,recheck(){}},harness:root,root,evidence:root,label:'disable-producer'});
 return{f,events,world,api,options:{f:{base:root,temp:root,env:{}},id:'a'.repeat(48),operation:'disable',ownedAt:'2026-10-29T00:00:00.000Z',parent:{pid:1,port:12345,identity:{pid:1}}}};
}
test('real producer fixture stages distinguish invalid ready JSON from identity failure without inventing an exit or close',async()=>{
 const invalid=modeledProducer({malformed:true});await assert.rejects(invalid.api.run(invalid.options),error=>error.name==='SyntaxError');
 assert.equal(invalid.world.ctx.phase,'disable-producer-ready-json');assert.equal(invalid.api.diagnostic().jsonFailure.capturedBytes,0);
 assert.equal(invalid.api.diagnostic().process.spawnSeen,true);assert.equal(invalid.api.diagnostic().process.exitSeen,false);assert.equal(invalid.api.diagnostic().process.closeSeen,false);
 const original=Error('PRIVATE unavailable CIM'),identity=modeledProducer({identityError:original});await assert.rejects(identity.api.run(identity.options),error=>error===original);
 assert.equal(identity.world.ctx.phase,'disable-producer-identity');assert.equal(identity.api.diagnostic().jsonFailure,null);assert.equal(JSON.stringify(identity.api.diagnostic()).includes('PRIVATE'),false);
 assert.deepEqual(identity.events.map(row=>row.stage),['precondition','keeper-ready','spawn','spawn-event','ready-json','identity']);
});
