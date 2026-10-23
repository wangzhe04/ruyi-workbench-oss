'use strict';
// Real source/crypto/fs, synthetic owned keys; no app process, DPAPI or network.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {functionBlock,constBlock}=require('../lib/source-slice'),{loadWorkDataChunks}=require('../lib/work-data-chunks-fixture');
const sourceDir=process.env.RUYI_MIGRATION_SOURCE_DIR||path.resolve(__dirname,'../../ruyi-workbench/app/src'),source=name=>fs.readFileSync(path.join(sourceDir,name),'utf8');
const base=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(base,'ruyi-migration-record-unit-')),masters=[];
after(()=>{for(const master of masters)master.fill(0);assert.equal(path.dirname(root),base);fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'case-')),paths={data:dir,skills:path.join(dir,'skills')},state={enabled:false,missing:false,acquires:0,releases:0,writes:0,rows:[],instance:'migration-unit'},master=crypto.randomBytes(32);masters.push(master);
 const fx=loadWorkDataChunks();if(fs.existsSync(path.join(sourceDir,'01p-work-data-store.js')))fx.store=vm.runInNewContext(constBlock(source('01p-work-data-store.js'),'WorkDataStore')+'\nWorkDataStore;',{require,Buffer,WorkDataCrypto:fx.crypto,WorkDataChunks:fx.chunks});const keys={snapshot:async()=>{state.acquires++;if(state.missing)throw Object.assign(Error('missing'),{code:'work_data_key.absent'});const key=Buffer.from(master);return{key,instanceId:state.instance,release:()=>{state.releases++;key.fill(0);}};}};fx.store.Hooks.keys=keys;
 const ctx={require,Buffer,process,console,crypto,fs,fsp,path,paths,WorkDataStore:fx.store,SKILL_ID_RE:/^[A-Za-z0-9_-]{1,64}$/,MigrationHooks:{},VERSION:'unit',safeJsonParse:(text,fallback)=>{try{return JSON.parse(text);}catch{return fallback;}},readConfig:async()=>({workDataEncryptionV1:state.enabled}),atomicWriteJson:async(...args)=>{state.writes++;if(state.writeError)throw state.writeError;return fx.atomicWriteJson(...args);},samePathKey:file=>path.resolve(file).toLowerCase(),nowIso:()=>new Date().toISOString(),tildePath:x=>x,externalRoot:()=>dir,logEvent:()=>{},__state:state};
 const tool=source('12-tool-dispatch.js'),names=['skillImportRecordStore','writeSkillImportRecord','readSkillImportRecord'];
 const code=constBlock(tool,'SKILL_IMPORT_RECORD')+'\n'+constBlock(tool,'SKILL_IMPORT_SOURCES')+'\n'+names.map(name=>functionBlock(tool,name)).join('\n')+'\n'+source('13u-migration-center.js')+'\nmigrationSkillRows = async () => __state.rows;\n({'+[...names,'migrationLogStore','writeMigrationLog','migrationLogs','migrationStoragePreflight','migrationNextLogStamp','migrationBackup','migrationRewriteRefs','migrationCopyOneSkill','migrationCopySkills','migrationUndo','migrationSkillTree','migrationTreeHash'].join(',')+'});';
 const api=vm.runInNewContext(code,ctx),skill=id=>{const target=path.join(paths.skills,id);fs.mkdirSync(target,{recursive:true});return target;},record={schema:1,source:'codex',sourcePath:path.join(dir,'source'),plugin:'',importedAt:'2026-01-01',sourceTreeHash:'a'.repeat(64),copyTreeHash:'b'.repeat(64)},log=(id='2026-01-01T00-00-00-000Z')=>({schema:1,id,createdAt:'2026-01-01',currentRoot:dir,version:'unit',files:[]});
 const seal=(file,text,purpose,scopeId,recordId)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({workData:2,...fx.crypto.seal(text,master,{purpose,instanceId:state.instance,schema:1,scopeId,recordId,seq:1})}));};
 return{dir,paths,state,master,fx,ctx,api,skill,record,log,seal};
}
const privateError=error=>String(error?.code||'').startsWith('work_data');

test('OFF log and skill-record bytes remain identical, large ordinary logs have no new cap or key access',async()=>{
 const f=fixture(),skill=f.skill('plain');await f.api.writeSkillImportRecord(skill,f.record,'plain');assert.equal(fs.readFileSync(path.join(skill,'.ruyi-import.json'),'utf8'),JSON.stringify(f.record,null,2)+'\n');assert.deepEqual(JSON.parse(JSON.stringify(await f.api.readSkillImportRecord(skill))),f.record);
 const log=f.log();log.note='x'.repeat(1024*1024+123);fs.mkdirSync(path.join(f.dir,'migrations'));await f.api.writeMigrationLog(log);assert.equal(fs.readFileSync(path.join(f.dir,'migrations',log.id+'.json'),'utf8'),JSON.stringify(log,null,2));assert.equal((await f.api.migrationLogs())[0].note.length,log.note.length);assert.equal(f.state.acquires,0);
});

test('ordinary malformed, unknown and oversized skill records retain a null miss, with no whole oversized plaintext read',async()=>{
 const f=fixture(),skill=f.skill('ordinary'),file=path.join(skill,'.ruyi-import.json');
 for(const text of ['{broken',JSON.stringify({schema:1,source:'unknown'}),JSON.stringify({...f.record,sourcePath:'x'.repeat(20000)})]){fs.writeFileSync(file,text);assert.equal(await f.api.readSkillImportRecord(skill),null);}
 fs.unlinkSync(file);fs.mkdirSync(file);assert.equal(await f.api.readSkillImportRecord(skill),null);assert.equal(f.state.acquires,0);
});

test('log listing preserves newest20 and skips bad ordinary records',async()=>{
 const f=fixture(),dir=path.join(f.dir,'migrations');fs.mkdirSync(dir);for(let i=0;i<25;i++){const log=f.log('2026-01-01T00-00-'+String(i).padStart(2,'0')+'-000Z');fs.writeFileSync(path.join(dir,log.id+'.json'),JSON.stringify(log));}
 fs.writeFileSync(path.join(dir,'9999-01-01T00-00-00-000Z.json'),'{ordinary');const rows=await f.api.migrationLogs();assert.equal(rows.length,19);assert.equal(rows[0].id,'2026-01-01T00-00-24-000Z');
});

test('sealed record business cap uses plaintext not base64 disk size and staging binds to final id after rename',async()=>{
 const f=fixture();f.state.enabled=true;const stage=path.join(f.paths.skills,'.ruyi-copy-final-ts');fs.mkdirSync(stage,{recursive:true});const record={...f.record,sourcePath:'P'.repeat(12000)};await f.api.writeSkillImportRecord(stage,record,'final');const target=path.join(f.paths.skills,'final');fs.renameSync(stage,target);const file=path.join(target,'.ruyi-import.json');assert.ok(fs.statSync(file).size>16384);assert.equal((await f.api.readSkillImportRecord(target)).sourcePath,record.sourcePath);assert.equal(JSON.parse(fs.readFileSync(file,'utf8').split('\n')[0]).purpose,'backup');
});

test('sealed warm record reads check key/instance every time and never collapse missing keys to metadata absence',async()=>{
 const f=fixture();f.state.enabled=true;const skill=f.skill('warm');await f.api.writeSkillImportRecord(skill,f.record,'warm');const file=path.join(skill,'.ruyi-import.json'),raw=fs.readFileSync(file);assert.ok(await f.api.readSkillImportRecord(skill));f.state.missing=true;await assert.rejects(()=>f.api.readSkillImportRecord(skill),{code:'work_data_key.absent'});await assert.rejects(()=>f.api.writeSkillImportRecord(skill,f.record,'warm'),privateError);assert.deepEqual(fs.readFileSync(file),raw);f.state.missing=false;f.state.instance='different';await assert.rejects(()=>f.api.readSkillImportRecord(skill),privateError);
});

test('sealed record cross-id, authenticated wrong shape and truncation are hard errors and immutable on writes',async()=>{
 const f=fixture();f.state.enabled=true;const one=f.skill('one'),two=f.skill('two');await f.api.writeSkillImportRecord(one,f.record,'one');fs.copyFileSync(path.join(one,'.ruyi-import.json'),path.join(two,'.ruyi-import.json'));await assert.rejects(()=>f.api.readSkillImportRecord(two),privateError);
 const file=path.join(one,'.ruyi-import.json');f.seal(file,JSON.stringify({...f.record,source:'unknown'}),'backup','skills','skill-import:one');let raw=fs.readFileSync(file);await assert.rejects(()=>f.api.readSkillImportRecord(one),{code:'work_data_store.validate'});await assert.rejects(()=>f.api.writeSkillImportRecord(one,f.record,'one'),privateError);assert.deepEqual(fs.readFileSync(file),raw);
 fs.writeFileSync(file,'{"workData":3,"format":');raw=fs.readFileSync(file);await assert.rejects(()=>f.api.readSkillImportRecord(one),privateError);await assert.rejects(()=>f.api.writeSkillImportRecord(one,f.record,'one'),privateError);assert.deepEqual(fs.readFileSync(file),raw);
});

test('oversized escaped-key sealed records authenticate instead of returning a plaintext-size miss',async()=>{
 const f=fixture(),skill=f.skill('escaped'),file=path.join(skill,'.ruyi-import.json');f.seal(file,JSON.stringify({...f.record,sourcePath:'x'.repeat(12000)}),'backup','skills','skill-import:escaped');let text=fs.readFileSync(file,'utf8');text=text.replace('"workData"','"'+String.fromCharCode(92)+'u0077orkData"');fs.writeFileSync(file,text);assert.ok(fs.statSync(file).size>16384);assert.equal((await f.api.readSkillImportRecord(skill)).sourcePath.length,12000);f.state.missing=true;await assert.rejects(()=>f.api.readSkillImportRecord(skill),privateError);
});

test('sealed logs retain large fields and enforce purpose, filename and authenticated shape without falling back to []',async()=>{
 const f=fixture();f.state.enabled=true;fs.mkdirSync(path.join(f.dir,'migrations'));const log=f.log();log.detail='汉字'.repeat(280000);await f.api.writeMigrationLog(log);const file=path.join(f.dir,'migrations',log.id+'.json'),header=JSON.parse(fs.readFileSync(file,'utf8').split('\n')[0]);assert.equal(header.purpose,'migration');assert.equal((await f.api.migrationLogs())[0].detail,log.detail);const raw=fs.readFileSync(file);f.state.missing=true;await assert.rejects(()=>f.api.migrationLogs(),privateError);await assert.rejects(()=>f.api.writeMigrationLog(log),privateError);assert.deepEqual(fs.readFileSync(file),raw);f.state.missing=false;
 f.seal(file,JSON.stringify({...log,detail:undefined,files:{}}),'migration','global','migration-log:'+log.id);await assert.rejects(()=>f.api.migrationLogs(),{code:'work_data_store.validate'});await assert.rejects(()=>f.api.writeMigrationLog(log),privateError);
});

test('OFF cannot downgrade a sealed log or record, and failed storage preserves authority',async()=>{
 const f=fixture();f.state.enabled=true;fs.mkdirSync(path.join(f.dir,'migrations'));const log=f.log(),skill=f.skill('sealed');await f.api.writeMigrationLog(log);await f.api.writeSkillImportRecord(skill,f.record,'sealed');const logFile=path.join(f.dir,'migrations',log.id+'.json'),file=path.join(skill,'.ruyi-import.json'),rawLog=fs.readFileSync(logFile),raw=fs.readFileSync(file);f.state.enabled=false;await assert.rejects(()=>f.api.writeMigrationLog(log),privateError);await assert.rejects(()=>f.api.writeSkillImportRecord(skill,f.record,'sealed'),privateError);assert.deepEqual(fs.readFileSync(logFile),rawLog);assert.deepEqual(fs.readFileSync(file),raw);
 f.state.enabled=true;f.state.writeError=Object.assign(Error('full'),{code:'ENOSPC'});await assert.rejects(()=>f.api.writeMigrationLog(log),{code:'ENOSPC'});assert.deepEqual(fs.readFileSync(logFile),rawLog);
});

test('ON key preflight precedes copy cleanup/live changes and OFF does not unlock',async()=>{
 const f=fixture();await f.api.migrationStoragePreflight();assert.equal(f.state.acquires,0);f.state.enabled=true;f.state.missing=true;let touched=false;f.state.rows=[];f.ctx.fsp={...fsp,readdir:async()=>{touched=true;return[];}};
 await assert.rejects(()=>f.api.migrationCopySkills({keys:['codex:one']}),{code:'work_data_key.absent'});assert.equal(touched,false);
});

test('skill copy publishes a sealed final-id record, preserves content tree hash, and missing key never replaces live skill',async()=>{
 const f=fixture(),src=path.join(f.dir,'src');fs.mkdirSync(src);fs.writeFileSync(path.join(src,'SKILL.md'),'# Synthetic skill\nPRIVATE SKILL BODY\n');const row={id:'one',_dir:src,source:'codex',plugin:''};f.state.enabled=true;let result=await f.api.migrationCopyOneSkill(row,'2026-01-01T00-00-00-000Z');assert.equal(result.ok,true);const target=path.join(f.paths.skills,'one');assert.equal((await f.api.readSkillImportRecord(target)).copyTreeHash,result.copyTreeHash);assert.equal(await f.api.migrationTreeHash(await f.api.migrationSkillTree(target)),result.copyTreeHash);assert.ok(fs.readFileSync(path.join(target,'.ruyi-import.json'),'utf8').startsWith('{"workData":3'));
 const before=fs.readFileSync(path.join(target,'SKILL.md'));f.state.missing=true;await assert.rejects(()=>f.api.migrationCopyOneSkill(row,'2026-01-02T00-00-00-000Z'),privateError);assert.deepEqual(fs.readFileSync(path.join(target,'SKILL.md')),before);assert.equal(fs.readdirSync(f.paths.skills).some(name=>name.startsWith('.ruyi-copy-')),false);
});

test('legacy minimal undo log can transition ON with partial progress, preserving ordinary failed-file retry semantics',async()=>{
 const f=fixture(),dir=path.join(f.dir,'migrations'),a=path.join(f.dir,'a.json'),b=path.join(f.dir,'b.json');fs.mkdirSync(dir);fs.writeFileSync(a,JSON.stringify({mcpServers:{a:{command:'NEW'}}}));fs.mkdirSync(b);const item=id=>({serverId:id,container:['mcpServers'],changes:[{field:'command',from:'OLD',to:'NEW'}]});const log={schema:1,id:f.log().id,files:[{file:a,kind:'json',items:[item('a')]},{file:b,kind:'json',items:[item('b')]}]};fs.writeFileSync(path.join(dir,log.id+'.json'),JSON.stringify(log));f.state.enabled=true;const first=await f.api.migrationUndo({id:log.id});assert.equal(first.error,'undo-incomplete');const progress=(await f.api.migrationLogs())[0];assert.ok(progress.files[0].undoneAt);assert.equal(progress.undoneAt,undefined);fs.rmdirSync(b);fs.writeFileSync(b,JSON.stringify({mcpServers:{b:{command:'NEW'}}}));const second=await f.api.migrationUndo({id:log.id});assert.equal(second.ok,true);assert.equal(JSON.parse(fs.readFileSync(b)).mcpServers.b.command,'OLD');assert.ok((await f.api.migrationLogs())[0].undoneAt);
});

test('skill selection and UI mutation consumers propagate work-data errors instead of clearing selections',async()=>{
 const error=Object.assign(Error('missing'),{code:'work_data_key.absent'}),tool=source('12-tool-dispatch.js');const resolve=vm.runInNewContext(functionBlock(tool,'resolveEnabledSkillEntries')+'\nresolveEnabledSkillEntries;',{effectiveSkillSelection:()=>[{id:'one'}],loadSkillRegistry:async()=>{throw error;}});await assert.rejects(()=>resolve({}, {}, '',null),{code:'work_data_key.absent'});
 const set=vm.runInNewContext(functionBlock(source('13-http-router.js'),'setSessionSkillsCore')+'\nsetSessionSkillsCore;',{loadSession:async()=>({id:'s'}),readConfig:async()=>({}),normalizeCwd:()=>'',loadSkillRegistry:async()=>{throw error;}});await assert.rejects(()=>set('s',[]),{code:'work_data_key.absent'});
 const ordinary=vm.runInNewContext(functionBlock(tool,'resolveEnabledSkillEntries')+'\nresolveEnabledSkillEntries;',{effectiveSkillSelection:()=>[{id:'one'}],loadSkillRegistry:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}});assert.equal((await ordinary({}, {}, '',null)).length,0);
});


test('escaped-key truncated containers fail closed on both reads and writes without changing either family file',async()=>{
 const f=fixture(),skill=f.skill('truncated'),recordFile=path.join(skill,'.ruyi-import.json'),log=f.log(),logFile=path.join(f.dir,'migrations',log.id+'.json');fs.mkdirSync(path.dirname(logFile));f.state.enabled=true;const raw='{"'+String.fromCharCode(92)+'u0077orkData":2,"ciphertext":';
 fs.writeFileSync(recordFile,raw);fs.writeFileSync(logFile,raw);await assert.rejects(()=>f.api.readSkillImportRecord(skill),privateError);await assert.rejects(()=>f.api.migrationLogs(),privateError);await assert.rejects(()=>f.api.writeSkillImportRecord(skill,f.record,'truncated'),privateError);await assert.rejects(()=>f.api.writeMigrationLog(log),privateError);assert.equal(fs.readFileSync(recordFile,'utf8'),raw);assert.equal(fs.readFileSync(logFile,'utf8'),raw);
});

test('OFF sealed undo refuses before external file mutation and keeps both authorities byte exact',async()=>{
 const f=fixture(),file=path.join(f.dir,'external.json'),dir=path.join(f.dir,'migrations');
  fs.mkdirSync(dir);
  fs.writeFileSync(file,'{"mcpServers":{"x":{"command":"NEW"}}}\n');
  const log=f.log();
  log.files=[{kind:'json',file,items:[{serverId:'x',container:['mcpServers'],changes:[{field:'command',from:'OLD',to:'NEW'}]}]}];
  f.state.enabled=true;
  await f.api.writeMigrationLog(log);
  const logFile=path.join(dir,log.id+'.json'),before=fs.readFileSync(file),receipt=fs.readFileSync(logFile);
  f.state.enabled=false;
  await assert.rejects(()=>f.api.migrationUndo({id:log.id}),{code:'work_data_store.downgrade_refused'});
  assert.deepEqual(fs.readFileSync(file),before);
  assert.deepEqual(fs.readFileSync(logFile),receipt);
});
test('OFF cannot replace sealed skill provenance through a plaintext stage and ON rejects corrupt provenance before staging',async()=>{
 const f=fixture(),src=path.join(f.dir,'src'),target=f.skill('protected');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src,'SKILL.md'),'# Replacement\n');
  fs.writeFileSync(path.join(target,'SKILL.md'),'# Original\n');
  const row={id:'protected',_dir:src,source:'codex',plugin:''};
  f.state.enabled=true;
  await f.api.writeSkillImportRecord(target,f.record,'protected');
  const file=path.join(target,'.ruyi-import.json'),before=fs.readFileSync(file);
  f.state.enabled=false;
  await assert.rejects(()=>f.api.migrationCopyOneSkill(row,'2026-01-01T00-00-00-000Z'),{code:'work_data_store.downgrade_refused'});
  assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(fs.readFileSync(path.join(target,'SKILL.md'),'utf8'),'# Original\n');
  f.state.enabled=true;
  fs.writeFileSync(file,'{"workData":3,"format":');
  await assert.rejects(()=>f.api.migrationCopyOneSkill(row,'2026-01-01T00-00-00-001Z'),privateError);
  assert.equal(fs.readdirSync(f.paths.skills).some(name=>name.startsWith('.ruyi-copy-')),false);
  assert.equal(fs.readFileSync(path.join(target,'SKILL.md'),'utf8'),'# Original\n');
});
test('same-millisecond log allocation preserves existing receipts and backup batches across restart, without reserving keys',async()=>{
 const f=fixture(),time=Date.parse('2026-01-01T00:00:00.000Z'),RealDate=Date;
  f.ctx.Date=class extends RealDate{static now(){return time;
    }};
  const dir=path.join(f.dir,'migrations');
  fs.mkdirSync(path.join(dir,'skill-backups','2026-01-01T00-00-00-001Z'),{recursive:true});
  const file=path.join(dir,'2026-01-01T00-00-00-000Z.json');
  fs.writeFileSync(file,'old receipt');
  assert.equal(await f.api.migrationNextLogStamp(),'2026-01-01T00-00-00-002Z');
  assert.equal(await f.api.migrationNextLogStamp(),'2026-01-01T00-00-00-003Z');
  assert.equal(fs.readFileSync(file,'utf8'),'old receipt');
  assert.equal(f.state.acquires,0);
});
test('existing reference backup is never overwritten when a failed prior migration reused the timestamp',async()=>{
 const f=fixture(),file=path.join(f.dir,'external.json'),stamp='2026-01-01T00-00-00-000Z';
  fs.writeFileSync(file,'new config');
  const backup=await f.api.migrationBackup(file,stamp);
  fs.writeFileSync(file,'later config');
  await assert.rejects(()=>f.api.migrationBackup(file,stamp),{code:'EEXIST'});
  assert.equal(fs.readFileSync(backup,'utf8'),'new config');
  assert.equal(fs.readFileSync(file,'utf8'),'later config');
});
test('short preflight lease is released before local copy filesystem side effects, including direct internal callers',async()=>{
 const f=fixture(),src=path.join(f.dir,'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src,'SKILL.md'),'# Skill\n');
  f.state.enabled=true;
  const observed=[];
  f.ctx.fsp={...fsp,copyFile:async(...args)=>{observed.push([f.state.acquires,f.state.releases]);
      assert.equal(f.state.acquires,f.state.releases);
      return fsp.copyFile(...args);
    },rename:async(...args)=>{assert.equal(f.state.acquires,f.state.releases);
      return fsp.rename(...args);
    }};
  assert.equal((await f.api.migrationCopyOneSkill({id:'one',_dir:src,source:'codex',plugin:''},'2026-01-01T00-00-00-000Z')).ok,true);
  assert.equal(observed.length,1);
  assert.ok(observed[0][0]>0);
  assert.equal(f.state.acquires,f.state.releases);
  const other=fixture();
  other.state.enabled=true;
  other.state.missing=true;
  let touched=false;
  other.ctx.fsp={...fsp,mkdir:async()=>{touched=true;
    }};
  await assert.rejects(()=>other.api.migrationCopyOneSkill({id:'one',_dir:src,source:'codex',plugin:''},'2026-01-01T00-00-00-000Z'),{code:'work_data_key.absent'});
  assert.equal(touched,false);
});
test('work-data provenance errors escape undo without deleting live skills or recording a misleading partial receipt',async()=>{
 const f=fixture(),target=f.skill('one'),dir=path.join(f.dir,'migrations');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(target,'SKILL.md'),'# Live\n');
  const log=f.log();
  log.files=[{file:target,kind:'skill-copy',backup:'',items:[{id:'one',copyTreeHash:'a'.repeat(64)}]}];
  const logFile=path.join(dir,log.id+'.json');
  fs.writeFileSync(logFile,JSON.stringify(log,null,2));
  const before=fs.readFileSync(logFile);
  f.ctx.readSkillImportRecord=async()=>{throw Object.assign(Error('corrupt'),{code:'work_data_store.corrupt'});
  };
  await assert.rejects(()=>f.api.migrationUndo({id:log.id}),{code:'work_data_store.corrupt'});
  assert.deepEqual(fs.readFileSync(logFile),before);
  assert.equal(fs.readFileSync(path.join(target,'SKILL.md'),'utf8'),'# Live\n');
});
test('copy log failure returns the completed receipt without retrying or replacing it with a no-op failure',async()=>{
 const f=fixture(),src=path.join(f.dir,'source');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src,'SKILL.md'),'# Synthetic completed copy\n');
  f.state.rows=[{key:'codex:one',id:'one',_dir:src,source:'codex',plugin:'',status:'live'}];
  f.state.enabled=true;
  let copies=0;
  f.ctx.fsp={...fsp,copyFile:async(...args)=>{copies++;
      return fsp.copyFile(...args);
    }};
  f.ctx.atomicWriteJson=async(file,...args)=>{if(path.dirname(file)===path.join(f.dir,'migrations'))throw Object.assign(Error('full'),{code:'ENOSPC'});
    return f.fx.atomicWriteJson(file,...args);
  };
  const result=await f.api.migrationCopySkills({keys:['codex:one']});
  assert.equal(result.ok,false);
  assert.equal(result.operationMayHaveExecuted,true);
  assert.equal(result.resultUnavailable,true);
  assert.equal(result.retry,false);
  assert.equal(result.copied,1);
  assert.equal(result.results[0].outcome,'created');
  assert.equal(copies,1);
  assert.equal(fs.readFileSync(path.join(f.paths.skills,'one','SKILL.md'),'utf8'),'# Synthetic completed copy\n');
  assert.equal(fs.existsSync(path.join(f.dir,'migrations',result.id+'.json')),false);
  assert.equal(f.state.acquires,f.state.releases);
});
test('undo log failure retains completed target count and current bytes, with no internal replay',async()=>{
 const f=fixture(),dir=path.join(f.dir,'migrations'),file=path.join(f.dir,'external.json');
  fs.mkdirSync(dir);
  fs.writeFileSync(file,'{"mcpServers":{"x":{"command":"NEW"}}}');
  const log=f.log();
  log.files=[{file,kind:'json',items:[{serverId:'x',container:['mcpServers'],changes:[{field:'command',from:'OLD',to:'NEW'}]}]}];
  const logFile=path.join(dir,log.id+'.json');
  fs.writeFileSync(logFile,JSON.stringify(log,null,2));
  const before=fs.readFileSync(logFile);
  f.state.enabled=true;
  let effects=0;
  f.ctx.atomicWriteJson=async(target,...args)=>{if(path.dirname(target)===dir)throw Object.assign(Error('full'),{code:'ENOSPC'});
    effects++;
    return f.fx.atomicWriteJson(target,...args);
  };
  const result=await f.api.migrationUndo({id:log.id});
  assert.equal(result.resultUnavailable,true);
  assert.equal(result.retry,false);
  assert.equal(result.restored,1);
  assert.equal(result.operationMayHaveExecuted,true);
  assert.equal(effects,1);
  assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers.x.command,'OLD');
  assert.deepEqual(fs.readFileSync(logFile),before);
});
test('ON rejects malformed legacy undo shape before touching external targets, while OFF keeps legacy tolerance',async()=>{
 const f=fixture(),dir=path.join(f.dir,'migrations'),file=path.join(f.dir,'external.json');
  fs.mkdirSync(dir);
  const log=f.log();
  log.files=[{file,kind:'json',items:{invalid:true}}];
  const logFile=path.join(dir,log.id+'.json');
  fs.writeFileSync(logFile,JSON.stringify(log));
  fs.writeFileSync(file,'{"keep":"current"}');
  f.state.enabled=true;
  await assert.rejects(()=>f.api.migrationUndo({id:log.id}),{code:'work_data_store.validate'});
  assert.equal(fs.readFileSync(file,'utf8'),'{"keep":"current"}');
  assert.equal(f.state.acquires,0);
});
test('ON legacy undo binds its id to the enumerated filename before external effects, with OFF listing unchanged',async()=>{
 const f=fixture(),dir=path.join(f.dir,'migrations'),file=path.join(f.dir,'external.json');
  fs.mkdirSync(dir);
  fs.writeFileSync(file,'{"mcpServers":{"x":{"command":"NEW"}}}');
  const log=f.log(),logFile=path.join(dir,log.id+'.json');
  log.files=[{file,kind:'json',items:[{serverId:'x',container:['mcpServers'],changes:[{field:'command',from:'OLD',to:'NEW'}]}]}];
  for(const id of ['wrong-id','2026-01-02T00-00-00-000Z']){log.id=id;
    fs.writeFileSync(logFile,JSON.stringify(log));
    const before=fs.readFileSync(logFile);
    f.state.enabled=false;
    assert.equal((await f.api.migrationLogs())[0].id,id);
    f.state.enabled=true;
    await assert.rejects(()=>f.api.migrationUndo({}),{code:'work_data_store.validate'});
    assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers.x.command,'NEW');
    assert.deepEqual(fs.readFileSync(logFile),before);
    assert.equal(fs.readdirSync(dir).length,1);
  }
});
test('later key loss after a completed copy retains the earlier result with an explicit partial outcome',async()=>{
 const f=fixture();
  for(const id of ['one','two']){const src=path.join(f.dir,id);
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src,'SKILL.md'),'# '+id);
    f.state.rows.push({key:'codex:'+id,id,_dir:src,source:'codex',plugin:'',status:'live'});
  }f.state.enabled=true;
  f.ctx.fsp={...fsp,rename:async(...args)=>{const result=await fsp.rename(...args);
      if(args[1]===path.join(f.paths.skills,'one'))f.state.missing=true;
      return result;
    }};
  const result=await f.api.migrationCopySkills({keys:['codex:one','codex:two']});
  assert.equal(result.copied,1);
  assert.equal(result.results[0].id,'one');
  assert.equal(result.resultUnavailable,true);
  assert.equal(result.retry,false);
  assert.ok(fs.existsSync(path.join(f.paths.skills,'one','SKILL.md')));
  assert.equal(fs.existsSync(path.join(f.paths.skills,'two')),false);
});

test('migration constructor errors retain their work-data code through the real HTTP sendError helpers', async () => {
  const boot = source('00-boot.js'), config = source('01-config.js');
  const helpers = constBlock(boot, 'LEGACY_API_ERROR_CODES') + '\n'
    + ['normalizeApiErrorPayload', 'json', 'apiFailure'].map(name => functionBlock(boot, name)).join('\n')
    + '\n' + ['send', 'sendError'].map(name => functionBlock(config, name)).join('\n');
  const sendError = vm.runInNewContext(helpers + '\nsendError;');
  const f = fixture(), target = f.skill('api-errors');
  f.state.enabled = true;
  const wrongId = fixture(), wrongLog = wrongId.log();
  wrongId.state.enabled = true;
  fs.mkdirSync(path.join(wrongId.dir, 'migrations'));
  fs.writeFileSync(path.join(wrongId.dir, 'migrations', wrongLog.id + '.json'), JSON.stringify({ ...wrongLog, id: '2026-01-02T00-00-00-000Z' }));
  const sealed = fixture(), sealedLog = sealed.log();
  sealed.state.enabled = true;
  fs.mkdirSync(path.join(sealed.dir, 'migrations'));
  await sealed.api.writeMigrationLog(sealedLog);
  sealed.state.enabled = false;

  const cases = [
    ['work_data_store.binding', () => f.api.skillImportRecordStore(target, '../invalid')],
    ['work_data_store.validate', () => f.api.writeSkillImportRecord(target, { ...f.record, sourcePath: 'x'.repeat(20000) }, 'api-errors')],
    ['work_data_store.binding', () => f.api.migrationLogStore('../invalid')],
    ['work_data_store.validate', () => f.api.writeMigrationLog({ ...f.log(), files: {} })],
    ['work_data_store.validate', () => wrongId.api.migrationLogs()],
    ['work_data_store.downgrade_refused', () => sealed.api.migrationStoragePreflight(path.join(sealed.dir, 'migrations', sealedLog.id + '.json'))],
  ];
  for (const [code, trigger] of cases) {
    let thrown;
    try { await trigger(); } catch (error) { thrown = error; }
    assert.ok(thrown, code + ' must throw');
    const response = {
      writeHead(status) { this.status = status; },
      end(body) { this.body = JSON.parse(body); },
    };
    sendError(response, thrown);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, code);
  }
});
