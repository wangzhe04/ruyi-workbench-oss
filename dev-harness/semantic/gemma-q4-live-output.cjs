'use strict';
function fullSentenceEmbedding(output){const hidden=output?.sentence_embedding;if(!hidden||JSON.stringify(hidden.dims)!=='[1,768]')throw Error('INVALID_FULL_SENTENCE_EMBEDDING');const vector=Array.from(hidden.data,Number),norm=Math.hypot(...vector);if(vector.length!==768||!vector.every(Number.isFinite)||!Number.isFinite(norm)||Math.abs(norm-1)>1e-4)throw Error('INVALID_MODEL_OUTPUT');return vector;}
module.exports={fullSentenceEmbedding};
