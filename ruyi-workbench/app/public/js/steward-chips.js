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

// 117u-G3（27 号文 §11.15.7；用户 2026-09-09「这个也不印默认值吧」）：这条会话的权限与模型
// 跟全局【一样吗】—— 一样就不值得印（§11.15.2 病 3「元信息是一串等重灰字」：满屏「权限 跟随
// 全局 · 模型 ⟨全局默认⟩」信息量为零，墨量却与线程名争重心）。
//
// 为什么住在这里：G2 先把这段判据写在 steward-board.js 的闭包里，G3 要给【看板与线程详情栏】
// 共用，而抽屉【不能】 import 看板（steward-board.js 已经 import 抽屉，反向引用即成环）。
// 本模块是这两面【已经】在 import 的零 import 叶子，且 resolveEngineRoute —— 全仓唯一那份
// 「会话级 ＞ 全局回落」—— 与 chip 工厂本来就住这儿，是它的自然归宿。搬家不改一个字的判据，
// 也不许再长出第三条：
//   · 模型：resolveEngineRoute 拿【这条会话】与【一份没有会话的空位】各算一次 —— 两次生效路由
//     一样，就说明这条线程根本没定过自己的模型／引擎，印出来的是全局默认值，印它等于没印；
//   · 权限：chips 的 render() 已经把「定过会话级档位」这件事画成 .is-pinned（它给 chip 上色
//     用的就是这一个事实），宿主 mount 完读一次它自己的输出即可 —— 不在这里第二次去认
//     session.permissionMode，那就是第二份判据。
//
// 如实记一处能力边界（与 G2 在看板那面记的是同一笔账，不是新债）：会话【元数据】
// （state.sessions，GET /api/sessions 的 sessionMeta）带 permissionMode 但【不带】 engineRoute，
// 任务卡（GET /api/missions）两者都不带 —— 所以在【看板】那一面，模型这一半只有在这条会话真被
// 补齐过（chip 菜单开过一次的 hydrate，或改完档回填的 onChanged）之后才判得准；补齐之前它必然
// 回落成「与全局相同」，也就是只会让它【少说】，不会让它【说错】。抽屉那一面没有这个洞：它的
// session 来自 GET /api/sessions/:id 的全量会话头，engineRoute 在里面（13d 那一行原样回 session）。
export function chipsWorthPrinting(session, config, chipHost) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const mine = JSON.stringify(resolveEngineRoute(session, cfg));
  const global = JSON.stringify(resolveEngineRoute(null, cfg));
  return mine !== global || Boolean(chipHost && chipHost.querySelector('.steward-chip.is-pinned'));
}

// 行动流水的「做了什么」列：与 13h 的 STEWARD_TOOL_LABELS 同一批键，但人话住 i18n。117n-M1
// （用户「查下有没有能合并的功能」走查）从 steward-settings.js 搬到这里：它是纯常量表，本来就该
// 住零 import 的叶子模块——settings/conversation 两个消费方都已经在 import 本文件的别的导出，
// 搬过来不新增任何模块依赖边。搬家本身切断了 conversation → settings 这条边（conversation 原来
// 为了这张表才 import settings.js），是给 ②「错误信封解包改引用权威实现」腾出的第一步：
// settings/board 接下来要反过来 import steward-conversation.js 的 stewardErrorText 等函数，
// 不先切断这条边就会造出循环 import。settings.js 仍然 export 这个名字（re-export），
// 老的 mod.STEWARD_TOOL_LABEL_KEYS 用法不受影响。
export const STEWARD_TOOL_LABEL_KEYS = Object.freeze({
  steward_thread_new: 'settings.steward.tool.threadNew',
  steward_thread_continue: 'settings.steward.tool.threadContinue',
  steward_thread_rename: 'settings.steward.tool.threadRename',
  steward_thread_prioritize: 'settings.steward.tool.threadPrioritize',
  steward_memory_write: 'settings.steward.tool.memoryWrite',
  steward_memory_veto: 'settings.steward.tool.memoryVeto',
  steward_config_set: 'settings.steward.tool.configSet',
  steward_skill_toggle: 'settings.steward.tool.skillToggle',
  steward_decide: 'settings.steward.tool.decide',
  steward_run_action: 'settings.steward.tool.runAction',
  // 117m-A4 新增的线程级停止原语。漏登记在这里 = 「行动流水」那一列把
  // steward_thread_stop 这个内部 id 原样显给用户（§8.1 原则 7：界面不出现系统内部词）。
  steward_thread_stop: 'settings.steward.tool.threadStop',
  steward_thread_note: 'settings.steward.tool.threadNote',
  steward_quick_ask: 'settings.steward.tool.quickAsk',
  steward_playbook_draft: 'settings.steward.tool.playbookDraft',
  steward_memory_panel_edit: 'settings.steward.tool.memoryEdit',
  steward_memory_panel_restore: 'settings.steward.tool.memoryRestore',
  steward_memory_panel_clear: 'settings.steward.tool.memoryClear',
});

// 117n-M1①（用户「查下有没有能合并的功能，比如对话输入框，通常应该都是一样的，应该要能做成
// 复用的」走查）：DOM 基础件三兄弟 doc()/byId()/el()，外加 clear()/button()，逐字复制在
// composer/drawer/conversation/board/classic-window/settings 六个消费方里（此前本模块自己在
// createQuickSwitchChips 内部也重复一份）。本模块是这六个消费方【已经】在 import 的零 import 叶子，
// 收进来不新增任何模块依赖边，也不动离线包清单。doc() 用 globalThis.document || null 是刻意的
// （非浏览器宿主——比如 Node 里的静态契约测试——不炸），六个消费方原来的写法逐字一致，保留。
export const doc = () => globalThis.document || null;
export const byId = id => (doc() ? doc().getElementById(id) : null);
export function el(tag, className, text) {
  const node = doc().createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}
export function clear(node) {
  if (!node) return null;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
export function button(className, text, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  if (onClick) node.addEventListener('click', onClick);
  return node;
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
  let sessionId = '';
  let session = null;
  let host = null;
  let openMenu = null;                 // 同一时刻只允许一个 chip 菜单展开
  const chips = new Map();             // kind -> { button, value, menu }

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

// 117o（用户第七轮走查②：「管家在规划的时候会把格式也输出出来，会先出现 {say:...} 这种」）：
// 管家回合的模型输出是一整个 JSON 信封，而 /api/steward/message 的 assistant_delta 是【原样】的
// 模型文本。修前前端把 delta 直接追加上屏，于是用户先看到半截 JSON，等 steward_reply 到了才
// 被替换成人话 —— 信封里的 why/acts 本来就不该在这一刻出现在对话流里（§8.1 原则 7）。
// 本函数只做一件事：从【到此刻为止的原始文本】里增量取出 say 已经吐出的那一段（转义已还原）。
// 取不到就回空串，调用方据此停在「···」：宁可少显示一拍，不许把系统内部格式端给用户。
// 放在这个零 import 的叶子模块里，单测才能脱开整个壳层依赖图直接 import 它。
const STEWARD_SAY_OPEN = new RegExp('"say"\\s*:\\s*"');
export function stewardSayFromPartial(raw) {
  const text = String(raw == null ? '' : raw);
  const open = STEWARD_SAY_OPEN.exec(text);
  if (!open) return '';
  let body = '';
  let escaped = false;
  for (let i = open.index + open[0].length; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { body += '\\' + ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }   // 末尾孤立反斜杠：等下一片 delta
    if (ch === '"') break;                              // say 已经收尾
    body += ch;
  }
  // 尾部可能停在半个 unicode 转义上，JSON.parse 会炸 —— 先丢掉那半截。
  const safe = body.replace(new RegExp('\\\\u[0-9a-fA-F]{0,3}$'), '');
  try { return JSON.parse('"' + safe + '"'); } catch { return ''; }
}
