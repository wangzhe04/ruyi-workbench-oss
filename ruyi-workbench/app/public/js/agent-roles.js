'use strict';

// EC-D 第61波：Agent 角色设置领域（库加载、草稿编辑、保存与子代理偏好选择）。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, toast } from './util.js';
import { t } from './i18n.js';

export function createAgentRolesDomain({
  apiErrText = error => String(error && error.message || error || ''),
  currentWorkspace = () => '',
} = {}) {
let agentRoleLibraryData = null;
let agentRoleDraft = [];
function mergeRoleDraft(base, override) {
  return { ...base, ...override, models: { ...(base.models || {}), ...(override.models || {}) }, budgets: { ...(base.budgets || {}), ...(override.budgets || {}) } };
}
function splitRoleList(value) { return String(value || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean); }
function captureAgentRoleDraft() {
  const cards = [...document.querySelectorAll('#agentRoleEditorList .agent-role-edit-card')];
  if (!cards.length) return agentRoleDraft;
  agentRoleDraft = cards.map(card => ({
    id: card.querySelector('[data-role-field="id"]').value.trim(),
    label: card.querySelector('[data-role-field="label"]').value.trim(),
    description: card.querySelector('[data-role-field="description"]').value.trim(),
    prompt: card.querySelector('[data-role-field="prompt"]').value.trim(),
    toolTier: card.querySelector('[data-role-field="toolTier"]').value,
    models: { openai: card.querySelector('[data-role-field="openaiModel"]').value.trim(), claude: card.querySelector('[data-role-field="claudeModel"]').value.trim() || 'inherit' },
    openaiTools: splitRoleList(card.querySelector('[data-role-field="openaiTools"]').value),
    claudeTools: splitRoleList(card.querySelector('[data-role-field="claudeTools"]').value),
    mcpServers: splitRoleList(card.querySelector('[data-role-field="mcpServers"]').value),
    permissionMode: card.querySelector('[data-role-field="permissionMode"]').value,
    budgets: { openai: Number(card.querySelector('[data-role-field="openaiBudget"]').value) || 100, claude: Number(card.querySelector('[data-role-field="claudeBudget"]').value) || 100 },
    isolation: card.querySelector('[data-role-field="isolation"]').value,
    builtin: card.dataset.builtin === '1',
  })).filter(r => r.id);
  return agentRoleDraft;
}
function roleInput(field, value, type = 'text') { const input = document.createElement('input'); input.type = type; input.value = value == null ? '' : value; input.dataset.roleField = field; return input; }
function roleField(label, control) { const wrap = el('label', 'agent-role-field'); wrap.append(el('span', '', label), control); return wrap; }
function roleSelect(field, value, choices) { const s = document.createElement('select'); s.dataset.roleField = field; for (const [v, label] of choices) { const o = el('option', '', label); o.value = v; if (v === value) o.selected = true; s.appendChild(o); } return s; }
function renderAgentRoleEditors() {
  const host = $('agentRoleEditorList'); if (!host) return; host.textContent = '';
  const scope = $('agentRoleScope')?.value || 'global';
  $('agentRoleScopeHint').textContent = scope === 'project' ? `${t('role.saveToLocal')}` : '保存在本机配置中，对所有项目生效；内置角色可在这里覆盖。';
  for (const role of agentRoleDraft) {
    const card = el('details', 'agent-role-edit-card'); card.open = agentRoleDraft.length <= 5; card.dataset.builtin = role.builtin ? '1' : '0';
    card.appendChild(el('summary', 'agent-role-edit-head', `${role.label || role.id} · ${role.toolTier || 'read'} · ${role.permissionMode || 'inherit'}`));
    const body = el('div', 'agent-role-edit-body');
    const idInput = roleInput('id', role.id); if (role.builtin) idInput.readOnly = true;
    body.append(roleField(t('role.id'), idInput), roleField(t('role.displayName'), roleInput('label', role.label)), roleField(t('role.description'), roleInput('description', role.description)));
    const prompt = document.createElement('textarea'); prompt.rows = 3; prompt.value = role.prompt || ''; prompt.dataset.roleField = 'prompt'; body.appendChild(roleField(t('role.instructions'), prompt));
    body.append(
      roleField(t('role.toolTier'), roleSelect('toolTier', role.toolTier || 'read', [['read',t('role.toolTierRead')],['edit',t('role.toolTierEdit')],['exec',t('role.toolTierExec')]])),
      roleField(t('role.permissions'), roleSelect('permissionMode', role.permissionMode || 'inherit', [['inherit',t('role.permInherit')],['default',t('role.permConfirm')],['acceptEdits',t('role.permAutoEdit')],['dontAsk',t('role.permDeny')],['plan',t('role.permReadOnly')],['auto',t('role.permSmart')],['bypass',t('role.permSkip')]])),
      roleField(t('role.isolation'), roleSelect('isolation', role.isolation || 'none', [['none',t('role.noIsolation')],['worktree','Git worktree']])),
      roleField(t('role.openaiModel'), roleInput('openaiModel', role.models?.openai || '')),
      roleField(t('role.claudeModel'), roleInput('claudeModel', role.models?.claude || 'inherit')),
      roleField(t('role.openaiIter'), roleInput('openaiBudget', role.budgets?.openai || 100, 'number')),
      roleField(t('role.claudeRounds'), roleInput('claudeBudget', role.budgets?.claude || 100, 'number')),
      roleField(t('role.openaiTools'), roleInput('openaiTools', (role.openaiTools || []).join(', '))),
      roleField(t('role.claudeTools'), roleInput('claudeTools', (role.claudeTools || []).join(', '))),
      roleField(t('role.mcpServiceId'), roleInput('mcpServers', (role.mcpServers || []).join(', ')))
    );
    const remove = el('button', 'mini danger', role.builtin ? t('role.resetDefault') : t('role.deleteRole'));
    remove.type = 'button'; remove.onclick = () => { captureAgentRoleDraft(); if (role.builtin && agentRoleLibraryData) { const base = (agentRoleLibraryData.builtinRoles || []).find(r => r.id === role.id); agentRoleDraft = agentRoleDraft.map(r => r.id === role.id ? JSON.parse(JSON.stringify(base)) : r); } else agentRoleDraft = agentRoleDraft.filter(r => r.id !== role.id); renderAgentRoleEditors(); };
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
  renderAgentRoleEditors();
}
async function loadAgentRoles() {
  try {
    const data = await api(`/api/agent-roles?cwd=${encodeURIComponent(currentWorkspace())}`); agentRoleLibraryData = data;
    const d = data.drivers || {}, omitted = d.claude?.omitted || [];
    $('agentRoleDriverStatus').textContent = `${t('role.driverStatus', {openai: 'OpenAI', claudeSynced: (d.claude?.synced || []).length, omitted: omitted.length || 0})}`;
    resetAgentRoleDraft();
  } catch (e) { toast(t("toast.rolesLoadFail", { p1: apiErrText(e) }), 'err'); }
}
async function saveAgentRoles() {
  captureAgentRoleDraft(); const scope = $('agentRoleScope')?.value || 'global';
  try { await api('/api/agent-roles', { method: 'POST', body: JSON.stringify({ scope, cwd: currentWorkspace(), roles: agentRoleDraft }) }); toast(t("toast.roleSaved"), 'ok'); await loadAgentRoles(); }
  catch (e) { toast(t("toast.roleSaveFail", { p1: apiErrText(e) }), 'err'); }
}
function addAgentRole() {
  captureAgentRoleDraft(); const used = new Set(agentRoleDraft.map(r => r.id)); let n = 1, id = 'custom-agent'; while (used.has(id)) id = `custom-agent-${++n}`;
  agentRoleDraft.push({ id, label: t('role.customRoles'), description: '', prompt: '', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: [], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, isolation: 'none' }); renderAgentRoleEditors();
}

function subagentProviderModels(provider) {
  if (!provider) return [];
  const seen = new Set();
  const out = [];
  const add = (id, label) => {
    const value = String(id || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ id: value, label: String(label || value) });
  };
  add(provider.subagentModel);
  add(provider.model);
  for (const model of (Array.isArray(provider.models) ? provider.models : [])) {
    if (typeof model === 'string') add(model);
    else if (model) add(model.id, model.label);
  }
  return out;
}

// 子代理端点/模型使用受控下拉：避免用户手抄 Provider/model id，也避免从 Kimi 切到 Ark 后
// 把上一端点的模型误送给新端点。空值仍保留既有“跟随主端点/自动分级”语义。
function populateSubagentPreferenceSelects(providerValue, modelValue) {
  const providerSel = $('cfgSubagentPreferredProvider');
  const modelSel = $('cfgSubagentPreferredModel');
  if (!providerSel || !modelSel) return;
  const providers = Array.isArray(state.config?.providers) ? state.config.providers : [];
  const preferredProvider = String(providerValue || '').trim();
  providerSel.textContent = '';
  const follow = el('option', '', t('settings.advanced.subagentPreferredProvider.followPrimary'));
  follow.value = '';
  providerSel.appendChild(follow);
  for (const provider of providers) {
    if (!provider || !provider.id) continue;
    const option = el('option', '', provider.label || provider.id);
    option.value = provider.id;
    providerSel.appendChild(option);
  }
  if (preferredProvider && !providers.some(provider => provider && provider.id === preferredProvider)) {
    const stale = el('option', '', t('settings.advanced.savedValue', { value: preferredProvider }));
    stale.value = preferredProvider;
    providerSel.appendChild(stale);
  }
  providerSel.value = preferredProvider;

  const effectiveProviderId = preferredProvider || state.config?.activeProvider || '';
  const provider = providers.find(item => item && item.id === effectiveProviderId) || providers[0] || null;
  const models = subagentProviderModels(provider);
  const preferredModel = String(modelValue || '').trim();
  modelSel.textContent = '';
  const automatic = el('option', '', t('settings.advanced.subagentPreferredModel.automatic'));
  automatic.value = '';
  modelSel.appendChild(automatic);
  for (const model of models) {
    const option = el('option', '', model.label === model.id ? model.id : `${model.label} · ${model.id}`);
    option.value = model.id;
    modelSel.appendChild(option);
  }
  if (preferredModel && !models.some(model => model.id === preferredModel)) {
    const stale = el('option', '', t('settings.advanced.savedValue', { value: preferredModel }));
    stale.value = preferredModel;
    modelSel.appendChild(stale);
  }
  modelSel.value = preferredModel;
  modelSel.disabled = !provider;
}

  function bindAgentRoles() {
    const refresh = $('agentRoleRefreshBtn');
    if (refresh) refresh.onclick = loadAgentRoles;
    const add = $('agentRoleAddBtn');
    if (add) add.onclick = addAgentRole;
    const save = $('agentRoleSaveBtn');
    if (save) save.onclick = saveAgentRoles;
    const scope = $('agentRoleScope');
    if (scope) scope.onchange = resetAgentRoleDraft;
    const provider = $('cfgSubagentPreferredProvider');
    if (provider) provider.onchange = () => populateSubagentPreferenceSelects(provider.value, '');
  }

  return Object.freeze({
    bindAgentRoles,
    loadAgentRoles,
    populateSubagentPreferenceSelects,
  });
}
