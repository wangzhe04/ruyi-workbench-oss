'use strict';
// tool_invoke_* 代理的壳(2026-10 真机复盘:4 天 86 次代理调用、17 次失败,失败几乎全在 {name, arguments} 这层壳上)。
//   [E1] 两种写歪的壳确定地还原:自套娃(name 是 tool_invoke_*)、目标名塞进 arguments;内层带目标自己参数的不动。
//   [E2] 真分发路径(toolCall)上两种壳都能跑到目标。
//   [E3] 档位:代理档不低于目标档就放行(edit 代理调 file_read);低档代理调高档目标照旧拒(read 代理调 file_write)。
//   [E4] 整个漏写 name:错误里带用它自己参数拼好的正统形状 + 按参数键猜的候选,不替它执行。
//   [E5] 回合账按还原后的真实目标记。
//   [E6] 分包认得实时信息类说法(美股/走势/行情),普通代码任务不顺带联网包。
//   [E7] tool_search 只带命中条目所在包的说明;整张包说明表归 list_tools。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-tool-invoke-envelope-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { toolCall, classifyToolPacks, buildOpenAiTools, buildToolCatalog, searchToolCatalog, createToolLoadingState, dispatchTestHooks: H } = srv;
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, 'a.txt'), 'hello envelope');
const ctx = () => ({ config: { toolLoadingMode: 'auto' }, workingDir: ws, session: { id: 'sess_envelope', cwd: ws } });

test('[E1] 两种写歪的壳确定地还原,其余形状原样', () => {
  const repair = H.toolInvokeEnvelopeRepair;
  // 自套娃(真机 3 次)
  let r = repair({ name: 'tool_invoke_read', arguments: { name: 'file_read', arguments: { path: 'a.txt' } } });
  assert.deepEqual(r, { args: { name: 'file_read', arguments: { path: 'a.txt' } }, repair: 'self_wrap' });
  // 套两层也剥得开
  r = repair({ name: 'tool_invoke_exec', arguments: { name: 'tool_invoke_read', arguments: { name: 'file_list', arguments: {} } } });
  assert.deepEqual(r.args, { name: 'file_list', arguments: {} });
  assert.equal(r.repair, 'self_wrap');
  // 目标名塞进 arguments(真机 4 次);内层 arguments 是 JSON 字符串也认
  r = repair({ arguments: { name: 'web_search', arguments: { query: 'x' } } });
  assert.deepEqual(r, { args: { name: 'web_search', arguments: { query: 'x' } }, repair: 'nested_name' });
  r = repair({ arguments: '{"name":"web_search","arguments":{"query":"x"}}' });
  assert.equal(r.repair, 'nested_name');
  assert.equal(r.args.name, 'web_search');
  // 正统形状:同一引用、不标记
  const good = { name: 'file_read', arguments: { path: 'a.txt' } };
  assert.equal(repair(good).args, good);
  assert.equal(repair(good).repair, null);
  // 内层带着目标自己的参数(目标恰好有个 name 参数,外层漏了 name):不猜
  const own = { arguments: { name: 'file_read', path: 'a.txt' } };
  assert.equal(repair(own).repair, null);
  // 内层 name 不像工具名:不上提
  assert.equal(repair({ arguments: { name: 'My Report.docx' } }).repair, null);
  // 外层除了壳还有别的键:不上提
  assert.equal(repair({ arguments: { name: 'file_read', arguments: {} }, path: 'b.txt' }).repair, null);
  // 外层 name 是普通工具名、arguments 里又套了一层:那是目标自己的参数,不动
  assert.equal(repair({ name: 'file_read', arguments: { name: 'x', arguments: {} } }).repair, null);
  // 坏输入不抛
  for (const v of [null, undefined, 'str', 42, [], { arguments: null }]) assert.doesNotThrow(() => repair(v));
});

test('[E1b] 能被还原执行的形状,原始入参里的命令仍在高风险扫描范围内', () => {
  // Claude CLI 路径上权限桥拿到的是【还原前】的入参,06i 只摊平 4 层。剥壳上限必须保证:凡是还原后会执行的,
  // 原始形状里的命令都扫得到;更深的套娃不还原(照旧被拒),不能出现「闸看不见、却被执行」。
  const cmd = { command: 'shutdown /s /t 0' };
  const wrap = (inner, n) => { let x = inner; for (let i = 0; i < n; i += 1) x = { name: 'tool_invoke_exec', arguments: x }; return x; };
  const canonical = { name: 'powershell_run', arguments: cmd };
  assert.ok(srv.stewardToolPermanentlyExempt('tool_invoke_exec', canonical), '正统形状本身扫得到(基线)');
  const shapes = [
    wrap(canonical, 1), wrap(canonical, 2),
    { arguments: canonical }, { arguments: wrap(canonical, 1) },
  ];
  for (const raw of shapes) {
    const r = H.toolInvokeEnvelopeRepair(raw);
    assert.equal(r.args.name, 'powershell_run', JSON.stringify(raw));
    assert.ok(srv.stewardToolPermanentlyExempt('tool_invoke_exec', raw), `还原前的原始入参也扫得到:${JSON.stringify(raw)}`);
  }
  // 再深一层就不还原:目标仍是代理名,分发点按控制面拒绝
  assert.equal(H.toolInvokeEnvelopeRepair(wrap(canonical, 3)).args.name, 'tool_invoke_exec');
  assert.equal(H.toolInvokeEnvelopeRepair({ arguments: wrap(canonical, 2) }).args.name, 'tool_invoke_exec');
});

test('[E2] 真分发路径上两种壳都跑到目标', async () => {
  const self = await toolCall('tool_invoke_exec', { name: 'tool_invoke_read', arguments: { name: 'file_list', arguments: {} } }, ctx());
  assert.notEqual(self.ok, false, `修前回「control-plane tools cannot be invoked through a proxy」(got ${JSON.stringify(self).slice(0, 200)})`);
  assert.equal(path.resolve(self.root), path.resolve(ws));
  const nested = await toolCall('tool_invoke_read', { arguments: { name: 'file_read', arguments: { path: 'a.txt' } } }, ctx());
  assert.notEqual(nested.ok, false, `修前回「missing required 'name'」(got ${JSON.stringify(nested).slice(0, 200)})`);
  assert.match(JSON.stringify(nested), /hello envelope/);
});

test('[E3] 代理档不低于目标档放行;低档代理调高档目标照旧拒', async () => {
  const down = await toolCall('tool_invoke_edit', { name: 'file_read', arguments: { path: 'a.txt' } }, ctx());
  assert.notEqual(down.ok, false, `修前回「risk tier mismatch」(got ${JSON.stringify(down).slice(0, 200)})`);
  assert.match(JSON.stringify(down), /hello envelope/);
  const up = await toolCall('tool_invoke_read', { name: 'file_write', arguments: { path: 'b.txt', content: 'x' } }, ctx());
  assert.equal(up.ok, false);
  assert.match(up.error, /risk tier mismatch/);
  assert.equal(up.code, 'tier-mismatch');
  assert.match(up.hint, /tool_invoke_edit/);
  assert.ok(!fs.existsSync(path.join(ws, 'b.txt')), 'read 代理没能写出文件');
});

test('[E4] 整个漏写 name:错误里给正统形状示例与候选,不执行', async () => {
  const r = await toolCall('tool_invoke_read', { arguments: { query: '2026年10月2日 美股 三大指数 收盘 涨跌 一周回顾与下周展望' } }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid-arguments');
  assert.ok(Array.isArray(r.didYouMean) && r.didYouMean.includes('web_search'), JSON.stringify(r));
  // {query} 配得上不止一个工具:示例不替它挑名字,只列候选
  assert.equal(r.example.name, '<exact tool name from tool_search>');
  assert.deepEqual(r.example.arguments, { query: '2026年10月2日 美股 三大指数 收盘 涨跌 一周回顾与下周展望' });
  assert.match(r.error, /TOP level/);
  assert.match(r.error, /"arguments":\{"query":/);
  // 长值在示例里截短(参数可能是十几 KB 的文件内容)
  const big = await toolCall('tool_invoke_edit', { arguments: { path: 'c.txt', content: 'x'.repeat(5000) } }, ctx());
  assert.ok(big.example.arguments.content.length <= 41 && big.error.length < 600, big.error.slice(0, 200));
  // 候选不越档:read 代理不会被推荐到 edit/exec 工具
  const w = await toolCall('tool_invoke_read', { arguments: { path: 'b.txt', content: 'x' } }, ctx());
  assert.ok(!(w.didYouMean || []).includes('file_write'), JSON.stringify(w));
  assert.ok(!fs.existsSync(path.join(ws, 'b.txt')));
  const we = await toolCall('tool_invoke_edit', { arguments: { path: 'b.txt', content: 'x' } }, ctx());
  assert.deepEqual(we.didYouMean, ['file_write', 'code_check'], JSON.stringify(we));
  assert.equal(we.example.name, '<exact tool name from tool_search>', '候选源码也可只检查，不应替调用者选择写盘');
  const unique = await toolCall('tool_invoke_edit', { arguments: { path: 'b.txt', content: 'x', createDirs: true } }, ctx());
  assert.deepEqual(unique.didYouMean, ['file_write']);
  assert.equal(unique.example.name, 'file_write', '候选唯一时示例直接填上');
  assert.ok(!fs.existsSync(path.join(ws, 'b.txt')), '只提示、不替它执行');
  // 什么参数都没给:仍是同一种可行动的错误
  const empty = await toolCall('tool_invoke_exec', {}, ctx());
  assert.equal(empty.code, 'invalid-arguments');
  assert.equal(empty.example.name, '<exact tool name from tool_search>');
});

test('[E5] 回合账按还原后的真实目标记', () => {
  const t = H.unwrapToolInvokeCall({ name: 'tool_invoke_exec', input: { arguments: { name: 'script_run', arguments: { language: 'node', code: '1' } } } });
  assert.equal(t.name, 'script_run');
  assert.deepEqual(t.input, { language: 'node', code: '1' });
  const s = H.unwrapToolInvokeCall({ name: 'tool_invoke_exec', input: { name: 'tool_invoke_exec', arguments: { name: 'powershell_run', arguments: { command: 'dir' } } } });
  assert.equal(s.name, 'powershell_run');
});

test('[E6] 分包认得实时信息类说法', () => {
  assert.ok(classifyToolPacks('帮我查一下判断一下美股这周与下周的走势，中国国庆期间的整体走势判断').includes('web'));
  assert.ok(classifyToolPacks('今天 A股 行情怎么样').includes('web'));
  assert.ok(classifyToolPacks('明天北京天气').includes('web'));
  assert.ok(!classifyToolPacks('帮我重构这个函数,把重复代码抽出来').includes('web'));
});

test('[E7] tool_search 只带命中包的说明;list_tools 给整张表', () => {
  const tools = buildOpenAiTools({ toolLoadingMode: 'auto', allowCommandTools: true }, null, {});
  const catalog = buildToolCatalog(tools, {}, {});
  for (const cfg of [{}, { runtimeToolRetrievalV1: true }]) {
    const r = searchToolCatalog(catalog, { query: 'web search' }, cfg, { legacyNameBoost: 3 });
    const hitPacks = [...new Set(r.matches.map(m => m.pack))].sort();
    assert.deepEqual(Object.keys(r.packs).sort(), hitPacks, JSON.stringify(cfg));
    assert.ok(Object.keys(r.packs).length < 15);
  }
  const state = createToolLoadingState({ toolLoadingMode: 'auto' }, 'hi', null, tools, {});
  const listed = state.list({});
  assert.ok(listed.packs && listed.packs.web && listed.packs.files_read, JSON.stringify(Object.keys(listed)));
});
