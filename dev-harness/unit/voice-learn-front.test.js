'use strict';
// Unit:59 号文 §6(从修改里学)的前端一侧 —— composer-voice.js 的发送事件与「交给服务端学」那一步。
//
//   [F1] 前后端上限同值:账最多几句 = 服务端一次最多几句;发出去的字上限 = 服务端上限
//   [F2] composerSent 在输入框上派冒泡的 COMPOSER_VOICE_SENT_EVENT,detail.text = 发出去的字
//   [F3] 三条发送路都派同一个事件、且在清空输入框之前派:工作台 sendPrompt / steerPrompt 运行完整 runtime,
//        管家输入行 submit 保留 composerSent 的结构性接线判据。
//   [F4] 发送监听:配了语音识别才交;只认自己那个输入框;太长不交;交的是 { sentences, final };学会新词提示一句;
//        服务端报错不打扰
//   [F5] 提示文案:有错听样子 / 没有 / 不止一个
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { functionBlock } = require('../lib/source-slice.js');
const { fixture: composerFixture } = require('../lib/composer-race-fixture.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-voice-learn-front-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const { VoiceLearn } = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
const PUBLIC_JS = path.join(repo, 'ruyi-workbench', 'app', 'public', 'js');
const load = () => import(pathToFileURL(path.join(PUBLIC_JS, 'composer-voice.js')).href);
const fmt = (key, params = {}) => key + JSON.stringify(params);

test('[F1] 前后端上限同值', async () => {
  const cv = await load();
  assert.equal(cv.COMPOSER_VOICE_LEDGER_MAX, VoiceLearn.MAX_SENTENCES);
  assert.equal(cv.COMPOSER_VOICE_LEARN_MAX_CHARS, VoiceLearn.MAX_FINAL_CHARS);
});

test('[F2] composerSent 在输入框上派冒泡事件', async () => {
  const cv = await load();
  const box = new EventTarget();
  let got = null;
  box.addEventListener(cv.COMPOSER_VOICE_SENT_EVENT, e => { got = e; });
  cv.composerSent(box, '你好 world');
  assert.ok(got && got.bubbles === true);
  assert.deepEqual(got.detail, { text: '你好 world' });
  assert.doesNotThrow(() => cv.composerSent(null, 'x'));
});

test('[F3] 三条发送路派同一个事件,且在清空输入框之前', async () => {
  const cv = await load();
  for (const name of ['sendPrompt', 'steerPrompt']) {
    for (const override of [false, true]) {
      const fx = composerFixture();
      if (name === 'sendPrompt') fx.state.sessionRelay = null;
      fx.nodes.promptInput.value = '输入框里的字';
      const pending = fx.runtime.sendPrompt(override ? '/compact' : undefined);
      if (name === 'steerPrompt') { fx.response.resolve({ ok: true }); await pending; }
      else await new Promise(resolve => setImmediate(resolve));
      if (override) {
        assert.equal(fx.nodes.promptInput.events.length, 0, name + ':覆写文字不派事件');
        assert.equal(fx.nodes.promptInput.value, '输入框里的字', name + ':覆写文字不清草稿');
      } else {
        assert.deepEqual(fx.nodes.promptInput.events, [{ type: cv.COMPOSER_VOICE_SENT_EVENT, text: '输入框里的字', before: '输入框里的字', bubbles: true }], name + ':先派同一事件、再清空输入框');
        assert.equal(fx.nodes.promptInput.value, '');
      }
    }
  }
  const steward = fs.readFileSync(path.join(PUBLIC_JS, 'steward-composer.js'), 'utf8');
  assert.match(steward, /import \{ createComposerVoice, composerSent \} from '\.\/composer-voice\.js';/);
  const submit = functionBlock(steward, 'submit');
  assert.ok(submit.indexOf('composerSent(input, text);') > 0 && submit.indexOf('composerSent(input, text);') < submit.indexOf("input.value = '';"), '管家输入行:先派事件、再清空');
});

test('[F4] 发送监听:交给服务端学', async () => {
  const cv = await load();
  const handlers = [];
  const prevDoc = globalThis.document;
  globalThis.document = { addEventListener: (type, fn) => { if (type === cv.COMPOSER_VOICE_SENT_EVENT) handlers.push(fn); } };
  try {
    const box = { value: '' };
    const calls = [], notes = [];
    let reply = { ok: true, learn: true, learned: [{ term: '张玮', heard: '张伟' }], reversed: 0 };
    let status = 200;
    const state = { config: { asrProviderId: 'p', asrModel: 'm' } };
    cv.createComposerVoice({
      state, t: fmt, input: () => box, anchor: () => null, notify: (text, kind) => notes.push([text, kind]),
      request: async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { ok: status === 200, status, json: async () => reply }; },
    });
    assert.equal(handlers.length, 1, '每个麦克风只挂一个发送监听');
    const fire = async (target, text) => { await handlers[0]({ target, detail: { text } }); };
    await fire(box, '我和张玮去吃饭');
    assert.deepEqual(calls, [['/api/audio/lexicon/observe', { sentences: [], final: '我和张玮去吃饭' }]], '没用麦克风的消息也交(只抽打的字)');
    assert.deepEqual(notes, [['composer.voice.learned{"term":"张玮","heard":"张伟","more":""}', 'ok']]);
    await fire({ value: '' }, '别的输入框');
    assert.equal(calls.length, 1, '只认自己那个输入框');
    await fire(box, '   ');
    await fire(box, 'x'.repeat(cv.COMPOSER_VOICE_LEARN_MAX_CHARS + 1));
    assert.equal(calls.length, 1, '空的、太长的不交');
    state.config = { asrProviderId: '', asrModel: '' };
    await fire(box, 'hello');
    assert.equal(calls.length, 1, '没配语音识别不交');
    state.config = { asrProviderId: 'p', asrModel: 'm' };
    reply = { ok: true, learn: true, learned: [], reversed: 0 };
    await fire(box, 'hello');
    status = 500;
    await fire(box, 'hello again');
    assert.equal(calls.length, 3);
    assert.equal(notes.length, 1, '没学会新词、服务端报错:都不提示');
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
});

test('[F5] 提示文案', async () => {
  const cv = await load();
  assert.equal(cv.composerVoiceLearnedText([], fmt), '');
  assert.equal(cv.composerVoiceLearnedText(null, fmt), '');
  assert.equal(cv.composerVoiceLearnedText([{ term: 'Redis', heard: '瑞迪斯' }], fmt), 'composer.voice.learned{"term":"Redis","heard":"瑞迪斯","more":""}');
  assert.equal(cv.composerVoiceLearnedText([{ term: 'FooBar', heard: '' }], fmt), 'composer.voice.learnedTerm{"term":"FooBar","more":""}');
  assert.equal(cv.composerVoiceLearnedText([{ term: 'A1', heard: 'x' }, { term: 'B2' }, { bad: 1 }], fmt),
    'composer.voice.learned{"term":"A1","heard":"x","more":"composer.voice.learnedMore{\\"count\\":1}"}');
  const zh = JSON.parse(fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
  for (const key of ['composer.voice.learned', 'composer.voice.learnedTerm']) assert.match(zh[key], /\{\{more\}\}/, key + ' 留着 {{more}} 的位置');
});
