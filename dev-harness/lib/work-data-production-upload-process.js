'use strict';
const cp=require('node:child_process');
// Test-only process identity observations. CIM and native FILETIME are separate
// exact views; there is no conversion, rounding, tolerance or replacement before.
const birthPsPrelude = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';function Hash([string]$s){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}};function Row($id0){Get-CimInstance Win32_Process -Filter ('ProcessId='+$id0) -Property ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath,CommandLine};function Check($r,$e){if(-not $r -or [int]$r.ProcessId -ne [int]$e.pid -or [int]$r.ParentProcessId -ne [int]$e.ppid -or $r.CreationDate.ToFileTimeUtc().ToString() -ne $e.cimCreated -or $r.Name.ToLowerInvariant() -ne $e.name){throw 'exact CIM identity changed'};if(-not $r.ExecutablePath -or -not $r.CommandLine){throw 'selected process path/command unavailable'}};";
function birthInput(rows){return Buffer.from(JSON.stringify(rows)).toString('base64');}
function makeBirthCaptureScript(rows,rootPid){
 return birthPsPrelude+"$expected=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+birthInput(rows)+"')));$held=@();$pairs=@();$omitted=@();try{foreach($e in $expected){$b=Row $e.pid;if(-not $b){if([int]$e.pid -eq "+rootPid+"){throw 'root absent'};$omitted+=,[pscustomobject]@{pid=[int]$e.pid;ppid=[int]$e.ppid;cimCreated=$e.cimCreated};continue};Check $b $e;try{$q=Get-Process -Id ([int]$e.pid) -ErrorAction Stop}catch [Microsoft.PowerShell.Commands.ProcessCommandException]{$gone=Row $e.pid;if([int]$e.pid -eq "+rootPid+" -or $gone){throw};$omitted+=,[pscustomobject]@{pid=[int]$e.pid;ppid=[int]$e.ppid;cimCreated=$e.cimCreated};continue};$held+=,$q;$handle=$q.Handle;if($handle -eq [IntPtr]::Zero -or $handle.ToInt64() -eq -1){throw 'invalid retained handle'};$native=$q.StartTime.ToFileTimeUtc().ToString();$x=Row $e.pid;Check $x $e;$command=Hash $b.CommandLine;$exe=Hash $b.ExecutablePath.ToLowerInvariant();if((Hash $x.CommandLine) -ne $command -or (Hash $x.ExecutablePath.ToLowerInvariant()) -ne $exe -or $q.StartTime.ToFileTimeUtc().ToString() -ne $native -or $q.HasExited){throw 'held native/CIM pair changed'};$pairs+=,[pscustomobject]@{pid=[int]$e.pid;ppid=[int]$e.ppid;name=$e.name;cimCreated=$e.cimCreated;nativeCreated=$native;commandLineSha256=$command;executablePathSha256=$exe}};$result=[pscustomobject]@{schema=1;kind='M3_NATIVE_BIRTH_PAIRS_V1';rootPid="+rootPid+";pairs=@($pairs);omitted=@($omitted)}}finally{$disposeFailed=$false;foreach($q in $held){try{$q.Dispose()}catch{$disposeFailed=$true}};if($disposeFailed){throw 'process handle dispose failed'}};$result | ConvertTo-Json -Depth 5 -Compress";
}
function fixedSpawnCommandLine(command,args){
 if(typeof command!=='string'||!Array.isArray(args))throw Error('fixed spawn command invalid');return [command,...args].map(value=>{if(typeof value!=='string'||Buffer.from(value).toString('utf8')!==value||/[\0\r\n"]/.test(value)||/[ \t]/.test(value)&&/\\$/.test(value))throw Error('unsupported fixed spawn argument');return !value.length?'""':/[ \t]/.test(value)?'"'+value+'"':value;}).join(' ');
}
function parseBirthCapture(raw,selected,rootPid,rootCommand,rootArgs){
 const fail=message=>{throw Error(message);};if(!Buffer.isBuffer(raw)||raw.length<1||raw.length>65536)fail('birth probe output capacity');let value;try{value=JSON.parse(raw.toString('utf8'));}catch{fail('birth probe JSON invalid');}
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 if(!exact(value,['schema','kind','rootPid','pairs','omitted'])||value.schema!==1||value.kind!=='M3_NATIVE_BIRTH_PAIRS_V1'||value.rootPid!==rootPid||!Array.isArray(value.pairs)||!Array.isArray(value.omitted)||value.pairs.length+value.omitted.length!==selected.length)fail('birth probe response shape');
 const seen=new Set(),pairs=[];for(const row of value.pairs){if(!exact(row,['pid','ppid','name','cimCreated','nativeCreated','commandLineSha256','executablePathSha256']))fail('birth pair shape');const old=selected.find(r=>r.pid===row.pid);if(!old||seen.has(row.pid)||row.ppid!==old.ppid||row.name!==old.name||row.cimCreated!==old.cimCreated||typeof row.nativeCreated!=='string'||!/^\d{1,20}$/.test(row.nativeCreated)||!(/^[a-f0-9]{64}$/).test(row.commandLineSha256)||!(/^[a-f0-9]{64}$/).test(row.executablePathSha256))fail('birth pair differs from selected original CIM');seen.add(row.pid);pairs.push(Object.freeze({...row}));}
 for(const row of value.omitted){if(!exact(row,['pid','ppid','cimCreated']))fail('omitted birth shape');const old=selected.find(r=>r.pid===row.pid);if(!old||row.pid===rootPid||seen.has(row.pid)||row.ppid!==old.ppid||row.cimCreated!==old.cimCreated)fail('omitted birth identity invalid');seen.add(row.pid);}
 const root=pairs.find(r=>r.pid===rootPid);if(!root||seen.size!==selected.length)fail('original root native birth missing');const expectedExe=require('node:crypto').createHash('sha256').update(require('node:path').resolve(rootCommand).toLowerCase()).digest('hex');if(root.executablePathSha256!==expectedExe)fail('root executable differs from actual ChildProcess command');const expectedCommand=require('node:crypto').createHash('sha256').update(fixedSpawnCommandLine(rootCommand,rootArgs)).digest('hex');if(root.commandLineSha256!==expectedCommand)fail('root command differs from actual ChildProcess args');return Object.freeze(pairs);
}
function makeDualBirthStopScript(items,pairs,rootPid){
 return birthPsPrelude+"$items='"+items+"';$expected=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+birthInput(pairs)+"')));$held=@();try{foreach($e in $expected){$b=Row $e.pid;if(-not $b){if([int]$e.pid -eq "+rootPid+"){throw 'root absent'};continue};Check $b $e;$q=Get-Process -Id ([int]$e.pid) -ErrorAction Stop;$held+=,$q;$nativeHandle=$q.Handle;if($nativeHandle -eq [IntPtr]::Zero -or $nativeHandle.ToInt64() -eq -1){throw 'invalid retained handle'};if($q.StartTime.ToFileTimeUtc().ToString() -ne $e.nativeCreated){throw 'exact native birth changed'};$x=Row $e.pid;Check $x $e;if((Hash $b.CommandLine) -ne $e.commandLineSha256 -or (Hash $x.CommandLine) -ne $e.commandLineSha256 -or (Hash $b.ExecutablePath.ToLowerInvariant()) -ne $e.executablePathSha256 -or (Hash $x.ExecutablePath.ToLowerInvariant()) -ne $e.executablePathSha256 -or $q.StartTime.ToFileTimeUtc().ToString() -ne $e.nativeCreated){throw 'held original pair changed'}};if(-not ($held | Where-Object {$_.Id -eq "+rootPid+"})){throw 'root absent'};foreach($q in $held){$q.Kill();Write-Output ('STOP_REQUESTED '+$q.Id)}}finally{$disposeFailed=$false;foreach($q in $held){try{$q.Dispose()}catch{$disposeFailed=$true}};if($disposeFailed){throw 'process handle dispose failed'}}";
}

// Test-process bookkeeping only. The normal product server and its native
// owners are never replaced or told to weaken their release/unknown decisions.
function createProcesses({record,writeOutput,latch,isUnknown,killOwnTree,snapshotProcessTable,ownDescendants,beforeStart=()=>{},spawn=cp.spawn,now=Date.now,nativeBirthProbe=null}={}){
 if([record,writeOutput,latch,isUnknown,killOwnTree,snapshotProcessTable,ownDescendants,spawn,now].some(x=>typeof x!=='function'))throw Error('process observer host invalid');
 const states=[],issued=new WeakMap();
 function healthy(){if(isUnknown())throw Error('unknown forbids new process work');}
 function note(row){try{record(row);}catch(error){latch(error);}}
 function startPrivate(command,args,options,label,probe=null){
  // Final synchronous gate: the actual entry supplies its full existing target
  // pin check. No await or observer IO separates this gate from private spawn.
  let state,child;try{healthy();beforeStart();healthy();child=spawn(command,args,options);}catch(error){latch(error);throw error;}
  let resolveClose,resolveSpawn,rejectSpawn;const closed=new Promise(r=>resolveClose=r),spawned=new Promise((r,j)=>{resolveSpawn=r;rejectSpawn=j;});spawned.catch(()=>{});
  state={label,child,pid:child.pid??null,started:now(),spawnSeen:false,exitSeen:false,closeSeen:false,exitCode:null,exitSignal:null,closeCode:null,closeSignal:null,events:[],cleanupRequested:false,cleanupResult:null,cleanupVerified:false,naturalRefusalVerified:false,metadataProbeVerified:false,probe,command,args:args.slice(),nativePairs:null,nativeCaptureStarted:false,creation:null,outputBytes:0};
  const failure=(phase,error)=>{latch(error);note({kind:'process-observation-error',label,pid:state.pid,phase,knownClosed:state.closeSeen,code:error?.code||null});};
  // Before any observer IO: all actual lifecycle listeners are installed.
  child.on('spawn',()=>{state.spawnSeen=true;state.pid=child.pid;const row={event:'spawn',pid:state.pid,at:now()};state.events.push(row);note({kind:'child-event',label,...row});resolveSpawn(state.pid);});
  child.on('error',error=>{failure('child-error',error);rejectSpawn(error);});
  child.on('exit',(code,signal)=>{state.exitSeen=true;state.exitCode=code;state.exitSignal=signal;const row={event:'exit',code,signal,at:now()};state.events.push(row);note({kind:'child-event',label,pid:state.pid,...row});});
  child.on('close',(code,signal)=>{state.closeSeen=true;state.closeCode=code;state.closeSignal=signal;const row={event:'close',code,signal,at:now()};state.events.push(row);note({kind:'child-event',label,pid:state.pid,...row});resolveClose({code,signal});});
  states.push(state);const handle=Object.freeze({spawned,closed});issued.set(handle,state);
  for(const [kind,stream]of [['stdout',child.stdout],['stderr',child.stderr]]){
   if(!stream||typeof stream.on!=='function'){failure(kind+'-missing',Error('owned child pipe missing'));continue;}
   stream.on('error',error=>failure(kind+'-error',error));stream.on('data',bytes=>{state.outputBytes+=bytes.length;if(state.outputBytes>2*1024*1024){failure('output-capacity',Error('test child output exceeded2MiB'));return;}try{if(probe){if(probe.bytes+bytes.length>65536)throw Error('birth probe output exceeded64KiB');probe.bytes+=bytes.length;probe[kind].push(Buffer.from(bytes));}else writeOutput(label,kind,bytes);}catch(error){failure(kind+'-record',error);}});
  }
  note({kind:'child-start',label,pid:child.pid,command,args,started:state.started,stdio:'ignore,pipe,pipe',IPC:false});return handle;
 }
 function start(command,args,options,label){return startPrivate(command,args,options,label);}
 async function captureNativeBirths(handle){
  const s=known(handle);healthy();beforeStart();healthy();if(s.nativeCaptureStarted||s.nativePairs)throw Error('native birth before cannot be refreshed');if(!s.spawnSeen||s.exitSeen||s.closeSeen||s.child.exitCode!==null||s.child.signalCode!==null)throw Error('native birth requires original live ChildProcess');s.nativeCaptureStarted=true;
  try{
   const observed=snapshot(handle,'before-original-native-birth-pair'),selected=observed.rows.filter(r=>r.pid===s.pid||r.name!=='conhost.exe').map(r=>({pid:r.pid,ppid:r.ppid,name:r.name,cimCreated:String(r.created)}));if(selected.length<1||selected.length>32)throw Error('selected native birth capacity');
   let raw;
   if(nativeBirthProbe){raw=await nativeBirthProbe(Object.freeze(selected.map(r=>Object.freeze({...r}))),s.pid,s.command);}
   else {
    const probe={stdout:[],stderr:[],bytes:0},script=makeBirthCaptureScript(selected,s.pid),h=startPrivate('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe']},s.label+'-native-birth-probe',probe);
    await waitClose(h,20000);healthy();const ps=known(h);if(!ps.spawnSeen||!ps.exitSeen||!ps.closeSeen||ps.exitCode!==0||ps.closeCode!==0||ps.exitSignal!==null||ps.closeSignal!==null||probe.stderr.length)throw Error('native birth probe terminal unverified');raw=Buffer.concat(probe.stdout);ps.metadataProbeVerified=true;note({kind:'native-birth-probe-terminal-verified',label:ps.label,pid:ps.pid,spawnSeen:true,exitCode:0,closeCode:0,stderrBytes:0,outputBytes:raw.length,scope:'Readonly selected process identity only;not continuous tracing.'});
   }
   healthy();beforeStart();healthy();if(s.exitSeen||s.closeSeen||s.child.exitCode!==null||s.child.signalCode!==null)throw Error('original ChildProcess ended during native birth capture');
   const pairs=parseBirthCapture(raw,selected,s.pid,s.command,s.args),after=snapshot(handle,'after-original-native-birth-pair');for(const row of pairs){if(!after.rows.some(r=>r.pid===row.pid&&r.ppid===row.ppid&&String(r.created)===row.cimCreated))throw Error('selected native pair absent after capture');}
   healthy();s.nativePairs=pairs;note({kind:'original-owned-native-birth-pairs',label:s.label,pid:s.pid,pairs:pairs.map(r=>({...r})),noCrossViewEqualityOrRounding:true,firstBeforeNeverRefreshed:true});healthy();return{pairs:pairs.length,registeredOnce:true};
  }catch(error){latch(error);throw error;}
 }
 function known(handle){const state=issued.get(handle);if(!state)throw Error('foreign process handle');return state;}
 function snapshot(handle,phase){const state=known(handle),table=snapshotProcessTable();if(!Array.isArray(table)){latch(Error('actual CIM snapshot unavailable'));throw Error('actual CIM snapshot unavailable');}const tree=ownDescendants(table,state.pid);if(!tree.root){latch(Error('owned process creation identity unavailable'));throw Error('owned process creation identity unavailable');}if(state.creation&&tree.root.created!==state.creation.created){latch(Error('owned process PID creation changed'));throw Error('owned process PID creation changed');}state.creation=tree.root;const rows=[tree.root,...tree.descendants].map(r=>({...r,created:String(r.created)}));note({kind:'actual-cim-owned-lineage',label:state.label,phase,rows,scope:'Actual sampled rows only;not all helper event triples or continuous process tracing.'});return{tree,rows};}
 async function waitClose(handle,budgetMs=20000){const s=known(handle);if(s.closeSeen)return{code:s.closeCode,signal:s.closeSignal};let timer;try{return await Promise.race([handle.closed,new Promise((_,reject)=>{timer=setTimeout(()=>{latch(Error('actual child close deadline'));reject(Error('actual child close deadline'));},budgetMs);})]);}finally{clearTimeout(timer);}}
 async function cleanupKnown(handle,verifyHealth){const state=known(handle);if(state.cleanupRequested)throw Error('cleanup already requested');if(state.closeSeen)throw Error('closed child is never killed');if(isUnknown())throw Error('unknown forbids automatic cleanup');await verifyHealth();if(isUnknown())throw Error('unknown forbids automatic cleanup');const before=snapshot(handle,'before-normal-test-cleanup');if(state.closeSeen||state.child.exitCode!==null||state.child.signalCode!==null)throw Error('actual owned child already exited');
  // No await separates the final observation gate and exact-held-child cleanup.
  if(isUnknown())throw Error('unknown forbids automatic cleanup');state.cleanupRequested=true;note({kind:'owned-cleanup-request',label:state.label,pid:state.pid,observedCreation:String(state.creation.created),scope:'Test teardown only;not migration completion.'});if(isUnknown())throw Error('observer failure forbids automatic cleanup');
  try{state.cleanupResult=killOwnTree(state.child,{expectedRoot:state.creation,healthy,birthPairs:state.nativePairs});}catch(error){latch(error);throw error;}note({kind:'owned-cleanup-call-result',label:state.label,result:state.cleanupResult,notDeathProof:true});if(!state.cleanupResult||state.cleanupResult.skipped||state.cleanupResult.error||!Array.isArray(state.cleanupResult.killed)){latch(Error('owned cleanup boundary incomplete'));throw Error('owned cleanup boundary incomplete');}healthy();await waitClose(handle);healthy();
  const after=snapshotProcessTable();if(!Array.isArray(after)){latch(Error('post-cleanup actual CIM unavailable'));throw Error('post-cleanup actual CIM unavailable');}const sampled=before.rows.concat(state.cleanupResult.sampledRows||[]),live=sampled.filter(row=>after.some(nowRow=>nowRow.pid===row.pid&&String(nowRow.created)===String(row.created)));if(live.length){latch(Error('sampled owned process still present'));throw Error('sampled owned process still present');}healthy();state.cleanupVerified=true;note({kind:'owned-cleanup-actual-close-and-sampled-absence',label:state.label,close:{code:state.closeCode,signal:state.closeSignal},sampledRows:sampled,remainingSampledIdentities:[],continuousWholeTreeClaim:false});return true;
 }
 function inspect(handle){const s=known(handle);return{label:s.label,pid:s.pid,spawnSeen:s.spawnSeen,exitSeen:s.exitSeen,closeSeen:s.closeSeen,exitCode:s.exitCode,exitSignal:s.exitSignal,closeCode:s.closeCode,closeSignal:s.closeSignal,events:s.events.map(r=>({...r})),cleanupRequested:s.cleanupRequested,cleanupResult:s.cleanupResult,cleanupVerified:s.cleanupVerified,metadataProbeVerified:s.metadataProbeVerified,nativeBirthPairCount:s.nativePairs?.length||0,creation:s.creation?{...s.creation,created:String(s.creation.created)}:null};}
 async function certifyExpectedRefusal(handle,verifyRefusal){const s=known(handle);if(isUnknown()||s.cleanupRequested||!s.spawnSeen||!s.exitSeen||!s.closeSeen||s.exitCode!==1||s.closeCode!==1||s.exitSignal!==null||s.closeSignal!==null)throw Error('expected refusal terminal unverified');await verifyRefusal();if(isUnknown())throw Error('unknown refuses refusal certification');s.naturalRefusalVerified=true;note({kind:'expected-refusal-verified',label:s.label,code:1,signal:null,noAutomaticCleanup:true});}
 return Object.freeze({start,snapshot,captureNativeBirths,waitClose,cleanupKnown,certifyExpectedRefusal,inspect,hasUnclosed:()=>states.some(s=>!s.closeSeen),hasUnverifiedSpawn:()=>states.some(s=>s.spawnSeen&&!s.cleanupVerified&&!s.naturalRefusalVerified&&!s.metadataProbeVerified),pid:h=>known(h).pid});
}
// Dedicated Windows test teardown. The checked-in generic killOwnTree default
// remains byte-identical and is never called by this path. Each stop consumes
// a registered held child supplied only by createProcesses, not a caller PID.
function createStrictStop({snapshotProcessTable,ownDescendants,latch,isUnknown,run=cp.spawnSync,platform=process.platform}={}){
 function fail(message){const error=Error(message);latch(error);throw error;}
 return function strictStop(child,{expectedRoot,healthy,birthPairs}={}){
  try{
   if(platform!=='win32')return fail('strict test stop requires Windows');
   healthy();if(isUnknown())return fail('unknown forbids strict stop');
   if(!child||!Number.isSafeInteger(child.pid)||child.pid<1||child.exitCode!==null||child.signalCode!==null)return fail('strict stop requires live held child');
   // A failed SECOND CIM sample cannot fall through to root taskkill.
   const table=snapshotProcessTable();if(!Array.isArray(table))return fail('strict stop CIM unavailable');
   const tree=ownDescendants(table,child.pid);if(!tree.root||!expectedRoot||tree.root.pid!==expectedRoot.pid||String(tree.root.created)!==String(expectedRoot.created))return fail('strict stop root creation changed');
   const rows=[tree.root,...tree.descendants],targets=rows.filter(r=>r.pid===child.pid||r.name!=='conhost.exe');
   for(const row of targets)if(!Number.isSafeInteger(row.pid)||row.pid<1||!/^[0-9]+$/.test(String(row.created)))return fail('strict stop identity invalid');
   const items=targets.map(r=>String(r.pid)+':'+String(r.created)).join(',');
   if(!Array.isArray(birthPairs)||birthPairs.length<1||birthPairs.length>32)return fail('original native birth pairs required');
   const selectedPairs=targets.map(row=>{const pair=birthPairs.find(r=>r.pid===row.pid);if(!pair||pair.ppid!==row.ppid||pair.name!==row.name||pair.cimCreated!==String(row.created)||!/^\d{1,20}$/.test(pair.nativeCreated)||!(/^[a-f0-9]{64}$/).test(pair.commandLineSha256)||!(/^[a-f0-9]{64}$/).test(pair.executablePathSha256))return fail('unregistered or changed nonconhost target');return pair;});
   // Acquire every long-term native process handle BEFORE reading StartTime.
   // The SAME Process object owns its handle through all requests. StartTime
   // alone may use a temporary handle; merely retaining objects is insufficient.
   // A finally block disposes every acquired object, including failed preflight.
   // There is no fallback PID kill. Request errors remain uncertainty.
   const script=makeDualBirthStopScript(items,selectedPairs,child.pid);
   healthy();if(isUnknown()||child.exitCode!==null||child.signalCode!==null)return fail('strict stop final gate refused');
   const result=run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000});
   if(!result||result.error||result.status!==0)return fail('strict stop preflight or request failed');
   const killed=String(result.stdout||'').split(/\r?\n/).filter(Boolean).map(line=>{const m=/^STOP_REQUESTED ([0-9]+)$/.exec(line.trim());if(!m)return fail('strict stop output invalid');return Number(m[1]);});
   if(!killed.includes(child.pid)||new Set(killed).size!==killed.length||killed.some(pid=>!targets.some(r=>r.pid===pid)))return fail('strict stop request receipt invalid');
   healthy();return{killed,sampledRows:rows.map(r=>({...r,created:String(r.created)})),strictPreflight:true,requestOnly:true};
  }catch(error){latch(error);throw error;}
 };
}
module.exports={createProcesses,createStrictStop,makeBirthCaptureScript,parseBirthCapture,makeDualBirthStopScript,fixedSpawnCommandLine};
