'use strict';
// Actual owner/source/PG/UI fixture with an explicit source-owner witness delta.
// All compilation outputs are owned research copies, never production writes.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(options={}){
  const directory=path.resolve(options.researchDirectory||'output/semantic-scan-stat-fakes');fs.mkdirSync(directory,{recursive:true});
  const owner=require('./scalar-scan-stat-source.cjs').transform(fs.readFileSync('ruyi-workbench/app/src/02-session-store.js','utf8'));
  const ownerPath=path.join(directory,'session-owner-'+owner.transformedSha256+'.js');if(!fs.existsSync(ownerPath))fs.writeFileSync(ownerPath,owner.source,{flag:'wx'});
  const basePath=require.resolve('../lib/work-data-session-fulltext-fixture.js');let base=fs.readFileSync(basePath,'utf8');const baseRecipe=[];
  if(hash(base)!=='55bc93e4cb744af0e617373c0908090dbf105d9330b52e5c63980b671e190c44')throw Error('Frozen actual source fixture changed.');
  const replace=(before,after)=>{if(base.split(before).length!==2)throw Error('Owner fixture boundary changed.');base=base.replace(before,after);baseRecipe.push({before,after});};
  replace("const root=path.resolve(__dirname,'../..');",'const root='+JSON.stringify(path.resolve(__dirname,'../..'))+';');
  replace("fs.readFileSync(selected('02-session-store.js'),'utf8')",'fs.readFileSync('+JSON.stringify(ownerPath)+",'utf8')");
  replace('const context={require,',"const scanWitness=require("+JSON.stringify(require.resolve('./scalar-scan-stat-witness.cjs'))+").createWitness(fx.store,keys);\n  const context={ResearchScanWitness:scanWitness,require,");
  replace('const hookContext={require,','const hookContext={ResearchScanWitness:scanWitness,require,');
  replace('return {directory,sessions,index,host,api,fx,context,hookContext,keys,master,instanceId,catalog,allowed,put,','return {scanWitness,sourceWitnessContext:context,directory,sessions,index,host,api,fx,context,hookContext,keys,master,instanceId,catalog,allowed,put,');
  const helperPath=path.join(directory,'source-fixture-'+hash(base)+'.cjs');if(!fs.existsSync(helperPath))fs.writeFileSync(helperPath,base,{flag:'wx'});
  const publicPath=require.resolve('./scalar-public-consumer-fixture.cjs');let source=fs.readFileSync(publicPath,'utf8');
  if(hash(source)!=='6d13221aadf1c12bc3dcbd64a4bcea5532e0abf179d20341ff40fb8464a7f773')throw Error('Frozen public fixture changed.');
  const one=(before,after)=>{if(source.split(before).length!==2)throw Error('Scan-stat public fixture boundary changed.');source=source.replace(before,after);};
  one("'./scalar-live-research-layout.cjs'","'./scalar-scan-stat-layout.cjs'");one("'./scalar-composite-policy-research.cjs'","'./scalar-window-policy-research.cjs'");
  one("compiled._compile(helper.replace(before, after).replace(projectionBefore, projectionAfter), helperPath);",
    "compiled._compile(helper.replace(before, after).replace(projectionBefore, projectionAfter).replace(\"require('./work-data-session-fulltext-fixture.js')\", "+JSON.stringify('require('+JSON.stringify(helperPath)+')')+"), helperPath);");
  const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
  const f=await compiled.exports.fixture({...options,researchDirectory:directory});
  return {...f,sourceWitnessRecipe:{ownerSha256:owner.transformedSha256,recipe:owner.recipe,baseRecipe,baseSha256:hash(fs.readFileSync(basePath)),derivedBaseSha256:hash(base),witnessSha256:hash(fs.readFileSync(require.resolve('./scalar-scan-stat-witness.cjs')))}};
}
module.exports={fixture};
