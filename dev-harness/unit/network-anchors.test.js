'use strict';
// 2026-10 走查修复(w1-provider · 发现 5):联网探测的锚点(06 networkAnchors)不再把【本机 / 局域网】的 provider baseUrl 算进去。
// 修前 provider 的 baseUrl 无条件是探测目标之一:Ollama / 内网网关(回环、RFC1918、*.local、单标签主机名)能应答就判「在线」,
// 真断网时能力矩阵照写 network.online:true、web_search / web_fetch 照常提供、提示词告诉模型「当前在线」。
//   [N1] 本机 / 局域网 / 内网后缀 / 单标签主机名 / 链路本地 / IPv6 本地 → 不当锚点,只剩固定的公网锚点。
//   [N2] 公网地址(域名与公网 IP)照旧当锚点,排在固定锚点之前。
//   [N3] capabilityProbeUrl 仍是唯一权威目标(纯内网部署声明在线状态的口子),与本机 provider 无关。
//   [N4] 测试后门:WCW_TEST_LOCAL_PROVIDER_ANCHOR=1 让本机 provider 照旧当锚点(离线跑的 e2e 靠本机假 provider 充当「网络在线」);
//        WCW_TEST_NO_NET_ANCHORS=1 + 本机 provider → 没有任何目标(online:null,真未知)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-network-anchors-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
delete process.env.WCW_TEST_NO_NET_ANCHORS;
delete process.env.WCW_TEST_LOCAL_PROVIDER_ANCHOR;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { networkAnchors } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

const FIXED = ['https://www.baidu.com', 'https://cn.bing.com'];
const cfg = baseUrl => ({ providers: [{ id: 'p', type: 'openai-compat', baseUrl, apiKey: 'k', model: 'm' }], activeProvider: 'p' });

test('[N1] 本机 / 局域网的 provider 不当联网锚点', () => {
  const local = [
    'http://127.0.0.1:8000', 'http://127.0.0.1:11434/v1', 'http://localhost:11434', 'http://LOCALHOST.:1234',
    'http://10.0.0.5:8000/v1', 'http://172.16.3.4', 'http://172.31.255.1', 'http://192.168.1.20:3000/v1',
    'http://169.254.10.10', 'http://100.64.0.9:8080',
    'http://llm.local/v1', 'http://gpu-box.lan:8000', 'http://gw.corp.internal', 'http://nas.home.arpa',
    'http://ollama:11434', 'http://nas/v1',
    'http://[::1]:8000', 'http://[fd12:3456::1]:8000', 'http://[fe80::1]:80', 'http://[::ffff:127.0.0.1]:8000',
    'localhost:11434/v1',   // 没写协议的也认
  ];
  for (const baseUrl of local) assert.deepEqual(networkAnchors(cfg(baseUrl)), FIXED, `${baseUrl} 只说明本机 / 内网通,不能证明公网可达`);
});

test('[N2] 公网地址照旧当锚点(排在固定锚点之前)', () => {
  assert.deepEqual(networkAnchors(cfg('https://api.deepseek.com')), ['https://api.deepseek.com/v1', ...FIXED]);
  assert.deepEqual(networkAnchors(cfg('https://api.openai.com/v1')), ['https://api.openai.com/v1', ...FIXED]);
  assert.deepEqual(networkAnchors(cfg('http://8.8.8.8:8000')), ['http://8.8.8.8:8000/v1', ...FIXED]);
  assert.deepEqual(networkAnchors(cfg('http://172.32.0.1')), ['http://172.32.0.1/v1', ...FIXED], '172.32 不在 RFC1918 的 172.16/12 里');
  assert.deepEqual(networkAnchors({ providers: [], activeProvider: '' }), FIXED, '没有 provider:只有固定锚点');
});

test('[N3] capabilityProbeUrl 是唯一权威目标', () => {
  assert.deepEqual(networkAnchors({ ...cfg('http://127.0.0.1:8000'), capabilityProbeUrl: 'http://intranet.health/ok' }), ['http://intranet.health/ok']);
  assert.deepEqual(networkAnchors({ ...cfg('https://api.deepseek.com'), capabilityProbeUrl: 'http://intranet.health/ok' }), ['http://intranet.health/ok']);
});

test('[N4] 测试后门', () => {
  process.env.WCW_TEST_LOCAL_PROVIDER_ANCHOR = '1';
  try {
    assert.deepEqual(networkAnchors(cfg('http://127.0.0.1:8000')), ['http://127.0.0.1:8000/v1', ...FIXED], '后门开:本机 provider 照旧当锚点');
    process.env.WCW_TEST_NO_NET_ANCHORS = '1';
    assert.deepEqual(networkAnchors(cfg('http://127.0.0.1:8000')), ['http://127.0.0.1:8000/v1'], '后门开 + 去掉固定锚点:只剩本机 provider(旧件的离线模拟口径)');
  } finally { delete process.env.WCW_TEST_LOCAL_PROVIDER_ANCHOR; }
  assert.deepEqual(networkAnchors(cfg('http://127.0.0.1:8000')), [], '后门关 + 没有固定锚点 + 本机 provider → 没有任何目标(online:null,真未知)');
  delete process.env.WCW_TEST_NO_NET_ANCHORS;
});
