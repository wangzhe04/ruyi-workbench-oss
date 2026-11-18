'use strict';
// Frozen Chinese-only development policy. No scalar model or probability bridge.
const fs=require('node:fs'),crypto=require('node:crypto'),Module=require('node:module');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),protocolPath=require.resolve('./bge-chinese-only-development-protocol.json'),protocol=JSON.parse(fs.readFileSync(protocolPath));
if(hash(fs.readFileSync(protocolPath))!=='4eec51a7de65c469cd0f780d904e8dd0a3ccf7d6f305fa7dc5579f12ca60cb8b')throw Error('Chinese-only protocol changed.');
const basePath=require.resolve('./scalar-composite-policy-research.cjs'),windowPath=require.resolve('./scalar-window-policy-research.cjs');
if(hash(fs.readFileSync(basePath))!=='cd7b52943b834269e989b084cef23a486d605390a7c09589fd0a27a718e4bf6c'||hash(fs.readFileSync(windowPath))!=='1d7eccdd39bdd3005d701164361504a5d18c5e0d70aef84dcba04857f8fd3ff6')throw Error('Audited window policy changed.');
const window=require(windowPath).transformation;let source=fs.readFileSync(basePath,'utf8');for(const step of window.recipe){if(source.split(step.before).length!==2)throw Error('Window recipe boundary drift.');source=source.replace(step.before,step.after);}if(hash(source)!==window.transformedCodeSha256)throw Error('Window reconstruction changed.');
const recipe=[],one=(before,after)=>{if(source.split(before).length!==2)throw Error('BGE policy boundary changed: '+before.slice(0,60));source=source.replace(before,after);recipe.push({before,after});};
one("id: 'qwen-prior-evidence-global-k1-rank095-best-field-window-v2', topK: 1, threshold: .95,", "id: 'bge-zh-original-window-global-k1-cos053-v1', topK: 1, threshold: .53, scoreKind:'cosine-not-probability', verifier:null,");
one('fixed-best-eligible-original96-overlap16-before-scalar;', 'fixed-best-eligible-original96-overlap16-before-cosine-admission;');
one('function createCompositePolicy({ bridge, identify, normalize, terms }) {','function createCompositePolicy({ identify, normalize, terms }) {');
one("if (typeof bridge?.verify !== 'function' || [identify, normalize, terms].some(value => typeof value !== 'function'))", "if ([identify, normalize, terms].some(value => typeof value !== 'function'))");
const start=source.indexOf('    const verified = items.length ?'),end=source.indexOf('    if (!Array.isArray(verified.results)',start);if(start<0||end<=start)throw Error('BGE decision boundary changed.');
const before=source.slice(start,end),after=`    // Each exact admitted window consumes its own already-computed cosine.
    // No extra inference and no independent window search after a rejection.
    const results=items.map(item=>{const values=item.uses.map(use=>scores[use.index]);
      if(values.some(value=>!Number.isFinite(value)))return {accepted:null,score:null,cached:false};
      if(values.some(value=>value < -1.00001||value > 1.00001||Math.abs(value-values[0])>1e-12))throw Error('bge.window_score_mismatch');
      return {accepted:values[0]>=CONTRACT.threshold,score:values[0],cached:false};});
    const verified={status:results.every(result=>result.accepted!==null)?'complete':'partial',results,
      coverage:{complete:results.every(result=>result.accepted!==null),total:items.length,completed:results.filter(result=>result.accepted!==null).length}};
`;
source=source.slice(0,start)+after+source.slice(end);recipe.push({before,after});
one('scalarPairs: items.length, requiredWork, strongEvidence,', 'scalarPairs:0, coarseAdmissionWindows:items.length, requiredWork, strongEvidence,');
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
module.exports={...compiled.exports,createCoarsePolicy:compiled.exports.createCompositePolicy,protocol,transformation:Object.freeze({baseSha256:window.transformedCodeSha256,recipe,derivedSha256:hash(source),protocolSha256:hash(fs.readFileSync(protocolPath))})};
