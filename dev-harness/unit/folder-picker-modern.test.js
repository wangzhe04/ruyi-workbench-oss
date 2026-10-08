'use strict';
// 3.0 收口(用户:「选择路径的那个界面太古老了」):原生文件夹选择器从 WinForms FolderBrowserDialog(.NET Framework 下是
// SHBrowseForFolder 那棵 XP 时代的树)换成 Vista 起的通用项目对话框(IFileOpenDialog + FOS_PICKFOLDERS),并从当前工作文件夹打开。
// 真弹窗进不了自动化;这里钉住「能弹出来」之前的每一环:
//   [S] 脚本形状:纯 ASCII(整段走 -EncodedCommand)、COM 的 CLSID/IID 与选项位、Add-Type 失败退回老对话框、成功行 'OK'+[char]9、
//       用户给的东西(标题 / 起始目录)只经环境变量进来,不拼进脚本文本;
//   [E] folderPickerEnv:控制字符剥掉、长度封顶;起始目录只认本机盘符绝对路径 —— UNC / 设备命名空间 / 相对路径一律不传;
//   [W] 仅 Windows:用真 powershell.exe 解析整段脚本并 Add-Type 编译其中的 C#(不弹窗)—— 修前「选好的路径被当取消」那类
//       只有真机才暴露的错误,这里在 CI 上就能红。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-folder-picker-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(root, 'data');
process.env.RUYI_HOME = path.join(root, 'data');
process.env.HOME = home;
process.env.USERPROFILE = home;

const { loadServerInternals } = require('../lib/server-internals');
const { DesktopShell } = loadServerInternals(['DesktopShell']);
const SCRIPT = DesktopShell.FOLDER_PICKER_PS_SCRIPT;
const csOf = script => { const m = /@'\n([\s\S]*?)\n'@/.exec(script); return m ? m[1] : ''; };

test('[S1] 脚本纯 ASCII、编码后在 Windows 命令行长度上限内', () => {
  assert.equal(typeof SCRIPT, 'string');
  assert.match(SCRIPT, /^[\x09\x0a\x20-\x7e]*$/, '脚本里只能有可打印 ASCII(中文进 -EncodedCommand 也行,但标题 / 路径必须走环境变量)');
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  assert.ok(encoded.length < 30000, `-EncodedCommand 参数 ${encoded.length} 字符,须留在 32767 的整行上限之内`);
});

test('[S2] 现代对话框:FileOpenDialog CLSID、IFileDialog / IShellItem IID、FOS_PICKFOLDERS 一族选项位、从起始目录打开', () => {
  const cs = csOf(SCRIPT);
  assert.ok(cs, 'C# 源码以单引号 here-string(@\' … \'@,收尾在行首)嵌在脚本里');
  assert.match(cs, /DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7/i, 'CLSID_FileOpenDialog');
  assert.match(cs, /42f85136-db7e-439c-85f1-e4075d135fc8/i, 'IID_IFileDialog');
  assert.match(cs, /43826D1E-E718-42EE-BC55-A1E261C37BFE/i, 'IID_IShellItem');
  assert.match(cs, /FOS_FLAGS\s*=\s*0x8\s*\|\s*0x20\s*\|\s*0x40\s*\|\s*0x800/, 'NOCHANGEDIR | PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST');
  assert.match(cs, /0x800704C7/i, '用户取消(HRESULT_FROM_WIN32(ERROR_CANCELLED))要与真失败分开');
  assert.match(cs, /SHCreateItemFromParsingName[\s\S]*SetFolder/, '起始目录经 SetFolder 生效');
  assert.match(cs, /SIGDN_FILESYSPATH\s*=\s*0x80058000/i, '结果取文件系统路径');
});

test('[S3] 退路与协议:Add-Type / COM 失败退回 FolderBrowserDialog;成功行 OK<TAB>路径;owner 置顶', () => {
  assert.match(SCRIPT, /try \{ Add-Type -TypeDefinition @'/);
  assert.match(SCRIPT, /\$modern = \$true \} catch \{ \$modern = \$false \}/);
  assert.match(SCRIPT, /if \(-not \$modern\) \{[\s\S]*FolderBrowserDialog[\s\S]*ShowDialog\(\$f\)/);
  assert.match(SCRIPT, /\[RuyiFolderPicker\]::Pick\(\$f\.Handle, \$title, \$initial\)/, '现代对话框挂在隐形 TopMost owner 上(否则被压在浏览器后面)');
  assert.match(SCRIPT, /\$f\.TopMost = \$true/);
  assert.match(SCRIPT, /Write-Output \('OK' \+ \[char\]9 \+ \$picked\)/, "成功行必须是 'OK' + [char]9(单引号里的 `t 不转义)");
  assert.match(SCRIPT, /Write-Output 'CANCEL'/);
  // 用户给的东西只经环境变量进来:脚本里读的环境变量只有这两个,且没有任何 Invoke-Expression。
  const envReads = [...SCRIPT.matchAll(/\$env:([A-Za-z_]+)/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(envReads)], ['RUYI_PICK_INITIAL', 'RUYI_PICK_TITLE']);
  assert.doesNotMatch(SCRIPT, /Invoke-Expression|\biex\b/i);
  assert.match(SCRIPT, /\[System\.IO\.Directory\]::Exists\(\$initial\)/, '起始目录不存在时不传(对话框退回系统默认位置)');
});

test('[E1] folderPickerEnv:标题剥控制字符、封顶 120;空标题不设键', () => {
  const env = DesktopShell.folderPickerEnv({ title: '选择\n工作\u0007文件夹' + 'x'.repeat(300) });
  assert.equal(env.RUYI_PICK_TITLE.slice(0, 7), '选择工作文件夹');
  assert.equal(env.RUYI_PICK_TITLE.length, 120);
  assert.deepEqual(DesktopShell.folderPickerEnv({ title: '  ' }), {});
  assert.deepEqual(DesktopShell.folderPickerEnv(null), {});
  assert.deepEqual(DesktopShell.folderPickerEnv('C:\\x'), {});
});

test('[E2] folderPickerEnv:起始目录只认本机盘符绝对路径(两种分隔符都认,归一成反斜杠)', () => {
  assert.equal(DesktopShell.folderPickerEnv({ initialDir: 'C:\\Users\\me\\proj' }).RUYI_PICK_INITIAL, 'C:\\Users\\me\\proj');
  assert.equal(DesktopShell.folderPickerEnv({ initialDir: 'D:/项目/网站/' }).RUYI_PICK_INITIAL, 'D:\\项目\\网站\\');
  assert.equal(DesktopShell.folderPickerEnv({ initialDir: '  e:\\a\\..\\b  ' }).RUYI_PICK_INITIAL, 'e:\\b');
});

test('[E3] folderPickerEnv:UNC / 设备命名空间 / 相对路径 / POSIX 路径 / 超长一律不传', () => {
  for (const bad of ['\\\\attacker\\share\\x', '//attacker/share/x', '\\\\?\\C:\\Windows', '\\\\.\\C:\\x', '\\\\?\\UNC\\h\\s',
    'relative\\dir', 'C:relative', '/home/me/proj', '', null, 42, 'C:\\' + 'a'.repeat(2000)]) {
    const env = DesktopShell.folderPickerEnv({ initialDir: bad });
    if (typeof bad === 'string' && bad.length > 1024) {
      // 超长:截到 1024 后仍是盘符开头的本机路径 —— 允许传,但长度封顶。
      assert.ok(!env.RUYI_PICK_INITIAL || env.RUYI_PICK_INITIAL.length <= 1024, 'over-long initialDir is capped');
      continue;
    }
    assert.equal(env.RUYI_PICK_INITIAL, undefined, `不该传:${JSON.stringify(bad)}`);
  }
});

test('[N1] 非 Windows:pickFolder 不起进程,返回带 hint 的优雅降级', { skip: process.platform === 'win32' ? '只在非 Windows 上验降级分支' : false }, async () => {
  const r = await DesktopShell.pickFolder({ title: 'x', initialDir: 'C:\\x' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /Windows/);
  assert.ok(r.hint);
});

test('[W1] Windows:真 powershell.exe 解析整段脚本、Add-Type 编译其中的 C#(不弹窗)', { skip: process.platform !== 'win32' ? '需要 Windows PowerShell 5.1(.NET Framework 的 C# 编译器)' : false }, () => {
  const probe = [
    "$ErrorActionPreference = 'Stop'",
    '$tokens = $null; $errors = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseInput($env:RUYI_TEST_PICKER_SCRIPT, [ref]$tokens, [ref]$errors)',
    "if ($errors.Count) { Write-Output ('PARSE-ERR ' + ($errors | ForEach-Object { $_.Message }) -join ' | '); exit 3 }",
    'Add-Type -TypeDefinition $env:RUYI_TEST_PICKER_CS',
    "if (-not [RuyiFolderPicker].GetMethod('Pick')) { Write-Output 'NO-METHOD'; exit 4 }",
    "Write-Output 'PROBE-OK'",
  ].join('\n');
  const r = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, RUYI_TEST_PICKER_SCRIPT: SCRIPT, RUYI_TEST_PICKER_CS: csOf(SCRIPT) },
  });
  assert.equal(r.status, 0, `powershell 退出码 ${r.status};stdout=${r.stdout};stderr=${String(r.stderr).slice(0, 800)}`);
  assert.match(String(r.stdout), /PROBE-OK/);
});
