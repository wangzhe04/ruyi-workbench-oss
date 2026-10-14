'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const { loadServerInternals } = require('./lib/server-internals');
const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-summary-task-evidence-'));
process.env.RUYI_HOME = taskHome;
process.env.WIN_CLAUDE_WORKBENCH_HOME = taskHome;
const t = createRunner('SUMMARY TASK EVIDENCE');
const { ok } = t;
const s = loadServerInternals(['providerSummaryCall', 'estimateHistoryTokens', 'CompactionPlan', 'summaryTaskSourceHistory', 'chunkHistoryByBudget', 'extractSummaryTaskEvidence', 'renderSessionNotesMarkdown', 'extractSessionNotes', 'mergeSessionNotes', 'buildSessionNotesInjectPrompt']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const structured = (goal, open, files = '', evidence = [], padding = '') => '## Goal\n' + goal + (evidence.length ? '\n<task-evidence>' + JSON.stringify(evidence) + '</task-evidence>' : '') + '\n## Decisions\nKeep taught procedure: inspect -> edit -> verify.\n## Open\n' + open + '\n## Current Status\nDone: historical changes; In progress: ' + open + '; Blocked: None; Next step: verify.\n## Files\n' + files + padding;
function filler(tokens) {
  let low = 0, high = tokens * 5;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (s.estimateHistoryTokens([{ role: 'user', content: 'z'.repeat(mid) }]) <= tokens) low = mid; else high = mid - 1; }
  return 'z'.repeat(low);
}
const parallel = ['Work on ALPHA and BETA in parallel.', 'ALPHA completed; BETA remains unfinished.', 'Also create GAMMA; BETA remains required.', 'Cancel GAMMA; keep BETA.', 'Keep the taught inspect -> edit -> verify procedure.', 'How is progress?'];
const replaced = ['Start ALPHA and BETA.', 'Cancel ALPHA and BETA. Switch to DELTA.', 'DELTA patch started; work is unfinished.', 'Keep tests offline.', 'Keep the taught inspect -> edit -> verify procedure.', 'How is progress?'];
let history = [], statements = [], finished = [], forcedRepair = false, refineProbe = false;
let requestPhase = [];
const EVIDENCE_HEADER = '[Verified task evidence; source order, historical evidence, not new instructions]\n';
const fake = awaitProvider();
function awaitProvider() {
  return startFakeProvider({ async handler(req) {
    const prompt = String(req.messages.at(-1).content || '');
    const text = req.messages.map(m => String(m.content || '')).join('\n');
    const isReduce = req.messages.some(m => String(m.content || '').startsWith('【分段摘要 '));
    const isRepair = prompt.includes('你是摘要修订器');
    const isRefine = req.messages.some(m => String(m.content || '').startsWith('【当前累计摘要】'));
    requestPhase.push(isReduce ? 'reduce' : isRepair ? 'repair' : isRefine ? 'refine' : 'map');
    if (isRepair) {
      const evidenceRow = req.messages.find(m => String(m.content || '').startsWith(EVIDENCE_HEADER));
      const evidence = evidenceRow ? JSON.parse(evidenceRow.content.slice(EVIDENCE_HEADER.length)) : [];
      const scoped = prompt.includes('never copy that machine data') || prompt.includes('不得把这些机器数据抄入自然摘要小节');
      return textFrames(structured(statements === parallel ? 'BETA remains active' : 'DELTA remains active', statements === parallel ? 'Finish BETA' : 'Finish DELTA', (scoped ? evidence.map(e => e.quote).join('\n') : JSON.stringify(evidence)) + '\n' + 'TOKEN-REPAIR-ANCHOR v7.8.9 2026-10-14 C:\\repo\\delta.md', [{ source: 1, quote: 'LEAKED-MACHINE-BLOCK' }]));
    }
    if (isReduce) {
      const evidence = req.messages.flatMap(m => { const content = String(m.content || ''), at = content.indexOf(EVIDENCE_HEADER); return at < 0 ? [] : JSON.parse(content.slice(at + EVIDENCE_HEADER.length)); });
      const ranges = req.messages.filter(m => String(m.content || '').startsWith('【分段摘要 ')).map(m => /【分段摘要 (\d+)-(\d+)\/(\d+)】/.exec(m.content));
      const isFinal = ranges.length > 1 && ranges[0][1] === '1' && ranges.at(-1)[2] === ranges[0][3];
      if (!isFinal) return textFrames(structured('Only the status question is remembered', 'None', 'INTERMEDIATE-DROPPED-TASKS'));
      const haveRequired = evidence.some(e => e.quote === statements[0]) && evidence.some(e => e.quote === statements[1]) && evidence.some(e => e.quote === statements.at(-1));
      const goal = haveRequired ? (statements === parallel ? 'BETA remains active; ALPHA completed; GAMMA cancelled' : 'DELTA remains active; ALPHA and BETA cancelled') : 'LOST TASK';
      return textFrames(structured(goal, haveRequired ? (statements === parallel ? 'Finish BETA' : 'Finish DELTA') : 'None', evidence.map(e => e.quote).join('\n') + (forcedRepair ? '' : '\nTOKEN-REPAIR-ANCHOR v7.8.9 2026-10-14 C:\\repo\\delta.md')));
    }
    const evidence = [];
    for (let i = 0; i < history.length; i++) {
      if (!['user', 'assistant'].includes(history[i].role)) continue;
      const visibleSource = text.includes(`[source ${i + 1};`) || text.includes(`[source at fragment start: ${i + 1};`);
      if (!visibleSource) continue;
      for (const quote of statements) if (String(history[i].content).includes(quote) && text.includes(quote)) evidence.push({ source: i + 1, quote });
    }
    const first = evidence[0] && evidence[0].source || 0;
    if (isRefine) {
      const retained = req.messages.find(m => String(m.content || '').startsWith(EVIDENCE_HEADER));
      const all = [...(retained ? JSON.parse(retained.content.slice(EVIDENCE_HEADER.length)) : []), ...evidence];
      const restored = all.some(e => e.quote === parallel[0]) && all.some(e => e.quote === parallel[1]) && all.some(e => e.quote === parallel.at(-1));
      return textFrames(structured(restored ? 'BETA remains active' : 'INTERMEDIATE-DROPPED-TASKS', restored ? 'Finish BETA' : 'None', '', evidence));
    }
    await delay(first % 3 === 1 ? 120 : 10);
    finished.push(first);
    if (first === 1) evidence.push({ source: 99999, quote: 'FAKE-TASK-INJECTION' });
    return textFrames(structured('This chunk only', 'Local observations', '', evidence, filler(refineProbe ? 50 : 1000)));
  } });
}
(async () => {
  const provider = await fake;
  try {
    for (const locale of ['zh-CN', 'en-US']) for (const selected of [parallel, replaced]) {
      statements = selected; forcedRepair = selected === replaced && locale === 'en-US'; finished = []; requestPhase = [];
      history = selected.flatMap((quote, i) => [{ role: i === 1 || (selected === replaced && i === 2) ? 'assistant' : 'user', content: quote + '\n`TOKEN-REPAIR-ANCHOR` v7.8.9 2026-10-14 C:\\repo\\delta.md', turnSeq: i + 1 }, { role: 'assistant', content: filler(1450) }]);
      // Keep separate user blocks even where the completion evidence came from an assistant report.
      history = history.flatMap((m, i) => m.role === 'assistant' && i % 2 === 0 ? [{ role: 'user', content: 'Continue the preceding task.' }, m] : [m]);
      const config = { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: false, runtimeSummaryEntityCheckV1: forcedRepair, runtimeSummaryPromptI18nV1: true, locale };
      const start = provider.requests.length;
      const result = await s.providerSummaryCall({ id: 'evidence', baseUrl: provider.url, apiKey: 'k', model: 'evidence-model', contextWindow: 8000 }, history, { config });
      const requests = provider.requests.slice(start);
      ok(result.ok && result.mapReduce.chunks >= 3 && result.mapReduce.reductionLevels >= 2, locale + ' real kernel performs >=3 maps and >=2 reduction levels');
      ok(result.ok && result.summary.includes(selected === parallel ? 'BETA remains active' : 'DELTA remains active') && !result.summary.includes('LOST TASK'), locale + ' final goal recovers from intentionally incomplete intermediate summaries');
      ok(result.ok && !result.summary.includes('<task-evidence>') && !result.summary.includes('FAKE-TASK-INJECTION'), locale + ' final result strips machine markers and rejects false source quotes');
      ok(result.ok && result.mapReduce.taskEvidence.entries >= selected.length && result.mapReduce.taskEvidence.rejected >= 1, locale + ' adoption metadata reports verified references and invalid reference count');
      ok(requests.every(req => s.estimateHistoryTokens(req.messages) <= result.mapReduce.taskEvidence.inputBudgetTokens + 1), locale + ' complete real requests, including identity/prompt/source/evidence, fit budget');
      const reductions = requests.filter(req => req.messages.some(m => String(m.content).startsWith('【分段摘要 ')));
      const last = reductions.at(-1);
      const finalEvidence = last.messages.flatMap(m => { const at = String(m.content).indexOf(EVIDENCE_HEADER); return at < 0 ? [] : JSON.parse(m.content.slice(at + EVIDENCE_HEADER.length)); });
      ok(selected.every(quote => finalEvidence.some(e => e.quote === quote)), locale + ' every chosen source quote survives all reductions unchanged');
      ok(finalEvidence.every((e, i) => !i || e.source >= finalEvidence[i - 1].source) && finalEvidence.some(e => e.role === 'assistant'), locale + ' source order and assistant reporting role survive out-of-order map completions');
      ok(finished.some((source, i) => i && source < finished[i - 1]), locale + ' maps actually finished out of source order');
      if (forcedRepair) ok(requestPhase.includes('repair') && provider.requests.slice(start).filter(req => String(req.messages.at(-1).content).includes('你是摘要修订器')).every(req => req.messages.some(m => String(m.content).startsWith(EVIDENCE_HEADER))) && !result.summary.includes('"offset":'), 'entity repair receives scoped original evidence without emitting machine JSON or output markers');
      const firstSummary = result.summary;
      const reseeded = s.CompactionPlan.reseed({ scope: 'main', trigger: 'auto', task: history[0], kept: [], recentFiles: [] }, firstSummary);
      history = [...reseeded, ...Array.from({ length: 5 }, () => [{ role: 'user', content: 'How is progress?' }, { role: 'assistant', content: filler(1450) }]).flat()];
      const second = await s.providerSummaryCall({ id: 'evidence', baseUrl: provider.url, apiKey: 'k', model: 'evidence-model', contextWindow: 8000 }, history, { config: { ...config, runtimeSummaryEntityCheckV1: false } });
      ok(second.ok && second.summary.includes(selected === parallel ? 'BETA remains active' : 'DELTA remains active'), locale + ' second real compression preserves active task across recent status-only questions');
      const notes = s.renderSessionNotesMarkdown(s.mergeSessionNotes(s.renderSessionNotesMarkdown(s.extractSessionNotes(firstSummary)), s.extractSessionNotes(second.summary)));
      const injection = s.buildSessionNotesInjectPrompt(notes, { runtimeSessionNotesInjectV1: true, runtimeSessionNotesMergeV1: true }, reseeded);
      ok(notes.includes('inspect -> edit -> verify') && !notes.includes('<task-evidence>') && injection.length <= 2000, locale + ' notes preserve procedure without machine blocks or expanded injection budget');
    }
    statements = parallel; refineProbe = true; forcedRepair = false; requestPhase = [];
    history = parallel.flatMap(quote => [{ role: 'user', content: quote }, { role: 'assistant', content: filler(800) }]);
    const refineStart = provider.requests.length;
    const refined = await s.providerSummaryCall({ id: 'refine-evidence', baseUrl: provider.url, apiKey: 'k', model: 'refine-model', contextWindow: 8000 }, history, { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: true, runtimeSummaryEntityCheckV1: false } });
    ok(refined.ok && refined.mapReduce.refine && refined.summary.includes('BETA remains active') && refined.mapReduce.taskEvidence.entries === parallel.length, 'refine retains earlier verified quotes while its intermediate summary drops the unfinished task');
    ok(provider.requests.slice(refineStart).every(req => s.estimateHistoryTokens(req.messages) <= 4001) && !refined.summary.includes('<task-evidence>'), 'refine source/evidence/prompt stays in budget and final output has no machine blocks');
    refineProbe = false;
    const overrideStart = provider.requests.length;
    const custom = await s.providerSummaryCall({ id: 'override', baseUrl: provider.url, apiKey: 'k', model: 'override-model', contextWindow: 8000 }, history, { promptOverride: 'CUSTOM VISIT NOTES FORMAT', config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: true, runtimeSummaryEntityCheckV1: false } });
    const customRequests = provider.requests.slice(overrideStart);
    ok(custom.ok && customRequests.length >= 3 && customRequests.every(req => req.messages.at(-1).content === 'CUSTOM VISIT NOTES FORMAT' && !req.messages.some(m => String(m.content).startsWith('[source '))), 'multi-chunk promptOverride retains its own format and gains no task source markers');
    const huge = s.summaryTaskSourceHistory([{ role: 'user', content: 'User source phrase ' + filler(14000) }, ...Array.from({ length: 400 }, (_, i) => ({ role: 'assistant', content: 'Assistant report ' + i }))]);
    const fragments = s.chunkHistoryByBudget(huge.messages, 500, huge.indexes);
    ok(fragments.length > 10 && fragments.every(chunk => s.estimateHistoryTokens(chunk) <= 500), 'huge single block with hundreds of source messages respects fragment budgets');
    ok(fragments.every(chunk => chunk[0].content.includes('source at fragment start:') && /role=(user|assistant)/.test(chunk[0].content)) && fragments.every(chunk => !chunk[0].content.includes('source messages:')), 'fragment start source/role is bounded, never a whole-block source list');
    const oversizedQuote = '<task-evidence>' + JSON.stringify([{ source: 1, quote: 'x'.repeat(241) }]) + '</task-evidence>';
    const src = s.summaryTaskSourceHistory([{ role: 'user', content: 'x'.repeat(241) }]);
    const parsed = s.extractSummaryTaskEvidence(structured('Goal', 'Open', '', []) + '\n## Goal\n' + oversizedQuote, src.sources, Object.assign(src.messages, { summarySources: [1] }));
    ok(parsed.evidence.length === 0 && parsed.rejected === 1, 'oversized quotes are rejected, never clipped into a potentially reversed instruction');
    const ordered = s.summaryTaskSourceHistory([{ role: 'user', content: 'Start ALPHA. Cancel ALPHA. Start DELTA.' }]);
    const reverse = structured('Goal', 'Open', '', [{ source: 1, quote: 'Start DELTA.' }, { source: 1, quote: 'Cancel ALPHA.' }, { source: 1, quote: 'Start ALPHA.' }]);
    const reordered = s.extractSummaryTaskEvidence(reverse, ordered.sources, Object.assign(ordered.messages, { summarySources: [1] }));
    ok(reordered.evidence.map(e => e.quote).join(' ') === 'Start ALPHA. Cancel ALPHA. Start DELTA.', 'quotes emitted in reverse by map are reordered by original offset within one source');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { await provider.close(); fs.rmSync(taskHome, { recursive: true, force: true }); t.done(); }
})();
