'use strict';

// 第83波：Mission change journal → 现场纪要的纯折算层。
// 双导出保持和 mission-state.js 相同的纪律：浏览器挂 window.PreviewNarrative，Node e2e 直接
// require。这里不读 DOM、不调用模型、不翻译文案；只把权威 change record 折成稳定的语义令牌。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PreviewNarrative = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const CHANGE_TYPES = Object.freeze([
    'mission_started', 'progress', 'failure', 'budget', 'intervention_pending',
    'intervention_resolved', 'result', 'rewind', 'run_deleted',
  ]);
  const TYPE_SET = new Set(CHANGE_TYPES);
  const TONES = Object.freeze({
    mission_started: 'opening', progress: 'progress', failure: 'issue', budget: 'meter',
    intervention_pending: 'attention', intervention_resolved: 'resolved', result: 'result',
    rewind: 'rewind', run_deleted: 'quiet',
  });
  const ACTORS = Object.freeze({
    mission_started: 'dispatcher', progress: 'crew', failure: 'crew', budget: 'meter',
    intervention_pending: 'foreman', intervention_resolved: 'foreman', result: 'foreman',
    rewind: 'operator', run_deleted: 'operator',
  });

  function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  }

  function sentenceKey(type, cursor) {
    if (type !== 'progress') return type;
    if (cursor.action === 'check') return 'progress_check';
    if (cursor.engine) return 'progress_turn';
    return 'progress_ledger';
  }

  function toNarrativeEntry(record) {
    const source = record && typeof record === 'object' ? record : {};
    const seq = Number(source.seq);
    const type = TYPE_SET.has(source.type) ? source.type : 'progress';
    const cursor = plainObject(source.cursor);
    const detail = plainObject(source.detail);
    return Object.freeze({
      id: `${Math.max(0, Number.isSafeInteger(seq) ? seq : 0)}:${type}`,
      seq: Math.max(0, Number.isSafeInteger(seq) ? seq : 0),
      type,
      tone: TONES[type],
      actor: ACTORS[type],
      sentenceKey: sentenceKey(type, cursor),
      occurredAt: String(source.occurredAt || ''),
      cursor: Object.freeze(cursor),
      detail: Object.freeze(detail),
    });
  }

  // 只折算本次 API 增量；既有 entries 原样复用，避免轮询时全量重建叙事。
  function appendNarrativeEntries(currentEntries, records) {
    const current = Array.isArray(currentEntries) ? currentEntries.filter(Boolean) : [];
    const seen = new Set(current.map(entry => Number(entry.seq)).filter(Number.isSafeInteger));
    const additions = (Array.isArray(records) ? records : [])
      .map(toNarrativeEntry)
      .filter(entry => entry.seq > 0 && !seen.has(entry.seq))
      .sort((a, b) => a.seq - b.seq);
    for (const entry of additions) seen.add(entry.seq);
    const entries = current.concat(additions);
    return Object.freeze({
      entries,
      added: additions,
      lastSeq: entries.reduce((max, entry) => Math.max(max, Number(entry && entry.seq) || 0), 0),
    });
  }

  return { CHANGE_TYPES, toNarrativeEntry, appendNarrativeEntries };
});
