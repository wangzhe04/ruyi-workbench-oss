'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), os = require('os'), path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { startFakeProvider, toolCallFrames } = require('./lib/fake-openai-provider');
const t = createRunner('PLAYBOOK REUSE'); const { ok } = t;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-playbook-reuse-'));
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
let fake, holdDraft = false, releaseDraft, unknown = false;
const correction = '金额使用万元，保留两位小数，按本次材料重新求和；标题固定为预算汇总。';
(async () => {
  try {
    fake = await startFakeProvider({ handler: req => {
      const text = String(req.messages.findLast(m => m.role === 'user')?.content || '');
      if (text.includes('产出一个 playbook 的 JSON')) {
        const draft = { id: 'weekly-report', title: '预算汇总做法', desc: '从本次输入重新计算', inputs: [], promptTemplate: '读取 {material}，按万元保留两位小数，重新求和，标题预算汇总。写到 {output}。' + (unknown ? ' {undeclared}' : ''), requires: [] };
        if (holdDraft) return new Promise(resolve => { releaseDraft = () => resolve(JSON.stringify(draft)); });
        return JSON.stringify(draft);
      }
      const userIndex = req.messages.findLastIndex(m => m.role === 'user'), tools = req.messages.slice(userIndex + 1).filter(m => m.role === 'tool');
      if (text.includes('NEW_MATERIAL_B')) {
        if (!tools.length) return toolCallFrames('file_read', { path: 'new-b.txt' });
        if (tools.length === 1) return toolCallFrames('file_write', { path: 'new-report.md', content: '# 预算汇总\n33.75 万元\n来源：NEW_MATERIAL_B\n' });
        return '已回读新材料并写入报告。';
      }
      return 'done';
    } });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'fixture', model: 'fake-model' }], activeProvider: 'fake', defaultWorkspace: home, workspaces: [{ path: home }], includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, stewardEnabledV1: true, permissionMode: 'acceptEdits' }));
    const s = loadServerInternals(['createSession', 'saveSession', 'loadSession', 'mutateSession', 'readConfig', 'mutateConfig', 'playbookReuseSources', 'draftPlaybookFromSession', 'normalizePlaybook', 'saveUserPlaybook', 'loadAllPlaybooks', 'StewardHooks', 'stewardLaunchingTurns']);
    const source = await s.createSession({ title: '已认可预算成果', cwd: home });
    source.messages = [
      { role: 'user', turnSeq: 1, content: '汇总旧材料 OLD_A，金额12和8。' },
      { role: 'assistant', turnSeq: 1, content: '旧版结果20元（错误格式）。', turnSummary: { turnSeq: 1 } },
      { role: 'user', turnSeq: 2, content: correction },
      { role: 'assistant', turnSeq: 2, content: '# 预算汇总\n20.00 万元，已按新格式重新计算。', turnSummary: { turnSeq: 2, filesChanged: [{ path: 'old-report.md' }] } },
      { role: 'user', turnSeq: 3, content: 'UNRELATED_LATEST_REQUEST：另问天气，不要写入做法。' },
      { role: 'assistant', turnSeq: 3, content: '天气未知。', turnSummary: { turnSeq: 3, filesChanged: [{ path: 'UNRELATED_ARTIFACT' }] } },
      { role: 'user', turnSeq: 4, content: 'SYSTEM_WAKE_NOT_A_CORRECTION', meta: { origin: 'agent_wake' } },
      { role: 'assistant', turnSeq: 4, content: 'STOPPED_NOT_APPROVED', source: 'aborted', turnSummary: { turnSeq: 4 } },
    ]; source.turnSeq = 4; await s.saveSession(source);
    const sources = await s.playbookReuseSources(source.id);
    ok(sources.results.length === 3 && !sources.corrections.some(r => r.text.includes('SYSTEM_WAKE')) && !sources.results.some(r => r.text.includes('STOPPED')), '只列真实可选成果/用户原话，排除停止和系统唤醒');
    const selection = { resultRef: sources.results.find(r => r.turnSeq === 2).ref, correctionRefs: [sources.corrections.find(r => r.turnSeq === 2).ref], inputs: [{ key: 'material', label: '新资料', type: 'file' }, { key: 'output', label: '输出', type: 'file' }], checks: ['标题预算汇总，金额按万元保留两位小数', '依据本次材料重新求和，给出来源'] };
    const n = fake.requests.length;
    for (const patch of [{ resultRef: '0'.repeat(64) }, { correctionRefs: ['0'.repeat(64)] }, { checks: [] }, { inputs: [{ key: 'bad key', label: 'bad', type: 'file' }] }, { correctionRefs: [selection.correctionRefs[0], selection.correctionRefs[0]] }]) {
      const r = await s.draftPlaybookFromSession(source.id, { selection: { ...selection, ...patch } });
      ok(!r.ok && r.noModelCall, '无效、跨成果或缺参数选择在调模型前拒绝');
    }
    ok(fake.requests.length === n, '无效选择不产生模型费用');
    const drafted = await s.draftPlaybookFromSession(source.id, { selection });
    const pb = drafted.draft, prompt = fake.requests.findLast(r => JSON.stringify(r.messages).includes('selectedResult'));
    ok(drafted.ok && pb.id !== 'weekly-report' && pb.inputs.every(i => i.required) && pb.reuse.status === 'unverified', '新草稿使用新id、用户输入和未验证状态，不能覆盖已有做法');
    ok(JSON.stringify(prompt.messages).includes(correction) && JSON.stringify(prompt.messages).includes('20.00') && !JSON.stringify(prompt.messages).includes('UNRELATED_LATEST_REQUEST') && !JSON.stringify(prompt.messages).includes('UNRELATED_ARTIFACT'), '选中的旧成果与关键纠正进入提炼，之后无关最新任务不混入');
    ok(!(await s.loadAllPlaybooks()).some(p => p.id === pb.id), '起草不等于保存');
    const later = await s.draftPlaybookFromSession(source.id, { selection: { ...selection, correctionRefs: [sources.corrections.find(r => r.turnSeq === 3).ref] } });
    ok(later.ok && later.draft.reuse.corrections[0].turnSeq === 3, '用户明确选择的成果后补充也可进入做法，不以时间顺序限制纠正');
    const saved = await s.saveUserPlaybook(pb);
    const edited = s.normalizePlaybook({ ...saved, id: 'pb-edited-copy', reuse: { ...saved.reuse, status: 'verified', checks: ['新材料金额重新计算，保留两位小数'] } });
    ok(edited.reuse.status === 'unverified' && !edited.promptTemplate.includes('1. 标题预算汇总') && edited.promptTemplate.includes('新材料金额重新计算') && edited.promptTemplate.split('<playbook-reuse-checks>').length === 2, '修改验收项替换旧检查段，伪造verified被归一为未验证');
    await s.saveUserPlaybook(edited);
    ok((await s.loadAllPlaybooks()).find(p => p.id === pb.id).reuse.checks[0] === selection.checks[0], '修改副本保留原版，可随时选回原做法');
    ok(!s.normalizePlaybook({ ...pb, promptTemplate: '读取 {undeclared}' }), '缺少所选参数或含野占位符的做法不能保存');
    ok(!s.normalizePlaybook({ ...pb, inputs: [...pb.inputs, { key: 'bad key', label: '坏参数', type: 'file' }], promptTemplate: pb.promptTemplate + '读取 {bad key}' }), '副本中的非法新增参数整份拒绝，不静默丢弃后留下坏占位符');
    unknown = true;
    ok(!(await s.draftPlaybookFromSession(source.id, { selection })).ok, '模型生成未声明变量时两次均拒绝，不发出坏草稿'); unknown = false;
    holdDraft = true;
    const pending = s.draftPlaybookFromSession(source.id, { selection });
    for (let i = 0; i < 300 && !releaseDraft; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await s.mutateSession(source.id, session => { session.messages[3].content = '成果已经修订，旧选择失效。'; });
    releaseDraft(); holdDraft = false;
    ok((await pending).error === 'playbook_source_changed', '模型起草期间来源变化，迟到草稿不能冒充当前认可成果');
    fs.writeFileSync(path.join(home, 'new-b.txt'), 'NEW_MATERIAL_B\n12.50\n21.25\n');
    const ctx = { sessionId: 'steward', trigger: 'user', session: { id: 'steward', kind: 'steward', providerHistory: [] } };
    const missing = await s.StewardHooks.threadNew({ brief: { userText: '在新材料上验证做法', playbook: { id: pb.id, inputs: { material: 'new-b.txt' } } }, cwd: home }, ctx);
    ok(!missing.ok && missing.reason === 'playbook_inputs_missing', '普通管家Playbook执行继续拒绝缺参数');
    const launched = await s.StewardHooks.threadNew({ brief: { userText: 'NEW_MATERIAL_B：按认可做法验证新材料', playbook: { id: pb.id, inputs: { material: 'new-b.txt', output: 'new-report.md' } } }, cwd: home }, ctx);
    for (let i = 0; i < 800 && s.stewardLaunchingTurns.has(launched.sessionId); i++) await new Promise(resolve => setTimeout(resolve, 25));
    ok(launched.ok && fs.readFileSync(path.join(home, 'new-report.md'), 'utf8').includes('33.75') && !fs.readFileSync(path.join(home, 'new-report.md'), 'utf8').includes('20.00'), '复用普通线程/文件工具在新材料上产生新结论，不复制旧成果数值');
    const run = await s.loadSession(launched.sessionId);
    ok(run.messages[0].content.includes('<playbook-reuse-checks>') && run.messages[0].content.includes(selection.checks[0]), '真实执行包含所选验收标准，来源历史不冒充本轮验证');
    await s.mutateConfig(c => { c.activeProvider = ''; c.providers = []; });
    ok((await s.playbookReuseSources(source.id)).canDraft === false && (await s.draftPlaybookFromSession(source.id, { selection })).noModelCall, '没有provider时明确不可起草，不偷偷调用CLI');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { if (fake) await fake.close(); t.done({ exit: true }); }
})();
