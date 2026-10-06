'use strict';
// 前端协议表(public/js/provider-api-styles.js)里「按地址收拾服务商」的三个纯函数:设置页服务商卡片与欢迎向导共用。
// 2026-10 用户报「Anthropic API 接入有问题、太复杂」:填 https://api.deepseek.com/anthropic 时协议要自己切到 Anthropic,
// 粘进来的完整端点(…/v1/messages、…/chat/completions、…/responses)要剥掉,否则拼成重复路径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const modPath = pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/provider-api-styles.js')).href;

test('[U1] inferProviderApiStyleFromUrl:只在明显时给出协议', async () => {
  const { inferProviderApiStyleFromUrl: infer } = await import(modPath);
  for (const url of ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic/', 'https://open.bigmodel.cn/api/anthropic',
    'https://gw.example.cn/anthropic/v1', 'https://api.anthropic.com', 'https://API.ANTHROPIC.COM/v1', 'https://x.example/v1/messages']) {
    assert.equal(infer(url), 'anthropic', url);
  }
  assert.equal(infer('https://api.example.com/v1/chat/completions'), 'chat');
  assert.equal(infer('https://api.example.com/responses'), 'responses');
  for (const url of ['', 'https://api.deepseek.com', 'https://api.example.com/v1', 'http://127.0.0.1:11434/v1', 'https://anthropic-proxy.example/v1',
    'https://api.anthropic.com.evil.example', 'https://x.example/anthropic-mirror']) {
    assert.equal(infer(url), '', url);
  }
});

test('[U2] stripProviderEndpointSuffix:剥掉粘进来的端点,只留 base', async () => {
  const { stripProviderEndpointSuffix: strip } = await import(modPath);
  assert.equal(strip(' https://api.deepseek.com/anthropic/v1/messages '), 'https://api.deepseek.com/anthropic');
  assert.equal(strip('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com');
  assert.equal(strip('https://x.example/anthropic/messages/'), 'https://x.example/anthropic');
  assert.equal(strip('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  assert.equal(strip('https://api.example.com/responses'), 'https://api.example.com');
  assert.equal(strip('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(strip('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic');
});

test('[U3] isAnthropicOfficialUrl 与服务端 anthropicOfficialHost 同一判据(只认官方主机)', async () => {
  const { isAnthropicOfficialUrl: official } = await import(modPath);
  assert.equal(official('https://api.anthropic.com'), true);
  assert.equal(official('HTTPS://API.ANTHROPIC.COM/'), true);
  assert.equal(official('https://api.anthropic.com.evil.example'), false);
  assert.equal(official('https://proxy.example/api.anthropic.com'), false);
  assert.equal(official('https://api.deepseek.com/anthropic'), false);
});

// 第三波复核:设置页逐键推断协议时,「敲到 …/anthropic 就切、之后不切回」。纯状态机放在协议表里,这里钉死它。
test('[U4] stepAutoProviderStyle:自动切换只对「没手动选过」的卡;推断落空要切回切换前的协议;存量协议不被动', async () => {
  const { stepAutoProviderStyle: step } = await import(modPath);
  assert.equal(typeof step, 'function', 'stepAutoProviderStyle 不存在(修前代码没有这个状态机)');
  // 逐键敲 …/anthropic-proxy/v1:中途(敲到 …/anthropic)会切到 Anthropic,敲到「-」就要切回,最终是 chat
  const url = 'https://x.example/openai/anthropic-proxy/v1';
  let state = { style: 'chat', touched: false, auto: null };
  const trail = [];
  for (let i = 1; i <= url.length; i++) {
    const r = step(state, url.slice(0, i));
    if (r.action) trail.push([url.slice(0, i).slice(-12), r.action, r.style]);
    state = { ...state, style: r.style, auto: r.auto };
  }
  assert.equal(state.style, 'chat', '最终地址推断不出 Anthropic → 协议回到 chat');
  assert.equal(state.auto, null);
  assert.deepEqual(trail.map(x => x[1]), ['switched', 'reverted'], `中途切过去、随后切回(trail=${JSON.stringify(trail)})`);
  // 粘 /anthropic(切)→ 改粘 chat 地址(切回)
  let r = step({ style: 'chat', touched: false, auto: null }, 'https://api.deepseek.com/anthropic');
  assert.deepEqual([r.style, r.action, r.auto && r.auto.from], ['anthropic', 'switched', 'chat']);
  r = step({ style: r.style, touched: false, auto: r.auto }, 'https://api.deepseek.com/v1');
  assert.deepEqual([r.style, r.action, r.auto], ['chat', 'reverted', null]);
  // 切换前是 responses(DeepSeek 预设):切回的是 responses 而不是缺省 chat
  r = step({ style: 'responses', touched: false, auto: null }, 'https://gw.example/anthropic/v1');
  assert.equal(r.style, 'anthropic');
  r = step({ style: r.style, touched: false, auto: r.auto }, '');
  assert.deepEqual([r.style, r.action], ['responses', 'reverted']);
  // 自动切换之间互相换手(anthropic → chat 端点)保留最初的「切换前」:再落空时回到最初那个
  r = step({ style: 'responses', touched: false, auto: null }, 'https://x/anthropic');
  r = step({ style: r.style, touched: false, auto: r.auto }, 'https://x/v1/chat/completions');
  assert.deepEqual([r.style, r.action, r.auto && r.auto.from], ['chat', 'switched', 'responses']);
  r = step({ style: r.style, touched: false, auto: r.auto }, 'https://x/v1');
  assert.deepEqual([r.style, r.action, r.auto], ['responses', 'reverted', null]);
  // 手动选过:地址怎么变都不动(也不记 auto)
  r = step({ style: 'anthropic', touched: true, auto: null }, 'https://api.deepseek.com/v1');
  assert.deepEqual([r.style, r.action, r.auto], ['anthropic', '', null]);
  r = step({ style: 'chat', touched: true, auto: null }, 'https://api.deepseek.com/anthropic');
  assert.deepEqual([r.style, r.action], ['chat', '']);
  // 存量卡本来就是 anthropic:地址推断一致不记 auto;之后改成别的地址也不能把人家存好的协议切走
  r = step({ style: 'anthropic', touched: false, auto: null }, 'https://api.deepseek.com/anthropic');
  assert.deepEqual([r.style, r.action, r.auto], ['anthropic', '', null]);
  r = step({ style: 'anthropic', touched: false, auto: null }, 'https://gw.example/custom');
  assert.deepEqual([r.style, r.action, r.auto], ['anthropic', '', null]);
  // 不认识的地址、空地址:什么都不做
  r = step({ style: 'chat', touched: false, auto: null }, '');
  assert.deepEqual([r.style, r.action, r.auto], ['chat', '', null]);
});

// 第三波复核:向导重开后再粘完整端点 —— 已存的服务商地址是剥过后缀的,比较时两边都要过同一道剥除,否则不复用、重复建 -2 且要求重填 key。
test('[U5] reusableProviderFor:比较的是剥过端点后缀的地址', async () => {
  const wizPath = pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/onboarding-wizard.js')).href;
  const { reusableProviderFor: reuse3 } = await import(wizPath);
  const { stripProviderEndpointSuffix } = await import(modPath);
  // 向导把注入的 normalizeProviderDraftEndpoint 包成第四个实参传进来;这里用同一个剥除函数代它
  const reuse = (providers, presetId, url) => reuse3(providers, presetId, url, stripProviderEndpointSuffix);
  const saved = [{ id: 'openai-compatible', baseUrl: 'https://api.deepseek.com/anthropic', apiStyle: 'anthropic' }, { id: 'openai-compatible-2', baseUrl: 'https://other.example/v1' }];
  assert.equal(reuse(saved, 'openai-compatible', 'https://api.deepseek.com/anthropic').id, 'openai-compatible', '同一地址照旧复用');
  assert.equal(reuse(saved, 'openai-compatible', ' HTTPS://API.DEEPSEEK.COM/anthropic/ ').id, 'openai-compatible', '空白 / 大小写 / 尾斜杠照旧');
  assert.equal((reuse(saved, 'openai-compatible', 'https://api.deepseek.com/anthropic/v1/messages') || {}).id, 'openai-compatible', '粘的是完整端点 → 剥掉后缀再比,复用已存的');
  assert.equal((reuse([{ id: 'custom', baseUrl: 'https://x.example/v1' }], 'custom', 'https://x.example/v1/chat/completions') || {}).id, 'custom');
  assert.equal(reuse(saved, 'openai-compatible', 'https://api.deepseek.com/v1/messages'), null, '不同地址不复用');
  assert.equal(reuse(saved, 'ollama', 'https://api.deepseek.com/anthropic'), null, '不同预设谱系不复用');
  // 不传第四个实参(纯函数老用法):行为与修前逐字一致
  assert.equal(reuse3(saved, 'openai-compatible', 'https://api.deepseek.com/anthropic/').id, 'openai-compatible');
  assert.equal(reuse3(saved, 'openai-compatible', 'https://api.deepseek.com/anthropic/v1/messages'), null);
});
