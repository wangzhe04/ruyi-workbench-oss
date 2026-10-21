'use strict';
// Current pre-dispatch refusal of references in arbitrary scripts. Synthetic only;
// no script, model, network or user file is executed/read. Historical derivation
// reports remain historical; refusing reference restoration is not OS isolation.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-oracle-boundary-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyCore', 'PrivacyGateway', 'toolCall', 'TOOL_HANDLERS', 'mutateConfig', 'readConfig'], { withEval: true });
const fixture = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = fixture.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = fixture.vault.openLocal;
(async () => {
  try {
    const settings = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [], credentialEncryptionV1: true,
      allowCommandTools: true, permissionMode: 'bypass', defaultWorkspace: work };
    await app.mutateConfig(cfg => { Object.assign(cfg, settings); return {}; }); const cfg = await app.readConfig();
    const value = '2SYNTHETIC-DERIVATION-ONLY', report = { syntheticOnly: true, networkCalls: 0, claim: 'reference-bearing scripts refused before dispatch; no isolation claim for scripts without references' };
    const observed = app.__eval(`(() => {
      const observed = { executed: 0 };
      for (const name of ['powershell_run', 'script_run']) {
        const original = TOOL_HANDLERS[name].handler;
        TOOL_HANDLERS[name].handler = async (...args) => { observed.executed++; return original(...args); };
      }
      return observed;
    })()`);
    app.PrivacyGateway.configure(cfg);
    await app.PrivacyGateway.run('oracle-boundary', cfg, async () => {
      const token = app.PrivacyGateway.active().scope.protectValue(value, 'INTERNAL');
      const ctx = { config: cfg, workingDir: work, session: { id: 'oracle-boundary', cwd: work } };
      report.refusals = [];
      for (const [name, args] of [
        ['powershell_run', { command: "Write-Output '" + token + "'" }],
        ['powershell_run', { command: "$syntheticValue = '" + token + "'; Write-Output $syntheticValue.Substring(0,1)" }],
        ['script_run', { language: 'node', code: 'console.log(' + JSON.stringify(token) + '.slice(0,1))' }],
      ]) {
        const prepared = await app.PrivacyGateway.prepareExecution({ name, rawArgs: JSON.stringify(args) }, ctx);
        if (prepared.privacyError?.code !== 'privacy.disclosure_not_supported' || prepared.rawArgs.includes(value)) throw Error('script_preparation_was_not_refused');
        let code = '';
        try { await app.toolCall(name, args, ctx); } catch (error) { code = error.code; }
        if (code !== 'privacy.disclosure_not_supported') throw Error('script_dispatch_was_not_refused');
        report.refusals.push({ tool: name, preparation: prepared.privacyError.code, dispatch: code });
      }
      report.scriptExecutions = observed.executed;
      report.expectedBoundaryObserved = observed.executed === 0 && report.refusals.length === 3;
    });
    console.log(JSON.stringify(report, null, 2)); if (!report.expectedBoundaryObserved) process.exitCode = 1;
  } finally { fixture.vault.clear(); if (path.dirname(root) !== base || !path.basename(root).startsWith('ruyi-oracle-boundary-')) throw Error('cleanup_scope'); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(/^[a-z_.]+$/.test(error.code || error.message || '') ? error.code || error.message : 'oracle_boundary_probe_failed'); process.exitCode = 1; });
