'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..');
const fromRepo = name => path.join(ROOT, name);
const { fixtureChildEnv } = require(fromRepo('dev-harness/lib/fixture-home.js'));
const { killOwnTree } = require(fromRepo('dev-harness/lib/kill-own-tree.js'));
const { createRetentionEvidence } = require(fromRepo('dev-harness/lib/external-bots-retention-evidence.js'));
const { getFreePort } = require(fromRepo('dev-harness/free-port.js'));
const { startFakeProvider, textFrames, toolCallFrames } = require(fromRepo('dev-harness/lib/fake-openai-provider.js'));
const { FAKE_BOT_ENV, qqWire, feishuWire, feishuEvent } = require(fromRepo('dev-harness/lib/external-bot-fixtures.js'));
const { assertThat, platformText, findView, assertStagedPage } = require('./journey-contract.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Caller caps, not product performance claims. Original request cap is 45s;
// stream cap follows the existing 300s permission prompt. Each selected action
// reserves 300s plus 60s transport/setup, with distinct startup/cleanup reserves.
const BUDGET = Object.freeze({ request: 45000, stream: 300000, journey: 360000, startup: 180000, cleanup: 120000 });
function remaining(deadline, cap = BUDGET.request) {
  const value = Math.min(cap, deadline - Date.now());
  if (value <= 0) throw Error('C2 caller absolute deadline'); return value;
}
async function waitWithin(work, deadline, label, cancel = () => {}) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { cancel(); reject(Error(label + ': absolute deadline')); }, remaining(deadline, 2147483647)); })]); }
  finally { clearTimeout(timer); }
}
// Narrow caller bookkeeping around already-held original ChildProcess objects.
// Original retention evidence records bytes/events; these facts support awaiting
// actual close. There is no process table, PID lookup or replacement child here.
function observeHeldChild(child, role, metadata = {}) {
  let resolveClose;
  const facts = { role, pid: child.pid || null, stdio: metadata.stdio, spawn: false, error: null, exit: null, close: null, streams: {} };
  const closed = new Promise(resolve => { resolveClose = resolve; });
  child.on('spawn', () => { facts.spawn = true; facts.pid = child.pid; });
  child.on('error', error => { facts.error = { code: error.code || '', message: error.message }; });
  child.on('exit', (code, signal) => { facts.exit = { code, signal }; });
  child.on('close', (code, signal) => { facts.close = { code, signal }; resolveClose(facts.close); });
  for (const name of ['stdout', 'stderr']) {
    const stream = child[name];
    const row = facts.streams[name] = stream ? { availability: 'original-pipe', end: false, close: false, error: null } : { availability: 'ignored-or-unavailable', end: null, close: null, error: null };
    if (stream) { stream.on('end', () => { row.end = true; }); stream.on('close', () => { row.close = true; }); stream.on('error', error => { row.error = error.message; }); }
  }
  return { child, facts, closed, killReceipt: null };
}
function knownClosed(row) {
  return row.facts.spawn && !row.facts.error && row.facts.exit && row.facts.close
    && row.facts.exit.code === row.facts.close.code && row.facts.exit.signal === row.facts.close.signal
    && Object.values(row.facts.streams).every(stream => stream.availability !== 'original-pipe' || stream.end && stream.close && !stream.error);
}
function knownCleanup(row) { return Boolean(knownClosed(row) && (!row.killReceipt?.skipped || row.killReceipt.skipped === 'root-exited')); }
// Retain exactly the original fake provider startup. A caller timeout never
// cancels that helper's listen promise, so late ownership must remain reachable.
function retainProviderStartup(pending, own, record, cleanupDeadline) {
  let value = null, startupError = null, closePromise = null, retentionPromise = null, evidenceError = null;
  const diagnosticErrors = [];
  const state = { phase: 'pending', settled: false, closeRequested: false, closeStatus: 'not-requested', listenerCloseObserved: false, rejection: null, closeError: null };
  const snapshot = () => ({ ...state, diagnosticErrors: diagnosticErrors.slice() });
  const note = (type, data) => { try { record(type, data); } catch (error) { diagnosticErrors.push({ type, code: error.code || '', message: error.message }); } };
  const incompleteEvidence = () => { evidenceError ||= Object.assign(Error('provider retention evidence incomplete'), { code: 'C2_EVIDENCE_INCOMPLETE' }); return evidenceError; };
  const closeOwned = () => {
    if (!closePromise) {
      state.closeStatus = 'pending';
      // Install the close obligation before any diagnostic operation. Its
      // original close still runs if the original evidence writer throws EIO.
      closePromise = waitWithin(Promise.resolve().then(() => value.close()), Math.min(cleanupDeadline, Date.now() + BUDGET.cleanup), 'retained original provider close')
        .then(() => { assertThat(state.listenerCloseObserved && value.server.listening === false, 'original provider close event/callback unproven'); state.closeStatus = 'closed'; note('c2-provider-close-observed', snapshot()); if (diagnosticErrors.length) throw incompleteEvidence(); })
        .catch(error => { state.closeStatus = state.closeStatus === 'closed' ? 'closed-evidence-incomplete' : 'failed'; state.closeError = error.message; note('c2-provider-close-failed', snapshot()); throw error; });
      closePromise.catch(() => {});
      note('c2-provider-close-requested', snapshot());
    }
    return closePromise;
  };
  const started = Promise.resolve(pending).then(provider => {
    value = provider; own(provider); state.phase = 'resolved'; state.settled = true;
    provider.server.once('close', () => { state.listenerCloseObserved = true; note('c2-provider-listener-close', snapshot()); });
    // Owner and close observer exist before recording; diagnostic failure may
    // reject new work, but can never skip an already-requested original close.
    if (state.closeRequested) { const closing = closeOwned(); note('c2-provider-startup-resolved', snapshot()); return closing.then(() => provider); }
    note('c2-provider-startup-resolved', snapshot());
    if (diagnosticErrors.length) throw incompleteEvidence();
    return provider;
  }, error => { startupError = error; state.phase = 'rejected'; state.settled = true; state.rejection = { code: error.code || '', message: error.message }; note('c2-provider-startup-rejected', snapshot()); throw error; });
  started.catch(() => {});
  return { started, snapshot, requestClose() {
    state.closeRequested = true;
    if (retentionPromise) return retentionPromise;
    if (state.phase === 'resolved') retentionPromise = closeOwned();
    else if (state.phase === 'rejected') retentionPromise = Promise.reject(startupError);
    else { state.closeStatus = 'awaiting-startup'; retentionPromise = started.then(() => closeOwned()); }
    retentionPromise.catch(() => {});
    note('c2-provider-startup-retained-pending', snapshot());
    return retentionPromise;
  } };
}
function callbackSettlement(response, row) {
  // Only exact known admission refusals count synchronously. Storage failure,
  // malformed response or server error can hide a durable commit and remain RED.
  const code = response?.json?.error?.code || response?.json?.code || '';
  if (row && ['completed', 'failed'].includes(row.execution?.status) && row.execution.finishedAt
    && row.delivery && ['sent', 'failed', 'cancelled'].includes(row.delivery.status)) return { kind: 'original-worker-terminal', item: row };
  if (!row && (response?.status === 409 && code === 'external_channel.delivery_changed'
    || response?.status === 400 && code === 'external_channel.request_invalid')) return { kind: 'synchronous-rejection', status: response.status, code, originalInboxItemAbsent: true };
  return null;
}
async function until(fn, label, budget = 45000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(40); }
  throw new Error('timeout: ' + label);
}
function scriptModel(work, { output, io = fs } = {}) {
  const { locateCurrentUser, hash } = require('./forge-observation.cjs');
  const requests = [], errors = [], held = new Map(), received = [];
  let expected = null;
  async function handler(req) {
    const index = requests.length;
    requests.push(req.body);
    try {
      const body = JSON.parse(JSON.stringify(req.body));
      const record = { index, receivedAt: new Date().toISOString(), raw: typeof req.raw === 'string' ? req.raw : null,
        rawAvailable: typeof req.raw === 'string', body, expected, captureFile: '', captureError: null };
      // Reception is recorded before matching, responding, or a later oracle.
      // A browser adapter may expose parsed messages only: say so and retain the
      // exact received current user instead of inventing original raw HTTP bytes.
      if (!output || !path.isAbsolute(output)) throw Error('provider reception requires an absolute evidence directory');
      record.captureFile = path.join(output, 'provider-request-' + String(index).padStart(5, '0') + '.json');
      const bytes = JSON.stringify(record, null, 2) + '\n';
      try { io.writeFileSync(record.captureFile, bytes, { flag: 'wx' }); }
      catch (error) { record.captureError = error.code || error.message; received.push(record); throw error; }
      record.captureSha256 = hash(bytes); received.push(record);
      if (record.rawAvailable && JSON.stringify(JSON.parse(record.raw)) !== JSON.stringify(body)) {
        record.captureError = 'raw_body_mismatch'; throw Error('provider raw/body mismatch');
      }
      const messages = req.messages || req.body.messages || [];
      const allUser = messages.filter(row => row.role === 'user').map(row => String(row.content || '')).join('\n');
      const firstUser = String(messages.find(row => row.role === 'user')?.content || '').split('以下是前序节点结果')[0];
      const toolResults = messages.filter(row => row.role === 'tool');
      const call = (name, args) => toolCallFrames(name, args, 'call_c2_' + requests.length);
      if (expected && locateCurrentUser(body, expected)) return textFrames(expected.payload);
      if (allUser.includes('重规划审查员')) return textFrames(JSON.stringify({ changes: [{ op: 'add_node', target: 'c2_replan_added', to: 'C2_REPLAN_NEW', from: ['origin'], reason: '真实 review 填充建议' }] }));
      if (firstUser.includes('C2_POOL_PROPOSER')) {
        if (!toolResults.length) return call('propose_task', { task: 'C2_POOL_HELPER', reason: 'C2 real proposal' });
        return await new Promise(resolve => held.set('pool', () => resolve(textFrames('C2 proposer finished'))));
      }
      if (firstUser.includes('C2_POOL_HELPER')) return textFrames('C2_POOL_HELPER_ACTUAL_CONSUMED');
      if (firstUser.includes('C2_REPLAN_FAIL')) return textFrames('{"verdict":"fail","confidence":0.1,"summary":"C2 real gate rejection"}');
      if (firstUser.includes('C2_REPLAN_NEW')) return textFrames('C2_REPLAN_NEW_ACTUAL_CONSUMED');
      const marker = allUser.match(/C2_NATIVE_(permission|question|plan)_[a-z0-9_]+/)?.[0];
      if (!marker) return textFrames('C2 unrelated event complete');
      const type = marker.split('_')[2];
      if (type === 'question') {
        if (!toolResults.length) return call('request_user_input', { questions: [{ id: 'c2_original_q', header: 'C2选择', question: '选择原始稳定选项并补充', answerMode: 'multiple', allowOther: true, options: [{ id: 'c2_no', label: '否' }, { id: 'c2_yes', label: '是', description: '保留原始 ID' }] }] });
        return textFrames('C2_QUESTION_REAL_TOOL_RESULT ' + String(toolResults.at(-1).content));
      }
      if (type === 'plan' && !messages.some(row => row.role === 'user' && String(row.content || '').includes('<workbench-plan-approved>'))) return textFrames('PLAN:\n' + ('C2 逐字完整计划，先确认再写文件。\n'.repeat(100)));
      if (!toolResults.length) return call('file_write', { path: path.join(work(), marker + '.txt'), content: 'C2 原始参数\n中文 "quote" 12345678901234567890\n' });
      return textFrames('C2_NATIVE_TOOL_COMPLETE');
    } catch (error) { errors.push(error.message); throw error; }
  }
  return { handler, requests, received, errors, held,
    expectForge(value) { if (expected) throw Error('forge expectation already owned'); expected = value; },
    finishForge(value) { if (expected !== value) throw Error('forge expectation owner changed'); expected = null; },
    release: kind => { held.get(kind)?.(); held.delete(kind); } };
}
function createJourneyHome() {
  const isolated = fixtureChildEnv({ perTest: true });
  // The generic helper deliberately shares fake AppData caches across tests.
  // Independent C2 journeys need a fresh whole context, including both roots.
  isolated.env.LOCALAPPDATA = path.join(isolated.home, 'AppData', 'Local');
  isolated.env.APPDATA = path.join(isolated.home, 'AppData', 'Roaming');
  return isolated;
}
async function createActualFixture(options = {}) {
  assertThat(typeof options.output === 'string' && path.isAbsolute(options.output), 'C2 actual fixture requires its absolute evidence directory');
  const deadline = options.deadline || Date.now() + BUDGET.startup + BUDGET.journey;
  const cleanupDeadline = options.cleanupDeadline || deadline + BUDGET.cleanup;
  const lifetime = options.signal || AbortSignal.timeout(remaining(deadline, 2147483647));
  const isolated = createJourneyHome();
  let home = isolated.home, work = path.join(home, 'work'), server = null, browser = null, provider = null, port = 0, token = '', serial = 0;
  fs.mkdirSync(work, { recursive: true });
  const outbound = [], tokenRequests = [], streams = new Set(), stderr = [], model = scriptModel(() => work, { output: options.output }), children = [], cleanup = [];
  const evidence = createRetentionEvidence(options.browser ? 'browser' : 'http', { directory: options.output });
  let browserStarting = false, startupSettled = false, closePromise = null, providerStartup = null, providerRetention = null;
  const facts = () => ({ home, work, port, isolationHome: isolated.home, browserRoot: browser?.root || null, deadline, cleanupDeadline, modelRequests: model.requests.length, outboundCount: outbound.length, stderr,
    actors: children.map(row => ({ ...row.facts, killReceipt: row.killReceipt })), cleanup: cleanup.slice(), browserStarting, startupSettled, providerStartup: providerStartup?.snapshot() || null, descendantKernelExitCertified: false });
  const observeChild = (role, child, metadata) => { const row = observeHeldChild(child, role, metadata); children.push(row); evidence?.observeChild(role, child, metadata); return row; };
  const bounded = (work, label, cap = BUDGET.request) => waitWithin(work, Math.min(deadline, Date.now() + cap), label);
  const wait = (fn, label, cap = BUDGET.request) => bounded(until(fn, label, remaining(deadline, cap)), label, cap);
  const stopChild = async (row, closeDeadline = Math.min(cleanupDeadline, Date.now() + BUDGET.cleanup)) => {
    if (!row) return;
    if (!row.facts.close) { row.killReceipt = killOwnTree(row.child); evidence?.event('c2-kill-receipt', { role: row.facts.role, pid: row.child.pid, receipt: row.killReceipt, notKernelDeathProof: true }); }
    await waitWithin(row.closed, closeDeadline, 'held child close ' + row.facts.role);
    assertThat(knownCleanup(row), 'held-child lifecycle or killOwnTree boundary unproven: ' + row.facts.role + ' / ' + JSON.stringify(row.killReceipt));
    cleanup.push({ phase: 'held-child-closed', role: row.facts.role, pid: row.child.pid, killReceipt: row.killReceipt, scope: 'held child and original pipe facts; no descendant kernel-exit claim' });
  };
  const official = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}'), host = req.headers.host;
      if (req.url.includes('token') || req.url === '/app/getAppAccessToken') {
        tokenRequests.push({ host, path: req.url, body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(host === 'api.bot.qq.com' ? { access_token: 'C2_SYNTHETIC_TOKEN', expires_in: '7200' } : { code: 0, tenant_access_token: 'C2_SYNTHETIC_TOKEN', expire: 7200 })); return;
      }
      const row = { host, path: req.url, body, at: Date.now() }; outbound.push(row);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(host === 'api.bot.qq.com' ? { id: 'c2_sent_' + outbound.length } : { code: 0, data: { message_id: 'c2_sent_' + outbound.length } }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  let officialPort = 0;
  let faultDir = path.join(home, 'fault-control'); fs.mkdirSync(faultDir, { recursive: true });
  const preload = fromRepo('dev-harness/lib/external-channel-delivery-preload.js'), faultPreload = path.join(__dirname, 'actual-fault-preload.cjs');
  const config = { configSchema: 14, workDataEncryptionV1: false, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default', permissionTimeoutMs: 300000,
    includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, autoImportKimiCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false,
    stewardEnabledV1: true, stewardPollMs: 120000, missionAutoContinue: false, stewardThreadBriefV1: false, agentWorkflowMaxNodes: 8, subagentMaxPerTurn: 8,
    desktopMcp: { enabled: false, autodetect: false }, onboarding: { completedAt: '2026-10-30T00:00:00.000Z', version: 1, skipped: false } };
  const env = () => ({ ...isolated.env, ...FAKE_BOT_ENV, RUYI_BOT_TEST_F_APP: 'C2_SYNTHETIC_APP_SECRET', RUYI_FAKE_EXTERNAL_API_PORT: String(officialPort), RUYI_C2_FAULT_DIR: faultDir,
    RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_TEST_HOOKS: '0', NODE_OPTIONS: '' });
  const request = async (method, route, body, { admin = true, headers = {}, signal } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-wcw-token': token } : {}), ...headers },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }), signal: AbortSignal.any([lifetime, signal || AbortSignal.timeout(remaining(deadline))]) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text };
  };
  const start = async () => {
    remaining(deadline); assertThat(!lifetime.aborted, 'cancelled before original serve spawn');
    const old = token;
    server = cp.spawn(process.execPath, ['--require', preload, '--require', faultPreload, 'app/server.js', 'serve', '--port', String(port)], { cwd: fromRepo('ruyi-workbench'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: env() });
    observeChild('server-' + children.length, server, { stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', bytes => stderr.push(String(bytes)));
    await wait(async () => { try { return (await request('GET', '/health', undefined, { admin: false })).status === 200; } catch (error) { if (lifetime.aborted) throw error; return false; } }, 'original serve health');
    token = await wait(async () => {
      try { const runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')); if (runtime.pid !== server.pid || !runtime.token || runtime.token === old) return false;
        return (await request('GET', '/api/external-bots/connections', undefined, { admin: false, headers: { 'x-wcw-token': runtime.token } })).status === 200 && runtime.token; } catch { return false; }
    }, 'fresh actual serve token');
  };
  const stop = async () => { if (server) { await stopChild(children.find(row => row.child === server)); server = null; } };
  const close = async () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const closeDeadline = Math.min(cleanupDeadline, Date.now() + BUDGET.cleanup);
      model.release('pool'); for (const controller of streams) controller.abort();
      if (browserStarting && !startupSettled) throw Error('browser startup still pending; unknown ownership retained, no concurrent cleanup');
      const errors = [];
      // Stop only held original actors, preserve the exact helper receipts, then
      // let original browser close dispose its CDP/provider/profile resources.
      for (const row of children.slice().reverse()) { try { await stopChild(row, closeDeadline); } catch (error) { errors.push(error); break; } }
      if (!errors.length && browser) {
        try { browser.provider?.closeAllConnections?.(); await waitWithin(browser.close({ keepRoot: true }), closeDeadline, 'original browser fixture close'); cleanup.push({ phase: 'original-browser-close-returned', stdio: 'ignore: no pipe EOF evidence', profileCleanup: 'original exact-profile helper; no all-descendant kernel-exit claim' }); } catch (error) { errors.push(error); }
      }
      if (providerStartup) {
        try { providerRetention ||= providerStartup.requestClose(); await waitWithin(providerRetention, closeDeadline, 'pending/owned original provider settlement and close'); cleanup.push({ phase: 'fake-provider-startup-settled-and-close-observed', state: providerStartup.snapshot() }); } catch (error) { errors.push(error); }
      }
      try { official.closeAllConnections(); await waitWithin(new Promise((resolve, reject) => official.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())), closeDeadline, 'fake official close'); cleanup.push({ phase: 'fake-official-close-returned' }); } catch (error) { errors.push(error); }
      evidence?.finish(errors[0]);
      if (errors.length) { const error = errors[0]; error.c2CleanupErrors = errors.map(value => value.message); throw error; }
      assertThat(Date.now() <= closeDeadline, 'cleanup absolute budget exceeded');
      return { status: 'closed-held-actors-and-owned-listeners', facts: facts() };
    })(); return closePromise;
  };
  try {
    remaining(deadline); assertThat(!lifetime.aborted, 'cancelled before official fixture listen');
    await bounded(new Promise((resolve, reject) => { official.once('error', reject); official.listen(0, '127.0.0.1', resolve); }), 'fake official listen');
    officialPort = official.address().port;
    if (options.browser) {
      remaining(deadline); assertThat(!lifetime.aborted, 'cancelled before original browser fixture start');
      const { startBrowserFixture } = require(fromRepo('dev-harness/lib/browser-fixture.js'));
      browserStarting = true;
      const startup = startBrowserFixture({ ok: options.ok, prefix: 'ruyi-c2-actual-', config,
        evidenceObserver: { ...evidence.observer,
          beforeStart(fx) { browser = fx; home = fx.home; work = fx.work; port = fx.appPort; evidence.observer.beforeStart(fx); },
          child: observeChild,
        },
        serverEnv: { ...env(), NODE_OPTIONS: '--require "' + preload + '" --require "' + faultPreload + '"' },
        provider: async ctx => { const frames = await model.handler({ body: ctx.body, messages: ctx.messages }); for (const frame of frames || []) ctx.sse(frame); },
        prepare: async fx => { assertThat(!lifetime.aborted && Date.now() < deadline, 'cancelled original browser startup'); home = fx.home; work = fx.work; port = fx.appPort; token = fx.token; },
      });
      startup.finally(() => { startupSettled = true; }).catch(() => {});
      browser = await bounded(startup, 'original browser startup', BUDGET.startup);
      // The control directory intentionally stays in the already isolated first home.
    } else {
      remaining(deadline); assertThat(!lifetime.aborted, 'cancelled before fake provider start');
      evidence.bind({ home });
      providerStartup = retainProviderStartup(startFakeProvider({ handler: model.handler }), owned => { provider = owned; }, (type, data) => evidence.event(type, data), cleanupDeadline);
      await bounded(providerStartup.started, 'fake provider startup');
      config.defaultWorkspace = work; config.workspaces = [{ path: work, read: true, write: true, exec: true }];
      config.providers = [{ id: 'fake', label: 'C2 Fake', type: 'openai-compat', baseUrl: provider.url, apiKey: 'C2_SYNTHETIC_KEY', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }];
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
      port = await getFreePort(); await start();
    }
  } catch (error) {
    let cleanupResult = null, cleanupError = null;
    try { cleanupResult = await close(); } catch (value) { cleanupError = value; }
    if (providerStartup && providerStartup.snapshot().closeStatus !== 'closed') {
      // Assign a live promise before invoking close in its microtask. Nothing
      // diagnostic on this error path can replace the original startup error.
      providerRetention ||= Promise.resolve().then(() => providerStartup.requestClose()); providerRetention.catch(() => {});
      error.c2ProviderRetention = { promise: providerRetention, snapshot: providerStartup.snapshot };
    }
    error.c2Evidence = { ...facts(), cleanupResult, cleanupError: cleanupError?.message || null }; throw error;
  }
  const connection = (platform = 'qq', group = false) => platform === 'qq' ? { id: 'qq_test', platform: 'qq', label: 'C2 QQ Offline', enabled: true, mode: 'control', appId: '12345678', tenantId: '12345678', botUserId: '',
    allowedSenderIds: ['qq_person'], allowedConversationIds: [group ? 'qq_room' : 'qq_person'], ownerSenderId: 'qq_person', ownerConversationId: group ? 'qq_room' : 'qq_person', ownerConversationType: group ? 'group' : 'direct', botSecretEnv: 'RUYI_BOT_TEST_Q_SECRET' }
    : { id: 'feishu_test', platform: 'feishu', label: 'C2 Feishu Offline', enabled: true, mode: 'control', appId: 'cli_fixture', tenantId: 'tenant_fixture', botUserId: 'ou_bot',
      allowedSenderIds: ['ou_person'], allowedConversationIds: ['oc_room'], ownerSenderId: 'ou_person', ownerConversationId: 'oc_room', ownerConversationType: group ? 'group' : 'direct', verificationTokenEnv: 'RUYI_BOT_TEST_F_TOKEN', encryptKeyEnv: 'RUYI_BOT_TEST_F_KEY', appSecretEnv: 'RUYI_BOT_TEST_F_APP' };
  const configure = async (platform = 'qq', group = false) => assertThat((await request('POST', '/api/external-bots/connections', { op: 'upsert', connection: connection(platform, group), controlConfirmed: true })).status === 200, 'actual local owner config');
  const wire = (id, text, platform = 'qq', options = {}) => {
    const eventId = options.eventId || id;
    if (platform === 'feishu') return feishuWire(feishuEvent({ messageId: id, eventId, text, senderId: options.senderId || 'ou_person', group: !!options.group }));
    return qqWire({ id: eventId, op: 0, t: options.group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', d: { id, content: text, timestamp: new Date().toISOString(), author: options.group ? { member_openid: options.senderId || 'qq_person' } : { user_openid: options.senderId || 'qq_person' }, ...(options.group ? { group_openid: 'qq_room' } : {}) } });
  };
  const callback = (id, text, platform = 'qq', options = {}) => {
    const packet = wire(id, text, platform, options); if (options.badSignature) { const key = platform === 'qq' ? 'x-signature-ed25519' : 'x-lark-signature'; packet.headers[key] = '00'.repeat(platform === 'qq' ? 64 : 32); }
    return request('POST', '/api/external-bots/callback/' + platform + '?connectionId=' + platform + '_test', packet.bytes, { admin: false, headers: packet.headers });
  };
  const nextId = label => 'c2_' + label + '_' + ++serial;
  const items = async () => (await request('GET', '/api/external-bots/inbox?limit=100')).json.items;
  const item = async id => (await items()).find(row => row.messageId === id);
  const delivered = id => wait(async () => { const row = await item(id); return row?.delivery?.status === 'sent' && row; }, 'original delivery ' + id);
  const settledCallback = async (id, response) => {
    return wait(async () => {
      const row = await item(id), settled = callbackSettlement(response, row);
      if (settled) return settled;
      assertThat(row || response.status === 200, 'callback admission unknown/refused without precise synchronous proof: ' + response.text);
      return null;
    }, 'same-message original worker settlement ' + id);
  };
  const sent = (id, platform = 'qq') => outbound.filter(row => platform === 'qq' ? row.host === 'api.bot.qq.com' && row.body.msg_id === id : row.host === 'open.feishu.cn' && row.path === '/open-apis/im/v1/messages/' + id + '/reply');
  const command = async (text, platform = 'qq', label = 'command') => { const id = nextId(label), response = await callback(id, text, platform); assertThat(response.status === 200, 'signed callback accepted: ' + response.text); const accepted = await delivered(id); const rows = sent(id, platform); assertThat(rows.length === 1, 'one original reply for ' + id); return { id, item: accepted, text: platformText(rows[0]) }; };
  const offer = async (iv, type, title, platform = 'qq') => {
    const listed = await command('/pending', platform, 'list');
    const handle = findView(listed.text, type, title); assertThat(handle, 'pending list names original ' + type + ' / ' + title + ': ' + listed.text);
    const pages = []; let code = '', page = 1, identity = null;
    while (page <= 1024) {
      const shown = await command('/pending ' + handle + ' ' + page, platform, 'page'); pages.push(shown);
      const staged = assertStagedPage(ledger(), shown.item, { handle, page, type, sessionId: iv.sessionId || iv.missionId, interventionId: iv.id }, identity);
      const marker = staged.marker; identity ||= marker;
      assertThat(shown.text.startsWith(staged.item.execution.replyText), 'actual platform page contains the original staged content');
      code = shown.text.match(/ra_[A-Za-z0-9_-]{22}/)?.[0] || '';
      if (page < marker.pages) assertThat(!code, 'no raw code before complete view delivery');
      if (page === marker.pages) { assertThat(code, 'complete original view publishes one-use code'); break; }
      page++;
    }
    return { iv, handle, code, pages };
  };
  const createSession = async (title, permissionMode = 'default', cwd = work) => {
    const created = await request('POST', '/api/sessions', { title, cwd }); assertThat(created.status === 200 && created.json?.session?.id, 'original session creation');
    const sid = created.json.session.id;
    const changed = await request('POST', '/api/sessions/' + sid, { permissionMode, engineRoute: { engine: 'openai', providerId: 'fake', model: 'fake-model' } }, { headers: { 'x-http-method': 'PATCH' } });
    assertThat(changed.status === 200, 'original session route/mode'); return sid;
  };
  const stream = (sid, message, cwd = work) => {
    const events = [], controller = new AbortController(); streams.add(controller);
    const signal = AbortSignal.any([lifetime, controller.signal, AbortSignal.timeout(remaining(deadline, BUDGET.stream))]);
    const done = (async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token }, body: JSON.stringify({ sessionId: sid, message, cwd }), signal });
      assertThat(response.status === 200, 'original stream admitted');
      let buffer = ''; const decode = new TextDecoder();
      for await (const chunk of response.body) { buffer += decode.decode(chunk, { stream: true }); let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (line) events.push(JSON.parse(line)); } }
      buffer += decode.decode(); if (buffer.trim()) events.push(JSON.parse(buffer)); return events;
    })(); done.catch(() => {}); done.finally(() => streams.delete(controller)).catch(() => {}); return { events, done, controller };
  };
  const pending = async (sid, type) => wait(async () => { const r = await request('GET', '/api/interventions'); assertThat(r.status === 200, 'original intervention read'); return r.json.pending?.find(iv => iv.type === type && (iv.sessionId === sid || iv.missionId === sid)); }, 'original ' + type + ' consumer');
  const journalFile = sid => path.join(home, 'sessions', sid + '.interventions.ndjson');
  const journal = sid => fs.readFileSync(journalFile(sid), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ledger = () => JSON.parse(fs.readFileSync(path.join(home, 'external-bots/state-v1.json'), 'utf8'));
  const readRun = async (sid, runId) => { const r = await request('GET', '/api/agent-runs/' + runId + '?sessionId=' + sid); assertThat(r.status === 200 && r.json?.run, 'original run reader'); return r.json.run; };
  const launch = async (sid, nodes, poolPolicy = 'off') => { const r = await request('POST', '/api/agent-workflow/launch', { token, sessionId: sid, nodes, poolPolicy, async: true }); assertThat(r.status === 200 && r.json?.runId, 'original workflow launch: ' + r.text); return r.json.runId; };
  return { get home() { return home; }, get work() { return work; }, get port() { return port; }, get token() { return token; }, get server() { return server; }, output: options.output, browser, model, outbound, tokenRequests, stderr,
    request, configure, connection, wire, callback, nextId, items, item, delivered, settledCallback, sent, command, offer, createSession, stream, pending, journalFile, journal, ledger, readRun, launch, start, stop, close, faultDir, bounded, wait,
    setFault: spec => fs.writeFileSync(path.join(faultDir, 'fault.json'), JSON.stringify(spec)),
    clearFault: () => { try { fs.unlinkSync(path.join(faultDir, 'fault.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    evidence: facts,
  };
}
module.exports = { ROOT, BUDGET, remaining, waitWithin, observeHeldChild, knownClosed, knownCleanup, retainProviderStartup, callbackSettlement, until, delay, scriptModel, createJourneyHome, createActualFixture };
