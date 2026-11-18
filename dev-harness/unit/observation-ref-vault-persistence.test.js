'use strict';
// Vault component portability only. This does not replace13ak/01ab restore E2E.
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{spawnSync}=require('node:child_process');
const{fixture,seed,sha,purpose,recordId,scopeId,payload,content,atomic,repo}=require('../lib/observation-ref-vault-fixture.cjs');
async function directory(){const output=path.join(repo,'output');await fs.mkdir(output,{recursive:true});return fs.mkdtemp(path.join(output,'observation-ref-vault-'));}
const code=suffix=>error=>error.code==='credential_vault.'+suffix;
function restart(dir,protector){const child=spawnSync(process.execPath,[path.join(__dirname,'../lib/observation-ref-vault-fixture.cjs'),dir,protector],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(child.status,0,child.stderr);const value=JSON.parse(child.stdout);assert.equal(value.opened,true);assert.equal(value.projectedProtected,true);assert.equal(value.workDataEncryption,false);assert.equal(value.writes,0);return value;}
test('OFF work data + actual enhanced gateway uses existing durable vault; open never creates a key',async()=>{
 const dir=await directory(),f=await fixture(dir);try{
  await assert.rejects(f.api.openLocal({},purpose,recordId),code('key_missing'));assert.equal(f.stats.writes,0);await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
  const seeded=await seed(f);assert.equal(f.config.workDataEncryptionV1,false);assert.ok(seeded.projected.includes('RUYI_PVT'));assert.ok(!seeded.projected.includes('3141'));assert.ok((await f.read()).instanceId);assert.equal(await f.api.openLocal(seeded.sealed,purpose,recordId),payload);
  assert.ok(!(await fs.readdir(dir)).includes('.work-data'));assert.ok((await fs.readdir(dir)).includes('privacy-scopes'));
  const second=await f.api.sealLocal(payload,purpose,recordId);assert.notEqual(JSON.stringify(seeded.sealed),JSON.stringify(second));
  const publicRef='message:v2:'+Buffer.from(JSON.stringify(seeded.sealed)).toString('base64url'),decoded=JSON.parse(Buffer.from(publicRef.slice(11),'base64url'));assert.equal(decoded.raw,undefined);
  const serialized=JSON.stringify(decoded);for(const value of ['2718','3141'])assert.equal(serialized.includes(sha(content(value))),false,'old offline raw-SHA candidate match must be unavailable');
 }finally{f.close();}
});
test('new process opens durable reference and persisted privacy mapping without creating or rewriting the key',async()=>{
 const dir=await directory(),f=await fixture(dir);await seed(f);const before=await fs.readFile(f.file);f.close();restart(dir,'A');assert.deepEqual(await fs.readFile(f.file),before);
});
test('actual portable vault staging keeps master+instance under new protector/root and restarts successfully',async()=>{
 const sourceDir=await directory(),targetDir=await directory(),source=await fixture(sourceDir,'A'),target=await fixture(targetDir,'B');let snapshot,staged;
 try{
  await seed(source);snapshot=await source.api.snapshotForWorkDataRecovery();assert.ok(snapshot);const sourceMaster=Buffer.from(snapshot.lease.key);
  try{staged=await target.api.stageRecoveredForWorkData({state:snapshot.state,key:snapshot.lease.key});assert.equal(staged.state.instanceId,snapshot.state.instanceId);assert.notEqual(staged.state.protectedKey,snapshot.state.protectedKey);assert.deepEqual(staged.lease.key,sourceMaster);
   await target.publish(staged.state);await fs.copyFile(path.join(sourceDir,'public-reference.json'),path.join(targetDir,'public-reference.json'));await fs.cp(path.join(sourceDir,'privacy-scopes'),path.join(targetDir,'privacy-scopes'),{recursive:true});
   assert.deepEqual(await fs.readFile(path.join(targetDir,'public-reference.json')),await fs.readFile(path.join(sourceDir,'public-reference.json')));
   source.close();target.close();restart(targetDir,'B');const wrong=await fixture(targetDir,'A');try{const sealed=JSON.parse(await fs.readFile(path.join(targetDir,'public-reference.json')));await assert.rejects(wrong.api.openLocal(sealed,purpose,recordId),code('unlock_failed'));}finally{wrong.close();}
  }finally{sourceMaster.fill(0);}
 }finally{snapshot?.lease.release();staged?.lease.release();if(snapshot)assert.ok(snapshot.lease.key.every(value=>value===0));if(staged)assert.ok(staged.lease.key.every(value=>value===0));source.close();target.close();}
});
test('sealed ref rejects ciphertext/tag tamper, wrong instance, session binding and purpose',async()=>{
 const dir=await directory(),f=await fixture(dir);try{const{sealed}=await seed(f);
  for(const field of ['ciphertext','tag']){const changed=structuredClone(sealed),bytes=Buffer.from(changed.envelope[field],'base64');bytes[0]^=1;changed.envelope[field]=bytes.toString('base64');await assert.rejects(f.api.openLocal(changed,purpose,recordId),code('decrypt_failed'));}
  await assert.rejects(f.api.openLocal(sealed,purpose,sha(JSON.stringify(['main-message-ref-v2','other-session','synthetic-created-at',0]))),code('decrypt_failed'));
  await assert.rejects(f.api.openLocal(sealed,'other-purpose-v2',recordId),code('decrypt_failed'));
  const changed=structuredClone(sealed);changed.instanceId='0'.repeat(32);await assert.rejects(f.api.openLocal(changed,purpose,recordId),code('binding_mismatch'));
 }finally{f.close();}
});
