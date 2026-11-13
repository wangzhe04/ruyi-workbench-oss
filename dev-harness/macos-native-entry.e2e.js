'use strict';
require('./lib/self-isolate-home');
// Opt-in real Mac receiver + real ACC. Only the model provider is an in-process offline fixture.
// Exercise ordinary default-mode session approval and actual per-turn image checkpoints/rollback.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('MACOS NATIVE ENTRY');
const workbench = path.resolve(__dirname, '../ruyi-workbench');
const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
const evidence = process.env.RUYI_P5_ENTRY_EVIDENCE;
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
(async () => {
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_P5_ENTRY_REQUIRED !== '1') { console.log('SKIP opt-in real Mac session entry validation'); return; }
    root = fs.mkdtempSync(path.join('/tmp', 'ruyi-p5-entry-'));
    work = path.join(root, 'work'); data = path.join(root, 'data');
    const env = { ...fixtureChildEnv(), TMPDIR: root, HOME: path.join(root, 'env-home'), USERPROFILE: path.join(root, 'env-home'),
      APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata') };
    for (const directory of [work, data, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(directory, { recursive: true });
    helper = process.env.RUYI_P5_ENTRY_HELPER || path.join(workbench, 'runtime/macos/ruyi-automation-helper');
    python = process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python');
    const probe = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0) throw new Error('Native prerequisite failed ' + (probe.error?.message || probe.stderr || probe.stdout));
    const state = JSON.parse(probe.stdout);
    if (!state.ready || !state.inputReady || state.locked) throw new Error('Current capture and input authorization are required: ' + JSON.stringify(state));
    const binary = path.join(root, 'receiver');
    const compile = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-DRUYI_MANUAL_FIXTURE=1', '-DRUYI_RECORD_FIXTURE=1', '-mmacosx-version-min=14.0', '-framework', 'AppKit',
      '-framework', 'ApplicationServices', '-framework', 'Carbon', path.join(__dirname, 'fixtures/macos-input-window.m'), '-o', binary],
    { encoding: 'utf8', timeout: 60000 });
    if (compile.status !== 0) throw new Error(compile.stderr);
    receiver = cp.spawn(binary, [], { env: { ...env, RUYI_P5_CLIPBOARD_FIXTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    receiver.stderr.resume(); let receiverBuffer = '';
    receiver.stdout.on('data', chunk => {
      receiverBuffer += chunk; let end;
      while ((end = receiverBuffer.indexOf('\n')) >= 0) { reports.push(JSON.parse(receiverBuffer.slice(0, end))); receiverBuffer = receiverBuffer.slice(end + 1); }
    });
    const ready = await until(() => reports.find(row => row.event === 'ready'), 'owned receiver');
    const source = await command('source-abc');
    const seed = await command('seed-clipboard'); seeded = seed.clipboardSnapshot;
    if (!seeded || !seed.clipboardPreserved) throw new Error('Cannot preserve the original clipboard');
    const specs = [];
    provider = await startFakeProvider({ handler(req) {
      if (!req.tools.some(tool => ['tool_invoke_read', 'tool_invoke_exec'].includes(tool.function?.name))) return textFrames('fixture metadata');
      const user = JSON.stringify(req.messages.filter(message => message.role === 'user').at(-1)?.content);
      const spec = specs.find(candidate => user?.includes(candidate.label));
      if (!spec || spec.sent) return textFrames('fixture turn complete');
      spec.sent = true;
      return toolCallFrames(spec.tier === 'read' ? 'tool_invoke_read' : 'tool_invoke_exec',
        { name: 'ai_computer_control__' + spec.tool, arguments: spec.args }, spec.callId);
    } });
    const config = { configSchema: require('../ruyi-workbench/app/server').CONFIG_SCHEMA, engineMode: 'interactive', permissionMode: 'default', permissionTimeoutMs: 15000,
      defaultWorkspace: work, providers: [{ id: 'fake', label: 'Offline fixture', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url,
        apiKey: 'synthetic-entry-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }], activeProvider: 'fake',
      allowDesktopTools: true, allowCommandTools: true, bridgeExternalToolsToProvider: true,
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [{ id: 'ai-computer-control', enabled: true,
        command: python, args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
        env: { ...env, PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'), ACC_TOOLSETS: 'desktop,macro,filesystem',
          ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } }] };
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config, null, 2));
    port = await getFreePort();
    server = cp.spawn(process.execPath, [path.join(workbench, 'app/server.js'), 'serve', '--port', String(port)], {
      env: { ...process.env, ...env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data }, cwd: workbench, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', value => calls.push({ name: 'service-stdout', text: String(value).slice(-4000) }));
    server.stderr.on('data', value => calls.push({ name: 'service-stderr', text: String(value).slice(-4000) }));
    serverIdentity = await until(() => snapshotProcessTable()?.find(row => row.pid === server.pid), 'service birth identity');
    await until(async () => {
      try {
        const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
        if (runtime.pid !== server.pid || !runtime.token || !runtime.port) return false;
        port = runtime.port; token = runtime.token;
        return (await request('GET', '/health')).status === 200;
      } catch { return false; }
    }, 'owned workbench service');
    const listed = await invoke('list_windows');
    const target = listed.windows.find(row => row.pid === receiver.pid && row.handle === ready.id)?.target;
    if (!target) throw new Error('Normal tool entry cannot bind its own receiver');
    const point = { x: Math.round(ready.pad.x + 100), y: Math.round(ready.pad.y + 60) };
    const sequence = { target, input_source: { id: source.inputSource, type: 'TISTypeKeyboardLayout' }, events: [
      { type: 'mouse_down', ...point, at_us: 0, flags: 0, button: 0, click_state: 1, pressure: 0, delta_x: 0, delta_y: 0 },
      { type: 'mouse_up', ...point, at_us: 40000, flags: 0, button: 0, click_state: 1, pressure: 0, delta_x: 0, delta_y: 0 }] };
    for (const action of ['allow', 'deny', 'cancel']) {
      const before = await command('state'), auditBefore = await invoke('audit_tail', { n: 100 });
      const spec = { label: 'ENTRY_APPROVAL_' + action, tool: 'macro_run', args: { delay_ms: 0, steps: [
        { tool: 'focus_window', args: { target } }, { tool: 'input_sequence', args: sequence }] } };
      specs.push(spec); const events = await turn(spec, action);
      const after = await command('state'), auditAfter = await invoke('audit_tail', { n: 100 });
      const ledger = events.find(event => event.type === 'turn_summary')?.irreversible;
      t.ok(events.filter(event => event.type === 'permission_request').length === 1, action + ' crosses actual default-mode permission entry exactly once');
      if (action === 'allow') {
        const result = toolResult(events).result;
        t.ok(result?.completed === 2 && result.failed === 0 && after.counts.left_down === (before.counts.left_down || 0) + 1
          && after.counts.left_up === (before.counts.left_up || 0) + 1, 'allowed session macro performs one actual balanced native click');
        t.ok(['macro_run', 'input_sequence', 'focus_window'].every(name => auditAfter.records.slice(auditBefore.records.length).some(row => row.tool === name && row.ok)),
          'normal allowed session preserves actual enclosing and native ACC audit rows');
        t.ok(ledger?.length === 2 && ledger.every((row, i) => row.effectStatus === 'reported' && row.step === i
          && row.callId === spec.callId && row.parentTool === 'ai_computer_control__macro_run')
          && ledger[0].name === 'ai_computer_control__focus_window' && ledger[1].name === 'ai_computer_control__input_sequence',
          'actual completed macro focus and input appear in the same-turn irreversible ledger with call and step attribution');
      } else {
        const mutations = records => records.filter(row => ['macro_run', 'input_sequence', 'focus_window'].includes(row.tool));
        t.ok(JSON.stringify(before.counts) === JSON.stringify(after.counts)
          && mutations(auditAfter.records).length === mutations(auditBefore.records).length,
          action + ' has no receiver side effect or dispatched ACC mutation');
        t.ok(Array.isArray(ledger) && ledger.length === 0, action + ' does not falsely record a reported irreversible action');
        const pending = await request('GET', '/api/interventions');
        t.ok(Array.isArray(pending.json.pending) && pending.json.pending.length === 0,
          action + ' leaves no live permission request after the actual session settles');
      }
      t.ok(!after.leftHeld && after.modifierFlags === 0, action + ' leaves the receiver input state neutral');
    }
    const baseline = path.join(root, 'baseline.png');
    const made = cp.spawnSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB", (3,3), (255,0,0)).save(sys.argv[1], "PNG")', baseline], { env, encoding: 'utf8', timeout: 5000 });
    if (made.status !== 0) throw new Error(made.stderr || 'Cannot create an owned baseline image');
    for (const tool of ['window_screenshot', 'get_clipboard_image']) for (const overwrite of [false, true]) {
      const output = path.join(work, tool + (overwrite ? '-overwrite.png' : '-new.png'));
      const before = overwrite ? fs.readFileSync(baseline) : null; if (before) fs.writeFileSync(output, before);
      const args = tool === 'window_screenshot' ? { title_substring: ready.title, output_path: output } : { save_path: output };
      const spec = { label: 'ENTRY_IMAGE_' + tool + '_' + overwrite, tier: 'exec', tool, args }; specs.push(spec);
      const events = await turn(spec, 'allow');
      const result = toolResult(events).result;
      t.ok(result?.output_path === output && fs.existsSync(output) && fs.readFileSync(output).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
        tool + ' saves an actual PNG through an ordinary session turn');
      const saved = fs.readFileSync(output);
      if (before) t.ok(hash(saved) !== hash(before), tool + ' genuinely overwrites different prior image bytes');
      const journal = await request('GET', '/api/checkpoints?sessionId=' + spec.sessionId);
      const entry = journal.json.entries?.find(row => row.path === output);
      const summary = events.find(event => event.type === 'turn_summary');
      checkpoints.push({ label: spec.label, sessionId: spec.sessionId, result, journal: journal.json, beforeSha256: before && hash(before), afterSha256: hash(saved) });
      t.ok(entry?.op === (overwrite ? 'modify' : 'create') && Number.isInteger(entry.turnSeq) && entry.turnSeq > 0 && entry.turnSeq === summary?.turnSeq && !entry.skipped
        && (!before || entry.bytes === before.length), tool + ' has the real per-session/per-turn ' + (overwrite ? 'before-image' : 'create') + ' checkpoint');
      if (!entry) throw new Error('Checkpoint missing for ' + tool);
      const rollback = await request('POST', '/api/checkpoints/rollback', { sessionId: spec.sessionId, turnSeq: entry.turnSeq });
      checkpoints.at(-1).rollback = rollback;
      t.ok(rollback.json.ok === true && (before ? fs.readFileSync(output).equals(before) : !fs.existsSync(output)),
        tool + ' rollback ' + (overwrite ? 'restores exact prior bytes' : 'removes its newly created file'));
    }
    const audit = await invoke('audit_tail', { n: 100 });
    t.ok(['window_screenshot', 'get_clipboard_image'].every(name => audit.records.filter(row => row.tool === name && row.ok).length === 2),
      'both actual image writers retain success audit rows for create and overwrite turns');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (server) {
      try {
        const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
        calls.push({ name: 'final-service-runtime', result: { ...runtime, token: '[omitted fixture token]' }, exitCode: server.exitCode, signalCode: server.signalCode });
      } catch (error) { calls.push({ name: 'final-service-runtime', error: error.message, exitCode: server.exitCode, signalCode: server.signalCode }); }
      let observed;
      try { observed = observeOwnedTree(server); await stopNativeWorkers(); }
      catch (error) { cleanupSafe = false; t.fail('native cleanup preparation ' + error.message); }
      const receipt = killOwnTree(server);
      cleanups.push({ label: 'service', receipt, observed: observed?.map(row => ({ ...row, created: String(row.created) })) });
      try {
        if (receipt.incomplete || receipt.skipped || !observed) throw new Error('Incomplete owned-tree receipt ' + JSON.stringify(receipt));
        await until(() => server.exitCode !== null || server.signalCode !== null, 'service cleanup', 5000);
        await confirmGone(observed);
        t.ok(true, 'service cleanup confirms all observed owned process identities exited');
      } catch (error) { cleanupSafe = false; t.fail(error.message); }
    }
    if (provider) await provider.close();
    if (receiver && receiver.exitCode === null && receiver.signalCode === null) {
      let observed;
      try { observed = observeOwnedTree(receiver); } catch (error) { cleanupSafe = false; t.fail(error.message); }
      receiver.stdin.write('quit\n');
      try {
        await until(() => receiver.exitCode !== null || receiver.signalCode !== null, 'receiver cleanup', 5000);
        if (!observed) throw new Error('Receiver process identities unavailable');
        await confirmGone(observed);
        cleanups.push({ label: 'receiver', graceful: true, observed: observed.map(row => ({ ...row, created: String(row.created) })) });
        t.ok(true, 'receiver cleanup confirms all observed owned process identities exited');
      } catch (error) { cleanupSafe = false; t.fail(error.message); cleanups.push({ label: 'receiver', receipt: killOwnTree(receiver) }); }
    }
    if (reports.some(row => row.event === 'source-abc')) t.ok(reports.some(row => row.event === 'input-source-restore' && row.restored), 'native entry fixture restores the original input source');
    if (seeded) t.ok(reports.some(row => row.event === 'clipboard-restore' && row.restored), 'native entry fixture restores the original clipboard');
    for (const call of calls) if (token && call.text) call.text = call.text.replaceAll(token, '[omitted fixture token]');
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ calls, turns, decisions, checkpoints, reports, cleanups, cleanupSafe, retainedRoot: cleanupSafe ? null : root, providerRequests: provider?.requests.map(req => ({ tools: req.tools?.map(tool => tool.function?.name), messages: req.messages?.filter(message => message.role !== 'system') })) }, null, 2) + '\n'); }
    if (root && cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
    else if (root) console.log('Retained incomplete cleanup evidence: ' + root);
    t.done();
  }
})();
