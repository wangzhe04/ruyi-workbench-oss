'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {transform}=require('./owned-candidate-proof-issue-research.cjs');
const source=fs.readFileSync('output/semantic-owned-current-real-enable-v3/source-input/ruyi-workbench/app/src/13u-migration-center.js','utf8');
test('issuer layers on candidate handles and original guarded census with exact inverse',()=>{
 const built=transform(source);let reversed=built.source;
 for(const [before,after] of [...built.edits].reverse()){assert.equal(reversed.split(after).length,2);reversed=reversed.replace(after,before);}
 assert.equal(reversed,source);
 for(const required of ['ResearchCandidateAuth(args)','CapturePreservedCensusFirst(request)','ResearchCandidateIds.TryGetValue(rel,out known)','seenFiles.Count!=expected.Count','ResearchVerifyCandidateProof(args,Snapshot)','VerifyCapturedBasicUnchanged(new List<Node>(Nodes.Values))'])assert.ok(built.source.includes(required),required);
});
