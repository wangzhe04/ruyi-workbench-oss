'use strict';
import { bindModelSelect, providerModels, agentModels, fillProviderSelect } from './model-catalog.js';

// EC-D 第61波：Agent 角色设置领域（库加载、草稿编辑、保存与子代理偏好选择）。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, toast, chatProviders } from './util.js';
import { t } from './i18n.js';
import { confirmDanger } from './confirm-panel.js';

// 角色颜色 = tokens.css 里 9 枚 --role-* 调色板（第23波；工作流画布的角色胶囊 / 左色条读同一组）。取值与那份调色板逐一相同，
// 服务端 normalizeAgentRole 只把 color 当 ≤32 字的字符串收，不限定集合；候选以这里为准，手编进来的别的值在下拉里补一条「自定义」不丢。
export const AGENT_ROLE_COLORS = Object.freeze(['blue', 'green', 'orange', 'purple', 'teal', 'cyan', 'red', 'amber', 'indigo']);
const ROLE_COLOR_TOKEN_RE = /^[a-z0-9_-]{1,32}$/i;
// 色块的底色：调色板里的名字走 CSS 变量（两主题通用），空值透明，认不出的名字退回 --muted。
export function roleColorCss(value) {
  const v = String(value || '').trim();
  return v && ROLE_COLOR_TOKEN_RE.test(v) ? `var(--role-${v}, var(--muted))` : 'transparent';
}
// 草稿合并（内置角色 ＋ 全局覆盖）：空颜色不盖掉内置角色的颜色。修前 {...base, ...override} 让存盘时带出的 color:'' 把内置的蓝/绿/橙…抹成无色。
export function mergeRoleDraft(base, override) {
  const merged = { ...base, ...override, models: { ...(base.models || {}), ...(override.models || {}) }, budgets: { ...(base.budgets || {}), ...(override.budgets || {}) } };
  const color = String(override.color || '').trim() || String(base.color || '').trim();
  if (color) merged.color = color; else delete merged.color;
  return merged;
}
function splitRoleList(value) { return String(value || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean); }
// 一张角色编辑卡 → 一条角色草稿。抽成纯函数（只用 card.querySelector / card.dataset），单测拿假卡直接喂。
// color 必须原样带回：修前这里不读它，保存时服务端 normalizeAgentRole 把缺失的 color 收成 ''，内置角色的颜色就此丢失。
export function readRoleCard(card) {
  const field = name => card.querySelector(`[data-role-field="${name}"]`);
  const colorField = field('color');
  return {
    id: field('id').value.trim(),
    label: field('label').value.trim(),
    description: field('description').value.trim(),
    prompt: field('prompt').value.trim(),
    toolTier: field('toolTier').value,
    models: { openai: field('openaiModel').value.trim(), claude: field('claudeModel').value.trim() || 'inherit' },
    openaiTools: splitRoleList(field('openaiTools').value),
    claudeTools: splitRoleList(field('claudeTools').value),
    mcpServers: splitRoleList(field('mcpServers').value),
    permissionMode: field('permissionMode').value,
    budgets: { openai: Number(field('openaiBudget').value) || 100, claude: Number(field('claudeBudget').value) || 100 },
    isolation: field('isolation').value,
    color: colorField ? String(colorField.value || '').trim() : '',
    builtin: card.dataset.builtin === '1',
  };
}

// 角色摘要行与下拉共用的枚举 → 文案键（走查 W1：摘要曾直接印原始枚举 Explorer · read · plan，中文界面里全是英文）。
export const ROLE_TOOL_TIER_KEYS = Object.freeze({ read: 'role.toolTierRead', edit: 'role.toolTierEdit', exec: 'role.toolTierExec' });
export const ROLE_PERMISSION_KEYS = Object.freeze({ inherit: 'role.permInherit', default: 'role.permConfirm', acceptEdits: 'role.permAutoEdit', dontAsk: 'role.permDeny', plan: 'role.permReadOnly', auto: 'role.permSmart', bypass: 'role.permSkip' });
// 一条角色在「保存比对」里要看的字段，规整成同一个形状（草稿侧是 readRoleCard 的产物，内置侧是服务端 normalizeAgentRole 的产物，
// 多出来的 source/builtin 之类不参与比对）。
function roleComparable(role) {
  const r = role || {};
  const list = value => (Array.isArray(value) ? value.map(item => String(item).trim()) : []);
  const text = value => String(value || '').trim();   // readRoleCard 读框时 trim 过，内置侧的原文可能带首尾空白/换行
  return {
    id: text(r.id), label: text(r.label), description: text(r.description), prompt: text(r.prompt),
    toolTier: String(r.toolTier || 'read'), permissionMode: String(r.permissionMode || 'inherit'), isolation: String(r.isolation || 'none'),
    color: String(r.color || '').trim(),
    models: { openai: text(r.models && r.models.openai), claude: text(r.models && r.models.claude) || 'inherit' },
    budgets: { openai: Number(r.budgets && r.budgets.openai) || 100, claude: Number(r.budgets && r.budgets.claude) || 100 },
    openaiTools: list(r.openaiTools), claudeTools: list(r.claudeTools), mcpServers: list(r.mcpServers),
  };
}
export function roleEqualsBuiltin(role, builtinRoles) {
  const base = (Array.isArray(builtinRoles) ? builtinRoles : []).find(b => b && b.id === (role && role.id));
  return Boolean(base) && JSON.stringify(roleComparable(role)) === JSON.stringify(roleComparable(base));
}
// 走查 W1-12：「保存角色」把整份草稿（含从没动过的 10 个内置角色）写进 config.agentRoleOverrides —— 之后内置角色的改进不再生效，
// 「恢复默认」也取消不了覆盖。全局范围保存前，与内置同 id 且逐字段相等的条目不写（等于没有覆盖）；项目范围不过滤。
export function rolesToSave(draft, builtinRoles, scope) {
  const roles = Array.isArray(draft) ? draft : [];
  if (scope === 'project') return roles;
  return roles.filter(role => !(role && role.builtin && roleEqualsBuiltin(role, builtinRoles)));
}

export function createAgentRolesDomain({
  apiErrText = error => String(error && error.message || error || ''),
  currentWorkspace = () => '',
} = {}) {
let agentRoleLibraryData = null;
let agentRoleDraft = [];
// 走查 W1-5：编辑区的「未保存」标记。修前切走再切回页签（loadAgentRoles）与切范围（resetAgentRoleDraft）都会把没存的编辑静默覆盖。
// 输入/下拉变化、加角色、删/恢复默认置脏；保存成功、从服务端重载草稿清除。
let agentRoleDirty = false;
let agentRoleScopeApplied = 'global';   // 当前草稿对应的范围：切范围被取消时据此把下拉退回去
const markRoleDirty = () => { agentRoleDirty = true; };
const confirmDiscardRoles = () => confirmDanger({ titleKey: 'role.discardTitle', bodyKey: 'role.discardBody', okKey: 'role.discardOk' });
function captureAgentRoleDraft() {
  const cards = [...document.querySelectorAll('#agentRoleEditorList .agent-role-edit-card')];
  if (!cards.length) return agentRoleDraft;
  agentRoleDraft = cards.map(readRoleCard).filter(r => r.id);
  return agentRoleDraft;
}
function roleInput(field, value, type = 'text') { const input = document.createElement('input'); input.type = type; input.value = value == null ? '' : value; input.dataset.roleField = field; return input; }
function roleModelSelect(field, value) {
  const select = document.createElement('select'); select.dataset.roleField = field;
  bindModelSelect(select, {
    models: () => field === 'claudeModel' ? agentModels('claude', state.status?.models || [])
      : providerModels(chatProviders(state.config).find(p => p.id === (state.config.subagentPreferredProvider || state.config.activeProvider)) || chatProviders(state.config)[0]),
    value, emptyValue: field === 'claudeModel' ? 'inherit' : '', emptyLabel: () => t('role.permInherit'),
  });
  return select;
}
// 颜色下拉 ＋ 旁边的色块。内置角色没有「无颜色」这一项（空值在合并时会让位给内置色，选了也留不住）；手编进来的非调色板值补一条「自定义」。
function roleColorControl(value, builtin, onPaint) {
  const wrap = el('div', 'agent-role-color-row');
  const swatch = el('span', 'agent-role-color-swatch'); swatch.setAttribute('aria-hidden', 'true');
  const select = document.createElement('select'); select.dataset.roleField = 'color';
  const add = (v, label) => { const o = el('option', '', label); o.value = v; select.appendChild(o); };
  const current = String(value || '').trim();
  if (!builtin || !current) add('', t('role.colorNone'));
  for (const c of AGENT_ROLE_COLORS) add(c, t(`role.color.${c}`));
  if (current && !AGENT_ROLE_COLORS.includes(current)) add(current, t('role.colorCustom', { value: current }));
  select.value = current;
  const paint = () => { swatch.style.backgroundColor = roleColorCss(select.value); swatch.classList.toggle('is-empty', !select.value); if (onPaint) onPaint(select.value); };
  select.onchange = paint; paint();
  wrap.append(swatch, select);
  return wrap;
}
function roleEnumLabel(keys, value) { return keys[value] ? t(keys[value]) : String(value); }
function roleField(label, control) { const wrap = el('label', 'agent-role-field'); wrap.append(el('span', '', label), control); return wrap; }
function roleSelect(field, value, choices) { const s = document.createElement('select'); s.dataset.roleField = field; for (const [v, label] of choices) { const o = el('option', '', label); o.value = v; if (v === value) o.selected = true; s.appendChild(o); } return s; }
function renderAgentRoleEditors() {
  const host = $('agentRoleEditorList'); if (!host) return; host.textContent = '';
  const scope = $('agentRoleScope')?.value || 'global';
  $('agentRoleScopeHint').textContent = scope === 'project' ? t('role.saveToLocal') : t('role.saveGlobal');
  for (const role of agentRoleDraft) {
    const card = el('details', 'agent-role-edit-card'); card.open = agentRoleDraft.length <= 5; card.dataset.builtin = role.builtin ? '1' : '0';
    const head = el('summary', 'agent-role-edit-head');
    const dot = el('span', 'agent-role-dot'); dot.setAttribute('aria-hidden', 'true');
    // 安全走查 S3:项目来源的角色被线程权限夹过时(后端给 roleClamped / effective*),标题行如实注明实际生效的档位;声明值(下面的下拉)不动。
    const clampNote = role.roleClamped ? t('role.clampedBadge', { tier: roleEnumLabel(ROLE_TOOL_TIER_KEYS, role.effectiveToolTier || role.toolTier || 'read'), mode: roleEnumLabel(ROLE_PERMISSION_KEYS, role.effectivePermissionMode || 'inherit') }) : '';
    head.append(dot, document.createTextNode(`${role.label || role.id} · ${roleEnumLabel(ROLE_TOOL_TIER_KEYS, role.toolTier || 'read')} · ${roleEnumLabel(ROLE_PERMISSION_KEYS, role.permissionMode || 'inherit')}${clampNote}`));
    card.appendChild(head);
    const body = el('div', 'agent-role-edit-body');
    const idInput = roleInput('id', role.id); if (role.builtin) idInput.readOnly = true;
    body.append(roleField(t('role.id'), idInput), roleField(t('role.displayName'), roleInput('label', role.label)), roleField(t('role.description'), roleInput('description', role.description)));
    const prompt = document.createElement('textarea'); prompt.rows = 3; prompt.value = role.prompt || ''; prompt.dataset.roleField = 'prompt'; body.appendChild(roleField(t('role.instructions'), prompt));
    body.append(
      roleField(t('role.toolTier'), roleSelect('toolTier', role.toolTier || 'read', [['read',t('role.toolTierRead')],['edit',t('role.toolTierEdit')],['exec',t('role.toolTierExec')]])),
      roleField(t('role.permissions'), roleSelect('permissionMode', role.permissionMode || 'inherit', [['inherit',t('role.permInherit')],['default',t('role.permConfirm')],['acceptEdits',t('role.permAutoEdit')],['dontAsk',t('role.permDeny')],['plan',t('role.permReadOnly')],['auto',t('role.permSmart')],['bypass',t('role.permSkip')]])),
      roleField(t('role.color'), roleColorControl(role.color, role.builtin, value => { dot.style.backgroundColor = roleColorCss(value); dot.classList.toggle('is-empty', !value); })),
      roleField(t('role.isolation'), roleSelect('isolation', role.isolation || 'none', [['none',t('role.noIsolation')],['worktree','Git worktree']])),
      roleField(t('role.openaiModel'), roleModelSelect('openaiModel', role.models?.openai || '')),
      roleField(t('role.claudeModel'), roleModelSelect('claudeModel', role.models?.claude || 'inherit')),
      roleField(t('role.openaiIter'), roleInput('openaiBudget', role.budgets?.openai || 100, 'number')),
      roleField(t('role.claudeRounds'), roleInput('claudeBudget', role.budgets?.claude || 100, 'number')),
      roleField(t('role.openaiTools'), roleInput('openaiTools', (role.openaiTools || []).join(', '))),
      roleField(t('role.claudeTools'), roleInput('claudeTools', (role.claudeTools || []).join(', '))),
      roleField(t('role.mcpServiceId'), roleInput('mcpServers', (role.mcpServers || []).join(', ')))
    );
    const remove = el('button', 'mini danger', role.builtin ? t('role.resetDefault') : t('role.deleteRole'));
    remove.type = 'button'; remove.onclick = () => { captureAgentRoleDraft(); markRoleDirty(); if (role.builtin && agentRoleLibraryData) { const base = (agentRoleLibraryData.builtinRoles || []).find(r => r.id === role.id); agentRoleDraft = agentRoleDraft.map(r => r.id === role.id ? JSON.parse(JSON.stringify(base)) : r); } else agentRoleDraft = agentRoleDraft.filter(r => r.id !== role.id); renderAgentRoleEditors(); };
    body.appendChild(remove); card.appendChild(body); host.appendChild(card);
  }
  const nativeHost = $('nativeClaudeRoleList'); nativeHost.textContent = '';
  const native = agentRoleLibraryData?.nativeClaudeRoles || [];
  if (native.length) { nativeHost.appendChild(el('h4', 'settings-subhead', t('role.claudeNative'))); for (const r of native) nativeHost.appendChild(el('div', 'native-claude-role', `${r.label} · ${r.file || ''}`)); }
}
function resetAgentRoleDraft() {
  if (!agentRoleLibraryData) return;
  const scope = $('agentRoleScope')?.value || 'global';
  if (scope === 'project') agentRoleDraft = JSON.parse(JSON.stringify(agentRoleLibraryData.projectRoles || []));
  else {
    const map = new Map((agentRoleLibraryData.builtinRoles || []).map(r => [r.id, JSON.parse(JSON.stringify(r))]));
    for (const r of (agentRoleLibraryData.globalRoles || [])) map.set(r.id, map.has(r.id) ? mergeRoleDraft(map.get(r.id), r) : JSON.parse(JSON.stringify(r)));
    agentRoleDraft = [...map.values()];
  }
  agentRoleDirty = false;
  agentRoleScopeApplied = scope;
  renderAgentRoleEditors();
}
// opts.explicit：用户点了「刷新」。不带它的调用（切回「Agent 角色」页签）遇到未保存的编辑就原样留着、不重载；
// 带它的遇到未保存的编辑先确认再覆盖。
async function loadAgentRoles(opts) {
  if (agentRoleDirty) {
    if (!(opts && opts.explicit === true)) return;
    if (!await confirmDiscardRoles()) return;
  }
  try {
    const data = await api(`/api/agent-roles?cwd=${encodeURIComponent(currentWorkspace())}`); agentRoleLibraryData = data;
    const d = data.drivers || {}, omitted = d.claude?.omitted || [];
    $('agentRoleDriverStatus').textContent = `${t('role.driverStatus', {openai: 'OpenAI', claudeSynced: (d.claude?.synced || []).length, omitted: omitted.length || 0})}`;
    resetAgentRoleDraft();
  } catch (e) { toast(t("toast.rolesLoadFail", { p1: apiErrText(e) }), 'err'); }
}
async function saveAgentRoles() {
  captureAgentRoleDraft(); const scope = $('agentRoleScope')?.value || 'global';
  const roles = rolesToSave(agentRoleDraft, agentRoleLibraryData && agentRoleLibraryData.builtinRoles, scope);
  try { await api('/api/agent-roles', { method: 'POST', body: JSON.stringify({ scope, cwd: currentWorkspace(), roles }) }); toast(t("toast.roleSaved"), 'ok'); agentRoleDirty = false; await loadAgentRoles(); }
  catch (e) { toast(t("toast.roleSaveFail", { p1: apiErrText(e) }), 'err'); }
}
function addAgentRole() {
  captureAgentRoleDraft(); markRoleDirty(); const used = new Set(agentRoleDraft.map(r => r.id)); let n = 1, id = 'custom-agent'; while (used.has(id)) id = `custom-agent-${++n}`;
  agentRoleDraft.push({ id, label: t('role.customRoles'), description: '', prompt: '', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: [], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, isolation: 'none', color: '' }); renderAgentRoleEditors();
}

// 子代理端点/模型使用受控下拉：避免用户手抄 Provider/model id，也避免从 Kimi 切到 Ark 后
// 把上一端点的模型误送给新端点。空值仍保留既有“跟随主端点/自动分级”语义。
function populateSubagentPreferenceSelects(providerValue, modelValue) {
  const providerSel = $('cfgSubagentPreferredProvider');
  const modelSel = $('cfgSubagentPreferredModel');
  if (!providerSel || !modelSel) return;
  const providers = chatProviders(state.config);   // 子代理要的是对话端点:只做语音的服务商不列
  // W6：选项由 model-catalog.js 的 fillProviderSelect 建（「模型分配」每一行的唯一构建器；修前这里是第四份手写）。
  fillProviderSelect(providerSel, {
    providers,
    value: String(providerValue || '').trim(),
    follow: t('settings.advanced.subagentPreferredProvider.followPrimary'),
    savedLabel: value => t('settings.advanced.savedValue', { value }),
  });

  bindModelSelect(modelSel, {
    provider: () => {
      const list = chatProviders(state.config);
      const id = providerSel.value || state.config?.activeProvider || '';
      return list.find(p => p.id === id) || (!providerSel.value ? list[0] : null);
    },
    value: modelValue || '', emptyLabel: () => t('settings.advanced.subagentPreferredModel.automatic'),
  });
}

  function bindAgentRoles() {
    const refresh = $('agentRoleRefreshBtn');
    if (refresh) refresh.onclick = () => loadAgentRoles({ explicit: true });
    const add = $('agentRoleAddBtn');
    if (add) add.onclick = addAgentRole;
    const save = $('agentRoleSaveBtn');
    if (save) save.onclick = saveAgentRoles;
    const scope = $('agentRoleScope');
    if (scope) {
      scope.onchange = async () => {
        if (agentRoleDirty && !await confirmDiscardRoles()) { scope.value = agentRoleScopeApplied; return; }   // 取消 → 范围与草稿都不动
        resetAgentRoleDraft();
      };
    }
    // 编辑区里任何输入/下拉变化都置脏（事件委托：卡片每次重画，监听挂在不重画的列表容器上）。
    const editors = $('agentRoleEditorList');
    if (editors) { editors.addEventListener('input', markRoleDirty); editors.addEventListener('change', markRoleDirty); }
    const provider = $('cfgSubagentPreferredProvider');
    if (provider) provider.onchange = () => populateSubagentPreferenceSelects(provider.value, '');
  }

  return Object.freeze({
    bindAgentRoles,
    loadAgentRoles,
    populateSubagentPreferenceSelects,
  });
}
