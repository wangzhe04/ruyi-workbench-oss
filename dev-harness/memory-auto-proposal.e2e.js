'use strict';
// R4-S3: low-noise, model-decided memory candidate gates. Pure/offline regression coverage.
const path = require('path');
const srv = require(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));

const {
  memoryProposalPrefilter,
  parseMemoryProposalDecision,
  memoryProposalSimilarity,
  memoryProposalIsDuplicate,
} = srv;
let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label); }
};
const assistant = (content, extra = {}) => ({ role: 'assistant', content, turnSeq: 8, engine: 'openai', source: 'provider', exitCode: 0, ...extra });
const substantial = '已完成实现与验证。'.repeat(40);

const ordinary = memoryProposalPrefilter({ turnSeq: 8, messages: [
  { role: 'user', content: '帮我解释一下这个函数' },
  assistant(substantial),
] });
ok(ordinary.eligible === false && ordinary.reason === 'no_durable_signal', 'ordinary Q&A is filtered before any model call');

const preference = memoryProposalPrefilter({ turnSeq: 8, messages: [
  { role: 'user', content: '以后所有外部链接默认都用系统浏览器打开，不要覆盖工作台。' },
  assistant(substantial, { turnSummary: { filesChanged: [{ path: 'desktop.cs' }], commands: 1 } }),
] });
ok(preference.eligible === true && preference.durablePreference === true, 'durable preference reaches the model judge');

const convention = memoryProposalPrefilter({ turnSeq: 8, messages: [
  { role: 'user', content: '项目规范统一使用 src 作为真源，生成文件不得手改。' },
  assistant(substantial, { turnSummary: { filesChanged: [{ path: 'build.js' }] } }),
] });
ok(convention.eligible === true && convention.convention === true, 'confirmed project convention reaches the model judge');

const conventionWithoutToolActivity = memoryProposalPrefilter({ turnSeq: 8, messages: [
  { role: 'user', content: 'Project convention: generated files are never edited directly.' },
  assistant('This is now a confirmed project rule. '.repeat(7)),
] });
ok(conventionWithoutToolActivity.eligible === true && conventionWithoutToolActivity.score === 4, 'one strong convention plus a substantive answer now reaches the judge without requiring file or command activity');

const explicitShort = memoryProposalPrefilter({ turnSeq: 8, messages: [
  { role: 'user', content: 'Remember this preference: keep final answers concise.' },
  assistant('I will submit that as a memory candidate for your confirmation.'),
] });
ok(explicitShort.eligible === true && explicitShort.explicit === true, 'explicit remember requests are not lost merely because the final acknowledgement is short');

const failed = memoryProposalPrefilter({ turnSeq: 8, messages: [
  { role: 'user', content: '以后默认这样做' },
  assistant(substantial, { exitCode: 1 }),
] });
ok(failed.eligible === false && failed.reason === 'failed_turn', 'failed turns never produce candidates');

ok(parseMemoryProposalDecision('{"decision":"none","reason":"temporary"}') === null, 'model none decision stays silent');
ok(parseMemoryProposalDecision('{"decision":"propose","confidence":0.7,"durability":"durable","name":"n","description":"d","type":"lesson","scope":"project","body":"b"}') === null, 'low-confidence model proposal is rejected');
ok(parseMemoryProposalDecision('{"decision":"propose","confidence":0.83,"durability":"durable","name":"n","description":"d","type":"lesson","scope":"project","body":"b"}') !== null, 'moderately high-confidence durable proposal now passes the relaxed review threshold');
const parsed = parseMemoryProposalDecision(JSON.stringify({
  decision: 'propose', confidence: 0.93, durability: 'durable',
  name: '外链使用系统浏览器', description: '桌面端渲染回答链接时适用', type: 'convention', scope: 'project',
  body: '外部链接交给系统默认浏览器，工作台只保留可返回的兜底。', reason: '这是稳定的桌面交互约定',
}));
ok(parsed && parsed.scope === 'project' && parsed.type === 'convention', 'high-confidence durable proposal is normalized');

ok(memoryProposalSimilarity('外部链接使用系统默认浏览器', '系统默认浏览器打开外部链接') >= 0.72, 'semantic term overlap catches a close paraphrase');
ok(memoryProposalIsDuplicate(parsed, [{ name: '外链使用系统浏览器', description: '桌面端渲染回答链接时适用' }], { history: [] }) === true, 'existing registry duplicate suppresses the card');
ok(memoryProposalIsDuplicate(parsed, [], { history: [{ summary: '外链使用系统浏览器 桌面端渲染回答链接时适用' }] }) === true, 'previously decided semantic duplicate suppresses repeat cards');

const fs = require('fs');
const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'src', '07-autonomy.js'), 'utf8');
const uiSource = fs.readFileSync(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'js', 'chat-stream-runtime.js'), 'utf8');
const memoryUiSource = fs.readFileSync(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'js', 'skills-memory.js'), 'utf8');
ok(/MEMORY_PROPOSAL_MIN_TURN_GAP\s*=\s*3/.test(serverSource), 'non-explicit suggestions have a three-turn cooldown');
ok(/latestAssistant\.engine\s*!==\s*'openai'/.test(serverSource) && /latestAssistant\.providerId/.test(serverSource), 'judge is pinned to the provider that produced the turn');
ok(/activeChildren\.has/.test(serverSource) && /reason: 'turn_active'/.test(serverSource), 'a new active turn suppresses stale proposal evaluation');
ok(/reason: latestSession \? 'conversation_advanced' : 'session_deleted'/.test(serverSource), 'a completed newer turn or deleted session also discards an in-flight candidate');
ok(!/turnState\.engine\s*===\s*'openai'/.test(uiSource) && /resultOk\s*===\s*true/.test(uiSource) && /suggestMemoryFromTurn/.test(uiSource), 'UI requests pending candidates after a clean turn from either engine');
ok(/proposal:null/.test(memoryUiSource) && /_isDraft:\s*true/.test(memoryUiSource), 'silent no-proposal path and edit-before-save path are both explicit');
const providerSource = fs.readFileSync(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'src', '06-provider-engine.js'), 'utf8');
ok(/responseInstructions/.test(providerSource) && /extraInstructions/.test(providerSource), 'Responses auxiliary calls retain strict system/developer judge instructions');

console.log('\nMEMORY AUTO PROPOSAL E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exit(failures ? 1 : 0);
