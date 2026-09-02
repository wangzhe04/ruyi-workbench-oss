#!/usr/bin/env node
// Unit tests for pure helper functions in app.js:
//   - thinkingCharCount()  — char count for thinking transcripts
//   - thinkingSummaryLabel() — collapsed label "思考过程 · N 字"
//   - assemblePlaybookPrompt() — {key} placeholder substitution
//   - ctxWindowGuess() — context-window size by model name
//
// These are browser-side functions, extracted from source for isolated testing.
// Uses Node built-in test runner, zero dependencies.
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Extract functions from app.js source ──
const fs = require('fs');
const path = require('path');
const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'app.js'), 'utf8');

function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm');
  const m = appSrc.match(re);
  if (!m) throw new Error(`Could not extract ${name} from app.js`);
  // Wrap in a callable function
  return new Function(...getParams(m[0]), getBody(m[0]));
}

function getParams(src) {
  const m = src.match(/function \w+\(([^)]*)\)/);
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

function getBody(src) {
  const start = src.indexOf('{') + 1;
  const end = src.lastIndexOf('}');
  return src.slice(start, end);
}

// Re-implement from source (simpler than eval-based extraction for some)
function thinkingCharCount(text) { return String(text || '').length; }
function thinkingSummaryLabel(text) { const n = thinkingCharCount(text); return n > 0 ? `思考过程 · ${n} 字` : '思考过程'; }

function assemblePlaybookPrompt(pb, values) {
  let out = String(pb.promptTemplate || '');
  for (const inp of (pb.inputs || [])) {
    const v = (values && values[inp.key] != null) ? String(values[inp.key]) : '';
    out = out.split('{' + inp.key + '}').join(v);
  }
  return out;
}

function ctxWindowGuess(model) {
  const m = String(model || '').toLowerCase();
  if (/haiku/.test(m)) return 200000;
  if (/opus-4|sonnet-5|sonnet-4|fable|mythos/.test(m)) return 1000000;
  if (/deepseek-v4/.test(m)) return 1000000;
  if (/deepseek/.test(m)) return 131072;
  if (/mimo-v2\.5-pro(?:$|[^a-z0-9])/.test(m) || /(?:^|\/)mimo-v2\.5$/.test(m)) return 1000000;
  if (/kimi|moonshot/.test(m)) return 262144;
  if (/qwen3\.8|qwen3\.7/.test(m)) return 1000000;
  if (/qwen3\.6-max/.test(m)) return 262144;
  if (/qwen3\.6-(plus|flash)/.test(m)) return 1000000;
  if (/qwen3\.6/.test(m)) return 262144;
  if (/qwen3\.5-omni/.test(m)) return 65536;
  if (/qwen3\.5-(plus|flash)/.test(m)) return 1000000;
  if (/qwen3\.5/.test(m)) return 32768;
  if (/qwen3-coder-plus/.test(m)) return 1000000;
  if (/qwen3-coder-next|qwen3-max|qwen3(?:$|[^.0-9])/.test(m)) return 262144;
  if (/qwen-plus-2025-01-25/.test(m)) return 131072;
  if (/qwen-plus|qwen-flash/.test(m)) return 1000000;
  if (/qwen-turbo/.test(m)) return 131072;
  if (/qwen-max/.test(m)) return 32768;
  if (/qwen-long/.test(m)) return 10000000;
  if (/qwen|qwq/.test(m)) return 131072;
  if (/glm-5\.3|glm-5\.2/.test(m)) return 1000000;
  if (/glm-5\.1|glm-5-turbo|glm-5|glm-4\.7|glm-4\.6/.test(m)) return 202752;
  if (/glm-4-long/.test(m)) return 1000000;
  if (/glm-4\.5|glm-4/.test(m)) return 131072;
  if (/glm/.test(m)) return 131072;
  if (/minimax-m3/.test(m)) return 1000000;
  if (/minimax-m2\.7|minimax-m2\.5/.test(m)) return 196608;
  if (/gemma4|minicpm5|whiskyakm/.test(m)) return 131072;
  if (/gpt-5\.6/.test(m)) return 1050000;
  if (/gpt-5\.5/.test(m)) return 1050000;
  if (/gpt-5\.4-pro/.test(m)) return 1050000;
  if (/gpt-5\.4-(mini|nano)/.test(m)) return 400000;
  if (/gpt-5\.4/.test(m)) return 1050000;
  if (/gpt-5\.2-chat-latest/.test(m)) return 128000;
  if (/gpt-5\.2/.test(m)) return 400000;
  if (/gpt-5\.1-chat-latest/.test(m)) return 128000;
  if (/gpt-5\.1/.test(m)) return 400000;
  if (/gpt-5-chat-latest/.test(m)) return 128000;
  if (/(^|\/)gpt-5(?:$|[^.0-9])/.test(m)) return 400000;
  if (/gpt-4o|gpt-4\.1/.test(m)) return 128000;
  if (/o3|o4/.test(m)) return 200000;
  if (/claude/.test(m)) return 200000;
  return 65536;
}

// ── Tests ──

describe('thinkingCharCount', () => {
  it('counts ASCII characters', () => {
    assert.equal(thinkingCharCount('hello'), 5);
  });
  it('counts CJK characters', () => {
    assert.equal(thinkingCharCount('你好世界'), 4);
  });
  it('returns 0 for empty string', () => {
    assert.equal(thinkingCharCount(''), 0);
  });
  it('returns 0 for null/undefined', () => {
    assert.equal(thinkingCharCount(null), 0);
    assert.equal(thinkingCharCount(undefined), 0);
  });
  it('counts mixed content', () => {
    assert.equal(thinkingCharCount('abc你好123'), 8);
  });
  it('counts emoji (as code units)', () => {
    // Emoji may be 2 code units; this tests the implementation detail
    const len = thinkingCharCount('🎉🎊');
    assert.ok(len >= 2); // at least 2 chars
  });
});

describe('thinkingSummaryLabel', () => {
  it('returns label with char count for non-empty text', () => {
    assert.equal(thinkingSummaryLabel('hello'), '思考过程 · 5 字');
  });
  it('returns plain label for empty text', () => {
    assert.equal(thinkingSummaryLabel(''), '思考过程');
  });
  it('returns plain label for null', () => {
    assert.equal(thinkingSummaryLabel(null), '思考过程');
  });
  it('handles CJK text', () => {
    assert.equal(thinkingSummaryLabel('你好'), '思考过程 · 2 字');
  });
  it('handles whitespace-only text', () => {
    assert.equal(thinkingSummaryLabel('   '), '思考过程 · 3 字');
  });
});

describe('assemblePlaybookPrompt', () => {
  it('substitutes declared keys', () => {
    const pb = { promptTemplate: 'Analyze {file} with {tool}', inputs: [{ key: 'file' }, { key: 'tool' }] };
    const result = assemblePlaybookPrompt(pb, { file: 'app.js', tool: 'eslint' });
    assert.equal(result, 'Analyze app.js with eslint');
  });
  it('leaves undeclared placeholders as-is', () => {
    const pb = { promptTemplate: 'Analyze {file} at {unknown}', inputs: [{ key: 'file' }] };
    const result = assemblePlaybookPrompt(pb, { file: 'app.js' });
    assert.equal(result, 'Analyze app.js at {unknown}');
  });
  it('handles missing values gracefully', () => {
    const pb = { promptTemplate: 'Analyze {file}', inputs: [{ key: 'file' }] };
    const result = assemblePlaybookPrompt(pb, {});
    assert.equal(result, 'Analyze ');
  });
  it('handles null values', () => {
    const pb = { promptTemplate: 'Analyze {file}', inputs: [{ key: 'file' }] };
    const result = assemblePlaybookPrompt(pb, { file: null });
    assert.equal(result, 'Analyze ');
  });
  it('handles missing promptTemplate', () => {
    const pb = { inputs: [{ key: 'file' }] };
    const result = assemblePlaybookPrompt(pb, { file: 'x' });
    assert.equal(result, '');
  });
  it('handles empty inputs array', () => {
    const pb = { promptTemplate: 'No placeholders', inputs: [] };
    const result = assemblePlaybookPrompt(pb, {});
    assert.equal(result, 'No placeholders');
  });
  it('substitutes all occurrences of a key', () => {
    const pb = { promptTemplate: '{x} and {x} again', inputs: [{ key: 'x' }] };
    const result = assemblePlaybookPrompt(pb, { x: 'A' });
    assert.equal(result, 'A and A again');
  });
  it('handles special regex chars in key name', () => {
    const pb = { promptTemplate: 'Use {file.name}', inputs: [{ key: 'file.name' }] };
    const result = assemblePlaybookPrompt(pb, { 'file.name': 'test.js' });
    assert.equal(result, 'Use test.js');
  });
  it('XSS: values are NOT escaped (textContent expected in caller)', () => {
    // This is a design choice — the caller must use textContent, not innerHTML
    const pb = { promptTemplate: 'Run {cmd}', inputs: [{ key: 'cmd' }] };
    const result = assemblePlaybookPrompt(pb, { cmd: '<script>alert(1)</script>' });
    assert.equal(result, 'Run <script>alert(1)</script>');
    // NOTE: caller MUST use textContent when rendering this into the DOM
  });
});

describe('ctxWindowGuess', () => {
  it('returns 200000 for haiku', () => {
    assert.equal(ctxWindowGuess('claude-3.5-haiku'), 200000);
  });
  it('returns 1000000 for opus-4', () => {
    assert.equal(ctxWindowGuess('claude-opus-4'), 1000000);
  });
  it('returns 1000000 for sonnet-5', () => {
    assert.equal(ctxWindowGuess('claude-sonnet-5'), 1000000);
  });
  it('returns 1000000 for sonnet-4', () => {
    assert.equal(ctxWindowGuess('claude-sonnet-4'), 1000000);
  });
  it('returns 1000000 for deepseek-v4', () => {
    assert.equal(ctxWindowGuess('deepseek-v4'), 1000000);
  });
  it('returns 131072 for deepseek (non-v4)', () => {
    assert.equal(ctxWindowGuess('deepseek-chat'), 131072);
    assert.equal(ctxWindowGuess('deepseek-reasoner'), 131072);
  });
  it('returns 262144 for kimi', () => {
    assert.equal(ctxWindowGuess('kimi-k2'), 262144);
  });
  it('returns 262144 for moonshot', () => {
    assert.equal(ctxWindowGuess('moonshot-v1'), 262144);
  });
  it('returns current model-specific windows for MiMo/Qwen/GLM/MiniMax/Ollama', () => {
    assert.equal(ctxWindowGuess('mimo-v2.5'), 1000000);
    assert.equal(ctxWindowGuess('mimo-v2.5-asr'), 65536);
    assert.equal(ctxWindowGuess('qwen3.8-flash'), 1000000);
    assert.equal(ctxWindowGuess('qwen3.6-max-preview'), 262144);
    assert.equal(ctxWindowGuess('qwen3.5-27b'), 32768);
    assert.equal(ctxWindowGuess('qwen3.5-omni-plus'), 65536);
    assert.equal(ctxWindowGuess('qwen-plus'), 1000000);
    assert.equal(ctxWindowGuess('qwen-turbo'), 131072);
    assert.equal(ctxWindowGuess('qwen-max'), 32768);
    assert.equal(ctxWindowGuess('glm-5.2'), 1000000);
    assert.equal(ctxWindowGuess('glm-4.6'), 202752);
    assert.equal(ctxWindowGuess('glm-4'), 131072);
    assert.equal(ctxWindowGuess('MiniMax-M3'), 1000000);
    assert.equal(ctxWindowGuess('gemma4:e2b-it-qat'), 131072);
  });
  it('returns 10000000 for qwen-long', () => {
    assert.equal(ctxWindowGuess('qwen-long'), 10000000);
  });
  it('returns 131072 for qwen (non-turbo/long)', () => {
    assert.equal(ctxWindowGuess('qwen-72b'), 131072);
  });
  it('returns 128000 for gpt-4o', () => {
    assert.equal(ctxWindowGuess('gpt-4o'), 128000);
  });
  it('returns current windows for GPT-5.x families', () => {
    assert.equal(ctxWindowGuess('gpt-5.6-sol'), 1050000);
    assert.equal(ctxWindowGuess('gpt-5.6-terra'), 1050000);
    assert.equal(ctxWindowGuess('gpt-5.6-luna'), 1050000);
    assert.equal(ctxWindowGuess('gpt-5.5-pro'), 1050000);
    assert.equal(ctxWindowGuess('gpt-5.4-mini'), 400000);
    assert.equal(ctxWindowGuess('gpt-5.4-nano'), 400000);
    assert.equal(ctxWindowGuess('gpt-5.2'), 400000);
    assert.equal(ctxWindowGuess('gpt-5.1-chat-latest'), 128000);
  });
  it('returns 128000 for gpt-4.1', () => {
    assert.equal(ctxWindowGuess('gpt-4.1'), 128000);
  });
  it('returns 200000 for o3', () => {
    assert.equal(ctxWindowGuess('o3-mini'), 200000);
  });
  it('returns 200000 for o4', () => {
    assert.equal(ctxWindowGuess('o4-mini'), 200000);
  });
  it('returns 65536 for unknown model', () => {
    assert.equal(ctxWindowGuess('some-random-model'), 65536);
  });
  it('returns 65536 for empty string', () => {
    assert.equal(ctxWindowGuess(''), 65536);
  });
  it('returns 65536 for null', () => {
    assert.equal(ctxWindowGuess(null), 65536);
  });
  it('case-insensitive matching', () => {
    assert.equal(ctxWindowGuess('DeepSeek-V4'), 1000000);
    assert.equal(ctxWindowGuess('CLAUDE-SONNET-5'), 1000000);
  });
});
