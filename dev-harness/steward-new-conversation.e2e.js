'use strict';
require('./lib/self-isolate-home.js');
const fs = require('fs'), os = require('os'), path = require('path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { startFakeAnthropic, messageEvents } = require('./lib/fake-anthropic-provider');
const run = createRunner('STEWARD NEW CONVERSATION');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-new-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-new-work-'));
fs.writeFileSync(path.join(work, 'external.txt'), 'external content');
const configPath = path.join(root, 'config.json');
const reply = say => JSON.stringify({ say, why: 'test', acts: [], actions: [] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fake, anthFake, srv, cfg, phase = 'openai', firstTool = false, toolStage = 0, targetId = '';
const anthropicRequests = [];
(async () => {
  try {
    fake = await startFakeProvider({
      handler(req) {
        // Strict gateways reject internal protocol metadata on chat messages.
        if (req.messages.some(m => m.providerBlocks)) return { status: 400, json: { error: { message: 'unknown field providerBlocks' } } };
        if (phase === 'openai' && !firstTool) { firstTool = true; return toolCallFrames('steward_threads_search', { q: 'test' }, 'call.with:punctuation'); }
        if (phase === 'tainted' && toolStage++ === 0) return toolCallFrames('steward_file_read', { path: path.join(work, 'external.txt') }, 'call_read_external');
        if (phase === 'tainted' && toolStage === 2) return toolCallFrames('steward_thread_continue', { sessionId: targetId, message: 'blocked relay' }, 'call_blocked_write');
        if (phase === 'fresh-write' && toolStage++ === 0) return toolCallFrames('steward_thread_continue', { sessionId: targetId, message: 'new clean relay' }, 'call_clean_write');
        if (phase === 'slow') return new Promise(resolve => setTimeout(() => resolve(textFrames(reply('old reply'))), 600));
        return textFrames(reply('reply ' + phase));
      },
    });
    anthFake = await startFakeAnthropic({ handler(req) {
      anthropicRequests.push(req.body);
      return messageEvents(anthropicRequests.length === 1
        ? { model: 'm', thinking: 'test thinking', signature: 'sig', toolUses: [{ id: 'toolu_anthropic', name: 'steward_threads_search', input: { q: 'test' } }] }
        : { model: 'm', text: reply('reply anthropic') });
    } });
    cfg = { configSchema: 7, activeProvider: 'open', engineMode: 'interactive', permissionMode: 'default', includeWorkbenchMcp: false,
      defaultWorkspace: work, recentWorkspaces: [work], workspaces: [{ path: work, label: 'test', read: true }], subagentMaxPerTurn: 0, desktopMcp: { enabled: false, autodetect: false },
      killOnDisconnect: false, locale: 'zh-CN', stewardEnabledV1: true, stewardPollMs: 5000, stewardReadBudgetChars: 4000,
      stewardMaxTurnsPerHour: 500, stewardMaxCostPerDay: 0, stewardGlobalMaxTurnsPerHour: 2000, stewardProviderId: 'open', stewardModel: 'm',
      stewardThreadBriefV1: false, stewardConversationRetention: 'forever', runtimeSessionNotesInjectV1: true,
      providers: [{ id: 'open', label: 'Open', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'm' },
        { id: 'anth', label: 'Anth', type: 'openai-compat', apiStyle: 'anthropic', baseUrl: anthFake.url, apiKey: 'k', model: 'm' }] };
    const write = () => fs.writeFileSync(configPath, JSON.stringify(cfg)); write();
    srv = require('../ruyi-workbench/app/server.js');
    const send = message => srv.runStewardTurn({ trigger: 'user', message, onEvent: () => {} });
    run.ok((await send('open first')).ok === true, 'OpenAI steward turn executes a tool');
    phase = 'anthropic'; cfg.stewardProviderId = 'anth'; write();
    const anth = await send('switch to anthropic');
    run.ok(anth.ok === true && anthropicRequests.length >= 2, 'same steward session switches to Anthropic and executes tools');
    const blocks = anthropicRequests[0]?.messages.flatMap(m => m.content) || [];
    const use = blocks.find(b => b.type === 'tool_use' && b.name === 'steward_threads_search');
    run.ok(use && /^[A-Za-z0-9_-]+$/.test(use.id) && blocks.some(b => b.type === 'tool_result' && b.tool_use_id === use.id), 'punctuated OpenAI tool ID remains paired in Anthropic request');
    phase = 'back'; cfg.stewardProviderId = 'open'; write();
    const back = await send('back to openai');
    run.ok(back.ok === true, 'Anthropic thinking/tool history switches back to strict OpenAI');
    const backBody = fake.requests.at(-1).body;
    run.ok(backBody.messages.some(m => m.tool_calls?.some(t => t.id === 'toolu_anthropic')) && backBody.messages.some(m => m.tool_call_id === 'toolu_anthropic'), 'Anthropic tool and result remain paired in OpenAI');
    run.ok(!backBody.messages.some(m => m.providerBlocks), 'internal Anthropic blocks never leak onto OpenAI wire');

    // Reset must clear real context, including sidecar notes, and reject stale saves.
    await srv.writeSessionNotes('steward', '# Session Notes\n\n## 已确认的决定\nOLD_CONTEXT_SENTINEL\n\n## 未完成事项\n无\n\n## 关键文件与上下文\n无');
    const other = await srv.createSession({ title: 'keep other', cwd: work });
    targetId = other.id;
    other.messages = [{ role: 'user', content: '报告都给我写成中文', turnSeq: 1, createdAt: new Date().toISOString() }]; other.turnSeq = 1;
    await srv.saveSession(other);
    const memory = await srv.toolCall('steward_memory_write', { kind: 'preference', text: '报告都给我写成中文', sourceRef: { sessionId: other.id, turnSeq: 1, quote: '报告都给我写成中文' } }, { session: await srv.loadSession('steward'), trigger: 'user' });
    run.ok(memory.ok === true, 'long-term memory is created through normal tool gate');
    const memoryFile = path.join(root, 'steward', 'memory-v1.json'); const memoryBefore = fs.readFileSync(memoryFile, 'utf8');
    phase = 'tainted'; toolStage = 0;
    await send('read external then rename');
    const taintedSession = await srv.loadSession('steward');
    const taintedCalls = taintedSession.messages.filter(m => m.role === 'assistant').flatMap(m => m.toolCalls || []);
    const blocked = taintedCalls.find(c => c.id === 'call_blocked_write');
    run.ok(blocked?.result?.error === 'propose_required' && blocked.result.reason === 'steward_turn_tainted', 'external read blocks same-turn write through normal tool gate');
    run.ok((await srv.loadSession(other.id)).title === 'keep other', 'tainted write preserves target thread');
    const old = await srv.loadSession('steward'); const oldSeq = old.turnSeq;
    phase = 'slow'; const seen = fake.requests.length;
    const active = send('old active');
    for (let i = 0; i < 100 && fake.requests.length === seen; i++) await sleep(10);
    run.ok(JSON.stringify(fake.requests.at(-1).body).includes('OLD_CONTEXT_SENTINEL'), 'old sidecar notes are actually injected before reset');
    const queued = send('old queued'); const queued2 = send('old queued second'); await sleep(30);
    const reset = await srv.stewardResetConversation();
    run.ok(reset.ok === true && reset.archive.archived > 0, 'reset archives even forever retention');
    run.ok((await active).ok === false && (await queued).error === 'steward.cancelled' && (await queued2).error === 'steward.cancelled', 'inflight and FIFO old user requests are cancelled');
    const clean = await srv.loadSession('steward');
    run.ok(clean.messages.length === 0 && clean.providerHistory.length === 0 && clean.summary === '', 'reset clears UI and model history plus summary');
    run.ok(clean.turnSeq >= oldSeq && clean.rewindGen > (old.rewindGen || 0), 'reset preserves monotonic turnSeq and advances rewind generation');
    const archived = JSON.parse(fs.readFileSync(path.join(root, 'steward', 'visits', reset.archive.file), 'utf8'));
    run.ok(archived.messages.length === reset.archive.archived && archived.messages.some(m => m.content === 'old active'), 'old chat is readable from archive before truncation');
    run.ok((await srv.loadSession(other.id)).title === 'keep other', 'other sessions are preserved');
    run.ok(fs.readFileSync(memoryFile, 'utf8') === memoryBefore, 'reset preserves long-term memory exactly');
    run.ok((await srv.readSessionNotes('steward')) === '', 'old compaction notes sidecar is cleared');
    await srv.saveSession(old);
    run.ok((await srv.loadSession('steward')).messages.length === 0, 'stale pre-reset save cannot restore old chat');
    phase = 'fresh'; run.ok((await send('new fresh')).ok === true, 'new conversation accepts fresh user turn');
    const freshWire = JSON.stringify(fake.requests.at(-1).body);
    run.ok(!freshWire.includes('old active') && !freshWire.includes('OLD_CONTEXT_SENTINEL') && !freshWire.includes('back to openai'), 'new provider request contains neither old chat nor sidecar notes');
    phase = 'fresh-write'; toolStage = 0; await send('rename in fresh conversation');
    run.ok((await srv.loadSession(other.id)).messages.some(m => m.role === 'user' && String(m.content).includes('new clean relay')), 'fresh model turn can write through normal gate without userPressed');
    for (const args of [{}, { sessionId: [], message: 'x' }, { sessionId: 'sess_x', message: '' }, { sessionId: 'sess_x', message: '  \t ' }, { sessionId: ' ', message: 'x' }]) {
      run.ok(srv.stewardParseReply(JSON.stringify({ say: 'x', why: 'x', acts: [{ kind: 'tool', tool: 'steward_thread_continue', args }], actions: [] })).acts.length === 0, 'malformed executable button is filtered before UI');
    }
  } catch (error) { run.fail(error.stack || error); }
  finally { srv?.stopStewardInbox(); await fake?.close(); await anthFake?.close(); fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); run.done(); }
})();
