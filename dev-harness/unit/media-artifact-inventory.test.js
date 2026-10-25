'use strict';
// 此文件只验证库存，不允许运行解释器、媒体程序、子进程或网络。
require('../lib/media-artifact-test-guard');
{
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');const {verifyArtifactFiles}=require('../../ruyi-workbench/tools/media-runtime-lock.cjs');const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function fixture(work){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ruyi-media-artifact-unit-'));try{await fs.mkdir(path.join(root,'runtime'));const data=Buffer.from('SYNTHETIC_RUNTIME');await fs.writeFile(path.join(root,'runtime','codec.bin'),data);await work(root,{path:'runtime/codec.bin',bytes:data.length,sha256:sha(data)});}finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('ruyi-media-artifact-unit-'));await fs.rm(root,{recursive:true,force:true});}}
test('exact artifact bytes verified without enabling egress',()=>fixture(async(root,row)=>{assert.deepEqual(await verifyArtifactFiles(root,[row]),{ok:true,artifacts:1,verifiedBytes:17,installsPerformed:false,mediaEgressEnabled:false});}));
test('same-length altered payload rejected',()=>fixture(async(root,row)=>{await fs.writeFile(path.join(root,'runtime','codec.bin'),'TYNTHETIC_RUNTIME');await assert.rejects(verifyArtifactFiles(root,[row]),{code:'media.artifact_changed'});}));
test('truncated artifact rejected',()=>fixture(async(root,row)=>{await fs.writeFile(path.join(root,'runtime','codec.bin'),'short');await assert.rejects(verifyArtifactFiles(root,[row]),{code:'media.artifact_changed'});}));
test('directory pretending to be runtime artifact rejected',()=>fixture(async(root,row)=>{await assert.rejects(verifyArtifactFiles(root,[{...row,path:'runtime'}]),{code:'media.artifact_kind'});}));
test('unknown malformed and escaping artifact names rejected before I/O',()=>fixture(async(root,row)=>{for(const name of ['../outside','/absolute','runtime/./codec.bin','runtime//codec.bin','runtime\\codec.bin','C:/codec.bin','runtime/codec.bin:ads'])await assert.rejects(verifyArtifactFiles(root,[{...row,path:name}]),{code:'media.artifact_shape'});}));
test('duplicate artifact proof rejected',()=>fixture(async(root,row)=>{await assert.rejects(verifyArtifactFiles(root,[row,row]),{code:'media.artifact_duplicate'});}));
test('invalid SHA and byte counts rejected',()=>fixture(async(root,row)=>{for(const mutation of [{sha256:'00'},{bytes:1.5},{bytes:-1},{bytes:Number.MAX_SAFE_INTEGER}])await assert.rejects(verifyArtifactFiles(root,[{...row,...mutation}]),{code:'media.artifact_shape'});}));
test('aggregate declared cap checked before opening artifacts',()=>fixture(async(root,row)=>{const rows=[0,1,2].map(n=>({...row,path:'runtime/'+n,bytes:128*1024*1024}));await assert.rejects(verifyArtifactFiles(root,rows),{code:'media.artifact_limit'});}));

test('missing Slim component gives typed refusal',()=>fixture(async(root,row)=>{await assert.rejects(verifyArtifactFiles(root,[{...row,path:'runtime/missing.bin'}]),{code:'media.component_missing',retry:false});}));

}

{
'use strict';
const{test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),vm=require('node:vm'),tools=p.resolve(__dirname,'../../ruyi-workbench/tools'),source=fs.readFileSync(p.join(tools,'verify-media-artifacts.cjs'),'utf8');
function model(gate,read=fs.readFileSync){const module={exports:{}},request=name=>name==='./media-runtime-lock.cjs'?{verifyArtifactFiles:gate}:name==='node:fs'?{readFileSync:read}:require(name);request.main={};vm.runInNewContext('(function(require,module,exports,__dirname){'+source+'\n})',{console,process:{argv:[]}})(request,module,module.exports,tools);return module.exports;}
const proof=rows=>({ok:true,artifacts:rows.length,verifiedBytes:rows.reduce((sum,row)=>sum+row.bytes,0),installsPerformed:false,mediaEgressEnabled:false});
const runtime=p.resolve('synthetic-media-runtime'),sources=p.resolve('synthetic-media-sources');
test('bundled private locks are captured before await and both exact artifact groups gate inventory-only success',async()=>{const calls=[],reads=[];const api=model(async(root,rows)=>{a.equal(reads.length,2);a.equal(Object.isFrozen(rows),true);a.equal(rows.every(Object.isFrozen),true);a.throws(()=>{rows[0].sha256='f'.repeat(64);},TypeError);calls.push({root,count:rows.length,first:rows[0].path});return proof(rows);},(...args)=>{reads.push(args[0]);return fs.readFileSync(...args);});const result=await api.verifyMediaArtifacts(runtime,sources);a.equal(calls.length,11);a.equal(calls[0].root,sources);a.equal(calls[0].count,1);a.equal(calls[0].first,'opencv-windows-ffmpeg-source-sidecar.zip');a.equal(calls[1].root,runtime);a.equal(calls.slice(1).reduce((n,row)=>n+row.count,0),4987);a.equal(result.dependencyFilesVerified,true);a.equal(result.sourceArchiveVerified,true);a.equal(result.pythonVersion,'3.12.10');a.equal(result.verifiedSourceBytes,19922194);a.equal(result.installsPerformed,false);a.equal(result.mediaProcessingEnabled,false);a.equal(result.mediaEgressEnabled,false);a.equal(Object.isFrozen(result),true);});
test('missing source archive refuses before any runtime verification or alternative provider',async()=>{let calls=0;const fault=Object.assign(Error('missing-synthetic'),{code:'media.component_missing'}),api=model(async()=>{calls++;throw fault;});await a.rejects(()=>api.verifyMediaArtifacts(runtime,sources),error=>error===fault);a.equal(calls,1);});
test('missing Slim runtime or changed Full payload never returns an admission receipt',async()=>{for(const code of ['media.component_missing','media.artifact_changed']){let calls=0;const fault=Object.assign(Error(code),{code}),api=model(async(_root,rows)=>{if(++calls===2)throw fault;return proof(rows);});await a.rejects(()=>api.verifyMediaArtifacts(runtime,sources),error=>error===fault);a.equal(calls,2);}});
test('a lock byte change refuses before asynchronous verifier even if JSON still parses',async()=>{let calls=0;const api=model(async()=>{calls++;},file=>Buffer.concat([fs.readFileSync(file),Buffer.from('\n')]));await a.rejects(()=>api.verifyMediaArtifacts(runtime,sources),{code:'media.lock_changed'});a.equal(calls,0);});
test('both roots require explicit absolute primitive paths before reading locks or invoking a gate',async()=>{let reads=0,calls=0;const api=model(async()=>{calls++;},()=>{reads++;});for(const args of [[undefined,sources],[runtime,null],['relative',sources],[runtime,'relative']])await a.rejects(()=>api.verifyMediaArtifacts(...args),{code:'media.artifact_shape'});a.equal(calls,0);a.equal(reads,0);});
test('invalid and falsy gate outcomes cannot become success',async()=>{for(const returned of [null,undefined,false,0,{}, {ok:true}]){const api=model(async()=>returned);await a.rejects(()=>api.verifyMediaArtifacts(runtime,sources),{code:'media.artifact_receipt'});}for(const cause of [null,undefined,false,0,'']){const api=model(async()=>{throw cause;});let failed=false;try{await api.verifyMediaArtifacts(runtime,sources);}catch(error){failed=true;a.equal(error,cause);}a.equal(failed,true);}});
test('the promoted low-level gate remains byte exact to approved b927 with no new execution imports',()=>{const gate=fs.readFileSync(p.join(tools,'media-runtime-lock.cjs'));a.equal(c.createHash('sha256').update(gate).digest('hex'),'b92703bd84f3b239e8ad6b568c080aa92a240d8e85829f354fc5eaae600c59c0');a.doesNotMatch(source,/child_process|worker_threads|https?:|fetch\(|spawn\(|exec\(|pip\b/);});

}

{
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),p=require('node:path'),os=require('node:os'),c=require('node:crypto');
const {verifyArtifactFiles}=require('../../ruyi-workbench/tools/media-runtime-lock.cjs');
const hash=b=>c.createHash('sha256').update(b).digest('hex');
async function fixture(t){const root=await fs.mkdtemp(p.join(os.tmpdir(),'ruyi-m4-independent-'));t.after(async()=>{assert.equal(p.dirname(root),p.resolve(os.tmpdir()));assert.ok(p.basename(root).startsWith('ruyi-m4-independent-'));await fs.rm(root,{recursive:true,force:true});});return root;}
test('artifact manifest is privately snapshotted before asynchronous filesystem work',async t=>{
 const root=await fixture(t),base=p.join(root,'package'),bytes=Buffer.from('SYNTHETIC_EXPECTED_ARTIFACT');await fs.mkdir(base);await fs.writeFile(p.join(base,'expected.bin'),bytes);await fs.writeFile(p.join(root,'outside.bin'),bytes);
 const row={path:'expected.bin',bytes:bytes.length,sha256:hash(bytes)},pending=verifyArtifactFiles(base,[row]);row.path='../outside.bin';await fs.unlink(p.join(base,'expected.bin'));
 await assert.rejects(pending,e=>e.code==='media.component_missing'||e.code==='media.artifact_changed');
});
test('artifact package ancestry cannot traverse an owned directory junction',async t=>{
 const root=await fixture(t),actual=p.join(root,'actual'),alias=p.join(root,'alias'),base=p.join(actual,'package'),bytes=Buffer.from('SYNTHETIC_EXPECTED_ARTIFACT');await fs.mkdir(base,{recursive:true});await fs.writeFile(p.join(base,'expected.bin'),bytes);await fs.symlink(actual,alias,process.platform==='win32'?'junction':'dir');
 try{await assert.rejects(verifyArtifactFiles(p.join(alias,'package'),[{path:'expected.bin',bytes:bytes.length,sha256:hash(bytes)}]),e=>e.code?.startsWith('media.'));}finally{await fs.unlink(alias);}
});

}

{
'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
test('raw review permanently denies native child sockets servers clusters and worker construction',()=>{
 const codes=new Set(['fixture.native_forbidden','fixture.socket_forbidden','fixture.native_or_socket_forbidden']);
 for(const [moduleName,names] of [
  ['node:child_process',['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync']],
  ['node:net',['createServer','connect','createConnection','Socket','Server']],
  ['node:tls',['createServer','connect','TLSSocket','Server']],
  ['node:http',['createServer','request','get','Server']],
  ['node:https',['createServer','request','get','Server']],
  ['node:http2',['createServer','createSecureServer','connect']],
  ['node:dgram',['createSocket','Socket']],['node:cluster',['fork']]
 ])for(const name of names)a.throws(()=>require(moduleName)[name](),error=>codes.has(error.code),moduleName+'.'+name);
 a.throws(()=>new (require('node:worker_threads').Worker)(''),error=>codes.has(error.code));
});

}


{
'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),c=require('node:crypto');
const tools=p.resolve(__dirname,'../../ruyi-workbench/tools'),source=fs.readFileSync(p.join(tools,'verify-media-artifacts.cjs'),'utf8'),lock=JSON.parse(fs.readFileSync(p.join(tools,'../resources/media-runtime-dependencies.json'))),hash=b=>c.createHash('sha256').update(b).digest('hex');
const proof=rows=>({ok:true,artifacts:rows.length,verifiedBytes:rows.reduce((n,r)=>n+r.bytes,0),installsPerformed:false,mediaEgressEnabled:false});
function model(gate,reader=fs.readFileSync){const module={exports:{}},request=name=>name==='./media-runtime-lock.cjs'?{verifyArtifactFiles:gate}:name==='node:fs'?{readFileSync:reader}:require(name);request.main={};const context={require:request,module,exports:module.exports,__dirname:tools,process:{argv:[]},console,AbortSignal};vm.runInNewContext(source+';this.groups=groupRows;',context);return{api:module.exports,groups:context.groups};}
const root=p.resolve('synthetic-closed-runtime'),sources=p.resolve('synthetic-closed-source');
test('old82 byte tuples are conserved while exactly three false license classifications change',()=>{a.equal(lock.artifacts.length,4987);a.equal(lock.closure.original82Tuples.length,82);a.equal(hash(JSON.stringify(lock.closure.original82Tuples)),'720e97d9ca79c9ea1d8a3c27d21d7f34e887a7007a9f9b0b6c138799b637e452');const byPath=new Map(lock.artifacts.map(r=>[r.path,r]));for(const old of lock.closure.original82Tuples){const row=byPath.get(old.path);a.deepEqual([row.path,row.bytes,row.sha256],[old.path,old.bytes,old.sha256]);}a.equal(lock.closure.correctedRoles.length,3);for(const row of lock.closure.correctedRoles){a.equal(row.before,'license');a.ok(row.after.startsWith('runtime-'));a.equal(byPath.get(row.path).role,row.after);}});
test('21 distributions retain all RECORD rows with separate hashed self-record and bytecode provenance',()=>{a.equal(lock.components.length,21);a.equal(lock.closure.recordRows,4931);a.equal(lock.closure.recordHashedRows,3178);a.equal(lock.closure.unhashedRecordRows,1753);a.equal(lock.closure.selfRecordRows,21);a.equal(lock.closure.bytecodeRowsBackedOnlyByFullManifest,1732);for(const row of lock.artifacts){for(const proof of row.proofs){if(proof.kind==='record-sha256-and-original-full-manifest')a.equal(proof.recordHash,'sha256='+Buffer.from(row.sha256,'hex').toString('base64url'));if(proof.kind==='original-full-manifest-unhashed-record'){a.equal(proof.recordHash,null);a.equal(proof.originalManifestSha256,lock.originalFullManifest.sha256);a.ok(row.path.endsWith('/RECORD')||row.path.endsWith('.pyc'));}}}});
test('seven extra wheels and missing notice spellings are explicit without inventing installed extras or OS capabilities',()=>{a.equal(lock.closure.newCachedTransitiveWheels.length,7);for(const path of ['openpyxl-3.1.5.dist-info/LICENCE.rst','et_xmlfile-2.0.0.dist-info/LICENCE.python','typing_extensions-4.16.0.dist-info/licenses/LICENSE'])a.ok(lock.artifacts.some(r=>r.path.endsWith('/'+path)));a.equal(lock.closure.actualProcessorValidation,false);a.equal(lock.closure.completeAccServerDependencyClosure,false);a.ok(lock.closure.windowsPrerequisites.length>=3);a.ok(lock.closure.unfrozenCapabilities.some(r=>r.startsWith('ASR')));a.ok(lock.closure.inactiveOptionalBranches.every(r=>r.enabledByThisInventory===false));});
test('the actual immutable complete snapshots precede the first await and every fixed bounded group must verify',async()=>{const calls=[],reads=[];const {api}=model(async(file,rows)=>{a.equal(reads.length,2);a.equal(Object.isFrozen(rows),true);a.equal(rows.every(Object.isFrozen),true);a.throws(()=>{rows[0].sha256='f'.repeat(64);},TypeError);a.ok(rows.length<=512);a.ok(rows.reduce((n,r)=>n+r.bytes,0)<=256*1024*1024);calls.push({file,rows});return proof(rows);},(...args)=>{reads.push(args[0]);return fs.readFileSync(...args);});const result=await api.verifyMediaArtifacts(root,sources);a.equal(calls.length,11);a.equal(calls[0].file,sources);a.equal(calls[0].rows.length,1);const all=calls.slice(1).flatMap(r=>r.rows);a.equal(all.length,4987);a.equal(new Set(all.map(r=>r.path.toLowerCase())).size,4987);a.deepEqual(all.map(r=>r.path).sort(),lock.artifacts.map(r=>r.path).sort());a.equal(result.runtimeArtifacts,4987);a.equal(result.verifiedRuntimeBytes,413946142);a.equal(result.installsPerformed,false);a.equal(result.mediaProcessingEnabled,false);a.equal(result.mediaEgressEnabled,false);a.equal(Object.isFrozen(result),true);});
for(const [label,mutation]of[['same-path',last=>({...last,path:'row-0'})],['Windows-case-alias',last=>({...last,path:'ROW-0'})],['conflicting-hash',last=>({...last,path:'row-0',sha256:'b'.repeat(64)})]])test('actual grouping rejects '+label+' across a 512-row boundary before any gate',()=>{let calls=0;const {groups}=model(async()=>{calls++;});const rows=Array.from({length:513},(_,n)=>({path:'row-'+n,bytes:1,sha256:'a'.repeat(64)}));rows[512]=mutation(rows[512]);a.throws(()=>groups(rows),{code:'media.artifact_duplicate'});a.equal(calls,0);});
test('group limits remain 512 rows 256MiB and original per-file128MiB without raising b927',()=>{const {groups}=model(async()=>{}),row={path:'large',bytes:128*1024*1024,sha256:'a'.repeat(64)},result=groups([row,{...row,path:'second'},{...row,path:'third'}]);a.equal(result.groups.length,2);a.equal(result.groups[0].rows.length,2);a.equal(result.groups[0].bytes,256*1024*1024);a.equal(result.groups[1].bytes,128*1024*1024);a.throws(()=>groups([{...row,bytes:128*1024*1024+1}]),{code:'media.artifact_shape'});const gate=fs.readFileSync(p.join(tools,'media-runtime-lock.cjs'));a.equal(hash(gate),'b92703bd84f3b239e8ad6b568c080aa92a240d8e85829f354fc5eaae600c59c0');a.equal(gate.length,4067);});
for(const failure of [null,undefined,false,0,'',Object.assign(Error('last-group'),{code:'media.artifact_changed'})])test('last group failure '+String(failure)+' never returns aggregate success',async()=>{let calls=0,failed=false;const {api}=model(async(_root,rows)=>{if(++calls===11)throw failure;return proof(rows);});try{await api.verifyMediaArtifacts(root,sources);}catch(error){failed=true;a.equal(error,failure);}a.equal(failed,true);a.equal(calls,11);});
test('a false receipt only in the final group cannot be hidden by earlier valid receipts',async()=>{let calls=0;const {api}=model(async(_root,rows)=>++calls===11?{...proof(rows),verifiedBytes:0}:proof(rows));await a.rejects(()=>api.verifyMediaArtifacts(root,sources),{code:'media.artifact_receipt'});a.equal(calls,11);});
test('pre-cancel performs no gate, between-group cancel and final-group cancel never grant success',async()=>{for(const at of[0,2,11]){const controller=new AbortController();let calls=0;if(at===0)controller.abort();const {api}=model(async(_root,rows)=>{calls++;if(calls===at)controller.abort();return proof(rows);});await a.rejects(()=>api.verifyMediaArtifacts(root,sources,{signal:controller.signal}),{code:'media.artifact_cancelled'});a.equal(calls,at);}});
test('locked bytes or source identity changes reject before any asynchronous gate',async()=>{for(const name of['media-runtime-dependencies.json','media-runtime-sources.json']){let calls=0;const {api}=model(async()=>{calls++;},file=>p.basename(file)===name?Buffer.concat([fs.readFileSync(file),Buffer.from('\n')]):fs.readFileSync(file));await a.rejects(()=>api.verifyMediaArtifacts(root,sources),{code:'media.lock_changed'});a.equal(calls,0);}});
test('package only updates verifier digest while first Application and all ordinary branch source remain exact',()=>{const now=fs.readFileSync(p.join(tools,'package-offline.ps1'),'utf8'),currentHash=hash(fs.readFileSync(p.join(tools,'verify-media-artifacts.cjs')));a.equal(hash(Buffer.from(now.replace(currentHash,()=> '7eed396fb315e0c40378fa6f994015483614ce2412a99afae5d7a52449c71613'))),'c2b4949033728f3e12c7adb2abdd0d4ed2874981259641b48cf8c2ae6d762402');a.match(now,/\$mediaNode = Get-Command node\.exe -CommandType Application -ErrorAction SilentlyContinue \| Select-Object -First 1/);a.equal(hash(fs.readFileSync(p.join(tools,'../resources/media-runtime-sources.json'))),'96b07893303e89c9ba668247aa9fb95a15d879c7fd741e674dbfc8491d11fd29');});

}
