'use strict';
// Verify the new fixed profile against actual development vectors, not labels.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {create,CONTRACT}=require('./qwen-evidence-research-adapter.cjs');
const corpus=require('./calibration-fixture.cjs');
const root=path.resolve(__dirname,'../..'),runtime=path.join(root,'output/semantic-qwen3-q4-research-v1');
const out=path.resolve(process.argv[2]||path.join(root,'output/semantic-qwen3-evidence-preflight-v1.json'));
if(fs.existsSync(out))throw Error('Immutable receipt exists');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const studyFile=path.join(root,'output/semantic-qwen3-stateless-development-v1.json');
const study=JSON.parse(fs.readFileSync(studyFile));
if(study.status!=='STATELESS_DEVELOPMENT_CANDIDATE_ONLY'||study.selected?.instruction!=='prior-evidence'||study.selected.policy.minScore!==.46||study.selected.prefix!==CONTRACT.queryPrefix)throw Error('Frozen study candidate changed');
const wanted=study.variants.find(v=>v.id==='prior-evidence');
const queries=new Map(wanted.queries.map(q=>[q.id,q.vector])),docs=new Map(study.documents.map(d=>[d.id,d.vector]));
const report={schema:1,status:'RUNNING',createdAt:new Date().toISOString(),realModel:true,synthetic:true,sourceSha256:sha(fs.readFileSync(__filename)),adapterSha256:sha(fs.readFileSync(path.join(__dirname,'qwen-evidence-research-adapter.cjs'))),studySha256:sha(fs.readFileSync(studyFile)),checks:[],limits:['Only selected developer queries and documents; no independent/check relevance outcome used.','Controller contract/vector/source-guard smoke, not production latency, packaged lifecycle, or quality acceptance.']};
const check=(name,passed)=>{report.checks.push({name,passed:!!passed});if(!passed)throw Error(name);};
const client=create({root:runtime});
(async()=>{try{
 report.ready=await client.prepare({budgetMs:20000});check('fixed evidence profile ready',report.ready.available&&report.ready.retrievalThresholds?.search===.46&&report.ready.contract.queryPrefix===study.selected.prefix);
 report.comparisons=[];
 for(const q of corpus.queries.filter(q=>q.split==='train').slice(0,2)){const value=await client.encode([q.text],{role:'query',budgetMs:1000});check('query inference '+q.id,value.ok);const maxDiff=Math.max(...value.vectors[0].map((n,i)=>Math.abs(n-queries.get(q.id)[i])));report.comparisons.push({role:'query',id:q.id,maxDiff});check('query equals frozen study vector '+q.id,maxDiff<=1e-6);}
 for(const d of corpus.documents.slice(0,2)){const value=await client.encode([d.text],{role:'document',budgetMs:1000});check('document inference '+d.id,value.ok);const maxDiff=Math.max(...value.vectors[0].map((n,i)=>Math.abs(n-docs.get(d.id)[i])));report.comparisons.push({role:'document',id:d.id,maxDiff});check('documents preserve original encoding '+d.id,maxDiff<=1e-6);}
 const sentinel=Object.assign(Error('synthetic-source-revoked'),{code:'SYNTHETIC_SOURCE_REVOKED'}),before=client.stats();let caught;try{await client.encode(['synthetic withheld text'],{role:'query',budgetMs:1000,beforeEncode(){throw sentinel;}});}catch(error){caught=error;}
 const after=client.stats();check('source error retains identity and precedes every native text write',caught===sentinel&&after.tokenizeWrites===before.tokenizeWrites&&after.embeddingWrites===before.embeddingWrites);
 report.status='PASS_PROFILE_PREFLIGHT';
 }catch(error){report.status='FAIL';report.error=String(error.code||error.message);process.exitCode=1;}
 finally{report.stats=client.stats();report.stop=await client.stop('disabled');report.finishedAt=new Date().toISOString();fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({out,status:report.status,checks:report.checks,comparisons:report.comparisons,stop:report.stop}));}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
