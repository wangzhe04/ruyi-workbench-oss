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
const net = read('js/net.js');
// 121-K5（34 号文 §2.5／§3）：steward-classic-window.js 整文件退役，它的位置由工作台线程头
// （js/thread-head.js）接手。本件对它的五处钉一起翻面：G0a/G0b 的组装、G0c 的「整体切到 2.0」、
// G3 的离线包清单、H 组的 i18n 键面，读的都换成新那一片。
const classicWindow = read('js/thread-head.js');
const drawer = read('js/steward-drawer.js');
const chips = read('js/steward-chips.js');
// 33 号文 §4（M3-a）：危险操作确认的共用件（D6 要正面查它的登记表与导出面）。
const confirmPanel = read('js/confirm-panel.js');
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
// F3（M 组）：抽屉那一侧也要剥注释再比对 —— 「递话原语只有一个调用点」这种计数断言，
// 撞上注释里那几处 /api/steward/relay 的说明文字就会假红。
const drawerCode = stripComments(drawer);
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
const count = (source, pattern) => (source.match(pattern) || []).length;

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {

// steward-board.js 的传递依赖里有 state.js，那个文件在模块顶层写一次 `window.state` 的兼容层。
// 给它一个 window 别名即可 —— 不引入任何 DOM，导出的仍然是纯函数与工厂本身（unit 件用的是同一
// 个办法）。（121-K1 前这条链是经 preview-shell.js 拉进来的，那个文件已随交办台退役。）
if (!globalThis.window) globalThis.window = globalThis;
const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-board.js')).href);
const drawerMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-drawer.js')).href);
// 32 号文 §4（M2-b）：暂停／继续判据的共享件（I5 要正面查它真的导出那几个函数）。
const runStateMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'run-state.js')).href);
// 33 号文 §4（M3-a）：确认件与其文案键登记表（D6 要正面查，不只看文本）。
const confirmPanelMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'confirm-panel.js')).href);
// 121-K1（34 号文 §8.2）：dockToneForMissionState 与 elapsedLabel 搬进叶子 js/thread-facts.js
// （原住 preview-shell.js / preview-task-sheet.js，两者随交办台退役整文件删除）。
const threadFactsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'thread-facts.js')).href);
// 121-K2b（34 号文 §6.2）：轮询常量的唯一来源（F3b 要正面读 STEWARD_POLL_MS_CONNECTED 的【值】，
// 不只看源码里那个名字 —— 名字对了值被改成 5000 的话断言必须红）。
const chipsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-chips.js')).href);

// ─── A DOM 锚点 ─────────────────────────────────────────────────────────────────
const headerStart = html.indexOf('id="stewardHeader"');
const headerEnd = html.indexOf('</header>', headerStart);
const header = html.slice(headerStart, headerEnd);
// 121-K4-2（34 号文 §2.3 末段）：看板【浮层】退役 —— 行搬到左栏、两视角共用、常开。
// 一行状态因此不再是「点开即看板」的开关：没有 aria-expanded（它不开合任何东西了），
// aria-controls 指向它真正的去处 #railList（点一下＝把左栏滚到最需要你的那一组）。
const statusMarkup = header.slice(header.indexOf('id="stewardStatusLine"'), header.indexOf('id="stewardStatusNeedsYouBtn"'));
ok(/<button type="button" id="stewardStatusLine" class="steward-status-line"/.test(header)
  && !/aria-expanded/.test(statusMarkup)
  && /aria-controls="railList"/.test(statusMarkup),
  'A1 一行状态是 #stewardHeader 里的 button，指向左栏（看板浮层退役后它不再是开关）');
ok(!html.includes('id="stewardBoard"') && !html.includes('id="stewardBoardList"')
  && !/class="steward-board"/.test(html),
  'A2 看板浮层 #stewardBoard 与它的正文容器已从骨架里删除（左栏取代了它）');
// 浮层顶部那条 toolbar 的四件事（并发上限、在跑／排队计数、「全部暂停」、那行 note）搬到
// 左栏【看板密度】的栏头里，id 与接线一个字没动；正文容器换成 #railList。
const railStart = html.indexOf('id="sidebar"');
const railEnd = html.indexOf('</aside>', railStart);
const railMarkup = html.slice(railStart, railEnd);
for (const id of ['stewardBoardMax', 'stewardBoardRunning', 'stewardBoardQueued',
  'stewardBoardPauseAllBtn', 'stewardBoardNote', 'railList', 'railCount', 'railBoardBtn', 'railPocket']) {
  ok(new RegExp(`id="${id}"`).test(railMarkup), `A3 左栏骨架锚点 ${id} 静态写在 index.html 的左栏里`);
}
ok(/class="rail-board-head"/.test(railMarkup),
  'A3c 并发上限与「全部暂停」住在左栏看板密度的栏头（§2.3 末段：浮层顶部那条 toolbar 的去处）');
// 121-K4（34 号文 §2.2）：看板顶部那枚「整体切到 2.0」（#stewardBoardClassicBtn）退役 —— 视角切换
// 只在顶栏分段钮一处（§2.7）。翻面钉住它【不在】骨架里，免得哪天又长回来第二个切换入口。
ok(!html.includes('id="stewardBoardClassicBtn"') && !html.includes('id="stewardClassicBtn"'),
  'A3b 视角切换的第二／第三入口都不在骨架里（看板顶部与输入区旁的两枚「切到 2.0」随 K4 退役）');
ok(/<input type="number" id="stewardBoardMax"[^>]*min="1"[^>]*max="32"/.test(html)
  && mod.STEWARD_MAX_PARALLEL_MIN === 1 && mod.STEWARD_MAX_PARALLEL_MAX === 32,
  'A4 并发上限就地可改，区间 [1,32] 与 01-config 同口径（导出常量，不是散落字面量）');
// 121-K4（34 号文 §2.6／§7.1）：右栏从浮层「现在这几件」（#stewardNow ＋ 标题条 ＋「关掉」）改成
// 外框栅格里常驻的一列 #stewardSide。三件事跟着重钉：
//   ① 骨架里不再有 #stewardNow／#stewardNowCloseBtn（那枚「关掉」在常驻栏里没有语义）；
//   ② 挂点名：121-K6b 起是 #stewardFocus（原 #stewardNowBody）—— 它是 steward-drawer.js 自己认的
//      docked 挂点（setMount 那一行由 D 组钉着）。浮层时代的「现在这几件」两刀之前就退役了，
//      名字里再留着 Now 就是在指一块不存在的面（§13.7 登记 ③ 到此关闭）；
//   ③ 默认 hidden 仍在（syncNow 一处写它），且仍然零抽屉区块 id。
ok(/<aside id="stewardSide" class="steward-side"[\s\S]{0,240}?hidden>/.test(html)
  && html.includes('id="stewardFocus"')
  && !html.includes('id="stewardNowBody"')
  && !html.includes('id="stewardNow"')
  && !html.includes('id="stewardNowCloseBtn"'),
  'A5 #stewardSide 默认 hidden，带抽屉自己认的那一个挂点 #stewardFocus；浮层时代的 #stewardNow／#stewardNowBody 与「关掉」已退役');
const shellAt = html.indexOf('id="stewardShell"');
const nowAt = html.indexOf('id="stewardSide"');
const drawerAt = html.indexOf('id="stewardDrawer"');
ok(railStart > 0 && railStart < shellAt && nowAt > shellAt && drawerAt > nowAt,
  'A6 左栏在两个视角容器【之前】（它是外框的一栏，不属于任何一个视角），右栏排在抽屉骨架之前');
// 右栏只是挂点：它的静态骨架里不许出现任何抽屉区块 id（那一份只有 #stewardDrawer 有）。
const nowMarkup = html.slice(nowAt, html.indexOf('</aside>', nowAt));
ok(drawerMod.STEWARD_DRAWER_BLOCK_IDS.every(id => !nowMarkup.includes(id)),
  'A7 #stewardSide 的骨架零抽屉区块 id（内容是搬过去的同一个 #stewardDrawer 节点）');

// ─── B 不另起判据 ───────────────────────────────────────────────────────────────
// 33 号文 §4「costText／acceptanceText／threadStateOf 三对收进 drawer 导出」**重钉 B1**（反向验证过：
// 往看板里塞回一句 globalThis.MissionState 立刻真红）：五态判据的**实现体**（globalThis.MissionState
// ＋ missionState.fromCard(card)）已从本模块搬进 steward-drawer.js 的导出 stewardThreadStateOf，本模块
// 只剩一个短名。被钉的那件事一个字没变：五态仍然只由 mission-state.js 的 fromCard 判【一次】、看板与
// 抽屉同源；而且**本模块零直接 MissionState 引用** —— 判据搬走之后，谁也别想在这里再长一份（B2 同理）。
// 顺手把三处正则换成纯字符串判定：这条锁钉的是「哪件事成立」，不该被一次等价的写法微调撞红。
ok(board.includes("import './mission-state.js';")
  && boardCode.includes('const threadStateOf = stewardThreadStateOf;')
  && drawer.includes('export function stewardThreadStateOf(card)')
  && !boardCode.includes('globalThis.MissionState')
  && drawer.includes('globalThis.MissionState') && drawer.includes('missionState.fromCard(card)'),
  'B1 线程五态经 mission-state.js 的 fromCard（全仓唯一判据，与抽屉同源）');
for (const name of ['deriveMissionState', 'aggregateMissionState', 'dockToneForMissionState', 'elapsedLabel']) {
  ok(!new RegExp(`function ${name}\\s*\\(`).test(boardCode),
    `B2 看板不定义同名函数 ${name}（复制即失去「同一份判据」）`);
}
// 121-K1 重钉：判据不变（两样都必须 import 复用、不许复制），来源换成叶子 thread-facts.js。
// 不再钉 import 语句的逐字形状：只要它们是【从那个叶子来的】就成立 —— 两个名字合成一行 import
// 或分成两行都不该撞红。
ok(/from '\.\/thread-facts\.js'/.test(board)
  && new RegExp(`import \\{[^}]*\\bdockToneForMissionState\\b[^}]*\\} from '\\./thread-facts\\.js'`).test(board)
  && new RegExp(`import \\{[^}]*\\belapsedLabel\\b[^}]*\\} from '\\./thread-facts\\.js'`).test(board),
  'B3 五态点的档位表现与耗时文案都是 import 复用（来自叶子 thread-facts.js，不是复制）');
// 聚合态：只读行上的 aggregateState，绝不在这里长出第二套「任一 needs_you 则…」的判据。
const aggregateSites = [...boardCode.matchAll(/aggregateState/g)].length;
ok(aggregateSites > 0 && !/aggregateMissionState/.test(boardCode)
  && /row\.aggregateState/.test(boardCode) && /group\.aggregateState/.test(boardCode),
  `B4 事项聚合态只读行上的 aggregateState（${aggregateSites} 处引用，零 aggregateMissionState 实现）`);
// needs_you 在本模块只允许出现在两处，两处都【不是】聚合判据：
//   ① focusThreadFor 的焦点优先级（先看哪一条）；② 状态行里「B 条等你」的计数。
// 事项的聚合态永远只读行上的 aggregateState —— 多出第三处就说明有人在这里重写判据了。
// 124 还债④（40 号文 §8.5 ④）：**焦点优先级那一处【计算】现场搬去了叶子 thread-facts.js**，
// 不是消失了。服务端 13q 修前也自己挑一条「现在这一件」（与这一份的第三档不一样），收成一处的
// 办法是服务端只投影事实、挑哪一条由这一份纯函数判 —— 而管家对话（steward-conversation.js）与
// 看板都要读它，它就得住在两边都够得着的叶子里。于是本模块的两处计算变成【一处】（状态行计数），
// 总数 11 → 10；焦点那一处跟着钉在叶子上，**两个文件加起来仍然恰好两处计算现场**。
// 本模块对外仍按原名 re-export（C1/C3 与 focus-rail B1 一个字都没改）。
const needsYouSites = count(boardCode, /needs_you/g);
const factsCode = stripComments(read('js/thread-facts.js'));
const focusAt = factsCode.indexOf('export function focusThreadFor');
const focusBody = focusAt < 0 ? '' : factsCode.slice(focusAt, factsCode.indexOf('\n}', focusAt));
// 121-K4：切片的下界改成 goToNeedsYou（它就排在状态行后面）—— 原来切到 renderArbiterFacts，
// 中间夹着「N 条等你」的去处，那里有一处 jumpToGroup('needs_you')。要钉的是【状态行自己】
// 那一处计数，切片不该把邻居算进来。
const statusBody = boardCode.slice(boardCode.indexOf('function renderStatusLine'),
  boardCode.indexOf('function goToNeedsYou'));
// 121-K4：左栏把「这一件该落在哪一组」也做成了纯函数（railGroupFor），于是 needs_you 这个词
// 多出九处【映射】用法：五组登记表 1 ＋ railGroupFor 2 ＋ 组头上色 1 ＋ 默认展开 1 ＋ 第二行 1 ＋
// 「去处理」跳组 1 ＋ 胶囊跳组 1 ＋ 焦点优先级那一处（已计入两处计算之一）。它们都不是第二份
// 【派生】—— 入参永远是别处算好的那个字符串（aggregateState ／ threadStateOf 的返回值），本模块
// 仍然一次都没有写「任一 needs_you 则…」这类判定。钉法跟着事实走：两处【计算】现场逐字钉死
// （焦点优先级 1 ＋ 状态行计数 1），总数钉 11 —— 数字变了就必须重新解释一遍。
ok(needsYouSites === 10 && count(focusBody, /needs_you/g) === 1 && count(statusBody, /needs_you/g) === 1
  && !/export function focusThreadFor/.test(boardCode) && /export \{ focusThreadFor \};/.test(boardCode),
  `B5 'needs_you' 的两处【计算】现场一处不多一处不少（叶子 thread-facts.js 的焦点优先级 1 ＋ 本模块状态行计数 1），本模块其余都是分组映射；本模块总数 10（实测 ${needsYouSites}，焦点体 ${count(focusBody, /needs_you/g)}）`);
// 等待原因单一性（§8.10「排队可解释」）：wait.label 只渲染一处，没有第二套等待文案。
ok(count(boardCode, /wait\.label/g) === 1,
  `B6 每行只渲染 wait.label 一处（实测 ${count(boardCode, /wait\.label/g)}）`);
// 117q-B3b 重钉（理由：30 号文 §4.4 P0-4——五态人话原本抄了四份，其中 previewShell.state.* 与
// stewardShell.drawer.state.* 两套 locale key 已判出不同文案结果。本条原判据「看板复用抽屉那一组
// stewardShell.drawer.state.* 键」不再成立，不是因为键被删掉了，而是六个键搬到了中性的
// mission.state.*，三个壳（交办台／看板／抽屉）现在共用同一组键，不再有「谁的键」这个问题。
// 判据同步收紧：看板必须查 mission.state.，且旧的 stewardShell.drawer.state.* /
// stewardShell.board.state.* 两个前缀都不许再出现（用 boardCode 剥过注释的版本比对，不让注释里的
// 说明文字巧合撞出假绿）。
ok(/mission\.state\./.test(boardCode) && !/stewardShell\.drawer\.state\./.test(boardCode)
  && !/stewardShell\.board\.state\./.test(boardCode),
  'B7 五态人话复用中性的 mission.state.* 键（原抽屉专属命名已废弃），不另开第二套 stewardShell.board.state.*');

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
// 121-K4（34 号文 §2.6）：右栏改成常驻的一列之后，那枚「关掉」与它记的本机偏好
// （wcw.stewardNowClosed）一起退役 —— 常驻栏里没有那枚钮，再读那个偏好就会让存量用户的右栏
// 永远空着，而原来把它请回来的唯一路径（行上的「打开」→ setNowClosed(false)）也随浮层一起没了。
// 翻面钉住：模块里一个字节都不许再读写那个键（否则就是把一个不可恢复的死状态留在本机）。
ok(mod.STEWARD_NOW_CLOSED_KEY === undefined
  && !/stewardNowClosed/.test(boardCode)
  && !/STEWARD_NOW_CLOSED_KEY/.test(boardCode),
  'C5 「关掉」与它的本机偏好随浮层右栏退役：模块不再导出、不再读写 wcw.stewardNowClosed');
ok(mod.STEWARD_NOW_MIN_WIDTH === 1000 && /min-width: \$\{STEWARD_NOW_MIN_WIDTH\}px/.test(board),
  'C6 ≥1000px 才常驻，断点是导出常量（与 CSS 那一条同一个数）');

// ─── D chip 与线程动作原语都是复用 ──────────────────────────────────────────────
// 117n-M1 重钉：board.js 的 chips import 那一行加了 doc/byId/el/clear（DOM 基础件去重，见 F9
// companion）。原判据只钉 createQuickSwitchChips 这一个名字；新判据仍然要求它在场，且明确写出
// 完整的四个新增名字——比原来更精确，不是放宽。
// 117u-G2 **重钉 D1**（B3「事实降级」）：这条 import 又多了一个名字 resolveEngineRoute ——
// 看板要判「这条线程的模型跟全局一样吗」（一样就不印那两枚 chip），判据必须是 chips 自己算生效
// 模型用的那一份。新判据仍逐字要求原来的五个名字在场，且把新增那个也写死，比原来更精确不是放宽；
// 另加一条：本模块不许出现第二处「会话级 ＞ 全局」的回落实现（零 activeProvider／agentCliType）。
//
// 117u-G3 **再重钉 D1**（§11.15.7）：那条判据的正身搬去了 steward-chips.js（线程详情栏也要读同一份，
// 而抽屉不能反向 import 看板），所以看板接过来的名字从 resolveEngineRoute 换成了 chipsWorthPrinting。
// 判据没有放宽而是更紧了——除了照旧钉住 import 的六个名字与 compact，还多钉三件【搬家必须为真、
// 只要有人再抄一份就立刻红】的事实：看板剥了注释之后
//   ① 零 resolveEngineRoute( 调用（它自此连「会话级 ＞ 全局回落」都不认识）；
//   ② 零 function chipsWorthPrinting（判据全仓只许有一个定义，就在 chips.js 里）；
//   ③ 那唯一的调用点把三件东西【递】进去（会话、全局配置、chips 画完的宿主），而不是就地算。
// 三条都比对 boardCode（剥过注释的正文）——本文件 472 行那条纪律：源码扫描锁匹配到注释里的字就是假绿。
// 33 号文 §4 **再重钉（第三次）**：note()×5 收一那次让这条 import 又多了一个名字 writeNote，而这里
// 逐字钉的是「那一行长什么样」，当场假红（32 号文 §4 纪律 5：锁要钉「哪件事必须成立」）。与 A3c／E4
// 同款改成按名字集合判定：一条 import 行从哪个模块来、带没带必需的那六个名字，不关心顺序、不关心
// 后来还加了谁。纯字符串切分、不走正则（纪律 7：反斜杠在本仓是第三类静默损坏）。
// （反向验证过：把 chipsWorthPrinting 从看板的 import 里删掉立刻真红。）
const boardChipsNames = board.split(String.fromCharCode(10))
  .filter(line => line.startsWith('import {') && line.includes("from './steward-chips.js';"))
  .flatMap(line => line.slice(line.indexOf('{') + 1, line.indexOf('}')).split(','))
  .map(name => name.trim())
  .filter(Boolean);
ok(['createQuickSwitchChips', 'doc', 'byId', 'el', 'clear', 'chipsWorthPrinting'].every(name => boardChipsNames.includes(name))
  && /compact: true,/.test(board)
  && !/activeProvider/.test(boardCode) && !/agentCliType/.test(boardCode)
  && !/resolveEngineRoute\(/.test(boardCode)
  && !/function chipsWorthPrinting/.test(boardCode)
  && count(boardCode, /chipsWorthPrinting\(sessionForRow\(row\), \(state && state\.config\) \|\| \{\}, chipHost\)/g) === 1,
  'D1 快切 chip 与「跟全局一样吗」判据都是 steward-chips.js 的同一份（紧凑模式：权限＋模型，引擎收进模型菜单）；看板零第二套回落规则、零第二份判据定义');
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
// 33 号文 §4（M3-a）**重钉**：危险操作确认四套收一套后，看板不再自己拼文案键、也不再调原生
// globalThis.confirm —— 原判据钉的正是那两行长什么样，改完当场假红。新判据钉同一件事的**更强**版本：
//   ① 等锁那一行仍给「停掉占用者」；
//   ② 看板里【零原生 confirm】（globalThis./window./裸调用三种写法一起扫，注释先剥离）；
//   ③ 确认走共用件 confirmDanger，键从登记表取（看板里不再出现那个确认文案键的字面量）；
//   ④ 共用件真的导出 confirmDanger，且登记表那一格指的就是 stewardShell.board.stopBlocker*(标题复用按钮自己的说法)。
ok(/String\(wait\.reason\) === 'lock' && wait\.blockedBy/.test(boardCode)
  && !/globalThis\.confirm|window\.confirm|\bconfirm\(/.test(boardCode)
  && /if \(!await confirmDanger\(\{ name: 'stopBlocker', bodyParams: \{ title \} \}\)\) return false;/.test(boardCode)
  && !/stewardShell\.board\.stopBlockerConfirm/.test(boardCode)
  && typeof confirmPanelMod.confirmDanger === 'function'
  && confirmPanelMod.CONFIRM_TEXT.stopBlocker.bodyKey === 'stewardShell.board.stopBlockerConfirm'
  && confirmPanelMod.CONFIRM_TEXT.stopBlocker.titleKey === 'stewardShell.board.stopBlocker'
  && /stewardShell\.board\.stopBlockerConfirm/.test(confirmPanel),
  'D6 等锁那一行给「停掉占用者」，二次确认走共用确认件（看板已零原生 confirm；33 §4 M3-a）');
ok(/api\('\/api\/steward\/arbiter\/prioritize'/.test(board)
  && /result\.prioritized === true \? 'stewardShell\.board\.prioritized' : 'stewardShell\.board\.notQueued'/.test(board),
  'D7 「优先」走 116h 的插队路由，且如实区分「插了」与「它没在排队」');
ok(/saveConfigPartial\(\{ stewardMaxParallelThreads: value \}\)/.test(board)
  && /await loadArbiter\(\);\s*renderArbiterFacts\(\);/.test(board),
  'D8 并发上限经既有配置写口，存完回读仲裁面确认（界面只说后端真答应了的数）');

// ─── D9 117n-M1②：failNote 不再是第二份弱化的错误解包 ──────────────────────────
// 修前 failNote 只是 `String(error.message || error)`——既不解结构化信封（对象会拍扁成
// "[object Object]"）也不特判 steward.queued 的 wait.label。同一种排队失败，看板上的提示比
// 抽屉里（steward-drawer.js:287 的 failNote）差。现在直接 import steward-conversation.js 的权威
// 实现，不再自己写一份。
// 117u-G2 **重钉 D9a**：这条 import 多了 stewardThreadHueFor（B2 色条上板要的号）。原判据只钉
// 三个错误名，新判据逐字要求四个都在场 —— 更精确，不是放宽。
// 121-K6b **再重钉 D9a**（34 号文 §5「色号按任务」）：多第五个名字 stewardRegisterThreadMission ——
// 色号的键换成 missionId 之后，「这条线程属于哪个任务」必须有人登记，而登记者只能是本模块
// （全仓唯一那个 /api/missions 取数者）。仍然是「不自己再写一份」：号还是那张表发的。
ok(/import \{ stewardErrorCode, stewardErrorText, stewardQueuedWaitLabel, stewardThreadHueFor,\s*\n\s*stewardRegisterThreadMission \} from '\.\/steward-conversation\.js';/.test(board),
  'D9a board.js 的错误信封解包、线程色号与任务归属登记都从 steward-conversation.js import，不是自己再写一份');
ok(!/String\(\(error && error\.message\) \|\| error \|\| 'failed'\)/.test(boardCode),
  'D9b 旧的弱化版 failNote（裸 String(error) 拍扁结构化信封）已经不在了');
const failNoteBody = boardCode.slice(boardCode.indexOf('function failNote'), boardCode.indexOf('function failNote') + 600);
ok(/const code = stewardErrorCode\(error\);/.test(failNoteBody)
  && /if \(code === 'steward\.queued'\) \{/.test(failNoteBody)
  && /stewardQueuedWaitLabel\(error\)/.test(failNoteBody)
  && /stewardErrorText\(error\)/.test(failNoteBody),
  'D9c failNote 先查 steward.queued 并取 wait.label（照 steward-drawer.js:287 的形状），其余情形一律经 stewardErrorText，不直落 String(error)');
for (const key of ['stewardShell.chat.errQueued', 'stewardShell.chat.errQueuedPlain']) {
  ok(typeof zh[key] === 'string' && typeof en[key] === 'string',
    `D9d 复用的 i18n 键 ${key} 中英本来就齐备（看板不需要新开一套）`);
}

// ─── E 抽屉复用：不存在第二份抽屉区块渲染 ────────────────────────────────────────
for (const id of drawerMod.STEWARD_DRAWER_BLOCK_IDS) {
  ok(!boardCode.includes(id), `E1 看板模块不渲染抽屉区块 ${id}（一份实现，两种挂法）`);
}
ok(JSON.stringify(drawerMod.STEWARD_DRAWER_MOUNTS) === JSON.stringify(['overlay', 'docked'])
  && /drawer\.setMount\('docked'\);/.test(board) && /drawer\.setMount\('overlay'\);/.test(board),
  'E2 「现在这一件」= 同一个抽屉换 docked 挂法（挂法是抽屉导出的冻结枚举）');
ok(/const host = next === 'docked' \? byId\('stewardFocus'\) : byId\('stewardShell'\);/.test(drawer)
  && /if \(host && drawer\.parentNode !== host\) host\.appendChild\(drawer\);/.test(drawer),
  'E3 换挂法就是把【同一个】 #stewardDrawer 节点搬到另一个父节点下');
// 121-K6b **重钉 E4**（§2.6／§13.7 ③「抽屉内部『关掉』语义」）：两态收成一态 —— docked 是常驻
// 焦点栏，不存在「关」也就不存在模态；overlay 只剩一种可达情形（窄到右栏摆不下，syncNow 的
// wideEnough 是唯一那道宽度门），那一态恒是模态。原来 applyModal 里还自己判一次宽度，那是浮层
// 时代留下的第二处判据。companion：docked 下那枚「关掉」由样式层收掉。
ok(/if \(mountMode === 'docked'\) drawer\.removeAttribute\('aria-modal'\);\s*\n\s*else drawer\.setAttribute\('aria-modal', 'true'\);/.test(drawer)
  && !/min-width: 1000px/.test(drawer.slice(drawer.indexOf('function applyModal'), drawer.indexOf('function applyModal') + 600))
  && /\.steward-drawer\[data-mount="docked"\] > \.steward-drawer-bar \{ display: none; \}/.test(read('css/views/steward-board.css')),
  'E4 docked 是常驻栏不是模态（不补 aria-modal、也没有「关掉」那枚钮）；overlay 恒是模态');
ok(/drawer\.setOnClosed\(mount => \{ if \(mount === 'docked' && !suppressCloseRecord\) closeNow\(\); \}\);/.test(board),
  'E5 关掉 docked 那一份＝关掉「现在这一件」；程序性收起（窄屏／切壳）不记本机偏好');

// ─── F 刷新纪律 + 零 innerHTML ──────────────────────────────────────────────────
ok(count(board, /setInterval\(/g) === 1 && count(board, /clearInterval\(/g) === 1,
  `F1 steward-board.js 恰好一处 setInterval 与一处 clearInterval（实测 ${count(board, /setInterval\(/g)}／${count(board, /clearInterval\(/g)}）`);
ok(count(board, /setTimeout\(/g) === 0, 'F2 看板零 setTimeout');
// 121-K2b（34 号文 §6.2／§6.4）**重钉 F3**：门控从三条收成两条 —— 「看板打开」这一条【删了】。
// 理由不是放宽而是它的前提没了：状态行那句「N 个事项 · A 条在跑，B 条等你」与右栏「现在这一件」
// 都【一直可见】，看板收起来它们照样在屏幕上，于是那道门换来的正是 32 号文 §5 记的两笔债
// （看板一关，状态行与紧凑行就停在关上的那一帧）。K4 之后左栏永远开着，「看不见」更不成立。
// 省下来的请求由新的一档节拍还回去：连接正常时这一拍 30 s 才拉一次（见下面 F3b）。
// 反向验证：把 isBoardOpen() && 加回去 → 本条与 event-stream-client.browser 的「看板收起后左栏仍
// 在 ≤1 s 内跟上」双红。
ok(/function syncPolling\(\) \{\s*if \(isStewardMode\(\) && !\(doc\(\) && doc\(\)\.hidden\)\) startPolling\(\);\s*else stopPolling\(\);/.test(board)
  && !/isBoardOpen\(\) && isStewardMode\(\)/.test(boardCode),
  'F3 唯一入口 syncPolling 的门控是「管家模式 && 页面可见」，任一为否即停表（121-K2b：「看板关着不刷」那道门已删）');
// 121-K2b 新钉（§6.4 的三条语义之二）：兜底轮询【存在】，且事件流连着时节拍 ≥30 s。
// 「存在」这一半与「≥30 s」这一半必须同时钉：只钉前者，改回 5 s 不会红；只钉后者，把兜底整个
// 拿掉也不会红 —— 而推送漏一帧时兜底是唯一的自愈路（13r 的环只有 200 条，断太久就补不上）。
ok(/const due = streamConnected \? STEWARD_POLL_MS_CONNECTED : \(anyThreadRunning\(\) \? STEWARD_BOARD_POLL_MS_MIN : pollIntervalMs\(\)\);/.test(board)
  && chipsMod.STEWARD_POLL_MS_CONNECTED >= 30000
  && /await refreshBoard\(\);/.test(boardCode),
  `F3b 兜底轮询存在且连接时节拍 ≥30 s（实测 ${chipsMod.STEWARD_POLL_MS_CONNECTED} ms；断开时回到「有线程在跑 5 s／空闲 config.stewardPollMs」两档）`);
// 121-K2b 新钉（§6.4 的三条语义之三）：连接时那 30 s 一拍之外，行的变化靠推送落地，而推送落地
// 【不许】变成每帧一发请求 —— thread.live 就地改（零请求），其余五类走串行合并的那一条路。
ok(/stream\.on\(EVENT_STREAM_LIVE_EVENT, data => \{ applyLivePush\(data\); \}\);/.test(board)
  && /for \(const name of EVENT_STREAM_ROW_EVENTS\) \{/.test(board)
  && /if \(pushBusy\) \{ pushAgain = true; return false; \}/.test(board)
  && count(boardCode, /pushRefreshRows\(\)/g) === 5,
  'F3c thread.live 就地改行（零请求）；其余五类经 pushRefreshRows 串行合并（在飞时只记一个「还要再来一趟」的位，不加第二个计时器）。121-K4 多出的第四处是 syncRail：工作台视角没有兜底计时器，用户动作（开／建／改名／删）就是行最该被复核的时刻 —— 它走的是同一条串行合并的路，不是第二条。128f 的第五处是 presence.ack（见 F3d）');
// 128f（thread-switch-race.browser 的 S1；c3a3585 全量 workbench-thread-head E3 的偶发）：行上的 seatedBy 是服务端按在场现算的，
// 在场只在事件流连上那一刻登记；工作台视角没有兜底节拍、在场变了服务端也不推 —— 收到「我已经记下你坐在哪」的回执就补一发行，
// 且推送那一路行变了要告诉宿主（线程头读的也是这批行）。两处任一拿掉，S1 就红（反向验证实测）。
ok(/stream\.on\('presence\.ack', \(\) => \{ void pushRefreshRows\(\); \}\);/.test(boardCode)
  && /async function refreshRows\(\) \{[\s\S]{0,700}?if \(changed\) renderRail\(\);[\s\S]{0,500}?if \(changed\) \{ try \{ onRowsChanged\(rows\.length\); \}/.test(boardCode),
  'F3d 在场回执（presence.ack）补一发行；refreshRows 行变了照样告诉宿主（onRowsChanged）—— 工作台线程头的管家条跟得上在场');
// 128f（thread-switch-race W1e／W2）：取行只认最后发出的那一发；被取代的那一发【等它落地再回】（立刻回 false 的话，
// 调用方紧接着的 render 画的是旧行 —— W2 构造出来过：开关刚点成「别盯了」，下一帧又被勾回去）。
ok(count(boardCode, /if \(seq !== missionsLoadSeq\) return missionsLoadLatest;/g) === 2
  && /function loadMissions\(\) \{\s*const seq = \+\+missionsLoadSeq;\s*const run = loadMissionsOnce\(seq\);\s*missionsLoadLatest = run;\s*return run;\s*\}/.test(boardCode),
  'F3e 取行只认最后发出的那一发（回包与解析之后各判一次），被取代的那一发等最后那一发落地再回');
// 121-K4-3 重钉（前值钉的是那句一行写完的观察者回调）。改动有二，各自都是事实：
//   ① 回调里先【同步】renderRail() 再走各视角自己那套异步 —— 左栏有三样东西是按视角变的
//      （「＋」的两义、选中态、点击语义），而切到管家那一路第一件事是 await refreshBoard()，
//      于是修前切过去的第一帧左栏还写着「新线程」（one-workbench-frame.browser 的 H0 实测到）；
//   ② leaveSteward 不再清 pinnedId（§2.7「管家视角记住自己的焦点线程」）。
// 「收摊」这件事本身一个字没松：stopPolling() 仍在 leaveSteward 里，门控仍是 F3 那一条。
// 反向验证：把 renderRail() 从回调里去掉 → H0 红；把 pinnedId = '' 加回 leaveSteward → K6 红。
ok(/function leaveSteward\(\) \{[\s\S]*?stopPolling\(\);/.test(board)
  && !/function leaveSteward\(\) \{[\s\S]*?pinnedId = '';[\s\S]*?stopPolling\(\);/.test(board)
  && /new MutationObserver\(\(\) => \{\s*renderRail\(\);\s*if \(isStewardMode\(\)\) void enterSteward\(\); else leaveSteward\(\);\s*\}\)/.test(board),
  'F4 切离管家模式即收摊（谁改的 data-shell-mode 都算），且切换的第一帧左栏就已经按新视角画过一遍；出视角不动用户钉的焦点');
ok(mod.STEWARD_BOARD_POLL_MS_MIN === 5000 && /Math\.max\(STEWARD_BOARD_POLL_MS_MIN, raw\)/.test(board),
  'F5 轮询周期取 config.stewardPollMs 并按 5000 下限 clamp（导出常量）');
ok(/if \(response\.status === 304\) return false;/.test(board)
  && /'if-none-match': missionsEtag/.test(board),
  'F6 行数据带 If-None-Match 走；没变（304）就不重画（也就不会打断正开着的 chip 菜单）');
for (const [name, source] of [['steward-board.js', boardCode], ['thread-head.js', classicCode]]) {
  ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(source),
    `F7 ${name} 零 innerHTML/insertAdjacentHTML/document.write`);
  const imports = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map(match => match[1]);
  ok(imports.every(spec => spec.startsWith('./')), `F8 ${name} 的 import 全是本域内相对路径（零第三方库）`);
}
// 117n-M1 重钉：el()/clear() 搬进 steward-chips.js 集中定义（composer/drawer/conversation/board/
// classic-window/settings 六个消费方零本地重复）之后，board.js 自己不再直接调 .createElement——
// 但它仍然只经从 chips.js import 的共享 el()/clear() 生成节点，createElement 本体仍可在 chips.js
// 里查证。原判据只证明「某处调过 createElement」；新判据在此之上再加一条正面证据（零本地重复
// 定义），是更强而不是更弱的版本。
ok(/textContent/.test(board)
  && /createElement\(/.test(chips)
  && !/function el\(tag, className, text\) \{/.test(boardCode)
  && !/function clear\(node\) \{/.test(boardCode)
  && !/const doc = \(\) => globalThis\.document \|\| null;/.test(boardCode)
  && !/const byId = id => \(doc\(\) \? doc\(\)\.getElementById\(id\) : null\);/.test(boardCode),
  'F9 看板的节点创建委托给 steward-chips.js 共享的 el()/clear()（117n-M1 去重）：零本地重复定义，createElement 仍可在 chips.js 里查证（零 innerHTML 的证据没消失，只是搬了家）');
// 后端零新增面：只调 116 之前就有的路由。
const routes = [...new Set([
  ...[...boardCode.matchAll(/'(\/api\/[a-z/-]+)[^']*'/g)].map(match => match[1]),
  ...[...boardCode.matchAll(/`(\/api\/[a-z/-]+)\$\{/g)].map(match => match[1]),
])].sort();
ok(JSON.stringify(routes) === JSON.stringify(
  ['/api/missions', '/api/sessions/', '/api/steward/arbiter', '/api/steward/arbiter/prioritize'].sort()),
  `F10 只调既有路由，零新增后端面（实测 ${JSON.stringify(routes)}）`);
// F11 重钉（117q-B3a，见 30 号文 §4.6 P1-6）：裸 fetch 缺 403 换 token 重放是真 bug——后端进程
// 重启导致旧 token 失效后，看板会一直空转到用户手动刷新页面，而其余 45+ 处 api() 调用点都能自愈。
// net.js 抽出 apiRaw(path, options)（拼 authHeaders + 403 判定 + initToken(true) + 重放一次，返回
// 原始 Response 不做 res.json()），api() 自己也改成 apiRaw(...).then(json)，消灭 net.js 内部的
// 自我重复；看板换成 apiRaw 之后，字面意义上的裸 fetch(就不会再出现在这个文件里，旧判据「唯一
// 一处 fetch(」也就必然不成立——这是①那条修复本身的直接后果，不是顺手改动。原判据的证据价值
// （只有一条直调、鉴权头不野生拼装）由新判据整体保留，只是换成了 apiRaw 语义。
ok(count(boardCode, /\bfetch\(/g) === 0 && count(boardCode, /\bapiRaw\(/g) === 1 && /import \{ apiRaw \} from '\.\/net\.js';/.test(board),
  'F11 零裸 fetch，唯一取数走 apiRaw（带 If-None-Match 的 /api/missions；304/etag 判断逻辑不动，鉴权头由 apiRaw 内部拼）');
// 更强伴随断言：apiRaw 是 net.js 里【唯一】一处 403 判定 + initToken(true) + 重放逻辑，api() 复用
// 它而不是自己再拼一份——防止「看板改对了，但 net.js 内部又长出第二份重复实现」这种回潮。
ok(net.includes('export async function apiRaw(path, options = {})')
  && count(net, /invalidTokenResponse\(res\.status, body\)/g) === 1
  && count(net, /await initToken\(true\)/g) === 1
  && /export async function api\(path, options = \{\}\) \{\s*const res = await apiRaw\(path, options\);/.test(net),
  'F11b net.js 的 403 换 token 重放只有 apiRaw 一份实现，api() 复用它（零自我重复）');

// ─── 117g→121-K5：工作台线程头与左栏的组装 ──────────────────────────────────────
ok(/const threadHead = createThreadHead\(\{/.test(stewardShell)
  && /const board = createStewardBoard\(\{/.test(stewardShell)
  && /threadHead\.bindThreadHead\(\);/.test(stewardShell)
  && /board\.bindStewardBoard\(\);/.test(stewardShell),
  'G0a 两个子域都在 steward-shell.js 里组装并绑定（组合根 app.js 一行不加）');
// 121-K5（§2.7／§3.2）：「在工作台打开」的实现从 steward-classic-window.js 的 openClassicWindow
// （它还要写一个 sessionStorage 返回标记、画一条返回带）收成 js/shell-mode.js 的 openInWorkbench
// （切视角 ＋ openSession 两步）。钉的事实一个字没变：抽屉与左栏用的是【同一个】入口，
// 而且壳层自己不再实现第二份。反向验证：把 drawer.setClassicWindow 那一行改回自己切壳 → 当场红。
ok(/drawer\.setClassicWindow\(sessionId => openInWorkbench\(sessionId\)\);/.test(stewardShell)
  && /openClassicWindow: sessionId => openInWorkbench\(sessionId\),/.test(stewardShell)
  && /^\s*openInWorkbench,/m.test(read('app.js')),
  'G0b 抽屉与左栏的「在工作台打开」是同一个 openInWorkbench（shell-mode.js 一处实现）');
// 121-K4（§2.2／§2.4）：「整体切到 2.0」那两个入口（看板浮层顶部、头像菜单末项）都退役 ——
// 视角切换只在外框顶栏的分段钮一处。121-K5 再进一步：连那个能力本身（switchWholeShell）也
// 随 steward-classic-window.js 整文件删除 —— 它是「第二条切壳通道」的最后一块残料。
// 翻面钉住它真的不在了：壳层不注入、对话流不引用那个文案键、四份 locale 里也没有它。
ok(!/switchWholeShell/.test(stewardShell)
  && !/stewardShell\.classicWindow\./.test(conversation)
  && !/switchWholeShell/.test(classicWindow)
  && zh['stewardShell.classicWindow.switchWhole'] === undefined,
  'G0c 「整体切到 2.0」连同它的能力与文案键整段退役（视角切换只在顶栏分段钮一处）');
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
  && overlay.includes("'app/public/js/thread-head.js'")
  && !overlay.includes("'app/public/js/steward-classic-window.js'"),
  'G3 离线包清单跟着换人：线程头进、退役的 2.0 视窗出（121-K5）');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(cssCode), 'G4 看板层 CSS 全部使用主题/语义 token，无硬编码色值');
ok(/@media \(prefers-reduced-motion: reduce\) \{/.test(cssCode) && /transition: none;/.test(cssCode),
  'G5 reduced-motion 下过渡全关（动效可以没有，信息不能少）');
// 121-K4（§2.6／§7.1）：右栏不再是 ≥1000px 才出现的 390px fixed 浮层，而是外框栅格里的一列
// （宽度由 layout.css 的 --right-w 一处给，本层不写第二个数）。docked ↔ overlay 的判定仍然只有
// steward-board.js 的 wideEnough()（≥1000px）一处，所以那条「从 fixed 收回流内」的规则不再需要
// 第二个宽度门 —— 属性选择器本身就是那个门。
ok(/\.steward-side \{/.test(cssCode) && /grid-column: 2;/.test(cssCode)
  && /\.steward-drawer\[data-mount="docked"\] \{/.test(cssCode)
  && !/width: 390px;/.test(cssCode)
  && !/@media \(min-width: 1000px\)/.test(cssCode),
  'G6 右栏是栅格里的一列（不写第二个宽度、不再有 ≥1000px 那道媒体门），docked 那一份仍从 fixed 收回流内');
ok(/@media \(max-width: 390px\)/.test(cssCode), 'G7 390px 窄屏断点存在');
ok(/\.steward-side\[hidden\] \{ display: none; \}/.test(cssCode)
  && !/\.steward-board\[hidden\]/.test(cssCode)
  && !/\.steward-board \{/.test(cssCode),
  'G8 显隐由 [hidden] 驱动（JS 不写 display）；看板浮层那一族规则随它退役');
ok(/\.steward-board-dot\[data-tone="attention"\]/.test(cssCode)
  && /\.steward-board-dot\[data-tone="active"\]/.test(cssCode)
  && /\.steward-board-dot\[data-tone="quiet"\]/.test(cssCode),
  'G9 五态点的颜色只经 dockToneForMissionState 的三档 data-tone');
// 117n-M1③（用户「看板圆点看不出已完成」走查）：新增，不改 G9——加一档 settled，只在 done 且
// 调用方主动传 settleDone:true 时才出现（默认返回值一个字不变）。
// 121-K1 搬家复核：真值表逐条一个字没变，只是从 preview-shell.js 换成了 thread-facts.js。
ok(threadFactsMod.dockToneForMissionState('done') === 'quiet'
  && threadFactsMod.dockToneForMissionState('done', { settleDone: true }) === 'settled'
  && threadFactsMod.dockToneForMissionState('running', { settleDone: true }) === 'active'
  && threadFactsMod.dockToneForMissionState('dispatching', { settleDone: true }) === 'active'
  && threadFactsMod.dockToneForMissionState('needs_you', { settleDone: true }) === 'attention'
  && threadFactsMod.dockToneForMissionState('stopped', { settleDone: true }) === 'quiet'
  && threadFactsMod.dockToneForMissionState('quick_ask', { settleDone: true }) === 'quiet',
  'G9b dockToneForMissionState 加了可选参数 settleDone：不传时 done 仍是 quiet（默认返回值零漂移），看板传 true 时 done 单独出第四档 settled，其余状态不受影响');
ok(/dockToneForMissionState\(value, \{ settleDone: true \}\)/.test(board),
  'G9c 看板 paintDot 显式传 settleDone:true 才选出第四档（不是改了默认返回值）');
// 121-K1：原 G9d 钉的是交办台 renderDock 那处「不传 settleDone」的伴随调用点。交办台整层退役后
// 全仓只剩看板一个调用点，「默认返回值零漂移」这件事改由上面 G9b 的真值表首行（done → quiet）
// 直接钉住 —— 判据没放松，只是它的见证者从「另一个调用点」换成了「函数本身的默认返回值」。
ok(threadFactsMod.dockToneForMissionState('done') === 'quiet'
  && !/dockToneForMissionState/.test(read('js/steward-drawer.js')),
  'G9d 默认返回值（不传 settleDone 时 done 仍是 quiet）零漂移；抽屉那一面仍然不碰这个函数（它走原始 state）');
ok(/\.steward-board-dot\[data-tone="settled"\] \{ background: var\(--ok\); \}/.test(cssCode),
  'G9e 看板 CSS 补上 settled 档，复用抽屉 done 那一档同一个语义 token（--ok），不新造颜色');

// ─── H i18n ──────────────────────────────────────────────────────────────────────
// 121-K5：stewardShell.classicWindow.* 两键随返回带退役，这里只剩看板那一族。
for (const prefix of ['stewardShell.board.']) {
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
// 121-K5：H5 翻面 —— 「整体切到 2.0」那两条文案键随 steward-classic-window.js 一起退役，
// 四份目录里一条都不许留（界面上已经没有任何地方说这句话了）。
ok(zh['stewardShell.classicWindow.switchWhole'] === undefined
  && zh['stewardShell.classicWindow.back'] === undefined
  && en['stewardShell.classicWindow.switchWhole'] === undefined
  && en['stewardShell.classicWindow.back'] === undefined,
  'H5 stewardShell.classicWindow.* 两键已从四份目录里删净（121-K5：返回带整段退役）');

// ─── I 117l-B2 ②：看板视觉（用户第五轮走查 2「这个限制界面（看板）优化美观一下」）──────────
// 修前顶部是一排裸文字、事项与线程行糊在一起。本组只钉【结构性的那几件】：
// 玻璃 toolbar／状态 pill／事项卡／线程行缩进与分隔／空态有出口／不许偷偷加模糊预算。
// 121-K4-2：117l-B2 ② 那条「玻璃底 toolbar」（.steward-board-top）随浮层退役，它的四件事搬到
// 左栏【看板密度】的栏头 .rail-board-head：仍然是一条带边框圆角的条，只是底色从玻璃改成实面
// （§7.1：玻璃只留浮层与安静卡），并且只在看板密度出现 —— 紧凑密度下左栏只留一行主信息。
ok(/\.rail-board-head \{[\s\S]{0,400}background: var\(--panel-2\);[\s\S]{0,200}border-radius: var\(--r-md\);/.test(cssCode)
  && /\.rail-board-head \{[\s\S]{0,200}display: none;/.test(cssCode)
  && /\.app-frame\.rail-board \.rail-board-head \{ display: flex; \}/.test(cssCode),
  'I1 并发上限那一条住在左栏看板密度的栏头（实面、带边框圆角，紧凑密度下收起）');
ok(!/\.rail-board-head \{[^}]*backdrop-filter/.test(cssCode)
  && !/backdrop-filter:\s*var\(--glass-blur/.test(cssCode),
  'I1b **模糊预算**：本层一处模糊都没有（唯一出现的 backdrop-filter 是把 docked 抽屉那一份【关掉】的 none；ui-v4-glass G2 的白名单一个字没加）');
ok(/<span class="steward-board-maxwrap">/.test(railMarkup)
  && /\.steward-board-maxwrap:focus-within \{ border-color: var\(--accent\); \}/.test(cssCode)
  && /\.steward-board-max-input \{[\s\S]{0,200}width: 48px;/.test(cssCode),
  'I2 「同时最多 ⟨n⟩」仍是一枚带标签的胶囊（48px 输入框，聚焦时整枚亮起来），住在左栏的看板栏头里');
ok(/id="stewardBoardRunning" class="steward-board-pill is-live"/.test(railMarkup)
  && /id="stewardBoardQueued" class="steward-board-pill is-quiet"/.test(railMarkup)
  && /\.steward-board-pill\.is-live::before \{ background: var\(--accent\); \}/.test(cssCode),
  'I3 在跑／排队是两枚状态 pill（在跑带 running 色点，排队保持安静），住在左栏的看板栏头里');
// 121-K4：那一排右侧动作键只剩「全部暂停」一枚（「整体切到 2.0」随视角切换收归顶栏而退役），
// 一枚按钮不需要一个把它推到右边的容器 —— .steward-board-tools 整个删掉。翻面钉住它不在了。
ok(!/steward-board-tools/.test(html) && !/steward-board-tools/.test(cssCode)
  && /id="stewardBoardPauseAllBtn"/.test(railMarkup),
  'I4 「全部暂停」直接排在栏头里（.steward-board-tools 随「整体切到 2.0」一起退役）');
// 「全部暂停」的可点态：判据必须与 pauseAll 自己那一行 filter 逐字同源，不许借 arbiter.running
// （仲裁面数的是占着并发位的线程，能被暂停的是有活 run 的线程，两者在「只跑对话回合」那类线程上不一样）。
// 32 号文 §4（M2-b）**重钉**：判据本体搬进叶子 js/run-state.js（2.0 的 run 卡同一份），两处就地写的
// `rows.some(...)` / `rows.filter(...)` 字面量随之消失 —— 原判据「钉那一行长什么样」当场假红。新判据
// 钉的是同一件事的**更强**版本：① 两处都从共享件取名单（hasPausableRun / pausableRunsOf）；
// ② 本模块里再没有就地写第二遍的 `lastRun.live === true` 判据；③ 共享件真的导出那三个函数；
// ④ 「可点态」的样式守卫仍在。（反向验证过：把 syncPauseAll 换回就地 some(...)，本行立刻真红。）
ok(/function syncPauseAll\(\) \{/.test(boardCode)
  && /const pausable = hasPausableRun\(rows\);/.test(boardCode)
  && /const pausable = pausableRunsOf\(rows\);/.test(boardCode)
  && !/lastRun\.live === true/.test(boardCode)
  && typeof runStateMod.hasPausableRun === 'function'
  && typeof runStateMod.pausableRunsOf === 'function'
  && typeof runStateMod.runControlAction === 'function'
  && /\.steward-board-btn:disabled \{/.test(cssCode),
  'I5 「全部暂停」只在真有可暂停的 run 时可点，判据与 pauseAll 自己那一行 filter 同源（32 号文 §4 起是 js/run-state.js 那一份共享件）');
// 121-K4（§2.3）：B1 的口径在左栏反过来 —— **任务是主、线程是展开项**。所以「每个事项一张卡」
// 这件事不再成立：多线程任务画的是一行【任务行】（.rail-task，与线程行同一枚卡基元 ＋ 小计数 ＋
// 折角），点开才是缩进的线程行。那张玻璃事项卡（.steward-board-mission）整族删除。
ok(!/steward-board-mission/.test(cssCode) && !/steward-board-mission/.test(boardCode)
  && /\.rail-task\.is-open \.rail-chev \{ transform: rotate\(180deg\); \}/.test(cssCode)
  && /\.rail-threads\.is-open \{ grid-template-rows: 1fr; \}/.test(cssCode),
  'I6 多线程任务是一行任务行（折角＋展开），不再是一张把线程行裹起来的事项卡');
// 117u-G2 **重钉 I6b**（B1／B4 把那一串三枚拆成了两处）：事项头只剩「事项名 · N 条」一枚药丸，
// 钱与验收搬去了卡尾那一行。被钉的事实一个字没变 —— 「·」仍然是【生成内容】，DOM 一个节点没加，
// 而且仍然只有【一条】声明在生产它（两个落点写在同一条规则里）。判据跟着两个落点走，并额外
// 钉住「只有一处 content: "·"」——比原来只钉一个选择器更强。
// 「只有一条规则在生产它」要按【规则块】数，不能按整层数 content:"·" —— 一行状态那枚
// .steward-status-line::before 从 117h 起就有一个，与药丸串这件事无关（数整层会把它算进来）。
const pillDotRules = [...cssCode.matchAll(/([^{}]*steward-board-pill[^{}]*)\{([^}]*)\}/g)]
  .filter(match => /content: "·"/.test(match[2]));
ok(/\.steward-board-facts \.steward-board-pill \+ \.steward-board-pill::before \{/.test(cssCode)
  && pillDotRules.length === 1,
  `I6b 「·」仍是生成内容、仍只有一条规则在生产它（事项头那个落点随事项卡退役，只剩卡尾事实行相邻药丸之间这一处），DOM 一个节点没加（实测涉及药丸的规则块 ${pillDotRules.length} 条）`);
// 117u-G2 **重钉 I7**（B1）：缩进的意思是「这几条挂在上面那个事项名下面」，所以它只属于【真分了
// 组】的卡 —— 单线程事项已经不画事项层，那张卡没有可挂的名字，缩进只会让它无故凹进去。原判据
// 钉的是「.steward-board-thread 自己带 --sp-4」，B1 之后这句话不再成立；新判据把两件事都钉死：
// 分组时缩进 --sp-4（两个断点各一条，都带 .is-grouped 限定），且【裸】的 .steward-board-thread
// 规则块里一处 margin-inline-start 都没有（否则单线程那张卡又会凹回去）。
const bareThreadRule = cssCode.slice(cssCode.indexOf('.steward-board-thread {'),
  cssCode.indexOf('}', cssCode.indexOf('.steward-board-thread {')));
// 121-K4：缩进的意思没变（「这几条挂在上面那个名字下面」），换的是它挂在谁身上 —— 现在是
// 展开容器里的线程行（.rail-threads .steward-board-thread），用 padding 而不是 margin：那一层
// 是 grid 0fr→1fr 的动画容器，外边距会在收起的那一帧被算进去、露出一条缝。
// 裸规则块里仍然一处 margin-inline-start 都没有（否则单线程任务那张卡又会无故凹进去）。
ok(/\.rail-threads \.steward-board-thread \{ padding-inline-start: var\(--sp-5\); \}/.test(cssCode)
  && !/margin-inline-start/.test(bareThreadRule)
  && /\.steward-board-thread \+ \.steward-board-thread \{ border-top: 1px solid var\(--line\); \}/.test(cssCode)
  && /\.steward-board-thread:hover \{ background: var\(--panel-2\); \}/.test(cssCode),
  'I7 缩进只属于【展开出来的】线程行；行间 1px 分隔线、hover 底色微亮照旧（分隔线随 §7.1 从玻璃色换成实色 --line）');
ok(/\.steward-board-thread-head \{[\s\S]{0,300}flex-wrap: wrap;/.test(cssCode)
  && /\.steward-board-thread-title \{[\s\S]{0,200}min-width: 5em;/.test(cssCode),
  'I7b 390px 下线程名不许被 pill 与时间挤成 0 宽（改前实测：整个线程名从屏幕上消失）');
const asksYouRule = cssCode.slice(cssCode.indexOf('.steward-board-pill.is-asks-you {'),
  cssCode.indexOf('}', cssCode.indexOf('.steward-board-pill.is-asks-you {')));
ok(/background: var\(--gold-soft\);/.test(asksYouRule) && /color: var\(--gold\);/.test(asksYouRule),
  'I8 「它在问你」是金色描边 + 极淡金底（仍是全行唯一带颜色的东西，只是不再喊）');
ok(/const empty = el\('div', 'steward-board-empty'\);/.test(boardCode)
  && /empty\.appendChild\(boardButton\('stewardShell\.board\.newThread', \(\) => newThread\(''\)/.test(boardCode),
  'I9 空态是「一句话 ＋ 一个出口」（＋ 线程），不是一行孤零零的灰字');
ok(/routeKind = missionId \? 'missionNew' : 'new';/.test(read('js/steward-composer.js')),
  'I9b companion：空态那枚「＋ 线程」没有事项可挂，chip 落到「另起一件」而不是撒谎说「在事项下新开」');
for (const selector of ['\\.steward-board-maxwrap', '\\.steward-board-thread', '\\.steward-board-pill\\.is-asks-you']) {
  ok(new RegExp(`@media \\(prefers-reduced-motion: reduce\\)[\\s\\S]*${selector},`).test(cssCode),
    `I10 本波新增的过渡 ${selector.replace(/\\/g, '')} 也进了 reduced-motion 的关闭清单`);
}

// ─── J 117m-A2：「等你」要点得开（用户第六轮走查⑤⑥）─────────────────────────────
// ⑤「系统提示的需要我通知，在管家界面也点不开」／⑥「需要我允许的也没在线程中」。
// 根因在服务端（06i 的 asksYou 只认 question），界面这一侧要跟上两件事：
//   pill 按【哪一类待决】说话；「N 条等你」那个数字要有【去处】。
ok(JSON.stringify(Object.keys(mod.STEWARD_BOARD_ASKS_YOU_KEYS)) === JSON.stringify(['question', 'permission', 'plan', 'pool', 'soft'])
  && Object.isFrozen(mod.STEWARD_BOARD_ASKS_YOU_KEYS)
  && Object.values(mod.STEWARD_BOARD_ASKS_YOU_KEYS).every(key => typeof zh[key] === 'string' && typeof en[key] === 'string'),
  'J1 pill 文案表覆盖四类待决 ＋ 软问句，五个键中英都齐备（导出常量，不是散落字面量）');
ok(/t\(STEWARD_BOARD_ASKS_YOU_KEYS\[kind\] \|\| STEWARD_BOARD_ASKS_YOU_KEYS\.soft\)/.test(boardCode)
  && !/t\('stewardShell\.board\.asksYou'\)/.test(boardCode),
  'J1b pill 文案【由 kind 决定】，看板里没有第二处写死的「它在问你」');
ok(/<button type="button" id="stewardStatusNeedsYouBtn" class="steward-status-needsyou" hidden><\/button>/.test(header),
  'J2 「N 条等你」的去处是 #stewardStatusLine 的【兄弟】button（那一行自己就是 button，套不了第二个），默认 hidden');
ok(/const waiting = views\.filter\(view => view\.state === 'needs_you'\);/.test(boardCode)
  && /needsYouIds = waiting\.map\(view => String\(view\.sessionId\)\);/.test(boardCode)
  && /needsYou: waiting\.length/.test(boardCode),
  'J2b 名单与计数是【同一次】filter 的产物：不新开第二个计数源，也不把 needs_you 数第二遍（B5 仍然只准两处）');
ok(/if \(ids\.length === 1\) \{[\s\S]{0,400}drawer\.focusAsk\(\)/.test(boardCode)
  && /const id = openThread\(ids\[0\]\);/.test(boardCode)
  && /focusAsk,/.test(drawer),
  'J3 恰好 1 条 → 直接打开那条线程的抽屉，并把焦点送进问答卡（抽屉导出 focusAsk 供「已经开着同一条」时补一次）');
// 121-K4：修前这一支是「拉开看板浮层 ＋ 把等你的行临时排到最前」。左栏常开、组头本来就把
// 等你的那几件收在一起之后，两步都不需要了 —— 滚过去就是全部。那个只活一程的临时排序
// （needsYouFirst）随之删掉：**后端行序自此是屏幕上唯一的行序**（翻面钉住它不再出现）。
ok(/return jumpToGroup\('needs_you'\);/.test(boardCode)
  && !/needsYouFirst/.test(boardCode)
  && !/group\.rows = group\.rows\.slice\(\)\.sort/.test(boardCode),
  'J3b 多于 1 条 → 把左栏滚到「等你」那一组；行序永远是后端那一份（临时重排已随看板浮层退役）');
ok(/\.steward-status-needsyou\[hidden\] \{ display: none; \}/.test(cssCode)
  && !/\.steward-status-needsyou \{[^}]*transition/.test(cssCode),
  'J4 新控件的显隐由 [hidden] 驱动（配 display 守卫），且没有偷偷加过渡（reduced-motion 清单一个字没动）');

// ─── K 117r-D2：管家新开线程之后，右栏／抽屉真的把它打开（用户第八轮走查①）─────────────
// 现象：「管家新开线程之后不会自动打开线程详情页了」。回合收尾派 steward:focus-thread
// （steward-conversation.js:704），抽屉那一侧 openThread 真的打开了，看板这一侧却把它顶掉：
//   ① focusFrom 是本模块 focusThread() 的一份弱化抄写（丢了「宽屏没接住就退回覆盖式打开」那条回退）；
//   ② currentFocusId 用「rows 里有没有它」这道门否掉刚钉上的线程 —— 而 rows 是上一趟
//      GET /api/missions 的快照，刚建出来的线程当然不在里面；否掉之后回落自动挑选，挑不出来就把
//      #stewardNow 整块收起并 closeDrawer()，恰好关掉抽屉刚打开的那一份。
// 本组一律比对【剥过注释】的 boardCode（117q-B3b 踩过：源码扫描锁匹配到注释里的字，假绿）。
const focusFromBody = boardCode.slice(boardCode.indexOf('const focusFrom = event =>'),
  boardCode.indexOf('document_.addEventListener(STEWARD_FOCUS_THREAD_EVENT'));
ok(focusFromBody.includes('focusThread(id);')
  && !/pinnedId = String\(id\)/.test(focusFromBody)
  && count(boardCode, /pinnedId = String\(/g) === 1,
  'K1 焦点／打开事件走本模块唯一的那一份 focusThread（弱化抄写已删；pinnedId 的非空赋值口只剩 focusThread 一处）');
ok(/void verifyPinnedRow\(\);/.test(focusFromBody),
  'K2 「焦点事件」这一刷真的存在（文件头刷新纪律里的第三个确定性时刻，此前只写在注释里、代码没照做）');
ok(/if \(pinnedId && \(pinnedUnverified \|\| rows\.some\(row => String\(row\.sessionId\) === pinnedId\)\)\) return pinnedId;/.test(boardCode),
  'K3 未核实期间 currentFocusId 无条件返回 pinnedId（不走 rows.some 那道门），核实之后原判据一个字不动');
const verifyBody = boardCode.slice(boardCode.indexOf('async function verifyPinnedRow'),
  boardCode.indexOf('function pollIntervalMs'));
ok(/try \{ await refreshBoard\(\); \}/.test(verifyBody)
  && /finally \{ pinnedUnverified = false; syncNow\(\); \}/.test(verifyBody)
  && count(boardCode, /pinnedUnverified = true/g) === 1,
  'K4 「未核实」是【有界的】：refreshBoard 跑完（无论成败）就在 finally 里清位并再 syncNow 一次，全模块只有焦点事件那一处置位 —— 不存在「一钉就永久信任」（那样一条不存在的线程会把右栏永远占着）');

// ─── L 117s-B：焦点落在【已经开着的同一条线程】上时，右栏要重新读一次（用户第九轮走查①④）─────
// 现象：管家递话给一条抽屉正开着的线程，steward:focus-thread 带的是同一个 id —— 修前 syncNow()
// 的最后一行相等即跳过、什么都不做，屏幕上留着「已收工」与上一回合的「它刚说」，要等抽屉自己的
// 空闲节拍（config.stewardPollMs，用户真机 15 s）才发现线程又活了。117r-D2（K 组）修的是另一半
// 「行里还没有它」的新线程；这一半一直没人管。
// 本组钉的是【哪件事必须成立】而不是那一行长什么样（30 号文 §8.13 ①）：
//   ① 相等分支上真有一次强刷，且走抽屉【既有】的 refreshOnce（不另起第二条取数路径）；
//   ② syncNow 仍然【同步返回布尔】—— focusThread 的 `if (!syncNow())` 回退靠它，改 async 会让那条
//      回退恒真（Promise 是真值），宽屏没接住时就再也退不回覆盖式打开；
//   ③ 这一刷是【焦点请求】专属的：refreshBoard 的每一拍也调 syncNow，无条件强刷等于把抽屉的取数
//      频率绑到看板节拍上（还会连同 refreshOnce 的节拍闸归零一起，把空闲线程永久按在 5 s 一拍）。
const syncNowBody = boardCode.slice(boardCode.indexOf('function syncNow('), boardCode.indexOf('function closeNow('));
ok(/if \(drawer\.currentSessionId\(\) !== focusId\) drawer\.openThread\(focusId\);/.test(syncNowBody)
  && /drawer\.refreshOnce\(\)/.test(syncNowBody)
  && /refreshOnce,/.test(drawer),
  'L1 syncNow 的相等分支上有一次强刷，且用的是抽屉导出的既有 refreshOnce（不同 id 那一支照旧开线程，一个字没动）');
ok(!/async function syncNow/.test(boardCode)
  && !/await drawer\.refreshOnce\(\)/.test(syncNowBody)
  && /drawer\.refreshOnce\(\)\.catch\(\(\) => \{\}\)/.test(syncNowBody),
  'L2 强刷是发射后不管（不 await、失败自吞）：syncNow 仍然同步返回布尔，focusThread 的回退判据与 closeNow／leaveSteward／断点回调拿到的还是真布尔');
// 121-K4 重钉：多出【第二个】强刷点，理由与 L1 是同一条（「抽屉手里那份切片一定是旧的」），
// 只是时刻不同 —— applyLivePush 里「这一回合的第一个字」那一刻：抽屉是在 thread.state 那一帧
// 读的切片，那时回合刚起跑、一个字都没有，所以它画的还是上一回合的「它刚说」。
// 门开得很窄，三条【同时】成立才补：① 从无到有那一次（!row.liveTail）；② 这条线程正是焦点；
// ③ 抽屉真导出 refreshOnce。所以仍然不是「每条 live 跟一发请求」（那正是 K2b 拒绝的形状）：
// 一个回合最多补一发。反向验证：把 firstTick 去掉（每条 live 都补）→ 本条立刻真红。
// 128f-⑫ 重钉（2 → 3 处 drawer.refreshOnce()）：第三条路是 refreshDrawerIfFocused —— 左栏行上的动作（暂停／继续／停止／
// 优先／停掉占用者／全部暂停）动的【正是焦点那一条】时补一发（审计 B：修前焦点栏还拿着动作之前的切片）。门同样窄：
// 只在用户按下这几枚按钮之后、且焦点就是被动的那一条时；refreshBoard 的每一拍、closeNow、leaveSteward 仍然不强刷。
ok(count(boardCode, /syncNow\(\{ focusRequest: true \}\)/g) === 1
  && /if \(!syncNow\(\{ focusRequest: true \}\) &&/.test(boardCode)
  && count(boardCode, /drawer\.refreshOnce\(\)/g) === 3
  && /function refreshDrawerIfFocused\(\.\.\.sessionIds\)/.test(boardCode)
  && /const firstTick = !row\.liveTail;/.test(boardCode)
  && /if \(firstTick && drawer && typeof drawer\.refreshOnce === 'function' && currentFocusId\(\) === sid\)/.test(boardCode),
  'L3 强刷只有两条路：【焦点请求】（focusThread 那一处 focusRequest:true）与【这一回合的第一个字】（applyLivePush 里 firstTick ＋ 焦点相符那一次）—— refreshBoard 的每一拍、closeNow、leaveSteward、断点变化那几处 syncNow() 不强刷，thread.live 也不是每条都补');

// ─── M F3（32 号文 §2.2「线程即频道」）：右栏从「现在这一件」变成「现在这几件」──────────
// 焦点那一条【仍然是那一份 docked 抽屉】（E 组一个字没动），其余线程按服务端行序在它上下叠成
// 小行。本组钉的是这一刀最容易被后人悄悄破坏的五件事，全都可证伪：
//   ① 两条 stack 的 id 是导出的冻结常量，且【不在】 index.html 的静态骨架里（右栏仍然只是挂点）；
//   ② 右栏不排第二次序（117s-A 已经在 13d 一处排好，客户端再排一次就会与看板／抽屉页签打架）；
//   ③ 「就地回答」不长第二条发送路径（看板零发送端点，抽屉里递话原语恰好一个调用点）；
//   ④ 看板不认识任何输入框 id —— 落点是抽屉导出的两个句柄（focusAsk → focusComposer）；
//   ⑤ 小行不为自己另造一套颜色与五态判据（点与药丸复用看板既有类，展开与否只读 data-tone）。
ok(JSON.stringify(mod.STEWARD_NOW_STACK_IDS) === JSON.stringify({ before: 'stewardNowStackBefore', after: 'stewardNowStackAfter' })
  && Object.isFrozen(mod.STEWARD_NOW_STACK_IDS)
  && !html.includes('stewardNowStackBefore') && !html.includes('stewardNowStackAfter'),
  'M1 两条小行叠的容器 id 是导出的冻结常量（不是散落字面量），且骨架里没有它们 —— #stewardNow 仍然只是一个挂点（A5/A7 未被本刀稀释）');
const renderNowBody = boardCode.slice(boardCode.indexOf('function renderNow(focusId)'), boardCode.indexOf('function clearNow()'));
ok(renderNowBody.length > 0 && count(renderNowBody, /\bsort\(/g) === 0
  && /rows\.forEach\(\(row, at\) =>/.test(renderNowBody)
  && count(renderNowBody, /appendChild\(renderNowThread\(row\)\)/g) === 1,
  `M2 右栏的行序【原样取 GET /api/missions】：renderNow 里零 sort（实测 ${count(renderNowBody, /\bsort\(/g)} 处），一次遍历一处出行 —— 117s-A 的状态优先序只在 13d 排一次，看板／抽屉页签／右栏消费同一份`);
ok(count(boardCode, /steward\/relay/g) === 0 && count(boardCode, /chat\/answer/g) === 0
  && count(drawerCode, /api\('\/api\/steward\/relay'/g) === 1,
  `M3 「就地回答」零第二条发送路径：看板里零递话／答复端点，递话原语在抽屉里恰好一个调用点（实测 ${count(drawerCode, /api\('\/api\/steward\/relay'/g)} 处）`);
ok(!/stewardDrawerInput/.test(boardCode) && !/stewardDrawerAskInput/.test(boardCode)
  && /drawer\.focusAsk === 'function' && drawer\.focusAsk\(\)/.test(boardCode)
  && /drawer\.focusComposer/.test(boardCode) && /focusComposer,/.test(drawer),
  'M4 看板不认识任何输入框 id：就地回答的落点是抽屉导出的两个句柄（有问答卡走 focusAsk，没有才落到底部 focusComposer），输入框与发送逻辑都只在抽屉里有一份');
const nowThreadBody = boardCode.slice(boardCode.indexOf('function renderNowThread(row)'), boardCode.indexOf('function renderNowCount('));
// F5a 重钉：状态药丸从 `el('span', 'steward-board-pill', …)` 就地一行改成走 statePill()
// （多一枚由五态值派生的字形）。契约一个字没变 —— 药丸【仍然】是看板既有那个类、颜色【仍然】
// 只经 data-tone、样式层【仍然】零 .steward-now-*；变的只是那一行写在哪儿，所以判据跟去 statePill 的定义。
// 117u-G2 **重钉 M5**（D4：小行＝同一枚线程卡的最紧密度）：那颗点从「按状态上色的
// .steward-board-dot」换成「按线程上色的 .steward-tcard-dot」——**色 ≠ 态**（§11.15.3 B2，F1 立的
// 纪律），态由那枚药丸独家承担。原判据钉的是「复用看板既有的两个类」，换点之后那句话的前半不再
// 成立；新判据钉的是同一件事的更强版本：小行仍然【一份骨架都不新造】——
//   ① 色条与色点走三面共用的 .steward-tcard-*（本文件另有一条钉它们全仓只有一份声明）；
//   ② 色号问同一张登记表要（threadDot 与 paintThreadCard 是本模块唯一的两个生产点）；
//   ③ 药丸仍是看板既有那个类、同一个 statePill；
//   ④ 样式层仍然零 .steward-now-dot ／ .steward-now-pill —— 右栏没有第二套颜色。
ok(/paintThreadCard\(el\('li', 'steward-now-thread'\), sessionId\)/.test(nowThreadBody)
  && /head\.appendChild\(threadDot\(\)\);/.test(nowThreadBody)
  && /statePill\(threadState\)/.test(nowThreadBody)
  && /const pill = el\('span', 'steward-board-pill', stateLabel\(value\)\);/.test(boardCode)
  && count(boardCode, /'steward-tcard-dot'/g) === 1 && count(boardCode, /'steward-tcard-bar'/g) === 1
  && count(boardCode, /stewardThreadHueFor\(/g) === 1
  && !/steward-now-dot/.test(cssCode) && !/steward-now-pill/.test(cssCode),
  'M5 小行＝同一枚线程卡的最紧密度：色条／色点各只有一个生产点、色号只问那一张登记表要一次、药丸仍是看板既有那个类，样式层零 .steward-now-dot/.steward-now-pill —— 右栏没有第二套颜色，也没有第二份骨架');
// 117u-G2 M5b（§11.15.3 B2「色 ≠ 态」）：看板与右栏两处线程卡上，色条与色点都【不许】读状态。
// 可证伪的形式：paintDot（唯一那处把 data-state / data-tone 写上节点的函数）只被事项头那颗聚合点
// 用一次 —— 线程卡这两面一次都不调它。
// 121-K4：那颗「按聚合态上色的事项点」随事项卡一起退役 —— 左栏的任务行用的是与线程行【同一枚】
// 卡基元（色条＋色点按任务色，态由药丸说）。于是 paintDot 一个调用点都不剩：定义 1 ＋ 调用 0。
// 被钉的事更强了：**整个模块没有一处把状态画成颜色**。
ok(count(boardCode, /paintDot\(/g) === 1
  && !/paintDot\(el\(/.test(boardCode)
  && !/paintDot\(/.test(nowThreadBody),
  `M5b 色 ≠ 态：paintDot（写 data-state/data-tone 的那一处）自此零调用点（定义 1 ＋ 调用 0 = ${count(boardCode, /paintDot\(/g)} 处），左栏与右栏的卡一次都不把状态画成颜色`);
ok(/tone === 'attention' \|\| tone === 'active'/.test(nowThreadBody)
  && count(boardCode, /needs_you/g) === 10 && count(boardCode, /'stopped'/g) === 0 && count(boardCode, /'done'/g) === 0,
  `M6 「展开还是折成一行」只读 toneOf 出的 data-tone（四档里的前两档）；五态字面量与 B5 同账：needs_you 10（一处计算＋九处分组映射；焦点那一处已随判据搬去叶子 thread-facts.js，见 B5）、'stopped' 零处（124 走查后本模块零五态字面量）、'done' 零处（实测 ${count(boardCode, /needs_you/g)}／${count(boardCode, /'stopped'/g)}／${count(boardCode, /'done'/g)}）`);
ok(/\.steward-now-stack \{/.test(cssCode) && /max-height: 33%;/.test(cssCode) && /overflow-y: auto;/.test(cssCode)
  && /\.steward-now-stack:empty \{ display: none; \}/.test(cssCode)
  && !/\.steward-now-(stack|thread)[^{]*\{[^}]*transition/.test(cssCode),
  'M7 两条 stack 各自最多吃三分之一高度并自己滚（线程再多也挤不掉正在看的那一件），空叠不占位；本组零过渡，reduced-motion 清单一个字不用动');

// ─── N F5a（27 号文 §11.13.1「F 追加」）：五态图标与动作图标，都不许长出第二份判据 ──────
// 这一组要证的三件事：
//   ① 五态字形是【从五态值派生】出来的，不是第二张五态表 —— icons.js 里一个五态字面量都没有，
//      而 mission-state.js 的 STATES 每一态都派生得出一枚字形，六枚两两不同；
//   ② paintDot 的 tone 契约一个字没变（紧凑行的展开／折叠仍然只读它，M6 是它的另一半）；
//   ③ 看板取用的每一个字形名都真的在 ICONS 表里（拼错的名字只会 console.warn，界面上静静地少一枚）。
const iconsSrc = read('js/icons.js');
const iconsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'icons.js')).href);
const missionStateMod = require(path.join(PUBLIC, 'js', 'mission-state.js'));
const iconNameSet = new Set(iconsMod.iconNames());
const stateGlyphs = missionStateMod.STATES.map(state => iconsMod.missionStateIconName(state));
ok(missionStateMod.STATES.length >= 5
  && stateGlyphs.every(name => name && iconNameSet.has(name))
  && new Set(stateGlyphs).size === missionStateMod.STATES.length,
  `N1 mission-state.js 的每一态都派生得出一枚【自己的】字形（都在 ICONS 表里、两两不同；实测 ${JSON.stringify(stateGlyphs)}）`);
const iconsCode = stripComments(iconsSrc);
ok(missionStateMod.STATES.every(state => !new RegExp("'" + state + "'").test(iconsCode))
  && !/STATES/.test(iconsCode) && /function missionStateIconName\(state\)/.test(iconsCode)
  && /replace\(\/_\(\[a-z0-9\]\)\/g/.test(iconsCode),
  'N2 那一枚字形是【派生】不是【查表】：icons.js 里零五态字面量、零 STATES 清单 —— 谁处在哪一态永远只由 mission-state.js 判，图标层长不出第二份枚举');
ok(count(boardCode, /missionStateIcon\(/g) === 1
  && /import \{ icon, missionStateIcon \} from '\.\/icons\.js';/.test(board)
  && count(boardCode, /needs_you/g) === 10 && count(boardCode, /'stopped'/g) === 0 && count(boardCode, /'done'/g) === 0,
  `N3 左栏只把 threadStateOf() 的返回值【原样】递给 missionStateIcon（恰好一处调用），五态字面量计数与 B5／M6 同账（${count(boardCode, /needs_you/g)}／${count(boardCode, /'stopped'/g)}／${count(boardCode, /'done'/g)}）`);
// 117u-G2 **重钉 N4**：tone 从 paintDot 里提成了纯函数 toneOf —— B2 之后小行那颗点归线程色，
// 但「展开还是折成一行」仍然只认这四档 tone，提出来之前要拿 tone 必须先造一颗点再读回来再扔掉。
// 被钉的契约一个字没变：settleDone 那一档没动，dockToneForMissionState 在全模块【仍然只被调用
// 一次】（现在这一次住在 toneOf 里），paintDot 仍然把 state 与 tone 一起写在节点上。
const paintDotBody = boardCode.slice(boardCode.indexOf('function paintDot(node, value)'), boardCode.indexOf('function paintThreadCard('));
ok(/function toneOf\(value\) \{ return dockToneForMissionState\(value, \{ settleDone: true \}\); \}/.test(boardCode)
  && /node\.dataset\.state = value;/.test(paintDotBody)
  && /node\.dataset\.tone = toneOf\(value\);/.test(paintDotBody)
  && count(boardCode, /dockToneForMissionState\(/g) === 1
  && new RegExp(`import \\{[^}]*\\bdockToneForMissionState\\b[^}]*\\} from '\\./thread-facts\\.js'`).test(board),
  'N4 tone 契约一个字没变：dockToneForMissionState 全模块仍然只调一次（住在纯函数 toneOf 里，settleDone 那一档没动），四档 tone 仍是紧凑行展开／折叠的唯一判据');
const boardGlyphNames = [
  ...[...boardCode.matchAll(/icon\('([A-Za-z]+)'/g)].map(match => match[1]),
  ...[...boardCode.matchAll(/\}, '([a-zA-Z]+)'\)\);/g)].map(match => match[1]),
];
ok(boardGlyphNames.length >= 6 && boardGlyphNames.every(name => iconNameSet.has(name)),
  `N5 看板取用的每一个字形名都在 ICONS 表里（拼错只会 console.warn，界面上静静地少一枚；实测 ${JSON.stringify([...new Set(boardGlyphNames)].sort())}）`);
// 文案里已经画过的符号不再画第二遍：「＋ 线程」那句本身以「＋」开头，配上 plus 会渲染成
// 「＋ ＋ 线程」（第一版就是这样，看板截图当场看出来的）。所以这两处刻意【不给】字形。
ok(count(boardCode, /boardButton\('stewardShell\.board\.newThread'[^\n]*\)\);/g) === 3
  && !/boardButton\('stewardShell\.board\.newThread'[^\n]*, '[a-z]+'\)\)/.test(boardCode)
  && /^＋/.test(String(zh['stewardShell.board.newThread'])),
  'N5b 「＋ 线程」刻意不配字形（三处：线程行卡尾、任务行卡尾、空态）：那句文案自己就带着一个「＋」，再画一枚 plus 会变成「＋ ＋ 线程」');
ok(/function boardButton\(labelKey, handler, dataset, iconName\)/.test(boardCode)
  && /const button = el\('button', 'steward-board-btn', t\(labelKey\)\);/.test(boardCode)
  && count(boardCode, /'steward-board-btn'/g) === 1,
  'N6 动作是【图标＋人话】不是纯图标：文案仍然从同一个 t(labelKey) 出，按钮仍然只有这一处生产点');
ok(/\.steward-board-pill\.has-icon \{ display: inline-flex;/.test(cssCode)
  && /\.steward-board-pill:empty \{ display: none; \}/.test(cssCode)
  && /\.steward-board-btn\[hidden\] \{ display: none; \}/.test(cssCode),
  'N7 只有【真取到字形】的药丸才换成 inline-flex（事项头那串纯文字药丸的「·」分隔规则不受影响），:empty 隐藏规则仍在；动作键给了 display 就补上 [hidden] 守卫');

// ─── P 124 还债①（40 号文 §8.5 ①）：看板也说得出「未记录验收」───────────────────────────
// 用户 2026-09-15 拍板：**只在收工了却没人记过时印**。两道门缺一不可，本组把它们钉成机器判据 ——
// 少任何一道，左栏就会变成满栏等重灰字（§2.3「只在有话可说时出现」，正是 P1 当初刻意不碰看板的
// 那条理由），而那正是这一刀最容易走偏的地方。
{
  const facts = boardCode.slice(boardCode.indexOf('function missionFacts('),
    boardCode.indexOf('function renderThreadRow('));
  ok(facts.length > 200, `P0 missionFacts 切得到（切不到 = 本组静默失效；实得 ${facts.length}）`);
  // **切出那条门表达式本身来钉**，不是只看「这几个字在文件里出现过」——
  // 第一版就是后者：反向把 `settled` 从门里拿掉、只留下那行没人用的 `const settled = …`，
  // P2 照绿。锁写松了当场收紧，这一条记在号文里。
  const gateAt = facts.indexOf('const unrecordedWorthSaying =');
  const gate = gateAt < 0 ? '' : facts.slice(gateAt, facts.indexOf(';', gateAt));
  ok(gate.length > 40, `P0b 那条门切得到（实得 ${gate.length}）`);
  ok(/acceptance\.tracked === true/.test(gate),
    'P1 第一道门在【门里】：这一组得是【一件活】（tracked）—— 普通聊天会话没有验收这回事，对它说「未记录验收」是噪声');
  ok(/\bsettled\b/.test(gate) && /const settled = missionStateSettled\(group\.aggregateState\);/.test(facts),
    'P2 第二道门在【门里】：收工了才说（还在跑／等你时说「未记录验收」没有意义）');
  ok(/!acceptanceRecorded\(group\)/.test(gate),
    'P3 判据走共享的 acceptanceRecorded（与抽屉同一个函数），不在看板里另推一份');
  ok(/if \(Number\(acceptance\.total\) > 0 \|\| unrecordedWorthSaying\) \{/.test(facts),
    'P3b 这条门真的挂在画药丸那一处（不是算完就扔）');
  ok(count(boardCode, /acceptanceRecorded\(/g) === 1,
    `P4 全模块只有一处调用它（没有第二条路；实得 ${count(boardCode, /acceptanceRecorded\(/g)}）`);
  ok(/unrecorded: 'stewardShell\.board\.acceptanceUnrecorded'/.test(boardCode)
    && typeof zh['stewardShell.board.acceptanceUnrecorded'] === 'string'
    && typeof en['stewardShell.board.acceptanceUnrecorded'] === 'string',
    'P5 措辞键在 ACCEPTANCE_KEYS 里登记，中英双份齐备（判据共享、措辞各说各的）');
  // 「收工了没有」这条折算必须住在叶子 thread-facts.js —— 写在看板里会长出 'done'／'stopped'
  // 两个五态字面量，M6／N3 那两条「本模块零五态字面量」的锁会当场红（第一版就是这么红的）。
  const factsLeaf = stripComments(read('js/thread-facts.js'));
  ok(/export function missionStateSettled\(value\) \{/.test(factsLeaf)
    && !/function missionStateSettled\(/.test(boardCode),
    'P6 missionStateSettled 的正身住在叶子里，看板只 import 不实现');
}

// ─── S 2026-09-24：右栏可收起（用户：「右边的线程永远收不起来」）＋「打开」去工作台 ────────────────
// 行为由 steward-side-collapse.browser.e2e.js 与 steward-board.e2e.js F 组在真浏览器里跑；本组钉的是
// 「修法本身没被后来的改动悄悄绕开」的几件结构事实：
//   ① 偏好键与窄条阈值是导出常量（不是散落字面量），阈值与 layout.css §7.3 的 1180 是对面（1181）；
//   ② syncNow 是三态的【唯一】写口（hidden／data-collapsed），别处不写 data-collapsed；
//   ③ 抽屉自己那两条事件路先过 openGate（右栏收着时不以覆盖式开出来），门由看板注入、判据只住看板；
//   ④ 骨架：开关钮与窄条都在 #stewardSide 里、窄条默认 hidden；样式层有 [hidden] 守卫与 [data-collapsed] 规则；
//   ⑤ 行菜单里不再有第二枚「在工作台打开」（data-action="classic"），「打开」走 openInWorkbenchRow；
//   ⑥ 本机偏好读写都包 try/catch（本机存储不可用不致命）。
{
  ok(mod.STEWARD_SIDE_COLLAPSED_KEY === 'wcw.stewardSideCollapsed' && mod.STEWARD_SIDE_STRIP_MIN_WIDTH === 1181
    && /min-width: \$\{STEWARD_SIDE_STRIP_MIN_WIDTH\}px/.test(boardCode)
    && /@container frame \(min-width: 1181px\)/.test(read('css/views/steward-shell.css'))
    && /@container frame \(max-width: 1180px\)/.test(read('css/layout.css')),
    'S1 偏好键与窄条阈值是导出常量；1181 与 layout.css §7.3 的 1180 是同一条线的两面');
  ok(count(boardCode, /dataset\.collapsed = '1'/g) === 1 && count(boardCode, /now\.hidden = !canShow;/g) === 1
    && !/data-collapsed/.test(drawerCode) && !/dataset\.collapsed/.test(drawerCode),
    'S2 三态只由 syncNow 一处写（hidden ＋ data-collapsed），抽屉不碰它');
  ok(/let openGate = \(\) => true;/.test(drawerCode)
    && /addEventListener\('steward:open-thread', event => \{ if \(openGate\(\)\) openThread\(/.test(drawerCode)
    && /addEventListener\('steward:focus-thread', event => \{ if \(openGate\(\)\) openThread\(/.test(drawerCode)
    && /setOpenGate: handler =>/.test(drawerCode)
    && /drawer\.setOpenGate\(\(\) => !sideCollapsedActive\(\)\);/.test(boardCode)
    && count(boardCode, /function sideCollapsedActive\(\)/g) === 1,
    'S3 抽屉两条事件路先过 openGate；门由看板迟绑定注入，判据 sideCollapsedActive 只住看板一处');
  const sideMarkup = html.slice(html.indexOf('id="stewardSide"'), html.indexOf('</aside>', html.indexOf('id="stewardSide"')));
  ok(/<button type="button" id="stewardSideToggleBtn" class="icon-btn steward-side-toggle"/.test(sideMarkup)
    && /<button type="button" id="stewardSideStrip" class="steward-side-strip" hidden><\/button>/.test(sideMarkup)
    && sideMarkup.indexOf('id="stewardSideStrip"') < sideMarkup.indexOf('id="stewardFocus"'),
    'S4 开关钮与窄条住在 #stewardSide 里、窄条默认 hidden、都排在挂点 #stewardFocus 之前');
  ok(/\.steward-side-strip\[hidden\] \{ display: none; \}/.test(cssCode)
    && /\.steward-side\[data-collapsed="1"\] \{ width: var\(--steward-strip-w, 44px\); \}/.test(cssCode)
    && /:has\(> \.steward-side\[data-collapsed="1"\]\)/.test(read('css/views/steward-shell.css'))
    && /\.steward-side-strip,\s*\n\s*\.th-back-steward \{ transition: none; \}/.test(cssCode),
    'S4b 样式层：窄条的 [hidden] 守卫、收起态宽度、列宽规则、reduced-motion 关过渡 —— 四样都在');
  ok(!/'stewardShell\.board\.classicView'/.test(boardCode) && !/action: 'classic'/.test(boardCode)
    && /boardButton\('stewardShell\.board\.openThread', \(\) => openInWorkbenchRow\(sessionId\), \{ action: 'open' \}, 'lensWork'\)/.test(boardCode)
    && /function openInWorkbenchRow\(sessionId\)/.test(boardCode),
    'S5 行菜单只剩一枚「打开」（去工作台），退役的「在工作台打开」不再长回来');
  ok(/try \{ return globalThis\.localStorage && globalThis\.localStorage\.getItem\(STEWARD_SIDE_COLLAPSED_KEY\) === '1'; \}/.test(boardCode)
    && /try \{ globalThis\.localStorage && globalThis\.localStorage\.setItem\(STEWARD_SIDE_COLLAPSED_KEY, collapsed \? '1' : '0'\); \}/.test(boardCode),
    'S6 本机偏好读写都包 try/catch');
  ok(/if \(stripAllowed\(\)\) \{ setSideCollapsed\(true\); return true; \}/.test(boardCode),
    'S7 常驻栏上的 ×／Esc／「交回管家」＝收起右栏（closeNow 先问 stripAllowed；抽屉带那一档保留松钉子的旧语义）');
  for (const key of ['stewardShell.side.collapse', 'stewardShell.side.expand', 'stewardShell.side.fresh', 'threadHead.backToSteward']) {
    ok(typeof zh[key] === 'string' && typeof en[key] === 'string', `S8 文案键 ${key} 中英齐备`);
  }
}

console.log(`\nSTEWARD BOARD STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
