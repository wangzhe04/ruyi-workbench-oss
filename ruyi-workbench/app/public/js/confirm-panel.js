'use strict';

// 33 号文 §4（M3-a）：3.0 管家壳的危险操作确认「四套收一套」。
//
// 修前同一个「你确定吗」在管家壳里有四种写法、四处各说各的话：
//   ① js/steward-chips.js 权限菜单里就地展开的二次确认（菜单内 DOM，不另起模态）；
//   ② js/steward-settings.js 设置页内的确认区（index.html 里的一块静态结构）；
//   ③ js/steward-board.js「停掉占用者」—— globalThis.confirm（浏览器原生）；
//   ④ js/steward-drawer.js「整单回退」—— globalThis.confirm（浏览器原生）。
// ③④ 两处的原生框是全站唯一跳出应用的浮层：不跟主题、不跟语言、焦点不归壳管，Esc/点背影
// 这些壳里统一的行为它一概没有。
//
// 本文件就是那一套的落点，建在叶子 js/modal.js 的模态原语之上（背影／Tab 焦点陷阱／焦点
// 归还／__cancel 都是那边一份，这里不复制）。职责只有两件：
//   · CONFIRM_TEXT  —— 确认文案键的【唯一登记表】。谁要问「你确定吗」，键从这里取；
//   · confirmDanger —— 统一确认件：Promise<boolean>，true = 用户按了确认。
//
// 契约：
//   · 同步变异步 —— 调用方必须 `if (!await confirmDanger(...)) return;`；返回 false 一律表示
//     「没得到允许」（取消／✕／Esc／点背影／未知确认名），调用方据此不动手；
//   · 未知确认名 **fail-closed**：拿不到键就返回 false，绝不静默放行；
//   · 任何关闭路径都要兑现这个 Promise（见 openConfirm 里的兜底 MutationObserver），
//     否则调用方会永久挂在 await 上 —— 对「停线程」「回退整单」这种动作，挂住等于点了没反应。
import { el } from './util.js';
import { t } from './i18n.js';
import { buildModal } from './modal.js';

// §8.6 那条「切全自动」弹窗必须逐条写明的五件事（键名即顺序，测试按这个顺序核对）。
// 127 波 2-quater B2（45 号文 §2-quater.2「文案会变假的几处」）：confirm3 的意思变了 —— 修前是「永久豁免的动作
// 仍然不做」，放开管家代批之后改成「底线项永远等你按；删文件／装卸软件／推送／对外请求管家可按规则带理由代批，
// 读过网页后不替你推送或外发」。键名不动，只改四份 locale 里的那一句。
// 117d 起这五条住在 steward-chips.js；M3-a 把确认文案键统一收进本文件，chips 就地改成
// re-export（`export { STEWARD_CONFIRM_KEYS }`），所以那边的调用面一个字都不用动。
const PERMISSION_CONFIRM_BODY_KEYS = Object.freeze([
  'stewardShell.permission.confirm1',
  'stewardShell.permission.confirm2',
  'stewardShell.permission.confirm3',
  'stewardShell.permission.confirm4',
  'stewardShell.permission.confirm5',
]);

// 「切哪一档权限要先出确认」的判据数据 —— 与那五条文案键同住这一份登记表：全仓唯一一处定义。
// 与 01-config 的 PERMISSION_MODES_REQUIRING_CONFIRM 同口径：四档里只有「全自动」要二次确认。
// 117d 起它住在 steward-chips.js；本刀把它和文案键一起收进本文件，chips 就地 re-export，
// 所以 chips 菜单口与 settings 设置页（onPermissionChange / toggleShield）读的是同一个数组对象。
export const STEWARD_PERMISSION_CONFIRM_MODES = Object.freeze(['auto']);

// 确认文案键登记表：全仓唯一一处。加一处新的危险操作确认 = 在这里加一条，不在调用点拼键。
// titleKey/okKey/cancelKey 走既有的 locale 键（common.confirm / common.cancel 两个语言下都有），
// 不新开文案、不动 locale。
export const CONFIRM_TEXT = Object.freeze({
  // 看板：等锁时「停掉占用者」（116h 登记项①）—— 标题复用那枚按钮自己的说法。
  stopBlocker: Object.freeze({
    titleKey: 'stewardShell.board.stopBlocker',
    bodyKey: 'stewardShell.board.stopBlockerConfirm',
    okKey: 'common.confirm',
    cancelKey: 'common.cancel',
  }),
  // 抽屉：整单回退（退到第一条用户消息之前）。标题复用底部那枚按钮的说法。
  rewindAll: Object.freeze({
    titleKey: 'stewardShell.drawer.rewindAll',
    bodyKey: 'stewardShell.drawer.rewindConfirm',
    okKey: 'common.confirm',
    cancelKey: 'common.cancel',
  }),
  // 定时任务两枚不可逆动作（123-M2 登记①／40 号文 P0）。「立即运行」不是预览:它真的起一个回合,
  // 花钱、而且可能对外做事;「删除」是彻底没了。两条都从这张表取键,调用点不拼键。
  scheduleRunNow: Object.freeze({
    titleKey: 'settings.steward.schedule.runNow',
    bodyKey: 'settings.steward.schedule.runNowConfirm',
    okKey: 'common.confirm',
    cancelKey: 'common.cancel',
  }),
  scheduleDelete: Object.freeze({
    titleKey: 'settings.steward.schedule.delete',
    bodyKey: 'settings.steward.schedule.deleteConfirm',
    okKey: 'common.confirm',
    cancelKey: 'common.cancel',
  }),
  // 107-S1 ④（46 号文 §5 ⑦b H1）：管家给的按钮属于 confirm 族（改设置／改技能／给线程开桌面）时，
  // 按下去之前先把「要改哪些键、改成什么」逐条摆出来。**清单是服务端派生的纯文本**（act.confirmItems，
  // 13o stewardActConfirmLines：键名 + 已脱敏并裁剪的值），所以这张表只有标题与引子两个文案键，
  // 正文由 listItems 传进来 —— 模型写的任何一个字都进不了这张面板。
  stewardActConfirm: Object.freeze({
    titleKey: 'stewardShell.acts.confirmTitle',
    bodyKey: 'stewardShell.acts.confirmBody',
    okKey: 'common.confirm',
    cancelKey: 'common.cancel',
  }),
  // 「本轮变更」的撤销（聊天里那张卡与右栏「变更」页签共用）。修前用浏览器原生 confirm（标题是「127.0.0.1:xxxx 显示」，
  // 像钓鱼框），且「撤销新建」也写「恢复到改动前的内容」—— 实际是把文件删掉。正文按那条改动的 op 分三种说法。
  revertTurn: Object.freeze({ titleKey: 'changes.revertTurn.confirmTitle', bodyKey: 'changes.revertTurn.confirm', okKey: 'changes.revertTurn', cancelKey: 'common.cancel' }),
  revertFileCreate: Object.freeze({ titleKey: 'changes.revert.confirmTitle', bodyKey: 'changes.revert.confirm.create', okKey: 'changes.revert', cancelKey: 'common.cancel' }),
  revertFileModify: Object.freeze({ titleKey: 'changes.revert.confirmTitle', bodyKey: 'changes.revert.confirm', okKey: 'changes.revert', cancelKey: 'common.cancel' }),
  revertFileDelete: Object.freeze({ titleKey: 'changes.revert.confirmTitle', bodyKey: 'changes.revert.confirm.delete', okKey: 'changes.revert', cancelKey: 'common.cancel' }),
  // 权限切「全自动」：chips 菜单内与设置页两处共用（那两处保持就地形态，理由见各自文件）。
  permissionAuto: Object.freeze({
    titleKey: 'stewardShell.permission.confirmTitle',
    bodyKey: '',
    listKeys: PERMISSION_CONFIRM_BODY_KEYS,
    okKey: 'stewardShell.permission.confirmOk',
    cancelKey: 'stewardShell.permission.confirmCancel',
  }),
});

// 旧名沿用（117d 起的公开面）：§8.6 那五条的正身。steward-chips.js 从这里 re-export。
export { PERMISSION_CONFIRM_BODY_KEYS as STEWARD_CONFIRM_KEYS };

// 单一确认件。两种用法：
//   confirmDanger({ name: 'stopBlocker', bodyParams: { title } })   ← 键从登记表取（推荐）
//   confirmDanger({ titleKey, bodyKey, okKey, cancelKey })          ← 显式键（登记表没有的一次性确认）
// 107-S1 ④：listItems 是【已经是人话的纯文本】清单（与 listKeys 的「locale 键清单」并列，两者可同时给）。
//   它存在的理由：管家那一族要列的是服务端按 args 派生的「键 = 新值」，不可能预先做成 locale 键。
//   渲染一律走 el('li', '', text)（textContent），零 innerHTML —— 与本文件其余部分同一条纪律。
export function confirmDanger({
  name = '',
  titleKey = '',
  bodyKey = '',
  bodyParams = null,
  listKeys = null,
  listItems = null,
  okKey = 'common.confirm',
  cancelKey = 'common.cancel',
} = {}) {
  const spec = name ? CONFIRM_TEXT[name] : null;
  // fail-closed：确认名写错时不能「没键可渲染就当作同意」，危险操作一律当作没得到允许。
  if (name && !spec) return Promise.resolve(false);
  const title = titleKey || (spec && spec.titleKey) || '';
  const bodyKeyFinal = bodyKey || (spec && spec.bodyKey) || '';
  const listKeysFinal = listKeys || (spec && spec.listKeys) || null;
  const okKeyFinal = okKey || (spec && spec.okKey) || 'common.confirm';
  const cancelKeyFinal = cancelKey || (spec && spec.cancelKey) || 'common.cancel';
  return new Promise(resolve => {
    let settled = false;
    const settle = value => { if (settled) return; settled = true; resolve(value); };
    const body = el('div', 'confirm-body');
    if (bodyKeyFinal) body.appendChild(el('p', '', t(bodyKeyFinal, bodyParams || undefined)));
    if (listKeysFinal && listKeysFinal.length) {
      const list = el('ul', 'confirm-list');
      for (const key of listKeysFinal) list.appendChild(el('li', '', t(key)));
      body.appendChild(list);
    }
    // 107-S1 ④：纯文本清单（服务端派生的「键 = 新值」）。与上面那一段同一个 <ul class="confirm-list"> 样式，
    // 只是文案不过 t() —— 它本来就不是 locale 键。
    if (Array.isArray(listItems) && listItems.length) {
      const list = el('ul', 'confirm-list');
      for (const item of listItems) list.appendChild(el('li', '', String(item == null ? '' : item)));
      body.appendChild(list);
    }
    const foot = el('div', 'confirm-foot');
    const cancelBtn = el('button', 'btn btn-sm', t(cancelKeyFinal));
    cancelBtn.type = 'button';
    cancelBtn.dataset.confirm = 'cancel';
    const okBtn = el('button', 'btn btn-sm', t(okKeyFinal));
    okBtn.type = 'button';
    okBtn.dataset.confirm = 'ok';
    foot.append(cancelBtn, okBtn);
    const modal = buildModal({
      title: t(title),
      body,
      foot,
      // 取消路径（✕／Esc／点背影／「取消」）由 buildModal 的 onCancel 兑出来。
      onCancel: () => settle(false),
      size: 'small',
      extraClass: 'dynamic confirm-panel',
    });
    okBtn.onclick = () => { settle(true); modal.close(); };
    cancelBtn.onclick = () => { settle(false); modal.cancel(); };
    // buildModal 只对「取消」这条路回调；外部若走 __close／close()（非取消语义）就没人兑现。
    // 兜底：背影一旦离开文档，就意味着这一问已经结束 —— 没settle 过的一律按「没得到允许」算。
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(() => {
        if (modal.backdrop.isConnected) return;
        observer.disconnect();
        settle(false);
      });
      observer.observe(document.body, { childList: true });
    }
    // 危险操作的默认焦点给「取消」（buildModal 自己会先聚焦到 ✕，这里覆盖成更安全的落点）。
    setTimeout(() => { try { cancelBtn.focus(); } catch { /* 宿主没有 focus 就随它 */ } }, 0);
  });
}
