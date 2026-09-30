'use strict';
// 审计 A3:桥接工具目录不缓存「残缺」的扫描结果。
// 病根:ACC(python + 一堆模块导入)冷启动可能赶不上 collectBridgedTools 给每个 entry 的启动竞速(3.5 s);修前把「缺了它」的
// 目录照常缓存 60 s —— 服务其实一秒后就起来了,首几个回合模型却看不到任何桌面工具、tool_search 也搜不到。
// 现在:有 entry 没在预算内起来 → 这一次的目录不进缓存,下一次调用重扫并拿到它(慢的那个 start 仍在后台跑,
// getMcpClient 的待决互斥保证不重复起进程)。竞速预算用 WCW_BRIDGED_ENTRY_START_TIMEOUT_MS 缩到 250 ms 做测试缝。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-catalog-incomplete-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.WCW_BRIDGED_ENTRY_START_TIMEOUT_MS = '250';
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const SLOW = path.join(root, 'slow-mcp.js');
fs.writeFileSync(SLOW, `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
function handle(m) {
  if (m.method === 'initialize') return setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'slow' }, capabilities: {} } }), 900);
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'late_tool' }] } });
}
`);

test('冷启动慢的桥接服务器:第一次目录残缺不缓存,服务起来后下一次调用就拿到它的工具', async () => {
  const config = { bridgeExternalToolsToProvider: true, desktopMcp: { enabled: false, autodetect: false }, enableMcpDropIn: false, toolbox: { autoDiscover: false },
    externalMcpServers: [{ id: 'slowacc', label: 'slow', command: process.execPath, args: [SLOW], enabled: true }] };
  const first = await srv.collectBridgedTools(config);
  assert.equal(first.tools.length, 0, '第一次:赶不上启动竞速,目录里还没有它');
  await new Promise(r => setTimeout(r, 1400));   // 慢的 initialize(900ms)在后台完成
  const second = await srv.collectBridgedTools(config);
  assert.deepEqual(second.tools.map(t => t.function.name), ['slowacc__late_tool'], '修前:第一次的空目录被缓存 60 s,这里仍是空');
  // 完整的目录照常缓存(同一对象)
  assert.equal(await srv.collectBridgedTools(config), second);
});
