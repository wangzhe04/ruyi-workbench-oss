#!/usr/bin/env node
'use strict';

// 112b: 回合流事件的机械对账门。
//
// 摸底(25 号 §2.1)发现服务端在一个回合里会下发 54 种事件,两壳把其中 20 种静默丢进 `default: break`
// —— 长命令心跳、等资源、回合预算、打转纠偏、子代理停滞与预算调整全在里面。用户看到的是一个不动的
// 界面,而服务端其实一直在说话。本门把「服务端发了什么」与「前端认了什么」两侧都做成扫描出来的集合,
// 逐项对账,不再靠人肉清单(上一波已证明人肉清单会漂移:新事件加进引擎,没人记得补前端)。
//
// 三条判定:
//   D1 登记完整性:服务端扫到的每一种事件,都必须出现在 turn-activity.js 的 CONSUMED/IGNORED 两表之一;
//      反过来两表里不能有服务端已经不发的僵尸条目。加事件不登记 => 红。
//   D2 认领覆盖:每一种事件要么被状态机消费,要么被某一壳的 case 表处理,要么在本文件的豁免表里
//      写明理由。默认丢弃不再是沉默的 —— 想丢就得留下一行字说为什么。
//   D3 豁免不发霉:豁免表里的条目如果其实已经有人处理了,或者服务端已经不发了,也判红,逼着删。
// 另加壳层接线、文案与样式三项静态锁,防「状态机写了但没人用」。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { scanSourceEventTypes, scanShellHandledTypes } = require('./lib/stream-event-scan.js');

let failed = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else { console.error('FAIL ' + label); failed += 1; }
}
function okList(list, label) {
  ok(list.length === 0, list.length === 0 ? label : `${label} :: ${list.join(', ')}`);
}

// ── 豁免表:服务端在发、两壳都没认领、且【本波有意不认领】的事件。每条必须给出理由。 ──────────────
// 理由不是免罪符,是待办的登记:117d 线程抽屉(27 号)会接走班组内部往来那一组。
const EXEMPT = Object.freeze({
  raw_stdout: 'Claude CLI 的原始 stdout 行,与 raw_line 同源,只喂调试镜头,不是过程状态。',
  tool_catalog: '自适应工具装载的一次性遥测(装了多少个 schema、多少 token),不随回合推进变化。',
  tool_image: '工具产图的第二路通知;图本身已在 tool_result 到达时内联渲染(109b),再认一次会重复出图。',
  observation_reduced: 'L1 观测缩减的计量事件,进 econ 采样不进用户面(25 号 §1.3 C 类影子口径)。',
  observation_reduction_shadow: '同上,且是 shadow 模式,按定义不产生任何用户可见后果。',
  self_check: '自检钩子的内部标记,没有用户可读语义。',
  subagent_mail_in: '班组成员之间的收信,归 117d 线程抽屉(27 号),本波不在主叙事里展开。',
  subagent_mail_out: '班组成员之间的发信,同 subagent_mail_in,归 117d 线程抽屉。',
  subagent_pool_proposed: '子代理任务池提案,归 117d 线程抽屉。',
  subagent_steered: '对某个成员的插话回执,归 117d 线程抽屉。',
  subagent_usage: '成员级用量台账,回合总账已在用量面板呈现,成员级明细归 117d。',
});

// ── 服务端侧 ────────────────────────────────────────────────────────────────────────────────
const serverEvents = scanSourceEventTypes(SRC);
const serverTypes = [...serverEvents.keys()].sort();
ok(serverTypes.length >= 50, `D0 服务端事件扫描到 ${serverTypes.length} 种(下界 50,防扫描器悄悄失灵)`);
ok(serverTypes.includes('tool_progress') && serverTypes.includes('agent_resource') && serverTypes.includes('budget_guard'),
  'D0b 扫描器认得多行 onEvent 与 downstreamEvent/emit 两个别名');

// ── 前端侧:状态机登记表 + 两壳 case 表 ──────────────────────────────────────────────────────
const activitySource = read('ruyi-workbench/app/public/js/turn-activity.js');
const activityContext = {};
vm.runInNewContext(
  activitySource.replace(/^export /gm, '')
  + '\nthis.CONSUMED = TURN_ACTIVITY_CONSUMED;\nthis.IGNORED = TURN_ACTIVITY_IGNORED;\nthis.PHASES = TURN_ACTIVITY_PHASES;',
  activityContext,
);
const consumed = new Set(activityContext.CONSUMED);
const ignored = new Set(activityContext.IGNORED);
const declared = new Set([...consumed, ...ignored]);

const classicPath = path.join(PUBLIC, 'js', 'chat-stream-runtime.js');
const previewPath = path.join(PUBLIC, 'js', 'preview-shell.js');
const classicHandled = scanShellHandledTypes([classicPath]);
const previewHandled = scanShellHandledTypes([previewPath]);

// D1 登记完整性(双向)
okList(serverTypes.filter(type => !declared.has(type)),
  'D1 服务端每一种事件都已登记进 CONSUMED/IGNORED');
okList([...declared].filter(type => !serverEvents.has(type)).sort(),
  'D1b 登记表里没有服务端已不再发送的僵尸条目');
okList([...consumed].filter(type => ignored.has(type)).sort(),
  'D1c 同一事件不能既消费又忽略');

// D2 认领覆盖
const covered = type => consumed.has(type) || classicHandled.has(type) || previewHandled.has(type);
okList(serverTypes.filter(type => !covered(type) && !EXEMPT[type]),
  'D2 未被任何一侧认领的事件必须写明豁免理由');

// D3 豁免不发霉
okList(Object.keys(EXEMPT).filter(type => !serverEvents.has(type)).sort(),
  'D3 豁免表里没有服务端已不再发送的条目');
okList(Object.keys(EXEMPT).filter(type => covered(type)).sort(),
  'D3b 已经有人认领的事件不该继续挂在豁免表里');
okList(Object.entries(EXEMPT).filter(([, reason]) => String(reason || '').trim().length < 12).map(([type]) => type),
  'D3c 每条豁免都给出了可读理由(不是空字符串占位)');

// ── 本波必须补齐的六族(25 号 §2.2 112b 明列)+ 顺手补的两族 ──────────────────────────────────
const WAVE_112B = ['tool_progress', 'agent_resource', 'budget_guard', 'loop_recovery', 'subagent_no_progress', 'adaptive_tool_budget'];
okList(WAVE_112B.filter(type => !consumed.has(type)),
  'D4 112b 点名的六族事件全部被状态机消费');
okList(WAVE_112B.filter(type => !serverEvents.has(type)),
  'D4b 这六族确实是服务端在发的(不是照着文档臆造的名字)');

// 有 DOM 侧效的三族要真的落到卡片上,不能只进状态机
const classic = read('ruyi-workbench/app/public/js/chat-stream-runtime.js');
ok(/case 'tool_progress':/.test(classic) && classic.includes('turnActivity.tool.budgetSoft') && classic.includes('turnActivity.tool.budgetHard'),
  'D5 经典壳工具卡片认领 tool_progress 的软/硬预算档');
ok(/case 'subagent_no_progress':/.test(classic) && /case 'adaptive_tool_budget':/.test(classic)
  && classic.includes('turnActivity.subagent.stalled') && classic.includes('turnActivity.subagent.budget'),
  'D6 经典壳子代理卡片认领停滞与预算调整');

// ── 壳层接线:状态机被两壳真正用起来 ──────────────────────────────────────────────────────────
ok(classic.includes('turnActivity.consume(evt)') && classic.includes('createTurnActivity'),
  'D7 经典壳把每一条事件喂进状态机');
ok(classic.includes("el('div', 'turn-activity hidden')") && classic.includes("bar.id = 'turnActivityBar'"),
  'D8 经典壳在 composer 上方渲染统一状态条');
ok(classic.includes('activityBoundSession') && /sid !== activityBoundSession/.test(classic),
  'D9 换会话即清状态机(不把上一条会话的动作挂到新会话头上)');

const app = read('ruyi-workbench/app/public/app.js');
ok(/import \{ createTurnActivity, describeTurnActivity \} from '\.\/js\/turn-activity\.js'/.test(app)
  && /^\s*createTurnActivity,/m.test(app) && /^\s*describeTurnActivity,/m.test(app),
  'D10 组装根把状态机注入 chat-stream-runtime(该文件全篇零 import 的既有纪律)');

const preview = read('ruyi-workbench/app/public/js/preview-shell.js');
ok(preview.includes("from './turn-activity.js'") && preview.includes('turnActivity.consume(event)'),
  'D11 Preview 壳与经典壳共用同一个状态机');
ok(preview.includes("makeMetric('context'") && preview.includes("[data-slot=\"context\"]"),
  'D12 Preview 壳接入上下文电量(此前完全没有)');
ok(/if \(pending > 0\) return t\('previewShell\.activity\.needsYou'/.test(preview)
  && preview.indexOf("previewShell.activity.needsYou") < preview.indexOf('describeTurnActivity(activity, t)'),
  'D13 速报 v2 保留待决优先,状态机排在其后');
ok(preview.includes('turnActivity.reset(); turnActivityPhase = ') || /turnActivity\.reset\(\);[\s\S]{0,80}turnActivityPhase/.test(preview),
  'D14 切任务清状态机');

// ── 文案:四份 locale 同步,零裸字符串 ────────────────────────────────────────────────────────
const LOCALES = [
  'ruyi-workbench/app/public/locales/zh-CN.json',
  'ruyi-workbench/app/public/locales/en-US.json',
  'docs/i18n/locales/zh-CN.json',
  'docs/i18n/locales/en-US.json',
];
const REQUIRED_KEYS = [
  ...activityContext.PHASES.map(phase => `turnActivity.phase.${phase}`),
  'turnActivity.action.thinking', 'turnActivity.action.tool',
  'turnActivity.compact.running', 'turnActivity.compact.applied',
  'turnActivity.waiting.permission', 'turnActivity.waiting.someTool', 'turnActivity.waiting.plan',
  'turnActivity.waiting.question', 'turnActivity.waiting.resource', 'turnActivity.waiting.resourceBlocked',
  'turnActivity.orchestrating.detail',
  'turnActivity.part.toolElapsed', 'turnActivity.part.turnElapsed', 'turnActivity.part.step', 'turnActivity.part.silence',
  'turnActivity.notice.budgetWarning', 'turnActivity.notice.budgetTripped', 'turnActivity.notice.toolBudget',
  'turnActivity.notice.loopRecovery', 'turnActivity.notice.failover', 'turnActivity.notice.resumeRecovery',
  'turnActivity.notice.subagentStalled', 'turnActivity.notice.adaptiveToolBudget',
  'turnActivity.tool.budgetSoft', 'turnActivity.tool.budgetHard',
  'turnActivity.subagent.stalled', 'turnActivity.subagent.budget',
  'previewShell.contextMeter', 'previewShell.contextMeterTitle',
];
const missingKeys = [];
for (const rel of LOCALES) {
  const catalog = JSON.parse(read(rel));
  for (const key of REQUIRED_KEYS) if (!(key in catalog)) missingKeys.push(`${path.basename(path.dirname(rel))}/${path.basename(rel)}:${key}`);
}
okList(missingKeys, 'D15 状态条文案在四份 locale 里齐全');
// 扁平点号键:嵌套会让 t() 查不到(catalog[key] 是一次性查表,不遍历嵌套)
ok(LOCALES.every(rel => Object.entries(JSON.parse(read(rel)))
  .filter(([key]) => key.startsWith('turnActivity.'))
  .every(([, value]) => typeof value === 'string')),
  'D16 turnActivity.* 全部是扁平点号键的字符串值');

// ── 样式:三个所有权层各自新增,载荷锁已重钉 ──────────────────────────────────────────────────
const css = require('./read-frontend-css.js').readFrontendCss();
ok(css.includes('.turn-activity {') && css.includes('.turn-activity .ta-notice.warn')
  && css.includes('.turn-activity[data-severity="attention"]'),
  'D17 状态条样式进 composer 所有权层,warn/attention 双档');
ok(css.includes('.tool-card .tc-status.warn') && css.includes('.subagent-head .sa-status.warn'),
  'D18 工具卡片与子代理状态行补上 warn 档(此前只有 ok/err)');
ok(/@media \(prefers-reduced-motion: reduce\) \{ \.turn-activity \.ta-dot \{ animation: none; \} \}/.test(css),
  'D19 状态条呼吸点尊重 reduced-motion');
ok(/@media \(max-width: 560px\) \{ \.turn-activity \.ta-notices \{ display: none; \} \}/.test(css)
  && /@media \(max-width: 430px\)[\s\S]{0,200}\.ta-part:nth-child\(n\+2\) \{ display: none; \}/.test(css),
  'D20 窄屏收敛:560px 通知让位、430px 只留句首与本次工具计时(整句会被省略号从中间切断)');
ok(!fs.readFileSync(path.join(PUBLIC, 'css', 'components', 'chat-composer.css'), 'utf8').includes('\u0000'),
  'D20b 样式层无 NUL 字节(112c 走查踩过:转义 \\00b7 经 shell/python 两层后写出真 NUL)');

console.log(`\nPROGRESS EVENTS STATIC E2E: ${failed ? 'FAIL (' + failed + ')' : 'ALL PASS'}`);
process.exit(failed ? 1 : 0);
