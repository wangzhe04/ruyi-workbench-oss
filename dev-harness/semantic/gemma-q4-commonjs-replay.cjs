'use strict';
// Explicit offline replay only: no model or inference; unknown text fails closed.
const crypto=require('node:crypto');
const H=x=>crypto.createHash('sha256').update(x).digest('hex');
function createReplay(rows,descriptor){
 if(!Array.isArray(rows)||!descriptor?.available||!/^sha256:/.test(descriptor.modelFingerprint||'')||descriptor.dimensions!==768)throw Error('replay.invalid_contract');
 const byKey=new Map();for(const row of rows){const role=row.cohort==='document'?'document':'query',key=role+'|'+row.textSha256,v=row.vector;if(!/^[a-f0-9]{64}$/.test(row.textSha256||'')||!Array.isArray(v)||v.length!==768||!v.every(Number.isFinite))throw Error('replay.invalid_row');if(byKey.has(key)&&byKey.get(key).some((n,i)=>n!==v[i]))throw Error('replay.conflict');byKey.set(key,v.slice());}
 const d=Object.freeze({...descriptor,replay:true});let requests=0;
 return Object.freeze({prepare:async({signal}={})=>{if(signal?.aborted)throw signal.reason||Error('aborted');return d;},encode:async(texts,{role,signal,beforeEncode}={})=>{if(beforeEncode)await beforeEncode();if(signal?.aborted)throw signal.reason||Error('aborted');if(!['query','document'].includes(role)||!Array.isArray(texts)||texts.some(t=>typeof t!=='string'))throw Error('replay.invalid_request');const vectors=texts.map(t=>byKey.get(role+'|'+H(t)));if(vectors.some(v=>!v))return {ok:false,reason:'unavailable'};requests++;return {ok:true,modelFingerprint:d.modelFingerprint,vectors:vectors.map(v=>v.slice()),truncated:vectors.map(()=>false)};},descriptor:()=>d,stop:async()=>({ok:true,replay:true}),stats:()=>({replay:true,requests})});
}
module.exports={createReplay};
