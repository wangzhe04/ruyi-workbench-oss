// Fresh maintenance-worker composition. Caller owns drain, OS ownership, durable
// full backup and maintenance intent. This module never rebinds warm globals.
const WorkDataMigrationHost = ((io,p,c) => {
  const fail=(suffix,details={})=>{throw Object.assign(Error('work_data_migration_host.'+suffix),{code:'work_data_migration_host.'+suffix,apiCode:'work_data_migration_host.'+suffix,statusCode:409,...details});};
  const hash=bytes=>c.createHash('sha256').update(bytes).digest('hex');
  const key=name=>process.platform==='win32'?name.toLowerCase():name;
  const inside=(root,name)=>{const rel=p.relative(key(root),key(name));return rel===''||rel!=='..'&&!rel.startsWith('..'+p.sep)&&!p.isAbsolute(rel);};
  const relative=name=>typeof name==='string'&&name&&!name.includes('\\')&&!p.isAbsolute(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[<>:"|?*\x00-\x1f]/.test(part)&&!/[. ]$/.test(part));
  const strict=bytes=>{const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))fail('utf8_invalid');return text;};
  const nativeScope=name=>{const folded=key(name);return folded==='migrations/skill-backup-bindings-v2.sealed'||folded==='migrations/skill-backups'||folded.startsWith('migrations/skill-backups/')||folded==='.work-data/skill-backups'||folded.startsWith('.work-data/skill-backups/');};
  function classify(name,legacy){
    const folded=key(name);
    if(nativeScope(name))return {kind:'special-backup'};
    if(/(?:\.corrupt(?:[.-]|$)|\.tmp(?:[.-]|$)|\.sealed-stage-|\.work-data-stage-|\.migration-codec-|\.sealed-stage$)/.test(folded))fail('special_owner_required',{file:name});
    if(legacy&&['runtime.json','mcp-host-v1.json'].includes(folded))return {kind:'stable-owner'};
    if(folded==='.work-data'||folded.startsWith('.work-data/')){
      if(legacy&&(folded==='.work-data'||folded==='.work-data/generations'||folded==='.work-data/active-v1.json'||folded==='.work-data/maintenance-v1.json'||folded==='.work-data/maintenance-result-v1.json'||/^\.work-data\/generations\/[a-f0-9]{48}(?:\/|$)/.test(folded)))return {kind:'stable-owner'};
      fail('special_owner_required',{file:name});
    }
    try{const descriptor=WorkDataMigrationCodecs.describe(name);if(descriptor.codec==='special-owner-required'){
      if(key(name).endsWith('.prevbody'))return {kind:'retained',descriptor:WorkDataMigrationCodecs.describeRetained(name)};
      fail('special_owner_required',{file:name});
    }return {kind:'codec',descriptor};}catch(error){if(error?.code!=='work_data_migration.path_unmapped')throw error;}
    if(key(name).endsWith('.prevbody'))fail('special_owner_required',{file:name});
    const retained=new RegExp('^(.*\\.(?:json|md|ndjson|gz))[^/]+$',process.platform==='win32'?'i':'').exec(name);
    if(retained){let owner;try{owner=WorkDataMigrationCodecs.describe(retained[1]);}catch(error){if(error?.code!=='work_data_migration.path_unmapped')throw error;}if(owner)fail('special_owner_required',{file:name});}
    return {kind:folded==='config.json'?'config':'raw'};
  }
  // Replace only top-level flag value spans. Unrelated numeric spellings,
  // duplicate keys, whitespace and credential references retain their raw text.
  function configMirror(text,enabled){
    let parsed;try{parsed=JSON.parse(text.replace(/^\uFEFF/,''));}catch{fail('config_invalid');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('config_invalid');
    const spans=[];let pos=0;const ws=()=>{while(/\s/.test(text[pos]||'')&&pos<text.length)pos++;};
    const stringEnd=start=>{let cursor=start+1;for(;cursor<text.length;cursor++){if(text[cursor]==='\\'){cursor++;continue;}if(text[cursor]==='"')return cursor+1;}fail('config_invalid');};
    ws();if(text[pos++]!=='{')fail('config_invalid');ws();
    while(text[pos]!=='}'){
      if(text[pos]!=='"')fail('config_invalid');const begin=pos;pos=stringEnd(pos);const name=JSON.parse(text.slice(begin,pos));ws();if(text[pos++]!==':')fail('config_invalid');ws();const valueStart=pos;let depth=0;
      for(;pos<text.length;pos++){const ch=text[pos];if(ch==='"'){pos=stringEnd(pos)-1;continue;}if(ch==='{'||ch==='[')depth++;else if(ch==='}'||ch===']'){if(depth===0)break;depth--;}else if(ch===','&&depth===0)break;}
      let end=pos;while(end>valueStart&&/\s/.test(text[end-1]))end--;if(name==='workDataEncryptionV1')spans.push([valueStart,end]);
      if(text[pos]===','){pos++;ws();}else if(text[pos]!=='}')fail('config_invalid');
    }
    const value=enabled?'true':'false';if(spans.length){for(const[start,end]of spans.reverse())text=text.slice(0,start)+value+text.slice(end);return text;}
    return text.slice(0,pos)+(Object.keys(parsed).length?',':'')+'"workDataEncryptionV1":'+value+text.slice(pos);
  }
  function create({base,ownership,assertExclusive,manifest,protector,assertDurableBackup,assertIntent,onCandidate,onKeyReady,specialOwnerFactory,assertSpecialCoverage,maintenanceResultOwner,writeJson,limits={}}={}){
    if(typeof base!=='string'||!p.isAbsolute(base)||!ownership||!Array.isArray(ownership.roots)||!ownership.roots.some(root=>key(p.resolve(root))===key(p.resolve(base)))
      ||[assertExclusive,assertDurableBackup,assertIntent,onCandidate,onKeyReady,specialOwnerFactory,assertSpecialCoverage,writeJson].some(fn=>typeof fn!=='function')
      ||!manifest||['readActive','prepare','commit'].some(name=>typeof manifest[name]!=='function')||!protector)fail('host_invalid');
    base=p.resolve(base);const tree=WorkDataTree.create(limits),issued=new WeakMap(),published=new WeakMap();let busy=false;
    const admission=async()=>{if(await assertExclusive(ownership)!==true)fail('ownership_required');};
    const current=async expected=>{await admission();const actual=await manifest.readActive();if(actual.proof.raw!==expected.proof.raw||actual.proof.sha256!==expected.proof.sha256)fail('manifest_changed');if(actual.id!==null&&!/^[a-f0-9]{48}$/.test(actual.id||''))fail('authority_root_invalid');const root=actual.id===null?base:p.join(base,'.work-data','generations',actual.id);if(key(p.resolve(actual.root))!==key(root))fail('authority_root_invalid');return actual;};
    const run=async work=>{if(busy)fail('busy');busy=true;try{await admission();return await work();}finally{busy=false;}};
    async function acceptIntent(value){const owned=value?.ownedFile;if(!owned||owned.name!=='.work-data/maintenance-v1.json'||!/^[a-f0-9]{64}$/.test(owned.sha256||'')||!owned.identity)fail('intent_receipt_invalid');
      const file=p.join(base,...owned.name.split('/')),stat=await io.lstat(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size>1048576n||String(stat.dev)!==String(owned.identity.dev)||String(stat.ino)!==String(owned.identity.ino))fail('intent_changed');
      const handle=await io.open(file,'r'),scratch=Buffer.alloc(65536),digest=c.createHash('sha256');let bytes=0;try{const opened=await handle.stat({bigint:true});if(String(opened.dev)!==String(stat.dev)||String(opened.ino)!==String(stat.ino)||opened.nlink!==1n)fail('intent_changed');for(;;){const part=await handle.read(scratch,0,Math.min(scratch.length,1048576-bytes+1),null);if(!part.bytesRead)break;bytes+=part.bytesRead;if(bytes>1048576)fail('intent_changed');digest.update(scratch.subarray(0,part.bytesRead));}const after=await handle.stat({bigint:true});if(bytes!==Number(stat.size)||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs||digest.digest('hex')!==owned.sha256)fail('intent_changed');}finally{scratch.fill(0);await handle.close();}
      return Object.freeze({name:owned.name,sha256:owned.sha256,identity:String(stat.dev)+':'+String(stat.ino)});}
    const receipt=expected=>Object.freeze({...expected,proof:Object.freeze({...expected.proof})});
    async function checkSource(plan){
      await current(plan.expected);await acceptIntent({ownedFile:{name:plan.intent.name,sha256:plan.intent.sha256,identity:{dev:plan.intent.identity.split(':')[0],ino:plan.intent.identity.split(':')[1]}}});
      const snapshot=await tree.capture(base);try{
        const files=new Map(plan.sourceProof.sourceFiles.map(row=>[key(row.path),row])),dirs=new Map(plan.sourceProof.sourceDirectories.map(row=>[key(row.path),row]));
        const candidate=name=>plan.candidate&&inside(plan.candidate.root,p.join(base,...name.split('/')));
        for(const file of snapshot.files){const prior=files.get(key(file.path));if(candidate(file.path))continue;
          const owned=plan.specialFiles?.get(key(file.path));if(owned){const stat=await io.lstat(p.join(base,...file.path.split('/')),{bigint:true});if(owned.sha256!==file.sha256||owned.identity!==String(stat.dev)+':'+String(stat.ino))fail('special_owner_changed');continue;}
          if(key(file.path)===key(plan.intent.name)){if(file.sha256!==plan.intent.sha256)fail('intent_changed');continue;}
          if(!prior||prior.sha256!==file.sha256)fail('source_changed',{file:file.path});const stat=await io.lstat(p.join(base,...file.path.split('/')),{bigint:true});if(prior.identity!==String(stat.dev)+':'+String(stat.ino)||prior.mtimeNs!==String(stat.mtimeNs)||prior.ctimeNs!==String(stat.ctimeNs))fail('source_changed',{file:file.path});files.delete(key(file.path));
        }
        for(const row of files.values())fail('source_changed',{file:row.path});
        for(const name of ['',...snapshot.directories]){const prior=dirs.get(key(name));if(candidate(name))continue;
          const owned=plan.specialDirectories?.get(key(name));if(owned){const stat=await io.lstat(p.join(base,...name.split('/')),{bigint:true});if(owned.identity!==String(stat.dev)+':'+String(stat.ino))fail('special_owner_changed');continue;}
          if(!prior){if(name==='.work-data'||name==='.work-data/generations'||plan.special&&name==='migrations')continue;fail('source_changed',{file:name});}
          const stat=await io.lstat(p.join(base,...name.split('/')),{bigint:true});if(prior.identity!==String(stat.dev)+':'+String(stat.ino))fail('source_changed',{file:name});dirs.delete(key(name));
        }
        for(const row of dirs.values())fail('source_changed',{file:row.path});
      }finally{snapshot.release();}
    }
    async function writeNew(file,data){const handle=await io.open(file,'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}}
    async function emptyStoreProof(plan){
      const prefix='.work-data/skill-backups',root=p.join(base,...prefix.split('/')),snapshot=await tree.capture(root);try{
        // The ordinary host can prove only the newly owned empty V3 store.
        // Existing original objects and historical controls require the complete
        // portable/closed-census owner adapter before any transition mutation.
        if(snapshot.files.some(row=>row.path!=='relocation-v1.sealed')||snapshot.directories.some(name=>name!=='objects-v1'))fail('special_owner_change_proof_required');
        plan.specialFiles=new Map();plan.specialDirectories=new Map();
        for(const file of snapshot.files){const name=prefix+'/'+file.path,stat=await io.lstat(p.join(base,...name.split('/')),{bigint:true});plan.specialFiles.set(key(name),{sha256:file.sha256,identity:String(stat.dev)+':'+String(stat.ino)});}
        for(const relative of ['',...snapshot.directories]){const name=relative?prefix+'/'+relative:prefix,stat=await io.lstat(p.join(base,...name.split('/')),{bigint:true});plan.specialDirectories.set(key(name),{identity:String(stat.dev)+':'+String(stat.ino)});}
      }finally{snapshot.release();}
    }
    function targetEntry(plan,name,sha256){if(plan.targetHashes.has(key(name)))fail('target_conflict',{file:name});plan.targetHashes.set(key(name),{path:name,sha256});const pieces=name.split('/');pieces.pop();while(pieces.length){plan.targetDirectories.add(key(pieces.join('/')));pieces.pop();}}
    async function plannedWrite(plan,name,data){if(!relative(name)||plan.targetHashes.has(key(name)))fail('target_conflict',{file:name});const file=p.join(plan.candidate.root,...name.split('/'));await io.mkdir(p.dirname(file),{recursive:true});if(key(await io.realpath(p.dirname(file)))!==key(p.dirname(file)))fail('target_alias');await writeNew(file,data);targetEntry(plan,name,hash(data));}
    async function verifyDomain(plan,rows){
      const canonical=new Map(),decoded=new Map();
      const add=id=>{if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id)||canonical.has(key(id))&&canonical.get(key(id))!==id)fail('session_owner_required');canonical.set(key(id),id);};
      const read=async row=>{if(decoded.has(row.path))return decoded.get(row.path);const d=row.descriptor,store=WorkDataStore.createText({file:()=>p.join(plan.candidate.root,...row.path.split('/')),purpose:d.purpose,schema:d.schema,scopeId:d.scopeId,recordId:d.recordId,chunked:d.chunked,maxPlaintextBytes:256*1024*1024,keys:plan.keys,enabled:()=>plan.candidate.mode==='encrypted',writeJson}),value=JSON.parse((await store.read()).replace(/^\uFEFF/,''));decoded.set(row.path,value);return value;};
      for(const row of rows.filter(row=>row.descriptor?.family==='session-index'))for(const entry of await read(row))if(entry&&Object.hasOwn(entry,'id'))add(entry.id);
      for(const row of rows.filter(row=>row.descriptor?.family==='session-head')){const head=await read(row),id=row.descriptor.recordId;if(head.id!==undefined&&head.id!==id)fail('session_owner_required',{file:row.path});add(id);}
      for(const row of rows){const d=row.descriptor;if(!d)continue;const sid=['session-messages','session-provider','session-interventions','session-changes','session-v1-backup','background-job-ledger','journal-index','journal-reverts','journal-history','agent-run-events','agent-run-snapshot'].includes(d.family)?d.scopeId:d.family==='session-scratchpad'?d.recordId:null;if(sid&&canonical.has(key(sid))&&canonical.get(key(sid))!==sid)fail('session_owner_required',{file:row.path});if(d.family==='agent-run-snapshot'){const value=await read(row);if(value.id!==d.recordId.slice('agent-run:'.length)||value.sessionId!==d.scopeId)fail('run_owner_required',{file:row.path});}}

      for(const row of rows.filter(row=>row.descriptor?.family==='session-head')){
        const d=row.descriptor,headStore=WorkDataStore.createText({file:()=>p.join(plan.candidate.root,...row.path.split('/')),purpose:d.purpose,schema:d.schema,scopeId:d.scopeId,recordId:d.recordId,chunked:d.chunked,keys:plan.keys,enabled:()=>plan.candidate.mode==='encrypted',writeJson}),head=JSON.parse((await headStore.read()).replace(/^\uFEFF/,''));if(head.storageVersion!==2)continue;
        for(const[kind,field]of[['messages','messageCount'],['provider','providerHistoryCount']]){
          const name='sessions/'+d.recordId+'.'+kind+'.ndjson';if(!plan.targetHashes.has(key(name)))fail('session_owner_required',{file:name});
          const bytes=await io.readFile(p.join(plan.candidate.root,...name.split('/'))),text=strict(bytes),count=text?text.slice(0,-1).split('\n').length:0;if(text&&!text.endsWith('\n'))fail('session_owner_required',{file:name});
          if(head[field]!==undefined&&(!Number.isSafeInteger(head[field])||head[field]<0||head[field]!==count))fail('session_owner_required',{file:row.path});
        }
      }
    }
    async function prepare({expected,targetMode,backupReceipt,sourceProof}={}){
      return run(async()=>{
        if(!['plain','encrypted'].includes(targetMode)||!expected?.proof||!sourceProof||!Array.isArray(sourceProof.sourceFiles)||!Array.isArray(sourceProof.sourceDirectories))fail('request_invalid');
        if(await assertDurableBackup({backupReceipt,sourceProof,expected})!==true)fail('backup_required');expected=await current(expected);
        const plan={expected:receipt(expected),backupReceipt,sourceProof:JSON.parse(JSON.stringify({sourceFiles:sourceProof.sourceFiles,sourceDirectories:sourceProof.sourceDirectories})),intent:await acceptIntent(await assertIntent({backupReceipt,expected})),candidate:null,special:null,disposable:[],targetProof:null,targetHashes:new Map(),targetDirectories:new Set()};
        await checkSource(plan);const source=await tree.capture(expected.root);plan.disposable.push(source);
        try{
          const legacy=key(p.resolve(expected.root))===key(base),rows=source.files.map(file=>({...file,...classify(file.path,legacy)}));
          for(const name of source.directories){if(key(name)==='.work-data/maintenance-result-v1.json')fail('control_owner_required');classify(name,legacy);} // reserved paths and unresolved stages cannot hide in an empty directory.
          for(const row of rows)if(key(row.path)==='.work-data/maintenance-result-v1.json'){if(typeof maintenanceResultOwner?.decode!=='function')fail('control_owner_required');maintenanceResultOwner.decode(row.data);}
          const specialPaths=[...source.directories,...source.files.map(row=>row.path)].filter(nativeScope);
          if(specialPaths.length){if(await assertSpecialCoverage({backupReceipt,sourceProof,sourcePaths:Object.freeze(specialPaths)})!==true||sourceProof.specialCoverage?.type!=='skill-backup-portable'||sourceProof.specialCoverage.originalObjects!=='refused')fail('special_backup_coverage_required');plan.existingSpecial=true;plan.specialCoverage=Object.freeze({...sourceProof.specialCoverage});}
          plan.mutationStarted=true;plan.candidate=await manifest.prepare({expected:plan.expected,mode:targetMode});if(!/^[a-f0-9]{48}$/.test(plan.candidate.id||'')||key(plan.candidate.root)!==key(p.join(base,'.work-data','generations',plan.candidate.id))||plan.candidate.generation!==expected.generation+1||plan.candidate.mode!==targetMode)fail('candidate_invalid');await admission();plan.intent=await acceptIntent(await onCandidate({backupReceipt,expected:plan.expected,candidate:plan.candidate}));await checkSource(plan);
          const headerRow=rows.find(row=>key(row.path)==='work-data-key-v1.json'),sourceHeader=headerRow?JSON.parse(strict(headerRow.data)):WorkDataKeys.empty();if(!WorkDataKeys.validate(sourceHeader))fail('key_header_invalid');
          const oldKeys=WorkDataKeys.create({protector,enabled:()=>false,store:{read:async()=>sourceHeader}});plan.disposable.push(oldKeys);let targetHeader,staged;
          if(sourceHeader.instanceId){const lease=await oldKeys.snapshot();try{staged=await oldKeys.stageRecovered({instanceId:lease.instanceId,key:lease.key});}finally{lease.release();}}
          else{if(targetMode!=='encrypted')fail('mode_unchanged');staged=await oldKeys.stageNew();}
          targetHeader=staged.header;plan.targetInstanceId=targetHeader.instanceId;staged.lease.release();plan.keys=WorkDataKeys.create({protector,enabled:()=>targetMode==='encrypted',store:{read:async()=>targetHeader}});plan.disposable.push(plan.keys);const sourceKeys=sourceHeader.instanceId?oldKeys:plan.keys;
          await plannedWrite(plan,'work-data-key-v1.json',Buffer.from(JSON.stringify(targetHeader)));await admission();plan.intent=await acceptIntent(await onKeyReady({backupReceipt,expected:plan.expected,candidate:plan.candidate,headerSha256:hash(JSON.stringify(targetHeader))}));await checkSource(plan);
          // stageRecovered above proves the unchanged work master/instance. The
          // V3 native owner intentionally requires one identical keys object;
          // independent old/new header factories remain confined to the codecs.
          plan.special=await specialOwnerFactory({base,readActive:()=>manifest.readActive(),sourceKeys:plan.keys,targetKeys:plan.keys});if(!plan.special||['prepare','prepareRepresentation','prepareBindings','recover','recoverRepresentation','activate','verifyPublished'].some(name=>typeof plan.special[name]!=='function'))fail('special_owner_invalid');
          if(plan.existingSpecial){
            if(typeof plan.special.capturePortable!=='function')fail('special_owner_change_proof_required');const complete=await tree.capture(base);try{const source=WorkDataRecovery.skillBackupSource(complete.files,complete.directories);if(source.sourcePath!==plan.specialCoverage.sourcePath||source.sourceSha256!==plan.specialCoverage.sourceSha256)fail('special_owner_changed');
              const readCaptured=async(row,d)=>{let authenticated=false;const text=await WorkDataStore.createText({...d,file:()=>p.join(base,...row.path.split('/')),keys:plan.keys,enabled:()=>false,writeJson,validateSealedText:()=>{authenticated=true;return true;}}).read();return{text,authenticated};};
              const portable=await plan.special.capturePortable({files:complete.files,directories:complete.directories,source,readCaptured,expected:plan.expected});try{const value=JSON.parse(strict(portable.data));if(!value.records.some(row=>row.kind==='catalog')||value.records.some(row=>row.kind==='history'||row.kind==='binding'&&row.value.entries.length))fail('special_owner_change_proof_required');}finally{portable.release();}await tree.verify(complete);
            }finally{complete.release();}
          }
          plan.specialToken=await plan.special.prepare({expected:plan.expected,candidate:plan.candidate});await admission();if(!plan.existingSpecial)await emptyStoreProof(plan);
          const bridge=WorkDataMigrationCodecs.create({sourceRoot:plan.expected.root,targetRoot:plan.candidate.root,sourceKeys,targetKeys:plan.keys,writeJson});
          const transformed=[];for(const row of rows){if(row.kind==='stable-owner'||row.kind==='special-backup'||key(row.path)==='work-data-key-v1.json')continue;await admission();
            if(row.kind==='codec'||row.kind==='retained'){const result=await bridge[row.kind==='retained'?'transformRetained':'transform']({relative:row.path,targetMode});targetEntry(plan,row.path,result.targetPhysicalHash);transformed.push(Object.freeze({path:row.path,...result}));continue;}
            await plannedWrite(plan,row.path,row.kind==='config'?Buffer.from(configMirror(strict(row.data),targetMode==='encrypted')):row.data);
          }
          if(!rows.some(row=>row.kind==='config'))await plannedWrite(plan,'config.json',Buffer.from(configMirror('{}',targetMode==='encrypted')));
          for(const name of source.directories){const kind=classify(name,legacy).kind;if(kind!=='stable-owner'&&kind!=='special-backup'){await io.mkdir(p.join(plan.candidate.root,...name.split('/')),{recursive:true});plan.targetDirectories.add(key(name));}}
          await plan.special.prepareRepresentation(plan.specialToken,{mode:targetMode});await admission();const binding=await plan.special.prepareBindings(plan.specialToken);if(binding.ready!==true)fail('special_owner_required');
          // Re-enter the same owner to authenticate its durable candidate binding,
          // rather than treating a successful write or arbitrary current bytes as proof.
          if((await plan.special.prepareBindings(plan.specialToken)).ready!==true)fail('special_owner_required');
          const bindingName='migrations/skill-backup-bindings-v2.sealed',bindingBytes=await io.readFile(p.join(plan.candidate.root,...bindingName.split('/')));targetEntry(plan,bindingName,hash(bindingBytes));
          const target=await tree.capture(plan.candidate.root);plan.disposable.push(target);plan.target=target;if(target.files.length!==plan.targetHashes.size||target.files.some(file=>plan.targetHashes.get(key(file.path))?.sha256!==file.sha256)||target.directories.length!==plan.targetDirectories.size||target.directories.some(name=>!plan.targetDirectories.has(key(name))))fail('target_verification',{expected:plan.targetHashes.size,actual:target.files.length,mismatch:target.files.filter(file=>plan.targetHashes.get(key(file.path))?.sha256!==file.sha256).map(file=>file.path)});await verifyDomain(plan,rows);plan.targetProof=await tree.verify(target);await checkSource(plan);
          const prepared=Object.freeze({candidate:plan.candidate,sourceGeneration:expected.generation,targetMode,files:target.files.length,directories:target.directories.length,transformed:Object.freeze(transformed),sourceHashes:Object.freeze(rows.map(row=>Object.freeze({path:row.path,sha256:row.sha256}))),targetHashes:Object.freeze([...plan.targetHashes.values()].map(row=>Object.freeze({...row}))),retainedPlainDisclosure:'Old roots and durable backups are retained; enabling does not erase existing plaintext.',processExitRequired:true});issued.set(prepared,plan);return prepared;
        }catch(cause){for(const item of plan.disposable.reverse()){try{item.release?.();item.clear?.();}catch{}}if(!plan.mutationStarted)throw cause;let code='work_data_migration_host.prepare_failed';try{if(typeof cause?.code==='string'&&/^[a-zA-Z0-9_.-]{1,128}$/.test(cause.code))code=cause.code;}catch{}throw Object.assign(Error(code,{cause}),{code,apiCode:code,statusCode:409,operationMayHaveExecuted:true,resultUnavailable:true,retry:false,candidateRetained:plan.candidate?.root||null});}
      });
    }
    async function publish(prepared){return run(async()=>{const plan=issued.get(prepared);if(!plan)fail('prepared_invalid');if(plan.commitStarted)fail('publish_already_attempted',{commitUncertain:true,retry:false});await checkSource(plan);await tree.verify(plan.target);let publishing=false;try{await admission();publishing=true;plan.commitStarted=true;const result=await manifest.commit({expected:plan.expected,candidate:plan.candidate});await plan.special.recover();await plan.special.activate();
        const specialProof=await plan.special.verifyPublished({expected:result}),specialTree=await tree.capture(p.join(base,'.work-data','skill-backups'));let specialSha;
        try{specialSha=(await tree.verify(specialTree)).sha256;}finally{specialTree.release();}
        published.set(prepared,Object.freeze({expected:receipt(result),targetSha:plan.targetProof.sha256,specialSha,specialProof:Object.freeze({...specialProof}),instanceId:plan.targetInstanceId,transformed:prepared.transformed}));
        issued.delete(prepared);return Object.freeze({active:result,processExitRequired:true});}catch(cause){throw Object.assign(Error('work_data_migration_host.publish_failed',{cause}),{code:'work_data_migration_host.publish_failed',commitUncertain:true,retry:false});}finally{if(publishing)for(const item of plan.disposable.reverse()){try{item.release?.();item.clear?.();}catch{}}}});}
    async function cancel(prepared){return run(async()=>{const plan=issued.get(prepared);if(!plan)fail('prepared_invalid');if(plan.commitStarted)fail('publish_already_attempted',{commitUncertain:true,retry:false});await current(plan.expected);try{await plan.special.recoverRepresentation();await plan.special.recover();issued.delete(prepared);return Object.freeze({canceled:true,candidateRetained:plan.candidate.root});}finally{for(const item of plan.disposable.reverse()){try{item.release?.();item.clear?.();}catch{}}}});}
    async function verifyPublished(prepared){return run(async()=>{
      const proof=published.get(prepared);if(!proof)fail('published_token_invalid');const selected=await current(proof.expected);
      const target=await tree.capture(selected.root);let keys,specialTree;
      try{
        if((await tree.verify(target)).sha256!==proof.targetSha)fail('published_target_changed');
        const headerRow=target.files.find(row=>key(row.path)==='work-data-key-v1.json');let header;try{header=JSON.parse(strict(headerRow.data));}catch{fail('key_header_invalid');}
        if(!WorkDataKeys.validate(header)||header.instanceId!==proof.instanceId)fail('key_header_invalid');
        keys=WorkDataKeys.create({protector,enabled:()=>selected.mode==='encrypted',store:{read:async()=>header}});const lease=await keys.snapshot();try{if(lease.instanceId!==proof.instanceId)fail('key_header_invalid');}finally{lease.release();}
        const bridge=WorkDataMigrationCodecs.create({sourceRoot:selected.root,targetRoot:base,sourceKeys:keys,targetKeys:keys,writeJson});
        for(const row of proof.transformed){await admission();const result=await bridge[key(row.path).endsWith('.prevbody')?'verifyRetained':'verify']({relative:row.path,targetMode:selected.mode});if(result.logicalHash!==row.logicalHash||result.logicalBytes!==row.logicalBytes||result.physicalHash!==row.targetPhysicalHash)fail('published_logical_changed',{file:row.path});}
        const owner=await specialOwnerFactory({base,readActive:()=>manifest.readActive(),sourceKeys:keys,targetKeys:keys});if(typeof owner?.verifyPublished!=='function')fail('special_owner_invalid');const actualSpecial=await owner.verifyPublished({expected:selected});
        if(JSON.stringify(actualSpecial)!==JSON.stringify(proof.specialProof))fail('published_special_changed');specialTree=await tree.capture(p.join(base,'.work-data','skill-backups'));if((await tree.verify(specialTree)).sha256!==proof.specialSha)fail('published_special_changed');
        await current(proof.expected);if((await tree.verify(target)).sha256!==proof.targetSha)fail('published_target_changed');if((await tree.verify(specialTree)).sha256!==proof.specialSha)fail('published_special_changed');
        return Object.freeze({active:selected,candidateId:selected.id,generation:selected.generation,mode:selected.mode,targetSha256:proof.targetSha,specialSha256:proof.specialSha,logicalFiles:proof.transformed.length,readOnly:true,processExitRequired:true});
      }finally{specialTree?.release();target.release();keys?.clear();}
    });}
    return Object.freeze({prepare,publish,cancel,verifyPublished});
  }
  return Object.freeze({create});
})(require('node:fs/promises'),require('node:path'),require('node:crypto'));
