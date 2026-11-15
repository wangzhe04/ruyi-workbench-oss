'use strict';
require('./lib/self-isolate-home.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { pathToFileURL } = require('node:url');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { buildMacDesktop } = require('../ruyi-workbench/tools/build-macos-desktop');
const t = createRunner('MACOS DESKTOP BRIDGE');
const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-native-bridge-'));
const wb = path.resolve(__dirname, '../ruyi-workbench');
let child;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const moduleURL = name => pathToFileURL(path.join(wb, 'app/public/js', name)).href;
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await sleep(80); } while (Date.now() < end);
  throw new Error('Native bridge condition timed out');
}

(async () => {
  const oldPlatform = Object.getOwnPropertyDescriptor(globalThis, '__ruyiDesktopPlatform');
  const oldWebkit = Object.getOwnPropertyDescriptor(globalThis, 'webkit');
  try {
    const bridge = await import(moduleURL('host-bridge.js'));
    const calls = [];
    const original = async (...args) => { calls.push(args); return { ok: true, browser: true }; };
    original.conditional = () => 'conditional';
    const api = bridge.withHostPickers(original, key => 'translated ' + key);
    ok((await api('/api/pick-folder', { method: 'POST', body: '{}' })).browser && calls.length === 1,
      'ordinary browser picker keeps existing HTTP transport');
    ok(api.conditional === original.conditional, 'native API adapter preserves conditional GET entry');
    const messages = [];
    let dispatch = async body => { messages.push(body); return { ok: true, path: '/tmp/中文 & path' }; };
    Object.defineProperty(globalThis, '__ruyiDesktopPlatform', { value: 'darwin', configurable: true });
    Object.defineProperty(globalThis, 'webkit', { value: { messageHandlers: { ruyiHost: { postMessage: body => dispatch(body) } } }, configurable: true });
    const picked = await api('/api/pick-folder', { method: 'post', body: JSON.stringify({ title: '工作区', initialDir: '/tmp' }) });
    ok(picked.path === '/tmp/中文 & path' && messages[0].method === 'pickFolder' && messages[0].params.title === '工作区',
      'normal picker API maps to structured native request with literal Unicode values');
    ok(messages[0].version === 1 && /^[\da-f-]{36}$/i.test(messages[0].id), 'native messages carry version and unique request identity');
    const net = await import(moduleURL('net.js'));
    bridge.installHostPickers(net.api);
    const direct = await net.api('/api/pick-file', { method: 'POST', body: '{}' });
    ok(direct.path === '/tmp/中文 & path', 'domain modules importing net.api directly use the registered native picker');
    delete net.api.hostAdapter;
    await api('/api/status');
    ok(calls.length === 2, 'all other workbench API calls keep their HTTP entry');
    dispatch = async () => ({ ok: false, error: { code: 'host.picker_busy', message: 'host.picker_busy' } });
    const busy = await api('/api/pick-file', { method: 'POST', body: '{}' });
    ok(busy.error.code === 'host.picker_busy' && busy.error.message === 'translated host.picker_busy'
      && busy.hint === 'translated host.picker_hint', 'native picker failures retain stable codes and localized recovery text');
    const originalTimeout = globalThis.setTimeout;
    let timedOut = false;
    try {
      globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
      dispatch = body => body.method === 'cancelPicker' ? Promise.resolve({ ok: true }) : new Promise(() => {});
      try { await api('/api/pick-file', { method: 'POST', body: '{}' }); }
      catch (error) {
        const result = JSON.parse(error.message);
        timedOut = result.error.code === 'host.timeout' && result.error.message === 'translated host.timeout';
      }
    } finally { globalThis.setTimeout = originalTimeout; }
    ok(timedOut, 'native picker timeout has a stable error code and localized recovery message');
    const controller = new AbortController(); controller.abort();
    let aborted = false;
    try { await bridge.hostRequest('pickFolder', {}, { signal: controller.signal }); } catch (error) { aborted = error.name === 'AbortError'; }
    ok(aborted, 'already-aborted native picker never starts a request');
    let oldStatus;
    dispatch = body => body.method === 'notificationStatus'
      ? new Promise(resolve => { oldStatus = resolve; }) : Promise.resolve({ ok: true, permission: 'granted' });
    const refresh = bridge.refreshHostPermissions();
    await bridge.requestHostNotifications();
    oldStatus({ ok: true, permission: 'default' });
    await refresh;
    ok(bridge.macNotificationPermission() === 'granted', 'old permission refresh cannot overwrite a newer authorization result');
    let finishRequest;
    let requests = 0;
    dispatch = () => { requests += 1; return new Promise(resolve => { finishRequest = resolve; }); };
    const request = bridge.requestHostNotifications();
    const focused = bridge.refreshHostPermissions();
    finishRequest({ ok: true, permission: 'denied' });
    await Promise.all([request, focused]);
    ok(requests === 1 && bridge.macNotificationPermission() === 'denied', 'focus during permission prompt shares the pending authorization and preserves refusal');

    const policy = await import(moduleURL('notify-policy.js'));
    const toggle = { checked: false };
    const storage = new Map();
    policy.bindNotifySettings({ documentRef: { getElementById: id => id === 'cfgNotifyEnabled' ? toggle : null },
      storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
    let statusResult;
    dispatch = () => new Promise(resolve => { statusResult = resolve; });
    toggle.checked = true;
    const enabling = toggle.onchange({ target: toggle });
    toggle.checked = false;
    await toggle.onchange({ target: toggle });
    statusResult({ ok: true, permission: 'granted' });
    await enabling;
    ok(JSON.parse(storage.get(policy.NOTIFY_POLICY_STORAGE_KEY)).enabled === false, 'late authorization result cannot override the latest user choice to disable reminders');
  } finally {
    if (oldPlatform) Object.defineProperty(globalThis, '__ruyiDesktopPlatform', oldPlatform); else delete globalThis.__ruyiDesktopPlatform;
    if (oldWebkit) Object.defineProperty(globalThis, 'webkit', oldWebkit); else delete globalThis.webkit;
  }

  try {
    const server = require('../ruyi-workbench/app/server');
    const application = '/Applications/Visual Studio Code.app';
    const editor = { command: '/usr/bin/open', application, kind: 'mac-vscode', label: 'Visual Studio Code', source: 'fixture' };
    const file = '/tmp/中文 空格 & $(literal).py';
    const open = server.buildCodeEditorSpawn(editor, 'open', '', file);
    ok(JSON.stringify(open.args) === JSON.stringify(['-a', application, '--', file]), 'Mac editor opens a literal file through an explicit LaunchServices application');
    const diff = server.buildCodeEditorSpawn(editor, 'diff', '/tmp/before.py', file);
    ok(JSON.stringify(diff.args) === JSON.stringify(['-n', '-a', application, '--args', '--reuse-window', '--diff', '/tmp/before.py', file]),
      'Mac VSCode-family diff retains both literal paths and fixed launch arguments');
    const fallback = server.buildCodeEditorSpawn({ ...editor, kind: 'mac-app', application: '/System/Applications/TextEdit.app' }, 'diff', '/tmp/before.py', file);
    ok(fallback.diffUnsupported && fallback.fileOpenPrefix[1] === '/System/Applications/TextEdit.app', 'safe TextEdit fallback retains explicit application handoff');
    if (process.platform !== 'darwin') { console.log('SKIP native WKWebView checks require macOS'); return; }
    const bundle = process.env.RUYI_DESKTOP_TEST_APP || buildMacDesktop(path.join(root, '如意 系统桥.app'));
    const fixture = fixtureChildEnv({ perTest: true });
    const data = path.join(fixture.home, 'data');
    const workspace = path.join(fixture.home, '工作 区');
    const cancelTarget = path.join(fixture.home, 'P4 取消目标');
    const cancelChild = 'P4 取消目录指纹.txt';
    fs.mkdirSync(data); fs.mkdirSync(workspace); fs.mkdirSync(cancelTarget);
    fs.writeFileSync(path.join(cancelTarget, cancelChild), 'P4 cancellation fixture\n');
    const alias = path.join(fixture.home, 'workspace-alias');
    const literalFolder = path.join(fixture.home, 'literal\\folder\\');
    const spacedFolder = path.join(fixture.home, 'trailing space ');
    fs.symlinkSync(workspace, alias);
    fs.mkdirSync(literalFolder);
    fs.mkdirSync(literalFolder.slice(0, -1));
    fs.mkdirSync(spacedFolder);
    const fsp = require('node:fs/promises');
    const originalStat = fsp.stat;
    const offline = path.join(fixture.home, 'offline-favorite');
    try {
      fsp.stat = (target, ...args) => target === offline ? new Promise(() => {}) : originalStat(target, ...args);
      const started = Date.now();
      const bounded = await server.resolveWorkspace({ selectedPath: workspace }, { workspaces: [
        { path: offline }, { path: workspace, read: false, write: false, execute: false },
      ] });
      // 墙钟上界豁免：验证失联收藏的一秒固定 I/O 超时，期限本身就是被测契约。
      ok(bounded.ok && bounded.favorite.write === false && Date.now() - started < 2500,
        'an unresponsive favorite cannot block resolving a local directory or promote its permissions');
    } finally { fsp.stat = originalStat; }
    try {
      const selected = fs.realpathSync(workspace);
      const different = literalFolder.slice(0, -1);
      fsp.stat = async (target, options) => {
        if (target !== selected && target !== different) return originalStat(target, options);
        const ino = target === selected ? 9007199254740992n : 9007199254740993n;
        return { dev: options?.bigint ? 1n : 1, ino: options?.bigint ? ino : Number(ino), isDirectory: () => true };
      };
      const exact = await server.resolveWorkspace({ selectedPath: workspace }, { workspaces: [{ path: different }] });
      ok(exact.ok && !exact.favorite && exact.path === selected,
        '64-bit directory identities cannot collide through floating-point inode rounding');
    } finally { fsp.stat = originalStat; }
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      configSchema: server.CONFIG_SCHEMA, defaultWorkspace: workspace,
      workspaces: [{ path: workspace }, { path: cancelTarget }], providers: [], stewardEnabledV1: false, schedulerEnabledV1: false,
      autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, enableMcpDropIn: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
    }));
    const script = path.join(root, 'native-checks.js');
    fs.writeFileSync(script, `
const { hostRequest, withHostPickers, isMacHost, requestHostNotifications } = await import('/js/host-bridge.js');
const results = [];
const check = (value, label) => results.push({ok: !!value, label});
const net = await import('/js/net.js');
const { state } = await import('/js/state.js');
const { createWorkspacePreferencesDomain } = await import('/js/workspace-preferences.js');
const canonical = await net.api('/api/workspace/resolve', {method:'POST',body:JSON.stringify({selectedPath:${JSON.stringify(fs.realpathSync(workspace))}})});
const aliased = await net.api('/api/workspace/resolve', {method:'POST',body:JSON.stringify({selectedPath:${JSON.stringify(alias)}})});
check(canonical.ok && canonical.path === ${JSON.stringify(workspace)} && aliased.path === canonical.path,
  'Mac path resolver reuses the existing favorite for POSIX and symlink aliases');
const beforeConfig = structuredClone(state.config), beforeSession = state.currentSession;
let saved;
const duplicateConfig = await net.api('/api/config', {method:'POST',body:JSON.stringify({workspaces:[
  {path:${JSON.stringify(workspace)},read:false,write:false,execute:false},
  {path:${JSON.stringify(alias)}},{path:${JSON.stringify(fs.realpathSync(workspace))}}
]})});
state.config=duplicateConfig.config;
const domain = createWorkspacePreferencesDomain({patchSession:async(id,patch)=>{
  await net.api('/api/sessions/'+encodeURIComponent(id),{method:'POST',headers:{'x-http-method':'PATCH'},body:JSON.stringify(patch)});
  Object.assign(state.currentSession,patch);
},saveConfigPartial:async patch=>{
  saved=patch;const result=await net.api('/api/config',{method:'POST',body:JSON.stringify(patch)});state.config=result.config;return true;
}});
state.currentSession = null;
await domain.setWorkspace(${JSON.stringify(alias)});
check(saved.workspaces.length===1 && saved.workspaces[0].path===${JSON.stringify(workspace)},
  'normal workspace switch removes stored alias duplicates and keeps the preferred spelling');
check(saved.workspaces[0].read===false && saved.workspaces[0].write===false && saved.workspaces[0].execute===false,
  'alias deduplication preserves existing favorite permissions');
state.config={...state.config,workspaces:[{path:${JSON.stringify(alias)}}]};
await domain.setWorkspace(${JSON.stringify(alias)});
check(saved.workspaces.length===1 && saved.workspaces[0].path===${JSON.stringify(workspace)} && saved.workspaces[0].write===false,
  'stale client favorites inherit the authoritative server permissions');
await domain.setWorkspace(${JSON.stringify(literalFolder.slice(0, -1))});
await domain.setWorkspace(${JSON.stringify(literalFolder)});
check(state.config.defaultWorkspace===${JSON.stringify(fs.realpathSync(literalFolder))}
  && state.config.workspaces.some(row=>row.path===${JSON.stringify(fs.realpathSync(literalFolder))})
  && state.config.workspaces.some(row=>row.path===${JSON.stringify(fs.realpathSync(literalFolder.slice(0, -1)))}),
  'Mac workspace persistence distinguishes literal trailing backslashes from their sibling directory');
check(document.querySelector('#workspacePicker .wp-name').textContent===${JSON.stringify(path.basename(literalFolder))},
  'Mac workspace label displays literal backslashes as filename characters');
await domain.setWorkspace(${JSON.stringify(spacedFolder)});
check(state.config.defaultWorkspace===${JSON.stringify(fs.realpathSync(spacedFolder))},
  'native Mac directory selection and config persistence preserve trailing whitespace');
const threaded=await net.api('/api/sessions',{method:'POST',body:JSON.stringify({title:'P4目录字符',cwd:${JSON.stringify(workspace)}})});
state.currentSession=threaded.session;
await domain.setWorkspace(${JSON.stringify(spacedFolder)});
const reloaded=await net.api('/api/sessions/'+encodeURIComponent(threaded.session.id));
check(reloaded.session.cwd===${JSON.stringify(fs.realpathSync(spacedFolder))},
  'existing-session workspace switch persists the exact Mac directory including trailing whitespace');
state.currentSession=null;
const nativeFetch = globalThis.fetch;
try {
  // Client comparison policy is independent of this fixture volume's case sensitivity.
  globalThis.fetch = async (url,options)=> url==='/api/workspace/resolve'
    ? new Response(JSON.stringify({ok:true,path:JSON.parse(options.body).selectedPath}),{headers:{'content-type':'application/json'}})
    : nativeFetch(url,options);
  state.config={...beforeConfig,workspaces:[{path:'/fixture/Case'},{path:'/fixture/case'}]};
  await domain.setWorkspace('/fixture/case');
  check(saved.workspaces.length===2 && saved.workspaces[0].path==='/fixture/case',
    'Mac favorite keys preserve distinct case-sensitive paths');
  const pendingResolvers = new Map();
  globalThis.fetch = async (url,options) => url==='/api/workspace/resolve'
    ? new Promise(resolve=>pendingResolvers.set(JSON.parse(options.body).selectedPath,
        ()=>resolve(new Response(JSON.stringify({ok:true,path:JSON.parse(options.body).selectedPath}),{headers:{'content-type':'application/json'}}))))
    : nativeFetch(url,options);
  let patches=[];let commits=[];
  const racingDomain=createWorkspacePreferencesDomain({patchSession:async(id,patch)=>patches.push({id,...patch}),
    saveConfigPartial:async patch=>{commits.push(patch);return true;}});
  state.currentSession={id:'first'};
  const outdated=racingDomain.setWorkspace('/fixture/outdated');
  state.currentSession={id:'second'};
  pendingResolvers.get('/fixture/outdated')();await outdated;
  check(patches.length===0 && commits.length===0,'directory resolution cannot apply an old selection to a different session');
  const older=racingDomain.setWorkspace('/fixture/older');
  const newer=racingDomain.setWorkspace('/fixture/newer');
  pendingResolvers.get('/fixture/newer')();await newer;
  pendingResolvers.get('/fixture/older')();await older;
  check(patches.length===1 && patches[0].cwd==='/fixture/newer' && commits.length===1,
    'late directory resolution cannot replace the latest workspace selection');
  let releasePatch;let patchStarted;
  const started=new Promise(resolve=>{patchStarted=resolve;});
  const held=new Promise(resolve=>{releasePatch=resolve;});
  patches=[];commits=[];
  const serialDomain=createWorkspacePreferencesDomain({patchSession:async(id,patch)=>{
    patches.push({id,...patch});if(patch.cwd==='/fixture/held'){patchStarted();await held;}
  },saveConfigPartial:async patch=>{commits.push(patch);return true;}});
  const first=serialDomain.setWorkspace('/fixture/held');pendingResolvers.get('/fixture/held')();await started;
  const last=serialDomain.setWorkspace('/fixture/latest');pendingResolvers.get('/fixture/latest')();
  await new Promise(resolve=>setTimeout(resolve,30));
  check(patches.length===1,'workspace writes serialize while an earlier session patch is in flight');
  releasePatch();await Promise.all([first,last]);
  check(patches.length===2 && patches[1].cwd==='/fixture/latest' && commits.length===1 && commits[0].recentWorkspaces[0]==='/fixture/latest',
    'late session patch completion cannot overwrite newer workspace preferences');
} finally {
  globalThis.fetch=nativeFetch;
  await net.api('/api/config',{method:'POST',body:JSON.stringify({workspaces:beforeConfig.workspaces,
    defaultWorkspace:beforeConfig.defaultWorkspace,recentWorkspaces:beforeConfig.recentWorkspaces})});
  state.config=beforeConfig;state.currentSession=beforeSession;
}
// The trusted Finder entry path has separate physical evidence. This untrusted
// fixture exercises the bound drop listener and the normal confirmation Cancel.
const { t: translate } = await import('/js/i18n.js');
const cancellation = { synthetic: true, entryReads: 0, resolutions: [], writes: [], sends: 0 };
state.currentSession = (await net.api('/api/sessions/' + threaded.session.id)).session;
async function cancellationSnapshot() {
  const [sessionResult, configResult] = await Promise.all([
    net.api('/api/sessions/' + threaded.session.id), net.api('/api/status'),
  ]);
  return { session: sessionResult.session, config: configResult.config,
    currentSession: structuredClone(state.currentSession), currentConfig: structuredClone(state.config) };
}
cancellation.before = await cancellationSnapshot();
check(cancellation.before.session.id === threaded.session.id
  && cancellation.before.session.cwd === ${JSON.stringify(fs.realpathSync(spacedFolder))}
  && cancellation.before.config.defaultWorkspace !== ${JSON.stringify(cancelTarget)}
  && !cancellation.before.config.recentWorkspaces.includes(${JSON.stringify(cancelTarget)}),
  'synthetic cancellation starts with an explicit current session and different cwd, default and recent workspaces');
try {
  globalThis.fetch = async (input, options) => {
    const url = String(typeof input === 'string' ? input : input?.url || '');
    const method = String(options?.method || 'GET').toUpperCase();
    if (/^\\/api\\/(chat\\/stream|steer|steward\\/(message|act))/.test(url)) cancellation.sends++;
    if (method !== 'GET' && /^\\/api\\/(config|sessions(?:\\/|$))/.test(url)) {
      cancellation.writes.push({ url, method });
    }
    const response = await nativeFetch(input, options);
    if (url === '/api/workspace/resolve') {
      cancellation.resolutions.push({ body: JSON.parse(options.body), status: response.status,
        result: await response.clone().json() });
    }
    return response;
  };
  const entry = { name: ${JSON.stringify(path.basename(cancelTarget))}, isDirectory: true, isFile: false,
    createReader: () => {
      let first = true;
      return { readEntries: success => {
        cancellation.entryReads++;
        const entries = first ? [{ name: ${JSON.stringify(cancelChild)} }] : [];
        first = false;
        success(entries);
      } };
    } };
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [],
    items: [{ kind: 'file', webkitGetAsEntry: () => entry }] } });
  cancellation.isTrusted = drop.isTrusted;
  document.body.dispatchEvent(drop);
  cancellation.defaultPrevented = drop.defaultPrevented;
  let modal;
  for (let attempt = 0; attempt < 100 && !modal; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    modal = document.querySelector('.ws-confirm')?.closest('.modal-backdrop');
  }
  const cancelButton = [...(modal?.querySelectorAll('.modal-foot button') || [])]
    .find(button => button.textContent === translate('common.cancel'));
  check(!drop.isTrusted && drop.defaultPrevented && cancellation.entryReads === 2 && cancellation.resolutions.length === 1
    && cancellation.resolutions[0].status === 200
    && cancellation.resolutions[0].body.children[0] === ${JSON.stringify(cancelChild)}
    && cancellation.resolutions[0].result.matches?.[0]?.path === ${JSON.stringify(cancelTarget)},
    'synthetic directory drop reads its fingerprint and uses the real resolver for the fixture target');
  check(!!cancelButton && modal.querySelector('.modal-head').textContent.includes(translate('workspace.switchTitle'))
    && modal.querySelector('.ws-confirm-path').textContent === ${JSON.stringify(cancelTarget)}
    && modal.querySelector('input[type=checkbox]').checked === false,
    'normal directory drop shows its target and unchecked default option in the actual confirmation modal');
  if (!cancelButton) throw new Error('Directory cancellation fixture did not open its confirmation');
  cancelButton.click();
  await new Promise(resolve => setTimeout(resolve, 80));
  cancellation.after = await cancellationSnapshot();
  check(!modal.isConnected && JSON.stringify(cancellation.before) === JSON.stringify(cancellation.after),
    'directory Cancel preserves the exact selected session, complete server config and frontend workspace state');
  check(cancellation.resolutions.length === 1 && cancellation.writes.length === 0 && cancellation.sends === 0,
    'directory Cancel issues no selectedPath resolution, session/config mutation or automatic send');
} finally {
  globalThis.fetch = nativeFetch;
  state.currentSession = beforeSession;
}
check(isMacHost(), 'trusted complete workbench receives native host marker');
const send = message => window.webkit.messageHandlers.ruyiHost.postMessage(message);
const envelope = (method, params = {}) => ({ version: 1, id: crypto.randomUUID(), method, params });
const status = await hostRequest('notificationStatus');
check(status.ok && ['default','granted','denied','unsupported'].includes(status.permission), 'notification state comes from the real OS');
if (status.permission === 'denied') {
  check(await requestHostNotifications() === 'denied', 'actual denied OS authorization completes without a stale default state');
  check(document.querySelector('#notifyStatus').textContent.includes('macOS'), 'real denied permission updates workbench recovery guidance for macOS');
}
for (const message of [true, {...envelope('notificationStatus'), version:true}, {...envelope('notificationStatus'), extra:1}, {...envelope('notificationStatus'), params:[]}]) {
  const result = await send(message); check(result?.error?.code === 'host.invalid_message', 'native rejects malformed message schema');
}
check((await hostRequest('exec', {command:'never-run'})).error?.code === 'host.method_unsupported', 'native bridge has no generic execution method');
check((await hostRequest('pickFolder', {initialDir:'/tmp', extra:'invalid'})).error?.code === 'host.invalid_params', 'native picker rejects unexpected parameter keys');
check((await hostRequest('pickFile', {filter:123})).error?.code === 'host.invalid_params', 'native picker rejects non-string filter parameters');
check((await hostRequest('notify', {id:'fixture',title:'x'.repeat(513),body:''})).error?.code === 'host.invalid_params', 'native notification rejects oversized payload fields');
if (status.permission !== 'granted') check((await hostRequest('notify', {id:'p4-refused',title:'fixture',body:'fixture'})).error?.code === 'host.notification_permission_required', 'ungranted OS permission refuses notification delivery');
const frame = document.createElement('iframe'); frame.src = 'about:blank';
await new Promise(resolve => { frame.onload = resolve; document.body.appendChild(frame); });
let refused = false; try { await frame.contentWindow.webkit.messageHandlers.ruyiHost.postMessage(envelope('notificationStatus')); } catch(error) { refused = String(error).includes('host.origin_denied'); }
check(refused && frame.contentWindow.__ruyiDesktopPlatform === undefined, 'same-origin child frame cannot acquire the main-frame native bridge'); frame.remove();
const localOrigin = location.origin; location.assign('http://127.0.0.1:1/untrusted-navigation');
await new Promise(resolve => setTimeout(resolve, 80));
check(location.origin === localOrigin, 'script-initiated remote navigation cannot replace trusted workbench');
const nativeApi = withHostPickers((...args) => import('/js/net.js').then(net => net.api(...args)));
const pickerMessage = envelope('pickFolder', {title:'P4 原生选择器取消验收',initialDir:${JSON.stringify(workspace)}});
const picker = send(pickerMessage);
await new Promise(resolve => setTimeout(resolve, 120));
const busy = await hostRequest('pickFile');
check(busy.error?.code === 'host.picker_busy', 'concurrent native picker requests are rejected explicitly');
await hostRequest('cancelPicker', {id:pickerMessage.id}); const cancelled = await picker;
check(cancelled.ok && cancelled.cancelled, 'native sheet cancellation resolves its original request cleanly');
const abort = new AbortController(); const abortedPicker = nativeApi('/api/pick-file', {method:'POST',body:'{}',signal:abort.signal});
await new Promise(resolve => setTimeout(resolve, 80)); abort.abort(); let aborted=false;
try { await abortedPicker; } catch(error) { aborted=error.name==='AbortError'; }
check(aborted, 'normal native picker API AbortSignal cancels its sheet');
return {results, cancellation};`);
    const report = path.join(root, 'native.json');
    child = cp.spawn(path.join(bundle, 'Contents/MacOS/RuyiDesktop'), ['--acceptance-report', report,
      '--acceptance-script', script, '--acceptance-auto-quit'], {
      env: { ...process.env, ...fixture.env, RUYI_HOME: data, RUYI_NODE_PATH: process.execPath }, cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', value => { output = (output + value).slice(-8000); });
    await until(() => child.exitCode !== null || child.signalCode !== null);
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    ok(child.exitCode === 0 && result.state === 'ready', 'complete native workbench bridge acceptance exits normally ' + output);
    for (const assertion of result.page?.additional?.results || []) ok(assertion.ok, assertion.label);
    const cancellation = result.page?.additional?.cancellation;
    const persistedSession = JSON.parse(fs.readFileSync(path.join(data, 'sessions', cancellation.before.session.id + '.json'), 'utf8'));
    const persistedConfig = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    const expectedConfig = server.normalizeConfig(cancellation.before.config, { inferExplicit: false }).persisted;
    ok(persistedSession.id === cancellation.before.session.id && persistedSession.cwd === cancellation.before.session.cwd
      && isDeepStrictEqual(persistedConfig, expectedConfig),
      'after App exit the cancelled session cwd and complete config still match the pre-drop disk-backed snapshot');
    ok(result.page?.additional?.results?.length >= 15, 'native acceptance returned all required bridge assertions');
    console.log('Native bridge reports ' + root);
  } finally { await killOwnTree(child); }
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done());
