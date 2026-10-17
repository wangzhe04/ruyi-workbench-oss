'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-routing-unit-'));
process.env.RUYI_HOME = root;
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const srv = require('../../ruyi-workbench/app/server.js');
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleanup */ } });

test('双语管家契约允许当前回合轻量读取,独立调查与执行仍交线程', () => {
  const zh = srv.getPromptPack('zh-CN').steward.stable;
  const en = srv.getPromptPack('en-US').steward.stable;
  assert.match(zh, /少量只读即可完整回答.*本回合/);
  assert.match(en, /in this turn when a few read-only lookups suffice/);
  assert.match(zh, /独立调查或短时执行才用 steward_quick_ask/);
  assert.match(en, /steward_quick_ask for independent investigation or short execution/);
  assert.match(zh, /不按字数或文件数/);
  assert.match(en, /not word or file count/);
  assert.doesNotMatch(zh, /读写文件.*一律交给线程/);
  assert.doesNotMatch(en, /anything needing files, network or hands-on work goes to/);
  for (const stable of [zh, en]) assert.ok(srv.estimateTextTokens(stable) <= 1250, '复用现有稳定层预算,不抬闸');
});

test('轻量读取契约不放开污染、写执行、原话和权限边界', () => {
  const zh = srv.getPromptPack('zh-CN').steward.stable;
  const en = srv.getPromptPack('en-US').steward.stable;
  assert.match(zh, /读过后本回合写动作只能提议/);
  assert.match(en, /after reading it, writes this turn are proposals only/);
  assert.match(zh, /写文件、跑命令、操作桌面交给线程/);
  assert.match(en, /File edits, commands and desktop work go to threads/);
  assert.match(zh, /原话|原样转述/);
  assert.match(en, /verbatim/);
  assert.match(zh, /永久豁免/);
  assert.match(en, /Permanent exemptions/);
});

test('发给管家的schema与稳定提示同口径,受限读取schema保持原形', () => {
  const tools = new Map(srv.buildOpenAiTools(srv.defaultConfig(), null, { stewardSession: true }).map(t => [t.function.name, t.function]));
  assert.equal(tools.size, 43, '67 adds the single bounded local bot setup tool');
  for (const name of ['steward_web_search', 'steward_web_fetch', 'steward_file_read', 'steward_thread_artifact_read']) {
    assert.match(tools.get(name).description, /本回合/);
    assert.match(tools.get(name).description, /外部内容/);
  }
  assert.deepEqual(tools.get('steward_file_read').parameters.required, ['path']);
  assert.deepEqual(tools.get('steward_thread_artifact_read').parameters.required, ['sessionId', 'path']);
  assert.match(tools.get('steward_web_fetch').description, /SSRF/);
  assert.match(tools.get('steward_file_read').description, /outside_workspace/);
  assert.match(tools.get('steward_thread_artifact_read').description, /not_in_artifacts/);
  assert.match(tools.get('steward_quick_ask').description, /独立调查或短时执行/);
  assert.doesNotMatch(tools.get('steward_quick_ask').description, /要读文件、要联网、要跑命令才能答的问题/);
  assert.match(tools.get('steward_thread_new').description, /少量受限只读就能完整回答的问题/);
});

test('bot setup discipline is bilingual, local and keeps secrets out of model tools',()=>{for(const locale of ['zh-CN','en-US']){const prompt=srv.getPromptPack(locale).steward.stable;assert.match(prompt,/steward_bot_setup inspect/);assert.match(prompt,/prepare/);assert.match(prompt,/密钥|never chat secrets/);assert.match(prompt,/真实收发|confirmed traffic/);}assert.equal(srv.PROMPT_PACK_VERSION,'2026-w138-2','only steward text changed; ordinary prompt pack retains its version');});
