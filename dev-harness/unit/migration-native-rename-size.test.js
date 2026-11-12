'use strict';
require('../lib/media-artifact-test-guard');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{test}=require('node:test');
const {constBlock,bracedBlock,functionBlock}=require('../lib/source-slice'),repo=path.resolve(__dirname,'../..');
const source=fs.readFileSync(process.env.RUYI_RENAME_NATIVE_SOURCE||path.join(repo,'ruyi-workbench/app/src/13u-migration-center.js'),'utf8');
const native=vm.runInNewContext(constBlock(source,'MIGRATION_SKILL_CAPSULE_NATIVE')+';MIGRATION_SKILL_CAPSULE_NATIVE',{}),rename=bracedBlock(native,'static void Rename('),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
// Independent WDK structure layout: flag union, HANDLE, ULONG, WCHAR[1], tail alignment.
const align=(value,size)=>Math.ceil(value/size)*size;
function abi(pointer){const root=align(4,pointer),length=root+pointer,name=length+4,size=align(name+2,pointer);return{root,length,name,size};}
function producer(pointer,text){const bytes=Buffer.from(text,'utf16le'),offset=pointer===8?20:12,alloc=/Marshal\.AllocHGlobal\(([^;]+)\);/.exec(rename)[1];let expression=alloc;
 if(alloc==='size'){expression=/int size = ([^;]+);/.exec(rename)[1].replace(/^checked\((.*)\)$/,'$1');}
 expression=expression.replaceAll('IntPtr.Size','pointer').replaceAll('name.Length','bytes');assert.match(expression,/^[0-9a-zA-Z_+?:=()<> .-]+$/);
 const size=vm.runInNewContext(expression,{pointer,bytes:bytes.length,offset},{timeout:100});return{bytes,offset,size};}
test('documented rename buffers cover sizeof plus real UTF16 bytes for canonical one-character and long names',()=>{
 for(const pointer of [4,8])for(const name of ['D','A','B','ab','A.bin','é','😀','x'.repeat(64),'E:\\synthetic\\renamed']){const layout=abi(pointer),packet=producer(pointer,name);assert.equal(layout.name,pointer===8?20:12);assert.equal(layout.size,pointer===8?24:16);assert.ok(packet.size>=layout.size+packet.bytes.length,'native FILE_RENAME_INFORMATION sizeof plus name bytes');assert.equal(packet.offset,layout.name);assert.ok(Number.isSafeInteger(packet.size));}
});
test('one-character padding never changes encoded filename length, parent offsets or no-replace flags',()=>{
 for(const pointer of [4,8])for(const text of ['D','😀']){const layout=abi(pointer),packet=producer(pointer,text),buffer=Buffer.alloc(packet.size);if(pointer===8)buffer.writeBigUInt64LE(1n,layout.root);else buffer.writeUInt32LE(1,layout.root);buffer.writeUInt32LE(packet.bytes.length,layout.length);packet.bytes.copy(buffer,packet.offset);assert.equal(buffer.readUInt32LE(0),0);assert.equal(buffer.readUInt32LE(layout.length),Buffer.byteLength(text,'utf16le'));assert.ok(buffer.subarray(packet.offset,packet.offset+packet.bytes.length).equals(Buffer.from(text,'utf16le')));assert.ok(buffer.subarray(packet.offset+packet.bytes.length).every(value=>value===0));}
 assert.ok(rename.includes('Marshal.WriteInt32(value, IntPtr.Size == 8 ? 16 : 8, name.Length)'));assert.ok(rename.includes('Marshal.Copy(name, 0, IntPtr.Add(value, offset), name.Length)'));
});
test('allocation zeroing and native Length share one checked size and exact historical Rename inverse',()=>{
 assert.ok(rename.includes('int size = checked((IntPtr.Size == 8 ? 24 : 16) + name.Length);'));assert.ok(rename.includes('Marshal.AllocHGlobal(size)'));assert.ok(rename.includes('i<size'));assert.ok(rename.includes('NtSetInformationFile(node.Handle, iosb, value, (uint)size, 10)'));
 const original=rename.replace('int size = checked((IntPtr.Size == 8 ? 24 : 16) + name.Length);\n    IntPtr value = Marshal.AllocHGlobal(size);','IntPtr value = Marshal.AllocHGlobal(offset + name.Length);').replace('i<size','i<offset + name.Length').replace('(uint)size, 10','(uint)(offset + name.Length), 10');assert.notEqual(original,rename);
 // The exact pre-fix Rename method from 1615ec59/5a7596b6 remains unchanged.
 // The full-native baseline also includes later preserved census/control reads
 // and container-alias handling; their bytes are independent of this ABI fix.
 assert.equal(sha(original),'580077d9bab370584c1192e0e1de5e4efa80207c01d02409f2202f4e0d95cc6d');
 assert.equal(sha(native.replace(rename,original)),'bab7d89c7d28acdb7e99e18646a395da1b3845de40fabee47863f9941fb185aa');
});
test('original namespace guard, parent handle, native error translation and both frees remain in Rename',()=>{
 assert.ok(rename.includes('String.Equals(current, fullTarget, StringComparison.OrdinalIgnoreCase)'));assert.ok(rename.includes('parent.DangerousGetHandle()'));assert.ok(rename.includes('if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status))'));assert.ok(rename.includes('finally { Marshal.FreeHGlobal(iosb); }'));assert.ok(rename.includes('finally { Marshal.FreeHGlobal(value); }'));
 const assemble=bracedBlock(native,'static void Assemble(');assert.ok(assemble.includes('VerifyEntries(expected)'));assert.ok(assemble.includes('Step="restore-child"; Rename(node,name,parents[parentRel].Handle);'));assert.ok(bracedBlock(native,'static void RestoreNodeBasic(').includes('Step="restore-basic"'));
});

const F=require('../lib/migration-native-short-rename-fixture'),Observer=require('../lib/migration-native-short-rename-observer'),{EventEmitter}=require('node:events');
const entry=fs.readFileSync(path.join(repo,'dev-harness/migration-native-short-rename.e2e.js'),'utf8');
test('focused actual fixture retains canonical S D A B readonly ADS and native-preserved Basic4 boundaries',()=>{
 assert.deepEqual([...F.RELS],['','D','D/A','D/B']);const rows=F.fixture();try{assert.equal(rows.reduce((n,r)=>n+r.data.length,0),65536);assert.equal(rows.filter(r=>r.stream).length,1);}finally{rows.forEach(r=>r.data.fill(0));}
 assert.ok(entry.includes("fs.chmodSync(path.join(S,'D','A'),0o444)"));assert.ok(entry.includes('ServerOwnership.acquire([root])'));assert.equal(entry.split('ServerOwnership.createSourceKeeper(owner,canonical)').length-1,2);assert.ok(entry.includes('WorkDataTree.createPreserved'));
 assert.ok(entry.includes("['ServerOwnership','WorkDataTree','migrationCapsuleBroker','migrationCapsuleCapturePreserved','migrationCapsuleShape','flushWorkbenchLogs']"));assert.ok(entry.includes('keeper.releaseChecked(safe)'));assert.ok(entry.includes('finalKeeper.releaseOwner(safe)'));
 assert.equal(/fs\.(?:readFile|readdir)/.test(entry),false);assert.equal(/utimes|SetShortName|setShortName/.test(entry),false);assert.ok(entry.includes('F.metadata(witness,N0,baseline)'));assert.ok(entry.includes('F.same(final,N0)'));assert.ok(entry.includes('PENDING_NATURAL_TERMINALS'));
});
test('focused absolute120000 is monotonic and sticky at equality while original command close metadata limits remain',()=>{
 let clock=0,retained=0;const s=new F.State(()=>clock,0,()=>retained++);assert.equal(s.deadline,120000);clock=119999;s.admit();clock=120000;assert.throws(()=>s.admit());const first=s.first;clock=0;assert.throws(()=>s.admit(),e=>e===first);assert.equal(s.unknown,true);assert.ok(retained>0);assert.deepEqual([F.LIMITS.commandMs,F.LIMITS.closeMs,F.LIMITS.metadataMs],[120000,2000,30000]);assert.equal(entry.includes('122000'),false);assert.equal(entry.includes('t.done({exit:true})'),false);
});
test('focused evidence never removes fixtures and late observer failures cannot leave a zero exitCode',()=>{
 assert.equal(/(?:rmSync|\.rm\(|unlink|kill\(|process\.exit\()/.test(entry),false);assert.ok(entry.includes("'UNKNOWN.json'"));assert.ok(entry.includes('process.exitCode=1'));assert.ok(entry.includes('lateSuccessCannotClear:true'));assert.ok(entry.includes('if(state.first&&t.failures===0)'));assert.ok(entry.includes('clearTimeout(timer)'));assert.ok(entry.includes('tapRestored=true'));
});
function snapshot(){const specs=F.fixture();try{return{schema:1,platform:'ntfs-objects-v1',revision:'1'.repeat(64),entries:F.RELS.map((rel,n)=>({rel,id:'00000001'+(n+1).toString(16).padStart(16,'0'),opaque:(n+1).toString(16).padStart(64,'0'),dir:n<2,attrs:n<2?16:n===2?33:32,times:['1','2','3','4'],shortName:rel?path.win32.basename(rel):'ROOT',streams:specs.filter(x=>x.rel===rel).map(x=>({name:x.stream,size:x.data.length,hash:F.sha(x.data),data:x.data.toString('base64')}))}))};}finally{specs.forEach(x=>x.data.fill(0));}}
test('focused full baseline checks reject every Basic field alias readonly security DATA ADS ID and extra entry mutation',()=>{
 const n=snapshot(),rows=n.entries.map(r=>({rel:r.rel,attrs:r.attrs,times:[...r.times],shortName:r.shortName,sddl:'O:SYG:SYD:(A;ID;FA;;;SY)'}));F.check(n);F.metadata(rows,n,rows);for(const at of [0,1,2,3]){const bad=structuredClone(rows);bad[2].times[at]='99';assert.throws(()=>F.metadata(bad,n,rows));}for(const field of ['attrs','shortName','sddl']){const bad=structuredClone(rows);bad[2][field]=field==='attrs'?32:'changed';assert.throws(()=>F.metadata(bad,n,rows));}for(const kind of ['data','ads','id','extra']){const bad=structuredClone(n);if(kind==='data')bad.entries[2].streams[0].data='AA==';if(kind==='ads')bad.entries[2].streams.pop();if(kind==='id')bad.entries[2].id=bad.entries[3].id;if(kind==='extra')bad.entries.push({...bad.entries[3],rel:'unexpected'});assert.throws(()=>F.check(bad));}
});
function transport({late=false,holdClose=false}={}){
 let clock=0,spawned=0,closed=0,killed=0;const commands=[],timers=new Map(),promises=[],children=[],P=class extends Promise{constructor(fn){super(fn);promises.push(this);}},state=new F.State(()=>clock,0);
 const cp={spawn(){spawned++;if(late)clock=120000;const child=new EventEmitter();child.pid=100+spawned;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stderr.resume=()=>{};child.stdin=new EventEmitter();child.kill=()=>{killed++};child.stdin.write=(wire,callback)=>{const arg=JSON.parse(wire);commands.push(arg);queueMicrotask(()=>child.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,value:arg.cmd==='capture-preserved'?snapshot():null})+'\r\n')));callback?.();return true};child.stdin.end=()=>{closed++;if(!holdClose)queueMicrotask(()=>{child.stdout.emit('end');child.stdout.emit('close');child.stderr.emit('end');child.stderr.emit('close');child.emit('exit',0);child.emit('close',0);});};children.push(child);queueMicrotask(()=>child.emit('spawn'));return child;}};
 const clockApi={setTimeout(fn,ms){const token={fn,ms};timers.set(token,token);return token},clearTimeout(token){timers.delete(token)}};
 const archiveLimit=vm.runInNewContext(constBlock(source,'MIGRATION_CAPSULE_ARCHIVE_LIMIT')+';MIGRATION_CAPSULE_ARCHIVE_LIMIT',{});
 const ctx={Buffer,Promise:P,process:{platform:'win32',env:{},hrtime:{bigint:()=>0n}},migrationCapsuleFail(code){throw Error(code)},MIGRATION_CAPSULE_ARCHIVE_LIMIT:archiveLimit,MIGRATION_SKILL_CAPSULE_NATIVE:native,crypto,require:name=>name==='node:child_process'?cp:name==='node:timers'?clockApi:require(name)};vm.createContext(ctx);
 vm.runInContext(constBlock(source,'migrationCapsuleCode')+'\n'+functionBlock(source,'migrationCapsuleBroker')+'\n'+functionBlock(source,'migrationCapsuleShape')+'\n'+functionBlock(source,'migrationCapsuleCapturePreserved')+'\nglobalThis.api={__eval:code=>eval(code),original:migrationCapsuleBroker,capture:migrationCapsuleCapturePreserved};',ctx,{timeout:1000});
 let broker;const options={admit:()=>state.admit(),latch:e=>state.retain(e),afterFactory(value){assert.equal(Object.isFrozen(value),true);assert.equal(children.length,1);broker=value;}};return{state,ctx,promises,commands,timers,children,options,get broker(){return broker},get spawned(){return spawned},get closed(){return closed},get killed(){return killed},setNow(n){clock=n}};
}
test('test seam runs original factory and hidden preserved API with original command/close Promise identities and exact restoration',async()=>{
 const f=transport(),seam=F.installAdmission(f.ctx.api,f.options);const value=await f.ctx.api.capture('S','1'.repeat(64));F.check(JSON.parse(JSON.stringify(value)));assert.equal(f.spawned,1);assert.deepEqual(f.commands.map(x=>x.cmd),['capture-preserved']);assert.equal(f.closed,1);assert.equal(f.ctx.api.__eval('migrationCapsuleBroker'),seam.factory);const restored=seam.restore();assert.equal(restored.sourceSha256,F.FACTORY_SHA);assert.equal(f.ctx.api.__eval('migrationCapsuleBroker'),f.ctx.api.original);await assert.rejects(seam.factory(),/seam_closed/);assert.equal(f.spawned,1);
 const g=transport(),other=F.installAdmission(g.ctx.api,g.options),facade=await other.factory.call({receiver:true},{argument:true});const offset=g.promises.length,request={cmd:'capture-preserved',root:'S',revision:'1'.repeat(64)},promise=facade.command(request);assert.equal(promise,g.promises[offset]);await promise;const closeOffset=g.promises.length,close=facade.close();assert.equal(close,g.promises[closeOffset]);await close;other.restore();assert.equal(g.killed,0);
});
test('late original factory cannot issue hidden DATA command but completes mandatory original close and never clears unknown',async()=>{
 const f=transport({late:true}),seam=F.installAdmission(f.ctx.api,f.options);let primary;await assert.rejects(f.ctx.api.capture('S','1'.repeat(64)),e=>{primary=e;return e===f.state.first});assert.equal(f.spawned,1);assert.equal(f.commands.length,0);assert.equal(f.closed,1);assert.equal(f.state.unknown,true);f.setNow(0);await assert.rejects(seam.factory(),e=>e===primary);assert.equal(f.spawned,1);seam.restore();
});
test('factory observer primary survives secondary original-close uncertainty and no DATA command can issue',async()=>{
 const f=transport({holdClose:true}),primary=Object.freeze(Object.assign(Error('observer first'),{code:'EIO'}));f.options.afterFactory=()=>{throw primary};const seam=F.installAdmission(f.ctx.api,f.options),pending=seam.factory();for(let n=0;n<5&&!f.timers.size;n++)await new Promise(resolve=>setImmediate(resolve));const token=[...f.timers.keys()].find(x=>x.ms===2000);assert.ok(token);token.fn();await assert.rejects(pending,e=>e===primary);assert.equal(f.state.first,primary);assert.equal(f.commands.length,0);assert.equal(f.closed,1);seam.restore();
});
test('command admission blocks at equality yet close bypasses expired business gate and preserves original errors',async()=>{
 const f=transport(),seam=F.installAdmission(f.ctx.api,f.options),broker=await seam.factory();f.setNow(120000);assert.throws(()=>broker.command({cmd:'restore'}),e=>e===f.state.first);assert.equal(f.commands.length,0);await broker.close();assert.equal(f.closed,1);assert.equal(f.state.unknown,true);seam.restore();
});
test('forged factory source and replacement seam are refused; original close uncertainty remains latched after restoration',async()=>{
 const forged=transport();forged.ctx.api.__eval('migrationCapsuleBroker=async function(){return Object.freeze({command(){return Promise.resolve(true)},close(){return Promise.resolve()}})}');assert.throws(()=>F.installAdmission(forged.ctx.api,forged.options));assert.equal(forged.spawned,0);
 const f=transport({holdClose:true}),seam=F.installAdmission(f.ctx.api,f.options),broker=await seam.factory(),closing=broker.close();const token=[...f.timers.keys()].find(x=>x.ms===2000);assert.ok(token);token.fn();await assert.rejects(closing,e=>e.code==='work_data_backup.native_helper_uncertain');assert.equal(f.ctx.api.original.helperMayStillRun,true);seam.restore();assert.equal(f.ctx.api.__eval('migrationCapsuleBroker'),f.ctx.api.original);await assert.rejects(f.ctx.api.original(),e=>e.code==='work_data_backup.native_helper_uncertain');assert.equal(f.spawned,1);
});
test('passive observer keeps original child and rejects EOF-tail without printing native payloads',()=>{
 const child=new EventEmitter();child.pid=7;child.stdout=new EventEmitter();child.stderr=new EventEmitter();const records=[],unknown=[],row=Observer.observeChild(child,{emit:(type,data)=>records.push({type,...data}),latch:x=>unknown.push(x),label:'N0',expected:['capture-preserved'],now:()=>0});child.emit('spawn');child.stdout.emit('data',Buffer.from('{"ok":true,"value":"PRIVATE_DATA"}\r\n'));child.stdout.emit('data',Buffer.from([0xe2]));child.stdout.emit('end');child.stderr.emit('end');child.stdout.emit('close');child.stderr.emit('close');child.emit('exit',0,null);child.emit('close',0,null);assert.equal(row.known(),false);assert.ok(unknown.includes('short_rename.wire_eof'));assert.equal(JSON.stringify(records).includes('PRIVATE_DATA'),false);
});
test('pass-through observer never bypasses or replaces the original08364 native denial',()=>{
 const state=new F.State(()=>0,0),wrapper=Observer.wrapSpawn(require('node:child_process').spawn,{state,emit(){},latch(){},getPhase:()=> 'N0',rows:[],beforeNative(){},now:()=>0});assert.throws(()=>wrapper.call({receiver:'original'},'NEVER_EXECUTE',[],{}),e=>e.code==='fixture.native_forbidden');
});
test('full native representation has approved240000 whole-file budget while default and focused remain120000',()=>{
 const runner=fs.readFileSync(path.join(repo,'dev-harness/run-all.js'),'utf8'),ctx={};vm.createContext(ctx);vm.runInContext(['TIMEOUT_MS','TIMEOUT_OVERRIDES','SKIP','PARALLEL_EXCLUSIVE'].map(n=>constBlock(runner,n)).join('\n')+'\n'+functionBlock(runner,'timeoutFor')+'\nglobalThis.defaultMs=TIMEOUT_MS;globalThis.check=f=>({ms:timeoutFor(f),skip:SKIP.has(f),exclusive:PARALLEL_EXCLUSIVE.has(f)});',ctx);assert.equal(ctx.defaultMs,120000);assert.equal(ctx.check('unlisted-budget-control.e2e.js').ms,120000);for(const [file,expected]of [['migration-native-short-rename.e2e.js',120000],['work-data-preserved-snapshot.e2e.js',120000],['migration-skill-backup-representation.e2e.js',240000]]){const result=ctx.check(file);assert.equal(result.ms,expected);assert.equal(result.skip,false);assert.equal(result.exclusive,true);}
 const full=fs.readFileSync(path.join(repo,'dev-harness/migration-skill-backup-representation.e2e.js'),'utf8');assert.equal(full.split('await delay(24000)').length-1,2);assert.ok(full.includes('timeout:120000'));assert.deepEqual([F.LIMITS.commandMs,F.LIMITS.closeMs,F.LIMITS.metadataMs],[120000,2000,30000]);
});

test('cold four-operation native regression has its separately approved490000 whole-file budget only',()=>{
 const runner=fs.readFileSync(path.join(repo,'dev-harness/run-all.js'),'utf8'),ctx={};vm.createContext(ctx);
 vm.runInContext(['TIMEOUT_MS','TIMEOUT_OVERRIDES','SKIP','PARALLEL_EXCLUSIVE'].map(n=>constBlock(runner,n)).join('\n')+'\n'+functionBlock(runner,'timeoutFor')+'\nglobalThis.defaultMs=TIMEOUT_MS;globalThis.check=f=>({ms:timeoutFor(f),skip:SKIP.has(f),exclusive:PARALLEL_EXCLUSIVE.has(f)});',ctx);
 assert.equal(ctx.defaultMs,120000);assert.equal(ctx.check('unlisted-budget-control.e2e.js').ms,120000);
 for(const [file,expected]of [['work-data-cold-operations.e2e.js',490000],['migration-skill-backup-representation.e2e.js',240000],['migration-native-short-rename.e2e.js',120000],['work-data-preserved-snapshot.e2e.js',120000],['work-data-cold-preserved-snapshot.e2e.js',120000]]){
  const value=ctx.check(file);assert.equal(value.ms,expected);assert.equal(value.skip,false);assert.equal(value.exclusive,true);
 }
 const cold=fs.readFileSync(path.join(repo,'dev-harness/work-data-cold-operations.e2e.js'),'utf8');assert.ok(cold.includes('timeout:120000'));
 assert.deepEqual([F.LIMITS.commandMs,F.LIMITS.closeMs,F.LIMITS.metadataMs],[120000,2000,30000]);
});
test('deadline latch retains real private01g two-keeper owner and forged DTO cannot authorize or reopen it',async()=>{
 const ownerText=fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/01g-server-ownership.js'),'utf8'),servers=new Map(),intervals=[];
 const net={createServer(){const s=new EventEmitter();s.listening=false;s.listen=(address,callback)=>queueMicrotask(()=>{s.listening=true;servers.set(address,s);callback()});s.close=callback=>{s.listening=false;for(const[k,v]of servers)if(v===s)servers.delete(k);queueMicrotask(()=>{s.emit('close');callback?.()})};return s;}},timer={setInterval(){const token={ref(){}};intervals.push(token);return token;}};
 const ctx={process:{platform:'win32',versions:process.versions,pid:1},require:name=>name==='net'?net:name==='fs'?{promises:{realpath:async root=>root,readFile:async()=>{throw Object.assign(Error('absent'),{code:'ENOENT'})}}}:name==='path'?path.win32:name==='os'?{tmpdir:()=> 'E:\\inert'}:name==='crypto'?crypto:name==='node:timers'?timer:assert.fail(name)};vm.createContext(ctx);vm.runInContext(constBlock(ownerText,'ServerOwnership')+';globalThis.ownerApi=ServerOwnership;',ctx);
 const api=ctx.ownerApi,root='E:\\inert\\focused',lease=await api.acquire([root]),one=api.createSourceKeeper(lease,root),two=api.createSourceKeeper(lease,root);assert.equal(api.isLease(lease),true);assert.equal(api.isSourceKeeper(one,lease,root),true);assert.equal(api.isLease({roots:[root],held:true}),false);assert.throws(()=>api.createSourceKeeper({roots:[root],held:true},root));
 let now=0;const state=new F.State(()=>now,0,error=>{one.retainUnknown(error);two.retainUnknown(error)});now=120000;assert.throws(()=>state.admit());assert.equal(one.assertExclusive(lease),false);await assert.rejects(one.releaseChecked(()=>true),e=>e.code==='DATA_ROOT_OWNER_UNCERTAIN');assert.ok(servers.size>0);assert.ok(intervals.length>0);now=0;assert.throws(()=>state.admit());assert.equal(api.owns(lease,root),false);
});

// Asset-free plan/observer regression only. No native process or owner is issued.
test('paired preserved plan retains eight real-child slots and seventeen command responses with all four paired censuses',()=>{
 assert.equal(F.LIMITS.capsules,8);assert.equal(F.LIMITS.metadata,2);
 const paired=['initial-preserved','initial-verify','final-preserved','final-verify'];
 for(const label of paired)assert.deepEqual([...F.PHASES.find(row=>row[0]===label)[1]],['capture-preserved-census-first','capture-preserved-census-final']);
 assert.equal(F.PHASES.length,8);assert.equal(F.PHASES.reduce((n,row)=>n+row[1].length,0),17);
 for(const label of ['N0','final-native'])assert.deepEqual([...F.PHASES.find(row=>row[0]===label)[1]],['capture-preserved']);
 assert.deepEqual([...F.PHASES.find(row=>row[0]==='seal')[1]],['attach','seal-attached','verify']);
 assert.deepEqual([...F.PHASES.find(row=>row[0]==='restore')[1]],['attach','publish-check','restore','publish']);
});
test('paired observer requires both responses and the same original complete child closure; extra response or missing EOF stays unknown',()=>{
 const make=()=>{const child=new EventEmitter();child.pid=7;child.stdout=new EventEmitter();child.stderr=new EventEmitter();const rows=[],records=[],unknown=[],state=new F.State(()=>0,0);const wrapper=Observer.wrapSpawn(function(){return child;},{state,emit:(type,data)=>records.push({type,...data}),latch:code=>unknown.push(code),getPhase:()=> 'initial-preserved',rows,beforeNative(){},now:()=>0});assert.equal(wrapper(),child);child.emit('spawn');return{child,row:rows[0],records,unknown};};
 const ack=f=>f.child.stdout.emit('data',Buffer.from('{"ok":true,"value":"SYNTHETIC_PRIVATE_CENSUS"}\r\n'));
 const closed=(f,stderr=true)=>{f.child.stdout.emit('end');f.child.stdout.emit('close');if(stderr)f.child.stderr.emit('end');f.child.stderr.emit('close');f.child.emit('exit',0,null);f.child.emit('close',0,null);};
 const good=make();ack(good);assert.equal(good.row.known(),false);ack(good);assert.equal(good.row.known(),false);closed(good);assert.equal(good.row.known(),true);assert.deepEqual(good.records.filter(row=>row.type==='wire-response').map(row=>row.sourceMappedCommand),['capture-preserved-census-first','capture-preserved-census-final']);assert.equal(JSON.stringify(good.records).includes('SYNTHETIC_PRIVATE_CENSUS'),false);
 const missing=make();ack(missing);closed(missing);assert.equal(missing.row.known(),false);
 const extra=make();ack(extra);ack(extra);ack(extra);closed(extra);assert.equal(extra.row.known(),false);assert.ok(extra.unknown.includes('n1.wire_shape'));
 const noEOF=make();ack(noEOF);ack(noEOF);closed(noEOF,false);assert.equal(noEOF.row.known(),false);
});
