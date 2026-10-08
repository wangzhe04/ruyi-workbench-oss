'use strict';
// 前端走查 W1 杂项修复的纯函数/目录判据(真浏览器那一半在 dev-harness/ui-misc-wave1.browser.e2e.js):
//   [F1] util.fmtBytes 进位(1048575 B 不再印「1024.0 KB」)
//   [F2] util.toastDurationMs:err 类按字数延长并夹在 [6s, 15s],其余仍 3.2s;migration-center 不再用 CSS 里不存在的 'error' 类
//   [F3] util.parseCsv:带引号的逗号/换行不切、剥 BOM、「恰好 200 行」不算截断
//   [F4] util.bindKeyboardClick:role=button 的 div 的 Enter/空格 → click,冒泡上来的按键不算
//   [F5] 英文单复数:tCount 的 .one/.other 键对(storage / changes / session.bulkCleanup / migration / 管家模型副行…),
//        中文两键同文;storage.cleanDone / lastSweepNote 的「{{bytes}} ({{n}} items)」补空格
//   [F6] 审计行摘要本地化:服务端 AUDIT_SUMMARY_MAP 的每个 kind 在两种语言里都有 audit.kind.<kind>,
//        中文与服务端措辞逐字一致,英文无 CJK;未知 kind / 桌面来源回落服务端 summary
//   [F7] MCP 兼容性框:服务端 MCP_COMPAT_MATRIX 的每个 transport 都有 settings.mcp.compat.<k>.* 键
//   [F8] markdown breaks:createMarkdownParser(…, {breaks:false}) 单个换行不画成 <br>(手册用),默认口径不变
//   [F9] modal.focusReturnTarget:trigger 看不见/不连通时退到拥有那张菜单的按钮 → #appGearBtn
//   [F10] 新键两份目录同键、同占位符、docs 镜像逐字节相同
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { constBlock } = require('../lib/source-slice');

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'ruyi-workbench', 'app');
const PUBLIC = path.join(APP, 'public');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const zh = readJson(path.join(PUBLIC, 'locales', 'zh-CN.json'));
const en = readJson(path.join(PUBLIC, 'locales', 'en-US.json'));
const importPublic = rel => import(pathToFileURL(path.join(PUBLIC, rel)).href);
const CJK = /[㐀-鿿]/;

let util;
let i18n;
let observability;

before(async () => {
  // i18n 目录靠 fetch(file URL)加载:Node 的 fetch 不认 file:,给一个读磁盘的替身(i18n.static 同款)。
  globalThis.document = { documentElement: {}, matches: () => false, querySelectorAll: () => [] };
  globalThis.window = { dispatchEvent() {}, addEventListener() {} };
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  globalThis.fetch = async url => {
    const name = path.basename(new URL(String(url)).pathname);
    return { ok: true, json: async () => readJson(path.join(PUBLIC, 'locales', name)) };
  };
  util = await importPublic('js/util.js');
  i18n = await importPublic('js/i18n.js');
  observability = await importPublic('js/operations-observability.js');
});

describe('[F1] fmtBytes 进位', () => {
  it('临界值不再印 1024.0', () => {
    assert.equal(util.fmtBytes(0), '0 B');
    assert.equal(util.fmtBytes(1023), '1023 B');
    assert.equal(util.fmtBytes(1024), '1.0 KB');
    assert.equal(util.fmtBytes(1536), '1.5 KB');
    assert.equal(util.fmtBytes(1048575), '1.0 MB');      // 修前「1024.0 KB」
    assert.equal(util.fmtBytes(1048576), '1.0 MB');
    assert.equal(util.fmtBytes(1073741823), '1.0 GB');   // 修前「1024.0 MB」
    assert.equal(util.fmtBytes(1073741824), '1.0 GB');
    assert.equal(util.fmtBytes(1048000), '1023.4 KB');   // 取整后仍 <1024 的不进位
    assert.equal(util.fmtBytes(NaN), '');
    for (const n of [1023.96 * 1024, 1023.99 * 1048576, 1048524, 5e12]) assert.ok(!/^1024\.\d /.test(util.fmtBytes(n)), `${n} → ${util.fmtBytes(n)}`);
  });
});

describe('[F2] toast 时长与 kind', () => {
  it('err 类按字数延长,夹在 [6s, 15s];其余 3.2s', () => {
    assert.equal(util.toastDurationMs('ok', 'ok'), 3200);
    assert.equal(util.toastDurationMs('x'.repeat(500), 'warn'), 3200);
    assert.equal(util.toastDurationMs('x'.repeat(500)), 3200);
    assert.equal(util.toastDurationMs('短', 'err'), 6000);
    assert.equal(util.toastDurationMs('', 'err'), 6000);
    assert.equal(util.toastDurationMs('x'.repeat(50), 'err'), 7200);
    assert.equal(util.toastDurationMs('x'.repeat(100), 'err'), 11200);
    assert.equal(util.toastDurationMs('x'.repeat(500), 'err'), 15000);
    assert.equal(util.toastDurationMs(null, 'err'), 6000);
  });
  it('migration-center 的错误提示用 .toast.err(CSS 里没有 .toast.error)', () => {
    const src = fs.readFileSync(path.join(PUBLIC, 'js', 'migration-center.js'), 'utf8');
    assert.ok(!/toast\([^;\n]*,\s*'error'\s*\)/.test(src), "不许再有 toast(…, 'error')");
    assert.ok(/toast\(errorText\(e\), 'err'\)/.test(src));
    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'components', 'tool-pane.css'), 'utf8');
    assert.ok(/\.toast\.err\s*\{/.test(css) && !/\.toast\.error\b/.test(css));
  });
});

describe('[F3] parseCsv', () => {
  it('带引号的逗号不拆、"" 是转义引号、BOM 被剥、CRLF 与末尾换行', () => {
    const { rows, truncated } = util.parseCsv('﻿name,note\r\n"Smith, J","he said ""hi"""\r\nx,y\r\n');
    assert.deepEqual(rows, [['name', 'note'], ['Smith, J', 'he said "hi"'], ['x', 'y']]);
    assert.equal(truncated, false);
    assert.equal(rows[0][0].charCodeAt(0), 'n'.charCodeAt(0));   // 没有残留的
  });
  it('引号里的换行属于同一个单元格;空字段与末尾逗号', () => {
    assert.deepEqual(util.parseCsv('"l1\nl2",z\n,\na,').rows, [['l1\nl2', 'z'], ['', ''], ['a', '']]);
    assert.deepEqual(util.parseCsv('').rows, []);
    assert.deepEqual(util.parseCsv('only').rows, [['only']]);
  });
  it('恰好 maxRows 行不算截断,多一行才算(且只留 maxRows 行)', () => {
    const lines = n => Array.from({ length: n }, (_, i) => `r${i},v`).join('\n');
    const exact = util.parseCsv(lines(200) + '\n', 200);
    assert.equal(exact.rows.length, 200);
    assert.equal(exact.truncated, false);
    const noNewline = util.parseCsv(lines(200), 200);
    assert.equal(noNewline.truncated, false);
    const over = util.parseCsv(lines(201), 200);
    assert.equal(over.rows.length, 200);
    assert.equal(over.truncated, true);
  });
});

describe('[F4] bindKeyboardClick', () => {
  function fakeNode() {
    const node = { clicks: 0, handlers: {}, click() { node.clicks += 1; }, addEventListener(type, fn) { node.handlers[type] = fn; } };
    return node;
  }
  function press(node, event) {
    let prevented = false;
    node.handlers.keydown({ target: node, preventDefault() { prevented = true; }, ...event });
    return prevented;
  }
  it('Enter / 空格触发 click 并 preventDefault;别的键、修饰键、冒泡上来的事件不触发', () => {
    const node = util.bindKeyboardClick(fakeNode());
    assert.equal(press(node, { key: 'Enter' }), true);
    assert.equal(press(node, { key: ' ' }), true);
    assert.equal(node.clicks, 2);
    assert.equal(press(node, { key: 'a' }), false);
    assert.equal(press(node, { key: 'Enter', ctrlKey: true }), false);
    assert.equal(press(node, { key: 'Enter', isComposing: true }), false);
    assert.equal(press(node, { key: 'Enter', target: {} }), false);   // 行内的真按钮/输入框冒泡上来
    assert.equal(node.clicks, 2);
  });
  it('没有节点时原样返回', () => {
    assert.equal(util.bindKeyboardClick(null), null);
  });
});

describe('[F5] 英文单复数', () => {
  const PAIRS = [
    'storage.fileCount', 'storage.cleanDone', 'storage.lastSweepNote', 'storage.transcriptNote',
    'chat.rewindConfirm', 'chat.usageTurns',
    'session.bulkCleanup.action', 'session.bulkCleanup.description', 'session.bulkCleanup.success',
    'changes.roundCount',
    'stewardShell.chips.usedDaysAgo', 'stewardShell.chips.usageLine', 'stewardShell.chips.usageTurns',
    'migration.card.instructions', 'migration.card.mcp', 'migration.card.skills', 'migration.card.packages',
    'migration.old.refs', 'migration.skill.toastCopied', 'migration.skill.links', 'migration.import.entries',
    'migration.toast.importedCount', 'migration.toast.applied', 'migration.toast.undone', 'migration.skill.tooLargeHint',
    'audit.bit.remaining', 'audit.bit.grants',
  ];
  it('每个键都有 .one / .other 一对;中文两键同文,英文两键不同(1 与 N 的名词形态)', () => {
    for (const base of PAIRS) {
      for (const [label, catalog] of [['zh', zh], ['en', en]]) {
        assert.equal(typeof catalog[base + '.one'], 'string', `${label} 缺 ${base}.one`);
        assert.equal(typeof catalog[base + '.other'], 'string', `${label} 缺 ${base}.other`);
      }
      assert.equal(zh[base + '.one'], zh[base + '.other'], `中文 ${base} 两键必须同文`);
      assert.notEqual(en[base + '.one'], en[base + '.other'], `英文 ${base} 单复数应不同`);
    }
  });
  it('「stewardShell.chips.*」三个裸键保留(unit/steward-model-menu.test.js 按裸键取中文)', () => {
    for (const key of ['stewardShell.chips.usedDaysAgo', 'stewardShell.chips.usageLine', 'stewardShell.chips.usageTurns']) {
      assert.equal(zh[key], zh[key + '.other']);
      assert.equal(en[key], en[key + '.other']);
    }
  });
  it('tCount 渲染:1 file / 2 files、1 day ago、1 turn;中文不变', async () => {
    await i18n.setLocale('en-US');
    assert.equal(i18n.tCount('storage.fileCount', 1), '1 file');
    assert.equal(i18n.tCount('storage.fileCount', 0), '0 files');
    assert.equal(i18n.tCount('storage.fileCount', 12), '12 files');
    assert.equal(i18n.tCount('chat.rewindConfirm', 1, { turns: 1 }), 'Go back before this message? The 1 turn after will be deleted.');
    assert.equal(i18n.tCount('chat.rewindConfirm', 3, { turns: 3 }), 'Go back before this message? The 3 turns after will be deleted.');
    assert.equal(i18n.tCount('session.bulkCleanup.action', 1), 'Clean up 1 thread');
    assert.equal(i18n.tCount('session.bulkCleanup.action', 5), 'Clean up 5 threads');
    assert.equal(i18n.tCount('changes.roundCount', 1), '1 item');
    assert.equal(i18n.tCount('stewardShell.chips.usedDaysAgo', 1, { days: 1 }), '1 day ago');
    assert.equal(i18n.tCount('stewardShell.chips.usedDaysAgo', 3, { days: 3 }), '3 days ago');
    assert.equal(i18n.tCount('stewardShell.chips.usageLine', 1, { when: 'today', turns: 1 }), 'Last used · today · 1 turn');
    assert.equal(i18n.tCount('migration.card.skills', 1), '1 skill');
    assert.equal(i18n.tCount('migration.card.mcp', 2), '2 MCP servers');
    assert.equal(i18n.tCount('migration.old.refs', 1), '1 reference');
    // 少空格:{{bytes}} 与括号之间要有空格
    assert.equal(i18n.tCount('storage.cleanDone', 1, { bytes: '1.0 MB' }), 'Cleanup done: freed 1.0 MB (1 item)');
    assert.equal(i18n.tCount('storage.cleanDone', 4, { bytes: '1.0 MB' }), 'Cleanup done: freed 1.0 MB (4 items)');
    assert.match(i18n.tCount('storage.lastSweepNote', 2, { when: 'now', bytes: '2 KB' }), /freed 2 KB \(2 items\)$/);
    await i18n.setLocale('zh-CN');
    assert.equal(i18n.tCount('storage.fileCount', 1), '1 个文件');
    assert.equal(i18n.tCount('storage.fileCount', 7), '7 个文件');
    assert.equal(i18n.tCount('stewardShell.chips.usageTurns', 1, { turns: 1 }), '共 1 回合');
  });
});

describe('[F6] 审计行摘要本地化', () => {
  const serverSrc = fs.readFileSync(path.join(APP, 'src', '06-provider-engine.js'), 'utf8');
  const mapBlock = constBlock(serverSrc, 'AUDIT_SUMMARY_MAP');
  const mapEntries = [...mapBlock.matchAll(/^\s*([a-z_]+):\s*'([^']*)'/gm)].map(m => [m[1], m[2]]);

  it('服务端 AUDIT_SUMMARY_MAP 的每个 kind 都有前端键;中文与服务端措辞一致,英文无 CJK', () => {
    assert.ok(mapEntries.length >= 11, '切到了 AUDIT_SUMMARY_MAP(' + mapEntries.length + ' 项)');
    for (const [kind, text] of mapEntries) {
      assert.equal(zh['audit.kind.' + kind], text, `zh audit.kind.${kind} 应与服务端 AUDIT_SUMMARY_MAP 逐字一致`);
      assert.equal(typeof en['audit.kind.' + kind], 'string', `en 缺 audit.kind.${kind}`);
      assert.ok(!CJK.test(en['audit.kind.' + kind]), `en audit.kind.${kind} 不该有中文`);
    }
  });
  it('英文界面:按 detail 重拼摘要,无中文', async () => {
    await i18n.setLocale('en-US');
    const row = (type, detail, extra = {}) => ({ source: 'workbench', type, summary: '服务端中文', detail, ...extra });
    const s = observability.auditSummaryText;
    assert.equal(s(row('turn_end', { ok: true })), 'Turn ended (succeeded)');
    assert.equal(s(row('turn_end', { ok: false, aborted: true })), 'Turn ended (not successful · aborted)');
    assert.equal(s(row('turn_start', { engine: 'openai', model: 'm1' })), 'Turn started (provider · m1)');
    assert.equal(s(row('turn_start', { engine: 'claude' })), 'Turn started (claude)');
    assert.equal(s(row('server_start', { version: '3.0.0' })), 'Server started (v3.0.0)');
    assert.equal(s(row('server_start', {})), 'Server started');
    assert.equal(s(row('autonomy_grant_consume', { tool: 'shell_run', remaining: 1 })), 'Grant used (shell_run · 1 use left)');
    assert.equal(s(row('autonomy_grant_consume', { tool: 'shell_run', remaining: 3 })), 'Grant used (shell_run · 3 uses left)');
    assert.equal(s(row('autonomy_grant_revoked', { count: 1 })), 'Grant revoked (1 grant)');
    assert.equal(s(row('autonomy_grant_revoked', { count: 2 })), 'Grant revoked (2 grants)');
    assert.equal(s(row('autonomy_grant_revoked', { tool: 'x' })), 'Grant revoked (x)');
    assert.equal(s(row('turn_kill', null)), 'Turn aborted');
    for (const [kind] of mapEntries) assert.ok(!CJK.test(s(row(kind, {}))), `${kind} 英文摘要不该有中文`);
    assert.equal(s({ source: 'desktop', type: 'hotkey', summary: 'hotkey（失败）', detail: { tool: 'hotkey', ok: false } }), 'hotkey (failed)');
    assert.equal(s({ source: 'desktop', type: 'hotkey', summary: 'hotkey', detail: { tool: 'hotkey', ok: true } }), 'hotkey');
    assert.equal(s({ source: 'desktop', type: 'hotkey', summary: 'custom summary', detail: { ok: false, summary: 'custom summary' } }), 'custom summary');
  });
  it('中文界面:与服务端 auditSummaryFor 的拼法一致(全角括号)', async () => {
    await i18n.setLocale('zh-CN');
    const s = observability.auditSummaryText;
    assert.equal(s({ source: 'workbench', type: 'turn_end', summary: 'x', detail: { ok: true } }), '结束回合（成功）');
    assert.equal(s({ source: 'workbench', type: 'turn_end', summary: 'x', detail: { ok: false, aborted: true } }), '结束回合（未成功 · 已中止）');
    assert.equal(s({ source: 'workbench', type: 'autonomy_grant_consume', summary: 'x', detail: { tool: 't', remaining: 2 } }), '消耗授权（t · 剩 2 次）');
    assert.equal(s({ source: 'workbench', type: 'autonomy_grant_revoked', summary: 'x', detail: { count: 3 } }), '撤销授权（3 张）');
    assert.equal(s({ source: 'desktop', type: 'hotkey', summary: 'hotkey（失败）', detail: { tool: 'hotkey', ok: false } }), 'hotkey（失败）');
  });
  it('未知 kind、桌面来源、缺 detail 回落服务端 summary,永不空白', async () => {
    await i18n.setLocale('en-US');
    const s = observability.auditSummaryText;
    assert.equal(s({ source: 'workbench', type: 'brand_new_kind', summary: 'srv text', detail: {} }), 'srv text');
    assert.equal(s({ source: 'desktop', type: 'turn_start', summary: 'srv text', detail: {} }), 'srv text');
    assert.equal(s({ source: 'workbench', type: 'turn_start', summary: 'srv text' }), 'Turn started');
    assert.equal(s(null), '');
  });
});

describe('[F7] MCP 兼容性框的本地化键', () => {
  it('服务端 MCP_COMPAT_MATRIX 的每个 transport 都有 capabilities / limitations 两键', () => {
    const src = fs.readFileSync(path.join(APP, 'src', '04-permission-runtime.js'), 'utf8');
    const block = constBlock(src, 'MCP_COMPAT_MATRIX');
    const transports = [...block.matchAll(/^ {2}(\w+): \{/gm)].map(m => m[1]);
    assert.deepEqual(transports.sort(), ['http', 'sse', 'stdio']);
    for (const k of transports) {
      for (const field of ['capabilities', 'limitations']) {
        const key = `settings.mcp.compat.${k}.${field}`;
        assert.equal(typeof zh[key], 'string', 'zh 缺 ' + key);
        assert.equal(typeof en[key], 'string', 'en 缺 ' + key);
        assert.ok(!CJK.test(en[key]), `${key} 英文不该有中文`);
      }
    }
    assert.ok(!CJK.test(en['settings.mcp.desktopControl.label']));
    assert.equal(zh['settings.mcp.desktopControl.label'], '桌面控制 (ai-computer-control)');
  });
});

describe('[F8] markdown breaks 选项', () => {
  const markedLib = require(path.join(PUBLIC, 'vendor', 'marked.min.js'));
  it('默认 breaks:true(对话口径不变);{breaks:false} 单个换行不画成 <br>,段落与表格不受影响', async () => {
    const { createMarkdownParser } = await importPublic('js/chat-render-primitives.js');
    const chat = createMarkdownParser(markedLib);
    const manual = createMarkdownParser(markedLib, { breaks: false });
    assert.match(chat.parse('line one\nline two'), /line one<br>line two/);
    const html = manual.parse('line one\nline two\n\nnext para');
    assert.ok(!html.includes('<br>'), html);
    assert.match(html, /<p>line one\nline two<\/p>/);
    assert.match(html, /<p>next para<\/p>/);
    assert.match(manual.parse('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>/);
    assert.match(manual.parse('旧 ~~划掉~~ 新'), /<del>划掉<\/del>/);   // 只认双波浪的 tokenizer 仍在
  });
  it('help-viewer 传 {breaks:false};renderMarkdownInto 把 opts 递给 renderMarkdown 且缓存键带上这一位', () => {
    const viewer = fs.readFileSync(path.join(PUBLIC, 'js', 'help-viewer.js'), 'utf8');
    assert.match(viewer, /renderMarkdownInto\(frame\.article, String\(res\.markdown \|\| ''\), \{ breaks: false \}\)/);
    const prims = fs.readFileSync(path.join(PUBLIC, 'js', 'chat-render-primitives.js'), 'utf8');
    assert.match(prims, /function renderMarkdownInto\(container, text, opts\)/);
    assert.match(prims, /renderMarkdown\(text, opts\)/);
    assert.match(prims, /cacheKey/);
  });
});

describe('[F9] 模态焦点归还目标', () => {
  function node(props = {}) {
    return { focus() {}, isConnected: true, getClientRects: () => [1], closest: () => null, ...props };
  }
  function fakeDoc(extra = {}) {
    const gear = node({ id: 'appGearBtn' });
    return {
      body: node({ tagName: 'BODY' }),
      gear,
      getElementById: id => (id === 'appGearBtn' ? gear : null),
      querySelector: () => null,
      ...extra,
    };
  }
  let modal;
  before(async () => { modal = await importPublic('js/modal.js'); });

  it('trigger 看得见 → 还给它', () => {
    const doc = fakeDoc();
    const trigger = node();
    assert.equal(modal.focusReturnTarget(trigger, doc), trigger);
  });
  it('trigger 为空 / 就是 body → 不动(没有「回哪儿」可言)', () => {
    const doc = fakeDoc();
    assert.equal(modal.focusReturnTarget(null, doc), null);
    assert.equal(modal.focusReturnTarget(doc.body, doc), null);
  });
  it('trigger 已脱离文档(isConnected=false)→ 退到 #appGearBtn', () => {
    const doc = fakeDoc();
    assert.equal(modal.focusReturnTarget(node({ isConnected: false }), doc), doc.gear);
  });
  it('trigger 不可见(display:none,无盒子)且在齿轮菜单里 → 退到 aria-controls 指回菜单的那枚按钮', () => {
    const owner = node({ id: 'ownerBtn' });
    const menu = { id: 'appGearMenu' };
    const doc = fakeDoc({ querySelector: sel => (sel === '[aria-controls="appGearMenu"]' ? owner : null) });
    const hidden = node({ getClientRects: () => [], closest: sel => (sel === '[role="menu"]' ? menu : null) });
    assert.equal(modal.focusReturnTarget(hidden, doc), owner);
  });
  it('不可见且认不出菜单 → #appGearBtn;连它也看不见 → null', () => {
    const doc = fakeDoc();
    assert.equal(modal.focusReturnTarget(node({ getClientRects: () => [] }), doc), doc.gear);
    doc.gear.getClientRects = () => [];
    assert.equal(modal.focusReturnTarget(node({ getClientRects: () => [] }), doc), null);
  });
});

describe('[F10] 新键的目录一致性', () => {
  it('两份目录键集合相同、同键占位符相同(含新增的)', () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    const ph = v => [...String(v).matchAll(/{{\s*([\w.-]+)\s*}}/g)].map(m => m[1]).sort();
    for (const key of Object.keys(zh)) assert.deepEqual(ph(zh[key]), ph(en[key]), 'placeholder mismatch: ' + key);
  });
  it('docs/i18n 镜像与运行时目录逐字节相同', () => {
    for (const name of ['zh-CN.json', 'en-US.json']) {
      const a = fs.readFileSync(path.join(PUBLIC, 'locales', name));
      const b = fs.readFileSync(path.join(ROOT, 'docs', 'i18n', 'locales', name));
      assert.ok(a.equals(b), name + ' 镜像不一致');
    }
  });
  it('文件树新键齐全且英文不夹中文', () => {
    for (const key of ['file.tree.notFound', 'file.tree.notAllowed', 'file.tree.truncated', 'ctx.meter.aria', 'audit.sourceFilterLabel']) {
      assert.equal(typeof zh[key], 'string', key);
      assert.ok(typeof en[key] === 'string' && !CJK.test(en[key]), key);
    }
  });
});
