'use strict';
// Derived actual producer/consumer runner. No detailed phase observer, fetch
// monkeypatch, per-transport clocks or event array. Outer request timings and
// actual native/vector/verdict cache counters remain as in the frozen driver.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const basePath=require.resolve('./scalar-composite-live-development.cjs'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
let source=fs.readFileSync(basePath,'utf8');if(hash(source)!=='e6b152e79bf5f07f375d2a1f704a93e3de34ce6ce09cbe02bde57f6e3fda6ff1')throw Error('Frozen live runner changed.');
const recipe=[],one=(before,after)=>{if(source.split(before).length!==2)throw Error('Unobserved runner boundary changed.');source=source.replace(before,after);recipe.push({before,after});};
one("require('./scalar-window-append-public-consumer-fixture.cjs')","require('./scalar-scan-stat-live-fixture.cjs')");
one("const sources = ['scalar-composite-live-development.cjs',", "const sources = ['scalar-scan-stat-live-development.cjs','scalar-scan-stat-live-fixture.cjs','scalar-scan-stat-layout.cjs','scalar-scan-stat-source.cjs','scalar-scan-stat-witness.cjs','scalar-scan-stat-fixture.cjs','scalar-coverage-reuse-layout.cjs','scalar-producer-timing-layout.cjs','scalar-composite-live-development.cjs',");
one("sources.push(...['13ap-session-fulltext-index.js', '13as-session-fulltext-consumers.js', '06ha-semantic-retrieval.js'].map(name => path.resolve('ruyi-workbench/app/src', name)));", `// Freeze all actual source-slice owners and shared fixture helpers, including02.
  const sourceInventory=directory=>{const out=[];for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Source inventory alias');if(entry.isDirectory())out.push(...sourceInventory(file));else if(entry.isFile()&&/\\.(?:c?js|mjs)$/.test(entry.name))out.push(file);}return out.sort();};
  sources.push(...sourceInventory(path.resolve('ruyi-workbench/app/src')),...sourceInventory(path.resolve('dev-harness/lib')));`);
one("const exited = report.cleanup.coarse.workerExited === true && report.cleanup.scalar.workerExited === true && report.cleanup.scalar.cleanupStatus === 'observed';", "const exited = report.cleanup.coarse.workerExited === true && report.cleanup.coarse.cleanupStatus === 'observed' && report.cleanup.scalar.workerExited === true && report.cleanup.scalar.cleanupStatus === 'observed';");
one("limits: ['Development integration", "observation: {detailedProducerTiming:false,transportTrace:false,outerRequestTiming:true,nativeAndCacheCounters:true},\n    limits: ['Development integration");
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
module.exports={...compiled.exports,recipe:Object.freeze(recipe),baseSha256:hash(fs.readFileSync(basePath)),transformedDriverSha256:hash(source)};
if(require.main===module){
  const [directory,file,pin]=process.argv.slice(2);
  if(!directory||!file||!/^[a-f0-9]{64}$/.test(pin||''))throw Error('Use <new-output-directory> <reviewed-profile-module> <sha256>.');
  const profilePath=path.resolve(file);if(hash(fs.readFileSync(profilePath))!==pin)throw Error('Profile hash mismatch.');const profile=require(profilePath).create();profile.bindings=[...profile.bindings,{file:profilePath,sha256:pin}];
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort(Error('research.cancelled')));process.once('SIGTERM',()=>controller.abort(Error('research.cancelled')));
  module.exports.run({directory,profile,controller}).then(result=>{if(result.failed)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
}
