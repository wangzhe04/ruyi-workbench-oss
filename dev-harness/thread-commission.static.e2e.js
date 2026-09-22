#!/usr/bin/env node
'use strict';

// 静态锁（第 124 波 P2 立、2026-09-22 用户拍板改写）：**委托书横幅已整条退役，折叠块保留**。
//
// 退役的口径（用户原话）：「委托书本身删掉吧，会话中会有委托消息历史保留的记录」——
// 线程头下那条 #threadCommission 横幅（DOM、renderCommission、「看原件」注入链、.thread-commission
// 样式、15 条 threadCommission.* 文案键）整条拆除；委托内容本来就留在历史第一条消息里，
// 气泡内那个 <details class="brief-fence"> 折叠块（132a）是它现在【唯一】的界面形态。
//
// 本锁钉两个方向：
//   ① **退役不回潮**：横幅的 DOM／渲染函数／注入链／CSS／文案键在四份 locale 与五个源码面
//      全部清零；主视图状态机（workbench.css）里那枚 #threadCommission 选择器也一并收走
//      （留着它 = 对一个不存在的元素开规则，更是「下次谁把横幅加回来一半」的藏身处）。
//   ② **折叠块还在、纪律没破**：判据只认 session.brief.userText ＋ 正文以它开头 ＋ 含围栏；
//      改的是显示不是数据（session.messages 一个字不动）；summary 的两条文案键四份 locale 齐备；
//      服务端 `session.brief =` 写口仍恰 13k 一处（折叠块印的就是用户原话这句话的前提）。
//
// 判定行：`THREAD COMMISSION STATIC E2E: ALL PASS`。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const readPub = rel => fs.readFileSync(path.join(PUBLIC, ...rel.split('/')), 'utf8');
const readSrc = name => fs.readFileSync(path.join(SRC, name), 'utf8');

let failures = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.log('FAIL ' + label); }
}

const indexHtml = readPub('index.html');
const head = readPub('js/thread-head.js');
// 去掉整行注释之后的代码面。多条断言按「代码里有没有」判，而注释里恰恰会点到那些名字。
const headCode = head.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const experience = readPub('js/session-experience.js');
const experienceCode = experience.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const shell = readPub('js/steward-shell.js');
const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const css = readPub('css/views/chat-shell.css');
const workbench = readPub('css/views/workbench.css');
const LOCALES = [
  path.join(PUBLIC, 'locales', 'zh-CN.json'), path.join(PUBLIC, 'locales', 'en-US.json'),
  path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json'), path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json'),
];

/* ── ① 退役不回潮 ─────────────────────────────────────────────────────────── */
{
  ok(!/id="threadCommission/.test(indexHtml), '①a index.html 里 #threadCommission 横幅 DOM 已清零');
  ok(!/renderCommission|threadCommissionOf|threadCommissionGist|THREAD_COMMISSION_/.test(headCode),
    '①b thread-head.js 里横幅渲染族（renderCommission/threadCommissionOf/…）已清零');
  ok(!/revealOriginal|originalRevealedFor|original-toggled/.test(headCode)
    && !/revealOriginal|originalRevealedFor|original-toggled/.test(app)
    && !/revealOriginal|originalRevealedFor|original-toggled/.test(shell)
    && !/revealOriginal|originalRevealedFor|original-toggled/.test(experienceCode),
    '①c 「看原件」注入链（experience→app→shell→thread-head）与 ruyi:original-toggled 事件已清零');
  ok(!/\.thread-commission\b|\.tc-caret|is-revealed|ruyi-reveal-flash/.test(css),
    '①d chat-shell.css 里 .thread-commission 一族与「看原件」闪烁样式已清零');
  ok(!/#threadCommission/.test(workbench),
    '①e workbench.css 主视图状态机里那枚 #threadCommission 选择器已收走');
  const RETIRED_KEYS = [
    'threadCommission.label', 'threadCommission.original', 'threadCommission.goal',
    'threadCommission.supplement', 'threadCommission.startedAt', 'threadCommission.bySteward',
    'threadCommission.runner', 'threadCommission.runnerModel', 'threadCommission.runnerModelOnly',
    'threadCommission.originalHide', 'threadCommission.acceptance', 'threadCommission.context',
    'threadCommission.preferences', 'threadCommission.constraints', 'threadCommission.count',
  ];
  const lingering = [];
  for (const file of LOCALES) {
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of RETIRED_KEYS) if (key in catalog) lingering.push(path.basename(file) + ':' + key);
  }
  ok(lingering.length === 0, `①f 15 条退役文案键四份 locale 清零（残留 ${lingering.length}${lingering.length ? '：' + lingering.join('、') : ''}）`);
}

/* ── ② 折叠块还在、纪律没破 ───────────────────────────────────────────────── */
{
  // 切片封到下一个函数定义为止 —— 不切住的话，后半份文件里别的 session.messages 读口
  // 会被误算进「改画那一段」（空洞/越界切片都是本仓栽过的模具）。
  const decorateStart = experience.indexOf('function decorateCommissionedFirstMessage(');
  const decorate = experience.slice(decorateStart, experience.indexOf('function isFirstRun('));
  ok(decorate.length > 200, '②a decorateCommissionedFirstMessage( 在文件里找得到（切片非空，本组不是空洞断言）');
  const gate = experience.slice(experience.indexOf('function commissionedFirstMessage('), experience.indexOf('function decorateCommissionedFirstMessage('));
  ok(gate.includes('threadCommissionOriginalText(session)') && gate.includes('content.startsWith(userText)') && gate.includes('content.includes(COMMISSION_FENCE_OPEN)'),
    '②b 判据＝有委托书 ＆ 正文以原话开头 ＆ 含围栏（三者缺一不改画）');
  ok(decorate.includes("bubble.textContent = info.userText;") && decorate.includes("fence.className = 'brief-fence';") && decorate.includes("pre.textContent = info.supplement;"),
    '②c 气泡正文只印原话，补充逐字放进 details 的 <pre>（不拼围栏标签）');
  ok(!decorate.includes('.messages') && !decorate.includes('splice') && !decorate.includes('message.content ='),
    '②d 改画那一段一个字都没动 session.messages（改的是显示，不是数据）');
  ok(decorate.includes('originalOpenIn.add(id)') && decorate.includes('originalOpenIn.delete(id)'),
    '②e 开合状态按【线程】记（sessionId 表），点 summary 即开合');
  ok(css.includes('#messages .message .bubble .brief-fence'),
    '②f 折叠块样式在场（brief-fence 一族）');
  const FENCE_KEYS = ['threadCommission.fenceSummary', 'threadCommission.fenceSummaryPlain'];
  const missing = [];
  const singleBrace = [];
  for (const file of LOCALES) {
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of FENCE_KEYS) {
      const value = catalog[key];
      if (typeof value !== 'string' || !value) { missing.push(path.basename(file) + ':' + key); continue; }
      if (/(^|[^{])\{[\w.]+\}([^}]|$)/.test(value)) singleBrace.push(path.basename(file) + ':' + key);
    }
  }
  ok(missing.length === 0, `②g 折叠块两条 summary 键四份 locale 齐备（缺 ${missing.length}）`);
  ok(singleBrace.length === 0, `②h 插值一律 {{name}}（单花括号 ${singleBrace.length} 处）`);
  // 界面上还活着的 threadCommission.* 键只能有这两条 —— 反过来钉死 ①f 的「删干净」。
  const used = [...new Set([indexHtml, head, experience]
    .flatMap(text => [...text.matchAll(/threadCommission\.[\w.]+/g)].map(m => m[0])))];
  ok(used.length === FENCE_KEYS.length && used.every(key => FENCE_KEYS.includes(key)),
    `②i 界面用到的 threadCommission.* 键只剩折叠块这两条（实得 ${used.length} 条：${used.join('、')}）`);
}

/* ── ③ 委托书写口只有 13k 一处（与横幅无关的前提锁，124-P2 ⑥ 原样保留）───────── */
{
  const files = fs.readdirSync(SRC).filter(name => name.endsWith('.js'));
  const writers = files.filter(name => /(^|[^\w.])session\.brief\s*=/.test(readSrc(name)));
  ok(writers.length === 1 && writers[0] === '13k-steward-threads.js',
    `③ 委托书的写入口全仓恰一处（13k-steward-threads.js），实得 ${JSON.stringify(writers)}`);
}

/* ── ④ thread-head 头注红线不破：零请求、不读摘要 ───────────────────────────── */
{
  const calls = (headCode.match(/\bapi\(/g) || []).length;
  ok(calls === 1, `④a thread-head.js 里 api( 恰一处（管家条开关那一发 PATCH），实得 ${calls}`);
  ok(!/session\.brief/.test(headCode) && !/session\.threadBrief/.test(headCode),
    '④b 横幅退役后线程头两个 brief 都不读（委托书唯一的界面消费面是会话域那个折叠块）');
}

console.log('');
if (failures) { console.log(`THREAD COMMISSION STATIC E2E: ${failures} FAILURE(S)`); process.exit(1); }
console.log('THREAD COMMISSION STATIC E2E: ALL PASS');
process.exit(0);
