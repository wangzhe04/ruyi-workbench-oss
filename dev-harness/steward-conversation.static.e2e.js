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
const ALLOWED = ['/api/session/rewind', '/api/sessions/steward', '/api/steward/act', '/api/steward/message', '/api/steward/visit', '/api/stop'];
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


console.log(`\nSTEWARD CONVERSATION STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
