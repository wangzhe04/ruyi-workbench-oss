'use strict';
function guardedReference(reference,phase,counts){return {get(key){const mode=phase();if(!['warmup','quality'].includes(mode))throw Error('gemma.live.comparison_scope');const value=reference.get(key);if(!value){if(mode==='quality'){counts.qualityUnmatched++;throw Error('gemma.live.quality_vector_reference_missing');}counts.warmupUnmatched++;}return value;}};}
function fullyWarmed(result,complete){return complete(result)&&result?.semantic?.candidateFragments===60&&result?.semantic?.cachedFragments===60;}
module.exports={guardedReference,fullyWarmed};
