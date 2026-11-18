'use strict';
// Actual-host test adapter with modeled (not NTFS) allocator/readback.
function transform(source){
 const edits=[
  ["manifest=api.WorkDataManifest.create({base,publish:","manifest=api.WorkDataManifest.create({base,researchCandidateAllocator:async({candidate})=>{await fsp.mkdir(candidate.root);const id=async file=>{const s=await fsp.stat(file,{bigint:true});return s.dev.toString(16).padStart(8,'0')+s.ino.toString(16).padStart(16,'0');};return {candidate,root:candidate.root,id:await id(candidate.root),parents:[await id(base),await id(path.join(base,'.work-data')),await id(path.join(base,'.work-data','generations'))],baselineSha256:crypto.createHash('sha256').update(JSON.stringify({sourceFiles:proof.sourceFiles,sourceDirectories:proof.sourceDirectories})).digest('hex')};},publish:"],
  [" const capturePreserved=require('./work-data-preserved-reader-model').createPreservedReaderModel(async root=>{state.nativeCaptures.push(root);if(state.onNativeCapture)await state.onNativeCapture(root);});",
   " const rawCapture=require('./work-data-preserved-reader-model').createPreservedReaderModel(async root=>{state.nativeCaptures.push(root);if(state.onNativeCapture)await state.onNativeCapture(root);});\n const capturePreserved=async(root,revision,readback)=>{if(!readback)return rawCapture(root,revision);const readbackContext=vm.runInContext('WorkDataTree',context).claimPreservedReadbackContext(readback,root,revision);if(!readbackContext)throw Error('unissued');const capture=async rev=>{const result=await rawCapture(root,rev),prefix=readbackContext.candidateBoundary?.rel;if(prefix)result.entries=result.entries.filter(row=>row.rel!==prefix&&!row.rel.startsWith(prefix+'/'));return result;};await readback.bind(await capture(revision));return capture(readback.revision);};"]
 ];let out=source;for(const [a,b] of edits){if(out.split(a).length!==2)throw Error('hostfixture.boundary');out=out.replace(a,b);}return{source:out,edits};
}
module.exports={transform};
