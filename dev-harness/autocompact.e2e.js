(async () => {
﻿// E2E for v0.8-S5 上下文管理 (§7.7): estimate v2 (parts-aware) + two-level auto-compaction + pairing
// iron law + append-only cache discipline + history snapshot + tiered truncation.
//
// Strategy (no fake changes needed — real big file heaps the window): a provider with a SMALL
// contextWindow + autoCompactThreshold 0.8, a 200KB seed file, and FAKE_TOOL_SEQUENCE = three full
// file_reads. Each truncated file_read result (~48KB → ~13K est-tokens) accumulates until the iteration
// boundary est crosses the budget, at which point LEVEL 1 (evaporate) rewrites the oldest tool result's
// content in place and the turn continues.
//
// NOTE on contextWindow value (design deviation, see delivery notes): the slice spec text suggested
// contextWindow:3000, but with a 200KB full read the FIRST truncated result alone (~13K est-tokens) is
// ~5× a 2400-token budget, so the very first crossing would jump straight to summary-reseed and the
// `evaporate` mode assertion (spec 5.a) could never be satisfied — evaporation only touches tool messages
// that precede the most-recent-2-assistant window, which requires ≥3 assistant turns to have accumulated.
// We therefore size the window (40000, budget 32000) so all three reads accumulate first and evaporate
// fires deterministically at the third boundary. This honors the design INTENT (exercise level-1
// evaporation with the pairing iron law intact) over the literal number.
//
// Asserts:
//   a) stream carries a `compact` event with mode 'evaporate'
//   b) turn completes with result ok:true
//   c) providerHistory pairing intact: every assistant.tool_calls id has a matching role:'tool' msg;
//      an evaporated tool msg content starts with '[已省略:'
//   d) checkpoints/<sid>/history-*.json.gz exists and gunzips to a valid JSON array
//   e) session.messages contains a 🗜 system message
//   f) a follow-up ordinary turn still answers (compaction didn't break the engine)
//   g) module.exports estimateHistoryTokens direct unit: pure-CJK ≈ len/1.5 (±10%); a tool_calls
//      assistant msg counts its arguments length
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

const { getFreePort } = require('./free-port.js');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort(); // 自内层 IIFE 提升:顶层 fixture 也要用(9642e26 codemod 事故修复)

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-autocompact-e2e');
const BIGFILE = path.join(HOME, 'big.txt');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
// 200KB ASCII text file (full reads heap the window). Multi-line so line-mode would also work.
fs.writeFileSync(BIGFILE, ('lorem ipsum dolor sit amet ' .repeat(40) + '\n').repeat(180), 'utf8');

fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key',
    model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], reasoning: true,
    contextWindow: 40000, // small window so three full reads cross the budget (see NOTE above)
  }],
  activeProvider: 'fake',
  autoCompactThreshold: 0.8, // budget = 32000 est-tokens
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ── (g) module.exports direct unit test (no server needed) ────────────────────────────────────────
  const mod = require(path.join(WB, 'app', 'server.js'));
  const est = mod.estimateHistoryTokens;
  ok(typeof est === 'function', 'estimateHistoryTokens is exported');
  if (typeof est === 'function') {
    const CJK_LEN = 300;
    const cjk = '中'.repeat(CJK_LEN); // '中' × 300
    const cjkTokens = est([{ role: 'user', content: cjk }]) - 40; // subtract per-message overhead
    const expected = CJK_LEN / 1.5; // 200
    const ratio = cjkTokens / expected;
    ok(Math.abs(ratio - 1) <= 0.10, `pure-CJK estimate ≈ len/1.5 (got ${cjkTokens}, expected ~${expected}, ratio ${ratio.toFixed(3)})`);
    // tool_calls arguments are counted: an assistant carrying big args must estimate far higher than one
    // with empty args (delta ≈ args.length / 3.6 for ascii args).
    const bigArgs = JSON.stringify({ path: 'p'.repeat(1000) }); // ~1011 ascii chars
    const withArgs = est([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: bigArgs } }] }]);
    const noArgs = est([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' }, }] }]);
    const delta = withArgs - noArgs;
    const expectedDelta = (bigArgs.length - 2) / 3.6; // '{}' baseline
    ok(delta > expectedDelta * 0.85 && delta < expectedDelta * 1.15, `tool_calls arguments counted (delta ${delta} ≈ ${Math.round(expectedDelta)})`);
    // parts-aware: an image part adds a fixed 1100.
    const withImg = est([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:x' } }] }]);
    const noImg = est([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    ok((withImg - noImg) === 1100, `image part adds fixed 1100 tokens (delta ${withImg - noImg})`);
  }

  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
    windowsHide: true,
    env: { ...process.env,
      // 第45波:本件测的是压缩【机制】(L1 蒸发/配对铁律/快照),不是估算校准 —— fake 的 usage 是
      // 玩具数(11/18 tokens),45d 会把 factor 学到 0.5 下限 → 校准后估算减半 → 预算永不跨越。
      // 关掉 usage 帧 = 无样本 = 因子恒 1,机制断言与校准解耦(校准本身的回归在 context-compact-v2)。
      FAKE_NO_USAGE: '1',
      FAKE_TOOL_SEQUENCE: JSON.stringify([
      { name: 'file_read', args: { path: BIGFILE } },
      { name: 'file_read', args: { path: BIGFILE } },
      { name: 'file_read', args: { path: BIGFILE } },
    ]) },
  });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    // Turn 1: three full file_reads → threshold crossing → auto-compaction.
    const events = await postStream(WB_PORT, { message: '请读三次 big.txt 然后总结' });
    const sid = (events.find(e => e.type === 'session') || {}).session?.id;
    ok(!!sid, 'session id captured');

    // (a) compact event with mode 'evaporate'.
    const compactEvents = events.filter(e => e.type === 'compact');
    ok(compactEvents.length > 0, 'at least one compact event (' + compactEvents.length + ')');
    const hadEvaporate = compactEvents.some(e => e.mode === 'evaporate');
    ok(hadEvaporate, 'compact event with mode "evaporate" present (' + compactEvents.map(e => e.mode).join(',') + ')');
    // sanity: compact events carry beforeTokens > afterTokens numbers.
    ok(compactEvents.every(e => typeof e.beforeTokens === 'number' && typeof e.afterTokens === 'number' && e.afterTokens < e.beforeTokens),
      'compact events carry beforeTokens>afterTokens');

    // (b) turn completed ok.
    const result = events.find(e => e.type === 'result');
    ok(result && result.ok === true, 'turn 1 result ok:true (' + JSON.stringify(result) + ')');

    // (c) pairing iron law: every assistant.tool_calls id has a matching role:'tool' message.
    const s1 = await getJson(WB_PORT, '/api/sessions/' + encodeURIComponent(sid));
    const ph = (s1 && s1.session && s1.session.providerHistory) || [];
    const toolIds = new Set(ph.filter(m => m && m.role === 'tool').map(m => m.tool_call_id));
    let allPaired = true, tcCount = 0;
    for (const m of ph) {
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) { tcCount++; if (!toolIds.has(tc.id)) allPaired = false; }
      }
    }
    ok(tcCount > 0 && allPaired, `pairing intact: all ${tcCount} tool_call ids have a role:'tool' answer`);
    const evaporatedMsgs = ph.filter(m => m && m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('[已省略:'));
    ok(evaporatedMsgs.length > 0, 'at least one tool message content starts with "[已省略:" (' + evaporatedMsgs.length + ')');

    // (d) history snapshot exists + gunzips to a JSON array.
    const ckDir = path.join(HOME, 'checkpoints', sid);
    const snaps = fs.existsSync(ckDir) ? fs.readdirSync(ckDir).filter(f => /^history-\d+\.json\.gz$/.test(f)) : [];
    ok(snaps.length > 0, 'checkpoints/<sid>/history-*.json.gz snapshot exists (' + snaps.join(',') + ')');
    let snapOk = false;
    if (snaps.length) {
      try {
        const raw = zlib.gunzipSync(fs.readFileSync(path.join(ckDir, snaps[0])));
        const parsed = JSON.parse(raw.toString('utf8'));
        snapOk = Array.isArray(parsed);
      } catch { snapOk = false; }
    }
    ok(snapOk, 'snapshot gunzips to a valid JSON array');

    // (e) 🗜 system message present.
    const msgs = (s1 && s1.session && s1.session.messages) || [];
    const compactSys = msgs.filter(m => m && m.role === 'system' && /🗜/.test(m.content || ''));
    ok(compactSys.length > 0, '🗜 system compact message present (' + compactSys.length + ')');

    // (f) follow-up ordinary turn still answers.
    const events2 = await postStream(WB_PORT, { message: 'thanks, now say hello', sessionId: sid });
    const text2 = events2.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const result2 = events2.find(e => e.type === 'result');
    ok(result2 && result2.ok === true, 'post-compaction follow-up turn result ok:true');
    ok(text2.trim().length > 0, 'post-compaction follow-up streamed a reply ("' + text2.slice(0, 30).replace(/\n/g, ' ') + '")');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nAUTOCOMPACT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
