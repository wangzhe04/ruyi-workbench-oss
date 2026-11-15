'use strict';
require('./lib/self-isolate-home');
// Opt-in ordinary default-permission root/provider -> real ACC -> real native input.
// One 40ms balanced middle pair in an owned passive window; deny and PRE-dispatch Stop.
// No held-state fault, rescue, keyboard/clipboard/source change, TCC change or deliberate lock.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port');
const t = createRunner('MACOS EXECUTION INPUT');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nonce = () => crypto.randomBytes(16).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = [], reports = [], attempts = [], specs = [], decisions = [], cleanups = [], caughtErrors = [];
let root, data, work, env, server, receiver, provider, binary, helper, token, port, receiverIdentity, originalSource, originalFrame, originalPoint;
let output = '', fixtureOutput = '', cleanupSafe = true;
let evidenceFD;
let halted = false;
function halt(error) { halted = true; caughtErrors.push({ at: Date.now(), error: error.stack || String(error) }); }
const app = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const jsonText = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
function check(value, label) {
  t.ok(value, label);
  if (!value) { const error = new Error('Stopped after ' + label); halt(error); throw error; }
}
async function until(read, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(25); }
  throw new Error('Timed out ' + label + '\n' + output.slice(-2000));
}
async function api(route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const value = await res.json();
  if (!res.ok) throw new Error(route + ': ' + res.status + ' ' + JSON.stringify(value));
  return value;
}
async function command(op, fields = {}) {
  const offset = reports.length, request = nonce();
  receiver.stdin.write(JSON.stringify({ op, request, ...fields }) + '\n');
  const expected = { arm: 'armed', disarm: 'disarmed' }[op] || op;
  return until(() => reports.slice(offset).find(row => row.event === 'rejected' || row.event === expected
    && (op !== 'state' || row.request === request)), 'receiver ' + op, 5000);
}
function birthCreated(birth) {
  if (!/^\d+:\d+$/.test(birth)) throw new Error('Invalid native process birth');
  const [sec, micro] = birth.split(':').map(BigInt); return sec * 1000000n + micro;
}
function identity(pid) {
  const result = cp.spawnSync(binary, ['--identity', String(pid)], { encoding: 'utf8', timeout: 3000 });
  if (result.error || result.status !== 0) throw new Error('Cannot read exact process identity ' + pid);
  const value = JSON.parse(result.stdout), processRow = snapshotProcessTable()?.find(row => row.pid === pid);
  if (!processRow || processRow.created !== birthCreated(value.birth)) throw new Error('Exact libproc birth mismatch ' + pid);
  return { ...value, ...processRow };
}
function neutral(state) {
  return state && state.hidButtons?.length === 3 && state.combinedButtons?.length === 3
    && [...state.hidButtons, ...state.combinedButtons].every(value => value === false)
    && state.keyHeld === false && state.hidModifiers === 0 && state.combinedModifiers === 0;
}
function stableTarget(state) {
  return state.frontmost === true && state.hit === true && state.geometryOK === true
    && state.pid === receiver.pid && state.birth === receiverIdentity.birth
    && state.input_source.id === originalSource.id && state.input_source.type === originalSource.type
    && ['x', 'y', 'width', 'height'].every(key => state.frame[key] === originalFrame[key])
    && state.point.x === originalPoint.x && state.point.y === originalPoint.y;
}
function safeState(report) {
  return report.journalOK === true && neutral(report.state) && report.noise === 0 && stableTarget(report.state);
}
const history = sid => fs.readFileSync(path.join(data, 'sessions', sid + '.provider.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const rows = sid => {
  const file = path.join(data, 'desktop-executions-v1/state.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)).entries.filter(row => !sid || row.sessionId === sid) : [];
};
const readCalls = (name, args, id) => ({ name: 'tool_invoke_read', args: { name: 'ai_computer_control__' + name, arguments: args }, id });
function result(messages, id) {
  const message = messages.find(row => row.role === 'tool' && row.tool_call_id === id);
  if (!message) return null;
  const value = JSON.parse(message.content); return value?.result || value;
}
function trace(row) {
  const folder = path.join(root, 'acc-data/logs/execution-receipts', row.invocationId);
  const bytes = fs.readFileSync(path.join(folder, 'events.ndjson'));
  const records = bytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const marker = JSON.parse(fs.readFileSync(path.join(folder, 'commit.json')));
  if (marker.bytes !== bytes.length || marker.sha256 !== hash(bytes) || marker.sequence !== records.length) throw new Error('Receipt committed prefix mismatch');
  return { records, marker };
}
function durableContinuation(spec, messages) {
  const saved = history(spec.sessionId), actualRows = rows(spec.sessionId);
  const toolIds = messages.filter(row => row.role === 'tool').map(row => row.tool_call_id);
  for (const row of actualRows) {
    if (row.phase !== 'returned' || !row.deliverySha256 || !row.observed?.receipt) throw new Error('Model follows unacknowledged result');
    const end = saved.findIndex((_value, end) => hash(JSON.stringify(saved.slice(0, end + 1))) === row.deliverySha256);
    if (end < 0) throw new Error('Saved provider prefix does not match delivery digest');
    const deliveredTool = saved.slice(0, end + 1).findLast(message => message.role === 'tool');
    const call = spec.calls.find(call => call.id === deliveredTool?.tool_call_id);
    if (!call || !toolIds.includes(call.id) || call.args.name !== 'ai_computer_control__' + row.toolName
      || hash(JSON.stringify(call.args.arguments)) !== row.argsSha256) throw new Error('Model lacks exact acknowledged call reply/arguments');
    const accepted = trace(row).records[0];
    if (accepted.stage !== 'acc_request_accepted' || accepted.call_id_hash !== row.callIdHash || accepted.session_id !== spec.sessionId
      || accepted.turn_seq !== row.turnSeq || accepted.acc_pid !== row.accPid || accepted.acc_worker_id !== row.accWorkerId
      || accepted.caller_args_sha256 !== row.argsSha256) throw new Error('Receipt differs from prepared actual call');
    const index = saved.findIndex(message => message.role === 'tool' && message.tool_call_id === call.id);
    if (JSON.stringify(saved[index]) !== JSON.stringify(messages.find(message => message.role === 'tool' && message.tool_call_id === call.id)))
      throw new Error('Provider reply differs from saved actual history');
  }
  return { rows: actualRows, saved, toolIds };
}
async function start() {
  port = await getFreePort(); token = '';
  server = cp.spawn(process.execPath, [app, 'serve', '--port', String(port)], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { output += value; }); server.stderr.on('data', value => { output += value; });
  await until(async () => {
    try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token) return false;
      token = runtime.token; port = runtime.port; return (await api('/health')).ok;
    } catch { return false; }
  }, 'owned service ready');
}
async function stopRoot() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  // ONLY after independent neutral observation and all actual turn drivers settled.
  await settled();
  const state = await command('state');
  if (!neutral(state.state) || !state.journalOK) { cleanupSafe = false; throw new Error('Refusing cleanup without neutral independent receiver'); }
  const table = snapshotProcessTable(), tree = table && ownDescendants(table, server.pid);
  if (!tree?.root || tree.descendants.some(row => row.pid === receiver.pid)) throw new Error('Owned cleanup topology invalid');
  const identities = [tree.root, ...tree.descendants];
  const cleanup = killOwnTree(server); cleanups.push({ identities, cleanup, neutral: state });
  if (cleanup.incomplete) throw new Error('Owned cleanup incomplete');
  await until(() => { const current = snapshotProcessTable(); return current && identities.every(row => !current.some(now => now.pid === row.pid && now.created === row.created)); }, 'every observed owned process exited');
  server = null;
}
async function settled() {
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    if (specs.some(spec => spec.started)) throw new Error('Root unavailable; cannot establish settled execution');
    return;
  }
  await until(async () => {
    const views = [];
    for (const spec of specs) views.push(await api('/api/sessions/' + spec.sessionId));
    return views.every(view => view.execution === null && view.resumable?.live !== true);
  }, 'all actual drivers settle without fault injection', 25000);
  // A neutral instant is insufficient if a native frame may still be pending.
  for (const row of rows()) {
    const records = trace(row).records;
    if (row.phase !== 'returned' || records.at(-1)?.stage !== 'acc_request_terminal'
      || records.filter(item => item.stage === 'native_prepared').some(start => !records.some(end => end.stage === 'native_terminal' && end.operation_id === start.operation_id)))
      throw new Error('Cannot prove every actual native invocation settled; preserve witnesses');
  }
}
async function decide(spec, event) {
  if (halted) throw new Error('Refusing permission decision after fixture failure');
  check(spec.permissionSeen++ === 0 && event.toolName === 'tool_invoke_exec'
    && JSON.stringify(event.input) === JSON.stringify({ name: 'ai_computer_control__macro_run', arguments: spec.macroArgs }),
  spec.label + ' exact known macro proxy is the sole permission request');
  const before = await command('state'); spec.preDecision = before;
  check(safeState(before) && before.armed === false,
    spec.label + ' independent neutral owned target/source immediately before decision');
  const native = identity(spec.native.pid);
  check(native.created === spec.native.created && native.birth === spec.native.birth, spec.label + ' target binding native worker remains the same incarnation');
  const armed = await command('arm', { nonce: spec.caseNonce, pid: native.pid, birth: native.birth }); spec.armed = armed;
  check(armed.event === 'armed' && armed.caseNonce === spec.caseNonce && armed.downs === 0 && armed.ups === 0
    && armed.receipts.length === 0 && safeState(armed), spec.label + ' passive receiver durably arms exact native process');
  // Re-read after the fsynced arm; no cancel/kill may be injected after allowing input.
  const final = await command('state'); spec.finalPreDecision = final;
  check(safeState(final) && final.armed === true && final.caseNonce === spec.caseNonce, spec.label + ' final pre-decision state is neutral and inside owned pad');
  if (halted) throw new Error('Refusing decision after concurrent fixture failure');
  let reply;
  if (spec.action === 'cancel') {
    const view = await api('/api/sessions/' + spec.sessionId);
    check(view.execution && !rows(spec.sessionId).some(row => row.toolName === 'macro_run'), 'pending cancel occurs before any macro preparation or native dispatch');
    if (halted) throw new Error('Refusing pending Stop after concurrent fixture failure');
    reply = await api('/api/stop', { sessionId: spec.sessionId, expectedExecution: view.execution });
    check(reply.stopped === true, 'pending permission exact execution Stop accepted');
  } else {
    reply = await api('/api/missions/' + spec.sessionId + '/interventions/' + event.requestId + '/decision', {
      expectedVersion: 0, idempotencyKey: spec.caseNonce, action: spec.action });
    check(reply.status === (spec.action === 'allow' ? 'allowed' : 'denied'), spec.label + ' real default-mode decision accepted');
  }
  decisions.push({ label: spec.label, event, reply });
}
async function turn(spec, message = spec.label) {
  spec.started = true;
  const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    body: JSON.stringify({ sessionId: spec.sessionId, message, cwd: work }), signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error('Turn HTTP ' + response.status);
  const events = [], tasks = []; spec.events = events;
  (spec.turns ||= []).push({ message, events });
  let buffer = ''; const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
      const event = JSON.parse(line); events.push(event);
      if (event.type === 'permission_request') tasks.push(decide(spec, event).catch(error => { halt(error); return { error }; }));
    }
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  const failure = (await Promise.all(tasks)).find(value => value?.error); if (failure) throw failure.error;
  await until(async () => (await api('/api/sessions/' + spec.sessionId)).execution === null, 'actual turn settlement');
  return events;
}
(async () => {
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_EXECUTION_INPUT_REQUIRED !== '1') { console.log('SKIP opt-in balanced actual root input receipt qualification'); return; }
    helper = process.env.RUYI_EXECUTION_CONTEXT_HELPER; const python = process.env.RUYI_ACC_PYTHON;
    if (!helper || !python || !process.env.RUYI_EXECUTION_INPUT_EVIDENCE) throw new Error('Explicit candidate helper, Python and persistent evidence destination required');
    evidenceFD = fs.openSync(process.env.RUYI_EXECUTION_INPUT_EVIDENCE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    root = fs.mkdtempSync(path.join('/tmp', 'rei-')); fs.chmodSync(root, 0o700);
    console.log('Owned raw input evidence: ' + root);
    data = path.join(root, 'data'); work = path.join(root, 'work');
    env = { ...fixtureChildEnv(), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TMPDIR: root,
      RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, RUYI_DESKTOP_EXECUTION_RECEIPTS: '1' };
    for (const dir of [data, work, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { mode: 0o700 });
    Object.assign(process.env, env);
    const prerequisite = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    if (prerequisite.error || prerequisite.status !== 0) throw new Error('Existing native readiness unavailable');
    const readyStatus = JSON.parse(prerequisite.stdout);
    proof.push({ readyStatus });
    // Native status contains both C integer readiness fields and JSON booleans.
    const ready = value => value === true || value === 1;
    check(readyStatus.ok === true && ready(readyStatus.ready) && ready(readyStatus.inputReady)
      && readyStatus.authorization === 'granted' && readyStatus.eventAuthorization === 'granted'
      && readyStatus.locked === false && readyStatus.permissionRequestsMade === false,
    'authorized unlocked real desktop available without changing TCC or lock');
    binary = path.join(root, 'receiver');
    const built = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=14.0',
      '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon', path.join(__dirname, 'fixtures/macos-balanced-input-window.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (built.error || built.status !== 0) throw new Error(built.error?.message || built.stderr);
    proof.push({ helper: { path: helper, sha256: hash(fs.readFileSync(helper)) }, receiver: { sha256: hash(fs.readFileSync(binary)) }, python, env, node: process.version });
    const instanceNonce = nonce(), journalPath = path.join(root, 'receiver.ndjson');
    receiver = cp.spawn(binary, ['--balanced-middle', journalPath, instanceNonce], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let lines = '';
    receiver.stdout.on('data', bytes => { lines += bytes; let end; while ((end = lines.indexOf('\n')) >= 0) {
      const line = lines.slice(0, end); lines = lines.slice(end + 1); reports.push(JSON.parse(line));
    } });
    receiver.stderr.on('data', bytes => { fixtureOutput += bytes; });
    const readyReport = await until(() => reports.find(row => row.event === 'ready'), 'passive receiver ready');
    receiverIdentity = identity(receiver.pid); originalSource = readyReport.state.input_source;
    originalFrame = readyReport.state.frame; originalPoint = readyReport.state.point;
    check(originalSource?.id && originalSource?.type && receiverIdentity.birth === readyReport.state.birth && safeState(readyReport)
      && readyReport.downs === 0 && readyReport.ups === 0 && readyReport.receipts.length === 0 && receiverIdentity.sid === receiver.pid,
    'fresh independent receiver has neutral input, actual TIS, private session and owned interior');
    provider = await startFakeProvider({ handler(req) { try {
      // Record EVERY entry before pairing logic, including partial tool histories/metadata calls.
      const attempt = { at: Date.now(), raw: req.raw, body: req.body, messages: req.messages, model: req.body.model, toolNames: req.tools.map(row => row.function?.name) };
      attempts.push(attempt);
      if (halted) return textFrames('FIXTURE_HALTED_AFTER_FAILURE');
      if (!req.tools.some(tool => tool.function?.name === 'tool_invoke_read')
        || !req.tools.some(tool => tool.function?.name === 'tool_invoke_exec')) return textFrames('offline metadata');
      const spec = specs.find(row => req.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(row.label)));
      if (!spec) return textFrames('offline metadata');
      attempt.label = spec.label;
      const listed = result(req.messages, spec.listId), beforeAudit = result(req.messages, spec.beforeId);
      const delivered = durableContinuation(spec, req.messages); attempt.delivery = delivered;
      if (spec.reopened) return textFrames('COLD_NO_REPLAY_COMPLETE');
      if (!listed || !beforeAudit) return toolCallFrames(spec.calls.slice(0, 2).filter(call => !result(req.messages, call.id)));
      if (!spec.macroArgs) {
        const own = listed.windows?.find(row => row.pid === receiver.pid && row.handle === readyReport.state.id);
        if (!own?.target?.ref || own.target.process_start !== receiverIdentity.birth || own.target.pid !== receiver.pid
          || !['x', 'y', 'width', 'height'].every(key => own.target.bounds[key] === readyReport.state.frame[key])) throw new Error('Admitted window target differs from independent receiver');
        const listRow = delivered.rows.find(row => row.toolName === 'list_windows'), records = trace(listRow).records;
        const prepared = records.find(row => row.stage === 'native_prepared' && row.op === 'window.list');
        if (!prepared) throw new Error('Missing admitted actual native target frame');
        spec.native = identity(prepared.worker_pid); spec.target = own.target;
        const point = readyReport.state.point;
        spec.macroArgs = { on_error: 'stop', delay_ms: 0, steps: [
          { tool: 'input_sequence', args: { target: spec.target, input_source: originalSource, pointer_profile: 'exact', events: [
            { type: 'mouse_down', at_us: 0, flags: 0, button: 2, click_state: 1, pressure: 0, delta_x: 0, delta_y: 0, ...point },
            { type: 'mouse_up', at_us: 40000, flags: 0, button: 2, click_state: 1, pressure: 0, delta_x: 0, delta_y: 0, ...point }] } },
          { tool: 'wait', args: { seconds: 0.02 } }] };
        spec.calls.push({ name: 'tool_invoke_exec', args: { name: 'ai_computer_control__macro_run', arguments: spec.macroArgs }, id: spec.macroId });
      }
      if (!result(req.messages, spec.macroId)) {
        if (spec.macroProposed) throw new Error('Refusing automatic macro proposal retry');
        spec.macroProposed = true; return toolCallFrames(spec.calls.find(call => call.id === spec.macroId).name,
          spec.calls.find(call => call.id === spec.macroId).args, spec.macroId);
      }
      if (!result(req.messages, spec.afterId)) {
        const call = readCalls('audit_tail', { n: 1000 }, spec.afterId); spec.calls.push(call); return toolCallFrames(call.name, call.args, call.id);
      }
      return textFrames('BALANCED_INPUT_CHAIN_COMPLETE');
    } catch (error) { halt(error); throw error; }
    } });
    const acc = path.resolve(__dirname, '../mcp/ai-computer-control');
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 9, permissionMode: 'default', permissionTimeoutMs: 20000,
      defaultWorkspace: work, providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url,
        apiKey: 'synthetic-input-fixture', model: 'fake-model' }], activeProvider: 'fake',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
      allowDesktopTools: true, allowCommandTools: true, bridgeExternalToolsToProvider: true, desktopMcp: { enabled: false, autodetect: false },
      externalMcpServers: [{ id: 'ai-computer-control', enabled: true, command: python, args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: acc,
        env: { ...env, PYTHONPATH: path.join(acc, 'src'), PYTHONDONTWRITEBYTECODE: '1', WCW_DATA_DIR: path.join(root, 'acc-data'),
          ACC_TOOLSETS: 'desktop,macro', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } }] }));
    await start();
    const table = snapshotProcessTable(), supervised = ownDescendants(table, server.pid), topology = identity(server.pid);
    proof.push({ topology, receiverIdentity, supervised });
    check(receiverIdentity.sid !== topology.sid && receiverIdentity.pgid !== topology.pgid && receiverIdentity.ppid === process.pid
      && !supervised.descendants.some(row => row.pid === receiver.pid), 'independent receiver is outside actual root supervised tree, group and session');
    for (const action of ['allow', 'deny', 'cancel']) {
      const spec = { label: 'BALANCED_INPUT_' + action.toUpperCase() + '_' + nonce(), action, caseNonce: nonce(), permissionSeen: 0,
        listId: 'list_' + action, beforeId: 'audit_before_' + action, macroId: 'macro_' + action, afterId: 'audit_after_' + action };
      spec.calls = [readCalls('list_windows', {}, spec.listId), readCalls('audit_tail', { n: 1000 }, spec.beforeId)];
      spec.sessionId = (await api('/api/sessions', { title: spec.label, cwd: work })).session.id; specs.push(spec);
      const events = await turn(spec);
      // A normal 40ms pair/finally must settle on its own. No Stop/kill/release injection here.
      const after = await until(async () => { const row = await command('state'); return neutral(row.state) && row; }, 'independent post-input neutral', 5000);
      spec.after = after; check(safeState(after) && spec.permissionSeen === 1 && after.caseNonce === spec.caseNonce,
        action + ' actual receiver returns to neutral with no foreign input or source change');
      const actualRows = rows(spec.sessionId), saved = history(spec.sessionId);
      spec.rows = actualRows; spec.saved = saved; spec.traces = actualRows.map(row => ({ invocationId: row.invocationId, ...trace(row) }));
      const effects = events.find(row => row.type === 'turn_summary')?.irreversible;
      if (action === 'allow') {
        const macro = result(saved, spec.macroId), macroRow = actualRows.find(row => row.toolName === 'macro_run');
        check(!events.some(row => row.type === 'error') && JSON.stringify(events).includes('BALANCED_INPUT_CHAIN_COMPLETE')
          && macro?.completed === 2 && macro.failed === 0 && macroRow?.phase === 'returned' && macroRow.deliverySha256,
        'allowed real macro and wait finish with strict receipt and durable saved result');
        const records = trace(macroRow).records, entered = records.filter(row => row.stage === 'native_entered');
        const prepared = records.find(row => row.stage === 'native_prepared' && row.op === 'input.sequence');
        const terminal = prepared && records.find(row => row.stage === 'native_terminal' && row.operation_id === prepared.operation_id);
        check(entered.length === 1 && entered[0].op === 'input.sequence' && entered[0].worker_pid === spec.native.pid
          && entered[0].frame_sha256 === prepared?.frame_sha256 && entered[0].frame_id === prepared.frame_id
          && records.some(row => row.stage === 'native_continue_sent' && row.operation_id === prepared.operation_id)
          && terminal?.ok === true && terminal.action_sent === true && terminal.acted === true && records.at(-1).stage === 'acc_request_terminal',
        'actual native input has exact prepared/entered/continue/terminal frame on target-list worker');
        check(after.downs === 1 && after.ups === 1 && after.receipts.length === 2 && after.receipts.every((receipt, index) => receipt.matched === true
          && receipt.sourcePID === spec.native.pid && receipt.sourceBirth === spec.native.birth && receipt.button === 2
          && receipt.down === (index === 0) && receipt.up === (index === 1) && receipt.flags === 0
          && receipt.x === spec.macroArgs.steps[0].args.events[index].x && receipt.y === spec.macroArgs.steps[0].args.events[index].y),
        'independent fsynced receiver observes exactly one matching middle down/up from birth-verified native worker');
        const received = reports.filter(row => row.event === 'input' && row.caseNonce === spec.caseNonce);
        check(received.length === 2 && received.every(row => row.armed === true && row.journalOK === true && row.noise === 0
          && stableTarget(row.state) && stableTarget(row.armState)
          && row.state.keyHeld === false && row.state.hidModifiers === 0 && row.state.combinedModifiers === 0
          && [row.state.hidButtons, row.state.combinedButtons].every(buttons => buttons.length === 3 && !buttons[0] && !buttons[1])
          && row.received.timestamp >= row.armStart && row.received.timestamp <= row.armDeadline)
          && received[1].received.cgTimestamp > received[0].received.cgTimestamp,
        'every independent input witness keeps frozen geometry, foreground, hit, TIS and bounded arm interval');
        const sequence = macro.results?.[0]?.result;
        check(sequence?.action_sent === true && sequence.acted === true && sequence.event_count === 2 && sequence.verification === 'events_posted',
          'actual saved input_sequence result reports exactly two posted events');
        const auditBefore = result(saved, spec.beforeId), auditAfter = result(saved, spec.afterId);
        check(['macro_run', 'input_sequence'].every(tool => auditAfter.records.slice(auditBefore.records.length).some(row => row.tool === tool && row.ok === true)),
          'genuine admitted audit reads retain successful macro and input_sequence');
        check(Array.isArray(effects) && effects.length === 1 && effects[0].name === 'ai_computer_control__input_sequence'
          && effects[0].effectStatus === 'reported' && effects[0].step === 0 && effects[0].callId === spec.macroId
          && effects[0].parentTool === 'ai_computer_control__macro_run', 'same-turn irreversible ledger attributes only input step zero to actual macro call');
        spec.effectSnapshot = (await api('/api/missions/' + spec.sessionId)).snapshot;
        check(spec.effectSnapshot.irreversible.total === 1 && spec.effectSnapshot.irreversible.items.length === 1
          && spec.effectSnapshot.irreversible.items[0].callId === spec.macroId
          && spec.effectSnapshot.irreversible.items[0].step === 0, 'actual mission API retains the same input effect and macro attribution');
      } else {
        check(after.downs === 0 && after.ups === 0 && after.receipts.length === 0 && !actualRows.some(row => row.toolName === 'macro_run')
          && !spec.traces.some(trace => trace.records.some(row => row.op === 'input.sequence')), action + ' performs no input preparation, native dispatch or receiver effect');
        check(Array.isArray(effects) && effects.length === 0, action + ' reports no irreversible effect');
        const pending = await api('/api/interventions'); check(pending.pending?.length === 0, action + ' leaves no live permission request');
      }
      check(actualRows.every(row => row.phase === 'returned' && row.deliverySha256), action + ' all dispatched reads retain durable ACKs');
      check((await command('disarm')).event === 'disarmed', action + ' receiver disarms only while neutral');
      proof.push({ spec });
    }
    const allowed = specs[0], beforeCold = rows(), beforeReports = reports.filter(row => row.event === 'input').length;
    await stopRoot(); await start(); allowed.reopened = true;
    const count = attempts.length, cold = await turn(allowed, allowed.label + ' explicit new request after cold reopen');
    const afterCold = rows(), coldState = await command('state');
    const coldSnapshot = (await api('/api/missions/' + allowed.sessionId)).snapshot;
    proof.push({ cold, coldState, beforeCold, afterCold, coldSnapshot });
    check(!cold.some(row => row.type === 'error') && JSON.stringify(cold).includes('COLD_NO_REPLAY_COMPLETE') && attempts.length === count + 1
      && JSON.stringify(afterCold.map(row => [row.invocationId, row.deliverySha256, row.phase])) === JSON.stringify(beforeCold.map(row => [row.invocationId, row.deliverySha256, row.phase]))
      && reports.filter(row => row.event === 'input').length === beforeReports && neutral(coldState.state), 'cold actual service retains exact ACKs and admits explicit new model request without input replay');
    check(coldSnapshot.irreversible.total === 1 && coldSnapshot.irreversible.items.length === 1
      && coldSnapshot.irreversible.items[0].callId === allowed.macroId && coldSnapshot.irreversible.items[0].step === 0,
    'actual cross-turn fold and cold mission API retain one input effect without duplication');
    const durable = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse);
    check((fs.statSync(journalPath).mode & 0o777) === 0o600 && durable.length === reports.length
      && durable.every((row, index) => row.sequence === index + 1 && row.instanceNonce === instanceNonce && JSON.stringify(row) === JSON.stringify(reports[index])),
    'independent receiver stdout exactly matches bounded private fsynced journal');
    check(reports.filter(row => row.event === 'armed').length === 3 && new Set(reports.filter(row => row.event === 'armed').map(row => row.caseNonce)).size === 3
      && reports.filter(row => row.event === 'input').length === 2 && reports.filter(row => row.event === 'input').every(row => row.caseNonce === allowed.caseNonce),
    'three fresh observer intervals contain only the single allowed pair');
  } catch (error) { halt(error); t.fail(error.stack || String(error)); }
  finally {
    if (root) {
      halted = true;
      try {
        // Preserve armed observation until all drivers and all native receipts have settled.
        await settled();
        if (receiver && receiver.exitCode === null) {
          const state = await until(async () => { const row = await command('state'); return neutral(row.state) && row; }, 'cleanup independent neutral', 5000);
          if (!state.journalOK) throw new Error('Independent receiver evidence failed');
          if (state.armed) await command('disarm');
        }
        await stopRoot();
        if (receiver && receiver.exitCode === null) {
          const seal = await command('quit');
          check(seal.event === 'quit' && seal.journalOK === true && neutral(seal.state), 'receiver final healthy fsync ACK precedes normal exit');
          await until(() => receiver.exitCode !== null, 'passive receiver normal exit', 5000);
          const durable = fs.readFileSync(path.join(root, 'receiver.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
          check(JSON.stringify(durable) === JSON.stringify(reports) && durable.at(-1).event === 'quit', 'final independent durable journal includes every ACK through healthy seal');
        }
      } catch (error) { cleanupSafe = false; halt(error); t.fail('cleanup withheld: ' + error.message); }
      if (provider && cleanupSafe) await provider.close();
      if (evidenceFD !== undefined) {
        fs.writeFileSync(evidenceFD, JSON.stringify(JSON.parse(jsonText({ scope: 'ordinary balanced-only root default-permission input chain; no held faults/rescue/fullP5 acceptance', root, cleanupSafe,
          proof, specs, reports, attempts, decisions, cleanups, caughtErrors, output, fixtureOutput })), null, 2));
        fs.fsyncSync(evidenceFD); fs.closeSync(evidenceFD); evidenceFD = undefined;
      }
      // Preserve every raw receipt, audit, saved history and receiver journal, even on failure.
      if (!cleanupSafe) {
        console.log('UNRESOLVED owned live state preserved at ' + root);
        // Retain the running harness/provider and owned witnesses, including their control pipes.
      }
    }
    if (evidenceFD !== undefined) fs.closeSync(evidenceFD);
    t.done();
  }
})();
