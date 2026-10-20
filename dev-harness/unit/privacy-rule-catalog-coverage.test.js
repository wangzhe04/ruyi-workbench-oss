'use strict';
// Synthetic data only. These exercise the actual detector and scope, not copied rule regexes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCorpus, createValidationCorpus, createMixedCorpus } = require('../privacy-31/synthetic-catalog-corpus');
const source = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const { core, catalog } = vm.runInNewContext(source('01i-privacy-rules.js') + '\n' + source('01h-privacy-core.js')
  + '\n({ core: PrivacyCore, catalog: PrivacyRuleCatalog });', { require, Buffer });
const all = { personal: true, technical: true, confidential: true };
const metadata = new Map(catalog.list().map(row => [row.id, row]));
const second = require('../privacy-31/second-scenario-corpus').createSecondCorpus();
for (const row of second.cases) test('second scenarios: complete ' + row.id, () => verify(row.sample, row.secret, row.tier === 'basic' ? {} : { personal: true }));
const third = require('../privacy-31/third-scenario-corpus').createThirdCorpus();
for (const row of third.cases) test('third scenarios: complete ' + row.id, () => verify(row.sample, row.secret, row.tier === 'basic' ? {} : { personal: true }));
test('third scenarios preserve business identifiers, redacted content, public encodings and disabled technical fields', () => {
  const detector = core.createDetector({ personal: true });
  for (const sample of [...third.negatives, ...third.technical]) assert.equal(detector.detect(sample).length, 0, sample);
  for (const pointer of ['/email', '/phone', '/idCard', '/cardNumber']) {
    const value = pointer === '/email' ? 'zhang***@126.com' : '138****0022';
    assert.equal(detector.detect(value, { pointer }).length, 0, pointer);
  }
  for (const sample of ['姓名：李*四', '姓名：李*四。']) assert.equal(detector.detect(sample).length, 0, sample);
  assert.equal(detector.detect('李*四', { pointer: '/fullName' }).length, 0);
  for (const sample of third.technical) assert.ok(core.createDetector({ technical: true }).detect(sample).length > 0);
});
test('encoded discovery is one level, bounded, exact on restoration and does not execute custom regex on decoded data', () => {
  const email = 'encoding-contract@example.test', encoded = Buffer.from(email).toString('base64');
  verify(encoded, encoded, { personal: true });
  verify(encodeURIComponent(email), encodeURIComponent(email), { personal: true });
  const detector = core.createDetector({ personal: true });
  assert.equal(detector.detect(Buffer.from(encoded).toString('base64')).length, 0, 'no recursive decoding');
  assert.equal(detector.detect('A'.repeat(9000)).length, 0, 'large binary/garbage is not a secret');
  assert.equal(detector.detect('%E0%A4%A').length, 0, 'malformed percent escapes do not break requests');
  const inputs = [];
  core.createDetector({ personal: true, rules: [{ id: 'custom-sentinel', kind: 'regex', value: 'SENTINEL', category: 'INTERNAL' }],
    regexMatches: input => { inputs.push(input); return []; } }).detect(encoded);
  assert.deepEqual(inputs, [encoded]);
  verify('DB_PASS: "Synthetic secret with spaces"', 'Synthetic secret with spaces', {});
  const literal = core.createDetector({ personal: true, rules: [{ id: 'explicit-mask', kind: 'literal', value: 'zhang***@126.com', category: 'EMAIL' }] });
  assert.equal(literal.detect('zhang***@126.com').length, 1, 'explicit custom rules remain authoritative');
});
test('second scenarios: public business identifiers, ambiguous forms and technical off stay visible', () => {
  const detector = core.createDetector({ personal: true, confidential: true, technical: false });
  for (const sample of [...second.negatives, ...second.technical]) assert.equal(detector.detect(sample).length, 0, sample);
  const technical = core.createDetector({ personal: true, technical: true });
  for (const sample of second.technical) assert.ok(technical.detect(sample).length > 0);
});
test('short learned CVV/OTP values do not replace numeric substrings inside public business identifiers', () => {
  const scope = core.createScope({ scopeId: 'short-numeric-context', detector: core.createDetector({ personal: true }) });
  try {
    const token = scope.protectValue('808', 'CREDENTIAL');
    const publicText = '订单 2026102080812345678；运单 SF8081234567890；商品条码 6901808123456；版本 v8.808.1';
    assert.equal(scope.protectRaw(publicText).text, publicText);
    const privateText = scope.protectRaw('CVV: 808').text;
    assert.ok(!privateText.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '').includes('808'));
    assert.equal(scope.restoreForTool(token, { scopeId: 'short-numeric-context', tool: 'file_write', pointer: '/content', authorize: () => true }), '808');
    scope.revoke(token);
    assert.equal(scope.protectRaw(publicText).text, publicText);
    assert.throws(() => scope.protectRaw('CVV: 808'), /privacy.reference_revoked/);
  } finally { scope.clear(); }
});
let sequence = 0;
function verify(sample, secret, options = all, context = {}) {
  const scopeId = 'catalog-adversarial:' + sequence++;
  const scope = core.createScope({ scopeId, detector: core.createDetector(options) });
  try {
    const start = sample.indexOf(secret);
    assert.ok(start >= 0);
    const matches = scope.detect(sample, context);
    assert.ok(matches.some(match => match.start <= start && match.end >= start + secret.length), 'complete value, never a prefix: ' + sample.slice(0, 80));
    const protectedValue = scope.protectRaw(sample, context);
    const visible = protectedValue.text.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '');
    assert.ok(!visible.includes(secret), 'no complete original outside references');
    // Comparing the union's exact original slices also catches short retained secret suffixes.
    let at = 0, expected = '';
    for (const match of protectedValue.matches) {
      expected += sample.slice(at, match.start); at = match.end;
    }
    expected += sample.slice(at);
    assert.equal(visible, expected);
    assert.equal(scope.restoreForTool(protectedValue.text, { scopeId, tool: 'synthetic_contract', pointer: context.pointer || '/text',
      destination: 'synthetic-local', purpose: 'unit', authorize: () => true, allowCredentialEmbedding: true }), sample);
    return matches;
  } finally { scope.clear(); }
}

const baseline = createCorpus('adversarial-catalog-only');
test('every executable catalog rule has synthetic positive, negative, boundary and tier coverage', () => {
  assert.equal(metadata.size, 45);
  assert.equal(catalog.version, 5);
  assert.deepEqual(baseline.map(row => row.id).sort(), [...metadata.keys()].sort());
  assert.deepEqual(createValidationCorpus().map(row => row.id).sort(), [...metadata.keys()].sort());
});
for (const row of baseline) test('catalog ' + row.id + ': exact full scope, original offsets, unicode wrapper and tier', () => {
  const detail = metadata.get(row.id);
  for (const sample of [row.sample, '🙂前文\n' + row.sample + '\n后文', JSON.stringify({ nested: [{ text: row.sample }] }).includes('\\') ? null : JSON.stringify({ text: row.sample })].filter(Boolean)) {
    const expectedStart = sample.indexOf(row.secret), found = [];
    catalog.scan(sample, all, (start, end, category, id) => found.push({ start, end, category, id }));
    assert.ok(found.some(match => match.id === row.id && match.start <= expectedStart && match.end >= expectedStart + row.secret.length), row.id + ' exact original interval');
    verify(sample, row.secret);
  }
  if (detail.tier !== 'basic') {
    const detector = core.createDetector();
    assert.equal(detector.detect(row.sample).length, 0, 'basic does not enable ' + detail.tier);
  }
  const overrides = { ruleOverrides: { [row.id]: true } };
  verify(row.sample, row.secret, overrides);
  const disabled = [];
  catalog.scan(row.sample, { ...all, ruleOverrides: { [row.id]: false } }, (...match) => disabled.push(match));
  assert.ok(disabled.every(match => match[3] !== row.id), 'individual opt-out respected');
});

for (const row of createValidationCorpus()) test('adversarial ' + row.id + ': positive boundaries and neighboring negatives', () => {
  for (const item of row.positive) {
    const hits = [];
    catalog.scan(item.sample, all, (start, end, category, id) => hits.push({ start, end, id }));
    const start = item.sample.indexOf(item.secret);
    assert.ok(hits.some(hit => hit.id === row.id && hit.start <= start && hit.end >= start + item.secret.length), row.id + ': full catalog capture ' + item.sample.slice(0, 90));
    verify(item.sample, item.secret);
  }
  for (const sample of row.negative) {
    const hits = [];
    catalog.scan(sample, all, (start, end, category, id) => hits.push(id));
    assert.ok(!hits.includes(row.id), row.id + ': neighboring negative ' + sample);
  }
});

test('structured nested bilingual fields use the same full-value policy and preserve arbitrary spelling', () => {
  const credentialFields = ['密码', '密钥', '私钥', '验证码', '恢复码', 'api_key', 'client-secret', 'Authorization', 'Set-Cookie', 'auth', 'otp', 'one_time_password', 'pin-code', 'API密钥', 'api密钥', '访问令牌', '刷新令牌'];
  const personalFields = ['姓名', '收货地址', '医保号', '护照号', '银行账户', '身份证号码', '电子邮箱', '手机号码', 'full_name', 'date-of-birth',
    'passportNumber', 'driverLicense', 'driver_license_number', 'driversLicense', 'driversLicenseNumber', 'driverLicence', 'driverLicenceNumber',
    'taxId', 'TIN', 'social_security_number', 'nationalId', 'bankAccountNumber', 'account_number', 'medicalRecordNumber', 'patientId', 'postalAddress', 'contactName', 'birthDate'];
  for (const field of [...credentialFields, ...personalFields]) {
    const pointer = '/nested/0/' + field, secret = '合成值🙂\\"\n编号００７';
    const options = credentialFields.includes(field) ? {} : all;
    verify(secret, secret, options, { pointer });
    const matches = core.createDetector().detect(secret, { pointer });
    assert.equal(matches.length > 0, credentialFields.includes(field), 'basic structured tier: ' + field);
  }
  for (const field of ['order_id', 'maxTokens', 'tokenCount', 'timestamp', 'port', 'count', 'normal_name']) {
    assert.equal(core.createDetector(all).detect('8192', { pointer: '/nested/0/' + field }).length, 0, field);
  }
});

test('quoted JSON personal labels and newline property syntax do not leak even invalid labelled identities', () => {
  for (const [field, secret] of [['SSN', '000-00-0000'], ['passport_number', 'BADPASS9'], ['full_name', '李'], ['patient_id', 'ERR-001'],
    ['tax_id', 'FAKE123456'], ['home_address', '合成测试路0号'], ['出生日期', '2099-99-99'], ['诊断结果', '合成诊断']]) {
    verify('🙂{"' + field + '"\n:\n"' + secret + '"}', secret);
    verify("{'" + field + "':'" + secret + "'}", secret);
  }
});

test('apostrophes within multilingual names and private prose are not treated as an exposed suffix', () => {
  for (const [label, secret] of [['姓名', "O'Brien"], ['家庭住址', "12 King's Road"], ['诊断结果', "Crohn's synthetic record"], ['保密代号', "Alice's project"]]) {
    verify(label + '：' + secret, secret);
    verify('{"' + label + '":"' + secret + '"}', secret);
    verify(label + ": '" + secret + "'", secret);
  }
});

test('clear Chinese labels support common conversational names and grouped mobile values without arbitrary numeric matching', () => {
  for (const [sample, secret] of [['姓名是合成甲', '合成甲'], ["联系人为O'Brien", "O'Brien"], ['手机号：139 0000 0088', '139 0000 0088'],
    ['手机号是139-0000-0088', '139-0000-0088'], ['手机号码为139 0000 0088', '139 0000 0088'], ['联系电话：86 139-0000-0088', '86 139-0000-0088']]) {
    verify('🙂' + sample, secret);
    assert.equal(core.createDetector().detect(sample).length, 0, 'basic does not enable personal conversational labels');
  }
  for (const sample of ['订单号：139 0000 0088', '计数为139-0000-0088', 'rename is ordinary', '名称为普通对象', '手机号的格式是三四四分组']) {
    assert.equal(core.createDetector(all).detect(sample).length, 0, 'neighboring ordinary label: ' + sample);
  }
});

test('input and mapping budgets fail closed; near-limit prefixed runs stay fully protected', t => {
  const start = performance.now(), secret = 'glpat-' + 'a'.repeat(1024 * 1024 - 20) + '-TAIL';
  verify(secret, secret);
  const detector = core.createDetector(all);
  assert.throws(() => detector.detect('a'.repeat(1024 * 1024 + 1)), error => error.code === 'privacy.text_limit');
  const scopeId = 'catalog-size-guard', scope = core.createScope({ scopeId, detector });
  try {
    scope.protectValue('x'.repeat(600000), 'INTERNAL');
    assert.throws(() => scope.protectRaw(secret), error => error.code === 'privacy.mapping_limit');
    assert.equal(scope.size(), 1, 'failed oversize mapping is not emitted');
  } finally { scope.clear(); }
  t.diagnostic('near-limit detector/scope/overflow checks: ' + (performance.now() - start).toFixed(2) + ' ms');
});

test('long truncated secret syntax still protects its entire remaining value without unrelated false positives', t => {
  const detector = core.createDetector(all), start = performance.now();
  for (const sample of ['<password>' + 'A'.repeat(300000), 'sshpass -p "' + 'A'.repeat(300000), 'redis://:' + 'A'.repeat(300000)]) {
    // A truncated copy/paste still has an unambiguous secret label. Its missing closing delimiter
    // is not permission to disclose the value, and does not cause a backtracking stall.
    verify(sample, 'A'.repeat(300000));
  }
  for (const sample of ['订单号：1234567890123456789', 'port=8192 count=200 maxTokens=32768', 'const name = "ordinary";', '密码需要至少八个字符']) {
    assert.equal(detector.detect(sample).length, 0, sample);
  }
  t.diagnostic('three 300k truncated secret scope round trips: ' + (performance.now() - start).toFixed(2) + ' ms');
});

test('overlapping field and credential rules keep full coverage and strongest classification', () => {
  const sample = '姓名：glpat-' + 'a'.repeat(300) + '-TAIL';
  const matches = verify(sample, sample.slice(3));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].category, 'CREDENTIAL');
  assert.ok(matches[0].ruleIds.includes('credential.gitlab'));
  assert.ok(matches[0].ruleIds.includes('personal.contact-name'));
});

test('nested token-looking prefixes within one near-limit run are emitted once and remain linear', t => {
  for (const [id, fragment] of [['credential.gitlab', 'glpat-' + 'A'.repeat(20) + '-'], ['credential.google-oauth', 'ya29.' + 'A'.repeat(20) + '.']]) {
    const sample = fragment.repeat(Math.floor((1024 * 1024 - 32) / fragment.length)), start = performance.now(), hits = [];
    catalog.scan(sample, {}, (from, end, category, ruleId) => { if (ruleId === id) hits.push({ from, end }); });
    assert.deepEqual(hits, [{ from: 0, end: sample.length }], 'each already covered run is visited once');
    verify(sample, sample, {});
    t.diagnostic(id + ': ' + sample.length + ' bytes, one full interval and exact scope restore in ' + (performance.now() - start).toFixed(2) + ' ms');
  }
});

test('mixed operations, service and recruiting corpus protects complete values at the selected tier', () => {
  const { sample: marked, prose, cases } = createMixedCorpus();
  const entities = cases.flatMap(row => row.secrets || [row.secret]);
  assert.equal(entities.length, 47); assert.equal(new Set(entities).size, 47, 'each independently counted entity has its own synthetic value');
  assert.ok(entities.every(secret => prose.includes(secret) && marked.includes(secret)), 'no absent fixture value may pass the no-leak assertion vacuously');
  for (const sample of [marked, prose]) for (const technical of [false, true]) {
    const detector = core.createDetector({ ...all, technical });
    const matches = detector.detect(sample);
    for (const row of cases) {
      for (const secret of row.secrets || [row.secret]) {
        let from = 0;
        while ((from = sample.indexOf(secret, from)) >= 0) {
          const start = from, end = start + secret.length;
          assert.equal(matches.some(match => match.start <= start && match.end >= end), row.tier !== 'technical' || technical, row.id + ': technical=' + technical);
          from = end;
        }
      }
    }
    verify(sample, sample.slice(sample.indexOf(cases[0].secret), sample.indexOf(cases[0].secret) + cases[0].secret.length), { ...all, technical });
    const scope = core.createScope({ scopeId: 'mixed-corpus-copy:' + sequence++, detector });
    try {
      const protectedCopy = scope.protectRaw(sample).text.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '');
      for (const row of cases) for (const secret of row.secrets || [row.secret]) {
        assert.equal(protectedCopy.includes(secret), row.tier === 'technical' && !technical, row.id + ': independently visible raw entity');
      }
    } finally { scope.clear(); }
  }
  for (const row of cases) {
    const matches = core.createDetector().detect(row.sample);
    for (const secret of row.secrets || [row.secret]) {
      const start = row.sample.indexOf(secret), end = start + secret.length;
      assert.equal(matches.some(match => match.start <= start && match.end >= end), row.tier === 'basic', row.id + ': basic boundary');
      if (row.tier !== 'technical') verify(row.sample, secret);
    }
  }
});

test('mixed clear-label rules preserve adjacent public instructions and ordinary numeric/code fields', () => {
  for (const [sample, secret, visible] of [['家庭住址：合成市示例区测试路99号，快递放前台', '合成市示例区测试路99号', '，快递放前台'],
    ['QiniuAK: SYNTHETIC-ACCESS-KEY；公开操作说明', 'SYNTHETIC-ACCESS-KEY', '；公开操作说明'],
    ['工号 EMP-99881，公开职位说明', 'EMP-99881', '，公开职位说明']]) {
    verify(sample, secret);
    const s = core.createScope({ scopeId: 'mixed-adjacent:' + sequence++, detector: core.createDetector(all) });
    try { assert.ok(s.protectRaw(sample).text.endsWith(visible)); } finally { s.clear(); }
  }
  for (const sample of ['request_id=99887766; file_name=ordinary.txt; token_count=200; port=8192',
    'order: EMP-99881; build: 12/29; checksum: 99SYNTHETIC00000001', 'https://example.test/hooks/documentation',
    '车牌识别说明与公积金查询指南', '公开医学讨论，不包含诊断结果字段', 'version=1.2.3.4']) {
    assert.equal(core.createDetector(all).detect(sample).length, 0, sample);
  }
});

test('prefixed and selected backup field names preserve explicit sensitive family suffixes only', () => {
  for (const [pointer, personal] of [['/config/worker_aws_secret_access_key', false], ['/config/prod_SMTP_PASSWORD', false],
    ['/config/qiniu_sk', false], ['/config/app_secret', false], ['/config/CVV2', false], ['/customer/emergency_contact_phone', true],
    ['/customer/full_name_backup', true], ['/employee/employee_id', true], ['/customer/registered_home_address', true]]) {
    const secret = 'SYNTHETIC-CUSTOM-FIELD-ONLY';
    verify(secret, secret, personal ? all : {}, { pointer });
  }
  for (const pointer of ['/request_id', '/file_name', '/token_count', '/constructor', '/phone_count', '/name_length']) {
    assert.equal(core.createDetector(all).detect('8192', { pointer }).length, 0, pointer);
  }
});

test('original no-scheme profiles, relative webhook secrets and family landlines keep exact boundaries', () => {
  for (const [sample, secret, personal] of [
    ['领英 linkedin.com/in/synthetic-recruiting-person，公开说明', 'linkedin.com/in/synthetic-recruiting-person', true],
    ['Webhook secret在路径里： /hooks/' + 'a1'.repeat(32) + '，公开说明', '/hooks/' + 'a1'.repeat(32), false],
    ['母亲 021-55550129，公开说明', '021-55550129', true],
    ['备用021-5555-0128 转18，公开说明', '021-5555-0128 转18', true],
  ]) {
    const matches = verify(sample, secret), start = sample.indexOf(secret);
    assert.ok(matches.some(match => match.start === start && match.end === start + secret.length));
    assert.equal(core.createDetector().detect(sample).length > 0, !personal, 'basic boundary');
    const scope = core.createScope({ scopeId: 'original-format:' + sequence++, detector: core.createDetector(all) });
    try { assert.ok(scope.protectRaw(sample).text.endsWith('，公开说明')); } finally { scope.clear(); }
  }
  for (const sample of ['fakelinkedin.com/in/synthetic-person', 'https://fakelinkedin.com/in/synthetic-person',
    'https://linkedin.com.evil.test/in/synthetic-person',
    'https://example.test/linkedin.com/in/synthetic-person', 'linkedin.com/company/synthetic-company',
    '/hooks/documentation', '/hooks/' + 'a'.repeat(31), '/hooks/' + 'a'.repeat(64) + 'xyz',
    'ordinary/hooks/' + 'a'.repeat(64), '订单号021-55550129', '备用端口021-55550129', '母亲编号 EMP-99881']) {
    assert.equal(core.createDetector(all).detect(sample).length, 0, sample);
  }
  const emailMatches = core.createDetector(all).detect('user@linkedin.com/in/synthetic-person');
  assert.ok(emailMatches.length > 0, 'an actual email still has its separate protection');
  assert.ok(emailMatches.every(match => !match.ruleIds.includes('personal.profile-url')), 'an email suffix is not a bare profile URL');
});

test('birth-date short explanations stay within the explicit label and sentence boundary', () => {
  const date = '1999-12-31';
  for (const prefix of ['出生日期我简历写了 ', '生日我登记的是 ', '出生日期' + '甲'.repeat(16)]) {
    const sample = prefix + date + '，其实证件仅用于合成测试';
    const matches = verify(sample, date), start = sample.indexOf(date);
    assert.ok(matches.some(match => match.start === start && match.end === start + date.length));
    assert.equal(core.createDetector().detect(sample).length, 0, 'basic leaves birth dates outside credentials');
  }
  for (const sample of ['出生日期不详，下次约 2026-11-30', '出生日期不详;下次约 2026-11-30',
    '出生日期不详。下次约 2026-11-30', '出生日期不详\n下次约 2026-11-30',
    '出生日期第2次登记 1999-12-31', '出生日期' + '甲'.repeat(17) + date]) {
    assert.equal(core.createDetector(all).detect(sample).length, 0, sample);
  }
});

test('quoted Qiniu AK and SK consume the entire secret and preserve public neighbors', () => {
  const ak = 'SYNTHETIC VALUE', sk = 'SYNTHETIC;TAIL!#@42/+', visible = '；公开说明 count=200 port=8192';
  const sample = 'QiniuAK: "' + ak + '", QiniuSK: \'' + sk + '\'' + visible;
  for (const secret of [ak, sk]) {
    const matches = verify(sample, secret, {}), start = sample.indexOf(secret);
    assert.ok(matches.some(match => match.start === start && match.end === start + secret.length), 'the value capture excludes only the surrounding quotes');
  }
  const scope = core.createScope({ scopeId: 'qiniu-quoted-neighbors', detector: core.createDetector() });
  try { assert.ok(scope.protectRaw(sample).text.endsWith(visible)); } finally { scope.clear(); }
  for (const [secret, before, after] of [['SYNTHETIC, VALUE;TAIL', 'QiniuAK: "', '"'], ['SYNTHETIC VALUE;TAIL', "QiniuSK: '", "'"],
    ['SYNTHETIC\\"VALUE;TAIL', 'QiniuAK: "', '"'], ['SYNTHETIC VALUE;TAIL', 'QiniuSK: "', ''],
    ['SYNTHETIC TRAILING\\', 'QiniuSK: "', ''], ['SYNTHETIC ' + 'A'.repeat(5000) + ';TAIL', 'QiniuAK: "', '"']]) {
    verify(before + secret + after, secret, {});
  }
  const partial = core.createScope({ scopeId: 'qiniu-truncated-line', detector: core.createDetector() });
  try { assert.ok(partial.protectRaw('QiniuSK: "SYNTHETIC VALUE;TAIL\n公开下一行 count=200').text.endsWith('\n公开下一行 count=200')); } finally { partial.clear(); }
  assert.equal(core.createDetector().detect('公开说明 count=200 port=8192; Qiniu 使用指南').length, 0);
});
