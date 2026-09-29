'use strict';
// hunt2-engines:Agent CLI 回合骨架(05 runClaudeTurn / 05b)与它用到的几件公共小件的加固。真源码、临时 HOME、零网络;
// 回合走进程内 runSessionTurn + tools/fake-claude.js(WCW_FAKE_CLAUDE 测试缝),不起 HTTP 服务。
//   [C1] #1 同会话并发两个回合:修前 supersede 检查与 activeChildren.set 之间隔着十来个 await,两个回合都看见「空闲」,
//        各起一个 CLI 子进程且都跑完;修后 spawn 前再判一次,后到的顶掉先到的 —— 恰好一个跑完、一个被停。
//   [C9] #9 WCW_TOKEN 等回环凭据不在 CLI 进程环境里(模型的 Bash 会继承),只在 --mcp-config 那个 server 的 env 块里。
//   [C17] #17 CLI 刷屏的 stderr 不再整段落盘:会话里那条 stderr 消息有上限、保留头部、标明省略量。
//   [C7] #7 外部摘要模型坏了时,自动压缩失败一次后进入退避:下一回合不再重试(修前每回合都重试一次)。
//   [D8] #8 decodeClaudeCliText 的流式用法:块边界切开的汉字不再被误判成 GB18030 乱码;真 GB18030 流照旧解对。
//   [R3] #3 ACP 子进程已死、退出事件还没处理时回写 stdin 撞 EPIPE:这个 'error' 必须有人接,不能变成未捕获异常(服务整个退出)。
//        createKimiAcpRpc 不导出,且「在两个事件之间」的竞态端到端没法稳定复现 —— 这里按源码切出真函数放进 vm,
//        喂一个写入必回 EPIPE 的假子进程(判据是结构性的:通道对象必须接住自己 stdin 的错误)。
//   [K14] #14 syncMcpServersToKimi 并发调用串行化:一次读改写(读 mcp.json → 写 mcp.json 与所有权旁账)做完下一次才读。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-hardening-'));
const work = path.join(root, 'work');
const kimiHome = path.join(root, 'kimi-home');
fs.mkdirSync(work, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.KIMI_CODE_HOME = kimiHome;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
process.env.WCW_FAKE_CLAUDE = path.join(app, '..', 'tools', 'fake-claude.js');
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'WCW_FAKE_SLOW_MS', 'WCW_FAKE_ENV_CAPTURE', 'WCW_FAKE_ARGV_CAPTURE']) delete process.env[k];
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  configSchema: 7, version: '1.4.0', permissionMode: 'bypass', defaultWorkspace: work,
  activeProvider: '', autoImportClaudeCodeMcp: false, engineMode: 'print',
}, null, 2));
const srv = require(path.join(app, 'server.js'));

const collect = () => { const events = []; return { events, onEvent: e => events.push(e) }; };
const turn = (sessionId, message, sink, extra = {}) => srv.runSessionTurn({ sessionId, message, cwd: work, onEvent: sink.onEvent, ...extra });

test('[C1] 同会话并发两个回合:只有一个 CLI 子进程跑完,另一个被 supersede', async () => {
  process.env.WCW_FAKE_SLOW_MS = '1500';
  try {
    const session = await srv.createSession({ title: 'race', cwd: work });
    const a = collect(), b = collect();
    const pa = turn(session.id, 'first', a);
    const pb = turn(session.id, 'second', b);
    await Promise.all([pa.catch(e => e), pb.catch(e => e)]);
    const finals = [a, b].map(s => s.events.filter(e => e.type === 'process' && e.state !== 'running').map(e => e.state).pop());
    const running = [a, b].map(s => s.events.filter(e => e.type === 'process' && e.state === 'running').length);
    assert.deepEqual(running, [1, 1], '两个回合各起过一个子进程');
    assert.deepEqual(finals.slice().sort(), ['idle', 'stopped'], `恰好一个跑完、一个被顶掉(实际 ${JSON.stringify(finals)})`);
    assert.equal(srv.activeChildren.has(session.id), false, '收尾后登记表干净');
  } finally { delete process.env.WCW_FAKE_SLOW_MS; }
});

test('[C9] 回环凭据只在 --mcp-config 的 env 块里,不在 CLI 进程环境里', async () => {
  const envCap = path.join(root, 'env-cap.json');
  const argvCap = path.join(root, 'argv-cap.json');
  process.env.WCW_FAKE_ENV_CAPTURE = envCap;
  process.env.WCW_FAKE_ARGV_CAPTURE = argvCap;
  try {
    const session = await srv.createSession({ title: 'env', cwd: work });
    await turn(session.id, 'hello', collect());
    const seen = JSON.parse(fs.readFileSync(envCap, 'utf8'));
    for (const key of ['WCW_TOKEN', 'WCW_SESSION_ID', 'WCW_PORT', 'WCW_HOST']) assert.equal(seen[key], null, `${key} 不应出现在 CLI 进程环境里`);
    assert.ok(Number(seen.WCW_PERMISSION_TIMEOUT_MS) > 0, '权限等待时长(非凭据,会话 MCP 配置里没有)仍给 MCP 子进程继承');
    const argv = JSON.parse(fs.readFileSync(argvCap, 'utf8'));
    const mcpPath = argv[argv.indexOf('--mcp-config') + 1];
    const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    const own = Object.values(mcp.mcpServers).find(server => server && server.env && server.env.WCW_SESSION_ID);
    assert.ok(own, '会话 MCP 配置里有如意自己的 server');
    assert.equal(own.env.WCW_SESSION_ID, session.id);
    assert.ok('WCW_TOKEN' in own.env && 'WCW_PORT' in own.env && 'WCW_HOST' in own.env, 'MCP 子进程从配置的 env 块拿回环字段');
  } finally { delete process.env.WCW_FAKE_ENV_CAPTURE; delete process.env.WCW_FAKE_ARGV_CAPTURE; }
});

test('[C17] 刷屏的 stderr 落盘有上限(保留头部、标明省略)', async () => {
  const session = await srv.createSession({ title: 'stderr', cwd: work });
  const sink = collect();
  await turn(session.id, 'stderrflood please', sink);
  const saved = await srv.loadSession(session.id);
  const stderrMsg = saved.messages.filter(m => m.role === 'system' && m.source === 'stderr').pop();
  assert.ok(stderrMsg, '有 stderr 消息');
  assert.ok(stderrMsg.content.length <= 70 * 1024, `stderr 消息被限在 ~64K 字符内(实际 ${stderrMsg.content.length})`);
  assert.ok(stderrMsg.content.startsWith('STDERR-HEAD'), '保留头部');
  assert.match(stderrMsg.content, /已省略 \d+ 字符/, '标明省略量');
  const assistant = saved.messages.filter(m => m.role === 'assistant').pop();
  assert.ok(assistant && /Claude 工作台/.test(assistant.content), '正文照常');
});

test('[C7] 外部摘要模型失败后退避:下一回合不再重试自动压缩', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    ...cfg,
    providers: [{ id: 'dead', name: 'dead', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }],
    compactProviderId: 'dead', autoCompactThreshold: 0.5,
  }, null, 2));
  try {
    const session = await srv.createSession({ title: 'compact', cwd: work });
    // 一段已有的对话,上一条助手消息实测上下文 90 万 token(远超任何窗口的一半)。
    await srv.mutateSession(session.id, fresh => {
      fresh.messages.push({ role: 'user', content: '之前的问题', turnSeq: 1, createdAt: new Date().toISOString() });
      fresh.messages.push({ role: 'assistant', content: '之前的回答', turnSeq: 1, engine: 'claude', createdAt: new Date().toISOString(),
        usage: { contextTokens: 900000, contextWindow: 1000000 } });
      fresh.turnSeq = 1;
    });
    const started = [];
    for (const message of ['第一回合', '第二回合']) {
      // 压缩没成功,上下文就还是那么大:把最后一条助手消息的实测占用钉回 90 万(fake CLI 自己报的用量很小)。
      await srv.mutateSession(session.id, fresh => {
        const last = fresh.messages.filter(m => m.role === 'assistant').pop();
        last.usage = { contextTokens: 900000, contextWindow: 1000000 };
      });
      const sink = collect();
      await turn(session.id, message, sink);
      started.push(sink.events.filter(e => e.type === 'compact' && e.phase === 'started').length);
      assert.ok(sink.events.some(e => e.type === 'result'), `${message} 照常收尾`);
    }
    assert.deepEqual(started, [1, 0], `第一回合试压并失败,第二回合在退避期内不再试(实际 ${JSON.stringify(started)})`);
  } finally {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2));
  }
});

test('[D8] decodeClaudeCliText 流式:切开的汉字不误判,真 GB18030 照旧解对', () => {
  const text = '错误：无法连接到服务器，请检查网络设置后重试。'.repeat(3);
  const bytes = Buffer.from(text, 'utf8');
  for (let cut = 1; cut < 12; cut++) {
    const stream = {};
    const out = srv.decodeClaudeCliText(bytes.subarray(0, bytes.length / 2 + cut), stream)
      + srv.decodeClaudeCliText(bytes.subarray(bytes.length / 2 + cut), stream)
      + srv.decodeClaudeCliText(null, stream);
    assert.equal(out, text, `切点 +${cut}`);
  }
  const gb = Buffer.from([0xC7, 0xEB, 0xC7, 0xF3, 0xCA, 0xA7, 0xB0, 0xDC]);   // 「请求失败」GB18030
  const stream = {};
  assert.equal(srv.decodeClaudeCliText(gb.subarray(0, 4), stream) + srv.decodeClaudeCliText(gb.subarray(4), stream)
    + srv.decodeClaudeCliText(null, stream), '请求失败');
  assert.equal(srv.decodeClaudeCliText(gb), '请求失败', '不传流状态时一次性解码的旧行为不变');
});

test('[K14] syncMcpServersToKimi 并发调用串行:一次读改写做完,下一次才读', async () => {
  const config = await srv.readConfig();
  const target = path.join(kimiHome, 'mcp.json');
  const sidecar = path.join(root, 'kimi-mcp-sync.json');
  await srv.syncMcpServersToKimi({ ...config, includeWorkbenchMcp: true });   // 预热:生成物与目录都在了
  // 记录「读 mcp.json」与「所有权旁账落盘(rename 到位)」的先后。修前并发的两次调用都先读、再各自写:读 读 写 写 ——
  // 后写的一方基于旧快照把先写的一方盖掉(一方开/一方关时,旁账与 mcp.json 可能各留一半,接管前的原条目就此丢失)。
  const trace = [];
  const fsp = fs.promises;
  const readFile = fsp.readFile, rename = fsp.rename;
  fsp.readFile = async function (file, ...rest) {
    if (path.resolve(String(file)) === target) { trace.push('read'); await new Promise(r => setTimeout(r, 20)); }
    return readFile.call(this, file, ...rest);
  };
  fsp.rename = async function (from, to, ...rest) {
    const out = await rename.call(this, from, to, ...rest);
    if (path.resolve(String(to)) === sidecar) trace.push('commit');
    return out;
  };
  try {
    await Promise.all([
      srv.syncMcpServersToKimi({ ...config, includeWorkbenchMcp: false }),
      srv.syncMcpServersToKimi({ ...config, includeWorkbenchMcp: true }),
      srv.syncMcpServersToKimi({ ...config, includeWorkbenchMcp: false }),
    ]);
  } finally { fsp.readFile = readFile; fsp.rename = rename; }
  assert.deepEqual(trace, ['read', 'commit', 'read', 'commit', 'read', 'commit'], `读改写不交错(实际 ${trace.join(' ')})`);
  // 最后一次是「关」:如意接管的条目撤掉,旁账清空 —— 串行时结局就是最后一次调用的意图。
  const own = JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers || {};
  const ledger = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.deepEqual(ledger.managedIds, [], '旁账与最后一次调用的意图一致');
  assert.equal(Object.keys(own).length, 0, 'mcp.json 与旁账一致:没有残留如意条目');
});

test('[R3] createKimiAcpRpc 接住 stdin 的 EPIPE:通道记为关闭,后续请求同步失败而不是炸掉进程', async () => {
  const vm = require('vm');
  const { EventEmitter } = require('events');
  const { Writable, PassThrough } = require('stream');
  const { functionBlock } = require('../lib/source-slice');
  const src = fs.readFileSync(path.join(app, 'src', '05b-kimi-bridge.js'), 'utf8');
  const block = functionBlock(src, 'createKimiAcpRpc');
  assert.ok(block.length > 500, '切到了 createKimiAcpRpc');
  const sandbox = {
    createNdjsonLineFeeder: srv.createNdjsonLineFeeder,
    safeJsonParse: raw => { try { return JSON.parse(raw); } catch { return null; } },
    kimiAcpRpcError: (payload, method) => new Error(`${method} failed`),
    setTimeout, clearTimeout, Promise, Error, String, JSON, Map, AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${block}\nthis.createKimiAcpRpc = createKimiAcpRpc;`, sandbox);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); } });
  const uncaught = [];
  const onUncaught = error => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    const rpc = sandbox.createKimiAcpRpc(child, {});
    assert.equal(rpc.notify('session/cancel', {}), true, '写入本身是异步失败的,notify 当场不知道');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(uncaught.map(error => error.code), [], 'EPIPE 没有变成未捕获异常');
    assert.equal(rpc.isClosed(), true, '通道记为关闭');
    await assert.rejects(rpc.request('session/prompt', {}, 1000), /input channel is closed/, '之后的请求同步失败,不再往坏管道里写');
  } finally { process.removeListener('uncaughtException', onUncaught); }
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
