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
