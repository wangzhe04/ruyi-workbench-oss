'use strict';
// 架构还债批 1 #9:按工具名分类的表与工具注册表(TOOL_HANDLERS + NATIVE_TOOL_TIER)对账。
// tool-dispatch.e2e 的 L4/L5 已钉住 TOOL_HANDLERS ↔ NATIVE_TOOL_PACKS ↔ NATIVE_TOOL_TIER;这里补上此前无人对账的几张:
//   [M1] 不可逆操作账(02f-turn-effect-kinds IRREVERSIBLE_NATIVE_KIND)的每个名字都是真工具、且风险档是 exec。
//   [M2] 每个 exec 档内建工具要么进账、要么在下面那张「不进账」清单里写明理由 ——
//        新增一个有副作用的 exec 工具却忘了决定它进不进账,这里当场红(修前是静默漏记)。
//   [M3] 回合摘要的两张表(改了哪些文件 / 跑了哪些命令)只收真工具,档位对得上(文件 = edit,命令 = exec)。
//   [M4] 有 handler 却不在原生 schema 表(13f MCP_TOOLS)里的,只能是下面这几个经别的通道发放的元工具。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-tool-meta-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { TOOL_HANDLERS, NATIVE_TOOL_TIER, IRREVERSIBLE_NATIVE_KIND, TURN_SUMMARY_FILE_TOOLS, TURN_SUMMARY_COMMAND_TOOLS } = srv;
const handlers = Object.keys(TOOL_HANDLERS);
const tierOf = name => NATIVE_TOOL_TIER[name];

// exec 档却【有意】不进不可逆账的内建工具,以及理由(判据见 02f-turn-effect-kinds IRREVERSIBLE_* 头注)。
const EXEC_NOT_LEDGERED = {
  tool_invoke_exec: '元工具:真正被调用的那个工具按自己的名字进账',
  permission_prompt: '只向用户发问,自身没有副作用',
  shell_poll: '只读交互式 shell 的增量输出',
  audio_transcribe: '把音频交给已配置的 ASR 端点转写,不改本机状态',
  spawn_agent: '编排元工具:子代理自己的工具调用逐条进账',
  orchestrate_agents: '编排元工具:同上',
  steward_decide: '管家工具:落在干预日志与管家审计里,不进用户回合的账',
  steward_run_action: '管家工具:同上',
  steward_thread_stop: '管家工具:同上',
  steward_config_set: '管家工具:同上(配置改动另有审计事件)',
  steward_skill_toggle: '管家工具:同上',
  steward_quick_ask: '管家工具:开一条速查线程,那条线程自己的工具调用在它的回合里进账',
};
const HANDLER_WITHOUT_SCHEMA = ['list_tools', 'tool_search', 'tool_load', 'tool_invoke_read', 'tool_invoke_edit', 'tool_invoke_exec', 'file_search', 'spawn_agent', 'skill_read'];

test('[M1] 不可逆账只收真工具,且都是 exec 档', () => {
  for (const name of Object.keys(IRREVERSIBLE_NATIVE_KIND)) {
    assert.ok(handlers.includes(name), `${name} 不是已注册的内建工具`);
    assert.equal(tierOf(name), 'exec', `${name} 进了不可逆账,但风险档是 ${tierOf(name)}`);
  }
});

test('[M2] 每个 exec 档内建工具都明确决定过进不进账', () => {
  const undecided = handlers.filter(n => tierOf(n) === 'exec'
    && !Object.prototype.hasOwnProperty.call(IRREVERSIBLE_NATIVE_KIND, n)
    && !Object.prototype.hasOwnProperty.call(EXEC_NOT_LEDGERED, n));
  assert.deepEqual(undecided, [], '新的 exec 工具:进不可逆账(02f-turn-effect-kinds IRREVERSIBLE_NATIVE_KIND)或在本文件 EXEC_NOT_LEDGERED 写明理由');
  for (const name of Object.keys(EXEC_NOT_LEDGERED)) {
    assert.equal(tierOf(name), 'exec', `EXEC_NOT_LEDGERED 里的 ${name} 已不是 exec 档,清单该删了`);
  }
});

test('[M3] 回合摘要的两张表只收真工具、档位对得上', () => {
  for (const name of TURN_SUMMARY_FILE_TOOLS) assert.equal(tierOf(name), 'edit', `文件变更表里的 ${name}`);
  for (const name of TURN_SUMMARY_COMMAND_TOOLS) assert.equal(tierOf(name), 'exec', `命令表里的 ${name}`);
});

test('[M4] 没有原生 schema 的 handler 只能是既知的元工具', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13f-native-tool-schemas.js'), 'utf8');
  const schemaNames = new Set([...src.matchAll(/^\s{4}name: '([a-z_0-9]+)'/gm)].map(m => m[1]));
  assert.ok(schemaNames.size > 50, `schema 名抽取失败(只抽到 ${schemaNames.size} 个)`);
  assert.deepEqual(handlers.filter(n => !schemaNames.has(n)).sort(), [...HANDLER_WITHOUT_SCHEMA].sort());
  assert.deepEqual([...schemaNames].filter(n => !handlers.includes(n)), [], '有 schema 却没有 handler');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
