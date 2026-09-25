require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——本件还另起一份自己的临时家，服务的导入/同步两个方向都只碰它（见 lib 头注）
'use strict';
// E2E(W2 迁移中心,56 号文 §3):从 Claude Code / Codex / Kimi 与老版本如意迁移到当前包。
//
// 隔离:本件自建临时根 ROOT,工作台的 HOME/USERPROFILE 与数据根都指进去(测试绝不碰真机家目录 ——
// 真机 ~/.claude.json 被夹具污染过三次);回收站动作经测试钩子 RUYI_MIGRATION_RECYCLE_STUB_DIR 换成「挪进一个临时目录」。
//
// 造的现场(隔离家里):
//   ~/.claude/CLAUDE.md · ~/.codex/AGENTS.md · ~/.codex/config.toml(含 mcp)· ~/.codex/skills/x-codex-skill/SKILL.md
//   ~/.kimi-code/mcp.json(一条 Kimi 自己的 + 一条如意同步过去的)· 假老包 OLD1(app/server.js 等)
//   ~/.claude.json 引用 OLD1(一条能改到新版的、一条新包里没有对应文件的)· 登记表里一个「正在运行」的老包 OLD0
// 判据(派单验收):
//   A  启动即导入:指令文件成核心记忆(core:true / convention / 前言记来源与哈希);MCP 三源导入且打来源标记,
//      如意自己的入口与 Kimi 里如意同步过去的条目不导;技能来源出现 codex
//   B  scan 全部列出(指令/ MCP / 技能 / 老包引用 / 老包),首启提示 show
//   C  去重:provider 引擎的系统提示里有 claude-md 那条;Claude 引擎回合的 stdin 注入里没有它(codex 那条两边都有)
//   D  来源变更自动同步;用户改过的不覆盖,只标 source-updated;移除后记 dismissed 不再自动导回
//   E  apply 改写且留备份、写迁移日志;undo 还原
//   F  recycle:确认不符 400、当前包 409、正在运行 409、仍被引用 409;改完后钩子下真的挪走
//   G  markSeen 后不再提示;token 门
//   H  (W8)技能「复制到如意」:按来源逐目录列出(含被遮住的)与五种状态;整目录复制 + 来源记录;符号链接/联接不复制;
//      注册表里变 user 且带 copiedFrom;来源变 → 可更新;副本改过 → 不带 overwrite 拒绝;同名用户技能/另一来源副本 → 拒绝;
//      超 20 MB / 500 个文件拒绝;路径穿越 key 拒绝;撤销只删没改过的副本、撤销更新换回旧副本
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const CURRENT_ROOT = WB; // 源码树里跑时,当前包根 = ruyi-workbench/(externalRoot)
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-migration-e2e-'));
const HOME = path.join(ROOT, 'home');
const DATA = path.join(ROOT, 'data');
const WORK = path.join(ROOT, 'work');
const STUB = path.join(ROOT, 'recycle-stub');
const STDIN_CAP = path.join(ROOT, 'claude-stdin.txt');
const OLD1 = path.join(ROOT, 'old', 'Ruyi-v1.0.0-full');
const OLD0 = path.join(ROOT, 'old', 'Ruyi-v0.9.0-full');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

function makePackage(root, version) {
  write(path.join(root, 'app', 'server.js'), '// fake old ruyi package\n');
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'ruyi-workbench', version }));
  write(path.join(root, 'Start-Workbench.cmd'), '@echo off\r\n');
  write(path.join(root, 'mcp', 'ai-computer-control', 'python_embed', 'python.exe'), '');
}

// ---- fixtures -------------------------------------------------------------------------------------------
write(path.join(HOME, '.claude', 'CLAUDE.md'), '# 我的规矩\n\n- CLAUDE_MD_MARKER 回答一律用中文\n- 改代码前先读相关文件\n');
write(path.join(HOME, '.codex', 'AGENTS.md'), '# Codex 规则\n\nCODEX_AGENTS_MARKER 先写测试再改代码\n');
write(path.join(HOME, '.gemini', 'GEMINI.md'), '# Gemini\n\nGEMINI_MD_MARKER\n');
write(path.join(HOME, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.codex-fs]\ncommand = "node"\nargs = ["codex-fs.js"]\n');
write(path.join(HOME, '.codex', 'skills', 'x-codex-skill', 'SKILL.md'), '---\nname: X Codex Skill\ndescription: CODEX_SKILL_MARKER 来自 Codex 的技能\n---\n\n# body\n');
write(path.join(HOME, '.kimi-code', 'mcp.json'), JSON.stringify({ mcpServers: {
  'kimi-tool': { command: 'node', args: ['kimi-tool.js'] },
  'ruyi-managed': { command: 'node', args: ['managed.js'] },
} }, null, 2));
makePackage(OLD1, '1.0.0');
makePackage(OLD0, '0.9.0');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CLAUDE_JSON_ORIGINAL = { numStartups: 3, mcpServers: {
  'claude-tool': { type: 'stdio', command: 'node', args: ['claude-tool.js'], env: {} },
  'old-bridge': { type: 'stdio', command: 'node', args: [path.join(OLD1, 'app', 'server.js'), 'mcp'], env: {} },
  'ai-computer-control': { type: 'stdio', command: path.join(OLD1, 'mcp', 'ai-computer-control', 'python_embed', 'python.exe'), args: ['-m', 'ai_computer_control.server'], env: {} },
} };
write(CLAUDE_JSON, JSON.stringify(CLAUDE_JSON_ORIGINAL, null, 2));
write(path.join(DATA, 'kimi-mcp-sync.json'), JSON.stringify({ managedIds: ['ruyi-managed'], previous: {} }));
write(path.join(DATA, 'install-registry.json'), JSON.stringify({ schema: 1, packages: [
  { packageRoot: OLD0, version: '0.9.0', launchMode: 'node', firstSeenAt: new Date().toISOString(), lastLaunchedAt: new Date().toISOString(), pid: process.pid },
] }));
fs.mkdirSync(WORK, { recursive: true });

// ---- fake provider(进程内):记下每一发的请求体 -------------------------------------------------------
const providerBodies = [];
function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fake-model"}]}'); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { providerBodies.push(JSON.parse(raw || '{}')); } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = v => res.write('data: ' + JSON.stringify(v) + '\n\n');
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '好。' }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } });
    res.end('data: [DONE]\n\n');
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ---- http helpers ---------------------------------------------------------------------------------------
let PORT = 0, TOKEN = '';
function request(method, pathname, body, token = TOKEN) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, timeout: 60000, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ndjson/non-json */ } resolve({ status: res.statusCode, json: j, text: b }); }); });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    if (raw) r.write(raw);
    r.end();
  });
}
const scan = async () => { const r = await request('GET', '/api/migration/scan'); return r && r.json; };
const apply = async body => request('POST', '/api/migration/apply', body);

(async () => {
  PORT = await getFreePort();
  const providerPort = await getFreePort();
  const provider = await startProvider(providerPort);
  write(path.join(DATA, 'config.json'), JSON.stringify({
    configSchema: 13, permissionMode: 'bypass', engineMode: 'print', defaultWorkspace: WORK, includeWorkbenchMcp: false,
    // 桌面 MCP 关掉:否则启动后的 syncMcpServersToClaude 可能用本机真的 claude CLI 往(隔离家里的)~/.claude.json
    // 写一条 ai-computer-control,把「改之前的备份 == 原文件」这类断言变成与本机装没装 claude 有关的抖动。
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    activeProvider: 'fake', locale: 'zh-CN',
    onboarding: { completedAt: '2026-09-13T00:00:00.000Z', version: 1, skipped: false },
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + providerPort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }, null, 2));
  const env = { ...process.env, RUYI_HOME: DATA, WIN_CLAUDE_WORKBENCH_HOME: DATA, HOME, USERPROFILE: HOME,
    WCW_DATA_DIR: path.join(ROOT, 'acc-data'), RUYI_MIGRATION_RECYCLE_STUB_DIR: STUB,
    WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_STDIN_CAPTURE: STDIN_CAP };
  delete env.CODEX_HOME; delete env.KIMI_CODE_HOME; // 各家覆盖变量一律不带进去 —— 只认隔离家
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { const r = await request('GET', '/health', null, ''); up = Boolean(r && r.status === 200); if (!up) await sleep(100); }
    ok(up, 'S0 工作台起来了');
    for (let i = 0; i < 300 && !TOKEN; i++) { TOKEN = (readJson(path.join(DATA, 'runtime.json')) || {}).token || ''; if (!TOKEN) await sleep(100); }
    ok(Boolean(TOKEN), 'S0 runtime token 可读');

    // ── G2 token 门 ──
    const noTok = await request('GET', '/api/migration/scan', null, '');
    ok(noTok && noTok.status === 403, 'G2 不带 token 的 scan 被 403(token 级路由)');

    // ── A 启动即导入 ──
    const memDir = path.join(DATA, 'memory', 'global');
    const claudeMem = readText(path.join(memDir, 'agentmd-claude-md-1.md'));
    ok(/CLAUDE_MD_MARKER/.test(claudeMem) && /^core: true$/m.test(claudeMem) && /^type: convention$/m.test(claudeMem),
      'A1 ~/.claude/CLAUDE.md 启动即导成全局核心记忆(core:true / convention)');
    ok(/^importSource: claude-md$/m.test(claudeMem) && /^importSourceHash: [0-9a-f]{32}$/m.test(claudeMem) && /^importedAt: \d{4}-/m.test(claudeMem)
      && /^importSourcePath: .*CLAUDE\.md$/m.test(claudeMem), 'A2 前言记 importSource / importSourcePath / importSourceHash / importedAt');
    ok(/CODEX_AGENTS_MARKER/.test(readText(path.join(memDir, 'agentmd-codex-agents-1.md'))), 'A3 ~/.codex/AGENTS.md 同样导入');
    const cfg1 = readJson(path.join(DATA, 'config.json')) || {};
    const ext = id => (cfg1.externalMcpServers || []).find(s => s && s.id === id);
    ok(ext('claude-tool') && ext('claude-tool').origin === 'claude-code', 'A4 Claude Code 的 MCP 自动导入,origin=claude-code');
    ok(ext('codex-fs') && ext('codex-fs').origin === 'codex' && ext('codex-fs').command === 'node', 'A5 Codex config.toml 的 MCP 自动导入,origin=codex');
    ok(ext('kimi-tool') && ext('kimi-tool').origin === 'kimi', 'A6 Kimi mcp.json 的 MCP 自动导入,origin=kimi');
    ok(!ext('ruyi-managed'), 'A7 Kimi 里如意自己同步过去的条目(kimi-mcp-sync.json 记着)不导回来');
    ok(!ext('old-bridge') && !ext('ai-computer-control'), 'A8 指向如意包 app/server.js 的入口与保留 id 不导(不让如意连自己)');
    const skills = await request('GET', '/api/skills');
    const codexSkill = skills && skills.json && (skills.json.skills || []).find(s => s.id === 'x-codex-skill');
    ok(codexSkill && codexSkill.source === 'codex', 'A9 技能库出现 ~/.codex/skills 的技能,来源 codex');

    // ── B scan 全部列出 ──
    const s1 = await scan();
    ok(s1 && s1.ok, 'B0 scan ok');
    const instr = key => (s1.instructions || []).find(x => x.key === key) || {};
    ok(instr('claude-md').status === 'imported' && instr('codex-agents').status === 'imported' && instr('kimi-agents').status === 'absent',
      'B1 指令文件逐项状态(claude-md/codex-agents 已导入,kimi 无此文件)');
    ok(instr('gemini-md').status === 'importable' && !fs.existsSync(path.join(memDir, 'agentmd-gemini-md-1.md')), 'B1b Gemini(非点名三家)只列为可导入,启动期不自动导');
    const mcpRow = (origin, id) => (s1.mcp.servers || []).find(x => x.origin === origin && x.id === id) || {};
    ok(mcpRow('codex', 'codex-fs').status === 'imported' && mcpRow('kimi', 'ruyi-managed').reason === 'ruyi-managed'
      && mcpRow('claude-code', 'old-bridge').reason === 'ruyi-self', 'B2 MCP 逐项状态与跳过原因');
    ok((s1.skills || []).some(x => x.id === 'x-codex-skill' && x.source === 'codex'), 'B3 技能来源 codex 列出');
    const refBridge = (s1.refs || []).find(r => r.serverId === 'old-bridge');
    const refAcc = (s1.refs || []).find(r => r.serverId === 'ai-computer-control');
    ok(refBridge && refBridge.action === 'rewrite' && refBridge.changes.some(c => c.field === 'args.0' && c.to === path.join(CURRENT_ROOT, 'app', 'server.js')),
      'B4 指向老包 app/server.js 的引用 → 提议改到当前包同相对路径');
    ok(refAcc && refAcc.action === 'remove', 'B5 旧名条目 ai-computer-control 在新包里没有对应文件 → 提议移除');
    const pkg = root => (s1.packages || []).find(p => p.root.toLowerCase() === root.toLowerCase());
    ok(pkg(OLD1) && pkg(OLD1).version === '1.0.0' && pkg(OLD1).refCount === 2 && typeof pkg(OLD1).sizeBytes === 'number', 'B6 老包 OLD1(由引用认出)列出:版本/引用数/大小');
    ok(pkg(OLD0) && pkg(OLD0).running === true && pkg(OLD0).discoveredBy.includes('registry'), 'B7 登记表里的老包 OLD0 列出且判为正在运行');
    ok(!(s1.packages || []).some(p => p.root.toLowerCase() === CURRENT_ROOT.toLowerCase()), 'B8 当前包不在老包清单里');
    ok(s1.prompt && s1.prompt.show === true, 'B9 首启提示 show=true');
    const reg = readJson(path.join(DATA, 'install-registry.json')) || {};
    ok((reg.packages || []).some(r => r.packageRoot.toLowerCase() === CURRENT_ROOT.toLowerCase() && r.pid > 0 && r.lastLaunchedAt), 'B10 本包启动时登记进 install-registry.json');

    // ── C 注入去重 ──
    const sess = (await request('POST', '/api/sessions', { cwd: WORK })).json.session;
    await request('POST', '/api/chat/stream', { sessionId: sess.id, message: 'hello provider', cwd: WORK });
    // 核心胶囊走易变层(可能在 system 之外的消息里):把这一发所有消息的文本拼起来看。
    const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('\n') : '');
    const sys = (() => { const b = providerBodies.filter(x => Array.isArray(x.messages)).pop() || {}; return (b.messages || []).map(m => textOf(m && m.content)).join('\n'); })();
    ok(/agentmd-claude-md-1/.test(sys) && /CLAUDE_MD_MARKER/.test(sys) && /agentmd-codex-agents-1/.test(sys), 'C1 provider 引擎的核心记忆里有 claude-md 与 codex 两条');
    const sessC = (await request('POST', '/api/sessions', { cwd: WORK })).json.session;
    await request('PATCH', '/api/sessions/' + encodeURIComponent(sessC.id), { engineRoute: { engine: 'agent', agentCliType: 'claude', model: '' } });
    try { fs.rmSync(STDIN_CAP, { force: true }); } catch { /* ignore */ }
    await request('POST', '/api/chat/stream', { sessionId: sessC.id, message: 'hello claude', cwd: WORK });
    for (let i = 0; i < 30 && !fs.existsSync(STDIN_CAP); i++) await sleep(100);
    let stdinTxt = readText(STDIN_CAP);
    try { const j = JSON.parse(stdinTxt.trim()); const c = j && j.message && j.message.content; if (Array.isArray(c) && c[0] && c[0].type === 'text') stdinTxt = String(c[0].text || ''); } catch { /* print 模式裸文本 */ }
    ok(/<workbench-memory-core>/.test(stdinTxt) && /agentmd-codex-agents-1/.test(stdinTxt), 'C2 Claude 引擎回合注入里有核心记忆(codex 那条在)');
    ok(!/agentmd-claude-md-/.test(stdinTxt) && !/CLAUDE_MD_MARKER/.test(stdinTxt), 'C3 Claude 引擎回合注入里没有 claude-md 那条(CLI 原生会读 ~/.claude/CLAUDE.md)');

    // ── D 同步 / 不覆盖 / 移除 ──
    write(path.join(HOME, '.codex', 'AGENTS.md'), '# Codex 规则\n\nCODEX_AGENTS_V2 源文件改过了\n');
    const s2 = await scan();
    const codexMem2 = readText(path.join(memDir, 'agentmd-codex-agents-1.md'));
    ok(/CODEX_AGENTS_V2/.test(codexMem2) && !/CODEX_AGENTS_MARKER/.test(codexMem2) && (s2.instructions.find(x => x.key === 'codex-agents') || {}).status === 'imported',
      'D1 来源变了、导入条目没被改过 → 自动重导');
    fs.appendFileSync(path.join(memDir, 'agentmd-codex-agents-1.md'), '\nUSER_EDIT_MARKER 我自己加的一句\n', 'utf8');
    write(path.join(HOME, '.codex', 'AGENTS.md'), '# Codex 规则\n\nCODEX_AGENTS_V3 又改了\n');
    const s3 = await scan();
    const codexMem3 = readText(path.join(memDir, 'agentmd-codex-agents-1.md'));
    const codexRow3 = s3.instructions.find(x => x.key === 'codex-agents') || {};
    ok(/USER_EDIT_MARKER/.test(codexMem3) && !/CODEX_AGENTS_V3/.test(codexMem3) && codexRow3.status === 'source-updated' && codexRow3.userModified === true,
      'D2 用户改过导入条目 → 来源再变也不覆盖,只标「来源已更新」');
    const forced = await apply({ importInstructions: ['codex-agents'] });
    ok(forced && forced.json && forced.json.ok && /CODEX_AGENTS_V3/.test(readText(path.join(memDir, 'agentmd-codex-agents-1.md'))), 'D3 显式「导入」用来源覆盖');
    const dis = await apply({ dismissInstructions: ['claude-md'] });
    ok(dis && dis.json && dis.json.ok && !fs.existsSync(path.join(memDir, 'agentmd-claude-md-1.md')), 'D4 移除 → 导入条目删掉');
    const s4 = await scan();
    ok((s4.instructions.find(x => x.key === 'claude-md') || {}).status === 'dismissed' && !fs.existsSync(path.join(memDir, 'agentmd-claude-md-1.md')),
      'D5 记 dismissed,再扫描(自动同步)也不导回来');
    const gem = await apply({ importInstructions: ['gemini-md'] });
    ok(gem && gem.json && gem.json.ok && /GEMINI_MD_MARKER/.test(readText(path.join(memDir, 'agentmd-gemini-md-1.md'))), 'D6 Gemini 经迁移中心显式导入才进核心记忆');

    // ── E apply 改写 + 备份 + 日志;undo 还原 ──
    const ids = [refBridge.id, refAcc.id];
    const ap = await apply({ rewriteRefs: ids });
    const cj = readJson(CLAUDE_JSON) || {};
    ok(ap && ap.json && ap.json.ok && ap.json.refs && ap.json.refs.items === 2, 'E1 apply 两项都落了');
    ok(cj.mcpServers && cj.mcpServers['old-bridge'] && cj.mcpServers['old-bridge'].args[0] === path.join(CURRENT_ROOT, 'app', 'server.js') && !cj.mcpServers['ai-computer-control'],
      'E2 ~/.claude.json:old-bridge 改到当前包,ai-computer-control 移除');
    ok(cj.numStartups === 3 && cj.mcpServers['claude-tool'], 'E3 其它键原样保留');
    const backups = fs.readdirSync(HOME).filter(f => f.startsWith('.claude.json.bak-ruyi-migrate-'));
    ok(backups.length === 1 && JSON.stringify(readJson(path.join(HOME, backups[0]))) === JSON.stringify(CLAUDE_JSON_ORIGINAL), 'E4 改之前留了备份 <file>.bak-ruyi-migrate-<ts>,内容是原文件');
    const logs = fs.readdirSync(path.join(DATA, 'migrations')).filter(f => f.endsWith('.json'));
    ok(logs.length === 1, 'E5 迁移日志写进 <data>/migrations/<ts>.json');
    const s5 = await scan();
    ok(!(s5.refs || []).some(r => r.serverId === 'old-bridge' || r.serverId === 'ai-computer-control') && s5.lastMigration && s5.lastMigration.id, 'E6 改完再扫:引用清零,可撤销的迁移记录在');
    const un = await request('POST', '/api/migration/undo', {});
    ok(un && un.json && un.json.ok && un.json.restored >= 2, 'E7 undo ok');
    ok(JSON.stringify(readJson(CLAUDE_JSON)) === JSON.stringify(CLAUDE_JSON_ORIGINAL), 'E8 undo 后 ~/.claude.json 还原成原样');
    const un2 = await request('POST', '/api/migration/undo', {});
    ok(un2 && un2.status === 404, 'E9 没有可撤销的了 → 404');

    // ── F 回收站 ──
    const rc0 = await request('POST', '/api/migration/recycle', { root: OLD1, confirm: 'nope' });
    ok(rc0 && rc0.status === 400 && rc0.json.error.code === 'migration.confirm_mismatch', 'F1 确认不符 → 400');
    const rcCur = await request('POST', '/api/migration/recycle', { root: CURRENT_ROOT, confirm: CURRENT_ROOT });
    ok(rcCur && rcCur.status === 409 && rcCur.json.error.code === 'migration.current_package', 'F2 拒绝当前包');
    const rcRun = await request('POST', '/api/migration/recycle', { root: OLD0, confirm: OLD0 });
    ok(rcRun && rcRun.status === 409 && rcRun.json.error.code === 'migration.running' && fs.existsSync(OLD0), 'F3 拒绝正在运行的包');
    const rcRef = await request('POST', '/api/migration/recycle', { root: OLD1, confirm: OLD1 });
    ok(rcRef && rcRef.status === 409 && rcRef.json.error.code === 'migration.referenced' && Array.isArray(rcRef.json.refs) && rcRef.json.refs.length === 2 && fs.existsSync(OLD1), 'F4 拒绝仍被引用的包');
    const s6 = await scan();
    const ap2 = await apply({ rewriteRefs: (s6.refs || []).filter(r => r.action !== 'manual').map(r => r.id) });
    ok(ap2 && ap2.json && ap2.json.ok, 'F5 再次改到新版');
    const rcOk = await request('POST', '/api/migration/recycle', { root: OLD1, confirm: OLD1 });
    ok(rcOk && rcOk.json && rcOk.json.ok === true && rcOk.json.via === 'test-stub' && !fs.existsSync(OLD1)
      && fs.readdirSync(STUB).some(f => f.startsWith('Ruyi-v1.0.0-full')), 'F6 无引用后移进回收站(测试钩子下挪进 stub 目录)'
      + (rcOk && rcOk.json && rcOk.json.ok ? '' : ' → ' + (rcOk ? JSON.stringify(rcOk.json).slice(0, 400) : 'no response')));

    // ── G 看过了 ──
    const seen = await apply({ markSeen: true });
    ok(seen && seen.json && seen.json.ok && seen.json.seen > 0, 'G1 markSeen ok');
    const s7 = await scan();
    ok(s7.prompt && s7.prompt.show === false, 'G1b 看过之后不再提示');
    write(path.join(HOME, '.kimi-code', 'AGENTS.md'), '# Kimi\n\nKIMI_AGENTS_MARKER\n');
    const s8 = await scan();
    ok(s8.prompt && s8.prompt.show === true && (s8.instructions.find(x => x.key === 'kimi-agents') || {}).status === 'imported', 'G3 出现新来源(Kimi 全局 AGENTS.md)→ 自动导入且再提示一次');

    // ── H 技能「复制到如意」(W8)──
    const CC = path.join(HOME, '.claude', 'skills');
    const CX = path.join(HOME, '.codex', 'skills');
    const KM = path.join(HOME, '.kimi-code', 'skills');
    const USK = path.join(DATA, 'skills');
    const OUTSIDE = path.join(ROOT, 'outside');
    write(path.join(OUTSIDE, 'secret.txt'), 'OUTSIDE_SECRET_MARKER\n');
    write(path.join(CC, 'w8-a', 'SKILL.md'), '---\nname: W8 A\ndescription: W8_A_MARKER\n---\n\n# a\n');
    write(path.join(CC, 'w8-a', 'ref', 'notes.md'), 'NOTES_V1\n');
    fs.symlinkSync(OUTSIDE, path.join(CC, 'w8-a', 'ext-link'), 'junction'); // 目录联接:Windows 无需特权
    let fileLink = false;
    try { fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(CC, 'w8-a', 'link.txt'), 'file'); fileLink = true; } catch { /* 无符号链接特权:只测联接 */ }
    write(path.join(CX, 'w8-a', 'SKILL.md'), '---\nname: W8 A (codex)\ndescription: codex 同名\n---\n');
    write(path.join(CX, 'w8-b', 'SKILL.md'), '---\nname: W8 B\ndescription: W8_B_MARKER\n---\n');
    write(path.join(CX, 'w8-b', 'scripts', 'run.py'), 'print(1)\n');
    write(path.join(CX, 'w8-b', 'scripts', 'deep', 'x.txt'), 'DEEP\n');
    write(path.join(CC, 'w8-big', 'SKILL.md'), '# big\n');
    fs.writeFileSync(path.join(CC, 'w8-big', 'blob.bin'), Buffer.alloc(21 * 1024 * 1024));
    write(path.join(CC, 'w8-many', 'SKILL.md'), '# many\n');
    for (let i = 0; i < 501; i++) write(path.join(CC, 'w8-many', 'f', i + '.txt'), String(i));
    write(path.join(CC, 'w8-mine', 'SKILL.md'), '# 来源里的 mine\n');
    write(path.join(USK, 'w8-mine', 'SKILL.md'), '# USER_OWN_MINE\n');
    const copySkills = body => request('POST', '/api/migration/skills/copy', body);
    const skillRows = async () => ((await scan()) || {}).skills || [];
    const rowOf = (rows, key) => rows.find(x => x.key === key) || {};
    const resOf = (r, key) => ((r && r.json && r.json.results) || []).find(x => x.key === key) || {};

    const h1 = await skillRows();
    ok(rowOf(h1, 'claude-code:w8-a').status === 'live' && rowOf(h1, 'codex:w8-b').status === 'live'
      && rowOf(h1, 'codex:w8-a').status === 'live' && rowOf(h1, 'codex:w8-a').shadowedBy === 'claude-code',
      'H1 按来源逐个目录列出(被同名遮住的 codex:w8-a 也列,且标明被 claude-code 那份遮住)');
    ok(rowOf(h1, 'claude-code:w8-big').status === 'too-large' && rowOf(h1, 'claude-code:w8-many').status === 'too-large',
      'H1b 超 20 MB / 超 500 个文件的技能判 too-large');
    ok(rowOf(h1, 'claude-code:w8-mine').status === 'conflict' && rowOf(h1, 'claude-code:w8-mine').conflictWith === 'user',
      'H1c dataRoot/skills 里已有用户自己的同名技能 → conflict');
    ok(rowOf(h1, 'claude-code:w8-a').links >= (fileLink ? 2 : 1), 'H1d 行上报出会被跳过的符号链接/联接个数');

    const c1 = await copySkills({ keys: ['claude-code:w8-a', 'codex:w8-b'] });
    ok(c1 && c1.status === 200 && c1.json.ok && c1.json.copied === 2 && resOf(c1, 'claude-code:w8-a').outcome === 'created' && c1.json.id,
      'H2 复制两项:都 created,写了迁移日志 id');
    const recA = readJson(path.join(USK, 'w8-a', '.ruyi-import.json')) || {};
    ok(readText(path.join(USK, 'w8-a', 'ref', 'notes.md')) === 'NOTES_V1\n' && fs.existsSync(path.join(USK, 'w8-b', 'scripts', 'deep', 'x.txt')),
      'H2b 整目录连子目录资源一起复制');
    ok(recA.schema === 1 && recA.source === 'claude-code' && path.resolve(recA.sourcePath) === path.resolve(CC, 'w8-a') && recA.plugin === ''
      && /^\d{4}-/.test(recA.importedAt) && /^[0-9a-f]{64}$/.test(recA.sourceTreeHash) && recA.copyTreeHash === recA.sourceTreeHash,
      'H2c 来源记录 .ruyi-import.json(schema/source/sourcePath/plugin/importedAt/两枚树哈希)');
    ok(!fs.existsSync(path.join(USK, 'w8-a', 'ext-link')) && !fs.existsSync(path.join(USK, 'w8-a', 'link.txt'))
      && !fs.readdirSync(path.join(USK, 'w8-a')).some(n => n.includes('secret')), 'H3 符号链接/联接没被复制,也没被跟随进去');
    const sk = await request('GET', '/api/skills');
    const skA = ((sk && sk.json && sk.json.skills) || []).find(s => s.id === 'w8-a' && s.kind === 'skill');
    ok(skA && skA.source === 'user' && skA.copiedFrom === 'claude-code' && path.resolve(skA.dir) === path.resolve(USK, 'w8-a'),
      'H4 注册表里 w8-a 来源变为 user,带 copiedFrom=claude-code');
    const h5 = await skillRows();
    ok(rowOf(h5, 'claude-code:w8-a').status === 'copied' && rowOf(h5, 'codex:w8-b').status === 'copied',
      'H5 复制后外部行仍在列表里,状态 copied');
    ok(rowOf(h5, 'codex:w8-a').status === 'conflict' && rowOf(h5, 'codex:w8-a').conflictWith === 'claude-code',
      'H5b 同名另一来源(codex:w8-a)→ conflict(如意里那份是从 claude-code 复制的)');
    const c2 = await copySkills({ keys: ['claude-code:w8-a', 'codex:w8-a'] });
    ok(c2 && c2.json.copied === 0 && resOf(c2, 'claude-code:w8-a').reason === 'already-copied' && resOf(c2, 'codex:w8-a').reason === 'conflict'
      && !c2.json.id && readJson(path.join(USK, 'w8-a', '.ruyi-import.json')).source === 'claude-code',
      'H6 已复制的跳过;另一来源的同名被拒,不覆盖、不写日志');

    write(path.join(CC, 'w8-a', 'ref', 'notes.md'), 'NOTES_V2\n');
    ok(rowOf(await skillRows(), 'claude-code:w8-a').status === 'source-updated', 'H7 来源变了、副本没动 → source-updated');
    const c3 = await copySkills({ keys: ['claude-code:w8-a'] });
    ok(c3 && resOf(c3, 'claude-code:w8-a').outcome === 'updated' && readText(path.join(USK, 'w8-a', 'ref', 'notes.md')) === 'NOTES_V2\n'
      && rowOf(await skillRows(), 'claude-code:w8-a').status === 'copied', 'H7b 一键更新成功,之后又是 copied');
    const updateLogId = c3.json.id;

    fs.appendFileSync(path.join(USK, 'w8-b', 'SKILL.md'), '\nUSER_EDIT_B\n', 'utf8');
    ok(rowOf(await skillRows(), 'codex:w8-b').status === 'copy-edited', 'H8 副本被改过 → copy-edited');
    const c4 = await copySkills({ keys: ['codex:w8-b'] });
    ok(c4 && resOf(c4, 'codex:w8-b').reason === 'copy-edited' && /USER_EDIT_B/.test(readText(path.join(USK, 'w8-b', 'SKILL.md'))),
      'H8b 不带 overwrite 拒绝,改动保留');

    const c5 = await copySkills({ keys: ['claude-code:w8-mine'] });
    ok(c5 && resOf(c5, 'claude-code:w8-mine').reason === 'conflict' && readText(path.join(USK, 'w8-mine', 'SKILL.md')) === '# USER_OWN_MINE\n'
      && !fs.existsSync(path.join(USK, 'w8-mine', '.ruyi-import.json')), 'H9 用户自己的同名技能 → conflict 拒绝,原样不动');
    const c6 = await copySkills({ keys: ['claude-code:w8-big', 'claude-code:w8-many'] });
    ok(c6 && resOf(c6, 'claude-code:w8-big').reason === 'too-large' && resOf(c6, 'claude-code:w8-many').reason === 'too-large'
      && !fs.existsSync(path.join(USK, 'w8-big')) && !fs.existsSync(path.join(USK, 'w8-many')), 'H10 超限拒绝,不落任何文件');
    const evil = ['claude-code:..', 'claude-code:../../evil', 'claude-code:w8-a/../../../evil', 'codex:..\\..\\evil'];
    const c7 = await copySkills({ keys: evil });
    ok(c7 && evil.every(k => resOf(c7, k).reason === 'invalid-key') && c7.json.copied === 0 && !fs.existsSync(path.join(ROOT, 'evil')) && !fs.existsSync(path.join(DATA, 'evil')),
      'H11 路径穿越 id 一律 invalid-key,什么都不写');
    const c8 = await copySkills({ keys: [] });
    ok(c8 && c8.status === 400 && c8.json.error.code === 'migration.keys_required', 'H11b 空 keys → 400');
    const noTokCopy = await request('POST', '/api/migration/skills/copy', { keys: ['codex:w8-b'] }, '');
    ok(noTokCopy && noTokCopy.status === 403, 'H11c 不带 token 的 copy 被 403');

    // 撤销:同一次复制里,没改过的删掉、改过的保留并说明
    write(path.join(KM, 'w8-c', 'SKILL.md'), '# c\n');
    write(path.join(KM, 'w8-d', 'SKILL.md'), '# d\n');
    const c9 = await copySkills({ keys: ['kimi:w8-c', 'kimi:w8-d'] });
    ok(c9 && c9.json.copied === 2, 'H12 kimi 两项复制');
    fs.appendFileSync(path.join(USK, 'w8-d', 'SKILL.md'), 'USER_EDIT_D\n', 'utf8');
    const u1 = await request('POST', '/api/migration/undo', { id: c9.json.id });
    const sk1 = (u1 && u1.json && u1.json.skills) || [];
    ok(u1 && u1.json.ok && !fs.existsSync(path.join(USK, 'w8-c')) && /USER_EDIT_D/.test(readText(path.join(USK, 'w8-d', 'SKILL.md')))
      && (sk1.find(x => x.id === 'w8-c') || {}).outcome === 'removed' && (sk1.find(x => x.id === 'w8-d') || {}).reason === 'edited',
      'H12b 撤销只删没改过的副本(w8-c),改过的(w8-d)保留并说明 edited');
    const sk2 = await request('GET', '/api/skills');
    ok(((sk2 && sk2.json && sk2.json.skills) || []).some(s => s.id === 'w8-c' && s.source === 'kimi'), 'H12c 撤销后 w8-c 回到活读(来源 kimi)');
    // 撤销「更新」:换回更新前的副本
    const u2 = await request('POST', '/api/migration/undo', { id: updateLogId });
    ok(u2 && u2.json.ok && ((u2.json.skills || [])[0] || {}).outcome === 'restored-previous' && readText(path.join(USK, 'w8-a', 'ref', 'notes.md')) === 'NOTES_V1\n'
      && rowOf(await skillRows(), 'claude-code:w8-a').status === 'source-updated', 'H13 撤销一次更新 → 换回更新前的副本,状态回到 source-updated');
    // 显式 overwrite 覆盖改过的副本(旧副本留底在迁移目录)
    const c10 = await copySkills({ keys: ['codex:w8-b'], overwrite: true });
    const skillBackups = (() => { try { return fs.readdirSync(path.join(DATA, 'migrations', 'skill-backups', c10.json.id)); } catch { return []; } })();
    ok(c10 && resOf(c10, 'codex:w8-b').outcome === 'updated' && !/USER_EDIT_B/.test(readText(path.join(USK, 'w8-b', 'SKILL.md'))) && skillBackups.includes('w8-b'),
      'H14 overwrite:true 才覆盖改过的副本,旧副本挪进 migrations/skill-backups/<id>/ 留底');
    ok(!fs.readdirSync(USK).some(n => n.startsWith('.ruyi-copy-')), 'H15 技能目录里不留暂存目录');
    // Claude Code 插件自带的技能:key 带插件名,来源记录记下 plugin
    const PLUG = path.join(ROOT, 'plugins', 'p1');
    write(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'p1@mk': [{ scope: 'user', installPath: PLUG }] } }));
    write(path.join(PLUG, 'skills', 'w8-p', 'SKILL.md'), '# plugin skill\n');
    const c11 = await copySkills({ keys: ['claude-plugin:p1@mk:w8-p'] });
    const recP = readJson(path.join(USK, 'w8-p', '.ruyi-import.json')) || {};
    const skP = (((await request('GET', '/api/skills')) || {}).json || {}).skills || [];
    ok(c11 && resOf(c11, 'claude-plugin:p1@mk:w8-p').outcome === 'created' && recP.source === 'claude-plugin' && recP.plugin === 'p1@mk'
      && skP.some(s => s.id === 'w8-p' && s.copiedFrom === 'claude-plugin' && s.copiedFromPlugin === 'p1@mk'), 'H16 插件技能复制:来源记录与注册表都记下插件名');
  } finally {
    try { killOwnTree(wb); } catch { /* already gone */ }
    await new Promise(resolve => provider.close(resolve));
    await sleep(300);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
  console.log('\nMIGRATION CENTER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
