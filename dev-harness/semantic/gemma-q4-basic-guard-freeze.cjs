'use strict';
// Prepare a derivative of the already frozen owned app source; no live app read.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'output'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function run(dir){
 dir=path.resolve(dir);if(path.dirname(dir)!==output||fs.existsSync(dir))throw Error('new owned output required');
 const priorPath=path.join(output,'semantic-gemma-q4-backup-diagnostic-v1/contract.json'),priorBytes=fs.readFileSync(priorPath);if(H(priorBytes)!=='eff07069a1ef8c23d055c34b41d5fe657db56383272f45136b8fed02f5d9bab5')throw Error('prior freeze mismatch');
 const prior=JSON.parse(priorBytes);for(const x of prior.bindings){const b=fs.readFileSync(x.file);if(b.length!==x.bytes||H(b)!==x.sha256)throw Error('prior binding drift');}
 fs.mkdirSync(dir);const nonce=crypto.randomBytes(32).toString('hex');fs.writeFileSync(path.join(dir,'OWNER.json'),JSON.stringify({owner:'basic-guard-diagnostic-only',nonce})+'\n',{flag:'wx'});const src=prior.sourceRoot,manifest=JSON.parse(fs.readFileSync(path.join(src,'manifest.json'))),parts=[],rows=[];let changed=0;
 for(const row of manifest.modules){const name=typeof row==='string'?row:row.file;if(path.basename(name)!==name||/acceptance/i.test(name))throw Error('manifest path');const original=fs.readFileSync(path.join(src,name),'utf8');let text=original;
  if(name==='13ak-work-data-cold-operations.js'){text=require('./gemma-q4-backup-verification-diagnostic.cjs').transform(original).source;changed++;}
  if(name==='01aa-work-data-tree.js'){text=require('./gemma-q4-preserved-tree-diagnostic.cjs').transform(original).source;changed++;}
  if(name==='13u-migration-center.js'){text=require('./gemma-q4-basic-guard-diagnostic.cjs').transform(original,path.join(dir,'basic-guard-diagnostic.jsonl')).source;changed++;}
  if(name==='14-main.js')parts.push('const ResearchBackupProbe=require('+JSON.stringify(require.resolve('./gemma-q4-backup-verification-diagnostic.cjs'))+').fileProbe('+JSON.stringify(path.join(dir,'backup-diagnostic.jsonl'))+');\nconst ResearchTreeProbe=require('+JSON.stringify(require.resolve('./gemma-q4-preserved-tree-diagnostic.cjs'))+').fileProbe('+JSON.stringify(path.join(dir,'tree-diagnostic.jsonl'))+');\n');
  rows.push({name,originalSha256:H(original),derivedSha256:H(text)});parts.push(text);
 }
 if(changed!==3)throw Error('diagnostic delta missing');const bundle=parts.join('\n'),check=cp.spawnSync(process.execPath,['--check','-'],{input:bundle,encoding:'utf8',windowsHide:true});if(check.status!==0)throw Error('bundle syntax invalid');const bundlePath=path.join(dir,'diagnostic-bundle.cjs');fs.writeFileSync(bundlePath,bundle,{flag:'wx'});
 const loaderPath=path.join(dir,'diagnostic-entry.cjs'),loader=fs.readFileSync(prior.loader,'utf8');fs.writeFileSync(loaderPath,loader,{flag:'wx'});
 const files=[...new Set([__filename,priorPath,require.resolve('./gemma-q4-basic-guard-diagnostic.cjs'),require.resolve('./gemma-q4-basic-guard-diagnostic.test.cjs'),bundlePath,loaderPath,...prior.bindings.map(x=>x.file)])].sort();const bindings=files.map(file=>{const b=fs.readFileSync(file);return{file,bytes:b.length,sha256:H(b)};});
 const contract={schema:1,status:'FROZEN_RESEARCH_SNAPSHOT_DIAGNOSTIC',root:dir,ownerNonce:nonce,semanticOff:true,baselineExecutionSha256:prior.baselineExecutionSha256,priorFreezeSha256:H(priorBytes),sourceRoot:src,bundle:bundlePath,bundleSha256:H(bundle),loader:loaderPath,loaderSha256:H(loader),modules:rows,bindings,limits:['Derived from previous immutable owned app source; non-app helpers remain bound.','Three derived modules: existing 13ak stages and 01aa branches, plus 13u Basic guard field-name trace.','All original rejection conditions remain; hard stop before generation.','Only synthetic-root relative paths, coarse scope and field names; no values, payload, credentials or stacks.','Semantic disabled in config and environment; outer Job must prove zero active members.']};
 const file=path.join(dir,'contract.json');fs.writeFileSync(file,JSON.stringify(contract,null,2)+'\n',{flag:'wx'});return{contract:file,sha256:H(fs.readFileSync(file)),bindings:bindings.length,bundleSha256:contract.bundleSha256,loaderSha256:contract.loaderSha256};
}
if(require.main===module){try{console.log(JSON.stringify(run(process.argv[2])));}catch(e){console.error(e.stack||e);process.exitCode=1;}}module.exports={run};
