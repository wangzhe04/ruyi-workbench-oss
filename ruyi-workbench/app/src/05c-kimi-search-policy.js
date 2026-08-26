// Narrow ACP fast-path policy for Kimi 0.37.x native Glob/Grep ripgrep calls.
//
// This fragment is deliberately a classifier only. It never spawns, never asks for permission, and never
// decides whether a terminal operation is allowed. 05b may call it before its ordinary terminal permission
// path so an exact, read-only native search can remain usable while Ruyi is in plan mode. Any non-match must
// continue through 05b's existing manual/plan denial path; it must not widen terminal execution.
//
// Contract:
//   async classifyKimiAcpReadonlySearch({ command, args, cwd, env }, { session, config, reg, ... })
//     -> { ok:true, command:<canonical trusted rg>, args:<canonical argv>, cwd:<canonical read path>,
//          env:<safe overrides> }
//     -> { ok:false, reason:<stable diagnostic> }
//
// The argv allowlist below is based on the Kimi 0.37.2 buildRgArgs/buildRgArgs$1 implementations. Keep this
// fragment before any future consumer that calls the classifier, and do not turn it into a general terminal
// parser: the narrow shape is the safety boundary.

const KIMI_ACP_SEARCH_MAX_ARGS = 128;
const KIMI_ACP_SEARCH_MAX_ARG_LENGTH = 32768;
const KIMI_ACP_SEARCH_MAX_COMMAND_LENGTH = 4096;
const KIMI_ACP_SEARCH_MAX_GLOBS = 64;
const KIMI_ACP_SEARCH_MAX_SEARCH_PATHS = 32;
const KIMI_ACP_SEARCH_MAX_PATTERN_LENGTH = 16384;
const KIMI_ACP_SEARCH_MAX_TYPE_LENGTH = 128;
const KIMI_ACP_SEARCH_MAX_CONTEXT_LINES = 1000;
const KIMI_ACP_SEARCH_RG_MAX_COLUMNS = 500;

const KIMI_ACP_SEARCH_VCS_GLOBS = Object.freeze([
  '!.git', '!.svn', '!.hg', '!.bzr', '!.jj', '!.sl',
]);
const KIMI_ACP_SEARCH_SENSITIVE_GLOBS = Object.freeze([
  '**/.env',
  '**/id_rsa', '**/id_rsa[-_]*', '**/id_rsa.bak', '**/id_rsa.backup', '**/id_rsa.copy', '**/id_rsa.disabled', '**/id_rsa.key', '**/id_rsa.old', '**/id_rsa.orig', '**/id_rsa.pem', '**/id_rsa.save', '**/id_rsa.tmp',
  '**/id_ed25519', '**/id_ed25519[-_]*', '**/id_ed25519.bak', '**/id_ed25519.backup', '**/id_ed25519.copy', '**/id_ed25519.disabled', '**/id_ed25519.key', '**/id_ed25519.old', '**/id_ed25519.orig', '**/id_ed25519.pem', '**/id_ed25519.save', '**/id_ed25519.tmp',
  '**/id_ecdsa', '**/id_ecdsa[-_]*', '**/id_ecdsa.bak', '**/id_ecdsa.backup', '**/id_ecdsa.copy', '**/id_ecdsa.disabled', '**/id_ecdsa.key', '**/id_ecdsa.old', '**/id_ecdsa.orig', '**/id_ecdsa.pem', '**/id_ecdsa.save', '**/id_ecdsa.tmp',
  '**/.aws/credentials', '**/.aws/credentials/**',
  '**/.gcp/credentials', '**/.gcp/credentials/**',
]);
const KIMI_ACP_SEARCH_SAFE_ENV_OVERRIDES = Object.freeze({
  // The flag is the primary guard. Empty overrides prevent an inherited config path from re-entering through
  // the explicitly merged child environment used by the eventual 05b/Turing integration.
  RIPGREP_CONFIG_PATH: '',
  RG_CONFIG_PATH: '',
});
const KIMI_ACP_SEARCH_BLOCKED_ENV_RE = /^(?:PATH|PATHEXT|COMSPEC|SHELL|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]*|RIPGREP_CONFIG_PATH|RG_CONFIG_PATH|RIPGREP_CONFIG|RUSTC_WRAPPER|RUSTFLAGS|GIT_CONFIG(?:_[A-Z0-9_]+)?|GIT_ASKPASS|GIT_SSH(?:_COMMAND)?|NODE_OPTIONS|NODE_PATH|PYTHONPATH)$/i;

function kimiAcpSearchDeny(code, detail) {
  const suffix = detail ? `: ${String(detail)}` : '';
  return { ok: false, reason: `kimi-readonly-search-${String(code)}${suffix}` };
}

function kimiAcpSearchIsObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function kimiAcpSearchPathEqual(left, right) {
  const a = path.resolve(String(left || ''));
  const b = path.resolve(String(right || ''));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function kimiAcpSearchWithin(target, root) {
  try {
    if (typeof pathWithinRoot === 'function') return pathWithinRoot(target, root);
    const relative = path.relative(root, target);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  } catch { return false; }
}

function kimiAcpSearchRgName() {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function kimiAcpSearchIsRgName(raw) {
  const name = path.basename(String(raw || ''));
  return process.platform === 'win32' ? name.toLowerCase() === 'rg.exe' : name === 'rg';
}

function kimiAcpSearchValidateText(value, label, maxLength, allowEmpty = false) {
  if (typeof value !== 'string') return kimiAcpSearchDeny('invalid-text', `${label} must be a string`);
  if (!allowEmpty && value.length === 0) return kimiAcpSearchDeny('invalid-text', `${label} is empty`);
  if (value.length > maxLength) return kimiAcpSearchDeny('length', `${label} exceeds ${maxLength}`);
  if (value.includes('\0')) return kimiAcpSearchDeny('nul', `${label} contains NUL`);
  return null;
}

function kimiAcpSearchValidateGlob(value) {
  const invalid = kimiAcpSearchValidateText(value, '--glob value', KIMI_ACP_SEARCH_MAX_ARG_LENGTH);
  if (invalid) return invalid;
  if (/[\r\n]/.test(value)) return kimiAcpSearchDeny('invalid-glob', 'line breaks are not accepted in --glob values');
  return null;
}

function kimiAcpSearchUnique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function kimiAcpSearchParseBoundedInteger(value, label, max) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return { error: kimiAcpSearchDeny('invalid-number', `${label} must be a non-negative decimal integer`) };
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) {
    return { error: kimiAcpSearchDeny('range', `${label} must be between 0 and ${max}`) };
  }
  return { value: number };
}

function kimiAcpSearchNormalizeInputEnv(rawEnv) {
  if (rawEnv == null) return { ok: true };
  let entries;
  if (Array.isArray(rawEnv)) {
    if (rawEnv.length > 64) return kimiAcpSearchDeny('env-count', 'too many environment entries');
    entries = rawEnv.map((row, index) => {
      if (!kimiAcpSearchIsObject(row)) return { error: kimiAcpSearchDeny('invalid-env', `env[${index}] must be an object`) };
      return { name: row.name, value: row.value };
    });
  } else if (kimiAcpSearchIsObject(rawEnv)) {
    const keys = Object.keys(rawEnv);
    if (keys.length > 64) return kimiAcpSearchDeny('env-count', 'too many environment entries');
    entries = keys.map(name => ({ name, value: rawEnv[name] }));
  } else {
    return kimiAcpSearchDeny('invalid-env', 'env must be an object or ACP name/value array');
  }
  const seen = new Set();
  for (const row of entries) {
    if (row && row.error) return row.error;
    if (typeof row.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name)) {
      return kimiAcpSearchDeny('invalid-env', 'environment name is invalid');
    }
    if (typeof row.value !== 'string' || row.value.length > KIMI_ACP_SEARCH_MAX_ARG_LENGTH || row.value.includes('\0')) {
      return kimiAcpSearchDeny('invalid-env', `environment value for ${row.name} is invalid`);
    }
    const key = row.name.toUpperCase();
    if (seen.has(key)) return kimiAcpSearchDeny('invalid-env', `duplicate environment name ${row.name}`);
    seen.add(key);
    // Do not pass caller-provided environment through. These names are rejected explicitly because even a
    // later safe merge must not let them select a different executable, loader, shell, or ripgrep config.
    if (KIMI_ACP_SEARCH_BLOCKED_ENV_RE.test(row.name)) return kimiAcpSearchDeny('unsafe-env', row.name);
  }
  return { ok: true };
}

async function kimiAcpSearchRealFile(rawPath) {
  const value = String(rawPath || '');
  if (!path.isAbsolute(value)) return null;
  let canonical;
  try { canonical = await realpathForContainment(value); } catch { return null; }
  if (!canonical || !path.isAbsolute(canonical)) return null;
  let stat;
  try { stat = await fsp.stat(canonical); } catch { return null; }
  if (!stat || !stat.isFile()) return null;
  // A Unix rg must be executable. Windows executable permission is represented by the .exe suffix and not
  // by the POSIX mode bits exposed by Node, so the platform-specific check stays deliberately small.
  if (process.platform !== 'win32' && typeof stat.mode === 'number' && (stat.mode & 0o111) === 0) return null;
  return path.resolve(canonical);
}

async function kimiAcpSearchCanonicalRoot(rawRoot) {
  const value = String(rawRoot || '');
  if (!value || !path.isAbsolute(value)) return null;
  try {
    const canonical = await realpathForContainment(value);
    return canonical && path.isAbsolute(canonical) ? path.resolve(canonical) : null;
  } catch { return null; }
}

async function kimiAcpSearchDeniedRoots(context) {
  const roots = [];
  const add = value => { if (typeof value === 'string' && value.trim()) roots.push(value.trim()); };
  const session = context && context.session;
  const config = context && context.config;
  if (typeof fileAllowedRoots === 'function') {
    try { for (const value of fileAllowedRoots(session, config)) add(value); } catch { /* explicit roots below */ }
  }
  add(session && session.cwd);
  add(config && config.defaultWorkspace);
  for (const value of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) add(value);
  for (const row of (config && Array.isArray(config.workspaces) ? config.workspaces : [])) add(row && row.path);
  if (typeof dataRoot === 'function') {
    try { add(dataRoot()); } catch { /* fail-closed at the data-root check */ }
  }
  const out = [];
  const seen = new Set();
  for (const raw of roots) {
    const canonical = await kimiAcpSearchCanonicalRoot(raw);
    if (!canonical) continue;
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

async function kimiAcpSearchVendorRg(context) {
  if (typeof appRoot !== 'function') return null;
  let root;
  try { root = appRoot(); } catch { return null; }
  const appRootRaw = path.resolve(String(root || ''));
  const appRootCanonical = await kimiAcpSearchCanonicalRoot(appRootRaw);
  if (!appRootCanonical) return null;
  const vendorRootRaw = path.join(appRootRaw, 'vendor-bin');
  // A vendored exception is only valid when vendor-bin is a real directory directly anchored under the
  // canonical appRoot. A junction/symlink from appRoot/vendor-bin into a workspace must not become a trust
  // escape hatch, even when the final rg file itself has a plausible basename.
  let vendorRootStat;
  try { vendorRootStat = await fsp.lstat(vendorRootRaw); } catch { return null; }
  if (!vendorRootStat || !vendorRootStat.isDirectory() || vendorRootStat.isSymbolicLink()) return null;
  const vendorRoot = await kimiAcpSearchCanonicalRoot(vendorRootRaw);
  if (!vendorRoot || !kimiAcpSearchWithin(vendorRoot, appRootCanonical)
    || path.basename(vendorRoot).toLowerCase() !== 'vendor-bin') return null;
  const vendorPath = path.join(vendorRootRaw, kimiAcpSearchRgName());
  let vendorFileStat;
  try { vendorFileStat = await fsp.lstat(vendorPath); } catch { return null; }
  if (!vendorFileStat || !vendorFileStat.isFile() || vendorFileStat.isSymbolicLink()) return null;
  const canonical = await kimiAcpSearchRealFile(vendorPath);
  if (!canonical) return null;
  const expected = path.join(vendorRoot, kimiAcpSearchRgName());
  return kimiAcpSearchPathEqual(canonical, expected) ? canonical : null;
}

async function kimiAcpSearchKimiCacheRg() {
  let home = '';
  try { home = String(process.env.KIMI_CODE_HOME || '').trim() || path.join(os.homedir(), '.kimi-code'); } catch { return null; }
  return path.resolve(path.join(home, 'bin', kimiAcpSearchRgName()));
}

async function kimiAcpSearchPathRgCandidates() {
  const rawPath = String(process.env.PATH || process.env.Path || '');
  const dirs = rawPath.split(path.delimiter);
  const candidates = [];
  const seen = new Set();
  for (const rawDir of dirs) {
    const dir = String(rawDir || '').trim().replace(/^"|"$/g, '');
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, kimiAcpSearchRgName());
    const key = process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try { stat = await fsp.stat(candidate); } catch { continue; }
    if (!stat || !stat.isFile()) continue;
    candidates.push(candidate);
  }
  return candidates;
}

async function kimiAcpSearchResolveTrustedRg(rawCommand, context) {
  const command = String(rawCommand || '');
  const name = kimiAcpSearchRgName();
  if (!command || command.trim() !== command || command.includes('\0')) return kimiAcpSearchDeny('command', 'command spelling is invalid');
  const isBare = command === name || command.toLowerCase() === 'rg';
  if (!isBare && !path.isAbsolute(command)) return kimiAcpSearchDeny('command', 'only an absolute rg or the bare rg name is accepted');
  if (!isBare && !kimiAcpSearchIsRgName(command)) return kimiAcpSearchDeny('command', 'shell wrappers and non-rg executables are rejected');

  const deniedRoots = await kimiAcpSearchDeniedRoots(context);
  const vendor = await kimiAcpSearchVendorRg(context);
  const ruyiOverride = String(process.env.RUYI_RG_PATH || '').trim();
  const cache = await kimiAcpSearchKimiCacheRg();

  const isDeniedByWorkspace = canonical => deniedRoots.some(root => kimiAcpSearchWithin(canonical, root));
  const accept = async (rawCandidate, source, allowVendor = false) => {
    const canonical = await kimiAcpSearchRealFile(rawCandidate);
    if (!canonical) return { kind: 'missing' };
    const isVendor = !!vendor && kimiAcpSearchPathEqual(canonical, vendor);
    if (isDeniedByWorkspace(canonical) && !(allowVendor || isVendor)) return { kind: 'blocked' };
    return { kind: 'accepted', source, path: canonical };
  };

  if (!isBare) {
    const direct = await kimiAcpSearchRealFile(command);
    const directIsVendor = !!vendor && direct && kimiAcpSearchPathEqual(direct, vendor);
    // Apply the workspace/extra-root deny before every absolute-path trust source. The only exception is the
    // strictly anchored appRoot/vendor-bin file returned above; an absolute PATH or RUYI_RG_PATH must not
    // bypass the same canonical boundary merely because its basename is rg.
    if (direct && isDeniedByWorkspace(direct) && !directIsVendor) {
      return kimiAcpSearchDeny('rg-in-workspace', 'canonical rg is inside a workspace or extra root');
    }
    if (direct && directIsVendor) return direct;
    if (direct && ruyiOverride && path.isAbsolute(ruyiOverride)) {
      const override = await kimiAcpSearchRealFile(ruyiOverride);
      if (override && kimiAcpSearchPathEqual(direct, override)) return direct;
    }
    for (const pathCandidate of await kimiAcpSearchPathRgCandidates()) {
      const canonicalPathCandidate = await kimiAcpSearchRealFile(pathCandidate);
      if (direct && canonicalPathCandidate && kimiAcpSearchPathEqual(direct, canonicalPathCandidate)) return direct;
    }
    if (cache && kimiAcpSearchPathEqual(path.resolve(command), cache)) return kimiAcpSearchDeny('unverified-kimi-rg', 'KIMI_CODE_HOME/bin/rg is not independently verified');
    return kimiAcpSearchDeny('rg-untrusted', 'absolute rg is not in Ruyi PATH, vendor-bin, or RUYI_RG_PATH');
  }

  // A bare command must resolve exactly as the Ruyi process would: the first existing absolute PATH entry
  // wins. If that entry is a workspace impostor, do not skip it and silently choose a later executable.
  for (const candidate of await kimiAcpSearchPathRgCandidates()) {
    const result = await accept(candidate, 'process-path');
    if (result.kind === 'accepted') return result.path;
    if (result.kind === 'blocked') return kimiAcpSearchDeny('rg-in-workspace', 'PATH rg resolves inside a workspace or extra root');
  }
  if (ruyiOverride && path.isAbsolute(ruyiOverride)) {
    const result = await accept(ruyiOverride, 'ruyi-env', false);
    if (result.kind === 'accepted') return result.path;
    if (result.kind === 'blocked') return kimiAcpSearchDeny('rg-in-workspace', 'RUYI_RG_PATH resolves inside a workspace or extra root');
  }
  if (vendor) return vendor;
  if (cache) {
    let cacheExists = false;
    try { cacheExists = (await fsp.stat(cache)).isFile(); } catch { /* unavailable */ }
    if (cacheExists) return kimiAcpSearchDeny('unverified-kimi-rg', 'KIMI_CODE_HOME/bin/rg is not independently verified');
  }
  return kimiAcpSearchDeny('rg-untrusted', 'no independently trusted absolute rg was found');
}

async function kimiAcpSearchDataRootInfo() {
  if (typeof dataRoot !== 'function') return { unavailable: true };
  let lexical;
  try { lexical = path.resolve(String(dataRoot() || '')); } catch { return { unavailable: true }; }
  if (!lexical || !path.isAbsolute(lexical)) return { unavailable: true };
  const canonical = await kimiAcpSearchCanonicalRoot(lexical);
  return { lexical, canonical: canonical || lexical };
}

function kimiAcpSearchIsControlPlaneRoot(candidate, dataInfo) {
  if (!dataInfo || dataInfo.unavailable) return true;
  const roots = [dataInfo.lexical, dataInfo.canonical].filter(Boolean);
  // A search directory that is an ancestor of dataRoot would let ripgrep traverse Ruyi's sessions/config/
  // memory/logs control plane. Safe dataRoot children such as uploads are still individually subject to the
  // normal read guard; the ancestor rule is the important fail-closed case.
  return roots.some(root => kimiAcpSearchWithin(root, candidate));
}

async function kimiAcpSearchCanonicalReadPath(rawPath, context, label, requireDirectory, dataInfo) {
  const text = kimiAcpSearchValidateText(rawPath, label, KIMI_ACP_SEARCH_MAX_COMMAND_LENGTH);
  if (text) return text;
  if (!path.isAbsolute(rawPath)) return kimiAcpSearchDeny('path', `${label} must be absolute`);
  if (typeof guardFileToolPath !== 'function') return kimiAcpSearchDeny('guard-unavailable', 'normal read guard is unavailable');
  let guard;
  try { guard = await guardFileToolPath(rawPath, context, { tool: 'kimi_acp_native_search', write: false }); }
  catch { return kimiAcpSearchDeny('guard-error', `${label} read guard failed`); }
  if (!guard || guard.ok !== true || typeof guard.absPath !== 'string') {
    return kimiAcpSearchDeny('path-denied', `${label} is outside the normal read guard`);
  }
  let canonical;
  try { canonical = await realpathForContainment(guard.absPath); } catch { return kimiAcpSearchDeny('path', `${label} cannot be canonicalized`); }
  if (!canonical || !path.isAbsolute(canonical)) return kimiAcpSearchDeny('path', `${label} canonical path is invalid`);
  if (typeof isSensitiveDataPath === 'function' && (isSensitiveDataPath(rawPath) || isSensitiveDataPath(canonical))) {
    return kimiAcpSearchDeny('sensitive-root', `${label} is Ruyi control-plane data`);
  }
  let stat;
  try { stat = await fsp.stat(canonical); } catch { return kimiAcpSearchDeny('path-missing', `${label} does not exist`); }
  if (!stat || (requireDirectory && !stat.isDirectory()) || (!requireDirectory && !stat.isDirectory() && !stat.isFile())) {
    return kimiAcpSearchDeny(requireDirectory ? 'not-directory' : 'not-searchable', `${label} is not searchable`);
  }
  if (stat.isDirectory() && kimiAcpSearchIsControlPlaneRoot(path.resolve(canonical), dataInfo)) {
    return kimiAcpSearchDeny('sensitive-root', `${label} would contain Ruyi control-plane data`);
  }
  return path.resolve(canonical);
}

function kimiAcpSearchAppendGlobArgs(out, values) {
  for (const value of values) out.push('--glob', value);
}

function kimiAcpSearchNegativeGlob(value) {
  const text = String(value || '');
  return text.startsWith('!') ? text : `!${text}`;
}

function kimiAcpSearchAppendNegativeGlobArgs(out, values) {
  for (const value of values) out.push('--glob', kimiAcpSearchNegativeGlob(value));
}

function kimiAcpSearchParseGlobArgs(args) {
  const state = { files: false, hidden: false, sorted: false, noIgnore: false, globs: [], noConfig: false, singleThreaded: false, finalDot: false };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '-j') {
      if (state.singleThreaded || args[++index] !== '1') return kimiAcpSearchDeny('unknown-option', '-j is allowed only as -j 1');
      state.singleThreaded = true;
    } else if (token === '--files') {
      if (state.files) return kimiAcpSearchDeny('duplicate-option', '--files');
      state.files = true;
    } else if (token === '--hidden') {
      if (state.hidden) return kimiAcpSearchDeny('duplicate-option', '--hidden');
      state.hidden = true;
    } else if (token === '--sortr=modified') {
      if (state.sorted) return kimiAcpSearchDeny('duplicate-option', '--sortr=modified');
      state.sorted = true;
    } else if (token === '--no-ignore') {
      if (state.noIgnore) return kimiAcpSearchDeny('duplicate-option', '--no-ignore');
      state.noIgnore = true;
    } else if (token === '--no-config') {
      if (state.noConfig) return kimiAcpSearchDeny('duplicate-option', '--no-config');
      state.noConfig = true;
    } else if (token === '--glob') {
      const value = args[++index];
      if (value === undefined) return kimiAcpSearchDeny('missing-value', '--glob');
      const invalid = kimiAcpSearchValidateGlob(value);
      if (invalid) return invalid;
      state.globs.push(value);
      if (state.globs.length > KIMI_ACP_SEARCH_MAX_GLOBS) return kimiAcpSearchDeny('glob-count', 'too many --glob values');
    } else if (token === '.') {
      if (state.finalDot || index !== args.length - 1) return kimiAcpSearchDeny('path', 'Glob must end with exactly one .');
      state.finalDot = true;
    } else {
      return kimiAcpSearchDeny('unknown-option', token);
    }
  }
  if (!state.files || !state.hidden || !state.sorted || !state.finalDot || state.globs.length === 0) {
    return kimiAcpSearchDeny('shape', 'not the Kimi native Glob argv shape');
  }
  return state;
}

function kimiAcpSearchParseGrepArgs(args) {
  const sentinel = args.indexOf('--');
  if (sentinel < 0) return kimiAcpSearchDeny('shape', 'Grep requires -- before pattern and paths');
  if (args.slice(sentinel + 1).includes('--')) return kimiAcpSearchDeny('path', 'Grep pattern/path section contains an extra --');
  if (sentinel + 2 > args.length - 1) return kimiAcpSearchDeny('shape', 'Grep requires a pattern and at least one search path');
  const state = {
    singleThreaded: false, hidden: false, nullOutput: false, maxColumns: null, noIgnore: false, noConfig: false,
    files: false, count: false, withFilename: false, insensitive: false, lineNumbers: false,
    fieldSeparator: false, after: null, before: null, context: null, globs: [], type: '', multiline: false,
  };
  const options = args.slice(0, sentinel);
  for (let index = 0; index < options.length; index++) {
    const token = options[index];
    if (token === '-j') {
      if (state.singleThreaded || options[++index] !== '1') return kimiAcpSearchDeny('unknown-option', '-j is allowed only as -j 1');
      state.singleThreaded = true;
    } else if (token === '--hidden') {
      if (state.hidden) return kimiAcpSearchDeny('duplicate-option', '--hidden');
      state.hidden = true;
    } else if (token === '--null') {
      if (state.nullOutput) return kimiAcpSearchDeny('duplicate-option', '--null');
      state.nullOutput = true;
    } else if (token === '--max-columns') {
      if (state.maxColumns !== null) return kimiAcpSearchDeny('duplicate-option', '--max-columns');
      const value = options[++index];
      if (value === undefined) return kimiAcpSearchDeny('missing-value', '--max-columns');
      const parsed = kimiAcpSearchParseBoundedInteger(value, '--max-columns', KIMI_ACP_SEARCH_RG_MAX_COLUMNS);
      if (parsed.error || parsed.value !== KIMI_ACP_SEARCH_RG_MAX_COLUMNS) return parsed.error || kimiAcpSearchDeny('range', '--max-columns must be 500');
      state.maxColumns = parsed.value;
    } else if (token === '--glob') {
      const value = options[++index];
      if (value === undefined) return kimiAcpSearchDeny('missing-value', '--glob');
      const invalid = kimiAcpSearchValidateGlob(value);
      if (invalid) return invalid;
      state.globs.push(value);
      if (state.globs.length > KIMI_ACP_SEARCH_MAX_GLOBS) return kimiAcpSearchDeny('glob-count', 'too many --glob values');
    } else if (token === '--type') {
      if (state.type) return kimiAcpSearchDeny('duplicate-option', '--type');
      const value = options[++index];
      const invalid = kimiAcpSearchValidateText(value, '--type value', KIMI_ACP_SEARCH_MAX_TYPE_LENGTH);
      if (invalid) return invalid;
      if (!/^[A-Za-z0-9_+.-]+$/.test(value)) return kimiAcpSearchDeny('invalid-type', '--type value contains unsupported characters');
      state.type = value;
    } else if (token === '-l') {
      if (state.files || state.count) return kimiAcpSearchDeny('mode', 'Grep output mode is ambiguous');
      state.files = true;
    } else if (token === '--count-matches') {
      if (state.files || state.count) return kimiAcpSearchDeny('mode', 'Grep output mode is ambiguous');
      state.count = true;
    } else if (token === '--with-filename') {
      if (state.withFilename) return kimiAcpSearchDeny('duplicate-option', '--with-filename');
      state.withFilename = true;
    } else if (token === '-i') {
      if (state.insensitive) return kimiAcpSearchDeny('duplicate-option', '-i');
      state.insensitive = true;
    } else if (token === '-n') {
      if (state.lineNumbers || state.fieldSeparator) return kimiAcpSearchDeny('content-format', 'Grep line-number format is ambiguous');
      state.lineNumbers = true;
    } else if (token === '--field-context-separator') {
      if (state.lineNumbers || state.fieldSeparator) return kimiAcpSearchDeny('content-format', 'Grep line-number format is ambiguous');
      if (options[++index] !== ':') return kimiAcpSearchDeny('content-format', '--field-context-separator must be :');
      state.fieldSeparator = true;
    } else if (token === '-A' || token === '-B' || token === '-C') {
      const value = options[++index];
      const parsed = kimiAcpSearchParseBoundedInteger(value, token, KIMI_ACP_SEARCH_MAX_CONTEXT_LINES);
      if (parsed.error) return parsed.error;
      if (token === '-C') {
        if (state.context !== null || state.after !== null || state.before !== null) return kimiAcpSearchDeny('context', 'Grep context flags are ambiguous');
        state.context = parsed.value;
      } else if (token === '-A') {
        if (state.context !== null || state.after !== null) return kimiAcpSearchDeny('context', 'duplicate -A or mixed -C context');
        state.after = parsed.value;
      } else {
        if (state.context !== null || state.before !== null) return kimiAcpSearchDeny('context', 'duplicate -B or mixed -C context');
        state.before = parsed.value;
      }
    } else if (token === '-U') {
      if (state.multiline) return kimiAcpSearchDeny('duplicate-option', 'multiline');
      if (options[index + 1] !== '--multiline-dotall') return kimiAcpSearchDeny('shape', 'Kimi multiline requires -U --multiline-dotall');
      index += 1;
      state.multiline = true;
    } else if (token === '--multiline-dotall') {
      return kimiAcpSearchDeny('shape', 'Kimi multiline requires -U before --multiline-dotall');
    } else if (token === '--no-ignore') {
      if (state.noIgnore) return kimiAcpSearchDeny('duplicate-option', '--no-ignore');
      state.noIgnore = true;
    } else if (token === '--no-config') {
      if (state.noConfig) return kimiAcpSearchDeny('duplicate-option', '--no-config');
      state.noConfig = true;
    } else {
      return kimiAcpSearchDeny('unknown-option', token);
    }
  }
  if (!state.hidden || !state.nullOutput) return kimiAcpSearchDeny('shape', 'not the Kimi native Grep argv shape');
  if (state.files && (state.count || state.withFilename)) return kimiAcpSearchDeny('mode', 'files_with_matches mode contains count/content flags');
  // Kimi's schema defaults output_mode to files_with_matches. Content is identifiable by one of its
  // content-only flags; the actual 0.37.2 builder normally emits -l explicitly, but keep the default exact.
  const hasContentMarker = state.lineNumbers || state.fieldSeparator || state.after !== null || state.before !== null || state.context !== null;
  const mode = state.count ? 'count_matches' : (state.files ? 'files_with_matches' : (hasContentMarker ? 'content' : 'files_with_matches'));
  if (mode === 'content' && state.maxColumns !== null) return kimiAcpSearchDeny('shape', 'content mode does not use --max-columns');
  if (mode !== 'content' && (state.lineNumbers || state.fieldSeparator || state.after !== null || state.before !== null || state.context !== null)) {
    return kimiAcpSearchDeny('mode', 'content-only flags require content mode');
  }
  if (mode === 'content' && state.count) return kimiAcpSearchDeny('mode', 'count mode cannot be content');
  if (mode === 'count_matches' && !state.withFilename) return kimiAcpSearchDeny('shape', 'count mode requires --with-filename');
  const pattern = args[sentinel + 1];
  const invalidPattern = kimiAcpSearchValidateText(pattern, 'Grep pattern', KIMI_ACP_SEARCH_MAX_PATTERN_LENGTH);
  if (invalidPattern) return invalidPattern;
  const searchPaths = args.slice(sentinel + 2);
  if (searchPaths.length === 0 || searchPaths.length > KIMI_ACP_SEARCH_MAX_SEARCH_PATHS) return kimiAcpSearchDeny('path-count', 'Grep search path count is out of range');
  for (const searchPath of searchPaths) {
    const invalidPath = kimiAcpSearchValidateText(searchPath, 'Grep search path', KIMI_ACP_SEARCH_MAX_COMMAND_LENGTH);
    if (invalidPath) return invalidPath;
    if (!path.isAbsolute(searchPath)) return kimiAcpSearchDeny('path', 'Grep search paths must be absolute');
  }
  return { ...state, mode, pattern, searchPaths };
}

function kimiAcpSearchBuildGlobArgs(state) {
  const out = ['--no-config'];
  if (state.singleThreaded) out.push('-j', '1');
  out.push('--files', '--hidden', '--sortr=modified');
  kimiAcpSearchAppendGlobArgs(out, kimiAcpSearchUnique(state.globs));
  if (state.noIgnore) out.push('--no-ignore');
  kimiAcpSearchAppendNegativeGlobArgs(out, KIMI_ACP_SEARCH_SENSITIVE_GLOBS);
  // Keep fixed exclusions after every model-supplied glob. In particular, --glob .git/** must not reopen
  // VCS metadata after the native Kimi shape has been normalized.
  kimiAcpSearchAppendNegativeGlobArgs(out, KIMI_ACP_SEARCH_VCS_GLOBS);
  out.push('.');
  return out;
}

function kimiAcpSearchBuildGrepArgs(state) {
  const out = ['--no-config'];
  if (state.singleThreaded) out.push('-j', '1');
  out.push('--hidden');
  if (state.mode !== 'content') out.push('--max-columns', String(KIMI_ACP_SEARCH_RG_MAX_COLUMNS));
  out.push('--null');
  if (state.mode === 'files_with_matches') out.push('-l');
  else if (state.mode === 'count_matches') out.push('--count-matches', '--with-filename');
  if (state.insensitive) out.push('-i');
  if (state.mode === 'content') {
    out.push('--with-filename');
    if (state.fieldSeparator) out.push('--field-context-separator', ':');
    else out.push('-n');
    if (state.context !== null) out.push('-C', String(state.context));
    else {
      if (state.after !== null) out.push('-A', String(state.after));
      if (state.before !== null) out.push('-B', String(state.before));
    }
  }
  kimiAcpSearchAppendGlobArgs(out, kimiAcpSearchUnique(state.globs));
  if (state.type) out.push('--type', state.type);
  if (state.multiline) out.push('-U', '--multiline-dotall');
  if (state.noIgnore) out.push('--no-ignore');
  kimiAcpSearchAppendNegativeGlobArgs(out, KIMI_ACP_SEARCH_SENSITIVE_GLOBS);
  kimiAcpSearchAppendNegativeGlobArgs(out, KIMI_ACP_SEARCH_VCS_GLOBS);
  out.push('--', state.pattern, ...state.searchPaths);
  return out;
}

async function classifyKimiAcpReadonlySearch(params, context) {
  if (!kimiAcpSearchIsObject(params)) return kimiAcpSearchDeny('params', 'params must be an object');
  const commandCheck = kimiAcpSearchValidateText(params.command, 'command', KIMI_ACP_SEARCH_MAX_COMMAND_LENGTH);
  if (commandCheck) return commandCheck;
  if (!Array.isArray(params.args) || params.args.length === 0 || params.args.length > KIMI_ACP_SEARCH_MAX_ARGS) {
    return kimiAcpSearchDeny('args', 'args must be a non-empty array of bounded size');
  }
  for (const value of params.args) {
    const invalid = kimiAcpSearchValidateText(value, 'argv value', KIMI_ACP_SEARCH_MAX_ARG_LENGTH, true);
    if (invalid) return invalid;
  }
  const envCheck = kimiAcpSearchNormalizeInputEnv(params.env);
  if (!envCheck.ok) return envCheck;
  const command = await kimiAcpSearchResolveTrustedRg(params.command, context);
  if (typeof command !== 'string') return command;
  const dataInfo = await kimiAcpSearchDataRootInfo();
  if (dataInfo.unavailable) return kimiAcpSearchDeny('data-root-unavailable', 'Ruyi data-root safety check is unavailable');

  const rawCwd = params.cwd == null || params.cwd === ''
    ? String(context && context.session && context.session.cwd || context && context.config && context.config.defaultWorkspace || '')
    : params.cwd;
  const cwd = await kimiAcpSearchCanonicalReadPath(rawCwd, context, 'cwd', true, dataInfo);
  if (typeof cwd !== 'string') return cwd;

  const args = params.args;
  const isGlob = args.includes('--files');
  let parsed;
  if (isGlob) {
    if (args.includes('--')) return kimiAcpSearchDeny('shape', 'Glob cannot contain Grep sentinel --');
    parsed = kimiAcpSearchParseGlobArgs(args);
  } else {
    parsed = kimiAcpSearchParseGrepArgs(args);
  }
  if (!parsed || parsed.ok === false) return parsed || kimiAcpSearchDeny('shape', 'unsupported native search shape');

  if (!isGlob) {
    const canonicalPaths = [];
    for (const rawPath of parsed.searchPaths) {
      const canonical = await kimiAcpSearchCanonicalReadPath(rawPath, context, 'Grep search path', false, dataInfo);
      if (typeof canonical !== 'string') return canonical;
      canonicalPaths.push(canonical);
    }
    parsed.searchPaths = canonicalPaths;
  }
  return {
    ok: true,
    command,
    args: isGlob ? kimiAcpSearchBuildGlobArgs(parsed) : kimiAcpSearchBuildGrepArgs(parsed),
    cwd,
    // This is an override contract, not a complete child environment. Turing/05b must merge it only with
    // Ruyi's own process environment after removing blocked caller/process variables; never merge params.env.
    env: { ...KIMI_ACP_SEARCH_SAFE_ENV_OVERRIDES },
  };
}
