'use strict';
// Candidate-only no-native replay wiring. Not a production runtime or an encoder.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const H=x=>crypto.createHash('sha256').update(x).digest('hex');
function make(){const file=path.resolve(__dirname,'../../output/granite-gemma-development-v1/gemma/vectors.json'),bytes=fs.readFileSync(file);if(H(bytes)!=='5092ada08a787545f7171f8270cc9c40e960e63858af32d3a254a4628b825c7c')throw Error('replay.input_changed');const input=JSON.parse(bytes);if(input.name!=='gemma'||input.status!=='COMPLETE_340_COLLECTION'||input.rows.length!==340)throw Error('replay.input_invalid');return require('./gemma-q4-commonjs-replay.cjs').createReplay(input.rows,{available:true,state:'ready',modelId:'embeddinggemma-300m-full-sentence-q4',modelNamespace:'2cf9f234e37e11c67f5c1d228944eb94cabbfc79092adaba238e8622b044cbba',modelFingerprint:'sha256:'+H('RESEARCH_NO_NATIVE_REPLAY:e3496e9bc6d03638e1557f919089714b11a111e1fa80082c4be4c7a9becf7ae8'),dimensions:768,pooling:'sentence_embedding',retrievalThresholds:{search:.4,automatic:null}});}
module.exports={make};
