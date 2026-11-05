'use strict';
// ROOT SERIAL ONLY: generated runtime, actual Windows DPAPI, NTFS publication,
// directory flush, native census and OS-held ownership. No real user data.
const path=require('node:path');
require('./lib/self-isolate-home');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {releaseEnvironment}=require('./lib/release-checks');
const runner=require('./lib/harness').createRunner('WORK DATA COLD OPERATIONS');
const names=['WorkDataColdOperations','WorkDataFullSnapshot','WorkDataNativeAdapters','WorkDataMaintenanceResult','WorkDataManifest','WorkDataMigrationHost','WorkDataNativePublish','WorkDataDisposableNativeTree','ServerOwnership','LocalSecretCrypto','ExternalBotCredentials','MigrationHooks','migrationCapsuleCapturePreserved','WorkDataKeys','WorkDataStore','flushWorkbenchLogs','paths'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function isolate(home,data){const env=releaseEnvironment(home,data);for(const key of Object.keys(process.env))if(!Object.hasOwn(env,key))delete process.env[key];Object.assign(process.env,env);}
const load=()=>require('./lib/server-internals').loadServerInternals(names);
function snapshot(api,base,ownership){return api.WorkDataFullSnapshot.create({base,ownership,assertExclusive:owner=>owner===ownership,protector:api.LocalSecretCrypto,externalOwner:options=>api.ExternalBotCredentials.create(options),skillBackupOwner:options=>api.MigrationHooks.createBackupOwner(options),maintenanceResultOwner:api.WorkDataMaintenanceResult});}
async function cold(input){
 isolate(input.home,input.target);const api=load(),owner=await api.ServerOwnership.acquire([input.target]);
 try{await snapshot(api,input.target,owner).seal({password:input.password,appVersion:'3.0.1',generation:input.generation});console.log('COLD FULL SNAPSHOT VERIFIED');}
 finally{await api.flushWorkbenchLogs({allowFailure:true});await owner.release();}
}
(async()=>{
 if(process.platform!=='win32'){console.log('SKIP Windows DPAPI/NTFS cold operations');return;}
 if(process.argv.includes('--cold')){await cold(JSON.parse(fs.readFileSync(0,'utf8')));return;}
 const parent=path.resolve(os.tmpdir()),root=await fsp.mkdtemp(path.join(parent,'ruyi-cold-operations-native-')),base=path.join(root,'data'),home=path.join(root,'home'),backupDirectory=path.join(root,'backups');
 await fsp.mkdir(path.join(base,'sessions'),{recursive:true});await fsp.mkdir(backupDirectory);isolate(home,base);
 let owner,api,native,passed=false,helperUncertain=false;
 const uncertain=()=>helperUncertain||native?.helperMayStillRun()===true||!!api&&api.MigrationHooks.helperMayStillRun()!==false;
 try{
  api=load();await fsp.writeFile(path.join(base,'config.json'),'{"workDataEncryptionV1":false}');
  const original='{"id":"sess_native","private":"NATIVE_COLD_OPERATION_PRIVATE"}';await fsp.writeFile(path.join(base,'sessions/sess_native.json'),original);
  const attachment='COLD ATTACHMENT RAW',attachmentBytes=Buffer.from(attachment);
  await fsp.mkdir(path.join(base,'uploads','file_0123456789abcdef'),{recursive:true});await fsp.writeFile(path.join(base,'uploads','file_0123456789abcdef','a.bin'),attachmentBytes);
  await fsp.mkdir(path.join(base,'uploads','toolimg_tag_abc'),{recursive:true});await fsp.writeFile(path.join(base,'uploads','toolimg_tag_abc','shot.png'),Buffer.from('COLD TOOL IMAGE RAW'));
  owner=await api.ServerOwnership.acquire([base]);const password='owned synthetic native password only',flush=api.WorkDataNativePublish.createFlush();
  const guard=async work=>{try{return await work();}catch(error){if(error?.helperMayStillRun===true)helperUncertain=true;throw error;}};
  const disposable=api.WorkDataDisposableNativeTree.create({capturePreserved:(...args)=>guard(()=>api.migrationCapsuleCapturePreserved(...args))});
  native=api.WorkDataNativeAdapters.create();const snapshotHost=native.coldOperationHost(()=>{});
  const host={acquire:roots=>api.ServerOwnership.acquire(roots),flush:dirs=>guard(()=>flush(dirs)),helperMayStillRun:()=>helperUncertain||native.helperMayStillRun(),
   fullSnapshot:(...args)=>snapshotHost.fullSnapshot(...args),
   captureRehearsal:(...args)=>snapshotHost.captureRehearsal(...args),
   verifyDisposableNativeTree:value=>guard(()=>disposable(value)),migrationFactory:options=>snapshotHost.migrationFactory(options),progress:()=>{},
   async verifyFresh(value){const child=cp.spawnSync(process.execPath,[__filename,'--cold'],{env:releaseEnvironment(path.join(root,'cold-home'),value.target),input:JSON.stringify({home:path.join(root,'cold-home'),target:value.target,password:value.password,generation:value.generation??(await api.WorkDataManifest.create({base:value.target}).readActive()).generation}),encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(child.status,0,child.stderr+'\n'+child.stdout);assert.match(child.stdout,/COLD FULL SNAPSHOT VERIFIED/);return true;},
  };
  const operation=api.WorkDataColdOperations.create(host);
  const execute=async kind=>{const active=await api.WorkDataManifest.create({base}).readActive();return guard(()=>operation.execute({id:crypto.randomBytes(24).toString('hex'),base,operation:kind,password,ownership:owner,assertExclusive:value=>value===owner,expectedAuthority:{generation:active.generation,id:active.id,mode:active.mode,sha256:active.proof.sha256},paths:{backupDirectory,targetDirectory:null,uploadFile:null,uploadSha256:null}}));};
  const enabled=await execute('enable');assert.equal(enabled.state,'published');const encrypted=await api.WorkDataManifest.create({base}).readActive();assert.equal(encrypted.mode,'encrypted');assert.equal(encrypted.generation,1);assert.equal((await fsp.readFile(path.join(encrypted.root,'sessions/sess_native.json'),'utf8')).includes('NATIVE_COLD_OPERATION_PRIVATE'),false);assert.equal(await fsp.readFile(path.join(base,'sessions/sess_native.json'),'utf8'),original);runner.ok(true,'actual native enable publishes encrypted generation and preserves original source');
  const sealedUploads=fs.readdirSync(path.join(encrypted.root,'uploads'));
  assert.equal(sealedUploads.some(name=>name.startsWith('file_')||name.startsWith('toolimg_')),false);
  assert.equal(sealedUploads.filter(name=>/^[a-f0-9]{32}$/i.test(name)).length,2);
  assert.equal(fs.existsSync(path.join(encrypted.root,'uploads/_catalog-attachments-v1.json')),true);
  assert.equal(fs.existsSync(path.join(encrypted.root,'uploads/_catalog-tool-images-v1.json')),true);
  for(const opaque of sealedUploads.filter(name=>/^[a-f0-9]{32}$/i.test(name)))for(const revision of fs.readdirSync(path.join(encrypted.root,'uploads',opaque)))for(const name of fs.readdirSync(path.join(encrypted.root,'uploads',opaque,revision))){const bytes=await fsp.readFile(path.join(encrypted.root,'uploads',opaque,revision,name));assert.equal(bytes.includes(attachmentBytes),false);assert.equal(bytes.includes(Buffer.from('COLD TOOL IMAGE RAW')),false);}
  runner.ok(true,'enable seals both upload faces without plaintext in the encrypted generation');
  const exported=await execute('export');assert.equal(exported.state,'verified');assert.equal(hash(await fsp.readFile(exported.backup.path)),exported.backup.sha256);runner.ok(true,'after-enable full export survives real native portable restore and independent cold process verification');
  const disabled=await execute('disable');assert.equal(disabled.state,'published');const plain=await api.WorkDataManifest.create({base}).readActive();assert.equal(plain.generation,2);assert.equal(plain.mode,'plain');assert.equal(await fsp.readFile(path.join(plain.root,'sessions/sess_native.json'),'utf8'),original);runner.ok(true,'actual reverse migration publishes complete plain generation');
  assert.equal(await fsp.readFile(path.join(plain.root,'uploads/file_0123456789abcdef/a.bin'),'utf8'),attachment);
  assert.equal(await fsp.readFile(path.join(plain.root,'uploads/toolimg_tag_abc/shot.png'),'utf8'),'COLD TOOL IMAGE RAW');
  assert.deepEqual(fs.readdirSync(path.join(plain.root,'uploads')).filter(name=>/^[a-f0-9]{32}$/i.test(name)),[]);
  assert.equal(fs.existsSync(path.join(plain.root,'uploads/_catalog-attachments-v1.json')),false);
  runner.ok(true,'disable unseals both upload faces back to the plain generation');
  const second=await execute('export');assert.equal(second.state,'verified');assert.equal(hash(await fsp.readFile(second.backup.path)),second.backup.sha256);assert.equal(fs.existsSync(path.join(base,'.work-data/maintenance-v1.json')),false);runner.ok(true,'second full export and durable result retain all generations without pending intent');passed=true;
 }finally{
  if(api)await api.flushWorkbenchLogs({allowFailure:true});if(owner&&!uncertain())await owner.release();
  if(passed&&!uncertain()){assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('ruyi-cold-operations-native-'));await fsp.rm(root,{recursive:true,force:true});assert.equal(uncertain(),false);}else {const late=passed;passed=false;console.error('Retained owned native operation fixture '+root);if(late)throw Object.assign(Error('cold_operations.owner_uncertain'),{code:'cold_operations.owner_uncertain',helperMayStillRun:true});}
 }
})().catch(error=>runner.fail(error.stack||String(error))).finally(()=>runner.done({exit:true}));
