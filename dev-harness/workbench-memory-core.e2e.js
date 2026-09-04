'use strict';
// Workbench Memory is the sole model-facing memory surface: ACC import, native tools, and prompt wiring.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-core-'));
const DATA = path.join(ROOT, 'workbench');
const LOCAL = path.join(ROOT, 'localappdata');
fs.mkdirSync(path.join(LOCAL, 'ai-computer-control', 'data'), { recursive: true });
fs.writeFileSync(path.join(LOCAL, 'ai-computer-control', 'data', 'memory.json'), JSON.stringify({ entries: {
  'preferred-output': { content: 'Keep final answers concise.', tags: 'preference,format', updated: '2026-08-01T00:00:00Z' },
} }), 'utf8');
process.env.WIN_CLAUDE_WORKBENCH_HOME = DATA;
process.env.LOCALAPPDATA = LOCAL;

const S = require(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));
let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label); }
};

(async () => {
  const migrated = await S.migrateLegacyAccMemory();
  ok(migrated.ok && migrated.imported === 1 && S.legacyAccMemoryMigrationComplete(), 'legacy ACC memory imports once and records completion');
  const migratedAgain = await S.migrateLegacyAccMemory();
  ok(migratedAgain.ok && migratedAgain.alreadyDone === true, 'ACC import is idempotent');
  const bridged = S.resolveExternalMcpServers({
    desktopMcp: { enabled: true, command: process.execPath, args: ['fake-acc.js'] }, browserAutomation: {}, externalMcpServers: [], enableMcpDropIn: false,
  });
  const accBridge = bridged.find(x => x.id === 'ai-computer-control');
  ok(accBridge && accBridge.env && accBridge.env.ACC_HIDE_MEMORY === '1', 'completed migration hides ACC memory tools on the actual bridge configuration');

  const cfg = { defaultWorkspace: path.join(ROOT, 'workspace') };
  fs.mkdirSync(cfg.defaultWorkspace, { recursive: true });
  const listed = await S.listWorkbenchMemories({ query: 'concise output' }, { config: cfg, workingDir: cfg.defaultWorkspace });
  ok(listed.ok && listed.memories.length === 1 && listed.memories[0].scope === 'global', 'workbench_memory_list discovers imported global memory');
  const read = await S.readWorkbenchMemory({ id: listed.memories[0].id, scope: 'global' }, { config: cfg, workingDir: cfg.defaultWorkspace });
  ok(read.ok && /Keep final answers concise/.test(read.memory.body) && /ACC Memory/.test(read.memory.body), 'workbench_memory_read returns content and import provenance');

  // Core memory is a protected prompt-residency layer, not a destructive second store.
  const savedCore = [];
  for (let i = 0; i < 18; i++) {
    const saved = await S.saveMemory({ id: 'core-' + i, scope: 'project', type: i === 1 ? 'preference' : 'reference',
      name: 'Core fixture ' + i, description: 'Core fixture for protected LRU ' + i, core: true,
      importance: i === 0 ? 'important' : 'normal', coreSummary: ('Reusable rule ' + i + ' ').repeat(24),
      reviewAfter: i === 2 ? '2020-01-01' : '', expiresAt: i === 3 ? '2020-01-01' : '',
      body: 'Full source memory body ' + i }, cfg.defaultWorkspace);
    savedCore.push(saved.memory);
  }
  // Make the important item artificially old: importance protection must still beat fresh ordinary references.
  const importantFile = savedCore[0].file;
  fs.writeFileSync(importantFile, fs.readFileSync(importantFile, 'utf8').replace(/^updatedAt: .*$/m, 'updatedAt: 2010-01-01T00:00:00.000Z'), 'utf8');
  const coreState = await S.resolveCoreMemoryState(cfg.defaultWorkspace);
  const important = coreState.all.find(m => m.id === 'core-0');
  const expired = coreState.all.find(m => m.id === 'core-3');
  const reviewDue = coreState.all.find(m => m.id === 'core-2');
  // 2026-09-04: 席位数与字符预算从模块常量改为可配(默认 200 条 / 16000 字)。断言改成两条:
  //   ① 默认预算下 18 条夹具应全部入席(这正是抬上限的目的 —— 旧的 4200 字只能装下一半);
  //   ② 显式给一个窄预算时,超出部分仍只进候补、不删源文件。
  // 两条合起来既验了新容量,又保住了受保护 LRU 本身的回归覆盖。
  // 18 条夹具里有一条(core-3)已过期 —— 过期条目不进候选,所以满额是 17。
  ok(coreState.stats.active === 17 && coreState.stats.standby === 0
    && coreState.stats.itemLimit === 200 && coreState.stats.charLimit === 16000,
    'widened capsule (200 items / 16000 chars) admits all 17 non-expired core fixtures (active '
      + coreState.stats.active + ', standby ' + coreState.stats.standby + ')');
  const narrow = await S.resolveCoreMemoryState(cfg.defaultWorkspace, null, { coreMemoryCharBudgetV1: 4200 });
  ok(narrow.stats.charLimit === 4200 && narrow.stats.charsUsed <= 4200 && narrow.stats.standby > 0,
    'an explicit narrow character budget still forces standby overflow (protected LRU intact)');
  ok(important && important.coreStatus === 'active', 'an old important memory keeps an active core slot ahead of fresh ordinary entries');
  ok(expired && expired.coreStatus === 'expired' && !coreState.active.some(m => m.id === expired.id), 'expired memory remains visible but is not injected');
  ok(reviewDue && reviewDue.reviewDue === true && reviewDue.coreStatus !== 'expired', 'review date is exposed without auto-expiring the memory');
  const projectMemoryFiles = fs.readdirSync(path.dirname(importantFile)).filter(name => name.endsWith('.md'));
  ok(projectMemoryFiles.length === 18, 'LRU standby never deletes or replaces source memory files');
  const corePrompt = S.buildCoreMemoryPromptSection(coreState.active, { locale: 'zh-CN' });
  ok(/<workbench-memory-core>/.test(corePrompt) && /受保护 LRU/.test(corePrompt), 'core summaries have a dedicated directly-loaded prompt fence');
  const preflight = await S.resolveMemoryPreflight({ memoriesExplicit: false, memoryExclusions: [] }, cfg.defaultWorkspace, 'unrelated request');
  ok(preflight.coreEntries.length > 0 && preflight.status.coreActiveCount === preflight.coreEntries.length, 'preflight reports and injects active core summaries separately from relevance matches');
  const afterUse = await S.resolveCoreMemoryState(cfg.defaultWorkspace);
  const preferenceUse = afterUse.all.find(m => m.id === 'core-1');
  ok(preferenceUse && preferenceUse.useCount >= 1 && preferenceUse.lastUsedAt, 'an injected core preference/rule counts as use (daily write-throttled)');

  const session = await S.createSession({ title: 'memory arbitration', cwd: cfg.defaultWorkspace });
  session.turnSeq = 3;
  session.messages = [
    { role: 'user', content: 'Remember for this project: generated files must never be edited directly.' },
    { role: 'assistant', content: 'I will submit this stable project convention as a memory candidate for your review.', turnSeq: 3, engine: 'openai', source: 'provider', exitCode: 0 },
  ];
  await S.saveSession(session);
  const proposed = await S.proposeWorkbenchMemory({
    name: 'Do not edit generated files', description: 'Use whenever changing generated application artifacts.',
    type: 'convention', scope: 'project', body: 'Edit source modules, then rebuild generated artifacts.',
    reason: 'This is a stable project convention that prevents drift.',
  }, { sessionId: session.id, turnSeq: session.turnSeq, session, config: cfg, workingDir: cfg.defaultWorkspace });
  ok(proposed.ok && proposed.pendingUserConfirmation === true, 'workbench_memory_propose creates a pending user-confirmed candidate');
  const proposedAgain = await S.proposeWorkbenchMemory({
    name: 'Different candidate must lose', description: 'A second candidate in the same turn.', type: 'lesson', scope: 'project',
    body: 'This body must not replace the first candidate.', reason: 'Regression fixture for single-slot arbitration.',
  }, { sessionId: session.id, turnSeq: session.turnSeq, session, config: cfg, workingDir: cfg.defaultWorkspace });
  ok(proposedAgain.ok && proposedAgain.alreadyPending === true && proposedAgain.proposalId === proposed.proposalId
    && proposedAgain.proposal.name === proposed.proposal.name, 'a second model proposal in the same turn reuses the first candidate instead of replacing it');
  const autoAfterTool = await S.proposeMemoryFromSession(session.id);
  ok(autoAfterTool.ok && autoAfterTool.replayed === true && autoAfterTool.reason === 'tool_proposal'
    && autoAfterTool.proposalId === proposed.proposalId, 'automatic proposal rules replay a same-turn tool candidate and do not run a second proposal path');
  const autoFirstSession = await S.createSession({ title: 'automatic first arbitration', cwd: cfg.defaultWorkspace });
  autoFirstSession.turnSeq = 4;
  autoFirstSession.messages = [{ role: 'user', content: 'Use this fixture to verify first-writer arbitration.' }];
  const autoFirstProposal = { name: 'Automatic candidate wins', description: 'Regression fixture.', type: 'lesson', scope: 'project',
    body: 'Keep the first candidate generated in one turn.', reason: 'Tests the reverse proposal ordering.', sourceSessionId: autoFirstSession.id, sourceTurnSeq: 4 };
  const proposalDir = path.join(DATA, 'memory', 'proposals');
  fs.mkdirSync(proposalDir, { recursive: true });
  fs.writeFileSync(path.join(proposalDir, autoFirstSession.id + '.json'), JSON.stringify({ schema: 1, lastEvaluatedTurn: 4, lastShownTurn: 4,
    current: { id: 'proposal-auto-first', status: 'pending', source: 'automatic', semanticKey: 'auto-first', summary: 'Automatic candidate wins', proposal: autoFirstProposal, createdAt: new Date().toISOString() }, history: [] }), 'utf8');
  const toolAfterAuto = await S.proposeWorkbenchMemory({
    name: 'Tool candidate must lose', description: 'Second source in the same turn.', type: 'convention', scope: 'project',
    body: 'Do not replace the automatic candidate.', reason: 'Reverse-order arbitration regression.',
  }, { sessionId: autoFirstSession.id, turnSeq: 4, session: autoFirstSession, config: cfg, workingDir: cfg.defaultWorkspace });
  ok(toolAfterAuto.ok && toolAfterAuto.alreadyPending === true && toolAfterAuto.source === 'automatic'
    && toolAfterAuto.proposalId === 'proposal-auto-first', 'a model tool call cannot replace an automatic candidate already created in the same turn');
  const projectDir = path.join(DATA, 'memory', 'project');
  const projectMarkdown = fs.existsSync(projectDir) ? fs.readdirSync(projectDir, { recursive: true }).filter(x => String(x).endsWith('.md')) : [];
  ok(projectMarkdown.length === 18, 'propose never writes an additional confirmed memory before user approval');

  const tools = S.buildOpenAiTools({ allowCommandTools: true, allowDesktopTools: true, subagentMaxPerTurn: 0 }, null, {});
  const toolNames = new Set(tools.map(t => t.function && t.function.name));
  ok(['workbench_memory_list', 'workbench_memory_read', 'workbench_memory_propose'].every(n => toolNames.has(n)), 'all three Workbench Memory tools are in the provider core surface');
  ok(!['memory_save', 'memory_read', 'memory_list', 'memory_delete'].some(n => toolNames.has(n)), 'ACC memory tools are not native Workbench tools');

  const providerSource = fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'src', '06-provider-engine.js'), 'utf8');
  const claudeSource = fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'src', '05-claude-engine.js'), 'utf8');
  const accSource = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'ai-computer-control', 'src', 'ai_computer_control', 'server.py'), 'utf8');
  ok(/memoryCoreGuide/.test(providerSource) && /memoryCoreGuide/.test(claudeSource), 'both engines inject the Workbench Memory core protocol');
  ok(/ACC_HIDE_MEMORY/.test(accSource), 'ACC can suppress its legacy memory module after migration');

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('\nWORKBENCH MEMORY CORE E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
