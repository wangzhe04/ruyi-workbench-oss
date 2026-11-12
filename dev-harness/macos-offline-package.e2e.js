'use strict';
// Opt-in P6-01 acceptance of an actual frozen candidate, copied to a new Unicode/space path.
// Sandbox restrictions apply only to owned fixture children; no system network/settings changes.
require('./lib/self-isolate-home');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { verifyPackage, inventory, run } = require('../ruyi-workbench/tools/macos-offline-lib');
const t = createRunner('MACOS OFFLINE PACKAGE');
const { ok } = t;
const candidate = process.env.RUYI_OFFLINE_CANDIDATE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(100); }
  throw new Error('Timed out waiting for offline candidate');
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

(async () => {
  if (process.platform !== 'darwin' || !candidate) {
    if (process.env.RUYI_OFFLINE_REQUIRED === '1') t.fail('An actual arm64 candidate is required');
    else console.log('SKIP live offline-package acceptance requires macOS and RUYI_OFFLINE_CANDIDATE');
    t.done(); return;
  }
  const fixture = fixtureChildEnv({ perTest: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-offline-acceptance-'));
  const moved = path.join(scratch, '搬移 如意 离线😀');
  const children = [];
  let client, api, web, cleanupMcp;
  const modes = [];
  try {
    const manifest = verifyPackage(candidate);
    const expectedSigning = process.env.RUYI_OFFLINE_EXPECT_SIGNING || 'ad-hoc-development';
    if (!['ad-hoc-development', 'ad-hoc-internal-trial'].includes(expectedSigning)) throw new Error('Invalid expected signing policy');
    ok(manifest.signing === expectedSigning && manifest.notarized === false && !manifest.minimumSystemRuntimeVerified,
      'candidate declares its development identity and unverified minimum-system boundary');
    // APFS clone copies keep this 1GB-scale acceptance independent without duplicating disk blocks.
    run('/bin/cp', ['-cR', path.resolve(candidate), moved]);
    verifyPackage(moved);
    const app = path.join(moved, 'Ruyi.app');
    const workbench = path.join(app, 'Contents/Resources/workbench');
    const node = path.join(workbench, 'runtime/node/bin/node');
    const serverJs = path.join(workbench, 'app/server.js');
    const acc = path.join(workbench, 'mcp/ai-computer-control');
    const workspace = path.join(fixture.home, '中文 工作区');
    const data = path.join(fixture.home, 'data');
    const temp = path.join(fixture.home, 'tmp');
    for (const directory of [workspace, data, temp]) fs.mkdirSync(directory);
    const environment = { ...fixture.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', RUYI_HOME: data,
      WIN_CLAUDE_WORKBENCH_HOME: '', PYTHONHOME: '', PYTHONPATH: '', PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
      RUYI_NODE_PATH: '', RUYI_RG_PATH: '', RUYI_MACOS_AUTOMATION_HELPER: '', RUYI_MACOS_PROCESS_HELPER: '', RUYI_MACOS_KEYCHAIN_HELPER: '',
      AI_COMPUTER_CONTROL_HOME: '', PLAYWRIGHT_NODEJS_PATH: '', PLAYWRIGHT_BROWSERS_PATH: '',
      ACC_BROWSER_HEADLESS: '1', ACC_BROWSER_MODE: 'bundled', TMPDIR: temp, WCW_DATA_DIR: path.join(fixture.home, 'acc-data'),
      MPLCONFIGDIR: path.join(fixture.home, 'matplotlib'), NODE_OPTIONS: '', NODE_PATH: '', PIP_NO_INDEX: '1' };
    delete environment.PLAYWRIGHT_NODEJS_PATH;
    const denied = [path.resolve(__dirname, '..'), '/opt/homebrew', '/usr/local', process.env.RUYI_REAL_HOME + '/.local',
      process.env.RUYI_REAL_HOME + '/.cache', '/tmp/ruyi-p6-assets', '/private/tmp/ruyi-p6-assets',
      '/tmp/ruyi-p6-assets-replayed', '/private/tmp/ruyi-p6-assets-replayed'];
    const profile = '(version 1)(allow default)(deny network-outbound)'
      + '(allow network-outbound (remote ip "localhost:*"))'
      + denied.filter(value => value && !value.startsWith('undefined')).map(value => '(deny file-read-data (subpath ' + JSON.stringify(value) + '))').join('');
    const sandbox = (command, args) => ['/usr/bin/sandbox-exec', ['-p', profile, command, ...args]];
    // Prove the fixture restrictions themselves: both a source file and public-network connection fail.
    const probe = path.join(scratch, 'restrictions.js');
    fs.writeFileSync(probe, `const fs=require('fs'),net=require('net');
let denied=false;try{fs.readFileSync(${JSON.stringify(path.resolve(__dirname, '../ruyi-workbench/app/server.js'))})}catch(e){denied=e.code==='EPERM'||e.code==='EACCES'}
if(!denied)process.exit(2);const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1000);s.on('connect',()=>process.exit(3));s.on('error',e=>process.exit(e.code==='EPERM'||e.code==='EACCES'?0:4));s.on('timeout',()=>process.exit(5));`);
    const [restrictionCommand, restrictionArgs] = sandbox(node, [probe]);
    run(restrictionCommand, restrictionArgs, { env: environment, cwd: scratch });
    ok(true, 'child sandbox actually refuses source reads and outbound public-network connections');
    for (const entry of inventory(app).filter(entry => entry.type !== 'symlink')) {
      const file = path.join(app, entry.path); modes.push([file, entry.mode]); fs.chmodSync(file, entry.mode & ~0o222);
    }
    modes.push([app, fs.statSync(app).mode & 0o777]); fs.chmodSync(app, 0o555);
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass',
      defaultWorkspace: workspace, workspaces: [{ path: workspace }], stewardEnabledV1: false, schedulerEnabledV1: false,
      autoImportClaudeCodeMcp: false, enableMcpDropIn: false, includeWorkbenchMcp: false,
      bridgeExternalToolsToProvider: true, toolLoadingMode: 'full', desktopMcp: { enabled: manifest.variant === 'full', autodetect: true },
      browserAutomation: { mode: 'bundled' },
      externalMcpServers: [], providers: [] }));
    const port = await getFreePort();
    const [command, args] = sandbox(node, [serverJs, 'serve', '--port', String(port)]);
    api = cp.spawn(command, args, { cwd: scratch, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(api);
    let diagnostic = '';
    api.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); }); api.stdout.on('data', () => {});
    const base = 'http://127.0.0.1:' + port;
    const request = async (route, body, token = '') => {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-wcw-token': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(route + ' HTTP ' + response.status);
      return result;
    };
    await until(async () => { if (api.exitCode !== null) throw new Error(diagnostic); try { return (await request('/health')).ok; } catch { return false; } });
    const token = (await request('/api/bootstrap', {})).token;
    ok(readJson(path.join(data, 'runtime.json'))?.pid === api.pid, 'relocated bundled Node starts the actual workbench in a separate writable data root');
    const inspection = path.join(scratch, 'inspect.cjs');
    fs.writeFileSync(inspection, `const S=require(${JSON.stringify(serverJs)}); (async()=>{
const cp=require('child_process');const result={node:process.execPath,python:process.env.RUYI_BUNDLED_PYTHON,
rg:cp.execFileSync('rg',['--version'],{encoding:'utf8'}).split('\\n')[0],detected:await S.detectDesktopMcpAsync()};
console.log(JSON.stringify(result));})().catch(e=>{console.error(e);process.exitCode=1});`);
    const [inspectCommand, inspectArgs] = sandbox(node, [inspection]);
    const inspected = JSON.parse(run(inspectCommand, inspectArgs, { env: environment, cwd: scratch }).split('\n').at(-1));
    fs.writeFileSync(path.join(scratch, 'runtime-sources.json'), JSON.stringify(inspected, null, 2));
    const sameFile = (first, second) => first && second && fs.realpathSync(first) === fs.realpathSync(second);
    ok(sameFile(inspected.node, node) && inspected.rg.includes('15.1.0'), 'Node and ripgrep come from the moved package under denied developer directories');
    if (manifest.variant === 'full') {
      const python = path.join(acc, 'runtime/python/bin/python3');
      ok(sameFile(inspected.python, python) && sameFile(inspected.detected.command, python) && inspected.detected.pythonSource === 'installed-runtime'
        && inspected.detected.env.PYTHONPATH === '', 'autodetection selects the bundled non-editable Python/ACC without a source override');
      for (const [entry, version] of [['pip', '26.2.1'], ['playwright', '1.64.1']]) {
        const [entryCommand, entryArgs] = sandbox(path.join(acc, 'runtime/python/bin', entry), ['--version']);
        ok(run(entryCommand, entryArgs, { env: environment, cwd: scratch }).includes(version),
          'relative ' + entry + ' console entrypoint runs after relocation without a staging shebang');
      }
      const [pythonCommand, pythonArgs] = sandbox(path.join(acc, 'runtime/python/bin/python'), ['-c', 'import sys;print(sys.version_info[:2])']);
      ok(run(pythonCommand, pythonArgs, { env: environment, cwd: scratch }).includes('(3, 12)'), 'portable python alias selects the bundled CPython3.12');
      const S = require(serverJs); cleanupMcp = S.killAllMcpClients;
      const session = (await request('/api/sessions', { title: 'P6 offline package', cwd: workspace }, token)).session;
      const [mcpCommand, mcpArgs] = sandbox(node, [serverJs, 'mcp']);
      client = new S.McpStdioClient({ id: 'p6-offline', command: mcpCommand, args: mcpArgs, cwd: workbench,
        env: { ...environment, WCW_SESSION_ID: session.id } });
      await client.start();
      const call = async (name, parameters, read = false) => {
        const result = await client.callTool(read ? 'tool_invoke_read' : 'tool_invoke_exec',
          { name: 'ai_computer_control__' + name, arguments: parameters }, 90000);
        if (!result.ok) throw new Error(name + ': ' + JSON.stringify(result));
        return result;
      };
      const title = '如意 离线中文验证';
      const files = Object.fromEntries(['报告.docx', '数据.xlsx', '演示.pptx', '文档.pdf', '图表.png'].map(name => [name, path.join(workspace, name)]));
      await call('write_document', { path: files['报告.docx'], title, content: '上海 123\n离线 English 数据' });
      await call('write_excel', { path: files['数据.xlsx'], headers: ['城市', '数值'], data: [['上海', 123]] });
      await call('write_pptx', { path: files['演示.pptx'], slides: [{ type: 'title', title, subtitle: '上海 123' }] });
      await call('write_pdf', { path: files['文档.pdf'], title, content: '上海 123\n离线 English 数据' });
      await call('chart_image', { path: files['图表.png'], chart_type: 'bar', title, data: { labels: ['上海'], series: [{ name: '数值', values: [123] }] } });
      for (const name of ['报告.docx', '演示.pptx']) ok(JSON.stringify(await call('read_document', { path: files[name] }, true)).includes('上海'), name + ' round-trips Chinese through the actual packaged workbench MCP');
      ok(JSON.stringify(await call('excel_read', { path: files['数据.xlsx'] }, true)).includes('123'), 'XLSX retains numeric sample data');
      ok(JSON.stringify(await call('pdf_read_pages', { path: files['文档.pdf'] }, true)).includes('上海'), 'PDF retains readable Chinese text');
      ok(fs.readFileSync(files['图表.png']).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'chart tool produces an actual PNG offline');
      const checkpoints = (await request('/api/checkpoints?sessionId=' + session.id, undefined, token)).entries;
      ok(Object.values(files).every(file => checkpoints.some(entry => entry.path === file && !entry.skipped)), 'all five packaged writers retain real session checkpoints');
      web = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>P6 Local</title><p>如意 离线浏览器</p><input id="name">'); });
      await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
      await call('browser_open', { url: 'http://127.0.0.1:' + web.address().port, mode: 'bundled' });
      await call('browser_type', { selector: '#name', text: '上海😀', clear: true });
      ok(JSON.stringify(await call('browser_get_text', {}, true)).includes('离线浏览器'), 'bundled Chromium navigates and reads the local Chinese page with public network denied');
      ok(JSON.stringify(await call('browser_backend_status', {}, true)).includes('156.0.8078.4'), 'actual running browser version matches the locked payload');
      await call('browser_close', {});
      client.child.stdin.end(); await until(() => client.child.exitCode !== null, 15000);
      ok(client.child.exitCode === 0, 'packaged MCP exits normally after browser cleanup and stdio EOF');
    } else {
      ok(!fs.existsSync(acc) && !inspected.python && !manifest.capabilities.officeFiles && !manifest.capabilities.browserAutomation,
        'Slim accurately omits Python/ACC/Office/browser dependencies');
    }
    await killOwnTree(api); await until(() => api.exitCode !== null || api.signalCode !== null, 15000);
    const report = path.join(scratch, 'host.json');
    const host = cp.spawn(path.join(app, 'Contents/MacOS/RuyiDesktop'), ['--acceptance-report', report, '--acceptance-auto-quit', '--workbench-root', '/missing/source'],
      { cwd: scratch, env: { ...environment, RUYI_NODE_PATH: '/missing/node' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(host); host.stdout.on('data', () => {}); host.stderr.on('data', () => {});
    await until(() => host.exitCode !== null);
    const hostReport = readJson(report);
    ok(host.exitCode === 0 && hostReport?.state === 'ready' && hostReport.page?.configLoaded,
      'moved read-only App initializes real WKWebView using its internal root and Node despite hostile development overrides');
    for (const [file, mode] of modes.reverse()) fs.chmodSync(file, mode);
    modes.length = 0;
    verifyPackage(moved); verifyPackage(candidate);
    ok(true, 'App payload remains byte-for-byte unchanged after service, MCP, browser and native-host execution');
    fs.writeFileSync(path.join(scratch, 'acceptance.json'), JSON.stringify({ candidate: path.resolve(candidate), treeSha256: manifest.treeSha256,
      variant: manifest.variant, failures: t.failures, sandboxDenied: denied, nativeHost: hostReport?.state }, null, 2));
    console.log('P6 acceptance evidence: ' + scratch);
  } catch (error) { t.fail(error.stack || String(error)); console.log('Failed fixture preserved: ' + scratch); }
  finally {
    if (client) client.kill(); if (cleanupMcp) cleanupMcp();
    for (const child of children.reverse()) await killOwnTree(child);
    if (web) await new Promise(resolve => web.close(resolve));
    for (const [file, mode] of modes.reverse()) { try { fs.chmodSync(file, mode); } catch {} }
    if (!t.failures) fs.rmSync(fixture.home, { recursive: true, force: true });
  }
  t.done();
})();
