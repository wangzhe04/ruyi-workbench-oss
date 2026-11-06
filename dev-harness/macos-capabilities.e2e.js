'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS CAPABILITIES');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-capabilities-'));
process.env.RUYI_HOME = path.join(root, 'data');
fs.mkdirSync(process.env.RUYI_HOME);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac capability integration requires macOS'); return; }
    const S = loadServerInternals(['ProcessRuntime', 'ProcessRuntimeHooks', 'getCapabilities', 'toolRequirementsMet',
      'buildOpenAiTools', 'buildProviderSystemPrompt', 'defaultConfig', 'computeHealth', 'doctorHealthSeverity', 'toolCall'], { withEval: true });
    const realHelper = S.ProcessRuntimeHooks.helperPath();
    const helper = path.join(root, 'helper');
    fs.copyFileSync(realHelper, helper); fs.chmodSync(helper, 0o700);
    S.ProcessRuntimeHooks.helperPath = () => helper;
    const config = { ...S.defaultConfig(), permissionMode: 'bypass' };
    // Keep unrelated network/desktop capabilities warm; helper readiness must refresh independently.
    S.__eval('_capCache = { at: Date.now(), value: { network: {online:true}, binaries:{git:true}, gitCli:true, desktopMcp:{present:false}, engine:"openai" } };');
    const ready = await S.getCapabilities(config);
    t.ok(ready.runtime.capabilities['process.supervisor'].ready && ready.runtime.capabilities['shell.exec'].ready,
      'capability matrix carries the real versioned native supervisor and default shell snapshot');
    t.ok(S.toolRequirementsMet('shell_run', ready, false, config).met && S.toolRequirementsMet('git_status', ready, false, config).met,
      'ready supervisor permits shell and git discovery');
    const readyTools = S.buildOpenAiTools(config, ready);
    const readyNames = readyTools.map(tool => tool.function.name);
    for (const tool of readyTools.filter(tool => ['shell_run', 'shell_start', 'script_run'].includes(tool.function.name))) {
      t.ok(!tool.function.parameters.properties.language.enum.includes('powershell'), tool.function.name + ' schema advertises only implemented Mac languages');
    }
    for (const name of ['powershell_run', 'desktop_screenshot', 'keyboard_send_keys']) {
      t.ok(!readyNames.includes(name), name + ' is not offered on Mac even with command and desktop settings enabled');
      const rejected = await S.toolCall(name, {}, { config });
      t.ok(!rejected.ok && rejected.code === 'tool-disabled' && rejected.error.includes('platform.unsupported'),
        name + ' stale direct invocation is rejected before reaching its Windows handler');
    }
    t.ok(!S.toolRequirementsMet('shell_run', {}, false, config).met, 'unknown Mac supervisor state cannot advertise execution readiness');
    fs.unlinkSync(helper);
    const missing = await S.getCapabilities(config);
    t.ok(!missing.runtime.capabilities['process.supervisor'].ready && missing.network.online,
      'removing helper invalidates runtime readiness despite a warm 60-second capability matrix');
    const names = S.buildOpenAiTools(config, missing).map(tool => tool.function.name);
    t.ok(!names.includes('shell_run') && !names.includes('script_run') && !names.includes('shell_start') && !names.includes('git_status'),
      'normal tool discovery filters managed startup tools while helper is unavailable');
    t.ok(names.includes('shell_kill') && names.includes('shell_poll'), 'existing-session cleanup and inspection remain discoverable');
    const prompt = S.buildProviderSystemPrompt({ id: 'fixture', model: 'fixture' }, 'fixture', root, [], missing, config);
    t.ok(String(prompt).includes('Mac 进程监督器尚未就绪'), 'system prompt explains the same runtime requirement');
    const status = await S.toolCall('workbench_self_status', { section: 'capabilities' }, { config, provider: { id: 'fixture', model: 'fixture' } });
    t.ok(status.ok && !status.capabilities.runtime.capabilities['shell.session'].ready
      && status.capabilities.matrix.find(row => row.modality === 'background').available === false,
      'self-status tool exposes unavailable shell capability and disables its background claim');
    const health = await S.computeHealth(config, { desktopPending: true });
    t.ok(health.health.some(item => item.id === 'process-supervisor' && item.ok === false), 'normal health assembly includes failed supervisor check');
    t.ok(S.doctorHealthSeverity({ id: 'process-supervisor', ok: false }) === 'error', 'CLI doctor and health UI agree on unavailable supervisor severity');
    const ui = await import(pathToFileURL(path.resolve(__dirname, '../ruyi-workbench/app/public/js/health-i18n.js')).href);
    for (const locale of ['zh-CN', 'en-US']) {
      const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../ruyi-workbench/app/public/locales/' + locale + '.json'), 'utf8'));
      const display = ui.describeHealthItem({ id: 'process-supervisor', ok: false }, key => catalog[key] || key);
      t.ok(display.severity === 'error' && display.label === catalog['health.item.process-supervisor.label']
        && display.hint === catalog['health.item.process-supervisor.hint.bad'], 'health UI uses localized supervisor state in ' + locale);
    }
    const count = path.join(root, 'probe-count');
    const report = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
    const slow = '#!' + process.execPath + '\n' + `require('fs').appendFileSync(${JSON.stringify(count)},'x');setTimeout(()=>console.log(${JSON.stringify(JSON.stringify(report))}),150);`;
    fs.writeFileSync(helper, slow, { mode: 0o700 });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const snapshots = await Promise.all(Array.from({ length: 6 }, () => S.ProcessRuntime.capabilitySnapshot()));
    clearInterval(timer);
    t.ok(snapshots.every(snapshot => snapshot.capabilities['process.supervisor'].ready) && ticks > 2,
      'cold asynchronous capability probes keep the event loop responsive');
    t.ok(fs.readFileSync(count, 'utf8') === 'x', 'concurrent capability consumers share one helper probe');
    fs.writeFileSync(helper, slow + '\n// refreshed fixture');
    const pending = S.ProcessRuntime.helperCapabilityAsync();
    await sleep(30);
    fs.writeFileSync(helper, '#!' + process.execPath + '\nconsole.log("{}");');
    const changed = await pending;
    t.ok(!changed.ready && changed.reasonCode === 'platform.dependency_changed', 'helper replacement during asynchronous probe cannot publish stale readiness');
    fs.copyFileSync(realHelper, helper); fs.chmodSync(helper, 0o700);
    const restored = await S.getCapabilities(config);
    t.ok(restored.runtime.capabilities['process.supervisor'].ready && S.toolRequirementsMet('shell_run', restored, false, config).met,
      'restoring helper re-enables discovery without restarting or expiring network cache');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); t.done(); }
})();
