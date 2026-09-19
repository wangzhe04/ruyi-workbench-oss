#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128d(48 号文 §1;47 号文 G3「无 axe-core 类自动审计」):不下载 axe-core,用浏览器【自己算的】无障碍树
// (CDP Accessibility.getFullAXTree —— 读屏软件拿到的就是这棵树)加几条纯 DOM 规则,做一台小审计器。
//
// 规则(每条都对应 axe 的一条同名规则,判据取它的核心):
//   A1 可操作的节点都有名字:role 是 button／link／textbox／combobox／checkbox／radio／switch／slider／spinbutton／
//      searchbox／menuitem*／tab／listbox／img 的非忽略节点,浏览器算出的 accessible name 不许为空
//      (axe: button-name、link-name、label、select-name、aria-command-name、aria-input-field-name、role-img-alt);
//   A2 没有重复 id(duplicate-id-aria —— 重复的 id 让 aria-labelledby／label[for] 指错人);
//   A3 aria-labelledby／aria-describedby／aria-controls／aria-owns／aria-activedescendant／label[for] 指向的 id 都存在;
//   A4 role 取值合法(aria-roles);
//   A5 没有 tabindex > 0(tabindex —— 打乱 Tab 序);
//   A6 没有嵌套的可操作元素(nested-interactive:按钮里套按钮／链接);
//   A7 aria-hidden="true" 的子树里没有可聚焦元素(aria-hidden-focus —— 读屏看不见、键盘却走得到)。
// 场景:管家视角、工作台视角、设置弹窗打开;专家档与简易档(出厂默认)各一遍。
// 判定行:`A11Y LINT BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const NAMED_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider',
  'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'listbox', 'img', 'treeitem']);

const DOM_RULES = `(() => {
  const VALID_ROLES = new Set(['alert','alertdialog','application','article','banner','blockquote','button','caption','cell','checkbox','code','columnheader','combobox','complementary','contentinfo','definition','deletion','dialog','directory','document','emphasis','feed','figure','form','generic','grid','gridcell','group','heading','img','insertion','link','list','listbox','listitem','log','main','marquee','math','menu','menubar','menuitem','menuitemcheckbox','menuitemradio','meter','navigation','none','note','option','paragraph','presentation','progressbar','radio','radiogroup','region','row','rowgroup','rowheader','scrollbar','search','searchbox','separator','slider','spinbutton','status','strong','subscript','superscript','switch','tab','table','tablist','tabpanel','term','textbox','time','timer','toolbar','tooltip','tree','treegrid','treeitem']);
  const desc = n => (n.id ? '#' + n.id : n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/)[0] : ''));
  const out = { dupIds: [], brokenRefs: [], badRoles: [], posTabindex: [], nested: [], hiddenFocus: [] };
  const ids = new Map();
  for (const n of document.querySelectorAll('[id]')) ids.set(n.id, (ids.get(n.id) || 0) + 1);
  for (const [id, c] of ids) if (c > 1 && id) out.dupIds.push(id + '×' + c);
  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant']) {
    for (const n of document.querySelectorAll('[' + attr + ']')) {
      for (const ref of String(n.getAttribute(attr) || '').split(/\\s+/).filter(Boolean)) {
        if (!document.getElementById(ref)) out.brokenRefs.push(desc(n) + ' ' + attr + '=' + ref);
      }
    }
  }
  for (const n of document.querySelectorAll('label[for]')) if (!document.getElementById(n.htmlFor)) out.brokenRefs.push('label[for=' + n.htmlFor + ']');
  for (const n of document.querySelectorAll('[role]')) {
    const roles = String(n.getAttribute('role') || '').trim().split(/\\s+/).filter(Boolean);
    if (!roles.length || !VALID_ROLES.has(roles[0])) out.badRoles.push(desc(n) + ' role=' + n.getAttribute('role'));
  }
  for (const n of document.querySelectorAll('[tabindex]')) if (Number(n.getAttribute('tabindex')) > 0) out.posTabindex.push(desc(n));
  const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], [role="switch"]';
  for (const n of document.querySelectorAll('button, a[href], [role="button"], [role="link"]')) {
    const inner = n.querySelector(INTERACTIVE);
    if (inner) out.nested.push(desc(n) + ' ⊃ ' + desc(inner));
  }
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  for (const h of document.querySelectorAll('[aria-hidden="true"]')) {
    for (const f of [h, ...h.querySelectorAll(FOCUSABLE)]) {
      if (!f.matches(FOCUSABLE)) continue;
      if (f.offsetParent === null && getComputedStyle(f).position !== 'fixed') continue;   // 真的不显示 → 键盘也走不到
      if (f.closest('[inert]')) continue;
      out.hiddenFocus.push(desc(h) + ' ∋ ' + desc(f));
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
  return out;
})()`;

async function unnamedInteractive(fx) {
  await fx.cdp.send('DOM.getDocument', { depth: -1 });
  const { nodes } = await fx.cdp.send('Accessibility.getFullAXTree');
  const bad = [];
  for (const node of nodes || []) {
    if (node.ignored) continue;
    const role = node.role && node.role.value;
    if (!NAMED_ROLES.has(role)) continue;
    const name = String((node.name && node.name.value) || '').trim();
    if (name) continue;
    let where = role;
    if (node.backendDOMNodeId) {
      try {
        const { object } = await fx.cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
        const r = await fx.cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId, returnByValue: true,
          functionDeclaration: `function () { const n = this.nodeType === 1 ? this : this.parentElement; if (!n) return '';
            if (n.offsetParent === null && getComputedStyle(n).position !== 'fixed') return '';   // 画面上不显示的(浏览器仍算进树)不计
            return (n.id ? '#' + n.id : n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')); }`,
        });
        if (!r.result || !r.result.value) continue;
        where = role + ' ' + r.result.value;
      } catch { /* 节点已被重画掉 */ continue; }
    }
    bad.push(where);
  }
  return [...new Set(bad)];
}

async function audit(fx, scene) {
  const unnamed = await unnamedInteractive(fx);
  const dom = await fx.evaluate(DOM_RULES);
  const show = list => list.length ? ':' + list.slice(0, 10).join('、') + (list.length > 10 ? ` 等 ${list.length} 处` : '') : '';
  ok(unnamed.length === 0, `A1 ${scene}:可操作节点都有名字(无名 ${unnamed.length}${show(unnamed)})`);
  ok(dom.dupIds.length === 0, `A2 ${scene}:没有重复 id(${dom.dupIds.length}${show(dom.dupIds)})`);
  ok(dom.brokenRefs.length === 0, `A3 ${scene}:id 引用都指得到人(断 ${dom.brokenRefs.length}${show(dom.brokenRefs)})`);
  ok(dom.badRoles.length === 0, `A4 ${scene}:role 取值合法(${dom.badRoles.length}${show(dom.badRoles)})`);
  ok(dom.posTabindex.length === 0, `A5 ${scene}:没有 tabindex>0(${dom.posTabindex.length}${show(dom.posTabindex)})`);
  ok(dom.nested.length === 0, `A6 ${scene}:没有嵌套的可操作元素(${dom.nested.length}${show(dom.nested)})`);
  ok(dom.hiddenFocus.length === 0, `A7 ${scene}:aria-hidden 子树里没有可聚焦元素(${dom.hiddenFocus.length}${show(dom.hiddenFocus)})`);
}

// 尺子自检:每一跑先往页面上【种】七条已知违规(每条规则一条),审计器必须逐条认出来,再拔掉、审真页面。
// 首跑全绿的审计器可能只是瞎的 —— 本仓「零命中 = 全绿」的假绿出过不止一次,这一步让它每跑都证明自己看得见。
const PLANT = `(() => {
  const box = document.createElement('div');
  box.id = 'a11yLintPlant';
  box.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#fff;color:#000;padding:4px';
  box.innerHTML = '<button id="plantNoName" type="button"></button>'
    + '<span id="plantDup">a</span><span id="plantDup">b</span>'
    + '<span id="plantRef" aria-labelledby="plantMissingRef">c</span>'
    + '<span id="plantRole" role="buton">d</span>'
    + '<span id="plantTab" tabindex="3">e</span>'
    + '<button id="plantNest" type="button">f<a href="#g">g</a></button>'
    + '<div id="plantHidden" aria-hidden="true"><button type="button">h</button></div>';
  document.body.appendChild(box);
  return true;
})()`;
async function selfTest(fx) {
  await fx.evaluate(PLANT);
  await sleep(100);
  const unnamed = await unnamedInteractive(fx);
  const dom = await fx.evaluate(DOM_RULES);
  await fx.evaluate(`(() => { document.getElementById('a11yLintPlant').remove(); return true; })()`);
  const seen = {
    A1: unnamed.some(s => s.includes('#plantNoName')),
    A2: dom.dupIds.some(s => s.startsWith('plantDup')),
    A3: dom.brokenRefs.some(s => s.includes('plantMissingRef')),
    A4: dom.badRoles.some(s => s.includes('#plantRole')),
    A5: dom.posTabindex.some(s => s.includes('#plantTab')),
    A6: dom.nested.some(s => s.includes('#plantNest')),
    A7: dom.hiddenFocus.some(s => s.includes('#plantHidden')),
  };
  const blind = Object.entries(seen).filter(([, v]) => !v).map(([k]) => k);
  ok(blind.length === 0, `A0 尺子自检:种下的七条违规逐条被认出(没认出的规则 ${blind.length ? blind.join(' ') : '无'})`);
}

async function scenes(fx, mode) {
  await fx.cdp.send('Accessibility.enable');
  await selfTest(fx);
  ok(Boolean(await fx.setLens('steward')), `A0 ${mode}:管家视角`);
  await sleep(400);
  await audit(fx, `${mode}·管家视角`);
  ok(Boolean(await fx.setLens('classic')), `A0 ${mode}:工作台视角`);
  await sleep(400);
  await audit(fx, `${mode}·工作台视角`);
  await fx.evaluate(`(() => { document.getElementById('appGearBtn').click(); document.getElementById('openSettingsBtn').click(); return true; })()`);
  ok(Boolean(await fx.waitForEval(`(() => !document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 100)), `A0 ${mode}:设置弹窗打开`);
  await sleep(300);
  await audit(fx, `${mode}·设置弹窗`);
}

(async () => {
  for (const mode of ['pro', 'simple']) {
    let fx = null;
    try {
      fx = await startBrowserFixture({
        ok,
        prefix: 'ruyi-a11y-lint-',
        width: 1440,
        height: 900,
        config: { uiMode: mode === 'pro' ? 'pro' : undefined },
        prepare: async f => {
          const created = await f.request('POST', '/api/sessions', { title: '审计那条线程', cwd: f.work });
          const sid = created && created.json && created.json.session && created.json.session.id;
          if (sid) await f.request('POST', '/api/chat/stream', { sessionId: sid, message: '一句', cwd: f.work }, 120000);
        },
      });
      await scenes(fx, mode === 'pro' ? '专家档' : '简易档');
    } catch (error) {
      fail += 1;
      console.log('FAIL 未捕获异常:' + (error && error.stack || error));
    } finally {
      if (fx) await fx.close({ keepRoot: fail > 0 });
    }
  }
  console.log(fail === 0 ? 'A11Y LINT BROWSER E2E: ALL PASS' : `A11Y LINT BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
