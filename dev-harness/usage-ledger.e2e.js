require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
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
//  ⑪ 117x-M1 byModel: the summary carries a byModel dimension ({model,provider,engine,turns,inTok,outTok,lastAt,
//     …同四维口径}); it equals a row-by-row recount of the on-disk ledger keyed by (engine,provider,model);
//     Σ byModel.turns === Σ byEngine.turns − rows whose model is empty (those rows are SKIPPED, not bucketed);
//     lastAt is that model's most recent row ts and the array comes back sorted by it, newest first; and a
//     historical row (model already on the line) aggregates without any new collection.
// Judgement line (exact): USAGE-LEDGER E2E: ALL PASS
'use strict';
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
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
const IN_PER_M = 1000, CACHED_PER_M = 500, OUT_PER_M = 2000, CUR = 'CNY';
const MODEL_IN_PER_M = 1200, MODEL_CACHED_PER_M = 100, MODEL_OUT_PER_M = 2200, CACHED_TOKENS = 12;
const PER_TURN = ((42 - CACHED_TOKENS) * MODEL_IN_PER_M + CACHED_TOKENS * MODEL_CACHED_PER_M + 15 * MODEL_OUT_PER_M) / 1e6;
const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;

function writeConfig(activeProvider) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    // 116-5a:本件隔离回合/工具/台账,不测线程自动摘要(它有自己的 thread-brief.e2e.js)
    stewardThreadBriefV1: false,
    configSchema: 7, version: '1.4.0', permissionMode: 'bypass',
    providers: [
      { id: 'priced', label: 'Priced', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_A, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false, pricing: { inputPerM: IN_PER_M, cachedInputPerM: CACHED_PER_M, outputPerM: OUT_PER_M, currency: CUR, models: [{ model: 'fake-model', inputPerM: MODEL_IN_PER_M, cachedInputPerM: MODEL_CACHED_PER_M, outputPerM: MODEL_OUT_PER_M }] } },
      { id: 'noprice', label: 'NoPrice', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_B, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false },
    ],
    activeProvider,
    usageBudget: { monthly: 100, currency: CUR },
    claudePricing: { inputPerM: 4, outputPerM: 12, currency: 'USD' },
  }, null, 2));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); } // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
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
function killp(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* ignore */ } } }
function patchSessionRoute(id, route, headers) {
  return reqJson(WB_PORT, 'POST', '/api/sessions/' + encodeURIComponent(id), { engineRoute: route }, { ...(headers || {}), 'x-http-method': 'PATCH' });
}
function readLedgerLines() { try { return fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(l => l.trim()); } catch { return []; } }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  writeConfig('priced');

  const fakeA = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_A), FAKE_CACHED_TOKENS: String(CACHED_TOKENS) }, windowsHide: true });
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
    ok(pcfg && eq(pcfg.pricing, { inputPerM: IN_PER_M, outputPerM: OUT_PER_M, currency: CUR, cachedInputPerM: CACHED_PER_M, models: [{ model: 'fake-model', inputPerM: MODEL_IN_PER_M, outputPerM: MODEL_OUT_PER_M, cachedInputPerM: MODEL_CACHED_PER_M }] }), 'provider pricing round-trips cache and model overrides');

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
    // 109b905 protocol: pin s3 to the no-usage provider explicitly (global config switch no longer retargets an existing session).
    await patchSessionRoute(s3, { engine: 'openai', providerId: 'noprice', model: 'fake-model' }, hdr);
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
    ok(priced.length === 2 && priced.every(r => r.inTok === 42 && r.cachedInTok === CACHED_TOKENS && r.outTok === 15 && r.currency === CUR && near(r.cost, PER_TURN) && r.estimated === false), 'priced rows use exact-model rates plus cached-input rate');
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
    ok(pProv && pProv.turns === 2 && pProv.inTok === 84 && pProv.cachedInTok === 2 * CACHED_TOKENS && pProv.label === 'Priced' && near(pProv.costsByCurrency[CUR], round6(2 * PER_TURN)), 'byProvider priced aggregates cache hits and model-specific cost');
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

    // ⑪ 117x-M1 byModel:账本行本来就带 model,这一刀只是把它聚合出来。注入四行——同一 provider 下的第二个
    // 模型(两条不同 ts,验 lastAt 取最近那条)、一条 model 为空串、一条 model 字段整个缺失。
    const T_OLDER = new Date(Date.now() - 120000).toISOString();
    const T_NEWER = new Date(Date.now() - 60000).toISOString();
    const mrow = o => JSON.stringify({ ts: T_OLDER, sessionId: s1, engine: 'openai', provider: 'priced', inTok: 10, outTok: 5, cost: null, currency: null, costTrusted: true, estimated: false, turnSeq: 1, ...o }) + '\n';
    fs.appendFileSync(LEDGER, mrow({ model: 'model-beta' }));
    fs.appendFileSync(LEDGER, mrow({ model: 'model-beta', ts: T_NEWER }));
    fs.appendFileSync(LEDGER, mrow({ model: '' }));  // 空串 model
    fs.appendFileSync(LEDGER, mrow({}));             // model 字段缺失
    const allSum = (await getJson(WB_PORT, '/api/usage/summary?range=all', hdr)).json;
    const monSum = (await getJson(WB_PORT, '/api/usage/summary?range=month', hdr)).json;
    const byModel = allSum && allSum.byModel;
    ok(Array.isArray(byModel) && byModel.length > 0, '⑪ summary 返回带 byModel 数组(' + (Array.isArray(byModel) ? byModel.length + ' 组' : typeof byModel) + ')');
    ok(Array.isArray(byModel) && byModel.every(m => m && typeof m.model === 'string' && m.model
      && typeof m.provider === 'string' && typeof m.engine === 'string'
      && Number.isFinite(m.turns) && Number.isFinite(m.inTok) && Number.isFinite(m.outTok)
      && typeof m.lastAt === 'string' && Number.isFinite(Date.parse(m.lastAt))),
      '⑪ byModel 每项带齐 {model,provider,engine,turns,inTok,outTok,lastAt} 且 lastAt 可解析');

    // 逐行重算(设计页 §11.17.7④):把磁盘上所有月份文件按 (engine,provider,model) 三元组自己聚一遍,与接口对齐。
    const diskRows = [];
    for (const f of fs.readdirSync(USAGE_DIR)) {
      if (!/^\d{4}-\d{2}\.jsonl$/.test(f)) continue;
      for (const l of fs.readFileSync(path.join(USAGE_DIR, f), 'utf8').split(/\r?\n/)) {
        if (!l.trim()) continue;
        let r = null; try { r = JSON.parse(l); } catch { continue; } // 坏行跳过,与 readUsageRows 同
        if (r && typeof r === 'object' && Number.isFinite(Date.parse(r.ts))) diskRows.push(r);
      }
    }
    const expect = new Map(); let emptyModelRows = 0;
    for (const r of diskRows) {
      const mid = String(r.model || '');
      if (!mid) { emptyModelRows++; continue; }
      const k = JSON.stringify([r.engine === 'claude' ? 'claude' : 'openai', String(r.provider || ''), mid]);
      let e = expect.get(k); if (!e) expect.set(k, e = { turns: 0, inTok: 0, outTok: 0, lastAt: '' });
      e.turns += 1; e.inTok += Number(r.inTok) || 0; e.outTok += Number(r.outTok) || 0;
      if (!e.lastAt || Date.parse(r.ts) > Date.parse(e.lastAt)) e.lastAt = String(r.ts);
    }
    const keyOf = m => JSON.stringify([m.engine, m.provider, m.model]);
    ok(Array.isArray(byModel) && byModel.length === expect.size && byModel.every(m => {
      const e = expect.get(keyOf(m));
      return e && e.turns === m.turns && e.inTok === m.inTok && e.outTok === m.outTok && e.lastAt === m.lastAt;
    }), '⑪ byModel 与账本逐行重算一致(接口 ' + (Array.isArray(byModel) ? byModel.length : '?') + ' 组 / 重算 ' + expect.size + ' 组)');

    // 口径锁:Σ byModel.turns 恰好 = Σ byEngine.turns − 空 model 行数(空 model 整行跳过,但仍进 engine/provider)。
    const mTurns = (byModel || []).reduce((a, m) => a + m.turns, 0);
    const eTurns = ((allSum && allSum.byEngine) || []).reduce((a, e) => a + e.turns, 0);
    ok(emptyModelRows === 2, '⑪ 只有注入的 2 条空 model 行(真回合都带 model,got ' + emptyModelRows + ')');
    ok(mTurns === eTurns - emptyModelRows, '⑪ Σ byModel.turns = Σ byEngine.turns − 空 model 行数 (' + mTurns + ' = ' + eTurns + ' − ' + emptyModelRows + ')');
    ok((byModel || []).every(m => m.model !== ''), '⑪ 空 model 行不进 byModel(不记成空串组)');

    // lastAt = 该模型最后一条账本行的 ts;排序按 lastAt 倒序(设计页「常用」按最近一次使用时间排)。
    const beta = (byModel || []).find(m => m.model === 'model-beta');
    ok(beta && beta.turns === 2 && beta.lastAt === T_NEWER, '⑪ lastAt 取该模型最近一条行的 ts(' + (beta && beta.lastAt) + ' === ' + T_NEWER + ')');
    ok((byModel || []).every((m, i, a) => i === 0 || Date.parse(a[i - 1].lastAt) >= Date.parse(m.lastAt)), '⑪ byModel 按 lastAt 倒序返回(不靠 Map 插入序)');

    // 历史行(2020-01 那条,账本里早就带着 model)照样被聚合进来:range=all 比 range=month 多它一回合。
    const findM = (s, prov, mod) => ((s && s.byModel) || []).find(m => m.provider === prov && m.model === mod);
    const allPriced = findM(allSum, 'priced', 'fake-model'), monPriced = findM(monSum, 'priced', 'fake-model');
    ok(allPriced && monPriced && allPriced.turns === monPriced.turns + 1 && allPriced.inTok === monPriced.inTok + 1000,
      '⑪ 历史行被聚合:range=all 的 priced/fake-model 比 range=month 多 2020-01 那一回合');
    // 沿用四个既有维度的同一套口径:planBased 推导 + costsByCurrency 分桶 + 缓存输入。
    const arkM = findM(allSum, 'ark-coding-plan', 'ark-code-latest');
    ok(arkM && arkM.planBased === true && Object.keys(arkM.costsByCurrency || {}).length === 0, '⑪ byModel 沿用 finishGroup:计划内计费行 planBased=true 且不进 costsByCurrency');
    ok(monPriced && monPriced.planBased === false && monPriced.cachedInTok === 2 * CACHED_TOKENS && near((monPriced.costsByCurrency || {})[CUR], round6(2 * PER_TURN)),
      '⑪ byModel 复用同一套成本/缓存口径(priced/fake-model 本月 = 2×perTurn)');

    // ⑫ 117x-M1 收口:兜底分支的维度键必须与成功分支一致。
    // 读盘出错那一刻端回一个形状不同的载荷,就是「返回什么取决于走了哪条分支」—— 本仓最贵的一类坑。
    // 钉的是【事实】不是字面量:两边各自抽出 by* 标识符集合再比,重排序/改注释/加非维度键都不会误红,
    // 只有「加了第 N 个维度却忘了兜底」才红。M1 加 byModel 时兜底就漏了,这条锁是为下一次准备的。
    const bootSrc = fs.readFileSync(path.join(WB, 'app', 'src', '00-boot.js'), 'utf8');
    const routerSrc = fs.readFileSync(path.join(WB, 'app', 'src', '13-http-router.js'), 'utf8');
    const dimsOf = text => new Set((text.match(/\bby[A-Z][A-Za-z0-9]*\s*:/g) || []).map(x => x.replace(/\s*:$/, '')));
    const fnStart = bootSrc.indexOf('async function buildUsageSummary');
    const okDims = dimsOf(bootSrc.slice(fnStart, bootSrc.indexOf('\n}', fnStart)));
    const fbStart = routerSrc.indexOf('Old install with no ledger');
    const fbDims = dimsOf(routerSrc.slice(fbStart, fbStart + 900));
    const missing = [...okDims].filter(k => !fbDims.has(k));
    const extra = [...fbDims].filter(k => !okDims.has(k));
    ok(okDims.size >= 5 && missing.length === 0 && extra.length === 0,
      '⑫ 兜底分支与成功分支的 by* 维度键逐个对齐(成功 ' + [...okDims].sort().join(',')
      + ';兜底缺 ' + (missing.join(',') || '无') + ',多 ' + (extra.join(',') || '无') + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fakeA, fakeB]) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nUSAGE-LEDGER E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
