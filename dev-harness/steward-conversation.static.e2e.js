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
// 33 号文 §4：几条 import 锁原来【逐字钉住整行】（连名字顺序都钉），一次合法的加名就把锁撞红。
// 本仓自己的先例（117u-G3 重钉 E4／D1）是加名时一并重钉，所以这里改成【按名字集合判定】：
// 一条 import 行从哪个模块来、带没带必需的那几个名字，不关心顺序、不关心后来还加了谁。
// 纯字符串切分、不走正则（32 号文 §4 纪律 7：反斜杠在本仓是第三类静默损坏）。
const chipsImportNames = source => source.split(String.fromCharCode(10))
  .filter(line => line.startsWith('import {') && line.includes("from './steward-chips.js';"))
  .flatMap(line => line.slice(line.indexOf('{') + 1, line.indexOf('}')).split(','))
  .map(name => name.trim())
  .filter(Boolean);
// 同一个判据的通用形态（33 号文 §4 的 J2 也要用）：从 <spec> 那条 import 里读出名字集合。
const importNamesFrom = (source, spec) => source.split(String.fromCharCode(10))
  .filter(line => line.startsWith('import {') && line.includes("from './" + spec + "';"))
  .flatMap(line => line.slice(line.indexOf('{') + 1, line.indexOf('}')).split(','))
  .map(name => name.trim())
  .filter(Boolean);
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
// 33 号文 §4 重钉 A3c（反向验证过：把 isSubmitEnter 从 composer 的 import 里去掉立刻真红）：那次收编
// 让本行又多了一个名字 isSubmitEnter。锁要钉的从来是「doc/byId/el 从 chips.js 来、零本地重复定义」，
// 不是「那一行长什么样」——所以改成按名字集合判定（见头上 chipsImportNames）。
ok(['stewardEscapeStack', 'doc', 'byId', 'el', 'isSubmitEnter'].every(name => chipsImportNames(composer).includes(name))
  && !/const doc = \(\) => globalThis\.document \|\| null;/.test(composerCode)
  && !/const byId = id => \(doc\(\) \? doc\(\)\.getElementById\(id\) : null\);/.test(composerCode)
  && !/function el\(tag, className, text\) \{/.test(composerCode),
  'A3c steward-composer.js 的 doc/byId/el 也从 steward-chips.js import，零本地重复定义');
// A3d companion（33 号文 §4「F5a 漏网图标」）：composer 那两枚圆键的图标曾自带一份构造器与两个
// path 字面量（其中一个与 icons.js 的 plus 逐字同）。收编后本文件零 SVG path 字面量、零
// createElementNS —— 字形只能来自 ICONS 表那一份词汇表；把任何一处换回内联 path，这条当场红。
ok(!/\bd:\s*'/.test(composerCode) && !/createElementNS/.test(composerCode)
  && /from '\.\/icons\.js'/.test(composerCode),
  'A3d steward-composer.js 零 SVG path 字面量、零 createElementNS：两枚圆键字形走 icons.js 的 ICONS 表（F5a 漏网图标收编）');

// ─── B 按钮行契约：≤3 且主动作唯一 ───────────────────────────────────────────────
const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-conversation.js')).href);
// 121-K6b 重钉：3 → 2（34 号文 §2.4 文字预算「按钮 ≤2（主动作金色）」）。收的是**渲染层**
// 那一处 slice —— 提示词层与后端照旧可以给三枚，多的那一枚在 renderActs 里被切掉。
ok(mod.STEWARD_ACTS_MAX === 2, `B1 STEWARD_ACTS_MAX === 2（§2.4 文字预算；实测 ${mod.STEWARD_ACTS_MAX}）`);
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
// locale 一侧只查 stewardShell.* 命名空间：「速问」曾是交办台自己的产品词（121-K1 随它退役），
// 不是管家的系统标签，本件不为别的命名空间连坐。
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
ok(/import \{ stewardShortTitle \} from '\.\/util\.js';/.test(composer),
  'D9 复用【唯一那一份】stewardShortTitle（住 util.js，STEWARD_TITLE_MAX=24），不在本文件里另起一份截断函数'
  + '（33 号文 §4：这份实现的落点从 steward-conversation.js 搬到 util.js 叶子，函数体逐字未改）');
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
// 121-K6b **重钉 I2**（原判据「零 setTimeout」）：立账本那一发要【回读 ＋ 有界重试】——
// 管家开线程之后立刻就给它派了第一回合，我们这一发落盘时那个回合往往还没进 activeChildren，
// 于是 13-http-router 的 C4 同步够不着它，回合收尾的 saveSession 把账本整份盖回去
// （实测：同一件 e2e 两跑一红一绿）。收紧而不是放宽：钉「**恰好一处**，且它就在
// ensureAcceptanceLedger 里，次数与间隔都是模块级常量」——想再加第二个临时计时器就必须先改这一条。
ok(count(conversation, /setTimeout\(/g) === 1
  && /const ACCEPTANCE_LEDGER_TRIES = \d+;/.test(conversation)
  && /const ACCEPTANCE_LEDGER_RETRY_MS = \d+;/.test(conversation)
  && /await new Promise\(resolve => setTimeout\(resolve, ACCEPTANCE_LEDGER_RETRY_MS\)\);/.test(conversation),
  `I2 steward-conversation.js 恰好一处 setTimeout（立账本的有界重试，次数与间隔都是常量；实测 ${count(conversation, /setTimeout\(/g)} 处）`);
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
// 121-K6b 补一条 `/api/mission`（34 号文 §13.3 ①）：管家开出一条新线程之后，前端把验收里程碑
// 账本立起来（GET 一次看账本空不空，空才 POST {action:'start'}）。它同样是**既有**路由 ——
// 13-http-router.js:889 那一条，交办台退役前的派单输入框走的就是它；本刀零后端。
const ALLOWED = ['/api/mission', '/api/session/rewind', '/api/sessions/', '/api/sessions/steward', '/api/steward/act', '/api/steward/message', '/api/steward/visit', '/api/stop'];
ok(JSON.stringify(routes) === JSON.stringify(ALLOWED),
  `J1 只调 116 已有的路由，零新增后端面（实测 ${JSON.stringify(routes)}）`);
ok(importNamesFrom(conversation, 'net.js').includes('authHeaders')
  && importNamesFrom(conversation, 'net.js').includes('readNdjsonStream')
  && count(conversation, /\bfetch\(/g) === 1
  && count(composer, /\bfetch\(/g) === 0,
  'J2 唯一的直调 fetch 是 /api/steward/message 的 NDJSON 流（api() 吃不下流），鉴权头复用 net.js');
// 33 号文 §4 重钉 J3（反向验证过）：读流骨架搬进了 net.js 的 readNdjsonStream，本模块不再自己写
// getReader/TextDecoder —— 所以这条锁改成钉【骨架只有一份 + 本模块真的用它】：
//   · 本模块零 getReader／零 TextDecoder 字面量（自己再抄一份立刻红）；
//   · net.js 里那份骨架带 decoder + 按 /\r?\n/ 切 + 留残行的三件事都在（搬走的是同一套，不是重写的另一套）；
//   · 本模块确实把 res.body 交给了它。
const netSrc = read('js/net.js');
ok(!/getReader|TextDecoder/.test(conversation)
  && /const reader = body\.getReader\(\);/.test(netSrc) && /new TextDecoder\(\)/.test(netSrc)
  && /buf = lines\.pop\(\) \|\| '';/.test(netSrc) && /await readNdjsonStream\(res\.body, takeLine\);/.test(conversation),
  'J3 读流骨架只有 net.js 一份（decoder ＋ 按行切 ＋ 末尾残行补发），本模块 import 它而不自己再抄一份');

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
// 33 号文 §4 重钉 L1／L2（反向验证过：把 chips.js 里那句 !event.isComposing 去掉，L2 立刻真红）：
// 三处回车发送的守卫收进了 steward-chips.js 的 isSubmitEnter／bindEnterToSubmit，所以
//   L1 改成数【接线点】—— composer 一处读判据、抽屉两个框各一处；并加一条更紧的：壳里零第二处
//      裸 Enter 判据（谁再手写一份 event.key === 'Enter' 就当场红）；
//   L2 改成钉【判据本体唯一且带输入法守卫】（守卫只剩一处定义，那处必须含 isComposing）。
const chipsFile = stripComments(read('js/steward-chips.js'));
const guardLines = chipsFile.split(String.fromCharCode(10))
  .filter(line => line.includes("event.key === 'Enter'") || line.includes("event.key !== 'Enter'"));
const enterWiringLines = [
  ...composerCode.split(String.fromCharCode(10)),
  ...stripComments(read('js/steward-drawer.js')).split(String.fromCharCode(10)),
].filter(line => line.includes('isSubmitEnter(') || line.includes('bindEnterToSubmit('));
const rawEnterLines = [
  ...composerCode.split(String.fromCharCode(10)),
  ...stripComments(read('js/steward-drawer.js')).split(String.fromCharCode(10)),
].filter(line => line.includes("event.key === 'Enter'") || line.includes("event.key !== 'Enter'"));
ok(enterWiringLines.length === 3 && rawEnterLines.length === 0,
  'L1 管家壳里回车发送的输入框恰好三处(composer + 抽屉两个)，且三处都走 chips.js 同一个守卫、壳里零第二处裸 Enter 判据');
ok(guardLines.length === 1 && guardLines[0].includes('isComposing'),
  'L2 回车发送的守卫只有一处定义，且带 !event.isComposing(中文候选词回车不误发)');

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
// O2b/O3b 术语统一（locale 已把界面上的「线程」改叫「会话」）：新词与旧词【都要认】。上面 O2/O3 钉的
// 是旧词 —— 已落盘的历史消息正文里逐字就是它，只认新词等于把老会话的来源小头静默丢掉（丢的是小头，
// 不报错）。下面两条钉新词，一侧缺席就红。
const inboxLineNew = '- [7] thread_done · 会话「周报-W36」(sess_abc123) · 收工了';
ok(JSON.stringify(mod.stewardInboxSource(inboxLineNew)) === JSON.stringify({ sessionId: 'sess_abc123', title: '周报-W36' }),
  `O2b 新词「会话「标题」(id)」同样取到 id 与显示名（实测 ${JSON.stringify(mod.stewardInboxSource(inboxLineNew))}）`);
ok(JSON.stringify(mod.stewardInboxSource('- [8] thread_failed · 会话 sess_9f0 · 挂了')) === JSON.stringify({ sessionId: 'sess_9f0', title: '' }),
  'O3b 新词的无显示名回落「会话 <id>」同样取得到 id');
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
  'P3 回合号取自 13i 那句「第 N 回合跑完了/失败」的旧词形态（历史消息里逐字是「线程第 N 回合」），取不到回 0');
// P3b 术语统一后的新词：13i stewardNormalizeSessionTurn 现在写「会话第 N 回合…」。新旧都认 ——
// 只认新词则历史消息退到 0，只认旧词则新回合退到 0，两边都是静默降级。
ok(mod.stewardInboxTurnSeq('- [2] done · 会话「A」(sess_a) · 会话第 3 回合跑完了') === 3
  && mod.stewardInboxTurnSeq('会话第 12 回合失败(engine)') === 12
  && mod.stewardInboxTurnSeq('会话「A」(sess_a) 收工了') === 0,
  'P3b 新词「会话第 N 回合跑完了/失败」同样取到回合号');
// P3c 【成对改的反向验证】——不钉行号、不钉整句，只钉「服务端现在写的就是解析器认得的那个形状」：
// 直接拿 src/13i 的摘要生产处来对（生产端改了措辞而这三支正则没跟，或反过来，这条立刻红）。
const inboxSrc = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '13i-steward-inbox.js'), 'utf8');
ok(/`会话第 \$\{seq\} 回合失败/.test(inboxSrc) && /`会话第 \$\{seq\} 回合跑完了/.test(inboxSrc)
  && /`会话停住了\(/.test(inboxSrc)
  && mod.stewardInboxTurnSeq('会话第 7 回合跑完了') === 7,
  'P3c 服务端 13i 现在写的是「会话第 N 回合…／会话停住了」(与上面的解析器同刀改才同时成立)');
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
// 117v-V1 ③ 重钉：判据从「调用点长什么样」改成【那一支里的边界】—— 回放这一段（renderHistorySince）
// 现在对 inbox 与 user 两种回合都挂线程卡，只有交付卡还锁在 inbox 那一支。锚在函数体里而不是整文件：
// attachDeliverable 的定义在别处，整文件匹配连「调用点被整个删掉」都发现不了。
const historyPath = conversationCode.slice(conversationCode.indexOf('function renderHistorySince'),
  conversationCode.indexOf('async function appendSince'));
const attachDeliverableSites = (conversationCode.match(/attachDeliverable\(/g) || []).length;
ok(historyPath.length > 0 && attachDeliverableSites === 2
  && (historyPath.match(/attachDeliverable\(/g) || []).length === 1
  && /if \(trigger\.kind === 'inbox'\) attachDeliverable\(row, \{ \.\.\.opening, turnSeq: trigger\.turnSeq \|\| inboxTurnSeq \}\);/.test(historyPath),
  `P7 交付卡只在「收件箱触发且认得出来源」那一支挂（定义 1 处 + 回放里调用 1 处，实测全文件 ${attachDeliverableSites}）——`
  + '用户自己问的那条一发请求都不多发；117v-V1 ③ 放出线程卡时它【没有】跟着放出来（刚开的线程还没有交付）');
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
//    33 号文 §4 把 './util.js' 加了进来：stewardShortTitle 从本模块搬去 util.js（无状态格式化
//    叶子，两个壳共用一份截短口径），本文件改为 import 使用 —— 借的还是【叶子】里的纯字符串函数，
//    不是新借了一个域的实现。
//    32 号文 §4（M2）把 './popover.js' 加了进来：※ 浮层与头像菜单的开合（Esc／点外／焦点归还锚点／
//    同一时刻只允许一个浮层）搬去两壳共用的那颗浮层原语，本文件改为 import 使用 —— 借的还是【叶子】
//    里的开合原语（chips 那一刀走的就是同一条 import），不是新借了一个域的实现。
//    本条锁因此仍然可证伪：它钉的是「除这五条之外，本文件不许再向任何域借东西」。
//    121-K6b 把 './thread-facts.js' 加了进来（34 号文 §13.3 ①「里程碑不丢」）：新任务的验收里程碑
//    生产者 dispatchAcceptanceMilestones 自 121-K1 起没有任何调用点，本刀把它接在「这一回合真开出
//    了一条新线程」那一刻。thread-facts.js 与 util.js 同族 —— **纯函数叶子**（零 DOM、零 t()、
//    零 fetch），借的仍然是叶子里的纯函数，不是新借了一个域的实现。
const CONVERSATION_IMPORTS = ['./icons.js', './net.js', './popover.js', './steward-chips.js', './thread-facts.js', './util.js'];
const conversationImports = [...conversation.matchAll(/^import .* from '([^']+)';/gm)].map(match => match[1]);
ok(JSON.stringify([...new Set(conversationImports)].sort()) === JSON.stringify(CONVERSATION_IMPORTS),
  `P10 import 只有 net.js、steward-chips.js、popover.js、icons.js 与 util.js 五个本域内相对路径（实测 ${JSON.stringify([...new Set(conversationImports)].sort())}）`);
ok(/openClassicWindow = null,/.test(conversation)
  && /if \(typeof openClassicWindow === 'function'\) \{/.test(conversationCode)
  && /openThread\(id\);/.test(conversationCode)
  && !/from '\.\/steward-drawer\.js'/.test(conversation) && !/from '\.\/steward-classic-window\.js'/.test(conversation),
  'P11 「看全文」＝注入的 openClassicWindow（与抽屉同一个入口），缺席时回落既有的 steward:open-thread；'
  + '本模块不 import 抽屉/视窗模块（不长出第二条切壳通道）');
// 117v-V1 ⑨ 重钉（用户第十轮走查⑨「管家的回复看全文是打开 2.0，看英伟达分析全文是打开线程」）：
// 原判据钉的是「共用抽屉那一个键」。同一屏上还有第二枚「看…全文」（管家写的 open_thread act，
// 点下去打开线程），两个去处共用一个泛泛的词，用户只能靠猜 —— 所以交付卡这一枚改用自己的键，
// 词里必须写清去处，且必须与抽屉那一枚的词【不同】。
// 121-K8（§2.10.4）：去处的说法从「2.0」改成【视角名】——「2.0 视窗」是禁用词（那是壳的版本号，
// 不是用户看得懂的地名），一台两视之后那个去处就叫「工作台」。判据本身没变：仍然是
// 「这一枚有自己的键 ＋ 词里点名去处 ＋ 与抽屉那一枚不同 ＋ 兜底句引的是它现在的词」。
// 锚在 deliverableActs 的函数体里：整文件匹配的话，把这一处按钮整个删掉也照样绿。
const deliverableActsRule = conversationCode.slice(conversationCode.indexOf('function deliverableActs'),
  conversationCode.indexOf('function attachDeliverable'));
const FULL_KEY = 'stewardShell.chat.deliverableFull';
ok(deliverableActsRule.length > 0
  && new RegExp(`t\\('${FULL_KEY.replace(/\./g, '\\.')}'\\)`).test(deliverableActsRule)
  && !/stewardShell\.drawer\.fullText/.test(conversationCode)
  && typeof zh[FULL_KEY] === 'string' && typeof en[FULL_KEY] === 'string'
  && zh[FULL_KEY] !== zh['stewardShell.drawer.fullText'] && en[FULL_KEY] !== en['stewardShell.drawer.fullText']
  && zh[FULL_KEY].includes('工作台') && en[FULL_KEY].includes('Workbench'),
  `P11b 交付卡那枚「看全文」有【自己】的键且词里写明去处（zh「${zh[FULL_KEY]}」／en「${en[FULL_KEY]}」），`
  + '与抽屉那枚（打开线程的琥珀色 act 旁边那个泛泛的词）区分得开；本模块不再引 stewardShell.drawer.fullText');
ok(zh['stewardShell.chat.deliverableMissing'].includes(zh[FULL_KEY])
  && en['stewardShell.chat.deliverableMissing'].includes(en[FULL_KEY]),
  'P11c 「这一次没取到原文」那句兜底引的就是这一枚按钮【现在】的词（改了词就得跟着改，中英都是）');

// ⑤ i18n 与样式层。
for (const key of ['stewardShell.chat.deliverableHead', 'stewardShell.chat.deliverableHeadPlain',
  'stewardShell.chat.deliverableLoading', 'stewardShell.chat.deliverableMissing',
  'stewardShell.chat.deliverableExpand', 'stewardShell.chat.deliverableCollapse',
  'stewardShell.chat.deliverableFull']) {
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
// 121-K1 重钉：elapsedLabel 从 preview-task-sheet.js 搬进叶子 thread-facts.js（那个文件随交办台
// 退役整文件删除）。判据【收紧】：既不许从新家 import 那一支，也不许 import 任何已被删掉的
// preview-* 模块（后者是纪律 13「搬符号必 grep 引用点」的机械保证 —— 一个死 import 就是白屏）。
ok(/new Intl\.RelativeTimeFormat\(/.test(conversationCode)
  && !/\belapsedLabel\b/.test(conversationCode)
  && !/from '\.\/preview-[a-z-]+\.js'/.test(conversation),
  'Q4c 相对时间走平台的 Intl，不去抄 thread-facts.js 的 elapsedLabel（那一支格式化的是【时长】「3m 20s」，不是「3 分钟前」），也不留任何指向已退役 preview-* 的 import');

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

// ③ 折叠只有一处实现，且【只有交付卡一个调用方】。
// 117y-S3 重钉（用户第十一轮拍板②「管家的话最好不要用展开的二级菜单了，显示完吧」）：
// 原判据钉的是「clampIfLong 恰好出现 3 次 ＝ 定义＋交付卡＋管家正文」。管家正文那一路撤掉之后
// 数字确实变成 2，但**本条不是把 3 改成 2**：改的是判据本身 —— 从「一处实现两个调用方」换成
// 「一处实现 ＋ 调用方只剩 fillDeliverable 那一个」，并把「finishSay 里没有折叠」单独钉成 Q6a。
// 谁想给别的东西再折一次，得先在这里加一个新的调用点，这一条立刻转红。
ok(count(conversationCode, /function clampIfLong\(/g) === 1
  && count(conversationCode, /function collapseToggle\(/g) === 1
  && count(conversationCode, /clampIfLong\(body, found\.text\)/g) === 1
  && count(conversationCode, /collapseToggle\(body\)/g) === 1
  && count(conversationCode, /clampIfLong\(/g) === 2 && count(conversationCode, /collapseToggle\(/g) === 2,
  `Q6 折叠仍是【一处】实现，而调用方只剩交付卡那一个（clampIfLong ${count(conversationCode, /clampIfLong\(/g)} 处出现 = 定义 + fillDeliverable，collapseToggle 同 = 定义 + deliverableActs）`);
const finishSayFrom = conversationCode.indexOf('function finishSay(');
const finishSayTo = conversationCode.indexOf('function appendRow(');
const finishSaySlice = conversationCode.slice(finishSayFrom, finishSayTo);
ok(finishSayFrom > 0 && finishSayTo > finishSayFrom
  && !/clampIfLong|collapseToggle|is-clamped/.test(finishSaySlice)
  && count(conversationCode, /steward-say-acts/g) === 0,
  `Q6a 管家的话【不折叠】：finishSay 的函数体内一个 clampIfLong/collapseToggle/is-clamped 都没有，那枚按钮行（.steward-say-acts）整份文件不再生成（判据锚在【函数体】上——整文件匹配会被交付卡那一路假绿；实测函数体 ${finishSaySlice.length} 字符）`);
ok(count(conversationCode, /button\('steward-deliverable-more'/g) === 1
  && count(conversationCode, /classList\.toggle\('is-clamped'\)/g) === 1
  && count(conversationCode, /classList\.add\('is-clamped'\)/g) === 1
  && count(conversationCode, /classList\.remove\('is-clamped'\)/g) === 1,
  'Q6b 「展开」按钮、is-clamped 的加/减/翻转各自全文件恰好一处 —— 想再造一个折叠必须先动这几行');
// 117y-S3：CSS 一层【本刀一个字节没动】（改它就得重算 LEGACY_STYLES_SHA256，那不归这一刀钉）。
// 于是 `.steward-say.is-clamped` 与 `.steward-say-acts` 两条规则今天成了【无消费方的死规则】——
// JS 侧已经没有任何路径会给 .steward-say 加 is-clamped（Q6a 钉着），删它们要与哈希重钉同刀走。
// 本条因此只钉仍然活着的那一处：交付卡读那个唯一的高度令牌。
ok(/\.steward-deliverable-body\.is-clamped \{ max-height: var\(--steward-clamp-h\); overflow: hidden; \}/.test(cssCode)
  && (cssCode.match(/--steward-clamp-h:/g) || []).length === 1,
  'Q6c 仅剩的那处折叠读一个全层只定义一次的高度令牌（--steward-clamp-h）：改折叠高度只有一处可改');
ok(mod.STEWARD_DELIVERABLE_LINES === 8
  && count(conversationCode, /STEWARD_DELIVERABLE_LINES/g) === 2
  && /clampIfLong\(body, found\.text\)/.test(conversationCode)
  // 原判据这半句写的是 /clampIfLong\(node, text\)/ —— 它其实一直同时匹配着【定义那一行的签名】，
  // 所以当年就没真的钉住「管家正文那个调用点」。这次改成钉「这串字只以签名的身份出现一次」。
  && count(conversationCode, /clampIfLong\(node, text\)/g) === 1
  && /function clampIfLong\(node, text\)/.test(conversationCode),
  'Q6d 阈值仍是那一个常量（STEWARD_DELIVERABLE_LINES=8，全文件恰好「定义 + clampIfLong 里用一次」两处），没有第二个「8」；`clampIfLong(node, text)` 只以【定义签名】的身份出现一次，再没有谁这么调它');

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

// ─── W F2 频道条 → 121-K4-3 整段退役（34 号文 §2.4／§12 末条）──────────────────────────────
// 原来这一组（W1–W11，12 条）钉的是频道条那三条纪律：过滤是呈现不是数据、不建第二个判官、
// 不建第二个「目标」。它们当时都成立，而且是这一刀敢把整段删掉的底气：**那一段确实没有别人
// 依赖的状态** —— 零存储、零请求、零第二份色号、输入区的目标仍然只有 picked 一个。
// 现在的事实是：左栏（两视角共用、常开、按任务归组）就是索引，频道条是它的第二遍；
// 「只看这条」在左栏是一次点击（点行＝换焦点）。所以整组翻面，钉【它真的不在了】：
//   ① 两个模块级状态、八个函数、两个导出常量，一个都不许留在对话流里；
//   ② 样式层那一族（含那条 .is-channel-out 过滤规则与只服务它的高度上限变量）一个都不许留；
//   ③ 唯一留下来的是「卡头只长在段首那一行」那条规则与 resealThreads —— 它不属于频道条
//      （线程卡的段界是追加时看上一行算出来的，与过滤无关）。
// 反向验证：把 syncChannels 的调用点加回 appendThread → ① 当场红（函数不存在，扫描也会抓到）。
const composerMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-composer.js')).href);
ok(mod.STEWARD_PICK_CHANNEL_EVENT === undefined && mod.STEWARD_CHANNEL_SELF === undefined
  && !/channelFilter|channelSignature|function channelList|function channelChip|function paintChannels|function syncChannels|function toggleChannel|function setChannel|function applyChannel|function pickChannelTarget/.test(conversationCode)
  && !/is-channel-out/.test(conversationCode)
  && !/steward-channels/.test(conversationCode),
  'W1 频道条在对话流里零残留：两个模块级状态、八个函数、两个导出常量全部退役（§2.4：左栏就是索引）');
ok(!/steward-channel/.test(cssCode) && !/is-channel-out/.test(cssCode)
  && !/--steward-channels-max-h/.test(cssCode),
  'W2 样式层那一族（chip／滚动容器／过滤规则／只服务它的高度上限变量）也零残留');
ok(/\.steward-msg-ruyi\.is-thread:not\(\.is-thread-start\) > \.steward-thread-head \{ display: none; \}/.test(cssCode)
  && /function resealThreads\(\)/.test(conversationCode)
  && !/is-channel-out/.test(conversationCode.slice(conversationCode.indexOf('function resealThreads()'))),
  'W3 「卡头只长在段首那一行」那条规则与 resealThreads 留着（它不属于频道条：段界是追加时看上一行算出来的），且它自己也不再认识那个过滤类');
// 121-K5（34 号文 §13.7 登记⑧）：输入区那一侧的同名常量、它的监听器、以及只由它写的两支
// 临时目标（channelPick / pickedBeforeChannel）全部清掉 —— 生产者一个都没有的监听器不是接口，
// 是让后人以为手选态还有第二条来路。输入区的目标自此仍然只有 picked 一个。
// 反向验证：把那条 addEventListener 加回输入区 → 本条当场红。
const composerSrc = read('js/steward-composer.js');
ok(composerMod.STEWARD_PICK_CHANNEL_EVENT === undefined
  && (conversation.match(/'steward:pick-channel'/g) || []).length === 0
  && !/channelPick|applyChannelPick|pickedBeforeChannel/.test(stripComments(composerSrc)),
  'W4 输入区那份同名常量、监听器与两支临时目标也已清净（121-K5：频道条零残留）');

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

// ─── Z 117v-V1（27 号文 §11.16.2 V1 行；用户第十轮走查②③）───────────────────────────────
// 每一条都【锚在它要守的那个函数体里】：整文件匹配在本波已经栽过一次 —— 同名调用在另一个渲染器里
// 也有一处，把目标那处整个删掉锁照样绿。
{
  const navRule = conversationCode.slice(conversationCode.indexOf('function isNavigationAct'),
    conversationCode.indexOf('async function runAct('));
  const runActRule = conversationCode.slice(conversationCode.indexOf('async function runAct('),
    conversationCode.indexOf('function engineProblemInfo'));
  const settleInRunAct = (runActRule.match(/settleRow\(/g) || []).length;
  ok(navRule.length > 0 && runActRule.length > 0
    && /act\.kind === 'open_thread'/.test(navRule) && !/label/.test(navRule)
    && /if \(isNavigationAct\(act\)\) \{/.test(runActRule)
    && settleInRunAct === 1
    && /\} else \{\s*settleRow\(actsRow, receiptFor\(act\)\);\s*\}/.test(runActRule),
    `Z1 ② 导航 ≠ 表态：「点完要不要落回执」按 act.kind 判（不看按钮上的字），runAct 里唯一那处 settleRow`
    + `（实测 ${settleInRunAct} 处）落在【非导航】那一支 —— open_thread 点完按钮行原样留着，从 2.0 回来还能再点`);
  const navBranch = runActRule.slice(runActRule.indexOf('if (isNavigationAct(act))'));
  ok(/if \(btn\) btn\.disabled = false;/.test(navBranch) && /openThread\(act\.sessionId\)/.test(navBranch),
    'Z2 ② companion：导航那一支既把按钮恢复可点（runAct 入口统一 disable 过一次，不恢复的话按钮还在却按不动，与「失效」没区别），也照旧真去开线程');
  const historyRule = conversationCode.slice(conversationCode.indexOf('function renderHistorySince'),
    conversationCode.indexOf('async function appendSince'));
  const finishRule = conversationCode.slice(conversationCode.indexOf('function finishReply('),
    conversationCode.indexOf('function actionWhyLines'));
  // Z3 的头一版只钉「attachThreadCard 没被 inbox 守着」，反向验证时发现它是【假绿】：把兜底那一档
  // 改回 `: null`（＝修前行为）之后本条照样通过 —— 卡的挂法没变，变的是「非 inbox 那一支拿不到来源」。
  // 所以必须连【兜底真的给到了非 inbox 那一支】一起钉。行为那一面由真机 AA1／AA2 看着。
  ok(historyRule.length > 0
    && (historyRule.match(/attachThreadCard\(/g) || []).length === 1
    && !/inbox'\)[^\n]*attachThreadCard\(/.test(historyRule)
    && /executedThreadSessionId\(stamp\.actions\)/.test(historyRule)
    && /\?[\s\S]{0,240}:\s*executedSource;/.test(historyRule),
    'Z3 ③ 回放这一支：线程卡（＝频道条 chip 的唯一来源）挂不挂，只看「这一回合有没有真开出一条线程」——「本回合真开的那条」这一档兜底对非 inbox 的回合同样给到，不再被 inbox 独占');
  ok(finishRule.length > 0
    && /const opened = executedThreadSessionId\(reply\.actions\);/.test(finishRule)
    && /attachThreadCard\(row, \{ sessionId: opened, title: '' \}\);/.test(finishRule),
    'Z4 ③「当场」：用户问、管家开线程的【那一轮】就挂卡 —— 回放那条路要等下一次进壳或下一条收件箱增量才走得到，只改回放等于「刷新一下才长出 chip」');
}

// ─── AA 117v-V4（27 号文 §11.16.4 追加②③／§11.16.5 追加④⑤；用户第十轮追加与再追加）─────────
// 三件：① 间距扩成四档；② 频道条不许有「看不见也摸不着」的 chip；③ 交付原文里不许混过程叙述。
// 每一条都钉【必须成立的那件事】：序关系（不是像素）、结构（不是某种滚法）、判据（不是某个正则）。
{
  /* ① 四档间距 —— 钉序关系，不钉像素。
     取值一律从 tokens.css 现算：设计要整体换一套 --sp 阶梯不该误伤本条，而谁把某一档调过头
     （比如把卡间调到比组间还小、或把卡内块间调过组间）当场红。
     「组内／组间两档一个像素都不许动」由既有的 M10 逐字钉着（那两行原样在），这里不重复。 */
  const tokens = read('css/tokens.css');
  const tokenPx = name => {
    const found = new RegExp('--' + name + ':\\s*(\\d+)px').exec(tokens);
    return found ? Number(found[1]) : NaN;
  };
  const declToken = (selector, prop) => {
    const at = cssCode.indexOf(selector + ' {');
    if (at < 0) return '';
    const block = cssCode.slice(at, cssCode.indexOf('}', at) + 1);
    const found = new RegExp(prop + ':\\s*var\\(--(sp-\\d+)\\)').exec(block);
    return found ? found[1] : '';
  };
  const gapToken = declToken('.steward-feed', 'gap');
  const cardGapToken = declToken('.steward-msg-ruyi.is-thread-start', 'margin-top');
  const within = tokenPx(gapToken);                                          // 组内
  const between = within + tokenPx(declToken('.steward-msg', 'margin-top')); // 组间
  const inCard = tokenPx(declToken('.steward-msg-ruyi.is-thread', 'gap'));   // 卡内块间（按语↔交付卡↔动作键）
  const betweenCards = within + tokenPx(cardGapToken);                       // 卡间
  const tiers = [within, between, inCard, betweenCards];
  ok(tiers.every(Number.isFinite)
    && betweenCards > between && between > inCard && inCard > within,
    `AA1 ① 四档间距的【序关系】成立：卡间 ${betweenCards} ＞ 组间 ${between} ＞ 卡内块间 ${inCard} ＞ 组内 ${within}（px，按 tokens.css 现算）`
    + ' —— F1 之后对话流的单位是一张几百像素高的线程卡，卡与卡之间却只有组内那一档，用户说的「很密」就是它');
  ok(Boolean(cardGapToken)
    && declToken('.steward-msg-ruyi.is-thread-end + .steward-msg', 'margin-top') === cardGapToken,
    `AA2 ① 卡间是【一档两个落点】：卡的第一行与卡后面那一行读同一个 token（实测都是 --${cardGapToken}）—— 不是两个各调各的数`);
  {
    // 「判据挂在已有的类上，不新造第二套分组状态」：本刀新写的这三条规则里出现的每一个 .is-*，
    // 都必须是 JS 【已经在维护】的那几个类（F1 的段界 markThread ／ 过滤后的 resealThreads）。
    const tierRules = ['.steward-msg-ruyi.is-thread {', '.steward-msg-ruyi.is-thread-start {',
      '.steward-msg-ruyi.is-thread-end + .steward-msg {'];
    const used = [...new Set(tierRules.flatMap(rule => [...rule.matchAll(/\.(is-[a-z-]+)/g)].map(m => m[1])))];
    const strangers = used.filter(name => !conversationCode.includes(`'${name}'`));
    ok(used.length > 0 && strangers.length === 0
      && tierRules.every(rule => cssCode.includes(rule)),
      `AA3 ① 四档判据挂在【已有的类】上：三条规则用到的 ${JSON.stringify(used)} 每一个都是 JS 里真在维护的段界类（陌生的: ${JSON.stringify(strangers)}）—— 没有为了间距新造第二套分组状态`);
  }

  /* ② 频道条那三条硬要求（AA4/AA5/AA6）随频道条本身退役 —— 121-K4-3 把整段删了（§2.4）。
     「看不见也摸不着的 chip」这个毛病自此不可能再出现：那一排 chip 不存在了，它要解决的问题
     （线程多了怎么都到得了）由左栏承担（常开、按任务归组、组头计数、Ctrl+K 搜索）。
     退役本身由上面 W 组三条正面钉住（JS 零残留 ／ CSS 零残留 ／ 只留段界那一条）。
     这里保留一条【不许悄悄回来】的负向锁：整层不许再出现把滚动条压成 0 的那两条声明。 */
  ok(!/scrollbar-width: none/.test(cssCode) && !/::-webkit-scrollbar \{ height: 0; \}/.test(cssCode),
    'AA4 ② 整层零「把滚动条压成 0」（修前那两条声明正是「看不见也摸不着」的病根；频道条已退役，这条锁留给后来的任何滚动区）');

  /* ③ 交付原文 ＝ 最后一个工具段之后的文本段 —— 真值表跑在导出的纯函数上（判据只有那一处）。 */
  const deliverableTextRule = conversationCode.slice(conversationCode.indexOf('export function stewardDeliverableText'),
    conversationCode.indexOf('export function stewardDeliverableFrom'));
  const deliverableFromRule = conversationCode.slice(conversationCode.indexOf('export function stewardDeliverableFrom'),
    conversationCode.indexOf('export const STEWARD_DELIVERABLE_LINES'));
  const PROCESS_A = '我先联网核实最新数据。';
  const PROCESS_B = '搜索后端对中文长查询分词太差，我改用脚本直连。';
  const THINK = '（这段是思考，不是交付）';
  const DELIVERED = '结论：偏多，三条理由。';
  const mixed = {
    role: 'assistant', turnSeq: 7,
    content: PROCESS_A + PROCESS_B + DELIVERED,
    segments: [
      { id: 'segment-1', type: 'text', text: PROCESS_A },
      { id: 'segment-2', type: 'tool', toolCallId: 't1', name: 'web_search', status: 'done' },
      { id: 'segment-3', type: 'text', text: PROCESS_B },
      { id: 'segment-4', type: 'thinking', text: THINK },
      { id: 'segment-5', type: 'tool', toolCallId: 't2', name: 'script_run', status: 'done' },
      { id: 'segment-6', type: 'thinking', text: THINK },
      { id: 'segment-7', type: 'text', text: DELIVERED },
    ],
  };
  ok(typeof mod.stewardDeliverableText === 'function'
    && mod.stewardDeliverableText(mixed) === DELIVERED,
    'AA7 ③ 交付原文＝【最后一个活动段之后】的 text 段：工具调用之间那两句过程叙述与两段 thinking 一个字都没进来（用户第十轮再追加②「参杂了一些线程推进的原文，也不要有」）');
  // 117v-V4b（主会话裁决，§11.16.7）：会产生「过程叙述」的活动有两种 —— 自己调工具、以及派子代理。
  // V4 严格照原判据只认 tool 并把这个缺口如实登记成债（它做对了：放宽判据是判断题）。这里补上另一半。
  // **反向的边界同样要钉住**：记账类段（mission/workflow 之流）有可能尾随在正文之后，若把边界扩成
  // 「所有非 text/thinking 段」，那一刀会把真交付整个切掉、演成「这一次没取到原文」—— 比漏挡一句叙述坏得多。
  {
    const viaSubagent = {
      role: 'assistant', turnSeq: 8,
      content: PROCESS_A + DELIVERED,
      segments: [
        { id: 'segment-1', type: 'text', text: PROCESS_A },
        { id: 'segment-2', type: 'subagent', name: 'researcher', status: 'done' },
        { id: 'segment-3', type: 'text', text: DELIVERED },
      ],
    };
    ok(mod.stewardDeliverableText(viaSubagent) === DELIVERED,
      `AA7b ③ 子代理段同样算「活动」边界：派 agent 之前那句叙述不进交付（实测「${mod.stewardDeliverableText(viaSubagent)}」）`);
    const trailingLedger = {
      role: 'assistant', turnSeq: 9,
      content: DELIVERED,
      segments: [
        { id: 'segment-1', type: 'tool', toolCallId: 't1', name: 'web_search', status: 'done' },
        { id: 'segment-2', type: 'text', text: DELIVERED },
        { id: 'segment-3', type: 'mission', status: 'updated' },
      ],
    };
    ok(mod.stewardDeliverableText(trailingLedger) === DELIVERED,
      `AA7c ③ 反向边界：记账类段【尾随】在正文之后时，交付仍然是那段正文（判据只认 tool/subagent，没有一刀切成「所有非文本段」；实测「${mod.stewardDeliverableText(trailingLedger)}」）`);
  }
  {
    const noTool = {
      role: 'assistant', content: PROCESS_A + DELIVERED,
      segments: [
        { id: 'segment-1', type: 'text', text: PROCESS_A },
        { id: 'segment-2', type: 'thinking', text: THINK },
        { id: 'segment-3', type: 'text', text: DELIVERED },
      ],
    };
    ok(mod.stewardDeliverableText(noTool) === noTool.content,
      'AA8 ③ 没有工具段时＝全部 text 段拼接，而它与今天的 content 【逐字相等】（content 本来就是所有 assistant_delta 的拼接）—— 回落一致，thinking 仍然不进');
  }
  {
    const legacy = { role: 'assistant', content: PROCESS_A + DELIVERED };
    ok(mod.stewardDeliverableText(legacy) === legacy.content
      && mod.stewardDeliverableText({ role: 'assistant', content: '老会话', segments: [] }) === '老会话'
      && mod.stewardDeliverableText({ role: 'assistant', content: '老会话', segments: null }) === '老会话'
      && mod.stewardDeliverableText({}) === '' && mod.stewardDeliverableText(null) === '',
      'AA9 ③ 边界：segments 缺席／空／不是数组的老会话（EC-D 之前落盘的）回落到 content 整段 —— **绝不许因为拿不到账本就返回空**，那是把「读不到」演成「它没交付」');
  }
  {
    const trailingTool = {
      role: 'assistant', turnSeq: 9, content: PROCESS_A + PROCESS_B,
      segments: [
        { id: 'segment-1', type: 'text', text: PROCESS_A },
        { id: 'segment-2', type: 'tool', toolCallId: 't1', name: 'web_search', status: 'done' },
      ],
    };
    ok(mod.stewardDeliverableText(trailingTool) === ''
      && mod.stewardDeliverableFrom({ messages: [trailingTool] }, 9) === null,
      'AA10 ③ 以工具调用收尾、后面一句收口的话都没有 → 这一条【没有交付原文】（回空串、from 回 null，调用方画「这一次没取到原文」＋「到 2.0 视窗看全文」）；这一档【不】回落到 content —— 回落等于把用户刚说「不要有」的那几句过程叙述原样端回去');
  }
  ok(JSON.stringify(mod.stewardDeliverableFrom({ messages: [mixed] }, 7)) === JSON.stringify({ text: DELIVERED, turnSeq: 7 })
    && JSON.stringify(mod.stewardDeliverableFrom({ messages: [mixed] }, 0)) === JSON.stringify({ text: DELIVERED, turnSeq: 7 }),
    'AA11 ③ 挑回合的形状一个字没变（{text,turnSeq}／对不上就退到最后一条），变的只是「这一条消息取哪一段文字」');
  ok(deliverableTextRule.length > 0 && deliverableFromRule.length > 0
    && /const text = stewardDeliverableText\(message\);/.test(deliverableFromRule)
    && !/message\.content/.test(deliverableFromRule)
    && !/document|fetch\(|api\(/.test(deliverableTextRule),
    'AA12 ③ 判据只有一处：挑段全在 stewardDeliverableText 里，stewardDeliverableFrom 自己不再碰 message.content（不留第二份取段口径）；两支都还是零 DOM、零请求的纯函数');
}

console.log(`\nSTEWARD CONVERSATION STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
