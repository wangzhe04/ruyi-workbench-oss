'use strict';
// 子代理时限(用户:「给子 agent 的限时似乎太少了」)。真源码、临时家目录、零模型请求、零等待:
//   [L1] 出厂值:自动收尾 30 分钟、宽限 5 分钟、总时长硬上限 60 分钟(单个子代理硬上限 ≥ 30 分钟;修前 8 + 2 = 10 分钟);
//   [L2] 用户设置跟随:调大 / 调小 / 关闭(0)都按公式走,硬上限始终 ≥ 收尾时限 + 宽限;
//   [L3] 持续有进展的节点不会被中止:一路跑过自动收尾时限、跑过「收尾 + 宽限」,只在总时长硬上限处才停;
//   [L4] 真正卡死的节点仍会被中止:催收尾之后宽限期内一点进展都没有 → 'quiet';中途有一点动静就从动静起重新数;
//   [L5] 没催过收尾的节点不归这条管(它的空闲由空闲看门狗盯);已强制过的不重复判;
//   [W1] wait_agents:默认 2 分钟、上限 5 分钟(修前 30 秒 / 60 秒),非数字 / 负数按 0,超上限按上限;
//   [W2] 工具描述(模型真实看到的 schema)里写着这两个数与节点时限;
//   [S1] 设置页:自动收尾的占位值 / 回填默认值与出厂一致;
//   [C1] Claude CLI 节点的空闲上限跟用户设置走,不再被封在 10 分钟。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-time-limits-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.HOME = root;
process.env.USERPROFILE = root;
const { loadServerInternals } = require('../lib/server-internals');
const { functionBlock } = require('../lib/source-slice');
const {
  agentNodeTimeLimits, nodeWrapUpAction, resolveWaitAgentsMs, WAIT_AGENTS_DEFAULT_MS, WAIT_AGENTS_MAX_MS, defaultConfig, normalizeConfig, buildOpenAiTools,
} = loadServerInternals(['agentNodeTimeLimits', 'nodeWrapUpAction', 'resolveWaitAgentsMs', 'WAIT_AGENTS_DEFAULT_MS', 'WAIT_AGENTS_MAX_MS', 'defaultConfig', 'normalizeConfig', 'buildOpenAiTools']);
after(() => fs.rmSync(root, { recursive: true, force: true }));

const MIN = 60000;
const limitsOf = (config = {}, env = {}) => agentNodeTimeLimits(config, env);

test('[L1] 出厂:自动收尾 30 分钟 / 宽限 5 分钟 / 硬上限 60 分钟', () => {
  assert.equal(defaultConfig().agentNodeWrapUpMs, 30 * MIN);
  const { config } = normalizeConfig({});
  assert.equal(config.agentNodeWrapUpMs, 30 * MIN, 'normalizeConfig 对缺省值回落到 30 分钟(不是旧的 8 分钟)');
  const l = limitsOf(config);
  assert.deepEqual(l, { wrapUpMs: 30 * MIN, graceMs: 5 * MIN, hardCapMs: 60 * MIN });
  assert.ok(l.hardCapMs >= 30 * MIN, '单个子代理的硬上限不低于 30 分钟');
  assert.ok(l.wrapUpMs + l.graceMs > 10 * MIN, '修前整个节点只有 8 + 2 = 10 分钟');
});

test('[L2] 用户设置:调大 / 调小 / 关闭都按公式走,硬上限不低于 收尾 + 宽限', () => {
  assert.deepEqual(limitsOf({ agentNodeWrapUpMs: 1 * MIN }), { wrapUpMs: 1 * MIN, graceMs: 2 * MIN, hardCapMs: 3 * MIN }, '1 分钟:宽限取下限 2 分钟,硬上限 = 收尾 + 宽限');
  assert.deepEqual(limitsOf({ agentNodeWrapUpMs: 8 * MIN }), { wrapUpMs: 8 * MIN, graceMs: 2 * MIN, hardCapMs: 16 * MIN });
  assert.deepEqual(limitsOf({ agentNodeWrapUpMs: 120 * MIN }), { wrapUpMs: 120 * MIN, graceMs: 10 * MIN, hardCapMs: 240 * MIN }, '120 分钟:宽限封顶 10 分钟,硬上限 2 倍');
  const off = limitsOf({ agentNodeWrapUpMs: 0 });
  assert.equal(off.wrapUpMs, 0, '0 = 关闭自动收尾');
  assert.equal(nodeWrapUpAction({ now: 1e12, modelStartedAt: 0, requestedAt: 0, lastActivityAt: 0, forced: false }, off), 'none', '关闭后既不催收尾也没有硬上限');
  const seam = limitsOf({ agentNodeWrapUpMs: 30 * MIN }, { WCW_AGENT_NODE_WRAPUP_MS: '1000', WCW_AGENT_NODE_WRAPUP_GRACE_MS: '2500', WCW_AGENT_NODE_HARDCAP_MS: '12000' });
  assert.deepEqual(seam, { wrapUpMs: 1000, graceMs: 2500, hardCapMs: 12000 }, 'env 缝只读环境变量,缺省(上面各条)即生产');
  assert.equal(limitsOf({}, { WCW_AGENT_NODE_WRAPUP_MS: '300', WCW_AGENT_NODE_WRAPUP_GRACE_MS: '4000' }).hardCapMs, 4300, '只给收尾与宽限时,硬上限 = 收尾 + 宽限(既有 e2e 的缩时口径不变)');
});

test('[L3] 持续有进展的节点:跑过收尾时限、跑过「收尾 + 宽限」都不被中止,只在硬上限处才停', () => {
  const limits = limitsOf({});
  const t0 = 1_000_000_000_000;
  const requestedAt = t0 + limits.wrapUpMs;
  const act = (minutes, recent = 1000) => ({ now: t0 + minutes * MIN, modelStartedAt: t0, requestedAt: minutes * MIN >= limits.wrapUpMs ? requestedAt : 0, lastActivityAt: t0 + minutes * MIN - recent, forced: false });
  assert.equal(nodeWrapUpAction(act(29.9), limits), 'none');
  assert.equal(nodeWrapUpAction({ ...act(30), requestedAt: 0 }, limits), 'nudge', '到 30 分钟只是催收尾');
  for (let minute = 31; minute < 60; minute += 1) {
    assert.equal(nodeWrapUpAction(act(minute), limits), 'none', `第 ${minute} 分钟节点仍在产出(1 秒前有动静)→ 不中止`);
  }
  assert.equal(nodeWrapUpAction(act(36), limits), 'none', '修前 30 + 2 分钟墙钟一到就杀;现在跑过 收尾 + 宽限(35 分钟)仍无事');
  assert.equal(nodeWrapUpAction(act(60), limits), 'hard_cap', '总时长到硬上限:不论是否还在产出都中止(兜住一直吐字、从不收尾)');
});

test('[L4] 真正卡死的节点仍会被中止:催收尾后宽限期内毫无进展 → quiet;有动静就重新数', () => {
  const limits = limitsOf({});
  const t0 = 1_000_000_000_000;
  const requestedAt = t0 + 30 * MIN;
  const at = (minutes, lastActivityMinutes) => ({ now: t0 + minutes * MIN, modelStartedAt: t0, requestedAt, lastActivityAt: t0 + lastActivityMinutes * MIN, forced: false });
  assert.equal(nodeWrapUpAction(at(34.99, 20), limits), 'none', '催收尾后 5 分钟内:还在宽限期');
  assert.equal(nodeWrapUpAction(at(35, 20), limits), 'quiet', '催收尾后整整 5 分钟没有任何进展 → 中止');
  assert.equal(nodeWrapUpAction(at(35, 33), limits), 'none', '33 分钟时还有过动静:从动静起重新数宽限');
  assert.equal(nodeWrapUpAction(at(38, 33), limits), 'quiet', '动静之后又整整 5 分钟没有进展 → 中止');
});

test('[L5] 没催过收尾的节点不归这条管;已强制过的不重复判', () => {
  const limits = limitsOf({});
  const t0 = 1_000_000_000_000;
  assert.equal(nodeWrapUpAction({ now: t0 + 20 * MIN, modelStartedAt: t0, requestedAt: 0, lastActivityAt: t0, forced: false }, limits), 'none', '没到收尾时限、再安静也由空闲看门狗盯,不在这里判');
  assert.equal(nodeWrapUpAction({ now: t0 + 90 * MIN, modelStartedAt: t0, requestedAt: t0 + 30 * MIN, lastActivityAt: t0, forced: true }, limits), 'none');
});

test('[W1] wait_agents:默认 2 分钟 / 上限 5 分钟,非数字与负数按 0,超上限按上限', () => {
  assert.equal(WAIT_AGENTS_DEFAULT_MS, 120000);
  assert.equal(WAIT_AGENTS_MAX_MS, 300000);
  assert.ok(WAIT_AGENTS_DEFAULT_MS > 30000 && WAIT_AGENTS_MAX_MS > 60000, '都比修前(30 秒 / 60 秒)放宽');
  assert.equal(resolveWaitAgentsMs(undefined), 120000);
  assert.equal(resolveWaitAgentsMs(null), 120000);
  assert.equal(resolveWaitAgentsMs(0), 0, '显式 0 = 不等,立即返回当前信封');
  assert.equal(resolveWaitAgentsMs('abc'), 0);
  assert.equal(resolveWaitAgentsMs(-5), 0);
  assert.equal(resolveWaitAgentsMs(45000), 45000);
  assert.equal(resolveWaitAgentsMs(99999999), 300000);
});

test('[W2] 模型真实看到的工具描述写明等待窗与节点时限', () => {
  const cfg = defaultConfig();
  const full = buildOpenAiTools({ ...cfg, toolLoadingMode: 'full', subagentMaxPerTurn: 4 }, null, { skillsEnabled: true, scratchpadEnabled: true });
  const wait = full.find(t => t.function.name === 'wait_agents').function;
  assert.match(wait.description, /default 120000, max 300000/);
  assert.match(wait.description, /timedOut:true means only the wait window ended/);
  assert.match(wait.parameters.properties.timeoutMs.description, /0\.\.300000 \(default 120000\)/);
  const orch = full.find(t => t.function.name === 'orchestrate_agents').function.description;
  assert.match(orch, /still running after 30 min to wrap up/);
  assert.match(orch, /passes 60 min in total/);
  assert.match(orch, /a node that keeps producing is not cut off/);
});

test('[S1] 设置页:自动收尾的占位值与回填默认值跟出厂一致(30 分钟)', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/index.html'), 'utf8');
  assert.match(html, /id="cfgAgentNodeWrapUpMinutes"[^>]*placeholder="30"/);
  const settings = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/provider-settings.js'), 'utf8');
  assert.match(settings, /clampedInt\('cfgAgentNodeWrapUpMinutes', 30, 0, 120\)/);
  for (const loc of ['zh-CN', 'en-US']) {
    const dict = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../ruyi-workbench/app/public/locales/${loc}.json`), 'utf8'));
    const mirror = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../docs/i18n/locales/${loc}.json`), 'utf8'));
    for (const key of ['settings.advanced.agentNodeWrapUp.hint', 'settings.limits.turnIdleHint']) {
      assert.ok(dict[key] && /30|10/.test(dict[key]), `${loc} ${key} 存在且带默认值`);
      assert.equal(mirror[key], dict[key], `${loc} ${key} 与 docs/i18n 镜像逐字一致`);
    }
    // 工作流卡的状态行按中止原因说话(hard_cap / quiet),两份 locale 与镜像齐备,且都点明「设置里调大」。
    for (const key of ['workflow.run.wrapUpForcedCap', 'workflow.run.wrapUpForcedQuiet']) {
      assert.ok(dict[key] && dict[key].includes('{{nodeId}}'), `${loc} ${key} 存在`);
      assert.equal(mirror[key], dict[key], `${loc} ${key} 与 docs/i18n 镜像逐字一致`);
    }
  }
  const prompts = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/interaction-prompts.js'), 'utf8');
  assert.match(prompts, /evt\.reason === 'hard_cap' \? 'workflow\.run\.wrapUpForcedCap' : \(evt\.reason === 'quiet' \? 'workflow\.run\.wrapUpForcedQuiet' : 'workflow\.run\.wrapUpForced'\)/, '状态行按事件里的 reason 选文案,老事件走原文案');
});

test('[C1] Claude CLI 节点的空闲上限跟 turnIdleTimeoutMs 走,不再封顶 10 分钟', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/07-autonomy.js'), 'utf8');
  const body = functionBlock(src, 'runClaudeSubAgentOnce');
  assert.ok(body.length > 2000, '切到了 runClaudeSubAgentOnce');
  assert.match(body, /const idleLimitMs = Math\.max\(1000, Number\(process\.env\.WCW_TURN_IDLE_MS\) \|\| Number\(config\.turnIdleTimeoutMs\) \|\| 600000\);/);
  assert.doesNotMatch(body, /Math\.min\(Number\(config\.turnIdleTimeoutMs\) \|\| 600000, 600000\)/);
});
