// E2E: 第26波c —— 调度核心纯 reducer computeSchedulerStep 组合单测。
// 源抽取 + new Function 实跑(无需起服务,纯函数),穷举 retry×loop×gate×pause×crash×inflight 组合,
// 锁死 26a 三铁律 + block/skip/condition/并发/依赖门语义。技术同 audit-w23 的源抽取范式。
'use strict';
const fs = require('fs'), path = require('path');
const SERVER = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ── 源抽取 computeSchedulerStep(顶层函数,到首个 column-0 '}') ──
const m = src.match(/function computeSchedulerStep\(nodes, opts\) \{[\s\S]*?\n\}/);
ok(!!m, '源抽取 computeSchedulerStep');
if (!m) { console.log('\nSCHEDULER-REDUCER E2E: FAIL (' + fail + ')'); process.exit(1); }
const compute = new Function(m[0] + '\nreturn computeSchedulerStep;')();

// 默认 helpers:terminal 集合 + failureContinues(默认恒 false)+ evalCondition(读 node._cond 布尔)。
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'blocked', 'skipped', 'rejected']);
function step(nodes, opts = {}) {
  return compute(nodes, {
    inFlightIds: opts.inFlightIds || [],
    concurrency: opts.concurrency == null ? 2 : opts.concurrency,
    isTerminal: n => TERMINAL.has(n.status),
    failureContinues: opts.failureContinues || (() => false),
    evalCondition: opts.evalCondition || ((cond, ns, node) => node._cond !== false),
  });
}
const N = (id, status, deps, extra = {}) => ({ id, status, dependsOn: deps || [], ...extra });

// ── 1) 基本就绪与并发上限 ──
{
  const nodes = [N('a', 'queued', []), N('b', 'queued', []), N('c', 'queued', [])];
  const s = step(nodes, { concurrency: 2 });
  ok(s.toDispatch.length === 2 && s.toDispatch[0] === 'a' && s.toDispatch[1] === 'b', '1 并发上限 2 → 派发前两个(数组序)');
  ok(!s.cycleDead && !s.allTerminal, '1 有派发 → 非环非全终态');
}

// ── 2) 依赖门:未终态依赖不就绪 ──
{
  const nodes = [N('a', 'running', []), N('b', 'queued', ['a'])];
  const s = step(nodes, { inFlightIds: ['a'] });
  ok(s.toDispatch.length === 0, '2 依赖 running → 下游不派发');
  ok(!s.cycleDead, '2 有在飞(a)→ 不判环');
}

// ── 3) 铁律①判环:零派发 + 在飞空 + 未全终态 ──
{
  const nodes = [N('a', 'queued', ['x'])]; // 依赖 x 不存在 → 永不就绪
  const s = step(nodes, { inFlightIds: [] });
  ok(s.cycleDead === true, '3 悬空依赖 + 无在飞 + 未全终态 → cycleDead');
}
{
  const nodes = [N('a', 'succeeded', []), N('b', 'succeeded', [])];
  const s = step(nodes, { inFlightIds: [] });
  ok(s.allTerminal === true && s.cycleDead === false, '3 全终态 → allTerminal 且【不】判环(交外壳收尾)');
}
{
  const nodes = [N('a', 'queued', ['x'])];
  const s = step(nodes, { inFlightIds: ['other'] });
  ok(s.cycleDead === false, '3 有在飞 → 即使零派发也不判环(同步节点 fast-settle 防误诊)');
}

// ── 4) 铁律③防双派发:已在飞的就绪节点不重复派发 ──
{
  const nodes = [N('a', 'queued', []), N('b', 'queued', [])];
  const s = step(nodes, { inFlightIds: ['a'], concurrency: 2 });
  ok(!s.toDispatch.includes('a'), '4 已在飞的节点不再派发');
  ok(s.toDispatch.includes('b'), '4 其它就绪节点正常派发');
  ok(s.toDispatch.length === 1, '4 并发 2 - 在飞 1 = 1 个空位');
}

// ── 5) block 扫描:失败依赖阻塞下游(deps 全终态才判) ──
{
  const nodes = [N('a', 'failed', []), N('b', 'queued', ['a'])];
  const s = step(nodes);
  ok(s.toBlock.length === 1 && s.toBlock[0].id === 'b' && s.toBlock[0].blockers.includes('a'), '5 失败依赖 → 下游 toBlock(附 blockers)');
  ok(!s.toDispatch.includes('b'), '5 被阻塞节点不派发');
}
{
  const nodes = [N('a', 'running', []), N('b', 'queued', ['a'])];
  const s = step(nodes, { inFlightIds: ['a'] });
  ok(s.toBlock.length === 0, '5 依赖未全终态(running)→ 暂不阻塞(等它终态)');
}

// ── 6) B8:rejected/skipped 前序不算失败,不阻塞下游 ──
{
  for (const st of ['rejected', 'skipped', 'succeeded']) {
    const nodes = [N('a', st, []), N('b', 'queued', ['a'])];
    const s = step(nodes);
    ok(s.toBlock.length === 0 && s.toDispatch.includes('b'), '6 前序 ' + st + ' 不阻塞 → 下游就绪派发');
  }
}

// ── 7) failureContinues:continue 型失败不阻塞下游 ──
{
  const nodes = [N('a', 'failed', [], { failurePolicy: 'continue' }), N('b', 'queued', ['a'])];
  const s = step(nodes, { failureContinues: n => n.failurePolicy === 'continue' });
  ok(s.toBlock.length === 0 && s.toDispatch.includes('b'), '7 failureContinues=true → 失败依赖不阻塞');
}

// ── 8) condition 跳过:依赖全终态 + 条件 false → skip ──
{
  const nodes = [N('a', 'succeeded', []), N('b', 'queued', ['a'], { condition: { x: 1 }, _cond: false })];
  const s = step(nodes, { evalCondition: (c, ns, node) => node._cond !== false });
  ok(s.toSkip.length === 1 && s.toSkip[0].id === 'b', '8 条件 false → toSkip');
  ok(!s.toDispatch.includes('b'), '8 被跳过节点不派发');
}
{
  const nodes = [N('a', 'succeeded', []), N('b', 'queued', ['a'], { condition: { x: 1 }, _cond: true })];
  const s = step(nodes, { evalCondition: (c, ns, node) => node._cond !== false });
  ok(s.toSkip.length === 0 && s.toDispatch.includes('b'), '8 条件 true → 不跳过,正常派发');
}

// ── 9) retry 重排:失败后回 queued 的节点,在其旧 flight 仍在飞时不双派发(铁律③组合) ──
{
  // r 刚被重排为 queued(retry),但它的旧 flight 尾部还没 settle(仍在 inFlight)。
  const nodes = [N('r', 'queued', [], { attempts: 1, failurePolicy: 'retry' })];
  const s = step(nodes, { inFlightIds: ['r'], concurrency: 2 });
  ok(s.toDispatch.length === 0, '9 retry 重排节点旧 flight 未 settle → 本步不双派发');
  ok(s.cycleDead === false, '9 有在飞(旧 flight)→ 不误判环');
}
{
  // 旧 flight settle 后(inFlight 空),重排节点才被派发。
  const nodes = [N('r', 'queued', [], { attempts: 1 })];
  const s = step(nodes, { inFlightIds: [] });
  ok(s.toDispatch.length === 1 && s.toDispatch[0] === 'r', '9 旧 flight settle 后 → 重排节点派发');
}

// ── 10) loop 重排:succeeded→queued 回环节点,与独立就绪节点并存,并发内都派发 ──
{
  const nodes = [N('lp', 'queued', [], { loop: { maxIterations: 3 }, loopIteration: 1 }), N('ind', 'queued', [])];
  const s = step(nodes, { concurrency: 2 });
  ok(s.toDispatch.length === 2, '10 loop 重排节点 + 独立节点 → 并发内都派发');
}

// ── 11) gate 节点(vote/dedupe/quality)在 reducer 层无特殊:queued 即按就绪/依赖处理 ──
{
  const nodes = [N('a', 'succeeded', []), N('b', 'succeeded', []), N('v', 'queued', ['a', 'b'], { gate: { mode: 'vote' } })];
  const s = step(nodes);
  ok(s.toDispatch.includes('v'), '11 gate 节点依赖全终态 → 就绪派发(gate 语义在执行体,不在 reducer)');
}

// ── 12) pause 语义:reducer 不管 pause(外壳 raceInFlight 拦新派发)—— 验证 reducer 对"全在飞"返回零派发不判环 ──
{
  const nodes = [N('a', 'running', []), N('b', 'running', [])];
  const s = step(nodes, { inFlightIds: ['a', 'b'], concurrency: 2 });
  ok(s.toDispatch.length === 0 && !s.cycleDead && !s.allTerminal, '12 全在飞 → 零派发、不判环、非全终态(外壳去 race)');
}

// ── 13) crash 恢复:interrupted 若被重排为 queued 则正常就绪(reducer 只看 queued+依赖) ──
{
  const nodes = [N('a', 'succeeded', []), N('crashed', 'queued', ['a'], { attempts: 1, interruptedAttempt: 1 })];
  const s = step(nodes);
  ok(s.toDispatch.includes('crashed'), '13 崩溃恢复重排为 queued 的节点 → 依赖满足即就绪派发');
}

// ── 14) 综合链:a→b→c 线性,分步推进无环 ──
{
  let nodes = [N('a', 'queued', []), N('b', 'queued', ['a']), N('c', 'queued', ['b'])];
  let s = step(nodes, { concurrency: 3 });
  ok(s.toDispatch.length === 1 && s.toDispatch[0] === 'a', '14 线性链首步仅 a 就绪');
  nodes[0].status = 'succeeded';
  s = step(nodes, { concurrency: 3 });
  ok(s.toDispatch.length === 1 && s.toDispatch[0] === 'b', '14 a 完成 → b 就绪');
  nodes[1].status = 'succeeded';
  s = step(nodes, { concurrency: 3 });
  ok(s.toDispatch[0] === 'c', '14 b 完成 → c 就绪');
  nodes[2].status = 'succeeded';
  s = step(nodes);
  ok(s.allTerminal && !s.cycleDead && s.toDispatch.length === 0, '14 全完成 → allTerminal 无环无派发');
}

// ── 15) 纯函数不 mutate 入参 ──
{
  const nodes = [N('a', 'failed', []), N('b', 'queued', ['a'])];
  const snapshot = JSON.stringify(nodes);
  step(nodes);
  ok(JSON.stringify(nodes) === snapshot, '15 reducer 不 mutate nodes(纯函数)');
}

console.log('');
if (fail) { console.log('SCHEDULER-REDUCER E2E: FAIL (' + fail + ')'); process.exit(1); }
console.log('SCHEDULER-REDUCER E2E: ALL PASS');
