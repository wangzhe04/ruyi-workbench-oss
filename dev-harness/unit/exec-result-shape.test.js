'use strict';
// 进程类工具的结果形状与兜底(审计 NE-1..5、NE-13)。用 node 子进程当被测程序,Linux/Windows 都能跑;
// PowerShell 相关的用例用 PATH 上的假 powershell.exe(仅非 Windows,Windows 上有真的)。
//   [S1] 大输出:头+尾+省略标记,stderr/退出码在 stdout 之前、整体远低于 60K(修前:60K 平切把 stderr 与尾部整块丢掉)
//   [S2] `\r` 覆盖式进度条折叠成最终一行
//   [S3] 一次性运行的 stdin 是 EOF,不是永不关闭的管道
//   [S4] 主进程退出后,占着管道的脱离孙进程不再拖住工具调用
//   [S5] timeoutMs 非数字用默认值;超时结果带 error / hint / 部分输出
//   [S6] cwd 不存在 → 「工作目录不存在」,不是 spawn ENOENT
//   [S7] python:UTF-8 环境变量
//   [S8] PowerShell 一次性运行带 -NonInteractive 与静音进度条(假 powershell.exe)
//   [S9] shell_poll:状态字段在前、输出封顶、可分页、waitMs 长轮询;后台任务主进程退出后即 running:false
//   [S10] shell_poll waitMs 长轮询可被用户插话(mode:interrupt)打断 —— 修前要等满 waitMs(≤30s)
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-exec-shape-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(root, 'data');
process.env.RUYI_HOME = path.join(root, 'data');
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });
const ctx = () => ({ config: { permissionMode: 'default' }, session: { id: 's', cwd: ws } });
const run = (language, code, extra = {}) => srv.toolCall('script_run', { language, code, cwd: ws, ...extra }, ctx());
const keyIdx = (o, k) => Object.keys(o).indexOf(k);

// 假 powershell.exe:行为由 FAKE_PS_MODE 决定(shellStart 会把 process.env 传给子进程)。
const fakeBin = path.join(root, 'bin');
fs.mkdirSync(fakeBin, { recursive: true });
const FAKE_PS = `#!${process.execPath}
const cp = require('child_process'), fs = require('fs');
const argv = process.argv.slice(2);
const mode = process.env.FAKE_PS_MODE || 'argv';
if (mode === 'argv') {
  const fi = argv.indexOf('-File');
  console.log(JSON.stringify({ argv, script: fi >= 0 ? fs.readFileSync(argv[fi + 1], 'utf8') : '' }));
} else if (mode === 'big') {
  process.stdout.write('HEAD-MARK\\n');
  for (let i = 0; i < 3500; i++) process.stdout.write('line ' + i + ' ' + 'x'.repeat(40) + '\\n');
  process.stdout.write('TAIL-MARK\\n');
} else if (mode === 'slow') {
  setTimeout(() => console.log('line1'), 200);
  setTimeout(() => console.log('line2'), 1200);
  setTimeout(() => process.exit(0), 1600);
} else if (mode === 'quiet') {
  setTimeout(() => {}, 60000);
} else if (mode === 'daemon') {
  cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
  console.log('main done');
}
`;
const fakePsPath = path.join(fakeBin, 'powershell.exe');
const skipFake = process.platform === 'win32' ? 'Windows 上有真 powershell.exe,假件只在非 Windows 装' : false;
if (!skipFake) {
  fs.writeFileSync(fakePsPath, FAKE_PS);
  fs.chmodSync(fakePsPath, 0o755);
  process.env.PATH = fakeBin + path.delimiter + process.env.PATH;
}
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

test('[S1] 大 stdout + 末尾 stderr:结果头+尾,stderr 与退出码在 stdout 之前,整体远低于 60K', async () => {
  const code = "for (let i = 1; i <= 5000; i++) console.log('compiling module ' + i);\nconsole.error('ERR-MARK build failed at link step');\nprocess.exitCode = 2;";
  const r = await run('node', code);
  const json = JSON.stringify(r);
  assert.ok(json.length < 50000, `result JSON ${json.length} chars must stay well under the 60K model cap`);
  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ERR-MARK/);
  assert.match(r.stdout, /compiling module 5000/, '尾部(构建报错所在处)必须在');
  assert.match(r.stdout, /compiling module 1\n/, '开头也在');
  assert.match(r.stdout, /已省略 \d+ 字符/);
  assert.ok(r.stdoutOmitted > 1000, 'stdoutOmitted count: ' + r.stdoutOmitted);
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
  assert.match(String(r.error), /退出码 2/);
  for (const k of ['ok', 'code', 'timedOut', 'stderr']) assert.ok(keyIdx(r, k) >= 0 && keyIdx(r, k) < keyIdx(r, 'stdout'), `${k} before stdout`);
  // 即使下游再从头平切 60K,前面的状态字段和 stderr 也都还在
  assert.match(json.slice(0, 60000), /ERR-MARK/);
});

test('[S1] 小输出原样不变(无省略字段)', async () => {
  const r = await run('node', "console.log('hello'); console.error('warn');");
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'hello\n');
  assert.equal(r.stderr, 'warn\n');
  assert.equal(r.stdoutOmitted, undefined);
  assert.equal(r.error, undefined);
});

test('[S2] `\\r` 进度条折叠成最终一行', async () => {
  const code = "for (let i = 1; i < 2000; i++) process.stdout.write('step ' + i + '/2000\\r');\nprocess.stdout.write('step 2000/2000\\n');\nconsole.log('done');";
  const r = await run('node', code);
  assert.equal(r.stdout, 'step 2000/2000\ndone\n');
});

test('[S3] 一次性运行的 stdin 是 EOF:读 stdin 的程序立刻返回而不是挂到超时', async () => {
  const code = "let n = 0; process.stdin.on('data', d => { n += d.length; }); process.stdin.on('end', () => { console.log('eof bytes=' + n); });";
  const t0 = Date.now();
  const r = await run('node', code, { timeoutMs: 4000 });
  assert.equal(r.timedOut, false, JSON.stringify(r).slice(0, 300));
  assert.equal(r.ok, true);
  assert.match(r.stdout, /eof bytes=0/);
  assert.ok(Date.now() - t0 < 3500, 'returned promptly');
});

test('[S4] 主进程退出后,占着输出管道的脱离孙进程不拖住工具调用', async () => {
  const code = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},7000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();\nconsole.log('main finished');";
  const t0 = Date.now();
  const r = await run('node', code, { timeoutMs: 60000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 3500, `returned in ${ms}ms (main exits at ~50ms; the grandchild lives 7s)`);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /main finished/);
  assert.match(String(r.note || ''), /后台子进程/);
});

test('[S5] timeoutMs 非数字:分发层按 schema 拒并点名字段;非正数用默认值,不再 9ms 就被杀', async () => {
  // 'abc' 在 toolCall 的参数校验处就被拦下(可操作的纠错信息),根本到不了 runProcess。
  const bad = await run('node', "console.log('never');", { timeoutMs: 'abc' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid-arguments');
  assert.match(String(bad.error), /timeoutMs/);
  // 数值型的坏值(0 / 负数)能过校验,由 runProcess 自己兜成默认超时,而不是立刻杀掉。
  for (const t of [0, -5]) {
    const r = await run('node', "setTimeout(() => console.log('alive'), 1500);", { timeoutMs: t });
    assert.equal(r.timedOut, false, JSON.stringify(r).slice(0, 300));
    assert.equal(r.ok, true);
    assert.match(r.stdout, /alive/);
  }
});

test('[S5] 超时结果:error + hint + 已产生的部分输出', async () => {
  const r = await run('node', "console.log('partial'); setTimeout(() => {}, 30000);", { timeoutMs: 1200 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(String(r.error), /超过 1200ms/);
  assert.match(String(r.hint), /shell_start/);
  assert.match(r.stdout, /partial/);
  assert.match(r.stderr, /timed out/);
});

test('[S6] cwd 不存在:明说「工作目录不存在」,不是 spawn ENOENT', async () => {
  const bad = path.join(root, 'no-such-dir');
  for (const [tool, args] of [['script_run', { language: 'node', code: 'console.log(1)' }], ['powershell_run', { command: 'echo 1' }]]) {
    const r = await srv.toolCall(tool, { ...args, cwd: bad }, ctx());
    assert.equal(r.ok, false, tool);
    assert.match(String(r.error), /工作目录不存在/, tool + ': ' + JSON.stringify(r).slice(0, 200));
    assert.ok(String(r.error).includes(bad), tool);
    assert.ok(!/ENOENT/.test(JSON.stringify(r)), tool + ' must not surface a bare spawn ENOENT');
  }
});

const havePython = (() => { try { return cp.spawnSync(process.platform === 'win32' ? 'py' : 'python', process.platform === 'win32' ? ['-3', '--version'] : ['--version']).status === 0; } catch { return false; } })();
test('[S7] python 子进程环境:PYTHONUTF8=1 / PYTHONIOENCODING=utf-8', { skip: havePython ? false : '本机没有 python' }, async () => {
  const r = await run('python', "import os, sys\nprint(os.environ.get('PYTHONUTF8'), os.environ.get('PYTHONIOENCODING'), sys.flags.utf8_mode)\nprint('\\u2713 ok')");
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.match(r.stdout, /1 utf-8 1/);
  assert.match(r.stdout, /✓ ok/);
});

test('[S8] PowerShell 一次性运行:-NonInteractive,脚本头静音进度条(powershell_run 与 script_run)', { skip: skipFake }, async () => {
  process.env.FAKE_PS_MODE = 'argv';
  for (const [tool, args] of [['powershell_run', { command: 'Write-Output hi' }], ['script_run', { language: 'powershell', code: 'Write-Output hi' }]]) {
    const r = await srv.toolCall(tool, { ...args, cwd: ws }, ctx());
    assert.equal(r.ok, true, tool + ': ' + JSON.stringify(r).slice(0, 300));
    const seen = JSON.parse(r.stdout);
    assert.ok(seen.argv.includes('-NonInteractive'), tool + ' argv: ' + seen.argv.join(' '));
    assert.ok(seen.argv.indexOf('-NonInteractive') < seen.argv.indexOf('-File'), tool);
    assert.match(seen.script, /\$ProgressPreference='SilentlyContinue'; Write-Output hi/, tool);
    // 2026-10:UTF-8 输出编码前导在 $ProgressPreference 之前、同一行(脚本以 UTF-8 BOM 开头)。console-output-decoding [E5] 在真 PowerShell 上验效果。
    assert.match(seen.script, /^﻿?try\{\[Console\]::OutputEncoding=\[Text\.UTF8Encoding\]::new\(\$false\)\}catch\{\};\$OutputEncoding=\[Console\]::OutputEncoding;\$ProgressPreference='SilentlyContinue'; Write-Output hi$/, tool);
  }
  // param()/using 开头的脚本不能被前置语句破坏
  const r2 = await srv.toolCall('script_run', { language: 'powershell', code: 'param($x)\nWrite-Output $x', cwd: ws }, ctx());
  assert.doesNotMatch(JSON.parse(r2.stdout).script, /ProgressPreference|OutputEncoding/);
  const r3 = await srv.toolCall('script_run', { language: 'powershell', code: '<#\n.SYNOPSIS\n help\n#>\n[CmdletBinding()]\nparam($x)\nWrite-Output $x', cwd: ws }, ctx());
  assert.doesNotMatch(JSON.parse(r3.stdout).script, /ProgressPreference|OutputEncoding/, '帮助注释在前、param 在后也不能前置语句');
});

async function startJob(mode, shellId) {
  process.env.FAKE_PS_MODE = mode;
  const r = await srv.toolCall('shell_start', { command: 'fake', shellId, cwd: ws }, ctx());
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}
const poll = (args) => srv.toolCall('shell_poll', args, ctx());

test('[S9] shell_poll:状态字段在前、输出封顶(头+尾)、可用 cursor 分页读回中间', { skip: skipFake }, async () => {
  await startJob('big', 'big1');
  let r;
  for (let i = 0; i < 40; i++) { r = await poll({ shellId: 'big1' }); if (r.running === false) break; await new Promise(res => setTimeout(res, 150)); }
  assert.equal(r.running, false, JSON.stringify(r).slice(0, 300));
  assert.equal(r.exitCode, 0);
  const json = JSON.stringify(r);
  assert.ok(json.length < 40000, 'poll JSON ' + json.length);
  const keys = Object.keys(r);
  assert.deepEqual(keys.slice(0, 4), ['ok', 'running', 'exitCode', 'timedOut']);
  assert.ok(keyIdx(r, 'cursor') < keyIdx(r, 'output') && keys[keys.length - 1] === 'output', 'output is last');
  assert.match(r.output, /HEAD-MARK/);
  assert.match(r.output, /TAIL-MARK/);
  assert.ok(r.omittedChars > 100000 && Number.isInteger(r.omittedFrom) && r.omittedTo > r.omittedFrom, JSON.stringify({ o: r.omittedChars, f: r.omittedFrom, t: r.omittedTo }));
  assert.equal(r.omittedTo - r.omittedFrom, r.omittedChars);
  // 分页读回:cursor=omittedFrom,页大小 1000
  const page = await poll({ shellId: 'big1', cursor: r.omittedFrom, maxChars: 1000 });
  assert.equal(page.more, true);
  assert.equal(page.output.length, 1000);
  assert.equal(page.cursor, r.omittedFrom + 1000);
  const page2 = await poll({ shellId: 'big1', cursor: page.cursor, maxChars: 1000 });
  assert.ok(page2.output.length === 1000 && page2.cursor === page.cursor + 1000, '连续翻页不丢不重');
  await srv.toolCall('shell_kill', { shellId: 'big1' }, ctx());
});

test('[S9] shell_poll waitMs:有新输出或进程退出就提前返回', { skip: skipFake }, async () => {
  await startJob('slow', 'slow1');
  const t0 = Date.now();
  const a = await poll({ shellId: 'slow1', waitMs: 8000 });
  assert.match(a.output, /line1/, JSON.stringify(a));
  assert.equal(a.running, true);
  assert.ok(Date.now() - t0 < 4000, 'returned on first output, not after the full wait');
  const b = await poll({ shellId: 'slow1', cursor: a.cursor, waitMs: 8000 });
  assert.match(b.output, /line2/, JSON.stringify(b));
  assert.ok(!/line1/.test(b.output), '续读不重复');
  const c = await poll({ shellId: 'slow1', cursor: b.cursor, waitMs: 8000 });
  assert.equal(c.running, false, JSON.stringify(c));
  assert.equal(c.exitCode, 0);
  await srv.toolCall('shell_kill', { shellId: 'slow1' }, ctx());
});

test('[S9] 后台任务:主进程退出、孙进程占着管道 → 及时 running:false(不永久占名额)', { skip: skipFake }, async () => {
  await startJob('daemon', 'dm1');
  let r;
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) { r = await poll({ shellId: 'dm1' }); if (r.running === false) break; await new Promise(res => setTimeout(res, 150)); }
  assert.equal(r.running, false, 'still running after ' + (Date.now() - t0) + 'ms: ' + JSON.stringify(r).slice(0, 300));
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /main done/);
  const list = await srv.toolCall('shell_list', {}, ctx());
  assert.ok(list.shells.some(s => s.shellId === 'dm1' && s.running === false));
  const k = await srv.toolCall('shell_kill', { shellId: 'dm1' }, ctx());
  assert.equal(k.ok, true, '退出的会话可回收');
});

test('[S10] shell_poll {waitMs:30000} 被插话打断:下一轮模型请求在秒级到达,不是等满 30 秒', { skip: skipFake }, async () => {
  const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('../lib/fake-openai-provider');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fake = await startFakeProvider({
    handler(req) {
      if (!req.stream || /起名字/.test(JSON.stringify(req.messages))) return textFrames('{"title":"t","gist":"g"}');
      const tools = req.messages.filter(m => m.role === 'tool').length;
      if (tools === 0) { process.env.FAKE_PS_MODE = 'quiet'; return toolCallFrames('shell_start', { command: 'fake', shellId: 'q10', cwd: ws }, 'call_start'); }
      if (tools === 1) return toolCallFrames('shell_poll', { shellId: 'q10', waitMs: 30000 }, 'call_poll');
      return [...textFrames('done'), usageFrame(8, 4)];
    },
  });
  try {
    fs.writeFileSync(path.join(root, 'data', 'config.json'), JSON.stringify({
      configSchema: 9, permissionMode: 'bypass', defaultWorkspace: ws, desktopMcp: { enabled: false },
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
      activeProvider: 'fake',
    }), 'utf8');
    const s = await srv.createSession({ title: 's10', cwd: ws });
    let pollStarted = null;
    const started = new Promise(r => { pollStarted = r; });
    const turn = srv.runSessionTurn({ sessionId: s.id, message: '等一下那个任务', cwd: ws, source: 'http',
      onEvent: e => { if (e && e.type === 'tool_use' && e.name === 'shell_poll') pollStarted(); } });
    turn.catch(() => {});
    assert.notEqual(await Promise.race([started, sleep(15000).then(() => 'timeout')]), 'timeout', '前提:shell_poll 已开始');
    await sleep(600);                                        // 让它真的进了长轮询循环
    const reg = srv.activeChildren.get(s.id);
    assert.ok(reg && typeof reg.interruptToolWait === 'function', 'shell_poll 登记了可中断的等待(修前 interruptToolWait 为 null)');
    const before = fake.requests.length;
    reg.steerQueue.push({ text: '别等了,先看一下别的', mode: 'interrupt' });
    const t0 = process.hrtime.bigint();
    reg.interruptToolWait();
    for (let i = 0; i < 250 && fake.requests.length <= before; i++) await sleep(20);
    const took = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(fake.requests.length > before, '插话之后模型的下一轮请求应在数秒内到达(修前要等满 30 s)');
    assert.ok(took < 6000, '用了 ' + took + ' ms');
    await Promise.race([turn.catch(() => {}), sleep(10000)]);
  } finally {
    await srv.toolCall('shell_kill', { shellId: 'q10' }, ctx()).catch(() => {});
    await fake.close();
    try { fs.unlinkSync(path.join(root, 'data', 'config.json')); } catch { /* ignore */ }
  }
});
