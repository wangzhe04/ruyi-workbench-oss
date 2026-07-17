(async () => {
// E2E (v1.4-OSS 用量看板「补」): Agent 工作流子代理(sub-agent)消耗入月度用量账本 usage/YYYY-MM.jsonl。
// Before this fix only top-level CHAT turns were metered; a DAG workflow / spawn_agent sub-agent's tokens
// were silently dropped ("漏算"). This drives a real dual-engine 2-node workflow (one openai-provider node +
// one engine:'claude' node) and asserts BOTH sub-agents append a kind:'subagent' ledger row, honoring the
// existing 诚实计费 rules (Claude-direct → notional USD, costTrusted:true; provider → tokens×pricing).
// Offline, zero-dep. Spawns fake-openai (9099) + the workbench (9100, with WCW_FAKE_CLAUDE → fake-claude).
//
// Asserts:
//  ① the 2-node workflow launches async and reaches a terminal state with BOTH nodes succeeded.
//  ② the ledger gains exactly 2 kind:'subagent' rows:
//     - openai row: provider 'fake', model 'fake-model', 42/15 tokens, cost = tokens×pricing (CNY), estimated:false,
//       agentKey 'oa', subagentId present.
//     - claude row: engine 'claude', provider 'claude-cli', 812/214 tokens, cost = 0.0123, currency 'USD',
//       costTrusted:true, agentKey 'cl'.
//  ③ GET /api/usage/summary?range=today → totals.subagentTurns === 2 (exact, 密闭 HOME); byProvider carries
//     BOTH sources' subagent tokens by exact equality (the漏算 is fixed — sub-agent spend now flows into the
//     same buckets as chat turns).
//  ④ (regression) a plain CHAT turn still appends a kind:'turn', costTrusted row (main-turn accounting unchanged),
//     and bySession attributes all 3 of the parent session's rows (2 subagent + 1 turn) to it.
//  ⑤ (mixed-read) a LEGACY ledger row with NO kind field aggregates as a plain turn — counted in totals.turns
//     but NOT in subagentTurns/auxCalls (向后兼容).
//  ⑥ (B1 aux) POST /api/provider/compact issues a summary call → exactly one kind:'aux'/note:'compact' row,
//     priced from the provider pricing (11/7 tokens), and totals.auxCalls === 1.
// Judgement line (exact): USAGE-SUBAGENT-LEDGER E2E: ALL PASS
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE = await getFreePort(), WB_PORT = await getFreePort();
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'wcw-usage-subagent-ledger-e2e');
const USAGE_DIR = path.join(HOME, 'usage');
const MONTH = new Date().toISOString().slice(0, 7); // current UTC month = ledger file name
const LEDGER = path.join(USAGE_DIR, MONTH + '.jsonl');

// Provider pricing (per MILLION tokens, CNY) and the derived cost for the fake's 42/15 usage frame.
const IN_PER_M = 1, OUT_PER_M = 2, CUR = 'CNY';
const OA_COST = (42 * IN_PER_M + 15 * OUT_PER_M) / 1e6; // 0.000072
// fake-claude's canned result frame (see ruyi-workbench/tools/fake-claude.js resultEvt).
const CL_IN = 812, CL_OUT = 214, CL_COST = 0.0123;
const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;

function writeConfig() {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.4.0', permissionMode: 'bypass', defaultWorkspace: HOME,
    subagentMaxConcurrent: 2,
    // NOTE: no modelsApiBase (Anthropic-direct → claudeLedgerSource costTrusted:true) and NO claudePricing,
    // so the Claude sub-agent records the CLI's notional total_cost_usd (0.0123 USD, trusted), not a priced value.
    providers: [
      { id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false, pricing: { inputPerM: IN_PER_M, outputPerM: OUT_PER_M, currency: CUR } },
    ],
    activeProvider: 'fake',
  }, null, 2));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function reqJson(port, method, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; res.on('data', c => { buf += c; }); res.on('end', () => resolve(buf));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function readLedgerLines() { try { return fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(l => l.trim()); } catch { return []; } }
function readRecs() { return readLedgerLines().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
const runOf = (r, runId) => r && Array.isArray(r.runs) && r.runs.find(x => x.id === runId);
const isTerminal = s => s === 'succeeded' || s === 'failed' || s === 'partial' || s === 'stopped' || s === 'cancelled';

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
  async function waitFor(label, fn, tries = 160, gap = 150) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); } ok(false, label + ' (timed out)'); return null; }

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  writeConfig();

  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE) }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  // Clear any Anthropic endpoint env the dev machine may carry: claudeLedgerSource now consults process.env
  // ANTHROPIC_BASE_URL/ANTHROPIC_BASE (a nonempty one makes the Claude ledger cost UNtrusted), so a stray value
  // would flip the claude sub-agent row's costTrusted/provider and flake this test. Empty string = 官方直连.
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_BASE: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'got workbench token');
    const hdr = { 'x-wcw-token': token };

    const created = await reqJson(WB_PORT, 'POST', '/api/sessions', { title: 'subagent-ledger', cwd: HOME }, hdr);
    const sid = created.json && created.json.session && created.json.session.id;
    ok(!!sid, 'created a session');

    // ① launch a dual-engine 2-node workflow: one openai-provider node + one Claude-CLI node. Both are
    //    independent (no dependsOn) and run in ONE batch (subagentMaxConcurrent:2). Task text is plain Chinese
    //    with no English keyword that would flip fake-claude off its default (happy) canned scenario.
    const launched = await reqJson(WB_PORT, 'POST', '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'oa', task: '开发引擎节点：请用一句话回复。', engine: 'openai', toolTier: 'read' },
        { id: 'cl', task: '克劳德引擎节点：请用一句话回复。', engine: 'claude', toolTier: 'read' },
      ],
    }, hdr);
    ok(launched.json && launched.json.ok === true && /^run_/.test(launched.json.runId || ''), 'workflow launched async with a run id');
    const runId = launched.json && launched.json.runId;

    const run = await waitFor('workflow reaches a terminal state', async () => {
      const r = await getJson(WB_PORT, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r.json, runId);
      return run && isTerminal(run.status) && run;
    });
    ok(!!run, 'workflow run terminated');
    if (run) {
      const nodes = run.nodes || [];
      const oa = nodes.find(n => n.id === 'oa'), cl = nodes.find(n => n.id === 'cl');
      ok(oa && oa.status === 'succeeded', 'openai node succeeded (status ' + (oa && oa.status) + ')');
      ok(cl && cl.status === 'succeeded', 'claude node succeeded (status ' + (cl && cl.status) + ')');
      console.log('  run status:', run.status, '| nodes:', nodes.map(n => n.id + '=' + n.status).join(','));
    }

    // C1: poll the ledger for the two fire-and-forget subagent appends instead of a fixed sleep (deterministic).
    await waitFor('two subagent ledger rows flushed', () => readRecs().filter(r => r.kind === 'subagent').length >= 2);

    // ② the ledger has exactly two kind:'subagent' rows with the right billing fields.
    const recs = readRecs();
    const subs = recs.filter(r => r.kind === 'subagent');
    ok(subs.length === 2, 'ledger has exactly 2 subagent rows (got ' + subs.length + ' of ' + recs.length + ' total)');
    const oaRow = subs.find(r => r.engine === 'openai');
    const clRow = subs.find(r => r.engine === 'claude');
    ok(oaRow && oaRow.provider === 'fake' && oaRow.model === 'fake-model' && oaRow.inTok === 42 && oaRow.outTok === 15
      && oaRow.currency === CUR && near(oaRow.cost, OA_COST) && oaRow.costTrusted === true && oaRow.estimated === false,
      'openai subagent row: fake/fake-model, 42/15, CNY cost=' + round6(OA_COST) + ' (got ' + (oaRow && oaRow.cost) + ')');
    ok(oaRow && oaRow.agentKey === 'oa' && typeof oaRow.subagentId === 'string' && oaRow.subagentId.length > 0,
      'openai subagent row carries agentKey=oa + a subagentId');
    // C2: the claude sub-agent's usage came from a populated result frame → estimated MUST be false (the msg_usage
    // 保守兜底 only flags estimated:true when it actually falls back).
    ok(clRow && clRow.provider === 'claude-cli' && clRow.inTok === CL_IN && clRow.outTok === CL_OUT
      && near(clRow.cost, CL_COST) && clRow.currency === 'USD' && clRow.costTrusted === true && clRow.estimated === false,
      'claude subagent row: claude-cli, 812/214, cost=0.0123 USD costTrusted estimated:false (got ' + (clRow && clRow.cost) + '/' + (clRow && clRow.currency) + '/est=' + (clRow && clRow.estimated) + ')');
    ok(clRow && clRow.agentKey === 'cl' && clRow.kind === 'subagent', 'claude subagent row carries agentKey=cl + kind=subagent');

    // ③ summary aggregation: subagentTurns counted; both sources' tokens present in byProvider. At this point the
    //    ledger holds EXACTLY the 2 subagent rows, so every value below is asserted by EXACT equality (C2).
    const sum = (await getJson(WB_PORT, '/api/usage/summary?range=today', hdr)).json;
    ok(sum && sum.ok === true && sum.totals, 'summary ok:true');
    ok(sum && Number(sum.totals.subagentTurns) === 2, 'totals.subagentTurns === 2 (got ' + (sum && sum.totals && sum.totals.subagentTurns) + ')');
    const pFake = sum && sum.byProvider.find(p => p.provider === 'fake');
    const pClaude = sum && sum.byProvider.find(p => p.provider === 'claude-cli');
    ok(pFake && pFake.inTok === 42 && pFake.outTok === 15 && near(pFake.costsByCurrency[CUR], round6(OA_COST)),
      'byProvider fake = the openai sub-agent tokens (42/15) + CNY cost');
    ok(pClaude && pClaude.inTok === CL_IN && pClaude.outTok === CL_OUT && near((pClaude.costsByCurrency || {}).USD, round6(CL_COST)),
      'byProvider claude-cli = the claude sub-agent tokens (812/214) + USD cost');
    const engClaude = sum && sum.byEngine.find(e => e.engine === 'claude');
    ok(engClaude && engClaude.inTok === CL_IN, 'byEngine claude reflects the claude sub-agent (was 漏算 before the fix)');

    // ④ regression: a plain CHAT turn still writes a kind:'turn' row (main-turn accounting unchanged).
    await postStream(WB_PORT, { sessionId: sid, message: '普通聊天回合', cwd: HOME });
    // C1: poll for the fire-and-forget turn append instead of a fixed sleep.
    await waitFor('chat-turn ledger row flushed', () => readRecs().some(r => r.kind === 'turn'));
    const recs2 = readRecs();
    const turnRows = recs2.filter(r => r.kind === 'turn');
    ok(turnRows.length === 1, 'exactly 1 kind:turn row after a normal chat turn (got ' + turnRows.length + ')');
    const turnRow = turnRows[0];
    // C2: the regression turn is a priced provider turn → its cost is trusted (costTrusted defaults true).
    ok(turnRow && turnRow.engine === 'openai' && turnRow.provider === 'fake' && turnRow.inTok === 42 && turnRow.outTok === 15
      && near(turnRow.cost, OA_COST) && turnRow.costTrusted === true && !turnRow.agentKey && !turnRow.subagentId,
      'the chat-turn row is a plain trusted openai turn (no agentKey/subagentId)');
    ok(recs2.filter(r => r.kind === 'subagent').length === 2, 'the chat turn did NOT add or disturb the 2 subagent rows');

    // C2: bySession attributes ALL THREE of the parent session's rows (2 subagent + 1 turn) to it, and its
    //     token totals equal the row-by-row sum (nothing double-counted, nothing dropped).
    const sumB = (await getJson(WB_PORT, '/api/usage/summary?range=today', hdr)).json;
    const sSess = sumB && sumB.bySession.find(s => s.sessionId === sid);
    ok(sSess && sSess.inTok === 42 + CL_IN + 42 && sSess.outTok === 15 + CL_OUT + 15,
      'bySession parent = sum of its 3 rows (' + (42 + CL_IN + 42) + '/' + (15 + CL_OUT + 15) + '), got ' + (sSess && sSess.inTok) + '/' + (sSess && sSess.outTok));

    // C3: mixed-read regression — a LEGACY row with NO kind field must aggregate as a plain turn (向后兼容),
    //     never as a subagent or an aux call.
    const beforeMix = (await getJson(WB_PORT, '/api/usage/summary?range=today', hdr)).json.totals;
    fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), sessionId: sid, engine: 'openai', provider: 'fake', model: 'fake-model', inTok: 7, outTok: 3, cost: null, currency: null, costTrusted: true, estimated: false, turnSeq: 1 }) + '\n');
    const afterMix = (await getJson(WB_PORT, '/api/usage/summary?range=today', hdr)).json.totals;
    ok(afterMix.turns === beforeMix.turns + 1, 'legacy (no-kind) row counts in totals.turns (' + beforeMix.turns + '→' + afterMix.turns + ')');
    ok(afterMix.subagentTurns === beforeMix.subagentTurns, 'legacy row NOT counted as subagent (stays ' + beforeMix.subagentTurns + ')');
    ok(afterMix.auxCalls === beforeMix.auxCalls, 'legacy row NOT counted as aux (stays ' + beforeMix.auxCalls + ')');

    // C4 (B1 coverage): a manual context compaction issues a non-stream summary call the fake serves with usage
    //     11/7. It must append EXACTLY one kind:'aux'/note:'compact' row, priced by the provider pricing.
    const AUX_COST = (11 * IN_PER_M + 7 * OUT_PER_M) / 1e6;
    const compact = await reqJson(WB_PORT, 'POST', '/api/provider/compact', { sessionId: sid }, hdr);
    ok(compact.json && compact.json.ok === true, 'provider/compact ok:true (' + ((compact.json && compact.json.error) || '') + ')');
    await waitFor('aux/compact ledger row flushed', () => readRecs().some(r => r.kind === 'aux' && r.note === 'compact'));
    const auxRows = readRecs().filter(r => r.kind === 'aux' && r.note === 'compact');
    ok(auxRows.length === 1, 'exactly 1 aux/compact row (got ' + auxRows.length + ')');
    const auxRow = auxRows[0];
    ok(auxRow && auxRow.engine === 'openai' && auxRow.provider === 'fake' && auxRow.model === 'fake-model'
      && auxRow.inTok === 11 && auxRow.outTok === 7 && auxRow.currency === CUR && near(auxRow.cost, AUX_COST)
      && auxRow.estimated === false && !auxRow.agentKey && !auxRow.subagentId,
      'aux/compact row: fake/fake-model, 11/7, CNY cost=' + round6(AUX_COST) + ' (got ' + (auxRow && auxRow.cost) + ')');
    const sumC = (await getJson(WB_PORT, '/api/usage/summary?range=today', hdr)).json;
    ok(sumC && Number(sumC.totals.auxCalls) === 1, 'totals.auxCalls === 1 after one compaction (got ' + (sumC && sumC.totals && sumC.totals.auxCalls) + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fake]) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nUSAGE-SUBAGENT-LEDGER E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
