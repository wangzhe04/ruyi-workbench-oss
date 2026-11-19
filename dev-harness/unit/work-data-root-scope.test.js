'use strict';
// 150 W3/W4: data-root content policy (01aa rootScope), its use by the full
// snapshot package (01ab) and migration (01ad/01x), the raised native census
// budget with its typed over-budget error, and the warm-side hygiene engine
// (01ac): inventory with a stable verdict schema, leftover quarantine and undo.
// Deleting cleanup of superseded roots (W13) is deliberately not part of this.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const {fixture,password}=require('../lib/work-data-full-snapshot-fixture');
const {createPreservedReaderModel}=require('../lib/work-data-preserved-reader-model');
const src=path.resolve(__dirname,'../../ruyi-workbench/app/src'),read=name=>fs.readFileSync(path.join(src,name),'utf8');
const loadTree=()=>vm.runInNewContext(read('01aa-work-data-tree.js')+'\nWorkDataTree;',{Buffer,process,require});
function loadHygiene(fsOverride){
 const req=name=>name==='node:fs/promises'&&fsOverride?fsOverride:require(name);
 const context=vm.createContext({Buffer,process,require:req,console,TextDecoder,fsp:fsOverride||fsp,fs,path,crypto});
 // The engine shares the product's atomic JSON writer (01-config).
 vm.runInContext(require('../lib/source-slice').functionBlock(read('01-config.js'),'atomicWriteJson'),context);
 vm.runInContext(['01t-work-data-recovery.js','01aa-work-data-tree.js','01ac-work-data-root-hygiene.js'].map(read).join('\n'),context);
 return vm.runInContext('({WorkDataTree,WorkDataRootHygiene,WorkDataRecovery})',context);
}
async function tempRoot(t,name){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-root-scope-'+name+'-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));return root;}
const put=async(base,relative,bytes)=>{const file=path.join(base,...relative.split('/'));await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file,bytes);return file;};
const exists=file=>fs.existsSync(file);
const plain=value=>JSON.parse(JSON.stringify(value));
const ID='a'.repeat(48),OLD='b'.repeat(48);
const pointerOf=(id,generation=1,mode='encrypted')=>JSON.stringify({schema:1,id,generation,mode,activeRoot:'generations/'+id});
const old=file=>{const past=new Date(Date.now()-3600000);fs.utimesSync(file,past,past);return file;};

test('rootScope classifies only product shapes, never inside skills/, uploads/, control or native-owner paths',()=>{
 const {rootScope}=loadTree(),c=(name,options)=>rootScope.classify(name,options);
 for(const name of ['webcache/x.json','agent-worktrees/r/.git','storage-trend.json','last-start-error.json','proxy-models-cache.json','quarantine-v1/s/data/x'])
  assert.equal(c(name).class,'excluded',name);
 assert.equal(c('webcache/x.json').regenerable,true);assert.equal(c('agent-worktrees/r/f').regenerable,false);
 assert.equal(c('.work-data/generations/'+ID+'/webcache/x.json',{base:true}).scope,'.work-data/generations/'+ID+'/webcache');
 // The deleting cleanup is gone: its stage area is not a product name any more.
 assert.equal(c('cleanup-trash-v1/r/data/0'),null);assert.ok(!rootScope.EXCLUDED_NAMES.includes('cleanup-trash-v1'));
 // Audit logs migrate with their owner whatever their last byte (torn rows are the codecs' business).
 for(const data of [Buffer.from('{"a":1}\n'),Buffer.from('{"a":1}\n{"to'),undefined])assert.equal(c('logs/workbench-2026-01-01.ndjson',{data}),null);
 assert.equal(c('generated/mcp-sync-sidecar.json'),null);
 assert.equal(c('sessions/sess_a.json.corrupt').reason,'quarantined-corrupt');
 assert.equal(c('checkpoints/s/index.json.corrupt-1731900000000').reason,'quarantined-corrupt');
 assert.equal(c('sessions/sess_a.json.4321.0123abcd.tmp').reason,'crash-stage');
 assert.equal(c('config.json.corrupt-1731900000000').class,'leftover');
 // S3: the agent-run event archiver's single tmp name (06 archiveAgentRunEvents) is a crash leftover too.
 assert.equal(c('agent-runs/sess_a/run1.events.ndjson.gz.tmp').reason,'archive-stage');assert.equal(c('.work-data/generations/'+ID+'/agent-runs/s/r.events.ndjson.gz.tmp',{base:true}).reason,'archive-stage');
 assert.equal(c('agent-runs/sess_a/run1.events.ndjson.gz'),null);assert.equal(c('sessions/run1.events.ndjson.gz.tmp'),null);
 // skills/ and uploads/ hold user-chosen names (restore validates them): never matched at all.
 for(const name of ['uploads/_catalog-attachments-v1.json.corrupt','uploads/att1/report.corrupt','uploads/a.1.0123abcd.tmp','skills/s/notes.corrupt','skills/s/x.12.0123abcd.tmp',
  'sessions/x.tmp','sessions/a.json.corrupt.bak','sessions/sess_a.json','migrations/skill-backups/x/y.corrupt','.work-data/maintenance-v1.json',
  // S4: copies of the skill-backup binding store keep their owner refusal.
  'migrations/skill-backup-bindings-v2.sealed.corrupt-1731900000000','migrations/skill-backup-bindings-v2.sealed.corrupt','.work-data/generations/'+ID+'/migrations/skill-backup-bindings-v2.sealed.corrupt'])assert.equal(c(name,{base:true}),null,name);
 // Inside a generation: the same rules on the logical path; its own .work-data/ is control.
 assert.equal(c('.work-data/generations/'+ID+'/sessions/a.json.corrupt',{base:true}).class,'leftover');
 for(const name of ['.work-data/generations/'+ID+'/.work-data/x.corrupt','.work-data/generations/'+ID+'/.work-data/webcache/x','.work-data/generations/'+ID+'/uploads/x.corrupt',
  '.work-data/generations/'+ID+'/skills/s/x.1.0123abcd.tmp','.work-data/generations/'+ID+'/migrations/skill-backups/s/a.corrupt','.work-data/webcache'])assert.equal(c(name,{base:true}),null,name);
});

test('partition omits retired generations and the superseded plain root only with a valid pointer and no native skill backup, and still lists their leftovers',()=>{
 const {rootScope}=loadTree(),pointer=Buffer.from(pointerOf(ID,2));
 const files=[{path:'.work-data/active-v1.json',data:pointer},{path:'.work-data/generations/'+ID+'/sessions/sess_a.json',data:Buffer.from('A')},
  {path:'.work-data/generations/'+OLD+'/sessions/sess_a.json',data:Buffer.from('OLD')},{path:'sessions/sess_a.json',data:Buffer.from('LEGACY')},
  {path:'migrations/2026.json',data:Buffer.from('M')},{path:'.work-data/generations/'+ID+'/webcache/x.json',data:Buffer.from('W')},
  {path:'config.json.corrupt-1731900000000',data:Buffer.from('{"apiKey":"sk-legacy"}')},{path:'.work-data/generations/'+OLD+'/sessions/b.json.corrupt',data:Buffer.from('X')},
  {path:'.work-data/generations/'+ID+'/logs/workbench-2026-01-01.ndjson',data:Buffer.from('{"torn')}];
 const directories=['.work-data','.work-data/generations','.work-data/generations/'+ID,'.work-data/generations/'+ID+'/sessions','.work-data/generations/'+ID+'/webcache',
  '.work-data/generations/'+ID+'/logs','.work-data/generations/'+OLD,'.work-data/generations/'+OLD+'/sessions','sessions','migrations'];
 const result=rootScope.partition(files,directories);
 assert.deepEqual(plain(result.files.map(row=>row.path).sort()),['.work-data/active-v1.json','.work-data/generations/'+ID+'/logs/workbench-2026-01-01.ndjson','.work-data/generations/'+ID+'/sessions/sess_a.json']);
 const classes=Object.fromEntries(result.report.omitted.map(row=>[row.path,row.class]));
 assert.equal(classes['.work-data/generations/'+OLD],'retired');assert.equal(classes.sessions,'legacy');assert.equal(classes.migrations,'legacy');
 assert.equal(classes['.work-data/generations/'+ID+'/webcache'],'excluded');assert.equal(result.report.supersededOmitted,true);
 // A superseded root's own leftovers are named individually (they may be plaintext with secrets).
 const left=Object.fromEntries(result.report.leftovers.map(row=>[row.path,row.area]));
 assert.equal(left['config.json.corrupt-1731900000000'],'superseded');
 assert.equal(rootScope.partition([...files,{path:'agent-worktrees/r/a.1.0123abcd.tmp',data:Buffer.from('W')},{path:'quarantine-v1/s/data/x.corrupt',data:Buffer.from('Q')}],directories)
  .report.leftovers.some(row=>/^(?:agent-worktrees|quarantine-v1)\//.test(row.path)),false,'excluded trees of a superseded root never yield leftovers');assert.equal(left['.work-data/generations/'+OLD+'/sessions/b.json.corrupt'],'superseded');
 assert.equal(result.report.supersededLeftovers,2);
 const unpointed=rootScope.partition(files.filter(row=>row.path!=='.work-data/active-v1.json'),directories);
 assert.ok(unpointed.files.some(row=>row.path==='sessions/sess_a.json'));
 assert.equal(unpointed.report.leftovers.find(row=>row.path==='config.json.corrupt-1731900000000').area,'active');
 for(const extra of ['migrations/skill-backups/s/k/archive','.work-data/skill-backups/objects-v1/x','.work-data/generations/'+OLD+'/migrations/skill-backups/s/x']){
  const guarded=rootScope.partition([...files,{path:extra,data:Buffer.from('N')}],directories);
  assert.equal(guarded.report.supersededOmitted,false,extra);
  assert.ok(guarded.files.some(row=>row.path==='.work-data/generations/'+OLD+'/sessions/sess_a.json')&&guarded.files.some(row=>row.path==='sessions/sess_a.json'),extra);
 }
});

test('W4: a root with product leftovers, a torn audit log row, caches and worktrees seals, reports and leaves the leftovers untouched',async t=>{
 const f=await fixture(t);
 await f.write('config.json','{"workDataEncryptionV1":false}');await f.write('sessions/sess_one.json','{"id":"sess_one"}');await f.write('logs/workbench-2026-01-02.ndjson','{"a":1}\n');
 const torn='{"a":1}\n{"torn":';await f.write('logs/workbench-2026-01-01.ndjson',torn);
 const left={'sessions/sess_two.json.corrupt':'{"id":"sess_two"','config.json.4321.0123abcd.tmp':'{"partial"',['webcache/'+'c'.repeat(64)+'.json']:'{"url":"x"}','agent-worktrees/run/repo/file.txt':'worktree'};
 for(const [name,bytes] of Object.entries(left))await f.write(name,bytes);
 const shot=await f.owner().seal({password,appVersion:'3.0.1',generation:0});
 assert.equal(shot.scope.leftoverCount,2);
 assert.deepEqual(plain(shot.scope.leftovers.map(row=>row.reason).sort()),['crash-stage','quarantined-corrupt']);
 assert.deepEqual(plain(shot.scope.omitted.map(row=>row.path).sort()),['agent-worktrees','webcache']);
 for(const name of [...Object.keys(left),'logs/workbench-2026-01-01.ndjson'])assert.ok(shot.sourceFiles.some(row=>row.path===name),name);
 const opened=await f.api.WorkDataRecovery.open(shot.serialized,password);
 try{
  assert.deepEqual(plain(opened.snapshot.files.map(row=>row.path).sort()),['config.json','logs/workbench-2026-01-01.ndjson','logs/workbench-2026-01-02.ndjson','sessions/sess_one.json']);
  // The package keeps the log's exact bytes; only validation looked at the committed prefix.
  assert.equal(Buffer.from(opened.snapshot.files.find(row=>row.path==='logs/workbench-2026-01-01.ndjson').data).toString('utf8'),torn);
 }finally{opened.release();}
 for(const [name,bytes] of Object.entries(left))assert.equal(await fsp.readFile(path.join(f.base,...name.split('/')),'utf8'),bytes,'left in place: '+name);
 const target=path.join(f.root,'restored');await f.owner(f.b).restore({serialized:shot.serialized,password,target});
 assert.equal(exists(path.join(target,'sessions','sess_two.json.corrupt')),false);assert.equal(await fsp.readFile(path.join(target,'sessions','sess_one.json'),'utf8'),'{"id":"sess_one"}');
 assert.equal(await fsp.readFile(path.join(target,'logs','workbench-2026-01-01.ndjson'),'utf8'),torn);
});

test('a torn audit-log row inside the committed region still fails closed (only the last unterminated row is not committed)',async t=>{
 const f=await fixture(t);
 await f.write('config.json','{"workDataEncryptionV1":false}');await f.write('logs/workbench-2026-01-01.ndjson','{"a":1}\n{"broken\n{"b":2}\n');
 await assert.rejects(()=>f.owner().seal({password,appVersion:'3.0.1',generation:0}));
});

test('W13 package scope: once a generation is active neither retired generations nor the superseded plain root are packed, and the restore is complete',async t=>{
 const f=await fixture(t);
 await f.write('.work-data/active-v1.json',pointerOf(ID,1,'plain'));await f.write('.work-data/generations/'+ID+'/config.json','{"workDataEncryptionV1":false}');await f.write('.work-data/generations/'+ID+'/sessions/sess_new.json','{"id":"sess_new"}');
 await f.write('config.json','{"workDataEncryptionV1":false}');await f.write('sessions/sess_old.json','{"id":"sess_old","private":"LEGACY PLAINTEXT"}');
 await f.write('.work-data/generations/'+OLD+'/sessions/sess_x.json','{"id":"sess_x"}');
 const shot=await f.owner().seal({password,appVersion:'3.0.1',generation:1});
 const opened=await f.api.WorkDataRecovery.open(shot.serialized,password);let names;
 try{
  names=opened.snapshot.files.map(row=>row.path).sort();
  assert.deepEqual(plain(names),['.work-data/active-v1.json','.work-data/generations/'+ID+'/config.json','.work-data/generations/'+ID+'/sessions/sess_new.json']);
  assert.ok(!opened.snapshot.directories.some(name=>name.includes(OLD)||name==='sessions'));
 }finally{opened.release();}
 assert.ok(shot.sourceFiles.some(row=>row.path==='sessions/sess_old.json'),'source proof still complete');
 assert.deepEqual(plain(shot.scope.omitted.map(row=>row.class).sort()),['legacy','legacy','retired']);
 const target=path.join(f.root,'restored');await f.owner(f.b).restore({serialized:shot.serialized,password,target});
 const authority=await f.api.WorkDataManifest.create({base:target}).readActive();assert.equal(authority.generation,1);assert.equal(authority.id,ID);
 const restored=[];const visit=rel=>{for(const name of fs.readdirSync(path.join(target,...rel.split('/').filter(Boolean)))){const next=rel?rel+'/'+name:name;if(fs.statSync(path.join(target,...next.split('/'))).isDirectory())visit(next);else restored.push(next);}};visit('');
 for(const name of names)assert.ok(restored.includes(name),'restored: '+name);
 assert.equal(exists(path.join(target,'sessions')),false);assert.equal(exists(path.join(target,'.work-data','generations',OLD)),false);
 // With a native skill backup anywhere the superseded roots stay packed (their owner decides).
 const g=await fixture(t);
 await g.write('.work-data/active-v1.json',pointerOf(ID,1,'plain'));await g.write('.work-data/generations/'+ID+'/config.json','{"workDataEncryptionV1":false}');
 await g.write('sessions/sess_old.json','{"id":"sess_old"}');await g.write('migrations/skill-backups/2026-01-01T00-00-00-000Z/one/SKILL.md','# skill');
 const guarded=await g.owner().seal({password,appVersion:'3.0.1',generation:1}).then(value=>({value}),error=>({error}));
 if(guarded.value)assert.equal(guarded.value.scope.supersededOmitted,false);
 else assert.match(String(guarded.error.code),/^work_data_/,'native skill backups keep their own owner refusal');
});

test('W3: the preserved census accepts more than 10,000 entries; over-budget censuses raise one typed limit with kind, maximum and safe areas',async t=>{
 const root=await tempRoot(t,'native'),tree=loadTree();
 await fsp.mkdir(path.join(root,'many'));for(let i=0;i<10050;i++)fs.writeFileSync(path.join(root,'many',String(i).padStart(5,'0')),'');
 const ownership={roots:[root]},reader=tree.createPreserved({capturePreserved:createPreservedReaderModel(),ownership,assertExclusive:async()=>true,assertExclusiveSync:()=>true});
 const captured=await reader.capture(root);try{assert.equal(captured.files.length,10050);const proof=await reader.verify(captured);assert.equal(proof.files,10050);}finally{captured.release();}
 const other=await tempRoot(t,'native-small');await fsp.writeFile(path.join(other,'big'),'eleven byte');for(const n of ['a','b','c'])await fsp.writeFile(path.join(other,n),'');const otherOwner={roots:[other]};
 const small=tree.createPreserved({capturePreserved:createPreservedReaderModel(),ownership:otherOwner,assertExclusive:async()=>true,limits:{nativeBytes:10}});
 await assert.rejects(small.capture(other),error=>error.code==='work_data_tree.preserved_native_engineering_limit'&&error.limit.kind==='bytes'&&error.limit.maximum===10&&error.retry===false);
 assert.throws(()=>tree.createPreserved({capturePreserved:createPreservedReaderModel(),ownership,assertExclusive:async()=>true,limits:{nativeBytes:tree.NATIVE_BUDGET.bytes+1}}),{code:'work_data_tree.limits_invalid'});
 const few=tree.createPreserved({capturePreserved:createPreservedReaderModel(),ownership:otherOwner,assertExclusive:async()=>true,limits:{files:2,directories:1}});
 await assert.rejects(few.capture(other),error=>error.code==='work_data_tree.preserved_native_engineering_limit'&&error.limit.kind==='entries'&&error.limit.maximum===4);
 // The default reader's own budget is typed too (same error shape, its own code).
 const defaultReader=tree.create({files:2});
 await assert.rejects(defaultReader.capture(other),error=>error.code==='work_data_tree.engineering_limit'&&error.limit.kind==='files'&&error.limit.maximum===2);
 // Areas: product names pass, anything else (user-chosen, possibly private) becomes 'other'; numbers must be safe.
 const limit=tree.engineeringLimit('entries',undefined,undefined,[{area:'Sessions',entries:9,bytes:1},{area:'My Private Folder',entries:5,bytes:7},{area:'secret',entries:1,bytes:1},{area:'webcache',entries:-1,bytes:2},{area:'uploads',entries:1,bytes:'9'}]);
 assert.deepEqual(plain(limit.areas),[{area:'other',entries:6,bytes:8},{area:'sessions',entries:9,bytes:1}]);
 assert.deepEqual(plain(limit.limit),{kind:'entries',maximum:200001});assert.equal(tree.engineeringLimit('nonsense').limit.kind,'bytes');
});

test('W3: the broker, its Node reader and the shape check all carry the same census budget',()=>{
 const tree=loadTree(),B=tree.NATIVE_BUDGET,broker=read('13u-migration-center.js');
 assert.deepEqual(plain(B),{files:100000,directories:100000,entries:200001,bytes:125829120,fileBytes:96000000,transportBytes:251658240,depth:256});
 assert.ok(broker.includes('MaxEntries = DataRootBudget ? '+B.entries+' : 10000; MaxTotal = DataRootBudget ? '+B.bytes+' : 96000000;'),'C# data-root caps');
 assert.ok(broker.includes('static long MaxBytes = '+B.fileBytes+','),'C# per-stream cap = fileBytes');
 assert.ok(broker.includes('MaxJsonLength = '+B.transportBytes+','),'C# MaxJsonLength = transportBytes');
 assert.ok(broker.includes('MaxTransport = '+B.transportBytes+' - 1048576;'),'C# pre-serialisation budget leaves room for the reply wrapper');
 assert.ok(broker.includes("if (rel.Split('/').Length > "+B.depth+')'),'C# depth');
 const archive=vm.runInNewContext(require('../lib/source-slice').constBlock(broker,'MIGRATION_CAPSULE_ARCHIVE_LIMIT')+';MIGRATION_CAPSULE_ARCHIVE_LIMIT');
 assert.equal(archive,B.transportBytes,'Node line limit (UTF-8 bytes) = transportBytes');
 const census=vm.runInNewContext(require('../lib/source-slice').constBlock(broker,'MIGRATION_CENSUS_BUDGET')+';MIGRATION_CENSUS_BUDGET');
 assert.deepEqual(plain(census),{files:B.files,directories:B.directories,entries:B.entries,bytes:B.bytes,fileBytes:B.fileBytes});
 const shape=vm.runInNewContext('('+require('../lib/source-slice').functionBlock(broker,'migrationCapsuleShape')+')',{Buffer,crypto});
 let serial=0;const entry=(rel,dir,size)=>({rel,dir,id:(serial++).toString(16).padStart(24,'0'),opaque:crypto.createHash('sha256').update(String(serial)).digest('hex'),attrs:dir?16:32,times:['1','2','3','4'],shortName:'',streams:dir?[]:[{name:'',size,hash:crypto.createHash('sha256').update(Buffer.alloc(size)).digest('hex'),data:Buffer.alloc(size).toString('base64')}]});
 assert.equal(shape({schema:1,platform:'ntfs-objects-v1',revision:'1'.repeat(64),entries:[entry('',true),...Array.from({length:B.entries-1},(_,i)=>entry('d'+i,true))]}),true,'shape admits exactly the census entry budget');
 assert.equal(shape({schema:1,platform:'ntfs-objects-v1',revision:'1'.repeat(64),entries:[entry('',true),...Array.from({length:B.entries},(_,i)=>entry('d'+i,true))]}),false);
 // Capsule (skill backup) captures keep their own caps; capsule binary limit holds for them.
 assert.ok(broker.includes('MaxEntries = DataRootBudget ? '+B.entries+' : 10000')&&broker.includes('static int MaxEntries = 10000;'));
 // Every data-root refusal is a distinct census_* code, mapped in Node; none falls back to a shape or localized message.
 for(const code of ['census_entries_limit','census_bytes_limit','census_file_limit','census_transport_limit','census_depth_limit'])
  assert.ok(broker.includes('"'+code+'"')&&broker.includes("'work_data_backup."+code+"'"),code);
 assert.ok(broker.includes('catch (InvalidOperationException) { reply = null; }')&&broker.includes('if (reply == null) Reject("census_transport_limit");'),'MaxJsonLength overflow is reported as the transport budget');
 // Units: Node limits the reply line in UTF-8 bytes, MaxJsonLength counts UTF-16 chars; the C# estimate counts each
 // escaped or non-ASCII char as 6 (>= its UTF-8 bytes, max 3 per UTF-16 unit, and >= one char), so both hold.
 assert.ok(broker.includes("c >= 0x80 ? 6 : 1; return n; }"),'non-ASCII chars count 6 in the transport estimate');
 assert.ok(broker.includes('AddTransport(512 + JsonBytes(rel) + JsonBytes(Str(node.Entry["shortName"])));')&&broker.includes('AddTransport(192 + JsonBytes(streamName) + 4L * ((bytes.Length + 2) / 3));'),'metadata and base64 data both count');
 for(const sample of ['会话记录.json','emoji-😀.txt','a"b\\c<d>&\'e'])assert.ok(Buffer.byteLength(JSON.stringify(sample))<=2+6*sample.length&&JSON.stringify(sample).length<=2+6*sample.length,sample);
});

test('W3: base64 and metadata of a maximal census fit the transport line, and a maximal capsule fits the capsule binary limit',()=>{
 const tree=loadTree(),B=tree.NATIVE_BUDGET,broker=read('13u-migration-center.js');
 // 151 profile under the C# estimate: 100,000 files (80-char ASCII paths, one stream each) plus the full byte budget fits
 // one broker line below MaxTransport. Pathological mixes (200,001 entries with long non-ASCII names and full bytes) do
 // not: they stop with the typed transport limit (census_transport_limit), never a localized or shape failure.
 const base64=4*Math.ceil(B.bytes/3),metadata=(B.files+1000+1)*(512+2+80)+B.files*(192+2),maxTransport=B.transportBytes-1048576;
 assert.ok(base64+metadata<=maxTransport,'a 100,000-file census reply fits one broker line: '+(base64+metadata));
 assert.ok(4*Math.ceil(B.bytes/3)+B.entries*(512+2+6*1024+194)>maxTransport,'pathological mixes reach the typed transport limit');
 // A capsule is gzip(JSON) of a capsule-budget capture (96,000,000 bytes, 10,000 entries); deflate on base64 never
 // exceeds 6 bits/char + block overhead, so its binary stays below MIGRATION_CAPSULE_BINARY_LIMIT.
 const binary=vm.runInNewContext(require('../lib/source-slice').constBlock(broker,'MIGRATION_CAPSULE_BINARY_LIMIT')+';MIGRATION_CAPSULE_BINARY_LIMIT');
 const capsuleJson=4*Math.ceil(96000000/3)+10000*(512+2+6*256+194);
 assert.ok(Math.ceil(capsuleJson*0.76)+1048576<binary,'capsule binary bound '+capsuleJson);
 const sample=crypto.randomBytes(3*1024*1024).toString('base64'),packed=require('node:zlib').gzipSync(Buffer.from(sample));
 assert.ok(packed.length/sample.length<0.76,'deflate on random base64 stays below 0.76: '+packed.length/sample.length);
});

test('inspect: stable schema, blocking vs advice verdicts with actions, and nothing touched',async t=>{
 const base=await tempRoot(t,'inspect'),{WorkDataRootHygiene:h,WorkDataTree:tree}=loadHygiene();
 await put(base,'sessions/sess_a.json','{"id":"sess_a"}');await put(base,'webcache/x.json','x'.repeat(1000));await put(base,'sessions/sess_b.json.corrupt','{');
 const before=fs.readdirSync(base).sort();
 let report=await h.inspect({base});
 assert.deepEqual(Object.keys(report).sort(),['budget','census','ok','quarantine','schema','scope','verdicts']);
 assert.deepEqual(Object.keys(report.census).sort(),['bytes','directories','entries','files','largest','largestFileBytes','nativeOwnerRoots']);
 assert.deepEqual(plain(report.budget.census),{files:100000,directories:100000,entries:200001,bytes:tree.NATIVE_BUDGET.bytes,fileBytes:96000000,depth:256});
 assert.equal(report.schema,1);assert.equal(report.ok,true,'leftovers alone do not block');
 assert.equal(report.census.files,3);assert.equal(report.census.entries,3+2+1);assert.equal(report.census.largest[0].path,'webcache');
 assert.equal(report.scope.included.files,1);assert.equal(report.scope.leftoverCount,1);assert.equal(report.scope.omitted[0].reason,'regenerable-cache');
 assert.deepEqual(plain(report.verdicts),[{code:'work_data_hygiene.leftovers_present',severity:'advice',action:'quarantine',params:{count:1,bytes:1,paths:['sessions/sess_b.json.corrupt']}}]);
 for(const verdict of report.verdicts)assert.deepEqual(Object.keys(verdict).sort(),['action','code','params','severity']);
 fs.mkdirSync(path.join(base,'real'));fs.symlinkSync(path.join(base,'real'),path.join(base,'alias'),process.platform==='win32'?'junction':'dir');
 report=await h.inspect({base});assert.equal(report.ok,false);
 const alias=report.verdicts.find(row=>row.code==='work_data_hygiene.aliases_present');assert.equal(alias.severity,'blocking');assert.equal(alias.action,'replace-alias');assert.deepEqual([...alias.params.paths],['alias']);
 // Over-budget verdicts name the largest areas.
 const tight=await h.inspect({base,maxEntries:2});const truncated=tree&&tight.verdicts.find(row=>row.code==='work_data_hygiene.inventory_truncated');
 assert.equal(truncated.severity,'blocking');assert.ok(Array.isArray(truncated.params.largest));
 assert.deepEqual(fs.readdirSync(base).sort(),[...before,'alias','real'].sort(),'inspect wrote nothing');
});

test('W4: after enable a superseded plain root\'s crash leftovers (e.g. a config.json.corrupt with provider keys) get a verdict and can be quarantined',async t=>{
 const base=await tempRoot(t,'superseded'),{WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000;
 await put(base,'.work-data/active-v1.json',pointerOf(ID));await put(base,'.work-data/generations/'+ID+'/sessions/sess_a.json','SEALED');
 await put(base,'sessions/sess_a.json','{"id":"sess_a"}');const secret=await put(base,'config.json.corrupt-1731900000000','{"providers":[{"apiKey":"sk-synthetic-legacy"}]}');
 const report=await h.inspect({base});
 const verdict=report.verdicts.find(row=>row.code==='work_data_hygiene.superseded_leftovers_present');
 assert.ok(verdict,'never silently shelved');assert.equal(verdict.severity,'advice');assert.equal(verdict.action,'quarantine');
 assert.deepEqual(plain(verdict.params.paths),['config.json.corrupt-1731900000000']);assert.equal(verdict.params.count,1);
 assert.equal(report.verdicts.some(row=>row.code==='work_data_hygiene.leftovers_present'),false);
 const plan=await h.planQuarantine({base,now:later});
 assert.deepEqual(plain(plan.items.map(row=>[row.path,row.area])),[['config.json.corrupt-1731900000000','superseded']]);
 const done=await h.quarantine({base,token:plan.token,now:later});assert.equal(done.moved,1);
 assert.equal(exists(secret),false);
 const moved=path.join(base,...done.areas[0].area.split('/'),'data','config.json.corrupt-1731900000000');
 assert.equal(fs.readFileSync(moved,'utf8'),'{"providers":[{"apiKey":"sk-synthetic-legacy"}]}','same volume, same root, product-private area');
 assert.equal((await h.inspect({base})).verdicts.some(row=>row.code==='work_data_hygiene.superseded_leftovers_present'),false);
});

test('quarantine moves only inert product leftovers, across several roots in one run, keeps manifests and undo restores the exact bytes',async t=>{
 const base=await tempRoot(t,'quarantine'),{WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000;
 await put(base,'sessions/sess_a.json','{"id":"sess_a"}');await put(base,'sessions/sess_b.json.corrupt','BROKEN');await put(base,'config.json.4321.0123abcd.tmp','PARTIAL');await put(base,'config.json.99.0123abcd.tmp','LIVE');
 // A second root: a (non-active) generation with its own leftover. One run moves both (no plan_changed).
 await put(base,'.work-data/generations/'+OLD+'/sessions/c.json.corrupt','GEN');
 const isAlive=pid=>pid===99;
 assert.equal((await h.planQuarantine({base,isAlive})).files,0,'too recent leftovers are not moved');
 const plan=await h.planQuarantine({base,now:later,isAlive});
 assert.deepEqual(plain(plan.items.map(row=>row.path).sort()),['.work-data/generations/'+OLD+'/sessions/c.json.corrupt','config.json.4321.0123abcd.tmp','sessions/sess_b.json.corrupt']);
 assert.deepEqual(plain(plan.roots.map(row=>[row.root,row.files])),[['',2],['.work-data/generations/'+OLD,1]]);
 assert.deepEqual(plain(plan.skipped.map(row=>row.reason)),['writer-alive']);
 await assert.rejects(h.quarantine({base,token:'0'.repeat(64),now:later,isAlive}),{code:'work_data_hygiene.plan_changed'});
 const done=await h.quarantine({base,token:plan.token,now:later,isAlive});
 assert.equal(done.moved,3);assert.equal(done.areas.length,2);assert.equal(exists(path.join(base,'sessions','sess_b.json.corrupt')),false);
 const baseArea=path.join(base,...done.areas.find(row=>row.root==='').area.split('/')),genArea=path.join(base,...done.areas.find(row=>row.root!=='').area.split('/'));
 assert.equal(fs.readFileSync(path.join(baseArea,'data','sessions','sess_b.json.corrupt'),'utf8'),'BROKEN');
 assert.equal(fs.readFileSync(path.join(genArea,'data','sessions','c.json.corrupt'),'utf8'),'GEN');
 for(const area of [baseArea,genArea])assert.equal(JSON.parse(fs.readFileSync(path.join(area,'manifest-v1.json'),'utf8')).state,'moved');
 const report=await h.inspect({base});
 assert.equal(report.scope.omitted.find(row=>row.path==='quarantine-v1').reason,'product-quarantine');
 assert.deepEqual(plain(report.quarantine.map(row=>row.state)),['moved','moved']);
 assert.equal((await h.undoQuarantine({base,stamp:done.stamp})).restored,2);
 assert.equal((await h.undoQuarantine({base,stamp:done.stamp,root:'.work-data/generations/'+OLD})).restored,1);
 assert.equal(fs.readFileSync(path.join(base,'sessions','sess_b.json.corrupt'),'utf8'),'BROKEN');
 assert.equal(fs.readFileSync(path.join(base,'.work-data','generations',OLD,'sessions','c.json.corrupt'),'utf8'),'GEN');
});

test('undo validates every manifest path and refuses traversal, foreign roots and aliases without moving anything',async t=>{
 const base=await tempRoot(t,'manifest'),outside=await tempRoot(t,'outside'),{WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000;
 await put(base,'sessions/a.json.corrupt','A');
 const plan=await h.planQuarantine({base,now:later}),done=await h.quarantine({base,token:plan.token,now:later});
 const area=path.join(base,...done.areas[0].area.split('/')),file=path.join(area,'manifest-v1.json'),good=JSON.parse(fs.readFileSync(file,'utf8'));
 const forged=[
  {...good.items[0],from:'../escape.json',to:'../escape.json'},{...good.items[0],from:path.join(outside,'x').replace(/\\/g,'/'),to:'x'},
  {...good.items[0],from:'C:/x',to:'C:/x'},{...good.items[0],from:'sessions\\a.json.corrupt',to:'sessions\\a.json.corrupt'},
  {...good.items[0],from:'sessions/a.json.corrupt',to:'sessions/other.json'},{...good.items[0],from:'sessions/./a.json.corrupt',to:'sessions/./a.json.corrupt'},
  {...good.items[0],from:'sessions/a.json.corrupt:stream',to:'sessions/a.json.corrupt:stream'},{...good.items[0],from:'.work-data/active-v1.json',to:'.work-data/active-v1.json'},
  {...good.items[0],sha256:'x'}];
 for(const item of forged){
  fs.writeFileSync(file,JSON.stringify({...good,items:[item]}));
  await assert.rejects(h.undoQuarantine({base,stamp:done.stamp}),{code:'work_data_hygiene.record_invalid'},JSON.stringify(item));
 }
 fs.writeFileSync(file,JSON.stringify({...good,root:'.work-data/generations/'+OLD}));
 await assert.rejects(h.undoQuarantine({base,stamp:done.stamp}),{code:'work_data_hygiene.record_invalid'},'a manifest for another root');
 await assert.rejects(h.undoQuarantine({base,stamp:'../x'}),{code:'work_data_hygiene.request_invalid'});
 await assert.rejects(h.undoQuarantine({base,stamp:done.stamp,root:'../../x'}),{code:'work_data_hygiene.request_invalid'});
 // An alias planted on the way back (sessions -> outside) is refused before any rename.
 fs.writeFileSync(file,JSON.stringify(good));fs.rmSync(path.join(base,'sessions'),{recursive:true,force:true});
 fs.symlinkSync(outside,path.join(base,'sessions'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(h.undoQuarantine({base,stamp:done.stamp}),{code:'work_data_hygiene.quarantine_alias'});
 assert.deepEqual(fs.readdirSync(outside),[],'nothing moved outside the root');
 assert.equal(fs.readFileSync(path.join(area,'data','sessions','a.json.corrupt'),'utf8'),'A');
});

test('a crash between creating an area and writing its manifest is reported and swept; a crash mid-move is undone',async t=>{
 const base=await tempRoot(t,'crash'),{WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000;
 const stale='2026-01-01T00-00-00-000Z-0123abcd';await fsp.mkdir(path.join(base,'quarantine-v1',stale),{recursive:true});
 await put(base,'sessions/a.json.corrupt','A');await put(base,'sessions/b.json.corrupt','B');
 let report=await h.inspect({base});
 assert.deepEqual(plain(report.quarantine),[{root:'',stamp:stale,state:'incomplete',plaintext:0}]);
 assert.equal(report.verdicts.find(row=>row.code==='work_data_hygiene.quarantine_incomplete').action,'quarantine','only crash-incomplete areas: the next run sweeps them');
 await assert.rejects(h.undoQuarantine({base,stamp:stale}),{code:'work_data_hygiene.quarantine_unknown'});
 // Second rename fails: the first is moved back and the manifest says rolled-back.
 let renames=0;const failing={...fsp,rename:async(from,to)=>{if(String(to).includes('quarantine-v1')&&++renames===2)throw Object.assign(Error('simulated'),{code:'EIO'});return fsp.rename(from,to);}};
 const {WorkDataRootHygiene:broken}=loadHygiene(failing),plan=await broken.planQuarantine({base,now:later});
 await assert.rejects(broken.quarantine({base,token:plan.token,now:later}),{code:'EIO'});
 assert.equal(fs.readFileSync(path.join(base,'sessions','a.json.corrupt'),'utf8'),'A');assert.equal(fs.readFileSync(path.join(base,'sessions','b.json.corrupt'),'utf8'),'B');
 assert.equal(exists(path.join(base,'quarantine-v1',stale)),false,'the empty manifest-less area was swept (rmdir only)');
 report=await h.inspect({base});assert.deepEqual(plain(report.quarantine.map(row=>row.state)),['rolled-back']);
 // A process killed mid-move leaves state 'moving' with some files moved: inspect flags it and undo restores them.
 const plan2=await h.planQuarantine({base,now:later}),done=await h.quarantine({base,token:plan2.token,now:later});
 const manifest=path.join(base,...done.areas[0].area.split('/'),'manifest-v1.json'),value=JSON.parse(fs.readFileSync(manifest,'utf8'));
 fs.writeFileSync(manifest,JSON.stringify({...value,state:'moving'}));
 const back=path.join(base,...done.areas[0].area.split('/'),'data','sessions','b.json.corrupt');fs.renameSync(back,path.join(base,'sessions','b.json.corrupt'));
 report=await h.inspect({base});assert.equal(report.verdicts.find(row=>row.code==='work_data_hygiene.quarantine_incomplete').action,'undo-quarantine','a run stopped mid-move is undone');
 assert.deepEqual(plain(await h.undoQuarantine({base,stamp:done.stamp})),{schema:1,restored:1,kept:[]});
 assert.equal(fs.readFileSync(path.join(base,'sessions','a.json.corrupt'),'utf8'),'A');
});

test('W4/W3: enabling migrates around product leftovers, caches and worktrees, carries only the committed prefix of a torn audit log and leaves the source untouched',async t=>{
 for(const preserved of [false,true]){
  const {fixture:migrationFixture}=require('../lib/work-data-migration-host-fixture'),f=await migrationFixture(t,preserved?{preserved:true}:{});
  await f.write('config.json','{}');await f.write('sessions/sess_one.json','{"id":"sess_one","private":"HELLO"}');
  const torn='{"a":1}\n{"torn":"PRIVATE TAIL';await f.write('logs/workbench-2026-01-01.ndjson',torn);
  const left={'sessions/sess_two.json.corrupt':'{"id":"sess_two"','sessions/index.json.4321.0123abcd.tmp':'[',['webcache/'+'d'.repeat(64)+'.json']:'{}','agent-worktrees/run/f.txt':'w'};
  for(const [name,bytes] of Object.entries(left))await f.write(name,bytes);
  const expected=await f.manifest.readActive(),backup=await f.backupFirst(),prepared=await f.host.prepare({...backup,expected,targetMode:'encrypted'}),result=await f.host.publish(prepared);
  assert.equal(result.active.generation,1);
  for(const name of Object.keys(left))assert.equal(exists(path.join(result.active.root,...name.split('/'))),false,'not migrated: '+name);
  for(const top of ['webcache','agent-worktrees'])assert.equal(exists(path.join(result.active.root,top)),false,top);
  for(const [name,bytes] of Object.entries({...left,'logs/workbench-2026-01-01.ndjson':torn}))assert.equal(await fsp.readFile(path.join(f.base,...name.split('/')),'utf8'),bytes,'left in place: '+name);
  const migrated=await fsp.readFile(path.join(result.active.root,'logs','workbench-2026-01-01.ndjson'),'utf8');
  assert.equal(migrated.split('\n').length,2,'one committed row, sealed, LF-terminated ('+(preserved?'preserved':'plain')+' reader)');assert.ok(migrated.endsWith('\n'));
  assert.ok(!migrated.includes('PRIVATE TAIL')&&!migrated.includes('torn'),'the torn bytes stay behind and nothing is plaintext');
  assert.ok(exists(path.join(result.active.root,'sessions','sess_one.json')));
 }
});

test('F1: file and directory counts over budget are the typed limit, whichever runs out first, in the reader and the broker-side check',async t=>{
 const tree=loadTree(),root=await tempRoot(t,'counts');
 for(const n of ['a','b','c'])fs.writeFileSync(path.join(root,n),'x');for(const d of ['d1','d2','d3'])fs.mkdirSync(path.join(root,d));
 const reader=limits=>tree.createPreserved({capturePreserved:createPreservedReaderModel(),ownership:{roots:[root]},assertExclusive:async()=>true,assertExclusiveSync:()=>true,limits});
 // files first: 3 files over 2, directories within (entries 7 <= 2+10+1)
 await assert.rejects(reader({files:2,directories:10}).capture(root),error=>error.code==='work_data_tree.preserved_native_engineering_limit'&&error.limit.kind==='files'&&error.limit.maximum===2);
 // directories first: 3 directories over 2, files within
 await assert.rejects(reader({files:10,directories:2}).capture(root),error=>error.code==='work_data_tree.preserved_native_engineering_limit'&&error.limit.kind==='directories'&&error.limit.maximum===2);
 // The same budget is checked on the broker reply before its shape (13u), each count on its own.
 const broker=read('13u-migration-center.js'),slice=require('../lib/source-slice');
 const check=vm.runInNewContext(slice.constBlock(broker,'MIGRATION_CENSUS_BUDGET')+'\n'+slice.functionBlock(broker,'migrationCensusBudgetCheck')+'\nmigrationCensusBudgetCheck',{WorkDataTree:tree});
 const B=tree.NATIVE_BUDGET,row=(dir,i)=>({rel:(dir?'d':'f')+i,dir,streams:[]}),snap=(files,dirs)=>({entries:[{rel:'',dir:true,streams:[]},...Array.from({length:files},(_,i)=>row(false,i)),...Array.from({length:dirs},(_,i)=>row(true,i))]});
 assert.throws(()=>check(snap(B.files+1,10),'data-root'),error=>error.code==='work_data_tree.preserved_native_engineering_limit'&&error.limit.kind==='files'&&error.limit.maximum===B.files);
 assert.throws(()=>check(snap(10,B.directories+1),'data-root'),error=>error.limit.kind==='directories'&&error.limit.maximum===B.directories);
 assert.doesNotThrow(()=>check(snap(B.files,B.directories),'data-root'),'exactly the budget passes (entries = 200,001)');
 assert.doesNotThrow(()=>check(snap(B.files+1,0),'capsule'),'capsule captures keep their own caps');
});

test('F2: quarantine never follows a junction at or below quarantine-v1 and sweeps nothing outside the root',async t=>{
 const {WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000,STALE='2026-01-01T00-00-00-000Z-deadbeef',kind=process.platform==='win32'?'junction':'dir';
 // A: quarantine-v1 itself is a junction to an outside directory holding an empty stamp-named directory.
 const a=await tempRoot(t,'f2a'),aOut=await tempRoot(t,'f2a-out');fs.mkdirSync(path.join(aOut,STALE));fs.symlinkSync(aOut,path.join(a,'quarantine-v1'),kind);
 await put(a,'sessions/x.json.corrupt','X');old(path.join(a,'sessions','x.json.corrupt'));
 let report=await h.inspect({base:a});
 assert.ok(report.verdicts.some(row=>row.code==='work_data_hygiene.aliases_present'&&row.severity==='blocking'));
 assert.deepEqual(plain(report.quarantine),[{root:'',stamp:null,state:'alias',plaintext:0}]);
 assert.equal(report.verdicts.find(row=>row.code==='work_data_hygiene.quarantine_record_invalid').action,'recover');
 await assert.rejects(h.planQuarantine({base:a,now:later}),{code:'work_data_hygiene.quarantine_alias'});
 await assert.rejects(h.quarantine({base:a,token:'0'.repeat(64),now:later}),{code:'work_data_hygiene.quarantine_alias'});
 assert.ok(fs.existsSync(path.join(aOut,STALE)),'the outside empty directory is kept');assert.ok(fs.existsSync(path.join(a,'sessions','x.json.corrupt')));
 // B: one stamp directory is a junction to an outside empty directory.
 const b=await tempRoot(t,'f2b'),bOut=await tempRoot(t,'f2b-out');fs.mkdirSync(path.join(b,'quarantine-v1'));fs.symlinkSync(bOut,path.join(b,'quarantine-v1',STALE),kind);
 await put(b,'sessions/x.json.corrupt','X');old(path.join(b,'sessions','x.json.corrupt'));
 report=await h.inspect({base:b});assert.deepEqual(plain(report.quarantine),[{root:'',stamp:STALE,state:'alias',plaintext:0}]);
 await assert.rejects(h.planQuarantine({base:b,now:later}),{code:'work_data_hygiene.quarantine_alias'});
 assert.ok(fs.lstatSync(path.join(b,'quarantine-v1',STALE)).isSymbolicLink(),'the junction itself is kept');assert.ok(fs.existsSync(bOut));
});

test('S1: a torn manifest without data is crash-incomplete and swept by the next run; a torn manifest with data is left for recovery',async t=>{
 const {WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000,STALE='2026-01-01T00-00-00-000Z-deadbeef',OTHER='2026-01-02T00-00-00-000Z-0badf00d';
 const base=await tempRoot(t,'s1');fs.mkdirSync(path.join(base,'quarantine-v1',STALE),{recursive:true});fs.writeFileSync(path.join(base,'quarantine-v1',STALE,'manifest-v1.json'),'{"schema":1,"st');
 fs.mkdirSync(path.join(base,'quarantine-v1',OTHER,'data','sessions'),{recursive:true});fs.writeFileSync(path.join(base,'quarantine-v1',OTHER,'manifest-v1.json'),'');
 fs.writeFileSync(path.join(base,'quarantine-v1',OTHER,'data','sessions','y.json.corrupt'),'Y');
 await put(base,'sessions/x.json.corrupt','X');
 const report=await h.inspect({base});
 assert.deepEqual(plain(report.quarantine.map(row=>[row.stamp,row.state])),[[STALE,'incomplete'],[OTHER,'invalid']]);
 assert.equal(report.verdicts.find(row=>row.code==='work_data_hygiene.quarantine_incomplete').action,'quarantine','nothing to undo: the next run clears it');
 assert.equal(report.verdicts.find(row=>row.code==='work_data_hygiene.quarantine_record_invalid').action,'recover');
 const plan=await h.planQuarantine({base,now:later});await h.quarantine({base,token:plan.token,now:later});
 assert.equal(fs.existsSync(path.join(base,'quarantine-v1',STALE)),false,'torn crash area swept');
 assert.equal(fs.readFileSync(path.join(base,'quarantine-v1',OTHER,'data','sessions','y.json.corrupt'),'utf8'),'Y','an area holding data is never swept');
});

test('F3/S2: moved superseded plaintext keeps an advice verdict until undone; undo restores only to leftover paths',async t=>{
 const base=await tempRoot(t,'f3'),{WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000;
 await put(base,'.work-data/active-v1.json',pointerOf(ID));await put(base,'.work-data/generations/'+ID+'/config.json','SEALED');
 await put(base,'config.json.corrupt-1731900000000','{"apiKey":"sk-synthetic"}');await put(base,'.work-data/generations/'+ID+'/sessions/a.json.corrupt','SEALED-COPY');
 const plan=await h.planQuarantine({base,now:later}),done=await h.quarantine({base,token:plan.token,now:later});assert.equal(done.moved,2);
 const manifest=path.join(base,'quarantine-v1',done.stamp,'manifest-v1.json'),value=JSON.parse(fs.readFileSync(manifest,'utf8'));
 assert.deepEqual(plain(value.items.map(row=>[row.from,row.area])),[['config.json.corrupt-1731900000000','superseded']],'the source area is recorded');
 let report=await h.inspect({base});
 const verdict=report.verdicts.find(row=>row.code==='work_data_hygiene.quarantined_plaintext_present');
 assert.ok(verdict,'still plaintext inside the root: never silent');assert.equal(verdict.severity,'advice');assert.equal(verdict.action,'delete-manually');
 assert.equal(verdict.params.count,1);assert.deepEqual(plain(verdict.params.areas),[{root:'',stamp:done.stamp,path:'quarantine-v1/'+done.stamp}]);
 assert.ok(fs.existsSync(path.join(base,'quarantine-v1',done.stamp,'data','config.json.corrupt-1731900000000')),'nothing is deleted automatically');
 const genArea=done.areas.find(row=>row.root!=='');assert.ok(genArea);
 assert.equal(report.quarantine.find(row=>row.root!=='').plaintext,0,'active-root copies are not counted as superseded plaintext');
 // S2: a forged entry pointing into skills/ or a skill-backup scope refuses the whole undo.
 const payload='planted',digest=crypto.createHash('sha256').update(payload).digest('hex');
 for(const rel of ['skills/evil/SKILL.md','migrations/skill-backups/2026-01-01T00-00-00-000Z/one/SKILL.md','uploads/att/a.corrupt']){
  fs.writeFileSync(manifest,JSON.stringify({...value,items:[...value.items,{from:rel,to:rel,size:payload.length,sha256:digest,reason:'quarantined-corrupt',area:'active'}]}));
  await assert.rejects(h.undoQuarantine({base,stamp:done.stamp}),{code:'work_data_hygiene.record_invalid'},rel);
  assert.equal(exists(path.join(base,...rel.split('/'))),false,rel);
 }
 fs.writeFileSync(manifest,JSON.stringify(value));
 assert.equal((await h.undoQuarantine({base,stamp:done.stamp})).restored,1);
 report=await h.inspect({base});assert.equal(report.verdicts.some(row=>row.code==='work_data_hygiene.quarantined_plaintext_present'),false);
 assert.ok(report.verdicts.some(row=>row.code==='work_data_hygiene.superseded_leftovers_present'),'back in place, reported as before');
});

test('S3: an aged agent-run archive stage is quarantined without a writer pid',async t=>{
 const base=await tempRoot(t,'s3'),{WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000;
 await put(base,'agent-runs/sess_a/run1.events.ndjson.gz.tmp','GZ');
 const plan=await h.planQuarantine({base,now:later,isAlive:()=>true});
 assert.deepEqual(plain(plan.items.map(row=>[row.path,row.reason])),[['agent-runs/sess_a/run1.events.ndjson.gz.tmp','archive-stage']]);
 assert.equal((await h.planQuarantine({base,isAlive:()=>true})).files,0,'a fresh stage may still be written');
});
test('151 phase 3C integration: a manifest that parses but fails validation is never swept, even without data (a live run may be writing it)',async t=>{
 const {WorkDataRootHygiene:h}=loadHygiene(),later=Date.now()+600000,LIVE='2026-01-03T00-00-00-000Z-feedface';
 const base=await tempRoot(t,'s1v');fs.mkdirSync(path.join(base,'quarantine-v1',LIVE),{recursive:true});
 const manifest=path.join(base,'quarantine-v1',LIVE,'manifest-v1.json');fs.writeFileSync(manifest,JSON.stringify({schema:1,state:'moving',items:[{from:'sessions/x.json.corrupt',to:'sessions/x.json.corrupt'}]}));
 await put(base,'sessions/z.json.corrupt','Z');
 const report=await h.inspect({base});
 assert.deepEqual(plain(report.quarantine.map(row=>[row.stamp,row.state])),[[LIVE,'invalid']],'parseable but invalid is invalid, not crash-incomplete');
 const plan=await h.planQuarantine({base,now:later});await h.quarantine({base,token:plan.token,now:later});
 assert.equal(fs.existsSync(manifest),true,'the sweep only removes empty or unparsable manifests');
});
