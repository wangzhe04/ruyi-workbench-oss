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

// ── 117j UX-F3/F4（§8.8 键盘可达）：Esc 逐层 ────────────────────────────────────────────
// 修前的两个毛病：
//   ① 抽屉与看板各挂了一处 document keydown 且各自 stopPropagation —— 抽屉开着时再打开一个
//      chip 菜单，Esc 关掉的是【抽屉】，菜单还在。谁先关取决于谁先注册，不是取决于谁在上面。
//   ② ※ 浮层与三个菜单（chip／盾牌／头像）的 Esc 要么挂在自己身上（焦点不在里面就收不到），
//      要么根本没有。
// 改成一个栈：浮层与菜单各自 push 自己的关闭器、关掉时 remove，由 steward-shell.js 那【一处】
// keydown 从栈顶往下关一层。抽屉与看板那两处 document keydown 保留不动 —— 它们天然是最底层，
// 而栈的监听【注册在它们之前】，所以「栈顶先关」自然成立：栈里有东西就关栈顶并 stopPropagation，
// 栈是空的才轮到抽屉／看板自己那一路。这样既拿到逐层语义，又不必动它们已被静态锁逐字钉住的形状。
const escapeLayers = [];
export const stewardEscapeStack = Object.freeze({
  // 返回一个「注销自己」的函数（调用方存起来，关闭时调一次）。同一层重复 push 会得到两个独立句柄，
  // 但关闭器是幂等的（自己不开着就返回 false），所以多注册一次只是多问一句。
  // 117k：第二个参数 owns(node) = 「这次点击落在我自己身上吗」（菜单本体或触发它的那颗键）。
  // 给了它的层才参与「点别处就收回」；不给的层只有 Esc 关得掉（保守：宁可不关，不误关）。
  push(close, owns) {
    if (typeof close !== 'function') return () => {};
    const layer = { close, owns: typeof owns === 'function' ? owns : null };
    escapeLayers.push(layer);
    return () => {
      const index = escapeLayers.indexOf(layer);
      if (index >= 0) escapeLayers.splice(index, 1);
    };
  },
  // 从栈顶往下找第一个【真的关掉了什么】的层。关闭器返回 false = 「我现在没开着」，继续往下问；
  // 抛错也当没关掉（一个坏掉的浮层不该把 Esc 整条吃掉）。
  handleEscape() {
    for (let i = escapeLayers.length - 1; i >= 0; i -= 1) {
      let closed = false;
      try { closed = escapeLayers[i].close() !== false; } catch { closed = false; }
      if (closed) return true;
    }
    return false;
  },
  // 117k（用户要求：所有菜单点了界面别的地方都要自动收回）：从栈顶往下，把每一层「这次点击
  // 不属于我」的都关掉。判据抛错一律当【点在里面】—— 一个坏掉的判据可以让菜单关不掉，
  // 但绝不能让它把用户正在点的菜单关掉。close() 会把自己从栈里摘掉，所以只能【倒着】走。
  handleOutsideClick(node) {
    let closed = 0;
    for (let i = escapeLayers.length - 1; i >= 0; i -= 1) {
      const layer = escapeLayers[i];
      if (!layer || !layer.owns) continue;
      let inside = true;
      try { inside = layer.owns(node) === true; } catch { inside = true; }
      if (inside) continue;
      try { if (layer.close() !== false) closed += 1; } catch { /* 坏掉的浮层不吃掉这次点击 */ }
    }
    return closed;
  },
  size: () => escapeLayers.length,
});

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

// 117j classic-1（经典壳回归审查 P1）：切「全自动」要不要二次确认，全仓只有这一处判据。
// 修前经典壳顶栏那个权限下拉只在【精简界面】才问一句，专家模式下切 auto 一声不吭就生效了 ——
// 同一个动作、同样的后果（它能在你不在时改文件、跑命令），两个壳、两种界面模式的门槛不该不一样。
// 纯函数 + 注入的 t：本模块不认识 window.confirm，也不该认识（它要能在 Node 里跑真值表）。
export function permissionSwitchNeedsConfirm(mode, uiMode) {
  if (STEWARD_PERMISSION_CONFIRM_MODES.includes(String(mode || ''))) return true;
  // bypass 沿用 v0.9-S1 那道闸：只在精简界面问（专家模式下它是常用档，问了反而是噪音）。
  return String(mode || '') === 'bypass' && String(uiMode || '') === 'simple';
}
// 确认文案：全自动走 §8.6 那五条人话（与管家壳盾牌菜单逐字同源），bypass 走既有那一句。
export function permissionConfirmText(mode, t) {
  const say = key => String(t(key));
  if (String(mode || '') === 'bypass') return say('permission.mode.bypass.confirm');
  return [say('permission.mode.auto.confirm'), ...STEWARD_CONFIRM_KEYS.map(key => '· ' + say(key))].join('\n');
}

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
  // 117h：看板行的紧凑模式 —— 只出【权限】与【模型】两个 chip，引擎收进模型菜单的第一段
  // （§8.10 线程行寸土寸金；抽屉与 2.0 顶栏仍是三个 chip 的完整模式）。
  compact = false,
  // 117h：看板行手里只有 GET /api/missions 的【卡片】（它没有 permissionMode / engineRoute），
  // 会话级档位与引擎路由要按需补齐。给了 hydrate 就在【打开菜单前】补一次（每个会话只补一次），
  // 没给就按宿主喂进来的那份渲染 —— 抽屉与 2.0 顶栏本来拿的就是完整会话，不需要这一步。
  hydrate = null,
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

  // 117j copy-P2-4/5：菜单开着时进 Esc 栈，关掉时注销并把焦点还给触发它的 chip
  // （键盘用户按完 Esc 得知道自己回到了哪里）。
  let releaseEscape = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.hidden = true;
    while (openMenu.firstChild) openMenu.removeChild(openMenu.firstChild);
    const owner = chips.get(openMenu.dataset.kind);
    if (owner) {
      owner.button.setAttribute('aria-expanded', 'false');
      try { owner.button.focus(); } catch { /* 宿主没有 focus 的环境 */ }
    }
    openMenu = null;
    if (releaseEscape) { releaseEscape(); releaseEscape = null; }
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
    // 紧凑模式：引擎收进模型菜单的第一段（同一份 engineOptions，不写第二套判据）。
    if (compact) {
      menu.appendChild(el('p', 'steward-chip-group', t('stewardShell.chips.engine')));
      buildEngineMenu(menu);
      menu.appendChild(el('p', 'steward-chip-group', t('stewardShell.chips.model')));
    }
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

  const hydrated = new Set();
  async function toggleMenu(kind) {
    const chip = chips.get(kind);
    if (!chip) return;
    const wasOpen = openMenu === chip.menu;
    closeMenu();
    if (wasOpen || !sessionId) return;
    // 补齐会话级事实再开菜单：不补的话紧凑模式下「跟随全局」与「真的定了档」会长得一模一样。
    if (typeof hydrate === 'function' && !hydrated.has(sessionId)) {
      const id = sessionId;
      hydrated.add(id);
      const full = await Promise.resolve(hydrate(id)).catch(() => null);
      if (id !== sessionId) return;                 // 期间宿主换了会话，这一趟作废
      if (full && typeof full === 'object') { session = full; render(); }
    }
    BUILDERS[kind](chip.menu);
    chip.menu.hidden = false;
    chip.button.setAttribute('aria-expanded', 'true');
    openMenu = chip.menu;
    releaseEscape = stewardEscapeStack.push(
      () => { if (!openMenu) return false; closeMenu(); return true; },
      // 菜单本体、以及打开它的那枚 chip：点这两处不算「点别处」。
      node => {
        if (!openMenu || !node) return false;
        if (openMenu.contains(node)) return true;
        const owner = chips.get(openMenu.dataset.kind);
        return Boolean(owner && owner.button && owner.button.contains(node));
      },
    );
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
    host.append(buildChip('permission', 'stewardShell.chips.permission'), buildChip('model', 'stewardShell.chips.model'));
    if (!compact) host.appendChild(buildChip('engine', 'stewardShell.chips.engine'));
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
