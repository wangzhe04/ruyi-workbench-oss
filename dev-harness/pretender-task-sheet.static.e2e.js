#!/usr/bin/env node
'use strict';

// 第77波静态契约：任务单头部/原始镜头/只读收活台，经典渲染器与 steer 去重规则复用，
// Mission cursor/usage/run/result 数据面齐全，SSE 只镜像既有流；第84波新增写动作只走权威控制命令。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const app = read('app.js');
const shell = read('js/preview-shell.js');
const renderer = read('js/chat-static-renderer.js');
const stream = read('js/chat-stream-runtime.js');
const narrative = read('js/turn-narrative.js');
const css = read('css/views/preview-shell.css');
const zh = JSON.parse(read('locales/zh-CN.json'));
const en = JSON.parse(read('locales/en-US.json'));

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

ok(shell.includes('className = \'preview-task-sheet\'') || shell.includes("text('article', 'preview-task-sheet'"), 'A1 全宽任务单为独立单视图 article');
for (const className of ['preview-task-head', 'preview-task-progress', 'preview-task-metrics', 'preview-worksite', 'preview-raw-messages', 'preview-intake']) {
  ok(shell.includes(className) && css.includes('.' + className), `A2 ${className} 结构/样式双锚`);
}
ok(shell.includes("makeMetric('turns'") && shell.includes("makeMetric('tokens'")
  && shell.includes("makeMetric('cost'") && shell.includes("makeMetric('runs'"), 'A3 头部五态/进度外含回合、Token、费用、班组用量事实');
ok(shell.includes("processDetails.dataset.mode = processMode") && shell.includes("processDetails.open = processMode === 'active'")
  && css.includes('.preview-process-details') && css.includes(':has(> .preview-process-details:not([open])) { height: auto; max-height: 100%; }')
  && css.includes('display: flex; align-items: center; justify-content: center;'),
  'A3b 执行过程与台账在活任务展开、终态任务默认折叠且收起时任务单紧凑居中');
ok(shell.includes("reportKind = files.length ? 'engineering'") && shell.includes("message.role === 'assistant'")
  && shell.includes("report.className = 'preview-finish-report'") && shell.includes('report.open = reportWasOpen')
  && shell.includes('reportDeliveryText(reportSource)') && shell.includes("text('div', 'preview-finish-report-copy md', '')")
  && shell.includes('renderMarkdownInto(reportCopy, reportText)') && shell.includes('highlightIn(reportCopy)')
  && shell.includes("reportCopy.dataset.markdownReady === 'true'")
  && shell.includes('reportPreviewText(reportSource)') && !shell.includes("full.className = 'preview-finish-report-full'"),
  'A3c 收工汇报默认折叠，以正文标题预览，展开显示完整交付正文并保留用户展开状态');
ok(css.includes('--preview-terminal-gutter') && css.includes('align-items: flex-start;')
  && css.includes('grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));'),
  'A3c2 wide terminal sheets share a centered content rail and balanced fact columns');
ok(shell.includes("section.className = 'preview-finish-artifacts'") && shell.includes('section.open = artifactsWereOpen')
  && shell.includes("api('/api/file/reveal'") && shell.includes("reveal(path, 'open')") && shell.includes("reveal(path, 'select')"),
  'A3c3 成果清单默认折叠并保留展开状态，每项复用安全文件接口提供打开与定位');
ok(shell.includes("text('section', 'preview-task-bottom'") && shell.includes("text('div', 'preview-continue-turn-head'")
  && shell.includes("continueState.dataset.slot = 'continueState'") && css.includes('.preview-task-bottom')
  && css.includes('.preview-task-actions-copy') && css.includes('.preview-continue-turn-state[data-tone="ready"]'),
  'A3c4 底部续办与普通任务操作分组，具备用途标题、状态徽记和差异化配色');
ok(shell.includes('narrativeTurnContext(entry)') && shell.includes('preview-narrative-outcome')
  && shell.includes('preview-narrative-goal'), 'A3d 现场纪要补任务目标、验收概况与逐回合结论');
ok(zh['previewShell.finishSavePlaybook'] === '保存为任务模板' && zh['previewShell.finishSaveMemory'] === '记住本次偏好',
  'A3e 完成态学习动作直接说明模板与偏好差别');
ok(shell.includes("details.className = 'preview-ledger-details'") && shell.includes('details.open = ledgerWasOpen || Boolean(controlDraft)')
  && shell.includes("section.className = 'preview-ledger-irreversible'") && shell.includes('section.open = irreversibleWasOpen'),
  'A3f 台账明细与不可逆操作分层折叠并保留用户展开状态');
ok(shell.includes("readonlyPanel('needs'") && shell.includes("readonlyPanel('results'")
  && shell.includes("readonlyPanel('ledger'"), 'A4 收活台需要你/成果/台账三块均为只读投影');
ok(shell.includes('/interventions/${encodeURIComponent(id)}/decision')
  && shell.includes('/api/missions/${encodeURIComponent(sessionId)}/control')
  && shell.includes("api('/api/checkpoints/rollback'")
  && shell.includes('/api/agent-runs/${encodeURIComponent(run.id)}'),
  'A5 Preview 写动作收敛到 Intervention/Mission/checkpoint/Run 权威命令');

ok(shell.includes('renderStaticMessage(message, key, signature, { readonly: true, idScope: \'preview\' })'),
  'B1 原始镜头逐条调用经典 chat-static-renderer，不复制消息/工具卡渲染器');
ok(renderer.includes('function renderStaticMessage(msg, messageKey, renderSignature, options = {})')
  && renderer.includes('if (!options.readonly) main.appendChild(msgActions(msg));')
  && renderer.includes('if (msg.turnSummary && !options.readonly)'), 'B2 共享渲染器只增加可选只读适配，经典默认行为不变');
ok(renderer.includes("idScope ? idScope + '-' : ''") && shell.includes("idScope: 'preview'"), 'B3 双壳工具锚点按视图作用域隔离，不制造重复 DOM id');
ok(shell.includes('visibleSessionMessageEntries(messages, start') && narrative.includes('export function visibleSessionMessageEntries('),
  'B4 经典/Preview 共用 persisted steer 去重规则');
ok(shell.includes('weightedMessageTailStart(messages') && shell.includes('MSG_WINDOW_STEP'), 'B5 原始镜头复用长历史重量窗口与可达的续读按钮');
ok(shell.includes("host.dataset.renderer = 'chat-static-renderer'") || shell.includes("raw.dataset.renderer = 'chat-static-renderer'"),
  'B6 原始镜头显式标记唯一渲染来源，便于浏览器契约核验');

ok(shell.includes('api(`/api/missions/${sessionId}`)') && shell.includes('api(`/api/sessions/${sessionId}`)'),
  'C1 详情只读读取 Mission 聚合快照 + 对应 Session 原文');
for (const fact of ['snapshot.acceptance', 'snapshot.usage', 'snapshot.runs', 'snapshot.pending', 'snapshot.result', 'snapshot.changes', 'snapshot.checkpoints', 'snapshot.irreversible', 'snapshot.controls', 'snapshot.ledger', 'snapshot.cursor']) {
  ok(shell.includes(fact), `C2 消费 ${fact} 权威投影`);
}
ok(shell.includes("event.type === 'assistant_delta'") && shell.includes('appendPreviewLiveText(event.text || \'\')'),
  'C3 新容器消费同一 SSE assistant_delta，未建立第二条网络流');
ok(stream.includes('emitSessionStream = () => {}') && stream.includes("notifySessionStream({ type: 'event'")
  && app.includes('emitSessionStream: event => previewStreamSink?.(event)'), 'C4 经典 stream runtime 经窄只读 sink 镜像事件');
ok(!/fetch\(['"]\/api\/chat\/stream/.test(shell) && !/new EventSource|new WebSocket/.test(shell), 'C5 Preview 不另连 chat SSE/WebSocket');
ok(shell.includes('captureRawFocus(host)') && shell.includes('restoreRawFocus(host, focus)')
  && shell.includes('follow ? host.scrollHeight : savedTop'), 'C6 静态重取和增量 append 均保存焦点/用户滚动意图');
ok(shell.includes('getActiveTurnLines(sessionId)') && shell.includes("parts.join('')"), 'C7 中途切入 Preview 可从既有活动流游标补播文本');

ok(css.includes('.preview-raw-messages .message') && css.includes('.preview-raw-messages .msg-actions { display: none; }'),
  'D1 经典消息资产在新容器全宽复用且操作条只读隐藏');
ok(css.includes('contain: layout paint') && css.includes('scroll-behavior: auto'), 'D2 原始镜头隔离布局/绘制并关闭程序化平滑滚动积压');
ok(css.includes('grid-template-columns: minmax(0, 1fr) minmax(250px, 300px)'), 'D3 桌面主现场 + 窄收活台布局锁定');
ok(/@media \(max-width: 920px\)[\s\S]*preview-task-body[\s\S]*grid-template-columns: minmax\(0, 1fr\)/.test(css),
  'D4 窄屏任务单收敛为单列且现场仍有最小阅读高度');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'D5 Wave 77 样式继续全走主题/语义 token');

const zhKeys = Object.keys(zh).filter(key => key.startsWith('previewShell.')).sort();
const enKeys = Object.keys(en).filter(key => key.startsWith('previewShell.')).sort();
ok(zhKeys.length >= 70 && JSON.stringify(zhKeys) === JSON.stringify(enKeys), `E1 Wave 77 中英键完全对称(${zhKeys.length})`);
ok(!/Pretender|3\.0/.test(Object.values(zh).filter((_, index) => Object.keys(zh)[index]?.startsWith('previewShell.')).join(' '))
  && !/Pretender|3\.0/.test(Object.values(en).filter((_, index) => Object.keys(en)[index]?.startsWith('previewShell.')).join(' ')),
  'E2 Preview 文案继续冻结内部品牌/版本号');
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(shell), 'E3 Preview 领域自身保持零 HTML 字符串注入');

console.log(`\nPRETENDER TASK SHEET STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
