'use strict';
// Research-only host contract. The injected native operation MUST open every
// component relative to a held anchor and compare the entire identity chain.
const path=require('node:path');
const fail=code=>Object.assign(Error('restore_flush.'+code),{code:'restore_flush.'+code});
const fold=x=>process.platform==='win32'?x.toUpperCase():x;
function isInside(a,b){const r=path.relative(fold(a),fold(b));return r!==''&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);}
function validRel(value){return typeof value==='string'&&value.length<=1024&&(value===''||value.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!/[\x00-\x1f<>:"|?*\\]/.test(x)&&!/[. ]$/.test(x)));}
function prepare({target,source,records}){
 if(typeof target!=='string'||typeof source!=='string'||!path.isAbsolute(target)||!path.isAbsolute(source))throw fail('scope');
 target=path.resolve(target);source=path.resolve(source);if(fold(target)===fold(source)||isInside(target,source)||isInside(source,target))throw fail('scope');
 if(!Array.isArray(records)||!records.length||records.length>100001)throw fail('records');
 const byKey=new Map();for(const r of records){if(!r||!validRel(r.relative)||typeof r.identity!=='string'||!/^\d+:\d+$/.test(r.identity))throw fail('records');const key=fold(r.relative);if(byKey.has(key))throw fail('duplicate');byKey.set(key,Object.freeze({relative:r.relative,identity:r.identity}));}
 if(!byKey.has(''))throw fail('root_missing');
 for(const r of byKey.values()){if(!r.relative)continue;let parent=r.relative;while(parent){const at=parent.lastIndexOf('/');parent=at<0?'':parent.slice(0,at);if(!byKey.has(fold(parent)))throw fail('parent_missing');}}
 const ordered=[...byKey.values()].sort((a,b)=>b.relative.split('/').length-a.relative.split('/').length||a.relative.localeCompare(b.relative));const rootAt=ordered.findIndex(x=>x.relative==='');ordered.push(...ordered.splice(rootAt,1));
 return Object.freeze({target,source,byKey,ordered:Object.freeze(ordered)});
}
async function run(input,host){
 const plan=prepare(input);if(!host||['admit','listDirectories','inspectDirectory','flushAnchored'].some(k=>typeof host[k]!=='function'))throw fail('host');
 const assertOwner=async()=>{if(await host.admit(input.ownership,plan.target)!==true)throw fail('owner');};
 const verify=async()=>{await assertOwner();const actual=await host.listDirectories(plan.target);if(!Array.isArray(actual)||actual.some(x=>!validRel(x)))throw fail('namespace');const names=actual.map(fold).sort(),expected=[...plan.byKey.keys()].sort();if(JSON.stringify(names)!==JSON.stringify(expected))throw fail('namespace');for(const r of plan.ordered){const observed=await host.inspectDirectory(plan.target,r.relative);if(!observed||observed.identity!==r.identity||observed.alias!==false)throw fail('identity_changed');await assertOwner();}};
 await verify();for(const r of plan.ordered){await assertOwner();const names=r.relative?r.relative.split('/'):[],chain=[plan.byKey.get('')];let rel='';for(const name of names){rel=rel?rel+'/'+name:name;chain.push(plan.byKey.get(fold(rel)));}const value=await host.flushAnchored(Object.freeze({target:plan.target,relative:r.relative,chain:Object.freeze(chain)}));if(!value||Object.keys(value).sort().join(',')!=='identities,ok,relative,target'||value.ok!==true||value.target!==plan.target||value.relative!==r.relative||!Array.isArray(value.identities)||JSON.stringify(value.identities)!==JSON.stringify(chain.map(x=>x.identity)))throw fail('native_receipt');await assertOwner();}await verify();return Object.freeze({ok:true,directories:plan.ordered.length});
}
module.exports={prepare,run};
