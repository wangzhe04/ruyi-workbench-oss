'use strict';
// Owned synthetic-only controller: no encrypted-source or full-enable claim.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const H=x=>crypto.createHash('sha256').update(x).digest('hex');
async function main(){
 if(process.argv.length!==5||process.argv[2]!=='run')throw Error('cli');
 const contractFile=path.resolve(process.argv[3]),expected=process.argv[4],bytes=fs.readFileSync(contractFile);if(H(bytes)!==expected)throw Error('contract');
 const c=JSON.parse(bytes),root=path.resolve(c.root);if(c.status!=='FROZEN_OWNED_RESTORE_NATIVE'||path.resolve(path.dirname(contractFile))!==root||!fs.existsSync(path.join(root,'OWNER.json')))throw Error('owner');
 const verify=()=>{for(const row of c.bindings){const b=fs.readFileSync(row.file);if(b.length!==row.bytes||H(b)!==row.sha256)throw Error('binding');}};verify();
 const env=require(c.environmentHelper).releaseEnvironment(path.join(root,'trial-home'),path.join(root,'source'));for(const k of Object.keys(process.env))if(!Object.hasOwn(env,k))delete process.env[k];Object.assign(process.env,env,{RUYI_DISABLE_SEMANTIC:'1'});
 const app=c.app,virtual=path.join(app,'server.js'),m=new Module(virtual,module);m.filename=virtual;m.paths=Module._nodeModulePaths(app);m._compile(fs.readFileSync(virtual,'utf8')+'\nmodule.exports.__ownedRestoreProof={WorkDataNativeAdapters,ServerOwnership,LocalSecretCrypto,MigrationHooks,flushWorkbenchLogs};\n',virtual);
 const api=m.exports.__ownedRestoreProof,source=path.join(root,'source'),target=path.join(root,'restored'),output=path.join(root,'receipt.json');let sourceOwner,targetOwner;const result={schema:1,status:'FAIL',scope:'Synthetic plain source; real protector and original 13aq→01ab/native census. Not encrypted-authority enable.',semanticOff:true,dpapiRoundtrip:false,seal:false,restore:false,ownershipReleased:false};
 try{
  if(fs.existsSync(source)||fs.existsSync(target)||fs.existsSync(output))throw Error('trial already exists');fs.mkdirSync(source);fs.mkdirSync(path.join(source,'sessions'));fs.mkdirSync(path.join(source,'nested'));fs.mkdirSync(path.join(source,'nested','deep'));
  for(const [rel,value] of [['config.json','{"workDataEncryptionV1":false}'],['sessions/test.json','{"id":"test","messages":[]}'],['nested/deep/item.txt','synthetic']]){const f=path.join(source,...rel.split('/')),h=fs.openSync(f,'wx');try{fs.writeFileSync(h,value);fs.fsyncSync(h);}finally{fs.closeSync(h);}}
  const plain=Buffer.from('owned synthetic dpapi probe'),entropy=Buffer.from('owned synthetic context');let sealed,opened;try{sealed=await api.LocalSecretCrypto.run('protect',plain,entropy);opened=await api.LocalSecretCrypto.run('unprotect',sealed,entropy);result.dpapiRoundtrip=opened.equals(plain);}finally{plain.fill(0);entropy.fill(0);sealed?.fill(0);opened?.fill(0);}if(!result.dpapiRoundtrip)throw Error('dpapi mismatch');
  sourceOwner=await api.ServerOwnership.acquire([source]);targetOwner=await api.ServerOwnership.acquire([target]);
  const adapter=api.WorkDataNativeAdapters.create(),full=adapter.fullSnapshot(source,sourceOwner,owner=>api.ServerOwnership.owns(owner));const secret='owned synthetic research password only';const snap=await full.seal({password:secret,appVersion:'3.0.1',generation:0});result.seal=true;
  const restored=await full.restore({serialized:snap.serialized,password:secret,target,targetOwnership:targetOwner});result.restore=restored?.mode==='restored-full-base';if(!result.restore)throw Error('restore result');
  if(adapter.helperMayStillRun()!==false||api.MigrationHooks.helperMayStillRun()!==false||api.LocalSecretCrypto.helperMayStillRun()!==false)throw Error('helper uncertain');
  await targetOwner.release();targetOwner=null;await sourceOwner.release();sourceOwner=null;result.ownershipReleased=true;verify();result.bindingsStable=true;result.status='PASS_OWNED_RESTORE_13AQ_01AB_NATIVE_CAPTURE';
 }catch(e){result.code=typeof e?.code==='string'?e.code:'trial.failed';result.unknown=!!(e?.helperMayStillRun||api.MigrationHooks.helperMayStillRun()||api.LocalSecretCrypto.helperMayStillRun());process.exitCode=1;}
 finally{if(targetOwner||sourceOwner){if(result.unknown===true||api.MigrationHooks.helperMayStillRun()!==false||api.LocalSecretCrypto.helperMayStillRun()!==false){result.ownerDisposition='retained unknown';}else{try{if(targetOwner)await targetOwner.release();if(sourceOwner)await sourceOwner.release();result.ownerDisposition='released after failure';}catch{result.ownerDisposition='release failed';process.exitCode=1;}}}try{await api.flushWorkbenchLogs({allowFailure:false});}catch{result.cleanup='failed';process.exitCode=1;result.status='FAIL';}fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
}
main().catch(()=>{console.error('owned restore controller failed');process.exitCode=1;});
