'use strict';
// Research transform of the real migration host; requires manifest/private
// native allocator and the patched preserved reader, never a path-only token.
const crypto=require('node:crypto');
function transform(source){
 const edits=[
  ['base=p.resolve(base);const tree=WorkDataTree.create(limits)', 'base=p.resolve(base);const candidatePlans=new WeakMap(),tree=WorkDataTree.create(limits)'],
  ["WorkDataTree.createPreserved({capturePreserved:preservedRead.capturePreserved,ownership,assertExclusive,assertExclusiveSync,limits})",
   "WorkDataTree.createPreserved({capturePreserved:preservedRead.capturePreserved,ownership,assertExclusive,assertExclusiveSync,limits,candidateAuthority:(candidate,root)=>{const plan=candidatePlans.get(candidate);if(!plan||!busy||key(p.resolve(root))!==key(base)||typeof assertExclusiveSync!=='function'||assertExclusiveSync(ownership)!==true||typeof manifest.researchCandidateBoundary!=='function')fail('candidate_invalid');return manifest.researchCandidateBoundary(candidate,plan.sourceProof);}})"],
  ['    async function checkSource(plan){','    async function capturePlanBase(plan){return sourceTree.capture(base,plan.candidate||undefined);}\n    async function checkSource(plan){'],
  ['await sourceTree.capture(base)','await capturePlanBase(plan)',3],
  ["plan.candidate=await manifest.prepare({expected:plan.expected,mode:targetMode});", "plan.candidate=await manifest.prepare({expected:plan.expected,mode:targetMode});candidatePlans.set(plan.candidate,plan);"],
  ['const targetReader=plan.nonemptySpecial?sourceTree:tree,target=await targetReader.capture(plan.candidate.root);','const targetReader=preservedRead!==undefined?sourceTree:tree,target=await targetReader.capture(plan.candidate.root);if(preservedRead!==undefined){targetReader.assertRootId(target,manifest.researchCandidateBoundary(plan.candidate,plan.sourceProof).id);if(!plan.nonemptySpecial)targetReader.assertNoNamedStreams(target);}'],
  ['plan.targetProof=await targetReader.verify(target);await checkSource(plan);','plan.targetProof=await targetReader.verify(target);if(preservedRead!==undefined&&!plan.nonemptySpecial)targetReader.assertNoNamedStreams(target);await checkSource(plan);'],
  ['const target=await (plan.nonemptySpecial?sourceTree:tree).verify(plan.target);if(plan.nonemptySpecial&&target.nativeSha256!==plan.targetProof.nativeSha256)', 'const target=await (preservedRead!==undefined?sourceTree:tree).verify(plan.target);if(preservedRead!==undefined){sourceTree.assertRootId(plan.target,manifest.researchCandidateBoundary(plan.candidate,plan.sourceProof).id);}if(preservedRead!==undefined&&target.nativeSha256!==plan.targetProof.nativeSha256)'],
  ['targetNativeSha:plan.nonemptySpecial?plan.targetProof.nativeSha256:null','targetNativeSha:preservedRead!==undefined?plan.targetProof.nativeSha256:null']
 ];let out=source;for(const [index,[a,b,count=1]] of edits.entries()){if(out.split(a).length!==count+1)throw Error('migration.boundary.'+index);out=out.split(a).join(b);}return {source:out,edits,sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
