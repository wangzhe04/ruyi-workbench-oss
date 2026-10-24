'use strict';
// Actual generated serve + real Claude/Kimi launch paths; only the CLI model is fake.
// Each fake CLI reads its own production MCP config/environment and starts actual stdio MCP.
// No manual registry/grant insertion, real provider, installed CLI, native crypto or network service.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), http = require('node:http'), crypto = require('node:crypto');
const SELF = __filename;
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? '' : process.argv[at + 1]; };
const REPO = path.resolve(option('--repo') || process.env.RUYI_LIFECYCLE_REPO || path.join(__dirname, '..'));
const LIB = path.join(REPO, 'dev-harness', 'lib');
const { killOwnTree } = require(path.join(LIB, 'kill-own-tree'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (value, label) => { if (!value) throw Error(label); };
const ownedChildren = new Set();
function spawn(command, args, options) {
  const child = cp.spawn(command, args, { windowsHide: true, ...options });
  ownedChildren.add(child); child.once('close', () => ownedChildren.delete(child)); return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  const closed = new Promise(resolve => { child.once('close', resolve); timer = setTimeout(resolve, 5000); });
  killOwnTree(child); await closed; clearTimeout(timer);
  check(child.exitCode !== null || child.signalCode !== null, 'owned child did not exit');
}
function mcp(definition, trap, inherited = process.env) {
  const env = { ...inherited, ...(definition.env || {}) };
  // A transport-only MCP must not touch even a nonexistent data directory.
  if (trap) { env.RUYI_HOME = trap; env.WIN_CLAUDE_WORKBENCH_HOME = trap; }
  const child = spawn(definition.command, definition.args || [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, buffer = '', bytes = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8'); child.stderr.resume(); child.stdin.on('error', () => {});
  child.stdout.on('data', text => {
    bytes += Buffer.byteLength(text); if (bytes > 8 * 1024 * 1024) { killOwnTree(child); return; }
    buffer += text; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const entry = pending.get(row.id); if (entry) { pending.delete(row.id); clearTimeout(entry.timer); entry.resolve(row); }
    }
  });
  const failPending = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('MCP exited before result')); } pending.clear(); };
  child.once('close', failPending); child.once('error', failPending);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error('MCP deadline: ' + method)); killOwnTree(child); }, 45000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const reply = await rpc('tools/call', { name, arguments: args });
    if (reply.error) return { rpcError: reply.error.message, raw: reply };
    const text = reply.result?.content?.find(row => row.type === 'text')?.text;
    let value; try { value = JSON.parse(text); } catch { value = { text }; }
    return { ...value, raw: reply };
  };
  return { child, rpc, call, close: () => stop(child) };
}
function ownDefinition() {
  const configPath = option('--mcp-config');
  const globalPath = path.join(process.env.KIMI_CODE_HOME, 'mcp.json');
  const config = JSON.parse(fs.readFileSync(configPath || globalPath, 'utf8'));
  const definition = config.mcpServers?.ruyi;
  check(definition && definition.command, 'own production MCP definition missing');
  check(/^[a-f0-9]{64}$/.test(definition.env?.RUYI_INTERNAL_MCP_CAP || process.env.RUYI_INTERNAL_MCP_CAP || ''), 'real execution capability missing');
  return { definition, configPath: configPath || globalPath };
}
async function exerciseCli(isNode) {
  const { definition, configPath } = ownDefinition(), work = process.cwd();
  const scenario = process.env.RUYI_LIFECYCLE_SCENARIO, reports = process.env.RUYI_LIFECYCLE_REPORTS;
  const trap = path.join(reports, scenario + (isNode ? '-node-trap' : '-main-trap'));
  const client = mcp(definition, trap), report = { scenario, isNode, cliPid: process.pid, mcpPid: client.child.pid, configPath };
  try {
    const initialized = await client.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-real-cli-launch', version: '1' } });
    check(initialized.result?.serverInfo?.name === 'ruyi', 'real MCP initialize');
    const listed = await client.rpc('tools/list', {}), names = listed.result?.tools?.map(row => row.name) || [];
    report.hasMainControls = names.includes('todo_write');
    check(report.hasMainControls === !isNode, 'main/node capability surface');
    const target = path.join(work, scenario + (isNode ? '-node.txt' : '-main.txt'));
    const write = await client.call('file_write', { path: target, content: 'SERVE_OWNED_' + scenario + (isNode ? '_NODE' : '_MAIN') });
    check(write.ok === true, 'file_write failed: ' + JSON.stringify(write));
    const checkpoints = await client.call('checkpoint_list', {});
    report.checkpoint = checkpoints.checkpoints?.find(row => row.path === target || row.paths?.includes(target));
    check(report.checkpoint && report.checkpoint.turnSeq > 0 && report.checkpoint.tool === 'file_write', 'serve checkpoint ownership');
    const scratch = await client.call('scratchpad_write', { op: 'write', key: 'relay', text: 'forbidden CLI scratchpad' });
    report.scratchDenied = scratch.ok === false && scratch.code === 'scratchpad-unavailable';
    check(report.scratchDenied, 'CLI must not become provider mainTurn');
    if (isNode) {
      const denied = await client.call('todo_write', { items: [{ text: 'NODE_MUST_NOT_CONTROL_PARENT' }] });
      report.parentControlDenied = denied.rpcError === 'internal_mcp.tool_not_allowed';
      check(report.parentControlDenied, 'node parent-control bypass');
    } else {
      const todo = await client.call('todo_write', { items: [{ text: 'SERVE_RELAY_TODO', status: 'done' }] });
      check(todo.ok && todo.count === 1, 'shared todo receipt');
      const mission = await client.call('mission_update', { goal: 'SERVE_RELAY_UPDATED_GOAL' });
      check(mission.ok && mission.mission?.goal === 'SERVE_RELAY_UPDATED_GOAL', 'shared mission receipt');
      const permission = await client.call('permission_prompt', { tool_name: 'Write', input: { file_path: path.join(work, 'not-executed.txt'), content: 'no actual CLI write' } });
      report.permissionDenied = permission.behavior === 'deny'; check(report.permissionDenied, 'permission UI receipt');
      const question = await client.call('request_user_input', { questions: [{ id: 'relay_choice', question: 'Synthetic relay choice?', options: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }] }] });
      report.questionAnswered = question.ok === true && String(question.content || '').includes('Alpha');
      check(report.questionAnswered, 'question UI receipt');
      const memory = await client.call('workbench_memory_read', { id: 'relay_full_memory' });
      report.memoryHash = digest(memory.memory?.body || ''); report.memoryChars = memory.memory?.body?.length || 0;
      check(memory.ok && report.memoryChars > 70000, 'full memory was truncated');
      const image = await client.call('file_read', { path: path.join(work, 'pixel.png'), as: 'image' });
      report.image = image.raw?.result?.content?.some(row => row.type === 'image' && row.mimeType === 'image/png' && row.data.length > 0);
      check(report.image, 'image MCP content lost');
      const node = await client.call('orchestrate_agents', { nodes: [{ id: 'real_exec_node', task: 'LIFECYCLE_NODE: exercise actual scoped MCP', engine: 'claude', role: 'relay-worker' }] });
      report.runId = node.runId; check(node.ok && report.runId, 'actual exec-node launch/envelope failed: ' + JSON.stringify(node));
    }
    report.trapAbsent = !fs.existsSync(trap); check(report.trapAbsent, 'stdio child created a data root');
    report.ok = true;
  } catch (error) {
    report.error = String(error.message); throw error;
  } finally {
    await client.close();
    fs.writeFileSync(path.join(reports, scenario + (isNode ? '-node.json' : '-main.json')), JSON.stringify(report, null, 2));
  }
  return report;
}
async function fakeClaude() {
  // Preserve actual Windows shim argv/config selection on failures that occur
  // before exerciseCli can create its report. Record token presence, never tokens.
  const selectedConfig = option('--mcp-config');
  let selectedEnv = null, configError = '';
  try { selectedEnv = JSON.parse(fs.readFileSync(selectedConfig || path.join(process.env.KIMI_CODE_HOME, 'mcp.json'), 'utf8')).mcpServers?.ruyi?.env || {}; }
  catch (error) { configError = String(error.code || error.message); }
  fs.writeFileSync(path.join(process.env.RUYI_LIFECYCLE_REPORTS, process.env.RUYI_LIFECYCLE_SCENARIO + '-claude-launch-' + process.pid + '.json'), JSON.stringify({
    argv: process.argv.slice(2), selectedConfig, configError,
    configuredCapChars: (selectedEnv?.RUYI_INTERNAL_MCP_CAP || '').length,
    inheritedCapChars: (process.env.RUYI_INTERNAL_MCP_CAP || '').length,
  }, null, 2));
  let input = '', started = false;
  const run = async () => {
    if (started) return; started = true;
    const sid = 'offline-relay-' + process.pid, emit = row => process.stdout.write(JSON.stringify(row) + '\n');
    try {
      emit({ type: 'system', subtype: 'init', session_id: sid, tools: [], model: 'offline-relay' });
      const report = await exerciseCli(input.includes('LIFECYCLE_NODE'));
      emit({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'CLI_RELAY_OK' }] } });
      emit({ type: 'result', subtype: 'success', is_error: false, result: 'CLI_RELAY_OK', session_id: sid, num_turns: 1, duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } });
      check(report.ok, 'CLI report missing');
    } catch (error) { emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(error.message), session_id: sid }); process.exitCode = 1; }
    finally { for (const child of ownedChildren) await stop(child); process.stdin.destroy(); }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text => { input += text; const end = input.indexOf('\n'); if (end >= 0 && input.trimStart().startsWith('{"type":"user"')) void run(); });
  process.stdin.once('end', () => void run()); process.stdin.on('error', () => {});
}
async function fakeKimi() {
  if (process.argv.includes('--version')) { console.log('0.37.2-offline-relay'); return; }
  if (process.argv.includes('provider')) { console.log(JSON.stringify({ providers: {}, models: {} })); return; }
  const send = row => process.stdout.write(JSON.stringify(row) + '\n');
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const reply = result => send({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'initialize') return reply({ protocolVersion: 1, agentInfo: { name: 'offline-kimi', version: '0.37.2' }, agentCapabilities: { loadSession: false, promptCapabilities: { image: true } } });
    if (msg.method === 'session/new') return reply({ sessionId: 'offline-kimi-' + process.pid, configOptions: [], modes: { currentModeId: 'yolo', availableModes: [{ id: 'default' }, { id: 'yolo' }] } });
    if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') return reply({ configOptions: [{ id: 'mode', currentValue: msg.params.modeId || msg.params.value, options: [{ value: 'default' }, { value: 'yolo' }] }] });
    if (msg.method === 'session/close') return reply({});
    if (msg.method === 'session/prompt') void (async () => {
      try { await exerciseCli(false); send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CLI_RELAY_OK' } } } }); reply({ stopReason: 'end_turn' }); }
      catch (error) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(error.message) } }); }
    })();
  });
}
function request(port, endpoint, token, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: endpoint, method: bytes ? 'POST' : 'GET', headers: { ...(token ? { 'x-wcw-token': token } : {}), ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(Error('invalid HTTP JSON')); } });
    }); req.setTimeout(45000, () => req.destroy(Error('HTTP deadline'))); req.once('error', reject); req.end(bytes);
  });
}
async function chat(port, token, sessionId) {
  const actions = [], events = [];
  await new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify({ sessionId, message: 'LIFECYCLE_MAIN: run the offline MCP relay checks' }));
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'x-wcw-token': token, 'content-type': 'application/json', 'content-length': bytes.length } }, res => {
      let buffer = ''; res.setEncoding('utf8');
      res.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { continue; } events.push(event);
        if (event.type === 'permission_request') actions.push(request(port, '/api/permission/decision', token, { requestId: event.requestId, behavior: 'deny', message: 'offline fixture denial' }));
        if (event.type === 'ask_user') actions.push(request(port, '/api/chat/answer', token, { sessionId, questionId: event.questionId || event.id, answers: [{ question: event.questions[0].question, answer: ['Alpha'] }], content: 'Synthetic relay choice?: Alpha' }));
      } }); res.once('end', resolve); res.once('error', reject);
    }); req.setTimeout(90000, () => req.destroy(Error('chat deadline'))); req.once('error', reject); req.end(bytes);
  });
  const answers = await Promise.all(actions); check(answers.every(row => row.ok), 'UI decision delivery'); return events;
}
function pixel() {
  const zlib = require('node:zlib'), crc = bytes => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = n >>> 1 ^ (n & 1 ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, checksum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function main() {
  require(path.join(LIB, 'self-isolate-home'));
  const { createRunner } = require(path.join(LIB, 'harness')), t = createRunner('INTERNAL MCP CLI LIFECYCLE');
  const { releaseEnvironment } = require(path.join(LIB, 'release-checks'));
  const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-cli-relay-lifecycle-'));
  try {
    for (const scenario of ['claude', 'kimi']) {
      const base = path.join(root, scenario), data = path.join(base, 'data'), work = path.join(base, 'work'), reports = path.join(base, 'reports');
      for (const dir of [data, work, reports]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(work, 'pixel.png'), pixel());
      const inherited = {}; for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE']) if (process.env[key]) inherited[key] = process.env[key];
      const env = { ...releaseEnvironment(path.join(base, 'home'), data, inherited), WCW_FAKE_CLAUDE: SELF, RUYI_LIFECYCLE_REPO: REPO, RUYI_LIFECYCLE_REPORTS: reports, RUYI_LIFECYCLE_SCENARIO: scenario };
      const packageRoot = path.join(base, 'npm', 'node_modules'), bin = path.join(packageRoot, '.bin'), entry = path.join(packageRoot, '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
      fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.mkdirSync(bin);
      fs.writeFileSync(entry, "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); await require(" + JSON.stringify(SELF) + ").fakeKimi();\n");
      const shim = path.join(bin, process.platform === 'win32' ? 'kimi.cmd' : 'kimi');
      fs.writeFileSync(shim, process.platform === 'win32' ? '@"' + process.execPath + '" "%~dp0\\..\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*\r\n' : '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(entry) + ' "$@"\n');
      if (process.platform !== 'win32') fs.chmodSync(shim, 0o755);
      const claudeShim = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      fs.writeFileSync(claudeShim, process.platform === 'win32' ? '@"' + process.execPath + '" "' + SELF + '" %*\r\n' : '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(SELF) + ' "$@"\n');
      if (process.platform !== 'win32') fs.chmodSync(claudeShim, 0o755);
      delete env.Path;
      env.PATH = [bin, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(env.SystemRoot || 'C:/Windows', 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
      // The legacy WCW fake seam bypasses Kimi's ACP adapter. Kimi must launch its
      // configured fake executable; its Claude node uses the configured isolated shim too.
      if (scenario === 'kimi') delete env.WCW_FAKE_CLAUDE;
      fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 7, agentCliType: scenario, kimiPath: shim, claudePath: claudeShim, model: '', engineMode: 'print', permissionMode: 'bypass', defaultWorkspace: work,
        providers: [], activeProvider: '', includeWorkbenchMcp: true, mcpCommandMode: 'node', toolLoadingMode: 'full', permissionBridge: true, autoImportClaudeCodeMcp: false, autoResumeClaudeSessions: false,
        stewardEnabledV1: false, schedulerEnabledV1: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
        agentRoleOverrides: [{ id: 'relay-worker', label: 'Relay Worker', prompt: 'Offline relay worker', toolTier: 'exec', mcpServers: ['ruyi'] }],
      }));
      const port = await require(path.join(REPO, 'dev-harness/free-port')).getFreePort();
      const server = spawn(process.execPath, [path.join(REPO, 'ruyi-workbench/app/server.js'), 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let logs = ''; for (const stream of [server.stdout, server.stderr]) { stream.setEncoding('utf8'); stream.on('data', chunk => { logs = (logs + chunk).slice(-65536); }); }
      try {
        let token = ''; const startedAt = Date.now();
        while (!token && Date.now() - startedAt < 45000) {
          check(server.exitCode === null, 'serve exited: ' + logs);
          try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8')); if (runtime.port === port && runtime.token) { await request(port, '/health'); token = runtime.token; } } catch {} if (!token) await sleep(100);
        }
        check(token, 'serve readiness');
        const body = 'FULL_MEMORY_' + '文'.repeat(70000) + '_END';
        const savedMemory = await request(port, '/api/memory', token, { cwd: work, memory: { id: 'relay_full_memory', scope: 'global', type: 'reference', name: 'Relay memory', body } });
        check(savedMemory.ok && savedMemory.memory?.id === 'relay_full_memory', 'memory seed');
        // saveMemory writes one final newline; the POST receipt omits body, so read
        // the owner's full persisted item and pin that exact canonical text first.
        const ownerMemory = await request(port, '/api/memory/item?id=relay_full_memory&scope=global&cwd=' + encodeURIComponent(work), token);
        const expectedBody = body + '\n';
        check(ownerMemory.ok && ownerMemory.memory?.body === expectedBody, 'owner memory body must equal the complete seed plus its stored final newline');
        const created = await request(port, '/api/sessions', token, { title: 'Real relay ' + scenario, cwd: work }), sid = created.session?.id; check(sid, 'session seed');
        check((await request(port, '/api/session/memories', token, { sessionId: sid, memories: [{ id: 'relay_full_memory', scope: 'global', enabled: true }] })).ok, 'memory selection');
        check((await request(port, '/api/mission', token, { sessionId: sid, action: 'start', goal: 'Original relay goal', milestones: [{ id: 'one', desc: 'offline relay work', status: 'pending' }] })).ok, 'mission seed');
        const events = await chat(port, token, sid);
        const readReport = role => {
          const file = path.join(reports, scenario + '-' + role + '.json');
          check(fs.existsSync(file), scenario + ' ' + role + ' CLI report missing after chat completion');
          return JSON.parse(fs.readFileSync(file));
        };
        const mainReport = readReport('main'), nodeReport = readReport('node');
        check(mainReport.ok && nodeReport.ok, scenario + ' actual CLI failed: main=' + (mainReport.error || 'ok') + '; node=' + (nodeReport.error || 'ok'));
        t.ok(mainReport.ok && nodeReport.ok && mainReport.cliPid !== nodeReport.cliPid && mainReport.mcpPid !== nodeReport.mcpPid, scenario + ' real main and exec-node launches use distinct actual stdio processes');
        t.ok(mainReport.hasMainControls && !nodeReport.hasMainControls && nodeReport.parentControlDenied && mainReport.scratchDenied && nodeReport.scratchDenied, scenario + ' exact execution scopes preserve parent UI/provider-only restrictions');
        t.ok(mainReport.checkpoint.turnSeq === nodeReport.checkpoint.turnSeq && mainReport.trapAbsent && nodeReport.trapAbsent
          && fs.readFileSync(path.join(work, scenario + '-main.txt'), 'utf8') === 'SERVE_OWNED_' + scenario + '_MAIN'
          && fs.readFileSync(path.join(work, scenario + '-node.txt'), 'utf8') === 'SERVE_OWNED_' + scenario + '_NODE', scenario + ' both writes/checkpoints belong to the serve parent while stdio creates no data root');
        t.ok(mainReport.permissionDenied && mainReport.questionAnswered && events.some(e => e.type === 'permission_request') && events.some(e => e.type === 'ask_user'), scenario + ' real shared permission and question receipts reach the active UI stream');
        t.ok(mainReport.memoryHash === digest(ownerMemory.memory.body) && mainReport.memoryChars === expectedBody.length && mainReport.image, scenario + ' actual full-memory text and PNG image survive stdio RPC envelopes');
        const session = (await request(port, '/api/sessions/' + encodeURIComponent(sid), token)).session;
        t.ok(session?.mission?.goal === 'SERVE_RELAY_UPDATED_GOAL' && session.todos?.length === 1 && session.backgroundJobSeen?.includes('agent:' + mainReport.runId), scenario + ' persisted business state and consumed workflow delivery receipt retain their owner');
        // Kimi's own global definition deliberately inherits a per-turn capability instead of persisting it.
        // Both node attempts and the Claude main definition support a post-close transport check.
        for (const [role, configPath] of [...(scenario === 'claude' ? [['main', mainReport.configPath]] : []), ['node', nodeReport.configPath]]) {
          const definition = JSON.parse(fs.readFileSync(configPath)).mcpServers.ruyi;
          const stale = mcp(definition, path.join(reports, 'stale-trap'), env);
          try { const denied = await stale.rpc('tools/call', { name: 'file_write', arguments: { path: path.join(work, 'stale-must-not-write.txt'), content: 'forbidden' } });
            t.ok(/^mcp_consumer\.setup_required:/.test(denied.error?.message || '') && !fs.existsSync(path.join(work, 'stale-must-not-write.txt')), scenario + ' closed actual ' + role + ' grant refuses a late mutation with the original setup receipt');
          } finally { await stale.close(); }
        }
      } catch (error) { fs.writeFileSync(path.join(base, 'serve-failure.log'), logs); throw error; }
      finally { await stop(server); }
    }
  } catch (error) { t.fail(error?.stack || String(error)); console.log('ARTIFACTS ' + root); }
  finally {
    for (const child of [...ownedChildren]) await stop(child);
    check(path.dirname(root) === temp && path.basename(root).startsWith('ruyi-cli-relay-lifecycle-'), 'cleanup path');
    if (!t.failures) fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
}
module.exports = { fakeKimi };
if (require.main === module) {
  if (process.argv.includes('--version')) console.log('1.0.0-offline-relay');
  else if (process.argv.includes('--output-format')) void fakeClaude();
  else void main().catch(error => { console.error(error); process.exitCode = 1; });
}
