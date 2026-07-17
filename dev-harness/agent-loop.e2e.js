// E2E (v0.8-S1): agent loop over the new fake modes.
//  Part 1 (FAKE_TOOL_SEQUENCE): three DIFFERENT tools in order (file_write -> file_read -> file_search).
//    Asserts 3 tool_use events appear in that order, all 3 tool_result are ok, the terminal usage event
//    reports calls===4 (3 tool rounds + 1 echo finish) with input_tokens === sum of 4 frames, result ok.
//  Part 2 (FAKE_PARALLEL_TOOLS): two tools emitted in ONE assistant message. Asserts both tool_use land
//    in the same assistant round, both tool_result are present, and the turn finishes normally.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-agent-loop-e2e');
const PER_CALL_PROMPT = 42; // from fake-openai usageFrame()

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
    // ---- Part 1: sequential three-step loop ----
    {
      const FP1 = await getFreePort(), WP1 = await getFreePort();
      const home = path.join(HOME, 'seq'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const target = path.join(home, 'made.txt');
      writeConfig(home, FP1);
      const seq = JSON.stringify([
        { name: 'file_write', args: { path: target, content: 'FINDME payload here' } },
        { name: 'file_read', args: { path: target } },
        { name: 'file_search', args: { pattern: 'FINDME', root: home } },
      ]);
      const pair = spawnPair({ FAKE_TOOL_SEQUENCE: seq }, FP1, WP1, home);
      const h = await waitHealthy(WP1); ok(!!h, 'seq: workbench up');
      const events = await postStream(WP1, { message: '三步走', cwd: home });
      const toolUses = events.filter(e => e.type === 'tool_use');
      const toolResults = events.filter(e => e.type === 'tool_result');
      ok(toolUses.length === 3, 'seq: 3 tool_use events (got ' + toolUses.length + ')');
      ok(toolUses[0] && toolUses[0].name === 'file_write' && toolUses[1] && toolUses[1].name === 'file_read' && toolUses[2] && toolUses[2].name === 'file_search',
        'seq: tool_use order file_write -> file_read -> file_search (got ' + toolUses.map(t => t.name).join(',') + ')');
      ok(toolResults.length === 3 && toolResults.every(r => r.isError !== true), 'seq: 3 tool_result all ok');
      const usage = events.find(e => e.type === 'usage');
      ok(usage && usage.calls === 4, 'seq: usage.calls === 4 (3 tool rounds + 1 finish) (got ' + (usage && usage.calls) + ')');
      ok(usage && usage.usage && usage.usage.input_tokens === PER_CALL_PROMPT * 4, 'seq: input_tokens === 4*42 (got ' + (usage && usage.usage && usage.usage.input_tokens) + ')');
      const result = events.find(e => e.type === 'result');
      ok(result && result.ok === true, 'seq: result ok=true');
      killPair(pair);
    }

    // ---- Part 2: parallel two-tool round ----
    {
      const home = path.join(HOME, 'par'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
      const fA = path.join(home, 'pa.txt'); fs.writeFileSync(fA, 'alpha');
      const fB = path.join(home, 'pb.txt'); fs.writeFileSync(fB, 'beta');
      writeConfig(home, FP2);
      const par = JSON.stringify([
        { name: 'file_read', args: { path: fA } },
        { name: 'file_read', args: { path: fB } },
      ]);
      const pair = spawnPair({ FAKE_PARALLEL_TOOLS: par }, FP2, WP2, home);
      const h = await waitHealthy(WP2); ok(!!h, 'par: workbench up');
      const events = await postStream(WP2, { message: '并行两个', cwd: home });
      const toolUses = events.filter(e => e.type === 'tool_use');
      const toolResults = events.filter(e => e.type === 'tool_result');
      ok(toolUses.length === 2, 'par: 2 tool_use events (got ' + toolUses.length + ')');
      // Same assistant round: both tool_use appear before any tool_result-driven follow-up round; their
      // call ids are call_1 and call_2 as emitted in one message.
      ok(toolUses[0] && toolUses[1] && toolUses[0].id === 'call_1' && toolUses[1].id === 'call_2', 'par: ids call_1 & call_2 in one round');
      ok(toolResults.length === 2 && toolResults.every(r => r.isError !== true), 'par: 2 tool_result all ok');
      const usage = events.find(e => e.type === 'usage');
      ok(usage && usage.calls === 2, 'par: usage.calls === 2 (parallel round + finish) (got ' + (usage && usage.calls) + ')');
      const result = events.find(e => e.type === 'result');
      ok(result && result.ok === true, 'par: result ok=true');
      killPair(pair);
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nAGENT-LOOP E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
