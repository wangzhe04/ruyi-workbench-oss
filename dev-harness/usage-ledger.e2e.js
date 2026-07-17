// E2E (v1.4-OSS 用量/成本看板): append-only usage ledger + GET /api/usage/summary aggregation. Offline, zero-dep.
// Spawns TWO fake-openai endpoints (A: reports usage + a priced provider; B: FAKE_NO_USAGE=1 -> the workbench
// falls back to an ESTIMATED usage frame) + the workbench, drives real provider turns, then pokes the on-disk
// ledger and the summary endpoint. Ports 9020 (fakeA) + 9022 (fakeB) + 9021 (wb).
//
// Asserts:
//  ① fresh install (no ledger rows yet) -> GET summary is ok:true with empty aggregation (never 500).
//  ② two priced turns + one no-usage turn append exactly 3 ledger lines to usage/<currentUTCmonth>.jsonl.
//  ③ summary totals: turns=3, estimatedTurns=1 (the no-usage turn), planBasedTurns=0.
//  ④ cost grouped BY CURRENCY: the priced provider's CNY cost = sum over both turns (tokens×pricing); the
//     unpriced provider records tokens with cost null (no currency bucket).
//  ⑤ byEngine/byProvider/bySession grouping + provider labels + session titles (from the metadata index).
//  ⑥ range filter: an injected OLD-month row shows only in range=all, not range=month.
//  ⑦ a CORRUPT ledger line is skipped by aggregation (turns count unchanged).
//  ⑧ a third-party Claude endpoint row (costTrusted:false) counts as planBased and its (absent) cost stays
//     OUT of costsByCurrency; its source is labelled from CLAUDE_ENDPOINT_PRESETS.
//  ⑨ budget.spentThisMonth = current-month TRUSTED spend in the budget currency.
//  ⑩ the endpoint is token-gated (403 without the workbench token).
// Judgement line (exact): USAGE-LEDGER E2E: ALL PASS
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_A = await getFreePort(), FAKE_B = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-usage-ledger-e2e');
const USAGE_DIR = path.join(HOME, 'usage');
const MONTH = new Date().toISOString().slice(0, 7); // current UTC month = ledger file name
const LEDGER = path.join(USAGE_DIR, MONTH + '.jsonl');

// Priced provider (CNY, per-MILLION-token) and derived per-turn cost for the fake's 42/15 usage frame.
const IN_PER_M = 1000, OUT_PER_M = 2000, CUR = 'CNY';
const PER_TURN = (42 * IN_PER_M + 15 * OUT_PER_M) / 1e6; // 0.072
const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;

function writeConfig(activeProvider) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.4.0', permissionMode: 'bypass',
    providers: [
      { id: 'priced', label: 'Priced', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_A, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false, pricing: { inputPerM: IN_PER_M, outputPerM: OUT_PER_M, currency: CUR } },
      { id: 'noprice', label: 'NoPrice', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_B, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false },
    ],
    activeProvider,
    usageBudget: { monthly: 100, currency: CUR },
    claudePricing: { inputPerM: 4, outputPerM: 12, currency: 'USD' },
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
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 8000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
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

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  writeConfig('priced');

  const fakeA = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_A) }, windowsHide: true });
  const fakeB = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_B), FAKE_NO_USAGE: '1' }, windowsHide: true });
  for (const [tag, f] of [['A', fakeA], ['B', fakeB]]) f.stdout.on('data', d => String(d).trim() && console.log('[fake' + tag + '] ' + String(d).trim()));
  // Clear any Anthropic endpoint env the dev machine may carry (claudeLedgerSource consults process.env
  // ANTHROPIC_BASE_URL/ANTHROPIC_BASE for Claude-ledger cost trust) so this test can't flake on a stray value.
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_BASE: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'got workbench token');
    const hdr = { 'x-wcw-token': token };
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // Config round-trip: pricing / usageBudget / claudePricing survive normalizeConfig (else the front-end's
    // 设置 save would silently drop them). GET /api/status returns the (mask-only) config.
    const st = (await getJson(WB_PORT, '/api/status', hdr)).json;
    const cfg = st && st.config;
    ok(cfg && eq(cfg.usageBudget, { monthly: 100, currency: CUR }), 'config.usageBudget round-trips');
    ok(cfg && eq(cfg.claudePricing, { inputPerM: 4, outputPerM: 12, currency: 'USD' }), 'config.claudePricing round-trips');
    const pcfg = cfg && (cfg.providers || []).find(p => p.id === 'priced');
    ok(pcfg && eq(pcfg.pricing, { inputPerM: IN_PER_M, outputPerM: OUT_PER_M, currency: CUR }), 'provider.pricing round-trips');

    // ① fresh install: no ledger rows yet -> empty aggregation, never 500.
    const empty = await getJson(WB_PORT, '/api/usage/summary?range=all', hdr);
    ok(empty.status === 200 && empty.json && empty.json.ok === true, 'empty summary ok:true (status ' + empty.status + ')');
    ok(empty.json && empty.json.totals && empty.json.totals.turns === 0, 'empty summary turns=0');
    ok(empty.json && Array.isArray(empty.json.byProvider) && empty.json.byProvider.length === 0, 'empty summary byProvider=[]');

    // ⑩ token gate: no token -> 403.
    const noTok = await getJson(WB_PORT, '/api/usage/summary?range=all', {});
    ok(noTok.status === 403, 'summary without token -> 403 (got ' + noTok.status + ')');

    // Create 3 sessions with distinct titles; run 2 turns on the priced provider, 1 on the no-usage provider.
    const mk = async title => { const r = await reqJson(WB_PORT, 'POST', '/api/sessions', { title, cwd: HOME }, hdr); return r.json && r.json.session && r.json.session.id; };
    const s1 = await mk('S-priced-1'); const s2 = await mk('S-priced-2'); const s3 = await mk('S-estimated');
    ok(!!(s1 && s2 && s3), 'created 3 sessions');

    await postStream(WB_PORT, { sessionId: s1, message: '价格一', cwd: HOME });
    await postStream(WB_PORT, { sessionId: s2, message: '价格二', cwd: HOME });
    // switch active provider to the no-usage one for the estimated turn (readConfig is uncached -> picked up).
    writeConfig('noprice');
    await postStream(WB_PORT, { sessionId: s3, message: '估算一', cwd: HOME });
    await sleep(500); // let the fire-and-forget ledger appends flush
    // Warm the session metadata index (the UI does this via the sidebar). buildUsageSummary reads titles from
    // that index ONLY (never scans session bodies), so it is cold until something lists sessions.
    await getJson(WB_PORT, '/api/sessions', hdr);

    // ② exactly 3 ledger lines in the current-month file.
    let lines = readLedgerLines();
    ok(lines.length === 3, 'ledger has 3 lines (got ' + lines.length + ')');
    const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const priced = recs.filter(r => r.provider === 'priced');
    const est = recs.filter(r => r.provider === 'noprice');
    ok(priced.length === 2 && priced.every(r => r.inTok === 42 && r.outTok === 15 && r.currency === CUR && near(r.cost, PER_TURN) && r.estimated === false), 'priced rows: 42/15, CNY cost per turn, estimated=false');
    ok(est.length === 1 && est[0].estimated === true && est[0].cost === null && est[0].currency === null && est[0].inTok > 0, 'no-usage row: estimated=true, cost null, inTok>0');

    // ③④⑤ summary aggregation over the 3 real turns.
    let sum = (await getJson(WB_PORT, '/api/usage/summary?range=month', hdr)).json;
    ok(sum && sum.totals.turns === 3, 'month summary turns=3 (got ' + (sum && sum.totals.turns) + ')');
    ok(sum && sum.totals.estimatedTurns === 1, 'month summary estimatedTurns=1');
    ok(sum && sum.totals.planBasedTurns === 0, 'month summary planBasedTurns=0');
    ok(sum && near(sum.totals.costsByCurrency[CUR], round6(2 * PER_TURN)), 'month CNY total = 2×perTurn (' + round6(2 * PER_TURN) + '), got ' + (sum && sum.totals.costsByCurrency[CUR]));
    ok(sum && Object.keys(sum.totals.costsByCurrency).length === 1, 'only one currency bucket (CNY)');
    const pProv = sum && sum.byProvider.find(p => p.provider === 'priced');
    const nProv = sum && sum.byProvider.find(p => p.provider === 'noprice');
    ok(pProv && pProv.turns === 2 && pProv.inTok === 84 && pProv.label === 'Priced' && near(pProv.costsByCurrency[CUR], round6(2 * PER_TURN)), 'byProvider priced: 2 turns, inTok 84, label, CNY cost');
    ok(nProv && nProv.turns === 1 && (nProv.costsByCurrency[CUR] === undefined), 'byProvider noprice: 1 turn, no CNY cost');
    const eng = sum && sum.byEngine.find(e => e.engine === 'openai');
    ok(eng && eng.turns === 3, 'byEngine openai turns=3');
    const sess = sum && sum.bySession.find(s => s.sessionId === s1);
    ok(sess && sess.title === 'S-priced-1', 'bySession carries the session title from the index');

    // ⑥ range filter: inject an OLD-month row (2020-01) worth 5 CNY.
    fs.writeFileSync(path.join(USAGE_DIR, '2020-01.jsonl'),
      JSON.stringify({ ts: '2020-01-15T00:00:00.000Z', sessionId: s1, engine: 'openai', provider: 'priced', model: 'fake-model', inTok: 1000, outTok: 500, cost: 5, currency: CUR, costTrusted: true, estimated: false, turnSeq: 1 }) + '\n');
    const all1 = (await getJson(WB_PORT, '/api/usage/summary?range=all', hdr)).json;
    const month1 = (await getJson(WB_PORT, '/api/usage/summary?range=month', hdr)).json;
    ok(all1 && all1.totals.turns === 4, 'range=all includes old-month row (turns=4)');
    ok(all1 && near(all1.totals.costsByCurrency[CUR], round6(2 * PER_TURN + 5)), 'range=all CNY includes old row (+5)');
    ok(month1 && month1.totals.turns === 3, 'range=month excludes old-month row (turns=3)');

    // ⑦ corrupt line + ⑧ third-party Claude (planBased, costTrusted:false) row appended to the CURRENT month.
    fs.appendFileSync(LEDGER, 'not-json{{{ broken line\n');
    fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), sessionId: s2, engine: 'claude', provider: 'ark-coding-plan', model: 'ark-code-latest', inTok: 100, outTok: 50, cost: null, currency: null, costTrusted: false, estimated: false, turnSeq: 1 }) + '\n');
    sum = (await getJson(WB_PORT, '/api/usage/summary?range=month', hdr)).json;
    ok(sum && sum.totals.turns === 4, 'corrupt line skipped; planBased claude row counted (turns=4)');
    ok(sum && sum.totals.planBasedTurns === 1, 'planBasedTurns=1 (the ark row)');
    ok(sum && near(sum.totals.costsByCurrency[CUR], round6(2 * PER_TURN)), 'planBased cost stays OUT of costsByCurrency (still 2×perTurn)');
    const ark = sum && sum.byProvider.find(p => p.provider === 'ark-coding-plan');
    ok(ark && ark.turns === 1 && /Ark/.test(ark.label || ''), 'ark source labelled from CLAUDE_ENDPOINT_PRESETS (' + (ark && ark.label) + ')');
    ok(ark && ark.planBased === true, 'ark entry planBased=true (front-end badges 计划内计费)');
    const pProv2 = sum && sum.byProvider.find(p => p.provider === 'priced');
    ok(pProv2 && pProv2.planBased === false, 'priced entry planBased=false (real cost shown)');
    const claudeEng = sum && sum.byEngine.find(e => e.engine === 'claude');
    ok(claudeEng && claudeEng.turns === 1 && claudeEng.planBased === true, 'byEngine claude turns=1, planBased=true');

    // ⑨ budget: current-month trusted CNY spend (priced turns only; planBased/old-month excluded).
    ok(sum && sum.budget && sum.budget.monthly === 100 && sum.budget.currency === CUR, 'budget monthly/currency echoed');
    ok(sum && sum.budget && near(sum.budget.spentThisMonth, round6(2 * PER_TURN)), 'budget spentThisMonth = 2×perTurn (' + round6(2 * PER_TURN) + '), got ' + (sum && sum.budget && sum.budget.spentThisMonth));
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fakeA, fakeB]) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nUSAGE-LEDGER E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
