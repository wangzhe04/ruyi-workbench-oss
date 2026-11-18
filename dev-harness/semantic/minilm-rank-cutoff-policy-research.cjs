'use strict';
// Second explicit predeclared point: existing.34 semantic cutoff, sameK4/.95.
// Weak lexical and metadata supplement still receive their own window proof.
const fs=require('node:fs'),crypto=require('node:crypto'),Module=require('node:module');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const window=require('./scalar-window-policy-research.cjs'),mini=require('./minilm-rank-policy-research.cjs');let source=fs.readFileSync(require.resolve('./scalar-composite-policy-research.cjs'),'utf8');
for(const {before,after}of [...window.transformation.recipe,...mini.transformation.recipe]){if(source.split(before).length!==2)throw Error('minilm.cutoff_recipe_changed');source=source.replace(before,after);}
if(hash(source)!==mini.transformation.transformedCodeSha256)throw Error('minilm.raw_policy_changed');
const recipe=[];function one(before,after){if(source.split(before).length!==2)throw Error('minilm.cutoff_boundary_changed');source=source.replace(before,after);recipe.push({before,after});}
one("id: 'minilm-global-k4-rank095-best-field-window-v2'","id: 'minilm-cutoff034-global-k4-rank095-best-field-window-v2'");
one('coarseThreshold: null, strong:',"coarseThreshold: .34, semanticCutoff: 'after-global-K-before-strong; weak-lexical-and-metadata-work-unchanged', strong:");
one('const selected = order.slice(0, CONTRACT.topK).map(item => item.index)', 'const selected = order.slice(0, CONTRACT.topK).filter(item => item.score >= CONTRACT.coarseThreshold).map(item => item.index)');
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
module.exports={...compiled.exports,transformation:Object.freeze({priorTransformedSha256:mini.transformation.transformedCodeSha256,recipe,transformedCodeSha256:hash(source)})};
