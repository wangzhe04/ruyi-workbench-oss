'use strict';
// Unit(走查 W1·F11):quoteWinArg 必须过 cmd.exe 与目标进程 C 运行时【两层】解析。
//   [Q1] 修前就成立的形状不变:无特殊字符原样、含空格/元字符加引号、`"` → `""`、空串 → `""`。
//   [Q2] CRT 层:`C:\My Docs\` 这类含空格且以反斜杠结尾的参数,结尾反斜杠加倍(否则收尾引号被当成转义引号吞掉)。
//   [Q3] CRT 层:引号前的反斜杠串加倍 —— JSON.stringify 的 `\"`(--agents 里角色 prompt 带双引号)经 .cmd 垫片
//        不再被劈成多个参数;按 UCRT 规则在测试里模拟解析,往返还原为同一个参数。
//   [Q4] cmd 层:每个 `"` 都成对出现,^ & | < > ( ) 在 cmd 眼里始终处于引号态内(不会被当成命令分隔/重定向)。
//   [Q5] 随机往返(种子固定):任意由 空格 " \ & ^ | ( ) < > 字母 拼成的参数,两层都对;长反斜杠串线性时间(无回溯正则)。
//   [Q6] 仅 Windows:真起 cmd.exe /d /s /c 经 .cmd 垫片把参数交给 node,argv 与原参数逐字相等。
// 没有 Windows 实机时,Q2-Q5 靠下面的 UCRT / cmd 解析模拟器钉规则;Q6 在 Windows CI 上兜真实行为。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-win-cmdline-unit-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { quoteWinArg, batchSafeSpawn } = srv;
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

// UCRT parse_command_line 的参数部分(MSVCRT 2008+ / Node / CPython 同规则):
//   2N 个反斜杠 + " → N 个反斜杠,引号态翻转;但引号态内 " 后紧跟 " 时,这一对只出一个字面 "(留在引号态);
//   2N+1 个反斜杠 + " → N 个反斜杠 + 字面 ";其余反斜杠原样;引号态外的空白切分参数。
function crtSplit(line) {
  const args = [];
  let cur = '', has = false, inQuotes = false, i = 0;
  while (i < line.length) {
    let bs = 0;
    while (line[i] === '\\') { bs++; i++; }
    if (line[i] === '"') {
      cur += '\\'.repeat(bs >> 1); has = true;
      if (bs % 2 === 1) { cur += '"'; i++; }
      else if (inQuotes && line[i + 1] === '"') { cur += '"'; i += 2; }
      else { inQuotes = !inQuotes; i++; }
      continue;
    }
    if (bs) { cur += '\\'.repeat(bs); has = true; }
    if (i >= line.length) break;
    const ch = line[i++];
    if (!inQuotes && (ch === ' ' || ch === '\t')) { if (has) { args.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) args.push(cur);
  return args;
}
// cmd.exe 的引号态:只认 " 切换;引号态外的 & | < > ^ ( ) 才有语法含义。返回暴露在引号外的元字符与收尾的引号态。
function cmdExposure(line) {
  let inQuotes = false;
  const exposed = [];
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && '&|<>^()'.includes(ch)) exposed.push(ch);
  }
  return { exposed, balanced: !inQuotes };
}
// 把一组参数拼成 .cmd 垫片收到的那一行(batchSafeSpawn 的 join 同款,不含 cmd /c 外壳),再按两层规则解析回来。
function roundTrip(args) {
  const line = args.map(quoteWinArg).join(' ');
  return { line, parsed: crtSplit(line), cmd: cmdExposure(line) };
}
function assertBothLayers(args, label) {
  const { line, parsed, cmd } = roundTrip(args);
  assert.deepEqual(parsed, args, `${label}: CRT 层往返应还原为同一组参数(行: ${line})`);
  assert.deepEqual(cmd.exposed, [], `${label}: cmd 层不应有暴露在引号外的元字符(行: ${line})`);
  assert.equal(cmd.balanced, true, `${label}: cmd 层引号应成对(行: ${line})`);
}

test('[Q1] 修前就成立的形状不变', () => {
  assert.equal(quoteWinArg('plain'), 'plain');
  assert.equal(quoteWinArg('--flag=1'), '--flag=1');
  assert.equal(quoteWinArg('C:\\dir\\sub'), 'C:\\dir\\sub', '无空格、无引号的反斜杠路径原样(反斜杠后面没有引号,CRT 不转义)');
  assert.equal(quoteWinArg('C:\\dir\\'), 'C:\\dir\\', '不加引号的参数结尾反斜杠不动(没有收尾引号可吞)');
  assert.equal(quoteWinArg(''), '""');
  assert.equal(quoteWinArg('a b'), '"a b"');
  assert.equal(quoteWinArg('a&b'), '"a&b"');
  assert.equal(quoteWinArg('say "hi"'), '"say ""hi"""');
  assert.equal(quoteWinArg(42), '42');
});

test('[Q2] 含空格且以反斜杠结尾的参数:结尾反斜杠加倍', () => {
  assert.equal(quoteWinArg('C:\\My Docs\\'), '"C:\\My Docs\\\\"');
  assert.equal(quoteWinArg('C:\\My Docs\\\\'), '"C:\\My Docs\\\\\\\\"');
  assertBothLayers(['C:\\My Docs\\', '--add-dir', 'D:\\a b\\c d\\'], 'Q2 路径');
  // 修前的形状:收尾 `\"` 被 CRT 当成转义引号,参数吞掉引号并和后面的参数粘在一起
  const old = args => crtSplit(args.map(a => (/[\s"^&|<>()%!]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a)).join(' '));
  assert.notDeepEqual(old(['C:\\My Docs\\', '--next']), ['C:\\My Docs\\', '--next'], '模拟器能复现修前的坏形状(自检:不是在断言一个怎么写都过的东西)');
});

test('[Q3] 引号前的反斜杠串加倍:JSON 里的 \\" 往返还原(--agents 带双引号的角色 prompt)', () => {
  assert.equal(quoteWinArg('a\\"b c'), '"a\\\\""b c"', '1 个反斜杠 + 引号 → 2 个反斜杠 + ""');
  assert.equal(quoteWinArg('a\\\\"b c'), '"a\\\\\\\\""b c"', '2 个反斜杠 + 引号 → 4 个反斜杠 + ""');
  const agents = {
    reviewer: { description: 'Code "reviewer"', prompt: 'Say "hello world" and quote \\"nested\\" text; path C:\\Users\\Some User\\ and trailing \\' },
    planner: { description: 'plan & (act) | ^caret^', prompt: 'line1 "a b"\\\\"c d"' },
  };
  const json = JSON.stringify(agents);
  assert.ok(json.includes('\\"'), '前提:JSON 里确有 \\" 序列');
  const args = ['-p', '--output-format', 'stream-json', '--agents', json, '--add-dir', 'C:\\My Docs\\'];
  assertBothLayers(args, 'Q3 --agents');
  assert.equal(JSON.parse(roundTrip(args).parsed[4]).reviewer.prompt, agents.reviewer.prompt, '解析回来的 --agents 仍是同一份合法 JSON');
});

test('[Q4] cmd 层:每个引号成对,元字符始终在引号态内', () => {
  for (const a of ['a&b', 'a|b c', 'x^y', '(paren) z', 'a<b>c d', 'say "a & b" now', '"', '""', '"&"', 'x\\"&\\"y']) assertBothLayers([a], 'Q4 ' + JSON.stringify(a));
  assertBothLayers(['a&b', 'c d', '"q"', 'e\\'], 'Q4 组合');
});

test('[Q5] 随机往返(种子固定)与线性时间', () => {
  let seed = 0x5eed1234;
  const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = ['a', 'b', ' ', '"', '\\', '\\', '&', '^', '|', '(', ')', '<', '>', '{', ':', ','];
  for (let n = 0; n < 4000; n++) {
    const args = [];
    for (let k = 1 + rnd(3); k > 0; k--) {
      let s = '';
      for (let len = rnd(14); len > 0; len--) s += alphabet[rnd(alphabet.length)];
      args.push(s);
    }
    assertBothLayers(args, 'Q5 #' + n + ' ' + JSON.stringify(args));
  }
  const t0 = Date.now();
  const long = '\\'.repeat(300000) + ' x';
  assert.equal(quoteWinArg(long).length, 2 + 300000 + 2, '无引号时反斜杠串原样,只加首尾引号');
  assert.equal(quoteWinArg('a b' + '\\'.repeat(300000)).length, 2 + 3 + 600000, '收尾反斜杠串整体加倍');
  assert.ok(Date.now() - t0 < 2000, `超长反斜杠串应线性完成(耗时 ${Date.now() - t0}ms)`);
});

test('[Q6] 仅 Windows:经 cmd.exe /d /s /c + .cmd 垫片,node 收到的 argv 与原参数逐字相等', { skip: process.platform !== 'win32' }, () => {
  const dir = path.join(root, 'shim dir');
  fs.mkdirSync(dir, { recursive: true });
  const echo = path.join(dir, 'echo-argv.js');
  fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const shim = path.join(dir, 'fake claude.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
  const agentsJson = JSON.stringify({ r: { description: 'Code "reviewer"', prompt: 'Say "hello world" and \\"nested\\" & more | text ^ (x)' } });
  const args = ['-p', 'C:\\My Docs\\', agentsJson, 'say "a & b" now', 'tail\\', 'x\\\\"y z', '', 'plain'];
  const sp = batchSafeSpawn(shim, args);
  const r = cp.spawnSync(sp.command, sp.args, { ...sp.opts, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `cmd 退出码(stderr: ${r.stderr})`);
  assert.deepEqual(JSON.parse(r.stdout), args);
});
