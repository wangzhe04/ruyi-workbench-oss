'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS MCP CAPABILITIES');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mcp-capabilities-'));
process.env.RUYI_HOME = path.join(root, 'parent-data');
let client;
let runtime;
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac MCP capabilities require macOS'); return; }
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime', 'ProcessRuntimeHooks']);
    runtime = S.ProcessRuntime;
    const helper = path.join(root, 'child-helper');
    fs.copyFileSync(S.ProcessRuntimeHooks.helperPath(), helper); fs.chmodSync(helper, 0o700);
    const childData = path.join(root, 'child-data'); fs.mkdirSync(childData);
    fs.writeFileSync(path.join(childData, 'config.json'), JSON.stringify({ configSchema: 14, permissionMode: 'bypass',
      desktopMcp: { enabled: false, autodetect: false }, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
      stewardEnabledV1: false, schedulerEnabledV1: false, mcpServers: [] }));
    const entry = path.join(root, 'mcp-entry.js');
    fs.writeFileSync(entry, `const S=require(${JSON.stringify(path.resolve(__dirname, 'lib/server-internals'))}).loadServerInternals(['startMcp','ProcessRuntimeHooks']);S.ProcessRuntimeHooks.helperPath=()=>${JSON.stringify(helper)};S.startMcp().catch(e=>{console.error(e.message);process.exitCode=1});`);
    client = new S.McpStdioClient({ id: 'capability-fixture', command: process.execPath, args: [entry],
      env: { ...fixtureChildEnv(), RUYI_HOME: childData, WIN_CLAUDE_WORKBENCH_HOME: childData,
        RUYI_MACOS_AUTOMATION_HELPER:path.join(root,'missing-capture-helper') } });
    await client.start();
    let names = client.listTools().map(tool => tool.name);
    if (!names.includes('shell_run') || !names.includes('git_status')) {
      const initial = await client.callTool('workbench_self_status',{section:'capabilities'},5000);
      console.log('Initial runtime diagnostic '+JSON.stringify(initial.capabilities?.runtime || initial));
    }
    t.ok(names.includes('shell_run') && names.includes('git_status'), 'real MCP tools/list offers managed tools with ready helper');
    const windowsOnly = ['powershell_run', 'keyboard_send_keys'];
    t.ok(windowsOnly.every(name => !names.includes(name)), 'MCP tools/list excludes Windows-only implementations on Mac');
    const desktopSearch = await client.callTool('tool_search', { query: 'desktop_screenshot keyboard_send_keys powershell_run', limit: 20 }, 5000);
    t.ok(desktopSearch.ok && !desktopSearch.matches.some(item => windowsOnly.includes(item.name)),
      'adaptive MCP discovery excludes the same Windows-only tools');
    const unsupported = await client.callTool('tool_invoke_exec', { name: 'keyboard_send_keys', arguments: {} }, 5000);
    t.ok(!unsupported.ok && unsupported.code === 'tool-disabled' && unsupported.error.includes('platform.unsupported'),
      'stale MCP proxy invocation cannot reach a Windows-only handler');
    t.ok(!names.includes('desktop_screenshot'), 'MCP listing removes capture when its Mac helper is missing');
    const missingCapture = await client.callTool('tool_invoke_exec',{name:'desktop_screenshot',arguments:{}},5000);
    t.ok(!missingCapture.ok && missingCapture.code==='dependency_missing', 'stale MCP capture reports the actual missing dependency');
    fs.unlinkSync(helper);
    names = (await client.refreshTools(5000)).map(tool => tool.name);
    t.ok(!names.includes('shell_run') && !names.includes('script_run') && !names.includes('git_status'),
      'same MCP process refresh removes managed execution tools immediately after helper removal');
    t.ok(names.includes('shell_poll') && names.includes('shell_kill') && names.includes('file_read'),
      'MCP discovery retains inspection, cleanup and ordinary file tools');
    const searched = await client.callTool('tool_search', { query: 'shell_run', limit: 20 }, 5000);
    t.ok(searched.ok && !searched.matches.some(item => item.name === 'shell_run'), 'adaptive MCP search uses the same unavailable snapshot');
    const marker = path.join(root, 'not-executed');
    const invoked = await client.callTool('tool_invoke_exec', { name: 'shell_run', arguments: { command: 'touch ' + marker } }, 5000);
    t.ok(!invoked.ok && invoked.code === 'process_helper_missing' && !fs.existsSync(marker),
      'stale adaptive invocation reports runtime unavailable without executing or claiming unknown tool');
    fs.copyFileSync(S.ProcessRuntimeHooks.helperPath(), helper); fs.chmodSync(helper, 0o700);
    names = (await client.refreshTools(5000)).map(tool => tool.name);
    t.ok(names.includes('shell_run') && names.includes('git_status'), 'MCP discovery recovers after helper replacement without restarting the client');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (client && client.child) { const child = client.child; client.kill(); const cleanup = await runtime.waitForCleanup(child, 3000); t.ok(cleanup && !cleanup.incomplete, 'owned MCP fixture confirms cleanup before removing files'); }
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
