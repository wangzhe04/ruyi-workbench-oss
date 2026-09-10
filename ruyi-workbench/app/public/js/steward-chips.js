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
// 117v-V2（27 号文 §11.16.2 V2 行；§11.16.5 经主会话裁决后的那一版）：切模型／引擎的那句说明摆在
// 哪两个菜单里。这句话是【无条件常显】的一句事实陈述，不接任何「在不在跑」的信号，理由三条：
//   ① 「下一回合生效、不打断正在跑的回合」在两种情形下都为真：在跑时它回答「会不会打断」，
//      不在跑时它同样准确（下一回合本来就是下一回合）。恒真的话没有理由依赖一个判断；
//   ② 本仓的活性判据【已知不可靠】，而且代码自己把这件事写在注释里 —— steward-drawer.js 的
//      renderLastSay 那段说明 isLive() 拿不到 resumable.live 就回落到五态，挂在提问上的回合
//      五态是 needs_you，于是恒判成不在跑。把一句本来无条件为真的话押在这种信号上，是拿一个
//      已知坏掉的判据去守它；
//   ③ chip 有三个宿主（抽屉、看板行、2.0 顶栏），看板行手里只有 GET /api/missions 的卡片
//      （连 engineRoute 都没有，见本文件 createQuickSwitchChips 的 hydrate 参数那段如实记）。
//      要让三面都判活性就得给 chip 喂第四种数据 —— 为一句恒真的话付这个代价不值。
// 事实本身（09-workflow 已核到行）：provider 在【回合入口】绑定，`for (let iter…)` 循环体内不再
// 重新取 config/provider，所以在跑的回合用旧模型跑完、新模型下一回合生效；13d 的 PATCH 只有
// 「会话级档位」与「切全自动要 confirm:true」两道门，没有「有活回合就拒」——切换不打断任何东西。
export const STEWARD_SWITCH_NOTE_KINDS = Object.freeze(['model', 'engine']);
export const STEWARD_SWITCH_NOTE_KEY = 'stewardShell.chips.switchTakesEffect';
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
  // 117z-E2b 提交①：线程权限进了 13m 的 STEWARD_ACTION_HOOKS（desktop:true 恒提议 -> 降级成按钮），
  // 漏登记在这里 = steward-settings.static H5 红，且「行动流水」把 steward_thread_permission 原样显给用户。
  steward_thread_permission: 'settings.steward.tool.threadPermission',
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

// 33 号文 §4「note()×5 收一」：chips／看板／抽屉／输入区／设置页五处「往某个 #...Note 元素写一行
// 小字」原本各写一份（取元素 → textContent = String(text || '')），逐字相同，只有目标 id 不同。
// 设置页那处多一句 dataset.tone —— 故意留在调用方：它只对那一个元素有意义，收进来会让其余四处
// 顺带把别人的 tone 清掉。返回目标节点，调用方要接着做别的事（比如写 tone）时不必再取一次。
export function writeNote(id, text) {
  const target = byId(id);
  if (!target) return null;
  target.textContent = String(text || '');
  return target;
}

// 33 号文 §4「轮询常量收进叶子」：管家三处轮询（壳层状态、看板、抽屉）各写了一份同一组字面量 ——
// 下限 5000（与 01-config 的 stewardPollMs 同一 clamp）、容差 250（setInterval 会比标称早几毫秒
// 回来，不留容差就会整整推迟一拍）、默认 15000（配置还没到达时的兜底）。三者都以 chips.js 为既有
// 依赖，收进来不新增任何模块依赖边。三处的【本地名字】刻意保留（STEWARD_DRAWER_POLL_MS_MIN 等）：
// 三把逐字锁钉的是 startPolling／pollStewardTick／pollSlice／pollTick 的函数体与 clamp 写法，
// 改名等于把锁全钉红；这一项收的是【值】不是名字 —— 本模块是这组数字的唯一来源。
export const STEWARD_POLL_MS_MIN = 5000;
export const STEWARD_POLL_MS_DEFAULT = 15000;
export const STEWARD_POLL_DUE_SLACK_MS = 250;

// 33 号文 §4「Enter/isComposing 守卫 ×3 抽 bindEnterToSubmit」：管家壳里「回车发送」的规矩原本在
// 三处各写一遍（composer 一处、抽屉底部输入框与问答框各一处），三份逐字同形。这里收成一处判据：
//   · Enter 且不按 Shift（Shift+Enter 在文本框里换行）；
//   · 且 **不在输入法组合中**（event.isComposing）—— 这是中文优先的产品里最要紧的一条：中文用户
//     选候选词按的那一下回车，绝不能把半句话发出去（117m-A6 用一次真事故换来的）。
// isSubmitEnter 是那条纯判据；bindEnterToSubmit 是它的「整框接线」形态（抽屉两次用）。composer 的
// keydown 还兼管 Esc 与 Tab，所以它读判据、不换监听器 —— 判据仍然只有一份。
export function isSubmitEnter(event) {
  return Boolean(event) && event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

export function bindEnterToSubmit(node, handler) {
  if (!node || typeof node.addEventListener !== 'function') return false;
  node.addEventListener('keydown', event => {
    if (!isSubmitEnter(event)) return;
    event.preventDefault();
    handler(event);
  });
  return true;
}

// ── 117x-M2 模型选择器（27 号文 §11.17）：能说什么、说给谁听，判据全在这一段纯函数里 ──────
// §11.17.1 划死了界面能说的话：我们真握着的只有 id／label、它属于哪个 provider、当前引擎、当前
// 选中项与全局默认值，外加账本里【按模型】的真实用量（M1 给 /api/usage/summary 补的第六个维度
// byModel）。没握着的一个字都不许出现 —— 上下文窗口、价格、速度、per-model 的能力（能力矩阵是
// provider 级的 provider.vision / provider.reasoning，不是模型级；给某个模型标「支持视觉」是编）。
//
// 「看起来不是文本模型」的 id 子串表：全仓【唯一一处】（§11.17.3 硬纪律二 —— 本仓为「第二份表」
// 栽过四次）。它只用来【折叠】，绝不用来过滤（硬纪律一）：判据是按名字猜的，猜错的代价是用户找不到
// 一个真实存在的端点，所以折叠区标题明写「按名字猜的，可能猜错」，里面的项照样能选、照样被搜索命中。
export const STEWARD_NON_TEXT_MODEL_HINTS = Object.freeze([
  'audio', 'realtime', 'image', 'ocr', 'tts', 'embed', 'rerank', 'livetranslate', 'video',
]);
export function looksNonTextModel(id) {
  const text = String(id == null ? '' : id).toLowerCase();
  return STEWARD_NON_TEXT_MODEL_HINTS.some(hint => text.includes(hint));
}

// 「常用」的两条裁剪与搜索框的出场门槛。后端【不切片】（M1 交付记录写明：byModel 全量返回），
// 「最近 30 天／最多 5 条」是前端这一处的事，所以它们是常量而不是散落的字面量。
export const STEWARD_MODEL_RECENT_DAYS = 30;
export const STEWARD_MODEL_RECENT_MAX = 5;
// 候选 > 8 项才出搜索框（少的时候多一个框是噪音，§11.17.2 ①）。
export const STEWARD_MODEL_SEARCH_MIN = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

// byModel → 按【模型 id】汇总的一行事实。M1 的分组键是 (engine, provider, model) 三元组（同一个 id
// 可由两个 provider 提供），而菜单里的一行本身就是【一个 id】，所以这里按 id 并组：turns 相加、
// 「上次用」取较近的那一条。副行说的于是正好是这个 id 的账，不需要在界面上替它挑一个 provider。
// lastAt 可能是空串（M1：该组没有可解析的 ts 就如实留空）—— 那一档 lastMs 记 0，副行只报回合数、
// 不报「几天前」：上次是什么时候我们确实不知道，说成「今天」或「0 天前」都是编。
export function stewardModelUsageIndex(byModel) {
  const index = new Map();
  for (const entry of (Array.isArray(byModel) ? byModel : [])) {
    const id = String((entry && entry.model) || '');
    if (!id) continue;
    const previous = index.get(id) || { turns: 0, lastMs: 0 };
    const at = Date.parse(String((entry && entry.lastAt) || ''));
    index.set(id, {
      turns: previous.turns + (Number(entry && entry.turns) || 0),
      lastMs: Number.isFinite(at) ? Math.max(previous.lastMs, at) : previous.lastMs,
    });
  }
  return index;
}

// 命中段：先在 label 上找（那是印出来的那一行），label 没有就退到 id（label 绝大多数就等于 id，
// 但两者不同时「搜 id 能搜到」比「高亮好看」重要）。返回 null ＝ 这一行不匹配。
function modelMatch(label, id, needle) {
  if (!needle) return { start: -1, end: -1 };
  const at = label.toLowerCase().indexOf(needle);
  if (at >= 0) return { start: at, end: at + needle.length };
  return id.toLowerCase().includes(needle) ? { start: -1, end: -1 } : null;
}

// 菜单里【此刻真看得见】的选项。折叠起来的那些【在 DOM 里但不在这份名单里】：它们照样能被点、
// 被搜索命中，只是键盘不该跳进一个收起来的抽屉。不走 querySelectorAll 是刻意的 —— 一层层走
// children 才能一路看住祖先的 hidden（选择器只认元素自己那一个属性）。
export function stewardVisibleOptions(node, out = []) {
  for (const child of Array.from((node && node.children) || [])) {
    if (child.hidden) continue;
    if (String(child.className || '').split(' ').includes('steward-chip-option')) out.push(child);
    stewardVisibleOptions(child, out);
  }
  return out;
}

// 菜单要画成什么样，全部在这里算完；渲染那一半只是把它翻译成节点（一处判据，三个宿主同一份）。
// 入参 options 是「这个端点的全部模型」，顺序即分组顺序（当前 route 的 provider 排在前）。
export function stewardModelMenuView({
  options = [],
  usage = null,
  currentModel = '',
  defaultModel = '',
  filter = '',
  now = Date.now(),
  foldOpen = false,
} = {}) {
  const index = usage instanceof Map ? usage : stewardModelUsageIndex(usage);
  const needle = String(filter || '').trim().toLowerCase();
  const current = String(currentModel || '');
  const fallback = String(defaultModel || '');
  const rows = [];
  for (const option of (Array.isArray(options) ? options : [])) {
    const id = String((option && option.id) || '');
    if (!id) continue;                       // 空 id 那一条由「跟随全局」代表，不重复摆一行
    const label = String((option && option.label) || id);
    const fact = index.get(id) || null;
    const match = modelMatch(label, id, needle);
    rows.push({
      id,
      label,
      group: String((option && option.group) || ''),
      groupLabel: String((option && option.groupLabel) || ''),
      nonText: looksNonTextModel(id),
      current: id === current,
      isDefault: Boolean(fallback) && id === fallback,
      // 副行：没有用量就是 null —— 不出「0 回合」，那是把「不知道」说成「零」（§11.17.2）。
      // days < 0 ＝ 有回合数但不知道上次是什么时候（lastAt 那一档为空）。
      usage: fact && fact.turns > 0
        ? { turns: fact.turns, lastMs: fact.lastMs, days: fact.lastMs > 0 ? Math.max(0, Math.floor((now - fact.lastMs) / DAY_MS)) : -1 }
        : null,
      match,
      hit: match !== null,
    });
  }
  const visible = needle ? rows.filter(row => row.hit) : rows;
  // 常用：最近 30 天用过的，按最近一次使用时间倒序，最多 5 条。一条都没有时【整段不出现】
  // （不摆一个空标题）——渲染那一半只需照抄 recent.length。用过的非文本模型【照样进这一段】，
  // 也【不折叠】：折叠是给「你大概不想要的东西」用的，用过的东西不属于那一类。
  const recent = visible
    .filter(row => row.usage && row.usage.days >= 0 && row.usage.days <= STEWARD_MODEL_RECENT_DAYS)
    .sort((a, b) => (b.usage.lastMs - a.usage.lastMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, STEWARD_MODEL_RECENT_MAX);
  // 折叠区【排除已经进了「常用」的那些】（§11.17.8 裁决：「常用」赢）。同一屏印两次是重复不是
  // 强调；去重之后折叠标题那个「× N」才是「还没露面的有 N 个」的真数。搜索时同样成立——过滤
  // 后的 recent 里有的，折叠区不再重复一份。key 是 (provider, model)：分组标的就是 provider，
  // 两件事实合起来才叫「一行」。
  const inRecent = new Set(recent.map(row => row.group + '\n' + row.id));
  const folded = visible.filter(row => row.nonText && !inRecent.has(row.group + '\n' + row.id));
  const groups = [];
  for (const row of visible) {
    if (row.nonText) continue;
    let group = groups.find(item => item.key === row.group);
    if (!group) groups.push(group = { key: row.group, label: row.groupLabel, rows: [] });
    group.rows.push(row);
  }
  return {
    // 门槛看的是【全部候选】而不是过滤后的那几条：搜索框不许在你打字打到只剩三条时自己消失。
    search: rows.length > STEWARD_MODEL_SEARCH_MIN,
    filtered: Boolean(needle),
    recent,
    groups,
    // 折叠区：在搜索时【自动展开】—— 否则命中了却看不见，就成了「看不见也摸不着」的项
    // （§11.16.4 追加③ 同一条纪律）。rows 一直在，展不展开只决定 body 的 hidden。
    fold: { rows: folded, open: Boolean(foldOpen) || (Boolean(needle) && folded.length > 0) },
    empty: visible.length === 0,
  };
}

// 常用置顶要的那份事实：GET /api/usage/summary 的 byModel。一次页面生命周期只拉一次（模块级缓存，
// 三个宿主各自 mount 出来的实例共用同一份 —— 看板给每条线程各建一个工厂实例，不共用就是一行一趟）。
// 拉的是 range=all：「最近 30 天」跨月，而端点只有 today／week／month／all 四档，month 是【本自然月】，
// 月初会把上个月用过的全判成没用过。失败不缓存（下次开菜单再试一次），也绝不编 —— 没有用量就是
// 不出常用段、不出副行。这不是轮询：它只在【第一次打开模型菜单】时发生一次，chip 仍然零计时器。
let usageRowsMemo = null;
let usageRowsPending = null;
export function stewardModelUsageRows() { return usageRowsMemo; }
function loadUsageRows(api) {
  if (usageRowsMemo) return Promise.resolve(usageRowsMemo);
  if (!usageRowsPending) {
    usageRowsPending = Promise.resolve()
      .then(() => api('/api/usage/summary?range=all'))
      // 自防：兜底分支已对齐会给 byModel，但别假设键一定在（usage-dashboard.js:80 同一写法）。
      .then(data => { usageRowsMemo = (data && Array.isArray(data.byModel)) ? data.byModel : []; return usageRowsMemo; })
      .catch(() => [])
      .then(rows => { usageRowsPending = null; return rows; });
  }
  return usageRowsPending;
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
  // 117x-M2：菜单一打开就把焦点交给搜索框（有搜索框的那张菜单才有）。它必须在 hidden = false
  // 【之后】才 focus —— 藏着的元素 focus() 不动，所以建菜单时只把节点记在这里，开完再交焦点。
  let pendingFocus = null;
  function closeMenu() {
    if (!openMenu) return;
    pendingFocus = null;
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
    writeNote('stewardDrawerNote', text);
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
  // 117x-M2 只多带两件事实：这一条候选属于哪个 provider（group）、那个 provider 印出来叫什么
  // （groupLabel）。两者都是已经握在手里的（provider.label／引擎品牌名），不是新编的元数据。
  function modelOptions(route) {
    if (route.engine === 'openai') {
      const provider = (config().providers || []).find(item => item && item.id === route.providerId) || null;
      const group = String(route.providerId || '');
      const groupLabel = String((provider && (provider.label || provider.id)) || group);
      return (provider && Array.isArray(provider.models) ? provider.models : [])
        .map(model => ({ id: String(model && model.id || ''), label: String((model && (model.label || model.id)) || ''), group, groupLabel }))
        .filter(model => model.id);
    }
    const models = (state && state.status && Array.isArray(state.status.models)) ? state.status.models : [];
    const group = 'agent:' + route.agentCliType;
    const groupLabel = AGENT_CLI_LABELS[route.agentCliType] || AGENT_CLI_LABELS.claude;
    return models
      .map(model => ({ id: String(model && model.id || ''), label: String((model && (model.label || model.id)) || t('stewardShell.chips.modelDefault')), group, groupLabel }));
  }

  // 一行模型：主行是 label（等于 id 时就是 id —— 不改写、不美化成别的名字，用户要复制粘贴的是真 id），
  // 命中搜索时把匹配的那一段包进 .steward-chip-hit；副行【只在真有用量时】出现，只说我们真知道的
  // 「上次用 · N 天前 · 共 M 回合」；全局默认那一项挂一枚「默认」徽标。
  function modelRow(row, route) {
    const node = el('button', 'steward-chip-option');
    node.type = 'button';
    node.setAttribute('role', 'menuitemradio');
    node.setAttribute('aria-checked', row.current ? 'true' : 'false');
    node.dataset.modelId = row.id;
    if (row.nonText) node.dataset.modelNonText = '1';
    const label = el('span', 'steward-chip-option-label');
    if (row.match && row.match.start >= 0) {
      const head = row.label.slice(0, row.match.start);
      const tail = row.label.slice(row.match.end);
      if (head) label.appendChild(el('span', '', head));
      label.appendChild(el('span', 'steward-chip-hit', row.label.slice(row.match.start, row.match.end)));
      if (tail) label.appendChild(el('span', '', tail));
    } else {
      label.textContent = row.label;
    }
    node.appendChild(label);
    if (row.isDefault) node.appendChild(el('span', 'steward-chip-badge', t('stewardShell.chips.modelDefault')));
    if (row.usage) {
      const when = row.usage.days === 0
        ? t('stewardShell.chips.usedToday')
        : t('stewardShell.chips.usedDaysAgo', { days: row.usage.days });
      node.appendChild(el('span', 'steward-chip-option-hint', row.usage.days >= 0
        ? t('stewardShell.chips.usageLine', { when, turns: row.usage.turns })
        : t('stewardShell.chips.usageTurns', { turns: row.usage.turns })));
    }
    node.onclick = () => { closeMenu(); patchSession({ engineRoute: { ...route, model: row.id } }); };
    return node;
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
    // 全局默认的那一项：只有当全局与这条会话走的是【同一个引擎／provider】时才认 —— 否则那个
    // 默认值属于另一个端点，给同名的一行贴「默认」徽标是张冠李戴。
    const globalRoute = resolveEngineRoute(null, config());
    const defaultModel = routeKey(globalRoute) === routeKey(route) ? String(globalRoute.model || '') : '';
    let filter = '';
    let foldOpen = false;
    const list = el('div', 'steward-chip-list');
    const view = () => stewardModelMenuView({
      options,
      usage: usageRowsMemo,
      currentModel: String(route.model || ''),
      defaultModel,
      filter,
      foldOpen,
    });
    // 搜索框只在候选 > 8 时出现；它活在重画之外（重画只换 list 的内容），所以打字时焦点与光标不丢。
    if (view().search) {
      const search = el('input', 'steward-chip-search');
      search.type = 'search';
      search.dataset.chipSearch = 'model';
      search.setAttribute('aria-label', t('stewardShell.chips.searchLabel'));
      search.placeholder = t('stewardShell.chips.searchLabel');
      search.oninput = () => { filter = String(search.value || ''); draw(); };
      menu.appendChild(search);
      pendingFocus = search;
    }
    menu.appendChild(list);
    function draw() {
      const model = view();
      clear(list);
      // ① 跟随全局永远第一项：语义与权限那一枚同一条 —— 这条线程不自己定，用全局那一份。
      //    形状上就是把会话级 engineRoute 的 model 清空（后端 configForSessionEngineRoute 对
      //    openai 端点会回落到 provider.model；agent 端点空模型即 CLI 自己的默认）。
      const follow = el('button', 'steward-chip-option');
      follow.type = 'button';
      follow.setAttribute('role', 'menuitemradio');
      follow.setAttribute('aria-checked', route.model ? 'false' : 'true');
      follow.dataset.modelId = '';
      follow.dataset.modelFollow = '1';
      follow.appendChild(el('span', 'steward-chip-option-label', t('stewardShell.chips.followGlobal')));
      follow.onclick = () => { closeMenu(); patchSession({ engineRoute: { ...route, model: '' } }); };
      list.appendChild(follow);
      // ② 常用：没有用量就整段不出现（不摆一个空标题）。
      if (model.recent.length) {
        list.appendChild(el('p', 'steward-chip-group', t('stewardShell.chips.groupRecent')));
        for (const row of model.recent) list.appendChild(modelRow(row, route));
      }
      // ③ 这个端点的全部模型（多 provider 时按 provider 分组，组标题就是它的 label）。
      for (const group of model.groups) {
        list.appendChild(el('p', 'steward-chip-group', group.label || t('stewardShell.chips.model')));
        for (const row of group.rows) list.appendChild(modelRow(row, route));
      }
      // ④ 「看起来不是文本模型」：折叠，不是隐藏 —— 行一直在 DOM 里、点了照样能选，
      //    标题明写「按名字猜的，可能猜错」，搜索命中时自动展开。
      if (model.fold.rows.length) {
        const fold = el('div', 'steward-chip-fold');
        const toggle = el('button', 'steward-chip-fold-toggle');
        toggle.type = 'button';
        toggle.dataset.chipFold = 'nonText';
        toggle.setAttribute('aria-expanded', model.fold.open ? 'true' : 'false');
        toggle.append(
          el('span', 'steward-chip-fold-title', t('stewardShell.chips.groupNonText')),
          el('span', 'steward-chip-fold-count', String(model.fold.rows.length)),
        );
        toggle.onclick = () => { foldOpen = !model.fold.open; draw(); };
        const body = el('div', 'steward-chip-fold-body');
        body.hidden = !model.fold.open;
        for (const row of model.fold.rows) body.appendChild(modelRow(row, route));
        fold.append(toggle, body);
        list.appendChild(fold);
      }
      // ⑤ 一条都没匹配上：如实说没匹配，而不是留一张空菜单让人以为坏了。
      if (model.empty && model.filtered) list.appendChild(el('p', 'steward-chip-option-hint', t('stewardShell.chips.noMatch')));
    }
    draw();
    // 用量是后到的（第一次开菜单才去拉）：到了就把 list 重画一遍。菜单已经关掉时 list 已被摘走
    // （closeMenu 清空菜单），parentNode 为空 —— 那就什么都不做，不去动一张不在屏幕上的菜单。
    if (!usageRowsMemo) loadUsageRows(api).then(() => { if (list.parentNode) draw(); }).catch(() => {});
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
    // 117v-V2：那句说明摆在【开菜单这一处】，不摆进 buildModelMenu／buildEngineMenu ——
    // 紧凑模式（看板行）把引擎收进模型菜单的第一段（buildModelMenu 会调 buildEngineMenu），
    // 摆在两个 builder 里就会在同一张菜单上出两遍。摆在这里天然「一张菜单一句」，
    // 也不必为紧凑模式补一个 if。判据只认 kind，与「在不在跑」无关（见 STEWARD_SWITCH_NOTE_KINDS）。
    if (STEWARD_SWITCH_NOTE_KINDS.includes(kind)) {
      const switchNote = el('p', 'steward-chip-option-hint', t(STEWARD_SWITCH_NOTE_KEY));
      switchNote.dataset.chipNote = 'switch';   // 静态锁与真夹具都按这个属性数「出没出、出了几遍」
      chip.menu.appendChild(switchNote);
    }
    chip.menu.hidden = false;
    chip.button.setAttribute('aria-expanded', 'true');
    openMenu = chip.menu;
    if (pendingFocus) { const target = pendingFocus; pendingFocus = null; try { target.focus(); } catch { /* 宿主没有 focus 的环境 */ } }
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
    // 117x-M2 键盘：↑↓ 在【看得见的】选项之间移动、Enter 选定（焦点还在搜索框时选第一条）。
    // 挂在菜单本体上、且只挂这一次（菜单节点跨开合复用，挂在每次 build 里会越叠越多）。
    // Esc 不在这里 —— 它走 stewardEscapeStack 那条栈（本文件顶部注释写了为什么是栈），不新开通道。
    menu.onkeydown = event => {
      const key = event && event.key;
      if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter') return;
      const items = stewardVisibleOptions(menu);
      if (!items.length) return;
      const at = items.indexOf(doc() ? doc().activeElement : null);
      if (key === 'Enter') {
        if (at >= 0) return;                       // 焦点已经在某一项上：让 button 的默认行为按下它
        if (event.preventDefault) event.preventDefault();
        items[0].click();
        return;
      }
      if (event.preventDefault) event.preventDefault();
      const next = key === 'ArrowDown'
        ? (at < 0 ? 0 : Math.min(items.length - 1, at + 1))
        : (at <= 0 ? 0 : at - 1);
      try { items[next].focus(); } catch { /* 宿主没有 focus 的环境 */ }
    };
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
