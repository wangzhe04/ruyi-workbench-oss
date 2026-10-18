'use strict';
// Opt-in local provider journey. Never modify the source config or print credentials.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { readLocalConfig } = require('./lib/local-provider-key');
const source = readLocalConfig();
const provider = source.config?.providers?.find(p => p.apiKey && /deepseek/i.test([p.label, p.baseUrl, p.model].join(' ')));
if (!provider) { console.log('SKIP: configured DeepSeek provider unavailable'); process.exit(0); }
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(source.file)).digest('hex');
const sourceHash = hash();
require('./lib/self-isolate-home');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('STEWARD MULTISTEP LIVE'); const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-multistep-live-'));
const home = path.join(root, 'home'), work = path.join(root, 'work'); fs.mkdirSync(home); fs.mkdirSync(work);
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: [provider], activeProvider: provider.id, stewardProviderId: provider.id, stewardModel: provider.model,
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, stewardEnabledV1: true, permissionMode: 'acceptEdits', subagentMaxPerTurn: 4, defaultWorkspace: work, workspaces: [{ path: work }] }));
const s = loadServerInternals(['runStewardTurn', 'listSessions', 'listAgentRuns', 'stewardLaunchingTurns', 'loadSession']);
const rows = [];
function cleanup() {
  for (const name of ['config.json', 'config.json.prev']) {
    const file = path.join(home, name); if (!fs.existsSync(file)) continue;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')); cfg.providers = []; cfg.activeProvider = ''; fs.writeFileSync(file, JSON.stringify(cfg));
  }
}
(async () => {
  const watchdog = setTimeout(() => { cleanup(); console.log('FAIL live timeout'); process.exit(1); }, 300000);
  try {
    const cases = [
      { title: '资料汇总', dir: 'summary', input: '资料编号 LIVE_EVIDENCE_7842。甲项目预算120万元，乙项目预算80万元。', output: 'summary.md', request: '第一步读取 source.txt 核对资料；第二步根据第一步结果写 summary.md，必须包含资料编号及两项目预算合计200万元。' },
      { title: '对比报告', dir: 'compare', input: '方案A：成本120，耗时3天。方案B：成本80，耗时5天。证据编号 LIVE_EVIDENCE_7842。', output: 'comparison.md', request: '第一步读取 source.txt 核对A/B指标；第二步根据第一步结果写 comparison.md，包含证据编号和成本优先选B、时效优先选A的结论。' },
      { title: '文件整理', dir: 'organize', input: 'LIVE_EVIDENCE_7842\n待整理条目：预算、时效、结论。', output: 'organized/index.md', request: '第一步读取 source.txt 清点条目；第二步根据第一步清单创建 organized/index.md，包含原资料编号与三项条目，不删除原件。' },
    ];
    for (const c of cases) {
      const dir = path.join(work, c.dir); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'source.txt'), c.input);
      const before = new Set((await s.listSessions()).map(x => x.id)); const started = Date.now();
      const reply = await s.runStewardTurn({ trigger: 'user', message: `请作为一个新的独立事项办理${c.title}，用 steward_thread_new 的 steps 参数明确交办两个有先后依赖的步骤，只有一个协调线程，不用速查，不用 playbook。工作区用 ${work}，材料位于 ${c.dir}/source.txt，输出也放在 ${c.dir}/ 下（下述文件名均相对该目录）。${c.request} 缺少材料或权限就明确报告；未完成不能说完成。` });
      const created = (await s.listSessions()).filter(x => !before.has(x.id) && x.id !== 'steward');
      ok(created.length === 1, c.title + '真实模型只创建一个协调线程');
      const sid = created[0]?.id;
      if (!sid) { rows.push({ title: c.title, say: reply.say, created: created.length }); continue; }
      for (let i = 0; i < 2400 && s.stewardLaunchingTurns.has(sid); i++) await new Promise(resolve => setTimeout(resolve, 100));
      const runs = await s.listAgentRuns(sid), run = runs[0], session = await s.loadSession(sid);
      const file = path.join(dir, c.output), text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const evidence = text.includes('LIVE_EVIDENCE_7842') && (c.dir !== 'summary' || text.includes('200')) && (c.dir !== 'compare' || /A|Ａ/.test(text) && /B|Ｂ/.test(text) && text.includes('成本') && text.includes('时效')) && (c.dir !== 'organize' || ['预算', '时效', '结论'].every(word => text.includes(word)));
      const passed = runs.length === 1 && run.kind === 'steward_delegation' && run.nodes.length === 2 && run.nodes.every(n => n.status === 'succeeded') && evidence;
      ok(passed, c.title + '真实 DAG 两步成功且产物包含材料证据');
      rows.push({ title: c.title, passed, elapsedMs: Date.now() - started, status: run?.status, steps: run?.nodes.map(n => ({ id: n.id, status: n.status, toolCalls: n.toolCalls })), usage: run?.usageTotals, output: file, evidence,
        final: session.messages.findLast(m => m.role === 'assistant')?.content, say: reply.say });
    }
    ok(hash() === sourceHash, '本机原配置逐字节不变');
    fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({ model: provider.model, cases: rows, pass: t.failures === 0, sourceUnchanged: hash() === sourceHash }, null, 2));
    console.log('ARTIFACTS ' + root);
  } catch { t.fail('live journey failed; credentials omitted'); }
  finally { clearTimeout(watchdog); cleanup(); t.done({ exit: true }); }
})();
