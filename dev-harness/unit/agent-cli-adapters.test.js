'use strict';
// 架构还债批 3 A:Agent CLI 适配器(05 AGENT_CLI_ADAPTERS)。runClaudeTurn 是 Claude Code / Kimi Code 两个命令行引擎
// 共用的唯一回合骨架,原先在一个函数体里按 `agentCliType === 'claude' | 'kimi'` 分叉三十来处;现在骨架只问适配器。
// 真源码、临时 HOME、零网络、不起 CLI。
//
// 判据:
//   [S] 方法集:两个适配器的键集合逐项相同、与下面登记的接口清单相同、各键类型一致(可选钩子 null|function);
//       适配器表的键与 01 AGENT_CLI_TYPES 的键相同(登记一个新 CLI 类型就必须给它一份适配器)。
//   [A] 命令行参数金样:buildArgs(输出格式/交互输入/部分消息/betas/MCP/权限桥/权限模式映射/模型/思考强度/轮数)、
//       resumeArgs(--resume vs --session)、extraArgs、appendSystemPromptFlag、cmdLineBudget、prepareSpawn。
//   [E] 子进程环境金样:第三方端点 bearer / x-api-key / auto、Kimi Coding 端点的全家族模型改写、Bedrock/Vertex 清空、
//       MAX_THINKING_TOKENS、骨架共有项的先后;Kimi 一律原样继承 process.env。
//   [P] 事件解析金样:一组 Claude stream-json 行(含 fixtures/fake-claude-long-process.jsonl 与 tools/fake-claude.js
//       出现过的全部形状)与一组 Kimi stream-json 行,逐行钉死解析结果;适配器解析与兼容出口 parseAgentCliEvent 同步。
//   [U] 用量记账金样:有结果帧 → 真实行(cachedInTok = 读 + 创建);无结果帧 → 估算行;都没有 → 不记;Kimi 不记。
//   [M] 其余决定:交互模式、斜杠原样、stdin 送提示、原生子代理工具、续接丢失判定、思考强度显示、旁路观察、回合后用量。
//   [G] 骨架形状:runClaudeTurn 函数体里不再出现按 CLI 类型分叉的比较。
// 金样由抽适配器前(基线提交)的 runClaudeTurn 行为得出:抽取期间另用差分脚本把新旧两份 server.js 各跑 34 个回合
// (拦截 spawn,逐项比较命令/参数/环境/stdin/事件流/落盘消息/用量账/Kimi 设置文件),归一化后逐字节相同。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-adapters-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'MAX_THINKING_TOKENS', 'WCW_CLAUDE_CMDLINE_BUDGET']) delete process.env[k];
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const { AGENT_CLI_ADAPTERS, agentCliAdapter, AGENT_CLI_TYPES, parseAgentCliEvent } = srv;
const claude = AGENT_CLI_ADAPTERS.claude;
const kimi = AGENT_CLI_ADAPTERS.kimi;
const plain = v => JSON.parse(JSON.stringify(v));   // 解析结果里的 undefined 字段(如缺 arguments 的 tool_use.input)按线上 JSON 口径比

const INTERFACE = {
  id: 'string', interactive: 'function', slashCommandVerbatim: 'boolean', buildArgs: 'function', resumeArgs: 'function',
  extraArgs: 'function', prepareSpawn: 'function', cmdLineBudget: 'function', appendSystemPromptFlag: 'string',
  runPreparedTurn: 'optional', buildAgentDefinitions: 'function', buildEnv: 'function', beforeSpawn: 'optional',
  thinkingEffortLabel: 'function', watchSideChannel: 'function', promptViaStdin: 'boolean', isNativeAgentTool: 'function',
  parseEvent: 'function', isResumeMissingError: 'function', syncPostTurnUsage: 'optional', recordTurnUsage: 'function',
};

test('[S] 两个适配器方法集逐项相同,且与登记的接口清单、AGENT_CLI_TYPES 对齐', () => {
  assert.deepEqual(Object.keys(AGENT_CLI_ADAPTERS).sort(), Object.keys(AGENT_CLI_TYPES).sort(), '每个登记的 CLI 类型都有一份适配器');
  const want = Object.keys(INTERFACE).sort();
  for (const [id, adapter] of Object.entries(AGENT_CLI_ADAPTERS)) {
    assert.equal(adapter.id, id);
    assert.deepEqual(Object.keys(adapter).sort(), want, `${id} 的键集合 = 接口清单`);
    assert.ok(Object.isFrozen(adapter), `${id} 冻结`);
    for (const [key, kind] of Object.entries(INTERFACE)) {
      const value = adapter[key];
      if (kind === 'optional') assert.ok(value === null || typeof value === 'function', `${id}.${key} 是 null 或函数`);
      else assert.equal(typeof value, kind, `${id}.${key} 是 ${kind}`);
    }
  }
  assert.ok(Object.isFrozen(AGENT_CLI_ADAPTERS));
  assert.equal(agentCliAdapter('claude'), claude);
  assert.equal(agentCliAdapter('kimi'), kimi);
  assert.equal(agentCliAdapter('unknown'), claude, '未知类型同 selectedAgentCli 口径归到 claude');
  assert.equal(agentCliAdapter(undefined), claude);
});

const BRIDGE = ['--permission-prompt-tool', 'mcp__win-claude-workbench__permission_prompt'];
const HEAD = ['-p', '--output-format', 'stream-json', '--verbose'];
const noMcp = extra => ({ includeWorkbenchMcp: false, ...extra });

test('[A] Claude buildArgs 金样', async () => {
  const session = { id: 'sess_unitargs0001' };
  const build = (config, interactive = false) => claude.buildArgs({ config, session, basePrompt: 'hello', attachments: [], interactive });
  assert.deepEqual(await build(noMcp({ permissionMode: 'default', permissionBridge: true })),
    [...HEAD, ...BRIDGE, '--permission-mode', 'default']);
  assert.deepEqual(await build(noMcp({
    permissionMode: 'bypass', permissionBridge: true, includePartialMessages: true, betaInterleavedThinking: true,
    model: 'test-model-a', claudeThinkingEffort: 'high', maxTurns: 7,
  }), true), [...HEAD, '--input-format', 'stream-json', '--include-partial-messages', '--betas', 'interleaved-thinking',
    '--permission-mode', 'bypassPermissions', '--model', 'test-model-a', '--effort', 'high', '--max-turns', '7']);
  // 权限模式 × 权限桥:auto / bypass 不挂桥;内部名经 CLAUDE_PERMISSION_MODE_MAP 映射;空模式不传 --permission-mode。
  const MODES = { default: 'default', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', bypass: 'bypassPermissions', dontAsk: 'dontAsk', '': null };
  for (const [mode, cliMode] of Object.entries(MODES)) {
    for (const bridge of [true, false]) {
      const bridged = bridge && mode !== 'bypass' && mode !== 'auto';
      const want = [...HEAD, ...(bridged ? BRIDGE : []), ...(cliMode ? ['--permission-mode', cliMode] : [])];
      assert.deepEqual(await build(noMcp({ permissionMode: mode, permissionBridge: bridge })), want, `mode=${mode} bridge=${bridge}`);
    }
  }
  // 工作台 MCP:按会话落一份 MCP 配置;交互模式另禁原生 AskUserQuestion。
  const withMcp = await build({ includeWorkbenchMcp: true, permissionMode: 'plan', permissionBridge: false }, true);
  assert.deepEqual(withMcp.slice(0, 6), [...HEAD, '--input-format', 'stream-json']);
  assert.equal(withMcp[6], '--mcp-config');
  assert.match(withMcp[7], /workbench\.mcp\.sess_unitargs0001\.json$/);
  assert.ok(fs.existsSync(withMcp[7]), 'MCP 配置已落盘');
  assert.deepEqual(withMcp.slice(8), ['--disallowedTools', 'AskUserQuestion', '--permission-mode', 'plan']);
  const printMcp = await build({ includeWorkbenchMcp: true, permissionMode: 'plan', permissionBridge: false }, false);
  assert.deepEqual([...printMcp.slice(0, 5), ...printMcp.slice(6)], [...HEAD, '--mcp-config', '--permission-mode', 'plan']);
});

test('[A] Kimi buildArgs 为空;续接/额外参数/追加系统提示/命令行预算/起进程', async () => {
  assert.deepEqual(await kimi.buildArgs({ config: { permissionMode: 'default', permissionBridge: true, model: 'x', includeWorkbenchMcp: true }, session: { id: 's' }, basePrompt: '', attachments: [], interactive: false }), []);
  assert.deepEqual(claude.resumeArgs('sid-1'), ['--resume', 'sid-1']);
  assert.deepEqual(kimi.resumeArgs('sid-1'), ['--session', 'sid-1']);
  assert.deepEqual(claude.extraArgs({ extraClaudeArgs: ['--foo', 'bar'] }), ['--foo', 'bar']);
  assert.deepEqual(claude.extraArgs({ extraClaudeArgs: '--foo' }), []);
  assert.deepEqual(claude.extraArgs({}), []);
  assert.deepEqual(kimi.extraArgs({ extraClaudeArgs: ['--foo'] }), []);
  assert.equal(claude.appendSystemPromptFlag, '--append-system-prompt');
  assert.equal(kimi.appendSystemPromptFlag, '', 'Kimi 的追加系统提示改走 stdin <ruyi-agent-cli-instructions> 段');
  for (const cmd of ['C:\\npm\\claude.cmd', 'C:\\tools\\claude.exe', 'claude']) {
    assert.equal(claude.cmdLineBudget(cmd), srv.cmdLineBudgetFor(cmd), `Claude 预算 = cmdLineBudgetFor(${cmd})`);
    assert.equal(kimi.cmdLineBudget(cmd), 0, 'Kimi(ACP 走 stdin)不设防');
  }
  process.env.WCW_CLAUDE_CMDLINE_BUDGET = '2600';
  try {
    assert.equal(claude.cmdLineBudget('whatever'), 2600, '测试缝强制预算对 Claude 生效');
    assert.equal(kimi.cmdLineBudget('whatever'), 0, '测试缝不改 Kimi 的不设防');
  } finally { delete process.env.WCW_CLAUDE_CMDLINE_BUDGET; }
  const args = ['-p', 'x y'];
  assert.deepEqual(claude.prepareSpawn('C:\\tools\\claude.exe', args), { command: 'C:\\tools\\claude.exe', args, opts: {} });
  assert.deepEqual(claude.prepareSpawn('C:\\npm\\claude.cmd', args), srv.prepareAgentCliSpawn('claude', 'C:\\npm\\claude.cmd', args));
  assert.deepEqual(kimi.prepareSpawn('X:\\tools\\kimi.exe', ['acp']), { command: 'X:\\tools\\kimi.exe', args: ['acp'], opts: {} });
  assert.deepEqual(kimi.prepareSpawn('kimi', ['acp']), srv.prepareAgentCliSpawn('kimi', 'kimi', ['acp']));
});

test('[E] 子进程环境金样', () => {
  const saved = { CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX };
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  try {
    const common = { WIN_CLAUDE_WORKBENCH_HOME: 'H:\\data' };
    const pick = (env, keys) => Object.fromEntries(keys.map(k => [k, env[k]]));
    const KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'MAX_THINKING_TOKENS', 'WIN_CLAUDE_WORKBENCH_HOME', 'CLAUDE_CODE_SUBAGENT_MODEL'];
    const bearer = claude.buildEnv({ modelsApiBase: 'https://proxy.example.test/v1', modelsApiKey: 'sk-1', claudeAuthMode: 'bearer', model: 'test-model-a', thinkingBudget: 2048 }, common);
    assert.deepEqual(pick(bearer, KEYS), {
      ANTHROPIC_BASE_URL: 'https://proxy.example.test/v1', ANTHROPIC_AUTH_TOKEN: 'sk-1', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'test-model-a',
      CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', MAX_THINKING_TOKENS: '2048', WIN_CLAUDE_WORKBENCH_HOME: 'H:\\data', CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    });
    // Windows 的 process.env 大小写不敏感(真键名通常是 Path),拷贝成普通对象后只认真键名 —— 按真键名比。
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    assert.equal(bearer[pathKey], process.env[pathKey], '其余键原样继承');
    const xkey = claude.buildEnv({ modelsApiBase: 'https://gw.example.test', modelsApiKey: 'sk-2', claudeAuthMode: 'x-api-key', model: 'm-2' }, common);
    assert.deepEqual(pick(xkey, KEYS.slice(0, 7)), {
      ANTHROPIC_BASE_URL: 'https://gw.example.test', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: 'sk-2', ANTHROPIC_MODEL: 'm-2',
      CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', MAX_THINKING_TOKENS: undefined,
    });
    const auto = claude.buildEnv({ modelsApiBase: 'https://gw.example.test', modelsApiKey: 'sk-3', claudeAuthMode: 'auto' }, common);
    assert.deepEqual(pick(auto, KEYS.slice(0, 4)), { ANTHROPIC_BASE_URL: 'https://gw.example.test', ANTHROPIC_AUTH_TOKEN: 'sk-3', ANTHROPIC_API_KEY: 'sk-3', ANTHROPIC_MODEL: undefined });
    const kimiCoding = claude.buildEnv({ modelsApiBase: 'https://api.kimi.com/coding/', modelsApiKey: 'sk-4', claudeAuthMode: 'auto', model: 'k-model' }, common);
    assert.deepEqual(pick(kimiCoding, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']), {
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/', ANTHROPIC_API_KEY: 'sk-4', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: 'k-model',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'k-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'k-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'k-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'k-model', ANTHROPIC_SMALL_FAST_MODEL: 'k-model', CLAUDE_CODE_SUBAGENT_MODEL: 'k-model',
    });
    // 没配第三方端点:Bedrock/Vertex 不动,不凭空添 ANTHROPIC_*;thinkingBudget 为 0 不写 MAX_THINKING_TOKENS。
    const direct = claude.buildEnv({ thinkingBudget: 0 }, common);
    assert.deepEqual(pick(direct, KEYS.slice(0, 7)), {
      ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: undefined,
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', MAX_THINKING_TOKENS: undefined,
    });
    // 先后:骨架共有项盖过继承值;MAX_THINKING_TOKENS 在共有项之后写(共有项里同名也以配置为准)。
    const order = claude.buildEnv({ thinkingBudget: 10 }, { MAX_THINKING_TOKENS: 'common', WIN_CLAUDE_WORKBENCH_HOME: 'X' });
    assert.equal(order.MAX_THINKING_TOKENS, '10');
    // Kimi:一律继承 process.env + 共有项,Claude 的第三方端点与思考预算都不碰。
    const k = kimi.buildEnv({ modelsApiBase: 'https://proxy.example.test', modelsApiKey: 'sk-k', model: 'kimi-code/k', thinkingBudget: 4096 }, common);
    assert.deepEqual(k, { ...process.env, ...common });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

// ---- [P] 事件解析:输入行 → 期望的内部事件(基线 parseAgentCliEvent 的输出) ----
const CLAUDE_ROWS = [
  [{ type: 'system', subtype: 'init', session_id: 'sid-A', tools: [], model: 'm' }, [{ kind: 'init', sessionId: 'sid-A', subtype: 'init' }]],
  [{ type: 'system', subtype: 'compact_boundary' }, [{ kind: 'unknown', raw: { type: 'system', subtype: 'compact_boundary' } }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 } } } },
    [{ kind: 'msg_usage', usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 } }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan: ' } } },
    [{ kind: 'thinking', text: 'plan: ', partial: true, index: 0 }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 0, delta: { type: 'reasoning_delta', reasoning: 'r' } } },
    [{ kind: 'thinking', text: 'r', partial: true, index: 0 }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'xx' } } },
    [{ kind: 'unknown', raw: { type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'xx' } } } }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } } },
    [{ kind: 'text', text: 'Hel', partial: true, index: 1 }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'message_delta', usage: { output_tokens: 33 } } }, [{ kind: 'msg_usage', usage: { output_tokens: 33 } }]],
  [{ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'bare' } }, [{ kind: 'text', text: 'bare', partial: true, index: 2 }]],
  [{ type: 'assistant', session_id: 'sid-A', message: { role: 'assistant', usage: { input_tokens: 120, output_tokens: 40 }, content: [
    { type: 'thinking', thinking: 'plan: ' }, { type: 'redacted_thinking', data: 'zz' }, { type: 'text', text: 'Hello' }, { type: 'reasoning', text: 'why' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }, { type: 'image' }, null] } }, [
    { kind: 'msg_usage', usage: { input_tokens: 120, output_tokens: 40 } }, { kind: 'thinking', text: 'plan: ', partial: false },
    { kind: 'thinking', text: '[redacted thinking]', partial: false, redacted: true }, { kind: 'text', text: 'Hello', partial: false },
    { kind: 'thinking', text: 'why', partial: false }, { kind: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]],
  [{ type: 'assistant', session_id: 'sid-A', message: { role: 'assistant', content: [] } },
    [{ kind: 'unknown', raw: { type: 'assistant', session_id: 'sid-A', message: { role: 'assistant', content: [] } } }]],
  [{ type: 'user', session_id: 'sid-A', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'a\nb' },
    { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [{ type: 'text', text: 'boom' }] }, { type: 'text', text: 'x' }] } }, [
    { kind: 'tool_result', id: 'toolu_1', content: 'a\nb', isError: false },
    { kind: 'tool_result', id: 'toolu_2', content: [{ type: 'text', text: 'boom' }], isError: true }]],
  [{ type: 'user', session_id: 'sid-A', message: { role: 'user', content: '<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>toolu_ag</tool-use-id>\n<output-file>C:\\fake\\x1.output</output-file>\n<status>completed</status>\n<summary>s</summary>\n<result>r &amp; done</result>\n</task-notification>' } },
    [{ kind: 'subagent_notification', taskId: 'x1', toolUseId: 'toolu_ag', outputFile: 'C:\\fake\\x1.output', status: 'completed', summary: 's', note: '', result: 'r & done', resultChars: 8, resultTruncated: false, failed: false }]],
  [{ type: 'user', session_id: 'sid-A', message: { role: 'user', content: 'plain user text' } },
    [{ kind: 'unknown', raw: { type: 'user', session_id: 'sid-A', message: { role: 'user', content: 'plain user text' } } }]],
  [{ type: 'result', subtype: 'success', is_error: false, result: 'Hello world', session_id: 'sid-A', duration_ms: 1234, num_turns: 3, total_cost_usd: 0.0456,
    usage: { input_tokens: 812, output_tokens: 214, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 } },
  [{ kind: 'result', sessionId: 'sid-A', ok: true, subtype: 'success', result: 'Hello world',
    usage: { input_tokens: 812, output_tokens: 214, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 }, costUsd: 0.0456, durationMs: 1234, numTurns: 3 }]],
  [{ type: 'result', subtype: 'error_during_execution', is_error: true, sessionId: 'sid-B', cost_usd: 0.01 },
    [{ kind: 'result', sessionId: 'sid-B', ok: false, subtype: 'error_during_execution', costUsd: 0.01 }]],
  [{ type: 'something_else', foo: 1 }, [{ kind: 'unknown', raw: { type: 'something_else', foo: 1 } }]],
  [{}, [{ kind: 'unknown', raw: {} }]],
  [null, [{ kind: 'unknown', raw: null }]],
  [42, [{ kind: 'unknown', raw: 42 }]],
  ['text', [{ kind: 'unknown', raw: 'text' }]],
];
const KIMI_ROWS = [
  [{ role: 'meta', type: 'system.version', version: '0.37.2' }, []],
  [{ role: 'meta', type: 'session.resume_hint', session_id: 'kimi-sess-1' }, [{ kind: 'init', sessionId: 'kimi-sess-1', subtype: 'session.resume_hint' }]],
  [{ role: 'meta', type: 'session.resume_hint', sessionId: 'kimi-sess-2' }, [{ kind: 'init', sessionId: 'kimi-sess-2', subtype: 'session.resume_hint' }]],
  [{ role: 'meta', type: 'session.resume_hint' }, []],
  [{ role: 'meta', type: 'turn.step.retrying', next_attempt: 2, max_attempts: 3, error_message: 'rate limited' }, [{ kind: 'diagnostic', text: 'Kimi 正在重试(2 / 3)：rate limited' }]],
  [{ role: 'meta', type: 'turn.step.retrying', error_name: 'Timeout' }, [{ kind: 'diagnostic', text: 'Kimi 正在重试(? / ?)：Timeout' }]],
  [{ role: 'assistant', content: 'Looking.', tool_calls: [
    { id: 't1', function: { name: 'ReadFile', arguments: '{"path":"a.txt"}' } }, { id: 't2', function: { name: 'Agent', arguments: { prompt: 'sub' } } },
    { id: 't3', function: { name: 'Shell', arguments: 'not-json' } }, { id: 't4' }] }, [
    { kind: 'text', text: 'Looking.', partial: false }, { kind: 'tool_use', id: 't1', name: 'ReadFile', input: { path: 'a.txt' } },
    { kind: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'sub' } }, { kind: 'tool_use', id: 't3', name: 'Shell', input: 'not-json' },
    { kind: 'tool_use', id: 't4', name: '' }]],
  [{ role: 'assistant', content: '' }, []],
  [{ role: 'assistant', content: ['array'] }, []],
  [{ role: 'tool', tool_call_id: 't1', content: 'file body' }, [{ kind: 'tool_result', id: 't1', content: 'file body', isError: false }]],
  [{ role: 'user', content: 'x' }, [{ kind: 'unknown', raw: { role: 'user', content: 'x' } }]],
  [{ type: 'result', subtype: 'success', result: 'claude-shaped' }, [{ kind: 'unknown', raw: { type: 'result', subtype: 'success', result: 'claude-shaped' } }]],
  [{}, [{ kind: 'unknown', raw: {} }]],
  [null, [{ kind: 'unknown', raw: null }]],
  [7, [{ kind: 'unknown', raw: 7 }]],
];

test('[P] 事件解析金样(Claude stream-json / Kimi stream-json),适配器与兼容出口同步', () => {
  for (const [row, want] of CLAUDE_ROWS) {
    assert.deepEqual(plain(claude.parseEvent(row)), want, `claude ${JSON.stringify(row).slice(0, 80)}`);
    assert.deepEqual(plain(parseAgentCliEvent(row, 'claude')), want);
    assert.deepEqual(plain(parseAgentCliEvent(row)), want, '缺省驱动 = claude');
  }
  for (const [row, want] of KIMI_ROWS) {
    assert.deepEqual(plain(kimi.parseEvent(row)), want, `kimi ${JSON.stringify(row).slice(0, 80)}`);
    assert.deepEqual(plain(parseAgentCliEvent(row, 'kimi')), want);
  }
  for (const [row] of [...CLAUDE_ROWS, ...KIMI_ROWS]) {
    assert.deepEqual(plain(parseAgentCliEvent(row, 'nope')), [{ kind: 'unknown', raw: row }], '未知驱动一律 unknown');
  }
  // 两份解析器互不认对方的行形(交叉喂:Claude 行给 Kimi 解析器 → 只认 role 字段,Claude 行没有 → unknown)。
  const init = CLAUDE_ROWS[0][0];
  assert.deepEqual(kimi.parseEvent(init), [{ kind: 'unknown', raw: init }]);
  assert.deepEqual(claude.parseEvent(KIMI_ROWS[1][0]), [{ kind: 'unknown', raw: KIMI_ROWS[1][0] }]);
  // 夹具 fixtures/fake-claude-long-process.jsonl(真 CLI 线上形状)逐行可解析,且不产生 unknown。
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'fake-claude-long-process.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  assert.ok(fixture.length > 10);
  for (const row of fixture) {
    const out = claude.parseEvent(row);
    assert.ok(out.length && out.every(e => e.kind !== 'unknown'), `fixture row ${row.type} 解析为已知事件`);
    assert.deepEqual(out, parseAgentCliEvent(row, 'claude'));
  }
});

function ledgerRows() {
  const dir = path.join(root, 'usage');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
}
async function waitRows(n) {
  for (let i = 0; i < 100 && ledgerRows().length < n; i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 60));
  return ledgerRows();
}

test('[U] 用量记账金样', async () => {
  const strip = r => { const { ts, ...rest } = r; assert.match(ts, /^\d{4}-\d{2}-\d{2}T/); return rest; };
  claude.recordTurnUsage({ session: { id: 'sess_u1', turnSeq: 3 }, config: { model: 'test-model-u' }, billInMax: 1, billOutMax: 1,
    usage: { usage: { input_tokens: 812, output_tokens: 214, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 }, costUsd: 0.0456 } });
  claude.recordTurnUsage({ session: { id: 'sess_u2', turnSeq: 1 }, config: { model: 'test-model-n', modelsApiBase: '' }, usage: null, billInMax: 300, billOutMax: 55 });
  claude.recordTurnUsage({ session: { id: 'sess_u3', turnSeq: 1 }, config: { modelsApiBase: 'https://proxy.example.test/v1' }, billInMax: 0, billOutMax: 0,
    usage: { usage: { input_tokens: 10, output_tokens: 2 }, costUsd: 0.5 } });
  claude.recordTurnUsage({ session: { id: 'sess_u4', turnSeq: 1 }, config: {}, usage: null, billInMax: 0, billOutMax: 0 });
  claude.recordTurnUsage({ session: { id: 'sess_u5', turnSeq: 1 }, config: {}, usage: { costUsd: 1 }, billInMax: 0, billOutMax: 0 });
  kimi.recordTurnUsage({ session: { id: 'sess_u6', turnSeq: 1 }, config: {}, usage: { usage: { input_tokens: 5, output_tokens: 5 } }, billInMax: 9, billOutMax: 9 });
  const rows = (await waitRows(3)).map(strip);
  assert.deepEqual(rows, [
    { sessionId: 'sess_u1', engine: 'claude', provider: 'claude-cli', model: 'test-model-u', inTok: 812, outTok: 214, cachedInTok: 600, cost: 0.0456, currency: 'USD', costTrusted: true, estimated: false, turnSeq: 3, kind: 'turn' },
    { sessionId: 'sess_u2', engine: 'claude', provider: 'claude-cli', model: 'test-model-n', inTok: 300, outTok: 55, cachedInTok: 0, cost: null, currency: null, costTrusted: true, estimated: true, turnSeq: 1, kind: 'turn' },
    { sessionId: 'sess_u3', engine: 'claude', provider: 'claude-endpoint:proxy.example.test', model: '', inTok: 10, outTok: 2, cachedInTok: 0, cost: null, currency: null, costTrusted: false, estimated: false, turnSeq: 1, kind: 'turn' },
  ], '有结果帧记真实行、无结果帧有计费下限记估算行、都没有不记;Kimi 不记');
});

test('[M] 其余逐 CLI 决定', async () => {
  assert.equal(claude.interactive({ engineMode: 'interactive' }), true);
  assert.equal(claude.interactive({ engineMode: 'legacy' }), false);
  assert.equal(kimi.interactive({ engineMode: 'interactive' }), false);
  assert.equal(claude.slashCommandVerbatim, false);
  assert.equal(kimi.slashCommandVerbatim, true);
  assert.equal(claude.promptViaStdin, true);
  assert.equal(kimi.promptViaStdin, false);
  assert.equal(claude.thinkingEffortLabel({ claudeThinkingEffort: 'xhigh' }), 'xhigh');
  assert.equal(claude.thinkingEffortLabel({ claudeThinkingEffort: '' }), 'default');
  assert.equal(kimi.thinkingEffortLabel({ claudeThinkingEffort: 'xhigh' }), 'cli-managed');
  for (const name of ['Agent', 'Task']) { assert.equal(claude.isNativeAgentTool(name), true); assert.equal(kimi.isNativeAgentTool(name), false); }
  for (const name of ['TaskOutput', 'Bash', '', undefined]) assert.equal(claude.isNativeAgentTool(name), false);
  const miss = 'No conversation found with session ID: abc';
  assert.equal(claude.isResumeMissingError(miss), true);
  assert.equal(claude.isResumeMissingError('Error: session ID abc does not exist'), true);
  assert.equal(claude.isResumeMissingError('auth failed: bad key'), false);
  assert.equal(kimi.isResumeMissingError(miss), false, 'Kimi 不走「去掉续接重试一次」');
  assert.equal(claude.runPreparedTurn, null);
  assert.equal(claude.beforeSpawn, null);
  assert.equal(claude.syncPostTurnUsage, null);
  assert.equal(typeof kimi.runPreparedTurn, 'function', 'Kimi 由 ACP(05b)接管回合');
  assert.equal(typeof kimi.beforeSpawn, 'function');
  assert.equal(await kimi.syncPostTurnUsage({ id: 's', claudeSessionId: null }, {}, () => {}), null, '没有原生会话 id 不去取用量');
  const events = [];
  const stopClaude = claude.watchSideChannel({ claudeSessionId: 'x' }, e => events.push(e));
  const stopKimi = kimi.watchSideChannel({ claudeSessionId: null }, e => events.push(e));
  assert.equal(typeof stopClaude, 'function'); assert.equal(typeof stopKimi, 'function');
  stopClaude(); stopKimi();
  assert.deepEqual(events, []);
  assert.deepEqual(await kimi.buildAgentDefinitions(root, {}, 6000), { definitions: {}, roles: [], omitted: [] });
  const cfg = srv.normalizeConfig({ defaultWorkspace: root }).config;
  assert.deepEqual(await claude.buildAgentDefinitions(root, cfg, 6000), await srv.buildClaudeAgentDefinitions(root, cfg, 6000));
});

test('[G] runClaudeTurn 骨架不再按 CLI 类型分叉', () => {
  const src = fs.readFileSync(path.join(app, 'src', '05-claude-engine.js'), 'utf8');
  const start = src.indexOf('async function runClaudeTurn(');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  const body = src.slice(start, end).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(body, /agentCliType\s*[!=]==/, '按 agentCliType 比较的分叉都进适配器');
  assert.doesNotMatch(body, /[!=]==\s*'(?:claude|kimi)'/, '不与 CLI 名字面量比较');
  for (const call of ['effectiveAnthropicEnv(', 'parseAgentCliEvent(', 'parseClaudeEvent(', 'watchKimiWire(', 'syncKimiSessionUsage(',
    'syncMcpServersToKimi(', 'syncKimiTurnPreferences(', 'runKimiAcpTurnPrepared(', 'buildClaudeAgentDefinitions(', 'prepareAgentCliSpawn(',
    'cmdLineBudgetFor(', 'isClaudeResumeMissingError(', 'appendUsageLedger(']) {
    assert.ok(!body.includes(call), `骨架不直接调 ${call.slice(0, -1)}(经适配器)`);
  }
  assert.match(body, /const adapter = agentCliAdapter\(agentCliType\);/);
});

test.after(() => { try { srv.flushUsageLedgerSync(); } catch { /* ignore */ } fs.rmSync(root, { recursive: true, force: true }); });
