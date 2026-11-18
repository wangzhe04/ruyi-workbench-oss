'use strict';
// Repeat the exact audited18 owner/security cases through the live fixture.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const basePath=require.resolve('./scalar-scan-stat.test.cjs'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');let source=fs.readFileSync(basePath,'utf8');
if(hash(source)!=='a6ac003c5f80e8fa8e894548ceb23bbfc6a768ced189fdae93b639d65078ee91')throw Error('Audited18 case bytes changed.');
const before="require('./scalar-scan-stat-fixture.cjs')",after="require('./scalar-scan-stat-live-fixture.cjs')";if(source.split(before).length!==2)throw Error('18-case live redirect changed.');source=source.replace(before,after);
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./scalar-scan-stat-live-fixture.cjs');
test('default live source does not install a phase observer or patch transport',async t=>{
  const originalFetch=global.fetch,f=await fixture({enabled:true,researchDirectory:path.resolve('output/semantic-scan-stat-live-fakes')});t.after(()=>f.close());
  assert.equal(Object.hasOwn(f.context,'ResearchProducerTiming'),false);
  await f.put('Plain',[{role:'user',id:'m1',content:'needle factual source'}]);await f.index.prepare(null);const found=await f.ui('needle factual');
  assert.ok(found.results.length);assert.equal(global.fetch,originalFetch);assert.equal(Object.hasOwn(f.context,'ResearchProducerTiming'),false);
  const generated=fs.readFileSync(f.sources.modulePath,'utf8');assert.ok(generated.includes("const researchMeasure=(name,work)=>researchTiming?researchTiming.measure(name,work):work();"));
  assert.equal(generated.includes('performance.now('),false);assert.equal(generated.includes('new AsyncLocalStorage('),false,'phase recorder is not part of runtime source');
});
test('unobserved runner preserves source checks, counters and paired cleanup without a transport tracer',()=>{
  const runner=require('./scalar-scan-stat-live-development.cjs'),text=fs.readFileSync(require.resolve('./scalar-scan-stat-live-development.cjs'),'utf8');
  assert.equal(typeof runner.run,'function');assert.equal(text.includes('scalar-budget-trace-research'),false);assert.equal(text.includes('global.fetch='),false);
  assert.ok(runner.recipe.some(row=>row.after.includes('nativeAndCacheCounters:true')));assert.ok(runner.recipe.some(row=>row.after.includes("report.cleanup.coarse.cleanupStatus === 'observed'")));
});
