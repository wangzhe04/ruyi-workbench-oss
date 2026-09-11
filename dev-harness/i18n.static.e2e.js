// Static i18n quality gate: catalog parity, placeholder contracts, pure runtime behavior, and locale config.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { readFrontendSrc } = require('./read-frontend-src.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const DOCS = path.join(ROOT, 'docs', 'i18n', 'locales');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const keys = object => Object.keys(object).sort();
const placeholders = value => [...String(value).matchAll(/{{\s*([\w.-]+)\s*}}/g)].map(match => match[1]).sort();

(async () => {
  const zh = readJson(path.join(PUBLIC, 'locales', 'zh-CN.json'));
  const en = readJson(path.join(PUBLIC, 'locales', 'en-US.json'));
  const docsZh = readJson(path.join(DOCS, 'zh-CN.json'));
  const docsEn = readJson(path.join(DOCS, 'en-US.json'));

  assert.deepStrictEqual(keys(zh), keys(en), 'zh-CN and en-US must have exactly the same keys');
  assert.deepStrictEqual(zh, docsZh, 'runtime zh-CN catalog must match the documented source of truth');
  assert.deepStrictEqual(en, docsEn, 'runtime en-US catalog must match the documented source of truth');
  for (const key of keys(zh)) {
    assert.deepStrictEqual(placeholders(zh[key]), placeholders(en[key]), `placeholder mismatch: ${key}`);
  }
  console.log(`PASS catalogs: ${keys(zh).length} matched keys and placeholder contracts`);

  // 117q-B3b（30 号文 §4.4 P0-4）伴随断言：任务五态人话此前抄了四份，其中两套 locale key
  // （previewShell.state.* 与 stewardShell.drawer.state.*）已经判出不同文案结果（quick_ask/done）。
  // 合并后四份 locale 都必须只剩中性的 mission.state.* 一套六个键，旧的两个前缀一个字都不许再
  // 出现——防止哪天又有人抄出第三套。
  const MISSION_STATES = ['dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask'];
  for (const [label, catalog] of [['public zh-CN', zh], ['public en-US', en], ['docs zh-CN', docsZh], ['docs en-US', docsEn]]) {
    const staleKeys = Object.keys(catalog).filter(key => key.startsWith('previewShell.state.') || key.startsWith('stewardShell.drawer.state.'));
    assert.deepStrictEqual(staleKeys, [], `${label} must not resurrect previewShell.state.*/stewardShell.drawer.state.* (found: ${staleKeys.join(',')})`);
    for (const state of MISSION_STATES) {
      assert.strictEqual(typeof catalog[`mission.state.${state}`], 'string', `${label} must carry mission.state.${state}`);
    }
  }
  console.log('PASS mission.state.*: all four locales carry the unified five-state copy with zero legacy previewShell.state./stewardShell.drawer.state. keys');

  const runtimePath = path.join(PUBLIC, 'js', 'i18n.js');
  const runtimeSource = fs.readFileSync(runtimePath, 'utf8')
    // The test imports from a data URL to retain ESM semantics without changing the package type. Keep the
    // production file URL as the resource base so loadCatalog() exercises its normal relative-URL behavior.
    .replace('import.meta.url', JSON.stringify(pathToFileURL(runtimePath).href));
  const i18n = await import(`data:text/javascript;base64,${Buffer.from(runtimeSource).toString('base64')}`);
  assert.strictEqual(i18n.normalizeLocale('en-GB'), 'en-US');
  assert.strictEqual(i18n.normalizeLocale('zh_Hans_CN'), 'zh-CN');
  assert.strictEqual(i18n.detectLocale(['fr-FR', 'en-GB']), 'en-US');
  assert.strictEqual(i18n.interpolate('Hello {{name}}', { name: 'Ruyi' }), 'Hello Ruyi');
  assert.strictEqual(i18n.pseudoLocalize('Save {{count}}'), '［Šåṽë {{count}}~~］');
  for (const [key, value] of Object.entries(en)) {
    const pseudo = i18n.pseudoLocalize(value);
    assert.ok(pseudo.startsWith('［') && pseudo.endsWith('］'), 'pseudo locale must bracket ' + key);
    assert.ok(pseudo.length >= String(value).length + 2, 'pseudo locale must expand ' + key);
    assert.deepStrictEqual(placeholders(pseudo), placeholders(value), 'pseudo locale must preserve placeholders for ' + key);
  }
  const fixture = new Map([['zh-CN', { 'sample.value': '中文 {{value}}' }], ['en-US', { 'sample.value': 'English {{value}}' }]]);
  assert.strictEqual(i18n.translate(fixture, 'en-US', 'sample.value', { value: 7 }), 'English 7');
  assert.strictEqual(i18n.translate(fixture, 'ja-JP', 'sample.value', { value: 7 }), '中文 7');
  const translatedNode = { dataset: { i18n: 'session.new' }, textContent: '' };
  const attributes = {};
  const attributeNode = {
    dataset: { i18nAttr: 'title:navigation.settings;aria-label:navigation.settings' },
    setAttribute: (name, value) => { attributes[name] = value; },
  };
  global.document = {
    documentElement: {},
    matches: () => false,
    querySelectorAll: () => [translatedNode, attributeNode],
  };
  global.window = { dispatchEvent: () => {} };
  global.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  global.fetch = async url => ({ ok: true, json: async () => String(url).includes('en-US') ? en : zh });
  await i18n.setLocale('en-US');
  assert.strictEqual(global.document.documentElement.lang, 'en-US');
  assert.strictEqual(translatedNode.textContent, 'New chat');
  assert.deepStrictEqual(attributes, { title: 'Settings', 'aria-label': 'Settings' });
  assert.strictEqual(i18n.tCount('session.messageCount', 1), '1 message');
  assert.strictEqual(i18n.tCount('session.messageCount', 2), '2 messages');
  console.log('PASS runtime: locale normalization, fallback, DOM attributes, pluralization, and named interpolation');

  const netPath = path.join(PUBLIC, 'js', 'net.js');
  const net = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(netPath, 'utf8')).toString('base64')}`);
  const structured = net.apiErrorInfo(new Error(JSON.stringify({ error: { code: 'file.path_required', params: { field: 'path' }, message: 'path is required' } })));
  assert.deepStrictEqual(structured, { code: 'file.path_required', params: { field: 'path' }, message: 'path is required' });
  const directStructured = net.apiErrorInfo({ code: 'steer.claude_requires_interactive', params: {}, message: 'switch to interactive' });
  assert.deepStrictEqual(directStructured, { code: 'steer.claude_requires_interactive', params: {}, message: 'switch to interactive' });
  assert.strictEqual(net.apiErrText(new Error(JSON.stringify({ error: { code: 'x', message: 'fallback message' } }))), 'fallback message');
  console.log('PASS error contract: structured and legacy API errors normalize safely');

  const server = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
  assert.strictEqual(server.defaultConfig().locale, 'auto');
  assert.strictEqual(server.normalizeConfig({ ...server.defaultConfig(), locale: 'en-US' }).config.locale, 'en-US');
  const invalid = server.normalizeConfig({ ...server.defaultConfig(), locale: 'fr-FR' });
  assert.strictEqual(invalid.config.locale, 'auto');
  assert.strictEqual(invalid.changed, true);
  console.log('PASS config: locale default and allowlist normalization');

  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const app = readFrontendSrc();
  const util = fs.readFileSync(path.join(PUBLIC, 'js', 'util.js'), 'utf8');
  const fileBrowser = fs.readFileSync(path.join(PUBLIC, 'js', 'file-browser.js'), 'utf8');
  const artifactChanges = fs.readFileSync(path.join(PUBLIC, 'js', 'artifact-changes.js'), 'utf8');
  const observability = fs.readFileSync(path.join(PUBLIC, 'js', 'operations-observability.js'), 'utf8');
  const usageDashboard = fs.readFileSync(path.join(PUBLIC, 'js', 'usage-dashboard.js'), 'utf8');
  assert.ok(html.includes('id="cfgLocale"'), 'settings must expose a locale selector');
  assert.ok(html.includes('data-i18n="app.title"'), 'browser title must use the catalog');
  assert.ok(html.includes('data-i18n-attr="placeholder:session.search"'), 'static attribute translation must be wired');
  const englishCriticalUi = {
    'settings.network': 'Web search',
    'settings.defaultWorkspace': 'Default workspace folder',
    'settings.uiMode': 'Interface mode',
    'settings.outputStyle': 'Response style',
    'settings.monthlyBudget.title': 'Monthly cost budget (optional)',
    'tool.files': 'Files',
    'tool.artifacts': 'Artifacts',
    'tool.sessionArtifacts': 'Artifacts from this chat',
  };
  for (const [key, value] of Object.entries(englishCriticalUi)) {
    assert.strictEqual(en[key], value, `English catalog must translate ${key}`);
    assert.ok(html.includes(`data-i18n="${key}"`), `static UI must wire ${key}`);
  }
  const englishDynamicUi = {
    'brand.name': 'Ruyi Workbench',
    'provider.testConnection': 'Test connection',
    'modelMenu.refreshModels': 'Refresh model list',
    'permission.mode.title': 'Security / permission mode',
    'capability.networkAndEngine': 'Network and engine',
    'tool.artifacts.turn': 'Turn {{turn}}',
    'help.title': 'Keyboard shortcuts',
    'palette.title': 'Command palette',
    'skills.title': 'Skills library',
    'skills.group.playbooks': 'Playbooks',
    'skills.playbook.pickerError': 'Folder picker error: {{reason}}',
    'skills.playbook.pickerUnavailable': 'Could not open the folder picker: {{reason}}',
    'playbook.create.modalTitle': 'Save as playbook',
    'onboarding.title': 'Welcome to Ruyi Workbench',
    'emptyState.starter.projectSummary': 'Read this project and summarize its structure',
  };
  for (const [key, value] of Object.entries(englishDynamicUi)) {
    assert.strictEqual(en[key], value, `English catalog must translate ${key}`);
  }
  const builtInSkillEntries = Object.entries(en).filter(([key]) => key.startsWith('skills.builtin.'));
  assert.strictEqual(builtInSkillEntries.length, 96, 'all 48 built-in skill/command/playbook records need localized name and description metadata');
  assert.ok(builtInSkillEntries.every(([, value]) => !/[\u4e00-\u9fff]/.test(value)), 'English built-in skill metadata must not contain Chinese');
  assert.ok(html.includes('data-i18n="brand.name"'), 'brand display name must use the catalog');
  assert.ok(html.includes('data-i18n="help.title"'), 'help dialog title must use the catalog');
  assert.ok(html.includes('data-i18n-attr="placeholder:palette.placeholder"'), 'palette placeholder must use the catalog');
  assert.ok(html.includes('data-i18n-attr="placeholder:skills.searchPlaceholder"'), 'skill search placeholder must use the catalog');
  assert.ok(html.includes('data-i18n-attr="placeholder:settings.monthlyBudget.amountPlaceholder"'), 'budget placeholder must be translatable');
  const settingsStart = html.indexOf('id="settingsModal"');
  const settingsEnd = html.indexOf('id="paletteModal"');
  const unlocalizedSettingsLines = html.slice(settingsStart, settingsEnd).split(/\r?\n/)
    .filter(line => /[\u4e00-\u9fff]/.test(line) && !line.includes('data-i18n') && !line.includes('<!--'));
  assert.deepStrictEqual(unlocalizedSettingsLines, [], 'settings must not leave fixed Chinese copy outside i18n markup');
  assert.ok(app.includes("from './js/i18n.js'"), 'client must load the i18n runtime');
  assert.ok(app.includes("tCount('session.messageCount'"), 'session rows must use localized pluralization');
  assert.ok(app.includes("t('workspace.switch.success'"), 'workspace success feedback must use the catalog');
  assert.ok(app.includes("t('chat.loadEarlier'"), 'message-window controls must use the catalog');
  assert.ok(app.includes("t('onboarding.drop.title'"), 'dynamic onboarding must use the catalog');
  assert.ok(app.includes("'mission.autoProgress'"), 'mission mode labels must use the catalog');
  assert.ok(app.includes("t('mission.complete.title')"), 'mission outcome cards must use the catalog');
  assert.ok(app.includes("t('mission.stop.failed'"), 'mission stop feedback must use the catalog');
  assert.ok(app.includes("'error.providerMisconfigured'"), 'known error classes must map to local catalog keys');
  assert.ok(app.includes("t('error.generic.title')"), 'generic error cards must use the catalog');
  assert.ok(app.includes("t('error.cliMissing.title'"), 'CLI-missing error cards must use the catalog (with optional engine interpolation)');
  assert.ok(app.includes("t('changes.title')"), 'change history must use the catalog');
  assert.ok(app.includes("t('file.open.failed'"), 'file-operation feedback must use the catalog');
  assert.ok(app.includes("t('permission.executionWarning'"), 'high-risk grant confirmation must use the catalog');
  assert.ok(app.includes("t('permission.preview.files'"), 'grant preview feedback must use the catalog');
  assert.ok(app.includes("t('permission.request.title'"), 'tool-permission prompts must use the catalog');
  assert.ok(app.includes("t('permission.notRevertible'"), 'permission risk feedback must use the catalog');
  assert.ok(app.includes("t('plan.card.heading'"), 'plan approval cards must use the catalog');
  assert.ok(app.includes("t('plan.awaitingApproval'"), 'plan approval hints must use the catalog');
  assert.ok(app.includes("t('workflow.run.title'"), 'workflow event cards must use the catalog');
  assert.ok(app.includes("t('workflow.started'"), 'workflow launch feedback must use the catalog');
  assert.ok(app.includes("t('workflow.editor.title'"), 'workflow editor core actions must use the catalog');
  assert.ok(html.includes('data-i18n="workflow.runTemplate"'), 'workflow quick-run entry must use the catalog');
  assert.ok(app.includes("t('workflow.pool.approve'"), 'workflow task-pool approval controls must use the catalog');
  assert.ok(app.includes("t('workflow.retry.node'"), 'workflow node retry controls must use the catalog');
  assert.ok(usageDashboard.includes("t('usage.loading')"), 'usage loading feedback must use the catalog');
  assert.ok(usageDashboard.includes("t('usage.budget.over'"), 'usage budget feedback must use the catalog');
  assert.ok(usageDashboard.includes("t('usage.dailyTrend'"), 'usage trend labels must use the catalog');
  assert.ok(fileBrowser.includes("t('file.preview.imageTooLarge'"), 'file preview feedback must use the catalog');
  assert.ok(observability.includes("t('audit.loadFailed'"), 'audit feedback must use the catalog');
  assert.ok(app.includes("t('provider.testConnection'"), 'provider card actions must use the catalog');
  assert.ok(app.includes("tCount('modelMenu.modelCount'"), 'model menu counts must use localized pluralization');
  assert.ok(app.includes("t('permission.mode.title'"), 'permission popover must use the catalog');
  assert.ok(app.includes("t('capability.networkAndEngine'"), 'capability popover must use the catalog');
  assert.ok(artifactChanges.includes("t('tool.artifacts.turn'"), 'artifact turn headings must use the catalog');
  assert.ok(app.includes("tCount('tool.group.completed'"), 'tool group summaries must use localized pluralization');
  assert.ok(app.includes('BUILTIN_SKILL_I18N_IDS'), 'built-in skill metadata must have a locale mapping');
  assert.ok(app.includes('playbookDisplayName(pb)'), 'built-in quick-task cards must use localized metadata');
  assert.ok(app.includes("t('skills.playbook.pickerError'"), 'quick-task folder picker failures must use the catalog');
  assert.ok(app.includes("t('skills.playbook.pickerUnavailable'"), 'quick-task folder picker feedback must use the catalog');
  assert.ok(app.includes("t('playbook.create.modalTitle'"), 'the save-as-playbook editor must use the catalog');
  assert.ok(app.includes("t('onboarding.title'"), 'first-run onboarding must use the catalog');
  assert.ok(!app.includes("'emptyState.starter.projectSummary'"), 'default empty state must not render starter prompts');
  assert.ok(app.includes("t('navigation.toggleUiMode'"), 'dynamic UI-mode labels must use the catalog');
  assert.ok(app.includes("t('palette.newSession'"), 'command palette actions must use the catalog');
  assert.ok(app.includes('renderProviders();'), 'locale changes must redraw provider cards');
  assert.ok(app.includes('renderSkillList();'), 'locale changes must redraw the skill panel');
  assert.ok(app.includes('refreshLocalizedArtifactChanges();'), 'locale changes must redraw the active artifact view');
  assert.ok(app.includes('refreshLocalizedObservability();'), 'locale changes must redraw loaded observability views');
  assert.ok(app.includes('refreshLocalizedUsage();'), 'locale changes must redraw cached usage data through its domain');
  assert.ok(app.includes("'auth.token_invalid': 'error.api.authToken'"), 'structured API errors must map to localized keys');
  assert.ok(usageDashboard.includes("toLocaleString(getLocale()"), 'usage values must follow the active locale');
  assert.ok(util.includes("toLocaleString(getLocale()"), 'time formatting must follow the active locale');
  console.log('PASS static wiring: locale settings and translated P0/P1 UI are present');

  // 117q-B3b（30 号文 §4.4 P0-4）伴随断言：服务端 06i-steward-core.js 的 STEWARD_STATE_LABELS 是
  // 中文单语，随 API 下发的 stateLabel 字段只给「工具返回给模型看的人话」用——前端已实测零调用点读
  // 这个字段（英文界面读它会看到中文）。mission-state.js 的 LABELS/.label 同理是服务端形状的镜像，
  // 不是给界面用的。用户可见的人话只有 t('mission.state.*') 一条路，这里钉死不许开第二条。
  assert.ok(!/\.stateLabel\b/.test(app),
    'client code must never read a server-dispatched .stateLabel field — user-facing state copy comes only from t(\'mission.state.*\')');
  assert.ok(!/\.fromCard\([^)]*\)\.label\b|\.fromSnapshot\([^)]*\)\.label\b|derived\.label\b|missionState\.LABELS\b|MissionState\.LABELS\b/.test(app),
    'client code must never read mission-state.js LABELS/.label — that is a mirror of the server shape, not for UI copy');
  // 每一处 stateLabel() 函数体都必须逐字查同一个前缀 mission.state.（包装形式允许不同 ——
  // steward-board.js／steward-drawer.js 原本就是声明式函数——本条只钉「查同一个前缀」这一件事，
  // 不强行拉齐包装语法）。
  // 121-K1（34 号文 §8.1）：交办台退役，它那一份 stateLabel() 随 preview-shell.js 一起删除，
  // 计数 3 → 2。判据【收紧】成「每一个查询点都在这两个模块里」——只钉数字挡不住有人在第三个
  // 文件里再抄一份，所以顺便钉住它们的出处。
  const STATE_LABEL_OWNERS = ['js/steward-board.js', 'js/steward-drawer.js'];
  const stateLabelPrefixHits = [...app.matchAll(/`mission\.state\.\$\{value\}`/g)].length;
  const stateLabelOwnerHits = STATE_LABEL_OWNERS.map(rel =>
    [...fs.readFileSync(path.join(PUBLIC, ...rel.split('/')), 'utf8').matchAll(/`mission\.state\.\$\{value\}`/g)].length);
  assert.strictEqual(stateLabelPrefixHits, 2,
    `exactly two stateLabel() bodies (steward-board/steward-drawer) must query the mission.state. prefix (found ${stateLabelPrefixHits})`);
  assert.deepStrictEqual(stateLabelOwnerHits, [1, 1],
    `the two stateLabel() queries must live in ${STATE_LABEL_OWNERS.join(' / ')} (found ${JSON.stringify(stateLabelOwnerHits)})`);
  console.log('PASS mission.state.* single path: no client read of server stateLabel or mission-state.js .label; both views query the same prefix');
  console.log('I18N STATIC E2E: ALL PASS');
})().catch(error => {
  console.error('I18N STATIC E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
