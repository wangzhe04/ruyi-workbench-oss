#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(服务启动会导入真机 MCP 配置,见 lib 头注)
// 128e(48 号文 §1),2.8.0 热修线移植:工作台 MCP 服务的资源面不许把明文密钥交给模型。
//
// 修前:`resources/list` 列出一条「Workbench config」,`resources/read` 把 config.json 【原样】读出来返回 ——
// 里面是明文的 provider apiKey、Claude CLI 的 modelsApiKey、外部 MCP 连接器 env 里的令牌。连到工作台 MCP 的模型
// (Claude 引擎会话;以及用户自己 Claude Code 里登记了工作台 MCP 的会话)都能用读资源的工具把它们读走。
// 同一批值在状态接口上早在 107-S0／S0b 就掩码了,文件工具也把 config.json 列为敏感路径拒读 ——
// 资源面是绕过这两道门的第三条路。(这里不写路由字面量:路由清册把测试文件里出现的路由串算作覆盖,本件并不打那条路由。)
// 判据(真子进程 `server.js mcp`,合成配置,假密钥):
//   R1 列出的资源仍是那一条(不改接口形状);
//   R2 读出来的内容里【一个明文密钥都没有】(三处埋的假密钥逐字搜);
//   R3 读出来的是掩码形(••••后四位)且仍是合法 JSON(调用方拿到的是有用的配置视图,而不是一个空壳)。
// 收尾只杀自己 spawn 的那一个 PID(child.kill),不用 taskkill /T —— /T 按父进程号认子孙,撞号会带走别人的树。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-128e-'));
const SECRETS = {
  provider: 'sk-128e-provider-SECRET-a1b2c3d4e5f6',
  cliModel: 'sk-128e-clikey-SECRET-f6e5d4c3b2a1',
  mcpEnv: 'ghp_128eMcpEnvSECRET0123456789abcdef',
};
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 12, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
  providers: [{ id: 'p1', label: 'P1', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: SECRETS.provider, models: [{ id: 'm', label: 'm' }] }],
  activeProvider: 'p1',
  modelsApiKey: SECRETS.cliModel,
  externalMcpServers: [{ id: 'gh', command: 'node', args: ['-e', '0'], env: { GITHUB_TOKEN: SECRETS.mcpEnv } }],
}, null, 2));

(async () => {
  const child = cp.spawn(process.execPath, [SERVER, 'mcp'], {
    cwd: path.join(ROOT, 'ruyi-workbench', 'app'),
    env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME },
    windowsHide: true,
  });
  child.stdin.on('error', () => { /* 收尸后迟到的写入 */ });
  let buf = '';
  const replies = new Map();
  child.stdout.on('data', d => {
    buf += String(d);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); if (msg.id != null) replies.set(msg.id, msg); } catch { /* 非 JSON 行 */ }
    }
  });
  const rpc = async (id, method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise(r => setTimeout(r, 50));
    return replies.get(id) || null;
  };
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: '128e', version: '1' } });
    ok(Boolean(init && init.result), 'MCP 子进程回了 initialize');
    const list = await rpc(2, 'resources/list');
    const resources = (list && list.result && list.result.resources) || [];
    ok(resources.length === 1 && /config/i.test(String(resources[0].name || '')), `R1 资源列表仍是那一条配置资源(实 ${resources.length})`);
    const read = resources.length ? await rpc(3, 'resources/read', { uri: resources[0].uri }) : null;
    const text = String((read && read.result && read.result.contents && read.result.contents[0] && read.result.contents[0].text) || '');
    ok(text.length > 20, `读到了内容(${text.length} 字)`);
    const leaked = Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([k]) => k);
    ok(leaked.length === 0, `R2 读出来的内容里没有明文密钥(泄漏:${leaked.join(',') || '无'})`);
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* 下一条判 */ }
    const p1 = parsed && Array.isArray(parsed.providers) ? parsed.providers.find(p => p.id === 'p1') : null;
    ok(Boolean(p1) && String(p1.apiKey || '').startsWith('••••') && p1.hasKey === true,
      `R3 仍是合法 JSON,provider 密钥是掩码形并带 hasKey(实 ${p1 ? JSON.stringify(p1.apiKey) : '解析失败'})`);
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
    await new Promise(r => { if (child.exitCode !== null || child.signalCode) r(); else { child.once('exit', r); setTimeout(r, 3000); } });
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 仍被占用 */ }
  }
  console.log(`MCP RESOURCE CONFIG MASK E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exit(fail ? 1 : 0);
})();
