'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function catalog() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/model-catalog.js'), 'utf8');
  return vm.runInNewContext(source.replace(/^export /gm, '') + '\n({ providerModels, publishProviderModels, bindModelSelect, refreshModelSelects, agentModels, publishAgentModels })');
}
function select(value = '') {
  return { value, isConnected: true, children: [], ownerDocument: { createElement: () => ({}) },
    replaceChildren(...children) { this.children = children; },
  };
}
const ids = node => node.children.map(option => option.value);

test('refresh updates every selector for the same endpoint without changing selections or drafts', () => {
  const c = catalog();
  const saved = { id: 'a', baseUrl: 'https://a/v1', model: 'old', models: [{ id: 'old' }] };
  const draft = { ...saved, model: 'draft-model', temperature: '0.3', models: [{ id: 'asr', caps: ['asr'] }] };
  const main = select(), steward = select(), settings = select();
  c.bindModelSelect(main, { provider: () => saved, value: 'old' });
  c.bindModelSelect(steward, { provider: () => saved, value: '' });
  c.bindModelSelect(settings, { provider: () => draft, value: 'draft-model' });
  c.publishProviderModels(saved, [{ id: 'new' }], [draft]);
  for (const node of [main, steward, settings]) assert.ok(ids(node).includes('new'));
  assert.equal(main.value, 'old'); assert.equal(steward.value, ''); assert.equal(settings.value, 'draft-model');
  assert.equal(draft.temperature, '0.3'); assert.equal(draft.model, 'draft-model');
  assert.ok(c.providerModels(draft).find(m => m.id === 'asr').caps.includes('asr'));
  c.publishProviderModels(draft, [{ id: 'from-test-connection' }], [saved]);
  assert.ok(ids(main).includes('from-test-connection'));
});

test('providers, edited endpoints and credentials do not share discoveries', () => {
  const c = catalog(), provider = { id: 'a', baseUrl: 'https://a', apiKey: 'one', models: [] };
  const peers = [{ ...provider, id: 'b' }, { ...provider, baseUrl: 'https://b' }, { ...provider, apiKey: 'two' }];
  c.publishProviderModels(provider, [{ id: 'private' }], peers);
  for (const peer of peers) assert.equal(c.providerModels(peer).length, 0);
});

test('config reload retains discovery; hidden models stay hidden and saved custom values survive', () => {
  const c = catalog(), original = { id: 'a', baseUrl: 'https://a/', models: [] };
  c.publishProviderModels(original, [{ id: 'fresh' }, { id: 'hidden' }]);
  const reloaded = { id: 'a', baseUrl: 'https://a', hiddenModels: ['hidden'], models: [] };
  assert.deepEqual(Array.from(c.providerModels(reloaded), m => m.id), ['fresh']);
  const node = select(); c.bindModelSelect(node, { provider: () => reloaded, value: 'legacy' });
  assert.ok(ids(node).includes('legacy')); assert.equal(node.value, 'legacy');
});

test('changing provider rebuilds options and keeps follow/default semantics', () => {
  const c = catalog(); let provider = { id: 'a', models: ['a-model'] };
  const node = select(); c.bindModelSelect(node, { provider: () => provider, value: 'a-model' });
  provider = { id: 'b', models: ['b-model'] };
  c.bindModelSelect(node, { provider: () => provider, value: '' });
  assert.deepEqual(ids(node), ['', 'b-model']); assert.equal(node.value, '');
});

test('Claude and Kimi discoveries stay separate and detached controls are released', () => {
  const c = catalog(), node = select();
  c.bindModelSelect(node, { models: () => c.agentModels('claude'), value: '' });
  c.publishAgentModels('kimi', [{ id: 'kimi-model' }]);
  assert.deepEqual(ids(node), ['']);
  c.publishAgentModels('claude', [{ id: 'claude-model' }]);
  assert.deepEqual(ids(node), ['', 'claude-model']);
  node.isConnected = false;
  c.publishAgentModels('claude', [{ id: 'next' }]);
  assert.deepEqual(ids(node), ['', 'claude-model']);
});
