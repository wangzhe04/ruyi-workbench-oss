'use strict';
// PowerShell / 控制台输出的编码(用户实测:中文 Windows 上 shell 会话里 PowerShell 的中文输出是乱码)。
//   [E1] 按行判定:GBK 行按 GBK 解、UTF-8 行按 UTF-8 解,混在同一份输出里也各自正确
//        (修前 runProcess 整段判定 —— 有一处不是 UTF-8 就整段按 GBK,UTF-8 那部分反被解坏;shell 会话一律按 UTF-8)
//   [E2] 流式:chunk 从一个 GBK / UTF-8 汉字中间切开也不出替换符;不带换行的尾巴(提示符)flush 时吐出
//   [E3] 交互式 shell 的输入:含中文的命令改成纯 ASCII 的等价命令(UTF-8 Base64 → Invoke-Expression),纯 ASCII 原样
//   [E4] 接线:runProcess 的 decodeBestEffort、shell 会话、覆盖包解压 / 进程取证都走这一套
// 夹具里的 GBK 字节是手写的(中文 = D6 D0 CE C4,乱码 = C2 D2 C2 EB,找不到路径 = D5 D2 B2 BB B5 BD C2 B7 BE B6)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
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
  assert.match(functionBlock(overlay, 'runOverlayPs1'), /decodeConsoleText\(/);
  assert.match(functionBlock(readSrcFile('13-http-router.js'), 'processCommandLine'), /decodeConsoleText\(stdout\)/);
});
