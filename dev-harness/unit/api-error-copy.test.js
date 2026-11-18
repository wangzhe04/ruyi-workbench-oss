'use strict';
// 151 阶段 1 · W10/U3/P10：后端稳定码的人话文案 + 「界面不出现原始 JSON」。
// 断言的都是运行时的值：真装入 public/js 的 api-error-i18n.js / privacy-failure.js / net.js（data: URL 以 ES 模块装入），
// 真读四份 locale；体验门 G-codes 的量具（experience-gates-codes.js）直接跑，门值只许降不许升。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const pub = path.join(root, 'ruyi-workbench/app/public');
const esm = rel => import('data:text/javascript;base64,' + fs.readFileSync(path.join(pub, rel)).toString('base64'));
const catalogs = Object.fromEntries([['zh', 'ruyi-workbench/app/public/locales/zh-CN.json'], ['en', 'ruyi-workbench/app/public/locales/en-US.json'],
  ['docsZh', 'docs/i18n/locales/zh-CN.json'], ['docsEn', 'docs/i18n/locales/en-US.json']].map(([k, rel]) => [k, JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))]));
const CJK = /[㐀-鿿]/;
const RAW_JSON = /^\s*[{[]|"(?:ok|error|code)"\s*:/;
const interpolate = (value, params = {}) => String(value).replace(/{{\s*([\w.-]+)\s*}}/g, (m, k) => (params[k] == null ? m : String(params[k])));
const tFor = lang => (key, params) => (Object.hasOwn(catalogs[lang], key) ? interpolate(catalogs[lang][key], params) : '[' + key + ']');

async function presenterFor(lang = 'zh') {
  const { createApiErrorPresenter } = await esm('js/api-error-i18n.js');
  const { privacyFailure } = await esm('js/privacy-failure.js');
  const net = await esm('js/net.js'); // 无 import 的 ES 模块；只用两个纯解析函数，不发网络请求
  return createApiErrorPresenter({ t: tFor(lang), apiErrorInfo: net.apiErrorInfo, rawApiErrText: net.apiErrText, privacyFailure });
}

test('every registered backend code has non-empty, mirrored zh/en copy under a collision-free derived key', async () => {
  const { apiErrorCopyKey } = await esm('js/api-error-i18n.js');
  const source = fs.readFileSync(path.join(pub, 'js/api-error-i18n.js'), 'utf8');
  const codes = [...source.slice(source.indexOf('const CODE_COPY = new Set(['), source.indexOf(']);', source.indexOf('const CODE_COPY'))).matchAll(/'([a-z0-9_.]+)'/g)].map(m => m[1]);
  assert.ok(codes.length >= 120, 'the code table is the real one (' + codes.length + ')');
  const keys = new Map();
  for (const code of codes) {
    const key = apiErrorCopyKey(code);
    assert.match(key, /^error\.code\.[a-zA-Z0-9]+$/, code);
    assert.ok(!keys.has(key), `derived key collision: ${code} vs ${keys.get(key)}`);
    keys.set(key, code);
    for (const lang of ['zh', 'en']) {
      const text = catalogs[lang][key];
      assert.equal(typeof text, 'string', `${lang} ${key}`);
      assert.ok(text.trim().length >= 12, `${lang} ${key} is a sentence, not a code`);
      assert.ok(!text.includes(code), `${lang} ${key} must explain, not repeat the code`);
      assert.equal(catalogs[lang === 'zh' ? 'docsZh' : 'docsEn'][key], text, 'docs mirror ' + key);
    }
    assert.ok(!CJK.test(catalogs.en[key]), 'English copy has no Chinese: ' + key);
    assert.ok(CJK.test(catalogs.zh[key]), 'Chinese copy is Chinese: ' + key);
  }
  assert.equal(apiErrorCopyKey('work_data.definitely_unknown'), '');
  assert.equal(apiErrorCopyKey({ code: 'api.bad_json' }), '');
});

test('presenter localizes stable codes from HTTP bodies and never returns a raw JSON or HTML body', async () => {
  for (const lang of ['zh', 'en']) {
    const present = await presenterFor(lang);
    const t = tFor(lang);
    const http = value => new Error(JSON.stringify(value));
    // 维护期发消息的真实形状：无 message 的结构化错误（冷端服务的 denied()）、遗留裸串、只带 code 的 internal_error。
    const cases = [
      [http({ ok: false, error: { code: 'work_data_setup.takeover_committed' }, retry: false }), t('error.code.workDataSetupTakeoverCommitted')],
      [http({ ok: false, error: { code: 'work_data_setup.busy', params: {}, message: 'work_data_setup.busy' } }), t('error.code.workDataSetupBusy')],
      [http({ ok: false, error: { code: 'api.internal_error', params: {}, message: 'work_data.maintenance_busy' } }), t('error.code.workDataMaintenanceBusy')],
      [http({ ok: false, error: { code: 'auth.token_invalid' }, retry: false }), t('error.api.authToken')],
      [http({ ok: false, error: { code: 'credential_vault.backup_password', params: {} } }), t('privacy.failure.vaultBackupPassword')],
      [http({ ok: false, error: { code: 'privacy.learning_not_stable' } }), t('privacy.failure.learningUnstable')],
      [http({ ok: false, error: { code: 'future.unknown_code' } }), t('error.api.codeOnly', { code: 'future.unknown_code' })],
      [http({ ok: false, error: { code: 'api.request_failed', message: '{"nested":true}' } }), t('error.api.unreadableResponse')],
      [http({ ok: false, error: { code: 'tool.failed', params: { name: 'x' }, message: 'disk is full' } }), t('error.code.withDetail', { text: t('error.code.toolFailed'), detail: 'disk is full' })],
      [new Error('<!doctype html><html><body>bad gateway</body></html>'), t('error.api.unreadableResponse')],
      [new Error('{"ok":false,"weird":1}'), t('error.api.unreadableResponse')],
    ];
    for (const [input, expected] of cases) {
      const text = present(input);
      assert.equal(text, expected, lang + ' ' + input.message);
      assert.doesNotMatch(text, RAW_JSON, 'no raw JSON on screen: ' + text);
      assert.ok(!/\[error\.|\[privacy\./.test(text), 'no missing-key brackets: ' + text);
      if (lang === 'en') assert.ok(!CJK.test(text), 'English UI shows no Chinese: ' + text);
    }
    // Ordinary prose from older routes is still passed through untouched (124: never swallow the server's own words).
    assert.equal(present(http({ ok: false, error: { code: 'api.request_failed', message: 'Kimi is finishing; send it as the next message' } })), 'Kimi is finishing; send it as the next message');
    assert.equal(present(new Error('plain words')), 'plain words');
  }
});

// 1D 审查：不锚定的 `"error":` 判据曾把「人话前缀 + 内嵌 JSON」的服务商原因吞成「无法识别、请重启如意」。
test('provider reasons wrapped as "HTTP <status>: {json}" reach the user instead of the unreadable-response sentence', async () => {
  for (const lang of ['zh', 'en']) {
    const present = await presenterFor(lang);
    const t = tFor(lang);
    const http = value => new Error(JSON.stringify(value));
    const cases = [
      [new Error('HTTP 401: {"error":{"message":"Incorrect API key provided"}}'), 'HTTP 401: Incorrect API key provided'],
      [http({ ok: false, error: { code: 'api.request_failed', message: 'HTTP 429: {"error":{"message":"Rate limit reached"}}' } }), 'HTTP 429: Rate limit reached'],
      [http({ ok: false, error: 'HTTP 400: {"error":{"message":"model not found"}}' }), 'HTTP 400: model not found'],
      [new Error('Provider said: the "code": field is invalid'), 'Provider said: the "code": field is invalid'],
    ];
    for (const [input, expected] of cases) {
      const text = present(input);
      assert.notEqual(text, t('error.api.unreadableResponse'), lang + ' must not swallow: ' + input.message);
      assert.ok(text.includes(expected), lang + ' shows the provider reason: ' + text);
    }
  }
});

test('privacy failure table covers gateway, regex and credential vault codes with mirrored copy', async () => {
  const { privacyFailure } = await esm('js/privacy-failure.js');
  const { collectEmitted } = require('../lib/experience-gates-codes.js');
  const emitted = [...collectEmitted(path.join(root, 'ruyi-workbench/app/src')).keys()];
  const vault = emitted.filter(code => code.startsWith('credential_vault.') && code !== 'credential_vault.unsupported');
  assert.ok(vault.length >= 20, 'vault codes found in 01k (' + vault.length + ')');
  const required = ['privacy.regex_timeout', 'privacy.regex_invalid', 'privacy.regex_empty_match', 'privacy.regex_busy', 'privacy.regex_scan_required', 'privacy.regex_worker_failed',
    'privacy.learning_not_stable', 'privacy.whitespace_sensitive', 'privacy.key_collision', 'privacy.scope_capacity', ...vault];
  for (const code of required) {
    const failure = privacyFailure({ ok: false, code });
    assert.ok(failure, code + ' is recognized');
    for (const lang of ['zh', 'en', 'docsZh', 'docsEn']) assert.ok(typeof catalogs[lang][failure.key] === 'string' && catalogs[lang][failure.key].length > 12, lang + ' ' + failure.key);
    assert.ok(!CJK.test(catalogs.en[failure.key]), failure.key);
  }
  // Ordinary prose that merely mentions a code is still not an authority (existing contract).
  assert.equal(privacyFailure('User wrote privacy.learning_not_stable in a note'), null);
});

test('privacy settings: privacy.busy and credential vault codes no longer fall back to the rule-format sentence; U12 preview names what is missing', async () => {
  const { privacyFailure } = await esm('js/privacy-failure.js');
  const { apiErrorCopyKey } = await esm('js/api-error-i18n.js');
  const source = fs.readFileSync(path.join(pub, 'js/privacy-settings.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const api = vm.runInNewContext(source + '\n({ privacySettingsFailureKey, recoveryPreviewBlocker });', { privacyFailure, apiErrorCopyKey, Object });
  const fallback = catalogs.zh['privacy.failed'];
  for (const code of ['privacy.busy', 'credential_vault.backup_password', 'credential_vault.backup_authentication', 'credential_recovery.ticket_expired', 'privacy.settings_invalid']) {
    const key = api.privacySettingsFailureKey(code);
    assert.notEqual(key, 'privacy.failed', code);
    assert.ok(catalogs.zh[key] && catalogs.en[key], code + ' -> ' + key);
    assert.notEqual(catalogs.zh[key], fallback);
    assert.doesNotMatch(catalogs.zh[key], /请检查规则格式、密码或恢复包/);
  }
  assert.equal(api.privacySettingsFailureKey('privacy.regex_timeout'), 'privacy.regexTimeout', 'settings-local wording keeps precedence');
  assert.equal(api.privacySettingsFailureKey('privacy.policy_unavailable'), 'privacy.policyRecoveryRequired');
  assert.equal(api.privacySettingsFailureKey('totally.unknown'), 'privacy.failed');
  const file = size => ({ length: 1, 0: { size } });
  assert.equal(api.recoveryPreviewBlocker(null, 'long enough password'), 'privacy.previewNeedFile');
  assert.equal(api.recoveryPreviewBlocker({ length: 0 }, 'long enough password'), 'privacy.previewNeedFile');
  assert.equal(api.recoveryPreviewBlocker(file(10), ''), 'privacy.previewNeedPassword');
  assert.equal(api.recoveryPreviewBlocker(file(10), 'short'), 'privacy.previewNeedPassword');
  assert.equal(api.recoveryPreviewBlocker(file(3 * 1024 * 1024), 'long enough password'), 'privacy.previewFileTooLarge');
  assert.equal(api.recoveryPreviewBlocker(file(10), 'long enough password'), '');
  for (const key of ['privacy.previewNeedFile', 'privacy.previewNeedPassword', 'privacy.previewFileTooLarge']) assert.ok(catalogs.zh[key] && catalogs.en[key] && !CJK.test(catalogs.en[key]), key);
});

test('G-codes gate: missing dedicated copy for HTTP-reachable and privacy codes only goes down', async () => {
  const { scanErrorCopy } = require('../lib/experience-gates-codes.js');
  const scan = await scanErrorCopy(root);
  // 151 阶段 1 改前 146（A 102 + B 44）。上限按本批落地后的实测值钉住：新增后端码时同一刀补文案，不许回涨。
  assert.ok(scan.gateMissing <= 0, 'gate missing ' + scan.gateMissing + ': ' + scan.missing.filter(r => r.tier !== 'C').map(r => r.code).join(', '));
});
