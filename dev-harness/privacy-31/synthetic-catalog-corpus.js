'use strict';
// Synthetic detector corpus only. Creation never reads config, credentials, user files or the network.
const crypto = require('node:crypto');

function createCorpus(marker) {
  if (typeof marker !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(marker)) throw new Error('synthetic_marker_invalid');
  const hash = crypto.createHash('sha256').update('ruyi-synthetic-catalog:' + marker).digest('hex');
  const tag = hash.slice(0, 16), token = hash.slice(0, 40);
  const number = (start, length) => String(parseInt(hash.slice(start, start + 8), 16)).padStart(length, '0').slice(-length);
  const rows = [];
  const add = (id, secret, before = '', after = '') => rows.push({ id, sample: before + secret + after, secret });
  add('credential.gitlab', 'glpat-' + token);
  add('credential.npm', 'npm_' + token);
  add('credential.pypi', 'pypi-' + hash);
  add('credential.huggingface', 'hf_' + token);
  add('credential.google-api', 'AIza' + hash.slice(0, 35));
  add('credential.google-oauth', 'ya29.' + token);
  add('credential.stripe', 'sk_test_' + token);
  add('credential.sendgrid', 'SG.' + tag + '.' + token);
  add('credential.slack-webhook', 'https://hooks.slack.com/services/' + tag + '/' + tag + '/' + token);
  add('credential.discord-webhook', 'https://discord.com/api/webhooks/' + number(0, 10) + '/' + token);
  add('credential.teams-webhook', 'https://synthetic.webhook.office.com/webhookb2/' + token);
  add('credential.aws-temporary-id', 'ASIA' + tag.toUpperCase());
  add('credential.azure-sas', 'synthetic-sas-' + tag, 'https://storage.example.test/blob?sig=');
  add('credential.signed-query', 'synthetic-signed-' + tag, 'https://storage.example.test/object?X-Goog-Signature=');
  add('credential.redis-auth', 'synthetic-redis-' + tag, 'redis://:', '@redis.example.test:6379');
  add('credential.sql-password', 'synthetic-sql-' + tag, 'Server=database.example.test;Password=', ';Database=fixture');
  add('credential.xml-secret', 'synthetic-xml-' + tag, '<password>', '</password>');
  add('credential.docker-auth', Buffer.from('synthetic:' + tag).toString('base64'), 'Docker auth entry "auth":"', '"');
  add('credential.ssh-password', 'synthetic-ssh-' + tag, "sshpass -p '", "' fixture-command");
  add('credential.otp', number(0, 6), '验证码：');
  add('credential.recovery-code', 'SYNTHETIC-' + tag.toUpperCase(), '恢复码：');
  add('credential.wallet-private', '0x' + hash, '钱包私钥：');
  add('credential.integration-secret', 'synthetic-qiniu-' + token, 'QiniuAK: ');
  add('personal.cn-landline', '010-5555' + number(8, 4), '座机：');
  add('personal.international-phone', '+1 202 555 01' + number(8, 2), 'phone: ');
  add('personal.passport-labelled', 'EX' + number(0, 8), 'passport: ');
  add('personal.social-security', '123-45-' + String(1 + parseInt(hash.slice(8, 16), 16) % 9999).padStart(4, '0'), 'SSN: ');
  add('personal.driver-license', 'SYNTH-' + tag.slice(0, 12).toUpperCase(), '驾驶证号：');
  add('personal.tax-id', 'SYNTH' + tag.toUpperCase(), '税号：');
  add('personal.bank-account', 'TEST' + tag.toUpperCase(), '银行账户：');
  add('personal.payment-security', '9' + number(16, 2), 'CVV: ');
  add('personal.payment-expiry', '12/29', '银行卡有效期：');
  add('personal.birth-date', '2000-01-01', '出生日期：');
  add('personal.contact-name', '合成测试人' + tag, '姓名：');
  add('personal.address', '合成测试路99号' + tag, '家庭住址：');
  add('personal.health-record', 'PATIENT-' + tag.toUpperCase(), '病历号：');
  add('personal.diagnosis', '合成测试诊断' + tag, '诊断结果：');
  add('personal.vehicle', 'TESTVIN' + tag.slice(0, 10).toUpperCase(), '车架号：');
  add('personal.work-identifier', 'EMP-' + number(0, 5), '工号：');
  add('personal.profile-url', 'https://www.linkedin.com/in/synthetic-' + tag);
  add('technical.ipv4', '10.' + (16 + parseInt(hash.slice(0, 2), 16) % 200) + '.' + parseInt(hash.slice(2, 4), 16) + '.' + (1 + parseInt(hash.slice(4, 6), 16) % 254));
  add('technical.mac', ['02', ...hash.slice(0, 10).match(/../g)].join(':'));
  add('technical.windows-user-path', 'fixturewin_' + tag, 'C:\\Users\\', '\\synthetic-contact.txt');
  add('technical.posix-user-path', 'fixtureposix_' + tag, '/home/', '/synthetic-contact.txt');
  add('internal.classified-line', '合成保密项目' + tag, '保密代号：');
  return rows;
}

function checkCorpus() {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
  const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
  const api = vm.runInNewContext(read('01i-privacy-rules.js') + '\n' + read('01h-privacy-core.js') + '\n({ catalog: PrivacyRuleCatalog, core: PrivacyCore })', { require, Buffer });
  const rows = createCorpus('catalog-check-synthetic'), ids = api.catalog.list().map(rule => rule.id).sort();
  assert.equal(ids.length, 45, 'Update this full-catalog corpus when executable catalog rules change');
  assert.deepEqual(rows.map(row => row.id).sort(), Array.from(ids));
  const profiles = { personal: true, technical: true, confidential: true };
  const detector = api.core.createDetector(profiles);
  for (const [index, row] of rows.entries()) {
    const expectedStart = row.sample.indexOf(row.secret), expectedEnd = expectedStart + row.secret.length;
    assert.ok(expectedStart >= 0, row.id + ': expected capture must exist');
    const catalogMatches = [];
    api.catalog.scan(row.sample, profiles, (start, end, category, id) => catalogMatches.push({ start, end, category, id }));
    assert.ok(catalogMatches.some(match => match.id === row.id && match.start === expectedStart && match.end === expectedEnd), row.id + ': exact catalog capture/offset');
    assert.ok(detector.detect(row.sample).some(match => match.ruleIds.includes(row.id) && match.start <= expectedStart && match.end >= expectedEnd), row.id + ': merged core interval must cover the complete capture');
    const scope = api.core.createScope({ scopeId: 'catalog-check:' + index, detector });
    try {
      const result = scope.protectRaw(row.sample);
      const visible = result.text.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '');
      assert.ok(!visible.includes(row.secret), row.id + ': no original capture outside opaque references');
    } finally { scope.clear(); }
  }
  console.log('SYNTHETIC CATALOG CORPUS: 45 rules, exact captures and full core coverage PASS');
}

// Independent format/label adversaries. These values are deliberately synthetic, including invalid
// labelled identities: a typo in a sensitive value must not become permission to disclose it.
function createValidationCorpus() {
  const rows = [];
  const add = (id, secret, before, after, negative) => rows.push({ id, positive: [{ secret, sample: before + secret + after }], negative });
  add('credential.gitlab', 'glpat-' + 'A'.repeat(257) + '-TAIL', '', '', ['glpat-' + 'A'.repeat(19), 'gitlab release 123']);
  add('credential.npm', 'npm_' + 'A'.repeat(257), '', '', ['npm_' + 'A'.repeat(35), 'npm install fixture']);
  add('credential.pypi', 'pypi-' + 'A'.repeat(2049) + '_TAIL', '', '', ['pypi-' + 'A'.repeat(49), 'pypi package metadata']);
  add('credential.huggingface', 'hf_' + 'A'.repeat(257), '', '', ['hf_' + 'A'.repeat(19), 'hf_model']);
  add('credential.google-api', 'AIza' + 'A'.repeat(36), '', '', ['AIza' + 'A'.repeat(34), 'Google API documentation']);
  add('credential.google-oauth', 'ya29.' + 'A'.repeat(2049) + '.TAIL', '', '', ['ya29.' + 'A'.repeat(19), 'ya28.unchanged']);
  add('credential.stripe', 'rk_live_' + 'A'.repeat(257), '', '', ['rk_live_' + 'A'.repeat(15), 'sk_live_docs']);
  add('credential.sendgrid', 'SG.' + 'A'.repeat(16) + '.' + 'B'.repeat(257) + '-TAIL', '', '', ['SG.short.short', 'SG.' + 'A'.repeat(15) + '.' + 'B'.repeat(20)]);
  add('credential.slack-webhook', 'https://hooks.slack.com/services/' + 'A'.repeat(8) + '/' + 'B'.repeat(8) + '/' + 'C'.repeat(129), '', '', ['https://hooks.slack.com/services/short/short/short', 'https://hooks.slack.com.evil.test/services/AAAAAAAA/BBBBBBBB/CCCCCCCCCCCCCCCC']);
  add('credential.discord-webhook', 'https://discordapp.com/api/webhooks/1234567890/' + 'A'.repeat(257) + '_TAIL', '', '', ['https://discord.com/api/webhooks/123/short', 'https://discord.com.evil.test/api/webhooks/1234567890/' + 'A'.repeat(20)]);
  add('credential.teams-webhook', 'HTTPS://SYNTHETIC.WEBHOOK.OFFICE.COM/webhookb2/' + 'A'.repeat(2049), '', '', ['https://synthetic.webhook.office.com/webhookb2/short', 'https://example.test/webhookb2/' + 'A'.repeat(20)]);
  add('credential.aws-temporary-id', 'ASIA' + 'A'.repeat(17), '', '', ['ASIA' + 'A'.repeat(15), 'ASIA REGION']);
  add('credential.azure-sas', 'SYNTH%2F' + 'A'.repeat(4097), 'https://example.test/?SIG=', '&sp=read', ['https://example.test/?sig=', 'signature=example']);
  add('credential.signed-query', 'SYNTH%2F' + 'A'.repeat(4097), 'https://example.test/?CLIENT_SECRET=', '&view=1', ['https://example.test/?client_secret=', 'https://example.test/?ordinary=fixture']);
  add('credential.redis-auth', 'synthetic:' + 'A'.repeat(4097), 'REDISS://:', '@example.test:6379', ['redis://example.test:6379', 'redis://:@example.test']);
  add('credential.sql-password', 'synthetic ' + 'A'.repeat(4097), 'Server=example.test;PWD=', ';Database=test', ['password documentation', 'Server=example.test;Password=;Database=test']);
  add('credential.xml-secret', 'synthetic\n' + 'A'.repeat(4097), '<CLIENT_SECRET>', '</CLIENT_SECRET>', ['<password></password>', '<ordinary>synthetic</ordinary>']);
  add('credential.docker-auth', 'A'.repeat(4097) + '==', '{"auth":"', '"}', ['{"auth":"short"}', '{"author":"QUFBQUFBQUFB"}']);
  add('credential.ssh-password', 'synthetic password ' + 'A'.repeat(4097), 'sshpass -p "', '" command', ['sshpass -p "" command', 'ssh -p 22 example.test']);
  add('credential.otp', 'SYNTH' + 'A'.repeat(17), '{"one_time_password":"', '"}', ['OTP guide', 'OTP: 123']);
  add('credential.recovery-code', 'SYNTH-' + 'A'.repeat(129), '{"recovery_code":"', '"}', ['recovery code instructions', 'backup code: short']);
  add('credential.wallet-private', '0x' + 'A'.repeat(65), '{"private_key":"', '"}', ['private key: 0x123', 'public key: ' + 'A'.repeat(64)]);
  add('credential.integration-secret', 'SYNTHETIC-' + 'A'.repeat(4097), 'QiniuSK: ', '', ['Qiniu secret documentation', 'https://example.test/hooks/documentation', 'https://linkedin.com.evil.test/in/example', '/hooks/documentation', '/hooks/' + 'a'.repeat(31), 'ordinary/hooks/' + 'a'.repeat(64)]);
  add('personal.cn-landline', '010-55551234 转123', '{"电话":"', '"}', ['电话指南', 'order: 010-55551234', '母亲编号 EMP-99881', '备用端口021-55550129']);
  add('personal.international-phone', '+44 (20) 7946 0123', '{"PHONE":"', '"}', ['phone documentation', 'amount: +44 (20) 7946 0123']);
  add('personal.passport-labelled', 'SYNTHETIC123456789', '{"passport_number":"', '"}', ['passport: short', 'order: SYNTHETIC123456789']);
  add('personal.social-security', '000-00-0000', '{"SSN":"', '"}', ['SSN: 123-4-5678', 'order: 000-00-0000']);
  add('personal.driver-license', 'SYNTH-' + 'A'.repeat(25), '{"driver_license_number":"', '"}', ['driver license: tiny', 'order: SYNTH-AAAAA']);
  add('personal.tax-id', 'SYNTH-' + 'A'.repeat(25), '{"tax_id":"', '"}', ['tax id: short', 'order: SYNTH-12345678']);
  add('personal.bank-account', 'SYNTH' + 'A'.repeat(35), '{"bank_account":"', '"}', ['bank account: tiny', 'order: 0000000000000000']);
  add('personal.payment-security', '000', '{"CVV":"', '"}', ['CVV: 12', 'HTTP: 200']);
  add('personal.payment-expiry', '12/29', '有效期 ', '', ['有效期见说明书', 'version: 12/29', 'TTL=1200']);
  add('personal.birth-date', '2099/99/99', '{"date_of_birth":"', '"}', ['DOB unknown', 'version: 2026.10.20', '出生日期不详，下次约 2026-11-30']);
  add('personal.contact-name', '李', '{"full_name":"', '"}', ['full name unknown', 'ordinary: 李']);
  add('personal.address', '合成测试路' + '甲'.repeat(257), '{"home_address":"', '"}', ['home address unknown', 'ordinary: 合成测试路0号']);
  add('personal.health-record', 'ERR-' + 'A'.repeat(41), '{"patient_id":"', '"}', ['patient id: ab', 'order: ERR-12345']);
  add('personal.diagnosis', '合成诊断' + '甲'.repeat(257), '{"diagnosis":"', '"}', ['diagnosis unknown', 'ordinary: 合成诊断']);
  add('personal.vehicle', '京Z·T1234', '车牌 ', '', ['车牌识别说明', '版本 VIN-123', 'order TESTVIN0000000001']);
  add('personal.work-identifier', 'EMP-' + 'A'.repeat(41), '工号 ', '', ['门禁卡使用说明', 'employee documentation', 'order EMP-88421']);
  add('personal.profile-url', 'https://www.linkedin.com/in/synthetic-' + 'A'.repeat(257), '', '', ['https://linkedin.com.evil.test/in/synthetic-person', 'https://www.linkedin.com/company/synthetic-company', 'https://example.test/in/synthetic-person', 'fakelinkedin.com/in/synthetic-person', 'https://fakelinkedin.com/in/synthetic-person', 'user@linkedin.com/in/synthetic-person']);
  add('technical.ipv4', '172.31.255.254', 'http://', ':8080/a', ['10.256.0.1', '192.168.1.999', '8.8.8.8', '172.32.0.1', '110.1.1.1']);
  add('technical.mac', 'AB:CD:EF:01:23:45', '', '', ['AB:CD:EF:01:23', 'AB:CD:EF:01:23:GG']);
  add('technical.windows-user-path', '合成用户', 'c:/users/', '/file.txt', ['C:/ProgramData/fixture/file.txt', 'C:/Users/']);
  add('technical.posix-user-path', 'synthetic', '/Users/', '/file.txt', ['/usr/share/fixture.txt', '/home/']);
  add('internal.classified-line', '合成代号' + '甲'.repeat(257), '{"confidential_value":"', '"}', ['confidential value unknown', 'ordinary: 合成代号']);
  const extra = (id, secret, before = '', after = '') => rows.find(row => row.id === id).positive.push({ secret, sample: before + secret + after });
  for (const [id, prefix, length] of [['credential.gitlab', 'glpat-', 20], ['credential.npm', 'npm_', 36],
    ['credential.pypi', 'pypi-', 50], ['credential.huggingface', 'hf_', 20], ['credential.google-api', 'AIza', 35],
    ['credential.google-oauth', 'ya29.', 20], ['credential.stripe', 'sk_test_', 16], ['credential.aws-temporary-id', 'ASIA', 16]]) {
    extra(id, prefix + 'A'.repeat(length));
  }
  extra('credential.sendgrid', 'SG.' + 'A'.repeat(16) + '.' + 'B'.repeat(20));
  extra('credential.slack-webhook', 'https://hooks.slack.com/services/AAAAAAAA/BBBBBBBB/CCCCCCCCCCCCCCCC');
  extra('credential.discord-webhook', 'https://discord.com/api/webhooks/1234567890/' + 'A'.repeat(20));
  extra('credential.teams-webhook', 'https://fixture.webhook.office.com/webhookb2/' + 'A'.repeat(20));
  extra('credential.azure-sas', 'AAAAAAAA', '?sig=', '&done=1');
  extra('credential.azure-sas', 'abc123', '?sig=', '&done=1');
  extra('credential.signed-query', 'A', '?refresh_token=', '&done=1');
  extra('credential.redis-auth', 'x', 'redis://:', '@example.test');
  extra('credential.redis-auth', 'synthetic-truncated', 'redis://:');
  extra('credential.sql-password', 'x', 'Pwd=', ';');
  extra('credential.xml-secret', 'x', '<password>', '</password>');
  extra('credential.xml-secret', 'synthetic-truncated', '<password>');
  extra('credential.docker-auth', 'QUFBQUFB', '{"auth":"', '"}');
  extra('credential.ssh-password', 'x', 'sshpass -p ', ' command');
  extra('credential.ssh-password', 'has spaces', "sshpass -p '", "' command");
  extra('credential.ssh-password', 'synthetic truncated', 'sshpass -p "');
  extra('credential.otp', '1234', 'OTP: ');
  extra('credential.recovery-code', 'ABCDEF', 'backup code: ');
  extra('credential.wallet-private', 'A'.repeat(64), 'private key: ');
  extra('credential.integration-secret', 'https://example.test/hooks/' + 'a'.repeat(64));
  extra('credential.integration-secret', 'https://open.feishu.cn/open-apis/bot/v2/hook/' + 'a'.repeat(36));
  extra('credential.integration-secret', 'SYNTHETIC;TAIL!#@42/+', 'QiniuSK: "', '"');
  extra('credential.integration-secret', 'SYNTHETIC VALUE', "QiniuAK: '", "'");
  extra('credential.integration-secret', '/hooks/' + 'a1'.repeat(32), 'Webhook secret在路径里： ');
  extra('personal.cn-landline', '010-' + '5'.repeat(30), '电话：');
  extra('personal.cn-landline', '021-55550129', '母亲 ');
  extra('personal.cn-landline', '021-5555-0128 转18', '备用');
  extra('personal.international-phone', '+1 ' + '5'.repeat(40), 'phone: ');
  extra('personal.international-phone', '139 0000 0088', '手机号：');
  extra('personal.international-phone', '139-0000-0088', '手机号是');
  extra('personal.international-phone', '86 139-0000-0088', '联系电话为');
  extra('personal.passport-labelled', 'ABCDEF', '护照号码：');
  extra('personal.social-security', '9999999999', 'SSN: ');
  extra('personal.driver-license', 'ABCDE', '驾驶证号码：');
  extra('personal.tax-id', 'ABCDEFGH', '纳税人识别号：');
  extra('personal.bank-account', 'ABCDE', '银行账号：');
  extra('personal.payment-security', '0'.repeat(9), 'CVV: ');
  extra('personal.birth-date', '2000年1月1日', '生日：');
  extra('personal.birth-date', '1999-12-31', '出生日期我简历写了 ', '，其实证件仅用于合成测试');
  extra('personal.profile-url', 'linkedin.com/in/synthetic-recruiting-person', '领英 ');
  extra('personal.contact-name', 'A'.repeat(81), '姓名：');
  extra('personal.contact-name', '合成甲', '姓名是');
  extra('personal.contact-name', "O'Brien", '联系人为');
  extra('personal.address', '四字地址', '家庭住址：');
  extra('personal.health-record', 'ABC', '就诊号：');
  extra('personal.diagnosis', '合成', '疾病诊断：');
  extra('technical.ipv4', '10.0.0.1');
  extra('technical.mac', '02:00:00:00:00:01');
  extra('technical.windows-user-path', 'synthetic' + 'A'.repeat(129), 'C:\\Users\\', '\\file.txt');
  extra('technical.posix-user-path', 'synthetic' + 'A'.repeat(129), '/home/', '/file.txt');
  extra('internal.classified-line', '甲', '内部项目：');
  return rows;
}

function createMixedCorpus() {
  const rows = [];
  const add = (id, tier, secret, before, after = '') => rows.push({ id, tier, secret, sample: before + secret + after });
  add('mixed.aws-id', 'basic', 'AKIA' + 'SYNTHETIC00000001', 'aws_access_key_id = ');
  add('mixed.aws-secret', 'basic', 'SYNTHETIC/AWS+SECRET/NOT+A/REAL+KEY=', 'aws_secret_access_key = ');
  add('mixed.qiniu-ak', 'basic', 'SYNTHETIC-QINIU-ACCESS-KEY-ONLY', 'QiniuAK: ');
  add('mixed.qiniu-sk', 'basic', 'SYNTHETIC-QINIU-SECRET-KEY-ONLY', 'QiniuSK: ');
  add('mixed.app-secret', 'basic', 'SYNTHETIC-APPLICATION-SECRET-ONLY', 'app_secret=');
  add('mixed.smtp-password', 'basic', 'SyntheticMail!#@42/+', 'SMTP_PASSWORD=');
  add('mixed.database-password', 'basic', 'SyntheticDb!#@83/+', 'user=readonly,password=');
  add('mixed.authorization', 'basic', 'eyJSYNTHETIC.e30.syntheticSignature', 'Authorization: Bearer ', '\nX-Public: keep-visible');
  add('mixed.mobile-old', 'personal', '139-0000-0088', '原号码是 ', '，已经停用');
  add('mixed.mobile-new', 'personal', '139 0000 0099', '新号是 ', '，请更新');
  add('mixed.identity-grouped', 'personal', '999999 2000 0101 123X', '身份证号麻烦系统里核一下：');
  add('mixed.card-grouped', 'personal', '6200 0000 0000 0000 001', '银行卡是 ', '，仅合成测试');
  add('mixed.cvv2', 'basic', '591', 'CVV2 在背面 ', '，公开备注保留');
  add('mixed.expiry', 'personal', '12/29', '有效期 ', '；公开备注保留');
  add('mixed.social-card', 'personal', '990001234567890123', '社保卡号 ', '，医保卡后台绑的是这个');
  add('mixed.home-address', 'personal', '合成市示例区测试路99号', '家庭住址：', '，快递放前台');
  add('mixed.license-plate', 'personal', '京Z·T1234', '车牌 ', '，这是合成车牌');
  add('mixed.vin', 'personal', 'TESTVIN00000000001', '车架号 ', '；仅合成');
  add('mixed.social-credit', 'personal', '99SYNTHETIC00000001', '统一社会信用代码 ', '；公开备注保留');
  add('mixed.bank-branch', 'personal', '合成测试银行示例支行', '开户行 ', '，账号另列');
  add('mixed.invoice-account', 'personal', '9900 0000 1234 5678 001', '账号 ', '；用于合成开票资料');
  add('mixed.return-permit', 'personal', 'H90000001', '回乡证 ', '；公开备注保留');
  add('mixed.taiwan-permit', 'personal', '9900000001', '台胞证 ', '；公开备注保留');
  add('mixed.passport', 'personal', 'E90000001', '护照 ', '；公开备注保留');
  add('mixed.international-pair', 'personal', '+1(202)555-0129 和 +44 20 7946 0129', '境外来电 ', '，请回拨');
  add('mixed.landline-extension', 'personal', '010-5555-0129 转分机806', '回拨座机', '，公开备注保留');
  add('mixed.mother-landline', 'personal', '021-55550129', '母亲 ');
  add('mixed.backup-landline', 'personal', '021-5555-0128 转18', '备用');
  add('mixed.birth-date', 'personal', '1999年12月31日', '出生日期我简历写了 ', '，其实证件仅用于合成招聘资料');
  add('mixed.emergency-contact', 'personal', '父亲 合成示例甲 手机139 0000 0077', '紧急联系人：', '；母亲联系方式另列');
  add('mixed.current-address', 'personal', '合成市示例区当前路77号', '现住址：', '；公开备注保留');
  add('mixed.registered-address', 'personal', '合成省示例县户籍路66号', '户籍地：', '；公开备注保留');
  add('mixed.employee-id', 'personal', 'EMP-99881', '工号 ', '；公开备注保留');
  add('mixed.access-card', 'personal', 'A1B2C3D4E5F60998', '门禁卡号 ', '；公开备注保留');
  add('mixed.housing-fund', 'personal', '990012345678900001', '公积金账号 ', '；公开备注保留');
  add('mixed.medical-id', 'personal', '990012345678900001X', '医保个人编号 ', '；公开备注保留');
  add('mixed.client-ip', 'technical', '203.0.113.29', 'client_ip=');
  add('mixed.forwarded-ip', 'technical', '198.51.100.29', 'xff=');
  add('mixed.private-ip', 'technical', '172.20.0.29', '内部诊断地址 ');
  const queryToken = 'eyJxdWVyeS1zeW50aGV0aWM.e30.querySyntheticSignature';
  add('mixed.short-signature', 'basic', 'f9e8d7', 'https://callback.example.test/path?token=' + queryToken + '&sig=', '&public=1');
  add('mixed.query-token', 'basic', queryToken, 'https://callback.example.test/path?token=', '&sig=f9e8d7&public=1');
  add('mixed.webhook-path', 'basic', '/hooks/' + 'a1'.repeat(32), 'Webhook secret在路径里： ');
  add('mixed.linkedin', 'personal', 'linkedin.com/in/synthetic-recruiting-person', '领英 ');
  add('mixed.email-underscore', 'personal', 'recruit_ops_29@example.test', '联系邮箱：');
  add('mixed.email-plus', 'personal', 'recruit.ops+synthetic29@example.test', '备用邮箱：');
  // Keep the natural shared line while asserting each independently sensitive entity. Testing only
  // absence of the concatenated pair could wrongly pass when just one phone/name was concealed.
  const phones = rows.find(row => row.id === 'mixed.international-pair');
  phones.secrets = ['+1(202)555-0129', '+44 20 7946 0129']; phones.secret = phones.secrets[0];
  const emergency = rows.find(row => row.id === 'mixed.emergency-contact');
  emergency.secrets = ['合成示例甲', '139 0000 0077']; emergency.secret = emergency.secrets[0];
  const text = '以下均为本地合成数据，不是任何真实账户或个人。\n' + rows.map(row => 'CASE_' + row.id + '_BEGIN\n' + row.sample + '\nCASE_' + row.id + '_END').join('\n') + '\n普通计数 count=200、port=8192、request_id=99887766 和公开说明应保留。';
  const statement = id => {
    const row = rows.find(item => item.id === 'mixed.' + id);
    const end = Math.max(...(row.secrets || [row.secret]).map(secret => row.sample.indexOf(secret) + secret.length));
    return row.sample.slice(0, end).trim();
  };
  const line = (...ids) => ids.map(statement).join('，');
  const prose = [
    '以下是运维、客服和招聘混合记录，所有账户与个人信息均为本地合成值。公开操作说明应保留。',
    '运维排障：', statement('authorization'), statement('aws-id'), statement('aws-secret'),
    line('qiniu-ak', 'qiniu-sk'), statement('app-secret'), statement('smtp-password'), statement('database-password'),
    line('client-ip', 'forwarded-ip', 'private-ip'), statement('short-signature'), statement('webhook-path'),
    '客服回访：', line('mobile-old', 'mobile-new'), statement('identity-grouped'),
    line('card-grouped', 'cvv2', 'expiry'), statement('social-card'),
    rows.find(row => row.id === 'mixed.home-address').sample,
    line('license-plate', 'vin'), line('social-credit', 'bank-branch', 'invoice-account'),
    line('return-permit', 'taiwan-permit', 'passport'), line('international-pair', 'landline-extension'),
    '招聘资料：', statement('birth-date'), statement('emergency-contact') + '；' + statement('mother-landline'), statement('backup-landline'),
    statement('current-address') + '；' + statement('registered-address'),
    line('employee-id', 'access-card'), line('housing-fund', 'medical-id'),
    statement('linkedin'), line('email-underscore', 'email-plus'),
    '普通计数 count=200、port=8192、request_id=99887766 和公开说明应保留。',
  ].join('\n');
  return { rows, text, cases: rows, sample: text, prose };
}

module.exports = { createCorpus, createValidationCorpus, createMixedCorpus };
if (require.main === module) {
  if (!process.argv.includes('--check')) { console.error('Usage: node dev-harness/privacy-31/synthetic-catalog-corpus.js --check'); process.exitCode = 2; }
  else { try { checkCorpus(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}
