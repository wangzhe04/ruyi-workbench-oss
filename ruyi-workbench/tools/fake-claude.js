#!/usr/bin/env node
'use strict';
/*
 * fake-claude.js — offline scenario replayer for testing the workbench with NO real Claude CLI.
 *
 * Spawned (via `node fake-claude.js`) when WCW_FAKE_CLAUDE points at it. Reads the user turn from
 * stdin and streams a canned stream-json scenario to stdout so the parser / renderer / tool-cards /
 * thinking panel / debug panel / interactive AskUserQuestion round-trip can be exercised end to end.
 *
 * Scenario: env WCW_FAKE_SCENARIO = happy | thinking | tools | error | ask, OR a path to a .jsonl
 * fixture captured from a REAL claude (wire-truth). A keyword in the prompt also selects the scenario.
 * WCW_FAKE_INTERACTIVE=1 (set by the workbench in interactive engine mode) enables the ask round-trip.
 */
const fs = require('fs');
const readline = require('readline');
if (process.env.WCW_FAKE_ARGV_CAPTURE) { try { fs.writeFileSync(process.env.WCW_FAKE_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2), null, 2)); } catch {} }
// Lets a test assert exactly which Anthropic-endpoint env vars this child actually received (e.g. that
// buildClaudeCliEnv's config-driven overrides reached the spawned process instead of a stale OS value).
if (process.env.WCW_FAKE_ENV_CAPTURE) {
  try {
    const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
    const snapshot = {}; for (const k of keys) snapshot[k] = process.env[k] ?? null;
    fs.writeFileSync(process.env.WCW_FAKE_ENV_CAPTURE, JSON.stringify(snapshot, null, 2));
  } catch { /* ignore */ }
}

// WCW_FAKE_SID pins the emitted session id: lets a test emulate --resume fidelity (the real CLI reports the
// SAME id across resumed turns; the random default emulates a fresh conversation each spawn).
const SID = process.env.WCW_FAKE_SID || 'fake-' + Math.random().toString(16).slice(2, 10);
const initEvt = { type: 'system', subtype: 'init', session_id: SID, tools: [], model: 'fake-model' };
const resultEvt = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SID,
  duration_ms: 2400, num_turns: 1, total_cost_usd: 0.0123, usage: { input_tokens: 812, output_tokens: 214 } });

function emit(evt) { process.stdout.write(JSON.stringify(evt) + '\n'); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function textDeltas(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 12) {
    out.push({ type: 'stream_event', session_id: SID, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: str.slice(i, i + 12) } } });
  }
  return out;
}
function thinkingDeltas(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 16) {
    out.push({ type: 'stream_event', session_id: SID, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: str.slice(i, i + 16) } } });
  }
  return out;
}
function assistantText(str) {
  return { type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: str }] } };
}

const REPLY = [
  '## 你好，我是 Claude 工作台\n',
  '这是一个**离线测试**回合，用来验证渲染与流式。\n\n',
  '- 支持 Markdown 列表\n- 代码高亮：\n\n',
  '```python\ndef greet(name):\n    print(f"hi {name}")\n```\n\n',
  '以及 `行内代码` 与 [链接文本](https://example.com)。\n',
].join('');

function build(scenario) {
  const events = [initEvt];
  if (scenario === 'thinking') {
    events.push(...thinkingDeltas('让我想想：先读取项目结构，再定位启动脚本，最后给出修复建议。'));
    events.push(...textDeltas(REPLY));
    events.push(assistantText(REPLY));
    events.push(resultEvt(REPLY));
  } else if (scenario === 'tools') {
    const toolId = 'toolu_fake1';
    events.push({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [
      { type: 'text', text: '我先看一下当前目录。\n' },
      { type: 'tool_use', id: toolId, name: 'powershell_run', input: { command: 'Get-ChildItem', cwd: 'C:\\demo' } },
    ] } });
    events.push({ type: 'user', session_id: SID, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolId, is_error: false, content: 'Mode  LastWriteTime  Name\n----  -------------  ----\nd---- 2026/07/02     src\n-a--- 2026/07/02     package.json' },
    ] } });
    events.push(...textDeltas('目录里有 `src/` 和 `package.json`。看起来是个 Node 项目。\n'));
    events.push(resultEvt('目录里有 src/ 和 package.json。'));
  } else if (scenario === 'error') {
    events.push({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: '尝试执行时出错。' }] } });
    events.push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SID, result: '模拟错误：命令返回非零退出码。' });
  } else if (scenario === 'agents') {
    const toolId = 'toolu_agent1';
    events.push({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [
      { type: 'tool_use', id: toolId, name: 'Agent', input: { subagent_type: 'reviewer', description: '审查改动', prompt: '检查这次改动的风险' } },
    ] } });
    events.push({ type: 'user', session_id: SID, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolId, is_error: false, content: '审查完成：没有阻断问题。' },
    ] } });
    events.push(resultEvt('审查完成。'));
  } else {
    events.push(...textDeltas(REPLY));
    events.push(assistantText(REPLY)); // whole message — should be deduped against the deltas
    events.push(resultEvt(REPLY));
  }
  return events;
}

function scenarioFromEnvAndPrompt(prompt) {
  let scenario = process.env.WCW_FAKE_SCENARIO || 'happy';
  for (const k of ['thinking', 'tools', 'error', 'ask', 'agents', 'steer']) if (prompt.includes(k)) scenario = k;
  return scenario;
}

// Keyword scenario selection must look at the USER's actual message ONLY. Workbench wrappers around it
// (recovery history, the 第35波 <workbench-context> index injection) legitimately contain 'agents'
// (orchestrate_agents) / 'tools' etc., which would otherwise hijack the scenario (last match wins).
function extractUserText(raw) {
  let text = String(raw || '');
  try {
    const env = JSON.parse(text); // interactive stream-json envelope
    const c = env && env.message && env.message.content;
    if (Array.isArray(c) && c[0] && typeof c[0].text === 'string') text = c[0].text;
    else if (typeof c === 'string') text = c;
  } catch { /* legacy plain-text prompt */ }
  // LAST match wins: wrapper texts may legitimately MENTION the delimiter (the workbench-context intro used
  // to); the real user-message delimiter is always the final one.
  const matches = [...text.matchAll(/<current_user_message>\s*([\s\S]*?)\s*<\/current_user_message>/g)];
  const m = matches.length ? matches[matches.length - 1] : null;
  return (m ? m[1] : text).toLowerCase();
}

function loadFixture(pathname) {
  return fs.readFileSync(pathname, 'utf8').split(/\r?\n/).filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function replay(events, delay = 35) {
  for (const evt of events) { emit(evt); await sleep(delay); }
}

// Line-buffered stdin so we can read the initial user turn AND a later tool_result (interactive).
function makeStdin() {
  const rl = readline.createInterface({ input: process.stdin });
  const queue = [];
  let waiter = null;
  rl.on('line', (line) => {
    if (waiter) { const w = waiter; waiter = null; w(line); }
    else queue.push(line);
  });
  return {
    next(timeoutMs = 5000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise(resolve => {
        waiter = resolve;
        setTimeout(() => { if (waiter === resolve) { waiter = null; resolve(''); } }, timeoutMs);
      });
    },
    // Like next() but resolves null on timeout, so genuinely EMPTY lines ('' — the prompt's blank
    // separator lines) don't terminate a drain loop early.
    nextOrNull(timeoutMs = 5000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise(resolve => {
        waiter = resolve;
        setTimeout(() => { if (waiter === resolve) { waiter = null; resolve(null); } }, timeoutMs);
      });
    },
  };
}

async function main() {
  const interactive = process.env.WCW_FAKE_INTERACTIVE === '1';
  const stdin = makeStdin();
  const firstLine = await stdin.next(1500); // the user envelope (interactive) or raw prompt (legacy)
  let fullStdinText = String(firstLine || '');
  if (process.env.WCW_FAKE_STDIN_CAPTURE || !interactive) {
    try {
      if (!interactive) {
        // Legacy print mode: the workbench writes the WHOLE prompt in one stdin write — possibly multi-line
        // (recovery history, <workbench-context> index injection, <current_user_message>). Drain it all so
        // tests can assert on any section AND keyword scenario selection sees the user message (which sits
        // AFTER the injected wrappers). Interactive keeps the raw envelope line (tests JSON.parse it).
        for (;;) { const more = await stdin.nextOrNull(150); if (more === null) break; fullStdinText += '\n' + more; }
      }
      if (process.env.WCW_FAKE_STDIN_CAPTURE) fs.writeFileSync(process.env.WCW_FAKE_STDIN_CAPTURE, fullStdinText, 'utf8');
    } catch {}
  }
  const prompt = extractUserText(interactive ? firstLine : fullStdinText);
  const scenario = scenarioFromEnvAndPrompt(prompt);
  // 47a 测试缝:WCW_FAKE_SLOW_MS 整体放慢(默认 0 关闭)—— 给 steer 等并发操作确定性窗口,防时序 flake。
  const slowMs = Number(process.env.WCW_FAKE_SLOW_MS) || 0;
  if (slowMs > 0) await sleep(slowMs);

  if (scenario.endsWith('.jsonl') && fs.existsSync(scenario)) {
    await replay(loadFixture(scenario));
    process.exit(0);
  }

  if (interactive && scenario === 'ask') {
    emit(initEvt);
    await replay(textDeltas('好的，我需要先确认一下你的偏好。\n'), 25);
    const askId = 'toolu_ask1';
    emit({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [
      { type: 'tool_use', id: askId, name: 'AskUserQuestion', input: { questions: [
        { header: '框架', question: '用哪个前端框架？', options: [{ label: 'React' }, { label: 'Vue' }, { label: '原生 JS' }], multiSelect: false },
      ] } },
    ] } });
    // wait for the workbench to write the documented text user envelope on stdin
    const ans = await stdin.next(60000);
    let chosen = '(超时未答)';
    try {
      const obj = JSON.parse(ans);
      const block = obj?.message?.content?.[0];
      chosen = typeof block?.text === 'string' ? block.text
        : (typeof block?.content === 'string' ? block.content : JSON.stringify(block?.content));
    } catch { chosen = ans || '(无)'; }
    await replay(textDeltas(`收到，你选择了 **${chosen}**。我按这个来实现。\n`), 25);
    emit(resultEvt(`用户选择了 ${chosen}。`));
    process.exit(0);
  }

  // 47a 探针:steer 剧本。慢速滴出正文(给测试留出 POST /api/steer 的窗口),然后循环吞读 stdin 上的
  // 插话 envelope(每来一条回声一条;静默 2s 才收工 —— 回合保活由本 fake 控制,测试连续注入多条无竞态)。
  // 全部原始行落盘 WCW_FAKE_STEER_CAPTURE(每行一条 envelope),断言注入内容/格式都靠它。
  if (interactive && scenario === 'steer') {
    emit(initEvt);
    await replay(textDeltas('正在处理任务,先输出第一段内容,给插话留出时间窗口。\n'), 120);
    const lines = [];
    const first = await stdin.next(30000);
    if (first) lines.push(first);
    if (lines.length) {
      for (;;) { const more = await stdin.nextOrNull(2000); if (more === null || more === '') break; lines.push(more); }
    }
    if (process.env.WCW_FAKE_STEER_CAPTURE) { try { fs.writeFileSync(process.env.WCW_FAKE_STEER_CAPTURE, lines.join('\n'), 'utf8'); } catch {} }
    const texts = lines.map(line => {
      try {
        const obj = JSON.parse(line);
        const block = obj && obj.message && obj.message.content && obj.message.content[0];
        return typeof (block && block.text) === 'string' ? block.text : '(非文本插话)';
      } catch { return String(line || '(空)'); }
    });
    if (!texts.length) texts.push('(未收到插话)');
    await replay(textDeltas(`收到插话 ${texts.length} 条:${texts.join(' / ')}。按插话调整后续方向。\n`), 25);
    emit(resultEvt(`steer round-trip: ${texts.join(' / ')}`));
    process.exit(0);
  }

  await replay(build(scenario));
  process.exit(0);
}
main();
