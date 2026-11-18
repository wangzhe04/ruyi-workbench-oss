'use strict';
// Non-intrusive timing variant of the frozen append/window source. No proof,
// deadline, admission, reuse or source-read is removed or added by this recipe.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const basePath = require.resolve('./scalar-window-append-live-layout.cjs'), hash = value => crypto.createHash('sha256').update(value).digest('hex');
function layout(directory) {
  if (hash(fs.readFileSync(basePath)) !== '262736ee886f81c11330eb0b5ff604b2d3046ddf70d849fbba1ef186d3f7a462') throw Error('Frozen append layout changed.');
  const prior = require(basePath).layout(directory); let source = fs.readFileSync(prior.modulePath, 'utf8'); const recipe = [];
  const one = (before, after) => { if (source.split(before).length !== 2) throw Error('Producer timing boundary changed: ' + before.slice(0, 65)); source = source.replace(before, after); recipe.push({ before, after }); };
  one("const sessionResults=host.resultUnit==='sessions';", `const researchTiming=typeof ResearchProducerTiming!=='undefined'?ResearchProducerTiming:null;
    const researchMeasure=(name,work)=>researchTiming?researchTiming.measure(name,work):work();
    if(researchTiming){const originalHost=host;host={...host};for(const name of ['epoch','scan','authorize','scope','catalog','project','enabled'])if(typeof originalHost[name]==='function')host[name]=(...args)=>researchMeasure('host.'+name,()=>Reflect.apply(originalHost[name],originalHost,args));
      for(const name of ['assertScope','assertAuthorized','authorizedEpoch','authorizedEmpty'])if(typeof originalHost[name]==='function')host[name]=(...args)=>researchTiming.measureSync('host.'+name,()=>Reflect.apply(originalHost[name],originalHost,args));
      host.sourceSequence=(...args)=>{researchTiming.count('host.sourceSequence');return Reflect.apply(originalHost.sourceSequence,originalHost,args);};}
    const sessionResults=host.resultUnit==='sessions';`);
  one('const read=async(sid,name,max)=>{', 'const readImplementation=async(sid,name,max)=>{');
  one("const write=async(sid,name,value,max,policy=undefined,check=undefined)=>", "const read=(...args)=>researchMeasure('index.read.'+(args[1]==='manifest.json'?'manifest':'shard'),()=>readImplementation(...args));\n    const write=async(sid,name,value,max,policy=undefined,check=undefined)=>");
  one('const beforeEncode=async()=>{', 'const beforeEncodeImplementation=async()=>{');
  one('const resolveTexts=async indices=>{', "const beforeEncode=()=>researchMeasure('phase.beforeEncode',()=>beforeEncodeImplementation());\n        const resolveTextsImplementation=async indices=>{");
  one('semanticState=await semantic.score(query,semanticRows.map(row=>row.text),', "const resolveTexts=(...args)=>researchMeasure('phase.resolveTexts',()=>resolveTextsImplementation(...args));\n        semanticState=await researchMeasure('phase.coarse',()=>semantic.score(query,semanticRows.map(row=>row.text),");
  one("deadline:semanticDeadline,...(options.signal?{signal:options.signal}:{})});researchCheck();", "deadline:semanticDeadline,...(options.signal?{signal:options.signal}:{})}));researchCheck();");
  one('const sourceCoverage=await rawCoverage({context,access,seen:new Set(),sequences:new Map()},{check:researchCheck,timeout:researchTimeout});', "const sourceCoverage=await researchMeasure('phase.coverage.preVerifier',()=>rawCoverage({context,access,seen:new Set(),sequences:new Map()},{check:researchCheck,timeout:researchTimeout}));");
  one('scalarDecision=await scalarComposite.evaluate({query,rows:rawRows,', "scalarDecision=await researchMeasure('phase.scalarEvaluate',()=>scalarComposite.evaluate({query,rows:rawRows,");
  one('scopeId:access.scopeId,signal:options.signal,deadline:semanticDeadline,resolve,beforeVerify});researchCheck();', 'scopeId:access.scopeId,signal:options.signal,deadline:semanticDeadline,resolve,beforeVerify}));researchCheck();');
  one('coverageState=await rawCoverage({context,access,seen:covered,sequences:coverageSequences},{...options,reuse:coverageReuse,observed:observedManifests});check();', "coverageState=await researchMeasure('phase.coverage.final',()=>rawCoverage({context,access,seen:covered,sequences:coverageSequences},{...options,reuse:coverageReuse,observed:observedManifests}));check();");
  one('const sourceCoverage=await rawCoverage({context,access,seen:new Set(),sequences:new Map()},{check,timeout:options.timeout});', "const sourceCoverage=await researchMeasure('phase.coverage.emptyEligible',()=>rawCoverage({context,access,seen:new Set(),sequences:new Map()},{check,timeout:options.timeout}));");
  const modulePath = path.join(directory, 'producer-timing-' + hash(source) + '.cjs');
  if (fs.existsSync(modulePath)) { if (hash(fs.readFileSync(modulePath)) !== hash(source)) throw Error('Timing source differs.'); }
  else fs.writeFileSync(modulePath, source, { flag: 'wx' });
  return { ...prior, modulePath, producer: { ...prior.producer, transformedSha256: hash(source), timingRecipe: recipe }, layoutScriptSha256: hash(fs.readFileSync(__filename)) };
}
module.exports = { layout };
