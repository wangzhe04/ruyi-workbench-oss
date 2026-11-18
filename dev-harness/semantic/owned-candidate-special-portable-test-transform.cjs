'use strict';
// Explicitly models candidate FILE_CREATE and paired native source capture in
// the existing real special-owner fixture. Does not execute native processes.
function transform(source){
 const old=` const capturePreserved=async(root,revision)=>{
  const captured=await f.special.native.capture(root,revision);
  for(const row of captured.entries){
   const stat=await fsp.lstat(path.join(root,...row.rel.split('/')),{bigint:true});
   row.id=stat.dev.toString(16).padStart(8,'0')+stat.ino.toString(16).padStart(16,'0');
  }
  return captured;
 };`;
 const replacement=` const capturePreserved=async(root,revision,readback)=>{
  const take=async rev=>{const captured=await f.special.native.capture(root,rev);for(const row of captured.entries){const stat=await fsp.lstat(path.join(root,...row.rel.split('/')),{bigint:true});row.id=stat.dev.toString(16).padStart(8,'0')+stat.ino.toString(16).padStart(16,'0');}return captured;};
  if(!readback)return take(revision);
  const context=f.api.WorkDataTree.claimPreservedReadbackContext(readback,root,revision);if(!context)throw Error('unissued');
  const capture=async rev=>{const result=await take(rev),prefix=context.candidateBoundary?.rel;if(prefix)result.entries=result.entries.filter(row=>row.rel!==prefix&&!row.rel.startsWith(prefix+'/'));return result;};
  await readback.bind(await capture(revision));return capture(readback.revision);
 };`;
 const before=' const host=f.api.WorkDataMigrationHost.create({base,ownership,manifest:f.manifest,protector:f.protector,assertExclusive:()=>true,assertExclusiveSync:()=>true,';
 const after=` const nativeId=async file=>{const s=await fsp.stat(file,{bigint:true});return s.dev.toString(16).padStart(8,'0')+s.ino.toString(16).padStart(16,'0');};
 const manifest=f.api.WorkDataManifest.create({base,publish:async request=>fsp.rename(request.stage,request.target),researchCandidateAllocator:async({candidate})=>{await fsp.mkdir(candidate.root);return{candidate,root:candidate.root,id:await nativeId(candidate.root),parents:[await nativeId(base),await nativeId(path.join(base,'.work-data')),await nativeId(path.join(base,'.work-data','generations'))],baselineSha256:crypto.createHash('sha256').update(JSON.stringify({sourceFiles:sourceProof.sourceFiles,sourceDirectories:sourceProof.sourceDirectories})).digest('hex')};}});
 const host=f.api.WorkDataMigrationHost.create({base,ownership,manifest,protector:f.protector,assertExclusive:()=>true,assertExclusiveSync:()=>true,`;
 const edits=[[old,replacement,2],[before,after,2]];let out=source;for(const [i,[a,b,n]] of edits.entries()){if(out.split(a).length!==n+1)throw Error('special.test.boundary.'+i);out=out.split(a).join(b);}return {source:out,edits};
}
module.exports={transform};
