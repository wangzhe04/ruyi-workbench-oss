'use strict';
// Native pre-issuance receipt is not a Basic-time proof. A token is authorized
// only by the private caller that holds the real plan/owner/manifest candidate.
const {types}=require('node:util'),proofs=new WeakMap();
const fail=()=>{throw Object.assign(Error('candidate_settlement.proof'),{code:'candidate_settlement.proof'});};
function record(value,keys){if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();const actual=Reflect.ownKeys(value);if(actual.some(x=>typeof x!=='string')||actual.sort().join(',')!==[...keys].sort().join(','))fail();const out={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))fail();out[key]=d.value;}return out;}
function list(value,limit){if(!Array.isArray(value)||types.isProxy(value))fail();const length=Object.getOwnPropertyDescriptor(value,'length');if(!length||!Object.hasOwn(length,'value')||!Number.isSafeInteger(length.value)||length.value<0||length.value>limit)fail();const keys=Reflect.ownKeys(value);if(keys.length!==length.value+1)fail();const out=[];for(let i=0;i<length.value;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))fail();out.push(d.value);}return out;}
function cleanRows(rows){
 const input=list(rows,10001);if(!input.length)fail();const names=new Set(),ids=new Set(),out=[];
 for(const raw of input){const row=record(raw,['attrs','dir','id','rel','shortName','streams']);if(typeof row.rel!=='string'||row.rel.length>1024||row.rel&&row.rel.split('/').some(p=>!p||p==='.'||p==='..'||/[\\:\x00-\x1f]/.test(p))||!/^[a-f0-9]{24}$/.test(row.id||'')||typeof row.dir!=='boolean'||!Number.isSafeInteger(row.attrs)||typeof row.shortName!=='string')fail();
  const key=process.platform==='win32'?row.rel.toLowerCase():row.rel;if(names.has(key)||ids.has(row.id))fail();names.add(key);ids.add(row.id);const streams=[],streamNames=new Set();
  for(const rawStream of list(row.streams,10000)){const stream=record(rawStream,['hash','name','size']);if(typeof stream.name!=='string'||!/^[a-f0-9]{64}$/.test(stream.hash||'')||!Number.isSafeInteger(stream.size)||stream.size<0)fail();const sk=stream.name.toLowerCase();if(streamNames.has(sk))fail();streamNames.add(sk);streams.push(Object.freeze({name:stream.name,size:stream.size,hash:stream.hash}));}
  streams.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);if(row.dir?streams.length!==0:streams.length!==1||streams[0].name!=='')fail();out.push(Object.freeze({rel:row.rel,id:row.id,dir:row.dir,attrs:row.attrs,shortName:row.shortName,streams:Object.freeze(streams)}));
 }
 out.sort((a,b)=>a.rel<b.rel?-1:a.rel>b.rel?1:0);return Object.freeze(out);
}
function issue({owner,candidate,rootId,files,directories,rows,assertAuthoritySync}){
 if(!owner||!candidate||!/^[a-f0-9]{24}$/.test(rootId||'')||typeof assertAuthoritySync!=='function'||assertAuthoritySync(owner,candidate)!==true)fail();
 const norm=s=>process.platform==='win32'?s.toLowerCase():s,byFile=new Map(),dirs=new Set(['']);
 for(const raw of list(files,10000)){const item=record(raw,['path','sha256']);if(typeof item.path!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256||'')||byFile.has(norm(item.path)))fail();byFile.set(norm(item.path),item.sha256);}
 for(const name of list(directories,10000)){if(typeof name!=='string'||!name||dirs.has(norm(name)))fail();dirs.add(norm(name));}
 const safe=cleanRows(rows),actualFiles=new Set(),actualDirs=new Set();
 for(const row of safe){const k=norm(row.rel);if(row.dir){if(!dirs.has(k))fail();actualDirs.add(k);if(!row.rel&&row.id!==rootId)fail();}else{if(byFile.get(k)!==row.streams[0].hash)fail();actualFiles.add(k);}}
 if(actualFiles.size!==byFile.size||actualDirs.size!==dirs.size||assertAuthoritySync(owner,candidate)!==true)fail();
 const token=Object.freeze(Object.create(null));proofs.set(token,{owner,candidate,rows:safe,assertAuthoritySync});return token;
}
function consume(token,{owner,candidate,rows}){const known=proofs.get(token);if(!known||known.owner!==owner||known.candidate!==candidate||known.assertAuthoritySync(owner,candidate)!==true)fail();const actual=cleanRows(rows);if(JSON.stringify(actual)!==JSON.stringify(known.rows))fail();if(known.assertAuthoritySync(owner,candidate)!==true)fail();proofs.delete(token);return true;}
module.exports={issue,consume};
