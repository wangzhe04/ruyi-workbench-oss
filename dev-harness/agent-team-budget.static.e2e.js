// Static/unit regression: one-shot Agent team UI + dual-engine policy injection + adaptive budgets.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const server = require(path.join(WB, 'app', 'server.js'));
const read = p => fs.readFileSync(path.join(WB, p), 'utf8');

const ordinary = server.resolveToolIterationBudget(100, '请读取这个文件并告诉我标题');
assert.deepStrictEqual(
  { initial: ordinary.initial, hardLimit: ordinary.hardLimit, mode: ordinary.mode, longTask: ordinary.longTask },
  { initial: 100, hardLimit: 300, mode: 'standard', longTask: false },
);

const longSingle = server.resolveToolIterationBudget(100, '请全面实现这次迁移，然后测试、打包、重启并提交推送');
assert.strictEqual(longSingle.initial, 200);
assert.strictEqual(longSingle.mode, 'long');
assert.strictEqual(longSingle.agentTeam, false, 'long task must not require Agent team mode');

const teamSimple = server.resolveToolIterationBudget(100, '比较这两个实现', { agentTeam: true });
assert.strictEqual(teamSimple.initial, 200);
assert.strictEqual(teamSimple.mode, 'agent-team');
assert.strictEqual(teamSimple.longTask, false, 'Agent team must remain independent from long-task classification');
assert.strictEqual(server.resolveToolIterationBudget(999, 'hello').base, 200, 'configured base clamps at 200');
assert.strictEqual(server.resolveToolIterationBudget(20, 'continue', { driverAuto: true }).initial, 200, 'mission driver starts long');

assert.strictEqual(server.shouldExtendToolIterationBudget({ currentLimit: 100, hardLimit: 300, iter: 100, lastProgressIter: 99, progressEvents: 4, progressAtLastExtension: 0 }), true);
assert.strictEqual(server.shouldExtendToolIterationBudget({ currentLimit: 100, hardLimit: 300, iter: 100, lastProgressIter: 80, progressEvents: 4, progressAtLastExtension: 0 }), false, 'stale progress must not extend');
assert.strictEqual(server.shouldExtendToolIterationBudget({ currentLimit: 150, hardLimit: 300, iter: 150, lastProgressIter: 149, progressEvents: 6, progressAtLastExtension: 4 }), false, 'less than three new progress events must not extend');
assert.strictEqual(server.shouldExtendToolIterationBudget({ currentLimit: 300, hardLimit: 300, iter: 300, lastProgressIter: 299, progressEvents: 99, progressAtLastExtension: 0 }), false, 'hard cap never extends');

const hint = server.buildAgentTeamHint();
assert.match(hint, /MUST actually call orchestrate_agents or spawn_agent/);
assert.match(hint, /matching preset workflowId/);
assert.match(hint, /at least two agents/);
assert.match(hint, /Duration or complexity alone is not a reason to split work/);
assert.ok(server.appendTurnPolicies('base', server.defaultConfig(), true).includes('<agent-team-mode>'));
assert.ok(!server.appendTurnPolicies('base', server.defaultConfig(), false).includes('<agent-team-mode>'));

const html = read('app/public/index.html');
const css = read('app/public/styles.css');
const app = read('app/public/app.js');
const source = read('app/server.js');
assert.ok(html.includes('id="agentTeamBtn"'));
assert.ok(css.includes('.agent-team-btn[aria-pressed="true"]'));
assert.ok(app.includes('let agentTeamTurnEnabled = false'));
assert.ok(app.includes('const agentTeam = overrideText == null && agentTeamTurnEnabled && agentTeamAvailable()'));
assert.ok(app.includes('agentTeamTurnEnabled = false;'), 'sending consumes one-shot preference');
assert.ok(app.includes('attachments: sentAttachments, agentTeam'));
assert.ok(source.includes('appendTurnPolicies(appendSys, config, agentTeam, appendLimit)'), 'Claude CLI receives Agent team policy (cmd8191: limit 由整行预算动态给出, ≤8000)');
assert.ok(source.includes('appendTurnPolicies(volatileExtras, config, agentTeam)'), 'OpenAI-compatible engine places Agent team policy in the volatile user prefix');
assert.strictEqual((source.match(/reg\.onEvent = evt => \{ reg\.lastEventAt = Date\.now\(\); onEvent\(evt\); \};/g) || []).length, 2, 'Claude and OpenAI active-turn registries both count external workflow events as activity');
assert.ok(source.includes("type: 'tool_budget', state: 'extended'"));

const cfg = server.normalizeConfig({ ...server.defaultConfig(), openaiMaxToolIterations: 999 }).config;
assert.strictEqual(cfg.openaiMaxToolIterations, 200);
const role = server.normalizeAgentRole({ id: 'budget-test', label: 'Budget test', budgets: { openai: 999, claude: 999 } });
assert.strictEqual(role.budgets.openai, 300);
assert.strictEqual(role.budgets.claude, 300);
assert.ok(server.BUILTIN_AGENT_ROLES.some(r => r.id === 'coder' && r.toolTier === 'exec'), 'Coder is available as a built-in dual-engine role');

console.log('PASS Agent team one-shot UI, aggressive dual-engine policy, and adaptive 100/200/300 budgets');
