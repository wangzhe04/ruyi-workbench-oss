'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createExpectation, observeReceived, hash } = require('./forge-observation.cjs');
const { ROOT, BUDGET, createActualFixture } = require('./actual-http-fixture.cjs');
const { assertThat, actionCommand, inspectTerminal } = require('./journey-contract.cjs');
const { createRunner } = require(path.join(ROOT, 'dev-harness/lib/harness.js'));
const { unclaimedColdOfferJourney } = require('./unclaimed-cold-offer.cjs');
const NATIVE = ['permission', 'question', 'plan'];
const ACTIONS = { permission: ['allow', 'deny'], question: ['answer'], plan: ['approve', 'reject'], pool: ['approve', 'reject'], replan: ['approve', 'reject'] };
const PLATFORM = { permission: 'qq', question: 'feishu', plan: 'qq', pool: 'feishu', replan: 'qq' };
async function browserPending(fx, iv, type, output) {
  const b = fx.browser; if (!b) return;
  await fx.bounded(b.setLens('steward'), 'browser lens');
  await fx.bounded(b.evaluate(`document.getElementById('stewardDecisionsBtn').click(), true`), 'browser open decisions');
  const selector = '.steward-decision[data-intervention-id="' + iv.id + '"]';
  const row = await fx.bounded(b.waitForEval(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); if(!n||n.dataset.phase!=='pending')return null;n.open=true;return {text:n.textContent,phase:n.dataset.phase};})()`), 'browser exact pending');
  assertThat(row && row.text.includes(iv.id), type + ': original browser renders this actual pending identity');
  fs.writeFileSync(path.join(output, type + '-' + iv.id + '-pending.png'), await fx.bounded(b.screenshot(), 'browser pending screenshot'));
}
async function browserTerminal(fx, iv, type, status, output) {
  const b = fx.browser; if (!b) return;
  // Use the existing refresh button; never construct local receipt DOM/state.
  await fx.bounded(b.evaluate(`(() => { const host=document.querySelector('.steward-task-decisions'); const refresh=host?.querySelector(':scope > button');if(!refresh)return false;refresh.click();return true;})()`), 'browser refresh terminal');
  const selector = '.steward-decision[data-intervention-id="' + iv.id + '"]';
  const controlSelector = type === 'question' ? '.steward-decision-question input, .steward-decision-question textarea' : '[data-action]';
  const value = await fx.bounded(b.waitForEval(`(() => {const n=document.querySelector(${JSON.stringify(selector)});const controls=n?[...n.querySelectorAll(${JSON.stringify(controlSelector)})]:[];return n?.dataset.phase==='settled'?{phase:n.dataset.phase,text:n.textContent,badge:n.querySelector('[data-receipt-badge]')?.textContent||'',controls:controls.length,disabled:controls.every(x=>x.disabled)}:null;})()`), 'browser authoritative settled');
  const locale = await fx.bounded(b.evaluate(`String(window.state?.config?.locale || 'zh-CN')`), 'browser locale');
  assertThat(['zh-CN', 'en-US'].includes(locale), 'browser receipt locale must be known');
  const expectedStatusText = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/public/locales', locale + '.json'), 'utf8'))['decisions.status.' + status];
  assertThat(value && value.controls > 0 && value.disabled && expectedStatusText && value.badge === expectedStatusText, type + ': browser reads authoritative ' + status + ' and disables original nonempty controls');
  fs.writeFileSync(path.join(output, type + '-' + iv.id + '-settled.png'), await fx.bounded(b.screenshot(), 'browser settled screenshot'));
  await fx.bounded(b.escape(), 'browser close decisions');
}
async function nativePending(fx, type, action, sequence) {
  const title = 'C2_' + type + '_' + action + '_' + sequence;
  const sid = await fx.createSession(title, type === 'plan' ? 'plan' : 'default');
  const marker = 'C2_NATIVE_' + type + '_' + action + '_' + sequence;
  const stream = fx.stream(sid, marker);
  const iv = await fx.pending(sid, type);
  assertThat(iv.deliverable === true, type + ': original live consumer is deliverable');
  const eventName = { permission: 'permission_request', question: 'ask_user', plan: 'plan' }[type];
  await fx.wait(() => stream.events.some(event => event.type === eventName), type + ': original live stream prompt');
  return { type, action, title, sid, iv, stream, target: path.join(fx.work, marker + '.txt') };
}
async function workflowPending(fx, type, action, sequence) {
  const title = 'C2_' + type + '_' + action + '_' + sequence, sid = await fx.createSession(title);
  const nodes = [{ id: 'origin', task: type === 'pool' ? 'C2_POOL_PROPOSER' : 'C2_REPLAN_FAIL', toolTier: 'read', engine: 'openai',
    ...(type === 'replan' ? { replan: true, gate: { mode: 'verify', minConfidence: 0.5 } } : {}) }];
  const runId = await fx.launch(sid, nodes, type === 'pool' ? 'manual' : 'off');
  const iv = await fx.pending(sid, type);
  if (type === 'pool') await fx.wait(() => fx.model.held.has('pool'), 'original proposer is live and held after real propose_task');
  else await fx.wait(async () => {
    const run = await fx.readRun(sid, runId); const patch = run.replanPatches?.find(row => row.id === iv.id);
    return !run.live && patch?.status === 'pending' && patch.changesSource === 'review' && patch.changes?.length === 1;
  }, 'original finished run and original reviewer generated nonempty patch');
  return { type, action, title, sid, iv, runId, ...(type === 'pool' ? { proposerRelease: fx.model.held.get('pool') } : {}) };
}
async function assertEffect(fx, scenario, terminal) {
  const { type, action, iv, sid } = scenario;
  if (NATIVE.includes(type)) {
    const events = await fx.bounded(scenario.stream.done, 'original native stream completion');
    if (type === 'question') {
      const answer = terminal.answer?.answers?.[0];
      assertThat(answer?.questionId === 'c2_original_q' && answer.selectedOptionIds?.join() === 'c2_yes' && answer.otherText === 'C2 自定义补充', 'original stable question/option IDs and canonical answer retained');
      assertThat(terminal.decisionResponse.delivered === true && events.some(row => row.type === 'question_answer' && row.ok === true), 'original question consumer confirms delivery');
      assertThat(fx.model.requests.some(body => body.messages?.some(row => row.role === 'tool' && String(row.content).includes('C2 自定义补充') && String(row.content).includes('c2_yes'))), 'actual provider continuation received original normalized tool result');
    } else {
      const positive = action === 'allow' || action === 'approve';
      assertThat(fs.existsSync(scenario.target) === positive, type + ': actual filesystem side effect follows original decision');
      if (positive) assertThat(fs.readFileSync(scenario.target, 'utf8') === 'C2 原始参数\n中文 "quote" 12345678901234567890\n', type + ': original consumer executes exact unmodified parameters');
      assertThat(terminal.decisionResponse.delivered === true, type + ': original runtime consumer confirms delivery');
      if (type === 'plan') assertThat(terminal.feedback === 'C2 完整计划反馈', 'original plan feedback reaches terminal');
    }
    return;
  }
  const run = await fx.readRun(sid, scenario.runId);
  if (type === 'pool') {
    const original = run.taskPool.find(row => row.id === iv.id);
    if (action === 'approve') {
      assertThat(original?.status === 'materialized' && original.resultNodeId === terminal.decisionResponse.nodeId, 'original pool consumer materializes its own recorded node');
      const completed = await fx.wait(async () => { const r = await fx.readRun(sid, scenario.runId); const n = r.nodes.find(row => row.id === original.resultNodeId); return n?.status === 'succeeded' && n; }, 'original scheduler consumes materialized pool node');
      assertThat(String(completed.result) === 'C2_POOL_HELPER_ACTUAL_CONSUMED', 'original scheduler/model executed materialized helper');
    } else assertThat(original?.status === 'rejected' && !original.resultNodeId, 'original pool rejection leaves no replacement node');
  } else {
    const patch = run.replanPatches.find(row => row.id === iv.id);
    assertThat(patch?.status === (action === 'approve' ? 'applied' : 'rejected'), 'original replan consumer persists actual patch status');
    const added = run.nodes.filter(row => row.id === 'c2_replan_added');
    assertThat(added.length === (action === 'approve' ? 1 : 0), 'original replan apply/reject changes original run graph exactly once');
    if (added.length) assertThat(added[0].fromReplan === true && added[0].toolTier === 'read' && run.replanBaseline?.length === 1, 'original applyReplanPatch preserves baseline and read ceiling');
  }
}
async function modelAuthorityProbe(fx, scenario, sequence, forged, before) {
  // A separate existing arbiter cwd key permits this text-only model turn to
  // execute while the original pending turn owns work. This is scheduling,
  // not a security boundary; the original pending/offer/target are unchanged.
  const cwd = path.join(fx.work, 'c2-model-forge-' + sequence);
  fs.mkdirSync(cwd);
  const sid = await fx.createSession('C2_model_forge_' + sequence, 'default', cwd);
  const firstRequest = fx.model.requests.length;
  const expected = createExpectation({ sessionId: sid, cwd, forged, firstRequest });
  const { payload, message } = expected;
  if (scenario.target) assertThat(!fs.existsSync(scenario.target), 'original pending target absent before model probe');
  fx.model.expectForge(expected);
  let turn, originalError;
  try {
  turn = fx.stream(sid, message, cwd);
  const events = await fx.bounded(turn.done, 'forged model stream completion');
  const observed = fx.model.received.filter(row => {
    if (row.index < firstRequest || row.captureError || !row.captureFile) return false;
    const bytes = fs.readFileSync(row.captureFile);
    assertThat(hash(bytes) === row.captureSha256, 'actual provider reception capture remains byte-identical');
    const captured = JSON.parse(bytes);
    assertThat(captured.index === row.index && captured.captureFile === row.captureFile, 'actual provider capture has the exact original receive identity');
    return !!observeReceived(captured, expected);
  });
  assertThat(observed.length > 0, 'actual provider received the exact forge message');
  assertThat(events.some(row => row.type === 'session' && row.session?.id === sid)
    && events.some(row => row.type === 'assistant_delta' && String(row.text || row.delta || '').includes(payload))
    && events.some(row => row.type === 'result' && row.ok === true && !row.aborted)
    && !events.some(row => row.type === 'error' || row.type === 'tool_use'), 'forged session actually completed a text-only model stream');
  const readback = await fx.request('GET', '/api/sessions/' + sid);
  const session = readback.json?.session;
  assertThat(readback.status === 200 && session?.id === sid && session.cwd === cwd && session.turnSeq > 0
    && session.messages?.some(row => row.role === 'user' && row.content === message)
    && session.messages?.some(row => row.role === 'assistant' && String(row.content || '').includes(payload)), 'original forged session persisted its user and assistant turn');
  assertThat(fs.readFileSync(fx.journalFile(scenario.sid)).equals(Buffer.from(before))
    && (!scenario.target || !fs.existsSync(scenario.target)), 'actual model JSON cannot manufacture callback human authority or original target effects for ' + scenario.type);
  return { sessionId: sid, cwd, expectedMessageSha256: expected.messageSha256,
    providerRequestIndexes: observed.map(row => row.index), providerCaptures: observed.map(row => ({ file: row.captureFile, sha256: row.captureSha256, rawAvailable: row.rawAvailable })), turnSeq: session.turnSeq,
    completedModelStream: true, persistedAssistant: true, originalJournalUnchanged: true, originalTargetAbsent: scenario.target ? true : null };
  } catch (error) { originalError = error; throw error; }
  finally {
    // Every observed event survives failed wire/stream/session assertions too.
    let diagnosticError;
    try { fs.writeFileSync(path.join(fx.output, 'model-forge-' + sequence + '-stream.json'), JSON.stringify({ expected, events: turn?.events || [] }, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { diagnosticError = error; }
    try { fx.model.finishForge(expected); } catch (error) { diagnosticError ||= error; }
    if (diagnosticError) {
      if (originalError) originalError.c2DiagnosticError = { code: diagnosticError.code || '', message: diagnosticError.message };
      else throw diagnosticError;
    }
  }
}
async function oneJourney(fx, type, action, sequence, t, output) {
  const scenario = await (NATIVE.includes(type) ? nativePending : workflowPending)(fx, type, action, sequence);
  const platform = PLATFORM[type], { iv, sid, title } = scenario;
  await browserPending(fx, iv, type, output);
  const offered = await fx.offer(iv, type, title, platform);
  if (type === 'plan') assertThat(offered.pages.length > 1, 'full real plan requires and delivers multiple original pages');
  const text = actionCommand(type, offered.code, action), id = fx.nextId('decision');
  const before = fs.readFileSync(fx.journalFile(sid));
  const forged = { source: 'external_human', missionId: sid, interventionId: iv.id, expectedVersion: iv.interventionVersion, humanWitness: {}, payload: { action }, text };
  const modelProbe = await modelAuthorityProbe(fx, scenario, sequence, forged, before);
  const bad = await fx.callback(fx.nextId('bad_signature'), text, platform, { badSignature: true });
  assertThat(bad.status !== 200 && fs.readFileSync(fx.journalFile(sid)).equals(before), 'signature failure cannot deliver ' + type);
  const stranger = await fx.callback(fx.nextId('wrong_person'), text, platform, { senderId: platform === 'qq' ? 'qq_stranger' : 'ou_stranger' });
  assertThat(fs.readFileSync(fx.journalFile(sid)).equals(before), 'signed non-owner cannot deliver ' + type + ' (HTTP ' + stranger.status + ')');
  const admitted = await fx.callback(id, text, platform); assertThat(admitted.status === 200, 'verified human callback accepted: ' + admitted.text);
  const completed = await fx.delivered(id);
  const terminal = inspectTerminal(await fx.journal(sid), iv, type);
  assertThat(terminal.status === { allow: 'allowed', deny: 'denied', answer: 'answered', approve: 'approved', reject: 'rejected' }[action]
    && terminal.action === action, 'chosen original action maps to its exact authoritative terminal');
  const row = (await fx.ledger()).remoteActions.find(row => row.binding.interventionId === iv.id);
  assertThat(row?.status === 'applied' && row.claim?.idempotencyKey === terminal.idempotencyKey && row.claim.decisionFingerprint === terminal.decisionFingerprint, 'original bot/core share exact claim and authoritative result');
  assertThat(completed.execution.status === 'completed' && completed.delivery.status === 'sent', 'original acceptance/execution/delivery facts remain separate');
  assertThat(!JSON.stringify(await fx.ledger()).includes(offered.code), 'raw action code is not persisted in original bot ledger');
  if (type === 'pool') {
    assertThat(typeof scenario.proposerRelease === 'function' && fx.model.held.get('pool') === scenario.proposerRelease, 'only the same original held proposer is released after authoritative terminal and exact claim');
    fx.model.release('pool');
    await fx.wait(async () => { const run = await fx.readRun(sid, scenario.runId); return run.nodes.find(node => node.id === iv.proposedBy)?.status === 'succeeded'; }, 'original proposer finishes after the verified decision');
  }
  await assertEffect(fx, scenario, terminal);
  const journalAfter = fs.readFileSync(fx.journalFile(sid)), originalSends = fx.sent(id, platform).length;
  await fx.callback(id, text, platform, { eventId: fx.nextId('duplicate_event') });
  await fx.command(text, platform, 'claimed_code_reuse');
  assertThat(fs.readFileSync(fx.journalFile(sid)).equals(journalAfter) && fx.sent(id, platform).length === originalSends, 'duplicate callback and claimed-code reuse never write another core phase or resend original attempt');
  inspectTerminal(await fx.journal(sid), iv, type);
  await browserTerminal(fx, iv, type, terminal.status, output);
  if (type === 'pool') {
    const after = await fx.readRun(sid, scenario.runId), nodes = after.nodes.filter(node => node.id === terminal.decisionResponse.nodeId);
    assertThat(action === 'approve' ? nodes.length === 1 && nodes[0].status === 'succeeded' && nodes[0].result === 'C2_POOL_HELPER_ACTUAL_CONSUMED'
      && nodes[0].attempts === 1 && nodes[0].fromPool === true && nodes[0].proposedBy === iv.proposedBy
      : !after.nodes.some(node => node.fromPool && node.proposedBy === iv.proposedBy), 'duplicate/reuse leaves the original pool helper effect exactly once or absent after rejection');
  }
  const sealedStorage = fx.sealed ? await fx.assertSealed(sid, [title, offered.code, type === 'question' ? '选择原始稳定选项并补充' : 'C2_POOL_HELPER']) : null;
  const sealedRunSnapshot = fx.sealed && type === 'pool' && action === 'approve'
    ? await fx.assertSealedRun(sid, scenario.runId, [title, offered.code, 'C2_POOL_PROPOSER', 'C2_POOL_HELPER', 'C2_POOL_HELPER_ACTUAL_CONSUMED'],
      { coldRestart: true, requiredPlaintext: ['C2_POOL_HELPER', 'C2_POOL_HELPER_ACTUAL_CONSUMED'] }) : null;
  const coldRestart = fx.sealed && type === 'question' ? await coldRestartJourney(fx, scenario, { offered, text, id, terminal, platform }, t, output) : null;
  const evidence = { type, action, platform, sessionId: sid, interventionId: iv.id, status: terminal.status, pages: offered.pages.length, botItemId: completed.id, botAttemptId: completed.delivery.attemptId,
    coreIdempotencyKey: terminal.idempotencyKey, coreFingerprint: terminal.decisionFingerprint, source: terminal.source, runId: scenario.runId || '', modelProbe };
  if (fx.sealed) Object.assign(evidence, { sealedStorage, sealedRunSnapshot, coldRestart });
  fs.writeFileSync(path.join(output, type + '-' + action + '.json'), JSON.stringify(evidence, null, 2));
  t.ok(true, type + '/' + action + ': actual HTTP/callback/original consumer/terminal once' + (fx.browser ? '/browser receipt' : ''));
  return evidence;
}
async function coldBrowserPendingAbsence(fx, iv, output) {
  const b = fx.browser, requests = new Map(), diagnostic = { requests: [], response: null, dom: null };
  let active = true, originalError;
  // Observe the existing modal's own GET, not a parallel test fetch or a DOM
  // injected receipt. A fresh page has no local attempt for a remote decision.
  b.cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (!active || request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin === 'http://127.0.0.1:' + fx.port && url.pathname === '/api/interventions' && url.searchParams.get('view') === 'steward') {
      const row = { requestId, path: url.pathname + url.search, status: null, finished: false };
      requests.set(requestId, row); diagnostic.requests.push(row);
    }
  });
  b.cdp.on('Network.responseReceived', ({ requestId, response }) => { if (active && requests.has(requestId)) requests.get(requestId).status = response.status; });
  b.cdp.on('Network.loadingFinished', ({ requestId }) => { if (active && requests.has(requestId)) requests.get(requestId).finished = true; });
  b.cdp.on('Network.loadingFailed', ({ requestId, errorText }) => { if (active && requests.has(requestId)) requests.get(requestId).error = errorText; });
  try {
    await fx.bounded(b.cdp.send('Network.enable'), 'cold browser network observation');
    await fx.bounded(b.evaluate("document.getElementById('stewardDecisionsBtn').click(), true"), 'cold browser decisions');
    const response = await fx.wait(() => diagnostic.requests.find(row => row.finished && row.status === 200 && !row.error), 'fresh modal actual pending GET 200 completion');
    const body = await fx.bounded(b.cdp.send('Network.getResponseBody', { requestId: response.requestId }), 'fresh modal actual pending body');
    const raw = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    diagnostic.response = { requestId: response.requestId, status: response.status, raw };
    const data = JSON.parse(raw);
    diagnostic.response.data = data;
    const locale = await fx.bounded(b.evaluate("String(window.state?.config?.locale || 'zh-CN')"), 'cold browser locale');
    assertThat(['zh-CN', 'en-US'].includes(locale), 'cold browser locale is known');
    const expectedNotice = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/public/locales', locale + '.json'), 'utf8'))['decisions.current'];
    const snapshot = `(() => {
      const host = document.querySelector('.steward-task-decisions');
      const rows = [...(host?.querySelectorAll('.steward-decision') || [])].filter(row => row.dataset.sessionId === ${JSON.stringify(iv.sessionId)} && row.dataset.interventionId === ${JSON.stringify(iv.id)});
      return { modal: !!host, refreshDisabled: host?.querySelector(':scope > button')?.disabled ?? null,
        notice: host?.querySelector(':scope > [role="status"]')?.textContent || '', matchingRows: rows.length,
        controls: rows.flatMap(row => [...row.querySelectorAll('input,textarea,button')].map(node => ({ disabled: node.disabled, action: node.dataset.action || '' }))) };
    })()`;
    const ready = await fx.bounded(b.waitForEval(`(() => { const value=${snapshot};return value.modal && value.refreshDisabled===false && value.notice===${JSON.stringify(expectedNotice)} ? value:null;})()`), 'fresh modal completed successful refresh');
    diagnostic.dom = ready || await fx.bounded(b.evaluate(snapshot), 'cold modal failure snapshot');
    fs.writeFileSync(path.join(output, 'cold-pending.png'), await fx.bounded(b.screenshot(), 'cold pending screenshot'), { flag: 'wx' });
    assertThat(response.status === 200 && data.ok === true && Array.isArray(data.pending) && data.index?.degraded?.active === false
      && Object.hasOwn(data, 'nextCursor') && !data.nextCursor
      && !data.pending.some(row => row.id === iv.id && row.sessionId === iv.sessionId), 'the fresh browser receives a complete nondegraded pending projection without the settled intervention');
    assertThat(expectedNotice && ready && ready.matchingRows === 0 && ready.controls.length === 0, 'after successful refresh the fresh browser offers no settled intervention or decision controls');
    await fx.bounded(b.escape(), 'cold browser close decisions');
    return diagnostic;
  } catch (error) { originalError = error; throw error; }
  finally {
    active = false;
    if (originalError) diagnostic.error = originalError.stack || String(originalError);
    try { fs.writeFileSync(path.join(output, 'cold-pending-diagnostics.json'), JSON.stringify(diagnostic, null, 2), { flag: 'wx' }); }
    catch (error) { if (originalError) originalError.c2DiagnosticError = { code: error.code || '', message: error.message }; else throw error; }
  }
}
async function coldRestartJourney(fx, scenario, decision, t, output) {
  const { iv, sid, title } = scenario, { offered, text, id, terminal, platform } = decision;
  assertThat(fx.sealed && fx.browser && scenario.type === 'question', 'cold restart uses the completed sealed question');
  const original = fx.server, oldRuntime = JSON.parse(fs.readFileSync(path.join(fx.home, 'runtime.json'), 'utf8'));
  assertThat(original?.pid === oldRuntime.pid && oldRuntime.token === fx.token && oldRuntime.overlayId, 'original held serve matches runtime identity');
  const journal = fs.readFileSync(fx.journalFile(sid)), ledger = fs.readFileSync(fx.ledgerFile());
  const before = { model: fx.model.requests.length, outbound: fx.outbound.length, originalSends: fx.sent(id, platform).length };
  await fx.stop();
  assertThat(original.exitCode !== null || original.signalCode !== null, 'old original serve exited before replacement spawn');
  const closed = fx.evidence().actors.find(row => row.pid === original.pid);
  assertThat(closed?.exit && closed.close, 'old held serve exit and close observed before cold spawn');
  await fx.start();
  const nextRuntime = JSON.parse(fs.readFileSync(path.join(fx.home, 'runtime.json'), 'utf8'));
  assertThat(fx.server !== original && fx.server.pid === nextRuntime.pid && nextRuntime.overlayId !== oldRuntime.overlayId
    && nextRuntime.token !== oldRuntime.token, 'fresh actual serve process/boot/token on the same physical home');
  const health = await fx.request('GET', '/health', undefined, { admin: false });
  assertThat(health.status === 200 && health.json?.overlayId === nextRuntime.overlayId, 'new runtime belongs to the actual HTTP listener');
  assert.deepEqual(fs.readFileSync(fx.journalFile(sid)), journal, 'cold boot preserves the completed sealed journal bytes');
  assert.deepEqual(fs.readFileSync(fx.ledgerFile()), ledger, 'cold boot preserves the applied sealed action ledger bytes');
  const replay = await fx.callback(id, text, platform, { eventId: fx.nextId('cold_duplicate_event') });
  assertThat(replay.status === 200, 'cold signed duplicate acknowledges the original message');
  const item = await fx.delivered(id);
  assertThat(item.execution.status === 'completed' && item.delivery.status === 'sent', 'cold replay retains original terminal execution and send receipt');
  const reread = inspectTerminal(await fx.journal(sid), iv, 'question');
  assert.deepEqual(reread, terminal, 'cold original terminal/fingerprint/answer unchanged');
  const b = fx.browser, oldPage = await fx.bounded(b.evaluate('performance.timeOrigin'), 'pre-cold document identity');
  await fx.bounded(b.cdp.send('Page.reload'), 'reload after actual cold serve');
  assertThat(await fx.bounded(b.waitForEval(`performance.timeOrigin!==${oldPage} && window.state?.config?.workDataEncryptionV1===true`), 'fresh sealed document after cold serve'), 'fresh browser decrypts the same selected generation after cold boot');
  assertThat(await fx.bounded(b.setLens('steward'), 'cold browser steward'), 'cold browser steward lens');
  const coldOutput = path.join(output, 'cold-restart'); fs.mkdirSync(coldOutput);
  const browserPending = await coldBrowserPendingAbsence(fx, iv, coldOutput);
  const history = await fx.request('GET', '/api/interventions/' + encodeURIComponent(sid) + '?limit=100');
  fs.writeFileSync(path.join(coldOutput, 'terminal-history.json'), JSON.stringify(history, null, 2), { flag: 'wx' });
  const historyRow = history.json?.interventions?.find(row => row.id === iv.id && row.sessionId === sid);
  assertThat(history.status === 200 && history.json?.integrity?.degraded === false && !history.json.nextCursor
    && historyRow?.status === terminal.status && historyRow.interventionVersion === terminal.interventionVersion
    && historyRow.decisionFingerprint === terminal.decisionFingerprint && historyRow.idempotencyKey === terminal.idempotencyKey,
  'new serve independently reads the exact persisted terminal, version and decision identity');
  assert.deepEqual(historyRow.answer, terminal.answer, 'new serve retains the exact original normalized answer');
  assert.deepEqual(fs.readFileSync(fx.journalFile(sid)), journal);
  assert.deepEqual(fs.readFileSync(fx.ledgerFile()), ledger);
  assert.deepEqual({ model: fx.model.requests.length, outbound: fx.outbound.length, originalSends: fx.sent(id, platform).length }, before,
    'cold duplicate and browser reconciliation create no model request, dispatch or resend');
  const storage = await fx.assertSealed(sid, [title, offered.code, 'C2 自定义补充', '选择原始稳定选项并补充']);
  const evidence = { previousPid: oldRuntime.pid, previousOverlayId: oldRuntime.overlayId, pid: nextRuntime.pid, overlayId: nextRuntime.overlayId,
    oldHeldExit: closed.exit, oldHeldClose: closed.close, samePhysicalHome: fx.home, storage, browserPending,
    history: { status: history.status, interventionId: historyRow.id, statusValue: historyRow.status, interventionVersion: historyRow.interventionVersion, decisionFingerprint: historyRow.decisionFingerprint },
    status: 'completed-sealed-question-cold-replay-once' };
  fs.writeFileSync(path.join(output, 'question-cold-restart.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  t.ok(true, 'sealed question survives actual serve cold restart and duplicate callback; fresh browser pending excludes it, authoritative history/answer unchanged, no extra effect/send');
  return evidence;
}
async function staleBrowserOfferJourney(fx, sequence, t, output) {
  const { iv, sid, title, ...pending } = await nativePending(fx, 'permission', 'deny', sequence);
  const platform = 'qq', browser = fx.browser;
  assert.ok(browser, 'a real browser is required for the local decision');
  await browserPending(fx, iv, 'permission', output);
  const offer = await fx.offer(iv, 'permission', title, platform);
  const selector = '.steward-decision[data-intervention-id="' + iv.id + '"]';
  const box = await fx.bounded(browser.waitForEval(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    const deny = row?.querySelector('[data-action="deny"]');
    if (row?.dataset.phase !== 'pending' || row.dataset.sessionId !== ${JSON.stringify(sid)} || !deny || deny.disabled) return null;
    deny.scrollIntoView({ block: 'nearest' });
    const rect = deny.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    return rect.width && rect.height && deny.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  })()`), 'original browser deny button');
  assert.ok(box);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await fx.bounded(browser.cdp.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...box }), 'browser deny click');
  }
  assert.ok(await fx.bounded(browser.waitForEval(`document.querySelector(${JSON.stringify(selector)})?.dataset.phase === 'success'`),
    'browser receives the original local decision response'));
  const rows = (await fx.journal(sid)).filter(row => row.id === iv.id);
  assert.equal(rows.filter(row => row.status === 'applying').length, 1);
  const terminal = rows.at(-1);
  assert.equal(terminal.status, 'denied');
  assert.equal(terminal.source, 'contract');
  assert.equal(terminal.interventionVersion, (iv.interventionVersion || 0) + 2);
  assert.equal(terminal.decisionResponse?.action, 'deny');
  await assertEffect(fx, { iv, sid, title, ...pending }, terminal);
  t.ok(true, 'the browser denies the original permission while its remote Allow offer is outstanding');

  const ledger = await fx.ledger();
  const row = ledger.remoteActions.find(row => row.offerId === offer.handle);
  assert.equal(row?.status, 'offered');
  assert.equal(row?.claim, null);
  const journal = fs.readFileSync(fx.journalFile(sid));
  const queueBytes = fs.readFileSync(fx.ledgerFile());
  const before = { outbound: fx.outbound.length, model: fx.model.requests.length };
  const command = actionCommand('permission', offer.code, 'allow'), id = fx.nextId('stale');
  const callbacks = [];
  for (const [messageId, eventId] of [[id, id], [id, fx.nextId('stale_replay_event')], [fx.nextId('stale_reuse'), fx.nextId('stale_reuse_event')]]) {
    const response = await fx.callback(messageId, command, platform, { eventId });
    const settled = await fx.settledCallback(messageId, response);
    assert.deepEqual(settled, { kind: 'synchronous-rejection', status: 409,
      code: 'external_channel.delivery_changed', originalInboxItemAbsent: true });
    callbacks.push({ messageId, eventId, status: settled.status, code: settled.code });
  }
  assert.deepEqual(await fx.ledger(), ledger, 'the stale offer creates no callback item or decision claim');
  assert.deepEqual(fs.readFileSync(fx.ledgerFile()), queueBytes, 'stale refusal leaves the physical queue unchanged');
  assert.deepEqual(fs.readFileSync(fx.journalFile(sid)), journal, 'the authoritative local terminal stays byte-identical');
  assert.equal(fs.existsSync(pending.target), false);
  assert.deepEqual({ outbound: fx.outbound.length, model: fx.model.requests.length }, before);
  t.ok(true, 'signed stale code and both replay shapes have no claim, new journal phase, filesystem effect or dispatch');

  const previousPage = await fx.bounded(browser.evaluate('performance.timeOrigin'), 'old browser document identity');
  await fx.bounded(browser.cdp.send('Page.reload'), 'reload browser receipt');
  assert.ok(await fx.bounded(browser.waitForEval(`performance.timeOrigin !== ${previousPage} && !!window.state?.config?.configSchema`),
    'fresh browser document'));
  assert.ok(await fx.bounded(browser.setLens('steward'), 'reopen browser lens'));
  await fx.bounded(browser.evaluate("document.getElementById('stewardDecisionsBtn').click(), true"), 'reopen browser decisions');
  await browserTerminal(fx, iv, 'permission', 'denied', output);
  assert.deepEqual(fs.readFileSync(fx.journalFile(sid)), journal);
  const sealedStorage = fx.sealed ? await fx.assertSealed(sid, [title, offer.code, 'C2 原始参数']) : null;
  t.ok(true, 'reloaded browser reconciles the original denied receipt and disables the decision controls');
  return { type: 'permission', action: 'deny', platform, sessionId: sid, interventionId: iv.id,
    status: terminal.status, source: terminal.source, callbacks, ...(fx.sealed ? { sealedStorage } : {}) };
}
async function runJourneys(options = {}) {
  const t = createRunner(options.browser ? 'EXTERNAL BOTS C2 ACTUAL BROWSER' : 'EXTERNAL BOTS C2 ACTUAL HTTP');
  const output = path.resolve(options.output || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ruyi-c2-actual-')));
  assertThat(!fs.existsSync(output) || !fs.readdirSync(output).length, 'evidence directory must be new or empty'); fs.mkdirSync(output, { recursive: true });
  const actions = options.unclaimedColdOffer ? { permission: ['allow'] }
    : options.sealedBrowser ? { question: ['answer'], pool: ['approve'], permission: ['deny'] }
    : options.staleBrowserOffer ? { permission: ['deny'] } : ACTIONS;
  const selected = options.types || Object.keys(actions), count = selected.reduce((n, type) => n + (options.positiveOnly ? 1 : actions[type].length), 0);
  const executionDeadline = Date.now() + BUDGET.startup + count * BUDGET.journey, cleanupDeadline = executionDeadline + BUDGET.cleanup;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(Error('C2 cumulative execution deadline')), executionDeadline - Date.now());
  // Independent scenarios get independent original fixtures. The one batch
  // controller/deadlines above are never reset by a case or its close.
  let fx, current, completed = [], originalFailure = null, cleanupUnknown = false;
  const cases = [], owners = [], diagnosticErrors = [];
  const evidence = () => {
    try { return fx?.evidence() || current?.startupEvidence || originalFailure?.c2Evidence || null; }
    catch (error) { diagnosticErrors.push({ phase: 'evidence-read', message: error.message }); return { evidenceError: error.message }; }
  };
  const firstFailure = error => {
    if (originalFailure) return;
    originalFailure = error;
    // A failed diagnostic must not replace the first error or skip close.
    try { fs.writeFileSync(path.join(output, 'FIRST-FAILURE.json'), JSON.stringify({ error: error.stack || String(error), case: current?.id || null, completed, evidence: evidence() }, null, 2), { flag: 'wx' }); }
    catch (value) { diagnosticErrors.push({ phase: 'first-failure-write', code: value.code || '', message: value.message }); }
  };
  const hardTimer = setTimeout(() => {
    const error = originalFailure || Error('C2 cumulative cleanup deadline; unknown scene retained'); firstFailure(error);
    try { fs.writeFileSync(path.join(output, 'ACTUAL-RESULT.json'), JSON.stringify({ status: 'RED_UNKNOWN_DEADLINE', selectedJourneys: completed, cases, cleanup: { status: 'unknown', evidence: evidence(), retainedProvider: error.c2ProviderRetention?.snapshot() || null }, diagnosticErrors, executionDeadline, cleanupDeadline }, null, 2)); }
    finally { t.fail(error.message); t.done(); process.exit(1); }
  }, cleanupDeadline - Date.now());
  try {
    let sequence = 0;
    casesLoop: for (const type of selected) for (const action of options.positiveOnly ? [actions[type][0]] : actions[type]) {
      assertThat(!controller.signal.aborted && Date.now() < executionDeadline, 'C2 cumulative execution deadline before next case');
      const id = 'case-' + String(++sequence).padStart(2, '0') + '-' + type + '-' + action;
      const caseOutput = path.join(output, id);
      // mkdir is exclusive: a local provider index may restart only in this
      // newly allocated namespace, never by replacing any earlier evidence.
      fs.mkdirSync(caseOutput);
      current = { id, type, action, output: caseOutput, business: 'pending', cleanup: { status: 'pending' } }; cases.push(current);
      fx = null;
      try {
        fx = await createActualFixture({ browser: options.browser, sealed: options.sealedBrowser || options.unclaimedColdOffer, ok: t.ok, output: caseOutput, deadline: executionDeadline, cleanupDeadline, signal: controller.signal });
        owners.push(fx); // Hold the exact original owner even after close.
        await fx.configure('qq'); await fx.configure('feishu');
        const result = options.unclaimedColdOffer ? await unclaimedColdOfferJourney(fx, sequence, t, caseOutput, { nativePending, browserPending, coldBrowserPendingAbsence })
          : options.staleBrowserOffer || options.sealedBrowser && type === 'permission' ? await staleBrowserOfferJourney(fx, sequence, t, caseOutput)
          : await oneJourney(fx, type, action, sequence, t, caseOutput);
        assertThat(!fx.model.errors.length, 'scripted model has no hidden errors');
        if (fx.browser) assertThat(!fx.browser.exceptions.length && !fx.browser.consoleErrors.length, 'actual UI has no exception/console errors');
        current.business = 'completed'; current.result = result; completed.push(result);
      } catch (error) {
        current.business = 'failed'; current.error = error.stack || String(error); current.startupEvidence = error.c2Evidence || null;
        firstFailure(error); t.fail(error.stack || String(error));
      } finally {
        // This fixture aborts its own streams. Aborting the shared controller
        // here would cancel every later independent scenario.
        try {
          const result = fx ? await fx.close() : current.startupEvidence?.cleanupResult;
          assertThat(result?.status === 'closed-held-actors-and-owned-listeners'
            && !current.startupEvidence?.cleanupError, 'original case held-owner/listener close unproven');
          current.cleanup = { status: 'known-held-actors-closed', result };
        } catch (error) {
          cleanupUnknown = true; current.cleanup = { status: 'unknown-or-failed', error: error.stack || String(error) };
          firstFailure(error); t.fail('cleanup: ' + (error.stack || error));
        }
        current.evidence = evidence();
        if (current.evidence?.evidenceError) { const error = Error(current.evidence.evidenceError); firstFailure(error); t.fail('case evidence read: ' + error.message); }
        try { fs.writeFileSync(path.join(caseOutput, 'CASE-RESULT.json'), JSON.stringify(current, null, 2) + '\n', { flag: 'wx' }); }
        catch (error) { firstFailure(error); t.fail('case evidence: ' + (error.stack || error)); }
      }
      // Business failure, evidence EIO and unknown close all stop before any
      // next fixture allocation. Earlier accepted cases remain in this run.
      if (originalFailure) break casesLoop;
    }
  } catch (error) {
    firstFailure(error); t.fail(error.stack || String(error));
  } finally {
    controller.abort(Error('C2 selected work finished'));
    const retention = originalFailure?.c2ProviderRetention, retainedState = retention?.snapshot();
    const retainedPending = retainedState && (!retainedState.settled || ['pending', 'awaiting-startup'].includes(retainedState.closeStatus));
    clearTimeout(timer); if (!retainedPending && !cleanupUnknown) clearTimeout(hardTimer);
    try { fs.writeFileSync(path.join(output, 'ACTUAL-RESULT.json'), JSON.stringify({ status: originalFailure || diagnosticErrors.length ? 'RED' : 'passed-selected-journeys-and-known-cleanup',
      selectedJourneys: { status: completed.length === count ? 'completed' : 'incomplete', requested: count, completed }, cases,
      cleanup: { status: !cleanupUnknown && cases.length && cases.every(row => row.cleanup.status === 'known-held-actors-closed') ? 'known-held-actors-closed' : 'unknown-or-failed' }, diagnosticErrors,
      browser: !!options.browser, executionDeadline, cleanupDeadline, budgets: BUDGET,
      bounds: ['offline synthetic platform transport', options.sealedBrowser || options.unclaimedColdOffer ? 'Windows CurrentUser DPAPI; selected encrypted generation' : 'encryption OFF only',
        'not real account/platform', 'group revision contract not accepted', ...(options.sealedBrowser || options.unclaimedColdOffer ? [] : ['no DPAPI evidence']), 'no all-descendant kernel-exit certification'], evidence: evidence() }, null, 2)); }
    catch (error) { firstFailure(error); t.fail('root evidence: ' + (error.stack || error)); }
    t.done();
    if (retainedPending) {
      // Keep the existing retention watchdog while the original startup may
      // still acquire a listener. Late settlement can only close, never resume.
      const noteLate = value => {
        try { fs.writeFileSync(path.join(output, 'LATE-PROVIDER-RETENTION.json'), JSON.stringify(value, null, 2), { flag: 'wx' }); }
        catch (error) { diagnosticErrors.push({ phase: 'late-provider-evidence', code: error.code || '', message: error.message }); console.error(error.stack || error); }
      };
      retention.promise.then(() => {
        noteLate({ status: 'RED_ORIGINAL_FAILURE_RETAINED', originalFailure: originalFailure.message, provider: retention.snapshot() });
        if (retention.snapshot().closeStatus === 'closed' && !cleanupUnknown) clearTimeout(hardTimer);
      }, error => {
        noteLate({ status: 'RED_UNKNOWN_PROVIDER_RETAINED', originalFailure: originalFailure.message, lateError: error.message, provider: retention.snapshot() });
      }).catch(error => { diagnosticErrors.push({ phase: 'late-provider-retention', message: error.message }); console.error(error.stack || error); });
    }
    // Unknown close keeps the original absolute watchdog and exact owners;
    // neither an early exit nor a later scenario may erase that obligation.
  }
  return { failures: t.failures, output };
}
module.exports = { ACTIONS, PLATFORM, nativePending, workflowPending, assertEffect, modelAuthorityProbe, oneJourney, runJourneys };
