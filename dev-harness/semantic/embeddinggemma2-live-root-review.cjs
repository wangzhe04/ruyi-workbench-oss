'use strict';
// Review only the already consumed development codec run. Never open blind fixtures.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const digest=file=>hash(fs.readFileSync(file));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
async function main(){
 const base='output/embeddinggemma2-live-codec-340-v1',freezeFile=base+'/freeze.json',receiptFile=base+'/receipt.json';
 assert.equal(digest(freezeFile),'726fdcb967c075641136d690f49d1fc6935e1d4aae98ebedbc420fb8874455dd');
 assert.equal(digest(receiptFile),'a3ae103182345f10e6232f189597024c1499b553680560c1d395bba6eb3c6c02');
 const f=read(freezeFile),r=read(receiptFile),reviewFile='output/embeddinggemma2-live-host-profile-v1/review-freeze.json';
 assert.equal(digest(reviewFile),'4d3885ef05f983abd2b013899a40c3c132f12b518c1b737e4db913e450c10c0d');
 const review=read(reviewFile);
 for(const b of f.bindings){assert.equal(fs.statSync(b.file).size,b.bytes);assert.equal(digest(b.file),b.sha256);}
 for(const b of review.sources){assert.equal(digest(b.file),b.sha256);assert.equal(digest(b.snapshot),b.sha256);}
 const lock=read(path.join(f.directory,'asset-lock.json'));
 assert.equal(digest(path.join(f.directory,'asset-lock.json')),f.lockSha256);
 for(const b of lock.assets){const p=path.join(lock.assetsRoot,b.path);assert.equal(fs.statSync(p).size,b.bytes);assert.equal(digest(p),b.sha256);}
 for(const b of lock.runtimeInventory){const p=path.join(lock.runtimeRoot,'node_modules',b.path);assert.equal(fs.statSync(p).size,b.bytes);assert.equal(digest(p),b.sha256);}
 const train=read('output/granite-gemma-train-input-v1.json'),later=read('output/embeddinggemma2-development-later-v1/later-input.json');
 const rows=[...train.documents.map(v=>({...v,role:'document',cohort:'document'})),...train.queries.map(v=>({...v,role:'query',cohort:'train'})),...later.queries.map(v=>({...v,role:'query',cohort:v.split}))];
 const raw=['output/embeddinggemma2-development-train-v2/vectors.ndjson','output/embeddinggemma2-development-later-v1/vectors.ndjson'].flatMap(p=>fs.readFileSync(p,'utf8').trimEnd().split('\n').map(JSON.parse));
 assert.equal(rows.length,340);assert.equal(r.rows.length,340);assert.equal(raw.length,340);assert.equal(new Set(r.rows.map(v=>v.id)).size,340);
 assert.equal(r.status,'PASS_CONSUMED340_CODEC_EXACT_NOT_QUALITY_OR_CONSUMER');assert.equal(r.bindingsStable,true);assert.equal(r.modelFingerprint,f.modelFingerprint);assert.equal(r.guardCalls,680);
 const groups={};
 for(let i=0;i<340;i++){const a=r.rows[i],b=rows[i],v=raw[i];for(const k of ['id','role','cohort','ordinal'])assert.equal(a[k],b[k]);assert.equal(f.rows[i].textSha256,hash(b.text));assert.equal(v.id,b.id);assert.equal(v.textSha256,hash(b.text));assert.equal(a.tokenCount,v.tokenCount);assert.equal(a.expectedTokenCount,v.tokenCount);assert.ok(a.tokenCount>0&&a.tokenCount<=512);assert.equal(a.maxAbs,0);assert.ok(Number.isFinite(a.hostEncodeMs)&&a.hostEncodeMs>=0);assert.ok(Number.isFinite(a.workerEncodeMs)&&a.workerEncodeMs>=0);(groups[a.cohort]??=[]).push(a);}
 assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),{document:60,train:186,calibration:62,mixed:32});
 assert.equal(r.stats.starts,1);assert.equal(r.stats.requests,340);assert.equal(r.stats.queryTexts,280);assert.equal(r.stats.documentTexts,60);for(const k of ['pending','kills','cleanupFailures','timeouts'])assert.equal(r.stats[k],0);
 assert.equal(r.cleanup.cleanupStatus,'observed');assert.equal(r.cleanup.workerExited,true);assert.equal(r.cleanup.homeClean,true);assert.equal(r.cleanup.close.code,0);assert.equal(r.cleanup.close.signal,null);assert.equal(r.cleanup.postStopOs.exists,false);assert.equal(r.cleanup.identity.creationFileTime,r.identity.creationFileTime);
 for(const sample of [r.readySample,r.afterSample]){assert.equal(sample.pid,r.identity.pid);assert.equal(sample.creationFileTime,r.identity.creationFileTime);}
 assert.equal(fs.existsSync(path.join(f.directory,'owned-process.json')),false);assert.deepEqual(fs.readdirSync(path.join(f.directory,'live-homes')),[]);
 const os=await require('./embeddinggemma2-live-host.cjs').observeProcess(r.identity.pid);assert.ok(os.exists===false||os.creationFileTime!==r.identity.creationFileTime);
 const stats=a=>{const sorted=[...a].sort((x,y)=>x-y);return{count:a.length,mean:a.reduce((s,x)=>s+x,0)/a.length,p95:sorted[Math.ceil(a.length*.95)-1]};};
 const output={schema:1,status:'ROOT_REVIEWED_GENUINE340_CODEC_RECEIPT_NOT_FINAL_ACCEPTANCE',reviewerSha256:digest(__filename),freezeSha256:digest(freezeFile),receiptSha256:digest(receiptFile),fakeTests:{session:93436,exitCode:0,pass:20,fail:0,skip:0},modelFingerprint:r.modelFingerprint,sourceCopiesVerified:review.sources.length,executionBindingsVerified:f.bindings.length,assetsVerified:lock.assets.length,runtimeFilesVerified:lock.runtimeInventory.length,rowsVerified:340,guardCalls:680,prepareMs:r.prepareMs,timing:Object.fromEntries(Object.entries(groups).map(([k,a])=>[k,{hostEncodeMs:stats(a.map(v=>v.hostEncodeMs)),workerEncodeMs:stats(a.map(v=>v.workerEncodeMs))}])),workerLifetimePeakBytes:r.stats.peakRssBytes,workerMaxSampledRssBytes:r.stats.maxSampledRssBytes,identity:r.identity,postReviewOs:os,cleanup:r.cleanup,limits:['Audited comparator runs fresh native encode before comparing; root checks all340 comparison records/source/token counts. Live raw vectors were not persisted for a second independent arithmetic comparison.','Already consumed development corpus; no new quality or blind qualification.','Parent encode includes IPC and host guards, excludes full source/privacy/search/UI; worker peak excludes application total and is not app incremental memory.','This research run still uses the retired-one-start host with idle60; user subsequently requires startup-resident production lifecycle. This run cannot prove that policy, hard parent exit or any consumer.']};
 const out='output/embeddinggemma2-live-root-review-r1.json';fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:output.status,output:out,sha256:digest(out),rows:340,peakBytes:output.workerLifetimePeakBytes,timing:output.timing}));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});module.exports={main};
