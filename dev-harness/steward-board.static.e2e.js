#!/usr/bin/env node
'use strict';

// 第117波 117h 静态契约（27 号文 §5 117h 行／§8.10「多线程看板与注意力预算」／§8.2 L1「一行状态
// （点开即看板）」）：
//   A DOM 锚点：一行状态住 #stewardHeader（button + aria-expanded + aria-controls），看板是 role="region"
//     的下拉面板，「现在这一件」只是一个挂点（它不渲染任何抽屉区块）；
//   B 不另起判据：聚合态【只读】行上的 aggregateState（零 aggregateMissionState 字面实现），五态经
//     mission-state.js，`needs_you` 只在焦点优先级那一处出现，等待原因只渲染 wait.label 一处；
//   C 焦点线程只经导出的纯函数 focusThreadFor（可 Node import，真值表见 unit 件）；
//   D 快切 chip 经 steward-chips.js 的同一个工厂（紧凑模式），看板不自己 PATCH；线程动作原语经
//     steward-drawer.js 导出的那一段（不复制）；
//   E 抽屉复用：看板模块不渲染 STEWARD_DRAWER_BLOCK_IDS 里的任何 id，「现在这一件」靠 setMount('docked')
//     把【同一个】节点搬过去；
//   F 刷新纪律：本模块恰好一处 setInterval／一处 clearInterval，且锁在三重门控里；零 innerHTML；
//   G 新样式层三处登记 ＋ 零硬编码色 ＋ reduced-motion ＋ 1000px 与 390px 断点；
//   H i18n 两组键中英对称、源码引用的键都齐备、禁词零出现。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const html = read('index.html');
const board = read('js/steward-board.js');
const classicWindow = read('js/steward-classic-window.js');
const drawer = read('js/steward-drawer.js');
const chips = read('js/steward-chips.js');
const stewardShell = read('js/steward-shell.js');
const conversation = read('js/steward-conversation.js');
const css = read('css/views/steward-board.css');
const styles = read('styles.css');
const zh = JSON.parse(read('locales/zh-CN.json'));
const en = JSON.parse(read('locales/en-US.json'));
const overlay = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');
const readFrontendCss = fs.readFileSync(path.join(__dirname, 'read-frontend-css.js'), 'utf8');

// 注释里要写清「不另起聚合判据」「等待原因只有一处」这些纪律本身，所以扫之前先剥注释
// （与 steward-drawer.static / steward-conversation.static 同款）。
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const boardCode = stripComments(board);
const classicCode = stripComments(classicWindow);
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
const count = (source, pattern) => (source.match(pattern) || []).length;

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {

// steward-board.js 经 preview-shell.js（dockToneForMissionState 住那儿，复用而不是复制）拉到
// state.js，那个文件在模块顶层写一次 `window.state` 的兼容层。给它一个 window 别名即可 ——
// 不引入任何 DOM，导出的仍然是纯函数与工厂本身（unit 件用的是同一个办法）。
if (!globalThis.window) globalThis.window = globalThis;
const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-board.js')).href);
const drawerMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-drawer.js')).href);

// ─── A DOM 锚点 ─────────────────────────────────────────────────────────────────
const headerStart = html.indexOf('id="stewardHeader"');
const headerEnd = html.indexOf('</header>', headerStart);
const header = html.slice(headerStart, headerEnd);
ok(/<button type="button" id="stewardStatusLine" class="steward-status-line"/.test(header)
  && /aria-expanded="false"/.test(header) && /aria-controls="stewardBoard"/.test(header),
  'A1 一行状态是 #stewardHeader 里的 button，带 aria-expanded 与 aria-controls（点开即看板）');
ok(/<div id="stewardBoard" class="steward-board" role="region"[\s\S]{0,240}?hidden>/.test(html),
  'A2 #stewardBoard 是默认 hidden 的 role="region" 面板');
for (const id of ['stewardBoardMax', 'stewardBoardRunning', 'stewardBoardQueued',
  'stewardBoardPauseAllBtn', 'stewardBoardClassicBtn', 'stewardBoardList', 'stewardBoardNote']) {
  ok(new RegExp(`id="${id}"`).test(html), `A3 看板骨架锚点 ${id} 静态写在 index.html 里`);
}
ok(/<input type="number" id="stewardBoardMax"[^>]*min="1"[^>]*max="32"/.test(html)
  && mod.STEWARD_MAX_PARALLEL_MIN === 1 && mod.STEWARD_MAX_PARALLEL_MAX === 32,
  'A4 并发上限就地可改，区间 [1,32] 与 01-config 同口径（导出常量，不是散落字面量）');
ok(/<aside id="stewardNow" class="steward-now"[\s\S]{0,240}?hidden>/.test(html)
  && html.includes('id="stewardNowBody"') && html.includes('id="stewardNowCloseBtn"'),
  'A5 #stewardNow 默认 hidden，带一个挂点 #stewardNowBody 与「关掉」');
const shellAt = html.indexOf('id="stewardShell"');
const boardAt = html.indexOf('id="stewardBoard"');
const nowAt = html.indexOf('id="stewardNow"');
const drawerAt = html.indexOf('id="stewardDrawer"');
ok(shellAt > 0 && boardAt > shellAt && nowAt > boardAt && drawerAt > nowAt,
  'A6 看板与「现在这一件」都住在 #stewardShell 里，且排在抽屉骨架之前');
// 「现在这一件」只是挂点：它的静态骨架里不许出现任何抽屉区块 id（那一份只有 #stewardDrawer 有）。
const nowMarkup = html.slice(nowAt, html.indexOf('</aside>', nowAt));
ok(drawerMod.STEWARD_DRAWER_BLOCK_IDS.every(id => !nowMarkup.includes(id)),
  'A7 #stewardNow 的骨架零抽屉区块 id（内容是搬过去的同一个 #stewardDrawer 节点）');

// ─── B 不另起判据 ───────────────────────────────────────────────────────────────
ok(/import '\.\/mission-state\.js';/.test(board) && /globalThis\.MissionState/.test(board)
  && /missionState\.fromCard\(card\)/.test(board),
  'B1 线程五态经 mission-state.js 的 fromCard（全仓唯一判据，与抽屉、交办台同源）');
for (const name of ['deriveMissionState', 'aggregateMissionState', 'dockToneForMissionState', 'elapsedLabel']) {
  ok(!new RegExp(`function ${name}\\s*\\(`).test(boardCode),
    `B2 看板不定义同名函数 ${name}（复制即失去「同一份判据」）`);
}
ok(/import \{ dockToneForMissionState \} from '\.\/preview-shell\.js';/.test(board)
  && /import \{ elapsedLabel \} from '\.\/preview-task-sheet\.js';/.test(board),
  'B3 五态点的三档表现与耗时文案都是 import 复用（拼接读取，不是复制）');
// 聚合态：只读行上的 aggregateState，绝不在这里长出第二套「任一 needs_you 则…」的判据。
const aggregateSites = [...boardCode.matchAll(/aggregateState/g)].length;
ok(aggregateSites > 0 && !/aggregateMissionState/.test(boardCode)
  && /row\.aggregateState/.test(boardCode) && /group\.aggregateState/.test(boardCode),
  `B4 事项聚合态只读行上的 aggregateState（${aggregateSites} 处引用，零 aggregateMissionState 实现）`);
// needs_you 在本模块只允许出现在两处，两处都【不是】聚合判据：
//   ① focusThreadFor 的焦点优先级（先看哪一条）；② 状态行里「B 条等你」的计数。
// 事项的聚合态永远只读行上的 aggregateState —— 多出第三处就说明有人在这里重写判据了。
const needsYouSites = count(boardCode, /needs_you/g);
const focusBody = boardCode.slice(boardCode.indexOf('export function focusThreadFor'),
  boardCode.indexOf('export function createStewardBoard'));
const statusBody = boardCode.slice(boardCode.indexOf('function renderStatusLine'),
  boardCode.indexOf('function renderArbiterFacts'));
ok(needsYouSites === 2 && count(focusBody, /needs_you/g) === 1 && count(statusBody, /needs_you/g) === 1,
  `B5 'needs_you' 字面量恰好两处（焦点优先级 1 ＋ 状态行计数 1，零聚合判据；实测 ${needsYouSites}）`);
// 等待原因单一性（§8.10「排队可解释」）：wait.label 只渲染一处，没有第二套等待文案。
ok(count(boardCode, /wait\.label/g) === 1,
  `B6 每行只渲染 wait.label 一处（实测 ${count(boardCode, /wait\.label/g)}）`);
ok(/stewardShell\.drawer\.state\./.test(board) && !/stewardShell\.board\.state\./.test(board),
  'B7 五态人话复用抽屉那一组键，不另开第二套 stewardShell.board.state.*');

// ─── C 焦点线程只经纯函数 ───────────────────────────────────────────────────────
ok(typeof mod.focusThreadFor === 'function',
  'C1 focusThreadFor 是可 Node import 的导出纯函数（真值表见 unit/steward-focus-thread.test.js）');
ok(mod.focusThreadFor([]) === null
  && mod.focusThreadFor([{ sessionId: 'a', state: 'running' }, { sessionId: 'b', state: 'needs_you' }]).sessionId === 'b',
  'C2 e2e 侧再钉一次：空清单 → null；等你压过在跑');
const factoryBody = boardCode.slice(boardCode.indexOf('export function createStewardBoard'));
ok(count(factoryBody, /focusThreadFor\(/g) === 1,
  `C3 工厂里只有一处调用 focusThreadFor（焦点线程没有第二条路，实测 ${count(factoryBody, /focusThreadFor\(/g)}）`);
ok(/document_\.addEventListener\(STEWARD_FOCUS_THREAD_EVENT, focusFrom\);/.test(board)
  && /document_\.addEventListener\(STEWARD_OPEN_THREAD_EVENT, focusFrom\);/.test(board),
  'C4 显式选线程（117c/117d 的两个事件）覆盖自动挑选');
ok(mod.STEWARD_NOW_CLOSED_KEY === 'wcw.stewardNowClosed'
  && /localStorage\.setItem\(STEWARD_NOW_CLOSED_KEY, '1'\)/.test(board)
  && /localStorage\.removeItem\(STEWARD_NOW_CLOSED_KEY\)/.test(board),
  'C5 「关掉」记在本机偏好里（导出常量，不是散落字面量）');
ok(mod.STEWARD_NOW_MIN_WIDTH === 1000 && /min-width: \$\{STEWARD_NOW_MIN_WIDTH\}px/.test(board),
  'C6 ≥1000px 才常驻，断点是导出常量（与 CSS 那一条同一个数）');

// ─── D chip 与线程动作原语都是复用 ──────────────────────────────────────────────
ok(/import \{ createQuickSwitchChips \} from '\.\/steward-chips\.js';/.test(board)
  && /compact: true,/.test(board),
  'D1 快切 chip 是 steward-chips.js 的同一个工厂（紧凑模式：权限＋模型，引擎收进模型菜单）');
ok(count(boardCode, /method: 'PATCH'/g) === 0 && !/permissionMode/.test(boardCode),
  'D2 看板不自己 PATCH 线程权限（唯一写口仍是 steward-chips.js）');
ok(/if \(compact\) \{[\s\S]{0,240}buildEngineMenu\(menu\);/.test(chips)
  && /if \(!compact\) host\.appendChild\(buildChip\('engine'/.test(chips),
  'D3 紧凑模式把引擎收进模型菜单，而不是另写一份引擎菜单');
ok(/import \{ stewardThreadRunAction, stewardThreadStop \} from '\.\/steward-drawer\.js';/.test(board)
  && typeof drawerMod.stewardThreadRunAction === 'function' && typeof drawerMod.stewardThreadStop === 'function'
  && typeof drawerMod.pausableRunOf === 'function',
  'D4 暂停／继续／停止走 steward-drawer.js 导出的同一段原语（抽屉自己也调它们，不复制）');
ok(/const result = await stewardThreadRunAction\(\{ api, sessionId, runId: run\.id, action \}\);/.test(drawer)
  && /const stopped = await stewardThreadStop\(\{ api, sessionId \}\);/.test(drawer),
  'D5 抽屉自己也改调这段原语（「同一段」是真的同一段，不是抄一份给看板）');
// 116h 交付记录登记项①的落点：等锁时给「停掉占用者」。
ok(/String\(wait\.reason\) === 'lock' && wait\.blockedBy/.test(board)
  && /stewardShell\.board\.stopBlockerConfirm/.test(board)
  && /globalThis\.confirm/.test(board),
  'D6 等锁那一行给「停掉占用者」，且有一句二次确认（116h 登记项①）');
ok(/api\('\/api\/steward\/arbiter\/prioritize'/.test(board)
  && /result\.prioritized === true \? 'stewardShell\.board\.prioritized' : 'stewardShell\.board\.notQueued'/.test(board),
  'D7 「优先」走 116h 的插队路由，且如实区分「插了」与「它没在排队」');
ok(/saveConfigPartial\(\{ stewardMaxParallelThreads: value \}\)/.test(board)
  && /await loadArbiter\(\);\s*renderArbiterFacts\(\);/.test(board),
  'D8 并发上限经既有配置写口，存完回读仲裁面确认（界面只说后端真答应了的数）');

// ─── E 抽屉复用：不存在第二份抽屉区块渲染 ────────────────────────────────────────
for (const id of drawerMod.STEWARD_DRAWER_BLOCK_IDS) {
  ok(!boardCode.includes(id), `E1 看板模块不渲染抽屉区块 ${id}（一份实现，两种挂法）`);
}
ok(JSON.stringify(drawerMod.STEWARD_DRAWER_MOUNTS) === JSON.stringify(['overlay', 'docked'])
  && /drawer\.setMount\('docked'\);/.test(board) && /drawer\.setMount\('overlay'\);/.test(board),
  'E2 「现在这一件」= 同一个抽屉换 docked 挂法（挂法是抽屉导出的冻结枚举）');
ok(/const host = next === 'docked' \? byId\('stewardNowBody'\) : byId\('stewardShell'\);/.test(drawer)
  && /if \(host && drawer\.parentNode !== host\) host\.appendChild\(drawer\);/.test(drawer),
  'E3 换挂法就是把【同一个】 #stewardDrawer 节点搬到另一个父节点下');
ok(/if \(narrow && mountMode !== 'docked'\) drawer\.setAttribute\('aria-modal', 'true'\);/.test(drawer),
  'E4 docked 是常驻栏不是模态（不补 aria-modal）');
ok(/drawer\.setOnClosed\(mount => \{ if \(mount === 'docked' && !suppressCloseRecord\) closeNow\(\); \}\);/.test(board),
  'E5 关掉 docked 那一份＝关掉「现在这一件」；程序性收起（窄屏／切壳）不记本机偏好');

// ─── F 刷新纪律 + 零 innerHTML ──────────────────────────────────────────────────
ok(count(board, /setInterval\(/g) === 1 && count(board, /clearInterval\(/g) === 1,
  `F1 steward-board.js 恰好一处 setInterval 与一处 clearInterval（实测 ${count(board, /setInterval\(/g)}／${count(board, /clearInterval\(/g)}）`);
ok(count(board, /setTimeout\(/g) === 0, 'F2 看板零 setTimeout');
ok(/function syncPolling\(\) \{\s*if \(isBoardOpen\(\) && isStewardMode\(\) && !\(doc\(\) && doc\(\)\.hidden\)\) startPolling\(\);\s*else stopPolling\(\);/.test(board),
  'F3 唯一入口 syncPolling 的门控是「看板打开 && 管家模式 && 页面可见」，任一为否即停表');
ok(/function leaveSteward\(\) \{[\s\S]*?stopPolling\(\);/.test(board)
  && /new MutationObserver\(\(\) => \{ if \(isStewardMode\(\)\) void enterSteward\(\); else leaveSteward\(\); \}\)/.test(board),
  'F4 切离管家模式即收摊（谁改的 data-shell-mode 都算）');
ok(mod.STEWARD_BOARD_POLL_MS_MIN === 5000 && /Math\.max\(STEWARD_BOARD_POLL_MS_MIN, raw\)/.test(board),
  'F5 轮询周期取 config.stewardPollMs 并按 5000 下限 clamp（导出常量）');
ok(/if \(response\.status === 304\) return false;/.test(board)
  && /'if-none-match': missionsEtag/.test(board),
  'F6 行数据带 If-None-Match 走；没变（304）就不重画（也就不会打断正开着的 chip 菜单）');
for (const [name, source] of [['steward-board.js', boardCode], ['steward-classic-window.js', classicCode]]) {
  ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(source),
    `F7 ${name} 零 innerHTML/insertAdjacentHTML/document.write`);
  const imports = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map(match => match[1]);
  ok(imports.every(spec => spec.startsWith('./')), `F8 ${name} 的 import 全是本域内相对路径（零第三方库）`);
}
ok(/createElement\(/.test(board) && /textContent/.test(board), 'F9 DOM 一律 createElement + textContent');
// 后端零新增面：只调 116 之前就有的路由。
const routes = [...new Set([
  ...[...boardCode.matchAll(/'(\/api\/[a-z/-]+)[^']*'/g)].map(match => match[1]),
  ...[...boardCode.matchAll(/`(\/api\/[a-z/-]+)\$\{/g)].map(match => match[1]),
])].sort();
ok(JSON.stringify(routes) === JSON.stringify(
  ['/api/missions', '/api/sessions/', '/api/steward/arbiter', '/api/steward/arbiter/prioritize'].sort()),
  `F10 只调既有路由，零新增后端面（实测 ${JSON.stringify(routes)}）`);
ok(count(boardCode, /\bfetch\(/g) === 1 && /import \{ authHeaders \} from '\.\/net\.js';/.test(board),
  'F11 唯一的直调 fetch 是带 If-None-Match 的 /api/missions（api() 看不见 304），鉴权头复用 net.js');

// ─── 117g：2.0 视窗与返回带的组装（细契约在 pretender-shell.static） ─────────────
ok(/const classicWindow = createStewardClassicWindow\(\{/.test(stewardShell)
  && /const board = createStewardBoard\(\{/.test(stewardShell)
  && /classicWindow\.bindStewardClassicWindow\(\);/.test(stewardShell)
  && /board\.bindStewardBoard\(\);/.test(stewardShell),
  'G0a 两个子域都在 steward-shell.js 里组装并绑定（组合根 app.js 一行不加）');
ok(/drawer\.setClassicWindow\(sessionId => classicWindow\.openClassicWindow\(sessionId\)\);/.test(stewardShell)
  && /openClassicWindow: sessionId => classicWindow\.openClassicWindow\(sessionId\),/.test(stewardShell),
  'G0b 抽屉与看板的「2.0」是同一个 openClassicWindow（117d 的两步做法退役）');
ok(/switchWholeShell: \(\) => classicWindow\.switchWholeShell\(\),/.test(stewardShell)
  && /stewardShell\.classicWindow\.switchWhole/.test(conversation),
  'G0c 「整体切到 2.0」在看板顶部与头像菜单两处，都走同一个 switchWholeShell');
const appLines = read('app.js').split(/\r?\n/).length;
ok(appLines <= 1280, `G0d 组合根仍在 D45 护栏内（实测 ${appLines} 行）`);

// ─── G 新样式层三处登记 + token / 降级 / 断点 ────────────────────────────────────
ok(styles.includes('@import url("/css/views/steward-board.css");')
  && html.includes('<link rel="stylesheet" href="/css/views/steward-board.css" />'),
  'G1 styles.css @import 与 index.html 直链同步收录 steward-board.css');
ok(readFrontendCss.includes("'css/views/steward-board.css',"),
  'G2 read-frontend-css.js 的 CSS_PAYLOAD_GROUPS 收录 steward-board.css');
ok(overlay.includes("'app/public/css/views/steward-board.css'")
  && overlay.includes("'app/public/js/steward-board.js'")
  && overlay.includes("'app/public/js/steward-classic-window.js'"),
  'G3 离线包清单收录 117g/117h 的三个新文件');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(cssCode), 'G4 看板层 CSS 全部使用主题/语义 token，无硬编码色值');
ok(/@media \(prefers-reduced-motion: reduce\) \{/.test(cssCode) && /transition: none;/.test(cssCode),
  'G5 reduced-motion 下过渡全关（动效可以没有，信息不能少）');
ok(/@media \(min-width: 1000px\)/.test(cssCode) && /width: 390px;/.test(cssCode)
  && /\.steward-drawer\[data-mount="docked"\] \{/.test(cssCode),
  'G6 ≥1000px 才有 390px 常驻右栏，docked 那一份从 fixed 收回流内');
ok(/@media \(max-width: 390px\)/.test(cssCode), 'G7 390px 窄屏断点存在');
ok(/\.steward-board\[hidden\] \{ display: none; \}/.test(cssCode)
  && /\.steward-now\[hidden\] \{ display: none; \}/.test(cssCode),
  'G8 显隐由 [hidden] 驱动（JS 不写 display，壳模式属性也不归本层管）');
ok(/\.steward-board-dot\[data-tone="attention"\]/.test(cssCode)
  && /\.steward-board-dot\[data-tone="active"\]/.test(cssCode)
  && /\.steward-board-dot\[data-tone="quiet"\]/.test(cssCode),
  'G9 五态点的颜色只经 dockToneForMissionState 的三档 data-tone');

// ─── H i18n ──────────────────────────────────────────────────────────────────────
for (const prefix of ['stewardShell.board.', 'stewardShell.classicWindow.']) {
  const zhKeys = Object.keys(zh).filter(key => key.startsWith(prefix)).sort();
  const enKeys = Object.keys(en).filter(key => key.startsWith(prefix)).sort();
  ok(zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `H1 ${prefix}* 中英键对称（${zhKeys.length} 条）`);
}
const usedKeys = [...new Set([
  ...[...`${board}\n${classicWindow}`.matchAll(/'(stewardShell\.[a-zA-Z0-9_.]+)'/g)].map(match => match[1]),
])].filter(key => !key.endsWith('.'));
const missing = usedKeys.filter(key => typeof zh[key] !== 'string' || typeof en[key] !== 'string');
ok(missing.length === 0, `H2 两模块引用的 ${usedKeys.length} 个 i18n 键中英都齐备（缺: ${missing.join(',') || '无'}）`);
// 禁词：界面不出现系统标签，也不提前暴露内部代号。`2.0` 是产品里对经典壳的正式叫法，不在禁词内。
const FORBIDDEN = [/速问/, /不立单/, /已切到档位/, /Pretender/, /3\.0/];
const stewardKeys = Object.keys(zh).filter(key => key.startsWith('stewardShell.'));
for (const pattern of FORBIDDEN) {
  ok(!pattern.test(boardCode) && !pattern.test(classicCode) && !pattern.test(cssCode),
    `H3 两模块与样式层零出现 ${pattern.source}`);
  ok(stewardKeys.every(key => !pattern.test(String(zh[key])) && !pattern.test(String(en[key]))),
    `H4 stewardShell.* 文案零出现 ${pattern.source}`);
}
ok(/2\.0/.test(String(zh['stewardShell.classicWindow.switchWhole'])),
  'H5 「整体切到 2.0」照 §5 117g 行的原话说（2.0 不是禁词，3.0 才是）');

console.log(`\nSTEWARD BOARD STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
