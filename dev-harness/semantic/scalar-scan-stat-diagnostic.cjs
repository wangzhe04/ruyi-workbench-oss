'use strict';
// Identical actual60-source fake-model workload to the earlier preserved driver.
// Compare request-local-only against fresh-owner/key-validated cross-request stats.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),priorPath=require.resolve('./scalar-coverage-reuse-diagnostic.cjs');
let source=fs.readFileSync(priorPath,'utf8');if(hash(source)!=='ce7efd0792ad5aed0a94a5585fb0baac54bd8c08d642257b01388cd2b7a07b00')throw Error('Frozen source diagnostic changed.');
const before="const {fixture}=require('./scalar-coverage-reuse-fixture.cjs'),{createTiming}=require('./scalar-producer-phase-timing.cjs');";
const after="const fixture=options=>options.reuse?require('./scalar-scan-stat-fixture.cjs').fixture(options):require('./scalar-coverage-reuse-fixture.cjs').fixture({...options,reuse:true}),{createTiming}=require('./scalar-producer-phase-timing.cjs');";
if(source.split(before).length!==2)throw Error('Diagnostic fixture boundary changed.');source=source.replace(before,after);
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(source,__filename);
async function main(){
  const directory=path.resolve(process.argv[2]||'output/semantic-scan-stat-diagnostic-r1');fs.mkdirSync(directory,{recursive:false});
  const runs=[];for(const reuse of [false,true])runs.push(await compiled.exports.run(reuse,directory));
  const report={status:'ACTUAL_SOURCE_FAKE_MODELS_SCAN_STATS_DIAGNOSTIC_NOT_NATIVE_QUALITY',nativeStarts:0,runs,
    samePublicResults:JSON.stringify(runs[0].rows.map(({results,coverage})=>({results,coverage})))===JSON.stringify(runs[1].rows.map(({results,coverage})=>({results,coverage}))),
    limitations:['Nested phase sums cannot be added; no native latency/quality/resource qualification.','Scope-authorized catalog and fresh owner epochs remain mandatory. Current actual body decode lease witness validates encrypted statistics; opaque only.','Request-local-only baseline and cross-request stats use identical warm synthetic vectors/scalars; no stored development vector or scalar matrices.'],
    bindings:['scalar-scan-stat-layout.cjs','scalar-scan-stat-witness.cjs','scalar-scan-stat-source.cjs','scalar-scan-stat-fixture.cjs','scalar-scan-stat.test.cjs',path.basename(__filename)].map(file=>({file,sha256:hash(fs.readFileSync(path.join(__dirname,file)))}))};
  const output=path.join(directory,'receipt.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,samePublicResults:report.samePublicResults,runs:runs.map(run=>({reuse:run.reuse,sourceSha256:run.sourceSha256,rows:run.rows.map(r=>({id:r.queryId,elapsedMs:r.elapsedMs,complete:r.coverage.complete})),phases:run.timing.phases.filter(row=>row.key[1].startsWith('phase.')||row.key[1]==='host.scan'),counters:run.timing.counters.filter(row=>row.key[1].startsWith('scanStats.'))}))}));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
