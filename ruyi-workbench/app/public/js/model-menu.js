'use strict';

// 32 号文 §4「能复用的复用」：模型菜单这一件事原本有两个实现 —— 2.0 顶栏弹层
// （navigation-controls.js 的 openModelChipPopover：mc-row / mc-group / ↑↓ 键盘）与 3.0 管家壳
// （steward-chips.js 的 modelRow：steward-chip-option / aria-checked）。同一件事两套 DOM，用户认知与
// 维护成本都翻倍。本模块是那份公共件，只负责【造行与造分组】：
//
//   · buildModelMenuRow  —— 一行模型（两壳共用）：button 骨架、当前项标记、标签→徽标→副行→删除的落位。
//   · buildModelMenuBody —— 弹层本体（2.0）：主组 + 各 provider 组（活动组展开、其余 details 折叠）+
//                            页脚动作 + ↑↓/Enter 键盘 + 聚焦当前行。
//
// 硬边界（本波红线，别越）：
//   · 只造 DOM。写盘（onSelect / onDelete）、开合（容器显隐）、Esc / 点外收回全在调用方 —— 本模块不
//     知道 PATCH 这件事存在，两壳各自的写口因此逐字不变。
//   · 类名全部可配：两壳的行类名不同（mc-row vs steward-chip-option），这里不假设任何一套；
//     MODEL_MENU_CLASSES 是 2.0 那份，3.0 用 { ...MODEL_MENU_CLASSES, row: 'steward-chip-option' } 覆盖。
//     绝不为「统一」去改 CSS（载荷锁钉着 CSS 的 SHA，改一处就整包红）。
//   · i18n 只作【默认文案】（provider.defaultModel / modelMenu.*）；3.0 的 t 是注入的，一律经 opts
//     覆盖，所以本模块不新增任何 locale 键，也不把注入 t 抢过来用。
//
// 依赖方向：util.el（节点工厂）+ i18n.js（默认文案）。两壳都在 import 本模块，故它必须登记进 overlay 载荷。
import { el } from './util.js';
import { t, tCount } from './i18n.js';

// 2.0 弹层的类名表 —— 公共默认值。3.0 只需覆盖 row / label / badge / hint 四处，其余用不到也无害。
export const MODEL_MENU_CLASSES = Object.freeze({
  root: 'mc-pop',
  group: 'mc-group',
  groupDot: 'mc-gdot',
  groupLabel: 'mc-glabel',
  groupCount: 'mc-gcount',
  groupSwitchNote: 'mc-switch-note',
  groupDetails: 'mc-groupd',
  groupSummary: 'mc-group mc-group-sum',
  row: 'mc-row',
  rowActive: 'active',
  rowDisabled: 'disabled',
  rowAction: 'mc-action',
  check: 'mc-check',
  label: 'mc-rlabel',
  badge: 'mc-ctxlen',
  hint: 'mc-hint',
  del: 'mc-del',
  separator: 'mc-sep',
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
  const cn = { ...MODEL_MENU_CLASSES, ...(opts.classNames || {}) };
  const row = el('button', cn.row + (isCurrent ? ' ' + cn.rowActive : ''));
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

// 弹层本体（2.0 那颗模型 chip 的内容）。返回根元素（类名 opts.classNames.root，默认 .mc-pop）。
//   models     主组（当前引擎）的候选行
//   providers  其余分组规格 [{ id, label, colorVar, models, emptyHint, deletableIds, appendExtra }]
//   current    { providerId, modelId } —— 决定哪一组展开、哪一行是当前项
//   onSelect(providerId, modelId) 只报结果；关弹层与写盘由调用方在回调里做
//   opts       primaryGroup 主组事实 { id, label, colorVar, emptyHint, deletableIds, appendExtra }
//              classNames / noModelsHint（空态兜底文案）/ switchNote（非当前组那句「选择将切换引擎」）
//              badge / labelFor / checkGlyph / attrs（透传给每一行）/ showCheck
//              actions [{ icon, label, onClick }]（页脚动作，也进 ↑↓ 行序）
//              onDelete(modelId) / deleteTitle（行尾删除件）/ keyboard:false（不挂键盘）
//
// 分组语义（与 2.0 改前逐字一致）：活动组用 div 组头 + 直铺的行；非活动组包在 <details> 里，summary 上
// 挂标签 + 模型数 + 「选择将切换引擎」。appendExtra(container) 是分组自带的额外件（两壳的 thinking /
// reasoning effort 选择器就挂在这），活动组挂在行后、折叠组挂在 details 里。
export function buildModelMenuBody({ models = [], providers = [], current = {}, onSelect = () => {}, opts = {} }) {
  const cn = { ...MODEL_MENU_CLASSES, ...(opts.classNames || {}) };
  const curPid = current.providerId || '';
  const curModel = current.modelId || '';
  const root = el('div', cn.root);
  const rows = []; // 可聚焦行序（视觉顺序）：键盘导航只认它
  const switchNote = textOr(opts.switchNote, t('modelMenu.switchesEngine'));

  const buildRows = (container, pid, groupModels, emptyHint, deletableIds) => {
    const list = (groupModels && groupModels.length) ? groupModels : [];
    if (!list.length) { container.appendChild(el('div', cn.row + ' ' + cn.rowDisabled, textOr(emptyHint, opts.noModelsHint))); return; }
    for (const model of list) {
      const node = buildModelMenuRow({
        model,
        isCurrent: (pid === curPid) && ((model.id || '') === (curModel || '')),
        onSelect: hit => onSelect(pid, hit.id || ''),
        opts: { ...opts, classNames: cn, deletableIds },
      });
      rows.push(node);
      container.appendChild(node);
    }
  };
  const addGroup = (pid, label, colorVar, groupModels, emptyHint, deletableIds, appendExtra) => {
    const count = (groupModels && groupModels.length) || 0;
    if (pid === curPid) {
      const head = el('div', cn.group);
      const dot = el('span', cn.groupDot); dot.style.background = colorVar;
      head.append(dot, el('span', cn.groupLabel, label), el('span', cn.groupCount, '· ' + tCount('modelMenu.modelCount', count)));
      root.appendChild(head);
      buildRows(root, pid, groupModels, emptyHint, deletableIds);
      if (appendExtra) appendExtra(root);
    } else {
      const details = el('details', cn.groupDetails);
      const summary = el('summary', cn.groupSummary);
      const dot = el('span', cn.groupDot); dot.style.background = colorVar;
      summary.append(dot, el('span', cn.groupLabel, label), el('span', cn.groupCount, '· ' + tCount('modelMenu.modelCount', count)),
        el('span', cn.groupSwitchNote, switchNote));
      details.appendChild(summary);
      buildRows(details, pid, groupModels, emptyHint, deletableIds);
      if (appendExtra) appendExtra(details);
      root.appendChild(details);
    }
  };

  const primary = opts.primaryGroup || {};
  addGroup(primary.id || '', primary.label || '', primary.colorVar || '', models,
    primary.emptyHint, primary.deletableIds || null, primary.appendExtra || null);
  for (const group of (providers || [])) {
    addGroup(group.id || '', group.label || '', group.colorVar || '', group.models || [],
      group.emptyHint, group.deletableIds || null, group.appendExtra || null);
  }

  const actions = opts.actions || [];
  if (actions.length) {
    root.appendChild(el('div', cn.separator));
    for (const action of actions) {
      const node = el('button', cn.row + ' ' + cn.rowAction);
      node.type = 'button';
      node.append(el('span', cn.check, action.icon), el('span', cn.label, action.label));
      node.onclick = () => action.onClick();
      root.append(node);
      rows.push(node);
    }
  }

  if (opts.keyboard !== false) {
    // ↑↓ 移动、Enter 激活当前焦点行（焦点不在行上时按 Enter 落在 idx 指的那一行）。SELECT 上的键
    // （分组里那个下拉）必须原样放行，否则方向键会被吃在这里、下拉选不动。
    let idx = Math.max(0, rows.findIndex(row => row.classList.contains(cn.rowActive)));
    setTimeout(() => { (rows[idx] || rows[0])?.focus(); }, 0);
    root.addEventListener('keydown', event => {
      if (event.target && event.target.tagName === 'SELECT') return;
      if (event.key === 'ArrowDown') { event.preventDefault(); idx = Math.min(rows.length - 1, idx + 1); rows[idx].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); idx = Math.max(0, idx - 1); rows[idx].focus(); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        const active = (globalThis.document || {}).activeElement;
        (active && rows.includes(active) ? active : rows[idx])?.click();
      }
    });
  }
  return root;
}
