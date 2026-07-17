// E2E (v0.8-S1): tool suite v2 — file_read line mode, binary refusal, glob, grep v2 (context/group),
// grep backward-compat, file_edit `closest`; (v0.8-S2fix F2) file_search pattern normalization:
// PCRE inline-flag prefix stripped, invalid regex → literal-text fallback + patternNote.
// Offline; drives the native provider engine via the
// fake OpenAI server. Each sub-test spawns its own fake (FAKE_TOOL_SEQUENCE differs per case) + a fresh
// workbench, asserts on the streamed tool_result, then tears both down. Uses ports 8961-8962.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-tools-v2-e2e');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
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
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}
(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  const spawnPair = (fakeEnv, fakePort, wbPort, home) => {
    const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), ...fakeEnv }, windowsHide: true });
    fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home }, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    procs.push(fake, wb);
    return { fake, wb };
  };
  const killPair = pair => { for (const c of [pair.wb, pair.fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } } };
  const waitHealthy = async (port) => { let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(port); } return h; };

  try {
    // ---- (a) line-mode read: 20-line file, lineOffset:5 lineLimit:3 -> lines 5-7, totalLines 20, mode 'lines'
    {
      const home = path.join(HOME, 'a'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const f = path.join(home, 'twenty.txt');
      fs.writeFileSync(f, Array.from({ length: 20 }, (_, i) => 'line-' + (i + 1)).join('\n'));
      writeConfig(home, 8961);
      const seq = JSON.stringify([{ name: 'file_read', args: { path: f, lineOffset: 5, lineLimit: 3 } }]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
      const h = await waitHealthy(8962); ok(!!h, '(a) workbench up');
      const events = await postStream(8962, { message: '读取行', cwd: home });
      const tr = events.find(e => e.type === 'tool_result');
      const c = tr && tr.content;
      ok(!!c && c.ok === true, '(a) file_read ok');
      ok(c && c.mode === 'lines', "(a) mode === 'lines' (got " + (c && c.mode) + ')');
      ok(c && c.totalLines === 20, '(a) totalLines === 20 (got ' + (c && c.totalLines) + ')');
      // cat -n style: "    5\tline-5" ... "    7\tline-7"; and NOT line 4 or 8.
      const body = (c && c.content) || '';
      ok(/(^|\n)\s*5\tline-5(\n|$)/.test(body), '(a) has line 5 prefix "5<tab>line-5"');
      ok(/\s*6\tline-6/.test(body) && /\s*7\tline-7/.test(body), '(a) has lines 6 and 7');
      ok(!/line-4/.test(body) && !/line-8/.test(body), '(a) excludes lines 4 and 8');
      ok(c && c.lineOffset === 5 && c.lineLimit === 3, '(a) echoes effective lineOffset/lineLimit');
      killPair(pair);
    }

    // ---- (b) binary refusal: file_read a .png -> ok:false, hint mentions 视觉
    {
      const home = path.join(HOME, 'b'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const png = path.join(home, 'pic.png'); fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeConfig(home, 8961);
      const seq = JSON.stringify([{ name: 'file_read', args: { path: png } }]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
      const h = await waitHealthy(8962); ok(!!h, '(b) workbench up');
      const events = await postStream(8962, { message: '读图', cwd: home });
      const tr = events.find(e => e.type === 'tool_result');
      const c = tr && tr.content;
      ok(c && c.ok === false, '(b) png read refused (ok:false)');
      ok(c && typeof c.hint === 'string' && c.hint.includes('视觉'), '(b) hint mentions 视觉 (got ' + (c && c.hint) + ')');
      killPair(pair);
    }

    // ---- (c) glob: nested dirs, **/*.txt covers nested files, mtime DESC, no node_modules
    {
      const home = path.join(HOME, 'c'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const proj = path.join(home, 'proj'); fs.mkdirSync(path.join(proj, 'sub', 'deep'), { recursive: true });
      fs.mkdirSync(path.join(proj, 'node_modules', 'pkg'), { recursive: true });
      // Write in a known order, oldest first, so mtime DESC is deterministic.
      fs.writeFileSync(path.join(proj, 'a.txt'), 'a'); await sleep(30);
      fs.writeFileSync(path.join(proj, 'sub', 'b.txt'), 'b'); await sleep(30);
      fs.writeFileSync(path.join(proj, 'sub', 'deep', 'c.txt'), 'c'); await sleep(30);
      fs.writeFileSync(path.join(proj, 'node_modules', 'pkg', 'skip.txt'), 'skip'); await sleep(30);
      fs.writeFileSync(path.join(proj, 'newest.txt'), 'newest');
      fs.writeFileSync(path.join(proj, 'notme.md'), 'md');
      writeConfig(home, 8961);
      const seq = JSON.stringify([{ name: 'glob', args: { pattern: '**/*.txt', root: proj } }]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
      const h = await waitHealthy(8962); ok(!!h, '(c) workbench up');
      const events = await postStream(8962, { message: 'glob', cwd: home });
      const tr = events.find(e => e.type === 'tool_result');
      const c = tr && tr.content;
      ok(c && c.ok === true && Array.isArray(c.files), '(c) glob returns files array');
      const rels = (c.files || []).map(f => f.relativePath.replace(/\\/g, '/'));
      ok(rels.some(r => /sub\/b\.txt$/.test(r)) && rels.some(r => /sub\/deep\/c\.txt$/.test(r)), '(c) covers nested files');
      ok(rels.some(r => /^a\.txt$/.test(r)) && rels.some(r => /newest\.txt$/.test(r)), '(c) covers top-level files');
      ok(!rels.some(r => /node_modules/.test(r)), '(c) no node_modules');
      ok(!rels.some(r => /\.md$/.test(r)), '(c) .md excluded by pattern');
      const mtimes = (c.files || []).map(f => f.mtime);
      const sortedDesc = mtimes.every((m, i) => i === 0 || mtimes[i - 1] >= m);
      ok(sortedDesc, '(c) files sorted mtime DESC');
      ok(c.files[0] && /newest\.txt$/.test(c.files[0].relativePath.replace(/\\/g, '/')), '(c) newest.txt first');
      killPair(pair);
    }

    // ---- (d) grep context + group
    {
      const home = path.join(HOME, 'd'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const proj = path.join(home, 'src'); fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'one.js'), ['aaa', 'bbb', 'TARGET here', 'ccc', 'ddd'].join('\n'));
      fs.writeFileSync(path.join(proj, 'two.js'), ['xxx', 'TARGET again', 'yyy'].join('\n'));
      writeConfig(home, 8961);
      // context:2
      {
        const seq = JSON.stringify([{ name: 'file_search', args: { pattern: 'TARGET', root: proj, context: 2 } }]);
        const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
        const h = await waitHealthy(8962); ok(!!h, '(d) workbench up (context)');
        const events = await postStream(8962, { message: 'grep', cwd: home });
        const tr = events.find(e => e.type === 'tool_result');
        const m = tr && tr.content && tr.content.matches;
        ok(Array.isArray(m) && m.length >= 2, '(d) >=2 matches');
        const hit = m.find(x => /one\.js$/.test(x.relativePath.replace(/\\/g, '/')));
        ok(hit && Array.isArray(hit.context), '(d) match carries context block');
        ok(hit && hit.context.some(l => l.line === 3 && l.match === true), '(d) match line flagged (line 3, match:true)');
        ok(hit && hit.context.some(l => l.line === 1 && l.match === false) && hit.context.some(l => l.line === 5), '(d) context spans +/-2 lines with line numbers');
        killPair(pair);
      }
      // group:true
      {
        const seq = JSON.stringify([{ name: 'file_search', args: { pattern: 'TARGET', root: proj, group: true } }]);
        const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
        const h = await waitHealthy(8962); ok(!!h, '(d) workbench up (group)');
        const events = await postStream(8962, { message: 'grep-group', cwd: home });
        const tr = events.find(e => e.type === 'tool_result');
        const g = tr && tr.content && tr.content.matches;
        ok(Array.isArray(g) && g.length === 2, '(d) grouped into 2 files (got ' + (g && g.length) + ')');
        ok(g && g.every(x => x.path && Array.isArray(x.matches)), '(d) group entries have {path, matches[]}');
        killPair(pair);
      }
    }

    // ---- (e) backward-compat: plain file_search fields identical to S0 baseline (path/line/text)
    {
      const home = path.join(HOME, 'e'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const proj = path.join(home, 'src'); fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'f.js'), ['zzz', 'NEEDLE line', 'qqq'].join('\n'));
      writeConfig(home, 8961);
      const seq = JSON.stringify([{ name: 'file_search', args: { pattern: 'NEEDLE', root: proj } }]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
      const h = await waitHealthy(8962); ok(!!h, '(e) workbench up');
      const events = await postStream(8962, { message: 'grep-compat', cwd: home });
      const tr = events.find(e => e.type === 'tool_result');
      const m = tr && tr.content && tr.content.matches;
      ok(Array.isArray(m) && m.length === 1, '(e) one match');
      const hit = m && m[0];
      ok(hit && typeof hit.path === 'string' && hit.line === 2 && hit.text === 'NEEDLE line', '(e) fields path/line/text as baseline');
      ok(hit && hit.context === undefined, '(e) no context field when not requested');
      killPair(pair);
    }

    // ---- (f) file_edit closest: oldText not present -> ok:false + closest {line, snippet}
    {
      const home = path.join(HOME, 'f'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const f = path.join(home, 'edit-me.txt');
      fs.writeFileSync(f, ['alpha line', 'beta line', 'gamma line', 'delta line', 'epsilon line'].join('\n'));
      writeConfig(home, 8961);
      // needle close to 'gamma line' but not exact -> closest should land near line 3
      const seq = JSON.stringify([{ name: 'file_edit', args: { path: f, oldText: 'gamma lime', newText: 'X' } }]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
      const h = await waitHealthy(8962); ok(!!h, '(f) workbench up');
      const events = await postStream(8962, { message: 'edit', cwd: home });
      const tr = events.find(e => e.type === 'tool_result');
      const c = tr && tr.content;
      ok(c && c.ok === false, '(f) edit ok:false (not found)');
      ok(c && c.closest && typeof c.closest.line === 'number', '(f) closest.line present (got ' + (c && c.closest && c.closest.line) + ')');
      ok(c && c.closest && c.closest.line === 3, '(f) closest points at line 3 (gamma)');
      ok(c && c.closest && typeof c.closest.snippet === 'string' && /gamma line/.test(c.closest.snippet), '(f) closest.snippet window contains gamma line');
      ok(c && c.closest && /beta line/.test(c.closest.snippet) && /delta line/.test(c.closest.snippet), '(f) snippet is +/-3 line window');
      killPair(pair);
    }

    // ---- (g) v0.8-S2fix F2: PCRE inline-flag prefix `(?i)pass` must not crash — stripped & matched
    // (real-model finding: LLMs emit (?i) constantly; JS RegExp used to throw "Invalid group").
    {
      const home = path.join(HOME, 'g'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const proj = path.join(home, 'src'); fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'creds.js'), ['const user = "bob";', 'const PaSsWoRd = "x";', 'done'].join('\n'));
      writeConfig(home, 8961);
      const seq = JSON.stringify([{ name: 'file_search', args: { pattern: '(?i)pass', root: proj } }]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
      const h = await waitHealthy(8962); ok(!!h, '(g) workbench up');
      const events = await postStream(8962, { message: 'grep-inline-flag', cwd: home });
      const tr = events.find(e => e.type === 'tool_result');
      const c = tr && tr.content;
      ok(c && c.ok === true, '(g) (?i)pass does not error (ok:true)');
      const m = c && c.matches;
      ok(Array.isArray(m) && m.length === 1 && m[0].line === 2, '(g) (?i)pass matches the mixed-case line 2 (got ' + JSON.stringify(m && m.map(x => x.line)) + ')');
      ok(c && c.patternNote === undefined, '(g) no patternNote (valid regex after stripping)');
      killPair(pair);
    }

    // ---- (h) v0.8-S2fix F2: invalid pattern `([x` falls back to literal-text search + patternNote
    {
      const home = path.join(HOME, 'h'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const proj = path.join(home, 'src'); fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'weird.txt'), ['nothing here', 'literal ([x marker', 'tail'].join('\n'));
      writeConfig(home, 8961);
      const seq = JSON.stringify([{ name: 'file_search', args: { pattern: '([x', root: proj } }]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, 8961, 8962, home);
      const h = await waitHealthy(8962); ok(!!h, '(h) workbench up');
      const events = await postStream(8962, { message: 'grep-literal-fallback', cwd: home });
      const tr = events.find(e => e.type === 'tool_result');
      const c = tr && tr.content;
      ok(c && c.ok === true, '(h) invalid regex does not error (ok:true)');
      const m = c && c.matches;
      ok(Array.isArray(m) && m.length === 1 && m[0].line === 2 && /\(\[x/.test(m[0].text), '(h) literal fallback finds the ([x line (got ' + JSON.stringify(m && m[0]) + ')');
      ok(c && c.patternNote === 'invalid regex; searched as literal text', '(h) patternNote present (got: ' + (c && c.patternNote) + ')');
      killPair(pair);
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nTOOLS-V2 E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
