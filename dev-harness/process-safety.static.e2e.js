#!/usr/bin/env node
'use strict';
// 128c(48 号文 §1)静态锁:测试框架「只杀自己的树」与 CDP「socket 关了就当场报错」。
//
// 为什么要锁:这两件都是一百多份复制粘贴出来的写法,修一次不锁,下一个新件照抄旧写法就回来了(本仓手攒名单
// 已漏过四次)。
//   ① 任何测试件都不许再用 taskkill /T —— /T 按父进程号认子孙,父号过期撞号时会带走别人的树(F8 真杀过用户的
//      Ollama;本机 explorer.exe 的父进程就早已不在)。收尾一律 lib/kill-own-tree 的 killOwnTree(按创建时间认子孙)。
//   ② 每个自带 CDP 客户端的件,send() 在 socket.send 之前必须有 readyState 闸 —— 否则浏览器被收尸之后下一发
//      请求永远不 settle,测试挂到 run-all 超时、一条 FAIL 都没有(F8 那批「只是超时」的偶发件)。
//   ③ owner 数钉住:扫描器若失明(改名、换写法),件数先红,而不是「零命中 = 全绿」。
const fs = require('fs');
const path = require('path');
const HARNESS = __dirname;
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(HARNESS).filter(f => path.resolve(f) !== path.resolve(__filename));   // 本文件自己写着要找的字面量
const rel = f => path.relative(HARNESS, f).replace(/\\/g, '/');

// ① 调用形状:exec*/spawn*( 第一个参数就是 taskkill,且同一行里带 /T。字符串里「提到」taskkill /T 的说明文字不算。
// 第一版写成 `[^)]*`,反向验证当场逮住:真实形状里有 `String(child.pid)`,那个右括号让匹配提前停住 —— 锁对原形是瞎的。
const TASKKILL_T = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*[`'"]taskkill\b.{0,240}?\/T\b/;
const offenders = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => { if (!/^\s*\/\//.test(line) && TASKKILL_T.test(line)) offenders.push(`${rel(f)}:${i + 1}`); });
}
ok(offenders.length === 0, `① 测试框架里没有一处 taskkill /T 调用(实得 ${offenders.length}${offenders.length ? ':' + offenders.slice(0, 8).join(' ') : ''})`);

const users = files.filter(f => /require\(['"][./]*(?:lib\/)?kill-own-tree['"]\)|require\(['"]\.\.\/lib\/kill-own-tree['"]\)/.test(fs.readFileSync(f, 'utf8')));
const KILL_OWNERS = 308; // 306 -> 308:2026-10 子代理思维链 + 时限:新增 subagent-thinking-continuity.e2e 与 agent-node-limits.e2e(都 killOwnTree 收自己起的服务;browser 件走 lib/browser-fixture 不另计)。305 -> 306:2026-10 合入 fix/mem-scope。303 -> 305:2026-10 走查「记忆 B」:新增 memory-recall-injection.e2e 与 memory-subagent.e2e。302 -> 303:2026-10 子代理 Retry-After e2e。301 -> 302:2026-10 走查 W1 存储批:新增 store-walkthrough-w1.e2e(只杀自己起的工作台)。299 -> 301:2026-10 走查合并:新增 preflight-relative-write.e2e 与 file-text-encoding.e2e。298 -> 299:2026-10 走查合并:新增 settings-wave1.browser 与 provider-no-model-locale.e2e。297 -> 298:2026-10 走查合并:新增 agent-resource-wait-stop.e2e(只杀自己起的工作台)。295 -> 297:2026-10 新增 agent-wake.e2e 与 provider-compact-recall.e2e(各只杀自己起的工作台)。294 -> 295:2026-10 61-C2 新增 session-scratchpad.e2e(只杀自己起的工作台)。293 -> 294:2026-10 61-C1 新增 playbook-skill-tools.e2e(只杀自己起的工作台)。292 -> 293:2026-10 61-C3 新增 memory-batch-proposal.e2e(与 61-C4 各 +1,合并后叠加)。291 -> 292:2026-10 新增 checkpoint-visibility.e2e(只杀自己起的工作台)。290 -> 291:2026-10 新增 harness-friction.e2e(只杀自己起的工作台)。289 -> 290:2026-10 新增 acc-capability-gates.e2e(只杀自己起的工作台与 MCP 子进程)。288 -> 289:2026-10 新增 tool-invoke-promote.e2e(只杀自己起的工作台)。287 -> 288:2026-10 新增 steward-viewing-gate.e2e(只杀自己起的工作台)。286 -> 287:59 号文 §6 新增 voice-learn.e2e(只杀自己起的工作台)。285 -> 286:59 号文新增 voice-lexicon.e2e(只杀自己起的工作台)。284 -> 285:新增 tool-audit-r2-meta.e2e(只杀自己起的工作台)。283 -> 284:新增 steward-continue-unfinished.e2e(只杀自己起的工作台)。281 -> 283:新增 observation-recall-snapshot-cap.e2e 与 responses-websearch-inline.e2e(各只杀自己起的工作台)。 // 工具结果边界:新增 tool-result-bounds.e2e 与 parallel-read-island.e2e(各只杀自己起的工作台/假 provider)。 工具分发批:新增 tool-dispatch-hardening.e2e 与 audit-desktop-records.e2e(只杀自己的工作台)。 审计 A①/A② 后续:新增 claude-cli-bridged-read-guard.e2e(只杀自己的工作台)与 unit/security-audit-followups.test(只杀自己起的假 MCP)。 回合引擎审计:新增 turn-stop-supersede.e2e(只杀自己起的两台工作台)。 安全审计修复 C:新增 claude-permission-bridge-mode.e2e(只杀自己的工作台)。 压缩后重取守卫:新增 compaction-refetch-guard.e2e(只杀自己的工作台)。 perf 条件 GET:新增 session-get-etag.e2e(只杀自己的工作台)。 hunt2-turnloop added provider-turnloop-hardening.e2e (kills only its own workbench). hunt2-http added unit/http-input-hardening.test (kills only its own workbench). Added agent-run-lifecycle.e2e and session-id-path-guard.e2e (each kills only its own workbench). Added data-root-migration.e2e (kills only its own workbenches). Added anthropic-fake.e2e (kills only its own workbench). Added subagent-compaction-parity.e2e (kills only its own workbenches). Added mermaid-viewer.browser (reviewed scoped cleanup); 145-W3 added engine-env-runtime (kills only its own two workbenches + fake provider). 137x W5 added rail-tool-height.browser (own killOwnTree cleanup). 137 W1 added agent-mode-v2.e2e. 137 W2 added migration-center.e2e.
//   // codemod 250 件(含 run-all 的超时收尸)＋ kimi-acp-live-probe(手改)＋ 128e 新件 mcp-resource-config-mask ＋ 128d 公共夹具 lib/browser-fixture ＋ 128f-③ 新件 desktop-probe-status ＋ 128f-⑪ 新件 steward-deferred-permission ＋ 128f-⑬ 新件 cli-probe-stall ＋ 2026-09-21 新件 toolbox-discovery ＋ 134 新件 background-completion ＋ 133f 新件 asr-warmup ＋ 137x 新件 rail-tool-height.browser ＋ 137 新件 agent-mode-v2 ＋ 137 新件 migration-center;unit/kill-own-tree.test.js 走绝对路径不计
ok(users.length === KILL_OWNERS, `③ 用 killOwnTree 的文件数钉成 ${KILL_OWNERS}(实得 ${users.length});加减件请回来改这个数`);
const runAll = fs.readFileSync(path.join(HARNESS, 'run-all.js'), 'utf8');
ok(/killOwnTree\(child\)/.test(runAll) && !/taskkill \/F \/T/.test(runAll.replace(/\/\/.*$/gm, '')),
  '① run-all 的超时收尸走 killOwnTree(child)');

// lib 本身:认子孙必须核创建时间(行为由 unit/kill-own-tree.test.js [P1] 钉,这里钉「那一行还在」防止被顺手删掉)
const lib = fs.readFileSync(path.join(HARNESS, 'lib', 'kill-own-tree.js'), 'utf8');
ok(/r\.created < parent\.created/.test(lib), 'lib/kill-own-tree 的子孙判据里有创建时间比较');
ok(!/['"]\/T['"]/.test(lib.replace(/\/\/.*$/gm, '')), 'lib/kill-own-tree 自己也不用 /T');

// ② CDP 客户端:socket.send 之前三行内必须有 readyState 闸
const SEND = 'this.socket.send(JSON.stringify({ id, method, params }));';
const cdpFiles = files.filter(f => fs.readFileSync(f, 'utf8').includes(SEND));
const unguarded = [];
for (const f of cdpFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.includes(SEND)) return;
    const window = lines.slice(Math.max(0, i - 3), i).join('\n');
    if (!/this\.socket\.readyState !== 1/.test(window)) unguarded.push(`${rel(f)}:${i + 1}`);
  });
}
const CDP_OWNERS = 30; // 137x：新增 rail-tool-height.browser 自带的 CDP 客户端，带 readyState 闸(照抄 live-full-text.browser 同款)。
//   // 27 件各自复制的 ＋ 128d 公共夹具 lib/browser-fixture 那一份(新件一律用它,不再复制第 29 份) ＋ 137x 新件 rail-tool-height.browser
ok(cdpFiles.length === CDP_OWNERS, `③ 自带 CDP 客户端的件数钉成 ${CDP_OWNERS}(实得 ${cdpFiles.length})`);
ok(unguarded.length === 0, `② 每个 CDP 客户端的 send() 在 socket.send 之前都有 readyState 闸(未设闸 ${unguarded.length}${unguarded.length ? ':' + unguarded.join(' ') : ''})`);

// ④ 128i:产品侧同一条规矩 —— src/ 里零 taskkill /T 调用;唯一的收尸实现 OWN_TREE_KILL_PS 保着「认子孙核创建时间」
//    「conhost 不杀」两行;两个入口(killChildTree 发出去就算、freeStalePort 的 killPid 等它跑完)都走它。
{
  const SRC = path.join(HARNESS, '..', 'ruyi-workbench', 'app', 'src');
  const srcFiles = fs.readdirSync(SRC).filter(n => n.endsWith('.js'));
  const prodOffenders = [];
  for (const n of srcFiles) {
    fs.readFileSync(path.join(SRC, n), 'utf8').split('\n').forEach((line, i) => {
      if (!/^\s*\/\//.test(line) && TASKKILL_T.test(line)) prodOffenders.push(`${n}:${i + 1}`);
    });
  }
  ok(srcFiles.length >= 50 && prodOffenders.length === 0,
    `④ 产品 src/ 里零 taskkill /T 调用(扫了 ${srcFiles.length} 个模块;命中 ${prodOffenders.length}${prodOffenders.length ? ':' + prodOffenders.join(' ') : ''})`);
  const pr = fs.readFileSync(path.join(SRC, '04-permission-runtime.js'), 'utf8');
  ok(/\[int64\]\$p\.Created -lt \[int64\]\$cur\.Created/.test(pr), '④ OWN_TREE_KILL_PS 认子孙核创建时间(撞号的陌生人比父亲还老 ⇒ 跳过)');
  ok(/'conhost\.exe'/.test(pr) && /Stop-Process/.test(pr) && /StartTime\.ToFileTimeUtc\(\)/.test(pr), '④ OWN_TREE_KILL_PS 不杀 conhost、动手前核启动时间');
  ok(/function killChildTree\(pid\)[\s\S]{0,1600}ownTreeKillCommand\(pid\)/.test(pr), '④ killChildTree 走 ownTreeKillCommand');
  const router = fs.readFileSync(path.join(SRC, '13-http-router.js'), 'utf8');
  ok(/async function killPid\(pid\) \{\s*await killOwnProcessTree\(pid\);/.test(router), '④ freeStalePort 的 killPid 走 killOwnProcessTree');
}

console.log(`PROCESS SAFETY STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
