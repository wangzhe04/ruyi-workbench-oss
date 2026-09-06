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
ok(Array.isArray(BLOCKS) && BLOCKS.length === 11 && Object.isFrozen(BLOCKS),
  `A1 导出的区块顺序表是冻结的 11 项（实测 ${BLOCKS && BLOCKS.length}）`);
ok(JSON.stringify(BLOCKS) === JSON.stringify([
  'stewardDrawerMission',      // ① 事项行
  'stewardDrawerTabs',         // ② 线程页签
  'stewardDrawerHead',         // ③ 线程头
  'stewardDrawerChips',        // ④ 快切 chip
  'stewardDrawerLastSay',      // ⑤ 它刚说
  'stewardDrawerQuickReplies', // ⑥ 你可以说
  'stewardDrawerRelay',        // ⑦ 接力关系
  'stewardDrawerActivity',     // ⑧ 三问
  'stewardDrawerAcceptance',   // ⑨ 验收项
  'stewardDrawerScene',        // ⑩ 现场
  'stewardDrawerFoot',         // ⑪ 底部
]), `A2 区块顺序逐字为 §8.13 那一串（实测 ${JSON.stringify(BLOCKS)}）`);
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
ok(/createElement\(/.test(drawer) && /textContent/.test(drawer) && /createElement\(/.test(chips),
  'B3 两模块一律 createElement + textContent 生成（零 innerHTML 的正面证据）');

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
ok(/import \{ createQuickSwitchChips \} from '\.\/steward-chips\.js';/.test(drawer)
  && /createQuickSwitchChips\(\{/.test(drawer),
  'E4 快切 chip 是 mount 进来的共用控件，不是抽屉自己搭的');
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
const ALLOWED = [
  '/api/agent-runs/', '/api/chat/answer', '/api/chat/stream', '/api/interventions',
  '/api/missions', '/api/missions/', '/api/permission/decision', '/api/session/rewind',
  '/api/sessions/', '/api/steer', '/api/stop',
].sort();
ok(JSON.stringify(routes) === JSON.stringify(ALLOWED),
  `F1 只调既有路由，零新增后端面（实测 ${JSON.stringify(routes)}）`);
ok(count(drawerCode, /\bfetch\(/g) === 1 && /await response\.text\(\);/.test(drawer)
  && /import \{ authHeaders \} from '\.\/net\.js';/.test(drawer),
  'F2 唯一的直调 fetch 是 POST /api/chat/stream（api() 吃不下流），鉴权头复用 net.js；抽屉不渲染流');
ok(count(chipsCode, /\bfetch\(/g) === 0, 'F3 chip 模块一律经注入的 api()，零直调 fetch');
ok(/if \(isLive\(\)\) \{[\s\S]{0,200}api\('\/api\/steer'/.test(drawer),
  'F4 线程在途走插话通道（/api/steer），空闲才开新回合 —— 两条都【不经管家】（§8.13）');
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

console.log(`\nSTEWARD DRAWER STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
