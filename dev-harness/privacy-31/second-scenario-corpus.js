'use strict';
// Synthetic equivalents of the second six-scenario report. Original user data is never used by live probes.
function createSecondCorpus() {
  const cases = [], add = (id, tier, sample, secret) => cases.push({ id, tier, sample, secret });
  // Assemble synthetic vendor-shaped fixtures at runtime; never publish a usable credential.
  const cosId = 'AK' + 'IDz8krbsJ5yKBZQpn74WFkmLPx4EXAMPLE';
  const gitlabToken = 'gl' + 'pat-BbCdEf1234567890GhIj';
  add('phone-grouped', 'personal', '手机号是 186 1122 4455', '186 1122 4455');
  add('email-alias', 'personal', '备用邮箱 clinic.test+follow@example.test', 'clinic.test+follow@example.test');
  add('identity-grouped', 'personal', '身份证：420106 1992 03 15 4327', '420106 1992 03 15 4327');
  add('card-unpunctuated', 'personal', '退款卡是示例银行，卡号 6228 4801 0000 2233 556，背面三位 808，有效期 10/29。', '6228 4801 0000 2233 556');
  add('cvv-context', 'basic', '退款卡是示例银行，卡号 6228 4801 0000 2233 556，背面三位 808，有效期 10/29。', '808');
  add('expiry', 'personal', '有效期 10/29', '10/29');
  add('emergency-phone', 'personal', '紧急联系人 139 2233 5566，需要同步更新吗？', '139 2233 5566');
  add('address-qualifier', 'personal', '收货地址也照旧：合成市测试区光明大道77号示例小区6栋1702，放驿站。', '合成市测试区光明大道77号示例小区6栋1702');
  add('medical-personal-number', 'personal', '医保电子凭证我已激活，个人编号 33010312345678902。', '33010312345678902');
  add('medical-record', 'personal', '病历号 MZ-2026-048216。', 'MZ-2026-048216');
  add('medical-report', 'personal', '检查报告单号 JC88421094，说是 3 个工作日出结果。', 'JC88421094');
  add('allergy', 'personal', '过敏史那栏填的"合成药物甲"，确认无误我就提交。', '合成药物甲');
  add('contact-name', 'personal', '紧急联系人写我妈：林示例 137 8899 1122。', '林示例');
  add('contact-name-phone', 'personal', '紧急联系人写我妈：林示例 137 8899 1122。', '137 8899 1122');
  add('property-address', 'personal', '房子在合成市测试区江南大道618号示例大厦1809，门禁密码我私发你。', '合成市测试区江南大道618号示例大厦1809');
  add('plate', 'personal', '车牌 鄂A·77D99 要录进系统', '鄂A·77D99');
  add('vin', 'personal', '车架号 LGBH52E05NY234567 也一起给我', 'LGBH52E05NY234567');
  add('api-v3-key', 'basic', 'apiv3_key = 8f6e4d2c1a9b7e5f3d1c8a6e4b2f09d8', '8f6e4d2c1a9b7e5f3d1c8a6e4b2f09d8');
  add('api-key-prose', 'basic', '旧版 API key（md5 风格）也还在：3f2e1d0c9b8a7f6e5d4c3b2a1908f7e7', '3f2e1d0c9b8a7f6e5d4c3b2a1908f7e7');
  add('cos-secret-id', 'basic', '腾讯云 COS 用这对：SecretId ' + cosId, cosId);
  add('cos-secret-key', 'basic', 'SecretKey = Gu5t9xGARNpq86cd98joQYCN4EXAMPLE', 'Gu5t9xGARNpq86cd98joQYCN4EXAMPLE');
  add('ali-access-id', 'basic', '阿里云短信：AccessKeyId LTAI5tB4ExampleKeyId02', 'LTAI5tB4ExampleKeyId02');
  add('ali-access-secret', 'basic', 'AccessKeySecret = V7xK2mP9qR4wN8sD3fH6jL1zY5tB0cB', 'V7xK2mP9qR4wN8sD3fH6jL1zY5tB0cB');
  add('jdbc-password', 'basic', 'jdbc:mysql://root:Synthetic#2026pass@10.0.0.8:3306/orderdb?useSSL=false', 'Synthetic#2026pass');
  add('redis-password', 'basic', 'redis://:synthetic!s#7799@10.0.0.9:6379/2', 'synthetic!s#7799');
  add('gitlab-token', 'basic', gitlabToken, gitlabToken);
  add('wecom-webhook', 'basic', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=793a91f6-7bc-4bc-9974-a5f9b6e8d2c2', '793a91f6-7bc-4bc-9974-a5f9b6e8d2c2');
  add('signature-path', 'basic', '/pay/notify/sig/b94a8fe5ccb19ba61c4c0873d391e987982fbbd4', 'b94a8fe5ccb19ba61c4c0873d391e987982fbbd4');
  add('jwt', 'basic', 'Bearer ' + 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoyfQ.synthetic-signature-only', 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoyfQ.synthetic-signature-only');
  add('ssh-pem', 'basic', '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-fixture-only\n-----END OPENSSH PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-fixture-only\n-----END OPENSSH PRIVATE KEY-----');
  add('fullwidth-phone-valid', 'personal', '手机号：１５８０１２３４５６７', '１５８０１２３４５６７');
  // Keep the positive independent of the 12-digit negative below. Otherwise a
  // substring leak assertion would flag the correctly preserved negative itself.
  add('chinese-phone-valid', 'personal', '手机号：一五九 零一二三四五六七', '一五九 零一二三四五六七');
  add('email-bracket-at', 'personal', '邮箱防爬虫：support [at] example.test', 'support [at] example.test');
  add('email-at-dot', 'personal', '邮箱：test.user at example dot test', 'test.user at example dot test');
  add('phone-line-split', 'personal', '手机号故意断开两行的：158 0123 /\n4567。', '158 0123 /\n4567');
  add('identity-line-split', 'personal', '身份证分三段发的：420106 /\n19920315 / 4327。', '420106 /\n19920315 / 4327');
  const negatives = ['订单 20261020153012345678', '金额 ¥1,299.00', '版本 v2.3.1-beta.4', '快递单 SF3101234567890', 'YT2233445566778', '商品条码 6901234567892',
    'ISBN 9787020002207', '商户号 1230000109', 'QQ 号 765432100', '到店坐标 30.592849,114.305539', '机票票号 999-1234567890', '电子发票代码 044320000111',
    '发票号码 24681357', '学号 202301030215', '房间号 1702', '3 个工作日', '门禁密码我私发你，别写合同里', '微信同号', '用户名 root，库名 orderdb，参数 useSSL=false',
    '裸哈希 3f2e1d0c9b8a7f6e5d4c3b2a1908f7e8', '１２３４５６７８９０１２', '158012345678', '一五八 零一二三四五六七八',
    '业务编号 158 0123 4567 8', '房子在大家共同讨论中，还没有签约', '在源代码里 search at example dot test 是一条普通语句', '/pay/notify/sig/public-documentation',
    '订单号13900000088', 'order_id=13900000088', '青霉素是常见药物过敏原，这只是通用用药知识'];
  const technical = ['10.8.0.12', '192.168.1.100', '3C:5A:B4:12:9E:F7'];
  return { cases, negatives, technical };
}
module.exports = { createSecondCorpus };
