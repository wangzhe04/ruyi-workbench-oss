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
