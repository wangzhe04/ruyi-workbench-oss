'use strict';
// Independent synthetic equivalents; no user transcript or configured credential.
function createThirdCorpus() {
  const cases = [], add = (id, tier, sample, secret) => cases.push({ id, tier, sample, secret });
  // These vendor-shaped values are synthetic and constructed only inside the fixture.
  const slackToken = 'xo' + 'xb-234567890123-2345678901234-abcdefghijklmnopqrstuvwy';
  const stripeKey = 'sk_' + 'live_5eC39HqLyjWDarjtT1zdp7dc';
  add('receiving-card-bank-prefix', 'personal', '收款卡：示例银行 6222 0210 0100 6677 889，开户行在测试支行。', '6222 0210 0100 6677 889');
  add('insurance-policy-number', 'personal', '保单号 PA2026EX010209。', 'PA2026EX010209');
  add('owner-dialogue-name', 'personal', '车主-林示例：好。本人身份证已核对。', '林示例');
  add('beneficiary-name', 'personal', '受益人写我爱人：方示例，身份证已登记。', '方示例');
  add('medical-record-narrative', 'personal', '医院要病历号，您上次发的 MZ8842157 我们已登记。', 'MZ8842157');
  add('driver-file-number', 'personal', '另外您驾照档案编号 210200123457 也需要录系统。', '210200123457');
  add('address-short-label', 'personal', '地址也照旧：合成市测试区仙岳路4666号示例大厦2梯1401。', '合成市测试区仙岳路4666号示例大厦2梯1401');
  add('landline-parentheses', 'personal', '座机 (027) 8765 4322 转 806。', '(027) 8765 4322 转 806');
  add('otp-narrative', 'basic', '动态口令刚收到的是 048219。', '048219');
  add('wifi-password-history', 'basic', '家里WiFi密码我也顺便改下，以前是 Synthetic@n_2021home。', 'Synthetic@n_2021home');
  add('door-code', 'basic', '门禁密码 963259，U盾PIN 6位我不提供。', '963259');
  add('telegram-bot-token', 'basic', 'Telegram 通知机器人 token： 234567890:AAHsyntheticTelegramFixtureOnlyNotARealSecret', '234567890:AAHsyntheticTelegramFixtureOnlyNotARealSecret');
  add('aws-short-example-id', 'basic', 'AWS 临时凭证那套：ASIA3EXAMPLESESSION + FwoGZXIvYXdzEKGAAAA7SYNTHETIC TOKEN 一长串 base64', 'ASIA3EXAMPLESESSION');
  add('aws-session-token-context', 'basic', 'AWS 临时凭证那套：ASIA3EXAMPLESESSION + FwoGZXIvYXdzEKGAAAA7SYNTHETIC TOKEN 一长串 base64', 'FwoGZXIvYXdzEKGAAAA7SYNTHETIC');
  add('db-pass-yaml', 'basic', 'apiVersion: v1\nkind: Secret\nstringData:\n  DB_PASS: Synthetic#Db_FixtureOnly', 'Synthetic#Db_FixtureOnly');
  add('db-pass-json', 'basic', '{"DB_PASS":"Synthetic#Db_FixtureOnly"}', 'Synthetic#Db_FixtureOnly');
  const encodedPhone = Buffer.from('13600005555').toString('base64');
  const encodedEmail = Buffer.from('coded-privacy@example.test').toString('base64');
  add('base64-phone', 'personal', '有人把手机号 base64 后塞进备注：' + encodedPhone, encodedPhone);
  add('base64-email', 'personal', '邮箱也编码了：' + encodedEmail, encodedEmail);
  add('url-encoded-phone', 'personal', 'URL 编码的手机号：%2B86%2013500004444', '%2B86%2013500004444');
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.\neyJzdWIiOiIxMzYwMDAwNTU1NSJ9.\nSyntheticSignature_NotARealToken_12345678';
  add('jwt-three-lines', 'basic', 'JWT 三段被人为拆到三行发：\n' + jwt, jwt);
  add('military-phone', 'personal', '军式读法报号的：幺八六 零零贰贰 壹壹叁肆。', '幺八六 零零贰贰 壹壹叁肆');
  add('otp-short', 'basic', '验证码 7749 是边界。', '7749');
  add('github-fine-grained', 'basic', 'GitHub：github_pat_11SYNTHETIC0123456789abcdefghijklmnopqrstuvwxyz', 'github_pat_11SYNTHETIC0123456789abcdefghijklmnopqrstuvwxyz');
  add('slack-bot', 'basic', 'Slack机器人：' + slackToken, slackToken);
  add('stripe-key', 'basic', stripeKey + ' 文档示例，勿外用', stripeKey);
  add('nacos-password', 'basic', 'nacos.password=SyntheticNacos#2027!', 'SyntheticNacos#2027!');
  add('feishu-webhook', 'basic', 'https://open.feishu.cn/open-apis/bot/v2/hook/4a1b9c2d4e5f60718293a4b5c6d7e8f91', 'https://open.feishu.cn/open-apis/bot/v2/hook/4a1b9c2d4e5f60718293a4b5c6d7e8f91');
  const negatives = ['订单号 202610202000111333', '受益人关系：爱人', '家长与孩子的称呼：辰辰妈妈', '卡尾号 8899', '手机尾号 4455',
    '李*四', '手机 138****0022', '身份证 4201**********321X', '邮箱 zhang***@126.com', 'U盾PIN 6位我不提供', '密码我不在电话里说',
    'uuid 550e8400-e29b-41d4-a716-446655440000', 'md5 d41d8cd98f00b204e9800998ecf8427e', 'sha1 da39a3ee5e6b4b0d3255bfef95601890afd80709',
    '时间戳 1761024000', 'ISO时间 2026-10-20T15:55:00+08:00', '股票600519涨了2.3%', '气温36.5°C', 'SKU：SPU-8899-A', '商品编号6942026888888',
    '容器id 7f3a9c2e1b', '构建号#88421', 'base64公开文档：cHVibGljIGRvY3VtZW50YXRpb24=', 'URL编码公开路径：%2Fdocs%2Findex.html', '服务地址也照旧：https://api.example.test/v1'];
  return { cases, negatives, technical: ['172.20.3.15'] };
}
module.exports = { createThirdCorpus };
