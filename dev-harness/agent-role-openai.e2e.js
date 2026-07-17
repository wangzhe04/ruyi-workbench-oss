'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-role-openai-e2e');
const CAP = path.join(HOME, 'captures');
let failures = 0;
const ok = (c,l) => { if(c) console.log('PASS '+l); else { failures++; console.error('FAIL '+l); } };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function kill(c){if(c&&c.pid){try{cp.execFileSync('taskkill',['/PID',String(c.pid),'/T','/F'],{stdio:'ignore'});}catch{}}}
function health(port){return new Promise(resolve=>{const q=http.get({host:'127.0.0.1',port,path:'/health',timeout:800},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b));}catch{resolve(null);}})});q.on('error',()=>resolve(null));q.on('timeout',()=>{q.destroy();resolve(null);});});}
function stream(body){return new Promise((resolve,reject)=>{const raw=JSON.stringify(body);const q=http.request({host:'127.0.0.1',port:WB_PORT,path:'/api/chat/stream',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw)}},r=>{let b='',events=[];r.on('data',c=>{b+=c;let i;while((i=b.indexOf('\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);try{if(line.trim())events.push(JSON.parse(line));}catch{}}});r.on('end',()=>resolve(events));});q.on('error',reject);q.write(raw);q.end();});}

(async()=>{
  const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
  fs.rmSync(HOME,{recursive:true,force:true});fs.mkdirSync(CAP,{recursive:true});
  const forbidden=path.join(HOME,'forbidden.txt');
  fs.writeFileSync(path.join(HOME,'config.json'),JSON.stringify({
    configSchema:7,permissionMode:'bypass',subagentMaxConcurrent:2,subagentMaxPerTurn:4,
    providers:[{id:'fake',label:'Fake',type:'openai-compat',baseUrl:`http://127.0.0.1:${FAKE_PORT}`,apiKey:'k',model:'fake-model',models:[{id:'fake-model',label:'Fake'}]}],activeProvider:'fake',
    agentRoleOverrides:[{id:'locked-worker',label:'Locked Worker',description:'Restricted worker',prompt:'LOCKED_ROLE_MARKER',toolTier:'exec',models:{openai:'fake-model',claude:'inherit'},openaiTools:['file_read'],mcpServers:[],permissionMode:'bypass',budgets:{openai:3,claude:5}}]
  },null,2));
  const script=JSON.stringify({parent:[{name:'orchestrate_agents',args:{nodes:[{id:'locked',task:'try forbidden write',role:'locked-worker'}]}}],sub:[{name:'file_write',args:{path:forbidden,content:'bad'}}],subText:'restricted role done',parentText:'role workflow done'});
  const fake=cp.spawn(process.execPath,[path.join(__dirname,'fake-openai.js'),String(FAKE_PORT)],{env:{...process.env,FAKE_OPENAI_PORT:String(FAKE_PORT),FAKE_SUBAGENT_SCRIPT:script,FAKE_CAPTURE_DIR:CAP},windowsHide:true});
  const wb=cp.spawn(process.execPath,['app/server.js','serve','--port',String(WB_PORT)],{cwd:WB,env:{...process.env,RUYI_HOME:HOME},windowsHide:true});
  try{
    let up=null;for(let i=0;i<40&&!up;i++){await sleep(150);up=await health(WB_PORT);}ok(!!up,'OpenAI role test server starts');
    const events=await stream({message:'run role workflow',cwd:HOME});
    const start=events.find(e=>e.type==='subagent'&&e.state==='start');
    ok(start&&start.roleId==='locked-worker'&&start.roleLabel==='Locked Worker'&&start.model==='fake-model','role identity and model are visible in subagent event');
    const refusal=events.find(e=>e.type==='tool_result'&&e.subagentId&&e.content&&/未授权工具/.test(String(e.content.error||'')));
    ok(!!refusal,'execution-time allowlist rejects an unoffered tool');
    ok(!fs.existsSync(forbidden),'role tool restriction prevents filesystem mutation');
    const captures=fs.readdirSync(CAP).filter(f=>/^req-\d+\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(CAP,f),'utf8')));
    const subReq=captures.find(body=>(body.messages||[]).some(m=>m.role==='system'&&String(m.content||'').includes('LOCKED_ROLE_MARKER')));
    const names=(subReq&&subReq.tools||[]).map(t=>t.function&&t.function.name);
    ok(!!subReq&&names.includes('file_read')&&!names.includes('file_write'),'role prompt is injected and offered tools are filtered');
    const wfEnd=events.find(e=>e.type==='agent_workflow'&&e.state==='end');
    ok(wfEnd&&wfEnd.status==='succeeded','DAG node references role and completes');
  }finally{kill(wb);kill(fake);await sleep(250);}
  fs.rmSync(HOME,{recursive:true,force:true});
  console.log('\nAGENT ROLE OPENAI E2E: '+(failures?`FAIL (${failures})`:'ALL PASS'));process.exitCode=failures?1:0;
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
