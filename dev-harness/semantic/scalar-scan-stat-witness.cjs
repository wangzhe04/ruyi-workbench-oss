'use strict';
// Opaque in-memory witnesses. Neither keys nor their HMACs are returned,
// serialized, logged, or added to source/consumer DTOs.
const crypto=require('node:crypto');
function createWitness(store,keys){
  const salt=crypto.randomBytes(32),proofs=new WeakMap(),tokens=new WeakMap();
  const plaintext=Object.freeze({});tokens.set(plaintext,{encrypted:false,tag:null});let lastTag=null,lastToken=null;
  const tag=lease=>crypto.createHmac('sha256',salt).update('ruyi-scan-stat-decode-lease-v1\0').update(lease.key).update('\0').update(lease.instanceId).digest('hex');
  function capture(encrypted,credential){
    if(typeof encrypted!=='boolean'||encrypted&&!credential)return null;
    if(!encrypted)return plaintext;
    const currentTag=tag(credential);if(currentTag===lastTag)return lastToken;
    const token=Object.freeze({});tokens.set(token,{encrypted:true,tag:currentTag});lastTag=currentTag;lastToken=token;return token;
  }
  async function validate(token){
    const value=tokens.get(token);if(!value)return false;if(!value.encrypted)return true;
    const lease=await store.acquireSnapshot(keys);
    try{return tag(lease)===value.tag;}finally{await lease.release();}
  }
  return Object.freeze({capture,publish:(proof,token)=>{if(proof&&tokens.has(token))proofs.set(proof,token);},read:proof=>proofs.get(proof)||null,validate});
}
module.exports={createWitness};
