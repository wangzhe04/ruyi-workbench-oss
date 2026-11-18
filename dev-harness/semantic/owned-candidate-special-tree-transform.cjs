'use strict';
// v3 overlay: an owner-branded paired raw snapshot for the existing portable
// reader. The complete original NTFS streams remain in the native snapshot.
const crypto=require('node:crypto');
function transform(source){
 const edits=[
  ['  const preservedCaptures = new WeakMap(), capturedFileLeases = new WeakMap(), preservedReadbacks = new WeakMap();','  const preservedCaptures = new WeakMap(), capturedFileLeases = new WeakMap(), preservedReadbacks = new WeakMap(), candidateSources = new WeakMap(), preservedReaders = new WeakSet();'],
  ['  const fileKey = file =>',`  function issueCandidateSource(reader,candidate,active) {
    if(!preservedReaders.has(reader)||!candidate||typeof active!=='function')fail('preserved_owner_required');
    const token=Object.freeze(Object.create(null));candidateSources.set(token,{reader,candidate,active});return token;
  }
  function candidateSourceActive(token) {const known=candidateSources.get(token);if(!known)fail('preserved_owner_required');return known.active()===true;}
  async function captureCandidateSource(token,root,revision) {const known=candidateSources.get(token);if(!known||known.active()!==true)fail('preserved_owner_required');const value=await (revision===undefined?known.reader.capture(root,known.candidate):known.reader.captureNativeRaw(root,known.candidate,revision));if(known.active()!==true){if(revision===undefined)value.release();fail('preserved_owner_required');}return value;}
  function readCapturedNativeManifest(captured,ownership) {const known=preservedCaptures.get(captured);if(!known||known.ownership!==ownership)fail('captured_file_invalid');known.admitSync();known.check();return known.nativeManifest();}
  const fileKey = file =>`],
  ['    async function census(root, retain, candidateBoundary = null) {','    async function census(root, retain, candidateBoundary = null, nativeRevision = null) {'],
  ["      const firstRevision = cryptoApi.randomBytes(32).toString('hex'), revision = cryptoApi.randomBytes(32).toString('hex');","      if(nativeRevision!==null&&!/^[a-f0-9]{64}$/.test(nativeRevision))fail('preserved_native_invalid');\n      const firstRevision = cryptoApi.randomBytes(32).toString('hex'), revision = nativeRevision===null?cryptoApi.randomBytes(32).toString('hex'):nativeRevision;if(firstRevision===revision)fail('preserved_native_invalid');"],
  ["        return { result, nativeSha256: second.nativeSha256, nativeHasExtraStreams: second.rows.some(row=>row.streams.some(stream=>stream.name!=='')) };","        return { result, nativeSha256: second.nativeSha256, nativeHasExtraStreams: second.rows.some(row=>row.streams.some(stream=>stream.name!=='')), nativeRows:Object.freeze(second.rows.map(row=>Object.freeze({rel:row.rel,id:row.id,dir:row.dir,streams:Object.freeze(row.streams.map(stream=>Object.freeze({...stream})))}))), nativeSnapshot:nativeRevision===null?null:snapshot };"],
  ["      const { result: captured, nativeSha256, nativeHasExtraStreams } = await census(root, true, boundary);","      const { result: captured, nativeSha256, nativeHasExtraStreams, nativeRows } = await census(root, true, boundary);"],
  ['      issued.set(result, { proof: proofOf(captured), nativeSha256, nativeHasExtraStreams, boundary, released: () => released });','      issued.set(result, { proof: proofOf(captured), nativeSha256, nativeHasExtraStreams, nativeRows, boundary, released: () => released });'],
  ['      owned.nativeSha256 = actual.nativeSha256;owned.nativeHasExtraStreams=actual.nativeHasExtraStreams;','      owned.nativeSha256 = actual.nativeSha256;owned.nativeHasExtraStreams=actual.nativeHasExtraStreams;owned.nativeRows=actual.nativeRows;'],
  ['preservedCaptures.set(result, { ownership, admit: () => admitted(root), admitSync: () => admittedSync(root), check: () => fingerprint(result), verify: () => verify(result), leases: new Set() });','preservedCaptures.set(result, { ownership, admit: () => admitted(root), admitSync: () => admittedSync(root), check: () => fingerprint(result), verify: () => verify(result), nativeManifest: () => issued.get(result).nativeRows, leases: new Set() });'],
  ['    return Object.freeze({ capture, verify, fingerprint, nativeFingerprint, assertRootId, assertNoNamedStreams });',`    async function captureNativeRaw(root,candidate,revision) {
      if(typeof candidateAuthority!=='function')fail('preserved_owner_required');const boundary=candidateAuthority(candidate,root);if(!boundary)fail('preserved_owner_required');
      const captured=await census(root,false,boundary,revision);await admitted(root);admittedSync(root);return captured.nativeSnapshot;
    }
    const reader=Object.freeze({ capture, verify, fingerprint, nativeFingerprint, assertRootId, assertNoNamedStreams, captureNativeRaw });preservedReaders.add(reader);return reader;`],
  ['create, createPreserved, claimPreservedReadback, claimPreservedReadbackContext, borrowCapturedFile','create, createPreserved, issueCandidateSource, candidateSourceActive, captureCandidateSource, readCapturedNativeManifest, claimPreservedReadback, claimPreservedReadbackContext, borrowCapturedFile']
 ];let out=source;for(const [i,[a,b]] of edits.entries()){if(out.split(a).length!==2)throw Error('special.tree.boundary.'+i);out=out.replace(a,b);}return{source:out,edits,sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
