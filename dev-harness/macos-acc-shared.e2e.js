require('./lib/self-isolate-home.js');
'use strict';
// P3-01 real Python ACC through the production stdio client. Only isolated files;
// no screenshots, user profiles, credentials, or external network operations.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { McpStdioClient, killAllMcpClients, auditBridgedWriteCoverage } = require('../ruyi-workbench/app/server.js');
const t = createRunner('MACOS ACC SHARED');
const { ok } = t;
const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
const python = process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python');

(async () => {
  if (process.platform !== 'darwin') {
    console.log('SKIP macOS shared ACC contract (Windows uses the existing ACC smoke suite)');
    t.done(); return;
  }
  if (!fs.existsSync(python)) {
    if (process.env.RUYI_ACC_REQUIRED === '1') t.fail('P3 acceptance requires an installed Python 3.12 ACC environment');
    else console.log('SKIP install ACC in .venv or set RUYI_ACC_PYTHON; RUYI_ACC_REQUIRED=1 makes this mandatory');
    t.done(); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-acc-shared-'));
  const workspace = path.join(root, '工作区 空格😀');
  const data = path.join(root, 'data');
  const protectedDir = path.join(root, 'protected');
  const caseParent = path.join(root, 'CaseParent');
  fs.mkdirSync(workspace); fs.mkdirSync(data); fs.mkdirSync(protectedDir);
  fs.mkdirSync(caseParent);
  fs.writeFileSync(path.join(data, 'safety.json'), JSON.stringify({
    protected_paths: [protectedDir, path.join(caseParent, 'FutureProtected')],
  }));
  const link = path.join(workspace, 'protected-link');
  fs.symlinkSync(protectedDir, link, 'dir');
  const env = { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'),
    PYTHONUTF8: '1', WCW_DATA_DIR: data, ACC_TOOLSETS: '', ACC_HIDE_TOOLS: '', ACC_HIDE_MEMORY: '' };
  const client = new McpStdioClient({ id: 'ai-computer-control', command: python,
    args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo, env });
  let child;
  try {
    await client.start(); child = client.child;
    const names = client.listTools().map(tool => tool.name);
    ok(['read_file', 'write_file', 'write_document', 'write_pptx', 'chart_image', 'browser_open'].every(n => names.includes(n)),
      'production stdio transport lists shared file, Office and browser tools');
    ok(['screenshot', 'mouse_click', 'ocr_image', 'ui_inspect', 'record_start', 'beep'].every(n => !names.includes(n)),
      'unsupported desktop backends are absent from the model tool registry');
    ok(auditBridgedWriteCoverage(names).uncovered.length === 0,
      'every live shared ACC write tool remains covered by the workbench checkpoint inventory');
    const diag = await client.callTool('diagnostics', {});
    ok(diag.ok && Object.keys(diag.load_errors).length === 0 && !!diag.unsupported_modules.uia,
      'diagnostics distinguishes unsupported modules from failed imports');
    ok(!diag.optional.ocr && !diag.optional.uia && !diag.optional.pynput &&
       diag.optional.playwright === diag.optional_modules.playwright,
      'diagnostics accurately reports absent or unsupported optional backends');
    const note = path.join(workspace, '中文.txt');
    const written = await client.callTool('write_file', { path: note, content: '第一行 中文😀\n第二行' });
    const read = await client.callTool('read_file', { path: note });
    ok(written.ok && read.ok && read.content === '第一行 中文😀\n第二行', 'Unicode and space paths round-trip through real tools');
    const edited = await client.callTool('edit_file', { path: note, old_string: '第二行', new_string: '更新内容' });
    ok(edited.ok && fs.readFileSync(note, 'utf8').includes('更新内容'), 'real edit_file preserves the shared filesystem workflow');
    const overwritten = await client.callTool('write_file', { path: note, content: 'unexpected overwrite' });
    ok(!overwritten.ok && /already exists/.test(overwritten.error) && fs.readFileSync(note, 'utf8').includes('更新内容'),
      'existing-file refusal preserves original content');
    // Validate system protection via safety_info, never issue a write to a system path.
    const safety = await client.callTool('safety_info', {});
    ok(safety.ok && JSON.stringify(safety).includes('/System') && JSON.stringify(safety).includes('/dev'),
      'Mac system protection is present in the live diagnostic contract');
    const refused = await client.callTool('write_file', { path: path.join(link, 'blocked.txt'), content: 'blocked' });
    ok(!refused.ok && /protected/.test(refused.error) && !fs.existsSync(path.join(protectedDir, 'blocked.txt')),
      'real tool refuses a symlink alias of a protected destination before creating anything');
    if (fs.existsSync(path.join(root, 'caseparent'))) {
      for (const target of [path.join(root, 'caseparent/FutureProtected/new.txt'), path.join(caseParent, 'futureprotected/new.txt')]) {
        const future = await client.callTool('write_file', { path: target, content: 'blocked' });
        ok(!future.ok && /protected/.test(future.error) && !fs.existsSync(path.dirname(target)),
          'future protected directory rejects a case alias without creating parents: ' + path.relative(root, target));
      }
    }
    const audit = fs.readdirSync(path.join(data, 'logs')).filter(n => n.endsWith('.ndjson'))
      .flatMap(n => fs.readFileSync(path.join(data, 'logs', n), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    ok(audit.some(row => row.tool === 'write_file' && row.ok === true) &&
       audit.some(row => row.tool === 'write_file' && row.ok === false), 'successful and refused writes both leave audit evidence');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    client.kill();
    if (child) {
      const until = Date.now() + 5000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < until)
        await new Promise(resolve => setTimeout(resolve, 25));
      ok(child.exitCode !== null || child.signalCode !== null, 'owned ACC process exits after client cleanup');
    }
    killAllMcpClients();
    fs.rmSync(root, { recursive: true, force: true });
  }
  t.done();
})();
