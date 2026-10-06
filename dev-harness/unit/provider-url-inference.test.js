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
