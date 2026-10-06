'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(全离线):Anthropic 兼容网关的接入 —— 2026-10 用户报「Anthropic API 的设置接入似乎有问题而且太复杂」,给的是
// DeepSeek 的 https://api.deepseek.com/anthropic。假端点按这类网关的真实脾气写得很「严」(lib/fake-anthropic-provider.js,
// models:null):
//   · 不提供模型清单(GET …/anthropic/v1/models → 404);
//   · 只认 x-api-key(没有或不对 → 401);
//   · max_tokens 超过 8192 → 400「Invalid max_tokens value, the valid range of max_tokens is [1, 8192]」(DeepSeek 的原话);
//   · 思考只认经典形 {type:'enabled'|'disabled'}(adaptive 等 → 400);不认 output_config(→ 400)。
//  G1 测试连接:没填模型 → code provider.test_needs_model(不再报「端点地址可能不对」);
//  G2 测试连接:填了模型 → 列清单 404 后用这个模型发一次最小补全,ok + modelsUnavailable;
//  G3 测试连接:密钥不对 → code provider.test_unauthorized;
//  G4 测试连接:Base URL 粘的是完整端点(…/anthropic/v1/messages)也通;
//  G5 一个真回合(思考:开 + 工具循环):首发 max_tokens 撞上限 → 按报文的上限重打一次就过;思考走经典形、不带 output_config;
//     工具真跑了、最终回答落盘;思考块进 thinking 事件;
//  G6 第二个回合:学到的上限直接用,不再吃 400。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeAnthropic, messageEvents } = require('./lib/fake-anthropic-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-anthropic-gw-'));
const HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const FILE_A = path.join(WORK, 'a.txt');
fs.writeFileSync(FILE_A, 'marker GATEWAY-5521', 'utf8');
const KEY = 'sk-gateway-test';
const MODEL = 'ds-reasoner-gw';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('ANTHROPIC GATEWAY SETUP');
const { ok } = t;

const rejects = [];
const reject = (status, message, type = 'invalid_request_error') => { rejects.push(message); return { status, json: { error: { message, type } } }; };
function handler(ctx) {
  if (ctx.headers['x-api-key'] !== KEY) return reject(401, 'Authentication Fails, Your api key is invalid', 'authentication_error');
  const b = ctx.body || {};
  if (Number(b.max_tokens) > 8192) return reject(400, 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]');
  if (b.thinking && !['enabled', 'disabled'].includes(b.thinking.type)) return reject(400, `thinking.type: unknown variant \`${b.thinking.type}\`, expected \`enabled\` or \`disabled\``);
  if (b.output_config !== undefined) return reject(400, 'output_config: Extra inputs are not permitted');
  const lastUser = [...(ctx.messages || [])].reverse().find(m => m.role === 'user') || {};
  const blocks = Array.isArray(lastUser.content) ? lastUser.content : [{ type: 'text', text: String(lastUser.content || '') }];
  const hasToolResult = blocks.some(x => x && x.type === 'tool_result');
  const text = blocks.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
  if (!ctx.stream) return messageEvents({ text: 'pong', model: b.model });
  if (hasToolResult) return messageEvents({ text: '读到了:GATEWAY-5521', model: b.model });
  if (/CMD_READ/.test(text)) return messageEvents({ thinking: '先读文件', signature: '', toolUses: [{ id: 'toolu_gw1', name: 'file_read', input: { path: FILE_A } }], model: b.model });
  return messageEvents({ text: '你好', model: b.model });
}

let WP = 0;
function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WP, path: route, method, timeout: 30000, headers: { ...headers, ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}) } }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
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
  const fake = await startFakeAnthropic({ handler, models: null });
  WP = await getFreePort();
  const base = fake.url + '/anthropic';
  const provider = { id: 'gw', label: 'Gateway', type: 'openai-compat', apiStyle: 'anthropic', baseUrl: base, apiKey: KEY, model: MODEL, models: [{ id: MODEL, label: MODEL }], anthropicThinking: 'adaptive', reasoningEffort: 'high' };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 12, permissionMode: 'bypass', toolLoadingMode: 'full', defaultWorkspace: WORK, providers: [provider], activeProvider: 'gw',
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME } });
  wb.stderr.on('data', d => String(d).trim() && console.log('[wb!] ' + String(d).trim()));
  try {
    let healthy = false; for (let i = 0; i < 300 && !healthy; i++) { await sleep(120); healthy = !!(await request('GET', '/health').catch(() => null)); }
    ok(healthy, 'workbench starts');
    const html = await request('GET', '/');
    const token = (String(html).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const auth = { 'x-wcw-token': token };
    const test = p => request('POST', '/api/provider/test', { provider: p }, auth);

    // ── 测试连接 ──
    const g1 = await test({ ...provider, id: 'draft1', model: '', models: [] });
    ok(g1 && g1.ok === false && g1.code === 'provider.test_needs_model', `G1 no models list + no model → needs_model (got ${JSON.stringify(g1 && { code: g1.code, ok: g1.ok })})`);
    const before = fake.requests.length;
    const g2 = await test({ ...provider, id: 'draft2' });
    ok(g2 && g2.ok === true && g2.modelsUnavailable === true && g2.model === MODEL, `G2 models 404 → completion probe with the configured model succeeds (got ${JSON.stringify(g2)})`);
    const probeReq = fake.requests.slice(before).find(r => r.stream === false);
    ok(!!probeReq && /\/anthropic\/v1\/messages$/.test(probeReq.url) && probeReq.headers['x-api-key'] === KEY, 'G2 the probe hit /anthropic/v1/messages with x-api-key');
    ok(fake.modelRequests.length >= 1, 'G2 the models list was tried first');
    const g3 = await test({ ...provider, id: 'draft3', apiKey: 'sk-wrong' });
    ok(g3 && g3.ok === false && g3.code === 'provider.test_unauthorized' && g3.errorClass === 'provider_misconfigured', `G3 wrong key → unauthorized code (got ${JSON.stringify(g3 && { code: g3.code, cls: g3.errorClass })})`);
    const g4 = await test({ ...provider, id: 'draft4', baseUrl: base + '/v1/messages' });
    ok(g4 && g4.ok === true, `G4 a pasted full endpoint URL still works (got ${JSON.stringify(g4 && { ok: g4.ok, code: g4.code })})`);

    // ── 真回合 ──
    const created = await request('POST', '/api/sessions', { title: 'gateway', cwd: WORK }, auth);
    const sid = created && created.session && created.session.id;
    ok(!!sid, 'session created');
    const rejectsBefore = rejects.length;
    const turnStart = fake.requests.length;
    const ev = await streamChat({ sessionId: sid, message: 'CMD_READ 读一下 a.txt', cwd: WORK });
    ok(ev.some(e => e.type === 'result' && e.ok === true), `G5 the turn completes (errors: ${JSON.stringify(ev.filter(e => e.type === 'error' || (e.type === 'result' && !e.ok)).slice(0, 2))})`);
    const turnRejects = rejects.slice(rejectsBefore);
    ok(turnRejects.length === 1 && /max_tokens/.test(turnRejects[0]), `G5 exactly one 400 (max_tokens) in the whole turn, retried at the gateway's cap (got ${JSON.stringify(turnRejects)})`);
    const streamed = fake.requests.slice(turnStart).filter(r => r.stream);
    const accepted = streamed.filter(r => Number(r.body.max_tokens) <= 8192);
    ok(accepted.length >= 2 && accepted.every(r => r.body.thinking && r.body.thinking.type === 'enabled' && r.body.thinking.budget_tokens < r.body.max_tokens),
      `G5 thinking goes out in the classic {type:'enabled', budget_tokens} form within max_tokens (got ${JSON.stringify(accepted.map(r => [r.body.max_tokens, r.body.thinking]))})`);
    ok(streamed.every(r => r.body.output_config === undefined), 'G5 no output_config is sent to a non-Claude gateway model');
    ok(ev.some(e => e.type === 'tool_result' && JSON.stringify(e.content || '').includes('GATEWAY-5521')), 'G5 the file_read tool really ran');
    ok(ev.some(e => e.type === 'thinking_delta' && String(e.text || '').includes('先读文件')), 'G5 the gateway thinking block reaches the thinking stream');
    ok(ev.some(e => e.type === 'assistant_delta' && String(e.text || '').includes('GATEWAY-5521')), 'G5 the final answer streams back');

    const rejects2 = rejects.length;
    const ev2 = await streamChat({ sessionId: sid, message: '再说一句', cwd: WORK });
    ok(ev2.some(e => e.type === 'result' && e.ok === true) && rejects.length === rejects2, `G6 the next turn uses the learned cap directly — no more 400 (new rejects: ${JSON.stringify(rejects.slice(rejects2))})`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    try { killOwnTree(wb); } catch {}
    await fake.close();
  }
  t.done({ exit: true });
})().catch(e => { console.error(e); process.exit(2); });
