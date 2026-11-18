'use strict';
// Recollect developer vectors after proving that b11146 embedding tasks ignore
// cache_prompt. Every native inference is preceded by authenticated slot erase.
// No check/acceptance relevance labels or vectors enter selection.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {create,CONTRACT}=require('./qwen-evidence-research-adapter.cjs');
const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),original=require(fixturePath);
const fixture={...original,queries:original.queries.filter(q=>['train','calibration'].includes(q.split))};
const {metrics,qualityPasses}=require('./calibration-policy.cjs');
const root=path.resolve(__dirname,'../..'),output=path.resolve(process.argv[2]||path.join(root,'output/semantic-qwen3-stateless-development-v1.json'));
if(fs.existsSync(output))throw Error('Immutable report exists');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const client=create({root:path.join(root,'output/semantic-qwen3-q4-research-v1')});
const variants=[{id:'web-search',prefix:'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:'},{id:'prior-evidence',prefix:'Instruct: Given a user question, retrieve prior messages that contain evidence relevant to answering it\nQuery:'},{id:'explicit-evidence',prefix:'Instruct: Given a question, retrieve passages containing explicit information needed to answer it, excluding unrelated or merely similar topics\nQuery:'}];
const report={schema:1,status:'RUNNING',createdAt:new Date().toISOString(),sourceSha256:sha(fs.readFileSync(__filename)),adapterSha256:sha(fs.readFileSync(path.join(__dirname,'qwen-evidence-research-adapter.cjs'))),fixtureSha256:sha(fs.readFileSync(fixturePath)),documents:[],variants:[],selectionRule:'Three predeclared instructions (original web baseline plus the two previous task instructions), each45 fixed cosine thresholds .10...98 step.02, complete structured IDs. BOTH train/cal must pass original language/MRR floors, pure OOD<=.05, entity mismatch<=.05. Rank lowest worst OOD, highest calibration MRR, highest train MRR, higher cosine, shorter prefix. No check or acceptance selection.',nativeCachePolicy:{physicalSequences:1,slotEraseBeforeEveryInference:true,cacheRamMiB:0,slotSaveRestoreRequests:false,sourceGuardAfterErase:true},limits:['Previous stateful developer studies remain preserved; their vectors cannot qualify this stateless profile.','This collector uses20s developer batch budgets, not production search1s/consumer2.5s proof.','No production/default/profile lock changed.','Relevance does not imply an answer; missing-field diagnostics remain separate.']};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
async function encode(rows,role,prefix=''){const vectors=[];for(let offset=0;offset<rows.length;offset+=4){const batch=rows.slice(offset,offset+4),result=await client.encode(batch.map(row=>prefix+row.text),{role,budgetMs:20000});if(!result.ok||result.vectors.length!==batch.length)throw Error('Incomplete stateless vector batch');batch.forEach((row,n)=>vectors.push({id:row.id,vector:result.vectors[n],tokens:result.encodedTokens[n]}));if(vectors.length%64===0)console.log(role+' '+vectors.length+'/'+rows.length);}return vectors;}
const compact=value=>{const{rows,...rest}=value;return rest;};
const passed=value=>qualityPasses(value)&&value.oodAdmission.rate<=.05&&value.entityMismatchAdmission.rate<=.05;
(async()=>{save();try{
 report.ready=await client.prepare({budgetMs:20000});if(!report.ready.available)throw Error('Native unavailable');
 report.documents=await encode(fixture.documents,'document');save();
 const docs=new Map(report.documents.map(d=>[d.id,d.vector]));
 for(const definition of variants){const variant={...definition,representationFingerprint:'sha256:'+sha(JSON.stringify([report.ready.modelFingerprint,definition.prefix,report.nativeCachePolicy])),queries:await encode(fixture.queries,'document',definition.prefix),policies:[]};
  const queries=new Map(variant.queries.map(q=>[q.id,q.vector]));
  const matrix=Object.fromEntries(fixture.queries.map(q=>{const vector=queries.get(q.id);return[q.id,fixture.documents.map(d=>vector.reduce((sum,n,i)=>sum+n*docs.get(d.id)[i],0))];}));
  for(let c=10;c<=98;c+=2){const policy={id:definition.id+'-stateless-c'+c,minScore:c/100,minGap:0,minZ:0,identifiers:true},train=metrics(fixture,matrix,policy,'train'),calibration=metrics(fixture,matrix,policy,'calibration');variant.policies.push({policy,train:compact(train),calibration:compact(calibration),passed:passed(train)&&passed(calibration)});}
  report.variants.push(variant);save();console.log(definition.id+' complete');
 }
 const passing=report.variants.flatMap(v=>v.policies.filter(p=>p.passed).map(p=>({...p,instruction:v.id,prefix:v.prefix,representationFingerprint:v.representationFingerprint})));
 passing.sort((a,b)=>Math.max(a.train.oodAdmission.rate,a.calibration.oodAdmission.rate)-Math.max(b.train.oodAdmission.rate,b.calibration.oodAdmission.rate)||b.calibration.quality.all.mrr-a.calibration.quality.all.mrr||b.train.quality.all.mrr-a.train.quality.all.mrr||b.policy.minScore-a.policy.minScore||a.prefix.length-b.prefix.length);
 report.selected=passing[0]||null;report.passingPolicies=passing.length;report.status=report.selected?'STATELESS_DEVELOPMENT_CANDIDATE_ONLY':'RED_NO_STATELESS_POLICY';
 // Query order must not change a cached document or selected query vector.
 report.repeat=[];for(const item of[{role:'document',text:fixture.documents[0].text,vector:report.documents[0].vector},{role:'query',text:fixture.queries[0].text,vector:report.variants.find(v=>v.id==='prior-evidence').queries[0].vector}]){const value=await client.encode([item.text],{role:item.role,budgetMs:20000});if(!value.ok)throw Error('Repeat incomplete');const maxDiff=Math.max(...value.vectors[0].map((n,i)=>Math.abs(n-item.vector[i])));report.repeat.push({role:item.role,maxDiff});if(maxDiff>1e-6)throw Error('Stateless repeat differs');}
 }catch(error){report.status='FAIL_INCOMPLETE';report.error=String(error.code||error.message);process.exitCode=1;}
 finally{report.stats=client.stats();report.stop=await client.stop('disabled');report.sourceStable=sha(fs.readFileSync(__filename))===report.sourceSha256&&sha(fs.readFileSync(path.join(__dirname,'qwen-evidence-research-adapter.cjs')))===report.adapterSha256;report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({output,status:report.status,selected:report.selected,passingPolicies:report.passingPolicies,repeat:report.repeat,stop:report.stop,sourceStable:report.sourceStable}));}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
