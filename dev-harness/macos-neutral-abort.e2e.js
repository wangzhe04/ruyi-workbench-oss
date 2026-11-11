'use strict';
require('./lib/self-isolate-home');
// Opt-in calibration: wait-only macro, root-only SIGKILL, no keyboard or pointer dispatch.
// Observes process cleanup and raw restart state. This is NOT held-input hard-abort acceptance.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { snapshotProcessTable, ownDescendants, killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('MACOS NEUTRAL ABORT');
const workbench = path.resolve(__dirname, '../ruyi-workbench'), acc = path.resolve(__dirname, '../mcp/ai-computer-control');
const evidence = process.env.RUYI_P5_ABORT_EVIDENCE;
const reports = [], events = [], calls = [], cleanups = [], observations = [], samples = [], snapshots = [];
const owned = new Map();
let root, env, data, work, accData, helper, receiver, server, provider, port, token = '', spec, sessionId, fault, restart;
let streamTask, failure, retained = false, dispatchEnabled = true, streamStarted, receiverBinary, helperHash;
let faultRows = [];
const serviceOutput = [], archiveErrors = [];
const fieldsEqual = (a, b, keys) => keys.every(key => a?.[key] === b?.[key]);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const serial = row => ({ ...row, created: String(row.created) });
const alive = child => child && child.exitCode === null && child.signalCode === null;
function check(value, label) { t.ok(value, label); if (!value) throw new Error('Stopped after failed assertion: ' + label); }
async function until(read, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Timed out: ' + label);
}
function tree(child, label) {
  if (!alive(child)) throw new Error('Owned root already exited: ' + label);
  const table = snapshotProcessTable(), result = table && ownDescendants(table, child.pid);
  if (!result?.root || result.root.ppid !== process.pid) throw new Error('Owned birth identity missing: ' + label);
  const rows = [result.root, ...result.descendants];
  for (const row of rows) owned.set(row.pid + '/' + row.created, row);
  samples.push({ label, wall_ms: Date.now(), rows: rows.map(serial) });
  return rows;
}
async function gone(rows, label) {
  if (!rows?.length) throw new Error('Cannot prove empty process set exited');
  await until(() => { const current = snapshotProcessTable(); return current && rows.every(prior => !current.some(row => row.pid === prior.pid && row.created === prior.created)); }, label, 10000);
}
async function state(label) {
  const offset = reports.length; receiver.stdin.write('state\n');
  const value = await until(() => reports.slice(offset).find(row => row.event === 'state'), label);
  observations.push({ label, ...value }); return value;
}
function neutral(value) { return !value.hidLeft && !value.combinedLeft && !value.hidModifiers && !value.combinedModifiers && value.downs === value.ups; }
async function request(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-wcw-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const json = await response.json(); return { status: response.status, json };
}
async function invoke(name, args = {}, tier = 'read') {
  const reply = await request('POST', '/api/tools/tool_invoke_' + tier, { name: 'ai_computer_control__' + name, arguments: args });
  const result = reply.json.result;
  calls.push({ name, status: reply.status, result: name === 'list_windows' && result?.windows
    ? { ...result, windows: result.windows.filter(row => row.pid === receiver.pid), observedWindowCount: result.windows.length } : result });
  if (reply.status !== 200 || !result) throw new Error('Tool entry failed: ' + name);
  return result;
}
function durable(label) {
  // Only this isolated fixture's sessions and audit logs; exclude runtime tokens/config/real user files.
  const rows = [];
  function visit(base, prefix, directory = '') {
    const current = path.join(base, directory); if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Unexpected durable symlink');
      const rel = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(base, prefix, rel);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(path.join(base, rel));
        if (bytes.length > 8 * 1024 * 1024) throw new Error('Unexpected unbounded fixture record');
        rows.push({ path: path.join(prefix, rel), bytes: bytes.length, sha256: sha(bytes) });
        if (evidence) { const target = path.join(evidence, label, prefix, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
      }
    }
  }
  visit(path.join(data, 'sessions'), 'sessions'); visit(path.join(data, 'logs'), 'node-logs'); visit(path.join(accData, 'logs'), 'acc-logs');
  snapshots.push({ label, wall_ms: Date.now(), nonAtomicCrossFileSnapshot: true, files: rows }); return rows;
}
async function startService(label) {
  port = await getFreePort(); token = '';
  server = cp.spawn(process.execPath, [path.join(workbench, 'app/server.js'), 'serve', '--port', String(port)], {
    env: { ...process.env, ...env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, RUYI_MACOS_AUTOMATION_HELPER: helper },
    cwd: workbench, stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', error => { failure ||= error; });
  for (const [channel, pipe] of [['stdout', server.stdout], ['stderr', server.stderr]]) {
    const output = path.join(evidence, label.replaceAll(' ', '-') + '-' + channel + '.txt');
    fs.mkdirSync(evidence, { recursive: true });
    const descriptor = fs.openSync(output, 'wx');
    const record = { label, channel, path: path.basename(output), startedAt: Date.now(), descriptor };
    serviceOutput.push(record);
    pipe.on('data', bytes => {
      try { fs.writeSync(descriptor, bytes); }
      catch (error) { record.archiveError = error.message; archiveErrors.push({ label, channel, error: error.message }); failure ||= error; }
    });
    pipe.once('close', () => {
      try { fs.closeSync(descriptor); }
      catch (error) { record.archiveError = error.message; archiveErrors.push({ label, channel, error: error.message }); failure ||= error; }
      record.closedAt = Date.now();
    });
  }
  const birth = tree(server, label)[0];
  await until(async () => {
    if (failure) throw failure;
    try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token || !runtime.port) return false;
      port = runtime.port; token = runtime.token; return (await request('GET', '/health')).status === 200;
    } catch { return false; }
  }, label + ' health');
  return birth;
}
async function stream() {
  streamStarted = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    body: JSON.stringify({ sessionId, message: spec.label, cwd: work }), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error('Ordinary session stream failed');
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
      const event = JSON.parse(line); events.push(event);
      if (event.type === 'permission_request') {
        if (!dispatchEnabled || events.filter(row => row.type === 'permission_request').length !== 1) throw new Error('Unexpected extra permission request');
        const decision = await request('POST', '/api/missions/' + sessionId + '/interventions/' + event.requestId + '/decision', {
          expectedVersion: 0, idempotencyKey: spec.label, action: 'allow' });
        calls.push({ name: 'permission', decision });
        if (decision.status !== 200 || decision.json.status !== 'allowed') throw new Error('Actual permission was not allowed');
      }
    }
  }
}
async function stopOwned(child, label) {
  if (!alive(child)) return;
  const rows = tree(child, label);
  if (child === receiver) { receiver.stdin.write('quit\n'); await until(() => !alive(receiver), 'receiver graceful exit', 5000); cleanups.push({ label, graceful: true }); }
  else { const receipt = killOwnTree(child); cleanups.push({ label, receipt }); if (receipt.incomplete || receipt.skipped) throw new Error('Incomplete cleanup receipt'); }
  await gone(rows, label + ' birth identities gone');
}
async function cleanupFaultRemnants() {
  if (!faultRows.length) return;
  const current = snapshotProcessTable(); if (!current) throw new Error('Cannot inspect original fault identities');
  const remaining = faultRows.filter(prior => current.some(row => row.pid === prior.pid && row.created === prior.created));
  if (!remaining.length) return;
  retained = true; t.fail('product left original observed process identities; separate external cleanup follows');
  const intervention = { label: 'original fault remnants', externalIntervention: true, original: remaining.map(serial), signals: [] };
  cleanups.push(intervention);
  // No input is dispatched by this fixture. Each original identity is rechecked before each signal.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const prior of [...remaining].reverse()) {
      const now = snapshotProcessTable()?.find(row => row.pid === prior.pid && row.created === prior.created);
      if (!now) continue;
      try { process.kill(prior.pid, signal); intervention.signals.push({ pid: prior.pid, created: String(prior.created), signal, wall_ms: Date.now() }); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (signal === 'SIGTERM') await new Promise(resolve => setTimeout(resolve, 500));
  }
  await gone(remaining, 'separately cleaned original fault remnants');
}
(async () => {
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_P5_ABORT_REQUIRED !== '1') { console.log('SKIP opt-in neutral Mac root-abort calibration'); return; }
    if (!evidence) throw new Error('Explicit evidence directory required for fault calibration');
    root = fs.mkdtempSync('/tmp/p5abort-'); work = path.join(root, 'work'); data = path.join(root, 'data'); accData = path.join(root, 'acc');
    env = { ...fixtureChildEnv(), TMPDIR: root, HOME: path.join(root, 'h'), USERPROFILE: path.join(root, 'h'),
      APPDATA: path.join(root, 'a'), LOCALAPPDATA: path.join(root, 'l'), WCW_SESSION_ID: '', WCW_DATA_DIR: accData };
    for (const dir of [work, data, accData, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
    helper = process.env.RUYI_P5_ABORT_HELPER || path.join(workbench, 'runtime/macos/ruyi-automation-helper');
    helperHash = sha(fs.readFileSync(helper));
    const probe = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    const status = JSON.parse(probe.stdout);
    check(probe.status === 0 && status.ready && status.inputReady && status.locked === false, 'actual helper has unlocked capture/input prerequisites');
    const binary = path.join(root, 'receiver'); receiverBinary = binary;
    const build = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=14.0',
      '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon', path.join(__dirname, 'fixtures/macos-abort-window.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (build.status !== 0) throw new Error(build.stderr);
    receiver = cp.spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    receiver.on('error', error => { failure ||= error; }); receiver.stdin.on('error', error => { failure ||= error; }); receiver.stderr.resume();
    let buffer = '';
    receiver.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) {
      try { reports.push(JSON.parse(buffer.slice(0, end))); } catch (error) { failure ||= error; } buffer = buffer.slice(end + 1);
    } });
    tree(receiver, 'receiver birth');
    const ready = await until(() => { if (failure) throw failure; return reports.find(row => row.event === 'ready'); }, 'receiver ready');
    check(ready.geometryOK && ready.frontmost && ready.pid === receiver.pid && neutral(ready) && ready.otherInput === 0 && ready.receipts.length === 0,
      'owned receiver begins foreground with neutral HID/combined left and modifiers');
    provider = await startFakeProvider({ handler(req) {
      if (!dispatchEnabled || !req.tools?.some(tool => tool.function?.name === 'tool_invoke_exec')) return textFrames('fixture metadata');
      if (!spec || spec.sent || !JSON.stringify(req.messages.filter(row => row.role === 'user').at(-1)?.content).includes(spec.label)) return textFrames('fixture turn complete');
      spec.sent = true;
      return toolCallFrames('tool_invoke_exec', { name: 'ai_computer_control__macro_run', arguments: spec.args }, spec.callId);
    } });
    const python = process.env.RUYI_ACC_PYTHON || path.join(acc, '.venv/bin/python');
    const config = { configSchema: require('../ruyi-workbench/app/server').CONFIG_SCHEMA, engineMode: 'interactive', permissionMode: 'default',
      permissionTimeoutMs: 15000, defaultWorkspace: work, providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url,
        apiKey: 'synthetic-abort-key', model: 'fake-model' }], activeProvider: 'fake', allowDesktopTools: true, allowCommandTools: true,
      bridgeExternalToolsToProvider: true, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
      schedulerEnabledV1: false, stewardEnabledV1: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [{
        id: 'ai-computer-control', enabled: true, command: python, args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: acc,
        env: { ...env, PYTHONPATH: path.join(acc, 'src'), ACC_TOOLSETS: 'desktop,macro', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } }] };
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config, null, 2));
    const birth = await startService('initial service');
    const listed = await invoke('list_windows');
    const target = listed.windows.find(row => row.pid === receiver.pid && row.handle === ready.id)?.target;
    check(target && JSON.stringify(ready.input_source) !== '{}', 'real ACC binds owned target and actual current input source without changing it');
    const created = await request('POST', '/api/sessions', { title: 'P5 neutral hard-abort calibration', cwd: work });
    sessionId = created.json.session?.id; if (created.status !== 200 || !sessionId) throw new Error('Session missing');
    spec = { label: 'P5_NEUTRAL_ABORT_' + crypto.randomBytes(8).toString('hex'), callId: 'call_neutral_abort',
      args: { delay_ms: 0, steps: [{ tool: 'wait', args: { seconds: 30 } }] } };
    streamTask = stream().then(() => ({ ended: true }), error => ({ error: error.message }));
    await until(() => events.some(row => row.type === 'permission_request') && calls.some(row => row.name === 'permission'), 'allowed real wait-only macro');
    const audit = (await invoke('audit_tail', { n: 100 })).records;
    const beforeKill = await state('before root kill');
    check(neutral(beforeKill) && beforeKill.downs === 0 && beforeKill.ups === 0 && beforeKill.otherInput === 0
      && beforeKill.geometryOK && beforeKill.frontmost && fieldsEqual(beforeKill.frame, ready.frame, ['x','y','width','height'])
      && fieldsEqual(beforeKill.input_source, ready.input_source, ['id','type']),
    'wait-only macro has no receiver input and remains neutral before root-only fault');
    const pending = await request('GET', '/api/sessions/' + sessionId);
    check(pending.json.execution !== null && pending.json.execution !== undefined && !events.some(row => row.type === 'tool_result')
      && events.filter(row => row.type === 'permission_request').length === 1
      && !audit.some(row => ['input_sequence', 'macro_run', 'mouse_click', 'focus_window'].includes(row.tool)), 'enclosing wait-only macro remains pending with no input or final macro audit');
    const rows = tree(server, 'pre-fault full owned topology');
    const topology = rows.map(row => {
      const identity = cp.spawnSync(receiverBinary, ['--identity', String(row.pid)], { encoding: 'utf8', timeout: 1500 });
      const ps = cp.spawnSync('/bin/ps', ['-ww', '-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1500 });
      const now = snapshotProcessTable()?.find(item => item.pid === row.pid && item.created === row.created);
      if (!now || identity.status !== 0 || ps.status !== 0) throw new Error('Topology birth identity changed');
      return { ...serial(row), ...JSON.parse(identity.stdout), command: ps.stdout.trim() };
    });
    const native = topology.find(row => row.command === helper + ' --input-session');
    const pythonRow = native && topology.find(row => row.pid === native.ppid && /ai_computer_control.server/.test(row.command));
    const primary = pythonRow && topology.find(row => row.pid === pythonRow.ppid && /--supervise-v2/.test(row.command));
    const guardian = primary && topology.find(row => row.pid === primary.ppid && /--supervise-v2/.test(row.command));
    check(rows[0].pid === birth.pid && rows[0].created === birth.created && !rows.some(row => row.pid === receiver.pid)
      && guardian?.ppid === birth.pid && [native, pythonRow, primary, guardian].every(row => row && row.pgid === guardian.pid && row.sid === guardian.pid)
      && ready.pgid !== guardian.pgid, 'birth-verified root guardian primary ACC native chain excludes external receiver from supervised group');
    durable('pre-kill');
    // There is no input step anywhere in the macro; the fault must still occur within its wait.
    const finalNeutral = await state('immediately before fault');
    const latest = await request('GET', '/api/sessions/' + sessionId);
    const current = snapshotProcessTable()?.find(row => row.pid === birth.pid && row.created === birth.created);
    const elapsedMs = performance.now() - streamStarted;
    if (failure || archiveErrors.length || !current || !alive(server) || !neutral(finalNeutral) || finalNeutral.downs !== 0 || finalNeutral.ups !== 0 || finalNeutral.receipts.length !== 0
      || finalNeutral.otherInput !== 0 || !finalNeutral.geometryOK || !finalNeutral.frontmost
      || !fieldsEqual(finalNeutral.frame, ready.frame, ['x','y','width','height'])
      || !fieldsEqual(finalNeutral.input_source, ready.input_source, ['id','type'])
      || latest.json.execution == null || events.some(row => row.type === 'tool_result') || elapsedMs >= 15000) throw new Error('Fault precondition changed or wait deadline expired');
    fault = { at: Date.now(), root: serial(birth), topology, before: finalNeutral, injectedSignal: 'SIGKILL', scope: 'root-only', audit, pending: latest.json, elapsedMs };
    faultRows = rows;
    process.kill(server.pid, 'SIGKILL'); // Intentional fault injection; never replace with tree/group cleanup.
    await until(() => !alive(server), 'root actual exit', 5000);
    fault.exitCode = server.exitCode; fault.signalCode = server.signalCode;
    check(server.signalCode === 'SIGKILL' && server.exitCode === null, 'only original owned Workbench root exits by injected SIGKILL');
    await gone(rows, 'original observed guardian ACC native identities gone'); fault.observedGoneAt = Date.now();
    check(true, 'original observed supervised process birth identities exit without external child signals');
    fault.stream = await streamTask;
    const afterKill = await state('after root kill');
    check(neutral(afterKill) && afterKill.downs === 0 && afterKill.ups === 0 && afterKill.otherInput === 0,
      'root-abort calibration keeps neutral state with zero pointer or keyboard input');
    durable('post-kill');
    // Restart exact isolated data with all automatic activity disabled; issue GET only, no chat/replay.
    dispatchEnabled = false; const providerCount = provider.requests.length;
    await startService('read-only restart');
    const view = await request('GET', '/api/sessions/' + sessionId);
    restart = { view, providerCountBefore: providerCount, providerCountAfter: provider.requests.length };
    durable('post-restart');
    check(view.status === 200 && view.json.execution === null && view.json.resumable?.live !== true,
      'same isolated session loads after restart with no active execution');
    const afterRestart = await state('after read-only restart');
    check(neutral(afterRestart) && afterRestart.downs === 0 && afterRestart.ups === 0 && afterRestart.otherInput === 0
      && provider.requests.length === providerCount, 'GET-only restart does not replay macro or request another model turn');
    // Observe and archive the actual durable classification; do not call missing macro receipts a gate pass.
    restart.scope = 'Calibration only; inspect raw durable records for missing/inaccurate invocation attribution before any held-state fault.';
  } catch (error) { failure ||= error; t.fail(error.stack || String(error)); }
  finally {
    dispatchEnabled = false;
    try { await stopOwned(server, 'final service cleanup'); } catch (error) { retained = true; t.fail(error.message); }
    try { await cleanupFaultRemnants(); } catch (error) { retained = true; t.fail(error.message); }
    try { if (provider) await provider.close(); } catch (error) { retained = true; t.fail('provider cleanup: ' + error.message); }
    try { await stopOwned(receiver, 'external receiver cleanup'); }
    catch (error) {
      retained = true; t.fail(error.message);
      if (alive(receiver)) {
        try {
          const rows = tree(receiver, 'receiver fallback birth');
          const receipt = killOwnTree(receiver); cleanups.push({ label: 'receiver fallback', receipt });
          if (receipt.incomplete || receipt.skipped) throw new Error('Incomplete receiver fallback cleanup receipt');
          await gone(rows, 'receiver fallback exit');
        } catch (fallbackError) { t.fail(fallbackError.message); }
      }
    }
    if (root) {
      try { if (!owned.size) throw new Error('No owned birth identities'); await gone([...owned.values()], 'all observed owned identities gone'); t.ok(true, 'all observed calibration and restart process birth identities exit'); }
      catch (error) { retained = true; t.fail(error.message); }
      try { await until(() => serviceOutput.every(row => row.closedAt), 'service output pipes closed', 5000); }
      catch (error) { retained = true; t.fail(error.message); }
      try { if (data) durable('terminal'); } catch (error) { retained = true; archiveErrors.push({ label: 'terminal snapshot', error: error.message }); t.fail(error.message); }
      let finalHelperHash;
      try { finalHelperHash = sha(fs.readFileSync(helper)); if (finalHelperHash !== helperHash) throw new Error('Helper changed during calibration'); }
      catch (error) { retained = true; archiveErrors.push({ label: 'final helper hash', error: error.message }); t.fail(error.message); }
      if (archiveErrors.length) { retained = true; t.fail('Raw archive errors are preserved; calibration is incomplete'); }
      const result = {
        scope: 'Neutral root-only SIGKILL calibration during a real wait-only macro; no input was dispatched. No held-state fault, rescue input, clipboard, TCC/lock or App acceptance.',
        helper, serviceOutput: serviceOutput.map(({ descriptor: _fd, ...row }) => row), helperSha256: helperHash, finalHelperSha256: finalHelperHash,
        sessionId, spec, reports, events, calls, observations, samples, snapshots, fault, restart, cleanups, archiveErrors,
        failures: t.failures, failure: failure?.message, retainedRoot: retained || failure ? root : null };
      try { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n'); }
      catch (error) {
        retained = true; t.fail('Terminal report archive failed: ' + error.message);
        try { fs.writeFileSync(path.join(root, 'terminal-incomplete.json'), JSON.stringify({ ...result, terminalArchiveError: error.message }, null, 2) + '\n'); }
        catch (fallbackError) { t.fail('Terminal fallback report failed: ' + fallbackError.message); }
        console.log('Retained calibration evidence at ' + root);
      }
      if (!retained && !failure) fs.rmSync(root, { recursive: true, force: true });
    }
    t.done();
  }
})();
