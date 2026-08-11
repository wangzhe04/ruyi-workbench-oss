(async () => {
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-quality-workflow');
const SOURCE_FILE = path.join(HOME, 'c1-source.txt');
const FP = await getFreePort(), WP = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function get(port, p, headers={}) { return new Promise(resolve => { const r=http.get({host:'127.0.0.1',port,path:p,timeout:1000,headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch{resolve(null);}})});r.on('error',()=>resolve(null));r.on('timeout',()=>{r.destroy();resolve(null);});}); }
function post(port, p, body, headers={}) { return new Promise((resolve,reject)=>{const raw=JSON.stringify(body);const r=http.request({host:'127.0.0.1',port,path:p,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw),...headers}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}})});r.on('error',reject);r.write(raw);r.end();}); }
function stream(body, headers={}) { return new Promise((resolve,reject)=>{const raw=JSON.stringify(body);const r=http.request({host:'127.0.0.1',port:WP,path:'/api/chat/stream',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw),...headers}},res=>{let b='',events=[];res.on('data',c=>{b+=c;let i;while((i=b.indexOf('\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);try{if(line.trim())events.push(JSON.parse(line));}catch{}}});res.on('end',()=>resolve(events));});r.on('error',reject);r.end(raw);}); }
async function up(port, path0='/health') { for(let i=0;i<50;i++){if(await get(port,path0))return true;await sleep(120);}return false; }

(async()=>{
  fs.rmSync(HOME,{recursive:true,force:true});fs.mkdirSync(HOME,{recursive:true});fs.writeFileSync(SOURCE_FILE,'C1 evidence source');
  const qualitySchema={type:'object',required:['verdict','confidence','summary','findings'],properties:{verdict:{type:'string',enum:['pass','fail','uncertain']},confidence:{type:'number',minimum:0,maximum:1},summary:{type:'string'},findings:{type:'array',items:{type:'object'}}}};
  const nodes=[
    {id:'finder_a',task:'VALID_A',outputSchema:qualitySchema},{id:'finder_b',task:'VALID_B',outputSchema:qualitySchema},
    {id:'review',task:'REVIEW_GATE',role:'reviewer',dependsOn:['finder_a','finder_b']},
    {id:'vote',task:'VOTE_GATE',dependsOn:['finder_a','finder_b'],gate:{mode:'vote',threshold:.6,minApprovals:2,minConfidence:.7}},
    {id:'dedupe',task:'DEDUPE_GATE',dependsOn:['finder_a','finder_b'],gate:{mode:'dedupe'}},
    {id:'after_vote',task:'AFTER_VOTE',dependsOn:['vote']},
    {id:'bad_block',task:'BAD_BLOCK',outputSchema:{type:'object',required:['ok'],properties:{ok:{type:'boolean'}}},failurePolicy:'block'},
    {id:'blocked_child',task:'BLOCKED_CHILD',dependsOn:['bad_block']},
    {id:'bad_continue',task:'BAD_CONTINUE',outputSchema:{type:'object',required:['ok']},failurePolicy:'continue'},
    {id:'continued_child',task:'CONTINUED_CHILD',dependsOn:['bad_continue']},
    {id:'bad_retry',task:'BAD_RETRY',outputSchema:{type:'object',required:['ok']},failurePolicy:'retry',maxRetries:1,retryFallback:'continue'},
    {id:'retry_child',task:'RETRY_CHILD',dependsOn:['bad_retry']},
  ];
  const good=JSON.stringify({verdict:'pass',confidence:.9,summary:'verified',findings:[{title:'duplicate issue',file:'x.js',line:4,confidence:.8}]});
  const reviewFail=JSON.stringify({verdict:'fail',confidence:.9,summary:'found real bugs',findings:[{title:'bug',file:'a.js',line:1,confidence:.9}]});
  const script={parent:[{name:'orchestrate_agents',args:{nodes}}],sub:[],subStepsByTask:{C1_TOOL_SOURCE:[{name:'file_read',args:{path:SOURCE_FILE}}]},parentText:'workflow done',subText:good,evidenceRefByTask:{C1_VALID_REF:'catalog',C1_FORGED_REF:'forged'},memoryRelationByTask:{R4_MEMORY_RELATIONS:{from:'r4-live-a',to:'r4-live-b'}},subTextByTask:{BAD_BLOCK:'not json',BAD_CONTINUE:'not json',BAD_RETRY:'not json',BAD_SETTLED:'not json',PLAIN_NON_VOTE:'{"answer":"correct but not a vote"}',B8_REVIEW_FAIL:reviewFail,M3_UNCOVERED:JSON.stringify({verdict:'pass',confidence:.9,summary:'checked most',findings:[],coverage:{total:3,handled:2,unhandled:['b.js','c.js']}}),M3_COVERED:JSON.stringify({verdict:'pass',confidence:.9,summary:'all checked',findings:[],coverage:{total:2,handled:2,unhandled:[]}}),R1_UNVERIFIED:JSON.stringify({verdict:'pass',confidence:.9,summary:'claims made',findings:[{text:'断言A',evidenceRefs:['evt_fake_99']}]}),M2_HANDLED:JSON.stringify({handledItems:['a','b']}),M2_PROPAGATE:JSON.stringify({items:[{id:'root',group:'g',assignment:'blue'},{id:'peer',group:'g'}],propagationEdges:[{from:'peer',to:'leaf'}]}),M2_CYCLE:JSON.stringify({assignments:{a:'x'},propagationEdges:[{from:'a',to:'b'},{from:'b',to:'a'}]})}};
  fs.writeFileSync(path.join(HOME,'config.json'),JSON.stringify({configSchema:7,permissionMode:'bypass',defaultWorkspace:HOME,subagentMaxPerTurn:12,subagentMaxConcurrent:6,providers:[{id:'fake',label:'Fake',type:'openai-compat',baseUrl:`http://127.0.0.1:${FP}`,apiKey:'k',model:'fake-model'}],activeProvider:'fake'}));
  const fake=cp.spawn(process.execPath,[path.join(__dirname,'fake-openai.js')],{env:{...process.env,FAKE_OPENAI_PORT:String(FP),FAKE_SUBAGENT_SCRIPT:JSON.stringify(script)},windowsHide:true});
  const wb=cp.spawn(process.execPath,['app/server.js','serve','--port',String(WP)],{cwd:WB,env:{...process.env,RUYI_HOME:HOME},windowsHide:true});
  try{
    ok(await up(FP,'/v1/models') && await up(WP), 'fake provider and workbench start');
    const html=await new Promise(resolve=>http.get({host:'127.0.0.1',port:WP,path:'/'},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve(b));}));
    const token=(html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/)||[])[1];const hdr={'x-wcw-token':token};
    const created=await post(WP,'/api/sessions',{title:'quality',cwd:HOME},hdr);const sid=created.session.id;
    await post(WP,'/api/memory',{memory:{id:'r4-live-a',scope:'project',name:'R4 Live A',description:'first live memory',type:'reference',body:'A'},cwd:HOME},hdr);
    await post(WP,'/api/memory',{memory:{id:'r4-live-b',scope:'project',name:'R4 Live B',description:'second live memory',type:'reference',body:'B'},cwd:HOME},hdr);
    const events=await stream({sessionId:sid,message:'run quality workflow',cwd:HOME},hdr);
    const start=events.find(e=>e.type==='agent_workflow'&&e.state==='start');
    ok(start && start.nodeCount===12, 'quality workflow starts with all nodes');
    const listed=await get(WP,'/api/agent-runs?sessionId='+encodeURIComponent(sid),hdr);
    const run=listed && listed.runs && listed.runs.find(x=>x.id===start.id);const by=id=>run.nodes.find(n=>n.id===id);
    ok(by('finder_a').structuredResult && by('finder_a').status==='succeeded', 'node output is parsed and JSON-Schema validated');
    ok(by('review').gate.mode==='review' && by('review').status==='succeeded' && by('review').confidence===.9, 'Reviewer automatically validates dependencies as a quality gate');
    ok(by('vote').status==='succeeded' && by('vote').structuredResult.approvals===2, 'deterministic vote gate passes with two approvals');
    ok(by('dedupe').structuredResult.findings.length===1, 'dedupe gate merges duplicate findings');
    ok(by('bad_block').status==='failed' && by('blocked_child').status==='blocked', 'block policy prevents downstream execution');
    ok(by('bad_continue').status==='failed' && by('continued_child').status==='succeeded', 'continue policy unlocks downstream in degraded mode');
    ok(by('bad_retry').attempts===2 && by('retry_child').status==='succeeded', 'retry policy retries then applies continue fallback');
    const cliProxy=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[{id:'claude_parent_worker',task:'VALID_CLI_PROXY',outputSchema:qualitySchema}]});
    ok(cliProxy.ok===true && cliProxy.results[0].structuredResult.verdict==='pass','Claude CLI loopback can launch the same persistent structured DAG through a configured provider');
    const control=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'seed',task:'VALID_CONDITION_SEED',outputSchema:qualitySchema},
      {id:'taken',task:'VALID_TAKEN_BRANCH',dependsOn:['seed'],condition:{node:'seed',path:'verdict',operator:'equals',value:'pass'}},
      {id:'skipped',task:'SHOULD_NOT_RUN',dependsOn:['seed'],condition:{node:'seed',path:'verdict',operator:'equals',value:'fail'}},
      {id:'loop',task:'VALID_LOOP_CONSTANT',dependsOn:['taken','skipped'],outputSchema:qualitySchema,loop:{maxIterations:6,noProgressLimit:2,onNoProgress:'continue'}},
    ]});
    const controlBy=id=>control.results.find(n=>n.id===id);
    ok(control.ok===true && controlBy('taken').status==='succeeded' && controlBy('skipped').status==='skipped','conditions take the matching branch and persist the skipped branch');
    ok(controlBy('loop').attempts===3 && controlBy('loop').loopStopReason==='no_progress' && controlBy('loop').status==='succeeded','loop stops after the configured consecutive no-progress limit');
    const reliability=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'plain',task:'PLAIN_NON_VOTE'},
      {id:'invalid_vote',task:'DETERMINISTIC_VOTE',dependsOn:['plain'],gate:{mode:'vote',minApprovals:1}},
      {id:'bad_settled',task:'BAD_SETTLED',outputSchema:{type:'object',required:['ok'],properties:{ok:{type:'boolean'}}}},
      {id:'tolerant_fan_in',task:'VALID_AFTER_SETTLED',dependsOn:['bad_settled'],dependencyPolicy:'all_settled'},
      {id:'evidence_probe',task:'VALID_BUT_NO_TOOL',minSuccessfulToolCalls:1},
    ]});
    const reliabilityBy=id=>reliability.results.find(n=>n.id===id);
    ok(reliabilityBy('invalid_vote').status==='failed' && reliabilityBy('invalid_vote').errorClass==='vote_contract_failed' && reliabilityBy('invalid_vote').gateResult.verdict==='invalid','malformed vote inputs fail as a contract error instead of a false rejection');
    ok(reliabilityBy('bad_settled').status==='failed' && reliabilityBy('tolerant_fan_in').status==='succeeded','all_settled fan-in can consume a failed dependency without global continue policy');
    ok(reliabilityBy('evidence_probe').status==='failed' && reliabilityBy('evidence_probe').errorClass==='evidence_missing','factual probe can require successful tool-call evidence');
    // ── B8: a quality-gate "no" verdict (rejected) is distinct from an execution failure (failed). A rejected
    //    predecessor must NOT block downstream: a conditional child (run fix only when review verdict=fail)
    //    must FIRE, a pure dependsOn child must treat the gate as completed, and the run must not be reported failed.
    const b8=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'implement',task:'B8_IMPLEMENT'},
      {id:'review',task:'B8_REVIEW_FAIL',role:'reviewer',dependsOn:['implement']},
      {id:'fix',task:'B8_FIX',dependsOn:['review'],condition:{node:'review',path:'verdict',operator:'equals',value:'fail'}},
      {id:'verify',task:'B8_VERIFY',dependsOn:['implement','fix']},
    ]});
    const b8By=id=>b8.results.find(n=>n.id===id);
    ok(b8.ok===true && b8By('review').status==='rejected' && b8By('review').gateVerdict==='fail','B8: a fail verdict marks the gate node rejected (not failed), and the verdict is recorded');
    ok(b8By('fix').status==='succeeded','B8: conditional downstream of a rejected gate RUNS (condition review.verdict==fail fires; not blocked)');
    ok(b8By('verify').status==='succeeded','B8: a pure dependsOn downstream treats a rejected predecessor as completed and runs');
    ok(b8.status==='succeeded' && b8.results.every(n=>n.status!=='failed'&&n.status!=='blocked'),'B8: a quality rejection is not reported as a run failure (run succeeded; no failed/blocked nodes)');
    // ── M3(09-m3-coverage-gate.md): 质量门除 verdict 外还对照 coverage.unhandled 机器数据。verdict 虽 pass，
    //    但存在未覆盖输入项时默认收紧为 rejected(gate_uncovered)；空 unhandled 则正常通过。
    const m3=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'probe',task:'M3_PROBE'},
      {id:'review',task:'M3_UNCOVERED',role:'reviewer',dependsOn:['probe']},
    ]});
    const m3U=id=>m3.results.find(n=>n.id===id);
    ok(m3.ok===true && m3U('review').status==='rejected' && m3U('review').errorClass==='gate_uncovered' && m3U('review').gateVerdict==='fail','M3: a pass verdict with non-empty coverage.unhandled is rejected as gate_uncovered');
    ok(String(m3U('review').error).includes('b.js') && String(m3U('review').error).includes('c.js'),'M3: rejection error lists the uncovered input items');
    const m3c=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'probe',task:'M3_PROBE_FULL'},
      {id:'review',task:'M3_COVERED',role:'reviewer',dependsOn:['probe']},
    ]});
    const m3C=id=>m3c.results.find(n=>n.id===id);
    ok(m3C('review').status==='succeeded' && m3C('review').gateVerdict==='pass','M3: empty unhandled passes the coverage gate (full coverage)');
    // ── R1(13-r1-evidence-graph.md): 高风险门 requireEvidence。claim.evidenceRefs 指向不存在的证据
    //    (fake-openai 不产 tool 事件 -> evidence 索引空) -> unverified -> gate_unverified rejected。
    //    非高风险模板同样 unverified 但仅标记不阻断(兼容存量,零回归)。normalizeAgentGate 修复后 requireEvidence 才透传到 node.gate。
    const r1=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'probe',task:'R1_PROBE'},
      {id:'audit',task:'R1_UNVERIFIED',role:'reviewer',dependsOn:['probe'],gate:{mode:'review',requireEvidence:true}},
    ]});
    const r1By=id=>r1.results.find(n=>n.id===id);
    ok(r1.ok===true && r1By('audit').status==='rejected' && r1By('audit').errorClass==='gate_unverified' && r1By('audit').gateVerdict==='fail','R1: high-stakes gate (requireEvidence) rejects a pass verdict whose claims lack verifiable evidence (gate_unverified)');
    ok(String(r1By('audit').error).includes('无证据断言'),'R1: rejection error reports the unverifiable claims');
    const r1c=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'probe',task:'R1_PROBE'},
      {id:'soft',task:'R1_UNVERIFIED',role:'reviewer',dependsOn:['probe']},
    ]});
    const r1C=id=>r1c.results.find(n=>n.id===id);
    ok(r1C('soft').status==='succeeded','R1: non-high-stakes gate marks unverified claims but does NOT block (backwards-compatible)');
    ok(r1C('soft').structuredResult.findings[0].status==='unverified','R1: unverified claim status still recorded (marked, not deleted)');
    // C1 fake workflow e2e: an upstream model tool call is indexed before the dependent gate starts;
    // fake model extracts the prompt catalog eventId. Forged IDs remain machine-unverified.
    const c1=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'source',task:'C1_TOOL_SOURCE',allowedTools:['file_read']},
      {id:'valid_gate',task:'C1_VALID_REF',role:'reviewer',dependsOn:['source'],gate:{mode:'review',requireEvidence:true}},
    ]});
    const c1By=id=>c1.results.find(n=>n.id===id);
    const c1Ref=c1By('valid_gate').structuredResult.findings[0].evidenceRefs[0];
    ok(c1By('source').attempts===1 && c1Ref.startsWith(`evt_${c1.runId}_source_a1_`) && c1By('valid_gate').structuredResult.findings[0].status==='verified','C1 e2e: downstream gate prompt exposes the upstream tool eventId and a legal reference verifies');
    ok(c1By('valid_gate').status==='succeeded' && c1By('valid_gate').errorClass!=='gate_unverified','C1 e2e: verified evidence does not trigger gate_unverified');
    const workerCatalog=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'source',task:'C1_TOOL_SOURCE_WORKER',allowedTools:['file_read']},
      {id:'worker',task:'C1_VALID_REF',dependsOn:['source'],outputSchema:{type:'object',required:['findings'],properties:{findings:{type:'array',items:{type:'object',required:['evidenceRefs'],properties:{evidenceRefs:{type:'array',items:{type:'string'}}}}}}}},
    ]});
    const wcBy=id=>workerCatalog.results.find(n=>n.id===id);
    ok(wcBy('worker').structuredResult.findings[0].evidenceRefs[0].startsWith(`evt_${workerCatalog.runId}_source_a1_`),'C1 e2e: evidence catalog is injected into a non-gate model node too');
    const c1f=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'source',task:'C1_TOOL_SOURCE_FORGED',allowedTools:['file_read']},
      {id:'forged_gate',task:'C1_FORGED_REF',role:'reviewer',dependsOn:['source'],gate:{mode:'review',requireEvidence:true}},
    ]});
    const c1F=id=>c1f.results.find(n=>n.id===id);
    ok(c1F('forged_gate').status==='rejected' && c1F('forged_gate').errorClass==='gate_unverified' && c1F('forged_gate').structuredResult.findings[0].status==='unverified','C1 e2e adversarial: a forged out-of-catalog eventId is unverified and rejected');
    const r4=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'source',task:'R4_MEMORY_SOURCE'},
      {id:'relation_gate',task:'R4_MEMORY_RELATIONS',role:'reviewer',dependsOn:['source']},
    ]});
    const r4Relations=await get(WP,'/api/memory/relations?cwd='+encodeURIComponent(HOME)+'&scope=project&includePending=true',hdr);
    const r4Pending=Array.isArray(r4Relations&&r4Relations.pending)?r4Relations.pending:[];
    ok(r4.ok===true && r4.results.find(n=>n.id==='relation_gate').structuredResult.memoryRelations.length===1,'R4-S2 e2e: gate model emitted memoryRelations only after seeing both indexed ids');
    ok(r4Pending.some(rel=>rel.from==='r4-live-a'&&rel.to==='r4-live-b'&&rel.type==='contradicts'&&rel.confirmed===false),'R4-S2 e2e: real workflow hook persisted the gate proposal as pending'+(r4Pending.length?'':' (response '+JSON.stringify(r4Relations)+')'));
    const c2Gap=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'handled',task:'M2_HANDLED'},
      {id:'coverage',task:'MUST_NOT_CALL_MODEL',dependsOn:['handled'],gate:{mode:'coverage',inputSet:['a','b','c'],allowPartialCoverage:true}},
      {id:'gap_gate',task:'C1_VALID_REF',role:'reviewer',dependsOn:['coverage'],gate:{mode:'review',requireEvidence:true}},
    ]});
    const gapBy=id=>c2Gap.results.find(n=>n.id===id);
    const gapRef=gapBy('gap_gate').structuredResult.findings[0].evidenceRefs[0];
    ok(/^evt_.+_coverage_a\d+_gap_coverage_unhandled_0$/.test(gapRef) && gapBy('gap_gate').structuredResult.findings[0].status==='verified','C3 e2e: downstream gate can cite a digest-only deterministic_gap event');
    ok(gapBy('gap_gate').status==='succeeded' && !JSON.stringify(c2Gap).includes('"value":"c"'),'C3 e2e: deterministic gap traceability passes without exposing the raw gap value');
    // M3 bonus: allowPartialCoverage=true 降级路径此前因 normalizeAgentGate 丢字段从未生效,修复后验证。
    const m3p=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'probe',task:'M3_PROBE'},
      {id:'partial',task:'M3_UNCOVERED',role:'reviewer',dependsOn:['probe'],gate:{mode:'review',allowPartialCoverage:true}},
    ]});
    const m3P=id=>m3p.results.find(n=>n.id===id);
    ok(m3P('partial').status==='succeeded' && m3P('partial').gateVerdict==='pass','M3 bonus: allowPartialCoverage=true downgrades uncovered from rejection to warning (was broken before normalizeAgentGate fix)');
    const m2=await post(WP,'/api/agent-workflow/launch',{token,sessionId:sid,nodes:[
      {id:'handled',task:'M2_HANDLED'},
      {id:'coverage',task:'MUST_NOT_CALL_MODEL',dependsOn:['handled'],gate:{mode:'coverage',inputSet:['a','b','c']}},
      {id:'coverage_partial',task:'MUST_NOT_CALL_MODEL',dependsOn:['handled'],gate:{mode:'coverage',inputSet:['a','b','c'],allowPartialCoverage:true}},
      {id:'prop_source',task:'M2_PROPAGATE'},
      {id:'propagate',task:'MUST_NOT_CALL_MODEL',dependsOn:['prop_source'],gate:{mode:'propagate',propagateKey:'group'}},
      {id:'cycle_source',task:'M2_CYCLE'},
      {id:'cycle',task:'MUST_NOT_CALL_MODEL',dependsOn:['cycle_source'],gate:{mode:'propagate'}},
    ]});
    const m2By=id=>m2.results.find(n=>n.id===id);
    ok(m2By('coverage').status==='rejected' && m2By('coverage').errorClass==='gate_uncovered' && m2By('coverage').structuredResult.unhandled.join(',')==='c','M2: deterministic coverage rejects an uncovered item without a model call');
    ok(m2By('coverage_partial').status==='succeeded' && m2By('coverage_partial').structuredResult.unhandled[0]==='c','M2: deterministic coverage supports allowPartialCoverage');
    ok(m2By('propagate').status==='succeeded' && m2By('propagate').structuredResult.assignments.leaf==='blue','M2: deterministic propagate inherits assignments without a model call');
    ok(m2By('cycle').status==='failed' && m2By('cycle').errorClass==='propagate_cycle','M2: propagate cycle fails deterministically');
  }finally{kill(wb);kill(fake);await sleep(200);fs.rmSync(HOME,{recursive:true,force:true});}
  console.log('\nAGENT QUALITY WORKFLOW E2E: '+(failures?`FAIL (${failures})`:'ALL PASS'));process.exitCode=failures?1:0;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
