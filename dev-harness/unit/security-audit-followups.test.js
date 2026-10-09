'use strict';
// 安全审计修复的后续补漏(承 unit/security-audit-fixes.test.js 的 A①/A②)。真源码、临时 HOME、真子进程。
//
//   [R1] 桥接读路径闸覆盖到【全部】只读的读文件族:模板匹配(find_template / find_all_templates / wait_for_image 的
//        可选 template_path、find_on_screen 的必填 template_path)与文档/图片读取(read_document / excel_read /
//        pdf_read_pages / image_info)。修前只登记了 read_file / list_directory / file_info / ocr_image,
//        read 档的模板匹配零弹窗就能拿 config.json 当模板路径喂给 ACC。工作区内绝对路径照常放行;只给 template_b64 不查。
//   [E1] 直挂给 Claude CLI 的桥接服务器(toolLoadingMode:'full' 与 exec 档 DAG 节点的 --mcp-config)不再从 CLI 的环境
//        继承工作台凭据:生成的条目 env 块把 WCW_*(WCW_DATA_DIR 除外)与 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 置空,
//        条目自己声明的 env 照常叠在最后。按 CLI 的合并口径({...父环境, ...条目 env})真起一个假 MCP 验收。
//   [F1] file_list 的 pattern(按相对路径过正则)不再能冻住事件循环:`(a+)+$` 对一个 60 个 a 加 b 的文件名,
//        修前同步回溯 2^60 步(子进程卡死被杀),修后约 2 s 内返回、如实标 truncated/patternNote;常用模式结果不变。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { killOwnTree } = require('../lib/kill-own-tree');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-security-followup-'));
const DATA = path.join(root, 'data');
const WORK = path.join(root, 'work');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const FAKE_MCP = path.resolve(__dirname, '..', 'fake-mcp.js');
const SERVER_JS = path.resolve(__dirname, '../../ruyi-workbench/app/server.js');
const ENV_CAPTURE = path.join(root, 'env-capture.ndjson');
const CONFIG = {
  configSchema: 7, permissionMode: 'default', defaultWorkspace: WORK, recentWorkspaces: [],
  toolLoadingMode: 'full', bridgeExternalToolsToProvider: true, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  providers: [{ id: 'remote', label: 'Remote', type: 'openai-compat', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }],
  activeProvider: 'remote',
  externalMcpServers: [{ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_MCP], enabled: true, env: { OWN_KEY: 'own-value' } }],
};
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(CONFIG, null, 2));
process.env.WIN_CLAUDE_WORKBENCH_HOME = DATA;
process.env.RUYI_HOME = DATA;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(SERVER_JS);

after(() => {
  try { srv.killAllMcpClients(); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('[R1] 模板匹配 / 文档读取族过读边界:内部数据、相对路径、远端越界拒;工作区内与只给 b64 放行', async () => {
  const gate = srv.bridgedReadPathGate;
  const config = await srv.readConfig();
  const ctx = { session: { id: 'r1', cwd: WORK }, config };
  const cfgPath = path.join(DATA, 'config.json');
  const inside = path.join(WORK, 'button.png');
  fs.writeFileSync(inside, 'PNG');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r1-outside-'));
  const outside = path.join(outsideDir, 'secret.png');
  fs.writeFileSync(outside, 'PNG');
  try {
    const templateTools = ['find_template', 'find_all_templates', 'wait_for_image', 'find_on_screen'];
    for (const name of templateTools) {
      const cfg = await gate(`ai-computer-control__${name}`, { template_path: cfgPath }, ctx);
      assert.ok(cfg && cfg.ok === false, `${name}: config.json as template_path must be refused, got ${JSON.stringify(cfg)}`);
      const out = await gate(`ai-computer-control__${name}`, { template_path: outside }, ctx);
      assert.ok(out && out.ok === false, `${name}: outside the workspace with a remote provider must be refused`);
      const rel = await gate(`ai-computer-control__${name}`, { template_path: 'button.png' }, ctx);
      assert.ok(rel && rel.code === 'path-not-absolute', `${name}: relative template_path must be refused`);
      assert.equal(await gate(`ai-computer-control__${name}`, { template_path: inside }, ctx), null, `${name}: in-workspace absolute template passes`);
    }
    // template_path 与 template_b64 二选一:只给 b64 时没有路径可查,照常放行;find_on_screen 只收 template_path(必填)。
    for (const name of ['find_template', 'find_all_templates', 'wait_for_image']) {
      assert.equal(await gate(`acc__${name}`, { template_b64: 'iVBORw0KGgo=' }, ctx), null, `${name}: b64-only call untouched`);
    }
    const missing = await gate('acc__find_on_screen', {}, ctx);
    assert.ok(missing && missing.code === 'path-not-absolute', 'find_on_screen without template_path refused (ACC would resolve against its own cwd)');

    for (const name of ['read_document', 'excel_read', 'pdf_read_pages', 'image_info']) {
      const cfg = await gate(`ai-computer-control__${name}`, { path: cfgPath }, ctx);
      assert.ok(cfg && cfg.ok === false, `${name}: config.json refused, got ${JSON.stringify(cfg)}`);
      const rel = await gate(`ai-computer-control__${name}`, { path: 'report.pdf' }, ctx);
      assert.ok(rel && rel.code === 'path-not-absolute', `${name}: relative path refused`);
      assert.equal(await gate(`ai-computer-control__${name}`, { path: inside }, ctx), null, `${name}: in-workspace passes`);
    }
    // 不读文件的工具不受影响。
    assert.equal(await gate('ai-computer-control__screenshot', {}, ctx), null);
    assert.equal(await gate('ai-computer-control__vision_click', { template_b64: 'x' }, ctx), null);
  } finally {
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('[E1] --mcp-config 里直挂的桥接服务器:env 块置空工作台凭据,条目自己的 env 照常;按 CLI 合并口径真起进程验收', async () => {
  const planted = { WCW_TOKEN: 'SECRET-TOKEN-E1', WCW_PORT: '8765', WCW_SESSION_ID: 'sess-e1', WCW_HOST: '127.0.0.1', WCW_EXTRA_INHERITED: 'x',
    ANTHROPIC_AUTH_TOKEN: 'sk-injected-e1', ANTHROPIC_API_KEY: 'sk-injected-e1b', WCW_DATA_DIR: path.join(root, 'acc-data') };
  const saved = {};
  for (const [k, v] of Object.entries(planted)) { saved[k] = process.env[k]; process.env[k] = v; }
  let child = null;
  try {
    const configPath = await srv.generateSessionMcpConfig('e1sess', 'auto', []);
    const mcp = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const fake = mcp.mcpServers && mcp.mcpServers.fake;
    assert.ok(fake && fake.type === 'stdio', 'full mode attaches the bridged server directly: ' + JSON.stringify(Object.keys(mcp.mcpServers || {})));
    const env = fake.env || {};
    for (const k of ['WCW_TOKEN', 'WCW_PORT', 'WCW_SESSION_ID', 'WCW_HOST', 'WCW_EXTRA_INHERITED', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      assert.equal(env[k], '', `bridged server env block must blank ${k}, got ${JSON.stringify(env[k])}`);
    }
    assert.equal(env.OWN_KEY, 'own-value', 'entry-declared env kept');
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'WCW_DATA_DIR'), 'WCW_DATA_DIR (ACC data-dir override) is not blanked');
    // 如意自己的 MCP 条目仍拿到回环字段(权限桥靠它)。
    const own = Object.values(mcp.mcpServers).find(s => s && s.env && Object.prototype.hasOwnProperty.call(s.env, 'WCW_SESSION_ID') && s.env.WCW_SESSION_ID === 'e1sess');
    assert.ok(own, 'the workbench own MCP entry still carries its loopback session id');

    // CLI 起 stdio MCP 的环境 = 它自己的环境叠条目 env。用同一口径起假 MCP,看它真拿到什么。
    const keys = [...Object.keys(planted), 'OWN_KEY', 'PATH'].join(',');
    child = cp.spawn(fake.command, fake.args, {
      env: { ...process.env, ...env, FAKE_MCP_ENV_CAPTURE: ENV_CAPTURE, FAKE_MCP_ENV_CAPTURE_KEYS: keys },
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    let row = null;
    for (let i = 0; i < 100 && !row; i++) {
      try { row = JSON.parse(fs.readFileSync(ENV_CAPTURE, 'utf8').trim().split('\n').pop()); } catch { await new Promise(r => setTimeout(r, 40)); }
    }
    assert.ok(row && row.env, 'env capture written');
    for (const k of ['WCW_TOKEN', 'WCW_PORT', 'WCW_SESSION_ID', 'WCW_HOST', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      assert.ok(!row.env[k], `${k} must not reach a CLI-launched bridged server (got ${JSON.stringify(row.env[k])})`);
    }
    assert.equal(row.env.WCW_DATA_DIR, planted.WCW_DATA_DIR, 'WCW_DATA_DIR still inherited');
    assert.equal(row.env.OWN_KEY, 'own-value');
    assert.ok(row.env.PATH, 'ordinary environment still inherited');
  } finally {
    if (child) { try { killOwnTree(child); } catch { /* gone */ } }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('[F1] file_list pattern:灾难性回溯的模式约 2 s 内返回(不冻事件循环);常用模式结果不变', () => {
  const dir = path.join(WORK, 'redos');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a'.repeat(60) + 'b'), 'x');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'note.md'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'other.js'), 'x');
  // 子进程里跑:修前主线程同步回溯,node:test 自己的超时计时器也跑不动,只能靠外面的 spawnSync 超时杀掉。
  const script = `
    const srv = require(${JSON.stringify(SERVER_JS)});
    (async () => {
      // Supply the request's config as the agent loop does: CLI discovery and
      // config migration are independent of the regex budget being tested.
      const list = args => srv.toolCall('file_list', args, { config: ${JSON.stringify(CONFIG)}, workingDir: ${JSON.stringify(WORK)} });
      const t0 = Date.now();
      const bad = await list({ root: ${JSON.stringify(dir)}, pattern: '(a+)+$' });
      const badMs = Date.now() - t0;
      const txt = await list({ root: ${JSON.stringify(dir)}, pattern: '\\\\.txt$' });
      const grp = await list({ root: ${JSON.stringify(dir)}, pattern: '(sub|nope)[\\\\\\\\/].*\\\\.md$' });
      const long = await list({ root: ${JSON.stringify(dir)}, pattern: 'x'.repeat(5000) }).catch(e => ({ ok: false, error: String(e && e.message || e) }));
      process.stdout.write(JSON.stringify({ badMs, bad, txt, grp, long }));
      process.exit(0);
    })().catch(e => { process.stdout.write(JSON.stringify({ fatal: String(e && e.stack || e) })); process.exit(1); });
  `;
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: DATA, RUYI_HOME: DATA, HOME: root, USERPROFILE: root },
    encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', windowsHide: true,
  });
  const wall = Date.now() - t0;
  assert.ok(!r.error && r.status === 0, `file_list child must finish (status ${r.status}, signal ${r.signal}, ${wall} ms): ${String(r.stderr || '').slice(0, 400)}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out.badMs < 2500, `catastrophic pattern returns within ~2 s (took ${out.badMs} ms)`);
  assert.equal(out.bad.ok, true, JSON.stringify(out.bad).slice(0, 300));
  assert.ok(!out.bad.files.some(f => /a{60}b$/.test(f.relativePath)), 'the pathological name did not match');
  assert.equal(out.bad.truncated, true, 'a timed-out pattern marks the listing truncated');
  assert.ok(/time budget/.test(String(out.bad.patternNote || '')), 'and says why: ' + out.bad.patternNote);
  assert.deepEqual(out.txt.files.map(f => f.relativePath), ['keep.txt'], 'simple pattern unchanged');
  assert.ok(!out.txt.truncated && !out.txt.patternNote);
  assert.deepEqual(out.grp.files.map(f => f.relativePath.replace(/\\/g, '/')), ['sub/note.md'], 'grouped/alternation pattern still matches correctly');
  assert.equal(out.long.ok, false, 'an over-long pattern is refused: ' + JSON.stringify(out.long).slice(0, 200));
});
