'use strict';

// Load the frozen service and exercise its tool handlers in an owned synthetic session.
require('../lib/self-isolate-home');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

const [rootArg, expected, receiptArg] = process.argv.slice(2);
assert.ok(rootArg && /^[a-f0-9]{64}$/.test(expected || '') && receiptArg,
  'Usage: node memory-package-walkthrough.cjs <extracted package> <server SHA-256> <new receipt>');
const root = path.resolve(rootArg);
const output = path.resolve(receiptArg);
assert.equal(fs.existsSync(output), false);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const service = path.join(root, 'app/server.js');
const bytes = fs.readFileSync(service);
assert.equal(hash(bytes), expected);
const nodePin = hash(fs.readFileSync(path.join(root, 'runtime/node/node.exe')));
assert.equal(hash(fs.readFileSync(process.execPath)), nodePin, 'Run with the package Node runtime');

for (const key of [
  'RUYI_SEMANTIC_RUNTIME_ROOT', 'RUYI_SEMANTIC_BACKEND', 'RUYI_SEMANTIC_MODEL',
  'RUYI_SEMANTIC_GEMMA2_ROOT', 'RUYI_SEMANTIC_GEMMA2_LOCK_SHA256',
]) delete process.env[key];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-package-memory-'));
Object.assign(process.env, {
  RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_DISABLE_SEMANTIC: '0',
  HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
});
const config = {
  configSchema: 14, permissionMode: 'bypass', semanticRetrievalV1: true,
  runtimeMemoryVectorRecallV1: true, privacyModeV1: 'off', autoImportClaudeCodeMcp: false,
};
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config), {flag:'wx'});

const mod = new Module(service, module);
mod.filename = service;
mod.paths = Module._nodeModulePaths(path.dirname(service));
mod._compile(bytes.toString() + '\nmodule.exports.fixturePorts={activeChildren,loadMemoryRegistry,memoryExplicitRetrievalText,resolveMemoryPreflight,buildMemoryTurnSection,buildMemoryPromptSection,rankMemoriesForRecallDetailed,descriptor:()=>SemanticRuntimeHooks.descriptor(),stats:()=>SemanticRuntimeHooks.stats(),shutdown:()=>SemanticRuntimeHooks.shutdown()};', service);
const srv = mod.exports;
const ports = srv.fixturePorts;
const report = {serviceSha256:expected, nodeSha256:nodePin, status:'FAIL', lists:[]};

async function main() {
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  async function save(id, name, extra = {}) {
    const result = await srv.saveMemory({
      id, name, scope:'project', type:'reference', description:'', body:'Synthetic memory.', ...extra,
    }, project);
    assert.equal(result.ok, true, id);
  }
  await save('vehicle-target', '载具上下车', {
    description:'顺序安排。上车握住扶手并依次站立，下车依序等候。',
    body:'等待车辆停稳，随后依序使用车门。SYNTHETIC_VEHICLE_BODY',
  });
  await save('vehicle-antipattern', '小汽车驾驶');
  await save('hidden-body-only', '白板序号', {body:'记录公共交通工具停稳以后应从车门依序进出。'});
  await save('irrelevant-meeting', '会议室签到与归档');
  await save('ordinary-rule', 'Deploying', {type:'convention',description:'Deploying'});
  await save('active-core', '固定记录规则', {type:'preference',core:true,description:'以匿名编号记录。',coreSummary:'以匿名编号记录。'});
  await save('inspection-main', 'Deployment release checklist', {description:'Record a release approval.'});
  await save('inspection-side', 'Deployment incident guide', {description:'Record incident contacts.'});
  for (let n=0;n<71;n++) await save('calendar-note-'+n, '会议签到记录 '+n);
  const ordered = await ports.loadMemoryRegistry(project);
  report.targetPosition = ordered.findIndex(entry=>entry.id==='vehicle-target') + 1;
  report.candidateHeaders = ordered.length;
  assert.equal(ordered.length, 79);
  assert.ok(report.targetPosition > 70);
  const bodyOnly = ordered.find(entry=>entry.id==='hidden-body-only');
  const headerText = ports.memoryExplicitRetrievalText(bodyOnly);
  assert.match(headerText, /白板序号/);
  assert.doesNotMatch(headerText, /公共交通工具|停稳|进出/);

  const session = await srv.createSession({title:'Anonymous package validation',cwd:project});
  session.turnSeq = 1;
  ports.activeChildren.set(session.id, {state:'running',session});
  const ctx = {session,sessionId:session.id,workingDir:project,turnSeq:1,config};
  async function search(label, query, firstOnly=false) {
    for (let attempt=1;attempt<=24;attempt++) {
      const started = performance.now();
      const reply = await srv.toolCall('workbench_memory_list', {query,limit:20}, ctx);
      assert.equal(reply.ok, true);
      assert.equal(reply.matchedCount+reply.ruleFillCount, reply.count);
      const rows = reply.memories.map(entry=>({id:entry.id,kind:entry.retrieval?.kind,score:entry.retrieval?.semanticScore,core:entry.coreStatus}));
      assert.equal(rows.filter(entry=>entry.kind==='rule-fill').length, reply.ruleFillCount);
      assert.equal(new Set(rows.map(entry=>entry.id)).size, rows.length);
      assert.doesNotMatch(JSON.stringify(reply), /SYNTHETIC_VEHICLE_BODY/);
      report.lists.push({label,attempt,elapsedMs:performance.now()-started,semantic:reply.semantic,rows,
        matchedCount:reply.matchedCount,ruleFillCount:reply.ruleFillCount});
      if (firstOnly) return rows;
      if (reply.semantic?.coverage?.complete) return rows;
      assert.equal(reply.semantic?.coverage?.canContinue, true, label);
      await delay(100);
    }
    assert.fail(label+' did not complete in 24 identical calls');
  }

  const coldKeyword = await search('cold-keyword', '载具上下车', true);
  assert.equal(coldKeyword.find(entry=>entry.id==='vehicle-target')?.kind, 'lexical');
  assert.ok(report.lists.at(-1).matchedCount>0);
  assert.ok(report.lists.at(-1).semantic?.fallback?.reason, 'Cold keyword search exposed its semantic fallback');
  const oneWord = await search('single-word', '大巴');
  report.singleWordTarget = oneWord.find(entry=>entry.id==='vehicle-target') || null;
  report.ambiguity = oneWord.filter(entry=>['vehicle-antipattern','hidden-body-only','irrelevant-meeting'].includes(entry.id));
  const question = await search('natural-question', '换乘客运车辆应该从哪边登乘');
  assert.equal(question.find(entry=>entry.id==='vehicle-target')?.kind, 'semantic');
  const lexical = await search('same-word-control', '载具上下车');
  assert.equal(lexical.find(entry=>entry.id==='vehicle-target')?.kind, 'lexical');
  const unrelated = await search('unrelated', 'sulfur molecular spectroscopy');
  report.unrelatedMatches = unrelated.filter(entry=>entry.kind!=='rule-fill');
  assert.ok(!report.unrelatedMatches.some(entry=>entry.id==='vehicle-target'));
  const read = await srv.toolCall('workbench_memory_read', {id:'vehicle-target',scope:'project'}, ctx);
  assert.equal(read.ok, true);
  assert.match(JSON.stringify(read), /SYNTHETIC_VEHICLE_BODY/);
  report.authorizedRead = true;

  const auto = await ports.resolveMemoryPreflight(session,project,'大巴',null,config);
  assert.equal(auto.status.matchCount, 0);
  assert.equal(auto.status.ruleFillCount, 1);
  assert.equal(auto.status.semantic.automaticCandidates, false);
  assert.deepEqual(auto.entries.map(entry=>entry.id), ['ordinary-rule']);
  assert.deepEqual(auto.coreEntries.map(entry=>entry.id), ['active-core']);
  const prompt = ports.buildMemoryTurnSection(auto.entries,'openai',config,null,auto.status);
  assert.match(prompt, /rule-fill="1"/);
  assert.doesNotMatch(prompt, /vehicle-target/);
  report.automatic = {status:auto.status, core:auto.coreEntries.map(entry=>entry.id), fill:auto.entries.map(entry=>entry.id)};
  const corePrompt = ports.buildMemoryPromptSection(auto.coreEntries,'openai',config,null,{part:'core'});
  assert.match(corePrompt, /固定记录规则/);
  assert.doesNotMatch(prompt, /固定记录规则/);

  const rankQuery = 'deployment';
  const before = ports.stats().backend;
  const baseline = ports.rankMemoriesForRecallDetailed(
    ordered.filter(entry=>entry.id!=='active-core'),rankQuery,8,config).entries.map(entry=>entry.id);
  const attempts = [];
  for (let attempt=1;attempt<=5;attempt++) {
    const started = performance.now();
    const reranked = await ports.resolveMemoryPreflight(session,project,rankQuery,null,config);
    const rankIds = reranked.entries.map(entry=>entry.id);
    const rankPrompt = ports.buildMemoryTurnSection(reranked.entries,'openai',config,null,reranked.status);
    const promptOrder = Array.from(rankPrompt.matchAll(/\[([a-z-]+)\]\(project\)/g), match=>match[1]);
    attempts.push({status:reranked.status,actualOrder:rankIds,promptOrder,
      elapsedMs:performance.now()-started,traceInPrompt:rankPrompt.includes('reranked')});
    assert.equal(reranked.status.matchCount, 2);
    assert.equal(reranked.status.ruleFillCount, 1);
    assert.deepEqual(new Set(rankIds),new Set(['inspection-main','inspection-side','ordinary-rule']));
    assert.deepEqual(promptOrder,rankIds);
    if (reranked.status.semantic?.status === 'reranked') {
      assert.equal(reranked.status.semantic.candidateCount, 2);
      break;
    }
    assert.deepEqual(rankIds,baseline);
  }
  const after = ports.stats().backend;
  report.automaticRerank = {baselineOrder:baseline,attempts,
    actualWorkerRequests:after.requests-before.requests,documentTexts:after.documentTexts-before.documentTexts};
  assert.equal(attempts.at(-1).status.semantic?.status, 'reranked');
  assert.ok(report.automaticRerank.documentTexts>=2);
  report.model = ports.descriptor();
  const runtimeLock = JSON.parse(fs.readFileSync(path.join(root, 'semantic-runtime/models.lock.json'), 'utf8'));
  assert.equal(report.model.modelId, runtimeLock.defaultModel);
  assert.equal(report.model.retrievalThresholds.automatic, null);
  assert.equal(hash(fs.readFileSync(service)), expected);
  report.status = 'PASS';
}

(async()=>{
  try { await main(); }
  catch (error) { report.error=String(error.stack); process.exitCode=1; }
  finally {
    report.shutdown=await ports.shutdown();
    fs.writeFileSync(output, JSON.stringify(report,null,2)+'\n', {flag:'wx'});
    console.log(JSON.stringify({output,status:report.status,error:report.error}));
  }
})();
