'use strict';
/*
 * E2E (MicroAgent 候选 B 波 / M1, 11-m1-context-tiering.md): 编排上下文分级注入。
 *
 * 验证两点:
 *  1. 节点级 context 只注入声明它的节点 -- A 带 context('NODE_A_ONLY'), B 不带;
 *     A 的请求体含 NODE_A_ONLY 与全局 GLOBAL_CTX, B 只含 GLOBAL_CTX 不含 NODE_A_ONLY。
 *  2. 节点无 context 时行为与基线一致 -- 全局 context 仍注入所有节点, 不改变既有行为。
 *
 * Run: node dev-harness/agent-workflow-node-context.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-m1-node-context');
const CAPTURE_DIR = path.join(HOME, 'capture');
let FP, WP;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function get(port, p, headers={}) { return new Promise(resolve => { const r=http.get({host:'127.0.0.1',port,path:p,timeout:1000,headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch{resolve(null);}})});r.on('error',()=>resolve(null));r.on('timeout',()=>{r.destroy();resolve(null);});}); }
function post(port, p, body, headers={}) { return new Promise((resolve,reject)=>{const raw=JSON.stringify(body);const r=http.request({host:'127.0.0.1',port,path:p,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw),...headers}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}})});r.on('error',reject);r.write(raw);r.end();}); }
async function up(port, path0='/health') { for(let i=0;i<50;i++){if(await get(port,path0))return true;await sleep(120);}return false; }
function capturedBodies() {
  return fs.readdirSync(CAPTURE_DIR).filter(f => /^req-\d+\.json$/.test(f)).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, f), 'utf8')));
}
// 子代理节点请求的 user 消息内容（节点 task + context 都进 user 消息）按请求分开返回。
function nodeRequestUserTexts() {
  return capturedBodies().map(b => (b.messages || []).filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n'));
}

(async () => {
  FP = await getFreePort(); WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  // fake-openai: 子代理返回固定文本即可, 我们只检查【请求体】里 context 是否正确注入。
  const script = { parent: [{ name: 'orchestrate_agents', args: { nodes: [] } }], parentText: 'workflow done', subText: '{"ok":true}' };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxPerTurn: 12, subagentMaxConcurrent: 6, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake' }));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_SUBAGENT_SCRIPT: JSON.stringify(script), FAKE_CAPTURE_DIR: CAPTURE_DIR }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(FP, '/v1/models') && await up(WP), 'fake provider and workbench start');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'm1', cwd: HOME }, hdr);
    const sid = created.session.id;
    // 两个节点: A 声明节点级 context, B 不声明; 全局 context 同时存在。
    const res = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid, context: 'GLOBAL_CTX_MARKER',
      nodes: [
        { id: 'nodeA', task: 'TASK_A', context: 'NODE_A_ONLY_MARKER' },
        { id: 'nodeB', task: 'TASK_B' },
      ],
    }, hdr);
    ok(res.ok === true, 'M1: workflow with per-node context launches');
    // 等子代理请求落盘(两个节点各一次子代理调用)。
    for (let i = 0; i < 30 && nodeRequestUserTexts().length < 2; i++) await sleep(100);
    const reqs = nodeRequestUserTexts();
    const aReq = reqs.find(r => r.includes('TASK_A')) || '';
    const bReq = reqs.find(r => r.includes('TASK_B')) || '';
    ok(aReq.includes('NODE_A_ONLY_MARKER'), 'M1: node A receives its node-level context');
    ok(aReq.includes('GLOBAL_CTX_MARKER'), 'M1: node A also receives the global context');
    ok(!bReq.includes('NODE_A_ONLY_MARKER'), 'M1: node B does NOT receive node A context (per-node isolation)');
    ok(bReq.includes('GLOBAL_CTX_MARKER'), 'M1: node B still receives the global context (legacy compat)');
  } finally { kill(wb); kill(fake); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  console.log('\nAGENT WORKFLOW NODE CONTEXT E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
