'use strict';

// 150 号文 U2／U11：左栏线程搜索的客户端状态机（纯函数、零 DOM、零 import、零 fetch）。
// 请求、去抖、序号丢弃仍然只住 session-experience.js 一处；本文件只回答三个问题：
//   ① 一发回包怎么并进已有状态（超时的空回包不许把已出的结果清掉）—— nextSessionSearchState／failedSessionSearchState；
//   ② 回包之后要不要接着搜、隔多久（连续超时退避，到顶就停下、露出「继续搜索」）—— sessionSearchFollowUp；
//   ③ 搜索框下那一句说明说什么（按状态互斥，只说一件事）—— sessionSearchNotices。
// dev-harness/unit/session-search-state.test.js 直接 import 跑真值表。

export const SESSION_SEARCH_REFRESH_MS = 500;
export const SESSION_SEARCH_MAX_REFRESH = 127;
// 连续超时的退避：第 1、2、3、4 次超时之后分别等 0.5／1／2／4 s 再接着搜；第 5 次超时就停下，交给「继续搜索」。
export const SESSION_SEARCH_TIMEOUT_BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000]);

// 这一发是不是「超时」：只认源级截止（reason:'deadline'／coverage.phase==='timeout'）。只有语义编码超时、关键词
// 检索已完整时（13ap 照样回 semantic.status:'timeout'），这一发的结果与覆盖率是权威的 —— 不保留旧结果、不说「已暂停」，
// 说明走语义回退那一档（1C 审查：否则「已索引 100/100」与「超时已暂停」并列，完整零命中还会被旧结果顶替）。
export function sessionSearchTimedOut(response) {
  if (!response || typeof response !== 'object') return false;
  return response.reason === 'deadline'
    || Boolean(response.coverage && response.coverage.phase === 'timeout');
}

function sameQuery(previous, query) {
  return previous && typeof previous === 'object' && previous.query === query ? previous : null;
}

// ① 成功回包（ok + results 数组）并进状态。超时且本次结果为空、上一次同一查询词手上有结果时：
// 保留上一次的结果与上一次的覆盖率／语义状态（timedOut 照实记下，说明那一句据此说「已暂停」）。
// 换了查询词（previous.query 不同）就是全新状态，计数归零。
export function nextSessionSearchState(previous, response, query) {
  const prior = sameQuery(previous, query);
  const timedOut = sessionSearchTimedOut(response);
  const timeouts = timedOut ? ((prior && Number(prior.timeouts)) || 0) + 1 : 0;
  const results = Array.isArray(response && response.results) ? response.results : [];
  const fresh = {
    query, results, loading: false, failed: false,
    coverage: response && response.coverage, semantic: response && response.semantic,
    lexicalPreview: Boolean(response && response.lexicalPreview === true),
    timedOut, timeouts,
  };
  if (timedOut && !results.length && prior && Array.isArray(prior.results) && prior.results.length) {
    return { ...fresh, results: prior.results, coverage: prior.coverage || fresh.coverage,
      semantic: prior.semantic || fresh.semantic, lexicalPreview: false, kept: true };
  }
  return fresh;
}

// ① 请求抛错（5xx、断网）：保留上一次同一查询词的结果，记下错误类别，允许「继续搜索」重试。
// 手上没有结果就是 results:null —— 左栏照旧回退到标题子串过滤（113b 的兜底路径一字未改）。
export function failedSessionSearchState(previous, query, error) {
  const prior = sameQuery(previous, query);
  const status = Number(error && error.status) || 0;
  const keep = prior && Array.isArray(prior.results) ? prior : null;
  return {
    query, results: keep ? keep.results : null, loading: false, failed: true,
    coverage: keep ? keep.coverage : undefined, semantic: keep ? keep.semantic : undefined,
    error: status >= 500 ? 'server' : 'network', timedOut: false, timeouts: 0, canResume: true,
  };
}

// ② 回包之后：{ next:true, delayMs } 接着搜；{ next:false, resume } 停下（resume 为真则露出「继续搜索」）。
// 判据与修前同源（源进度前进／语义片段前进／预览／语义模型加载中前三次），只多两条：
//   · 本发超时 → 等待时长按连续超时次数退避；连续超时超过退避表长度就停（不再每 0.5 s 打一发 15 s 的请求，上限 127 次）；
//   · 停在超时上一律 resume（界面说「超时已暂停」，按钮必须在）。
export function sessionSearchFollowUp({ response, previous, refreshAttempt = 0, timeouts = 0 } = {}) {
  const coverage = response && response.coverage;
  const semantic = response && response.semantic;
  const sourcePending = Boolean(coverage && coverage.complete === false && coverage.pendingSessions > 0
    && ['pending', 'building', 'idle'].includes(coverage.phase));
  const sourceAdvanced = Boolean(coverage && coverage.phase === 'timeout' && coverage.preparedThisRequest > 0)
    || (sourcePending && Number.isSafeInteger(coverage.indexedSessions)
      && coverage.indexedSessions > ((previous && previous.coverage && previous.coverage.indexedSessions) ?? 0));
  const semanticAdvanced = Boolean(semantic && !semantic.truncated && semantic.coverage !== 'complete'
    && semantic.cachedFragments > ((previous && previous.semantic && previous.semantic.cachedFragments) ?? 0));
  const semanticPending = Boolean(semantic && ['loading', 'partial', 'timeout'].includes(semantic.status)
    && !semantic.truncated && semantic.coverage !== 'complete');
  const lexicalPreview = Boolean(response && response.lexicalPreview === true);
  const canContinue = !['paused', 'disabled'].includes(coverage && coverage.phase)
    && (lexicalPreview || sourceAdvanced || semanticAdvanced || (semantic && semantic.status === 'loading' && refreshAttempt < 3));
  const timedOut = sessionSearchTimedOut(response);
  const backoffSpent = timedOut && timeouts > SESSION_SEARCH_TIMEOUT_BACKOFF_MS.length;
  if (canContinue && refreshAttempt < SESSION_SEARCH_MAX_REFRESH && !backoffSpent) {
    const delayMs = timedOut
      ? SESSION_SEARCH_TIMEOUT_BACKOFF_MS[Math.min(Math.max(timeouts, 1), SESSION_SEARCH_TIMEOUT_BACKOFF_MS.length) - 1]
      : SESSION_SEARCH_REFRESH_MS;
    return { next: true, delayMs };
  }
  return { next: false, resume: Boolean(timedOut || sourcePending || semanticPending) };
}

function coverageCounts(coverage) {
  return coverage && Number.isSafeInteger(coverage.indexedSessions) && Number.isSafeInteger(coverage.sessions)
    ? { indexed: coverage.indexedSessions, total: coverage.sessions } : null;
}

// ③ 搜索框下的说明：返回 [{ key, params }]。第一条是【互斥】的主说明，按下面的先后只取一条：
//   出错 → 准备中（请求在飞／两发之间等下一发／关键词预览）→ 超时已暂停可继续 → 索引已暂停 → 部分覆盖可继续 → 语义降级／不全 → 完成（覆盖率）。
// 只有「完成」那一档才在后面附「另有 N 个附件／消息待验证」—— 它们与主说明不矛盾，其余各档不附，免得一句话压住列表。
export function sessionSearchNotices(state) {
  const s = state && typeof state === 'object' ? state : {};
  const coverage = s.coverage || null;
  const semantic = s.semantic || null;
  const counts = coverageCounts(coverage);
  if (s.error) {
    if (!(Array.isArray(s.results) && s.results.length)) return [{ key: 'session.searchFailedEmpty' }];
    // 保留下来的上一次覆盖率一并说出来:用户知道手上这批结果是在索引到哪一步时搜出来的。
    return [counts ? { key: 'session.searchFailedCoverage', params: counts } : { key: 'session.searchFailed' }];
  }
  if (s.loading || s.continuing || (s.lexicalPreview && !s.canResume)) {
    if (s.lexicalPreview && !(Array.isArray(s.results) && s.results.length)) return [{ key: 'session.searchPreviewEmpty' }];
    // 进度量得到(上一发带回了覆盖率)就并进同一句里说 —— 索引确实在推进,不让用户以为卡住了。
    const preparing = coverage && coverage.phase !== 'timeout' && coverage.complete === false ? counts : null;
    return [preparing ? { key: 'session.searchPreparingCoverage', params: preparing } : { key: 'session.searchPreparing' }];
  }
  if (s.timedOut || (coverage && coverage.phase === 'timeout')) {
    const known = coverage && coverage.phase !== 'timeout' ? counts : null;
    return [known ? { key: 'session.searchTimeoutPaused', params: known } : { key: 'session.searchProgressUnavailable' }];
  }
  if (coverage && coverage.phase === 'paused') return [counts ? { key: 'session.searchIndexPaused', params: counts } : { key: 'session.searchPaused' }];
  if (s.canResume && counts && coverage.complete === false) return [{ key: 'session.searchPartialResumable', params: counts }];
  if (semantic && !['disabled', 'deferred'].includes(semantic.status)) {
    if (semantic.status === 'loading') return [{ key: 'session.semanticLoading' }];
    if (['unavailable', 'timeout', 'overloaded'].includes(semantic.status) && !semantic.cachedFragments) return [{ key: 'session.semanticFallback' }];
    if (semantic.coverage !== 'complete') return [{ key: 'session.semanticPartial', params: { cached: semantic.cachedFragments || 0, total: semantic.candidateFragments || 0 } }];
  }
  if (!counts) return [];
  const out = [{ key: 'session.searchCoverage', params: counts }];
  if (coverage.attachments && coverage.attachments.unverifiedFullText > 0) out.push({ key: 'session.searchUnverifiedAttachments', params: { count: coverage.attachments.unverifiedFullText } });
  if (coverage.messages && coverage.messages.unverifiedText > 0) out.push({ key: 'session.searchUnverifiedMessages', params: { count: coverage.messages.unverifiedText } });
  return out;
}
