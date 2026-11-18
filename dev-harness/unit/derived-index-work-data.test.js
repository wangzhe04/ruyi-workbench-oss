'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const repo=process.env.RUYI_DERIVED_INDEX_REPO||path.resolve(__dirname,'../..'),draft=process.env.RUYI_DERIVED_INDEX_SOURCE||path.join(repo,'ruyi-workbench/app/src');
const {loadWorkDataChunks}=require(path.join(repo,'dev-harness/lib/work-data-chunks-fixture'));
const {functionBlock,constBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const temp=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(temp,'ruyi-derived-test-'));after(()=>{assert.equal(path.dirname(root),temp);assert.ok(path.basename(root).startsWith('ruyi-derived-test-'));fs.rmSync(root,{recursive:true,force:true});});
const src=n=>fs.readFileSync(path.join(draft,n),'utf8'),boot=fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/00-boot.js'),'utf8');
const privateError=e=>String(e?.code||'').startsWith('work_data'),plain=v=>JSON.parse(JSON.stringify(v));
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'case-')),state={enabled:false,key:crypto.randomBytes(32),instance:'derived-index-unit',missing:false,acquires:0,releases:0,io:false,failWrite:false},disk={...fsp,stat:async(...a)=>{if(state.io)throw Object.assign(Error('denied'),{code:'EACCES'});return fsp.stat(...a);}};
 const fx=loadWorkDataChunks({fsp:disk});fx.store.Hooks.keys={snapshot:async()=>{if(state.missing)throw Object.assign(Error('missing'),{code:'work_data_key.absent'});state.acquires++;const key=Buffer.from(state.key);return {key,instanceId:state.instance,release:async()=>{if(state.releaseGate)await state.releaseGate;state.releases++;key.fill(0);if(state.releaseFailure)throw Error('release failed');}};},unlock:async()=>state.key,instance:async()=>state.instance};
 const records=vm.runInNewContext(constBlock(fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/01q-work-data-records.js'),'utf8'),'WorkDataRecords')+';WorkDataRecords',{WorkDataCrypto:fx.crypto,Buffer});
 const projectionFile=path.join(dir,'projection.json');
 const c=vm.createContext({require,Buffer,console,crypto,path,fs,fsp:disk,WorkDataStore:fx.store,WorkDataRecords:records,PRETENDER_INDEX_SCHEMA:8,pretenderIndexRuntime:{writers:0,counters:{persists:0},value:null},
 pretenderIndexPath:()=>projectionFile,sessionBodyPaths:id=>({messages:path.join(dir,id+'.ndjson')}),
 readConfig:async()=>{if(state.switchError)throw Error('unknown switch');return{workDataEncryptionV1:state.enabled};},nowIso:()=> 'fixed-time',
 atomicWriteJson:async(...a)=>{if(state.failWrite)throw Object.assign(Error('full'),{code:'ENOSPC'});return fx.atomicWriteJson(...a);},pretenderFileStamp:async file=>{try{const st=await fsp.stat(file);return st.size+':'+st.mtimeMs;}catch{return '-';}}});
 // 3.1 精简:13d 的旧会话搜索索引(读写、头尾分段读、加密正文行读取)零生产调用已删,只测它的用例随之退役;这里只剩投影索引(13e)。
 const p=src('13e-pretender-index.js');
 const projectionNames=['validatePretenderIndex','pretenderIndexStore','pretenderCheckIndexAuth','readPretenderIndexDisk','writePretenderIndexFileNow'];
 vm.runInContext(functionBlock(boot,'safeJsonParse')+'\n'+functionBlock(boot,'runKeyedChain')+'\n'+projectionNames.map(n=>functionBlock(p,n)).join('\n')+'\nglobalThis.api={'+projectionNames.join(',')+'};',c);
 return{state,fx,records,c,api:c.api,projectionFile};
}
test('projection OFF compact bytes and sealed ON roundtrip; warm key change clears value and rejects disk',async()=>{const f=fixture(),value={schemaVersion:8,sessions:[{sessionId:'s',revision:'r',card:{title:'private-projection'}}],sources:{s:'stamp'},usageStamp:'u'};assert.equal(await f.api.writePretenderIndexFileNow(value),true);assert.equal(fs.readFileSync(f.projectionFile,'utf8'),JSON.stringify(value));assert.equal(f.state.acquires,0);f.state.enabled=true;await f.api.pretenderCheckIndexAuth();await f.api.writePretenderIndexFileNow(value);const raw=fs.readFileSync(f.projectionFile,'utf8');assert.ok(!raw.includes('private-projection'));assert.deepEqual(plain(await f.api.readPretenderIndexDisk()),value);f.c.pretenderIndexRuntime.value=value;f.state.key=crypto.randomBytes(32);await f.api.pretenderCheckIndexAuth();assert.equal(f.c.pretenderIndexRuntime.value,null);await assert.rejects(()=>f.api.readPretenderIndexDisk(),privateError);assert.equal(fs.readFileSync(f.projectionFile,'utf8'),raw);});
test('projection missing key fails on every warm attempt and OFF save does not downgrade ciphertext',async()=>{const f=fixture(),value={schemaVersion:8,sessions:[],sources:{},usageStamp:'u'};f.state.enabled=true;await f.api.pretenderCheckIndexAuth();await f.api.writePretenderIndexFileNow(value);const raw=fs.readFileSync(f.projectionFile,'utf8');f.state.missing=true;await assert.rejects(()=>f.api.pretenderCheckIndexAuth(),privateError);await assert.rejects(()=>f.api.readPretenderIndexDisk(),privateError);f.state.missing=false;f.state.enabled=false;assert.equal(await f.api.writePretenderIndexFileNow({...value,builtAt:'new'}),false);assert.equal(fs.readFileSync(f.projectionFile,'utf8'),raw);});

test('warming ordinary plaintext while ON never makes OFF require a missing key',async()=>{
 const f=fixture(),projection={schemaVersion:8,sessions:[],sources:{},usageStamp:'u'};
 fs.writeFileSync(f.projectionFile,JSON.stringify(projection));f.state.enabled=true;
 await f.api.pretenderCheckIndexAuth();assert.deepEqual(plain(await f.api.readPretenderIndexDisk()),projection);f.c.pretenderIndexRuntime.value=projection;
 f.state.enabled=false;f.state.missing=true;const before=f.state.acquires;
 await f.api.pretenderCheckIndexAuth();assert.deepEqual(plain(await f.api.readPretenderIndexDisk()),projection);assert.equal(f.state.acquires,before);
});

test('short authority reads await asynchronous source cleanup before resolving',async()=>{
 const f=fixture();let settled=false;
 f.state.enabled=true;let releaseProjection;f.state.releaseGate=new Promise(resolve=>{releaseProjection=resolve;});
 const checking=f.api.pretenderCheckIndexAuth().then(()=>{settled=true;});await new Promise(setImmediate);assert.equal(settled,false);releaseProjection();await checking;assert.equal(f.state.releases,1);
});
