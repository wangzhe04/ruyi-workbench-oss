'use strict';
// Opt-in provider journey; original configuration and credentials stay private.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { readLocalConfig } = require('./lib/local-provider-key');
const source = readLocalConfig();
const provider = source.config?.providers?.find(p => p.apiKey && /deepseek/i.test([p.label, p.baseUrl, p.model].join(' ')));
if (!provider) { console.log('SKIP: configured DeepSeek provider unavailable'); process.exit(0); }
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(source.file)).digest('hex');
const originalHash = hash();
require('./lib/self-isolate-home');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('PLAYBOOK REUSE LIVE'); const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-playbook-reuse-live-'));
const home = path.join(root, 'home'), work = path.join(root, 'work'); fs.mkdirSync(home); fs.mkdirSync(work);
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
function cleanup() {
  let failed = false;
  for (const name of ['config.json', 'config.json.prev']) {
    const file = path.join(home, name); if (!fs.existsSync(file)) continue;
    try { fs.writeFileSync(file, JSON.stringify({ providers: [], activeProvider: '' })); } catch { failed = true; }
  }
  if (failed) throw new Error('isolated credential cleanup failed');
}
function meetsCriteria(text, c, input) {
  const clean = text.replace(/[*`]/g, '');
  const number = value => new RegExp('(?<![\\d.])' + value.replace('.', '\\.') + '(?![\\d.])');
  return /^(?:#{1,6}\s*)?预算汇总\s*$/m.test(clean) && clean.includes('万元') && clean.includes(input) && c.values.every(v => number(v).test(clean)) && !number('20.00').test(clean);
}
(async () => {
  const watchdog = setTimeout(() => { cleanup(); console.log('FAIL live timeout'); process.exit(1); }, 300000);
  const rows = [];
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: [provider], activeProvider: provider.id,
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, stewardEnabledV1: true, permissionMode: 'acceptEdits', toolLoadingMode: 'full', defaultWorkspace: work, workspaces: [{ path: work }] }));
    const s = loadServerInternals(['createSession', 'saveSession', 'loadSession', 'playbookReuseSources', 'draftPlaybookFromSession', 'saveUserPlaybook', 'StewardHooks', 'stewardLaunchingTurns', 'readInterventions']);
    const terminal = async run => {
      let session = run.ok ? await s.loadSession(run.sessionId) : null;
      for (let i = 0; run.ok && i < 100 && session?.stewardLastTurn?.seq !== session?.turnSeq; i++) { await new Promise(resolve => setTimeout(resolve, 20)); session = await s.loadSession(run.sessionId); }
      const final = session?.messages?.findLast(m => m.role === 'assistant'), outcome = session?.stewardLastTurn;
      const pending = run.ok ? (await s.readInterventions(run.sessionId)).filter(iv => ['pending', 'applying'].includes(iv.status)).length : 0;
      const settled = run.ok && !s.stewardLaunchingTurns.has(run.sessionId) && outcome?.seq === session?.turnSeq && outcome.ok === true && outcome.aborted !== true && !outcome.errorClass && !!final?.turnSummary && final.source?.startsWith('provider:') && !!final.content?.trim() && !pending && !(final.toolCalls || []).some(call => call.result?.ok === false || call.error);
      return { settled, pending, outcome, source: final?.source, final: final?.content, usage: final?.usage };
    };
    const history = await s.createSession({ title: '固定认可历史样本', cwd: work });
    history.messages = [
      { role: 'user', turnSeq: 1, content: '汇总旧材料：甲120000元、乙80000元，写预算报告。' },
      { role: 'assistant', turnSeq: 1, content: '合计200000元。', turnSummary: { turnSeq: 1 } },
      { role: 'user', turnSeq: 2, content: '以后标题用预算汇总，金额转为万元且必须保留两位小数；读取本次文件重新计算，列各项和合计并注明来源文件，不复用旧金额。' },
      { role: 'assistant', turnSeq: 2, content: '# 预算汇总\n甲12.00万元，乙8.00万元，合计20.00万元。来源：old-a.txt。', turnSummary: { turnSeq: 2 } },
      { role: 'user', turnSeq: 3, content: '另一个无关问题：周末天气如何？' },
    ]; history.turnSeq = 3; await s.saveSession(history);
    const sources = await s.playbookReuseSources(history.id), started = Date.now();
    const drafted = await s.draftPlaybookFromSession(history.id, { selection: {
      resultRef: sources.results.find(r => r.turnSeq === 2).ref, correctionRefs: [sources.corrections.find(r => r.turnSeq === 2).ref],
      inputs: [{ key: 'material', label: '本次材料文件', type: 'file' }, { key: 'output', label: '本次报告文件', type: 'file' }],
      checks: ['标题为预算汇总；各项与合计均转为万元并保留两位小数', '读取本次材料重新计算，注明本次来源文件，不复制历史金额'],
    } });
    ok(drafted.ok && drafted.draft?.reuse?.status === 'unverified', '真实模型从固定认可历史起草，保持未验证');
    if (!drafted.ok) throw new Error('draft failed');
    const pb = await s.saveUserPlaybook(drafted.draft);
    rows.push({ phase: 'draft', elapsedMs: Date.now() - started, template: pb.promptTemplate });
    const ctx = { sessionId: 'steward', trigger: 'user', session: { id: 'steward', kind: 'steward', providerHistory: [] } };
    for (const c of [
      { name: 'new-b', material: '甲项目125000元，乙项目212500元。', values: ['12.50', '21.25', '33.75'] },
      { name: 'new-c', material: '丙项目12345元，丁项目7655元。', values: ['1.23', '0.77', '2.00'] },
    ]) {
      const input = c.name + '.txt', output = c.name + '-report.md', start = Date.now(); fs.writeFileSync(path.join(work, input), c.material);
      const baselineOutput = c.name + '-baseline.md';
      const baseline = await s.StewardHooks.threadNew({ cwd: work, brief: { userText: `请用 file_read 读取 ${input}，汇总预算并用 file_write 写到 ${baselineOutput}。只用这两个文件工具。` } }, ctx);
      for (let i = 0; i < 900 && s.stewardLaunchingTurns.has(baseline.sessionId); i++) await new Promise(resolve => setTimeout(resolve, 100));
      const baselineFile = path.join(work, baselineOutput), baselineText = fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, 'utf8') : '';
      const baselineState = await terminal(baseline); ok(baselineState.settled, c.name + '对照线程真实收尾且无待决/工具失败');
      rows.push({ phase: 'baseline', name: c.name, elapsedMs: Date.now() - start, output: baselineFile, content: baselineText, ...baselineState, passed: baselineState.settled && meetsCriteria(baselineText, c, input) });
      const reuseStart = Date.now();
      const run = await s.StewardHooks.threadNew({ cwd: work, brief: { userText: '在这份新材料上验证已保存做法，并逐项核对验收规则。仅使用 file_read 读取 UTF-8 材料及 file_write 写报告，不运行命令。', playbook: { id: pb.id, inputs: { material: input, output } } } }, ctx);
      ok(run.ok, c.name + '沿原Playbook线程执行');
      if (!run.ok) continue;
      for (let i = 0; i < 2400 && s.stewardLaunchingTurns.has(run.sessionId); i++) await new Promise(resolve => setTimeout(resolve, 100));
      const file = path.join(work, output), text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const state = await terminal(run); ok(state.settled, c.name + '复用线程真实收尾且无待决/工具失败');
      const passed = state.settled && meetsCriteria(text, c, input);
      ok(passed, c.name + '实际文件按新金额、两位小数及来源通过');
      rows.push({ phase: 'reuse', name: c.name, passed, elapsedMs: Date.now() - reuseStart, output: file, content: text,
        ...state });
    }
    ok(hash() === originalHash, '本机原配置逐字节不变');
    fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({ model: provider.model, source: 'fixed historical fixture', cases: rows, pass: t.failures === 0, sourceUnchanged: hash() === originalHash }, null, 2));
    console.log('ARTIFACTS ' + root);
  } catch { t.fail('live journey failed; credentials omitted'); }
  finally { clearTimeout(watchdog); cleanup(); t.done({ exit: true }); }
})();
