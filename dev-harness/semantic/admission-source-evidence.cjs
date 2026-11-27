'use strict';
// Development replay. The guard sees only the query and original source clauses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {memoryCorpus} = require('./admission-dev-corpus.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const devHash = '63a03095d788dbf4cb0275037145cb6584cb971501f42ccd9999456d55e89dc3';
const matrixHash = '002b825765a69708234ec680d02d1c8619cfab386feb2c864de68843dbae740b';
const modes = ['reference', 'identifier', 'typed-number', 'typed-attribute'];
const normalize = text => text.normalize('NFKC').toLowerCase();
function codes(text) {
  return (text.match(/[a-z0-9]+(?:[-_][a-z0-9]+)+/g) || []).filter(token => /[a-z]/.test(token) && /\d/.test(token));
}
const value = '(?:\\d+(?:[.,]\\d+)?|[零〇一二两三四五六七八九十百千万]+|\\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|hundred)\\b)';
const numberTypes = [
  [/小时|hours?\b/, /小时|hours?\b/], [/分钟|minutes?\b/, /分钟|minutes?\b/],
  [/毫秒|milliseconds?\b/, /毫秒|milliseconds?\b/], [/秒钟|几秒|多少秒|\bseconds?\b/, /秒钟?|\bseconds?\b/],
  [/几天|多少天|\bdays?\b/, /天|日|days?\b/], [/多少行|几行|\brows?\b|\blines?\b/, /行|rows?\b|lines?\b/],
  [/多少钱|价格|费用|how much.*cost|\bprice\b/, /元|美元|英镑|欧元|dollars?|euros?|pounds?/],
  [/字数|字符|长度|\blength\b|\bcharacters?\b/, /字节|字符|个字|bytes?|characters?|cm\b|mm\b|厘米|毫米/],
];
const count = new RegExp(value + '\\s*(?:个|位|张|份|件|人|名|台|条|把|本|组|次|项|种|套|只|[a-z]+\\b)', 'i');
const attrs = [
  [/品牌|牌子|\bbrand\b/, /(?:品牌|牌子|\bbrand)\s*(?:名|为|是|叫|is|name|[:=])?\s*[^\s:：=。，,;；]{2,}/],
  [/厂家|制造商|生产商|\bmanufactur(?:er|ed)\b/, /(?:制造商|生产商|厂家)\s*(?:是|为|[:=])\s*\S+|由.{2,24}(?:制造|生产)|(?:made|manufactured|produced) by\s+[\w\p{L}]+|manufacturer\s*[:=]\s*\S+/u],
  [/作者|编写者|\bauthor\b|\bwho (?:wrote|drew|composed)/, /(?:作者|编写者)\s*(?:是|为|[:=])\s*\S+|(?:written|drawn|composed) by\s+\w+|author\s*[:=]\s*\S+/],
  [/叫什么名字|姓名|\bwhat is the name\b/, /(?:姓名|名字)\s*(?:叫|是|为|[:=])\s*\S+|名叫\S+|\b(?:named|called)\s+\w+|\bname\s*[:=]\s*\S+/],
];
function requirements(query) {
  const q = normalize(query);
  const wantsNumber = /多少|几[个位张名人天小分秒行]|(?:最多|最少).*(?:几|多少)|\bhow (?:many|much|long)\b|\b(?:maximum|minimum) (?:length|number|size)\b/.test(q);
  const unit = wantsNumber && numberTypes.find(([ask]) => ask.test(q));
  const number = !wantsNumber ? null : unit ? new RegExp(value + '\\s*(?:' + unit[1].source.replace(/\\b/g, '') + ')(?![a-z])', 'i') : count;
  return {ids:codes(q), number, attrs:attrs.filter(([ask]) => ask.test(q)).map(([, evidence]) => evidence)};
}
function supported(need, clause, level) {
  if (level === 0) return true;
  const text = normalize(clause);
  const present = need.ids.length ? codes(text) : [];
  return need.ids.every(id => present.includes(id)) && (level < 2 || !need.number || need.number.test(text))
    && (level < 3 || need.attrs.every(pattern => pattern.test(text)));
}
function windows(doc) {
  const clauses = [...doc.text.matchAll(/[^。！？!?;；\n.]+(?:\.(?=\d)[^。！？!?;；\n.]*)*/gu)].map(m => ({start:m.index,end:m.index+m[0].length,text:m[0]}));
  const result = [];
  for (let start = 0; start < doc.text.length; start += 80) {
    const end = start + 96;
    result.push({id:doc.id, clauses:clauses.filter(c => c.start < end && c.end > start).map(c => c.text)});
    if (end >= doc.text.length) break;
  }
  return result;
}
function stats() { return {positive:0, negative:0, hits1:0, hits5:0, falsePositives:0, reciprocalRanks:0}; }
function update(s, q, top) {
  if (q.kind !== 'positive') { s.negative++; if (top.length) s.falsePositives++; return; }
  s.positive++;
  const rank = top.findIndex(id => q.relevant.includes(id)) + 1;
  if (rank) { s.hits5++; s.reciprocalRanks += 1 / rank; }
  if (rank === 1) s.hits1++;
}
function evaluate(pool, corpus) {
  const ids = new Set(pool.windows);
  const rows = corpus.documents.filter(doc => ids.has(doc.id)).flatMap(windows);
  assert.deepEqual(rows.map(w => w.id), pool.windows);
  const queries = corpus.queries.filter(q => q.kind !== 'positive' || q.relevant.some(id => ids.has(id)));
  assert.equal(queries.length, pool.queries.length);
  return Object.fromEntries(modes.map((name, level) => {
    const all = stats(), groups = {};
    queries.forEach((q, i) => {
      const recorded = pool.queries[i];
      assert.deepEqual([q.group,q.kind,q.relevant], [recorded.group,recorded.kind,recorded.relevant]);
      const need = requirements(q.text), best = new Map();
      const reference = recorded.referenceScores.reduce((a,b) => a+b,0)/recorded.referenceScores.length;
      rows.forEach((row, n) => {
        const score = recorded.scores[n];
        if (score < .70 || score-reference < .070 || !row.clauses.some(clause => supported(need, clause, level))) return;
        best.set(row.id, Math.max(score, best.get(row.id) ?? -Infinity));
      });
      const top = [...ids].filter(id => best.has(id)).sort((a,b) => best.get(b)-best.get(a)).slice(0,5);
      update(all, q, top);
      update(groups[q.group+'/'+q.kind] ||= stats(), q, top);
    });
    return [name, {all,groups}];
  }));
}
function run(fixture, output) {
  const bytes = fs.readFileSync(fixture);
  assert.equal(sha(bytes), devHash, 'only the consumed V7 R3 development fixture is accepted');
  const v7 = require(path.resolve(fixture));
  const file = path.resolve(__dirname, '../../docs/optimization-plan/evidence/semantic-retrieval-20261116/152-admission-dev/scores.json.gz');
  const compressed = fs.readFileSync(file);
  assert.equal(sha(compressed), matrixHash);
  const matrix = JSON.parse(zlib.gunzipSync(compressed));
  const memory = memoryCorpus();
  assert.equal(sha(JSON.stringify(memory)), matrix.developmentCorpusSha256);
  const pools = Object.fromEntries(matrix.pools.map(pool => [pool.name,evaluate(pool,pool.name==='v7-r3'?v7:memory)]));
  const report = {kind:'152-development-source-evidence',fixtureSha256:devHash,matrixSha256:matrixHash,model:matrix.fingerprint,pools};
  fs.writeFileSync(output, JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
function contrasts(file, output) {
  const bytes = fs.readFileSync(file);
  const pairs = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const rows = pairs.map(({category,query,positive,negative}) => {
    const need = requirements(query);
    const passes = text => windows({id:'probe',text}).some(w => w.clauses.some(clause => supported(need, clause, 3)));
    return {category,positiveKept:passes(positive),negativeBlocked:!passes(negative)};
  });
  const result = {kind:'source-guard-only',pairsSha256:sha(bytes),rows,positiveKept:rows.filter(r=>r.positiveKept).length,
    negativeBlocked:rows.filter(r=>r.negativeBlocked).length,bothCorrect:rows.filter(r=>r.positiveKept && r.negativeBlocked).length};
  fs.writeFileSync(output, JSON.stringify(result,null,2)+'\n', {flag:'wx'});
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--contrasts') contrasts(...args.slice(1));
  else run(...args);
}
module.exports = {requirements,supported,windows};
