'use strict';
/*
 * E2E (候选 F / R5, 16-r5-replan-ledger.md §3.3): 模型 review 角色自动生成 changes。
 *
 * 验证:
 *  1. 失败节点(replan=true, gate fail)触发 pending patch;
 *  2. fire-and-forget spawn 只读 review 子代理, 其 task 含"重规划审查员", 返回 changes JSON;
 *  3. 逐条机器校验后 patch.changes 被填充(changesSource='review');
 *  4. approve 此时能真正 apply(add_node), patch status='applied'。
 *
 * Run: node dev-harness/agent-workflow-replan-review.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-r5-review');
let FP, WP;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function get(port, p, headers={}) { return new Promise(resolve => { const r=http.get({host:'127.0.0.1',port,path:p,timeout:1000,headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch{resolve(null);}})});r.on('error',()=>resolve(null));r.on('timeout',()=>{r.destroy();resolve(null);});}); }
function post(port, p, body, headers={}) { return new Promise((resolve,reject)=>{const raw=JSON.stringify(body);const r=http.request({host:'127.0.0.1',port,path:p,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw),...headers}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}})});r.on('error',reject);r.write(raw);r.end();}); }
async function up(port, path0='/health') { for(let i=0;i<50;i++){if(await get(port,path0))return true;await sleep(120);}return false; }

(async () => {
  FP = await getFreePort(); WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  // nodeA 返回 fail verdict -> rejected 触发 replan; review 子代理 task 含"重规划审查员" -> 返回 changes JSON。
  const changes = [{ op: 'add_node', target: 'nodeC', to: '补一个只读证据节点', from: ['nodeA'], reason: '补证据' }];
  const script = {
    parent: [{ name: 'orchestrate_agents', args: { nodes: [] } }],
    parentText: 'workflow done',
    subText: '{"verdict":"fail","confidence":0.1,"summary":"rejected by test"}',
    subTextByTask: { '重规划审查员': JSON.stringify({ changes }) },
  };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxPerTurn: 12, subagentMaxConcurrent: 6, agentWorkflowMaxNodes: 10, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake' }));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_SUBAGENT_SCRIPT: JSON.stringify(script) }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(FP, '/v1/models') && await up(WP), 'fake provider and workbench start');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'r5-review', cwd: HOME }, hdr);
    const sid = created.session.id;
    const res = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [ { id: 'nodeA', task: 'TASK_A', replan: true, gate: { mode: 'verify', minConfidence: 0.5 } } ] }, hdr);
    ok(res && res.runId, 'launch runId');
    // 等 patch + review 子代理填充 changes
    const runFile = path.join(HOME, 'agent-runs', sid, `${res.runId}.json`);
    let run = null;
    for (let i = 0; i < 40; i++) {
      try { run = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { run = null; }
      if (run && run.replanPatches && run.replanPatches[0] && Array.isArray(run.replanPatches[0].changes) && run.replanPatches[0].changes.length > 0) break;
      await sleep(150);
    }
    ok(run && Array.isArray(run.replanPatches) && run.replanPatches.length === 1, 'one replanPatch');
    const patch = run && run.replanPatches && run.replanPatches[0];
    ok(patch && Array.isArray(patch.changes) && patch.changes.length === 1, 'review 填充 changes: ' + JSON.stringify(patch && patch.changes));
    ok(patch && patch.changesSource === 'review', 'changesSource = review');
    ok(patch && patch.status === 'pending', 'patch 仍 pending(未自动 apply)');

    // approve 此时应真正 apply
    const ivs = await get(WP, '/api/interventions', hdr);
    const replanIv = (ivs.pending || []).find(i => i.type === 'replan');
    ok(replanIv != null, 'replan intervention registered');
    const decisionPath = `/api/missions/${replanIv.missionId}/interventions/${replanIv.id}/decision`;
    const app = await post(WP, decisionPath, { action: 'approve', expectedVersion: replanIv.interventionVersion, idempotencyKey: 'app-' + Date.now() }, hdr);
    ok(app && app.ok === true, 'approve 应用成功: ' + JSON.stringify(app));
    let run2 = null; for (let i=0;i<10 && !run2;i++){ try { run2 = JSON.parse(fs.readFileSync(runFile,'utf8')); } catch { await sleep(100); } }
    ok(run2 && run2.replanPatches && run2.replanPatches[0].status === 'applied', 'patch applied');
    ok(run2 && run2.nodes && run2.nodes.some(n => n.id === 'nodeC' && n.fromReplan === true), 'add_node 节点 nodeC 已物化');
  } finally { kill(wb); kill(fake); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  console.log('\nAGENT WORKFLOW REPLAN REVIEW E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
