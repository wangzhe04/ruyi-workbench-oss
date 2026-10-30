'use strict';
// ACTUAL OFFLINE: HTTP relay -> original orchestrate_agents -> child fakeProvider.
// Foreground and background across parent completion. Run only in Terra's serial
// actual window; source preparation never executes this file.
require('./lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { request, waitForHttp, sleep } = require('./lib/browser-fixture');
const t = createRunner('THREAD RELAY NESTED');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-relay-nested-')), data = path.join(directory, 'data'), work = path.join(directory, 'work');
fs.mkdirSync(data); fs.mkdirSync(work);
let proc, fake, port, token, releaseBackground;
let backgroundParentTerminalObserved = false, backgroundSecondPostAfterTerminal = false, backgroundReadObserved = false;
const backgroundOrder = [], backgroundEvidence = path.join(work, 'nested-child.txt');
const backgroundHeld = new Promise(resolve => { releaseBackground = resolve; });
const isChild = messages => String(messages.find(row => row.role === 'system')?.content || '').includes('子任务执行体');
const get = route => request(port, 'GET', route, null, token);
const post = (route, body) => request(port, 'POST', route, { token, ...body }, token, 120000);
async function until(read, label) { for (let n = 0; n < 400; n++) { const value = await read(); if (value) return value; await sleep(50); } throw Error(label + ' timeout'); }
async function approval(sid) {
  return until(async () => { const d = (await get('/api/steward/delivery?sessionId=' + sid + '&turnSeq=1'))?.json;
    return d?.relayCompletion === 'succeeded' && { reference: { turnSeq: d.turnSeq, latestTurnSeq: d.latestTurnSeq, sourceStamp: d.sourceStamp, fileStamp: d.fileStamp }, accepted: true, materials: { text: true, files: [] } }; }, 'source completion');
}
async function childRun(sid) { return (await get('/api/agent-runs?sessionId=' + sid))?.json?.runs?.find(run => run.kind === 'orchestrate_agents'); }
async function journey(a, source, background) {
  const mode = background ? 'BG' : 'FG', marker = 'RELAY_NESTED_' + mode;
  const b = (await post('/api/sessions', { title: marker, cwd: work })).json.session.id;
  const relay = (await post('/api/thread-relays', { action: 'create', sessionId: a, requestId: 'nested_actual_' + mode, source, targets: [{ sessionId: b, task: marker }] })).json.relay;
  const edge = relay.threadRelay.edges[0];
  const started = await post('/api/thread-relays', { action: 'start', sessionId: a, relayId: relay.id, edgeId: edge.id });
  t.ok(started.status === 200, mode + ': HTTP relay starts its exact existing B');
  if (background) {
    const observation = await until(async () => { const head = (await get('/api/sessions/' + b))?.json, child = await childRun(b);
      return head && !head.execution && child?.live === true && head.session.messages.some(row => row.role === 'assistant' && String(row.content).includes('NESTED_PARENT_DONE_BG')) && { head, child }; }, 'background child after parent completion');
    t.ok(observation.child.background === true && observation.child.sessionId === b, 'BG: original child workflow remains live after relay parent turn exits');
    backgroundParentTerminalObserved = true; backgroundOrder.push({ event: 'parent-terminal-observed' });
    await until(() => fake.requests.find(row => isChild(row.messages) && JSON.stringify(row.messages).includes('NESTED_CHILD_BG')), 'background child provider request');
    releaseBackground();
  }
  const child = await until(async () => { const value = await childRun(b); return value?.status === 'succeeded' && !value.live && value; }, mode + ' child success');
  t.ok(child.sessionId === b && child.nodes.length === 1 && child.nodes[0].status === 'succeeded' && String(child.nodes[0].result).includes('NESTED_CHILD_OK_' + mode), mode + ': actual original child fakeProvider result is durably succeeded');
  const settled = await until(async () => { const value = (await get('/api/thread-relays?sessionId=' + a + '&relayId=' + relay.id))?.json?.relays?.[0]; return value?.threadRelay.edges[0].state === 'review' && value; }, mode + ' relay completion');
  const target = (await get('/api/sessions/' + b)).json;
  t.ok(settled.threadRelay.edges[0].runId === edge.runId && target.session.turnSeq === 1 && !target.execution, mode + ': same relay receipt and original parent owner settle without replay');
  t.ok(fake.requests.filter(row => isChild(row.messages) && JSON.stringify(row.messages).includes('NESTED_CHILD_' + mode)).length === (background ? 2 : 1), mode + ': child performs exactly ' + (background ? 'two' : 'one') + ' real fakeProvider requests');
  if (background) {
    t.ok(backgroundSecondPostAfterTerminal && backgroundReadObserved, 'BG: real second child POST follows observed parent terminal and contains the actual local read result');
    console.log('BACKGROUND_NESTED_ORDER ' + JSON.stringify(backgroundOrder));
  }
}
(async () => { try {
  fake = await startFakeProvider({ handler: async req => {
    const all = JSON.stringify(req.messages);
    if (isChild(req.messages)) {
      if (all.includes('NESTED_CHILD_BG')) {
        if (!req.messages.some(row => row.role === 'tool' && row.tool_call_id === 'nested_bg_read')) {
          backgroundOrder.push({ event: 'child-post-1', index: req.index }); await backgroundHeld;
          return toolCallFrames('file_read', { path: backgroundEvidence }, 'nested_bg_read');
        }
        backgroundSecondPostAfterTerminal = backgroundParentTerminalObserved;
        backgroundReadObserved = all.includes('NESTED_LOCAL_READ_EVIDENCE');
        backgroundOrder.push({ event: 'child-post-2', index: req.index, afterParentTerminal: backgroundParentTerminalObserved, actualReadResult: backgroundReadObserved });
        return textFrames('NESTED_CHILD_OK_BG');
      }
      if (all.includes('NESTED_CHILD_FG')) return textFrames('NESTED_CHILD_OK_FG');
    }
    for (const mode of ['FG', 'BG']) if (all.includes('RELAY_NESTED_' + mode)) {
      if (!req.messages.some(row => row.role === 'tool')) return toolCallFrames('orchestrate_agents', { background: mode === 'BG', poolPolicy: 'off', nodes: [{ id: 'nested_' + mode, task: 'NESTED_CHILD_' + mode, engine: 'openai', model: 'fake-model', toolTier: 'read', resources: ['read:nested-' + mode], maxIters: 2 }] }, 'nested_call_' + mode);
      return textFrames('NESTED_PARENT_DONE_' + mode);
    }
    return textFrames('APPROVED_NESTED_SOURCE');
  } });
  fs.writeFileSync(backgroundEvidence, 'NESTED_LOCAL_READ_EVIDENCE', 'utf8');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 12, defaultWorkspace: work, permissionMode: 'auto', engineMode: 'interactive',
    stewardEnabledV1: true, stewardPollMs: 120000, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, agentAutoWake: false,
    subagentMaxPerTurn: 4, subagentMaxConcurrent: 2, agentWorkflowMaxNodes: 4, agentTaskPoolPolicy: 'off',
    activeProvider: 'fake', providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'fixture', model: 'fake-model' }] }));
  port = await getFreePort();
  proc = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: path.resolve(__dirname, '../ruyi-workbench'), windowsHide: true, stdio: 'pipe', env: { ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, WCW_POOL_GRACE_MS: '0', WCW_TEST_NO_NET_ANCHORS: '1' } });
  let output = ''; for (const stream of [proc.stdout, proc.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
  if (!await waitForHttp(port, 'GET', '/health', response => response.status === 200)) throw Error('workbench not ready: ' + output);
  token = (await post('/api/bootstrap', {}))?.json?.token; if (!token) throw Error('bootstrap token missing');
  const a = (await post('/api/sessions', { title: 'Approved nested source', cwd: work })).json.session.id;
  const chat = await post('/api/chat/stream', { sessionId: a, message: 'NESTED_APPROVED_SOURCE', cwd: work });
  t.ok(chat.status === 200 && chat.text.includes('"type":"result"'), 'source A completes through actual HTTP and shared fakeProvider');
  const source = await approval(a); await journey(a, source, false); await journey(a, source, true);
  t.ok(fake.errors.length === 0, 'shared fakeProvider reports no handler errors');
} catch (e) { t.fail(e.stack || String(e)); } finally { releaseBackground(); if (proc) await killOwnTree(proc); if (fake) await fake.close(); } t.done(); })();
