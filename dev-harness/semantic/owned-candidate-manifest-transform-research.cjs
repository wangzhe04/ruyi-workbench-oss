'use strict';
// Research transform only. Native allocator must independently authenticate the
// actual owner and prior intent; this callback is not itself an authority.
const crypto=require('node:crypto'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){
 const edits=[
  ['function create({ base, publish: explicitPublish } = {}) {','function create({ base, publish: explicitPublish, researchCandidateAllocator } = {}) {'],
  ['    const candidates = new WeakMap();','    const candidates = new WeakMap(), researchCandidateState = new WeakMap(), researchBoundaries = new WeakMap();\n    const researchCandidateIssued = candidate => ["creating", "created"].includes(researchCandidateState.get(candidate));\n    const researchCandidateReady = candidate => researchCandidateState.get(candidate) === "created";\n    const researchCandidateBoundary = (candidate,sourceProof) => { const known=researchBoundaries.get(candidate); if(!researchCandidateReady(candidate) || !known || !sourceProof || digest(JSON.stringify({sourceFiles:sourceProof.sourceFiles,sourceDirectories:sourceProof.sourceDirectories}))!==known.baselineSha256) throw error("candidate_invalid"); return known.boundary; };'],
  [
`      try { await fsApi.mkdir(target); } catch (cause) { throw error('prepare_failed', cause); }
      await directory(target);
      const pointer = { schema: SCHEMA, generation: previous.generation + 1, id, mode, activeRoot: 'generations/' + id };
      const candidate = Object.freeze({ ...pointer, root: target, pointerProof: pointerProof(JSON.stringify(pointer) + '\\n') });
      candidates.set(candidate, Object.freeze({ proof, generation: candidate.generation, mode, root: target }));
      return candidate;`,
`      const pointer = { schema: SCHEMA, generation: previous.generation + 1, id, mode, activeRoot: 'generations/' + id };
      const candidate = Object.freeze({ ...pointer, root: target, pointerProof: pointerProof(JSON.stringify(pointer) + '\\n') });
      if (researchCandidateAllocator === undefined) {
        try { await fsApi.mkdir(target); } catch (cause) { throw error('prepare_failed', cause); }
      } else {
        if (typeof researchCandidateAllocator !== 'function') throw error('prepare_failed');
        researchCandidateState.set(candidate, 'creating');
        try {
          const created=await researchCandidateAllocator({ candidate, root, expected: proof, assertIssued: researchCandidateIssued });
          if(!created || created.candidate!==candidate || created.root!==target || !/^[a-f0-9]{24}$/.test(created.id||'') || !/^[a-f0-9]{64}$/.test(created.baselineSha256||'') || !Array.isArray(created.parents) || created.parents.length!==3 || created.parents.some(id=>!/^[a-f0-9]{24}$/.test(id||''))) throw error('candidate_invalid');
          researchBoundaries.set(candidate,Object.freeze({baselineSha256:created.baselineSha256,boundary:Object.freeze({rel:'.work-data/generations/'+id,id:created.id,parents:Object.freeze([...created.parents])})}));
        }
        catch (cause) { researchCandidateState.set(candidate, 'failed'); throw error('prepare_failed', cause); }
      }
      try { await directory(target); } catch(cause) { if(researchCandidateAllocator !== undefined) researchCandidateState.set(candidate, 'failed'); throw cause; }
      if(researchCandidateAllocator !== undefined) researchCandidateState.set(candidate, 'created');
      candidates.set(candidate, Object.freeze({ proof, generation: candidate.generation, mode, root: target }));
      return candidate;`],
  ['return Object.freeze({ readActive, readCaptured, prepare, commit });','return Object.freeze({ readActive, readCaptured, prepare, commit, researchCandidateIssued, researchCandidateReady, researchCandidateBoundary });']
 ];
 let out=source;for(const [before,after] of edits){if(out.split(before).length!==2)throw Error('manifest.boundary');out=out.replace(before,after);}return {source:out,edits,originalSha256:hash(source),derivedSha256:hash(out)};
}
module.exports={transform};
