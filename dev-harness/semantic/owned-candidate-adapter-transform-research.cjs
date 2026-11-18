'use strict';
const crypto=require('node:crypto');
function transform(source){
 const before='return Object.freeze({acquire:roots => {check();return bindings.ownership.acquire(roots,{preserveRuntime:true});},sourceKeeper,flush,verifyFresh,captureRehearsal,';
 const after='return Object.freeze({createCandidateBoundary: options => guarded(()=>migrationCreateCandidateBoundary(options)),acquire:roots => {check();return bindings.ownership.acquire(roots,{preserveRuntime:true});},sourceKeeper,flush,verifyFresh,captureRehearsal,';
 if(source.split(before).length!==2)throw Error('adapter.boundary');const out=source.replace(before,after);return{source:out,edits:[[before,after]],sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
