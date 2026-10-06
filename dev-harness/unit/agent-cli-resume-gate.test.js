'use strict';
// 走查 W1 #2 / #5 / #6(05 runClaudeTurn / 05b Kimi ACP / 01 启动器探测)。真源码、临时 HOME、零网络;
// Kimi 用一个写在本件里的最小假 ACP 服务(initialize / session/new / session/resume / session/set_config_option / session/prompt),
// 沿用 kimi-agent-cli.e2e.js 的 npm shim 布局让 prepareAgentCliSpawn 直接起 node + main.mjs(Windows / Linux 都能跑)。
// 未导出的内部函数经 lib/server-internals.js 取(它【代替】对 server.js 的 require)。
//   [L] 回合入口的 CLI 在位判据 agentCliLauncherUsable:异步(探测期间事件循环照常转)、只有「缺失」才拒绝、
//       超时算「在,只是慢」、「在」按 60 s 记忆、缺失不记(刚装好立刻能用);探测结果三态由 agentCliProbeVerdict 给出。
//   [G] Kimi 默认模型(config.model 为空)时续接闸不再每回合判「模型变了」:claudeSessionModel 会被 Kimi 报回的实际模型改写,
//       闸现在比的是绑定时记下的「请求模型」(claudeSessionRequestedModel);显式换模型照旧触发重置。
//   [H] Kimi 在 session/prompt 应答前失败(这里用 session/resume 报错造)时清「已注入索引」hash,下回合补发索引;
//       prompt 已送达后的失败(JSON-RPC 错误应答)不清。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-gate-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
const work = path.join(root, 'work');
const fakeDir = path.join(root, 'fake-kimi');   // 假 ACP 服务的旗标 / 日志目录(经环境变量传给子进程)
for (const d of [home, data, work, fakeDir]) fs.mkdirSync(d, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
process.env.RUYI_HOME = data;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.KIMI_CODE_HOME = path.join(home, '.kimi-code');
process.env.FAKE_KIMI_DIR = fakeDir;
for (const k of ['WCW_FAKE_CLAUDE', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) delete process.env[k];

const writeConfig = patch => fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  configSchema: 11, defaultWorkspace: work, includeWorkbenchMcp: false, autoResumeClaudeSessions: true, autoImportClaudeCodeMcp: false,
  killPortOnStart: false, permissionMode: 'default', engineMode: 'legacy', providers: [], activeProvider: '', ...patch,
}, null, 2));
writeConfig({});

const { loadServerInternals } = require('../lib/server-internals');
const { agentCliLauncherUsable, agentCliProbeVerdict, invalidateAgentCliPathCaches, runSessionTurn, createSession, loadSession, mutateSession } = loadServerInternals([
  'agentCliLauncherUsable', 'agentCliProbeVerdict', 'invalidateAgentCliPathCaches', 'runSessionTurn', 'createSession', 'loadSession', 'mutateSession',
]);

const collect = () => { const events = []; return { events, onEvent: e => events.push(e) }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ───────────── [L] ─────────────
// .cjs 启动器:agentCliProbeSpawn 对它用 process.execPath 跑「<script> --version」,跨平台、不依赖 .cmd / 可执行位。
const launcher = (name, body) => { const file = path.join(root, name); fs.writeFileSync(file, body); return file; };

test('[L1] 三态判定:启动不起来 / 非 0 退出 = missing,超时被杀(status=null 无 error)与 ETIMEDOUT = slow,0 = ok', () => {
  assert.equal(agentCliProbeVerdict({ error: null, status: 0 }), 'ok');
  assert.equal(agentCliProbeVerdict({ error: null, status: null }), 'slow', '超时被杀:不算缺失');
  assert.equal(agentCliProbeVerdict({ error: { code: 'ETIMEDOUT' }, status: null }), 'slow');
  assert.equal(agentCliProbeVerdict({ error: { code: 'ENOENT' }, status: null }), 'missing');
  assert.equal(agentCliProbeVerdict({ error: { code: 'EACCES' }, status: null }), 'missing');
  assert.equal(agentCliProbeVerdict({ error: null, status: 1 }), 'missing', '退出码非 0 = 装坏了');
  assert.equal(agentCliProbeVerdict(null), 'missing');
});

test('[L2] 缺失不放行、不记忆;装好后立刻可用;「在」按 60 s 记忆', async () => {
  invalidateAgentCliPathCaches();
  const file = path.join(root, 'late-claude.cjs');
  assert.equal(await agentCliLauncherUsable(file), false, '启动器不存在 → 缺失');
  assert.equal(await agentCliLauncherUsable(''), false, '空路径 → 缺失');
  fs.writeFileSync(file, 'process.exit(0)');   // 「刚装好」
  assert.equal(await agentCliLauncherUsable(file), true, '缺失结果不记忆:装好后下一次立刻可用');
  fs.rmSync(file);
  assert.equal(await agentCliLauncherUsable(file), true, '「在」的结果记忆期内不再重探(文件删了仍答在)');
  invalidateAgentCliPathCaches();
  assert.equal(await agentCliLauncherUsable(file), false, '设置保存 / 重新检测作废记忆后重新探');
  const broken = launcher('broken-claude.cjs', 'process.exit(3)');
  assert.equal(await agentCliLauncherUsable(broken), false, '退出码非 0 → 缺失');
});

test('[L3] 慢启动器(--version 超过 4 s 探测上限):算「在」放行,且探测期间事件循环照常转', async () => {
  invalidateAgentCliPathCaches();
  const slow = launcher('slow-claude.cjs', 'setTimeout(() => process.exit(0), 9000);');
  let maxGap = 0, last = Date.now();
  const ticker = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 25);
  const t0 = Date.now();
  let usable;
  try { usable = await agentCliLauncherUsable(slow); } finally { clearInterval(ticker); }
  const took = Date.now() - t0;
  assert.equal(usable, true, '超时不再被误判成「未检测到 CLI」');
  assert.ok(took >= 3500 && took < 8500, `探测在 4 s 上限处结束(实际 ${took}ms)`);
  assert.ok(maxGap < 1000, `探测期间事件循环没被钉住(最长一次停顿 ${maxGap}ms;修前同步 spawnSync 会停满 4 s)`);
  const t1 = Date.now();
  assert.equal(await agentCliLauncherUsable(slow), true);
  assert.ok(Date.now() - t1 < 500, '慢启动器的「在」同样记忆,下一回合不再付 4 s');
});

test('[L4] 回合入口:CLI 真缺失仍走引导卡(code cli-missing);超时慢的不会挡回合', async () => {
  invalidateAgentCliPathCaches();
  writeConfig({ agentCliType: 'claude', claudePath: path.join(root, 'no-such-claude.cjs') });
  const session = await createSession({ title: 'missing', cwd: work });
  const sink = collect();
  await runSessionTurn({ sessionId: session.id, message: 'hello', cwd: work, onEvent: sink.onEvent });
  const result = sink.events.find(e => e.type === 'result');
  assert.ok(result && result.ok === false && result.code === 'cli-missing', `缺失:引导卡(实际 ${JSON.stringify(result)})`);
  assert.ok(sink.events.some(e => e.type === 'assistant_delta' && /未检测到/.test(e.text)), '给出可操作的中文说明');
});

// ───────────── Kimi 假 ACP ─────────────
const FAKE_MAIN = String.raw`
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.37.2-test'); process.exit(0); }
if (args[0] === 'provider') { console.log(JSON.stringify({ providers: {}, models: {} })); process.exit(0); }
if (args[0] !== 'acp') process.exit(2);
const dir = process.env.FAKE_KIMI_DIR;
const flag = name => fs.existsSync(path.join(dir, name));
const log = rec => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(rec) + '\n');
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
const modelOptions = () => [{ id: 'model', currentValue: process.env.FAKE_KIMI_ACTUAL_MODEL || 'kimi-code/actual-model',
  options: [{ value: 'kimi-code/actual-model' }, { value: 'kimi-code/other-model' }] },
  { id: 'thinking', currentValue: 'high', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max' }] }];
const modes = { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'plan' }, { id: 'auto' }, { id: 'yolo' }] };
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return;
  const m = msg.method;
  if (m === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '0.37.2-test' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { image: true, embeddedContext: true } } } });
  if (m === 'session/new') {
    log({ m });
    if (flag('fail-new')) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'fake: cannot create session' } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'kimi-sess-' + (++n), configOptions: modelOptions(), modes } });
  }
  if (m === 'session/resume') {
    log({ m, sessionId: msg.params.sessionId });
    if (flag('fail-resume')) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'fake: resume exploded' } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: modelOptions(), modes } });
  }
  if (m === 'session/set_config_option') {
    const p = msg.params;
    return send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [
      { id: 'mode', currentValue: p.configId === 'mode' ? p.value : 'default', options: modes.availableModes.map(x => ({ value: x.id })) },
      { id: 'model', currentValue: p.configId === 'model' ? p.value : (process.env.FAKE_KIMI_ACTUAL_MODEL || 'kimi-code/actual-model'), options: [{ value: 'kimi-code/actual-model' }, { value: 'kimi-code/other-model' }] },
      { id: 'thinking', currentValue: p.configId === 'thinking' ? p.value : 'high', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max' }] },
    ] } });
  }
  if (m === 'session/close') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (m === 'session/prompt') {
    const text = (msg.params.prompt || []).map(p => p && p.text || '').join('\n');
    log({ m, sessionId: msg.params.sessionId, text });
    if (flag('fail-prompt')) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'provider.auth_error: 403 usage limit reached' } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FAKE_KIMI_OK' } } } });
    return setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }), 20);
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
});
`;
const kimiShimDir = path.join(root, 'kimi-npm');
const kimiEntry = path.join(kimiShimDir, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
const kimiShim = path.join(kimiShimDir, 'node_modules', '.bin', 'kimi.cmd');
fs.mkdirSync(path.dirname(kimiEntry), { recursive: true });
fs.mkdirSync(path.dirname(kimiShim), { recursive: true });
fs.writeFileSync(kimiEntry, FAKE_MAIN);
fs.writeFileSync(kimiShim, `@"${process.execPath}" "%~dp0\\..\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*\r\n`);

const kimiLog = () => { try { return fs.readFileSync(path.join(fakeDir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const resetFake = () => { for (const f of fs.readdirSync(fakeDir)) fs.rmSync(path.join(fakeDir, f), { recursive: true, force: true }); };
const kimiConfig = patch => writeConfig({ agentCliType: 'kimi', kimiPath: kimiShim, ...patch });
const lastAssistantText = async sessionId => {
  const saved = await loadSession(sessionId);
  const last = (saved.messages || []).filter(m => m.role === 'assistant').pop();
  return String(last && last.content || '');
};
const runTurn = async (sessionId, message) => {
  const sink = collect();
  await runSessionTurn({ sessionId, message, cwd: work, onEvent: sink.onEvent });
  return sink.events;
};

// ───────────── [G] ─────────────
test('[G1] Kimi 默认模型(config.model 为空):实际模型改写 claudeSessionModel,但续接闸不再每回合判「模型变了」', async () => {
  resetFake(); invalidateAgentCliPathCaches();
  kimiConfig({ model: '' });
  const session = await createSession({ title: 'kimi default model', cwd: work });
  const e1 = await runTurn(session.id, '第一回合');
  assert.ok(e1.some(e => e.type === 'assistant_delta' && /FAKE_KIMI_OK/.test(e.text)), `第一回合跑通(事件:${e1.map(e => e.type).join(',')})`);
  const s1 = await loadSession(session.id);
  assert.equal(s1.claudeSessionId, 'kimi-sess-1', '绑定了原生会话');
  assert.equal(s1.claudeSessionModel, 'kimi-code/actual-model', 'claudeSessionModel 仍是 Kimi 报回的实际模型(状态面板 / 上下文窗口要用)');
  assert.equal(s1.claudeSessionRequestedModel, '', '另记「请求的模型」= 空(默认)');

  const e2 = await runTurn(session.id, '第二回合');
  assert.equal(e2.some(e => e.type === 'resume_recovery'), false, `第二回合不重置原生会话(修前:resume_recovery reason=model-changed;实际事件 ${JSON.stringify(e2.filter(e => e.type === 'resume_recovery'))})`);
  const s2 = await loadSession(session.id);
  assert.equal(s2.claudeSessionId, 'kimi-sess-1', '仍是同一个原生会话');
  const methods = kimiLog().map(r => r.m);
  assert.deepEqual(methods.filter(m => m === 'session/new'), ['session/new'], '全程只 new 过一次');
  assert.ok(methods.includes('session/resume'), '第二回合走的是 session/resume');
});

test('[G2] 显式换模型照旧触发重置(闸没被废掉);同模型不重置', async () => {
  resetFake(); invalidateAgentCliPathCaches();
  kimiConfig({ model: 'kimi-code/actual-model' });
  const session = await createSession({ title: 'kimi explicit model', cwd: work });
  await runTurn(session.id, '第一回合');
  assert.equal((await loadSession(session.id)).claudeSessionRequestedModel, 'kimi-code/actual-model');
  const same = await runTurn(session.id, '第二回合(同模型)');
  assert.equal(same.some(e => e.type === 'resume_recovery'), false, '同一显式模型:不重置');
  // 会话的引擎/模型归会话自己的 engineRoute 管(02e):用户在界面里换模型 = 改这条路由,不是改全局 config。
  await mutateSession(session.id, fresh => { fresh.engineRoute = { ...fresh.engineRoute, model: 'kimi-code/other-model' }; });
  const changed = await runTurn(session.id, '第三回合(换模型)');
  const rec = changed.find(e => e.type === 'resume_recovery');
  assert.ok(rec && rec.reason === 'model-changed', `换了请求模型:触发 model-changed 重置(实际 ${JSON.stringify(rec)})`);
  const s = await loadSession(session.id);
  assert.equal(s.claudeSessionRequestedModel, 'kimi-code/other-model', '重新绑定后记下新的请求模型');
});

test('[G3] 没有 claudeSessionRequestedModel 的老会话(修前绑定):退回 claudeSessionModel 比较,行为同修前', async () => {
  resetFake(); invalidateAgentCliPathCaches();
  kimiConfig({ model: 'kimi-code/actual-model' });
  const session = await createSession({ title: 'legacy bound', cwd: work });
  await runTurn(session.id, '第一回合');
  await mutateSession(session.id, fresh => { delete fresh.claudeSessionRequestedModel; fresh.claudeSessionModel = 'kimi-code/other-model'; });
  const e = await runTurn(session.id, '第二回合');
  assert.ok(e.some(x => x.type === 'resume_recovery' && x.reason === 'model-changed'), '旧字段与当前请求不符 → 照旧判模型变了');
});

// ───────────── [H] ─────────────
test('[H1] session/prompt 应答前失败(session/resume 报错):清 injectedIndexHash,下回合补发索引', async () => {
  resetFake(); invalidateAgentCliPathCaches();
  kimiConfig({ model: '', appendSystemPrompt: '' });
  const session = await createSession({ title: 'kimi index', cwd: work });
  await runTurn(session.id, '第一回合');
  const s1 = await loadSession(session.id);
  assert.ok(s1.injectedIndexHash, '第一回合注入了索引并记下 hash');
  assert.equal(s1.claudeSessionId, 'kimi-sess-1');

  // 第二回合:索引内容变了(用户加了自定义系统提示)→ 会重新注入、hash 先被置成新值;但 session/resume 失败,prompt 根本没送达。
  kimiConfig({ model: '', appendSystemPrompt: 'INDEX-MARKER-V2 请用海盗口吻' });
  fs.writeFileSync(path.join(fakeDir, 'fail-resume'), '1');
  await runTurn(session.id, '第二回合(resume 会失败)');
  assert.match(await lastAssistantText(session.id), /ACP 调用失败/, '第二回合如实失败');
  assert.equal(kimiLog().filter(r => r.m === 'session/prompt' && /第二回合/.test(r.text)).length, 0, 'prompt 确实没送达');
  const s2 = await loadSession(session.id);
  assert.equal(s2.injectedIndexHash, null, '修前这里还是第二回合的新 hash → 下回合因「内容没变」不再补发');
  assert.equal(s2.claudeSessionId, 'kimi-sess-1', '原生会话没丢(非 unknown-session 错误不新建)');

  // 第三回合:resume 恢复正常。索引必须补发给 Kimi。
  fs.rmSync(path.join(fakeDir, 'fail-resume'));
  await runTurn(session.id, '第三回合');
  const prompt3 = kimiLog().filter(r => r.m === 'session/prompt' && /第三回合/.test(r.text)).pop();
  assert.ok(prompt3, '第三回合 prompt 送达');
  assert.match(prompt3.text, /INDEX-MARKER-V2/, '索引(含新的自定义系统提示)补发了');
  assert.match(prompt3.text, /<workbench-context>|<ruyi-agent-cli-instructions>/, '以注入块的形式');
  assert.ok((await loadSession(session.id)).injectedIndexHash, '送达后 hash 重新记上');

  // 第四回合:内容没变、续接有效 → 不重复注入(去重仍然生效)
  await runTurn(session.id, '第四回合');
  const prompt4 = kimiLog().filter(r => r.m === 'session/prompt' && /第四回合/.test(r.text)).pop();
  assert.ok(prompt4 && !/INDEX-MARKER-V2/.test(prompt4.text), '已送达的索引不再重复发');
});

test('[H2] prompt 已送达后 Kimi 回 JSON-RPC 错误(额度/鉴权):不清 hash(索引已在它的转录里)', async () => {
  resetFake(); invalidateAgentCliPathCaches();
  kimiConfig({ model: '', appendSystemPrompt: '' });
  const session = await createSession({ title: 'kimi index rpc error', cwd: work });
  await runTurn(session.id, '第一回合');
  kimiConfig({ model: '', appendSystemPrompt: 'INDEX-MARKER-V3' });
  fs.writeFileSync(path.join(fakeDir, 'fail-prompt'), '1');
  await runTurn(session.id, '第二回合(额度用尽)');
  assert.match(await lastAssistantText(session.id), /ACP 调用失败/, '第二回合失败');
  assert.equal(kimiLog().filter(r => r.m === 'session/prompt' && /第二回合/.test(r.text) && /INDEX-MARKER-V3/.test(r.text)).length, 1, 'prompt(含新索引)已送达 Kimi');
  assert.ok((await loadSession(session.id)).injectedIndexHash, 'hash 保留:下回合不重复补发');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
