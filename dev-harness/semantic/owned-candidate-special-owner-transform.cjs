'use strict';
// v3 overlay: only the private prepublication candidate capability can cause
// base captures to omit the exact manifest-created output boundary.
const crypto=require('node:crypto');
function transform(source){
 const edits=[
  ['function createMigrationBackupOwner({ base, readActive, sourceKeys, targetKeys = sourceKeys, native, ownership, assertExclusive, assertExclusiveSync, preservedRead } = {}) {','function createMigrationBackupOwner({ base, readActive, sourceKeys, targetKeys = sourceKeys, native, ownership, assertExclusive, assertExclusiveSync, preservedRead, candidateSource } = {}) {'],
  ["  const preservedTree = preservedRead ? WorkDataTree.createPreserved({ capturePreserved: preservedRead.capturePreserved,","  if(candidateSource!==undefined && (!preservedRead || WorkDataTree.candidateSourceActive(candidateSource)!==true)) migrationCapsuleFail('owner_preserved_host');\n  const preservedTree = preservedRead ? WorkDataTree.createPreserved({ capturePreserved: preservedRead.capturePreserved,"],
  ['    const captured = await preservedTree.capture(base);let result,failed=false,primary;','    const captured = candidateSource!==undefined&&WorkDataTree.candidateSourceActive(candidateSource)?await WorkDataTree.captureCandidateSource(candidateSource,base):await preservedTree.capture(base);let result,failed=false,primary;'],
  ['  const portableCapture = (root, revision) => native\n    ? (typeof native.capturePreserved',"  const portableCapture = (root, revision) => candidateSource!==undefined&&eq(root,base)&&WorkDataTree.candidateSourceActive(candidateSource)\n    ? WorkDataTree.captureCandidateSource(candidateSource,root,revision)\n    : native\n    ? (typeof native.capturePreserved"]
  ,['    await current(owned.expected);\n    return Object.freeze({ ready, storeId: token.storeId, generationId: owned.candidate.id, entries: entries.length });',
   '    await current(owned.expected);\n    owned.candidateBinding=JSON.parse(JSON.stringify(binding));\n    return Object.freeze({ ready, storeId: token.storeId, generationId: owned.candidate.id, entries: entries.length });']
  ,['  async function storedPhysical(backupRef, binding, selected) {',`  async function verifyCandidateStreams(token,captured) {
    const owned=plans.get(token), binding=owned?.candidateBinding;
    if(!owned||!binding||!candidateValid(owned.candidate)||!captured||!eq(captured.root,owned.candidate.root)||!ownership) migrationCapsuleFail('candidate_stream_proof');
    await current(owned.expected);if(assertExclusiveSync(ownership)!==true)migrationCapsuleFail('owner_preserved_host');
    const rows=WorkDataTree.readCapturedNativeManifest(captured,ownership),byPath=new Map(),allowed=new Map();
    const fold=s=>process.platform==='win32'?s.toLowerCase():s;
    const normalized=streams=>streams.map(({name,size,hash})=>({name,size,hash})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    for(const row of rows){const k=fold(row.rel);if(byPath.has(k))migrationCapsuleFail('candidate_stream_proof');byPath.set(k,row);}
    for(const entry of binding.entries){
      if(entry.eligibility!=='eligible'||!Array.isArray(entry.newTree))continue;
      if(typeof entry.physicalSkillId!=='string'||!SKILL_ID_RE.test(entry.physicalSkillId))migrationCapsuleFail('candidate_stream_proof');
      for(const row of entry.newTree){if(!row||typeof row.rel!=='string'||row.rel.split('/').some(p=>p==='..'||p==='.'||p.includes('\\\\'))||!Array.isArray(row.streams))migrationCapsuleFail('candidate_stream_proof');
        if(!row.streams.some(stream=>stream.name!==''))continue;
        const rel='skills/'+entry.physicalSkillId+(row.rel?'/'+row.rel:''),key=fold(rel),expected=JSON.stringify({rel,id:row.id,dir:row.dir,streams:normalized(row.streams)});
        if(allowed.has(key)&&allowed.get(key)!==expected)migrationCapsuleFail('candidate_stream_proof');allowed.set(key,expected);
      }
    }
    for(const [key,expected] of allowed){const row=byPath.get(key);if(!row||JSON.stringify({rel:row.rel,id:row.id,dir:row.dir,streams:normalized(row.streams)})!==expected)migrationCapsuleFail('candidate_stream_proof');}
    for(const row of rows)if(row.streams.some(stream=>stream.name!=='')&&!allowed.has(fold(row.rel)))migrationCapsuleFail('candidate_stream_proof');
    if(assertExclusiveSync(ownership)!==true)migrationCapsuleFail('owner_preserved_host');return true;
  }
  async function storedPhysical(backupRef, binding, selected) {`]
  ,['return Object.freeze({ prepare, prepareBindings, recover, activate, resolve, ref, prepareRepresentation, preparedDelta, recoverRepresentation, recoverPreparedTransition, prepareEmptyCancellation, retireEmptyCancellation, verifyEmptyCancellation, verifyPublished, capturePortable, readInlineProvenance, validatePortable, stagePortable, installPortable, verifyPortableInstalled });','return Object.freeze({ prepare, prepareBindings, verifyCandidateStreams, recover, activate, resolve, ref, prepareRepresentation, preparedDelta, recoverRepresentation, recoverPreparedTransition, prepareEmptyCancellation, retireEmptyCancellation, verifyEmptyCancellation, verifyPublished, capturePortable, readInlineProvenance, validatePortable, stagePortable, installPortable, verifyPortableInstalled });']
 ];let out=source;for(const [i,[a,b]] of edits.entries()){if(out.split(a).length!==2)throw Error('special.owner.boundary.'+i);out=out.replace(a,b);}return{source:out,edits,sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
