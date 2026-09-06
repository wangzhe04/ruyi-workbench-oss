'use strict';

// 第117波 117d：快切 chip（权限／模型／引擎）。
//
// §8.6「每条线程一个『权限』chip，在看板行、抽屉、2.0 视窗顶栏三处是【同一控件】」——所以它住在
// 自己的模块里，而不是抽屉里：117d 抽屉、117g 的 2.0 顶栏、117h 的看板行各自 mount 一份实例，
// 读同一份数据、走同一条 PATCH，改哪里都是改会话本身（没有第二套状态）。
//
// 边界：
//   · 本模块是【唯一】改线程 permissionMode / engineRoute 的地方（抽屉不自己实现 PATCH）；
//   · 零 innerHTML（全部 createElement + textContent）；零 setInterval / setTimeout —— chip 不轮询，
//     数据由宿主（抽屉的刷新循环）用 setSession() 喂进来；
//   · 切「全自动」必须先出二次确认（§8.6 五条人话），确认后才带 confirm:true 发出；服务端
//     （13d PATCH /api/sessions/:id）还有同一道门，UI 弹没弹过窗它不信。
//   · 模型／引擎的候选来源【复用经典壳那一份】：Claude 侧是 state.status.models，provider 侧是
//     state.config.providers[].models（navigation-controls.js 的模型菜单读的就是这两处），不另写一份。

export const STEWARD_PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto']);
// 与 01-config 的 PERMISSION_MODES_REQUIRING_CONFIRM 同口径：只有全自动需要二次确认。
export const STEWARD_PERMISSION_CONFIRM_MODES = Object.freeze(['auto']);
// §8.6 那条弹窗必须逐条写明的五件事（键名即顺序，测试按这个顺序核对）。
export const STEWARD_CONFIRM_KEYS = Object.freeze([
  'stewardShell.permission.confirm1',
  'stewardShell.permission.confirm2',
  'stewardShell.permission.confirm3',
  'stewardShell.permission.confirm4',
  'stewardShell.permission.confirm5',
]);
// Agent CLI 的品牌名（不是文案，两个语言下逐字相同），与 navigation-controls.js 的同名表同源。
const AGENT_CLI_LABELS = Object.freeze({ claude: 'Claude Code', kimi: 'Kimi Code' });

export function permissionLabelKey(mode) {
  return STEWARD_PERMISSION_MODES.includes(mode) ? `stewardShell.permission.${mode}.label` : '';
}
export function permissionHintKey(mode) {
  return STEWARD_PERMISSION_MODES.includes(mode) ? `stewardShell.permission.${mode}.hint` : '';
}

// 会话的生效引擎路由：会话级 engineRoute 优先，否则回落全局（与 02-session-store 的
// sessionEngineRouteFromConfig 同一判据；chip 只做展示，不落盘这个回落值）。
export function resolveEngineRoute(session, config) {
  const raw = session && session.engineRoute;
  if (raw && raw.engine === 'openai' && raw.providerId) {
    return { engine: 'openai', providerId: String(raw.providerId), model: String(raw.model || '') };
  }
  if (raw && (raw.engine === 'agent' || raw.engine === 'claude')) {
    return { engine: 'agent', agentCliType: raw.agentCliType === 'kimi' ? 'kimi' : 'claude', model: String(raw.model || '') };
  }
  const cfg = config && typeof config === 'object' ? config : {};
  const providerId = String(cfg.activeProvider || '').trim();
  if (providerId && providerId !== 'claude-cli') {
    const provider = (cfg.providers || []).find(item => item && item.id === providerId) || null;
    return { engine: 'openai', providerId, model: String((provider && provider.model) || '') };
  }
  return { engine: 'agent', agentCliType: cfg.agentCliType === 'kimi' ? 'kimi' : 'claude', model: String(cfg.model || '') };
}

export function createQuickSwitchChips({
  api = async () => null,
  t = key => key,
  state = null,
  onChanged = () => {},
} = {}) {
  const doc = () => globalThis.document || null;
  let sessionId = '';
  let session = null;
  let host = null;
  let openMenu = null;                 // 同一时刻只允许一个 chip 菜单展开
  const chips = new Map();             // kind -> { button, value, menu }

  function el(tag, className, text) {
    const node = doc().createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function config() { return (state && state.config) || {}; }

  function closeMenu() {
    if (!openMenu) return;
    openMenu.hidden = true;
    while (openMenu.firstChild) openMenu.removeChild(openMenu.firstChild);
    const owner = chips.get(openMenu.dataset.kind);
    if (owner) owner.button.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }

  function note(text) {
    const target = doc() && doc().getElementById('stewardDrawerNote');
    if (target) target.textContent = String(text || '');
  }

  // ── 唯一的写口：PATCH /api/sessions/:id ────────────────────────────────────────
  // 权限档与引擎路由是【同一个端点、同一种形状】（13d 的 updateSessionMeta 一起处理），所以这里
  // 只有一个函数；抽屉与 117g/117h 都不许自己再写一条。
  async function patchSession(patch) {
    if (!sessionId) return null;
    try {
      const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (!response || response.ok !== true) {
        note(t('stewardShell.chips.changeFailed', { error: String((response && response.error) || 'failed') }));
        return null;
      }
      session = response.session || session;
      render();
      note(t('stewardShell.chips.changed'));
      try { onChanged(session); } catch { /* 宿主刷新失败不该把 chip 打回旧值 */ }
      return session;
    } catch (error) {
      note(t('stewardShell.chips.changeFailed', { error: String((error && error.message) || error) }));
      return null;
    }
  }

  // ── 权限菜单（四档人话 + 全自动二次确认） ────────────────────────────────────
  function buildPermissionMenu(menu) {
    const current = session && session.permissionMode ? String(session.permissionMode) : '';
    for (const mode of STEWARD_PERMISSION_MODES) {
      const option = el('button', 'steward-chip-option');
      option.type = 'button';
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', current === mode ? 'true' : 'false');
      option.dataset.permissionMode = mode;
      option.append(
        el('span', 'steward-chip-option-label', t(permissionLabelKey(mode))),
        el('span', 'steward-chip-option-hint', t(permissionHintKey(mode))),
      );
      option.onclick = () => {
        if (STEWARD_PERMISSION_CONFIRM_MODES.includes(mode)) { showAutoConfirm(menu, mode); return; }
        closeMenu();
        patchSession({ permissionMode: mode });
      };
      menu.appendChild(option);
    }
    // 清除会话级设置 → 回落全局默认（null 是后端显式认可的合法值，不是「没改」）。
    const follow = el('button', 'steward-chip-option');
    follow.type = 'button';
    follow.setAttribute('role', 'menuitemradio');
    follow.setAttribute('aria-checked', current ? 'false' : 'true');
    follow.dataset.permissionMode = '';
    follow.appendChild(el('span', 'steward-chip-option-label', t('stewardShell.chips.followGlobal')));
    follow.onclick = () => { closeMenu(); patchSession({ permissionMode: null }); };
    menu.appendChild(follow);
  }

  // 二次确认就地展开在菜单里（不另起模态：抽屉本身已是 dialog，模态套模态会把焦点管理搞坏）。
  function showAutoConfirm(menu, mode) {
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    const box = el('div', 'steward-chip-confirm');
    box.appendChild(el('strong', '', t('stewardShell.permission.confirmTitle')));
    const list = el('ul');
    for (const key of STEWARD_CONFIRM_KEYS) list.appendChild(el('li', '', t(key)));
    box.appendChild(list);
    const actions = el('div', 'steward-chip-confirm-actions');
    const cancel = el('button', 'steward-drawer-btn', t('stewardShell.permission.confirmCancel'));
    cancel.type = 'button';
    cancel.dataset.confirm = 'cancel';
    cancel.onclick = () => closeMenu();
    const accept = el('button', 'steward-drawer-btn', t('stewardShell.permission.confirmOk'));
    accept.type = 'button';
    accept.dataset.confirm = 'ok';
    // 服务端要 confirm:true 才肯切（13d：否则 409 permission.confirm_required）。这是那道门的界面一半。
    accept.onclick = () => { closeMenu(); patchSession({ permissionMode: mode, confirm: true }); };
    actions.append(cancel, accept);
    box.appendChild(actions);
    menu.appendChild(box);
  }

  // ── 引擎菜单 ──────────────────────────────────────────────────────────────────
  function engineOptions() {
    const options = [
      { key: 'agent:claude', label: AGENT_CLI_LABELS.claude, route: { engine: 'agent', agentCliType: 'claude', model: '' } },
      { key: 'agent:kimi', label: AGENT_CLI_LABELS.kimi, route: { engine: 'agent', agentCliType: 'kimi', model: '' } },
    ];
    for (const provider of (config().providers || [])) {
      if (!provider || !provider.id) continue;
      options.push({
        key: 'openai:' + provider.id,
        label: String(provider.label || provider.id),
        route: { engine: 'openai', providerId: String(provider.id), model: String(provider.model || '') },
      });
    }
    return options;
  }

  function routeKey(route) {
    return route.engine === 'openai' ? 'openai:' + route.providerId : 'agent:' + route.agentCliType;
  }

  function buildEngineMenu(menu) {
    const current = routeKey(resolveEngineRoute(session, config()));
    for (const option of engineOptions()) {
      const row = el('button', 'steward-chip-option');
      row.type = 'button';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', current === option.key ? 'true' : 'false');
      row.dataset.engineKey = option.key;
      row.appendChild(el('span', 'steward-chip-option-label', option.label));
      row.onclick = () => { closeMenu(); patchSession({ engineRoute: option.route }); };
      menu.appendChild(row);
    }
  }

  // ── 模型菜单：候选由【当前引擎】决定，来源与经典壳模型菜单同一份数据 ──────────
  function modelOptions(route) {
    if (route.engine === 'openai') {
      const provider = (config().providers || []).find(item => item && item.id === route.providerId) || null;
      return (provider && Array.isArray(provider.models) ? provider.models : [])
        .map(model => ({ id: String(model && model.id || ''), label: String((model && (model.label || model.id)) || '') }))
        .filter(model => model.id);
    }
    const models = (state && state.status && Array.isArray(state.status.models)) ? state.status.models : [];
    return models
      .map(model => ({ id: String(model && model.id || ''), label: String((model && (model.label || model.id)) || t('stewardShell.chips.modelDefault')) }));
  }

  function buildModelMenu(menu) {
    const route = resolveEngineRoute(session, config());
    const options = modelOptions(route);
    if (!options.length) {
      menu.appendChild(el('p', 'steward-chip-option-hint', t('stewardShell.chips.noModels')));
      return;
    }
    for (const option of options) {
      const row = el('button', 'steward-chip-option');
      row.type = 'button';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(route.model || '') === option.id ? 'true' : 'false');
      row.dataset.modelId = option.id;
      row.appendChild(el('span', 'steward-chip-option-label', option.label || t('stewardShell.chips.modelDefault')));
      row.onclick = () => { closeMenu(); patchSession({ engineRoute: { ...route, model: option.id } }); };
      menu.appendChild(row);
    }
  }

  const BUILDERS = { permission: buildPermissionMenu, model: buildModelMenu, engine: buildEngineMenu };

  function toggleMenu(kind) {
    const chip = chips.get(kind);
    if (!chip) return;
    const wasOpen = openMenu === chip.menu;
    closeMenu();
    if (wasOpen || !sessionId) return;
    BUILDERS[kind](chip.menu);
    chip.menu.hidden = false;
    chip.button.setAttribute('aria-expanded', 'true');
    openMenu = chip.menu;
  }

  // chip 上显示的当前值：权限显示档位人话（未设会话级则「跟随全局」），模型／引擎显示生效值。
  function valueFor(kind) {
    if (kind === 'permission') {
      const mode = session && session.permissionMode ? String(session.permissionMode) : '';
      return mode && STEWARD_PERMISSION_MODES.includes(mode)
        ? t(permissionLabelKey(mode))
        : t('stewardShell.chips.followGlobal');
    }
    const route = resolveEngineRoute(session, config());
    if (kind === 'engine') {
      if (route.engine === 'openai') {
        const provider = (config().providers || []).find(item => item && item.id === route.providerId) || null;
        return String((provider && (provider.label || provider.id)) || route.providerId);
      }
      return AGENT_CLI_LABELS[route.agentCliType] || AGENT_CLI_LABELS.claude;
    }
    return route.model || t('stewardShell.chips.modelDefault');
  }

  function render() {
    for (const [kind, chip] of chips) {
      chip.value.textContent = valueFor(kind);
      chip.button.disabled = !sessionId;
      chip.button.classList.toggle('is-pinned', kind === 'permission' && Boolean(session && session.permissionMode));
    }
  }

  function buildChip(kind, labelKey) {
    const wrap = el('div', 'steward-chip-wrap');
    const button = el('button', 'steward-chip');
    button.type = 'button';
    button.dataset.chip = kind;
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    const value = el('span', 'steward-chip-value');
    button.append(el('span', 'steward-chip-key', t(labelKey)), value);
    button.onclick = () => toggleMenu(kind);
    const menu = el('div', 'steward-chip-menu');
    menu.setAttribute('role', 'menu');
    menu.dataset.kind = kind;
    menu.hidden = true;
    wrap.append(button, menu);
    chips.set(kind, { button, value, menu });
    return wrap;
  }

  function mount(container) {
    if (!container || !doc()) return null;
    host = container;
    chips.clear();
    while (host.firstChild) host.removeChild(host.firstChild);
    host.append(
      buildChip('permission', 'stewardShell.chips.permission'),
      buildChip('model', 'stewardShell.chips.model'),
      buildChip('engine', 'stewardShell.chips.engine'),
    );
    render();
    return host;
  }

  function setSession(next) {
    const nextId = String((next && next.id) || '');
    if (nextId !== sessionId) closeMenu();
    sessionId = nextId;
    session = next || null;
    render();
    return session;
  }

  return Object.freeze({
    mount,
    setSession,
    closeMenu,
    render,
    // 117g/117h 复用时按需读：当前会话与生效路由（只读快照，不给写口）。
    currentRoute: () => resolveEngineRoute(session, config()),
  });
}
