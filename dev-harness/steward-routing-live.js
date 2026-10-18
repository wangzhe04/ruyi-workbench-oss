'use strict';
// Opt-in, bounded first-response cohort. No tools execute; credentials never enter fixtures or output.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), cp = require('child_process'), vm = require('vm');
const { readLocalConfig } = require('./lib/local-provider-key');
const source = readLocalConfig(), provider = source.config?.providers?.find(p => p.apiKey && /deepseek/i.test([p.label, p.baseUrl, p.model].join(' ')));
if (!provider) { console.log('SKIP configured DeepSeek unavailable'); process.exit(0); }
const hash = value => crypto.createHash('sha256').update(value).digest('hex'), originalHash = hash(fs.readFileSync(source.file));
require('./lib/self-isolate-home');
const { createRunner } = require('./lib/harness'), { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('STEWARD ROUTING LIVE'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-routing-live-'));
process.env.RUYI_HOME = root; process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const s = loadServerInternals(['getPromptPack', 'buildOpenAiTools', 'defaultConfig', 'providerWireProtocol']);
const wire = s.providerWireProtocol(provider), model = provider.model;
const oldSource = cp.execFileSync('git', ['show', '256f0cc3:ruyi-workbench/app/src/06b-prompt-registry.js'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
const old = vm.runInNewContext(oldSource + '\n;({zh:PROMPT_ZH.steward.stable,en:PROMPT_EN.steward.stable})', {});
const currentTools = s.buildOpenAiTools(s.defaultConfig(), null, { stewardSession: true });
const oldTools = structuredClone(currentTools);
oldTools.find(x => x.function.name === 'steward_thread_new').function.parameters.properties.brief.properties.userText.description = '用户原话,逐字。';
const variants = {
  baseline: { stable: old.zh, tools: oldTools },
  candidate: { stable: s.getPromptPack('zh-CN').steward.stable, tools: currentTools },
};
if (variants.baseline.stable === variants.candidate.stable) throw new Error('candidate prompt must differ from the frozen baseline');
const cases = [
  { id: 'status', question: '已有报告现在完成了吗？' },
  { id: 'material', question: '请看看 C:\\RoutingFixture\\material.txt 讲什么,解释统计口径即可。' },
  { id: 'report', question: '请独立核对a.txt、b.txt和c.txt的统计口径和矛盾,深入研究后写成完整report.md报告。' },
  { id: 'edit', question: '新任务:把 C:\\RoutingFixture\\material.txt 的收入从37万元改成40万元并保存。' },
  { id: 'followup', question: '请读已有报告交付的 C:\\RoutingFixture\\report.md 原件,解释刚才37万元结论的依据,无需继续修改。' },
];
const context = '已知工作区:C:\\RoutingFixture。线程总览:id=sess_existing_report;标题=已有报告;状态=done;已交付文件=C:\\RoutingFixture\\report.md。用户在场。材料尚未读取。';
const scrub = value => String(value || '').split(provider.apiKey).join('[REDACTED]');
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
function assess(c, decoded) {
  if (decoded.failed || decoded.incomplete || decoded.finishReason === 'length' || !decoded.text && !decoded.toolCalls?.length) return { unknown: true, strict: false };
  const object = parse(decoded.text), calls = (decoded.toolCalls || []).map(x => ({ tool: x.name, args: parse(x.rawArgs) }));
  const actions = [...calls, ...(Array.isArray(object?.actions) ? object.actions : [])];
  const paths = value => String(value || '').replace(/\\+/g, '/').toLowerCase();
  const delegated = actions.some(a => ['steward_thread_new', 'steward_quick_ask'].includes(a.tool));
  const readOnlyCase = ['status', 'material', 'followup'].includes(c.id);
  const allowedReads = ['steward_thread_status', 'steward_thread_read', 'steward_file_read', 'steward_thread_artifact_read'];
  let strict = false;
  if (c.id === 'status') strict = !delegated && (calls.some(a => ['steward_thread_status', 'steward_thread_read'].includes(a.tool) && a.args?.sessionId === 'sess_existing_report') || !actions.length && /完成|收工|done/.test(object?.say || decoded.text) && !/没完成|未完成|还没|尚未|正在/.test(object?.say || decoded.text));
  else if (c.id === 'material') strict = !delegated && calls.some(a => a.tool === 'steward_file_read' && paths(a.args?.path) === 'c:/routingfixture/material.txt');
  else if (c.id === 'followup') strict = !delegated && calls.some(a => a.tool === 'steward_thread_artifact_read' && a.args?.sessionId === 'sess_existing_report' && paths(a.args?.path) === 'c:/routingfixture/report.md');
  else strict = actions.some(a => a.tool === 'steward_thread_new' && a.args?.brief?.userText === c.question);
  if (readOnlyCase && actions.some(a => !allowedReads.includes(a.tool))) strict = false;
  return { strict, unknown: false, actions, proposedOnly: !actions.length && !!object?.acts?.length };
}
(async () => {
  const rows = []; let aborted = false;
  try {
    // Two repetitions of the same five cases; alternate paired ordering to expose order/caching effects.
    for (let repeat = 0; repeat < 2; repeat++) for (const [index, c] of cases.entries()) for (const variant of (index + repeat) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const v = variants[variant], messages = [{ role: 'system', content: v.stable }, { role: 'user', content: context + '\n' + c.question }];
      const body = wire.encodeQuick({ model, messages, plain: false, provider }); body.max_tokens = 768; wire.applyTemperature(body, 0); wire.applyTools(body, v.tools);
      const started = Date.now(), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 60000);
      try {
        const response = await fetch(wire.completionUrl(provider.baseUrl), { method: 'POST', headers: wire.requestHeaders(provider, { model }), body: JSON.stringify(body), signal: ctrl.signal });
        if (!response.ok) { rows.push({ repeat, id: c.id, variant, httpStatus: response.status, unknown: true, strict: false, ms: Date.now() - started }); if ([401, 403, 404].includes(response.status)) throw new Error('provider unavailable'); continue; }
        const decoded = wire.decodeCompletion(await response.json(), { requestModel: model }), assessment = assess(c, decoded);
        rows.push({ repeat, id: c.id, variant, question: c.question, requestHash: hash(JSON.stringify(body)), ms: Date.now() - started,
          ...assessment, content: scrub(decoded.text), usage: decoded.usage });
        console.log(JSON.stringify({ repeat, id: c.id, variant, strict: assessment.strict, unknown: assessment.unknown, ms: Date.now() - started }));
      } catch (error) { if (error.message === 'provider unavailable') throw error; rows.push({ repeat, id: c.id, variant, unknown: true, strict: false, error: 'request failed', ms: Date.now() - started }); }
      finally { clearTimeout(timer); }
    }
    t.ok(rows.length === 20 && !rows.some(r=>r.unknown), '固定五类两轮对照均得到可评响应');
  } catch { aborted = true; t.fail('routing cohort failed; credentials omitted'); }
  finally {
    const summary = Object.fromEntries(Object.keys(variants).map(v => [v, { total: rows.filter(r=>r.variant===v).length, strict: rows.filter(r=>r.variant===v&&r.strict).length, unknown: rows.filter(r=>r.variant===v&&r.unknown).length }]));
    t.ok(hash(fs.readFileSync(source.file)) === originalHash, '本机配置逐字节不变');
    fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({ model, protocol: wire.id, baseline: '256f0cc3', scope: 'synthetic first response only; no tool execution', tools: currentTools.length, limits: { requests: 20, outputTokens: 768, timeoutMs: 60000, retries: 0 }, summary, rows, aborted, sourceUnchanged: hash(fs.readFileSync(source.file)) === originalHash }, null, 2));
    console.log('SUMMARY ' + JSON.stringify(summary)); console.log('ARTIFACTS ' + root);
    t.done({ exit: true });
  }
})();
