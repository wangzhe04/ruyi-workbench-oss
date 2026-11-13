'use strict';
// Local deterministic provider -> real Workbench -> real ACC. Never contacts a
// model service or a public website. --headed exercises the default GUI launch.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), http = require('http');
const repo = path.resolve(__dirname, '../..');
const { fixtureChildEnv } = require(path.join(repo, 'dev-harness/lib/fixture-home'));
const { killOwnTree } = require(path.join(repo, 'dev-harness/lib/kill-own-tree'));
const { getFreePort } = require(path.join(repo, 'dev-harness/free-port'));
const { createRunner } = require(path.join(repo, 'dev-harness/lib/harness'));
const { startFakeProvider, textFrames, toolCallFrames } = require(path.join(repo, 'dev-harness/lib/fake-openai-provider'));
const t = createRunner('MAC OVERALL WORKFLOW');
const headed = process.argv.includes('--headed');
const outIndex = process.argv.indexOf('--out');
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error('Pass --out <new evidence directory>');
const out = path.resolve(process.argv[outIndex + 1]);
if (fs.existsSync(out)) throw new Error('Evidence directory already exists');
fs.mkdirSync(out, { recursive: true });
const fixture = fixtureChildEnv({ perTest: true });
const root = fixture.home, workspace = path.join(root, '中文 工作区'), data = path.join(root, 'workbench');
fs.mkdirSync(workspace); fs.mkdirSync(data); fs.mkdirSync(path.join(root, 'tmp'));
const marker = '如意 Mac 整体验收 2026';
const document = path.join(workspace, '验收报告.docx');
const acc = path.join(repo, 'mcp/ai-computer-control');
const python = process.env.RUYI_ACC_PYTHON || path.join(acc, '.venv/bin/python');
const env = { ...fixture.env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data,
  PYTHONPATH: path.join(acc, 'src'), PYTHONUTF8: '1', WCW_DATA_DIR: path.join(root, 'acc'),
  ACC_TOOLSETS: 'office,browser,filesystem', ACC_BROWSER_MODE: 'bundled', ACC_BROWSER_HEADLESS: headed ? '0' : '1',
  ACC_BROWSER_EXECUTABLE: '', PLAYWRIGHT_BROWSERS_PATH: process.env.RUYI_BROWSER_CACHE_SOURCE,
  TMPDIR: path.join(root, 'tmp'), WCW_TEST_NO_NET_ANCHORS: '1' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let fake, server, site, token = '', base = '', evidence = { headed, marker };
let ownedProfiles = [], canonicalProfiles = [], ownedBrowsers = [], observedTree = [];
const ps = () => cp.execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  .split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
  .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
const tree = parent => {
  const rows = ps(), ids = new Set([parent]);
  for (let pass = 0; pass < rows.length; pass++) {
    const size = ids.size;
    for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
    if (ids.size === size) break;
  }
  return rows.filter(row => row.pid !== parent && ids.has(row.pid));
};
const gone = rows => {
  const current = new Map(ps().map(row => [row.pid, row.command]));
  return rows.every(row => current.get(row.pid) !== row.command);
};
const request = async (route, body) => {
  const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-wcw-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(route + ': HTTP ' + res.status);
  return res;
};
(async () => {
  try {
    if (process.platform !== 'darwin') throw new Error('This acceptance requires macOS');
    if (!env.PLAYWRIGHT_BROWSERS_PATH || !fs.existsSync(python)) throw new Error('Prepare ACC and offline Chromium cache');
    const submissions = [];
    site = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.method === 'POST' && req.url === '/submit') {
        let raw = ''; req.on('data', b => { raw += b; });
        req.on('end', () => { submissions.push(new URLSearchParams(raw).get('name')); res.end('<!doctype html><meta charset="utf-8"><title>如意整体验收成功</title><h1 id="result">' + marker + '</h1>'); });
      } else res.end('<!doctype html><meta charset="utf-8"><title>如意 Mac 整体验收</title><h1>本地浏览器验收</h1><form action="/submit" method="post"><label>姓名<input id="name" name="name"></label><button id="submit">提交本地表单</button></form>');
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    const siteUrl = 'http://127.0.0.1:' + site.address().port;
    const steps = [
      ['write_document', { path: document, content: marker, title: 'Mac 整体验收报告' }],
      ['read_document', { path: document }],
      ['browser_open', { url: siteUrl }],
      ['browser_backend_status', {}],
      ['browser_type', { selector: '#name', text: marker }],
      ['browser_click', { selector: '#submit' }],
      ['browser_get_text', { selector: '#result' }],
      ['browser_screenshot', {}],
      ['browser_close', {}],
      ['browser_backend_status', {}],
    ];
    const forwarded = [];
    fake = await startFakeProvider({ async handler(req) {
      const results = req.messages.filter(m => m.role === 'tool');
      if (results.length) forwarded[results.length - 1] = results.at(-1).content;
      if (results.length === 4) {
        const rows = tree(server.pid);
        observedTree = rows;
        ownedBrowsers = rows.filter(row => row.command.includes('/playwright/driver/') || row.command.includes('--user-data-dir='));
        ownedProfiles = [...new Set(rows.map(row => /--user-data-dir=([^\s]+)/.exec(row.command)?.[1]).filter(Boolean))];
        canonicalProfiles = ownedProfiles.map(p => fs.realpathSync(p));
      }
      if (results.length === 8 && process.argv.includes('--observe-ui')) {
        fs.writeFileSync(path.join(out, 'ui-ready.json'), JSON.stringify({ url: siteUrl + '/submit', title: '如意整体验收成功' }));
        await wait(30000);
      }
      if (results.length >= steps.length) return textFrames('已完成本地工具链验收：' + marker);
      const [name, args] = steps[results.length];
      const tool = req.tools.find(x => x.function?.name === 'ai_computer_control__' + name);
      if (!tool) throw new Error('Real ACC schema was not offered: ' + name);
      return toolCallFrames(tool.function.name, args, 'mac_accept_' + results.length);
    } });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 7, version: '3.0.1',
      permissionMode: 'bypass', defaultWorkspace: workspace, stewardThreadBriefV1: false,
      providers: [{ id: 'local-acceptance', type: 'openai-compat', apiStyle: 'chat', label: '本地验收假端点', baseUrl: fake.url, apiKey: 'fixture-only', model: 'fake-model', models: [{ id: 'fake-model', label: 'Local fixture' }] }],
      activeProvider: 'local-acceptance', autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, enableMcpDropIn: false,
      externalMcpServers: [], bridgeExternalToolsToProvider: true, toolLoadingMode: 'full',
      desktopMcp: { enabled: true, autodetect: false, command: python, args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: acc },
      browserAutomation: { mode: 'bundled', headless: !headed } }));
    const port = await getFreePort(); base = 'http://127.0.0.1:' + port;
    server = cp.spawn(process.execPath, ['ruyi-workbench/app/server.js', 'serve', '--port', String(port)], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const serverLog = fs.createWriteStream(path.join(out, 'server.txt'));
    server.stdout.pipe(serverLog, { end: false }); server.stderr.pipe(serverLog, { end: false });
    server.once('close', () => serverLog.end());
    let healthy = false;
    for (let n = 0; n < 200; n++) {
      try { healthy = (await (await request('/health')).json()).ok; } catch { /* wait for owned server */ }
      if (healthy || server.exitCode !== null) break;
      await wait(100);
    }
    t.ok(healthy, 'isolated Workbench starts on localhost');
    token = (await (await request('/api/bootstrap', {})).json()).token;
    const session = (await (await request('/api/sessions', { title: 'Mac 整体验收', cwd: workspace })).json()).session;
    const response = await request('/api/chat/stream', { sessionId: session.id, message: '请生成并读取验收报告，然后在受控本地页面填写表单，最后关闭浏览器。' });
    const events = (await response.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
    fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 2));
    evidence = { ...evidence, sessionId: session.id, forwarded, submissions, ownedProfiles, canonicalProfiles, ownedBrowsers, observedTree, steps: steps.map(([name]) => name) };
    for (const [name] of steps) t.ok(events.some(e => e.type === 'tool_use' && e.name === 'ai_computer_control__' + name), 'Provider turn calls real ACC ' + name);
    const results = events.filter(e => e.type === 'tool_result');
    const uses = events.filter(e => e.type === 'tool_use');
    t.ok(uses.length === steps.length && uses.every((e, index) => e.name === 'ai_computer_control__' + steps[index][0]), 'real ACC calls follow the requested workflow in order');
    t.ok(fake.errors.length === 0, 'local Provider fixture completes without handler errors');
    t.ok(results.length === steps.length && results.every(e => e.isError !== true), 'all real ACC results return without tool errors');
    t.ok(results.length === steps.length && results.every((e, index) => e.id === 'mac_accept_' + index && e.content?.ok === true), 'each ordered tool call has its matching successful real result');
    t.ok(events.some(e => e.type === 'result' && e.ok === true), 'provider turn reaches successful result');
    t.ok(String(forwarded[1]).includes(marker) && String(forwarded[6]).includes(marker), 'document and browser readback reach the provider');
    t.ok(submissions.length === 1 && submissions[0] === marker, 'only controlled local form receives the Chinese submission');
    const active = JSON.parse(forwarded[3]), closed = JSON.parse(forwarded[9]);
    t.ok(active.ready === true && active.headless === !headed && closed.ready === false, 'actual browser reports requested visibility, readiness and subsequent closure');
    const browsers = ownedBrowsers.filter(row => row.command.includes('--user-data-dir=') && !row.command.includes('--type='));
    t.ok(browsers.length > 0 && browsers.every(row => /(?:^|\s)--headless(?:=|\s|$)/.test(row.command) === !headed), 'actual Chromium launch arguments match requested visibility');
    t.ok(ownedBrowsers.some(row => row.command.includes('/playwright/driver/')), 'cleanup observes the actual Playwright driver as well as Chromium');
    t.ok(canonicalProfiles.length > 0 && canonicalProfiles.every(p => p.startsWith(fs.realpathSync(env.TMPDIR) + path.sep)), 'GUI browser uses only owned isolated profiles');
    for (let n = 0; n < 100 && ownedProfiles.some(p => fs.existsSync(p)); n++) await wait(50);
    t.ok(ownedProfiles.every(p => !fs.existsSync(p)) && gone(ownedBrowsers), 'browser close removes the owned GUI profiles and processes');
    const readback = cp.execFileSync(python, ['-c', 'from docx import Document; import sys; print("\\n".join(p.text for p in Document(sys.argv[1]).paragraphs))', document], { env, encoding: 'utf8', timeout: 20000 });
    t.ok(readback.includes(marker), 'independent DOCX reader confirms the real generated artifact');
    fs.copyFileSync(document, path.join(out, '验收报告.docx'));
    const screenshot = results[7]?.content?.imageAttachments?.find(item => item.mime === 'image/png');
    if (!screenshot || !/^toolimg_[a-zA-Z0-9_]+$/.test(screenshot.id) || screenshot.name !== 'browser_screenshot.png')
      throw new Error('Actual browser screenshot attachment missing');
    const image = fs.readFileSync(path.join(data, 'uploads', screenshot.id, screenshot.name));
    t.ok(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      image.readUInt32BE(16) === 1280 && image.readUInt32BE(20) === 720, 'Provider-triggered browser screenshot is stored as an actual 1280x720 PNG attachment');
    fs.writeFileSync(path.join(out, 'browser.png'), image);
    const checkpoints = (await (await request('/api/checkpoints?sessionId=' + session.id)).json()).entries;
    t.ok(checkpoints.some(e => e.path === document && !e.skipped), 'Provider-triggered document write creates a real checkpoint');
    fs.writeFileSync(path.join(out, 'checkpoints.json'), JSON.stringify(checkpoints, null, 2));
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (server) {
      const remaining = tree(server.pid);
      evidence.cleanup = killOwnTree(server);
      for (let n = 0; n < 100 && (server.exitCode === null && server.signalCode === null || !gone(remaining)); n++) await wait(50);
      t.ok(!evidence.cleanup.incomplete && (!evidence.cleanup.skipped || evidence.cleanup.skipped === 'root-exited') &&
        (server.exitCode !== null || server.signalCode !== null) && gone(remaining) && gone(observedTree), 'Workbench teardown confirms the owned process tree exited');
    }
    if (fake) await fake.close();
    if (site) await new Promise(resolve => site.close(resolve));
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ...evidence, failures: t.failures, profile: 'Local deterministic provider; real Workbench, MCP, Office and Chromium; no real-model quality claim' }, null, 2));
    if (!t.failures) fs.rmSync(root, { recursive: true, force: true });
  }
  t.done();
})();
