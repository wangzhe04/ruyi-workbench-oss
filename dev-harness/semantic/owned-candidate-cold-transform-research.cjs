'use strict';
const crypto=require('node:crypto');
function transform(source){
 const before='manifest: WorkDataManifest.create({ base }), protector,';
 const after="manifest: WorkDataManifest.create({ base, researchCandidateAllocator: typeof host.createCandidateBoundary==='function' ? ({candidate,root,assertIssued}) => host.createCandidateBoundary({candidate,root,sourceProof:captured,assertIssued,ownership:context.ownership,assertExclusive,assertIntent:async()=>{await control.verify(intent);},onNativeCause:retainHelper}) : undefined }), protector,";
 if(source.split(before).length!==2)throw Error('cold.boundary');const out=source.replace(before,after);return{source:out,edits:[[before,after]],sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
