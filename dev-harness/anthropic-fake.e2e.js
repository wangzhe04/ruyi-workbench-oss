'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(全离线):真工作台的「模型服务商」引擎经 Anthropic Messages 协议(apiStyle:'anthropic',58 号方案批 2)跑工具循环。
// 假端点是 lib/fake-anthropic-provider.js,挂在 /anthropic 前缀下(兼容网关的常见形状)。
//   M1 端点与头:POST /anthropic/v1/messages;x-api-key + anthropic-version(非官方主机 auto 模式同时带 Bearer);
//      请求体是 Messages 形:顶层 system、max_tokens、adaptive thinking(claude-opus-5-5)、tools 的 input_schema、tool_choice auto,
//      没有 OpenAI 的 stream_options / messages[].role:'system';
//   M2 并行 tool_use:两个工具都真跑了,第二发里【一条】user 消息装两个 tool_result,排在最前;
//   M3 思考块 + 签名在同一段工具循环的下一发里【逐字节】回放(thinking / text / tool_use 原顺序);
//   M4 最终回答流进 assistant_delta、思考流进 thinking_delta;用量按 Anthropic 口径归一(input + cache_read + cache_creation)进 usage 事件;
//   M5 会话历史落了 providerBlocks(签名在),reasoning_content 照旧;
//   M6 第二个用户回合:上一回合的思考块不再回放(只丢最早的一段,API 明文允许),文本与 tool_use 照发;
//   M7 工具循环里遇到签名校验 400:去掉思考块重打一次就过,回合成功;
//   M8 子代理(08)走同一协议:请求形状对、结果成功;
//   M9 非流式(06 providerRawCompletion):后插的 system 规则以 <system-reminder> 留在对话里,回体取字正确;不带 tools 时工具块改写成文字;
//   M10 模型清单:GET /anthropic/v1/models 带 x-api-key,max_input_tokens 读成上下文窗口。
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-anthropic-'));
const HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const t = createRunner('ANTHROPIC FAKE');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const FILE_A = path.join(WORK, 'a.txt');
const FILE_B = path.join(WORK, 'b.txt');
fs.writeFileSync(FILE_A, 'marker ALPHA-4410', 'utf8');
fs.writeFileSync(FILE_B, 'marker BRAVO-9921', 'utf8');
const MODEL = 'claude-opus-5-5';

const blocksOf = req => (req.messages || []).flatMap(m => (Array.isArray(m.content) ? m.content : []));
const hasThinking = req => blocksOf(req).some(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));
const isSub = req => String(req.body && req.body.system || '').includes('子任务执行体');
const allText = req => JSON.stringify(req.messages || []);
let signatureRejects = 0;
function handler(req) {
  if (!req.stream) return messageEvents({ text: 'draft ok: ' + (allText(req).includes('<system-reminder>') ? 'reminder-seen' : 'no-reminder') });
  if (isSub(req)) return messageEvents({ text: 'sub done', usage: { input_tokens: 9, output_tokens: 2 } });
  const all = allText(req);
  const results = blocksOf(req).filter(b => b && b.type === 'tool_result');
  if (all.includes('TURN_TWO')) {
    // 第二回合:先开一个工具循环(带思考);下一发若还带着思考块就回签名失配 400(只回一次),去掉之后正常收尾
    if (!results.some(r => String(r.tool_use_id) === 'toolu_t2')) return messageEvents({ thinking: '第二回合想一下', signature: 'SIG-T2', toolUses: [{ id: 'toolu_t2', name: 'file_read', input: { path: FILE_A } }] });
    if (hasThinking(req)) {
      signatureRejects += 1;
      return { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } } };
    }
    return messageEvents({ text: 'turn two done', usage: { input_tokens: 30, output_tokens: 3 } });
  }
  if (!results.length) {
    return messageEvents({
      thinking: '两个文件一起读', signature: 'SIG-T1',
      text: '我并行读两个文件。',
      toolUses: [{ id: 'toolu_a', name: 'file_read', input: { path: FILE_A } }, { id: 'toolu_b', name: 'file_read', input: { path: FILE_B } }],
      usage: { input_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens: 11 },
    });
  }
  const seen = results.map(r => JSON.stringify(r.content)).join(' ');
  return messageEvents({ text: ['读到了 ', seen.includes('ALPHA-4410') && seen.includes('BRAVO-9921') ? 'ALPHA-4410 与 BRAVO-9921' : '缺东西'], usage: { input_tokens: 25, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, output_tokens: 7 } });
}

function request(port, method, route, body, headers = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + route)));
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
function chatStream(port, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
async function waitFor(fn, tries = 150, gap = 100) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}

(async () => {
  let fake = null, wb = null;
  try {
    fake = await startFakeAnthropic({ handler });
    const provider = { id: 'claude', label: 'Claude(假)', type: 'openai-compat', apiStyle: 'anthropic', baseUrl: fake.url + '/anthropic', apiKey: 'sk-ant-fake-key', model: MODEL, models: [{ id: MODEL, label: MODEL }] };
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 12, permissionMode: 'bypass', defaultWorkspace: WORK, stewardThreadBriefV1: false,
      providers: [provider], activeProvider: 'claude',
    }));
    const port = await getFreePort();
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME } });
    let log = ''; wb.stdout.on('data', d => { log += d; }); wb.stderr.on('data', d => { log += d; });
    const up = await waitFor(() => request(port, 'GET', '/health').catch(() => null), 80, 150);
    if (!up) throw new Error('workbench did not start: ' + log.slice(-800));
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const headers = { 'x-wcw-token': token };
    const created = await request(port, 'POST', '/api/sessions', { title: 'anthropic', cwd: WORK }, headers);
    const sessionId = created.session.id;

    // ── 第一回合:并行工具循环 ─────────────────────────────────────────────────────────────
    const ev1 = await chatStream(port, { sessionId, cwd: WORK, message: '并行读 a.txt 和 b.txt,告诉我两个标记。' }, headers);
    const first = fake.requests[0], second = fake.requests[1];
    ok(first && second, `M1 第一回合打了两发(${fake.requests.length})`);
    ok(fake.requests.every(r => r.url === '/anthropic/v1/messages'), 'M1 端点 = /anthropic/v1/messages');
    ok(first.headers['x-api-key'] === 'sk-ant-fake-key' && first.headers['anthropic-version'] === '2023-06-01' && first.headers.authorization === 'Bearer sk-ant-fake-key',
      'M1 头:x-api-key + anthropic-version,非官方主机 auto 模式也带 Bearer');
    const b1 = first.body;
    ok(typeof b1.system === 'string' && b1.system.length > 100 && b1.max_tokens === 32000 && b1.stream === true, 'M1 顶层 system、max_tokens、stream');
    ok(b1.thinking && b1.thinking.type === 'adaptive', 'M1 claude-opus-5-5 发 adaptive thinking');
    ok(!('stream_options' in b1) && !(b1.messages || []).some(m => m.role === 'system'), 'M1 没有 OpenAI 的 stream_options / system 角色消息');
    ok(Array.isArray(b1.tools) && b1.tools.length > 3 && b1.tools.every(x => x.name && x.input_schema && !x.function) && b1.tool_choice && b1.tool_choice.type === 'auto',
      'M1 工具是 { name, description, input_schema },tool_choice auto');
    const toolResults = ev1.filter(e => e.type === 'tool_result');
    ok(ev1.filter(e => e.type === 'tool_use').length === 2 && toolResults.length === 2 && toolResults.every(r => r.isError !== true), 'M2 两个 tool_use 都真跑了');
    const lastUser = second.messages[second.messages.length - 1];
    const trBlocks = (lastUser.content || []).filter(b => b.type === 'tool_result');
    ok(lastUser.role === 'user' && trBlocks.length === 2 && lastUser.content[0].type === 'tool_result' && lastUser.content[1].type === 'tool_result'
      && trBlocks.map(b => b.tool_use_id).join(',') === 'toolu_a,toolu_b', 'M2 两个 tool_result 装在同一条 user 消息里、排在最前');
    const replay = second.messages[second.messages.length - 2];
    ok(replay.role === 'assistant' && JSON.stringify(replay.content) === JSON.stringify([
      { type: 'thinking', thinking: '两个文件一起读', signature: 'SIG-T1' },
      { type: 'text', text: '我并行读两个文件。' },
      { type: 'tool_use', id: 'toolu_a', name: 'file_read', input: { path: FILE_A } },
      { type: 'tool_use', id: 'toolu_b', name: 'file_read', input: { path: FILE_B } },
    ]), 'M3 思考块 + 签名在下一发里原顺序逐字节回放(' + JSON.stringify(replay.content).slice(0, 160) + ')');
    const said = ev1.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const thought = ev1.filter(e => e.type === 'thinking_delta').map(e => e.text).join('');
    ok(said.includes('ALPHA-4410 与 BRAVO-9921'), 'M4 最终回答用到了两个工具结果(' + said.slice(-60) + ')');
    ok(thought.includes('两个文件一起读'), 'M4 思考流进 thinking_delta');
    const usage = ev1.filter(e => e.type === 'usage').pop();
    ok(usage && usage.usage && usage.usage.input_tokens === (20 + 300 + 40) + (25 + 300) && usage.usage.cached_input_tokens === 600 && usage.usage.output_tokens === 18,
      'M4 用量按 Anthropic 口径归一(input+cache_read+cache_creation;' + JSON.stringify(usage && usage.usage) + ')');
    ok((ev1.find(e => e.type === 'result') || {}).ok === true, 'M4 回合成功');
    // 会话存储 v2:providerHistory 在 sessions/<id>.provider.ndjson 旁车里,一行一条消息
    const providerFile = path.join(HOME, 'sessions', sessionId + '.provider.ndjson');
    const history = await waitFor(() => {
      if (!fs.existsSync(providerFile)) return null;
      const rows = fs.readFileSync(providerFile, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      return rows.some(m => m.role === 'assistant' && m.providerBlocks) ? rows : null;
    }, 50, 100) || [];
    const withBlocks = history.filter(m => m.role === 'assistant' && m.providerBlocks);
    ok(withBlocks.length === 1 && withBlocks[0].providerBlocks.protocol === 'anthropic' && withBlocks[0].providerBlocks.blocks[0].signature === 'SIG-T1' && withBlocks[0].reasoning_content === '两个文件一起读',
      `M5 历史落了 providerBlocks(签名在)与 reasoning_content(${withBlocks.length} 条)`);

    // ── 第二回合:旧思考块不回放;循环中途的签名失配 → 去块重打 ────────────────────────────────
    const before = fake.requests.length;
    const ev2 = await chatStream(port, { sessionId, cwd: WORK, message: 'TURN_TWO 再读一次 a.txt' }, headers);
    const turn2 = fake.requests.slice(before);
    ok(turn2.length === 3, `M6 第二回合三发:开循环、签名失配、去块重打(${turn2.length})`);
    const t2first = turn2[0];
    const oldAssistant = (t2first.messages || []).find(m => m.role === 'assistant' && JSON.stringify(m.content).includes('toolu_a'));
    ok(!hasThinking(t2first) && oldAssistant && oldAssistant.content.some(b => b.type === 'text') && oldAssistant.content.some(b => b.type === 'tool_use'),
      'M6 上一回合的思考块不回放,文本与 tool_use 照发');
    ok(hasThinking(turn2[1]) && !hasThinking(turn2[2]) && signatureRejects === 1, 'M7 签名失配 400 → 去掉思考块重打一次');
    ok((ev2.find(e => e.type === 'result') || {}).ok === true && ev2.filter(e => e.type === 'assistant_delta').map(e => e.text).join('').includes('turn two done'), 'M7 重打之后回合成功');

    // ── 子代理 ───────────────────────────────────────────────────────────────────────────
    const launch = await request(port, 'POST', '/api/agent-workflow/launch', { token, sessionId, async: true, nodes: [{ id: 'reader', task: '子任务:说一句完成', toolTier: 'read' }] }, headers);
    const run = await waitFor(async () => {
      const list = await request(port, 'GET', `/api/agent-runs?sessionId=${encodeURIComponent(sessionId)}`, null, headers);
      const r = list && Array.isArray(list.runs) && list.runs.find(x => x.id === launch.runId);
      return r && !r.live && ['succeeded', 'failed', 'partial', 'stopped', 'cancelled'].includes(r.status) ? r : null;
    }, 300, 100);
    const subReq = fake.requests.find(isSub);
    ok(run && run.status === 'succeeded', `M8 子代理跑完(${run && run.status})`);
    ok(subReq && subReq.url === '/anthropic/v1/messages' && subReq.body.thinking && subReq.body.messages[0].role === 'user' && !('stream_options' in subReq.body),
      'M8 子代理请求也是 Messages 形');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (wb) { try { killOwnTree(wb); } catch { /* gone */ } }
  }

  // ── 进程内:非流式与模型清单 ─────────────────────────────────────────────────────────────
  try {
    process.env.RUYI_HOME = path.join(ROOT, 'inproc');
    process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
    fs.mkdirSync(process.env.RUYI_HOME, { recursive: true });
    const srv = require(path.join(WB, 'app', 'server.js'));
    const provider = { id: 'claude', apiStyle: 'anthropic', baseUrl: fake.url + '/anthropic', apiKey: 'sk-ant-fake-key', model: MODEL, models: [] };
    const draft = await srv.providerRawCompletion(provider, [
      { role: 'user', content: '起草一份' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_d', type: 'function', function: { name: 'file_read', arguments: '{"path":"x"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_d', content: 'X 内容' },
      { role: 'system', content: 'STRICT JSON RULE' },
    ]);
    const draftReq = fake.requests.filter(r => !r.stream).pop();
    ok(draft.ok && draft.content === 'draft ok: reminder-seen', `M9 非流式取字正确(${JSON.stringify(draft)})`);
    ok(draftReq && draftReq.body.stream === false && draftReq.body.max_tokens === 8192 && JSON.stringify(draftReq.body.messages).includes('<system-reminder>\\nSTRICT JSON RULE\\n</system-reminder>'),
      'M9 后插的 system 规则以 <system-reminder> 留在对话里');
    const draftBlocks = (draftReq && draftReq.body.messages || []).flatMap(m => m.content);
    ok(!('tools' in draftReq.body) && draftBlocks.every(b => b.type === 'text') && draftBlocks.some(b => b.text === '[工具结果 toolu_d]\nX 内容'),
      'M9 不带 tools 的请求里没有 tool_use / tool_result 块(改写成文字,Messages 不收没有 tools 定义的工具块)');
    const listed = await srv.fetchOpenAiModels(provider);
    const hdr = fake.modelRequests[fake.modelRequests.length - 1] || {};
    ok(listed.ok && listed.models.length === 1 && listed.models[0].id === MODEL && listed.models[0].contextLength === 1000000, `M10 模型清单读到 max_input_tokens(${JSON.stringify(listed.models)})`);
    ok(hdr.url === '/anthropic/v1/models' && hdr.headers && hdr.headers['x-api-key'] === 'sk-ant-fake-key' && hdr.headers['anthropic-version'] === '2023-06-01', 'M10 清单请求带 Anthropic 头');
  } catch (error) {
    t.fail('fatal (in-process): ' + (error && error.stack || error));
  } finally {
    if (fake) await fake.close();
    await sleep(200);
    if (t.failures === 0) fs.rmSync(ROOT, { recursive: true, force: true });
    else console.log('[keep] ' + ROOT);
  }
  t.done({ exit: true });
})();
