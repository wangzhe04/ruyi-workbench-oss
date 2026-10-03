'use strict';
// 代叫「叫得对」(2026-10):代叫不把完整说明书装进上下文,靠两样东西把参数叫对 ——
//   [G1] 参数骨架 toolArgsSkeleton:brief 给目录卡(必填在前、* / ? 标记、可选值、可空、$ref、截断且含尾注守住长度、
//        尾注点明藏起来的必填),full 给报错(带用途说明);'none' = 明确无参,'' = 压不成骨架(不拿「无参」误导)。
//   [G2] tool_search 的命中带 args 骨架:没装进工具表的带,已装的不带(说明书本来就在);MCP 路径不知道装了什么,一律带。
//   [G3] 代叫内置工具参数错:不执行,错误里递上完整骨架(argsGuide)。
//   [G4] 代叫桥接工具缺必填:本地先拦,不发给它的服务、不动文件,同样递骨架;正确的桥接代叫照常。
//   [G5] 只认锚定的服务端参数校验报错(pydantic / JSON-RPC -32602);自带 code 的(mcp-child-exited、退出码)不改写;
//        业务报错里的 missing required / invalid argument 不误判;原生不按文字猜;成功原样(同一引用)。
//   [G6] 本地必填检查不比服务端严:带 default / 可空的不算缺;入参非对象按空对象;required 里不在 properties 的忽略。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-args-guide-'));
const DATA = path.join(root, 'data');
const WORK = path.join(root, 'work');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const FAKE_MCP = path.resolve(__dirname, '..', 'fake-mcp.js');
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WORK, recentWorkspaces: [],
  toolLoadingMode: 'auto', bridgeExternalToolsToProvider: true, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  workspaces: [{ path: WORK, read: true, write: true, execute: true }],
  providers: [{ id: 'local', label: 'Local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }],
  activeProvider: 'local',
  externalMcpServers: [{ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_MCP], enabled: true }],
}, null, 2));
process.env.WIN_CLAUDE_WORKBENCH_HOME = DATA;
process.env.RUYI_HOME = DATA;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const H = srv.dispatchTestHooks;
after(() => {
  try { srv.killAllMcpClients(); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('[G1] 参数骨架:必填在前、标记、可选值、可空、$ref、截断(含尾注守住长度);full 带用途', () => {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Chart title shown above the plot' },
      path: { type: 'string', description: 'Absolute path to the .xlsx file' },
      mode: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'area', 'radar'] },
      region: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
      count: { type: ['integer', 'null'] },
      paths: { type: 'array', items: { type: 'string' } },
      opts: { type: 'object', properties: { deep: { type: 'boolean' } } },
    },
    required: ['path', 'mode'],
  };
  const brief = H.toolArgsSkeleton(schema, 'brief');
  assert.ok(brief.startsWith('path*:string, mode*:bar|line|pie|scatter|area|…'), brief);
  assert.ok(/title\?:string/.test(brief) && /region\?:string/.test(brief), '可选取前两个;pydantic 可空写法认成 string: ' + brief);
  assert.ok(/…\(\+3\)$/.test(brief), '剩下的记成 …(+N),没有藏起来的必填就不提: ' + brief);
  assert.ok(!/deep/.test(brief), '对象不往里展开');
  const full = H.toolArgsSkeleton(schema, 'full');
  assert.ok(/path\*:string — Absolute path to the \.xlsx file/.test(full), full);
  assert.ok(/count\?:integer/.test(full) && /paths\?:array<string>/.test(full) && /opts\?:object/.test(full), full);
  // 'none' 只给明确无参;说不清的形状回 ''(调用方不加 args / argsGuide)
  assert.equal(H.toolArgsSkeleton({ type: 'object', properties: {} }, 'brief'), 'none');
  for (const opaque of [null, { $ref: '#/$defs/X' }, { allOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }] }, { type: 'object', additionalProperties: true }]) {
    assert.equal(H.toolArgsSkeleton(opaque, 'full'), '', JSON.stringify(opaque));
  }
  // $ref → $defs(FastMCP 的 Enum 参数)、allOf 单包装、const、anyOf 混 enum 与类型、enum 数组、enum 对象
  const fm = {
    $defs: { Mode: { enum: ['fast', 'slow'], type: 'string' }, Box: { type: 'object', properties: { w: { type: 'integer' } } } },
    type: 'object',
    properties: {
      mode: { $ref: '#/$defs/Mode' }, box: { allOf: [{ $ref: '#/$defs/Box' }] }, kind: { const: 'x' },
      size: { anyOf: [{ enum: ['auto'] }, { type: 'integer' }] }, tags: { type: 'array', items: { enum: ['a', 'b'] } },
      shape: { enum: [{ w: 1 }, 'flat'] },
    },
    required: ['mode'],
  };
  const fmFull = H.toolArgsSkeleton(fm, 'full');
  assert.ok(/mode\*:fast\|slow/.test(fmFull) && /box\?:object/.test(fmFull) && /kind\?:x/.test(fmFull), fmFull);
  assert.ok(/size\?:auto\/integer/.test(fmFull) && /tags\?:array<a\|b>/.test(fmFull) && /shape\?:\{"w":1\}\|flat/.test(fmFull), fmFull);
  // 必填很多:总长(含尾注)守住 140,尾注点明藏起来几个必填
  const many = { type: 'object', properties: {}, required: [] };
  for (let i = 0; i < 12; i += 1) { many.properties[`argument_number_${i}`] = { type: 'string' }; many.required.push(`argument_number_${i}`); }
  const b2 = H.toolArgsSkeleton(many, 'brief');
  assert.ok(b2.length <= 140, `含尾注 ≤140(got ${b2.length}): ${b2}`);
  assert.match(b2, /…\(\+\d+, \d+ required\)$/);
  // 超长的可选值被截短
  const longEnum = { type: 'object', properties: { pick: { enum: ['x'.repeat(60), 'y'.repeat(60), 'z'.repeat(60)] } }, required: ['pick'] };
  const b3 = H.toolArgsSkeleton(longEnum, 'brief');
  assert.ok(b3.length <= 140, `got ${b3.length}: ${b3}`);
});

test('[G2] tool_search 命中带 args:没装的带,已装的不带;MCP 路径一律带', () => {
  const cfg = srv.defaultConfig();
  const tools = srv.buildOpenAiTools({ ...cfg, allowCommandTools: true }, null, {});
  const st = srv.createToolLoadingState(cfg, '你好', null, tools, {}, null);
  const r = st.search('zip archive', 8);
  const zip = r.matches.find(m => m.name === 'archive_zip');
  assert.ok(zip && /^paths\*:array<string>, dest\*:string/.test(zip.args), JSON.stringify(zip));
  assert.ok(zip.name && zip.pack && zip.tier && typeof zip.description === 'string', '原有字段都在');
  const web = st.search('web fetch page', 8).matches.find(m => m.name === 'web_fetch');
  assert.ok(web && web.args === undefined, '起手工具已在工具表里,不重复给骨架: ' + JSON.stringify(web));
  const viaMcp = srv.searchToolCatalog(srv.buildToolCatalog(tools, {}, cfg), { query: 'web fetch page' }, cfg, { legacyNameBoost: 3 });
  const web2 = viaMcp.matches.find(m => m.name === 'web_fetch');
  assert.ok(web2 && typeof web2.args === 'string' && web2.args.includes('url*'), 'MCP 路径不知道装了什么,一律带: ' + JSON.stringify(web2));
});

test('[G3] 代叫内置工具参数错:不执行,递上完整骨架', async () => {
  const config = await srv.readConfig();
  const ctx = { config, workingDir: WORK, session: { id: 'sess_g3', cwd: WORK } };
  const target = path.join(WORK, 'g3.txt');
  const r = await srv.toolCall('tool_invoke_edit', { name: 'file_write', arguments: { path: target } }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid-arguments');
  assert.ok(typeof r.argsGuide === 'string' && /path\*:string/.test(r.argsGuide) && /content\*:string/.test(r.argsGuide), JSON.stringify(r));
  assert.ok(!fs.existsSync(target), '参数不全没有执行');
  const okR = await srv.toolCall('tool_invoke_edit', { name: 'file_write', arguments: { path: target, content: 'hi' } }, ctx);
  assert.notEqual(okR.ok, false, JSON.stringify(okR));
  assert.equal(okR.argsGuide, undefined, '叫对了不附骨架');
});

test('[G4] 代叫桥接工具缺必填:本地先拦、不动文件;叫对照常', async () => {
  const config = await srv.readConfig();
  const ctx = { config, workingDir: WORK, session: { id: 'sess_g4', cwd: WORK } };
  // 先等桥接目录就绪(假 MCP 子进程起来、工具列出来),免得第一发在慢机器上撞「tool not found」
  for (let i = 0; i < 40; i += 1) {
    const s = await srv.toolCall('tool_search', { query: 'fake write_file echo' }, ctx);
    if (JSON.stringify(s).includes('fake__write_file')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const target = path.join(WORK, 'g4.txt');
  const r = await srv.toolCall('tool_invoke_exec', { name: 'fake__write_file', arguments: { path: target } }, ctx);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'invalid-arguments');
  assert.match(r.error, /missing required 'content'/);
  assert.ok(/content\*:string/.test(r.argsGuide) && /append\?:boolean/.test(r.argsGuide), JSON.stringify(r));
  assert.ok(!fs.existsSync(target), '没有发给服务端(假 MCP 的 write_file 收到就会建文件),文件没写');
  const echo = await srv.toolCall('tool_invoke_exec', { name: 'fake__echo', arguments: { message: 'hello-g4' } }, ctx);   // 未登记档位的桥接工具按 exec 算
  assert.ok(JSON.stringify(echo).includes('hello-g4') && echo.argsGuide === undefined, JSON.stringify(echo));
});

test('[G5] 只认锚定的服务端参数校验报错;自带 code 的不改写;业务报错不误判', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, sheet: { type: 'string' } }, required: ['path'] };
  const pyd = { ok: false, text: 'Error executing tool excel_read: 1 validation error for excel_readArguments\npath\n  Field required [type=missing]' };
  const g = H.withToolArgsGuide(pyd, schema, true);
  assert.equal(g.code, 'invalid-arguments');
  assert.match(g.argsGuide, /path\*:string; sheet\?:string/);
  assert.notEqual(g, pyd, '不改入参对象');
  assert.equal(pyd.argsGuide, undefined);
  const rpc = H.withToolArgsGuide({ ok: false, error: 'MCP error -32602: Invalid params' }, schema, true);
  assert.ok(typeof rpc.argsGuide === 'string');
  // 自带 code 的:那个 code 有它自己的意思(子进程退出可重试 / 退出码),不被 stderr 里的字样改写
  const exited = { ok: false, code: 'mcp-child-exited', retryable: true, error: 'child exited: pydantic ValidationError: 1 validation error for FooArguments' };
  assert.equal(H.withToolArgsGuide(exited, schema, true), exited);
  const exitCode = { ok: false, code: 1, error: 'Field required somewhere' };
  assert.equal(H.withToolArgsGuide(exitCode, schema, true), exitCode, '数字退出码不动');
  // 业务报错里出现的字样不算参数错
  for (const text of ["Sheet 'Q1' is missing required column 'Date'", 'File not found: C:\\docs\\invalid argument notes.docx', "[Errno 22] Invalid argument: 'C:\\\\x?y'", '页面不存在(HTTP 404)']) {
    const r = { ok: false, error: text };
    assert.equal(H.withToolArgsGuide(r, schema, true), r, text);
  }
  // 原生工具不按文字猜
  const native = { ok: false, error: '1 validation error for UserScript' };
  assert.equal(H.withToolArgsGuide(native, schema, false), native);
  // schema 压不成骨架:只校正 code,不递 argsGuide
  const opaque = H.withToolArgsGuide({ ok: false, error: 'Input should be a valid integer' }, { $ref: '#/$defs/Args' }, true);
  assert.equal(opaque.code, 'invalid-arguments');
  assert.equal(opaque.argsGuide, undefined);
  const okR = { ok: true, text: 'done' };
  assert.equal(H.withToolArgsGuide(okR, schema, true), okR, '成功原样(同一引用)');
});

test('[G6] 本地必填检查不比服务端严', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      mode: { type: 'string', default: 'fast' },
      region: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      limit: { type: ['integer', 'null'] },
      tag: { type: 'string', nullable: true },
    },
    required: ['path', 'mode', 'region', 'limit', 'tag', 'ghost'],
  };
  assert.deepEqual(H.toolArgsMissingRequired(schema, {}), ['path'], '带 default / 可空的不算缺;不在 properties 的 ghost 忽略');
  assert.deepEqual(H.toolArgsMissingRequired(schema, { path: null }), [], '显式 null 交给服务端判');
  assert.deepEqual(H.toolArgsMissingRequired(schema, 'oops'), ['path'], '入参不是对象按空对象算');
  assert.deepEqual(H.toolArgsMissingRequired(null, {}), []);
});
