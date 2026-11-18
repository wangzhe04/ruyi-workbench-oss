'use strict';
// Builds a whole CommonJS research candidate; never starts it or changes app/server.js.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),src=path.join(root,'ruyi-workbench/app/src');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function build(out){
 out=path.resolve(out);if(fs.existsSync(out))throw Error('new owned output required');fs.mkdirSync(out,{recursive:false});
 const manifestFile=path.join(src,'manifest.json'),manifestBytes=fs.readFileSync(manifestFile),manifest=JSON.parse(manifestBytes),seen=new Set();
 if(!Array.isArray(manifest.modules)||!manifest.modules.length)throw Error('invalid manifest');
 const research=require('./ui-tentative-coverage-layout.cjs').layout(path.join(out,'transforms'));
 const owner=require('./scalar-scan-stat-source.cjs').transform(fs.readFileSync(path.join(src,'02-session-store.js'),'utf8'));
 const replacements={'02-session-store.js':owner.source,'13ap-session-fulltext-index.js':fs.readFileSync(research.modulePath,'utf8'),'13as-session-fulltext-consumers.js':research.consumer.source};
 const bindings=[],parts=[];let hookCount=0;
 const hook="const ResearchScanWitness=require("+JSON.stringify(require.resolve('./scalar-scan-stat-witness.cjs'))+").createWitness(WorkDataStore,workDataKeys);\nconst ResearchScalarComposite=require("+JSON.stringify(require.resolve('./gemma-q4-live-policy.cjs'))+").createCoarsePolicy({identify:SemanticRetrieval.structuredIds,normalize:text=>text.normalize('NFKC').toUpperCase().normalize('NFKC').replace(/\\s+/g,' '),terms:retrievalTerms});\nconst ResearchReplayRuntime=require("+JSON.stringify(require.resolve('./gemma-q4-commonjs-replay-runtime.cjs'))+").make();Object.assign(SemanticRuntimeHooks,ResearchReplayRuntime);\n";
 for(const row of manifest.modules){const name=typeof row==='string'?row:row.file;if(typeof name!=='string'||path.basename(name)!==name||seen.has(name))throw Error('invalid module name');seen.add(name);const file=path.join(src,name),body=fs.readFileSync(file,'utf8'),first=body.split('\n',1)[0];if(body.includes('\r')||!first||/^\s/.test(first)||/^[)\]};,]/.test(first))throw Error('build.js boundary invalid '+name);const derived=replacements[name]??body;if(name==='14-main.js'){parts.push(hook);hookCount++;}bindings.push({name,file,originalSha256:hash(body),derivedSha256:hash(derived),changed:derived!==body});parts.push(derived);}
 if(hookCount!==1)throw Error('hook boundary invalid');if(Object.keys(replacements).some(n=>!seen.has(n)))throw Error('missing transformed module');
 // This candidate deliberately has no startup or seed hook yet. It is syntax-only and cannot be launched as an approved run.
 const bundle=parts.join('\n'),syntax=cp.spawnSync(process.execPath,['--check','-'],{input:bundle,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});if(syntax.status!==0)throw Error('candidate syntax invalid '+syntax.stderr);
 fs.writeFileSync(path.join(out,'candidate.cjs'),bundle,{flag:'wx'});const record={schema:1,status:'PREPARED_REPLAY_SYNTAX_ONLY_NOT_EXECUTION_FROZEN',manifestSha256:hash(manifestBytes),buildSha256:hash(fs.readFileSync(path.join(root,'ruyi-workbench/app/build.js'))),bundleSha256:hash(bundle),hookSha256:hash(hook),modules:bindings,limits:['Replay only, no native inference; no DPAPI enrollment or full-service boot proof yet.','Only the three named modules are research derived; no app/server.js changed.','This is complete manifest concatenation, not the VM slice fixture.']};fs.writeFileSync(path.join(out,'assembly.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});return record;
}
if(require.main===module){try{if(!process.argv[2])throw Error('new output required');const r=build(process.argv[2]);console.log(JSON.stringify({status:r.status,bundleSha256:r.bundleSha256,modules:r.modules.length,changed:r.modules.filter(x=>x.changed).map(x=>x.name)}));}catch(e){console.error(e);process.exitCode=1;}}module.exports={build};
