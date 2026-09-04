'use strict';

// 118d: 常驻帮助入口 + 「真动作」出口。
//
// 为什么存在:118a-fix 把手册搬进了应用内,但入口只有向导完成页一个 -- 走完引导就再也找不到手册,
// 管理员手册连 UI 都没有。本模块把四件事聚合成一个常驻菜单:使用手册 / 管理员手册 / 重新打开引导 /
// 看日志与打开数据目录。
//
// UX 红线(用户 2026-09-03 拍板):不做「给用户一个路径或命令,让他自己去别处打开」的交互。
// 所以这里每一项都是【真动作】:
//   · 手册 -> 应用内阅读器(openHelpDoc);
//   · 打开目录 -> POST /api/open-path {target},由服务端把资源管理器开出来,界面上一个路径都不印;
//   · 看日志 -> GET /api/logs/tail,等宽只读面板直接显示内容(远程/无图形外壳也能用)。
// 「复制全部」复制的是【日志内容】(给支持人员发问题报告),不是路径 : 复制内容是正常功能,
// 复制路径再让用户自己去找才是反模式。
//
// 纪律:零 import(壳无关工厂,环境依赖全注入),零 innerHTML(DOM 走注入的 el() + textContent)。

// 服务端 OPEN_PATH_TARGETS 的前端镜像。前端只发这四个枚举 key,拼路径这件事只发生在服务端常量里。
export const HELP_OPEN_TARGETS = Object.freeze(['data', 'logs', 'workspace', 'manuals']);

// 日志面板行数:与服务端 LOG_TAIL_MAX_LINES / LOG_TAIL_DEFAULT_LINES 同值。
export const LOG_TAIL_MAX_LINES = 2000;
export const LOG_TAIL_DEFAULT_LINES = 200;
export const LOG_TAIL_LINE_CHOICES = Object.freeze([100, 500, 2000]);

// 上下文帮助:设置各页签 -> 手册小节。值是【文案键】而不是写死的标题字符串,中英各自对应本语言的
// `##` 标题(与 118b 的 health.anchor.* 同一口径);静态锁会拿这些文案去两份手册里逐字比对,
// 手册改了标题而这里没跟着改,门就红 -- 免得「?」静默退化成滚到文首。
export const SETTINGS_TAB_HELP_ANCHORS = Object.freeze({
  basic: 'help.anchor.settings',
  claude: 'help.anchor.settings',
  providers: 'help.anchor.settings',
  network: 'help.anchor.settings',
  agents: 'help.anchor.power',
  integrations: 'help.anchor.faq',
  mcp: 'help.anchor.faq',
  doctor: 'help.anchor.faq',
  advanced: 'help.anchor.faq',
  update: 'help.anchor.faq',
});

// 页签 -> 锚点文案键。不认识的页签回落到「设置指南」那一节(设置弹层里最通用的一节)。
export function helpAnchorKeyForTab(tab) {
  const name = String(tab || '');
  return Object.prototype.hasOwnProperty.call(SETTINGS_TAB_HELP_ANCHORS, name)
    ? SETTINGS_TAB_HELP_ANCHORS[name] : 'help.anchor.settings';
}

// 日志请求的唯一构造点(纯函数,可单测)。行数在前端先夹一次,服务端还会再夹一次。
export function logTailRequestPath(lines) {
  const asked = Number.parseInt(lines, 10);
  const clamped = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), LOG_TAIL_MAX_LINES) : LOG_TAIL_DEFAULT_LINES;
  return '/api/logs/tail?lines=' + clamped;
}

// 错误标签提取。00-boot 的 normalizeApiErrorPayload 会把服务端写的 {ok:false,error:'logs.none'}
// 改写成 {error:{code:'api.request_failed',params:{},message:'logs.none'}} 再上线,所以判定分支必须
// 两种形状都认 -- 只比字符串会让降级分支恒不命中,把 [object Object] 印到用户面前。
export function helpErrorTag(res) {
  const raw = res && res.error;
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  return String(raw.message || raw.code || '');
}

// 打开目录请求的唯一构造点。枚举外的 target 直接返回空串 -- 连请求都不发,前端这一层先挡一道。
export function openPathRequestBody(target, sessionId) {
  const name = String(target || '');
  if (!HELP_OPEN_TARGETS.includes(name)) return '';
  const id = String(sessionId || '');
  return JSON.stringify(id ? { target: name, sessionId: id } : { target: name });
}

export function createHelpMenuDomain({
  api = async () => ({}),
  el = tag => ({ tag }),
  t = key => key,
  toast = () => {},
  apiErrText = error => String((error && error.message) || error || ''),
  buildModal = () => null,
  popover = () => null,
  openHelpDoc = () => null,
  openOnboarding = () => null,
  currentSessionId = () => '',
  clipboard = () => (globalThis.navigator && globalThis.navigator.clipboard) || null,
} = {}) {

  // 真动作:让服务端把资源管理器开出来。失败一律给人话,绝不退化成「路径是 X,你自己去开」。
  async function openWorkbenchFolder(target) {
    const body = openPathRequestBody(target, target === 'workspace' ? currentSessionId() : '');
    if (!body) { toast(t('help.open.unknownTarget'), 'err'); return false; }
    let res = null;
    try { res = await api('/api/open-path', { method: 'POST', body }); }
    catch (error) { toast(t('help.open.failed', { reason: apiErrText(error) }), 'err'); return false; }
    if (!res || res.ok !== true) {
      toast(t('help.open.failed', { reason: helpErrorText(res) }), 'err');
      return false;
    }
    toast(t('help.open.ok'), 'ok');
    return true;
  }

  // 结构化信封(apiFailure)与老式 {ok:false,error:'串'} 两种都要能取出一句人话。
  // 注意:00-boot 的 normalizeApiErrorPayload 会把后者改写成前者再上线,所以【只认字符串是不行的】。
  function helpErrorText(res) {
    const tag = helpErrorTag(res);
    return tag || t('common.unknownError');
  }

  // 应用内日志面板。等宽只读,不可编辑;两个动作:「复制全部」(复制内容发问题报告)与「打开日志目录」。
  function openLogPanel() {
    const body = el('div', 'help-logs-body');
    const head = el('div', 'help-logs-head');
    const fileLabel = el('span', 'help-logs-file muted', '');
    const linesLabel = el('label', 'help-logs-lines-label', t('help.logs.lines'));
    const select = el('select', 'help-logs-lines');
    for (const n of LOG_TAIL_LINE_CHOICES) {
      const opt = el('option', '', String(n));
      opt.value = String(n);
      if (n === LOG_TAIL_LINE_CHOICES[0]) opt.selected = true;
      select.append(opt);
    }
    linesLabel.append(select);
    head.append(fileLabel, linesLabel);
    body.append(head);
    body.append(el('p', 'help-logs-hint muted', t('help.logs.hint')));
    const pre = el('pre', 'help-logs-pre');
    pre.setAttribute('tabindex', '0');
    pre.setAttribute('aria-label', t('help.logs.title'));
    body.append(pre);

    const foot = el('div', 'confirm-foot help-logs-foot');
    const copyBtn = el('button', 'btn btn-sm', t('help.logs.copyAll'));
    copyBtn.type = 'button';
    const openDirBtn = el('button', 'btn btn-sm', t('help.menu.openLogsDir'));
    openDirBtn.type = 'button';
    const refreshBtn = el('button', 'btn btn-sm', t('common.refresh'));
    refreshBtn.type = 'button';
    const done = el('button', 'primary', t('common.close'));
    done.type = 'button';
    foot.append(copyBtn, openDirBtn, refreshBtn, done);

    let text = '';
    async function load() {
      pre.textContent = t('help.logs.loading');
      let res = null;
      try { res = await api(logTailRequestPath(select.value)); }
      catch (error) { text = ''; pre.textContent = t('help.logs.loadFailed', { reason: apiErrText(error) }); fileLabel.textContent = ''; return; }
      if (!res || res.ok !== true) {
        text = '';
        fileLabel.textContent = '';
        const tag = helpErrorTag(res);
        pre.textContent = tag === 'logs.none' ? t('help.logs.none')
          : tag === 'logs.read_failed' ? t('help.logs.readFailed')
            : t('help.logs.loadFailed', { reason: helpErrorText(res) });
        return;
      }
      const lines = Array.isArray(res.lines) ? res.lines : [];
      text = lines.join('\n');
      // 只印文件名,不印目录 : 用户看得出这是哪天的日志,界面上却没有任何「照着去找」的路径。
      fileLabel.textContent = t('help.logs.fileLabel', { file: String(res.file || ''), count: lines.length });
      pre.textContent = lines.length ? text : t('help.logs.empty');
    }

    select.onchange = () => { load(); };
    refreshBtn.onclick = () => { load(); };
    copyBtn.onclick = async () => {
      const board = clipboard();
      if (!board || typeof board.writeText !== 'function' || !text) { toast(t('toast.copyFail'), 'err'); return; }
      try { await board.writeText(text); toast(t('toast.copied'), 'ok'); }
      catch { toast(t('toast.copyFail'), 'err'); }
    };
    openDirBtn.onclick = () => { openWorkbenchFolder('logs'); };

    const modal = buildModal(t('help.logs.title'), body, foot);
    // 实底 + 更宽的面板:buildModal 造的是 .modal.small 玻璃档,密排等宽日志在玻璃上读不下去。
    try { modal.backdrop.querySelector('.modal').classList.add('help-logs-modal'); } catch { /* 无 DOM 时跳过 */ }
    if (done && modal) done.onclick = () => modal.close();
    load();
    return modal;
  }

  // 菜单项定义(纯数据,便于静态锁逐项核对)。每一项都带一个真动作。
  function helpMenuItems() {
    return [
      { id: 'user-guide', label: t('help.menu.userGuide'), run: () => openHelpDoc({ docId: 'user-guide' }) },
      { id: 'admin-guide', label: t('help.menu.adminGuide'), run: () => openHelpDoc({ docId: 'admin-guide' }) },
      { id: 'reopen-wizard', label: t('onboarding.wizard.reopen'), run: () => openOnboarding() },
      { id: 'view-logs', label: t('help.menu.viewLogs'), run: () => openLogPanel() },
      { id: 'open-data-dir', label: t('help.menu.openDataDir'), run: () => openWorkbenchFolder('data') },
    ];
  }

  // 常驻入口:侧栏「帮助」按钮的弹层菜单。与顶栏「更多」菜单同一 popover 原语与 role 口径。
  function openHelpMenu(anchor) {
    if (!anchor) return null;
    return popover(anchor, close => {
      const menu = el('div', 'more-menu help-menu');
      menu.setAttribute('role', 'menu');
      menu.append(el('div', 'help-menu-title muted', t('help.menu.title')));
      for (const entry of helpMenuItems()) {
        const b = el('button', 'mm-item help-menu-item', entry.label);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.dataset.helpItem = entry.id;
        b.onclick = () => { close(); try { entry.run(); } catch { /* 单项失败不拖垮菜单 */ } };
        menu.append(b);
      }
      return menu;
    });
  }

  // 上下文帮助:设置弹层的「?」。按当前页签打开手册对应小节,锚点取自 SETTINGS_TAB_HELP_ANCHORS。
  function openSettingsTabHelp(tab) {
    return openHelpDoc({ docId: 'user-guide', anchor: t(helpAnchorKeyForTab(tab)) });
  }

  return Object.freeze({
    helpMenuItems,
    openHelpMenu,
    openLogPanel,
    openSettingsTabHelp,
    openWorkbenchFolder,
  });
}
