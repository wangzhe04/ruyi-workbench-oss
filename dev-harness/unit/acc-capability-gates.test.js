'use strict';
// 2026-10 能力总闸补桥接面(07 toolDisabledByPolicy / ACC_POLICY_TOOL_FAMILIES)的纯逻辑与生成物。真 server.js、临时 HOME。
//   [G1] 名单里每个名字都是 ACC 真实注册的工具(读 mcp/ai-computer-control/src/ai_computer_control/tools/*.py 的
//        @mcp.tool 定义);三族互不相交、无重复;55 件。ACC 改名 / 删工具时这里先红,名单不会悄悄失效。
//   [G2] 判据矩阵:命令闸 / 桌面闸 / 会话覆盖三者的每一种组合下,桌面族与原生 desktop_screenshot 的判决逐格相同
//        (「与原生同口径」不是口号);命令族只看 allowCommandTools;转调器任一闸关就关。
//   [G3] 只认内置桌面 MCP:外部服务器的同名工具恒放行;名单外的 ACC 工具恒放行。
//   [G4] accPolicyHiddenToolNames / dropPolicyDisabledBridgedTools:默认配置一个不藏;滤 tools 不动 route。
//   [G5] createToolLoadingState:被关的 ACC 工具不进目录(full 注入、tool_load、tool_search 都看不见),会话覆盖 true 时回来。
//   [G6] generateSessionMcpConfig(full 模式直挂面):ACC 条目按配置 + 会话覆盖带 ACC_HIDE_TOOLS;两个闸都开时不加这个键
//        (生成物与修前逐字节相同);外部条目永远不带。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-acc-gates-unit-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
const { createToolLoadingState, generateSessionMcpConfig, dispatchTestHooks: H } = srv;
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const ACC_ID = 'ai-computer-control';
const F = H.ACC_POLICY_TOOL_FAMILIES;
const accBridge = toolName => ({ serverId: ACC_ID, toolName });

function accRegisteredToolNames() {
  const dir = path.join(repo, 'mcp', 'ai-computer-control', 'src', 'ai_computer_control', 'tools');
  const names = new Set();
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.py'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^@mcp\.tool\b/.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const m = /^(?:async\s+)?def\s+([a-z_0-9]+)\s*\(/.exec(lines[j]);
        if (m) { names.add(m[1]); break; }
      }
    }
  }
  return names;
}

test('[G1] 名单里的每个名字都是 ACC 真实注册的工具;三族互不相交', () => {
  const real = accRegisteredToolNames();
  assert.equal(real.size, 108, `ACC 工具总数变了(got ${real.size}):先核对能力总闸名单要不要跟着增删`);
  const all = [...F.command, ...F.desktop, ...F.dispatcher];
  assert.equal(new Set(all).size, all.length, '名单里有重复名字');
  assert.equal(all.length, 55);
  const missing = all.filter(n => !real.has(n));
  assert.deepEqual(missing, [], `名单里有 ACC 不存在的名字:${missing.join(', ')}`);
  for (const k of ['command', 'desktop', 'dispatcher']) assert.ok(Object.isFrozen(F[k]), `${k} 族应冻结`);
  // 归类边界(注释里写了理由的几个):读图片文件的 OCR、只读进程表、通知弹窗不在名单里
  for (const n of ['ocr_image', 'ocr_available_languages', 'list_processes', 'message_box', 'show_notification', 'get_system_info', 'read_document', 'browser_screenshot'])
    assert.ok(!all.includes(n), `${n} 不该进名单`);
  for (const n of ['ocr_find_text', 'get_clipboard_image', 'set_clipboard_image', 'macro_list', 'record_start']) assert.ok(F.desktop.includes(n), `${n} 应在桌面族`);
});

test('[G2] 判据矩阵:桌面族与原生 desktop_screenshot 逐格同判;命令族只看命令闸;转调器任一闸关就关', () => {
  for (const allowCommandTools of [true, false, undefined]) {
    for (const allowDesktopTools of [true, false, undefined]) {
      for (const override of [null, true, false]) {
        const cfg = { allowCommandTools, allowDesktopTools };
        const nativeDesk = H.nativeToolDisabledByPolicy('desktop_screenshot', cfg, override);
        const nativeCmd = H.nativeToolDisabledByPolicy('script_run', cfg, override);
        for (const n of F.desktop) assert.equal(H.toolDisabledByPolicy(`x__${n}`, cfg, override, accBridge(n)), nativeDesk, `${n} ${JSON.stringify(cfg)} override=${override}`);
        for (const n of F.command) assert.equal(H.toolDisabledByPolicy(`x__${n}`, cfg, override, accBridge(n)), nativeCmd, `${n} ${JSON.stringify(cfg)} override=${override}`);
        for (const n of F.dispatcher) {
          const r = H.toolDisabledByPolicy(`x__${n}`, cfg, override, accBridge(n));
          assert.equal(r !== '', nativeDesk !== '' || nativeCmd !== '', `${n} ${JSON.stringify(cfg)} override=${override}`);
        }
      }
    }
  }
  assert.equal(H.toolDisabledByPolicy('ai_computer_control__screenshot', { allowDesktopTools: true }, false, accBridge('screenshot')), 'desktopTools=false (this session)');
  assert.equal(H.toolDisabledByPolicy('ai_computer_control__screenshot', { allowDesktopTools: false }, true, accBridge('screenshot')), '');
  assert.equal(H.toolDisabledByPolicy('ai_computer_control__run_command', { allowCommandTools: false }, true, accBridge('run_command')), 'allowCommandTools=false');
  // 不带 bridge = 原生判据(与 nativeToolDisabledByPolicy 同一个函数)
  assert.equal(H.toolDisabledByPolicy('script_run', { allowCommandTools: false }), 'allowCommandTools=false');
  assert.equal(H.toolDisabledByPolicy('run_command', { allowCommandTools: false }), '', '没有 bridge 的裸名不是原生工具,放行(由 resolveBridge 先认出桥接目标)');
});

test('[G3] 只认内置桌面 MCP:外部服务器同名工具与名单外的 ACC 工具恒放行', () => {
  const off = { allowCommandTools: false, allowDesktopTools: false };
  for (const n of [...F.command, ...F.desktop, ...F.dispatcher]) {
    assert.equal(H.toolDisabledByPolicy(`ext__${n}`, off, false, { serverId: 'ext-mcp', toolName: n }), '', `外部 ${n}`);
  }
  for (const n of ['read_document', 'ocr_image', 'list_processes', 'write_file', 'excel_read', 'browser_click', 'fetch', 'diagnostics']) {
    assert.equal(H.toolDisabledByPolicy(`ai_computer_control__${n}`, off, false, accBridge(n)), '', n);
  }
});

test('[G4] accPolicyHiddenToolNames / dropPolicyDisabledBridgedTools', () => {
  assert.deepEqual(H.accPolicyHiddenToolNames({}), []);
  assert.deepEqual(H.accPolicyHiddenToolNames({ allowCommandTools: true, allowDesktopTools: true }), []);
  assert.deepEqual(H.accPolicyHiddenToolNames({ allowCommandTools: false }), [...F.command, ...F.dispatcher].sort());
  assert.deepEqual(H.accPolicyHiddenToolNames({ allowDesktopTools: false }), [...F.desktop, ...F.dispatcher].sort());
  assert.deepEqual(H.accPolicyHiddenToolNames({ allowDesktopTools: false }, true), []);
  assert.deepEqual(H.accPolicyHiddenToolNames({ allowDesktopTools: true }, false), [...F.desktop, ...F.dispatcher].sort());
  const mk = n => ({ type: 'function', function: { name: n, description: n, parameters: { type: 'object', properties: {} } } });
  const route = {
    ai_computer_control__run_command: accBridge('run_command'),
    ai_computer_control__read_document: accBridge('read_document'),
    ext_mcp__run_command: { serverId: 'ext-mcp', toolName: 'run_command' },
  };
  const tools = ['file_read', ...Object.keys(route)].map(mk);
  const routeBefore = JSON.stringify(route);
  const kept = H.dropPolicyDisabledBridgedTools(tools, route, { allowCommandTools: false }).map(t => t.function.name);
  assert.deepEqual(kept, ['file_read', 'ai_computer_control__read_document', 'ext_mcp__run_command']);
  assert.equal(JSON.stringify(route), routeBefore, 'route 不动(分发面靠它回 tool-disabled)');
  assert.equal(tools.length, 4, '入参数组不被就地改');
});

test('[G5] createToolLoadingState:被关的 ACC 工具不进目录;会话覆盖 true 时回来', () => {
  const mk = n => ({ type: 'function', function: { name: n, description: n, parameters: { type: 'object', properties: {} } } });
  const accNames = ['mouse_click', 'screenshot', 'run_command', 'read_document'];
  const route = Object.fromEntries(accNames.map(n => [`ai_computer_control__${n}`, accBridge(n)]));
  const tools = Object.keys(route).map(mk);
  const cfg = { toolLoadingMode: 'full', allowDesktopTools: false, allowCommandTools: true };
  const names = s => s.current().map(t => t.function.name);
  const off = createToolLoadingState(cfg, '看一眼屏幕', [], tools, route, undefined);
  assert.deepEqual(names(off).sort(), ['ai_computer_control__read_document', 'ai_computer_control__run_command']);
  const pulled = off.load({ tools: ['ai_computer_control__mouse_click'] });
  assert.deepEqual(pulled.loaded, []);
  assert.deepEqual(pulled.unknown, ['ai_computer_control__mouse_click']);
  assert.ok(!JSON.stringify(off.search('screenshot mouse click', 10)).includes('"ai_computer_control__screenshot"'));
  const on = createToolLoadingState(cfg, '看一眼屏幕', [], tools, route, undefined, { desktopOverride: true });
  assert.equal(on.fullCount, 4);
});

test('[G6] generateSessionMcpConfig:直挂 ACC 条目的 ACC_HIDE_TOOLS 跟配置与会话覆盖走;两个闸都开时不加键', async () => {
  fs.mkdirSync(process.env.RUYI_HOME, { recursive: true });
  const fake = path.join(repo, 'dev-harness', 'fake-mcp.js');
  const base = {
    configSchema: 7, version: '1.0.0', toolLoadingMode: 'full', includeWorkbenchMcp: true, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
    desktopMcp: { enabled: true, command: process.execPath, args: [fake], cwd: '', autodetect: false },
    externalMcpServers: [{ id: 'ext-mcp', label: 'Ext', command: process.execPath, args: [fake], enabled: true }],
  };
  const gen = async (extra, opts) => {
    fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify({ ...base, ...extra }, null, 2));
    const file = await generateSessionMcpConfig('sess_acc_gates', 'auto', [], opts);
    return JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
  };
  const open = await gen({ allowCommandTools: true, allowDesktopTools: true });
  assert.ok(open[ACC_ID] && open['ext-mcp'], '两个桥接条目都直挂');
  assert.ok(!('ACC_HIDE_TOOLS' in open[ACC_ID].env), '两个闸都开:不加 ACC_HIDE_TOOLS');
  const cmdOff = await gen({ allowCommandTools: false, allowDesktopTools: true });
  assert.equal(cmdOff[ACC_ID].env.ACC_HIDE_TOOLS, [...F.command, ...F.dispatcher].sort().join(','));
  assert.ok(!('ACC_HIDE_TOOLS' in cmdOff['ext-mcp'].env), '外部条目不带');
  const sessOff = await gen({ allowCommandTools: true, allowDesktopTools: true }, { desktopOverride: false });
  assert.equal(sessOff[ACC_ID].env.ACC_HIDE_TOOLS, [...F.desktop, ...F.dispatcher].sort().join(','), '会话 desktopTools:false 带上桌面族');
  const sessOn = await gen({ allowCommandTools: true, allowDesktopTools: false }, { desktopOverride: true });
  assert.ok(!('ACC_HIDE_TOOLS' in sessOn[ACC_ID].env), '会话 desktopTools:true 盖过全局关');
});
