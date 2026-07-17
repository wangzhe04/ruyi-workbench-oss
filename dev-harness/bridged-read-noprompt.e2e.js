// E2E (v0.8-S0): bridged-tool permission tiering under permissionMode 'default'.
//   Segment A: a READ-tier bridged tool (fake__screenshot_full — matches BRIDGED_TOOL_TIERS' read rule)
//     must auto-allow: NO permission_request event, tool_result ok.
//   Segment B: an EXEC-tier bridged tool (fake__echo) must prompt: a permission_request IS emitted;
//     with no UI answering it times out (permissionTimeoutMs 6000) and the tool_result is a denial,
//     and the turn still finishes cleanly.
// Two independent workbench+fake pairs keep the two provider configs isolated. Fully offline.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const NODE = process.execPath;
const FAKE_MCP = path.join(HERE, 'fake-mcp.js');

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

function seedHome(home, fakePort) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 4, version: '0.7.0',
    permissionMode: 'default',        // the whole point: read auto-allows, exec prompts
    permissionTimeoutMs: 6000,        // exec prompt times out fast so the turn can finish
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
    externalMcpServers: [{ id: 'fake', label: 'Fake MCP', command: NODE, args: [FAKE_MCP], enabled: true }],
    bridgeExternalToolsToProvider: true,
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }, null, 2));
}

async function runSegment({ label, wbPort, fakePort, home, toolName, toolArgs, procs }) {
  seedHome(home, fakePort);
  const fake = cp.spawn(NODE, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_TOOL_NAME: toolName, FAKE_TOOL_ARGS: JSON.stringify(toolArgs || {}) }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake:' + label + '] ' + String(d).trim()));
  fake.stderr.on('data', d => String(d).trim() && console.log('[fake!:' + label + '] ' + String(d).trim()));
  const wb = cp.spawn(NODE, ['app/server.js', 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb:' + label + '] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!:' + label + '] ' + l.trim())));
  procs.push(fake, wb);
  let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(wbPort); }
  if (!h) return { listening: false };
  const events = await postStream(wbPort, { message: '请调用工具', cwd: home });
  return { listening: true, events };
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  try {
    const WB_PORT_A = await getFreePort(), FAKE_PORT_A = await getFreePort();
    const WB_PORT_B = await getFreePort(), FAKE_PORT_B = await getFreePort();
    // --- Segment A: read-tier bridged tool auto-allows ---
    const a = await runSegment({ label: 'A', wbPort: WB_PORT_A, fakePort: FAKE_PORT_A, home: path.join(os.tmpdir(), 'wcw-bridged-read-a'), toolName: 'fake__screenshot_full', toolArgs: {}, procs });
    ok(a.listening, 'segment A workbench listening');
    if (a.events) {
      const permReq = a.events.find(e => e.type === 'permission_request');
      const toolUse = a.events.find(e => e.type === 'tool_use' && e.name === 'fake__screenshot_full');
      const toolResult = a.events.find(e => e.type === 'tool_result');
      const result = a.events.find(e => e.type === 'result');
      ok(!!toolUse, 'A: tool_use fake__screenshot_full emitted');
      ok(!permReq, 'A: NO permission_request (read tier auto-allowed in default mode)');
      ok(toolResult && toolResult.isError !== true, 'A: tool_result ok (not error)');
      ok(result && result.ok === true, 'A: result ok=true');
    }

    // --- Segment B: exec-tier bridged tool prompts, then denies on timeout ---
    const b = await runSegment({ label: 'B', wbPort: await getFreePort(), fakePort: await getFreePort(), home: path.join(os.tmpdir(), 'wcw-bridged-read-b'), toolName: 'fake__echo', toolArgs: { message: 'hi' }, procs });
    ok(b.listening, 'segment B workbench listening');
    if (b.events) {
      const permReq = b.events.find(e => e.type === 'permission_request');
      const toolResult = b.events.find(e => e.type === 'tool_result');
      const result = b.events.find(e => e.type === 'result');
      ok(!!permReq, 'B: permission_request emitted (exec tier prompts in default mode)');
      ok(toolResult && toolResult.isError === true, 'B: tool_result is a denial (isError true) after prompt timeout');
      const deniedMsg = toolResult && toolResult.content && typeof toolResult.content.error === 'string' && /denied|timed out/i.test(toolResult.content.error);
      ok(deniedMsg, 'B: denial carries a denied/timeout reason: ' + JSON.stringify(toolResult && toolResult.content));
      ok(!!result, 'B: turn finished cleanly (result event present)');
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(400);
    for (const d of ['wcw-bridged-read-a', 'wcw-bridged-read-b']) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    console.log('\nBRIDGED-READ-NOPROMPT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
