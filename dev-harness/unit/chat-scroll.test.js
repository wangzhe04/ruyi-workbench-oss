#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'chat-scroll.js');
const moduleSource = fs.readFileSync(MODULE_PATH, 'utf8');
let modulePromise;
function loadModule() {
  if (!modulePromise) {
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(moduleSource, 'utf8').toString('base64');
    modulePromise = import(dataUrl);
  }
  return modulePromise;
}

function fixture() {
  const box = { scrollHeight: 1000, scrollTop: 800, clientHeight: 200 };
  const visibility = [];
  const button = { classList: { toggle: (name, hidden) => visibility.push({ name, hidden }) } };
  let streaming = true;
  return {
    box,
    button,
    visibility,
    setStreaming: value => { streaming = value; },
    options: {
      getMessages: () => box,
      getJumpLatest: () => button,
      isStreaming: () => streaming,
    },
  };
}

describe('chat scroll controller', () => {
  it('follows DOM growth while sticky without reclassifying growth as user scroll', async () => {
    const { createChatScrollController } = await loadModule();
    const f = fixture();
    const scroll = createChatScrollController(f.options);
    f.box.scrollHeight = 1250;
    scroll.maybeScrollToBottom();
    assert.equal(f.box.scrollTop, 1250);
    assert.equal(scroll.isStickyScroll(), true);
  });

  it('stops following after a real upward scroll and resumes near the bottom', async () => {
    const { createChatScrollController } = await loadModule();
    const f = fixture();
    const scroll = createChatScrollController(f.options);
    f.box.scrollTop = 300;
    assert.equal(scroll.syncStickToBottom(), false);
    f.box.scrollHeight = 1400;
    scroll.maybeScrollToBottom();
    assert.equal(f.box.scrollTop, 300);
    assert.equal(f.visibility.at(-1).hidden, false);

    f.box.scrollTop = 1090;
    assert.equal(scroll.syncStickToBottom(), true);
    f.box.scrollHeight = 1500;
    scroll.maybeScrollToBottom();
    assert.equal(f.box.scrollTop, 1500);
  });

  it('explicit jump restores sticky follow and hides the jump control', async () => {
    const { createChatScrollController } = await loadModule();
    const f = fixture();
    const scroll = createChatScrollController(f.options);
    f.box.scrollTop = 250;
    scroll.syncStickToBottom();
    assert.equal(scroll.isStickyScroll(), false);

    scroll.resetStickyScroll();
    assert.equal(scroll.isStickyScroll(), true);
    assert.equal(f.box.scrollTop, 250, 'reset only restores intent before the new view is rendered');
    scroll.scrollMessagesToBottom();
    assert.equal(f.box.scrollTop, f.box.scrollHeight);
    assert.equal(scroll.isStickyScroll(), true);
    assert.equal(f.visibility.at(-1).hidden, true);
  });

  it('does not expose the jump control after streaming ends', async () => {
    const { createChatScrollController } = await loadModule();
    const f = fixture();
    const scroll = createChatScrollController(f.options);
    f.box.scrollTop = 100;
    scroll.syncStickToBottom();
    assert.equal(f.visibility.at(-1).hidden, false);
    f.setStreaming(false);
    scroll.updateJumpLatest();
    assert.equal(f.visibility.at(-1).hidden, true);
  });

  // 2026-10-04:mermaid 图异步画完替换源码块,不走流式路径。修前没人重新贴底,8 张图的回复画完视图停在半途。
  it('keeps the view pinned across an async layout change while following at the bottom', async () => {
    const { createChatScrollController } = await loadModule();
    const f = fixture();
    f.setStreaming(false);
    const scroll = createChatScrollController(f.options);
    let ranInside = false;
    scroll.keepPinnedAcross(() => { ranInside = true; f.box.scrollHeight = 1600; });
    assert.equal(ranInside, true);
    assert.equal(f.box.scrollTop, 1600);
    assert.equal(scroll.isStickyScroll(), true);
  });

  it('leaves the view alone when the user scrolled up, or a jump moved it before its scroll event arrived', async () => {
    const { createChatScrollController } = await loadModule();
    const f = fixture();
    const scroll = createChatScrollController(f.options);
    // 用户上滑(真实 scroll 事件已到):不粘。
    f.box.scrollTop = 300;
    scroll.syncStickToBottom();
    scroll.keepPinnedAcross(() => { f.box.scrollHeight = 1600; });
    assert.equal(f.box.scrollTop, 300);
    // 「加载更早」直接把 scrollTop 写成 0,滚动事件还没到:粘性仍是 true,但视图已不在底部 —— 不拽回去。
    const g = fixture();
    const fresh = createChatScrollController(g.options);
    g.box.scrollTop = 0;
    assert.equal(fresh.isStickyScroll(), true);
    fresh.keepPinnedAcross(() => { g.box.scrollHeight = 1600; });
    assert.equal(g.box.scrollTop, 0);
  });

  it('still pins when the layout change throws, and rethrows the error', async () => {
    const { createChatScrollController } = await loadModule();
    const f = fixture();
    const scroll = createChatScrollController(f.options);
    assert.throws(() => scroll.keepPinnedAcross(() => { f.box.scrollHeight = 1400; throw new Error('boom'); }), /boom/);
    assert.equal(f.box.scrollTop, 1400);
  });
});
