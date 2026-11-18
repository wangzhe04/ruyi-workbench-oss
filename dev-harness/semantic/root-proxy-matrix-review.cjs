'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), cp=require('node:child_process'), a=require('node:assert/strict');
const H=b=>crypto.createHash('sha256').update(b).digest('hex');
const spec={
 'input-stalled':['13fdc1301eff33b00f1e7b73b2a935306b7a6211d39a6101faa22aca3bfe220f',19,1],
 concurrent:['6e5c1fa01a948053a05ff22211883f420d5a03102189534342c3a69a0913bc82',25,2]
};
const name=process.argv[2];a.ok(Object.hasOwn(spec,name));const [pin,count,groups]=spec[name];
const dir=path.resolve('output/semantic-resident-proxy-'+name+'-v1');
const read=file=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8').replace(/^\uFEFF/,''));
const f=read('freeze.json'),r=read('receipt.json'),o=read('outer-job-receipt.json');
a.equal(H(fs.readFileSync(path.join(dir,'freeze.json'))),pin);a.equal(f.bindings.length,count);
for(const row of f.bindings){const b=fs.readFileSync(row.file);a.equal(b.length,row.bytes);a.equal(H(b),row.sha256);}
a.equal(r.status,'PASS_PROXY_B3_MATRIX_NOT_MODEL_QUALIFICATION');a.equal(r.freezeSha256,pin);a.equal(r.bindingsStable,true);a.equal(r.groups.length,groups);
a.equal(o.controllerExitCode,0);a.equal(o.terminationRequested,false);a.equal(o.beforeReclaim.active,0);a.deepEqual(o.beforeReclaim.members,[]);a.equal(o.accounting.active,0);a.deepEqual(o.accounting.members,[]);
const identities=[{pid:o.controllerPid,creationFileTime:o.controllerCreationFileTime}],outputs=[];
if(name==='input-stalled'){
 a.equal(r.inputBackpressure.attemptedBytes,458752);a.equal(r.inputBackpressure.writeReturned,false);a.equal(r.inputBackpressure.callbackObserved,false);a.ok(r.inputBackpressure.facadeWritableLength>=65536);
}else{
 for(const field of ['survivorBeforeEcho','survivorAfterEcho'])a.deepEqual(r.concurrent[field],r.groups[1].owned.workerIdentity);
 a.notEqual(r.groups[0].owned.workerIdentity.pid,r.groups[1].owned.workerIdentity.pid);
}
const absent=(value,id)=>value?.pid===id.pid&&(value.exists===false||value.exists===true&&value.creationFileTime!==id.creationFileTime);
for(const [i,row]of r.groups.entries()){
 a.equal(row.cleanupCall,'fulfilled');a.deepEqual(row.errors,[]);const q=row.cleanup;
 a.equal(q.cleanupStatus,'observed');a.equal(q.workerExited,true);a.equal(q.helperExited,true);a.equal(q.innerActive,0);a.equal(q.stdoutDrained,true);a.equal(q.leaseCleanup.cleanupStatus,'observed');a.equal(q.leaseCleanup.retainedHandles,0);
 a.equal(q.close.code,0);a.equal(q.close.signal,null);a.equal(q.protocolError,null);a.equal(q.observationError,null);
 for(const role of ['helper','worker']){const id=row.owned[role+'Identity'];a.deepEqual(q[role+'Identity'],id);a.ok(absent(q[role+'Os'],id));a.ok(absent(row.postStopOs[role],id));identities.push(id);}
 let expected=JSON.stringify({type:'matrix-ready',pid:row.owned.workerIdentity.pid,mode:row.mode,hasIPC:false})+'\n';
 if(name==='concurrent')for(const tag of i===0?['A']:['B-first','B-after-A-stopped'])expected+=JSON.stringify({publicText:'matrix '+tag+' 中😀'})+'\n';
 const b=Buffer.from(expected);a.equal(row.stdout.bytes,b.length);a.equal(row.stdout.sha256,H(b));a.equal(row.stdout.expectedBytes,b.length);a.equal(row.stdout.expectedSha256,H(b));a.equal(row.stdout.equal,true);a.equal(q.workerOutputBytes,b.length);outputs.push({group:i,bytes:b.length,sha256:H(b)});
}
const observations=[];
for(const id of identities){a.ok(Number.isSafeInteger(id.pid)&&id.pid>0&&/^\d{10,20}$/.test(id.creationFileTime));const script='$p=Get-Process -Id '+id.pid+' -ErrorAction SilentlyContinue;if($p){[string]$p.StartTime.ToUniversalTime().ToFileTimeUtc()}else{"ABSENT"}';const x=cp.spawnSync(f.systemPs,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});a.equal(x.status,0);a.equal(x.stderr,'');const v=x.stdout.trim();a.ok(v==='ABSENT'||/^\d+$/.test(v)&&v!==id.creationFileTime);observations.push({...id,observation:v});}
const sourceSnapshots=[],external=[];fs.mkdirSync(path.join(dir,'root-source-snapshots'));
for(const [i,row]of f.bindings.entries()){if(/\.(exe|dll)$/i.test(row.file)){external.push(row);continue;}const snapshot=path.join('root-source-snapshots',String(i+1).padStart(3,'0')+'-'+path.basename(row.file));fs.writeFileSync(path.join(dir,snapshot),fs.readFileSync(row.file),{flag:'wx'});sourceSnapshots.push({...row,snapshot});}
const result={schema:1,status:'ROOT_REAL_SYNTHETIC_'+name.toUpperCase().replaceAll('-','_')+'_SCOPED_PASS',freezeSha256:pin,receiptSha256:H(fs.readFileSync(path.join(dir,'receipt.json'))),outerSha256:H(fs.readFileSync(path.join(dir,'outer-job-receipt.json'))),sourceSnapshots,external,observations,independentlyRecomputedPublicOutputs:outputs,outerTerminationRequested:false,scope:'Real pinned helper and synthetic workers, actual pipe pressure or independently surviving concurrent group. Not product/model/latency qualification.',limits:['Exact output hashes independently recomputed from fixed public worker protocol; actual raw stdout retained by controller only during run, not a second raw-stream replay.','Machine-pinned PowerShell, lease preparation parent-death, production provider and full Windows matrix remain separate.']};
fs.writeFileSync(path.join(dir,'root-review.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,sha256:H(fs.readFileSync(path.join(dir,'root-review.json'))),snapshots:sourceSnapshots.length,identities:observations.length}));
