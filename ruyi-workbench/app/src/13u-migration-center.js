// ============================================================================
// 13u 迁移中心(W2;56 号文 §3 + 用户 2026-09-24 原话「让用户无痛迁移…包括把老的如意迁移到新的如意里;
// 要注意如意的安装包可能是在电脑里的任意位置」)。
//
// 两件事,一个面:
//   ① 从 Claude Code / Codex / Kimi Code 导入:全局指令文件(06d syncAgentInstructionImports,导成核心记忆)、
//      MCP(01 classifyAgentMcpCandidate,与启动期自动导入同一个判据)、技能(12 loadSkillRegistry 活读)。
//   ② 老版本如意 → 当前包:所有包共用一个数据根,配置/会话/记忆本来就是同一份;真正会断的是【别处存着的
//      指向老包目录的绝对路径】(56 号文 §3.1 的实例:~/.claude.json 的 ai-computer-control 指着
//      dist/Ruyi-v1.6.7-full/…/python.exe)。本模块只从「登记表 + 各处配置里的绝对路径」认老包,不全盘扫描;
//      路径落在【另一个】如意包根(00 ruyiPackageInfo 的标记)里、且当前包有同相对路径的文件 → 提议改写;
//      没有对应文件的 MCP 条目 → 提议移除。应用前每个文件先备份(<file>.bak-ruyi-migrate-<ts>),改动写进
//      迁移日志 <data>/migrations/<ts>.json,「撤销」按日志逐项反向改回(只改回我们改过、且此后没人再动的值)。
//   ③ 删老包:只「移到回收站」,不做永久删除;拒绝当前包、拒绝仍在运行的包、拒绝仍被引用的包、拒绝装着数据根的目录。
//
// 替用户做的默认决定(56 号文 §3.3 三条,报告里写明、用户可推翻):一键全改,但预览里逐项勾选(默认全勾);
// 删老包只进回收站;老包一次列全;旧名 MCP 条目(如 ai-computer-control)新包里有对应文件就改路径,否则提议移除。
//
// 本模块【零入边】:消费点(13b 的 /api/migration/* 路由)只经 00-boot 的 MigrationHooks 调进来;它自己只向
// 更早的模块取符号 —— 依赖图上不添前向边、不进循环。
// ============================================================================

const MIGRATION_LOG_SCHEMA = 1;
const MIGRATION_BACKUP_TAG = '.bak-ruyi-migrate-';
const MIGRATION_SIZE_BUDGET_MS = 6000;       // 一次扫描里算目录大小的总时间预算(超了就报「至少 X」)
const MIGRATION_SIZE_FILE_CAP = 80000;       // 单个包最多数这么多个文件
const MIGRATION_SIZE_TTL_MS = 10 * 60 * 1000;
const MIGRATION_EXTERNAL_SOURCES = Object.freeze(['claude-code', 'codex', 'kimi', 'claude-plugin']);
const migrationSizeCache = new Map();        // 包根键 -> { at, bytes, files, capped }
let migrationChain = Promise.resolve();

function migrationSerial(fn) {
  const job = migrationChain.then(fn);
  migrationChain = job.catch(() => {});
  return job;
}
function migrationDir() { return path.join(paths.data, 'migrations'); }
function migrationStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function migrationHash(text) { return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 12); }
function migrationCurrentRoot() { return path.resolve(externalRoot()); }
// childKey / parentKey 都是 samePathKey 的结果:child 就是 parent,或在 parent 之下。
function migrationPathInside(childKey, parentKey) {
  return childKey === parentKey || childKey.startsWith(parentKey + '\\') || childKey.startsWith(parentKey + '/');
}

// ── 引用扫描:各处配置里指向「另一个如意包」的字符串 ─────────────────────────────────────────────
// 一个值(可能是 ; 分隔的路径表)里指向老包的段 → 改写方案。newValue 为 null = 至少一段在当前包里没有对应文件。
// encode:TOML 基本字符串里反斜杠是转义过的(我们的迷你解析器不反转义),写回时按原样式编码。
function migrationAnalyzeValue(value, ctx, encode) {
  const s = String(value == null ? '' : value);
  if (!s || s.length > 4000) return null;
  const parts = process.platform === 'win32' && s.includes(';') ? s.split(';') : [s];
  let hit = false, allTargets = true;
  const roots = new Map();
  const mapped = parts.map(part => {
    const t = part.trim();
    if (!t || !path.isAbsolute(t)) return part;
    const info = findRuyiPackageRootFor(t, ctx.cache);
    if (!info || samePathKey(info.root) === ctx.currentKey) return part;
    hit = true;
    roots.set(samePathKey(info.root), info.root);
    const rel = path.relative(info.root, path.resolve(t));
    if (rel.startsWith('..')) { allTargets = false; return part; }
    const target = rel ? path.join(ctx.currentRoot, rel) : ctx.currentRoot;
    if (!fs.existsSync(target)) { allTargets = false; return part; }
    return part.replace(t, encode ? encode(t, target) : target);
  });
  if (!hit) return null;
  return { roots: [...roots.values()], newValue: allTargets ? mapped.join(';') : null };
}

// 一个 MCP 条目(json/toml/如意配置里的一条)→ 引用项;没有指向老包的字段时回 null。
function migrationServerItem(ctx, meta, server, encode) {
  const changes = [];
  const roots = new Map();
  let complete = true;
  const look = (field, value) => {
    if (typeof value !== 'string') return;
    const a = migrationAnalyzeValue(value, ctx, encode);
    if (!a) return;
    for (const r of a.roots) roots.set(samePathKey(r), r);
    if (a.newValue == null) complete = false;
    changes.push({ field, from: value, to: a.newValue });
  };
  look('command', server && server.command);
  (server && Array.isArray(server.args) ? server.args : []).forEach((a, i) => look('args.' + i, a));
  look('cwd', server && server.cwd);
  if (server && server.env && typeof server.env === 'object') for (const [k, v] of Object.entries(server.env)) look('env.' + k, v);
  if (!changes.length) return null;
  let action = complete ? 'rewrite' : 'remove';
  if (!complete && meta.kind === 'toml') action = 'manual'; // TOML 里整段删除不做,留给用户手动
  const id = migrationHash([samePathKey(meta.file), JSON.stringify(meta.container || []), meta.serverId, changes.map(c => c.field + '=' + c.from).join('\n')].join('\n'));
  return {
    id, file: meta.file, displayFile: tildePath(meta.file), kind: meta.kind, owner: meta.owner,
    container: meta.container || [], serverId: meta.serverId, entryLabel: meta.entryLabel || meta.serverId,
    packageRoots: [...roots.values()], action, changes: changes.map(c => ({ field: c.field, from: c.from, to: action === 'rewrite' ? c.to : null })),
  };
}

function migrationGetAt(obj, pointer) {
  let cur = obj;
  for (const k of pointer) { if (!cur || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}

async function migrationCollectRefs(config) {
  const currentRoot = migrationCurrentRoot();
  const ctx = { cache: new Map(), currentRoot, currentKey: samePathKey(currentRoot) };
  const homes = agentCliHomes();
  const items = [];
  // ① JSON 形的 MCP 声明:~/.claude.json(含 projects.<路径>.mcpServers)、Kimi 的 mcp.json、如意自己生成的 workbench.mcp*.json
  const jsonFiles = [
    { file: homes.claudeJson, owner: 'claude-code' },
    { file: path.join(homes.kimi, 'mcp.json'), owner: 'kimi' },
  ];
  try {
    for (const f of await fsp.readdir(paths.generated)) {
      if (/^workbench\.mcp.*\.json$/i.test(f)) jsonFiles.push({ file: path.join(paths.generated, f), owner: 'ruyi-generated' });
    }
  } catch { /* generated/ 还没有 */ }
  for (const jf of jsonFiles) {
    let obj = null;
    try {
      const st = await fsp.stat(jf.file);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
      obj = safeJsonParse(await fsp.readFile(jf.file, 'utf8'), null);
    } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const containers = [['mcpServers']];
    if (jf.owner === 'claude-code' && obj.projects && typeof obj.projects === 'object') {
      for (const p of Object.keys(obj.projects)) containers.push(['projects', p, 'mcpServers']);
    }
    for (const container of containers) {
      const servers = migrationGetAt(obj, container);
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
      for (const [serverId, server] of Object.entries(servers)) {
        const item = migrationServerItem(ctx, { file: jf.file, kind: 'json', owner: jf.owner, container, serverId,
          entryLabel: container.length > 1 ? serverId + ' (' + tildePath(container[1]) + ')' : serverId }, server);
        if (item) items.push(item);
      }
    }
  }
  // ② Codex 的 config.toml [mcp_servers.X]
  {
    const file = path.join(homes.codex, 'config.toml');
    let text = null;
    try { const st = await fsp.stat(file); if (st.isFile() && st.size <= 512 * 1024) text = await fsp.readFile(file, 'utf8'); } catch { /* 没装 Codex */ }
    if (text) {
      const encode = (raw, target) => (raw.includes('\\\\') ? target.replace(/\\/g, '\\\\') : target);
      for (const server of _parseTomlMcpServers(text)) {
        const item = migrationServerItem(ctx, { file, kind: 'toml', owner: 'codex', container: ['mcp_servers'], serverId: server.id }, server, encode);
        if (item) items.push(item);
      }
    }
  }
  // ③ 如意自己的配置:externalMcpServers 可改写/移除;desktopMcp / claudePath / kimiPath 只报告(设置页那一份表单会把
  //    它们整字段存回去,这里改了会被下一次「保存设置」盖掉 —— 所以交给用户在设置里改)。
  for (const s of (Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [])) {
    if (!s || !s.id) continue;
    const item = migrationServerItem(ctx, { file: paths.config, kind: 'ruyi-config', owner: 'ruyi', container: ['externalMcpServers'], serverId: s.id }, s);
    if (item) items.push(item);
  }
  {
    const dm = config.desktopMcp || {};
    const item = migrationServerItem(ctx, { file: paths.config, kind: 'ruyi-config', owner: 'ruyi', container: [], serverId: 'desktopMcp', entryLabel: 'desktopMcp' }, { command: dm.command, args: dm.args, cwd: dm.cwd });
    if (item) items.push({ ...item, action: 'manual', changes: item.changes.map(c => ({ ...c, to: null })), note: 'settings' });
    for (const key of ['claudePath', 'kimiPath']) {
      const it = migrationServerItem(ctx, { file: paths.config, kind: 'ruyi-config', owner: 'ruyi', container: [], serverId: key, entryLabel: key }, { command: config[key] });
      if (it) items.push({ ...it, action: 'manual', changes: it.changes.map(c => ({ ...c, to: null })), note: 'settings' });
    }
  }
  return items;
}

// ── 老包清单:登记表 ∪ 引用里认出来的包根(不全盘扫描)──────────────────────────────────────────
function migrationPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
}
// 「还在跑」:登记表里那一行的 pid 还活着,且那次启动晚于本次开机(开机前的 pid 不可能还活着,排除 pid 复用的大头)。
// 判不准时宁可判「在跑」—— 后果只是拒绝移进回收站,方向是安全的。
function migrationPackageRunning(row) {
  if (!row || !row.pid) return false;
  const bootAt = Date.now() - os.uptime() * 1000;
  const launched = Date.parse(String(row.lastLaunchedAt || ''));
  if (Number.isFinite(launched) && launched < bootAt - 60000) return false;
  return migrationPidAlive(row.pid);
}
async function migrationDirSize(root, budget) {
  const key = samePathKey(root);
  const hit = migrationSizeCache.get(key);
  if (hit && Date.now() - hit.at < MIGRATION_SIZE_TTL_MS) return hit;
  let bytes = 0, files = 0, capped = false;
  const stack = [root];
  while (stack.length) {
    if (files >= MIGRATION_SIZE_FILE_CAP || Date.now() > budget.deadline) { capped = true; break; }
    const dir = stack.pop();
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ents) {
      if (d.isSymbolicLink()) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else if (d.isFile()) { try { bytes += (await fsp.stat(p)).size; } catch { /* 读不到的文件不计 */ } files++; }
    }
  }
  const out = { at: Date.now(), bytes, files, capped };
  if (!capped) migrationSizeCache.set(key, out);
  return out;
}
async function migrationListPackages(refs, opts = {}) {
  const currentRoot = migrationCurrentRoot();
  const currentKey = samePathKey(currentRoot);
  const reg = readInstallRegistry();
  const map = new Map();
  for (const row of reg.packages) {
    const key = samePathKey(row.packageRoot);
    if (key === currentKey) continue;
    const info = ruyiPackageInfo(row.packageRoot);
    if (!info) continue;
    map.set(key, { root: info.root, version: info.version || row.version, lastLaunchedAt: row.lastLaunchedAt, firstSeenAt: row.firstSeenAt,
      launchMode: row.launchMode, running: migrationPackageRunning(row), discoveredBy: ['registry'] });
  }
  for (const item of refs) {
    for (const r of item.packageRoots) {
      const key = samePathKey(r);
      if (key === currentKey) continue;
      if (map.has(key)) { const p = map.get(key); if (!p.discoveredBy.includes('reference')) p.discoveredBy.push('reference'); continue; }
      const info = ruyiPackageInfo(r);
      if (!info) continue;
      map.set(key, { root: info.root, version: info.version, lastLaunchedAt: '', firstSeenAt: '', launchMode: '', running: false, discoveredBy: ['reference'] });
    }
  }
  const budget = { deadline: Date.now() + MIGRATION_SIZE_BUDGET_MS };
  const out = [];
  for (const [key, p] of map) {
    const myRefs = refs.filter(item => item.packageRoots.some(r => samePathKey(r) === key));
    const size = opts.withSizes ? await migrationDirSize(p.root, budget) : null;
    out.push({ ...p, key, refCount: myRefs.length, refIds: myRefs.map(item => item.id),
      containsCurrent: migrationPathInside(currentKey, key),
      sizeBytes: size ? size.bytes : null, sizeCapped: size ? size.capped : null });
  }
  out.sort((a, b) => String(b.lastLaunchedAt || '').localeCompare(String(a.lastLaunchedAt || '')) || a.root.localeCompare(b.root));
  return out;
}

// ── 导入面(MCP / 技能)的只读视图 ───────────────────────────────────────────────────────────
function migrationMcpSummary(raw) {
  if (raw.url) return String(raw.type || 'http') + ' ' + safeUrlForDisplay(raw.url);
  return path.basename(String(raw.command || '')) + (Array.isArray(raw.args) && raw.args.length ? ' +' + raw.args.length : '');
}
async function migrationScanMcp(config) {
  const managedKimi = await kimiMcpManagedIds();
  const view = { externalMcpServers: Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [], dismissedMcpIds: Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds : [] };
  const sources = [];
  const servers = [];
  for (const src of agentMcpImportSources()) {
    const parsed = parseMcpConfigFile(src.file);
    const missing = Boolean(parsed.error && /文件不存在/.test(parsed.error));
    sources.push({ origin: src.origin, label: src.label, file: src.file, displayFile: tildePath(src.file), exists: !missing,
      error: parsed.error && !missing && !/未找到 mcpServers/.test(parsed.error) ? parsed.error : '' });
    for (const raw of parsed.servers) {
      const v = classifyAgentMcpCandidate(raw, src.origin, view, managedKimi);
      const existing = view.externalMcpServers.find(s => s && s.id === raw.id);
      servers.push({ key: src.origin + ':' + raw.id, origin: src.origin, label: src.label, id: raw.id, summary: migrationMcpSummary(raw),
        status: v.status, reason: v.reason, importedOrigin: existing ? String(existing.origin || 'ruyi') : '' });
    }
  }
  return { sources, servers, limit: 10, used: view.externalMcpServers.length };
}
async function migrationScanSkills(config) {
  let registry = [];
  try { registry = await loadSkillRegistry('', config, null); } catch { registry = []; }
  return registry.filter(e => e && e.kind === 'skill' && MIGRATION_EXTERNAL_SOURCES.includes(e.source))
    .map(e => ({ key: e.source + ':' + e.id, id: e.id, name: e.name, source: e.source, plugin: e.plugin || '', available: e.available !== false }));
}

async function migrationLogs() {
  let files = [];
  try { files = (await fsp.readdir(migrationDir())).filter(f => /^[0-9TZ-]+\.json$/.test(f)).sort().reverse(); } catch { return []; }
  const out = [];
  for (const f of files.slice(0, 20)) {
    const log = safeJsonParse(await fsp.readFile(path.join(migrationDir(), f), 'utf8').catch(() => ''), null);
    if (log && log.schema === MIGRATION_LOG_SCHEMA) out.push(log);
  }
  return out;
}

// 首启提示的候选键:出现任何一个不在 config.migrationSeenKeys 里的键就提示一次。
function migrationPromptKeys(parts) {
  const keys = [];
  for (const s of parts.instructions) if (['importable', 'imported', 'source-updated'].includes(s.status)) keys.push('instr:' + s.key);
  for (const s of parts.mcp.servers) {
    if (s.status === 'importable' || (s.status === 'imported' && s.importedOrigin === s.origin)) keys.push('mcp:' + s.key);
  }
  for (const s of parts.skills) keys.push('skill:' + s.key);
  for (const p of parts.packages) keys.push('pkg:' + p.key);
  return keys.map(k => k.slice(0, 200)).slice(0, 300);
}

async function migrationCollect(opts = {}) {
  const config = await readConfig();
  const instr = await syncAgentInstructionImports({ auto: config.importAgentInstructions !== false });
  const mcp = await migrationScanMcp(config);
  const skills = await migrationScanSkills(config);
  const refs = await migrationCollectRefs(config);
  await migrationRememberPackages(refs.flatMap(r => r.packageRoots)).catch(() => 0);
  const packages = await migrationListPackages(refs, { withSizes: opts.withSizes === true });
  const keys = migrationPromptKeys({ instructions: instr.sources, mcp, skills, packages });
  const seen = new Set(Array.isArray(config.migrationSeenKeys) ? config.migrationSeenKeys : []);
  const fresh = keys.filter(k => !seen.has(k));
  return { config, instructions: instr.sources, mcp, skills, refs, packages, keys, fresh };
}

async function migrationScan() {
  return migrationSerial(async () => {
    const c = await migrationCollect({ withSizes: true });
    const logs = await migrationLogs();
    const last = logs.find(l => !l.undoneAt) || null;
    const counts = {
      instructions: c.instructions.filter(s => s.status === 'imported' || s.status === 'source-updated').length,
      instructionsImportable: c.instructions.filter(s => s.status === 'importable').length,
      mcpImported: c.mcp.servers.filter(s => s.status === 'imported' && s.importedOrigin === s.origin).length,
      mcpImportable: c.mcp.servers.filter(s => s.status === 'importable').length,
      skills: c.skills.length,
      packages: c.packages.length,
      refs: c.refs.filter(r => r.action !== 'manual').length,
    };
    return {
      ok: true,
      current: { root: migrationCurrentRoot(), version: VERSION },
      settings: { importAgentInstructions: c.config.importAgentInstructions !== false, autoImportClaudeCodeMcp: c.config.autoImportClaudeCodeMcp !== false },
      instructions: c.instructions, mcp: c.mcp, skills: c.skills, refs: c.refs, packages: c.packages,
      lastMigration: last ? { id: last.id, createdAt: last.createdAt, items: (last.files || []).reduce((n, f) => n + (f.items || []).length, 0) } : null,
      prompt: { show: c.fresh.length > 0, fresh: c.fresh.length, counts },
    };
  });
}

// ── 应用:导入 / 改写老包引用 / 记「看过了」/ 两个开关 ────────────────────────────────────────
async function migrationImportMcp(list) {
  const want = (Array.isArray(list) ? list : []).map(x => ({ origin: String(x && x.origin || ''), id: String(x && x.id || '') })).filter(x => x.origin && x.id).slice(0, 20);
  if (!want.length) return { ok: true, added: [], skipped: [] };
  const managedKimi = await kimiMcpManagedIds();
  const sources = new Map(agentMcpImportSources().map(s => [s.origin, s]));
  const r = await mutateConfig(async current => {
    const list2 = Array.isArray(current.externalMcpServers) ? current.externalMcpServers.slice() : [];
    const added = [], skipped = [];
    for (const w of want) {
      const src = sources.get(w.origin);
      if (!src) { skipped.push({ ...w, reason: 'unknown-source' }); continue; }
      const raw = parseMcpConfigFile(src.file).servers.find(s => s.id === w.id);
      if (!raw) { skipped.push({ ...w, reason: 'not-found' }); continue; }
      // 显式导入:dismissed 不拦(用户改主意了),其余判据与自动导入相同。
      const v = classifyAgentMcpCandidate(raw, w.origin, { externalMcpServers: list2, dismissedMcpIds: [] }, managedKimi);
      if (v.status !== 'importable') { skipped.push({ ...w, reason: v.status === 'imported' ? 'already-imported' : v.reason }); continue; }
      if (list2.length >= 10) { skipped.push({ ...w, reason: 'limit' }); continue; }
      const srv = sanitizeExternalMcpServer({ ...raw, origin: w.origin });
      if (!srv) { skipped.push({ ...w, reason: 'invalid' }); continue; }
      list2.push(srv); added.push(srv.id);
    }
    if (!added.length) return { abort: { added, skipped } };
    current.externalMcpServers = list2;
    current.dismissedMcpIds = (Array.isArray(current.dismissedMcpIds) ? current.dismissedMcpIds : []).filter(x => !added.includes(x));
    return { value: { added, skipped } };
  });
  const value = r.ok ? r.value : (r.value || { added: [], skipped: [] });
  if (value.added.length) {
    void generateMcpConfig(r.config && r.config.mcpCommandMode).catch(() => {});
    logEvent({ kind: 'mcp_import', ids: value.added, added: value.added.length, source: 'migration-center' });
  }
  return { ok: true, ...value };
}

function migrationSetField(server, field, value) {
  if (field === 'command' || field === 'cwd') { server[field] = value; return; }
  const m = /^(args|env)\.(.+)$/.exec(field);
  if (!m) return;
  if (m[1] === 'args') { const i = Number(m[2]); if (Array.isArray(server.args) && Number.isInteger(i) && i >= 0 && i < server.args.length) server.args[i] = value; }
  else if (server.env && typeof server.env === 'object') server.env[m[2]] = value;
}
function migrationGetField(server, field) {
  if (!server || typeof server !== 'object') return undefined;
  if (field === 'command' || field === 'cwd') return server[field];
  const m = /^(args|env)\.(.+)$/.exec(field);
  if (!m) return undefined;
  if (m[1] === 'args') return Array.isArray(server.args) ? server.args[Number(m[2])] : undefined;
  return server.env && typeof server.env === 'object' ? server.env[m[2]] : undefined;
}
// TOML 的 [mcp_servers.<id>] 段在全文里的 [start, end) 字符区间(找不到回 null)。
function migrationTomlSection(text, serverId) {
  const lines = text.split('\n');
  let pos = 0, start = -1;
  for (const line of lines) {
    const m = line.match(/^\s*\[\s*mcp_servers\.([^\]\s]+)\s*\]\s*$/);
    if (start >= 0 && /^\s*\[/.test(line)) return { start, end: pos };
    if (m && m[1].replace(/^["']|["']$/g, '') === serverId) start = pos + line.length + 1;
    pos += line.length + 1;
  }
  return start >= 0 ? { start, end: text.length } : null;
}
// 在 TOML 段内把带引号的旧值换成新值(保留原引号样式)。返回 { text, count }。
function migrationTomlReplace(text, serverId, from, to) {
  const sec = migrationTomlSection(text, serverId);
  if (!sec) return { text, count: 0 };
  let body = text.slice(sec.start, sec.end);
  let count = 0;
  for (const q of ['"', "'"]) {
    const needle = q + from + q;
    while (body.includes(needle)) { body = body.replace(needle, q + to + q); count++; }
  }
  return { text: text.slice(0, sec.start) + body + text.slice(sec.end), count };
}

async function migrationBackup(file, ts) {
  const backup = file + MIGRATION_BACKUP_TAG + ts;
  await fsp.copyFile(file, backup);
  return backup;
}

async function migrationRewriteRefs(ids) {
  const wantIds = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!wantIds.size) return { ok: true, id: null, items: 0 };
  const config = await readConfig();
  const refs = await migrationCollectRefs(config);
  const selected = refs.filter(r => wantIds.has(r.id) && (r.action === 'rewrite' || r.action === 'remove'));
  const stale = [...wantIds].filter(id => !refs.some(r => r.id === id));
  if (!selected.length) return { ok: false, error: 'nothing-to-apply', stale, status: 409 };
  await migrationRememberPackages(selected.flatMap(item => item.packageRoots)).catch(() => 0);
  const ts = migrationStamp();
  const log = { schema: MIGRATION_LOG_SCHEMA, id: ts, createdAt: nowIso(), currentRoot: migrationCurrentRoot(), version: VERSION, files: [] };
  const byFile = new Map();
  for (const item of selected) { const k = samePathKey(item.file) + '|' + item.kind; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(item); }
  let applied = 0;
  const failures = [];
  for (const items of byFile.values()) {
    const { file, kind } = items[0];
    const entry = { file, kind, backup: '', items: [] };
    try {
      entry.backup = await migrationBackup(file, ts);
      if (kind === 'ruyi-config') {
        const r = await mutateConfig(async cfg => {
          const list = Array.isArray(cfg.externalMcpServers) ? cfg.externalMcpServers.slice() : [];
          const done = [];
          for (const item of items) {
            const idx = list.findIndex(s => s && s.id === item.serverId);
            if (idx < 0) continue;
            if (item.action === 'remove') {
              const [removed] = list.splice(idx, 1);
              cfg.dismissedMcpIds = [...new Set([...(Array.isArray(cfg.dismissedMcpIds) ? cfg.dismissedMcpIds : []), item.serverId])];
              done.push({ ...item, removed });
            } else {
              const server = { ...list[idx], args: Array.isArray(list[idx].args) ? list[idx].args.slice() : [], env: { ...(list[idx].env || {}) } };
              const changes = item.changes.filter(c => migrationGetField(server, c.field) === c.from);
              for (const c of changes) migrationSetField(server, c.field, c.to);
              list[idx] = server;
              if (changes.length) done.push({ ...item, changes });
            }
          }
          if (!done.length) return { abort: done };
          cfg.externalMcpServers = list;
          return { value: done };
        });
        if (r.ok) { entry.items = r.value; void generateMcpConfig(r.config && r.config.mcpCommandMode).catch(() => {}); }
      } else if (kind === 'json') {
        const text = await fsp.readFile(file, 'utf8');
        const obj = JSON.parse(text);
        for (const item of items) {
          const container = migrationGetAt(obj, item.container);
          if (!container || typeof container !== 'object' || !container[item.serverId]) continue;
          if (item.action === 'remove') {
            entry.items.push({ ...item, removed: container[item.serverId] });
            delete container[item.serverId];
          } else {
            const server = container[item.serverId];
            const changes = item.changes.filter(c => migrationGetField(server, c.field) === c.from);
            for (const c of changes) migrationSetField(server, c.field, c.to);
            if (changes.length) entry.items.push({ ...item, changes });
          }
        }
        if (entry.items.length) await atomicWriteJson(file, JSON.stringify(obj, null, 2) + (text.endsWith('\n') ? '\n' : ''));
      } else if (kind === 'toml') {
        let text = await fsp.readFile(file, 'utf8');
        for (const item of items) {
          if (item.action !== 'rewrite') continue;
          const changes = [];
          for (const c of item.changes) {
            const r = migrationTomlReplace(text, item.serverId, c.from, c.to);
            if (r.count) { text = r.text; changes.push(c); }
          }
          if (changes.length) entry.items.push({ ...item, changes });
        }
        if (entry.items.length) await atomicWriteJson(file, text);
      }
    } catch (e) {
      failures.push({ file: tildePath(file), error: (e && e.message) || String(e) });
    }
    if (entry.items.length) { applied += entry.items.length; log.files.push(entry); }
    else if (entry.backup) await fsp.unlink(entry.backup).catch(() => {}); // 一项都没落:备份没用,不留垃圾
  }
  if (!applied) return { ok: false, error: 'nothing-applied', failures, status: 409 };
  await fsp.mkdir(migrationDir(), { recursive: true });
  await atomicWriteJson(path.join(migrationDir(), ts + '.json'), log);
  logEvent({ kind: 'migration_apply', id: ts, files: log.files.length, items: applied, failures: failures.length });
  return { ok: true, id: ts, items: applied, files: log.files.map(f => ({ file: tildePath(f.file), backup: f.backup, items: f.items.length })), failures, stale };
}

async function migrationApply(body) {
  return migrationSerial(async () => {
    const b = body && typeof body === 'object' ? body : {};
    const out = { ok: true };
    const importKeys = Array.isArray(b.importInstructions) ? b.importInstructions.map(String).slice(0, 10) : [];
    const dismissKeys = Array.isArray(b.dismissInstructions) ? b.dismissInstructions.map(String).slice(0, 10) : [];
    if (b.settings && typeof b.settings === 'object') {
      const patch = {};
      for (const k of ['importAgentInstructions', 'autoImportClaudeCodeMcp']) if (typeof b.settings[k] === 'boolean') patch[k] = b.settings[k];
      if (Object.keys(patch).length) {
        await mutateConfig(async cfg => { Object.assign(cfg, patch); return { value: true }; });
        out.settings = patch;
      }
    }
    if (importKeys.length || dismissKeys.length) {
      const r = await syncAgentInstructionImports({ auto: false, importKeys, dismissKeys });
      out.instructions = r.sources.filter(s => importKeys.includes(s.key) || dismissKeys.includes(s.key));
    }
    if (Array.isArray(b.importMcp) && b.importMcp.length) out.mcp = await migrationImportMcp(b.importMcp);
    if (Array.isArray(b.rewriteRefs) && b.rewriteRefs.length) {
      out.refs = await migrationRewriteRefs(b.rewriteRefs);
      if (!out.refs.ok) { out.ok = false; out.error = out.refs.error; }
    }
    if (b.markSeen === true) {
      const c = await migrationCollect({ withSizes: false });
      const keys = c.keys;
      await mutateConfig(async cfg => {
        const prev = Array.isArray(cfg.migrationSeenKeys) ? cfg.migrationSeenKeys : [];
        const merged = [...prev.filter(k => !keys.includes(k)), ...keys].slice(-300);
        cfg.migrationSeenKeys = merged;
        return { value: merged.length };
      });
      out.seen = keys.length;
    }
    return out;
  });
}

// ── 撤销:按日志逐项反向改回(只改回「现在的值仍是我们写下的值」的那些;被删的条目只在原位空着时放回)──
async function migrationUndo(body) {
  return migrationSerial(async () => {
    const logs = await migrationLogs();
    const wantId = String((body && body.id) || '');
    const log = wantId ? logs.find(l => l.id === wantId) : logs.find(l => !l.undoneAt);
    if (!log) return { ok: false, error: 'no-migration-to-undo', status: 404 };
    if (log.undoneAt) return { ok: false, error: 'already-undone', status: 409 };
    let restored = 0, skipped = 0;
    for (const f of log.files || []) {
      try {
        if (f.kind === 'ruyi-config') {
          await mutateConfig(async cfg => {
            const list = Array.isArray(cfg.externalMcpServers) ? cfg.externalMcpServers.slice() : [];
            for (const item of f.items || []) {
              if (item.removed) {
                if (list.some(s => s && s.id === item.serverId) || list.length >= 10) { skipped++; continue; }
                list.push(item.removed); restored++;
                cfg.dismissedMcpIds = (Array.isArray(cfg.dismissedMcpIds) ? cfg.dismissedMcpIds : []).filter(x => x !== item.serverId);
              } else {
                const idx = list.findIndex(s => s && s.id === item.serverId);
                if (idx < 0) { skipped++; continue; }
                const server = { ...list[idx], args: Array.isArray(list[idx].args) ? list[idx].args.slice() : [], env: { ...(list[idx].env || {}) } };
                for (const c of item.changes || []) {
                  if (migrationGetField(server, c.field) === c.to) { migrationSetField(server, c.field, c.from); restored++; } else skipped++;
                }
                list[idx] = server;
              }
            }
            cfg.externalMcpServers = list;
            return { value: true };
          });
          void generateMcpConfig().catch(() => {});
        } else if (f.kind === 'json') {
          let text = '';
          try { text = await fsp.readFile(f.file, 'utf8'); } catch { text = ''; }
          const obj = text ? JSON.parse(text) : {};
          for (const item of f.items || []) {
            let container = migrationGetAt(obj, item.container);
            if (item.removed) {
              if (!container || typeof container !== 'object') {
                container = obj;
                for (const k of item.container) { if (!container[k] || typeof container[k] !== 'object') container[k] = {}; container = container[k]; }
              }
              if (container[item.serverId]) { skipped++; continue; }
              container[item.serverId] = item.removed; restored++;
            } else {
              const server = container && container[item.serverId];
              if (!server) { skipped++; continue; }
              for (const c of item.changes || []) {
                if (migrationGetField(server, c.field) === c.to) { migrationSetField(server, c.field, c.from); restored++; } else skipped++;
              }
            }
          }
          await atomicWriteJson(f.file, JSON.stringify(obj, null, 2) + (text.endsWith('\n') ? '\n' : ''));
        } else if (f.kind === 'toml') {
          let text = await fsp.readFile(f.file, 'utf8');
          for (const item of f.items || []) {
            for (const c of item.changes || []) {
              const r = migrationTomlReplace(text, item.serverId, c.to, c.from);
              if (r.count) { text = r.text; restored++; } else skipped++;
            }
          }
          await atomicWriteJson(f.file, text);
        }
      } catch { skipped++; }
    }
    log.undoneAt = nowIso();
    log.undoResult = { restored, skipped };
    await atomicWriteJson(path.join(migrationDir(), log.id + '.json'), log);
    logEvent({ kind: 'migration_undo', id: log.id, restored, skipped });
    return { ok: true, id: log.id, restored, skipped };
  });
}

// 从引用里认出来的老包记进登记表(没启动过的行:pid 0、lastLaunchedAt 空)。否则引用一改完,它就既不在登记表、
// 也不再被任何配置指着 —— 从清单里消失,用户再也点不到「移到回收站」。
async function migrationRememberPackages(roots) {
  const reg = readInstallRegistry();
  const known = new Set(reg.packages.map(r => samePathKey(r.packageRoot)));
  const currentKey = samePathKey(migrationCurrentRoot());
  let added = 0;
  for (const root of roots) {
    const key = samePathKey(root);
    if (known.has(key) || key === currentKey) continue;
    const info = ruyiPackageInfo(root);
    if (!info) continue;
    reg.packages.push({ packageRoot: info.root, version: info.version, launchMode: '', firstSeenAt: nowIso(), lastLaunchedAt: '', pid: 0 });
    known.add(key); added++;
  }
  if (!added) return 0;
  await fsp.mkdir(paths.data, { recursive: true });
  await atomicWriteJson(installRegistryPath(), { schema: reg.schema, updatedAt: nowIso(), packages: reg.packages });
  return added;
}

// ── 移到回收站 ───────────────────────────────────────────────────────────────────────────────
async function migrationForgetPackage(root) {
  const key = samePathKey(root);
  const reg = readInstallRegistry();
  const packages = reg.packages.filter(r => samePathKey(r.packageRoot) !== key);
  if (packages.length === reg.packages.length) return;
  await atomicWriteJson(installRegistryPath(), { schema: reg.schema, updatedAt: nowIso(), packages });
}
async function migrationSendToRecycleBin(root) {
  // 测试钩子:设了 RUYI_MIGRATION_RECYCLE_STUB_DIR 时,不碰系统回收站,把目录挪进这个目录(e2e 用)。
  const stub = String(process.env.RUYI_MIGRATION_RECYCLE_STUB_DIR || '').trim();
  if (stub) {
    await fsp.mkdir(stub, { recursive: true });
    await fsp.rename(root, path.join(stub, path.basename(root) + '-' + migrationStamp()));
    return { via: 'test-stub' };
  }
  if (process.platform !== 'win32') return { error: 'unsupported-platform' };
  // 目标路径经环境变量传入,脚本是纯 ASCII 常量 —— 零拼接、零注入。只移进回收站(SendToRecycleBin),不做永久删除。
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; "
    + '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:RUYI_RECYCLE_TARGET, '
    + '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)';
  const r = await DesktopShell.runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { env: { RUYI_RECYCLE_TARGET: root }, timeoutMs: 180000 });
  if (fs.existsSync(root)) return { error: 'recycle-failed', detail: String((r && (r.stderr || r.stdout)) || '').trim().slice(0, 400) };
  return { via: 'recycle-bin' };
}
async function migrationRecycle(body) {
  return migrationSerial(async () => {
    const root = String((body && body.root) || '').trim();
    if (!root || !path.isAbsolute(root)) return { ok: false, error: 'root-required', status: 400 };
    if (String((body && body.confirm) || '') !== root) return { ok: false, error: 'confirm-mismatch', status: 400 };
    const key = samePathKey(root);
    const currentKey = samePathKey(migrationCurrentRoot());
    if (migrationPathInside(currentKey, key)) return { ok: false, error: 'current-package', status: 409 };
    if (migrationPathInside(samePathKey(paths.data), key)) return { ok: false, error: 'contains-data', status: 409 };
    if (migrationPathInside(samePathKey(os.homedir()), key)) return { ok: false, error: 'contains-home', status: 409 };
    const config = await readConfig();
    const refs = await migrationCollectRefs(config);
    const packages = await migrationListPackages(refs, { withSizes: false });
    const pkg = packages.find(p => p.key === key);
    if (!pkg || !ruyiPackageInfo(root)) return { ok: false, error: 'not-an-old-package', status: 404 };
    if (pkg.running) return { ok: false, error: 'running', status: 409 };
    if (pkg.refCount > 0) {
      return { ok: false, error: 'referenced', status: 409,
        refs: refs.filter(r => pkg.refIds.includes(r.id)).map(r => ({ id: r.id, file: r.displayFile, entry: r.entryLabel, action: r.action })) };
    }
    const done = await migrationSendToRecycleBin(pkg.root);
    if (done.error) return { ok: false, error: done.error, detail: done.detail || '', status: 500 };
    migrationSizeCache.delete(key);
    await migrationForgetPackage(pkg.root).catch(() => {});
    logEvent({ kind: 'migration_recycle', root: pkg.root, version: pkg.version || '', via: done.via });
    return { ok: true, root: pkg.root, version: pkg.version || '', via: done.via };
  });
}

// 迟绑定挂接(见 00-boot 的 MigrationHooks 头注)。
Object.assign(MigrationHooks, {
  scan: migrationScan,
  apply: migrationApply,
  undo: migrationUndo,
  recycle: migrationRecycle,
});
