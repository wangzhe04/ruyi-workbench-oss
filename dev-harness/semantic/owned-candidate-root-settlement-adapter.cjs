'use strict';
const crypto=require('node:crypto');
function transform(source){
 const a='const owner = bindings.migrationHost.create({...options,assertExclusive:exclusive,assertExclusiveSync:exclusive,',b="const owner = bindings.migrationHost.create({...options,assertExclusive:exclusive,assertExclusiveSync:exclusive,candidateSettlement:values=>guarded(()=>migrationSettleCandidateRoot({...values,onNativeCause:onNativeCause||(()=>{})})),";
 if(source.split(a).length!==2)throw Error('settlement.adapter.boundary');const out=source.replace(a,b);return{source:out,edits:[[a,b]],sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
