// E2E: the live Provider loop extends a small standard budget only after distinct successful progress.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePorts } = require('./free-port');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), `ruyi-adaptive-budget-${process.pid}`);
const CAPTURE = path.join(HOME, 'capture');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', chunk => {
        buf += chunk;
        for (;;) {
          const nl = buf.indexOf('\n'); if (nl < 0) break;
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* diagnostics */ } }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

(async () => {
  let fail = 0; const children = [];
  const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const [fakePort, wbPort] = await getFreePorts(2);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 8,
    version: '1.6.3',
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    toolLoadingMode: 'auto',
    openaiMaxToolIterations: 3,
    subagentMaxPerTurn: 4,
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [],
    bridgeExternalToolsToProvider: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));

  try {
    const sequence = [
      { name: 'tool_search', args: { query: 'workspace files' } },
      { name: 'tool_search', args: { query: 'git status' } },
      { name: 'tool_search', args: { query: 'run tests' } },
    ];
    fs.mkdirSync(CAPTURE, { recursive: true });
    const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_TOOL_SEQUENCE: JSON.stringify(sequence), FAKE_CAPTURE_DIR: CAPTURE }, windowsHide: true });
    const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    children.push(fake, wb);
    let live = null;
    for (let i = 0; i < 50 && !live; i++) { await sleep(120); live = await health(wbPort); }
    ok(!!live, 'workbench starts');
    const events = await postStream(wbPort, { message: 'Inspect the available tools and answer briefly.' });
    const extended = events.find(event => event.type === 'tool_budget' && event.state === 'extended');
    ok(extended && extended.from === 3 && extended.to === 53 && extended.hardLimit === 300, 'live loop extends 3 → 53 after three distinct successful tool calls');
    ok(!events.some(event => event.type === 'assistant_delta' && String(event.text || '').includes('已达工具调用上限 3')), 'turn is not stopped at the original budget');
    ok(events.some(event => event.type === 'result' && event.ok === true), 'turn completes normally after extension');

    const teamEvents = await postStream(wbPort, { message: 'Compare two approaches.', agentTeam: true });
    ok(teamEvents.some(event => event.type === 'result' && event.ok === true), 'Agent team turn completes');
    const captures = fs.readdirSync(CAPTURE).filter(name => name.endsWith('.json')).sort();
    const teamBody = JSON.parse(fs.readFileSync(path.join(CAPTURE, captures[captures.length - 1]), 'utf8'));
    const systemText = String(teamBody.messages && teamBody.messages[0] && teamBody.messages[0].content || '');
    ok(systemText.includes('<agent-team-mode>') && systemText.includes('MUST actually call orchestrate_agents or spawn_agent'), 'OpenAI request receives the aggressive Agent team policy');
  } catch (error) {
    fail++;
    console.log('ERROR ' + (error && error.stack || error));
  } finally {
    children.reverse().forEach(killTree);
    await sleep(150);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(`\nADAPTIVE-BUDGET E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
    process.exitCode = fail ? 1 : 0;
  }
})();
