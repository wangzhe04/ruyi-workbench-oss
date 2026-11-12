'use strict';
// Cache lifetime tests use inert files/children. One Windows parser-only test
// runs the real closed metadata decoder without any native worker or DATA I/O.
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {constBlock,functionBlock}=require('../lib/source-slice');
const source=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13u-migration-center.js'),'utf8'),block=constBlock(source,'migrationCapsuleCode'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const REFS=['mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089','System, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089','System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35','System.Core, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089'];
// Independent test-side wire reader; the production encoder is not reused.
function metadata(record){const fields=Buffer.from(record.env.RUYI_SKILL_CAPSULE_CODE_META,'base64').toString('utf8').split('\0');a([41,44].includes(fields.length));a.deepEqual(fields.slice(0,3),['rnc-meta-v1','1','x64']);a.equal(fields[6],'14');a.equal(fields[35],'4');const result={revision:1,arch:fields[2],executable:fields[3],key:fields[4],sourceHash:fields[5],files:Array.from({length:14},(_,n)=>({file:fields[7+n*2],sha256:fields[8+n*2]})),references:fields.slice(36,40)};a.equal(fields[40],fields.length===44?'1':'0');if(fields.length===44)Object.assign(result,{artifactHash:fields[41],clr:fields[42],mvid:fields[43]});return result;}
function fixture(options={}){
 const win=path.win32,rows=new Map(),deleted=[],readPaths=[];let sequence=0,closed=0,allocated=0,temporaryRoot=options.tmpdir||'T:\\owned';
 const key=file=>win.resolve(file).toLowerCase(),norm=file=>win.resolve(file);
 function directory(file){file=norm(file);if(rows.has(key(file)))return rows.get(key(file));if(win.dirname(file)!==file)directory(win.dirname(file));const row={file,dir:true,id:++sequence,bytes:null,link:false,nlink:1n};rows.set(key(file),row);return row;}
 function put(file,bytes){file=norm(file);directory(win.dirname(file));const row={file,dir:false,id:++sequence,bytes:Buffer.from(bytes),link:false,nlink:1n};rows.set(key(file),row);return row;}
 const get=file=>{const row=rows.get(key(file));if(row)return row;if(key(file).startsWith('w:')&&/\.(?:exe|dll|config|rsp)$/.test(file))return put(file,'PUBLIC_TOOL_'+win.basename(file));if(key(file).startsWith('w:'))return directory(file);throw Object.assign(Error('missing'),{code:'ENOENT'});};
 const stat=row=>({dev:1n,ino:BigInt(row.id),nlink:row.nlink,mode:row.dir?0o40700n:0o100600n,size:BigInt(row.bytes?.length||0),mtimeNs:1n,ctimeNs:1n,isFile:()=>!row.dir,isDirectory:()=>row.dir,isSymbolicLink:()=>row.link});
 const io={
  async lstat(file){return stat(get(file));},async realpath(file){get(file);return norm(file);},
  async open(file){const row=get(file);return{async stat(){return stat(row);},async read(buffer,offset,length,position){readPaths.push(norm(file));const n=Math.min(length,row.bytes.length-position);row.bytes.copy(buffer,offset,position,position+n);return{bytesRead:n,buffer};},async close(){closed++;}};},
  async mkdtemp(prefix){allocated++;const file=prefix+allocated;directory(file);return file;},
  async readdir(file){get(file);return[...rows.values()].filter(r=>key(win.dirname(r.file))===key(file)&&key(r.file)!==key(file)).map(r=>win.basename(r.file));},
  async unlink(file){if(options.unlinkError)throw Error('cache optional cleanup');deleted.push(norm(file));rows.delete(key(file));},
  async rmdir(file){if((await io.readdir(file)).length)throw Error('not empty');deleted.push(norm(file));rows.delete(key(file));},
 };
 directory(temporaryRoot);
 const process={arch:options.arch||'x64',env:{SystemRoot:'W:\\Windows',ruyi_skill_capsule_code_0:'UNTRUSTED',RUYI_SKILL_CAPSULE_SOURCE:'UNTRUSTED'},platform:'win32'};
 const broker=function migrationCapsuleBroker(){};
 const context={Buffer,process,migrationCapsuleBroker:broker,require:name=>name==='node:fs/promises'?io:name==='node:path'?win:name==='node:os'?{tmpdir:()=>temporaryRoot}:name==='node:timers'?{setImmediate:fn=>queueMicrotask(fn)}:require(name)};
 let body=options.block||block;if(options.contextOnly){const anchor='return Object.freeze({ prepare, idle:';a.equal(body.split(anchor).length,2);body=body.replace(anchor,'return Object.freeze({ testContext:context, prepare, idle:');}
 vm.createContext(context);vm.runInContext(body+'\nthis.api=migrationCapsuleCode;',context);
 const child=()=>{const ch=new EventEmitter();ch.stdout=new EventEmitter();ch.stderr=new EventEmitter();return ch;};
 const complete=(record,ch,{missing=null,success=true,marker=null}={})=>{
  ch.emit('spawn');if(marker!==null)ch.stderr.emit('data',Buffer.from(marker));
  for(const name of ['stdout','stderr'])for(const event of ['end','close'])if(missing!==name+'-'+event)ch[name].emit(event);
  if(missing!=='exit')ch.emit('exit',0,null);if(missing!=='close')ch.emit('close',0,null);record.complete(success);
 };
 const materialize=(record,change={})=>{const root=record.env.RUYI_SKILL_CAPSULE_CODE_SINK,meta=metadata(record),bytes=Buffer.from('PUBLIC_ASSEMBLY_BYTES');directory(win.join(root,'compiler'));put(win.join(root,'capsule.dll'),bytes);const manifest={revision:1,key:meta.key,sourceHash:meta.sourceHash,artifactHash:hash(bytes),artifactBytes:bytes.length,clr:'4.0.30319.42000',type:'RuyiSkillCapsule',mvid:'12345678-1234-1234-1234-123456789abc',references:REFS,...change};put(win.join(root,'manifest.json'),JSON.stringify(manifest));return{root,meta,bytes,manifest};};
 return{api:context.api,broker,process,io,rows,put,directory,get,deleted,readPaths,child,complete,materialize,key,closed:()=>closed,allocated:()=>allocated,setTmpdir:value=>{temporaryRoot=norm(value);directory(temporaryRoot);}};
}
async function published(f){const r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);const info=f.materialize(r);f.complete(r,ch);await f.api.idle();a.equal(f.api.stats().published,1);return info;}

test('fresh public context hashes all fourteen files in fixed order with four bounded complete pipelines',async()=>{
 const f=fixture({contextOnly:true}),open=f.io.open;let active=0,peak=0,opened=0,closed=0,release;
 const gate=new Promise(resolve=>release=resolve);
 f.io.open=async(...args)=>{const fd=await open(...args);active++;opened++;peak=Math.max(peak,active);if(active===4)release();const read=fd.read,close=fd.close;
  fd.read=async(...args)=>{await gate;return read(...args);};fd.close=async()=>{await close();active--;closed++;};return fd;};
 const ctx=await f.api.testContext('PUBLIC SOURCE');a.equal(ctx.files.length,14);a.equal(peak,4);a.equal(active,0);a.equal(opened,14);a.equal(closed,14);
 a.equal(ctx.files[0].file,ctx.executable);a.equal(ctx.files[1].file,ctx.executable+'.config');a.deepEqual(Array.from(ctx.files.slice(10),row=>row.file),Array.from(ctx.references));
 for(const row of ctx.files)a.equal(row.sha256,hash(f.get(row.file).bytes));
 const before=opened;await f.api.testContext('PUBLIC SOURCE');a.equal(opened-before,14,'a later context never reuses file hash or ancestor authority');a.equal(active,0);
});

test('hash-only public IO reuses at most one MiB and hashes every byte including its final short block',async()=>{
 const f=fixture({contextOnly:true}),file='W:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',bytes=Buffer.alloc(2*1024*1024+137);for(let n=0;n<bytes.length;n++)bytes[n]=n%251;f.put(file,bytes);
 const open=f.io.open,reads=[];f.io.open=async(name,...args)=>{const fd=await open(name,...args),read=fd.read;if(f.key(name)===f.key(file))fd.read=async(buffer,offset,length,position)=>{reads.push({buffer:buffer.length,length,position});return read(buffer,offset,length,position);};return fd;};
 const ctx=await f.api.testContext('PUBLIC SOURCE');a.equal(ctx.files[0].sha256,hash(bytes));a.equal(reads.length,3);a(reads.every(row=>row.buffer<=1024*1024&&row.length<=row.buffer));a.deepEqual(reads.map(row=>row.position),[0,1024*1024,2*1024*1024]);a.equal(reads.at(-1).length,137);
});

test('optional context failure waits every started FD close before returning compiler fallback',async()=>{
 const f=fixture(),open=f.io.open,primary=Error('synthetic context read refusal');let active=0,opened=0,closed=0,release,finished=false;
 const gate=new Promise(resolve=>release=resolve);
 f.io.open=async(file,...args)=>{const fd=await open(file,...args);active++;opened++;const read=fd.read,close=fd.close;
  fd.read=async(...args)=>{if(file.endsWith('powershell.exe'))throw primary;await gate;return read(...args);};fd.close=async()=>{await close();active--;closed++;};return fd;};
 const preparing=f.api.prepare('PUBLIC SOURCE').then(value=>{finished=true;return value;});
 try{for(let n=0;n<200&&!(opened===4&&closed===1);n++)await Promise.resolve();a.equal(opened,4);a.equal(closed,1);a.equal(active,3);a.equal(finished,false);a.equal(f.allocated(),0);}
 finally{release();}
 a.equal(await preparing,null);a.equal(closed,4);a.equal(active,0);a.equal(finished,true);a.equal(f.api.stats().disabled,true);a.equal(f.allocated(),0);
});
test('completed original producer publishes only private code; fresh hit has bounded parts and exact context',async()=>{
 const f=fixture(),r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);const info=f.materialize(r);a.equal(f.api.stats().published,0);a.equal(r.env.ruyi_skill_capsule_code_0,undefined);a.equal(Buffer.from(r.env.RUYI_SKILL_CAPSULE_SOURCE,'base64').toString(),'PUBLIC SOURCE');f.complete(r,ch);a.equal(f.api.stats().published,0);await f.api.idle();a.equal(f.api.stats().published,1);a.equal(f.api.stats().compiled,1);a.equal(f.api.stats().codeIdentity.sourceHash,hash('PUBLIC SOURCE'));a.equal(f.api.stats().codeIdentity.artifactSha256,hash(info.bytes));a.equal(JSON.stringify(f.api.stats()).includes('PUBLIC_ASSEMBLY_BYTES'),false);a.equal(f.api.stats().pending,0);
 const hot=await f.api.prepare('PUBLIC SOURCE'),meta=metadata(hot);a.equal(hot.env.RUYI_SKILL_CAPSULE_CODE_SINK,'');a.equal(meta.artifactHash,hash(info.bytes));a.equal(meta.mvid,info.manifest.mvid);a.equal(meta.clr,info.manifest.clr);a.equal(Buffer.from(hot.env.RUYI_SKILL_CAPSULE_CODE_0,'base64').toString(),info.bytes.toString());const hc=f.child();hot.observe(hc);f.complete(hot,hc,{marker:'RUYI_CODE_V1_LOAD|'+meta.artifactHash+'\r\n'});await f.api.idle();a.equal(f.api.stats().loaded,1);a.equal(f.api.stats().disabled,false);a.equal(f.allocated(),1);a.equal(f.deleted.length,4);a(f.closed()>0);
});

test('cached bootstrap derives the same policy decoder refs and loader while omitting only the cold producer arm',async()=>{
 const f=fixture(),cold=await f.api.prepare('PUBLIC SOURCE'),child=f.child();cold.observe(child);f.materialize(cold);f.complete(cold,child);await f.api.idle();const hot=await f.api.prepare('PUBLIC SOURCE');
 const original=vm.runInNewContext(constBlock(block,'bootstrap')+';bootstrap',{});a.equal(cold.bootstrap,original);a(hot.bootstrap.length<cold.bootstrap.length);a.equal(metadata(hot).artifactHash,f.api.stats().codeIdentity.artifactSha256);
 a.equal(bracedDecoder(hot.bootstrap),bracedDecoder(cold.bootstrap));
 for(const guard of ["LanguageMode.ToString() -ceq 'FullLanguage'","GetSystemLockdownPolicy().ToString() -ceq 'None'","StartsWith('RUYI_SKILL_CAPSULE_'","try{Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition $source}",'CodeHash ([IO.File]::ReadAllBytes($file.file))',"throw 'native_code_reference'","[Reflection.Assembly]::Load($bytes)","throw 'native_code_artifact'","throw 'native_code_runtime'","throw 'native_code_method'","throw 'native_code_dependency'","'RUYI_CODE_V1_LOAD|'",'[RuyiSkillCapsule]::Run()']){
  a(hot.bootstrap.includes(guard),guard);
 }
 const refs=cold.bootstrap.slice(cold.bootstrap.indexOf('foreach($file in $meta.files)'),cold.bootstrap.indexOf("if($encoded -eq '') {\n  $source="));a(hot.bootstrap.includes(refs));
 const loader=cold.bootstrap.slice(cold.bootstrap.indexOf('  $bytes=[Convert]::FromBase64String($encoded);'),cold.bootstrap.indexOf("\n}\n$type=$assembly.GetType('RuyiSkillCapsule'"));a(hot.bootstrap.includes(loader));
 a(hot.bootstrap.includes("if($encoded -eq ''){throw 'native_code_cache_parts'}\n$meta=CodeMetaDecode $meta64 $true"));a.equal(hot.bootstrap.includes('-OutputAssembly $dll'),false);a.equal(hot.bootstrap.includes('function CodeAclCapability'),false);a(hot.bootstrap.indexOf('if(!$useCode)')<hot.bootstrap.indexOf('function CodeMetaDecode'));
});

test('cold hot specialization encoder and selector text all bind the private code context key',async()=>{
 const base=fixture(),original=metadata(await base.api.prepare('PUBLIC SOURCE')).key;
 for(const [before,after]of [
  ["$ProgressPreference='SilentlyContinue'","$ProgressPreference='SilentlyContinue'\n# Different bootstrap identity."],
  ['function specializeBootstrap(value) {','function specializeBootstrap(value) {\n    // Different specialization identity.'],
  ['function bootstrapFor(hit) {','function bootstrapFor(hit) { /* Different selection identity. */'],
  ['function encodeMetadata(meta) {','function encodeMetadata(meta) {\n    // Different encoder identity.'],
 ]){a(block.includes(before));const f=fixture({block:block.replace(before,after)});a.notEqual(metadata(await f.api.prepare('PUBLIC SOURCE')).key,original);}
});

test('unrecognized or ambiguous specialization retains the complete original bootstrap',()=>{
 const specialize=vm.runInNewContext('('+functionBlock(block,'specializeBootstrap')+')'),original=vm.runInNewContext(constBlock(block,'bootstrap')+';bootstrap',{});
 for(const changed of[original.replace("if($encoded -eq '') {\n  $source=","if($encoded -eq '') {\n  # changed template\n  $source="),original+"\n} else {\n  $bytes=[Convert]::FromBase64String($encoded);",original+"\n}\n$type=$assembly.GetType('RuyiSkillCapsule'",original.replace("$meta=CodeMetaDecode $meta64 ([bool]($encoded -ne ''))",'$meta=other_decoder')])a.equal(specialize(changed),changed);
});

test('Windows parses both complete emitted bootstraps without executing source or native commands',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const f=fixture(),cold=await f.api.prepare('PUBLIC SOURCE');await published(f);const hot=await f.api.prepare('PUBLIC SOURCE');
 const os=require('node:os'),cp=require('node:child_process'),root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-code-bootstrap-parser-')),env=require('../lib/release-checks').releaseEnvironment(path.join(root,'home'),path.join(root,'data'));
 const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$raw=[Console]::In.ReadToEnd();if($raw.Length -gt 1048576){throw 'input_limit'};$scripts=$raw|ConvertFrom-Json;$rows=@();foreach($script in $scripts){$tokens=$null;$issues=$null;$null=[System.Management.Automation.Language.Parser]::ParseInput([string]$script,[ref]$tokens,[ref]$issues);$rows+=@{errors=@($issues).Count}};[Console]::WriteLine((ConvertTo-Json -InputObject $rows -Compress))";
 try{const result=cp.spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true,encoding:'utf8',input:JSON.stringify([cold.bootstrap,hot.bootstrap]),timeout:30000,maxBuffer:1024*1024});a.equal(result.status,0,result.stderr);a.equal(result.stderr,'');a.deepEqual(JSON.parse(result.stdout),[{errors:0},{errors:0}]);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('policy-declined bootstrap control selects original source fallback without entering byte loader',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const f=fixture(),cold=await f.api.prepare('PUBLIC SOURCE');await published(f);const hot=await f.api.prepare('PUBLIC SOURCE'),os=require('node:os'),cp=require('node:child_process'),root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-code-policy-control-'));
 const policy="$useCode=$false;try{$useCode=$ExecutionContext.SessionState.LanguageMode.ToString() -ceq 'FullLanguage' -and [System.Management.Automation.Security.SystemPolicy]::GetSystemLockdownPolicy().ToString() -ceq 'None'}catch{}",compile='try{Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition $source}finally{$source=$null}';
 try{for(const record of[cold,hot]){
  a(record.bootstrap.includes(policy));a(record.bootstrap.includes(compile));
  // Only the policy result and source execution are inert controls; validators
  // and the alternative loader remain the actual emitted PowerShell body.
  const script=record.bootstrap.replace(policy,'$useCode=$false').replace(compile,'$script:sourceFallback=$true').replace('[RuyiSkillCapsule]::Run()',"if(!$script:sourceFallback){throw 'missing_source_fallback'};[Console]::WriteLine('SOURCE_ONLY');return");
  const base=require('../lib/release-checks').releaseEnvironment(path.join(root,'home'),path.join(root,'data')),env={...base,...Object.fromEntries(Object.entries(record.env).filter(([name])=>name.startsWith('RUYI_SKILL_CAPSULE_')))};
  const result=cp.spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});a.equal(result.status,0,result.stderr);a.equal(result.stderr,'');a.equal(result.stdout.trim(),'SOURCE_ONLY');
 }}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('live producer and concurrent misses never wait or share native state; a cold instance has no cache',async()=>{
 const f=fixture(),one=await f.api.prepare('PUBLIC SOURCE'),two=await f.api.prepare('PUBLIC SOURCE');a.notEqual(one.env.RUYI_SKILL_CAPSULE_CODE_SINK,two.env.RUYI_SKILL_CAPSULE_CODE_SINK);a.equal(f.api.stats().published,0);await published(f);const cold=fixture(),fresh=await cold.api.prepare('PUBLIC SOURCE');a(fresh.env.RUYI_SKILL_CAPSULE_CODE_SINK);a.equal(cold.api.stats().published,0);
});
for(const missing of ['stdout-end','stdout-close','stderr-end','stderr-close','exit','close'])test('missing '+missing+' cannot publish code',async()=>{const f=fixture(),r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);f.materialize(r);f.complete(r,ch,{missing});await f.api.idle();a.equal(f.api.stats().published,0);a.equal(f.api.stats().disabled,true);a.equal(f.deleted.length,0);});
test('another original helper becoming unknown before adoption prevents publication forever',async()=>{const f=fixture(),r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);f.materialize(r);f.complete(r,ch);f.broker.helperMayStillRun=true;await f.api.idle();a.equal(f.api.stats().published,0);a.equal(f.api.stats().disabled,true);a.equal(await f.api.prepare('PUBLIC SOURCE'),null);});
for(const [name,change]of [['source',{sourceHash:'0'.repeat(64)}],['hash',{artifactHash:'0'.repeat(64)}],['size',{artifactBytes:1}],['mvid',{mvid:'bad'}],['runtime',{clr:'8.0.1'}],['refs',{references:[REFS[0],REFS[0],REFS[0]]}],['type',{type:'Other'}],['extra',{unexpected:'public unexpected field'}],['missing-Core',{references:REFS.slice(0,3)}]])test('bad '+name+' disables optional adoption without replacing business result',async()=>{const f=fixture(),r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);f.materialize(r,change);f.complete(r,ch);await f.api.idle();a.equal(f.api.stats().published,0);a.equal(f.api.stats().disabled,true);a.equal(f.deleted.length,0);});
test('unknown leaf is retained unread and never adopted as compiler-owned cleanup',async()=>{const f=fixture(),r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);const info=f.materialize(r),file=path.win32.join(info.root,'foreign.txt');f.put(file,'DO NOT READ');f.complete(r,ch);await f.api.idle();a.equal(f.api.stats().disabled,true);a.equal(f.api.stats().published,0);a.equal(f.readPaths.includes(file),false);a.equal(f.deleted.length,0);a(f.rows.has(f.key(file)));});
for(const alias of ['link','hardlink'])test(alias+' manifest is refused before publication or cleanup',async()=>{const f=fixture(),r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);const info=f.materialize(r),row=f.get(path.win32.join(info.root,'manifest.json'));if(alias==='link')row.link=true;else row.nlink=2n;f.complete(r,ch);await f.api.idle();a.equal(f.api.stats().published,0);a.equal(f.deleted.length,0);});
test('tool/source drift invalidates private cache; no stale code is transported',async()=>{const f=fixture();await published(f);a.equal(await f.api.prepare('CHANGED SOURCE'),null);a.equal(f.api.stats().disabled,true);const g=fixture();await published(g);const tool=[...g.rows.values()].find(x=>x.file.endsWith('csc.exe'));tool.bytes=Buffer.from('CHANGED COMPILER');a.equal(await g.api.prepare('PUBLIC SOURCE'),null);a.equal(g.api.stats().disabled,true);});
test('hot child error or missing load marker is never replayed as a fresh compilation',async()=>{const f=fixture();await published(f);const r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);f.complete(r,ch);await f.api.idle();a.equal(f.api.stats().loaded,0);a.equal(f.api.stats().disabled,true);a.equal(f.allocated(),1);});
test('optional cleanup failure disables reuse and leaves original code lifetime verdict untouched',async()=>{const f=fixture({unlinkError:true}),r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);f.materialize(r);f.complete(r,ch);await f.api.idle();a.equal(f.api.stats().published,0);a.equal(f.api.stats().disabled,true);});
test('unsupported cache architecture retains original source compiler path',async()=>{const f=fixture({arch:'ia32'});a.equal(await f.api.prepare('PUBLIC SOURCE'),null);a.equal(f.allocated(),0);a.equal(f.api.stats().disabled,false);});
for(const kind of ['grown','replaced'])test('opened '+kind+' artifact is rejected before its first byte is read',async()=>{
 const f=fixture(),r=await f.api.prepare('PUBLIC SOURCE'),ch=f.child();r.observe(ch);f.materialize(r);const open=f.io.open;
 f.io.open=async file=>{const handle=await open(file);if(file.endsWith('capsule.dll')){const stat=handle.stat;handle.stat=async()=>{const st=await stat();return{...st,...(kind==='grown'?{size:2000000n}:{ino:st.ino+1n})};};}return handle;};
 f.complete(r,ch);await f.api.idle();a.equal(f.api.stats().published,0);a.equal(f.api.stats().disabled,true);a.equal(f.readPaths.some(x=>x.endsWith('capsule.dll')),false);a.equal(f.deleted.length,0);
});
test('bootstrap keeps policy fallback and exact source/native Run while first-use deadline includes preparation',()=>{
 a(block.includes("GetSystemLockdownPolicy().ToString() -ceq 'None'"));a(block.includes("LanguageMode.ToString() -ceq 'FullLanguage'"));a(block.includes('try{Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition $source}'));a(block.includes('-OutputAssembly $dll -OutputType Library -PassThru'));a(block.includes('[Reflection.Assembly]::Load($bytes)'));a(!block.includes('AssemblyResolve'));a(block.includes('[RuyiSkillCapsule]::Run()'));a(block.includes('131072'));a(block.includes('8192'));
 const broker=functionBlock(source,'migrationCapsuleBroker');a(broker.indexOf('const startedAt')<broker.indexOf('await migrationCapsuleCode.prepare'));a(broker.includes('process.hrtime.bigint() - startedAt >= 120000000000n'));a(broker.includes('firstCommand ? Math.ceil(120000 - Number(process.hrtime.bigint() - startedAt) / 1e6) : 120000'));a(broker.includes('}, 2000)'));a(!broker.includes('122000'));
});
test('ACL capability fallback preserves owner and selects one compiler before any TEMP or Run',()=>{
 a.equal(block.includes('.SetOwner('),false);a.equal(block.includes('.SetGroup('),false);a.equal(block.includes('SetAuditRule'),false);
 a(block.includes('[Security.AccessControl.AccessControlSections]::Access'));a(block.includes('GetAccessControl($sink,$access)'));a(block.includes('RemoveAccessRuleSpecific($old)'));a(block.includes('$checkedAcl.AreAccessRulesProtected'));a(block.includes('$rules.Length -ne 1'));a(block.includes('IdentityReference.Equals($sid)'));
 a(block.includes('$kind -eq [UnauthorizedAccessException]'));a(block.includes('$kind -eq [Security.AccessControl.PrivilegeNotHeldException]'));a(block.includes('$kind -eq [NotSupportedException]'));
 const select=block.indexOf('if($cacheAclReady){\n  $temp=');a(select>0);a(block.indexOf('SetAccessControl($sink,$acl)')<select);a(block.indexOf("throw 'native_code_acl'")<select);
 a(block.indexOf("if($cacheAclReady){\n  $temp=")<block.indexOf('-OutputAssembly $dll'));a(block.includes("[Console]::Error.WriteLine('RUYI_CODE_V1_ACL_FALLBACK')"));
 const fallback=block.slice(block.indexOf("[Console]::Error.WriteLine('RUYI_CODE_V1_ACL_FALLBACK')"),block.indexOf('} else {\n  $bytes='));a(fallback.includes('Add-Type -ReferencedAssemblies $meta.references[2] -TypeDefinition $source -PassThru'));a.equal(fallback.includes('-OutputAssembly'),false);a.equal(fallback.includes('Run()'),false);a.equal(fallback.includes('ReadLine'),false);
});
function brokerFixture(prepare){
 let now=0n,spawned=0,writes=0,kills=0;const spawns=[],timers=new Map(),child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stderr.resume=()=>{};child.stdin=new EventEmitter();child.stdin.write=()=>{writes++;};child.stdin.end=()=>{};child.kill=()=>{kills++;};
 const context={Buffer,process:{platform:'win32',env:{},hrtime:{bigint:()=>now}},MIGRATION_SKILL_CAPSULE_NATIVE:'PUBLIC SOURCE',MIGRATION_CAPSULE_ARCHIVE_LIMIT:1024,migrationCapsuleFail:code=>{throw Error(code);},migrationCapsuleCode:{prepare:async()=>prepare?.({setNow:ms=>{now=BigInt(ms)*1000000n;},context})||null},require:name=>name==='node:child_process'?{spawn(executable,args,options){spawned++;spawns.push({executable,args,options});return child;}}:name==='node:timers'?{setTimeout(fn,ms){const token={fn,ms};timers.set(token,token);return token;},clearTimeout:token=>timers.delete(token)}:require(name)};
 vm.createContext(context);vm.runInContext(functionBlock(source,'migrationCapsuleBroker')+'\nthis.make=migrationCapsuleBroker;',context);
 return{context,make:context.make,child,timers,spawns,setNow:ms=>{now=BigInt(ms)*1000000n;},counts:()=>({spawned,writes,kills})};
}
test('first command retains one120s end-to-end envelope through async cache preparation',async()=>{const f=brokerFixture(({setNow})=>setNow(30000)),broker=await f.make();const one=broker.command({cmd:'one'});a([...f.timers].some(([t])=>t.ms===90000));f.child.stdout.emit('data',Buffer.from('{"ok":true,"value":1}\n'));a.equal(await one,1);f.setNow(40000);const two=broker.command({cmd:'two'});a([...f.timers].some(([t])=>t.ms===120000));f.child.stdout.emit('data',Buffer.from('{"ok":true,"value":2}\n'));a.equal(await two,2);const close=broker.close();a([...f.timers].some(([t])=>t.ms===2000));f.child.emit('close',0,null);await close;a.deepEqual(f.counts(),{spawned:1,writes:2,kills:0});});
test('expired preparation or a different helper becoming unknown refuses before new spawn',async()=>{const expired=brokerFixture(({setNow})=>setNow(120000));await a.rejects(expired.make(),e=>e.code==='work_data_backup.native_timeout');a.equal(expired.counts().spawned,0);const unknown=brokerFixture(({context})=>{context.migrationCapsuleBroker.helperMayStillRun=true;});await a.rejects(unknown.make(),e=>e.helperMayStillRun===true);a.equal(unknown.counts().spawned,0);});
test('expired first command writes no business bytes and still requires original mandatory close',async()=>{const f=brokerFixture(),broker=await f.make();f.setNow(120000);await a.rejects(broker.command({cmd:'late'}),e=>e.code==='work_data_backup.native_timeout');a.equal(f.counts().writes,0);a.equal(f.counts().kills,1);const closing=broker.close();let done=false;closing.catch(()=>{done=true;});await Promise.resolve();a.equal(done,false);f.child.emit('close',0,null);await a.rejects(closing,e=>e.code==='work_data_backup.native_timeout');a.equal(f.context.migrationCapsuleBroker.helperMayStillRun,undefined);});

const encode=vm.runInNewContext('('+functionBlock(block,'encodeMetadata')+')',{require,Buffer});
async function wireFixture(hit=true){const f=fixture(),r=await f.api.prepare('PUBLIC SOURCE'),value=metadata(r);if(hit)Object.assign(value,{artifactHash:'a'.repeat(64),clr:'4.0.30319.42000',mvid:'12345678-1234-1234-1234-123456789abc'});return value;}
test('metadata wire preserves exact cold/hot public context and never treats Unicode punctuation as code',async()=>{for(const hit of [false,true]){const m=await wireFixture(hit),text="W:\\Windows\\'‘’`$(not-code);#{}\\é.dll";m.executable=text;m.files[0].file=text;const result=metadata({env:{RUYI_SKILL_CAPSULE_CODE_META:encode(m)}});a.deepEqual(result,m);a.equal(Buffer.from(encode(m),'base64').filter(x=>x===0).length,hit?43:40);}});
test('metadata encoder refuses malformed shape UTF8 NUL oversized values hashes and reference order',async()=>{const base=await wireFixture();for(const mutate of [m=>{m.executable+='\0';},m=>{m.executable+='\ud800';},m=>{m.executable='relative';},m=>{m.key+='\n';},m=>{m.key='A'.repeat(64);},m=>{m.files.pop();},m=>{m.references.pop();},m=>{[m.references[0],m.references[1]]=[m.references[1],m.references[0]];},m=>{m.files[1].file=m.files[0].file;},m=>{m.mvid+='\n';},m=>{delete m.clr;},m=>{m.clr='x';},m=>{m.executable='W:\\'+ 'x'.repeat(32760);},m=>{for(let n=0;n<14;n++)m.files[n].file='W:\\'+String(n)+'x'.repeat(2000);m.references=m.files.slice(10).map(x=>x.file);}]){const value=structuredClone(base);mutate(value);a.throws(()=>encode(value),/native_code_metadata/);}});
test('metadata own-property readers never invoke accessors array map or Proxy traps',async()=>{const base=await wireFixture();for(const location of ['key','row','files-index','refs-index','files-map']){const value=structuredClone(base);let calls=0;const target=location==='key'?value:location==='row'?value.files[0]:location.startsWith('files')?value.files:value.references,key=location==='key'?'key':location==='row'?'file':location==='files-map'?'map':'0';Object.defineProperty(target,key,{configurable:true,get(){calls++;throw Error('accessor executed');}});a.throws(()=>encode(value),/native_code_metadata/);a.equal(calls,0);}for(const kind of ['meta','files','row']){let traps=0;const value=structuredClone(base),proxy=new Proxy(kind==='meta'?value:kind==='files'?value.files:value.files[0],{get(){traps++;throw Error('proxy get');},getOwnPropertyDescriptor(){traps++;throw Error('proxy descriptor');}});if(kind==='files')value.files=proxy;else if(kind==='row')value.files[0]=proxy;a.throws(()=>encode(kind==='meta'?proxy:value),/native_code_metadata/);a.equal(traps,0);}});
test('metadata schema implementation is bound into code identity and oversized full argv refuses before sink creation',async()=>{const first=fixture(),one=metadata(await first.api.prepare('PUBLIC SOURCE')),changed=fixture({block:block.replace('function encodeMetadata(meta) {','function encodeMetadata(meta) {\n    // Different codec implementation identity.')}),two=metadata(await changed.api.prepare('PUBLIC SOURCE'));a.notEqual(one.key,two.key);const large=fixture();large.process.env.SystemRoot='W:\\'+'x'.repeat(5000);a.equal(await large.api.prepare('PUBLIC SOURCE'),null);a.equal(large.allocated(),0);a.equal(large.api.stats().disabled,true);a(block.indexOf('commandUnits > 32767')<block.indexOf('sink = await io.mkdtemp'));});
test('metadata decoder stays within the original full-language policy gate and original verification path',()=>{const bootstrap=vm.runInNewContext(constBlock(block,'bootstrap')+';bootstrap',{});a.equal(bootstrap.includes('ConvertFrom-Json'),false);a.equal(/\b(?:IEX|Invoke-Expression)\b/.test(bootstrap),false);a(bootstrap.indexOf('if(!$useCode)')<bootstrap.indexOf('function CodeMetaDecode'));a(bootstrap.indexOf('function CodeMetaDecode')<bootstrap.indexOf('$meta=CodeMetaDecode $meta64 ([bool]($encoded -ne \'\'))'));a(bootstrap.indexOf('$meta64=$env:RUYI_SKILL_CAPSULE_CODE_META')<bootstrap.indexOf("StartsWith('RUYI_SKILL_CAPSULE_'"));a(bootstrap.includes('[Text.UTF8Encoding]::new($false,$true)'));a(bootstrap.includes('$fields.Length -ne $(if($expectedHit){44}else{41})'));a(bootstrap.includes('$files[10+$n].file'));a(bootstrap.includes('CodeHash ([IO.File]::ReadAllBytes($file.file))'));});

test('Windows metadata parser accepts full semantic values and refuses every transport boundary without executing code',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const cp=require('node:child_process'),os=require('node:os'),root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-code-meta-parser-')),env=require('../lib/release-checks').releaseEnvironment(path.join(root,'home'),path.join(root,'data')),bootstrap=vm.runInNewContext(constBlock(block,'bootstrap')+';bootstrap',{}),decoder=bracedDecoder(bootstrap),hot=await wireFixture(),cold=await wireFixture(false),special=structuredClone(hot);special.executable="W:\\Windows\\'‘’`$(literal);#{}\\é.dll";special.files[0].file=special.executable;
 const cases=[{name:'cold',wire:encode(cold),hit:false,valid:true,value:cold},{name:'hot',wire:encode(hot),hit:true,valid:true,value:hot},{name:'Unicode',wire:encode(special),hit:true,valid:true,value:special},{name:'hot-as-cold',wire:encode(hot),hit:false,valid:false},{name:'cold-as-hot',wire:encode(cold),hit:true,valid:false},{name:'base64',wire:'invalid',hit:false,valid:false},{name:'utf8',wire:Buffer.from([255]).toString('base64'),hit:false,valid:false}];
 const fields=Buffer.from(encode(hot),'base64').toString('utf8').split('\0');for(let n=0;n<fields.length;n++){const changed=[...fields];changed[n]='';cases.push({name:'empty-'+n,wire:Buffer.from(changed.join('\0')).toString('base64'),hit:true,valid:false});}for(const [name,index,value]of [['header',0,'x'],['revision',1,'2'],['arch',2,'ia32'],['key-length',4,fields[4]+'\n'],['hash-length',8,fields[8]+'\n'],['files',6,'13'],['file-duplicate',9,fields[7].toUpperCase()],['refs',35,'3'],['ref-order',36,fields[37]],['mode',40,'0'],['mvid-length',43,fields[43]+'\n']]){const changed=[...fields];changed[index]=value;cases.push({name,wire:Buffer.from(changed.join('\0')).toString('base64'),hit:true,valid:false});}cases.push({name:'trailing',wire:Buffer.from([...fields,'extra'].join('\0')).toString('base64'),hit:true,valid:false},{name:'oversized',wire:'A'.repeat(32764),hit:true,valid:false});
 const payload=JSON.stringify(cases.map(({value,...row})=>row));a(Buffer.byteLength(payload)<1048576);const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';\n"+decoder+"\n$text=[Text.StringBuilder]::new();$buffer=New-Object char[] 4096;while(($read=[Console]::In.Read($buffer,0,$buffer.Length)) -gt 0){if($text.Length+$read -gt 1048576){throw 'input_limit'};$null=$text.Append($buffer,0,$read)};$cases=$text.ToString()|ConvertFrom-Json;$rows=@();foreach($case in $cases){$ok=$false;$value=$null;try{$value=CodeMetaDecode $case.wire ([bool]$case.hit);$ok=$true}catch{};$rows+=@{name=$case.name;valid=$ok;value=$value}};$json=ConvertTo-Json -InputObject $rows -Depth 9 -Compress;[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))";
 try{const r=cp.spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true,encoding:'utf8',input:payload,maxBuffer:2*1024*1024,timeout:30000});a.equal(r.status,0,r.stderr);a.equal(r.stderr,'');const rows=JSON.parse(Buffer.from(r.stdout.trim(),'base64').toString('utf8'));a.equal(rows.length,cases.length);for(let n=0;n<cases.length;n++){a.equal(rows[n].name,cases[n].name);a.equal(rows[n].valid,cases[n].valid,cases[n].name);if(cases[n].valid)a.deepEqual(rows[n].value,cases[n].value);}}finally{fs.rmSync(root,{recursive:true,force:true});}
});
function bracedDecoder(bootstrap){const {bracedBlock}=require('../lib/source-slice');return bracedBlock(bootstrap,'function CodeMetaDecode');}


for(const length of [128,129,203])test('cold cache TEMP root '+length+' UTF-16 units uses the explicit optional budget before allocation',async()=>{
 const root='T:\\'+'t'.repeat(length-3),f=fixture({tmpdir:root}),before=JSON.stringify(f.process.env);
 a.equal(path.win32.resolve(root).length,length);const prepared=await f.api.prepare('PUBLIC SOURCE');
 a.equal(JSON.stringify(f.process.env),before,'optional admission never rewrites the original process TEMP or other environment');
 if(length<=128){a(prepared);a.equal(f.allocated(),1);a.equal(path.win32.dirname(prepared.env.RUYI_SKILL_CAPSULE_CODE_SINK),path.win32.resolve(root));a.equal(metadata(prepared).sourceHash,hash('PUBLIC SOURCE'));}
 else{a.equal(prepared,null);a.equal(f.allocated(),0);a.equal(f.api.stats().pending,0);a.equal(f.api.stats().published,0);a.equal(f.api.stats().disabled,true);a.equal([...f.rows.values()].some(row=>path.win32.basename(row.file).startsWith('ruyi-native-code-')),false);}
});
test('cold cache counts UTF-16 units and admits a short Unicode root without an encoding blanket ban',async()=>{
 const root='T:\\'+'演'.repeat(125),f=fixture({tmpdir:root});a.equal(path.win32.resolve(root).length,128);a(Buffer.byteLength(root,'utf8')>128);
 const prepared=await f.api.prepare('PUBLIC SOURCE');a(prepared);a.equal(f.allocated(),1);a.equal(path.win32.dirname(prepared.env.RUYI_SKILL_CAPSULE_CODE_SINK),path.win32.resolve(root));
});
test('validated hot bytes bypass cold TEMP geometry without skipping source and context identity',async()=>{
 const f=fixture(),info=await published(f),key=f.api.stats().codeIdentity.contextKey;
 f.setTmpdir('T:\\'+'t'.repeat(200));const hot=await f.api.prepare('PUBLIC SOURCE');a(hot);a.equal(hot.env.RUYI_SKILL_CAPSULE_CODE_SINK,'');a.equal(f.allocated(),1);
 const meta=metadata(hot);a.equal(meta.key,key);a.equal(meta.artifactHash,hash(info.bytes));a.equal(Buffer.from(hot.env.RUYI_SKILL_CAPSULE_CODE_0,'base64').toString(),info.bytes.toString());
 const child=f.child();hot.observe(child);f.complete(hot,child,{marker:'RUYI_CODE_V1_LOAD|'+meta.artifactHash+'\r\n'});await f.api.idle();a.equal(f.api.stats().loaded,1);a.equal(f.api.stats().disabled,false);
 a.equal(await f.api.prepare('CHANGED SOURCE'),null);a.equal(f.api.stats().disabled,true);a.equal(f.allocated(),1);
});
test('declined cold-cache geometry preserves one original source child and its remaining deadline and close',async()=>{
 const cache=fixture({tmpdir:'T:\\'+'t'.repeat(200)}),f=brokerFixture(({setNow})=>{setNow(30000);return cache.api.prepare('PUBLIC SOURCE');}),broker=await f.make();
 a.equal(cache.allocated(),0);a.equal(f.spawns.length,1);const spawn=f.spawns[0];a.equal(spawn.executable,'powershell.exe');a.deepEqual(Array.from(spawn.args.slice(0,4)),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand']);
 const plain=vm.runInNewContext(constBlock(functionBlock(source,'migrationCapsuleBroker'),'bootstrap')+';bootstrap',{});a.equal(Buffer.from(spawn.args[4],'base64').toString('utf16le'),plain);
 a.deepEqual(Object.keys(spawn.options.env),['RUYI_SKILL_CAPSULE_SOURCE']);a.equal(Buffer.from(spawn.options.env.RUYI_SKILL_CAPSULE_SOURCE,'base64').toString(),'PUBLIC SOURCE');
 const command=broker.command({cmd:'one'});a([...f.timers].some(([timer])=>timer.ms===90000));f.child.stdout.emit('data',Buffer.from('{"ok":true,"value":1}\n'));a.equal(await command,1);
 let closed=false;const closing=broker.close().then(()=>{closed=true;});await Promise.resolve();a.equal(closed,false);a([...f.timers].some(([timer])=>timer.ms===2000));f.child.emit('exit',0,null);await Promise.resolve();a.equal(closed,false);f.child.emit('close',0,null);await closing;a.deepEqual(f.counts(),{spawned:1,writes:1,kills:0});
});
test('an issued source child failure after cache decline is never retried or settled before original close',async()=>{
 const cache=fixture({tmpdir:'T:\\'+'t'.repeat(200)}),f=brokerFixture(()=>cache.api.prepare('PUBLIC SOURCE')),broker=await f.make();
 const command=broker.command({cmd:'one'}),rejected=a.rejects(command,error=>error.code==='work_data_backup.native_exit');f.child.emit('exit',1,null);
 let closed=false;const closing=broker.close().then(()=>{closed=true;},error=>{closed=true;throw error;});const closeRejected=a.rejects(closing,error=>error.code==='work_data_backup.native_exit');await Promise.resolve();a.equal(closed,false);a.equal(f.spawns.length,1);
 f.child.emit('close',1,null);await rejected;await closeRejected;a.equal(cache.allocated(),0);a.deepEqual(f.counts(),{spawned:1,writes:1,kills:0});
});
