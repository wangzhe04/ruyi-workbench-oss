'use strict';
// Research-only diagnostics for the synthetic root. The original three
// comparisons and their fail-closed behaviour are retained byte for byte.
const fs=require('node:fs'),crypto=require('node:crypto');
const H=x=>crypto.createHash('sha256').update(x).digest('hex');
const pathSafe=x=>typeof x==='string'&&x.length<=1024&&!x.startsWith('/')&&!x.split('/').includes('..')&&!/[\x00-\x1f\\:]/.test(x)?x:'[invalid-relative-path]';
function rowDiff(a,b){
 const fields=[];for(const key of ['id','dir','attrs','shortName','identity','size','sha256'])if(JSON.stringify(a?.[key])!==JSON.stringify(b?.[key]))fields.push(key==='sha256'?'content':'native.'+key);
 for(let i=0;i<4;i++)if(a?.times?.[i]!==b?.times?.[i])fields.push(['time.creation','time.access','time.write','time.change'][i]);
 if(JSON.stringify(a?.streams)!==JSON.stringify(b?.streams))fields.push('streams');
 return fields;
}
function diffRows(left,right,key='rel'){
 const a=new Map((left||[]).map(x=>[x[key],x])),b=new Map((right||[]).map(x=>[x[key],x])),out=[];
 for(const name of [...new Set([...a.keys(),...b.keys()])].sort()){const x=a.get(name),y=b.get(name),fields=!x?['added']:!y?['removed']:rowDiff(x,y);if(fields.length)out.push({path:pathSafe(name),fields});}
 return out;
}
function create(write){
 if(typeof write!=='function')throw Error('tree-diagnostic.writer');
 const emit=value=>{try{write(value);}catch{/* Never weaken or replace original refusal. */}};
 return Object.freeze({
  binding:(row,idMismatch,sizeMismatch)=>emit({branch:'node-native-binding',changes:[{path:pathSafe(row.rel),fields:[...(idMismatch?['identity']:[]),...(sizeMismatch?['size']:[])]}]}),
  native:(first,second)=>emit({branch:'native-census-diff',changes:diffRows(first.rows,second.rows)}),
  proof:(oldProof,newProof)=>{const dirs=diffRows(oldProof.directories,newProof.directories,'path'),files=diffRows(oldProof.files,newProof.files,'path');emit({branch:'verification-proof-diff',rootIdentityChanged:oldProof.rootIdentity!==newProof.rootIdentity,bytesChanged:oldProof.bytes!==newProof.bytes,changes:[...dirs,...files]});}
 });
}
function transform(source){
 const edits=[
 ["if (nativeId !== row.id || !row.dir && stat.size !== BigInt(row.data.length)) fail('source_changed');","if (nativeId !== row.id || !row.dir && stat.size !== BigInt(row.data.length)) { ResearchTreeProbe.binding(row,nativeId !== row.id,!row.dir && stat.size !== BigInt(row.data.length)); fail('source_changed'); }"],
 ["if (second.nativeSha256 !== first.nativeSha256) fail('source_changed');","if (second.nativeSha256 !== first.nativeSha256) { ResearchTreeProbe.native(first,second); fail('source_changed'); }"],
 ["if (JSON.stringify(proofOf(actual.result)) !== JSON.stringify(owned.proof)) fail('source_changed');","if (JSON.stringify(proofOf(actual.result)) !== JSON.stringify(owned.proof)) { ResearchTreeProbe.proof(owned.proof,proofOf(actual.result)); fail('source_changed'); }"]
 ];let derived=source;for(const [before,after] of edits){if(derived.split(before).length!==2)throw Error('tree-diagnostic.boundary');derived=derived.replace(before,after);}return{source:derived,originalSha256:H(source),derivedSha256:H(derived),edits};
}
function fileProbe(file){return create(value=>fs.appendFileSync(file,JSON.stringify(value)+'\n',{encoding:'utf8',mode:0o600}));}
module.exports={create,diffRows,transform,fileProbe};
