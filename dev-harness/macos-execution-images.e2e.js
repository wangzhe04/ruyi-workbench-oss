'use strict';
require('./lib/self-isolate-home');
// Opt-in real root/provider/ACC SDK with synthetic PNGs. No screen capture or input.
// Qualifies durable image delivery, batch pairing and Stop/steer, not native capture or full P5.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port');
const t = createRunner('MACOS EXECUTION IMAGES');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rei-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
const app = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const env = { ...fixtureChildEnv(), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
  APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TMPDIR: root,
  RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data };
for (const dir of [data, work, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, env);
let server, provider, token, port, output = '';
const observations = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(read, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(); }
  throw new Error('Timed out ' + label + '\n' + output.slice(-4000));
}
async function api(route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(route + ': ' + res.status + ' ' + await res.text());
  return res.json();
}
async function start() {
  port = await getFreePort(); token = '';
  server = cp.spawn(process.execPath, [app, 'serve', '--port', String(port)], { env: { ...process.env, ...env }, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
  await until(async () => {
    try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token) return false;
      port = runtime.port; token = runtime.token;
      return (await api('/health')).ok;
    } catch { return false; }
  }, 'serve ready');
}
async function stop() {
  if (!server) return;
  const child = server, identity = snapshotProcessTable()?.find(row => row.pid === child.pid);
  if (!identity) throw new Error('Cannot establish owned service identity');
  killOwnTree(child);
  await until(() => {
    const rows = snapshotProcessTable();
    return rows && !rows.some(row => row.pid === identity.pid && row.created === identity.created);
  }, 'owned service exit');
  server = null;
}
async function turn(sessionId, message) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token }, body: JSON.stringify({ sessionId, message, cwd: work }),
    signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('turn HTTP ' + res.status);
  const events = (await res.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(async () => (await api('/api/sessions/' + sessionId)).execution === null, 'driver finally');
  observations.push({ sessionId, message, events }); return events;
}
(async () => {
  const specs = [], continuations = [], proof = [];
  const ledgerFile = path.join(data, 'desktop-executions-v1/state.json');
  const marker = path.join(root, 'delivered.json'), release = path.join(root, 'release'), control = path.join(root, 'control.json');
  const history = id => fs.readFileSync(path.join(data, 'sessions', id + '.provider.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  const rows = id => JSON.parse(fs.readFileSync(ledgerFile)).entries.filter(row => row.sessionId === id);
  const imageCount = messages => messages.filter(row => row.role === 'user' && Array.isArray(row.content)
    && row.content.some(part => part.type === 'image_url')).length;
  function check(value, label) { t.ok(value, label); if (!value) throw new Error('Stopped after ' + label); }
  function paired(messages, spec) {
    const index = messages.findIndex(row => row.role === 'assistant' && row.tool_calls?.some(call => call.id === spec.calls[0].id));
    return index >= 0 && spec.calls.every((call, i) => messages[index + 1 + i]?.role === 'tool'
      && messages[index + 1 + i].tool_call_id === call.id);
  }
  function image(label) { return { name: 'tool_invoke_read', args: { name: 'ai_computer_control__fixture_image', arguments: { label } }, id: label }; }
  function observe(label) { return { name: 'tool_invoke_read', args: { name: 'ai_computer_control__fixture_observe', arguments: { label } }, id: label }; }
  async function run(spec) {
    spec.sessionId = (await api('/api/sessions', { title: spec.label, cwd: work })).session.id;
    specs.push(spec);
    const events = await turn(spec.sessionId, spec.label);
    const saved = history(spec.sessionId), entries = rows(spec.sessionId);
    proof.push({ spec, events, saved, entries });
    return { events, saved, entries };
  }
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_EXECUTION_IMAGES_REQUIRED !== '1') { console.log('SKIP opt-in actual root synthetic image delivery'); return; }
    const helper = process.env.RUYI_EXECUTION_CONTEXT_HELPER, python = process.env.RUYI_ACC_PYTHON;
    if (!helper || !python) throw new Error('Explicit candidate helper and Python required');
    const acc = path.resolve(__dirname, '../mcp/ai-computer-control');
    provider = await startFakeProvider({ handler(req) {
      // The original prompt identifies the scenario; trailing image messages have no scenario label.
      const spec = specs.find(row => req.messages.some(message => message.role === 'user'
        && typeof message.content === 'string' && message.content.includes(row.label)));
      if (!spec) return textFrames('metadata fixture');
      const answered = req.messages.filter(row => row.role === 'tool' && spec.calls.some(call => call.id === row.tool_call_id));
      if (answered.length === spec.calls.length) {
        continuations.push({ label: spec.label, messages: req.messages, entries: rows(spec.sessionId) });
        if (spec.nextCalls && !req.messages.some(row => row.role === 'tool' && row.tool_call_id === spec.nextCalls[0].id)) return toolCallFrames(spec.nextCalls);
        return textFrames('IMAGES_VERIFIED_COMPLETE');
      }
      return toolCallFrames(spec.calls);
    } });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 9, permissionMode: 'bypass', defaultWorkspace: work,
      providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url, apiKey: 'synthetic-key', model: 'fake-model', vision: true }], activeProvider: 'fake',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
      allowDesktopTools: true, allowCommandTools: true, desktopMcp: { enabled: false, autodetect: false }, bridgeExternalToolsToProvider: true,
      externalMcpServers: [{ id: 'ai-computer-control', enabled: true, command: python,
        args: ['-X', 'utf8', path.resolve(__dirname, 'fixtures/execution-image-server.py')], cwd: acc, startupTimeoutMs: 20000,
        env: { ...env, PYTHONPATH: path.join(acc, 'src'), PYTHONDONTWRITEBYTECODE: '1', WCW_DATA_DIR: path.join(root, 'acc-data'),
          RUYI_FIXTURE_DATA: data, RUYI_EXECUTION_CONTEXT_REQUIRED: '0', ACC_TOOLSETS: 'desktop,macro', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } }] }));
    // Pause after the real ledger publishes delivery, with no input state held.
    const preload = path.resolve(__dirname, 'fixtures/execution-image-preload.cjs');
    env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require=' + preload;
    env.RUYI_IMAGE_TEST_ROOT = root;
    env.RUYI_DESKTOP_EXECUTION_RECEIPTS = '1';
    await start();
    for (const count of [1, 2]) {
      const spec = { label: 'IMAGE_MIXED_' + count, calls: [...Array.from({ length: count }, (_, i) => image('image_' + count + '_' + i)), observe('observe_' + count)] };
      const result = await run(spec);
      check(!result.events.some(row => row.type === 'error') && JSON.stringify(result.events).includes('IMAGES_VERIFIED_COMPLETE'), spec.label + ' completes actual root/provider/SDK mixed batch');
      check(result.entries.length === count + 1 && result.entries.every(row => row.phase === 'returned' && row.deliverySha256), spec.label + ' actual image and observer receipts durably delivered');
      const observed = JSON.parse(result.saved.find(row => row.role === 'tool' && row.tool_call_id === 'observe_' + count).content);
      check(observed.ok && observed.images === count && observed.deliveredImages === count && observed.lastImageDeliveryMatchesSnapshot,
        spec.label + ' next actual ACC body sees image parts and matching prior delivery digest on disk');
      const resume = continuations.find(row => row.label === spec.label);
      check(paired(result.saved, spec) && paired(resume.messages, spec) && imageCount(resume.messages) === count,
        spec.label + ' final disk and next real model request keep contiguous replies before images');
      check(resume.entries.every(row => row.deliverySha256), spec.label + ' provider continuation occurs only after all actual delivery commits');
    }
    await stop();
    for (const action of ['stop', 'steer']) {
      const oldIds = JSON.parse(fs.readFileSync(ledgerFile)).entries.map(row => row.invocationId);
      for (const file of [marker, release]) fs.rmSync(file, { force: true });
      fs.writeFileSync(control, JSON.stringify({ kind: action, seen: oldIds }));
      await start();
      const spec = { label: 'IMAGE_' + action.toUpperCase(), calls: [image(action + '_image'), observe(action + '_must_skip')] };
      spec.sessionId = (await api('/api/sessions', { title: spec.label, cwd: work })).session.id; specs.push(spec);
      const pending = turn(spec.sessionId, spec.label); pending.catch(() => {});
      await until(() => fs.existsSync(marker), 'image delivery pause');
      const delivered = JSON.parse(fs.readFileSync(marker));
      check(delivered.sessionId === spec.sessionId && imageCount(history(spec.sessionId)) === 1,
        action + ' gate starts only after owned image/history delivery publication');
      const current = await api('/api/sessions/' + spec.sessionId);
      const response = await api('/api/' + action, action === 'stop'
        ? { sessionId: spec.sessionId, expectedExecution: current.execution }
        : { sessionId: spec.sessionId, text: 'FIXTURE_STEER_PRESERVE_IMAGE', mode: 'interrupt' });
      fs.writeFileSync(release, 'release');
      check(response.ok === true, action + ' accepted during real image delivery completion');
      const events = await pending, saved = history(spec.sessionId), entries = rows(spec.sessionId);
      proof.push({ spec, response, events, saved, entries, delivered });
      check(entries.length === 1 && entries[0].phase === 'returned' && entries[0].deliverySha256 && imageCount(saved) === 1,
        action + ' retains acknowledged image and never dispatches remaining ACC observer');
      check(paired(saved, spec), action + ' saved history pairs missing reply ahead of preserved image');
      if (action === 'steer') {
        const resume = continuations.find(row => row.label === spec.label);
        check(resume && paired(resume.messages, spec) && imageCount(resume.messages) === 1
          && JSON.stringify(resume.messages).includes('FIXTURE_STEER_PRESERVE_IMAGE'),
          'steer resumes actual provider with paired replies, acknowledged image and user steering');
      } else check(!continuations.some(row => row.label === spec.label), 'Stop never resumes parent model after image delivery');
      await stop(); fs.rmSync(control, { force: true });
    }
    // The second model batch exists in memory when its first intent save fails.
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(control, JSON.stringify({ kind: 'intent_save_fault', callId: 'late_intent' }));
    await start();
    const late = { label: 'IMAGE_LATE_INTENT_FAULT', calls: [image('first_delivered_image')], nextCalls: [observe('late_intent')] };
    const lateResult = await run(late), lateSpec = { calls: late.nextCalls };
    check(fs.existsSync(marker) && lateResult.entries.length === 1 && lateResult.entries[0].deliverySha256,
      'second-batch intent EIO occurs after first image actual durable delivery without dispatching second call');
    check(paired(lateResult.saved, lateSpec) && imageCount(lateResult.saved) === 1
      && JSON.parse(lateResult.saved.find(row => row.tool_call_id === 'late_intent').content).outcome === 'not_dispatched',
      'second-batch intent failure final save pairs current assistant IDs and retains earlier image');
    check(lateResult.events.some(row => row.type === 'error' || row.type === 'result' && row.ok === false), 'intent persistence failure produces explicit failed turn');
    proof.push({ fault: JSON.parse(fs.readFileSync(marker)) });
    await stop(); fs.rmSync(marker, { force: true });
    fs.writeFileSync(control, JSON.stringify({ kind: 'image_save_fault', callId: 'image_history_fault' }));
    await start();
    const failedImage = { label: 'IMAGE_HISTORY_SAVE_FAULT', calls: [image('image_history_fault'), observe('image_fault_must_skip')] };
    const failedResult = await run(failedImage);
    check(fs.existsSync(marker) && failedResult.entries.length === 1 && failedResult.entries[0].phase === 'returned'
      && failedResult.entries[0].deliverySha256 === null, 'actual image result remains unacknowledged when strict image-history head commit fails');
    check(!continuations.some(row => row.label === failedImage.label) && !failedResult.events.some(row => row.type === 'tool_use' && row.id === 'image_fault_must_skip'),
      'failed image delivery prevents same-batch observer and parent model continuation');
    proof.push({ fault: JSON.parse(fs.readFileSync(marker)) });
    await stop(); fs.rmSync(control, { force: true });
    await start();
    const held = await turn(failedImage.sessionId, 'after image delivery failure');
    check(held.some(row => row.type === 'error') && rows(failedImage.sessionId)[0].phase === 'unknown'
      && rows(failedImage.sessionId).length === 1, 'actual restart holds unacknowledged image result without replay or fabricated delivery');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    fs.writeFileSync(release, 'cleanup');
    try { await stop(); } catch (error) { t.fail('cleanup ' + error.message); }
    if (provider) await provider.close();
    if (process.env.RUYI_EXECUTION_IMAGES_EVIDENCE) fs.writeFileSync(process.env.RUYI_EXECUTION_IMAGES_EVIDENCE,
      JSON.stringify({ scope: 'actual root/provider/SDK synthetic image mixed batches and Stop/steer; no native capture, input or full P5', root, proof, continuations, observations, output }, null, 2));
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
