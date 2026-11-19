// Warm-side data-root hygiene for work-data maintenance (150 W3/W4).
// Nothing here deletes user data: inspect only lstats, quarantine only renames
// inert product crash leftovers into the same root (same volume, product-private
// quarantine-v1 area) with a manifest, and undo renames them back. Never enters
// native skill-backup scopes, never reads keys or decrypts, never touches
// worktrees, logs or caches. Callers own the maintenance gate (no concurrent
// cold operation) and the UI confirmation. Not wired to HTTP yet (a later batch).
//
// inspect({ base, maxEntries? }) -> frozen, stable schema 1 (later batches may
// only add fields):
//   { schema: 1,
//     ok: boolean,                  // true when no verdict has severity 'blocking'
//     verdicts: [{ code,            // 'work_data_hygiene.<name>' (list below)
//                  severity,        // 'blocking': the census/package would refuse
//                                   // 'advice':   nothing fails, but the user should act
//                  action,          // what the UI offers: 'reduce' | 'quarantine' |
//                                   // 'undo-quarantine' | 'replace-alias' |
//                                   // 'separate-hardlink' | 'fix-access' | 'recover'
//                  params }],       // numbers, base-relative '/' paths (first 20), areas
//     census: { files, directories, entries, bytes, largestFileBytes,
//               nativeOwnerRoots: [relative],  // skill-backup roots: counted as one
//                                              // directory each, never enumerated
//               largest: [{ path, files, directories, bytes }] },  // top 8 areas
//     budget: { census: { files, directories, entries, bytes, fileBytes, depth },
//               package: { files, bytes, serialized } },
//     scope: WorkDataTree.rootScope report (schema 1: active, supersededOmitted,
//            included, omitted[], leftovers[{path,directory,reason,area,bytes}],
//            leftoverCount, leftoverBytes, supersededLeftovers, leftoversTruncated),
//     quarantine: [{ root, stamp, state, plaintext }] }  // existing areas, see below
//   state: moving | moved | rolled-back | partial | restored | partially-restored
//   (from the manifest), incomplete (crash before any move: empty area or a
//   torn manifest without data), invalid/unknown (unreadable record with data),
//   alias (the area or quarantine-v1 itself is a junction/symlink: never read,
//   never swept). plaintext: quarantined copies from a superseded root that are
//   still present (they stay plaintext inside the data root).
//   Verdict codes: blocking — inventory_truncated, census_entries_exceeded,
//   census_files_exceeded, census_directories_exceeded, census_bytes_exceeded,
//   census_file_bytes_exceeded, census_depth_exceeded, package_files_exceeded,
//   package_bytes_exceeded, package_serialized_exceeded, aliases_present,
//   hardlinks_present, unreadable_entries, active_pointer_invalid; advice —
//   leftovers_present (active root), superseded_leftovers_present (a superseded
//   plain root or retired generation: may hold plaintext such as a
//   config.json.corrupt-<ts> with provider keys), quarantine_incomplete
//   (action undo-quarantine, or quarantine when only crash-incomplete areas
//   remain: the next run sweeps them), quarantine_record_invalid (action
//   recover), quarantined_plaintext_present (action delete-manually: moved
//   superseded copies are still plaintext in the root; the user may delete
//   that area folder, the product never deletes it). UI copy per advice
//   verdict: workData.hygiene.<camelCase code> in the four locale files.
//   Privacy (main-session decision): inspect output is for the local panel and
//   may show the user's own base-relative paths; error and limit payloads
//   (13u broker areas, 13am/13al limitDetail) carry product names or 'other'.
//   The census is complete (trees the package omits still count); skill-backup
//   trees are not enumerated here, so counts are a lower bound when present.
//
// planQuarantine / quarantine({ token }) / undoQuarantine({ stamp, root }):
//   every movable leftover (active and superseded areas, any number of roots)
//   moves under <root>/quarantine-v1/<stamp>/data/<logical path> where <root>
//   is '' (the base) or '.work-data/generations/<id>'; one stamp per run and one
//   manifest-v1.json per root area, written (wx + fsync) before the first move.
//   Every path read back from a manifest is validated (relative, inside its
//   root, no '.'/'..', no drive/stream/backslash, no alias on the way).
//   A crash between creating an area and finishing its manifest leaves an empty
//   area or a torn manifest with no data: inspect reports state 'incomplete',
//   the next quarantine removes it (alias-checked; the torn manifest is unlinked
//   only as a regular single-link file, then rmdir, so data is never removed).
//   quarantine refuses while any alias sits at or below a quarantine-v1 path,
//   and undo restores only to paths the data-root policy classifies leftover.
const WorkDataRootHygiene = ((io, p, c) => {
  const fail = (suffix, params = {}, cause) => { throw Object.assign(new Error('work_data_hygiene.' + suffix), {
    code: 'work_data_hygiene.' + suffix, apiCode: 'work_data_hygiene.' + suffix, statusCode: 409, params,
    ...(cause === undefined ? {} : { cause }) }); };
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const hash = value => c.createHash('sha256').update(value).digest('hex');
  const at = (root, relative) => relative ? p.join(root, ...relative.split('/')) : root;
  const NATIVE_SCOPE = /^(?:migrations\/skill-backups|\.work-data\/skill-backups|\.work-data\/generations\/[a-f0-9]{48}\/migrations\/skill-backups)$/;
  const GENERATION_ROOT = /^\.work-data\/generations\/[a-f0-9]{48}$/;
  const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
  const STAGE_PID = /\.(\d{1,10})\.[a-f0-9]{8}\.tmp$/;
  const QUIET_MS = 120000, LIST = 20;
  async function realBase(base) {
    if (typeof base !== 'string' || !p.isAbsolute(base)) fail('base_invalid');
    base = p.resolve(base);
    let stat; try { stat = await io.lstat(base); } catch (cause) { fail('base_unavailable', {}, cause); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fold(p.resolve(await io.realpath(base))) !== fold(base)) fail('base_invalid');
    return base;
  }
  // Bounded lstat walk. Native skill-backup trees are listed as opaque roots
  // and never enumerated (their original objects keep all four NTFS times).
  async function walk(root, { maxEntries = 400000 } = {}) {
    const files = [], directories = [], aliases = [], hardlinks = [], nativeOwners = [], unreadable = [];
    let entries = 0, truncated = false, depth = 0;
    async function visit(relative, level) {
      let names;
      try { names = await io.readdir(at(root, relative)); }
      catch (cause) { unreadable.push({ path: relative, code: String(cause.code || 'EIO') }); return; }
      names.sort();
      for (const name of names) {
        if (truncated) return;
        const rel = relative ? relative + '/' + name : name;
        let stat; try { stat = await io.lstat(at(root, rel), { bigint: true }); }
        catch (cause) { unreadable.push({ path: rel, code: String(cause.code || 'EIO') }); continue; }
        if (++entries > maxEntries) { truncated = true; return; }
        depth = Math.max(depth, level);
        if (stat.isSymbolicLink()) { aliases.push(rel); continue; }
        if (stat.isDirectory()) {
          directories.push(rel);
          if (NATIVE_SCOPE.test(fold(rel))) { nativeOwners.push(rel); continue; }
          await visit(rel, level + 1); continue;
        }
        if (!stat.isFile()) { aliases.push(rel); continue; }
        if (stat.nlink !== 1n) hardlinks.push(rel);
        files.push({ path: rel, size: Number(stat.size), identity: String(stat.dev) + ':' + String(stat.ino),
          mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
      }
    }
    await visit('', 1);
    return { files, directories, aliases, hardlinks, nativeOwners, unreadable, truncated, entries, depth };
  }
  async function readSmall(file, maximum) {
    let stat; try { stat = await io.lstat(file); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('record_invalid', { file: p.basename(file) });
    const bytes = await io.readFile(file);
    if (bytes.length > maximum) fail('record_invalid', { file: p.basename(file) });
    return bytes;
  }
  async function activePointer(base, directories) {
    const bytes = await readSmall(p.join(base, '.work-data', 'active-v1.json'), 4096);
    if (!bytes) return { present: false, active: null };
    return { present: true, active: WorkDataTree.rootScope.activeOf([{ path: '.work-data/active-v1.json', data: bytes }], directories) };
  }
  function contributors(files, directories) {
    const groups = new Map();
    const keyOf = relative => {
      const parts = relative.split('/'), folded = fold(relative);
      if (/^\.work-data\/generations\/[a-f0-9]{48}\//.test(folded)) return parts.slice(0, 4).join('/');
      return parts[0];
    };
    for (const name of directories) { const id = keyOf(name); if (!groups.has(id)) groups.set(id, { path: id, files: 0, directories: 0, bytes: 0 }); groups.get(id).directories++; }
    for (const row of files) { const id = keyOf(row.path); if (!groups.has(id)) groups.set(id, { path: id, files: 0, directories: 0, bytes: 0 }); const g = groups.get(id); g.files++; g.bytes += row.size; }
    return [...groups.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files || (a.path < b.path ? -1 : 1)).slice(0, 8).map(value => Object.freeze(value));
  }
  const verdict = (code, severity, action, params) => Object.freeze({ code: 'work_data_hygiene.' + code, severity, action, params: Object.freeze(params) });
  const listed = rows => Object.freeze(rows.slice(0, LIST));

  // Pre-operation estimate. Verdicts carry stable codes, numeric params and the
  // largest areas so the UI can say what is too large, where, and what to do.
  async function inspect({ base, maxEntries } = {}) {
    base = await realBase(base);
    const B = WorkDataTree.NATIVE_BUDGET, R = WorkDataRecovery.LIMITS, limit = maxEntries || B.entries * 2;
    const found = await walk(base, { maxEntries: limit });
    const pointer = await activePointer(base, found.directories);
    const scoped = WorkDataTree.rootScope.partition(found.files, found.directories, { active: pointer.active, listLimit: 200 });
    const censusBytes = found.files.reduce((sum, row) => sum + row.size, 0), largest = contributors(found.files, found.directories);
    const entries = found.files.length + found.directories.length + 1, largestFile = found.files.reduce((top, row) => row.size > top.size ? row : top, { size: 0, path: null });
    const verdicts = [];
    const over = (code, actual, maximum, extra = {}) => { if (actual > maximum) verdicts.push(verdict(code, 'blocking', 'reduce', { actual, limit: maximum, largest, ...extra })); };
    if (found.truncated) verdicts.push(verdict('inventory_truncated', 'blocking', 'reduce', { actual: found.entries, limit, largest }));
    over('census_entries_exceeded', entries, B.entries);
    over('census_files_exceeded', found.files.length, B.files);
    over('census_directories_exceeded', found.directories.length, B.directories);
    over('census_bytes_exceeded', censusBytes, B.bytes);
    if (largestFile.size > B.fileBytes) verdicts.push(verdict('census_file_bytes_exceeded', 'blocking', 'reduce', { actual: largestFile.size, limit: B.fileBytes,
      paths: listed(found.files.filter(row => row.size > B.fileBytes).map(row => row.path)) }));
    over('census_depth_exceeded', found.depth, B.depth);
    over('package_files_exceeded', scoped.report.included.files, R.files);
    over('package_bytes_exceeded', scoped.report.included.bytes, R.bytes);
    // Package JSON carries base64 data inside base64 ciphertext (about 16/9).
    over('package_serialized_exceeded', Math.ceil(scoped.report.included.bytes * 16 / 9) + 1048576, R.serialized);
    if (found.aliases.length) verdicts.push(verdict('aliases_present', 'blocking', 'replace-alias', { count: found.aliases.length, paths: listed(found.aliases) }));
    if (found.hardlinks.length) verdicts.push(verdict('hardlinks_present', 'blocking', 'separate-hardlink', { count: found.hardlinks.length, paths: listed(found.hardlinks) }));
    if (found.unreadable.length) verdicts.push(verdict('unreadable_entries', 'blocking', 'fix-access', { count: found.unreadable.length, paths: listed(found.unreadable.map(row => row.path)) }));
    if (pointer.present && !pointer.active) verdicts.push(verdict('active_pointer_invalid', 'blocking', 'recover', {}));
    const leftovers = scoped.report.leftovers, superseded = leftovers.filter(row => row.area === 'superseded'), active = leftovers.filter(row => row.area !== 'superseded');
    const activeCount = scoped.report.leftoverCount - scoped.report.supersededLeftovers;
    if (activeCount > 0) verdicts.push(verdict('leftovers_present', 'advice', 'quarantine', { count: activeCount,
      bytes: active.reduce((sum, row) => sum + row.bytes, 0), paths: listed(active.map(row => row.path)) }));
    // 150 W4: a superseded plain root keeps its own crash leftovers in place
    // after enable (e.g. config.json.corrupt-<ts> with provider keys): never
    // silent. They can be quarantined like any other leftover.
    if (scoped.report.supersededLeftovers > 0) verdicts.push(verdict('superseded_leftovers_present', 'advice', 'quarantine', { count: scoped.report.supersededLeftovers,
      bytes: superseded.reduce((sum, row) => sum + row.bytes, 0), paths: listed(superseded.map(row => row.path)) }));
    const areas = (await quarantineAreas(base, found.directories)).map(row => Object.freeze({ root: row.root, stamp: row.stamp, state: row.state, plaintext: row.plaintext }));
    const brief = rows => Object.freeze(rows.slice(0, LIST).map(row => Object.freeze({ root: row.root, stamp: row.stamp, state: row.state })));
    const unfinished = areas.filter(row => ['moving', 'partial', 'partially-restored', 'incomplete'].includes(row.state));
    if (unfinished.length) verdicts.push(verdict('quarantine_incomplete', 'advice', unfinished.every(row => row.state === 'incomplete') ? 'quarantine' : 'undo-quarantine',
      { count: unfinished.length, areas: brief(unfinished) }));
    const unreadable = areas.filter(row => ['invalid', 'unknown', 'alias'].includes(row.state));
    if (unreadable.length) verdicts.push(verdict('quarantine_record_invalid', 'advice', 'recover', { count: unreadable.length, areas: brief(unreadable) }));
    // 150 W4: quarantine moves superseded plaintext but does not make it go away.
    const plaintext = areas.filter(row => row.plaintext > 0);
    if (plaintext.length) verdicts.push(verdict('quarantined_plaintext_present', 'advice', 'delete-manually', { count: plaintext.reduce((sum, row) => sum + row.plaintext, 0),
      areas: Object.freeze(plaintext.slice(0, LIST).map(row => Object.freeze({ root: row.root, stamp: row.stamp, path: areaOf(row.root, row.stamp) }))) }));
    return Object.freeze({ schema: 1, ok: !verdicts.some(row => row.severity === 'blocking'), verdicts: Object.freeze(verdicts),
      census: Object.freeze({ files: found.files.length, directories: found.directories.length, entries, bytes: censusBytes, largestFileBytes: largestFile.size,
        nativeOwnerRoots: Object.freeze([...found.nativeOwners]), largest: Object.freeze(largest) }),
      budget: Object.freeze({ census: Object.freeze({ files: B.files, directories: B.directories, entries: B.entries, bytes: B.bytes, fileBytes: B.fileBytes, depth: B.depth }),
        package: Object.freeze({ files: R.files, bytes: R.bytes, serialized: R.serialized }) }),
      scope: scoped.report, quarantine: Object.freeze(areas) });
  }

  // ---- W4: leftover quarantine --------------------------------------------
  // Manifest paths are data from disk: validated before any use.
  const SEGMENT_BAD = /[\x00-\x1f\\:*?"<>|]/;
  function safeRelative(value, { maximum = 1024 } = {}) {
    if (typeof value !== 'string' || !value || value.length > maximum || value.startsWith('/') || value.endsWith('/')) return false;
    return value.split('/').every(part => part && part !== '.' && part !== '..' && !SEGMENT_BAD.test(part) && !/[. ]$/.test(part));
  }
  // Every existing directory from the base down to the parent of `relative`
  // must be a real directory (no junction/symlink) whose realpath is lexical.
  async function assertNoAlias(base, relative) {
    const parts = relative.split('/'); parts.pop();
    let cursor = base;
    for (const part of parts) {
      cursor = p.join(cursor, part);
      let stat; try { stat = await io.lstat(cursor); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
      if (stat.isSymbolicLink() || !stat.isDirectory() || fold(p.resolve(await io.realpath(cursor))) !== fold(cursor)) fail('quarantine_alias', { path: relative });
    }
  }
  const areaOf = (root, stamp) => (root ? root + '/' : '') + 'quarantine-v1/' + stamp;
  function manifestValue(value, { root, stamp }) {
    if (!value || typeof value !== 'object' || value.schema !== 1 || value.stamp !== stamp || value.root !== root
      || !['moving', 'moved', 'rolled-back', 'partial', 'restored', 'partially-restored'].includes(value.state) || !Array.isArray(value.items) || value.items.length > 400000) fail('record_invalid');
    const seen = new Set();
    for (const item of value.items) {
      if (!item || typeof item !== 'object' || !safeRelative(item.from) || !safeRelative(item.to) || !Number.isSafeInteger(item.size) || item.size < 0
        || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || typeof item.reason !== 'string' || !['active', 'superseded'].includes(item.area)) fail('record_invalid');
      // from is base-relative inside this root; to is its logical path there.
      const prefix = root ? root + '/' : '';
      if (fold(item.from) !== fold(prefix + item.to) || fold(item.to) === 'quarantine-v1' || fold(item.to).startsWith('quarantine-v1/')
        || fold(item.to) === '.work-data' || fold(item.to).startsWith('.work-data/') || seen.has(fold(item.from))) fail('record_invalid');
      // A restore target must be what this policy would quarantine: never skills/, uploads/, a skill-backup scope or control.
      if (WorkDataTree.rootScope.classify(item.from, { base: true })?.class !== 'leftover') fail('record_invalid');
      seen.add(fold(item.from));
    }
    return value;
  }
  // tornCode: what an empty or unparsable manifest reports. Only areaState asks for
  // 'manifest_torn' (the one shape the sweep may remove); every other caller keeps record_invalid.
  async function readManifest(base, root, stamp, tornCode = 'record_invalid') {
    const bytes = await readSmall(p.join(at(base, areaOf(root, stamp)), 'manifest-v1.json'), 64 * 1024 * 1024);
    if (!bytes) return null;
    if (!bytes.length) fail(tornCode);
    let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(tornCode); }
    return manifestValue(value, { root, stamp });
  }
  const quarantineRoot = root => (root ? root + '/' : '') + 'quarantine-v1';
  const realDir = async file => { try { const stat = await io.lstat(file); return stat.isDirectory() && !stat.isSymbolicLink() && fold(p.resolve(await io.realpath(file))) === fold(file); } catch { return false; } };
  // One area, read without following any alias. torn: an unparsable manifest.
  async function areaState(base, root, stamp) {
    const rel = areaOf(root, stamp), dir = at(base, rel);
    try { await assertNoAlias(base, rel + '/manifest-v1.json'); } catch { return { state: 'alias' }; }
    if (!await realDir(dir)) return { state: 'alias' };
    // torn: empty or unparsable (a crash inside writeNew). A manifest that parses but fails
    // validation, or a read that fails (EBUSY/EACCES under antivirus), is not torn: it may be a live
    // record another quarantine call is writing, so it is reported invalid and never swept.
    let value = null, torn = false, unreadable = false;
    try { value = await readManifest(base, root, stamp, 'manifest_torn'); }
    catch (error) { if (error && error.code === 'work_data_hygiene.manifest_torn') torn = true; else unreadable = true; }
    let names; try { names = await io.readdir(dir); } catch { return { state: 'unknown' }; }
    if (value) {
      let plaintext = 0;
      if (!['restored', 'rolled-back'].includes(value.state)) for (const item of value.items) {
        if (item.area !== 'superseded') continue;
        try { const stat = await io.lstat(at(dir, 'data/' + item.to)); if (stat.isFile()) plaintext++; } catch { /* moved back or gone */ }
      }
      return { state: value.state, plaintext };
    }
    const data = names.some(name => fold(name) === 'data');
    if (unreadable) return { state: 'invalid' };
    if (!data && (names.length === 0 || torn && names.length === 1 && fold(names[0]) === 'manifest-v1.json')) return { state: 'incomplete', torn };
    return { state: torn ? 'invalid' : 'unknown' };
  }
  // Existing areas under the base and every generation root seen by a walk.
  async function quarantineAreas(base, directories) {
    const roots = ['', ...directories.filter(name => GENERATION_ROOT.test(fold(name)))], rows = [];
    for (const root of roots) {
      const rel = quarantineRoot(root), dir = at(base, rel);
      try { await io.lstat(dir); } catch { continue; }
      let ancestors = true; try { await assertNoAlias(base, rel + '/x'); } catch { ancestors = false; }
      if (!ancestors || !await realDir(dir)) { rows.push({ root, stamp: null, state: 'alias', plaintext: 0 }); continue; }
      let names; try { names = await io.readdir(dir); } catch { rows.push({ root, stamp: null, state: 'unknown', plaintext: 0 }); continue; }
      for (const stamp of names.sort()) {
        if (!STAMP.test(stamp)) continue;
        const row = await areaState(base, root, stamp);
        rows.push({ root, stamp, state: row.state, plaintext: row.plaintext || 0, torn: row.torn === true });
      }
    }
    return rows;
  }
  // Aliases at or below any quarantine-v1 (base or generation) block quarantine.
  const quarantineAlias = name => { const logical = fold(name).replace(/^\.work-data\/generations\/[a-f0-9]{48}\//, ''); return logical === 'quarantine-v1' || logical.startsWith('quarantine-v1/'); };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (cause) { return cause.code === 'EPERM'; } };
  async function quarantinePlanFor(base, { now = Date.now(), isAlive = alive } = {}) {
    const found = await walk(base);
    if (found.truncated) fail('inventory_truncated');
    const quarantineAliases = found.aliases.filter(quarantineAlias);
    if (quarantineAliases.length) fail('quarantine_alias', { paths: quarantineAliases.slice(0, LIST) });
    const pointer = await activePointer(base, found.directories);
    const scoped = WorkDataTree.rootScope.partition(found.files, found.directories, { active: pointer.active, listLimit: Infinity });
    const byPath = new Map(found.files.map(row => [row.path, row])), hardlinks = new Set(found.hardlinks), items = [], skipped = [];
    for (const leftover of scoped.report.leftovers) {
      const row = byPath.get(leftover.path);
      if (leftover.directory || !row) { skipped.push(Object.freeze({ path: leftover.path, reason: 'directory' })); continue; }
      if (hardlinks.has(row.path)) { skipped.push(Object.freeze({ path: row.path, reason: 'hardlink' })); continue; }
      const age = now - Number(BigInt(row.mtimeNs) / 1000000n);
      if (leftover.reason === 'crash-stage') {
        const pid = Number(STAGE_PID.exec(p.posix.basename(row.path))?.[1]);
        if (!Number.isSafeInteger(pid) || pid < 1 || isAlive(pid)) { skipped.push(Object.freeze({ path: row.path, reason: 'writer-alive' })); continue; }
      }
      if (age < QUIET_MS) { skipped.push(Object.freeze({ path: row.path, reason: 'too-recent' })); continue; }
      const generation = /^(\.work-data\/generations\/[a-f0-9]{48})\//i.exec(row.path);
      const root = generation ? generation[1] : '', logical = generation ? row.path.slice(generation[1].length + 1) : row.path;
      if (!safeRelative(row.path) || !safeRelative(logical)) { skipped.push(Object.freeze({ path: row.path, reason: 'name' })); continue; }
      items.push(Object.freeze({ path: row.path, root, logical, size: row.size, identity: row.identity, mtimeNs: row.mtimeNs, ctimeNs: row.ctimeNs,
        reason: leftover.reason, area: leftover.area }));
    }
    const token = hash(JSON.stringify(items.map(row => [row.path, row.size, row.identity, row.mtimeNs, row.ctimeNs])));
    return { items, skipped, token, directories: found.directories };
  }
  function rootsOf(items) {
    const roots = new Map();
    for (const row of items) { if (!roots.has(row.root)) roots.set(row.root, []); roots.get(row.root).push(row); }
    return [...roots.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  }
  async function planQuarantine({ base, now, isAlive } = {}) {
    base = await realBase(base);
    const plan = await quarantinePlanFor(base, { now, isAlive });
    return Object.freeze({ schema: 1, token: plan.token, files: plan.items.length, bytes: plan.items.reduce((sum, row) => sum + row.size, 0),
      roots: Object.freeze(rootsOf(plan.items).map(([root, rows]) => Object.freeze({ root, files: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) }))),
      items: Object.freeze(plan.items.map(row => Object.freeze({ path: row.path, root: row.root, reason: row.reason, area: row.area, bytes: row.size }))),
      skipped: Object.freeze(plan.skipped) });
  }
  async function same(file, row) {
    const stat = await io.lstat(file, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && String(stat.dev) + ':' + String(stat.ino) === row.identity
      && Number(stat.size) === row.size && String(stat.mtimeNs) === row.mtimeNs && String(stat.ctimeNs) === row.ctimeNs;
  }
  async function fileSha(file) { const digest = c.createHash('sha256'); for await (const part of require('node:fs').createReadStream(file)) digest.update(part); return digest.digest('hex'); }
  async function absent(file) { try { await io.lstat(file); return false; } catch (cause) { if (cause.code === 'ENOENT') return true; throw cause; } }
  async function writeNew(file, value) {
    const handle = await io.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  }
  // Manifest state changes reuse the shared atomic JSON writer.
  const replaceJson = (file, value) => atomicWriteJson(file, value);
  const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + c.randomBytes(4).toString('hex');
  // Crash-incomplete areas (empty, or only a torn manifest and no data) are
  // removed: every path is alias-checked first, the torn manifest is unlinked
  // only as a regular single-link file, and rmdir refuses anything non-empty.
  async function sweepIncomplete(base, directories) {
    for (const row of await quarantineAreas(base, directories)) {
      if (row.state !== 'incomplete') continue;
      const rel = areaOf(row.root, row.stamp), dir = at(base, rel);
      try {
        await assertNoAlias(base, rel + '/manifest-v1.json');
        if (!await realDir(dir)) continue;
        if (row.torn) {
          const manifest = p.join(dir, 'manifest-v1.json'), stat = await io.lstat(manifest);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
          await io.unlink(manifest);
        }
        await io.rmdir(dir);
      } catch { /* not empty, busy or aliased: left, still reported by inspect */ }
    }
  }
  // Nothing is deleted: each leftover is renamed (same volume) under
  // <root>/quarantine-v1/<stamp>/data/ with a manifest naming its origin and hash.
  async function quarantine({ base, token, now, isAlive } = {}) {
    base = await realBase(base);
    const plan = await quarantinePlanFor(base, { now, isAlive });
    if (typeof token !== 'string' || token !== plan.token) fail('plan_changed');
    await sweepIncomplete(base, plan.directories);
    if (!plan.items.length) return Object.freeze({ schema: 1, moved: 0, stamp: null, areas: Object.freeze([]) });
    const stamp = stampNow(), groups = rootsOf(plan.items), runs = [];
    // Hash first (nothing moved yet), then one manifest per root area.
    for (const [root, rows] of groups) {
      const area = at(base, areaOf(root, stamp)), entries = [];
      for (const row of rows) {
        await assertNoAlias(base, row.path);
        entries.push({ from: row.path, to: row.logical, size: row.size, sha256: await fileSha(at(base, row.path)), reason: row.reason, area: row.area });
      }
      runs.push({ root, rows, area, entries, manifest: p.join(area, 'manifest-v1.json'), value: { schema: 1, stamp, root, state: 'moving', items: entries } });
    }
    const moved = [], started = [];
    try {
      for (const run of runs) {
        await assertNoAlias(base, areaOf(run.root, stamp) + '/manifest-v1.json');
        await io.mkdir(run.area, { recursive: true });
        await writeNew(run.manifest, run.value); started.push(run);
        for (const [index, row] of run.rows.entries()) {
          const from = at(base, row.path), to = at(run.area, 'data/' + row.logical);
          await assertNoAlias(base, row.path);
          if (!await same(from, row) || await fileSha(from) !== run.entries[index].sha256) fail('plan_changed', { path: row.path });
          await io.mkdir(p.dirname(to), { recursive: true });
          await assertNoAlias(base, areaOf(run.root, stamp) + '/data/' + row.logical);
          if (!await absent(to)) fail('quarantine_conflict', { path: row.path });
          await io.rename(from, to); moved.push({ from, to, run });
        }
      }
    } catch (cause) {
      const stuck = [];
      for (const item of moved.reverse()) { try { if (await absent(item.from)) await io.rename(item.to, item.from); else stuck.push(item); } catch { stuck.push(item); } }
      for (const run of started) {
        const partial = stuck.some(item => item.run === run);
        await replaceJson(run.manifest, { ...run.value, state: partial ? 'partial' : 'rolled-back' }).catch(() => {});
      }
      if (stuck.length) fail('quarantine_recovery_required', { stamp }, cause);
      throw cause;
    }
    for (const run of runs) await replaceJson(run.manifest, { ...run.value, state: 'moved' });
    return Object.freeze({ schema: 1, moved: moved.length, stamp,
      areas: Object.freeze(runs.map(run => Object.freeze({ root: run.root, area: areaOf(run.root, stamp), files: run.rows.length }))) });
  }
  async function undoQuarantine({ base, stamp, root = '' } = {}) {
    base = await realBase(base);
    if (typeof stamp !== 'string' || !STAMP.test(stamp) || typeof root !== 'string' || root && !GENERATION_ROOT.test(root)) fail('request_invalid');
    const areaRelative = areaOf(root, stamp), area = at(base, areaRelative), manifest = p.join(area, 'manifest-v1.json');
    await assertNoAlias(base, areaRelative + '/manifest-v1.json');
    const value = await readManifest(base, root, stamp); if (!value) fail('quarantine_unknown');
    let restored = 0; const kept = [];
    for (const item of value.items) {
      const from = at(base, item.from), to = at(area, 'data/' + item.to);
      await assertNoAlias(base, item.from); await assertNoAlias(base, areaRelative + '/data/' + item.to);
      if (await absent(to)) continue;
      const stat = await io.lstat(to);
      if (!stat.isFile() || stat.isSymbolicLink() || !await absent(from) || await fileSha(to) !== item.sha256) { kept.push(item.from); continue; }
      await io.mkdir(p.dirname(from), { recursive: true }); await assertNoAlias(base, item.from); await io.rename(to, from); restored++;
    }
    await replaceJson(manifest, { ...value, state: kept.length ? 'partially-restored' : 'restored' });
    return Object.freeze({ schema: 1, restored, kept: Object.freeze(kept) });
  }
  return Object.freeze({ inspect, planQuarantine, quarantine, undoQuarantine });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
