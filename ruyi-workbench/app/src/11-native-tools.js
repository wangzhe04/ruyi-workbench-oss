// ===================================================================================================
// v0.8-S2 — persistent PowerShell shell sessions (provider engine only).
// A session = one long-lived `powershell -NoLogo -NoProfile` child whose stdout+stderr stream into a
// ring buffer. State lives ONLY in the serve process Map below; the one-shot MCP child (Claude CLI
// engine) cannot host it (RUNTIME.isMcpChild guard in toolCall), so shell_* return a guiding error there.
// Cursor semantics = ABSOLUTE offset since session start, measured in UTF-16 code units (chunks are
// toString('utf8')-decoded BEFORE length accounting — so this is a JS char offset, NOT raw bytes; do not
// use it for external byte math). When buf is trimmed at the head (>200KB units), the evicted unit count
// accumulates into baseOffset; a cursor below baseOffset yields truncated:true.
// ===================================================================================================
const SHELL_BUF_MAX = 200 * 1024;                 // ring-buffer cap per session (UTF-16 units of retained tail)
const SHELL_IDLE_MS = 30 * 60 * 1000;             // auto-kill sessions idle longer than this
const shellSessions = new Map();                  // shellId -> { child, name, cwd, buf, baseOffset, running, exitCode, startedAt, lastUsedAt }

function shellIdValid(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(id); }
function genShellId() { return 'sh_' + crypto.randomBytes(5).toString('hex'); }

// Append a chunk to a session's ring buffer, trimming the head past SHELL_BUF_MAX and accounting the
// evicted units into baseOffset so cursor offsets stay absolute across trims.
function shellAppend(sess, chunk) {
  sess.buf += chunk;
  if (sess.buf.length > SHELL_BUF_MAX) {
    const drop = sess.buf.length - SHELL_BUF_MAX;
    sess.buf = sess.buf.slice(drop);
    sess.baseOffset += drop;
  }
}

// Total absolute offset (UTF-16 units) of the buffer's tail end (== units ever written, modulo trimming accounting).
function shellEndOffset(sess) { return sess.baseOffset + sess.buf.length; }

// Slice the buffer from an absolute cursor to the end. cursor < baseOffset → start at baseOffset,
// truncated:true (the requested region was already evicted). Returns { output, cursor, truncated }.
function shellSliceFrom(sess, cursor) {
  const end = shellEndOffset(sess);
  let from = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
  let truncated = false;
  if (from < sess.baseOffset) { from = sess.baseOffset; truncated = true; }
  if (from > end) from = end;
  const output = sess.buf.slice(from - sess.baseOffset);
  return { output, cursor: end, truncated };
}

// Spawn a persistent powershell child. Returns { ok, shellId, name, cwd } or { ok:false, error, hint }.
function shellStart(args, config) {
  const max = (config && Number.isFinite(config.shellSessionMax)) ? config.shellSessionMax : 3;
  // The cap counts LIVE sessions only. Exited (running:false) sessions stay in the Map so their output
  // tail remains pollable — that's their value — but they must not eat concurrency slots (a naturally
  // exited shell would otherwise block new starts with a confusing "limit reached").
  const active = [...shellSessions.values()].filter(s => s.running).length;
  if (active >= max) {
    return { ok: false, error: `已达 shell 会话上限 ${max}`, hint: '先 shell_kill 释放(shell_list 可见全部,含已退出)' };
  }
  let shellId = args.shellId;
  if (shellId !== undefined && shellId !== null && shellId !== '') {
    // Caller-specified id: deterministic (static FAKE_TOOL_SEQUENCE + models). Validate + reject clashes.
    if (!shellIdValid(String(shellId))) return { ok: false, error: 'shellId 非法(仅 [a-zA-Z0-9_-]{1,32})' };
    shellId = String(shellId);
    if (shellSessions.has(shellId)) return { ok: false, error: `shellId '${shellId}' 已存在` };
  } else {
    do { shellId = genShellId(); } while (shellSessions.has(shellId));
  }
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : os.homedir();
  const name = args.name ? String(args.name).slice(0, 80) : shellId;
  let child;
  try {
    child = cp.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], {
      cwd, env: { ...process.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : 'spawn failed' };
  }
  const now = Date.now();
  const sess = { child, name, cwd, buf: '', baseOffset: 0, running: true, exitCode: null, startedAt: now, lastUsedAt: now };
  child.stdout?.on('data', d => shellAppend(sess, d.toString('utf8')));
  child.stderr?.on('data', d => shellAppend(sess, d.toString('utf8')));
  child.on('error', err => { shellAppend(sess, `\n[shell error] ${err && err.message ? err.message : err}\n`); sess.running = false; });
  child.on('close', code => { sess.running = false; sess.exitCode = (code === null ? null : code); });
  shellSessions.set(shellId, sess);
  return { ok: true, shellId, name, cwd };
}

// Write input to a session and wait for output to settle. best-effort capture: polls buffer growth and
// returns when ~300ms passes with no new bytes, or timeoutMs elapses. A newly spawned PowerShell may need
// several seconds before it consumes its first stdin command on a cold hosted Windows runner, so an
// entirely silent command gets a bounded 5s startup/grace window; returning earlier can leave that command
// queued and misattribute its output to the next shell_send. Long-running tasks won't finish
// within one send — track them with shell_poll. output = increment from the pre-send cursor to now.
async function shellSend(args) {
  const shellId = String(args.shellId || '');
  const sess = shellSessions.get(shellId);
  // v0.8-S7 error guidance: an unknown shellId (typo, or the session was reaped/killed) → point the model
  // at shell_list / shell_start rather than leaving it to retry the same dead id.
  if (!sess) return { ok: false, error: `未知 shellId '${shellId}'`, hint: '用 shell_list 查看现有会话,或 shell_start 新建' };
  sess.lastUsedAt = Date.now();
  const startCursor = shellEndOffset(sess);
  const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeoutMs || 10000)));
  if (sess.running && sess.child.stdin && sess.child.stdin.writable) {
    try { sess.child.stdin.write(String(args.input != null ? args.input : '') + '\n'); }
    catch (e) { return { ok: false, error: `写入失败: ${e && e.message ? e.message : e}` }; }
  } else if (!sess.running) {
    // Child already exited — still return whatever fresh output exists, but flag not-running.
    const slice = shellSliceFrom(sess, startCursor);
    return { ok: true, output: slice.output, cursor: slice.cursor, running: false, exitCode: sess.exitCode };
  }
  // Settle loop: poll every 60ms; resolve once ~300ms passes with no growth, or on timeout / child exit.
  const deadline = Date.now() + timeoutMs;
  const sentAt = Date.now();
  let lastLen = shellEndOffset(sess);
  let stableSince = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 60));
    const nowLen = shellEndOffset(sess);
    if (nowLen !== lastLen) { lastLen = nowLen; stableSince = Date.now(); }
    if (!sess.running) break;
    if (Date.now() - stableSince >= 300 && nowLen > startCursor) break; // grew then went quiet
    if (nowLen === startCursor && Date.now() - sentAt >= Math.min(5000, timeoutMs)) {
      // No output at all within a settle window (e.g. a command that prints nothing) — don't hang.
      break;
    }
    if (Date.now() >= deadline) break;
  }
  sess.lastUsedAt = Date.now();
  const slice = shellSliceFrom(sess, startCursor);
  return { ok: true, output: slice.output, cursor: slice.cursor, running: sess.running, exitCode: sess.running ? undefined : sess.exitCode };
}

function shellPoll(args) {
  const shellId = String(args.shellId || '');
  const sess = shellSessions.get(shellId);
  // v0.8-S7 error guidance: same unknown-shellId hint as shell_send.
  if (!sess) return { ok: false, error: `未知 shellId '${shellId}'`, hint: '用 shell_list 查看现有会话,或 shell_start 新建' };
  sess.lastUsedAt = Date.now();
  const cursor = args.cursor === undefined || args.cursor === null ? 0 : Number(args.cursor);
  const slice = shellSliceFrom(sess, cursor);
  const out = { ok: true, output: slice.output, cursor: slice.cursor, running: sess.running };
  if (slice.truncated) out.truncated = true;
  if (!sess.running) out.exitCode = sess.exitCode;
  return out;
}

function shellKill(args) {
  const shellId = String(args.shellId || '');
  const sess = shellSessions.get(shellId);
  if (!sess) return { ok: false, error: `未知 shellId '${shellId}'` };
  try { if (sess.child && sess.child.pid) killChildTree(sess.child.pid); } catch { /* already gone */ }
  sess.running = false;
  shellSessions.delete(shellId);
  return { ok: true };
}

function shellList() {
  const shells = [];
  for (const [shellId, s] of shellSessions) {
    shells.push({
      shellId, name: s.name, cwd: s.cwd, running: s.running, exitCode: s.exitCode,
      startedAt: new Date(s.startedAt).toISOString(), lastUsedAt: new Date(s.lastUsedAt).toISOString(),
      bytes: shellEndOffset(s),
    });
  }
  return { ok: true, shells };
}

// Reap every live shell session (called on serve-process shutdown alongside killAllMcpClients).
function killAllShellSessions() {
  for (const [, s] of shellSessions) { try { if (s.child && s.child.pid) killChildTree(s.child.pid); } catch { /* ignore */ } }
  shellSessions.clear();
}

// Idle reaper: every 60s, kill sessions untouched for >30min. .unref() so it never keeps the loop alive.
const shellIdleReaper = setInterval(() => {
  const cutoff = Date.now() - SHELL_IDLE_MS;
  for (const [id, s] of shellSessions) { if (s.lastUsedAt < cutoff) { try { shellKill({ shellId: id }); } catch { /* ignore */ } } }
}, 60_000);
shellIdleReaper.unref();

// v0.8-S2: the guarding stub returned when a shell_* tool runs in the one-shot MCP child (Claude CLI
// engine). The session cannot live there; steer the model to the persistent provider engine, or to
// powershell_run for a one-shot command.
function shellMcpChildGuard() {
  return {
    ok: false,
    error: 'shell 会话仅在原生 provider 引擎可用(工具运行于一次性 MCP 子进程,无法跨回合存活)',
    hint: '一次性命令请用 powershell_run',
  };
}

// v0.8-S1: glob → RegExp. Self-written, zero-dep. Semantics: `**` crosses directory separators,
// `*` matches within one path segment (not `/` or `\`), `?` matches one non-separator char; every
// other regex metacharacter is escaped literally. Matches against the relative path (with either
// slash flavor accepted). Anchored full-match (^…$).
function globToRegExp(glob) {
  const g = String(glob || '');
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { // `**` → any chars including separators
        re += '.*';
        i += 1;
        // swallow an immediately following separator so `**/x` also matches `x` at root
        if (g[i + 1] === '/' || g[i + 1] === '\\') { re += '(?:[\\\\/])?'; i += 1; }
      } else {
        re += '[^\\\\/]*'; // `*` → within a segment
      }
    } else if (c === '?') {
      re += '[^\\\\/]'; // single non-separator char
    } else if (c === '/' || c === '\\') {
      re += '[\\\\/]'; // accept either separator flavor
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // escape regex metachars
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

// v0.8-S1: minimal Levenshtein edit distance (zero-dep) for file_edit `closest` ranking. Lines longer
// than `cap` are truncated first (edit distance is O(m*n); pathological long lines would be quadratic).
function levenshtein(a, b, cap = 500) {
  const s = String(a || '').slice(0, cap);
  const t = String(b || '').slice(0, cap);
  const m = s.length, n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// v0.8-S1: image/binary suffixes that file_read refuses (routes user to the vision channel instead).
// NOTE: 'svg' is deliberately NOT here — SVG is XML text with real read/edit workflows.
const BINARY_READ_SUFFIXES = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'wav', 'flac', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'class', 'o', 'obj', 'pyc', 'wasm',
]);
function isBinaryReadPath(p) {
  const ext = path.extname(String(p || '')).replace(/^\./, '').toLowerCase();
  return ext !== '' && BINARY_READ_SUFFIXES.has(ext);
}

// v0.8-S1: ripgrep fast-path probe. Looks for a vendored rg.exe at <appRoot>/vendor-bin/rg.exe and
// confirms it is executable. Cached for the process lifetime (path is static per install). Absent
// binary → false + JS scan path (normal on machines without the optional vendor-bin).
let _rgProbe;
function probeRg() {
  if (_rgProbe !== undefined) return _rgProbe;
  const candidate = path.join(appRoot(), 'vendor-bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
  _rgProbe = fs.existsSync(candidate) && existsExecutable(candidate) ? candidate : null;
  return _rgProbe;
}
function hasRg() { return !!probeRg(); }

async function walkFiles(root, opts = {}) {
  const base = path.resolve(root || process.cwd());
  const maxFiles = Number(opts.maxFiles || 500);
  const recursive = opts.recursive !== false;
  const pattern = opts.pattern ? new RegExp(opts.pattern, opts.ignoreCase === false ? '' : 'i') : null;
  const ignoredDirs = new Set(opts.ignoreDirs || ['node_modules', '.git', '.venv']);
  const out = [];
  // 审计 P1(对抗轮补漏): 遍历类工具(file_list/glob,以及经 searchFileContentJs 的 file_search)会递归进 dataRoot,
  // 而 guardFileToolPath 只校验 root 参数、不校验被遍历文件 —— 当某允许根是 dataRoot 的祖先(默认: home 工作区 ⊇
  // home/.win-claude-workbench)时,config.json/sessions/token 配置的内容仍被搜出返回。这里在遍历处逐项跳过敏感子树
  // (既不入结果也不下钻)。ensureDataRootReal 已在上游 guardFileToolPath(root) 预热,此处 sync 判定即可。
  await ensureDataRootReal();
  async function walk(dir, depth) {
    if (out.length >= maxFiles) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (isSensitiveDataPath(full)) continue; // 敏感控制面文件/目录:不返回、不下钻
      const rel = path.relative(base, full) || '.';
      if (!pattern || pattern.test(rel)) {
        const stat = await fsp.stat(full).catch(() => null);
        out.push({ path: full, relativePath: rel, type: entry.isDirectory() ? 'directory' : 'file', size: stat?.size || 0 });
      }
      if (recursive && entry.isDirectory() && depth < Number(opts.maxDepth || 8)) {
        await walk(full, depth + 1);
      }
    }
  }
  await walk(base, 0);
  return out;
}

// v0.8-S1: grep v2. Backward compatible — with no new params the returned records are byte-identical
// to the S0 shape ({path, relativePath, line, text}). New optional params:
//   context(0-5): include N lines before/after each match; each result gains `context:[{line,text,match}]`
//                 (`match:true` marks the hit line; `>` markers are rendered by the caller display).
//   glob:         relative-path glob filter (reuses globToRegExp) restricting which files are scanned.
//   group:true:   results grouped by file as [{path, relativePath, matches:[...]}].
// When a vendored rg.exe is present (probeRg), file_search routes through `spawn rg --json` (NDJSON),
// mapping results back to this exact shape; on rg failure/timeout it silently falls back to this JS scan.
// v0.8-S2 fix (F2): normalize an LLM-supplied pattern once, for BOTH the JS and rg paths. Models very
// commonly emit PCRE inline-flag prefixes like `(?i)pass` — rg's Rust regex accepts them natively but
// JS `new RegExp` throws "Invalid group", which used to fail the whole tool. Steps:
//  1) strip a leading inline-flag group `(?…)` — `i` is already the scanner default; `m`/`s` are merged
//     into the JS flags (extraFlags); the rg path just gets the stripped pattern (unaffected semantics);
//  2) if the stripped pattern STILL doesn't compile, escape every metacharacter and search it as literal
//     text, reporting note:'invalid regex; searched as literal text' (surfaced as `patternNote`).
// Returns { pattern, extraFlags, note }.
function normalizeSearchPattern(rawPattern) {
  let pattern = String(rawPattern || '');
  let extraFlags = '';
  const m = pattern.match(/^\(\?([a-z]*)(?:-[a-z]+)?\)/);
  if (m) {
    pattern = pattern.slice(m[0].length);
    if (m[1].includes('m')) extraFlags += 'm';
    if (m[1].includes('s')) extraFlags += 's';
  }
  try { new RegExp(pattern); return { pattern, extraFlags, note: null }; }
  catch {
    return {
      pattern: pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      extraFlags,
      note: 'invalid regex; searched as literal text',
    };
  }
}

async function searchFileContent(root, pattern, opts = {}) {
  // F2: single normalization point shared by the rg fast path and the JS scanner.
  const norm = normalizeSearchPattern(pattern);
  const effOpts = norm.extraFlags ? { ...opts, extraFlags: norm.extraFlags } : opts;
  let results = null;
  // Fast path: ripgrep, if vendored. Failure/timeout → silent fallback to the JS scanner below.
  if (hasRg()) {
    try {
      const viaRg = await searchFileContentRg(root, norm.pattern, effOpts);
      if (viaRg) results = viaRg;
    } catch { /* fall through to JS path */ }
  }
  if (!results) results = await searchFileContentJs(root, norm.pattern, effOpts);
  // Carry the literal-fallback note on the array (JSON.stringify of an array drops extra props, so the
  // file_search handler lifts it into the response as `patternNote`; other callers safely ignore it).
  if (norm.note) results.patternNote = norm.note;
  return results;
}

// Group flat match records by file (stable order of first appearance) when opts.group is set.
function maybeGroup(results, group) {
  if (!group) return results;
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.path)) byFile.set(r.path, { path: r.path, relativePath: r.relativePath, matches: [] });
    const { path: _p, relativePath: _rp, ...rest } = r;
    byFile.get(r.path).matches.push(rest);
  }
  return Array.from(byFile.values());
}

async function searchFileContentJs(root, pattern, opts = {}) {
  const files = await walkFiles(root, {
    recursive: true,
    maxFiles: opts.maxFiles || 2000,
    maxDepth: opts.maxDepth || 8,
    ignoreDirs: opts.ignoreDirs || ['node_modules', '.git', '.venv'],
  });
  // F2: extraFlags carries m/s harvested from a stripped inline-flag prefix (normalizeSearchPattern).
  const re = new RegExp(pattern, (opts.ignoreCase === false ? 'g' : 'gi') + (opts.extraFlags || ''));
  const globRe = opts.glob ? globToRegExp(opts.glob) : null;
  const ctx = Math.max(0, Math.min(5, Number(opts.context || 0) || 0));
  const maxResults = Number(opts.maxResults || 200);
  const results = [];
  for (const file of files.filter(f => f.type === 'file')) {
    if (results.length >= maxResults) break;
    if (file.size > Number(opts.maxFileBytes || 1024 * 1024)) continue;
    if (globRe && !globRe.test(file.relativePath)) continue;
    let raw = '';
    try {
      raw = await fsp.readFile(file.path, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        const rec = { path: file.path, relativePath: file.relativePath, line: i + 1, text: lines[i].slice(0, 500) };
        if (ctx > 0) {
          const block = [];
          for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j += 1) {
            block.push({ line: j + 1, text: lines[j].slice(0, 500), match: j === i });
          }
          rec.context = block;
        }
        results.push(rec);
        if (results.length >= maxResults) break;
      }
    }
  }
  return maybeGroup(results, opts.group);
}

// rg --json emits NDJSON: one JSON object per line. We care about type:'match' events. The matched
// line text lives at data.lines.text, OR (for non-UTF8 content) at data.lines.bytes as base64 — both
// branches handled. Context lines arrive as type:'context' events between matches (rg -C N). We map
// everything back to the identical JS-path record shape (absolute path + relativePath + line + text
// [+ context]). Bounded by a 10s timeout; on non-zero-with-no-output / spawn error we return null so
// the caller falls back to the JS scanner.
function searchFileContentRg(root, pattern, opts = {}) {
  const rg = probeRg();
  const base = path.resolve(root || process.cwd());
  const ctx = Math.max(0, Math.min(5, Number(opts.context || 0) || 0));
  const maxResults = Number(opts.maxResults || 200);
  const args = ['--json', '--no-messages'];
  if (opts.ignoreCase !== false) args.push('-i');
  if (ctx > 0) { args.push('-C', String(ctx)); }
  if (opts.glob) { args.push('-g', String(opts.glob)); }
  for (const d of (opts.ignoreDirs || ['node_modules', '.git', '.venv'])) { args.push('-g', '!' + d + '/'); }
  // Align rg's scan limits with the JS path so both paths skip the same big files / deep dirs.
  args.push('--max-filesize', String(opts.maxFileBytes || 1024 * 1024));
  if (opts.maxDepth) args.push('--max-depth', String(opts.maxDepth));
  args.push('--', String(pattern), base);
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false;
    const finish = v => { if (!done) { done = true; try { clearTimeout(timer); } catch {} resolve(v); } };
    const child = cp.spawn(rg, args, { cwd: base, windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish(null); }, Number(opts.rgTimeoutMs || 10000));
    child.stdout.on('data', d => { stdout += d.toString('utf8'); if (stdout.length > 32_000_000) { try { child.kill('SIGTERM'); } catch {} } });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', code => {
      // rg exit 1 = no matches (valid: empty result). exit 2 = error → fall back.
      if (code === 2 && !stdout) return finish(null);
      const results = [];
      // rg -C N emits `context` events BOTH before and after each `match` (interleaved per file). We
      // buffer leading context in pendingCtx; a context event within `ctx` lines AFTER the last match is
      // appended to that match's block (trailing context). Blocks are then sorted by line to match the
      // contiguous JS-path window shape. Known shape difference: when two matches sit close together,
      // context lines in the overlapping window are attributed to the PREVIOUS match (rg emits each
      // shared line once), whereas the JS path gives every match its full ±ctx window — an acceptable
      // display-level difference.
      let pendingCtx = [];
      let lastMatch = null; // most recent match record (for trailing-context attachment)
      const rel = full => path.relative(base, full) || '.';
      const decode = data => {
        if (!data || !data.lines) return '';
        if (typeof data.lines.text === 'string') return data.lines.text.replace(/\r?\n$/, '');
        if (data.lines.bytes) { try { return Buffer.from(data.lines.bytes, 'base64').toString('utf8').replace(/\r?\n$/, ''); } catch { return ''; } }
        return '';
      };
      const finalizeBlock = rec => { if (rec && rec.context) rec.context.sort((a, b) => a.line - b.line); };
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || !ev.type) continue;
        if (ev.type === 'begin') { finalizeBlock(lastMatch); pendingCtx = []; lastMatch = null; continue; }
        if (ev.type === 'end') { finalizeBlock(lastMatch); lastMatch = null; continue; }
        if (ev.type === 'context' && ctx > 0) {
          const d = ev.data || {};
          const lineNo = Number(d.line_number || 0);
          const entry = { line: lineNo, text: decode(d).slice(0, 500), match: false };
          // Trailing context for the last match (same file, within ctx lines after it) → attach there.
          if (lastMatch && lastMatch.context && lineNo > lastMatch.line && lineNo <= lastMatch.line + ctx) {
            lastMatch.context.push(entry);
          } else {
            pendingCtx.push(entry);
          }
          continue;
        }
        if (ev.type === 'match') {
          if (results.length >= maxResults) break;
          finalizeBlock(lastMatch);
          const d = ev.data || {};
          const full = d.path && d.path.text ? path.resolve(base, d.path.text) : base;
          const lineNo = Number(d.line_number || 0);
          const text = decode(d).slice(0, 500);
          const rec = { path: full, relativePath: rel(full), line: lineNo, text };
          if (ctx > 0) {
            rec.context = [...pendingCtx.map(c => ({ ...c })), { line: lineNo, text, match: true }];
            pendingCtx = [];
          }
          results.push(rec);
          lastMatch = rec;
        }
      }
      finalizeBlock(lastMatch);
      finish(maybeGroup(results, opts.group));
    });
  });
}

async function readIfExists(file, limit = 200000) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return raw.slice(0, limit);
  } catch {
    return '';
  }
}

// ============================================================================
// v1.0-S4 — git 工具族 (git_status / git_diff / git_log / git_commit)。
// 面向非程序员:AI 替用户管版本(「帮我把这次改动存个版本」)。四个工具都走 ONE 条安全执行路径:
//   • child_process.execFile('git', [...])   —— 无 shell,杜绝命令注入 / 旗标走私经由 shell 元字符。
//   • 一切模型可控的路径参数(path/paths)一律置于 `--` 分隔符之后;message 用 `-m <message>` 两元素传递。
//   • windowsHide + 超时(默认 15s,commit 30s)+ maxBuffer 上限。
//   • git 不存在(ENOENT) / 非仓库 / 缺身份 → 全部转「人话引导错误」,永不崩溃。
// 两个引擎路径都注册(serve 进程 provider 循环 + `node server.js mcp` 子进程),因为这是无状态一次性命令,
// 同 file_read/powershell_run 一样自然工作 —— 不像 shell 会话那样需要 provider-only 护栏。
// ============================================================================
const GIT_DIFF_MAX_BYTES = 200 * 1024; // git_diff 输出超此上限即截断加注(200KB)
// v1.0 收官安全加固(对抗复核 CONFIRMED·CRITICAL):git 会执行由被操作仓库自带 `.git/config` 指定的
// 外部程序 —— `core.fsmonitor`(status/diff 读 index 时执行)、`diff.external` / textconv(diff 时执行)。
// git_status/git_diff 是 read 档、所有权限模式恒放行零弹窗,若不覆盖这些键,「看一眼陌生仓库的 git 状态」
// 即等于在受害仓库自带的 hook 程序下无提示 RCE(两面均实弹已证:fsmonitor 用 sh hook + fsmonitorHookVersion=2
// 触发;diff.external 裸 git diff 即执行)。命令行 `-c core.fsmonitor=`(空=关闭)优先级最高,覆盖各级配置且
// 对功能零损失(fsmonitor 纯读性能优化)。**注意**:`-c diff.external=`(空)不能用——git 会把空值当成「要 spawn
// 的外部差异器」而报 `external diff died`,反而破坏正常 diff;diff.external / textconv 面改由 gitDiff 的
// `--no-ext-diff --no-textconv` 关闭(diff 子命令专用选项,见 gitDiff)。GIT_SAFE_FLAGS 对 ALL git 调用统一
// 前置(commit 亦安全:它不读 fsmonitor;合法 pre-commit hook 走 core.hooksPath,未被触碰,仍在 exec 档权限门下)。
const GIT_SAFE_FLAGS = ['-c', 'core.fsmonitor=', '-c', 'core.fsmonitorHookVersion=0'];
// execFile('git', args) 的 Promise 包装:无 shell。返回 { ok, code, stdout, stderr, error?(ENOENT等) }。
// 永不 reject —— 传输层错误(git 缺失、cwd 不存在)落在 result.error / result.code<0 上,由调用方转人话。
function runGit(args, cwd, timeoutMs) {
  return new Promise(resolve => {
    let child;
    try {
      // 安全加固前缀(GIT_SAFE_FLAGS)必须在子命令之前;args 以 `-C <dir> <subcmd> …` 开头,故整体前置合法。
      child = cp.execFile('git', [...GIT_SAFE_FLAGS, ...args], {
        cwd: cwd || process.cwd(),
        windowsHide: true,
        timeout: Math.max(1000, Number(timeoutMs || 15000)),
        maxBuffer: 24 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : (error ? -1 : 0);
        resolve({ ok: !error, code, stdout: stdout || '', stderr: stderr || '', error: error || null });
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: e });
      return;
    }
    child.on('error', () => { /* handled via the callback's `error` arg */ });
  });
}
// Resolve the working directory a git tool runs in. Mirrors powershell_run's lenient handling: an explicit,
// existing absolute dir wins; anything unusable falls back to the session/home workspace (never throws).
function resolveGitCwd(raw) {
  const home = os.homedir();
  const candidate = String(raw || '').trim();
  if (!candidate) return home;
  let resolved;
  try { resolved = path.resolve(candidate); } catch { return home; }
  try { if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved; } catch { /* fall through */ }
  return home;
}
// Map a failed git invocation to a 中文人话引导错误. Order matters: binary-missing first (nothing else is
// meaningful without git), then the common "not a repo" and "missing identity" cases, else the raw stderr.
function gitHumanError(res, cwd) {
  // ENOENT (or the wrapper's -1 with an ENOENT-shaped error) → git isn't installed / not on PATH.
  const err = res && res.error;
  if (err && (err.code === 'ENOENT' || /ENOENT/.test(String(err.message || '')))) {
    return { ok: false, error: '未检测到 Git', hint: '请安装 Git for Windows(https://git-scm.com/download/win)后重试,或让 AI 用命令确认 git 是否在 PATH 上。', cwd };
  }
  const stderr = String((res && res.stderr) || '').trim();
  const low = stderr.toLowerCase();
  if (/not a git repository/.test(low)) {
    return { ok: false, error: '这个文件夹还不是 Git 仓库', hint: '可以让 AI 运行 `git init` 把它变成一个 Git 仓库,再重试。', cwd, detail: stderr };
  }
  // git_commit without a configured identity — DO NOT auto-inject a fake user; guide the human instead.
  if (/please tell me who you are|user\.name|user\.email|empty ident/.test(low)) {
    return {
      ok: false, error: '还没配置 Git 身份(user.name / user.email)',
      hint: '请在设置里配置 Git 身份,或让 AI 用命令配置(例如 `git config user.name "你的名字"` 与 `git config user.email "you@example.com"`)。',
      cwd, detail: stderr,
    };
  }
  return { ok: false, error: 'Git 命令执行失败', hint: '请查看下方 detail 的原始报错,调整后重试。', cwd, detail: stderr || (err && err.message) || '未知错误' };
}
// Parse `git status --porcelain=v1 -b` into a human summary line. First line is the branch header
// (## branch...tracking [ahead N, behind M]); remaining lines are XY-coded change entries.
function summarizeGitStatus(stdout) {
  const lines = String(stdout || '').split('\n').filter(l => l.length > 0);
  let branch = '(未知分支)', ahead = 0, behind = 0, changes = 0, untracked = 0;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      // "branch...upstream [ahead 1, behind 2]" or "No commits yet on main" or "HEAD (no branch)"
      const nameMatch = head.match(/^([^\s.]+(?:\.\.\.[^\s]+)?)/);
      branch = head.startsWith('No commits yet') ? head : (nameMatch ? nameMatch[1].split('...')[0] : head);
      const am = head.match(/ahead (\d+)/); if (am) ahead = Number(am[1]);
      const bm = head.match(/behind (\d+)/); if (bm) behind = Number(bm[1]);
      continue;
    }
    changes++;
    if (line.startsWith('??')) untracked++;
  }
  const parts = [`分支 ${branch}`];
  if (ahead) parts.push(`领先 ${ahead}`);
  if (behind) parts.push(`落后 ${behind}`);
  parts.push(changes === 0 ? '工作区干净,无改动' : `${changes} 个改动` + (untracked ? `(含 ${untracked} 个未跟踪)` : ''));
  return { summary: parts.join(' · '), branch, ahead, behind, changes, untracked };
}
// git_status {cwd?}: porcelain v1 + branch header, plus a 人话 summary line. tier: read.
async function gitStatus(args = {}) {
  const cwd = resolveGitCwd(args.cwd);
  const res = await runGit(['-C', cwd, 'status', '--porcelain=v1', '-b'], cwd, args.timeoutMs || 15000);
  if (!res.ok) return gitHumanError(res, cwd);
  const parsed = summarizeGitStatus(res.stdout);
  return { ok: true, cwd, summary: parsed.summary, branch: parsed.branch, ahead: parsed.ahead, behind: parsed.behind, changes: parsed.changes, untracked: parsed.untracked, status: res.stdout };
}

// git_diff {cwd?, path?, staged?, contextLines?}: unified diff text. tier: read.
// SECURITY: any model-controllable path goes AFTER `--`; a lone `-`-leading path with no separator is refused.
async function gitDiff(args = {}) {
  const cwd = resolveGitCwd(args.cwd);
  // 安全加固(对抗复核 CRITICAL 的 diff 面):--no-ext-diff 忽略仓库配置的 diff.external 外部差异器,
  // --no-textconv 关掉 gitattributes 指定的 textconv 过滤器 —— 两者都会执行仓库自带的外部程序,是 read 档
  // git_diff 下的代码执行面。用 diff 子命令专用选项关闭(不能用 `-c diff.external=` 空值,那会让 git 尝试
  // spawn 空命令而报错)。正常 diff 输出不受影响(已实弹验证:+/- 行照常产出、恶意 diff.external 不触发)。
  const gitArgs = ['-C', cwd, 'diff', '--no-ext-diff', '--no-textconv'];
  if (args.staged === true) gitArgs.push('--cached');
  // contextLines → -U<n> (clamped 0..50). Passed as a single joined arg so it can't be split/走私.
  const ctx = Number(args.contextLines);
  if (Number.isFinite(ctx)) gitArgs.push('-U' + String(Math.max(0, Math.min(50, Math.floor(ctx)))));
  // path is UNTRUSTED. Place it strictly after `--` so a value like `--output=x` is treated as a pathspec,
  // never a git flag. (We still pass it verbatim — execFile means no shell, so no further quoting needed.)
  const rawPath = (args.path != null && String(args.path).trim() !== '') ? String(args.path) : null;
  if (rawPath) gitArgs.push('--', rawPath);
  const res = await runGit(gitArgs, cwd, args.timeoutMs || 15000);
  if (!res.ok) return gitHumanError(res, cwd);
  let diff = res.stdout || '';
  let truncated = false;
  if (Buffer.byteLength(diff, 'utf8') > GIT_DIFF_MAX_BYTES) {
    // Truncate on a byte budget, then trim back to a whole-character boundary and add a 人话 note.
    diff = Buffer.from(diff, 'utf8').slice(0, GIT_DIFF_MAX_BYTES).toString('utf8');
    truncated = true;
    diff += `\n\n[已截断:diff 超过 ${Math.round(GIT_DIFF_MAX_BYTES / 1024)}KB。可用 path 参数只看单个文件,或减小 contextLines。]`;
  }
  return { ok: true, cwd, staged: args.staged === true, path: rawPath || undefined, diff, empty: diff.trim() === '', truncated };
}

// git_log {cwd?, maxCount?, path?}: recent commits as a row table. tier: read.
async function gitLog(args = {}) {
  const cwd = resolveGitCwd(args.cwd);
  const n = Math.max(1, Math.min(100, Math.floor(Number(args.maxCount) || 10)));
  const gitArgs = ['-C', cwd, 'log', '--date=iso', '--pretty=format:%h|%ad|%an|%s', '-n', String(n)];
  const rawPath = (args.path != null && String(args.path).trim() !== '') ? String(args.path) : null;
  if (rawPath) gitArgs.push('--', rawPath); // UNTRUSTED path after the `--` separator
  const res = await runGit(gitArgs, cwd, args.timeoutMs || 15000);
  if (!res.ok) return gitHumanError(res, cwd);
  const commits = String(res.stdout || '').split('\n').filter(l => l.length > 0).map(line => {
    const [hash, date, author, ...rest] = line.split('|');
    return { hash: hash || '', date: date || '', author: author || '', subject: rest.join('|') };
  });
  return { ok: true, cwd, count: commits.length, maxCount: n, path: rawPath || undefined, commits };
}

// git_commit {cwd?, message(必填), addAll?, paths?}: stage then commit. tier: exec (hooks run arbitrary code).
// SECURITY: message via `-m <message>` (two elements); paths after `--`; NEVER --no-verify; NEVER fake identity.
async function gitCommit(args = {}) {
  const cwd = resolveGitCwd(args.cwd);
  const message = String(args.message != null ? args.message : '').trim();
  if (!message) return { ok: false, error: 'message 不能为空', hint: '请给这次提交写一句说明(例如「修好登录按钮」)。', cwd };
  const paths = Array.isArray(args.paths) ? args.paths.filter(p => typeof p === 'string' && p.trim() !== '') : [];
  const addAll = args.addAll !== false && paths.length === 0; // explicit paths override addAll
  // Stage. addAll → `git add -A`; else `git add -- <paths...>` (paths strictly after `--`).
  if (addAll) {
    const addRes = await runGit(['-C', cwd, 'add', '-A'], cwd, args.timeoutMs || 30000);
    if (!addRes.ok) return gitHumanError(addRes, cwd);
  } else if (paths.length) {
    const addRes = await runGit(['-C', cwd, 'add', '--', ...paths], cwd, args.timeoutMs || 30000);
    if (!addRes.ok) return gitHumanError(addRes, cwd);
  }
  // Commit. `-m <message>` as two separate array elements (no shell → no injection). No --no-verify: hooks
  // are honest behavior, gated by the exec-tier permission门.
  const res = await runGit(['-C', cwd, 'commit', '-m', message], cwd, args.timeoutMs || 30000);
  if (!res.ok) {
    // "nothing to commit" is a benign, common case — surface it as a clear 人话 result, not a scary error.
    const low = (String(res.stdout || '') + String(res.stderr || '')).toLowerCase();
    if (/nothing to commit|no changes added|nothing added to commit/.test(low)) {
      return { ok: false, error: '没有可提交的改动', hint: '工作区没有变化,或改动还没被暂存。先确认有改动再提交。', cwd, detail: (res.stdout || res.stderr || '').trim() };
    }
    return gitHumanError(res, cwd);
  }
  // Resolve the new commit's short hash for the return payload.
  const head = await runGit(['-C', cwd, 'rev-parse', '--short', 'HEAD'], cwd, 5000);
  const hash = head.ok ? String(head.stdout || '').trim() : '';
  return { ok: true, cwd, hash, message, summary: `已提交 ${hash ? hash + ' ' : ''}「${message}」`, output: (res.stdout || '').trim() };
}

async function dependencyInventory(root) {
  const cwd = path.resolve(root || process.cwd());
  const candidates = [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'requirements.txt',
    'pyproject.toml',
    'poetry.lock',
    'Pipfile',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'composer.json',
    '.tool-versions',
    '.node-version',
  ];
  const files = [];
  for (const rel of candidates) {
    const full = path.join(cwd, rel);
    if (fs.existsSync(full)) {
      files.push({ relativePath: rel, path: full, content: await readIfExists(full, 80000) });
    }
  }
  const packageJson = files.find(f => f.relativePath === 'package.json');
  let npm = null;
  if (packageJson) {
    const parsed = safeJsonParse(packageJson.content, {});
    npm = {
      scripts: parsed.scripts || {},
      dependencies: Object.keys(parsed.dependencies || {}),
      devDependencies: Object.keys(parsed.devDependencies || {}),
      engines: parsed.engines || {},
    };
  }
  return { ok: true, root: cwd, files: files.map(({ content, ...f }) => f), npm };
}

async function codeReviewScan(root, opts = {}) {
  const cwd = path.resolve(root || process.cwd());
  const files = await walkFiles(cwd, {
    recursive: true,
    maxFiles: opts.maxFiles || 1200,
    maxDepth: opts.maxDepth || 8,
    ignoreDirs: opts.ignoreDirs || ['node_modules', '.git', '.venv', 'dist', 'build', 'coverage', '.next', 'out', 'target'],
  });
  const patterns = [
    { id: 'hardcoded-secret', severity: 'high', re: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}/i, hint: 'Possible hardcoded credential' },
    { id: 'shell-exec', severity: 'medium', re: /\b(exec|execSync|Invoke-Expression|IEX|shell_exec|system)\s*\(/i, hint: 'Shell execution needs input validation' },
    { id: 'sql-concat', severity: 'medium', re: /(SELECT|UPDATE|DELETE|INSERT).{0,80}(\+|\$\{)/i, hint: 'Possible SQL string interpolation' },
    { id: 'xss-html', severity: 'medium', re: /(innerHTML|dangerouslySetInnerHTML|document\.write)\b/i, hint: 'HTML injection surface' },
    { id: 'broad-cors', severity: 'medium', re: /(Access-Control-Allow-Origin.{0,40}\*|cors\(\s*\))/i, hint: 'Review CORS policy' },
    { id: 'disabled-tls', severity: 'high', re: /(NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized\s*:\s*false)/i, hint: 'TLS verification disabled' },
    { id: 'todo-marker', severity: 'low', re: /\b(TODO|FIXME|HACK|XXX)\b/i, hint: 'Unresolved engineering note' },
  ];
  const findings = [];
  for (const file of files.filter(f => f.type === 'file')) {
    if (findings.length >= Number(opts.maxFindings || 300)) break;
    if (file.size > Number(opts.maxFileBytes || 1024 * 1024)) continue;
    if (!/\.(js|jsx|ts|tsx|py|ps1|sh|php|rb|go|rs|java|cs|html|vue|svelte|sql|env|json|yml|yaml)$/i.test(file.path)) continue;
    const raw = await readIfExists(file.path, Number(opts.maxFileBytes || 1024 * 1024));
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (/\{\s*id:\s*['"][\w-]+['"].*\bre:\s*\//.test(lines[i])) continue;
      for (const ptn of patterns) {
        if (ptn.re.test(lines[i])) {
          findings.push({
            id: ptn.id,
            severity: ptn.severity,
            path: file.path,
            relativePath: file.relativePath,
            line: i + 1,
            text: lines[i].trim().slice(0, 500),
            hint: ptn.hint,
          });
          break;
        }
      }
      if (findings.length >= Number(opts.maxFindings || 300)) break;
    }
  }
  const counts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  return { ok: true, root: cwd, counts, findings };
}

async function frontendAudit(root, opts = {}) {
  const cwd = path.resolve(root || process.cwd());
  const files = await walkFiles(cwd, {
    recursive: true,
    maxFiles: opts.maxFiles || 800,
    maxDepth: opts.maxDepth || 6,
    ignoreDirs: opts.ignoreDirs || ['node_modules', '.git', '.venv', 'dist', 'build', 'coverage', '.next', 'out', 'target'],
  });
  const issues = [];
  for (const file of files.filter(f => f.type === 'file' && /\.(html|css|js|jsx|ts|tsx|vue|svelte)$/i.test(f.path))) {
    if (file.size > 1024 * 1024) continue;
    const raw = await readIfExists(file.path, 1024 * 1024);
    const lines = raw.split(/\r?\n/).filter(line => !/\{\s*id:\s*['"][\w-]+['"].*\bre:\s*\//.test(line));
    const checks = [
      { id: 'external-asset', re: /https?:\/\/(cdn|fonts|unpkg|jsdelivr|cdnjs|googleapis|gstatic)\./i, hint: 'External CDN/font asset will fail offline' },
      { id: 'missing-viewport', re: /<html[\s\S]*<\/html>/i, hint: 'HTML page may need a viewport meta tag', custom: text => /<html[\s\S]*<\/html>/i.test(text) && !/<meta[^>]+viewport/i.test(text) },
      { id: 'negative-letter-spacing', re: /letter-spacing\s*:\s*-\d/i, hint: 'Negative letter spacing often hurts UI polish' },
      { id: 'viewport-font-scaling', re: /font-size\s*:\s*[^;]*(vw|vmin|vmax)/i, hint: 'Viewport-scaled font size can overflow controls' },
      { id: 'one-note-gradient', re: /(radial-gradient|linear-gradient).{0,80}(purple|violet|slate|blue)/i, hint: 'Review for generic gradient-heavy visual style' },
    ];
    for (const check of checks) {
      const match = check.custom ? check.custom(raw) : lines.some(line => {
        check.re.lastIndex = 0;
        return check.re.test(line);
      });
      if (match) issues.push({ id: check.id, path: file.path, relativePath: file.relativePath, hint: check.hint });
    }
  }
  return { ok: true, root: cwd, issues };
}

async function claudeMdAudit(root) {
  const cwd = path.resolve(root || process.cwd());
  const files = await walkFiles(cwd, { recursive: true, maxFiles: 400, maxDepth: 5, pattern: '(^|\\\\|/)CLAUDE\\.md$' });
  const audits = [];
  for (const f of files.filter(_ => _.type === 'file')) {
    const content = await readIfExists(f.path, 200000);
    const checks = [
      { id: 'purpose', ok: /purpose|overview|目标|说明/i.test(content) },
      { id: 'commands', ok: /test|build|lint|run|命令|测试|构建/i.test(content) },
      { id: 'style', ok: /style|convention|pattern|规范|约定/i.test(content) },
      { id: 'safety', ok: /permission|secret|credential|安全|权限|密钥/i.test(content) },
      { id: 'offline', ok: /offline|air.?gap|intranet|内网|离线/i.test(content) },
    ];
    audits.push({
      path: f.path,
      relativePath: f.relativePath,
      size: content.length,
      missing: checks.filter(c => !c.ok).map(c => c.id),
    });
  }
  return {
    ok: true,
    root: cwd,
    found: audits.length,
    audits,
    recommendation: audits.length === 0
      ? 'Create CLAUDE.md with project overview, commands, conventions, safety/offline notes.'
      : 'Update missing sections before relying on long-running agent work.',
  };
}

async function docsSearch(root, query, opts = {}) {
  const cwd = path.resolve(root || process.cwd());
  // v0.8-S3fix: normalize once via the shared sanitizer — the bare `new RegExp(query,'i')` here had the
  // same (?i)-inline-flag crash file_search fixed in S2fix (found by a live DeepSeek run). The
  // searchFileContent call below re-normalizes internally (idempotent for a normalized pattern).
  const nq = normalizeSearchPattern(query);
  let fileRe = null;
  try { fileRe = new RegExp(nq.pattern, 'i' + (nq.extraFlags || '')); } catch { fileRe = null; }
  const roots = [
    cwd,
    path.join(cwd, 'docs'),
    path.join(cwd, 'doc'),
    path.join(cwd, 'README.md'),
    path.join(cwd, 'CHANGELOG.md'),
  ];
  const matches = [];
  const seen = new Set();
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const stat = await fsp.stat(r).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      const content = await readIfExists(r, 400000);
      if (fileRe && fileRe.test(content)) matches.push({ path: r, relativePath: path.relative(cwd, r), line: 1, text: `File contains: ${query}` });
      continue;
    }
    const partial = await searchFileContent(r, query, {
      maxFiles: opts.maxFiles || 1500,
      maxResults: opts.maxResults || 200,
      maxDepth: opts.maxDepth || 8,
      ignoreDirs: opts.ignoreDirs || ['node_modules', '.git', '.venv', 'dist', 'build', 'coverage', '.next', 'out', 'target'],
    });
    for (const item of partial) {
      const key = `${item.path}:${item.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push(item);
      }
    }
  }
  return { ok: true, root: cwd, query, matches: matches.slice(0, Number(opts.maxResults || 200)) };
}

// ============================================================================
// v0.9-S9 — web_search / web_fetch (§0.9-S9, D6). SSRF防御 is the security核心 of this slice.
// ============================================================================
//
// SSRF防御 (web_fetch's url is MODEL/网页-supplied → UNTRUSTED). We block, BY LITERAL HOST, the address
// classes that a fetch must never reach: loopback, private RFC1918 ranges, link-local / cloud metadata
// (169.254.169.254), and the *.local/*.internal service-discovery suffixes. This is a HOST-string判定, not a
// DNS resolution — a domain that resolves to an internal IP (DNS rebinding) is a KNOWN LIMITATION of this
// zero-dependency slice (documented; the fix is a resolve-then-recheck, deferred). We DO block literal
// internal domains and IP literals, which covers the common misconfiguration + accidental-fetch cases.
//
// searchBackend.baseUrl (searxng/custom, and — v1.0-S6 — the tavily/bocha official-host override) is an
// ADMIN-configured TRUSTED endpoint → its outbound request is NOT run through this check (an admin may
// legitimately point web_search at an intranet searxng or a corporate search proxy). Only web_fetch's
// untrusted url is guarded. Keep that distinction explicit.
function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return false; // not a valid dotted-quad → not our concern here
  const [a, b] = o;
  if (a === 127) return true;                         // 127.0.0.0/8 loopback
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local + cloud metadata (…169.254)
  if (a === 100 && b >= 64 && b <= 127) return true;  // v1.4.1 (audit #12): 100.64.0.0/10 CGNAT/共享地址段
  if (a === 0) return true;                           // 0.0.0.0/8 (this host)
  return false;
}
// v0.9 F1: pull an embedded IPv4 out of an IPv4-mapped / IPv4-compatible IPv6 literal so isPrivateIpv4 can
// judge it. Handles: dotted-quad mapped (::ffff:127.0.0.1), hex mapped (::ffff:7f00:1), the bare-hex form
// without the ffff marker (::a9fe:a9fe — an IPv4-compatible-ish literal a scanner might use), and the
// deprecated IPv4-compatible dotted form (::127.0.0.1). Returns a dotted-quad string, or null when there is
// no embedded IPv4 to extract. Exported for direct e2e testing.
function embeddedIpv4FromV6(bareIn) {
  const bare = String(bareIn || '').toLowerCase();
  // 1) dotted-quad embedded: ::ffff:127.0.0.1  OR  deprecated ::127.0.0.1
  let m = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  if (m) return m[1];
  // 2) hex embedded (last two hextets): ::ffff:7f00:1  OR  bare ::a9fe:a9fe
  m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (m) {
    const h1 = parseInt(m[1], 16), h2 = parseInt(m[2], 16);
    if (Number.isFinite(h1) && Number.isFinite(h2)) {
      return `${(h1 >> 8) & 255}.${h1 & 255}.${(h2 >> 8) & 255}.${h2 & 255}`;
    }
  }
  return null;
}
// Return { allowed, reason?, host } for a candidate URL. Called on the initial url AND on every redirect hop.
function ssrfCheck(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return { allowed: false, reason: 'URL 无法解析', host: '' }; }
  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return { allowed: false, reason: '仅允许 http/https 协议', host: u.hostname };
  let host = String(u.hostname || '').toLowerCase();
  // Strip an IPv6 bracket form ([::1]) that URL leaves in hostname.
  const bare = host.replace(/^\[|\]$/g, '');
  // TEST HOOK (v1.1-W2): env WCW_TEST_ALLOW_LOOPBACK=1 permits 127.0.0.1 (loopback only) so the http_download
  // e2e can exercise the full guarded-fetch happy path against a local fake server. Mirrors the narrow
  // WCW_TEST_NO_NET_ANCHORS hook. DEFAULT OFF → zero production effect; only 127.0.0.1 is exempted (all other
  // private/link-local/metadata ranges + *.internal/*.local stay blocked even with the flag on).
  const testLoopback = process.env.WCW_TEST_ALLOW_LOOPBACK === '1' && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
  if (testLoopback) return { allowed: true, host: bare };
  // Loopback / link-local / metadata by literal host.
  if (bare === 'localhost' || bare === '::1' || bare === '::' || bare === '0.0.0.0') return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // IPv6 unique-local (fc00::/7 → fc/fd prefix) + link-local (fe80::) — literal判定.
  if (/^f[cd][0-9a-f]{0,2}:/.test(bare) || /^fe80:/.test(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // v0.9 F1: NAT64 well-known prefix (64:ff9b::/96) can smuggle an embedded IPv4 → refuse the whole prefix.
  if (/^64:ff9b:/.test(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // v0.9 F1: IPv4-mapped/compatible IPv6 literals ([::ffff:127.0.0.1], hex [::ffff:7f00:1], etc.) — extract the
  // embedded v4 and run it through the private-range check BEFORE the plain isPrivateIpv4(bare) (which only
  // sees dotted-quads). A mapped literal whose embedded v4 is PUBLIC (e.g. ::ffff:8.8.8.8) falls through and is
  // allowed (a legitimate public mapping). A ::ffff:-prefixed literal we cannot resolve to a v4 is refused as
  // suspicious rather than allowed.
  const embV4 = embeddedIpv4FromV6(bare);
  if (embV4) { if (isPrivateIpv4(embV4)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare }; }
  else if (/^::ffff:/.test(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // IPv4 literal private/loopback ranges.
  if (isPrivateIpv4(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  // Service-discovery suffixes that only ever名 internal hosts.
  if (/\.(local|internal)$/.test(bare)) return { allowed: false, reason: '目标地址不允许(内网/回环)', host: bare };
  return { allowed: true, host: bare };
}

// Zero-dependency main-text extraction from an HTML string (self-written, no npm). Steps:
//   1) drop <script>/<style>/<noscript> BLOCKS entirely (content + tags);
//   2) capture <title> before stripping;
//   3) turn block-level closing/opening tags into newlines so paragraph structure survives;
//   4) strip ALL remaining tags;
//   5) decode the common HTML entities;
//   6) collapse runs of blank space, keep paragraph newlines.
// Exported (module.exports) so the e2e can直测 it deterministically without any network.
const BLOCK_TAGS_RE = /<\/?(p|div|section|article|header|footer|main|br|hr|li|ul|ol|tr|table|h[1-6]|blockquote|pre|figure|nav|aside)\b[^>]*>/gi;
function decodeEntities(s) {
  return String(s)
    // v1.1-W1a (T3): numeric (&#174;) and hex (&#xAE;) entities — common in scraped search-result HTML.
    // Decode BEFORE the named set so &#38; → & doesn't then get re-read as a named entity opener. Guard the
    // codepoint range (fromCodePoint throws on invalid) — a bad ref is left as-is rather than crashing.
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const n = parseInt(h, 16); return (n >= 0 && n <= 0x10ffff) ? safeFromCodePoint(n, m) : m; })
    .replace(/&#(\d+);/g, (m, d) => { const n = parseInt(d, 10); return (n >= 0 && n <= 0x10ffff) ? safeFromCodePoint(n, m) : m; })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    // v1.1-W1a 把关补:实弹抽验发现 Bing 摘要含 &ensp; 未解码(「2013年8月27日&ensp;·&ensp;原始青花瓷…」)。
    // 补常见命名空白/标点实体;不认识的命名实体保持原样(不猜)。
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&thinsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”');
}
function safeFromCodePoint(n, fallback) { try { return String.fromCodePoint(n); } catch { return fallback; } }
function extractMainText(html) {
  let s = String(html == null ? '' : html);
  // 2) title first (before we strip the head).
  let title = '';
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  if (tm) title = decodeEntities(tm[1].replace(/\s+/g, ' ').trim()).slice(0, 300);
  // 1) drop the whole <head> (title/meta/link belong to metadata, not main text), then script/style/noscript
  // blocks and comments. The <head> strip is best-effort — a malformed page without a closing </head> keeps
  // its head content, which the later tag-strip still neutralizes.
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
       .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
       .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');
  // 3) block-level tags → newline (paragraph structure survives the tag strip).
  s = s.replace(BLOCK_TAGS_RE, '\n');
  // 4) strip every remaining tag.
  s = s.replace(/<[^>]+>/g, ' ');
  // 5) decode entities.
  s = decodeEntities(s);
  // 6) collapse whitespace: spaces/tabs within a line, then blank-line runs.
  s = s.replace(/[ \t\f\v ]+/g, ' ')
       .replace(/ *\n */g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim();
  return { title, text: s };
}

// Web cache: dataRoot/webcache/<sha256(url)>.json holding {url,title,text,ts}. Written after a successful
// fetch; read as an OFFLINE fallback (no TTL — an old copy is still useful when there is no network — but the
// stored ts is returned so the model can judge freshness). Exported for direct e2e read/write testing.
function webCachePath(url) {
  const h = crypto.createHash('sha256').update(String(url)).digest('hex');
  return path.join(paths.webcache, `${h}.json`);
}
async function readWebCache(url) {
  try {
    const raw = await fsp.readFile(webCachePath(url), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && typeof j.text === 'string') return j;
  } catch { /* miss */ }
  return null;
}
async function writeWebCache(entry) {
  try {
    await fsp.mkdir(paths.webcache, { recursive: true });
    await atomicWriteJson(webCachePath(entry.url), JSON.stringify(entry));   // 25.1 收编
  } catch { /* best-effort cache write; never fail the fetch on a cache error */ }
}

// v0.9 F2: resolve a hostname and refuse if ANY resolved address is private/loopback (DNS-rebinding /
// nip.io-style names that pass the literal ssrfCheck but resolve to internal IPs). Returns { blocked, host }
// when a private address is found, else null. A lookup failure (ENOTFOUND, etc.) returns null — we do NOT
// block on it; the subsequent fetch fails naturally. Never throws.
async function dnsResolvesToPrivate(hostname) {
  const bare = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  // Literal IPs are already judged by ssrfCheck — skip a pointless lookup.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) || bare.includes(':')) return null;
  let addrs;
  try { addrs = await require('dns').promises.lookup(bare, { all: true }); }
  catch { return null; } // ENOTFOUND / no network → let the real fetch fail
  for (const a of (addrs || [])) {
    const addr = String(a.address || '').toLowerCase();
    if (a.family === 4) { if (isPrivateIpv4(addr)) return { blocked: addr, host: bare }; continue; }
    // family 6: loopback / ULA / link-local, plus any embedded-v4 that is private.
    if (addr === '::1' || addr === '::') return { blocked: addr, host: bare };
    if (/^f[cd][0-9a-f]{0,2}:/.test(addr) || /^fe80:/.test(addr)) return { blocked: addr, host: bare };
    const v4 = embeddedIpv4FromV6(addr);
    if (v4 && isPrivateIpv4(v4)) return { blocked: addr, host: bare };
  }
  // v1.4.1 (audit #2):全部解析地址均为公网 → 回传这批地址,供 httpGetGuarded【锁定】连接到它们(避免 DNS
  // 重绑定 TOCTOU:http/https 各自独立二次 getaddrinfo,第二次可换成内网/元数据 IP)。
  return (addrs && addrs.length) ? { pin: addrs } : null;
}
// v1.1-W1a (T1): realistic browser request headers. The bare-bot UA (WCW-web_fetch/0.9) got connections
// killed by anti-scrape edges on many CN sites (bigmodel 等). A mainstream Chrome UA + zh Accept-Language +
// a rich Accept string reads as a real browser and gets served. This is a header change ONLY — the SSRF
// defense (per-hop ssrfCheck + dnsResolvesToPrivate) is untouched. Shared by web_fetch and the builtin
// web_search HTML backends so all outbound scraping speaks the same believable dialect.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
function browserHeaders(extra) {
  return Object.assign({
    'user-agent': BROWSER_UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }, extra || {});
}
// v1.1-W1a (T1): classify a low-level socket/HTTP error into a stable failClass the caller maps to 人话.
// 'dns' | 'connect' | 'reset' | 'tls' | 'timeout' | 'http' (with statusCode) | 'too-big' | 'other'.
function classifyFetchError(err) {
  const code = String((err && (err.code || err.errno)) || '');
  const msg = String((err && err.message) || '').toLowerCase();
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|enotfound|dns/.test(msg)) return 'dns';
  if (/timeout|etimedout|esockettimedout/.test(code.toLowerCase() + ' ' + msg)) return 'timeout';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || /aborted|socket hang up|reset|econnreset|epipe/.test(msg)) return 'reset';
  if (/cert|tls|ssl|handshake|self.signed|unable to verify|dh key|alt name|altnames|epROTO|wrong version/.test(code.toLowerCase() + ' ' + msg)) return 'tls';
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL' || /refused|unreachable/.test(msg)) return 'connect';
  return 'other';
}
// Low-level http(s) GET with a redirect chain, re-running ssrfCheck on EVERY hop (≤maxRedirects). Returns
// { ok, status, finalUrl, body(Buffer, ≤maxBytes), truncated } on success, else { ok:false, error, failClass,
//  statusCode?, blocked? }. v1.1-W1a: a 'reset' failure (对端掐线 / aborted) is retried ONCE automatically
// before surfacing — anti-scrape edges often reset the first probe but serve the second. Never throws.
function httpGetGuarded(rawUrl, { maxRedirects = 3, timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, userAgent = BROWSER_UA, rejectOverMaxBytes = false, _retriedReset = false } = {}) {
  return new Promise(resolve => {
    let hops = 0;
    const visit = async current => {
      const chk = ssrfCheck(current);
      if (!chk.allowed) { resolve({ ok: false, error: chk.reason, failClass: 'blocked', blocked: chk.host }); return; }
      let u;
      try { u = new URL(current); } catch { resolve({ ok: false, error: 'URL 无法解析', failClass: 'other' }); return; }
      // v0.9 F2 / v1.4.1 audit #2: DNS resolve-then-check —— 拒绝解析到内网的名字(rebinding 守护),并把已验证的
      // 公网地址【锁定】给本次连接(pinned lookup),使 http/https 不再独立二次解析(消除 TOCTOU 重绑定窗口)。
      const dnsRes = await dnsResolvesToPrivate(u.hostname);
      if (dnsRes && dnsRes.blocked) { resolve({ ok: false, error: '解析到内网地址', failClass: 'blocked', blocked: dnsRes.blocked }); return; }
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const reqOpts = { method: 'GET', timeout: timeoutMs, headers: browserHeaders({ 'user-agent': userAgent }) };
      const pin = dnsRes && dnsRes.pin;
      if (pin && pin.length) {
        // 锁定到已验证公网地址(literal IP / 解析失败 → dnsRes 为 null → 不 pin,literal 已被 ssrfCheck 判过)。
        reqOpts.lookup = (h, opts, cb) => { if (opts && opts.all) cb(null, pin); else cb(null, pin[0].address, pin[0].family); };
      }
      const req = lib.request(u, reqOpts, res => {
        const status = res.statusCode || 0;
        // Redirect handling — re-check every hop.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (hops >= maxRedirects) { resolve({ ok: false, error: `重定向次数超过上限(${maxRedirects})`, failClass: 'other' }); return; }
          hops++;
          let next;
          try { next = new URL(res.headers.location, u).toString(); } catch { resolve({ ok: false, error: '重定向地址无法解析', failClass: 'other' }); return; }
          visit(next);
          return;
        }
        // A non-2xx terminal status is an 'http' failClass carrying the code (403/503/… → 反爬/拒绝归因).
        if (status < 200 || status >= 300) {
          res.resume(); // drain — we don't need the error page body
          resolve({ ok: false, error: `HTTP ${status}`, failClass: 'http', statusCode: status, finalUrl: u.toString() });
          return;
        }
        // v1.1-W2 (T1): opt-in Content-Length pre-reject (http_download). When rejectOverMaxBytes is set and the
        // server advertises a length over maxBytes, refuse UP FRONT (no wasted download). webFetch never sets it
        // (its maxBytes is a soft truncation for main-text extraction) → unchanged.
        if (rejectOverMaxBytes) {
          const cl = Number(res.headers['content-length']);
          if (Number.isFinite(cl) && cl > maxBytes) {
            res.resume();
            resolve({ ok: false, error: `文件超过大小上限（Content-Length ${cl} > ${maxBytes}）`, failClass: 'too-big', contentLength: cl });
            return;
          }
        }
        const chunks = [];
        let total = 0, truncated = false;
        res.on('data', d => {
          if (truncated) return;
          total += d.length;
          if (total > maxBytes) { chunks.push(d.slice(0, Math.max(0, d.length - (total - maxBytes)))); truncated = true; try { req.destroy(); } catch { /* ignore */ } return; }
          chunks.push(d);
        });
        res.on('end', () => resolve({ ok: true, status, finalUrl: u.toString(), body: Buffer.concat(chunks), truncated, contentType: res.headers['content-type'] || null }));
        res.on('error', e => resolve({ ok: false, error: (e && e.message) || 'response error', failClass: classifyFetchError(e) }));
      });
      req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
      req.on('error', async e => {
        const failClass = classifyFetchError(e);
        // v1.1-W1a (T1): a 'reset'/aborted failure is often a transient anti-scrape blip → retry once.
        if (failClass === 'reset' && !_retriedReset) {
          const retry = await httpGetGuarded(rawUrl, { maxRedirects, timeoutMs, maxBytes, userAgent, _retriedReset: true });
          resolve(retry); return;
        }
        resolve({ ok: false, error: (e && e.message) || 'request error', failClass });
      });
      req.end();
    };
    visit(String(rawUrl));
  });
}

// web_fetch tool body. SSRF-guarded fetch → main-text extraction → cache write. On a fetch failure (offline),
// falls back to the on-disk cache (fromCache:true) so an air-gapped session can still reuse a prior fetch.
async function webFetch(args = {}) {
  const url = String(args.url || '').trim();
  const maxChars = Math.min(200000, Math.max(500, Number(args.maxChars) || 20000));
  if (!url) return { ok: false, error: 'url is required' };
  // Fast SSRF reject up-front (also blocks non-http/https + literal internal targets) — a blocked target
  // never even attempts a socket, and NEVER falls back to cache (a blocked url must not leak cached content).
  const pre = ssrfCheck(url);
  if (!pre.allowed) return { ok: false, error: pre.reason, blocked: pre.host };
  const got = await httpGetGuarded(url);
  if (got.ok && got.body) {
    const html = got.body.toString('utf8');
    const { title, text } = extractMainText(html);
    const clipped = text.slice(0, maxChars);
    const entry = { url: got.finalUrl || url, title, text: clipped, ts: nowIso() };
    await writeWebCache(entry);
    // v1.1-W1a (T2): a real successful fetch is fresh proof we are online — nudge the capability cache so a
    // stale/single-target offline reading gets corrected for free.
    markNetworkOnline();
    return { ok: true, url: entry.url, title, text: clipped, truncated: got.truncated || clipped.length < text.length, fromCache: false, ts: entry.ts };
  }
  // A guard-level block during a redirect hop → surface it as blocked, do NOT serve cache.
  if (got.blocked) return { ok: false, error: got.error, blocked: got.blocked };
  // v1.1-W1a (T1): the fetch failed. Map the structured failClass to 中文人话 — NEVER blindly claim "离线".
  const mapped = webFetchFailMessage(got);
  // Cache fallback still applies (an air-gapped session reuses a prior fetch).
  const cached = await readWebCache(url);
  if (cached) return { ok: true, url: cached.url || url, title: cached.title || '', text: String(cached.text || '').slice(0, maxChars), truncated: false, fromCache: true, ts: cached.ts || null, staleReason: mapped.error };
  // No cache. Decide the hint by a FAST live probe (multi-target, 2s) — only if that also fails do we say 离线.
  const online = await probeAny(networkAnchors(await readConfig().catch(() => ({}))), 2000);
  let hint = mapped.hint;
  if (online === false) hint = '当前疑似离线。' + '联网后重试,或先在线抓取一次以建立缓存';
  else markNetworkOnline(); // the probe just succeeded → refresh the cap cache
  return { ok: false, error: mapped.error, failClass: got.failClass || 'other', statusCode: got.statusCode, hint };
}

// v1.1-W1a (T1): failClass → 中文人话 message + a targeted next-step hint. The message is ACCURATE about the
// real failure (反爬/证书/解析/超时…) instead of the old blanket "离线". The hint is refined afterward by a live
// probe in webFetch (online 反爬 → 建议改用 web_search;确证离线 → 原缓存提示).
function webFetchFailMessage(got) {
  const fc = (got && got.failClass) || 'other';
  const code = got && got.statusCode;
  switch (fc) {
    case 'dns': return { error: '域名解析失败(网址可能不存在)', hint: '检查网址拼写是否正确' };
    case 'connect': return { error: '无法连接到该网站', hint: '确认网址可访问,或稍后重试' };
    case 'reset': return { error: '对方服务器中断了连接(可能有反爬限制)', hint: '可尝试用 web_search 搜索该内容替代' };
    case 'tls': return { error: 'HTTPS 证书/握手失败', hint: '该站点的安全证书异常,谨慎访问' };
    case 'timeout': return { error: '抓取超时', hint: '网站响应过慢,稍后重试或换个来源' };
    case 'http': {
      if (code === 403 || code === 401) return { error: `网站拒绝了请求(HTTP ${code},可能反爬)`, hint: '可尝试用 web_search 搜索该内容替代' };
      if (code === 429) return { error: `请求过于频繁被限流(HTTP ${code})`, hint: '稍后再试' };
      if (code === 503 || code === 502 || code === 504) return { error: `网站暂时不可用(HTTP ${code})`, hint: '稍后重试' };
      if (code === 404 || code === 410) return { error: `页面不存在(HTTP ${code})`, hint: '检查网址是否正确' };
      return { error: `网站返回了错误(HTTP ${code || '?'})`, hint: '换个来源或稍后重试' };
    }
    default: return { error: (got && got.error) || '抓取失败', hint: '稍后重试或换个来源' };
  }
}

// v1.1-W1a (T3): strip tags + decode entities + collapse whitespace from an HTML fragment → a plain snippet.
// Truncated to ≤300 chars. Defensive: any input coerces to a string first.
function htmlFragmentToText(frag) {
  return decodeEntities(String(frag == null ? '' : frag).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 300);
}
// v1.1-W1a (T3): parse Bing (cn.bing.com) result HTML. Each hit is an <li class="b_algo"> block; title+url
// live in its <h2><a href="…">…</a></h2>, the snippet in a <p> (often class b_lineclamp*/b_caption). Regex
// string-scan (no DOM lib — zero deps). Fully defensive: a markup change yields fewer/zero results, never a
// throw. Returns [{title,url,snippet,source:'bing'}].
function parseBingHtml(html, limit) {
  const out = [];
  const s = String(html || '');
  // Split on the algo blocks; each chunk after the first starts inside one b_algo <li>.
  const blocks = s.split(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    // First anchor inside an <h2> is the title/url. Fall back to the first anchor with an http(s) href.
    let m = /<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!m) m = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!m) continue;
    const url = decodeEntities(m[1]).trim();
    const title = htmlFragmentToText(m[2]);
    if (!/^https?:\/\//i.test(url) || !title) continue;
    // Snippet: prefer a <p> (Bing caption); else the first div with a caption-ish class.
    let sm = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    if (!sm) sm = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const snippet = sm ? htmlFragmentToText(sm[1]) : '';
    out.push({ title, url, snippet, source: 'bing' });
  }
  return out;
}
// v1.1-W1a (T3): parse 百度 (www.baidu.com/s) result HTML. Each hit is a <div class="result c-container …">
// block; the title anchor is its first <h3><a href="…">…</a> (百度 hands back a redirect link — 照收). The
// snippet is best-effort from a content div/span. Defensive; returns [{title,url,snippet,source:'baidu'}].
function parseBaiduHtml(html, limit) {
  const out = [];
  const s = String(html || '');
  const blocks = s.split(/<div[^>]*class="[^"]*\bresult\b[^"]*\bc-container\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    let m = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!m) m = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!m) continue;
    const url = decodeEntities(m[1]).trim();
    const title = htmlFragmentToText(m[2]);
    if (!url || !title) continue;
    // Snippet: 百度's abstract lives in a span/div with a content-ish class; fall back to the first <p>.
    let sm = /<[^>]*class="[^"]*(?:content-right|c-abstract|content_right)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(block);
    if (!sm) sm = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = sm ? htmlFragmentToText(sm[1]) : '';
    out.push({ title, url, snippet, source: 'baidu' });
  }
  return out;
}
// v1.1-W1a (T3): the builtin no-key search. Bing CN first; if it errors or returns <1 result, fall back to
// 百度. Both空 → ok:true with an empty list + a note (an empty result set is NOT an error). baseUrlOverride
// (admin-trusted) replaces the Bing root for e2e; when set, the 百度 fallback is skipped so a fake server
// deterministically owns the whole path. GET requests use the realistic browser headers (T1).
async function builtinSearch(query, maxResults, baseUrlOverride, timeoutMs) {
  const enc = encodeURIComponent(query);
  const bingRoot = baseUrlOverride || 'https://cn.bing.com';
  const bingUrl = `${bingRoot}/search?q=${enc}&count=${maxResults}`;
  let bingResults = [];
  try {
    const r = await httpRequest({ url: bingUrl, headers: browserHeaders(), timeoutMs, maxBodyChars: 800000 });
    if (r.ok && typeof r.body === 'string') bingResults = parseBingHtml(r.body, maxResults);
  } catch { /* fall through to 百度 */ }
  if (bingResults.length >= 1) { markNetworkOnline(); return { ok: true, results: bingResults.slice(0, maxResults), backend: 'builtin', engine: 'bing' }; }
  // baseUrl override present → the operator/e2e redirected the engine; do NOT leak to the real 百度.
  if (baseUrlOverride) return { ok: true, results: [], backend: 'builtin', engine: 'bing', note: 'Bing 未返回结果(已覆写引擎地址,跳过百度兜底)' };
  // Fallback: 百度.
  let baiduResults = [];
  try {
    const r = await httpRequest({ url: `https://www.baidu.com/s?wd=${enc}&rn=${maxResults}`, headers: browserHeaders(), timeoutMs, maxBodyChars: 800000 });
    if (r.ok && typeof r.body === 'string') baiduResults = parseBaiduHtml(r.body, maxResults);
  } catch { /* both empty → note below */ }
  if (baiduResults.length >= 1) { markNetworkOnline(); return { ok: true, results: baiduResults.slice(0, maxResults), backend: 'builtin', engine: 'baidu' }; }
  return { ok: true, results: [], backend: 'builtin', note: '两个引擎都未返回结果' };
}

// web_search tool body. Fans out by searchBackend.type. searxng/custom baseUrl is TRUSTED (admin-configured)
// → NOT SSRF-checked (see note atop this section). Returns {ok, results:[{title,url,snippet}], backend}.
async function webSearch(args, config) {
  const query = String(args && args.query || '').trim();
  const maxResults = Math.min(20, Math.max(1, Number(args && args.maxResults) || 5));
  const sb = (config && config.searchBackend) || { type: 'none' };
  const backend = sb.type || 'none';
  if (!query) return { ok: false, error: 'query is required', backend };
  if (backend === 'none') return { ok: false, error: '未配置搜索后端', hint: '到 设置→搜索后端 选择 内置免费搜索(builtin)/searxng/bing/brave/tavily/bocha/custom', backend };
  const baseUrl = String(sb.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(sb.apiKey || '').trim();
  const timeoutMs = Number(args && args.timeoutMs) || 12000;
  try {
    // v1.1-W1a (T3): 'builtin' — zero-config, no-key HTML search. Primary Bing CN, 兜底 百度. Both scraped
    // with the realistic browser headers (T1) so anti-scrape edges serve real HTML. Fully defensive parsing
    // (a shape change collapses to [] rather than throwing). Results are JSON text only — the front-end renders
    // them via textContent, so no XSS surface. baseUrl override (admin-trusted, 同 searxng 先例) redirects the
    // Bing root for e2e determinism; when set, the 百度 fallback is skipped (the fake server owns both paths).
    if (backend === 'builtin') return await builtinSearch(query, maxResults, baseUrl, timeoutMs);
    if (backend === 'searxng') {
      if (!baseUrl) return { ok: false, error: 'searxng baseUrl 未配置', backend };
      const u = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
      const r = await httpRequest({ url: u, timeoutMs, maxBodyChars: 500000 });
      if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.statusCode), backend };
      const body = safeJsonParse(r.body, null);
      const rows = (body && Array.isArray(body.results)) ? body.results : [];
      const results = rows.slice(0, maxResults).map(x => ({ title: String(x.title || ''), url: String(x.url || ''), snippet: String(x.content || x.snippet || '') }));
      return { ok: true, results, backend };
    }
    if (backend === 'bing') {
      const u = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const r = await httpRequest({ url: u, headers: { 'Ocp-Apim-Subscription-Key': apiKey }, timeoutMs, maxBodyChars: 500000 });
      if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.statusCode), backend };
      const body = safeJsonParse(r.body, null);
      const rows = (body && body.webPages && Array.isArray(body.webPages.value)) ? body.webPages.value : [];
      const results = rows.slice(0, maxResults).map(x => ({ title: String(x.name || ''), url: String(x.url || ''), snippet: String(x.snippet || '') }));
      return { ok: true, results, backend };
    }
    if (backend === 'brave') {
      const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const r = await httpRequest({ url: u, headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' }, timeoutMs, maxBodyChars: 500000 });
      if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.statusCode), backend };
      const body = safeJsonParse(r.body, null);
      const rows = (body && body.web && Array.isArray(body.web.results)) ? body.web.results : [];
      const results = rows.slice(0, maxResults).map(x => ({ title: String(x.title || ''), url: String(x.url || ''), snippet: String(x.description || '') }));
      return { ok: true, results, backend };
    }
    // v1.0-S6 (A): Tavily (AI 搜索 API). POST /search, JSON {api_key, query, max_results}; parse
    // results[].{title,url,content}. baseUrl override — searchBackend.baseUrl, when non-empty, REPLACES the
    // official host (enterprise proxy + e2e fake server). baseUrl is an ADMIN-configured TRUSTED endpoint
    // (同 searxng 先例) → NOT SSRF-checked. Empty → official https://api.tavily.com. Defensive parse: a
    // missing/невалид results array yields an empty list, never a crash.
    if (backend === 'tavily') {
      const root = baseUrl || 'https://api.tavily.com';
      const u = `${root}/search`;
      const payload = JSON.stringify({ api_key: apiKey, query, max_results: maxResults });
      const r = await httpRequest({ url: u, method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, timeoutMs, maxBodyChars: 500000 });
      if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.statusCode), backend };
      const body = safeJsonParse(r.body, null);
      const rows = (body && Array.isArray(body.results)) ? body.results : [];
      const results = rows.slice(0, maxResults).map(x => ({ title: String((x && x.title) || ''), url: String((x && x.url) || ''), snippet: String((x && x.content) || '') }));
      return { ok: true, results, backend };
    }
    // v1.0-S6 (A): 博查 Bocha (中文搜索 API). POST /v1/web-search, Header Authorization: Bearer <key>,
    // JSON {query, count}; parse data.webPages.value[].{name,url,snippet} (按官方公开文档形状). baseUrl
    // override同上 (TRUSTED, not SSRF'd); empty → official https://api.bochaai.com. Fully defensive: any
    // missing hop in data.webPages.value collapses to an empty list, никогда crashes.
    if (backend === 'bocha') {
      const root = baseUrl || 'https://api.bochaai.com';
      const u = `${root}/v1/web-search`;
      const payload = JSON.stringify({ query, count: maxResults });
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers['authorization'] = 'Bearer ' + apiKey;
      const r = await httpRequest({ url: u, method: 'POST', headers, body: payload, timeoutMs, maxBodyChars: 500000 });
      if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.statusCode), backend };
      const body = safeJsonParse(r.body, null);
      const rows = (body && body.data && body.data.webPages && Array.isArray(body.data.webPages.value)) ? body.data.webPages.value : [];
      const results = rows.slice(0, maxResults).map(x => ({ title: String((x && x.name) || ''), url: String((x && x.url) || ''), snippet: String((x && x.snippet) || '') }));
      return { ok: true, results, backend };
    }
    // custom: GET {baseUrl}?q=… ; best-effort parse of common {title,url,snippet} field shapes.
    if (backend === 'custom') {
      if (!baseUrl) return { ok: false, error: 'custom baseUrl 未配置', backend };
      const sep = baseUrl.includes('?') ? '&' : '?';
      const u = `${baseUrl}${sep}q=${encodeURIComponent(query)}`;
      const headers = {};
      if (apiKey) headers['authorization'] = 'Bearer ' + apiKey;
      const r = await httpRequest({ url: u, headers, timeoutMs, maxBodyChars: 500000 });
      if (!r.ok) return { ok: false, error: r.error || ('HTTP ' + r.statusCode), backend };
      const body = safeJsonParse(r.body, null);
      const rows = Array.isArray(body) ? body : (body && (body.results || body.items || body.data)) || [];
      const list = Array.isArray(rows) ? rows : [];
      const results = list.slice(0, maxResults).map(x => ({
        title: String((x && (x.title || x.name || x.heading)) || ''),
        url: String((x && (x.url || x.link || x.href)) || ''),
        snippet: String((x && (x.snippet || x.content || x.description || x.summary)) || ''),
      }));
      return { ok: true, results, backend };
    }
    return { ok: false, error: '未知搜索后端: ' + backend, backend };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'search failed', hint: '检查搜索后端地址/密钥与联网状态', backend };
  }
}

async function httpRequest(args = {}) {
  const target = String(args.url || '');
  if (!/^https?:\/\//i.test(target)) throw new Error('url must start with http:// or https://');
  const lib = target.startsWith('https://') ? require('https') : require('http');
  const method = String(args.method || 'GET').toUpperCase();
  const body = args.body === undefined ? null : String(args.body);
  const timeoutMs = Number(args.timeoutMs || 20000);
  const maxChars = Number(args.maxBodyChars || 200000);
  // v1.4.1 (audit #11):此前把整个响应体缓冲进内存再截断 —— 恶意/失控端点可无上限撑爆内存。加【字节硬顶】,
  // 超顶即返回已收的截断体并 destroy 连接停止下载。done 守护防双 resolve / 防 destroy 后的 error 事件误触。
  const hardCap = Math.max(1, maxChars) * 4 + 65536; // utf8 每字符 ≤4 字节 + 余量
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };
    const req = lib.request(target, { method, headers: args.headers || {}, timeout: timeoutMs }, res => {
      const chunks = []; let total = 0;
      res.on('data', d => {
        if (done) return;
        chunks.push(d); total += d.length;
        if (total >= hardCap) {
          finish({ ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, maxChars), truncated: true });
          try { req.destroy(); } catch { /* ignore */ }
        }
      });
      res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, maxChars), truncated: false }));
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.on('error', error => finish({ ok: false, error: error.message }));
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================================
// v1.1-W2 (T1) — 零依赖 ZIP 编解码器 + 五个新内建工具的实现辅助函数。
// ============================================================================
// 【格式说明·把关人可据此审】本 ZIP 读写器只用 Node 内建 zlib（deflateRawSync / inflateRawSync）+ 手写的
// CRC32、local file header、central directory、EOCD。故意 NOT 用 stored 模式（不压缩）——deflate 已内建，无
// 任何 npm 依赖，压缩率还更好。仅实现 ZIP 规范的一个安全子集：
//   • 压缩方法：写入统一用 method 8 (deflate)；空文件退化为 method 0 (stored, size 0)。读取仅认 0/8，其它报错。
//   • 无加密、无 zip64、无 data descriptor（写入端把 CRC/size 直接写进 local header，因为我们先算好再写）。
//   • 文件名一律用 '/' 分隔（ZIP 规范要求），并置 general-purpose bit 11（UTF-8 flag）→ 中文文件名正确往返。
//   • 目录条目名以 '/' 结尾、大小为 0。
//
// CRC32：标准 IEEE 多项式 0xEDB88320 的反射查表实现（256 项预计算表，纯 JS，无依赖）。与 PKZIP/zlib 兼容。
const CRC32_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ (-1)) >>> 0; // >>>0 → 无符号 32 位
}

// ZIP 大小 / 数量护栏（zip 炸弹与体积防御）。
const ZIP_MAX_SINGLE_FILE = 100 * 1024 * 1024;   // 单文件 100MB（打包时）
const ZIP_MAX_TOTAL = 500 * 1024 * 1024;         // 总量 500MB（打包 + 解压累计）
const ZIP_MAX_ENTRIES = 2000;                    // 解压条目数上限（zip 炸弹）

// 收集要打包的路径（文件或文件夹）→ 一个 {name, data} 平面列表。name 是 ZIP 内的相对路径（'/' 分隔）。
// baseName = 该顶层路径在包内的根名（文件夹用其 basename，文件用 basename）。递归遍历文件夹；符号链接跳过。
// 累计大小 > ZIP_MAX_TOTAL 或单文件 > ZIP_MAX_SINGLE_FILE → 抛人话错误（调用方转 {ok:false}）。
async function zipCollectEntries(rootPaths) {
  const entries = []; // {name, data:Buffer, isDir}
  let total = 0;
  const addFile = async (absPath, zipName) => {
    const st = await fsp.lstat(absPath);
    if (st.isSymbolicLink()) return; // 安全：符号链接不入包（避免打进包外内容）
    if (st.isDirectory()) {
      entries.push({ name: zipName.replace(/\/?$/, '/'), data: Buffer.alloc(0), isDir: true });
      const kids = await fsp.readdir(absPath);
      for (const kid of kids.sort()) await addFile(path.join(absPath, kid), zipName + '/' + kid);
      return;
    }
    if (!st.isFile()) return;
    if (st.size > ZIP_MAX_SINGLE_FILE) throw new Error(`单个文件超过上限（${Math.round(ZIP_MAX_SINGLE_FILE / 1024 / 1024)}MB）：${path.basename(absPath)}`);
    total += st.size;
    if (total > ZIP_MAX_TOTAL) throw new Error(`打包总大小超过上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB）`);
    const data = await fsp.readFile(absPath);
    entries.push({ name: zipName, data, isDir: false });
  };
  for (const raw of rootPaths) {
    const abs = path.resolve(String(raw));
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st) throw new Error(`路径不存在：${raw}`);
    await addFile(abs, path.basename(abs));
  }
  return entries;
}

// 把 {name,data,isDir} 条目数组写成一个 ZIP Buffer。deflate 压缩（空数据 stored）。手写 local header +
// central directory + EOCD。返回完整 Buffer。文件名用 UTF-8 字节 + flag bit 11。
function zipWrite(entries) {
  const localParts = []; // 各条目的 [localHeader, filename, compressedData]
  const central = [];    // central directory 记录
  let offset = 0;        // 当前 local header 的绝对偏移（EOCD/central 用）
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    let method, comp;
    if (e.data.length === 0) { method = 0; comp = Buffer.alloc(0); } // 空文件/目录 → stored, size 0
    else { method = 8; comp = zlib.deflateRawSync(e.data); }        // deflate（内建 zlib）
    // ---- local file header (0x04034b50) ----
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // general purpose flag: bit 11 = UTF-8 文件名
    lh.writeUInt16LE(method, 8);        // compression method
    lh.writeUInt16LE(0, 10);            // mod time（不记录 → 0）
    lh.writeUInt16LE(0x21, 12);         // mod date（0 非法, 用一个合法占位 1980-01-01）
    lh.writeUInt32LE(crc, 14);          // crc32
    lh.writeUInt32LE(comp.length, 18);  // compressed size
    lh.writeUInt32LE(e.data.length, 22);// uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // extra field length
    localParts.push(lh, nameBuf, comp);
    // ---- central directory header (0x02014b50) ----
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);            // version made by
    cd.writeUInt16LE(20, 6);            // version needed
    cd.writeUInt16LE(0x0800, 8);        // flag bit 11 UTF-8
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);            // mod time
    cd.writeUInt16LE(0x21, 14);         // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra len
    cd.writeUInt16LE(0, 32);            // comment len
    cd.writeUInt16LE(0, 34);            // disk number
    cd.writeUInt16LE(0, 36);            // internal attrs
    cd.writeUInt32LE(e.isDir ? 0x10 : 0, 38); // external attrs: 目录置 FILE_ATTRIBUTE_DIRECTORY
    cd.writeUInt32LE(offset, 42);       // 相对 local header 偏移
    central.push(Buffer.concat([cd, nameBuf]));
    offset += lh.length + nameBuf.length + comp.length;
  }
  const localBlob = Buffer.concat(localParts);
  const centralBlob = Buffer.concat(central);
  // ---- EOCD (0x06054b50) ----
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);            // disk
  eocd.writeUInt16LE(0, 6);            // cd start disk
  eocd.writeUInt16LE(entries.length, 8);  // entries this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBlob.length, 12); // central dir size
  eocd.writeUInt32LE(localBlob.length, 16);   // central dir offset (= 所有 local 之后)
  eocd.writeUInt16LE(0, 20);          // comment len
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

// 从 ZIP Buffer 解析 central directory → [{name, method, compSize, uncompSize, crc, localOffset, isDir}]。
// 手动找 EOCD（从尾部倒扫 0x06054b50），读 central dir 偏移与条目数，逐条读 central header。只读元数据，不解压。
// 损坏/非 ZIP → 抛人话错误。
function zipReadCentralDir(buf) {
  // 从尾部倒扫 EOCD 签名（comment 可变长，但我们写入端 comment=0；仍倒扫以兼容外部 zip）。
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('不是有效的 ZIP 文件（找不到结尾记录）');
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP 目录结构越界（文件可能损坏）');
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 目录记录签名错误（文件可能损坏）');
    const flag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    // flag bit 11 = UTF-8；ZIP 传统上非 UTF-8 用 CP437。我们只可靠支持 UTF-8（bit 11）与纯 ASCII 名。
    const nameBuf = buf.slice(p + 46, p + 46 + nameLen);
    const name = nameBuf.toString('utf8');
    const isDir = name.endsWith('/') || (externalAttrs & 0x10) !== 0;
    // Unix 符号链接：external attrs 高 16 位是 st_mode，S_IFLNK = 0xA000。跳过（安全）。
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0xF000) === 0xA000;
    out.push({ name, method, crc, compSize, uncompSize, localOffset, isDir, isSymlink, flag });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// 从 ZIP Buffer + 一条 central 记录取出解压后的数据 Buffer。读 local header 定位数据区，按 method 解压。
// method 0 = stored（原样切片）；method 8 = deflate（inflateRawSync）；其它 → 抛「不支持」。累计解压字节由调用方卡上限。
function zipReadEntryData(buf, rec) {
  // local header：签名 4 + 26 字节固定 → name/extra 长度在 26/28 偏移。
  const lo = rec.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('ZIP 条目头签名错误（文件可能损坏）');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const comp = buf.slice(dataStart, dataStart + rec.compSize);
  if (rec.method === 0) return comp; // stored
  if (rec.method === 8) {
    // 把关加固(收官复核):单条目 inflate 硬上限。没有它,高压缩比的【单个】条目(zip 炸弹,几百 KB 压缩
    // 体可展开出数十 GB)会在调用方的累计限额检查【之前】就被 inflateRawSync 全量展开吃爆内存——累计上限
    // 只防多条目,不防单条目。maxOutputLength 让 zlib 在超限处即刻中止,这里映射成人话。
    try { return zlib.inflateRawSync(comp, { maxOutputLength: ZIP_MAX_TOTAL }); }
    catch (e) {
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|output.*length|too (large|big)/i.test(String(e && e.message || '')))) {
        throw new Error(`单个条目解压后超过大小上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB），疑似 zip 炸弹，已拒绝`);
      }
      throw e;
    }
  }
  throw new Error(`不支持的压缩方式（method ${rec.method}），仅支持 stored/deflate`);
}

// v1.1-W2 (T1) — http_download 的落盘目标护栏。thread 进来的 ctx 可能带 session/config（provider 引擎路径）
// 或不带（MCP child 路径）。带 → 走 guardWorkspacePath（realpath + fileAllowedRoots）；不带 → 退化护栏：
// dest 的父目录必须在 dataRoot 或 process.cwd 下（与文件工具「落盘落在工作区」同精神，绝不写系统任意路径）。
// 返回 {ok, absPath?} 或 {ok:false, error}。dest 尚不存在时对其父目录做包含判定。
async function guardDownloadDest(rawDest, ctx) {
  const dest = String(rawDest || '');
  if (!dest || !path.isAbsolute(dest)) return { ok: false, error: '下载目标必须是绝对路径' };
  const abs = path.resolve(dest);
  const session = ctx && ctx.session ? ctx.session : null;
  const config = ctx && ctx.config ? ctx.config : null;
  if (session || config) {
    // dest 可能尚不存在 → guardWorkspacePath 对不存在的路径 realpath 回退为自身，再做包含判定，OK。
    const g = await guardWorkspacePath(abs, session, config);
    if (!g.ok) return { ok: false, error: g.error || '下载目标不在允许的工作区内' };
    return { ok: true, absPath: g.absPath };
  }
  // 退化路径（无 session/config）：父目录须在 dataRoot 或当前工作目录下。
  const parent = path.dirname(abs);
  const roots = [dataRoot(), process.cwd()].map(r => path.resolve(r));
  const realParent = await fsp.realpath(parent).catch(() => parent);
  const realRoots = await Promise.all(roots.map(r => fsp.realpath(r).catch(() => r)));
  if (!pathWithinAnyRoot(realParent, realRoots)) return { ok: false, error: '下载目标不在允许的工作区内' };
  return { ok: true, absPath: abs };
}

// v0.8-S4a: `ctx` optionally carries checkpoint-journal context {sessionId, turnSeq}. The provider loop
// passes its live session.id/turnSeq; the MCP child passes nothing (journalSessionCtx resolves both from
// the injected WCW_SESSION_ID env + the session file). File-mutating tools (file_write/file_edit/
// file_delete) record a `before` checkpoint immediately before executing.
async function adaptiveCatalogForMcp(config) {
  const native = MCP_TOOLS
    .filter(t => t && t.name && !t.name.startsWith('tool_invoke_') && t.name !== 'tool_load')
    .map(t => ({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } }));
  let bridged = { tools: [], route: {} };
  try { bridged = await collectBridgedTools(config); } catch { /* native-only catalog is still useful */ }
  return { bridged, catalog: buildToolCatalog(native.concat(bridged.tools), bridged.route, config) };
}
