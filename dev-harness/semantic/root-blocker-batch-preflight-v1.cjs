'use strict';
// Root-only input/recipe audit. Does not execute a native helper or model.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function load(file,pin){const b=fs.readFileSync(file);if(hash(b)!==pin)throw Error('freeze pin: '+file);return JSON.parse(b);}
function verify(rows){for(const r of rows){const b=fs.readFileSync(r.file);if(b.length!==r.bytes||hash(b)!==r.sha256)throw Error('binding: '+r.file);}}
function write(root,value){fs.writeFileSync(path.join(root,'root-preflight.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
const leaseFile=path.resolve('output/semantic-resident-proxy-file-lease-smoke-v1/freeze.json'),leasePin='f7a2db3bb6c54a0322660a277963de944f2b23b6fa3af8bf6eafb2c89bb781c9',lease=load(leaseFile,leasePin);
verify(lease.bindings);if(lease.bindings.length!==18)throw Error('lease closure');
const recipe=JSON.parse(fs.readFileSync('output/semantic-resident-proxy-lease-keeper-recipe-v1.json','utf8'));
let keeper=fs.readFileSync(recipe.original,'utf8');if(hash(Buffer.from(keeper))!==recipe.originalSha256)throw Error('original keeper');
for(const [index,[from,to]] of recipe.changes.entries()){if(keeper.split(from).length!==([1,2,1,1][index]+1))throw Error('keeper edit');keeper=keeper.split(from).join(to);}
// Derived PowerShell file uses CRLF; account for that byte transform explicitly.
if(/\r/.test(keeper))throw Error('original keeper line endings');keeper=keeper.replace(/\n/g,'\r\n');
if(keeper!==fs.readFileSync(recipe.derived,'utf8')||hash(Buffer.from(keeper))!==recipe.derivedSha256)throw Error('keeper recipe');
const build=JSON.parse(fs.readFileSync('output/semantic-resident-proxy-build-v4/build-receipt.json','utf8'));
if(build.status!=='COMPILED_NOT_EXECUTED'||!build.bindingsStable)throw Error('compile');
for(const row of build.reports){verify([row.output]);if(hash(fs.readFileSync(row.source.file))!==row.source.sha256)throw Error('compiled source');}
write(lease.directory,{status:'ROOT_LEASE_ONLY_PREFLIGHT_PASS',freezeSha256:leasePin,bindings:18,keeperRecipeExact:true,compiledSourceProductsMatch:true,authorizationScope:'One file-lease-only run under the frozen external Job. Does not authorize helper.exe, worker, model or product qualification.',limits:lease.limits});
const suppressionFile=path.resolve('output/semantic-owned-root-suppression-pair-v2/contract.json'),suppressionPin='46b27ee2cbb1a36d8fc466f5e47d78ac842d40822965895ef00b5af317910b23',s=load(suppressionFile,suppressionPin);
verify(s.bindings);if(s.bindings.length!==303)throw Error('suppression closure');
const {transform}=require('./owned-root-suppression-research.cjs'),prior=path.resolve('output/semantic-owned-restore-flush-production-native-v2/source-input/ruyi-workbench/app/src');
for(const arm of s.arms){const app=path.join(s.root,arm.arm,'source-input/ruyi-workbench/app'),manifest=JSON.parse(fs.readFileSync(path.join(app,'src/manifest.json'))),names=manifest.modules.map(m=>typeof m==='string'?m:m.file);if(names.length!==145||new Set(names).size!==145)throw Error('manifest');for(const name of names){const original=fs.readFileSync(path.join(prior,name),'utf8'),expected=name==='13u-migration-center.js'?transform(original).source:original;if(expected!==fs.readFileSync(path.join(app,'src',name),'utf8'))throw Error('source recipe '+name);}const check=cp.spawnSync(process.execPath,[path.join(app,'build.js'),'--check'],{encoding:'utf8'});if(check.status!==0)throw Error('build check');if(hash(fs.readFileSync(path.join(app,'server.js')))!==arm.serverSha256)throw Error('server');}
const tests=cp.spawnSync(process.execPath,['--test','dev-harness/semantic/owned-root-suppression-research.test.cjs'],{encoding:'utf8'});fs.writeFileSync(path.join(s.root,'root-preflight-unit.log'),tests.stdout+tests.stderr,{flag:'wx'});if(tests.status!==0)throw Error('suppression units');
write(s.root,{status:'ROOT_SUPPRESSION_PRIMITIVE_PREFLIGHT_PASS',freezeSha256:suppressionPin,bindings:303,modulesPerArm:145,exactRecipe:true,originalSourceUnchanged:true,units:2,authorizationScope:'One paired synthetic-source primitive observation under the frozen Job. Suppression setter is called with documented -1/0 markers. No timestamps are restored; no production fix, restore, model or holdout qualification.',limits:s.design.policy});
console.log(JSON.stringify({lease:'PREFLIGHT_PASS',suppression:'PREFLIGHT_PASS',nativeExecuted:false}));
