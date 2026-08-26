// Kimi Code Agent CLI adapter contract: config selection, npm-shim escape hatch, native JSONL parsing,
// and settings surface. This test is credential-free and does not invoke the real Kimi service.
'use strict';
const fs = require('fs');
const cp = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { getFreePort } = require('./free-port.js');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const server = require(path.join(WB, 'app', 'server.js'));

let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label); }
};

const normalized = server.normalizeConfig({ agentCliType: 'kimi', kimiPath: '  X:\\tools\\kimi.cmd  ' }).config;
ok(normalized.agentCliType === 'kimi', 'config preserves Kimi driver selection');
ok(normalized.kimiPath === 'X:\\tools\\kimi.cmd', 'config normalizes Kimi launcher path');
ok(server.normalizeConfig({ agentCliType: 'kimi', model: 'k3-256k' }).config.model === 'kimi-code/k3-256k', 'legacy bare Kimi model migrates to its native alias');
ok(server.normalizeConfig({ agentCliType: 'unknown' }).config.agentCliType === 'claude', 'unknown driver falls back to Claude');
ok(Object.keys(server.AGENT_CLI_TYPES).join(',') === 'claude,kimi', 'driver registry contains only Claude and Kimi');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-adapter-'));
try {
  const bin = path.join(tmp, 'node_modules', '.bin');
  const entry = path.join(tmp, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(entry, '');
  const shim = path.join(bin, 'kimi.cmd');
  fs.writeFileSync(shim, '');
  const spawn = server.prepareAgentCliSpawn('kimi', shim, ['--version']);
  ok(path.resolve(spawn.command) === path.resolve(process.execPath), 'Kimi npm shim resolves to direct Node launch');
  ok(path.resolve(spawn.args[0]) === path.resolve(entry) && spawn.args[1] === '--version', 'direct launch preserves entrypoint and args');
  const psShim = path.join(bin, 'kimi.ps1');
  fs.writeFileSync(psShim, '');
  const psSpawn = server.prepareAgentCliSpawn('kimi', psShim, ['--version']);
  ok(path.resolve(psSpawn.command) === path.resolve(process.execPath) && path.resolve(psSpawn.args[0]) === path.resolve(entry), 'Kimi PowerShell shim resolves to the same direct Node entrypoint');
  ok(server.probeAgentCliLauncher(psShim) === true, 'Kimi PowerShell shim passes readiness probing without PowerShell execution-policy dependence');
  const globalRoot = path.join(tmp, 'global-npm');
  const globalEntry = path.join(globalRoot, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  fs.mkdirSync(path.dirname(globalEntry), { recursive: true });
  fs.writeFileSync(globalEntry, '');
  const globalShim = path.join(globalRoot, 'kimi.cmd');
  fs.writeFileSync(globalShim, '');
  const globalSpawn = server.prepareAgentCliSpawn('kimi', globalShim, ['--version']);
  ok(path.resolve(globalSpawn.args[0]) === path.resolve(globalEntry), 'global npm shim layout also resolves directly');
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = bin + path.delimiter + String(originalPath || '');
    const bareSpawn = server.prepareAgentCliSpawn('kimi', 'kimi.cmd', ['--version']);
    ok(path.resolve(bareSpawn.command) === path.resolve(process.execPath), 'bare Kimi command resolves its shim from PATH');
    ok(path.resolve(bareSpawn.args[0]) === path.resolve(entry), 'bare PATH shim bypasses cmd.exe through the package entrypoint');
  } finally {
    process.env.PATH = originalPath;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const loaderProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-acp-loader-'));
try {
  const entry = path.join(loaderProbe, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, [
    'function isBashToolInvocation(args, options) {',
    '\treturn args.length === 2 && args[0] === "-c" && options?.env?.["NO_COLOR"] === "1" && options?.env?.["TERM"] === "dumb";',
    '}',
    "process.stdout.write(String(isBashToolInvocation(['--files'], {})));",
  ].join('\n'));
  const register = path.join(WB, 'resources', 'kimi-acp-compat-register.mjs');
  const out = cp.execFileSync(process.execPath, ['--import', pathToFileURL(register).href, entry], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, RUYI_KIMI_ACP_COMPAT: '1' },
  });
  ok(out === 'true', 'opt-in Kimi ACP loader enables non-Bash process tools without modifying the installed CLI');
} finally {
  fs.rmSync(loaderProbe, { recursive: true, force: true });
}

const version = server.parseAgentCliEvent({ role: 'meta', type: 'system.version', version: '0.37.2' }, 'kimi');
ok(Array.isArray(version) && version.length === 0, 'version metadata is accepted without chat output');
const resume = server.parseAgentCliEvent({ role: 'meta', type: 'session.resume_hint', session_id: 'abc' }, 'kimi');
ok(resume[0]?.kind === 'init' && resume[0]?.sessionId === 'abc', 'resume hint binds native Kimi session');
const assistant = server.parseAgentCliEvent({ role: 'assistant', content: 'done', tool_calls: [{ id: 't1', function: { name: 'ReadFile', arguments: '{"path":"a"}' } }] }, 'kimi');
ok(assistant[0]?.kind === 'text' && assistant[0]?.text === 'done', 'assistant content becomes text');
ok(assistant[1]?.kind === 'tool_use' && assistant[1]?.name === 'ReadFile' && assistant[1]?.input?.path === 'a', 'Kimi function call becomes tool event');
const tool = server.parseAgentCliEvent({ role: 'tool', tool_call_id: 't1', content: 'ok' }, 'kimi');
ok(tool[0]?.kind === 'tool_result' && tool[0]?.id === 't1', 'Kimi tool response becomes tool result');
const compactBegin = server.parseKimiWireCompaction({ type: 'full_compaction.begin', source: 'auto' });
ok(compactBegin?.type === 'compact' && compactBegin.phase === 'started' && compactBegin.trigger === 'auto', 'Kimi wire auto-compaction start becomes visible compact event');
const compactApplied = server.parseKimiWireCompaction({ type: 'context.apply_compaction', tokensBefore: 100000, tokensAfter: 42000, compactedCount: 18 });
ok(compactApplied?.phase === 'applied' && compactApplied.beforeTokens === 100000 && compactApplied.afterTokens === 42000, 'Kimi wire compaction application preserves exact before/after usage');
const rebased = server.parseKimiWireCompaction({ type: 'token_counting.rebased', tokens: 42000 });
ok(rebased?.type === 'usage' && rebased.contextTokens === 42000, 'Kimi rebased token count synchronizes Ruyi usage');
const wireState = { subagents: new Map(), childTools: new Map() };
const spawned = server.parseKimiWireAgentEvents({ type: 'context.append_loop_event', event: {
  type: 'subagent.spawned', subagentId: 'agent-7', subagentName: 'coder', parentToolCallId: 'agent-tool-1', description: 'Inspect documentation', runInBackground: false,
} }, 'main', wireState);
const childCall = server.parseKimiWireAgentEvents({ type: 'context.append_loop_event', event: {
  type: 'tool.call', toolCallId: 'glob-1', name: 'Glob', args: { pattern: 'docs/**/*.md' },
} }, 'agent-7', wireState);
const childResult = server.parseKimiWireAgentEvents({ type: 'context.append_loop_event', event: {
  type: 'tool.result', toolCallId: 'glob-1', result: { output: 'docs/a.md', isError: false },
} }, 'agent-7', wireState);
const completed = server.parseKimiWireAgentEvents({ type: 'context.append_loop_event', event: {
  type: 'subagent.completed', subagentId: 'agent-7', resultSummary: 'Found the document.', contextTokens: 1234,
} }, 'main', wireState);
ok(spawned[0]?.type === 'subagent' && spawned[0]?.id === 'kimi:agent-7' && spawned[0]?.parentToolCallId === 'agent-tool-1', 'Kimi wire subagent spawn maps to the Ruyi subagent card contract');
ok(childCall[0]?.type === 'tool_use' && childCall[0]?.subagentId === 'kimi:agent-7' && childCall[0]?.name === 'Glob', 'Kimi child Glob wire event nests in its Ruyi subagent card');
ok(childResult[0]?.type === 'tool_result' && childResult[0]?.content === 'docs/a.md' && childResult[0]?.subagentId === 'kimi:agent-7', 'Kimi child tool result preserves output and ownership');
ok(completed[0]?.type === 'subagent' && completed[0]?.state === 'end' && completed[0]?.ok === true && completed[0]?.result === 'Found the document.', 'Kimi wire subagent completion settles the Ruyi card');

const html = fs.readFileSync(path.join(WB, 'app', 'public', 'index.html'), 'utf8');
const ui = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'provider-settings.js'), 'utf8');
const navigation = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'navigation-controls.js'), 'utf8');
const streamUi = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'chat-stream-runtime.js'), 'utf8');
const sessionUi = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'session-experience.js'), 'utf8');
ok(/compactProviderId/.test(navigation) && /默认（Kimi 原生压缩）/.test(navigation), 'context panel exposes universal compaction-model selector');
ok(/\/api\/agent\/compact/.test(streamUi) && !/sendPrompt\('\/compact'\)[\s\S]{0,120}agentCliType === 'kimi'/.test(streamUi), 'Kimi manual compact routes to native API instead of prompt text');
ok(/isProviderMode\(\) \|\| state\.config\?\.agentCliType !== 'kimi'/.test(sessionUi), 'Kimi status refresh cannot overwrite active Provider compaction usage');
ok(/handle && !isProviderMode\(\) && state\.config\?\.agentCliType === 'kimi'/.test(navigation), 'opening the Provider context popover cannot trigger a late Kimi usage overwrite');
ok(/case 'tool_use_update'/.test(streamUi) && /card\.inp\.textContent/.test(streamUi), 'live Kimi tool input updates refresh the existing Ruyi tool card');
const engine = fs.readFileSync(path.join(WB, 'app', 'src', '05-claude-engine.js'), 'utf8');
ok(/value="kimi">Kimi Code</.test(html) && /settings\.agentCli\.tab/.test(html), 'settings exposes Agent CLI selector with Kimi');
ok(/detectedKimiPath/.test(ui) && /currentAgentCliLabel/.test(ui), 'frontend readiness and labels follow selected driver');
const kimiBridge = fs.readFileSync(path.join(WB, 'app', 'src', '05b-kimi-bridge.js'), 'utf8');
ok(/runKimiAcpTurnPrepared/.test(engine) && /prepareKimiAcpSpawn\(claude\)/.test(kimiBridge) && /kimi-acp-compat-register\.mjs/.test(kimiBridge), 'engine launches Kimi through ACP with the guarded non-Bash tool compatibility layer');

const mcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-mcp-'));
try {
  const kimiHome = path.join(mcpHome, 'custom-kimi-home');
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.writeFileSync(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: { keepMe: { command: 'keep-command' } } }));
  const mcpConfig = server.normalizeConfig({
    includeWorkbenchMcp: true, mcpCommandMode: 'node',
    desktopMcp: { enabled: true, autodetect: false, command: process.execPath, args: ['fake-acc-server.js'] },
    externalMcpServers: [
      { id: 'acc', label: 'Duplicate ACC alias', command: 'python', args: ['-m', 'ai_computer_control.server'], toolTimeoutMs: 120000 },
      { id: 'slow-tool', command: process.execPath, args: ['fake-slow-tool.js'], startupTimeoutMs: 4321, toolTimeoutMs: 123456, enabledTools: ['run'] },
    ],
  }).config;
  fs.writeFileSync(path.join(mcpHome, 'config.json'), JSON.stringify(mcpConfig, null, 2));
  const childScript = [
    `const fs=require('fs'); const server=require(${JSON.stringify(path.join(WB, 'app', 'server.js'))});`,
    `(async()=>{ const target=${JSON.stringify(path.join(kimiHome, 'mcp.json'))};`,
    `const cfg=server.normalizeConfig(${JSON.stringify(mcpConfig)}).config; await server.syncMcpServersToKimi(cfg); const enabled=JSON.parse(fs.readFileSync(target,'utf8'));`,
    `await server.syncMcpServersToKimi({...cfg,includeWorkbenchMcp:false}); const disabled=JSON.parse(fs.readFileSync(target,'utf8'));`,
    `process.stdout.write(JSON.stringify({enabled,disabled})); })().catch(e=>{console.error(e);process.exit(1)});`,
  ].join('');
  const synced = JSON.parse(cp.execFileSync(process.execPath, ['-e', childScript], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: mcpHome, RUYI_HOME: mcpHome, KIMI_CODE_HOME: kimiHome, USERPROFILE: mcpHome, HOME: mcpHome },
  }));
  ok(synced.enabled?.mcpServers?.keepMe?.command === 'keep-command', 'Kimi MCP sync preserves unrelated user entries');
  ok(synced.enabled?.mcpServers?.['win-claude-workbench']?.command && !('type' in synced.enabled.mcpServers['win-claude-workbench']), 'Kimi MCP sync writes native inferred-transport shape');
  ok(synced.enabled?.mcpServers?.['win-claude-workbench']?.toolTimeoutMs === 900000, 'Kimi MCP sync grants Ruyi bridge its long-running tool budget');
  ok(synced.enabled?.mcpServers?.['ai-computer-control']?.toolTimeoutMs === 650000 && !synced.enabled?.mcpServers?.acc, 'Kimi MCP sync removes duplicate ACC aliases and avoids the 60-second transport timeout');
  ok(synced.enabled?.mcpServers?.['slow-tool']?.startupTimeoutMs === 4321 && synced.enabled?.mcpServers?.['slow-tool']?.toolTimeoutMs === 123456 && synced.enabled?.mcpServers?.['slow-tool']?.enabledTools?.[0] === 'run', 'Kimi MCP sync preserves per-server timeout and tool filters');
  ok(!synced.disabled?.mcpServers?.['win-claude-workbench'] && synced.disabled?.mcpServers?.keepMe?.command === 'keep-command', 'disabling Ruyi MCP removes only Ruyi-owned Kimi entries');
} finally {
  fs.rmSync(mcpHome, { recursive: true, force: true });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function getJson(port, requestPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, timeout: 3000,
      headers: testToken ? { 'x-wcw-token': testToken } : {} }, res => {
      let body = ''; res.on('data', chunk => (body += chunk));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function health(port) { return getJson(port, '/health'); }
let testToken = '';
function postJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'POST', timeout: 5000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...(testToken ? { 'x-wcw-token': testToken } : {}) } }, res => {
      let text = ''; res.on('data', chunk => (text += chunk));
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(null); } });
    });
    req.on('error', reject); req.end(raw);
  });
}
function stream(port, body, onEvent) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const events = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 30000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            if (line.trim()) {
              const event = JSON.parse(line); events.push(event);
              if (onEvent) Promise.resolve(onEvent(event)).catch(() => {});
            }
          } catch { /* diagnostic line */ }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('stream timeout')); });
    req.end(raw);
  });
}

async function verifyKimiWireWatcher() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-wire-watch-'));
  const previous = process.env.KIMI_CODE_HOME;
  let stop = () => {};
  try {
    const sessionId = 'kimi-wire-e2e';
    const sessionDir = path.join(root, 'sessions', 'session-e2e');
    const main = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    fs.mkdirSync(path.dirname(main), { recursive: true });
    fs.writeFileSync(main, '');
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), JSON.stringify({ sessionId, sessionDir }) + '\n');
    process.env.KIMI_CODE_HOME = root;
    const events = [];
    stop = server.watchKimiWire(sessionId, event => events.push(event), 262144, { subagents: new Map(), childTools: new Map() });
    fs.appendFileSync(main, JSON.stringify({ type: 'context.append_loop_event', event: {
      type: 'subagent.spawned', subagentId: 'agent-live', subagentName: 'coder', parentToolCallId: 'agent-tool-live', description: 'Find markdown', runInBackground: false,
    } }) + '\n');
    await sleep(350);
    const child = path.join(sessionDir, 'agents', 'agent-live', 'wire.jsonl');
    fs.mkdirSync(path.dirname(child), { recursive: true });
    fs.writeFileSync(child, [
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'grep-live', name: 'Grep', args: { pattern: 'TODO', path: 'docs' } } }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'grep-live', result: { output: 'docs/a.md:1:TODO', isError: false } } }),
    ].join('\n') + '\n');
    await sleep(450);
    fs.appendFileSync(main, JSON.stringify({ type: 'context.append_loop_event', event: {
      type: 'subagent.completed', subagentId: 'agent-live', resultSummary: 'One TODO found.', contextTokens: 321,
    } }) + '\n');
    await sleep(350);
    ok(events.some(event => event.type === 'subagent' && event.state === 'start' && event.id === 'kimi:agent-live'), 'Kimi wire watcher discovers a live subagent after the ACP session starts');
    ok(events.some(event => event.type === 'tool_use' && event.subagentId === 'kimi:agent-live' && event.name === 'Grep'), 'Kimi wire watcher follows newly-created child-agent tool files');
    ok(events.some(event => event.type === 'tool_result' && event.subagentId === 'kimi:agent-live' && /TODO/.test(String(event.content))), 'Kimi wire watcher relays child tool output to Ruyi');
    ok(events.some(event => event.type === 'subagent' && event.state === 'end' && event.id === 'kimi:agent-live' && event.ok === true), 'Kimi wire watcher completes the matching Ruyi subagent card');
  } finally {
    stop();
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verifyKimiPlanFilePathGuard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-plan-path-'));
  const escapes = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-plan-escape-'));
  const previous = process.env.KIMI_CODE_HOME;
  try {
    const sessionId = 'kimi-plan-path-e2e';
    const sessionDir = path.join(root, 'sessions', 'session-plan');
    const plansDir = path.join(sessionDir, 'agents', 'main', 'plans');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), JSON.stringify({ sessionId, sessionDir }) + '\n');
    process.env.KIMI_CODE_HOME = root;
    const legacyPlan = path.join(workspace, 'plan', 'legacy-plan.md');
    const context = { reg: { nativeSessionId: sessionId, kimiAcpPlanFile: legacyPlan }, session: { cwd: workspace } };
    ok(server.isKimiAcpPlanFilePath(path.join(plansDir, 'safe-plan.md'), context), 'active Kimi session plan markdown is recognized as internal protocol state');
    ok(server.isKimiAcpPlanFilePath(legacyPlan, context), 'legacy workspace plan markdown remains compatible when ACP names the current file');
    ok(!server.isKimiAcpPlanFilePath(path.join(workspace, 'plan', 'unknown-plan.md'), context), 'unknown legacy plan markdown does not bypass the filesystem guard');
    ok(!server.isKimiAcpPlanFilePath(path.join(sessionDir, 'agents', 'main', 'plans-evil', 'safe-plan.md'), context), 'lookalike plan directory cannot bypass the filesystem guard');
    ok(!server.isKimiAcpPlanFilePath(path.join(plansDir, '..', 'outside.md'), context), 'plan traversal cannot bypass the filesystem guard');
    ok(!server.isKimiAcpPlanFilePath(path.join(plansDir, 'not-markdown.txt'), context), 'non-plan files remain on the normal guarded path');
    ok(await server.resolveKimiAcpPlanFilePath(path.join(plansDir, 'safe-plan.md'), context) === path.resolve(plansDir, 'safe-plan.md'), 'canonical active session plan path is accepted before the file exists');

    const outside = escapes;
    fs.mkdirSync(path.join(outside, 'agents-target', 'main', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'session-target', 'agents', 'main', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'legacy-target'), { recursive: true });
    const makeJunction = (link, target) => {
      try { fs.symlinkSync(target, link, 'junction'); return true; } catch (error) {
        console.log('SKIP junction fixture: ' + (error && error.message || error));
        return false;
      }
    };
    const agentsJunctionSession = path.join(root, 'sessions', 'session-agents-junction');
    fs.mkdirSync(agentsJunctionSession, { recursive: true });
    const agentsJunction = makeJunction(path.join(agentsJunctionSession, 'agents'), path.join(outside, 'agents-target'));
    if (agentsJunction) {
      const junctionSessionId = 'kimi-plan-agents-junction';
      fs.writeFileSync(path.join(root, 'session_index.jsonl'), JSON.stringify({ sessionId: junctionSessionId, sessionDir: agentsJunctionSession }) + '\n');
      const escaped = path.join(agentsJunctionSession, 'agents', 'main', 'plans', 'escaped.md');
      const junctionContext = { reg: { nativeSessionId: junctionSessionId }, session: { cwd: workspace } };
      ok(!await server.resolveKimiAcpPlanFilePath(escaped, junctionContext), 'agents directory junction to an external tree is rejected by canonical-root validation');
    }
    const sessionJunction = path.join(root, 'sessions', 'session-root-junction');
    const sessionLink = makeJunction(sessionJunction, path.join(outside, 'session-target'));
    if (sessionLink) {
      const junctionSessionId = 'kimi-plan-session-junction';
      fs.writeFileSync(path.join(root, 'session_index.jsonl'), JSON.stringify({ sessionId: junctionSessionId, sessionDir: sessionJunction }) + '\n');
      const escaped = path.join(sessionJunction, 'agents', 'main', 'plans', 'escaped.md');
      const junctionContext = { reg: { nativeSessionId: junctionSessionId }, session: { cwd: workspace } };
      ok(!await server.resolveKimiAcpPlanFilePath(escaped, junctionContext), 'session directory junction outside KIMI_CODE_HOME is rejected');
    }
    const legacyWorkspace = path.join(root, 'legacy-workspace');
    fs.mkdirSync(legacyWorkspace, { recursive: true });
    const legacyJunction = makeJunction(path.join(legacyWorkspace, 'plan'), path.join(outside, 'legacy-target'));
    if (legacyJunction) {
      const escaped = path.join(legacyWorkspace, 'plan', 'escaped.md');
      const legacyContext = { reg: { nativeSessionId: '', kimiAcpPlanFile: escaped }, session: { cwd: legacyWorkspace } };
      ok(!await server.resolveKimiAcpPlanFilePath(escaped, legacyContext), 'legacy plan directory junction outside cwd is rejected');
    }
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(escapes, { recursive: true, force: true });
  }
}

(async () => {
  await verifyKimiPlanFilePathGuard();
  const resumeCaps = server.kimiAcpSessionRestoreMethods({ sessionCapabilities: { resume: {} }, loadSession: true });
  const loadCaps = server.kimiAcpSessionRestoreMethods({ sessionCapabilities: { resume: false }, loadSession: true });
  const disabledCaps = server.kimiAcpSessionRestoreMethods({ sessionCapabilities: { resume: false }, loadSession: false });
  ok(resumeCaps.methods.join(',') === 'session/resume,session/load' && loadCaps.methods[0] === 'session/load', 'Kimi ACP restore chooses declared resume/load capability paths');
  ok(disabledCaps.methods.length === 0 && disabledCaps.declared === true
    && server.kimiAcpUnknownSessionError({ code: -32602, message: 'Unknown sessionId: missing' }, 'missing')
    && !server.kimiAcpUnknownSessionError({ code: -32602, message: 'authentication failed' }, 'missing'), 'explicitly disabled restore cannot fall through to new-session recovery');
  const modesOnly = server.kimiAcpModeOptionFromActivated({ modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'plan' }] } });
  ok(modesOnly?.id === 'mode' && modesOnly.currentValue === 'default' && modesOnly.options?.some(option => option.value === 'plan'), 'modes-only ACP response becomes an advertised safe mode option');
  const staleMode = { kimiAcpConfigActualSeq: { mode: 0 }, kimiAcpLatestConfigActual: { mode: 'auto' } };
  const freshMode = { kimiAcpConfigActualSeq: { mode: 1 }, kimiAcpLatestConfigActual: { mode: 'plan' } };
  ok(server.kimiAcpFreshActualForOperation(staleMode, 'mode', 0, { mode: '' }) === ''
    && server.kimiAcpFreshActualForOperation(freshMode, 'mode', 0, { mode: '' }) === 'plan', 'Kimi mode fallback never reuses stale session actual without activation/connection evidence');
  const inferredWrite = server.kimiAcpInferConcreteToolInput({ title: 'Write', kind: 'edit', content: [{ type: 'content', content: { type: 'text', text: '{"path":"early.txt","content":"x","mode":"overwrite"}' } }] });
  const inferredBash = server.kimiAcpInferConcreteToolInput({ title: 'Bash', kind: 'execute', content: [{ type: 'content', content: { type: 'text', text: '{"command":"printf ok"}' } }] });
  ok(inferredWrite?.path === 'early.txt' && inferredWrite?.mode === 'overwrite' && inferredBash?.command === 'printf ok', 'Kimi early content JSON recovers concrete Write and Bash inputs only for native kinds');
  ok(server.kimiAcpInferConcreteToolInput({ title: 'Write', kind: 'edit', content: [{ type: 'text', text: '{"path":' }] }) === null
    && server.kimiAcpInferConcreteToolInput({ title: 'Write', kind: 'edit', content: [{ type: 'text', text: '{"path":"a"}' }, { type: 'text', text: '{"path":"b"}' }] }) === null
    && server.kimiAcpInferConcreteToolInput({ title: 'mcp__vendor__write_file', kind: 'edit', content: [{ type: 'text', text: '{"path":"a"}' }] }) === null
    && server.kimiAcpInferConcreteToolInput({ title: 'Write', kind: 'edit', content: [{ type: 'text', text: '{}' }] }) === null, 'Kimi early content recovery rejects illegal, ambiguous, MCP, and empty inputs');
  const stableToolMap = new Map([['stable-write', {
    nativeName: 'Write', name: 'later descriptive Write title', kind: 'edit', input: {},
    content: [{ type: 'content', content: { type: 'text', text: '{"path":"stable.txt","content":"x"}' } }],
  }]]);
  const stablePermissionTool = server.kimiAcpPermissionToolCall({ toolCall: { toolCallId: 'stable-write', title: 'later descriptive Write title', content: [] } }, { state: { toolMap: stableToolMap } });
  ok(stablePermissionTool.title === 'Write' && stablePermissionTool.rawInput?.path === 'stable.txt', 'same-id Kimi permission merge keeps the initial stable native name and recovers only that active tool input');
  const approvalPath = path.join(process.cwd(), 'kimi-approval-once.txt');
  const approvalContext = (rows, toolMap) => ({
    reg: { kimiAcpApprovals: rows }, state: { toolMap: toolMap || new Map() },
    session: { cwd: process.cwd() }, config: { defaultWorkspace: process.cwd() },
  });
  const approvalRow = (patch = {}) => ({ title: 'write', tier: 'edit', input: { path: approvalPath }, scope: 'once', toolCallId: 'live-once', at: Date.now(), ...patch });
  const liveOnce = approvalContext([approvalRow()], new Map([['live-once', { __settled: false }]]));
  ok(server.consumeKimiAcpApproval(liveOnce, 'write', { path: approvalPath }) === true
    && server.consumeKimiAcpApproval(liveOnce, 'write', { path: approvalPath }) === false, 'Kimi once approval is concrete, active-tool-bound, and single-use');
  const settledOnce = approvalContext([approvalRow({ toolCallId: 'settled-once' })], new Map([['settled-once', { __settled: true }]]));
  ok(server.consumeKimiAcpApproval(settledOnce, 'write', { path: approvalPath }) === false && settledOnce.reg.kimiAcpApprovals.length === 0, 'settled native tool invalidates its leftover Kimi once approval');
  const wrongTier = approvalContext([approvalRow({ tier: 'exec', toolCallId: 'wrong-tier' })], new Map([['wrong-tier', { __settled: false }]]));
  const emptyValue = approvalContext([approvalRow({ input: {}, toolCallId: 'empty-value' })], new Map([['empty-value', { __settled: false }]]));
  const wrongPath = approvalContext([approvalRow({ toolCallId: 'wrong-path' })], new Map([['wrong-path', { __settled: false }]]));
  ok(server.consumeKimiAcpApproval(wrongTier, 'write', { path: approvalPath }) === false
    && server.consumeKimiAcpApproval(emptyValue, 'write', {}) === false
    && server.consumeKimiAcpApproval(wrongPath, 'write', { path: path.join(process.cwd(), 'other.txt') }) === false, 'Kimi once approval rejects wrong tier, empty values, and wrong paths without wildcard reuse');
  const concurrent = approvalContext([
    approvalRow({ toolCallId: 'same-a' }), approvalRow({ toolCallId: 'same-b' }),
  ], new Map([['same-a', { __settled: false }], ['same-b', { __settled: false }]]));
  ok(server.consumeKimiAcpApproval(concurrent, 'write', { path: approvalPath }) === false
    && concurrent.reg.kimiAcpApprovals.length === 2, 'Kimi concurrent same-value once approvals remain manual when ownership is ambiguous');
  const sessionApproval = approvalContext([approvalRow({ scope: 'session', toolCallId: '' })]);
  ok(server.consumeKimiAcpApproval(sessionApproval, 'write', { path: approvalPath }) === true
    && server.consumeKimiAcpApproval(sessionApproval, 'write', { path: approvalPath }) === true, 'explicit Kimi session approval remains reusable for the exact same tier and value');
  ok(server.kimiAcpSuccessfulEnterPlanMode({ nativeName: 'EnterPlanMode' }, { status: 'completed' })
    && !server.kimiAcpSuccessfulEnterPlanMode({ nativeName: 'EnterPlanMode' }, { status: 'completed', error: { message: 'failed' } })
    && !server.kimiAcpSuccessfulEnterPlanMode({ nativeName: 'EnterPlanMode' }, { status: 'failed' })
    && !server.kimiAcpSuccessfulEnterPlanMode({ nativeName: 'later description' }, { status: 'completed' }), 'EnterPlanMode revocation requires the stable native name and completed non-error lifecycle');
  const trustedNativeBash = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe'].find(fs.existsSync)
    : '/bin/bash';
  const wrapperCwd = path.resolve(process.cwd());
  const nativeCommand = 'printf KIMI_PROBE_BASH_OK';
  const wrapperText = server.kimiAcpNativeBashWrapperTexts(nativeCommand, wrapperCwd)[0];
  const wrapperCandidate = trustedNativeBash && server.kimiAcpNativeBashWrapperCandidate({
    command: trustedNativeBash, args: ['-c', wrapperText], cwd: wrapperCwd,
  }, { session: { cwd: wrapperCwd }, config: { defaultWorkspace: wrapperCwd } });
  ok(Boolean(wrapperCandidate && wrapperCandidate.argv.length === 2 && wrapperCandidate.argv[0] === '-c')
    && server.kimiAcpNativeShellQuote("C:/probe/'cwd") === "'C:/probe/'\\''cwd'", 'native Bash wrapper candidate preserves exact executable/argv shape and upstream shell quoting');
  const wrapperRow = { title: 'bash', tier: 'exec', input: { command: nativeCommand, cwd: wrapperCwd }, nativeBash: { command: nativeCommand, cwd: wrapperCwd }, scope: 'once', toolCallId: 'native-wrapper', at: Date.now() };
  const wrapperApproval = approvalContext([wrapperRow], new Map([['native-wrapper', { __settled: false }]]));
  ok(Boolean(wrapperCandidate) && server.consumeKimiAcpApproval(wrapperApproval, 'terminal', {
    command: wrapperText, cwd: wrapperCwd, __kimiAcpNativeBashWrapper: wrapperCandidate,
  }) === true, 'native Bash approval reuses only the exact known wrapper and cwd');
  const extraCommand = server.kimiAcpNativeBashWrapperCandidate({
    command: trustedNativeBash || 'bash', args: ['-c', wrapperText + ' && whoami'], cwd: wrapperCwd,
  }, { session: { cwd: wrapperCwd }, config: { defaultWorkspace: wrapperCwd } });
  const differentCwd = path.dirname(wrapperCwd);
  const differentCwdCandidate = server.kimiAcpNativeBashWrapperCandidate({
    command: trustedNativeBash || 'bash', args: ['-c', wrapperText], cwd: differentCwd,
  }, { session: { cwd: wrapperCwd }, config: { defaultWorkspace: wrapperCwd } });
  const wrapperNegative = (candidate, rowPatch = {}) => {
    const context = approvalContext([{ ...wrapperRow, ...rowPatch }], new Map([['native-wrapper', { __settled: false }]]));
    return server.consumeKimiAcpApproval(context, 'terminal', {
      command: candidate ? candidate.executable : 'bash', cwd: candidate ? candidate.cwd : wrapperCwd,
      __kimiAcpNativeBashWrapper: candidate,
    }) === false;
  };
  ok(wrapperNegative(extraCommand) && wrapperNegative(differentCwdCandidate)
    && wrapperNegative(wrapperCandidate, { tier: 'edit' })
    && server.kimiAcpNativeBashWrapperCandidate({
      command: path.join(wrapperCwd, 'bash.exe'), args: ['-c', wrapperText], cwd: wrapperCwd,
    }, { session: { cwd: wrapperCwd }, config: { defaultWorkspace: wrapperCwd } }) === null
    && server.kimiAcpNativeBashWrapperCandidate({
      command: trustedNativeBash || 'bash', args: ['-c', ''], cwd: wrapperCwd,
    }, { session: { cwd: wrapperCwd }, config: { defaultWorkspace: wrapperCwd } }) === null, 'native Bash wrapper rejects extra commands, different cwd, wrong tier, workspace pseudo-shell, and empty wrapper command');
  const planBuilder = server.createTurnSegmentBuilder();
  planBuilder.consume({ type: 'kimi_plan_snapshot', planId: 'snapshot-e2e', markdown: '# Plan', path: 'C:\\safe\\plan.md', status: 'active', source: 'kimi-acp' });
  planBuilder.consume({ type: 'kimi_plan_snapshot', planId: 'snapshot-e2e', status: 'removed', source: 'kimi-acp' });
  const planSegments = planBuilder.snapshot().filter(segment => segment.planId === 'snapshot-e2e');
  ok(planSegments.length === 1 && planSegments[0].status === 'removed' && planSegments[0].markdown === '# Plan'
    && planSegments[0].path === 'C:\\safe\\plan.md' && planSegments[0].readOnly === true, 'removed Kimi plan snapshot updates in place without erasing prior markdown/path');
  const streamModule = await import(`data:text/javascript;base64,${Buffer.from(streamUi).toString('base64')}`);
  const updatedCard = {
    name: 'OldTool',
    nameEl: { textContent: '' },
    verbEl: { textContent: '' },
    inp: { textContent: '' },
    argEl: { textContent: '', title: '' },
  };
  streamModule.applyToolUseUpdate(updatedCard, {
    name: 'mcp__win-claude-workbench__powershell_run',
    input: { command: 'Get-Volume' },
  }, {
    humanizeToolName: name => `human:${name}`,
    safeStringify: value => JSON.stringify(value),
    toolArgSummary: input => input.command,
  });
  ok(updatedCard.verbEl.textContent === 'human:mcp__win-claude-workbench__powershell_run'
    && updatedCard.inp.textContent === '{"command":"Get-Volume"}'
    && updatedCard.argEl.textContent === 'Get-Volume',
    'Kimi late tool update executes with explicit formatter dependencies and updates the live card');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-turn-'));
  let child = null;
  let trustedRgRoot = '';
  try {
    const project = path.join(home, 'project');
    const npmBin = path.join(home, 'npm', 'node_modules', '.bin');
    const entry = path.join(home, 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
    trustedRgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-trusted-rg-'));
    const trustedRg = path.join(trustedRgRoot, process.platform === 'win32' ? 'rg.exe' : 'rg');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(npmBin, { recursive: true });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.copyFileSync(process.execPath, trustedRg);
    if (process.platform !== 'win32') fs.chmodSync(trustedRg, 0o755);
    const fakeSource = [
      "import readline from 'node:readline';",
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('0.37.2-test'); process.exit(0); }",
      "if (args[0] === 'provider' && args[1] === 'list' && args.includes('--json')) { console.log(JSON.stringify({providers:{'managed:kimi-code':{type:'kimi'}},models:{'kimi-code/k3-256k':{provider:'managed:kimi-code',model:'k3-256k',displayName:'K3 256K',maxContextSize:262144},'custom/fast':{provider:'custom',model:'fast',displayName:'Fast'}}})); process.exit(0); }",
      "if (args[0] !== 'acp') process.exit(2);",
      "const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');",
      "let promptSeq=0; const waiting=new Map(); const reverse=(id,method,params,reply)=>{waiting.set(String(id),{reply});send({jsonrpc:'2.0',id,method,params});};",
      "const update=(sessionId,update)=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});",
      "const current=(prompt,text)=>new RegExp('<current_user_message>\\\\s*'+text+'\\\\s*</current_user_message>').test(prompt); const finishPrompt=(msg,prompt,answer)=>{ const sid=String(msg.params.sessionId); const n=++promptSeq; update(sid,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:(answer||'KIMI_E2E:'+current(prompt,'hello-kimi'))}}); update(sid,{sessionUpdate:'tool_call',toolCallId:'turn'+n+':tool-1',title:'Read',kind:'read',status:'in_progress'}); update(sid,{sessionUpdate:'tool_call_update',toolCallId:'turn'+n+':tool-1',rawInput:{path:'demo-updated.txt'}}); update(sid,{sessionUpdate:'tool_call_update',toolCallId:'turn'+n+':tool-1',status:'completed',rawOutput:'fixture-result'}); update(sid,{sessionUpdate:'plan_update',plan:{type:'items',planId:'plan-e2e',entries:[{content:'Inspect ACP mapping',priority:'high',status:'completed'}]}}); update(sid,{sessionUpdate:'usage_update',used:1234+n,size:262144}); setTimeout(()=>send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn',usage:{inputTokens:101,outputTokens:7,totalTokens:108}}}),prompt.includes('cancel-kimi')?10000:(prompt.includes('steer-base')?500:10)); };",
      "const terminalFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId);update(sid,{sessionUpdate:'tool_call',toolCallId:'native-bash',title:'Bash',kind:'execute',status:'in_progress'});reverse('reverse-terminal-create','terminal/create',{sessionId:sid,command:process.execPath,args:['-e',\"process.stdout.write('ACP_TERMINAL_OK')\"],cwd:process.cwd(),env:[],outputByteLimit:65536},created=>{if(created.error)return finishPrompt(msg,prompt,'KIMI_TERMINAL_ERROR:'+created.error.message);const terminalId=created.result.terminalId;update(sid,{sessionUpdate:'tool_call_update',toolCallId:'native-bash',title:'Running native Bash',rawInput:{command:'node marker'}});reverse('reverse-terminal-wait','terminal/wait_for_exit',{sessionId:sid,terminalId},()=>reverse('reverse-terminal-output','terminal/output',{sessionId:sid,terminalId},output=>reverse('reverse-terminal-release','terminal/release',{sessionId:sid,terminalId},()=>{update(sid,{sessionUpdate:'tool_call_update',toolCallId:'native-bash',status:'completed',content:{type:'terminal',terminalId}});finishPrompt(msg,prompt,'KIMI_TERMINAL:'+String(output.result&&output.result.output));})));});};",
      "const searchFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId),command=String(process.env.RUYI_RG_PATH||'');update(sid,{sessionUpdate:'tool_call',toolCallId:'native-search',title:'Glob',kind:'search',status:'in_progress'});reverse('reverse-search-create','terminal/create',{sessionId:sid,command,args:['--files','--hidden','--sortr=modified','--glob','*.js','.'],cwd:process.cwd(),env:[{name:'CUSTOM_SEARCH_ENV',value:'must-not-be-forwarded'}],outputByteLimit:65536},created=>{if(created.error)return finishPrompt(msg,prompt,'KIMI_SEARCH_ERROR:'+created.error.message);const terminalId=created.result.terminalId;reverse('reverse-search-wait','terminal/wait_for_exit',{sessionId:sid,terminalId},waited=>{reverse('reverse-search-output','terminal/output',{sessionId:sid,terminalId},output=>{reverse('reverse-search-release','terminal/release',{sessionId:sid,terminalId},()=>{update(sid,{sessionUpdate:'tool_call_update',toolCallId:'native-search',status:'completed',content:{type:'terminal',terminalId}});finishPrompt(msg,prompt,'KIMI_SEARCH_FAST:'+String(waited.result&&waited.result.exitCode)+':'+String(output.result&&output.result.output||''));});});});});};",
      "const fsFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'acp-fs-roundtrip.txt');reverse('reverse-fs-write','fs/write_text_file',{sessionId:sid,path:file,content:'ACP_FS_OK'},written=>{if(written.error)return finishPrompt(msg,prompt,'KIMI_FS_ERROR:'+written.error.message);reverse('reverse-fs-read','fs/read_text_file',{sessionId:sid,path:file,line:1,limit:1},read=>finishPrompt(msg,prompt,'KIMI_FS:'+String(read.result&&read.result.content)));});};",
      "const planExecution=(msg,prompt,option)=>{const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'plan-executed.txt');reverse('reverse-plan-exec-write','fs/write_text_file',{sessionId:sid,path:file,content:'KIMI_PLAN_EXECUTED'},written=>{if(written.error)return finishPrompt(msg,prompt,'KIMI_PLAN_EXEC_ERROR:'+String(written.error.message||written.error));finishPrompt(msg,prompt,'KIMI_PLAN_OPTION:'+option+'|KIMI_PLAN_EXECUTED');});};",
      "const planBlocked=(msg,prompt,reason)=>{const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'plan-blocked.txt');if(reason==='mode')update(sid,{sessionUpdate:'current_mode_update',currentModeId:'default'});if(reason==='removed')update(sid,{sessionUpdate:'plan_removed'});reverse('reverse-plan-blocked-'+reason,'fs/write_text_file',{sessionId:sid,path:file,content:'SHOULD_NOT_WRITE'},written=>finishPrompt(msg,prompt,'KIMI_PLAN_BLOCKED:'+reason+':'+String(written.error&&written.error.message||'unexpected-success')));};",
      "const planFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'plan','fake-plan.md');update(sid,{sessionUpdate:'plan_update',plan:{type:'file',planId:'plan-file-e2e',uri:pathToFileURL(file).href}});reverse('reverse-plan-read','fs/read_text_file',{sessionId:sid,path:file},read=>{if(read.error||String(read.result&&read.result.content||'')!=='')return finishPrompt(msg,prompt,'KIMI_PLAN_READ_ERROR:'+String(read.error&&read.error.message||read.result&&read.result.content));reverse('reverse-plan-write','fs/write_text_file',{sessionId:sid,path:file,content:'# Kimi plan\\n- Inspect ACP mapping'},written=>{if(written.error)return finishPrompt(msg,prompt,'KIMI_PLAN_WRITE_ERROR:'+written.error.message);waiting.set('reverse-plan',{msg,prompt,reply:response=>{const option=String(response.result&&response.result.outcome&&response.result.outcome.optionId||'');if(option==='plan_approve'){if(prompt.includes('plan-reenter-kimi')){update(sid,{sessionUpdate:'plan_update',plan:{type:'items',planId:'plan-reentered',entries:[{content:'Re-enter plan',priority:'high',status:'pending'}]}});return planBlocked(msg,prompt,'reentered');}return planExecution(msg,prompt,option);}return finishPrompt(msg,prompt,'KIMI_PLAN_OPTION:'+option);}});send({jsonrpc:'2.0',id:'reverse-plan',method:'session/request_permission',params:{sessionId:sid,toolCall:{toolCallId:'exit-plan-1',title:'ExitPlanMode',content:[{type:'content',content:{type:'text',text:'# Kimi plan\\n- Inspect ACP mapping'}}]},options:[{optionId:'plan_approve',name:'Approve plan',kind:'allow_once'},{optionId:'plan_revise',name:'Revise plan',kind:'reject_once'},{optionId:'plan_reject_and_exit',name:'Reject and exit',kind:'reject_once'}]}});});});};",
      "const editAutoFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'accept-edits.txt');reverse('reverse-edit-auto','session/request_permission',{sessionId:sid,toolCall:{toolCallId:'edit-auto-1',title:'Write',kind:'edit',rawInput:{path:file,content:'AUTO_EDIT'}},options:[{optionId:'edit_allow_once',name:'Allow once',kind:'allow_once'},{optionId:'edit_allow_always',name:'Allow always',kind:'allow_always'},{optionId:'edit_reject',name:'Reject',kind:'reject_once'}]},reply=>finishPrompt(msg,prompt,'KIMI_EDIT_AUTO:'+String(reply.result&&reply.result.outcome&&reply.result.outcome.optionId||'')));};",
      "const editMergeFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId);update(sid,{sessionUpdate:'tool_call',toolCallId:'edit-merge-1',title:'Write',kind:'edit',rawInput:{path:'relative-auto.txt',content:'MERGED_EDIT'},status:'in_progress'});reverse('reverse-edit-merge','session/request_permission',{sessionId:sid,toolCall:{toolCallId:'edit-merge-1',title:'Write',content:[]},options:[{optionId:'merge_allow_once',name:'Allow once',kind:'allow_once'},{optionId:'merge_reject',name:'Reject',kind:'reject_once'}]},reply=>finishPrompt(msg,prompt,'KIMI_EDIT_MERGE:'+String(reply.result&&reply.result.outcome&&reply.result.outcome.optionId||'')));};",
      "const editOnlyAlwaysFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'only-always.txt');reverse('reverse-edit-only-always','session/request_permission',{sessionId:sid,toolCall:{toolCallId:'edit-only-always-1',title:'Write',kind:'edit',rawInput:{path:file,content:'ONLY_ALWAYS'}},options:[{optionId:'only_always',name:'Allow always',kind:'allow_always'},{optionId:'only_reject',name:'Reject',kind:'reject_once'}]},reply=>finishPrompt(msg,prompt,'KIMI_EDIT_ONLY_ALWAYS:'+String(reply.result&&reply.result.outcome&&reply.result.optionId||'')));};",
      "const editUnknownFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'unknown-edit.txt');reverse('reverse-edit-unknown','session/request_permission',{sessionId:sid,toolCall:{toolCallId:'edit-unknown-1',title:'mcp__vendor__write_file',kind:'edit',rawInput:{path:file,content:'UNKNOWN_EDIT'}},options:[{optionId:'unknown_allow_once',name:'Allow once',kind:'allow_once'},{optionId:'unknown_allow_always',name:'Allow always',kind:'allow_always'},{optionId:'unknown_reject',name:'Reject',kind:'reject_once'}]},reply=>finishPrompt(msg,prompt,'KIMI_EDIT_UNKNOWN:'+String(reply.result&&reply.result.outcome&&reply.result.outcome.optionId||'')));};",
      "const elicitFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId);reverse('reverse-elicit','elicitation/create',{sessionId:sid,toolCallId:'elicit-tool',mode:'form',message:'Choose execution settings',requestedSchema:{type:'object',properties:{strategy:{type:'string',title:'Strategy',oneOf:[{const:'safe',title:'Safe'},{const:'fast',title:'Fast'}]},confirm:{type:'boolean',title:'Confirm'}},required:['strategy','confirm']}},reply=>finishPrompt(msg,prompt,'KIMI_ELICIT:'+JSON.stringify(reply.result||reply.error)));};",
      "const cancelReverseFlow=(msg,prompt)=>{const sid=String(msg.params.sessionId);reverse('reverse-cancel-create','terminal/create',{sessionId:sid,command:process.execPath,args:['-e','setTimeout(()=>{},10000)'],cwd:process.cwd(),env:[]},created=>{if(created.error)return finishPrompt(msg,prompt,'KIMI_CANCEL_CREATE_ERROR');const terminalId=created.result.terminalId;reverse('reverse-cancel-wait','terminal/wait_for_exit',{sessionId:sid,terminalId},waited=>reverse('reverse-cancel-kill','terminal/kill',{sessionId:sid,terminalId},()=>reverse('reverse-cancel-release','terminal/release',{sessionId:sid,terminalId},()=>finishPrompt(msg,prompt,'KIMI_CANCEL_CODE:'+String(waited.error&&waited.error.code)))));setTimeout(()=>send({jsonrpc:'2.0',method:'$/cancel_request',params:{requestId:'reverse-cancel-wait'}}),50);});};",
      "readline.createInterface({input:process.stdin}).on('line',line=>{ let msg; try{msg=JSON.parse(line)}catch{return}; if(!msg.method&&msg.id!==undefined){ const held=waiting.get(String(msg.id)); if(held){waiting.delete(String(msg.id)); if(held.reply)return held.reply(msg); const option=String(msg.result&&msg.result.outcome&&msg.result.outcome.optionId); const prefix=held.kind==='permission'?'KIMI_PERMISSION_OPTION:':held.kind==='plan'?'KIMI_PLAN_OPTION:':'KIMI_QUESTION_OPTION:'; finishPrompt(held.msg,held.prompt,prefix+option);} return;} const m=msg.method; if(m==='initialize'){const caps=msg.params&&msg.params.clientCapabilities||{};if(caps.terminal!==true||caps.fs?.readTextFile!==true||caps.fs?.writeTextFile!==true||!caps.elicitation?.form||!caps.elicitation?.url||!caps.plan||!caps.planCapabilities)return send({jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'missing Ruyi ACP client capabilities'}});return send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1,agentInfo:{name:'Kimi Code CLI',version:'0.37.2-test'},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}},promptCapabilities:{image:true,embeddedContext:true}}}});} if(m==='session/new') return send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'kimi-session-e2e',configOptions:[]}}); if(m==='session/resume') return send({jsonrpc:'2.0',id:msg.id,result:{configOptions:[]}}); if(m==='session/set_config_option') return send({jsonrpc:'2.0',id:msg.id,result:{configOptions:[{id:msg.params.configId,currentValue:msg.params.value}]}}); if(m==='session/close') return send({jsonrpc:'2.0',id:msg.id,result:{}}); if(m==='session/cancel') return; if(m==='session/prompt'){ const prompt=String(msg.params.prompt&&msg.params.prompt[0]&&msg.params.prompt[0].text||''); if(current(prompt,'fail-kimi')) return send({jsonrpc:'2.0',id:msg.id,error:{code:-32000,message:'provider.auth_error: 403 usage limit reached'}}); if(current(prompt,'required-kimi')) return send({jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'required parameter cwd is missing'}}); if(current(prompt,'terminal-kimi'))return terminalFlow(msg,prompt); if(current(prompt,'fs-kimi'))return fsFlow(msg,prompt); if(current(prompt,'edit-auto-kimi'))return editAutoFlow(msg,prompt); if(current(prompt,'edit-unknown-kimi'))return editUnknownFlow(msg,prompt); if(current(prompt,'plan-kimi')||current(prompt,'plan-reject-kimi')||current(prompt,'plan-cancel-kimi')||current(prompt,'plan-mode-change-kimi')||current(prompt,'plan-removed-kimi')||current(prompt,'plan-reenter-kimi')){if(current(prompt,'plan-mode-change-kimi')){update(String(msg.params.sessionId),{sessionUpdate:'plan_update',plan:{type:'items',planId:'plan-mode-change',entries:[{content:'Mode change plan',priority:'high',status:'pending'}]}});return planBlocked(msg,prompt,'mode');}if(current(prompt,'plan-removed-kimi')){update(String(msg.params.sessionId),{sessionUpdate:'plan_update',plan:{type:'items',planId:'plan-removed',entries:[{content:'Removed plan',priority:'high',status:'pending'}]}});return planBlocked(msg,prompt,'removed');}return planFlow(msg,prompt);} if(current(prompt,'plan-new-turn-kimi')){const sid=String(msg.params.sessionId),file=path.join(process.cwd(),'plan-new-turn-blocked.txt');return reverse('reverse-plan-new-turn','fs/write_text_file',{sessionId:sid,path:file,content:'SHOULD_NOT_WRITE'},written=>finishPrompt(msg,prompt,'KIMI_PLAN_NEW_TURN:'+String(written.error&&written.error.message||'unexpected-success')));} if(current(prompt,'elicit-kimi'))return elicitFlow(msg,prompt); if(current(prompt,'cancel-reverse-kimi'))return cancelReverseFlow(msg,prompt); if(current(prompt,'approve-kimi')){ waiting.set('reverse-p',{msg,prompt,kind:'permission'}); return send({jsonrpc:'2.0',id:'reverse-p',method:'session/request_permission',params:{sessionId:msg.params.sessionId,toolCall:{toolCallId:'bash-1',title:'Bash',kind:'execute',rawInput:{command:'echo safe'},content:[]},options:[{optionId:'approve_once',name:'Approve once',kind:'allow_once'},{optionId:'approve_always',name:'Approve for this session',kind:'allow_always'},{optionId:'reject',name:'Reject',kind:'reject_once'}]}});} if(current(prompt,'ask-kimi')){ waiting.set('reverse-q',{msg,prompt,kind:'question'}); return send({jsonrpc:'2.0',id:'reverse-q',method:'session/request_permission',params:{sessionId:msg.params.sessionId,toolCall:{toolCallId:'ask-1',title:'AskUserQuestion',content:[{type:'content',content:{type:'text',text:'Choose a Kimi option'}}]},options:[{optionId:'q0_opt_0',name:'Alpha',kind:'allow_once'},{optionId:'q0_opt_1',name:'Beta',kind:'allow_once'},{optionId:'q0_skip',name:'Skip',kind:'reject_once'}]}});} return finishPrompt(msg,prompt); } send({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'unknown'}});});",
    ].join('\n')
      .replace("if(current(prompt,'terminal-kimi'))return terminalFlow(msg,prompt);", "if(current(prompt,'terminal-kimi'))return terminalFlow(msg,prompt); if(current(prompt,'search-kimi'))return searchFlow(msg,prompt);")
      .replace("if(current(prompt,'edit-auto-kimi'))return editAutoFlow(msg,prompt);", "if(current(prompt,'edit-auto-kimi'))return editAutoFlow(msg,prompt); if(current(prompt,'edit-merge-kimi'))return editMergeFlow(msg,prompt); if(current(prompt,'edit-only-always-kimi'))return editOnlyAlwaysFlow(msg,prompt);")
      .replace("if(m==='session/set_config_option') return", "if(m==='session/set_config_option'&&process.env.FAKE_KIMI_MODE_SETTER==='1'&&msg.params.configId==='mode')return send({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'method not found'}}); if(m==='session/set_config_option') return")
      .replace("if(m==='session/close') return send({jsonrpc:'2.0',id:msg.id,result:{}});", "if(m==='session/set_mode'){update(String(msg.params.sessionId),{sessionUpdate:'current_mode_update',currentModeId:msg.params.modeId});update(String(msg.params.sessionId),{sessionUpdate:'config_option_update',configOptions:[{id:'mode',currentValue:msg.params.modeId,options:[{value:'default'},{value:'plan'},{value:'auto'},{value:'yolo'}]}]});return send({jsonrpc:'2.0',id:msg.id,result:{}});} if(m==='session/close') return send({jsonrpc:'2.0',id:msg.id,result:{}});")
      .replace("if(m==='session/new') return send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'kimi-session-e2e',configOptions:[]}});", "if(m==='session/new') return send({jsonrpc:'2.0',id:msg.id,result:{sessionId:'kimi-session-e2e',configOptions:[{id:'model',currentValue:'',options:[{value:'kimi-code/k3-256k'},{value:'custom/fast'}]},{id:'thinking',currentValue:'high',options:[{value:'low'},{value:'medium'},{value:'high'},{value:'max'}]}],modes:{currentModeId:'default',availableModes:[{id:'default'},{id:'plan'},{id:'auto'},{id:'yolo'}]}}});")
      .replace("if(m==='session/resume') return send({jsonrpc:'2.0',id:msg.id,result:{configOptions:[]}});", "if(m==='session/resume') return send({jsonrpc:'2.0',id:msg.id,result:{configOptions:[{id:'model',currentValue:'',options:[{value:'kimi-code/k3-256k'},{value:'custom/fast'}]},{id:'thinking',currentValue:'high',options:[{value:'low'},{value:'medium'},{value:'high'},{value:'max'}]}],modes:{currentModeId:'default',availableModes:[{id:'default'},{id:'plan'},{id:'auto'},{id:'yolo'}]}}});")
      .replace("if(m==='session/set_config_option') return send({jsonrpc:'2.0',id:msg.id,result:{configOptions:[{id:msg.params.configId,currentValue:msg.params.value}]}});", "if(m==='session/set_config_option') return send({jsonrpc:'2.0',id:msg.id,result:{configOptions:[{id:'mode',currentValue:msg.params.configId==='mode'?msg.params.value:'default',options:[{value:'default'},{value:'plan'},{value:'auto'},{value:'yolo'}]},{id:'model',currentValue:msg.params.configId==='model'?msg.params.value:'',options:[{value:'kimi-code/k3-256k'},{value:'custom/fast'}]},{id:'thinking',currentValue:msg.params.configId==='thinking'?msg.params.value:'high',options:[{value:'low'},{value:'medium'},{value:'high'},{value:'max'}]}]}});");
    fs.writeFileSync(entry, fakeSource);
    const shim = path.join(npmBin, 'kimi.cmd');
    fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0\\..\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*\r\n`);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      configSchema: 11, agentCliType: 'kimi', kimiPath: shim, defaultWorkspace: project,
      includeWorkbenchMcp: false, autoResumeClaudeSessions: true, killPortOnStart: false,
      permissionMode: 'default', engineMode: 'legacy', providers: [], knownModels: ['k3-256k', 'claude-old-model'],
    }, null, 2));

    const port = await getFreePort();
    child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
      cwd: WB, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home, USERPROFILE: home, HOME: home, RUYI_RG_PATH: trustedRg, FAKE_KIMI_MODE_SETTER: '1' },
    });
    let ready = null;
    for (let attempt = 0; attempt < 40 && !ready?.ok; attempt++) { await sleep(150); ready = await health(port); }
    ok(Boolean(ready?.ok), 'workbench starts with selected fake Kimi driver');
    if (ready?.ok) {
      testToken = String((await postJson(port, '/api/bootstrap', {}))?.token || '');
      const modelReply = await getJson(port, '/api/models');
      const modelIds = (modelReply?.models || []).map(model => model.id);
      ok(modelReply?.ok === true && modelReply?.agentCliType === 'kimi', 'Kimi model refresh queries the selected CLI');
      ok(modelIds.includes('kimi-code/k3-256k') && modelIds.includes('custom/fast'), 'Kimi model refresh returns configured aliases');
      ok(!modelIds.includes('k3-256k') && !modelIds.includes('claude-old-model'), 'Kimi picker excludes bare/Claude remembered model ids');
      const events = await stream(port, { message: 'hello-kimi', cwd: project, attachments: [] });
      const meta = events.find(event => event.type === 'meta');
      const sessionId = events.find(event => event.type === 'session')?.session?.id;
      ok(meta?.agentCliType === 'kimi' && meta?.agentDriver === 'kimi-acp', 'turn metadata identifies Kimi ACP driver');
      ok(meta?.kimiAcpCompat === true, 'direct npm Kimi ACP launch enables the guarded non-Bash tool compatibility layer');
      ok(events.some(event => event.type === 'assistant_delta' && /KIMI_E2E:true/.test(event.text)), 'Kimi ACP assistant chunks reach the chat stream');
      ok(events.some(event => event.type === 'tool_use' && event.name === 'Read'), 'Kimi tool call reaches the chat stream');
      ok(events.some(event => event.type === 'tool_use_update' && event.input?.path === 'demo-updated.txt'), 'late Kimi tool input updates reach the existing chat card');
      ok(events.some(event => event.type === 'tool_result' && /:tool-1$/.test(event.id)), 'Kimi tool result reaches the chat stream');
      ok(events.some(event => event.type === 'todo' && event.items?.[0]?.text === 'Inspect ACP mapping' && event.items[0].status === 'done'), 'nested ACP plan_update maps to Ruyi todos');
      ok(events.some(event => event.type === 'kimi_plan_snapshot' && event.planId === 'plan-e2e'
        && event.status === 'active' && /Inspect ACP mapping/.test(event.markdown || '') && event.source === 'kimi-acp'), 'Kimi ACP plan_update emits a read-only ordered snapshot');
      ok(events.some(event => event.type === 'usage' && event.contextWindow === 262144), 'Kimi ACP usage update reaches the context panel');
      ok(events.some(event => event.type === 'result' && event.ok === true), 'Kimi process completion closes the turn successfully');
      ok(Boolean(sessionId), 'Kimi ACP turn exposes the Ruyi session id');
      const persistedTurn = await getJson(port, `/api/sessions/${sessionId}`);
      const persistedAssistant = persistedTurn?.session?.messages?.filter(message => message.role === 'assistant').at(-1);
      ok(persistedAssistant?.usage?.usage?.inputTokens === 101, 'ACP prompt-response usage is retained alongside context occupancy');
      ok(persistedAssistant?.segments?.some(segment => segment.type === 'plan' && segment.planId === 'plan-e2e'
        && segment.readOnly === true && segment.status === 'snapshot' && segment.source === 'kimi-acp'), 'Kimi plan snapshot persists as a read-only narrative segment');

      const asked = await stream(port, { sessionId, message: 'ask-kimi', cwd: project, attachments: [] }, event => {
        if (event.type !== 'ask_user') return;
        const question = event.questions && event.questions[0];
        return postJson(port, '/api/chat/answer', {
          sessionId, questionId: event.questionId,
          answers: [{ questionId: question.id, selectedOptionIds: ['q0_opt_1'] }],
        });
      });
      ok(asked.some(event => event.type === 'ask_user' && event.questions?.[0]?.options?.some(option => option.id === 'q0_opt_1')), 'Kimi AskUserQuestion becomes a structured Ruyi prompt');
      ok(asked.some(event => event.type === 'assistant_delta' && /KIMI_QUESTION_OPTION:q0_opt_1/.test(event.text)), 'structured user answer round-trips through ACP reverse RPC');

      const planned = await stream(port, { sessionId, message: 'plan-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'permission_request') {
          return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
        }
        if (event.type !== 'ask_user') return;
        const question = event.questions && event.questions[0];
        return postJson(port, '/api/chat/answer', {
          sessionId, questionId: event.questionId,
          answers: [{ questionId: question.id, selectedOptionIds: ['plan_approve'] }],
        });
      });
      ok(planned.some(event => event.type === 'ask_user' && /Inspect ACP mapping/.test(event.questions?.[0]?.question || '')
        && event.questions?.[0]?.options?.some(option => option.id === 'plan_approve')), 'Kimi ExitPlanMode becomes a visible structured Ruyi plan decision');
      ok(planned.some(event => event.type === 'assistant_delta' && /KIMI_PLAN_OPTION:plan_approve/.test(event.text)), 'Ruyi plan approval round-trips through ACP without aborting the turn');
      ok(planned.some(event => event.type === 'permission_request' && event.toolName === 'Write'
        && !String(event.input?.path || '').endsWith(path.join('plan', 'fake-plan.md'))), 'approved plan execution continues through the normal manual write permission');
      ok(fs.readFileSync(path.join(project, 'plan', 'fake-plan.md'), 'utf8') === '# Kimi plan\n- Inspect ACP mapping', 'Kimi empty-plan read and subsequent plan write complete through ACP');
      ok(fs.readFileSync(path.join(project, 'plan-executed.txt'), 'utf8') === 'KIMI_PLAN_EXECUTED', 'approved plan execution writes after the ordinary permission decision');

      const acceptEditsConfig = await postJson(port, '/api/config', { permissionMode: 'acceptEdits' });
      const editAuto = await stream(port, { sessionId, message: 'edit-auto-kimi', cwd: project, attachments: [] });
      ok(acceptEditsConfig?.config?.permissionMode === 'acceptEdits'
        && !editAuto.some(event => event.type === 'permission_request')
        && editAuto.some(event => event.type === 'assistant_delta' && /KIMI_EDIT_AUTO:edit_allow_once/.test(event.text)), 'acceptEdits native Write returns allow_once without a second popup');
      const editMerge = await stream(port, { sessionId, message: 'edit-merge-kimi', cwd: project, attachments: [] });
      ok(!editMerge.some(event => event.type === 'permission_request')
        && editMerge.some(event => event.type === 'assistant_delta' && /KIMI_EDIT_MERGE:merge_allow_once/.test(event.text)), 'acceptEdits merges same-id tool_call kind/rawInput and allows a relative Write path once');
      const editOnlyAlways = await stream(port, { sessionId, message: 'edit-only-always-kimi', cwd: project, attachments: [] }, event => {
        if (event.type !== 'permission_request') return;
        return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(editOnlyAlways.some(event => event.type === 'permission_request')
        && editOnlyAlways.some(event => event.type === 'assistant_delta' && /^KIMI_EDIT_ONLY_ALWAYS:$/.test(event.text)), 'acceptEdits does not upgrade a native request that lacks allow_once');
      const editUnknown = await stream(port, { sessionId, message: 'edit-unknown-kimi', cwd: project, attachments: [] }, event => {
        if (event.type !== 'permission_request') return;
        return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(editUnknown.some(event => event.type === 'permission_request'), 'acceptEdits unknown/prefixed edit tool remains interactive');
      await postJson(port, '/api/config', { permissionMode: 'default' });

      const approved = await stream(port, { sessionId, message: 'approve-kimi', cwd: project, attachments: [] }, event => {
        if (event.type !== 'permission_request') return;
        return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'session' });
      });
      ok(approved.some(event => event.type === 'permission_request' && event.toolName === 'Bash'), 'Kimi tool approval uses the Ruyi permission surface');
      ok(approved.some(event => event.type === 'assistant_delta' && /KIMI_PERMISSION_OPTION:approve_always/.test(event.text)), 'session-scoped approval maps to ACP allow_always');

      const terminal = await stream(port, { sessionId, message: 'terminal-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'permission_request') return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(terminal.some(event => event.type === 'assistant_delta' && /KIMI_TERMINAL:ACP_TERMINAL_OK/.test(event.text)), 'Kimi ACP Bash uses the Ruyi terminal capability and returns output');
      ok(terminal.some(event => event.type === 'tool_result' && event.id === 'native-bash' && event.content === 'ACP_TERMINAL_OK'), 'released ACP terminal output replaces the opaque terminalId in the Ruyi tool card');

      await postJson(port, '/api/config', { permissionMode: 'plan' });
      const nativeSearch = await stream(port, { sessionId, message: 'search-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'permission_request') return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(!nativeSearch.some(event => event.type === 'permission_request')
        && nativeSearch.some(event => event.type === 'assistant_delta' && /KIMI_SEARCH_FAST:/.test(event.text)), 'trusted native Kimi search skips execution permission while retaining read-only classification');
      await postJson(port, '/api/config', { permissionMode: 'default' });

      const fileRoundtrip = await stream(port, { sessionId, message: 'fs-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'permission_request') return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(fileRoundtrip.some(event => event.type === 'assistant_delta' && /KIMI_FS:ACP_FS_OK/.test(event.text)), 'Kimi ACP text write/read round-trips through guarded Ruyi filesystem calls');
      ok(fs.readFileSync(path.join(project, 'acp-fs-roundtrip.txt'), 'utf8') === 'ACP_FS_OK', 'ACP filesystem write is applied in the selected workspace');

      const elicited = await stream(port, { sessionId, message: 'elicit-kimi', cwd: project, attachments: [] }, event => {
        if (event.type !== 'ask_user') return;
        return postJson(port, '/api/chat/answer', {
          sessionId, questionId: event.questionId,
          answers: event.questions.map(question => ({
            questionId: question.id,
            selectedOptionIds: [question.header === 'Strategy' ? 'kimi_strategy_1' : 'kimi_confirm_0'],
          })),
        });
      });
      ok(elicited.some(event => event.type === 'assistant_delta' && /KIMI_ELICIT:.*\"strategy\":\"fast\".*\"confirm\":true/.test(event.text)), 'Kimi ACP form elicitation maps to structured Ruyi user input');

      const reverseCancelled = await stream(port, { sessionId, message: 'cancel-reverse-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'permission_request') return postJson(port, '/api/permission/decision', { requestId: event.requestId, behavior: 'allow', scope: 'once' });
      });
      ok(reverseCancelled.some(event => event.type === 'assistant_delta' && /KIMI_CANCEL_CODE:-32800/.test(event.text)), 'ACP $/cancel_request interrupts a pending Ruyi terminal wait with the standard cancellation code');

      let markSteerRunning;
      const steerRunning = new Promise(resolve => { markSteerRunning = resolve; });
      const steeredPromise = stream(port, { sessionId, message: 'steer-base', cwd: project, attachments: [] }, event => {
        if (event.type === 'process' && event.state === 'running') markSteerRunning();
      });
      await steerRunning;
      await sleep(80);
      const steerReply = await postJson(port, '/api/steer', { sessionId, text: 'steer-followup' });
      const steered = await steeredPromise;
      ok(steerReply?.ok === true && steerReply?.queued === 1 && steerReply?.protocol === 'kimi-acp-followup', 'Kimi steer honestly reports queued ACP follow-up semantics');
      ok(steered.some(event => event.type === 'steered' && event.text === 'steer-followup'), 'queued steer is injected into the same live Kimi ACP session');
      ok(steered.filter(event => event.type === 'assistant_delta').length >= 2, 'queued steer runs as a follow-up ACP prompt before the outer turn closes');

      let markCancelableRunning;
      const cancelableRunning = new Promise(resolve => { markCancelableRunning = resolve; });
      const cancelablePromise = stream(port, { sessionId, message: 'cancel-kimi', cwd: project, attachments: [] }, event => {
        if (event.type === 'process' && event.state === 'running') markCancelableRunning();
      });
      await cancelableRunning;
      await sleep(80);
      const stopReply = await postJson(port, '/api/stop', { sessionId });
      const cancelled = await cancelablePromise;
      const cancelledResult = cancelled.find(event => event.type === 'result');
      ok(stopReply?.ok === true && stopReply?.stopped === true, 'Kimi ACP live turn accepts the common stop endpoint');
      ok(cancelledResult?.ok === false && cancelledResult?.aborted === true, 'stopped Kimi ACP prompt settles as aborted instead of a false success');

      const failed = await stream(port, { sessionId, message: 'fail-kimi', cwd: project, attachments: [] });
      const failedResult = failed.find(event => event.type === 'result');
      ok(failedResult?.ok === false && /usage limit/.test(String(failedResult.error || '')), 'Kimi stderr reaches the visible failed-result card');
      const required = await stream(port, { sessionId, message: 'required-kimi', cwd: project, attachments: [] });
      const requiredResult = required.find(event => event.type === 'result');
      ok(requiredResult?.ok === false && /required parameter/.test(String(requiredResult.error || '')) && !/kimi login/i.test(String(requiredResult.error || '')), 'non-auth ACP required-field errors are not misreported as login failures');
    }
  } finally {
    if (child?.pid) {
      try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    }
    await sleep(200);
    fs.rmSync(home, { recursive: true, force: true });
    if (trustedRgRoot) fs.rmSync(trustedRgRoot, { recursive: true, force: true });
  }
  await verifyKimiWireWatcher();
  if (failures) process.exitCode = 1;
  else console.log('Kimi Agent CLI adapter contract passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
