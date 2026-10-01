require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(2026-10 工具走查):六组 Sonnet 代理逐个真调了全部 107 个原生工具,本件钉住其中确认过的那批修复。
// 每一条都是【修前真调复现过】的现场,断言写的是修后该有的行为(修前在这里会红):
//
//  (G) git:G1 git_commit 带 paths 只提交这些文件(修前连索引里早已暂存的别的文件一起提交);
//      G2 读类 git 守工作区围栏(修前 git_diff 能读出工作区外仓库的改动内容,file_read 同一文件却被拒);
//      G3 相对 cwd 接在工作目录下(修前落到服务进程目录);G4 分支名带点(release-1.0 修前报成 release-1);
//      G5 改动全在暂存区时 git_diff 给提示(修前 empty:true);G6 有已跟踪改动时照样列出未跟踪文件。
//  (F) 文件:F1 file_search 的 `$` 在 CRLF 文件里配得上(rg 修前一条不中);F2 glob `**/x` 只配完整段
//      (修前 `**/test_two.py` 连 mytest_two.py 也配上);F3 glob 花括号 / 字符类;F4 root 不存在 → not_found
//      (修前 ok:true + 空表);F5 file_read 的缓存不把「自动识别编码」与「强制 utf8」混成一格;
//      F6 dependency_inventory 认 BOM、坏 JSON 如实报。
//  (W) web_fetch 超过 2MB 的页面截断交回(修前报成「对方服务器中断了连接(可能有反爬限制)」);ssrf 认末尾点。
//  (M) todo_write 认 completed / content 同义词;memory_propose 正文带 ``` 代码块;tool_search「读文件」找得到
//      file_read;observation_recall 剥 rawRef= 前缀、抄错的 ref 不扣配额;allowCommandTools:false 在不带
//      config 的调用面(MCP 子进程)同样生效;browser_open 不再把 .exe/.bat 交给系统关联(= 执行)。
//  (S) 管家:S1 steward_file_read 的 `..` 越界与指向区外的符号链接一律拒;S2 steward_thread_workspace 拒不存在的
//      目录与文件;S3 steward_memory_write 在 200 条生效 + 否决过的库里新写的不再「回 ok 却丢掉」;
//      (answer / steer 通道不再给可回退锚点、前端「撤回」不再回落 0+1 —— 由 steward-conversation.static E3/E3b 钉住)
//      S5 steward_config_set 拒类型不对的值与不存在的 stewardProviderId(修前写进去管家自己就醒不过来)。
//
// 判定行:`TOOL AUDIT FIXES E2E: ALL PASS`。
(async () => {
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createRunner } = require('./lib/harness');
const t = createRunner('TOOL AUDIT FIXES');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.RUYI_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-tool-audit-'));
process.env.RUYI_HOME = HOME; process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-tool-audit-ws-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-tool-audit-out-'));
const hasGit = (() => { try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const git = (cwd, ...a) => cp.execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

fs.writeFileSync(path.join(WS, 'a.txt'), 'line1\n');
fs.writeFileSync(path.join(WS, 'data.csv'), 'a,b\n1,2\n');
fs.writeFileSync(path.join(WS, 'crlf.txt'), 'a hello\r\nb\r\n');
fs.mkdirSync(path.join(WS, 'src'));
fs.writeFileSync(path.join(WS, 'src', 'test_two.py'), 'x');
fs.writeFileSync(path.join(WS, 'src', 'mytest_two.py'), 'x');
fs.writeFileSync(path.join(WS, 'src', 'app.js'), 'x');
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'OUTSIDE SECRET');
const config = {
  configSchema: 7, permissionMode: 'default', engineMode: 'interactive', defaultWorkspace: WS, recentWorkspaces: [WS],
  workspaces: [{ path: WS, read: true, write: true, execute: true }],
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killOnDisconnect: false, stewardEnabledV1: true,
  runtimeObservationRecallV1: true, runtimeObservationReducerV1: true,
  // 远端服务商:本机模型才放行工作区外读(那是既有策略),这里要验的是远端模型下的围栏。
  providers: [{ id: 'p1', label: 'P1', type: 'openai-compat', baseUrl: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }],
  activeProvider: 'p1',
};
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2));
const srv = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
const cfg = await srv.readConfig();
const session = await srv.createSession({ title: 'tool audit', cwd: WS });
session.turnSeq = 1;
const call = async (name, args, extra = {}) => {
  const ctx = extra.noCtx ? null : { sessionId: session.id, turnSeq: session.turnSeq, session, config: extra.config || cfg, workingDir: WS, ...(extra.ctx || {}) };
  try { return await srv.toolCall(name, args, ctx); } catch (e) { return { threw: String((e && e.message) || e) }; }
};

try {
  /* ═════════ (G) git ═════════ */
  if (hasGit) {
    git(WS, 'init', '-q', '-b', 'release-1.0'); git(WS, 'config', 'user.email', 'a@b.c'); git(WS, 'config', 'user.name', 'a');
    git(WS, 'add', '-A'); git(WS, 'commit', '-qm', 'init');
    fs.appendFileSync(path.join(WS, 'a.txt'), 'x\n');
    fs.appendFileSync(path.join(WS, 'data.csv'), '3,4\n');
    git(WS, 'add', 'data.csv');
    const c = await call('git_commit', { message: 'only a', paths: ['a.txt'] });
    const files = git(WS, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
    ok(c.ok === true && files.length === 1 && files[0] === 'a.txt', `G1 git_commit paths:['a.txt'] 只提交 a.txt(got ${JSON.stringify(files)})`);
    ok(/^M  data\.csv/m.test(git(WS, 'status', '--porcelain')), 'G1b 早已暂存的 data.csv 仍在暂存区,没被顺带提交');

    git(OUTSIDE, 'init', '-q');
    const out = await call('git_status', { cwd: OUTSIDE });
    ok(out.ok === false && out.code === 'not-allowed', `G2 读类 git 不读工作区外的仓库(got ${JSON.stringify(out).slice(0, 160)})`);

    const st = await call('git_status', {});
    ok(st.branch === 'release-1.0', `G4 分支名带点(got ${st.branch})`);

    const staged = await call('git_diff', {});
    ok(staged.empty === false && /staged:true/.test(String(staged.hint || '')), `G5 改动全在暂存区时给提示(got empty=${staged.empty} hint=${staged.hint})`);
    fs.appendFileSync(path.join(WS, 'a.txt'), 'y\n');
    fs.writeFileSync(path.join(WS, 'new.txt'), 'n');
    const both = await call('git_diff', {});
    ok(/a\.txt/.test(both.diff || '') && Array.isArray(both.untracked) && both.untracked.includes('new.txt'), `G6 有已跟踪改动时照样列出未跟踪文件(got ${JSON.stringify(both.untracked)})`);

    fs.mkdirSync(path.join(WS, 'sub')); git(path.join(WS, 'sub'), 'init', '-q', '-b', 'main');
    const rel = await call('git_status', { cwd: 'sub' });
    ok(rel.ok === true && rel.cwd === path.join(WS, 'sub'), `G3 相对 cwd 接在工作目录下(got ${rel.cwd || rel.error})`);
    ok(rel.unborn === true && rel.branch === 'main', `G3b 还没有提交的仓库:branch=main、unborn:true(got ${rel.branch}/${rel.unborn})`);
  } else {
    console.log('SKIP (G) git not installed');
  }

  /* ═════════ (F) 文件 ═════════ */
  const crlf = await call('file_search', { pattern: 'hello$', glob: 'crlf.txt' });
  ok(Array.isArray(crlf.matches) && crlf.matches.length === 1, `F1 \`hello$\` 在 CRLF 文件里配得上(engine=${crlf.engine},got ${JSON.stringify(crlf.matches)})`);
  const g1 = await call('glob', { pattern: '**/test_two.py' });
  ok(g1.ok && g1.files.map(f => f.relativePath.replace(/\\/g, '/')).join(',') === 'src/test_two.py', `F2 **/test_two.py 只配完整段(got ${JSON.stringify(g1.files)})`);
  const g2 = await call('glob', { pattern: '**/*.{js,csv}' });
  const g2names = (g2.files || []).map(f => f.relativePath.replace(/\\/g, '/')).sort();
  ok(g2names.includes('src/app.js') && g2names.includes('data.csv') && !g2names.some(n => n.endsWith('.py')), `F3 花括号展开(got ${JSON.stringify(g2names)})`);
  const g3 = await call('glob', { pattern: 'src/[a-m]*.js' });
  ok((g3.files || []).length === 1, `F3b 字符类(got ${JSON.stringify(g3.files)})`);
  for (const [tool, args] of [['file_list', { root: 'nope-dir' }], ['glob', { pattern: '*', root: 'nope-dir' }], ['file_search', { pattern: 'x', root: 'nope-dir' }], ['project_snapshot', { root: 'nope-dir' }]]) {
    const r = await call(tool, args);
    ok(r.ok === false && r.code === 'not_found', `F4 ${tool} root 不存在 → not_found(got ${JSON.stringify(r).slice(0, 120)})`);
  }
  const fileRoot = await call('file_list', { root: 'a.txt' });
  ok(fileRoot.ok === false && fileRoot.code === 'not_a_directory', `F4b root 是文件 → not_a_directory(got ${fileRoot.code})`);
  fs.writeFileSync(path.join(WS, 'gbk.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a, 0x61, 0x62, 0x63]));
  const forced = await call('file_read', { path: 'gbk.txt', encoding: 'utf8' });
  const auto = await call('file_read', { path: 'gbk.txt' });
  ok(/你好/.test(String(auto.content || '')) && !/你好/.test(String(forced.content || '')), `F5 强制 utf8 读过之后,自动识别读照样解出 GBK(got auto=${JSON.stringify(String(auto.content || '').slice(0, 10))})`);
  fs.mkdirSync(path.join(WS, 'pkg'));
  fs.writeFileSync(path.join(WS, 'pkg', 'package.json'), '﻿' + JSON.stringify({ dependencies: { lodash: '1' } }));
  const bom = await call('dependency_inventory', { root: 'pkg' });
  ok(bom.ok && bom.npm && bom.npm.dependencies.includes('lodash'), `F6 带 BOM 的 package.json 照样解析(got ${JSON.stringify(bom.npm)})`);
  fs.writeFileSync(path.join(WS, 'pkg', 'package.json'), 'null');
  const nul = await call('dependency_inventory', { root: 'pkg' });
  ok(nul.ok && nul.npm && nul.npm.parseError, `F6b package.json 是 null:如实报 parseError,不抛(got ${JSON.stringify(nul).slice(0, 160)})`);

  /* ═════════ (W) 网络 ═════════ */
  const big = '<html><body><p>' + 'x'.repeat(3 * 1024 * 1024) + '</p></body></html>';
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(big); }).listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
  const prevNoProxy = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1'; process.env.no_proxy = '127.0.0.1';
  const fetched = await call('web_fetch', { url: `http://127.0.0.1:${server.address().port}/` });
  ok(fetched.ok === true && String(fetched.text || '').length > 1000, `W1 超过 2MB 的页面截断交回(got ${fetched.ok} ${fetched.error || ''})`);
  delete process.env.WCW_TEST_ALLOW_LOOPBACK;
  if (prevNoProxy === undefined) { delete process.env.NO_PROXY; delete process.env.no_proxy; } else { process.env.NO_PROXY = prevNoProxy; process.env.no_proxy = prevNoProxy; }
  server.close();
  ok(srv.ssrfCheck('http://localhost./').allowed === false && srv.ssrfCheck('http://x.internal./').allowed === false, 'W2 ssrfCheck 认 FQDN 末尾的点');

  /* ═════════ (M) 元工具 ═════════ */
  const todo = await call('todo_write', { items: [{ content: '写测试', status: 'completed' }, { text: '跑一遍', status: 'in-progress' }, 'third'] });
  ok(todo.ok === true, `M1 todo_write 认 content / completed / in-progress / 纯字符串条目(got ${JSON.stringify(todo).slice(0, 200)})`);
  const bad = await call('todo_write', { items: 'a, b' });
  ok(bad.ok === false && bad.code === 'invalid-arguments', `M1c items 不是数组 → 校验失败,不清空计划(got ${bad.code})`);
  session.messages = [{ role: 'user', content: '记住:跑测试用 npm test' }];
  await srv.saveSession(session).catch(() => {});
  const mem = await call('workbench_memory_propose', { name: '测试命令', description: '跑测试的方式', type: 'reference', scope: 'project', body: 'Run tests with:\n```bash\nnpm test\n```\nthen lint.', reason: '用户让记住' });
  ok(mem.ok === true && /```bash/.test(String(mem.proposal && mem.proposal.body || '')), `M2 正文带 \`\`\` 代码块的记忆候选照常提交(got ${JSON.stringify(mem).slice(0, 160)})`);
  const found = srv.searchToolCatalog(srv.buildToolCatalog(srv.buildOpenAiTools(cfg, null, {}), null, cfg), { query: '读文件', limit: 8 }, cfg, { legacyNameBoost: 3 });
  ok((found.matches || []).some(m => m.name === 'file_read'), `M3 tool_search「读文件」找得到 file_read(got ${JSON.stringify((found.matches || []).map(m => m.name))})`);
  for (let i = 0; i < 9; i += 1) await call('observation_recall', { rawRef: 'not-a-ref-' + i });
  const pref = await call('observation_recall', { rawRef: 'rawRef=history:1:0123456789abcdef:0:0123456789abcdef' });
  ok(pref.error !== 'quota_exceeded' && pref.error !== 'invalid_ref', `M4 抄错的 ref 不扣配额;带 rawRef= 前缀的照常解析(got ${pref.error})`);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ ...config, allowCommandTools: false }, null, 2));
  const noCtx = await call('script_run', { language: 'node', code: 'console.log(1)' }, { noCtx: true });
  ok(noCtx.ok === false && noCtx.code === 'tool-disabled', `M5 allowCommandTools:false 在不带 config 的调用面同样生效(got ${JSON.stringify(noCtx).slice(0, 120)})`);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2));
  const exe = await call('browser_open', { url: path.join(WS, 'evil.bat') });
  ok(exe.ok === false && /只打开网址/.test(String(exe.error || '')), `M6 browser_open 不把 .bat 交给系统关联(got ${JSON.stringify(exe).slice(0, 120)})`);
  const dash = await call('browser_open', { url: '--renderer-cmd-prefix=cmd.exe x.html' });
  ok(dash.ok === false, 'M6b 以 - 开头的值不当网址');

  /* ═════════ (S) 管家 ═════════ */
  const steward = { id: 'steward', kind: 'steward', turnSeq: 7, providerHistory: [] };
  let stewardTurn = 7;
  const S = (name, args, extra) => call(name, args, { ctx: { session: { ...steward, turnSeq: ++stewardTurn }, sessionId: 'steward', trigger: 'user', ...(extra || {}) } });
  const trav = await S('steward_file_read', { path: WS + '/../' + path.basename(OUTSIDE) + '/secret.txt' });
  ok(trav.ok === false && trav.error === 'outside_workspace', `S1 \`..\` 越界拒(got ${trav.error})`);
  let linked = false;
  try { fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(WS, 'link.txt')); linked = true; } catch { /* Windows 无权限建链接时跳过 */ }
  if (linked) {
    const viaLink = await S('steward_file_read', { path: path.join(WS, 'link.txt') });
    ok(viaLink.ok === false && viaLink.error === 'outside_workspace', `S1b 指向区外的符号链接拒(got ${viaLink.error})`);
    const searched = await call('docs_search', { query: 'OUTSIDE', root: '.' });
    ok(!JSON.stringify(searched).includes('OUTSIDE SECRET'), 'S1c 遍历类工具不跟着链接读区外文件');
  }
  const okRead = await S('steward_file_read', { path: path.join(WS, 'a.txt') });
  ok(okRead.ok === true, `S1d 区内文件照常读(got ${okRead.error || ''})`);

  const target = await srv.createSession({ title: '目标线程', cwd: WS });
  target.permissionMode = 'auto'; await srv.saveSession(target);
  const noDir = await S('steward_thread_workspace', { sessionId: target.id, cwd: path.join(WS, 'no-such-dir') });
  ok(noDir.ok === false && noDir.error === 'invalid_request', `S2 不存在的目录不能设成工作目录(got ${noDir.error})`);
  const isFile = await S('steward_thread_workspace', { sessionId: target.id, cwd: path.join(WS, 'a.txt') });
  ok(isFile.ok === false && isFile.error === 'invalid_request', `S2b 文件不能设成工作目录(got ${isFile.error})`);

  const memFile = path.join(HOME, 'steward', 'memory-v1.json');
  const now = new Date().toISOString();
  const entries = [];
  for (let i = 0; i < 200; i += 1) entries.push({ id: `smem_${String(i).padStart(16, '0')}`, kind: 'preference', text: `第 ${i} 条偏好 alpha${i} beta${i}`, state: i === 0 ? 'vetoed' : 'active', createdAt: now, updatedAt: now, source: { sessionId: target.id, turnSeq: 1 } });
  entries.push({ id: 'smem_9999999999999999', kind: 'preference', text: '第 200 条偏好 gamma delta', state: 'active', createdAt: now, updatedAt: now, source: { sessionId: target.id, turnSeq: 1 } });
  fs.mkdirSync(path.dirname(memFile), { recursive: true });
  fs.writeFileSync(memFile, JSON.stringify({ schema: 1, updatedAt: now, entries }));
  const hit = await S('steward_memory_search', { q: 'gamma delta' });
  ok(hit.ok !== false && JSON.stringify(hit).includes('smem_9999999999999999'),
    `S3 200 条生效 + 1 条否决的库里,第 201 条(生效)读得回来(修前读库把总数截在 200,它被挤掉;got ${JSON.stringify(hit).slice(0, 160)})`);


  const typo = await S('steward_config_set', { patch: { killOnDisconnect: 'maybe' } });
  ok(typo.ok === false && typo.error === 'invalid_request', `S5 开关键收到字符串 → 拒(got ${typo.error})`);
  const ghost = await S('steward_config_set', { patch: { stewardProviderId: 'no-such-provider' } });
  ok(ghost.ok === false && /stewardProviderId/.test(String(ghost.message || '')), `S5b 不存在的 stewardProviderId → 拒(got ${ghost.error})`);
} catch (e) {
  t.fail('fatal: ' + ((e && e.stack) || e));
}
t.done({ exit: true });
})();
