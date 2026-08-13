'use strict';
/*
 * E2E (候选 F / R5, 16-r5-replan-ledger.md §3.3): 重规划提案审批路由。
 *
 * 验证审批闭环:
 *  1. 触发(replan=true 节点 rejected) → 生成 pending patch → 注册 Intervention(type 'replan')。
 *  2. GET /api/interventions 返回 replan 类型、counts.replan、replanSummary。
 *  3. 审批 reject → patch status='rejected' + metrics.interventions.replan_reject + 离开 pending 队列。
 *  4. 审批 approve(空 changes) → 诚实拒绝(replan_changes_pending),不应用、不静默。
 *
 * Run: node dev-harness/agent-workflow-replan-approve.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-r5-approve');
let FP, WP;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function get(port, p, headers={}) { return new Promise(resolve => { const r=http.get({host:'127.0.0.1',port,path:p,timeout:1000,headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch{resolve(null);}})});r.on('error',()=>resolve(null));r.on('timeout',()=>{r.destroy();resolve(null);});}); }
function post(port, p, body, headers={}) { return new Promise((resolve,reject)=>{const raw=JSON.stringify(body);const r=http.request({host:'127.0.0.1',port,path:p,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw),...headers}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}})});r.on('error',reject);r.write(raw);r.end();}); }
async function up(port, path0='/health') { for(let i=0;i<50;i++){if(await get(port,path0))return true;await sleep(120);}return false; }

async function boot() {
  FP = await getFreePort(); WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const script = { parent: [{ name: 'orchestrate_agents', args: { nodes: [] } }], parentText: 'workflow done', subText: '{"verdict":"fail","confidence":0.1,"summary":"rejected by test"}' };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxPerTurn: 12, subagentMaxConcurrent: 6, agentWorkflowMaxNodes: 10, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake' }));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_SUBAGENT_SCRIPT: JSON.stringify(script) }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  await up(FP, '/v1/models'); await up(WP);
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
  const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
  const hdr = { 'x-wcw-token': token };
  const created = await post(WP, '/api/sessions', { title: 'r5-approve', cwd: HOME }, hdr);
  const sid = created.session.id;
  return { fake, wb, token, hdr, sid };
}

(async () => {
  let env;
  try {
    env = await boot();
    const { token, hdr, sid } = env;

    // 场景 1: reject 全通
    const res1 = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [ { id: 'nodeA', task: 'TASK_A', replan: true, gate: { mode: 'verify', minConfidence: 0.5 } } ] }, hdr);
    ok(res1 && res1.runId, 'S1 launch runId');
    await sleep(1200);
    const ivs = await get(WP, '/api/interventions', hdr);
    const replanIv = (ivs.pending || []).find(i => i.type === 'replan');
    ok(replanIv != null, 'S1 replan intervention registered');
    ok(ivs.counts && ivs.counts.replan >= 1, 'S1 counts.replan >= 1');
    ok(replanIv && replanIv.replanSummary && replanIv.replanSummary.length > 0, 'S1 replanSummary present');
    ok(replanIv && replanIv.replanNodeId === 'nodeA', 'S1 replanNodeId = nodeA');

    const decisionPath = `/api/missions/${replanIv.missionId}/interventions/${replanIv.id}/decision`;
    const rej = await post(WP, decisionPath, { action: 'reject', expectedVersion: replanIv.interventionVersion, idempotencyKey: 'rej-' + Date.now() }, hdr);
    ok(rej && rej.ok === true, 'S1 reject ok');
    const runFile1 = path.join(HOME, 'agent-runs', sid, `${res1.runId}.json`);
    let run1 = null; for (let i=0;i<10 && !run1;i++){ try { run1 = JSON.parse(fs.readFileSync(runFile1,'utf8')); } catch { await sleep(100); } }
    ok(run1 && run1.replanPatches && run1.replanPatches[0].status === 'rejected', 'S1 patch rejected');
    ok(run1 && run1.metrics && run1.metrics.interventions && run1.metrics.interventions.replan_reject === 1, 'S1 replan_reject metric');
    const ivs2 = await get(WP, '/api/interventions', hdr);
    ok(!(ivs2.pending || []).some(i => i.id === replanIv.id), 'S1 intervention 离开 pending');

    // 场景 2: approve 空 changes 诚实拒绝
    const res2 = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [ { id: 'nodeB', task: 'TASK_B', replan: true, gate: { mode: 'verify', minConfidence: 0.5 } } ] }, hdr);
    ok(res2 && res2.runId, 'S2 launch runId');
    await sleep(1200);
    const ivs3 = await get(WP, '/api/interventions', hdr);
    const replanIv2 = (ivs3.pending || []).find(i => i.type === 'replan');
    ok(replanIv2 != null, 'S2 replan intervention registered');
    const decisionPath2 = `/api/missions/${replanIv2.missionId}/interventions/${replanIv2.id}/decision`;
    const app = await post(WP, decisionPath2, { action: 'approve', expectedVersion: replanIv2.interventionVersion, idempotencyKey: 'app-' + Date.now() }, hdr);
    ok(app && app.ok === false && app.reason === 'replan_changes_pending', 'S2 approve 空 changes 诚实拒绝: ' + JSON.stringify(app));
    const runFile2 = path.join(HOME, 'agent-runs', sid, `${res2.runId}.json`);
    let run2 = null; for (let i=0;i<10 && !run2;i++){ try { run2 = JSON.parse(fs.readFileSync(runFile2,'utf8')); } catch { await sleep(100); } }
    ok(run2 && run2.replanPatches && run2.replanPatches[0].status === 'pending', 'S2 patch 仍 pending(未应用)');
  } finally {
    if (env) { kill(env.wb); kill(env.fake); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  }
  console.log('\nAGENT WORKFLOW REPLAN APPROVE E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
