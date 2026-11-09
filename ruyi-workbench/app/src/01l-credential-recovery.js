// 81-P1: Import appends immutable vault records before a journaled config switch.
// An interrupted switch rolls back config on the next read; old encrypted records remain usable.
const CredentialRecovery = ((cryptoApi) => {
  const fail = code => { throw Object.assign(new Error('credential_recovery.' + code), { code: 'credential_recovery.' + code, statusCode: 409 }); };
  function startupGuidance(error, platform = require('node:process').platform) {
    // A portable package can restore credentials into a fresh profile, but replacing
    // this profile's master key would orphan its conversation reference mappings.
    // Never present an incorrect backup password or an unrelated failure as DPAPI loss.
    const suffix = String(error?.code || '').replace(/^credential_vault\./, '');
    if (platform === 'darwin' && ['permission_required', 'permission_denied', 'keychain_locked', 'dependency_missing', 'keychain_unavailable'].includes(suffix))
      return '本地凭据暂时无法访问 macOS 钥匙串。请确认工作台组件完整、登录钥匙串已解锁，并恢复钥匙串对工作台的访问权限后重试。保留原数据目录；访问失败不会回落到明文。';
    if (platform === 'darwin' && suffix === 'keychain_corrupt')
      return 'macOS 钥匙串中的工作台封装密钥损坏，请保留原钥匙串及数据，先恢复系统钥匙串。仅更换 RUYI_HOME 无法修复系统密钥；如有口令保护的凭据恢复包，可在钥匙串正常的独立系统账户或另一台机器上，使用全新的数据目录预览并导入。';
    if (platform === 'darwin' && ['unlock_failed', 'key_missing', 'key_changed', 'provider_mismatch'].includes(suffix))
      return '本地凭据库无法在当前 Mac 钥匙串身份下解锁。请保留原数据目录及其中的密钥、credential-vault-v1.json、privacy-scopes 和会话，不要删除密钥或覆盖旧库。'
        + 'Windows DPAPI 数据不能在 Mac 直接解密；请在原系统和账户导出口令保护的凭据恢复包。已有恢复包时，将 RUYI_HOME 设置为独立、全新的空目录，再按 Mac 启动方式运行工作台；'
        + '进入「设置 → 权限与安全 → 本地隐私保护 → 凭据恢复包」，输入导出时的口令，先预览再确认导入。恢复包不恢复旧聊天、隐私规则或代号映射。';
    if (error?.code !== 'credential_vault.unlock_failed') return '';
    return '本地凭据库无法在当前 Windows 账户或系统环境下解锁（credential_vault.unlock_failed）。'
      + '请保留原数据目录及其中的密钥、credential-vault-v1.json、privacy-scopes 和会话，不要删除密钥或覆盖旧库。'
      + '如果已有口令保护的凭据恢复包，请在启动前将 RUYI_HOME 设置为一个独立、全新的空目录，再运行 Start-Workbench.cmd；'
      + '进入「设置 → 权限与安全 → 本地隐私保护 → 凭据恢复包」选择恢复包、输入导出时的口令，先预览再确认导入。'
      + '恢复包只恢复凭据与连接配置，不恢复旧聊天、隐私规则或代号映射；旧资料应继续保留，需要原 Windows 身份和可用密钥才能读取。';
  }
  function create(host) {
    const tickets = new Map(), revisionKey = cryptoApi.randomBytes(32);
    const transaction = new (require('node:async_hooks').AsyncLocalStorage)();
    let activeDone = Promise.resolve(), finishActive = () => {}, activeOwner = null, deferredConfig = null;
    let active = false, recoveryPromise = null, previews = 0;
    const revision = async () => cryptoApi.createHmac('sha256', revisionKey).update(await host.readConfigFile()).update(String(await host.vault.stateStamp())).digest('hex');
    const cleanup = () => { for (const [id, value] of tickets) if (value.expires <= Date.now()) tickets.delete(id); };
    async function recoverPending() {
      while (active && transaction.getStore() !== activeOwner) await activeDone;
      if (active) return false;
      if (recoveryPromise) return recoveryPromise;
      recoveryPromise = (async () => {
        const encrypted = await host.readJournal(); if (!encrypted) return false;
        let journal;
        try { journal = JSON.parse(await host.vault.openLocal(encrypted, 'credential-import', 'journal-v1')); }
        catch { fail('journal_unreadable'); }
        if (journal.version !== 1 || typeof journal.previous !== 'string' || !journal.previous.length || journal.previous.length > 1024 * 1024) fail('journal_invalid');
        await host.writeConfigFile(journal.previous);
        await host.removeJournal();
        return true;
      })();
      try { return await recoveryPromise; } finally { recoveryPromise = null; }
    }
    async function preview(backup, password) {
      cleanup(); if (tickets.size + previews >= 4 || active || previews >= 2) fail('busy');
      previews++;
      try {
      await host.readConfig();
      const before = await revision();
      const prepared = await host.vault.prepareImport(backup, password, { runtime: true });
      const imported = host.normalize(prepared.runtime).config;
      const patch = {};
      for (const key of ['providers', 'externalMcpServers', 'modelsApiKey', 'modelsApiBase', 'searchBackend']) {
        if (Array.isArray(imported[key]) ? imported[key].length > 0 : typeof imported[key] === 'string' ? !!imported[key] : !!imported[key]?.apiKey) patch[key] = imported[key];
      }
      if (!Object.keys(patch).length) fail('empty');
      const ticket = cryptoApi.randomBytes(24).toString('hex'), expires = Date.now() + 120000;
      tickets.set(ticket, { patch, before, expires });
      const origin = value => { try { return new URL(value).origin; } catch { return ''; } };
      return { ticket, expiresAt: new Date(expires).toISOString(), summary: {
        providers: (patch.providers || []).map(p => ({ id: p.id, label: p.label || p.id, origin: origin(p.baseUrl) })),
        connectors: (patch.externalMcpServers || []).map(p => ({ id: p.id, label: p.label || p.id, origin: origin(p.url), command: String(p.command || '').slice(0, 512), argumentCount: (p.args || []).length })),
        cli: !!patch.modelsApiKey, search: !!patch.searchBackend, cliOrigin: origin(patch.modelsApiBase), searchOrigin: origin(patch.searchBackend?.baseUrl),
      } };
      } finally { previews--; }
    }
    async function commit(ticket) {
      cleanup(); const item = tickets.get(ticket); if (!item) fail('ticket_expired');
      tickets.delete(ticket); if (active || host.busy()) fail('busy');
      active = true; activeOwner = {}; deferredConfig = null; activeDone = new Promise(resolve => { finishActive = resolve; });
      return transaction.run(activeOwner, async () => {
      let journalWritten = false;
      try {
        const result = await host.mutate(async current => {
          if (await revision() !== item.before) fail('configuration_changed');
          const next = structuredClone(current);
          for (const [key, value] of Object.entries(item.patch)) {
            if (Array.isArray(value)) {
              const merged = new Map((Array.isArray(next[key]) ? next[key] : []).map(row => [row.id, row]));
              for (const row of value) merged.set(row.id, row);
              if (merged.size > (key === 'providers' ? 20 : 10)) fail('capacity');
              next[key] = [...merged.values()];
            } else next[key] = value;
          }
          next.credentialEncryptionV1 = true;
          const previous = await host.vault.protectConfig(JSON.stringify(host.normalize(current).persisted), { force: true });
          // This append is safe even when the subsequent config write fails: no old records are replaced.
          await host.vault.protectConfig(JSON.stringify(host.normalize(next).persisted), { force: true });
          const encrypted = await host.vault.sealLocal(JSON.stringify({ version: 1, previous }), 'credential-import', 'journal-v1');
          await host.writeJournal(encrypted); journalWritten = true;
          return { next };
        });
        await host.removeJournal(); journalWritten = false;
        active = false;
        // Publish configuration changes only after the journal has been durably removed.
        if (deferredConfig) { try { host.committed?.(deferredConfig); } catch { /* committed data is authoritative; observers retry on their next read */ } }
        return { ok: result.ok === true };
      } catch (error) {
        if (journalWritten) {
          active = false;
          try { await recoverPending(); host.invalidate(); } catch { fail('recovery_required'); }
        }
        throw error;
      } finally { active = false; activeOwner = null; deferredConfig = null; host.invalidate(); finishActive(); }
      });
    }
    async function exportBackup(password) {
      if (active || host.busy()) fail('busy');
      await host.readConfig();
      return host.vault.exportBackup(await host.readConfigFile(), password);
    }
    function deferConfigWritten(config) {
      if (!active || transaction.getStore() !== activeOwner) return false;
      deferredConfig = structuredClone(config); return true;
    }
    return Object.freeze({ recoverPending, preview, commit, exportBackup, deferConfigWritten, startupGuidance });
  }
  return Object.freeze({ create, startupGuidance });
})(require('node:crypto'));

const credentialRecoveryJournal = DurableJsonStore.create({
  id: 'credential-import-v1', file: () => path.join(paths.data, 'credential-import-v1.json'), schemaKey: 'version', schemaVersion: 1,
  cache: false, strictRead: true, quarantine: false, defaultValue: () => null,
  validate: value => value.version === 1 && typeof value.instanceId === 'string' && !!value.envelope,
});
Object.assign(PrivacyCore.configHooks, CredentialRecovery.create({
  committed: configEmitWritten, vault: { ...PrivacyCore.configHooks }, normalize: normalizeConfig, readConfig, mutate: mutateConfig,
  busy: () => typeof PrivacyCore.configHooks.isBusy === 'function' && PrivacyCore.configHooks.isBusy(),
  readConfigFile: () => fsp.readFile(paths.config, 'utf8'),
  writeConfigFile: value => atomicWriteJson(paths.config, value, { mode: 0o600 }),
  readJournal: async () => {
    try { const file = path.join(paths.data, 'credential-import-v1.json'), stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('credential_recovery.journal_invalid');
      return credentialRecoveryJournal.read(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
  writeJournal: value => credentialRecoveryJournal.write(value),
  removeJournal: () => fsp.unlink(path.join(paths.data, 'credential-import-v1.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }),
  invalidate: () => { configReadCache = null; lastGoodConfig = null; },
}));
