'use strict';
// Full ordinary default-stream snapshot, real CurrentUser DPAPI and a fresh Node
// verifier. The opt-in capsule cases exercise the native owner gate, including
// the production cold export rehearsal under --capsule-export.
require('./lib/self-isolate-home');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {once}=require('node:events');
const {releaseEnvironment}=require('./lib/release-checks'),{killOwnTree}=require('./lib/kill-own-tree');
const {createRunner}=require('./lib/harness');
const temporaryParent=fs.realpathSync(os.tmpdir());
const childMode=['--verify','--verify-capsule','--seed-media'].includes(process.argv[2]);
const root=childMode?null:fs.mkdtempSync(path.join(temporaryParent,'ruyi-full-snapshot-native-'));
if(root){const isolated=releaseEnvironment(path.join(root,'home'),path.join(root,'source'));for(const key of Object.keys(process.env))if(!Object.hasOwn(isolated,key))delete process.env[key];Object.assign(process.env,isolated);}
const {loadServerInternals}=require('./lib/server-internals');
const api=loadServerInternals(['WorkDataKeys','WorkDataStore','WorkDataRecovery','WorkDataFullSnapshot','ServerOwnership','LocalSecretCrypto','ExternalBotCredentials','CredentialVault','PrivacyCore','atomicWriteJson','VERSION','WorkDataNativeAdapters','WorkDataColdOperations','WorkDataVerifierEntry','MigrationHooks','migrationCopySkills','migrationLogs','migrationCapsuleRead','migrationCapsuleDescriptor','migrationCapsuleCapturePreserved','migrationUndoSkillCopy','readConfig','writeConfig','workDataKeys','flushWorkbenchLogs',
  'MediaDerivedStore','MediaImageService','WorkDataMigrationCodecs']);
const password='synthetic native fullsnapshot password only',leases=[],owners=new Set(),keys=[],vaults=[];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function acquire(base){const owner=await api.ServerOwnership.acquire([base]);owners.add(owner);return owner;}
async function release(owner){owners.delete(owner);await owner.release();}
const exclusive=owner=>owners.has(owner);
const snapshot=(base,owner)=>api.WorkDataFullSnapshot.create({base,ownership:owner,assertExclusive:exclusive,
 protector:api.LocalSecretCrypto,externalOwner:options=>api.ExternalBotCredentials.create(options)});
async function keysAt(base,create){
 const file=path.join(base,'work-data-key-v1.json');
 const k=api.WorkDataKeys.create({protector:api.LocalSecretCrypto,enabled:()=>false,store:{read:async()=>JSON.parse(await fsp.readFile(file,'utf8'))}});keys.push(k);
 if(create){const staged=await k.stageNew();leases.push(staged.lease);await fsp.mkdir(base,{recursive:true});await fsp.writeFile(file,JSON.stringify(staged.header));}
 return k;
}
function vaultAt(base){const file=path.join(base,'credential-vault-v1.json');const v=api.CredentialVault.create({core:api.PrivacyCore,protector:api.LocalSecretCrypto,
 size:async()=>{try{return(await fsp.stat(file)).size;}catch(e){if(e.code==='ENOENT')return 0;throw e;}},store:{
  read:async()=>{try{return JSON.parse(await fsp.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return api.CredentialVault.empty();throw e;}},
  write:value=>api.atomicWriteJson(file,value),invalidate(){}}});vaults.push(v);return v;}
const head=(base,k,id)=>api.WorkDataStore.createText({file:()=>path.join(base,'sessions',id+'.json'),purpose:'session',schema:2,
 scopeId:'sessions',recordId:id,keys:k,enabled:()=>true,writeJson:api.atomicWriteJson});
const mediaSession='sess_native_media', mediaScope=digest(mediaSession).slice(0,32);
const mediaDirectory=base=>path.join(base,'media-derived-v1',mediaScope);
const mediaRelative=id=>'media-derived-v1/'+mediaScope+'/'+id+'.json';
const mediaStore=(base,key,authority)=>api.MediaDerivedStore.create({root:mediaDirectory(base),scopeId:mediaScope,
 keys:key,enabled:()=>true,writeJson:api.atomicWriteJson,authority});
const mediaCodec=(sourceRoot,targetRoot,sourceKeys,targetKeys)=>api.WorkDataMigrationCodecs.create({
 sourceRoot,targetRoot,sourceKeys,targetKeys,writeJson:api.atomicWriteJson,
});
const mediaRecipient='f'.repeat(64);
const mediaBody=reference=>({messages:[{role:'user',content:[{type:'image_url',image_url:{url:reference}}]}]});
async function seedProtectedMedia(){
 const base=process.env.RUYI_HOME,fixtureRoot=path.dirname(base);
 assert.equal(path.basename(base),'source');
 assert.match(path.basename(fixtureRoot),/^ruyi-full-snapshot-native-[A-Za-z0-9]{6}$/);
 assert.equal(process.env.HOME,path.join(fixtureRoot,'seed-media-home'));
 assert.equal(await fsp.realpath(base),base);
 assert.deepEqual(await fsp.readdir(base),[]);
 await acquire(base);
 // Only the source and decoder observations are synthetic. The actual service
 // issues the capability and publishes the real DPAPI-backed record.
 try{
  const key=await keysAt(base,true);
  const {sourceOwner,policyOwner,processorOwner}=require('./lib/media-image-contract-fixture').fixture();
  const captured=sourceOwner.capture(),policy=policyOwner.capture();
  const source={id:'file_media_lifecycle',name:'synthetic.png',snapshot:{...captured,scope:mediaScope},
   assert:()=>sourceOwner.assert(captured),release:()=>captured.bytes.fill(0)};
  await fsp.mkdir(mediaDirectory(base),{recursive:true});
  const service=api.MediaImageService.create({context:()=>({scopeId:mediaSession}),
   storeFor:async({scopeId,authority})=>{assert.equal(scopeId,mediaScope);return mediaStore(base,key,authority);}});
  const issued=await service.prepare({sessionId:mediaSession,source,policy:{...policy,assert:()=>policyOwner.assert(policy)},
   processor:processorOwner,recipient:mediaRecipient});
  const [filename,...others]=await fsp.readdir(mediaDirectory(base));
  assert.equal(others.length,0);
  assert.match(filename,/^mimg_[a-f0-9]{32}\.json$/);
  const relative=mediaRelative(filename.slice(0,-'.json'.length)),ciphertext=await fsp.readFile(path.join(mediaDirectory(base),filename));
  const preview=await service.borrow(issued.id);
  try{
   preview.assert();
   assert.equal(digest(preview.bytes),issued.manifest.payloadHash);
   const pngBase64=preview.bytes.toString('base64');
   assert.ok(!ciphertext.includes(pngBase64)&&!ciphertext.includes(source.id));
   const delivery=await service.delivery(mediaBody(issued.reference),mediaRecipient);
   try{
    delivery.assert();
    assert.deepEqual(delivery.body,mediaBody('data:image/png;base64,'+pngBase64));
   }finally{delivery.release();}
  }finally{preview.release();}
  const proof=await mediaCodec(base,path.join(path.dirname(base),'unused-media-output'),key).verify({relative,targetMode:'encrypted'});
  assert.equal(proof.family,'media-derived');
  assert.equal(proof.physicalHash,digest(ciphertext));
  // Leave the cache file as a restart remnant. The issuing process exits and
  // the capability itself is never serialized as live state.
  console.log(JSON.stringify({relative,referenceId:issued.id,physicalHash:proof.physicalHash,logicalHash:proof.logicalHash}));
 }finally{await clear();}
}
async function verifyColdMedia(base,key,referenceId){
 assert.match(referenceId,/^[a-f0-9]{32}$/);
 const [filename,...others]=await fsp.readdir(mediaDirectory(base));
 assert.equal(others.length,0);
 assert.match(filename,/^mimg_[a-f0-9]{32}\.json$/);
 const id=filename.slice(0,-'.json'.length),relative=mediaRelative(id);
 const codec=mediaCodec(base,path.join(path.dirname(base),'unused-cold-media-output'),key);
 const proof=await codec.verify({relative,targetMode:'encrypted'});
 const store=mediaStore(base,key,{capture:async()=>{throw Error('no live source authority');},assert:()=>false});
 await assert.rejects(store.read(id),{message:'no live source authority'});
 await assert.rejects(store.remove(id),{code:'media_store.unowned_remove'});
 const cold=api.MediaImageService.create({context:()=>({scopeId:mediaSession}),
  storeFor:async()=>assert.fail('stale media reference must not open a store')});
 await assert.rejects(cold.borrow(referenceId),{code:'privacy.image_expired'});
 await assert.rejects(cold.delivery(mediaBody('https://ruyi.invalid/protected-image/'+referenceId),mediaRecipient),{code:'privacy.image_expired'});
 assert.equal(digest(await fsp.readFile(path.join(mediaDirectory(base),filename))),proof.physicalHash);
 return proof.logicalHash;
}
const connection={id:'bot_snapshot',platform:'qq',appId:'synthetic_app',tenantId:'synthetic_tenant',botUserId:'',enabled:false};
async function clear(){for(const l of leases)l.release();for(const k of keys)k.clear();for(const v of vaults)v.clear();for(const owner of [...owners])await release(owner);}
async function runMediaSnapshotProcess(base,mode,...args){
 const env=releaseEnvironment(path.join(root,mode.slice(2)+'-home'),base);
 const child=cp.spawn(process.execPath,[__filename,mode,...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='',stderr='',timedOut=false;
 child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>stderr+=part);
 const timer=setTimeout(()=>{timedOut=true;killOwnTree(child);},45000);
 try{
  const [code,signal]=await once(child,'close');
  assert.equal(timedOut,false,mode+' timed out');
  assert.equal(signal,null);assert.equal(code,0,stderr);
  return JSON.parse(output);
 }finally{clearTimeout(timer);}
}
async function verifyCold(){
 const base=process.env.RUYI_HOME,owner=await acquire(base);
 try{
  const primary=await keysAt(base,false);assert.equal(await head(base,primary,'sess_native').read(),'{"id":"sess_native","private":"NATIVE_FULL_PRIVATE"}');
  const v=vaultAt(base),old=await v.hydrateConfig(JSON.parse((await fsp.readFile(path.join(base,'config.json.prev'),'utf8')).replace(/^\uFEFF/,'')));
  assert.equal(old.raw.providers[0].apiKey,'NATIVE_CREDENTIAL_OLD');
  assert.equal((await api.ExternalBotCredentials.create({root:base}).read(connection)).botSecret,'NATIVE_BOT_SECRET');
  const mediaLogicalHash=await verifyColdMedia(base,primary,process.argv[3]);
  const shot=await snapshot(base,owner).seal({password,appVersion:api.VERSION,generation:0});
  process.stdout.write(JSON.stringify({ok:true,keyIds:shot.keyIds.length,files:shot.files,mediaLogicalHash}));
 }finally{await clear();}
}
async function main(){
 const t=createRunner('WORK DATA FULL SNAPSHOT');
 if(process.platform!=='win32'){console.log('SKIP Windows DPAPI fullsnapshot integration');return;}
 const base=process.env.RUYI_HOME;
 try{
  await fsp.mkdir(base);
  const derived=await runMediaSnapshotProcess(base,'--seed-media');
  const owner=await acquire(base),k=await keysAt(base,false);
  const mediaFile=path.join(base,...derived.relative.split('/')),mediaCiphertext=await fsp.readFile(mediaFile);
  assert.equal(digest(mediaCiphertext),derived.physicalHash);
  t.ok(true,'producer issues live preview and delivery for exact protected PNG and seals the record under a real DPAPI-owned key');
  await fsp.mkdir(path.join(base,'sessions'));await head(base,k,'sess_native').write('{"id":"sess_native","private":"NATIVE_FULL_PRIVATE"}');
  const v=vaultAt(base),cfg=secret=>JSON.stringify({credentialEncryptionV1:true,workDataEncryptionV1:true,providers:[{id:'synthetic',baseUrl:'https://fixture.invalid',apiKey:secret}]});
  await fsp.writeFile(path.join(base,'config.json.prev'),'\uFEFF'+await v.protectConfig(cfg('NATIVE_CREDENTIAL_OLD')));
  await fsp.writeFile(path.join(base,'config.json'),await v.protectConfig(cfg('NATIVE_CREDENTIAL_CURRENT')));
  const bot=api.ExternalBotCredentials.create({root:base});await bot.save(connection,{set:{botSecret:'NATIVE_BOT_SECRET'},remove:[],expectedRevision:(await bot.inspect(connection)).credentialRevision});
  const botBytes=await fsp.readFile(path.join(base,'external-bot-credentials.json'));await fsp.writeFile(path.join(base,'external-bot-credentials.json.prev'),botBytes);
  const retained=path.join(base,'.work-data','generations','c'.repeat(48)),retainedKeys=await keysAt(retained,true);
  await fsp.mkdir(path.join(retained,'sessions'));await head(retained,retainedKeys,'sess_retained').write('{"id":"sess_retained","private":"RETAINED_NATIVE_PRIVATE"}');
  const media=Buffer.from([0,255,128,1,2,0]);await fsp.mkdir(path.join(base,'uploads','empty'),{recursive:true});await fsp.writeFile(path.join(base,'uploads','media.bin'),media);
  const captured=await snapshot(base,owner).seal({password,appVersion:api.VERSION,generation:0});
  assert.equal(captured.keyIds.length,3);for(const secret of ['NATIVE_FULL_PRIVATE','NATIVE_CREDENTIAL_OLD','NATIVE_BOT_SECRET'])assert.equal(captured.serialized.includes(secret),false);
  t.ok(true,'real DPAPI owners seal complete ordinary bytes, retained independent master and historical credentials/auxiliary sources');
  const opened=await api.WorkDataRecovery.open(captured.serialized,password);
  try{assert.equal(opened.snapshot.auxiliaries.length,2);assert.deepEqual(opened.snapshot.files.find(f=>f.path==='uploads/media.bin').data,media);assert.ok(opened.snapshot.directories.includes('uploads/empty'));
   assert.equal(opened.snapshot.files.find(f=>f.path==='config.json.prev').keyRefs.length,1,'BOM historical config retains its actual credential reference closure');
   const record=opened.snapshot.files.find(f=>f.path===derived.relative);
   assert.equal(record.keyRefs.length,1);assert.deepEqual(record.data,mediaCiphertext);
  }finally{opened.release();}
  t.ok(true,'whole authenticated manifest includes raw non41 media, empty directories and mandatory direct-DPAPI history');
  const wrong=path.join(root,'wrong'),wrongOwner=await acquire(wrong);
  try{await assert.rejects(snapshot(base,owner).restore({serialized:captured.serialized,password:password+'bad',target:wrong,targetOwnership:wrongOwner}));assert.equal(fs.existsSync(wrong),false);}finally{await release(wrongOwner);}
  t.ok(true,'wrong password with actual destination OS owner leaves the fresh target absent');
  const target=path.join(root,'restored'),targetOwner=await acquire(target);let restored;
  try{restored=await snapshot(base,owner).restore({serialized:captured.serialized,password,target,targetOwnership:targetOwner});}finally{await release(targetOwner);}
  assert.deepEqual(await fsp.readFile(path.join(target,'uploads','media.bin')),media);assert.ok((await fsp.stat(path.join(target,'uploads','empty'))).isDirectory());
  assert.deepEqual(await fsp.readFile(path.join(target,...derived.relative.split('/'))),mediaCiphertext);
  assert.equal(restored.stagedStates.length,5);for(const row of restored.stagedStates){assert.equal(digest(await fsp.readFile(path.join(target,...row.path.split('/')))),row.stagedSha256);assert.notEqual(row.stagedSha256,row.sourceSha256);}
  t.ok(true,'all independent master headers and direct-DPAPI sources are restaged and verified before publishing fresh ordinary target bytes');
  const result=await runMediaSnapshotProcess(target,'--verify',derived.referenceId);
  assert.equal(result.ok,true);assert.equal(result.keyIds,3);assert.equal(result.mediaLogicalHash,derived.logicalHash);
  t.ok(true,'fresh Node obtains its own actual OS owner and authenticates restored work data, historical vault and direct-DPAPI secrets with cold caches');
  t.ok(true,'fresh process validates restored media without reviving preview, delivery or unlink authority');
  const plainMedia=path.join(root,'plain-media'),sealedMedia=path.join(root,'sealed-media');
  await fsp.mkdir(plainMedia);
  const migratedKeys=await keysAt(sealedMedia,true);
  const forward=await mediaCodec(base,plainMedia,k).transform({relative:derived.relative,targetMode:'plain'});
  const back=await mediaCodec(plainMedia,sealedMedia,null,migratedKeys).transform({relative:derived.relative,targetMode:'encrypted'});
  assert.equal(forward.logicalHash,derived.logicalHash);assert.equal(back.logicalHash,derived.logicalHash);
  assert.notEqual(await migratedKeys.instance(),await k.instance());
  assert.notEqual(back.targetPhysicalHash,derived.physicalHash);
  const verification=await mediaCodec(sealedMedia,plainMedia,migratedKeys).verify({relative:derived.relative,targetMode:'encrypted'});
  assert.equal(verification.logicalHash,derived.logicalHash);
  t.ok(true,'production media codec migrates to plaintext and reseals identical logical bytes under a different real DPAPI-owned key');
  const unchanged=await snapshot(base,owner).seal({password,appVersion:api.VERSION,generation:0});assert.deepEqual(unchanged.sourceFiles,captured.sourceFiles);assert.deepEqual(await fsp.readFile(path.join(base,'external-bot-credentials.json')),botBytes);
  t.ok(true,'full source identities and hashes remain unchanged through restore and independent cold verification');
 }finally{await clear();assert.equal(path.dirname(root),temporaryParent);assert.ok(path.basename(root).startsWith('ruyi-full-snapshot-native-'));await fsp.rm(root,{recursive:true,force:true});}
 t.done();
}
const capsuleSkill = 'Snapshot_Skill';
const capsuleMarkdown = revision => `---\nname: ${capsuleSkill}\ndescription: Owned synthetic native capsule\n---\n\nCAPSULE VERSION ${revision}\n`;
const capsuleAds = Buffer.from([0, 13, 10, 128, 255]);
const logicalCapsule = snapshot => snapshot.entries.map(({ rel, dir, attrs, times, shortName, streams }) => ({ rel, dir, attrs, times, shortName, streams }));
const capsuleIds = snapshot => snapshot.entries.map(entry => entry.id);
const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function capsuleSourceWitness({schema, platform, revision, entries}) {
  // The native producer validates each stream hash. Object IDs include the NTFS
  // volume serial; the opaque labels are newly generated for each capture.
  return {schema, platform, revision, entries:entries.map(({rel, id, dir, attrs, times, shortName, streams}) => ({
    rel, id, dir, attrs, times, shortName,
    streams:streams.map(({name, size, hash}) => ({name, size, hash})).sort((a,b) => byName(a.name,b.name)),
  })).sort((a,b) => byName(a.rel,b.rel))};
}

async function capsuleReceipt(id) {
  const log = (await api.migrationLogs()).find(row => row.id === id);
  const receipt = log?.files.find(file => file.kind === 'skill-copy');
  assert.ok(receipt?.backup, 'the actual migration receipt has an owned capsule');
  return receipt;
}

async function verifyCapsuleCold() {
  const expected = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = process.env.RUYI_HOME;
  assert.equal(path.basename(base), 'capsule-restored');
  const fixtureRoot = path.dirname(base);
  assert.ok(path.basename(fixtureRoot).startsWith('ruyi-full-snapshot-native-'));
  assert.equal(process.env.HOME, path.join(fixtureRoot, 'capsule-cold-home'));
  const owner = await api.ServerOwnership.acquire([base]);
  try {
    const receipt = await capsuleReceipt(expected.copyId);
    assert.equal(receipt.backup, path.join(base, ...expected.wrapper.split('/')));
    const live = path.join(base, 'skills', capsuleSkill, 'SKILL.md');
    assert.equal(await fsp.readFile(live, 'utf8'), capsuleMarkdown(2));
    const { snapshot: archive, intent } = await api.migrationCapsuleRead(api.migrationCapsuleDescriptor(receipt.backup));
    assert.equal(intent.phase, 'published');
    assert.deepEqual(logicalCapsule(archive), expected.original);
    assert.ok(capsuleIds(archive).every(id => !expected.ids.includes(id)), 'portable restore owns new object identities');
    const objects = await api.migrationCapsuleCapturePreserved(path.join(receipt.backup, 'objects'), digest('cold portable objects'));
    assert.deepEqual(objects.entries.filter(row => row.rel).map(row => row.id).sort(), capsuleIds(archive).sort());
    console.log('COLD NATIVE CAPSULE VERIFIED');
    const undone = await api.migrationUndoSkillCopy(receipt);
    assert.equal(undone.outcome, 'restored-previous');
    assert.equal(await fsp.readFile(live, 'utf8'), capsuleMarkdown(1));
    assert.deepEqual(await fsp.readFile(live + ':owned-ads'), capsuleAds);
    console.log('COLD NATIVE CAPSULE UNDO VERIFIED');
  } finally {
    api.workDataKeys.clear();
    await api.flushWorkbenchLogs({ allowFailure: true });
    if (api.MigrationHooks.helperMayStillRun() === false && api.LocalSecretCrypto.helperMayStillRun() === false) await owner.release();
    else throw new Error('cold capsule native owner retained');
  }
}

async function checkCapsulePackage(serialized, wrapper, original) {
  const opened = await api.WorkDataRecovery.open(serialized, password);
  try {
    const source = api.WorkDataRecovery.skillBackupSource(opened.snapshot.files, opened.snapshot.directories);
    const auxiliary = opened.snapshot.auxiliaries.filter(row => row.type === 'skill-backup-portable');
    assert.equal(auxiliary.length, 1);
    assert.equal(auxiliary[0].sourceSha256, source.sourceSha256);
    assert.equal(auxiliary[0].sourcePath, source.sourcePath);
    const portable = JSON.parse(auxiliary[0].data.toString('utf8'));
    assert.equal(portable.originals.length, 1);
    assert.equal(portable.originals[0].wrapper, wrapper);
    assert.deepEqual(portable.records.find(record => record.path === wrapper + '/archive').value, original);
  } finally { opened.release(); }
}

async function capsuleExport(t, {base, owner, native, receipt, wrapper, original}) {
  const backupDirectory = path.join(root, 'exports');
  await fsp.mkdir(backupDirectory);
  const id = crypto.randomBytes(24).toString('hex');
  const rehearsal = path.join(backupDirectory, '.ruyi-work-data-verify-' + id);
  const revision = digest('source capsule export');
  const captureSource = async () => capsuleSourceWitness(await api.migrationCapsuleCapturePreserved(receipt.backup, revision));
  const before = await captureSource();
  const sourceKeeper = api.ServerOwnership.createSourceKeeper(owner, base);
  const phases = [], events = [];
  const production = native.coldOperationHost(value => phases.push(value.phase));
  const host = {...production,
    async verifyFresh(value) {
      assert.equal(value.target, rehearsal);
      assert.equal(await production.verifyFresh(value), true);
      events.push('fresh');
      return true;
    },
    async verifyDisposableNativeTree(value) {
      assert.equal(value.target, rehearsal);
      assert.equal(api.ServerOwnership.owns(value.ownership, rehearsal), true);
      const prefix = wrapper + '/objects/';
      const newNames = [...value.snapshot.directories, ...value.snapshot.files.map(row => row.path)]
        .filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
      assert.equal(newNames.length, original.entries.length);
      assert.ok(newNames.every(name => /^[a-f0-9]{64}$/.test(name) && original.entries.every(row => row.opaque !== name)));
      assert.equal(await production.verifyDisposableNativeTree(value), true);
      events.push('exact mapped census');
      return true;
    }
  };
  try {
    const result = await api.WorkDataColdOperations.create(host).execute({id, base, operation:'export', password,
      ownership:owner, assertExclusive:selected => selected === owner && sourceKeeper.assertExclusive(selected),
      expectedAuthority:{generation:0, id:null, mode:'encrypted', sha256:null},
      paths:{backupDirectory, targetDirectory:null, uploadFile:null, uploadSha256:null}});
    assert.equal(result.state, 'verified');
    assert.equal(result.operation, 'export');
    assert.deepEqual(phases, ['snapshot','verify-backup']);
    assert.deepEqual(events, ['fresh','exact mapped census']);
    await assert.rejects(fsp.lstat(rehearsal), {code:'ENOENT'});
    t.ok(true, 'production cold export restores a new native capsule, passes the independent verifier and removes only its verified rehearsal');
    const bytes = await fsp.readFile(result.backup.path);
    assert.equal(digest(bytes), result.backup.sha256);
    await checkCapsulePackage(bytes.toString('utf8'), wrapper, original);
    assert.deepEqual(await captureSource(), before);
    t.ok(true, 'published export authenticates the original native evidence and preserves source capsule identity and metadata');
  } finally {
    if (native.helperMayStillRun()) sourceKeeper.retainUnknown();
    else await sourceKeeper.releaseChecked(() => native.helperMayStillRun() === false);
  }
}

async function capsuleMain(t, exporting) {
  const base = process.env.RUYI_HOME;
  const target = path.join(root, 'capsule-restored');
  const native = exporting
    ? api.WorkDataVerifierEntry.createVerifier({entry:path.resolve(__dirname, '../ruyi-workbench/app/server.js')})
    : api.WorkDataNativeAdapters.create();
  const uncertain = () => native.helperMayStillRun() !== false || api.MigrationHooks.helperMayStillRun() !== false;
  let owner, targetOwner, passed = false;
  try {
    await fsp.mkdir(base);
    owner = await api.ServerOwnership.acquire([base]);
    const config = await api.readConfig();
    config.workDataEncryptionV1 = true;
    await api.writeConfig(config);
    (await api.workDataKeys.ensure()).fill(0);
    const external = path.join(process.env.CODEX_HOME, 'skills', capsuleSkill, 'SKILL.md');
    const live = path.join(base, 'skills', capsuleSkill, 'SKILL.md');
    await fsp.mkdir(path.dirname(external), { recursive: true });
    await fsp.writeFile(external, capsuleMarkdown(1));
    assert.equal((await api.migrationCopySkills({ keys: ['codex:' + capsuleSkill] })).copied, 1);
    await fsp.writeFile(live + ':owned-ads', capsuleAds);
    await fsp.writeFile(external, capsuleMarkdown(2));
    const copied = await api.migrationCopySkills({ keys: ['codex:' + capsuleSkill], overwrite: true });
    assert.equal(copied.copied, 1);
    const receipt = await capsuleReceipt(copied.id);
    const wrapper = path.relative(base, receipt.backup).split(path.sep).join('/');
    assert.match(wrapper, /^migrations\/skill-backups\/[0-9TZ-]+\/Snapshot_Skill$/);
    const { snapshot: original } = await api.migrationCapsuleRead(api.migrationCapsuleDescriptor(receipt.backup));
    const originalSkill = original.entries.find(row => row.rel === 'SKILL.md');
    assert.deepEqual(Buffer.from(originalSkill.streams.find(row => row.name === ':owned-ads:$DATA').data, 'base64'), capsuleAds);
    assert.ok((await fsp.readdir(path.join(receipt.backup, 'objects'))).length >= 2);
    await api.flushWorkbenchLogs({ allowFailure: false });
    t.ok(true, 'production skill overwrite creates a non-empty authenticated native capsule and named DATA stream');

    if (exporting) {
      await capsuleExport(t, {base, owner, native, receipt, wrapper, original});
      passed = true;
      return;
    }

    const snapshotHost = native.fullSnapshot(base, owner, selected => selected === owner || selected === targetOwner);
    const seal = () => snapshotHost.seal({ password, appVersion: api.VERSION, generation: 0 });
    const sealed = await seal();
    assert.equal(sealed.specialCoverage?.originalObjects, 'new-owned-portable');
    await checkCapsulePackage(sealed.serialized, wrapper, original);
    t.ok(true, 'ordinary full snapshot binds actual native capsule evidence to the authenticated source manifest');

    targetOwner = await api.ServerOwnership.acquire([target]);
    const restored = await snapshotHost.restore({ serialized: sealed.serialized, password, target, targetOwnership: targetOwner });
    assert.equal(restored.specialProfile?.originalObjects, 'new-owned-portable');
    assert.equal(await fsp.readFile(path.join(target, 'skills', capsuleSkill, 'SKILL.md'), 'utf8'), capsuleMarkdown(2));
    await targetOwner.release();
    targetOwner = null;
    const env = releaseEnvironment(path.join(root, 'capsule-cold-home'), target);
    const child = cp.spawn(process.execPath, [__filename, '--verify-capsule'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '', expired = false;
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ copyId: copied.id, wrapper, original: logicalCapsule(original), ids: capsuleIds(original) }));
    const timer = setTimeout(() => { expired = true; killOwnTree(child); }, 90000);
    try {
      const code = await closed;
      assert.equal(expired, false, 'cold capsule verifier exceeded its owned window');
      assert.equal(code, 0, stderr + '\n' + output);
      assert.match(output, /^COLD NATIVE CAPSULE VERIFIED$/m);
      assert.match(output, /^COLD NATIVE CAPSULE UNDO VERIFIED$/m);
    } finally { clearTimeout(timer); killOwnTree(child); }
    t.ok(true, 'fresh process authenticates the restored capsule, its new native objects and real undo with named DATA');

    const unchanged = await seal();
    assert.deepEqual(unchanged.sourceFiles, sealed.sourceFiles);
    assert.deepEqual(unchanged.sourceDirectories, sealed.sourceDirectories);
    assert.equal(await fsp.readFile(live, 'utf8'), capsuleMarkdown(2));
    t.ok(true, 'source capsule identity and bytes and the live replacement survive target restore and undo');
    passed = true;
  } finally {
    api.workDataKeys.clear();
    await api.flushWorkbenchLogs({ allowFailure: true });
    if (!uncertain()) {
      if (targetOwner) await targetOwner.release();
      if (owner) await owner.release();
    }
    if (passed && !uncertain()) {
      assert.equal(path.dirname(root), temporaryParent);
      assert.ok(path.basename(root).startsWith('ruyi-full-snapshot-native-'));
      await fsp.rm(root, { recursive: true, force: true });
    } else {
      console.error('Retained owned native capsule fixture ' + root);
      if (passed) throw new Error('capsule native owner retained');
    }
  }
}

function logCauses(error) {
  for (let cause = error; cause; cause = cause.cause) {
    if (cause !== error) console.error(cause.stack || cause);
    if (cause.portableDiagnostic) console.error('PORTABLE TARGET DIAGNOSTIC ' + JSON.stringify(cause.portableDiagnostic));
  }
}

if (process.argv.includes('--verify-capsule')) {
  verifyCapsuleCold().catch(error => {
    console.error(error.stack || error); logCauses(error);
    process.exitCode = 1;
  });
} else if (process.argv.includes('--capsule') || process.argv.includes('--capsule-export')) {
  if (process.platform !== 'win32') console.log('SKIP Windows native portable capsule');
  else {
    const t = createRunner('WORK DATA FULL SNAPSHOT CAPSULE');
    capsuleMain(t, process.argv.includes('--capsule-export')).catch(error => {
      t.fail(error.stack || String(error)); logCauses(error);
    }).finally(() => t.done());
  }
} else {
  (process.argv[2]==='--seed-media' ? seedProtectedMedia() : childMode ? verifyCold() : main()).catch(async error => {
    console.error(error.stack || error); await clear().catch(() => {}); process.exitCode = 1;
  });
}
