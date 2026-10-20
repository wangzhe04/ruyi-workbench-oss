'use strict';
// Explicit diagnostic of the practical-DLP boundary. Synthetic local data only;
// no model, network, user configuration or transcript. Does not claim isolation.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-oracle-boundary-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyCore', 'PrivacyGateway', 'toolCall', 'TOOL_HANDLERS', 'mutateConfig', 'readConfig']);
const fixture = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = fixture.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = fixture.vault.openLocal;
(async () => {
  try {
    const settings = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [], credentialEncryptionV1: true,
      allowCommandTools: true, permissionMode: 'bypass', defaultWorkspace: work };
    await app.mutateConfig(cfg => { Object.assign(cfg, settings); return {}; }); const cfg = await app.readConfig();
    const value = '2SYNTHETIC-DERIVATION-ONLY', report = { syntheticOnly: true, networkCalls: 0, claim: 'accidental-disclosure prevention; arbitrary execution is not capability isolation' };
    fs.writeFileSync(path.join(work, 'synthetic-secret.txt'), value);
    app.PrivacyGateway.configure(cfg);
    await app.PrivacyGateway.run('oracle-boundary', cfg, async () => {
      const token = app.PrivacyGateway.active().scope.protectValue(value, 'INTERNAL');
      const execute = async command => {
        const prepared = app.PrivacyGateway.prepareCall({ name: 'powershell_run', rawArgs: JSON.stringify({ command }) }, { isRegisteredTool: name => Object.hasOwn(app.TOOL_HANDLERS, name) });
        if (prepared.privacyError) throw Error(prepared.privacyError.code);
        const result = await app.toolCall('powershell_run', JSON.parse(prepared.rawArgs), { config: cfg, workingDir: work });
        if (!result.ok) throw Error('synthetic_command_failed');
        return app.PrivacyGateway.modelToolResult(result);
      };
      const complete = await execute("Write-Output '" + token + "'");
      const derived = await execute("$syntheticValue = '" + token + "'; Write-Output $syntheticValue.Substring(0,1)");
      const fromDisk = await execute("$syntheticValue = [IO.File]::ReadAllText((Join-Path (Get-Location) 'synthetic-secret.txt')); Write-Output $syntheticValue.Substring(0,1)");
      report.completeValueProtected = !JSON.stringify(complete).includes(value) && JSON.stringify(complete).includes('[[RUYI_PVT:');
      report.derivedCharacterVisible = String(derived.stdout || '').trim() === value[0];
      report.fileReadCharacterVisible = String(fromDisk.stdout || '').trim() === value[0];
      report.aliasRestorationBanAloneWouldNotIsolate = report.fileReadCharacterVisible;
      report.expectedBoundaryObserved = report.completeValueProtected && report.derivedCharacterVisible && report.fileReadCharacterVisible;
    });
    console.log(JSON.stringify(report, null, 2)); if (!report.expectedBoundaryObserved) process.exitCode = 1;
  } finally { fixture.vault.clear(); if (path.dirname(root) !== base || !path.basename(root).startsWith('ruyi-oracle-boundary-')) throw Error('cleanup_scope'); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(/^[a-z_.]+$/.test(error.code || error.message || '') ? error.code || error.message : 'oracle_boundary_probe_failed'); process.exitCode = 1; });
