'use strict';

// Discovery is shared by endpoint, while selection remains local to each setting/session.
const catalogs = new Map();
const selects = new Map();
const providerKey = provider => JSON.stringify([provider?.id || '', String(provider?.baseUrl || '').replace(/\/+$/, ''), provider?.apiKey || '']);

export function mergeModels(...lists) {
  const rows = new Map();
  for (const list of lists) for (const value of Array.isArray(list) ? list : []) {
    const model = typeof value === 'string' ? { id: value, label: value } : value;
    const id = String(model?.id || '').trim();
    if (id) rows.set(id, { ...rows.get(id), ...model, id, label: model.label || rows.get(id)?.label || id });
  }
  return [...rows.values()];
}

export function providerModels(provider) {
  if (!provider) return [];
  const hidden = new Set(provider.hiddenModels || []);
  return mergeModels([provider.model, provider.subagentModel].filter(Boolean),
    catalogs.get(providerKey(provider)), provider.models)
    .filter(model => !hidden.has(model.id));
}

export function agentModels(type, fallback = []) {
  return catalogs.get('agent:' + type) || mergeModels(fallback);
}

export function refreshModelSelects() {
  for (const [select, options] of selects) {
    if (select.isConnected === false) { selects.delete(select); continue; }
    fillModelSelect(select, options, select.value);
    options.onRefresh?.();
  }
}

export function publishProviderModels(provider, models, peers = []) {
  const key = providerKey(provider);
  const fresh = mergeModels(providerModels(provider), models);
  catalogs.set(key, fresh);
  for (const entry of new Set([provider, ...peers])) {
    if (entry && providerKey(entry) === key) {
      // Preserve capability annotations and unsaved edits on each local provider entry.
      entry.models = mergeModels(fresh, entry.models).filter(model => !(entry.hiddenModels || []).includes(model.id));
    }
  }
  refreshModelSelects();
}

export function publishAgentModels(type, models) {
  catalogs.set('agent:' + type, mergeModels(models));
  refreshModelSelects();
}

function fillModelSelect(select, options, value) {
  const models = options.models ? options.models() : providerModels(options.provider?.());
  const selected = String(value || '');
  const empty = String(options.emptyValue || '');
  const rows = mergeModels(models);
  // Existing custom/saved IDs remain selectable; a refresh must never change a setting.
  if (selected && selected !== empty && !rows.some(model => model.id === selected)) rows.unshift({ id: selected, label: selected });
  const option = (id, label) => {
    const node = select.ownerDocument.createElement('option');
    node.value = id; node.textContent = label; return node;
  };
  select.replaceChildren(option(empty, typeof options.emptyLabel === 'function' ? options.emptyLabel() : (options.emptyLabel || '—')),
    ...rows.filter(model => model.id !== empty).map(model => option(model.id, options.labelOnly || model.label === model.id ? model.label : `${model.label} · ${model.id}`)));
  select.value = selected;
}

export function bindModelSelect(select, options = {}) {
  if (!select) return;
  selects.set(select, options);
  fillModelSelect(select, options, options.value ?? select.value);
}

// W6 设置重组：「模型分配」每一行左边那枚「服务商」下拉的【唯一】选项构建器（修前同一件事被写了四份：
// 基础页主端点、管家三枚、子代理、句尾改错）。右边那枚模型下拉仍是上面的 bindModelSelect。
//   providers  候选服务商（调用方按这一行的口径筛过：对话端点、非 toolbox- …）
//   follow     首项「跟随…」的文案（给了才有这一项，值恒为 ''）
//   lead       排在候选之前的固定项 [{ value, label }]（主模型那一行的命令行引擎）
//   value      落盘值；不在候选里又非空时补一条「保存的值」占位（savedLabel 给文案）—— 绝不静默改写用户的盘
export function fillProviderSelect(select, { providers = [], value = '', follow = null, lead = [], savedLabel = saved => saved } = {}) {
  if (!select) return;
  const doc = select.ownerDocument;
  const option = (id, label) => {
    const node = doc.createElement('option');
    node.value = id; node.textContent = label; return node;
  };
  const nodes = [];
  const known = new Set();
  if (follow != null) { nodes.push(option('', typeof follow === 'function' ? follow() : String(follow))); known.add(''); }
  for (const item of Array.isArray(lead) ? lead : []) {
    if (!item) continue;
    nodes.push(option(String(item.value), String(item.label)));
    known.add(String(item.value));
  }
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!provider || !provider.id || known.has(String(provider.id))) continue;
    nodes.push(option(String(provider.id), String(provider.label || provider.id)));
    known.add(String(provider.id));
  }
  const saved = String(value || '');
  if (saved && !known.has(saved)) nodes.push(option(saved, savedLabel(saved)));
  select.replaceChildren(...nodes);
  select.value = saved;
  if (select.value !== saved && select.options.length) select.value = select.options[0].value;
}
