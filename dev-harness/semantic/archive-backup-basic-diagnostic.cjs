'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),H=b=>crypto.createHash('sha256').update(b).digest('hex');
function main(){
  const parent='docs/optimization-plan/evidence/semantic-retrieval-20261116';
  const baseDir=parent+'/s3c-preserved-capture-fix-reviewed-r1',basePath=baseDir+'/manifest.json',baseRaw=fs.readFileSync(basePath),base=JSON.parse(baseRaw);
  assert.equal(H(baseRaw),'709590dcb81a6736ac31495fbb274b56ed4b8fefbafe5b9733db0342099793b0');
  const available=new Map();
  for(const r of base.records){const gz=fs.readFileSync(baseDir+'/'+r.member),b=zlib.gunzipSync(gz);assert.equal(H(gz),r.gzipSha256);assert.equal(b.length,r.rawBytes);assert.equal(H(b),r.rawSha256);available.set(r.rawSha256,{baseManifest:basePath,baseManifestSha256:H(baseRaw),member:r.member,gzipBytes:r.gzipBytes,gzipSha256:r.gzipSha256});}
  const inputs=new Map(),external=[];
  function add(file,pin,bytes){
    const p=path.resolve(file);assert.ok(p.startsWith(root+path.sep),p);assert.doesNotMatch(p,/acceptance/i);
    assert.ok(['.js','.cjs','.json','.jsonl','.ps1'].includes(path.extname(p)));
    const b=fs.readFileSync(p);if(pin)assert.equal(H(b),pin,p);if(bytes!==undefined)assert.equal(b.length,bytes,p);inputs.set(p,b);
  }
  const trials=[['output/semantic-gemma-q4-backup-diagnostic-v1','eff07069a1ef8c23d055c34b41d5fe657db56383272f45136b8fed02f5d9bab5'],['output/semantic-gemma-q4-basic-guard-diagnostic-v1','2e0104d40bde7ed970101c46d1fcadcc7ac23cc52be368450a75584629384118']];
  for(const [dir,pin]of trials){const cb=fs.readFileSync(dir+'/contract.json');assert.equal(H(cb),pin);const c=JSON.parse(cb);
    for(const binding of c.bindings){if(path.extname(binding.file)==='.exe'){external.push({...binding,reason:'External Node executable not copied'});continue;}add(binding.file,binding.sha256,binding.bytes);}
    for(const n of ['contract.json','root-preflight.json','bootstrap-receipt.json','outer-job-receipt.json','backup-diagnostic.jsonl'])add(dir+'/'+n);
  }
  for(const n of ['root-review.json','basic-guard-diagnostic.jsonl'])add(trials[1][0]+'/'+n);
  for(const n of ['recipes-v2.json','verify-recipes-v2.cjs'])add('output/semantic-gemma-q4-rca-bundle-v1/'+n);
  add('dev-harness/semantic/gemma-q4-basic-guard-root-review.cjs');add(__filename);
  const out=path.resolve(parent,'s3c-backup-basic-diagnostic-reviewed-r1');assert.equal(fs.existsSync(out),false);fs.mkdirSync(out);
  const records=[];let rawBytes=0,storedGzipBytes=0,references=0;const local=new Map();
  for(const [file,b]of [...inputs].sort((a,b)=>a[0].localeCompare(b[0]))){
    const hash=H(b),record={source:path.relative(root,file).replaceAll('\\','/'),rawBytes:b.length,rawSha256:hash};
    if(available.has(hash)){record.storage={kind:'prior-archive',...available.get(hash)};references++;}
    else if(local.has(hash))record.storage={kind:'local',...local.get(hash)};
    else{const gz=zlib.gzipSync(b,{level:9}),member=String(local.size+1).padStart(4,'0')+'.gz';fs.writeFileSync(path.join(out,member),gz,{flag:'wx'});assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(out,member))),b);const storage={member,gzipBytes:gz.length,gzipSha256:H(gz)};local.set(hash,storage);record.storage={kind:'local',...storage};storedGzipBytes+=gz.length;}
    records.push(record);rawBytes+=b.length;
  }
  const manifest={schema:2,status:'IMMUTABLE_SOURCE_DIAGNOSTICS_COMPLETE_ACTUAL_RESTORE_FAIL_RETAINED',records,external,totalLogicalRawBytes:rawBytes,storedGzipBytes,referencedRecords:references,storedMembers:local.size,
    limits:['Synthetic disposable backup verification only, original guards retained, semantics disabled; not encrypted enable or release acceptance.',
      'Both executions terminal; outer private Job active0/members empty. Local ownershipUnknown and forced cold-child reclaim retained.',
      'Precise observed mismatch: rehearsal root held Basic time.access. Actor/fix still pending.',
      'Content references resolve by pinned prior manifest/member SHA and full decompression validation. Each source alias is preserved.',
      'No model weights, tokenizer, executable/native binary, backup payload, key/token or confidential holdout body included.']};
  const mp=path.join(out,'manifest.json');fs.writeFileSync(mp,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({manifest:path.relative(root,mp).replaceAll('\\','/'),sha256:H(fs.readFileSync(mp)),records:records.length,rawBytes,storedGzipBytes,references,storedMembers:local.size}));
}
if(require.main===module)main();module.exports={main};
