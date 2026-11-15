'use strict';
require('./lib/self-isolate-home');
// Opt-in real Mac receiver + real ACC. Only the model provider is an in-process offline fixture.
// Exercise actual missing-helper readiness, live hidden registry and normal-entry master switches.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('MACOS NATIVE READINESS');
const workbench = path.resolve(__dirname, '../ruyi-workbench');
const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
const evidence = process.env.RUYI_P5_READINESS_EVIDENCE;
const reports = [], calls = [], turns = [], decisions = [], checkpoints = [], cleanups = [];
let cleanupSafe = true;
let root, work, data, helper, python, receiver, server, provider, serverIdentity, port, token = '', seeded = false;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function until(read, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out: ' + label);
}
async function command(value) {
  const offset = reports.length; receiver.stdin.write(value + '\n');
  return until(() => reports.slice(offset).find(row => row.event === value), 'receiver ' + value);
}
async function request(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-wcw-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const json = await response.json();
  return { status: response.status, json };
}
async function invoke(name, args = {}, tier = 'read') {
  const reply = await request('POST', '/api/tools/tool_invoke_' + tier, { name: 'ai_computer_control__' + name, arguments: args });
  const result = reply.json.result;
  const logged = name === 'list_windows' && result?.windows ? { ...result, windows: result.windows.filter(row => row.pid === receiver?.pid), observedWindowCount: result.windows.length } : result;
  calls.push({ name, args, status: reply.status, result: logged });
  if (reply.status !== 200 || !result) throw new Error('Invoke envelope ' + name + ': ' + JSON.stringify(reply));
  return result;
}
async function session(title) {
  const created = await request('POST', '/api/sessions', { title, cwd: work });
  if (created.status !== 200 || !created.json.session?.id) throw new Error('Cannot create an actual test session');
  return created.json.session.id;
}
async function idle(id) {
  return until(async () => {
    const value = await request('GET', '/api/sessions/' + id);
    return value.json.execution === null && value.json.resumable?.live !== true && value.json;
  }, 'real session settlement');
}
function toolResult(events) {
  const row = events.filter(event => event.type === 'tool_result').at(-1);
  let content = row?.content;
  if (typeof content === 'string') { try { content = JSON.parse(content); } catch {} }
  return { event: row, outer: content, result: content?.result || content };
}
async function turn(spec, action) {
  spec.sessionId = await session(spec.label);
  spec.callId = 'call_' + spec.label;
  const events = [], decisionTasks = [];
  const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    body: JSON.stringify({ sessionId: spec.sessionId, message: spec.label, cwd: work }), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Session stream failed ' + response.status + ': ' + await response.text());
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      const event = JSON.parse(line); events.push(event);
      if (event.type === 'permission_request') {
        const decide = (async () => {
          let reply;
          if (action === 'cancel') {
            const view = await request('GET', '/api/sessions/' + spec.sessionId);
            reply = await request('POST', '/api/stop', { sessionId: spec.sessionId, expectedExecution: view.json.execution });
          } else if (action === 'allow' || action === 'deny') {
            reply = await request('POST', '/api/missions/' + spec.sessionId + '/interventions/' + event.requestId + '/decision', {
              expectedVersion: 0, idempotencyKey: spec.label, action,
            });
          } else throw new Error('Unexpected approval for a read-only image call');
          decisions.push({ label: spec.label, requestId: event.requestId, action, reply });
          if (reply.status !== 200 || (action === 'cancel' ? reply.json.stopped !== true
            : reply.json.status !== (action === 'allow' ? 'allowed' : 'denied')))
            throw new Error('Approval decision failed ' + JSON.stringify(reply));
        })();
        // Handle immediately, but retain rejection for the caller after the stream settles.
        decisionTasks.push(decide.catch(error => ({ error })));
      }
    }
  }
  const completed = await Promise.all(decisionTasks);
  const failed = completed.find(value => value?.error); if (failed) throw failed.error;
  await idle(spec.sessionId);
  turns.push({ label: spec.label, sessionId: spec.sessionId, action, events });
  return events;
}
function observeOwnedTree(child) {
  const table = snapshotProcessTable();
  if (!table || !table.some(row => row.pid === child.pid)) throw new Error('Owned process snapshot unavailable');
  const tree = ownDescendants(table, child.pid);
  return [tree.root, ...tree.descendants];
}
async function confirmGone(rows) {
  await until(() => {
    const table = snapshotProcessTable();
    return table && rows.every(row => !table.some(current => current.pid === row.pid && current.created === row.created));
  }, 'observed owned process identities exited', 15000);
}
async function stopNativeWorkers() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const table = snapshotProcessTable();
  if (!table?.some(row => row.pid === serverIdentity?.pid && row.created === serverIdentity?.created)) throw new Error('Owned service identity unconfirmed');
  const workers = [];
  for (const row of ownDescendants(table, server.pid).descendants) {
    const invocation = cp.spawnSync('/bin/ps', ['-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
    if (invocation !== helper + ' --input-session') continue;
    if (!snapshotProcessTable()?.some(current => current.pid === row.pid && current.created === row.created)) continue;
    try { process.kill(row.pid, 'SIGTERM'); workers.push(row); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await until(() => {
    const current = snapshotProcessTable();
    return current && workers.every(worker => !current.some(row => row.pid === worker.pid && row.created === worker.created));
  }, 'owned native graceful cleanup', 15000);
}
const scenarios = [], specs = [];
function check(condition, label) { t.ok(condition, label); if (!condition) throw new Error('Stopped after failed assertion: ' + label); }
let envBase, receiverReady, originalSource, savedRecording, recordingFileBytes, baselineTarget;
async function catalog() {
  const names = []; let cursor = 0;
  do {
    const reply = await request('POST', '/api/tools/list_tools', { cursor, limit: 200 });
    if (reply.status !== 200 || !reply.json.result?.groups) throw new Error('Actual compact catalog missing');
    const result = reply.json.result;
    names.push(...Object.values(result.groups).flat()); cursor = result.nextCursor;
  } while (cursor !== null);
  return names;
}
async function stopService() {
  if (!server) return;
  let observed;
  try { observed = observeOwnedTree(server); await stopNativeWorkers(); }
  catch (error) { cleanupSafe = false; t.fail('Service cleanup preparation ' + error.message); }
  const receipt = killOwnTree(server);
  cleanups.push({ label: 'service', scenario: scenarios.at(-1)?.name, receipt, observed: observed?.map(row => ({ ...row, created: String(row.created) })) });
  try {
    if (receipt.incomplete || receipt.skipped || !observed) throw new Error('Incomplete owned service tree: ' + JSON.stringify(receipt));
    await until(() => server.exitCode !== null || server.signalCode !== null, 'service root exit', 5000);
    await confirmGone(observed);
    t.ok(true, 'scenario service and all observed owned process identities exit completely');
  } catch (error) { cleanupSafe = false; t.fail(error.message); }
  if (provider) await provider.close();
  for (const call of calls) if (token && call.text) call.text = call.text.replaceAll(token, '[omitted fixture token]');
  server = null; provider = null; token = '';
}
async function startService(name, { missing = false, hidden = '', desktop = true, commandTools = true } = {}) {
  await stopService();
  if (!cleanupSafe) throw new Error('Refusing later scenarios after incomplete cleanup');
  const caseRoot = path.join(root, name);
  data = path.join(caseRoot, 'data'); fs.mkdirSync(data, { recursive: true });
  const env = { ...envBase, HOME: path.join(caseRoot, 'h'), USERPROFILE: path.join(caseRoot, 'h'),
    APPDATA: path.join(caseRoot, 'a'), LOCALAPPDATA: path.join(caseRoot, 'l'), WCW_DATA_DIR: path.join(caseRoot, 'acc') };
  for (const value of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.WCW_DATA_DIR]) fs.mkdirSync(value, { recursive: true });
  helper = missing ? path.join(caseRoot, 'nonexistent-helper') : process.env.RUYI_P5_READINESS_HELPER || path.join(workbench, 'runtime/macos/ruyi-automation-helper');
  provider = await startFakeProvider({ handler(req) {
    if (!req.tools.some(tool => tool.function?.name === 'tool_invoke_exec')) return textFrames('fixture metadata');
    const user = JSON.stringify(req.messages.filter(message => message.role === 'user').at(-1)?.content);
    const spec = specs.find(row => user?.includes(row.label));
    if (!spec || spec.sent) return textFrames('fixture turn complete');
    spec.sent = true;
    return toolCallFrames('tool_invoke_exec', { name: 'ai_computer_control__' + spec.tool, arguments: spec.args }, spec.callId);
  } });
  const config = { configSchema: require('../ruyi-workbench/app/server').CONFIG_SCHEMA, engineMode: 'interactive',
    permissionMode: 'default', permissionTimeoutMs: 15000, defaultWorkspace: work,
    providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url, apiKey: 'synthetic-readiness-key', model: 'fake-model' }],
    activeProvider: 'fake', allowDesktopTools: desktop, allowCommandTools: commandTools, bridgeExternalToolsToProvider: true,
    includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
    desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [{ id: 'ai-computer-control', enabled: true, command: python,
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...env, PYTHONPATH: path.join(repo, 'src'), ACC_TOOLSETS: 'desktop,macro,filesystem,uia,ocr,observe,shell',
        ACC_HIDE_TOOLS: hidden, RUYI_MACOS_AUTOMATION_HELPER: helper } }] };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config, null, 2));
  scenarios.push({ name, missing, hidden, desktop, commandTools });
  port = await getFreePort();
  server = cp.spawn(process.execPath, [path.join(workbench, 'app/server.js'), 'serve', '--port', String(port)], {
    env: { ...process.env, ...env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, RUYI_MACOS_AUTOMATION_HELPER: helper },
    cwd: workbench, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => calls.push({ name: 'service-stdout', scenario: name, text: String(chunk).slice(-4000) }));
  server.stderr.on('data', chunk => calls.push({ name: 'service-stderr', scenario: name, text: String(chunk).slice(-4000) }));
  serverIdentity = await until(() => snapshotProcessTable()?.find(row => row.pid === server.pid), 'service birth');
  await until(async () => {
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token || !runtime.port) return false;
      token = runtime.token; port = runtime.port;
      return (await request('GET', '/health')).status === 200;
    } catch { return false; }
  }, 'isolated real service');
  const names = await catalog(), diagnostic = await invoke('diagnostics');
  scenarios.at(-1).catalog = names; scenarios.at(-1).diagnostic = diagnostic;
  return { names, diagnostic };
}
async function refusedTurn(label, tool, args, expectedCode) {
  const before = await command('state'), auditBefore = await invoke('audit_tail', { n: 100 });
  const spec = { label, tool, args }; specs.push(spec);
  const events = await turn(spec, 'allow');
  const result = toolResult(events).result;
  const after = await command('state'), auditAfter = await invoke('audit_tail', { n: 100 });
  const mutations = auditAfter.records.slice(auditBefore.records.length).filter(row => ['input_sequence', 'focus_window', 'mouse_move'].includes(row.tool));
  scenarios.at(-1).outcomes ||= [];
  scenarios.at(-1).outcomes.push({ label, result, before, after, newAudit: auditAfter.records.slice(auditBefore.records.length) });
  check(result?.ok === false && result.code === expectedCode, label + ' refuses through the ordinary provider proxy with ' + expectedCode);
  check(JSON.stringify(before.counts) === JSON.stringify(after.counts) && !after.leftHeld && !after.modifierFlags && mutations.length === 0,
    label + ' has no receiver input or native input/focus dispatch audit');
  const pending = await request('GET', '/api/interventions');
  check(Array.isArray(pending.json.pending) && pending.json.pending.length === 0, label + ' leaves no pending permission');
  return result;
}
(async () => {
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_P5_READINESS_REQUIRED !== '1') { console.log('SKIP opt-in real Mac readiness/hidden-registry validation'); return; }
    root = fs.mkdtempSync('/tmp/p5ready-'); work = path.join(root, 'work'); fs.mkdirSync(work);
    envBase = { ...fixtureChildEnv(), TMPDIR: root, HOME: path.join(root, 'h'), USERPROFILE: path.join(root, 'h'),
      APPDATA: path.join(root, 'a'), LOCALAPPDATA: path.join(root, 'l') };
    for (const value of [envBase.HOME, envBase.APPDATA, envBase.LOCALAPPDATA]) fs.mkdirSync(value, { recursive: true });
    envBase.WCW_SESSION_ID = '';
    python = process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python');
    const binary = path.join(root, 'receiver');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-DRUYI_MANUAL_FIXTURE=1', '-DRUYI_RECORD_FIXTURE=1', '-mmacosx-version-min=14.0', '-framework', 'AppKit',
      '-framework', 'ApplicationServices', '-framework', 'Carbon', path.join(__dirname, 'fixtures/macos-input-window.m'), '-o', binary],
    { encoding: 'utf8', timeout: 60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
    receiver = cp.spawn(binary, [], { env: envBase, stdio: ['pipe', 'pipe', 'pipe'] });
    receiver.stderr.resume(); let buffer = '';
    receiver.stdout.on('data', chunk => { buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) { reports.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
    receiverReady = await until(() => reports.find(row => row.event === 'ready'), 'owned receiver');
    originalSource = await command('source-abc');
    const baseline = await startService('baseline');
    const baselineStatus = await request('GET', '/api/status');
    check(baselineStatus.json.runtime?.capabilities?.['desktop.capture']?.ready === true
      && baselineStatus.json.tools?.some(row => row.name === 'desktop_screenshot'),
      'actual enabled Workbench helper begins ready with native screenshot visible');
    const listed = await invoke('list_windows'); baselineTarget = listed.windows.find(row => row.pid === receiver.pid && row.handle === receiverReady.id)?.target;
    if (!baselineTarget) throw new Error('Cannot bind owned fixture');
    const source = { id: originalSource.inputSource, type: 'TISTypeKeyboardLayout' };
    const point = { x: Math.round(receiverReady.pad.x + 100), y: Math.round(receiverReady.pad.y + 60) };
    const sequence = { target: baselineTarget, input_source: source, events: [
      { type: 'mouse_down', at_us: 0, ...point, flags: 0, button: 0, click_state: 1, pressure: 0, delta_x: 0, delta_y: 0 },
      { type: 'mouse_up', at_us: 40000, ...point, flags: 0, button: 0, click_state: 1, pressure: 0, delta_x: 0, delta_y: 0 }] };
    const focused = await invoke('focus_window', { target: baselineTarget }, 'exec');
    check(focused.ok === true, 'baseline confirms owned foreground focus before starting a recording');
    const started = await invoke('record_start', { target: baselineTarget }, 'exec');
    check(started.ok === true && started.source === 'controlled_native_requests', 'baseline confirms controlled recording before dispatching its one input');
    const beforeSequence = await command('state');
    const moved = await invoke('input_sequence', sequence, 'exec');
    check(moved.ok === true, 'baseline confirms the actual balanced click sequence before collection');
    const afterSequence = await command('state');
    check(afterSequence.counts.left_down === (beforeSequence.counts.left_down || 0) + 1
      && afterSequence.counts.left_up === (beforeSequence.counts.left_up || 0) + 1 && !afterSequence.leftHeld && !afterSequence.modifierFlags,
      'baseline counted down/up receipts make any later erroneous replay observable');
    const stopped = await invoke('record_stop', { save_as: 'registry-gate-owned' }, 'exec');
    check(stopped.ok === true && stopped.complete === true && typeof stopped.path === 'string' && fs.existsSync(stopped.path),
      'baseline confirms complete collection and actual saved file before replay scenarios');
    savedRecording = stopped.recording;
    recordingFileBytes = stopped.path && fs.readFileSync(stopped.path);
    check(focused.ok && started.ok && moved.ok && stopped.ok && stopped.complete && savedRecording?.actions.length === 1
      && savedRecording.actions[0].op === 'input.sequence' && savedRecording.schema === 1
      && JSON.stringify(JSON.parse(recordingFileBytes)) === JSON.stringify(savedRecording),
      'baseline actually records and saves one owned balanced click sequence for later hidden replay');
    if (!savedRecording) throw new Error('No actual captured macro');
    check(['input_sequence', 'record_start', 'window_screenshot', 'ui_find', 'ocr_screen', 'observe', 'act_and_verify']
      .every(name => baseline.names.includes('ai_computer_control__' + name)), 'ready baseline advertises actual loaded native capability families');
    const positive = { label: 'READINESS_BASELINE', tool: 'macro_run', args: { recording: savedRecording, target: baselineTarget } }; specs.push(positive);
    const beforeReplay = await command('state');
    const positiveEvents = await turn(positive, 'allow');
    const afterReplay = await command('state');
    check(toolResult(positiveEvents).result?.completed === 1 && toolResult(positiveEvents).result?.failed === 0
      && afterReplay.counts.left_down === beforeReplay.counts.left_down + 1 && afterReplay.counts.left_up === beforeReplay.counts.left_up + 1
      && !afterReplay.leftHeld && !afterReplay.modifierFlags,
      'same captured macro replays successfully through ordinary default-mode session before refusal controls');
    const missing = await startService('missing-helper', { missing: true });
    const status = await request('GET', '/api/status'); scenarios.at(-1).workbenchCapture = status.json.runtime?.capabilities?.['desktop.capture'];
    const cap = scenarios.at(-1).workbenchCapture;
    check(cap?.installed === false && cap.ready === false && cap.reasonCode === 'dependency_missing'
      && !status.json.tools?.some(row => row.name === 'desktop_screenshot'), 'actual missing helper makes Workbench capture unavailable and removes its native screenshot');
    const dc = missing.diagnostic.capabilities;
    check(dc?.['desktop.capture']?.installed === false && dc['desktop.capture'].ready === false && dc['desktop.capture'].reasonCode === 'dependency_missing'
      && dc['desktop.input_sequence']?.ready === false && dc['desktop.recording']?.ready === false && dc['desktop.accessibility']?.ready === false,
      'real ACC missing-helper diagnostic reports capture/input/record/AX unavailable');
    check(['input_sequence', 'record_start', 'window_screenshot', 'ui_find', 'ocr_screen', 'observe', 'act_and_verify']
      .every(name => !missing.names.includes('ai_computer_control__' + name)), 'actual missing helper omits native capture/input/record/AX/OCR-screen families from compact catalog');
    await refusedTurn('READINESS_MISSING', 'macro_run', { recording: savedRecording, target: baselineTarget }, 'dependency_missing');
    const hidden = await startService('registry-hidden', { hidden: 'input_sequence' });
    check(hidden.diagnostic.hidden_tools.includes('input_sequence') && !hidden.names.includes('ai_computer_control__input_sequence')
      && hidden.names.includes('ai_computer_control__macro_run'), 'actual ACC registry removes only the requested sequence while normal macro dispatcher remains available');
    const hiddenWindows = await invoke('list_windows');
    const hiddenTarget = hiddenWindows.windows.find(row => row.pid === receiver.pid && row.handle === receiverReady.id)?.target;
    check(hiddenTarget && typeof hiddenTarget.ref === 'string' && hiddenTarget.ref.length > 0,
      'new hidden-registry worker binds a fresh native-session reference to the same owned receiver');
    await refusedTurn('READINESS_HIDDEN_RECORDING', 'macro_run', { recording: savedRecording, target: hiddenTarget }, 'tool_unavailable');
    const beforeBatch = await command('state'), auditBeforeBatch = await invoke('audit_tail', { n: 100 });
    const batch = { label: 'READINESS_HIDDEN_BATCH', tool: 'batch_actions', args: { actions: [{ tool: 'input_sequence', args: { ...sequence, target: hiddenTarget } }] } }; specs.push(batch);
    const batchEvents = await turn(batch, 'allow'); const batchResult = toolResult(batchEvents).result;
    const afterBatch = await command('state'), auditAfterBatch = await invoke('audit_tail', { n: 100 });
    check(batchResult?.failed === 1 && batchResult.completed === 0 && /unknown or non-batchable/.test(batchResult.results?.[0]?.error || ''),
      'real hidden registry refuses nested batch input rather than dispatching it');
    check(JSON.stringify(beforeBatch.counts) === JSON.stringify(afterBatch.counts)
      && !auditAfterBatch.records.slice(auditBeforeBatch.records.length).some(row => row.tool === 'input_sequence'),
      'hidden nested batch has no actual receiver input or sequence audit');
    for (const gate of ['desktop', 'command']) {
      const state = await startService(gate + '-off', { desktop: gate !== 'desktop', commandTools: gate !== 'command' });
      const expectedHidden = ['macro_run', 'batch_actions', ...(gate === 'desktop' ? ['input_sequence', 'focus_window'] : ['launch_application', 'run_command', 'kill_process'])];
      check(expectedHidden.every(name => !state.names.includes('ai_computer_control__' + name))
        && state.diagnostic.hidden_tools.length === 0,
        gate + ' Node master switch filters the catalog while standalone ACC registry remains unmodified');
      const policyStatus = await request('GET', '/api/status');
      const generatedPath = policyStatus.json.mcpConfigPath || path.join(data, 'generated/workbench.mcp.json');
      const generated = await until(() => {
        try { return JSON.parse(fs.readFileSync(generatedPath)).mcpServers?.['ai-computer-control']; } catch { return false; }
      }, 'actual generated CLI ACC configuration');
      const cliHidden = String(generated.env?.ACC_HIDE_TOOLS || '').split(',').filter(Boolean);
      scenarios.at(-1).generatedCliPolicy = { path: generatedPath, hidden: cliHidden };
      check(expectedHidden.every(name => cliHidden.includes(name)),
        gate + ' generated CLI configuration independently contains product-generated exact hidden tool names');
      if (gate === 'command') check(state.names.includes('ai_computer_control__list_windows'), 'command-off keeps independent desktop reads available');
      await refusedTurn('READINESS_' + gate.toUpperCase() + '_OFF', 'macro_run', { recording: savedRecording, target: baselineTarget }, 'tool-disabled');
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    await stopService().catch(error => { cleanupSafe = false; t.fail(error.stack || String(error)); });
    if (receiver && receiver.exitCode === null && receiver.signalCode === null) {
      let observed;
      try { observed = observeOwnedTree(receiver); } catch (error) { cleanupSafe = false; t.fail(error.message); }
      receiver.stdin.write('quit\n');
      try { await until(() => receiver.exitCode !== null || receiver.signalCode !== null, 'receiver exit', 5000);
        if (!observed) throw new Error('Receiver identity unconfirmed'); await confirmGone(observed);
        t.ok(true, 'receiver and all observed owned process identities exit');
      } catch (error) { cleanupSafe = false; t.fail(error.message); cleanups.push({ label: 'receiver', receipt: killOwnTree(receiver) }); }
    }
    if (originalSource) t.ok(reports.some(row => row.event === 'input-source-restore' && row.restored), 'fixture restores the original input source after all readiness scenarios');
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ calls, turns, decisions, scenarios, reports,
      cleanups, cleanupSafe, recording: savedRecording, savedRecordingSha256: recordingFileBytes && hash(recordingFileBytes), retainedRoot: cleanupSafe ? null : root }, null, 2) + '\n'); }
    if (root && cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
    else if (root) console.log('Retained incomplete cleanup evidence: ' + root);
    t.done();
  }
})();
