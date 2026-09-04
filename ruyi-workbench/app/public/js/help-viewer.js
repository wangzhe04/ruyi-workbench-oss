'use strict';

// 118a-fix: 应用内手册阅读器。
//
// 为什么存在:118a 的向导完成页只给了一行相对路径 docs/manuals/USER-GUIDE_CN.md 加一个「复制路径」按钮,
// 等于告诉用户「自己去文件管理器里找」。产品口径是每件事都要能在如意里做完 : 所以手册在应用内读:
// GET /api/help/doc?id=&lang= 取 markdown 原文,这里用注入的既有渲染管线(marked + sanitizeNode 白名单)
// 落 DOM,右侧正文 + 左侧 ## 目录跳转 + 中英切换。全程没有任何「路径 / 复制 / 自己去打开」的出口。
//
// 纪律:零 import(壳无关工厂,每个环境依赖都注入),零 HTML 字符串注入(DOM 走 el() 与注入的 renderMarkdownInto,
// 后者是 chat-render-primitives 里那一份唯一的、已消毒的 markdown 写入口,本模块不另造解析/写入路径)。

// 源码写死的文档枚举。与服务端 13-http-router.js 的 HELP_DOC_FILES 同名同键;前端只发 id/lang,
// 拼路径这件事只发生在服务端的常量查表里。
export const HELP_DOC_IDS = Object.freeze(['user-guide', 'admin-guide']);
export const HELP_LOCALES = Object.freeze(['zh-CN', 'en-US']);

// 取文请求的唯一构造点(纯函数,可单测)。非白名单 id 直接返回空串,连请求都不发。
export function helpDocRequestPath(docId, lang) {
  const id = String(docId || '');
  if (!HELP_DOC_IDS.includes(id)) return '';
  const wanted = String(lang || '');
  const query = '?id=' + encodeURIComponent(id) + (HELP_LOCALES.includes(wanted) ? '&lang=' + encodeURIComponent(wanted) : '');
  return '/api/help/doc' + query;
}

// 标题 -> 锚点 id。sanitizeNode 的属性白名单只留 class/alt/title/href/src,渲染出来的 h2 不带 id,
// 所以锚点由这里在渲染后统一补写;目录按钮与 openHelpViewer({anchor}) 共用同一套 id 推导。
export function helpAnchorId(text, index) {
  const slug = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, '-')
    .replace(/[^0-9a-z一-鿿-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return 'help-sec-' + (Number.isInteger(index) ? index : 0) + (slug ? '-' + slug : '');
}

// 手册之间的互相引用写的是磁盘文件名。这张表把它们翻译成应用内的 {id, lang},
// 与服务端 HELP_DOC_FILES 一一对应(那边 id+lang -> 文件名,这边文件名 -> id+lang)。
const MANUAL_FILE_TO_DOC = Object.freeze({
  'USER-GUIDE_CN.md': Object.freeze({ id: 'user-guide', lang: 'zh-CN' }),
  'USER-GUIDE_EN.md': Object.freeze({ id: 'user-guide', lang: 'en-US' }),
  'ADMIN-GUIDE_CN.md': Object.freeze({ id: 'admin-guide', lang: 'zh-CN' }),
  'ADMIN-GUIDE_EN.md': Object.freeze({ id: 'admin-guide', lang: 'en-US' }),
});

// href(可能带 ./ ../ 前缀与 #锚点/?查询)-> 应用内文档引用;不是手册就是 null。
export function helpDocRefFor(href) {
  const bare = String(href || '').split('#')[0].split('?')[0];
  const file = bare.split('/').pop();
  return Object.prototype.hasOwnProperty.call(MANUAL_FILE_TO_DOC, file) ? MANUAL_FILE_TO_DOC[file] : null;
}

// 是否是「离开本站」的绝对链接(留给浏览器新标签页开)。判不出来就当同源,按保守路径处理。
export function isCrossOriginHref(href, base) {
  const raw = String(href || '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false; // 相对/片段链接
  try {
    const here = String(base || (globalThis.location && globalThis.location.href) || 'http://127.0.0.1/');
    const url = new URL(raw, here);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return false;
    if (url.protocol === 'mailto:') return true;
    return url.origin !== new URL(here).origin;
  } catch { return false; }
}

function asArray(value) { return Array.isArray(value) ? value : []; }

// 118b: 全应用共用的阅读器实例登记处。
//
// 体检行的「怎么办」也要能打开手册,但设置域(provider-settings.js)不是组合根,拿不到 markdown 渲染
// 原语(那两个函数由 app.js 注入给经典壳)。与其把新依赖塞进组合根(app.js 的 D45 行数护栏只剩 1 行余量),
// 经典壳建好唯一实例后把它登记在这里,其余领域只调 openSharedHelpDoc() -- 仍然只有一个实例、一条渲染
// 管线,组合根一行不加。没有登记(例如预览壳单独跑)时返回 null,调用方按「没有这个入口」处理。
let sharedHelpViewer = null;
export function registerHelpViewer(instance) { sharedHelpViewer = instance || null; return instance; }
export function openSharedHelpDoc(options) {
  return sharedHelpViewer && typeof sharedHelpViewer.openHelpViewer === 'function'
    ? sharedHelpViewer.openHelpViewer(options)
    : null;
}
export function hasSharedHelpViewer() { return Boolean(sharedHelpViewer); }

export function createHelpViewerDomain({
  api = async () => ({}),
  el = tag => ({ tag }),
  t = key => key,
  toast = () => {},
  apiErrText = error => String((error && error.message) || error || ''),
  getLocale = () => 'zh-CN',
  renderMarkdownInto = container => container,
  highlightIn = () => {},
  doc = globalThis.document,
} = {}) {
  let openBackdrop = null;

  function focusableIn(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const selector = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    try { return [...root.querySelectorAll(selector)]; } catch { return []; }
  }

  function buildFrame() {
    const backdrop = el('div', 'modal-backdrop dynamic help-viewer-backdrop');
    const trigger = doc && doc.activeElement;
    let closed = false;
    let detachEsc = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      if (openBackdrop === backdrop) openBackdrop = null;
      try { detachEsc(); } catch { /* already detached */ }
      try { backdrop.remove(); } catch { /* already detached */ }
      if (trigger && typeof trigger.focus === 'function') { try { trigger.focus(); } catch { /* ignore */ } }
    };
    // 阅读器可以叠在向导之上。app.js 的全局 Esc 处理器挂在 window 冒泡相位(最后触发)并对【每一个】
    // 打开的 backdrop 调 __cancel : 直接沿用就会让 Esc 连带把底下的向导当「以后再说」关掉。
    // 叠层对话框的正确语义是 Esc 只关最上面这一层,所以在 document 捕获相位先截住并停止冒泡。
    if (doc && typeof doc.addEventListener === 'function') {
      const onKeydown = e => {
        if (!e || e.key !== 'Escape' || closed) return;
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.preventDefault === 'function') e.preventDefault();
        finish();
      };
      doc.addEventListener('keydown', onKeydown, true);
      detachEsc = () => { if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKeydown, true); };
    }
    backdrop.__cancel = finish;
    backdrop.__close = finish;

    const modal = el('div', 'modal help-viewer');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', t('help.doc.title'));

    const head = el('div', 'modal-head help-viewer-head');
    const title = el('h3', 'help-viewer-title', t('help.doc.title'));
    const langs = el('div', 'help-viewer-langs');
    langs.setAttribute('role', 'group');
    langs.setAttribute('aria-label', t('help.doc.langLabel'));
    const closeBtn = el('button', 'icon-btn help-viewer-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('common.close'));
    closeBtn.onclick = finish;
    head.append(title, langs, closeBtn);

    const body = el('div', 'modal-body help-viewer-body');
    const toc = el('nav', 'help-viewer-toc');
    toc.setAttribute('aria-label', t('help.doc.toc'));
    const article = el('article', 'help-viewer-doc markdown-body');
    article.setAttribute('tabindex', '0');
    body.append(toc, article);

    const status = el('div', 'help-viewer-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    modal.append(head, body, status);
    backdrop.appendChild(modal);
    if (typeof backdrop.addEventListener === 'function') {
      backdrop.addEventListener('mousedown', e => { if (e && e.target === backdrop) finish(); });
      // 焦点陷阱:与向导/interaction-prompts 同一实现口径。
      backdrop.addEventListener('keydown', e => {
        if (!e || e.key !== 'Tab') return;
        const nodes = focusableIn(modal).filter(n => n && n.offsetParent !== null);
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = doc && doc.activeElement;
        const inside = typeof modal.contains === 'function' ? modal.contains(active) : true;
        if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); if (typeof last.focus === 'function') last.focus(); }
        else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); if (typeof first.focus === 'function') first.focus(); }
      });
    }
    if (doc && doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(backdrop);
    return { backdrop, modal, title, langs, toc, article, status, close: finish };
  }

  function setStatus(frame, message, tone) {
    frame.status.className = 'help-viewer-status' + (tone ? ' ' + tone : '');
    frame.status.textContent = message || '';
  }

  function scrollToNode(node) {
    if (!node) return;
    if (typeof node.scrollIntoView === 'function') { try { node.scrollIntoView({ block: 'start' }); } catch { node.scrollIntoView(); } }
  }

  // 渲染后补锚点 + 建目录。目录条目是真 <button>(键盘可达),点击滚到对应小节 : 全程停留在应用内,
  // 不生成任何指向磁盘或外部的链接。
  function buildToc(frame, anchor) {
    frame.toc.replaceChildren();
    let headings = [];
    try { headings = [...frame.article.querySelectorAll('h2')]; } catch { headings = []; }
    if (!headings.length) {
      frame.toc.append(el('p', 'help-viewer-toc-empty muted', t('help.doc.tocEmpty')));
      return;
    }
    frame.toc.append(el('div', 'help-viewer-toc-title', t('help.doc.toc')));
    const list = el('ul', 'help-viewer-toc-list');
    let target = null;
    headings.forEach((heading, index) => {
      const label = String(heading.textContent || '').trim();
      const id = helpAnchorId(label, index);
      heading.id = id;
      const item = el('li', 'help-viewer-toc-item');
      const jump = el('button', 'help-viewer-toc-link', label);
      jump.type = 'button';
      jump.onclick = () => scrollToNode(heading);
      item.append(jump);
      list.append(item);
      if (anchor && (id === anchor || label === anchor)) target = heading;
    });
    frame.toc.append(list);
    if (target) scrollToNode(target);
  }

  function buildLangToggle(frame, available, current, onPick) {
    frame.langs.replaceChildren();
    const options = asArray(available).filter(code => HELP_LOCALES.includes(code));
    if (options.length < 2) return; // 只有一种语言就不显示切换器(空控件比没有更糟)
    for (const code of options) {
      const active = code === current;
      const btn = el('button', 'btn btn-sm help-viewer-lang' + (active ? ' active' : ''), t('help.doc.lang.' + code));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.onclick = () => { if (!active) onPick(code); };
      frame.langs.append(btn);
    }
  }

  // 手册文件不在这台机器上(精简包不带 docs/)。这是唯一的降级分支,它给的仍然是【应用内】的下一步:
  // 直接在对话里问,而不是「去某个路径把文件打开」。
  function renderMissing(frame) {
    frame.article.replaceChildren();
    const block = el('div', 'help-viewer-missing');
    block.append(el('h4', 'help-viewer-missing-title', t('help.doc.missingTitle')));
    block.append(el('p', 'help-viewer-missing-body', t('help.doc.missingBody')));
    frame.article.append(block);
    frame.toc.replaceChildren();
    setStatus(frame, '', '');
  }

  // 正文里的相对链接收口。手册互相引用写的是磁盘文件名(USER-GUIDE_EN.md、../../../SECURITY.md),
  // 原样留着就是死链:点一下整页离开如意去 404,正好是本波要消灭的那类出口。规则:
  //   · 指向白名单手册的 -> 换成应用内切换按钮(原地换 docId/lang 重载);
  //   · 其他同源/相对链接 -> 摘掉 href 只留文字(不给死链,也不把人带出应用);
  //   · 跨站 http(s) -> 不动(renderMarkdownInto 里的 prepareExternalLinks 已加 target=_blank rel=noopener)。
  function tameDocLinks(frame, reopen) {
    let anchors = [];
    try { anchors = [...frame.article.querySelectorAll('a')]; } catch { anchors = []; }
    for (const link of anchors) {
      const href = String((typeof link.getAttribute === 'function' && link.getAttribute('href')) || '');
      if (!href) continue;
      if (isCrossOriginHref(href)) continue;
      const ref = helpDocRefFor(href);
      const replacement = ref
        ? el('button', 'help-viewer-doclink', String(link.textContent || ''))
        : el('span', 'help-viewer-deadlink', String(link.textContent || ''));
      if (ref) { replacement.type = 'button'; replacement.onclick = () => reopen(ref.id, ref.lang); }
      if (link.parentNode && typeof link.parentNode.insertBefore === 'function') {
        link.parentNode.insertBefore(replacement, link);
        link.remove();
      }
    }
  }

  async function load(frame, docId, lang, anchor) {
    const url = helpDocRequestPath(docId, lang);
    if (!url) { setStatus(frame, t('help.doc.unknown'), 'err'); return; }
    setStatus(frame, t('help.doc.loading'), '');
    frame.toc.replaceChildren();
    frame.article.replaceChildren(el('p', 'muted', t('help.doc.loading')));
    let res = null;
    try {
      res = await api(url);
    } catch (error) {
      frame.article.replaceChildren();
      setStatus(frame, t('help.doc.loadFailed', { reason: apiErrText(error) }), 'err');
      return;
    }
    if (!res || res.ok !== true) {
      if (res && res.error === 'help.doc_missing') { renderMissing(frame); return; }
      frame.article.replaceChildren();
      setStatus(frame, t('help.doc.loadFailed', { reason: String((res && res.error) || '') }), 'err');
      return;
    }
    frame.title.textContent = String(res.title || t('help.doc.title'));
    frame.article.replaceChildren();
    // 唯一的 markdown 落 DOM 入口:注入的 renderMarkdownInto 已做 marked 解析 + sanitizeNode 白名单消毒。
    renderMarkdownInto(frame.article, String(res.markdown || ''));
    try { highlightIn(frame.article); } catch { /* 高亮失败不影响正文可读 */ }
    tameDocLinks(frame, (nextId, nextLang) => { load(frame, nextId, nextLang, ''); });
    buildToc(frame, anchor);
    buildLangToggle(frame, res.available, res.lang, next => { load(frame, docId, next, ''); });
    setStatus(frame, res.truncated ? t('help.doc.truncated') : '', res.truncated ? 'warn' : '');
    // 焦点落在正文上(键盘可以直接翻页),但 preventScroll:窄屏是单栏块流,带滚动的聚焦会把上方的
    // 目录顶出可视区,一打开就看不见跳转清单。
    if (typeof frame.article.focus === 'function') { try { frame.article.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  // 唯一入口。docId 必须是白名单枚举;anchor 可选,给「跳到某节」用。
  function openHelpViewer(options = {}) {
    const docId = String((options && options.docId) || 'user-guide');
    if (!HELP_DOC_IDS.includes(docId)) { toast(t('help.doc.unknown'), 'warn'); return null; }
    if (openBackdrop) return openBackdrop; // 不叠两层阅读器
    const frame = buildFrame();
    openBackdrop = frame.backdrop;
    const locale = String(getLocale() || '');
    const lang = HELP_LOCALES.includes(locale) ? locale : '';
    load(frame, docId, lang, String((options && options.anchor) || ''));
    return frame.backdrop;
  }

  function closeHelpViewer() {
    if (openBackdrop && typeof openBackdrop.__close === 'function') openBackdrop.__close();
  }

  return Object.freeze({ HELP_DOC_IDS, HELP_LOCALES, openHelpViewer, closeHelpViewer });
}
