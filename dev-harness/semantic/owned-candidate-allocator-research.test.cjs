'use strict';
// Execute the actual inserted allocator function with an instrumented process
// seam. No process or native code is started by these tests.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const fragment=fs.readFileSync(process.env.CANDIDATE_ALLOCATOR_FRAGMENT||'dev-harness/semantic/owned-candidate-allocator-research.jsfrag','utf8');
function setup({timeout=false,afterStillAlive=false,receiptFail=false}={}){
 const root=path.resolve('C:/synthetic-data'),temp=path.resolve('C:/isolated-temp'),owner={},candidate=Object.freeze({id:'a'.repeat(48),root:path.join(root,'.work-data','generations','a'.repeat(48))});
 const issued=new Set(),children=new WeakMap(),queries=[],calls=[],audit=[];let observedError;
 const nativeChild={pid:4321},observation={child:nativeChild,closeObserved:false,closeCode:null,closeSignal:null},broker={async command(x){calls.push(x.cmd);if(x.cmd==='research-candidate-start')return{kind:'candidate-directory-created-v1',token:'b'.repeat(64),root:candidate.root,relative:'',id:'1'.repeat(24),parentId:null,created:true};if(x.cmd==='research-candidate-close')return{closed:true};throw Error('unexpected');},async close(){issued.delete(nativeChild);observation.closeObserved=true;observation.closeCode=0;observation.closeSignal=null;}};
 async function brokerFactory(){children.set(broker,observation);issued.add(nativeChild);return broker;}brokerFactory.helperMayStillRun=false;
 const fsp={async mkdtemp(){return path.join(temp,'ruyi-candidate-observer-owned');},async writeFile(){},async open(){if(receiptFail)throw Error('audit_disk_failed');return{async writeFile(value){audit.push(JSON.parse(value));},async sync(){},async close(){}};},async lstat(){return{dev:1n,ino:2n,isDirectory:()=>true,isSymbolicLink:()=>false};},async realpath(p){return p;}};
 function spawn(exe,args,opts){const child=new EventEmitter();child.stdout=new EventEmitter();queries.push({exe,args,opts,child});if(!timeout)queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(queries.length===1||afterStillAlive?'123456\n':'ABSENT\n'));child.emit('close',0,null);});return child;}
 const context={path,crypto,fsp,Buffer,process:{env:{SystemRoot:'C:/Windows'}},__dirname:path.resolve('C:/application/app'),migrationCapsuleIssuedChildren:issued,migrationCapsuleBrokerChildren:children,migrationCapsuleBroker:brokerFactory,migrationCapsuleFail:reason=>{throw Object.assign(Error(reason),{code:'work_data_backup.'+reason});},require:name=>name==='node:os'?{tmpdir:()=>temp}:name==='node:child_process'?{spawn}:require(name),setTimeout:timeout?fn=>{queueMicrotask(fn);return 1;}:setTimeout,clearTimeout:timeout?()=>{}:clearTimeout};
 vm.createContext(context);const api=vm.runInContext(fragment+'\n({run:migrationCreateCandidateBoundary,retained:migrationCandidateRetained})',context);
 const args={candidate,root,sourceProof:{sourceFiles:[],sourceDirectories:[{path:''}]},assertIssued:value=>value===candidate,ownership:owner,assertExclusive:value=>value===owner,assertIntent:async()=>{},onNativeCause:value=>{observedError=value;}};
 return{api,args,queries,calls,audit,owner,nativeChild,broker,issued,observed:()=>observedError};
}
test('allocator binds exact child identity and only releases after observed OS absence',async()=>{
 const f=setup(),result=await f.api.run(f.args);assert.equal(result.candidate,f.args.candidate);assert.equal(result.id,'1'.repeat(24));assert.deepEqual(f.calls,['research-candidate-start','research-candidate-close']);assert.equal(f.issued.size,0);assert.equal(f.queries.length,2);
 for(const q of f.queries){assert.ok(q.exe.endsWith(path.join('System32','WindowsPowerShell','v1.0','powershell.exe')));assert.deepEqual(Array.from(q.args.slice(0,2)),['-NoProfile','-NonInteractive']);assert.match(q.args[3],/ProgressPreference/);assert.ok(q.opts.env.PSModuleAnalysisCachePath.includes('ruyi-candidate-observer-owned'));for(const key of ['NODE_OPTIONS','COMPLUS_Version','PSModulePath'])assert.equal(Object.hasOwn(q.opts.env,key),false);}
 assert.deepEqual(f.audit[0].native,{pid:4321,creationFileTime:'123456',closeObserved:true,closeCode:0,closeSignal:null,osIdentityChecked:true,sameIdentityAbsent:true});assert.equal(f.audit[0].status,'success');
});
test('identity query timeout retains actual helper, query child and owner, before issuing native command',async()=>{
 const f=setup({timeout:true});await assert.rejects(()=>f.api.run(f.args),e=>e.helperMayStillRun===true&&e.ownershipRetained===true);assert.deepEqual(f.calls,[]);assert.equal(f.observed().helperMayStillRun,true);assert.ok([...f.api.retained].some(x=>x.nativeChild===f.nativeChild&&x.ownership===f.owner));assert.ok([...f.api.retained].some(x=>x.nativeChild===f.queries[0].child&&x.ownership===f.owner));assert.equal(f.audit[0].status,'unknown');assert.equal(f.audit[0].native.osIdentityChecked,false);
});
test('an original baseline path cannot be excluded as a new candidate',async()=>{
 const f=setup();f.args.sourceProof.sourceDirectories.push({path:'.work-data/generations/'+f.args.candidate.id});await assert.rejects(()=>f.api.run(f.args),e=>e.code==='work_data_backup.candidate_baseline');assert.equal(f.queries.length,0);
});
test('owner loss after create closes and checks the same native identity before returning failure',async()=>{
 const f=setup();let allowed=true;f.args.assertExclusive=value=>allowed&&value===f.owner;const command=f.broker.command;
 f.broker.command=async value=>{const receipt=await command(value);if(value.cmd==='research-candidate-start')allowed=false;return receipt;};
 await assert.rejects(()=>f.api.run(f.args),e=>e.code==='work_data_backup.candidate_authority');assert.equal(f.queries.length,2);assert.equal(f.issued.size,0);assert.equal(f.api.retained.size,0);assert.equal(f.audit[0].status,'failure');assert.equal(f.audit[0].native.sameIdentityAbsent,true);
});
test('failure cleanup fences and holds actual owner if OS still reports the same identity',async()=>{
 const f=setup({afterStillAlive:true});let allowed=true;f.args.assertExclusive=value=>allowed&&value===f.owner;const command=f.broker.command;
 f.broker.command=async value=>{const receipt=await command(value);if(value.cmd==='research-candidate-start')allowed=false;return receipt;};
 await assert.rejects(()=>f.api.run(f.args),e=>e.helperMayStillRun===true&&e.ownershipRetained===true);assert.equal(f.queries.length,2);assert.ok([...f.api.retained].some(x=>x.nativeChild===f.nativeChild&&x.ownership===f.owner));
});
test('audit write failure retains owner and does not mask the prior primary',async()=>{
 const f=setup({receiptFail:true});let allowed=true;f.args.assertExclusive=value=>allowed&&value===f.owner;const command=f.broker.command;
 f.broker.command=async value=>{const receipt=await command(value);if(value.cmd==='research-candidate-start')allowed=false;return receipt;};
 await assert.rejects(()=>f.api.run(f.args),e=>e.code==='work_data_backup.candidate_audit_unverified'&&e.ownershipRetained===true&&e.cause?.cause?.code==='work_data_backup.candidate_authority');
 assert.ok([...f.api.retained].some(x=>x.ownership===f.owner));
});
