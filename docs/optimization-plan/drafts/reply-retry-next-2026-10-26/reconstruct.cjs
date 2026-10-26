'use strict';
// Explicit source preparation only. Does not load the application or run tests.
const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),a=require('node:assert/strict');
const repo=p.resolve(process.argv[2]||''),out=p.resolve(process.argv[3]||'');
a.equal(process.argv.length,4,'usage: node reconstruct.cjs <repo> <new-output-directory>');
a.equal(fs.existsSync(out),false,'output must be a new directory');
const key=value=>process.platform==='win32'?value.toLowerCase():value;
const actualOut=p.join(fs.realpathSync(p.dirname(out)),p.basename(out)),actualRepo=fs.realpathSync(repo);
a.ok(key(actualOut)!==key(actualRepo)&&!key(actualOut).startsWith(key(actualRepo)+p.sep),'output must be outside the checkout');
const hash=bytes=>c.createHash('sha256').update(bytes).digest('hex'),identity=JSON.parse(fs.readFileSync(p.join(__dirname,'candidate-identity.json'))),spans=JSON.parse(fs.readFileSync(p.join(__dirname,'spans.json')));
const baseline=fs.readFileSync(p.join(repo,identity.product.file),'utf8');
a.equal(hash(baseline),identity.product.beforeSha256,'must use the reviewed cancellation-capacity baseline');
let candidate=baseline;for(const span of spans.spans){a.equal(candidate.split(span.before).length-1,1);candidate=candidate.replace(span.before,span.after);}
a.equal(hash(candidate),identity.product.afterSha256);let inverse=candidate;
for(const span of [...spans.spans].reverse()){a.equal(inverse.split(span.after).length-1,1);inverse=inverse.replace(span.after,span.before);}a.equal(inverse,baseline);
fs.mkdirSync(out);fs.writeFileSync(p.join(out,'13w-retry-baseline.js'),baseline);fs.writeFileSync(p.join(out,'13w-external-bots.js'),candidate);
console.log(JSON.stringify({sourcePreparedOnly:true,productSha256:hash(candidate),out}));
