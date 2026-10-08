'use strict';
// PowerShell / 控制台输出的编码(用户实测:中文 Windows 上 shell 会话里 PowerShell 的中文输出是乱码)。
//   [E1] 按行判定:GBK 行按 GBK 解、UTF-8 行按 UTF-8 解,混在同一份输出里也各自正确
//        (修前 runProcess 整段判定 —— 有一处不是 UTF-8 就整段按 GBK,UTF-8 那部分反被解坏;shell 会话一律按 UTF-8)
//   [E2] 流式:chunk 从一个 GBK / UTF-8 汉字中间切开也不出替换符;不带换行的尾巴(提示符)flush 时吐出
//   [E3] 交互式 shell 的输入:含中文的命令改成纯 ASCII 的等价命令(UTF-8 Base64 → Invoke-Expression),纯 ASCII 原样
//   [E4] 接线:runProcess 的 decodeBestEffort、shell 会话、覆盖包解压 / 进程取证都走这一套
//   [E5] 源头编码(仅 Windows 且有 powershell.exe;走生产路径 toolCall):非中文代码页(en-US:OEM 437 / ANSI 1252)的机器上,
//        powershell.exe 把输出按控制台代码页编码,中文在【源头】就变成 `?`(0x3f),Node 侧的 UTF-8 优先 / GB18030 回落无从还原。
//        脚本前导 [Console]::OutputEncoding = UTF8(无 BOM)后,中文输出、中文文件名、cmd /c dir、Write-Host、stderr 全部正确。
//        powershell_run / script_run(PowerShell)/ shell_start(后台命令 + 交互式 shell_send)四条路径都断言。
//   [E6] 前导的形状(跨平台、不起进程):withQuietProgress 把它放在 $ProgressPreference 之前、同一行、不换行(报错行号不漂);
//        用 UTF8Encoding($false) 而不是带 BOM 的 [Text.Encoding]::UTF8;豁免脚本(param / using / #requires / [CmdletBinding])两样都不加;
//        shell_start 的 -EncodedCommand 脚本头与交互式 -NoExit -Command 都带它,且不改用户命令的行号。
// 夹具里的 GBK 字节是手写的(中文 = D6 D0 CE C4,乱码 = C2 D2 C2 EB,找不到路径 = D5 D2 B2 BB B5 BD C2 B7 BE B6)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const path = require('path');
const { readServerSource } = require('../src-reader');
const readSrcFile = name => fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const { functionBlock, constBlock } = require('../lib/source-slice');

const source = readServerSource();
function load() {
  const code = [
    'let _consoleGbDecoder = null;',
    constBlock(source, '_consoleUtf8Strict'),
    functionBlock(source, 'decodeConsoleSegment'),
    functionBlock(source, 'decodeConsoleText'),
    functionBlock(source, 'consoleIncompleteTail'),
    functionBlock(source, 'createConsoleLineDecoder'),
    functionBlock(source, 'shellInputForPowerShell'),
    '({ decodeConsoleText, createConsoleLineDecoder, shellInputForPowerShell })',
  ].join('\n');
  return vm.runInNewContext(code, { Buffer, TextDecoder });
}
const { decodeConsoleText, createConsoleLineDecoder, shellInputForPowerShell } = load();

const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];                          // 中文
const GBK_LUANMA = [0xc2, 0xd2, 0xc2, 0xeb];                            // 乱码
const GBK_NOTFOUND = [0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xc2, 0xb7, 0xbe, 0xb6];   // 找不到路径
const bytes = (...parts) => Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));

test('[E1] 同一份输出里 GBK 行与 UTF-8 行各自解对', () => {
  const mixed = bytes('PS> git log --oneline\r\n', 'abc123 修复中文提交说明\n', GBK_NOTFOUND, ' C:\\', GBK_ZHONGWEN, '\r\n', 'done\n');
  assert.equal(decodeConsoleText(mixed), 'PS> git log --oneline\r\nabc123 修复中文提交说明\n找不到路径 C:\\中文\r\ndone\n');
  assert.equal(decodeConsoleText(bytes(GBK_LUANMA)), '乱码', '没有换行的单行 GBK');
  assert.equal(decodeConsoleText(bytes('纯 UTF-8')), '纯 UTF-8');
  assert.equal(decodeConsoleText(Buffer.alloc(0)), '');
});

test('[E2] 流式解码:切在汉字中间不出替换符,尾巴 flush 时吐出', () => {
  const full = bytes(GBK_ZHONGWEN, GBK_LUANMA, '\r\n', 'UTF-8 行:如意\n', 'PS C:\\', GBK_ZHONGWEN, '> ');
  for (let cut = 1; cut < full.length; cut++) {
    const dec = createConsoleLineDecoder();
    let out = dec.write(full.subarray(0, cut)) + dec.write(full.subarray(cut));
    out += dec.flush();
    assert.equal(out, '中文乱码\r\nUTF-8 行:如意\nPS C:\\中文> ', `切点 ${cut}`);
    assert.ok(!out.includes('\ufffd'));
  }
  // 空闲 flush 正好落在一个字符的两半之间(写方停顿):没写完的那半留着,下一次拼上再解
  for (const [label, parts] of [['UTF-8', [bytes('输出:'), Buffer.from([0xe4, 0xb8]), Buffer.from([0xad, 0xe6, 0x96, 0x87])]],
    ['GBK', [bytes('out:'), Buffer.from([0xd6]), Buffer.from([0xd0, 0xce, 0xc4])]]]) {
    const d = createConsoleLineDecoder();
    let got = d.write(parts[0]) + d.write(parts[1]) + d.flush();
    got += d.write(parts[2]) + d.flush();
    assert.equal(got, label === 'UTF-8' ? '输出:中文' : 'out:中文', `${label}:flush 不劈开字符`);
  }
  const dec = createConsoleLineDecoder();
  assert.equal(dec.write(bytes('提示符> ')), '', '没有换行先攒着');
  assert.equal(dec.pendingBytes > 0, true);
  assert.equal(dec.end(), '提示符> ');
});

test('[E3] 交互式 shell 的中文输入改成纯 ASCII 的等价命令', () => {
  assert.equal(shellInputForPowerShell('Get-ChildItem -Force'), 'Get-ChildItem -Force', '纯 ASCII 原样');
  const cmd = 'Get-ChildItem "C:\\用户\\如意 文档"';
  const wrapped = shellInputForPowerShell(cmd);
  assert.ok(!/[^\x00-\x7f]/.test(wrapped), '包装后纯 ASCII');
  const b64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(wrapped)[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), cmd, 'Base64 里是原文的 UTF-8');
  assert.match(wrapped, /^Invoke-Expression \(\[System\.Text\.Encoding\]::UTF8\.GetString\(/);
});

test('[E4] 接线:runProcess、shell 会话、覆盖包、进程取证都走按行解码', () => {
  const desktop = readSrcFile('04-desktop-shell.js');
  assert.match(functionBlock(desktop, 'decodeBestEffort'), /decodeConsoleTextFn\(buf\)/);
  const shell = functionBlock(readSrcFile('11-native-tools.js'), 'shellStart');
  assert.match(shell, /createConsoleLineDecoder\(\)/);
  assert.ok(!/new StringDecoder\('utf8'\)/.test(shell), 'shell 会话不再一律按 UTF-8');
  assert.match(functionBlock(readSrcFile('11-native-tools.js'), 'shellSend'), /shellInputForPowerShell\(/);
  const overlay = readSrcFile('13c-overlay-routes.js');
  assert.match(functionBlock(overlay, 'extractOverlayZip'), /-EncodedCommand/);
  assert.match(functionBlock(overlay, 'extractOverlayZip'), /'-ExecutionPolicy', 'Bypass'/, '解压子进程可加载 Archive 脚本模块');
  assert.match(functionBlock(overlay, 'runOverlayPs1'), /decodeConsoleText\(/);
  assert.match(functionBlock(readSrcFile('13-http-router.js'), 'processCommandLine'), /decodeConsoleText\(stdout\)/);
});

test('[E6] 前导的形状:同一行放在 $ProgressPreference 之前;无 BOM 编码;豁免脚本不加;shell_start 两种形态都带', () => {
  const code = [
    constBlock(source, 'PS_UTF8_OUTPUT_PREAMBLE'),
    functionBlock(readSrcFile('04-desktop-shell.js'), 'withQuietProgress'),
    '({ PS_UTF8_OUTPUT_PREAMBLE, withQuietProgress })',
  ].join('\n');
  const { PS_UTF8_OUTPUT_PREAMBLE: pre, withQuietProgress } = vm.runInNewContext(code);
  assert.ok(pre.length > 40 && !/[\r\n]/.test(pre), '前导非空且是单行');
  assert.match(pre, /\[Text\.UTF8Encoding\]::new\(\$false\)/, '必须是无 BOM 的 UTF8Encoding($false)');
  assert.ok(!/\[Text\.Encoding\]::UTF8/.test(pre), '[Text.Encoding]::UTF8 带 BOM,会污染首行');
  assert.match(pre, /^try\{.*\}catch\{\};/, '设置失败要被 try/catch 吞掉(退回修前行为,不让脚本因此报错)');
  assert.match(pre, /\$OutputEncoding=\[Console\]::OutputEncoding;$/);
  assert.ok(!/ProgressPreference/.test(pre), '前导里不碰 ProgressPreference(S8 的 doesNotMatch 靠它判「豁免脚本没被前置语句」)');

  const out = withQuietProgress('Write-Output hi');
  assert.equal(out, pre + "$ProgressPreference='SilentlyContinue'; Write-Output hi", '前导 + 静音进度条同一行');
  const multi = withQuietProgress('Write-Output 1\nWrite-Output 2');
  assert.equal(multi.split('\n').length, 2, '不加换行:用户脚本的行号不漂');
  for (const exempt of ['param($x)\nWrite-Output $x', 'using namespace System\nWrite-Output 1', '#requires -Version 5\nWrite-Output 1',
    '<#\n.SYNOPSIS\n help\n#>\n[CmdletBinding()]\nparam($x)\nWrite-Output $x']) {
    assert.equal(withQuietProgress(exempt), exempt, '第一条语句必须是 param/using/#requires/[CmdletBinding] 的脚本一个字都不能动');
  }

  // shell_start:后台命令的 -EncodedCommand 脚本头 / 交互式的 -NoExit -Command 都带前导。
  const shell = functionBlock(readSrcFile('11-native-tools.js'), 'shellStart');
  assert.match(shell, /const script = PS_UTF8_OUTPUT_PREAMBLE \+ "\$ErrorActionPreference = 'Stop'\\n/, '后台命令:前导接在第一行同一行,不加换行');
  assert.match(shell, /launchArgs\.push\('-NoExit', '-Command', PS_UTF8_OUTPUT_PREAMBLE\)/, '交互式:-NoExit -Command 前导');
  assert.match(shell, /launchArgs\.push\('-NonInteractive'\)/, '管道输入绕过 PSReadLine,交给 ConsoleHost 执行');
  assert.ok(!/-NoExit['"],\s*['"]-EncodedCommand/.test(shell), '交互式不能用 -EncodedCommand(会往 stderr 写 CLIXML 进度对象)');
});

const havePowerShell = process.platform === 'win32' && (() => {
  try { return cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, timeout: 30000 }).status === 0; } catch { return false; }
})();

test('[E5] 源头编码:powershell_run / script_run / shell_start 的中文输出与中文文件名不再变成 ?', { skip: havePowerShell ? false : '仅 Windows 且有 powershell.exe' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-console-enc-'));
  process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(root, 'data');
  process.env.RUYI_HOME = path.join(root, 'data');
  const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const fileName = '如意中文名-测试文件.txt';
  fs.writeFileSync(path.join(ws, fileName), 'x');
  const ctx = () => ({ config: { permissionMode: 'default' }, session: { id: 's', cwd: ws } });
  // 脚本自带中文字面量(UTF-8 + BOM 落盘,PS 按 UTF-8 读,输入侧没问题);输出走五条路:
  // Write-Output / Write-Host / 列目录(中文文件名)/ 原生 cmd(它按控制台代码页写)/ stderr。
  const script = [
    "Write-Output '中文输出'",
    "Write-Host '宿主输出'",
    'Get-ChildItem -Name',
    'cmd /c dir /b',
    "[Console]::Error.WriteLine('错误输出')",
  ].join('\n');
  const check = (label, out, err) => {
    const all = String(out) + '\n' + String(err);
    for (const want of ['中文输出', '宿主输出']) assert.ok(String(out).includes(want), `${label}: stdout 缺 ${want};got ${JSON.stringify(out)}`);
    assert.ok(String(err).includes('错误输出'), `${label}: stderr 缺 错误输出;got ${JSON.stringify(err)}`);
    const withName = String(out).split('\n').filter(l => l.includes(fileName)).length;
    assert.ok(withName >= 2, `${label}: Get-ChildItem 与 cmd dir 都应列出中文文件名(出现 ${withName} 次);got ${JSON.stringify(out)}`);
    assert.ok(!all.includes('?'), `${label}: 输出里不应有 ?(代码页有损编码的痕迹);got ${JSON.stringify(all)}`);
    assert.ok(!all.includes('�'), `${label}: 输出里不应有替换符;got ${JSON.stringify(all)}`);
  };
  try {
    const rp = await srv.toolCall('powershell_run', { command: script, cwd: ws }, ctx());
    assert.equal(rp.ok, true, 'powershell_run: ' + JSON.stringify(rp).slice(0, 400));
    check('powershell_run', rp.stdout, rp.stderr);

    const rs = await srv.toolCall('script_run', { language: 'powershell', code: script, cwd: ws }, ctx());
    assert.equal(rs.ok, true, 'script_run: ' + JSON.stringify(rs).slice(0, 400));
    check('script_run', rs.stdout, rs.stderr);

    // shell_start 的后台命令:两条流合在一个 output 里。
    const st = await srv.toolCall('shell_start', { command: script, shellId: 'e5enc', cwd: ws }, ctx());
    assert.equal(st.ok, true, 'shell_start: ' + JSON.stringify(st).slice(0, 400));
    let poll;
    for (let i = 0; i < 100; i++) {
      poll = await srv.toolCall('shell_poll', { shellId: 'e5enc' }, ctx());
      if (poll.running === false) break;
      await new Promise(r => setTimeout(r, 300));
    }
    assert.equal(poll.running, false, 'shell_start 的后台命令应已结束: ' + JSON.stringify(poll).slice(0, 400));
    check('shell_start', poll.output, poll.output);

    // 交互式 shell(shell_start 不带 command → -NoExit -Command 前导,再读 stdin):输入侧中文已由 shellInputForPowerShell 转成 ASCII,
    // 这里验的是输出侧。stderr 与 stdout 合在 output 里,提示符里的路径是纯 ASCII。
    const si = await srv.toolCall('shell_start', { shellId: 'e5int', cwd: ws }, ctx());
    assert.equal(si.ok, true, 'shell_start(interactive): ' + JSON.stringify(si).slice(0, 400));
    const sent = await srv.toolCall('shell_send', { shellId: 'e5int', input: script }, ctx());
    assert.equal(sent.ok, true, 'shell_send: ' + JSON.stringify(sent).slice(0, 400));
    let seen = String(sent.output || '');
    for (let i = 0; i < 50 && !seen.includes('错误输出'); i++) {
      await new Promise(r => setTimeout(r, 300));
      const more = await srv.toolCall('shell_poll', { shellId: 'e5int', cursor: 0 }, ctx());
      seen = String(more.output || '');
    }
    check('shell_send(interactive)', seen, seen);
  } finally {
    try { await srv.toolCall('shell_kill', { shellId: 'e5int' }, ctx()); } catch { /* 已结束 */ }
    try { await srv.toolCall('shell_kill', { shellId: 'e5enc' }, ctx()); } catch { /* 已结束 */ }
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  }
});
