'use strict';
const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const H=b=>crypto.createHash('sha256').update(b).digest('hex'),kind=process.argv[2];
a.ok(['group','human'].includes(kind));
const pin=kind==='group'?'b2c79247b879ddd7f7787bf0ec8b28def92b894e0e352119c6cf45d25c40e073':'ba55601f6d20a4acc6f6c5e56fd0b92a18d6c5d9510d4dca340e98162c91a98a';
const root=p.resolve('output/m5-http-fixed-harness-candidate-20261118-r1/actualrun-'+kind+'-v8'),file=p.join(root,'case-output/freeze.json'),pre=p.resolve('output/m5-http-root-v8-preflight-20261118-r1/root-review.json');
const preBytes=fs.readFileSync(pre),review=JSON.parse(preBytes);a.equal(review.status,'ROOT_M5_V8_21_MOCK_AND_STATIC_PREFLIGHT_SCOPED_PASS');a.equal(review.tests,21);a.ok(review.contracts.some(x=>x.kind===kind&&x.freezeSha256===pin));
const raw=fs.readFileSync(file);a.equal(H(raw),pin);const f=JSON.parse(raw);for(const row of f.bindings){const b=fs.readFileSync(row.path);a.equal(b.length,row.bytes);a.equal(H(b),row.sha256);}
fs.writeFileSync(p.join(f.output,'ROOT_CONSUMED'),JSON.stringify({kind,freezeSha256:pin,rootPreflightSha256:H(preBytes),launcherSourceSha256:H(fs.readFileSync(__filename)),realHttpStackMockIncludedIn21:true,actualNetworkInThatMock:false})+'\n',{flag:'wx'});
const child=require(p.join(root,'launcher.cjs')).launch(file,pin);console.log(JSON.stringify({status:'ROOT_LAUNCHED_REVIEWED_FIXED_M5',kind,keeperPid:child.pid}));
child.once('close',(code,signal)=>{fs.writeFileSync(p.join(f.output,'root-launcher-receipt.json'),JSON.stringify({schema:1,kind,keeperPid:child.pid,closeObserved:true,code,signal})+'\n',{flag:'wx'});});
