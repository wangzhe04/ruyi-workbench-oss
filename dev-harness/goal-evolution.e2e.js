'use strict';
// Offline behavior checks: goal continuity across compaction and bounded latest activity evidence.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-goal-evolution-'));
process.env.RUYI_HOME = taskHome;
process.env.WIN_CLAUDE_WORKBENCH_HOME = taskHome;
const t = createRunner('GOAL EVOLUTION');
const { ok } = t;
const s = loadServerInternals(['CompactionPlan', 'compactionTaskText', 'historyStartsWithCompactionSummary', 'sessionMeta', 'createSession', 'saveSession', 'rewindSession', 'listSessions', 'safeSessionId', 'getPromptPack', 'stewardThreadDigestRows', 'stewardOverviewBlock', 'stewardImplThreadsSearch', 'stewardImplThreadRead', 'mergeSessionNotes', 'renderSessionNotesMarkdown', 'buildSessionNotesInjectPrompt', 'CONTEXT_GOVERNANCE_RULES', 'SUMMARY_PROMPT', 'SUMMARY_PROMPT_EN']);
const summary = (goal, historical = 'A cancelled') => '## Goal\n' + goal + '\n## Decisions\nKeep offline; taught workflow: inspect, edit, verify.\n## Open\nFinish ' + goal + '\n## Current Status\nDone: ' + historical + '; In progress: ' + goal + '; Blocked: None; Next step: verify.\n## Files\nA history retained; B current files.';
const plan = (task, extra = {}) => ({ scope: 'main', trigger: 'auto', task, kept: [], recentFiles: [], ...extra });
(async () => {
  try {
    for (const historical of ['A cancelled', 'A completed']) {
      let h = [{ role: 'user', content: 'Start A' }];
      for (let i = 0; i < 3; i++) {
        h = s.CompactionPlan.reseed(plan(h[0]), summary('B', historical));
        ok(h[0].content.includes('## Goal\nB') && !h[0].content.includes('原始任务(保持聚焦)'), historical + ': B is current, first request is history at pass ' + i);
        ok((h[0].content.match(/【压缩摘要/g) || []).length === 1 && h[0].content.includes('Start A'), historical + ': no nested summary, history remains');
      }
    }
    const legacy = { role: 'user', content: '原始任务(保持聚焦):\nStart A\n\n【压缩摘要】\nOLD' };
    ok(!s.CompactionPlan.reseed(plan(legacy), summary('B'))[0].content.includes('OLD'), 'legacy prefix is unwrapped');
    const manual = { role: 'user', content: '(以下是此前对话的压缩摘要)\n' + summary('B') };
    ok(s.compactionTaskText(manual).trim() === '## Goal\nB', 'manual English Goal is parsed without old summary nesting');
    const tail = [{ role: 'user', content: 'How is progress? Also keep tests offline.' }];
    const continued = s.CompactionPlan.reseed(plan(manual, { kept: tail }), summary('B'));
    ok(continued.at(-1) === tail[0] && continued[0].content.includes('补充或进度追问不取消未完目标'), 'recent additions and status questions preserve unfinished goal and applicable constraints');
    const forced = s.CompactionPlan.reseed(plan(manual, { trigger: 'forced_400' }), summary('B'), { toolIndex: 'rawRef=history:1:0123456789abcdef:3:0123456789abcdef' });
    ok(s.historyStartsWithCompactionSummary(forced) && forced[0].content.includes('rawRef='), 'forced summary is recognized and tool index preserved');
    const sub = s.CompactionPlan.reseed(plan({ role: 'user', content: 'Delegated task B' }, { scope: 'subagent' }), summary('B'));
    ok(sub[0].content.startsWith('原始任务(保持聚焦):\nDelegated task B'), 'subagent delegated task constraint remains');
    const notes = s.renderSessionNotesMarkdown(s.mergeSessionNotes(s.renderSessionNotesMarkdown({ decisions: 'Old A decision\nKeep offline\nTaught workflow: inspect, edit, verify', open: 'Finish A', files: 'A file' }), { decisions: 'B decision\nKeep offline\nTaught workflow: inspect, edit, verify', open: 'Finish B', files: 'B file' }));
    const injected = s.buildSessionNotesInjectPrompt(notes, { runtimeSessionNotesV1: true, runtimeSessionNotesInjectV1: true, runtimeSessionNotesMergeV1: true }, forced);
    ok(notes.includes('Taught workflow') && notes.includes('A file') && !notes.includes('Finish A'), 'notes retain taught workflow and history while open tasks use newest summary');
    ok(injected.includes('current user instructions take precedence') && injected.includes('never automatically restore') && !injected.includes('Finish A'), 'historical notes cannot assert old goal or constraints as active');
    const rules = s.CONTEXT_GOVERNANCE_RULES.summary;
    ok(s.SUMMARY_PROMPT.includes('不得只凭最新一句重置目标') && s.SUMMARY_PROMPT_EN.includes('do not reset the goal from the latest sentence alone'), 'Chinese and English summary protect continuity');
    ok(rules.refine.prompt.includes('普通补充和进度追问不取消主目标') && rules.entityCheck.repairPrompt.includes('不得恢复为当前目标'), 'refine and entity repair preserve goal status');
    const session = await s.createSession({ title: 'Initial A', cwd: taskHome });
    const secret = 'sk-' + 'q'.repeat(40);
    session.summary = 'Working on B';
    session.turnSeq = 2;
    session.messages = [{ role: 'user', content: 'Start A', turnSeq: 1 }, ...Array.from({ length: 250 }, (_, i) => ({ role: 'assistant', content: 'Historical progress A ' + i })), { role: 'user', content: 'Cancel A. Work on B_TARGET ' + secret, turnSeq: 2, at: '2026-10-14T00:00:00Z' }, { role: 'user', content: 'agent wake notification', meta: { origin: 'agent_wake' } }];
    session.threadBrief = { title: 'Initial A', gist: 'Build A' };
    await s.saveSession(session);
    const meta = (await s.listSessions()).find(row => row.id === session.id);
    ok(meta.recentUserRequest.text.includes('B_TARGET') && meta.recentUserRequest.turnSeq === 2 && s.sessionMeta(meta).recentUserRequest.text === meta.recentUserRequest.text, 'index double normalization preserves latest actual user request and turn');
    const rows = await s.stewardThreadDigestRows({});
    const relatedIds = ['a'.repeat(36), 'b'.repeat(36)];
    ok(relatedIds.every(id => s.safeSessionId(id) === id), 'relation budget fixture uses long legal session IDs');
    const crowded = [{ displayTitle: 'A'.repeat(200), digest: { id: 'budget-row', title: 'Initial A', lastSay: 'reply '.repeat(80), recentUserRequest: { text: '近期新诉求'.repeat(40) } }, relatedThreads: relatedIds.map(sessionId => ({ sessionId, reasons: ['relatedSessionId', 'sameMission'] })) }];
    for (const locale of ['zh-CN', 'en-US']) {
      const block = s.stewardOverviewBlock(crowded, s.getPromptPack(locale));
      const line = block.split('\n').find(value => value.includes(s.getPromptPack(locale).steward.activityRequest));
      ok(line && line.length <= 320, locale + ' crowded overview retains activity within 320 characters');
      const visible = line && line.match(/related: (.*)$/);
      const entries = visible ? visible[1].split(',') : [];
      ok(entries.every(entry => relatedIds.some(id => entry === id + '(relatedSessionId)')), locale + ' every shown related ID is complete and uses primary reason');
      ok(entries.length <= 1 && (locale !== 'zh-CN' || entries.length === 1), locale + ' related entries that do not fit are omitted whole');
    }
    const roomy = s.stewardOverviewBlock([{ ...crowded[0], digest: { ...crowded[0].digest, recentUserRequest: null } }], s.getPromptPack('en-US'));
    ok(relatedIds.every(id => roomy.includes(id + '(relatedSessionId)')), 'two whole related IDs remain readable when budget permits');
    for (const locale of ['zh-CN', 'en-US']) {
      const overview = s.stewardOverviewBlock(rows, s.getPromptPack(locale));
      ok(overview.includes('B_TARGET') && (locale !== 'en-US' || overview.includes('Recent request:')), locale + ' overview exposes current activity and localized label');
      ok(!overview.includes(secret), locale + ' overview redacts recent user secrets');
    }
    const search = await s.stewardImplThreadsSearch({ q: 'B_TARGET' }, { session: { id: 'steward-test' } }, { runtimeSessionSearchIndexV1: false });
    ok(search.results.some(row => row.sessionId === session.id && row.recentUserRequest.text.includes('B_TARGET')), 'cross-thread search finds latest request even with original title A');
    ok(!JSON.stringify(search.results.map(row => row.recentUserRequest)).includes(secret), 'search recent evidence is redacted');
    const read = await s.stewardImplThreadRead({ sessionId: session.id, tail: 2 }, { session: { id: 'steward-test', turnSeq: 1 } }, {});
    ok(read.ok && read.recentUserRequest && read.recentUserRequest.text.includes('B_TARGET'), 'cross-thread deep read exposes latest request');
    ok(!JSON.stringify(read.recentUserRequest).includes(secret), 'deep read recent evidence is redacted');
    const rewind = await s.rewindSession(session.id, 2, false);
    ok(rewind.ok, 'actual rewind removes second turn');
    const reverted = (await s.listSessions()).find(row => row.id === session.id);
    ok(reverted.recentUserRequest.text === 'Start A', 'surviving message tail rebuilds recent request after rewind');
    ok(s.sessionMeta({ id: 'bounded', messages: [{ role: 'user', content: 'B'.repeat(1000) }] }).recentUserRequest.text.length === 240, 'recent activity metadata stays bounded');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { fs.rmSync(taskHome, { recursive: true, force: true }); t.done(); }
})();
