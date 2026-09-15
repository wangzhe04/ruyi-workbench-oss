#!/usr/bin/env node
'use strict';

// 静态锁（第 124 波 P2 · 40 号文 §2 ②「我当初交办的是什么？」）：**委托书带**的结构性纪律。
//
// 行为由 thread-commission.browser.e2e.js 在真浏览器里跑出来验；本件只钉那些「跑起来看不见、
// 坏了也不会红」的结构约定：
//
//   ① **位置即判据**（§5 的 P2 反向：「把委托书插到第二条 → 红」）。委托书是线程头【下面第一条】
//      系统消息，所以 index.html 里 #threadCommission 必须排在 #missionBar／#autonomyBar／
//      #stepBar／#messages **全部之前**。这条锁钉的是位置，不是「存在」——「它在页面上」这件事
//      任何一次误插都仍然成立，而「它排第一」一插错就塌。
//   ② **零二次解析**：前端不许把 `brief.supplement` 拿正则拆回字段。拼它的是 06i 的
//      buildStewardBrief（「目标：」「验收项：」那几行），界面原样印；在这边再写一份解析器，
//      就是本仓已经栽过四次的「第二份判据」。
//   ③ **原话逐字**：目标那一格只许 textContent 直赋 `brief.userText`，不许截断、不许改写
//      （截断只允许发生在折叠态那一行的摘录 threadCommissionGist 上）。
//   ④ **单一时间出口**：委托书要印「多久以前」必须走 stewardAgoLabel（全仓那一个），
//      不许在本模块里 new 第二个 Intl.RelativeTimeFormat / 拼第二种时间写法
//      （124-P1 的 J8 在抽屉那面钉的是同一条）。
//   ⑤ **零请求**：thread-head.js 的头注红线「本模块不发任何取数请求」不许被委托书破掉 ——
//      `session.brief` 就在 state.currentSession 上（13d 的 GET /api/sessions/:id 原样回整个
//      session），本模块里 api( 的调用点只许是既有那一处（管家条开关的 PATCH）。
//   ⑥ **委托书的写口只有 13k 一处**：`session.brief =` 在 src/ 里恰一次（13k-steward-threads.js
//      的 steward_thread_new）。它是「目标那一格印的就是用户原话」这句话的前提 —— 哪天多一处
//      写口，牌子就开始说别人的话。同款模具见 124-P1 的容器验收项单写入口锁。
//   ⑦ **不与 116-5b 的线程自动摘要同名**：那一族叫 threadBrief（`session.threadBrief`、
//      settings.steward.threadBrief、thread-brief.static.e2e.js），是「自动给线程起名字」，
//      与委托书没有半点关系。界面侧一律 commission，两族在 index.html／CSS／locale 三处零交叉。
//   ⑧ **九条文案键四份 locale 齐备**，且插值一律 {{name}}（单花括号会原样上屏 —— 124-P0 栽过）。
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
// 去掉整行注释之后的代码面。多条断言按「代码里有没有」判，而注释里恰恰会点到那些名字
// （同名陷阱、判据出处都得写下来），拿整份文本判会把说明文字当成违规。
const headCode = head.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const experience = readPub('js/session-experience.js');
const shell = readPub('js/steward-shell.js');
const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const css = readPub('css/views/chat-shell.css');

/* ── ① 位置即判据 ─────────────────────────────────────────────────────────── */
{
  const at = needle => indexHtml.indexOf(needle);
  const commission = at('id="threadCommission"');
  const after = [
    ['#missionBar', at('id="missionBar"')],
    ['#autonomyBar', at('id="autonomyBar"')],
    ['#stepBar', at('id="stepBar"')],
    ['#messages', at('id="messages"')],
  ];
  ok(commission > 0, '①a index.html 有委托书带 #threadCommission');
  ok(commission > 0 && at('id="threadHead"') > 0 && at('id="threadHead"') < commission,
    '①b 它排在线程头 #threadHead 【之后】（是「线程头下」那一条，不是线程头自己的一行）');
  const later = after.filter(([, index]) => index > 0 && index < commission).map(([name]) => name);
  ok(later.length === 0,
    `①c 它排在 ${after.map(([name]) => name).join('／')} 全部【之前】${later.length ? '（实得排在 ' + later.join('／') + ' 之后）' : ''}`);
}

/* ── ①d 班组视角一起收 ────────────────────────────────────────────────────── */
{
  // 「看原件」跳的落点就是 #messages，而主视图切到班组（data-main-view=canvas）时 #messages
  // 是 display:none 的。留着带、藏着落点 ＝ 一枚点了没反应的按钮，所以委托书带必须跟着一起收，
  // 且规则要写在【主视图状态机那一处】（workbench.css），不许在别的层再开第二份。
  const workbench = readPub('css/views/workbench.css');
  const chatShell = css;
  ok(/\.chat-pane\[data-main-view="canvas"\] > #threadCommission,/.test(workbench),
    '①d 班组视角下委托书带跟着对话三件套一起收（规则在主视图状态机那一处）');
  ok(!/data-main-view/.test(chatShell),
    '①d2 chat-shell.css 里零 data-main-view —— 状态机没长出第二处');
}

/* ── ② 零二次解析 ─────────────────────────────────────────────────────────── */
{
  // 判「本模块有没有去拆 supplement」：supplement 只许被原样赋给 textContent，不许进正则／split。
  const lines = head.split('\n').filter(line => !line.trim().startsWith('//') && /supplement/i.test(line));
  const parsing = lines.filter(line => /\.split\(|\.match\(|RegExp|\/\^|exec\(|indexOf\(/.test(line));
  ok(parsing.length === 0, `② 委托书不二次解析管家补充（实得 ${parsing.length} 行在拆它）`);
  ok(/supplement\.textContent\s*=\s*\w+\.supplement/.test(head),
    '②b 管家补充【原样】上屏（textContent 直赋，零改写）');
}

/* ── ③ 原话逐字 ───────────────────────────────────────────────────────────── */
{
  ok(/goal\.textContent\s*=\s*\w+\.userText;/.test(head),
    '③a 目标那一格是 brief.userText 逐字（不 slice、不 replace）');
  ok(/threadCommissionGist\(/.test(head) && /export function threadCommissionGist/.test(head),
    '③b 截断只发生在折叠态摘录 threadCommissionGist 上，且它是可单测的导出纯函数');
}

/* ── ④ 单一时间出口 ───────────────────────────────────────────────────────── */
{
  ok(/import \{[^}]*stewardAgoLabel[^}]*\} from '\.\/steward-conversation\.js';/.test(head),
    '④a 时间人话 import 自全仓那一个出口 stewardAgoLabel');
  ok(!/Intl\.RelativeTimeFormat/.test(head) && !/toLocaleString|toLocaleDateString|toLocaleTimeString/.test(head),
    '④b 本模块里零第二种时间写法（无 Intl.RelativeTimeFormat、无 toLocale*）');
}

/* ── ⑤ 零请求 ─────────────────────────────────────────────────────────────── */
{
  const calls = (headCode.match(/\bapi\(/g) || []).length;
  ok(calls === 1, `⑤ thread-head.js 里 api( 恰一处（管家条开关那一发 PATCH），实得 ${calls}`);
  // 委托书这一段自己零请求。切片必须真的切到东西 —— 切不到就是函数被改名了，那时这条断言会
  // 静默变成「对空串求值」＝ 永远绿，所以先把切片长度本身断言出来（本仓踩过的空洞断言模具）。
  const commissionBody = headCode.slice(headCode.indexOf('function renderCommission('));
  ok(commissionBody.length > 400, '⑤b0 renderCommission( 在文件里找得到（切片非空，本条不是空洞断言）');
  ok(commissionBody.length > 400 && !/\bapi\(/.test(commissionBody),
    '⑤b 委托书这一段自己零请求（brief 随会话头下发，不为它多发一发）');
}

/* ── ⑥ 委托书写口只有 13k 一处 ────────────────────────────────────────────── */
{
  const files = fs.readdirSync(SRC).filter(name => name.endsWith('.js'));
  const writers = files.filter(name => /(^|[^\w.])session\.brief\s*=/.test(readSrc(name)));
  ok(writers.length === 1 && writers[0] === '13k-steward-threads.js',
    `⑥ 委托书的写入口全仓恰一处（13k-steward-threads.js），实得 ${JSON.stringify(writers)}`);
}

/* ── ⑦ 不与 116-5b 的线程自动摘要同名 ─────────────────────────────────────── */
{
  // 钉的是【带的命名】，不是整份文件：index.html 里本来就有 116-5b 那一族自己的控件与文案键
  // （#cfgStewardThreadBrief / settings.steward.threadBrief*），它们理应留在那儿。
  ok(!/id="threadBrief/.test(indexHtml) && !/thread-brief/.test(indexHtml),
    '⑦a 委托书带不叫 threadBrief（零 id="threadBrief…"、零 thread-brief 类名）');
  ok(/id="cfgStewardThreadBrief"/.test(indexHtml) && /settings\.steward\.threadBrief"/.test(indexHtml),
    '⑦a2 而 116-5b 摘要那一族的控件与文案键原样还在（改名不许误伤它）');
  ok(!/thread-brief/.test(css) && /\.thread-commission\b/.test(css),
    '⑦b CSS 用 .thread-commission，零 .thread-brief');
  // 按【代码】判，不按注释判：本模块的头注里刻意点了 session.threadBrief 的名（那处同名陷阱
  // 必须写下来），拿整份文本去 test 会把那句注释当成违规。
  ok(/session\.brief/.test(headCode) && !/session\.threadBrief/.test(headCode),
    '⑦c 线程头读的是委托书 session.brief，从不去读摘要 session.threadBrief');
}

/* ── ⑧ 九条文案键四份 locale 齐备 ─────────────────────────────────────────── */
{
  const KEYS = [
    'threadCommission.label', 'threadCommission.original', 'threadCommission.goal',
    'threadCommission.supplement', 'threadCommission.startedAt', 'threadCommission.bySteward',
    'threadCommission.runner', 'threadCommission.runnerModel', 'threadCommission.runnerModelOnly',
    'threadCommission.originalFolded',   // 124 走查 B：第一条消息折起来时那一行提示
  ];
  const LOCALES = [
    path.join(PUBLIC, 'locales', 'zh-CN.json'), path.join(PUBLIC, 'locales', 'en-US.json'),
    path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json'), path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json'),
  ];
  const missing = [];
  const singleBrace = [];
  for (const file of LOCALES) {
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of KEYS) {
      const value = catalog[key];
      if (typeof value !== 'string' || !value) { missing.push(path.basename(file) + ':' + key); continue; }
      // 本仓 t() 的插值是 {{name}}：单花括号会原样上屏（124-P0 的 locale 教训）。
      if (/(^|[^{])\{[\w.]+\}([^}]|$)/.test(value)) singleBrace.push(path.basename(file) + ':' + key);
    }
  }
  ok(missing.length === 0, `⑧a 九条键四份 locale 齐备（缺 ${missing.length}${missing.length ? '：' + missing.join('、') : ''}）`);
  ok(singleBrace.length === 0, `⑧b 插值一律 {{name}}（单花括号 ${singleBrace.length} 处）`);
  // 界面上出现的每一个 threadCommission.* 键都必须在词表里（反过来：词表里不许有没人用的死键）。
  // 三个消费面：骨架（index.html）、带本体（thread-head.js）、124 走查 B 那一行折叠提示
  // （session-experience.js —— 折叠住在会话域，因为它要跟着 renderCurrentSession 走）。
  const used = [...new Set([indexHtml, head, experience]
    .flatMap(text => [...text.matchAll(/threadCommission\.[\w.]+/g)].map(m => m[0])))];
  ok(used.length === KEYS.length && used.every(key => KEYS.includes(key)),
    `⑧c 界面用到的键与锁上这 ${KEYS.length} 条逐条对齐（实得 ${used.length} 条：${used.join('、')}）`);
}

/* ── ⑧b 124 走查 B：折的是显示，不是数据 ─────────────────────────────────────
   用户 2026-09-15 三选一选了 B：有委托书带时第一条用户消息折成一行，点「看原件」才展开。
   这一组钉三件「坏了也不会红」的事：
     · 折叠判据只认 `session.brief.userText`（用户自己开的线程没有委托书，一个字都不该被折）；
     · 折叠状态按【线程】记（存 sessionId，不是布尔）—— 换线程自然失效，换回来重新折起；
     · **不许去动 session.messages**：折的是显示层，回退／检查点／复制读的仍是同一条消息。 */
{
  const foldFn = experience.slice(experience.indexOf('function shouldFoldOriginal('));
  ok(foldFn.length > 80, '⑧b0 shouldFoldOriginal( 在文件里找得到（切片非空，本组不是空洞断言）');
  ok(foldFn.includes('threadCommissionOriginalText(session)') && foldFn.includes('!originalUnfoldedIn.has('),
    '⑧b 折叠判据＝有委托书 ＆ 这条线程还没被展开过（按 sessionId 表记，不是单个游标）');
  const unfoldMark = "originalUnfoldedIn.add(String((session && session.id) || ''));";
  ok(experience.includes(unfoldMark)
    && experience.indexOf(unfoldMark)
       < experience.indexOf('if (windowStartFor(msgs) > 0) {', experience.indexOf('function revealOriginalMessage(')),
    '⑧b2 展开先记状态【再】重画（反过来的话 renderCurrentSession 会照旧把它折回去）');
  ok(experience.includes("row.classList.toggle('is-original-folded', foldOriginal);"),
    '⑧b3 用 toggle 不是 add（行按 renderSignature 复用，上一拍展开过的那一份会原样再进来）');
  const renderBlock = experience.slice(experience.indexOf('const foldOriginal ='), experience.indexOf('fragment.appendChild(row);', experience.indexOf('const foldOriginal =')));
  ok(renderBlock.length > 80 && !renderBlock.includes('.messages') && !renderBlock.includes('splice'),
    '⑧b4 折叠那一段一个字都没动 session.messages（折的是显示，不是数据）');
  ok(css.includes('#messages .message.is-original-folded .bubble { display: none; }')
    && css.includes('content: attr(data-folded-hint);'),
    '⑧b5 样式层只取 attr()（i18n 留在 JS 一侧，CSS 里零中文文案）');
}

/* ── ⑨ 「看原件」的落点：注入链完整，且它是 expandMessageWindowFully 的调用方 ── */
{
  ok(/function revealOriginalMessage\(/.test(experience) && /expandMessageWindowFully\(\);/.test(
    experience.slice(experience.indexOf('function revealOriginalMessage('))),
    '⑨a 落点住 session-experience.js，且真的走那条「指定回落」把消息窗全展开');
  ok(/\n    revealOriginalMessage,/.test(experience), '⑨b 它在会话域的冻结导出里');
  ok(/revealOriginalMessage,/.test(app), '⑨c 组合根把它递进管家域');
  ok(/revealOriginalMessage = null,/.test(shell) && /revealOriginal: typeof revealOriginalMessage === 'function'/.test(shell),
    '⑨d 管家壳只转交（拿不到就递 null，线程头据此把按钮整枚藏掉，不画点了没反应的）');
  ok(/revealOriginal = null,/.test(head) && /typeof revealOriginal !== 'function'/.test(head),
    '⑨e 线程头拿不到落点时按钮 hidden');
}

console.log('');
if (failures) { console.log(`THREAD COMMISSION STATIC E2E: ${failures} FAILURE(S)`); process.exit(1); }
console.log('THREAD COMMISSION STATIC E2E: ALL PASS');
process.exit(0);
