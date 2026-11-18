'use strict';
// Offline research verifier, exact existing BGE assets + current text runtime.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sourceRoot=path.resolve(__dirname,'../../ruyi-workbench/semantic-runtime'),{sha256,verifyRuntimeAssets}=require(path.join(sourceRoot,'verify.cjs')),{modelFingerprint}=require(path.join(sourceRoot,'protocol.cjs'));
async function verify(root,id){
  const file=process.env.RUYI_BGE_CN_LOCK,expected=process.env.RUYI_BGE_CN_LOCK_SHA256;if(!file||!/^[a-f0-9]{64}$/.test(expected||'')||await sha256(file)!==expected)throw Error('BGE_LOCK_CHANGED');
  const lock=JSON.parse(fs.readFileSync(file));if(path.resolve(root)!==lock.runtimeRoot||id!==lock.model.workerModel.id)throw Error('BGE_ROOT_MODEL_MISMATCH');
  for(const item of lock.sourceBindings)if(await sha256(item.file)!==item.sha256)throw Error('BGE_SOURCE_CHANGED');
  for(const item of lock.model.workerModel.files){const actual=path.resolve(lock.model.modelDir,item.path),stat=fs.lstatSync(actual);if(actual!==path.resolve(item.file)||!stat.isFile()||stat.isSymbolicLink()||stat.size!==item.bytes||await sha256(actual)!==item.sha256)throw Error('BGE_MODEL_INTEGRITY');}
  if(await sha256(path.join(root,'package-lock.json'))!==lock.packageLockSha256)throw Error('BGE_DEPENDENCY_LOCK_CHANGED');const assets=await verifyRuntimeAssets(root);if(assets!==lock.runtimeInventorySha256)throw Error('BGE_DEPENDENCIES_CHANGED');
  const implementationHash=crypto.createHash('sha256').update(JSON.stringify([expected,await sha256(__filename),lock.workerSha256,'original449f-CLS-L2-CN-query-prefix-physical1-cpu2-inter1'])).digest('hex');
  return {model:lock.model.workerModel,modelDir:lock.model.modelDir,modelFingerprint:modelFingerprint(lock.model.workerModel,lock.packageLockSha256,assets,implementationHash)};
}
module.exports={verify};
