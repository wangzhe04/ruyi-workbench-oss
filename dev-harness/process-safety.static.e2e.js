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
const KILL_OWNERS = 251;   // codemod 250 件(含 run-all 的超时收尸)＋ kimi-acp-live-probe(手改);unit/kill-own-tree.test.js 走绝对路径不计
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
const CDP_OWNERS = 27;
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
