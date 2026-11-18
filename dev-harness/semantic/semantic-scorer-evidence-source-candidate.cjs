'use strict';
// Read-only extraction of the promoted private scorer. The prior public issuer
// recipe is retired and cannot be used to reconstruct a writable score registry.
const fs=require('node:fs'),crypto=require('node:crypto'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){if(!source.includes('function sealScoreEvidence(')||!source.includes('const scoreEvidenceRecords=new WeakMap()')||!source.includes('readScoreEvidence,windowPolicy:SemanticWindowPolicy,admissionRequest:SemanticAdmissionRequest,hasScoreEvidence:'))throw Error('private scorer required');return {source,recipe:[],alreadyPromoted:true,originalSha256:hash(source),derivedSha256:hash(source),transformerSha256:hash(fs.readFileSync(__filename))};}
module.exports={transform};
