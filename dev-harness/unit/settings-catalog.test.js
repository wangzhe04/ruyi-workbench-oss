'use strict';
// 2026-10 设置补全（用户：「把所有能配置的都放进设置页」）：public/js/settings-catalog.js 是修前没有控件的那批 config 键
// 的唯一登记处。本件把这张表与【服务端】对账，而不是与它自己对账：
//   [A] 每个目录键都是服务端 defaultConfig 里真实存在的键（嵌套键按路径取）—— 写错名字的控件存进去是死键；
//   [B] 界面钳位 = 服务端钳位：把每个数字框的上界＋1、下界−1、0 喂给 catalogStoredValue，产出的落盘值再过一遍
//       normalizeConfig，必须原样留下（否则用户看到的是 A、盘上是 B）；
//   [C] 出厂值往返：defaultConfig 的值 → 控件显示值 → 落盘值，回到同一个数（单位换算不漂）；
//   [D] 文案齐：每一段的标题／说明、每一项的标签／说明、单位、下拉选项，两份语言目录都有；
//   [E] 嵌套键补丁带上父对象现值（POST /api/config 是顶层浅合并，只送子键会冲掉兄弟字段）；
//   [F] 依赖项判定与置灰；
//   [G] 设置页不再按界面模式藏页签（用户 2026-10-01：「工具与集成里啥都没有」）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const { normalizeConfig } = require(path.join(app, 'server.js'));
const CATALOG = path.join(app, 'public', 'js', 'settings-catalog.js');
const load = () => import(pathToFileURL(CATALOG).href);
const zh = JSON.parse(fs.readFileSync(path.join(app, 'public', 'locales', 'zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(app, 'public', 'locales', 'en-US.json'), 'utf8'));
const DEFAULTS = normalizeConfig(null).config;
const readPath = (obj, field) => (field.path || [field.key]).reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), obj);

test('[A] 每个目录键都是服务端认得的键', async () => {
  const { catalogFields } = await load();
  const unknown = catalogFields().filter(f => {
    if (f.path) return !(f.path[0] in DEFAULTS);
    return !(f.key in DEFAULTS);
  }).map(f => f.key);
  assert.deepEqual(unknown, []);
});

test('[A2] 同一个键只登记一次', async () => {
  const { catalogFields } = await load();
  const keys = catalogFields().map(f => f.key);
  assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), []);
});

test('[B] 数字框的钳位与 normalizeConfig 一致', async () => {
  const { catalogFields, catalogStoredValue, catalogPatch } = await load();
  for (const field of catalogFields().filter(f => f.type === 'number')) {
    for (const shown of [field.max + 1, field.max, field.min, field.min - 1, 0, 1]) {
      const stored = catalogStoredValue(field, String(shown));
      if (stored === undefined) continue;
      const patch = catalogPatch(field, stored, DEFAULTS);
      const after = normalizeConfig({ ...DEFAULTS, ...patch }).config;
      assert.equal(readPath(after, field), stored, `${field.key}: 界面输入 ${shown} → 落盘 ${stored}，服务端改成了 ${readPath(after, field)}`);
    }
  }
});

test('[B2] 清空或乱填数字框不写盘', async () => {
  const { catalogFields, catalogStoredValue } = await load();
  const field = catalogFields().find(f => f.type === 'number');
  assert.equal(catalogStoredValue(field, ''), undefined);
  assert.equal(catalogStoredValue(field, 'abc'), undefined);
});

test('[C] 出厂值经控件往返不漂', async () => {
  const { catalogFields, catalogDisplayValue, catalogStoredValue } = await load();
  for (const field of catalogFields()) {
    if (field.type === 'allowRules' || field.type === 'tierMap') continue;
    const shown = catalogDisplayValue(field, DEFAULTS);
    const stored = catalogStoredValue(field, shown);
    const expected = readPath(DEFAULTS, field);
    assert.deepEqual(stored, expected === undefined ? field.fallback : expected, `${field.key}: 显示 ${JSON.stringify(shown)}`);
  }
});

test('[D] 文案两份语言都齐', async () => {
  const { SETTINGS_CATALOG, catalogFields, catalogLabelKey, catalogHintKey } = await load();
  const need = new Set();
  for (const section of SETTINGS_CATALOG) {
    need.add(section.titleKey);
    if (section.hintKey) need.add(section.hintKey);
  }
  for (const field of catalogFields()) {
    if (field.type === 'allowRules' || field.type === 'tierMap') continue;
    need.add(catalogLabelKey(field));
    need.add(catalogHintKey(field));
    if (field.unitKey) need.add(field.unitKey);
    for (const option of field.options || []) need.add(`${field.optionKeyPrefix}${option}`);
    if (field.placeholderKey) need.add(field.placeholderKey);
  }
  for (const extra of ['settings.catalog.allowRules.empty', 'settings.catalog.allowRules.revoke', 'settings.catalog.allowRules.revokeLabel',
    'settings.catalog.tierMap.empty', 'settings.catalog.tierMap.add', 'settings.catalog.tierMap.remove', 'settings.catalog.tierMap.tierLabel',
    'settings.catalog.tierMap.namePlaceholder', 'settings.catalog.tier.read', 'settings.catalog.tier.edit', 'settings.catalog.tier.exec']) need.add(extra);
  const missing = [...need].filter(key => typeof zh[key] !== 'string' || !zh[key] || typeof en[key] !== 'string' || !en[key]);
  assert.deepEqual(missing, []);
});

test('[D2] 每一段都挂在真实存在的页签上', async () => {
  const { SETTINGS_CATALOG } = await load();
  const html = fs.readFileSync(path.join(app, 'public', 'index.html'), 'utf8');
  const missing = SETTINGS_CATALOG.filter(s => !html.includes(`id="stab-${s.tab}"`) || !html.includes(`data-stab="${s.tab}"`)).map(s => s.id);
  assert.deepEqual(missing, []);
});

test('[E] 嵌套键的补丁带上父对象现值', async () => {
  const { catalogFields, catalogPatch } = await load();
  const field = catalogFields().find(f => f.path && f.path[0] === 'searchBackend');
  const patch = catalogPatch(field, true, { searchBackend: { type: 'bing', baseUrl: 'https://x', apiKey: '••••abcd' } });
  assert.deepEqual(patch, { searchBackend: { type: 'bing', baseUrl: 'https://x', apiKey: '••••abcd', fallbackToBuiltin: true } });
  const flat = catalogFields().find(f => f.key === 'allowCommandTools');
  assert.deepEqual(catalogPatch(flat, false, DEFAULTS), { allowCommandTools: false });
});

test('[F] 依赖项没满足时判为置灰', async () => {
  const { catalogFields, catalogDependencyMet } = await load();
  const ttl = catalogFields().find(f => f.key === 'autonomyPauseTtlMs');
  assert.equal(catalogDependencyMet(ttl, { ...DEFAULTS, autonomyPauseOnTimeout: false }), false);
  assert.equal(catalogDependencyMet(ttl, { ...DEFAULTS, autonomyPauseOnTimeout: true }), true);
  const cap = catalogFields().find(f => f.key === 'agentTaskPoolAutoCap');
  assert.equal(catalogDependencyMet(cap, { ...DEFAULTS, agentTaskPoolPolicy: 'auto-capped' }), true);
  assert.equal(catalogDependencyMet(cap, { ...DEFAULTS, agentTaskPoolPolicy: 'manual' }), false);
});

test('[G] 设置页不按界面模式藏页签', () => {
  const css = fs.readFileSync(path.join(app, 'public', 'css', 'themes', 'ui-modes.css'), 'utf8');
  assert.equal(/data-ui-mode="simple"\][^{]*#settingsTabs/.test(css), false, 'ui-modes.css 不应再藏设置页签');
  assert.equal(/data-ui-mode="simple"\][^{]*settings-expert-only/.test(css), false, 'ui-modes.css 不应再藏设置页内的行');
  const nav = fs.readFileSync(path.join(app, 'public', 'js', 'navigation-controls.js'), 'utf8');
  assert.equal(nav.includes('SETTINGS_SIMPLE_TABS'), false, 'navigation-controls.js 不应再有简易模式页签白名单');
});
