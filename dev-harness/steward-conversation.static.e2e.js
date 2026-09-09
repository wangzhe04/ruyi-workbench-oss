#!/usr/bin/env node
'use strict';

// 第117波 117c 静态契约（27 号文 §5 117c 行／§8.4「话＋一行按钮」／§8.9「空状态与首次／每次打开」／
// §8.12「递话」）：管家对话区与输入区的机械口径。
//   A 零 innerHTML / 零第三方 import；
//   B 按钮行契约 ≤3（常量 + 渲染处的 slice 锚）与主动作唯一（全文件恰好一处 .is-primary）；
//   C 禁词表（速问／不立单／已切到档位／Pretender／3.0）零出现；
//   D 预判去抖 + 序号丢弃；
//   E 撤回窄窗 10 秒 + 「先 stop 再 rewind」的顺序锚；
//   F 两个 CustomEvent 事件名是导出常量；
//   G i18n 三组键中英对称；
//   H 新样式层三处登记 + 零硬编码色 + reduced-motion + 390px；
//   I timer 门控延续 117b：倒计时住 conversation、去抖住 composer，各自恰好一处且有对应 clear，
//     steward-shell.js 仍然「全文件恰好一处 setInterval」（C2a 原样通过）。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const html = read('index.html');
const conversation = read('js/steward-conversation.js');
const composer = read('js/steward-composer.js');
const chips = read('js/steward-chips.js');
const stewardShell = read('js/steward-shell.js');
const css = read('css/views/steward-conversation.css');
const styles = read('styles.css');
const zh = JSON.parse(read('locales/zh-CN.json'));
const en = JSON.parse(read('locales/en-US.json'));
const overlay = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');
const readFrontendCss = fs.readFileSync(path.join(__dirname, 'read-frontend-css.js'), 'utf8');

// 注释里要写清楚「零 innerHTML」「界面不出现『速问』」这些纪律本身，所以扫禁词与扫危险 API 时
// 必须先把注释剥掉 —— 否则写下纪律的那一行会把自己判红。两个模块里没有任何字符串含 `//`，
// 因此「块注释 + 行注释到行尾」这种朴素剥法在这里是安全的。
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const conversationCode = stripComments(conversation);
const composerCode = stripComments(composer);
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {

// ─── A 零 innerHTML、import 只在本域内 ────────────────────────────────────────────
for (const [name, source] of [['steward-conversation.js', conversationCode], ['steward-composer.js', composerCode]]) {
  ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(source),
    `A1 ${name} 零 innerHTML/insertAdjacentHTML/document.write`);
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
  ok(imports.every(spec => spec.startsWith('./')), `A2 ${name} 的 import 全部是本域内相对路径（零第三方库）`);
}
// 117n-M1 重钉：el()/button() 搬进 steward-chips.js 集中定义（六个消费方零本地重复）之后，
// conversation.js 自己不再直接调 .createElement——但它仍然只经从 chips.js import 的共享
// el()/button() 生成节点，createElement 本体仍可在 chips.js 里查证。原判据只证明「某处调过
// createElement」；新判据在此之上再加一条正面证据（零本地重复定义），是更强而不是更弱的版本。
ok(/textContent/.test(conversation)
  && /createElement\(/.test(chips)
  && !/function el\(tag, className, text\) \{/.test(conversation)
  && !/function button\(className, text, onClick\) \{/.test(conversation)
  && !/const doc = \(\) => globalThis\.document \|\| null;/.test(conversationCode)
  && !/const byId = id => \(doc\(\) \? doc\(\)\.getElementById\(id\) : null\);/.test(conversationCode),
  'A3 对话流的节点创建委托给 steward-chips.js 共享的 el()/button()（117n-M1 去重）：零本地重复定义，createElement 仍可在 chips.js 里查证（零 innerHTML 的证据没消失，只是搬了家）');
// A3b companion：composer.js 同样去重（doc/byId/el），不定义第二份。
ok(/import \{ stewardEscapeStack, doc, byId, el \} from '\.\/steward-chips\.js';/.test(composer)
  && !/const doc = \(\) => globalThis\.document \|\| null;/.test(composerCode)
  && !/const byId = id => \(doc\(\) \? doc\(\)\.getElementById\(id\) : null\);/.test(composerCode)
  && !/function el\(tag, className, text\) \{/.test(composerCode),
  'A3c steward-composer.js 的 doc/byId/el 也从 steward-chips.js import，零本地重复定义');

// ─── B 按钮行契约：≤3 且主动作唯一 ───────────────────────────────────────────────
const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-conversation.js')).href);
ok(mod.STEWARD_ACTS_MAX === 3, `B1 STEWARD_ACTS_MAX === 3（实测 ${mod.STEWARD_ACTS_MAX}）`);
ok(/const list = \(Array\.isArray\(acts\) \? acts : \[\]\)\.slice\(0, STEWARD_ACTS_MAX\);/.test(conversation),
  'B2 渲染 acts 时按 STEWARD_ACTS_MAX 截断（一行按钮永远 ≤3）');
const primarySites = (conversation.match(/'is-primary'/g) || []).length;   // 只该出现在常量声明那一行
ok(primarySites === 1 && !/is-primary/.test(composer),
  `B3 主动作类名全文件恰好一处，且只在对话模块里（实测 conversation=${primarySites}）`);
ok(/if \(act && act\.primary === true && !primaryTaken\) \{ btn\.classList\.add\(STEWARD_PRIMARY_CLASS\); primaryTaken = true; \}/.test(conversation)
  && mod.STEWARD_PRIMARY_CLASS === 'is-primary',
  'B4 主动作只给第一个 primary（第二个 primary 一律降为安静按钮），类名是唯一的导出常量');
ok(/\.steward-act\.is-primary \{/.test(css), 'B5 CSS 里 .is-primary 是唯一的主动作视觉档');

// ─── C 禁词：界面不出现系统标签，也不提前暴露内部代号 ────────────────────────────
// locale 一侧只查 stewardShell.* 命名空间：「速问」是【交办台预览壳】(previewShell.*) 自己的产品词
// （previewShell.quickAsk 等 5 条既有键），不是管家壳的系统标签，不该被本件连坐。
const FORBIDDEN = [/速问/, /不立单/, /已切到档位/, /Pretender/, /3\.0/];
for (const pattern of FORBIDDEN) {
  ok(!pattern.test(conversationCode) && !pattern.test(composerCode) && !pattern.test(cssCode),
    `C1 两模块与样式层零出现 ${pattern.source}`);
}
const stewardKeys = Object.keys(zh).filter(key => key.startsWith('stewardShell.'));
for (const pattern of FORBIDDEN) {
  ok(stewardKeys.every(key => !pattern.test(String(zh[key])) && !pattern.test(String(en[key]))),
    `C2 stewardShell.* 文案零出现 ${pattern.source}`);
}
for (const pattern of FORBIDDEN) {
  ok(!pattern.test(html), `C3 index.html 零出现 ${pattern.source}`);
}

// ─── D 输入即预判：去抖 + 序号丢弃 ───────────────────────────────────────────────
ok(/export const STEWARD_PREROUTE_DEBOUNCE_MS = 150;/.test(composer),
  'D1 预判去抖窗口是 150ms 的导出常量');
ok(/debounceTimer = setTimeout\(\(\) => \{ debounceTimer = 0; runPreroute\(text\); \}, STEWARD_PREROUTE_DEBOUNCE_MS\);/.test(composer),
  'D2 去抖用的是 STEWARD_PREROUTE_DEBOUNCE_MS，不是散落的字面量');
ok(/const seq = \+\+prerouteSeq;/.test(composer) && /if \(seq !== prerouteSeq\) return;/.test(composer),
  'D3 预判请求带序号，过期响应直接丢弃（慢的那一次不许覆盖新判定）');
ok(/if \(!isStewardMode\(\)\) return;/.test(composer)
  && /if \(!\(state && state\.config && state\.config\.stewardEnabledV1 === true\)\) return;/.test(composer),
  'D4 预判受「管家模式 + 管家开关」双重门控（非管家模式零请求，延续 117b 纪律）');
ok(/api\(`\/api\/steward\/preroute\?q=\$\{encodeURIComponent\(query\)\}`\)/.test(composer),
  'D5 预判走既有的 GET /api/steward/preroute（后端零改动）');
// 117l D1（用户第四轮走查②「无论关键词匹配到什么，都要发给管家让它决定」）：预判从「目标」降级
// 成「提示」。修前 currentTarget() 把 routeHits[0] 当目标返回，submit() 于是直递 —— 用户说
// 「大A这周走势会怎么样」被「走势」命中美股那条线程，一句新话把它正在等的提问 supersede 掉。
ok(/function currentTarget\(\) \{\s*return picked;/.test(composer),
  'D6 currentTarget() 只回 picked —— 自动预判永远不是递送目标');
ok(/function hintedThread\(\) \{/.test(composer)
  && /if \(routeKind === 'thread' && routeHits\.length\) \{/.test(composer)
  && /label\.textContent = t\('stewardShell\.compose\.targetSteward\.hint', \{ title: hint\.title \}\);/.test(composer),
  'D6b 预判命中只用来显示 chip 上那句「像是接着『X』」（hintedThread 一处判定）');
ok(/if \(target\) await conversation\.handOff\(/.test(composer)
  && /else await conversation\.sendToSteward\(text, \{ routeHint: routeHintPayload\(\) \}\);/.test(composer),
  'D6c companion：**手选的目标仍然直递**（那是用户明示），其余一律经管家并带上 routeHint');
ok(/hits: routeHits\.slice\(0, 3\)\.map\(hit => \(\{ sessionId: String\(\(hit && hit\.sessionId\) \|\| ''\), reason: String\(\(hit && hit\.reason\) \|\| ''\) \}\)\)/.test(composer)
  && !/displayTitle/.test(composer.slice(composer.indexOf('function routeHintPayload'), composer.indexOf('function renderChip'))),
  'D6d routeHint 只带 sessionId 与命中理由，≤3 条 —— 标题一个字都不进请求（服务端自己重查）');
ok(/const hint = \(opts && opts\.routeHint && typeof opts\.routeHint === 'object'\) \? opts\.routeHint : null;/.test(conversation)
  && /body: JSON\.stringify\(\{ message, \.\.\.\(hint \? \{ routeHint: hint \} : \{\}\) \}\)/.test(conversation),
  'D7 routeHint 与用户那句话分开走请求体（用户消息逐字不动）；没有 hint 时这个键整个不出现');
ok(!/sending/.test(composerCode),
  'D8 输入区不再有「上一句没发完就不许再发」的闸（走查⑥：第二句此前被无声丢弃）');

// ─── D9/D10 117r-D3（用户第八轮走查②「关键词匹配……最好不要和输入框放同一行，会把输入框内容
// 挤没」「而且匹配的没法删掉/关掉」）：三条根因逐条钉。①③是本文件能扫的机械口径；②（chip 挪到
// 输入框上面一行）是纯样式改动，靠 steward-conversation.e2e.js 的真实浏览器宽度断言与截图核验。
ok(/import \{ stewardShortTitle \} from '\.\/steward-conversation\.js';/.test(composer),
  'D9 复用 steward-conversation.js 的 stewardShortTitle（STEWARD_TITLE_MAX=24），不在本文件里另起一份截断函数');
ok(/if \(hint\) hint\.title = stewardShortTitle\(hint\.title\);/.test(composerCode),
  'D9b 自动预判（hintedThread 命中）的标题在塞进 chip 之前过 stewardShortTitle —— 不再原样吐一整句用户的话');
ok(/label\.textContent = t\('stewardShell\.compose\.targetThread', \{ title: stewardShortTitle\(target\.title\)/.test(composerCode),
  'D9c 手选目标（target/picked）的标题同样过 stewardShortTitle —— ①的截短对两条分支都成立');
ok(/const active = Boolean\(target \|\| hint\);/.test(composerCode)
  && /if \(clear\) clear\.hidden = !active;/.test(composerCode)
  && !/clear\.hidden = !picked/.test(composerCode),
  'D10 × 的显隐判据是「手选或自动命中，两者之一就有东西可撤」，不再只看 picked（修前自动命中的提示没有关闭出口）');
ok(/if \(hintedThread\(\)\) \{[\s\S]{0,120}hintDismissed = true;/.test(composerCode),
  'D10b 点 × 撤自动预判：routeKind/routeHits/routeReason 清空，并置 hintDismissed（「用户已经否掉这一次预判」的状态位）');
ok(/if \(hintDismissed\) return;/.test(composerCode)
  && composerCode.indexOf('if (hintDismissed) return;') < composerCode.indexOf('routeKind = String(result.kind'),
  'D10c runPreroute 响应回来时先看 hintDismissed —— 否掉之后不会随后续输入自己把 chip 变回去');
// 排掉 `let hintDismissed = false;` 那处声明本身（否则声明单独一条就能把这条断言撑到 1，
// 数不出「真的复位了几处」）——三个消费点都是裸赋值 `hintDismissed = false;`，前面不带 `let `。
ok((composerCode.match(/(?<!let )hintDismissed = false;/g) || []).length >= 3,
  'D10d hintDismissed 至少三处复位（runPreroute 空查询分支／resetComposer／submit 的 finally）——用户重打一句新的话，预判要正常回来');

// ─── E 撤回：10 秒窄窗 + 先 stop 再 rewind ───────────────────────────────────────
ok(mod.STEWARD_UNDO_WINDOW_MS === 10000 && /export const STEWARD_UNDO_WINDOW_MS = 10000;/.test(conversation),
  'E1 撤回窄窗是 10 秒的导出常量');
const stopAt = conversation.indexOf("api('/api/stop'");
const rewindAt = conversation.indexOf("api('/api/session/rewind'");
ok(stopAt > 0 && rewindAt > stopAt,
  'E2 撤回的顺序是「先 stop 再 rewind」（还在跑的回合不停下来就回退，回退完它还会往回写）');
// 117d 第 0 步重钉（语义收紧，不是放宽）：后端补出了显式字段 undoRef.rewindTargetTurnSeq
// （= 被递那一回合的 seq，与 09-workflow 的 plannedTurnSeq 同口径），前端改为【优先读它】，
// 只有旧后端（字段缺失）才回落到原来的「undoRef.turnSeq + 1」。两条路径都锚在这里。
ok(/targetTurnSeq: target, rollbackFiles: true/.test(conversation)
  && /const explicit = undoRef && Number\(undoRef\.rewindTargetTurnSeq\);/.test(conversation)
  && /const target = Number\.isFinite\(explicit\) && explicit > 0 \? explicit : before \+ 1;/.test(conversation),
  'E3 rewind 的锚点优先取 undoRef.rewindTargetTurnSeq，缺省才回落 turnSeq + 1，并请求文件回退');
ok(/if \(!rewound \|\| rewound\.ok === false\) \{/.test(conversation),
  'E3a 回退没成真就不说「已撤回」（诚实优先；按钮行留着可重试）');
ok(/filesReverted > 0 \? t\('stewardShell\.chat\.undone'\) : t\('stewardShell\.chat\.undoneFilesKept'\)/.test(conversation),
  'E4 rewind 没回文件时如实标注（诚实优先，不假装全撤了）');
ok(/appendSteward\(t\('stewardShell\.chat\.whoInstead'\), ''\);/.test(conversation),
  'E5 撤回成功后管家追问「那递给谁？」（i18n，不调模型）');
ok(/try \{ pickTarget\(\); \} catch/.test(conversation)
  && /conversation\.setPickTargetHandler\(\(\) => composer\.openPicker\(\)\);/.test(stewardShell)
  && !/steward-composer\.js/.test(conversation),
  'E6 撤回／换一条之后就地打开候选列表，靠迟绑定回调（conversation 不 import composer）');
ok(/undoBtn\.textContent = t\('stewardShell\.chat\.switchTarget'\);/.test(conversation),
  'E7 10 秒到点同一个按钮改称「换一条」，行为仍是「先回退再递」');

// ─── F 事件名是导出常量（117d 抽屉 / 117h「现在这一件」照这两个名字接） ───────────
ok(mod.STEWARD_OPEN_THREAD_EVENT === 'steward:open-thread'
  && mod.STEWARD_FOCUS_THREAD_EVENT === 'steward:focus-thread',
  'F1 两个 CustomEvent 名是导出常量且逐字固定');
ok(/new CustomEvent\(STEWARD_OPEN_THREAD_EVENT/.test(conversation)
  && /new CustomEvent\(STEWARD_FOCUS_THREAD_EVENT/.test(conversation),
  'F2 派发处引用常量而不是字面量');
ok(mod.STEWARD_DETAILS_KEY === 'wcw.stewardDetails' && /localStorage\.setItem\(STEWARD_DETAILS_KEY/.test(conversation),
  'F3 「细节」开关记在本机 localStorage，不同步服务端');

// ─── G i18n：三组键中英对称 ─────────────────────────────────────────────────────
for (const prefix of ['stewardShell.chat.', 'stewardShell.compose.', 'stewardShell.acts.']) {
  const zhKeys = Object.keys(zh).filter(key => key.startsWith(prefix)).sort();
  const enKeys = Object.keys(en).filter(key => key.startsWith(prefix)).sort();
  ok(zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `G1 ${prefix}* 中英键对称（${zhKeys.length} 条）`);
}
// 源码里引用到的每一个 stewardShell.* 键都必须在目录里（防「界面上一片 [key] 兜底」）。
const usedKeys = [...new Set([...`${conversation}\n${composer}`.matchAll(/'(stewardShell\.[a-zA-Z0-9_.]+)'/g)].map(m => m[1]))];
const missing = usedKeys.filter(key => typeof zh[key] !== 'string' || typeof en[key] !== 'string');
ok(missing.length === 0, `G2 两模块引用的 ${usedKeys.length} 个 i18n 键中英都齐备（缺: ${missing.join(',') || '无'}）`);

// ─── H 新样式层三处登记 + token / 降级 / 窄屏 ────────────────────────────────────
ok(styles.includes('@import url("/css/views/steward-conversation.css");')
  && html.includes('<link rel="stylesheet" href="/css/views/steward-conversation.css" />'),
  'H1 styles.css @import 与 index.html 直链同步收录 steward-conversation.css');
ok(readFrontendCss.includes("'css/views/steward-conversation.css',"),
  'H2 read-frontend-css.js 的 CSS_PAYLOAD_GROUPS 收录 steward-conversation.css');
ok(overlay.includes("'app/public/css/views/steward-conversation.css'")
  && overlay.includes("'app/public/js/steward-conversation.js'")
  && overlay.includes("'app/public/js/steward-composer.js'"),
  'H3 离线包清单收录 117c 的三个新文件');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'H4 对话层 CSS 全部使用主题/语义 token，无硬编码色值');
ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.steward-typing-dot \{ animation: none;/.test(css),
  'H5 reduced-motion 下「···」占位退化为静态');
ok(/@media \(max-width: 390px\)/.test(css), 'H6 390px 窄屏断点存在');
ok(/\.steward-typing/.test(css) && !/spinner|rotate\(/.test(css),
  'H7 思考占位是「···」而不是转圈（§8.4 末句）');

// ─── I timer 门控：倒计时住 conversation、去抖住 composer，各一处且有对应 clear ────
const count = (source, pattern) => (source.match(pattern) || []).length;
ok(count(conversation, /setInterval\(/g) === 1 && count(conversation, /clearInterval\(/g) === 1,
  'I1 steward-conversation.js 恰好一处 setInterval（撤回倒计时）与一处 clearInterval');
ok(count(conversation, /setTimeout\(/g) === 0, 'I2 steward-conversation.js 零 setTimeout');
ok(count(composer, /setTimeout\(/g) === 1 && count(composer, /clearTimeout\(/g) === 1,
  'I3 steward-composer.js 恰好一处 setTimeout（预判去抖）与一处 clearTimeout');
ok(count(composer, /setInterval\(/g) === 0, 'I4 steward-composer.js 零 setInterval');
ok(count(stewardShell, /setInterval\(/g) === 1,
  'I5 steward-shell.js 仍然全文件恰好一处 setInterval（117b 的 C2a 未被 117c 稀释）');
ok(/function startUndoCountdown\(btn, onExpire\) \{\s*stopUndoCountdown\(\);/.test(conversation)
  && /undoTimer = setInterval\(/.test(conversation)
  && /stopUndoCountdown\(\);\s*onExpire\(\);/.test(conversation),
  'I6 倒计时只在一次真实递话后起，且到点自清（不会有「没递话却在跑的计时器」）');
ok(/function resetConversation\(\) \{\s*entered = false;\s*stopUndoCountdown\(\);\s*\}/.test(conversation)
  && /function resetComposer\(\) \{\s*cancelPreroute\(\);\s*prerouteSeq \+= 1;/.test(composer),
  'I7 离开管家壳时两个模块各自收摊（倒计时清掉、去抖清掉、在途预判作废）');
ok(/if \(isStewardMode\(\)\) conversation\.ensureVisit\(\);\s*else \{ conversation\.resetConversation\(\); composer\.resetComposer\(\); \}/.test(stewardShell),
  'I8 进壳即到访、出壳即收摊，由 steward-shell.js 的模式观察者单点驱动');
ok(/function ensureVisit\(\) \{\s*if \(entered\) return null;\s*entered = true;\s*return enterVisit\(\);\s*\}/.test(conversation)
  && /function resetConversation\(\) \{\s*entered = false;\s*stopUndoCountdown\(\);\s*\}/.test(conversation),
  'I9 一次进壳只到访一次（config 每次刷新都会重跑准入判定，不能把正在进行的对话清屏重画）');

// ─── J 后端零改动：只用 116 已有的路由 ──────────────────────────────────────────
const routes = [...new Set([...`${conversation}\n${composer}`.matchAll(/'(\/api\/[a-z/]+)'/g)].map(m => m[1]))].sort();
// 117s-H2 补一条 `/api/sessions/`（＋ encodeURIComponent(sessionId)）：交付卡取线程原文用的是
// **13d 早就有的**那条会话信封（`GET /api/sessions/:id`，返回 { ok, session, resumable, displayTitle }，
// session.messages 就是整份消息）。本条断言钉的是「零新增后端面」——它仍然成立：新增的是一个
// 【既有】路由的消费者，不是一个新路由。
const ALLOWED = ['/api/session/rewind', '/api/sessions/', '/api/sessions/steward', '/api/steward/act', '/api/steward/message', '/api/steward/visit', '/api/stop'];
ok(JSON.stringify(routes) === JSON.stringify(ALLOWED),
  `J1 只调 116 已有的路由，零新增后端面（实测 ${JSON.stringify(routes)}）`);
ok(/import \{ authHeaders \} from '\.\/net\.js';/.test(conversation)
  && count(conversation, /\bfetch\(/g) === 1
  && count(composer, /\bfetch\(/g) === 0,
  'J2 唯一的直调 fetch 是 /api/steward/message 的 NDJSON 流（api() 吃不下流），鉴权头复用 net.js');
ok(/const reader = res\.body\.getReader\(\);/.test(conversation) && /new TextDecoder\(\)/.test(conversation),
  'J3 读流部分照 chat-stream-runtime.js 的 reader 循环（同形 NDJSON）');

// ─── K 错误文案：结构化 error 对象绝不 String() 直落（117e 第 0 步，117d 登记项 ②）─────────
// 后端的失败信封有两种形状：域层裸串 `error:'not_found'` 与路由层 normalizeApiErrorPayload 归一出来的
// `error:{code,message,params}`。原来一律 `String(error)`，结构化那一支在界面上就是「[object Object]」。
// 两个导出的纯函数各司其职：stewardErrorCode 取机器码查人话表，stewardErrorText 取 message‖error‖code。
ok(typeof mod.stewardErrorText === 'function' && typeof mod.stewardErrorCode === 'function',
  'K1 stewardErrorText / stewardErrorCode 是导出的纯函数');
ok(mod.stewardErrorText({ code: 'x.y', message: '端点连不上' }) === '端点连不上'
  && mod.stewardErrorText({ error: 'not_found' }) === 'not_found'
  && mod.stewardErrorText({ code: 'only_code' }) === 'only_code'
  && mod.stewardErrorText({ error: { code: 'a', message: '里层的话' } }) === '里层的话'
  && mod.stewardErrorText('裸串') === '裸串'
  && mod.stewardErrorText(null) === '',
  'K2 stewardErrorText 取 message ‖ error ‖ code（对象套娃再递归一次），永不吐 [object Object]');
ok(mod.stewardErrorCode({ code: 'steward.busy' }) === 'steward.busy'
  && mod.stewardErrorCode({ error: 'version_conflict' }) === 'version_conflict'
  && mod.stewardActErrorKey({ code: 'version_conflict', message: '版本冲突' }) === 'stewardShell.chat.errConflict',
  'K3 结构化 error 也能查到人话键（stewardActErrorKey 走 stewardErrorCode，不走 String）');
// 源码锚：errGeneric 的每一处调用都必须把 error 值交给 stewardErrorText。
const errGenericArgs = [...conversationCode.matchAll(/t\('stewardShell\.chat\.errGeneric', \{ error: ([^}]+)\}\)/g)]
  .map(match => match[1].trim());
ok(errGenericArgs.length >= 5 && errGenericArgs.every(arg => arg.startsWith('stewardErrorText(')),
  `K4 errGeneric 的每一处调用都过 stewardErrorText（实测 ${JSON.stringify(errGenericArgs)}）`);
// 两个纯函数之外（它们内部本来就要 String 兜底非对象值），全模块零 `String(<含 error 的表达式>)`。
const afterHelpers = conversationCode.slice(conversationCode.indexOf('export function stewardActErrorKey'));
ok(!/String\([^)]*\berror\b/.test(afterHelpers),
  'K5 两个纯函数之外零 String(<error 值>)（结构化对象绝不直落文案）');

// ─── L 117l：连发队列（D3）与 ※ 的两个小标题（D5）────────────────────────────────
// 修前 sendToSteward 的第一行是 `if (!message || streaming) return null;` —— 管家还在流的时候
// 用户再说一句，那句话不上屏、不排队、不报错，只是没了（用户第四轮走查⑥）。
ok(mod.STEWARD_SEND_QUEUE_MAX === 5 && /export const STEWARD_SEND_QUEUE_MAX = 5;/.test(conversation),
  `L1 连发队列上限是导出常量 5（实测 ${mod.STEWARD_SEND_QUEUE_MAX}）`);
// 扫的是【剥掉注释】的源码：修法头注里逐字引用了那一行坏代码（「修前这里是 …」），
// 不剥注释的话写下修法的那一行会把自己判红（与本件顶部 stripComments 同一条理由）。
ok(!/if \(!message \|\| streaming\) return null;/.test(conversationCode),
  'L2 「正在流就静默丢弃」那一行已经不在了');
ok(/if \(streaming\) \{[\s\S]{0,320}const row = appendUser\(message\);\s*markQueued\(row, true\);\s*sendQueue\.push\(/.test(conversation),
  'L3 在流时第二句【立刻上屏】并入队（不是丢掉，也不是等发完再画）');
ok(/if \(sendQueue\.length >= STEWARD_SEND_QUEUE_MAX\) \{ composerNote\(t\('stewardShell\.chat\.queueFull'\)\); return null; \}/.test(conversation),
  'L4 超过上限时在输入框旁如实说一句，而不是继续往里堆');
ok(/function drainQueue\(\) \{\s*const next = sendQueue\.shift\(\);/.test(conversation)
  && /drainQueue\(\);\s*\}\s*\}\s*\n\s*function finishReply/.test(conversation),
  'L5 当前这条流的 finally 里 shift 下一条（按序发，不并发）');
ok(/row\.classList\.toggle\('is-queued', on === true\);/.test(conversation)
  && /\.steward-msg-user\.is-queued \{/.test(cssCode),
  'L6 排队中的行带 is-queued，样式层有对应的淡化档');
ok(/const tag = el\('span', 'steward-queued', t\('stewardShell\.chat\.queued'\)\);/.test(conversation)
  && /tag\.setAttribute\('aria-label', t\('stewardShell\.chat\.queued'\)\);/.test(conversation),
  'L6b 「排队中」是真节点（读屏念得到），不是 CSS 生成内容');
ok(/if \(!isStewardMode\(\)\) \{[\s\S]{0,300}for \(const row of \[next, \.\.\.sendQueue\]\) markQueued\(row\.row, false\);\s*sendQueue\.length = 0;/.test(conversation),
  'L7 人已经离开管家壳就不再替他把排队的话发出去（清队列，并把每一行的「排队中」小标摘掉）');
// D5：※ 浮层的两个小标题，各自只在对应内容非空时渲染。
ok(/pop\.appendChild\(el\('h4', 'steward-why-h', t\('stewardShell\.chat\.whyHeading'\)\)\);/.test(conversation)
  && /pop\.appendChild\(el\('h4', 'steward-why-h', t\('stewardShell\.chat\.whyDone'\)\)\);/.test(conversation),
  'L8 ※ 浮层里「依据」「已办」两个小标题（用户第四轮走查④）');
ok(/if \(whyLines\.length\) \{/.test(conversation) && /if \(doneRows\.length\) \{/.test(conversation)
  && /if \(!whyLines\.length && !doneRows\.length\) pop\.appendChild\(el\('p', 'steward-why-line', t\('stewardShell\.chat\.whyEmpty'\)\)\);/.test(conversation),
  'L8b 两段各自只在有内容时才渲染；两段都空时仍是那句「这一条没有更多依据」');
ok(/appendSteward\(t\('stewardShell\.chat\.handedOff', \{ title: label \}\), String\(reason \|\| ''\), \[\],/.test(conversation),
  'L8c 「其它候选」走【依据】那一段，不会被扣上「已办」的帽子（分段之后的必然要求）');
ok(/\.steward-why-h \{/.test(cssCode), 'L9 样式层有 .steward-why-h');
ok(/\.steward-composer-note:empty \{ display: none; \}/.test(cssCode)
  && html.includes('id="stewardComposerNote"'),
  'L10 输入区那行小字有骨架，且空的时候不占位');

// ─── M 117l-B2：菜单锚点（③）、对话流分组与降噪（④）、steward.queued 的人话（⑤）────────
// ③ 用户第五轮走查 3「为啥点 Avatar，显示面板是在最上面，怎么也得要么在下面要么在上面吧」。
//   117k 把菜单锚在【顶栏】下沿（.steward-menu 的 top:100%/left:0），而 117j W2-3 之后头像跟着
//   最新一条管家的话走 —— 头像在屏幕下半截、菜单还钉在最上面。现在按头像的 rect 定位。
ok(!/top: 100%;/.test(cssCode) && !/\.steward-menu \{[^}]*position: absolute;/.test(cssCode)
  && /\.steward-menu \{[\s\S]{0,600}position: fixed;/.test(cssCode),
  'M1 .steward-menu 不再有 top:100% 那个顶栏锚点，改成 fixed（锚点由 JS 按头像 rect 逐次写行内样式）');
ok(/\.steward-menu\[hidden\] \{ display: none; \}/.test(cssCode),
  'M1b companion：117k 那道 [hidden] 守卫原样还在（作者 display:flex 仍会压过 UA 表）');
ok(/const rect = avatar\.getBoundingClientRect\(\);/.test(conversation)
  && /function placeMenu\(\) \{/.test(conversation),
  'M2 打开时读的是【头像】的 getBoundingClientRect()，不是顶栏的');
ok(/const below = \(viewport - rect\.bottom\) >= \(height \+ STEWARD_MENU_GAP\);/.test(conversation)
  && /menu\.style\.top = `\$\{Math\.round\(rect\.bottom \+ STEWARD_MENU_GAP\)\}px`;/.test(conversation)
  && /menu\.style\.bottom = `\$\{Math\.round\(viewport - rect\.top \+ STEWARD_MENU_GAP\)\}px`;/.test(conversation),
  'M3 有上下翻转分支：下方够放就开下方，不够就开上方（底缘贴住头像顶）');
ok(mod.STEWARD_MENU_GAP === 8 && /export const STEWARD_MENU_GAP = 8;/.test(conversation),
  `M3b 空隙是导出常量，定位与「放不放得下」的判定读同一个数（实测 ${mod.STEWARD_MENU_GAP}）`);
ok(/const menuHost = byId\('stewardShell'\);/.test(conversation)
  && !/header\.appendChild\(menu\)/.test(conversationCode),
  'M4 菜单挂在 #stewardShell 上：#stewardStage 有 backdrop-filter(给 fixed 后代造包含块)＋overflow:hidden(会切掉菜单)');
ok(/const closeMenuOnViewportChange = \(\) => \{ if \(!menu\.hidden\) closeMenu\(\); \};/.test(conversation)
  && /addEventListener\('resize', closeMenuOnViewportChange\)/.test(conversation)
  && /feedForMenu\.addEventListener\('scroll', closeMenuOnViewportChange\)/.test(conversation),
  'M5 开着时窗口 resize／对话流 scroll 即关（关着时两个监听一件事都不做）');
ok(/releaseMenuEscape = stewardEscapeStack\.push\(closeMenu,/.test(conversation)
  && /avatar\.setAttribute\('aria-controls', menu\.id\)/.test(conversation),
  'M5b companion：117k 的 Esc 栈与 owns 判定原样保留（只改了锚点，没改开合契约）');

// ④ 用户第五轮走查 4「Ruyi 说的话…现在这种很多轮的看起来有点奇怪，尤其是边边那个点」。
ok(!/\.steward-avslot:empty::before/.test(cssCode),
  'M6 历史消息的空槽不再画那个 8px 灰点（十几轮之后左边一列点，用户说的就是它）');
ok(/function markGroup\(row, kind\) \{/.test(conversation)
  && /row\.classList\.add\('is-group-end'\);/.test(conversation)
  && /else row\.classList\.add\('is-group-start'\);/.test(conversation)
  && /if \(sameSpeaker\) previous\.classList\.remove\('is-group-end'\);/.test(conversation),
  'M7 is-group-start / is-group-end 在 appendRow 时按【前一行的角色】维护（追加式，不重排整条流）');
ok(/markGroup\(row, kind\);/.test(conversation)
  && /function markStale\(current\) \{/.test(conversation)
  && /row\.classList\.toggle\('is-stale', stale\);/.test(conversation)
  && /markStale\(row\);/.test(conversation),
  'M7b 三个类都在 JS 里一处维护：组界靠 markGroup，「不是最新那条」靠 markStale(判据＝头像在谁那儿)');
ok(/\.steward-msg-ruyi:not\(\.is-group-start\.is-group-end\)::before \{/.test(cssCode)
  && /\.steward-msg-ruyi\.is-group-start:not\(:has\(~ \.steward-msg-ruyi\.is-group-start\)\)::before,/.test(cssCode),
  'M8 组的左侧竖线只画给多行组；头像所在的【最新那一组】整组不画（头像本身就是锚）');
ok(/\.steward-msg-ruyi\.is-stale \.steward-act,/.test(cssCode)
  && /\.steward-msg-ruyi\.is-stale \.steward-act\.is-primary \{/.test(cssCode)
  && /\.steward-act\.is-primary \{/.test(cssCode),
  'M9 旧行的 act 降成幽灵档，最新那一条仍是金底主按钮（.is-primary 那条原样在）');
ok(!/is-stale[\s\S]{0,200}(disabled|pointer-events: none)/.test(cssCode),
  'M9b companion：降噪只改样式 —— 没有 disabled、没有 pointer-events:none，旧行的按钮照样可点');
ok(/\.steward-feed \{[\s\S]{0,200}gap: var\(--sp-1\);/.test(cssCode)
  && /\.steward-msg \{ margin-top: var\(--sp-3\); \}/.test(cssCode)
  && /\.steward-msg-ruyi:not\(\.is-group-start\) \{ margin-top: 0; \}/.test(cssCode),
  'M10 组内 --sp-1、组间 --sp-1+--sp-3＝原来的 --sp-4：组与组之间的间距一个像素没变，用户气泡不进组内档');

// ⑤ A1-fix（56f8c2b）的第五条通道：线程还排在仲裁器队列里时递话 → 409 steward.queued。
ok(/'steward\.queued': 'stewardShell\.chat\.errQueued',/.test(conversation)
  && mod.stewardActErrorKey({ code: 'steward.queued' }) === 'stewardShell.chat.errQueued',
  'M11 steward.queued 有自己的人话键（它不是 steward.busy：忙＝插不进去，排队＝还没轮到它开跑）');
ok(mod.stewardQueuedWaitLabel({ code: 'steward.queued', params: { wait: { reason: 'lock', label: '等锁：同一个文件夹被「X」占着' } } }) === '等锁：同一个文件夹被「X」占着'
  && mod.stewardQueuedWaitLabel({ code: 'steward.queued', wait: { label: '等并发位' } }) === '等并发位'
  && mod.stewardQueuedWaitLabel({ error: { code: 'steward.queued', params: { wait: { label: '等预算' } } } }) === '等预算'
  && mod.stewardQueuedWaitLabel({ code: 'steward.queued' }) === ''
  && mod.stewardQueuedWaitLabel(null) === '',
  'M11b wait.label 只取不编：三种落点都找得到，一个都没有就回空串');
ok(mod.stewardActErrorMessage({ code: 'steward.queued', params: { wait: { label: '等锁' } } }, (key, params) => `${key}|${params && params.wait}`) === 'stewardShell.chat.errQueued|等锁'
  && mod.stewardActErrorMessage({ code: 'steward.queued' }, key => key) === 'stewardShell.chat.errQueuedPlain'
  && mod.stewardActErrorMessage({ code: 'steward.busy' }, key => key) === 'stewardShell.chat.errBusy'
  && mod.stewardActErrorMessage({ code: '不在表里' }, key => key) === '',
  'M11c 取不到 wait 就换成不带括号的那一句；表外仍回空串(由调用方落到 errGeneric，原始 error 原样带出去)');
for (const key of ['stewardShell.chat.errQueued', 'stewardShell.chat.errQueuedPlain']) {
  ok(typeof zh[key] === 'string' && zh[key].length > 0 && typeof en[key] === 'string' && en[key].length > 0,
    `M12 locale 键 ${key} 中英齐备`);
}
ok(/\{\{wait\}\}/.test(String(zh['stewardShell.chat.errQueued'])) && /\{\{wait\}\}/.test(String(en['stewardShell.chat.errQueued']))
  && !/\{\{wait\}\}/.test(String(zh['stewardShell.chat.errQueuedPlain'])) && !/\{\{wait\}\}/.test(String(en['stewardShell.chat.errQueuedPlain'])),
  'M12b 带括号的那句有 {{wait}} 插值、不带括号的那句没有(否则界面会出现一对空括号)');
const drawerSrc = read('js/steward-drawer.js');
ok(/if \(code === 'steward\.queued'\) \{/.test(drawerSrc)
  && /t\('stewardShell\.chat\.errQueued', \{ wait: label \}\) : t\('stewardShell\.chat\.errQueuedPlain'\)/.test(drawerSrc),
  'M13 抽屉「直接对这条线程说」走 relay 时读同两个键，不把服务端原文塞进「没做成：…」的模板');

// ─── L 117m-A6：中文输入法的候选词回车不许把半句话发出去 ────────────────
// 管家壳的输入框漏了输入法守卫（审查报回）：经典壳与抽屉两处都有 !event.isComposing，
// 唯独管家 composer 没有 —— 中文用户选候选词按回车会把未完成的句子直接发给管家。
// 这是中文优先的产品，这两条钉住「每一处回车发送都带输入法守卫」。
const enterSendLines = [
  ...composerCode.split(String.fromCharCode(10)),
  ...stripComments(read('js/steward-drawer.js')).split(String.fromCharCode(10)),
].filter(line => line.includes("event.key === 'Enter'") || line.includes("event.key !== 'Enter'"));
ok(enterSendLines.length === 3, 'L1 管家壳里回车发送的输入框恰好三处(composer + 抽屉两个)');
ok(enterSendLines.every(line => line.includes("isComposing")),
  'L2 每一处回车发送都带 !event.isComposing(中文候选词回车不误发)');

// ─── N 117s-C：管家的话走【注入的】共享渲染器（27 号文 §11.13 D5，用户第九轮走查⑦）──────────
// 修前 steward-conversation.js:20 的纪律是「零 innerHTML，全部 textContent」，于是模型写的
// `## 结论先行`、`**偏空**`、列表、代码围栏、mermaid 全部原样上屏。全仓唯一的 markdown＋XSS 净化
// 路径是 chat-render-primitives.js（renderMarkdownInto 里那一处 innerHTML 是它自己的），管家壳要的
// 不是新渲染器，是同一条注入线再接一根 —— 所以下面这一组钉的是「注入，不是 import」。
const appSrc = read('app.js');
ok(/renderMarkdownInto = null,/.test(conversation) && /highlightIn = null,/.test(conversation),
  'N1 对话区把两个渲染器作为【可选】依赖收下，缺席时默认 null（Node 里 await import 本模块那条路照常走得通）');
ok(/if \(typeof renderMarkdownInto !== 'function'\) \{ node\.textContent = say; return node; \}/.test(conversationCode)
  && /catch \{ node\.textContent = say; \}/.test(conversationCode),
  'N2 没有渲染器（或渲染器抛了）就回落 textContent —— 话一定说得出来，不会留空节点');
// 两条都把「行首（只允许缩进）」写进正则：注释掉的那一行（`  // …renderMarkdownInto, highlightIn,`）
// 因此【不】算数 —— 反向验证时注释掉这一行本条必须立刻转红，否则这条锁形同虚设。
ok(/createStewardShellDomain\(\{[\s\S]{0,2000}\n\s+renderMarkdownInto, highlightIn,/.test(appSrc)
  && /createStewardConversation\(\{[\s\S]{0,1200}\n\s+renderMarkdownInto, highlightIn,/.test(stewardShell),
  'N3 注入线：组合根 app.js → steward-shell.js → steward-conversation.js（三段都是注入，零 import）');
// A1/A2 已经钉了「零 innerHTML」与「import 全是本域内相对路径」；这里再钉一次「本波没有偷偷加 import」。
ok(!/from '\.\/chat-render-primitives\.js'/.test(conversation) && !/from '\.\/chat-render-primitives\.js'/.test(stewardShell),
  'N3b 两个文件都【没有】直接 import 渲染器（走注入＝与经典壳六个消费面同一份，不长出第二条净化通道）');
// say 的三个上屏口（追加、流式重写、终态）全部经 paintSay；流式那一路不每片都跑高亮。
const paintCalls = (conversationCode.match(/paintSay\(/g) || []).length;
ok(/function paintSay\(node, text, \{ highlight = true \} = \{\}\)/.test(conversation) && paintCalls >= 5,
  `N4 say 的上屏收在一个 paintSay 里（实测 ${paintCalls} 处出现：定义 + 追加/流式/终态两支）`);
ok(/paintSay\(sayNode, say, \{ highlight: false \}\);/.test(conversationCode),
  'N4b 流式那一路只渲染 markdown、不每个分片都跑 highlightIn（代码高亮与 mermaid 留到终态一次）');
// ※ 里的依据与行动行是【机器回执】，不许被 markdown 吃掉；用户气泡是用户原话，同理。
ok(/pop\.appendChild\(el\('p', 'steward-why-line', line\)\);/.test(conversationCode)
  && !/paintSay\([^)]*why/.test(conversationCode),
  'N5 ※ 浮层里的依据行仍然是 el()+textContent（机器回执不进 markdown）');
ok(/function actionWhyLines\(actions\) \{/.test(conversation) && !/paintSay\([^)]*action/i.test(conversationCode),
  'N5b 行动行（actionWhyLines）只产字符串、只进 ※ 的纯文本行，不经渲染器');
ok(/function appendUser\(text\) \{\s*const row = appendRow\('user'\);\s*if \(!row\) return null;\s*row\.appendChild\(el\('p', 'steward-say', String\(text \|\| ''\)\)\);/.test(conversation),
  'N5c 用户气泡仍是 textContent（用户原话逐字不动，不被 markdown 重排）');

// ─── O 117s-C：来源小头「来自线程『X』」（用户第九轮走查⑦「返回消息没有区分」）────────────
// 落盘的 message.steward.trigger 只有 'user'/'inbox' 两个字面量（13h stewardStampReply 盖的章就这
// 一个字段，来源线程 id【不在】里面），所以来源取自同一回合那条 meta.origin==='inbox' 的系统消息
// —— 13h stewardEventLine 写的「线程「标题」(sess_…)」。下面是那支解析的真值表（纯函数、零 DOM）。
ok(typeof mod.stewardInboxSource === 'function', 'O1 stewardInboxSource 是导出的纯函数');
const inboxLine = '[收件箱] 这是工作台的 1 条系统事件:\n- [7] thread_done · 线程「周报-W36」(sess_abc123) · 收工了';
ok(JSON.stringify(mod.stewardInboxSource(inboxLine)) === JSON.stringify({ sessionId: 'sess_abc123', title: '周报-W36' }),
  `O2 带显示名的事件行取到 id 与显示名（实测 ${JSON.stringify(mod.stewardInboxSource(inboxLine))}）`);
ok(JSON.stringify(mod.stewardInboxSource('- [8] thread_failed · 线程 sess_9f0 · 挂了')) === JSON.stringify({ sessionId: 'sess_9f0', title: '' }),
  'O3 没有显示名时（13h 那条「线程 <id>」的回落）仍取得到 id，标题留空');
ok(mod.stewardInboxSource('用户自己说的一句话，跟任何线索无关') === null
  && mod.stewardInboxSource('') === null && mod.stewardInboxSource(null) === null,
  'O4 认不出来源就回 null —— 宁可不加小头，也不编一个来源出来');
ok(mod.stewardInboxSource('线程「x」(' + 'a'.repeat(65) + ')') === null,
  'O5 越界的 id 不认（与服务端 safeSessionId 的 1..64 同一把尺）');
ok(/if \(stamp && stamp\.trigger === 'inbox'\) \{/.test(conversation),
  `O6 小头只加给 trigger==='inbox' 的那一条（用户自己问的那条不加）`);
ok(/const chip = button\('steward-source', label, \(\) => focusThread\(source\.sessionId\)\);/.test(conversation),
  'O7 点小头走的是既有的 steward:focus-thread（focusThread 一处派发，不新增第二条聚焦通道）');
for (const key of ['stewardShell.chat.fromThread']) {
  ok(typeof zh[key] === 'string' && zh[key].includes('{{title}}')
    && typeof en[key] === 'string' && en[key].includes('{{title}}'),
    `O8 locale 键 ${key} 中英齐备且带 {{title}} 插值`);
}
ok(/\.steward-say\.md \{/.test(cssCode) && /white-space: normal;/.test(cssCode) && /\.steward-source \{/.test(cssCode),
  'O9 样式层有 markdown 排版与来源小头两组规则（取值同源 chat-narrative.css 的 .md 族）');




// ─── P 117s-H2/H4：交付卡（27 号文 §11.13.3 H2「用户看原件，管家只加批注」）───────────────
// 摸底结论：管家【读了】、时机也对，但 say 硬切 600 字 —— 2687 字的交付被压成 407 字的二手货。
// 所以收件箱触发的那条回复里嵌线程自己的交付原文。下面钉的是「必须成立的事」，不是某一行长什么样。
// ① 三支纯函数的真值表（零 DOM，Node 里直接跑）。
ok(typeof mod.stewardTriggerInfo === 'function' && typeof mod.stewardInboxTurnSeq === 'function'
  && typeof mod.stewardDeliverableFrom === 'function',
  'P1 三支新判据都是导出的纯函数（stewardTriggerInfo / stewardInboxTurnSeq / stewardDeliverableFrom）');
ok(JSON.stringify(mod.stewardTriggerInfo({ trigger: { kind: 'inbox', sessionId: 'sess_a', title: '周报', turnSeq: 4 } }))
    === JSON.stringify({ kind: 'inbox', sessionId: 'sess_a', title: '周报', turnSeq: 4 })
  && JSON.stringify(mod.stewardTriggerInfo({ trigger: 'inbox' }))
    === JSON.stringify({ kind: 'inbox', sessionId: '', title: '', turnSeq: 0 })
  && mod.stewardTriggerInfo({ trigger: 'user' }).kind === 'user'
  && mod.stewardTriggerInfo({}).kind === '' && mod.stewardTriggerInfo(null).kind === '',
  'P2 H4：trigger 的两种形状都认 —— 新回合的对象逐字取出，老回合的字符串照旧算数，缺席回空');
ok(mod.stewardTriggerInfo({ trigger: { kind: 'inbox', turnSeq: 0 } }).turnSeq === 0
  && mod.stewardTriggerInfo({ trigger: { kind: 'inbox', turnSeq: -3 } }).turnSeq === 0
  && mod.stewardTriggerInfo({ trigger: { kind: 'inbox', turnSeq: '7' } }).turnSeq === 7,
  'P2b 回合号越界/非正数一律归 0（调用方据此退到「最后一条助手话」，不去编一个回合号）');
ok(mod.stewardInboxTurnSeq('- [2] done · 线程「A」(sess_a) · 线程第 3 回合跑完了') === 3
  && mod.stewardInboxTurnSeq('线程第 12 回合失败(engine)') === 12
  && mod.stewardInboxTurnSeq('线程「A」(sess_a) 收工了') === 0
  && mod.stewardInboxTurnSeq('') === 0 && mod.stewardInboxTurnSeq(null) === 0,
  'P3 回合号取自 13i 那句「线程第 N 回合跑完了/失败」，取不到回 0');
const deliverSession = { messages: [
  { role: 'user', turnSeq: 1, content: '问' },
  { role: 'assistant', turnSeq: 1, content: '第一回合的答' },
  { role: 'assistant', turnSeq: 2, content: '   ' },
  { role: 'assistant', turnSeq: 3, content: '第三回合的交付' },
] };
ok(JSON.stringify(mod.stewardDeliverableFrom(deliverSession, 3)) === JSON.stringify({ text: '第三回合的交付', turnSeq: 3 })
  && JSON.stringify(mod.stewardDeliverableFrom(deliverSession, 1)) === JSON.stringify({ text: '第一回合的答', turnSeq: 1 }),
  'P4 交付＝turnSeq 对得上的那条助手话（09-workflow 落盘时每条助手消息都带 turnSeq）');
ok(JSON.stringify(mod.stewardDeliverableFrom(deliverSession, 0)) === JSON.stringify({ text: '第三回合的交付', turnSeq: 3 })
  && JSON.stringify(mod.stewardDeliverableFrom(deliverSession, 9)) === JSON.stringify({ text: '第三回合的交付', turnSeq: 3 }),
  'P4b 不知道回合号（或那一回合没落到）就退到最后一条【非空】助手话');
ok(mod.stewardDeliverableFrom({ messages: [{ role: 'user', content: '只有用户的话' }] }, 0) === null
  && mod.stewardDeliverableFrom({ messages: [{ role: 'assistant', content: '  ' }] }, 0) === null
  && mod.stewardDeliverableFrom(null, 0) === null && mod.stewardDeliverableFrom({}, 3) === null,
  'P5 一条都挑不出来就回 null —— 调用方据此画兜底那一句，绝不留一个空盒子');
ok(mod.STEWARD_DELIVERABLE_LINES === 8,
  `P5b 折叠阈值是导出常量（§11.13.3 H2「超 8 行折叠」；实测 ${mod.STEWARD_DELIVERABLE_LINES}）`);

// ② 正文必须走【同一条】渲染器：交付是线程产出的、模型写的、不可信的文本，与管家的话同一口径。
ok(/paintSay\(body, found\.text\);/.test(conversationCode),
  'P6 交付正文经 paintSay 上屏（＝注入的 renderMarkdownInto ＋ highlightIn；本模块仍然只有这一处渲染入口）');
const bodyTextWrites = (conversationCode.match(/body\.textContent = /g) || []).length;
ok(bodyTextWrites === 1 && /body\.textContent = t\('stewardShell\.chat\.deliverableMissing'\);/.test(conversationCode),
  `P6b 交付正文【唯一】那处 textContent 直写是「取不到」的兜底一句（实测 ${bodyTextWrites} 处）——`
  + '有渲染器时正文绝不走纯文本，缺席时由 paintSay 内部统一回落');

// ③ 懒：只有收件箱触发的那一行才发信封请求；且零新增路由、零新 fetch。
const attachDeliverableSites = (conversationCode.match(/attachDeliverable\(/g) || []).length;
ok(attachDeliverableSites === 2 && /if \(opening\) attachDeliverable\(row, \{ \.\.\.opening, turnSeq: trigger\.turnSeq \|\| inboxTurnSeq \}\);/.test(conversationCode),
  `P7 交付卡只在「收件箱触发且认得出来源」那一支挂（定义 1 处 + 调用 1 处，实测 ${attachDeliverableSites}）——`
  + '用户自己问的那条一发请求都不多发');
ok(/api\('\/api\/sessions\/' \+ encodeURIComponent\(sessionId\)\)/.test(conversationCode),
  'P8 取原文走【既有】的 GET /api/sessions/<id>（13d 的信封本来就带 session.messages，零新增路由）');
const fetchSites = (conversationCode.match(/\bfetch\(/g) || []).length;
ok(fetchSites === 1,
  `P8b 全文件仍然只有一处裸 fetch（NDJSON 那条流），交付卡走注入的 api()（实测 ${fetchSites} 处）`);
ok(/deliverableCache\.set\(key, task\);/.test(conversationCode)
  && /const key = String\(sessionId\) \+ '\|' \+ String\(turnSeq \|\| 0\);/.test(conversationCode)
  && /task\.catch\(\(\) => \{ deliverableCache\.delete\(key\); \}\);/.test(conversationCode),
  'P9 按 sessionId|turnSeq 在本实例里缓存（同一条线程反复出现只取一次），失败不进缓存（下次还能再试）');

// ④ import 白名单：整份名单就这三条，多一条都算越界（下面 P10/Q7d/W11 三处钉的是同一份名单，
//    所以只留一处字面量 —— 三处各写一遍是上一波留下的重复，谁改都得改三次）。
//    F5b（32 号文 §2.2.2 撤回三态）把 './icons.js' 加了进来：到期那枚「⇄」与落定那枚「✓」必须
//    从【全仓唯一那张】图标词汇表取件 —— 这正是 F5a 定的规矩「SVG 路径只许住在 icons.js」，
//    steward-board / steward-drawer / steward-settings 三个消费方走的也是这条 import。
//    本条锁因此仍然可证伪：它钉的是「除这三条之外，本文件不许再向任何域借东西」。
const CONVERSATION_IMPORTS = ['./icons.js', './net.js', './steward-chips.js'];
const conversationImports = [...conversation.matchAll(/^import .* from '([^']+)';/gm)].map(match => match[1]);
ok(JSON.stringify([...new Set(conversationImports)].sort()) === JSON.stringify(CONVERSATION_IMPORTS),
  `P10 import 只有 net.js、steward-chips.js 与 icons.js 三个本域内相对路径（实测 ${JSON.stringify([...new Set(conversationImports)].sort())}）`);
ok(/openClassicWindow = null,/.test(conversation)
  && /if \(typeof openClassicWindow === 'function'\) \{/.test(conversationCode)
  && /openThread\(id\);/.test(conversationCode)
  && !/from '\.\/steward-drawer\.js'/.test(conversation) && !/from '\.\/steward-classic-window\.js'/.test(conversation),
  'P11 「看全文」＝注入的 openClassicWindow（与抽屉同一个入口），缺席时回落既有的 steward:open-thread；'
  + '本模块不 import 抽屉/视窗模块（不长出第二条切壳通道）');
ok(/t\('stewardShell\.drawer\.fullText'\)/.test(conversationCode),
  'P11b 「看全文」与抽屉那一枚共用同一个 i18n 键（同一个词、同一个动作，不另造第二条文案）');

// ⑤ i18n 与样式层。
for (const key of ['stewardShell.chat.deliverableHead', 'stewardShell.chat.deliverableHeadPlain',
  'stewardShell.chat.deliverableLoading', 'stewardShell.chat.deliverableMissing',
  'stewardShell.chat.deliverableExpand', 'stewardShell.chat.deliverableCollapse']) {
  ok(typeof zh[key] === 'string' && zh[key].length > 0 && typeof en[key] === 'string' && en[key].length > 0,
    `P12 locale 键 ${key} 中英齐备`);
}
ok(/\{\{seq\}\}/.test(String(zh['stewardShell.chat.deliverableHead']))
  && /\{\{seq\}\}/.test(String(en['stewardShell.chat.deliverableHead']))
  && !/\{\{seq\}\}/.test(String(zh['stewardShell.chat.deliverableHeadPlain'])),
  'P12b 带回合号那句有 {{seq}} 插值、不带的那句没有（不知道回合号时界面不出现一个空的「第  回合」）');
ok(/\.steward-deliverable \{/.test(cssCode) && /\.steward-deliverable-body\.is-clamped \{ max-height:/.test(cssCode)
  && /\.steward-deliverable-body\.md \{/.test(cssCode),
  'P13 样式层有交付卡三组规则：卡本体（左描边，不是盒子）、折叠、markdown 排版（同源 .md 一族）');
const deliverableCss = cssCode.slice(cssCode.indexOf('.steward-deliverable {'));
ok(deliverableCss.length > 0 && !/transition|animation/.test(deliverableCss),
  'P13b 交付卡零 transition／零 animation（故 reduced-motion 的关闭清单一个字没加）');


// ─── Q F1 线程卡 ＋ F4 回复定型（27 号文 §11.13.1「线程即频道」；设计稿两块画板）──────────────
// 钉的是「哪件事必须成立」，不是「某一行长什么样」（32 号文 §4 第 3 条）。
// ① 三支新判据的真值表（纯函数、零 DOM，Node 里直接跑）。
ok(typeof mod.stewardThreadHue === 'function' && typeof mod.stewardThreadFacts === 'function'
  && typeof mod.stewardAgoParts === 'function' && mod.STEWARD_THREAD_HUES === 4,
  `Q1 三支新判据都是导出的纯函数，色卡是 4 色的导出常量（实测 ${mod.STEWARD_THREAD_HUES}）`);
ok([0, 1, 2, 3, 4, 7].map(mod.stewardThreadHue).join(',') === '1,2,3,4,1,4'
  && mod.stewardThreadHue(-1) === 1 && mod.stewardThreadHue('x') === 1,
  'Q1b 色号按首次出现顺序循环（第 5 条线程回到 1 号色），越界/非数一律归 1 号');
const factsOf = payload => JSON.stringify(mod.stewardThreadFacts(payload));
ok(mod.stewardThreadFacts({ relay: { channel: 'permission' } }).state === 'needs_you'
  && mod.stewardThreadFacts({ relay: { channel: 'answer' } }).state === 'needs_you'
  && mod.stewardThreadFacts({ relay: { channel: 'queued' } }).state === 'queued'
  && mod.stewardThreadFacts({ relay: { channel: 'steer' } }).state === 'running'
  && mod.stewardThreadFacts({ resumable: { live: true } }).state === 'running'
  && mod.stewardThreadFacts({ session: { turnSeq: 2, stewardLastTurn: { seq: 2, ok: false } } }).state === 'stopped'
  && mod.stewardThreadFacts({ session: { turnSeq: 2 } }).state === 'done',
  'Q2 五态只从信封上的权威字段派生：relay.channel（13h 那条递话阶梯的输出）＞ resumable.live ＞ 会话头的 stewardLastTurn/turnSeq');
ok(mod.stewardThreadFacts({ relay: { channel: 'permission' }, resumable: { live: true }, session: { turnSeq: 9 } }).state === 'needs_you'
  && mod.stewardThreadFacts({ resumable: { live: true }, session: { turnSeq: 2, stewardLastTurn: { ok: false } } }).state === 'running',
  'Q2b 优先级：等你 ＞ 在跑 ＞ 上一回合的结果（正在等你拿主意时不该说「在跑」，正在跑时不该说「上次失败了」）');
ok(mod.stewardThreadFacts({}).state === '' && mod.stewardThreadFacts(null).stateKey === ''
  && mod.stewardThreadFacts({ session: { turnSeq: 0 } }).state === '',
  'Q2c 一回合都没跑过、信封什么都没说时【不出药丸】—— 宁可少一枚药丸，不许编一个状态（§8.1 原则 2）');
ok(mod.stewardThreadFacts({ session: { turnSeq: 1 } }).stateKey === 'mission.state.done'
  && mod.stewardThreadFacts({ relay: { channel: 'queued' } }).stateKey === 'stewardShell.chat.queued',
  'Q2d 药丸人话复用全仓既有的那组键（mission.state.* ＋ 管家壳自己那句「排队中」），不新开一套词');
ok(factsOf({ displayTitle: '周报', session: { engineRoute: { model: 'q3-flash' }, updatedAt: '2026-09-09T00:00:00.000Z', turnSeq: 1 } })
    === JSON.stringify({ title: '周报', state: 'done', stateKey: 'mission.state.done', updatedAt: '2026-09-09T00:00:00.000Z', model: 'q3-flash' })
  && mod.stewardThreadFacts({ session: { turnSeq: 1, messages: [{ role: 'assistant', model: 'm-last' }] } }).model === 'm-last'
  && mod.stewardThreadFacts({ session: {} }).model === '' && mod.stewardThreadFacts({ session: {} }).title === '',
  'Q3 线程名取信封的 displayTitle（02 一处判定）；模型取会话头 engineRoute.model，缺席才回落最后一条助手消息上的 model；都取不到就空着');
const agoNow = Date.parse('2026-09-09T12:00:00.000Z');
ok(JSON.stringify(mod.stewardAgoParts('2026-09-09T11:59:40.000Z', agoNow)) === JSON.stringify({ value: -20, unit: 'second' })
  && JSON.stringify(mod.stewardAgoParts('2026-09-09T11:55:00.000Z', agoNow)) === JSON.stringify({ value: -5, unit: 'minute' })
  && JSON.stringify(mod.stewardAgoParts('2026-09-09T09:00:00.000Z', agoNow)) === JSON.stringify({ value: -3, unit: 'hour' })
  && JSON.stringify(mod.stewardAgoParts('2026-09-07T12:00:00.000Z', agoNow)) === JSON.stringify({ value: -2, unit: 'day' }),
  'Q4 「最后动静」只算出 (value, unit)，人话交给 Intl.RelativeTimeFormat 按 documentElement.lang 去说（零新增 i18n 键）');
ok(mod.stewardAgoParts('2026-09-10T12:00:00.000Z', agoNow) === null
  && mod.stewardAgoParts('', agoNow) === null && mod.stewardAgoParts(null, agoNow) === null,
  'Q4b 时间在未来、或根本没有时间戳时回 null（调用方据此整段不说，不猜一个「刚刚」出来）');
ok(/new Intl\.RelativeTimeFormat\(/.test(conversationCode)
  && !/from '\.\/preview-task-sheet\.js'/.test(conversation),
  'Q4c 相对时间走平台的 Intl，不去抄 preview-task-sheet.js 的 elapsedLabel（那一支格式化的是【时长】「3m 20s」，不是「3 分钟前」）');

// ② 颜色只从令牌来：本层【只有一处】把颜色算出来，四个色号规则各自只改 --thread-hue 指向哪一根，
//    JS 一个颜色值都不写（它只写 data-thread-hue 这个序号）。
ok(/--thread-hue-1:/.test(cssCode) && /--thread-hue-4:/.test(cssCode)
  && /--thread-sat:/.test(cssCode) && /--thread-light:/.test(cssCode)
  && /--thread-color: hsl\(var\(--thread-hue\) var\(--thread-sat\) var\(--thread-light\)\);/.test(cssCode),
  'Q5 四色是一组【色相角 + 共用饱和度/明度】的自定义属性，颜色由一条 hsl() 算出来（27 号文 §11.13.1「同明度同饱和度只换色相」）');
ok((cssCode.match(/hsl\(/g) || []).length === 1,
  `Q5b 整层【只有一处】构造颜色：换四色只需改令牌，不必改任何一条元素规则（实测 ${(cssCode.match(/hsl\(/g) || []).length} 处）`);
// 117u-G1 重钉：色号映射从「点名某一副面」（.steward-msg-ruyi.is-thread[...] ／ .steward-channel[...]）
// 挪到【属性本身】上，好让抽屉与看板写同一个 data-thread-hue 就拿到同一个色，不必再往名单里加面。
// 原判据钉的是那一条选择器长什么样；新判据钉的是两件更强的事实：① 那条规则不带任何面前缀
// （行首即 `[data-thread-hue="N"]`）；② 全层【恰好一条】—— 谁想再给某一副面开一份专用映射，
// 这一条立刻转红。反向验证：把 `.steward-channel` 那三条加回去，hits 变 2，本条即红。
for (const hue of [2, 3, 4]) {
  const mapping = new RegExp(`\\[data-thread-hue="${hue}"\\] \\{ --thread-hue: var\\(--thread-hue-${hue}\\); \\}`, 'g');
  const hits = (cssCode.match(mapping) || []).length;
  ok(hits === 1
    && new RegExp(`(^|\\n)\\[data-thread-hue="${hue}"\\] \\{ --thread-hue: var\\(--thread-hue-${hue}\\); \\}`).test(cssCode),
    `Q5c ${hue} 号色规则全层恰好一条、且与【面】无关（行首就是属性选择器），只把 --thread-hue 指到另一根令牌上，不写第二个颜色值（实测 ${hits} 条）`);
}
ok(/:root\[data-theme="dark"\] \{ --thread-sat:/.test(cssCode),
  'Q5d 深浅两档各一组饱和度/明度（月白底要压暗、墨夜底要提亮），主题层特指度更高因此还能整组覆盖');
ok(count(conversationCode, /dataset\.threadHue/g) === 1
  && !/hsl\(|rgb\(|style\.(background|color)/.test(conversationCode),
  'Q5e JS 只写色【号】（一处 dataset.threadHue），一个颜色值都不写（零行内样式、零 hsl/rgb 字面量）');

// ③ 折叠只有一处实现，两个调用方（117s-H2 的交付卡 ＋ F4 的管家正文）。
ok(count(conversationCode, /function clampIfLong\(/g) === 1
  && count(conversationCode, /function collapseToggle\(/g) === 1
  && count(conversationCode, /clampIfLong\(/g) === 3 && count(conversationCode, /collapseToggle\(/g) === 3,
  `Q6 折叠是【一处】实现两个调用方（clampIfLong ${count(conversationCode, /clampIfLong\(/g)} 处出现 = 定义 + 交付卡 + 管家正文，collapseToggle 同）`);
ok(count(conversationCode, /button\('steward-deliverable-more'/g) === 1
  && count(conversationCode, /classList\.toggle\('is-clamped'\)/g) === 1
  && count(conversationCode, /classList\.add\('is-clamped'\)/g) === 1
  && count(conversationCode, /classList\.remove\('is-clamped'\)/g) === 1,
  'Q6b 「展开」按钮、is-clamped 的加/减/翻转各自全文件恰好一处 —— 想再造一个折叠必须先动这几行');
ok(/\.steward-say\.is-clamped \{ max-height: var\(--steward-clamp-h\); overflow: hidden; \}/.test(cssCode)
  && /\.steward-deliverable-body\.is-clamped \{ max-height: var\(--steward-clamp-h\); overflow: hidden; \}/.test(cssCode)
  && (cssCode.match(/--steward-clamp-h:/g) || []).length === 1,
  'Q6c 两处折叠读同一个高度令牌（--steward-clamp-h 全层只定义一次）：改折叠高度只有一处可改');
ok(mod.STEWARD_DELIVERABLE_LINES === 8 && /clampIfLong\(node, text\)/.test(conversationCode)
  && /clampIfLong\(body, found\.text\)/.test(conversationCode),
  'Q6d 两个调用方吃的是同一个阈值常量（STEWARD_DELIVERABLE_LINES=8），没有第二个「8」');

// ④ 卡头的事实【只从信封来】：零新增路由、零新增请求、零新增 import。
const factsStart = conversationCode.indexOf('export function stewardThreadFacts');
const factsEnd = conversationCode.indexOf('export function stewardAgoParts');
const factsSlice = conversationCode.slice(factsStart, factsEnd);
ok(factsStart > 0 && factsEnd > factsStart
  && ['resumable', 'relay', 'engineRoute', 'stewardLastTurn'].every(field =>
    count(conversationCode, new RegExp(field, 'g')) === count(factsSlice, new RegExp(field, 'g'))),
  'Q7 信封上那四个字段（resumable/relay/engineRoute/stewardLastTurn）只在 stewardThreadFacts 一处读 —— 卡头的事实不许散落在渲染代码里');
ok(/const got = await loadDeliverable\(source\.sessionId, source\.turnSeq\); facts = stewardThreadFacts\(got && got\.envelope\);/.test(conversationCode)
  && /return \{ envelope: payload, deliverable: stewardDeliverableFrom\(payload && payload\.session, turnSeq\) \}/.test(conversationCode),
  'Q7b 卡头与交付原文 await 的是【同一个】被缓存的 promise（loadDeliverable 一发信封解出两样），所以请求数一发没多');
ok(JSON.stringify([...new Set([...`${conversation}\n${composer}`.matchAll(/'(\/api\/[a-z/]+)'/g)].map(m => m[1]))].sort()) === JSON.stringify(ALLOWED),
  'Q7c companion：本刀零新增后端面（路由白名单与 J1 逐字相同）');
ok(JSON.stringify([...new Set([...conversation.matchAll(/^import .* from '([^']+)';/gm)].map(m => m[1]))].sort()) === JSON.stringify(CONVERSATION_IMPORTS),
  'Q7d companion：卡头零新增 import（要的东西全在信封里，不去别的域借函数）——名单仍是 P10 那一份');

// ⑤ 线程卡与既有分组规则的关系：分组照旧，色条更强。
ok(/function markThread\(row, sessionId\) \{/.test(conversation)
  && /if \(sameThread\) previous\.classList\.remove\('is-thread-end'\);/.test(conversation)
  && /else row\.classList\.add\('is-thread-start'\);/.test(conversation),
  'Q8 线程段与说话人分组同一种追加式做法（只看前一行），三个类在 JS 里一处维护');
const markThreadSlice = conversationCode.slice(conversationCode.indexOf('function markThread'), conversationCode.indexOf('function agoLabel'));
ok(markThreadSlice.length > 0 && !/is-group/.test(markThreadSlice)
  && /\.steward-msg \{ margin-top: var\(--sp-3\); \}/.test(cssCode)
  && /\.steward-msg-ruyi:not\(\.is-group-start\) \{ margin-top: 0; \}/.test(cssCode),
  'Q8b 线程卡【不碰】分组的任何一个类，组间/组内的间距规则一个字没改（卡是叠在分组之上的一层）');
ok(/\.steward-feed \.steward-msg-ruyi\.is-thread\[data-thread\]::before \{ content: none; \}/.test(cssCode)
  && /\.steward-msg-ruyi\.is-thread::after \{/.test(cssCode)
  && /\.steward-msg-ruyi\.is-thread:not\(\.is-thread-end\)::after \{ bottom: calc\(-1 \* var\(--sp-1\)\); \}/.test(cssCode),
  'Q8c 一行只有一个锚：有色条的那几行让出那道淡竖线；色条按与竖线同一个接线法跨过组内的 --sp-1');
ok(/\.steward-say > \.is-lead \{/.test(cssCode) && /const lead = node\.firstElementChild;/.test(conversation)
  && /if \(lead && lead\.tagName === 'P'\) lead\.classList\.add\('is-lead'\);/.test(conversation),
  'Q9 首句抬成引子是【纯呈现】：只给第一个段落加一个类，不切句、不改文本、不重排 markdown 块（第一块是标题时不加）');
for (const key of ['mission.state.running', 'mission.state.needs_you', 'mission.state.done', 'mission.state.stopped',
  'stewardShell.chat.queued', 'stewardShell.acts.open']) {
  ok(typeof zh[key] === 'string' && zh[key].length > 0 && typeof en[key] === 'string' && en[key].length > 0,
    `Q10 卡头复用的既有 locale 键 ${key} 中英齐备（本刀零新增键）`);
}

// ─── W F2 频道条（27 号文 §11.14；设计稿画板「宽屏 · 线程即频道」与「窄屏」）─────────────────
// 钉的是「哪件事必须成立」（32 号文 §4 第 4 条）：
//   ① 过滤是【呈现】不是数据：零 removeChild、零请求、零存储，行数在过滤前后逐个相同；
//   ② 不建第二个判官：chip 的色号/名字/状态全从 F1 已经写在行上的那三处读；
//   ③ 不建第二个「目标」：输入区仍然只有 picked 一个，频道条走的是手选那条既有路；
//   ④ 过滤后的段首段尾重封，用的是 markThread 逐字同一条判据（只是「前一行」取可见的那一个）。
const composerMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-composer.js')).href);
const f2 = conversationCode.slice(conversationCode.indexOf('let channelFilter ='),
  conversationCode.indexOf('const deliverableCache = new Map();'));
ok(mod.STEWARD_PICK_CHANNEL_EVENT === 'steward:pick-channel'
  && composerMod.STEWARD_PICK_CHANNEL_EVENT === mod.STEWARD_PICK_CHANNEL_EVENT
  && mod.STEWARD_CHANNEL_SELF === 'steward:self',
  `W1 两个模块各持一份【同名同值】的事件常量（steward-board.js / steward-classic-window.js 对既有那两个事件就是这么做的；实测 ${mod.STEWARD_PICK_CHANNEL_EVENT} ／ ${composerMod.STEWARD_PICK_CHANNEL_EVENT}）`);
ok((conversation.match(/'steward:pick-channel'/g) || []).length === 1
  && (composer.match(/'steward:pick-channel'/g) || []).length === 1
  && /new CustomEvent\(STEWARD_PICK_CHANNEL_EVENT/.test(conversation)
  && /addEventListener\(STEWARD_PICK_CHANNEL_EVENT/.test(composer),
  'W1b 派发处与监听处都引用常量，字面量在两个文件里各自只出现在那一行导出声明上');

// ① 过滤是呈现不是数据。
const filterPath = conversationCode.slice(conversationCode.indexOf('function applyChannel()'),
  conversationCode.indexOf('function resealThreads()'));
ok(filterPath.length > 0
  && !/removeChild|\.remove\(|innerHTML/.test(filterPath)
  && !/\bapi\(|fetch\(/.test(filterPath)
  && /row\.classList\.toggle\('is-channel-out', hide\);/.test(filterPath),
  'W2 过滤这条路只 toggle 一个类：零 removeChild／零 remove()／零请求 —— 点一条 chip 之后 DOM 里的行数与点之前逐个相同');
const f2Removes = [...f2.matchAll(/removeChild\(([^)]*)\)/g)].map(match => match[1]);
ok(f2Removes.length === 2 && f2Removes.every(arg => arg === 'bar.firstChild' || arg === 'bar'),
  `W2b 频道条整段里仅有的两处 removeChild 拆的都是【频道条自己】（重画 chip ／ 一条线程都没有时整条收起），没有一处碰消息行（实测 ${JSON.stringify(f2Removes)}）`);
ok(!/localStorage|sessionStorage/.test(f2)
  && /channelFilter = '';/.test(conversationCode.slice(conversationCode.indexOf('function clearFeed()'),
    conversationCode.indexOf('function renderDigest')))
  && /channelPick = null;/.test(composerCode.slice(composerCode.indexOf('function resetComposer()'))),
  'W3 过滤【不落任何存储】，且整屏重画（clearFeed）与离开管家壳（resetComposer）各复位一次 —— 它活不过一次切壳，更活不过一次刷新');

// ② 不建第二个判官。
ok(f2.length > 0
  // 117u-G1 重钉：闭包里那个 hueOf() 已经提成模块级的 stewardThreadHueFor()，名字换了就把新名字
  // 一起钉上 —— 只留 hueOf 的话这条负向锁从此钉的是一个不存在的名字，形同虚设。
  && !/hueOf\(|stewardThreadHueFor\(|stewardThreadHue\(|stewardThreadFacts\(|loadDeliverable\(/.test(f2)
  && /row\.getAttribute\('data-thread-hue'\)/.test(f2)
  && /head\.querySelector\('\.steward-thread-name'\)/.test(f2)
  && /head\.querySelector\('\.steward-thread-state'\)/.test(f2),
  'W4 chip 的色号／名字／状态全部【从对话流的行上读】（F1 的 markThread 与卡头已经写好的那三处）：本段零 hueOf、零 stewardThreadFacts、零 loadDeliverable');
ok(count(conversationCode, /dataset\.threadHue/g) === 1 && count(f2, /data-thread-hue/g) === 2,
  `W4b companion：色号在全文件仍然只被【算并写】一次（markThread 那一行），频道条那两处是一读一抄（getAttribute ／ setAttribute），不是第二次分配（实测 ${count(f2, /data-thread-hue/g)} 处）`);

// ③ 不建第二个「目标」。
const targetDecls = (composerCode.match(/let picked\b/g) || []).length;
ok(targetDecls === 1
  && /function currentTarget\(\) \{\s*return picked;/.test(composer)
  && /if \(target\) await conversation\.handOff\(/.test(composer)
  && /else await conversation\.sendToSteward\(text, \{ routeHint: routeHintPayload\(\) \}\);/.test(composer),
  `W5 输入区仍然只有【一个】目标：picked 只声明一处（实测 ${targetDecls}），currentTarget() 只回它，两条递送分支与 117l-D1 定的逐字相同 —— 频道条走的是手选那条既有路，不是新开一条`);
ok(/channelPick = \{ sessionId: id, title: String\(title \|\| id\) \};\s*picked = channelPick;/.test(composerCode)
  && /picked = pickedBeforeChannel;/.test(composerCode)
  && /picked = channelPick;/.test(composerCode.slice(composerCode.indexOf('async function submit()'))),
  'W5b 频道条写的就是那一个 picked：进频道时记下原来的手选、退出频道原样还回去；发完一句之后 finally 摆回频道那条（屏幕还只看着某条线程、输入框却已改指如意，是自相矛盾的一帧）');
ok(!/routeHint|handOff|sendToSteward/.test(f2),
  'W5c companion：频道条这一段完全不碰递送 —— 零 routeHint、零 handOff／sendToSteward，「无论匹配到什么都发给管家让它决定」那条铁律没被本刀动过');

// ④ 重封与 markThread 同一条判据；说话人分组一个字不动。
const markThreadRule = conversationCode.slice(conversationCode.indexOf('function markThread'),
  conversationCode.indexOf('function agoLabel'));
const resealRule = conversationCode.slice(conversationCode.indexOf('function resealThreads()'),
  conversationCode.indexOf('function pickChannelTarget()'));
ok(markThreadRule.length > 0 && resealRule.length > 0
  && [markThreadRule, resealRule].every(source => /previous\.classList\.contains\('is-thread'\)/.test(source)
    && /previous\.dataset\.thread === id/.test(source)
    && /if \(sameThread\) previous\.classList\.remove\('is-thread-end'\);/.test(source)),
  'W6 过滤后的重封与追加时的 markThread 是【同一条判据】（前一行是不是同一条线程），区别只在「前一行」取的是前一个【可见】兄弟 —— 不是第二套分段规则');
ok(!/is-group/.test(f2),
  'W6b 频道条这一段【不碰】说话人分组的任何一个类：藏掉同一个人的一行不会把那一段撕开，间距反而正好收成组内档 —— 过滤后的一段线程因此仍然是一张卡');

// ⑤ i18n、样式层、看板入口、零新增面。
for (const key of ['stewardShell.channels.label', 'stewardShell.channels.only', 'stewardShell.channels.all',
  'stewardShell.channels.steward', 'stewardShell.channels.board']) {
  ok(typeof zh[key] === 'string' && zh[key].length > 0 && typeof en[key] === 'string' && en[key].length > 0,
    `W7 locale 键 ${key} 中英齐备`);
}
ok(/\.steward-msg\.is-channel-out \{ display: none; \}/.test(cssCode),
  'W8 「过滤掉的行只是不显示」在样式层就这一条规则，JS 那边只 toggle 这一个类');
ok(/\.steward-channels \{[\s\S]{0,240}position: sticky;/.test(cssCode) && !/\.steward-stage/.test(cssCode),
  'W8b 频道条钉在滚动区顶上（sticky），而本层【一个字都不碰】 .steward-stage 的网格 —— 那条 grid-template-rows 住在 steward-shell.css，从本层覆盖它就得押上「频道条永远在流」这个假设，它一被收起来整张卡的行就错位');
// 117u-G1 重钉：chip 那份专用色号映射（.steward-channel[data-thread-hue="N"] 三条）已经删了 ——
// 映射钉在属性上之后它逐条重复。新判据把「chip 自己没有任何一条色号规则」也钉进来（这比原来
// 「那三条在不在」更强：它同时挡住了「哪天又给 chip 补一份专用映射」）。
ok((cssCode.match(/hsl\(/g) || []).length === 1
  && !/\.steward-channel\[data-thread-hue/.test(cssCode)
  && /\.steward-channel-dot \{[\s\S]{0,200}background: var\(--thread-color\);/.test(cssCode),
  'W8c chip 的色点与色条读同一个 --thread-color，整层仍然只有一处 hsl()（Q5b 的口径没被本刀稀释）；且 chip 自己一条色号规则都没有 —— 色是 [data-thread-hue] 那一条与面无关的规则给的');
ok(/\.steward-msg-ruyi\.is-thread:not\(\.is-thread-start\) > \.steward-thread-head \{ display: none; \}/.test(cssCode),
  'W8d 卡头只长在【当下】的段首那一行：过滤之后段首换了人，少这一条同一条线程会露出两个卡头（看着像两张卡）');
ok(/\.steward-channel \{ min-height: 44px;/.test(cssCode.slice(cssCode.lastIndexOf('@media (max-width: 390px)')))
  && /\.steward-channels \{[\s\S]{0,420}overflow-x: auto;/.test(cssCode),
  'W8e 窄屏：chip 触达高度 ≥44px，放不下就横向滑（设计稿「窄屏」画板），不换行也不把对话区挤没');
ok(/function openBoard\(\) \{[\s\S]{0,360}byId\('stewardStatusLine'\)/.test(conversationCode)
  && /line\.getAttribute\('aria-expanded'\) === 'true'/.test(conversationCode)
  && !/from '\.\/steward-board\.js'/.test(conversation),
  'W9 「全部线程」＝点【既有的那一个】看板入口（117h 的 #stewardStatusLine），不 import steward-board.js、不新增第二条通道；已经开着就不再点一下把它关上');
ok(/bar\.setAttribute\('role', 'toolbar'\);/.test(conversationCode)
  && /bar\.setAttribute\('aria-live', 'off'\);/.test(conversationCode)
  && /if \(signature === channelSignature\) return bar;/.test(conversationCode)
  && /chip\.setAttribute\('aria-pressed', on \? 'true' : 'false'\);/.test(conversationCode),
  'W10 频道条住在 role=log 的 #stewardFeed 里：aria-live=off ＋「组成没变就不重画」两道一起挡住读屏的重复播报；选中态用 aria-pressed 说，不是只有一层颜色');
ok(JSON.stringify([...new Set([...`${conversation}\n${composer}`.matchAll(/'(\/api\/[a-z/]+)'/g)].map(m => m[1]))].sort()) === JSON.stringify(ALLOWED)
  && JSON.stringify([...new Set([...conversation.matchAll(/^import .* from '([^']+)';/gm)].map(m => m[1]))].sort()) === JSON.stringify(CONVERSATION_IMPORTS),
  'W11 companion：频道条零新增后端面、零新增 import（要的一切都已经在对话流的行上）——名单仍是 P10 那一份');

// ─── Y F5b 撤回三态（32 号文 §2.2.2；设计稿「图标集」画板第二行）────────────────────────────
// 用户对着「每秒把整段文字换成『撤回 9』『撤回 8』、位数一变按钮宽度跟着跳；到期又无声变成
// 『换一条』」确认了「对，就是这个」。改法：秒数画成环、文字恒定；到期换图标；成功退成一句话。
// 下面这一组钉的全是【机械事实】，不是文案长什么样：
//   谁在每秒被写（一个自定义属性，不是文字）／属性名两边是不是同一个／aria 契约还在不在／
//   到期那一下有没有图标／落定那句有没有对勾／图标从哪儿取／五个键在四份目录里齐不齐。
const undoTickBody = (() => {
  const at = conversationCode.indexOf('undoTimer = setInterval(');
  if (at < 0) return '';
  const end = conversationCode.indexOf('}, 1000);', at);
  return end < 0 ? '' : conversationCode.slice(at, end);
})();
const startUndoBody = (() => {
  const at = conversationCode.indexOf('function startUndoCountdown(btn, onExpire) {');
  if (at < 0) return '';
  const end = conversationCode.indexOf('}, 1000);', at);
  return end < 0 ? '' : conversationCode.slice(at, end);
})();
const paintRingBody = (() => {
  const at = conversationCode.indexOf('function paintUndoRing(face, left, total) {');
  if (at < 0) return '';
  const end = conversationCode.indexOf('\n  }', at);
  return end < 0 ? '' : conversationCode.slice(at, end);
})();
ok(undoTickBody.length > 0 && /paintUndoRing\(face, left, total\)/.test(undoTickBody)
  && !/textContent/.test(undoTickBody) && !/innerText/.test(undoTickBody),
  `Y1 倒计时那一拍【只改一个数】：tick 里调 paintUndoRing，零 textContent／innerText（实测这一拍 ${undoTickBody.length} 字符）`);
ok(paintRingBody.length > 0
  && /face\.style\.setProperty\(STEWARD_UNDO_RING_PROP, String\(ratio\)\);/.test(paintRingBody)
  && !/textContent/.test(paintRingBody),
  'Y2 每秒被写的就是那一个 0–1 的自定义属性（paintUndoRing 里零 textContent）');
ok(mod.STEWARD_UNDO_RING_PROP === '--steward-undo-left'
  && /export const STEWARD_UNDO_RING_PROP = '--steward-undo-left';/.test(conversation)
  && cssCode.includes('var(' + mod.STEWARD_UNDO_RING_PROP),
  `Y3 环由 CSS 画：JS 写的属性名与 CSS 读的是同一个（导出常量 ${mod.STEWARD_UNDO_RING_PROP}），改一边另一边立刻对不上`);
ok(startUndoBody.length > 0 && !/btn\.textContent/.test(startUndoBody)
  && /const undoBtn = button\('steward-act', t\('stewardShell\.chat\.undo'\), \(\) => \{/.test(conversationCode),
  'Y4 按钮的文字一辈子只写过一次（建它的时候那句「撤回」）：整个 startUndoCountdown 里零 btn.textContent —— 宽度不跳的根据就是这一条');
ok(/face\.setAttribute\('aria-hidden', 'true'\);/.test(conversationCode)
  && /btn\.setAttribute\('aria-label', t\('stewardShell\.chat\.undo'\)\);/.test(conversationCode)
  && !/aria-label/.test(undoTickBody),
  'Y5 copy-P2-2 的 aria 契约没被本刀稀释：环那个 span 仍是 aria-hidden，按钮 aria-label 仍固定「撤回」，且每秒那一拍连 aria 都不碰（#stewardFeed 是 aria-live 区）');
ok(/\.steward-undo-face \{[\s\S]{0,480}conic-gradient\(currentColor calc\(var\(--steward-undo-left, 1\) \* 360deg\)/.test(cssCode)
  && /\.steward-undo-face \{[\s\S]{0,480}mask: radial-gradient\(/.test(cssCode)
  && !/\.steward-undo-face \{[^}]*(?:transition|animation)/.test(cssCode),
  'Y6 环＝conic-gradient ＋ 中心挖空的 mask，且零 transition／零 animation（所以 reduced-motion 的关闭清单一个字都不用加）');
// 收尾重钉：原断言钉死了 `icon('refresh', 12)` 这个【字面量】—— 那是「锁钉文本长什么样」的反模式
// （30 号文 §8.13 ①）。要成立的事实是两件：到期那一下【插了一枚字形】，且它取自 icons.js 的唯一词汇表
// （名字必须真的在 ICONS 里 —— icon() 对未知名字只 console.warn 后返回 null，界面上会静默少一枚图标）。
// 具体挑哪一枚是设计决定，不该由锁冻结（F5b 用 refresh，收尾按语义换成 swap：换目标不是重试）。
const switchGlyph = (conversationCode.match(/const switchMark = icon\('([a-zA-Z0-9_]+)', \d+\);/) || [])[1] || '';
ok(/undoBtn\.classList\.add\('steward-act-switch'\);/.test(conversationCode)
  && Boolean(switchGlyph)
  && /undoBtn\.insertBefore\(switchMark, undoBtn\.firstChild\);/.test(conversationCode),
  `Y7 到期那一下换图标：加 .steward-act-switch ＋ 在文字【前面】插一枚 icons.js 词汇表里真有的字形（实测 ${JSON.stringify(switchGlyph)}）——【图标出现】就是那次改口的过渡（改前是文字无声地换掉）`);
ok(/function settleRow\(actsRow, text, glyph\) \{/.test(conversationCode)
  && /const mark = glyph \? icon\(glyph, 12\) : null;/.test(conversationCode)
  && /settleRow\(actsRow, filesReverted > 0 \? t\('stewardShell\.chat\.undone'\) : t\('stewardShell\.chat\.undoneFilesKept'\), 'done'\);/.test(conversationCode)
  && /settleRow\(actsRow, receiptFor\(act\)\);/.test(conversationCode)
  && /settleRow\(actsRow, t\('stewardShell\.chat\.providerSwitched', \{ provider: candidate\.id \}\)\);/.test(conversationCode),
  'Y8 第三态「✓ 已撤回」：字形是 settleRow 的【可选】第三参，只有撤回这一处传 —— 另两处回执（dismiss／换 Provider）仍是两个参数，一个字没动');
{
  const iconsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'icons.js')).href);
  const names = iconsMod.iconNames();
  // 收尾重钉：原断言写死了 refresh／done 两个名字。要成立的事实是「本模块取的每一枚字形，
  // 在 icons.js 的词汇表里都真的存在」—— icon() 对未知名字只 console.warn 后返回 null，
  // 界面上会【静默】少一枚图标，所以这条必须按模块实际取的名字来核，而不是按写稿时挑的那两个。
  // 两种取件写法都要抓：① 直接 `icon('name', …)`；② 名字先当字符串传给 settleRow 的第三参，
  // 由它内部 `icon(glyph, 12)` 间接取（撤回成功那一态就是这么走的）。只抓 ① 会把 ② 漏成盲区。
  const usedGlyphs = [
    ...[...conversation.matchAll(/\bicon\('([a-zA-Z0-9_]+)'/g)].map(m => m[1]),
    ...[...conversation.matchAll(/settleRow\([^;]*,\s*'([a-zA-Z0-9_]+)'\s*\)/g)].map(m => m[1]),
  ];
  const unknownGlyphs = usedGlyphs.filter(name => !names.includes(name));
  ok(/import \{ icon \} from '\.\/icons\.js';/.test(conversation)
    && usedGlyphs.length > 0 && unknownGlyphs.length === 0
    && !/\bd: 'M/.test(conversation) && !/createElementNS/.test(conversation),
    `Y9 本模块取的每一枚字形都在【全仓唯一那张】词汇表里（实测取了 ${JSON.stringify(usedGlyphs)}，icons.js 共 ${names.length} 枚，未知 ${JSON.stringify(unknownGlyphs)}），本文件一条 SVG path、一次 createElementNS 都没有（F5a 的「不留孤本」）`);
}
{
  const DOCS_LOCALES = path.join(ROOT, 'docs', 'i18n', 'locales');
  const catalogs = [
    ['app/zh-CN', zh], ['app/en-US', en],
    ['docs/zh-CN', JSON.parse(fs.readFileSync(path.join(DOCS_LOCALES, 'zh-CN.json'), 'utf8'))],
    ['docs/en-US', JSON.parse(fs.readFileSync(path.join(DOCS_LOCALES, 'en-US.json'), 'utf8'))],
  ];
  const undoKeys = ['undo', 'undoCountdown', 'switchTarget', 'undone', 'undoneFilesKept']
    .map(name => 'stewardShell.chat.' + name);
  const holes = catalogs.flatMap(([name, cat]) => undoKeys
    .filter(key => typeof cat[key] !== 'string').map(key => `${name}:${key}`));
  ok(holes.length === 0,
    `Y10 三态用到的 ${undoKeys.length} 个键在【四份】目录里都齐（app 与 docs 各中英；缺: ${holes.join(',') || '无'}）`);
}
ok(count(conversation, /stewardShell\.chat\.undoCountdown/g) === 1
  && /face\.title = t\('stewardShell\.chat\.undoCountdown', \{ seconds: left \}\);/.test(conversationCode),
  'Y11 undoCountdown 没成死键：秒数改写进环那枚 aria-hidden 元素的 title（鼠标停上去仍看得到「还剩几秒」，而整棵子树不在无障碍树里，读屏照旧不会每秒念一遍）');
ok(count(conversation, /setInterval\(/g) === 1 && !/\.innerHTML/.test(conversationCode),
  'Y12 companion：本刀既没多起一个计时器（仍然全文件一处 setInterval），也没开 innerHTML 的口子');

console.log(`\nSTEWARD CONVERSATION STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
