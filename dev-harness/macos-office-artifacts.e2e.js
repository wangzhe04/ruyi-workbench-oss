require('./lib/self-isolate-home.js');
'use strict';
// P3-02: real CLI MCP proxy -> real ACC writers -> journal -> HTTP rollback.
// No provider/account/desktop interaction. All files and profiles belong to this fixture.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { McpStdioClient, killAllMcpClients } = require('../ruyi-workbench/app/server.js');
const t = createRunner('MACOS OFFICE ARTIFACTS');
const { ok } = t;
const repo = path.resolve(__dirname, '..');
const acc = path.join(repo, 'mcp/ai-computer-control');
const python = process.env.RUYI_ACC_PYTHON || path.join(acc, '.venv/bin/python');
const sample = JSON.parse(fs.readFileSync(path.join(acc, 'tests/fixtures/macos-office-sample.json'), 'utf8'));

(async () => {
  if (process.platform !== 'darwin') { console.log('SKIP macOS Office contract'); t.done(); return; }
  if (!fs.existsSync(python)) {
    if (process.env.RUYI_OFFICE_REQUIRED === '1') t.fail('Install ACC and the pptx/charts/pdf-export extras before acceptance');
    else console.log('SKIP install the Office test environment; RUYI_OFFICE_REQUIRED=1 makes it mandatory');
    t.done(); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-office-mcp-'));
  const workspace = path.join(root, '中文 工作区');
  const data = path.join(root, 'data');
  const auditDir = path.join(root, 'acc-data');
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const files = Object.fromEntries(['report.docx', 'data.xlsx', 'slides.pptx', 'summary.pdf', 'chart.png'].map(n => [n, path.join(workspace, n)]));
  const before = Buffer.from('P3 existing file: restore these exact bytes after overwrite.\n');
  fs.writeFileSync(files['report.docx'], before);
  const env = { ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data,
    WCW_DATA_DIR: auditDir, MPLCONFIGDIR: path.join(root, 'mpl-cache'), PYTHONUTF8: '1' };
  const config = {
    configSchema: 7, version: '3.0.1', permissionMode: 'bypass', defaultWorkspace: workspace,
    autoImportClaudeCodeMcp: false, enableMcpDropIn: false, includeWorkbenchMcp: false,
    bridgeExternalToolsToProvider: true, toolLoadingMode: 'full',
    desktopMcp: { enabled: true, autodetect: false, command: python,
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: acc },
    externalMcpServers: [], providers: [],
  };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  // Explicit Python needs the source environment, never a user's browser or CLI profile.
  if (process.env.RUYI_ACC_INSTALLED_ONLY === '1') delete env.PYTHONPATH;
  else env.PYTHONPATH = path.join(acc, 'src');
  env.ACC_TOOLSETS = 'office,filesystem';
  const port = await getFreePort();
  const base = 'http://127.0.0.1:' + port;
  const server = cp.spawn(process.execPath, [path.join(repo, 'ruyi-workbench/app/server.js'), 'serve', '--port', String(port)],
    { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', client;
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  server.stdout.on('data', () => {});
  const request = async (route, body, token = '') => {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-wcw-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const value = await res.json();
    if (!res.ok) throw new Error(route + ': HTTP ' + res.status + ' ' + JSON.stringify(value));
    return value;
  };
  try {
    const until = Date.now() + 20000;
    let healthy = false;
    while (Date.now() < until) {
      try { healthy = (await request('/health')).ok === true; } catch { /* startup pending */ }
      if (healthy) break;
      if (server.exitCode !== null) throw new Error('workbench exited: ' + stderr);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!healthy) throw new Error('workbench startup timed out: ' + stderr);
    const token = (await request('/api/bootstrap', {})).token;
    const session = (await request('/api/sessions', { title: 'P3 Office artifacts', cwd: workspace }, token)).session;
    ok(!!session?.id, 'isolated workbench creates a real session for checkpoint ownership');
    client = new McpStdioClient({ id: 'p3-office-workbench', command: process.execPath,
      args: [path.join(repo, 'ruyi-workbench/app/server.js'), 'mcp'], cwd: repo,
      env: { ...env, WCW_SESSION_ID: session.id } });
    await client.start();
    const call = async (name, args, read = false) => {
      const result = await client.callTool(read ? 'tool_invoke_read' : 'tool_invoke_exec',
        { name: 'ai_computer_control__' + name, arguments: args }, 60000);
      if (!result.ok) throw new Error(name + ': ' + JSON.stringify(result));
      ok(true, 'real workbench MCP proxy completes ' + name);
      return result;
    };
    const chart = await call('chart_image', { path: files['chart.png'], chart_type: 'bar',
      title: '季度数据对比', data: sample.chart, x_title: '城市', y_title: '数量' });
    ok(!chart.warning && !!chart.font, 'Mac chart resolves a real CJK font without a fallback warning');
    await call('write_document', { path: files['report.docx'], content: sample.content, title: sample.title, page_numbers: true });
    await call('write_excel', { path: files['data.xlsx'], headers: sample.headers, data: sample.rows });
    await call('excel_chart', { path: files['data.xlsx'], sheet: 'Sheet1', chart_type: 'bar', data_range: 'A1:C4', title: '季度数据对比', target_cell: 'A8' });
    await call('write_pptx', { path: files['slides.pptx'], slides: [
      { type: 'title', title: sample.title, subtitle: '文档、表格与图表', date: '2026-11-07' },
      { type: 'table', title: '验收数据', headers: sample.headers, rows: sample.rows },
      { type: 'image', title: '季度数据对比', image_path: files['chart.png'], caption: '固定样例数据 / Sample data' },
    ] });
    const pdf = await call('write_pdf', { path: files['summary.pdf'], content: sample.content, title: sample.title });
    ok(/^MacCJK/.test(pdf.font) && !pdf.warning, 'PDF selects a readable Mac TrueType font without a reader-font fallback');
    const word = await call('read_document', { path: files['report.docx'] }, true);
    const slides = await call('read_document', { path: files['slides.pptx'] }, true);
    const book = await call('excel_read', { path: files['data.xlsx'] }, true);
    const pdfRead = await call('pdf_read_pages', { path: files['summary.pdf'] }, true);
    for (const [name, result] of [['DOCX', word], ['PPTX', slides], ['XLSX', book], ['PDF', pdfRead]])
      ok(JSON.stringify(result).includes('上海'), name + ' real read tool retains Chinese table content');
    const entries = (await request('/api/checkpoints?sessionId=' + session.id, undefined, token)).entries;
    const paths = new Set(entries.filter(e => !e.skipped).map(e => e.path));
    ok(Object.values(files).every(p => paths.has(p)), 'all five real artifact destinations have checkpoints');
    const original = entries.find(e => e.path === files['report.docx'] && e.op === 'modify');
    ok(original && Number(original.bytes) === before.length, 'overwriting an existing Word file records its exact original bytes');
    const audit = fs.readdirSync(path.join(auditDir, 'logs')).filter(n => n.endsWith('.ndjson'))
      .flatMap(n => fs.readFileSync(path.join(auditDir, 'logs', n), 'utf8').trim().split('\n').map(JSON.parse));
    ok(['chart_image', 'write_document', 'write_excel', 'excel_chart', 'write_pptx', 'write_pdf']
      .every(tool => audit.some(row => row.tool === tool && row.ok)), 'every Office/image write tool leaves successful audit evidence');
    if (process.env.RUYI_OFFICE_ARTIFACT_DIR) {
      const parent = path.resolve(process.env.RUYI_OFFICE_ARTIFACT_DIR); fs.mkdirSync(parent, { recursive: true });
      const retained = fs.mkdtempSync(path.join(parent, 'sample-'));
      for (const [name, file] of Object.entries(files)) fs.copyFileSync(file, path.join(retained, name), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(retained, 'tool-results.json'), JSON.stringify({ chart, pdf, word, slides, book, pdfRead }, null, 2));
      console.log('ARTIFACT_DIR=' + retained);
    }
    client.kill(); client = null;
    const reverted = await request('/api/checkpoints/rollback', { sessionId: session.id, turnSeq: original.turnSeq }, token);
    ok(reverted.ok, 'production HTTP rollback reverses the real Office tool sequence');
    ok(fs.readFileSync(files['report.docx']).equals(before), 'rollback restores the existing Word file byte for byte');
    ok(Object.entries(files).filter(([name]) => name !== 'report.docx').every(([,file]) => !fs.existsSync(file)),
      'rollback removes the four newly created artifacts, including the edited chart workbook');
  } catch (error) { t.fail((error.stack || String(error)) + '\n' + stderr); }
  finally {
    if (client) client.kill();
    killAllMcpClients();
    await killOwnTree(server);
    const until = Date.now() + 5000;
    while (server.exitCode === null && server.signalCode === null && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 25));
    ok(server.exitCode !== null || server.signalCode !== null, 'owned workbench process exits during fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
  t.done();
})();
