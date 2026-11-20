'use strict';
// Every positive sample of the privacy-31 corpora plus the 4B review probes, with a stable key and the tier it is
// detected under. Used to freeze and compare rule-catalog coverage between versions (no v6 true positive may become
// a v7 miss). Synthetic data only.
const path = require('node:path');
const dir = path.join(__dirname, '..', 'privacy-31');
// Review 4B probes (probe1/probe3): shapes version 6 detected that a rewrite must keep.
const REVIEW_PROBES = ['价格 面议 13800138000', '单价请咨询13800138000', '售价 13800138000', '金额问题找财务 13800138000', '数量有限，速联13800138000',
  '金额：13800138000元', 'count: 13800138000', '13800138000人', '13800138000 名', '价格咨询：13800138000', '总共 13800138000', 'Total contact 13800138000',
  '联系电话(价格咨询) 13800138000', 'Phone count 13800138000', '收款账号：工商银行(北京)6222000011112222', '收款账号：中国工商银行（北京分行）6222 0000 1111 2222',
  '收款账号：中国工商银行北京分行 6222000011112222', '账号：张三的工资卡 6222000011112222', '账号：6222000011112222（工商银行）', '银行账号：工商银行 6222000011112222',
  '开户行：中国工商银行北京分行', '账号：ABCD1234 已冻结', '账号是 abc-12345，请查收', '账号：建行·6217000010001234567', '收款账号：工商银行，6222000011112222',
  '收款账户：招商银行 6214 8301 2345 6789', '开票账号：工商银行北京海淀支行 0200 0045 0920 0123 456', '账号：工商银行北京海淀支行营业部 0200004509200123456',
  '账号:农行6228480402564890018', '账号：工行 6222-0200-1122-3344-55', '电话 138 0013 8000', '手机：138 0013-8000', 'password=hunter2，请勿外传', 'password=hun，ter2',
  'api_key=sk-abc，def', '订单号 4111111111111111', '手机 138\u200b0013\u200b8000 后', 'token: None123',
  '账号：工商银行-6222000011112222', '账号：工商银行/6222000011112222', '账号：工商银行：6222000011112222'];
// The value each review probe must keep covered, by index ('' = the whole tail after the label is not one value).
const REVIEW_SECRETS = ['13800138000', '13800138000', '13800138000', '13800138000', '13800138000', '13800138000', '13800138000', '13800138000', '13800138000',
  '13800138000', '13800138000', '13800138000', '13800138000', '13800138000', '工商银行(北京)6222000011112222', '中国工商银行（北京分行）6222 0000 1111 2222',
  '中国工商银行北京分行 6222000011112222', '张三的工资卡 6222000011112222', '6222000011112222', '工商银行 6222000011112222', '中国工商银行北京分行', 'ABCD1234', 'abc-12345',
  '建行·6217000010001234567', '工商银行，6222000011112222', '招商银行 6214 8301 2345 6789', '工商银行北京海淀支行 0200 0045 0920 0123 456',
  '工商银行北京海淀支行营业部 0200004509200123456', '农行6228480402564890018', '工行 6222-0200-1122-3344-55', '138 0013 8000', '138 0013-8000', 'hunter2', 'hun，ter2',
  'sk-abc，def', '', '138\u200b0013\u200b8000', 'None123', '工商银行-6222000011112222', '工商银行/6222000011112222', '工商银行：6222000011112222'];
function samples() {
  const rows = [], add = (key, sample, tier, secret) => rows.push({ key, sample, tier, ...(secret ? { secret } : {}) });
  const { createCorpus, createValidationCorpus, createMixedCorpus } = require(path.join(dir, 'synthetic-catalog-corpus.js'));
  for (const row of createCorpus('adversarial-catalog-only')) add('catalog:' + row.id, row.sample, 'all', row.secret);
  createValidationCorpus().forEach(row => row.positive.forEach((item, i) => add('validation:' + row.id + ':' + i, item.sample, 'all', item.secret)));
  for (const row of createMixedCorpus().rows) add('mixed:' + row.id, row.sample, row.tier === 'basic' ? 'basic' : row.tier === 'technical' ? 'technical' : 'personal', row.secret);
  for (const row of require(path.join(dir, 'second-scenario-corpus.js')).createSecondCorpus().cases) add('second:' + row.id, row.sample, row.tier === 'basic' ? 'basic' : 'personal', row.secret);
  for (const row of require(path.join(dir, 'third-scenario-corpus.js')).createThirdCorpus().cases) add('third:' + row.id, row.sample, row.tier === 'basic' ? 'basic' : 'personal', row.secret);
  for (const row of require(path.join(dir, 'format-gap-corpus.js')).createFormatGapCorpus().cases) add('format-gap:' + row.id, row.sample, row.tier === 'basic' ? 'basic' : 'personal', row.secret);
  for (const row of require(path.join(dir, 'phase4-detection-corpus.js')).createPhase4Corpus().cases) add('phase4:' + row.id, row.sample, row.tier, row.secret);
  REVIEW_PROBES.forEach((sample, i) => add('review:' + i, sample, 'technical', REVIEW_SECRETS[i] || undefined));
  return rows;
}
module.exports = { samples, REVIEW_PROBES };
