'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),a=require('node:assert/strict');
const H=b=>crypto.createHash('sha256').update(b).digest('hex'),root=path.resolve('output/semantic-candidate-boundary-real-enable-v3');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,''));
const pin='7ed6dddd4261e4e71819e58cbc322b72345836787fb95dff764c7e8ea4ad82ef',f=read('contract.json'),r=read('bootstrap-receipt.json'),o=read('outer-job-receipt.json');
a.equal(H(fs.readFileSync(path.join(root,'contract.json'))),pin);a.equal(r.status,'FAIL_RETAIN_AND_FENCE');a.equal(r.ownershipUnknown,true);a.equal(r.bindingsStable,true);a.equal(o.controllerExitCode,1);a.equal(o.terminationRequested,true);a.equal(o.afterTermination.active,0);a.deepEqual(o.afterTermination.members,[]);
for(const row of f.bindings){const b=fs.readFileSync(row.file);a.equal(b.length,row.bytes);a.equal(H(b),row.sha256);}
const eventsFile=path.join(root,'baseline-evidence/events.jsonl'),events=fs.readFileSync(eventsFile,'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x));
const progress=events.filter(x=>x.kind==='successor-observation').map(({phase,state,code,elapsedMs})=>({phase,state,code,elapsedMs}));
a.ok(progress.some(x=>x.phase==='verify-backup'));a.ok(progress.some(x=>x.phase==='prepare-generation'&&x.state==='uncertain'));
const temp=path.join(root,'baseline-home/Temp'),audits=[];
for(const row of fs.readdirSync(temp,{withFileTypes:true})){
 if(!row.isDirectory()||!row.name.startsWith('ruyi-candidate-observer-'))continue;
 const dir=path.join(temp,row.name);a.equal(JSON.parse(fs.readFileSync(path.join(dir,'OWNER.json'))).kind,'ruyi-candidate-identity-query-v1');
 const file=path.join(dir,'allocator-receipt.json'),raw=fs.readFileSync(file),value=JSON.parse(raw);
 a.deepEqual(Object.keys(value).sort(),['kind','native','ownerRetained','schema','status']);
 a.equal(value.kind,'candidate-allocator-process-v1');a.equal(value.status,'success');
 a.deepEqual(Object.keys(value.native).sort(),['closeCode','closeObserved','closeSignal','creationFileTime','osIdentityChecked','pid','sameIdentityAbsent']);
 const n=value.native;a.equal(n.closeObserved,true);a.equal(n.closeCode,0);a.equal(n.closeSignal,null);a.equal(n.osIdentityChecked,true);a.equal(n.sameIdentityAbsent,true);
 audits.push({sourceRelative:path.relative(root,file),sha256:H(raw),receipt:value});
}
a.equal(audits.length,1);
fs.writeFileSync(path.join(root,'root-allocator-process-receipts.json'),JSON.stringify({status:'ROOT_INDIVIDUAL_ALLOCATOR_CLOSE_AND_ABSENCE_VERIFIED',records:audits},null,2)+'\n',{flag:'wx'});
const identities=[{pid:o.controllerPid,created:o.controllerCreationFileTime},r.keeperIdentity,...r.stages.filter(x=>x.identity).map(x=>x.identity),...audits.map(x=>({pid:x.receipt.native.pid,created:x.receipt.native.creationFileTime}))],observations=[];
for(const id of identities){a.ok(Number.isSafeInteger(id.pid)&&id.pid>0&&/^\d{10,20}$/.test(id.created));const script='$p=Get-Process -Id '+id.pid+' -ErrorAction SilentlyContinue;if($p){[string]$p.StartTime.ToUniversalTime().ToFileTimeUtc()}else{"ABSENT"}';const v=cp.spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:10000});a.equal(v.status,0);a.equal(v.stderr,'');const value=v.stdout.trim();a.ok(value==='ABSENT'||/^\d+$/.test(value)&&value!==id.created);observations.push({pid:id.pid,originalCreationFileTime:id.created,observation:value});}
const result={schema:1,status:'ROOT_ORDINARY_V3_ENABLE_FAILED_AFTER_ALLOCATOR_OBSERVED_SUCCESS',freezeSha256:pin,receiptSha256:H(fs.readFileSync(path.join(root,'bootstrap-receipt.json'))),outerSha256:H(fs.readFileSync(path.join(root,'outer-job-receipt.json'))),eventsSha256:H(fs.readFileSync(eventsFile)),bindingsVerified:328,progress,allocatorReceiptSha256:H(fs.readFileSync(path.join(root,'root-allocator-process-receipts.json'))),observations,ownership:{controllerReportedUnknown:true,normalFunctionalCloseProven:false,outerForcedReclaim:true,outerActive:0,totalProcesses:o.afterTermination.totalProcesses},limits:['Full real ordinary enable FAILED; no encrypted authority published. Earlier backup/rehearsal/cold-verify progress and allocator success cannot promote the whole flow.','Allocator helper individually observed close0 and same PID/creation absent before later failure; root independently observed it absent again.','Cause after allocator remains unproven. Next owned diagnostic must preserve original source guards, original uncertainty and record only bounded safe error codes/stages.','Special ADS/portableCapture, fresh-source Access, full recovery/disable and product integration remain open.']};
fs.writeFileSync(path.join(root,'root-review.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:result.status,sha256:H(fs.readFileSync(path.join(root,'root-review.json'))),bindings:328,allocatorSuccess:true,outerProcesses:o.afterTermination.totalProcesses}));
