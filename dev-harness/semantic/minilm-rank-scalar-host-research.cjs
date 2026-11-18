'use strict';
// Share the existing GCC owner registry/transport. Only policy cache FP differs.
const fs=require('node:fs'),crypto=require('node:crypto');const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const baseFile=require.resolve('./gcc-window-scalar-native-host-research.cjs'),policyFile=require.resolve('./minilm-rank-policy-research.cjs');
if(sha(fs.readFileSync(baseFile))!=='153341c0603ce878a3b47b90ac272a532e604edccd99dc253e6a473bd229b470')throw Error('minilm.gcc_host_source_changed');
const {createScalarNativeHost:createBase}=require(baseFile),fields=['modelFingerprint','templateFingerprint','runtimeFingerprint','policyFingerprint'];
function createScalarNativeHost(options={}){const {variant='raw',...baseOptions}=options;if(!['raw','cutoff034'].includes(variant))throw Error('minilm.variant_invalid');const selectedPolicy=variant==='raw'?policyFile:require.resolve('./minilm-rank-cutoff-policy-research.cjs'),{CONTRACT}=require(selectedPolicy);if(CONTRACT.topK!==4||CONTRACT.threshold!==.95)throw Error('minilm.policy_changed');const base=createBase(baseOptions);let prior=null,descriptor=null;
 async function prepare(args){const r=await base.prepare(args);if(!r?.ok)return r;prior=Object.freeze(Object.fromEntries(fields.map(k=>[k,r[k]])));descriptor=Object.freeze({...prior,policyFingerprint:'sha256:'+sha(JSON.stringify(['minilm-k4-window-v2',prior.policyFingerprint,sha(fs.readFileSync(selectedPolicy)),CONTRACT]))});return {...r,...descriptor};}
 async function verify(query,source,options={}){if(options.signal?.aborted)throw options.signal.reason===undefined?Object.assign(Error('scalar.aborted'),{name:'AbortError'}):options.signal.reason;
  if(!descriptor)return {ok:false,reason:'unavailable',state:'not-prepared',researchOnly:true};if(!options.fingerprints||fields.some(k=>options.fingerprints[k]!==descriptor[k]))throw Error('scalar.fingerprint_changed');
  const r=await base.verify(query,source,{...options,fingerprints:prior});return r?.ok?{...r,...descriptor}:r;}
 return Object.freeze({...base,prepare,verify});
}
module.exports={createScalarNativeHost};
