'use strict';
require('./lib/self-isolate-home');
// Actual root/provider -> ACC -> negotiated native capture/Vision -> saved model history.
// Owned OCR window only. No input posting, clipboard changes, TCC changes or deliberate lock.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port');
const { decodePng } = require('./lib/png-grid');
const t = createRunner('MACOS EXECUTION CAPTURE');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
const env = { ...fixtureChildEnv(), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
  APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TMPDIR: root,
  RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, RUYI_DESKTOP_EXECUTION_RECEIPTS: '1' };
for (const dir of [data, work, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, env);
let server, provider, fixture, port, token, output = '';
const reports = [], proof = [], continuations = [], providerAttempts = [], specs = [];
const app = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(25); }
  throw new Error('Timed out ' + label + '\n' + output.slice(-3000));
}
function check(value, label) { t.ok(value, label); if (!value) throw new Error('Stopped after ' + label); }
async function api(route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(route + ': ' + res.status + ' ' + await res.text());
  return res.json();
}
async function start() {
  port = await getFreePort(); token = '';
  server = cp.spawn(process.execPath, [app, 'serve', '--port', String(port)], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', bytes => { output += bytes; }); server.stderr.on('data', bytes => { output += bytes; });
  await until(async () => {
    try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token) return false;
      token = runtime.token; port = runtime.port; return (await api('/health')).ok;
    } catch { return false; }
  }, 'root ready');
}
async function stop(child, label) {
  if (!child) return;
  const identity = snapshotProcessTable()?.find(row => row.pid === child.pid);
  if (!identity) { if (child.exitCode !== null) return; throw new Error('Missing owned identity ' + label); }
  killOwnTree(child);
  await until(() => { const rows = snapshotProcessTable(); return rows && !rows.some(row => row.pid === identity.pid && row.created === identity.created); }, label + ' exit');
}
const history = sid => fs.readFileSync(path.join(data, 'sessions', sid + '.provider.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
const ledgerRows = sid => JSON.parse(fs.readFileSync(path.join(data, 'desktop-executions-v1/state.json'))).entries.filter(row => row.sessionId === sid);
const invoke = (name, args, id) => ({ name: 'tool_invoke_read', args: { name: 'ai_computer_control__' + name, arguments: args }, id });
async function turn(spec, message = spec.label) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token }, body: JSON.stringify({ sessionId: spec.sessionId, message, cwd: work }),
    signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error('turn HTTP ' + res.status);
  const events = (await res.text()).split('\n').filter(Boolean).map(JSON.parse);
  await until(async () => (await api('/api/sessions/' + spec.sessionId)).execution === null, 'driver finally');
  return events;
}
async function create(spec) {
  spec.sessionId = (await api('/api/sessions', { title: spec.label, cwd: work })).session.id; specs.push(spec); return spec;
}
async function run(spec) {
  await create(spec); const events = await turn(spec);
  const saved = history(spec.sessionId), rows = ledgerRows(spec.sessionId);
  const traces = rows.map(row => ({ invocationId: row.invocationId, records: fs.readFileSync(path.join(root, 'acc-data/logs/execution-receipts', row.invocationId, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse) }));
  const result = { spec, events, saved, rows, traces }; proof.push(result);
  check(!events.some(row => row.type === 'error') && JSON.stringify(events).includes('NATIVE_CHAIN_COMPLETE'), spec.label + ' actual root turn completes');
  check(rows.length === spec.calls.length && rows.every(row => row.phase === 'returned' && row.deliverySha256 && row.observed?.receipt), spec.label + ' all actual SDK results have strict receipts and saved deliveries');
  check(continuations.some(row => row.label === spec.label && row.rows.every(entry => entry.deliverySha256)), spec.label + ' actual next model request follows durable deliveries');
  for (let i = 0; i < rows.length; i++) {
    const trace = traces[i].records, accepted = trace[0];
    check(accepted.stage === 'acc_request_accepted' && accepted.session_id === spec.sessionId && accepted.turn_seq === rows[i].turnSeq
      && accepted.call_id_hash === rows[i].callIdHash && accepted.received_semantic_sha256 === rows[i].argsSemanticSha256,
    spec.label + ' native chain is bound to actual root preparation ' + rows[i].toolName);
    const entered = trace.filter(row => row.stage === 'native_entered');
    check(entered.length === spec.nativeOps[i].length && entered.every((row, j) => row.op === spec.nativeOps[i][j]), spec.label + ' real native handlers enter exact requested operations ' + rows[i].toolName);
    check(entered.every(row => trace.filter(end => end.stage === 'native_terminal' && end.operation_id === row.operation_id).length === 1
      && trace.some(start => start.stage === 'native_prepared' && start.operation_id === row.operation_id && start.frame_sha256 === row.frame_sha256))
      && trace.at(-1).stage === 'acc_request_terminal', spec.label + ' exact native frames have terminal receipts before SDK completion ' + rows[i].toolName);
  }
  return result;
}
(async () => {
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_EXECUTION_CAPTURE_REQUIRED !== '1') { console.log('SKIP opt-in owned native capture/Vision receipt qualification'); return; }
    const helper = process.env.RUYI_EXECUTION_CONTEXT_HELPER, python = process.env.RUYI_ACC_PYTHON;
    if (!helper || !python) throw new Error('Explicit candidate helper and Python required');
    const binary = path.join(root, 'ocr-fixture'), localImage = path.join(work, 'bilingual.png');
    const built = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=14.0',
      '-framework', 'AppKit', '-framework', 'ApplicationServices', path.join(__dirname, 'fixtures/macos-ocr-window.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (built.error || built.status !== 0) throw new Error(built.error?.message || built.stderr);
    const image = cp.spawnSync(binary, ['--image', localImage], { env, encoding: 'utf8', timeout: 10000 });
    if (image.error || image.status !== 0) throw new Error(image.error?.message || image.stderr);
    fixture = cp.spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let lines = '';
    fixture.stdout.on('data', bytes => { lines += bytes; let end; while ((end = lines.indexOf('\n')) >= 0) { const line = lines.slice(0, end); lines = lines.slice(end + 1); try { reports.push(JSON.parse(line)); } catch { output += line; } } });
    fixture.stderr.on('data', bytes => { output += bytes; });
    const ready = await until(() => reports.find(row => row.event === 'ready'), 'owned OCR scene ready');
    check(ready.counts.every(count => count === 0), 'owned OCR scene starts without injected input');
    provider = await startFakeProvider({ handler(req) {
      const child = specs.find(row => row.node && req.body.model === 'native-sub'
        && req.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(row.node.task)));
      if (child) {
        providerAttempts.push({ label: child.label + ':node', toolIds: req.messages.filter(row => row.role === 'tool').map(row => row.tool_call_id), messages: req.messages });
        if (req.messages.some(row => row.role === 'tool')) return textFrames(child.node.noContinuation ? 'UNEXPECTED_NODE_CONTINUATION' : 'NATIVE_NODE_COMPLETE');
        return toolCallFrames(child.node.calls);
      }
      const spec = specs.find(row => req.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(row.label)));
      if (!spec) return textFrames('metadata fixture');
      providerAttempts.push({ label: spec.label, toolIds: req.messages.filter(row => row.role === 'tool').map(row => row.tool_call_id),
        ...(spec.label.startsWith('NATIVE_FAULT_') ? { messages: req.messages } : {}) });
      if (spec.calls.every(call => req.messages.some(row => row.role === 'tool' && row.tool_call_id === call.id))) {
        continuations.push({ label: spec.label, messages: req.messages, rows: ledgerRows(spec.sessionId) }); return textFrames('NATIVE_CHAIN_COMPLETE');
      }
      return toolCallFrames(spec.calls);
    } });
    const acc = path.resolve(__dirname, '../mcp/ai-computer-control');
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 9, permissionMode: 'bypass', defaultWorkspace: work,
      providers: [{ id: 'fake', type: 'openai-compat', baseUrl: provider.url, apiKey: 'synthetic-key', model: 'fake-model', vision: true,
        models: [{ id: 'fake-model' }, { id: 'native-sub' }] }], activeProvider: 'fake',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
      allowDesktopTools: true, allowCommandTools: true, desktopMcp: { enabled: false, autodetect: false }, bridgeExternalToolsToProvider: true,
      externalMcpServers: [{ id: 'ai-computer-control', enabled: true, command: python,
        args: ['-X', 'utf8', path.resolve(__dirname, 'fixtures/execution-capture-server.py')], cwd: acc,
        env: { ...env, PYTHONPATH: path.join(acc, 'src'), PYTHONDONTWRITEBYTECODE: '1', WCW_DATA_DIR: path.join(root, 'acc-data'),
          ACC_TOOLSETS: 'desktop,ocr,vision', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper,
          RUYI_CAPTURE_TEST_ROOT: root } }] }));
    env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require=' + path.resolve(__dirname, 'fixtures/execution-image-preload.cjs');
    env.RUYI_IMAGE_TEST_ROOT = root;
    await start();
    const captured = await run({ label: 'NATIVE_WINDOW_CAPTURE', calls: [invoke('screenshot', { window_title: ready.title, max_width: 0 }, 'native_image'), invoke('get_screen_info', {}, 'native_status')], nativeOps: [['capture'], ['status']] });
    const imageRows = captured.saved.filter(row => row.role === 'user' && Array.isArray(row.content) && row.content.some(part => part.type === 'image_url'));
    check(imageRows.length === 1, 'real native screenshot reaches exactly one saved image row');
    const url = imageRows[0].content.find(part => part.type === 'image_url').image_url.url;
    check(url.startsWith('data:image/png;base64,'), 'actual screenshot retains PNG image transport');
    const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'), decoded = decodePng(png);
    check(decoded.width >= ready.content.width && decoded.height >= ready.content.height, 'independently decoded screenshot dimensions cover the owned window');
    const capturePath = path.join(work, 'captured-window.png'); fs.writeFileSync(capturePath, png);
    if (process.env.RUYI_EXECUTION_CAPTURE_EVIDENCE) fs.writeFileSync(process.env.RUYI_EXECUTION_CAPTURE_EVIDENCE.replace(/\.json$/, '') + '-window.png', png);
    const recognized = await run({ label: 'NATIVE_IMAGE_OCR', calls: [invoke('ocr_image', { path: localImage }, 'native_local_ocr'), invoke('ocr_image', { path: capturePath }, 'native_capture_ocr'), invoke('ocr_available_languages', {}, 'native_languages')], nativeOps: [['ocr.image'], ['ocr.image'], ['ocr.languages']] });
    for (const id of ['native_local_ocr', 'native_capture_ocr']) {
      const value = JSON.parse(recognized.saved.find(row => row.role === 'tool' && row.tool_call_id === id).content);
      check(value.ok === true && value.text.includes('INVOICE 42') && value.text.includes('中文测试'), 'real Vision recognizes English and Chinese through saved root result ' + id);
    }
    const negative = await run({ label: 'NATIVE_CAPTURE_REFUSAL', calls: [invoke('screenshot', { window_title: ready.title + ' missing' }, 'native_missing_window')], nativeOps: [['capture']] });
    const refused = JSON.parse(negative.saved.find(row => row.role === 'tool' && row.tool_call_id === 'native_missing_window').content);
    check(refused.ok === false && !negative.saved.some(row => row.role === 'user' && Array.isArray(row.content) && row.content.some(part => part.type === 'image_url')), 'missing owned window produces a real native failure with no invented image');
    const smallTask = 'SMALL_OWNED_NATIVE_IMAGE_TEST';
    const small = await run({ label: 'NATIVE_NODE_SMALL_IMAGE', node: { task: smallTask,
      calls: [invoke('screenshot', { window_title: ready.title, max_width: 640 }, 'native_small_node_image')] },
      calls: [{ name: 'orchestrate_agents', args: { nodes: [{ id: 'capture', task: smallTask, model: 'native-sub', toolTier: 'exec', maxIters: 2 }], background: false }, id: 'launch_native_small' }],
      nativeOps: [['capture']] });
    const smallRow = small.rows[0], smallSnapshot = JSON.parse(fs.readFileSync(path.join(data, 'desktop-executions-v1', smallRow.nodeDelivery.file)));
    small.snapshot = smallSnapshot;
    const smallImage = smallSnapshot.history.find(row => row.role === 'user' && Array.isArray(row.content) && row.content.some(part => part.type === 'image_url'));
    const smallUrl = smallImage?.content.find(part => part.type === 'image_url').image_url.url;
    check(smallRow.nodeDelivery.scope.kind === 'foreground_workflow_node' && smallSnapshot.historySha256 === smallRow.deliverySha256
      && require('node:crypto').createHash('sha256').update(JSON.stringify(smallSnapshot.history)).digest('hex') === smallRow.deliverySha256,
    'real native small node image has an exact acknowledged immutable consumer history snapshot');
    check(smallSnapshot.history.some(row => row.role === 'tool' && row.tool_call_id === 'native_small_node_image')
      && smallUrl?.startsWith('data:image/png;base64,') && decodePng(Buffer.from(smallUrl.slice(smallUrl.indexOf(',') + 1), 'base64')).width === 640,
    'actual node snapshot retains the independently decoded resized native PNG and exact tool reply');
    const childRequest = providerAttempts.find(row => row.label === 'NATIVE_NODE_SMALL_IMAGE:node' && row.toolIds.includes('native_small_node_image'));
    small.childRequest = childRequest;
    check(JSON.parse(small.saved.find(row => row.role === 'tool' && row.tool_call_id === 'launch_native_small').content).status === 'succeeded',
      'actual foreground workflow reports successful small native image node completion');
    check(childRequest?.messages.some(row => row.role === 'user' && Array.isArray(row.content) && row.content.some(part => part.type === 'image_url' && part.image_url.url === smallUrl))
      && !small.saved.some(row => row.role === 'user' && Array.isArray(row.content) && row.content.some(part => part.type === 'image_url')),
    'actual child model receives its saved native PNG while parent history keeps child image separate');
    await stop(server, 'owned small node root'); await start();
    const beforeSmallResume = provider.requests.length, smallResume = await turn(small.spec, 'explicit request after valid native node cold reopen');
    small.reopen = { events: smallResume, beforeProviderRequests: beforeSmallResume, afterProviderRequests: provider.requests.length,
      rows: ledgerRows(small.spec.sessionId), snapshot: JSON.parse(fs.readFileSync(path.join(data, 'desktop-executions-v1', smallRow.nodeDelivery.file))) };
    check(!smallResume.some(row => row.type === 'error') && provider.requests.length === beforeSmallResume + 1
      && ledgerRows(small.spec.sessionId).length === 1 && ledgerRows(small.spec.sessionId)[0].deliverySha256 === smallRow.deliverySha256,
    'actual cold service reopens valid native node snapshot and permits a new model request without replaying capture');
    for (const kind of ['entry_stop', 'continue_stop', 'native_terminal_eio', 'image_save_fault']) {
      await stop(server, 'owned root before ' + kind);
      for (const name of ['control.json', 'capture-gate.json', 'capture-gate-exit.json', 'capture-fault.json', 'capture-release', 'delivered.json', 'release']) fs.rmSync(path.join(root, name), { force: true });
      const callId = 'native_' + kind, mustNotExist = path.join(work, kind + '-must-not-write.txt');
      fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ kind, callId }));
      await start();
      const spec = await create({ label: 'NATIVE_FAULT_' + kind.toUpperCase(), calls: [invoke('screenshot', { window_title: ready.title, max_width: 640 }, callId),
        { name: 'file_write', args: { path: mustNotExist, content: 'must never dispatch after uncertain capture' }, id: 'after_' + kind }] });
      const pending = turn(spec); pending.catch(() => {});
      let gate, response, owned = [];
      if (kind.endsWith('_stop')) {
        await until(() => fs.existsSync(path.join(root, 'capture-gate.json')), 'real native ' + kind + ' rendezvous');
        gate = JSON.parse(fs.readFileSync(path.join(root, 'capture-gate.json')));
        const table = snapshotProcessTable();
        owned = [gate.accPid, gate.nativePid].map(pid => table?.find(row => row.pid === pid));
        check(owned.every(Boolean) && gate.frame.stage === (kind === 'entry_stop' ? 'native_entered' : 'native_continue_sent'), kind + ' captures live actual ACC/native identities at committed native boundary');
        const view = await api('/api/sessions/' + spec.sessionId);
        const dispatched = ledgerRows(spec.sessionId);
        const liveBeforeStop = snapshotProcessTable();
        gate.stopSentUnixMs = Date.now();
        check(view.execution && dispatched.length === 1 && dispatched[0].invocationId === gate.invocationId
          && liveBeforeStop && owned.every(identity => liveBeforeStop.some(row => row.pid === identity.pid && row.created === identity.created))
          && gate.stopSentUnixMs < gate.deadlineUnixMs - 1000 && !fs.existsSync(path.join(root, 'capture-gate-exit.json'))
          && (kind !== 'entry_stop' || gate.stopSentUnixMs < Date.parse(gate.preparedAt) + 1500),
        kind + ' Stop targets a live actual turn while its exact native gate is still blocked before deadline');
        response = await api('/api/stop', { sessionId: spec.sessionId, expectedExecution: view.execution });
        check(response.ok === true && response.stopped === true, kind + ' actual workbench Stop accepts exact current execution');
        // Do not release the journal rendezvous until actual Stop/cleanup has
        // completed; an expired fixture timer is not evidence of cancellation.
      }
      const events = await pending, immediateRows = ledgerRows(spec.sessionId);
      const immediateTrace = path.join(root, 'acc-data/logs/execution-receipts', immediateRows[0]?.invocationId || 'missing', 'events.ndjson');
      const faultProof = { spec, kind, response, gate, immediateRows, events,
        immediateRecords: fs.existsSync(immediateTrace) ? fs.readFileSync(immediateTrace, 'utf8').trim().split('\n').map(JSON.parse) : [],
        owned: owned.map(row => row && ({ pid: row.pid, created: String(row.created) })) };
      proof.push(faultProof);
      if (kind.endsWith('_stop')) {
        await until(() => { const table = snapshotProcessTable(); return table && owned.every(identity => !table.some(row => row.pid === identity.pid && row.created === identity.created)); }, kind + ' exact observed ACC/native exits');
        faultProof.observedOwnedExitUnixMs = Date.now();
        check(kind !== 'entry_stop' || faultProof.observedOwnedExitUnixMs < Date.parse(gate.preparedAt) + 1900,
          kind + ' exits before the earliest possible native handshake timeout');
        await until(() => ledgerRows(spec.sessionId).find(row => row.invocationId === gate.invocationId)?.phase === 'unknown', kind + ' pending cleanup publishes durable uncertainty');
        const exit = fs.existsSync(path.join(root, 'capture-gate-exit.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'capture-gate-exit.json'))) : null;
        check(Date.now() < gate.deadlineUnixMs && (!exit || exit.reason === 'cancel'), kind + ' actual identities exit and uncertainty commits before fixture timeout or manual release');
      }
      const rows = ledgerRows(spec.sessionId), saved = history(spec.sessionId);
      const traceFile = path.join(root, 'acc-data/logs/execution-receipts', rows[0]?.invocationId || 'missing', 'events.ndjson');
      const records = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
      Object.assign(faultProof, { observedQuiescentUnixMs: Date.now(),
        gateExit: fs.existsSync(path.join(root, 'capture-gate-exit.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'capture-gate-exit.json'))) : null,
        rows, saved, records });
      check(rows.length === 1 && rows[0].deliverySha256 === null && rows[0].phase === (kind === 'image_save_fault' ? 'returned' : 'unknown'), kind + ' retains exactly one unacknowledged uncertain invocation');
      check(!fs.existsSync(mustNotExist) && !events.some(row => row.type === 'tool_use' && row.id === 'after_' + kind), kind + ' prevents later same-batch local file mutation');
      check(providerAttempts.filter(row => row.label === spec.label).length === 1 && !continuations.some(row => row.label === spec.label), kind + ' sends no actual provider request after initial tool proposal');
      if (kind.endsWith('_stop')) {
        check(!records.some(row => row.stage === 'native_terminal') && (kind !== 'entry_stop' || !records.some(row => row.stage === 'native_continue_sent')),
          kind + ' never invents native terminal and entry Stop sends no committed continue');
        check(!fs.existsSync(path.join(root, 'capture-release')), kind + ' completes real Stop before any fixture release');
      } else if (kind === 'native_terminal_eio') {
        const fault = JSON.parse(fs.readFileSync(path.join(root, 'capture-fault.json'))); proof.push({ kind, fault });
        check(fault.invocationId === rows[0].invocationId && records.some(row => row.stage === 'native_continue_sent') && !records.some(row => row.stage === 'native_terminal'),
          'native terminal EIO preserves actual continue but cannot publish a completed screenshot');
      } else {
        const fault = JSON.parse(fs.readFileSync(path.join(root, 'delivered.json'))); proof.push({ kind, fault });
        check(fault.history.some(row => row.role === 'user' && Array.isArray(row.content) && row.content.some(part => part.type === 'image_url'))
          && records.some(row => row.stage === 'native_terminal') && records.at(-1).stage === 'acc_request_terminal',
        'actual screenshot image-history EIO distinguishes completed native result from uncommitted consumer delivery');
      }
      await stop(server, 'owned fault root'); fs.rmSync(path.join(root, 'control.json'), { force: true }); await start();
      const before = provider.requests.length, held = await turn(spec, 'explicit request after native fault');
      check(held.some(row => row.type === 'error') && ledgerRows(spec.sessionId).length === 1 && ledgerRows(spec.sessionId)[0].phase === 'unknown'
        && provider.requests.length === before && !fs.existsSync(mustNotExist), kind + ' actual cold restart holds before model or tool replay');
    }
    await stop(server, 'owned root before actual image capacity');
    fs.rmSync(path.join(root, 'control.json'), { force: true });
    fixture.stdin.write('noise\n');
    const noise = await until(() => reports.find(row => row.event === 'noise'), 'owned high entropy canvas');
    check(noise.content.width === 1000 && noise.content.height === 700, 'large-image quota scene is an actual bounded self-owned native canvas');
    fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify({ kind: 'large_image' }));
    await start();
    const nodeTask = 'LARGE_OWNED_NATIVE_IMAGE_TEST', capacityTarget = path.join(work, 'node-capacity-must-not-write.txt');
    const capacity = await create({ label: 'NATIVE_NODE_IMAGE_CAPACITY', node: { task: nodeTask, noContinuation: true,
      calls: [invoke('screenshot', { window_title: ready.title, max_width: 0 }, 'native_large_image'),
        { name: 'file_write', args: { path: capacityTarget, content: 'must never dispatch after quota refusal' }, id: 'after_native_large_image' }] },
      calls: [{ name: 'orchestrate_agents', args: { nodes: [{ id: 'capture', task: nodeTask, model: 'native-sub', toolTier: 'exec', maxIters: 2 }], background: false }, id: 'launch_native_capacity' }] });
    const capacityEvents = await turn(capacity), capacityRows = ledgerRows(capacity.sessionId);
    const capacityProof = { spec: capacity, events: capacityEvents, rows: capacityRows }; proof.push(capacityProof);
    check(capacityRows.length === 1 && capacityRows[0].phase === 'returned' && capacityRows[0].deliverySha256 === null
      && capacityRows[0].nodeDelivery?.scope.nodeId === 'capture', 'actual large node screenshot remains returned and unacknowledged when consumer snapshot exceeds quota');
    const nodeRun = await api('/api/agent-runs/' + capacityRows[0].nodeDelivery.scope.runId + '?sessionId=' + capacity.sessionId);
    capacityProof.run = nodeRun;
    check(nodeRun.run.nodes.find(row => row.id === 'capture').error.includes('Actual node history exceeds the bounded snapshot'), 'actual node refuses the real native image at the explicit snapshot byte capacity check');
    const imageEvent = capacityEvents.find(row => row.type === 'tool_result' && row.id === 'native_large_image');
    const encoded = JSON.parse(fs.readFileSync(path.join(root, 'capture-large.json')));
    check(encoded.invocationId === capacityRows[0].invocationId && imageEvent?.content?._truncated?.fields.some(field => field.path === 'image' && field.chars === encoded.base64Chars),
      'owned observer retains actual capture bytes before the separate bounded display projection');
    const actualPng = fs.readFileSync(path.join(root, 'capture-large.png')), actualImage = decodePng(actualPng);
    const minimumSnapshotBytes = 2 * Buffer.byteLength('data:image/png;base64,' + actualPng.toString('base64'));
    capacityProof.actualImage = { bytes: actualPng.length, width: actualImage.width, height: actualImage.height, minimumSnapshotBytes,
      encoded, sha256: require('node:crypto').createHash('sha256').update(actualPng).digest('hex') };
    check(actualPng.length === encoded.bytes && capacityProof.actualImage.sha256 === encoded.sha256 && actualImage.width >= 2000 && actualImage.height >= 1400 && minimumSnapshotBytes > 16 * 1024 * 1024,
      'independent PNG decode proves the real image and its exact binding/history copies exceed the 16 MiB snapshot cap');
    if (process.env.RUYI_EXECUTION_CAPTURE_EVIDENCE) fs.writeFileSync(process.env.RUYI_EXECUTION_CAPTURE_EVIDENCE.replace(/\.json$/, '') + '-quota.png', actualPng);
    check(!fs.existsSync(capacityTarget) && !capacityEvents.some(row => row.type === 'tool_use' && row.id === 'after_native_large_image')
      && providerAttempts.filter(row => row.label === capacity.label).length === 1 && providerAttempts.filter(row => row.label === capacity.label + ':node').length === 1,
    'oversize actual node image stops later local mutation and every parent or child model continuation');
    const reserved = JSON.parse(fs.readFileSync(path.join(data, 'desktop-executions-v1', capacityRows[0].nodeDelivery.file)));
    check(reserved.kind === 'node_delivery_reservation' && !Object.hasOwn(reserved, 'history'), 'quota refusal preserves the reservation instead of writing a truncated image transcript');
    const capacityTrace = fs.readFileSync(path.join(root, 'acc-data/logs/execution-receipts', capacityRows[0].invocationId, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    capacityProof.records = capacityTrace;
    check(capacityTrace.some(row => row.stage === 'native_terminal' && row.ok === true) && capacityTrace.at(-1).stage === 'acc_request_terminal',
      'quota refusal follows actual completed native capture rather than a fabricated payload or skipped dispatch');
    await stop(server, 'owned quota root'); fs.rmSync(path.join(root, 'control.json'), { force: true }); await start();
    const beforeQuotaHold = provider.requests.length, quotaHold = await turn(capacity, 'explicit request after native image quota refusal');
    check(quotaHold.some(row => row.type === 'error') && ledgerRows(capacity.sessionId)[0].phase === 'unknown' && provider.requests.length === beforeQuotaHold
      && ledgerRows(capacity.sessionId).length === 1 && !fs.existsSync(capacityTarget), 'actual cold restart holds oversize image uncertainty without dropping required image or replaying node');
    fixture.stdin.write('plain\n'); await until(() => reports.find(row => row.event === 'plain'), 'owned OCR scene restored');
    fixture.stdin.write('status\n');
    const final = await until(() => reports.find(row => row.event === 'status'), 'owned scene final state');
    check(final.counts.every(count => count === 0) && final.counterText === ready.counterText, 'capture and OCR leave owned controls unchanged');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const name of ['capture-release', 'release']) fs.writeFileSync(path.join(root, name), 'cleanup');
    try { await stop(server, 'owned root'); } catch (error) { t.fail(error.message); }
    try { if (fixture && fixture.exitCode === null) { fixture.stdin.write('quit\n'); await until(() => fixture.exitCode !== null, 'owned scene normal exit', 5000); } } catch { try { await stop(fixture, 'owned scene'); } catch (error) { t.fail(error.message); } }
    if (provider) await provider.close();
    if (process.env.RUYI_EXECUTION_CAPTURE_EVIDENCE) fs.writeFileSync(process.env.RUYI_EXECUTION_CAPTURE_EVIDENCE, JSON.stringify({ scope: 'actual root/ACC/native owned screenshot and Vision receipts and saved image history; root Stop before continue and after continue before terminal observation, exact owned cleanup, native terminal EIO/image history EIO and cold holds; no input, held faults, background/CLI or wholeP5 acceptance', root, reports, proof, continuations, providerAttempts, output }, null, 2));
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
