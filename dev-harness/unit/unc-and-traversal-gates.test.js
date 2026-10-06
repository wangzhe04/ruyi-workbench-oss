// Unit(第二波安全走查 W1 + S7):文件工具读写闸的两处洞。
//
// W1 · 非本机 UNC 外联:`\\攻击者\share\x`(含 `//攻击者/share/x`、`\\?\UNC\…`)在 Windows 上被 realpath / readFile / writeFile 一碰就去连对方的
//   SMB —— 无提示外传通道(绕过 web_fetch 的 SSRF 闸)+ 泄露 NTLM。读写闸在任何 I/O 之前一律拒,宽写档 / allowOutsideWorkspace / 本地模型读都不例外;
//   唯一例外是路径落在用户配置的某个 UNC 工作区里(纯词法判)。本机主机名(localhost / 127.0.0.1 / ::1 / 本机名)不算外联。
//
// S7 · 遍历类工具经指向数据根的符号链接 / 硬链接当 root,把 config.json 的 apiKey、runtime.json 的 token 搜出来:
//   · 工作区里 linkdir -> <数据根>:守门的 realpath 恰好等于允许根 dataRoot(放行),遍历与过滤却按词法路径比,认不出 linkdir\config.json。
//     修法:遍历前把 root 换成 guardFileToolPath 返回的 realpath(file_list / file_search / glob / project_snapshot / code_review_scan / …);
//   · 硬链接 `ln config.json hard.json`:同 inode 不同名,路径判据看不出 → 对 config.json / runtime.json 做 dev+ino 比对(nlink>1 才比,拿不到 ino 不挡);
//   · 敏感名单补 steward/ missions/ scheduler/ migrations/ engine-transcripts.json(检查点内容有意保留可读,见 03 注释)。
//
// 反向验证:RUYI_TEST_SERVER_JS=<修前 server.js> node --test 本文件 → 对应断言红。
// JS 引擎覆盖:本文件会再起一个自己(PATH 里去掉 rg,W2_NO_RG=1)跑同一批断言,file_search 走 JS 扫描路径。
'use strict';
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, after } = require('node:test');

const NO_RG = process.env.W2_NO_RG === '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trav-gates-'));
const home = path.join(root, 'home');
const dataRootDir = path.join(home, '.ruyi-workbench');
const ws = path.join(home, 'ws');
fs.mkdirSync(dataRootDir, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
if (NO_RG) {   // 只留 node 自己的目录:系统 PATH 里的 rg 看不到,file_search 退到 JS 扫描
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, path.basename(process.execPath)));
  process.env.PATH = bin;
  delete process.env.Path;
  delete process.env.RUYI_RG_PATH;
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.RUYI_HOME = dataRootDir;
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataRootDir;
delete process.env.WCW_SESSION_ID;
const { loadServerInternals } = require('../lib/server-internals');
let I;
try { I = loadServerInternals(['guardFileToolPath', 'toolCall', 'remoteUncDenial', 'uncHostAndPath', 'UNC_DENIED_ERROR']); }
catch (e) {
  if (!(e instanceof ReferenceError)) throw e;   // 反向验证:修前没有 UNC 闸符号 → 退回基础名单、UNC 单元断言自然红
  I = loadServerInternals(['guardFileToolPath', 'toolCall']);
  I.remoteUncDenial = () => ''; I.uncHostAndPath = () => null; I.UNC_DENIED_ERROR = '<none>';
}

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const ctxFor = (cwd, mode, extra) => ({ session: { cwd }, config: { permissionMode: mode || 'default', defaultWorkspace: home, recentWorkspaces: [], workspaces: [], ...(extra || {}) } });
const dump = r => JSON.stringify(r);

// ───────────────────────────── W1 ─────────────────────────────
describe('W1 · remoteUncDenial / uncHostAndPath 纯判据', () => {
  it('远端 UNC 各种写法都认出主机;本地盘 / 设备命名空间 / 三斜杠不是 UNC', () => {
    assert.equal(I.uncHostAndPath('\\\\evil.example\\share\\x.txt').host, 'evil.example');
    assert.equal(I.uncHostAndPath('\\\\?\\UNC\\evil.example\\share\\x').host, 'evil.example');
    assert.equal(I.uncHostAndPath('//evil.example/share/x', true).host, 'evil.example');
    assert.equal(I.uncHostAndPath('//evil.example/share/x', false), null, 'POSIX 上 //a/b 就是 /a/b,不是 UNC');
    assert.equal(I.uncHostAndPath('\\\\EVIL\\SHARE\\a').norm, '\\\\evil\\share\\a');
    assert.equal(I.uncHostAndPath('\\\\?\\C:\\Windows\\x'), null);
    assert.equal(I.uncHostAndPath('\\\\.\\C:\\x'), null);
    assert.equal(I.uncHostAndPath('\\\\.\\pipe\\x'), null);
    assert.equal(I.uncHostAndPath('\\\\\\x'), null);
    assert.equal(I.uncHostAndPath('C:\\x\\y'), null);
    assert.equal(I.uncHostAndPath('/home/me/x'), null);
  });
  it('非本机 UNC → 拒;本机名 / localhost / 127.0.0.1 / ::1 不算外联', () => {
    const me = os.hostname();
    for (const p of ['\\\\evil.example\\share\\x', '\\\\10.1.2.3\\c$\\Windows\\x', '\\\\?\\UNC\\evil\\s\\x', '\\\\evil.example@SSL\\DavWWWRoot\\x', '\\\\127.0.0.2\\share\\x']) {
      assert.ok(I.remoteUncDenial([p], null, {}), p);
    }
    for (const p of ['\\\\localhost\\C$\\x', '\\\\127.0.0.1\\C$\\x', '\\\\' + me + '\\share\\x', 'C:\\x', '/tmp/x', 'rel\\path']) {
      assert.equal(I.remoteUncDenial([p], null, {}), '', p);
    }
    assert.ok(I.remoteUncDenial(['//evil.example/share/x'], null, {}, true));
  });
  it('例外:落在用户配置的 UNC 工作区根之内(workspaces / defaultWorkspace / recent / 会话 cwd),大小写不敏感,`..` 爬不出共享根', () => {
    const cfg = { workspaces: [{ path: '\\\\FileServer\\Proj', read: true, write: true }], recentWorkspaces: ['\\\\other\\recent'], defaultWorkspace: '\\\\dflt\\ws' };
    assert.equal(I.remoteUncDenial(['\\\\fileserver\\proj\\src\\a.txt'], null, cfg), '');
    assert.equal(I.remoteUncDenial(['\\\\fileserver\\proj'], null, cfg), '');
    assert.equal(I.remoteUncDenial(['\\\\other\\recent\\a'], null, cfg), '');
    assert.equal(I.remoteUncDenial(['\\\\dflt\\ws\\a'], null, cfg), '');
    assert.equal(I.remoteUncDenial(['\\\\sess\\dir\\a'], { cwd: '\\\\sess\\dir' }, {}), '');
    assert.ok(I.remoteUncDenial(['\\\\fileserver\\proj2\\a.txt'], null, cfg), '前缀相同但不是同一个共享');
    assert.ok(I.remoteUncDenial(['\\\\fileserver\\other\\a.txt'], null, cfg));
    assert.ok(I.remoteUncDenial(['\\\\evil\\proj\\a.txt'], null, cfg), '同共享名、别的主机');
    assert.equal(I.uncHostAndPath('\\\\fileserver\\proj\\..\\..\\evil\\x').norm, '\\\\fileserver\\proj\\evil\\x');
    // 任一拼法越界即拒(候选里混了一个越界的)
    assert.ok(I.remoteUncDenial(['\\\\fileserver\\proj\\a', '\\\\evil\\s\\a'], null, cfg));
  });
});

describe('W1 · guardFileToolPath:读 / 写 / 任何档位 / 逃生舱都拒非本机 UNC(在任何 I/O 之前)', () => {
  const TARGETS = ['\\\\evil.example\\share\\x.txt', '\\\\?\\UNC\\evil.example\\share\\x.txt', '\\\\10.9.8.7\\C$\\Users\\x.txt'];
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypass']) {
    it(`${mode} 档:读与写都拒,报错说人话、指向工作区设置`, async () => {
      for (const p of TARGETS) {
        for (const write of [false, true]) {
          const g = await I.guardFileToolPath(p, ctxFor(ws, mode), { tool: write ? 'file_write' : 'file_read', write });
          assert.equal(g.ok, false, `${mode} write=${write} ${p} → ${dump(g)}`);
          assert.equal(g.error, I.UNC_DENIED_ERROR, `${mode} ${p}: must be the UNC denial, got ${dump(g)}`);
          assert.match(g.error, /工作区/);
        }
      }
    });
  }
  it('allowOutsideWorkspace=true / 本地模型读(providerIsLocal)也拒', async () => {
    const hatch = await I.guardFileToolPath(TARGETS[0], ctxFor(ws, 'default', { allowOutsideWorkspace: true }), { tool: 'file_read', write: false });
    assert.equal(hatch.error, I.UNC_DENIED_ERROR, dump(hatch));
    const local = await I.guardFileToolPath(TARGETS[0], ctxFor(ws, 'default', { providers: [{ id: 'p', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'x', model: 'm' }], activeProviderId: 'p' }), { tool: 'file_read', write: false });
    assert.equal(local.error, I.UNC_DENIED_ERROR, dump(local));
    const wide = await I.guardFileToolPath(TARGETS[0], ctxFor(ws, 'bypass', { allowOutsideWorkspace: true }), { tool: 'file_write', write: true });
    assert.equal(wide.error, I.UNC_DENIED_ERROR, dump(wide));
  });
  it('端到端:file_read / file_write 对 UNC 路径返回 not-allowed,不抛、不落盘', async (t) => {
    // 工具层的路径解析按宿主 path.isAbsolute 判:`\\\\主机\\共享` 只有 Windows 认作绝对路径,POSIX 上会被接到工作区下当成一个怪文件名 ——
    // 所以端到端只在 Windows 上有意义(Linux 上闸本身已由上面的直测覆盖)。
    if (process.platform !== 'win32') return t.skip('UNC absolute paths exist only on Windows hosts');
    for (const [tool, args] of [['file_read', { path: TARGETS[0] }], ['file_write', { path: TARGETS[0], content: 'x' }], ['file_list', { root: TARGETS[0] }], ['file_copy', { from: path.join(ws, 'nope.txt'), to: TARGETS[0] }]]) {
      const r = await I.toolCall(tool, args, ctxFor(ws, 'bypass'));
      assert.equal(r.ok, false, tool + ' ' + dump(r));
    }
  });
  it('本机 UNC 与普通本地路径不受 UNC 闸影响(报错不是 UNC 拒绝)', async () => {
    const g = await I.guardFileToolPath('\\\\localhost\\C$\\Windows\\Temp\\x.txt', ctxFor(ws, 'default'), { tool: 'file_read', write: false });
    assert.notEqual(g.error, I.UNC_DENIED_ERROR, dump(g));
    fs.writeFileSync(path.join(ws, 'ok.txt'), 'hi');
    const g2 = await I.guardFileToolPath(path.join(ws, 'ok.txt'), ctxFor(ws, 'default'), { tool: 'file_read', write: false });
    assert.equal(g2.ok, true, dump(g2));
  });
  it('用户把网络共享配成工作区:UNC 闸放行(后续闸门照旧判,Linux 上词法拼法对不上只会换一句报错)', async () => {
    const cfg = { workspaces: [{ path: '\\\\fileserver\\proj', read: true, write: true }] };
    const g = await I.guardFileToolPath('\\\\fileserver\\proj\\src\\a.txt', ctxFor(ws, 'default', cfg), { tool: 'file_read', write: false });
    assert.notEqual(g.error, I.UNC_DENIED_ERROR, dump(g));
    const g2 = await I.guardFileToolPath('\\\\fileserver\\proj2\\a.txt', ctxFor(ws, 'default', cfg), { tool: 'file_read', write: false });
    assert.equal(g2.error, I.UNC_DENIED_ERROR, dump(g2));
  });
});

// ───────────────────────────── S7 ─────────────────────────────
const API_KEY = 'sk-SECRETKEY-w2s7-0123456789';
const TOKEN = 'WCWTOKEN-w2s7-abcdef0123456789';
const STEWARD = 'STEWARDMEMORY-w2s7-private';
fs.writeFileSync(path.join(dataRootDir, 'config.json'), JSON.stringify({ providers: [{ id: 'p', apiKey: API_KEY }] }));
fs.writeFileSync(path.join(dataRootDir, 'runtime.json'), JSON.stringify({ token: TOKEN }));
for (const [rel, body] of [
  ['steward/cursor-v1.json', { note: STEWARD }], ['missions/m1.json', { note: STEWARD }], ['scheduler/tasks-v1.json', { note: STEWARD }],
  ['migrations/1.json', { note: STEWARD }], ['engine-transcripts.json', { note: STEWARD }], ['sessions/s1.json', { note: STEWARD }],
  ['checkpoints/s1/1-1.txt', { before: 'checkpoint content stays readable' }], ['uploads/a.txt', { note: 'upload' }],
]) {
  fs.mkdirSync(path.dirname(path.join(dataRootDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dataRootDir, rel), JSON.stringify(body));
}
function tryLink(target, linkPath, kind) {
  try { fs.symlinkSync(target, linkPath, process.platform === 'win32' ? (kind === 'dir' ? 'junction' : 'file') : undefined); return true; }
  catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return false; throw e; }
}
const SECRETS = [API_KEY, TOKEN, STEWARD, 'SECRETKEY', 'WCWTOKEN', 'STEWARDMEMORY'];
const leaks = r => SECRETS.filter(s => dump(r).includes(s));
const namesIn = r => dump(r);

describe('S7 · 指向数据根的符号链接当遍历 root:内容与名字都不外泄', () => {
  const link = path.join(ws, 'linkdir');
  let linked = false;
  it('准备:linkdir -> <数据根>', (t) => { linked = tryLink(dataRootDir, link, 'dir'); if (!linked) t.skip('cannot create directory links here'); });

  it('file_search(rg 或 JS 引擎)按 apiKey / token / 管家记忆搜都搜不出内容', async (t) => {
    if (!linked) return t.skip('no link');
    const seen = new Set();
    for (const pattern of ['apiKey', 'token', 'SECRETKEY', 'STEWARDMEMORY', 'sk-', '.']) {
      const r = await I.toolCall('file_search', { root: link, pattern, includeHidden: true, maxResults: 500 }, ctxFor(ws, 'default'));
      assert.deepEqual(leaks(r), [], `file_search ${pattern} leaked: ${dump(r).slice(0, 400)}`);
      if (r && r.engine) seen.add(r.engine);
    }
    if (NO_RG) assert.ok(!seen.has('rg'), 'child run must exercise the JS engine, saw ' + [...seen].join(','));
  });
  it('code_review_scan / docs_search / codebase_symbol_search / claude_md_audit / dependency_inventory / frontend_audit 不读出内容', async (t) => {
    if (!linked) return t.skip('no link');
    for (const [tool, args] of [['code_review_scan', { root: link }], ['docs_search', { root: link, query: 'apiKey token' }],
      ['codebase_symbol_search', { root: link, query: 'apiKey' }], ['claude_md_audit', { root: link }], ['dependency_inventory', { root: link }], ['frontend_audit', { root: link }]]) {
      const r = await I.toolCall(tool, args, ctxFor(ws, 'default'));
      assert.deepEqual(leaks(r), [], `${tool} leaked: ${dump(r).slice(0, 400)}`);
    }
  });
  it('glob / file_list / project_snapshot 不列出 config.json、runtime.json 与新增敏感目录里的名字', async (t) => {
    if (!linked) return t.skip('no link');
    const sensitiveNames = ['config.json', 'runtime.json', 'cursor-v1.json', 'm1.json', 'tasks-v1.json', 'engine-transcripts.json', 's1.json'];
    for (const [tool, args] of [['glob', { root: link, pattern: '**/*' }], ['file_list', { root: link }], ['project_snapshot', { root: link }]]) {
      const r = await I.toolCall(tool, { ...args, includeIgnored: true }, ctxFor(ws, 'default'));
      assert.equal(r.ok, true, tool + ' ' + dump(r).slice(0, 300));
      const hit = sensitiveNames.filter(n => namesIn(r).includes('"' + n + '"') || namesIn(r).includes('/' + n) || namesIn(r).includes('\\\\' + n));
      assert.deepEqual(hit, [], `${tool} listed sensitive names: ${hit.join(',')}`);
    }
  });
  it('信封里回显的 root 仍是调用方给的写法;链接指向普通目录时行为不变(不误伤)', async (t) => {
    if (!linked) return t.skip('no link');
    const plain = path.join(ws, 'plain');
    fs.mkdirSync(path.join(plain, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'sub', 'a.js'), 'const needle = 1;\n');
    const plainLink = path.join(ws, 'plainlink');
    if (!tryLink(plain, plainLink, 'dir')) return t.skip('no link');
    const r = await I.toolCall('file_search', { root: plainLink, pattern: 'needle' }, ctxFor(ws, 'default'));
    assert.equal(r.ok, true, dump(r));
    assert.equal(r.root, plainLink, 'echoed root stays as the caller wrote it');
    assert.ok(r.matches.some(m => /a\.js$/.test(m.path)), dump(r));
    const gl = await I.toolCall('glob', { root: plainLink, pattern: '**/*.js' }, ctxFor(ws, 'default'));
    assert.ok(gl.files.some(f => /a\.js$/.test(f.relativePath)), dump(gl));
  });
});

describe('S7 · 祖先目录当 root(工作区 = 家目录):敏感子树不入结果', () => {
  it('file_search / file_list / glob 以家目录为根,新增的管家 / 事项 / 调度 / 迁移数据不外泄,检查点与上传产物照旧可见', async () => {
    const rs = await I.toolCall('file_search', { root: home, pattern: 'STEWARDMEMORY|SECRETKEY|WCWTOKEN', includeHidden: true, maxResults: 500 }, ctxFor(home, 'default'));
    assert.deepEqual(leaks(rs), [], dump(rs).slice(0, 300));
    const rl = await I.toolCall('file_list', { root: dataRootDir, pattern: '.', includeIgnored: true, absolute: true }, ctxFor(home, 'default'));
    const rg = await I.toolCall('glob', { root: dataRootDir, pattern: '**/*', includeIgnored: true, absolute: true }, ctxFor(home, 'default'));
    for (const r of [rl, rg]) {
      const txt = dump(r);
      for (const n of ['config.json', 'runtime.json', 'cursor-v1.json', 'tasks-v1.json', 'engine-transcripts.json']) assert.ok(!txt.includes(n), n + ' must not be listed: ' + txt.slice(0, 300));
      assert.ok(txt.includes('1-1.txt') || txt.includes('a.txt'), 'checkpoints / uploads stay visible: ' + txt.slice(0, 300));
    }
  });
  it('file_read 新增敏感名单:steward / missions / scheduler / migrations / engine-transcripts.json 拒;checkpoints 与 uploads 仍可读', async () => {
    const ctx = ctxFor(home, 'default');
    for (const rel of ['steward/cursor-v1.json', 'missions/m1.json', 'scheduler/tasks-v1.json', 'migrations/1.json', 'engine-transcripts.json', 'config.json', 'runtime.json', 'sessions/s1.json']) {
      const g = await I.guardFileToolPath(path.join(dataRootDir, rel), ctx, { tool: 'file_read', write: false });
      assert.equal(g.ok, false, rel + ' must be denied: ' + dump(g));
      const r = await I.toolCall('file_read', { path: path.join(dataRootDir, rel) }, ctx);
      assert.equal(r.ok, false, rel + ' ' + dump(r).slice(0, 200));
      assert.deepEqual(leaks(r), []);
    }
    for (const rel of ['checkpoints/s1/1-1.txt', 'uploads/a.txt']) {
      const g = await I.guardFileToolPath(path.join(dataRootDir, rel), ctx, { tool: 'file_read', write: false });
      assert.equal(g.ok, true, rel + ' must stay readable: ' + dump(g));
    }
  });
});

describe('S7 · config.json / runtime.json 的硬链接别名(dev+ino 比对)', () => {
  const hardCfg = path.join(ws, 'hard-config.json');
  const hardRt = path.join(ws, 'hard-runtime.json');
  const benignSrc = path.join(ws, 'benign-src.json');
  const benignHard = path.join(ws, 'benign-hard.json');
  let linked = false;
  it('准备:ws/hard-config.json 与 ws/hard-runtime.json 是数据根文件的硬链接;另造一对无关的硬链接', (t) => {
    try {
      fs.linkSync(path.join(dataRootDir, 'config.json'), hardCfg);
      fs.linkSync(path.join(dataRootDir, 'runtime.json'), hardRt);
      fs.writeFileSync(benignSrc, '{"benign":"visible-benign-content"}');
      fs.linkSync(benignSrc, benignHard);
      linked = true;
    } catch (e) { t.skip('hard links unavailable: ' + (e && e.code)); }
  });
  it('file_read / file_copy(from)/ file_write / file_edit / file_delete 经硬链接别名一律拒,config.json 原样', async (t) => {
    if (!linked) return t.skip('no hard link');
    const before = fs.readFileSync(path.join(dataRootDir, 'config.json'), 'utf8');
    const ctx = ctxFor(ws, 'bypass');
    for (const [tool, args] of [
      ['file_read', { path: hardCfg }], ['file_read', { path: hardRt }],
      ['file_copy', { from: hardCfg, to: path.join(ws, 'stolen.json') }],
      ['file_write', { path: hardCfg, content: '{"pwned":true}' }],
      ['file_edit', { path: hardCfg, old_string: 'providers', new_string: 'pwned' }],
      ['file_delete', { path: hardCfg }],
      ['data_profile', { path: hardCfg }],
    ]) {
      const r = await I.toolCall(tool, args, ctx);
      assert.equal(r.ok, false, tool + ' ' + dump(r).slice(0, 200));
      assert.deepEqual(leaks(r), [], tool);
    }
    assert.equal(fs.existsSync(path.join(ws, 'stolen.json')), false);
    assert.equal(fs.readFileSync(path.join(dataRootDir, 'config.json'), 'utf8'), before);
  });
  it('file_search / file_list / glob / archive_zip 不把别名里的内容或名字带出来;无关的硬链接照常可读可列', async (t) => {
    if (!linked) return t.skip('no hard link');
    const ctx = ctxFor(ws, 'default');
    const rs = await I.toolCall('file_search', { root: ws, pattern: 'SECRETKEY|WCWTOKEN|providers|token', maxResults: 100 }, ctx);
    assert.deepEqual(leaks(rs), [], dump(rs).slice(0, 300));
    assert.ok(!dump(rs).includes('hard-config.json') && !dump(rs).includes('hard-runtime.json'), dump(rs).slice(0, 300));
    const rb = await I.toolCall('file_search', { root: ws, pattern: 'visible-benign-content', maxResults: 100 }, ctx);
    assert.ok(rb.matches.some(m => /benign-(src|hard)\.json$/.test(m.path)), 'unrelated hard link must still be searchable: ' + dump(rb).slice(0, 300));
    const rl = await I.toolCall('file_list', { root: ws, recursive: false }, ctx);
    const rg = await I.toolCall('glob', { root: ws, pattern: '*.json' }, ctx);
    for (const r of [rl, rg]) {
      assert.ok(!dump(r).includes('hard-config.json') && !dump(r).includes('hard-runtime.json'), dump(r).slice(0, 300));
      assert.ok(dump(r).includes('benign-hard.json'), 'unrelated hard link stays listed: ' + dump(r).slice(0, 300));
    }
    const zip = path.join(ws, 'pack.zip');
    const rz = await I.toolCall('archive_zip', { paths: [ws], dest: zip }, ctx);
    assert.equal(rz.ok, true, dump(rz).slice(0, 300));
    const zipBytes = fs.readFileSync(zip).toString('latin1');
    assert.ok(!zipBytes.includes('hard-config.json') && !zipBytes.includes('hard-runtime.json'), 'aliases must not be packed');
    assert.ok(zipBytes.includes('benign-hard.json'));
    const rb2 = await I.toolCall('file_read', { path: benignHard }, ctx);
    assert.equal(rb2.ok, true, dump(rb2).slice(0, 200));
  });
});

if (!NO_RG) {
  describe('S7 · JS 扫描引擎(PATH 里没有 rg)同一批断言', () => {
    it('子进程跑本文件:退出码 0', () => {
      // NODE_TEST_CONTEXT 是外层 node --test 塞给子测试的标记:带着它再起 `node --test` 会被当成「已在测试子进程里」而不真跑、恒退出 0,必须摘掉。
      const env = { ...process.env, W2_NO_RG: '1' };
      delete env.NODE_TEST_CONTEXT;
      const r = cp.spawnSync(process.execPath, ['--test', __filename], { env, encoding: 'utf8', timeout: 240000 });
      assert.equal(r.status, 0, (r.stdout || '').split('\n').filter(l => /not ok|# (fail|pass)/.test(l)).join('\n') + (r.stderr || '').slice(0, 500));
    });
  });
}
