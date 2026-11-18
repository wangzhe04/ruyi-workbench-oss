'use strict';
// Model-aware verification for an explicitly derived research worker only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sourceRuntime=path.resolve(__dirname,'../../ruyi-workbench/semantic-runtime');
const {sha256,verifyRuntimeAssets}=require(path.join(sourceRuntime,'verify.cjs')),{modelFingerprint}=require(path.join(sourceRuntime,'protocol.cjs'));
async function verify(root,id){const file=process.env.RUYI_MINILM_FAMILY_LOCK,expected=process.env.RUYI_MINILM_FAMILY_LOCK_SHA256;if(!file||!expected||await sha256(file)!==expected)throw Error('FAMILY_LOCK_CHANGED');const lock=JSON.parse(fs.readFileSync(file));const item=lock.models.find(x=>x.workerModel.id===id);if(!item)throw Error('FAMILY_MODEL_UNKNOWN');
 for(const x of lock.sourceBindings)if(await sha256(x.file)!==x.sha256)throw Error('FAMILY_SOURCE_CHANGED');
 for(const x of item.workerModel.files){const actual=path.resolve(item.modelDir,x.path);if(actual!==path.resolve(x.file)||fs.statSync(actual).size!==x.bytes||await sha256(actual)!==x.sha256)throw Error('FAMILY_ASSET_CHANGED');}
 if(await sha256(path.join(root,'package-lock.json'))!==lock.packageLockSha256)throw Error('FAMILY_RUNTIME_LOCK_CHANGED');const runtimeAssetsHash=await verifyRuntimeAssets(root);if(runtimeAssetsHash!==lock.runtimeInventorySha256)throw Error('FAMILY_RUNTIME_ASSETS_CHANGED');
 const implementationHash=crypto.createHash('sha256').update(JSON.stringify([expected,await sha256(__filename),lock.workerRecipe.transformedSha256,'original-worker-mask-mean-L2-physical1-cpu2-inter1-arena-default'])).digest('hex');return {model:item.workerModel,modelDir:item.modelDir,modelFingerprint:modelFingerprint(item.workerModel,lock.packageLockSha256,runtimeAssetsHash,implementationHash)};
}
module.exports={verify};
