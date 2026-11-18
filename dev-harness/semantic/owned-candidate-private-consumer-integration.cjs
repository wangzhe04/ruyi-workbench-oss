'use strict';
// Research-only overlay for the frozen settlement candidate. Issuance remains
// inside the existing private WeakMap service; only consumption is injected.
function replace(source,edits){for(const [a,b] of edits){if(source.split(a).length!==2)throw Error('private-consumer.boundary '+a.slice(0,80));source=source.replace(a,b);}return source;}
function host(source){const edits=[
 ['function create({base,ownership,assertExclusive,assertExclusiveSync,preservedRead,candidateSettlement,manifest,protector,','function create({base,ownership,assertExclusive,assertExclusiveSync,preservedRead,candidateSettlement,candidateSettlementConsume,manifest,protector,'],
 ["    if(candidateSettlement!==undefined&&typeof candidateSettlement!=='function')fail('host_invalid');","    if(candidateSettlement!==undefined&&typeof candidateSettlement!=='function')fail('host_invalid');\n    if(candidateSettlementConsume!==undefined&&typeof candidateSettlementConsume!=='function')fail('host_invalid');"],
 ["if(typeof candidateSettlement!=='function')fail('candidate_settlement_required');","if(typeof candidateSettlement!=='function'||typeof candidateSettlementConsume!=='function')fail('candidate_settlement_required');"],
 ['migrationCandidateSettlementProof.consume(settlementProof,{owner:ownership,candidate:plan.candidate,rows:WorkDataTree.readCapturedNativeManifest(target,ownership)});','candidateSettlementConsume(settlementProof,{owner:ownership,candidate:plan.candidate,rows:WorkDataTree.readCapturedNativeManifest(target,ownership)});']];return{source:replace(source,edits),edits};}
function adapter(source){const a='candidateSettlement:values=>guarded(()=>migrationSettleCandidateRoot({...values,onNativeCause:onNativeCause||(()=>{})})),',b=a+'candidateSettlementConsume:(proof,values)=>migrationCandidateSettlementProof.consume(proof,values),';const edits=[[a,b]];return{source:replace(source,edits),edits};}
function fixture(source){const a='candidateSettlement:async options=>{',b='candidateSettlementConsume:(proof,values)=>context.migrationCandidateSettlementProof.consume(proof,values),candidateSettlement:async options=>{';const edits=[[a,b]];return{source:replace(source,edits),edits};}
module.exports={host,adapter,fixture};
