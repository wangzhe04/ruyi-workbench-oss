'use strict';
// 安全审计修复 F(ReDoS):file_search 的 JS 扫描路径把模型给的正则放进 worker 里跑,有时间预算。
// 修前逐行同步 re.test —— 一条灾难回溯的行就把整个服务的事件循环冻住(审计实测 81 s)。
// 模式里带前瞻 (?=$):ripgrep(Rust regex)不支持环视会拒掉它、退到 JS 路径;机器上没有 rg 时本来就走 JS 路径。
// 于是不论 CI 机上有没有随包 rg,这里测到的都是 JS 路径。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-file-search-redos-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(root, 'data');
process.env.RUYI_HOME = path.join(root, 'data');
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

test('[F] 灾难回溯的正则不冻住事件循环,撞时间预算后如实标注结果可能不全', async () => {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'plain line\n' + 'a'.repeat(27) + 'b\n');
  const ctx = { config: { permissionMode: 'default' }, session: { id: 's', cwd: ws } };
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 25);
  const t0 = Date.now();
  const r = await srv.toolCall('file_search', { root: ws, pattern: '(a+)+(?=$)', regexTimeoutMs: 400 }, ctx);
  const ms = Date.now() - t0;
  clearInterval(iv);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.ok(ms < 3000, `file_search returned within the budget (took ${ms} ms)`);
  assert.ok(ticks >= 5, `event loop kept running during the search (ticks=${ticks})`);
  assert.equal(r.truncated, true, 'timed-out search is flagged truncated');
  assert.ok(/time budget/.test(String(r.patternNote || '')), 'patternNote explains the timeout: ' + r.patternNote);
});

test('[F] 正常正则照常命中(含上下文行),顺序与形状不变', async () => {
  const ws = path.join(root, 'ws2');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'b.txt'), 'one\nfoo bar\nthree\n');
  const ctx = { config: { permissionMode: 'default' }, session: { id: 's', cwd: ws } };
  // (?=\s) 迫使走 JS 路径(rg 拒环视)。
  const r = await srv.toolCall('file_search', { root: ws, pattern: 'foo(?=\\s)', context: 1 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].line, 2);
  assert.equal(r.matches[0].text, 'foo bar');
  assert.deepEqual(r.matches[0].context.map(c => c.line), [1, 2, 3]);
  assert.equal(r.truncated, undefined);
});
