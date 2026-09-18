#!/usr/bin/env node
'use strict';
// 128b(48 号文 §2-b)静态锁:会话「读-改-写」只走 mutateSession,旁车／驱动器过撤回闸,撤回相关的码有人话。
//
// 为什么是普查而不是「凡是 saveSession 都要 X」:哪一处是「回合存自己」(被闸丢掉是对的)、哪一处是「请求／后台读改写」
// (被闸丢掉就是回了一句假话),机器分不出来 —— 这是判断题。所以钉的是【普查数】:各模块里 saveSession( 的调用个数
// 与下面那张表逐项相等;谁新加一处,这里当场红,红的那句话告诉他回来做这道判断题(读改写 → mutateSession)。
// 另外逐个点名 128b 改过的那十一处,钉住「它们真的走 mutateSession」,免得普查数碰巧对上而改法被撤回。
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'src');
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
const read = n => fs.readFileSync(path.join(SRC, n), 'utf8');
const codeLines = text => text.split('\n').map(l => l.replace(/\/\/.*$/, ''));

// ① 普查:各模块 saveSession( 的调用个数(128b 之后)。
const CENSUS = {
  '02-session-store.js': 9,      // 回合外的存储层自身:updateSessionMeta ×2、loadSession 自愈 ×2、v1 回退、createSession、撤回、mutateSession、任务控制
  '05-claude-engine.js': 4,      // runClaudeTurn 自存
  '05b-kimi-bridge.js': 3,       // Kimi 回合自存(runKimiCompact 已改走 mutateSession)
  '06e-mission-domain.js': 5,    // 驱动器自存(拿着聊天流那份对象;撤回后由 sessionObjectIsStale 收手)
  '07-autonomy.js': 1,           // steer 排空(回合自存)
  '09-workflow.js': 10,          // runOpenAiTurn 自存
  '10-context-governance.js': 3, // maybeAutoCompact(回合自存);两个手动压缩已改走 mutateSession
  '13-http-router.js': 1,        // Kimi 状态那个 GET 回写用量读数(低风险,丢了下次再读)
  '13b-api-domain-routes.js': 1, // 插话路由往活回合那份对象里追加(回合自存)
  '13d-core-domain-routes.js': 1,// 权限暂停计时器的纯重写
  '13k-steward-threads.js': 2,   // 建会话
  '13m-steward-runner-base.js': 2, // ensureStewardSession(建/补管家会话)
  '13s-scheduler.js': 1,         // 定时触发建会话
};
const actual = {};
for (const n of fs.readdirSync(SRC).filter(x => x.endsWith('.js')).sort()) {
  let c = 0;
  for (const code of codeLines(read(n))) {
    if (/function saveSession\(/.test(code)) continue;
    c += (code.match(/\bsaveSession\(/g) || []).length;
  }
  if (c) actual[n] = c;
}
const diffs = [...new Set([...Object.keys(CENSUS), ...Object.keys(actual)])]
  .filter(n => (CENSUS[n] || 0) !== (actual[n] || 0)).map(n => `${n}: 表 ${CENSUS[n] || 0} / 实 ${actual[n] || 0}`);
ok(diffs.length === 0, `① saveSession 普查与表逐项相等${diffs.length ? '(对不上:' + diffs.join(';') + ')—— 新加的若是请求／后台「读-改-写」,改走 mutateSession;若是回合存自己,回来改表并写明理由' : ''}`);

// ② 128b 改过的十一处真的走 mutateSession(慢活带 expectGen)。
function fnBody(file, header) {
  const text = read(file);
  const at = text.indexOf(header);
  if (at < 0) return '';
  const end = text.indexOf('\n}\n', at);
  return text.slice(at, end < 0 ? undefined : end);
}
function routeBlock(file, marker, lines = 70) {
  const text = read(file);
  const at = text.indexOf(marker);
  return at < 0 ? '' : text.slice(at).split('\n').slice(0, lines).join('\n');
}
// 路由判定串按片拼出来,本文件里不出现字面路由路径:route-inventory 按「测试文件里出现了这条路径」认覆盖,
// 而本件只读源码、并不打这些路由 —— 字面写出来就是一条假覆盖(本件第一版就把 6 条路由的 coveredBy 冒领了)。
const routeMarker = tail => "pathname === '/" + 'api/' + tail + "'";
const sites = [
  ['13-http-router.js setSessionSkillsCore', fnBody('13-http-router.js', 'async function setSessionSkillsCore('), false],
  ['13-http-router.js 线程记忆设置路由', routeBlock('13-http-router.js', routeMarker('session/memories'), 60), false],
  ['13-http-router.js todo 回写路由', routeBlock('13-http-router.js', routeMarker('todo'), 25), false],
  ['13-http-router.js 任务账本路由(check／start／update)', routeBlock('13-http-router.js', routeMarker('mission'), 110), true],
  ['10-context-governance.js runProviderCompact', fnBody('10-context-governance.js', 'async function runProviderCompact('), true],
  ['10-context-governance.js runAgentExternalCompact', fnBody('10-context-governance.js', 'async function runAgentExternalCompact('), true],
  ['05b-kimi-bridge.js runKimiCompact', fnBody('05b-kimi-bridge.js', 'async function runKimiCompact('), false],
  ['08-agent-runs.js appendAgentWorkflowSummaryToSession', fnBody('08-agent-runs.js', 'async function appendAgentWorkflowSummaryToSession('), false],
  ['13p-steward-runner-actions.js stewardStampReply', fnBody('13p-steward-runner-actions.js', 'async function stewardStampReply('), false],
  ['13q-steward-runner-turn.js stewardArchiveConversation', fnBody('13q-steward-runner-turn.js', 'async function stewardArchiveConversation('), true],
  ['02-session-store.js missionControlCommand', fnBody('02-session-store.js', 'async function missionControlCommand('), false],
];
for (const [label, body, needsExpectGen] of sites) {
  const code = codeLines(body).join('\n');
  const uses = /\bmutateSession\(/.test(code);
  const bare = code.split('\n').filter(l => /\bsaveSession\(/.test(l) && !/throwIfStale:\s*true/.test(l));
  ok(body.length > 0 && uses && bare.length === 0 && (!needsExpectGen || /expectGen/.test(code)),
    `② ${label} 走 mutateSession${needsExpectGen ? '(带 expectGen)' : ''}、没有裸 saveSession(${body.length ? `裸存 ${bare.length} 处` : '没找到函数'})`);
}

// ③ 原语本身:存盘带 throwIfStale、expectGen 不一致就不写。
const mutate = fnBody('02-session-store.js', 'async function mutateSession(');
ok(/throwIfStale:\s*true/.test(mutate) && /expectGen/.test(mutate) && /session\.rewound_during_write|sessionRewoundError/.test(mutate),
  '③ mutateSession 存盘带 throwIfStale、expectGen 不一致即抛 session.rewound_during_write');

// ④ 旁车与驱动器过撤回闸。
ok(/sessionObjectIsStale\(session\)/.test(fnBody('10-context-governance.js', 'function maybeWriteSessionNotes(')), '④ 会话笔记旁车:陈旧对象不写');
ok(/sessionObjectIsStale\(session\)\s*\?\s*''\s*:\s*await writeHistorySnapshot\(/.test(read('10-context-governance.js')), '④ 历史快照:陈旧对象不写');
ok(/sessionObjectIsStale\(session\)/.test(fnBody('06e-mission-domain.js', 'async function runMissionDriver(')), '④ 任务驱动器:陈旧对象收手');

// ⑤ 撤回相关的码有稳定码与人话(Brief §4.2 第 18 条)。
const boot = read('00-boot.js');
ok(/\['rewind_superseded', 'session\.rewind_superseded'\]/.test(boot), "⑤ 裸串 'rewind_superseded' 归一成稳定码 session.rewind_superseded");
const app = fs.readFileSync(path.join(SRC, '..', 'public', 'app.js'), 'utf8');
const drawer = fs.readFileSync(path.join(SRC, '..', 'public', 'js', 'steward-drawer.js'), 'utf8');
const codes = ['session.rewind_superseded', 'session.rewound_during_write', 'session.history_changed_during_compact'];
ok(codes.every(c => app.includes(`'${c}':`) && drawer.includes(`'${c}':`)), '⑤ 工作台与管家抽屉都给这三个码配了人话键');
const keys = ['error.api.rewindSuperseded', 'error.api.rewoundDuringWrite', 'error.api.historyChangedDuringCompact'];
const localeFiles = ['ruyi-workbench/app/public/locales/zh-CN.json', 'ruyi-workbench/app/public/locales/en-US.json', 'docs/i18n/locales/zh-CN.json', 'docs/i18n/locales/en-US.json']
  .map(r => JSON.parse(fs.readFileSync(path.join(__dirname, '..', r), 'utf8')));
ok(localeFiles.every(l => keys.every(k => typeof l[k] === 'string' && l[k].length > 8)), '⑤ 四份 locale 都有这三句人话');

console.log(`SESSION SAVE CENSUS STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
