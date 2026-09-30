'use strict';
// 架构还债批 3·C:server.js 的导出面(14-main.js 的 module.exports)。
//   [X1] 每个导出都至少被 dev-harness/ 或 ruyi-workbench/tools/ 下一个代码文件按词边界提到 —— 导出只为
//        测试/工具直调而存在,没人用的导出就是死面积(批 3 清掉了 73 条)。要把某个名字当作刻意的公共
//        接口留着(MCP/CLI 入口、打包脚本会用),登记进 PUBLIC_API 并写明理由。
//   [X2] 导出总数只减不增。上限随每次清理往下调;调上去 = 又在往 module.exports 里加东西,请先确认真有
//        测试要直调它(那条测试会让 [X1] 通过),再把上限跟着改成实数。
//   [X3] PUBLIC_API 里的名字必须真的还在导出里(过期的豁免要删掉)。
// 判据故意粗:注释里提到也算引用;它只防「没人用」,不替代各件自己的行为断言。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-export-surface-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

const EXPORT_CEILING = 587;   // 2026-09-27 批 3·C 清掉 73 条无人引用的导出之后的实数(修前 643);批 3·A 引擎适配器 +2(AGENT_CLI_ADAPTERS / agentCliAdapter,unit/agent-cli-adapters 直调);58 号批 1 协议登记表 +3(PROVIDER_WIRE_PROTOCOLS / normalizeProviderApiStyle / providerWireProtocol,unit/provider-wire-protocols 直调);hunt2-http +1(spawnDetachedChecked,unit/http-input-hardening 直调);性能批 P1 +3(forEachUsageRow / readUsageRows / usageLedgerCacheStats,unit/usage-ledger-cache 直调);性能批 P2 +1(pretenderIndexTestHooks,unit/pretender-index-incremental 直调);perf 轮询路径 +4(buildMissionAggregateRows / listAgentRunDigests / saveAgentRun / perfCounters,unit/poll-path-caches 直调并读确定性计数器);会话正文 perf +1(sessionMessagesDelta,unit/session-body-line-cache 把字节戳路径与逐条序列化路径逐格比对);安全审计修复 +2(schedulerPermissionModeFor / bridgedReadPathGate,unit/security-audit-fixes 直调)

// 刻意的公共接口:名字 → 理由。目前为空 —— 现有每个导出都有测试或工具在用。
const PUBLIC_API = {};

const CORPUS_ROOTS = ['dev-harness', path.join('ruyi-workbench', 'tools')];
const CODE_EXT = /\.(?:js|mjs|cjs|ps1|cmd|py)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'visual-baselines']);
const SELF = path.resolve(__filename);

function corpusIdentifiers() {
  const seen = new Set();
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
      if (!CODE_EXT.test(e.name) || path.resolve(p) === SELF) continue;
      for (const tok of fs.readFileSync(p, 'utf8').split(/[^A-Za-z0-9_$]+/)) if (tok) seen.add(tok);
    }
  };
  for (const r of CORPUS_ROOTS) walk(path.join(repo, r));
  return seen;
}

const exported = Object.keys(srv);

test('[X1] 每个导出都有 dev-harness/ 或 ruyi-workbench/tools/ 的引用(或登记为公共接口)', () => {
  const ids = corpusIdentifiers();
  const orphans = exported.filter(name => !ids.has(name) && !Object.prototype.hasOwnProperty.call(PUBLIC_API, name));
  assert.deepEqual(orphans, [],
    `这些导出没有任何测试/工具引用,请从 14-main.js 的 module.exports 删掉(符号本身留着),或登记进 PUBLIC_API 并写理由:${orphans.join(', ')}`);
});

test('[X2] 导出总数只减不增', () => {
  assert.ok(exported.length <= EXPORT_CEILING,
    `module.exports 有 ${exported.length} 个键,超过上限 ${EXPORT_CEILING}。新导出须有测试直调;清理后把上限改成实数。`);
});

test('[X3] PUBLIC_API 的豁免都还在导出里', () => {
  const stale = Object.keys(PUBLIC_API).filter(name => !exported.includes(name));
  assert.deepEqual(stale, [], `过期豁免:${stale.join(', ')}`);
  for (const [name, why] of Object.entries(PUBLIC_API)) assert.ok(typeof why === 'string' && why.trim(), `${name} 缺理由`);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
