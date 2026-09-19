// Unit(128f-⑥;Brief §4.2 第 5 条「账本即发即忘」):appendUsageLedger 是同步入口 ＋ 内部 promise 链,全仓调用点无一 await。
// 进程紧接着 process.exit()(serve 的 SIGINT／SIGTERM／未捕获异常三条收尾都走它)时,链上还没轮到的那几行就丢了。
// 修后:排队的行登记在 usageLedgerPending(queued),退出监听器里 flushUsageLedgerSync 用同步 I/O 补写 queued 的;
// 正在写的那一行(writing)不补 —— 它落没落盘不知道,补了可能记两遍(费用翻倍比少一行更糟)。
//   [L0] 修前的读数(对照):子进程追加一行后立刻 process.exit(0)、不挂补写 —— 那一行【丢了】;
//   [L1] 同样的子进程,exit 监听器里调 flushUsageLedgerSync —— 那一行在,且只有一行;
//   [L2] 进程内:连着排两行后立刻同步补写 → 补写 2 行、文件里各一行;之后链照常跑完【不重复】;
//   [L3] 正常路径:排一行、等链跑完 → 一行;此时同步补写什么都不做(返回 0);
//   [L4] 正在写的那一行不补:让链先开写(state=writing)再同步补写 → 补写 0 行,链写完后仍只有一行。
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const repo = path.resolve(__dirname, '../..');
const SERVER = path.join(repo, 'ruyi-workbench', 'app', 'server.js');
process.env.RUYI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ledger-flush-'));
const srv = require(SERVER);
const settle = () => new Promise(r => setTimeout(r, 150));
const ledgerLines = home => {
  const dir = path.join(home, 'usage');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
    .flatMap(n => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean)).map(l => JSON.parse(l));
};
const row = sid => ({ sessionId: sid, engine: 'openai', provider: 'p', model: 'm', inTok: 10, outTok: 2, kind: 'turn' });

function childExit(withFlush) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ledger-child-'));
  const script = [
    `const srv = require(${JSON.stringify(SERVER)});`,
    withFlush ? 'process.on("exit", () => srv.flushUsageLedgerSync());' : '',
    'srv.appendUsageLedger({ sessionId: "exit-probe", engine: "openai", provider: "p", model: "m", inTok: 10, outTok: 2, kind: "turn" });',
    'process.exit(0);',
  ].join('\n');
  const r = cp.spawnSync(process.execPath, ['-e', script], { env: { ...process.env, RUYI_HOME: home }, encoding: 'utf8', timeout: 60000, windowsHide: true });
  const lines = ledgerLines(home).filter(x => x.sessionId === 'exit-probe');
  fs.rmSync(home, { recursive: true, force: true });
  return { status: r.status, lines: lines.length };
}

describe('用量账本:退出路径上还没轮到的行同步补写', () => {
  it('[L0] 对照:追加后立刻 process.exit、不补写 —— 那一行丢了(修前的形状)', () => {
    const r = childExit(false);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.lines, 0, '不补写时那一行本该丢;若没丢,这件量不出修法的价值');
  });

  it('[L1] exit 监听器里同步补写 —— 那一行在,且只有一行', () => {
    const r = childExit(true);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.lines, 1);
  });

  it('[L2] 连着排两行后立刻同步补写:各一行;链跑完不重复', async () => {
    srv.appendUsageLedger(row('l2-a'));
    srv.appendUsageLedger(row('l2-b'));
    assert.strictEqual(srv.flushUsageLedgerSync(), 2);
    const now = ledgerLines(process.env.RUYI_HOME);
    assert.strictEqual(now.filter(x => x.sessionId === 'l2-a').length, 1);
    assert.strictEqual(now.filter(x => x.sessionId === 'l2-b').length, 1);
    await settle();
    const later = ledgerLines(process.env.RUYI_HOME);
    assert.strictEqual(later.filter(x => x.sessionId === 'l2-a').length, 1, '链不许再写一遍已补写的行');
    assert.strictEqual(later.filter(x => x.sessionId === 'l2-b').length, 1);
  });

  it('[L3] 正常路径:排一行、等链跑完 → 一行;此时同步补写返回 0', async () => {
    srv.appendUsageLedger(row('l3'));
    await settle();
    assert.strictEqual(srv.flushUsageLedgerSync(), 0);
    assert.strictEqual(ledgerLines(process.env.RUYI_HOME).filter(x => x.sessionId === 'l3').length, 1);
  });

  it('[L4] 正在写的那一行不补:补写 0 行,链写完后仍只有一行', async () => {
    srv.appendUsageLedger(row('l4'));
    await Promise.resolve(); await Promise.resolve();   // 让链上这一步开跑到第一个 await(state=writing)
    assert.strictEqual(srv.flushUsageLedgerSync(), 0);
    await settle();
    assert.strictEqual(ledgerLines(process.env.RUYI_HOME).filter(x => x.sessionId === 'l4').length, 1);
  });
});
