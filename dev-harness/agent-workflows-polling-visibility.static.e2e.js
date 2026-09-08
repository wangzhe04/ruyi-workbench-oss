#!/usr/bin/env node
'use strict';

// 第117波 117q-B5 静态契约(30号文§3 总表 P2-17 / §「agent-workflows.js 是 5 个轮询里唯一没有可见性门控的」):
//
//   agent-workflows.js 的 agentRunsPollWanted()/syncAgentRunsPolling() 此前只判「监控页签激活」∪「工作台画布
//   视图激活」，没有 document.hidden 判定——标签页整个切到后台，2 秒一拍的 setInterval(loadAgentRuns, 2000)
//   照常跑。另外四处轮询(preview-shell.js/session-experience.js/steward-board.js/steward-drawer.js)两个门控
//   都有，这是「漏做一半」不是设计差异。修法只加 document.hidden 判定 + 监听 visibilitychange 重新同步，
//   不抽公共模块(另外四处已被各自的静态锁按函数体逐字钉着，30号文已否决合并)。
//
// 本件只锁 agent-workflows.js 自己这一份的轮询生命周期(此前对它零静态锁):
//   A 全文件恰好一处 setInterval／一处 clearInterval(轮询原语没有被复制出第二份)；
//   B agentRunsPollWanted() 的返回表达式里出现 document.hidden 判定(可见性门控真的接进了期望态)；
//   C 恰好一处 visibilitychange 监听，且监听回调调用的是 syncAgentRunsPolling(不是挂了个空监听)；
//   D 语义健全性：agentRunsPollWanted 仍保留原有的「监控页签激活 ∪ 工作台画布视图激活」判据(只加，不改)。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'js', 'agent-workflows.js');
const src = fs.readFileSync(FILE, 'utf8');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const code = stripComments(src);
const count = (source, pattern) => (source.match(pattern) || []).length;

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };

// A: 轮询原语没有被复制出第二份。
ok(count(code, /setInterval\(/g) === 1 && count(code, /clearInterval\(/g) === 1,
  `A agent-workflows.js 恰好一处 setInterval 与一处 clearInterval(实测 ${count(code, /setInterval\(/g)}／${count(code, /clearInterval\(/g)})`);

// B: agentRunsPollWanted() 函数体接入 document.hidden 判定(P2-17 修的就是这个缺口)。
const wantedMatch = code.match(/function agentRunsPollWanted\(\)\s*\{([\s\S]*?)\n\}/);
ok(!!wantedMatch, 'B0 定位到 agentRunsPollWanted() 函数体');
const wantedBody = wantedMatch ? wantedMatch[1] : '';
ok(/document\.hidden/.test(wantedBody), 'B agentRunsPollWanted() 返回表达式里出现 document.hidden 判定(此前是唯一没有的那一处)');

// D: 只加不改 —— 原有「监控页签激活 ∪ 工作台画布视图激活」判据原样保留。
ok(/tabActive\s*\|\|\s*isWorkbenchCanvasView\(\)/.test(wantedBody),
  'D 原判据「监控页签激活 ∪ 工作台画布视图激活」原样保留(本次只加可见性门控，没有改判据本身)');
ok(/document\.querySelector\('\.tool-pane \.tool-tabs button\[data-tab="agent-runs"\]\.active'\)/.test(wantedBody),
  'D2 tabActive 仍取自同一个 DOM 锚点(未被顺手改写)');

// C: 恰好一处 visibilitychange 监听，且接的是 syncAgentRunsPolling(闭环，不是挂了个空监听)。
ok(count(code, /addEventListener\(\s*['"]visibilitychange['"]/g) === 1,
  `C1 全文件恰好一处 visibilitychange 监听(实测 ${count(code, /addEventListener\(\s*['"]visibilitychange['"]/g)})`);
ok(/document\.addEventListener\(\s*['"]visibilitychange['"]\s*,\s*syncAgentRunsPolling\s*\)/.test(code),
  'C2 visibilitychange 监听回调正是 syncAgentRunsPolling(切后台停表、切回前台立即重新同步 + 恢复 2s 心跳)');

// 交叉核对(信息性，不新起对四处已有静态锁的重复判据):另外四处轮询模块各自已有 document.hidden/doc().hidden
// 门控(30号文§3 P2-17 一句话原文的「另外四处都有」)，本文件此前是唯一缺口——这里只再确认一次 agent-workflows.js
// 自己现在也具备同款字面量，不去碰、不去重锁那四份(它们各自的 .static.e2e.js 已经钉住)。
ok(count(code, /document\.hidden/g) >= 1,
  `E agent-workflows.js 现在也出现 document.hidden(补齐五个轮询里此前唯一的缺口，实测 ${count(code, /document\.hidden/g)} 处)`);

console.log(`\nAGENT-WORKFLOWS POLLING VISIBILITY STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
