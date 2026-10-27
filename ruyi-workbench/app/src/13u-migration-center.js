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
let migrationBackupAuthority = null;
function migrationBackupRoot() { return migrationBackupAuthority?.root || path.join(migrationDir(), MIGRATION_SKILL_BACKUP_DIR); }

function migrationSerial(fn) {
  const guard = () => {
    if (migrationCapsuleBroker.helperMayStillRun === true) throw Object.assign(new Error('work_data_backup.native_helper_uncertain'), {
      code: 'work_data_backup.native_helper_uncertain', apiCode: 'work_data_backup.native_helper_uncertain', statusCode: 503,
      helperMayStillRun: true, operationMayHaveExecuted: true, retry: false });
  };
  try { guard(); } catch (error) { return Promise.reject(error); }
  if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.run && !WorkDataMaintenanceHooks.entered('migration')) return WorkDataMaintenanceHooks.run('migration', () => migrationSerial(fn));
  const admission = migrationBackupAuthority;
  const job = migrationChain.then(async () => {
    guard();
    if (admission !== migrationBackupAuthority) migrationCapsuleFail('generation_changed');
    if (admission) await admission.assertCurrent();
    guard();
    if (migrationRecoveryNeeded) {
      await migrationRecoverSkillBackups();
      migrationRecoveryNeeded = false;
    }
    guard(); const value = await fn(); guard(); return value;
  });
  migrationChain = job.catch(() => {});
  return job;
}
function migrationDir() { return path.join(migrationBackupAuthority?.activeRoot || paths.data, 'migrations'); }
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
    for (const file of [path.join(migrationDir(), stamp + '.json'), path.join(migrationBackupRoot(), stamp)]) {
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
  const root = path.resolve(migrationBackupAuthority?.skillsRoot || paths.skills);
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
  [StructLayout(LayoutKind.Explicit,Size=24)] struct FileIdDescriptor {
    [FieldOffset(0)] public uint Size; [FieldOffset(4)] public int Type;
    [FieldOffset(8)] public long FileId; [FieldOffset(16)] public long Reserved;
  }
  [StructLayout(LayoutKind.Sequential)] struct RelativeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct RelativeAttributes { public uint Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
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
  [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle OpenFileById(SafeFileHandle volumeHint,ref FileIdDescriptor descriptor,uint access,uint share,IntPtr security,uint flags);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle,uint access,ref RelativeAttributes attributes,IntPtr iosb,IntPtr allocation,uint fileAttrs,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileExW(string source,string target,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetFileShortName(SafeFileHandle h,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CheckNameLegalDOS8Dot3(string name,IntPtr oem,uint size,out bool spaces,out bool legal);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 180000000, RecursionLimit = 512 };
  static readonly Dictionary<string, Node> Nodes = new Dictionary<string, Node>();
  static Dictionary<string,object> Snapshot;
  static SafeFileHandle Capsule;
  static string OriginalRoot;
  static long MaxBytes = 96000000, TotalBytes;
  static string Step = "idle";
  static bool PreserveTimeHandles = false;
  sealed class Node {
    public SafeFileHandle Handle; public bool Writable; public Dictionary<string,object> Entry;
    public Dictionary<string,SafeFileHandle> Streams = new Dictionary<string,SafeFileHandle>();
    public HashSet<string> ReadOnlyStreams = new HashSet<string>();
  }
  static Dictionary<string,object> Dict(object value) { return (Dictionary<string,object>)value; }
  static string Str(object value) { return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture); }
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Reject(string reason) { throw new InvalidOperationException(reason); }
  // All callers supply canonical owner-bound paths (or paths from held handles).
  // Preserve an existing namespace and qualify DOS/UNC paths before .NET or Win32 IO.
  static string NativePath(string path) {
    if(path.StartsWith(@"\\?\",StringComparison.Ordinal)) return path;
    return path.StartsWith(@"\\",StringComparison.Ordinal)?@"\\?\UNC\"+path.Substring(2):@"\\?\"+path;
  }
  static SafeFileHandle Open(string file) {
    bool ignored; return Open(file, out ignored);
  }
  static SafeFileHandle Open(string file, out bool writable, bool dataStream = false) {
    file=NativePath(file);
    // Known DATA streams exclude existing writers. Directories/new streams require
    // explicit set verification; Windows sharing is per-stream, not per-tree.
    FileAttributes attributes = File.GetAttributes(file);
    bool directory = !dataStream && (attributes & FileAttributes.Directory) != 0, readOnly = (attributes & FileAttributes.ReadOnly) != 0;
    writable = !directory && !readOnly;
    SafeFileHandle handle = CreateFile(file, CapturedDirectoryWrite && directory ? 0xC0010100u : writable ? 0xC0010000u : 0x80010100u, directory ? 7u : 5u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    if(PreserveTimeHandles) {try {PreserveHandleTimes(handle);} catch {handle.Dispose();throw;}}
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
    string file=System.IO.Path.Combine(NativePath(Str(args["root"])),".ruyi-short-probe-"+RandomName());
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
    path=NativePath(path);
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
  static bool IsPrefix(byte[] actual,string encoded) {
    byte[] expected=Convert.FromBase64String(encoded);
    try { if(actual.Length>expected.Length)return false;for(int i=0;i<actual.Length;i++)if(actual[i]!=expected[i])return false;return true; }
    finally { Array.Clear(expected,0,expected.Length); }
  }
  static void VerifyRestorable(Dictionary<string,object> alternate = null) {
    List<Node> expected = Expected(); VerifyEntries(expected);
    foreach (Node node in expected) {
      Dictionary<string,object> streams = new Dictionary<string,object>();
      foreach (object raw in (IEnumerable)node.Entry["streams"]) streams.Add(Str(Dict(raw)["name"]), raw);
      foreach (string name in StreamNames(node)) {
        if (!streams.ContainsKey(name)) Reject("stream_set_changed");
        SafeFileHandle handle = name == "" ? node.Handle : node.Streams[name];
        byte[] actual = Read(handle);
        try {
          bool valid=IsPrefix(actual,Str(Dict(streams[name])["data"]));
          if(!valid && alternate!=null) foreach(object raw in (IEnumerable)alternate["entries"]) {
            Dictionary<string,object> entry=Dict(raw);if(Str(entry["id"])!=Str(node.Entry["id"]))continue;
            foreach(object streamRaw in (IEnumerable)entry["streams"]) { Dictionary<string,object> stream=Dict(streamRaw);
              if(Str(stream["name"])==name && IsPrefix(actual,Str(stream["data"])))valid=true;
            }
          }
          if(!valid)Reject("content_changed");
        } finally { Array.Clear(actual,0,actual.Length); }
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
    root=NativePath(root);
    foreach(Node node in Expected()) {
      string rel=Str(node.Entry["rel"]),target=rel==""?root:System.IO.Path.Combine(root,rel.Replace('/','\\'));
      if(!String.Equals(PathOf(node.Handle),target,StringComparison.OrdinalIgnoreCase)) Reject("entry_set_changed");
      if((rootAlias || rel!="") && !String.Equals(ShortName(node.Handle),Str(node.Entry["shortName"]),StringComparison.OrdinalIgnoreCase)) Reject("short_name_changed");
    }
  }
  static void Restore(Dictionary<string,object> args) {
    VerifyRestorable(args.ContainsKey("allowedSnapshot") ? Dict(args["allowedSnapshot"]) : null);
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
        Step="restore-content";
        // A representation conversion can shrink an existing managed stream.
        // Clear first so a crash never leaves an unrecognizable old-data suffix.
        if(args.ContainsKey("allowedSnapshot"))Write(handle,new byte[0]);
        Write(handle,bytes);Array.Clear(bytes,0,bytes.Length);
      }
    }
    Step="restore-verify";Verify(false,true);VerifyNames(Str(args["target"]),false);RestoreBasic(expected);
  }
  static void CheckPublication(Dictionary<string,object> args) {
    string alias=Str(RootNode().Entry["shortName"]);if(alias=="") return;
    string candidate=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(Str(args["target"])),alias);
    using(SafeFileHandle handle=CreateFile(NativePath(candidate),0x80u,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
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
  static void StoreFileSystem(SafeFileHandle handle) {
    StringBuilder filesystem=new StringBuilder(64);uint serial,component,flags;
    Check(GetVolumeInformationByHandleW(handle,null,0,out serial,out component,out flags,filesystem,64));
    if(filesystem.ToString()!="NTFS") Reject("filesystem_unsupported");
  }
  static object StoreInfoCore(Dictionary<string,object> args) {
    using(var handle=Open(Str(args["root"]))) {
      StoreFileSystem(handle);
      if((BasicOf(handle).Attr&16u)==0) Reject("store_not_directory");
      if(!String.Equals(PathOf(handle),@"\\?\"+System.IO.Path.GetFullPath(Str(args["root"])),StringComparison.OrdinalIgnoreCase)) Reject("store_path_alias");
      return new Dictionary<string,object>{{"id",Id(handle)},{"volume",VolumeOf(handle)}};
    }
  }
  static void FlushStoreDirectory(string path) {
    path=NativePath(path);
    using(var handle=CreateFile(path,0xC0000000u,7,IntPtr.Zero,3,0x02200000u,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error()); if(PreserveTimeHandles)PreserveHandleTimes(handle);Check(FlushFileBuffers(handle));
    }
  }
  static bool FlushPart(string value) {
    if(value.Length<1 || value.Length>255 || value=="." || value==".." || value.EndsWith(".") || value.EndsWith(" "))return false;
    foreach(char ch in value)if(ch<32 || "\\/:*?\"<>|".IndexOf(ch)>=0)return false;
    return true;
  }
  static void CheckFlushDirectory(SafeFileHandle handle,string expected,string volume,string expectedId=null) {
    PreserveHandleTimes(handle);
    Info info;Check(GetFileInformationByHandle(handle,out info));
    if((info.Attr&16u)==0)Reject("store_not_directory");string observedId=Id(handle);if(expectedId!=null && !String.Equals(observedId,expectedId,StringComparison.Ordinal))Reject("store_id_changed");StoreFileSystem(handle);
    if(!String.Equals(PathOf(handle),expected,StringComparison.OrdinalIgnoreCase))Reject("store_path_alias");
    if(volume!=null && !String.Equals(VolumeOf(handle),volume,StringComparison.Ordinal))Reject("store_volume_changed");
  }
  static SafeFileHandle OpenFlushChild(SafeFileHandle parent,string part,string expected,string volume) {
    IntPtr buffer=Marshal.StringToHGlobalUni(part),name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RelativeName))),iosb=Marshal.AllocHGlobal(IntPtr.Size*2);
    SafeFileHandle handle=null;
    try {
      RelativeName unicode=new RelativeName{Length=(ushort)(part.Length*2),MaximumLength=(ushort)((part.Length+1)*2),Buffer=buffer};
      Marshal.StructureToPtr(unicode,name,false);
      RelativeAttributes attributes=new RelativeAttributes{Length=(uint)Marshal.SizeOf(typeof(RelativeAttributes)),RootDirectory=parent.DangerousGetHandle(),ObjectName=name,Attributes=0x40};
      // Open exactly one component relative to the already protected directory.
      // FILE_OPEN, DIRECTORY_FILE, SYNCHRONOUS_IO_NONALERT, OPEN_FOR_BACKUP_INTENT,
      // OPEN_REPARSE_POINT. No absolute fallback or create disposition is allowed.
      int status=NtCreateFile(out handle,0xC0100000u,ref attributes,iosb,IntPtr.Zero,0,3,1,0x00204021u,IntPtr.Zero,0);
      if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status));
      if(status!=0 || handle==null || handle.IsInvalid)Reject("store_relative_open");
      CheckFlushDirectory(handle,expected,volume);return handle;
    } catch {if(handle!=null)handle.Dispose();throw;}
    finally {GC.KeepAlive(parent);Marshal.FreeHGlobal(buffer);Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(iosb);}
  }
  static void FlushStoreDirectoryPreserved(string path,string anchor) {
    // Both paths are strict local DOS paths, validated lexically before any open.
    if(path==null || anchor==null || path.Length<3 || anchor.Length<3 || path.Length>32763 || anchor.Length>32763
      || !Char.IsLetter(path[0]) || !Char.IsLetter(anchor[0]) || path[1]!=':' || anchor[1]!=':' || path[2]!='\\' || anchor[2]!='\\')Reject("store_flush_anchor");
    if(path.Length>3)path=path.TrimEnd('\\');if(anchor.Length>3)anchor=anchor.TrimEnd('\\');
    string prefix=anchor.EndsWith("\\")?anchor:anchor+"\\";
    if(!String.Equals(System.IO.Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase)
      ||!String.Equals(System.IO.Path.GetFullPath(anchor),anchor,StringComparison.OrdinalIgnoreCase)
      ||!String.Equals(path,anchor,StringComparison.OrdinalIgnoreCase)&&!path.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))Reject("store_flush_anchor");
    foreach(string part in anchor.Length==3?new string[0]:anchor.Substring(3).Split('\\'))if(!FlushPart(part))Reject("store_flush_anchor");
    string relative=path.Length==anchor.Length?"":path.Substring(prefix.Length);
    string[] parts=relative==""?new string[0]:relative.Split('\\');
    if(parts.Length>512)Reject("store_flush_anchor");foreach(string part in parts)if(!FlushPart(part))Reject("store_flush_anchor");
    bool previous=PreserveTimeHandles;PreserveTimeHandles=true;var handles=new List<SafeFileHandle>();
    try {
      var root=CreateFile(anchor,0xC0000000u,3,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
      if(root.IsInvalid){int error=Marshal.GetLastWin32Error();root.Dispose();throw new Win32Exception(error);}
      handles.Add(root);string expected=@"\\?\"+anchor;CheckFlushDirectory(root,expected,null);string volume=VolumeOf(root);
      SafeFileHandle current=root;
      foreach(string part in parts){expected+=(expected.EndsWith("\\")?"":"\\")+part;current=OpenFlushChild(current,part,expected,volume);handles.Add(current);}
      Check(FlushFileBuffers(current));
    } finally {try {for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();}finally {PreserveTimeHandles=previous;}}
  }
  static bool CapturedDirectoryWrite = false, CapturedFlushScope = false, CapturedFlushConsumed = false;
  static Dictionary<string,object> CapturedFlushSnapshot;
  static string CapturedFlushToken, CapturedFlushRoot, CapturedFlushRevision, CapturedFlushVolume, CapturedFlushRole;
  static object CaptureOwnedFlushReady(Dictionary<string,object> args) {
    object scope=null,preserve=null,rawRoot=null,rawRevision=null;
    if(Nodes.Count!=0 || CapturedFlushScope)Reject("already_open");
    if(!args.TryGetValue("scope",out scope) || !(scope is string) || ((string)scope!="owned-stage" && (string)scope!="owned-target"))Reject("captured_flush_scope");
    if(!args.TryGetValue("preserveMetadata",out preserve) || !(preserve is bool) || !(bool)preserve)Reject("captured_flush_option");
    if(!args.TryGetValue("root",out rawRoot) || !(rawRoot is string) || !args.TryGetValue("revision",out rawRevision) || !(rawRevision is string))Reject("captured_flush_binding");
    string root=(string)rawRoot,revision=(string)rawRevision;
    if(root.Length<3 || root.Length>32763 || !Char.IsLetter(root[0]) || root[1]!=':' || root[2]!='\\'
      || !String.Equals(System.IO.Path.GetFullPath(root),root,StringComparison.OrdinalIgnoreCase)
      || !System.Text.RegularExpressions.Regex.IsMatch(revision,"^[a-f0-9]{64}$"))Reject("captured_flush_binding");
    // This internal opt-in is for a separately admitted new owned stage/target.
    // The scope label is not ownership authority; the caller must hold that lease.
    CapturedFlushScope=true;bool previous=CapturedDirectoryWrite;CapturedDirectoryWrite=true;
    try {
      Dictionary<string,object> captured=Dict(CapturePreserved(args));
      if(!String.Equals(OriginalRoot,@"\\?\"+root,StringComparison.OrdinalIgnoreCase))Reject("captured_flush_root_alias");
      object requestedVolume=null;string admittedVolume=null;
      if(args.TryGetValue("expectedVolume",out requestedVolume)) {
        if(!(requestedVolume is string) || ((string)requestedVolume).Length<1 || ((string)requestedVolume).Length>128)Reject("captured_flush_volume");
        admittedVolume=VolumeOf(RootNode().Handle);if(!String.Equals(admittedVolume,(string)requestedVolume,StringComparison.Ordinal))Reject("store_volume_changed");
      }
      CapturedFlushSnapshot=captured;CapturedFlushRoot=root;CapturedFlushRevision=revision;CapturedFlushToken=RandomName();CapturedFlushConsumed=false;CapturedFlushVolume=admittedVolume;CapturedFlushRole=(string)scope;
      var ready=new Dictionary<string,object>{{"schema",1},{"snapshot",captured},{"token",CapturedFlushToken},{"scope",(string)scope}};if(admittedVolume!=null)ready.Add("volume",admittedVolume);return ready;
    } finally {CapturedDirectoryWrite=previous;}
  }
  static void CheckCapturedDirectory(Node node,string volume) {
    string rel=Str(node.Entry["rel"]),expected=rel==""?OriginalRoot:System.IO.Path.Combine(OriginalRoot,rel.Replace('/','\\'));
    if(!(bool)node.Entry["dir"] || node.Writable)Reject("captured_flush_not_directory");
    if(!String.Equals(Id(node.Handle),Str(node.Entry["id"]),StringComparison.Ordinal))Reject("identity_changed");
    StoreFileSystem(node.Handle);
    if(!String.Equals(PathOf(node.Handle),expected,StringComparison.OrdinalIgnoreCase))Reject("store_path_alias");
    if(!String.Equals(VolumeOf(node.Handle),volume,StringComparison.Ordinal))Reject("store_volume_changed");
    if(!String.Equals(ShortName(node.Handle),Str(node.Entry["shortName"]),StringComparison.Ordinal))Reject("short_name_changed");
    Basic actual=BasicOf(node.Handle);var times=new List<string>();foreach(object time in (IEnumerable)node.Entry["times"])times.Add(Str(time));
    if(times.Count!=4 || Str(actual.Creation)!=times[0] || Str(actual.Access)!=times[1] || Str(actual.Write)!=times[2] || Str(actual.Change)!=times[3] || actual.Attr!=Convert.ToUInt32(node.Entry["attrs"]))Reject("captured_flush_metadata_changed");
  }
  static object FlushCapturedDirectories(Dictionary<string,object> args) {
    object token=null,root=null,revision=null,rawIds=null;
    if(!CapturedFlushScope || CapturedFlushSnapshot==null || CapturedFlushConsumed || !Object.ReferenceEquals(Snapshot,CapturedFlushSnapshot))Reject("captured_flush_not_ready");
    if(!args.TryGetValue("token",out token) || !(token is string) || (string)token!=CapturedFlushToken
      ||!args.TryGetValue("root",out root) || !(root is string) || (string)root!=CapturedFlushRoot
      ||!args.TryGetValue("revision",out revision) || !(revision is string) || (string)revision!=CapturedFlushRevision
      ||!args.TryGetValue("directoryIds",out rawIds) || !(rawIds is object[]))Reject("captured_flush_binding");
    object requestedVolume=null;if(CapturedFlushVolume!=null && (!args.TryGetValue("expectedVolume",out requestedVolume) || !(requestedVolume is string) || !String.Equals((string)requestedVolume,CapturedFlushVolume,StringComparison.Ordinal)))Reject("captured_flush_volume");
    object[] ids=(object[])rawIds;var expected=Expected();var directories=new List<Node>();var supplied=new HashSet<string>(StringComparer.Ordinal);
    if(expected.Count!=Nodes.Count)Reject("entry_set_changed");
    foreach(object id in ids)if(!(id is string) || !System.Text.RegularExpressions.Regex.IsMatch((string)id,"^[a-f0-9]{24}$") || !supplied.Add((string)id))Reject("captured_flush_binding");
    foreach(Node node in expected)if((bool)node.Entry["dir"]){if(!supplied.Contains(Str(node.Entry["id"])))Reject("captured_flush_binding");directories.Add(node);}
    if(directories.Count<1 || directories.Count!=ids.Length)Reject("captured_flush_binding");
    // From this point a failure is not retryable. Every directory was opened
    // with WRITE before the ready capture's original checkpoint, never here.
    CapturedFlushConsumed=true;
    directories.Sort(delegate(Node a,Node b){return Str(b.Entry["rel"]).Length.CompareTo(Str(a.Entry["rel"]).Length);});
    Step="captured-directory-precheck";string volume=VolumeOf(RootNode().Handle);if(CapturedFlushVolume!=null && !String.Equals(volume,CapturedFlushVolume,StringComparison.Ordinal))Reject("store_volume_changed");foreach(Node node in directories)CheckCapturedDirectory(node,volume);
    Step="captured-directory-flush";var flushed=new List<object>();foreach(Node node in directories){Check(FlushFileBuffers(node.Handle));flushed.Add(new Dictionary<string,object>{{"rel",Str(node.Entry["rel"])},{"id",Str(node.Entry["id"])}});}
    Step="captured-directory-postcheck";foreach(Node node in directories)CheckCapturedDirectory(node,volume);
    var receipt=new Dictionary<string,object>{{"schema",1},{"kind","captured-directory-flush-v1"},{"token",CapturedFlushToken},{"root",CapturedFlushRoot},{"revision",CapturedFlushRevision},{"directories",flushed},{"count",flushed.Count},{"allFlushed",true},{"metadataExact",true}};if(CapturedFlushVolume!=null){receipt.Add("volume",volume);receipt.Add("role",CapturedFlushRole);}return receipt;
  }
  static void CheckBoundFlushDirectory(SafeFileHandle handle,string root,string id,string volume) {
    Info value;Check(GetFileInformationByHandle(handle,out value));if((value.Attr&16u)==0)Reject("store_not_directory");
    if(!String.Equals(Id(handle),id,StringComparison.Ordinal))Reject("store_id_changed");StoreFileSystem(handle);
    if(!String.Equals(PathOf(handle),@"\\?\"+root,StringComparison.OrdinalIgnoreCase))Reject("store_path_alias");
    if(!String.Equals(VolumeOf(handle),volume,StringComparison.Ordinal))Reject("store_volume_changed");
  }
  static object FlushStoreDirectoryBound(Dictionary<string,object> args) {
    object rawRoot=null,rawId=null,rawVolume=null,rawRole=null,rawOrdinal=null;
    if(!args.TryGetValue("root",out rawRoot) || !(rawRoot is string) || !args.TryGetValue("id",out rawId) || !(rawId is string)
      ||!args.TryGetValue("volume",out rawVolume) || !(rawVolume is string) || !args.TryGetValue("role",out rawRole) || !(rawRole is string)
      ||!args.TryGetValue("ordinal",out rawOrdinal) || !(rawOrdinal is int))Reject("bound_flush_binding");
    string root=(string)rawRoot,id=(string)rawId,volume=(string)rawVolume,role=(string)rawRole;int ordinal=(int)rawOrdinal;
    if(root.Length<3 || root.Length>32763 || !Char.IsLetter(root[0]) || root[1]!=':' || root[2]!='\\'
      ||!String.Equals(System.IO.Path.GetFullPath(root),root,StringComparison.OrdinalIgnoreCase)
      ||!System.Text.RegularExpressions.Regex.IsMatch(id,"^[a-f0-9]{24}$") || volume.Length<1 || volume.Length>128
      ||(role!="external-parent" && role!="new-target-ancestor") || ordinal<0 || ordinal>=10000)Reject("bound_flush_binding");
    // Ordinary directory durability, independently bound to this exact parent.
    // No metadata suppression, capture, child-name lookup or borrowed tree ID.
    using(var handle=CreateFile(root,0xC0000000u,7,IntPtr.Zero,3,0x02200000u,IntPtr.Zero)) {
      if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      CheckBoundFlushDirectory(handle,root,id,volume);Step="bound-directory-flush";Check(FlushFileBuffers(handle));CheckBoundFlushDirectory(handle,root,id,volume);
    }
    return new Dictionary<string,object>{{"schema",1},{"kind","bound-directory-flush-v1"},{"root",root},{"id",id},{"volume",volume},{"role",role},{"ordinal",ordinal},{"flushed",true}};
  }
  static void FlushStoreDirectoryById(Dictionary<string,object> args) {
    object preserve=null,rawPath=null,rawAnchor=null,rawId=null;
    if(!args.TryGetValue("preserveMetadata",out preserve) || !(preserve is bool) || !(bool)preserve)Reject("store_flush_option");
    if(!args.TryGetValue("root",out rawPath) || !(rawPath is string) || !args.TryGetValue("anchor",out rawAnchor) || !(rawAnchor is string))Reject("store_flush_anchor");
    if(!args.TryGetValue("objectId",out rawId) || !(rawId is string))Reject("store_flush_id");
    string path=(string)rawPath,anchor=(string)rawAnchor,objectId=(string)rawId;uint serial=0;ulong index=0;
    if(!System.Text.RegularExpressions.Regex.IsMatch(objectId,"^[a-f0-9]{24}$")
      ||!uint.TryParse(objectId.Substring(0,8),System.Globalization.NumberStyles.HexNumber,System.Globalization.CultureInfo.InvariantCulture,out serial)
      ||!ulong.TryParse(objectId.Substring(8),System.Globalization.NumberStyles.HexNumber,System.Globalization.CultureInfo.InvariantCulture,out index))Reject("store_flush_id");
    // Pure lexical checks precede all opens. The target ID comes only from the
    // caller's unchanged original checkpoint, never a new lookup by this path.
    if(path.Length<3 || anchor.Length<3 || path.Length>32763 || anchor.Length>32763
      ||!Char.IsLetter(path[0]) || !Char.IsLetter(anchor[0]) || path[1]!=':' || anchor[1]!=':' || path[2]!='\\' || anchor[2]!='\\')Reject("store_flush_anchor");
    if(path.Length>3)path=path.TrimEnd('\\');if(anchor.Length>3)anchor=anchor.TrimEnd('\\');
    string prefix=anchor.EndsWith("\\")?anchor:anchor+"\\";
    if(!String.Equals(System.IO.Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase)
      ||!String.Equals(System.IO.Path.GetFullPath(anchor),anchor,StringComparison.OrdinalIgnoreCase)
      ||!String.Equals(path,anchor,StringComparison.OrdinalIgnoreCase)&&!path.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))Reject("store_flush_anchor");
    foreach(string part in anchor.Length==3?new string[0]:anchor.Substring(3).Split('\\'))if(!FlushPart(part))Reject("store_flush_anchor");
    string relative=path.Length==anchor.Length?"":path.Substring(prefix.Length);string[] parts=relative==""?new string[0]:relative.Split('\\');
    if(parts.Length>512)Reject("store_flush_anchor");foreach(string part in parts)if(!FlushPart(part))Reject("store_flush_anchor");
    bool previous=PreserveTimeHandles;PreserveTimeHandles=true;
    try {
      using(var hint=CreateFile(anchor,0xC0000000u,3,IntPtr.Zero,3,0x02200000u,IntPtr.Zero)) {
        if(hint.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
        CheckFlushDirectory(hint,@"\\?\"+anchor,null);
        Info information;Check(GetFileInformationByHandle(hint,out information));if(information.Volume!=serial)Reject("store_volume_changed");
        string volume=VolumeOf(hint);
        FileIdDescriptor descriptor=new FileIdDescriptor{Size=(uint)Marshal.SizeOf(typeof(FileIdDescriptor)),Type=0,FileId=unchecked((long)index),Reserved=0};
        using(var target=OpenFileById(hint,ref descriptor,0xC0100000u,3,IntPtr.Zero,0x02200000u)) {
          if(target.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
          CheckFlushDirectory(target,@"\\?\"+path,volume,objectId);
          Check(FlushFileBuffers(target));
        }
      }
    } finally {PreserveTimeHandles=previous;}
  }
  static object MoveStoreCore(Dictionary<string,object> args) {
    string source=System.IO.Path.GetFullPath(Str(args["source"])),target=System.IO.Path.GetFullPath(Str(args["target"]));
    string fromParent=System.IO.Path.GetDirectoryName(source),toParent=System.IO.Path.GetDirectoryName(target);
    using(var original=Open(source)) using(var parent=Open(toParent)) {
      StoreFileSystem(original);
      if(Id(original)!=Str(args["id"]) || !String.Equals(PathOf(original),@"\\?\"+source,StringComparison.OrdinalIgnoreCase)) Reject("store_identity");
      if(!String.Equals(PathOf(parent),@"\\?\"+toParent,StringComparison.OrdinalIgnoreCase)) Reject("store_path_alias");
      if(!String.Equals(VolumeOf(original),VolumeOf(parent),StringComparison.OrdinalIgnoreCase)) Reject("cross_volume");
      // Capability refusal precedes rename. No COPY_ALLOWED and no replacement.
      bool preserveMetadata=args.ContainsKey("preserveMetadata") && args["preserveMetadata"] is bool && (bool)args["preserveMetadata"];
      Basic before=BasicOf(original);string beforeAlias=ShortName(original);
      Step="store-flush-pre";FlushStoreDirectory(fromParent);FlushStoreDirectory(toParent);
      Step="store-move";Check(MoveFileExW(@"\\?\"+source,@"\\?\"+target,8));
      if(Id(original)!=Str(args["id"]) || !String.Equals(PathOf(original),@"\\?\"+target,StringComparison.OrdinalIgnoreCase)) Reject("store_identity");
      Step="store-flush-post";FlushStoreDirectory(fromParent);FlushStoreDirectory(toParent);
      if(preserveMetadata) {
        Node owned=new Node { Handle=original,Entry=new Dictionary<string,object>{{"shortName",beforeAlias},{"attrs",before.Attr},{"times",new string[]{Str(before.Creation),Str(before.Access),Str(before.Write),Str(before.Change)}}} };
        SetAlias(owned,beforeAlias);if(!String.Equals(ShortName(original),beforeAlias,StringComparison.Ordinal))Reject("portable_short_name_unrepresentable");
        FlushStoreDirectory(target);RestoreNodeBasic(owned,original);
        Basic after=BasicOf(original);if(after.Creation!=before.Creation || after.Access!=before.Access || after.Write!=before.Write || after.Change!=before.Change || after.Attr!=before.Attr)Reject("metadata_changed");
      }
      return new Dictionary<string,object>{{"id",Id(original)},{"volume",VolumeOf(original)}};
    }
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,IntPtr security);
  // FILE_BASIC_INFORMATION -1 suppresses automatic updates on this handle.
  // This is scoped to owned creation/preserved capture, never general writes.
  static object StoreInfo(Dictionary<string,object> args) {
    bool previous=PreserveTimeHandles;PreserveTimeHandles=true;
    try {return StoreInfoCore(args);}finally {PreserveTimeHandles=previous;}
  }
  static object MoveStore(Dictionary<string,object> args) {
    bool preserve=args.ContainsKey("preserveMetadata") && args["preserveMetadata"] is bool && (bool)args["preserveMetadata"];
    if(!preserve)return MoveStoreCore(args);
    bool previous=PreserveTimeHandles;PreserveTimeHandles=true;
    try {return MoveStoreCore(args);}finally {PreserveTimeHandles=previous;}
  }

  static void PreserveHandleTimes(SafeFileHandle handle) {
    Basic keep = new Basic { Access=-1, Write=-1, Change=-1 };
    IntPtr value=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Basic))),iosb=Marshal.AllocHGlobal(IntPtr.Size*2);
    string prior=Step;Step="preserve-times";
    try {
      Marshal.StructureToPtr(keep,value,false);
      int status=NtSetInformationFile(handle,iosb,value,(uint)Marshal.SizeOf(typeof(Basic)),4);
      if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status));
      Step=prior;
    } finally {Marshal.FreeHGlobal(value);Marshal.FreeHGlobal(iosb);}
  }
  static object CapturePreserved(Dictionary<string,object> args) {
    bool previous=PreserveTimeHandles;PreserveTimeHandles=true;
    try {return Capture(args);}
    finally {try {RestoreBasic(new List<Node>(Nodes.Values));} finally {PreserveTimeHandles=previous;}}
  }
  static object CreateOwnedPortable(Dictionary<string,object> args) {
    bool previous=PreserveTimeHandles;PreserveTimeHandles=true;
    try {return CreateOwnedPortableCore(args);}
    finally {PreserveTimeHandles=previous;}
  }
  static void VerifyPortableReadback(Dictionary<string,object> wanted,Dictionary<string,object> actual) {
    Dictionary<string,Dictionary<string,object>> byPath=new Dictionary<string,Dictionary<string,object>>(StringComparer.Ordinal);
    foreach(object raw in (IEnumerable)actual["entries"]) {Dictionary<string,object> entry=Dict(raw);byPath.Add(Str(entry["rel"]),entry);}
    int count=0;
    foreach(object raw in (IEnumerable)wanted["entries"]) {
      Dictionary<string,object> expected=Dict(raw);string rel=Str(expected["rel"]);count++;
      if(!byPath.ContainsKey(rel))Reject("portable_readback_changed");Dictionary<string,object> entry=byPath[rel];
      if(Str(entry["id"])!=Str(expected["id"]) || (bool)entry["dir"]!=(bool)expected["dir"] || Convert.ToUInt32(entry["attrs"])!=Convert.ToUInt32(expected["attrs"]))Reject("portable_readback_changed");
      if(!String.Equals(Str(entry["shortName"]),Str(expected["shortName"]),StringComparison.Ordinal))Reject("portable_short_name_unrepresentable");
      List<string> expectedTimes=new List<string>(),actualTimes=new List<string>();
      foreach(object time in (IEnumerable)expected["times"])expectedTimes.Add(Str(time));
      foreach(object time in (IEnumerable)entry["times"])actualTimes.Add(Str(time));
      if(expectedTimes.Count!=4 || actualTimes.Count!=4)Reject("portable_readback_changed");
      for(int index=0;index<4;index++)if(actualTimes[index]!=expectedTimes[index])Reject("portable_metadata_changed");
      Dictionary<string,Dictionary<string,object>> streams=new Dictionary<string,Dictionary<string,object>>(StringComparer.Ordinal);int streamCount=0;
      foreach(object streamRaw in (IEnumerable)entry["streams"]) {Dictionary<string,object> stream=Dict(streamRaw);streams.Add(Str(stream["name"]),stream);}
      foreach(object streamRaw in (IEnumerable)expected["streams"]) {
        Dictionary<string,object> stream=Dict(streamRaw);string name=Str(stream["name"]);streamCount++;
        if(!streams.ContainsKey(name))Reject("portable_readback_changed");Dictionary<string,object> read=streams[name];
        if(Convert.ToInt64(read["size"])!=Convert.ToInt64(stream["size"]) || Str(read["hash"])!=Str(stream["hash"]) || Str(read["data"])!=Str(stream["data"]))Reject("portable_readback_changed");
      }
      if(streamCount!=streams.Count)Reject("portable_readback_changed");
    }
    if(count!=byPath.Count)Reject("portable_readback_changed");
  }

  static object CreateOwnedPortableCore(Dictionary<string,object> args) {
    // All objects are new, created without replacement. Security is inherited
    // from the destination; source IDs/opaque names never authorize a live object.
    if(Nodes.Count!=0 || Capsule!=null) Reject("already_open");
    string root=System.IO.Path.GetFullPath(Str(args["root"])),revision=Str(args["revision"]);
    if(!System.Text.RegularExpressions.Regex.IsMatch(revision,"^[a-f0-9]{64}$")) Reject("portable_revision");
    Dictionary<string,object> source=Dict(args["snapshot"]);
    if(Convert.ToInt32(source["schema"])!=1 || Str(source["platform"])!="ntfs-objects-v1") Reject("portable_shape");
    List<Dictionary<string,object>> entries=new List<Dictionary<string,object>>();
    HashSet<string> names=new HashSet<string>(StringComparer.OrdinalIgnoreCase),dirs=new HashSet<string>(StringComparer.OrdinalIgnoreCase),sourceIds=new HashSet<string>(),aliases=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    long bytesTotal=0;
    foreach(object raw in (IEnumerable)source["entries"]) {
      Dictionary<string,object> entry=Dict(raw);string rel=Str(entry["rel"]);bool directory=(bool)entry["dir"];
      if(entries.Count>=10000 || rel.Length>30000 || !names.Add(rel)) Reject("portable_shape");
      if(!System.Text.RegularExpressions.Regex.IsMatch(Str(entry["id"]),"^[a-f0-9]{24}$") || !sourceIds.Add(Str(entry["id"]))) Reject("portable_shape");
      if(rel!="") {
        string[] parts=rel.Split('/');if(parts.Length>256)Reject("portable_path");
        foreach(string part in parts) if(part.Length<1 || part.Length>255 || part=="." || part==".." || part.EndsWith(".") || part.EndsWith(" ") || part.IndexOfAny(new char[]{'\\',':','*','?','"','<','>','|'})>=0 || System.Text.RegularExpressions.Regex.IsMatch(part,"[\\x00-\\x1f]")) Reject("portable_path");
      } else if(!directory)Reject("portable_root");
      uint attrs=Convert.ToUInt32(entry["attrs"]);if((attrs & ~0x31b7u)!=0 || ((attrs&16u)!=0)!=directory) Reject("portable_attrs");
      int times=0;foreach(object time in (IEnumerable)entry["times"]) {long parsed;if(!long.TryParse(Str(time),out parsed)||parsed<0)Reject("portable_times");times++;}if(times!=4)Reject("portable_times");
      string alias=Str(entry["shortName"]);LegalShortName(alias);
      if(rel!="" && alias!="") {int slash=rel.LastIndexOf('/');string key=(slash<0?"":rel.Substring(0,slash+1))+alias;if(!aliases.Add(key))Reject("portable_alias");}
      HashSet<string> streams=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach(object streamRaw in (IEnumerable)entry["streams"]) {
        Dictionary<string,object> stream=Dict(streamRaw);string name=Str(stream["name"]);
        if(streams.Count>=1024 || !streams.Add(name) || name.Length>1024 || directory&&name=="")Reject("portable_stream");
        if(name!="" && !System.Text.RegularExpressions.Regex.IsMatch(name,"^:[^:\\\\/*?\"<>|\\x00-\\x1f]+:\\$DATA$"))Reject("portable_stream");
        byte[] bytes=Convert.FromBase64String(Str(stream["data"]));
        try {bytesTotal+=bytes.Length;if(bytesTotal>MaxBytes || bytes.Length!=Convert.ToInt64(stream["size"]) || Convert.ToBase64String(bytes)!=Str(stream["data"]) || Hash(bytes)!=Str(stream["hash"]))Reject("portable_content");}
        finally {Array.Clear(bytes,0,bytes.Length);}
      }
      if(!directory && !streams.Contains(""))Reject("portable_default");
      if(directory)dirs.Add(rel);entries.Add(entry);
    }
    if(entries.Count<1 || !dirs.Contains(""))Reject("portable_root");
    foreach(Dictionary<string,object> entry in entries) {
      string rel=Str(entry["rel"]);if(rel=="")continue;int slash=rel.LastIndexOf('/');string parent=slash<0?"":rel.Substring(0,slash);
      if(!dirs.Contains(parent))Reject("portable_parent");string alias=Str(entry["shortName"]),key=(parent==""?"":parent+"/")+alias;
      if(alias!="" && names.Contains(key) && !String.Equals(key,rel,StringComparison.OrdinalIgnoreCase))Reject("portable_alias");
    }
    // Validate the real destination parent and flush capability before mutation.
    string parentRoot=System.IO.Path.GetDirectoryName(root);using(SafeFileHandle parent=Open(parentRoot)) {
      StoreFileSystem(parent);if(!String.Equals(PathOf(parent),@"\\?\"+parentRoot,StringComparison.OrdinalIgnoreCase))Reject("portable_parent_alias");
      FlushStoreDirectory(parentRoot);
    }
    entries.Sort(delegate(Dictionary<string,object> a,Dictionary<string,object> b){return Str(a["rel"]).Length.CompareTo(Str(b["rel"]).Length);});
    List<object> created=new List<object>();OriginalRoot=@"\\?\"+root;
    foreach(Dictionary<string,object> entry in entries) {
      string rel=Str(entry["rel"]),file=rel==""?OriginalRoot:System.IO.Path.Combine(OriginalRoot,rel.Replace('/','\\'));bool directory=(bool)entry["dir"];
      Step="portable-create";Node node=new Node();
      try {
      if(directory){Check(CreateDirectoryW(file,IntPtr.Zero));node.Handle=Open(file,out node.Writable);}
      else {node.Handle=CreateFile(file,0xC0010000u,5,IntPtr.Zero,1,0x00200000u,IntPtr.Zero);node.Writable=true;if(node.Handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());try {PreserveHandleTimes(node.Handle);}catch{node.Handle.Dispose();throw;}}
      string id=Id(node.Handle);if(Nodes.ContainsKey(id)){node.Handle.Dispose();Reject("object_duplicate");}
      if(!String.Equals(PathOf(node.Handle),file,StringComparison.OrdinalIgnoreCase)){node.Handle.Dispose();Reject("portable_path_alias");}
      Dictionary<string,object> staged=new Dictionary<string,object>(entry);staged["id"]=id;staged["opaque"]=RandomName();node.Entry=staged;Nodes.Add(id,node);created.Add(staged);
      } catch {
        if(!Nodes.ContainsValue(node) && node.Handle!=null && !node.Handle.IsClosed)node.Handle.Dispose();
        throw;
      }
      // Directories have no descendants open when their alias is established.
      SetAlias(node,Str(entry["shortName"]));
      if(!String.Equals(ShortName(node.Handle),Str(entry["shortName"]),StringComparison.Ordinal))Reject("portable_short_name_unrepresentable");
      foreach(object streamRaw in (IEnumerable)entry["streams"]) {
        Dictionary<string,object> stream=Dict(streamRaw);string name=Str(stream["name"]);byte[] bytes=Convert.FromBase64String(Str(stream["data"]));
        try {
          SafeFileHandle handle=node.Handle;
          if(name!=""){handle=CreateFile(file+name,0xC0010000u,5,IntPtr.Zero,1,0x00200000u,IntPtr.Zero);if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());try{PreserveHandleTimes(handle);}catch{handle.Dispose();throw;}node.Streams.Add(name,handle);}
          Step="portable-write";Write(handle,bytes);
        } finally {Array.Clear(bytes,0,bytes.Length);}
      }
    }
    Snapshot=new Dictionary<string,object>{{"schema",1},{"platform","ntfs-objects-v1"},{"revision",revision},{"entries",created}};
    Step="portable-verify";Verify(false,true);VerifyOriginalLayout();
    // Enumeration and every auxiliary flush handle finish before the final
    // metadata application. Suppressed primary/stream handles cannot overwrite
    // restored Basic values on close. Reopen and inspect actual objects/bytes.
    foreach(Node node in Expected())if((bool)node.Entry["dir"])FlushStoreDirectory(PathOf(node.Handle));FlushStoreDirectory(parentRoot);
    RestoreBasic(Expected());Dictionary<string,object> wanted=Snapshot;Close();
    Dictionary<string,object> observed=Dict(CapturePreserved(new Dictionary<string,object>{{"root",root},{"revision",revision}}));
    Step="portable-readback";VerifyPortableReadback(wanted,observed);return observed;
  }

  public static void Run() {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    try {
      string line;
      while ((line = Console.ReadLine()) != null) {
        try {
          Dictionary<string,object> args = Dict(Json.DeserializeObject(line)); string command = Str(args["cmd"]); object result = null;
          if(CapturedFlushScope && command!="flush-captured-directories" && command!="close")Reject("captured_flush_scope");
          if (command == "store-info") result=StoreInfo(args);
          else if (command == "store-move") result=MoveStore(args);
          else if (command == "create-owned-portable") result=CreateOwnedPortable(args);
          else if (command == "capture") result = Capture(args);
          else if (command == "capture-preserved") result=CapturePreserved(args);
          else if (command == "capture-owned-flush-ready") result=CaptureOwnedFlushReady(args);
          else if (command == "flush-captured-directories") result=FlushCapturedDirectories(args);
          else if (command == "short-probe") ProbeShortNames(args);
          else if (command == "attach") Attach(args);
          else if (command == "seal") Seal(args);
          else if (command == "seal-attached") { OriginalRoot=PathOf(RootNode().Handle); Seal(args); }
          else if (command == "restore") Restore(args);
          else if (command == "publish") Publish(args);
          else if (command == "finish-published") FinishPublished(args);
          else if (command == "publish-check") CheckPublication(args);
          else if (command == "store-flush-bound") result=FlushStoreDirectoryBound(args);
          else if (command == "store-flush-by-id") FlushStoreDirectoryById(args);
          else if (command == "store-flush") {
            object preserve;
            if(args.TryGetValue("preserveMetadata",out preserve) && !(preserve is bool)) Reject("store_flush_option");
            if(preserve is bool && (bool)preserve) {
              object anchor;if(!args.TryGetValue("anchor",out anchor) || !(anchor is string))Reject("store_flush_anchor");
              FlushStoreDirectoryPreserved(Str(args["root"]),(string)anchor);
            }
            else FlushStoreDirectory(Str(args["root"]));
          }
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
  const base = path.resolve(migrationBackupRoot());
  const rel = path.relative(base, path.resolve(backup)).split(path.sep);
  if (rel.length !== 2 || !/^[0-9TZ-]+$/.test(rel[0]) || !SKILL_ID_RE.test(rel[1])) migrationCapsuleFail('binding');
  return { backup: path.join(base, ...rel), stamp: rel[0], id: rel[1],
    scopeId: 'skill-backups:' + rel[0], recordId: 'skill-backup:' + (process.platform === 'win32' ? rel[1].toLowerCase() : rel[1]),
    ...(migrationBackupAuthority?.variants.get(rel[0] + '/' + (process.platform === 'win32' ? rel[1].toLowerCase() : rel[1])) || {}) };
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
function migrationCapsuleArchive(descriptor, keys = descriptor.archiveKeys) {
  const file = path.join(descriptor.backup, 'archive');
  return WorkDataStore.createBinary({ file: () => file,
    ...(descriptor.capturedFile ? { capturedFile: descriptor.capturedFile(file, 256 * 1024 * 1024) } : {}),
    purpose: 'backup', schema: 1, scopeId: descriptor.scopeId, recordId: descriptor.recordId + ':archive', keys,
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
  const converted = value?.conversion;
  if (converted !== undefined && (!converted || converted.schema !== 1 || !/^[a-f0-9]{48}$/.test(converted.operationId || '')
    || !['eligible', 'edited', 'gone'].includes(converted.eligibility))) return false;
  const missing = converted?.eligibility === 'gone' && Array.isArray(value.newTree) && value.newTree.length === 0;
  if (value?.historyPublish !== undefined && (!descriptor.plainRoot || value.phase !== 'complete'
    || Object.keys(value.historyPublish || {}).sort().join(',') !== 'id,name,schema' || value.historyPublish.schema !== 1
    || !/^[a-f0-9]{48}$/.test(value.historyPublish.name || '') || !/^[a-f0-9]{24}$/.test(value.historyPublish.id || ''))) return false;
  return !!value && value.schema === 1 && value.id === descriptor.id && value.stamp === descriptor.stamp
    && /^[a-f0-9]{64}$/.test(value.revision || '') && ['preparing', 'ready', 'published', 'restoring', 'complete', 'aborted'].includes(value.phase)
    && /^[a-f0-9]{24}$/.test(value.oldRoot || '') && (missing || migrationCapsuleFingerprintShape(value.newTree))
    && (missing || value.newTree.find(entry => entry.rel === '').id !== value.oldRoot)
    && (!descriptor.generationId || value.generationId === descriptor.generationId)
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
function migrationCapsuleIntent(descriptor, keys = descriptor.intentKeys) {
  const file = () => descriptor.intentFile || path.join(descriptor.backup, 'intent');
  const store = onAuthenticated => WorkDataStore.createText({ file, ...(descriptor.capturedFile ? { capturedFile: descriptor.capturedFile(file(), 256 * 1024 * 1024) } : {}), purpose: 'backup', schema: 1,
    scopeId: descriptor.scopeId, recordId: descriptor.intentRecordId || descriptor.recordId + ':intent', keys, chunked: true, maxPlaintextBytes: 16 * 1024 * 1024,
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
function migrationCapsuleCarrierHeaderValid(header,descriptor,kind) { return !(!header || Array.isArray(header)
        || Object.keys(header).sort().join(',') !== 'format,instanceId,keyId,manifest,purpose,recordId,revision,schema,scopeId,seq,workData'
        || header.workData !== 3 || header.format !== 'chunks-v1' || header.purpose !== 'backup'
        || header.schema !== 1 || header.seq !== 1 || header.scopeId !== descriptor.scopeId
        || header.recordId !== (kind === 'intent' && descriptor.intentRecordId || descriptor.recordId + ':' + kind)
        || typeof header.instanceId !== 'string' || typeof header.keyId !== 'string'
        || !/^[a-f0-9]{32}$/.test(header.revision || '') || !header.manifest || typeof header.manifest !== 'object' || Array.isArray(header.manifest)); }
// Captured sources are opaque leases issued by the real preserved tree owner.
// Only this callback can see the copy; an expired/changed lease never falls back
// to opening the path. Crypto parsing remains in the existing Store owners.
function migrationCapturedCleanupFailure(primary,failed,cleanupErrors,releaseFailed) {
  const unknown = value => {
    if (value === null || !['object','function'].includes(typeof value)) return false;
    const seen=new Set();
    try { for(let depth=0;value!==null&&depth<8;depth++) {
      if(seen.has(value))return true;seen.add(value);
      const flag=Object.getOwnPropertyDescriptor(value,'helperMayStillRun');
      if(flag)return !Object.hasOwn(flag,'value')||flag.value===true;
      value=Object.getPrototypeOf(value);
    } return value!==null; } catch { return true; }
  };
  const causes=[...(failed?[primary]:[]),...cleanupErrors];
  return Object.assign(new AggregateError(causes,'work_data_backup.captured_cleanup_uncertain',{cause:causes[0]}),{
    code:'work_data_backup.captured_cleanup_uncertain',cleanupFailed:true,ownershipRetained:true,
    helperMayStillRun:releaseFailed||causes.some(unknown),operationMayHaveExecuted:true,resultUnavailable:true,retry:false,
  });
}
async function migrationWithCapturedBytes(descriptor, file, maximum, work) {
  const factory = descriptor?.capturedFile;
  if (typeof factory !== 'function') migrationCapsuleFail('captured_source');
  const issue = factory(file, maximum);
  if (typeof issue !== 'function') migrationCapsuleFail('captured_source');
  const token = await issue(); let bytes,result,failed=false,primary;
  try {
    bytes = await WorkDataTree.readCapturedFile(token, file);
    if (!Buffer.isBuffer(bytes) || bytes.length > maximum) migrationCapsuleFail('captured_source');
    result = await work(bytes);
    if (await WorkDataTree.verifyCapturedFile(token, file) !== true
      || WorkDataTree.assertCapturedFile(token, file) !== true) migrationCapsuleFail('captured_source');
  } catch(cause) {failed=true;primary=cause;}
  const cleanupErrors=[];let releaseFailed=false;
  try {if(bytes)bytes.fill(0);}catch(cause){cleanupErrors.push(cause);}
  try {const released=token?.release();if(released!==undefined){Promise.resolve(released).catch(()=>{});throw new Error('captured_release_unproven');}}
  catch(cause){releaseFailed=true;cleanupErrors.push(cause);}
  if(cleanupErrors.length)throw migrationCapturedCleanupFailure(primary,failed,cleanupErrors,releaseFailed);
  if(failed)throw primary;return result;
}
async function migrationCapsuleRequireCarrier(file, descriptor, kind) {
  if (descriptor.capturedFile) return migrationWithCapturedBytes(descriptor, file, 256 * 1024 * 1024, bytes => {
    const end = bytes.indexOf(10);
    if (end < 0 || end > 16 * 1024) migrationCapsuleFail('carrier');
    const header = safeJsonParse(bytes.subarray(0, end).toString('utf8'), null);
    if (!migrationCapsuleCarrierHeaderValid(header, descriptor, kind)) migrationCapsuleFail('carrier');
  });
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
    if (!migrationCapsuleCarrierHeaderValid(header,descriptor,kind)) migrationCapsuleFail('carrier');
  } finally { await handle.close(); }
}
async function migrationCapsuleWriteIntent(descriptor, intent) {
  if (!migrationCapsuleIntentShape(intent, descriptor)) migrationCapsuleFail('intent');
  // Recovery keeps this private authority sealed even if the switch changed after
  // preparing. Ordinary OFF undo is rejected separately, before touching live data.
  const lease = await WorkDataStore.acquireSnapshot(descriptor.intentKeys || WorkDataStore.requireKeys());
  await lease.release();
  await migrationCapsuleIntent(descriptor).write(JSON.stringify(intent));
}
async function migrationCapsuleRead(descriptor) {
  const archiveFile = path.join(descriptor.backup, 'archive'), intentFile = descriptor.intentFile || path.join(descriptor.backup, 'intent');
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
const MIGRATION_BACKUP_HISTORY_MARKER = '.ruyi-backup-history-v1';
function migrationBackupHistoryShape(value, descriptor) {
  return value && Object.keys(value).sort().join(',') === 'historyOnly,id,phase,schema,snapshot,stamp,type'
    && value.schema === 1 && value.type === 'terminal-skill-backup-history' && value.historyOnly === true
    && value.id === descriptor.id && value.stamp === descriptor.stamp && ['complete', 'aborted'].includes(value.phase)
    && migrationCapsuleShape(value.snapshot);
}
function migrationBackupHistoryBinding(descriptor) { return { purpose:'backup',schema:1,scopeId:'skill-backup-history:'+descriptor.stamp,recordId:descriptor.recordId+':history' }; }
function migrationBackupHistoryStore(descriptor, mode, onAuthenticated) {
  const file = path.join(descriptor.backup, 'history');
  return WorkDataStore.createText({ file: () => file, ...(descriptor.capturedFile ? { capturedFile: descriptor.capturedFile(file, 256 * 1024 * 1024) } : {}), ...migrationBackupHistoryBinding(descriptor), keys: descriptor.archiveKeys,
    chunked: true, maxPlaintextBytes: MIGRATION_CAPSULE_ARCHIVE_LIMIT, enabled: async () => mode === 'encrypted', writeJson: atomicWriteJson,
    validateSealedText: text => { const valid = migrationBackupHistoryShape(safeJsonParse(text, null), descriptor); if (valid && onAuthenticated) onAuthenticated(); return valid; } });
}
async function migrationReadBackupHistory(backup, descriptor = migrationCapsuleDescriptor(backup)) {
  descriptor = { ...descriptor, backup };
  const marker = path.join(backup, MIGRATION_BACKUP_HISTORY_MARKER);
  let present; try { present = await fsp.lstat(marker); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!present) return null;
  if (!present.isFile() || present.isSymbolicLink() || present.nlink !== 1 || present.size > 128) migrationCapsuleFail('history_marker');
  const header = descriptor.capturedFile
    ? await migrationWithCapturedBytes(descriptor, marker, 128, bytes => safeJsonParse(bytes.toString('utf8'), null))
    : safeJsonParse(await fsp.readFile(marker, 'utf8'), null);
  if (!header || Object.keys(header).sort().join(',') !== 'mode,schema' || header.schema !== 1 || !['plain', 'encrypted'].includes(header.mode)) migrationCapsuleFail('history_marker');
  const file = path.join(backup, 'history'), stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MIGRATION_CAPSULE_BINARY_LIMIT * 2) migrationCapsuleFail('history_shape');
  let authenticated = false;
  const text = await migrationBackupHistoryStore(descriptor, header.mode, () => { authenticated = true; }).read();
  const value = safeJsonParse(text, null);
  if (!migrationBackupHistoryShape(value, descriptor) || authenticated !== (header.mode === 'encrypted')) migrationCapsuleFail('history_carrier');
  return { ...value, mode: header.mode };
}
async function migrationCapsulePresent(backup, descriptor = migrationCapsuleDescriptor(backup)) {
  if (await migrationReadBackupHistory(backup, descriptor)) return false;
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
  const failure = (suffix, cause, uncertain = false) => {
    const code = 'work_data_backup.' + suffix;
    return Object.assign(new Error(code), { code, apiCode: code, statusCode: 503,
      ...(cause ? { cause } : {}), ...(uncertain ? { helperMayStillRun: true, operationMayHaveExecuted: true, retry: false } : {}) });
  };
  if (migrationCapsuleBroker.helperMayStillRun === true) throw failure('native_helper_uncertain', null, true);
  if (process.platform !== 'win32') migrationCapsuleFail('platform_unsupported');
  const bootstrap = "$ErrorActionPreference='Stop'; $ruyiSkillCapsuleSource=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RUYI_SKILL_CAPSULE_SOURCE)); [Environment]::SetEnvironmentVariable('RUYI_SKILL_CAPSULE_SOURCE',$null,[EnvironmentVariableTarget]::Process); try { Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition $ruyiSkillCapsuleSource } finally { $ruyiSkillCapsuleSource=$null }; [RuyiSkillCapsule]::Run()";
  let child;
  try {
    child = require('node:child_process').spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], {
      env: { ...process.env, RUYI_SKILL_CAPSULE_SOURCE: Buffer.from(MIGRATION_SKILL_CAPSULE_NATIVE, 'utf8').toString('base64') },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (cause) { throw failure('native_unavailable', cause); } // no issued child
  const timers = require('node:timers');
  const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
  let pending = null, closing = false, stopping = false, settled = false, spawned = false;
  let output = [], outputBytes = 0, firstError = null, settleTimer = null, closePromise = null, resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const finish = error => {
    if (settled) return;
    settled = true; timers.clearTimeout(settleTimer); output = []; outputBytes = 0;
    if (pending) {
      const entry = pending; pending = null; timers.clearTimeout(entry.timer);
      entry.reject(error || failure('native_exit'));
    }
    resolveClosed(error);
  };
  const kill = () => { try { child.kill(); } catch (cause) { firstError ||= failure('native_unavailable', cause); } };
  const boundClose = () => {
    if (settled || settleTimer !== null) return;
    settleTimer = timers.setTimeout(() => {
      if (settled) return;
      migrationCapsuleBroker.helperMayStillRun = true; // permanent, even after late close
      firstError ||= failure('native_close_timeout'); kill();
      finish(failure('native_helper_uncertain', firstError, true));
    }, 2000);
  };
  const stop = (suffix, cause) => {
    if (settled || stopping) return;
    stopping = true; firstError ||= failure(suffix, cause);
    if (pending) timers.clearTimeout(pending.timer);
    output = []; outputBytes = 0; boundClose(); kill();
  };
  child.on('spawn', () => { spawned = true; });
  child.on('error', cause => {
    // Node's spawn-failure event can prove no helper was issued. Runtime/kill
    // errors on a PID, and ambiguous error objects, still require actual close.
    let absent = false;
    try { absent = !spawned && child.pid == null && typeof cause?.syscall === 'string' && cause.syscall.startsWith('spawn '); } catch { /* unknown is not absent */ }
    if (absent) { firstError ||= failure('native_unavailable', cause); finish(firstError); }
    else stop('native_unavailable', cause);
  });
  child.on('exit', code => {
    // Exit does not close inherited pipes. It can prohibit another command but
    // cannot discharge the lease or settle pending command failures.
    if (settled) return;
    if (!closing || code !== 0 || pending) firstError ||= failure('native_exit');
    closing = true; boundClose();
  });
  child.on('close', code => {
    if (settled) return;
    if (code !== 0 || pending) firstError ||= failure('native_exit');
    finish(firstError);
  });
  try {
    child.stdout.on('data', chunk => {
      if (settled || stopping) return;
      const parts = decoder.write(chunk).split('\n');
      for (let index = 0; index < parts.length; index++) {
        output.push(parts[index]); outputBytes += Buffer.byteLength(parts[index]);
        if (outputBytes > MIGRATION_CAPSULE_ARCHIVE_LIMIT) { stop('native_limit'); return; }
        if (index === parts.length - 1) break;
        const line = output.join(''); output = []; outputBytes = 0;
        if (!pending) continue;
        let response;
        try { response = JSON.parse(line); } catch { stop('native_unavailable'); return; }
        const entry = pending; pending = null; timers.clearTimeout(entry.timer);
        if (response?.ok === true) entry.resolve(response.value);
        else {
          const suffix = /^[a-z0-9_]+$/.test(response?.code || '') ? response.code : 'native_unavailable';
          const error = failure(suffix); firstError ||= error; entry.reject(error);
        }
      }
    });
    child.stdout.on('error', cause => stop('native_pipe', cause));
    child.stdin.on?.('error', cause => stop('native_pipe', cause));
    child.stderr.on?.('error', cause => stop('native_pipe', cause));
    child.stderr.resume(); // never capture/log compiler or payload stderr
  } catch (cause) { stop('native_pipe', cause); }
  const command = args => new Promise((resolve, reject) => {
    if (pending || closing || stopping || settled || migrationCapsuleBroker.helperMayStillRun === true) {
      reject(migrationCapsuleBroker.helperMayStillRun === true ? failure('native_helper_uncertain', firstError, true) : failure('native_exit')); return;
    }
    const timer = timers.setTimeout(() => stop('native_timeout'), 120000);
    pending = { resolve, reject, timer };
    try {
      child.stdin.write(JSON.stringify(args) + '\n', cause => { if (cause) stop('native_pipe', cause); });
    } catch (cause) { stop('native_pipe', cause); }
  });
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = closed.then(error => { if (error) throw error; });
    if (!settled) {
      closing = true; boundClose();
      try { child.stdin.end(); } catch (cause) { stop('native_pipe', cause); }
    }
    return closePromise;
  };
  return Object.freeze({ command, close });
}
function migrationCapsulePortableShape(snapshot) {
  const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===names;
  return migrationCapsuleShape(snapshot)&&keys(snapshot,'entries,platform,revision,schema')
    &&snapshot.entries.every(entry=>keys(entry,'attrs,dir,id,opaque,rel,shortName,streams,times')
      &&entry.streams.every(stream=>keys(stream,'data,hash,name,size')));
}
async function migrationCapsuleCreateOwnedPortable(root, snapshot, revision) {
  if(typeof root!=='string'||!path.isAbsolute(root)||root!==path.resolve(root)
    ||!/^[a-f0-9]{64}$/.test(revision||'')||!migrationCapsulePortableShape(snapshot))migrationCapsuleFail('portable_create_shape');
  // Capture the exact logical input before any await. The child creates new
  // objects; source IDs and opaque paths are historical metadata only.
  const original=JSON.parse(JSON.stringify(snapshot));
  const logical=value=>value.entries.map(entry=>({rel:entry.rel,dir:entry.dir,attrs:entry.attrs,times:entry.times,shortName:entry.shortName,streams:entry.streams}))
    .sort((a,b)=>a.rel<b.rel?-1:a.rel>b.rel?1:0);
  let broker,result,failure,failed=false,started=false;
  const hasUncertainty=root=>{
    const active=new Set(),done=new Set();let nodes=0;
    const walk=(value,depth)=>{
      if(value===null||!['object','function'].includes(typeof value))return false;
      if(require('node:util').types.isProxy(value)||depth>8||active.has(value))return true;if(done.has(value))return false;if(++nodes>64)return true;active.add(value);
      try{
        let proto=value;const seen=new Set();for(let level=0;proto!==null&&level<8;level++){
          if(require('node:util').types.isProxy(proto)||seen.has(proto))return true;seen.add(proto);const flag=Object.getOwnPropertyDescriptor(proto,'helperMayStillRun');
          if(flag&&(!Object.hasOwn(flag,'value')||flag.value!==false))return true;
          if(proto!==value&&(Object.getOwnPropertyDescriptor(proto,'cause')||Object.getOwnPropertyDescriptor(proto,'errors')))return true;
          proto=Object.getPrototypeOf(proto);
        }if(proto!==null)return true;
        if(Array.isArray(value)){
          const length=Object.getOwnPropertyDescriptor(value,'length');if(!length||!Object.hasOwn(length,'value')||!Number.isSafeInteger(length.value)||length.value<0||length.value>16)return true;
          for(let index=0;index<length.value;index++){const item=Object.getOwnPropertyDescriptor(value,String(index));if(!item||!Object.hasOwn(item,'value')||walk(item.value,depth+1))return true;}
        }
        for(const key of ['cause','errors']){const edge=Object.getOwnPropertyDescriptor(value,key);if(!edge)continue;if(!Object.hasOwn(edge,'value')||key==='errors'&&!Array.isArray(edge.value)||walk(edge.value,depth+1))return true;}
        done.add(value);return false;
      }catch{return true;}finally{active.delete(value);}
    };return walk(root,0);
  };
  try {
    broker=await migrationCapsuleBroker();started=true;
    result=await broker.command({cmd:'create-owned-portable',root,snapshot:original,revision});
    if(!migrationCapsulePortableShape(result)||result.revision!==revision||JSON.stringify(logical(result))!==JSON.stringify(logical(original)))migrationCapsuleFail('portable_create_changed');
    result=JSON.parse(JSON.stringify(result));
  }catch(cause){failure=cause;failed=true;}
  const cleanupErrors=[];let cleanupUnproven=false;
  if(broker){let closePromised=false;
    const unproven=()=>Object.assign(new Error('work_data_backup.portable_create_close_unproven'),{code:'work_data_backup.portable_create_close_unproven',helperMayStillRun:true});
    try{
      if(require('node:util').types.isProxy(broker))throw unproven();
      const close=Object.getOwnPropertyDescriptor(broker,'close');if(!close||!Object.hasOwn(close,'value')||typeof close.value!=='function')throw unproven();
      const pending=Reflect.apply(close.value,broker,[]);
      if(pending!==undefined){
        if(require('node:util').types.isProxy(pending)||!require('node:util').types.isPromise(pending))throw unproven();
        let proto=pending;const prototypes=new Set();for(let depth=0;proto!==null&&depth<8;depth++){if(require('node:util').types.isProxy(proto)||prototypes.has(proto))throw unproven();prototypes.add(proto);proto=Object.getPrototypeOf(proto);}if(proto!==null)throw unproven();
        const data=(value,key)=>{const seen=new Set();for(let depth=0;value!==null&&depth<8;depth++){if(require('node:util').types.isProxy(value)||seen.has(value))throw unproven();seen.add(value);const descriptor=Object.getOwnPropertyDescriptor(value,key);if(descriptor){if(!Object.hasOwn(descriptor,'value'))throw unproven();return descriptor.value;}value=Object.getPrototypeOf(value);}throw unproven();};
        const ctor=data(pending,'constructor'),then=data(pending,'then'),nativeText=value=>Function.prototype.toString.call(value);
        if(require('node:util').types.isProxy(ctor)||require('node:util').types.isProxy(then)||typeof ctor!=='function'||typeof then!=='function'||nativeText(ctor)!=='function Promise() { [native code] }'||nativeText(then)!=='function then() { [native code] }')throw unproven();
        const species=Object.getOwnPropertyDescriptor(ctor,Symbol.species);
        if(!species||!(Object.hasOwn(species,'value')?[undefined,null,ctor].includes(species.value):typeof species.get==='function'&&!require('node:util').types.isProxy(species.get)&&species.set===undefined&&nativeText(species.get)==='function get [Symbol.species]() { [native code] }'))throw unproven();
        // Subscribe with the checked intrinsic now. Await only our own void
        // promise; do not re-read foreign constructor/then later or assimilate ACK data.
        await new Promise((resolve,reject)=>{Reflect.apply(then,pending,[value=>{if(value===undefined)resolve();else reject(unproven());},reject]);closePromised=true;});
      }
    }catch(cause){cleanupErrors.push(cause);cleanupUnproven=!closePromised||cause===null||!['object','function'].includes(typeof cause);}
  }
  if(cleanupErrors.length){failure=migrationCapturedCleanupFailure(failure,failed,cleanupErrors,cleanupUnproven||(failed&&hasUncertainty(failure))||cleanupErrors.some(hasUncertainty));failed=true;}
  if(failed){if(!started)throw failure;const helperMayStillRun=hasUncertainty(failure);throw Object.assign(new Error('work_data_backup.portable_create_uncertain',{cause:failure}),{
    code:'work_data_backup.portable_create_uncertain',apiCode:'work_data_backup.portable_create_uncertain',statusCode:409,
    operationMayHaveExecuted:true,resultUnavailable:true,retry:false,stageRetained:root,...(helperMayStillRun?{helperMayStillRun:true}:{})});}
  const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
  return freeze(result);
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
  for (const candidate of [descriptor.plainRoot, migrationSkillTarget(descriptor.id), path.join(descriptor.backup, 'restored', intent.oldRoot)].filter(Boolean)) {
    const stat = await migrationLstat(candidate);
    if (!stat) continue;
    // A ready copy is a different root; it must never enter the old-object scan.
    const info = await fsp.stat(candidate, { bigint: true });
    if (info.ino.toString(16).padStart(16, '0') === intent.oldRoot.slice(8)) roots.push(candidate);
  }
  for (const entry of await fsp.readdir(objects, { withFileTypes: true })) roots.push(path.join(objects, entry.name));
  return roots;
}
async function migrationCapsuleCapturePreserved(root, revision) {
  const broker = await migrationCapsuleBroker();
  try { const snapshot = await broker.command({ cmd: 'capture-preserved', root, revision }); if (!migrationCapsuleShape(snapshot)) migrationCapsuleFail('shape'); return snapshot; }
  finally { await broker.close(); }
}
function migrationCapsuleSameMetadata(actual, expected) {
  if (!migrationCapsuleSame(actual, migrationCapsuleFingerprint(expected))) return false;
  const expectedById = new Map(expected.entries.map(entry => [entry.id, entry]));
  return actual.entries.every(entry => {
    const source = expectedById.get(entry.id);
    return source && entry.attrs === source.attrs && entry.shortName === source.shortName && JSON.stringify(entry.times) === JSON.stringify(source.times);
  });
}
async function migrationFinishPlainHistory(descriptor, snapshot, intent) {
  if (!descriptor.plainRoot || intent.phase !== 'complete') return;
  const target = descriptor.plainRoot, host = descriptor.historyHost;
  if (!host || ['directory', 'info', 'move', 'flush'].some(name => typeof host[name] !== 'function')) migrationCapsuleFail('plain_history_host', true);
  await host.directory(descriptor.backup); await host.directory(path.dirname(target));
  const parent = path.join(descriptor.backup, 'history-stage');
  await host.directory(parent, true); await fsp.mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; }); await host.directory(parent);
  if (!intent.historyPublish) {
    if (await migrationLstat(target)) migrationCapsuleFail('plain_history_conflict', true);
    const name = crypto.randomBytes(24).toString('hex'), stage = path.join(parent, name);
    await fsp.mkdir(stage); await host.directory(stage);
    const staged = { ...descriptor, backup: stage };
    await migrationBackupHistoryStore(staged, 'plain').write(JSON.stringify({ schema: 1, type: 'terminal-skill-backup-history', historyOnly: true,
      id: descriptor.id, stamp: descriptor.stamp, phase: 'complete', snapshot }));
    await atomicWriteJson(path.join(stage, MIGRATION_BACKUP_HISTORY_MARKER), { schema: 1, mode: 'plain' });
    await host.flush([stage, parent, descriptor.backup]);
    intent.historyPublish = { schema: 1, name, id: (await host.info(stage)).id };
    await migrationCapsuleWriteIntent(descriptor, intent); await host.flush([descriptor.backup]);
  }
  const stage = path.join(parent, intent.historyPublish.name), locations = [];
  for (const candidate of [stage, target]) {
    let stat; try { stat = await fsp.lstat(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await host.info(candidate)).id !== intent.historyPublish.id) migrationCapsuleFail('plain_history_conflict', true);
    if ((await fsp.readdir(candidate)).sort().join(',') !== [MIGRATION_BACKUP_HISTORY_MARKER, 'history'].sort().join(',')) migrationCapsuleFail('plain_history_conflict', true);
    const existing = await migrationReadBackupHistory(candidate, { ...descriptor, backup: candidate });
    if (!existing || existing.mode !== 'plain' || existing.phase !== 'complete' || JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)) migrationCapsuleFail('plain_history_conflict', true);
    locations.push(candidate);
  }
  if (locations.length !== 1) migrationCapsuleFail('plain_history_conflict', true);
  // The old objects are now live. This newly owned directory is typed history,
  // never a recreated set of objects claiming those historical native IDs.
  if (locations[0] === stage) {
    const moved = await host.move({ source: stage, target, id: intent.historyPublish.id });
    if (!moved || moved.id !== intent.historyPublish.id) migrationCapsuleFail('plain_history_conflict', true);
  }
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
  await migrationFinishPlainHistory(descriptor, snapshot, intent);
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
  const root = migrationBackupRoot();
  try {
    const stat = await fsp.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) migrationCapsuleFail('backup_root');
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let batches;
  try { batches = await fsp.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const work = [];
  for (const batch of batches) {
    if (!/^[0-9TZ-]+$/.test(batch.name)) continue;
    if (!batch.isDirectory() || batch.isSymbolicLink()) migrationCapsuleFail('backup_root');
    for (const entry of await fsp.readdir(path.join(root, batch.name), { withFileTypes: true })) {
      const backup = path.join(root, batch.name, entry.name);
      work.push({ backup, entry });
    }
  }
  for (const record of migrationBackupAuthority?.plainRecords || []) if (!work.some(item => samePathKey(item.backup) === samePathKey(record.backup)))
    work.push({ backup: record.backup, entry: { isDirectory: () => true, isSymbolicLink: () => false } });
  for (const { backup, entry } of work) {
      const descriptor = migrationCapsuleDescriptor(backup);
      if (!descriptor.plainRoot && entry.isDirectory() && !entry.isSymbolicLink() && await migrationReadBackupHistory(backup)) continue; // Terminal history never replays an original-object restore.
      if (!entry.isDirectory() || entry.isSymbolicLink() || !descriptor.plainRoot && !await migrationCapsulePresent(backup)) continue;
      // Before intent publication the live objects are untouched. Keep orphaned
      // encrypted archives for inspection; they are never interpreted as live trees.
      if (!await migrationLstat(descriptor.intentFile || path.join(descriptor.backup, 'intent'))) {
        if ((await fsp.readdir(path.join(descriptor.backup, 'objects'))).length) migrationCapsuleFail('intent_missing', true);
        continue;
      }
      const { snapshot, intent } = await migrationCapsuleRead(descriptor);
      const dest = migrationSkillTarget(descriptor.id), stat = await migrationLstat(dest);
      const oldPublished = stat && !stat.isSymbolicLink() && (await fsp.stat(dest, { bigint: true })).ino.toString(16).padStart(16, '0') === intent.oldRoot.slice(8);
      if (['complete', 'aborted'].includes(intent.phase)) {
        const retired = path.join(descriptor.backup, 'retired');
        if (await migrationLstat(retired)) {
          await migrationCapsuleAssertTree(retired, intent.newTree, intent.revision);
          await fsp.rm(retired, { recursive: true });
        }
        await migrationFinishPlainHistory(descriptor, snapshot, intent); continue;
      }
      if (intent.phase === 'published') {
        if (descriptor.plainRoot) {
          const captured = await migrationCapsuleCapturePreserved(descriptor.plainRoot, intent.revision);
          if (!migrationCapsuleSameMetadata(captured, snapshot)) migrationCapsuleFail('plain_backup_changed', true);
        } else await migrationCapsuleVerifyReady(descriptor, snapshot);
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
        const retired = path.join(descriptor.backup, 'retired');
        if (await migrationLstat(retired)) {
          await migrationCapsuleAssertTree(retired, intent.newTree, intent.revision);
          await fsp.rm(retired, { recursive: true });
        }
        await migrationFinishPlainHistory(descriptor, snapshot, intent); continue;
      }
      await migrationCapsuleRestore(descriptor, snapshot, intent, intent.phase === 'restoring');
  }
}
async function migrationUndoCapsule(backup, item, dest) {
  const descriptor = migrationCapsuleDescriptor(backup);
  if ((await readConfig()).workDataEncryptionV1 !== true && !descriptor.plainRoot) migrationCapsuleFail('downgrade_refused');
  if (descriptor.id !== item.id) migrationCapsuleFail('binding');
  const { snapshot, intent } = await migrationCapsuleRead(descriptor);
  const eligibility = migrationBackupAuthority?.eligibility.get(descriptor.stamp + '/' + (process.platform === 'win32' ? descriptor.id.toLowerCase() : descriptor.id)) || intent.conversion?.eligibility;
  if (eligibility && ['gone', 'edited'].includes(eligibility)) return { id: item.id, outcome: 'kept', reason: eligibility };
  if (intent.phase === 'complete') { await migrationFinishPlainHistory(descriptor, snapshot, intent); return { id: item.id, outcome: 'restored-previous' }; }
  if (intent.phase === 'aborted') return { id: item.id, outcome: 'kept', reason: 'aborted' };
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
      const bdir = path.join(migrationBackupRoot(), ts);
      await fsp.mkdir(bdir, { recursive: true });
      backup = path.join(bdir, row.id);
      if (sealBackup) {
        await migrationCapsulePrepare(dest, stage, backup);
      } else {
        await fsp.rename(dest, backup);
      }
    }
    if (!existing || !sealBackup) await fsp.rename(stage, dest);
    return { ok: true, action: existing ? 'updated' : 'created', copyTreeHash, backup,
      ...(backup && migrationBackupAuthority ? { backupRef: migrationBackupAuthority.makeRef(ts, row.id) } : {}), skippedLinks: tree.links };
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
      log.files.push({ file: migrationSkillTarget(row.id), kind: 'skill-copy', backup: r.backup, ...(r.backupRef ? { backupRef: r.backupRef } : {}),
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
  const fileKey = samePathKey(String(f.file || ''));
  const legacyFile = migrationBackupAuthority?.legacySkillRoots.some(root => fileKey === samePathKey(path.join(root, String(item.id || ''))));
  if (!dest || fileKey !== samePathKey(dest) && !legacyFile) return { id: String(item.id || ''), outcome: 'kept', reason: 'invalid-log' };
  const backupRoot = samePathKey(migrationBackupRoot());
  const requestedBackup = migrationBackupAuthority && f.backupRef ? await migrationBackupAuthority.resolveRef(f.backupRef) : migrationBackupAuthority && f.backup ? await migrationBackupAuthority.resolveLegacy(f.backup) : f.backup;
  const backup = requestedBackup && migrationPathInside(samePathKey(requestedBackup), backupRoot) ? requestedBackup : '';
  if (backup) {
    const history = await migrationReadBackupHistory(backup);
    if (history) return history.phase === 'complete' ? { id: item.id, outcome: 'restored-previous' } : { id: item.id, outcome: 'kept', reason: 'aborted' };
  }
  if (backup && migrationCapsuleDescriptor(backup).plainRoot) return migrationUndoCapsule(backup, item, dest);
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

// M3-3 local backup owner. The lifecycle host holds its transition gate and drains
// writers before calling this API. Original backup objects never enter fs.cp/codecs.
function createMigrationBackupOwner({ base, readActive, sourceKeys, targetKeys = sourceKeys, native, ownership, assertExclusive, assertExclusiveSync, preservedRead } = {}) {
  if (typeof base !== 'string' || !path.isAbsolute(base) || typeof readActive !== 'function') migrationCapsuleFail('owner_host');
  // This local batch keeps one existing work-data master. Rotation/portable keys
  // need a per-backup key-reference map and are deliberately not implied here.
  if (targetKeys !== sourceKeys) migrationCapsuleFail('owner_key_rotation_unavailable');
  base = path.resolve(base);
  if (preservedRead !== undefined && (!preservedRead || preservedRead.profile !== 'bounded-native-v1'
    || typeof preservedRead.capturePreserved !== 'function' || typeof assertExclusive !== 'function'
    || typeof assertExclusiveSync !== 'function' || !ownership)) migrationCapsuleFail('owner_preserved_host');
  const preservedTree = preservedRead ? WorkDataTree.createPreserved({ capturePreserved: preservedRead.capturePreserved,
    ownership, assertExclusive, assertExclusiveSync, limits: preservedRead.limits || {} }) : null;
  const capturedReads = preservedTree ? new (require('node:async_hooks').AsyncLocalStorage)() : null;
  const portableTargetReads = preservedTree ? new (require('node:async_hooks').AsyncLocalStorage)() : null;
  function capturedFile(file, maximum = 256 * 1024 * 1024) {
    const targetRead = portableTargetReads?.getStore(), captured = targetRead?.captured || capturedReads?.getStore();
    if (!captured) return undefined;
    return () => WorkDataTree.borrowCapturedFile(captured, file, targetRead ? targetRead.ownership : ownership, { maxBytes: maximum });
  }
  function capturedDescriptor(descriptor) {
    return capturedReads?.getStore() || portableTargetReads?.getStore() ? { ...descriptor, capturedFile } : descriptor;
  }
  async function withCapturedReads(work) {
    if (!preservedTree) return work();
    const captured = await preservedTree.capture(base);let result,failed=false,primary;
    try {
      result=await capturedReads.run(captured, async () => {
        const value = await work();
        await preservedTree.verify(captured);
        if (assertExclusiveSync(ownership) !== true) migrationCapsuleFail('owner_preserved_host');
        return value;
      });
    } catch(cause){failed=true;primary=cause;}
    const cleanupErrors=[];let releaseFailed=false;
    try {const released=captured.release();if(released!==undefined){Promise.resolve(released).catch(()=>{});throw new Error('captured_release_unproven');}}
    catch(cause){releaseFailed=true;cleanupErrors.push(cause);}
    if(cleanupErrors.length)throw migrationCapturedCleanupFailure(primary,failed,cleanupErrors,releaseFailed);
    if(failed)throw primary;return result;
  }
  const control = path.join(base, '.work-data', 'skill-backups');
  const legacyRoot = path.join(base, 'migrations', MIGRATION_SKILL_BACKUP_DIR), stableRoot = path.join(control, 'objects-v1');
  const generationRoot = id => path.join(base, '.work-data', 'generations', id);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const id48 = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
  const id24 = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
  const eq = (a, b) => samePathKey(a) === samePathKey(b);
  const plans = new WeakMap();
  const platform = native || {
    info: async root => { const broker = await migrationCapsuleBroker(); try { return await broker.command({ cmd: 'store-info', root }); } finally { await broker.close(); } },
    move: async args => { const broker = await migrationCapsuleBroker(); try { return await broker.command({ cmd: 'store-move', ...args }); } finally { await broker.close(); } },
    capture: migrationCapsuleCapture,
  };
  if (typeof platform.info !== 'function' || typeof platform.move !== 'function' || typeof platform.capture !== 'function') migrationCapsuleFail('owner_host');
  async function stat(file) { try { return await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async function directory(file, missing = false) {
    const absolute = path.resolve(file), volume = path.parse(absolute).root;
    let cursor = volume;
    for (const part of ['', ...absolute.slice(volume.length).split(path.sep).filter(Boolean)]) {
      if (part) cursor = path.join(cursor, part);
      const value = await stat(cursor);
      if (!value) { if (missing) return false; migrationCapsuleFail('owner_directory'); }
      if (!value.isDirectory() || value.isSymbolicLink() || !eq(await fsp.realpath(cursor), cursor)) migrationCapsuleFail('owner_directory');
    }
    return true;
  }
  async function ensureControl() {
    await directory(base); await directory(control, true);
    await fsp.mkdir(control, { recursive: true }); await directory(control);
  }
  function ref(stamp, skillId, storeId) {
    if (typeof stamp !== 'string' || !/^[0-9TZ-]+$/.test(stamp) || typeof skillId !== 'string' || !SKILL_ID_RE.test(skillId) || !id48(storeId)) migrationCapsuleFail('backup_ref');
    const canonical = process.platform === 'win32' ? skillId.toLowerCase() : skillId;
    return Object.freeze({ schema: 2, storeId, stamp, skillId: canonical, backupId: hash(stamp + '/' + canonical) });
  }
  function refValid(value) {
    if (!exact(value, 'schema,storeId,stamp,skillId,backupId') || value.schema !== 2) return false;
    try { const canonical = ref(value.stamp, value.skillId, value.storeId); return canonical.skillId === value.skillId && canonical.backupId === value.backupId; } catch { return false; }
  }
  function journalValid(value) {
    return exact(value, 'schema,operationId,storeId,rootId,volume,sourceProof,targetId,phase') && value.schema === 1
      && id48(value.operationId) && id48(value.storeId) && id24(value.rootId) && typeof value.volume === 'string'
      && (value.sourceProof === null || hex(value.sourceProof)) && id48(value.targetId)
      && ['prepared', 'moved', 'kept', 'canceled'].includes(value.phase);
  }
  function catalogValid(value) {
    return exact(value, 'schema,storeId,rootId,volume') && value.schema === 1 && id48(value.storeId) && id24(value.rootId) && typeof value.volume === 'string';
  }
  function bindingValid(value) {
    return (exact(value, 'schema,generationId,storeId,sourceProof,sourceRootIds,ready,entries') || exact(value, 'schema,generationId,storeId,sourceProof,sourceRootIds,mode,ready,entries'))
      && (value.mode === undefined || ['plain', 'encrypted'].includes(value.mode)) && value.schema === 2 && id48(value.generationId)
      && id48(value.storeId) && (value.sourceProof === null || hex(value.sourceProof)) && typeof value.ready === 'boolean'
      && Array.isArray(value.sourceRootIds) && value.sourceRootIds.length > 0 && value.sourceRootIds.length <= 10000
      && value.sourceRootIds.every(id => id === null || id48(id)) && new Set(value.sourceRootIds).size === value.sourceRootIds.length
      && Array.isArray(value.entries) && value.entries.every(entry => refValid(entry.ref) && entry.ref.storeId === value.storeId
        && (entry.kind === undefined || entry.kind === 'plain' && value.mode === 'plain' && ['published', 'complete'].includes(entry.phase)
          || entry.kind === 'history' && entry.historyMode === (value.mode || 'encrypted') && ['complete', 'aborted'].includes(entry.phase))
        && SKILL_ID_RE.test(entry.physicalSkillId || '') && ref(entry.ref.stamp, entry.physicalSkillId, value.storeId).skillId === entry.ref.skillId
        && ['published', 'complete', 'aborted', 'plain'].includes(entry.phase)
        && ['eligible', 'edited', 'gone', 'terminal', 'plain-owner-required'].includes(entry.eligibility)
        && (entry.phase === 'plain' || entry.sourceGenerationId === null || id48(entry.sourceGenerationId))
        && (entry.phase === 'plain' || hex(entry.archiveSha) && hex(entry.intentSha))
        && (entry.eligibility !== 'eligible' || migrationCapsuleFingerprintShape(entry.newTree)));
  }
  const ownerScope = sourceBase => 'skill-backup-owner:' + hash(samePathKey(sourceBase)).slice(0, 32);
  function sealed(file, recordId, validate, keys = targetKeys, scopeBase = base) {
    const store = authenticated => WorkDataStore.createText({ file: () => file, ...(capturedReads?.getStore() ? { capturedFile: capturedFile(file) } : {}), purpose: 'backup', schema: 1, scopeId: ownerScope(scopeBase), recordId,
      keys, chunked: true, maxPlaintextBytes: 256 * 1024 * 1024, enabled: async () => true, writeJson: atomicWriteJson,
      validateSealedText: text => { const valid = validate(safeJsonParse(text, null)); if (valid && authenticated) authenticated(); return valid; } });
    return { write: async value => { if (!validate(value)) migrationCapsuleFail('owner_shape'); await store().write(JSON.stringify(value)); }, read: async () => {
      if (!await stat(file)) return null;
      let authenticated = false; const text = await store(() => { authenticated = true; }).read();
      if (!authenticated) migrationCapsuleFail('carrier'); return JSON.parse(text);
    } };
  }
  const journalStore = () => sealed(path.join(control, 'relocation-v1.sealed'), 'relocation-v1', journalValid);
  const catalogStore = () => sealed(path.join(control, 'catalog-v1.sealed'), 'catalog-v1', catalogValid);
  const bindingsStore = (id, keys = targetKeys) => sealed(path.join(generationRoot(id), 'migrations', 'skill-backup-bindings-v2.sealed'), 'bindings:' + id, bindingValid, keys);
  async function active() {
    const value = await readActive();
    if (!value || !value.proof || (value.proof.raw !== null && typeof value.proof.raw !== 'string')
        || value.proof.sha256 !== (value.proof.raw === null ? null : hash(value.proof.raw))
        || value.id !== null && !id48(value.id)
        || !eq(value.root, value.id === null ? base : generationRoot(value.id))) migrationCapsuleFail('owner_manifest');
    return value;
  }
  async function current(expected) {
    const value = await active();
    if (!expected?.proof || typeof expected.root !== 'string' || !eq(value.root, expected.root) || value.proof.raw !== expected.proof.raw || value.proof.sha256 !== expected.proof.sha256 || value.id !== expected.id) migrationCapsuleFail('generation_changed');
    return value;
  }
  function candidateValid(candidate) { return candidate && id48(candidate.id) && typeof candidate.root === 'string' && eq(candidate.root, generationRoot(candidate.id)); }
  async function location(journal) {
    const rows = [];
    for (const root of [legacyRoot, stableRoot]) {
      if (!await directory(root, true)) continue;
      const info = await platform.info(root);
      if (info.id !== journal.rootId || info.volume !== journal.volume) migrationCapsuleFail('store_identity', true);
      rows.push({ root, info });
    }
    if (rows.length !== 1) migrationCapsuleFail('store_location', true);
    return rows[0].root;
  }
  async function relocate(journal, target) {
    const source = await location(journal);
    if (eq(source, target)) return;
    await directory(path.dirname(target));
    let moved;
    try { moved = await platform.move({ source, target, id: journal.rootId }); }
    catch (error) { error.operationMayHaveExecuted = true; error.resultUnavailable = true; error.retry = false; throw error; }
    if (!moved || moved.id !== journal.rootId || moved.volume !== journal.volume || !eq(await location(journal), target)) migrationCapsuleFail('store_identity', true);
  }
  async function prepare({ expected, candidate } = {}) {
    expected = Object.freeze({ id: expected?.id, root: expected?.root, proof: Object.freeze({ ...expected?.proof }) });
    candidate = Object.freeze({ id: candidate?.id, root: candidate?.root, mode: candidate?.mode });
    await current(expected);
    if (!candidateValid(candidate)) migrationCapsuleFail('owner_candidate');
    await directory(candidate.root); await ensureControl();
    const catalog = await catalogStore().read();
    if (catalog) {
      await directory(stableRoot); const info = await platform.info(stableRoot);
      if (info.id !== catalog.rootId || info.volume !== catalog.volume) migrationCapsuleFail('store_identity');
      const token = Object.freeze({ storeId: catalog.storeId, root: stableRoot, moved: false });
      plans.set(token, { expected, candidate, catalog }); return token;
    }
    let journal = await journalStore().read();
    if (journal && ['prepared', 'moved'].includes(journal.phase)) {
      if (journal.targetId !== candidate.id || journal.sourceProof !== expected.proof.sha256) migrationCapsuleFail('owner_busy', true);
    } else {
      if (await stat(stableRoot)) migrationCapsuleFail('store_unowned');
      if (!await directory(legacyRoot, true)) { await fsp.mkdir(legacyRoot, { recursive: true }); await directory(legacyRoot); }
      const info = await platform.info(legacyRoot);
      if (!id24(info.id) || typeof info.volume !== 'string') migrationCapsuleFail('store_identity');
      journal = { schema: 1, operationId: crypto.randomBytes(24).toString('hex'), storeId: crypto.randomBytes(24).toString('hex'),
        rootId: info.id, volume: info.volume, sourceProof: expected.proof.sha256, targetId: candidate.id, phase: 'prepared' };
      await journalStore().write(journal);
    }
    await current(expected); await relocate(journal, stableRoot);
    journal.phase = 'moved'; await journalStore().write(journal);
    const token = Object.freeze({ storeId: journal.storeId, root: stableRoot, moved: true });
    plans.set(token, { expected, candidate, journal }); return token;
  }
  async function recover() {
    await recoverRepresentation();
    await directory(control, true); const journal = await journalStore().read();
    if (!journal || ['kept', 'canceled'].includes(journal.phase)) return journal;
    const selected = await active(), keep = selected.id === journal.targetId;
    if (!keep && selected.proof.sha256 !== journal.sourceProof) migrationCapsuleFail('owner_manifest', true);
    const existingCatalog = await catalogStore().read();
    if (existingCatalog && (!keep || existingCatalog.storeId !== journal.storeId || existingCatalog.rootId !== journal.rootId || existingCatalog.volume !== journal.volume)) migrationCapsuleFail('owner_catalog', true);
    await relocate(journal, keep ? stableRoot : legacyRoot);
    if (keep) await catalogStore().write({ schema: 1, storeId: journal.storeId, rootId: journal.rootId, volume: journal.volume });
    journal.phase = keep ? 'kept' : 'canceled'; await journalStore().write(journal);
    return Object.freeze({ phase: journal.phase, root: keep ? stableRoot : legacyRoot, storeId: journal.storeId });
  }
  function descriptor(root, stamp, skillId) {
    return { backup: path.join(root, stamp, skillId), stamp, id: skillId, scopeId: 'skill-backups:' + stamp,
      recordId: 'skill-backup:' + (process.platform === 'win32' ? skillId.toLowerCase() : skillId), archiveKeys: sourceKeys, intentKeys: sourceKeys };
  }
  async function fileHash(file) {
    if (capturedReads?.getStore() || portableTargetReads?.getStore()) return migrationWithCapturedBytes({ capturedFile }, file, 256 * 1024 * 1024,
      bytes => crypto.createHash('sha256').update(bytes).digest('hex'));
    const digest = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(file)) digest.update(bytes); return digest.digest('hex');
  }
  async function provenance(root, skillId, keys) {
    return WorkDataStore.createText({ file: () => path.join(root, SKILL_IMPORT_RECORD), purpose: 'backup', schema: 1, scopeId: 'skills',
      recordId: 'skill-import:' + (process.platform === 'win32' ? skillId.toLowerCase() : skillId), keys, chunked: true, maxPlaintextBytes: 16 * 1024,
      enabled: async () => true, writeJson: atomicWriteJson, validateSealedText: text => Buffer.byteLength(text, 'utf8') <= 16 * 1024 }).read();
  }
  async function equivalent(source, target, sourcePath, targetPath, skillId) {
    const expected = migrationCapsuleFingerprint(source), actual = migrationCapsuleFingerprint(target);
    if (expected.length !== actual.length) migrationCapsuleFail('binding_tree');
    let reencoded = false;
    for (let index = 0; index < expected.length; index++) {
      const a = expected[index], b = actual[index];
      if (a.rel !== b.rel || a.dir !== b.dir || a.streams.length !== b.streams.length) migrationCapsuleFail('binding_tree');
      for (let ordinal = 0; ordinal < a.streams.length; ordinal++) {
        const left = a.streams[ordinal], right = b.streams[ordinal];
        if (left.name !== right.name) migrationCapsuleFail('binding_tree');
        if (left.hash === right.hash && left.size === right.size) continue;
        if (a.rel !== SKILL_IMPORT_RECORD || left.name !== '') migrationCapsuleFail('binding_tree');
        if (await provenance(sourcePath, skillId, sourceKeys) !== await provenance(targetPath, skillId, targetKeys)) migrationCapsuleFail('binding_provenance');
        reencoded = true;
      }
    }
    return reencoded;
  }
  function plainDescriptor(entry, generationId) {
    const source = descriptor(stableRoot, entry.ref.stamp, entry.physicalSkillId);
    return { ...source, backup: path.join(control, 'plain-v1', generationId, entry.ref.backupId), plainRoot: source.backup, generationId,
      intentRecordId: source.recordId + ':intent:' + generationId, archiveKeys: sourceKeys, intentKeys: targetKeys,
      historyHost: Object.freeze({ ...conversionNative, directory }) };
  }
  async function preparePlainBinding(owned, token, backupRef, physicalSkillId, priorBinding) {
    requireConversionNative();
    const entry = { ref: backupRef, physicalSkillId, kind: 'plain', phase: 'published', eligibility: 'edited', newTree: null,
      archiveSha: '', intentSha: '', sourceGenerationId: null };
    const source = plainDescriptor(entry, owned.candidate.id), revision = hash('plain:' + owned.candidate.id + ':' + backupRef.backupId);
    const captured = await conversionNative.capture(source.plainRoot, revision);
    if (!migrationCapsuleShape(captured)) migrationCapsuleFail('plain_backup_shape');
    const currentRepresentation = await representationStore().read();
    const row = currentRepresentation?.targetId === owned.candidate.id && currentRepresentation.entries.find(row => row.backupId === backupRef.backupId);
    let proof;
    if (row) {
      const record = await representationRecordStore(currentRepresentation, row).read();
      if (!record || record.phase !== 'forward' || !migrationCapsuleSameMetadata(captured, record.target)) migrationCapsuleFail('plain_backup_changed');
      proof = { eligibility: record.eligibility, newTree: record.newTree };
    } else {
      const prior = priorBinding?.entries.find(row => row.ref.backupId === backupRef.backupId);
      if (prior?.kind === 'plain') {
        const previous = await migrationCapsuleRead(plainDescriptor(prior, owned.expected.id));
        if (previous.intent.phase !== 'published' || !migrationCapsuleSameMetadata(captured, previous.snapshot)) migrationCapsuleFail('plain_backup_changed');
        proof = { eligibility: previous.intent.conversion.eligibility, newTree: previous.intent.newTree };
        const live = path.join(owned.expected.root, 'skills', physicalSkillId);
        if (!await stat(live)) proof = { eligibility: 'gone', newTree: [] };
        else if (proof.eligibility === 'eligible' && !migrationCapsuleSame(await conversionNative.capture(live, revision), proof.newTree)) proof.eligibility = 'edited';
      } else proof = await plainReceipt(owned.expected, { stamp: backupRef.stamp, skillId: physicalSkillId }, revision);
    }
    entry.eligibility = proof.eligibility;
    let targetTree = proof.newTree;
    if (proof.eligibility === 'eligible') {
      const live = path.join(owned.expected.root, 'skills', physicalSkillId), target = path.join(owned.candidate.root, 'skills', physicalSkillId);
      const original = await platform.capture(live, revision), copied = await platform.capture(target, revision);
      if (!migrationCapsuleSame(original, proof.newTree)) entry.eligibility = 'edited';
      else { entry.reencodedProvenance = await equivalent(original, copied, live, target, physicalSkillId); entry.newTree = migrationCapsuleFingerprint(copied); targetTree = entry.newTree; }
    }
    const intent = { schema: 1, id: physicalSkillId, stamp: backupRef.stamp, revision, phase: 'published', oldRoot: rootId(captured), newTree: targetTree,
      generationId: owned.candidate.id, sourceStage: MIGRATION_SKILL_STAGE_PREFIX + physicalSkillId + '-' + backupRef.stamp,
      conversion: { schema: 1, operationId: currentRepresentation?.targetId === owned.candidate.id ? currentRepresentation.operationId : owned.candidate.id, eligibility: entry.eligibility } };
    await directory(source.backup, true); await fsp.mkdir(source.backup, { recursive: true }); await directory(source.backup);
    await directory(path.join(source.backup, 'objects'), true); await fsp.mkdir(path.join(source.backup, 'objects')).catch(error => { if (error.code !== 'EEXIST') throw error; }); await directory(path.join(source.backup, 'objects'));
    if (await stat(path.join(source.backup, 'archive'))) {
      const previous = await migrationCapsuleRead(source);
      if (!migrationCapsuleSameMetadata(captured, previous.snapshot) || JSON.stringify(previous.intent) !== JSON.stringify(intent)) migrationCapsuleFail('binding_conflict');
    } else {
      const raw = Buffer.from(JSON.stringify(captured), 'utf8'); let bytes;
      try { if (raw.length > MIGRATION_CAPSULE_ARCHIVE_LIMIT) migrationCapsuleFail('capacity'); bytes = require('node:zlib').gzipSync(raw); }
      finally { raw.fill(0); }
      try { await migrationCapsuleArchive(source).write(bytes); } finally { bytes.fill(0); }
      await migrationCapsuleIntent(source).write(JSON.stringify(intent)); await migrationCapsuleRead(source);
    }
    entry.archiveSha = await fileHash(path.join(source.backup, 'archive')); entry.intentSha = await fileHash(path.join(source.backup, 'intent'));
    await conversionNative.flush([source.backup, path.dirname(source.backup), path.dirname(path.dirname(source.backup)), control]);
    return entry;
  }
  async function prepareBindings(token) {
    const owned = plans.get(token); if (!owned) migrationCapsuleFail('owner_token');
    await current(owned.expected); await directory(stableRoot);
    const priorBinding = owned.expected.id ? await bindingsStore(owned.expected.id, sourceKeys).read() : null;
    if (owned.expected.id && (!priorBinding || priorBinding.generationId !== owned.expected.id || priorBinding.storeId !== token.storeId)) migrationCapsuleFail('binding_missing');
    const representation = await representationStore().read();
    const targetMode = owned.candidate.mode || (representation?.targetId === owned.candidate.id ? representation.mode : 'encrypted');
    const entries = []; let ready = true;
    for (const batch of await fsp.readdir(stableRoot, { withFileTypes: true })) {
      if (!batch.isDirectory() || batch.isSymbolicLink() || !/^[0-9TZ-]+$/.test(batch.name)) migrationCapsuleFail('store_entry');
      for (const item of await fsp.readdir(path.join(stableRoot, batch.name), { withFileTypes: true })) {
        if (!item.isDirectory() || item.isSymbolicLink() || !SKILL_ID_RE.test(item.name)) migrationCapsuleFail('store_entry');
        const backupRef = ref(batch.name, item.name, token.storeId), source = descriptor(stableRoot, batch.name, item.name);
        const history = await migrationReadBackupHistory(source.backup, source);
        if (history) {
          if (history.mode !== targetMode) migrationCapsuleFail('representation_mode');
          entries.push({ ref: backupRef, physicalSkillId: item.name, kind: 'history', historyMode: history.mode, phase: history.phase, eligibility: 'terminal', newTree: null,
            archiveSha: await fileHash(path.join(source.backup, 'history')), intentSha: await fileHash(path.join(source.backup, MIGRATION_BACKUP_HISTORY_MARKER)), sourceGenerationId: null });
          continue;
        }
        if (!await migrationCapsulePresent(source.backup, source)) {
          if (targetMode === 'plain') entries.push(await preparePlainBinding(owned, token, backupRef, item.name, priorBinding));
          else { ready = false; entries.push({ ref: backupRef, physicalSkillId: item.name, phase: 'plain', eligibility: 'plain-owner-required' }); }
          continue;
        }
        if (targetMode !== 'encrypted') migrationCapsuleFail('representation_mode');
        const prior = priorBinding?.entries.find(entry => entry.ref.backupId === backupRef.backupId && entry.kind === undefined && entry.phase !== 'plain');
        if (prior) Object.assign(source, { generationId: owned.expected.id, intentFile: path.join(control, 'intents', owned.expected.id, backupRef.backupId + '.sealed'), intentRecordId: source.recordId + ':intent:' + owned.expected.id });
        const record = await migrationCapsuleRead(source), phase = record.intent.phase;
        if (!['published', 'complete', 'aborted'].includes(phase)) migrationCapsuleFail('backup_unsettled');
        const entry = { ref: backupRef, physicalSkillId: item.name, phase, archiveSha: await fileHash(path.join(source.backup, 'archive')),
          intentSha: await fileHash(source.intentFile || path.join(source.backup, 'intent')), sourceGenerationId: prior ? owned.expected.id : null, eligibility: 'terminal', newTree: null };
        if (phase === 'published') {
          await migrationCapsuleVerifyReady(source, record.snapshot);
          if (['edited', 'gone'].includes(record.intent.conversion?.eligibility)) entry.eligibility = record.intent.conversion.eligibility;
          else {
            const sourceLive = path.join(owned.expected.root, 'skills', item.name), targetLive = path.join(owned.candidate.root, 'skills', item.name);
            if (!await stat(sourceLive)) entry.eligibility = 'gone';
            else {
              const original = await platform.capture(sourceLive, record.intent.revision);
              if (!migrationCapsuleSame(original, record.intent.newTree)) entry.eligibility = 'edited';
              else {
                const target = await platform.capture(targetLive, record.intent.revision);
                entry.reencodedProvenance = await equivalent(original, target, sourceLive, targetLive, item.name);
                entry.eligibility = 'eligible'; entry.newTree = migrationCapsuleFingerprint(target);
              }
            }
          }
        }
        const variant = { ...record.intent, generationId: owned.candidate.id, ...(entry.newTree ? { newTree: entry.newTree } : {}) };
        const variantDescriptor = { ...source, generationId: owned.candidate.id,
          intentFile: path.join(control, 'intents', owned.candidate.id, backupRef.backupId + '.sealed'),
          intentRecordId: source.recordId + ':intent:' + owned.candidate.id, intentKeys: targetKeys };
        await directory(path.dirname(variantDescriptor.intentFile), true); await fsp.mkdir(path.dirname(variantDescriptor.intentFile), { recursive: true });
        const variantText = JSON.stringify(variant);
        if (await stat(variantDescriptor.intentFile)) {
          if (await migrationCapsuleIntent(variantDescriptor).read() !== variantText) migrationCapsuleFail('binding_intent');
        } else await migrationCapsuleIntent(variantDescriptor).write(variantText);
        const verified = safeJsonParse(await migrationCapsuleIntent(variantDescriptor).read(), null);
        if (!migrationCapsuleIntentShape(verified, variantDescriptor)) migrationCapsuleFail('binding_intent');
        entries.push(entry);
      }
    }
    const sourceRootIds = [...new Set([...(priorBinding?.sourceRootIds || []), owned.expected.id])];
    const binding = { schema: 2, generationId: owned.candidate.id, storeId: token.storeId, sourceProof: owned.expected.proof.sha256, sourceRootIds, mode: targetMode, ready, entries };
    await fsp.mkdir(path.join(owned.candidate.root, 'migrations'), { recursive: true });
    const previous = await bindingsStore(owned.candidate.id).read();
    if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) migrationCapsuleFail('binding_conflict');
    if (!previous) await bindingsStore(owned.candidate.id).write(binding);
    await current(owned.expected);
    return Object.freeze({ ready, storeId: token.storeId, generationId: owned.candidate.id, entries: entries.length });
  }
  async function storedPhysical(backupRef, binding, selected) {
    if (!refValid(backupRef) || backupRef.storeId !== binding.storeId) migrationCapsuleFail('backup_ref');
    await current(selected);
    const bound = binding.entries.find(row => row.ref.backupId === backupRef.backupId && row.ref.skillId === backupRef.skillId && row.ref.stamp === backupRef.stamp);
    if (bound?.kind === 'plain') {
      const source = plainDescriptor(bound, selected.id), record = await migrationCapsuleRead(source);
      if (!['published', 'restoring', 'complete'].includes(record.intent.phase)) migrationCapsuleFail('binding_intent');
      if (record.intent.phase === 'complete') await migrationFinishPlainHistory(source, record.snapshot, record.intent);
      else await directory(source.plainRoot, record.intent.phase === 'restoring');
      await current(selected); return source.plainRoot;
    }
    const batch = path.join(stableRoot, backupRef.stamp); await directory(batch);
    const matches = (await fsp.readdir(batch, { withFileTypes: true })).filter(item => SKILL_ID_RE.test(item.name)
      && ref(backupRef.stamp, item.name, backupRef.storeId).skillId === backupRef.skillId);
    if (matches.length !== 1 || !matches[0].isDirectory() || matches[0].isSymbolicLink()) migrationCapsuleFail('backup_ref');
    const entry = binding.entries.find(row => row.ref.backupId === backupRef.backupId && row.ref.skillId === backupRef.skillId && row.ref.stamp === backupRef.stamp);
    const physicalSkillId = matches[0].name;
    if (entry && entry.physicalSkillId !== physicalSkillId) migrationCapsuleFail('binding_source_changed');
    const source = descriptor(stableRoot, backupRef.stamp, physicalSkillId);
    await directory(source.backup);
    const history = await migrationReadBackupHistory(source.backup, source);
    if (history) {
      if (entry && (entry.kind !== 'history' || entry.phase !== history.phase || entry.historyMode !== history.mode
        || await fileHash(path.join(source.backup, 'history')) !== entry.archiveSha
        || await fileHash(path.join(source.backup, MIGRATION_BACKUP_HISTORY_MARKER)) !== entry.intentSha)) migrationCapsuleFail('binding_source_changed');
      await current(selected); return source.backup;
    }
    if (entry?.kind === 'history') migrationCapsuleFail('binding_source_changed');
    if (!entry && binding.mode === 'plain') { await current(selected); return source.backup; } // New ordinary OFF backups retain whole-directory undo.
    if (entry) Object.assign(source, { generationId: selected.id, intentKeys: targetKeys,
      intentFile: path.join(control, 'intents', selected.id, backupRef.backupId + '.sealed'),
      intentRecordId: source.recordId + ':intent:' + selected.id });
    // Newly published backups after activation use their original authenticated
    // intent. Enumerating the actual name preserves its exact intent ID on NTFS.
    await migrationCapsuleRead(source); await current(selected);
    return source.backup;
  }
  async function finishPlainHistoryReadOnly(source, snapshot, intent) {
    const captured = capturedReads?.getStore();
    if (!captured) return migrationFinishPlainHistory(source, snapshot, intent);
    // A previously completed plain history can be authenticated without the
    // mutating finish routine. Pending publication belongs to recovery first.
    const target = source.plainRoot, publication = intent.historyPublish;
    const selected = captured.directories.some(name => eq(path.join(base, ...name.split('/')), target));
    if (!selected || !publication) migrationCapsuleFail('plain_history_pending');
    const names = [];
    for (const row of captured.files) { const file = path.join(base, ...row.path.split('/')); if (eq(path.dirname(file), target)) names.push(path.basename(file)); }
    for (const name of captured.directories) { const file = path.join(base, ...name.split('/')); if (eq(path.dirname(file), target)) names.push(path.basename(file) + '/'); }
    if (names.sort().join(',') !== [MIGRATION_BACKUP_HISTORY_MARKER, 'history'].sort().join(',')) migrationCapsuleFail('plain_history_conflict');
    if ((await source.historyHost.info(target)).id !== publication.id) migrationCapsuleFail('plain_history_conflict');
    const history = await migrationReadBackupHistory(target, capturedDescriptor({ ...source, backup: target }));
    if (!history || history.mode !== 'plain' || history.phase !== 'complete'
      || JSON.stringify(history.snapshot) !== JSON.stringify(snapshot)) migrationCapsuleFail('plain_history_conflict');
  }
  async function activate() {
    await recover();
    const prepared = await withCapturedReads(async () => {
    const selected = await active();
    if (!selected.id) migrationCapsuleFail('owner_manifest');
    const catalog = await catalogStore().read(), binding = await bindingsStore(selected.id).read();
    if (!catalog || !binding || !binding.ready || binding.storeId !== catalog.storeId || binding.generationId !== selected.id) migrationCapsuleFail('binding_missing');
    if (safeJsonParse(selected.proof.raw, null)?.mode !== (binding.mode || 'encrypted')) migrationCapsuleFail('representation_mode');
    await directory(stableRoot); const info = await platform.info(stableRoot);
    if (info.id !== catalog.rootId || info.volume !== catalog.volume) migrationCapsuleFail('store_identity');
    const variants = new Map(), eligibility = new Map(), plainRecords = [];
    for (const entry of binding.entries) {
      const physical = path.join(stableRoot, entry.ref.stamp, entry.physicalSkillId);
      if (entry.kind === 'plain') {
        const source = plainDescriptor(entry, selected.id); await directory(source.backup);
        if (await fileHash(path.join(source.backup, 'archive')) !== entry.archiveSha) migrationCapsuleFail('binding_source_changed');
        const record = await migrationCapsuleRead(capturedDescriptor(source));
        if (!['published', 'restoring', 'complete'].includes(record.intent.phase) || record.intent.conversion?.eligibility !== entry.eligibility
          || entry.newTree && JSON.stringify(record.intent.newTree) !== JSON.stringify(entry.newTree)) migrationCapsuleFail('binding_intent');
        if (record.intent.phase === 'published') {
          const actual = await conversionNative.capture(physical, record.intent.revision);
          if (!migrationCapsuleSameMetadata(actual, record.snapshot)) migrationCapsuleFail('plain_backup_changed');
        } else if (record.intent.phase === 'complete') await finishPlainHistoryReadOnly(source, record.snapshot, record.intent);
        const key = entry.ref.stamp + '/' + entry.ref.skillId;
        if (eligibility.has(key)) migrationCapsuleFail('binding_duplicate');
        variants.set(key, source); eligibility.set(key, entry.eligibility); plainRecords.push({ stamp: entry.ref.stamp, id: entry.physicalSkillId, backup: physical }); continue;
      }
      await directory(physical);
      if (entry.kind === 'history') {
        const history = await migrationReadBackupHistory(physical, capturedDescriptor(descriptor(stableRoot, entry.ref.stamp, entry.physicalSkillId)));
        if (!history || history.mode !== entry.historyMode || history.phase !== entry.phase || await fileHash(path.join(physical, 'history')) !== entry.archiveSha
          || await fileHash(path.join(physical, MIGRATION_BACKUP_HISTORY_MARKER)) !== entry.intentSha) migrationCapsuleFail('binding_source_changed');
        const key = entry.ref.stamp + '/' + entry.ref.skillId;
        if (eligibility.has(key)) migrationCapsuleFail('binding_duplicate');
        eligibility.set(key, 'terminal'); continue;
      }
      const sourceIntent = entry.sourceGenerationId ? path.join(control, 'intents', entry.sourceGenerationId, entry.ref.backupId + '.sealed') : path.join(physical, 'intent');
      if (await fileHash(path.join(physical, 'archive')) !== entry.archiveSha || await fileHash(sourceIntent) !== entry.intentSha) migrationCapsuleFail('binding_source_changed');
      const key = entry.ref.stamp + '/' + entry.ref.skillId;
      if (eligibility.has(key)) migrationCapsuleFail('binding_duplicate');
      const variant = { generationId: selected.id, archiveKeys: sourceKeys, intentKeys: targetKeys,
        intentFile: path.join(control, 'intents', selected.id, entry.ref.backupId + '.sealed'),
        intentRecordId: 'skill-backup:' + entry.ref.skillId + ':intent:' + selected.id };
      const record = await migrationCapsuleRead(capturedDescriptor({ ...descriptor(stableRoot, entry.ref.stamp, entry.physicalSkillId), ...variant }));
      const phases = entry.phase === 'published' ? ['published', 'restoring', 'complete'] : [entry.phase];
      if (!phases.includes(record.intent.phase) || entry.newTree && JSON.stringify(record.intent.newTree) !== JSON.stringify(entry.newTree)) migrationCapsuleFail('binding_intent');
      variants.set(key, variant);
      eligibility.set(key, entry.eligibility);
    }
    const resolveLegacy = async absolute => {
      const normalized = path.resolve(String(absolute)), candidates = [legacyRoot, stableRoot];
      for (const root of candidates) {
        const pieces = path.relative(root, normalized).split(path.sep);
        if (pieces.length === 2 && /^[0-9TZ-]+$/.test(pieces[0]) && SKILL_ID_RE.test(pieces[1])) {
          return storedPhysical(ref(pieces[0], pieces[1], catalog.storeId), binding, selected);
        }
      }
      migrationCapsuleFail('backup_ref');
    };
    const authority = Object.freeze({ root: stableRoot, activeRoot: selected.root, skillsRoot: path.join(selected.root, 'skills'),
      legacySkillRoots: Object.freeze(binding.sourceRootIds.map(id => path.join(id === null ? base : generationRoot(id), 'skills'))), storeId: catalog.storeId, variants, eligibility, plainRecords, resolveLegacy,
      makeRef: (stamp, skillId) => ref(stamp, skillId, catalog.storeId),
      resolveRef: value => { if (!refValid(value) || value.storeId !== catalog.storeId) migrationCapsuleFail('backup_ref'); return storedPhysical(value, binding, selected); }, assertCurrent: () => current(selected) });
    const result = Object.freeze({ generationId: selected.id, storeId: catalog.storeId, root: stableRoot });
    // The ordinary host keeps its previous publication point. Only the explicit
    // captured profile defers installation until its final physical proof.
    if (!preservedTree) { migrationBackupAuthority = authority; migrationRecoveryNeeded = true; }
    return { authority, result };
    });
    if (!preservedTree) return prepared.result;
    if (assertExclusiveSync(ownership) !== true) migrationCapsuleFail('owner_preserved_host');
    migrationBackupAuthority = prepared.authority;
    migrationRecoveryNeeded = true;
    return prepared.result;
  }
  async function resolve(backupRef) {
    if (!refValid(backupRef)) migrationCapsuleFail('backup_ref');
    const selected = await active(), catalog = await catalogStore().read();
    if (!selected.id || !catalog || backupRef.storeId !== catalog.storeId) migrationCapsuleFail('backup_ref');
    const binding = await bindingsStore(selected.id).read();
    if (!binding?.ready || binding.storeId !== catalog.storeId || binding.generationId !== selected.id) migrationCapsuleFail('binding_missing');
    const info = await platform.info(stableRoot);
    if (info.id !== catalog.rootId || info.volume !== catalog.volume) migrationCapsuleFail('store_identity');
    return storedPhysical(backupRef, binding, selected);
  }
  // Conversion is a separately recoverable representation transaction. The host
  // keeps the global writer exclusion until recoverRepresentation settles it.
  // This API neither publishes a manifest nor replays a historical skill copy.
  const representationRoot = path.join(control, 'representations-v1');
  const representationValid = value => exact(value, 'schema,operationId,storeId,sourceId,sourceProof,targetId,mode,phase,entries')
    && value.schema === 1 && id48(value.operationId) && id48(value.storeId) && (value.sourceId === null || id48(value.sourceId))
    && (value.sourceProof === null || hex(value.sourceProof)) && id48(value.targetId) && ['plain', 'encrypted'].includes(value.mode)
    && ['prepared', 'converted', 'kept', 'canceled'].includes(value.phase) && Array.isArray(value.entries)
    && value.entries.every(row => exact(row, 'stamp,skillId,backupId') && typeof row.stamp === 'string' && /^[0-9TZ-]+$/.test(row.stamp)
      && typeof row.skillId === 'string' && SKILL_ID_RE.test(row.skillId) && row.backupId === hash(row.stamp + '/' + (process.platform === 'win32' ? row.skillId.toLowerCase() : row.skillId)))
    && new Set(value.entries.map(row => row.backupId)).size === value.entries.length;
  const representationStore = () => sealed(path.join(control, 'representation-v1.sealed'), 'representation-v1', representationValid, sourceKeys);
  function representationPaths(journal, row) {
    const anchor = path.join(representationRoot, journal.operationId, row.backupId);
    return { anchor, backup: path.join(stableRoot, row.stamp, row.skillId), capsule: path.join(anchor, 'capsule'), history: path.join(anchor, 'history'), restored: path.join(anchor, 'restored') };
  }
  function representationRecordValid(value) {
    if (!exact(value, 'schema,operationId,stamp,skillId,oldType,oldMode,oldPhase,eligibility,capsuleId,historyId,historyTree,revision,original,target,newTree,sourceGenerationId,archiveSha,intentSha,phase') || value.schema !== 1
      || !id48(value.operationId) || typeof value.stamp !== 'string' || !/^[0-9TZ-]+$/.test(value.stamp)
      || typeof value.skillId !== 'string' || !SKILL_ID_RE.test(value.skillId) || !['plain', 'capsule', 'history'].includes(value.oldType) || !['plain', 'encrypted'].includes(value.oldMode)
      || !['published', 'complete', 'aborted'].includes(value.oldPhase) || !['eligible', 'edited', 'gone', 'terminal'].includes(value.eligibility)
      || !id24(value.capsuleId) || !hex(value.revision) || !migrationCapsuleShape(value.original) || !migrationCapsuleShape(value.target)
      || !(value.sourceGenerationId === null || id48(value.sourceGenerationId)) || !hex(value.archiveSha) || !hex(value.intentSha)
      || (value.eligibility === 'terminal' ? !id24(value.historyId) || !migrationCapsuleFingerprintShape(value.historyTree) : value.historyId !== null || value.historyTree !== null)
      || value.original.revision !== value.revision || value.target.revision !== value.revision
      || !['prepared', 'forward', 'canceled'].includes(value.phase)
      || (value.eligibility !== 'gone' && value.eligibility !== 'terminal' && !migrationCapsuleFingerprintShape(value.newTree))) return false;
    const left = JSON.parse(JSON.stringify(value.original)), right = JSON.parse(JSON.stringify(value.target));
    for (const snapshot of [left, right]) for (const entry of snapshot.entries) if (entry.rel === SKILL_IMPORT_RECORD)
      for (const stream of entry.streams) if (stream.name === '') { delete stream.data; delete stream.hash; delete stream.size; }
    return JSON.stringify(left) === JSON.stringify(right);
  }
  const representationRecordStore = (journal, row) => sealed(path.join(representationPaths(journal, row).anchor, 'record-v1.sealed'),
    'representation:' + journal.operationId + ':' + row.backupId, representationRecordValid, sourceKeys);
  const rootId = snapshot => snapshot.entries.find(entry => entry.rel === '').id;
  async function conversionRoots(paths, snapshot) {
    const roots = [];
    for (const root of [paths.backup, path.join(paths.restored, rootId(snapshot))]) {
      const value = await stat(root);
      if (value && value.isDirectory() && !value.isSymbolicLink()
        && (await fsp.stat(root, { bigint: true })).ino.toString(16).padStart(16, '0') === rootId(snapshot).slice(8)) roots.push(root);
    }
    const objects = path.join(paths.capsule, 'objects'); await directory(objects);
    for (const entry of await fsp.readdir(objects)) roots.push(path.join(objects, entry));
    return roots;
  }
  const conversionNative = native || {
    createOwnedPortable: async ({root,snapshot,revision}) => migrationCapsuleCreateOwnedPortable(root,snapshot,revision),
    ...platform,
    capture: async (root, revision) => { const broker = await migrationCapsuleBroker(); try { return await broker.command({ cmd: 'capture-preserved', root, revision }); } finally { await broker.close(); } },
    flush: async roots => { const broker = await migrationCapsuleBroker(); try { for (const root of roots) await broker.command({ cmd: 'store-flush', root }); } finally { await broker.close(); } },
    seal: async ({ root, container, snapshot }) => { const broker = await migrationCapsuleBroker(); try {
      await broker.command({ cmd: 'attach', roots: [root], snapshot });
      await broker.command({ cmd: 'seal-attached', container }); await broker.command({ cmd: 'verify', cleared: true });
    } finally { await broker.close(); } },
    materialize: async ({ roots, snapshot, alternate, paths }) => { const broker = await migrationCapsuleBroker(); try {
      await broker.command({ cmd: 'attach', roots, snapshot }); await broker.command({ cmd: 'publish-check', target: paths.backup });
      await broker.command({ cmd: 'restore', target: path.join(paths.restored, rootId(snapshot)), container: path.join(paths.capsule, 'objects'), allowedSnapshot: alternate });
      await broker.command({ cmd: 'publish', target: paths.backup, container: path.join(paths.capsule, 'objects') });
    } finally { await broker.close(); } },
  };
  function requireConversionNative() {
    if (['info', 'move', 'capture', 'flush', 'seal', 'materialize'].some(name => typeof conversionNative[name] !== 'function')) migrationCapsuleFail('representation_host');
  }
  async function conversionLocation(paths, record) {
    const matches = [];
    for (const root of [paths.backup, paths.capsule]) {
      if (!await directory(root, true)) continue;
      const info = await conversionNative.info(root);
      if (info.id === record.capsuleId) matches.push(root);
      else if (info.id !== rootId(record.original) && info.id !== record.historyId) migrationCapsuleFail('representation_identity', true);
    }
    if (matches.length !== 1) migrationCapsuleFail('representation_location', true);
    return matches[0];
  }
  async function moveConversionCapsule(paths, record, target) {
    const source = await conversionLocation(paths, record);
    if (eq(source, target)) return;
    if (await stat(target)) migrationCapsuleFail('representation_target', true);
    const before = await conversionNative.info(source), moved = await conversionNative.move({ source, target, id: record.capsuleId });
    if (!moved || moved.id !== record.capsuleId || moved.volume !== before.volume) migrationCapsuleFail('representation_identity', true);
  }
  async function verifyConversionCarrier(journal, row, record) {
    const paths = representationPaths(journal, row), capsule = await conversionLocation(paths, record);
    const source = descriptor(stableRoot, row.stamp, row.skillId); source.backup = capsule;
    if (record.sourceGenerationId) Object.assign(source, { generationId: record.sourceGenerationId,
      intentFile: path.join(control, 'intents', record.sourceGenerationId, row.backupId + '.sealed'),
      intentRecordId: source.recordId + ':intent:' + record.sourceGenerationId });
    if (record.oldType === 'history') {
      const history = await migrationReadBackupHistory(capsule, source);
      if (!history || history.mode !== record.oldMode || JSON.stringify(history.snapshot) !== JSON.stringify(record.original)
        || await fileHash(path.join(capsule, 'history')) !== record.archiveSha
        || await fileHash(path.join(capsule, MIGRATION_BACKUP_HISTORY_MARKER)) !== record.intentSha) migrationCapsuleFail('representation_carrier_changed', true);
      return;
    }
    if (await fileHash(path.join(capsule, 'archive')) !== record.archiveSha
      || await fileHash(source.intentFile || path.join(capsule, 'intent')) !== record.intentSha) migrationCapsuleFail('representation_carrier_changed', true);
    const authenticated = await migrationCapsuleRead(source);
    if (JSON.stringify(authenticated.snapshot) !== JSON.stringify(record.oldType === 'plain' ? record.target : record.original)) migrationCapsuleFail('representation_carrier_changed', true);
  }
  function importShape(text) {
    const value = safeJsonParse(text, null);
    return Buffer.byteLength(text, 'utf8') <= 16 * 1024 && value && typeof value === 'object' && !Array.isArray(value)
      && value.schema === 1 && SKILL_IMPORT_SOURCES.includes(value.source)
      && ['plugin', 'sourcePath', 'importedAt', 'sourceTreeHash', 'copyTreeHash'].every(name => typeof value[name] === 'string');
  }
  async function representationSnapshot(snapshot, mode, paths, skillId) {
    const target = JSON.parse(JSON.stringify(snapshot)), entry = target.entries.find(entry => entry.rel === SKILL_IMPORT_RECORD);
    if (!entry) return target;
    if (entry.dir) migrationCapsuleFail('representation_provenance');
    const stream = entry.streams.find(stream => stream.name === ''), raw = Buffer.from(stream.data, 'base64');
    try {
      const text = raw.toString('utf8'); if (!Buffer.from(text, 'utf8').equals(raw)) migrationCapsuleFail('representation_provenance');
      const first = safeJsonParse(text.split('\n')[0], null), whole = safeJsonParse(text, null);
      const carrier = first && typeof first === 'object' && Object.hasOwn(first, 'workData') ? first : whole;
      const marked = carrier && typeof carrier === 'object' && Object.hasOwn(carrier, 'workData');
      let logical = text;
      const host = { purpose: 'backup', schema: 1, scopeId: 'skills', recordId: 'skill-import:' + (process.platform === 'win32' ? skillId.toLowerCase() : skillId),
        keys: sourceKeys, chunked: true, maxPlaintextBytes: 16 * 1024, validateSealedText: importShape, writeJson: atomicWriteJson, enabled: async () => true };
      if (marked) {
        if (raw.length > WorkDataChunks.maxFileBytes(16 * 1024)) migrationCapsuleFail('representation_provenance');
        const generation = /\.k(\d{1,2})$/.exec(String(carrier.keyId || ''));
        if (!generation || !['2', '3'].includes(String(carrier.workData))) migrationCapsuleFail('representation_provenance');
        const lease = await WorkDataStore.acquireSnapshot(sourceKeys);
        try {
          const expected = { purpose: host.purpose, instanceId: lease.instanceId, schema: host.schema, scopeId: host.scopeId,
            recordId: host.recordId, seq: carrier.workData === 3 ? 1 : carrier.seq, generation: Number(generation[1]) };
          if (carrier.workData === 3) {
            if (!text.endsWith('\n')) migrationCapsuleFail('representation_provenance');
            const lines = text.slice(0, -1).split('\n');
            logical = await WorkDataChunks.openLines(lines, lease.key, expected, 16 * 1024);
          } else { const { workData, ...container } = whole || {}; if (workData !== 2) migrationCapsuleFail('representation_provenance'); logical = WorkDataCrypto.open(container, lease.key, expected); }
        } finally { await lease.release(); }
      }
      if (!importShape(logical)) migrationCapsuleFail('representation_provenance');
      let data;
      if (mode === 'encrypted') {
        const targetFile = path.join(paths.anchor, 'import-target.sealed');
        const store = WorkDataStore.createText({ ...host, keys: targetKeys, file: () => targetFile });
        await store.write(logical); if (await store.read() !== logical) migrationCapsuleFail('representation_provenance');
        data = await fsp.readFile(targetFile);
      } else data = Buffer.from(logical, 'utf8');
      try { stream.size = data.length; stream.hash = hash(data); stream.data = data.toString('base64'); } finally { data.fill(0); }
      if (!migrationCapsuleShape(target)) migrationCapsuleFail('representation_capacity');
      return target;
    } finally { raw.fill(0); }
  }
  async function plainReceipt(expected, row, revision) {
    const live = path.join(expected.root, 'skills', row.skillId);
    if (!await stat(live)) return { eligibility: 'gone', newTree: [] };
    const captured = await conversionNative.capture(live, revision);
    const currentTree = migrationCapsuleFingerprint(captured);
    let logical = null;
    const log = WorkDataStore.createText({ file: () => path.join(expected.root, 'migrations', row.stamp + '.json'), purpose: 'migration', schema: 1,
      scopeId: 'global', recordId: 'migration-log:' + row.stamp, keys: sourceKeys, chunked: true, maxPlaintextBytes: 256 * 1024 * 1024,
      enabled: async () => true, validateSealedText: text => migrationLogShape(safeJsonParse(text, null), row.stamp), writeJson: atomicWriteJson });
    try { logical = safeJsonParse(await log.read(), null); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const receipt = migrationLogShape(logical, row.stamp) && logical.files.find(file => file.kind === 'skill-copy'
      && file.items.length === 1 && file.items[0].id === row.skillId && eq(file.file, live)
      && typeof file.backup === 'string'
      && [path.join(legacyRoot, row.stamp, row.skillId), path.join(stableRoot, row.stamp, row.skillId)].some(root => eq(file.backup, root)));
    const digest = crypto.createHash('sha256');
    for (const entry of captured.entries.filter(entry => !entry.dir && entry.rel !== SKILL_IMPORT_RECORD).sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
      digest.update(entry.rel + '\0' + entry.streams.find(stream => stream.name === '').hash + '\n');
    const contentHash = digest.digest('hex');
    // Legacy receipts did not bind object IDs/ADS. Do not bless unknown DATA
    // streams merely because their default-stream content still matches a log.
    const ordinaryStreams = captured.entries.every(entry => entry.streams.every(stream => stream.name === ''));
    return { eligibility: receipt && receipt.items[0].copyTreeHash === contentHash && ordinaryStreams ? 'eligible' : 'edited', newTree: currentTree };
  }
  async function writeConversionCapsule(paths, row, record) {
    const source = descriptor(paths.anchor, row.stamp, row.skillId); source.backup = paths.capsule;
    await atomicWriteJson(path.join(paths.capsule, MIGRATION_CAPSULE_MARKER), { version: 1 });
    await fsp.mkdir(path.join(paths.capsule, 'objects')); await directory(path.join(paths.capsule, 'objects'));
    const raw = Buffer.from(JSON.stringify(record.target), 'utf8'); let bytes;
    try { bytes = require('node:zlib').gzipSync(raw); } finally { raw.fill(0); }
    try { await migrationCapsuleArchive(source).write(bytes); } finally { bytes.fill(0); }
    const intent = { schema: 1, id: row.skillId, stamp: row.stamp, revision: record.revision, phase: 'published', oldRoot: rootId(record.target),
      newTree: record.newTree, sourceStage: MIGRATION_SKILL_STAGE_PREFIX + row.skillId + '-' + row.stamp,
      conversion: { schema: 1, operationId: record.operationId, eligibility: record.eligibility } };
    await migrationCapsuleIntent(source).write(JSON.stringify(intent)); await migrationCapsuleRead(source);
  }
  async function prepareHistory(paths, row, record, mode) {
    await fsp.mkdir(paths.history); await directory(paths.history);
    const descriptor = { ...descriptorForHistory(row), backup: paths.history, archiveKeys: targetKeys };
    const payload = { schema: 1, type: 'terminal-skill-backup-history', historyOnly: true, id: row.skillId, stamp: row.stamp, phase: record.oldPhase, snapshot: record.target };
    await migrationBackupHistoryStore(descriptor, mode).write(JSON.stringify(payload));
    await atomicWriteJson(path.join(paths.history, MIGRATION_BACKUP_HISTORY_MARKER), { schema: 1, mode });
    const read = await migrationReadBackupHistory(paths.history, descriptor); if (!read || read.phase !== record.oldPhase) migrationCapsuleFail('history_carrier');
    const captured = await conversionNative.capture(paths.history, record.revision);
    record.historyId = rootId(captured); record.historyTree = migrationCapsuleFingerprint(captured);
  }
  function descriptorForHistory(row) { return descriptor(stableRoot, row.stamp, row.skillId); }
  async function moveHistory(paths, record, target) {
    const found = [];
    for (const source of [paths.history, paths.backup]) if (await directory(source, true) && (await conversionNative.info(source)).id === record.historyId) found.push(source);
    if (found.length !== 1) migrationCapsuleFail('representation_history_location', true);
    const source = found[0], captured = await conversionNative.capture(source, record.revision);
    if (!migrationCapsuleSame(captured, record.historyTree)) migrationCapsuleFail('representation_history_changed', true);
    if (eq(source, target)) return;
    if (await stat(target)) migrationCapsuleFail('representation_target', true);
    const before = await conversionNative.info(source), result = await conversionNative.move({ source, target, id: record.historyId });
    if (!result || result.id !== record.historyId || result.volume !== before.volume) migrationCapsuleFail('representation_identity', true);
  }
  async function runRepresentation(journal, row, record, forward) {
    const paths = representationPaths(journal, row), wantCapsule = forward ? journal.mode === 'encrypted' : record.oldType === 'capsule';
    await verifyConversionCarrier(journal, row, record);
    if (record.eligibility === 'terminal') {
      // These IDs now belong to live/retained objects elsewhere. Preserve only
      // typed history and the original wrapper; never instantiate or move them.
      if (forward) { await moveConversionCapsule(paths, record, paths.capsule); await moveHistory(paths, record, paths.backup); }
      else { await moveHistory(paths, record, paths.history); await moveConversionCapsule(paths, record, paths.backup); }
    } else if (wantCapsule) {
      // First materialize the exact representation that is being sealed. This
      // reconciles any interrupted flatten/write using only two authenticated snapshots.
      await moveConversionCapsule(paths, record, paths.capsule);
      const snapshot = forward ? record.original : record.target, desired = forward ? record.target : record.original;
      await fsp.mkdir(paths.restored, { recursive: true }); await directory(paths.restored);
      await conversionNative.materialize({ paths, snapshot, alternate: desired, roots: await conversionRoots(paths, snapshot) });
      await conversionNative.flush([paths.anchor, paths.capsule, path.dirname(paths.backup), control]);
      await conversionNative.seal({ root: paths.backup, container: path.join(paths.capsule, 'objects'), snapshot });
      await moveConversionCapsule(paths, record, paths.backup);
    } else {
      await moveConversionCapsule(paths, record, paths.capsule);
      const snapshot = forward ? record.target : record.original, alternate = forward ? record.original : record.target;
      await fsp.mkdir(paths.restored, { recursive: true }); await directory(paths.restored);
      await conversionNative.materialize({ paths, snapshot, alternate, roots: await conversionRoots(paths, snapshot) });
    }
    await conversionNative.flush([paths.anchor, path.dirname(paths.backup), control]);
    record.phase = forward ? 'forward' : 'canceled'; await representationRecordStore(journal, row).write(record);
  }
  async function prepareRepresentation(token, { mode } = {}) {
    requireConversionNative(); const owned = plans.get(token); if (!owned || !['plain', 'encrypted'].includes(mode)) migrationCapsuleFail('representation_host');
    if (owned.candidate.mode !== undefined && owned.candidate.mode !== mode) migrationCapsuleFail('representation_mode');
    await current(owned.expected); await directory(stableRoot);
    const prior = await representationStore().read();
    if (prior && !['kept', 'canceled'].includes(prior.phase)) migrationCapsuleFail('representation_busy', true);
    const journal = { schema: 1, operationId: crypto.randomBytes(24).toString('hex'), storeId: token.storeId, sourceId: owned.expected.id,
      sourceProof: owned.expected.proof.sha256, targetId: owned.candidate.id, mode, phase: 'prepared', entries: [] };
    const records = [];
    // Capture and persist every supported record before clearing any original DATA.
    for (const batch of await fsp.readdir(stableRoot, { withFileTypes: true })) {
      if (!batch.isDirectory() || batch.isSymbolicLink() || !/^[0-9TZ-]+$/.test(batch.name)) migrationCapsuleFail('store_entry');
      for (const item of await fsp.readdir(path.join(stableRoot, batch.name), { withFileTypes: true })) {
        if (!item.isDirectory() || item.isSymbolicLink() || !SKILL_ID_RE.test(item.name)) migrationCapsuleFail('store_entry');
        const row = { stamp: batch.name, skillId: item.name, backupId: ref(batch.name, item.name, token.storeId).backupId }, paths = representationPaths(journal, row);
        const source = descriptor(stableRoot, row.stamp, row.skillId), history = await migrationReadBackupHistory(source.backup, source);
        const capsule = !history && await migrationCapsulePresent(source.backup, source), oldMode = history ? history.mode : capsule ? 'encrypted' : 'plain';
        if (oldMode === mode) continue;
        await directory(paths.anchor, true); await fsp.mkdir(paths.anchor, { recursive: true }); await directory(paths.anchor);
        let original, oldPhase = 'published', eligibility, newTree, revision, sourceGenerationId = null;
        if (history) {
          original = history.snapshot; revision = original.revision; oldPhase = history.phase; eligibility = 'terminal'; newTree = [];
        } else if (capsule) {
          const sourceBinding = owned.expected.id ? await bindingsStore(owned.expected.id, sourceKeys).read() : null;
          if (sourceBinding?.entries.some(entry => entry.ref.backupId === row.backupId)) {
            sourceGenerationId = owned.expected.id;
            Object.assign(source, { generationId: sourceGenerationId, intentFile: path.join(control, 'intents', sourceGenerationId, row.backupId + '.sealed'),
              intentRecordId: source.recordId + ':intent:' + sourceGenerationId });
          }
          const existing = await migrationCapsuleRead(source); original = existing.snapshot; revision = original.revision;
          oldPhase = existing.intent.phase; if (!['published', 'complete', 'aborted'].includes(oldPhase)) migrationCapsuleFail('backup_unsettled');
          if (oldPhase !== 'published') {
            const objects = path.join(paths.backup, 'objects'); await directory(objects);
            if ((await fsp.readdir(objects)).length || await stat(path.join(paths.backup, 'retired'))) migrationCapsuleFail('representation_terminal_unsettled');
            eligibility = 'terminal'; newTree = [];
          }
          else {
            await migrationCapsuleVerifyReady(source, original); eligibility = existing.intent.conversion?.eligibility || 'eligible'; newTree = existing.intent.newTree;
            const live = path.join(owned.expected.root, 'skills', row.skillId);
            if (!await stat(live)) { eligibility = 'gone'; newTree = []; }
            else {
              const captured = await conversionNative.capture(live, revision);
              if (eligibility === 'eligible' && !migrationCapsuleSame(captured, existing.intent.newTree)) eligibility = 'edited';
              newTree = migrationCapsuleFingerprint(captured);
            }
          }
        } else { revision = crypto.randomBytes(32).toString('hex'); original = await conversionNative.capture(paths.backup, revision);
          const priorBinding = owned.expected.id ? await bindingsStore(owned.expected.id, sourceKeys).read() : null;
          const prior = priorBinding?.entries.find(entry => entry.ref.backupId === row.backupId);
          if (prior?.kind === 'plain') {
            const previous = await migrationCapsuleRead(plainDescriptor(prior, owned.expected.id));
            if (previous.intent.phase !== 'published' || !migrationCapsuleSameMetadata(original, previous.snapshot)) migrationCapsuleFail('plain_backup_changed');
            eligibility = previous.intent.conversion.eligibility; newTree = previous.intent.newTree;
            const live = path.join(owned.expected.root, 'skills', row.skillId);
            if (!await stat(live)) { eligibility = 'gone'; newTree = []; }
            else if (eligibility === 'eligible' && !migrationCapsuleSame(await conversionNative.capture(live, revision), newTree)) eligibility = 'edited';
          } else ({ eligibility, newTree } = await plainReceipt(owned.expected, row, revision)); }
        if (!migrationCapsuleShape(original)) migrationCapsuleFail('representation_shape');
        const target = await representationSnapshot(original, mode, paths, row.skillId);
        if (!capsule && !history) { await fsp.mkdir(paths.capsule); await directory(paths.capsule); }
        const info = await conversionNative.info(capsule || history ? paths.backup : paths.capsule);
        const record = { schema: 1, operationId: journal.operationId, stamp: row.stamp, skillId: row.skillId, oldType: history ? 'history' : capsule ? 'capsule' : 'plain', oldMode,
          oldPhase, eligibility, capsuleId: info.id, historyId: null, historyTree: null, revision, original, target, newTree, sourceGenerationId, archiveSha: '', intentSha: '', phase: 'prepared' };
        if (eligibility === 'terminal') await prepareHistory(paths, row, record, mode);
        else if (!capsule) await writeConversionCapsule(paths, row, record);
        const carrier = capsule || history ? paths.backup : paths.capsule;
        record.archiveSha = await fileHash(path.join(carrier, history ? 'history' : 'archive'));
        record.intentSha = await fileHash(history ? path.join(carrier, MIGRATION_BACKUP_HISTORY_MARKER) : source.intentFile || path.join(carrier, 'intent'));
        if (!representationRecordValid(record)) migrationCapsuleFail('representation_shape');
        await representationRecordStore(journal, row).write(record); journal.entries.push(row); records.push(record);
      }
    }
    if (!journal.entries.length) return Object.freeze({ mode, entries: 0, phase: 'unchanged' });
    await representationStore().write(journal); await current(owned.expected);
    try {
      const durableDirectories = [control, stableRoot, representationRoot, path.join(representationRoot, journal.operationId)];
      for (let index = 0; index < journal.entries.length; index++) {
        const paths = representationPaths(journal, journal.entries[index]), record = records[index];
        durableDirectories.push(paths.anchor, path.dirname(paths.backup), record.oldType === 'plain' ? paths.capsule : paths.backup);
        if (record.sourceGenerationId) durableDirectories.push(path.join(control, 'intents', record.sourceGenerationId));
        if (record.eligibility === 'terminal') durableDirectories.push(paths.history);
      }
      await conversionNative.flush([...new Set(durableDirectories)]);
      for (let index = 0; index < journal.entries.length; index++) await runRepresentation(journal, journal.entries[index], records[index], true);
      journal.phase = 'converted'; await representationStore().write(journal); await current(owned.expected);
      return Object.freeze({ operationId: journal.operationId, mode, entries: journal.entries.length, phase: journal.phase });
    } catch (error) { throw representationUncertain(error); }
  }
  function representationUncertain(cause) {
    // Native/host failures may be frozen errors, primitives or objects with
    // throwing getters. Never trust their writable flags after DATA mutation.
    let code = 'work_data_backup.representation_uncertain';
    try { if (typeof cause?.code === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(cause.code)) code = cause.code; } catch { /* retain controlled code */ }
    return Object.assign(new Error(code, { cause }), { code, apiCode: code, statusCode: 503,
      operationMayHaveExecuted: true, resultUnavailable: true, retry: false });
  }
  async function recoverRepresentation() {
    const journal = await representationStore().read(); if (!journal || ['kept', 'canceled'].includes(journal.phase)) return journal;
    requireConversionNative(); const selected = await active(), keep = selected.id === journal.targetId;
    if (!keep && (selected.id !== journal.sourceId || selected.proof.sha256 !== journal.sourceProof)) migrationCapsuleFail('generation_changed', true);
    if (keep && safeJsonParse(selected.proof.raw, null)?.mode !== journal.mode) migrationCapsuleFail('representation_mode', true);
    try { for (const row of journal.entries) {
      const record = await representationRecordStore(journal, row).read();
      if (!record || record.operationId !== journal.operationId || record.stamp !== row.stamp || record.skillId !== row.skillId) migrationCapsuleFail('representation_missing', true);
      await runRepresentation(journal, row, record, keep);
    }
    journal.phase = keep ? 'kept' : 'canceled'; await representationStore().write(journal); return Object.freeze({ phase: journal.phase, mode: journal.mode, entries: journal.entries.length });
    } catch (error) { throw representationUncertain(error); }
  }

  // Read-only completion proof for the ordinary host's empty stable store.
  // Recovery/activate may mutate journals; never invoke them from this verifier.
  async function verifyPublished({ expected } = {}) {
    const selected = await current(expected), catalog = await catalogStore().read(), binding = await bindingsStore(selected.id).read(), journal = await journalStore().read();
    if (!selected.id || !catalog || !binding || !journal || !binding.ready || binding.entries.length
      || binding.generationId !== selected.id || binding.storeId !== catalog.storeId || (binding.mode || 'encrypted') !== safeJsonParse(selected.proof.raw, null)?.mode
      || journal.phase !== 'kept' || journal.targetId !== selected.id && !binding.sourceRootIds.includes(journal.targetId) || journal.storeId !== catalog.storeId
      || journal.rootId !== catalog.rootId || journal.volume !== catalog.volume || journal.targetId === selected.id && binding.sourceProof !== journal.sourceProof) migrationCapsuleFail('published_empty_proof');
    await directory(control); await directory(stableRoot); const info = await platform.info(stableRoot);
    if (info.id !== catalog.rootId || info.volume !== catalog.volume) migrationCapsuleFail('store_identity');
    const names = (await fsp.readdir(control)).sort();
    if (names.join(',') !== ['catalog-v1.sealed', 'objects-v1', 'relocation-v1.sealed'].sort().join(',') || (await fsp.readdir(stableRoot)).length) migrationCapsuleFail('published_empty_proof');
    await current(selected);
    return Object.freeze({ generationId: selected.id, storeId: catalog.storeId, rootId: catalog.rootId, volume: catalog.volume,
      mode: binding.mode || 'encrypted', entries: 0, readOnly: true });
  }
  // Portable layer 1 owns only settled controls and terminal typed history.
  // Any live or retained original-object capsule is refused until its separate
  // create-owned-portable native staging path is available.
  const portableStages = new WeakMap();
  const portableFold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const portableSort = (a,b) => a < b ? -1 : a > b ? 1 : 0;
  const portableJSON = value => JSON.stringify(value);
  const portableClone = value => JSON.parse(portableJSON(value));
  function portableAuthority(files) {
    const row = files.find(file => portableFold(file.path) === '.work-data/active-v1.json');
    if (!row) return { id:null,generation:0,mode:'plain',raw:null,sha256:null };
    const raw = row.data.toString('utf8');
    if (!Buffer.from(raw).equals(row.data)) migrationCapsuleFail('portable_authority');
    const value = safeJsonParse(raw,null);
    if (!exact(value,'schema,id,generation,mode,activeRoot') || value.schema !== 1 || !id48(value.id)
      || !Number.isSafeInteger(value.generation) || value.generation < 1 || !['plain','encrypted'].includes(value.mode)
      || value.activeRoot !== 'generations/' + value.id) migrationCapsuleFail('portable_authority');
    return {id:value.id,generation:value.generation,mode:value.mode,raw,sha256:hash(row.data)};
  }
  function portableInput(request) {
    if (!request || !Array.isArray(request.files) || !Array.isArray(request.directories)
      || !request.source || typeof request.source.sourcePath !== 'string' || !hex(request.source.sourceSha256)
      || !Array.isArray(request.source.files) || !Array.isArray(request.source.directories)
      || typeof request.readCaptured !== 'function') migrationCapsuleFail('portable_host');
    const completeSource=WorkDataRecovery.skillBackupSource(request.files,request.directories);
    if(request.source.sourcePath!==completeSource.sourcePath||request.source.sourceSha256!==completeSource.sourceSha256
      ||portableJSON(request.source.files)!==portableJSON(completeSource.files)||portableJSON(request.source.directories)!==portableJSON(completeSource.directories))migrationCapsuleFail('portable_source');
    const files = new Map();
    for (const row of request.files) {
      if (!row || typeof row.path !== 'string' || !Buffer.isBuffer(row.data) || files.has(portableFold(row.path))) migrationCapsuleFail('portable_source');
      files.set(portableFold(row.path),row);
    }
    const scoped = new Map();
    for (const row of request.source.files) {
      const actual=files.get(portableFold(row.path));
      if (!actual || actual.path !== row.path || actual.data.length !== row.size || hash(actual.data) !== row.sha256
        || scoped.has(portableFold(row.path))) migrationCapsuleFail('portable_source');
      scoped.set(portableFold(row.path),actual);
    }
    const dirs=new Map(request.source.directories.map(name=>[portableFold(name),name]));
    if (dirs.size !== request.source.directories.length || request.source.directories.some(name=>!request.directories.includes(name))) migrationCapsuleFail('portable_source');
    return {files,scoped,dirs,source:request.source,read:request.readCaptured};
  }
  const portableDurabilityProofs=new WeakMap();
  function portableRequireDurabilityHost(){if(native&&typeof native.openPortableDurability!=='function')migrationCapsuleFail('portable_durability_required');}
  function portableProofRows(snapshot){return snapshot.entries.map(entry=>({rel:entry.rel,id:entry.id,dir:entry.dir,attrs:entry.attrs,shortName:entry.shortName,times:entry.times,streams:entry.streams.map(stream=>({name:stream.name,size:stream.size,hash:stream.hash,data:stream.data})).sort((a,b)=>portableSort(a.name,b.name))})).sort((a,b)=>portableSort(a.rel,b.rel));}
  function portableProofExact(actual,expected){return migrationCapsuleShape(actual)&&migrationCapsuleShape(expected)&&actual.revision===expected.revision&&migrationCapsuleSameMetadata(actual,expected)&&portableJSON(portableProofRows(actual))===portableJSON(portableProofRows(expected));}
  function portableWithin(root,file){const relative=path.relative(samePathKey(root),samePathKey(file));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
  async function portableWithDurabilityBroker(work){
    portableRequireDurabilityHost();const broker=await(native?native.openPortableDurability():migrationCapsuleBroker());let result,failure,failed=false;
    if(!broker||typeof broker.command!=='function'||typeof broker.close!=='function'){let closed=false;try{if(broker&&typeof broker.close==='function')closed=await broker.close()===undefined;}catch{}throw Object.assign(new Error('work_data_backup.portable_durability_host'),{code:'work_data_backup.portable_durability_host',helperMayStillRun:!closed,operationMayHaveExecuted:true,resultUnavailable:true,retry:false});}
    try{result=await work(broker);}catch(cause){failure=cause;failed=true;}
    try{if(await broker.close()!==undefined)throw Error('portable_close_unproven');}catch(cause){throw Object.assign(new Error('work_data_backup.portable_durability_uncertain',{cause}),{code:'work_data_backup.portable_durability_uncertain',helperMayStillRun:true,operationMayHaveExecuted:true,resultUnavailable:true,retry:false,...(failed?{operationCause:failure}:{})});}
    if(failed)throw failure;return result;
  }
  async function portableBindExternal(roots,role,admission){
    if(!Array.isArray(roots)||!['external-parent','new-target-ancestor'].includes(role))migrationCapsuleFail('portable_durability_binding');
    const unique=new Map();for(const root of roots){if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root)migrationCapsuleFail('portable_durability_binding');unique.set(samePathKey(root),root);}
    const ordered=[...unique.values()].sort((a,b)=>b.length-a.length||portableSort(a,b)),bindings=[],identities=new Set();
    for(const root of ordered){await admission();await directory(root);const info=await platform.info(root);await admission();if(!info||!id24(info.id)||typeof info.volume!=='string'||info.volume.length<1||info.volume.length>128||identities.has(info.volume+':'+info.id))migrationCapsuleFail('portable_durability_binding');identities.add(info.volume+':'+info.id);bindings.push(Object.freeze({root,id:info.id,volume:info.volume,role,ordinal:bindings.length}));}
    return Object.freeze(bindings);
  }
  async function portableFlushBound(bindings,admission){
    if(!Array.isArray(bindings)||bindings.some((row,index)=>!row||row.ordinal!==index))migrationCapsuleFail('portable_durability_binding');
    if(bindings.length===0)return Object.freeze([]);
    return portableWithDurabilityBroker(async broker=>{const receipts=[];for(const binding of bindings){await admission();const reply=await broker.command({cmd:'store-flush-bound',...binding});await admission();if(!exact(reply,'flushed,id,kind,ordinal,role,root,schema,volume')||reply.schema!==1||reply.kind!=='bound-directory-flush-v1'||reply.flushed!==true||['root','id','volume','role','ordinal'].some(key=>reply[key]!==binding[key]))migrationCapsuleFail('portable_durability_receipt');receipts.push(Object.freeze({...reply}));}return Object.freeze(receipts);});
  }
  async function portableStageDurability(root,fixedProof,identity,requestedRoots,externalBindings,admission){
    if(typeof root!=='string'||!migrationCapsuleShape(fixedProof)||!identity||!id24(identity.id)||typeof identity.volume!=='string'||fixedProof.entries.find(entry=>entry.rel==='')?.id!==identity.id)migrationCapsuleFail('portable_durability_binding');
    const boundIdentity=Object.freeze({id:identity.id,volume:identity.volume}),fixed=portableClone(fixedProof),dirs=fixed.entries.filter(entry=>entry.dir),idList=Object.freeze(dirs.map(entry=>entry.id)),dirPaths=new Set(dirs.map(entry=>samePathKey(entry.rel?path.join(root,...entry.rel.split('/')):root))),external=new Map(externalBindings.map(row=>[samePathKey(row.root),row]));
    for(const wanted of requestedRoots){if(portableWithin(root,wanted)){if(!dirPaths.has(samePathKey(wanted)))migrationCapsuleFail('portable_durability_binding');}else if(!external.has(samePathKey(wanted)))migrationCapsuleFail('portable_durability_binding');}
    if(externalBindings.some(row=>portableWithin(root,row.root)||row.volume!==boundIdentity.volume||fixed.entries.some(entry=>entry.id===row.id)))migrationCapsuleFail('portable_durability_binding');
    const nativeReceipt=await portableWithDurabilityBroker(async broker=>{
      await admission();const ready=await broker.command({cmd:'capture-owned-flush-ready',root,revision:fixed.revision,scope:'owned-stage',preserveMetadata:true,expectedVolume:boundIdentity.volume});await admission();
      if(!exact(ready,'schema,scope,snapshot,token,volume')||ready.schema!==1||ready.scope!=='owned-stage'||ready.volume!==boundIdentity.volume||!hex(ready.token)||!portableProofExact(ready.snapshot,fixed))migrationCapsuleFail('portable_stage_changed');
      const receipt=await broker.command({cmd:'flush-captured-directories',root,revision:fixed.revision,token:ready.token,directoryIds:idList,expectedVolume:boundIdentity.volume});await admission();
      if(!exact(receipt,'allFlushed,count,directories,kind,metadataExact,revision,role,root,schema,token,volume')||receipt.schema!==1||receipt.kind!=='captured-directory-flush-v1'||receipt.role!=='owned-stage'||receipt.root!==root||receipt.revision!==fixed.revision||receipt.token!==ready.token||receipt.volume!==boundIdentity.volume||receipt.allFlushed!==true||receipt.metadataExact!==true||receipt.count!==dirs.length||!Array.isArray(receipt.directories)||receipt.directories.length!==dirs.length)migrationCapsuleFail('portable_durability_receipt');
      const expected=new Map(dirs.map(entry=>[entry.id,entry.rel])),seen=new Set();let lastLength=Infinity;for(const entry of receipt.directories){if(!exact(entry,'id,rel')||!expected.has(entry.id)||expected.get(entry.id)!==entry.rel||seen.has(entry.id)||entry.rel.length>lastLength)migrationCapsuleFail('portable_durability_receipt');seen.add(entry.id);lastLength=entry.rel.length;}
      return portableClone(receipt);
    });
    await portableFlushBound(externalBindings,admission);await admission();const observed=await portableCapture(root,fixed.revision);await admission();if(!portableProofExact(observed,fixed))migrationCapsuleFail('portable_stage_changed');
    const token=Object.freeze({});portableDurabilityProofs.set(token,{root,volume:boundIdentity.volume,rootId:boundIdentity.id,proof:fixed,receipt:nativeReceipt});return token;
  }
  function portableAssertDurability(token,root,identity,observed){const proof=portableDurabilityProofs.get(token);if(!proof||!eq(proof.root,root)||proof.rootId!==identity?.id||proof.volume!==identity?.volume||!portableProofExact(observed,proof.proof))migrationCapsuleFail('portable_stage_changed');return proof;}
  function portableDurabilitySlice(proof,name){const anchor=proof.entries.find(entry=>entry.dir&&portableFold(entry.rel)===portableFold(name))?.rel;if(typeof anchor!=='string'||anchor==='')migrationCapsuleFail('portable_durability_binding');const prefix=anchor+'/',entries=proof.entries.filter(entry=>entry.rel===anchor||entry.rel.startsWith(prefix)).map(entry=>({...portableClone(entry),rel:entry.rel===anchor?'':entry.rel.slice(prefix.length)}));const snapshot={...portableClone(proof),entries};if(!migrationCapsuleShape(snapshot))migrationCapsuleFail('portable_durability_binding');return snapshot;}
  async function portableVerifyInherited(token,stageRoot,target,identity,names,admission){
    const proof=portableDurabilityProofs.get(token);if(!proof||!eq(proof.root,stageRoot)||proof.rootId!==identity?.id||proof.volume!==identity?.volume)migrationCapsuleFail('portable_durability_binding');
    const protectedRoots=[];for(const name of names){const expected=portableDurabilitySlice(proof.proof,name),root=path.join(target,...name.split('/'));await admission();const info=await platform.info(root);if(info.id!==expected.entries.find(entry=>entry.rel==='').id||info.volume!==proof.volume)portableTargetFailure('inherited.identity',()=>({path:name,expected:{id:expected.entries.find(entry=>entry.rel==='').id,volume:proof.volume},actual:{id:info.id,volume:info.volume}}));const actual=await portableCapture(root,expected.revision);await admission();if(!portableProofExact(actual,expected))portableTargetFailure('inherited.snapshot',()=>({path:name,delta:portableTargetSnapshotDelta(actual,expected)}));protectedRoots.push(root);}
    return protectedRoots;
  }
  function portableAssertExternal(token,bindings){const proof=portableDurabilityProofs.get(token);if(!proof||bindings.some(row=>row.volume!==proof.volume||proof.proof.entries.some(entry=>entry.id===row.id)))migrationCapsuleFail('portable_durability_binding');}
  function portableExternalOnly(roots,protectedRoots){return roots.filter(root=>!protectedRoots.some(protectedRoot=>portableWithin(protectedRoot,root)));}

  // Portable source/live/stage evidence must not leave read-induced Basic time
  // changes behind. Keep the older local migration platform unchanged.
  // A supplied native model must explicitly implement the preserved capability.
  // Production uses the same native command with a strict, opt-in time scope.
  const portableFlush = async (roots,anchor) => {
    if(native){
      if(typeof native.flushPreservedRelative!=='function')migrationCapsuleFail('portable_preserved_flush_required');
      return native.flushPreservedRelative(roots,anchor);
    }
    const broker=await migrationCapsuleBroker();
    try{for(const root of roots)await broker.command({cmd:'store-flush',root,anchor,preserveMetadata:true});}
    finally{await broker.close();}
  };
  const portableCapture = (root, revision) => native
    ? (typeof native.capturePreserved === 'function' ? native.capturePreserved(root, revision) : native.capture(root, revision))
    : migrationCapsuleCapturePreserved(root, revision);
  async function collectPortable(request,sourceBase,evidence) {
    const input=portableInput(request),remaining=new Map(input.scoped),claimedDirectories=new Set(),records=[],histories=new Map();
    const take=name=>{const row=remaining.get(portableFold(name));if(!row)migrationCapsuleFail('portable_source');remaining.delete(portableFold(name));return row;};
    const dir=name=>{const actual=input.dirs.get(portableFold(name));if(!actual)migrationCapsuleFail('portable_source');claimedDirectories.add(portableFold(name));return actual;};
    const ancestors=name=>{let current=name;for(;;){if(input.dirs.has(portableFold(current)))claimedDirectories.add(portableFold(current));const at=current.lastIndexOf('/');if(at<0)break;current=current.slice(0,at);}};
    const read=async(path,kind,recordId,validate,{scopeId=ownerScope(sourceBase),mode='encrypted'}={})=>{
      const row=take(path);
      if(kind==='capsule-archive'||kind==='capsule-intent'){
        const end=row.data.indexOf(10),header=end>=0&&end<=16*1024?safeJsonParse(row.data.subarray(0,end).toString('utf8'),null):null,privateKind=kind==='capsule-archive'?'archive':'intent',descriptor={scopeId,recordId:privateKind==='archive'?recordId.slice(0,-8):recordId.split(':intent')[0],...(privateKind==='intent'?{intentRecordId:recordId}:{})};
        if(!migrationCapsuleCarrierHeaderValid(header,descriptor,privateKind))migrationCapsuleFail('carrier');
      }
      const result=await input.read(row,{purpose:'backup',schema:1,scopeId,recordId,chunked:true,maxPlaintextBytes:256*1024*1024});
      if (!result || typeof result.text !== 'string' || result.authenticated !== (mode==='encrypted')) migrationCapsuleFail('portable_carrier');
      const value=safeJsonParse(result.text,null);if(!validate(value))migrationCapsuleFail('portable_shape');
      const record={path:row.path,kind,recordId,scopeId,mode,value};records.push(record);ancestors(row.path.slice(0,row.path.lastIndexOf('/')));return record;
    };
    const authority=portableAuthority(request.files),controlPrefix='.work-data/skill-backups';
    let catalog=null,journal=null,representation=null;
    if(input.dirs.has(controlPrefix)){
      dir(controlPrefix);
      if(remaining.has(controlPrefix+'/catalog-v1.sealed'))catalog=await read(controlPrefix+'/catalog-v1.sealed','catalog','catalog-v1',catalogValid);
      if(remaining.has(controlPrefix+'/relocation-v1.sealed'))journal=await read(controlPrefix+'/relocation-v1.sealed','relocation','relocation-v1',journalValid);
      if(remaining.has(controlPrefix+'/representation-v1.sealed')){
        representation=await read(controlPrefix+'/representation-v1.sealed','representation','representation-v1',representationValid);
        if(!['kept','canceled'].includes(representation.value.phase))migrationCapsuleFail('portable_pending');
        // Nonempty settled records are authenticated below; unresolved phases still refuse.
      }
      if(!journal || !['kept','canceled'].includes(journal.value.phase))migrationCapsuleFail('portable_pending');
      if(catalog){if(journal.value.phase!=='kept'||journal.value.storeId!==catalog.value.storeId||journal.value.rootId!==catalog.value.rootId||journal.value.volume!==catalog.value.volume)migrationCapsuleFail('portable_store');dir(controlPrefix+'/objects-v1');}
      else if(journal.value.phase!=='canceled'||input.dirs.has(controlPrefix+'/objects-v1'))migrationCapsuleFail('portable_store');
    }
    const bindingPattern=new RegExp('^\\.work-data/generations/([a-f0-9]{48})/migrations/skill-backup-bindings-v2\\.sealed$',process.platform==='win32'?'i':'');
    const bindings=[];
    for(const row of [...remaining.values()]){
      const match=bindingPattern.exec(row.path);if(!match)continue;const generationId=portableFold(match[1]);
      const record=await read(row.path,'binding','bindings:'+generationId,bindingValid);
      if(!catalog||record.value.generationId!==generationId||record.value.storeId!==catalog.value.storeId||!record.value.ready)migrationCapsuleFail('portable_binding');
      if(record.value.entries.some(entry=>entry.kind==='history'?entry.eligibility!=='terminal':!['plain',undefined].includes(entry.kind)||!['published','complete','aborted'].includes(entry.phase)))migrationCapsuleFail('portable_original_capsule_required');
      bindings.push(record);
    }
    const activeBinding=bindings.find(row=>row.value.generationId===authority.id);
    if(catalog&&(!authority.id||!activeBinding||(activeBinding.value.mode||'encrypted')!==authority.mode))migrationCapsuleFail('portable_binding');
    const roots=[catalog?controlPrefix+'/objects-v1':null,input.dirs.has('migrations/skill-backups')?'migrations/skill-backups':null].filter(Boolean);
    for(const root of roots){
      dir(root);
      const markerPattern=new RegExp('^'+root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/([0-9TZ-]+)/([A-Za-z0-9_-]{1,64})/\\.ruyi-backup-history-v1$',process.platform==='win32'?'i':'');
      for(const row of [...remaining.values()]){
        const match=markerPattern.exec(row.path);if(!match)continue;const stamp=match[1],skillId=match[2],wrapper=row.path.slice(0,row.path.lastIndexOf('/'));
        const marker=take(row.path),header=safeJsonParse(marker.data.toString('utf8'),null);
        if(!exact(header,'schema,mode')||header.schema!==1||!['plain','encrypted'].includes(header.mode))migrationCapsuleFail('portable_history');
        const descriptor={stamp,id:skillId,recordId:'skill-backup:'+(process.platform==='win32'?skillId.toLowerCase():skillId)};
        const binding=migrationBackupHistoryBinding(descriptor),history=await read(wrapper+'/history','history',binding.recordId,value=>migrationBackupHistoryShape(value,descriptor),{scopeId:binding.scopeId,mode:header.mode});
        for(const entry of history.value.snapshot.entries)if(portableFold(entry.rel)===portableFold(SKILL_IMPORT_RECORD)){
          const stream=entry.streams.find(stream=>stream.name==='');if(!stream||entry.dir)migrationCapsuleFail('portable_history');const bytes=Buffer.from(stream.data,'base64');
          try{const opened=await input.read({path:history.path,data:bytes},{purpose:'backup',schema:1,scopeId:'skills',recordId:'skill-import:'+portableFold(skillId),chunked:true,maxPlaintextBytes:16*1024});if(!opened||typeof opened.text!=='string'||Buffer.byteLength(opened.text,'utf8')>16*1024)migrationCapsuleFail('portable_history');}finally{bytes.fill(0);}
        }
        if(histories.has(stamp+'/'+portableFold(skillId)))migrationCapsuleFail('portable_binding');
        histories.set(stamp+'/'+portableFold(skillId),{history,marker:{path:marker.path,sha256:hash(marker.data)},wrapper,stamp,skillId});
        ancestors(wrapper);
      }
      // Empty stamp directories are legitimate retained names, not capabilities.
      for(const name of input.dirs.values())if(new RegExp('^'+root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[0-9TZ-]+$',process.platform==='win32'?'i':'').test(name))claimedDirectories.add(portableFold(name));
    }
    // Fixed published capsule families. Other representation/pending forms stay
    // explicit special-owner-required until their complete private closure exists.
    const originalPattern=new RegExp('^(?:(?:\\.work-data/generations/[a-f0-9]{48}/)?migrations/skill-backups|\\.work-data/skill-backups/objects-v1)/([0-9TZ-]+)/([A-Za-z0-9_-]{1,64})/\\.ruyi-capsule-v1$',process.platform==='win32'?'i':'');
    if(evidence!==undefined&&!Array.isArray(evidence))migrationCapsuleFail('portable_native_evidence');
    const nativeEvidence=[],providedEvidence=evidence===undefined?null:new Map((Array.isArray(evidence)?evidence:[]).map(row=>[portableFold(row.path),row]));
    if(providedEvidence&&providedEvidence.size!==evidence.length)migrationCapsuleFail('portable_source');
    const evidenceFor=async(relative,revision)=>{
      const snapshot=providedEvidence?providedEvidence.get(portableFold(relative))?.snapshot:await portableCapture(path.join(sourceBase,...relative.split('/')),revision);
      if(!migrationCapsulePortableShape(snapshot)||snapshot.revision!==revision)migrationCapsuleFail('portable_native_evidence');
      const paths=new Set(),fileRows=[...input.files.values()].filter(row=>portableFold(row.path).startsWith(portableFold(relative)+'/'));
      for(const entry of snapshot.entries){const name=entry.rel?relative+'/'+entry.rel:relative;paths.add(portableFold(name));if(entry.dir){if(!request.directories.some(dir=>portableFold(dir)===portableFold(name)))migrationCapsuleFail('portable_source');}
        else{const row=input.files.get(portableFold(name)),stream=entry.streams.find(stream=>stream.name==='');if(!row||!stream||stream.hash!==hash(row.data)||stream.size!==row.data.length)migrationCapsuleFail('portable_source');}}
      if(fileRows.some(row=>!paths.has(portableFold(row.path)))||request.directories.some(dir=>portableFold(dir).startsWith(portableFold(relative)+'/')&&!paths.has(portableFold(dir))))migrationCapsuleFail('portable_source');
      nativeEvidence.push({path:relative,snapshot});return snapshot;
    };
    const provenanceRefs=async(snapshot,slot,anchor)=>{
      for(const entry of snapshot.entries)if(portableFold(entry.rel)===portableFold(SKILL_IMPORT_RECORD)){
        const stream=entry.streams.find(row=>row.name==='');if(entry.dir||!stream)migrationCapsuleFail('portable_history');const bytes=Buffer.from(stream.data,'base64');
        try{const opened=await input.read({path:anchor,data:bytes},{purpose:'backup',schema:1,scopeId:'skills',recordId:'skill-import:'+portableFold(slot.skillId),chunked:true,maxPlaintextBytes:16*1024});if(!opened||typeof opened.text!=='string'||!importShape(opened.text))migrationCapsuleFail('portable_provenance');}finally{bytes.fill(0);}
      }
    };
    const originals=[],terminalCapsules=[],rawTrees=[],originalByRef=new Map(),liveTrees=new Map(),originalSources=new Map();
    for(const row of [...remaining.values()]){
      const match=originalPattern.exec(row.path);if(!match)continue;const stamp=match[1],skillId=match[2],wrapper=row.path.slice(0,row.path.lastIndexOf('/')),slot={stamp,skillId},source=descriptor(path.join(sourceBase,...wrapper.split('/').slice(0,-2)),stamp,skillId),marker=take(row.path),backupRef=ref(stamp,skillId,catalog?.value.storeId||'0'.repeat(48));
      const archive=await read(wrapper+'/archive','capsule-archive',source.recordId+':archive',value=>value&&Object.keys(value).sort().join(',')==='data,encoding'&&value.encoding==='gzip-base64-v1'&&typeof value.data==='string',{scopeId:source.scopeId});
      const zipped=Buffer.from(archive.value.data,'base64');let snapshot;try{if(zipped.toString('base64')!==archive.value.data)migrationCapsuleFail('portable_archive');snapshot=migrationCapsuleDecode(zipped);}finally{zipped.fill(0);}if(!migrationCapsulePortableShape(snapshot))migrationCapsuleFail('portable_snapshot_owner_required');archive.value=snapshot;
      const intent=await read(wrapper+'/intent','capsule-intent',source.recordId+':intent',value=>migrationCapsuleIntentShape(value,source),{scopeId:source.scopeId});
      if(!['published','complete','aborted'].includes(intent.value.phase)||intent.value.revision!==snapshot.revision||intent.value.oldRoot!==rootId(snapshot))migrationCapsuleFail('portable_original_capsule_required');
      const selectedEntry=activeBinding?.value.entries.find(entry=>entry.ref.backupId===backupRef.backupId&&entry.ref.stamp===stamp&&entry.ref.skillId===portableFold(skillId));
      let selectedIntent=intent;
      if(selectedEntry){
        if(selectedEntry.kind!==undefined||selectedEntry.physicalSkillId!==skillId)migrationCapsuleFail('portable_binding');
        const relative=controlPrefix+'/intents/'+authority.id+'/'+backupRef.backupId+'.sealed',variant={...source,generationId:authority.id};
        if(!remaining.has(portableFold(relative)))migrationCapsuleFail('portable_binding');
        selectedIntent=await read(relative,'capsule-intent',source.recordId+':intent:'+authority.id,value=>migrationCapsuleIntentShape(value,variant),{scopeId:source.scopeId});
        if(!['published','complete','aborted'].includes(selectedIntent.value.phase)||selectedIntent.value.revision!==snapshot.revision||selectedIntent.value.oldRoot!==rootId(snapshot))migrationCapsuleFail('portable_binding');
      }
      const terminal=['complete','aborted'].includes(selectedIntent.value.phase)?selectedIntent.value.phase:null;
      if(!terminal&&intent.value.phase!=='published'||terminal&&intent.value.phase!=='published'&&intent.value.phase!==terminal)migrationCapsuleFail('portable_binding');
      await provenanceRefs(snapshot,slot,archive.path);const objects=wrapper+'/objects';dir(objects);
      const physical=await evidenceFor(objects,hash('portable-objects:'+wrapper));
      if(physical.entries.some(entry=>entry.rel===''?entry.streams.length!==0:entry.streams.some(stream=>stream.name!=='')))migrationCapsuleFail('portable_native_streams');
      if(terminal){if(physical.entries.length!==1||physical.entries[0].rel!==''||!physical.entries[0].dir||physical.entries[0].streams.length)migrationCapsuleFail('portable_terminal_objects');}
      else if(physical.entries.length!==snapshot.entries.length+1)migrationCapsuleFail('portable_objects');
      for(const original of terminal?[]:snapshot.entries){const opaque=objects+'/'+original.opaque,current=physical.entries.find(entry=>entry.rel===original.opaque);
        if(!current||current.id!==original.id||current.dir!==original.dir||current.streams.some(stream=>stream.name!==''||stream.size!==0))migrationCapsuleFail('portable_objects');
        if(original.dir)dir(opaque);else if(take(opaque).data.length)migrationCapsuleFail('portable_objects');
      }
      if(terminal){const restored=wrapper+'/restored';if(input.dirs.has(portableFold(restored))){dir(restored);const empty=await evidenceFor(restored,hash('portable-terminal-restored:'+wrapper));if(empty.entries.length!==1||empty.entries[0].rel!==''||!empty.entries[0].dir||empty.entries[0].streams.length)migrationCapsuleFail('portable_terminal_objects');}}
      const livePrefix=authority.id?'.work-data/generations/'+authority.id+'/':'',liveName=livePrefix+'skills/'+skillId;let live=null;
      if(request.directories.some(name=>portableFold(name)===portableFold(liveName))){const actualName=request.directories.find(name=>portableFold(name)===portableFold(liveName));if(!liveTrees.has(portableFold(actualName))){live=await evidenceFor(actualName,hash('portable-live:'+actualName));await provenanceRefs(live,slot,archive.path);liveTrees.set(portableFold(actualName),{path:actualName,snapshot:live});}else live=liveTrees.get(portableFold(actualName)).snapshot;}
      let eligibility=terminal?'terminal':selectedIntent.value.conversion?.eligibility;if(!terminal&&!['edited','gone'].includes(eligibility))eligibility=live&&migrationCapsuleSame(live,selectedIntent.value.newTree)?'eligible':live?'edited':'gone';
      const original={wrapper,stamp,skillId,backupId:backupRef.backupId,archive:archive.path,intent:intent.path,marker:{path:marker.path,sha256:hash(marker.data)},live:live?liveName:null,eligibility,...(terminal?{phase:terminal}:{})};
      if(originalByRef.has(stamp+'/'+portableFold(skillId)))migrationCapsuleFail('portable_binding');originalByRef.set(stamp+'/'+portableFold(skillId),original);originalSources.set(original,{snapshot,live});(terminal?terminalCapsules:originals).push(original);ancestors(wrapper);
    }
    // Whole raw legacy backups are user trees, not capsule/control records.
    // Their actual native owner snapshot authenticates the complete namespace
    // against captured default bytes; preserved user streams stay in the aux.
    const rawPattern=new RegExp('^((?:\\.work-data/generations/[a-f0-9]{48}/)?migrations/skill-backups|\\.work-data/skill-backups/objects-v1)/([0-9TZ-]+)/([A-Za-z0-9_-]{1,64})$',process.platform==='win32'?'i':'');
    for(const wrapper of input.dirs.values()){
      const match=rawPattern.exec(wrapper);if(!match||input.files.has(portableFold(wrapper+'/.ruyi-capsule-v1'))||input.files.has(portableFold(wrapper+'/'+MIGRATION_BACKUP_HISTORY_MARKER))||!input.files.has(portableFold(wrapper+'/SKILL.md')))continue;
      const stamp=match[2],skillId=match[3],snapshot=await evidenceFor(wrapper,hash('portable-raw:'+wrapper));
      if(!snapshot.entries.some(entry=>!entry.dir&&portableFold(entry.rel)===portableFold('SKILL.md')))migrationCapsuleFail('portable_raw_shape');
      await provenanceRefs(snapshot,{stamp,skillId},wrapper+'/'+SKILL_IMPORT_RECORD);
      for(const entry of snapshot.entries){const name=entry.rel?wrapper+'/'+entry.rel:wrapper;if(entry.dir)dir(name);else take(name);}
      ancestors(wrapper);rawTrees.push({path:wrapper,wrapper,stamp,skillId,snapshot});
      const prefix=portableFold(match[1]).startsWith('.work-data/skill-backups/')?(authority.id?'.work-data/generations/'+authority.id+'/':''):match[1].slice(0,-'migrations/skill-backups'.length),liveName=prefix+'skills/'+skillId,actualName=request.directories.find(name=>portableFold(name)===portableFold(liveName));
      if(actualName&&!liveTrees.has(portableFold(actualName))){const live=await evidenceFor(actualName,hash('portable-live:'+actualName));await provenanceRefs(live,{stamp,skillId},actualName+'/'+SKILL_IMPORT_RECORD);liveTrees.set(portableFold(actualName),{path:actualName,snapshot:live});}
    }
    // Settled representation records retain their authenticated history. They
    // do not authorize a conversion replay or instantiate historical objects.
    const settledRepresentations=[],retainedCapsules=[],plainBackups=[];
    const recordPattern=new RegExp('^\\.work-data/skill-backups/representations-v1/([a-f0-9]{48})/([a-f0-9]{64})/record-v1\\.sealed$',process.platform==='win32'?'i':'');
    const retainedByPath=new Map();
    const historicalHistory=async(wrapper,slot)=>{
      const marker=take(wrapper+'/'+MIGRATION_BACKUP_HISTORY_MARKER),header=safeJsonParse(marker.data.toString('utf8'),null);
      if(!exact(header,'schema,mode')||header.schema!==1||!['plain','encrypted'].includes(header.mode))migrationCapsuleFail('portable_history');
      const d={...slot,id:slot.skillId,recordId:'skill-backup:'+portableFold(slot.skillId)},binding=migrationBackupHistoryBinding(d),history=await read(wrapper+'/history','history',binding.recordId,payload=>migrationBackupHistoryShape(payload,d),{scopeId:binding.scopeId,mode:header.mode});
      await provenanceRefs(history.value.snapshot,slot,history.path);dir(wrapper);ancestors(wrapper);return history;
    };
    const emptyPortable=async name=>{
      if(!input.dirs.has(portableFold(name)))return;
      dir(name);ancestors(name);const proof=await evidenceFor(name,hash('portable-empty:'+name));
      if(proof.entries.length!==1||!proof.entries[0].dir||proof.entries[0].rel!==''||proof.entries[0].streams.length)migrationCapsuleFail('portable_representation_unsettled');
    };
    const historicalCapsule=async(wrapper,slot,{plain=false,generationId=null}={})=>{
      if(retainedByPath.has(portableFold(wrapper)))return retainedByPath.get(portableFold(wrapper));
      const d=descriptor(stableRoot,slot.stamp,slot.skillId),archive=await read(wrapper+'/archive','capsule-archive',d.recordId+':archive',value=>exact(value,'encoding,data')&&value.encoding==='gzip-base64-v1'&&typeof value.data==='string',{scopeId:d.scopeId});
      const zipped=Buffer.from(archive.value.data,'base64');let snapshot;try{if(zipped.toString('base64')!==archive.value.data)migrationCapsuleFail('portable_archive');snapshot=migrationCapsuleDecode(zipped);}finally{zipped.fill(0);}
      if(!migrationCapsulePortableShape(snapshot))migrationCapsuleFail('portable_snapshot_owner_required');archive.value=snapshot;archive.kind=plain?'plain-archive':'representation-archive';
      const intentId=d.recordId+':intent'+(generationId?':'+generationId:''),intent=await read(wrapper+'/intent','capsule-intent',intentId,value=>migrationCapsuleIntentShape(value,{...d,...(plain?{plainRoot:path.join(sourceBase,...(controlPrefix+'/objects-v1/'+slot.stamp+'/'+slot.skillId).split('/'))}:{}),...(generationId?{generationId}:{})}),{scopeId:d.scopeId});intent.kind=plain?'plain-intent':'representation-intent';
      if(!['published','complete','aborted'].includes(intent.value.phase)||intent.value.revision!==snapshot.revision||intent.value.oldRoot!==rootId(snapshot))migrationCapsuleFail('portable_representation_unsettled');
      if(!plain){const marker=take(wrapper+'/'+MIGRATION_CAPSULE_MARKER);if(!exact(safeJsonParse(marker.data.toString('utf8'),null),'version')||safeJsonParse(marker.data.toString('utf8'),null).version!==1)migrationCapsuleFail('portable_shape');}
      dir(wrapper);await emptyPortable(wrapper+'/objects');await emptyPortable(wrapper+'/restored');ancestors(wrapper);await provenanceRefs(snapshot,slot,archive.path);
      const value={wrapper,stamp:slot.stamp,skillId:slot.skillId,backupId:hash(slot.stamp+'/'+portableFold(slot.skillId)),archive:archive.path,intent:intent.path,generationId,snapshot,phase:intent.value.phase,plain};
      retainedByPath.set(portableFold(wrapper),value);if(!plain)retainedCapsules.push(value);return value;
    };
    for(const file of [...remaining.values()]){
      const match=recordPattern.exec(file.path);if(!match)continue;const operationId=portableFold(match[1]),backupId=portableFold(match[2]),anchor=file.path.slice(0,-'/record-v1.sealed'.length);
      const record=await read(file.path,'representation-record','representation:'+operationId+':'+backupId,representationRecordValid),value=record.value;
      if(value.operationId!==operationId||backupId!==hash(value.stamp+'/'+portableFold(value.skillId))||!['forward','canceled'].includes(value.phase))migrationCapsuleFail('portable_representation_unsettled');
      const slot={stamp:value.stamp,skillId:value.skillId};await provenanceRefs(value.original,slot,record.path);await provenanceRefs(value.target,slot,record.path);
      const row={path:record.path,anchor,operationId,backupId,stamp:value.stamp,skillId:value.skillId,archive:null,intent:null};
      if(input.dirs.has(portableFold(anchor+'/capsule'))){
        if(input.files.has(portableFold(anchor+'/capsule/'+MIGRATION_BACKUP_HISTORY_MARKER)))await historicalHistory(anchor+'/capsule',slot);
        else{const carrier=await historicalCapsule(anchor+'/capsule',slot);row.archive=carrier.archive;row.intent=carrier.intent;}
      }
      if(input.dirs.has(portableFold(anchor+'/history'))){
        await historicalHistory(anchor+'/history',slot);
      }
      if(remaining.has(portableFold(anchor+'/import-target.sealed'))){
        const row=take(anchor+'/import-target.sealed'),target=value.target.entries.find(entry=>portableFold(entry.rel)===portableFold(SKILL_IMPORT_RECORD)),stream=target?.streams.find(stream=>stream.name==='');
        if(!stream||stream.hash!==hash(row.data)||stream.size!==row.data.length)migrationCapsuleFail('portable_provenance');
        const opened=await input.read(row,{purpose:'backup',schema:1,scopeId:'skills',recordId:'skill-import:'+portableFold(slot.skillId),chunked:true,maxPlaintextBytes:16*1024});
        if(!opened||typeof opened.text!=='string'||!importShape(opened.text)||!opened.authenticated)migrationCapsuleFail('portable_provenance');
        records.push({path:row.path,kind:'representation-provenance',recordId:'skill-import:'+portableFold(slot.skillId),scopeId:'skills',mode:'encrypted',value:opened.text});
      }
      dir(anchor);ancestors(anchor);await emptyPortable(anchor+'/restored');await evidenceFor(anchor,hash('portable-representation:'+anchor));settledRepresentations.push(row);
    }
    if(settledRepresentations.length&&!representation)migrationCapsuleFail('portable_representation_missing');
    if(representation?.value.entries.length){
      if(!catalog||representation.value.storeId!==catalog.value.storeId)migrationCapsuleFail('portable_store');
      const current=representation.value.phase==='kept'?representation.value.targetId:representation.value.sourceId;
      if(current!==authority.id&&!activeBinding?.value.sourceRootIds.includes(current)||representation.value.phase==='kept'&&representation.value.mode!==authority.mode
        ||representation.value.phase==='canceled'&&representation.value.sourceId===authority.id&&representation.value.sourceProof!==authority.sha256)migrationCapsuleFail('portable_representation_authority');
      for(const entry of representation.value.entries){const row=settledRepresentations.find(row=>row.operationId===representation.value.operationId&&row.backupId===entry.backupId&&row.stamp===entry.stamp&&row.skillId===entry.skillId);
        if(!row)migrationCapsuleFail('portable_representation_missing');const record=records.find(record=>record.path===row.path).value;
        if(record.phase!==(representation.value.phase==='kept'?'forward':'canceled'))migrationCapsuleFail('portable_representation_unsettled');
      }
    }
    for(const binding of bindings)for(const entry of binding.value.entries.filter(entry=>entry.kind==='plain')){
      const wrapper=controlPrefix+'/plain-v1/'+binding.value.generationId+'/'+entry.ref.backupId,slot={stamp:entry.ref.stamp,skillId:entry.physicalSkillId},carrier=await historicalCapsule(wrapper,slot,{plain:true,generationId:binding.value.generationId});
      if(entry.ref.backupId!==carrier.backupId||entry.archiveSha!==hash(input.files.get(portableFold(carrier.archive)).data)||entry.intentSha!==hash(input.files.get(portableFold(carrier.intent)).data)&&carrier.phase!=='complete')migrationCapsuleFail('portable_binding');
      const intent=records.find(row=>row.path===carrier.intent).value;
      if(intent.conversion?.eligibility!==entry.eligibility||entry.newTree&&portableJSON(entry.newTree)!==portableJSON(intent.newTree))migrationCapsuleFail('portable_binding');
      const physical=controlPrefix+'/objects-v1/'+slot.stamp+'/'+slot.skillId,liveName=(authority.id?'.work-data/generations/'+authority.id+'/':'')+'skills/'+slot.skillId,live=liveTrees.get(portableFold(liveName))||null;
      const current=binding.value.generationId===authority.id,raw=rawTrees.find(row=>portableFold(row.path)===portableFold(physical)),history=histories.get(slot.stamp+'/'+portableFold(slot.skillId));
      if(current&&intent.phase==='published'&&(!raw||!migrationCapsuleSameMetadata(raw.snapshot,carrier.snapshot)))migrationCapsuleFail('portable_plain_changed');
      if(current&&intent.phase==='complete'&&(!history||history.history.value.phase!=='complete'||portableJSON(history.history.value.snapshot)!==portableJSON(carrier.snapshot)))migrationCapsuleFail('portable_plain_changed');
      plainBackups.push({...carrier,physical,live:live?.path||null,eligibility:intent.phase!=='published'?'terminal':!current?'edited':!live?'gone':entry.eligibility==='eligible'&&migrationCapsuleSame(live.snapshot,intent.newTree)?'eligible':entry.eligibility==='gone'?'gone':'edited'});
    }
    for(const row of [...remaining.values()]){
      const match=new RegExp('^\\.work-data/skill-backups/plain-v1/([a-f0-9]{48})/([a-f0-9]{64})/archive$',process.platform==='win32'?'i':'').exec(row.path);if(!match)continue;
      const binding=bindings.find(row=>row.value.generationId===portableFold(match[1])),entry=binding?.value.entries.find(entry=>entry.ref.backupId===portableFold(match[2])&&entry.kind==='history');if(!entry)migrationCapsuleFail('portable_binding');
      const slot={stamp:entry.ref.stamp,skillId:entry.physicalSkillId},carrier=await historicalCapsule(row.path.slice(0,-'/archive'.length),slot,{plain:true,generationId:binding.value.generationId});
      if(carrier.phase!=='complete')migrationCapsuleFail('portable_representation_unsettled');
      plainBackups.push({...carrier,physical:controlPrefix+'/objects-v1/'+slot.stamp+'/'+slot.skillId,live:null,eligibility:'terminal'});
    }
    for(const slot of plainBackups)if(slot.phase==='complete'){
      await emptyPortable(slot.wrapper+'/history-stage');const intent=records.find(row=>row.path===slot.intent).value,publish=intent.historyPublish;if(!publish)migrationCapsuleFail('portable_plain_changed');
      const history=records.find(row=>row.kind==='history'&&portableJSON(row.value.snapshot)===portableJSON(slot.snapshot));if(!history)migrationCapsuleFail('portable_plain_changed');
      const relative=history.path.slice(0,history.path.lastIndexOf('/')),proof=nativeEvidence.find(row=>portableFold(row.path)===portableFold(relative))?.snapshot||await evidenceFor(relative,hash('portable-plain-history:'+relative));if(rootId(proof)!==publish.id)migrationCapsuleFail('portable_plain_changed');slot.historyPublishPath=relative;
    }
    // Every retained generation variant is also source provenance, including
    // intents referenced by old representation records but no current binding.
    for(const row of [...remaining.values()]){
      const match=new RegExp('^\\.work-data/skill-backups/intents/([a-f0-9]{48})/([a-f0-9]{64})\\.sealed$',process.platform==='win32'?'i':'').exec(row.path);if(!match)continue;
      const slot=settledRepresentations.find(slot=>slot.backupId===portableFold(match[2]));if(!slot)continue;const d=descriptor(stableRoot,slot.stamp,slot.skillId);
      const intent=await read(row.path,'capsule-intent',d.recordId+':intent:'+portableFold(match[1]),value=>migrationCapsuleIntentShape(value,{...d,generationId:portableFold(match[1])}),{scopeId:d.scopeId});intent.kind='representation-variant';
      if(!['published','complete','aborted'].includes(intent.value.phase)||!records.some(record=>['capsule-archive','representation-archive','plain-archive'].includes(record.kind)&&record.value.revision===intent.value.revision&&rootId(record.value)===intent.value.oldRoot))migrationCapsuleFail('portable_binding');
    }
    for(const row of settledRepresentations){
      const record=records.find(record=>record.path===row.path).value,archiveCandidates=records.filter(item=>['capsule-archive','representation-archive','plain-archive','history'].includes(item.kind)&&hash(input.files.get(portableFold(item.path)).data)===record.archiveSha),intentCandidates=records.filter(item=>['capsule-intent','representation-intent','plain-intent','representation-variant'].includes(item.kind)&&hash(input.files.get(portableFold(item.path)).data)===record.intentSha);
      if(record.oldType==='history'){
        const marker=[...input.files.values()].find(file=>hash(file.data)===record.intentSha&&file.path.endsWith('/'+MIGRATION_BACKUP_HISTORY_MARKER));if(!marker||!archiveCandidates.length)migrationCapsuleFail('portable_representation_carrier');row.archive=archiveCandidates[0].path;row.intent=marker.path;
      }else{
        if(!archiveCandidates.length||!intentCandidates.length)migrationCapsuleFail('portable_representation_carrier');row.archive=archiveCandidates[0].path;row.intent=intentCandidates[0].path;
        const snapshot=archiveCandidates[0].value;if(portableJSON(snapshot)!==portableJSON(record.oldType==='plain'?record.target:record.original))migrationCapsuleFail('portable_representation_carrier');
      }
      if(record.sourceGenerationId&&row.intent!==controlPrefix+'/intents/'+record.sourceGenerationId+'/'+row.backupId+'.sealed')migrationCapsuleFail('portable_binding');
      for(const relative of [row.archive.slice(0,row.archive.lastIndexOf('/')),...(record.oldType==='history'?[row.intent.slice(0,row.intent.lastIndexOf('/'))]:[])])
        if(!nativeEvidence.some(proof=>portableFold(proof.path)===portableFold(relative)))await evidenceFor(relative,hash('portable-carrier:'+relative));
      const carrierProof=nativeEvidence.find(proof=>portableFold(proof.path)===portableFold(row.archive.slice(0,row.archive.lastIndexOf('/'))));
      if(!carrierProof||rootId(carrierProof.snapshot)!==record.capsuleId)migrationCapsuleFail('portable_representation_identity');
      if(record.historyId){
        let targetProof=null;
        for(const history of records.filter(item=>item.kind==='history'&&portableJSON(item.value.snapshot)===portableJSON(record.target))){
          const relative=history.path.slice(0,history.path.lastIndexOf('/')),proof=nativeEvidence.find(proof=>portableFold(proof.path)===portableFold(relative))?.snapshot||await evidenceFor(relative,hash('portable-carrier:'+relative));
          if(rootId(proof)===record.historyId)targetProof=proof;
        }
        if(!targetProof||!migrationCapsuleSame(targetProof,record.historyTree))migrationCapsuleFail('portable_representation_identity');
      }
    }
    for(const slot of settledRepresentations){
      const liveName=(authority.id?'.work-data/generations/'+authority.id+'/':'')+'skills/'+slot.skillId,actualName=request.directories.find(name=>portableFold(name)===portableFold(liveName));
      if(actualName&&!liveTrees.has(portableFold(actualName))){const snapshot=await evidenceFor(actualName,hash('portable-live:'+actualName));await provenanceRefs(snapshot,slot,actualName+'/'+SKILL_IMPORT_RECORD);liveTrees.set(portableFold(actualName),{path:actualName,snapshot});}
    }

    // Each bound generation owns a mandatory authenticated intent. Physical
    // intent bytes are archive provenance, not the selected generation's live
    // identity authority after prepareBindings copied its replacement tree.
    const linkedVariant=async(original,entry,generationId)=>{
      const source=descriptor(stableRoot,original.stamp,original.skillId),relative=controlPrefix+'/intents/'+generationId+'/'+entry.ref.backupId+'.sealed',variant={...source,generationId};
      let record=records.find(row=>portableFold(row.path)===portableFold(relative));
      if(!record){if(!remaining.has(portableFold(relative)))migrationCapsuleFail('portable_binding');record=await read(relative,'capsule-intent',source.recordId+':intent:'+generationId,value=>migrationCapsuleIntentShape(value,variant),{scopeId:source.scopeId});}
      const snapshot=originalSources.get(original).snapshot;
      if(!['capsule-intent','representation-variant'].includes(record.kind)||record.recordId!==source.recordId+':intent:'+generationId||record.scopeId!==source.scopeId
        ||!migrationCapsuleIntentShape(record.value,variant)||!(original.phase?['published',original.phase].includes(record.value.phase):record.value.phase==='published')||record.value.revision!==snapshot.revision||record.value.oldRoot!==rootId(snapshot))migrationCapsuleFail('portable_binding');
      return record;
    };
    for(const binding of bindings){const seen=new Set();for(const entry of binding.value.entries){
      if(seen.has(entry.ref.backupId))migrationCapsuleFail('portable_binding');seen.add(entry.ref.backupId);if(['history','plain'].includes(entry.kind))continue;
      const original=[...originals,...terminalCapsules,...retainedCapsules].find(row=>row.stamp===entry.ref.stamp&&portableFold(row.skillId)===entry.ref.skillId&&hash(input.files.get(portableFold(row.archive)).data)===entry.archiveSha);if(original&&!originalSources.has(original))originalSources.set(original,{snapshot:original.snapshot,live:null});if(!original||entry.physicalSkillId!==original.skillId||entry.kind!==undefined||!(original.phase?['published',original.phase].includes(entry.phase):entry.phase==='published'))migrationCapsuleFail('portable_original_capsule_required');
      const variant=await linkedVariant(original,entry,binding.value.generationId);
      if(!(original.phase?['terminal','eligible','edited','gone']:['eligible','edited','gone']).includes(entry.eligibility)||entry.eligibility==='eligible'&&portableJSON(entry.newTree)!==portableJSON(variant.value.newTree)
        ||entry.eligibility!=='eligible'&&entry.newTree!==null||['edited','gone'].includes(variant.value.conversion?.eligibility)&&entry.eligibility!==variant.value.conversion.eligibility)migrationCapsuleFail('portable_binding');
      if(entry.sourceGenerationId){if(!binding.value.sourceRootIds.includes(entry.sourceGenerationId))migrationCapsuleFail('portable_binding');await linkedVariant(original,entry,entry.sourceGenerationId);}
      const sourceIntent=entry.sourceGenerationId?controlPrefix+'/intents/'+entry.sourceGenerationId+'/'+entry.ref.backupId+'.sealed':original.intent;
      if(entry.archiveSha!==hash(input.files.get(portableFold(original.archive)).data)||entry.intentSha!==hash(input.files.get(portableFold(sourceIntent))?.data||Buffer.alloc(0)))migrationCapsuleFail('portable_binding');
      if(!original.phase&&binding.value.generationId===authority.id){const live=originalSources.get(original).live;original.eligibility=!live?'gone':entry.eligibility!=='eligible'?entry.eligibility:migrationCapsuleSame(live,variant.value.newTree)?'eligible':'edited';}
    }}
    const logPattern=new RegExp('^(?:\\.work-data/generations/[a-f0-9]{48}/)?migrations/[0-9TZ-]+\\.json$',process.platform==='win32'?'i':'');
    for(const row of request.files){
      if(!logPattern.test(row.path))continue;const logical=row.path.replace(new RegExp('^\\.work-data/generations/[a-f0-9]{48}/',process.platform==='win32'?'i':''),''),binding=WorkDataMigrationCodecs.describe(logical),opened=await input.read(row,binding);
      if(!opened||typeof opened.text!=='string')migrationCapsuleFail('portable_log');const text=opened.text,bom=text.startsWith('\uFEFF')?'\uFEFF':'',clean=text.slice(bom.length),value=safeJsonParse(clean,null);if(!value||!Array.isArray(value.files))continue;
      const rewrites=[];
      for(const [index,file]of value.files.entries()){
        if(!file||file.kind!=='skill-copy'||typeof file.backup!=='string')continue;const original=[...originals,...terminalCapsules,...rawTrees,...plainBackups.filter(row=>row.phase==='complete').map(row=>({...row,wrapper:row.physical})),...settledRepresentations.filter(row=>histories.has(row.stamp+'/'+portableFold(row.skillId))).map(row=>({...row,wrapper:histories.get(row.stamp+'/'+portableFold(row.skillId)).wrapper}))].find(original=>eq(file.backup,path.join(sourceBase,...original.wrapper.split('/')))||settledRepresentations.length&&eq(file.backup,path.join(sourceBase,'migrations','skill-backups',original.stamp,original.skillId)));if(!original)continue;
        if(!Array.isArray(file.items)||file.items.length!==1||file.items[0]?.id!==original.skillId||typeof file.file!=='string'||!path.isAbsolute(file.file))migrationCapsuleFail('portable_log');
        const relative=path.relative(sourceBase,file.file).split(path.sep).join('/'),allowed=['skills/'+original.skillId,...bindings.flatMap(row=>[row.value.generationId,...row.value.sourceRootIds.filter(Boolean)].map(id=>'.work-data/generations/'+id+'/skills/'+original.skillId))];
        if(!allowed.some(name=>portableFold(name)===portableFold(relative)))migrationCapsuleFail('portable_log');rewrites.push({index,file:relative,backup:original.wrapper});
      }
      if(!rewrites.length)continue;let format=null;
      for(const indent of [null,2])for(const ending of ['','\n','\r\n'])if(JSON.stringify(value,null,indent)+ending===clean)format={indent,ending,bom};
      if(!format)migrationCapsuleFail('portable_log_owner_required');
      records.push({path:row.path,kind:'migration-log',recordId:binding.recordId,scopeId:binding.scopeId,purpose:binding.purpose,mode:opened.authenticated?'encrypted':'plain',value,format,rewrites});
    }

    if(providedEvidence&&nativeEvidence.length!==providedEvidence.size)migrationCapsuleFail('portable_native_evidence');
    nativeEvidence.sort((a,b)=>portableSort(a.path,b.path));originals.sort((a,b)=>portableSort(a.wrapper,b.wrapper));terminalCapsules.sort((a,b)=>portableSort(a.wrapper,b.wrapper));rawTrees.sort((a,b)=>portableSort(a.path,b.path));

    for(const binding of bindings)for(const entry of binding.value.entries.filter(entry=>entry.kind==='history')){const history=histories.get(entry.ref.stamp+'/'+entry.ref.skillId);if(!history||entry.physicalSkillId!==history.skillId||entry.phase!==history.history.value.phase||entry.historyMode!==history.history.mode||entry.archiveSha!==hash(input.files.get(portableFold(history.history.path)).data)||entry.intentSha!==history.marker.sha256)migrationCapsuleFail('portable_binding');}
    if(remaining.size)migrationCapsuleFail([...remaining.keys()].some(name=>/(?:\/.ruyi-capsule-v1$|\/archive$|\/intent$|\/objects\/|\/plain-v1\/|\/intents\/|\/representations-v1\/)/.test(name))?'portable_original_capsule_required':'portable_unknown');
    for(const name of input.dirs.values())if(!claimedDirectories.has(portableFold(name))){
      // Empty fixed control ancestors preserve names without granting authority.
      if(new RegExp('^\\.work-data/skill-backups/(?:intents|plain-v1|representations-v1)(?:/[a-f0-9]{48}){0,2}$',process.platform==='win32'?'i':'').test(name))claimedDirectories.add(portableFold(name));
      else migrationCapsuleFail('portable_unknown');
    }
    records.sort((a,b)=>portableSort(a.path,b.path));
    return {schema:1,type:'skill-backup-portable',sourceBase,source:{sourcePath:input.source.sourcePath,sourceSha256:input.source.sourceSha256},authority,records,...(originals.length||terminalCapsules.length||rawTrees.length||settledRepresentations.length?{originals,...(settledRepresentations.length||retainedCapsules.length||plainBackups.length?{settledRepresentations,retainedCapsules,plainBackups}:{}),...(terminalCapsules.length?{terminalCapsules}:{}),...(rawTrees.length?{rawTrees}:{}),nativeEvidence,liveTrees:[...liveTrees.values()].sort((a,b)=>portableSort(a.path,b.path))}:{}),
      profile:{originalObjects:originals.length||terminalCapsules.length||rawTrees.length||settledRepresentations.length?'new-owned-portable':'refused',terminalSnapshots:'source-history-only',nativeStreams:rawTrees.length?'enumerated-user-streams':'enumerated-default-only',destinationSecurity:'inherited; no source ACL replay'}};
  }
  async function capturePortable(request) {
    if(base.length>4096)migrationCapsuleFail('portable_capacity');
    const selected=await active(),expected=request?.expected;
    if(!expected?.proof||selected.proof.raw!==expected.proof.raw||selected.proof.sha256!==expected.proof.sha256)migrationCapsuleFail('generation_changed');
    const value=await collectPortable(request,base);
    if(value.authority.raw!==selected.proof.raw||value.authority.sha256!==selected.proof.sha256)migrationCapsuleFail('portable_authority');
    const input=portableInput(request),roots=new Set();
    for(const name of input.dirs.values())if(portableFold(name)==='.work-data/skill-backups'
      ||new RegExp('^(?:\\.work-data/generations/[a-f0-9]{48}/)?migrations/skill-backups$',process.platform==='win32'?'i':'').test(name))roots.add(name);
    for(const row of input.scoped.values())if(/\/migrations\/skill-backup-bindings-v2\.sealed$/i.test(row.path))roots.add(row.path.slice(0,row.path.lastIndexOf('/')));
    for(const name of roots){
      const absolute=path.join(base,...name.split('/')),snapshot=await portableCapture(absolute,hash(request.source.sourceSha256+':'+name));
      const insideRaw=entry=>(value.rawTrees||[]).some(row=>portableFold(name+'/'+entry.rel)===portableFold(row.path)||portableFold(name+'/'+entry.rel).startsWith(portableFold(row.path)+'/'));
      if(!migrationCapsuleShape(snapshot)||snapshot.entries.some(entry=>!insideRaw(entry)&&entry.streams.some(stream=>stream.name!=='')))migrationCapsuleFail('portable_native_streams');
      if(value.settledRepresentations?.length||value.plainBackups?.length)for(const proof of value.nativeEvidence){
        if(portableFold(proof.path)!==portableFold(name)&&!portableFold(proof.path).startsWith(portableFold(name)+'/'))continue;
        const prefix=proof.path.slice(name.length).replace(/^\//,'');
        for(const expected of proof.snapshot.entries){
          const relative=prefix+(prefix&&expected.rel?'/':'')+expected.rel,actual=snapshot.entries.find(entry=>portableFold(entry.rel)===portableFold(relative));
          if(!actual)migrationCapsuleFail('portable_source');const {rel:a,opaque:actualTransport,...actualMetadata}=actual,{rel:b,opaque:expectedTransport,...expectedMetadata}=expected;
          if(portableJSON(actualMetadata)!==portableJSON(expectedMetadata))migrationCapsuleFail('portable_native_changed');
        }
      }

      const expectedFiles=[...input.files.values()].filter(row=>portableFold(row.path).startsWith(portableFold(name)+'/'));
      const actual=snapshot.entries.filter(entry=>!entry.dir);if(actual.length!==expectedFiles.length)migrationCapsuleFail('portable_source');
      for(const entry of actual){const row=input.files.get(portableFold(name+'/'+entry.rel));const stream=entry.streams.find(item=>item.name==='');if(!row||!stream||!insideRaw(entry)&&entry.streams.length!==1||stream.hash!==hash(row.data)||stream.size!==row.data.length)migrationCapsuleFail('portable_source');}
      if(portableFold(name)==='.work-data/skill-backups'&&value.records.some(row=>row.kind==='catalog')){
        const catalog=value.records.find(row=>row.kind==='catalog').value,info=await platform.info(stableRoot);
        if(info.id!==catalog.rootId||info.volume!==catalog.volume)migrationCapsuleFail('store_identity');
      }
    }
    await current(selected);const data=Buffer.from(portableJSON(value));let released=false;
    return Object.freeze({type:'skill-backup-portable',schema:1,sourcePath:request.source.sourcePath,sourceSha256:request.source.sourceSha256,data,
      profile:Object.freeze({...value.profile}),release(){if(!released){released=true;data.fill(0);}}});
  }
  async function validatePortable({data,...request}={}) {
    if(!Buffer.isBuffer(data)||data.length<1||data.length>256*1024*1024)migrationCapsuleFail('portable_shape');
    const text=data.toString('utf8');if(!Buffer.from(text).equals(data))migrationCapsuleFail('portable_shape');const value=safeJsonParse(text,null);
    const optional=['originals','terminalCapsules','rawTrees','nativeEvidence','liveTrees','settledRepresentations','retainedCapsules','plainBackups'],mandatory=['schema','type','sourceBase','source','authority','records','profile'];
    if(!value||mandatory.some(name=>!Object.hasOwn(value,name))||Object.keys(value).some(name=>!mandatory.includes(name)&&!optional.includes(name))||value.schema!==1||value.type!=='skill-backup-portable'
      ||typeof value.sourceBase!=='string'||value.sourceBase.length>4096||!path.isAbsolute(value.sourceBase)||path.resolve(value.sourceBase)!==value.sourceBase)migrationCapsuleFail('portable_shape');
    const collected=await collectPortable(request,value.sourceBase,value.nativeEvidence);
    if(portableJSON(collected)!==text)migrationCapsuleFail('portable_binding');
    return portableClone(collected);
  }
  async function stagePortableOriginals({target,keysFor,assertTargetExclusive,targetOwnership,assertTargetExclusiveSync,request,value}) {
    if(typeof conversionNative.createOwnedPortable!=='function')migrationCapsuleFail('portable_native_create_required');
    const admission=async()=>{if(await assertTargetExclusive()!==true)migrationCapsuleFail('portable_owner');};
    await admission();await directory(path.dirname(target));if(await stat(target))migrationCapsuleFail('portable_target_exists');
    const stageRoot=path.join(path.dirname(target),'.ruyi-skill-portable-'+crypto.randomBytes(24).toString('hex')),input=portableInput(request),replacements=[],mappings=[],moves=[];let mutated=false;
    const originals=value.originals,terminals=value.terminalCapsules||[],rawTrees=value.rawTrees||[],physicalTrees=[...value.liveTrees,...rawTrees],archives=new Map(),liveTrees=new Map(),recordByPath=new Map(value.records.map(row=>[portableFold(row.path),row]));
    const inside=(name,root)=>portableFold(name)===portableFold(root)||portableFold(name).startsWith(portableFold(root)+'/');
    const oldOpaque=name=>originals.some(original=>{const snapshot=recordByPath.get(portableFold(original.archive)).value;return snapshot.entries.some(entry=>inside(name,original.wrapper+'/objects/'+entry.opaque));});
    const catalog=value.records.find(row=>row.kind==='catalog'),roots=[catalog?input.source.directories.find(name=>portableFold(name)==='.work-data/skill-backups/objects-v1'):null,
      ...input.source.directories.filter(name=>/^(?:\.work-data\/generations\/[a-f0-9]{48}\/)?migrations\/skill-backups$/i.test(name)),...value.liveTrees.map(row=>row.path),...(((value.settledRepresentations||[]).length||(value.plainBackups||[]).length||(value.retainedCapsules||[]).length)?['.work-data/skill-backups/representations-v1','.work-data/skill-backups/plain-v1','.work-data/skill-backups/intents'].filter(name=>input.dirs.has(portableFold(name))):[])].filter(Boolean);
    const parents=new Set([path.dirname(stageRoot)]),stagePath=name=>path.join(stageRoot,...name.split('/'));
    const retained=value.retainedCapsules||[],plainBackups=value.plainBackups||[],settled=value.settledRepresentations||[],newOriginals=new Map(),extraCopies=[];
    const rememberOriginal=(before,after)=>{if(before.entries.length!==after.entries.length)migrationCapsuleFail('portable_create_changed');newOriginals.set(rootId(before),after);};
    const translatedSnapshot=before=>{
      const actual=newOriginals.get(rootId(before));if(!actual)return portableClone(before);
      const result=portableClone(before);result.revision=actual.revision;
      for(const entry of result.entries){const replacement=actual.entries.find(row=>row.rel===entry.rel);if(!replacement||replacement.dir!==entry.dir)migrationCapsuleFail('portable_create_changed');entry.id=replacement.id;entry.opaque=replacement.opaque;}
      if(!migrationCapsulePortableShape(result))migrationCapsuleFail('portable_create_changed');return result;
    };
    const extraArchive=async row=>{
      const record=recordByPath.get(portableFold(row.archive)),snapshot=translatedSnapshot(record.value),source=descriptor('',row.stamp,row.skillId),copy={...source,backup:stagePath(row.wrapper),archiveKeys:await keysFor(row.archive)};
      await make(row.wrapper+'/objects');const bytes=require('node:zlib').gzipSync(Buffer.from(portableJSON(snapshot)));try{await migrationCapsuleArchive(copy).write(bytes);}finally{bytes.fill(0);}
      const reopened=await migrationCapsuleArchive(copy).read();try{if(portableJSON(migrationCapsuleDecode(reopened))!==portableJSON(snapshot))migrationCapsuleFail('portable_create_changed');}finally{reopened.fill(0);}
      archives.set(portableFold(row.archive),snapshot);
    };
    const extraIntent=async(record,slot,snapshot,{current=false,eligibility='edited'}={})=>{
      const liveName=(value.authority.id?'.work-data/generations/'+value.authority.id+'/':'')+'skills/'+slot.skillId,live=liveTrees.get(portableFold(liveName)),terminal=['complete','aborted'].includes(record.value.phase),staged={...portableClone(record.value),revision:snapshot.revision,oldRoot:rootId(snapshot)};
      if(terminal&&staged.historyPublish&&slot.historyPublishPath)staged.historyPublish.id=(await platform.info(stagePath(slot.historyPublishPath))).id;
      if(!terminal){staged.newTree=current&&live?migrationCapsuleFingerprint(live):record.value.newTree;staged.conversion={schema:1,operationId:record.value.conversion?.operationId||crypto.randomBytes(24).toString('hex'),eligibility:current?eligibility:'edited'};}
      const copy={...descriptor('',slot.stamp,slot.skillId),backup:stagePath(slot.wrapper),...(slot.plain?{plainRoot:stagePath(slot.physical)}:{}),intentFile:stagePath(record.path),intentRecordId:record.recordId,intentKeys:await keysFor(record.path),...(record.value.generationId?{generationId:record.value.generationId}:{})};
      await make(record.path.slice(0,record.path.lastIndexOf('/')));await migrationCapsuleIntent(copy).write(portableJSON(staged));if(portableJSON(safeJsonParse(await migrationCapsuleIntent(copy).read(),null))!==portableJSON(staged))migrationCapsuleFail('portable_binding');
      extraCopies.push({slot,record,snapshot,staged});
    };
    const transformBinding=async(staged,entry)=>{
      const current=staged.generationId===value.authority.id;
      if(entry.kind==='plain'){
        const slot=plainBackups.find(row=>row.generationId===staged.generationId&&row.backupId===entry.ref.backupId);if(!slot)migrationCapsuleFail('portable_binding');
        if(current&&slot.phase==='complete'){
          const history=value.records.find(row=>row.kind==='history'&&portableFold(row.path)===portableFold(slot.physical+'/history')),marker=slot.physical+'/'+MIGRATION_BACKUP_HISTORY_MARKER;if(!history)migrationCapsuleFail('portable_binding');
          entry.kind='history';entry.phase='complete';entry.historyMode=history.mode;entry.eligibility='terminal';entry.newTree=null;entry.archiveSha=await fileHash(stagePath(history.path));entry.intentSha=await fileHash(stagePath(marker));entry.sourceGenerationId=null;return;
        }
        // A completed historical plain intent retains its original conversion proof.
        // Keep the already validated binding paired with it; complete never replays undo.
        const live=slot.live?liveTrees.get(portableFold(slot.live)):null;if(slot.phase!=='complete'){entry.eligibility=slot.phase!=='published'?'terminal':current?slot.eligibility:'edited';entry.newTree=entry.eligibility==='eligible'?migrationCapsuleFingerprint(live):null;}
        entry.archiveSha=await fileHash(stagePath(slot.archive));entry.intentSha=await fileHash(stagePath(slot.intent));return;
      }
      const original=[...originals,...terminals,...retained].find(row=>row.stamp===entry.ref.stamp&&portableFold(row.skillId)===entry.ref.skillId&&hash(input.files.get(portableFold(row.archive)).data)===entry.archiveSha);if(!original)migrationCapsuleFail('portable_binding');
      const live=original.live?liveTrees.get(portableFold(original.live)):null,terminal=original.phase&&original.phase!=='published';if(terminal)entry.phase=original.phase;entry.eligibility=terminal?'terminal':current?original.eligibility:'edited';entry.newTree=entry.eligibility==='eligible'?migrationCapsuleFingerprint(live):null;
      entry.archiveSha=await fileHash(stagePath(original.archive));entry.intentSha=await fileHash(stagePath(entry.sourceGenerationId?'.work-data/skill-backups/intents/'+entry.sourceGenerationId+'/'+entry.ref.backupId+'.sealed':original.intent));
    };

    const make=async name=>{await admission();const absolute=stagePath(name);await fsp.mkdir(absolute,{recursive:true});await directory(absolute);let cursor=absolute;for(;;){parents.add(cursor);if(eq(cursor,stageRoot))break;cursor=path.dirname(cursor);}return absolute;};
    const write=async(name,data)=>{await make(name.slice(0,name.lastIndexOf('/')));await admission();const handle=await fsp.open(stagePath(name),'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}};
    try {
      await admission();await fsp.mkdir(stageRoot,{mode:0o700});mutated=true;const stageIdentity=await platform.info(stageRoot);
      for(const name of input.source.directories.filter(name=>roots.some(root=>inside(name,root))&&!physicalTrees.some(row=>inside(name,row.path))&&!oldOpaque(name)).sort((a,b)=>a.split('/').length-b.split('/').length||portableSort(a,b)))await make(name);
      for(const row of input.scoped.values())if(roots.some(root=>inside(row.path,root))&&!originals.some(original=>inside(row.path,original.wrapper))&&!rawTrees.some(raw=>inside(row.path,raw.path))&&recordByPath.get(portableFold(row.path))?.kind!=='representation-record')await write(row.path,row.data);
      // Relevant live trees are reconstructed first, so every newTree identity is
      // known before target mkdir and belongs to a real staged object.
      for(const row of physicalTrees){await make(row.path.slice(0,row.path.lastIndexOf('/')));await admission();const snapshot=await conversionNative.createOwnedPortable({root:stagePath(row.path),snapshot:row.snapshot,revision:hash('portable-new-live:'+crypto.randomBytes(32).toString('hex'))});
        if(!migrationCapsuleShape(snapshot))migrationCapsuleFail('portable_create_changed');liveTrees.set(portableFold(row.path),snapshot);if(rawTrees.includes(row))rememberOriginal(row.snapshot,snapshot);
      }
      for(const original of originals){
        const record=recordByPath.get(portableFold(original.archive)),old=record.value,scratch='.owned-originals/'+crypto.randomBytes(24).toString('hex');await make(scratch);const root=stagePath(scratch+'/'+original.skillId);await admission();
        const snapshot=await conversionNative.createOwnedPortable({root,snapshot:old,revision:hash('portable-new-original:'+crypto.randomBytes(32).toString('hex'))});if(!migrationCapsuleShape(snapshot)||snapshot.entries.length!==old.entries.length)migrationCapsuleFail('portable_create_changed');
        rememberOriginal(old,snapshot);archives.set(portableFold(original.archive),snapshot);await make(original.wrapper+'/objects');await admission();await conversionNative.seal({root,container:stagePath(original.wrapper+'/objects'),snapshot});
        // This maps only owned opaque object names; semantic skill IDs stay exact.
        for(const entry of old.entries){const next=snapshot.entries.find(row=>row.rel===entry.rel);if(!next||next.dir!==entry.dir)migrationCapsuleFail('portable_create_changed');mappings.push({source:original.wrapper+'/objects/'+entry.opaque,target:original.wrapper+'/objects/'+next.opaque,dir:entry.dir});}
        const marker=input.files.get(portableFold(original.marker.path));await write(marker.path,marker.data);
        const source=descriptor('',original.stamp,original.skillId),keys=await keysFor(original.archive),targetDescriptor={...source,backup:stagePath(original.wrapper),archiveKeys:keys};
        const bytes=require('node:zlib').gzipSync(Buffer.from(portableJSON(snapshot)));try{await migrationCapsuleArchive(targetDescriptor).write(bytes);}finally{bytes.fill(0);}
        const reopened=await migrationCapsuleArchive(targetDescriptor).read();try{if(portableJSON(migrationCapsuleDecode(reopened))!==portableJSON(snapshot))migrationCapsuleFail('portable_create_changed');}finally{reopened.fill(0);}
      }
      // Terminal capsules retain authenticated historical snapshots and IDs.
      // They never enter createOwnedPortable/seal: only their real current live
      // tree (if any) is newly owned. Every intent is terminalized below.
      for(const terminal of terminals){
        const record=recordByPath.get(portableFold(terminal.archive)),source=descriptor('',terminal.stamp,terminal.skillId),keys=await keysFor(terminal.archive),copy={...source,backup:stagePath(terminal.wrapper),archiveKeys:keys};
        const bytes=require('node:zlib').gzipSync(Buffer.from(portableJSON(record.value)));try{await migrationCapsuleArchive(copy).write(bytes);}finally{bytes.fill(0);}
        const reopened=await migrationCapsuleArchive(copy).read();try{if(portableJSON(migrationCapsuleDecode(reopened))!==portableJSON(record.value))migrationCapsuleFail('portable_terminal_changed');}finally{reopened.fill(0);}
      }
      // Rebind every fixed intent to the staged originals. Only the selected
      // live generation can retain eligible undo; older views become edited.
      for(const record of value.records.filter(row=>row.kind==='capsule-intent')){
        const original=[...originals,...terminals].find(row=>row.stamp===record.value.stamp&&row.skillId===record.value.id);if(!original)migrationCapsuleFail('portable_binding');const snapshot=original.phase?recordByPath.get(portableFold(original.archive)).value:archives.get(portableFold(original.archive)),live=original.live?liveTrees.get(portableFold(original.live)):null;
        const isCurrent=record.value.generationId===undefined||record.value.generationId===value.authority.id,eligibility=isCurrent?original.eligibility:'edited',staged=original.phase?{...portableClone(record.value),phase:original.phase}:{...portableClone(record.value),revision:snapshot.revision,oldRoot:rootId(snapshot),newTree:live?migrationCapsuleFingerprint(live):[],conversion:{schema:1,operationId:crypto.randomBytes(24).toString('hex'),eligibility:live?eligibility:'gone'}};
        const keys=await keysFor(record.path),descriptor={id:original.skillId,stamp:original.stamp,backup:stagePath(original.wrapper),scopeId:record.scopeId,recordId:'skill-backup:'+portableFold(original.skillId),intentFile:stagePath(record.path),intentRecordId:record.recordId,intentKeys:keys,...(record.value.generationId?{generationId:record.value.generationId}:{})};
        await make(record.path.slice(0,record.path.lastIndexOf('/')));await admission();await migrationCapsuleIntent(descriptor).write(portableJSON(staged));const checked=safeJsonParse(await migrationCapsuleIntent(descriptor).read(),null);if(portableJSON(checked)!==portableJSON(staged))migrationCapsuleFail('portable_binding');
      }
      for(const row of [...retained,...plainBackups])await extraArchive(row);
      for(const row of [...retained,...plainBackups]){
        const record=recordByPath.get(portableFold(row.intent)),snapshot=archives.get(portableFold(row.archive));await extraIntent(record,row,snapshot,{current:row.generationId===value.authority.id,eligibility:row.eligibility});
      }
      for(const record of value.records.filter(row=>row.kind==='representation-variant')){
        const generationId=record.value.generationId,backupId=hash(record.value.stamp+'/'+portableFold(record.value.id)),binding=value.records.find(row=>row.kind==='binding'&&row.value.generationId===generationId),bound=binding?.value.entries.find(entry=>entry.ref.backupId===backupId);
        const slot=[...originals,...terminals,...retained,...plainBackups].find(row=>row.stamp===record.value.stamp&&row.skillId===record.value.id&&(!bound||hash(input.files.get(portableFold(row.archive)).data)===bound.archiveSha));if(!slot)migrationCapsuleFail('portable_binding');
        const sourceSnapshot=recordByPath.get(portableFold(slot.archive)).value,snapshot=archives.get(portableFold(slot.archive))||translatedSnapshot(sourceSnapshot);
        await extraIntent(record,slot,snapshot,{current:generationId===value.authority.id,eligibility:slot.eligibility});
      }

      const verifyCopies=async root=>{
        for(const check of extraCopies){const slot=check.slot,copy={...descriptor('',slot.stamp,slot.skillId),backup:path.join(root,...slot.wrapper.split('/')),...(slot.plain?{plainRoot:path.join(root,...slot.physical.split('/'))}:{}),archiveKeys:await keysFor(slot.archive),intentKeys:await keysFor(check.record.path),intentFile:path.join(root,...check.record.path.split('/')),intentRecordId:check.record.recordId,...(check.staged.generationId?{generationId:check.staged.generationId}:{})},reopened=await migrationCapsuleRead(capturedDescriptor(copy));if(portableJSON(reopened.snapshot)!==portableJSON(check.snapshot)||portableJSON(reopened.intent)!==portableJSON(check.staged))migrationCapsuleFail('portable_binding');}

        for(const record of value.records.filter(row=>row.kind==='capsule-intent')){
          const original=[...originals,...terminals].find(row=>row.stamp===record.value.stamp&&row.skillId===record.value.id),source=descriptor('',original.stamp,original.skillId),copy={...source,backup:path.join(root,...original.wrapper.split('/')),archiveKeys:await keysFor(original.archive),intentKeys:await keysFor(record.path),intentFile:path.join(root,...record.path.split('/')),intentRecordId:record.recordId,...(record.value.generationId?{generationId:record.value.generationId}:{})};
          const current=await migrationCapsuleRead(capturedDescriptor(copy)),expected=original.phase?recordByPath.get(portableFold(original.archive)).value:archives.get(portableFold(original.archive));if(portableJSON(current.snapshot)!==portableJSON(expected)||current.intent.oldRoot!==rootId(expected)||original.phase&&current.intent.phase!==original.phase)migrationCapsuleFail('portable_binding');
        }
      };await verifyCopies(stageRoot);
      let objectsInfo=null;if(catalog)objectsInfo=await platform.info(stagePath(roots.find(root=>portableFold(root)==='.work-data/skill-backups/objects-v1')));
      const validators={catalog:catalogValid,relocation:journalValid,representation:representationValid,'representation-record':representationRecordValid,binding:bindingValid};
      for(const record of value.records){
        if(record.kind==='migration-log'){
          const staged=portableClone(record.value);for(const row of record.rewrites){staged.files[row.index].file=path.join(target,...row.file.split('/'));staged.files[row.index].backup=path.join(target,...row.backup.split('/'));}
          const text=record.format.bom+JSON.stringify(staged,null,record.format.indent)+record.format.ending;await make(record.path.slice(0,record.path.lastIndexOf('/')));const keys=record.mode==='encrypted'?await keysFor(record.path):undefined;
          const store=WorkDataStore.createText({file:()=>stagePath(record.path),purpose:record.purpose,schema:1,scopeId:record.scopeId,recordId:record.recordId,chunked:true,maxPlaintextBytes:256*1024*1024,keys,enabled:()=>record.mode==='encrypted',writeJson:atomicWriteJson});await admission();await store.write(text);if(await store.read()!==text)migrationCapsuleFail('portable_log');continue;
        }
        if(['history','capsule-archive','capsule-intent','representation-archive','representation-intent','representation-variant','plain-archive','plain-intent','representation-provenance'].includes(record.kind))continue;const validate=validators[record.kind];if(!validate)migrationCapsuleFail('portable_shape');const staged=portableClone(record.value);
        if(record.kind==='catalog'||record.kind==='relocation'&&staged.phase==='kept'){if(!objectsInfo)migrationCapsuleFail('portable_store');staged.rootId=objectsInfo.id;staged.volume=objectsInfo.volume;}
        if(record.kind==='binding')for(const entry of staged.entries)if(entry.kind!=='history')await transformBinding(staged,entry);
        if(record.kind==='representation-record'){
          const history=settled.find(row=>row.path===record.path);if(!history)migrationCapsuleFail('portable_binding');
          staged.original=translatedSnapshot(record.value.original);staged.target=translatedSnapshot(record.value.target);staged.revision=staged.original.revision;
          if(staged.eligibility!=='terminal'){staged.eligibility=record.value.eligibility==='gone'?'gone':'edited';}
          staged.archiveSha=await fileHash(stagePath(history.archive));staged.intentSha=await fileHash(stagePath(history.intent));
          // Wrapper IDs are derived from the same closed source native evidence;
          // historical original IDs without a physical owner remain unchanged.
          for(const field of ['capsuleId','historyId'])if(staged[field]){
            let name=null;for(const proof of value.nativeEvidence||[])for(const entry of proof.snapshot.entries)if(entry.id===record.value[field])name=entry.rel?proof.path+'/'+entry.rel:proof.path;
            if(name){const actual=await platform.info(stagePath(name));staged[field]=actual.id;if(field==='historyId'){const proof=await portableCapture(stagePath(name),staged.revision);staged.historyTree=migrationCapsuleFingerprint(proof);}}
          }
        }

        await make(record.path.slice(0,record.path.lastIndexOf('/')));const keys=await keysFor(record.path);await admission();await sealed(stagePath(record.path),record.recordId,validate,keys,target).write(staged);if(portableJSON(await sealed(stagePath(record.path),record.recordId,validate,keys,target).read())!==portableJSON(staged))migrationCapsuleFail('portable_binding');
      }
      for(const record of value.records.filter(row=>row.kind!=='history')){const bytes=await fsp.readFile(stagePath(record.path));replacements.push({path:record.path,data:bytes,sha256:hash(bytes)});}
      for(const name of roots){const snapshot=await portableCapture(stagePath(name),hash('portable-stage:'+name));if(!migrationCapsuleShape(snapshot))migrationCapsuleFail('portable_stage_changed');moves.push({path:name,info:await platform.info(stagePath(name)),snapshot});}
      const parentBindings=await portableBindExternal([...parents].filter(root=>!portableWithin(stageRoot,root)),'external-parent',admission);
      const stageProof=await portableCapture(stageRoot,hash('portable-stage-root:'+crypto.randomBytes(32).toString('hex')));await admission();if(await stat(target))migrationCapsuleFail('portable_target_exists');const stageDurability=await portableStageDurability(stageRoot,stageProof,stageIdentity,[...parents],parentBindings,admission);
      const skipFiles=request.files.filter(row=>roots.some(root=>inside(row.path,root))).map(row=>row.path),token=Object.freeze({stageRoot,stageIdentity:Object.freeze({...stageIdentity}),files:Object.freeze(replacements.map(row=>Object.freeze({...row}))),skipDirectories:Object.freeze(roots),skipFiles:Object.freeze(skipFiles),pathMappings:Object.freeze(mappings.map(row=>Object.freeze({...row}))),profile:Object.freeze({...value.profile}),release(){for(const row of replacements)row.data.fill(0);}});
      portableStages.set(token,{originals:true,verifyCopies,target,targetOwnership,assertTargetExclusiveSync,stageRoot,stageIdentity,stageProof,stageDurability,moves,replacements,admission,installed:false,installStarted:false,targetIdentity:null});return token;
    }catch(cause){if(!mutated)throw cause;throw Object.assign(new Error('work_data_backup.portable_stage_failed',{cause}),{code:'work_data_backup.portable_stage_failed',apiCode:'work_data_backup.portable_stage_failed',statusCode:409,operationMayHaveExecuted:true,resultUnavailable:true,retry:false,stageRetained:stageRoot,...(cause?.helperMayStillRun===true?{helperMayStillRun:true}:{})});}
  }
  function portableTargetReadAdmission(owned,selected){
    const targetOwner=owned.targetOwnership;
    if(selected!==targetOwner||!targetOwner||!Array.isArray(targetOwner.roots)||!targetOwner.roots.some(root=>typeof root==='string'&&path.isAbsolute(root)&&eq(path.resolve(root),owned.target))||typeof owned.assertTargetExclusiveSync!=='function')migrationCapsuleFail('portable_target_owner');
    const proof=owned.assertTargetExclusiveSync(targetOwner);
    if(proof&&typeof proof.then==='function'){Promise.resolve(proof).catch(()=>{});throw Object.assign(new Error('work_data_backup.portable_target_owner_uncertain'),{code:'work_data_backup.portable_target_owner_uncertain',helperMayStillRun:true,ownershipRetained:true,operationMayHaveExecuted:true,resultUnavailable:true,retry:false});}
    if(proof!==true)migrationCapsuleFail('portable_target_owner');return true;
  }
  async function withPortableTargetReads(owned,work){
    if(!preservedTree)return work();
    await owned.admission();portableTargetReadAdmission(owned,owned.targetOwnership);
    const targetOwner=owned.targetOwnership,tree=WorkDataTree.createPreserved({capturePreserved:portableCapture,ownership:targetOwner,
      assertExclusive:async selected=>{await owned.admission();return portableTargetReadAdmission(owned,selected);},assertExclusiveSync:selected=>portableTargetReadAdmission(owned,selected),limits:preservedRead.limits||{}});
    let captured,result,failed=false,primary;
    try{captured=await tree.capture(owned.target);result=await portableTargetReads.run({captured,ownership:targetOwner},work);await tree.verify(captured);portableTargetReadAdmission(owned,targetOwner);}
    catch(cause){failed=true;primary=cause;}
    let cleanupFailed=false,cleanup;try{if(captured){const released=captured.release();if(released!==undefined){if(released&&typeof released.then==='function')Promise.resolve(released).catch(()=>{});throw new Error('portable_target_read_release_unproven');}}}catch(cause){cleanupFailed=true;cleanup=cause;}
    if(cleanupFailed){
      const error=migrationCapturedCleanupFailure(primary,failed,[cleanup],true);
      Object.assign(error,{code:'work_data_backup.portable_target_read_cleanup_uncertain',message:'work_data_backup.portable_target_read_cleanup_uncertain'});
      throw error;
    }
    if(failed)throw primary;return result;
  }
  // Diagnostic-only: runs after an unchanged refusal predicate, using existing memory.
  function portableTargetSnapshotDelta(actual,expected){
    const limited=value=>typeof value==='string'&&value.length>1024?value.slice(0,1024)+'[truncated]':value;
    const a=new Map(actual.entries.map(row=>[row.rel,row])),e=new Map(expected.entries.map(row=>[row.rel,row])),deltas=[];let changedEntries=0;
    for(const rel of new Set([...e.keys(),...a.keys()])){const old=e.get(rel),now=a.get(rel),fields={};
      if(!old||!now)fields.membership={expected:!!old,actual:!!now};else{
        for(const key of ['id','dir','attrs','shortName','times'])if(JSON.stringify(old[key])!==JSON.stringify(now[key]))fields[key]={expected:old[key],actual:now[key]};
        const oldStreams=new Map(old.streams.map(row=>[row.name,row])),newStreams=new Map(now.streams.map(row=>[row.name,row])),streams=[];let changedStreams=0;
        for(const name of new Set([...oldStreams.keys(),...newStreams.keys()])){const before=oldStreams.get(name),after=newStreams.get(name),streamFields={};if(!before||!after)streamFields.membership={expected:!!before,actual:!!after};else{for(const key of ['size','hash'])if(before[key]!==after[key])streamFields[key]={expected:before[key],actual:after[key]};if(before.data!==after.data)streamFields.dataDifferent=true;}
          if(Object.keys(streamFields).length){changedStreams++;if(streams.length<4)streams.push({name:limited(name),fields:streamFields});}}
        if(changedStreams)fields.streams={changedStreams,shown:streams.length,entries:streams};
      }
      if(Object.keys(fields).length){changedEntries++;if(deltas.length<8)deltas.push({rel:limited(rel),fields});}
    }
    return{revision:{expected:expected.revision,actual:actual.revision},count:{expected:expected.entries.length,actual:actual.entries.length},changedEntries,shown:deltas.length,entries:deltas};
  }
  function portableTargetFailure(check,details){
    try{migrationCapsuleFail('portable_target_changed');}catch(error){
      try{const diagnostic={schema:1,check,...details()};const diagnosticJson=JSON.stringify(diagnostic);error.portableDiagnostic=diagnosticJson.length<=24576?JSON.parse(diagnosticJson):{schema:1,check,detailTruncated:true};}
      catch{try{error.portableDiagnostic={schema:1,check,diagnosticUnavailable:true};}catch{}}
      throw error;
    }
  }
  async function verifyPortableOriginals(owned){
    return withPortableTargetReads(owned,async()=>{
    if(!owned.installed)migrationCapsuleFail('portable_token');await owned.admission();await directory(owned.target);const root=await fsp.lstat(owned.target,{bigint:true});if(String(root.dev)!==owned.targetIdentity.dev||String(root.ino)!==owned.targetIdentity.ino)portableTargetFailure('originals.verify.root-identity',()=>({expected:owned.targetIdentity,actual:{dev:String(root.dev),ino:String(root.ino)}}));
    for(const move of owned.moves){const file=path.join(owned.target,...move.path.split('/')),info=await platform.info(file),snapshot=await portableCapture(file,move.snapshot.revision);if(info.id!==move.info.id||info.volume!==move.info.volume||!migrationCapsuleSameMetadata(snapshot,move.snapshot))portableTargetFailure('originals.verify.move',()=>({path:move.path,expected:{id:move.info.id,volume:move.info.volume},actual:{id:info.id,volume:info.volume},delta:portableTargetSnapshotDelta(snapshot,move.snapshot)}));}
    for(const row of owned.replacements)if(await fileHash(path.join(owned.target,...row.path.split('/')))!==row.sha256||hash(row.data)!==row.sha256)portableTargetFailure('originals.verify.replacement-sha256',()=>({path:row.path,expectedSha256:row.sha256,actualHashNotRetained:true}));
    await owned.verifyCopies(owned.target);await owned.admission();return Object.freeze({target:owned.target,readOnly:true,originalObjects:'new-owned-portable',terminalSnapshots:'source-history-only'});
    });
  }
  async function installPortableOriginals(owned,{targetIdentity}={}){
    if(owned.installed||owned.installStarted||!targetIdentity||!['dev','ino'].every(key=>typeof targetIdentity[key]==='string'))migrationCapsuleFail('portable_token');await owned.admission();await directory(owned.target);const root=await fsp.lstat(owned.target,{bigint:true});if(String(root.dev)!==targetIdentity.dev||String(root.ino)!==targetIdentity.ino)portableTargetFailure('originals.install.root-identity',()=>({expected:targetIdentity,actual:{dev:String(root.dev),ino:String(root.ino)}}));
    const stage=await portableCapture(owned.stageRoot,owned.stageProof.revision);if(!migrationCapsuleSameMetadata(stage,owned.stageProof))migrationCapsuleFail('portable_stage_changed');portableAssertDurability(owned.stageDurability,owned.stageRoot,owned.stageIdentity,stage);
    const moveNames=owned.moves.map(row=>row.path),protectedRoots=moveNames.map(name=>path.join(owned.target,...name.split('/'))),requiredFlushRoots=[owned.target,...new Set(owned.moves.map(row=>path.dirname(path.join(owned.target,...row.path.split('/')))))],targetBindings=await portableBindExternal(portableExternalOnly(requiredFlushRoots,protectedRoots),'new-target-ancestor',owned.admission);portableAssertExternal(owned.stageDurability,targetBindings);
    try{owned.installStarted=true;for(const move of owned.moves){await owned.admission();const source=path.join(owned.stageRoot,...move.path.split('/')),target=path.join(owned.target,...move.path.split('/'));await directory(path.dirname(target));if(await stat(target))migrationCapsuleFail('portable_target_exists');const result=await platform.move({source,target,id:move.info.id,preserveMetadata:true});if(!result||result.id!==move.info.id||result.volume!==move.info.volume)migrationCapsuleFail('portable_store');}
      owned.installed=true;owned.targetIdentity=Object.freeze({...targetIdentity});await portableVerifyInherited(owned.stageDurability,owned.stageRoot,owned.target,owned.stageIdentity,moveNames,owned.admission);await portableFlushBound(targetBindings,owned.admission);return await verifyPortableOriginals(owned);
    }catch(cause){throw Object.assign(new Error('work_data_backup.portable_install_uncertain',{cause}),{code:'work_data_backup.portable_install_uncertain',apiCode:'work_data_backup.portable_install_uncertain',statusCode:409,operationMayHaveExecuted:true,resultUnavailable:true,retry:false,stageRetained:owned.stageRoot,targetRetained:owned.target,...(cause?.helperMayStillRun===true?{helperMayStillRun:true}:{})});}
  }

  async function stagePortable({target,keysFor,assertTargetExclusive,targetOwnership,assertTargetExclusiveSync,data,...request}={}) {
    if(typeof target!=='string'||!path.isAbsolute(target)||!eq(target,path.resolve(target))||typeof keysFor!=='function'||typeof assertTargetExclusive!=='function')migrationCapsuleFail('portable_host');
    if(preservedTree)portableTargetReadAdmission({target,targetOwnership,assertTargetExclusiveSync},targetOwnership);
    const within=(a,b)=>{const relative=path.relative(samePathKey(a),samePathKey(b));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
    if(within(base,target)||within(target,base))migrationCapsuleFail('portable_target');
    const admission=async()=>{if(await assertTargetExclusive()!==true)migrationCapsuleFail('portable_owner');};
    await admission();const value=await validatePortable({...request,data});portableRequireDurabilityHost();if(value.originals?.length||value.terminalCapsules?.length||value.rawTrees?.length||value.settledRepresentations?.length)return stagePortableOriginals({target,keysFor,assertTargetExclusive,targetOwnership,assertTargetExclusiveSync,request,value});await directory(path.dirname(target));
    const absent=async file=>{if(await stat(file))migrationCapsuleFail('portable_target_exists');};await absent(target);
    const stageRoot=path.join(path.dirname(target),'.ruyi-skill-portable-'+crypto.randomBytes(24).toString('hex'));
    let mutated=false;
    try{
      await admission();await fsp.mkdir(stageRoot,{mode:0o700});mutated=true;await directory(stageRoot);
      const stageIdentity=await platform.info(stageRoot),input=portableInput(request),catalog=value.records.find(row=>row.kind==='catalog'),replacements=[];
      const allDirs=new Set([stageRoot,path.dirname(stageRoot)]),objectsName=catalog?input.source.directories.find(name=>portableFold(name)==='.work-data/skill-backups/objects-v1'):null;
      let objectInfo=null,objectProof=null;
      const makeParents=async relative=>{const parent=path.dirname(path.join(stageRoot,...relative.split('/')));await fsp.mkdir(parent,{recursive:true});await directory(parent);let cursor=parent;for(;;){allDirs.add(cursor);if(eq(cursor,stageRoot))break;cursor=path.dirname(cursor);}};
      if(catalog){
        if(!objectsName)migrationCapsuleFail('portable_store');
        for(const name of input.source.directories.filter(name=>portableFold(name)===portableFold(objectsName)||portableFold(name).startsWith(portableFold(objectsName)+'/')).sort((a,b)=>a.split('/').length-b.split('/').length||portableSort(a,b))){await makeParents(name+'/placeholder');await directory(path.join(stageRoot,...name.split('/')));}
        const objectRoot=path.join(stageRoot,...objectsName.split('/'));objectInfo=await platform.info(objectRoot);
        if(!id24(objectInfo.id)||typeof objectInfo.volume!=='string')migrationCapsuleFail('portable_store');
        for(const row of input.scoped.values())if(portableFold(row.path).startsWith(portableFold(objectsName)+'/')){
          await makeParents(row.path);const handle=await fsp.open(path.join(stageRoot,...row.path.split('/')),'wx',0o600);try{await handle.writeFile(row.data);await handle.sync();}finally{await handle.close();}
        }
        objectProof=await portableCapture(objectRoot,hash(value.source.sourceSha256+':target-store'));
        if(!migrationCapsuleShape(objectProof)||objectProof.entries.some(entry=>entry.streams.some(stream=>stream.name!=='')))migrationCapsuleFail('portable_native_streams');
      }
      const validators={catalog:catalogValid,relocation:journalValid,representation:representationValid,binding:bindingValid};
      for(const record of value.records){
        if(record.kind==='history')continue;const validate=validators[record.kind];if(!validate)migrationCapsuleFail('portable_shape');
        const staged=portableClone(record.value);
        if(record.kind==='catalog'||record.kind==='relocation'&&staged.phase==='kept'){if(!objectInfo)migrationCapsuleFail('portable_store');staged.rootId=objectInfo.id;staged.volume=objectInfo.volume;}
        await makeParents(record.path);const file=path.join(stageRoot,...record.path.split('/')),keys=await keysFor(record.path);
        if(!keys||typeof keys.snapshot!=='function')migrationCapsuleFail('portable_keys');
        await sealed(file,record.recordId,validate,keys,target).write(staged);
        const reopened=await sealed(file,record.recordId,validate,keys,target).read();if(portableJSON(reopened)!==portableJSON(staged))migrationCapsuleFail('portable_binding');
        const bytes=await fsp.readFile(file);replacements.push({path:record.path,data:bytes,sha256:hash(bytes)});
      }
      const parentBindings=await portableBindExternal([...allDirs].filter(root=>!portableWithin(stageRoot,root)),'external-parent',admission);
      const stageProof=await portableCapture(stageRoot,hash(value.source.sourceSha256+':stage'));if(!migrationCapsuleShape(stageProof)||stageProof.entries.some(entry=>entry.streams.some(stream=>stream.name!=='')))migrationCapsuleFail('portable_native_streams');
      await admission();await absent(target);const stageDurability=await portableStageDurability(stageRoot,stageProof,stageIdentity,[...allDirs],parentBindings,admission);
      const token=Object.freeze({stageRoot,stageIdentity:Object.freeze({...stageIdentity}),objectsRoot:objectsName,files:Object.freeze(replacements.map(row=>Object.freeze({...row}))),
        skipDirectories:Object.freeze(objectsName?[objectsName]:[]),skipFiles:Object.freeze(objectsName?[...input.scoped.values()].filter(row=>portableFold(row.path).startsWith(portableFold(objectsName)+'/')).map(row=>row.path):[]),
        profile:Object.freeze({...value.profile}),release(){for(const row of replacements)row.data.fill(0);}});
      portableStages.set(token,{target,stageRoot,stageIdentity,stageProof,stageDurability,objectsName,objectInfo,objectProof,replacements,admission,installed:false,targetIdentity:null});return token;
    }catch(cause){if(!mutated)throw cause;throw Object.assign(new Error('work_data_backup.portable_stage_failed',{cause}),{code:'work_data_backup.portable_stage_failed',apiCode:'work_data_backup.portable_stage_failed',statusCode:409,operationMayHaveExecuted:true,resultUnavailable:true,retry:false,stageRetained:stageRoot,...(cause?.helperMayStillRun===true?{helperMayStillRun:true}:{})});}
  }
  async function verifyPortableInstalled(token){
    const owned=portableStages.get(token);if(owned?.originals)return verifyPortableOriginals(owned);if(!owned?.installed)migrationCapsuleFail('portable_token');await owned.admission();
    await directory(owned.target);const actualRoot=await fsp.lstat(owned.target,{bigint:true});
    if(String(actualRoot.dev)!==owned.targetIdentity.dev||String(actualRoot.ino)!==owned.targetIdentity.ino)migrationCapsuleFail('portable_target_changed');
    for(const row of owned.replacements){if(hash(row.data)!==row.sha256||await fileHash(path.join(owned.target,...row.path.split('/')))!==row.sha256)migrationCapsuleFail('portable_target_changed');}
    for(const parent of new Set(owned.replacements.map(row=>path.dirname(path.join(owned.target,...row.path.split('/')))))){const actual=await portableCapture(parent,owned.stageProof.revision);if(!migrationCapsuleShape(actual)||actual.entries.some(entry=>entry.streams.some(stream=>stream.name!=='')))migrationCapsuleFail('portable_native_streams');}
    if(owned.objectsName){const root=path.join(owned.target,...owned.objectsName.split('/')),info=await platform.info(root),actual=await portableCapture(root,owned.objectProof.revision);if(info.id!==owned.objectInfo.id||info.volume!==owned.objectInfo.volume||!migrationCapsuleSame(actual,migrationCapsuleFingerprint(owned.objectProof)))migrationCapsuleFail('portable_target_changed');}
    await owned.admission();return Object.freeze({target:owned.target,readOnly:true,originalObjects:'refused',terminalSnapshots:'source-history-only'});
  }
  async function installPortable(token,{targetIdentity}={}){
    const owned=portableStages.get(token);if(owned?.originals)return installPortableOriginals(owned,{targetIdentity});if(!owned||owned.installed||owned.installStarted)migrationCapsuleFail('portable_token');await owned.admission();
    if(!targetIdentity||!['dev','ino'].every(name=>typeof targetIdentity[name]==='string'))migrationCapsuleFail('portable_target');
    await directory(owned.target);const actual=await fsp.lstat(owned.target,{bigint:true});if(String(actual.dev)!==targetIdentity.dev||String(actual.ino)!==targetIdentity.ino)migrationCapsuleFail('portable_target_changed');
    const stage=await platform.info(owned.stageRoot);if(stage.id!==owned.stageIdentity.id||stage.volume!==owned.stageIdentity.volume)migrationCapsuleFail('portable_stage_changed');
    const stageCurrent=await portableCapture(owned.stageRoot,owned.stageProof.revision);if(!migrationCapsuleSame(stageCurrent,migrationCapsuleFingerprint(owned.stageProof)))migrationCapsuleFail('portable_stage_changed');portableAssertDurability(owned.stageDurability,owned.stageRoot,owned.stageIdentity,stageCurrent);
    const inheritedNames=owned.objectsName?[owned.objectsName]:[],protectedRoots=inheritedNames.map(name=>path.join(owned.target,...name.split('/'))),requiredFlushRoots=[owned.target,path.join(owned.target,'.work-data'),path.join(owned.target,'.work-data','skill-backups')].filter(root=>owned.objectsName||eq(root,owned.target)),targetBindings=await portableBindExternal(portableExternalOnly(requiredFlushRoots,protectedRoots),'new-target-ancestor',owned.admission);portableAssertExternal(owned.stageDurability,targetBindings);
    for(const row of owned.replacements)if(hash(row.data)!==row.sha256||await fileHash(path.join(owned.target,...row.path.split('/')))!==row.sha256)migrationCapsuleFail('portable_target_changed');
    try{
      owned.installStarted=true;
      if(owned.objectsName){const source=path.join(owned.stageRoot,...owned.objectsName.split('/')),target=path.join(owned.target,...owned.objectsName.split('/'));await directory(path.dirname(target));if(await stat(target))migrationCapsuleFail('portable_target_exists');const current=await portableCapture(source,owned.objectProof.revision);if(!migrationCapsuleSame(current,migrationCapsuleFingerprint(owned.objectProof)))migrationCapsuleFail('portable_stage_changed');const moved=await platform.move({source,target,id:owned.objectInfo.id,preserveMetadata:true});if(moved.id!==owned.objectInfo.id||moved.volume!==owned.objectInfo.volume)migrationCapsuleFail('portable_store');}
      owned.installed=true;owned.targetIdentity=Object.freeze({...targetIdentity});await portableVerifyInherited(owned.stageDurability,owned.stageRoot,owned.target,owned.stageIdentity,inheritedNames,owned.admission);await portableFlushBound(targetBindings,owned.admission);
      return await verifyPortableInstalled(token);
    }catch(cause){throw Object.assign(new Error('work_data_backup.portable_install_uncertain',{cause}),{code:'work_data_backup.portable_install_uncertain',apiCode:'work_data_backup.portable_install_uncertain',statusCode:409,operationMayHaveExecuted:true,resultUnavailable:true,retry:false,targetRetained:owned.target,stageRetained:owned.stageRoot,...(cause?.helperMayStillRun===true?{helperMayStillRun:true}:{})});}
  }

  // Narrow first-enable retirement. The authenticated original package proves
  // that this control namespace did not predate the pending transition. Tokens
  // remain private to this owner; a boolean recovery result grants no deletion.
  const emptyCancellations = new WeakMap();
  const emptyNames = ['relocation-v1.sealed', 'representation-v1.sealed'];
  async function emptyPhysical(file) {
    await directory(path.dirname(file)); const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 128n * 1024n) migrationCapsuleFail('empty_cancel_changed');
    const handle = await fsp.open(file, 'r'); let bytes;
    try {
      const opened = await handle.stat({ bigint: true }); bytes = Buffer.alloc(Number(before.size) + 1);let count = 0;
      while (count < bytes.length) {const read = await handle.read(bytes, count, bytes.length - count, null);if (!read.bytesRead) break;count += read.bytesRead;}
      const after = await handle.stat({ bigint: true }), current = await fsp.lstat(file, { bigint: true });
      for (const value of [opened, after, current]) if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n
        || value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size || value.mtimeNs !== before.mtimeNs || value.ctimeNs !== before.ctimeNs) migrationCapsuleFail('empty_cancel_changed');
      if (count !== Number(before.size)) migrationCapsuleFail('empty_cancel_changed');
      return { sha256: hash(bytes.subarray(0, count)), dev: String(before.dev), ino: String(before.ino) };
    } finally { bytes?.fill(0); await handle.close(); }
  }
  const sameEmptyPhysical = (a, b) => a.sha256 === b.sha256 && a.dev === b.dev && a.ino === b.ino;
  async function emptyNative(root) {
    const snapshot = await platform.capture(root, crypto.randomBytes(32).toString('hex'));
    if (!migrationCapsuleShape(snapshot) || snapshot.entries.some(row => row.attrs !== (row.dir ? 16 : 32) && !(row.dir === false && row.attrs === 128)
      || row.streams.length !== (row.dir ? 0 : 1) || row.streams.some(stream => stream.name !== ''))) migrationCapsuleFail('empty_cancel_native');
    return snapshot;
  }
  async function emptyAdmission(known, assertUnchanged) {
    if (typeof assertUnchanged !== 'function' || await assertUnchanged() !== true) migrationCapsuleFail('empty_cancel_ownership');
    const selected = await active();
    if (selected.id !== null || selected.proof.raw !== null || selected.proof.sha256 !== null) migrationCapsuleFail('empty_cancel_authority');
    await directory(path.join(base, '.work-data'));
    const names = await fsp.readdir(path.join(base, '.work-data'));
    if (names.some(name => !['generations', 'maintenance-v1.json', 'skill-backups'].includes(name))) migrationCapsuleFail('empty_cancel_external_reference');
    await directory(path.join(base, '.work-data', 'generations'));
    const generations = await fsp.readdir(path.join(base, '.work-data', 'generations'));
    if (!(generations.length === 1 && generations[0] === known.candidateId || generations.length === 0 && (known.retired || known.allowMissing)) || await stat(path.join(base, 'work-data-key-v1.json'))) migrationCapsuleFail('empty_cancel_external_reference');
  }
  async function emptyLayout(known, allowStable) {
    if (!await directory(control, true)) { if (known.controlIdentity && !known.retired) migrationCapsuleFail('empty_cancel_changed'); return []; }
    if (known.controlIdentity) {const observed = await fsp.lstat(control, { bigint: true });if (String(observed.dev) !== known.controlIdentity.dev || String(observed.ino) !== known.controlIdentity.ino) migrationCapsuleFail('empty_cancel_changed');}
    const names = (await fsp.readdir(control)).sort();
    if (names.some(name => !emptyNames.includes(name) && !(allowStable && name === 'objects-v1'))) migrationCapsuleFail('empty_cancel_external_reference');
    for (const root of [legacyRoot, stableRoot]) if (await stat(root)) {
      await directory(root);
      if (eq(root, legacyRoot) && known.legacyIdentity) {const observed = await fsp.lstat(root, { bigint: true });if (String(observed.dev) !== known.legacyIdentity.dev || String(observed.ino) !== known.legacyIdentity.ino) migrationCapsuleFail('empty_cancel_changed');}
      if ((await fsp.readdir(root)).length) migrationCapsuleFail('empty_cancel_nonempty');
      const captured = await emptyNative(root); if (captured.entries.length !== 1 || !captured.entries[0].dir) migrationCapsuleFail('empty_cancel_nonempty');
    }
    if (!allowStable && await stat(stableRoot)) migrationCapsuleFail('empty_cancel_unsettled');
    for (const name of names.filter(value => emptyNames.includes(value))) await emptyPhysical(path.join(control, name));
    const snapshot = await emptyNative(control);
    if (snapshot.entries.length !== names.length + 1) migrationCapsuleFail('empty_cancel_changed');
    for (const row of snapshot.entries) if (row.rel && (!names.includes(row.rel) || row.dir !== (row.rel === 'objects-v1'))) migrationCapsuleFail('empty_cancel_changed');
    return names.filter(name => emptyNames.includes(name));
  }
  async function prepareEmptyCancellation({ serialized, password, state, assertUnchanged } = {}) {
    let copied; try { copied = JSON.parse(JSON.stringify(state)); } catch { migrationCapsuleFail('empty_cancel_request'); }
    if (typeof serialized !== 'string' || !hex(copied?.backup?.sha256) || hash(serialized) !== copied.backup.sha256
      || copied.schema !== 2 || copied.operation !== 'enable' || !['candidate', 'key-ready', 'canceling'].includes(copied.phase)
      || copied.expectedAuthority?.generation !== 0 || copied.expectedAuthority.id !== null || copied.expectedAuthority.sha256 !== null || copied.expectedAuthority.mode !== 'plain'
      || !id48(copied.id) || !id48(copied.candidate?.id) || copied.candidate.mode !== 'encrypted') migrationCapsuleFail('empty_cancel_request');
    const known = { candidateId: copied.candidate.id, backupSha256: copied.backup.sha256, records: null, retired: false, allowMissing: copied.phase === 'canceling' };
    const opened = await WorkDataRecovery.open(serialized, password);
    try {
      const snapshot = opened.snapshot, lower = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (snapshot.generation !== 0 || snapshot.keys.some(row => row.purpose === 'work-data')
        || [...snapshot.files.map(row => row.path), ...snapshot.directories].some(relative => {
          const name = lower(relative); return name === 'migrations/skill-backups' || name === '.work-data' || name.startsWith('.work-data/') || name === 'work-data-key-v1.json'
            || name.startsWith('migrations/skill-backups/');
        }) || snapshot.auxiliaries.some(row => row.type === 'skill-backup-portable')) migrationCapsuleFail('empty_cancel_preexisting');
      const config = snapshot.files.find(row => lower(row.path) === 'config.json');
      if (!config) migrationCapsuleFail('empty_cancel_source');
      const text = config.data.toString('utf8'); let value;
      try { if (!Buffer.from(text).equals(config.data)) migrationCapsuleFail('empty_cancel_source'); value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { migrationCapsuleFail('empty_cancel_source'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.workDataEncryptionV1 !== undefined && value.workDataEncryptionV1 !== false) migrationCapsuleFail('empty_cancel_source');
    } finally { opened.release(); }
    await emptyAdmission(known, assertUnchanged); await emptyLayout(known, true);
    const before = new Map();
    for (const name of emptyNames) if (await stat(path.join(control, name))) before.set(name, await emptyPhysical(path.join(control, name)));
    const relocation = await journalStore().read(), representation = await representationStore().read();
    if (relocation && (relocation.targetId !== known.candidateId || relocation.sourceProof !== null || !['prepared', 'moved', 'canceled'].includes(relocation.phase))
      || representation && relocation && representation.storeId !== relocation.storeId
      || representation && (representation.targetId !== known.candidateId || representation.sourceId !== null || representation.sourceProof !== null
        || representation.mode !== 'encrypted' || representation.entries.length || !['prepared', 'converted', 'canceled'].includes(representation.phase))) migrationCapsuleFail('empty_cancel_unsettled');
    for (const [name, proof] of before) if (!sameEmptyPhysical(proof, await emptyPhysical(path.join(control, name)))) migrationCapsuleFail('empty_cancel_changed');
    // Only this authenticated empty transition may move its root back. Unknown
    // operation journals, old controls, and nonempty objects never reach recover.
    await emptyAdmission(known, assertUnchanged); await recoverRepresentation(); await recover();
    const names = await emptyLayout(known, false), canceled = await journalStore().read(), represented = await representationStore().read();
    if (canceled && (canceled.phase !== 'canceled' || canceled.targetId !== known.candidateId || canceled.sourceProof !== null)
      || represented && (represented.phase !== 'canceled' || represented.entries.length || represented.targetId !== known.candidateId)) migrationCapsuleFail('empty_cancel_unsettled');
    if (canceled) {
      await directory(legacyRoot); const identity = await platform.info(legacyRoot);
      if (identity.id !== canceled.rootId || identity.volume !== canceled.volume) migrationCapsuleFail('empty_cancel_changed');
    }
    if (canceled && represented && canceled.storeId !== represented.storeId) migrationCapsuleFail('empty_cancel_unsettled');
    if (await stat(control)) {const observed = await fsp.lstat(control, { bigint: true });known.controlIdentity = {dev: String(observed.dev), ino: String(observed.ino)};}
    if (await stat(legacyRoot)) {const observed = await fsp.lstat(legacyRoot, { bigint: true });known.legacyIdentity = {dev: String(observed.dev), ino: String(observed.ino)};}
    known.records = new Map(); for (const name of names) known.records.set(name, await emptyPhysical(path.join(control, name)));
    await emptyAdmission(known, assertUnchanged);
    const proof = Object.freeze({ candidateId: known.candidateId, backupSha256: known.backupSha256, profile: 'first-enable-empty-canceled' });
    emptyCancellations.set(proof, known); return proof;
  }
  async function retireEmptyCancellation(proof, { assertUnchanged, flush } = {}) {
    const known = emptyCancellations.get(proof); if (!known || known.retired || typeof flush !== 'function') migrationCapsuleFail('empty_cancel_proof');
    await emptyAdmission(known, assertUnchanged); const names = await emptyLayout(known, false);
    if (names.length !== known.records.size || names.some(name => !known.records.has(name))) migrationCapsuleFail('empty_cancel_changed');
    for (const [name, expected] of known.records) if (!sameEmptyPhysical(expected, await emptyPhysical(path.join(control, name)))) migrationCapsuleFail('empty_cancel_changed');
    const remaining = new Set(names);
    for (const [name, expected] of known.records) {
      await emptyAdmission(known, assertUnchanged); const actualNames = await emptyLayout(known, false);
      if (actualNames.length !== remaining.size || actualNames.some(value => !remaining.has(value)) || !sameEmptyPhysical(expected, await emptyPhysical(path.join(control, name)))) migrationCapsuleFail('empty_cancel_changed');
      await fsp.unlink(path.join(control, name)); remaining.delete(name); await flush([control, path.dirname(control), base]);
    }
    if (await stat(control)) {
      await emptyAdmission(known, assertUnchanged); if ((await emptyLayout(known, false)).length || (await fsp.readdir(control)).length) migrationCapsuleFail('empty_cancel_changed');
      await fsp.rmdir(control); await flush([path.dirname(control), base]);
    } else if (known.controlIdentity) migrationCapsuleFail('empty_cancel_changed');
    known.retired = true; return await verifyEmptyCancellation(proof, { assertUnchanged });
  }
  async function verifyEmptyCancellation(proof, { assertUnchanged } = {}) {
    const known = emptyCancellations.get(proof); if (!known || !known.retired) migrationCapsuleFail('empty_cancel_proof');
    await emptyAdmission(known, assertUnchanged);
    if (await stat(control)) migrationCapsuleFail('empty_cancel_external_reference');
    if (await directory(legacyRoot, true)) {
      const observed = await fsp.lstat(legacyRoot, { bigint: true });
      if (known.legacyIdentity && (String(observed.dev) !== known.legacyIdentity.dev || String(observed.ino) !== known.legacyIdentity.ino)) migrationCapsuleFail('empty_cancel_changed');
      if ((await fsp.readdir(legacyRoot)).length) migrationCapsuleFail('empty_cancel_nonempty');
      const snapshot = await emptyNative(legacyRoot); if (snapshot.entries.length !== 1) migrationCapsuleFail('empty_cancel_nonempty');
    }
    if (known.legacyIdentity && !await stat(legacyRoot)) migrationCapsuleFail('empty_cancel_changed');
    await emptyAdmission(known, assertUnchanged); return true;
  }

  return Object.freeze({ prepare, prepareBindings, recover, activate, resolve, ref, prepareRepresentation, recoverRepresentation, prepareEmptyCancellation, retireEmptyCancellation, verifyEmptyCancellation, verifyPublished, capturePortable, validatePortable, stagePortable, installPortable, verifyPortableInstalled });
}

// 迟绑定挂接(见 00-boot 的 MigrationHooks 头注)。
Object.assign(MigrationHooks, {
  createBackupOwner: createMigrationBackupOwner,
  helperMayStillRun: () => migrationCapsuleBroker.helperMayStillRun === true,
  recover: () => migrationSerial(async () => {}),
  withSkillRead: work => migrationSerial(work),
  scan: migrationScan,
  apply: migrationApply,
  undo: migrationUndo,
  recycle: migrationRecycle,
  copySkills: migrationCopySkills,
});
