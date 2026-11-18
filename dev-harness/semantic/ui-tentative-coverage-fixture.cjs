'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto'),vm=require('node:vm');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(options={}){const file=require.resolve('./scalar-scan-stat-fixture.cjs');let source=fs.readFileSync(file,'utf8');if(hash(source)!=='becacd73dd0c6d80bb60f1d12589ade82be122e11d76032fa52fd3d240e2a767')throw Error('Source fixture pin changed');const before="one(\"'./scalar-live-research-layout.cjs'\",\"'./scalar-scan-stat-layout.cjs'\")";if(source.split(before).length!==2)throw Error('Fixture layout boundary changed');source=source.replace(before,"one(\"'./scalar-live-research-layout.cjs'\",\"'./ui-tentative-coverage-layout.cjs'\")");const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,file);const f=await compiled.exports.fixture(options);if(options.producerTiming)f.context.ResearchProducerTiming=options.producerTiming;
 if(!options.scalarHost){const original=fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js','utf8');const normalize=vm.runInNewContext(original.match(/^  const canonicalText=.*;$/m)[0]+'\n'+original.match(/^  const normalize=.*;$/m)[0]+'\nnormalize;');f.context.ResearchScalarComposite=require('./bge-zh-coarse-policy.cjs').createCoarsePolicy({identify:f.context.SemanticRetrieval.structuredIds,normalize,terms:f.api.terms});}
 return f;
}
module.exports={fixture};
