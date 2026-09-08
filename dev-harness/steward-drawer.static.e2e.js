#!/usr/bin/env node
'use strict';

// 第117波 117d 静态契约（27 号文 §5 117d 行／§8.13「线程抽屉里的『话』」／§8.6「权限的界面表达」）：
//   A 区块顺序 ①→⑪（按 id 在 index.html 中的出现顺序）＋ dialog／aria-labelledby／tablist；
//   B 零 innerHTML、import 只在本域内（零第三方）；
//   C 轮询纪律：本模块恰好一处 setInterval／一处 clearInterval，且锁在三重门控里；
//   D 快捷回复来源是可 Node import 的纯函数，且导出上限常量；
//   E 拼接读取而不是复制：验收项／三问／五态／快切 chip 全部 import 复用，抽屉不定义同名函数，
//     也不自己实现权限档的 PATCH（那只有 steward-chips.js 一个写口）；
//   F 后端零新增面：只调 116 之前就有的路由；
//   G 新样式层三处登记 ＋ 零硬编码色 ＋ reduced-motion ＋ 390px ＋ 1000px 断点；
//   H i18n 三组键中英对称、源码用到的键都齐备、禁词零出现。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const html = read('index.html');
const drawer = read('js/steward-drawer.js');
const chips = read('js/steward-chips.js');
const stewardShell = read('js/steward-shell.js');
const composer = read('js/steward-composer.js');
const css = read('css/views/steward-drawer.css');
const styles = read('styles.css');
const zh = JSON.parse(read('locales/zh-CN.json'));
const en = JSON.parse(read('locales/en-US.json'));
const overlay = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');
const readFrontendCss = fs.readFileSync(path.join(__dirname, 'read-frontend-css.js'), 'utf8');

// 注释里要写清「零 innerHTML」「不自己实现 PATCH permissionMode」这些纪律本身，所以扫禁词与扫危险
// API 之前先把注释剥掉 —— 否则写下纪律的那一行会把自己判红（与 steward-conversation.static 同款）。
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const drawerCode = stripComments(drawer);
const chipsCode = stripComments(chips);
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
const count = (source, pattern) => (source.match(pattern) || []).length;

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {

const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-drawer.js')).href);
const chipsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-chips.js')).href);

// ─── A 区块顺序即契约 ────────────────────────────────────────────────────────────
const BLOCKS = mod.STEWARD_DRAWER_BLOCK_IDS;
// 117l D4 **重钉 A1/A2**（用户第四轮走查①③；语义是「多了两块、四块换了位置」，不是放宽）。
// 旧断言钉的是 117d 立的十一块常驻清单。用户第四轮走查推翻了它的两条前提：
//   ① 「线程里的提问出来时…并没有 2.0 的那种问答框，导致没法正常地回复」→ ③ 之下必须多一张
//      「它在问你」卡（stewardDrawerAsk）；
//   ③ 「线程页内容还是太多太杂了」→ 接力／三问／验收项／现场四块折进默认收起的
//      <details id="stewardDrawerMore">。
// 所以清单从 11 变 13（多的两项是「问答卡」与「更多」这个容器本身）。
// companion（A2b）：被折进去的那四块【一块没少、顺序没变】—— 这条修法是「换个地方放」，
// 不是「删掉」，静态锁必须能把「顺手删了一块」和「折起来了」分开。
ok(Array.isArray(BLOCKS) && BLOCKS.length === 13 && Object.isFrozen(BLOCKS),
  `A1 导出的区块顺序表是冻结的 13 项（实测 ${BLOCKS && BLOCKS.length}）`);
ok(JSON.stringify(BLOCKS) === JSON.stringify([
  'stewardDrawerMission',      // ① 事项行
  'stewardDrawerTabs',         // ② 线程页签
  'stewardDrawerHead',         // ③ 线程头
  'stewardDrawerAsk',          // ④ 它在问你（117l）
  'stewardDrawerChips',        // ⑤ 快切 chip
  'stewardDrawerLastSay',      // ⑥ 它正在说／它刚说
  'stewardDrawerQuickReplies', // ⑦ 你可以说
  'stewardDrawerMore',         // ⑧ 更多（容器，117l）
  'stewardDrawerRelay',        // ⑧-1 接力关系
  'stewardDrawerActivity',     // ⑧-2 三问
  'stewardDrawerAcceptance',   // ⑧-3 验收项
  'stewardDrawerScene',        // ⑧-4 现场
  'stewardDrawerFoot',         // ⑪ 底部
]), `A2 区块顺序逐字为 §11.9 D4 那一串（实测 ${JSON.stringify(BLOCKS)}）`);
ok(JSON.stringify(mod.STEWARD_DRAWER_MORE_BLOCK_IDS)
  === JSON.stringify(['stewardDrawerRelay', 'stewardDrawerActivity', 'stewardDrawerAcceptance', 'stewardDrawerScene'])
  && mod.STEWARD_DRAWER_MORE_BLOCK_IDS.every(id => BLOCKS.includes(id)),
  'A2b companion：折进「更多」的四块一块没少、顺序没变（这条修法是换地方，不是删块）');
const positions = BLOCKS.map(id => html.indexOf(`id="${id}"`));
ok(positions.every(index => index > 0), 'A3 十一个区块骨架都静态写在 index.html 里（不是 JS 现搭）');
ok(positions.every((index, i) => i === 0 || index > positions[i - 1]),
  'A4 index.html 里的出现顺序 === 区块顺序表的顺序（DOM 顺序即锁）');
const shellAt = html.indexOf('id="stewardShell"');
const drawerAt = html.indexOf('id="stewardDrawer"');
const settingsAt = html.indexOf('id="settingsModal"');
ok(shellAt > 0 && drawerAt > shellAt && drawerAt < settingsAt, 'A5 抽屉住在 #stewardShell 容器【内】');
ok(/<aside id="stewardDrawer"[^>]*class="steward-drawer"[\s\S]{0,400}?role="dialog"/.test(html)
  && /<aside id="stewardDrawer"[\s\S]{0,400}?aria-labelledby="stewardDrawerTitle"/.test(html)
  && /<aside id="stewardDrawer"[\s\S]{0,400}?hidden>/.test(html),
  'A6 抽屉是 role="dialog" + aria-labelledby="stewardDrawerTitle" 的 <aside>，默认 hidden');
ok(html.includes('id="stewardDrawerTitle"'), 'A6b aria-labelledby 指向的标题节点真实存在');
ok(/<div id="stewardDrawerTabs"[^>]*role="tablist"/.test(html)
  && /tab\.setAttribute\('role', 'tab'\)/.test(drawer)
  && /tab\.setAttribute\('aria-selected'/.test(drawer),
  'A7 线程页签是 tablist / tab / aria-selected 的正经页签，不是一排按钮');
ok(/aria-modal/.test(drawer) && /matchMedia\('\(min-width: 1000px\)'\)/.test(drawer),
  'A8 窄屏（<1000px）全屏覆盖时补 aria-modal，宽屏栏式不补');
ok(/if \(event\.key === 'Escape' && isOpen\(\)\)/.test(drawer)
  && /on\('stewardDrawerCloseBtn', \(\) => closeDrawer\(\)\);/.test(drawer)
  && /on\('stewardDrawerHandBackBtn', \(\) => closeDrawer\(\{ focusComposer: true \}\)\);/.test(drawer),
  'A9 Esc／×／「交回管家」三条关闭路径俱全，交回管家把焦点还给管家输入框');

// ─── B 零 innerHTML、import 只在本域内 ───────────────────────────────────────────
for (const [name, source] of [['steward-drawer.js', drawerCode], ['steward-chips.js', chipsCode]]) {
  ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(source),
    `B1 ${name} 零 innerHTML/insertAdjacentHTML/document.write`);
  const imports = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map(match => match[1]);
  ok(imports.every(spec => spec.startsWith('./')), `B2 ${name} 的 import 全是本域内相对路径（零第三方库）`);
}
// 117n-M1 重钉：el()/clear() 搬进 steward-chips.js 集中定义（六个消费方零本地重复）之后，
// drawer.js 自己不再直接调 .createElement——但它仍然只经从 chips.js import 的共享 el()/clear()
// 生成节点，createElement 本体仍可在 chips.js 里查证。原判据只证明「某处调过 createElement」；
// 新判据在此之上再加一条正面证据（零本地重复定义），是更强而不是更弱的版本。
ok(/textContent/.test(drawer)
  && /createElement\(/.test(chips)
  && !/function el\(tag, className, text\) \{/.test(drawerCode)
  && !/function clear\(node\) \{/.test(drawerCode)
  && !/const doc = \(\) => globalThis\.document \|\| null;/.test(drawerCode)
  && !/const byId = id => \(doc\(\) \? doc\(\)\.getElementById\(id\) : null\);/.test(drawerCode),
  'B3 抽屉的节点创建委托给 steward-chips.js 共享的 el()/clear()（117n-M1 去重）：零本地重复定义，createElement 仍可在 chips.js 里查证（零 innerHTML 的证据没消失，只是搬了家）');

// ─── C 轮询纪律：恰好一处 setInterval／clearInterval，且三重门控 ─────────────────
ok(count(drawer, /setInterval\(/g) === 1 && count(drawer, /clearInterval\(/g) === 1,
  `C1 steward-drawer.js 恰好一处 setInterval 与一处 clearInterval（实测 ${count(drawer, /setInterval\(/g)}／${count(drawer, /clearInterval\(/g)}）`);
ok(count(drawer, /setTimeout\(/g) === 0 && count(chips, /setInterval\(|setTimeout\(/g) === 0,
  'C2 抽屉零 setTimeout；chip 模块零计时器（它不轮询，数据由宿主喂）');
ok(/function syncPolling\(\) \{\s*if \(isOpen\(\) && isStewardMode\(\) && !\(doc\(\) && doc\(\)\.hidden\)\) startPolling\(\);\s*else stopPolling\(\);/.test(drawer),
  'C3 唯一入口 syncPolling 的门控是「抽屉开着 && 管家模式 && 页面可见」，任一为否即停表');
ok(count(drawer, /startPolling\(\)/g) === 2 && count(drawer, /stopPolling\(\)/g) === 3,
  `C3b startPolling/stopPolling 只由 syncPolling 与关抽屉调用（实测 ${count(drawer, /startPolling\(\)/g)}／${count(drawer, /stopPolling\(\)/g)}）`);
ok(/document_\.addEventListener\('visibilitychange', syncPolling\);/.test(drawer)
  && /attributeFilter: \['data-shell-mode'\]/.test(drawer),
  'C4 触发点是 visibilitychange 与 data-shell-mode 的 MutationObserver（谁改的都算）');
ok(/function closeDrawer\(\{ focusComposer = false \} = \{\}\) \{[\s\S]*?stopPolling\(\);/.test(drawer),
  'C5 关抽屉即停表（不留「抽屉关着还在刷」的计时器）');
ok(mod.STEWARD_DRAWER_POLL_MS_MIN === 5000
  && /Math\.max\(STEWARD_DRAWER_POLL_MS_MIN, raw\)/.test(drawer),
  'C6 轮询周期取 config.stewardPollMs 并按 5000 下限 clamp（导出常量，不是散落字面量）');
ok(count(stewardShell, /setInterval\(/g) === 1,
  'C7 steward-shell.js 仍然全文件恰好一处 setInterval（117b 的 C2a 未被 117d 稀释）');

// ─── D 快捷回复：确定性纯函数 ────────────────────────────────────────────────────
ok(typeof mod.quickRepliesFor === 'function' && mod.STEWARD_QUICK_REPLIES_MAX === 3,
  'D1 quickRepliesFor 是可 Node import 的导出函数，上限常量为 3');
ok(mod.quickRepliesFor({ pending: { id: 'p', type: 'permission' }, state: 'running', t: key => key })
  .map(reply => reply.behavior).join(',') === 'allow,deny',
  'D2 待决（permission）盖过五态：允许／拒绝');
ok(mod.quickRepliesFor({ lastAssistantText: '继续吗？', state: 'running', t: key => key }).length === 2
  && mod.quickRepliesFor({ state: 'running', t: key => key }).length === 1,
  'D3 问句优先于五态默认；无问句时按五态给（running → 一条）');
ok(/\.slice\(0, STEWARD_QUICK_REPLIES_MAX\)/.test(drawer),
  'D4 渲染处也按 STEWARD_QUICK_REPLIES_MAX 截断（≤3 是两道口径同一个常量）');
ok(/String\(\(option && \(option\.label \|\| option\.value\)\) \|\| ''\)/.test(drawer),
  'D5 question 选项文案取 opt.label || opt.value（与 interaction-prompts.js 同口径）');

// ─── E 拼接读取而不是复制 ────────────────────────────────────────────────────────
ok(/import \{ acceptanceItems, activeAcceptanceIndex, taskProgress, elapsedLabel \} from '\.\/preview-task-sheet\.js';/.test(drawer),
  'E1 验收项／进度／耗时 import 自 preview-task-sheet.js');
ok(/import \{ describeTurnActivity \} from '\.\/turn-activity\.js';/.test(drawer),
  'E2 三问 import 自 turn-activity.js');
ok(/import '\.\/mission-state\.js';/.test(drawer) && /globalThis\.MissionState/.test(drawer),
  'E3 五态经 mission-state.js（UMD，与 preview-shell.js 同款 import 后读 globalThis）');
// 117n-M1 重钉：drawer.js 的 chips import 那一行加了 doc/byId/el/clear（DOM 基础件去重，见 B3
// companion）。原判据只钉 createQuickSwitchChips 这一个名字；新判据仍然要求它在场，且明确写出
// 完整的四个新增名字——比原来更精确，不是放宽。
ok(/import \{ createQuickSwitchChips, doc, byId, el, clear \} from '\.\/steward-chips\.js';/.test(drawer)
  && /createQuickSwitchChips\(\{/.test(drawer),
  'E4 快切 chip 是 mount 进来的共用控件，不是抽屉自己搭的；同一条 import 顺带把 DOM 基础件也接过来');
for (const name of ['acceptanceItems', 'activeAcceptanceIndex', 'taskProgress', 'elapsedLabel', 'describeTurnActivity', 'deriveMissionState']) {
  ok(!new RegExp(`function ${name}\\s*\\(`).test(drawerCode),
    `E5 抽屉不定义同名函数 ${name}（复制即失去「同一份判据」）`);
}
// 权限档只有一个写口：chip 模块。抽屉里连 permissionMode 这个字面量都不该出现。
ok(!/permissionMode/.test(drawerCode),
  'E6 抽屉不自己实现 PATCH permissionMode（线程权限的唯一写口是 steward-chips.js）');
ok(/method: 'PATCH'/.test(chipsCode) && count(chipsCode, /method: 'PATCH'/g) === 1
  && /async function patchSession\(patch\)/.test(chips),
  'E7 chip 模块里也只有一处 PATCH（权限与引擎路由同端点同形状，不许各写一条）');
ok(JSON.stringify(chipsMod.STEWARD_PERMISSION_MODES) === JSON.stringify(['default', 'acceptEdits', 'plan', 'auto'])
  && JSON.stringify(chipsMod.STEWARD_PERMISSION_CONFIRM_MODES) === JSON.stringify(['auto']),
  'E8 四档与「只有全自动要二次确认」是导出常量，与 01-config 的 PERMISSION_MODES 同口径');
ok(chipsMod.STEWARD_CONFIRM_KEYS.length === 5
  && /accept\.onclick = \(\) => \{ closeMenu\(\); patchSession\(\{ permissionMode: mode, confirm: true \}\); \};/.test(chips),
  'E9 §8.6 的二次确认写明五条，确认后才带 confirm:true 发出（服务端还有同一道门）');
ok(/showAutoConfirm\(menu, mode\); return;/.test(chips)
  && /if \(STEWARD_PERMISSION_CONFIRM_MODES\.includes\(mode\)\)/.test(chips),
  'E10 切「全自动」必须先出确认，不许直接 PATCH');
// 117g（2.0 顶栏）与 117h（看板行）要 mount 同一个工厂：导出面必须是「工厂 + mount」，不是抽屉私有。
ok(/export function createQuickSwitchChips\(\{/.test(chips) && /mount,\n\s*setSession,/.test(chips),
  'E11 chip 控件是可挂到任意容器的工厂（117g 顶栏与 117h 看板行复用同一份）');

// ─── F 后端零新增面 ──────────────────────────────────────────────────────────────
const routes = [...new Set([
  ...[...`${drawerCode}\n${chipsCode}`.matchAll(/'(\/api\/[a-z/-]+)[^']*'/g)].map(match => match[1]),
  ...[...`${drawerCode}\n${chipsCode}`.matchAll(/`(\/api\/[a-z/-]+)\$\{/g)].map(match => match[1]),
])].sort();
// 117l D2 **重钉 F1/F2/F4**（用户第四轮走查①⑥；语义是收紧：路由面从两条收成一条）。
// 旧断言钉的是「抽屉自己在 /api/steer 与 /api/chat/stream 之间二选一」（F4 逐字钉了 isLive() 那道
// 判据，F1 的白名单里因此有这两条，F2 钉了那一处直调 fetch）。真机 10:32:34 证明这个二选一是错的：
// 线程挂在 request_user_input 上等答案时【不 live】，于是走 /api/chat/stream 开新回合，
// 09-workflow:1343 的 `activeChildren.has → stopSession('superseded')` 把用户还没回答的那道提问
// 连回合一起杀了（turn_kill reason:superseded，§11.9.2 ①⑥）。117l 把通道判定收进服务端单点
// （13h 的 stewardRelayChannelFor：answer > permission > steer > turn），抽屉只剩一个口子。
// 所以白名单加 /api/steward/relay、去掉 /api/steer 与 /api/chat/stream；F2 从「恰好一处 fetch」
// 收紧成「零处 fetch」（不再需要读流，也就不再需要 authHeaders）。
const ALLOWED = [
  '/api/agent-runs/', '/api/chat/answer', '/api/interventions',
  '/api/missions', '/api/missions/', '/api/permission/decision', '/api/session/rewind',
  '/api/sessions/', '/api/steward/relay', '/api/stop',
].sort();
ok(JSON.stringify(routes) === JSON.stringify(ALLOWED),
  `F1 递话收成单口：白名单里有 /api/steward/relay，没有 /api/steer 与 /api/chat/stream（实测 ${JSON.stringify(routes)}）`);
ok(count(drawerCode, /\bfetch\(/g) === 0 && !/authHeaders/.test(drawerCode)
  && /import \{ apiErrorInfo \} from '\.\/net\.js';/.test(drawer),
  `F2 抽屉零直调 fetch（不再读流）；net.js 那一份改取 apiErrorInfo —— relay 的失败是结构化信封（实测 fetch=${count(drawerCode, /\bfetch\(/g)}）`);
ok(count(chipsCode, /\bfetch\(/g) === 0, 'F3 chip 模块一律经注入的 api()，零直调 fetch');
ok(/const relayed = await api\('\/api\/steward\/relay', \{ method: 'POST', body: JSON\.stringify\(\{ sessionId, message \}\) \}\);/.test(drawer)
  && !/api\('\/api\/steer'/.test(drawerCode) && !/\/api\/chat\/stream/.test(drawerCode),
  'F4 「直接对这条线程说」走 relay 单口，抽屉不再自己在 /api/steer 与 /api/chat/stream 之间猜');
// companion：通道是【服务端】判的，抽屉只把回执文案按 channel 分档 —— 它自己没有第二套判据。
ok(/const RELAY_NOTE_KEYS = Object\.freeze\(\{\s*answer:/.test(drawer)
  && !/isLive\(\)/.test(drawer.slice(drawer.indexOf('async function sayToThread'), drawer.indexOf('async function runQuickReply'))),
  'F4b companion：sayToThread 里一个 isLive() 都没有（通道判定不在前端）');
// 选项按钮与「有本地待决 question 时的自由回答」仍走 /api/chat/answer（带 content 与 otherText）——
// 那是「回答一道正式提问」，不是「递一句话」，两者本来就是两条路。
ok(/answers: \[\{ questionId: String\(\(first && first\.id\) \|\| ''\), selectedOptionIds: \[\], otherText: text \}\],\s*content: text,/.test(drawer),
  'F4c 问答卡的自由回答（有本地待决时）走 /api/chat/answer，content 与 otherText 都带上');
ok(/targetTurnSeq: target, rollbackFiles: true/.test(drawer)
  && /function firstUserTurnSeq\(\)/.test(drawer)
  && drawer.indexOf("api('/api/stop'") < drawer.indexOf("api('/api/session/rewind'"),
  'F5 整单回退＝先 stop 再 rewind，锚点是第一条用户消息那一回合（与 117d 第 0 步同口径）');

// ─── G 新样式层三处登记 + token / 降级 / 断点 ────────────────────────────────────
ok(styles.includes('@import url("/css/views/steward-drawer.css");')
  && html.includes('<link rel="stylesheet" href="/css/views/steward-drawer.css" />'),
  'G1 styles.css @import 与 index.html 直链同步收录 steward-drawer.css');
ok(readFrontendCss.includes("'css/views/steward-drawer.css',"),
  'G2 read-frontend-css.js 的 CSS_PAYLOAD_GROUPS 收录 steward-drawer.css');
ok(overlay.includes("'app/public/css/views/steward-drawer.css'")
  && overlay.includes("'app/public/js/steward-drawer.js'")
  && overlay.includes("'app/public/js/steward-chips.js'"),
  'G3 离线包清单收录 117d 的三个新文件');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(cssCode), 'G4 抽屉层 CSS 全部使用主题/语义 token，无硬编码色值');
ok(/@media \(prefers-reduced-motion: reduce\) \{/.test(cssCode) && /transition: none;/.test(cssCode),
  'G5 reduced-motion 下过渡全关（动效可以没有，信息不能少）');
ok(/@media \(max-width: 390px\)/.test(cssCode), 'G6 390px 窄屏断点存在');
ok(/@media \(min-width: 1000px\)/.test(cssCode) && /width: 390px;/.test(cssCode)
  && /\.steward-shell\[data-drawer="open"\] \{\s*padding-right:/.test(cssCode),
  'G7 ≥1000px 抽屉占右侧 390px 栏且对话区收窄；窄屏回全屏覆盖');
ok(/\.steward-drawer\[hidden\] \{ display: none; \}/.test(cssCode),
  'G8 显隐由 [hidden] 驱动（JS 不写 display，壳模式属性也不归本层管）');

// ─── H i18n ──────────────────────────────────────────────────────────────────────
for (const prefix of ['stewardShell.drawer.', 'stewardShell.chips.', 'stewardShell.permission.']) {
  const zhKeys = Object.keys(zh).filter(key => key.startsWith(prefix)).sort();
  const enKeys = Object.keys(en).filter(key => key.startsWith(prefix)).sort();
  ok(zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `H1 ${prefix}* 中英键对称（${zhKeys.length} 条）`);
}
const usedKeys = [...new Set([
  ...[...`${drawer}\n${chips}`.matchAll(/'(stewardShell\.[a-zA-Z0-9_.]+)'/g)].map(match => match[1]),
  ...[...`${drawer}
${chips}`.matchAll(/`(stewardShell\.[a-zA-Z0-9_.]+)\$\{/g)].map(match => match[1]),
])];
const templated = usedKeys.filter(key => key.endsWith('.'));
const literal = usedKeys.filter(key => !key.endsWith('.'));
const missing = literal.filter(key => typeof zh[key] !== 'string' || typeof en[key] !== 'string');
ok(missing.length === 0, `H2 两模块引用的 ${literal.length} 个 i18n 键中英都齐备（缺: ${missing.join(',') || '无'}）`);
// 模板键（五态标签、四档 label/hint）按枚举逐条核对，不能只靠前缀存在。
for (const value of ['dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask']) {
  const key = `stewardShell.drawer.state.${value}`;
  ok(typeof zh[key] === 'string' && typeof en[key] === 'string', `H3 五态人话 ${value} 中英齐备`);
}
for (const mode of chipsMod.STEWARD_PERMISSION_MODES) {
  ok(typeof zh[`stewardShell.permission.${mode}.label`] === 'string'
    && typeof zh[`stewardShell.permission.${mode}.hint`] === 'string'
    && typeof en[`stewardShell.permission.${mode}.label`] === 'string'
    && typeof en[`stewardShell.permission.${mode}.hint`] === 'string',
    `H4 权限档 ${mode} 有 label 与一句人话 hint（中英）`);
}
ok(templated.length === 2, `H4b 只有五态与权限档两组模板键（实测 ${JSON.stringify(templated)}）`);
// 禁词：界面不出现系统标签，也不提前暴露内部代号（locale 一侧只查 stewardShell.* 命名空间，
// 与 117c 同一理由 —— 「速问」是交办台预览壳自己的产品词）。
const FORBIDDEN = [/速问/, /不立单/, /已切到档位/, /Pretender/, /3\.0/];
const stewardKeys = Object.keys(zh).filter(key => key.startsWith('stewardShell.'));
for (const pattern of FORBIDDEN) {
  ok(!pattern.test(drawerCode) && !pattern.test(chipsCode) && !pattern.test(cssCode),
    `H5 两模块与样式层零出现 ${pattern.source}`);
  ok(stewardKeys.every(key => !pattern.test(String(zh[key])) && !pattern.test(String(en[key]))),
    `H6 stewardShell.* 文案零出现 ${pattern.source}`);
}

// ─── I 组装：app.js 只加一行注入，抽屉住在 steward-shell.js 里 ──────────────────
const app = read('app.js');
ok(app.split(/\r?\n/).length <= 1280, `I1 组合根仍在 D45 护栏内（实测 ${app.split(/\r?\n/).length} 行）`);
ok(/openSession, \/\/ 117d/.test(app) && !/createStewardDrawer/.test(app),
  'I2 app.js 只多注入一个 openSession；抽屉的组装住在 steward-shell.js 里');
ok(/const drawer = createStewardDrawer\(\{ api, state, t, isStewardMode, applyShellMode, openSession \}\);/.test(stewardShell)
  && /drawer\.bindStewardDrawer\(\);/.test(stewardShell),
  'I3 steward-shell.js 组装并绑定抽屉（依赖注入，与 117c 两个子域同款）');
ok(/globalThis\.document\.addEventListener\(STEWARD_NEW_THREAD_EVENT/.test(stewardShell)
  && /markNewInMission: missionId => \{/.test(composer)
  && !/steward-composer\.js/.test(drawer),
  'I4 「＋ 线程」经事件把 chip 置为「在事项下新开」，抽屉不 import composer（迟绑定同款纪律）');
ok(mod.STEWARD_NEW_THREAD_EVENT === 'steward:new-thread'
  && /new CustomEvent\(STEWARD_NEW_THREAD_EVENT/.test(drawer),
  'I5 新线程事件名是导出常量，派发处引用常量而不是字面量');
ok(/document_\.addEventListener\('steward:open-thread'/.test(drawer)
  && /document_\.addEventListener\('steward:focus-thread'/.test(drawer),
  'I6 抽屉接 117c 派发的两个事件（steward:open-thread / steward:focus-thread）');
ok(/openThread,/.test(drawer) && /drawer,\n\s*\}\);/.test(stewardShell),
  'I7 openThread 与 drawer 子域都导出（117h「现在这一件」直接调，不另起一份抽屉）');

// ─── J 117l D4：④ 问答卡、⑧「更多」、liveTail、焦点 ──────────────────────────────
// 骨架仍然静态写在 index.html 里（与 A3 同一条纪律：JS 只填内容，不现搭区块）。
ok(/<section id="stewardDrawerAsk"[^>]*class="steward-drawer-ask"[\s\S]{0,200}?hidden/.test(html)
  && html.includes('id="stewardDrawerAskText"') && html.includes('id="stewardDrawerAskOptions"')
  && html.includes('id="stewardDrawerAskInput"') && html.includes('id="stewardDrawerAskSendBtn"'),
  'J1 ④ 问答卡骨架（问题原文／选项／回答框／回答键）静态写在 index.html 里，默认 hidden');
ok(/\.steward-drawer-ask\[hidden\] \{ display: none; \}/.test(cssCode),
  'J1b **[hidden] 守卫**：.steward-drawer-ask 那条 display:flex 是作者样式，会压过 UA 表的 [hidden]（本层第三处同款）');
const moreOpen = html.indexOf('<details id="stewardDrawerMore"');
const moreClose = html.indexOf('</details>', moreOpen);
ok(moreOpen > 0 && moreClose > moreOpen && !/<details id="stewardDrawerMore"[^>]*\bopen\b/.test(html),
  'J2 ⑧「更多」是 <details> 且【默认收起】（没有 open 属性）');
for (const id of mod.STEWARD_DRAWER_MORE_BLOCK_IDS) {
  const at = html.indexOf(`id="${id}"`);
  ok(at > moreOpen && at < moreClose, `J2b ${id} 真的在「更多」容器【内】`);
}
ok(!/\.steward-drawer-more \{[^}]*display:\s*(flex|grid)/.test(cssCode),
  'J2c 样式层【不】给 <details> 本身写 display:flex/grid —— 那会让收起来的内容照样画出来，「默认收起」当场失效');
ok(typeof mod.liveTailSentences === 'function'
  && mod.liveTailSentences('一。二。三。四。') === '二。三。四。'
  && mod.lastSaySentences('一。二。三。四。') === '一。二。三。',
  'J3 活回合取【末尾】≤3 句、落盘原话取【开头】≤3 句（两个导出纯函数，切句判据同一张标点表）');
ok(/liveTail = \(sessionRes\.liveTail && typeof sessionRes\.liveTail === 'object'\) \? sessionRes\.liveTail : null;/.test(drawer)
  && count(drawerCode, /\/api\/sessions\//g) === 1,
  `J3b liveTail 从既有那一发 GET /api/sessions/:id 的信封里读，零新请求（实测 /api/sessions/ 出现 ${count(drawerCode, /\/api\/sessions\//g)} 次）`);
ok(/const streaming = Boolean\(liveTail\) && Boolean\(tailText\);/.test(drawer)
  && /head\.textContent = t\('stewardShell\.drawer\.liveSay'\);/.test(drawer)
  && /head\.textContent = t\('stewardShell\.drawer\.lastSay'\);/.test(drawer),
  'J3c 在跑说「它正在说」，不在跑换回「它刚说」（liveTail 这个键不在 = 回合结束了）');
// 判据【不许】叠 isLive()：13d 的 live 分支回的 resumable 里根本没有 live 字段，isLive() 于是
// 回落到「事项行五态是不是 running」——挂在提问上的回合五态是 needs_you，叠上去就恒判成不在跑
// （实测：E6 直接说「它还没说过话」）。服务端只在真有活回合时下发 liveTail，那才是权威判据。
ok(!/Boolean\(liveTail\) && isLive\(\)/.test(drawer),
  'J3d 「在不在跑」只看 liveTail 在不在，不叠 isLive()');
ok(/t\('stewardShell\.drawer\.usingTool', \{ tool: threadToolLabel\(tool\) \}\)/.test(drawer)
  && /function threadToolLabel\(tool\) \{[\s\S]{0,200}return key \? t\(key\) : t\('stewardShell\.drawer\.tool\.other'\);/.test(drawer),
  'J4 工具说人话（铁律：界面上永远不出现工具名），表外落到「用一个工具」');
// 117m-A2 **重钉 J5**（用户第六轮走查⑤⑥；语义是「一类放开成四类」，不是放宽）。
// 旧断言里那一条 `asksYouFrom({ pending: { type: 'permission' } }) === null` 钉住的正是本波要修的
// bug 本身：真机 sess_8bb0dd55d35045b0 的 14 条待决全是 permission（最后一条 02:34:57 请求、
// 02:36:57 被 timeout 拒掉），于是抽屉一张问答卡都不出 —— 右上说「需要你 1」，点进去什么都没有。
// 现在四类待决（question > permission > plan > pool，与服务端 06i 逐字同序）都出卡；
// 三条 companion（J5a/J5a2/J5a3）比旧断言更强：它们钉住形状、钉住「人话只有服务端一个来源」、
// 也钉住四类之外的 replan 仍然回 null（不是把闸门整个拆掉）。
ok(typeof mod.asksYouFrom === 'function'
  && mod.asksYouFrom({ pending: { id: 'p1', type: 'question', questions: [{ question: '用哪个？' }] } }).kind === 'question'
  && mod.asksYouFrom({ rowAsksYou: { kind: 'soft', text: '要接着做吗？' } }).texts[0] === '要接着做吗？'
  && mod.asksYouFrom({ lastAssistantText: '看完了。要不要我继续？' }).kind === 'soft'
  && mod.asksYouFrom({ lastAssistantText: '看完了。要不要我继续？', live: true }) === null
  && mod.asksYouFrom({ lastAssistantText: '看完了。' }) === null,
  'J5 「它在问你」是可 Node import 的纯函数：待决 question > 行上的 asksYou > 客户端兜底；在跑就不算');
{
  const perm = mod.asksYouFrom({
    pending: { id: 'perm_1', type: 'permission', sessionId: 'sess_a', interventionVersion: 2, toolName: 'script_run', tier: 'exec', revertible: false },
    rowAsksYou: { kind: 'permission', text: '工具 script_run(exec 级)等待放行' },
  });
  const plan = mod.asksYouFrom({ pending: { id: 'plan_1', type: 'plan', sessionId: 'sess_a' }, rowAsksYou: { kind: 'plan', text: '先清库存再补货' } });
  const pool = mod.asksYouFrom({ pending: { id: 'pool_1', type: 'pool', sessionId: 'sess_a' }, rowAsksYou: { kind: 'pool', text: '再加一条子任务' } });
  const noRow = mod.asksYouFrom({ pending: { id: 'perm_2', type: 'permission', sessionId: 'sess_a' } });
  const replan = mod.asksYouFrom({ pending: { id: 'replan_1', type: 'replan', sessionId: 'sess_a' } });
  ok(perm.kind === 'permission' && perm.interventionId === 'perm_1' && perm.missionId === 'sess_a'
    && perm.interventionVersion === 2 && perm.toolName === 'script_run' && perm.tier === 'exec' && perm.revertible === false
    && perm.texts[0] === '工具 script_run(exec 级)等待放行'
    && plan.kind === 'plan' && plan.texts[0] === '先清库存再补货'
    && pool.kind === 'pool' && pool.texts[0] === '再加一条子任务',
    'J5a companion：permission/plan/pool 三类都出卡；permission 带上 toolName/tier/revertible（抽屉据此说「这一步要动什么」）');
  ok(noRow.kind === 'permission' && noRow.texts.length === 0 && replan === null,
    'J5a2 companion：行上的 asksYou 还没到就【不摆那句话】（人话单点在服务端 06i 的 stewardPendingOneLine）；四类白名单外的 replan 仍回 null');
  ok(JSON.stringify(mod.STEWARD_ASK_PENDING_KINDS) === JSON.stringify(['question', 'permission', 'plan', 'pool']),
    'J5a3 companion：优先级表是导出的冻结常量，与服务端 06i 的 stewardAsksYouForThread 逐字同序');
}
ok(/const ask = asksYouNow\(\);\s*section\.hidden = !ask;/.test(drawer),
  'J5b 卡片只在真有人问你时出现（[hidden] 一处驱动）');
ok(/if \(section\) section\.hidden = askOptionReplies\(\)\.length > 0;/.test(drawer),
  'J6 ④ 已经把选项摆出来时 ⑦「你可以说」整块隐藏（不出现两排一样的按钮）');
ok(/function askOptionReplies\(\) \{[\s\S]{0,320}return quickRepliesFor\(\{ pending: pendingForThread, t \}\)/.test(drawer),
  'J6b 选项按钮复用 quickRepliesFor（与 ⑦ 同一份判据，不另写一遍「取 label || value」）');
ok(/if \(sessionId === id\) \{ loading = false; renderAll\(\); focusAsk\(\); \}/.test(drawer),
  'J7 焦点在【loading 闸落下之后】才给问答框（闸落之前还不知道它有没有在问你）');
// 117m-A2 **重钉 J7b**（语义是「焦点从只认输入框放到第一个可操作控件」，不是放宽）。
// 旧断言逐字钉着 `if (!section || section.hidden || !input` —— permission／plan／pool 的卡片
// 【没有】输入框（renderAsk 把自由输入整块隐藏了：那三类是按一下的事）。只认输入框的话，
// 从「N 条等你」直达跳过来会一个焦点都不落，人照样不知道该点哪儿。
// companion（J7c）比旧断言更强：它同时钉住「没有输入框时落到第一枚按钮」与「把卡片滚进视野」。
ok(/function focusAsk\(\) \{[\s\S]{0,160}if \(!section \|\| section\.hidden\) return false;/.test(drawer),
  'J7b 卡片没出现时不抢焦点');
ok(/const target = \(input && !\(answer && answer\.hidden\)\)/.test(drawer)
  && /\.querySelector\('\.steward-drawer-reply'\)/.test(drawer)
  && /section\.scrollIntoView\(\{ block: 'nearest' \}\)/.test(drawer),
  'J7c companion：焦点落在【第一个可操作控件】上（有输入框就是它，没有就是第一枚按钮），并把卡片滚进视野');
ok(/t\('stewardShell\.drawer\.settledSince', \{ elapsed \}\)/.test(drawer)
  && /const touched = String\(\(missionRow && missionRow\.updatedAt\) \|\| \(session && session\.updatedAt\) \|\| ''\);/.test(drawer)
  && !/stewardShell\.drawer\.settled'/.test(drawer),
  'J8 「已收工 · 最近动过 X 前」锚在 updatedAt（修前锚在 createdAt，真机上说成「用时 770h 35m」）');
ok(typeof zh['stewardShell.drawer.settled'] === 'undefined' && typeof en['stewardShell.drawer.settled'] === 'undefined',
  'J8b 旧键 stewardShell.drawer.settled 已随最后一个引用一起删掉（零引用键不留在目录里）');
// 看板行那枚 pill（117l D4）：只读行上的 asksYou，点击 = 打开抽屉。
const board = read('js/steward-board.js');
// 117m-A2 **重钉 J9**（语义是「一句话变四句」，不是放宽）：旧断言逐字钉着 `t('stewardShell.board.asksYou')`
// 这一句写死的文案，于是 permission／plan／pool 三类只能顶着「它在问你」出现 —— 用户看不出
// 点进去要干什么。现在文案由 asksYou.kind 决定（表在 STEWARD_BOARD_ASKS_YOU_KEYS），
// 并额外钉住「看板里没有第二处写死的那句话」（比旧断言更强）。
ok(/if \(row\.asksYou && typeof row\.asksYou === 'object' && String\(row\.asksYou\.kind \|\| ''\)\) \{/.test(board)
  && /pill\.onclick = \(\) => openThread\(sessionId\);/.test(board)
  && /t\(STEWARD_BOARD_ASKS_YOU_KEYS\[kind\] \|\| STEWARD_BOARD_ASKS_YOU_KEYS\.soft\)/.test(board)
  && !/t\('stewardShell\.board\.asksYou'\)/.test(board),
  'J9 看板行 pill 的文案【由 asksYou.kind 决定】（不是写死一句），点它仍然是打开抽屉（问答卡在那儿）');

// ─── 117m-A2：问答卡吃下四类待决（用户第六轮走查⑤⑥「需要我允许的也没在线程中」）──────────
ok(/const ASK_HEAD_KEYS = Object\.freeze\(\{[\s\S]{0,400}permission: 'stewardShell\.drawer\.asksYouPermission',[\s\S]{0,120}plan: 'stewardShell\.drawer\.asksYouApprove',[\s\S]{0,80}pool: 'stewardShell\.drawer\.asksYouApprove',/.test(drawer)
  && /head\.textContent = t\(ASK_HEAD_KEYS\[kind\] \|\| ASK_HEAD_KEYS\.soft\);/.test(drawer),
  'J10 卡片标题按【哪一类在等你】说话（它在问你／它等你放行／等你批），不是写死一句');
ok(/if \(meta && kind === 'permission'\) \{/.test(drawer)
  && /t\('stewardShell\.drawer\.askScope', \{/.test(drawer)
  && /t\(ask\.revertible === true \? 'stewardShell\.drawer\.askRevertible' : 'stewardShell\.drawer\.askIrreversible'\)/.test(drawer),
  'J10b permission 卡多两行「这一步要动什么」＋可撤销徽章；徽章只认 revertible 这一个落盘事实（有就说有，没有就说无法自动撤销，不编第三种）');
ok(/if \(answer\) answer\.hidden = kind === 'permission' \|\| kind === 'plan' \|\| kind === 'pool';/.test(drawer)
  && html.includes('id="stewardDrawerAskAnswer"') && html.includes('id="stewardDrawerAskMeta"'),
  'J10c permission／plan／pool 是按一下的事：自由输入整块隐藏（别让人以为要打完字才算数），两个新锚点静态写在 index.html 里');
ok(count(drawerCode, /\/api\/permission\/decision/g) === 1
  && /if \(reply\.kind === 'permission'\) \{[\s\S]{0,200}api\('\/api\/permission\/decision'/.test(drawer),
  `J11 permission 的决策仍然只有 /api/permission/decision 这一条路（实测 ${count(drawerCode, /\/api\/permission\/decision/g)} 处）`);
ok(/\} else if \(reply\.kind === 'plan' \|\| reply\.kind === 'pool'\) \{/.test(drawer)
  && /api\(`\/api\/missions\/\$\{encodeURIComponent\(reply\.missionId\)\}\/interventions\/\$\{encodeURIComponent\(reply\.interventionId\)\}\/decision`/.test(drawer)
  && !/\/api\/plan\/decision/.test(drawerCode) && !/pool_approve/.test(drawerCode),
  'J11b plan／pool 复用 75b 立的统一决策契约端点，不去找 /api/plan/decision 与 pool_approve 那两个老适配器（否则决策路径就有四条）');
ok(/function askOptionReplies\(\) \{[\s\S]{0,900}if \(type !== 'plan' && type !== 'pool'\) return \[\];/.test(drawer),
  'J11c 四类白名单之外（replan…）一枚按钮都不给 —— 给一枚点了没用的按钮比不给更坏');

console.log(`\nSTEWARD DRAWER STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
