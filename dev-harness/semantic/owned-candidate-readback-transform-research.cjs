'use strict';
// Research source transform: private candidate brand must be checked by the
// supplied manifest authority. Native/owner integration is required separately.
const crypto=require('node:crypto');
function transform(source){
 const edits=[
  ['  const fileKey = file =>', '  function claimPreservedReadbackContext(token, root, revision) { const known=preservedReadbacks.get(token); if(!known || known.root!==root || known.revision!==revision) return null; preservedReadbacks.delete(token); return Object.freeze({candidateBoundary:known.candidateBoundary||null}); }\n  const fileKey = file =>'],
  ['function createPreserved({ capturePreserved, ownership, assertExclusive, assertExclusiveSync, limits = {} } = {}) {','function createPreserved({ capturePreserved, ownership, assertExclusive, assertExclusiveSync, candidateAuthority, limits = {} } = {}) {'],
  ['      || !ownership || !Array.isArray(ownership.roots)) fail(\'preserved_owner_required\');','      || candidateAuthority !== undefined && typeof candidateAuthority !== \'function\'\n      || !ownership || !Array.isArray(ownership.roots)) fail(\'preserved_owner_required\');'],
  ['    async function census(root, retain) {\n      await admitted(root);','    async function census(root, retain, candidateBoundary = null) {\n      await admitted(root);'],
  ['      preservedReadbacks.set(readback,{root,revision:firstRevision});','      preservedReadbacks.set(readback,{root,revision:firstRevision,candidateBoundary});'],
  ['        if (!binding) {\n          // Hosts implementing only','        if (!binding) {\n          if(candidateBoundary)fail(\'preserved_native_invalid\');\n          // Hosts implementing only'],
  ['        return { result, nativeSha256: second.nativeSha256 };','        return { result, nativeSha256: second.nativeSha256, nativeHasExtraStreams: second.rows.some(row=>row.streams.some(stream=>stream.name!==\'\')) };'],
  ['    async function capture(root) {\n      const { result: captured, nativeSha256 } = await census(root, true);','    async function capture(root, candidate) {\n      const boundary=candidate===undefined?null:(typeof candidateAuthority===\'function\'?candidateAuthority(candidate,root):fail(\'preserved_owner_required\'));\n      if(candidate!==undefined&&!boundary)fail(\'preserved_owner_required\');\n      const { result: captured, nativeSha256, nativeHasExtraStreams } = await census(root, true, boundary);'],
  ['      issued.set(result, { proof: proofOf(captured), nativeSha256, released: () => released });','      issued.set(result, { proof: proofOf(captured), nativeSha256, nativeHasExtraStreams, boundary, released: () => released });'],
  ['      const actual = await census(captured.root, false);\n      if (JSON.stringify(proofOf(actual.result))','      const actual = await census(captured.root, false, owned.boundary);\n      if (JSON.stringify(proofOf(actual.result))'],
  ['      owned.nativeSha256 = actual.nativeSha256;','      owned.nativeSha256 = actual.nativeSha256;owned.nativeHasExtraStreams=actual.nativeHasExtraStreams;'],
  ['    return Object.freeze({ capture, verify, fingerprint, nativeFingerprint });','    function assertRootId(captured,expected) { const value=issued.get(captured); if(!value || value.released() || !/^[a-f0-9]{24}$/.test(expected||\'\')) fail(\'snapshot_unavailable\'); const parts=value.proof.rootIdentity.split(\':\'); if(parts.length!==2 || BigInt(parts[0]).toString(16).padStart(8,\'0\')+BigInt(parts[1]).toString(16).padStart(16,\'0\')!==expected) fail(\'source_changed\'); return true; }\n    function assertNoNamedStreams(captured) { const value=issued.get(captured); if(!value || value.released() || value.nativeHasExtraStreams) fail(\'source_changed\'); return true; }\n    return Object.freeze({ capture, verify, fingerprint, nativeFingerprint, assertRootId, assertNoNamedStreams });'],
  ['create, createPreserved, claimPreservedReadback, borrowCapturedFile','create, createPreserved, claimPreservedReadback, claimPreservedReadbackContext, borrowCapturedFile']
 ];let out=source;for(const [index,[a,b]] of edits.entries()){if(out.split(a).length!==2)throw Error('readback.boundary.'+index);out=out.replace(a,b);}return {source:out,edits,sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
