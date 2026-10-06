#!/usr/bin/env node
'use strict';

// 第三波前端走查修复（W3-ui）的纯函数／静态契约快通道。真浏览器那一半在 dev-harness/frontend-wave3.browser.e2e.js。
//
//   M4  stewardAskText：权限一支按 toolName ＋ target 在前端拼句。zh 与服务端 06i stewardPermissionPlain 的整句逐字相同
//       （中文界面一个字不变），en 不含中文；缺 toolName／target（老服务端、手造行）与其它几类（question／plan／pool）原样退回服务端原句；
//       asksYouFrom 带 translate 时 permission 支的 texts 走同一条口径。
//   M4  服务端 subagent_progress 三处带 noteCode，前端词表 chat.subagent.note.* 两语言齐全、占位符一致、英文零中文。
//   M5  档名统一：英文向导「每步都问／改文件不问」叫 Ask me every step／Edit files without asking；词表里没有残留的旧叫法。
//   新增文案键：docs/i18n 镜像逐字节相同。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const LOCALES = path.join(PUBLIC, 'locales');
const MIRROR = path.join(ROOT, 'docs', 'i18n', 'locales');
const load = name => import(pathToFileURL(path.join(PUBLIC, 'js', name)).href);
const read = file => fs.readFileSync(file, 'utf8');
const zh = JSON.parse(read(path.join(LOCALES, 'zh-CN.json')));
const en = JSON.parse(read(path.join(LOCALES, 'en-US.json')));
const CJK = /[㐀-鿿]/;
const placeholders = text => [...String(text).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
const translator = catalog => (key, params = {}) => String(catalog[key] === undefined ? `[${key}]` : catalog[key])
  .replace(/\{\{(\w+)\}\}/g, (_, name) => (params[name] === undefined ? '' : String(params[name])));
const tZh = translator(zh);
const tEn = translator(en);

describe('M4 stewardAskText：「等你放行」按界面语言拼', () => {
  // 服务端 06i stewardPermissionPlain 对这几类工具的整句（STEWARD_PERMISSION_VERBS）
  const SERVER = {
    file_write: v => `写入文件「${v}」`, file_edit: v => `修改文件「${v}」`, file_delete: v => `删除文件「${v}」`,
    file_move: v => `移动文件「${v}」`, file_copy: v => `复制文件「${v}」`, http_download: v => `下载文件「${v}」`,
  };
  it('zh：与服务端整句逐字相同（中文界面一个字不变）', async () => {
    const { stewardAskText } = await load('thread-facts.js');
    for (const [tool, plain] of Object.entries(SERVER)) {
      const text = `等你放行:${plain('report.md')}`;
      assert.equal(stewardAskText({ kind: 'permission', toolName: tool, target: 'report.md', text }, tZh), text, `${tool}：zh 与服务端不一致`);
    }
  });
  it('en：无中文，并点名文件；没有 target 时只说动词', async () => {
    const { stewardAskText } = await load('thread-facts.js');
    const a = stewardAskText({ kind: 'permission', toolName: 'file_write', target: 'report.md', text: '等你放行:写入文件「report.md」' }, tEn);
    assert.equal(a, 'Waiting for your approval: Write file “report.md”');
    assert.ok(!CJK.test(a));
    const b = stewardAskText({ kind: 'permission', toolName: 'file_delete', target: '', text: '等你放行:删除文件' }, tEn);
    assert.equal(b, 'Waiting for your approval: Delete file');
  });
  it('认不出的工具／缺字段／其它几类：原样退回服务端原句（宁可印中文也不编一句）', async () => {
    const { stewardAskText } = await load('thread-facts.js');
    assert.equal(stewardAskText({ kind: 'permission', toolName: 'some_new_tool', target: 'x', text: '等你放行:用「some_new_tool」处理「x」' }, tEn), '等你放行:用「some_new_tool」处理「x」');
    assert.equal(stewardAskText({ kind: 'permission', text: '等你放行:xx' }, tEn), '等你放行:xx');
    assert.equal(stewardAskText({ kind: 'question', text: '要等吗?' }, tEn), '要等吗?');
    assert.equal(stewardAskText({ kind: 'permission', toolName: 'file_write', target: 'a', text: 'T' }, null), 'T');
    assert.equal(stewardAskText(null, tEn), '');
  });
  it('asksYouFrom：带 translate 时 permission 支的 texts 走同一条口径；不带时照旧', async () => {
    const { asksYouFrom } = await load('steward-drawer.js');
    const pending = { type: 'permission', id: 'iv1', sessionId: 's1', toolName: 'file_write', tier: 'edit', revertible: true };
    const row = { kind: 'permission', toolName: 'file_write', target: 'report.md', text: '等你放行:写入文件「report.md」' };
    assert.deepEqual(asksYouFrom({ pending, rowAsksYou: row, translate: tEn }).texts, ['Waiting for your approval: Write file “report.md”']);
    assert.deepEqual(asksYouFrom({ pending, rowAsksYou: row }).texts, ['等你放行:写入文件「report.md」']);
  });
});

describe('M4 子代理进度 noteCode ＋ 新词条', () => {
  it('服务端 subagent_progress 的字面量都带 noteCode（源码与产物各一份）', () => {
    const need = { 'src/08-agent-runs.js': ['init', 'streaming'], 'src/07-autonomy.js': ['generating'], 'src/05b-kimi-bridge.js': ['kimiRunning', 'kimiRunningFor', 'kimiPaused'],
      'server.js': ['init', 'streaming', 'generating', 'kimiRunning', 'kimiRunningFor', 'kimiPaused'] };
    for (const [file, codes] of Object.entries(need)) {
      const text = read(path.join(ROOT, 'ruyi-workbench', 'app', file));
      for (const code of codes) assert.ok(text.includes(`noteCode: '${code}'`) || (code === 'kimiPaused' && text.includes("'kimiPaused'")), `${file} 缺 noteCode ${code}`);
    }
  });
  const KEYS = ['chat.subagent.note.init', 'chat.subagent.note.streaming', 'chat.subagent.note.generating', 'chat.subagent.note.kimiRunning',
    'chat.subagent.note.kimiRunningFor', 'chat.subagent.note.kimiPaused', 'chat.subagent.note.kimiPausedWaiting',
    'stewardShell.askYou.permission', 'stewardShell.askYou.permissionTarget'];
  it('两语言齐全、占位符一致、英文零中文', () => {
    for (const key of KEYS) {
      assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`);
      assert.equal(typeof en[key], 'string', `en 缺 ${key}`);
      assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key} 占位符不一致`);
      assert.ok(!CJK.test(en[key]), `${key} 英文里有中文`);
    }
  });
  it('docs/i18n 镜像逐字节相同', () => {
    for (const lang of ['zh-CN', 'en-US']) assert.equal(read(path.join(MIRROR, `${lang}.json`)), read(path.join(LOCALES, `${lang}.json`)), `${lang} 镜像不同步`);
  });
});

describe('M5 权限档命名统一', () => {
  it('英文向导与设置里不再有旧叫法', () => {
    assert.equal(en['onboarding.wizard.safety.default.title'], 'Ask me every step');
    assert.equal(en['onboarding.wizard.safety.acceptEdits.title'], 'Edit files without asking');
    assert.equal(en['onboarding.wizard.safety.plan.title'], 'Plan only');
    assert.equal(en['onboarding.wizard.safety.auto.title'].startsWith('Smart auto'), true);
    assert.doesNotMatch(en['onboarding.wizard.safety.hint'], /Ask me every time/);
    assert.doesNotMatch(en['settings.permissionBridge'], /bypass/i);
    assert.doesNotMatch(zh['settings.permissionBridge'], /bypass/i);
    assert.match(zh['settings.permissionBridge'], /全自动/);
  });
  it('定时任务权限下拉顺序与盾牌一致：跟随全局／默认／改文件不问／只做计划／智能自动', () => {
    const html = read(path.join(PUBLIC, 'index.html'));
    const block = html.slice(html.indexOf('id="cfgStewardSchedulePermission"'));
    const values = [...block.slice(0, block.indexOf('</select>')).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(values, ['', 'default', 'acceptEdits', 'plan', 'auto']);
  });
});
