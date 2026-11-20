'use strict';
// 151 阶段 3D(150 号文 W11):真实 Windows 冷启用(生产组合:WorkDataVerifierEntry → coldOperationHost →
// WorkDataColdOperations)里整根原生普查的次数。改前:旧明文根(第 0 代)的每个编解码行各做一次整根捕获 +
// 一次整根复核,密封快照做 1 次捕获 + 3 次复核;12 个会话的启用在 prepare-generation 阶段有 31 次普查。
// 改后:prepare 阶段只剩与行数无关的固定几次,快照阶段 1 次捕获 + 1 次复核;同时检查只为复核的普查
// 请求「只回哈希」(不回传内容)。只用本测试自建的合成根与隔离家目录;DPAPI 密钥只在夹具里新建。
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {releaseEnvironment}=require('../lib/release-checks');
// Bind the server under test (RUYI_TEST_SERVER_JS for reverse checks) before the environment is isolated.
const {loadServerInternals}=require('../lib/server-internals'),testServer=process.env.RUYI_TEST_SERVER_JS;
const win=process.platform==='win32';
const parent=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'ruyi-census-count-'));
after(()=>{assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,force:true});});

test('legacy enable: whole-root censuses do not scale with codec rows; seal verifies once; verify censuses are hash-only',{skip:!win,timeout:600000},async()=>{
 const base=path.join(root,'data'),home=path.join(root,'home'),backups=path.join(root,'backups');
 fs.mkdirSync(path.join(base,'sessions'),{recursive:true});fs.mkdirSync(backups);
 const env=releaseEnvironment(home,base);for(const key of Object.keys(process.env))if(!Object.hasOwn(env,key))delete process.env[key];Object.assign(process.env,env);
 fs.writeFileSync(path.join(base,'config.json'),'{"workDataEncryptionV1":false}');
 const SESSIONS=12;
 for(let i=0;i<SESSIONS;i++)fs.writeFileSync(path.join(base,'sessions','sess_count_'+i+'.json'),JSON.stringify({id:'sess_count_'+i,private:'CENSUS_COUNT_PRIVATE_'+i}));
 // Count every broker census (its paired first command) by the current phase, observing only the
 // command lines this process writes to its own native helpers (no product seam is replaced).
 const counts={},hashOnly={};let phase='start';
 const cp=require('node:child_process'),spawn=cp.spawn;
 cp.spawn=function(command,args,options){const child=spawn.apply(this,arguments);
  if(/powershell/i.test(String(command))&&Object.keys(options?.env||{}).some(key=>/^RUYI_SKILL_CAPSULE_/i.test(key))){const write=child.stdin.write;child.stdin.write=function(chunk){
   for(const line of String(chunk).split('\n')){if(!line)continue;let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.cmd==='capture-preserved-census-first'){counts[phase]=(counts[phase]||0)+1;if(value.content==='hash')hashOnly[phase]=(hashOnly[phase]||0)+1;}}
   return write.apply(this,arguments);};}
  return child;};
 after(()=>{cp.spawn=spawn;});
 const api=loadServerInternals(['WorkDataVerifierEntry','WorkDataColdOperations','WorkDataManifest','ServerOwnership','flushWorkbenchLogs']);
 const entry=testServer?path.resolve(testServer):path.resolve(__dirname,'..','..','ruyi-workbench','app','server.js');
 const native=api.WorkDataVerifierEntry.createVerifier({packaged:false,entry});
 const owner=await api.ServerOwnership.acquire([base]);
 try{
  const active=await api.WorkDataManifest.create({base}).readActive();
  const operation=api.WorkDataColdOperations.create(native.coldOperationHost(value=>{phase=value.phase;}));
  const result=await operation.execute({id:crypto.randomBytes(24).toString('hex'),base,operation:'enable',password:'synthetic census count password',ownership:owner,
   assertExclusive:value=>value===owner,expectedAuthority:{generation:active.generation,id:active.id,mode:active.mode,sha256:active.proof.sha256},
   paths:{backupDirectory:backups,targetDirectory:null,uploadFile:null,uploadSha256:null}});
  assert.equal(result.state,'published');
  const encrypted=await api.WorkDataManifest.create({base}).readActive();assert.equal(encrypted.mode,'encrypted');assert.equal(encrypted.generation,1);
  console.log('# censuses by phase',JSON.stringify(counts),'hash-only',JSON.stringify(hashOnly));
  assert.equal(counts.snapshot,2,'seal: one capture and one closing verification');
  assert.equal(hashOnly.snapshot,1,'the closing verification of the seal transfers hashes only');
  assert.ok(counts['prepare-generation']<=8,'prepare-generation censuses stay bounded independent of '+SESSIONS+' codec rows: '+counts['prepare-generation']);
  assert.ok((hashOnly['prepare-generation']||0)>=1,'the transform scope closes with a hash-only verification');
 }finally{
  await api.flushWorkbenchLogs({allowFailure:true});
  if(native.helperMayStillRun()===false)await owner.release();
 }
});
