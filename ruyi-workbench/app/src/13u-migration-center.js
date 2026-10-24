// ============================================================================
// 13u 迁移中心(W2;56 号文 §3 + 用户 2026-09-24 原话「让用户无痛迁移…包括把老的如意迁移到新的如意里;
// 要注意如意的安装包可能是在电脑里的任意位置」)。
//
// 两件事,一个面:
//   ① 从 Claude Code / Codex / Kimi Code 导入:全局指令文件(06d syncAgentInstructionImports,导成核心记忆)、
//      MCP(01 classifyAgentMcpCandidate,与启动期自动导入同一个判据)、技能(12 loadSkillRegistry 活读;
//      W8 起可逐项「复制到如意」,拷进 dataRoot/skills 后与来源脱钩,见下文技能一节)。
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
const migrationSizeCache = new Map();        // 包根键 -> { at, bytes, files, capped }
let migrationChain = Promise.resolve();
let migrationRecoveryNeeded = true;

function migrationSerial(fn) {
  const job = migrationChain.then(async () => {
    if (migrationRecoveryNeeded) {
      await migrationRecoverSkillBackups();
      migrationRecoveryNeeded = false;
    }
    return fn();
  });
  migrationChain = job.catch(() => {});
  return job;
}
function migrationDir() { return path.join(paths.data, 'migrations'); }
function migrationLogShape(value, id) {
  return /^[0-9TZ-]+$/.test(String(id || '')) && !!value && typeof value === 'object' && !Array.isArray(value) && value.schema === MIGRATION_LOG_SCHEMA && value.id === id
    && ['createdAt', 'currentRoot', 'version'].every(key => value[key] === undefined || typeof value[key] === 'string') && Array.isArray(value.files)
    && value.files.every(file => file && typeof file === 'object' && !Array.isArray(file) && typeof file.file === 'string'
      && ['ruyi-config', 'json', 'toml', 'skill-copy'].includes(file.kind) && Array.isArray(file.items)
      && file.items.every(item => item && typeof item === 'object' && !Array.isArray(item)));
}
function migrationLogText(log, enabled) {
  const text = JSON.stringify(log, null, 2);
  if (enabled && (!migrationLogShape(log, log.id) || Buffer.byteLength(text, 'utf8') > 256 * 1024 * 1024)) {
    throw Object.assign(new Error('work_data_store.validate'), { code: 'work_data_store.validate', apiCode: 'work_data_store.validate', statusCode: 503 });
  }
  return text;
}
function migrationLogStore(id) {
  if (!/^[0-9TZ-]+$/.test(String(id || ''))) throw Object.assign(new Error('work_data_store.binding'), { code: 'work_data_store.binding', apiCode: 'work_data_store.binding', statusCode: 503 });
  return WorkDataStore.createText({
    file: () => path.join(migrationDir(), id + '.json'), purpose: 'migration', schema: MIGRATION_LOG_SCHEMA,
    scopeId: 'global', recordId: 'migration-log:' + id, chunked: true, maxPlaintextBytes: 256 * 1024 * 1024,
    enabled: async () => (await readConfig()).workDataEncryptionV1 === true,
    validateSealedText: text => migrationLogShape(safeJsonParse(text, null), id),
    writeJson: atomicWriteJson,
  });
}
async function writeMigrationLog(log) { await migrationLogStore(log.id).write(migrationLogText(log, (await readConfig()).workDataEncryptionV1 === true)); }
function migrationUncertainResult(result, error) {
  return { ...result, ok: false, error: 'result-unavailable', status: 503,
    operationMayHaveExecuted: true, resultUnavailable: true, retry: false,
    storageCode: /^work_data[.\w]*$/.test(String(error?.code || '')) ? error.code : 'work_data_store.storage_unavailable' };
}
async function migrationCommitLog(log, result) {
  try {
    await fsp.mkdir(migrationDir(), { recursive: true });
    await writeMigrationLog(log);
    return result;
  } catch (error) {
    // External effects already happened. Keep their receipt in the response and
    // make retries explicit; a failed log write never re-executes the operation.
    return migrationUncertainResult({ ...result, id: log.id }, error);
  }
}
async function migrationStoragePreflight(existingFile, log) {
  const enabled = (await readConfig()).workDataEncryptionV1 === true;
  if (log) migrationLogText(log, enabled); // validate legacy undo receipts before touching their targets
  if (!enabled) {
    // A readable sealed revision must not be replaced through a new staging directory
    // or changed externally before the ordinary store's downgrade guard can run.
    if (existingFile) {
      try {
        if (await WorkDataStore.hasContainerMarker(existingFile)) throw Object.assign(new Error('work_data_store.downgrade_refused'), { code: 'work_data_store.downgrade_refused', apiCode: 'work_data_store.downgrade_refused', statusCode: 503 });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return;
  }
  // No key creation. Detect unavailable work-data authority before touching an external
  // configuration/live skill. This is not a cross-file transaction or rotation CAS.
  const lease = await WorkDataStore.acquireSnapshot(WorkDataStore.requireKeys());
  await lease.release();
}
function migrationStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
let migrationLastLogTime = 0;
async function migrationNextLogStamp() {
  // Calls run inside migrationSerial. Avoid replacing an earlier receipt after
  // a same-millisecond request or a restart; the data-root owner excludes peers.
  let time = Math.max(Date.now(), migrationLastLogTime + 1);
  for (;;) {
    const stamp = new Date(time).toISOString().replace(/[:.]/g, '-');
    let exists = false;
    for (const file of [path.join(migrationDir(), stamp + '.json'), path.join(migrationDir(), MIGRATION_SKILL_BACKUP_DIR, stamp)]) {
      try { await fsp.lstat(file); exists = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!exists) { migrationLastLogTime = time; return stamp; }
    time++;
  }
}
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
// ── 技能:活读 vs「复制到如意」(W8)──────────────────────────────────────────────────────────
// 活读:12 loadSkillRegistry 每次现读外部目录,来源删了技能也跟着没了。复制:整目录拷进 dataRoot/skills/<id>/,
// 附来源记录 SKILL_IMPORT_RECORD(12),此后它就是 user 技能,与来源脱钩(优先级 user > 一切外部源)。
// 扫描【按来源逐个目录读】,不走合并后的注册表 —— 复制后 user 那份会把外部同名那份盖掉,合并视图里外部行就没了。
// 每行状态(判据只看内容哈希,不看 mtime):
//   live           dataRoot/skills/<id> 不存在
//   copied         它的来源记录指着【这一行】(source + plugin + sourcePath),且来源与副本都和复制时一样
//   source-updated 来源变了、副本没被改过 → 可一键更新
//   copy-edited    副本被用户改过 → 不覆盖,除非显式 overwrite:true
//   conflict       dataRoot/skills/<id> 已存在但不是从这一行复制的(用户自己的同名技能、另一来源的副本、符号链接)
//   too-large      来源超出单技能上限(还没复制过时)
// 复制安全边界:只跟随真实文件与目录,符号链接/联接一律跳过不跟随;单技能 ≤ 20 MB / 500 个文件 / 16 层;
// 目标恒为 path.resolve(paths.skills, id) 且必须是 paths.skills 的直接子目录;先拷进同卷暂存目录再整体改名换入。
const MIGRATION_SKILL_MAX_BYTES = 20 * 1024 * 1024;
const MIGRATION_SKILL_MAX_FILES = 500;
const MIGRATION_SKILL_MAX_DEPTH = 16;
const MIGRATION_SKILL_STAGE_PREFIX = '.ruyi-copy-';
const MIGRATION_SKILL_BACKUP_DIR = 'skill-backups';
const migrationFileHashCache = new Map(); // 绝对路径|大小|mtime -> sha256(扫描反复算哈希时只重读变过的文件)

function migrationSkillKey(source, plugin, id) {
  return source === 'claude-plugin' ? 'claude-plugin:' + plugin + ':' + id : source + ':' + id;
}
// 外部技能目录,优先级从低到高(与 12 loadSkillRegistry 同序;同名时后面的生效)。
async function migrationSkillSources() {
  const homes = agentCliHomes();
  const out = [];
  for (const d of await claudePluginSkillDirs()) out.push({ source: 'claude-plugin', plugin: d.plugin, baseDir: d.skillsDir });
  out.push({ source: 'kimi', plugin: '', baseDir: path.join(homes.kimi, 'skills') });
  out.push({ source: 'codex', plugin: '', baseDir: path.join(homes.codex, 'skills') });
  out.push({ source: 'claude-code', plugin: '', baseDir: path.join(homes.claude, 'skills') });
  return out;
}
// 走一棵技能目录树:只收真实文件(lstat),符号链接/联接计数后跳过、绝不跟随;超限即停(tooLarge)。
// 顶层的来源记录不算内容(副本与来源按同一口径比哈希)。
async function migrationSkillTree(root) {
  const files = [];
  let bytes = 0, links = 0;
  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur.dir, { withFileTypes: true }); } catch { return { error: 'unreadable', files, bytes, links }; }
    for (const d of ents) {
      if (!cur.rel && d.name === SKILL_IMPORT_RECORD) continue;
      const abs = path.join(cur.dir, d.name);
      const rel = cur.rel ? cur.rel + '/' + d.name : d.name;
      let st;
      try { st = await fsp.lstat(abs); } catch { continue; }
      if (d.isSymbolicLink() || st.isSymbolicLink()) { links++; continue; }
      if (st.isDirectory()) {
        if (cur.depth + 1 > MIGRATION_SKILL_MAX_DEPTH) return { tooLarge: true, reason: 'too-deep', files, bytes, links };
        stack.push({ dir: abs, rel, depth: cur.depth + 1 });
        continue;
      }
      if (!st.isFile()) continue;
      files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
      bytes += st.size;
      if (files.length > MIGRATION_SKILL_MAX_FILES) return { tooLarge: true, reason: 'too-many-files', files, bytes, links };
      if (bytes > MIGRATION_SKILL_MAX_BYTES) return { tooLarge: true, reason: 'too-many-bytes', files, bytes, links };
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, bytes, links };
}
async function migrationFileHash(f) {
  const k = f.abs + '|' + f.size + '|' + f.mtimeMs;
  const hit = migrationFileHashCache.get(k);
  if (hit) return hit;
  const h = crypto.createHash('sha256').update(await fsp.readFile(f.abs)).digest('hex');
  if (migrationFileHashCache.size > 5000) migrationFileHashCache.clear();
  migrationFileHashCache.set(k, h);
  return h;
}
// 树哈希 = 排序后的「相对路径 NUL 文件哈希」逐行。读不全/超限回 ''(与任何记录都不相等 → 判「变了」,方向安全)。
async function migrationTreeHash(tree) {
  if (!tree || tree.error || tree.tooLarge) return '';
  const h = crypto.createHash('sha256');
  try { for (const f of tree.files) h.update(f.rel + '\0' + await migrationFileHash(f) + '\n'); } catch { return ''; }
  return h.digest('hex');
}
function migrationSkillTarget(id) {
  if (!SKILL_ID_RE.test(String(id || ''))) return null;
  const root = path.resolve(paths.skills);
  const dest = path.resolve(root, String(id));
  return samePathKey(path.dirname(dest)) === samePathKey(root) ? dest : null;
}
async function migrationLstat(p) { try { return await fsp.lstat(p); } catch { return null; } }

// 一行的状态。内部字段(_dir 等)只在本模块里用,对外视图由 migrationSkillPublicRow 剥掉。
async function migrationSkillRow(src, entry) {
  const tree = await migrationSkillTree(entry.dir);
  const row = {
    key: migrationSkillKey(src.source, src.plugin, entry.id), id: entry.id, name: entry.name, source: src.source, plugin: src.plugin || '',
    displayPath: tildePath(entry.dir), available: entry.available !== false,
    tooLarge: Boolean(tree.tooLarge), bytes: tree.bytes, files: tree.files.length, links: tree.links,
    status: 'live', conflictWith: '', sourceChanged: false, importedAt: '', _dir: entry.dir,
  };
  const dest = migrationSkillTarget(entry.id);
  const st = dest ? await migrationLstat(dest) : null;
  if (!st) { row.status = tree.tooLarge ? 'too-large' : 'live'; return row; }
  if (st.isSymbolicLink() || !st.isDirectory()) { row.status = 'conflict'; row.conflictWith = 'user'; return row; }
  const rec = await readSkillImportRecord(dest);
  if (!rec || rec.source !== src.source || rec.plugin !== (src.plugin || '') || !rec.sourcePath || samePathKey(rec.sourcePath) !== samePathKey(entry.dir)) {
    row.status = 'conflict'; row.conflictWith = rec ? rec.source : 'user';
    return row;
  }
  row.importedAt = rec.importedAt;
  const copyHash = await migrationTreeHash(await migrationSkillTree(dest));
  const srcHash = await migrationTreeHash(tree);
  row.sourceChanged = !srcHash || srcHash !== rec.sourceTreeHash;
  row.status = !copyHash || copyHash !== rec.copyTreeHash ? 'copy-edited' : (row.sourceChanged ? 'source-updated' : 'copied');
  return row;
}
async function migrationSkillRows(config) {
  // caps 传 null:与改版前扫描同口径(不为一张迁移清单去探能力矩阵),也不给 13u 添一条到 06 的边。
  const caps = null;
  const rows = [];
  for (const src of await migrationSkillSources()) {
    for (const entry of (await readSkillDir(src.baseDir, src.source, caps)).values()) rows.push(await migrationSkillRow(src, entry));
    if (rows.length >= 400) break;
  }
  // 同名时谁生效(只给看:活读那一行被谁盖住了)。user 目录里有同名 → 如意自己的那份生效。
  const winner = new Map();
  for (const r of rows) winner.set(r.id, r.key);
  for (const r of rows) {
    const userHas = r.status !== 'live' && r.status !== 'too-large';
    const w = winner.get(r.id);
    r.shadowedBy = userHas ? 'user' : (w !== r.key ? (rows.find(x => x.key === w) || {}).source || '' : '');
  }
  return rows;
}
function migrationSkillPublicRow(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) out[k] = v;
  return out;
}
async function migrationScanSkills(config) {
  return (await migrationSkillRows(config)).map(migrationSkillPublicRow);
}

const MIGRATION_SKILL_CAPSULE_NATIVE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// This process owns one skill's original NTFS objects. It never receives an encryption key.
public static class RuyiSkillCapsule {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation, Access, Write, Change; public uint Attr; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string p, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info value);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int kind, out Basic value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int kind, IntPtr value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(SafeFileHandle h, byte[] buffer, uint count, out uint read, IntPtr overlap);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(SafeFileHandle h, byte[] buffer, uint count, out uint wrote, IntPtr overlap);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h, long offset, out long result, uint method);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileSizeEx(SafeFileHandle h, out long size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool BackupRead(SafeFileHandle h, byte[] buffer, uint count, out uint read, bool abort, bool security, ref IntPtr context);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool BackupSeek(SafeFileHandle h, uint low, uint high, out uint doneLow, out uint doneHigh, ref IntPtr context);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle h, StringBuilder volume, uint volumeSize, out uint serial, out uint component, out uint flags, StringBuilder filesystem, uint filesystemSize);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle h, IntPtr iosb, IntPtr value, uint length, int kind);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle h,IntPtr iosb,IntPtr value,uint length,int kind);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetFileShortName(SafeFileHandle h,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CheckNameLegalDOS8Dot3(string name,IntPtr oem,uint size,out bool spaces,out bool legal);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 180000000, RecursionLimit = 512 };
  static readonly Dictionary<string, Node> Nodes = new Dictionary<string, Node>();
  static Dictionary<string,object> Snapshot;
  static SafeFileHandle Capsule;
  static string OriginalRoot;
  static long MaxBytes = 96000000, TotalBytes;
  static string Step = "idle";
  sealed class Node {
    public SafeFileHandle Handle; public bool Writable; public Dictionary<string,object> Entry;
    public Dictionary<string,SafeFileHandle> Streams = new Dictionary<string,SafeFileHandle>();
    public HashSet<string> ReadOnlyStreams = new HashSet<string>();
  }
  static Dictionary<string,object> Dict(object value) { return (Dictionary<string,object>)value; }
  static string Str(object value) { return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture); }
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Reject(string reason) { throw new InvalidOperationException(reason); }
  static SafeFileHandle Open(string file) {
    bool ignored; return Open(file, out ignored);
  }
  static SafeFileHandle Open(string file, out bool writable, bool dataStream = false) {
    // Known DATA streams exclude existing writers. Directories/new streams require
    // explicit set verification; Windows sharing is per-stream, not per-tree.
    FileAttributes attributes = File.GetAttributes(file);
    bool directory = !dataStream && (attributes & FileAttributes.Directory) != 0, readOnly = (attributes & FileAttributes.ReadOnly) != 0;
    writable = !directory && !readOnly;
    SafeFileHandle handle = CreateFile(file, writable ? 0xC0010000u : 0x80010100u, directory ? 7u : 5u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    return handle;
  }
  static string Id(SafeFileHandle handle) {
    Info info; Check(GetFileInformationByHandle(handle, out info));
    // Only SetBasic-restorable ordinary attributes. Reparse/EFS/sparse/compressed,
    // integrity/provider-specific metadata and multiple links need a different codec.
    if ((info.Attr & ~0x31b7u) != 0 || (info.Attr & 0x10u) == 0 && info.Links != 1) Reject("unsupported_object");
    return info.Volume.ToString("x8") + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8");
  }
  static string PathOf(SafeFileHandle handle) {
    StringBuilder value = new StringBuilder(32768);
    uint count = GetFinalPathNameByHandle(handle, value, (uint)value.Capacity, 0);
    if (count == 0 || count >= value.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
    return value.ToString();
  }
  static string VolumeOf(SafeFileHandle handle) {
    StringBuilder value = new StringBuilder(32768);
    uint count = GetFinalPathNameByHandle(handle,value,(uint)value.Capacity,1);
    if (count==0 || count>=value.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
    string path=value.ToString(); int end=path.IndexOf('}');
    if (!path.StartsWith(@"\\?\Volume{",StringComparison.OrdinalIgnoreCase) || end<0) Reject("volume_unsupported");
    return path.Substring(0,end+1);
  }
  static string ShortName(SafeFileHandle handle) {
    IntPtr iosb=Marshal.AllocHGlobal(IntPtr.Size*2), value=Marshal.AllocHGlobal(1024);
    try {
      int status=NtQueryInformationFile(handle,iosb,value,1024,21);
      if (status==unchecked((int)0xc0000034)) return "";
      if (status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
      int length=Marshal.ReadInt32(value);
      if (length<0 || length>24 || length%2!=0) Reject("short_name_shape");
      return Marshal.PtrToStringUni(IntPtr.Add(value,4),length/2);
    } finally { Marshal.FreeHGlobal(value); Marshal.FreeHGlobal(iosb); }
  }
  static void LegalShortName(string name) {
    if (name=="") return;
    bool spaces,legal; Check(CheckNameLegalDOS8Dot3(name,IntPtr.Zero,0,out spaces,out legal));
    if (spaces || !legal) Reject("unsupported_short_name");
  }
  static void ProbeShortNames(Dictionary<string,object> args) {
    string file=System.IO.Path.Combine(Str(args["root"]),".ruyi-short-probe-"+RandomName());
    // The same access as original directories/readonly files. Older platforms
    // needing SeRestorePrivilege fail here, before touching any original object.
    using (SafeFileHandle handle=CreateFile(file,0x80010100u,7,IntPtr.Zero,1,0x06000000u,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      string name="RC"+RandomName().Substring(0,6).ToUpperInvariant()+".TMP";
      Check(SetFileShortName(handle,name));
      if(!String.Equals(ShortName(handle),name,StringComparison.OrdinalIgnoreCase)) Reject("short_name_capability");
      Check(SetFileShortName(handle,""));
      if(ShortName(handle)!="") Reject("short_name_capability");
    }
  }
  static string RandomName() {
    byte[] bytes = new byte[32]; using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
    return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
  }
  static string Hash(byte[] bytes) { using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
  static void Rewind(SafeFileHandle handle) { long position; Check(SetFilePointerEx(handle, 0, out position, 0)); }
  static byte[] Read(SafeFileHandle handle) {
    long size; Check(GetFileSizeEx(handle, out size));
    if (size < 0 || size > MaxBytes) Reject("archive_limit");
    byte[] result = new byte[(int)size]; Rewind(handle);
    int used = 0;
    while (used < result.Length) {
      byte[] buffer = new byte[Math.Min(65536, result.Length - used)]; uint got;
      Check(ReadFile(handle, buffer, (uint)buffer.Length, out got, IntPtr.Zero));
      if (got == 0) Reject("source_changed");
      Buffer.BlockCopy(buffer, 0, result, used, (int)got); used += (int)got;
    }
    byte[] extra = new byte[1]; uint extraRead; Check(ReadFile(handle, extra, 1, out extraRead, IntPtr.Zero));
    if (extraRead != 0) Reject("source_changed");
    return result;
  }
  static void Write(SafeFileHandle handle, byte[] bytes) {
    Rewind(handle); int offset = 0;
    while (offset < bytes.Length) {
      byte[] buffer = new byte[Math.Min(65536, bytes.Length - offset)];
      Buffer.BlockCopy(bytes, offset, buffer, 0, buffer.Length); uint wrote;
      Check(WriteFile(handle, buffer, (uint)buffer.Length, out wrote, IntPtr.Zero));
      if (wrote == 0) Reject("write_failed"); offset += (int)wrote;
    }
    Check(SetEndOfFile(handle)); Check(FlushFileBuffers(handle));
  }
  static byte[] BackupBytes(SafeFileHandle handle, int count, ref IntPtr context, bool eofAllowed) {
    byte[] result = new byte[count]; int used = 0;
    while (used < count) {
      byte[] buffer = new byte[count - used]; uint got;
      Check(BackupRead(handle, buffer, (uint)buffer.Length, out got, false, false, ref context));
      if (got == 0) { if (used == 0 && eofAllowed) return null; Reject("stream_header"); }
      Buffer.BlockCopy(buffer, 0, result, used, (int)got); used += (int)got;
    }
    return result;
  }
  static List<string> StreamNames(Node node) {
    List<string> names = new List<string>(); IntPtr context = IntPtr.Zero;
    try {
      while (true) {
        byte[] header = BackupBytes(node.Handle, 20, ref context, true); if (header == null) break;
        uint kind = BitConverter.ToUInt32(header, 0), flags = BitConverter.ToUInt32(header, 4), length = BitConverter.ToUInt32(header, 16);
        long size = BitConverter.ToInt64(header, 8);
        if (length > 65536 || size < 0 || size > MaxBytes || flags != 0) Reject("unsupported_stream");
        string name = length == 0 ? "" : Encoding.Unicode.GetString(BackupBytes(node.Handle, (int)length, ref context, false));
        if (kind != 1 && kind != 4) Reject("unsupported_stream");
        if (kind == 4 && (!name.StartsWith(":") || !name.EndsWith(":$DATA") || name.IndexOf('\0') >= 0)) Reject("stream_name");
        if (kind == 1) name = "";
        if (names.Contains(name)) Reject("stream_duplicate"); names.Add(name);
        uint low, high; Check(BackupSeek(node.Handle, (uint)size, (uint)((ulong)size >> 32), out low, out high, ref context));
        if ((((ulong)high << 32) | low) != (ulong)size) Reject("stream_seek");
      }
    } finally { uint ignored; BackupRead(node.Handle, new byte[1], 0, out ignored, true, false, ref context); }
    // BackupRead may omit the unnamed DATA header for an empty ordinary file.
    if ((BasicOf(node.Handle).Attr & 0x10u) == 0 && !names.Contains("")) {
      long size; Check(GetFileSizeEx(node.Handle, out size));
      if (size != 0) Reject("default_stream_missing"); names.Add("");
    }
    return names;
  }
  static Basic BasicOf(SafeFileHandle handle) { Basic info; Check(GetFileInformationByHandleEx(handle, 0, out info, (uint)Marshal.SizeOf(typeof(Basic)))); return info; }
  static void Walk(string path, string rel, List<object> entries, bool capture) {
    if (entries.Count >= 10000 || rel.Split('/').Length > 256) Reject("archive_limit");
    Node node = new Node(); node.Handle = Open(path, out node.Writable);
    try {
      string id = Id(node.Handle); if (Nodes.ContainsKey(id)) Reject("object_duplicate");
      Basic basic = BasicOf(node.Handle); bool directory = (basic.Attr & 0x10u) != 0;
      node.Entry = new Dictionary<string,object> { { "rel", rel }, { "opaque", RandomName() }, { "id", id }, { "dir", directory }, { "attrs", basic.Attr },
        { "shortName", ShortName(node.Handle) }, { "times", new string[] { Str(basic.Creation), Str(basic.Access), Str(basic.Write), Str(basic.Change) } } };
      LegalShortName(Str(node.Entry["shortName"]));
      Nodes.Add(id, node); entries.Add(node.Entry);
      List<object> streams = new List<object>();
      foreach (string name in StreamNames(node)) {
        if (directory && name == "") Reject("directory_data");
        bool writable = node.Writable;
        SafeFileHandle handle = name == "" ? node.Handle : Open(PathOf(node.Handle) + name, out writable, true);
        if (name != "") { node.Streams.Add(name, handle); if (!writable) node.ReadOnlyStreams.Add(name); }
        if (capture) {
          byte[] bytes = Read(handle); TotalBytes += bytes.Length;
          if (TotalBytes > MaxBytes) Reject("archive_limit");
          streams.Add(new Dictionary<string,object> { { "name", name }, { "size", bytes.Length }, { "hash", Hash(bytes) }, { "data", Convert.ToBase64String(bytes) } });
          Array.Clear(bytes, 0, bytes.Length);
        }
      }
      if (!directory && !StreamNames(node).Contains("")) Reject("default_stream_missing");
      node.Entry["streams"] = streams;
      if (directory) foreach (string child in Directory.GetFileSystemEntries(path)) Walk(child, rel == "" ? System.IO.Path.GetFileName(child) : rel + "/" + System.IO.Path.GetFileName(child), entries, capture);
    } catch { if (!Nodes.ContainsValue(node)) node.Handle.Dispose(); throw; }
  }
  static object Capture(Dictionary<string,object> args) {
    if (Nodes.Count != 0) Reject("already_open"); TotalBytes = 0;
    List<object> entries = new List<object>(); Walk(Str(args["root"]), "", entries, true);
    StringBuilder filesystem = new StringBuilder(64); uint serial, component, flags;
    Check(GetVolumeInformationByHandleW(RootNode().Handle, null, 0, out serial, out component, out flags, filesystem, 64));
    if (filesystem.ToString() != "NTFS") Reject("filesystem_unsupported");
    Snapshot = new Dictionary<string,object> { { "schema", 1 }, { "platform", "ntfs-objects-v1" }, { "revision", Str(args["revision"]) }, { "entries", entries } };
    OriginalRoot = PathOf(RootNode().Handle);
    VerifyOriginalLayout(); Verify(false, true); return Snapshot;
  }
  static void Attach(Dictionary<string,object> args) {
    if (Nodes.Count != 0) Reject("already_open"); Snapshot = Dict(args["snapshot"]);
    List<object> current = new List<object>();
    foreach (object root in (IEnumerable)args["roots"]) Walk(Str(root), "", current, false);
    foreach (object raw in (IEnumerable)Snapshot["entries"]) {
      Dictionary<string,object> entry = Dict(raw); string id = Str(entry["id"]);
      LegalShortName(Str(entry["shortName"]));
      if (!Nodes.ContainsKey(id)) Reject("object_missing"); Nodes[id].Entry = entry;
    }
    if (current.Count != Expected().Count) Reject("entry_set_changed");
  }
  static void Rename(Node node, string target, SafeFileHandle parent = null) {
    string current = PathOf(node.Handle);
    string fullTarget = parent == null ? target : System.IO.Path.Combine(PathOf(parent), target);
    if (String.Equals(current, fullTarget, StringComparison.OrdinalIgnoreCase)) return;
    byte[] name = Encoding.Unicode.GetBytes(target); int offset = IntPtr.Size == 8 ? 20 : 12;
    IntPtr value = Marshal.AllocHGlobal(offset + name.Length);
    try {
      for (int i=0;i<offset + name.Length;i++) Marshal.WriteByte(value, i, 0);
      if (parent != null) Marshal.WriteIntPtr(value, IntPtr.Size == 8 ? 8 : 4, parent.DangerousGetHandle());
      Marshal.WriteInt32(value, IntPtr.Size == 8 ? 16 : 8, name.Length); Marshal.Copy(name, 0, IntPtr.Add(value, offset), name.Length);
      IntPtr iosb = Marshal.AllocHGlobal(IntPtr.Size * 2);
      try { int status = NtSetInformationFile(node.Handle, iosb, value, (uint)(offset + name.Length), 10); if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status)); }
      finally { Marshal.FreeHGlobal(iosb); }
    } finally { Marshal.FreeHGlobal(value); }
  }
  static Node RootNode() { foreach (Node node in Nodes.Values) if (Str(node.Entry["rel"]) == "") return node; throw new InvalidOperationException("root_missing"); }
  static List<Node> Expected() {
    List<Node> result = new List<Node>(); foreach (object raw in (IEnumerable)Snapshot["entries"]) result.Add(Nodes[Str(Dict(raw)["id"])]); return result;
  }
  static void DeleteStream(SafeFileHandle handle) {
    IntPtr value = Marshal.AllocHGlobal(1);
    try { Marshal.WriteByte(value, 1); Check(SetFileInformationByHandle(handle, 4, value, 1)); }
    finally { Marshal.FreeHGlobal(value); handle.Dispose(); }
  }
  static void UpgradeStream(Node node, string name) {
    SafeFileHandle old = name == "" ? node.Handle : node.Streams[name];
    string path = PathOf(old), expected = Id(old);
    // This attribute-only guard remains bound to the original object during the
    // short read-only DATA-handle handoff. It never bypasses another DATA writer.
    SafeFileHandle guard = CreateFile(path,0x180u,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if (guard.IsInvalid) { guard.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    if (Id(guard) != expected) { guard.Dispose(); Reject("identity_changed"); }
    old.Dispose();
    SafeFileHandle replacement = CreateFile(path,0xC0010000u,5,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    int failure = replacement.IsInvalid ? Marshal.GetLastWin32Error() : 0;
    if (failure != 0 || Id(replacement) != expected) {
      replacement.Dispose();
      if (name == "") node.Handle=guard; else node.Streams[name]=guard;
      RestoreNodeBasic(node,guard);
      if (failure != 0) throw new Win32Exception(failure);
      Reject("identity_changed");
    }
    guard.Dispose();
    if (name == "") { node.Handle=replacement; node.Writable=true; } else node.Streams[name]=replacement;
  }
  static void EnsureWritable(Node node) {
    Basic basic = BasicOf(node.Handle);
    if ((basic.Attr & 1u) != 0) {
      // A read-only ordinary file can be renamed, but cannot be truncated until
      // its attribute is cleared. This runs only after the durable archive/intent.
      basic.Attr &= ~1u; IntPtr value = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Basic)));
      try { Marshal.StructureToPtr(basic,value,false); Check(SetFileInformationByHandle(node.Handle,0,value,(uint)Marshal.SizeOf(typeof(Basic)))); }
      finally { Marshal.FreeHGlobal(value); }
    }
    if (!(bool)node.Entry["dir"] && !node.Writable) UpgradeStream(node, "");
    foreach (string name in new List<string>(node.ReadOnlyStreams)) UpgradeStream(node, name);
    node.ReadOnlyStreams.Clear();
  }
  static void Verify(bool cleared, bool exact) {
    List<Node> expected = Expected(); if (exact && expected.Count != Nodes.Count) Reject("entry_set_changed");
    VerifyEntries(expected);
    foreach (Node node in expected) {
      if (Id(node.Handle) != Str(node.Entry["id"])) Reject("identity_changed");
      List<string> current = StreamNames(node), names = new List<string>();
      foreach (object raw in (IEnumerable)node.Entry["streams"]) names.Add(Str(Dict(raw)["name"]));
      foreach (string name in current) if (!names.Contains(name) || cleared && name != "") Reject("stream_set_changed");
      if (cleared) {
        if (ShortName(node.Handle)!="") Reject("short_name_not_cleared");
        if (!(bool)node.Entry["dir"]) { long size; Check(GetFileSizeEx(node.Handle, out size)); if (size != 0) Reject("not_cleared"); }
      } else {
        foreach (object raw in (IEnumerable)node.Entry["streams"]) {
          Dictionary<string,object> stream = Dict(raw); string name = Str(stream["name"]);
          if (!current.Contains(name)) Reject("stream_missing");
          SafeFileHandle handle = name == "" ? node.Handle : node.Streams[name];
          byte[] bytes = Read(handle); if (Hash(bytes) != Str(stream["hash"])) Reject("content_changed"); Array.Clear(bytes, 0, bytes.Length);
        }
      }
    }
  }
  static void VerifyEntries(List<Node> expected) {
    HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (Node node in expected) paths.Add(PathOf(node.Handle));
    foreach (Node node in expected) if ((bool)node.Entry["dir"]) {
      foreach (string child in Directory.GetFileSystemEntries(PathOf(node.Handle))) {
        if (!paths.Contains(child)) Reject("entry_set_changed");
      }
    }
  }
  static void VerifyOriginalLayout() {
    if (!String.Equals(PathOf(RootNode().Handle), OriginalRoot, StringComparison.OrdinalIgnoreCase)) Reject("root_changed");
    foreach (Node node in Expected()) {
      string rel = Str(node.Entry["rel"]);
      string expected = rel == "" ? OriginalRoot : System.IO.Path.Combine(OriginalRoot, rel.Replace('/', '\\'));
      if (!String.Equals(PathOf(node.Handle), expected, StringComparison.OrdinalIgnoreCase)) Reject("entry_set_changed");
      if (!String.Equals(ShortName(node.Handle),Str(node.Entry["shortName"]),StringComparison.OrdinalIgnoreCase)) Reject("short_name_changed");
    }
  }
  static void VerifyRestorable() {
    List<Node> expected = Expected(); VerifyEntries(expected);
    foreach (Node node in expected) {
      Dictionary<string,object> streams = new Dictionary<string,object>();
      foreach (object raw in (IEnumerable)node.Entry["streams"]) streams.Add(Str(Dict(raw)["name"]), raw);
      foreach (string name in StreamNames(node)) {
        if (!streams.ContainsKey(name)) Reject("stream_set_changed");
        SafeFileHandle handle = name == "" ? node.Handle : node.Streams[name];
        byte[] actual = Read(handle), original = Convert.FromBase64String(Str(Dict(streams[name])["data"]));
        // Interrupted writes can only be a prefix of the authenticated original.
        if (actual.Length > original.Length) Reject("content_changed");
        for (int i=0;i<actual.Length;i++) if (actual[i] != original[i]) Reject("content_changed");
        Array.Clear(actual,0,actual.Length); Array.Clear(original,0,original.Length);
      }
    }
  }
  static void Seal(Dictionary<string,object> args) {
    // Detect unknown nodes/streams before clearing any data, then verify again afterwards.
    List<Node> expected = Expected(); if (expected.Count != Nodes.Count) Reject("entry_set_changed");
    VerifyOriginalLayout();
    Verify(false, true);
    foreach (Node node in expected) {
      List<string> allowed = new List<string>(); foreach (object raw in (IEnumerable)node.Entry["streams"]) allowed.Add(Str(Dict(raw)["name"]));
      foreach (string name in StreamNames(node)) if (!allowed.Contains(name)) Reject("stream_set_changed");
    }
    if (Capsule == null) Capsule = Open(Str(args["container"]));
    Id(Capsule);
    if (!String.Equals(VolumeOf(Capsule),VolumeOf(RootNode().Handle),StringComparison.OrdinalIgnoreCase)) Reject("cross_volume");
    // Upgrade every initially read-only DATA stream before clearing any object.
    // A new writer in a handoff gap causes rejection with the original Basic restored.
    try { foreach (Node node in expected) EnsureWritable(node); }
    catch { RestoreBasic(expected); throw; }
    VerifyOriginalLayout(); Verify(false,true);
    expected.Sort(delegate(Node a, Node b) { return Str(b.Entry["rel"]).Length.CompareTo(Str(a.Entry["rel"]).Length); });
    foreach (Node node in expected) {
      if (!String.Equals(PathOf(RootNode().Handle), OriginalRoot, StringComparison.OrdinalIgnoreCase)) Reject("root_changed");
      string rel = Str(node.Entry["rel"]);
      string expectedPath = rel == "" ? OriginalRoot : System.IO.Path.Combine(OriginalRoot, rel.Replace('/', '\\'));
      if (!String.Equals(PathOf(node.Handle), expectedPath, StringComparison.OrdinalIgnoreCase)) Reject("entry_set_changed");
      Id(node.Handle);
      // Upgrade of an initially read-only handle must exclude pre-existing
      // writers and revalidate its authenticated content before the first clear.
      foreach (object raw in (IEnumerable)node.Entry["streams"]) {
        Dictionary<string,object> stream=Dict(raw); string name=Str(stream["name"]);
        byte[] bytes=Read(name==""?node.Handle:node.Streams[name]);
        if (Hash(bytes)!=Str(stream["hash"])) Reject("content_changed"); Array.Clear(bytes,0,bytes.Length);
      }
      Step = "truncate";
      if (!(bool)node.Entry["dir"]) Write(node.Handle, new byte[0]);
      Step = "delete-stream";
      foreach (SafeFileHandle handle in node.Streams.Values) DeleteStream(handle); node.Streams.Clear(); node.ReadOnlyStreams.Clear();
      Step = "rename-node";
      Rename(node, Str(node.Entry["opaque"]), Capsule);
      Check(SetFileShortName(node.Handle,""));
    }
    Verify(true, true);
    string[] actual = Directory.GetFileSystemEntries(PathOf(Capsule)); if (actual.Length != expected.Count) Reject("entry_set_changed");
  }
  static void SetAlias(Node node,string name) {
    LegalShortName(name);
    if (String.Equals(ShortName(node.Handle),name,StringComparison.OrdinalIgnoreCase)) return;
    // NTFS refuses directory short-name mutation while a descendant is open.
    // Child directories are still empty; Publish handles the root after releasing descendants.
    Step="alias-remove"; Check(SetFileShortName(node.Handle,""));
    if(name!="") { Step="alias-set"; Check(SetFileShortName(node.Handle,name)); }
    if(!String.Equals(ShortName(node.Handle),name,StringComparison.OrdinalIgnoreCase)) Reject("short_name_changed");
  }
  static void Flatten(List<Node> expected,bool root) {
    expected.Sort(delegate(Node a,Node b){return PathOf(b.Handle).Length.CompareTo(PathOf(a.Handle).Length);});
    foreach(Node node in expected) {
      if(!root && Str(node.Entry["rel"])=="") continue;
      VerifyEntries(expected);
      Step="flatten-node"; Rename(node,Str(node.Entry["opaque"]),Capsule); SetAlias(node,"");
    }
  }
  static void Assemble(List<Node> expected) {
    expected.Sort(delegate(Node a,Node b){return Str(a.Entry["rel"]).Length.CompareTo(Str(b.Entry["rel"]).Length);});
    Dictionary<string,Node> parents=new Dictionary<string,Node>();
    foreach(Node node in expected) parents.Add(Str(node.Entry["rel"]),node);
    foreach(Node node in expected) {
      string rel=Str(node.Entry["rel"]); if(rel=="") continue;
      VerifyEntries(expected);
      int slash=rel.LastIndexOf('/');string parentRel=slash<0?"":rel.Substring(0,slash);
      string name=slash<0?rel:rel.Substring(slash+1),alias=Str(node.Entry["shortName"]);
      if(String.Equals(name,alias,StringComparison.OrdinalIgnoreCase)) SetAlias(node,alias);
      Step="restore-child"; Rename(node,name,parents[parentRel].Handle);
      SetAlias(node,alias);
    }
  }
  static void VerifyNames(string root,bool rootAlias) {
    if(!root.StartsWith(@"\\?\")) root=@"\\?\"+System.IO.Path.GetFullPath(root);
    foreach(Node node in Expected()) {
      string rel=Str(node.Entry["rel"]),target=rel==""?root:System.IO.Path.Combine(root,rel.Replace('/','\\'));
      if(!String.Equals(PathOf(node.Handle),target,StringComparison.OrdinalIgnoreCase)) Reject("entry_set_changed");
      if((rootAlias || rel!="") && !String.Equals(ShortName(node.Handle),Str(node.Entry["shortName"]),StringComparison.OrdinalIgnoreCase)) Reject("short_name_changed");
    }
  }
  static void Restore(Dictionary<string,object> args) {
    VerifyRestorable();
    List<Node> expected=Expected();
    if(Capsule==null) Capsule=Open(Str(args["container"]));
    foreach(Node node in expected) EnsureWritable(node);
    Flatten(expected,true);
    Step="restore-root";
    using(SafeFileHandle parent=Open(System.IO.Path.GetDirectoryName(Str(args["target"])))) Rename(RootNode(),System.IO.Path.GetFileName(Str(args["target"])),parent);
    SetAlias(RootNode(),""); Assemble(expected);
    foreach(Node node in expected) {
      foreach(object raw in (IEnumerable)node.Entry["streams"]) {
        Dictionary<string,object> stream=Dict(raw);string name=Str(stream["name"]);
        byte[] bytes=Convert.FromBase64String(Str(stream["data"]));
        if(bytes.Length!=Convert.ToInt32(stream["size"]) || Hash(bytes)!=Str(stream["hash"])) Reject("archive_content");
        SafeFileHandle handle;
        if(name=="") handle=node.Handle;
        else if(!node.Streams.TryGetValue(name,out handle)) {
          handle=CreateFile(PathOf(node.Handle)+name,0xC0010000,5,IntPtr.Zero,4,0,IntPtr.Zero);
          if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());node.Streams.Add(name,handle);
        }
        Step="restore-content";Write(handle,bytes);Array.Clear(bytes,0,bytes.Length);
      }
    }
    Step="restore-verify";Verify(false,true);VerifyNames(Str(args["target"]),false);RestoreBasic(expected);
  }
  static void CheckPublication(Dictionary<string,object> args) {
    string alias=Str(RootNode().Entry["shortName"]);if(alias=="") return;
    string candidate=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(Str(args["target"])),alias);
    using(SafeFileHandle handle=CreateFile(candidate,0x80u,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(handle.IsInvalid) { int code=Marshal.GetLastWin32Error();if(code==2 || code==3)return;throw new Win32Exception(code); }
      string id=Id(handle);
      if(id!=Str(RootNode().Entry["id"]) && (!args.ContainsKey("allowedId") || id!=Str(args["allowedId"]))) Reject("root_alias_collision");
    }
  }
  static void FinishPublished(Dictionary<string,object> args) {
    // An already visible old root can still be between publication and final
    // alias/Basic restoration. Relock and verify the original objects before completing.
    Verify(false,true); Publish(args);
  }
  static void RestoreBasic(List<Node> source) {
    List<Node> expected = new List<Node>(source);
    expected.Sort(delegate(Node a, Node b) { return Str(b.Entry["rel"]).Length.CompareTo(Str(a.Entry["rel"]).Length); });
    foreach (Node node in expected) RestoreNodeBasic(node,node.Handle);
  }
  static void RestoreNodeBasic(Node node, SafeFileHandle handle) {
      List<string> times = new List<string>(); foreach (object raw in (IEnumerable)node.Entry["times"]) times.Add(Str(raw));
      Basic info = new Basic { Creation=long.Parse(times[0]), Access=long.Parse(times[1]), Write=long.Parse(times[2]), Change=long.Parse(times[3]), Attr=Convert.ToUInt32(node.Entry["attrs"]) };
      IntPtr value = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Basic)));
      Step="restore-basic";
      try { Marshal.StructureToPtr(info, value, false); Check(SetFileInformationByHandle(handle, 0, value, (uint)Marshal.SizeOf(typeof(Basic)))); }
      finally { Marshal.FreeHGlobal(value); }
      Basic actual = BasicOf(handle);
      if (actual.Creation != info.Creation || actual.Access != info.Access || actual.Write != info.Write
          || actual.Change != info.Change || actual.Attr != info.Attr) Reject("metadata_changed");
  }
  static void Publish(Dictionary<string,object> args) {
    Verify(false,true); CheckPublication(args);
    Node root=RootNode();
    foreach(Node node in Nodes.Values) {
      foreach(SafeFileHandle stream in node.Streams.Values) stream.Dispose();node.Streams.Clear();
      if(node!=root) node.Handle.Dispose();
    }
    string error=null;
    try {
      string name=System.IO.Path.GetFileName(Str(args["target"]));
      string alias=Str(root.Entry["shortName"]);
      if(String.Equals(alias,name,StringComparison.OrdinalIgnoreCase)) SetAlias(root,alias);
      using(SafeFileHandle parent=Open(System.IO.Path.GetDirectoryName(Str(args["target"])))) Rename(root,name,parent);
      SetAlias(root,alias);
    } catch(Win32Exception failure) { error="publish_win32_"+failure.NativeErrorCode; }
    string current=PathOf(root.Handle);root.Handle.Dispose();Nodes.Clear();
    List<object> entries=new List<object>();Walk(current,"",entries,false);
    foreach(object raw in (IEnumerable)Snapshot["entries"]) {
      Dictionary<string,object> entry=Dict(raw);string id=Str(entry["id"]);
      if(!Nodes.ContainsKey(id)) Reject("object_missing");Nodes[id].Entry=entry;
    }
    Verify(false,true);
    if(error!=null) Reject(error);
    VerifyNames(Str(args["target"]),true);RestoreBasic(Expected());
  }
  static void Close() {
    foreach (Node node in Nodes.Values) { foreach (SafeFileHandle stream in node.Streams.Values) stream.Dispose(); node.Handle.Dispose(); }
    Nodes.Clear(); Snapshot = null; OriginalRoot = null; if (Capsule != null) { Capsule.Dispose(); Capsule = null; }
  }
  public static void Run() {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    try {
      string line;
      while ((line = Console.ReadLine()) != null) {
        try {
          Dictionary<string,object> args = Dict(Json.DeserializeObject(line)); string command = Str(args["cmd"]); object result = null;
          if (command == "capture") result = Capture(args);
          else if (command == "short-probe") ProbeShortNames(args);
          else if (command == "attach") Attach(args);
          else if (command == "seal") Seal(args);
          else if (command == "restore") Restore(args);
          else if (command == "publish") Publish(args);
          else if (command == "finish-published") FinishPublished(args);
          else if (command == "publish-check") CheckPublication(args);
          else if (command == "verify") Verify(Convert.ToBoolean(args["cleared"]), true);
          else if (command == "close") { Close(); Console.WriteLine("{\"ok\":true}"); return; }
          else Reject("command_invalid");
          Console.WriteLine(Json.Serialize(new Dictionary<string,object> { { "ok", true }, { "value", result } }));
        } catch (Exception error) {
          Win32Exception native = error as Win32Exception;
          string code = native == null ? error is InvalidOperationException ? error.Message : "native_failure" : Step.Replace('-','_') + "_win32_" + native.NativeErrorCode;
          Console.WriteLine(Json.Serialize(new Dictionary<string,object> { { "ok", false }, { "code", code } }));
        }
      }
    } finally { Close(); }
  }
}
`;

// Skill backup capsules retain the original NTFS objects (including their unreadable
// security descriptors). Only DATA bytes/names are archived; no key reaches the broker.
// The private directory is not a cross-process CAS against a hostile same-account peer.
const MIGRATION_CAPSULE_MARKER = '.ruyi-capsule-v1';
const MIGRATION_CAPSULE_ARCHIVE_LIMIT = 160 * 1024 * 1024;
const MIGRATION_CAPSULE_BINARY_LIMIT = 128 * 1024 * 1024;
function migrationCapsuleFail(reason, uncertain = false) {
  const code = 'work_data_backup.' + reason;
  throw Object.assign(new Error(code), { code, apiCode: code, statusCode: 503,
    ...(uncertain ? { operationMayHaveExecuted: true, resultUnavailable: true, retry: false } : {}) });
}
function migrationCapsuleDescriptor(backup) {
  const base = path.resolve(migrationDir(), MIGRATION_SKILL_BACKUP_DIR);
  const rel = path.relative(base, path.resolve(backup)).split(path.sep);
  if (rel.length !== 2 || !/^[0-9TZ-]+$/.test(rel[0]) || !SKILL_ID_RE.test(rel[1])) migrationCapsuleFail('binding');
  return { backup: path.join(base, ...rel), stamp: rel[0], id: rel[1],
    scopeId: 'skill-backups:' + rel[0], recordId: 'skill-backup:' + (process.platform === 'win32' ? rel[1].toLowerCase() : rel[1]) };
}
function migrationCapsuleShape(snapshot) {
  if (!snapshot || snapshot.schema !== 1 || snapshot.platform !== 'ntfs-objects-v1'
      || !/^[a-f0-9]{64}$/.test(snapshot.revision || '') || !Array.isArray(snapshot.entries)
      || snapshot.entries.length < 1 || snapshot.entries.length > 10000) return false;
  const names = new Set(), ids = new Set(), opaque = new Set();
  let total = 0;
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.rel !== 'string' || entry.rel.length > 30000 || typeof entry.dir !== 'boolean'
        || !/^[a-f0-9]{24}$/.test(entry.id || '') || !/^[a-f0-9]{64}$/.test(entry.opaque || '')
        || !Number.isInteger(entry.attrs) || entry.attrs < 0 || entry.attrs > 0xffffffff
        || (entry.attrs & ~0x31b7) !== 0
        || !!(entry.attrs & 0x10) !== entry.dir || !Array.isArray(entry.times) || entry.times.length !== 4
        || typeof entry.shortName !== 'string' || entry.shortName.length > 12
        || entry.shortName && (/[\\/:*?"<>|\x00-\x20]/.test(entry.shortName) || ['.', '..'].includes(entry.shortName))
        || !entry.times.every(time => typeof time === 'string' && /^\d{1,19}$/.test(time) && BigInt(time) <= 9223372036854775807n)
        || !Array.isArray(entry.streams) || entry.streams.length > 1024) return false;
    const segments = entry.rel.split('/');
    if (entry.rel && (segments.length > 256 || segments.some(part => !part || part === '.' || part === '..'
        || /[\\:*?"<>|\x00-\x1f]/.test(part) || /[. ]$/.test(part) || part.length > 255))) return false;
    const key = entry.rel.toLowerCase();
    if (names.has(key) || ids.has(entry.id) || opaque.has(entry.opaque)) return false;
    names.add(key); ids.add(entry.id); opaque.add(entry.opaque);
    const streams = new Set();
    for (const stream of entry.streams) {
      if (!stream || typeof stream.name !== 'string' || stream.name.length > 1024
          || stream.name !== '' && !/^:[^:\\/*?"<>|\x00-\x1f]+:\$DATA$/.test(stream.name)
          || entry.dir && stream.name === '' || !Number.isSafeInteger(stream.size) || stream.size < 0
          || !/^[a-f0-9]{64}$/.test(stream.hash || '') || typeof stream.data !== 'string'
          || stream.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(stream.data)) return false;
      const streamKey = stream.name.toLowerCase();
      if (streams.has(streamKey)) return false;
      streams.add(streamKey);
      const bytes = Buffer.from(stream.data, 'base64');
      const valid = bytes.length === stream.size && bytes.toString('base64') === stream.data
        && crypto.createHash('sha256').update(bytes).digest('hex') === stream.hash;
      total += bytes.length; bytes.fill(0);
      if (!valid || total > 96000000) return false;
    }
    if (!entry.dir && !streams.has('')) return false;
  }
  if (!names.has('') || !snapshot.entries.find(entry => entry.rel === '').dir) return false;
  const dirs = new Set(snapshot.entries.filter(entry => entry.dir).map(entry => entry.rel.toLowerCase()));
  const aliases = new Set();
  return snapshot.entries.every(entry => {
    const parent = entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')).toLowerCase() : '';
    if (entry.rel && !dirs.has(parent)) return false;
    // The root alias belongs to the external skills parent, not its own child namespace.
    if (!entry.rel || !entry.shortName) return true;
    const alias = (parent ? parent + '/' : '') + entry.shortName.toLowerCase();
    if (aliases.has(alias) || names.has(alias) && alias !== entry.rel.toLowerCase()) return false;
    aliases.add(alias); return true;
  });
}
function migrationCapsuleFingerprint(snapshot) {
  return snapshot.entries.map(entry => ({ rel: entry.rel, id: entry.id, dir: entry.dir,
    streams: entry.streams.map(stream => ({ name: stream.name, size: stream.size, hash: stream.hash })).sort((a, b) => a.name.localeCompare(b.name))
  })).sort((a, b) => a.rel.localeCompare(b.rel));
}
function migrationCapsuleSame(snapshot, fingerprint) {
  return JSON.stringify(migrationCapsuleFingerprint(snapshot)) === JSON.stringify(fingerprint);
}
function migrationCapsuleDecode(bytes) {
  let decoded;
  try { decoded = require('node:zlib').gunzipSync(bytes, { maxOutputLength: MIGRATION_CAPSULE_ARCHIVE_LIMIT }); }
  catch { migrationCapsuleFail('archive'); }
  try {
    const snapshot = JSON.parse(decoded.toString('utf8'));
    if (!migrationCapsuleShape(snapshot)) migrationCapsuleFail('shape');
    return snapshot;
  } catch (error) {
    if (String(error?.code || '').startsWith('work_data')) throw error;
    migrationCapsuleFail('shape');
  } finally { decoded.fill(0); }
}
function migrationCapsuleArchive(descriptor) {
  return WorkDataStore.createBinary({ file: () => path.join(descriptor.backup, 'archive'),
    purpose: 'backup', schema: 1, scopeId: descriptor.scopeId, recordId: descriptor.recordId + ':archive',
    chunked: true, maxPlaintextBytes: 192 * 1024 * 1024, maxBinaryBytes: MIGRATION_CAPSULE_BINARY_LIMIT,
    enabled: async () => true, // this format has no plaintext capsule representation
    validateLegacyBinary: (bytes, context) => {
      // A capsule never had a legacy gzip representation. The shared binary store
      // supports one for other families; marker bytes inside gzip cannot authorize it here.
      if (context?.sealed !== true) migrationCapsuleFail('carrier');
      migrationCapsuleDecode(bytes); return true;
    }, writeJson: atomicWriteJson });
}
function migrationCapsuleIntentShape(value, descriptor) {
  return !!value && value.schema === 1 && value.id === descriptor.id && value.stamp === descriptor.stamp
    && /^[a-f0-9]{64}$/.test(value.revision || '') && ['preparing', 'ready', 'published', 'restoring', 'complete', 'aborted'].includes(value.phase)
    && /^[a-f0-9]{24}$/.test(value.oldRoot || '') && migrationCapsuleFingerprintShape(value.newTree)
    && value.newTree.find(entry => entry.rel === '').id !== value.oldRoot
    && value.sourceStage === MIGRATION_SKILL_STAGE_PREFIX + descriptor.id + '-' + descriptor.stamp;
}
function migrationCapsuleFingerprintShape(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 10000) return false;
  const names = new Set(), ids = new Set(), directories = new Set();
  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.rel !== 'string' || entry.rel.length > 30000 || typeof entry.dir !== 'boolean'
        || !/^[a-f0-9]{24}$/.test(entry.id || '') || !Array.isArray(entry.streams) || entry.streams.length > 1024) return false;
    const segments = entry.rel.split('/');
    if (entry.rel && (segments.length > 256 || segments.some(part => !part || part === '.' || part === '..'
        || /[\\:*?"<>|\x00-\x1f]/.test(part) || /[. ]$/.test(part) || part.length > 255))) return false;
    const key = entry.rel.toLowerCase();
    if (names.has(key) || ids.has(entry.id)) return false;
    names.add(key); ids.add(entry.id); if (entry.dir) directories.add(key);
    const streams = new Set();
    for (const stream of entry.streams) {
      if (!stream || typeof stream.name !== 'string' || stream.name.length > 1024
          || stream.name !== '' && !/^:[^:\\/*?"<>|\x00-\x1f]+:\$DATA$/.test(stream.name)
          || entry.dir && stream.name === '' || !Number.isSafeInteger(stream.size) || stream.size < 0
          || !/^[a-f0-9]{64}$/.test(stream.hash || '') || streams.has(stream.name.toLowerCase())) return false;
      streams.add(stream.name.toLowerCase()); total += stream.size;
      if (total > 96000000) return false;
    }
    if (!entry.dir && !streams.has('')) return false;
  }
  return directories.has('') && entries.every(entry => !entry.rel || directories.has(entry.rel.includes('/')
    ? entry.rel.slice(0, entry.rel.lastIndexOf('/')).toLowerCase() : ''));
}
function migrationCapsuleIntent(descriptor) {
  const file = () => path.join(descriptor.backup, 'intent');
  const store = onAuthenticated => WorkDataStore.createText({ file, purpose: 'backup', schema: 1,
    scopeId: descriptor.scopeId, recordId: descriptor.recordId + ':intent', chunked: true, maxPlaintextBytes: 16 * 1024 * 1024,
    enabled: async () => true,
    validateSealedText: text => {
      const valid = migrationCapsuleIntentShape(safeJsonParse(text, null), descriptor);
      if (valid && onAuthenticated) onAuthenticated();
      return valid;
    }, writeJson: atomicWriteJson });
  return Object.freeze({ filePath: file, write: text => store().write(text), read: async () => {
    // createText intentionally permits legacy plaintext for other hosts. Require
    // this invocation's validator to run through its authenticated read path.
    let authenticated = false;
    const text = await store(() => { authenticated = true; }).read();
    if (!authenticated) migrationCapsuleFail('carrier');
    return text;
  } });
}
async function migrationCapsuleRequireCarrier(file, descriptor, kind) {
  const handle = await fsp.open(file, 'r');
  try {
    const bytes = Buffer.alloc(16 * 1024 + 1); let used = 0, end = -1;
    while (used < bytes.length && end < 0) {
      const next = await handle.read(bytes, used, bytes.length - used, used);
      if (!next.bytesRead) break;
      used += next.bytesRead; end = bytes.subarray(0, used).indexOf(10);
    }
    if (end < 0 || end > 16 * 1024) migrationCapsuleFail('carrier');
    const header = safeJsonParse(bytes.subarray(0, end).toString('utf8'), null);
    // This family has only the current chunk writer's sealed representation.
    // This bounded format/binding check is followed by the store's full crypto authentication.
    if (!header || Array.isArray(header)
        || Object.keys(header).sort().join(',') !== 'format,instanceId,keyId,manifest,purpose,recordId,revision,schema,scopeId,seq,workData'
        || header.workData !== 3 || header.format !== 'chunks-v1' || header.purpose !== 'backup'
        || header.schema !== 1 || header.seq !== 1 || header.scopeId !== descriptor.scopeId
        || header.recordId !== descriptor.recordId + ':' + kind
        || typeof header.instanceId !== 'string' || typeof header.keyId !== 'string'
        || !/^[a-f0-9]{32}$/.test(header.revision || '') || !header.manifest || typeof header.manifest !== 'object' || Array.isArray(header.manifest)) migrationCapsuleFail('carrier');
  } finally { await handle.close(); }
}
async function migrationCapsuleWriteIntent(descriptor, intent) {
  if (!migrationCapsuleIntentShape(intent, descriptor)) migrationCapsuleFail('intent');
  // Recovery keeps this private authority sealed even if the switch changed after
  // preparing. Ordinary OFF undo is rejected separately, before touching live data.
  const lease = await WorkDataStore.acquireSnapshot(WorkDataStore.requireKeys());
  await lease.release();
  await migrationCapsuleIntent(descriptor).write(JSON.stringify(intent));
}
async function migrationCapsuleRead(descriptor) {
  const archiveFile = path.join(descriptor.backup, 'archive'), intentFile = path.join(descriptor.backup, 'intent');
  // These two private records have no plaintext alternate encoding. A malformed or
  // displaced carrier cannot be reclassified as an old renamed skill directory.
  await migrationCapsuleRequireCarrier(archiveFile, descriptor, 'archive');
  await migrationCapsuleRequireCarrier(intentFile, descriptor, 'intent');
  const bytes = await migrationCapsuleArchive(descriptor).read();
  let snapshot;
  try { snapshot = migrationCapsuleDecode(bytes); } finally { bytes.fill(0); }
  const intent = safeJsonParse(await migrationCapsuleIntent(descriptor).read(), null);
  if (!migrationCapsuleIntentShape(intent, descriptor) || snapshot.revision !== intent.revision
      || snapshot.entries.find(entry => entry.rel === '').id !== intent.oldRoot) migrationCapsuleFail('binding');
  return { snapshot, intent };
}
async function migrationCapsulePresent(backup) {
  const descriptor = migrationCapsuleDescriptor(backup);
  for (const name of [MIGRATION_CAPSULE_MARKER, 'archive', 'intent']) {
    const file = path.join(backup, name), stat = await migrationLstat(file);
    if (!stat) continue;
    // This filename is reserved for a capsule; even a damaged marker may never
    // authorize the legacy recursive-delete path. Payload files in old renamed
    // skill directories can themselves be unrelated work-data containers.
    if (name === MIGRATION_CAPSULE_MARKER) return true;
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const handle = await fsp.open(file, 'r');
    let header;
    try {
      const prefix = Buffer.alloc(64 * 1024), read = await handle.read(prefix, 0, prefix.length, 0);
      header = safeJsonParse(prefix.subarray(0, read.bytesRead).toString('utf8').split('\n')[0], null);
    } finally { await handle.close(); }
    if (header && header.workData !== undefined && header.purpose === 'backup'
        && header.scopeId === descriptor.scopeId && header.recordId === descriptor.recordId + ':' + name) return true;
  }
  return false;
}
async function migrationCapsuleBroker() {
  if (process.platform !== 'win32') migrationCapsuleFail('platform_unsupported');
  const bootstrap = "$ErrorActionPreference='Stop'; Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RUYI_SKILL_CAPSULE_SOURCE))); [RuyiSkillCapsule]::Run()";
  const child = require('node:child_process').spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], {
    env: { ...process.env, RUYI_SKILL_CAPSULE_SOURCE: Buffer.from(MIGRATION_SKILL_CAPSULE_NATIVE, 'utf8').toString('base64') },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timers = require('node:timers');
  const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
  let pending = null, ended = false, output = [], outputBytes = 0, exitResolve;
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const reject = reason => {
    if (pending) { const entry = pending; pending = null; timers.clearTimeout(entry.timer); entry.reject(reason); }
  };
  child.stdout.on('data', chunk => {
    const parts = decoder.write(chunk).split('\n');
    for (let index = 0; index < parts.length; index++) {
      output.push(parts[index]); outputBytes += Buffer.byteLength(parts[index]);
      if (outputBytes > MIGRATION_CAPSULE_ARCHIVE_LIMIT) { reject(Object.assign(new Error('work_data_backup.native_limit'), { code: 'work_data_backup.native_limit', apiCode: 'work_data_backup.native_limit', statusCode: 503 })); child.kill(); return; }
      if (index === parts.length - 1) break;
      const line = output.join(''); output = []; outputBytes = 0;
      if (!pending) continue;
      const entry = pending; pending = null; timers.clearTimeout(entry.timer);
      let response;
      try { response = JSON.parse(line); } catch { response = null; }
      if (response?.ok === true) entry.resolve(response.value);
      else {
        const suffix = /^[a-z0-9_]+$/.test(response?.code || '') ? response.code : 'native_unavailable';
        const code = 'work_data_backup.' + suffix;
        entry.reject(Object.assign(new Error(code), { code, apiCode: code, statusCode: 503 }));
      }
    }
  });
  child.stderr.resume(); // compiler/native diagnostics must never contain work-data payloads in app logs
  child.on('error', () => { ended = true; reject(Object.assign(new Error('work_data_backup.native_unavailable'), { code: 'work_data_backup.native_unavailable', apiCode: 'work_data_backup.native_unavailable', statusCode: 503 })); exitResolve(); });
  child.on('exit', () => { ended = true; reject(Object.assign(new Error('work_data_backup.native_exit'), { code: 'work_data_backup.native_exit', apiCode: 'work_data_backup.native_exit', statusCode: 503 })); exitResolve(); });
  const command = args => new Promise((resolve, rejectCommand) => {
    if (pending || ended) return rejectCommand(Object.assign(new Error('work_data_backup.native_exit'), { code: 'work_data_backup.native_exit', apiCode: 'work_data_backup.native_exit', statusCode: 503 }));
    const timer = timers.setTimeout(() => { reject(Object.assign(new Error('work_data_backup.native_timeout'), { code: 'work_data_backup.native_timeout', apiCode: 'work_data_backup.native_timeout', statusCode: 503 })); child.kill(); }, 120000);
    pending = { resolve, reject: rejectCommand, timer };
    child.stdin.write(JSON.stringify(args) + '\n', error => { if (error) { reject(Object.assign(new Error('work_data_backup.native_pipe'), { code: 'work_data_backup.native_pipe', apiCode: 'work_data_backup.native_pipe', statusCode: 503 })); child.kill(); } });
  });
  return { command, close: async () => { child.stdin.end(); await exited; } };
}
async function migrationCapsuleCapture(root, revision) {
  const broker = await migrationCapsuleBroker();
  try {
    const snapshot = await broker.command({ cmd: 'capture', root, revision });
    if (!migrationCapsuleShape(snapshot)) migrationCapsuleFail('shape');
    return snapshot;
  } finally { await broker.close(); }
}
async function migrationCapsuleAssertTree(root, fingerprint, revision) {
  const snapshot = await migrationCapsuleCapture(root, revision);
  if (!migrationCapsuleSame(snapshot, fingerprint)) migrationCapsuleFail('live_changed', true);
}
async function migrationCapsuleVerifyReady(descriptor, snapshot) {
  const broker = await migrationCapsuleBroker();
  try {
    const objects = path.join(descriptor.backup, 'objects');
    const names = await fsp.readdir(objects), allowed = new Set(snapshot.entries.map(entry => entry.opaque));
    if (names.length !== allowed.size || names.some(name => !allowed.has(name))) migrationCapsuleFail('opaque_set');
    const roots = names.map(name => path.join(objects, name));
    await broker.command({ cmd: 'attach', roots, snapshot });
    await broker.command({ cmd: 'verify', cleared: true });
  } finally { await broker.close(); }
}
async function migrationCapsuleFinishPublished(descriptor, snapshot, dest) {
  const broker = await migrationCapsuleBroker();
  try {
    await broker.command({ cmd: 'attach', roots: [dest], snapshot });
    await broker.command({ cmd: 'finish-published', target: dest, container: path.join(descriptor.backup, 'objects') });
  } finally { await broker.close(); }
}
async function migrationCapsuleRoots(descriptor, intent) {
  const roots = [], objects = path.join(descriptor.backup, 'objects');
  for (const candidate of [migrationSkillTarget(descriptor.id), path.join(descriptor.backup, 'restored', intent.oldRoot)]) {
    const stat = await migrationLstat(candidate);
    if (!stat) continue;
    // A ready copy is a different root; it must never enter the old-object scan.
    const info = await fsp.stat(candidate, { bigint: true });
    if (info.ino.toString(16).padStart(16, '0') === intent.oldRoot.slice(8)) roots.push(candidate);
  }
  for (const entry of await fsp.readdir(objects, { withFileTypes: true })) roots.push(path.join(objects, entry.name));
  return roots;
}
async function migrationCapsuleRestore(descriptor, snapshot, intent, undo) {
  const broker = await migrationCapsuleBroker(), dest = migrationSkillTarget(descriptor.id);
  const wrapper = path.join(descriptor.backup, 'restored'), restored = path.join(wrapper, intent.oldRoot), retired = path.join(descriptor.backup, 'retired');
  try {
    await fsp.mkdir(wrapper).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const wrapperStat = await migrationLstat(wrapper);
    if (!wrapperStat?.isDirectory() || wrapperStat.isSymbolicLink()
        || (await fsp.readdir(wrapper)).some(name => name !== intent.oldRoot)) migrationCapsuleFail('restore_wrapper', true);
    const roots = await migrationCapsuleRoots(descriptor, intent);
    await broker.command({ cmd: 'attach', roots, snapshot });
    const publicationExisting = await migrationLstat(dest);
    await broker.command({ cmd: 'publish-check', target: dest, allowedId: publicationExisting ? intent.newTree.find(entry => entry.rel === '').id : '' });
    await broker.command({ cmd: 'restore', target: restored, container: path.join(descriptor.backup, 'objects') });
    const existing = await migrationLstat(dest);
    if (existing) {
      if (!undo) migrationCapsuleFail('live_changed', true);
      await migrationCapsuleAssertTree(dest, intent.newTree, intent.revision);
      if (await migrationLstat(retired)) migrationCapsuleFail('retired_exists', true);
      await fsp.rename(dest, retired);
    }
    await broker.command({ cmd: 'publish', target: dest, container: path.join(descriptor.backup, 'objects') });
    intent.phase = undo ? 'complete' : 'aborted';
    await migrationCapsuleWriteIntent(descriptor, intent);
  } finally { await broker.close(); }
  if (await migrationLstat(retired)) {
    await migrationCapsuleAssertTree(retired, intent.newTree, intent.revision);
    await fsp.rm(retired, { recursive: true });
  }
}
async function migrationCapsulePrepare(dest, stage, backup) {
  const descriptor = migrationCapsuleDescriptor(backup), revision = crypto.randomBytes(32).toString('hex');
  const broker = await migrationCapsuleBroker();
  let intent = null;
  try {
    await broker.command({ cmd: 'short-probe', root: stage });
    const snapshot = await broker.command({ cmd: 'capture', root: dest, revision });
    if (!migrationCapsuleShape(snapshot)) migrationCapsuleFail('shape');
    const staged = await migrationCapsuleCapture(stage, revision);
    const raw = Buffer.from(JSON.stringify(snapshot), 'utf8');
    if (raw.length > MIGRATION_CAPSULE_ARCHIVE_LIMIT) { raw.fill(0); migrationCapsuleFail('capacity'); }
    let bytes;
    try { bytes = require('node:zlib').gzipSync(raw); } finally { raw.fill(0); }
    try {
      if (bytes.length > MIGRATION_CAPSULE_BINARY_LIMIT) migrationCapsuleFail('capacity');
      if (await migrationLstat(backup)) migrationCapsuleFail('target_exists');
      await fsp.mkdir(path.dirname(backup), { recursive: true });
      await fsp.mkdir(backup);
      await atomicWriteJson(path.join(backup, MIGRATION_CAPSULE_MARKER), { version: 1 });
      await fsp.mkdir(path.join(backup, 'objects'));
      await migrationCapsuleArchive(descriptor).write(bytes);
    } finally { if (bytes) bytes.fill(0); }
    intent = { schema: 1, id: descriptor.id, stamp: descriptor.stamp, revision, phase: 'preparing',
      oldRoot: snapshot.entries.find(entry => entry.rel === '').id, newTree: migrationCapsuleFingerprint(staged), sourceStage: path.basename(stage) };
    migrationRecoveryNeeded = true;
    await migrationCapsuleWriteIntent(descriptor, intent);
    // Authenticate the durable authority and all business/path/size bindings before
    // the first truncation/rename. No archive is ever written as a plaintext temp.
    await migrationCapsuleRead(descriptor);
    await broker.command({ cmd: 'seal', container: path.join(backup, 'objects') });
    intent.phase = 'ready';
    await migrationCapsuleWriteIntent(descriptor, intent);
    await broker.command({ cmd: 'verify', cleared: true });
    await migrationCapsuleAssertTree(stage, intent.newTree, revision);
    await fsp.rename(stage, dest);
    await migrationCapsuleAssertTree(dest, intent.newTree, revision);
    intent.phase = 'published';
    await migrationCapsuleWriteIntent(descriptor, intent);
    migrationRecoveryNeeded = false;
    return descriptor;
  } catch (error) {
    if (intent) {
      // Recovery is durable; never hide an executed publication behind a retryable
      // copy-failed result. The next owner/startup resolves the same intent once.
      error.operationMayHaveExecuted = true; error.resultUnavailable = true; error.retry = false;
    }
    throw error;
  } finally { await broker.close(); }
}
async function migrationRecoverSkillBackups() {
  const root = path.join(migrationDir(), MIGRATION_SKILL_BACKUP_DIR);
  try {
    const stat = await fsp.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) migrationCapsuleFail('backup_root');
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let batches;
  try { batches = await fsp.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const batch of batches) {
    if (!/^[0-9TZ-]+$/.test(batch.name)) continue;
    if (!batch.isDirectory() || batch.isSymbolicLink()) migrationCapsuleFail('backup_root');
    for (const entry of await fsp.readdir(path.join(root, batch.name), { withFileTypes: true })) {
      const backup = path.join(root, batch.name, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !await migrationCapsulePresent(backup)) continue;
      const descriptor = migrationCapsuleDescriptor(backup);
      // Before intent publication the live objects are untouched. Keep orphaned
      // encrypted archives for inspection; they are never interpreted as live trees.
      if (!await migrationLstat(path.join(backup, 'intent'))) {
        if ((await fsp.readdir(path.join(backup, 'objects'))).length) migrationCapsuleFail('intent_missing', true);
        continue;
      }
      const { snapshot, intent } = await migrationCapsuleRead(descriptor);
      const dest = migrationSkillTarget(descriptor.id), stat = await migrationLstat(dest);
      const oldPublished = stat && !stat.isSymbolicLink() && (await fsp.stat(dest, { bigint: true })).ino.toString(16).padStart(16, '0') === intent.oldRoot.slice(8);
      if (['complete', 'aborted'].includes(intent.phase)) {
        const retired = path.join(backup, 'retired');
        if (await migrationLstat(retired)) {
          await migrationCapsuleAssertTree(retired, intent.newTree, intent.revision);
          await fsp.rm(retired, { recursive: true });
        }
        continue;
      }
      if (intent.phase === 'published') {
        await migrationCapsuleVerifyReady(descriptor, snapshot);
        continue; // users may edit/remove their live skill after a committed publication
      }
      if (intent.phase === 'ready' && stat && !oldPublished) {
        const expectedRoot = intent.newTree.find(entry => entry.rel === '');
        if (!expectedRoot || (await fsp.stat(dest, { bigint: true })).ino.toString(16).padStart(16, '0') !== expectedRoot.id.slice(8)) migrationCapsuleFail('published_identity', true);
        await migrationCapsuleVerifyReady(descriptor, snapshot);
        intent.phase = 'published';
        await migrationCapsuleWriteIntent(descriptor, intent);
        continue; // publication succeeded; absent result log must never trigger a copy replay
      }
      if (intent.phase === 'restoring' && oldPublished) {
        await migrationCapsuleFinishPublished(descriptor, snapshot, dest);
        intent.phase = 'complete'; await migrationCapsuleWriteIntent(descriptor, intent);
        const retired = path.join(backup, 'retired');
        if (await migrationLstat(retired)) {
          await migrationCapsuleAssertTree(retired, intent.newTree, intent.revision);
          await fsp.rm(retired, { recursive: true });
        }
        continue;
      }
      await migrationCapsuleRestore(descriptor, snapshot, intent, intent.phase === 'restoring');
    }
  }
}
async function migrationUndoCapsule(backup, item, dest) {
  if ((await readConfig()).workDataEncryptionV1 !== true) migrationCapsuleFail('downgrade_refused');
  const descriptor = migrationCapsuleDescriptor(backup);
  if (descriptor.id !== item.id) migrationCapsuleFail('binding');
  const { snapshot, intent } = await migrationCapsuleRead(descriptor);
  if (intent.phase === 'complete') return { id: item.id, outcome: 'restored-previous' };
  if (!['ready', 'published'].includes(intent.phase)) migrationCapsuleFail('phase', true);
  const stat = await migrationLstat(dest);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return { id: item.id, outcome: 'kept', reason: 'gone' };
  const current = await migrationCapsuleCapture(dest, intent.revision);
  if (!migrationCapsuleSame(current, intent.newTree)) return { id: item.id, outcome: 'kept', reason: 'edited' };
  intent.phase = 'restoring';
  await migrationCapsuleWriteIntent(descriptor, intent);
  migrationRecoveryNeeded = true;
  try { await migrationCapsuleRestore(descriptor, snapshot, intent, true); }
  catch (error) { error.operationMayHaveExecuted = true; error.resultUnavailable = true; error.retry = false; throw error; }
  migrationRecoveryNeeded = false;
  return { id: item.id, outcome: 'restored-previous' };
}

// 把一行复制进 dataRoot/skills/<id>/。返回 { ok, action, copyTreeHash, backup } 或 { ok:false, reason }。
async function migrationCopyOneSkill(row, ts) {
  const dest = migrationSkillTarget(row.id);
  if (!dest) return { ok: false, reason: 'invalid-key' };
  await migrationStoragePreflight(path.join(dest, SKILL_IMPORT_RECORD));
  const sealBackup = (await readConfig()).workDataEncryptionV1 === true;
  await readSkillImportRecord(dest); // authenticate an existing revision before stage or backup writes
  const tree = await migrationSkillTree(row._dir);
  if (tree.error) return { ok: false, reason: 'unreadable' };
  if (tree.tooLarge) return { ok: false, reason: 'too-large' };
  if (!tree.files.some(f => f.rel === 'SKILL.md')) return { ok: false, reason: 'no-skill-md' };
  const root = path.dirname(dest);
  await fsp.mkdir(root, { recursive: true });
  const stage = path.join(root, MIGRATION_SKILL_STAGE_PREFIX + row.id + '-' + ts);
  const stageKey = samePathKey(stage);
  let backup = '';
  try {
    await fsp.mkdir(stage, { recursive: false });
    for (const f of tree.files) {
      const target = path.resolve(stage, ...f.rel.split('/'));
      if (!migrationPathInside(samePathKey(target), stageKey) || samePathKey(target) === stageKey) throw new Error('path escaped stage');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(f.abs, target, fs.constants.COPYFILE_EXCL);
    }
    // 记录的两枚哈希都按【拷进来的内容】算:复制途中来源又变了,下一次扫描会如实显示「来源已更新」。
    const copyTreeHash = await migrationTreeHash(await migrationSkillTree(stage));
    if (!copyTreeHash) throw new Error('copy unreadable');
    const record = { schema: 1, source: row.source, sourcePath: row._dir, plugin: row.plugin || '', importedAt: nowIso(),
      sourceTreeHash: copyTreeHash, copyTreeHash };
    await writeSkillImportRecord(stage, record, row.id);
    const existing = await migrationLstat(dest);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('target is not a directory');
      // 旧副本整体挪进迁移目录留底(撤销时换回来),不就地覆盖。
      const bdir = path.join(migrationDir(), MIGRATION_SKILL_BACKUP_DIR, ts);
      await fsp.mkdir(bdir, { recursive: true });
      backup = path.join(bdir, row.id);
      if (sealBackup) {
        await migrationCapsulePrepare(dest, stage, backup);
      } else {
        await fsp.rename(dest, backup);
      }
    }
    if (!existing || !sealBackup) await fsp.rename(stage, dest);
    return { ok: true, action: existing ? 'updated' : 'created', copyTreeHash, backup, skippedLinks: tree.links };
  } catch (e) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (backup && !await migrationCapsulePresent(backup) && !(await migrationLstat(dest))) await fsp.rename(backup, dest).catch(() => {});
    if (String(e?.code || '').startsWith('work_data') || e.operationMayHaveExecuted) throw e;
    return { ok: false, reason: 'copy-failed', detail: String((e && e.message) || e).slice(0, 200) };
  }
}

// POST /api/migration/skills/copy {keys:[…], overwrite?:true}。请求合法就回 200 + 逐项结果(前端就地显示),
// 至少复制了一项才写迁移日志(撤销走 /api/migration/undo,与改写老包引用共用同一本账)。
async function migrationCopySkills(body) {
  return migrationSerial(async () => {
    const b = body && typeof body === 'object' ? body : {};
    const keys = Array.isArray(b.keys) ? [...new Set(b.keys.map(k => String(k == null ? '' : k)))].slice(0, 200) : [];
    if (!keys.length) return { ok: false, error: 'keys-required', status: 400 };
    const overwrite = b.overwrite === true;
    await migrationStoragePreflight();
    // 上一次崩在半路留下的暂存目录先清掉(它们不是技能:名字过不了 SKILL_ID_RE,注册表本来就不读)。
    try {
      for (const d of await fsp.readdir(paths.skills, { withFileTypes: true })) {
        if (d.name.startsWith(MIGRATION_SKILL_STAGE_PREFIX)) await fsp.rm(path.join(paths.skills, d.name), { recursive: true, force: true }).catch(() => {});
      }
    } catch { /* 还没有 skills 目录 */ }
    const config = await readConfig();
    const rows = await migrationSkillRows(config);
    const ts = await migrationNextLogStamp();
    const log = { schema: MIGRATION_LOG_SCHEMA, id: ts, type: 'skill-copy', createdAt: nowIso(), currentRoot: migrationCurrentRoot(), version: VERSION, files: [] };
    const results = [];
    let interrupted = null;
    for (const key of keys) {
      const id = key.slice(key.lastIndexOf(':') + 1);
      if (key.length > 300 || !SKILL_ID_RE.test(id)) { results.push({ key: key.slice(0, 120), outcome: 'rejected', reason: 'invalid-key' }); continue; }
      const row = rows.find(r => r.key === key);
      if (!row) { results.push({ key, id, outcome: 'rejected', reason: 'unknown-key' }); continue; }
      const base = { key, id, source: row.source, plugin: row.plugin };
      if (row.status === 'copied') { results.push({ ...base, outcome: 'skipped', reason: 'already-copied' }); continue; }
      if (row.status === 'conflict') { results.push({ ...base, outcome: 'rejected', reason: 'conflict', conflictWith: row.conflictWith }); continue; }
      if (row.status === 'too-large' || row.tooLarge) { results.push({ ...base, outcome: 'rejected', reason: 'too-large' }); continue; }
      if (row.status === 'copy-edited' && !overwrite) { results.push({ ...base, outcome: 'rejected', reason: 'copy-edited' }); continue; }
      let r;
      try { r = await migrationCopyOneSkill(row, ts); }
      catch (error) {
        if (!log.files.length && !error.operationMayHaveExecuted) throw error;
        if (error.operationMayHaveExecuted) results.push({ ...base, outcome: 'uncertain', retry: false });
        interrupted = error;
        break; // retain prior completed copies and never replay them internally
      }
      if (!r.ok) { results.push({ ...base, outcome: 'rejected', reason: r.reason, detail: r.detail || '' }); continue; }
      results.push({ ...base, outcome: r.action, skippedLinks: r.skippedLinks });
      log.files.push({ file: migrationSkillTarget(row.id), kind: 'skill-copy', backup: r.backup,
        items: [{ key, id: row.id, source: row.source, plugin: row.plugin, action: r.action, copyTreeHash: r.copyTreeHash }] });
    }
    const copied = log.files.length;
    let result = { ok: true, id: copied || interrupted ? ts : null, copied, results };
    if (interrupted) result = migrationUncertainResult(result, interrupted);
    if (copied) {
      result = await migrationCommitLog(log, result);
      if (!result.resultUnavailable) logEvent({ kind: 'migration_skill_copy', id: ts, copied, rejected: results.filter(r => r.outcome === 'rejected').length });
    }
    return result;
  });
}

// 撤销一条技能复制:副本自复制后没被改过才动 —— 新建的删掉,更新的换回旧副本;改过的原样保留并说明。
async function migrationUndoSkillCopy(f) {
  const item = (f.items || [])[0] || {};
  const dest = migrationSkillTarget(item.id);
  if (!dest || samePathKey(dest) !== samePathKey(String(f.file || ''))) return { id: String(item.id || ''), outcome: 'kept', reason: 'invalid-log' };
  const backupRoot = samePathKey(path.join(migrationDir(), MIGRATION_SKILL_BACKUP_DIR));
  const backup = f.backup && migrationPathInside(samePathKey(f.backup), backupRoot) ? f.backup : '';
  if (backup && await migrationCapsulePresent(backup)) return migrationUndoCapsule(backup, item, dest);
  const st = await migrationLstat(dest);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return { id: item.id, outcome: 'kept', reason: 'gone' };
  const rec = await readSkillImportRecord(dest);
  const hash = await migrationTreeHash(await migrationSkillTree(dest));
  if (!rec || !hash || hash !== item.copyTreeHash) return { id: item.id, outcome: 'kept', reason: 'edited' };
  const hasBackup = backup ? Boolean(await migrationLstat(backup)) : false;
  await fsp.rm(dest, { recursive: true, force: true });
  if (hasBackup) {
    await fsp.rename(backup, dest);
    await fsp.rmdir(path.dirname(backup)).catch(() => {}); // 这一批的留底目录空了就顺手收掉
    return { id: item.id, outcome: 'restored-previous' };
  }
  return { id: item.id, outcome: 'removed' };
}

async function migrationLogs() {
  const enabled = (await readConfig()).workDataEncryptionV1 === true;
  let files = [];
  try { files = (await fsp.readdir(migrationDir())).filter(f => /^[0-9TZ-]+\.json$/.test(f)).sort().reverse(); } catch { return []; }
  const out = [];
  for (const f of files.slice(0, 20)) {
    let text = '';
    try { text = await migrationLogStore(f.slice(0, -5)).read(); }
    catch (error) { if (String(error?.code || '').startsWith('work_data')) throw error; }
    const log = safeJsonParse(text, null);
    if (log && log.schema === MIGRATION_LOG_SCHEMA) {
      if (enabled && !migrationLogShape(log, f.slice(0, -5))) throw Object.assign(new Error('work_data_store.validate'), { code: 'work_data_store.validate', apiCode: 'work_data_store.validate', statusCode: 503 });
      out.push(log);
    }
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
// 一个服务器 mcp_servers.<id> 在 TOML 全文里占的全部 [start, end) 字符区间:[mcp_servers.<id>] 本段,加上它的子表
// ([mcp_servers.<id>.env] / .http_headers / .tools.x …)。区间 = 表头的下一行起,到下一个表头(任何 [ 开头的行)之前。
// 同一服务器的几段在 TOML 里可以不相邻,所以回的是区间数组(找不到回 [])。
// 修前只认精确的 [mcp_servers.<id>]:Codex 常把 env 写成 [mcp_servers.<id>.env] 子表,解析侧(_parseTomlMcpServers)把子表里的
// 老包路径算进了 env.<KEY> 的改写项,这里却搜不到子表 → 那一项改写不了(单独一项时整体 nothing-applied,与别的字段同批时被静默漏掉)。
// 表头的键路径按 TOML 规则拆(带引号的段、点号都处理),与解析侧同一个 _tomlKeyPath。
function migrationTomlSections(text, serverId) {
  const ranges = [];
  let pos = 0, start = -1;
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) {
      if (start >= 0) { ranges.push({ start, end: pos }); start = -1; }
      const m = /^\s*\[(?!\[)\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line.replace(/\r$/, ''));
      if (m) {
        const keyPath = _tomlKeyPath(m[1]);
        if (keyPath[0] === 'mcp_servers' && keyPath[1] === serverId) start = pos + line.length + 1;
      }
    }
    pos += line.length + 1;
  }
  if (start >= 0) ranges.push({ start, end: text.length });
  return ranges;
}
// 在 TOML 服务器区间(本段 + 子表)内把带引号的旧值换成新值(保留原引号样式)。返回 { text, count }。
function migrationTomlReplace(text, serverId, from, to) {
  const ranges = migrationTomlSections(text, serverId);
  if (!ranges.length) return { text, count: 0 };
  let count = 0;
  for (const sec of ranges.slice().reverse()) {   // 从后往前改:前面区间的偏移不受影响
    let body = text.slice(sec.start, sec.end);
    for (const q of ['"', "'"]) {
      const needle = q + from + q;
      while (body.includes(needle)) { body = body.replace(needle, () => q + to + q); count++; }
    }
    text = text.slice(0, sec.start) + body + text.slice(sec.end);
  }
  return { text, count };
}

async function migrationBackup(file, ts) {
  const backup = file + MIGRATION_BACKUP_TAG + ts;
  await fsp.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
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
  await migrationStoragePreflight();
  await migrationRememberPackages(selected.flatMap(item => item.packageRoots)).catch(() => 0);
  const ts = await migrationNextLogStamp();
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
      if (String(e?.code || '').startsWith('work_data')) throw e;
      failures.push({ file: tildePath(file), error: (e && e.message) || String(e) });
    }
    if (entry.items.length) { applied += entry.items.length; log.files.push(entry); }
    else if (entry.backup) await fsp.unlink(entry.backup).catch(() => {}); // 一项都没落:备份没用,不留垃圾
  }
  if (!applied) return { ok: false, error: 'nothing-applied', failures, status: 409 };
  const result = await migrationCommitLog(log, { ok: true, id: ts, items: applied, files: log.files.map(f => ({ file: tildePath(f.file), backup: f.backup, items: f.items.length })), failures, stale });
  if (!result.resultUnavailable) logEvent({ kind: 'migration_apply', id: ts, files: log.files.length, items: applied, failures: failures.length });
  return result;
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
      if (out.refs.resultUnavailable) Object.assign(out, { status: out.refs.status, operationMayHaveExecuted: true, resultUnavailable: true, retry: false });
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
    await migrationStoragePreflight(path.join(migrationDir(), log.id + '.json'), log);
    let restored = 0, skipped = 0;
    const failed = [];   // 读写抛错、这一轮没能改回的文件(与「值已被用户改过、按设计留着」的 skipped 不是一回事)
    const skills = [];
    let interrupted = null;
    for (const f of log.files || []) {
      if (f.undoneAt) continue;   // 上一轮(部分失败的撤销)已经改回的文件:重试时不再动,免得重复处理
      const mark = { restored, skipped };   // 这个文件中途抛错时把计数退回来(没落盘的不算「已还原」;重试时会重新数)
      try {
        if (f.kind === 'skill-copy') {
          const r = await migrationUndoSkillCopy(f);
          skills.push(r);
          if (r.outcome === 'kept') skipped++; else restored++;
        } else if (f.kind === 'ruyi-config') {
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
          // 只有 ENOENT(文件被删了,被删条目要放回去)才当空;EBUSY / EPERM 等读错误当成空再写回会把现有内容整份覆盖 —— 抛出去记成失败、可重试。
          try { text = await fsp.readFile(f.file, 'utf8'); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; text = ''; }
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
          let text = null;
          try { text = await fsp.readFile(f.file, 'utf8'); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
          if (text === null) {
            for (const item of f.items || []) skipped += (item.changes || []).length;   // 文件已被删掉:无处可还原,算「留着」不算失败
          } else {
            for (const item of f.items || []) {
              for (const c of item.changes || []) {
                const r = migrationTomlReplace(text, item.serverId, c.to, c.from);
                if (r.count) { text = r.text; restored++; } else skipped++;
              }
            }
            await atomicWriteJson(f.file, text);
          }
        }
        f.undoneAt = nowIso();
      } catch (e) {
        if (String(e?.code || '').startsWith('work_data') || e.operationMayHaveExecuted) {
          if (!mark.restored && !mark.skipped && !e.operationMayHaveExecuted) throw e;
          interrupted = e;
        }
        restored = mark.restored; skipped = mark.skipped;
        failed.push({ file: tildePath(f.file || ''), error: (e && e.message) || String(e) });
        if (interrupted) break;
      }
    }
    // 累计账:部分失败后重试,restored / skipped 接着前几轮算(最终写进 undoResult)。
    const prior = log.undoProgress && typeof log.undoProgress === 'object' ? log.undoProgress : {};
    const total = { restored: restored + (Number(prior.restored) || 0), skipped: skipped + (Number(prior.skipped) || 0) };
    const allSkills = [...(Array.isArray(prior.skills) ? prior.skills : []), ...skills];   // 技能副本的逐项结局也跨轮累计(前端据 kept 提示哪些被留下)
    if (allSkills.length) total.skills = allSkills;
    if (failed.length) {
      // 修前:单个文件失败只 skipped++,照样写 undoneAt —— 剩下没改回的部分从此再也撤不了(重试得 409 already-undone)。
      // 现在:有失败就【不】置 undoneAt,已改回的文件各自带 undoneAt 落盘,这条迁移仍是「可撤销的最近一次」,
      // 处理掉原因(文件被占用/权限)后再点一次撤销,只重做没完成的文件。
      log.undoProgress = total;
      const partial = { ok: false, error: 'undo-incomplete', status: 500, id: log.id, restored, skipped, failed, ...(skills.length ? { skills } : {}) };
      const result = await migrationCommitLog(log, interrupted ? migrationUncertainResult(partial, interrupted) : partial);
      if (!result.resultUnavailable) logEvent({ kind: 'migration_undo_partial', id: log.id, restored, skipped, failed: failed.length });
      return result;
    }
    delete log.undoProgress;
    log.undoneAt = nowIso();
    log.undoResult = { restored: total.restored, skipped: total.skipped, ...(allSkills.length ? { skills: allSkills } : {}) };
    const result = await migrationCommitLog(log, { ok: true, id: log.id, restored, skipped, ...(allSkills.length ? { skills: allSkills } : {}) });
    if (!result.resultUnavailable) logEvent({ kind: 'migration_undo', id: log.id, restored, skipped });
    return result;
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
  recover: () => migrationSerial(async () => {}),
  withSkillRead: work => migrationSerial(work),
  scan: migrationScan,
  apply: migrationApply,
  undo: migrationUndo,
  recycle: migrationRecycle,
  copySkills: migrationCopySkills,
});
