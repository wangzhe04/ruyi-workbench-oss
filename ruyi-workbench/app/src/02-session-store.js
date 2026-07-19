// ===== v1.9 会话存储 v2(head JSON + append-only NDJSON 正文)=====================================
// 背景:旧格式把整个 messages+providerHistory 塞进单个 <id>.json,saveSession 每轮全量序列化+原子重写
// —— 写放大 O(会话总历史)/轮:5MB 会话 = 每轮重写 5MB。v2 拆分为:
//   <id>.json              「头」:全部标量/小字段 + messageCount/providerHistoryCount + storageVersion:2(小,每次重写)
//   <id>.messages.ndjson   展示消息正文,一行一条 JSON,append-only
//   <id>.provider.ndjson   provider 引擎历史正文,同上
// 快路径(saveSession):两个数组只在尾部增长 → 每文件一次 append,O(增量)/轮。
// 慢路径(全量重写正文):任何前缀变化自动触发 —— rewind(slice)/compaction(reseed)/pop/蒸发改写。
// 检测机制【不靠调用方自觉打标记】:进程内状态表存每行的 sha1-16 hash,save 时前缀逐行重算比对;
// 任何对不上(含未来新代码忘了声明的中间改写)都安全降级为全量重写 —— 失配只可能损失性能,不可能丢数据。
// 崩溃语义:头是提交点(正文先写、头后写)。append 崩溃中途 → 无 \n 终结的撕裂尾行,读取时物理截断;
// append 完成但头写未完成 → 正文比头声明的多出「未提交尾巴」,读取时按头计数截断;慢路径(全量重写)
// 崩溃 → .prevbody 快照(重写前旧正文)恢复与旧头重新配对;正文比头声明的短 / 中间行损坏且无快照可退
// = 真损坏 → v1bak 回退(迁移期)或隔离为 .corrupt(与旧单文件损坏同纪律)。
// 迁移:legacy <id>.json 首次 load 时原样备份 <id>.json.v1bak 再落 v2;v2 下次成功读取后自动删 v1bak。
const SESSION_STORAGE_VERSION = 2;
function sessionBodyPaths(id) {
  return {
    messages: path.join(paths.sessions, `${id}.messages.ndjson`),
    provider: path.join(paths.sessions, `${id}.provider.ndjson`),
  };
}
function sessionLineHash(line) {
  return crypto.createHash('sha1').update(line).digest('hex').slice(0, 16);
}
// 进程内「已落盘正文」状态:id → { msgHashes:[sha1-16/行], provHashes:[...], bodiesOk }
// bodiesOk=false 表示上次正文写失败(可能半成品)→ 下次 save 强制全量重写自愈。
// 内存占用 16B/行,万行会话 ≈ 160KB,可忽略;进程重启后由 loadSession 重建。
const sessionBodyState = new Map();
// 读一个 NDJSON 正文文件。返回 { entries, hashes } | null(文件缺失) | { corrupt:true }(中间行坏)。
// 崩溃语义:写入侧永远「整行 + 尾随 \n」一次 append,所以【无 \n 终结的尾行 = 撕裂】(append 崩溃中途,
// 其所属的头写未完成,等于那次 save 没发生)—— 发现即【物理截断】到最后一个好行边界,而不是只在内存里
// 容忍:否则磁盘上留着半行,下次快路径 append 会接在撕裂字节之后,把新的真消息焊进坏行 → 中间坏行 →
// 整个会话被判 corrupt 隔离(真丢数据)。中间空行/坏行一律 corrupt(不应发生,发生即数据事故)。
async function readSessionBodyFile(p) {
  let txt;
  try { txt = await fsp.readFile(p, 'utf8'); } catch { return null; }
  const lines = txt.split('\n');
  const entries = [], hashes = [], lineEndBytes = [];
  let goodBytes = 0; // 已确认好行的 utf8 字节数(含每行结尾 \n),撕裂截断点
  let torn = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === lines.length - 1) { // split 尾元:文件以 \n 结尾 → '';非空 = 无终结尾行(撕裂)
      if (line !== '') torn = true;
      break;
    }
    if (line === '') return { corrupt: true }; // 中间空行 = 坏
    try { entries.push(JSON.parse(line)); }
    catch { return { corrupt: true }; } // 中间坏行 = 坏
    hashes.push(sessionLineHash(line));
    goodBytes += Buffer.byteLength(line, 'utf8') + 1;
    lineEndBytes.push(goodBytes);
  }
  if (torn) await fsp.truncate(p, goodBytes).catch(() => {}); // 截断失败 → 下次 load 再试,不阻塞读取
  return { entries, hashes, lineEndBytes };
}
// 快路径判定:entries 的前 persistedHashes.length 行逐行 hash 全等 → 返回 {appendLines, appendHashes, allHashes};
// 否则(前缀变/缩短/无状态)返回 null → 调用方全量重写。注意:必须逐行重算 hash,不能只比长度+尾行 ——
// 蒸发(evaporateHistory)会在保持长度不变的情况下原地改写中间行的 content。
function planSessionBodyAppend(entries, persistedHashes) {
  if (!persistedHashes || persistedHashes.length > entries.length) return null;
  const allHashes = new Array(entries.length);
  const allLines = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    let line;
    try { line = JSON.stringify(entries[i]); } catch { return null; } // 不可序列化 → 全量重写兜底
    const h = sessionLineHash(line);
    if (i < persistedHashes.length && h !== persistedHashes[i]) return null; // 前缀变 → 全量重写
    allHashes[i] = h;
    allLines[i] = line;
  }
  return {
    appendLines: allLines.slice(persistedHashes.length),
    appendHashes: allHashes.slice(persistedHashes.length),
    allLines,
    allHashes,
  };
}
// 全量重写用的整体序列化(行数组 + hash 数组)。返回 null = 有条目不可序列化(调用方跳过正文写并标
// bodiesOk=false —— 宁可下次再试,绝不写出半个正文文件)。
function serializeSessionBody(entries) {
  const lines = new Array(entries.length), hashes = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    let line;
    try { line = JSON.stringify(entries[i]); } catch { return null; }
    lines[i] = line;
    hashes[i] = sessionLineHash(line);
  }
  return { lines, hashes };
}
function sessionBodyText(lines) { return lines.length ? lines.join('\n') + '\n' : ''; }

// ===== PF2: session metadata index (sessions/index.json) =====================================================
// listSessions used to JSON.parse EVERY session file in full just to show 7 sidebar fields, and saveSession
// rewrote each session whole; both costs grow with session count/size. We keep a lightweight index of just
// those 7 fields, incrementally maintained by saveSession/deleteSession. CRITICAL SAFETY INVARIANT: the index
// is ONLY a cache; each per-session JSON file remains the single source of truth. listSessions trusts the
// index only when its id-set EXACTLY matches the session files on disk; on any mismatch/missing/corrupt index
// it falls back to scanning the real files (and rebuilds the index). On any index write failure we DELETE the
// index so the next read rebuilds from truth. Sessions are single-writer (the serve process only; the MCP
// child never writes session files), so a process-global write lock is enough to serialize index mutations.
const SESSION_INDEX_FILE = 'index.json';
function sessionIndexPath() { return path.join(paths.sessions, SESSION_INDEX_FILE); }

// The 7 sidebar fields. Accepts a full session (has .messages) OR an index entry (has .messageCount), so the
// same shaper builds index entries and normalizes them on read.
function sessionMeta(o) {
  return {
    id: o.id,
    title: o.title,
    summary: o.summary || '',
    cwd: o.cwd,
    pinned: Boolean(o.pinned),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    messageCount: Number.isFinite(o.messageCount) ? o.messageCount : (o.messages?.length || 0),
  };
}
function sortSessionMetas(arr) {
  return arr.slice().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
// Read the index array, or null when missing/corrupt/not-an-array (caller falls back to a full scan).
async function readSessionIndex() {
  try {
    const raw = await fsp.readFile(sessionIndexPath(), 'utf8');
    const arr = safeJsonParse(raw, null);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
// Atomic index write (tmp + rename, same discipline as saveSession). Caller wraps failures.
async function writeSessionIndex(entries) {
  await fsp.mkdir(paths.sessions, { recursive: true });
  await atomicWriteJson(sessionIndexPath(), entries);   // 25.1 收编
}
async function invalidateSessionIndex() { await fsp.unlink(sessionIndexPath()).catch(() => {}); }
// Serialize all index mutations (single global chain) so concurrent saveSession calls can't lose updates or
// tear the file. Session FILES are still written concurrently; only the shared index write is serialized.
let sessionIndexChain = Promise.resolve();
async function withSessionIndexLock(work) {
  const previous = sessionIndexChain || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  sessionIndexChain = current;
  try { return await current; }
  finally { if (sessionIndexChain === current) sessionIndexChain = Promise.resolve(); }
}
// COALESCED index maintenance. saveSession/deleteSession call scheduleSessionIndexUpdate synchronously (a cheap
// in-memory Map.set); the actual read-modify-write of index.json is DEBOUNCED and batched. This matters two ways:
//  (1) it keeps the saveSession critical path free of index I/O (turns/workflows call it constantly), and
//  (2) a burst of N saves (e.g. a DAG workflow) collapses into ONE index write instead of N, so the background
//      I/O never floods the event loop and delays incoming request handling.
// Durability: the pending batch is in-memory only. Losing it on crash is harmless — the session FILES are the
// source of truth and listSessions rebuilds the index whenever its id-set drifts from disk.
const SESSION_TOMBSTONE = Symbol('session-deleted');
const SESSION_INDEX_FLUSH_MS = 200;
let pendingSessionIndex = new Map(); // id -> meta entry | SESSION_TOMBSTONE (last write per id wins)
let sessionIndexFlushTimer = null;
function scheduleSessionIndexUpdate(id, valueOrTombstone) {
  pendingSessionIndex.set(String(id), valueOrTombstone);
  if (sessionIndexFlushTimer) return; // a flush is already pending; this entry rides along with it
  sessionIndexFlushTimer = setTimeout(() => { sessionIndexFlushTimer = null; void flushSessionIndex(); }, SESSION_INDEX_FLUSH_MS);
  if (sessionIndexFlushTimer.unref) sessionIndexFlushTimer.unref(); // a cache flush must never keep the process alive
}
// Apply the whole pending batch in a single locked read-modify-write. Best-effort: if there is no valid index
// we drop the batch (listSessions rebuilds from truth); on any error we invalidate so the next read falls back.
async function flushSessionIndex() {
  if (!pendingSessionIndex.size) return;
  const batch = pendingSessionIndex; pendingSessionIndex = new Map(); // take-and-clear so saves during the I/O queue up
  return withSessionIndexLock(async () => {
    try {
      const index = await readSessionIndex();
      if (!index) return; // no valid index → don't fabricate a partial one; listSessions will rebuild
      const map = new Map(index.map(e => [String(e && e.id), e]));
      for (const [id, val] of batch) { if (val === SESSION_TOMBSTONE) map.delete(id); else map.set(id, val); }
      await writeSessionIndex([...map.values()]);
    } catch { await invalidateSessionIndex(); }
  }).catch(() => {});
}
// PF2 fix: SYNCHRONOUS flush for the exit path. process.exit() (the SIGINT/SIGTERM handlers, uncaughtException)
// runs 'exit' listeners synchronously, so the async debounced flushSessionIndex above can never complete there —
// a graceful shutdown would silently drop the last ~200ms of metadata updates. Persist the pending batch with
// fs.*Sync using the SAME tmp+rename atomic discipline. Best-effort: on a missing/corrupt index or any error we
// bail (the boot-time invalidateSessionIndex + fallback file scan rebuild from truth regardless).
function flushSessionIndexSync() {
  try {
    if (!pendingSessionIndex.size) return;
    const batch = pendingSessionIndex; pendingSessionIndex = new Map();
    let index = null;
    try { const arr = safeJsonParse(fs.readFileSync(sessionIndexPath(), 'utf8'), null); index = Array.isArray(arr) ? arr : null; } catch { index = null; }
    if (!index) return; // no valid index → don't fabricate a partial one; boot rebuild + fallback scan self-heal
    const map = new Map(index.map(e => [e && String(e.id), e]).filter(([id]) => id));
    for (const [id, val] of batch) { if (val === SESSION_TOMBSTONE) map.delete(id); else map.set(id, val); }
    // 25.1: 这是全文件唯一豁免 atomicWriteJson 的 JSON 写点 —— exit 监听器里只能同步 I/O(async 版永远跑不完)。
    // tmp 名仍按统一纪律取唯一名(pid+随机),防与并行的 async 写者互踩;失败清 tmp。
    const finalPath = sessionIndexPath();
    const tmpPath = finalPath + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify([...map.values()], null, 2), 'utf8');
      fs.renameSync(tmpPath, finalPath);
    } catch (e) { try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ } throw e; }
  } catch { /* best-effort; boot invalidation rebuilds from truth regardless */ }
}

// List sessions for the sidebar (7 meta fields each). FAST PATH: a valid index whose id-set matches the
// session files on disk exactly. FALLBACK: scan every real session file (source of truth) and rebuild the index.
async function listSessions() {
  await ensureDirs();
  const all = await fsp.readdir(paths.sessions).catch(() => []);
  const files = all.filter(f => f.endsWith('.json') && f !== SESSION_INDEX_FILE);
  const diskIds = new Set(files.map(f => f.slice(0, -5))); // strip '.json'
  const index = await readSessionIndex();
  if (index) {
    // PF2 fix: overlay the not-yet-flushed in-memory batch onto the disk index BEFORE trusting it. The index
    // write is debounced ~200ms, so a read landing inside that window would otherwise serve a stale title /
    // messageCount / pin (or miss a brand-new session, or still show a just-deleted one). The pending batch is
    // exactly the data the flush will persist (last-write-per-id already applied), so merging it makes a live
    // read never staler than the most recent saveSession/deleteSession — closing the debounce dirty-read window.
    const map = new Map(index.map(e => [e && String(e.id), e]).filter(([id]) => id));
    for (const [id, val] of pendingSessionIndex) { if (val === SESSION_TOMBSTONE) map.delete(id); else map.set(id, val); }
    const indexIds = new Set(map.keys());
    if (indexIds.size === diskIds.size && [...diskIds].every(id => indexIds.has(id))) {
      return sortSessionMetas([...map.values()].map(sessionMeta)); // trust cache+pending: id-set matches disk exactly
    }
  }
  // Index missing / corrupt / drifted from disk → authoritative scan of the real files, then rebuild the index.
  const sessions = [];
  for (const file of files) {
    try {
      const raw = await fsp.readFile(path.join(paths.sessions, file), 'utf8');
      const item = JSON.parse(raw);
      sessions.push(sessionMeta(item));
    } catch {
      // Ignore corrupt session files.
    }
  }
  await withSessionIndexLock(() => writeSessionIndex(sessions)).catch(() => {}); // best-effort rebuild
  return sortSessionMetas(sessions);
}

async function updateSessionMeta(id, patch) {
  const session = await loadSession(id);
  if (!session) return null; // missing/corrupt — caller maps to 404
  if (typeof patch.title === 'string') session.title = patch.title.slice(0, 200);
  if (typeof patch.pinned === 'boolean') session.pinned = patch.pinned;
  // v0.9-S3 (C3): the top-bar working-folder picker + folder-drag switch persist the session's cwd here.
  // Resolve to an absolute path (mirrors normalizeCwd); a blank/non-string value is ignored (never clears
  // an existing cwd). The turn engine reads `cwd || session.cwd`, so this becomes the working dir for the
  // next turn. No existence check — a stale/moved folder simply resolves at run time like any manual entry.
  if (typeof patch.cwd === 'string' && patch.cwd.trim()) session.cwd = path.resolve(patch.cwd.trim());
  await saveSession(session);
  return session;
}

// Delete the persisted chat itself. `purgeAssociated` is deliberately opt-in: a normal single-chat
// delete keeps its previous, conservative behavior, while the batch-cleanup flow can also reclaim
// the per-chat recovery and workflow records that otherwise have their own GC lifecycle.
async function deleteSession(id, { purgeAssociated = false } = {}) {
  stopSession(id, 'deleted');
  try { revokeAllGrants(id, 'session-deleted'); } catch { /* best-effort */ } // 第27波:会话销毁 → 授权书全清
  await fsp.unlink(sessionPath(id)).catch(() => {}); // idempotent
  // v1.9 存储 v2:正文/迁移备份/损坏隔离副本一并清(用户删会话 = 删除其全部数据载体)。
  const bp = sessionBodyPaths(id);
  await Promise.all([
    fsp.unlink(bp.messages).catch(() => {}),
    fsp.unlink(bp.provider).catch(() => {}),
    fsp.unlink(sessionPath(id) + '.v1bak').catch(() => {}),
    fsp.unlink(sessionPath(id) + '.corrupt').catch(() => {}),
    fsp.unlink(bp.messages + '.corrupt').catch(() => {}),
    fsp.unlink(bp.provider + '.corrupt').catch(() => {}),
    fsp.unlink(bp.messages + '.prevbody').catch(() => {}),
    fsp.unlink(bp.provider + '.prevbody').catch(() => {}),
  ]);
  sessionBodyState.delete(id);
  if (purgeAssociated) {
    await Promise.all([
      fsp.rm(journalDir(id), { recursive: true, force: true }).catch(() => {}),
      fsp.rm(agentRunDir(id), { recursive: true, force: true }).catch(() => {}),
    ]);
  }
  scheduleSessionIndexUpdate(id, SESSION_TOMBSTONE); // PF2: queue removal from the metadata index (debounced; see saveSession)
  return { ok: true, id, purgedAssociated: Boolean(purgeAssociated) };
}

// Safety-first bulk history cleanup. It can only delete UNPINNED chats, preserves the explicitly
// supplied current chat, and refuses to tear down a currently-running chat. This keeps the UI action
// useful for clearing history without turning a single misclick into a "delete everything" operation.
async function bulkDeleteUnpinnedSessions({ preserveSessionId, purgeAssociated = false } = {}) {
  const preserveId = safeSessionId(preserveSessionId);
  const sessions = await listSessions();
  const deleted = [];
  const skipped = { pinned: 0, preserved: 0, active: 0 };
  for (const meta of sessions) {
    if (!meta || !meta.id) continue;
    if (meta.pinned) { skipped.pinned++; continue; }
    if (preserveId && meta.id === preserveId) { skipped.preserved++; continue; }
    if (activeChildren.has(meta.id)) { skipped.active++; continue; }
    await deleteSession(meta.id, { purgeAssociated });
    deleted.push(meta.id);
  }
  return { ok: true, deleted, deletedCount: deleted.length, skipped, purgedAssociated: Boolean(purgeAssociated) };
}

// v0.8-S0: fold an older/partial session onto the current schema. Mirrors normalizeConfig's shape:
// returns { session, changed }. Backfills schemaVersion + turnSeq and guarantees the array fields so
// no downstream code has to defend against missing/typo'd properties.
function normalizeSession(raw) {
  const session = (raw && typeof raw === 'object') ? raw : {};
  let changed = false;
  if (session.schemaVersion !== SESSION_SCHEMA) { session.schemaVersion = SESSION_SCHEMA; changed = true; }
  // turnSeq is the session-level monotonic turn counter (checkpoint/rewind/summary primary key). Old
  // sessions predate it → backfill 0. A non-finite value is treated as absent.
  if (!Number.isFinite(session.turnSeq)) { session.turnSeq = 0; changed = true; }
  if (!Array.isArray(session.messages)) { session.messages = []; changed = true; }
  if (!Array.isArray(session.providerHistory)) { session.providerHistory = []; changed = true; }
  // Cursor into display `messages` that has already been mirrored into providerHistory. It is optional on
  // legacy sessions; runOpenAiTurn derives a safe migration point before the first new Provider turn.
  if (session.providerHistoryCursor !== undefined &&
      (!Number.isInteger(session.providerHistoryCursor) || session.providerHistoryCursor < 0)) {
    delete session.providerHistoryCursor;
    changed = true;
  }
  if (!Array.isArray(session.attachments)) { session.attachments = []; changed = true; }
  // v0.8-S3: todo list (TodoWrite). Old sessions predate it → backfill empty array.
  if (!Array.isArray(session.todos)) { session.todos = []; changed = true; }
  // 第26波b: 任务账本(MissionSpec)。默认 null(无任务)。旧会话无此键 → 保持 null。
  if (session.mission !== null && session.mission !== undefined && typeof session.mission !== 'object') { session.mission = null; changed = true; }
  if (session.mission === undefined) { session.mission = null; changed = true; }
  // v1 技能体系: 会话启用的技能数组(上限 8)。P2-2: 元素为 {id, source} 对象 —— source 锁定「启用当时的注册表
  // 来源」(builtin/user/project),据此在解析时校验来源未被调包(防换 cwd 后同 id 项目技能静默顶替内置技能)。
  // 向后兼容: 旧裸字符串 id 视为 {id, source:''}(source 空 = 宽松匹配一次),本次 normalize 即固化为对象结构。
  {
    const cleaned = [];
    const seenIds = new Set();
    for (const raw of (Array.isArray(session.skills) ? session.skills : [])) {
      let id = '', source = '';
      if (typeof raw === 'string') { id = raw.trim(); } // 旧裸字符串 → source 空(宽松,下次启用时才锁定来源)
      else if (raw && typeof raw === 'object') { id = String(raw.id || '').trim(); source = String(raw.source || '').trim(); }
      if (!SKILL_ID_RE.test(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      cleaned.push({ id, source });
      if (cleaned.length >= 8) break;
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(session.skills)) { session.skills = cleaned; changed = true; }
  }
  // v2 跨会话记忆: session.memories = [{id, scope:'global'|'project'}] (上限 8),{id,scope} 锁定来源(同技能 P2-2);
  // session.memoriesExplicit = 用户是否显式设置过(false=默认策略:项目记忆自动启用、global 手动)。
  {
    const cleaned = [];
    const seen = new Set();
    for (const raw of (Array.isArray(session.memories) ? session.memories : [])) {
      const id = String((raw && typeof raw === 'object' && raw.id) || '').trim();
      if (!SKILL_ID_RE.test(id)) continue;
      const scope = (raw && raw.scope === 'global') ? 'global' : 'project';
      const key = scope + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      // P3-3: 保留 project 条目启用时锁定的 projectKey(渐进迁移:旧数据无此字段→保持缺省=宽松匹配,下次经
      // POST /api/session/memories 固化;同 Skills P2-2 的 source 渐进迁移)。仅接受 16-hex 合法值,防脏字段注入。
      const entry = { id, scope };
      if (scope === 'project') { const pk = String((raw && raw.projectKey) || '').trim(); if (/^[a-f0-9]{16}$/.test(pk)) entry.projectKey = pk; }
      cleaned.push(entry);
      if (cleaned.length >= 8) break;
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(session.memories)) { session.memories = cleaned; changed = true; }
    if (typeof session.memoriesExplicit !== 'boolean') { session.memoriesExplicit = false; changed = true; }
  }
  return { session, changed };
}

// v0.8-S3: sanitize a todo_write items payload (full-replace semantics; the SAME normalizer is used by
// the provider-engine special-case, the /api/todo endpoint, and the generic toolCall path). Rules: array
// capped at 50 entries; text coerced to string and capped at 200 chars; status defaults to 'pending' when
// missing/invalid; id defaults to t1..tN when absent. Non-array input yields an empty list.
const TODO_MAX_ITEMS = 50;
const TODO_MAX_TEXT = 200;
function normalizeTodoItems(raw) {
  const arr = Array.isArray(raw) ? raw.slice(0, TODO_MAX_ITEMS) : [];
  return arr.map((it, i) => {
    const o = (it && typeof it === 'object') ? it : {};
    const status = (o.status === 'in_progress' || o.status === 'done') ? o.status : 'pending';
    const text = String(o.text == null ? '' : o.text).slice(0, TODO_MAX_TEXT);
    const id = (o.id != null && String(o.id).trim()) ? String(o.id).slice(0, 64) : `t${i + 1}`;
    return { id, text, status };
  });
}

// ============================================================================
// 第26波b(AUTONOMY-PLAN §26b):任务账本(MissionSpec)—— 长任务的「目标—验收—预算」权威状态,存 session.mission
// (随会话走,免疫压缩:账本不在 messages 里),驱动 until-done 续跑。规范器同款三路复用(工具/API/驱动器)。
//  · milestones[].check:机器可判定优先(command 跑进程判退出码/输出、file_exists 判文件在)、'none' 由模型自报;
//  · budget.maxAutoTurns:无人值守自动续跑硬上限;spent 累计;autoMode:off|until-done|supervised;
//  · stall:digest K 轮不变即停滞;replans:重规划次数(硬限)。
const MISSION_MAX_MILESTONES = 16;
const MISSION_MAX_TEXT = 400;
const MISSION_MAX_CONSTRAINTS = 12;
const MISSION_DEFAULT_MAX_TURNS = 12;
const MISSION_REPLAN_LIMIT = 2;
const MISSION_STALL_LIMIT = 3;
// 对抗轮 P1(第26波b): check.cmd 是【驱动器每轮无提示 shell 执行】的输入 —— 绝不能被【模型】设置,否则
// 提示注入 = 绕过整个权限系统的任意命令执行。`trusted` 门:仅用户(经 UI header token 的 /api/mission)可定义
// command 检查;不可信来源(模型 mission_update 工具 / body-token loopback)的 command 检查一律降级为 'none'。
// file_exists(纯 fsp.access 只读)风险低,但路径可越工作区探测,故也仅 trusted 可设 —— 不可信一律 'none'。
function normalizeMissionCheck(raw, trusted) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  let type = (o.type === 'command' || o.type === 'file_exists') ? o.type : 'none';
  if (!trusted && type !== 'none') type = 'none'; // 不可信来源禁设任何机器检查(只能自报 status/evidence)
  const check = { type };
  if (type === 'command') { check.cmd = String(o.cmd == null ? '' : o.cmd).slice(0, 500); if (o.expect != null) check.expect = String(o.expect).slice(0, 200); }
  else if (type === 'file_exists') check.path = String(o.path == null ? '' : o.path).slice(0, 500);
  return check;
}
// trusted 默认 true:内部深拷(applyMissionUpdate 的 normalizeMission({}, prev))必须原样保留 prev 里【已在可信
// 来源校验过】的检查;仅当里程碑来自【新输入 o.milestones】时才按调用方 trusted 门控(见 fromRaw 判定)。
function normalizeMission(raw, prev, trusted = true) {
  if (raw === null) return null; // 显式清空
  const o = (raw && typeof raw === 'object') ? raw : {};
  const p = (prev && typeof prev === 'object') ? prev : {};
  const fromRaw = Array.isArray(o.milestones);
  const rawMs = fromRaw ? o.milestones : (Array.isArray(p.milestones) ? p.milestones : []);
  const seen = new Set();
  const milestones = rawMs.slice(0, MISSION_MAX_MILESTONES).map((m, i) => {
    const mo = (m && typeof m === 'object') ? m : {};
    let id = (mo.id != null && String(mo.id).trim()) ? String(mo.id).trim().slice(0, 64) : `m${i + 1}`;
    while (seen.has(id)) id = id + '_'; seen.add(id);
    const status = (mo.status === 'done' || mo.status === 'blocked') ? mo.status : 'pending';
    // 新输入的 check 按 trusted 门控;prev 深拷的 check 视为已可信(原样保留)。
    return { id, desc: String(mo.desc == null ? '' : mo.desc).slice(0, MISSION_MAX_TEXT), status, check: normalizeMissionCheck(mo.check, fromRaw ? trusted : true), evidence: mo.evidence ? String(mo.evidence).slice(0, MISSION_MAX_TEXT) : '' };
  });
  const budgetIn = (o.budget && typeof o.budget === 'object') ? o.budget : (p.budget || {});
  const maxAutoTurns = Math.max(1, Math.min(50, Math.round(Number(budgetIn.maxAutoTurns) || MISSION_DEFAULT_MAX_TURNS)));
  const spentIn = (p.spent && typeof p.spent === 'object') ? p.spent : {};
  const autoMode = ['off', 'until-done', 'supervised'].includes(o.autoMode) ? o.autoMode : (['off', 'until-done', 'supervised'].includes(p.autoMode) ? p.autoMode : 'off');
  return {
    goal: String(o.goal != null ? o.goal : (p.goal || '')).slice(0, 2000),
    milestones,
    constraints: (Array.isArray(o.constraints) ? o.constraints : (Array.isArray(p.constraints) ? p.constraints : [])).slice(0, MISSION_MAX_CONSTRAINTS).map(c => String(c || '').slice(0, MISSION_MAX_TEXT)).filter(Boolean),
    budget: { maxAutoTurns, maxTokens: Number.isFinite(Number(budgetIn.maxTokens)) ? Math.max(0, Math.round(Number(budgetIn.maxTokens))) : 0 },
    spent: { autoTurns: Math.max(0, Number(spentIn.autoTurns) || 0), tokens: Math.max(0, Number(spentIn.tokens) || 0) },
    autoMode,
    stall: { lastDigest: String((p.stall && p.stall.lastDigest) || ''), sameCount: Math.max(0, Number(p.stall && p.stall.sameCount) || 0) },
    replans: Math.max(0, Number(p.replans) || 0),
    // 对抗轮 P2(#6): 保留 budgetExhaustedAt —— 它是"本任务预算已耗尽并记过账"的持久标记,update 再武装(prev 深拷)
    // 必须保住它,否则再耗尽会二次落 mission_budget_exhausted 使超支率 >100%;全新 start(prev=null → p={})自然清空,
    // 新任务的耗尽正常重记。budget 无法经 update 抬高(applyMissionUpdate 不碰 budget),故不需"抬预算才清"的额外逻辑。
    budgetExhaustedAt: String(p.budgetExhaustedAt || ''),
    createdAt: p.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}
// 第26波b: 增量更新账本(mission_update 工具 / API update)—— 按 id 【合并】里程碑,不整表替换。
// 已存在的 id → 更新 status/evidence/desc(只更新提供的字段);新 id → 追加(受 16 上限);goal 提供才改。
// 关键:与 normalizeMission(full-replace,用于 start)语义相反 —— 模型只报"m2 done"时不能抹掉 m1/m3。
// trusted:是否可信来源(用户经 UI header token)。不可信(模型 mission_update / body-token loopback)时:
//  ① 不得设置/修改任何机器 check(P1 关键——防模型注入 check.cmd 让驱动器无提示 shell 执行);
//  ② 不得把已 done 的里程碑回退为 pending(P3——防模型靠 done→pending 抖动无限拖住 until-done 循环)。
function applyMissionUpdate(prev, patch, trusted = false) {
  if (!prev) return prev;
  const p = (patch && typeof patch === 'object') ? patch : {};
  const next = normalizeMission({}, prev); // 深拷现有(经规范化;prev 的 check 视为已可信,原样保留)
  if (p.goal != null) next.goal = String(p.goal).slice(0, 2000);
  const ups = Array.isArray(p.milestones) ? p.milestones : [];
  const byId = new Map(next.milestones.map(m => [m.id, m]));
  for (const u of ups) {
    const uo = (u && typeof u === 'object') ? u : {};
    const id = String(uo.id || '').trim().slice(0, 64);
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      if (uo.status === 'done' || uo.status === 'blocked' || uo.status === 'pending') {
        // 对抗轮 P3: 不可信来源不得把 done 回退为 pending/blocked(防抖动拖住循环);pending↔blocked、→done 允许。
        if (!(existing.status === 'done' && uo.status !== 'done' && !trusted)) existing.status = uo.status;
      }
      if (uo.desc != null) existing.desc = String(uo.desc).slice(0, MISSION_MAX_TEXT);
      if (uo.evidence != null) existing.evidence = String(uo.evidence).slice(0, MISSION_MAX_TEXT);
      // 对抗轮 P1: check 仅 trusted(用户 UI)可改;不可信(模型/loopback)的 uo.check 一律忽略 —— 保留原检查。
      if (uo.check && trusted) existing.check = normalizeMissionCheck(uo.check, true);
    } else if (next.milestones.length < MISSION_MAX_MILESTONES) {
      // 新里程碑的 check 同样按 trusted 门控:模型新增里程碑不能自带机器检查(降级 'none')。
      const nm = { id, desc: String(uo.desc || '').slice(0, MISSION_MAX_TEXT), status: (uo.status === 'done' || uo.status === 'blocked') ? uo.status : 'pending', check: normalizeMissionCheck(uo.check, trusted), evidence: uo.evidence ? String(uo.evidence).slice(0, MISSION_MAX_TEXT) : '' };
      next.milestones.push(nm); byId.set(id, nm);
    }
  }
  next.updatedAt = nowIso();
  return next;
}
// 账本进度指纹(停滞检测用)。对抗轮 P3: 除 status 外并入 evidence 长度桶 —— 一个粗粒度大里程碑上模型持续
// 工作、经 mission_update 更新 evidence 但尚未翻 status,也算「有进展」不误判停滞;真正原地打转(账本零变化)
// 才连续 K 轮同指纹触发降级。桶而非全文,避免 evidence 微小抖动被当进展(仍需实质增长才换桶)。
function missionProgressDigest(mission) {
  if (!mission || !Array.isArray(mission.milestones)) return '';
  return mission.milestones.map(m => m.id + ':' + m.status + ':' + Math.floor(String(m.evidence || '').length / 20)).join(' ');
}
// 执行一条里程碑的机器验收(command 判退出码+可选输出包含;file_exists 判在)。'none' 返回 null(交模型自报)。
// 只读判定,不改文件;command 走工作区 cwd,复用 runProcess 基建;绝不用于副作用。
async function evaluateMissionCheck(check, cwd) {
  if (!check || check.type === 'none') return null;
  try {
    if (check.type === 'file_exists') {
      const p = path.resolve(cwd || '.', String(check.path || ''));
      // 对抗轮 P3: 限定在工作区内 —— file_exists 路径可为绝对/../ 穿越,即便只读(fsp.access)也是任意路径存在性
      // 探测(信息泄露)。仅当解析后落在 cwd 内才判定,越界一律「不适用」(不泄露)。
      const base = path.resolve(cwd || '.');
      if (p !== base && !p.startsWith(base + path.sep)) return { pass: false, detail: '路径超出工作区,已跳过验收' };
      try { await fsp.access(p); return { pass: true, detail: '文件存在: ' + check.path }; }
      catch { return { pass: false, detail: '文件不存在: ' + check.path }; }
    }
    if (check.type === 'command') {
      if (!String(check.cmd || '').trim()) return { pass: false, detail: '空命令' };
      // shell:true 让整条命令串按用户书写执行(判定性只读用途;超时 60s;工作区 cwd)。
      const r = await runProcess(String(check.cmd), [], { timeoutMs: 60000, cwd: cwd || process.cwd(), shell: true }).catch(e => ({ code: -1, stdout: '', stderr: String(e && e.message || e) }));
      const out = String((r.stdout || '') + (r.stderr || ''));
      const codeOk = Number(r.code) === 0;
      const expectOk = check.expect ? out.includes(String(check.expect)) : true;
      return { pass: codeOk && expectOk, detail: `退出码=${r.code}${check.expect ? (expectOk ? ' · 命中期望' : ' · 未命中期望「' + check.expect + '」') : ''}` };
    }
  } catch (e) { return { pass: false, detail: '验收异常: ' + String(e && e.message || e).slice(0, 200) }; }
  return null;
}

// v0.8-S3/S4a: derive a turn_summary from the turn's tool records + checkpoint journal. Both engines call
// this with their own toolCalls array (provider: {name,input,result}; claude: {name,input,result} where
// result is the raw MCP text) AND this turn's journal entries (index rows for this turnSeq). DATA SOURCE:
//  - journal entries (S4a) are the authoritative source for file changes: merged into filesChanged by
//    path, their `op` (create/modify/delete) is used (more accurate than the tool record's guess), and
//    they are `revertible:true` (skipped:true entries stay revertible:false — no `before` was stored);
//  - tool records supply files NOT covered by the journal (e.g. CLI-native tools) at revertible:false,
//    and the command count. When a path appears in BOTH, the journal entry wins.
//  Rules:
//  - file_write → op create/modify; file_edit → modify; file_delete → delete; path=input.path
//  - powershell_run/script_run/shell_send (and, for the claude engine, any non-workbench-file tool) → commands+1
//  - artifacts is always [] (field established for C4/v0.9).
const TURN_SUMMARY_FILE_TOOLS = new Set(['file_write', 'file_edit', 'file_delete']);
const TURN_SUMMARY_COMMAND_TOOLS = new Set(['powershell_run', 'script_run', 'shell_send']);
// v0.9-S4 (C4): classify an artifact by file-name suffix. img/md/csv/txt/html/xlsx/docx/pdf → distinct
// kinds (drive the gallery's per-kind preview branch); everything else → 'other'. Extension-only (no I/O).
const ARTIFACT_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']);
function kindForPath(p) {
  const ext = String(path.extname(String(p || '')).replace(/^\./, '')).toLowerCase();
  if (ARTIFACT_IMG_EXTS.has(ext)) return 'img';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'csv') return 'csv';
  if (ext === 'txt') return 'txt';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'docx') return 'docx';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}
// v0.9-S4: keys a bridged/creation tool result may use to report a file it produced (ACC document creation,
// screenshot tools, office bridges all echo one of these). Harvested into turn_summary.artifacts alongside
// this turn's journal `create` entries. Purely a hint source — never a security boundary (the preview
// endpoint re-checks every path against the allowed roots regardless of how it entered a summary).
const ARTIFACT_OUTPUT_PATH_KEYS = ['output_path', 'outputPath', 'saved_path', 'savedPath'];
// v1.5-W1.5: ACC(官方原生 MCP)的写族文档工具返回 {success:true, path:...} —— 裸 `path` 不在
// ARTIFACT_OUTPUT_PATH_KEYS 里(读类工具 read_document/file_info 也回 path,加进去会把「读过的文件」误登记
// 为产物)。所以对 bridged 工具改用「工具名限定的 path 收割」:仅当工具名匹配写族时,才把结果里的字符串
// `path` 当产物。这是对已装 旧版 ACC(未回 output_path)的兼容层;新版 ACC 已同时回 output_path,走上面的
// 通用键即可。判定纯按名字前缀 + 结果 success:true,不做 I/O。裸名(去 serverId__ 前缀)参与匹配。
// 明确写族名(ACC 与常见 office bridge):write_document/write_excel/write_pdf/write_docx。
const ARTIFACT_BRIDGED_WRITE_NAMES = new Set(['write_docx', 'write_excel', 'write_pdf', 'write_document']);
// 前缀写族:名字以这些开头的 bridged 工具也算「产出文件」(create_*/export_*/save_*/write_*)。
const ARTIFACT_BRIDGED_WRITE_PREFIXES = ['write_', 'create_', 'export_', 'save_'];
// 去掉 bridged 工具的 serverId__ 前缀,取裸工具名(collectBridgedTools 用 `${prefix}__${toolName}` 拼接)。
function unprefixedBridgedName(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('__');
  return i >= 0 ? s.slice(i + 2) : s;
}
function isBridgedWriteTool(name) {
  const bare = unprefixedBridgedName(name);
  if (ARTIFACT_BRIDGED_WRITE_NAMES.has(bare)) return true;
  return ARTIFACT_BRIDGED_WRITE_PREFIXES.some(p => bare.startsWith(p));
}
// Workbench tools whose effect we can attribute precisely; anything the claude CLI runs OUTSIDE this set
// (native Edit/Write/Bash, which never reach toolCall) only counts as a command.
const TURN_SUMMARY_KNOWN_TOOLS = new Set([
  ...TURN_SUMMARY_FILE_TOOLS, ...TURN_SUMMARY_COMMAND_TOOLS,
  'todo_write', 'file_read', 'file_list', 'file_search', 'glob', 'project_snapshot', 'git_status',
  'git_diff', 'git_log', 'git_commit', // v1.0-S4 git 工具族
  'dependency_inventory', 'code_review_scan', 'frontend_audit', 'claude_md_audit', 'docs_search',
  'shell_start', 'shell_poll', 'shell_kill', 'shell_list', 'http_request', 'browser_open', 'office_open',
  'desktop_screenshot', 'keyboard_send_keys', 'permission_prompt',
  // v1.1-W2 (T1): 新五工具是内建可撤销工具(journal 驱动) —— 归入 KNOWN 集合,故 claude 引擎不会把它们误计为「命令」。
  // 它们产生的 journal 条目由 buildTurnSummary 的 journalEntries 叠加为 filesChanged(revertible:true)。
  'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download',
]);
// Best-effort: coerce a tool result into a plain object. Handles (a) an object already; (b) a JSON string;
// (c) an MCP content array [{type:'text',text:'{...}'}] (the shape the Claude CLI reports for workbench
// tools) — parse the concatenated text as JSON. Returns null when nothing parses.
function asResultObject(result) {
  if (result == null) return null;
  if (Array.isArray(result)) {
    const text = result.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    try { return JSON.parse(text); } catch { return null; }
  }
  if (typeof result === 'object') return result;
  if (typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
  return null;
}
function buildTurnSummary(turnSeq, toolCalls, engine, journalEntries) {
  const byPath = new Map(); // path → {path, op, revertible} — journal entries take precedence over records
  let commands = 0;
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (!tc || !tc.name) continue;
    const name = String(tc.name);
    const input = (tc.input && typeof tc.input === 'object') ? tc.input : {};
    if (TURN_SUMMARY_FILE_TOOLS.has(name)) {
      const r = asResultObject(tc.result);
      // Path: prefer the tool input; fall back to the parsed result (claude workbench tools echo .path).
      const p = input.path ? String(input.path) : (r && r.path ? String(r.path) : '');
      if (!p) continue;
      // Skip failed file ops (e.g. file_edit oldText-not-found) — nothing changed, nothing to revert.
      if (r && r.ok === false) continue;
      let op = 'unknown';
      if (name === 'file_edit') op = 'modify';
      else if (name === 'file_delete') op = 'delete';
      else if (name === 'file_write') {
        // 25.5: 幂等跳过(op:'skip')= 未发生任何改动,不进变更清单(与失败 continue 同款语义)。
        if (r && r.op === 'skip') continue;
        // file_write now echoes op (create/modify) from the journal-aware toolCall; fall back to 'unknown'.
        op = (r && r.op === 'create') ? 'create' : (r && r.op === 'modify') ? 'modify' : 'unknown';
      }
      byPath.set(path.resolve(p), { path: p, op, revertible: false });
    } else if (TURN_SUMMARY_COMMAND_TOOLS.has(name)) {
      commands += 1;
    } else if (engine === 'claude' && !TURN_SUMMARY_KNOWN_TOOLS.has(name)) {
      // Claude CLI native tools (Edit/Write/Bash/etc.) never pass through toolCall — count as a command.
      commands += 1;
    }
  }
  // v0.8-S4a: overlay the journal entries — they carry the accurate op and mark revertible:true (unless
  // the before content was too large to store → skipped → stays false). Keyed on resolved absolute path.
  // v0.8-S4b: also carry `entrySeq` so the UI「本轮变更」card can target a SINGLE file for rollback
  // (POST /api/checkpoints/rollback {turnSeq, entrySeq}). When a path was written more than once in the
  // turn the last journal entry wins here — its entrySeq is the newest `before`, i.e. rolling back that
  // one entry restores the state just prior to the last write (single-file undo semantics).
  for (const je of (Array.isArray(journalEntries) ? journalEntries : [])) {
    if (!je || !je.path) continue;
    byPath.set(path.resolve(String(je.path)), { path: String(je.path), op: je.op || 'unknown', revertible: !je.skipped, entrySeq: Number(je.entrySeq) });
  }
  const filesChanged = [...byPath.values()];
  // v0.9-S4 (C4): artifacts — files this turn PRODUCED, for the右栏「产物」gallery. Two sources, merged
  // by resolved path (last write wins, so kind stays consistent):
  //  (1) journal entries with op:'create' (a genuinely new file) → {path, kind};
  //  (2) any tool result carrying an output_path-style key (bridged doc/screenshot/office tools echo one).
  // Note: modify/delete journal entries are NOT artifacts (nothing new was produced); the file still shows
  // up under filesChanged. Kind is suffix-derived (kindForPath). De-dup keyed on the resolved absolute path.
  const artByPath = new Map();
  const addArtifact = raw => {
    const p = String(raw || '').trim();
    if (!p) return;
    artByPath.set(path.resolve(p), { path: p, kind: kindForPath(p) });
  };
  // v1.0.2-S4 产物判定放宽(产品决策):除 op:'create' 外, op:'modify' 且 kindForPath 命中已知类型
  // (img/md/csv/html/xlsx/docx/pdf) 的也算产物(改一个 xlsx 也是产物)。addArtifact 已按 resolved path
  // 去重, 故 create/modify 同 path 只留一条。'txt' 与 'other' 的 modify 不入(避免把随手改的日志/临时文
  // 本当产物, 与用户「右侧产物页签」的心智一致)。
  const ARTIFACT_MODIFY_KINDS = new Set(['img', 'md', 'csv', 'html', 'xlsx', 'docx', 'pdf']);
  for (const je of (Array.isArray(journalEntries) ? journalEntries : [])) {
    if (!je || !je.path) continue;
    if (je.op === 'create') addArtifact(je.path);
    else if (je.op === 'modify' && ARTIFACT_MODIFY_KINDS.has(kindForPath(je.path))) addArtifact(je.path);
  }
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (!tc) continue;
    const r = asResultObject(tc.result);
    if (!r || r.ok === false) continue; // failed calls produced nothing
    for (const k of ARTIFACT_OUTPUT_PATH_KEYS) {
      if (typeof r[k] === 'string' && r[k].trim()) addArtifact(r[k]);
    }
    // v1.5-W1.5: ACC 兼容层 —— 对写族 bridged 工具额外收割裸 `path`。三条同时满足才收:①工具名是写族;
    // ②结果 success===true(ACC 契约:写成功回 success:true;失败回 {error}, 无 success);③有非空字符串
    // path。与上面 addArtifact 的 resolved-path 去重合并,故新版 ACC(同时回 output_path 与 path)不会重复
    // 登记。仅对 bridged 写族生效,读类工具(read_document 也回 path)因名字不匹配而不会误收。
    if (tc.name && isBridgedWriteTool(tc.name) && r.success === true
        && typeof r.path === 'string' && r.path.trim()) {
      addArtifact(r.path);
    }
  }
  const artifacts = [...artByPath.values()];
  return { turnSeq: Number(turnSeq) || 0, filesChanged, commands, artifacts };
}

// v0.8-S0 A6: detect an interrupted (dangling) turn from providerHistory. Dangling shapes:
//   - the tail is a role:'user' message with no assistant reply after it (turn never got answered);
//   - the tail is a role:'tool' message (turn stopped mid tool-loop, see below);
//   - the tail assistant carries tool_calls but not every tool_call_id has a matching role:'tool' reply
//     (turn was arrested mid tool-loop). Returns { dangling, kind } — kind: 'user'|'tool_calls'|null.
function detectDanglingTurn(session) {
  const h = (session && Array.isArray(session.providerHistory)) ? session.providerHistory : [];
  if (!h.length) return { dangling: false, kind: null };
  const last = h[h.length - 1];
  if (last && last.role === 'user') return { dangling: true, kind: 'user' };
  // A tail of role:'tool' is the persisted shape of Stop-mid-loop (the MOST common interruption): the
  // abort lands after the tool results were pushed but before the next model call (the `if (aborted)
  // break` right after the per-tool-result push in runOpenAiTurn), and the closing assistant text is
  // only pushed on normal completion. Every tool_call_id is answered, yet the turn never concluded.
  if (last && last.role === 'tool') return { dangling: true, kind: 'tool_calls' };
  // Walk back to the most recent assistant message that requested tools; verify each id was answered.
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i];
    if (!m || m.role !== 'assistant') continue;
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) break; // plain assistant → complete
    const answered = new Set();
    for (let j = i + 1; j < h.length; j++) {
      if (h[j] && h[j].role === 'tool' && h[j].tool_call_id != null) answered.add(String(h[j].tool_call_id));
    }
    const unanswered = m.tool_calls.some(tc => tc && !answered.has(String(tc.id)));
    return unanswered ? { dangling: true, kind: 'tool_calls' } : { dangling: false, kind: null };
  }
  return { dangling: false, kind: null };
}

// Returns the normalized session, or null when the file is missing/unreadable. A file that exists but
// fails to parse is renamed to <id>.json.corrupt (isolated, not deleted) so a truncated write can't
// keep 500-ing every read; callers treat null as "not found".
// v1.9 存储 v2:头(storageVersion:2)从两个 NDJSON 正文装配 messages/providerHistory;正文缺失/坏 →
// v1bak 回退(迁移备份),无 v1bak 才按损坏隔离。legacy 单文件首次加载后打非枚举 __v1bakPending 标记,
// 由 saveSession 完成「先备份 v1bak、再落 v2」的懒迁移(对调用方完全透明)。
async function loadSession(id) {
  let raw;
  try {
    raw = await fsp.readFile(sessionPath(id), 'utf8');
  } catch {
    return null; // ENOENT etc.
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await fsp.rename(sessionPath(id), sessionPath(id) + '.corrupt').catch(() => {});
    return null;
  }
  if (Array.isArray(parsed)) return null; // sessions/index.json is an array, not a session; never load it as one
  let legacy = true;
  if (parsed && parsed.storageVersion === SESSION_STORAGE_VERSION) {
    const bp = sessionBodyPaths(id);
    let msg = await readSessionBodyFile(bp.messages);
    let prov = await readSessionBodyFile(bp.provider);
    // 头是提交点:正文行数【少于】头声明 = 已提交数据丢失,与 corrupt 同级;【多于】头声明 = 崩溃于
    // 「append 完成、头写未完成」之间,多余行是未提交尾巴,物理截断(见下),不算损坏。
    const shortOf = (body, count) => Number.isInteger(count) && body && !body.corrupt && body.entries.length < count;
    const bodyBad = () => !msg || !prov || msg.corrupt || prov.corrupt
      || shortOf(msg, parsed.messageCount) || shortOf(prov, parsed.providerHistoryCount);
    const countsDiffer = () => (Number.isInteger(parsed.messageCount) && msg && !msg.corrupt && msg.entries.length !== parsed.messageCount)
      || (Number.isInteger(parsed.providerHistoryCount) && prov && !prov.corrupt && prov.entries.length !== parsed.providerHistoryCount);
    // .prevbody 快照(saveSession 慢路径重写前的旧正文)在场 + 正文坏/计数与头不符 = 上次慢路径中断
    // (崩溃于「正文重写、头未提交」之间)→ 恢复快照,与磁盘上的旧头重新配对。
    // 注意区分:头计数==正文行数时 prevbody 是「头已提交、清理未完成」的陈旧快照 → 不恢复,随下方清理删掉。
    const pm = bp.messages + '.prevbody', pp = bp.provider + '.prevbody';
    const hasPrev = await fsp.stat(pm).then(() => true).catch(() => false)
      && await fsp.stat(pp).then(() => true).catch(() => false);
    if (hasPrev && (bodyBad() || countsDiffer())) {
      sessionBodyState.delete(id);
      await fsp.rename(pm, bp.messages).catch(() => {});
      await fsp.rename(pp, bp.provider).catch(() => {});
      msg = await readSessionBodyFile(bp.messages);
      prov = await readSessionBodyFile(bp.provider);
    }
    if (bodyBad()) {
      // 磁盘正文已不可信 → 先作废进程内镜像,否则 save 的快路径会拿旧 hash 往坏正文上 append。
      sessionBodyState.delete(id);
      // 正文缺失/损坏 → 迁移备份回退(v1 原文重走迁移,等价于回到迁移前一刻)。
      const bak = await loadSessionV1Backup(id);
      if (bak) return bak;
      // 无备份可退:坏正文隔离(不删,留取证),头按损坏处理。
      for (const p of [bp.messages, bp.provider]) await fsp.rename(p, p + '.corrupt').catch(() => {});
      await fsp.rename(sessionPath(id), sessionPath(id) + '.corrupt').catch(() => {});
      return null;
    }
    // 未提交尾巴截断:不物理截断的话,磁盘上多出的行会在下次快路径 append 后「复活」进会话。
    for (const [body, count, file] of [[msg, parsed.messageCount, bp.messages], [prov, parsed.providerHistoryCount, bp.provider]]) {
      if (Number.isInteger(count) && body.entries.length > count) {
        const cut = count > 0 ? body.lineEndBytes[count - 1] : 0;
        await fsp.truncate(file, cut).catch(() => {});
        body.entries.length = count; body.hashes.length = count;
      }
    }
    parsed.messages = msg.entries;
    parsed.providerHistory = prov.entries;
    sessionBodyState.set(id, { msgHashes: msg.hashes, provHashes: prov.hashes, bodiesOk: true });
    // v2 完整可读 → 迁移残留的 v1bak 与慢路径残留 prevbody 快照一并清掉(备份使命已完成;也防无界堆积)。
    await fsp.unlink(sessionPath(id) + '.v1bak').catch(() => {});
    await fsp.unlink(bp.messages + '.prevbody').catch(() => {});
    await fsp.unlink(bp.provider + '.prevbody').catch(() => {});
    delete parsed.storageVersion; // 运行时对象不携带存储标记(保持与 v1 同形),saveSession 落盘时重新加
    delete parsed.messageCount;        // 计数同理:落盘字段,运行时以真数组为准,带出只会是过期副本
    delete parsed.providerHistoryCount;
    legacy = false;
  }
  const { session, changed } = normalizeSession(parsed);
  if (session.id == null) session.id = id;
  if (legacy) {
    // 懒迁移:标记后无条件 save —— 老会话首次被真正使用时一次性转 v2,之后读写全走新格式。
    Object.defineProperty(session, '__v1bakPending', { value: true, enumerable: false, configurable: true, writable: true });
    await saveSession(session).catch(() => {});
  } else if (changed) await saveSession(session).catch(() => {});
  return session;
}

// 迁移备份回退:<id>.json.v1bak 是 legacy 单文件原样拷贝(写入侧 COPYFILE_EXCL 保证它永不被覆盖)。
// 读出后走正常 legacy 路径(重打迁移标记,save 时 v1bak 已存在 → EXCL 失败被吞,内容不变 —— 幂等)。
// 防线:v1bak 里若是 v2 头(带 storageVersion 且没有 messages 数组),说明备份已被污染/根本不是备份,
// 宁可回退失败走损坏隔离,也绝不拿一个空正文重建会话(那等于丢历史)。
async function loadSessionV1Backup(id) {
  let raw;
  try { raw = await fsp.readFile(sessionPath(id) + '.v1bak', 'utf8'); }
  catch { return null; }
  const parsed = safeJsonParse(raw, null);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
  if (parsed.storageVersion === SESSION_STORAGE_VERSION) return null;
  const { session } = normalizeSession(parsed);
  if (session.id == null) session.id = id;
  Object.defineProperty(session, '__v1bakPending', { value: true, enumerable: false, configurable: true, writable: true });
  await saveSession(session).catch(() => {});
  return session;
}

// Atomic write: serialize to <id>.json.tmp then rename over the target. rename is atomic within a
// volume, so a crash mid-write leaves the previous good file intact instead of a truncated one.
// v1.9 存储 v2(save 侧):头(小)仍 tmp+rename 原子重写;两个正文数组优先 append-only 快路径
// (前缀逐行 hash 比对,见文件头部「会话存储 v2」块注释),任何前缀变化/状态缺失/上次失败 → 全量重写正文。
async function saveSession(session) {
  await ensureDirs();
  session.updatedAt = nowIso();
  const id = session.id;
  const finalPath = sessionPath(id);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const providerHistory = Array.isArray(session.providerHistory) ? session.providerHistory : [];
  // 头 = 运行时对象剥掉两个大数组 + 存储标记 + 计数(计数供 listSessions 兜底扫描/sessionMeta 不读正文)。
  const head = { ...session };
  delete head.messages;
  delete head.providerHistory;
  head.storageVersion = SESSION_STORAGE_VERSION;
  head.messageCount = messages.length;
  head.providerHistoryCount = providerHistory.length;
  // Serialize the payload and snapshot the 7 index fields in the SAME synchronous tick, so the background index
  // write reflects EXACTLY what we persist here (no drift if `session` is mutated during the awaits below).
  const payload = JSON.stringify(head, null, 2);
  const metaSnapshot = sessionMeta(session);
  // 第25波 25.1: 写体收编进 atomicWriteJson(唯一 tmp 名防并发互踩 + rename 瞬时锁重试 + 失败清 tmp)。
  // 对抗轮修: 同会话并发写者(回合保存 + 节流 flush + updateSessionMeta)此前不串行 —— 加了 rename 重试后,
  // 旧载荷可在 ~680ms 退避后覆写掉新载荷(stale-overwrites-fresh 窗口从 writeFile 粒度拉宽到 680ms)。
  // 按 saveAgentRun 同款 per-id 写链串行化:链内按提交顺序落盘,窗口归零;链错误吞掉(下一写自愈)。
  // v2:整个「正文 append/重写 + 头写」都在链内 —— 进程内状态表与磁盘正文的一致性靠同一条链保证。
  const prevWrite = sessionWriteChains.get(id) || Promise.resolve();
  const thisWrite = prevWrite.catch(() => {}).then(async () => {
    const bp = sessionBodyPaths(id);
    // 懒迁移:legacy 单文件先原样备份 v1bak。必须 COPYFILE_EXCL(已存在则失败被吞)—— v1bak 回退
    // 恢复路径也会走到这里,若允许覆盖会把「 pristine legacy 备份」冲成 v2 头,备份使命直接报废。
    if (session.__v1bakPending === true) {
      await fsp.copyFile(finalPath, finalPath + '.v1bak', fs.constants.COPYFILE_EXCL).catch(() => {});
      session.__v1bakPending = false;
    }
    const state = sessionBodyState.get(id);
    const msgPlan = state && state.bodiesOk ? planSessionBodyAppend(messages, state.msgHashes) : null;
    const provPlan = state && state.bodiesOk ? planSessionBodyAppend(providerHistory, state.provHashes) : null;
    let nextMsgHashes, nextProvHashes;
    if (msgPlan && provPlan) {
      // 快路径:只 append 增量行(0 增量 = 不动正文文件,仅更新头)。
      if (msgPlan.appendLines.length) await fsp.appendFile(bp.messages, msgPlan.appendLines.join('\n') + '\n', 'utf8');
      if (provPlan.appendLines.length) await fsp.appendFile(bp.provider, provPlan.appendLines.join('\n') + '\n', 'utf8');
      nextMsgHashes = msgPlan.allHashes;
      nextProvHashes = provPlan.allHashes;
    } else {
      // 慢路径:全量重写两个正文。【崩溃窗口设防】重写前把旧正文快照为 .prevbody(EXCL:已有快照不覆盖
      // —— 在场快照必属「上一个未干净完成的慢路径」,其配对的头更老,覆盖会把一致态快照冲成未提交内容)。
      // 收缩型重写(rewind/compaction 后行数变少)若崩溃于「正文已重写、头未提交」之间,旧头计数 > 新正文
      // 行数,读取侧本会把会话判 corrupt;有 .prevbody 即可回滚到崩溃前的一致态(loadSession 恢复,见下)。
      const msgSer = serializeSessionBody(messages);
      const provSer = serializeSessionBody(providerHistory);
      if (!msgSer || !provSer) throw new Error('session body not serializable');
      await fsp.copyFile(bp.messages, bp.messages + '.prevbody', fs.constants.COPYFILE_EXCL).catch(() => {});
      await fsp.copyFile(bp.provider, bp.provider + '.prevbody', fs.constants.COPYFILE_EXCL).catch(() => {});
      try {
        await atomicWriteJson(bp.messages, sessionBodyText(msgSer.lines));
        await atomicWriteJson(bp.provider, sessionBodyText(provSer.lines));
      } catch (werr) {
        // 进程内写失败(非崩溃)→ 立即回滚快照,磁盘回到重写前的一致态;bodiesOk=false 由外层标。
        await fsp.rename(bp.messages + '.prevbody', bp.messages).catch(() => {});
        await fsp.rename(bp.provider + '.prevbody', bp.provider).catch(() => {});
        throw werr;
      }
      nextMsgHashes = msgSer.hashes;
      nextProvHashes = provSer.hashes;
    }
    // 头最后写:头指向的正文状态必须先于头落盘(头=「正文有效」的声明)。
    await atomicWriteJson(finalPath, payload);
    // 头已提交 → prevbody 快照使命完成(崩溃于清理前也无妨:下次读取按「头计数==正文行数」判其为陈旧快照,
    // 顺带清除,见 loadSession)。
    await fsp.unlink(bp.messages + '.prevbody').catch(() => {});
    await fsp.unlink(bp.provider + '.prevbody').catch(() => {});
    sessionBodyState.set(id, { msgHashes: nextMsgHashes, provHashes: nextProvHashes, bodiesOk: true });
  });
  sessionWriteChains.set(id, thisWrite);
  try { await thisWrite; }
  catch (e) {
    // 正文/头任何一步失败:标 bodiesOk=false(下次 save 全量重写自愈),再把错误抛给调用方(与旧语义一致:
    // save 失败对调用方可见,回合层自会 .catch)。
    const st = sessionBodyState.get(id);
    sessionBodyState.set(id, { msgHashes: st ? st.msgHashes : null, provHashes: st ? st.provHashes : null, bodiesOk: false });
    throw e;
  }
  finally { if (sessionWriteChains.get(id) === thisWrite) sessionWriteChains.delete(id); }
  // PF2: queue the sidebar metadata index update (cheap sync Map.set; the write is debounced + coalesced). The
  // index is only a cache and listSessions falls back to a full file scan whenever its id-set drifts from disk.
  scheduleSessionIndexUpdate(id, metaSnapshot);
  // v1.9 P-B: 引擎转录白名单账本(仅记录本工作台 spawn 过的 claudeSessionId;GC 只清「账本内 + 无活会话
  // 引用 + 超保留期」三者同时成立的转录,绝不碰用户自己 Claude Code 的转录)。fire-and-forget,账本写失败
  // 不影响会话保存(大不了 GC 永远不碰这条转录 —— 保守方向)。
  if (typeof session.claudeSessionId === 'string' && session.claudeSessionId) {
    void recordEngineTranscript(session.claudeSessionId, session.cwd).catch(() => {});
  }
  return session;
}

async function createSession({ title, cwd }) {
  const id = makeId('sess');
  const config = await readConfig();
  const session = {
    id,
    schemaVersion: SESSION_SCHEMA,
    turnSeq: 0,
    title: title || 'New session',
    summary: '',
    pinned: false,
    cwd: cwd || config.defaultWorkspace || os.homedir(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    claudeSessionId: null,
    messages: Array.isArray(arguments[0]?.messages) ? arguments[0].messages : [],
    providerHistory: [],
    providerHistoryCursor: 0,
    attachments: [],
    mission: null, // 第26波b: 任务账本(见 normalizeMission)
  };
  await saveSession(session);
  return session;
}

// ============================================================================
// v0.8-S4a — Checkpoint journal (信任层核心). Layout under dataRoot/checkpoints/<sessionId>/:
//   index.json                 [{turnSeq, entrySeq, tool, path, op:'create'|'modify'|'delete', bytes, skipped?, ts}]
//   <turnSeq>-<entrySeq>.gz    zlib.gzipSync(before content) — op:'create' has NO .gz (before never existed)
//   history-<turnSeq>.json.gz  (S5 providerHistory snapshot — only the directory convention is reserved here)
//
// DUAL-PROCESS INVARIANT: the journal is FILESYSTEM-LEVEL shared state. Both engines write the SAME
// dataRoot/checkpoints dir — the provider engine's toolCall() runs in the serve process; the Claude
// engine's workbench tools run in the one-shot MCP child. This is race-free by construction: within one
// session, only ONE engine runs a turn at any instant, so there is never concurrent writing to a given
// session's checkpoints dir. The MCP child must NOT write session files (S3 invariant) but CAN write the
// checkpoints dir (independent of session files → no contention with the serve process's saveSession).
//
// SAFETY-NET, NOT A GATE: any journal failure is swallowed (try/catch) and MUST NOT block tool execution.
// A journal write that throws simply skips its index entry; the tool runs regardless. The trade-off is
// deliberate — a checkpoint is a safety net, and a broken safety net must never stop the user's work.
// ============================================================================
const JOURNAL_MAX_BEFORE_BYTES = 5 * 1024 * 1024;   // >5MB before-content → skipped:true, content not stored
const JOURNAL_KEEP_TURNS = 20;                       // per-session GC: keep the most recent 20 turnSeqs
const JOURNAL_GLOBAL_MAX_BYTES = (() => {
  const n = Number(process.env.RUYI_JOURNAL_GLOBAL_MAX_BYTES); // env override for e2e; default 200MB
  return Number.isFinite(n) && n > 0 ? n : 200 * 1024 * 1024;
})();  // global cap: purge oldest sessions (dir mtime) over this
// PF1: the global size cap used to run a full dirSize() sweep of EVERY session's checkpoint tree on every
// checkpoint-triggering file write (O(all checkpoint files), awaited before the tool returns) - so a single
// tool call's latency grew with the app's TOTAL checkpoint history (a 50-edit workflow = 50 full sweeps).
// We now keep a process-local APPROXIMATE running total of checkpoint bytes and use it only to decide whether
// the authoritative full sweep is worth running. SAFETY: the cache NEVER authorizes a purge - purges always
// run off a fresh full sweep that also recalibrates the cache. The cache can only SKIP the sweep when
// confidently under budget, so a stale or under-counting cache costs at most one extra sweep, never a missed
// cleanup. Recalibrated on cold start, every JOURNAL_GC_RECALIBRATE_EVERY calls, and when the estimate nears
// the cap. Process-local by design: the serve process and the one-shot MCP child each calibrate via their own
// authoritative sweeps (which see ALL sessions on disk regardless of writer), so correctness needs no sharing.
let journalGlobalBytes = null;            // cached approx total bytes of paths.checkpoints (null = uncalibrated)
let journalGcSinceScan = 0;               // journalGc calls since the last authoritative full sweep
const JOURNAL_GC_RECALIBRATE_EVERY = 64;  // force a real sweep at least this often (bounds cache drift)
const JOURNAL_GC_SCAN_HYSTERESIS = 0.9;   // sweep once the estimate reaches this fraction of the hard cap
// Probe (exported) so the PF1 e2e can assert the sweep does NOT run on every call yet still purges over-cap.
const journalGcProbe = { fullScans: 0, calls: 0 };
// PF1 fix: ALL running-total mutations funnel through journalBytesAdjust so byte accounting lives in one place
// and a full sweep can't silently clobber concurrent writers. A sweep measures disk truth across several awaits
// (readdir/stat/dirSize per session); other sessions' writers may `+=` during that window. Recording those
// deltas here lets the sweep replay them onto its recalibrated total instead of overwriting them (an overwrite
// would re-introduce a small under-count -> a possibly-missed sweep). SAFETY: this cache NEVER authorizes a
// purge (purges run off fresh dirSize), so any drift costs at most an extra sweep, never a missed cleanup.
let journalSweeping = 0;                   // in-flight authoritative sweeps (measurement windows currently open)
let journalDeltaDuringSweep = 0;           // net bytes changed by writers while any sweep is measuring
function journalBytesAdjust(delta) {
  if (!delta) return;
  if (journalGlobalBytes != null) journalGlobalBytes = Math.max(0, journalGlobalBytes + delta);
  if (journalSweeping > 0) journalDeltaDuringSweep += delta; // replayed after the sweep recalibrates from truth
}
// Parallel sub-agents may checkpoint different files in the same parent turn. Serialize each session's
// read-modify-write index transaction so entrySeq stays unique and a later write cannot overwrite an
// earlier agent's index entry. Different sessions retain full concurrency.
const journalWriteChains = new Map(); // sessionId -> Promise

async function withJournalWriteLock(sessionId, work) {
  const key = String(sessionId || '');
  const previous = journalWriteChains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  journalWriteChains.set(key, current);
  try { return await current; }
  finally { if (journalWriteChains.get(key) === current) journalWriteChains.delete(key); }
}

function journalDir(sessionId) { return path.join(paths.checkpoints, String(sessionId)); }
function journalIndexPath(sessionId) { return path.join(journalDir(sessionId), 'index.json'); }

// Read a session's checkpoint index (array of entries). Missing/corrupt → []. Never throws.
async function journalReadIndex(sessionId) {
  try {
    const raw = await fsp.readFile(journalIndexPath(sessionId), 'utf8');
    const arr = safeJsonParse(raw, null);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Atomic index write. Never throws (caller wraps). 第25波 25.1: 收编进 atomicWriteJson。
// 对抗轮修: retries:0 —— 该文件是【跨进程多写者】(serve 进程 + MCP 子进程各持独立 journalWriteChains,
// 进程间无法串行),rename 重试会让旧载荷在 ~680ms 退避后覆写掉别进程刚落的新条目(丢检查点)。
// 保持旧的 fail-fast 语义:输给并发写者就立刻失败(调用方本就 best-effort 包裹),绝不迟到覆写。
async function journalWriteIndex(sessionId, entries) {
  const dir = journalDir(sessionId);
  await fsp.mkdir(dir, { recursive: true });
  await atomicWriteJson(journalIndexPath(sessionId), entries, { retries: 0 });
}

// Resolve the current turnSeq for a checkpoint entry.
//  - serve process (provider engine): the caller passes the closure's session.turnSeq (authoritative).
//  - MCP child (Claude engine): read the session file (READ-ONLY, no race) via WCW_SESSION_ID env and take
//    its turnSeq. Missing env / unreadable file → null → the caller skips journaling (tool still runs).
async function journalResolveTurnSeq(sessionId, explicitTurnSeq) {
  if (Number.isFinite(explicitTurnSeq)) return Number(explicitTurnSeq);
  if (!sessionId) return null;
  try {
    const raw = await fsp.readFile(sessionPath(sessionId), 'utf8');
    const parsed = safeJsonParse(raw, null);
    const t = parsed && Number(parsed.turnSeq);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// Record a `before` checkpoint for a file mutation, BEFORE the tool executes. Returns nothing meaningful;
// all failures are swallowed so the tool proceeds unimpeded. `beforeContent` is a Buffer|string for
// modify/delete, or null for create (nothing to save). op ∈ 'create'|'modify'|'delete'. entrySeq is the
// per-turn running count (derived from how many entries already exist for this turnSeq).
async function journalRecord(sessionId, turnSeq, tool, filePath, op, beforeContent) {
  return withJournalWriteLock(sessionId, () => journalRecordUnlocked(sessionId, turnSeq, tool, filePath, op, beforeContent));
}

async function journalRecordUnlocked(sessionId, turnSeq, tool, filePath, op, beforeContent) {
  try {
    if (!sessionId || !Number.isFinite(turnSeq)) return; // no session context → nothing to anchor to
    const dir = journalDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    const index = await journalReadIndex(sessionId);
    const entrySeq = index.filter(e => e && Number(e.turnSeq) === Number(turnSeq)).length; // per-turn autoincrement
    let bytes = 0, skipped = false;
    if (op !== 'create' && beforeContent != null) {
      const buf = Buffer.isBuffer(beforeContent) ? beforeContent : Buffer.from(String(beforeContent), 'utf8');
      bytes = buf.length;
      if (bytes > JOURNAL_MAX_BEFORE_BYTES) {
        // Too large to snapshot — record the entry as skipped (rollback of this entry will fail loudly).
        skipped = true;
      } else {
        const gz = zlib.gzipSync(buf); // built-in zlib — zero npm
        await fsp.writeFile(path.join(dir, `${turnSeq}-${entrySeq}.gz`), gz);
        journalBytesAdjust(gz.length); // PF1: keep the size-cap cache current
      }
    }
    index.push({ turnSeq: Number(turnSeq), entrySeq, tool: String(tool || ''), path: String(filePath || ''), op, bytes, ...(skipped ? { skipped: true } : {}), ts: nowIso() });
    await journalWriteIndex(sessionId, index);
    // v1.4.1 (audit #8):必须 await —— 此前 detached 触发,GC 的 index.json 读改写会与下一条 journalRecord 竞争,
    // 修剪写回时可覆盖刚追加的条目(lost-write → 该文件变更不可撤销)。await 让 GC 在下一条 record 前完成,
    // 消除并发。GC 内部全 try/catch 静默,不抛。
    await journalGc(sessionId).catch(() => {});
  } catch {
    // Safety-net discipline: a failed journal write must NOT abort the tool. Swallow and continue — the
    // index entry simply isn't written, and the file operation runs as if the journal weren't there.
  }
}

// GC. (1) Per-session: keep only the most recent JOURNAL_KEEP_TURNS turnSeqs; drop older entries + their
// .gz files. (2) Global: if the whole checkpoints/ tree exceeds JOURNAL_GLOBAL_MAX_BYTES, remove entire
// oldest sessions (by dir mtime) until under budget. All failures are silent.
async function journalGc(sessionId) {
  let freedBytes = 0; // PF1: bytes reclaimed by the per-session prune below, to decrement the size-cap cache
  try {
    const dir = journalDir(sessionId);
    const index = await journalReadIndex(sessionId);
    if (index.length) {
      const turns = [...new Set(index.map(e => Number(e.turnSeq)))].sort((a, b) => a - b);
      if (turns.length > JOURNAL_KEEP_TURNS) {
        const keep = new Set(turns.slice(turns.length - JOURNAL_KEEP_TURNS));
        const kept = [];
        for (const e of index) {
          if (keep.has(Number(e.turnSeq))) { kept.push(e); continue; }
          if (!e.skipped && e.op !== 'create') {
            const gzp = path.join(dir, `${e.turnSeq}-${e.entrySeq}.gz`);
            const st = await fsp.stat(gzp).catch(() => null); // real on-disk size (best-effort) for the cache decrement
            await fsp.unlink(gzp).catch(() => {});
            if (st) freedBytes += st.size;
          }
        }
        await journalWriteIndex(sessionId, kept);
      }
    }
  } catch { /* silent */ }
  try {
    journalGcProbe.calls++;
    // PF1: keep the running estimate current with what the per-session prune just reclaimed (never below 0).
    if (freedBytes) journalBytesAdjust(-freedBytes);
    journalGcSinceScan++;
    // Decide whether the authoritative full sweep is worth running. Sweep when: uncalibrated (cold start),
    // periodic recalibration is due (drift correction), or the estimate is near/over the cap. Otherwise the
    // common case (well under budget) SKIPS the O(all-checkpoint-files) sweep entirely - the whole point of PF1.
    const needSweep = journalGlobalBytes == null
      || journalGcSinceScan >= JOURNAL_GC_RECALIBRATE_EVERY
      || journalGlobalBytes >= JOURNAL_GLOBAL_MAX_BYTES * JOURNAL_GC_SCAN_HYSTERESIS;
    if (!needSweep) return; // fast path: confidently under budget, no sweep
    journalGcProbe.fullScans++;
    journalGcSinceScan = 0;
    journalSweeping++;
    const deltaMark = journalDeltaDuringSweep; // writer deltas already counted BEFORE this window opened
    try {
      // Authoritative sweep: sum every session dir, purge whole sessions oldest-first when over budget, and
      // RECALIBRATE the cache from measured truth. This is the ONLY writer that resets journalGlobalBytes, so a
      // purge decision is always made against real bytes, never the estimate.
      const root = paths.checkpoints;
      const names = await fsp.readdir(root).catch(() => []);
      const dirs = [];
      let total = 0;
      for (const name of names) {
        const p = path.join(root, name);
        const st = await fsp.stat(p).catch(() => null);
        if (!st || !st.isDirectory()) continue;
        const size = await dirSize(p);
        total += size;
        dirs.push({ p, size, mtime: st.mtimeMs });
      }
      if (total > JOURNAL_GLOBAL_MAX_BYTES) {
        dirs.sort((a, b) => a.mtime - b.mtime); // oldest first
        for (const d of dirs) {
          if (total <= JOURNAL_GLOBAL_MAX_BYTES) break;
          await fsp.rm(d.p, { recursive: true, force: true }).catch(() => {});
          total -= d.size;
        }
      }
      // Recalibrate from measured truth, then replay the writer bytes that landed DURING this window so a
      // concurrent journalRecord's increment isn't clobbered (PF1: without this the cache could drift LOW ->
      // a missed sweep). Double-counting a byte already on disk when measured only inflates the estimate,
      // which is the SAFE direction (an extra sweep that recalibrates, never a skipped cleanup).
      const windowDelta = journalDeltaDuringSweep - deltaMark;
      journalGlobalBytes = Math.max(0, total + windowDelta);
    } finally {
      journalSweeping--;
      if (journalSweeping === 0) journalDeltaDuringSweep = 0; // reset once no sweep is measuring
    }
  } catch { /* silent */ }
}

// Sum the byte size of a directory tree (best-effort; errors count as 0).
async function dirSize(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += await dirSize(p);
    else { const st = await fsp.stat(p).catch(() => null); if (st) total += st.size; }
  }
  return total;
}

// Roll back checkpoint entries for a turn. entrySeq given = single entry; omitted = the whole turn
// (all entries for that turnSeq, in REVERSE order). Inverse ops: delete→write `before` back;
// modify→write `before` back; create→unlink the current file. skipped:true entries fail (no stored
// content) and are listed in `failed` without aborting the rest. Reverted entries are REMOVED from the
// index (idempotent: rolling back the same turn again → {ok:false,error:'no entries'}). The rollback
// action itself is NEVER journaled (anti-recursion). Returns {ok, reverted:[{path,op}], failed:[{path,reason}]}.
async function journalRollback(sessionId, turnSeq, entrySeq) {
  const dir = journalDir(sessionId);
  const index = await journalReadIndex(sessionId);
  const tSeq = Number(turnSeq);
  let targets = index.filter(e => e && Number(e.turnSeq) === tSeq);
  if (entrySeq !== undefined && entrySeq !== null && entrySeq !== '') {
    const eSeq = Number(entrySeq);
    targets = targets.filter(e => Number(e.entrySeq) === eSeq);
  }
  if (!targets.length) return { ok: false, error: 'no entries' };
  // Reverse order so multiple mutations to the same file unwind to the earliest recorded `before`.
  targets = targets.slice().sort((a, b) => b.entrySeq - a.entrySeq);
  const reverted = [], failed = [], revertedKeys = new Set();
  for (const e of targets) {
    const key = `${e.turnSeq}-${e.entrySeq}`;
    try {
      if (e.skipped) { failed.push({ path: e.path, reason: 'before content was not stored (too large)' }); continue; }
      if (e.op === 'create') {
        await fsp.unlink(e.path).catch(() => {}); // idempotent: gone already is fine
      } else {
        // modify | delete → restore the gzipped before content
        const gz = await fsp.readFile(path.join(dir, `${e.turnSeq}-${e.entrySeq}.gz`));
        const before = zlib.gunzipSync(gz);
        await fsp.mkdir(path.dirname(e.path), { recursive: true });
        // Atomic restore (tmp + rename, same discipline as saveSession): the trust layer's own rollback
        // must be lossless — a crash (power loss / kill) mid-writeFile would TRUNCATE the user's file,
        // which is exactly the harm checkpoints exist to prevent. rename is atomic within a volume, so a
        // crash leaves either the pre-rollback file or the fully-restored one, never a torn write.
        const tmpRestore = e.path + '.tmp';
        await fsp.writeFile(tmpRestore, before);
        await fsp.rename(tmpRestore, e.path);
        await fsp.unlink(path.join(dir, `${e.turnSeq}-${e.entrySeq}.gz`)).catch(() => {});
      }
      reverted.push({ path: e.path, op: e.op });
      revertedKeys.add(key);
    } catch (err) {
      failed.push({ path: e.path, reason: (err && err.message) ? err.message : String(err) });
    }
  }
  // Remove the successfully-reverted entries from the index (idempotency). Failed ones stay so a retry
  // is possible. The rollback is NOT journaled — no new checkpoint entries are created here.
  const remaining = index.filter(e => !revertedKeys.has(`${e.turnSeq}-${e.entrySeq}`));
  await journalWriteIndex(sessionId, remaining).catch(() => {});
  return { ok: reverted.length > 0, reverted, failed };
}

// v0.8-S4b B2 — conversation REWIND (Claude Code-style "back up to just before this message"). Truncates
// the session to the state right BEFORE `targetTurnSeq` began: removes that turn's user message and
// everything after it, returns the removed user text so the front-end can refill the composer (话还在输入
// 框里可改可重发), and OPTIONALLY rolls back the files of every discarded turn.
//
// Key决策 (locked in this slice):
//  - providerHistory is CLEARED to [] — NOT surgically truncated. The provider engine's lazy-reseed
//    (runOpenAiTurn, seeds from session.messages when providerHistory is empty) rebuilds the user/assistant
//    text context on the very next turn. Simple and ALWAYS correct (including after a compaction, where a
//    surgical truncation of the summarized history would be meaningless). The trade-off is losing the tool
//    trace from prior turns; the reseed carries text only. Documented here.
//  - session.turnSeq is NOT rewound — monotonicity is the journal's primary key; a new turn after a rewind
//    keeps incrementing (never reuses a discarded seq).
//  - session.todos is KEPT — rewinding the CONVERSATION is not abandoning the TASK LIST.
//  - claudeSessionId is nulled — the CLI's --resume context no longer matches the truncated history, so a
//    stale resume would splice removed context back in.
// Returns {ok, removedTurns, lastUserText, filesReverted:[], filesFailed:[]} (or {ok:false,error} when a
// turn is live or the target can't be located).
async function rewindSession(sessionId, targetTurnSeq, rollbackFiles) {
  const session = await loadSession(sessionId);
  if (!session) return { ok: false, error: 'session not found' };
  // Refuse while a turn is running for this session — truncating live state races the tool loop.
  if (activeChildren.has(sessionId)) return { ok: false, error: '回合进行中,请先停止' };
  const target = Number(targetTurnSeq);
  if (!Number.isFinite(target)) return { ok: false, error: 'targetTurnSeq is required' };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  // Locate the first user message belonging to targetTurnSeq. Primary: the additive `turnSeq` field
  // (S4b stamps every new user message). Fallback for pre-S4b messages without the field: the first user
  // message whose FOLLOWING assistant carries turnSummary.turnSeq === target (assistant messages have
  // carried turnSummary.turnSeq since S3), else an ordinal guess (the `target`-th user message, 1-based).
  let cutIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === 'user' && Number(m.turnSeq) === target) { cutIndex = i; break; }
  }
  if (cutIndex === -1) {
    // Fallback A: user message immediately preceding the assistant whose turnSummary.turnSeq === target.
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === 'assistant' && m.turnSummary && Number(m.turnSummary.turnSeq) === target) {
        for (let j = i - 1; j >= 0; j--) { if (messages[j] && messages[j].role === 'user') { cutIndex = j; break; } }
        break;
      }
    }
  }
  if (cutIndex === -1) {
    // Fallback B: ordinal — the `target`-th user message (1-based). Only reached for legacy sessions.
    let n = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] && messages[i].role === 'user') { n++; if (n === target) { cutIndex = i; break; } }
    }
  }
  if (cutIndex === -1) return { ok: false, error: 'target turn not found in this session' };

  const lastUserText = String((messages[cutIndex] && messages[cutIndex].content) || '');
  // Which turnSeqs are being discarded? Everything from the cut point onward. Prefer the stamped/summary
  // turnSeqs actually present in the tail; fall back to the numeric range target..current.
  const discarded = new Set();
  for (let i = cutIndex; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user' && Number.isFinite(Number(m.turnSeq))) discarded.add(Number(m.turnSeq));
    if (m.role === 'assistant' && m.turnSummary && Number.isFinite(Number(m.turnSummary.turnSeq))) discarded.add(Number(m.turnSummary.turnSeq));
  }
  const curSeq = Number(session.turnSeq) || target;
  for (let s = target; s <= curSeq; s++) discarded.add(s);

  // Optional file rollback of the discarded turns, newest→oldest (so multiple writes to a file unwind to
  // the earliest recorded `before` across turns). Aggregate into filesReverted / filesFailed.
  const filesReverted = [], filesFailed = [];
  if (rollbackFiles) {
    const seqs = [...discarded].sort((a, b) => b - a); // newest first
    for (const s of seqs) {
      try {
        const r = await journalRollback(sessionId, s); // whole-turn rollback
        if (r && Array.isArray(r.reverted)) for (const x of r.reverted) filesReverted.push(x);
        if (r && Array.isArray(r.failed)) for (const x of r.failed) filesFailed.push(x);
      } catch (e) { filesFailed.push({ path: '', reason: (e && e.message) ? e.message : String(e) }); }
    }
  }

  const removedTurns = messages.length - cutIndex; // message count removed (user + all following)
  session.messages = messages.slice(0, cutIndex);
  // providerHistory cleared — lazy-reseed rebuilds it on the next turn (see block comment above).
  session.providerHistory = [];
  session.providerHistoryCursor = 0;
  // turnSeq NOT rewound (monotonic journal key); todos KEPT (rewind ≠ abandon task list).
  session.claudeSessionId = null; // stale --resume context must not splice removed history back in
  // Refresh the derived summary/title tail off the surviving messages (best-effort).
  const lastAssistant = [...session.messages].reverse().find(m => m && m.role === 'assistant');
  session.summary = lastAssistant ? String(lastAssistant.content || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  await saveSession(session);
  return { ok: true, removedTurns, lastUserText, filesReverted, filesFailed };
}

// Resolve the journal {sessionId, turnSeq} for a file-mutating toolCall. Priority:
//  - ctx (provider loop passes its live session.id + session.turnSeq) → authoritative;
//  - else the MCP child reads WCW_SESSION_ID env + the session file's turnSeq (read-only, no race).
// Returns {sessionId, turnSeq} where either may be falsy/null → journalRecord then no-ops gracefully.
async function journalSessionCtx(ctx) {
  if (ctx && ctx.sessionId && Number.isFinite(ctx.turnSeq)) return { sessionId: ctx.sessionId, turnSeq: Number(ctx.turnSeq) };
  const sessionId = (ctx && ctx.sessionId) || process.env.WCW_SESSION_ID || '';
  const turnSeq = await journalResolveTurnSeq(sessionId, ctx && ctx.turnSeq);
  return { sessionId, turnSeq };
}

// v1.5-W1.5 (T3): bridged 写族工具的路径提取表 —— 裸工具名 → args 里的目标路径字段名。ACC 的
// write_document/write_excel/write_pdf 入参都叫 `path`(见 document.py 函数签名);delete 类走 op:delete。
// 表里没有的 bridged 工具不快照(collectBridgedWriteTargets 返回 []),工具照常执行。
//
// v1.2-B:两种条目形状 ——
//   (1) 单目标:{ field:'<argName>', op:'write'|'delete' } —— 一条快照(绝大多数写族)。
//   (2) 多目标:{ multi: [{ field, op }, ...] } —— 一次工具调用动多个文件,逐条独立快照。
//       move_file 是典型:源存在→op:'delete'(回滚=写回原处),目的地→op:'write'(存在→modify,否则 create,
//       回滚=删除)。回滚整回合时 journalRollback 按 entrySeq 逆序展开:后写的 dest 先撤(删掉新文件),
//       再撤 src(把源写回原处)—— 净效果=文件回到移动前的位置与内容。任一目标快照失败静默跳过,不阻断工具、
//       不阻断其它目标(与单目标同一安全网纪律)。
//   ⚠️ 参数名以 ACC 源码实际签名为准(不是本能猜测):filesystem.move_file/copy_file 的入参是
//      `source` / `destination`,不是 src/dest;window_screenshot 是 output_path;get_clipboard_image 是 save_path。
const BRIDGED_WRITE_PATH_ARGS = {
  write_document: { field: 'path', op: 'write' },
  write_docx: { field: 'path', op: 'write' },
  write_excel: { field: 'path', op: 'write' },
  write_pdf: { field: 'path', op: 'write' },
  write_file: { field: 'path', op: 'write' },
  // v1.1 返修(用户真机撞出):ACC v1.6 四个 Office 工具上线时漏进此表 → write_pptx/excel_beautify 全程
  // 零快照,用户「生成的 Excel 和 PPT 不能撤销」。教训:新增 bridged 写族工具时,此表 + toolIsRevertible
  // 徽章是【发布检查项】,不是可选项。四个入参均为 `path`(office_pptx/office_excel/office_chart 签名核对)。
  write_pptx: { field: 'path', op: 'write' },
  excel_beautify: { field: 'path', op: 'write' },
  excel_chart: { field: 'path', op: 'write' },
  chart_image: { field: 'path', op: 'write' },
  // 删除类:存 before 快照(op:delete → 回滚=写回)。ACC filesystem.delete_file 入参叫 `path`。
  delete_file: { field: 'path', op: 'delete' },
  // v1.2-B:move/copy 补齐(W1.5 明确欠账)。ACC filesystem.py 签名:move_file(source, destination)、
  //   copy_file(source, destination)。move = 源删 + 目的写(两条);copy = 只动目的地(一条 write)。
  //   注:源/目的地可能是目录(shutil.move/copytree);journalBridgedWrite 只快照普通文件(读得到字节的),
  //   目录目标读 before 失败按「无 before」处理 → 目录 move 的源侧记 delete 但无内容(回滚会 loudly fail),
  //   这是可接受的降级(整目录快照超出 checkpoint 的字节级设计,和内建 file_move 同保真度)。
  move_file: { multi: [{ field: 'source', op: 'delete' }, { field: 'destination', op: 'write' }] },
  copy_file: { field: 'destination', op: 'write' },
  // v1.2-B:截图/抓图类 —— 仅当调用方显式给了落盘路径参数时才产出磁盘文件(否则回 base64,无文件可撤)。
  //   op:'create' 语义(新 png),快照价值=可回滚删除。参数名:window_screenshot=output_path、
  //   get_clipboard_image=save_path(capture.py / desktop_extra.py 签名核对)。缺参→collectBridgedWriteTargets
  //   返回 [](不快照)。这些路径由调用方给,可能落在工作区内;落在护栏外则 journalBridgedWrite 自然跳过。
  window_screenshot: { field: 'output_path', op: 'write' },
  get_clipboard_image: { field: 'save_path', op: 'write' },
  // ACC v1.8:image_resize —— 真写文件 (缩放后落 output_path),但名字不含写族前缀 (^write_/save_/…),
  //   与 excel_beautify/chart_image 同类:命名审计抓不到,靠 B1 人工盘点入表。参数名 output_path
  //   (image_tools.py: image_resize(path, output_path, …) 签名核对)。落盘可能在工作区内 → 快照可撤;
  //   护栏外 (image_resize 自带 protected_path 护栏兜底) → journalBridgedWrite 自然跳过。
  image_resize: { field: 'output_path', op: 'write' },
};
// 从 bridged 工具名 + args 解析出「该工具将要动的所有目标文件」。返回 [{path, mode}, ...](可能空数组)。
// mode ∈ 'write'|'delete'。纯字符串/查表逻辑,无 I/O。每个目标:path 缺失/非字符串/非绝对路径 → 跳过该目标
// (不快照,不阻断);单目标条目产出 0 或 1 条,多目标条目逐字段产出(move 最多 2 条)。
function collectBridgedWriteTargets(bridgedName, args) {
  const bare = unprefixedBridgedName(bridgedName);
  const spec = BRIDGED_WRITE_PATH_ARGS[bare];
  if (!spec) return [];
  const fields = Array.isArray(spec.multi) ? spec.multi : [spec];
  const out = [];
  for (const f of fields) {
    const raw = args && typeof args === 'object' ? args[f.field] : null;
    if (typeof raw !== 'string' || !raw.trim()) continue; // 该字段缺省(如可选 output_path)→ 跳过
    if (!path.isAbsolute(raw)) continue;                   // 相对路径 → 不快照(护栏也只认绝对路径)
    out.push({ path: raw, mode: f.op });
  }
  return out;
}
// v1.4.1 (audit #9):某桥接【写族】工具带【相对路径】写目标时返回该字段名(否则 null)。工作台无法可靠知道 ACC
// 对相对路径的解析基准(ACC 子进程 cwd ≠ 会话工作区)——既不能正确快照也不能正确回滚 → 会变成【静默不可撤销】
// 的写。分发点据此拒绝并引导改用绝对路径(绝对路径照常快照 + 可撤销)。
function bridgedWriteRelativePathArg(bridgedName, args) {
  const bare = unprefixedBridgedName(bridgedName);
  const spec = BRIDGED_WRITE_PATH_ARGS[bare];
  if (!spec) return null;
  const fields = Array.isArray(spec.multi) ? spec.multi : [spec];
  for (const f of fields) {
    const raw = args && typeof args === 'object' ? args[f.field] : null;
    if (typeof raw === 'string' && raw.trim() && !path.isAbsolute(raw)) return f.field;
  }
  return null;
}
// 单目标兼容层(保留原契约:返回首个目标 {path, mode} 或 null)。既有 e2e 直测此签名;多目标工具(move_file)
// 由此返回其第一条(source delete)。新代码应改用 collectBridgedWriteTargets(复数,全目标)。
function collectBridgedWriteTarget(bridgedName, args) {
  const targets = collectBridgedWriteTargets(bridgedName, args);
  return targets.length ? targets[0] : null;
}
