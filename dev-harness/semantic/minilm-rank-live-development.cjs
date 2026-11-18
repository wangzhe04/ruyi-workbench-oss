'use strict';
// Finite adaptation of the originale6 runner; it remains byte-stable.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const base=require.resolve('./scalar-composite-live-development.cjs');
function forVariant(variant='raw'){if(!['raw','cutoff034'].includes(variant))throw Error('minilm.variant_invalid');if(hash(base)!=='e6b152e79bf5f07f375d2a1f704a93e3de34ce6ce09cbe02bde57f6e3fda6ff1')throw Error('minilm.runner_base_changed');let source=fs.readFileSync(base,'utf8');const recipe=[];
 const replace=(before,after)=>{if(source.split(before).length!==2)throw Error('minilm.runner_boundary_changed');source=source.replace(before,after);recipe.push({before,after});};
 replace("const { fixture } = require('./scalar-window-append-public-consumer-fixture.cjs');","const { fixture } = require('./minilm-rank-public-consumer-fixture.cjs').forVariant('"+variant+"');");
 replace("const { CONTRACT: windowContract } = require('./scalar-window-policy-research.cjs');","const { CONTRACT: windowContract } = require('"+(variant==='raw'?'./minilm-rank-policy-research.cjs':'./minilm-rank-cutoff-policy-research.cjs')+"');");
 replace('raw global eligibleK1 plus scalar>=.95;',variant==='raw'?'raw global eligibleK4 plus scalar>=.95;':'global eligibleK4 then existing semantic cosine>=.34 plus scalar>=.95; weak lexical independent of cutoff;');
 const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
 const derivedSha256=crypto.createHash('sha256').update(source).digest('hex');
 return {...compiled.exports,transformation:{baseSha256:hash(base),recipe,derivedSha256}};
}
async function main(){const [directory,variant='raw',expected]=process.argv.slice(2);if(!directory||!['raw','cutoff034'].includes(variant)||expected!==hash(__filename))throw Error('Use <new-output-directory> <raw|cutoff034> <reviewed-runner-sha256>.');const profile=require('./minilm-rank-live-profile.cjs').create({variant});const controller=new AbortController();for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>controller.abort(Error('research.cancelled')));const result=await forVariant(variant).run({directory,profile,controller});if(result.failed)process.exitCode=1;}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={forVariant};
