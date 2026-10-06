'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
/*
 * 召出子代理后,父回合的思维链不许被切碎(用户:「召出子 agent 后,会话的思维链似乎会被切得很碎」)。
 *
 * 真服务 + 假 provider(reasoning_content / thinking 分片),经 /api/chat/stream 起回合,三处一起看:
 *   A 事件流 + 落盘 segments(02c 叙事账本):
 *     A1 同步 orchestrate_agents:父回合每个模型迭代各一段思考,子代理期间的事件不多切一段;
 *     A2 background:true 且下游节点在父回合【还在写思考】的当口才起(dependsOn 保证它晚到)—— 同一段连续思考
 *        落盘仍是一段(修前:thinking | subagent | thinking,同一段思考被后台节点的卡片切成两段);
 *     A3 子代理自己的思考 / 正文不进父回合的 segments;
 *   B 发给模型的历史(providerHistory + 下一发请求体):
 *     B1 chat 协议:每个父迭代恰一条 assistant 消息带完整 reasoning_content(不拆、不丢),下一发请求原样带回;
 *     B2 Anthropic 协议:thinking 块 + 签名在同一段工具循环的下一发里逐字节回放,子代理的事件不影响它。
 * 判定行:`SUBAGENT THINKING CONTINUITY E2E: ALL PASS`。
 */
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { startFakeAnthropic, messageEvents } = require('./lib/fake-anthropic-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const t = createRunner('SUBAGENT THINKING CONTINUITY');
const { ok } = t;
const FRAME = { id: 'chatcmpl-think' };
const reasoning = text => ({ id: 'chatcmpl-think', choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] });
const PARENT_PLAN = 'Plan: I should delegate. Spawning agents now.';
const STEPS = 20;
const parentSteps = Array.from({ length: STEPS }, (_, i) => `step${i} `);

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + route)));
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
function chatStream(port, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 60000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => resolve(events));
    });
    req.on('timeout', () => req.destroy(new Error('chat timeout'))); req.on('error', reject); req.write(data); req.end();
  });
}
async function waitFor(fn, tries = 150, gap = 100) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await sleep(gap); }
  return null;
}
async function boot(providerBase, apiStyle, model) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-sub-think-'));
  fs.writeFileSync(path.join(home, 'a.txt'), 'hello', 'utf8');
  const port = await getFreePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 12, permissionMode: 'bypass', defaultWorkspace: home, stewardThreadBriefV1: false,
    subagentMaxPerTurn: 8, subagentMaxConcurrent: 4, agentWorkflowMaxNodes: 16, agentAutoWake: false,   // 后台 run 的完成信封不另起「自动唤醒」回合(本件只看一个回合)
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', ...(apiStyle ? { apiStyle } : {}), baseUrl: providerBase, apiKey: 'k', model, models: [{ id: model, label: model }] }],
    activeProvider: 'fake',
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home } });
  const up = await waitFor(() => request(port, 'GET', '/health').catch(() => null), 100, 150);
  if (!up) throw new Error('workbench did not start');
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }));
  const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
  const headers = { 'x-wcw-token': token };
  return { home, port, wb, headers, close() { try { killOwnTree(wb); } catch { /* gone */ } try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows 句柄 */ } } };
}
async function runTurn(env, title, message) {
  const created = await request(env.port, 'POST', '/api/sessions', { title, cwd: env.home }, env.headers);
  const sessionId = created.session.id;
  const events = await chatStream(env.port, { sessionId, message, cwd: env.home, agentTeam: true }, env.headers);
  await sleep(600);
  const loaded = await request(env.port, 'GET', `/api/sessions/${sessionId}`, null, env.headers);
  const messages = (loaded && loaded.session && loaded.session.messages) || [];
  return { sessionId, events, session: loaded && loaded.session, assistant: messages.filter(m => m.role === 'assistant').pop() };
}
const segTypes = assistant => ((assistant && assistant.segments) || []).map(s => s.type + (s.background ? '*' : ''));
const thinkingSegs = assistant => ((assistant && assistant.segments) || []).filter(s => s.type === 'thinking');

// ── chat 协议的假 provider:父回合第一迭代 = 思考 + orchestrate_agents,第二迭代 = 慢速思考 + 正文;子代理用 NODE_A / NODE_B 区分 ──
function chatHandler(background) {
  return async req => {
    const sys = String((req.messages.find(m => m.role === 'system') || {}).content || '');
    const toolMsgs = req.messages.filter(m => m.role === 'tool');
    if (sys.includes('你是子任务执行体')) {
      const all = JSON.stringify(req.messages);
      const isA = all.includes('NODE_A');
      const calls = isA ? 3 : 1;
      if (toolMsgs.length >= calls) return [reasoning('SUBAGENT-SECRET-REASONING'), ...textFrames(isA ? 'sub A done' : 'sub B done', FRAME)];
      await sleep(isA ? 450 : 200);
      return [reasoning('SUBAGENT-SECRET-REASONING'), ...toolCallFrames('file_read', { path: 'a.txt', offset: toolMsgs.length }, `sub_${isA ? 'a' : 'b'}_${toolMsgs.length}`, FRAME)];
    }
    if (!toolMsgs.length) {
      const nodes = background
        ? [{ id: 'n1', task: 'NODE_A read stuff', toolTier: 'read' }, { id: 'n2', task: 'NODE_B read after A', toolTier: 'read', dependsOn: ['n1'] }]
        : [{ id: 'n1', task: 'NODE_A read stuff', toolTier: 'read' }, { id: 'n2', task: 'NODE_B read other', toolTier: 'read' }];
      return [reasoning('Plan: '), reasoning('I should delegate. '), reasoning('Spawning agents now.'), ...toolCallFrames('orchestrate_agents', { background, nodes }, 'call_orch', FRAME)];
    }
    return { frames: [...parentSteps.map(reasoning), ...textFrames('final answer', FRAME)], delayMs: 250 };
  };
}

async function chatScenario(name, background) {
  const fake = await startFakeProvider({ handler: chatHandler(background) });
  const env = await boot(fake.url, '', 'fake-model');
  try {
    const turn = await runTurn(env, name, '请分工');
    const { events, assistant, session } = turn;
    ok(events.some(e => e.type === 'result' && e.ok === true), `${name}: 回合成功收尾`);
    ok(events.some(e => e.type === 'subagent' && e.state === 'start' && (background ? e.background === true : !e.background)), `${name}: 事件流里确有子代理起头(${background ? '后台' : '前台'})`);
    const toolResultIdx = events.findIndex(e => e.type === 'tool_result' && !e.subagentId);
    const afterTool = events.slice(toolResultIdx + 1);
    const thinkIdx = afterTool.map((e, i) => (e.type === 'thinking_delta' ? i : -1)).filter(i => i >= 0);
    const lateStartIdx = afterTool.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'n2');
    if (background) {
      // 守门:没有这一条,下面的「不被切开」就可能是空断言(后台节点起得太早 / 太晚,根本没落在思考中途)。
      ok(thinkIdx.length > 3 && lateStartIdx > thinkIdx[0] && lateStartIdx < thinkIdx[thinkIdx.length - 1], `${name}: 夹具成立 —— 后台节点 n2 的起头事件落在父回合第二段思考的中途`);
      ok(afterTool.some(e => e.subagentId && e.type === 'tool_use') && afterTool.some(e => e.type === 'tool_result' && e.subagentId), `${name}: 且思考期间还有子代理自己的工具事件穿插进来`);
    }
    const segs = thinkingSegs(assistant);
    ok(segs.length === 2, `${name}: 落盘的 thinking 段恰两段 = 父回合的两次模型调用各一段(实得 ${segs.length};形状 ${segTypes(assistant).join(' | ')})`);
    ok(segs[0] && segs[0].text === PARENT_PLAN, `${name}: 第一段思考完整`);
    ok(segs[1] && segs[1].text === parentSteps.join(''), `${name}: 第二段思考是一整段连续文本(未被子代理的卡 / 事件切开),实得 ${segs[1] ? segs[1].text.length : 0} 字`);
    ok(!JSON.stringify(assistant.segments).includes('SUBAGENT-SECRET-REASONING') && !String(assistant.thinking || '').includes('SUBAGENT-SECRET-REASONING'), `${name}: 子代理自己的思考不串进父回合的 segments / thinking`);
    ok(assistant.thinking === (PARENT_PLAN + parentSteps.join('')).trim(), `${name}: 向后兼容字段 message.thinking 仍是两段按序拼接`);
    // B1 发给模型的历史
    const history = session.providerHistory || [];
    const assistants = history.filter(m => m.role === 'assistant');
    ok(assistants.length === 2 && assistants[0].reasoning_content === PARENT_PLAN && assistants[1].reasoning_content === parentSteps.join(''), `${name}: providerHistory 每个父迭代恰一条 assistant 带完整 reasoning_content(${assistants.length} 条)`);
    ok(!JSON.stringify(history).includes('SUBAGENT-SECRET-REASONING'), `${name}: providerHistory 里没有子代理的思考`);
    const parentSecond = fake.requests.filter(r => !String((r.messages.find(m => m.role === 'system') || {}).content || '').includes('你是子任务执行体') && r.messages.some(m => m.role === 'tool'))[0];
    const replayed = parentSecond && parentSecond.messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
    ok(replayed && replayed.reasoning_content === PARENT_PLAN, `${name}: 下一发请求把第一迭代的 reasoning_content 原样带回`);
  } finally { env.close(); await fake.close(); }
}

// ── Anthropic 协议:thinking 块 + 签名在工具循环的下一发里逐字节回放,子代理事件不影响 ──
async function anthropicScenario() {
  const name = 'B2 anthropic';
  const isSub = req => String(req.body && req.body.system || '').includes('你是子任务执行体');
  const blocksOf = req => (req.messages || []).flatMap(m => (Array.isArray(m.content) ? m.content : []));
  const fake = await startFakeAnthropic({
    handler(req) {
      if (!req.stream) return messageEvents({ text: 'draft' });
      if (isSub(req)) return messageEvents({ thinking: 'SUBAGENT-SECRET-THINKING', signature: 'SIG-SUB', text: 'sub done', usage: { input_tokens: 9, output_tokens: 2 } });
      const results = blocksOf(req).filter(b => b && b.type === 'tool_result');
      if (!results.length) {
        return messageEvents({ thinking: '先想好怎么分工', signature: 'SIG-ORCH', toolUses: [{ id: 'toolu_orch', name: 'orchestrate_agents', input: { nodes: [{ id: 'n1', task: 'NODE_A', toolTier: 'read' }] } }] });
      }
      return messageEvents({ thinking: '子代理回来了,汇总', signature: 'SIG-SECOND', text: 'done' });
    },
  });
  const env = await boot(fake.url + '/anthropic', 'anthropic', 'claude-opus-5-5');
  try {
    const turn = await runTurn(env, name, '请分工');
    const { assistant, session } = turn;
    ok(turn.events.some(e => e.type === 'result' && e.ok === true), `${name}: 回合成功收尾`);
    const parentReqs = fake.requests.filter(r => r.stream !== false && !isSub(r));
    ok(parentReqs.length === 2, `${name}: 父回合两发 Messages 请求(${parentReqs.length})`);
    const second = parentReqs[1];
    const replayedAssistant = second && (second.messages || []).find(m => m.role === 'assistant' && JSON.stringify(m.content).includes('toolu_orch'));
    const first = replayedAssistant && replayedAssistant.content[0];
    ok(first && first.type === 'thinking' && first.thinking === '先想好怎么分工' && first.signature === 'SIG-ORCH', `${name}: 第二发请求里 thinking 块 + 签名逐字节回放(在 tool_use 之前)`);
    ok(!JSON.stringify(second.messages).includes('SUBAGENT-SECRET-THINKING'), `${name}: 子代理的 thinking 块不进父回合的请求`);
    const withBlocks = (session.providerHistory || []).filter(m => m.role === 'assistant' && m.providerBlocks);
    ok(withBlocks.length === 2 && withBlocks[0].providerBlocks.blocks[0].signature === 'SIG-ORCH' && withBlocks[1].providerBlocks.blocks[0].signature === 'SIG-SECOND', `${name}: providerHistory 每个父迭代各一条 providerBlocks,签名都在(${withBlocks.length})`);
    const segs = thinkingSegs(assistant);
    ok(segs.length === 2 && segs[0].text === '先想好怎么分工' && segs[1].text === '子代理回来了,汇总', `${name}: 落盘 thinking 段两段、不含子代理的思考(形状 ${segTypes(assistant).join(' | ')})`);
  } finally { env.close(); await fake.close(); }
}

(async () => {
  try {
    await chatScenario('A1 同步 orchestrate', false);
    await chatScenario('A2 后台 orchestrate', true);
    await anthropicScenario();
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  }
  t.done({ exit: true });
})();
