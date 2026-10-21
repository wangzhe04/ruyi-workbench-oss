'use strict';
// Test-only CLI admission. No HTTP test route, verifier replacement or fake env
// authority: the product host registers its own real wrapper ChildProcess.
const cp = require('node:child_process');
const path = require('node:path');
const { killOwnTree } = require('./kill-own-tree');
const SERVER = path.resolve(__dirname, '../../ruyi-workbench/app/server.js');
let serial = 0;
function send(child, value) { if (child.connected) child.send(value, () => {}); }
function spawnInternalMcpHost(options = {}) {
  const child = cp.spawn(process.execPath, [__filename, '--host', String(options.port)], {
    ...options, port: undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.fixtureBridges = new Map();
  child.fixtureReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(Error('Internal MCP host ready deadline')); void killOwnTree(child); }, 45000);
    child.on('message', message => {
      if (message?.kind === 'ready') { clearTimeout(timer); resolve(message); }
      const proxy = child.fixtureBridges.get(message?.bridge);
      if (proxy) send(proxy, message);
    });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Internal MCP host exited')); for (const proxy of child.fixtureBridges.values()) send(proxy, { kind: 'exit', code: 1 }); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  // Most old fixtures wait on /health before their first MCP RPC.
  child.fixtureReady.catch(() => {});
  return child;
}
function spawnAuthenticatedMcp(host, options = {}) {
  const proxy = cp.spawn(process.execPath, [__filename, '--proxy'], {
    ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const bridge = ++serial; host.fixtureBridges.set(bridge, proxy);
  proxy.on('message', message => send(host, { ...message, bridge }));
  proxy.once('exit', () => { host.fixtureBridges.delete(bridge); send(host, { kind: 'close', bridge }); });
  host.fixtureReady.then(() => {
    if (proxy.exitCode === null && proxy.signalCode === null) send(host, { kind: 'open', bridge, env: options.env || process.env });
  }, () => send(proxy, { kind: 'exit', code: 1 }));
  return proxy;
}
function spawnMcpInApp(app, { session, env = process.env }) {
  if (!session || !app.RUNTIME?.token) throw Error('Fixture host/session required');
  const child = cp.spawn(process.execPath, [__filename, '--cli'], { env: { ...env, WCW_HOST: '127.0.0.1', WCW_PORT: String(app.RUNTIME.port), WCW_TOKEN: app.RUNTIME.token, WCW_SESSION_ID: session.id }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let settle; const owner = { promise: new Promise(resolve => { settle = resolve; }), source: 'fixture-cli', driverRunId: 'fixture-local-' + (++serial), phase: 'starting', cancelRequested: false, cancel() { this.cancelRequested = true; } };
  const reg = { child, pid: child.pid, kind: 'kimi-acp', state: 'running', exited: false, session };
  app.recordSessionExecutionOwner(session.id, owner); app.registerSessionExecutionChild(session.id, reg, owner);
  const close = () => { if (app.activeChildren.get(session.id) === reg) app.activeChildren.delete(session.id); if (app.turnSettlers.get(session.id) === owner) app.turnSettlers.delete(session.id); settle(); };
  child.once('exit', close); child.once('error', close); return child;
}
async function spawnMcpWithOwnedHost(options = {}) {
  const port = await require('../free-port').getFreePort();
  const host = spawnInternalMcpHost({ ...options, port });
  host.stdout.resume(); host.stderr.resume();
  try { await host.fixtureReady; } catch (error) { void killOwnTree(host); throw error; }
  const child = spawnAuthenticatedMcp(host, options);
  child.fixtureHost = host;
  child.once('exit', () => { void killOwnTree(host); });
  return child;
}
async function closeFixtureMcp(child) {
  if (!child) return;
  const owned = [child, child.fixtureHost].filter(Boolean);
  for (const item of owned) {
    if (item.exitCode !== null || item.signalCode !== null) continue;
    const exited = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Fixture child exit deadline')), 5000); item.once('exit', () => { clearTimeout(timer); resolve(); }); });
    void killOwnTree(item); await exited;
  }
}
module.exports = { spawnInternalMcpHost, spawnAuthenticatedMcp, spawnMcpWithOwnedHost, spawnMcpInApp, closeFixtureMcp };

// Child close is the upstream boundary; write callbacks are the downstream
// boundary. Neither process exit nor receipt of an IPC exit proves stdout drained.
function outputCompletion() {
  let pending = 0, ending = false, code = 0, timer;
  const fail = () => { clearTimeout(timer); process.exit(1); };
  const finish = () => { if (ending && pending === 0) { clearTimeout(timer); process.exit(code); } };
  process.stdout.on('error', fail); process.stderr.on('error', fail);
  return {
    write(stream, bytes) {
      if (ending) return fail();
      pending++;
      try { return stream.write(bytes, error => { pending--; if (error) fail(); else finish(); }); }
      catch { fail(); }
    },
    end(value) {
      if (ending) return;
      ending = true; code = Number.isInteger(value) ? value : 1;
      timer = setTimeout(fail, 5000); finish();
    },
  };
}
if (require.main === module) {
  const role = process.argv[2];
  if (role === '--cli') {
    const child = cp.spawn(process.execPath, [SERVER, 'mcp'], { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = outputCompletion();
    process.stdin.pipe(child.stdin);
    for (const kind of ['stdout', 'stderr']) {
      child[kind].on('data', bytes => { if (!output.write(process[kind], bytes)) child[kind].pause(); });
      process[kind].on('drain', () => child[kind].resume());
    }
    child.stdin.on('error', () => {}); child.once('error', () => process.exit(1));
    child.once('close', (code, signal) => output.end(signal ? 1 : code));
  } else if (role === '--proxy') {
    const output = outputCompletion();
    let ready = false, ended = false, size = 0; const pending = [];
    process.stdin.on('data', bytes => { if (ready) send(process, { kind: 'input', bytes: bytes.toString('base64') }); else { size += bytes.length; if (size > 1024 * 1024) process.exit(1); pending.push(bytes); } });
    process.stdin.on('end', () => { ended = true; if (ready) send(process, { kind: 'end' }); });
    process.on('message', message => {
      if (message?.kind === 'opened') { ready = true; for (const bytes of pending) send(process, { kind: 'input', bytes: bytes.toString('base64') }); pending.length = 0; if (ended) send(process, { kind: 'end' }); }
      if (message?.kind === 'stdout') output.write(process.stdout, Buffer.from(message.bytes, 'base64'));
      if (message?.kind === 'stderr') output.write(process.stderr, Buffer.from(message.bytes, 'base64'));
      if (message?.kind === 'exit') output.end(message.code);
    });
    process.once('disconnect', () => process.exit(1));
  } else if (role === '--host') {
    void hostMain().catch(() => { console.error('Internal MCP fixture host failed'); process.exit(1); });
  }
}
async function hostMain() {
  const app = require('./server-internals').loadServerInternals(['startServer', 'RUNTIME', 'createSession', 'loadSession', 'recordSessionExecutionOwner', 'registerSessionExecutionChild', 'activeChildren', 'turnSettlers']);
  const bridges = new Map();
  function close(bridge) {
    const entry = bridges.get(bridge); if (!entry) return;
    bridges.delete(bridge);
    entry.closed = true;
    if (!entry.child) return;
    if (app.activeChildren.get(entry.session.id) === entry.reg) app.activeChildren.delete(entry.session.id);
    if (app.turnSettlers.get(entry.session.id) === entry.owner) app.turnSettlers.delete(entry.session.id);
    entry.settle(); void killOwnTree(entry.child);
  }
  process.once('disconnect', () => { for (const bridge of bridges.keys()) close(bridge); process.exit(0); });
  process.on('message', message => {
    if (!message || !Number.isSafeInteger(message.bridge)) return;
    if (message.kind === 'close') { close(message.bridge); return; }
    const entry = bridges.get(message.bridge);
    if (entry && message.kind === 'input') entry.child.stdin.write(Buffer.from(message.bytes, 'base64'));
    if (entry && message.kind === 'end') entry.child.stdin.end();
    if (message.kind !== 'open') return;
    void (async () => {
      if (bridges.has(message.bridge)) throw Error('Duplicate fixture bridge');
      const pending = { closed: false }; bridges.set(message.bridge, pending);
      const requested = message.env?.WCW_SESSION_ID;
      const session = requested ? await app.loadSession(requested) : await app.createSession({ title: 'Synthetic registered CLI owner' });
      if (pending.closed || bridges.get(message.bridge) !== pending) return;
      if (!session || app.activeChildren.has(session.id)) throw Error('Fixture session unavailable');
      const child = cp.spawn(process.execPath, [__filename, '--cli'], { env: { ...process.env, ...message.env, WCW_HOST: '127.0.0.1', WCW_PORT: String(app.RUNTIME.port), WCW_TOKEN: app.RUNTIME.token, WCW_SESSION_ID: session.id }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let settle; const owner = { promise: new Promise(resolve => { settle = resolve; }), source: 'fixture-cli', driverRunId: 'fixture-cli-' + message.bridge, phase: 'starting', cancelRequested: false, cancel() { this.cancelRequested = true; } };
      const reg = { child, pid: child.pid, kind: 'kimi-acp', state: 'running', exited: false, session };
      bridges.set(message.bridge, { child, owner, reg, session, settle });
      app.recordSessionExecutionOwner(session.id, owner); app.registerSessionExecutionChild(session.id, reg, owner);
      child.stdin.on('error', () => {});
      for (const kind of ['stdout', 'stderr']) child[kind].on('data', bytes => send(process, { kind, bridge: message.bridge, bytes: bytes.toString('base64') }));
      child.once('close', (code, signal) => { send(process, { kind: 'exit', bridge: message.bridge, code: signal ? 1 : code }); close(message.bridge); });
      child.once('error', () => { send(process, { kind: 'exit', bridge: message.bridge, code: 1 }); close(message.bridge); });
      send(process, { kind: 'opened', bridge: message.bridge });
    })().catch(() => { close(message.bridge); send(process, { kind: 'exit', bridge: message.bridge, code: 1 }); });
  });
  await app.startServer({ port: Number(process.argv[3]), host: '127.0.0.1' });
  send(process, { kind: 'ready' });
}
