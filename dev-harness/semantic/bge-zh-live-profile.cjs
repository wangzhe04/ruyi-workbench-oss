'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{create}=require('./bge-zh-worker-host.cjs'),{CONTRACT,transformation}=require('./bge-zh-coarse-policy.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function createProfile(options={}){
  if(Object.keys(options).some(key=>!['enabled','spawn','idleMs','stopMs'].includes(key)))throw Error('BGE profile model contract cannot be overridden.');
  const directory=path.resolve('output/semantic-bge-cn-coarse-v2'),encoder=create({directory,...options});
  const files=['bge-zh-live-profile.cjs','bge-zh-worker-host.cjs','bge-zh-coarse-policy.cjs','bge-zh-live-fixture.cjs','bge-chinese-only-development-protocol.json','bge-cn-worker-verify.cjs'].map(file=>path.join(__dirname,file));
  files.push(path.join(directory,'asset-lock.json'),path.join(directory,'worker.cjs'));
  return {id:CONTRACT.id,kind:'single-onnx-research',encoder,bindings:files.map(file=>({file,sha256:hash(fs.readFileSync(file))})),descriptor:{policyId:CONTRACT.id,policyFingerprint:'sha256:'+hash(JSON.stringify([CONTRACT,transformation.protocolSha256])),model:encoder.descriptor(),scalar:null,automatic:null},ownedIdentities:()=>({encoder:encoder.identity()})};
}
module.exports={create:createProfile};
