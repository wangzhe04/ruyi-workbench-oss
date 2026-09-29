// ============================================================================
// 113a: 离线检索原语(特征哈希向量 + TF-IDF + 余弦 + RRF 融合)。零依赖、零网络、零模型。
//
// 为什么不是 embedding:如意的红线是「断网、无 provider 时结果不比今天差」。本层是永远可用的那一层
// —— 纯 Node 内建实现,把「中文 2-gram + ASCII 词 + ASCII 3-gram」哈希进 512 维带符号桶,TF-IDF 加权、
// L2 归一化,余弦比相似度。它补的是词法层最明显的两个洞:同义改写(词不同但共现的 gram 重合)与
// 拼写/分词差(3-gram 容忍一两个字符的偏移)。
//
// 为什么不是 ANN:语料是百到千级,暴力余弦是微秒级;引 HNSW 只会多一个索引要维护。
//
// 向量一律【稀疏】表示({桶下标: 权重} 的普通对象):一篇记忆约 50 个词,512 维里最多 50 个非零桶,
// 稀疏表示既省内存也让余弦退化成两个小对象的交集遍历。
// ============================================================================

const RETRIEVAL_DIMS = 512;
const RETRIEVAL_RRF_K = 60;
// 单条文本进索引前的硬上限。会话正文可以很长,而检索只需要「这条讲的是什么」——
// 截断在这里做,调用方不必各自记得。
const RETRIEVAL_TEXT_CAP = 8192;

// FNV-1a 32 位。选它不是为了密码学强度(这里不需要),而是为了「同一段文本在任何机器上、
// 任何 Node 版本上都落进同一个桶」——索引可以跨进程复用的前提。
function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (input.charCodeAt(i) >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// 分词:与 06d 的 memorySearchTerms 同一套 NFKC+小写口径,但多产 ASCII 3-gram。
// 3-gram 是这一层相对词法层的主要增量 —— 「powershel」与「powershell」共享 8 个 3-gram,
// 词法层的 includes 判定则直接落空。
function retrievalTerms(input) {
  const source = String(input || '').slice(0, RETRIEVAL_TEXT_CAP).normalize('NFKC').toLowerCase();
  const terms = [];
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_.-]{1,63}/g)) {
    const word = match[0].replace(/^[_.-]+|[_.-]+$/g, '');
    if (word.length < 2) continue;
    terms.push(word);
    // 拆分只在真的含分隔符时补：否则 split 会把整词再吐一遍，把每个普通词的 tf 白白抬成 2。
    for (const part of word.split(/[_.-]+/)) if (part.length >= 2 && part !== word) terms.push(part);
    if (word.length >= 4) {
      for (let i = 0; i + 3 <= word.length; i++) terms.push('#' + word.slice(i, i + 3));
    }
  }
  for (const match of source.matchAll(/[㐀-鿿]{2,64}/g)) {
    const run = match[0];
    for (let i = 0; i + 2 <= run.length; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

function retrievalTermCounts(input) {
  const counts = new Map();
  for (const term of retrievalTerms(input)) counts.set(term, (counts.get(term) || 0) + 1);
  return counts;
}

// 语料的文档频次。IDF 用平滑对数式,单文档语料也不会除零。
function buildRetrievalDf(termCountsList) {
  const df = new Map();
  for (const counts of termCountsList) {
    for (const term of counts.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  return { df, docCount: termCountsList.length };
}

function retrievalIdf(df, docCount, term) {
  const seen = df.get(term) || 0;
  return Math.log(1 + (Math.max(1, docCount) + 1) / (seen + 1));
}

// 带符号特征哈希:桶下标取低位,符号取另一位。符号位是特征哈希的标准做法 ——
// 没有它,不同词撞进同一桶时权重只会同向累加,相似度被系统性抬高。
function retrievalVector(termCounts, df, docCount) {
  const raw = new Map();
  for (const [term, count] of termCounts) {
    const hash = fnv1a32(term);
    const dim = hash % RETRIEVAL_DIMS;
    const sign = (hash >>> 16) & 1 ? -1 : 1;
    const weight = (1 + Math.log(count)) * retrievalIdf(df, docCount, term);
    raw.set(dim, (raw.get(dim) || 0) + sign * weight);
  }
  let norm = 0;
  for (const value of raw.values()) norm += value * value;
  norm = Math.sqrt(norm);
  const vector = {};
  if (!(norm > 0)) return vector;
  for (const [dim, value] of raw) {
    const scaled = value / norm;
    if (scaled !== 0) vector[dim] = scaled;
  }
  return vector;
}

// 两个已 L2 归一化的稀疏向量的余弦 = 点积。遍历较短的一侧。
function retrievalCosine(a, b) {
  if (!a || !b) return 0;
  let left = a, right = b;
  const leftKeys = Object.keys(left);
  if (leftKeys.length > Object.keys(right).length) { const swap = left; left = right; right = swap; }
  let dot = 0;
  for (const dim of Object.keys(left)) {
    const other = right[dim];
    if (other !== undefined) dot += left[dim] * other;
  }
  return dot;
}

// Reciprocal Rank Fusion:每个排名表贡献 1/(k+名次)。选它而不是分数加权,是因为词法分数
// (命中长度 ×10)与余弦(0..1)不同量纲,归一化怎么调都是拍脑袋;RRF 只看名次,天然免标定。
// rankings = [[id, id, ...], [id, ...]],可带每表权重。
function reciprocalRankFusion(rankings, { k = RETRIEVAL_RRF_K, weights = null } = {}) {
  const scores = new Map();
  rankings.forEach((ranking, index) => {
    const weight = weights && Number.isFinite(weights[index]) ? weights[index] : 1;
    (Array.isArray(ranking) ? ranking : []).forEach((id, rank) => {
      const key = String(id);
      scores.set(key, (scores.get(key) || 0) + weight / (k + rank + 1));
    });
  });
  return scores;
}

// 内容指纹:索引条目的失效键之一(另一个是 mtime+size)。截断成 16 位十六进制够用,
// 这里比对的是「同一条记忆有没有被改过」,不是防篡改。
function retrievalContentHash(input) {
  const source = String(input || '');
  const a = fnv1a32(source);
  const b = fnv1a32(source.length + '|' + source.slice(-256));
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'));
}

// 一次性把一批文档变成 {ids, vectors, df, docCount}。语料小(百到千级),每次重算是微秒级,
// 所以这里不做磁盘索引 —— 会话搜索那边正文提取才是真花钱的地方,索引落盘在那边做。
function buildRetrievalCorpus(documents) {
  const ids = [];
  const countsList = [];
  for (const doc of documents || []) {
    if (!doc || !doc.id) continue;
    ids.push(String(doc.id));
    countsList.push(retrievalTermCounts(doc.text));
  }
  const { df, docCount } = buildRetrievalDf(countsList);
  const vectors = countsList.map(counts => retrievalVector(counts, df, docCount));
  return { ids, vectors, df, docCount };
}

// 用 query 在语料上打分,返回按余弦降序的 [{id, score}]。低于 minScore 的直接丢
// (稀疏哈希在完全不相干的文本之间也会有零点几的噪声分)。
function rankRetrievalCorpus(corpus, query, { minScore = 0.05, limit = 0 } = {}) {
  if (!corpus || !corpus.ids.length) return [];
  const queryVector = retrievalVector(retrievalTermCounts(query), corpus.df, corpus.docCount);
  if (!Object.keys(queryVector).length) return [];
  const scored = [];
  for (let i = 0; i < corpus.ids.length; i++) {
    const score = retrievalCosine(queryVector, corpus.vectors[i]);
    if (score >= minScore) scored.push({ id: corpus.ids[i], score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return limit > 0 ? scored.slice(0, limit) : scored;
}

// ── 性能批 C1:可复用的语料缓存 ────────────────────────────────────────────────────────────────────────
// buildRetrievalCorpus 每次都把每篇文档重新分词、重算 df 与向量。会话搜索每敲一个字(200 ms 去抖)就调一次,
// 3000 条会话 × 8 KB 的单元要 6–7 秒、整段占住事件循环;记忆召回每条用户消息也调一次。
// 缓存两层,结果与 buildRetrievalCorpus 逐位相同(同一批文档、同一顺序 → 同一 df、同一向量):
//   ① 每篇文档的词频按「文本没变」复用 —— 存成全局词表里的词号数组 + 次数数组(保留首次出现的次序,
//      retrievalVector 的累加次序因此不变),不再每次重新分词;
//   ② 文档集合(id 与文本逐篇相同)没变就整份复用语料;变了只用缓存的词频重算 df 与向量。
// 每个调用点各持一份(会话搜索、记忆召回),互不干扰。
// opts.maxTerms:词表上限(超了整份重来),缺省 200 万;只有单测会调小它来触发重置。
function createRetrievalCorpusCache(opts = {}) {
  const maxTerms = Number(opts && opts.maxTerms) > 0 ? Number(opts.maxTerms) : 2000000;
  const vocab = new Map();          // term -> id
  const termOf = [];                // id -> term
  const termHash = [];              // id -> fnv1a32(term)
  const docs = new Map();           // doc id -> { text, ids: Uint32Array, counts: Uint32Array }
  let last = null;                  // { ids, texts, corpus }
  let generation = 0;               // 词表整份重来一次 +1:挂起中的异步装配据此作废重算(审查轮)
  let buildChain = Promise.resolve();
  const termId = term => {
    let id = vocab.get(term);
    if (id === undefined) { id = termOf.length; vocab.set(term, id); termOf.push(term); termHash.push(fnv1a32(term)); }
    return id;
  };
  const docTerms = (id, text) => {
    const hit = docs.get(id);
    if (hit && hit.text === text) return hit;
    const counts = retrievalTermCounts(text);
    const entry = { text, ids: new Uint32Array(counts.size), counts: new Uint32Array(counts.size) };
    let k = 0;
    for (const [term, count] of counts) { entry.ids[k] = termId(term); entry.counts[k] = count; k++; }
    docs.set(id, entry);
    return entry;
  };
  // 与 retrievalVector 同一算式、同一迭代次序(词按首次出现的次序、raw 按桶首次出现的次序)。
  const vectorOf = (entry, dfById, docCount) => {
    const raw = new Map();
    for (let k = 0; k < entry.ids.length; k++) {
      const tid = entry.ids[k];
      const hash = termHash[tid];
      const dim = hash % RETRIEVAL_DIMS;
      const sign = (hash >>> 16) & 1 ? -1 : 1;
      const seen = dfById.get(tid) || 0;
      const weight = (1 + Math.log(entry.counts[k])) * Math.log(1 + (Math.max(1, docCount) + 1) / (seen + 1));
      raw.set(dim, (raw.get(dim) || 0) + sign * weight);
    }
    let norm = 0;
    for (const value of raw.values()) norm += value * value;
    norm = Math.sqrt(norm);
    const vector = {};
    if (!(norm > 0)) return vector;
    for (const [dim, value] of raw) {
      const scaled = value / norm;
      if (scaled !== 0) vector[dim] = scaled;
    }
    return vector;
  };
  // 异步预热:把还没分过词的文档分词进缓存,每 50 篇让一次事件循环(3000 篇 × 8 KB 首次要几秒,不能一口气占住主线程)。
  // 之后再调 corpusFor 就只剩 df 与向量。结果不变 —— 只是把同一份分词提前、分片做了。
  const prepare = async documents => {
    let sinceYield = 0;
    for (const doc of documents || []) {
      if (!doc || !doc.id) continue;
      const hit = docs.get(String(doc.id));
      if (hit && hit.text === doc.text) continue;
      docTerms(String(doc.id), doc.text);
      if (++sinceYield >= 50) { sinceYield = 0; await new Promise(resolve => setImmediate(resolve)); }
    }
  };
  // 装配(df 与向量)写成生成器:每算完一篇的向量 yield 一次。同步调用方一口气跑完,异步调用方隔几篇让一次事件循环 ——
  // 两条路径是同一份代码,结果相同。
  // 词表只增不减;极端情况下(几百万个不同的词)整份重来,别让它无限长。每次装配开始前查一次。
  const maybeReset = () => {
    if (termOf.length > maxTerms) { vocab.clear(); termOf.length = 0; termHash.length = 0; docs.clear(); last = null; generation += 1; }
  };
  function* assemble(documents) {
    const ids = [], texts = [];
    for (const doc of documents || []) {
      if (!doc || !doc.id) continue;
      ids.push(String(doc.id));
      texts.push(doc.text);
    }
    if (last && last.ids.length === ids.length && last.ids.every((id, i) => id === ids[i] && last.texts[i] === texts[i])) return last.corpus;
    const entries = ids.map((id, i) => docTerms(id, texts[i]));
    // 不在这一批里的缓存条目只在超出上限时才清(审查轮:两批文档交替查询 —— 例如两个工作区的记忆召回 —— 每次都清掉
    // 另一批,等于没有缓存)。上限按当前批的 4 倍、至少 2000 篇,内存仍有界。
    if (docs.size > Math.max(2000, ids.length * 4)) {
      const keep = new Set(ids);
      for (const id of [...docs.keys()]) if (!keep.has(id)) docs.delete(id);
    }
    const dfById = new Map();
    for (const entry of entries) for (let k = 0; k < entry.ids.length; k++) dfById.set(entry.ids[k], (dfById.get(entry.ids[k]) || 0) + 1);
    const docCount = entries.length;
    const df = new Map();
    for (const [tid, n] of dfById) df.set(termOf[tid], n);
    const vectors = [];
    for (const entry of entries) { vectors.push(vectorOf(entry, dfById, docCount)); yield; }
    const corpus = { ids, vectors, df, docCount };
    last = { ids, texts, corpus };
    return corpus;
  }
  const corpusFor = function corpusFor(documents) {
    maybeReset();
    const run = assemble(documents);
    let step = run.next();
    while (!step.done) step = run.next();
    return step.value;
  };
  // 异步版:先分片分词(prepare),装配时每 200 篇让一次。
  // 审查轮:同一份缓存上的异步装配一次只跑一个(串在 buildChain 上)—— 两个并发装配交错时,后一个触发的词表重置会让
  // 前一个挂起中的生成器拿旧词号配新哈希表,算出错的向量。同步的 corpusFor 插进来重置了词表也一样:让出回来发现代数变了就整份重算。
  const buildNow = async documents => {
    for (;;) {
      maybeReset();
      const gen = generation;
      await prepare(documents);
      if (gen !== generation) continue;
      const run = assemble(documents);
      let step = run.next(), n = 0;
      while (!step.done && gen === generation) {
        if (++n % 200 === 0) await new Promise(resolve => setImmediate(resolve));
        if (gen !== generation) break;
        step = run.next();
      }
      if (step.done && gen === generation) return step.value;
    }
  };
  corpusFor.build = documents => {
    const run = buildChain.then(() => buildNow(documents));
    buildChain = run.catch(() => {});
    return run;
  };
  corpusFor.prepare = prepare;
  return corpusFor;
}
