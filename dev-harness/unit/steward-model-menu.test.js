#!/usr/bin/env node
'use strict';
// Unit: 117x-M2 —— 模型选择器（27 号文 §11.17）。用户原话「这个模型选择做的也很一般」：
// 真机是一个 30 余项的扁平裸列表，无搜索、无分组，直接印原始 id，还混着 audio-realtime／image／
// ocr／livetranslate 这些与文本任务无关的端点。
//
// 这一份钉的是【事实】，不是某一行的写法：
//   ① 「看起来不是文本模型」是【折叠】不是【隐藏】—— 收起来时那些行仍在 DOM 里、点了照样能选；
//   ①b 已经在「常用」里露过面的那一行，折叠区【不重复印第二份】，折叠标题的计数也不算它
//      （§11.17.8 裁决：常用赢，按 (provider, model) 去重）；
//   ② 搜索能命中折叠区里的项（并把折叠区自动展开）—— 不许有「看不见也摸不着」的东西；
//   ③ 「常用」没有用量时【整段不出现】，有用量时按最近一次使用倒序、最多 5 条、只收最近 30 天；
//   ④ 副行没有用量就【不出】（不显示「0 回合」——那是把「不知道」说成「零」）；
//   ⑤ 那张 id 子串表全仓【只有一处】定义。
// 为了让①②④这种「DOM 里在不在」的事实真被走到，本文件用一个极小的假 DOM 驱动【真的】工厂
// （createQuickSwitchChips → toggleMenu → buildModelMenu），不是去读源码字符串。
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_JS = path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'js');
const CHIPS = path.join(PUBLIC_JS, 'steward-chips.js');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));

let fail = 0;
const ok = (cond, label) => { if (cond) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };

// ── 极小假 DOM：只实现 steward-chips.js 真的用到的那几件事 ──────────────────────────
function makeNode(document, tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    attrs: {},
    hidden: false,
    disabled: false,
    text: '',
    classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    append(...kids) { for (const kid of kids) node.appendChild(kid); },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) { node.attrs[String(name)] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, String(name)) ? node.attrs[String(name)] : null; },
    addEventListener() {},
    contains(other) { return other === node || node.children.some(child => child.contains(other)); },
    focus() { document.activeElement = node; },
    click() { if (typeof node.onclick === 'function') node.onclick(); },
  };
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
  Object.defineProperty(node, 'textContent', {
    get: () => (node.children.length ? node.children.map(child => child.textContent).join('') : node.text),
    set: value => { node.text = String(value); node.children.length = 0; },
  });
  return node;
}
function makeDocument() {
  // 32 号文 §4（M1-b）：快切菜单的开合改走 js/popover.js（两壳共用的浮层原语），于是这条路也用到了
  // document/window 的事件注册（开时挂 keydown／mousedown／resize／scroll，关时逐条摘掉）。假 DOM 把
  // 这两个口子补齐 —— 补的是 mock 自己的契约，不是让产品代码为测试让路（真机浏览器里它们一直都在）。
  const listeners = new Set();
  const document = {
    activeElement: null,
    getElementById: () => null,
    addEventListener: (type, handler) => { listeners.add(handler); },
    removeEventListener: (type, handler) => { listeners.delete(handler); },
  };
  document.createElement = tag => makeNode(document, tag);
  return document;
}
// 树里所有满足条件的节点（不用选择器：假 DOM 不该假装自己有选择器引擎）。
function walk(node, hit, out = []) {
  for (const child of node.children || []) {
    if (hit(child)) out.push(child);
    walk(child, hit, out);
  }
  return out;
}
const byClass = name => node => String(node.className || '').split(' ').includes(name);
const modelRows = menu => walk(menu, node => node.dataset && typeof node.dataset.modelId === 'string');
const groupTitles = menu => walk(menu, byClass('steward-chip-group')).map(node => node.textContent);
const rowOf = (menu, id) => modelRows(menu).find(node => node.dataset.modelId === id) || null;
// 折叠区那一份【自己的】行：文本模型最近用过时会在「常用」与「全部模型」里各出现一份（那是同一个
// id 的两条路，不是两个东西），所以问「折叠区里的那一条看不看得见」必须问折叠区自己那一份。
// （非文本模型进了「常用」之后折叠区就不再有它了 —— §11.17.8 的去重裁决，见 ①b。）
const foldToggle = menu => walk(menu, node => node.dataset && node.dataset.chipFold === 'nonText')[0] || null;
const foldCount = menu => { const node = foldToggle(menu); return node ? (walk(node, byClass('steward-chip-fold-count'))[0] || {}).textContent : null; };
const foldBody = menu => walk(menu, byClass('steward-chip-fold-body'))[0] || null;
const foldRowOf = (menu, id) => {
  const body = foldBody(menu);
  return body ? (modelRows(body).find(node => node.dataset.modelId === id) || null) : null;
};
// 「常用」段＝第一个组标题之后、下一个组标题之前的那些模型行。
const recentIds = menu => {
  const list = walk(menu, byClass('steward-chip-list'))[0];
  const out = [];
  let inRecent = false;
  for (const node of (list ? list.children : [])) {
    if (byClass('steward-chip-group')(node)) { inRecent = node.textContent === zh['stewardShell.chips.groupRecent']; continue; }
    if (inRecent && node.dataset && typeof node.dataset.modelId === 'string') out.push(node.dataset.modelId);
  }
  return out;
};
const hintOf = row => walk(row, byClass('steward-chip-option-hint'))[0] || null;
// 一行是不是【此刻真看得见】：本身没 hidden，且没有一个祖先 hidden（折叠区收起来就是靠这个）。
function visible(node) {
  for (let at = node; at; at = at.parentNode) if (at.hidden) return false;
  return true;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = days => new Date(NOW - days * DAY).toISOString();

// 一个真机形状的候选表：11 项，其中 4 项按名字看不像文本模型。
const MODELS = [
  { id: 'gpt-x-pro' },
  { id: 'gpt-x-mini' },
  { id: 'gpt-x-nano' },
  { id: 'deepthink-r2' },
  { id: 'qwen3.5-max' },
  { id: 'kimi-k3-256k' },
  { id: 'glm-5-air' },
  { id: 'omni-audio-preview' },
  { id: 'qwen3.5-livetranslate-flash-realtime-2026-05-19' },
  { id: 'seedream-image-4' },
  { id: 'bge-rerank-v3' },
];
const NON_TEXT = ['omni-audio-preview', 'qwen3.5-livetranslate-flash-realtime-2026-05-19', 'seedream-image-4', 'bge-rerank-v3'];
// 这四个里只有 omni-audio-preview 在下面那份用量里有账（2 天前）→ 它进「常用」，于是折叠区里
// 【不再有它】（§11.17.8 裁决：常用赢，折叠区按 (provider, model) 去重）。折叠区因此是三条：
// 那三个没账的。谁在折叠区不是抄一份常量，而是从「有没有账」这件事实推出来的。
const NON_TEXT_USED = ['omni-audio-preview'];
const FOLDED = NON_TEXT.filter(id => !NON_TEXT_USED.includes(id));
// 用量：6 条落在 30 天内（要验「最多 5 条」与「按最近一次使用倒序」）、1 条在窗口外、1 条没有 ts。
const USAGE = [
  { model: 'gpt-x-mini', provider: 'p1', engine: 'openai', turns: 3, lastAt: ago(3) },
  { model: 'gpt-x-pro', provider: 'p1', engine: 'openai', turns: 12, lastAt: ago(1) },
  { model: 'deepthink-r2', provider: 'p1', engine: 'openai', turns: 7, lastAt: ago(5) },
  { model: 'qwen3.5-max', provider: 'p1', engine: 'openai', turns: 2, lastAt: ago(9) },
  { model: 'kimi-k3-256k', provider: 'p1', engine: 'openai', turns: 1, lastAt: ago(12) },
  { model: 'omni-audio-preview', provider: 'p1', engine: 'openai', turns: 4, lastAt: ago(2) },
  { model: 'glm-5-air', provider: 'p1', engine: 'openai', turns: 9, lastAt: ago(400) },
  { model: 'gpt-x-nano', provider: 'p1', engine: 'openai', turns: 6, lastAt: '' },
];

const fill = (text, params) => {
  let out = String(text);
  for (const [name, value] of Object.entries(params || {})) out = out.split('{{' + name + '}}').join(String(value));
  return out;
};

// 每个场景都 import 一份【新的】模块实例：用量缓存是模块级的（三个宿主共用一份），
// 不隔离的话「没有用量」那一档会读到上一个场景拉回来的数据。
async function scenario({ tag, usage = USAGE, models = MODELS, sessionModel = 'gpt-x-pro', compact = false }) {
  const document = makeDocument();
  globalThis.document = document;
  // popover 还往 window 上挂 resize／scroll（layer 模式下那两个是空转，但「注册」这件事真发生）。
  globalThis.window = document;
  const mod = await import(url.pathToFileURL(CHIPS).href + '?case=' + encodeURIComponent(tag));
  const missingKeys = [];
  const t = (key, params) => {
    if (typeof zh[key] !== 'string') { missingKeys.push(key); return key; }
    return fill(zh[key], params);
  };
  const calls = [];
  const api = async (route, init) => {
    calls.push({ route, init });
    if (route.startsWith('/api/usage/summary')) return { ok: true, byModel: usage };
    return { ok: true, session: { id: 's1', engineRoute: JSON.parse((init && init.body) || '{}').engineRoute } };
  };
  const state = {
    config: {
      activeProvider: 'p1',
      providers: [{ id: 'p1', label: '厂商甲', model: 'gpt-x-mini', models }],
    },
  };
  const chips = mod.createQuickSwitchChips({ api, t, state, compact });
  const host = makeNode(document, 'div');
  chips.mount(host);
  chips.setSession({ id: 's1', engineRoute: { engine: 'openai', providerId: 'p1', model: sessionModel } });
  const chipButton = walk(host, node => node.dataset && node.dataset.chip === 'model')[0];
  chipButton.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  const menu = walk(host, node => node.dataset && node.dataset.kind === 'model')[0];
  const search = walk(menu, node => node.dataset && node.dataset.chipSearch === 'model')[0] || null;
  const type = value => { search.value = value; search.oninput(); };
  return { mod, document, chips, menu, search, type, calls, missingKeys, host };
}

(async () => {
  // ── ① 折叠，不是过滤 ────────────────────────────────────────────────────────────
  {
    const s = await scenario({ tag: 'fold' });
    const body = foldBody(s.menu);
    const folded = body ? modelRows(body).map(node => node.dataset.modelId) : [];
    ok(JSON.stringify(folded.slice().sort()) === JSON.stringify(FOLDED.slice().sort()),
      `① 收起来的时候，那三个【没账的】「看起来不是文本模型」的端点仍在 DOM 里（实测 ${JSON.stringify(folded)}）`);
    // 「看不见」必须连「这一行还在不在」一起问：行被删掉时它当然也看不见，那是【过滤】，正是这条锁要挡的。
    ok(FOLDED.every(id => { const row = foldRowOf(s.menu, id); return Boolean(row) && visible(row) === false; }),
      '① 但它们此刻【看不见】—— 折叠区默认收起（body.hidden），这才叫折叠而不是照单全列');
    const toggle = foldToggle(s.menu);
    ok(Boolean(toggle) && toggle.textContent.includes('可能猜错') && toggle.getAttribute('aria-expanded') === 'false',
      `① 折叠区标题明写「按名字猜的，可能猜错」（实测「${toggle && toggle.textContent}」）`);
    if (toggle) toggle.click();
    ok(Boolean(toggle)
      && FOLDED.every(id => { const row = foldRowOf(s.menu, id); return Boolean(row) && visible(row) === true; })
      && foldToggle(s.menu).getAttribute('aria-expanded') === 'true',
      '① 一键展开：展开后那三条全部可见，aria-expanded 跟着翻面');
    // 可选性没被改变：点折叠区里的那一行，PATCH 就该带着它的 id 出去（点完菜单会收起来，
    // 所以这一条放在本段最后）。
    const pick = foldRowOf(s.menu, 'seedream-image-4');
    if (pick) pick.click();
    const patched = s.calls.filter(call => call.init && call.init.method === 'PATCH').pop();
    ok(Boolean(patched) && JSON.parse(patched.init.body).engineRoute.model === 'seedream-image-4',
      `① 折叠区里的模型点了照样能选（实测 PATCH ${patched && patched.init.body}）`);
    ok(s.missingKeys.length === 0, `i18n 这张菜单用到的键【逐个】在 zh-CN 里解析得出（缺 ${JSON.stringify(s.missingKeys)}）`);
  }

  // ── ①b 折叠区不重复印「常用」里已经有的那一行（§11.17.8 裁决：「常用」赢） ───────────
  // 用过的非文本模型（omni-audio-preview，2 天前）该在「常用」段【不折叠地】印一行；折叠区
  // 不许再印第二份，折叠标题的「× N」也不许把它算上 —— 同一屏印两次是重复不是强调，去重之后
  // 那个数才是「还没露面的有 N 个」。
  {
    const s = await scenario({ tag: 'dedupe' });
    const used = NON_TEXT_USED[0];
    const printed = modelRows(s.menu).map(node => node.dataset.modelId).filter(id => id === used);
    ok(printed.length === 1, `①b 最近用过的那个非文本 id 整张菜单里【只印一行】（实测 ${printed.length} 行）`);
    ok(recentIds(s.menu).includes(used) && foldRowOf(s.menu, used) === null,
      `①b 那一行在「常用」段里，折叠区里没有它（实测 常用 ${JSON.stringify(recentIds(s.menu))}）`);
    ok(foldCount(s.menu) === String(FOLDED.length),
      `①b 折叠标题的计数是【去重之后】的 ${FOLDED.length}，不含已经在「常用」露过面的那一个（实测 × ${foldCount(s.menu)}）`);
    // 搜索时同一条判据成立：过滤之后「常用」里还有的，折叠区照样不重复一份。
    s.type('audio');
    const hits = modelRows(s.menu).map(node => node.dataset.modelId).filter(id => id === used);
    ok(hits.length === 1 && recentIds(s.menu).includes(used) && foldToggle(s.menu) === null,
      `①b 搜「audio」时也不重复：命中的那一行只印一次、就在「常用」里；折叠区一条不剩于是整块不摆（实测 ${hits.length} 行／折叠区在场=${Boolean(foldToggle(s.menu))}）`);
    s.type('');
    // 反向对照：去重去掉的只是【已经露过面的那一行】，不是把非文本全放行。
    const never = FOLDED[0];
    ok(Boolean(foldRowOf(s.menu, never)) && !recentIds(s.menu).includes(never),
      `①b 对照：同一夹具里没账的「${never}」照旧只在折叠区（它没在别处露过面，就该留在折叠区）`);
  }

  // ── ② 搜索命中折叠区里的项 ──────────────────────────────────────────────────────
  {
    const s = await scenario({ tag: 'search' });
    ok(Boolean(s.search), '② 候选 11 项（> 8）→ 搜索框出现');
    s.type('realtime');
    const hitId = 'qwen3.5-livetranslate-flash-realtime-2026-05-19';
    const hit = rowOf(s.menu, hitId);
    ok(Boolean(hit) && visible(hit) === true,
      '② 搜「realtime」命中的是折叠区里的那一项，且它【当场看得见】（折叠区自动展开，不是命中了却还藏着）');
    ok(walk(hit, byClass('steward-chip-hit')).map(node => node.textContent).join('') === 'realtime',
      '② 命中段被高亮，且高亮的就是匹配的那一段（主行仍是完整的真 id，没被改写）');
    ok(hit.textContent.includes(hitId), '② 主行印的是原样 id（不改写、不美化成别的名字）');
    ok(modelRows(s.menu).filter(node => node.dataset.modelId).map(node => node.dataset.modelId)
      .every(id => id === hitId || id === ''),
      '② 不匹配的行退场（跟随全局那一条恒在，它不是模型行）');
    s.type('');
    ok(modelRows(s.menu).length > 5, '② 清空搜索之后全部候选回来（过滤是画面，不是删数据）');
    const small = await scenario({ tag: 'small', models: MODELS.slice(0, 4) });
    ok(small.search === null, '② 候选只有 4 项（不足 8）→ 不出搜索框（少的时候多一个框是噪音）');
  }

  // ── ③ 常用：没有用量整段不出现；有用量最多 5 条、按最近一次使用倒序、只收 30 天内 ────
  {
    const empty = await scenario({ tag: 'recent-empty', usage: [] });
    ok(!groupTitles(empty.menu).includes(zh['stewardShell.chips.groupRecent']),
      `③ 一条用量都没有 → 「常用」整段不出现（实测组标题 ${JSON.stringify(groupTitles(empty.menu))}）`);
    const s = await scenario({ tag: 'recent' });
    const titles = groupTitles(s.menu);
    ok(titles[0] === zh['stewardShell.chips.groupRecent'],
      `③ 有用量 → 「常用」在第一段（实测 ${JSON.stringify(titles)}）`);
    const recent = recentIds(s.menu);
    ok(recent.length === 5, `③ 最多 5 条（实测 ${recent.length}：${JSON.stringify(recent)}）`);
    ok(JSON.stringify(recent) === JSON.stringify(['gpt-x-pro', 'omni-audio-preview', 'gpt-x-mini', 'deepthink-r2', 'qwen3.5-max']),
      `③ 按【最近一次使用】倒序，不是按回合数（实测 ${JSON.stringify(recent)}）`);
    ok(!recent.includes('gpt-x-nano'), '③ lastAt 是空串（该组没有可解析的 ts）的那一条不进「常用」—— 我们不知道它上次是什么时候，就不能说它「最近用过」');
    ok(recent.includes('omni-audio-preview') && foldRowOf(s.menu, 'omni-audio-preview') === null,
      '③ 「看起来不是文本」的模型只要真的最近用过就进「常用」，并且【只在那里】出现一次（折叠区不再重复一份，见 ①b）');
    // 30 天那道窗口要单独一个夹具才证得伪：上面那份里出窗口的 glm-5-air 排在最后，就算窗口
    // 放宽到十年，它也被「最多 5 条」挡在外面 —— 那条断言恒真，等于没验（写这份锁时踩过一次）。
    // 这一份只放三条用量、两条在窗口内，窗口一放宽第三条立刻现身。
    const window = await scenario({
      tag: 'recent-window',
      usage: [
        { model: 'gpt-x-pro', turns: 1, lastAt: ago(2) },
        { model: 'gpt-x-mini', turns: 1, lastAt: ago(29) },
        { model: 'deepthink-r2', turns: 1, lastAt: ago(31) },
      ],
    });
    ok(JSON.stringify(recentIds(window.menu)) === JSON.stringify(['gpt-x-pro', 'gpt-x-mini']),
      `③ 窗口就是最近 30 天：29 天前用过的进得来，31 天前的进不来（实测 ${JSON.stringify(recentIds(window.menu))}）`);
  }

  // ── ④ 副行：没有用量就不出，不许说「0 回合」 ───────────────────────────────────
  {
    const s = await scenario({ tag: 'subline' });
    const never = rowOf(s.menu, 'kimi-k3-256k');
    const unused = rowOf(s.menu, 'bge-rerank-v3');
    ok(hintOf(unused) === null, '④ 从没用过的模型【没有副行】（不是印一句「共 0 回合」）');
    ok(!unused.textContent.includes('0'), `④ 那一行里连个「0」都不该出现（实测「${unused.textContent}」）`);
    ok(Boolean(hintOf(never)) && hintOf(never).textContent === fill(zh['stewardShell.chips.usageLine'], { when: fill(zh['stewardShell.chips.usedDaysAgo'], { days: 12 }), turns: 1 }),
      `④ 真有用量的那一行副行只说我们真知道的两件事：上次用 · N 天前 · 共 M 回合（实测「${hintOf(never) && hintOf(never).textContent}」）`);
    const noTs = rowOf(s.menu, 'gpt-x-nano');
    ok(Boolean(hintOf(noTs)) && hintOf(noTs).textContent === fill(zh['stewardShell.chips.usageTurns'], { turns: 6 }),
      `④ lastAt 为空串那一档：只报回合数、不报「几天前」（实测「${hintOf(noTs) && hintOf(noTs).textContent}」）`);
    // 界面里不许出现我们没握着的事实（§11.17.1）。
    const menuText = s.menu.textContent;
    ok(!/(上下文|context window|\$|￥|tokens\/s|支持工具|支持视觉|vision)/i.test(menuText),
      '④ 整张菜单里没有上下文窗口／价格／速度／per-model 能力这些我们【没握着】的话');
  }

  // ── ⑤ 跟随全局、默认徽标、键盘 ─────────────────────────────────────────────────
  {
    const s = await scenario({ tag: 'follow' });
    const list = walk(s.menu, byClass('steward-chip-list'))[0];
    const first = list.children[0];
    ok(first.dataset.modelFollow === '1' && first.textContent.includes(zh['stewardShell.chips.followGlobal']),
      '⑤ 「跟随全局」永远是第一项');
    first.click();
    const patched = s.calls.filter(call => call.init && call.init.method === 'PATCH').pop();
    ok(JSON.parse(patched.init.body).engineRoute.model === '',
      `⑤ 点它＝把这条线程的会话级模型清空（回落全局那一份，语义与权限那一枚同一条；实测 ${patched.init.body}）`);
    const s2 = await scenario({ tag: 'badge' });
    const badge = walk(rowOf(s2.menu, 'gpt-x-mini'), byClass('steward-chip-badge'))[0] || null;
    ok(Boolean(badge) && badge.textContent === zh['stewardShell.chips.modelDefault'],
      '⑤ 全局默认那一项（provider.model = gpt-x-mini）挂一枚「默认」徽标');
    // 同一个 id 会同时出现在「常用」与「全部模型」两段（同一个东西的两条路），所以徽标数＝
    // 那个 id 画出来的行数；要钉的事实是「除了全局默认那个 id，谁都没有徽标」。
    const badged = modelRows(s2.menu).filter(node => walk(node, byClass('steward-chip-badge')).length > 0)
      .map(node => node.dataset.modelId);
    ok(badged.length > 0 && badged.every(id => id === 'gpt-x-mini'),
      `⑤ 只有全局默认那个 id 带徽标（实测带徽标的行 ${JSON.stringify(badged)}）`);
    ok(rowOf(s2.menu, 'gpt-x-pro').getAttribute('aria-checked') === 'true'
      && rowOf(s2.menu, 'gpt-x-mini').getAttribute('aria-checked') === 'false',
      '⑤ 当前项是 aria-checked 的那一个（这条会话定的是 gpt-x-pro，不是全局默认）');
    // 键盘：↑↓ 只在【看得见的】项之间走，Enter 从搜索框选第一条。
    s2.document.activeElement = s2.search;
    const key = name => s2.menu.onkeydown({ key: name, preventDefault: () => {} });
    key('ArrowDown');
    ok(s2.document.activeElement === walk(s2.menu, byClass('steward-chip-list'))[0].children[0],
      '⑤ ↓ 从搜索框跳到第一项');
    key('ArrowDown');
    key('ArrowUp');
    ok(s2.document.activeElement === walk(s2.menu, byClass('steward-chip-list'))[0].children[0],
      '⑤ ↓↑ 一来一回回到原处');
    ok(s2.mod.stewardVisibleOptions(s2.menu).every(node => visible(node)),
      '⑤ 键盘能走到的项恒是【看得见的】那些：折叠着的行不在这份名单里（它们仍在 DOM 里、仍可点、仍被搜索命中）');
    s2.document.activeElement = s2.search;
    const before = s2.calls.length;
    key('Enter');
    ok(s2.calls.length === before + 1 && s2.calls[s2.calls.length - 1].init.method === 'PATCH',
      '⑤ 焦点还在搜索框时按 Enter＝选中第一条');
  }

  // ── ⑤b 紧凑模式（看板行）：引擎那一段还在最前，模型这一半跟着一起变好了 ──────────
  {
    const s = await scenario({ tag: 'compact', compact: true });
    const titles = groupTitles(s.menu);
    ok(titles[0] === zh['stewardShell.chips.engine'] && titles[1] === zh['stewardShell.chips.model'],
      `⑤b 看板行仍然把引擎收进模型菜单的第一段（实测组标题 ${JSON.stringify(titles)}）`);
    ok(walk(s.menu, node => node.dataset && typeof node.dataset.engineKey === 'string').length > 0,
      '⑤b 引擎那一段真的画出来了（同一份 engineOptions，不是第二套判据）');
    ok(Boolean(s.search) && Boolean(foldBody(s.menu)) && titles.includes(zh['stewardShell.chips.groupRecent']),
      '⑤b 搜索框／折叠区／常用在紧凑模式下同样在场 —— 一处实现，三个面同时到位');
    const list = walk(s.menu, byClass('steward-chip-list'))[0];
    ok(Boolean(list) && list.children[0].dataset.modelFollow === '1',
      '⑤b 模型那一半的第一项仍是「跟随全局」（引擎段在它之前，两段各归各的）');
  }

  // ── ⑥ 子串表只有一处 ───────────────────────────────────────────────────────────
  {
    const mod = await import(url.pathToFileURL(CHIPS).href + '?case=table');
    ok(JSON.stringify(mod.STEWARD_NON_TEXT_MODEL_HINTS)
      === JSON.stringify(['audio', 'realtime', 'image', 'ocr', 'tts', 'embed', 'rerank', 'livetranslate', 'video']),
      '⑥ 子串表就是设计页 §11.17.3 那九个，且是导出的冻结常量');
    ok(Object.isFrozen(mod.STEWARD_NON_TEXT_MODEL_HINTS), '⑥ 冻结（改它得改这一处，不能就地长出第二份）');
    const owners = fs.readdirSync(PUBLIC_JS)
      .filter(name => name.endsWith('.js'))
      .filter(name => fs.readFileSync(path.join(PUBLIC_JS, name), 'utf8').includes("'livetranslate'"));
    ok(owners.length === 1 && owners[0] === 'steward-chips.js',
      `⑥ 整个 public/js 里这张表只有一处，且就在 steward-chips.js（实测 ${JSON.stringify(owners)}）`);
    const source = fs.readFileSync(CHIPS, 'utf8');
    ok(source.split("'livetranslate'").length - 1 === 1,
      `⑥ 连本文件里也只出现一次（实测 ${source.split("'livetranslate'").length - 1} 次）—— 第二份表就是从「再抄一遍」开始的`);
    ok(mod.looksNonTextModel('qwen3.5-livetranslate-flash-realtime-2026-05-19') === true
      && mod.looksNonTextModel('GPT-X-AUDIO') === true
      && mod.looksNonTextModel('gpt-x-pro') === false
      && mod.looksNonTextModel('') === false && mod.looksNonTextModel(null) === false,
      '⑥ 判据不分大小写、空值不误判');
  }

  console.log('');
  if (fail) { console.log(`STEWARD MODEL MENU UNIT: ${fail} FAILURE(S)`); process.exit(1); }
  console.log('STEWARD MODEL MENU UNIT: ALL PASS');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
