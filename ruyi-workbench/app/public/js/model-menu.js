'use strict';

// 32 号文 §4「能复用的复用」：模型菜单这一件事原本有两个实现 —— 2.0 顶栏弹层
// （navigation-controls.js 的 openModelChipPopover：mc-row / mc-group / ↑↓ 键盘）与 3.0 管家壳
// （steward-chips.js 的 modelRow：steward-chip-option / aria-checked）。同一件事两套 DOM，用户认知与
// 维护成本都翻倍。本模块是那份公共件，只负责【造行与造分组】：
//
//   · buildModelMenuRow  —— 一行模型（两壳共用）：button 骨架、当前项标记、标签→徽标→副行→删除的落位。
//
// 121-K6a（34 号文 §13.8 K5 登记②）：本文件曾经导出的「弹层本体」函数（2.0 独立模型弹层，约 100
// 行）随那颗弹层一起退役——`js/thread-head.js` 换成 `createQuickSwitchChips`（一份工厂，两视角共用）
// 之后，`js/navigation-controls.js` 的模型弹层打开口已经删了唯一调用点（K5 交付），该函数从此零调用，
// 本刀整段删除（验收：仓内 `public/` 对它的旧导出名零命中）。它的类名族（`.mc-pop`／`.mc-row` 一族）
// CSS 归 K8（避免多钉一次 CSS 载荷锁），本刀不动 css/。
//
// 硬边界（本波红线，别越）：
//   · 只造 DOM。写盘（onSelect / onDelete）、开合（容器显隐）、Esc / 点外收回全在调用方 —— 本模块不
//     知道 PATCH 这件事存在，两壳各自的写口因此逐字不变。
//   · 类名全部可配：两壳的行类名不同（mc-row vs steward-chip-option），这里不假设任何一套；
//     MODEL_MENU_CLASSES 是 2.0 那份，3.0 用 { ...MODEL_MENU_CLASSES, row: 'steward-chip-option' } 覆盖。
//     绝不为「统一」去改 CSS（载荷锁钉着 CSS 的 SHA，改一处就整包红）。
//     37 号文 §3.7（123-M3）：K8 把 2.0 那族 CSS（.mc-pop/.mc-group*/.mc-row*/.mc-switch-note/.mc-sep）
//     整段删过之后，表里对应的 mc-* 字面量就成了「造出来但没有一条 CSS 规则认」的死字符串——`grep -rn
//     "mc-" public/css public/js` 核过：除本文件的表定义外零命中。已删（root/group*/row/rowDisabled/
//     rowAction/check/label/badge/hint/separator）；`buildModelMenuRow` 改成内部兜底空串，唯一调用方
//     （steward-chips.js）逐字不变。只留两条仍有真实消费的：rowActive（'active'，全仓通用状态类）与
//     del（'mc-del'，chat-shell.css 267/269 行还在渲染自定义模型行尾那枚 ×）。
//   · i18n 只作【默认文案】（provider.defaultModel / modelMenu.*）；3.0 的 t 是注入的，一律经 opts
//     覆盖，所以本模块不新增任何 locale 键，也不把注入 t 抢过来用。
//
// 依赖方向：util.el（节点工厂）+ i18n.js（默认文案）。两壳都在 import 本模块，故它必须登记进 overlay 载荷。
import { el } from './util.js';
import { t } from './i18n.js';

// 2.0 弹层的类名表 —— 曾经是那颗弹层的公共默认值；它的 CSS 家族已被 K8 整段删除（见上面 123-M3 的
// 登记），表里只留仍有真实 CSS 或全仓通用语义的两项。row / check / label / badge / hint 不再在这里给
// 默认值——3.0（唯一调用方）逐条覆盖 row/label/badge/hint，check 由 buildModelMenuRow 内部兜底空串。
export const MODEL_MENU_CLASSES = Object.freeze({
  rowActive: 'active',
  del: 'mc-del',
});

// 分组行/取消标记等文案：null/undefined 与「空串」语义不同（2.0 的 Claude 组空态就是空串 = 什么都不写），
// 所以这里不用 || 合并。
function textOr(value, fallback) {
  if (value != null) return value;
  return fallback != null ? fallback : '';
}

// 一行模型。骨架与落位在两壳之间逐字一致，差异全部走 opts：
//   classNames  类名表（默认 MODEL_MENU_CLASSES）
//   showCheck   false = 不摆 ✓ 列（3.0 用 role=menuitemradio + aria-checked 表达当前项）
//   labelFor    标签文本（默认 model.label || model.id || t('provider.defaultModel')）
//   label       自定义标签节点（3.0 的搜索命中高亮要往标签里塞多段 span）
//   badge(model) → { className?, text } | null     标签之后的徽标（2.0 的 128K/1M，3.0 的「默认」）
//   hint(model)  → { className?, text } | null     徽标之后的副行（3.0 的用量行；2.0 无）
//   attrs(model) → { 属性名: 值, dataset: {…} }    额外属性（3.0 的 role/aria-checked/dataset）
//   deletableIds/onDelete/deleteTitle              行尾删除件（2.0 的自定义模型 ×）
// onSelect(model) 只报「选了哪一行」——关菜单、写盘都归调用方。
export function buildModelMenuRow({ model = {}, isCurrent = false, onSelect = () => {}, opts = {} }) {
  // row/check/label/badge/hint 的空串兜底跟 MODEL_MENU_CLASSES 无关——那张表已经不再假装给这几个键
  // 配默认类名（37 号文 §3.7）；没有调用方覆盖时宁可不带 class，也不要把 undefined 拼进字符串里。
  const cn = { row: '', check: '', label: '', badge: '', hint: '', ...MODEL_MENU_CLASSES, ...(opts.classNames || {}) };
  const row = el('button', [cn.row, isCurrent ? cn.rowActive : null].filter(Boolean).join(' '));
  row.type = 'button';
  const attrs = typeof opts.attrs === 'function' ? opts.attrs(model, isCurrent) : null;
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value == null) continue;
      if (key === 'dataset') { for (const name of Object.keys(value)) row.dataset[name] = value[name]; }
      else row.setAttribute(key, value);
    }
  }
  if (opts.showCheck !== false) row.append(el('span', cn.check, isCurrent ? (opts.checkGlyph || '✓') : ''));
  const labelNode = typeof opts.label === 'function' ? opts.label(model, isCurrent) : null;
  row.append(labelNode || el('span', cn.label,
    typeof opts.labelFor === 'function' ? opts.labelFor(model, isCurrent) : (model.label || model.id || t('provider.defaultModel'))));
  const badge = typeof opts.badge === 'function' ? opts.badge(model, isCurrent) : null;
  if (badge) row.append(el('span', badge.className || cn.badge, badge.text));
  const hint = typeof opts.hint === 'function' ? opts.hint(model, isCurrent) : null;
  if (hint) row.append(el('span', hint.className || cn.hint, hint.text));
  if (opts.deletableIds && model.id && typeof opts.deletableIds.has === 'function' && opts.deletableIds.has(model.id)) {
    const del = el('span', cn.del, '×');
    del.title = textOr(opts.deleteTitle, t('modelMenu.deleteCustomModel'));
    del.setAttribute('role', 'button');
    // 行本身是 <button>，删除件只能靠 stopPropagation 把这次点击从「选中这一行」里摘出来。
    del.onclick = async event => {
      event.stopPropagation();
      if (typeof opts.onDelete === 'function') await opts.onDelete(model.id);
    };
    row.append(del);
  }
  row.onclick = () => onSelect(model);
  return row;
}

