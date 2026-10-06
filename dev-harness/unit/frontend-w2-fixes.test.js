#!/usr/bin/env node
'use strict';

// 第二波前端走查修复（W2-frontend）的纯函数／静态契约快通道。真浏览器那一半在 dev-harness/frontend-wave2.browser.e2e.js。
//
//   F5  stewardWaitText／stewardWaitBlockerId：按 wait.reason ＋ 结构化字段取本地化句；zh 与服务端 label 逐字相同
//       （所以中文界面一个字不变），en 不含中文；缺结构化字段退回 label；stewardQueuedWaitLabel 可带 translate。
//       服务端 waitReasonFor 只加字段（pending／axis·spent·limit），label 逐字不变（也在 steward-wait-reason.test.js 钉）。
//   F6  en-US 不再有「(s)」单复数遗留：十条键都拆成 .one/.other（两语言都拆、旧键不留、占位符一致）。
//   F4  autoGrow 的宽度观察：只在【宽度】变了时重量一次（高度变化不触发），每个输入框只挂一只。
//   Ctrl+K  app-frame.js 不再有第二个 Ctrl+K 监听（键归 app.js 的命令面板一处）；帮助弹窗的快捷键表补了 Ctrl+` 与 Ctrl+Enter。
//   新增文案键：两语言齐全、占位符一致、英文零中文、docs/i18n 镜像逐字节相同。
//
// ESM 前端模块直接 import 磁盘文件（与 unit/steward-shell-wave1.test.js 同款约定）；零磁盘写（server.js 的家目录指到临时目录）。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const JS = path.join(PUBLIC, 'js');
const LOCALES = path.join(PUBLIC, 'locales');
const MIRROR = path.join(ROOT, 'docs', 'i18n', 'locales');
const load = name => import(pathToFileURL(path.join(JS, name)).href);
const read = file => fs.readFileSync(file, 'utf8');
const zh = JSON.parse(read(path.join(LOCALES, 'zh-CN.json')));
const en = JSON.parse(read(path.join(LOCALES, 'en-US.json')));
const placeholders = text => [...String(text).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
const CJK = /[㐀-鿿＀-￯　-〿]/;
const translator = catalog => (key, params = {}) => String(catalog[key] === undefined ? `[${key}]` : catalog[key])
  .replace(/\{\{(\w+)\}\}/g, (_, name) => (params[name] === undefined ? '' : String(params[name])));
const tZh = translator(zh);
const tEn = translator(en);

// 服务端 waitReasonFor 的真输出（require server.js 前把家目录指到临时目录，与 steward-wait-reason.test.js 同款）。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w2-fixes-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
process.env.RUYI_HOME = home;
const { waitReasonFor } = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));

describe('F5 等待原因本地化：stewardWaitText', () => {
  const server = {
    needsYou: () => waitReasonFor({ pending: 3 }, {}),
    lock: () => waitReasonFor({ pending: 0 }, { lock: { sessionId: 'sess_holder', title: '周报-W36' } }),
    budgetCost: () => waitReasonFor({ pending: 0 }, { budget: { axis: 'cost_per_day', spent: 21.5, limit: 20 } }),
    budgetTurns: () => waitReasonFor({ pending: 0 }, { budget: { axis: 'turns_per_hour', spent: 120, limit: 120 } }),
    slotAhead: () => waitReasonFor({ pending: 0 }, { slot: { ahead: 2 } }),
    slotNext: () => waitReasonFor({ pending: 0 }, { slot: { ahead: 0 } }),
  };
  it('中文界面：用服务端真输出喂进去，说出来的话与服务端 label 逐字相同（中文界面一个字不变）', async () => {
    const { stewardWaitText } = await load('thread-facts.js');
    for (const [name, make] of Object.entries(server)) {
      const wait = make();
      assert.equal(stewardWaitText(wait, tZh), wait.label, `${name}：zh 与服务端 label 不一致（实得「${stewardWaitText(wait, tZh)}」，label「${wait.label}」）`);
    }
  });
  it('英文界面：六种等待说出来的话一个中文字都没有，且带上了数字／标题', async () => {
    const { stewardWaitText } = await load('thread-facts.js');
    // 线程标题是用户自己起的名字（可以是中文），不算界面文案 —— 零中文的断言用英文标题的那一份。
    const asciiLock = waitReasonFor({ pending: 0 }, { lock: { sessionId: 'sess_holder', title: 'Weekly report' } });
    for (const [name, wait] of Object.entries({ ...Object.fromEntries(Object.entries(server).map(([k, make]) => [k, make()])), lock: asciiLock })) {
      const text = stewardWaitText(wait, tEn);
      assert.ok(text && !CJK.test(text), `${name}：英文界面出现中文或空：「${text}」`);
    }
    assert.match(stewardWaitText(server.needsYou(), tEn), /3 pending/);
    assert.match(stewardWaitText(server.lock(), tEn), /周报-W36/, '线程标题是用户自己的字，原样带出（它不是界面文案）');
    assert.match(stewardWaitText(server.budgetCost(), tEn), /21\.5.*20/);
    assert.match(stewardWaitText(server.budgetTurns(), tEn), /120.*120/);
    assert.match(stewardWaitText(server.slotAhead(), tEn), /2 ahead/);
  });
  it('缺结构化字段（老服务端／手造行）退回 label；reason 不认识也退回 label；没有 translate 也退回 label', async () => {
    const { stewardWaitText } = await load('thread-facts.js');
    assert.equal(stewardWaitText({ reason: 'needs_you', label: '等你(1 条待决)' }, tEn), '等你(1 条待决)');
    assert.equal(stewardWaitText({ reason: 'budget', label: '等预算：X' }, tEn), '等预算：X');
    assert.equal(stewardWaitText({ reason: 'lock', label: '等锁：Y' }, tEn), '等锁：Y');
    assert.equal(stewardWaitText({ reason: 'slot', label: '等并发位' }, tEn), '等并发位');
    assert.equal(stewardWaitText({ reason: 'future-reason', label: '新原因' }, tEn), '新原因');
    assert.equal(stewardWaitText(server.slotAhead(), null), server.slotAhead().label);
    assert.equal(stewardWaitText(null, tEn), '');
    assert.equal(stewardWaitText('x', tEn), '');
  });
  it('等锁没有标题时说「别的线程」，不把内部 id 印给人；预算数缺失时印 ?', async () => {
    const { stewardWaitText } = await load('thread-facts.js');
    const text = stewardWaitText({ reason: 'lock', label: 'x', blockedBy: { sessionId: 'sess_0123456789abcdef', title: '' } }, tEn);
    assert.ok(!/sess_/.test(text) && /another thread/.test(text), text);
    assert.match(stewardWaitText({ reason: 'budget', label: 'x', axis: 'cost_per_day', spent: null, limit: null }, tEn), /\?.*\?/);
  });
  it('stewardWaitBlockerId：对象取 sessionId，老形状字符串照认，空回空串（修前 String(对象)＝"[object Object]"）', async () => {
    const { stewardWaitBlockerId } = await load('thread-facts.js');
    assert.equal(stewardWaitBlockerId(server.lock()), 'sess_holder');
    assert.equal(stewardWaitBlockerId({ blockedBy: 'sess_x' }), 'sess_x');
    assert.equal(stewardWaitBlockerId({ blockedBy: { sessionId: '', title: 't' } }), '');
    assert.equal(stewardWaitBlockerId({}), '');
    assert.equal(stewardWaitBlockerId(null), '');
    assert.notEqual(String(server.lock().blockedBy), 'sess_holder', '对照：这正是修前 String(wait.blockedBy) 拿不到 id 的原因');
  });
  it('stewardQueuedWaitLabel：带 translate 时按本地化说，不带就回 label；三种信封落点都认', async () => {
    const { stewardQueuedWaitLabel } = await load('steward-conversation.js');
    const wait = server.slotAhead();
    for (const envelope of [{ code: 'steward.queued', params: { wait } }, { code: 'steward.queued', wait }, { error: { code: 'steward.queued', params: { wait } } }]) {
      assert.equal(stewardQueuedWaitLabel(envelope), wait.label, '不带 translate：与修前逐字相同');
      assert.match(stewardQueuedWaitLabel(envelope, tEn), /2 ahead/);
    }
    assert.equal(stewardQueuedWaitLabel({ code: 'steward.queued' }, tEn), '');
    assert.equal(stewardQueuedWaitLabel(null, tEn), '');
  });
  it('服务端 waitReasonFor 只加了字段：label 逐字不变，needs_you 带 pending，budget 带 axis/spent/limit', () => {
    assert.deepEqual(Object.keys(server.needsYou()).sort(), ['label', 'pending', 'reason']);
    assert.deepEqual(Object.keys(server.budgetCost()).sort(), ['axis', 'label', 'limit', 'reason', 'spent']);
    assert.equal(server.needsYou().label, '等你(3 条待决)');
    assert.equal(server.slotNext().label, '等并发位：下一个就是它');
  });
});

describe('F6 en-US 单复数：「(s)」遗留拆成 .one/.other', () => {
  const KEYS = ['changes.revert.partial', 'chat.agentWake', 'settings.asrLexicon.count', 'settings.asrLexicon.saved',
    'settings.asrLexicon.savedSkipped', 'settings.asrLexicon.countLearned', 'toast.externalDiffOpened', 'toast.externalDiffPartial',
    'settings.mcp.count', 'settings.update.backupsCount'];
  it('en-US 里一条「(s)」都不剩（含新增键）', () => {
    const left = Object.entries(en).filter(([, value]) => /\(s\)/.test(String(value))).map(([key]) => key);
    assert.deepEqual(left, []);
  });
  it('十条键都有 .one/.other（两语言），旧的无后缀键不留，占位符两语言一致、.one 与 .other 之间一致', () => {
    for (const key of KEYS) {
      for (const [name, catalog] of [['zh-CN', zh], ['en-US', en]]) {
        assert.equal(catalog[key], undefined, `${name} 还留着旧键 ${key}`);
        assert.ok(catalog[`${key}.one`] && catalog[`${key}.other`], `${name} 缺 ${key}.one/.other`);
      }
      assert.deepEqual(placeholders(zh[`${key}.one`]), placeholders(en[`${key}.one`]), `${key}.one 两语言占位符`);
      assert.deepEqual(placeholders(zh[`${key}.other`]), placeholders(en[`${key}.other`]), `${key}.other 两语言占位符`);
      assert.deepEqual(placeholders(en[`${key}.one`]), placeholders(en[`${key}.other`]), `${key} en 的 .one/.other 占位符`);
      assert.notEqual(en[`${key}.one`], en[`${key}.other`], `${key} en 的单复数文案不该相同`);
      assert.equal(zh[`${key}.one`], zh[`${key}.other`], `${key} zh 无单复数，两档同文`);
    }
  });
  it('调用点都改成 tCount（旧键名不再被 t() 直接取）', () => {
    const files = ['session-experience.js', 'chat-static-renderer.js', 'provider-settings.js', 'artifact-changes.js', 'settings-operations.js'];
    const src = files.map(file => read(path.join(JS, file))).join('\n');
    for (const key of KEYS) {
      assert.ok(!new RegExp(`\\bt\\(\\s*['"]${key.replace(/\./g, '\\.')}['"]`).test(src), `${key} 仍被 t() 直接取`);
      assert.ok(new RegExp(`tCount\\(\\s*['"]${key.replace(/\./g, '\\.')}['"]`).test(src), `${key} 没有 tCount 调用点`);
    }
  });
});

describe('F4 autoGrow 的宽度观察', () => {
  it('每个输入框只挂一只观察者；宽度与「量高度时的宽度」不同才重量，只有高度变了不重量（免得自己喂自己）', async () => {
    const observers = [];
    global.ResizeObserver = class { constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); } observe(node) { this.targets.push(node); } disconnect() {} };
    try {
      const { autoGrow } = await load('util.js');
      let measured = 0;
      const ta = { clientWidth: 5, style: {}, get scrollHeight() { measured += 1; return 144; } };
      autoGrow(ta);
      autoGrow(ta);
      assert.equal(observers.length, 1, '同一个输入框只挂一只观察者');
      assert.equal(ta.style.height, '144px');
      const before = measured;
      observers[0].cb();                       // 宽度没变（高度变化触发的那种通知）
      assert.equal(measured, before, '宽度没变不重量');
      ta.clientWidth = 600; observers[0].cb();
      assert.equal(measured, before + 1, '宽度变了重量一次');
      observers[0].cb();
      assert.equal(measured, before + 1, '同一个宽度不重复量');
      ta.clientWidth = 0; observers[0].cb();   // 被藏起来（宽 0）：量不出东西，不量
      assert.equal(measured, before + 1);
      assert.equal(ta.style.height, '144px');
    } finally { delete global.ResizeObserver; }
  });
  it('窄宽下量过、观察者还没来得及看见窄宽就又变宽：照样重量（宽度记在量的那一刻，不是观察到的那一刻）', async () => {
    const observers = [];
    global.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} };
    try {
      const { autoGrow } = await load('util.js');
      let measured = 0;
      const ta = { clientWidth: 600, style: {}, get scrollHeight() { measured += 1; return 24; } };
      autoGrow(ta);                            // 宽 600 量过一次（观察者此时也记下 600）
      ta.clientWidth = 70; autoGrow(ta);       // 窄宽下又量了一次（这次记下的是 70），观察者没有任何通知
      const before = measured;
      ta.clientWidth = 600; observers[0].cb(); // 变回 600：与「量的那一刻」的 70 不同 → 必须重量
      assert.equal(measured, before + 1);
    } finally { delete global.ResizeObserver; }
  });
  it('浏览器里(有 requestAnimationFrame)重量放到下一帧,不在观察者回调里同步改高(免得报 ResizeObserver loop)', async () => {
    const observers = []; const frames = [];
    global.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} };
    global.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
    try {
      const { autoGrow } = await load('util.js');
      let measured = 0;
      const ta = { clientWidth: 300, style: {}, get scrollHeight() { measured += 1; return 60; } };
      autoGrow(ta);
      const before = measured;
      ta.clientWidth = 600; observers[0].cb();
      assert.equal(measured, before, '回调里不同步量');
      assert.equal(frames.length, 1, '排了一帧');
      frames.shift()();
      assert.equal(measured, before + 1, '下一帧量一次');
      ta.clientWidth = 400; observers[0].cb(); ta.clientWidth = 500;   // 排帧之后宽度又变了
      frames.shift()();
      assert.equal(measured, before + 1, '那一帧宽度已不是排帧时的宽度:不量(新宽度由观察者再排)');
    } finally { delete global.ResizeObserver; delete global.requestAnimationFrame; }
  });
  it('没有 ResizeObserver（单测桩子、旧环境）：行为与修前逐字相同，不抛', async () => {
    const { autoGrow } = await load('util.js');
    const ta = { style: {}, scrollHeight: 500 };
    autoGrow(ta);
    assert.equal(ta.style.height, '260px');
  });
});

describe('Ctrl+K 只有一个监听；帮助弹窗快捷键表补全', () => {
  it('app-frame.js 不再监听 Ctrl+K（键归 app.js 的命令面板）；app.js 仍是命令面板', () => {
    const frame = read(path.join(JS, 'app-frame.js'));
    const code = frame.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    assert.ok(!/toLowerCase\(\)\s*===\s*'k'/.test(code), 'app-frame.js 里还有 Ctrl+K 监听');
    assert.ok(!/#sessionSearch|byId\('sessionSearch'\)/.test(code), 'app-frame.js 不该再去聚焦左栏搜索框');
    assert.match(code, /event\.key === '`'/, 'Ctrl+` 切视角仍在');
    const app = read(path.join(PUBLIC, 'app.js'));
    assert.match(app, /toLowerCase\(\) === 'k'\) \{ e\.preventDefault\(\); openPalette\(\); \}/);
  });
  it('帮助弹窗的快捷键表有 Ctrl+` 与 Ctrl+Enter，文案走键，两语言齐', () => {
    const html = read(path.join(PUBLIC, 'index.html'));
    const table = html.slice(html.indexOf('<table class="kbd-table">'), html.indexOf('</table>', html.indexOf('<table class="kbd-table">')));
    assert.match(table, /<kbd>`<\/kbd>[\s\S]*?data-i18n="help\.switchLens"/);
    assert.match(table, /<kbd>Enter<\/kbd><\/td><td data-i18n="help\.answerQuestion"/);
    assert.match(table, /<kbd>Ctrl<\/kbd>\+<kbd>K<\/kbd><\/td><td data-i18n="help\.commandPalette"/, '原有的 Ctrl+K 命令面板行还在');
    for (const key of ['help.switchLens', 'help.answerQuestion']) {
      assert.ok(zh[key] && en[key] && !CJK.test(en[key]), key);
      assert.ok(html.includes(`data-i18n="${key}">${zh[key]}<`), `${key} 的 index.html 兜底文案与 zh-CN 不一致`);
    }
  });
  it('设置页那句提示不再声称 Ctrl+K 能搜线程（命令面板只列最近 12 条）', () => {
    assert.ok(!/Ctrl\+K/.test(zh['settings.steward.threadIndexRecentHint']) && !/Ctrl\+K/.test(en['settings.steward.threadIndexRecentHint']));
  });
});

describe('新增文案键：两语言齐全、占位符一致、英文零中文、镜像逐字节相同', () => {
  const KEYS = ['stewardShell.wait.needsYou', 'stewardShell.wait.lock', 'stewardShell.wait.lockUnknown', 'stewardShell.wait.budgetCost',
    'stewardShell.wait.budgetTurns', 'stewardShell.wait.slotAhead', 'stewardShell.wait.slotNext', 'chat.attachCancelAria',
    'help.switchLens', 'help.answerQuestion', 'memory.check.fill'];
  it('每个键在 zh-CN／en-US 都有非空文案，占位符一致，英文零中文', () => {
    for (const key of KEYS) {
      assert.ok(typeof zh[key] === 'string' && zh[key], `zh 缺 ${key}`);
      assert.ok(typeof en[key] === 'string' && en[key], `en 缺 ${key}`);
      assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key + ' 两语言占位符不一致');
      assert.ok(!CJK.test(en[key]), key + ' 的英文含中文');
    }
  });
  it('docs/i18n/locales 两份镜像与 public/locales 逐字节相同', () => {
    for (const file of ['zh-CN.json', 'en-US.json']) {
      assert.ok(fs.readFileSync(path.join(LOCALES, file)).equals(fs.readFileSync(path.join(MIRROR, file))), file + ' 镜像漂移');
    }
  });
});

describe('F7b 欢迎向导第七步：卡面只认本地化键', () => {
  it('卡片标题与说明直接取 onboarding.wizard.done.playbook(Hint).<id>，不再优先取 state.playbooks（切语言前取回的旧文案）', () => {
    const src = read(path.join(JS, 'onboarding-wizard.js'));
    const body = src.slice(src.indexOf('function buildDoneStep()'), src.indexOf('/* 118a-fix: manual entry'));
    assert.match(body, /el\('div', 'onboard-wiz-card-title', t\('onboarding\.wizard\.done\.playbook\.' \+ id\)\)/);
    assert.match(body, /el\('div', 'onboard-wiz-card-desc', t\('onboarding\.wizard\.done\.playbookHint\.' \+ id\)\)/);
    assert.ok(!/playbook\.title|playbook\.desc|playbook\.name/.test(body), '卡面不应再读 playbook 对象的文案字段');
  });
});
