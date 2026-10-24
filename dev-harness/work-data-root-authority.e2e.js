'use strict';
// Actual generated serve/CLI processes and native manifest/key preparation.
// Synthetic distinct generations test boot routing, not complete user migration.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict');
const at=process.argv.indexOf('--harness-root'),harness=at<0?__dirname:path.resolve(process.argv[at+1]);
require(path.join(harness,'lib/self-isolate-home'));
const {releaseEnvironment}=require(path.join(harness,'lib/release-checks'));
const {killOwnTree}=require(path.join(harness,'lib/kill-own-tree'));
const {getFreePort}=require(path.join(harness,'free-port'));
const t=require(path.join(harness,'lib/harness')).createRunner('WORK DATA ROOT AUTHORITY');
const temp=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(temp,'ruyi-root-authority-e2e-'));
const base=path.join(root,'base'),home=path.join(root,'home'),children=new Set(),leases=[];
const env=releaseEnvironment(home,base);
for(const key of Object.keys(process.env))if(!Object.hasOwn(env,key))delete process.env[key];Object.assign(process.env,env);
const {loadServerInternals}=require(path.join(harness,'lib/server-internals'));
const api=loadServerInternals(['WorkDataManifest','WorkDataKeys','LocalSecretCrypto','ServerOwnership','atomicWriteJson','CONFIG_SCHEMA','WorkDataRootHooks']);
const server=path.resolve(harness,'../ruyi-workbench/app/server.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const norm=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const request=async(record,route,body)=>{
 const response=await fetch('http://127.0.0.1:'+record.port+route,{method:body===undefined?'GET':'POST',headers:{'x-wcw-token':record.token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 return{status:response.status,value:await response.json()};
};
function spawn(data,command,port){
 const child=cp.spawn(process.execPath,[server,command,...(port===undefined?[]:['--port',String(port)])],{cwd:path.dirname(server),env:releaseEnvironment(home,data),windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{child.output=(child.output+chunk).slice(-16000);});
 children.add(child);child.closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{children.delete(child);resolve(code);});});return child;
}
async function stop(child){if(child&&child.exitCode===null)killOwnTree(child);if(child)await child.closed;}
async function ready(child,data){
 const end=Date.now()+20000;
 while(Date.now()<end){
  if(child.exitCode!==null)throw Error('serve_exited');
  let record;try{record=JSON.parse(fs.readFileSync(path.join(data,'runtime.json'),'utf8'));}catch{}
  if(record?.pid===child.pid){try{if((await request(record,'/health')).value.ok)return record;}catch{}}
  await sleep(50);
 }throw Error('serve_timeout');
}
async function exited(child){return Promise.race([child.closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('exit_timeout')),20000);timer.unref();})]);}
const config=flag=>({configSchema:api.CONFIG_SCHEMA,workDataEncryptionV1:flag,permissionMode:'bypass',stewardEnabledV1:false,schedulerEnabledV1:false,autoImportClaudeCodeMcp:false,includeWorkbenchMcp:false,enableMcpDropIn:false,desktopMcp:{enabled:false,autodetect:false},externalMcpServers:[],providers:[],defaultWorkspace:root});
async function createSession(record,title){const result=await request(record,'/api/sessions',{cwd:root,title});assert.equal(result.status,200);assert.ok(result.value.session?.id);return result.value.session.id;}
function bytesIn(directory){const out=[];for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const full=path.join(directory,entry.name);out.push([entry.name,entry.isDirectory()?bytesIn(full):fs.readFileSync(full).toString('base64')]);}return out;}
(async()=>{
 try{
  if(process.platform!=='win32'){console.log('SKIP actual Windows authority boot');return;}
  fs.mkdirSync(base);fs.mkdirSync(path.join(base,'sessions'));fs.writeFileSync(path.join(base,'sessions','source-marker.txt'),'UNCHANGED-LEGACY-SOURCE');
  const sourceConfig=JSON.stringify(config(false));fs.writeFileSync(path.join(base,'config.json'),sourceConfig);
  const authority=api.WorkDataManifest.create({base}),initial=await authority.readActive();
  const owner=await api.ServerOwnership.acquire([base]);let encrypted;
  try{
   encrypted=await authority.prepare({expected:initial,mode:'encrypted'});
   await api.atomicWriteJson(path.join(encrypted.root,'config.json'),config(false));
   const keys=api.WorkDataKeys.create({store:{read:async()=>{throw Error('unexpected_key_read');},write:async()=>{throw Error('unexpected_key_write');}},enabled:()=>false,protector:api.LocalSecretCrypto});
   const staged=await keys.stageNew();leases.push(staged.lease);await api.atomicWriteJson(path.join(encrypted.root,'work-data-key-v1.json'),staged.header);
   await authority.commit({expected:initial,candidate:encrypted});
  }finally{await owner.release();}
  const first=spawn(base,'serve',await getFreePort()),record=await ready(first,base);
  const status=await request(record,'/api/status');assert.equal(status.status,200);assert.equal(status.value.config.workDataEncryptionV1,true);
  assert.equal(norm(status.value.dataRoot),norm(encrypted.root));assert.equal(fs.existsSync(path.join(encrypted.root,'runtime.json')),false);
  assert.equal(fs.readFileSync(path.join(base,'config.json'),'utf8'),sourceConfig);
  t.ok(true,'A1 fresh serve owns the stable base and resolves encrypted generation before config recovery; runtime discovery stays at base');

  const one=await createSession(record,'PRIVATE-ROOT-ENCRYPTED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(encrypted.root,'sessions',one+'.json'),'utf8')).workData,2);
  assert.equal(fs.existsSync(path.join(base,'sessions',one+'.json')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(encrypted.root,'config.json'),'utf8')).workDataEncryptionV1,true);
  t.ok(true,'A2 a stale false config mirror cannot downgrade manifest mode; real HTTP session writes seal only inside selected generation');

  const duplicate=spawn(base,'serve',await getFreePort()),doctorBusy=spawn(base,'doctor');
  assert.equal(await exited(duplicate),1);assert.equal(await exited(doctorBusy),1);assert.equal(first.exitCode,null);
  assert.equal(fs.existsSync(path.join(base,'last-start-error.json')),false);
  assert.equal(fs.readFileSync(path.join(base,'sessions','source-marker.txt'),'utf8'),'UNCHANGED-LEGACY-SOURCE');
  t.ok(true,'A3 duplicate serve and recovery-capable one-shot CLI refuse the same owned base before touching startup or source files');

  fs.writeFileSync(path.join(encrypted.root,'config.json'),'{broken config');
  const two=await createSession(record,'PRIVATE-ROOT-RECOVERED-CONFIG');
  assert.equal(JSON.parse(fs.readFileSync(path.join(encrypted.root,'sessions',two+'.json'),'utf8')).workData,2);
  assert.equal(fs.readFileSync(path.join(base,'config.json'),'utf8'),sourceConfig);
  t.ok(true,'B1 real configuration recovery preserves encrypted manifest mode and never writes plaintext into the legacy source');
  await stop(first);

  const encryptedBefore=bytesIn(encrypted.root),selected=await authority.readActive(),nextOwner=await api.ServerOwnership.acquire([base]);let plain;
  try{plain=await authority.prepare({expected:selected,mode:'plain'});await api.atomicWriteJson(path.join(plain.root,'config.json'),config(true));await authority.commit({expected:selected,candidate:plain});}finally{await nextOwner.release();}
  const second=spawn(base,'serve',await getFreePort()),nextRecord=await ready(second,base),nextStatus=await request(nextRecord,'/api/status');
  assert.equal(nextStatus.value.config.workDataEncryptionV1,false);assert.equal(norm(nextStatus.value.dataRoot),norm(plain.root));
  const three=await createSession(nextRecord,'PLAIN-SELECTED-GENERATION');const raw=fs.readFileSync(path.join(plain.root,'sessions',three+'.json'),'utf8');
  assert.equal(JSON.parse(raw).workData,undefined);assert.ok(raw.includes('PLAIN-SELECTED-GENERATION'));assert.equal(fs.existsSync(path.join(plain.root,'work-data-key-v1.json')),false);
  assert.deepEqual(bytesIn(encrypted.root),encryptedBefore);
  t.ok(true,'B2 a fresh plain generation overrides stale true mirror, creates no master and leaves the retained encrypted generation byte-identical');
  await stop(second);

  const doctor=spawn(base,'doctor');assert.equal(await exited(doctor),0);let diagnosis;
  try{diagnosis=JSON.parse(doctor.output.trim());}catch{throw Error('doctor_not_json');}
  assert.equal(norm(diagnosis.dataRoot),norm(plain.root));assert.equal(fs.readFileSync(path.join(base,'config.json'),'utf8'),sourceConfig);
  t.ok(true,'C1 after serve exits the one-shot doctor acquires the same base and diagnoses the selected generation');

  const broken=path.join(root,'bad-manifest');fs.mkdirSync(path.join(broken,'.work-data'),{recursive:true});fs.writeFileSync(path.join(broken,'config.json'),sourceConfig);fs.writeFileSync(path.join(broken,'.work-data','active-v1.json'),'{bad authority');
  const before=bytesIn(broken),bad=spawn(broken,'serve',await getFreePort());assert.equal(await exited(bad),1);assert.deepEqual(bytesIn(broken),before);
  assert.equal(fs.existsSync(path.join(broken,'sessions')),false);assert.equal(fs.existsSync(path.join(broken,'last-start-error.json')),false);
  t.ok(true,'C2 malformed authority refuses before ensureDirs, configuration recovery and startup-error writes, preserving every fixture byte');
 }catch(error){t.fail(error?.stack||String(error));}
 finally{for(const child of [...children])await stop(child);for(const lease of leases)lease.release();assert.equal(path.dirname(root),temp);assert.ok(path.basename(root).startsWith('ruyi-root-authority-e2e-'));if(!t.failures)fs.rmSync(root,{recursive:true,force:true});else console.log('[keep] '+root);t.done();}
})();
