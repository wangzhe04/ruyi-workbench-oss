'use strict';
// 81-P0 contracts against the real pure module; no provider/DPAPI/storage integration is claimed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/01i-privacy-rules.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/01h-privacy-core.js'), 'utf8');
const core = vm.runInNewContext(source + '\nPrivacyCore;', { require, Buffer });
const plain = value => JSON.parse(JSON.stringify(value));
const secret = 'sk-' + 'example'.repeat(5);
const scope = options => core.createScope({ scopeId: 'session-test', detector: core.createDetector({ personal: true }), ...options });
const allowed = extra => ({ scopeId: 'session-test', tool: 'find_orders', pointer: '/email', destination: 'local-orders', purpose: 'user-request',
  authorize: r => r.tool === 'find_orders' && r.pointer === '/email' && r.destination === 'local-orders' && r.category === 'EMAIL' && !r.embedded, ...extra });
const assertCode = (fn, code) => assert.throws(fn, e => e.code === 'privacy.' + code);

test('explicit business identifiers do not become phones; standalone and labelled phones remain private', () => {
  const detector = core.createDetector({ personal: true });
  for (const sample of ['订单号13900000088', '订单号：13900000088', '订单号是13900000088', '运单号=13900000088', '快递单号13900000088', 'order_id=13900000088', 'tracking number:13900000088']) {
    assert.equal(detector.detect(sample).length, 0, sample);
  }
  for (const pointer of ['/orderId', '/order_id', '/trackingNumber', '/学号']) assert.equal(detector.detect('13900000088', { pointer }).length, 0, pointer);
  for (const sample of ['13900000088', '手机号13900000088', '联系电话：13900000088', '手机号：一五九 零一二三四五六七', 'Phone:１５９０１２３４５６７']) {
    assert.ok(detector.detect(sample).some(hit => hit.category === 'PHONE'), sample);
  }
  const mixed = '订单号13900000088，联系电话13800138000';
  const result = scope().protectRaw(mixed);
  assert.ok(result.text.includes('13900000088') && !result.text.includes('13800138000'));
});

test('explicit card labels protect grouped wrong-checksum values in prose and quoted JSON fields', () => {
  const number = '6200 0000 0000 0000 001';
  for (const sample of ['银行卡是 ' + number, '银行卡号为' + number, JSON.stringify({ 银行卡号: number }), "{'银行卡号':'" + number + "'}"]) {
    const s = scope(), result = s.protectRaw(sample);
    assert.equal(result.text.includes(number), false);
    assert.equal(result.matches.some(row => row.category === 'PAYMENT'), true);
  }
  assert.equal(core.createDetector({ personal: true }).detect('普通订单号：6200000000000000001').length, 0);
});

test('authentication padding and scheme-only header fragments cannot become credentials', () => {
  const detector = core.createDetector();
  for (const text of ['Authorization: ', 'Authorization: Bearer ', 'Proxy-Authorization: ApiKey\t', 'Cookie: ', 'Set-Cookie:\t', 'Password= ', 'Password="']) {
    assert.equal(detector.detect(text).length, 0, text);
  }
  for (const [text, publicPrefix, credentials] of [
    ['Authorization: Digest username="fixture", response="012345fixture"', 'Authorization: Digest ', ['fixture', '012345fixture']],
    ['Proxy-Authorization: ApiKey fixture-value\r\n continuation-value', 'Proxy-Authorization: ApiKey ', ['fixture-value', 'continuation-value']],
    ['Inline Bearer synthetic\\secret-value tail', 'Inline Bearer ', ['synthetic\\secret-value']],
    ['Inline Basic synthetic\\basic-value tail', 'Inline Basic ', ['synthetic\\basic-value']],
  ]) {
    const s = scope({ detector }), result = s.protectRaw(text);
    assert.ok(result.text.startsWith(publicPrefix));
    for (const credential of credentials) assert.ok(!result.text.includes(credential));
    assert.equal(s.restoreForTool(result.text, allowed({ authorize: () => true, allowCredentialEmbedding: true })), text);
  }
});

test('legacy whitespace tokens retain validation and restoration without global learned matching', () => {
  const s = scope(), token = '[[RUYI_PVT:CREDENTIAL:' + 'b'.repeat(32) + ']]';
  s.importState({ version: 1, scopeId: 'session-test', entries: [{ token, value: ' ', category: 'CREDENTIAL', expiresAt: Date.now() + 60000 }] });
  assert.equal(s.validateProtected(token), token);
  assert.equal(s.restoreForTool(token, allowed({ authorize: () => true })), ' ');
  assert.equal(s.protectRaw('ordinary public text').text, 'ordinary public text');
  assert.equal(s.protectRaw('{ "count": 200, "ok": true }').text, '{ "count": 200, "ok": true }');
  assert.equal(s.exportState().entries.length, 1, 'the historical mapping is retained');
  assertCode(() => s.protectRaw(' ', { pointer: '/password' }), 'whitespace_sensitive');
  assertCode(() => s.protectAlias('\\u0020', ' ', 'CREDENTIAL'), 'whitespace_sensitive');
  s.revoke(token); assertCode(() => s.validateProtected(token), 'reference_unknown');
});

test('opaque-reference scanning ignores internal active and revoked short values but preserves outside rejection', () => {
  const s = scope(), token = '[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]';
  s.importState({ version: 1, scopeId: 'session-test', entries: [{ token, value: 'opaque@example.test', category: 'EMAIL', expiresAt: Date.now() + 60000 }], revokedValues: ['a'] });
  assert.equal(s.detect(token, { opaqueReferences: true }).length, 0);
  assertCode(() => s.detect(token + ' a', { opaqueReferences: true }), 'reference_revoked');
  assertCode(() => s.detect(token.replace(/a/g, 'b'), { opaqueReferences: true }), 'reference_unknown');
  assertCode(() => s.detect(token + ' [[RUYI_PVT:bad', { opaqueReferences: true }), 'reference_malformed');
});

test('explicit known or custom whitespace values refuse issuing maps rather than silently sending them', () => {
  for (const detector of [core.createDetector({ knownSecrets: [' '] }), core.createDetector({ rules: [{ id: 'space', kind: 'literal', value: '\t', category: 'CREDENTIAL' }] })]) {
    const s = scope({ detector });
    assertCode(() => s.protectRaw(' \t '), 'whitespace_sensitive'); assert.equal(s.size(), 0);
  }
});

test('raw tool results and repeated values become stable references; authorized execution restores exact input', () => {
  const s = scope();
  const protectedInput = s.protectRaw('查询 Case.User@example.test');
  assert.equal(protectedInput.text.includes('Case.User'), false);
  const token = protectedInput.text.slice(3);
  assert.equal(s.restoreForTool(token, allowed()), 'Case.User@example.test');
  const returned = s.protectRaw('工具返回：Case.User@example.test，手机 13800138000，API=' + secret);
  assert.ok(returned.text.includes(token));
  for (const value of ['Case.User@example.test', '13800138000', secret]) assert.equal(returned.text.includes(value), false);
  assert.equal(s.size(), 3);
  assert.equal(s.validateProtected(returned.text), returned.text);
});

test('references are random across scopes and cannot cross scopes or fields', () => {
  const a = scope(), b = scope({ scopeId: 'another-session' });
  const ta = a.protectRaw('sample@example.test').text, tb = b.protectRaw('sample@example.test').text;
  assert.notEqual(ta, tb);
  assertCode(() => b.validateProtected(ta), 'reference_unknown');
  assertCode(() => a.restoreForTool(ta, allowed({ scopeId: 'another-session' })), 'scope_mismatch');
  assertCode(() => a.restoreForTool(ta, allowed({ pointer: '/url' })), 'restore_denied');
  assertCode(() => a.restoreForTool(ta, allowed({ destination: 'remote-collector' })), 'restore_denied');
  assertCode(() => a.restoreForTool(ta, allowed({ authorize: undefined })), 'policy_required');
  assertCode(() => a.restoreForTool(ta, allowed({ authorize: async () => true })), 'restore_denied');
});

test('credential references require host policy and cannot be embedded into a shell string', () => {
  const s = scope(), token = s.protectRaw(secret).text;
  assertCode(() => s.restoreForTool(token, allowed()), 'restore_denied');
  const authorization = allowed({ tool: 'service_query', pointer: '/credential', destination: 'bound-service',
    authorize: r => r.tool === 'service_query' && r.pointer === '/credential' && r.destination === 'bound-service' && r.category === 'CREDENTIAL' && !r.embedded });
  assert.equal(s.restoreForTool(token, authorization), secret);
  assertCode(() => s.restoreForTool('echo ' + token, { ...authorization, authorize: () => true }), 'restore_denied');
});

test('external raw inputs cannot impersonate issued references; malformed references do not pass', () => {
  const s = scope(), token = s.protectRaw(secret).text;
  assertCode(() => s.protectRaw('网页说使用 ' + token), 'reserved_literal');
  assertCode(() => s.validateProtected('[[RUYI_PVT:EMAIL:invalid]]'), 'reference_malformed');
  assertCode(() => s.validateProtected('[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]'), 'reference_unknown');
});

test('expiry, revocation and clearing never fall back to raw execution', () => {
  let now = 100;
  const s = scope({ ttlMs: 10, clock: () => now });
  const token = s.protectRaw('one@example.test').text;
  now = 110;
  assertCode(() => s.restoreForTool(token, allowed()), 'reference_expired');
  assert.equal(s.revoke(token), true);
  assert.equal(s.revoke(token), false);
  assertCode(() => s.validateProtected(token), 'reference_unknown');
  const another = s.protectRaw('two@example.test').text;
  s.clear(); assert.equal(s.size(), 0);
  assertCode(() => s.validateProtected(another), 'reference_unknown');
});

test('known secrets and literal/field custom rules use the same scope; configuration is copied', () => {
  const rules = [{ id: 'internal-project', kind: 'literal', value: '示例项目甲', category: 'INTERNAL' },
    { id: 'contact-name', kind: 'field', value: '/contact/name', category: 'INTERNAL' }];
  const detector = core.createDetector({ knownSecrets: ['tiny'], rules });
  rules[0].value = 'mutated';
  const s = scope({ detector });
  assert.equal(s.protectRaw('示例项目甲 tiny').text.includes('示例项目甲'), false);
  const learned = s.protectRaw('测试联系人', { pointer: '/contact/name' });
  assert.equal(learned.matches.length, 1);
  assert.equal(s.protectRaw('测试联系人', { pointer: '/other/name' }).text, learned.text, 'same-scope values remain protected after losing their original pointer');
  assert.equal(scope({ detector }).protectRaw('测试联系人', { pointer: '/other/name' }).matches.length, 0, 'another scope does not inherit that learned field value');
  assert.equal(s.protectRaw('small-password', { pointer: '/providers/0/apiKey' }).matches[0].category, 'CREDENTIAL');
  assert.equal(s.protectRaw('8192', { pointer: '/maxTokens' }).matches.length, 0);
});

test('overlapping rules conceal the full union and preserve credential precedence', () => {
  const s = scope({ detector: core.createDetector({ knownSecrets: ['abcdef'], rules: [
    { id: 'overlap', kind: 'literal', value: 'defghi', category: 'INTERNAL' },
  ] }) });
  const output = s.protectRaw('x abcdefghi z');
  assert.equal(output.matches.length, 1);
  assert.equal(output.matches[0].start, 2); assert.equal(output.matches[0].end, 11);
  assert.equal(output.matches[0].category, 'CREDENTIAL');
  assert.equal(output.text.includes('ghi'), false);
  const token = output.text.slice(2, -2);
  assert.equal(s.restoreForTool(token, allowed({ authorize: () => true })), 'abcdefghi');
});

test('new credential context tightens an existing reference instead of granting previous personal use', () => {
  const s = scope(), token = s.protectRaw('contact@example.test').text;
  assert.equal(s.restoreForTool(token, allowed()), 'contact@example.test');
  assert.equal(s.protectRaw('contact@example.test', { pointer: '/password' }).text, token);
  assertCode(() => s.restoreForTool(token, allowed()), 'restore_denied');
});

test('protected validation can require current credential metadata without disclosing or changing a reference', () => {
  const s = scope(), token = s.protectRaw('validation@example.test').text;
  const before = plain(s.exportState()), revision = s.revision();
  assertCode(() => s.validateProtected(token, { requiredCategory: 'CREDENTIAL' }), 'credential_context');
  assert.deepEqual(plain(s.exportState()), before); assert.equal(s.revision(), revision);
  assert.equal(s.validateProtected(token), token);
  s.protectRaw('validation@example.test', { pointer: '/password' });
  assert.equal(s.validateProtected(token, { requiredCategory: 'CREDENTIAL' }), token);
  assert.match(token, /^\[\[RUYI_PVT:EMAIL:/, 'the old prefix does not override upgraded metadata');
  s.revoke(token);
  assertCode(() => s.validateProtected(token, { requiredCategory: 'CREDENTIAL' }), 'reference_unknown');
});

test('custom confidential field also tightens a previously identified email reference', () => {
  const detector = core.createDetector({ personal: true, rules: [{ id: 'private', kind: 'field', value: '/private', category: 'INTERNAL' }] });
  const s = scope({ detector }), token = s.protectRaw('contact@example.test').text;
  assert.equal(s.protectRaw('contact@example.test', { pointer: '/private' }).text, token);
  assertCode(() => s.restoreForTool(token, allowed()), 'restore_denied');
});

test('learned exact values survive prose, restart and overlap while remaining isolated to their scope', () => {
  const detector = core.createDetector({ rules: [{ id: 'patient', kind: 'field', value: '/patient', category: 'INTERNAL' }] });
  const s = scope({ detector }), value = 'SYNTHETIC-PATIENT-ONLY';
  const token = s.protectRaw(value, { pointer: '/patient' }).text;
  assert.equal(s.protectRaw('echo=' + value).text, 'echo=' + token);
  const fresh = scope({ scopeId: 'fresh', detector });
  assert.equal(fresh.protectRaw(value).text, value);
  const restarted = scope({ detector }); restarted.importState(s.exportState());
  assert.equal(restarted.protectRaw(value).text, token);
  const outer = s.protectValue('ABCDE', 'INTERNAL'); s.protectValue('ABC', 'CREDENTIAL');
  assert.equal(s.protectRaw('ABCDE').text, outer);
  assert.equal(s.detect('ABCDE')[0].category, 'CREDENTIAL');
  assertCode(() => s.restoreForTool(outer, allowed({ authorize: ref => ref.category !== 'CREDENTIAL' })), 'restore_denied');
});

test('escaped aliases tighten together and retain credential restrictions after encrypted-state restart', () => {
  const s = scope(), decoded = 'foo"bar', encoded = 'foo\\"bar';
  const alias = s.protectAlias(encoded, decoded, 'INTERNAL');
  assert.equal(s.restoreForTool(alias, allowed({ authorize: ref => ref.category !== 'CREDENTIAL' })), encoded);
  s.protectValue(decoded, 'CREDENTIAL');
  assertCode(() => s.restoreForTool(alias, allowed({ authorize: ref => ref.category !== 'CREDENTIAL' })), 'restore_denied');
  const restarted = scope(); restarted.importState(s.exportState());
  assert.equal(restarted.protectRaw(encoded).text, alias);
  assertCode(() => restarted.restoreForTool(alias, allowed({ authorize: ref => ref.category !== 'CREDENTIAL' })), 'restore_denied');
});

test('an exhausted alias-upgrade budget never leaves only part of an alias group upgraded', () => {
  const s = scope(), decoded = 'foo"bar', encoded = 'foo\\"bar'; s.protectAlias(encoded, decoded, 'INTERNAL');
  const before = plain(s.exportState()), revision = s.revision();
  assertCode(() => s.protectAlias(encoded, decoded, 'CREDENTIAL', { budget: core.createMatchBudget(1) }), 'learned_scan_limit');
  assert.deepEqual(plain(s.exportState()), before); assert.equal(s.revision(), revision);
  s.protectAlias(encoded, decoded, 'CREDENTIAL');
  assert.ok(s.exportState().entries.every(entry => entry.category === 'CREDENTIAL'));
});

test('a fresh alias budget or mapping limit failure creates no unlinked representations, including after restart', () => {
  const s = scope(), decoded = 'decoded-SYNTHETIC', encoded = 'raw-SYNTHETIC';
  const before = plain(s.exportState()), revision = s.revision();
  assertCode(() => s.protectAlias(encoded, decoded, 'INTERNAL', { budget: core.createMatchBudget(1) }), 'learned_scan_limit');
  assert.deepEqual(plain(s.exportState()), before); assert.equal(s.revision(), revision);
  const restarted = scope(); restarted.importState(s.exportState());
  restarted.protectValue(decoded, 'CREDENTIAL');
  assert.equal(restarted.protectRaw(encoded).text, encoded, 'a failed operation has exposed no raw alias token to downgrade');
  const token = restarted.protectAlias(encoded, decoded, 'INTERNAL');
  assertCode(() => restarted.restoreForTool(token, allowed({ authorize: ref => ref.category !== 'CREDENTIAL' })), 'restore_denied');
  const capacity = scope(); capacity.protectValue('x'.repeat(600000), 'INTERNAL');
  const capacityBefore = plain(capacity.exportState());
  assertCode(() => capacity.protectAlias('a'.repeat(300000), 'b'.repeat(300000), 'INTERNAL'), 'mapping_limit');
  assert.deepEqual(plain(capacity.exportState()), capacityBefore, 'combined alias capacity is checked before the first issue');
});

test('expired and revoked learned values fail closed on reappearance and tombstones survive restart', () => {
  let now = 100;
  const s = scope({ clock: () => now, ttlMs: 10 });
  const expired = s.protectValue('SYNTHETIC-EXPIRED', 'INTERNAL'); now = 110;
  assertCode(() => s.protectRaw('SYNTHETIC-EXPIRED'), 'reference_expired');
  assertCode(() => s.validateProtected(expired), 'reference_expired');
  const revoked = s.protectValue('SYNTHETIC-REVOKED', 'INTERNAL');
  assert.equal(s.revoke(revoked), true); assert.equal(s.revoke(revoked), false);
  assertCode(() => s.protectRaw('SYNTHETIC-REVOKED'), 'reference_revoked');
  assertCode(() => s.validateProtected(revoked), 'reference_unknown');
  const restarted = scope({ clock: () => now, ttlMs: 10 }); restarted.importState(s.exportState());
  assertCode(() => restarted.protectRaw('SYNTHETIC-REVOKED'), 'reference_revoked');
  assertCode(() => restarted.protectRaw('SYNTHETIC-EXPIRED'), 'reference_expired');
  restarted.clear(); assert.equal(restarted.protectRaw('SYNTHETIC-REVOKED').text, 'SYNTHETIC-REVOKED');
  assert.equal(restarted.protectRaw('SYNTHETIC-EXPIRED').text, 'SYNTHETIC-EXPIRED');
});

test('revocation of an escaped alias also invalidates the remaining representation after restart', () => {
  const s = scope(), decoded = 'foo"bar', encoded = 'foo\\"bar';
  const token = s.protectAlias(encoded, decoded, 'INTERNAL'); s.revoke(token);
  assertCode(() => s.protectRaw(decoded), 'reference_revoked');
  const restarted = scope(); restarted.importState(s.exportState());
  assertCode(() => restarted.protectRaw(decoded), 'reference_revoked');
});

test('learned matching has shared comparison and pre-merge hit budgets, including one-character secrets', () => {
  const s = scope({ detector: core.createDetector() }); s.protectValue('abcabcabd', 'INTERNAL');
  const budget = core.createMatchBudget(80);
  assert.deepEqual(plain(s.detect('z'.repeat(30), { budget })), []);
  assertCode(() => s.detect('z'.repeat(60), { budget }), 'learned_scan_limit');
  assert.deepEqual(plain(s.detect('z'.repeat(60))), [], 'a separate default-bounded operation gets a new budget');
  const tiny = scope({ detector: core.createDetector() }); const token = tiny.protectValue('x', 'INTERNAL');
  assert.equal(tiny.protectRaw('x').text, token);
  tiny.protectValue('xx', 'INTERNAL');
  assertCode(() => tiny.detect('xxxx', { budget: core.createMatchBudget(100, 5) }), 'learned_scan_limit');
  assertCode(() => tiny.detect('x', { budget: {} }), 'scan_budget_invalid');
});

test('learned mapping counts and bytes include revoked values; imports validate empty, duplicate and alias state atomically', () => {
  const s = scope({ detector: core.createDetector() }), token = s.protectValue('a'.repeat(600000), 'INTERNAL'); s.revoke(token);
  assertCode(() => s.protectValue('b'.repeat(600000), 'INTERNAL'), 'mapping_limit');
  const countBounded = scope({ detector: core.createDetector() }); let last;
  for (let i = 0; i < core.LIMITS.mappings; i++) last = countBounded.protectValue('mapping-' + i, 'INTERNAL');
  countBounded.revoke(last);
  assertCode(() => countBounded.protectValue('overflow-mapping', 'INTERNAL'), 'mapping_limit');
  const valid = scope({ detector: core.createDetector() }); valid.protectValue('stable', 'INTERNAL');
  const legacy = plain(valid.exportState()); assert.equal('revokedValues' in legacy, false);
  const imported = scope({ detector: core.createDetector() }); imported.importState(legacy);
  assert.equal(imported.protectRaw('stable').text, legacy.entries[0].token);
  const invalid = [
    { ...legacy, entries: [{ ...legacy.entries[0], value: '' }] },
    { ...legacy, revokedValues: ['stable'] },
    { ...legacy, revokedValues: ['', 'x'] },
    { ...legacy, revokedValues: [PREFIX_FOR_TEST()] },
    { ...legacy, revokedValues: ['x', 'x'] },
    { ...legacy, revokedValues: ['a'.repeat(600000), 'b'.repeat(600000)] },
    { ...legacy, aliasGroups: [['stable', 'missing']] },
    { ...legacy, aliasGroups: [['stable', 'stable']] },
    { ...legacy, entries: [{ ...legacy.entries[0], extra: 'unknown' }] },
    { ...legacy, entries: [{ ...legacy.entries[0], token: legacy.entries[0].token.replace('INTERNAL', 'CREDENTIAL') }] },
    { ...legacy, unexpected: true },
  ];
  for (const state of invalid) {
    assert.throws(() => imported.importState(state));
    assert.equal(imported.validateProtected(legacy.entries[0].token), legacy.entries[0].token, 'failed import leaves the previous scope intact');
  }
  function PREFIX_FOR_TEST() { return '[[RUYI_PVT:INTERNAL:' + 'a'.repeat(32) + ']]'; }
});

test('builtins cover multi-line private keys, authentication, cookies, config and signed URLs', () => {
  const samples = [
    ['-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----', 'SYNTHETIC'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nINCOMPLETE', 'INCOMPLETE'],
    ['Authorization: ' + ['Bearer', 'fixture-bearer-value'].join(' '), 'fixture-bearer-value'],
    ['authorization: Basic ' + Buffer.from('fixture:example').toString('base64'), Buffer.from('fixture:example').toString('base64')],
    ['Cookie: sid=fixture-session; locale=zh-CN\nNext: normal', 'fixture-session'],
    ['{"apiKey": "fixture-key-value", "maxTokens": 123}', 'fixture-key-value'],
    ["DB_PASSWORD='fixture database password'", 'fixture database password'],
    ['OPENAI_API_KEY=fixture-env-key', 'fixture-env-key'],
    ['curl --password "fixture secret"', 'fixture secret'],
    ["curl --token 'fixture secret'", 'fixture secret'],
    ['curl --token fixture-token', 'fixture-token'],
    ['https://example.test/?X-Amz-Signature=fixture-signature&part=1', 'fixture-signature'],
    ['postgres://tester:fixture-password@example.test/db', 'fixture-password'],
    ['eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.Zml4dHVyZQ', 'eyJhbGciOiJub25lIn0'],
    ['github_pat_' + 'a'.repeat(30), 'github_pat_'],
  ];
  for (const [input, sensitive] of samples) {
    const result = scope().protectRaw(input);
    assert.ok(result.matches.length > 0, input);
    assert.equal(result.text.includes(sensitive), false, input);
  }
});

test('basic protects explicit Chinese secrets and non-Bearer authorization without hiding ordinary descriptions', () => {
  const detector = core.createDetector();
  const samples = [
    ['密码是 fixture-password-01，请保管', 'fixture-password-01'],
    ['API密钥：fixture-key-02', 'fixture-key-02'],
    ['{"密码":"fixture-json-secret"}', 'fixture-json-secret'],
    ['访问令牌为 “fixture token with spaces”', 'fixture token with spaces'],
    ["口令='fixture spaced password'", 'fixture spaced password'],
    ['Authorization: Digest username="fixture", response="012345fixture"', 'username="fixture", response="012345fixture"'],
    ['Proxy-Authorization: ApiKey fixture-value\r\n continuation-value', 'fixture-value\r\n continuation-value'],
  ];
  for (const [input, value] of samples) {
    const s = scope({ detector }), result = s.protectRaw(input);
    assert.equal(result.text.includes(value), false); assert.ok(result.matches.some(m => m.category === 'CREDENTIAL'));
    assert.equal(s.restoreForTool(result.text, allowed({ category: 'CREDENTIAL', authorize: () => true, allowCredentialEmbedding: true })), input);
  }
  for (const input of ['请修改密码长度要求', '密钥管理文档', 'tokenCount=100 maxTokens=4096']) assert.equal(detector.detect(input).length, 0);
});

test('personal category is optional; bare identity validation and explicit card context reduce false positives', () => {
  const base = scope({ detector: core.createDetector() });
  assert.equal(base.protectRaw('user@example.test 13800138000').matches.length, 0);
  const detector = core.createDetector({ personal: true });
  const cnId = prefix => { const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]; return prefix + '10X98765432'[w.reduce((s, n, i) => s + n * Number(prefix[i]), 0) % 11]; };
  const validId = cnId('11010120000101001'), invalidDate = cnId('11010120000230001');
  assert.ok(detector.detect(validId).some(m => m.category === 'IDENTITY'));
  assert.equal(detector.detect(invalidDate).some(m => m.category === 'IDENTITY'), false);
  assert.equal(detector.detect(validId.slice(0, -1) + (validId.endsWith('0') ? '1' : '0')).some(m => m.category === 'IDENTITY'), false);
  assert.ok(detector.detect('card: 4111 1111 1111 1111').some(m => m.category === 'PAYMENT'));
  assert.equal(detector.detect('订单 4111111111111111').some(m => m.category === 'PAYMENT'), false);
  assert.ok(detector.detect('card: 4111111111111112').some(m => m.category === 'PAYMENT'), 'a mistyped explicitly labelled card is still sensitive');
  assert.deepEqual(plain(detector.detect('maxTokens=4096 tokenCount=100 schemaVersion=1 SHA=' + 'f'.repeat(64))), []);
});

test('explicit Chinese identity labels protect mistyped, grouped, full-width and old-format values', () => {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const prefix = '11010120000101001';
  const valid = prefix + '10X98765432'[weights.reduce((sum, n, i) => sum + n * Number(prefix[i]), 0) % 11];
  const typo = valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0');
  const fullWidth = typo.replace(/[0-9]/g, n => String.fromCharCode(n.charCodeAt(0) + 0xfee0));
  const variants = [valid, typo, typo.slice(0, 6) + ' ' + typo.slice(6, 14) + ' ' + typo.slice(14),
    typo.slice(0, 6) + '-' + typo.slice(6), fullWidth, '110101000101001'];
  for (const value of variants) {
    for (const label of ['我的身份证号是', '身份证号码：', '居民身份证号为 ', '"身份证号码": "']) {
      const s = scope(), input = label + value + '，请分析';
      const protectedValue = s.protectRaw(input);
      assert.equal(protectedValue.text.includes(value), false, 'labelled synthetic identity must be hidden');
      assert.ok(protectedValue.matches.some(m => m.category === 'IDENTITY'));
      assert.equal(s.restoreForTool(protectedValue.text, allowed({ category: 'IDENTITY', authorize: () => true })), input);
      assert.equal(core.createDetector().detect(input).some(m => m.category === 'IDENTITY'), false, 'basic stays opt-in for personal data');
    }
  }
  const detector = core.createDetector({ personal: true });
  for (const field of ['/身份证', '/身份证号', '/身份证号码', '/居民身份证号']) {
    assert.ok(detector.detect(typo, { pointer: field }).some(m => m.category === 'IDENTITY'), field);
  }
  assert.equal(detector.detect('订单号：' + typo).some(m => m.category === 'IDENTITY'), false);
  assert.equal(detector.detect('身份证号：1234').some(m => m.category === 'IDENTITY'), false);
});

test('limits and unsupported custom regex fail explicitly, never return an unscanned tail', () => {
  const detector = core.createDetector();
  assertCode(() => detector.detect('a'.repeat(core.LIMITS.bytes + 1)), 'text_limit');
  assertCode(() => core.createDetector({ patterns: ['(a+)+$'] }), 'regex_worker_required');
  assertCode(() => core.createDetector({ rules: [{ id: 'r', kind: 'literal', value: '', category: 'INTERNAL' }] }), 'rule_empty');
  assertCode(() => core.createDetector({ knownSecrets: Array(201).fill('x') }), 'rules_limit');
  const d = core.createDetector({ knownSecrets: ['x'] });
  assertCode(() => d.detect('x'.repeat(10001)), 'matches_limit');
  const s = scope({ detector: core.createDetector({ rules: [{ id: 'big', kind: 'field', value: '/value', category: 'INTERNAL' }] }) });
  const token = s.protectRaw('x'.repeat(600000), { pointer: '/value' }).text;
  assertCode(() => s.restoreForTool(token + token, allowed({ authorize: () => true })), 'text_limit');
});

test('bounded builtin detection handles long near-misses without a backtracking stall', { timeout: 4000 }, () => {
  const detector = core.createDetector({ personal: true });
  for (const input of ['a'.repeat(500000), ' '.repeat(500000), 'tokenCount='.repeat(40000)]) {
    assert.deepEqual(plain(detector.detect(input)), []);
  }
});

const binding = { instanceId: 'instance-test', purpose: 'credential', recordId: 'provider-test' };
test('authenticated envelopes round-trip Unicode and generate fresh nonces without plaintext fields', () => {
  const key = crypto.randomBytes(32), text = '合成测试\n' + secret;
  const a = core.seal(text, key, binding, 'key-v1'), b = core.seal(text, key, binding, 'key-v1');
  assert.notEqual(a.nonce, b.nonce); assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(JSON.stringify(a).includes(secret), false);
  assert.equal(core.open(a, key, binding, 'key-v1'), text);
  assert.equal(core.open(core.seal('', key, binding, 'key-v1'), key, binding, 'key-v1'), '');
  assertCode(() => core.seal('\ud800', key, binding, 'key-v1'), 'unicode_invalid');
});

test('ciphertext tampering, key changes and record/purpose/instance swaps all fail with uniform errors', () => {
  const key = crypto.randomBytes(32), envelope = core.seal('fixture', key, binding, 'key-v1');
  for (const field of ['nonce', 'ciphertext', 'tag']) {
    const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1;
    assertCode(() => core.open({ ...envelope, [field]: bytes.toString('base64') }, key, binding, 'key-v1'), 'decrypt_failed');
  }
  for (const field of ['instanceId', 'purpose', 'recordId']) {
    assertCode(() => core.open(envelope, key, { ...binding, [field]: 'other' }, 'key-v1'), 'decrypt_failed');
  }
  assertCode(() => core.open(envelope, crypto.randomBytes(32), binding, 'key-v1'), 'decrypt_failed');
  assertCode(() => core.open(envelope, key, binding, 'key-v2'), 'decrypt_failed');
  assertCode(() => core.open({ ...envelope, nonce: 'invalid' }, key, binding, 'key-v1'), 'decrypt_failed');
  assertCode(() => core.open({ ...envelope, plaintext: 'bad' }, key, binding, 'key-v1'), 'decrypt_failed');
});
