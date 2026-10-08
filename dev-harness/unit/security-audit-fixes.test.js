'use strict';
// 安全审计修复(2026-09-30,A/B/D 三项)的回归锁。真源码、临时 HOME、真子进程(假 MCP、真 git)。
//
//   [A1] 桥接 MCP 服务器不得继承工作台回环凭据:每会话 MCP 子进程的环境里有 WCW_TOKEN/WCW_PORT/WCW_SESSION_ID,
//        修前 McpStdioClient.start 用 {...process.env} 原样传给 ACC,get_environment_variable 一问就把令牌交给模型。
//   [A2] 档位:get_environment_variable 不再被 get_ 前缀收进 read 档;get_clipboard_image / window_screenshot
//        带了落盘参数的那一次调用至少 edit(allow_protected:true → exec);不带参数仍 read。
//   [A3] 桥接读文件族(read_file/list_directory/file_info/ocr_image)过与 file_read 同一道读边界:
//        应用内部数据(config.json 等)拒、相对路径拒、远端模型越界拒、工作区内照常放行;经 tool_invoke_read 真路径同样生效。
//   [B]  read 档 git_status/git_diff 不再执行仓库自带的 clean 过滤器(.gitattributes filter= + .git/config clean=<命令>),
//        子模块里的过滤器也不执行;输出照常。
//   [D]  定时任务权限档天花板 = 全局档、永不含 bypass(schedulerPermissionModeFor 整张真值表)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-security-audit-'));
const DATA = path.join(root, 'data');
const WORK = path.join(root, 'work');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const FAKE_MCP = path.resolve(__dirname, '..', 'fake-mcp.js');
const ENV_CAPTURE = path.join(root, 'env-capture.ndjson');
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  configSchema: 7, permissionMode: 'default', defaultWorkspace: WORK, recentWorkspaces: [],
  toolLoadingMode: 'auto', bridgeExternalToolsToProvider: true, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  // 远端 provider(非本机地址)→ 越工作区读应被拒(与 file_read 同口径)。
  providers: [{ id: 'remote', label: 'Remote', type: 'openai-compat', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }],
  activeProvider: 'remote',
  externalMcpServers: [{ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_MCP], enabled: true }],
}, null, 2));
process.env.WIN_CLAUDE_WORKBENCH_HOME = DATA;
process.env.RUYI_HOME = DATA;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

after(() => {
  try { srv.killAllMcpClients(); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('[A1] 桥接 MCP 子进程拿不到 WCW_* 回环凭据与注入的模型密钥;条目自己声明的 env 与 WCW_DATA_DIR 照常', async () => {
  const saved = {};
  const planted = { WCW_TOKEN: 'SECRET-TOKEN-A1', WCW_PORT: '8765', WCW_SESSION_ID: 'sess-a1', WCW_HOST: '127.0.0.1',
    ANTHROPIC_AUTH_TOKEN: 'sk-injected', WCW_DATA_DIR: path.join(root, 'acc-data') };
  for (const [k, v] of Object.entries(planted)) { saved[k] = process.env[k]; process.env[k] = v; }
  const keys = [...Object.keys(planted), 'OWN_KEY', 'PATH'].join(',');
  const client = new srv.McpStdioClient({
    id: 'envcap', command: process.execPath, args: [FAKE_MCP],
    env: { FAKE_MCP_ENV_CAPTURE: ENV_CAPTURE, FAKE_MCP_ENV_CAPTURE_KEYS: keys, OWN_KEY: 'own-value' },
  });
  try {
    await client.start();
    let row = null;
    for (let i = 0; i < 50 && !row; i++) {
      try { row = JSON.parse(fs.readFileSync(ENV_CAPTURE, 'utf8').trim().split('\n').pop()); } catch { await new Promise(r => setTimeout(r, 40)); }
    }
    assert.ok(row && row.env, 'env capture written');
    assert.equal(row.env.WCW_TOKEN, null, 'WCW_TOKEN must not reach a bridged MCP server');
    assert.equal(row.env.WCW_PORT, null);
    assert.equal(row.env.WCW_SESSION_ID, null);
    assert.equal(row.env.WCW_HOST, null);
    assert.equal(row.env.ANTHROPIC_AUTH_TOKEN, null, 'workbench-injected model credential stripped');
    assert.equal(row.env.WCW_DATA_DIR, planted.WCW_DATA_DIR, 'ACC data-dir override still inherited');
    assert.equal(row.env.OWN_KEY, 'own-value', 'entry-declared env still applied');
    assert.ok(row.env.PATH, 'ordinary environment still inherited');
  } finally {
    try { client.kill ? client.kill() : srv.killAllMcpClients(); } catch { /* ignore */ }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('[A2] 桥接档位:get_environment_variable → exec;落盘参数按次抬档;无参仍 read', () => {
  const tier = srv.bridgedToolTier;
  assert.equal(tier('get_environment_variable', {}), 'exec');
  assert.equal(tier('get_clipboard_image', {}), 'read', 'catalog tier (no args) unchanged');
  assert.equal(tier('get_clipboard_image', {}, {}), 'read', 'no save_path → still read');
  assert.equal(tier('get_clipboard_image', {}, { save_path: 'C:\\x\\clip.png' }), 'edit');
  assert.equal(tier('get_clipboard_image', {}, JSON.stringify({ save_path: 'C:\\x\\clip.png' })), 'edit', 'raw JSON args accepted');
  assert.equal(tier('get_clipboard_image', {}, { save_path: 'C:\\Windows\\x.png', allow_protected: true }), 'exec');
  assert.equal(tier('window_screenshot', {}, { title_substring: 'x' }), 'read');
  assert.equal(tier('window_screenshot', {}, { title_substring: 'x', output_path: 'C:\\x\\w.png' }), 'edit');
  // 用户覆盖表压不下按次地板;其余口径不变。
  assert.equal(tier('get_clipboard_image', { bridgedToolTiers: { get_clipboard_image: 'read' } }, { save_path: 'C:\\x\\c.png' }), 'edit');
  assert.equal(tier('read_file', {}), 'read');
  assert.equal(tier('get_windows', {}), 'read');
  assert.equal(tier('write_file', {}, { path: 'C:\\x' }), 'exec', 'floor never lowers');
});

test('[A3] 桥接读文件过读边界:内部数据/相对路径/远端越界拒,工作区内放行', async () => {
  const gate = srv.bridgedReadPathGate;
  const config = await srv.readConfig();
  const session = { id: 'a3', cwd: WORK };
  const ctx = { session, config };
  const inside = path.join(WORK, 'note.txt');
  fs.writeFileSync(inside, 'HELLO-A3');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-a3-outside-'));
  const outside = path.join(outsideDir, 'id_rsa');
  fs.writeFileSync(outside, 'PRIVATE');
  try {
    const cfgRefusal = await gate('fake__read_file', { path: path.join(DATA, 'config.json') }, ctx);
    assert.ok(cfgRefusal && cfgRefusal.ok === false, 'config.json in the data root is refused');
    const rtRefusal = await gate('acc__file_info', { path: path.join(DATA, 'runtime.json') }, ctx);
    assert.ok(rtRefusal && rtRefusal.ok === false, 'runtime.json (loopback token) is refused');
    const outRefusal = await gate('acc__read_file', { path: outside }, ctx);
    assert.ok(outRefusal && outRefusal.ok === false, 'outside the workspace with a remote provider is refused');
    const lsRefusal = await gate('acc__list_directory', { path: outsideDir }, ctx);
    assert.ok(lsRefusal && lsRefusal.ok === false, 'list_directory outside the workspace refused');
    const relRefusal = await gate('acc__read_file', { path: 'note.txt' }, ctx);
    assert.ok(relRefusal && relRefusal.code === 'path-not-absolute', 'relative path refused');
    const missing = await gate('acc__list_directory', {}, ctx);
    assert.ok(missing && missing.code === 'path-not-absolute', 'missing path (ACC default ".") refused');
    assert.equal(await gate('acc__read_file', { path: inside }, ctx), null, 'inside the workspace passes');
    assert.equal(await gate('acc__screenshot', { region: '0,0,1,1' }, ctx), null, 'non file tools untouched');

    // 真路径:tool_invoke_read → 12 invokeAdaptiveMcpTool → 假 MCP 的 read_file。
    const denied = await srv.toolCall('tool_invoke_read', { name: 'fake__read_file', arguments: { path: path.join(DATA, 'config.json') } }, ctx);
    assert.equal(denied.ok, false, 'tool_invoke_read of config.json refused: ' + JSON.stringify(denied).slice(0, 200));
    assert.ok(!JSON.stringify(denied).includes('api.example.com'), 'no config content leaked');
    const allowed = await srv.toolCall('tool_invoke_read', { name: 'fake__read_file', arguments: { path: inside } }, ctx);
    assert.ok(JSON.stringify(allowed).includes('HELLO-A3'), 'in-workspace read still works: ' + JSON.stringify(allowed).slice(0, 200));
  } finally {
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function gitAvailable() {
  try { return cp.spawnSync('git', ['--version'], { windowsHide: true }).status === 0; } catch { return false; }
}

test('[B] git_status / git_diff 不执行仓库自带的 clean 过滤器(含子模块)', { skip: !gitAvailable() && 'git not installed' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-git-filter-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'no-global') };
  const git = (cwd, args) => {
    const r = cp.spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
    return r.stdout;
  };
  const marker = path.join(base, 'PWNED');
  const markJs = path.join(base, 'mark.js');
  fs.writeFileSync(markJs, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdin.pipe(process.stdout);\n`);
  const fwd = p => p.replace(/\\/g, '/');
  const filterCmd = `"${fwd(process.execPath)}" "${fwd(markJs)}"`;
  const touch = (file, text, bumpMs) => { fs.writeFileSync(file, text); const t = new Date(Date.now() + bumpMs); fs.utimesSync(file, t, t); };
  try {
    // ── 主仓库:`* filter=evil` + [filter "evil"] clean=<写标记>
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q']);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'x']);
    // Let Git escape embedded quotes so executable paths containing spaces stay quoted for the shell.
    git(repo, ['config', 'filter.evil.clean', filterCmd]);
    git(repo, ['config', 'filter.evil.smudge', filterCmd]);
    // 对照:同一个仓库里裸 git status 确实会执行过滤器(证明夹具是真的)。
    touch(path.join(repo, 'a.txt'), 'jello\n', 5000);
    cp.spawnSync('git', ['status', '--porcelain'], { cwd: repo, env, windowsHide: true });
    assert.ok(fs.existsSync(marker), 'fixture sanity: plain git status runs the clean filter');
    fs.rmSync(marker, { force: true });

    touch(path.join(repo, 'a.txt'), 'kello\n', 10000);
    // 读类 git 守工作区围栏(2026-10 工具走查,与 file_read 同一道):把这个临时仓库作为线程的工作目录传进去。
    const inRepo = { config: { permissionMode: 'default', workspaces: [{ path: base, read: true, write: true, execute: true }] }, session: { id: 's-audit-b', cwd: base } };
    const st = await srv.toolCall('git_status', { cwd: repo }, inRepo);
    assert.equal(st.ok, true, JSON.stringify(st));
    assert.ok(/a\.txt/.test(st.status), 'status still reports the change');
    // toolCall 用的是本进程的真环境(不是上面 env 里隔离掉的全局配置):CI 机器全局配着 git-lfs,
    // filter.lfs.* 也会被一并中和 —— 那是对的。这里只钉「仓库自带的 evil 在里面」,不钉清单全等。
    assert.ok(Array.isArray(st.filtersNeutralized) && st.filtersNeutralized.includes('evil'), JSON.stringify(st.filtersNeutralized));
    assert.equal(fs.existsSync(marker), false, 'git_status must not execute the repo clean filter');

    touch(path.join(repo, 'a.txt'), 'lello\n', 15000);
    const df = await srv.toolCall('git_diff', { cwd: repo }, inRepo);
    assert.equal(df.ok, true, JSON.stringify(df));
    assert.ok(/\+lello/.test(df.diff), 'diff still produced');
    assert.equal(fs.existsSync(marker), false, 'git_diff must not execute the repo clean filter');

    // ── 子模块:过滤器写在子模块自己的 config 里(主仓库的 git config 读不到它)
    const sub = path.join(base, 'sub');
    fs.mkdirSync(sub);
    git(sub, ['init', '-q']);
    fs.writeFileSync(path.join(sub, '.gitattributes'), '* filter=Evil2\n');
    fs.writeFileSync(path.join(sub, 's.txt'), 's\n');
    git(sub, ['add', '-A']);
    git(sub, ['commit', '-q', '-m', 's']);
    const sup = path.join(base, 'sup');
    fs.mkdirSync(sup);
    git(sup, ['init', '-q']);
    git(sup, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm']);
    git(sup, ['commit', '-q', '-m', 'sup']);
    git(path.join(sup, 'sm'), ['config', 'filter.Evil2.clean', filterCmd]);
    touch(path.join(sup, 'sm', 's.txt'), 't\n', 20000);
    const st2 = await srv.toolCall('git_status', { cwd: sup }, inRepo);
    assert.equal(st2.ok, true, JSON.stringify(st2));
    assert.equal(fs.existsSync(marker), false, 'git_status must not recurse into a submodule and run its filter');
    touch(path.join(sup, 'sm', 's.txt'), 'u\n', 25000);
    const df2 = await srv.toolCall('git_diff', { cwd: sup }, inRepo);
    assert.equal(df2.ok, true, JSON.stringify(df2));
    assert.equal(fs.existsSync(marker), false, 'git_diff must not recurse into a submodule and run its filter');
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('[D] 定时任务权限档:天花板 = 全局档,永不含 bypass', () => {
  const f = srv.schedulerPermissionModeFor;
  const run = (globalMode, taskMode) => f({ autonomy: { permissionMode: taskMode } }, { permissionMode: globalMode });
  // 任务档比全局宽 → 按全局(修前任务档照样生效)。
  assert.equal(run('default', 'auto'), 'default');
  assert.equal(run('plan', 'auto'), 'plan');
  assert.equal(run('plan', 'acceptEdits'), 'plan');
  assert.equal(run('acceptEdits', 'auto'), 'acceptEdits');
  // 任务档比全局紧 → 按任务。
  assert.equal(run('auto', 'default'), 'default');
  assert.equal(run('auto', 'plan'), 'plan');
  assert.equal(run('bypass', 'auto'), 'auto');
  assert.equal(run('default', 'default'), 'default');
  // 没给档 → 全局;全局 bypass 也不能漏成 bypass(修前原样 bypass)。
  assert.equal(run('auto', ''), 'auto');
  assert.equal(run('default', ''), 'default');
  assert.equal(run('bypass', ''), 'default');
  // 任务显式 bypass / 非法档 → 当没给。
  assert.equal(run('default', 'bypass'), 'default');
  assert.equal(run('bypass', 'bypassPermissions'), 'default');
  assert.equal(run('auto', 'dontAsk'), 'auto');
  assert.equal(f({}, { permissionMode: 'weird' }), 'default');
});
