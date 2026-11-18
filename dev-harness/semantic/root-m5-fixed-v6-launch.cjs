'use strict';
const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const H=b=>crypto.createHash('sha256').update(b).digest('hex'),kind=process.argv[2];
a.ok(['group','human'].includes(kind));
const pin=kind==='group'?'fc8d7a4566cb414e36582d5670649527d5660d549e2f13b3e4e93adfc92b5507':'0f7aafaf1be76dace9065dde36abe545c3c5f664bd5b1d940dfcda247313a76c';
const root=p.resolve('output/m5-http-fixed-harness-candidate-20261118-r1/actualrun-'+kind+'-v6'),file=p.join(root,'case-output/freeze.json'),pre=p.resolve('output/m5-http-root-v6-preflight-20261118-r1/root-review.json');
const preBytes=fs.readFileSync(pre),review=JSON.parse(preBytes);a.equal(review.status,'ROOT_M5_V6_17_MOCK_AND_STATIC_PREFLIGHT_SCOPED_PASS');a.equal(review.tests,17);a.ok(review.contracts.some(x=>x.kind===kind&&x.freezeSha256===pin));
const raw=fs.readFileSync(file);a.equal(H(raw),pin);const f=JSON.parse(raw);for(const row of f.bindings){const b=fs.readFileSync(row.path);a.equal(b.length,row.bytes);a.equal(H(b),row.sha256);}
fs.writeFileSync(p.join(f.output,'ROOT_CONSUMED'),JSON.stringify({kind,freezeSha256:pin,rootPreflightSha256:H(preBytes),launcherSourceSha256:H(fs.readFileSync(__filename)),additionalRealHttpStackMockPass:1,actualNetworkInThatMock:false})+'\n',{flag:'wx'});
const child=require(p.join(root,'launcher.cjs')).launch(file,pin);console.log(JSON.stringify({status:'ROOT_LAUNCHED_REVIEWED_FIXED_M5',kind,keeperPid:child.pid}));
child.once('close',(code,signal)=>{fs.writeFileSync(p.join(f.output,'root-launcher-receipt.json'),JSON.stringify({schema:1,kind,keeperPid:child.pid,closeObserved:true,code,signal})+'\n',{flag:'wx'});});
