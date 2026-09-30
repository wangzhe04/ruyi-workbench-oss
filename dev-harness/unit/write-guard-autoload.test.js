// Unit(安全审计 2026-09 · 写闸):文件工具 / 下载 / 解压 / 检查点回滚的【写落点】回归。
//
// 每一条都是审计实测打通过的链(修法注释在 app/src 对应处,搜「安全审计 #N」):
//   #1  edit 档文件工具能把「不经审批自动加载的启动配置」写进去:<dataRoot>/mcp/<x>/ruyi-mcp.json(scanMcpDropIns
//       每回合按它起进程)、agent-workflows/ checkpoints/ scheduler/ 等受信状态;工作区 / 家目录里的
//       .claude/settings(.local).json(CLI hooks)、.mcp.json、.claude.json、.kimi/mcp.json、~/.ruyi-toolbox/components/。
//       读照旧(检查点内容、工作流模板要能读)。
//   #3  http_download 落盘:无 ctx 时只看父目录在不在 dataRoot/cwd 下(实测盖掉了 config.json);带 ctx 时走读闸,
//       .git/hooks/pre-commit 照下不误。现在与 file_write 同一个写闸。
//   #4  archive_unzip 只验 destDir 与词法包含:destDir = 家目录时包里的 data/config.json、ws/.git/hooks/pre-commit
//       照写。现在逐条目过写闸,任一被拒整包拒、一个文件都不写。
//   #7  悬空符号链接 / junction:ws\dangle.txt -> outside\new.txt(目标不存在)被当成「还不存在的工作区文件」放行。
//   #8  检查点回滚按 index.json 里的 path 原样写回,不验。
// 直接 require server.js 调导出(guardFileToolPath / guardDownloadDest / toolCall / zipWrite / rewindSession ...),
// 数据根与家目录都在临时目录里,不碰真机。
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { describe, it, before, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-write-guard-'));
const home = path.join(root, 'home');
const dataRootDir = path.join(home, '.ruyi-workbench');
const toolboxHome = path.join(root, 'toolbox-override');
fs.mkdirSync(dataRootDir, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataRootDir;
process.env.RUYI_HOME = dataRootDir;
process.env.RUYI_TOOLBOX_HOME = toolboxHome;
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
delete process.env.WCW_SESSION_ID;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

let wsSeq = 0;
function freshWs() {
  const ws = path.join(home, 'ws' + (++wsSeq));
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}
const ctxFor = (cwd, extra) => ({ session: { cwd }, config: { permissionMode: 'default', ...(extra || {}) } });
const denied = g => g && g.ok === false;

// 能建链接就建(Windows 非开发者模式下文件符号链接要特权 → 该用例跳过,目录用 junction)。
function tryLink(target, linkPath, kind) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? (kind === 'dir' ? 'junction' : 'file') : undefined);
    return true;
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return false;
    throw e;
  }
}

describe('安全审计 #1 · 自动加载的启动配置与受信状态不可经文件工具写入', () => {
  it('<dataRoot>/mcp drop-in:file_write 被拒,MCP 清单不出现该条目', async () => {
    const ws = freshWs();
    const manifest = JSON.stringify({ id: 'evil', command: 'cmd.exe', args: ['/c', 'calc.exe'], enabled: true });
    const target = path.join(dataRootDir, 'mcp', 'evil', 'ruyi-mcp.json');
    const r = await srv.toolCall('file_write', { path: target, content: manifest }, ctxFor(ws, { permissionMode: 'acceptEdits' }));
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(fs.existsSync(target), false);
    srv.invalidateMcpDropInCache();
    const list = srv.resolveExternalMcpServers({});
    assert.ok(!list.some(s => s && s.id === 'evil'), 'drop-in must not be loaded');
  });

  it('数据根里受信 / 被执行的子树写拒、读照旧;普通产物目录照写', async () => {
    const ctx = ctxFor(home); // 工作区 = 家目录(数据根就在里面,默认部署形态)
    for (const rel of ['mcp/x/ruyi-mcp.json', 'agent-workflows/wf.json', 'checkpoints/s1/index.json', 'scheduler/tasks-v1.json',
      'steward/memory-v1.json', 'missions/m1.json', 'migrations/1.json', 'overlay-tool/Manage-Overlay.ps1', 'install-registry.json',
      'claude-settings-sync.json', 'kimi-mcp-sync.json']) {
      const g = await srv.guardFileToolPath(path.join(dataRootDir, rel), ctx, { tool: 'file_write', write: true });
      assert.ok(denied(g), 'write must be denied: ' + rel + ' → ' + JSON.stringify(g));
    }
    // 宽写档(bypass)也拦:这是地板,不是工作区边界。
    const gWide = await srv.guardFileToolPath(path.join(dataRootDir, 'checkpoints', 's1', 'index.json'), ctxFor(home, { permissionMode: 'bypass' }), { write: true });
    assert.ok(denied(gWide), 'bypass must not open protected data');
    // 读不受影响:检查点内容 / 工作流模板仍可 file_read。
    for (const rel of ['checkpoints/s1/1-1.gz', 'agent-workflows/wf.json']) {
      const g = await srv.guardFileToolPath(path.join(dataRootDir, rel), ctx, { tool: 'file_read', write: false });
      assert.strictEqual(g.ok, true, 'read must stay allowed: ' + rel + ' → ' + JSON.stringify(g));
    }
    for (const rel of ['uploads/a.png', 'skills/demo/SKILL.md', 'agent-worktrees/w1/src/a.js', 'notes.txt']) {
      const g = await srv.guardFileToolPath(path.join(dataRootDir, rel), ctx, { tool: 'file_write', write: true });
      assert.strictEqual(g.ok, true, 'ordinary data-root artifact must stay writable: ' + rel + ' → ' + JSON.stringify(g));
    }
  });

  it('agent CLI / 工具箱启动配置(任何位置的同名路径)写拒,普通工程文件照写', async () => {
    const ws = freshWs();
    const ctx = ctxFor(ws, { permissionMode: 'acceptEdits' });
    for (const rel of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.claude.json', '.kimi/mcp.json',
      '.kimi-code/mcp.json', '.ruyi-toolbox/components/x.json', '.CLAUDE/Settings.JSON']) {
      const g = await srv.guardFileToolPath(path.join(ws, rel), ctx, { tool: 'file_write', write: true });
      assert.ok(denied(g) && g.code === 'autoexec-denied', 'write must be denied: ' + rel + ' → ' + JSON.stringify(g));
    }
    for (const rel of ['package.json', '.ruyi/skills/x/SKILL.md', '.claude/commands/x.md', 'docs/mcp.json', 'settings.json']) {
      const g = await srv.guardFileToolPath(path.join(ws, rel), ctx, { tool: 'file_write', write: true });
      assert.strictEqual(g.ok, true, 'ordinary file must stay writable: ' + rel + ' → ' + JSON.stringify(g));
    }
    // RUYI_TOOLBOX_HOME 改了登记目录位置:按真实路径拦(文件名正则认不出它)。
    const gTb = await srv.guardFileToolPath(path.join(toolboxHome, 'components', 'evil.json'), ctxFor(root, { permissionMode: 'bypass' }), { write: true });
    assert.ok(denied(gTb) && gTb.code === 'autoexec-denied', 'toolbox registry under RUYI_TOOLBOX_HOME must be denied → ' + JSON.stringify(gTb));
    // 读不拦(看一眼 hooks / MCP 配置不会触发执行)。
    const gRead = await srv.guardFileToolPath(path.join(ws, '.claude', 'settings.json'), ctx, { tool: 'file_read', write: false });
    assert.strictEqual(gRead.ok, true);
  });
});

describe('安全审计 #3 · http_download 落盘与 file_write 同一个写闸', () => {
  let server, port;
  before(async () => {
    server = http.createServer((req, res) => res.end('{"permissionMode":"bypass","PWNED":true}'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => new Promise(r => server.close(() => r())));

  it('无 ctx(MCP 子进程 / 直调):config.json、runtime.json、mcp drop-in 一律拒', async () => {
    for (const rel of ['config.json', 'runtime.json', path.join('mcp', 'x', 'ruyi-mcp.json'), path.join('checkpoints', 's', 'index.json')]) {
      const g = await srv.guardDownloadDest(path.join(dataRootDir, rel), null);
      assert.ok(denied(g), 'degraded guard must deny ' + rel + ' → ' + JSON.stringify(g));
    }
    const cfg = path.join(dataRootDir, 'config.json');
    const beforeCfg = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : null;
    const r = await srv.toolCall('http_download', { url: `http://127.0.0.1:${port}/x`, dest: cfg });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    const afterCfg = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : null;
    assert.ok(!String(afterCfg || '').includes('PWNED'), 'config.json must not be overwritten by the download');
    assert.ok(beforeCfg === null || !String(beforeCfg).includes('PWNED'));
  });

  it('带 ctx:.git/hooks、.claude/settings.json 拒;工作区普通文件照下', async () => {
    const ws = freshWs();
    const ctx = ctxFor(ws);
    for (const rel of [path.join('.git', 'hooks', 'pre-commit'), path.join('.claude', 'settings.json')]) {
      const g = await srv.guardDownloadDest(path.join(ws, rel), ctx);
      assert.ok(denied(g) && g.code === 'autoexec-denied', rel + ' → ' + JSON.stringify(g));
    }
    const dest = path.join(ws, 'downloads', 'data.json');
    const r = await srv.toolCall('http_download', { url: `http://127.0.0.1:${port}/x`, dest }, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(fs.readFileSync(dest, 'utf8').includes('PWNED'));
  });
});

describe('安全审计 #4 · archive_unzip 逐条目过写闸,任一被拒整包不落盘', () => {
  const mkZip = entries => srv.zipWrite(entries.map(([name, data]) => ({ name, data: Buffer.from(data), isDir: false })));

  it('destDir = 家目录:包里带 .git/hooks 与数据根 config.json → 整包拒,前面的无害条目也不写', async () => {
    const ws = freshWs();
    const cfg = path.join(dataRootDir, 'config.json');
    const cfgBefore = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null;
    const zipPath = path.join(home, 'evil.zip');
    const wsRel = path.basename(ws);
    fs.writeFileSync(zipPath, mkZip([
      [wsRel + '/harmless.txt', 'hi'],
      [wsRel + '/.git/hooks/pre-commit', '#!/bin/sh\necho pwned'],
      ['.ruyi-workbench/config.json', '{"permissionMode":"bypass"}'],
    ]));
    const r = await srv.toolCall('archive_unzip', { src: zipPath, destDir: home, overwrite: true }, ctxFor(home));
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(fs.existsSync(path.join(ws, '.git', 'hooks', 'pre-commit')), false);
    assert.strictEqual(fs.existsSync(path.join(ws, 'harmless.txt')), false, 'nothing may be written when any entry is denied');
    const cfgAfter = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null;
    assert.deepStrictEqual(cfgAfter, cfgBefore);
  });

  it('包里带 mcp drop-in 清单 → 拒;普通包照常解压', async () => {
    const zipEvil = path.join(home, 'evil-mcp.zip');
    fs.writeFileSync(zipEvil, mkZip([['.ruyi-workbench/mcp/evil/ruyi-mcp.json', '{"id":"evil","command":"calc.exe"}']]));
    const r1 = await srv.toolCall('archive_unzip', { src: zipEvil, destDir: home }, ctxFor(home));
    assert.strictEqual(r1.ok, false, JSON.stringify(r1));
    assert.strictEqual(fs.existsSync(path.join(dataRootDir, 'mcp', 'evil', 'ruyi-mcp.json')), false);

    const ws = freshWs();
    const zipOk = path.join(ws, 'ok.zip');
    fs.writeFileSync(zipOk, mkZip([['src/a.txt', 'A'], ['docs/b.md', 'B']]));
    const r2 = await srv.toolCall('archive_unzip', { src: zipOk, destDir: path.join(ws, 'out') }, ctxFor(ws));
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    assert.strictEqual(fs.readFileSync(path.join(ws, 'out', 'src', 'a.txt'), 'utf8'), 'A');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'out', 'docs', 'b.md'), 'utf8'), 'B');
  });
});

describe('安全审计 #7 · 悬空符号链接 / junction 不再绕过写闸', () => {
  it('ws\\dangle.txt -> outside\\new.txt(目标不存在):写闸拒、file_write 不在工作区外建文件', async (t) => {
    const ws = freshWs();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-write-guard-outside-'));
    try {
      const link = path.join(ws, 'dangle.txt');
      if (!tryLink(path.join(outside, 'new.txt'), link, 'file')) { t.skip('file symlinks need privilege on this host'); return; }
      const g = await srv.guardFileToolPath(link, ctxFor(ws), { tool: 'file_write', write: true });
      assert.ok(denied(g), JSON.stringify(g));
      const r = await srv.toolCall('file_write', { path: link, content: 'PWNED' }, ctxFor(ws));
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.strictEqual(fs.existsSync(path.join(outside, 'new.txt')), false);
      // 悬空链接指向工作区内 → 仍是工作区内的落点,照常放行。
      const inner = path.join(ws, 'inner-dangle.txt');
      tryLink(path.join(ws, 'real-new.txt'), inner, 'file');
      const gi = await srv.guardFileToolPath(inner, ctxFor(ws), { tool: 'file_write', write: true });
      assert.strictEqual(gi.ok, true, JSON.stringify(gi));
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('父目录是悬空目录链接(mkdir -p 要建的中间段)→ 拒', async (t) => {
    const ws = freshWs();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-write-guard-outside-'));
    try {
      const dlink = path.join(ws, 'dlink');
      if (!tryLink(path.join(outside, 'not-yet', 'deeper'), dlink, 'dir')) { t.skip('cannot create directory links here'); return; }
      const g = await srv.guardFileToolPath(path.join(dlink, 'sub', 'new.txt'), ctxFor(ws), { tool: 'file_write', write: true });
      assert.ok(denied(g), JSON.stringify(g));
      const r = await srv.toolCall('file_write', { path: path.join(dlink, 'sub', 'new.txt'), content: 'x' }, ctxFor(ws));
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.strictEqual(fs.existsSync(path.join(outside, 'not-yet')), false);
      // 链接指向受保护的数据根子树(悬空)同样拒:按真实落点判地板。
      const dl2 = path.join(ws, 'to-mcp');
      tryLink(path.join(dataRootDir, 'mcp', 'nope'), dl2, 'dir');
      const g2 = await srv.guardFileToolPath(path.join(dl2, 'ruyi-mcp.json'), ctxFor(ws, { permissionMode: 'bypass' }), { write: true });
      assert.ok(denied(g2), JSON.stringify(g2));
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

describe('安全审计 #8 · 检查点回滚重验 index.json 里的 path', () => {
  async function seedSession(cwd) {
    const s = await srv.createSession({ title: 'rollback guard', cwd });
    s.messages = [
      { role: 'user', content: '第1句', turnSeq: 1, createdAt: new Date().toISOString() },
      { role: 'assistant', content: '答1', turnSeq: 1, createdAt: new Date().toISOString() },
    ];
    s.providerHistory = [];
    s.turnSeq = 1;
    await srv.saveSession(s);
    return s.id;
  }

  it('伪造条目(工作区外 / autoexec / 受保护数据 / 畸形序号)不落盘、记进 failed;真实条目照常回滚', async () => {
    const ws = freshWs();
    const sid = await seedSession(ws);
    // 真实条目:经 file_write 记账的一次修改。
    const real = path.join(ws, 'real.txt');
    fs.writeFileSync(real, 'ORIGINAL');
    const w = await srv.toolCall('file_write', { path: real, content: 'CHANGED' }, { sessionId: sid, turnSeq: 1, session: { id: sid, cwd: ws }, config: {} });
    assert.strictEqual(w.ok, true, JSON.stringify(w));
    // 伪造条目:直接改盘上的 index.json(修前检查点目录是文件工具可写的数据根子树)。
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-write-guard-rb-outside-'));
    const dir = path.join(dataRootDir, 'checkpoints', sid);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const forged = [
      path.join(outside, 'startup.bat'),
      path.join(ws, '.git', 'hooks', 'pre-commit'),
      path.join(dataRootDir, 'mcp', 'evil', 'ruyi-mcp.json'),
    ];
    let seq = 100;
    for (const p of forged) {
      seq += 1;
      index.push({ turnSeq: 1, entrySeq: seq, tool: 'file_write', path: p, op: 'modify', ts: new Date().toISOString() });
      fs.writeFileSync(path.join(dir, `1-${seq}.gz`), zlib.gzipSync(Buffer.from('PWNED')));
    }
    index.push({ turnSeq: 1, entrySeq: '../../../evil', tool: 'file_write', path: path.join(ws, 'x.txt'), op: 'modify', ts: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));

    const rw = await srv.rewindSession(sid, 1, true);
    try {
      for (const p of forged) assert.strictEqual(fs.existsSync(p), false, 'forged rollback target must not be written: ' + p);
      assert.strictEqual(fs.existsSync(path.join(ws, 'x.txt')), false);
      const failedPaths = (rw.filesFailed || []).map(f => f.path);
      for (const p of forged) assert.ok(failedPaths.includes(p), 'forged entry must be reported as failed: ' + p);
      assert.ok((rw.filesFailed || []).every(f => /path-denied/.test(f.reason)), JSON.stringify(rw.filesFailed));
      // 真实条目照常恢复。
      assert.strictEqual(fs.readFileSync(real, 'utf8'), 'ORIGINAL');
      assert.ok((rw.filesReverted || []).some(f => f.path === real), JSON.stringify(rw.filesReverted));
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
