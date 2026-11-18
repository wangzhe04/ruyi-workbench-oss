'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),H=b=>crypto.createHash('sha256').update(b).digest('hex');
function main(){
  const trial=path.join(root,'output/gemma2-production-transport-proof-smoke-v1'),reviewRaw=fs.readFileSync(path.join(trial,'root-review.json')),review=JSON.parse(reviewRaw);
  assert.equal(H(reviewRaw),'b8a974326c6a23c7643e285863b6687fdc1fdb3cd9cbc8baf81db11180ba890c');
  const inputs=[];function add(file,pin,originalSource){file=path.resolve(file);assert.ok(file.startsWith(root+path.sep));assert.doesNotMatch(file,/acceptance/i);assert.ok(['.cjs','.js','.ps1','.json'].includes(path.extname(file)));const raw=fs.readFileSync(file);if(pin)assert.equal(H(raw),pin,file);inputs.push({file,raw,originalSource});}
  for(const b of review.sourceSnapshots)add(path.join(trial,b.snapshot),b.sha256,path.relative(root,b.file).replaceAll('\\','/'));
  add(path.join(trial,'freeze.json'),review.freezeSha256);add(path.join(trial,'receipt.json'),review.receiptSha256);add(path.join(trial,'outer-job-receipt.json'),review.outerJobReceiptSha256);
  for(const n of ['root-preflight.json','root-review.json'])add(path.join(trial,n));
  add(path.join(root,'dev-harness/semantic/gemma2-resident-smoke-keeper.ps1'),'d570cb4c38794d4c0034bcf285e47db19b472d88f7599e6ddd7b9d12fb5ca563');add(__filename);
  const dir=path.join(root,'docs/optimization-plan/evidence/semantic-retrieval-20261116/s3c-production-transport-proof-reviewed-r1');assert.equal(fs.existsSync(dir),false);fs.mkdirSync(dir);const records=[];let rawBytes=0,gzipBytes=0;
  for(const {file,raw,originalSource}of inputs){const gz=zlib.gzipSync(raw,{level:9}),member=String(records.length+1).padStart(4,'0')+'.gz';fs.writeFileSync(path.join(dir,member),gz,{flag:'wx'});const stored=fs.readFileSync(path.join(dir,member));assert.deepEqual(zlib.gunzipSync(stored),raw);records.push({source:path.relative(root,file).replaceAll('\\','/'),...(originalSource?{originalSource}:{}),member,rawBytes:raw.length,rawSha256:H(raw),gzipBytes:gz.length,gzipSha256:H(gz)});rawBytes+=raw.length;gzipBytes+=gz.length;}
  const manifest={schema:1,status:'ROOT_REVIEWED_GENUINE_TRANSPORT_SCORER_COMPONENT_SCOPED_PASS',records,external:review.external,totalRawBytes:rawBytes,totalGzipBytes:gzipBytes,
    reconstruction:'Eight frozen non-executable inputs copied before component freeze released; originalSource preserves module/provider/profile paths. New keeper differs from pinned resident keeper only in expected status/error labels; WinAPI/control byte block identical.',
    limits:review.limits};const mp=path.join(dir,'manifest.json');fs.writeFileSync(mp,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({manifest:path.relative(root,mp).replaceAll('\\','/'),sha256:H(fs.readFileSync(mp)),records:records.length,rawBytes,gzipBytes}));
}
if(require.main===module)main();module.exports={main};
