'use strict';
// Independent owner/fixture derivative, audited scan-stat/public consumer intact.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),vm=require('node:vm'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(options={}){
 const file=require.resolve('./scalar-scan-stat-fixture.cjs');let source=fs.readFileSync(file,'utf8');if(hash(source)!=='becacd73dd0c6d80bb60f1d12589ade82be122e11d76032fa52fd3d240e2a767')throw Error('Frozen source fixture changed');
 const one=(before,after)=>{if(source.split(before).length!==2)throw Error('Sequence fixture exact boundary changed');source=source.replace(before,after);};
 one("require('./scalar-scan-stat-source.cjs')","require('./source-sequence-memo-research.cjs')");
 one("const helperPath=path.join(directory,'source-fixture-'+hash(base)+'.cjs');", "replace('...names.map(name=>functionBlock(store,name))',\"constBlock(store,'SESSION_FULLTEXT_SEQUENCE_MEMO'),...names.map(name=>functionBlock(store,name))\");\n  const helperPath=path.join(directory,'source-fixture-'+hash(base)+'.cjs');");
 const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));compiled._compile(source,file);const f=await compiled.exports.fixture(options);
 if(options.producerTiming)f.context.ResearchProducerTiming=options.producerTiming;
 if(!options.scalarHost){const original=fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js','utf8');if(hash(original)!=='90a0191d29307ba1f5582f4073bb7a01dc311f5a72481bbc06b01ee3a084a15f'){await f.close();throw Error('Producer changed');}const normalize=vm.runInNewContext(original.match(/^  const canonicalText=.*;$/m)[0]+'\n'+original.match(/^  const normalize=.*;$/m)[0]+'\nnormalize;');f.context.ResearchScalarComposite=require('./bge-zh-coarse-policy.cjs').createCoarsePolicy({identify:f.context.SemanticRetrieval.structuredIds,normalize,terms:f.api.terms});}
 return {...f,sequenceMemoRecipe:{fixtureSha256:hash(source),ownerSha256:f.sourceWitnessRecipe.ownerSha256}};
}
module.exports={fixture};
