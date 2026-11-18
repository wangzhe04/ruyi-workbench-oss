'use strict';
const crypto=require('node:crypto');
function transform(source){
 const before='const ownerRead=plan.nonemptySpecial?{preservedRead,ownership,assertExclusive,assertExclusiveSync}:{};';
 const after='const ownerRead=preservedRead!==undefined&&(plan.nonemptySpecial||plan.existingSpecial)?{preservedRead,ownership,assertExclusive,assertExclusiveSync,candidateSource:WorkDataTree.issueCandidateSource(sourceTree,plan.candidate,()=>!plan.commitStarted)}:{};';
 const first='const targetReader=preservedRead!==undefined?sourceTree:tree,target=await targetReader.capture(plan.candidate.root);if(preservedRead!==undefined){targetReader.assertRootId(target,manifest.researchCandidateBoundary(plan.candidate,plan.sourceProof).id);if(!plan.nonemptySpecial)targetReader.assertNoNamedStreams(target);}plan.disposable.push(target);plan.target=target;';
 const firstAfter="const targetReader=preservedRead!==undefined?sourceTree:tree,target=await targetReader.capture(plan.candidate.root);plan.disposable.push(target);plan.target=target;if(preservedRead!==undefined){targetReader.assertRootId(target,manifest.researchCandidateBoundary(plan.candidate,plan.sourceProof).id);if(plan.nonemptySpecial){if(typeof plan.special.verifyCandidateStreams!=='function')fail('special_owner_change_proof_required');await plan.special.verifyCandidateStreams(plan.specialToken,target);}else targetReader.assertNoNamedStreams(target);}";
 const last='plan.targetProof=await targetReader.verify(target);if(preservedRead!==undefined&&!plan.nonemptySpecial)targetReader.assertNoNamedStreams(target);';
 const lastAfter="plan.targetProof=await targetReader.verify(target);if(preservedRead!==undefined){if(plan.nonemptySpecial)await plan.special.verifyCandidateStreams(plan.specialToken,target);else targetReader.assertNoNamedStreams(target);}";
 const edits=[[before,after],[first,firstAfter],[last,lastAfter]];let out=source;for(const [i,[a,b]] of edits.entries()){if(out.split(a).length!==2)throw Error('special.host.boundary.'+i);out=out.replace(a,b);}return{source:out,edits,sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
