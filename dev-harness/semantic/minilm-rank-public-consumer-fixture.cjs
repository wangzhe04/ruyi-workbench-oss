'use strict';
// Actual consumer/source fixture; select only explicit MiniK4 policy variants.
const fs=require('node:fs'),crypto=require('node:crypto'),Module=require('node:module');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const base=require.resolve('./scalar-public-consumer-fixture.cjs'),layout=require.resolve('./scalar-window-append-live-layout.cjs');
if(hash(fs.readFileSync(base))!=='6d13221aadf1c12bc3dcbd64a4bcea5532e0abf179d20341ff40fb8464a7f773'||hash(fs.readFileSync(layout))!=='262736ee886f81c11330eb0b5ff604b2d3046ddf70d849fbba1ef186d3f7a462')throw Error('minilm.consumer_fixture_source_changed');
function forVariant(variant='raw'){if(!['raw','cutoff034'].includes(variant))throw Error('minilm.variant_invalid');let source=fs.readFileSync(base,'utf8');const recipe=[];
 for(const [before,after]of [["'./scalar-live-research-layout.cjs'","'./scalar-window-append-live-layout.cjs'"],["'./scalar-composite-policy-research.cjs'",variant==='raw'?"'./minilm-rank-policy-research.cjs'":"'./minilm-rank-cutoff-policy-research.cjs'"]]){if(source.split(before).length!==2)throw Error('minilm.fixture_boundary_changed');source=source.replace(before,after);recipe.push({before,after});}
 const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);return {...compiled.exports,transformation:{baseSha256:hash(fs.readFileSync(base)),layoutSha256:hash(fs.readFileSync(layout)),recipe,transformedSha256:hash(source)}};
}
module.exports={forVariant};
