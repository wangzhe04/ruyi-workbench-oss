'use strict';
// Exact allowlist only. No model/tokenizer binaries or confidential acceptance sources.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),H=b=>crypto.createHash('sha256').update(b).digest('hex');
function main(){
 const contractFile='output/semantic-gemma-q4-snapshot-primitive-v3/contract.json',contractBytes=fs.readFileSync(contractFile);
 assert.equal(H(contractBytes),'c9020aa385b3ed4e672bfbfa2ca67b6083a387994fcfb91472f656e6fe2bf257');
 const c=JSON.parse(contractBytes),sources=new Map(),external=[];
 function add(file,expected){const resolved=path.resolve(file);assert.ok(resolved.startsWith(root+path.sep));assert.ok(!/^acceptance-.*fixture\.cjs$/i.test(path.basename(file)));const bytes=fs.readFileSync(resolved);if(expected)assert.equal(H(bytes),expected,file);sources.set(resolved,bytes);}
 for(const b of c.bindings){if(path.extname(b.file)==='.exe'){external.push({file:b.file,bytes:b.bytes,sha256:b.sha256,reason:'External Node binary is not duplicated in evidence'});continue;}assert.ok(['.js','.cjs','.json','.ps1'].includes(path.extname(b.file)));add(b.file,b.sha256);}
 for(const name of ['contract.json','root-preflight.json','bootstrap-receipt.json','outer-job-receipt.json','snapshot-diagnostic.jsonl'])add(path.join(c.root,name));
 for(const directory of ['output/semantic-gemma-q4-commonjs-real-bootstrap-v1'])for(const name of ['contract.json','bootstrap-receipt.json','outer-job-receipt.json'])add(path.join(directory,name));
 const p='output/embeddinggemma2-live-host-profile-v1';for(const name of ['OWNER.json','asset-lock.json','preparation-receipt.json','review-freeze.json'])add(path.join(p,name));
 const review=JSON.parse(fs.readFileSync(path.join(p,'review-freeze.json')));for(const b of review.sources){add(b.file,b.sha256);add(b.snapshot,b.sha256);}
 for(const name of ['freeze.json','CONSUMED','receipt.json'])add('output/embeddinggemma2-live-codec-340-v1/'+name);
 add('output/embeddinggemma2-live-root-review-r1.json','d450bc7c765c055a025db3898da311c74111d2321373d27107583715d0ac19ac');
 for(const name of ['embeddinggemma2-live-root-review.cjs','archive-resident-progress-evidence.cjs'])add(path.join(__dirname,name));
 // Read and verify every original before writing the archive, so source drift fails closed.
 const out=path.join(root,'docs/optimization-plan/evidence/semantic-retrieval-20261116/s3c-gemma2-codec-and-bootstrap-reviewed-r1');assert.equal(fs.existsSync(out),false);fs.mkdirSync(out);
 const records=[];let totalRaw=0,totalGzip=0;for(const [file,bytes]of [...sources].sort((a,b)=>a[0].localeCompare(b[0]))){const compressed=zlib.gzipSync(bytes,{level:9}),member=String(records.length+1).padStart(4,'0')+'.gz';assert.deepEqual(zlib.gunzipSync(compressed),bytes);fs.writeFileSync(path.join(out,member),compressed,{flag:'wx'});records.push({source:path.relative(root,file).replaceAll('\\','/'),member,rawBytes:bytes.length,rawSha256:H(bytes),gzipBytes:compressed.length,gzipSha256:H(compressed)});totalRaw+=bytes.length;totalGzip+=compressed.length;}
 const manifest={schema:1,status:'DEVELOPMENT_CODEC_EXACT_AND_BOOTSTRAP_FAILURE_RCA_ONLY_NOT_RELEASE_ACCEPTANCE',records,external,totalRawBytes:totalRaw,totalGzipBytes:totalGzip,limits:['No model/tokenizer weights, native binaries or blind corpus bodies included.','Genuine codec340 outputs match comparison records; raw live vectors were not persisted.','Original production enable failed; research primitive identifies work_data_tree.source_changed. Job PASS proves containment cleanup, not enable success.','All formal gates remain pending; resident lifecycle implementation and all planned consumer acceptance remain pending.']};const m=path.join(out,'manifest.json');fs.writeFileSync(m,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({manifest:path.relative(root,m).replaceAll('\\','/'),sha256:H(fs.readFileSync(m)),records:records.length,totalRawBytes:totalRaw,totalGzipBytes:totalGzip}));
}
if(require.main===module)main();module.exports={main};
