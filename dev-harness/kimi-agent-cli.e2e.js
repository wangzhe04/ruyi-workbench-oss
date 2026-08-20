// Kimi Code Agent CLI adapter contract: config selection, npm-shim escape hatch, native JSONL parsing,
// and settings surface. This test is credential-free and does not invoke the real Kimi service.
'use strict';
const fs = require('fs');
const cp = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
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

const version = server.parseAgentCliEvent({ role: 'meta', type: 'system.version', version: '0.37.2' }, 'kimi');
ok(Array.isArray(version) && version.length === 0, 'version metadata is accepted without chat output');
const resume = server.parseAgentCliEvent({ role: 'meta', type: 'session.resume_hint', session_id: 'abc' }, 'kimi');
ok(resume[0]?.kind === 'init' && resume[0]?.sessionId === 'abc', 'resume hint binds native Kimi session');
const assistant = server.parseAgentCliEvent({ role: 'assistant', content: 'done', tool_calls: [{ id: 't1', function: { name: 'ReadFile', arguments: '{"path":"a"}' } }] }, 'kimi');
ok(assistant[0]?.kind === 'text' && assistant[0]?.text === 'done', 'assistant content becomes text');
ok(assistant[1]?.kind === 'tool_use' && assistant[1]?.name === 'ReadFile' && assistant[1]?.input?.path === 'a', 'Kimi function call becomes tool event');
const tool = server.parseAgentCliEvent({ role: 'tool', tool_call_id: 't1', content: 'ok' }, 'kimi');
ok(tool[0]?.kind === 'tool_result' && tool[0]?.id === 't1', 'Kimi tool response becomes tool result');

const html = fs.readFileSync(path.join(WB, 'app', 'public', 'index.html'), 'utf8');
const ui = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'provider-settings.js'), 'utf8');
const engine = fs.readFileSync(path.join(WB, 'app', 'src', '05-claude-engine.js'), 'utf8');
ok(/value="kimi">Kimi Code</.test(html) && /settings\.agentCli\.tab/.test(html), 'settings exposes Agent CLI selector with Kimi');
ok(/detectedKimiPath/.test(ui) && /currentAgentCliLabel/.test(ui), 'frontend readiness and labels follow selected driver');
ok(/--output-format', 'stream-json/.test(engine) && /args\.push\('-p', fullPrompt\)/.test(engine), 'engine launches Kimi headless stream-json prompt mode');

const mcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-mcp-'));
try {
  const kimiHome = path.join(mcpHome, 'custom-kimi-home');
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.writeFileSync(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: { keepMe: { command: 'keep-command' } } }));
  const childScript = [
    `const fs=require('fs'); const server=require(${JSON.stringify(path.join(WB, 'app', 'server.js'))});`,
    `(async()=>{ const target=${JSON.stringify(path.join(kimiHome, 'mcp.json'))};`,
    `await server.syncMcpServersToKimi(server.normalizeConfig({mcpCommandMode:'node',includeWorkbenchMcp:true}).config); const enabled=JSON.parse(fs.readFileSync(target,'utf8'));`,
    `await server.syncMcpServersToKimi(server.normalizeConfig({mcpCommandMode:'node',includeWorkbenchMcp:false}).config); const disabled=JSON.parse(fs.readFileSync(target,'utf8'));`,
    `process.stdout.write(JSON.stringify({enabled,disabled})); })().catch(e=>{console.error(e);process.exit(1)});`,
  ].join('');
  const synced = JSON.parse(cp.execFileSync(process.execPath, ['-e', childScript], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: mcpHome, RUYI_HOME: mcpHome, KIMI_CODE_HOME: kimiHome, USERPROFILE: mcpHome, HOME: mcpHome },
  }));
  ok(synced.enabled?.mcpServers?.keepMe?.command === 'keep-command', 'Kimi MCP sync preserves unrelated user entries');
  ok(synced.enabled?.mcpServers?.['win-claude-workbench']?.command && !('type' in synced.enabled.mcpServers['win-claude-workbench']), 'Kimi MCP sync writes native inferred-transport shape');
  ok(!synced.disabled?.mcpServers?.['win-claude-workbench'] && synced.disabled?.mcpServers?.keepMe?.command === 'keep-command', 'disabling Ruyi MCP removes only Ruyi-owned Kimi entries');
} finally {
  fs.rmSync(mcpHome, { recursive: true, force: true });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function getJson(port, requestPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, timeout: 3000 }, res => {
      let body = ''; res.on('data', chunk => (body += chunk));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function health(port) { return getJson(port, '/health'); }
function stream(port, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 15000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buffer = ''; const events = [];
      res.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try { if (line.trim()) events.push(JSON.parse(line)); } catch { /* diagnostic line */ }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('stream timeout')); });
    req.end(raw);
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-turn-'));
  let child = null;
  try {
    const project = path.join(home, 'project');
    const npmBin = path.join(home, 'npm', 'node_modules', '.bin');
    const entry = path.join(home, 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(npmBin, { recursive: true });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, [
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('0.37.2-test'); process.exit(0); }",
      "if (args[0] === 'provider' && args[1] === 'list' && args.includes('--json')) { console.log(JSON.stringify({providers:{'managed:kimi-code':{type:'kimi'}},models:{'kimi-code/k3-256k':{provider:'managed:kimi-code',model:'k3-256k',displayName:'K3 256K',maxContextSize:262144},'custom/fast':{provider:'custom',model:'fast',displayName:'Fast'}}})); process.exit(0); }",
      "const pi = args.lastIndexOf('-p'); const prompt = pi >= 0 ? String(args[pi + 1] || '') : '';",
      "if (prompt.includes('fail-kimi')) { console.error('provider.auth_error: 403 usage limit reached'); process.exit(1); }",
      "console.log(JSON.stringify({role:'meta',type:'system.version',version:'0.37.2-test'}));",
      "console.log(JSON.stringify({role:'meta',type:'session.resume_hint',session_id:'kimi-session-e2e'}));",
      "console.log(JSON.stringify({role:'assistant',content:'KIMI_E2E:' + prompt.includes('hello-kimi'),tool_calls:[{id:'tool-1',function:{name:'ReadFile',arguments:JSON.stringify({path:'demo.txt'})}}]}));",
      "console.log(JSON.stringify({role:'tool',tool_call_id:'tool-1',content:'fixture-result'}));",
      "console.log(JSON.stringify({role:'assistant',content:'KIMI_DONE'}));",
    ].join('\n'));
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
      env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home, USERPROFILE: home, HOME: home },
    });
    let ready = null;
    for (let attempt = 0; attempt < 40 && !ready?.ok; attempt++) { await sleep(150); ready = await health(port); }
    ok(Boolean(ready?.ok), 'workbench starts with selected fake Kimi driver');
    if (ready?.ok) {
      const modelReply = await getJson(port, '/api/models');
      const modelIds = (modelReply?.models || []).map(model => model.id);
      ok(modelReply?.ok === true && modelReply?.agentCliType === 'kimi', 'Kimi model refresh queries the selected CLI');
      ok(modelIds.includes('kimi-code/k3-256k') && modelIds.includes('custom/fast'), 'Kimi model refresh returns configured aliases');
      ok(!modelIds.includes('k3-256k') && !modelIds.includes('claude-old-model'), 'Kimi picker excludes bare/Claude remembered model ids');
      const events = await stream(port, { message: 'hello-kimi', cwd: project, attachments: [] });
      const meta = events.find(event => event.type === 'meta');
      ok(meta?.agentCliType === 'kimi' && meta?.agentDriver === 'kimi-native', 'turn metadata identifies Kimi native driver');
      ok(events.some(event => event.type === 'assistant_delta' && /KIMI_E2E:true/.test(event.text)), 'Kimi assistant JSONL reaches the chat stream');
      ok(events.some(event => event.type === 'tool_use' && event.name === 'ReadFile'), 'Kimi tool call reaches the chat stream');
      ok(events.some(event => event.type === 'tool_result' && event.id === 'tool-1'), 'Kimi tool result reaches the chat stream');
      ok(events.some(event => event.type === 'result' && event.ok === true), 'Kimi process completion closes the turn successfully');
      const failed = await stream(port, { message: 'fail-kimi', cwd: project, attachments: [] });
      const failedResult = failed.find(event => event.type === 'result');
      ok(failedResult?.ok === false && /usage limit/.test(String(failedResult.error || '')), 'Kimi stderr reaches the visible failed-result card');
    }
  } finally {
    if (child?.pid) {
      try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    }
    await sleep(200);
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
  else console.log('Kimi Agent CLI adapter contract passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
