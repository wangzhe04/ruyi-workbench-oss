// One root binding per process, after the stable control-base OS owner and before any store IO.
// The active manifest selects both the data namespace and work-data mode. A config flag is a mirror.
const WorkDataRootAuthority = ((fsApi, pathApi) => {
  const ID = /^[a-f0-9]{48}$/;
  const fail = suffix => { throw Object.assign(new Error('work_data_root.' + suffix), {
    code: 'work_data_root.' + suffix, apiCode: 'work_data_root.' + suffix, statusCode: 409,
  }); };
  function create(host) {
    const io = host.fs || fsApi, p = host.path || pathApi;
    const key = value => process.platform === 'win32' ? p.resolve(value).toLowerCase() : p.resolve(value);
    const inside = (target, root) => { const rel = p.relative(key(root), key(target)); return rel === '' || rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel); };
    const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
    let status = 'unbound', selected = null, aliases = [], reservedUnavailable = false;
    let reserved = { hasControl: false, generations: new Map(), container: null };
    const bases = () => [...new Set([host.base(), ...aliases, ...(selected ? [selected.canonicalBase] : [])])];
    function mode(legacy) {
      if (status === 'binding' || status === 'failed') fail('unavailable');
      return selected?.present ? selected.mode === 'encrypted' : legacy === true;
    }
    function requireOwner(owner, canonicalBase) {
      if (!owner || !Array.isArray(owner.roots) || !owner.roots.some(root => key(root) === key(canonicalBase))) fail('ownership_required');
    }
    async function reservedFacts(canonicalBase, owner) {
      requireOwner(owner, canonicalBase);
      const control = p.join(canonicalBase, '.work-data'), generations = new Map();
      let stat;
      try { stat = await io.lstat(control); }
      catch (error) { if (error.code === 'ENOENT') return { hasControl: false, generations, container: null }; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(await io.realpath(control)) !== key(control)) fail('control_invalid');
      const container = p.join(control, 'generations');
      try { stat = await io.lstat(container); }
      catch (error) { if (error.code === 'ENOENT') return { hasControl: true, generations, container: null }; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(await io.realpath(container)) !== key(container))
        return { hasControl: true, generations, container: null }; // An unrecognized reserved entry remains wholly private.
      for (const entry of await io.readdir(container, { withFileTypes: true })) {
        const name = fold(entry.name);
        if (!ID.test(name)) continue;
        const root = p.join(container, entry.name), current = await io.lstat(root);
        if (current.isDirectory() && !current.isSymbolicLink() && key(await io.realpath(root)) === key(root)) generations.set(name, root);
      }
      return { hasControl: true, generations, container };
    }
    // A future transition host may refresh after preparing/removing reserved paths while
    // holding this same base owner and its global writer exclusion. This does not rebind
    // the active namespace or mode; a fresh process is still required for that publication.
    async function refreshReserved(owner) {
      if (status !== 'bound') fail('unavailable');
      requireOwner(owner, selected.canonicalBase);
      try { reserved = await reservedFacts(selected.canonicalBase, owner); reservedUnavailable = false; }
      catch (error) { reservedUnavailable = true; throw error; }
    }
    async function bind(owner) {
      if (status !== 'unbound') fail('already_bound');
      status = 'binding';
      try {
        const base = host.base(), canonicalBase = await host.canonical(base);
        requireOwner(owner, canonicalBase);
        let found;
        try { found = await io.lstat(canonicalBase); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const receipt = found ? await host.manifest(canonicalBase).readActive() : { root: base, id: null, mode: 'plain', generation: 0, proof: Object.freeze({ raw: null, sha256: null }) };
        if (receipt.proof.raw !== null) {
          const pointer = await io.lstat(p.join(canonicalBase, '.work-data', 'active-v1.json'));
          if (!pointer.isFile() || pointer.isSymbolicLink() || pointer.nlink !== 1) fail('manifest_alias');
        }
        const facts = await reservedFacts(canonicalBase, owner), present = receipt.proof.raw !== null;
        if (present && !facts.generations.has(fold(receipt.id))) fail('generation_unrecognized');
        const snapshot = Object.freeze({ present, base, canonicalBase, root: present ? receipt.root : host.paths.data,
          id: receipt.id, mode: present ? receipt.mode : null, generation: receipt.generation, proof: receipt.proof });
        aliases = [...new Set([base, canonicalBase, ...(await host.aliases())])];
        if (present) {
          const from = p.resolve(host.paths.data), next = {};
          for (const [name, value] of Object.entries(host.paths)) {
            if (typeof value !== 'string' || !inside(value, from)) fail('mixed_paths');
            next[name] = p.join(receipt.root, p.relative(from, p.resolve(value)));
          }
          // All async validation completes before this indivisible namespace publication.
          Object.assign(host.paths, next);
        }
        reserved = facts; selected = snapshot; status = 'bound';
        if (present && host.pin) host.pin(base, aliases);
        return snapshot;
      } catch (error) { status = 'failed'; throw error; }
    }
    function generationRoot(target, base) {
      const relative = p.relative(key(p.join(base, '.work-data', 'generations')), key(target));
      const parts = relative.split(p.sep);
      return parts.length && reserved.generations.has(parts[0]) ? p.join(base, '.work-data', 'generations', parts[0]) : null;
    }
    function guardRoots(target) {
      const roots = [...bases(), ...(selected?.present ? [selected.root] : [])];
      if (target) for (const base of [...roots]) { const root = generationRoot(target, base); if (root && inside(target, root)) roots.push(root); }
      return [...new Set(roots)];
    }
    function controlSensitive(target, write = false) {
      for (const base of bases()) {
        const control = p.join(base, '.work-data');
        if (!inside(target, control)) continue;
        const rel = p.relative(key(control), key(target)), parts = rel.split(p.sep);
        if (!rel || parts[0] === 'generations' && parts.length === 1 && reserved.container) return write;
        if (parts[0] === 'generations' && reserved.generations.has(parts[1] || '')) {
          if (write && (parts.length === 2 || !selected?.present || key(p.join(control, 'generations', parts[1])) !== key(selected.root))) return true;
          return false; // Per-family guards below this generation retain normal user-content reads.
        }
        return true; // Manifest, stages, journals and unknown reserved control paths.
      }
      return false;
    }
    async function hardlinkIdentities() {
      if (reservedUnavailable) fail('reserved_unavailable');
      const ids = new Set();
      async function scan(file) {
        let stat;
        try { stat = await io.lstat(file, { bigint: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (stat.isSymbolicLink()) fail('sensitive_alias');
        if (stat.isFile()) { if (stat.ino && stat.nlink > 1n) ids.add(String(stat.dev) + ':' + String(stat.ino)); return; }
        if (!stat.isDirectory()) return;
        const directory = await io.opendir(file);
        for await (const entry of directory) await scan(p.join(file, entry.name));
      }
      const names = ['config.json', 'runtime.json', 'sessions', 'memory', 'usage', 'logs', 'generated', 'agent-runs', 'steward',
        'missions', 'scheduler', 'migrations', 'engine-transcripts.json', 'credential-vault-v1.json', 'credential-import-v1.json',
        'mcp-consumers-v1.json', 'privacy-scopes', 'external-bot-credentials.json', 'external-bots', 'desktop', 'work-data-key-v1.json'];
      const base = selected?.canonicalBase || await host.canonical(host.base());
      for (const root of [base, ...reserved.generations.values()]) {
        for (const name of names) await scan(p.join(root, name));
        let entries;
        try { entries = await io.readdir(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const name of entries) if (/^(?:config\.json|credential-vault-v1\.json|credential-import-v1\.json|external-bot-credentials\.json|work-data-key-v1\.json)\./i.test(name)) await scan(p.join(root, name));
      }
      const control = p.join(base, '.work-data');
      let entries;
      try { entries = await io.readdir(control); } catch (error) { if (error.code === 'ENOENT') return ids; throw error; }
      for (const name of entries) {
        const file = p.join(control, name);
        if (fold(name) !== 'generations' || !reserved.container) { await scan(file); continue; }
        // Only verified real generation directories have ordinary readable children.
        // Unknown entries (including a 48hex regular file) are reserved private data.
        const containerStat = await io.lstat(file);
        if (!containerStat.isDirectory() || containerStat.isSymbolicLink() || key(await io.realpath(file)) !== key(reserved.container)) fail('reserved_unavailable');
        for (const entry of await io.readdir(file, { withFileTypes: true })) {
          const root = p.join(file, entry.name), recognized = reserved.generations.get(fold(entry.name));
          if (recognized) {
            const stat = await io.lstat(root);
            if (stat.isDirectory() && !stat.isSymbolicLink() && key(await io.realpath(root)) === key(recognized)) continue;
          }
          await scan(root);
        }
      }
      return ids;
    }
    return Object.freeze({ bind, mode, guardRoots, controlSensitive, hardlinkIdentities, refreshReserved,
      hasReserved: () => reserved.hasControl, hardlinkGuarded: () => reserved.hasControl || reservedUnavailable || selected?.present === true || status === 'failed',
      selected: () => selected, ready: () => status === 'bound', guarded: () => selected?.present === true || status === 'failed' });
  }
  const active = create({ paths, base: dataRoot, aliases: dataRootAliases, canonical: ServerOwnership.canonicalRoot,
    manifest: base => WorkDataManifest.create({ base }), pin: (base, aliases) => {
      _workDataStableBase = base; _workDataStableAliases = Object.freeze(aliases.filter(alias => alias !== base));
    } });
  Object.assign(WorkDataRootHooks, { bind: active.bind, ready: active.ready, mode: active.mode, guardRoots: active.guardRoots, controlSensitive: active.controlSensitive,
    hardlinkIdentities: active.hardlinkIdentities, hardlinkGuarded: active.hardlinkGuarded, refreshReserved: active.refreshReserved, guarded: active.guarded });
  return Object.freeze({ create, ...active });
})(require('node:fs/promises'), require('node:path'));
