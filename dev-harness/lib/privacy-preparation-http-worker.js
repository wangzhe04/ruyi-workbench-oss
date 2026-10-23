'use strict';
// Child of privacy-preparation-stop.e2e.js. Loads the generated server at its real filename.
// No source overlay, production patch or synthetic turn controller is used here.
const fs = require('node:fs'), path = require('node:path');
const repo = process.env.RUYI_GATEWAY_DRAFT_REPO || path.resolve(__dirname, '../..');
const { createPreparationObserver } = require(fs.existsSync(path.join(__dirname, 'privacy-preparation-observer.js')) ? './privacy-preparation-observer' : './preparation-observer');
const app = require(path.join(repo, 'dev-harness/lib/server-internals')).loadServerInternals([
  'startServer', 'PrivacyCore', 'PrivacyGateway', 'readConfig', 'mutateConfig', 'paths',
], { withEval: true });
const fixture = require(path.join(repo, 'dev-harness/lib/privacy-test-fixture')).fixture();
app.PrivacyCore.configHooks.sealLocal = fixture.vault.sealLocal;
app.PrivacyCore.configHooks.openLocal = fixture.vault.openLocal;
const observer = createPreparationObserver({ onPause: value => process.send?.({ event: 'preparation-paused', ...value }) });
// The tiny probe ALS labels actual runSubAgentCore invocations only; it does not touch
// PrivacyGateway's ALS, scope identity, permission context or cancellation controllers.
const probe = app.__eval(`(() => {
  const probe = { child: new (require('node:async_hooks').AsyncLocalStorage)(), observer: null, tools: [], childEntries: 0, transportErrors: [], disconnects: 0 };
  const childCore = runSubAgentCore, originalPost = providerModelPostOnce, execute = toolCall, originalTurn = runSessionTurn;
  runSessionTurn = options => {
    if (options.source === 'http' && options.signal) options.signal.addEventListener('abort', () => { probe.disconnects++; }, { once: true });
    return originalTurn(options);
  };
  runSubAgentCore = options => { probe.childEntries++; return probe.child.run(true, () => childCore(options)); };
  providerModelPostOnce = async options => {
    const kind = probe.child.getStore() ? 'child' : 'main';
    try { return await probe.observer.boundary(kind, options, originalPost); }
    catch (error) { probe.transportErrors.push({ kind, code: error.code || '', name: error.name, message: error.message }); throw error; }
  };
  toolCall = async function(name, args, context) { probe.tools.push({ name, args: structuredClone(args) }); return execute(name, args, context); };
  detectClaudePath = () => ''; detectKimiPath = () => ''; maybeWriteThreadBrief = async () => {};
  // Optional background probes are outside this privacy/cancellation test.
  ensureDesktopMcpWarm = async () => {}; generateMcpConfig = async () => '';
  syncMcpServersToClaude = async () => {}; syncAgentCliMcpManifests = async () => {};
  return probe;
})()`);
probe.observer = observer;
const immediate = global.setImmediate;
global.setImmediate = (callback, ...args) => observer.schedule(immediate, callback, ...args);
let baselinePolicy;
process.on('message', async message => {
  if (!message?.command) return;
  try {
    let result;
    if (message.command === 'arm') { observer.arm(message.scenario); probe.tools.length = 0; probe.childEntries = 0; probe.transportErrors.length = 0; probe.disconnects = 0; result = observer.snapshot(); }
    else if (message.command === 'probe') result = { ...observer.snapshot(), tools: probe.tools, childEntries: probe.childEntries, transportErrors: probe.transportErrors, disconnects: probe.disconnects };
    else if (message.command === 'release') result = { released: observer.release() };
    else if (message.command === 'epoch-away-back') { app.PrivacyGateway.configure({ privacyModeV1: 'off' }); app.PrivacyGateway.configure(baselinePolicy); result = { changedTwice: true }; }
    else throw Error('unknown fixture command');
    process.send?.({ reply: message.id, result });
  } catch (error) { process.send?.({ reply: message.id, error: String(error.stack || error) }); }
});
(async () => {
  baselinePolicy = await app.readConfig();
  await app.startServer({ port: Number(process.env.RUYI_PREPARATION_PORT), open: false });
  const runtime = JSON.parse(fs.readFileSync(path.join(app.paths.data, 'runtime.json'), 'utf8'));
  process.send?.({ event: 'ready', port: runtime.port, token: runtime.token });
})().catch(error => { process.send?.({ event: 'worker-error', error: String(error.stack || error) }); process.exitCode = 1; });
