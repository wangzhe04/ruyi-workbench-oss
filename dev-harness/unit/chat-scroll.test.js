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
});
