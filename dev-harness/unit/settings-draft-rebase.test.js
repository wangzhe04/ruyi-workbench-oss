'use strict';
// W6 设置重组（缺陷①「草稿过期会回滚」）：服务商草稿的三方合并 rebaseProvidersDraft（util.js 纯函数），
// 以及「模型分配」每一行服务商下拉的唯一选项构建器 fillProviderSelect（model-catalog.js）。
// 修前：推理强度／全局切模型／删模型行／线程头「设为新任务默认」只改 config 不碰设置页的草稿，页脚「保存」再把
// 旧草稿整份写回去 —— 这里钉的是合并规则本身：用户没动过的字段跟最新值走，动过的留用户的。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.resolve(__dirname, '../../ruyi-workbench/app/public');
const util = () => import(pathToFileURL(path.join(PUBLIC, 'js', 'util.js')).href);
const clone = value => JSON.parse(JSON.stringify(value));
const isToolbox = p => String((p && p.id) || '').startsWith('toolbox-');

test('fields another writer changed are taken; fields the user edited are kept', async () => {
  const { rebaseProvidersDraft } = await util();
  const base = [{ id: 'ds', label: 'DeepSeek', model: 'chat', reasoningEffort: '', models: [{ id: 'chat' }, { id: 'pro' }] }];
  const draft = clone(base); draft[0].label = 'My DeepSeek';                          // 用户在卡片上改了名字
  const next = clone(base); next[0].reasoningEffort = 'high'; next[0].model = 'pro';  // 别处改了强度与缺省模型
  const draftBefore = clone(draft);
  const { providers, changed } = rebaseProvidersDraft(base, draft, next);
  assert.equal(changed, true);
  assert.deepEqual(providers, [{ id: 'ds', label: 'My DeepSeek', model: 'pro', reasoningEffort: 'high', models: [{ id: 'chat' }, { id: 'pro' }] }]);
  assert.deepEqual(draft, draftBefore, '纯函数：不改入参');
});

test('deleted model rows and hiddenModels from another writer survive when the user did not touch them', async () => {
  const { rebaseProvidersDraft } = await util();
  const base = [{ id: 'q', model: 'a', models: [{ id: 'a' }, { id: 'b' }] }];
  const draft = clone(base); draft[0].apiKey = 'sk-new';
  const next = [{ id: 'q', model: 'a', models: [{ id: 'a' }], hiddenModels: ['b'] }];
  const { providers } = rebaseProvidersDraft(base, draft, next);
  assert.deepEqual(providers[0].models, [{ id: 'a' }]);
  assert.deepEqual(providers[0].hiddenModels, ['b']);
  assert.equal(providers[0].apiKey, 'sk-new');
});

test('a field both sides changed keeps the user value (explicit save reflects what is on screen)', async () => {
  const { rebaseProvidersDraft } = await util();
  const base = [{ id: 'p', model: 'x' }];
  const draft = [{ id: 'p', model: 'user-pick' }];
  const next = [{ id: 'p', model: 'elsewhere' }];
  assert.equal(rebaseProvidersDraft(base, draft, next).providers[0].model, 'user-pick');
});

test('adds, deletions and server-owned entries follow their owners', async () => {
  const { rebaseProvidersDraft } = await util();
  const base = [{ id: 'a', model: '1' }, { id: 'gone', model: '1' }, { id: 'toolbox-asr', models: [{ id: 'v1' }] }];
  const draft = [{ id: 'a', model: '1' }, { id: 'gone', model: '1' }, { id: 'mine', model: 'n' }, { id: 'toolbox-asr', models: [{ id: 'v1' }] }];
  // 用户在草稿里删掉了 base 里的一条？没有 —— 这里是别处删了 'gone'、别处新加了 'other'、toolbox 那条换了版本。
  const next = [{ id: 'a', model: '1' }, { id: 'other', model: 'o' }, { id: 'toolbox-asr', models: [{ id: 'v2' }] }];
  const { providers } = rebaseProvidersDraft(base, draft, next, { serverOwned: isToolbox });
  assert.deepEqual(providers.map(p => p.id), ['a', 'mine', 'toolbox-asr', 'other'],
    '别处删掉且用户没动过的跟着删；草稿里新加的留着；toolbox- 照最新值；别处新加的补在末尾');
  assert.deepEqual(providers.find(p => p.id === 'toolbox-asr').models, [{ id: 'v2' }]);
});

test('a provider the user deleted in the draft is not resurrected by a later change elsewhere', async () => {
  const { rebaseProvidersDraft } = await util();
  const base = [{ id: 'a', model: '1' }, { id: 'b', model: '1' }];
  const draft = [{ id: 'a', model: '1' }];
  const next = [{ id: 'a', model: '1' }, { id: 'b', model: '2' }];
  assert.deepEqual(rebaseProvidersDraft(base, draft, next).providers.map(p => p.id), ['a']);
});

test('a provider deleted elsewhere but edited by the user is kept', async () => {
  const { rebaseProvidersDraft } = await util();
  const base = [{ id: 'a', model: '1' }];
  const draft = [{ id: 'a', model: '1', label: 'edited' }];
  assert.deepEqual(rebaseProvidersDraft(base, draft, []).providers, [{ id: 'a', model: '1', label: 'edited' }]);
});

test('key order does not count as a change', async () => {
  const { rebaseProvidersDraft, canonicalJson } = await util();
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  const base = [{ id: 'a', model: '1', pricing: { inputPerM: 1, currency: 'CNY' } }];
  const draft = [{ pricing: { currency: 'CNY', inputPerM: 1 }, model: '1', id: 'a' }];
  const next = [{ id: 'a', model: '2', pricing: { inputPerM: 1, currency: 'CNY' } }];
  const { providers } = rebaseProvidersDraft(base, draft, next);
  assert.equal(providers[0].model, '2', '键序不同但值相同的 pricing 不算用户改过，model 照样跟最新值');
});

function catalog() {
  const source = fs.readFileSync(path.join(PUBLIC, 'js', 'model-catalog.js'), 'utf8');
  return vm.runInNewContext(source.replace(/^export /gm, '') + '\n({ fillProviderSelect })');
}
function select() {
  return {
    value: '', children: [], ownerDocument: { createElement: () => ({}) },
    get options() { return this.children; },
    replaceChildren(...children) { this.children = children; },
  };
}

test('fillProviderSelect: follow first, lead next, providers, then a saved-value placeholder', () => {
  const { fillProviderSelect } = catalog();
  const node = select();
  fillProviderSelect(node, {
    follow: 'follow', lead: [{ value: 'L', label: 'Lead' }],
    providers: [{ id: 'a', label: 'A' }, { id: 'b' }, null, { id: 'a', label: 'dup' }],
    value: 'gone', savedLabel: value => `saved:${value}`,
  });
  assert.deepEqual(node.children.map(o => [o.value, o.textContent]), [['', 'follow'], ['L', 'Lead'], ['a', 'A'], ['b', 'b'], ['gone', 'saved:gone']]);
  assert.equal(node.value, 'gone', '落盘值不在候选里也保留原样（补占位，不静默改写）');
});

test('fillProviderSelect: without a follow option an empty value lands on the first entry', () => {
  const { fillProviderSelect } = catalog();
  const node = select();
  // 真 <select> 的 value 设成不存在的值会读回第一项；桩这里模拟「设什么就是什么」，所以只核选项与写入的值。
  fillProviderSelect(node, { providers: [{ id: 'x' }], value: 'x' });
  assert.deepEqual(node.children.map(o => o.value), ['x']);
  assert.equal(node.value, 'x');
});
