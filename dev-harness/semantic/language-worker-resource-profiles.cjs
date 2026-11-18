'use strict';
// Independent single-model factories only. No language detection, routing,
// cross-model cosine comparison or fusion lives in this resource interface.
const path=require('node:path'),{create}=require('./bge-zh-worker-host.cjs');
function bge(options={}){return create({directory:path.resolve('output/semantic-bge-cn-coarse-v2'),...options});}
function english({searchThreshold,...options}={}){
  if(!Number.isFinite(searchThreshold))throw Error('Explicit frozen English threshold is required.');
  return create({directory:path.resolve('output/semantic-minilm-family-coarse-v1'),...options,modelSpec:{id:'all-MiniLM-L6-v2',dimensions:384,pooling:'mean',normalize:true,maxTokens:256,prefix:{query:'',document:''},searchThreshold,
    lockSha256:'2a7fbd52eafaa2c759ea762f4f4b8fc0d2c4321fca0f5858babb2d17cd142474',verifierFile:require.resolve('./minilm-family-worker-verify.cjs'),lockEnvironment:'RUYI_MINILM_FAMILY_LOCK',implementationTag:'original-worker-mask-mean-L2-physical1-cpu2-inter1-arena-default'}});
}
module.exports={bge,english};
