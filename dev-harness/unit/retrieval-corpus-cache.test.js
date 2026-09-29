'use strict';
// 性能批 C1:06h createRetrievalCorpusCache 与 buildRetrievalCorpus 逐位相同。
//   [R1] 随机文档集合 + 随机增 / 删 / 改 / 换序 / 同文不同实例,每一步 corpusFor(docs) 与 buildRetrievalCorpus(docs)
//        的 ids、docCount、df、每篇向量逐位相等,rankRetrievalCorpus 的结果也相等
//   [R2] 文档集合没变 → 直接复用同一份语料(不重算);改一篇 → 只重新分词那一篇
//   [R3] 同一份缓存上并发两次异步装配(.build),其中一次触发词表整份重置:两份结果都与现算逐位相同
//        (审查轮复现过:修前挂起中的那一次拿旧词号配新哈希表,向量是错的)
// 06h 是自足的纯函数模块(不引用别的模块),整份在 vm 里执行,拿到的就是产物里的同一份代码。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/06h-retrieval-index.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(source + '\n;globalThis.__api = { buildRetrievalCorpus, createRetrievalCorpusCache, rankRetrievalCorpus, retrievalTermCounts };', ctx);
const { buildRetrievalCorpus, createRetrievalCorpusCache, rankRetrievalCorpus } = ctx.__api;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WORDS = ['powershell', 'encoding', 'gbk', 'utf-8', 'build.js', 'server', '断点续传', '下载器', '上下文压缩', '如意工作台', 'range', 'retry', 'token_budget', 'a.b-c', '会话', '搜索', 'x', 'Ｆｕｌｌｗｉｄｔｈ', 'naïve'];
function text(r) { const n = 3 + Math.floor(r() * 60); const out = []; for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]); return out.join(r() < 0.5 ? ' ' : ','); }
const plain = corpus => ({ ids: [...corpus.ids], docCount: corpus.docCount, df: [...corpus.df.entries()], vectors: corpus.vectors.map(v => Object.entries(v)) });

test('[R1] 随机变更序列:缓存语料与现算语料逐位相同', () => {
  const r = rng(99);
  const cache = createRetrievalCorpusCache();
  let docs = Array.from({ length: 30 }, (_, i) => ({ id: 'd' + i, text: text(r) }));
  for (let step = 0; step < 80; step++) {
    const op = Math.floor(r() * 6);
    if (op === 0) docs.push({ id: 'n' + step, text: text(r) });
    else if (op === 1 && docs.length > 2) docs.splice(Math.floor(r() * docs.length), 1);
    else if (op === 2) docs[Math.floor(r() * docs.length)] = { ...docs[0], id: docs[Math.floor(r() * docs.length)].id, text: text(r) };
    else if (op === 3) docs = docs.slice().reverse();
    else if (op === 4) docs = docs.map(d => ({ id: d.id, text: (' ' + d.text).slice(1) }));   // 同文不同实例
    const got = cache(docs), want = buildRetrievalCorpus(docs);
    assert.deepEqual(plain(got), plain(want), `第 ${step} 步(op ${op})`);
    for (const q of ['powershell 编码', '断点续传', 'retry budget', 'powershel']) {
      assert.deepEqual(rankRetrievalCorpus(got, q), rankRetrievalCorpus(want, q), `第 ${step} 步查询 ${q}`);
    }
  }
});

test('[R2] 集合没变整份复用;改一篇只重新分词那一篇', () => {
  const r = rng(5);
  const docs = Array.from({ length: 20 }, (_, i) => ({ id: 'd' + i, text: text(r) }));
  const cache = createRetrievalCorpusCache();
  const first = cache(docs);
  assert.equal(cache(docs.map(d => ({ ...d }))), first, '同一批文档 → 同一份语料对象');
  let tokenized = 0;
  const origin = ctx.retrievalTermCounts;
  ctx.retrievalTermCounts = input => { tokenized += 1; return origin(input); };
  try {
    docs[3] = { id: 'd3', text: docs[3].text + ' 新增内容' };
    const next = cache(docs);
    assert.notEqual(next, first);
    assert.equal(tokenized, 1, '只重新分词改过的那一篇');
    assert.deepEqual(plain(next), plain(buildRetrievalCorpus(docs)));
  } finally { ctx.retrievalTermCounts = origin; }
});

test('[R3] 异步装配挂起时词表被整份重置:结果仍与现算逐位相同;并发两次异步装配也相同', async () => {
  const actx = vm.createContext({ setImmediate });
  vm.runInContext(source + '\n;globalThis.__api = { buildRetrievalCorpus, createRetrievalCorpusCache };', actx);
  const api = actx.__api;
  const r = rng(7);
  const vocabText = n => Array.from({ length: n }, () => 'w' + Math.floor(r() * 5000)).join(' ');
  const docsA = Array.from({ length: 450 }, (_, i) => ({ id: 'a' + i, text: vocabText(6) }));   // 向量循环每 200 篇让一次
  const docsB = Array.from({ length: 40 }, (_, i) => ({ id: 'b' + i, text: vocabText(30) }));
  const refA = plain(api.buildRetrievalCorpus(docsA));
  const refB = plain(api.buildRetrievalCorpus(docsB));
  const cache = api.createRetrievalCorpusCache({ maxTerms: 60 });
  // ① 确定性构造:A 的异步装配停在向量循环的让出点上,此时同步装配一次 B(词表超上限 → 整份重置)
  const pa = cache.build(docsA);
  await new Promise(resolve => setImmediate(resolve));   // A 此刻挂在第 200 篇之后的让出点
  const syncB = cache(docsB);
  assert.deepEqual(plain(await pa), refA, 'A 与现算相同(修前:挂起的装配拿旧词号配新哈希表)');
  assert.deepEqual(plain(syncB), refB, 'B 与现算相同');
  // ② 并发两次异步装配
  const [a, b] = await Promise.all([cache.build(docsA), cache.build(docsB)]);
  assert.deepEqual(plain(a), refA);
  assert.deepEqual(plain(b), refB);
});
