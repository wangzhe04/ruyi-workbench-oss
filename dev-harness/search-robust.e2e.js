// E2E for v0.8-S2fix F2 (live-model finding): file_search must survive LLM regex habits.
// A real DeepSeek run passed `(?i)pass` (PCRE inline flag) and the old `new RegExp` threw
// 'Invalid group'. normalizeSearchPattern now (1) strips a leading inline-flag group, folding m/s
// into JS flags, and (2) falls back to LITERAL search with patternNote when the pattern still
// doesn't compile. Drives /api/tools/file_search directly (UI-token path, no provider needed).
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const WB_PORT = 8971;
const HOME = path.join(os.tmpdir(), 'wcw-search-robust-e2e');
const WORK = path.join(HOME, 'work');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 6, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: WORK,
}, null, 2));
// Seed: mixed-case target for the (?i) case + a literal '([x' occurrence for the fallback case.
fs.writeFileSync(path.join(WORK, 'seed.txt'), [
  'first line no target here',
  'second: The tests all PaSs when run',      // (?i)pass should hit this
  'third: literal chars ([x appear right here', // '([x' literal fallback should hit this
].join('\n'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function tool(port, token, name, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: '/api/tools/' + name, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': token } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    // NOTE: /api/tools/<name> wraps the tool response as { ok, result } (server.js handleApi) — the
    // file_search payload (matches/patternNote) lives at .result.

    // (a) PCRE inline flag: (?i)pass must NOT error, must hit the mixed-case line, no patternNote.
    const a = (await tool(WB_PORT, token, 'file_search', { root: WORK, pattern: '(?i)pass' })).result;
    ok(a && a.ok === true, '(?i)pass → ok:true (no Invalid group crash), err=' + (a && a.error));
    ok(a && Array.isArray(a.matches) && a.matches.some(m => /PaSs/.test(m.text)), '(?i)pass hits the mixed-case line');
    ok(a && a.patternNote === undefined, '(?i)pass carries NO patternNote (valid after stripping)');

    // (b) invalid regex: '([x' must fall back to literal search + patternNote, and hit the seeded line.
    const b = (await tool(WB_PORT, token, 'file_search', { root: WORK, pattern: '([x' })).result;
    ok(b && b.ok === true, 'invalid pattern → ok:true (literal fallback), err=' + (b && b.error));
    ok(b && b.patternNote === 'invalid regex; searched as literal text', 'patternNote present (got: ' + (b && b.patternNote) + ')');
    ok(b && Array.isArray(b.matches) && b.matches.some(m => m.text.includes('([x')), 'literal ([x found in seed');

    // (c) back-compat: a plain valid pattern behaves exactly as before (no note, normal shape).
    const c = (await tool(WB_PORT, token, 'file_search', { root: WORK, pattern: 'first line' })).result;
    ok(c && c.ok === true && c.matches.length === 1 && c.matches[0].line === 1 && c.patternNote === undefined, 'plain pattern unchanged shape');

    // (d) docs_search shares the sanitizer (S3fix, task #11): (?i) query must not crash and must hit.
    const d = (await tool(WB_PORT, token, 'docs_search', { root: WORK, query: '(?i)pass' })).result;
    ok(d && d.ok === true, 'docs_search (?i) query → ok:true (no Invalid group crash), err=' + (d && d.error));
    ok(d && Array.isArray(d.matches) && d.matches.length >= 1, 'docs_search (?i) query finds the seeded line');
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSEARCH-ROBUST E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
