'use strict';

import { toast } from './util.js';
import {
  STEWARD_PERMISSION_MODES,
  STEWARD_PERMISSION_CONFIRM_MODES,
  STEWARD_CONFIRM_KEYS,
  permissionLabelKey,
  permissionHintKey,
  stewardEscapeStack,
  // 117n-M1：工具人话表与 DOM 基础件三兄弟（doc/byId/el）＋ clear/button 都搬到 steward-chips.js
  // 集中定义。STEWARD_TOOL_LABEL_KEYS 原来就定义在本文件里，现在从这里引用，仍然 export 出去
  // （下面那行 re-export）——老的 `import { STEWARD_TOOL_LABEL_KEYS } from './steward-settings.js'`
  // 用法（本波之前 steward-conversation.js 就是这么用的）不受影响。
  STEWARD_TOOL_LABEL_KEYS,
  doc,
  byId,
  el,
  clear,
  button,
  writeNote,
} from './steward-chips.js';
export { STEWARD_TOOL_LABEL_KEYS };
// 117n-M1②：错误信封解包不再自己写一份弱化版（漏了 error instanceof Error 分支，api() 抛出的
// 原始 Error 会退化成「[object Object]」那一类）——改成引用 steward-conversation.js 的权威实现，
// 它正确调用 net.js 的 apiErrorInfo 解结构化信封。
import { stewardErrorText } from './steward-conversation.js';
// 117 波 F5a：头部两枚常驻控件的字形全部取自 icons.js 的 ICONS 表（本模块零 SVG 路径常量）。
// permissionIconName 是【纯派生】（档位名 → 盾内字形名），不是第二份四档表 —— 四档的唯一判据
// 仍然是 steward-chips.js 的 STEWARD_PERMISSION_MODES，本文件一个档位名字面量都没有。
import { icon, permissionIconName } from './icons.js';
// 121-K7（§7.2 表首行／§13.5 登记③）：「多久之后」那句人话只有 js/rail-pocket.js 那一份
// （口袋、焦点栏「接下来」与本页这张表说同一句话，不各写一个 Intl.RelativeTimeFormat）。
// 123-M2：本页改成可建可改之后，列表要的是【全量】任务行（describeKey / state / policy），
// 而 rail-pocket 的 normalizeScheduleTasks 只留 K7 要的四个字段——所以取数那一发在本文件自己发，
// 不再复用 readScheduleTasks；排序也换成「暂停与算不出下一次的也要在表里」（upcomingSchedules
// 按设计会把它们滤掉，那是「接下来」要的语义，不是这张表要的）。
import { scheduleWhenLabel } from './rail-pocket.js';
// 40 号文 P0①：危险动作的确认件与文案键都住 js/confirm-panel.js（33 号文 §4「四套收一套」的那一份）。
// 本文件只调，不自己拼键、更不用 globalThis.confirm（119 波已把原生框清零）。
import { confirmDanger } from './confirm-panel.js';

// 第117波 117e：管家设置（27 号文 §5 117e 行 / §8.6「权限的界面表达」/ §4「面板」/ §11.1 拍板 6·7）。
//
// 两片地盘，一个模块：
//   ① 设置弹窗的「管家」页签（#stab-steward）——七组 <section>：总开关与壳、新线程默认权限、
//      管家可以自己做的事、模型与预算、新开线程用什么模型（117l-A3：强/快两档）、
//      管家记得的关于你、行动流水；
//   ② 管家壳头部右上角的两个常驻控件（§8.2）——盾牌（新线程默认权限）与一键停机／唤醒。
// 两片共用一份判据：权限四档的档位表、人话键与「全自动」二次确认文案【全部从 steward-chips.js
// import】（确认文案键与「哪一档要二次确认」的正身是 js/confirm-panel.js，那边定义、chips 就地
// re-export），本模块【不定义第二份四档表】（静态锁看住：settings 里零 'acceptEdits' 之类的字面量枚举）。
//
// 边界：
//   · 零 innerHTML／insertAdjacentHTML／document.write —— 全部 createElement + textContent；
//   · 零 setInterval／setTimeout —— 设置页不轮询，停机态由「打开页签／按下按钮／壳层轮询喂进来」
//     三个确定性时刻刷新（壳层那一处是 steward-shell.js 已有的唯一计时器，本模块不另起）；
//   · 配置写口只有注入的 saveConfigPartial（= POST /api/config），本模块不自己拼那条请求；
//   · `<a download>` 只用于记忆导出这一处（浏览器把 blob 存到本地，不经服务端）。
//
// 一条产品纪律（§8.6）：切到「全自动」要二次确认。116-3 B1 之后这是【两半】——界面这一半出弹窗
// （用的还是 chips 那五条文案，不写第二份），服务端那一半由 `POST /api/config` 的 applyConfigPatch
// 守着（缺 confirm:true 就 409 permission.confirm_required，与 13d 的线程级 PATCH 同一个错误码）。
// 所以本模块的写口在弹窗点过之后必须把 confirm:true 一起带上。

export const STEWARD_MEMORY_KINDS = Object.freeze(['profile', 'preference', 'habit', 'focus', 'policy']);
export const STEWARD_DECISIONS_PAGE = 50;          // 一屏多少条（后端缺省也是 50）
export const STEWARD_DECISIONS_MAX = 200;          // 后端硬顶，「加载更多」到此为止
export const STEWARD_SETTINGS_TAB = 'steward';     // data-stab 值，头像菜单三项都切到它

// 行动流水的「做了什么」列：与 13h 的 STEWARD_TOOL_LABELS 同一批键，但人话住 i18n（前端自己一份
// 映射，不从后端拿文案——后端那份是给模型看的，两边受众不同）。表外的工具原样显示工具名。
// 117n-M1：这张纯常量表搬到 steward-chips.js 去了（本文件顶部 import 它，并原样 re-export）。

// 三态「重启后自动续跑」：null = 跟随线程的自动续跑设置（后端 stewardAutoActions.resume 的三态）。
const RESUME_TO_SELECT = Object.freeze({ true: 'on', false: 'off' });
const SELECT_TO_RESUME = Object.freeze({ on: true, off: false });

export function createStewardSettingsDomain({
  // 117j UX-F1：总开关关掉的那一刻，如果用户正站在管家壳里，必须【立刻】回经典。修前只把配置写了，
  // 壳还留在原地，而状态行已经说「已回到经典」—— 说的和看到的不是一回事。壳的准入判定单点在
  // steward-shell.js 的 syncStewardShellAvailability（它内部就有 fail-closed 回退那一支），
  // 这里只负责在写完配置之后把它踢一脚，不自己再判一遍「能不能进管家壳」。
  syncShellAvailability = () => 'classic',
  api = async () => null,
  state = null,
  t = key => key,
  saveConfigPartial = async () => false,
  openSettingsTab = () => {},
  // 117b 的 presence 子域（纯投影 derivePresence 的驱动口）。停机／唤醒要立刻把头像切到
  // sleeping，不能等下一次壳层轮询——§8.3「停机覆盖一切」是个即时语义。
  presence = null,
} = {}) {
  const config = () => (state && state.config) || {};

  let bound = false;
  let seeding = false;          // fillStewardSettings 期间抑制 change 回写（否则每次刷新都在存）
  let stopped = false;          // 最近一次已知的停机态（来自 GET /api/steward/state）
  let memoryLoaded = false;
  let decisionsLoaded = false;
  let decisionsLimit = STEWARD_DECISIONS_PAGE;
  let decisionRows = [];
  let shieldOpen = false;
  // 117n-M1：doc/byId/el/clear/button 从 steward-chips.js import（六个消费方零本地重复定义）。

  // 117i：管家壳头部右上角那两枚常驻小图标（原型 .head 的 .ib：34px 圆、只有线条，没有底）。
  // 零 innerHTML —— SVG 全部由 icons.js 的 icon() 用 createElementNS 建；文字留在一个只给读屏的
  // span 里，所以按钮的 textContent 仍然逐字是那句人话（既有断言读的就是它）。
  //
  // F5a：本模块【不再自己写 SVG 路径常量】。F5a 之前这里躺着两份孤本 —— ICON_SHIELD 与
  // ICON_STOP，后者画的是「圆里一个方块」，与线程「停止」（icons.js 的实心方块 stop）同形不同义：
  // 用户没法从字形分辨停的是管家还是这条线程。现在停机／唤醒是电源符（已停机加一道斜杠），
  // 盾牌按档位取不同的盾内字形，两者的字形都住 icons.js 的那一张表。
  function paintIconButton(node, iconName, label, size = 18) {
    if (!doc()) return;
    clear(node);
    const glyph = icon(iconName, size);
    if (glyph) node.appendChild(glyph);
    node.appendChild(el('span', 'steward-icon-label', label));
  }
  // 盾牌是【胶囊】不是圆键（§11.13.1 F 追加：图标不再要求人猜）：盾内字形 ＋ 看得见的档位名 ＋ 角标。
  // 角标只能是图标，不能是文字字符 —— 按钮的 textContent 必须仍然逐字等于档位名（既有断言读的就是它）。
  function paintShieldButton(node, iconName, label) {
    if (!doc()) return;
    clear(node);
    const glyph = icon(iconName, 17);
    if (glyph) node.appendChild(glyph);
    node.appendChild(el('span', 'steward-shield-label', label));
    const caret = icon('caret', 12);
    if (caret) { caret.classList.add('steward-shield-caret'); node.appendChild(caret); }
  }
  // 117n-M1：button/clear 从 steward-chips.js import（六个消费方零本地重复定义）。

  function note(message, tone) {
    const target = writeNote('cfgStewardNote', message);
    if (!target) return;
    // dataset.tone 只对这一个元素有意义，故意不进共享写手（否则其余四处会顺带清掉别人的 tone）。
    if (tone) target.dataset.tone = tone; else delete target.dataset.tone;
  }
  function problem(message) {
    note(message, 'err');
    try { toast(message, 'err'); } catch { /* toast 是旁路，失败不该吞掉这次操作的结论 */ }
  }
  // 117n-M1②：稳定信封 → 人话不再自己写弱化版（原来的本地 errorText 少了 error instanceof Error
  // 分支——api() 抛出的原始 Error 会退化成「[object Object]」那一类）。直接引用
  // steward-conversation.js 的权威实现 stewardErrorText（正确调用 net.js 的 apiErrorInfo 解结构化
  // 信封），两处（这里与对话流）从此是同一条纪律的同一份实现，不是「同一条纪律的两份抄本」。

  async function call(pathname, options) {
    try {
      const response = await api(pathname, options);
      if (response && response.ok === false) {
        problem(t('settings.steward.failed', { error: stewardErrorText(response.error) || stewardErrorText(response) }));
        return null;
      }
      return response;
    } catch (error) {
      problem(t('settings.steward.failed', { error: stewardErrorText(error) }));
      return null;
    }
  }

  // 配置写口：单键或多键补丁。失败 toast 并把控件回填成落盘值（不留下「界面上改了、盘上没改」）。
  async function saveConfig(patch) {
    const okFlag = await saveConfigPartial(patch);
    if (!okFlag) { note(t('settings.steward.saveFailed'), 'err'); fillStewardSettings(); return false; }
    note(t('settings.steward.saved'));
    return true;
  }

  const num = (node, fallback) => {
    const raw = Number(node && node.value);
    return Number.isFinite(raw) ? raw : fallback;
  };

  /* ═══════════════ ① 总开关与壳 ═══════════════ */

  // 启停：POST /api/steward/{start,stop}。它们【不改配置】——配置落盘由 saveConfigPartial 负责。
  async function stewardStart() { return call('/api/steward/start', { method: 'POST' }); }
  async function stewardStop() { return call('/api/steward/stop', { method: 'POST' }); }

  // 顺序是有讲究的，两条都别调过来：
  //   打开 → 先落盘 stewardEnabledV1:true，再 start（start 自己会读 config，开关还没落盘时它必然
  //          409 steward.disabled）；
  //   关闭 → 先 stop，再落盘 false（先落盘的话 stop 会被同一道开关闸挡在门外，在途回合就停不下来）。
  async function toggleEnabled(next) {
    const box = byId('cfgStewardEnabled');
    if (next === true) {
      if (!await saveConfig({ stewardEnabledV1: true })) { if (box) box.checked = false; return false; }
      const started = await stewardStart();
      if (!started) { if (box) box.checked = false; await saveConfig({ stewardEnabledV1: false }); return false; }
      stopped = false;
    } else {
      await stewardStop();
      if (!await saveConfig({ stewardEnabledV1: false })) { if (box) box.checked = true; return false; }
      stopped = true;
    }
    fillStewardSettings();
    // UX-F1：配置已落盘（saveConfigPartial 顺手把 state.config 换成了服务端回的那一份），此刻再跑
    // 一次准入判定 —— 开关关着且人在管家壳里，它会 recoverStewardShell() 把壳与本机偏好一起改回经典。
    try { syncShellAvailability(); } catch (error) { console.warn('[steward] syncShellAvailability failed', error); }
    return true;
  }

  // 一键停机／唤醒（§8.6「常驻且永远可点」）：只动运行态，不动配置。
  async function toggleStopped() {
    const next = !stopped;
    const response = next ? await stewardStop() : await stewardStart();
    if (!response) return false;
    setStopped(next);
    return true;
  }

  // 壳层轮询（steward-shell.js 的那一处 setInterval）把最新的 stopped 喂进来，两边显示不打架。
  function setStopped(next) {
    stopped = next === true;
    renderRunState();
    return stopped;
  }

  async function refreshRunState() {
    const response = await call('/api/steward/state');
    if (response) stopped = response.stopped === true;
    renderRunState();
    return stopped;
  }

  function renderRunState() {
    const enabled = config().stewardEnabledV1 === true;
    // 头像与按钮读同一份真值（§8.3：sleeping = 开关关【或】已停机，且覆盖一切）。这一处是设置页
    // 与头部按钮改变运行态之后的即时投影 —— 不等下一次壳层轮询，也不等下一次 refreshStatus。
    // presence 缺席（依赖没接上）时只是没有头像可画，其余照常。
    try { if (presence && typeof presence.set === 'function') presence.set({ enabled, stopped }); } catch { /* presence 是旁路 */ }
    const label = stopped ? t('settings.steward.wake') : t('settings.steward.stop');
    for (const id of ['cfgStewardStopBtn', 'stewardStopBtn']) {
      const node = byId(id);
      if (!node) continue;
      // 设置页那一枚是普通文字按钮；管家壳头部那一枚按原型 .head 是个 34px 的图标圆键 ——
      // 图标 ＋ 只给读屏看的同一句话（textContent 仍然逐字等于 label，界面上不再是一颗大按钮）。
      // F5a：字形是【电源符】，已停机时同一枚加一道斜杠 —— 停的是管家，不是某一条线程。
      if (id === 'stewardStopBtn') paintIconButton(node, stopped ? 'powerOff' : 'power', label);
      else node.textContent = label;
      node.dataset.stopped = stopped ? 'true' : 'false';
      node.title = label;
      node.setAttribute('aria-label', label);
    }
    const shellBtn = byId('cfgStewardShellBtn');
    if (shellBtn) shellBtn.disabled = !enabled;
    const stateText = byId('cfgStewardRunState');
    if (stateText) {
      stateText.textContent = !enabled
        ? t('settings.steward.stateOff')
        : (stopped ? t('settings.steward.stateStopped') : t('settings.steward.stateRunning'));
    }
  }

  // 「切到管家界面」不自己写 data-shell-mode（那是 117a 的单一写入点）：改基础页那个既有的
  // 壳模式选择器并触发它自己的 change，持久化／准入判定／fail-closed 全部白拿。
  function switchToStewardShell() {
    const select = byId('cfgShellMode');
    if (!select) return false;
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /* ═══════════════ ② 新线程默认权限（四档表来自 steward-chips.js）═══════════════ */

  function currentPermission() {
    const mode = String(config().permissionMode || '');
    return STEWARD_PERMISSION_MODES.includes(mode) ? mode : STEWARD_PERMISSION_MODES[0];
  }

  function renderPermissionSelect() {
    const select = byId('cfgStewardDefaultPermission');
    if (!select) return;
    clear(select);
    for (const mode of STEWARD_PERMISSION_MODES) {
      const option = el('option', '', t(permissionLabelKey(mode)));
      option.value = mode;
      select.appendChild(option);
    }
    // 配置里可能是 bypass 之类的 CLI 原生内部值：保留一条「保存的值」占位，不静默改写用户的盘。
    const saved = String(config().permissionMode || '');
    if (saved && !STEWARD_PERMISSION_MODES.includes(saved)) {
      const stale = el('option', '', t('settings.steward.permissionSaved', { value: saved }));
      stale.value = saved;
      select.appendChild(stale);
    }
    select.value = saved || STEWARD_PERMISSION_MODES[0];
    const hint = byId('cfgStewardPermissionHint');
    if (hint) hint.textContent = t(permissionHintKey(currentPermission()) || 'settings.steward.permissionUnknown');
  }

  function hidePermissionConfirm() {
    const box = byId('cfgStewardPermissionConfirm');
    if (box) box.hidden = true;
  }

  // 二次确认：文案与顺序【就是】js/confirm-panel.js 登记表里那一份 STEWARD_CONFIRM_KEYS
  // （§8.6 那五条，经 chips re-export 取得），不复制第二份。
  function showPermissionConfirm(mode, onAccept, onCancel) {
    const box = byId('cfgStewardPermissionConfirm');
    if (!box) { onAccept(); return; }
    const title = byId('cfgStewardPermissionConfirmTitle');
    if (title) title.textContent = t('stewardShell.permission.confirmTitle');
    const list = byId('cfgStewardPermissionConfirmList');
    clear(list);
    if (list) for (const key of STEWARD_CONFIRM_KEYS) list.appendChild(el('li', '', t(key)));
    const cancel = byId('cfgStewardPermissionCancel');
    const accept = byId('cfgStewardPermissionOk');
    if (cancel) { cancel.textContent = t('stewardShell.permission.confirmCancel'); cancel.onclick = () => { hidePermissionConfirm(); onCancel(); }; }
    if (accept) { accept.textContent = t('stewardShell.permission.confirmOk'); accept.onclick = () => { hidePermissionConfirm(); onAccept(mode); }; }
    box.hidden = false;
    if (accept) accept.focus();
  }

  // 全局 permissionMode 的唯一写口。切「全自动」先出确认（界面这一半），服务端的 applyConfigPatch
  // 另有一道同码的 409 门（116-3 B1）——两半都在，脚本与界面走同一条纪律。
  async function setDefaultPermission(mode) {
    if (!STEWARD_PERMISSION_MODES.includes(mode)) return false;
    // 116-3 B1:服务端 applyConfigPatch 现在也有这道门(切「全自动」缺 confirm:true → 409
    // permission.confirm_required)。走到这里时确认弹窗已经点过「知道了」——两处写口
    //(设置页的选择器与管家盾牌菜单)都经 showPermissionConfirm 才调本函数,所以带上这个事实。
    if (!await saveConfig({ permissionMode: mode, confirm: true })) return false;
    // 经典壳顶栏的安全 chip 与隐藏的 permSelect 读的是同一份 config：把值同步过去，
    // 免得在下一次 refreshStatus 之前两处显示不一致（真正的重绘仍归 provider-settings）。
    const legacy = byId('permSelect');
    if (legacy) legacy.value = mode;
    renderPermissionSelect();
    renderShield();
    return true;
  }

  function onPermissionChange(event) {
    const mode = String(event.target.value || '');
    if (!STEWARD_PERMISSION_MODES.includes(mode)) { renderPermissionSelect(); return; }
    if (STEWARD_PERMISSION_CONFIRM_MODES.includes(mode)) {
      showPermissionConfirm(mode, accepted => setDefaultPermission(accepted), () => renderPermissionSelect());
      return;
    }
    setDefaultPermission(mode);
  }

  /* ═══════════════ 盾牌（管家壳头部，§8.2 右上两个常驻图标之一）═══════════════ */

  // 117j copy-P2-4：盾牌菜单进 Esc 栈，关掉时把焦点还给盾牌键（键盘用户按完 Esc 要知道回到了哪里）。
  let releaseShieldEscape = null;
  function closeShield() {
    const menu = byId('stewardShieldMenu');
    if (menu) { menu.hidden = true; clear(menu); }
    const btn = byId('stewardShieldBtn');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      try { btn.focus(); } catch { /* 宿主没有 focus 的环境 */ }
    }
    shieldOpen = false;
    if (releaseShieldEscape) { releaseShieldEscape(); releaseShieldEscape = null; }
  }

  function renderShield() {
    const btn = byId('stewardShieldBtn');
    if (!btn) return;
    const mode = currentPermission();
    // F5a：盾牌是家族标，档位画在盾【里面】（问号／铅笔／清单线／闪电）；档位名同时以文字常驻，
    // 图标不是唯一信号。字形名由档位名派生，本函数不认识任何一个档位名。
    paintShieldButton(btn, permissionIconName(mode), t(permissionLabelKey(mode)));
    btn.dataset.permission = mode;
    btn.title = t('settings.steward.shieldTitle', { mode: t(permissionLabelKey(mode)) });
    btn.setAttribute('aria-label', btn.title);
  }

  function toggleShield() {
    const menu = byId('stewardShieldMenu');
    const btn = byId('stewardShieldBtn');
    if (!menu || !btn) return;
    if (shieldOpen) { closeShield(); return; }
    clear(menu);
    const current = currentPermission();
    for (const mode of STEWARD_PERMISSION_MODES) {
      const option = el('button', 'steward-shield-option');
      option.type = 'button';
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', current === mode ? 'true' : 'false');
      option.dataset.permissionMode = mode;
      option.append(
        el('span', 'steward-shield-option-label', t(permissionLabelKey(mode))),
        el('span', 'steward-shield-option-hint', t(permissionHintKey(mode))),
      );
      option.onclick = () => {
        closeShield();
        if (STEWARD_PERMISSION_CONFIRM_MODES.includes(mode)) {
          openSettingsTab(STEWARD_SETTINGS_TAB);
          showPermissionConfirm(mode, accepted => setDefaultPermission(accepted), () => {});
          return;
        }
        setDefaultPermission(mode);
      };
      menu.appendChild(option);
    }
    menu.hidden = false;
    menu.id = menu.id || 'stewardShieldMenu';
    btn.setAttribute('aria-controls', 'stewardShieldMenu');   // copy-P2-4
    btn.setAttribute('aria-expanded', 'true');
    shieldOpen = true;
    releaseShieldEscape = stewardEscapeStack.push(
      () => { if (!shieldOpen) return false; closeShield(); return true; },
      // 117k：点别处收回。盾牌菜单与盾牌键自己不算「别处」。
      node => {
        const own = byId('stewardShieldMenu');
        const trigger = byId('stewardShieldBtn');
        return Boolean(node && ((own && own.contains(node)) || (trigger && trigger.contains(node))));
      },
    );
  }

  /* ═══════════════ ⑤ 记忆面板（§4「面板」）═══════════════ */

  function memoryItem(entry) {
    const item = el('div', 'steward-memory-item');
    item.dataset.memoryId = String(entry.id || '');
    item.dataset.state = String(entry.state || 'active');
    const text = el('textarea', 'steward-memory-text');
    text.value = String(entry.text || '');
    text.rows = 2;
    text.dataset.version = String(entry.updatedAt || '');
    text.setAttribute('aria-label', t('settings.steward.memory.editLabel'));
    text.addEventListener('blur', () => {
      const next = text.value.trim();
      if (!next || next === String(entry.text || '')) return;
      editMemory(entry, next);
    });
    item.appendChild(text);

    const meta = el('div', 'steward-memory-meta');
    if (entry.isNew === true) meta.appendChild(el('span', 'steward-memory-new', t('settings.steward.memory.new')));
    // 126-M02：过期条目**照常列在面板上**（时效是过滤不是删除），只是带一枚标 —— 用户看得见
    // 「它到期了」，可以改掉到期日续期、也可以直接否决。判据是服务端算好的 expired，
    // 前端不自己解析日期（与 isNew 同一个模具：可见层不造第二套判据）。
    if (entry.expired === true) {
      const badge = el('span', 'steward-memory-expired', t('settings.steward.memory.expired'));
      badge.title = t('settings.steward.memory.expiredHint', { at: String(entry.expiresAt || '') });
      meta.appendChild(badge);
    }
    meta.appendChild(el('span', '', t('settings.steward.memory.confidence', { value: Number(entry.confidence || 0).toFixed(2) })));
    meta.appendChild(el('span', '', t('settings.steward.memory.used', { count: Number(entry.useCount || 0) })));
    // 来源悬停（§8.7「使用可解释」）：会话与 seq 走 title，不占版面。
    const source = el('span', '', t('settings.steward.memory.source'));
    source.title = t('settings.steward.memory.sourceDetail', {
      sessionId: String(entry.sourceSessionId || ''), seq: String(entry.sourceSeq || 0),
    });
    meta.appendChild(source);
    if (String(entry.state) === 'vetoed') {
      meta.appendChild(button('steward-memory-btn', t('settings.steward.memory.restore'), () => restoreMemory(entry)));
    } else {
      meta.appendChild(button('steward-memory-btn', t('settings.steward.memory.veto'), () => vetoMemory(entry)));
    }
    item.appendChild(meta);
    return item;
  }

  function renderMemory(payload) {
    const panel = byId('cfgStewardMemoryPanel');
    if (!panel) return;
    clear(panel);
    const groups = (payload && payload.groups) || {};
    let any = false;
    for (const kind of STEWARD_MEMORY_KINDS) {
      const rows = Array.isArray(groups[kind]) ? groups[kind] : [];
      if (!rows.length) continue;
      any = true;
      const group = el('div', 'steward-memory-group');
      group.dataset.kind = kind;
      group.appendChild(el('h5', 'steward-memory-group-title', t(`settings.steward.memory.kind.${kind}`)));
      for (const entry of rows) group.appendChild(memoryItem(entry));
      panel.appendChild(group);
    }
    if (!any) panel.appendChild(el('p', 'steward-memory-empty', t('settings.steward.memory.empty')));
  }

  async function loadMemory() {
    if (config().stewardEnabledV1 !== true) {
      const panel = byId('cfgStewardMemoryPanel');
      clear(panel);
      if (panel) panel.appendChild(el('p', 'steward-memory-empty', t('settings.steward.memory.disabled')));
      memoryLoaded = false;
      return null;
    }
    const payload = await call('/api/steward/memory');
    if (!payload) return null;
    memoryLoaded = true;
    renderMemory(payload);
    return payload;
  }

  async function editMemory(entry, text) {
    const response = await call('/api/steward/memory/edit', {
      method: 'POST',
      body: JSON.stringify({ id: entry.id, text, version: String(entry.updatedAt || '') }),
    });
    if (!response) { await loadMemory(); return null; }   // 含 version_conflict：提示后重载
    note(t('settings.steward.memory.editDone'));
    await loadMemory();
    return response;
  }
  async function vetoMemory(entry) {
    if (!await call('/api/steward/memory/veto', { method: 'POST', body: JSON.stringify({ id: entry.id }) })) return null;
    note(t('settings.steward.memory.vetoDone'));
    return loadMemory();
  }
  async function restoreMemory(entry) {
    if (!await call('/api/steward/memory/restore', { method: 'POST', body: JSON.stringify({ id: entry.id }) })) return null;
    note(t('settings.steward.memory.restoreDone'));
    return loadMemory();
  }

  // 导出：把 GET /api/steward/memory/export 的 JSON 包成 blob 交给浏览器存。整个前端只有这一处
  // `<a download>`（静态锁看住）——服务端不生成文件，也不给可点的路径（§8.1 原则 4 的反面：
  // 这不是「给你一个路径你自己去开」，是直接把文件交到手上）。
  async function exportMemory() {
    const payload = await call('/api/steward/memory/export');
    if (!payload) return null;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a');
    anchor.href = url;
    anchor.download = 'steward-memory.json';
    doc().body.appendChild(anchor);
    anchor.click();
    doc().body.removeChild(anchor);
    URL.revokeObjectURL(url);
    note(t('settings.steward.memory.exportDone'));
    return payload;
  }

  function toggleClearConfirm(show) {
    const box = byId('cfgStewardMemoryClearConfirm');
    if (!box) return;
    box.hidden = !show;
    const input = byId('cfgStewardMemoryClearInput');
    if (input) { input.value = ''; if (show) input.focus(); }
  }

  async function clearMemory() {
    const input = byId('cfgStewardMemoryClearInput');
    const typed = String((input && input.value) || '').trim();
    // 后端要求 confirm 逐字 'clear'；前端先自查一次，免得把一次误按发成一条请求。
    if (typed !== 'clear') { problem(t('settings.steward.memory.clearNeedsWord')); return null; }
    if (!await call('/api/steward/memory/clear', { method: 'POST', body: JSON.stringify({ confirm: 'clear' }) })) return null;
    toggleClearConfirm(false);
    note(t('settings.steward.memory.clearDone'));
    return loadMemory();
  }

  /* ═══════════════ ⑥ 行动流水（§8.6 末条）═══════════════ */

  function toolLabel(tool) {
    const key = STEWARD_TOOL_LABEL_KEYS[String(tool || '')];
    return key ? t(key) : String(tool || '');
  }
  function permissionText(mode) {
    const key = permissionLabelKey(String(mode || ''));
    return key ? t(key) : (String(mode || '') || t('settings.steward.decisions.noPermission'));
  }
  // 127 波 2-quater B2：代批账本里的类别键 → 人话键。表内写死五个（与 06i STEWARD_EXEMPT_CATEGORY_LABELS 同一组键）：
  // t() 是扁平查找，拼出来的键不在表里会渲染成 [key]，所以不拼键；表外的类别原样显示机器键（诚实兜底）。
  const EXEMPT_CATEGORY_KEYS = Object.freeze({
    delete_data: 'settings.steward.decisions.exemptCategory.deleteData',
    system_change: 'settings.steward.decisions.exemptCategory.systemChange',
    install: 'settings.steward.decisions.exemptCategory.install',
    outbound_send: 'settings.steward.decisions.exemptCategory.outboundSend',
    push_remote: 'settings.steward.decisions.exemptCategory.pushRemote',
  });
  function basisText(row) {
    const basis = (row && row.basis) || {};
    const parts = [];
    if (basis.inboxSeq) parts.push(t('settings.steward.decisions.basisInbox', { seq: String(basis.inboxSeq) }));
    if (basis.auto === true) parts.push(t('settings.steward.decisions.basisAuto'));
    if (basis.origin) parts.push(String(basis.origin));
    if (basis.interventionId) parts.push(String(basis.interventionId));
    if (Array.isArray(basis.memoryIds) && basis.memoryIds.length) {
      parts.push(t('settings.steward.decisions.basisMemory', { count: basis.memoryIds.length }));
    }
    // 127 波 2-quater B2：代批的类别与管家写的理由。整格经 el() 的 textContent 上屏（本文件零 innerHTML），
    // 理由是模型写的字、服务端已中和截 200，这里仍只当纯文本。
    const delegation = (basis.delegation && typeof basis.delegation === 'object') ? basis.delegation : null;
    if (delegation) {
      const categories = (Array.isArray(delegation.categories) ? delegation.categories : [])
        .map(key => (EXEMPT_CATEGORY_KEYS[String(key)] ? t(EXEMPT_CATEGORY_KEYS[String(key)]) : String(key)))
        .filter(Boolean);
      parts.push(t('settings.steward.decisions.basisDelegation', { categories: categories.join('、'), note: String(delegation.riskNote || '') }));
    }
    return parts.join(' · ');
  }

  // 「撤销」只在 undoRef 带得动锚点时才给（§3.5：写工具返回 undoRef；没有锚点的一律给「详情」）。
  function undoTarget(row) {
    const undoRef = (row && row.undoRef) || null;
    if (!undoRef || typeof undoRef !== 'object') return null;
    const seq = Number(undoRef.rewindTargetTurnSeq);
    const sessionId = String(undoRef.sessionId || '');
    return Number.isFinite(seq) && seq > 0 && sessionId ? { sessionId, seq } : null;
  }

  async function undoDecision(row) {
    const target = undoTarget(row);
    if (!target) return null;
    const response = await call('/api/session/rewind', {
      method: 'POST',
      body: JSON.stringify({ sessionId: target.sessionId, targetTurnSeq: target.seq, rollbackFiles: true }),
    });
    if (!response) return null;
    // 回退没成真就不说「已撤销」（§8.1 原则 2 诚实优先）。
    note(response.ok === true ? t('settings.steward.decisions.undone') : t('settings.steward.decisions.undoFailed'), response.ok === true ? '' : 'err');
    return response;
  }

  function decisionDetail(row) {
    const undoRef = (row && row.undoRef) || {};
    return t('settings.steward.decisions.detail', {
      tool: String(row.tool || ''),
      kind: String(undoRef.kind || t('settings.steward.decisions.noUndo')),
      args: JSON.stringify(row.args || {}),
    });
  }

  function visibleDecisions() {
    const threadSelect = byId('cfgStewardDecisionsThread');
    const dateInput = byId('cfgStewardDecisionsDate');
    const thread = String((threadSelect && threadSelect.value) || '');
    const day = String((dateInput && dateInput.value) || '');
    return decisionRows.filter(row => {
      if (thread && String(row.targetSessionId || '') !== thread) return false;
      if (day && String(row.at || '').slice(0, 10) !== day) return false;
      return true;
    });
  }

  function renderDecisionsThreadFilter() {
    const select = byId('cfgStewardDecisionsThread');
    if (!select) return;
    const previous = select.value;
    clear(select);
    const all = el('option', '', t('settings.steward.decisions.allThreads'));
    all.value = '';
    select.appendChild(all);
    for (const sessionId of [...new Set(decisionRows.map(row => String(row.targetSessionId || '')).filter(Boolean))]) {
      const option = el('option', '', sessionId);
      option.value = sessionId;
      select.appendChild(option);
    }
    select.value = [...select.options].some(option => option.value === previous) ? previous : '';
  }

  function renderDecisions() {
    const host = byId('cfgStewardDecisions');
    if (!host) return;
    clear(host);
    const rows = visibleDecisions();
    if (!rows.length) {
      host.appendChild(el('p', 'steward-decisions-empty', t('settings.steward.decisions.empty')));
      return;
    }
    const table = el('table');
    const head = el('tr');
    for (const key of ['at', 'what', 'thread', 'permission', 'basis', 'cost', 'undo']) {
      head.appendChild(el('th', '', t(`settings.steward.decisions.col.${key}`)));
    }
    table.appendChild(el('thead')).appendChild(head);
    const body = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      tr.dataset.decisionSeq = String(row.seq || 0);
      tr.dataset.thread = String(row.targetSessionId || '');
      tr.appendChild(el('td', '', String(row.at || '').replace('T', ' ').slice(0, 19)));
      tr.appendChild(el('td', '', toolLabel(row.tool)));
      tr.appendChild(el('td', '', String(row.targetSessionId || '')));
      tr.appendChild(el('td', '', permissionText(row.permissionMode)));
      tr.appendChild(el('td', 'steward-decision-basis', basisText(row)));
      tr.appendChild(el('td', '', row.cost != null ? String(row.cost) : ''));
      const actions = el('td');
      if (undoTarget(row)) actions.appendChild(button('steward-decision-btn', t('settings.steward.decisions.undo'), () => undoDecision(row)));
      else actions.appendChild(button('steward-decision-btn', t('settings.steward.decisions.details'), () => note(decisionDetail(row))));
      tr.appendChild(actions);
      body.appendChild(tr);
    }
    table.appendChild(body);
    host.appendChild(table);
  }

  async function loadDecisions() {
    if (config().stewardEnabledV1 !== true) {
      const host = byId('cfgStewardDecisions');
      clear(host);
      if (host) host.appendChild(el('p', 'steward-decisions-empty', t('settings.steward.decisions.disabled')));
      decisionsLoaded = false;
      return null;
    }
    const payload = await call(`/api/steward/decisions?limit=${encodeURIComponent(decisionsLimit)}`);
    if (!payload) return null;
    decisionsLoaded = true;
    decisionRows = Array.isArray(payload.rows) ? payload.rows : [];
    renderDecisionsThreadFilter();
    renderDecisions();
    const more = byId('cfgStewardDecisionsMoreBtn');
    if (more) more.disabled = decisionsLimit >= STEWARD_DECISIONS_MAX || Number(payload.total || 0) <= decisionRows.length;
    return payload;
  }

  async function loadMoreDecisions() {
    decisionsLimit = Math.min(STEWARD_DECISIONS_MAX, decisionsLimit + STEWARD_DECISIONS_PAGE);
    return loadDecisions();
  }

  /* ═══════════════ ④ 模型与预算 ═══════════════ */

  // 117l-A3：三个 select 共用一份「providers + 『跟随主端点』」填充逻辑——管家自己的服务商、
  // 新开线程「强模型」的服务商、「快速模型」的服务商。savedId 由调用方各自传各自的落盘值；
  // 不在列表里也不是空串时补一条「保存的值」占位（与原来 renderProviderSelect 的既有语义一致，
  // 只是不再各自拼一份，本函数【只有一处定义】）。
  function fillProviderOptions(select, savedId) {
    if (!select) return;
    const providers = Array.isArray(config().providers) ? config().providers : [];
    const saved = String(savedId || '');
    clear(select);
    const follow = el('option', '', t('settings.steward.providerFollow'));
    follow.value = '';
    select.appendChild(follow);
    for (const provider of providers) {
      if (!provider || !provider.id) continue;
      const option = el('option', '', String(provider.label || provider.id));
      option.value = String(provider.id);
      select.appendChild(option);
    }
    if (saved && !providers.some(provider => provider && provider.id === saved)) {
      const stale = el('option', '', t('settings.steward.providerSaved', { value: saved }));
      stale.value = saved;
      select.appendChild(stale);
    }
    select.value = saved;
  }

  function renderProviderSelect() {
    const threadModels = (config().stewardThreadModels && typeof config().stewardThreadModels === 'object') ? config().stewardThreadModels : {};
    const strong = (threadModels.strong && typeof threadModels.strong === 'object') ? threadModels.strong : {};
    const fast = (threadModels.fast && typeof threadModels.fast === 'object') ? threadModels.fast : {};
    fillProviderOptions(byId('cfgStewardProviderId'), config().stewardProviderId);
    fillProviderOptions(byId('cfgStewardStrongProviderId'), strong.providerId);
    fillProviderOptions(byId('cfgStewardFastProviderId'), fast.providerId);
  }

  /* ═══════════════ ④d 定时任务（121-K7 立面，123-M2 接真数据；37 号文 §3.6）═══════════════ */
  // 121-K7 那一版是【只读】的（后端零实现，读不到就说「还没有定时任务」）。M1 把六条 API 落地
  // 之后，这一块改成【可建可改】：列表 ＋ 行内三个动作 ＋ 展开最近 5 次 ＋ 新建表单。
  //
  // 三条纪律：
  //   · 零 innerHTML —— 表单是 index.html 里的静态 DOM（五档计划各自的字段用 hidden 切换，
  //     不重画），列表行全部 createElement + textContent；
  //   · 无「路径 ＋ 复制」反模式（28 号 §2 / 27 号 §8.1）—— 产出线程只有一枚「打开这条线程」，
  //     它在如意里打开，界面上一个路径字符都不印；
  //   · 计划的人话【不在这里第二次判定】：服务端的 describeSchedule（06j 纯函数）给键与参数，
  //     本文件只把它翻成本地语言。weekly 那一支的 dayKeys 是键的数组,逐个翻完再拼。
  // 读列表仍走 js/rail-pocket.js 的 readScheduleTasks（口袋计数、焦点栏「接下来」与这张表同一发、
  // 同一序），但**这张表要的是全量字段**（describeKey / state / policy），所以另存一份原始行 ——
  // normalizeScheduleTasks 那一份只留 K7 要的四个字段，够不着徽标与展开。
  const SCHEDULE_TASKS_PATH = '/api/scheduler/tasks';
  const SCHEDULE_RUNS_LIMIT = 5;
  // 五档计划各自要显示哪几个字段块（表单里的其余块 hidden）。表在这里只有一份。
  const SCHEDULE_KIND_FIELDS = Object.freeze({
    once: ['at', 'date'], daily: ['at'], weekly: ['at', 'days'], monthly: ['at', 'dom'], cron: ['cron'],
  });
  const SCHEDULE_FIELD_BLOCKS = Object.freeze({
    at: 'cfgStewardScheduleAtBlock', date: 'cfgStewardScheduleDateBlock',
    days: 'cfgStewardScheduleDaysBlock', dom: 'cfgStewardScheduleDomBlock', cron: 'cfgStewardScheduleCronBlock',
  });
  // 触发模式与结果各自的人话键。**这两张表是界面侧 J10／J11 的落点**：
  //   · J10 —— 补跑必须显示成「补跑」，不能冒充「准时」；
  //   · J11 —— 崩溃后那一次是「结果未知，先核对」，不能显示成「成功」。
  const SCHEDULE_MODE_KEYS = Object.freeze({
    ontime: 'scheduler.mode.ontime', late: 'scheduler.mode.late', manual: 'scheduler.mode.manual',
  });
  const SCHEDULE_OUTCOME_KEYS = Object.freeze({
    succeeded: 'scheduler.outcome.succeeded', failed: 'scheduler.outcome.failed',
    needs_you: 'scheduler.outcome.needs_you', skipped: 'scheduler.outcome.skipped',
    unknown: 'scheduler.outcome.unknown',
  });
  let scheduleLoaded = false;
  let scheduleRows = [];        // 最近一次读到的【全量】任务行
  let scheduleOpenRuns = '';    // 当前展开的是哪一条（同时只展开一条，省一发请求也省一屏噪音）
  let openThreadHandler = null; // 迟绑定：点 sessionId 在【如意内】打开那条线程（不给路径）

  const lang = () => (doc() && doc().documentElement && doc().documentElement.lang) || '';
  // 06j 的 describeSchedule 只回键与参数（纯函数不认识语言）。weekly 的通用那一支带 dayKeys，
  // 逐个翻完再用一个也走目录的连接符拼起来。
  function scheduleDescribeText(task) {
    const key = String((task && task.describeKey) || '');
    if (!key) return '';
    const params = (task && task.describeParams && typeof task.describeParams === 'object') ? task.describeParams : {};
    if (Array.isArray(params.dayKeys)) {
      return t(key, { ...params, days: params.dayKeys.map(dayKey => t(dayKey)).join(t('scheduler.dowJoin')) });
    }
    return t(key, params);
  }
  function scheduleResultBadge(state) {
    const outcome = String((state && state.lastResult) || '');
    if (!outcome) return { text: t('settings.steward.schedule.never'), outcome: '', mode: '' };
    const mode = String((state && state.lastMode) || '');
    const outcomeText = t(SCHEDULE_OUTCOME_KEYS[outcome] || 'scheduler.outcome.unknown');
    const modeText = mode && SCHEDULE_MODE_KEYS[mode] ? t(SCHEDULE_MODE_KEYS[mode]) : '';
    return { text: modeText ? `${outcomeText} · ${modeText}` : outcomeText, outcome, mode };
  }

  function scheduleRunRow(run) {
    const item = el('li', 'steward-schedule-run');
    const firedAt = Date.parse(String(run.firedAt || run.dueAt || ''));
    item.appendChild(el('span', 'steward-schedule-run-when',
      Number.isFinite(firedAt) ? new Date(firedAt).toLocaleString(lang() || undefined) : ''));
    const badge = scheduleResultBadge({ lastResult: run.outcome, lastMode: run.mode });
    const chip = el('span', 'steward-schedule-badge', badge.text);
    chip.dataset.outcome = badge.outcome;
    chip.dataset.mode = badge.mode;
    item.appendChild(chip);
    if (run.sessionId) {
      // 唯一的落点：在如意里打开那条线程。**不印路径、不给复制**（28 号 §2 的 UX 红线）。
      const open = button('steward-schedule-run-open', t('settings.steward.schedule.openThread'),
        () => { if (typeof openThreadHandler === 'function') openThreadHandler(String(run.sessionId)); });
      open.dataset.sessionId = String(run.sessionId);
      item.appendChild(open);
    }
    return item;
  }

  // 40 号文 P0③：取回 runs 的这一趟里，整张表可能被一帧 schedule.changed 重画过 —— 那时手上这个
  // host 已经脱离文档，往里 append 等于画给空气看（scheduler-ui.browser 的 B3 就是这么红的）。
  // 认「用户要看的是哪一条」这件事，落点重新找一次。
  function liveRunsHost(taskId, host) {
    if (host && host.isConnected) return host;
    const root = doc();
    const row = root ? root.querySelector(`#cfgStewardSchedule .steward-schedule-row[data-task-id="${CSS.escape(String(taskId))}"]`) : null;
    return row ? row.querySelector('.steward-schedule-runs') : null;
  }
  async function toggleRuns(taskId, host) {
    if (scheduleOpenRuns === taskId) { scheduleOpenRuns = ''; host.hidden = true; clear(host); return 0; }
    scheduleOpenRuns = taskId;
    clear(host);
    host.hidden = false;
    const response = await call(`${SCHEDULE_TASKS_PATH}/${encodeURIComponent(taskId)}/runs?limit=${SCHEDULE_RUNS_LIMIT}`);
    const live = liveRunsHost(taskId, host);
    if (!live) return 0;                 // 那一条整个没了（被删）：没有落点，也就没什么可画
    scheduleOpenRuns = taskId;           // 重画把它清空过，重新认回来
    clear(live);
    live.hidden = false;
    const runs = (response && Array.isArray(response.runs)) ? response.runs : [];
    if (!runs.length) { live.appendChild(el('li', 'steward-schedule-empty', t('settings.steward.schedule.runsEmpty'))); return 0; }
    for (const run of runs) live.appendChild(scheduleRunRow(run));
    return runs.length;
  }

  async function scheduleAction(pathname, options) {
    const response = await call(pathname, options);
    if (!response) return false;
    await loadSchedule();
    return true;
  }

  function scheduleTaskRow(task) {
    const state = (task && task.state && typeof task.state === 'object') ? task.state : {};
    const item = el('li', 'steward-schedule-row');
    item.dataset.taskId = String(task.id || '');
    item.dataset.enabled = state.enabled === false ? 'false' : 'true';
    const head = el('div', 'steward-schedule-head');
    head.appendChild(el('span', 'steward-schedule-name', String(task.title || task.name || '')));
    const described = scheduleDescribeText(task);
    if (described) head.appendChild(el('span', 'steward-schedule-plan', described));
    const nextMs = Date.parse(String(task.nextRunAt || ''));
    const when = state.enabled === false
      ? t('settings.steward.schedule.paused')
      : (Number.isFinite(nextMs) ? t('settings.steward.schedule.next', { when: scheduleWhenLabel(nextMs, lang()) }) : '');
    if (when) head.appendChild(el('span', 'steward-schedule-when', when));
    const badge = scheduleResultBadge(state);
    const chip = el('span', 'steward-schedule-badge', badge.text);
    chip.dataset.outcome = badge.outcome;
    chip.dataset.mode = badge.mode;
    head.appendChild(chip);
    item.appendChild(head);

    const actions = el('div', 'steward-schedule-actions');
    const id = encodeURIComponent(String(task.id || ''));
    actions.appendChild(button('steward-schedule-act',
      t(state.enabled === false ? 'settings.steward.schedule.resume' : 'settings.steward.schedule.pause'),
      () => scheduleAction(`${SCHEDULE_TASKS_PATH}/${id}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: state.enabled === false }),
      })));
    // 40 号文 P0①：「立即运行」与「删除」两枚不可逆动作先问一句。confirmDanger 的契约是
    // 「返回 false 一律表示没得到允许」（取消／✕／Esc／点背影／键写错都算），所以必须 await 之后再动手。
    const taskTitle = String(task.title || task.name || '');
    actions.appendChild(button('steward-schedule-act', t('settings.steward.schedule.runNow'),
      async () => {
        if (!await confirmDanger({ name: 'scheduleRunNow', bodyParams: { title: taskTitle } })) return false;
        return scheduleAction(`${SCHEDULE_TASKS_PATH}/${id}/run-now`, { method: 'POST' });
      }));
    const runsHost = el('ul', 'steward-schedule-runs');
    runsHost.hidden = true;
    actions.appendChild(button('steward-schedule-act', t('settings.steward.schedule.runs'),
      () => toggleRuns(String(task.id || ''), runsHost)));
    actions.appendChild(button('steward-schedule-act steward-schedule-del', t('settings.steward.schedule.delete'),
      async () => {
        if (!await confirmDanger({ name: 'scheduleDelete', bodyParams: { title: taskTitle } })) return false;
        return scheduleAction(`${SCHEDULE_TASKS_PATH}/${id}`, { method: 'DELETE' });
      }));
    item.appendChild(actions);
    item.appendChild(runsHost);
    return item;
  }

  // 排序：与口袋／「接下来」同一序（下次触发升序），但**暂停与算不出下一次的也要在表里**——
  // upcomingSchedules 会把它们滤掉（那是「接下来」要的语义，不是这张表要的）。
  function scheduleSorted(tasks) {
    return [...tasks].sort((a, b) => {
      const ax = Date.parse(String(a.nextRunAt || '')) || Number.MAX_SAFE_INTEGER;
      const bx = Date.parse(String(b.nextRunAt || '')) || Number.MAX_SAFE_INTEGER;
      return ax - bx;
    });
  }

  function renderSchedule(tasks) {
    const list = byId('cfgStewardSchedule');
    if (!list) return 0;
    clear(list);
    const rows = scheduleSorted(tasks);
    if (!rows.length) {
      list.appendChild(el('li', 'steward-schedule-empty', t('settings.steward.schedule.empty')));
      return 0;
    }
    for (const task of rows) list.appendChild(scheduleTaskRow(task));
    return rows.length;
  }
  // 40 号文 P0③：推送来的刷新与「按刷新键」不是一回事 —— 用户展开着某一条的「最近几次」时，
  // 别处（管家建了一条／到点跑完了）派来的一帧不该把他正看着的那一格收起来。loadSchedule 会把
  // scheduleOpenRuns 清空并重建整张表，所以这里记住展开的是哪一条，重画完再把它展开回来。
  async function refreshScheduleFromPush() {
    const openId = scheduleOpenRuns;
    await loadSchedule();
    if (!openId) return 0;
    const row = doc() && doc().querySelector(`#cfgStewardSchedule .steward-schedule-row[data-task-id="${CSS.escape(openId)}"]`);
    const host = row ? row.querySelector('.steward-schedule-runs') : null;
    if (!host) return 0;      // 那一条被删了：没什么可展开的
    return toggleRuns(openId, host);
  }
  async function loadSchedule() {
    let payload = null;
    try { payload = await api(SCHEDULE_TASKS_PATH); } catch { payload = null; }
    scheduleRows = (payload && Array.isArray(payload.tasks)) ? payload.tasks : [];
    scheduleLoaded = true;
    scheduleOpenRuns = '';
    return renderSchedule(scheduleRows);
  }

  /* ── 新建表单 ─────────────────────────────────────────────────────────── */
  function scheduleFormError(message) {
    const node = byId('cfgStewardScheduleFormError');
    if (node) node.textContent = String(message || '');
  }
  // 五档各显示各自那几块。同时 prompt 载荷才有「在哪儿跑 / 哪一条线程 / 权限档」。
  function syncScheduleForm() {
    const kind = String((byId('cfgStewardScheduleKind') || {}).value || 'once');
    const wanted = SCHEDULE_KIND_FIELDS[kind] || SCHEDULE_KIND_FIELDS.once;
    for (const [field, blockId] of Object.entries(SCHEDULE_FIELD_BLOCKS)) {
      const block = byId(blockId);
      if (block) block.hidden = !wanted.includes(field);
    }
    const isPrompt = String((byId('cfgStewardSchedulePayloadKind') || {}).value || '') === 'prompt';
    const targetBlock = byId('cfgStewardScheduleTargetBlock');
    if (targetBlock) targetBlock.hidden = !isPrompt;
    const permissionBlock = byId('cfgStewardSchedulePermissionBlock');
    if (permissionBlock) permissionBlock.hidden = !isPrompt;
    const existing = isPrompt && String((byId('cfgStewardScheduleTarget') || {}).value || '') === 'existing-session';
    const sessionBlock = byId('cfgStewardScheduleSessionBlock');
    if (sessionBlock) sessionBlock.hidden = !existing;
    return kind;
  }
  // 「哪一条线程」的候选来自左栏已经取回来的那一份（GET /api/missions），不裸发第二份请求。
  async function fillScheduleSessions() {
    const select = byId('cfgStewardScheduleSessionId');
    if (!select) return 0;
    let rows = [];
    try {
      const payload = await api('/api/missions?limit=50');
      rows = (payload && Array.isArray(payload.missions)) ? payload.missions : [];
    } catch { rows = []; }
    clear(select);
    for (const row of rows) {
      const sessionId = String((row && row.sessionId) || '');
      if (!sessionId) continue;
      const option = el('option', '', String(row.missionTitle || row.title || sessionId));
      option.value = sessionId;
      select.appendChild(option);
    }
    return select.options.length;
  }
  function scheduleFormPlan(kind) {
    const at = String((byId('cfgStewardScheduleAt') || {}).value || '');
    if (kind === 'cron') return { kind, expr: String((byId('cfgStewardScheduleCron') || {}).value || '') };
    if (kind === 'once') return { kind, at, date: String((byId('cfgStewardScheduleDate') || {}).value || '') };
    if (kind === 'weekly') {
      const box = byId('cfgStewardScheduleDaysBlock');
      const days = box ? [...box.querySelectorAll('input[data-dow]')].filter(node => node.checked).map(node => Number(node.dataset.dow)) : [];
      return { kind, at, days };
    }
    if (kind === 'monthly') return { kind, at, dayOfMonth: Number((byId('cfgStewardScheduleDom') || {}).value || 1) };
    return { kind, at };
  }
  async function submitSchedule() {
    scheduleFormError('');
    const kind = String((byId('cfgStewardScheduleKind') || {}).value || 'once');
    const payloadKind = String((byId('cfgStewardSchedulePayloadKind') || {}).value || 'reminder');
    const body = {
      title: String((byId('cfgStewardScheduleTitle') || {}).value || '').trim(),
      schedule: scheduleFormPlan(kind),
      payload: { kind: payloadKind, text: String((byId('cfgStewardScheduleText') || {}).value || '').trim() },
    };
    if (payloadKind === 'prompt') {
      const mode = String((byId('cfgStewardScheduleTarget') || {}).value || 'new-session');
      body.target = mode === 'existing-session'
        ? { mode, sessionId: String((byId('cfgStewardScheduleSessionId') || {}).value || '') }
        : { mode };
      const permission = String((byId('cfgStewardSchedulePermission') || {}).value || '');
      if (permission) body.autonomy = { permissionMode: permission };
    }
    let response = null;
    try { response = await api(SCHEDULE_TASKS_PATH, { method: 'POST', body: JSON.stringify(body) }); }
    catch (error) { response = { ok: false, error }; }
    if (!response || response.ok !== true) {
      // 建不成【留在表单里】并把原因印在旁边（不 toast 完就把表单收掉——用户刚填的东西还在里面）。
      scheduleFormError(t('settings.steward.schedule.form.failed', { reason: stewardErrorText((response && response.error) || response) }));
      return false;
    }
    toggleScheduleForm(false);
    await loadSchedule();
    return true;
  }
  function toggleScheduleForm(open) {
    const form = byId('cfgStewardScheduleForm');
    if (!form) return false;
    form.hidden = !open;
    if (open) {
      scheduleFormError('');
      const date = byId('cfgStewardScheduleDate');
      if (date && !date.value) date.value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      syncScheduleForm();
      void fillScheduleSessions();
    }
    return open;
  }

  /* ═══════════════ 填充与接线 ═══════════════ */

  function fillStewardSettings() {
    if (!byId('stab-steward')) return false;
    const c = config();
    seeding = true;
    try {
      const enabled = c.stewardEnabledV1 === true;
      const box = byId('cfgStewardEnabled');
      if (box) box.checked = enabled;
      renderRunState();
      renderPermissionSelect();
      renderShield();
      const auto = (c.stewardAutoActions && typeof c.stewardAutoActions === 'object') ? c.stewardAutoActions : {};
      const retry = byId('cfgStewardAutoRetry'); if (retry) retry.checked = auto.retry !== false;
      const relay = byId('cfgStewardAutoRelay'); if (relay) relay.checked = auto.relay === true;
      const newThread = byId('cfgStewardAutoNewThread'); if (newThread) newThread.checked = auto.newThread !== false;
      const resume = byId('cfgStewardAutoResume');
      if (resume) resume.value = RESUME_TO_SELECT[String(auto.resume)] || '';
      renderProviderSelect();
      const model = byId('cfgStewardModel'); if (model) model.value = String(c.stewardModel || '');
      // 117l-A3：强/快两档各自的模型名文本框（providerId 由上面 renderProviderSelect 里的
      // fillProviderOptions 播种，这里只补 model 字段）。
      const threadModels = (c.stewardThreadModels && typeof c.stewardThreadModels === 'object') ? c.stewardThreadModels : {};
      const strongModel = byId('cfgStewardStrongModel');
      if (strongModel) strongModel.value = String((threadModels.strong && threadModels.strong.model) || '');
      const fastModel = byId('cfgStewardFastModel');
      if (fastModel) fastModel.value = String((threadModels.fast && threadModels.fast.model) || '');
      const poll = byId('cfgStewardPollMs'); if (poll) poll.value = String(Math.round(Number(c.stewardPollMs || 15000) / 1000));
      const visitIdle = byId('cfgStewardVisitIdle'); if (visitIdle) visitIdle.value = String(Number(c.stewardVisitIdleMinutes || 60));
      const turns = byId('cfgStewardMaxTurnsPerHour'); if (turns) turns.value = String(Number(c.stewardMaxTurnsPerHour || 12));
      const cost = byId('cfgStewardMaxCostPerDay'); if (cost) cost.value = String(Number(c.stewardMaxCostPerDay ?? 1));
      const parallel = byId('cfgStewardMaxParallelThreads'); if (parallel) parallel.value = String(Number(c.stewardMaxParallelThreads || 5));
      const globalTurns = byId('cfgStewardGlobalMaxTurnsPerHour'); if (globalTurns) globalTurns.value = String(Number(c.stewardGlobalMaxTurnsPerHour || 120));
      const globalCost = byId('cfgStewardGlobalMaxCostPerDay'); if (globalCost) globalCost.value = String(Number(c.stewardGlobalMaxCostPerDay ?? 20));
      // 116-5b:默认开(缺字段 = 开),所以判的是 !== false 而不是 === true。
      const brief = byId('cfgStewardThreadBrief'); if (brief) brief.checked = c.stewardThreadBriefV1 !== false;
      // 127 波 2-quater B2：管家代批。默认开（缺字段 = 开），与上面那一格同方向：判 !== false。
      const exemptDelegation = byId('cfgStewardExemptDelegation'); if (exemptDelegation) exemptDelegation.checked = c.stewardExemptDelegationV1 !== false;
      const retention = byId('cfgStewardRetention');
      if (retention) retention.value = ['visit', '24h', 'forever'].includes(c.stewardConversationRetention) ? c.stewardConversationRetention : 'visit';
      // 121-K7（§13.5 登记③）：「最近 N 条」窗口。缺省与钳位都在 src/01-config.js 一处
      // （THREAD_INDEX_RECENT_DEFAULT/MIN/MAX），这里【不写第二份区间】—— 读不到就留空，
      // 让服务端回来的那个数说话（min/max 只挂在 <input> 上给浏览器做输入提示）。
      const indexRecent = byId('cfgStewardThreadIndexRecent');
      if (indexRecent) indexRecent.value = Number.isFinite(Number(c.threadIndexRecent)) ? String(Number(c.threadIndexRecent)) : '';
      // 40 号文 P0②：安静卡「稍后」推迟多久。同一手法——服务端那个数说话,客户端不抄第二份钳位。
      const snoozeMinutes = byId('cfgStewardQuietSnoozeMinutes');
      if (snoozeMinutes) snoozeMinutes.value = Number.isFinite(Number(c.quietCardSnoozeMinutes)) ? String(Number(c.quietCardSnoozeMinutes)) : '';
    } finally {
      seeding = false;
    }
    return true;
  }

  // change 即存（与基础页同风格）。seeding 期间一律不回写。
  function onChange(id, handler) {
    const node = byId(id);
    if (!node) return;
    node.addEventListener('change', event => { if (!seeding) handler(event); });
  }

  function bindStewardSettings() {
    if (bound || !doc()) return false;
    bound = true;

    onChange('cfgStewardEnabled', event => toggleEnabled(event.target.checked === true));
    const shellBtn = byId('cfgStewardShellBtn');
    if (shellBtn) shellBtn.onclick = () => switchToStewardShell();
    for (const id of ['cfgStewardStopBtn', 'stewardStopBtn']) {
      const node = byId(id);
      if (node) node.onclick = () => toggleStopped();
    }
    const shield = byId('stewardShieldBtn');
    if (shield) shield.onclick = () => toggleShield();

    onChange('cfgStewardDefaultPermission', onPermissionChange);

    const autoPatch = () => {
      const resume = byId('cfgStewardAutoResume');
      const raw = String((resume && resume.value) || '');
      return {
        retry: byId('cfgStewardAutoRetry') ? byId('cfgStewardAutoRetry').checked === true : true,
        resume: Object.prototype.hasOwnProperty.call(SELECT_TO_RESUME, raw) ? SELECT_TO_RESUME[raw] : null,
        relay: byId('cfgStewardAutoRelay') ? byId('cfgStewardAutoRelay').checked === true : false,
        newThread: byId('cfgStewardAutoNewThread') ? byId('cfgStewardAutoNewThread').checked === true : true,
      };
    };
    for (const id of ['cfgStewardAutoRetry', 'cfgStewardAutoResume', 'cfgStewardAutoRelay', 'cfgStewardAutoNewThread']) {
      onChange(id, () => saveConfig({ stewardAutoActions: autoPatch() }));
    }

    onChange('cfgStewardThreadBrief', event => saveConfig({ stewardThreadBriefV1: event.target.checked === true }));
    // 127 波 2-quater B2：走用户自己的 POST /api/config（与上面同一条 saveConfig），不经管家 —— 这个键在 06i 是
    // forbidden 档，steward_config_set 碰不到它。
    onChange('cfgStewardExemptDelegation', event => saveConfig({ stewardExemptDelegationV1: event.target.checked === true }));
    onChange('cfgStewardProviderId', event => saveConfig({ stewardProviderId: String(event.target.value || '') }));
    onChange('cfgStewardModel', event => saveConfig({ stewardModel: String(event.target.value || '').trim() }));
    // 117l-A3：强/快两档各自的服务商与模型。四个控件都在「当前 config 里的 stewardThreadModels」
    // 基础上合并那一格再整对象上传——不是只传半个（POST /api/config 是整键覆盖写，传半个会把另一
    // 档手滑清空）。
    const threadModelPatch = (tier, field, value) => {
      const current = (config().stewardThreadModels && typeof config().stewardThreadModels === 'object') ? config().stewardThreadModels : {};
      const currentTier = (current[tier] && typeof current[tier] === 'object') ? current[tier] : {};
      return { ...current, [tier]: { ...currentTier, [field]: value } };
    };
    onChange('cfgStewardStrongProviderId', event => saveConfig({ stewardThreadModels: threadModelPatch('strong', 'providerId', String(event.target.value || '')) }));
    onChange('cfgStewardStrongModel', event => saveConfig({ stewardThreadModels: threadModelPatch('strong', 'model', String(event.target.value || '').trim()) }));
    onChange('cfgStewardFastProviderId', event => saveConfig({ stewardThreadModels: threadModelPatch('fast', 'providerId', String(event.target.value || '')) }));
    onChange('cfgStewardFastModel', event => saveConfig({ stewardThreadModels: threadModelPatch('fast', 'model', String(event.target.value || '').trim()) }));
    // 秒进毫秒出：界面按秒（下限 5），落盘按毫秒（后端 clamp [5000,120000]）。
    onChange('cfgStewardPollMs', event => saveConfig({ stewardPollMs: Math.max(5, num(event.target, 15)) * 1000 }));
    onChange('cfgStewardVisitIdle', event => saveConfig({ stewardVisitIdleMinutes: num(event.target, 60) }));
    onChange('cfgStewardMaxTurnsPerHour', event => saveConfig({ stewardMaxTurnsPerHour: num(event.target, 12) }));
    onChange('cfgStewardMaxCostPerDay', event => saveConfig({ stewardMaxCostPerDay: num(event.target, 1) }));
    onChange('cfgStewardMaxParallelThreads', event => saveConfig({ stewardMaxParallelThreads: num(event.target, 5) }));
    onChange('cfgStewardGlobalMaxTurnsPerHour', event => saveConfig({ stewardGlobalMaxTurnsPerHour: num(event.target, 120) }));
    onChange('cfgStewardGlobalMaxCostPerDay', event => saveConfig({ stewardGlobalMaxCostPerDay: num(event.target, 20) }));
    onChange('cfgStewardRetention', event => saveConfig({ stewardConversationRetention: String(event.target.value || 'visit') }));
    // 121-K7（§13.5 登记③）：写回原样送数字，钳位由服务端 normalizeConfig 做（客户端不抄第二份
    // [10,200]）；落盘之后 fillStewardSettings 会把钳过的值回填到框里。
    onChange('cfgStewardThreadIndexRecent', async event => {
      if (!await saveConfig({ threadIndexRecent: num(event.target, 30) })) return;
      // 落盘之后把【服务端钳过的那个数】写回框里 —— 用户填 5，服务端给 10，框里就得是 10，
      // 否则界面在说一件不成立的事。只补这一个框（不整页重播种，那会打断别处正在输入的值）。
      const clamped = Number(config().threadIndexRecent);
      if (Number.isFinite(clamped)) event.target.value = String(clamped);
    });
    // 40 号文 P0②：与上面那一条同一个模具（送原样数字、服务端钳 [1,1440]、把钳过的写回框里）。
    onChange('cfgStewardQuietSnoozeMinutes', async event => {
      if (!await saveConfig({ quietCardSnoozeMinutes: num(event.target, 30) })) return;
      const clamped = Number(config().quietCardSnoozeMinutes);
      if (Number.isFinite(clamped)) event.target.value = String(clamped);
    });

    const refreshSchedule = byId('cfgStewardScheduleRefreshBtn');
    if (refreshSchedule) refreshSchedule.onclick = () => loadSchedule();
    // 123-M2（§3.6）：新建表单。计划四档＋cron 高级用同一张 SCHEDULE_KIND_FIELDS 表切字段块，
    // 不重画表单（零 innerHTML 的另一半：DOM 是静态的，JS 只改 hidden 与 value）。
    const newSchedule = byId('cfgStewardScheduleNewBtn');
    if (newSchedule) newSchedule.onclick = () => toggleScheduleForm(byId('cfgStewardScheduleForm') ? byId('cfgStewardScheduleForm').hidden : true);
    const cancelSchedule = byId('cfgStewardScheduleCancelBtn');
    if (cancelSchedule) cancelSchedule.onclick = () => toggleScheduleForm(false);
    const scheduleForm = byId('cfgStewardScheduleForm');
    if (scheduleForm) scheduleForm.addEventListener('submit', event => { event.preventDefault(); void submitSchedule(); });
    for (const id of ['cfgStewardScheduleKind', 'cfgStewardSchedulePayloadKind', 'cfgStewardScheduleTarget']) {
      const node = byId(id);
      if (node) node.addEventListener('change', () => syncScheduleForm());
    }

    const refreshMemory = byId('cfgStewardMemoryRefreshBtn');
    if (refreshMemory) refreshMemory.onclick = () => loadMemory();
    const exportBtn = byId('cfgStewardMemoryExportBtn');
    if (exportBtn) exportBtn.onclick = () => exportMemory();
    const clearBtn = byId('cfgStewardMemoryClearBtn');
    if (clearBtn) clearBtn.onclick = () => toggleClearConfirm(true);
    const clearCancel = byId('cfgStewardMemoryClearCancel');
    if (clearCancel) clearCancel.onclick = () => toggleClearConfirm(false);
    const clearOk = byId('cfgStewardMemoryClearOk');
    if (clearOk) clearOk.onclick = () => clearMemory();

    const refreshDecisions = byId('cfgStewardDecisionsRefreshBtn');
    if (refreshDecisions) refreshDecisions.onclick = () => { decisionsLimit = STEWARD_DECISIONS_PAGE; loadDecisions(); };
    const moreDecisions = byId('cfgStewardDecisionsMoreBtn');
    if (moreDecisions) moreDecisions.onclick = () => loadMoreDecisions();
    for (const id of ['cfgStewardDecisionsThread', 'cfgStewardDecisionsDate']) {
      const node = byId(id);
      if (node) node.addEventListener('change', () => renderDecisions());
    }

    // 页签自己的按钮就是「打开这一页」的唯一确定性时刻：懒加载两个面板，不在 fillSettings 里
    // 每次后台刷新都去打两条请求。
    const tabButton = doc().querySelector(`#settingsTabs button[data-stab="${STEWARD_SETTINGS_TAB}"]`);
    if (tabButton) tabButton.addEventListener('click', () => openPanel(''));
    return true;
  }

  // 121-K7：头像菜单只剩「细节」「设置」（§2.4／§9 K7），三样管家的东西搬进左栏栏底的口袋
  // （js/rail-pocket.js）—— 口袋、头像菜单里的「设置」与盾牌确认走的仍是这一个入口：
  // 切到「管家」页签，需要时把目标区块滚进视野，并按需拉一次面板数据。
  // section 名就是下面这张表，**不在别处再列一遍**（口袋那一份表里写的是同样这几个字符串）。
  const PANEL_SECTIONS = Object.freeze({
    schedule: 'cfgStewardGroupSchedule',
    memory: 'cfgStewardGroupMemory',
    decisions: 'cfgStewardGroupDecisions',
    index: 'cfgStewardGroupIndex',
  });
  function openPanel(section) {
    openSettingsTab(STEWARD_SETTINGS_TAB);
    fillStewardSettings();
    refreshRunState();
    if (!memoryLoaded) loadMemory();
    if (!decisionsLoaded) loadDecisions();
    if (!scheduleLoaded) loadSchedule();
    const targetId = PANEL_SECTIONS[String(section || '')] || '';
    const target = targetId ? byId(targetId) : null;
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
    return section || '';
  }

  return Object.freeze({
    bindStewardSettings,
    fillStewardSettings,
    openPanel,
    refreshRunState,
    setStopped,
    renderShield,
    // 测试与 117g/117h 复用：当前已知的停机态（只读快照）。
    isStopped: () => stopped,
    // 123-M2（§3.6）：定时任务展开的最近几次里，点产出线程要在【如意内】打开它。
    // 走 setter 而不是构造参数——构造那一行被 steward-settings.static 逐字钉着（新依赖一律迟绑定，
    // 与 drawer.setClassicWindow / setMissionRows 同一条纪律）。
    setOpenThread: handler => { openThreadHandler = typeof handler === 'function' ? handler : null; },
    // 40 号文 P0③：定时任务块订阅 schedule.changed（13r 那条帧只转发 taskId/phase/outcome 与 id，
    // 正文不进这条线）。口袋（rail-pocket）与焦点栏「接下来」（steward-drawer）早就订了，这一块没订
    // ——于是「管家自己建了一条」「到点跑完了」这两件事，在设置页要手动按刷新才看得见，而用户刚在
    // 这一页上盯着它。**仍然零计时器**：只是把「做完一个动作才刷」扩成「别处改了也刷」。
    // 没打开过这一块（scheduleLoaded 假）就不刷：不为一个没人看的列表发请求。
    setEventStream: stream => {
      if (!stream || typeof stream.on !== 'function') return false;
      try { stream.on('schedule.changed', () => { if (scheduleLoaded) void refreshScheduleFromPush(); }); }
      catch { return false; }   // 推送是旁路：订不上也不能影响这一页能用
      return true;
    },
    // 真夹具的确定性刷新口（本块没有计时器：只在打开页签、按刷新、做完一个动作这三个时刻刷）。
    loadSchedule,
  });
}
