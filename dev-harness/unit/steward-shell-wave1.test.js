#!/usr/bin/env node
'use strict';

// 前端走查第一批（管家壳）的纯函数／静态契约快通道。真浏览器那一半在 dev-harness/steward-shell-wave1.browser.e2e.js。
//
//   S-15 isQuietSuppressed：免打扰时段只在「开启了本机通知」时才压提示（默认 enabled:false 而时段默认 22:00–08:00，
//        修前没动过设置的人夜里收不到安静卡）；isQuietTime 仍是纯时间判断，不看 enabled。
//   S-14 stewardThreadToolLabel／railRunningLine：左栏在跑行第二行说人话（工具名走抽屉那张表、时长走「刚刚／3 分钟前」）。
//   S-12 stewardThreadEnvelopeLite：缓存里瘦身后的信封喂给 stewardThreadFacts 得到与整份信封逐字相同的事实，且不带 messages。
//   S-09 桌面壳：前端有 ruyiNotification 的发送方，字段名与 RuyiDesktop.cs 的解析一致。
//   S-11 / 全部新文案键：两语言都有、占位符一致、docs/i18n 镜像逐字节相同。
//
// ESM 前端模块直接 import 磁盘文件（与 unit/notify-policy.test.js 同款约定）；零磁盘写、零 DOM。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const JS = path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'js');
const LOCALES = path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'locales');
const MIRROR = path.join(ROOT, 'docs', 'i18n', 'locales');
const load = name => import(pathToFileURL(path.join(JS, name)).href);
const read = file => fs.readFileSync(file, 'utf8');

describe('S-15 免打扰时段只在开启本机通知时才压提示', () => {
  const at = (h, m = 0) => new Date(2026, 9, 5, h, m, 0);
  it('默认设置（enabled:false，时段 22:00–08:00）夜里不压；isQuietTime 本身仍说「在时段内」', async () => {
    const { isQuietSuppressed, isQuietTime, DEFAULT_NOTIFY_SETTINGS } = await load('notify-policy.js');
    assert.equal(DEFAULT_NOTIFY_SETTINGS.enabled, false);
    assert.equal(isQuietTime(at(23), DEFAULT_NOTIFY_SETTINGS), true);           // 纯时间判断：钉死不变
    assert.equal(isQuietSuppressed(at(23), DEFAULT_NOTIFY_SETTINGS), false);    // 没开通知 → 安静卡照出
    assert.equal(isQuietSuppressed(at(3), null), false);                        // 读不到设置＝默认
    assert.equal(isQuietSuppressed(at(3), { enabled: 'yes' }), false);          // 只认严格 true
  });
  it('开启之后时段生效：时段内压、时段外不压，跨午夜与同日段都对', async () => {
    const { isQuietSuppressed } = await load('notify-policy.js');
    const on = { enabled: true, quietStart: '22:00', quietEnd: '08:00' };
    assert.equal(isQuietSuppressed(at(23), on), true);
    assert.equal(isQuietSuppressed(at(7, 59), on), true);
    assert.equal(isQuietSuppressed(at(8), on), false);
    assert.equal(isQuietSuppressed(at(12), on), false);
    assert.equal(isQuietSuppressed(at(13), { enabled: true, quietStart: '12:00', quietEnd: '14:00' }), true);
    assert.equal(isQuietSuppressed(at(13), { enabled: true, quietStart: '09:00', quietEnd: '09:00' }), false);   // 起止相同＝不设
  });
});

describe('S-14 左栏在跑行第二行说人话', () => {
  const tpl = (key, vars) => key + (vars ? '|' + JSON.stringify(vars) : '');
  it('stewardThreadToolLabel：表内走人话键，表外（含 mcp__ 机器把手）一律「一个工具」', async () => {
    const { stewardThreadToolLabel } = await load('steward-drawer.js');
    assert.equal(stewardThreadToolLabel('Read', tpl), 'stewardShell.drawer.tool.read');
    assert.equal(stewardThreadToolLabel('Grep', tpl), 'stewardShell.drawer.tool.search');
    assert.equal(stewardThreadToolLabel('mcp__playwright__browser_click', tpl), 'stewardShell.drawer.tool.other');
    assert.equal(stewardThreadToolLabel('', tpl), 'stewardShell.drawer.tool.other');
  });
  it('railRunningLine：不漏工具原名、不印 2s／1m 05s 缩写；没工具名给中性占位；算不出时间就只说工具', async () => {
    const { railRunningLine } = await load('steward-board.js');
    const ago = iso => (iso ? '3 分钟前' : '');
    const row = { updatedAt: '2026-10-05T00:00:00.000Z', liveTail: { tool: 'mcp__playwright__browser_click', updatedAt: '2026-10-05T00:00:00.000Z' } };
    const line = railRunningLine(row, { t: tpl, ago });
    assert.equal(line, 'rail.liveToolAgo|' + JSON.stringify({ tool: 'stewardShell.drawer.tool.other', ago: '3 分钟前' }));
    assert.ok(!/mcp__|playwright|browser_click/.test(line), '工具原名不许漏到左栏');
    assert.ok(!/\b\d+s\b|\d+m \d\ds/.test(line), '时长缩写不许混进来');
    assert.equal(railRunningLine({ liveTail: { tool: '' } }, { t: tpl, ago }), 'rail.liveRunning');
    assert.equal(railRunningLine({}, { t: tpl, ago }), 'rail.liveRunning');
    assert.equal(railRunningLine({ liveTail: { tool: 'Read' } }, { t: tpl, ago: () => '' }), 'stewardShell.drawer.tool.read');
  });
});

describe('S-12 deliverableCache 只缓存瘦身后的事实', () => {
  const payloads = () => [
    { displayTitle: '甲', relay: { channel: 'answer' }, resumable: { live: false },
      session: { updatedAt: '2026-10-01T00:00:00Z', turnSeq: 3, stewardLastTurn: { ok: true }, engineRoute: { model: 'm-route' },
        messages: [{ role: 'user', content: 'x'.repeat(5000) }, { role: 'assistant', model: 'm-msg', content: 'y'.repeat(5000) }] } },
    { displayTitle: '乙', relay: { channel: 'queued' }, session: { turnSeq: 1, messages: [{ role: 'assistant', model: 'm-fallback' }] } },
    { displayTitle: '丙', resumable: { live: true }, session: { turnSeq: 0, messages: [] } },
    { displayTitle: '丁', session: { turnSeq: 2, stewardLastTurn: { ok: false }, updatedAt: '2026-10-02T00:00:00Z' } },
    { displayTitle: '戊', relay: { channel: 'steer' } },
    {}, null, undefined,
  ];
  it('瘦身前后 stewardThreadFacts 的输出逐字相同（含「模型缺席时取最后一条助手消息的 model」那条回落）', async () => {
    const { stewardThreadFacts, stewardThreadEnvelopeLite } = await load('steward-conversation.js');
    for (const payload of payloads()) {
      assert.deepEqual(stewardThreadFacts(stewardThreadEnvelopeLite(payload)), stewardThreadFacts(payload),
        '事实不变：' + JSON.stringify(payload && payload.displayTitle));
    }
  });
  it('瘦身后的信封里没有 messages，体积与会话长度无关', async () => {
    const { stewardThreadEnvelopeLite } = await load('steward-conversation.js');
    const lite = stewardThreadEnvelopeLite(payloads()[0]);
    assert.ok(!('messages' in lite.session));
    assert.ok(JSON.stringify(lite).length < 400, '瘦身后应当只剩几十个字节的事实：' + JSON.stringify(lite).length);
  });
  it('缓存有上限（LRU：命中挪到最新、满了淘汰最老的）', () => {
    const source = read(path.join(JS, 'steward-conversation.js'));
    assert.match(source, /const DELIVERABLE_CACHE_MAX = 50;/);
    assert.match(source, /while \(deliverableCache\.size > DELIVERABLE_CACHE_MAX\) deliverableCache\.delete\(deliverableCache\.keys\(\)\.next\(\)\.value\);/);
    assert.match(source, /deliverableCache\.delete\(key\); deliverableCache\.set\(key, hit\);/);
  });
});

describe('S-09 桌面壳通知有前端发送方', () => {
  it('quiet-card.js 在桌面壳里发 chrome.webview.postMessage({ ruyiNotification:{ title, body } })，且仍保留浏览器 Notification 回落', () => {
    const quiet = read(path.join(JS, 'quiet-card.js'));
    assert.match(quiet, /bridge\.postMessage\(\{ ruyiNotification: \{ id: entry\.key, title, body \} \}\)/);
    assert.match(quiet, /globalThis\.__ruyiDesktop === 1 && bridge && typeof bridge\.postMessage === 'function'/);
    assert.match(quiet, /new notificationApi\(title, \{ body, tag: entry\.key \}\)/);
  });
  it('宿主 RuyiDesktop.cs 读的正是 ruyiNotification 下的 title／body', () => {
    const host = read(path.join(ROOT, 'ruyi-workbench', 'desktop', 'RuyiDesktop.cs'));
    assert.match(host, /TryGetValue\("ruyiNotification"/);
    assert.match(host, /TryGetValue\("title"/);
    assert.match(host, /TryGetValue\("body"/);
  });
});

describe('新增文案键：两语言齐全、占位符一致、镜像逐字节相同', () => {
  const KEYS = [
    'rail.liveToolAgo',
    'stewardShell.drawer.threadSwitchedCancelled',
    'stewardShell.compose.attachNeedsSteward',
    'quietCard.answerGone',
    'quietCard.answerFailed',
    'chat.background.partial',
    'chat.background.stopped',
    'chat.background.interrupted',
    'chat.background.finished',
  ];
  const zh = JSON.parse(read(path.join(LOCALES, 'zh-CN.json')));
  const en = JSON.parse(read(path.join(LOCALES, 'en-US.json')));
  const placeholders = text => [...String(text).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort();
  it('每个键在 zh-CN／en-US 都有非空文案，占位符名字一致', () => {
    for (const key of KEYS) {
      assert.ok(zh[key] && String(zh[key]).trim(), 'zh-CN 缺 ' + key);
      assert.ok(en[key] && String(en[key]).trim(), 'en-US 缺 ' + key);
      assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key + ' 两语言占位符不一致');
    }
  });
  it('后台任务七种终态都有文案（不再显示「[chat.background.partial]」），并有通用回落', () => {
    for (const status of ['succeeded', 'failed', 'timed_out', 'cancelled', 'partial', 'stopped', 'interrupted']) {
      assert.ok(zh['chat.background.' + status], 'zh-CN 缺 chat.background.' + status);
      assert.ok(en['chat.background.' + status], 'en-US 缺 chat.background.' + status);
    }
    assert.ok(zh['chat.background.finished'] && en['chat.background.finished']);
  });
  it('docs/i18n/locales 两份镜像与 public/locales 逐字节相同', () => {
    for (const file of ['zh-CN.json', 'en-US.json']) {
      assert.ok(fs.readFileSync(path.join(LOCALES, file)).equals(fs.readFileSync(path.join(MIRROR, file))), file + ' 镜像漂移');
    }
  });
});
