'use strict';
// DRAFT. Run ONLY after the candidate is applied, generated server built, and parent
// grants an exclusive HTTP runtime window. This file never builds or overlays code.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), cp = require('node:child_process');
const crypto = require('node:crypto');
const repo = process.env.RUYI_GATEWAY_DRAFT_REPO || path.resolve(__dirname, '..');
const { releaseEnvironment } = require(path.join(repo, 'dev-harness/lib/release-checks'));
const { killOwnTree } = require(path.join(repo, 'dev-harness/lib/kill-own-tree'));
const { getFreePort } = require(path.join(repo, 'dev-harness/free-port'));
const { startFakeProvider, textFrames, toolCallFrames } = require(path.join(repo, 'dev-harness/lib/fake-openai-provider'));
const { messageEvents } = require(path.join(repo, 'dev-harness/lib/fake-anthropic-provider'));
const { createRunner } = require(path.join(repo, 'dev-harness/lib/harness'));
const runner = createRunner('PRIVACY PREPARATION STOP');
const workerFile = fs.existsSync(path.join(__dirname, 'lib/privacy-preparation-http-worker.js')) ? path.join(__dirname, 'lib/privacy-preparation-http-worker.js') : path.join(__dirname, 'generated-http-worker.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-preparation-stop-'));
const generatedServer = path.join(repo, 'ruyi-workbench/app/server.js');
const generatedBytes = fs.readFileSync(generatedServer);
const generatedSha256 = crypto.createHash('sha256').update(generatedBytes).digest('hex');
const requests = [], results = [];
let selected = null;

async function until(fn, description, limit = 15000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(25); }
  throw Error('timeout: ' + description);
}
async function bounded(promise, ms, description) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(description)), ms); })]); }
  finally { clearTimeout(timer); }
}
function action(body, url) {
  const tag = body.metadata || {};
  const request = { url, case: tag.ruyiFixtureCase, kind: tag.ruyiFixtureKind, attempt: Number(tag.ruyiFixtureAttempt), body };
  requests.push(request);
  assert.equal(request.case, selected.id, 'unlabelled/unexpected provider POST');
  assert.ok(['main', 'child'].includes(request.kind));
  if (selected.kind === 'child' && request.kind === 'main' && request.attempt === 1) {
    return { name: 'orchestrate_agents', args: { task: 'Complete the bounded synthetic child task.', toolTier: 'edit', maxIters: 3, background: false, engine: 'openai' } };
  }
  if (selected.effect && request.kind === selected.kind && request.attempt === 1) {
    return { name: 'file_write', args: { path: selected.output, content: 'SIDE-EFFECT-ONCE\n' } };
  }
  return { final: true };
}
async function fakeProvider() {
  const fallbackErrors = [];
  const fake = await startFakeProvider({
    models: ['fixture-model'],
    handler(req) {
      const next = action(req.body, req.url), id = 'fixture_' + requests.length;
      return next.final ? textFrames('fixture complete') : toolCallFrames(next.name, next.args, id);
    },
    fallback: async (req, res) => { try {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw), next = action(body, req.url);
      const id = 'fixture_' + requests.length;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (req.url.endsWith('/messages')) {
        for (const event of messageEvents(next.final ? { text: 'fixture complete' } : { toolUses: [{ id, name: next.name, input: next.args }] })) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
        res.end(); return;
      }
      assert.ok(req.url.endsWith('/responses'), 'unexpected POST path ' + req.url);
      let sequence_number = 0;
      const emit = value => res.write('data: ' + JSON.stringify({ ...value, sequence_number: sequence_number++ }) + '\n\n');
      emit({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
      if (next.final) emit({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_' + id, delta: 'fixture complete' });
      else {
        const item = { type: 'function_call', id: 'fc_' + id, call_id: id, name: next.name, arguments: '' };
        emit({ type: 'response.output_item.added', output_index: 0, item });
        emit({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: JSON.stringify(next.args) });
        emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: JSON.stringify(next.args) } });
      }
      emit({ type: 'response.completed', response: { id, status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 5 } } }); res.end();
    } catch (error) { fallbackErrors.push(String(error.stack || error)); if (!res.headersSent) res.writeHead(500); res.end(); } },
  });
  return { url: fake.url, close: () => fake.close(), get errors() { return [...fake.errors, ...fallbackErrors]; } };
}
function mailbox(child) {
  let serial = 0, fatal = null;
  const pending = new Map(), events = [];
  child.on('message', value => {
    if (value.event === 'worker-error') fatal = Error(value.error);
    if (value.event) events.push(value);
    const request = pending.get(value.reply);
    if (request) { pending.delete(value.reply); clearTimeout(request.timer); value.error ? request.reject(Error(value.error)) : request.resolve(value.result); }
  });
  child.on('exit', (code, signal) => { fatal ||= Error('worker exited ' + code + '/' + signal); });
  return {
    rpc(command, extra = {}) { if (fatal) return Promise.reject(fatal); return new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('IPC timeout ' + command)); }, 15000);
      pending.set(id, { resolve, reject, timer }); child.send({ id, command, ...extra });
    }); },
    event(name, scenario) { return until(() => { if (fatal) throw fatal; const i = events.findIndex(value => value.event === name && (!scenario || value.scenario === scenario)); return i < 0 ? null : events.splice(i, 1)[0]; }, 'worker ' + name); },
  };
}
function streamChat(port, token, sessionId, work) {
  const events = []; let response = null, text = '', closed = false;
  const client = http.request({ hostname: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token } });
  // Disconnection is deliberately performed after the observer reports live prep.
  const done = new Promise((resolve, reject) => {
    client.once('response', res => {
      response = res;
      if (res.statusCode !== 200) { res.resume(); reject(Error('chat status ' + res.statusCode)); return; }
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; let lf; while ((lf = text.indexOf('\n')) >= 0) { const line = text.slice(0, lf); text = text.slice(lf + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch (error) { reject(error); } } } });
      res.on('end', () => resolve({ disconnected: false }));
      res.on('close', () => { if (closed) resolve({ disconnected: true }); });
      res.on('error', error => closed ? resolve({ disconnected: true }) : reject(error));
    });
    client.on('error', error => closed ? resolve({ disconnected: true }) : reject(error));
  });
  done.catch(() => {});
  client.end(JSON.stringify({ sessionId, message: 'Complete the synthetic bounded fixture task.', cwd: work, permissionMode: 'bypass' }));
  return { events, done, disconnect() { closed = true; response?.destroy(); client.destroy(); } };
}
async function runStyle(style, fake) {
  const dir = path.join(root, style), home = path.join(dir, 'home'), data = path.join(dir, 'data'), work = path.join(dir, 'work');
  for (const folder of [home, data, work]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14,
    configExplicitKeysV1: ['killOnDisconnect'], killOnDisconnect: false,
    activeProvider: 'fake', engineMode: 'interactive', defaultWorkspace: work, permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url + '/primary', extraBaseUrls: [fake.url + '/fallback'], apiStyle: style,
      apiKey: 'fixture-auth-token', model: 'fixture-model', models: [{ id: 'fixture-model', label: 'Fixture' }], serverWebSearch: false, anthropicThinking: 'off' }],
    privacyModeV1: 'enhanced', privacyRulesV1: [], privacyTechnicalV1: false, credentialEncryptionV1: true, workDataEncryptionV1: false,
    toolLoadingMode: 'full', allowCommandTools: false, importAgentInstructions: false,
    includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, bridgeExternalToolsToProvider: false,
    desktopMcp: { enabled: false, autodetect: false }, schedulerEnabledV1: false, stewardEnabledV1: false,
    missionAutoContinue: false, memoryAutoPropose: false, runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false,
    openaiMaxToolIterations: 4, subagentMaxPerTurn: 2, subagentMaxConcurrent: 2,
  }));
  const env = { ...releaseEnvironment(home, data), RUYI_GATEWAY_DRAFT_REPO: repo, RUYI_PREPARATION_PORT: String(await getFreePort()) };
  const child = cp.fork(workerFile, [], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const log = fs.createWriteStream(path.join(dir, 'worker.log')); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const box = mailbox(child);
  try {
    const { port, token } = await box.event('ready');
    async function api(method, route, body) {
      const response = await fetch('http://127.0.0.1:' + port + route, { method,
        headers: { 'content-type': 'application/json', 'x-wcw-token': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      const json = await response.json(); assert.equal(response.status, 200, JSON.stringify(json)); return json;
    }
    for (const kind of ['main', 'child']) for (const mode of ['stop', 'epoch', 'disconnect-true', 'disconnect-false', 'completed-stop']) {
      const effect = mode === 'completed-stop', kill = mode === 'disconnect-true';
      const id = [style, kind, mode].join('-'); selected = { id, kind, effect, output: id + '.txt', holdAttempt: effect ? 2 : 1 };
      await api('POST', '/api/config', { killOnDisconnect: kill });
      const created = await api('POST', '/api/sessions', { title: id, cwd: work });
      const sid = created.session.id, start = requests.length;
      await box.rpc('arm', { scenario: selected });
      const chat = streamChat(port, token, sid, work);
      try {
        const paused = await box.event('preparation-paused', id);
        assert.equal(paused.phase, 'inside-consumeSteps-setImmediate');
        assert.equal(paused.signalAbortedAtPause, false); assert.equal(paused.kind, kind); assert.equal(paused.attempt, selected.holdAttempt);
        assert.equal(paused.rows, 4096); assert.ok(paused.bodyBytes > 250000, 'actual large structured preparation is in flight');
        const before = requests.length;
        assert.equal(before - start, (kind === 'child' ? 1 : 0) + (effect ? 1 : 0), 'only required prior model requests arrived');
        if (effect) assert.equal(fs.readFileSync(path.join(work, selected.output), 'utf8'), 'SIDE-EFFECT-ONCE\n');
        if (mode === 'stop' || effect) {
          const session = await api('GET', '/api/sessions/' + sid); assert.ok(session.execution?.driverRunId);
          const receipt = await api('POST', '/api/stop', { sessionId: sid, expectedExecution: session.execution });
          assert.equal(receipt.stopped, true);
          await until(async () => (await box.rpc('probe')).signalAborted, 'real Stop reaches held request signal');
        } else if (mode === 'epoch') await box.rpc('epoch-away-back');
        else {
          chat.disconnect();
          await until(async () => (await box.rpc('probe')).disconnects > 0, 'real HTTP shell observes the closed client socket');
          if (kill) await until(async () => (await box.rpc('probe')).signalAborted, 'real socket close aborts owned request');
          else assert.equal((await box.rpc('probe')).signalAborted, false, 'killOnDisconnect=false keeps actual request live after a proven server-side disconnect');
        }
        assert.equal(requests.length, before, 'paused preparation has sent zero additional POSTs');
        assert.equal((await box.rpc('release')).released, true);
        await until(async () => { const value = await api('GET', '/api/sessions/' + sid); return value.execution === null && value.resumable?.live !== true && value; }, id + ' settles', 30000);
        if (!mode.startsWith('disconnect')) await bounded(chat.done, 10000, 'chat stream did not settle');
        const probe = await box.rpc('probe'), sent = requests.slice(start);
        assert.ok(sent.every(row => !row.url.includes('/fallback')), 'no alternate endpoint was attempted');
        if (kind === 'child') assert.ok(probe.childEntries > 0, 'a real runSubAgentCore child was entered');
        if (mode === 'disconnect-false') {
          assert.equal(sent.length, kind === 'child' ? 3 : 1);
          assert.equal(sent.filter(row => row.kind === kind).length, 1, 'live request proceeds once after harmless disconnect');
        } else {
          if (mode === 'epoch' && kind === 'child') {
            // Existing child error handling returns a failed task to its parent. A
            // fresh parent continuation may report that failure under current policy.
            // It must not retry the rejected child request or execute another tool.
            assert.equal(sent.filter(row => row.kind === 'child').length, 0);
            assert.ok(sent.filter(row => row.kind === 'main').length <= 2);
            assert.ok(sent.filter(row => row.kind === 'main').every(row => row.attempt === 1 || row.attempt === 2));
          } else assert.equal(sent.length, before - start, 'cancelled/invalidated preparation never sends, retries, or fails over');
          assert.equal(probe.counts[kind], selected.holdAttempt, 'no model-boundary retry or replay');
          assert.ok(probe.transportErrors.some(error => error.kind === kind && (mode === 'epoch' ? error.code === 'privacy.policy_changed' : error.name === 'AbortError')),
            'actual transport boundary reports the expected denial');
        }
        const writes = probe.tools.filter(tool => tool.name === 'file_write');
        assert.equal(writes.length, effect ? 1 : 0, 'completed tool side effect executes exactly once and is never replayed');
        if (effect) assert.equal(fs.readFileSync(path.join(work, selected.output), 'utf8'), 'SIDE-EFFECT-ONCE\n');
        assert.deepEqual(fake.errors, []);
        const result = { id, phase: paused.phase, bodyBytes: paused.bodyBytes, childEntries: probe.childEntries, postCount: sent.length, postsByKind: { main: sent.filter(row => row.kind === 'main').length, child: sent.filter(row => row.kind === 'child').length }, boundaryAttempts: probe.counts, serverDisconnects: probe.disconnects, completedWrites: writes.length, pass: true };
        results.push(result); runner.ok(true, id);
      } finally { chat.disconnect(); await box.rpc('release').catch(() => {}); }
    }
  } finally {
    killOwnTree(child); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned worker exit'); log.end();
  }
}
(async () => {
  let fake, failure;
  try {
    assert.ok(generatedBytes.includes(Buffer.from('async function consumeSteps(iterator)')), 'build the reviewed cooperative gateway candidate before running this draft');
    fake = await fakeProvider(); for (const style of ['chat', 'responses', 'anthropic']) await runStyle(style, fake);
  }
  catch (error) { failure = error; runner.fail(error.stack || String(error)); }
  finally {
    try {
      if (fake) await fake.close();
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ generatedServer, generatedSha256, results, error: failure ? String(failure.stack || failure) : null }, null, 2));
      console.log('Evidence retained at ' + root);
    } catch (error) { runner.fail('cleanup/evidence: ' + (error.stack || error)); }
    runner.done();
  }
})();
