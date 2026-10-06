'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:子代理(08 runSubAgentCore 的 OpenAI 子回合)遇到服务商 429 + Retry-After 时,至少等服务商要求的时长再重试。
// 修前子代理的退避是固定的 min(2000, 250·n):限流窗口还没过就把 3 次重试用光、子代理整个失败;主回合(09)已在
// 第一波服务商修复里按 Retry-After 退避,这里钉子代理与它同口径。离线,lib/fake-openai-provider。
//  R1 子代理的第一次请求回 429 + retry-after: 2 → 第二次请求与第一次相隔 ≥ 1.8 s;
//  R2 第二次成功,子代理的结论回到父回合,回合正常收尾。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-subagent-retry-after');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('SUBAGENT RETRY AFTER');
const { ok } = t;
const FRAME_ID = { id: 'chatcmpl-retry-after' };
const textOf = m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');

const subagentHits = [];
function handleChat(req) {
  const messages = req.messages || [];
  const sys = String((messages.find(m => m && m.role === 'system') || {}).content || '');
  if (sys.includes('你是子任务执行体')) {
    subagentHits.push(Date.now());
    if (subagentHits.length === 1) return { status: 429, json: { error: { message: 'rate limited, slow down', type: 'rate_limit' } }, headers: { 'retry-after': '2' } };
    return textFrames('SUB_OK 子代理结论', FRAME_ID);
  }
  const last = messages[messages.length - 1] || {};
  if (last.role === 'tool') return textFrames('父回合收尾。', FRAME_ID);
  if (messages.some(m => m.role === 'user' && textOf(m).includes('CMD_RA'))) return toolCallFrames('orchestrate_agents', { task: 'RA_TASK 看一下', agentKey: 'ra', toolTier: 'read' }, 'call_ra', FRAME_ID);
  return textFrames('好的。', FRAME_ID);
}

let WP = 0;
function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WP, path: route, method, timeout: 15000, headers: { ...headers, ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (raw) req.write(raw); req.end();
  });
}
function streamChat(body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = '';
    const req = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', timeout: 60000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) try { events.push(JSON.parse(line)); } catch {} } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('chat timeout')); }); req.write(raw); req.end();
  });
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const fake = await startFakeProvider({ handler: handleChat });
  WP = await getFreePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', toolLoadingMode: 'full', defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }], activeProvider: 'fake',
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME } });
  wb.stderr.on('data', d => String(d).trim() && console.log('[wb!] ' + String(d).trim()));
  try {
    let healthy = false; for (let i = 0; i < 300 && !healthy; i++) { await sleep(120); healthy = !!(await request('GET', '/health').catch(() => null)); }
    ok(healthy, 'workbench starts');
    const html = await request('GET', '/');
    const token = (String(html).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const created = await request('POST', '/api/sessions', { title: 'retry after', cwd: HOME }, { 'x-wcw-token': token });
    const sid = created && created.session && created.session.id;
    ok(!!sid, 'session created');
    const ev = await streamChat({ sessionId: sid, message: 'CMD_RA 派一个子代理', cwd: HOME });
    ok(ev.some(e => e.type === 'result' && e.ok === true), 'R2 the parent turn completes');
    ok(subagentHits.length === 2, `R1 the sub-agent retried exactly once after the 429 (requests: ${subagentHits.length})`);
    const gap = subagentHits.length >= 2 ? subagentHits[1] - subagentHits[0] : 0;
    ok(gap >= 1800, `R1 the retry waited for Retry-After: 2 (gap ${gap} ms; the fixed backoff alone is 250 ms)`);
    const parentAfterTool = fake.requests.filter(r => (r.messages || []).some(m => m.role === 'tool' && m.tool_call_id === 'call_ra')).pop();
    const toolMsg = parentAfterTool && (parentAfterTool.messages || []).find(m => m.role === 'tool' && m.tool_call_id === 'call_ra');
    ok(!!toolMsg && textOf(toolMsg).includes('SUB_OK'), 'R2 the sub-agent\'s answer reached the parent turn');
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    try { killOwnTree(wb); } catch {}
    await fake.close();
  }
  t.done({ exit: true });
})().catch(e => { console.error(e); process.exit(2); });
