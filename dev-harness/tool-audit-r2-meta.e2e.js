require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(2026-10 工具走查第二轮·meta 组):元工具 / 记忆 / 代理 / MCP 里「验证过、却一直没修」的那批。
// 每条都是修前真调复现过的现场,断言写的是修后该有的行为(修前在这里会红):
//
//  (1) tool_invoke_* 代理到引擎特判工具(todo_write / mission_update / tool_search / wait_agents / orchestrate_agents)
//      在【真 provider 回合】里等价于直调 —— 修前 todo_write 经代理回 ok:true 却没落盘、没事件,mission_update 回
//      「独立调用仅校验」,wait_agents 报「仅在 provider 回合可用」;计划模式下代理不能绕开拦截;
//      无会话的 todo_write / mission_update 兜底不再谎称 ok:true。
//  (2) workbench_memory_revise / relation_propose 不给 scope 时与 memory_read 同口径自动判定(修前只在 global 的记忆「不存在」)。
//  (3) mcp_list 读盘上最新配置(同回合 upsert 之后看得到新连接器)。
//  (4) mcp_configure 入参校验:set-browser 的 mode / cdpUrl / 缺 browser / custom 没 executable;upsert 的 id 与 args 形状。
//  (5) orchestrate_agents:未知 toolTier、task+nodes 同给 → 拒;模型清单外的 model → notes 提示(不拒)。
//  (6) wait_agents 全是不存在的 runId → 顶层 ok:false;混着给 → ok:true + notFound。
//  (7) workbench_memory_list 带 query 时不给没命中的条目记使用;memory_propose 的重复错误点名已有记忆。
//  (8) permission_prompt 不进 list_tools / tool_search;skill_read(null) 回信封不抛;limit ≤ 0 一律回默认;
//      tool_invoke_* 去 name 空白、接受 JSON 字符串 arguments。
//  (9) 缺描述的入参补了描述(11 个工具抽样 + 全表无遗漏 + http_request.body 说明两种形态)。
//
// 判定行:`TOOL AUDIT R2 META E2E: ALL PASS`。
(async () => {
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createRunner } = require('./lib/harness');
const { killOwnTree } = require('./lib/kill-own-tree');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port');
const t = createRunner('TOOL AUDIT R2 META');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HOME = process.env.RUYI_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2meta-'));
process.env.RUYI_HOME = HOME; process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2meta-ws-'));
fs.writeFileSync(path.join(WS, 'a.txt'), 'hello a\n');
const PROVIDER = (baseUrl) => ({ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] });
const baseConfig = (providers, activeProvider) => ({
  configSchema: 10, permissionMode: 'bypass', engineMode: 'interactive', toolLoadingMode: 'full', defaultWorkspace: WS, recentWorkspaces: [WS],
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killOnDisconnect: false,
  subagentMaxPerTurn: 4, subagentMaxConcurrent: 2, agentWorkflowMaxNodes: 48,
  providers, activeProvider,
});

/* ═════════ Part A:进程内直调(toolCall) ═════════ */
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(baseConfig([PROVIDER('http://127.0.0.1:1')], 'fake'), null, 2));
const srv = require(SERVER);
const cfg = await srv.readConfig();
const session = await srv.createSession({ title: 'r2 meta', cwd: WS });
session.turnSeq = 1;
session.messages = [{ role: 'user', content: '记住所有项目都用 tab 缩进' }];
await srv.saveSession(session).catch(() => {});
const call = async (name, args, extra = {}) => {
  const ctx = extra.noCtx ? null : { sessionId: session.id, turnSeq: session.turnSeq, session, config: extra.config || cfg, workingDir: WS, ...(extra.ctx || {}) };
  try { return await srv.toolCall(name, args, ctx); } catch (e) { return { threw: String((e && e.message) || e) }; }
};
const nextTurn = () => { session.turnSeq += 1; };
const liveCfg = () => srv.readConfig();   // 盘上最新配置(normalizeConfig 补全默认值之后)
let fakeProvider = null, wb = null;

try {
  /* ── (2) 记忆 scope 自动判定 ── */
  const gdir = path.join(HOME, 'memory', 'global');
  fs.mkdirSync(gdir, { recursive: true });
  const memMd = (name, desc, type) => `---\nname: ${name}\ndescription: ${desc}\ntype: ${type}\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\nbody of ${name}\n`;
  fs.writeFileSync(path.join(gdir, 'glob-one.md'), memMd('Glob One', 'global only memory', 'preference'));
  fs.writeFileSync(path.join(gdir, 'glob-two.md'), memMd('Glob Two', 'another global memory', 'lesson'));
  const rd = await call('workbench_memory_read', { id: 'glob-one' });
  ok(rd.ok === true && rd.memory && rd.memory.scope === 'global', `B0 前置:memory_read 不给 scope 读得到只在 global 的记忆(got ${JSON.stringify(rd).slice(0, 100)})`);
  const rev = await call('workbench_memory_revise', { id: 'glob-one', body: 'new body', reason: '过时了' });
  ok(rev.ok === true && rev.proposal && rev.proposal.targetScope === 'global', `B1 memory_revise 不给 scope 时自动判到 global(修前:目标记忆不存在;got ${JSON.stringify(rev).slice(0, 160)})`);
  nextTurn();
  const rev2 = await call('workbench_memory_revise', { id: 'no-such-mem', body: 'x', reason: 'y' });
  ok(rev2.ok === false && /project/.test(rev2.error) && /global/.test(rev2.error), `B1b 找不到时错误说明两个 scope 都查过(got ${rev2.error})`);
  const rev3 = await call('workbench_memory_revise', { id: 'glob-one', scope: 'project', body: 'x', reason: 'y' });
  ok(rev3.ok === false && /scope=project/.test(rev3.error), `B1c 显式给错 scope 时错误点名 scope=project(got ${rev3.error})`);
  nextTurn();
  const rel = await call('workbench_memory_relation_propose', { type: 'supports', from: 'glob-one', to: 'glob-two', reason: '互相印证' });
  ok(rel.ok === true && rel.proposal && rel.proposal.scope === 'global', `B2 relation_propose 不给 scope 时自动判到 global(got ${JSON.stringify(rel).slice(0, 160)})`);
  nextTurn();

  /* ── (7) memory_list 的使用计数 / propose 去重信息 ── */
  fs.writeFileSync(path.join(gdir, 'glob-three.md'), memMd('Glob Three', 'third convention entry', 'convention'));
  const usageText = () => { try { return fs.readFileSync(path.join(HOME, 'memory', '_usage-v1.json'), 'utf8'); } catch { return ''; } };
  const zl = await call('workbench_memory_list', { query: 'zzzzqqqq' });
  ok(zl.ok === true && zl.memories.some(m => m.id === 'glob-three'), `B3 前置:preference/convention 条目没词命中也照常列出(got ${JSON.stringify((zl.memories || []).map(m => m.id))})`);
  ok(!/glob-three/.test(usageText()), `B3b 没命中 query 的条目不记使用(修前 useCount/lastUsedAt 被刷;usage=${usageText().slice(0, 160)})`);
  const hitList = await call('workbench_memory_list', { query: 'third convention' });
  ok(hitList.ok === true && /glob-three/.test(usageText()), `B3c 真命中的条目照常记使用(usage=${usageText().slice(0, 160)})`);
  const dup = await call('workbench_memory_propose', { name: 'Glob One', description: 'global only memory', type: 'preference', scope: 'global', body: 'dup body', reason: '测重复' });
  ok(dup.ok === false && dup.duplicate === true && dup.existingId === 'glob-one' && /workbench_memory_revise/.test(dup.error) && /glob-one/.test(dup.error),
    `B4 重复候选的错误点名已有记忆 id 并指向 workbench_memory_revise(got ${JSON.stringify(dup).slice(0, 220)})`);

  /* ── (3)(4) mcp_list / mcp_configure ── */
  const up = await call('mcp_configure', { operation: 'upsert', id: 'foo', server: { command: 'node', args: ['x.js'] } });
  ok(up.ok === true, `C0 前置:upsert foo 成功(got ${JSON.stringify(up).slice(0, 120)})`);
  const lst = await call('mcp_list', {});
  ok(lst.ok === true && lst.servers.some(s => s.id === 'foo'), `C1 同一回合 upsert 后 mcp_list 看得到新连接器(修前读回合起点快照;got ${JSON.stringify((lst.servers || []).map(s => s.id))})`);
  const b1 = await call('mcp_configure', { operation: 'set-browser', browser: { mode: 'bogus' } });
  ok(b1.ok === false && /system/.test(b1.error) && /cdp/.test(b1.error) && (await liveCfg()).browserAutomation.mode === 'system', `C2 mode:'bogus' → 拒并列允许值,配置没动(got ${JSON.stringify(b1).slice(0, 160)})`);
  const b2 = await call('mcp_configure', { operation: 'set-browser', browser: { mode: 'custom', executable: 'C:/x/chrome.exe' } });
  ok(b2.ok === true && b2.browserAutomation.mode === 'custom' && b2.browserAutomation.executable === 'C:/x/chrome.exe', `C3 合法的 custom + executable 照存(got ${JSON.stringify(b2).slice(0, 160)})`);
  const b3 = await call('mcp_configure', { operation: 'set-browser', browser: { mode: 'cdp' } });
  ok(b3.ok === true && b3.browserAutomation.mode === 'cdp' && b3.browserAutomation.executable === 'C:/x/chrome.exe', `C3b 只改 mode 时沿用盘上的 executable(修前整体重置成默认;got ${JSON.stringify(b3.browserAutomation)})`);
  const b4 = await call('mcp_configure', { operation: 'set-browser', browser: { cdpUrl: 'not a url' } });
  ok(b4.ok === false && /cdpUrl/.test(b4.error) && (await liveCfg()).browserAutomation.cdpUrl !== 'not a url', `C4 cdpUrl:'not a url' → 拒(got ${JSON.stringify(b4).slice(0, 160)})`);
  const b5 = await call('mcp_configure', { operation: 'set-browser' });
  ok(b5.ok === false && /browser/.test(b5.error) && (await liveCfg()).browserAutomation.mode === 'cdp', `C5 缺 browser 对象 → 拒,不重置现有配置(got ${JSON.stringify(b5).slice(0, 160)})`);
  await call('mcp_configure', { operation: 'set-browser', browser: { mode: 'system', executable: '' } });
  const b6 = await call('mcp_configure', { operation: 'set-browser', browser: { mode: 'custom' } });
  ok(b6.ok === false && /executable/.test(b6.error), `C6 custom 没有 executable → 拒(got ${JSON.stringify(b6).slice(0, 160)})`);
  const a1 = await call('mcp_configure', { operation: 'upsert', id: 'bar', server: { command: 'node', args: 'a "b c" d' } });
  ok(a1.ok === true && JSON.stringify(a1.server.args) === JSON.stringify(['a', 'b c', 'd']), `C7 args 给成字符串 → 按 shell 口径切开(修前静默存成 [];got ${JSON.stringify(a1.server && a1.server.args)})`);
  const a2 = await call('mcp_configure', { operation: 'upsert', id: 'bar2', server: { command: 'node', args: [1, 2] } });
  ok(a2.ok === false && /args/.test(a2.error), `C8 args 数组里混非字符串 → 拒(got ${JSON.stringify(a2).slice(0, 160)})`);
  const a3 = await call('mcp_configure', { operation: 'upsert', id: 'bar baz/../x', server: { command: 'node' } });
  ok(a3.ok === false && /id/.test(a3.error) && !((await liveCfg()).externalMcpServers || []).some(s => /baz/.test(s.id)), `C9 id 含空格/斜杠 → 拒(got ${JSON.stringify(a3).slice(0, 160)})`);
  const rm = await call('mcp_configure', { operation: 'remove', id: 'bar' });
  await call('mcp_configure', { operation: 'remove', id: 'foo' });
  ok(rm.ok === true, `C10 remove 不受 id 形状校验影响(got ${JSON.stringify(rm).slice(0, 100)})`);

  /* ── (6) wait_agents 的不存在 runId ── */
  const w1 = await srv.waitForAgentRunResults(session.id, ['run_doesnotexist'], 1000, null);
  ok(w1.ok === false && Array.isArray(w1.notFound) && w1.notFound[0] === 'run_doesnotexist' && /没有找到/.test(w1.error) && w1.timedOut === false,
    `D1 runId 全不存在 → 顶层 ok:false + notFound(修前 ok:true settled:false,读起来像还在跑;got ${JSON.stringify({ ok: w1.ok, notFound: w1.notFound, timedOut: w1.timedOut })})`);

  /* ── (8) 元工具杂项 ── */
  const lt = await call('list_tools', {});
  const ts = await call('tool_search', { query: 'permission prompt internal bridge', limit: 20 });
  ok(!JSON.stringify(lt).includes('permission_prompt') && !JSON.stringify(ts).includes('permission_prompt'), 'E1 permission_prompt 不出现在 list_tools / tool_search(它不能被调用)');
  const inv = await call('tool_invoke_read', { name: 'permission_prompt', arguments: {} });
  ok(inv.ok === false && /control-plane/.test(inv.error), `E1b tool_invoke 调 permission_prompt → 控制面拒绝(got ${JSON.stringify(inv).slice(0, 120)})`);
  const sk = await call('skill_read', null);
  ok(sk && sk.threw === undefined && sk.ok === false && sk.code === 'invalid-arguments', `E2 skill_read(null) 回 invalid-arguments 信封,不抛 TypeError(got ${JSON.stringify(sk).slice(0, 160)})`);
  const l0 = await call('list_tools', { limit: 0 }), lneg = await call('list_tools', { limit: -5 });
  ok(l0.count > 1 && l0.count === lneg.count, `E3 list_tools limit 0 与 -5 都回默认(修前 -5 → 1 条;got ${l0.count} / ${lneg.count})`);
  const s0 = await call('tool_search', { query: 'file', limit: 0 }), sneg = await call('tool_search', { query: 'file', limit: -5 });
  ok(s0.matches.length > 1 && s0.matches.length === sneg.matches.length, `E3b tool_search limit 0 与 -5 都回默认(got ${s0.matches.length} / ${sneg.matches.length})`);
  const m0 = await call('workbench_memory_list', { limit: 0 }), mneg = await call('workbench_memory_list', { limit: -5 });
  ok(m0.memories.length === 3 && mneg.memories.length === 3, `E3c workbench_memory_list limit 0 / -5 都回默认(got ${m0.memories.length} / ${mneg.memories.length})`);
  const sp = await call('tool_invoke_read', { name: ' file_read ', arguments: { path: 'a.txt' } });
  ok(sp.ok === true && /hello a/.test(sp.content || ''), `E4 tool_invoke 的 name 去首尾空白(got ${JSON.stringify(sp).slice(0, 120)})`);
  const js = await call('tool_invoke_read', { name: 'file_read', arguments: '{"path":"a.txt"}' });
  ok(js.ok === true && /hello a/.test(js.content || ''), `E4b tool_invoke 的 arguments 给成 JSON 字符串时解析(got ${JSON.stringify(js).slice(0, 120)})`);

  /* ── (1) 无会话的兜底 ── */
  const tdNo = await call('todo_write', { items: ['a'] }, { noCtx: true });
  ok(tdNo.ok === false && /会话/.test(tdNo.error), `F1 无会话时 todo_write 兜底 ok:false(修前 ok:true 却没落盘;got ${JSON.stringify(tdNo).slice(0, 120)})`);
  const msNo = await call('mission_update', { goal: 'g' }, { noCtx: true });
  ok(msNo.ok === false && /会话/.test(msNo.error), `F1b 无会话时 mission_update 兜底 ok:false(got ${JSON.stringify(msNo).slice(0, 120)})`);
  const tdYes = await call('todo_write', { items: ['a'] });
  ok(tdYes.ok === true && tdYes.persisted === false, `F1c 有会话上下文但不在回合内:仍校验通过,但明说 persisted:false(got ${JSON.stringify(tdYes).slice(0, 120)})`);
  ok(srv.planDiscoveryToolBatchAllowed([{ name: 'tool_invoke_read', rawArgs: JSON.stringify({ name: 'todo_write', arguments: { items: ['a'] } }) }], {}, {}) === false
    && srv.planDiscoveryToolBatchAllowed([{ name: 'tool_invoke_read', rawArgs: JSON.stringify({ name: 'orchestrate_agents', arguments: { task: 'x' } }) }], {}, {}) === false
    && srv.planDiscoveryToolBatchAllowed([{ name: 'tool_invoke_read', rawArgs: JSON.stringify({ name: 'file_read', arguments: { path: 'a.txt' } }) }], {}, {}) === true,
  'F2 计划阶段:代理到 todo_write / orchestrate_agents 的调用按目标判(被拦),代理到只读工具照放行');

  /* ── (9) 入参描述 ── */
  const full = srv.buildOpenAiTools({ ...cfg, toolLoadingMode: 'full', subagentMaxPerTurn: 4 }, null, { skillsEnabled: true });
  const stew = srv.buildOpenAiTools({ ...cfg, toolLoadingMode: 'full', subagentMaxPerTurn: 4 }, null, { skillsEnabled: true, stewardSession: true });
  const byName = new Map(); for (const x of [...full, ...stew]) byName.set(x.function.name, x.function);
  const WANT = {
    workbench_memory_list: ['scope', 'limit'], workbench_memory_read: ['id'], workbench_memory_propose: ['name', 'type'],
    powershell_run: ['command', 'timeoutMs'], shell_send: ['shellId', 'input'], shell_poll: ['shellId'], script_run: ['language', 'code', 'timeoutMs'],
    file_write: ['createDirs'], file_list: ['root', 'recursive', 'maxFiles', 'maxDepth', 'ignoreDirs', 'includeIgnored', 'absolute', 'ignoreCase'],
    file_search: ['root', 'maxResults', 'maxFiles', 'maxDepth', 'ignoreDirs', 'includeIgnored', 'ignoreCase', 'group'],
    glob: ['root', 'maxResults', 'maxDepth', 'ignoreDirs', 'includeIgnored', 'absolute'], mcp_configure: ['operation'],
    desktop_screenshot: ['outputPath', 'timeoutMs'], keyboard_send_keys: ['keys', 'delayMs', 'timeoutMs'],
    project_snapshot: ['root', 'maxFiles', 'maxDepth', 'ignoreDirs', 'includeIgnored', 'absolute'],
    code_review_scan: ['root', 'maxFiles', 'maxDepth', 'maxFindings', 'ignoreDirs'], frontend_audit: ['root', 'maxFiles', 'maxDepth', 'ignoreDirs'],
    docs_search: ['root', 'maxResults', 'maxFiles', 'maxDepth', 'ignoreDirs', 'includeIgnored'], codebase_symbol_search: ['symbol'],
    http_request: ['url', 'method', 'headers', 'body', 'timeoutMs', 'maxBodyChars'], web_fetch: ['url'], mission_update: ['milestones', 'goal'],
    orchestrate_agents: ['nodes'], steward_schedule_pause: ['basis'], steward_schedule_resume: ['basis'], steward_schedule_run_now: ['basis'], steward_schedule_delete: ['basis'],
  };
  const lacking = [];
  for (const [tool, props] of Object.entries(WANT)) {
    const fn = byName.get(tool);
    if (!fn) { lacking.push(tool + '(工具不在)'); continue; }
    const p = (fn.parameters && fn.parameters.properties) || {};
    for (const k of props) if (!p[k] || !String(p[k].description || '').trim()) lacking.push(`${tool}.${k}`);
  }
  ok(lacking.length === 0, `G1 清单里每个入参都有描述(缺:${lacking.join(', ') || '无'})`);
  const body = byName.get('http_request').parameters.properties.body;
  // body 可以是字符串或对象:不写 type(多类型 type 数组有的服务商 schema 校验不认,会整份工具表 400),
  // 只用描述说明两种形态。
  ok(body.type === undefined && /object as JSON/.test(String(body.description || '')), `G2 http_request.body 不带多类型 type、描述说明两种形态(got ${JSON.stringify(body)})`);
  const tooLong = [];
  for (const [tool, props] of Object.entries(WANT)) for (const k of props) { const d = String(byName.get(tool).parameters.properties[k].description || ''); if (tool !== 'orchestrate_agents' && d.length > 70) tooLong.push(`${tool}.${k}=${d.length}`); }
  ok(tooLong.length === 0, `G3 新补的入参描述保持简短(≤70 字符;超:${tooLong.join(', ') || '无'})`);
  const orchDesc = byName.get('orchestrate_agents').description;
  ok(orchDesc.length < 2000 && /workflowId/.test(orchDesc) && /background:true/.test(orchDesc) && /Sub-agents cannot launch further sub-agents/.test(orchDesc), `G4 orchestrate_agents 描述压到 <2000 字符且关键信息还在(${orchDesc.length})`);

  /* ═════════ Part B:真 provider 回合(serve + 假 provider) ═════════ */
  const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2meta-b-'));
  const NODE_MARK = 'R2META_NODE_TASK';
  // 脚本:每个主回合请求按「已有多少条 tool 结果」决定下一步;子代理节点的请求(消息里带 NODE_MARK)直接答一句话。
  const steps = [
    ['tool_invoke_read', { name: 'todo_write', arguments: { items: [{ content: '查看代码', status: 'in_progress' }, '写测试'] } }],
    ['tool_invoke_edit', { name: 'mission_update', arguments: { milestones: [{ id: 'm1', status: 'done', evidence: '代理路径更新' }] } }],
    ['tool_invoke_read', { name: 'tool_search', arguments: { query: 'read file', limit: 3 } }],
    ['tool_invoke_read', { name: 'wait_agents', arguments: { runIds: ['run_doesnotexist'], timeoutMs: 500 } }],
    ['orchestrate_agents', { task: 'x', nodes: [{ id: 'n1', task: 'y' }] }],
    ['orchestrate_agents', { task: 'x', toolTier: 'superuser' }],
    ['tool_invoke_exec', { name: 'orchestrate_agents', arguments: { task: NODE_MARK + ' say hi', model: 'bogus-model-xyz' } }],
    ['tool_invoke_read', { name: 'agent_result', arguments: { runId: 'run_doesnotexist' } }],
  ];
  fakeProvider = await startFakeProvider({
    handler(req) {
      const raw = JSON.stringify(req.messages || []);
      if (raw.includes(NODE_MARK) && !(req.messages || []).some(m => m.role === 'tool' && /orchestrate/.test(String(m.name || '')))) {
        const toolNames = (req.tools || []).map(x => x.function && x.function.name);
        if (!toolNames.includes('orchestrate_agents')) return [...textFrames('node says hi'), usageFrame({ prompt_tokens: 5, completion_tokens: 3 })];
      }
      const done = (req.messages || []).filter(m => m.role === 'tool').length;
      if (done < steps.length) return toolCallFrames(steps[done][0], steps[done][1], 'call_' + done);
      return [...textFrames('all done'), usageFrame({ prompt_tokens: 8, completion_tokens: 4 })];
    },
  });
  fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify(baseConfig([PROVIDER(fakeProvider.url)], 'fake'), null, 2));
  const wbPort = await getFreePort();
  wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: path.join(ROOT, 'ruyi-workbench'), env: { ...process.env, RUYI_HOME: HOME2, WIN_CLAUDE_WORKBENCH_HOME: HOME2 }, windowsHide: true });
  const httpJson = (method, route, body, headers) => new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: wbPort, path: route, method, timeout: 60000, headers: { ...(headers || {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  let live = null; for (let i = 0; i < 100 && !live; i++) { await sleep(150); live = await httpJson('GET', '/health').catch(() => null); }
  const page = await new Promise(r => http.get({ host: '127.0.0.1', port: wbPort, path: '/' }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => r(b)); }));
  const token = (String(page).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
  const auth = { 'x-wcw-token': token };
  const created = await httpJson('POST', '/api/sessions', { title: 'r2', cwd: WS }, auth);
  const sid = created && created.session && created.session.id;
  ok(!!sid, 'H0 前置:真服务起得来、能建会话');
  const started = await httpJson('POST', '/api/mission', { sessionId: sid, action: 'start', goal: '代理路径验证', milestones: [{ id: 'm1', desc: '第一步' }, { id: 'm2', desc: '第二步' }] }, auth);
  ok(started && started.ok === true, `H0b 前置:建任务账本(got ${JSON.stringify(started).slice(0, 100)})`);
  const events = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ sessionId: sid, message: '请按脚本调用工具', cwd: WS });
    const r = http.request({ host: '127.0.0.1', port: wbPort, path: '/api/chat/stream', method: 'POST', timeout: 180000, headers: { ...auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const evs = [];
      res.on('data', ch => { buf += ch; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { evs.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => resolve(evs));
    });
    r.on('error', reject); r.write(data); r.end();
  });
  const results = new Map();   // tool_use id → { name, input, content }
  for (const e of events) {
    if (e.type === 'tool_use') results.set(e.id, { name: e.name, input: e.input });
    if (e.type === 'tool_result' && results.has(e.id)) results.get(e.id).content = e.content;
  }
  const byStep = i => results.get('call_' + i) || {};
  const asObj = c => (c && typeof c === 'object') ? c : (() => { try { return JSON.parse(c); } catch { return {}; } })();

  const sessAfter = (await httpJson('GET', '/api/sessions/' + sid, null, auth)).session || {};
  const todos = Array.isArray(sessAfter.todos) ? sessAfter.todos : [];
  ok(todos.length === 2 && todos[0].text === '查看代码' && todos[0].status === 'in_progress', `P1 tool_invoke_read{todo_write} 在回合内真落盘到 session.todos(修前 ok:true 却没写;got ${JSON.stringify(todos)})`);
  ok(events.some(e => e.type === 'todo' && Array.isArray(e.items) && e.items.length === 2), 'P1b 代理的 todo_write 同样发出 todo 事件(进度条刷新)');
  ok(byStep(0).name === 'todo_write', `P1c 事件里记的是真正执行的工具名 todo_write(got ${byStep(0).name})`);
  const ms = (sessAfter.mission && sessAfter.mission.milestones) || [];
  ok(ms.some(m => m.id === 'm1' && m.status === 'done'), `P2 tool_invoke_edit{mission_update} 真改了账本(修前「独立调用仅校验」;got ${JSON.stringify(ms.map(m => [m.id, m.status]))})`);
  const sr = asObj(byStep(2).content);
  ok(Array.isArray(sr.matches) && sr.matches.length > 0, `P3 tool_invoke_read{tool_search} 回检索结果(got ${JSON.stringify(sr).slice(0, 100)})`);
  const wr = asObj(byStep(3).content);
  ok(wr.ok === false && /没有找到/.test(String(wr.error || '')) && !/仅在 provider/.test(String(wr.error || '')), `P4 回合内经代理的 wait_agents 走真实现、全不存在 → ok:false(修前「仅在 provider 回合可用」;got ${JSON.stringify(wr).slice(0, 160)})`);
  const o1 = asObj(byStep(4).content);
  ok(o1.ok === false && /互斥/.test(String(o1.error || '')), `P5 orchestrate_agents task+nodes 同给 → 拒(修前 task 被悄悄忽略;got ${JSON.stringify(o1).slice(0, 160)})`);
  const o2 = asObj(byStep(5).content);
  ok(o2.ok === false && /toolTier/.test(String(o2.error || '')) && /read \/ edit \/ exec/.test(String(o2.error || '')), `P6 toolTier:'superuser' → 拒并列允许值(修前静默按 read 档跑;got ${JSON.stringify(o2).slice(0, 160)})`);
  const o3 = asObj(byStep(6).content);
  ok(o3.ok !== false && Array.isArray(o3.notes) && o3.notes.some(n => /bogus-model-xyz/.test(n)), `P7 经代理的 orchestrate_agents 真启动,且模型清单外的 model 只给 notes 提示、不拒(修前「需要在 OpenAI 对话回合中调用」;got ${JSON.stringify(o3).slice(0, 220)})`);
  const ar = asObj(byStep(7).content);
  ok(ar.ok === false && !/仅在 provider/.test(String(ar.error || '')), `P8 回合内经代理的 agent_result 走真实现(got ${JSON.stringify(ar).slice(0, 160)})`);
  ok(events.some(e => e.type === 'assistant_delta' && /all done/.test(e.text || '')) || events.some(e => e.type === 'done' || e.type === 'result'), 'P9 回合正常收尾(配对没乱)');
} catch (e) {
  t.fail('fatal: ' + ((e && e.stack) || e));
} finally {
  try { if (wb) killOwnTree(wb); } catch { try { wb.kill('SIGKILL'); } catch { /* gone */ } }
  try { if (fakeProvider) await fakeProvider.close(); } catch { /* ignore */ }
}
t.done({ exit: true });
})();
