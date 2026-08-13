'use strict';
/*
 * E2E (候选 F / R5, 16-r5-replan-ledger.md): 可审查重规划提案 —— 第一步数据面 + 触发点。
 *
 * 验证两点:
 *  1. 声明 replan=true 的节点失败(rejected)时, run 落一条 status='pending' 的 replanPatch, trigger 归 gate_rejected。
 *  2. 未声明 replan 的节点失败时零迁移 —— run.replanPatches 仍为空(不生成提案)。
 *
 * 用 fake-openai 让两个 verify-gate 节点都返回 fail verdict, 从而 rejected; 仅 nodeA 声明 replan。
 * Run: node dev-harness/agent-workflow-replan.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-r5-replan');
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
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  // 两个 verify 节点都返回 fail verdict -> rejected; 仅 nodeA 声明 replan。
  const script = { parent: [{ name: 'orchestrate_agents', args: { nodes: [] } }], parentText: 'workflow done', subText: '{"verdict":"fail","confidence":0.1,"summary":"rejected by test"}' };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxPerTurn: 12, subagentMaxConcurrent: 6, agentWorkflowMaxNodes: 10, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake' }));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_SUBAGENT_SCRIPT: JSON.stringify(script) }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(FP, '/v1/models') && await up(WP), 'fake provider and workbench start');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'r5', cwd: HOME }, hdr);
    const sid = created.session.id;
    const res = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid,
      nodes: [
        { id: 'nodeA', task: 'TASK_A', replan: true, gate: { mode: 'verify', minConfidence: 0.5 } },
        { id: 'nodeB', task: 'TASK_B', gate: { mode: 'verify', minConfidence: 0.5 } },
      ],
    }, hdr);
    ok(res && res.runId, 'R5: workflow launches, got runId: ' + (res && res.runId));
    // 读持久化 run JSON 验证 replanPatches。
    const runFile = path.join(HOME, 'agent-runs', sid, `${res.runId}.json`);
    let run = null;
    for (let i = 0; i < 20 && !run; i++) { try { run = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { await sleep(100); } }
    ok(run != null, 'R5: persisted run JSON readable');
    ok(Array.isArray(run && run.replanPatches), 'R5: run has replanPatches array');
    ok((run && run.replanPatches && run.replanPatches.length) === 1, 'R5: exactly one replanPatch (nodeA only, nodeB zero-migration)');
    const p = run && run.replanPatches && run.replanPatches[0];
    ok(p && p.status === 'pending', 'R5: patch status is pending (never auto-applied)');
    ok(p && p.trigger && p.trigger.type === 'gate_rejected', 'R5: trigger classified as gate_rejected');
    ok(p && p.trigger && p.trigger.nodeId === 'nodeA', 'R5: patch targets nodeA (the replan=true node)');
    ok(Array.isArray(p && p.changes), 'R5: changes is an array (empty, pending to fill)');
  } finally { kill(wb); kill(fake); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  console.log('\nAGENT WORKFLOW REPLAN E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
