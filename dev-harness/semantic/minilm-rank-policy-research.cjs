'use strict';
// Fixed historical MiniK4/.95 choice. No grid, new labels or default change.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const windowFile=path.join(__dirname,'scalar-window-policy-research.cjs'),baseFile=path.join(__dirname,'scalar-composite-policy-research.cjs');
if(hash(fs.readFileSync(windowFile))!=='1d7eccdd39bdd3005d701164361504a5d18c5e0d70aef84dcba04857f8fd3ff6')throw Error('minilm.window_policy_source_changed');
const prior=require(windowFile);let source=fs.readFileSync(baseFile,'utf8');if(hash(source)!==prior.transformation.baseSha256)throw Error('minilm.policy_base_changed');
for(const {before,after}of prior.transformation.recipe){if(source.split(before).length!==2)throw Error('minilm.window_recipe_changed');source=source.replace(before,after);}
if(hash(source)!==prior.transformation.transformedCodeSha256)throw Error('minilm.window_reconstruction_changed');
const before="id: 'qwen-prior-evidence-global-k1-rank095-best-field-window-v2', topK: 1",after="id: 'minilm-global-k4-rank095-best-field-window-v2', topK: 4";
if(source.split(before).length!==2)throw Error('minilm.k4_boundary_changed');source=source.replace(before,after);
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
module.exports={...compiled.exports,transformation:Object.freeze({priorPolicySha256:hash(fs.readFileSync(windowFile)),priorTransformedSha256:prior.transformation.transformedCodeSha256,recipe:[{before,after}],transformedCodeSha256:hash(source)})};
