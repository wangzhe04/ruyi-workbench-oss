'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-roles-e2e');
const PROJECT = path.join(HOME, 'project');
process.env.RUYI_HOME = path.join(HOME, 'unit-data');
const {
  normalizeConfig, getAgentRoleLibrary, saveProjectAgentRoles,
  readClaudeProjectAgentRoles, buildClaudeAgentDefinitions,
} = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { failures += 1; console.error('FAIL ' + label); } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function kill(child) { if (child && child.pid) { try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
function health(port) { return new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, res => { let b=''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); }); }
function stream(port, body) { return new Promise((resolve, reject) => { const raw=JSON.stringify(body); const req=http.request({host:'127.0.0.1',port,path:'/api/chat/stream',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw)}},res=>{let buf='',events=[];res.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);try{if(line.trim())events.push(JSON.parse(line));}catch{}}});res.on('end',()=>resolve(events));});req.on('error',reject);req.write(raw);req.end(); }); }

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(PROJECT, { recursive: true });
  const normalized = normalizeConfig({ permissionMode: 'bypass', agentRoleOverrides: [{ id: 'My Role!', openaiModel: 'x-model', maxIters: 99, permissionMode: 'dontAsk' }] }).config;
  ok(normalized.agentRoleOverrides[0].id === 'my-role' && normalized.agentRoleOverrides[0].budgets.openai === 12, 'global custom role is sanitized and budget-clamped');

  await saveProjectAgentRoles(PROJECT, [
    { id: 'explorer', label: 'Project Explorer', prompt: 'project explorer prompt', toolTier: 'read' },
    { id: 'project-specialist', label: 'Project Specialist', prompt: 'project-only prompt', toolTier: 'edit', openaiTools: ['file_read', 'file_edit'] },
  ]);
  fs.mkdirSync(path.join(PROJECT, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '.claude', 'agents', 'native-auditor.md'), '---\nname: native-auditor\ndescription: Native auditor\nmodel: sonnet\ntools: [Read, Grep]\npermissionMode: plan\nmaxTurns: 9\n---\nAudit natively.\n');
  const cfg = normalizeConfig({ permissionMode: 'bypass', agentRoleOverrides: [{ id: 'worker', label: 'Global Worker', prompt: 'global worker prompt', models: { openai: 'worker-model', claude: 'sonnet' } }] }).config;
  const library = await getAgentRoleLibrary(PROJECT, cfg);
  ok(library.some(r => r.id === 'explorer' && r.label === 'Project Explorer' && r.source === 'project'), 'project role overrides built-in role');
  ok(library.some(r => r.id === 'worker' && r.label === 'Global Worker' && r.models.openai === 'worker-model'), 'global override configures built-in worker model');
  ok(library.some(r => r.id === 'project-specialist'), 'project custom role joins the library');
  const native = await readClaudeProjectAgentRoles(PROJECT);
  ok(native.length === 1 && native[0].nativeClaude && native[0].claudeTools.includes('Read'), 'native .claude/agents role is discovered for display');
  const defs = await buildClaudeAgentDefinitions(PROJECT, cfg);
  ok(defs.definitions.worker && defs.definitions.worker.model === 'sonnet', 'Claude definitions carry its independent role model override');
  ok(defs.definitions.reviewer && defs.definitions.reviewer.permissionMode === 'plan' && defs.definitions.reviewer.maxTurns, 'Claude definitions carry permissions and iteration budget');

  const DATA = path.join(HOME, 'live-data'); fs.mkdirSync(DATA, { recursive: true });
  const capture = path.join(HOME, 'claude-argv.json');
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', activeProvider: '', engineMode: 'interactive', includePartialMessages: false,
    agentRoleOverrides: [{ id: 'security-checker', label: 'Security Checker', description: 'Checks security', prompt: 'SECRET_ROLE_PROMPT', claudeModel: 'sonnet', claudeTools: ['Read', 'Grep'], mcpServers: ['win-claude-workbench'], permissionMode: 'dontAsk', maxTurns: 7 }],
  }, null, 2));
  const port = 9072;
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env: { ...process.env, RUYI_HOME: DATA, WCW_FAKE_CLAUDE: path.join(WB, 'tools', 'fake-claude.js'), WCW_FAKE_ARGV_CAPTURE: capture, WCW_FAKE_SCENARIO: 'agents' }, windowsHide: true });
  try {
    let up = null; for (let i=0;i<40 && !up;i++){await sleep(150);up=await health(port);} ok(!!up, 'Claude role test server starts');
    const events = await stream(port, { message: 'run agents', cwd: PROJECT });
    const meta = events.find(e => e.type === 'meta');
    const start = events.find(e => e.type === 'subagent' && e.state === 'start');
    const end = events.find(e => e.type === 'subagent' && e.state === 'end');
    ok(meta && meta.agentDriver === 'claude-native' && Array.isArray(meta.agentRoles), 'Claude meta exposes native role driver and role list');
    ok(meta && !JSON.stringify(meta.args || []).includes('SECRET_ROLE_PROMPT'), 'Claude meta redacts role definition payload');
    ok(start && start.native === true && start.roleId === 'reviewer' && end && end.ok === true, 'Claude Agent tool is normalized into subagent start/end events');
    const argv = JSON.parse(fs.readFileSync(capture, 'utf8')); const idx = argv.indexOf('--agents'); const sent = idx >= 0 ? JSON.parse(argv[idx + 1]) : {};
    ok(sent['security-checker'] && sent['security-checker'].model === 'sonnet' && sent['security-checker'].maxTurns === 7, '--agents receives custom model and maxTurns');
    ok(sent['security-checker'] && sent['security-checker'].mcpServers[0] === 'win-claude-workbench' && sent['security-checker'].permissionMode === 'dontAsk', '--agents receives MCP and permission settings');
  } finally { kill(wb); await sleep(250); }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nAGENT ROLES E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
