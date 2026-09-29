// Unit(hunt2 · tools):写族文件工具与检查点账本的完整性回归。
//
// 每一条都是实测过的「回 ok:true 却丢数据 / 撤不回来 / 泄密」的缺陷,修法的注释在 app/src 对应处(搜 hunt2 #N)。
// 放 unit 而不是 e2e:这些都是 toolCall / 检查点存储层的不变量,直接调 server.js 的导出就能确定性地摆出每一种
// 交错(需要「卡在某一步」的地方在 fs/promises 上装一次性卡子,与 session-rewind-gen.test.js 同一手法)。
//
//   #1  >5MB 文件 file_move:检查点存不下源文件时不能留一对「回滚=删掉唯一一份内容」的条目;
//   #2  file_edit 遇到非 UTF-8(GBK)文件拒绝,不把中文写成 U+FFFD;检查点存原字节;
//   #3  archive_zip 打包数据根的祖先目录,config.json 等敏感控制面不得入包;
//   #4  CLI 回合对账(git 基线)按原字节取 HEAD 内容(GBK 不坏)、还原 CRLF;git 读失败不当成「回合前不存在」;
//   #5  跨盘(EXDEV)退化 copy+unlink 成功时检查点不能被提前丢掉;
//   #6  entrySeq 在中间条目被删之后不撞号(撞号 = 覆写别人的 .gz);
//   #7  同一文件并发 file_edit 不丢更新;
//   #8  CRLF 文件里以 "\n" 开头的 oldText 不产出 "\r\r\n";
//   #9  file_write 漏传 content / file_edit 漏传 newText 不再静默清空;
//   #10 file_write 保住原文件的 UTF-8 BOM,新建 .ps1 带 BOM;
//   #11 持久 shell 的输出按流解码,跨 chunk 的汉字不成 U+FFFD(需要假 powershell.exe,只在非 Windows 跑);
//   #12 撤回不让被截掉回合的后台任务回执复活;
//   #13 archive_unzip 批量记账:索引写入次数不随文件数线性增长;
//   #15 file_edit 未命中时的 firstDiff 长词元一轮真的在跑;
//   #17 file_edit 等在检查点没存下时带 checkpointWarn;
//   #18 索引一次瞬时读错误不会让下一次记账把整份索引盖掉;
//   #19 删会话一并删掉后台任务账本。
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');   // 与 server.js 里的 fsp 是同一个对象 —— 卡子装在它的属性上
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { describe, it, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-file-tool-integrity-'));
// 数据根放在「家目录」里面(默认部署就是 ~/.ruyi-workbench),#3 要打包的正是它的祖先目录。
const home = path.join(root, 'home');
const dataRootDir = path.join(home, '.ruyi-workbench');
fs.mkdirSync(dataRootDir, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataRootDir;
process.env.RUYI_HOME = dataRootDir;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

let wsSeq = 0;
function freshWs() {
  const ws = path.join(home, 'proj' + (++wsSeq));
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}
const ctxFor = (ws, sessionId, turnSeq) => ({ sessionId, turnSeq, workingDir: ws, session: { cwd: ws }, config: {} });
const indexOf = sid => {
  try { return JSON.parse(fs.readFileSync(path.join(dataRootDir, 'checkpoints', sid, 'index.json'), 'utf8')); } catch { return []; }
};
const gzBefore = (sid, e) => zlib.gunzipSync(fs.readFileSync(path.join(dataRootDir, 'checkpoints', sid, `${e.turnSeq}-${e.entrySeq}.gz`)));

// 一条有 N 个回合的会话(rewindSession 按 user 消息的 turnSeq 定位)。
async function seedSession(turns, extra = []) {
  const s = await srv.createSession({ title: 'hunt2 tools', cwd: home });
  s.messages = [];
  s.providerHistory = [];
  for (let t = 1; t <= turns; t++) {
    s.messages.push({ role: 'user', content: `第${t}句`, turnSeq: t, createdAt: new Date().toISOString() });
    s.messages.push({ role: 'assistant', content: `答${t}`, turnSeq: t, turnSummary: { turnSeq: t }, createdAt: new Date().toISOString() });
  }
  s.messages.push(...extra);
  s.turnSeq = turns;
  await srv.saveSession(s);
  await srv.loadSession(s.id);
  return s.id;
}

// fs/promises 上的一次性卡子:第一次命中 match 时先报到,再等 release() 放行(或直接抛 throwError)。
function hook(method, match, { throwError, gate } = {}) {
  const original = fsp[method];
  let armed = true;
  let reachedResolve;
  const reached = new Promise(r => { reachedResolve = r; });
  let releaseResolve;
  const released = new Promise(r => { releaseResolve = r; });
  fsp[method] = async function hooked(...args) {
    if (armed && match(...args)) {
      armed = false;
      fsp[method] = original;
      reachedResolve();
      if (gate) await released;
      if (throwError) throw throwError();
    }
    return original.apply(this, args);
  };
  return { reached, release: () => releaseResolve(), restore: () => { fsp[method] = original; } };
}
const errnoError = code => () => Object.assign(new Error(code), { code });

describe('hunt2 · 写族文件工具与检查点完整性', () => {
  it('#1 >5MB 文件 file_move:不留「回滚删掉唯一一份」的条目;覆盖式移动拒绝', async () => {
    const ws = freshWs();
    const sid = await seedSession(1);
    const big = path.join(ws, 'big.log');
    const dest = path.join(ws, 'moved.log');
    fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0x78));
    const r = await srv.toolCall('file_move', { from: big, to: dest }, ctxFor(ws, sid, 1));
    assert.equal(r.ok, true);
    assert.match(String(r.checkpointWarn || ''), /不可一键撤销/, '移动了但不可撤销,必须如实披露');
    assert.deepEqual(indexOf(sid).filter(e => e.tool === 'file_move'), [], '源文件快照没存下 → 这一对条目都不能留');
    const rw = await srv.rewindSession(sid, 1, true);
    assert.equal(rw.ok, true);
    assert.equal(fs.existsSync(dest), true, '撤回本轮不得删掉移动后的唯一一份内容');
    assert.equal(fs.statSync(dest).size, 6 * 1024 * 1024);

    // 覆盖式:旧 to 与大文件二者必丢其一 → 拒绝,两边原样。
    const sid2 = await seedSession(1);
    const big2 = path.join(ws, 'big2.log');
    const old = path.join(ws, 'old.txt');
    fs.writeFileSync(big2, Buffer.alloc(6 * 1024 * 1024, 0x79));
    fs.writeFileSync(old, 'keep me');
    const r2 = await srv.toolCall('file_move', { from: big2, to: old, overwrite: true }, ctxFor(ws, sid2, 1));
    assert.equal(r2.ok, false);
    assert.equal(fs.statSync(big2).size, 6 * 1024 * 1024);
    assert.equal(fs.readFileSync(old, 'utf8'), 'keep me');
    assert.deepEqual(indexOf(sid2).filter(e => e.tool === 'file_move'), []);
  });

  it('#2 file_edit:GBK 文件拒绝且逐字节不变;UTF-8 文件的检查点是原字节', async () => {
    const ws = freshWs();
    const sid = 'sess_hunt2_gbk';
    const gbkFile = path.join(ws, 'gbk.txt');
    const gbk = Buffer.from('c4e3bac30a466f6f0ad6d0cec40a', 'hex'); // 你好\nFoo\n中文\n(GBK)
    fs.writeFileSync(gbkFile, gbk);
    const r = await srv.toolCall('file_edit', { path: gbkFile, oldText: 'Foo', newText: 'Bar' }, ctxFor(ws, sid, 1));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_utf8');
    assert.ok(fs.readFileSync(gbkFile).equals(gbk), 'GBK 文件一个字节都不能动');
    assert.deepEqual(indexOf(sid), [], '拒绝的编辑不记检查点');

    const u = path.join(ws, 'bom.txt');
    const orig = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\r\nFoo\r\n', 'utf8')]);
    fs.writeFileSync(u, orig);
    const r2 = await srv.toolCall('file_edit', { path: u, oldText: 'Foo', newText: 'Bar' }, ctxFor(ws, sid, 2));
    assert.equal(r2.ok, true);
    assert.ok(fs.readFileSync(u).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM 原样写回');
    const entry = indexOf(sid).find(e => e.turnSeq === 2);
    assert.ok(gzBefore(sid, entry).equals(orig), '检查点 = 编辑前的原字节');
  });

  it('#3 archive_zip 打包数据根的祖先目录:敏感控制面不入包', async () => {
    fs.writeFileSync(path.join(dataRootDir, 'config.json'), '{"providers":[{"apiKey":"sk-HUNT2-SECRET"}]}');
    fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'docs', 'readme.txt'), 'hello');
    const dest = path.join(root, 'out', 'home.zip');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ctx = { sessionId: 'sess_hunt2_zip', turnSeq: 1, workingDir: root, session: { cwd: root }, config: {} };
    // 直读被拒是前提(守卫本来就在);要验证的是打包祖先目录这条绕行。
    const direct = await srv.toolCall('file_read', { path: path.join(dataRootDir, 'config.json') }, ctx);
    assert.equal(direct.ok, false);
    const z = await srv.toolCall('archive_zip', { paths: [home], dest }, ctx);
    assert.equal(z.ok, true, JSON.stringify(z));
    assert.ok(z.skippedSensitive >= 1, '跳过的敏感项要计数披露');
    const zipBuf = fs.readFileSync(dest);
    assert.equal(zipBuf.includes('config.json'), false, '包里不得出现 config.json 条目');
    assert.equal(zipBuf.includes('readme.txt'), true, '普通文件照常入包');
    const outDir = path.join(root, 'out', 'x');
    const u = await srv.toolCall('archive_unzip', { src: dest, destDir: outDir }, ctx);
    assert.equal(u.ok, true);
    const leaked = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.readFileSync(p).includes('sk-HUNT2-SECRET')) leaked.push(p); } })(outDir);
    assert.deepEqual(leaked, []);
  });

  it('#4 git 基线对账:GBK 原字节、CRLF 还原、git 读失败不当成新建', async (t) => {
    const hasGit = cp.spawnSync('git', ['--version']).status === 0;
    if (!hasGit) { t.skip('git 不可用'); return; }
    const ws = freshWs();
    const g = args => cp.execFileSync('git', args, { cwd: ws, stdio: 'pipe' });
    g(['init', '-q']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'n']); g(['config', 'core.autocrlf', 'true']);
    const gbk = Buffer.from('c4e3bac30a466f6f0ad6d0cec40a', 'hex');
    fs.writeFileSync(path.join(ws, 'g.txt'), gbk);
    fs.writeFileSync(path.join(ws, 'c.txt'), 'line1\nline2\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
    // 按 Windows 上的真实形态重新检出:autocrlf=true 的工作区文件是 CRLF。
    fs.unlinkSync(path.join(ws, 'c.txt'));
    g(['checkout', '--', 'c.txt']);
    const cBefore = fs.readFileSync(path.join(ws, 'c.txt'));
    assert.equal(cBefore.toString('utf8'), 'line1\r\nline2\r\n', '前提:检出后是 CRLF');
    // g.txt 是作者直接写的 LF 文件、没被 git 重新检出过 —— 同样算干净,回滚要还原成它本来的 LF。
    const base = await srv.captureWorkspaceTurnBaseline(ws);
    assert.equal(base && base.kind, 'git');
    // 模拟 CLI 回合的编辑。
    fs.writeFileSync(path.join(ws, 'g.txt'), Buffer.from('c4e3bac30a4261720ad6d0cec40a', 'hex'));
    fs.writeFileSync(path.join(ws, 'c.txt'), 'line1\r\nLINE2\r\n');
    const sid = 'sess_hunt2_git';
    const rec = await srv.reconcileWorkspaceTurnBaseline(base, sid, 1);
    assert.equal(rec.recorded, 2, JSON.stringify(rec));
    const idx = indexOf(sid);
    const byName = name => idx.find(e => path.basename(e.path) === name);
    assert.ok(gzBefore(sid, byName('g.txt')).equals(gbk), 'GBK 文件的回合前内容逐字节保真');
    assert.ok(gzBefore(sid, byName('c.txt')).equals(cBefore), 'CRLF 工作区文件的回合前内容是 CRLF');

    // git 读失败(超时 / 超输出上限的同类):用只让 cat-file 失败的 git 垫片冒充。修前这条被记成 create,
    // 回滚时直接删掉用户改过的文件。垫片是 sh 脚本,只在非 Windows 跑。
    if (process.platform === 'win32') return;
    const realGit = cp.execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    const shim = path.join(root, 'gitshim');
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = cat-file ] && exit 128; done\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    g(['add', '-A']); g(['commit', '-q', '-m', 'turn1']);
    const base3 = await srv.captureWorkspaceTurnBaseline(ws);
    assert.equal(base3 && base3.kind, 'git');
    fs.writeFileSync(path.join(ws, 'g.txt'), 'rewritten\n');
    const oldPath = process.env.PATH;
    process.env.PATH = shim + path.delimiter + oldPath;
    let rec2;
    try { rec2 = await srv.reconcileWorkspaceTurnBaseline(base3, sid, 2); } finally { process.env.PATH = oldPath; }
    assert.equal(rec2.recorded, 1, JSON.stringify(rec2));
    const lost = indexOf(sid).find(e => e.turnSeq === 2);
    assert.equal(lost.op, 'modify', 'git 读失败不得当成回合内新建(create 的回滚是删文件)');
    assert.equal(lost.skipped, true, '内容未知 → 如实记为不可回滚');
  });

  it('#5 跨盘 EXDEV:copy+unlink 成功后检查点仍在、可回滚', async () => {
    const ws = freshWs();
    const sid = await seedSession(1);
    const a = path.join(ws, 'x.txt'), b = path.join(ws, 'y.txt');
    fs.writeFileSync(a, 'data');
    const h = hook('rename', from => path.resolve(String(from)) === a, { throwError: errnoError('EXDEV') });
    let r;
    try { r = await srv.toolCall('file_move', { from: a, to: b }, ctxFor(ws, sid, 1)); } finally { h.restore(); }
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(b), true);
    assert.equal(indexOf(sid).filter(e => e.tool === 'file_move').length, 2, '两条逆操作条目都在');
    const rw = await srv.rewindSession(sid, 1, true);
    assert.equal(rw.ok, true);
    assert.equal(fs.readFileSync(a, 'utf8'), 'data', '撤回把文件移回原处');
    assert.equal(fs.existsSync(b), false);
  });

  it('#6 entrySeq:中间条目被删后新条目不撞号', async () => {
    const ws = freshWs();
    const sid = 'sess_hunt2_seq';
    const from = path.join(ws, 'm.txt'), to = path.join(ws, 'n.txt');
    const p3 = path.join(ws, 'p3.txt'), p4 = path.join(ws, 'p4.txt');
    fs.writeFileSync(from, 'M'); fs.writeFileSync(p3, 'THREE'); fs.writeFileSync(p4, 'FOUR');
    // 子代理 A 的 file_move 记下 seq0/seq1 后卡在 rename;子代理 B 同回合记 seq2/seq3;A 的 rename 失败 → 删 seq0/seq1。
    const h = hook('rename', f => path.resolve(String(f)) === from, { gate: true, throwError: errnoError('EPERM') });
    const moving = srv.toolCall('file_move', { from, to }, ctxFor(ws, sid, 5));
    await h.reached;
    await srv.journalRecord(sid, 5, 'file_write', p3, 'modify', Buffer.from('THREE'));
    await srv.journalRecord(sid, 5, 'file_write', path.join(ws, 'other.txt'), 'create', null);
    h.release();
    const mv = await moving;
    assert.equal(mv.ok, false);
    await srv.journalRecord(sid, 5, 'file_write', p4, 'modify', Buffer.from('FOUR'));
    const seqs = indexOf(sid).filter(e => e.turnSeq === 5).map(e => e.entrySeq);
    assert.equal(new Set(seqs).size, seqs.length, `entrySeq 不得重复:${seqs.join(',')}`);
    const e3 = indexOf(sid).find(e => e.path === p3);
    assert.equal(gzBefore(sid, e3).toString('utf8'), 'THREE', 'p3 的快照没有被后来者覆写');
  });

  it('#7 同一文件并发 file_edit 两处替换都落盘', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'c.txt');
    fs.writeFileSync(f, 'AAA\nBBB\n');
    const ctx = ctxFor(ws, 'sess_hunt2_conc', 1);
    const [r1, r2] = await Promise.all([
      srv.toolCall('file_edit', { path: f, oldText: 'AAA', newText: 'aaa' }, ctx),
      srv.toolCall('file_edit', { path: f, oldText: 'BBB', newText: 'bbb' }, ctx),
    ]);
    assert.equal(r1.ok && r2.ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'aaa\nbbb\n');
  });

  it('#8 CRLF 文件 + 以 "\\n" 开头的 oldText:不产出 \\r\\r\\n', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'a.txt');
    fs.writeFileSync(f, 'hello\r\nworld\r\n');
    const r = await srv.toolCall('file_edit', { path: f, oldText: '\nworld', newText: '\nWORLD' }, ctxFor(ws, 'sess_hunt2_crlf', 1));
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello\r\nWORLD\r\n');
    assert.equal(r.writtenLineEnding, 'crlf');
  });

  it('#9 漏传 content / newText 不再静默清空', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'k.txt');
    fs.writeFileSync(f, 'important content');
    const ctx = ctxFor(ws, 'sess_hunt2_args', 1);
    const w = await srv.toolCall('file_write', { path: f }, ctx);
    assert.equal(w.ok, false);
    const e = await srv.toolCall('file_edit', { path: f, oldText: 'important' }, ctx);
    assert.equal(e.ok, false);
    assert.equal(fs.readFileSync(f, 'utf8'), 'important content');
    // 显式空串仍是合法的「清空 / 删除」。
    const e2 = await srv.toolCall('file_edit', { path: f, oldText: 'important ', newText: '' }, ctx);
    assert.equal(e2.ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'content');
  });

  it('#10 file_write 保住 BOM;新建 .ps1 带 BOM', async () => {
    const ws = freshWs();
    const ctx = ctxFor(ws, 'sess_hunt2_bom', 1);
    const b = path.join(ws, 'b.ps1');
    fs.writeFileSync(b, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Write-Host "中文"\r\n', 'utf8')]));
    const r = await srv.toolCall('file_write', { path: b, content: 'Write-Host "新"\r\n' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(b).subarray(0, 3).toString('hex'), 'efbbbf');
    const n = path.join(ws, 'new.ps1');
    await srv.toolCall('file_write', { path: n, content: 'Write-Host "你好"\n' }, ctx);
    assert.equal(fs.readFileSync(n).subarray(0, 3).toString('hex'), 'efbbbf');
    // 普通新文件不加 BOM(行为不变)。
    const t2 = path.join(ws, 'plain.txt');
    await srv.toolCall('file_write', { path: t2, content: '纯文本\n' }, ctx);
    assert.notEqual(fs.readFileSync(t2).subarray(0, 3).toString('hex'), 'efbbbf');
    // 同内容重写仍幂等跳过(BOM 已计入比较)。
    const again = await srv.toolCall('file_write', { path: n, content: 'Write-Host "你好"\n' }, ctx);
    assert.equal(again.op, 'skip');
  });

  it('#11 持久 shell:跨 chunk 的汉字按流解码', async (t) => {
    if (process.platform === 'win32') { t.skip('需要假 powershell.exe(非 Windows 才能用脚本冒充)'); return; }
    const bin = path.join(root, 'fakebin');
    fs.mkdirSync(bin, { recursive: true });
    // 「中文」的 UTF-8 字节 e4 b8 ad e6 96 87,故意在 e4 b8 | ad 处切成两次写。
    fs.writeFileSync(path.join(bin, 'powershell.exe'), "#!/bin/sh\nprintf '\\344\\270'\nsleep 0.3\nprintf '\\255\\346\\226\\207'\n", { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    const ws = freshWs();
    const ctx = ctxFor(ws, 'sess_hunt2_shell', 1);
    try {
      const s = await srv.toolCall('shell_start', { command: 'Write-Output 中文', cwd: ws }, ctx);
      assert.equal(s.ok, true, JSON.stringify(s));
      let poll;
      for (let i = 0; i < 100; i++) {
        poll = await srv.toolCall('shell_poll', { shellId: s.shellId }, ctx);
        if (!poll.running) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(poll.output, '中文');
    } finally { process.env.PATH = oldPath; }
  });

  it('#12 撤回之后,被截掉回合的后台任务回执不复活', async () => {
    const jobId = 'job_hunt2_rewind';
    const sid = await seedSession(1, [
      { role: 'user', content: 'second', turnSeq: 2, createdAt: new Date().toISOString() },
      { role: 'assistant', content: 'a2', turnSeq: 2, turnSummary: { turnSeq: 2 }, createdAt: new Date().toISOString() },
    ]);
    const s = await srv.loadSession(sid);
    s.turnSeq = 2;
    await srv.saveSession(s);
    // 回合 2 期间一个后台命令完成:账本记一行,会话读/存时合进消息。
    const ledger = path.join(dataRootDir, 'sessions', 'background-jobs', sid + '.json');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify([{ id: jobId, shellId: 'sh_1', name: 'build', sessionId: sid, status: 'succeeded', exitCode: 0, output: 'done', completedAt: new Date().toISOString() }]));
    const live = await srv.loadSession(sid);
    assert.ok(live.messages.some(m => m.backgroundJobId === jobId), '前提:回执已合进回合 2');
    await srv.saveSession(live);
    const rw = await srv.rewindSession(sid, 2, false);
    assert.equal(rw.ok, true);
    const afterRewind = await srv.loadSession(sid);
    assert.equal(afterRewind.messages.some(m => m.backgroundJobId === jobId), false, '回执随被撤回的回合一起消失');
    await srv.saveSession(afterRewind);
    assert.equal((await srv.loadSession(sid)).messages.some(m => m.backgroundJobId === jobId), false, '再存再读也不复活');
  });

  it('#13 archive_unzip 批量记账:索引写入次数远少于文件数', async () => {
    const ws = freshWs();
    const src = path.join(ws, 'many');
    fs.mkdirSync(src);
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(src, `f${i}.txt`), 'x' + i);
    const ctx = ctxFor(ws, 'sess_hunt2_bulk', 1);
    const z = await srv.toolCall('archive_zip', { paths: [src], dest: path.join(ws, 'many.zip') }, ctx);
    assert.equal(z.ok, true);
    const original = fsp.rename;
    let indexWrites = 0;
    fsp.rename = async function counted(from, to) {
      if (String(to).endsWith(path.join('sess_hunt2_bulk', 'index.json'))) indexWrites += 1;
      return original.apply(this, arguments);
    };
    let u;
    try { u = await srv.toolCall('archive_unzip', { src: path.join(ws, 'many.zip'), destDir: path.join(ws, 'out') }, ctx); } finally { fsp.rename = original; }
    assert.equal(u.ok, true);
    assert.equal(u.files, 300);
    assert.equal(indexOf('sess_hunt2_bulk').filter(e => e.tool === 'archive_unzip').length, 300, '每个文件仍各有一条检查点');
    assert.ok(indexWrites <= 5, `300 个文件的索引写入应是批量的(实际 ${indexWrites} 次)`);
  });

  it('#15 file_edit 未命中:firstDiff 先按长词元定位真正的形近行', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'calc.js');
    // B 行逐位重合度更高但与 oldText 没有一个共同词元;A 行才是把 → 写成 -> 的那一行。
    fs.writeFileSync(f, 'lot tatal = prace → tux\nlet total = price -> tax\n');
    const r = await srv.toolCall('file_edit', { path: f, oldText: 'let total = price → tax', newText: 'x' }, ctxFor(ws, 'sess_hunt2_diff', 1));
    assert.equal(r.ok, false);
    assert.equal(r.firstDiff && r.firstDiff.line, 2, JSON.stringify(r.firstDiff));
  });

  it('#17 file_edit 在检查点存不下时带 checkpointWarn', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'huge.txt');
    fs.writeFileSync(f, 'NEEDLE\n' + 'y'.repeat(6 * 1024 * 1024));
    const r = await srv.toolCall('file_edit', { path: f, oldText: 'NEEDLE', newText: 'found' }, ctxFor(ws, 'sess_hunt2_warn', 1));
    assert.equal(r.ok, true);
    assert.match(String(r.checkpointWarn || ''), /不可一键撤销/);
  });

  it('#18 索引一次瞬时读错误:本次记账失败,既有条目原样保留', async () => {
    const sid = 'sess_hunt2_eperm';
    const p = path.join(freshWs(), 'q.txt');
    for (let t = 1; t <= 3; t++) await srv.journalRecord(sid, t, 'file_write', p, 'modify', Buffer.from('v' + t));
    assert.equal(indexOf(sid).length, 3);
    const h = hook('readFile', f => String(f).endsWith(path.join(sid, 'index.json')), { throwError: errnoError('EPERM') });
    let r;
    try { r = await srv.journalRecord(sid, 4, 'file_write', p, 'modify', Buffer.from('v4')); } finally { h.restore(); }
    assert.equal(r.ok, false);
    assert.deepEqual(indexOf(sid).map(e => e.turnSeq), [1, 2, 3], '三个回合的检查点一条不少');
    const r2 = await srv.journalRecord(sid, 4, 'file_write', p, 'modify', Buffer.from('v4'));
    assert.equal(r2.ok, true);
    assert.deepEqual(indexOf(sid).map(e => e.turnSeq), [1, 2, 3, 4]);
  });

  it('#19 删会话一并删掉后台任务账本', async () => {
    const sid = await seedSession(1);
    const ledger = path.join(dataRootDir, 'sessions', 'background-jobs', sid + '.json');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, '[]');
    await srv.deleteSession(sid);
    assert.equal(fs.existsSync(ledger), false);
  });
});
