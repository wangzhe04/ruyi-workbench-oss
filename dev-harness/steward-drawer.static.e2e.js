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
// 121-K6b（34 号文 §2.6「焦点卡」）：13 → 14，且【顺序变了】——
//   · 卡头排到最前、元信息一行紧随其后（§2.6「卡头 → 元信息一行 → 按五态一段 → 动作行」；
//     原来是「事项行 → 页签 → 线程头」，把任务名摆在线程名前面当第一眼信息，那是浮层时代
//     「先说这是哪一件」的排法，常驻焦点栏里第一眼该是【这条线程】）；
//   · 多的那一项是排队那一段（stewardDrawerQueue：在等什么 ＋ 插队 ＋ 并发上限）。
// companion（A2b）：被折进「更多」的那四块【一块没少、顺序没变】—— 这条修法是「换个地方放」，
// 不是「删掉」，静态锁必须能把「顺手删了一块」和「折起来了」分开。
ok(Array.isArray(BLOCKS) && BLOCKS.length === 14 && Object.isFrozen(BLOCKS),
  `A1 导出的区块顺序表是冻结的 14 项（实测 ${BLOCKS && BLOCKS.length}）`);
ok(JSON.stringify(BLOCKS) === JSON.stringify([
  'stewardDrawerHead',         // ① 卡头（色条＋「任务 › 线程」＋药丸）
  'stewardDrawerMission',      // ② 元信息一行（来源图形 · 相对时间 · 验收 a/b；**不印费用**）
  'stewardDrawerTabs',         // ③ 线程页签
  'stewardDrawerAsk',          // ④ 它在问你（117l）
  'stewardDrawerChips',        // ⑤ 快切 chip
  'stewardDrawerLastSay',      // ⑥ 它正在说／它最后说（含当前动作行）
  'stewardDrawerQuickReplies', // ⑦ 你可以说
  'stewardDrawerQueue',        // ⑧ 排队：在等什么 ＋ 插队 ＋ 并发上限（121-K6b）
  'stewardDrawerMore',         // ⑨ 更多（容器，117l）
  'stewardDrawerRelay',        // ⑨-1 接力关系
  'stewardDrawerActivity',     // ⑨-2 三问
  'stewardDrawerAcceptance',   // ⑨-3 验收项
  'stewardDrawerScene',        // ⑨-4 现场
  'stewardDrawerFoot',         // ⑩ 底部动作行
]), `A2 区块顺序逐字为 §2.6 焦点卡那一串（实测 ${JSON.stringify(BLOCKS)}）`);
ok(JSON.stringify(mod.STEWARD_DRAWER_MORE_BLOCK_IDS)
  === JSON.stringify(['stewardDrawerRelay', 'stewardDrawerActivity', 'stewardDrawerAcceptance', 'stewardDrawerScene'])
  && mod.STEWARD_DRAWER_MORE_BLOCK_IDS.every(id => BLOCKS.includes(id)),
  'A2b companion：折进「更多」的四块一块没少、顺序没变（这条修法是换地方，不是删块）');
const positions = BLOCKS.map(id => html.indexOf(`id="${id}"`));
ok(positions.every(index => index > 0), 'A3 十四个区块骨架都静态写在 index.html 里（不是 JS 现搭）');
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
// 117s-B（用户第九轮走查①④「递话给已有线程／已收工的线程，『它刚说』更新不够及时」）：
// 表与三重门控一个字不动（C1／C3／C3b／C6 仍然是上面那几条），本组只钉「这一拍拉不拉」的两条判据。
// 切到 refreshOnce 自己的收尾大括号为止 —— 一路切到 pollSlice 的话会把中间那句模块级的
// `let lastPollAt = 0;` 声明也圈进来，本条断言就恒真了（写这条锁时踩过一次：把改动还原成
// `= Date.now()`，它照样绿）。
const refreshOnceAt = drawerCode.indexOf('async function refreshOnce()');
const refreshOnceBody = drawerCode.slice(refreshOnceAt, drawerCode.indexOf('\n  }', refreshOnceAt));
ok(/lastPollAt = 0;/.test(refreshOnceBody)
  && refreshOnceBody.lastIndexOf('lastPollAt = 0;') > refreshOnceBody.lastIndexOf('lastPollAt = Date.now();')
  && refreshOnceBody.lastIndexOf('lastPollAt = 0;') > refreshOnceBody.lastIndexOf('await loadMissionSlice();'),
  'C8 强刷跑完把节拍闸【打开】而不是关上：refreshOnce 末尾 lastPollAt 归零，下一拍照常自己判「该不该拉」——修前只有开头那句 = Date.now()，等于把下一次复核又推后整整一个节拍（空闲线程走 config.stewardPollMs，用户真机 15 s），而强刷恰恰发生在「刚有事发生」的时刻');
const pollSliceBody = drawerCode.slice(drawerCode.indexOf('async function pollSlice()'),
  drawerCode.indexOf('function pollIntervalMs()'));
ok(/const nowLive = isLive\(\);/.test(pollSliceBody)
  && /if \(wasLive !== nowLive\) await loadMissionSlice\(\);/.test(pollSliceBody)
  && !/wasLive && !isLive\(\)/.test(pollSliceBody)
  && count(pollSliceBody, /loadMissionSlice\(\)/g) === 1,
  'C9 live 的【两个方向】都同拍重拉事项切片：真→假（回合刚结束）与假→真（递话把已收工的线程重新点着）都只有事项面知道五态，只钉一边的话状态行会停在旧的那一档；判据合成一条 —— live 没变就一个请求都不多发');

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
// 121-K1（34 号文 §8.2）：这四个纯函数从 preview-task-sheet.js（随交办台退役整文件删除）搬进叶子
// js/thread-facts.js。判据不变（四样都必须 import 复用、不许在抽屉里复制），只换来源；而且不再钉
// import 语句的逐字顺序 —— 名字换个排列不该撞红。
ok(/from '\.\/thread-facts\.js'/.test(drawer)
  && ['acceptanceItems', 'activeAcceptanceIndex', 'taskProgress', 'elapsedLabel'].every(name =>
    new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./thread-facts\\.js'`).test(drawer)),
  'E1 验收项／进度／耗时四个纯函数 import 自叶子 thread-facts.js（不在抽屉里复制）');
ok(/import \{ describeTurnActivity \} from '\.\/turn-activity\.js';/.test(drawer),
  'E2 三问 import 自 turn-activity.js');
ok(/import '\.\/mission-state\.js';/.test(drawer) && /globalThis\.MissionState/.test(drawer),
  'E3 五态经 mission-state.js（UMD，import 后读 globalThis）');
// 117n-M1 重钉：drawer.js 的 chips import 那一行加了 doc/byId/el/clear（DOM 基础件去重，见 B3
// companion）。原判据只钉 createQuickSwitchChips 这一个名字；新判据仍然要求它在场，且明确写出
// 完整的四个新增名字——比原来更精确，不是放宽。
// 117u-G3 **重钉 E4**（§11.15.7；用户「这个也不印默认值吧」）：这条 import 又多了一个名字
// chipsWorthPrinting —— 详情栏这一行自此与看板同一份判据（跟全局一样就不印）。判据比原来更紧：
// 除照旧逐字钉住 import 的六个名字与 createQuickSwitchChips 在场，另加两条【抄第二份就立刻红】的：
// 抽屉剥了注释之后零 resolveEngineRoute(（不自己算生效路由）、零 engineRoute 字面量（不自己认字段）。
// 33 号文 §4 **再重钉 E4**：那次收编（回车发送的守卫进 chips.js）让这条 import 又多了一个名字
// bindEnterToSubmit。与 A3c 一样改成按名字集合判定：锁要钉的是「chips 与那条判据都是同一份、抽屉
// 零第二套回落规则」，不是「那一行长什么样」。（反向验证过：把 bindEnterToSubmit 从名字表里去掉立刻真红。）
const drawerChipsNames = read('js/steward-drawer.js').split(String.fromCharCode(10))
  .filter(line => line.startsWith('import {') && line.includes("from './steward-chips.js';"))
  .flatMap(line => line.slice(line.indexOf('{') + 1, line.indexOf('}')).split(','))
  .map(name => name.trim())
  .filter(Boolean);
ok(['createQuickSwitchChips', 'doc', 'byId', 'el', 'clear', 'chipsWorthPrinting', 'bindEnterToSubmit'].every(name => drawerChipsNames.includes(name))
  && /createQuickSwitchChips\(\{/.test(drawer)
  && !/resolveEngineRoute\(/.test(drawerCode) && !/engineRoute/.test(drawerCode),
  'E4 快切 chip 与「跟全局一样吗」判据都是 mount／import 进来的同一份，不是抽屉自己搭的；抽屉零第二套回落规则');
// 117u-G3 新钉：顺序是这一刀唯一容易写错的地方 —— 判据的【权限】那一半读的是 chips 自己 render()
// 画上去的 .is-pinned，所以必须【先 setSession 再问判据】；问早了读到的是上一拍的皮，刚定过档的
// 线程会晚一拍才现身。钉「同一个函数体里 setSession 出现在 chipsWorthPrinting 之前」，
// 而不是钉某个字面量在全文件里存在（那种写法在别处有同名调用时会假绿）。
{
  const body = /function renderChips\(\) \{([\s\S]*?)\n  \}/.exec(drawerCode);
  const inner = body ? body[1] : '';
  const setAt = inner.indexOf('chips.setSession(session)');
  const askAt = inner.indexOf('chipsWorthPrinting(');
  // 117u-G3b 重钉：判据的答案怎么用，两面【有意不同】——看板整条不印（信息），详情栏只收值、
  // 留控件（入口）。所以这里不再钉 `host.hidden = !…` 那个字面量，改钉两件事：判据在这个函数体里
  // 被问到了，且答案落在 classList 上而不是把控件摘掉（`hidden` 与 `remove(`/`clear(` 都算摘）。
  const toggles = /host\.classList\.toggle\('is-default', !chipsWorthPrinting\(/.test(inner);
  const tearsDown = /host\.hidden\s*=/.test(inner) || /host\.remove\(/.test(inner) || /clear\(host\)/.test(inner);
  ok(Boolean(body) && setAt >= 0 && askAt > setAt && toggles && !tearsDown,
    `E4b 详情栏的 chip 行「跟全局一样就不印默认值」：先 setSession 再问判据（.is-pinned 是 chips 自己的输出），答案落在 is-default 上、控件一直在（实测 setSession@${setAt} < 判据@${askAt}，落 class=${toggles}，摘控件=${tearsDown}）`);
  ok(count(drawerCode, /chips\.setSession\(/g) === 1,
    `E4b2 setSession 全文件只有 renderChips 里这一个调用点 —— 绕开它就是绕开判据（实测 ${count(drawerCode, /chips\.setSession\(/g)} 处）`);
}
// 117u-G3：hidden 要真收得住。.steward-drawer-chips 那条 display:flex 是作者样式，会盖掉 UA 的
// [hidden]{display:none}（本层 .steward-drawer / .steward-drawer-ask / .steward-drawer-wait 三处
// 踩过同一个坑）。且只许收抽屉这一份：2.0 视窗顶栏的 .steward-chips 是「给这条线程单独定一档」
// 剩下的那条路，跟着一起消失就是把能力删了。
ok(/\.steward-drawer-chips\[hidden\] \{ display: none; \}/.test(cssCode)
  && !/\.steward-chips\[hidden\]/.test(cssCode),
  'E4c 抽屉 chip 行的 [hidden] 守卫在（display:flex 会盖掉 UA 规则），且 2.0 顶栏那一份不受牵连');
// 117u-G3b：真正在干活的是这条 —— 收的是【值】那半个节点（.steward-chip-value），键那半与整个
// 按钮都留着，所以「给这条线程单独定一档」的入口没被收走。同样只许作用于抽屉这一份。
ok(/\.steward-drawer-chips\.is-default \.steward-chip-value \{ display: none; \}/.test(cssCode)
  && !/\.steward-chips\.is-default/.test(cssCode)
  && !/\.steward-drawer-chips\.is-default \.steward-chip(-key)? \{/.test(cssCode),
  'E4d 详情栏收的是 chip 的【值】那半，不是整个控件（键与按钮都还在，入口没丢）；2.0 顶栏那一份不受牵连');
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
// 117x-M2 **再重钉 F1**（27 号文 §11.17）：白名单多一条【只读】的 /api/usage/summary —— 模型选择器
// 的「常用置顶」由账本按模型的真实用量派生（M1 给这个既有端点补的第六个维度 byModel），
// 不是浏览器本地的猜测。它仍然是「后端零新增面」：没有新路由、没有新写口，chip 只在【第一次打开
// 模型菜单】时 GET 一次（模块级缓存，三个宿主共用），F3 的「零直调 fetch」与 C2 的「零计时器」一个字没松。
// 33 号文 §4 **重钉 F1**（抽屉 /api/missions 改经看板 rows）：白名单去掉【裸的】/api/missions ——
// 那张 200 行的列表不再由抽屉自己拉（它现在只读看板取回来的那一批），抽屉这一面只剩带 id 的
// /api/missions/（任务快照）。语义是收紧而不是放宽：这条路由一旦从抽屉里再长出来（自己发一次
// 列表请求），收集到的路由集就与白名单不再相等，本条当场红。
// 121-K5 **再重钉 F1**（34 号文 §3.1）：白名单多一条 /api/config —— chips 的模型菜单里新增了
// 【显式的】「设为新任务默认」。它是这一刀的要害：修前 2.0 顶栏切一次模型会顺带 POST /api/config
// 改全局默认（两种语义同屏，33 号文 §0），现在切模型恒为 PATCH /api/sessions/:id，只有点那一项
// 才写 /api/config。所以这条白名单项对应的不是「多了一条写路」，而是「那条写路从隐式变显式」。
// E6 那条「chipsCode 里 method:'PATCH' 恰好一处」仍然钉着会话级写口的唯一性。
// 121-K6b **再重钉 F1**（34 号文 §2.6 排队那一段）：白名单多一条
// /api/steward/arbiter/prioritize —— 「插队」。它是 116h 就立好的既有路由（看板行上那枚
// prioritize 走的就是它），焦点栏只是多了一个调用点，**后端零新增面**这件事一个字没松；
// 语义也刻意仍然做窄（只有还在排队的那一条能被提到队首，不在队列里如实说一句）。
// 「并发上限」那一枚【不在这张名单里】，因为它一个请求都不发：它把光标送到左栏栏头那个既有
// 输入框（全仓唯一一处并发上限控件），写值仍然只有看板那一条 saveConfigPartial。
const ALLOWED = [
  '/api/agent-runs/', '/api/chat/answer', '/api/config', '/api/interventions',
  '/api/missions/', '/api/permission/decision', '/api/session/rewind',
  '/api/sessions/', '/api/steward/arbiter/prioritize', '/api/steward/relay',
  '/api/stop', '/api/usage/summary',
].sort();
ok(JSON.stringify(routes) === JSON.stringify(ALLOWED),
  `F1 递话收成单口：白名单里有 /api/steward/relay，没有 /api/steer 与 /api/chat/stream（实测 ${JSON.stringify(routes)}）`);
ok(count(drawerCode, /\bfetch\(/g) === 0 && !/authHeaders/.test(drawerCode)
  && /import \{ apiErrorInfo \} from '\.\/net\.js';/.test(drawer),
  `F2 抽屉零直调 fetch（不再读流）；net.js 那一份改取 apiErrorInfo —— relay 的失败是结构化信封（实测 fetch=${count(drawerCode, /\bfetch\(/g)}）`);
ok(count(chipsCode, /\bfetch\(/g) === 0, 'F3 chip 模块一律经注入的 api()，零直调 fetch');
// F4d（33 号文 §4「抽屉 failNote 对齐看板」）：抽屉此前那份 failNote 是 117n-M1② 之前的弱化版 ——
// 自己读 info.code/info.message，结构化信封拿不到就落到 String(error)。现在三条判据（稳定码 /
// wait.label / 人话文本）全部取自 steward-conversation.js 的权威实现，与看板那一条逐条同；
// 把任意一处换回本地解包，这条当场红。
const failNoteBody = drawerCode.slice(drawerCode.indexOf('function failNote'), drawerCode.indexOf('function failNote') + 800);
ok(/const code = stewardErrorCode\(info\);/.test(failNoteBody)
  && /stewardQueuedWaitLabel\(info\)/.test(failNoteBody)
  && /stewardErrorText\(info\)/.test(failNoteBody)
  && !/String\(\(info && info\.message\)/.test(failNoteBody)
  && /stewardErrorCode, stewardErrorText, stewardQueuedWaitLabel \} from '\.\/steward-conversation\.js';/.test(drawer),
  'F4d 抽屉 failNote 与看板同判据：稳定码 / wait.label / 人话文本三处都只经 steward-conversation.js（零本地弱化解包）');
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
// 117q-B3b 重钉（理由：30 号文 §4.4 P0-4——五态人话原来抄了四份，两套 locale key 已判出不同文案
// 结果。六个五态键从抽屉专属的 stewardShell.drawer.state.* 搬到中性的 mission.state.*，与看板、
// 交办台三个壳共用同一组键；不是被删掉，所以模板键扫描要跟着认 mission. 前缀，不能只认 stewardShell.）。
const usedKeys = [...new Set([
  ...[...`${drawer}\n${chips}`.matchAll(/'(stewardShell\.[a-zA-Z0-9_.]+)'/g)].map(match => match[1]),
  ...[...`${drawer}
${chips}`.matchAll(/`((?:stewardShell|mission)\.[a-zA-Z0-9_.]+)\$\{/g)].map(match => match[1]),
])];
const templated = usedKeys.filter(key => key.endsWith('.'));
const literal = usedKeys.filter(key => !key.endsWith('.'));
const missing = literal.filter(key => typeof zh[key] !== 'string' || typeof en[key] !== 'string');
ok(missing.length === 0, `H2 两模块引用的 ${literal.length} 个 i18n 键中英都齐备（缺: ${missing.join(',') || '无'}）`);
// 模板键（五态标签、四档 label/hint）按枚举逐条核对，不能只靠前缀存在。
for (const value of ['dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask']) {
  const key = `mission.state.${value}`;
  ok(typeof zh[key] === 'string' && typeof en[key] === 'string', `H3 五态人话 ${value} 中英齐备（mission.state.*）`);
}
for (const mode of chipsMod.STEWARD_PERMISSION_MODES) {
  ok(typeof zh[`stewardShell.permission.${mode}.label`] === 'string'
    && typeof zh[`stewardShell.permission.${mode}.hint`] === 'string'
    && typeof en[`stewardShell.permission.${mode}.label`] === 'string'
    && typeof en[`stewardShell.permission.${mode}.hint`] === 'string',
    `H4 权限档 ${mode} 有 label 与一句人话 hint（中英）`);
}
// 两组模板键：mission.state.（五态，117q-B3b 前是 stewardShell.drawer.state.）与 stewardShell.permission.
// （四档 label/hint）。数量不变，前缀之一变了，实测数组一并打进失败信息方便下次核对。
ok(templated.length === 2 && templated.includes('mission.state.') && templated.includes('stewardShell.permission.'),
  `H4b 只有五态与权限档两组模板键（实测 ${JSON.stringify(templated)}）`);
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
// 121-K6b **重钉 J4**（34 号文 §2.6／§5）：工具人话从「它正在说」的引文尾巴搬到【当前动作行】
// （`工具 · 第 N 次调用 · N 秒前有输出`）—— 引文只放它说的话，一句话里不掺一句状态。
// 要钉的事实一个字没变：**界面上永远不出现工具名**，表外一律落到「用一个工具」。
ok(/parts\.push\(threadToolLabel\(tool\)\);/.test(drawer)
  && /function threadToolLabel\(tool\) \{[\s\S]{0,200}return key \? t\(key\) : t\('stewardShell\.drawer\.tool\.other'\);/.test(drawer)
  && !/usingTool/.test(drawer),
  'J4 工具说人话（铁律：界面上永远不出现工具名），表外落到「用一个工具」；这句话住在当前动作行，不在引文里');
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
// 121-K6b **重钉 J7**（§13.7 登记 ⑨）：焦点栏常驻之后，换焦点的触发者多数不是用户（管家递话、
// 推送来帧、syncNow 的自动挑选），把光标从用户正在打字的地方抢走就是把键位丢掉。
// 「闸落之后才移焦」这半句一个字没松，只是外面多了一道「用户没在打字」的门。
ok(/if \(sessionId === id\) \{ loading = false; renderAll\(\); if \(wantFocus\) focusAsk\(\); \}/.test(drawer)
  && /function userIsTyping\(\)/.test(drawer)
  && /return active\.isContentEditable === true;/.test(drawer)
  && /const wantFocus = opts && opts\.focus === true \? true : \(opts && opts\.focus === false \? false : !userIsTyping\(\)\);/.test(drawer),
  'J7 焦点在【loading 闸落下之后】才给问答框，且只在用户没在输入框里打字时才移焦（§13.7 ⑨）');
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
// 121-K6b **重钉 J8**（33 号文第 11 项／§5「最后动静统一用 stewardAgoLabel」）：锚点仍然是
// updatedAt（那一半没变，判据收进 lastTouchLabel 一处），换掉的是【人话来源】——
// 原来借 elapsedLabel 出一个时长「3m 20s」当「多久以前」用，抽屉里因此有两种时间写法。
// 现在与卡头那一句是同一处实现、同一句「3 分钟前」。反向：把 lastTouchLabel() 换回
// elapsedLabel(touched, new Date()) → 本条红。
ok(/t\('stewardShell\.drawer\.settledSince', \{ elapsed: ago \}\)/.test(drawer)
  && /const ago = lastTouchLabel\(\);/.test(drawer)
  && /const touched = String\(\(missionRow && missionRow\.updatedAt\) \|\| \(session && session\.updatedAt\) \|\| ''\);/.test(drawer)
  && count(drawerCode, /stewardAgoLabel\(/g) === 1
  && !/stewardShell\.drawer\.settled'/.test(drawer),
  'J8 「已收工 · 最近动过 X 前」锚在 updatedAt，人话与卡头【同一处】stewardAgoLabel（抽屉里只剩一种时间写法）');
ok(typeof zh['stewardShell.drawer.settled'] === 'undefined' && typeof en['stewardShell.drawer.settled'] === 'undefined',
  'J8b 旧键 stewardShell.drawer.settled 已随最后一个引用一起删掉（零引用键不留在目录里）');
// 看板行那枚 pill（117l D4）：只读行上的 asksYou，点击 = 打开抽屉。
const board = read('js/steward-board.js');
// 117m-A2 **重钉 J9**（语义是「一句话变四句」，不是放宽）：旧断言逐字钉着 `t('stewardShell.board.asksYou')`
// 这一句写死的文案，于是 permission／plan／pool 三类只能顶着「它在问你」出现 —— 用户看不出
// 点进去要干什么。现在文案由 asksYou.kind 决定（表在 STEWARD_BOARD_ASKS_YOU_KEYS），
// 并额外钉住「看板里没有第二处写死的那句话」（比旧断言更强）。
// 121-K4：左栏是两视角共用的那一份，所以「点它」在两视角里是两件事 —— 管家视角仍然是把抽屉
// 开到这一条（问答卡在那儿），工作台视角是 openSession（中栏换成这条线程）。两条都经 openRow
// 这【一个】入口，本模块没有第二条打开路径。文案由 kind 决定这件事一个字没变。
ok(/if \(row\.asksYou && typeof row\.asksYou === 'object' && String\(row\.asksYou\.kind \|\| ''\)\) \{/.test(board)
  && /pill\.onclick = \(\) => openRow\(sessionId\);/.test(board)
  && /if \(isStewardMode\(\)\) return openThread\(id\);/.test(board)
  && /t\(STEWARD_BOARD_ASKS_YOU_KEYS\[kind\] \|\| STEWARD_BOARD_ASKS_YOU_KEYS\.soft\)/.test(board)
  && !/t\('stewardShell\.board\.asksYou'\)/.test(board),
  'J9 左栏行 pill 的文案【由 asksYou.kind 决定】（不是写死一句），点它仍然是打开那一条（管家＝抽屉开到它，工作台＝openSession；同一个 openRow 入口）');

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

// ─── K F3（32 号文 §2.2）：右栏「就地回答」把光标交回抽屉，抽屉这一侧只多了一个只读句柄 ──────
// 「现在这几件」把等你的那条线程做成可就地回答的小行。诚实的零重复形状是：小行只负责【聚焦】，
// 答案仍然从抽屉这一份输入口发出去 —— 所以抽屉这边只该多一个 focusComposer，发送路径一处不加。
// 本组钉的是「输入口与发送路径都还是一份」这件事，不钉那几行长什么样。
ok(/function focusComposer\(\) \{[\s\S]{0,200}byId\('stewardDrawerInput'\)/.test(drawerCode)
  && /focusComposer,/.test(drawer) && /focusAsk,/.test(drawer),
  'K1 抽屉导出 focusComposer（把光标放回底部「直接对这条线程说」），与 focusAsk 一起构成右栏就地回答的两个落点');
ok(count(drawerCode, /api\('\/api\/steward\/relay'/g) === 1
  && count(drawerCode, /api\('\/api\/chat\/answer'/g) === 2
  && !/api\(/.test(drawerCode.slice(drawerCode.indexOf('function focusComposer()'), drawerCode.indexOf('function renderQuickReplies'))),
  `K2 发送路径一处不加：递话单口仍然只有 1 个调用点、答复口仍然是既有那 2 个（卡里的自由回答 ＋ 选项按钮；实测 ${count(drawerCode, /api\('\/api\/steward\/relay'/g)}／${count(drawerCode, /api\('\/api\/chat\/answer'/g)}），新句柄自己一个请求都不发`);
const drawerMarkup = html.slice(html.indexOf('id="stewardDrawer"'), html.indexOf('</aside>', html.indexOf('id="stewardDrawer"')));
ok(count(drawerMarkup, /<textarea/g) === 2
  && drawerMarkup.includes('id="stewardDrawerAskInput"') && drawerMarkup.includes('id="stewardDrawerInput"'),
  `K3 全壳仍然只有抽屉里这两个输入框（问答卡一个、底部一个）——右栏没有、也不许有第三个（实测 ${count(drawerMarkup, /<textarea/g)} 个）`);

// ─── L F5a（27 号文 §11.13.1「F 追加」）：抽屉的动作与五态都配了图标 ─────────────────
// 三件必须成立的事：
//   ① 静态动作键的 data-i18n 挂在【内层 span】上 —— applyTranslations 是 `node.textContent = value`，
//      挂在带 [data-icon] 的 button 上会把 hydrateIcons 刚注入的 SVG 一起抹掉（boot 里
//      hydrateIcons 之后还会再 setLocale 一次，所以这不是理论问题）。这条是本组最值钱的一条；
//   ② 线程「停止」用的是实心方块 stop —— 管家本人的停机在头部，那一枚是电源符（同形不同义到此为止）；
//   ③ 五态药丸多了一枚由五态值派生的字形，而 textContent 逐字仍是那句人话（既有断言读的就是它）。
const iconsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'icons.js')).href);
const iconNameSet = new Set(iconsMod.iconNames());
const drawerIconed = [...drawerMarkup.matchAll(/<button[^>]*?id="(steward[A-Za-z]+)"[^>]*?data-icon="([A-Za-z]+)"[\s\S]{0,200}?<\/button>/g)]
  .map(match => ({ id: match[1], glyph: match[2], markup: match[0] }));
const DRAWER_ICONED_IDS = ['stewardDrawerClassicBtn', 'stewardDrawerFullTextBtn', 'stewardDrawerChangesBtn',
  'stewardDrawerSendBtn', 'stewardDrawerPauseBtn', 'stewardDrawerResumeBtn', 'stewardDrawerStopBtn',
  'stewardDrawerRewindBtn', 'stewardDrawerHandBackBtn'];
ok(DRAWER_ICONED_IDS.every(id => drawerIconed.some(entry => entry.id === id)),
  `L1 派单点名的九枚抽屉动作全部配了图标（缺: ${DRAWER_ICONED_IDS.filter(id => !drawerIconed.some(entry => entry.id === id)).join(',') || '无'}）`);
ok(drawerIconed.length > 0 && drawerIconed.every(entry => iconNameSet.has(entry.glyph)),
  `L2 每一个 data-icon 名都真的在 ICONS 表里（实测 ${JSON.stringify(drawerIconed.map(entry => entry.id + '=' + entry.glyph))}）`);
ok(drawerIconed.every(entry => !/<button[^>]*data-i18n="/.test(entry.markup)
    && /<span data-i18n="[a-zA-Z.]+">/.test(entry.markup)),
  'L3 这些按钮的 data-i18n 挂在【内层 span】上：applyTranslations 写的是 textContent，挂在 button 上会把刚注入的 SVG 一起抹掉（boot 里 hydrateIcons 之后还会再 setLocale 一次）');
ok(drawerIconed.find(entry => entry.id === 'stewardDrawerStopBtn').glyph === 'stop'
  && !drawerIconed.some(entry => entry.glyph === 'power' || entry.glyph === 'powerOff'),
  'L4 线程「停止」用的是实心方块 stop；电源符只归管家本人的停机／唤醒（头部那一枚），抽屉里一次都不出现');
// 121-K6b：renderHead 后面那个函数从 lastAssistantText 变成 actingLine（当前动作行），切片终点
// 跟着走；import 那一行多了一个 icon（元信息一行的来源图形与左栏行同一批字形）。
const renderHeadBody = drawerCode.slice(drawerCode.indexOf('function renderHead()'), drawerCode.indexOf('function actingLine()'));
ok(renderHeadBody.length > 0
  && /import \{ missionStateIcon, icon \} from '\.\/icons\.js';/.test(drawer)
  && count(drawerCode, /missionStateIcon\(/g) === 1
  && count(renderHeadBody, /stateLabel\(/g) === 1
  && /stateNode\.appendChild\(doc\(\)\.createTextNode\(stateLabel\(stateValue\)\)\);/.test(renderHeadBody)
  && /const stateValue = threadStateOf\(missionRow\);/.test(renderHeadBody),
  'L5 状态药丸 = 一枚派生字形 ＋ 原来那句 stateLabel（药丸里恰好一处文案来源，不是两处），五态仍然只由 threadStateOf → mission-state.js 判一次');
ok(/\.steward-drawer-state \{[\s\S]{0,200}?gap: var\(--sp-1\);/.test(cssCode)
  && /\.steward-drawer-link\[hidden\] \{ display: none; \}/.test(cssCode)
  && /\.steward-drawer-btn\[hidden\] \{ display: none; \}/.test(cssCode),
  'L6 药丸给字形留了 gap；新给 display 的 .steward-drawer-link 补上了 [hidden] 守卫（本层第四处，前三处的根因写在 .steward-drawer-ask 那段注释里）');

// ─── M 117u-G1：线程详情栏改用那枚共用的线程卡（27 号文 §11.15.3 D1-D3）────────────────
// 这一组钉的全是【机械事实】，不是文案或像素：
//   谁发的色号／五态词表查的是哪一份／卡骨架的皮住在哪一层／破坏性动作还在不在一眼可及处。
const conversationMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-conversation.js')).href);
const conversationSrc = read('js/steward-conversation.js');
const conversationCssCode = read('css/views/steward-conversation.css').replace(/\/\*[\s\S]*?\*\//g, '');

// ① 色号：全仓一张登记表，抽屉只【问】不【记】。
// 121-K6b **重钉 M1**（34 号文 §5「色号按任务」）：表的键从 sessionId 换成 missionId，线程继承
// 任务色。四件事实：① 同一条恒同色、空 id 仍回 0（原判据两条一字未动）；② 同一个任务下的两条
// 线程【同色】（这是本刀要的那一条，修前必然不同色）；③ 发号器是显式计数器而不是 Map.size ——
// 归并会删临时键，读 size 就会发重号；④ 登记表仍然只有一张（一处 new Map() 给色号）。
ok(typeof conversationMod.stewardThreadHueFor === 'function'
  && conversationMod.stewardThreadHueFor('m-a') === conversationMod.stewardThreadHueFor('m-a')
  && conversationMod.stewardThreadHueFor('') === 0
  && (() => {
    conversationMod.stewardRegisterThreadMission('k6b-t1', { missionId: 'k6b-m', threadCount: 2 });
    conversationMod.stewardRegisterThreadMission('k6b-t2', { missionId: 'k6b-m', threadCount: 2 });
    return conversationMod.stewardThreadHueFor('k6b-t1') === conversationMod.stewardThreadHueFor('k6b-t2');
  })()
  && count(conversationSrc, /const stewardThreadHues = new Map\(\);/g) === 1
  && /let stewardHueSeq = 0;/.test(conversationSrc)
  && !/stewardThreadHue\(stewardThreadHues\.size\)/.test(conversationSrc),
  'M1 色号登记表在模块级、键是 missionId（同一任务两条线程同色、空 id 回 0），发号器是计数器不是 Map.size');
// 117v-V2 **重钉 M2 的第一个合取项**（语义没变，被一次合法改动挪走了）：⑤「它刚说」的取段判据
// 也从 steward-conversation.js 拿（stewardDeliverableText），于是同一行 import 多了第四个名字。
// 旧断言逐字钉着三个名字的列表 —— 那是「色号只问一次、不自己算」这件事的【伴生字面量】，不是它
// 本身；钉字面量的代价就是这种：合法复用把名单加长一个，锁当场红，整条 e2e 闸卡死。
// 现在改成钉三件事实：① 三个名字都还是从这个模块 import 的（一个都没被本地重写）；
// ② 色号在本文件只问一次；③ 本文件零本地登记表、零 stewardThreadHue()、零颜色字面量。
ok(/import \{[^}]*\bstewardThreadHueFor\b[^}]*\bstewardThreadStateKey\b[^}]*\bstewardAgoLabel\b[^}]*\} from '\.\/steward-conversation\.js';/.test(drawer)
  && count(drawerCode, /stewardThreadHueFor\(/g) === 1
  && !/new Map\(\)|stewardThreadHue\(|hsl\(|rgb\(/.test(drawerCode),
  `M2 抽屉的色号【只问一次、不自己算】：一处 stewardThreadHueFor(（实测 ${count(drawerCode, /stewardThreadHueFor\(/g)}），零本地登记表、零 stewardThreadHue()、零颜色字面量`);
ok(/headNode\.dataset\.threadHue = String\(stewardThreadHueFor\(sessionId, missionRow && missionRow\.missionId\)\);/.test(drawerCode)
  && /else headNode\.removeAttribute\('data-thread-hue'\);/.test(drawerCode),
  'M2b 号写在详情头的 data-thread-hue 上（与对话流那一行 markThread 同一个属性），没有线程时把属性摘掉 —— 不留一根说不清是谁的色条');

// ② 五态词表：抽屉查【共享那一份】，重合的档从此保证同词；抽屉自己仍然一个五态字面量都没有。
ok(typeof conversationMod.stewardThreadStateKey === 'function'
  && conversationMod.stewardThreadStateKey('done') === conversationMod.STEWARD_THREAD_STATE_KEYS.done
  && conversationMod.stewardThreadStateKey('dispatching') === ''
  && Object.isFrozen(conversationMod.STEWARD_THREAD_STATE_KEYS),
  'M3 五态词表导出成一份（查不到回空串，调用方据此回落），表本身仍然冻结 —— 改名它三面同时变');
// M4 的判据刻意【不】是「本文件零五态字面量」—— 那句话是假的：quickRepliesFor 里真有一行
// `state === 'running' || state === 'dispatching'`（它判的是「该给哪几句快捷回复」，不是词表）。
// 要钉的是「没有第二份【态 → 人话键】的表」：全文件出现 mission.state. 的地方恰好一处，且那一处
// 是模板不是写死的键。反向验证：把 stateLabel 改回 `t('mission.state.' + value)` 之外再补一张
// { needs_you: 'mission.state.needs_you', … }，count 立刻 >1，本条转红。
ok(/return t\(stewardThreadStateKey\(value\) \|\| `mission\.state\.\$\{value\}`\);/.test(drawerCode)
  && count(drawerCode, /stewardThreadStateKey\(/g) === 1
  && count(drawerCode, /mission\.state\./g) === 1
  && !/'mission\.state\.[a-z_]+'/.test(drawerCode),
  `M4 抽屉的药丸人话先查共享词表、查不到才回落中性模板（dispatching／quick_ask 那两档共享表里没有）；全文件出现 mission.state. 恰好一处且是模板，没有第二份「态 → 人话键」的表（实测 ${count(drawerCode, /mission\.state\./g)} 处）`);

// ③ 卡骨架的皮住在【一层】：抽屉挂类名，不重写药丸的色/形。
// 121-K6b：名单去掉 .steward-tcard-act —— 那个基元管的是「卡头右端那枚主动作的落点」，
// 而「在工作台打开」按 §2.6 已经从卡头搬到底部动作行的首位（金色那一枚，M7 钉着）。
// 卡头此刻只有色条 · 色点 ·「任务 › 线程」· 药丸四样，没有动作，也就不该再挂那个类。
for (const klass of ['steward-tcard', 'steward-tcard-name', 'steward-tcard-state']) {
  ok(new RegExp(`classList\\.add\\('${klass}'\\)`).test(drawerCode), `M5 详情头挂上共用类 .${klass}`);
}
ok(/\.steward-tcard-state,\s*\n\.steward-thread-state \{/.test(conversationCssCode)
  && /\.steward-tcard-bar \{ inset-inline-start: 0; \}/.test(conversationCssCode)
  && /\.steward-msg-ruyi\.is-thread::after,\s*\n\.steward-tcard-bar \{/.test(conversationCssCode),
  'M5b 骨架（药丸／色条）在 steward-conversation.css 里是【一条选择器两个名字】：对话流那一侧因此逐字节还是同一份声明，抽屉与看板照 .steward-tcard-* 这份类契约画');
ok(!/\.steward-drawer-state \{[^}]*(border-radius|background|padding)/.test(cssCode)
  && !/--thread-color/.test(cssCode)
  && /\.steward-drawer-state \{[\s\S]{0,200}?gap: var\(--sp-1\);/.test(cssCode),
  'M5c 抽屉那一层【不再】自己写药丸的色/圆角/内距（搬去基元了，留着就是第二份），也不自己构造 --thread-color；只留 F5a 那枚字形要的 gap');

// ④ D2「它在问你」＝卡内 callout（左侧 2px 强调边 ＋ 面色），不再是一整块独立黄框。
ok(/\.steward-drawer-ask \{[\s\S]{0,400}?border-inline-start: 2px solid var\(--gold\);/.test(cssCode)
  && /\.steward-drawer-ask \{[\s\S]{0,400}?background: var\(--panel\);/.test(cssCode)
  && !/\.steward-drawer-ask \{[\s\S]{0,400}?background: var\(--gold-soft\);/.test(cssCode),
  'M6 「它在问你」是卡内 callout：左侧 2px --gold 强调边 ＋ --panel 面色，整块 --gold-soft 底没了（语义还是那一族色，收的是墨量）');

// ⑤ D3 底部动作分级：主一枚、破坏性两枚收进「更多」，可访问名一个字没改。
// 121-K6b **重钉 M7**（§2.6 动作行「主＝在工作台打开」）：金色那一枚从「发给它」换成
// 「在工作台打开」（它从卡头搬到了动作行首位）。要钉的事实没变：**主动作只有一枚**，
// 而且旧的那一枚是被【显式摘掉】的，不是靠没人加。
ok(/const primary = byId\('stewardDrawerClassicBtn'\);/.test(drawerCode)
  && /if \(primary\) primary\.classList\.add\('is-primary'\);/.test(drawerCode)
  && /if \(send\) send\.classList\.remove\('is-primary'\);/.test(drawerCode)
  && count(drawerCode, /classList\.add\('is-primary'\)/g) === 1,
  'M7 底部只有一枚主动作（「在工作台打开」拿 .is-primary 那身金色皮），不是六枚等重');
const footMoreIds = (drawerCode.match(/STEWARD_DRAWER_FOOT_MORE_IDS = Object\.freeze\(\[([^\]]*)\]\)/) || [])[1] || '';
ok(/'stewardDrawerRewindBtn'/.test(footMoreIds) && /'stewardDrawerHandBackBtn'/.test(footMoreIds)
  && /for \(const button of buttons\) more\.appendChild\(button\);/.test(drawerCode)
  && !/textContent|setAttribute\('aria-label'/.test(drawerCode.slice(drawerCode.indexOf('function gradeFootActions'), drawerCode.indexOf('function bindStewardDrawer'))),
  'M8 「整单回退／交回管家」是被【原样搬】进折叠里的（appendChild 同一个节点），这一段一个 textContent／aria-label 都没写 —— 可访问名与既有接线逐字不变');
ok(/summary\.dataset\.i18n = 'stewardShell\.drawer\.more';/.test(drawerCode)
  && typeof zh['stewardShell.drawer.more'] === 'string' && typeof en['stewardShell.drawer.more'] === 'string'
  && count(drawerCode, /t\('stewardShell\.drawer\.more'\)/g) === 1,
  'M8b 「更多」复用 body 那枚折叠已经在用的键（零新增 i18n 键），且挂了 data-i18n —— 切语言时动态建的这枚 summary 会跟着变');
ok(/\.steward-drawer-foot-more \{ min-width: 0; margin-inline-start: auto; \}/.test(cssCode)
  && /\.steward-drawer-foot-more\[open\] \{/.test(cssCode)
  && !/\.steward-drawer-foot-more \{[^}]*display: flex/.test(cssCode),
  'M8c 折叠的 display:flex 锁在 [open] 上：给 <details> 本身写 flex 会让收起来的内容照样被画出来（.steward-drawer-more 那条注释里的同一个坑）');

// ─── N 117v-V2：⑤「它刚说」按分段取交付；切模型/引擎的那句说明常显（27 号文 §11.16.2 V2 行）───
// 这一组钉的全是【机械事实】，不是文案也不是像素：判据住在哪一份、有没有长出第二份、
// 问句判定吃的还是不是整条原话、那句说明依不依赖一个已知不可靠的信号。

// ① 取段判据只有一处 —— 抽屉问 steward-conversation.js 那一份，自己不遍历分段账本。
ok(/import \{[^}]*\bstewardDeliverableText\b[^}]*\} from '\.\/steward-conversation\.js';/.test(drawer)
  && count(drawerCode, /stewardDeliverableText\(/g) === 1
  && !/segments/.test(drawerCode),
  `N1 ⑤ 的取段判据【只问不写】：从 steward-conversation.js import，全文件调用一次（实测 ${count(drawerCode, /stewardDeliverableText\(/g)}），且剥掉注释后一个 segments 都不出现 —— 抽屉里没有第二份分段遍历`);
ok(/const said = lastSaySentences\(stewardLastDeliverable\(session && session\.messages\)\);/.test(drawerCode),
  'N1b 收工态的「它刚说」＝先按分段取交付段、再取那一段的【开头】≤3 句（不是整条 content 的开头）');
// 取头不取尾是有意的：过滤之后第一句就是收口结论，末尾往往是注意事项/风险提示/下一步建议；
// 对话区那一份交付卡走的也是「从头显示、超 8 行折叠」，两处同一个方向。活回合那一路仍取末尾。
ok(mod.lastSaySentences('一。二。三。四。') === '一。二。三。'
  && mod.liveTailSentences('一。二。三。四。') === '二。三。四。',
  'N1c 两条取句方向没被顺手对调（收工取头、活回合取尾，与 J3 同一对判据）');

// ② 行为（Node 直接 import 那个导出纯函数跑真值表）：老会话回落、过程叙述被挡、取不出就往前找。
ok(typeof mod.stewardLastDeliverable === 'function', 'N2 取交付原文的那一步是可 Node import 的纯函数');
{
  const PROCESS = '我先联网核实最新数据。';
  const DELIVERED = '核实完了，三个数字都对得上。';
  const mixed = {
    role: 'assistant',
    content: PROCESS + DELIVERED,
    segments: [
      { id: 'segment-1', type: 'text', text: PROCESS },
      { id: 'segment-2', type: 'tool', toolCallId: 't1', name: 'web_search', status: 'done' },
      { id: 'segment-3', type: 'text', text: DELIVERED },
    ],
  };
  ok(mod.stewardLastDeliverable([mixed]) === DELIVERED
    && mod.stewardLastDeliverable([mixed]).indexOf(PROCESS) < 0,
    `N2b 夹在工具调用之前的过程叙述【不进】「它刚说」（实测「${mod.stewardLastDeliverable([mixed])}」）`);
  // 老会话（EC-D 之前落盘的，账本缺席/空/不是数组）：必须回落到 content 整段，绝不返回空 ——
  // 返回空就是把「读不到」演成「它没说过话」。三种缺席形状逐条跑。
  const legacy = text => ({ role: 'assistant', content: '老会话说的话' + (text || '') });
  ok(mod.stewardLastDeliverable([legacy()]) === '老会话说的话'
    && mod.stewardLastDeliverable([{ ...legacy(), segments: [] }]) === '老会话说的话'
    && mod.stewardLastDeliverable([{ ...legacy(), segments: null }]) === '老会话说的话'
    && mod.lastSaySentences(mod.stewardLastDeliverable([legacy()])) !== '',
    'N2c 分段账本缺席/空/不是数组的老会话 → 回落到 content 整段，「它刚说」不为空');
  // 以工具调用收尾、一句收口的话都没写的那一条：本身没有交付原文 → 跳过它继续往前找。
  const trailingTool = {
    role: 'assistant',
    content: '我去查一下。',
    segments: [
      { id: 'segment-1', type: 'text', text: '我去查一下。' },
      { id: 'segment-2', type: 'tool', toolCallId: 't2', name: 'web_search', status: 'done' },
    ],
  };
  ok(mod.stewardLastDeliverable([trailingTool]) === ''
    && mod.stewardLastDeliverable([mixed, trailingTool]) === DELIVERED,
    'N2d 以工具调用收尾、没写收口话的那一条没有交付原文 → 跳过它退到更早一条真有交付的（与 stewardDeliverableFrom 同源）');
  ok(mod.stewardLastDeliverable([]) === '' && mod.stewardLastDeliverable(null) === ''
    && mod.stewardLastDeliverable([{ role: 'user', content: '用户说的' }]) === '',
    'N2e 空/非数组/只有用户消息 → 回空串（调用方据此说「它还没说过话」）');
}

// ③ 问句判定【继续吃整条 content】：④ 的客户端兜底与 ⑦ 的「好，就这样／先不要」都靠「最后一句
// 是不是问号收尾」。交付段是 content 的后缀，非空时末字符一样；唯一分岔是交付段为空那一档 ——
// 那时若也换成交付段，选消息会退到更早一条，把过去了的问句误报成「它现在在问你」。
ok(count(drawerCode, /lastAssistantText: lastAssistantText\(\)/g) === 2
  && /function lastAssistantText\(\) \{[\s\S]{0,320}String\(message\.content \|\| ''\)\.trim\(\)/.test(drawerCode)
  && count(drawerCode, /export function stewardLastDeliverable\(/g) === 1
  && count(drawerCode, /stewardLastDeliverable\(session/g) === 1,
  `N3 两处问句判定仍吃【整条 content】（实测 ${count(drawerCode, /lastAssistantText: lastAssistantText\(\)/g)} 处），交付段只有 ⑤ 那一处消费（一处定义 ＋ 一处调用，实测调用 ${count(drawerCode, /stewardLastDeliverable\(session/g)}）`);

// ④ 切模型/引擎的那句说明：两个菜单都带、每张菜单只出一次、不接任何活性信号。
ok(Object.isFrozen(chipsMod.STEWARD_SWITCH_NOTE_KINDS)
  && JSON.stringify(chipsMod.STEWARD_SWITCH_NOTE_KINDS) === JSON.stringify(['model', 'engine'])
  && chipsMod.STEWARD_SWITCH_NOTE_KEY === 'stewardShell.chips.switchTakesEffect',
  `N4 那句说明摆在【模型与引擎】两个菜单里，清单是导出的冻结常量（实测 ${JSON.stringify(chipsMod.STEWARD_SWITCH_NOTE_KINDS)}）`);
// 摆在 toggleMenu（开菜单那一处）而不是两个 builder 里：紧凑模式下 buildModelMenu 会调
// buildEngineMenu，摆进 builder 就会在同一张菜单上出两遍。全文件只有一处 t(那个键)。
ok(count(chipsCode, /t\(STEWARD_SWITCH_NOTE_KEY\)/g) === 1
  && /BUILDERS\[kind\]\(chip\.menu\);[\s\S]{0,320}STEWARD_SWITCH_NOTE_KINDS\.includes\(kind\)[\s\S]{0,320}chip\.menu\.appendChild\(switchNote\);/.test(chipsCode)
  && !/function buildModelMenu\(menu\) \{[\s\S]{0,900}?STEWARD_SWITCH_NOTE/.test(chipsCode)
  && !/function buildEngineMenu\(menu\) \{[\s\S]{0,600}?STEWARD_SWITCH_NOTE/.test(chipsCode),
  `N4b 一张菜单只出一句：append 在开菜单那一处（实测 t(键) ${count(chipsCode, /t\(STEWARD_SWITCH_NOTE_KEY\)/g)} 处），两个 builder 里一个字都没有 —— 紧凑模式把引擎收进模型菜单时不会出两遍`);
// 关键的一条：这句话【无条件为真】，所以它的出现不许押在任何「在不在跑」的信号上。本仓的活性
// 判据已知不可靠（steward-drawer.js renderLastSay 那段注释写着 isLive() 恒判成不在跑），而 chip
// 的三个宿主里看板行手上连 engineRoute 都没有。判据：整份 chips（剥注释后）零活性标识符。
for (const pattern of [/liveTail/, /isLive/, /streaming/, /resumable/, /'running'/]) {
  ok(!pattern.test(chipsCode), `N4c chips 剥注释后零出现 ${pattern.source} —— 那句说明不接任何活性判断`);
}
// 文案两个意思一个都不能少（§11.16.5 裁决：①下一回合生效 ②不打断）。只钉这两个语义锚，
// 措辞随便润色 —— 钉整句就会被一次合法润色打红。
ok(/下一回合/.test(String(zh['stewardShell.chips.switchTakesEffect']))
  && /打断/.test(String(zh['stewardShell.chips.switchTakesEffect']))
  && /next turn/i.test(String(en['stewardShell.chips.switchTakesEffect']))
  && /interrupt/i.test(String(en['stewardShell.chips.switchTakesEffect'])),
  `N4d 中英都说清两件事：下一回合生效 ＋ 不打断正在跑的回合（中「${zh['stewardShell.chips.switchTakesEffect']}」）`);

// ─── N5 117x-M2 模型选择器（27 号文 §11.17）：两条设计红线 ──────────────────────────
// 「界面里能画成什么样」由 dev-harness/unit/steward-model-menu.test.js 用假 DOM 驱动真工厂逐条钉
// （折叠不是隐藏／搜索命中折叠区／常用的三条裁剪／副行没有用量就不出）。本段只钉那份单测【看不见】
// 的两件事：裁剪归谁做，以及界面绝不许说出口的那几类事实。
ok(chipsMod.STEWARD_MODEL_RECENT_DAYS === 30
  && chipsMod.STEWARD_MODEL_RECENT_MAX === 5
  && chipsMod.STEWARD_MODEL_SEARCH_MIN === 8,
  `N5a 「最近 30 天／最多 5 条／候选 > 8 才出搜索框」三条裁剪都是【前端这一处】的导出常量 —— M1 交付记录写明 byModel 全量返回、后端不切片（实测 ${chipsMod.STEWARD_MODEL_RECENT_DAYS}／${chipsMod.STEWARD_MODEL_RECENT_MAX}／${chipsMod.STEWARD_MODEL_SEARCH_MIN}）`);
// 红线二的静态一半：那张「按名字猜的」子串表【只被用来打标，不被用来筛】。判据是调用点数量 ——
// 全文件恰好一处 looksNonTextModel(，就在算 row.nonText 的地方；多出来的第二处必然是拿它去过滤。
ok(count(chipsCode, /looksNonTextModel\(/g) === 2
  && /nonText: looksNonTextModel\(id\),/.test(chipsCode)
  && /body\.hidden = !model\.fold\.open;/.test(chipsCode),
  `N5b 子串表只用来【打标 + 折叠】：定义一处、调用一处（实测 ${count(chipsCode, /looksNonTextModel\(/g)} 处含定义），收起来靠的是 body.hidden 而不是把行删掉`);
// 红线一：没握着的一个字都不许出现。能力矩阵是 provider 级的（provider-settings.js:842 的
// provider.vision / provider.reasoning），不是模型级 —— 给某个模型标「支持视觉／支持工具调用」是编；
// 上下文窗口、价格、速度同理，我们手里根本没有这些数。判据：整份 chips 剥注释后零出现这些字眼。
for (const pattern of [/\.vision\b/, /\.reasoning\b/, /contextWindow/i, /maxTokens/i, /pricing/i, /pricePer/i, /tokensPerSecond/i]) {
  ok(!pattern.test(chipsCode), `N5c chips 剥注释后零出现 ${pattern.source} —— 界面只说我们真握着的事实`);
}
ok(/Array\.isArray\(data\.byModel\)/.test(chipsCode) && /data\.byModel : \[\]/.test(chipsCode)
  && count(chipsCode, /api\('\/api\/usage/g) === 1
  && /'\/api\/usage\/summary\?range=all'/.test(chipsCode),
  `N5d 「常用」的唯一数据源是账本的 byModel（M1 那个维度），读它时自防「键可能不在」（usage-dashboard.js:80 同一写法）；全文件恰好一处 GET（实测 ${count(chipsCode, /api\('\/api\/usage/g)} 处），且拉的是 range=all —— 端点只有 today／week／month／all 四档，month 是【本自然月】，用它的话月初会把上个月用过的全判成没用过`);

console.log(`\nSTEWARD DRAWER STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
