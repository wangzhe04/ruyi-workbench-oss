// 151 阶段 1 · U4：每轮记忆检查摘要的可见尾标。
// 修前摘要（匹配 N、核心 N、补位 N、关键词回退）只写进永久隐藏的 #toolOutput，用户看不到，e2e 读隐藏节点所以是绿的。
// 现在它挂在助手消息尾部、与 token/用量同一行：一枚 <details>，摘要一行常显，点开看候选数、项目/全局分布与回退原因。
// 纯模块：数据只来自流式 meta 事件的 memoryCheck（后端 memoryPreflight.status），不读任何别的状态。
const KEYWORD_FALLBACK = new Set(['overloaded', 'timeout', 'partial', 'truncated']);
// 150 号文 S1/S11：语义运行时不可用、检索期间记忆库变化后重算，各有自己的回执，不混进「重排未完成」。
const OWN_FALLBACK = { loading: 'preparing', unavailable: 'unavailable', stale: 'stale' };
const SUMMARY_TAG = { keyword: 'memory.badge.keywordFallback', preparing: 'memory.badge.semanticPreparing', unavailable: 'memory.badge.semanticUnavailable', stale: 'memory.badge.staleRecovered' };
const DETAIL_LINE = { keyword: 'memory.check.semanticFallback', preparing: 'memory.check.semanticPreparing', unavailable: 'memory.check.semanticUnavailable', stale: 'memory.check.staleRecovered' };
const count = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);

export function memoryCheckBadgeModel(check) {
  if (!check || typeof check !== 'object') return null;
  if (!check.enabled) return { state: 'disabled' };
  if (!check.checked) return { state: 'unavailable' };
  const reason = check.semantic && check.semantic.fallback ? check.semantic.fallback.reason : undefined;
  return {
    state: 'done', matches: count(check.matchCount), core: count(check.coreActiveCount), fill: count(check.ruleFillCount),
    candidates: count(check.candidateCount), project: count(check.projectMatches), global: count(check.globalMatches),
    fallback: Object.hasOwn(OWN_FALLBACK, reason) ? OWN_FALLBACK[reason] : KEYWORD_FALLBACK.has(reason) ? 'keyword' : '',
  };
}

export function memoryCheckSummaryText(model, t) {
  if (!model) return '';
  if (model.state === 'disabled') return t('memory.badge.disabled');
  if (model.state === 'unavailable') return t('memory.badge.unavailable');
  const head = t('memory.badge.summary', { matches: model.matches, core: model.core, fill: model.fill });
  return SUMMARY_TAG[model.fallback] ? head + ' · ' + t(SUMMARY_TAG[model.fallback]) : head;
}

export function memoryCheckDetailLines(model, t) {
  if (!model) return [];
  if (model.state === 'disabled') return [t('memory.check.disabled')];
  if (model.state === 'unavailable') return [t('memory.check.unavailable')];
  const lines = [t('memory.check.done', { candidates: model.candidates, matches: model.matches, project: model.project, global: model.global })
    + (model.core > 0 ? t('memory.check.core', { core: model.core }) : '')
    + (model.fill > 0 ? t('memory.check.fill', { fill: model.fill }) : '')];
  if (DETAIL_LINE[model.fallback]) lines.push(t(DETAIL_LINE[model.fallback]));
  return lines;
}

export function renderMemoryCheckBadge(check, { t, doc = globalThis.document } = {}) {
  const model = memoryCheckBadgeModel(check);
  if (!model || !doc) return null;
  const badge = doc.createElement('details');
  badge.className = 'memory-check-badge';
  badge.dataset.state = model.state;
  if (model.fallback) badge.dataset.fallback = model.fallback;
  const summary = doc.createElement('summary');
  summary.textContent = memoryCheckSummaryText(model, t);
  summary.title = t('memory.badge.title');
  const body = doc.createElement('div');
  body.className = 'memory-check-detail';
  for (const line of memoryCheckDetailLines(model, t)) {
    const row = doc.createElement('p');
    row.textContent = line;
    body.appendChild(row);
  }
  badge.append(summary, body);
  return badge;
}

// 给实时回合壳用：有 usage 行就并进那一行，回合收尾时还没放（出错、没有 usage）就在消息尾部单独起一行。每个壳只放一次。
export function createMemoryBadgeAttacher({ t, doc = globalThis.document } = {}) {
  return function attachMemoryBadge(live, line) {
    if (!live || !live.memoryCheck || live.memoryBadgePlaced) return null;
    const host = line || (live.main ? doc.createElement('div') : null);
    if (!host) return null;
    const badge = renderMemoryCheckBadge(live.memoryCheck, { t, doc });
    if (!badge) return null;
    if (!line) { host.className = 'usage-line memory-check-line'; live.main.appendChild(host); }
    host.appendChild(badge);
    live.memoryBadgePlaced = true;
    return badge;
  };
}
