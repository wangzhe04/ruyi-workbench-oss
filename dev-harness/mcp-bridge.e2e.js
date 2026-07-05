// E2E (v0.7d core acceptance): full bridge chain. fake-openai (provider) asks the workbench to call a
// BRIDGED tool `fake__echo`; the workbench's in-process MCP stdio client forwards it to fake-mcp.js
// (a stdio JSON-RPC MCP child); the result is fed back and the model echoes it. Fully offline.
//   model -> workbench -> McpStdioClient -> fake-mcp child -> result -> back to model
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = 8913, WB_PORT = 8799;
const HOME = path.join(os.tmpdir(), 'wcw-bridge-e2e');
const MARKER = 'BRIDGE_ECHO_MARKER_77';
const NODE = process.execPath;
const FAKE_MCP = path.join(HERE, 'fake-mcp.js');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
  activeProvider: 'fake',
  // Line 2 under test: a user-defined external stdio MCP server + the bridge master switch.
  externalMcpServers: [{ id: 'fake', label: 'Fake MCP', command: NODE, args: [FAKE_MCP], enabled: true }],
  bridgeExternalToolsToProvider: true,
  // Keep the built-in desktop MCP OFF so this test is deterministic (only the fake server is bridged).
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
}, null, 2));

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

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const fake = cp.spawn(NODE, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_NAME: 'fake__echo', FAKE_TOOL_ARGS: JSON.stringify({ message: MARKER }) }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  fake.stderr.on('data', d => String(d).trim() && console.log('[fake!] ' + String(d).trim()));
  const wb = cp.spawn(NODE, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    ok(h && h.version === '1.4.0', 'version 1.4.0 (got ' + (h && h.version) + ')');

    const events = await postStream(WB_PORT, { message: '请用 echo 工具回显一句话' });
    const meta = events.find(e => e.type === 'meta');
    const toolUse = events.find(e => e.type === 'tool_use' && e.name === 'fake__echo');
    const toolResult = events.find(e => e.type === 'tool_result');
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const result = events.find(e => e.type === 'result');

    ok(meta && meta.bridgedTools >= 1, 'meta.bridgedTools >= 1 (got ' + (meta && meta.bridgedTools) + ')');
    ok(!!toolUse, 'tool_use name === "fake__echo"' + (toolUse ? '' : ' (MISSING)'));
    ok(toolUse && toolUse.input && toolUse.input.message === MARKER, 'tool_use carries the echo arg (message=' + (toolUse && toolUse.input && toolUse.input.message) + ')');
    ok(toolResult && toolResult.isError !== true, 'tool_result ok (not error)');
    // The bridged result object is normalized from fake-mcp's {ok:true, echoed:MARKER}.
    const echoedBack = toolResult && toolResult.content && (toolResult.content.echoed === MARKER);
    ok(echoedBack, 'tool_result.content.echoed === MARKER (round-trip through fake-mcp): ' + JSON.stringify(toolResult && toolResult.content));
    ok(text.includes(MARKER), 'final answer echoes the marker from the MCP child: ' + JSON.stringify(text.slice(0, 80)));
    ok(result && result.ok === true, 'result ok=true');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(400);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nMCP-BRIDGE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
