// ============================================================================
// 第75c波(Pretender P1):Mission / Intervention 可重建物化索引、revision cursor 与 ETag。
// 权威源始终是 session head、Intervention journal、run snapshot 与 usage ledger；本文件只维护可删缓存。
// ============================================================================
// 116-5b:2 -> 3。事项卡片的形状变了(加了 displayTitle 与 brief,见 13d buildMissionCard)。
// 不升号的话,盘上那些 sourceStamp 没变过的会话【不会重建】,它们的卡片会一直缺这两个键 —— 壳层
// 那句 displayTitle || title 于是一直回落到原话,而摘要明明已经写在会话头上了。索引是纯派生物
// (durable-state 清册记的就是 fully regenerable),升号的代价只是启动后第一次读时全量重建一次。
// 117p-S2:3 -> 4。卡片又加了 turnSeq 与 lastTurn(30 号文 §8.3,五态判据的新证据)。这次【必须】
// 强制整份重建,而不只是形状升级 —— 否则存量那些已经跑完的管家线程的旧卡片永远不会再刷新
// (它们的会话文件不会再变,sourceStamp 不动),无账本线程的五态就一直卡在「交办中」。
// 117r-D1:4 -> 5。这次变的不是卡片【形状】而是卡片的【产生条件】(见下方 buildPretenderSessionSlice:
// 管家关心的线程现在也有卡片)。不升号的话,存量索引里这些会话的行就是 card:null,而它们的会话文件
// 不会再变(sourceStamp 不动),增量刷新永远不碰它们 —— 用户已经有的那些速查线程会一直不出现在看板上。
// 与 117p-S2 同一条理由:索引是纯派生物,升号的代价只是启动后第一次读时全量重建一次。
// 121-K3:5 -> 6。这次卡片的【形状】与【产生条件】一起变了:行上新增 origin/watched 两个持久字段
// (cardRevision 也把它们算进哈希),产生条件从 watched 一条线换成 threadVisible 四条并集(§4.2)。
// 不升号的话,存量索引里用户自己在 2.0 开的那些会话仍是 card:null,而它们的会话文件不会再变
// (sourceStamp 不动),增量刷新永远不碰它们 —— 本刀要修的那个症状会原样留在存量机器上。
const PRETENDER_INDEX_SCHEMA = 6;
const PRETENDER_INDEX_DIR = '.pretender';
const PRETENDER_INDEX_FILE = 'projection-index.json';
const PRETENDER_PAGE_DEFAULT = 100;
const PRETENDER_PAGE_MAX = 200;

const pretenderIndexRuntime = {
  value: null,
  diskStamp: '',
  persisted: false,
  building: null,
  fullDirty: false,
  dirtySessions: new Set(),
  usageDirty: new Set(),
  // 121-K3(34 号文 §13.3 登记的那条竞态):上一次【真的扫过 sessions 目录】时,那个目录的 mtime,
  // 以及那次扫描完成的时刻。两个值一起用才判得出「这次扫描可信不可信」,见下面 PRETENDER_DIR_SETTLE_MS。
  sourcesDirStamp: '',
  sourcesScannedAt: 0,
};

// 121-K3:目录 mtime 的「沉降窗口」。
// 病根不是 K0b 修的那个(空目录时建出空索引并缓存),而是它的一般形式:**投影索引一旦进了进程内存,
// buildOrLoadPretenderIndex 的 `if (!value)` 就短路掉整段「扫目录 + sameSourceMap 比对」,此后外部
// 写进 sessions 目录的会话【永远】不被发现** —— 没有人给它们打脏页(markPretenderIndexDirty 只长在
// 应用自己的写口上)。导入、多进程写入、以及本仓大量「boot 之后才 seed」的夹具都是这个形状;
// 121-K1 那次全量真红(冷列表 300 条没读满)就是它。
// 自愈判据用【目录级】指纹:一次 stat(paths.sessions) 就够(NTFS/ext4 都在增删条目时更新父目录 mtime),
// 不必为每次读都付一遍 300 条会话 × 3 次 syscall 的全量扫描。
// 但 mtime 有粒度:扫描如果发生在最后一次写的【同一毫秒附近】,这个指纹就还没稳定下来 ——
// 那正是「一边写一边读」的现场。所以只信任「扫描时刻比目录 mtime 晚至少 1 秒」的那一次指纹;
// 更年轻的指纹一律重扫。代价有界:一阵写完之后,第一次落在 1 秒之外的扫描就把指纹变成可信的,
// 此后每次读只多一次 stat。
const PRETENDER_DIR_SETTLE_MS = 1000;

async function pretenderSessionsDirStamp() {
  try { return String(Math.trunc((await fsp.stat(paths.sessions)).mtimeMs)); } catch { return '-'; }
}
function pretenderSourcesTrusted(dirStamp) {
  if (pretenderIndexRuntime.sourcesDirStamp !== dirStamp) return false;
  const mtime = Number(dirStamp);
  if (!Number.isFinite(mtime)) return false;                       // 目录读不到:永远重扫(扫一次也很便宜)
  return pretenderIndexRuntime.sourcesScannedAt - mtime >= PRETENDER_DIR_SETTLE_MS;
}
function pretenderNoteSourcesScan(dirStamp) {
  pretenderIndexRuntime.sourcesDirStamp = dirStamp;
  pretenderIndexRuntime.sourcesScannedAt = Date.now();
}

function pretenderIndexPath() {
  return path.join(paths.sessions, PRETENDER_INDEX_DIR, PRETENDER_INDEX_FILE);
}

// Called by authoritative writers in earlier source modules. A dirty mark never blocks the write; the next
// read refreshes only that session slice. `usage` is separate because refreshing it requires scanning ledgers.
function markPretenderIndexDirty(sessionId, reason = 'source') {
  const sid = safeSessionId(sessionId);
  if (!sid) { pretenderIndexRuntime.fullDirty = true; return; }
  pretenderIndexRuntime.dirtySessions.add(sid);
  if (reason === 'usage') pretenderIndexRuntime.usageDirty.add(sid);
}

function pretenderHash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex').slice(0, 24);
}

async function pretenderFileStamp(file) {
  try {
    const st = await fsp.stat(file);
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch { return '-'; }
}

async function pretenderSessionSourceStamp(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return '-';
  const parts = [
    'h=' + await pretenderFileStamp(sessionPath(sid)),
    'i=' + await pretenderFileStamp(interventionFilePath(sid)),
  ];
  const dir = agentRunDir(sid);
  let files = [];
  try { files = (await fsp.readdir(dir)).filter(f => /^run_[a-f0-9]+\.json$/i.test(f)).sort(); } catch { files = []; }
  for (const file of files) parts.push('r=' + file + ':' + await pretenderFileStamp(path.join(dir, file)));
  return pretenderHash(parts.join('|'));
}

async function scanPretenderSessionSources() {
  let files = [];
  try { files = await fsp.readdir(paths.sessions); } catch { files = []; }
  const idSet = new Set();
  for (const file of files) {
    if (/^sess_[A-Za-z0-9_-]+\.json$/.test(file)) idSet.add(file.slice(0, -5));
    else if (/^sess_[A-Za-z0-9_-]+\.interventions\.ndjson$/.test(file)) idSet.add(file.slice(0, -'.interventions.ndjson'.length));
  }
  const ids = [...idSet].sort();
  const sources = {};
  let cursor = 0;
  const workers = Array.from({ length: Math.min(16, Math.max(1, ids.length)) }, async () => {
    while (cursor < ids.length) {
      const sid = ids[cursor++];
      sources[sid] = await pretenderSessionSourceStamp(sid);
    }
  });
  await Promise.all(workers);
  return sources;
}

// 121-K3(34 号文 §4.1 第三条「最近 N 条」):任务索引窗口里那 N 个 sessionId。
// 按【会话文件 mtime】排,不按会话头里的 updatedAt —— 后者要把每个头都读出来解析一遍 JSON,
// 而这一步只是为了决定「要不要给它造卡片」,一次 readdir + 每文件一次 stat 就够
// (scanPretenderSessionSources 每条会话本来就付着更贵的 2 次 stat + 一次 readdir)。
// 两者的偏差只在「文件写过但 updatedAt 没动」这种退化情形,而那恰恰也算「最近动过」。
// N 取自配置(config.threadIndexRecent,清洗块已 clamp 到 [10,200]);读不到配置就用默认 30,
// 绝不因为配置读失败把索引缩成空(fail-open:这里是可见性窗口,不是权限门)。
async function pretenderRecentSessionIds() {
  const config = await readConfig().catch(() => null);
  const raw = Number(config && config.threadIndexRecent);
  const limit = Number.isFinite(raw)
    ? Math.min(THREAD_INDEX_RECENT_MAX, Math.max(THREAD_INDEX_RECENT_MIN, Math.round(raw)))
    : THREAD_INDEX_RECENT_DEFAULT;
  let files = [];
  try { files = await fsp.readdir(paths.sessions); } catch { return new Set(); }
  const rows = [];
  for (const file of files) {
    if (!/^sess_[A-Za-z0-9_-]+\.json$/.test(file)) continue;
    let mtime = 0;
    try { mtime = Math.trunc((await fsp.stat(path.join(paths.sessions, file))).mtimeMs); } catch { continue; }
    rows.push([file.slice(0, -5), mtime]);
  }
  // 末位按 sessionId 降序兜确定性:同毫秒写入的两条会话不该因为目录枚举顺序漂移而轮流进窗口。
  rows.sort((a, b) => b[1] - a[1] || String(b[0]).localeCompare(String(a[0])));
  return new Set(rows.slice(0, limit).map(row => row[0]));
}

async function pretenderUsageSourceStamp() {
  let files = [];
  try { files = (await fsp.readdir(paths.usage)).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { files = []; }
  const parts = [];
  for (const file of files) parts.push(file + ':' + await pretenderFileStamp(path.join(paths.usage, file)));
  return pretenderHash(parts.join('|'));
}

function emptyMissionUsage() {
  return { inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, subagentTurns: 0, costsByCurrency: {} };
}

function addMissionUsageRow(usage, row) {
  usage.inTok += Number(row && row.inTok) || 0;
  usage.outTok += Number(row && row.outTok) || 0;
  usage.cachedInTok += Number(row && row.cachedInTok) || 0;
  usage.turns += 1;
  if (row && row.kind === 'subagent') usage.subagentTurns += 1;
  const cost = Number(row && row.cost);
  const currency = row && typeof row.currency === 'string' ? row.currency : '';
  if (row && row.costTrusted !== false && currency && Number.isFinite(cost)) {
    usage.costsByCurrency[currency] = (usage.costsByCurrency[currency] || 0) + cost;
  }
}

function finishMissionUsage(usage) {
  for (const key of Object.keys(usage.costsByCurrency)) usage.costsByCurrency[key] = Math.round(usage.costsByCurrency[key] * 1e6) / 1e6;
  return usage;
}

async function buildMissionUsageMap() {
  const map = new Map();
  const rows = await readUsageRows(0).catch(() => []);
  for (const row of rows) {
    const sid = String(row && row.sessionId || '');
    if (!sid) continue;
    let usage = map.get(sid);
    if (!usage) map.set(sid, usage = emptyMissionUsage());
    addMissionUsageRow(usage, row);
  }
  for (const usage of map.values()) finishMissionUsage(usage);
  return map;
}

async function buildPretenderSessionSlice(sessionId, sourceStamp, usage, recentIds) {
  const sid = safeSessionId(sessionId);
  if (!sid) return null;
  const head = safeJsonParse(await fsp.readFile(sessionPath(sid), 'utf8').catch(() => ''), null);
  let ivMeta = await readInterventionsWithMeta(sid);
  if ((!head || !head.id) && ivMeta.bytes === 0) return null;
  // External/legacy journals also get bounded maintenance on a rebuild. Never compact degraded authority.
  if (!ivMeta.degraded && ivMeta.bytes >= 65536 && ivMeta.rowCount > Math.max(256, ivMeta.interventions.length * 3)) {
    await compactInterventionJournal(sid).catch(() => {});
    ivMeta = await readInterventionsWithMeta(sid);
    sourceStamp = await pretenderSessionSourceStamp(sid);
  }
  const kind = head && head.id ? sessionKind(head) : 'orphan';
  const missionId = (head && sessionMissionId(head)) || sid;
  // ── 卡片的产生条件(121-K3,34 号文 §4.2「索引口径」)────────────────────────────────────
  // 117r-D1 把它从「只给 mission 造」放宽到「mission ∪ 管家关心的线程」,理由写在那一版注释里
  // (管家开的速查线程当时在看板上根本不存在)。但那一版仍是【一个判据管两件事】:
  // 「管家要不要动手」同时当成了「它要不要出现在索引里」,于是用户自己在 2.0 里开的普通会话
  // (missionId === sessionId、无 stewardQuick、无 launchedBy)永远不进 /api/missions ——
  // §1.3 数过的那条病根,而它当时被写成「刻意的,理由是噪音」。
  //
  // K3 把一个判据拆成两个(判据本体都在 06i,这里只消费,不新造):
  //   · watched = stewardWatchedThread —— 管家要不要为它动手(收件箱第四源用的还是这一条);
  //   · visible = threadVisible —— 它要不要进索引。四条并集:在途 ∪ 今天有动静 ∪ 最近 N 条 ∪ watched。
  // 噪音不再靠「把整类线程挡在门外」治,靠【窗口】治(§4.2):几百条旧会话既不在途、今天也没动静、
  // 又排不进最近 N 条,自然不进索引;进了索引的旧线程在界面上也只落「更早」组。
  //   · inFlight 是「五态非 done/stopped」的机器事实那一半:此刻有活回合,或挂着未决。
  //     两者都是这里现成的(activeChildren 与刚读出来的 ivMeta),不为它多读一次盘。
  //   · recentIds 由调用方一次算好整份(pretenderRecentSessionIds),每条会话只做一次 Set 查询。
  // 注:orphan(只有 Intervention journal、没有会话头)天然为 false —— 两个判据的第一行都挡住
  // head 为空的情况,不必在这里再写一道。
  const watched = stewardWatchedThread(head, sid, missionId);
  const origin = threadOriginOf(head);
  const inFlight = activeChildren.has(sid)
    || (Array.isArray(ivMeta.interventions) && ivMeta.interventions.some(iv => iv && iv.status === 'pending'));
  const carded = kind === 'mission' || threadVisible(head, {
    now: Date.now(),
    watched,
    inFlight,
    recent: recentIds instanceof Set ? recentIds.has(sid) : false,
  });
  const runs = carded ? await listAgentRuns(sid).catch(() => []) : [];
  const card = carded
    ? await buildMissionCard(head, runs, { interventions: ivMeta.interventions, persistent: true })
    : null;
  const usageFact = usage || emptyMissionUsage();
  const changeSeq = Math.max(0, Number(head && head.mission && head.mission.changeSeq) || 0);
  // 121-K3:origin/watched 进哈希。它们是【持久】字段(跟着切片落盘),不进哈希的话
  // 「用户按下交给管家盯」这种只改 stewardWatch 的写会拿不到新 ETag,左栏画的还是旧标。
  const cardRevision = pretenderHash({ missionId, changeSeq, card, origin, watched });
  const missionRevision = pretenderHash({ cardRevision, usage: usageFact });
  // Health is part of the semantic projection, but physical row/byte counts are not (compaction must keep
  // revision stable). A newly corrupt authority line therefore invalidates ETags even when valid facts match.
  const interventionRevision = pretenderHash({ interventions: ivMeta.interventions, degraded: ivMeta.degraded, corruptLines: ivMeta.corruptLines });
  return {
    sessionId: sid,
    missionId,
    kind,
    // 121-K3(§4.1):来源三值与「管家盯着没有」。两个都是从会话头派生的持久事实,行上直接带着 ——
    // 消费者(左栏、总览、收件箱)零改动即能画来源图形与「交给管家盯」的开关态。
    origin,
    watched,
    changeSeq,
    sourceStamp,
    indexedAt: nowIso(),
    card,
    usage: usageFact,
    interventions: ivMeta.interventions,
    integrity: { degraded: ivMeta.degraded, corruptLines: ivMeta.corruptLines, journalRows: ivMeta.rowCount, journalBytes: ivMeta.bytes },
    cardRevision,
    missionRevision,
    interventionRevision,
    revision: pretenderHash([missionRevision, interventionRevision]),
  };
}

function validatePretenderIndex(value) {
  if (!value || value.schemaVersion !== PRETENDER_INDEX_SCHEMA || !Array.isArray(value.sessions)) return false;
  if (!value.sources || typeof value.sources !== 'object' || typeof value.usageStamp !== 'string') return false;
  return value.sessions.every(row => row && typeof row.sessionId === 'string' && typeof row.revision === 'string');
}

async function readPretenderIndexDisk() {
  try {
    const value = safeJsonParse(await fsp.readFile(pretenderIndexPath(), 'utf8'), null);
    return validatePretenderIndex(value) ? value : null;
  } catch { return null; }
}

function sameSourceMap(a, b) {
  const ak = Object.keys(a || {}).sort(), bk = Object.keys(b || {}).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && a[key] === b[key]);
}

function finalizePretenderIndex(sessions, sources, usageStamp, buildReason) {
  sessions.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
  const missionRows = sessions.filter(row => row.card);
  const missionsRevision = pretenderHash(missionRows.map(row => [row.missionId, row.cardRevision || row.missionRevision]));
  const interventionsRevision = pretenderHash(sessions.map(row => [row.sessionId, row.interventionRevision]));
  const revision = pretenderHash([missionsRevision, interventionsRevision]);
  const degradedSessions = sessions.filter(row => row.integrity && row.integrity.degraded).map(row => row.sessionId);
  const value = {
    schemaVersion: PRETENDER_INDEX_SCHEMA,
    revision,
    missionsRevision,
    interventionsRevision,
    builtAt: nowIso(),
    buildReason,
    sources,
    usageStamp,
    sessions,
    degraded: { active: degradedSessions.length > 0, sessions: degradedSessions },
  };
  value.estimatedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  return value;
}

async function persistPretenderIndex(value) {
  const file = pretenderIndexPath();
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteJson(file, value);
    pretenderIndexRuntime.diskStamp = await pretenderFileStamp(file);
    pretenderIndexRuntime.persisted = true;
  } catch {
    // Cache write failure never compromises authority or blocks reads. Keep the current in-memory projection.
    pretenderIndexRuntime.diskStamp = await pretenderFileStamp(file);
    pretenderIndexRuntime.persisted = false;
  }
}

async function rebuildPretenderIndexFull(reason, knownSources) {
  const sources = knownSources || await scanPretenderSessionSources();
  const usageMap = await buildMissionUsageMap();
  const recentIds = await pretenderRecentSessionIds();   // 121-K3:整份算一次,每条会话只做一次 Set 查询
  let ids = Object.keys(sources).sort(), cursor = 0;
  const sessions = [];
  const workers = Array.from({ length: Math.min(12, Math.max(1, ids.length)) }, async () => {
    while (cursor < ids.length) {
      const sid = ids[cursor++];
      const slice = await buildPretenderSessionSlice(sid, sources[sid], usageMap.get(sid), recentIds);
      if (slice) { sources[sid] = slice.sourceStamp; sessions.push(slice); }
    }
  });
  await Promise.all(workers);
  return finalizePretenderIndex(sessions, sources, await pretenderUsageSourceStamp(), reason);
}

async function refreshPretenderIndexSlices(base, dirtyIds, usageIds, reason) {
  const sources = { ...(base.sources || {}) };
  const rows = new Map(base.sessions.map(row => [row.sessionId, row]));
  const usageMap = usageIds.size ? await buildMissionUsageMap() : null;
  // 121-K3:增量刷新也要算一次窗口 —— 一条刚被写过的会话恰恰最可能【刚刚】挤进最近 N 条,
  // 拿旧窗口判它等于让新会话晚一整轮才上索引。dirtyIds 为空时下面的循环不跑,这一次 readdir
  // 也就不会白付(getPretenderProjectionIndex 只在真有脏页时才走到这里)。
  const recentIds = await pretenderRecentSessionIds();
  for (const sid of dirtyIds) {
    const stamp = await pretenderSessionSourceStamp(sid);
    if (!fs.existsSync(sessionPath(sid)) && !fs.existsSync(interventionFilePath(sid))) { delete sources[sid]; rows.delete(sid); continue; }
    sources[sid] = stamp;
    const previous = rows.get(sid);
    const usage = usageIds.has(sid) ? usageMap.get(sid) : (previous && previous.usage);
    const slice = await buildPretenderSessionSlice(sid, stamp, usage, recentIds);
    if (slice) { sources[sid] = slice.sourceStamp; rows.set(sid, slice); } else { delete sources[sid]; rows.delete(sid); }
  }
  const usageStamp = usageIds.size ? await pretenderUsageSourceStamp() : base.usageStamp;
  return finalizePretenderIndex([...rows.values()], sources, usageStamp, reason);
}

async function buildOrLoadPretenderIndex() {
  const indexFile = pretenderIndexPath();
  const currentDiskStamp = await pretenderFileStamp(indexFile);
  if (pretenderIndexRuntime.value && pretenderIndexRuntime.persisted && currentDiskStamp !== pretenderIndexRuntime.diskStamp) {
    // User deleted/replaced/corrupted the cache while the process was live: discard memory and prove rebuild.
    pretenderIndexRuntime.value = null;
  }

  // ── 121-K3(§13.3):目录级自愈 ───────────────────────────────────────────────────────
  // 下面那句 `if (!value)` 是热路径的命根子(不能每次读都全量扫目录),但它同时也是 §13.3 那条
  // 竞态的病根:索引进了内存之后,外部写进 sessions 目录的会话【永远】不被发现。
  // 这里用一次 stat 把两件事都照顾到:目录指纹没变且已经沉降 -> 什么都不做(热路径逐字不变);
  // 指纹变了、或者变得太新(还在一边写一边读的窗口里)-> 扫一遍目录,真有差异才按差异刷【那几片】。
  // 注意它只在 value 已经在内存里时才跑:value 为空时下面那段本来就要扫,重复扫是白花钱。
  const dirStamp = await pretenderSessionsDirStamp();
  if (pretenderIndexRuntime.value && !pretenderSourcesTrusted(dirStamp)) {
    const base = pretenderIndexRuntime.value;
    const sources = await scanPretenderSessionSources();
    pretenderNoteSourcesScan(dirStamp);
    if (!sameSourceMap(base.sources, sources)) {
      const ids = new Set([...Object.keys(base.sources || {}), ...Object.keys(sources)]);
      const changed = new Set([...ids].filter(id => (base.sources || {})[id] !== sources[id]));
      pretenderIndexRuntime.value = await refreshPretenderIndexSlices(base, changed, new Set(), 'sources_dir_changed');
      pretenderIndexRuntime.persisted = false;   // 变过就得重新落盘(下面统一那一处写)
    }
  }

  let value = pretenderIndexRuntime.value;
  if (!value) {
    const disk = await readPretenderIndexDisk();
    const sources = await scanPretenderSessionSources();
    pretenderNoteSourcesScan(dirStamp);
    const usageStamp = await pretenderUsageSourceStamp();
    if (!disk) {
      // 121-K0b(病根在此):原来的空目录守卫只长在 warmPretenderProjectionIndex 里,只护 boot 那一次
      // 预热。13i 的收件箱 tick 与其他任何调用方一样直接走 getPretenderProjectionIndex -> 这里,不经过
      // warm。当索引文件从未建过(currentDiskStamp === '-',即真·首次)且 sessions 目录此刻确实一份
      // sess_* 都没有(scanPretenderSessionSources 的 sources 为空)时,不能走下面的 rebuildPretenderIndexFull:
      // 那会把一份空索引落盘(persistPretenderIndex,314 行)并存进 pretenderIndexRuntime.value——下一次
      // 调用会在 279 行发现 diskStamp 没变就直接信任这份【已缓存为已建】的空索引,永远不再重新发现
      // (284 行 `if (!value)` 短路)。管家默认开着(121-K0)之后,服务起来的第一拍收件箱 tick 就会撞上这个
      // 窗口——外部导入/多进程写入/本仓大量夹具都在 boot 之后才把会话物化到盘上。
      // 修法:直接 return 一份不落盘、不缓存为已建的空索引,下一次调用(不论隔多久)重新 scanPretenderSessionSources
      // 发现磁盘上的真会话。disk 索引已存在时(currentDiskStamp !== '-',对应下面 corrupt_index 分支)不受影响——
      // 那是「索引文件在但读不出来」,与「索引从未建过」是两回事,仍应立即重建并落盘(热路径逐字不变)。
      if (currentDiskStamp === '-' && Object.keys(sources).length === 0) {
        return finalizePretenderIndex([], sources, usageStamp, 'empty_sessions_dir');
      }
      value = await rebuildPretenderIndexFull(currentDiskStamp === '-' ? 'missing_index' : 'corrupt_index', sources);
    } else if (disk.usageStamp !== usageStamp) {
      value = await rebuildPretenderIndexFull('usage_source_changed', sources);
    } else if (!sameSourceMap(disk.sources, sources)) {
      const ids = new Set([...Object.keys(disk.sources || {}), ...Object.keys(sources)]);
      const changed = new Set([...ids].filter(id => disk.sources[id] !== sources[id]));
      value = await refreshPretenderIndexSlices(disk, changed, new Set(), 'source_changed');
    } else {
      value = disk;
      pretenderIndexRuntime.diskStamp = currentDiskStamp;
      pretenderIndexRuntime.persisted = true;
    }
  }

  const forceFull = pretenderIndexRuntime.fullDirty;
  pretenderIndexRuntime.fullDirty = false;
  const dirtyIds = new Set(pretenderIndexRuntime.dirtySessions);
  const usageIds = new Set(pretenderIndexRuntime.usageDirty);
  pretenderIndexRuntime.dirtySessions.clear();
  pretenderIndexRuntime.usageDirty.clear();
  if (forceFull) value = await rebuildPretenderIndexFull('explicit_rebuild');
  else if (dirtyIds.size) value = await refreshPretenderIndexSlices(value, dirtyIds, usageIds, usageIds.size ? 'usage_dirty' : 'source_dirty');

  if (value !== pretenderIndexRuntime.value || !pretenderIndexRuntime.persisted) await persistPretenderIndex(value);
  pretenderIndexRuntime.value = value;
  return value;
}

async function getPretenderProjectionIndex() {
  if (pretenderIndexRuntime.building) return pretenderIndexRuntime.building;
  const current = buildOrLoadPretenderIndex();
  pretenderIndexRuntime.building = current;
  try { return await current; }
  finally { if (pretenderIndexRuntime.building === current) pretenderIndexRuntime.building = null; }
}

// Wave 80: warm an existing projection as soon as the local service is listening. The empty-directory
// guard here just skips the boot-time warm call entirely when there is nothing to warm yet (cheap early
// return, no index built, no disk touched) — it does not need to protect every caller against trusting an
// empty index. 121-K0b moved that protection to the root (buildOrLoadPretenderIndex above): every caller of
// getPretenderProjectionIndex, not only this boot-time warmer, now gets an unpersisted/uncached empty
// projection when sessions haven't materialized yet, so this function's own check is now redundant-but-
// harmless (kept for its boot-time short-circuit, not for correctness).
async function warmPretenderProjectionIndex() {
  let files = [];
  try { files = await fsp.readdir(paths.sessions); } catch { return null; }
  if (!files.some(file => /^sess_[A-Za-z0-9_-]+(?:\.json|\.interventions\.ndjson)$/.test(file))) return null;
  return getPretenderProjectionIndex();
}

function encodePretenderCursor(kind, revision, offset, limit) {
  return Buffer.from(JSON.stringify({ v: 1, k: kind, r: revision, o: offset, l: limit }), 'utf8').toString('base64url');
}

function decodePretenderCursor(raw) {
  try {
    const value = JSON.parse(Buffer.from(String(raw || ''), 'base64url').toString('utf8'));
    if (!value || value.v !== 1 || typeof value.k !== 'string' || typeof value.r !== 'string' || !Number.isInteger(value.o) || value.o < 0) return null;
    return value;
  } catch { return null; }
}

function paginatePretenderProjection(req, kind, revision, items) {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  const requestedLimit = Number(query.get('limit'));
  let limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : PRETENDER_PAGE_DEFAULT;
  limit = Math.max(1, Math.min(PRETENDER_PAGE_MAX, limit));
  let offset = 0;
  const rawCursor = query.get('cursor');
  if (rawCursor) {
    const cursor = decodePretenderCursor(rawCursor);
    if (!cursor || cursor.k !== kind) return { response: apiFailure('projection.invalid_cursor', { kind }, 'invalid pagination cursor', 400) };
    if (cursor.r !== revision) {
      return { response: apiFailure('projection.snapshot_changed', { cursorRevision: cursor.r, projectionRevision: revision, restartCursor: null }, 'projection changed; restart pagination', 409) };
    }
    offset = cursor.o;
    if (!query.has('limit') && Number.isInteger(cursor.l)) limit = Math.max(1, Math.min(PRETENDER_PAGE_MAX, cursor.l));
  }
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const nextCursor = nextOffset < items.length ? encodePretenderCursor(kind, revision, nextOffset, limit) : null;
  return {
    items: pageItems,
    page: { limit, offset, count: pageItems.length, total: items.length, nextCursor, projectionRevision: revision },
  };
}

function pretenderEtag(kind, revision, page) {
  const suffix = page ? `-${page.offset}-${page.limit}` : '';
  return `W/\"${kind}-${revision}${suffix}\"`;
}

// ETag includes volatile overlay state, while pagination cursors deliberately carry only the persistent
// projection revision. A run/turn heartbeat therefore refreshes conditional reads without invalidating pages.
function pretenderLiveOverlayRevision(sessionId = '') {
  const sid = String(sessionId || '');
  const rows = [];
  // 121-K3:活回合这一行带上 liveTail 摘要的三个值。修前它只有 ['turn', id] —— 一个回合从起跑到
  // 收工整段时间里 ETag 一动不动,而卡片上的「正在调什么」每几百毫秒就变一次,兜底轮询于是永远
  // 拿 304、永远画着第一帧。overlayMissionCard 往卡片里放了什么,这里就得跟着算什么。
  for (const [id, reg] of activeChildren) {
    if (sid && id !== sid) continue;
    const tail = (reg && reg.liveTail && typeof reg.liveTail === 'object') ? reg.liveTail : null;
    rows.push(['turn', id, tail ? String(tail.tool || '') : '', tail ? String(tail.updatedAt || '') : '',
      tail ? Math.max(0, Number(tail.iterations) || 0) : 0]);
  }
  // 同理:在场(§4.3 的 seatedBy)也进卡片,也就必须进这份 revision —— 用户从 X 换坐到 Y,
  // 两行卡片的 seatedBy 都变了,ETag 不动的话左栏要等到下一次会话头写盘才更新。
  try {
    const presence = typeof EventStreamHooks.presenceSnapshot === 'function' ? EventStreamHooks.presenceSnapshot() : [];
    for (const row of (Array.isArray(presence) ? presence : [])) {
      const seated = String((row && row.sessionId) || '');
      if (!seated || (row && row.lens) !== 'classic') continue;
      if (sid && seated !== sid) continue;
      rows.push(['seat', seated]);
    }
  } catch { /* 在场读不到就当没人坐着 —— 与 overlayMissionCard 同一条 fail-open */ }
  for (const runtime of activeAgentRuns.values()) {
    const run = runtime && runtime.run;
    if (!run || (sid && run.sessionId !== sid)) continue;
    rows.push(['run', run.sessionId, run.id, run.status, Number(run.eventSeq) || 0, run.updatedAt || '', Boolean(runtime.paused)]);
  }
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return pretenderHash(rows);
}

function pretenderNotModified(req, etag) {
  return String(req.headers['if-none-match'] || '').split(',').map(v => v.trim()).includes(etag);
}

function pretenderIndexMeta(index) {
  return {
    projectionRevision: index.revision,
    builtAt: index.builtAt,
    estimatedBytes: index.estimatedBytes,
    persisted: pretenderIndexRuntime.persisted,
    degraded: index.degraded,
  };
}

function overlayMissionCard(slice) {
  const card = slice && slice.card;
  if (!card) return null;
  const liveRuns = [];
  for (const runtime of activeAgentRuns.values()) if (runtime && runtime.run && runtime.run.sessionId === slice.sessionId) liveRuns.push(runtime.run);
  liveRuns.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
  const latestLive = liveRuns.length ? liveRuns[liveRuns.length - 1] : null;
  const activeTurn = activeChildren.has(slice.sessionId);
  // 117l D4(§11.9):「它在问你」只活在叠加层 —— 待决的死活与活回合都是此刻的事实,写进持久卡片
  // 就会在下一次重建前一直说谎(与 activeTurn / lastRun 同一条纪律)。判据单点同样是 06i 的 stewardAsksYou。
  // 117m-A2:判据单点从 stewardAsksYou 换成 stewardAsksYouForThread —— 后者认【四类待决】
  // (question > permission > plan > pool),而这里修前只挑 question,于是挂着 permission 的线程
  // 在看板行永远拿不到 asksYou(用户第六轮走查⑥:标着「需要你」的行上一枚 pill 都没有)。
  // 抽取待决行的那一段一并搬进 06i:两个调用面(13g 与本处)现在喂的是同一个入参形状。
  const pending = (Array.isArray(slice.interventions) ? slice.interventions : [])
    .filter(iv => iv && iv.status === 'pending');
  const asksYou = stewardAsksYouForThread({
    pending,
    activeTurn,
    lastAssistantText: String(card.lastSay || ''),
  });
  // 121-K3(§4.2「行加 liveTail 摘要」/ §5「左栏在跑组每行的第二行」):正在调什么工具、第几次、
  // 什么时候有的输出。**摘要不带正文** —— `text`/`full` 一个字都不进来(§6.1 的红线:观察面不承载
  // 工具输出正文;要正文的面走 GET /api/sessions/:id 的 liveTail,那里有自己的预算与门)。
  // 没有活回合就是 null,不编一个空壳出来让消费者分不清「没在跑」与「在跑但还没输出」。
  const liveReg = activeTurn ? activeChildren.get(slice.sessionId) : null;
  const liveTailReg = (liveReg && liveReg.liveTail && typeof liveReg.liveTail === 'object') ? liveReg.liveTail : null;
  const liveTail = liveTailReg ? {
    tool: String(liveTailReg.tool || ''),
    updatedAt: String(liveTailReg.updatedAt || ''),
    iterations: Math.max(0, Number(liveTailReg.iterations) || 0),
  } : null;
  // 121-K3(§4.3/§4.5):用户此刻是不是就坐在这条线程前面。事实源是 13r 的在场快照(SSE 连接自报的
  // lens/sessionId),经 00-boot 的延迟绑定命名空间取 —— 13e 拼在 13r 之前,直引 13r 的符号是前向边。
  // 钩子没填充(13r 还没加载 / 事件流关着)或抛错,一律当「没人坐着」:在场信号缺席时管家照旧行事,
  // 这是 fail-open,因为它管的是【打扰纪律】不是权限。
  let seatedBy = null;
  try {
    const presence = typeof EventStreamHooks.presenceSnapshot === 'function' ? EventStreamHooks.presenceSnapshot() : [];
    if (Array.isArray(presence) && presence.some(row => row && row.lens === 'classic' && String(row.sessionId || '') === slice.sessionId)) {
      seatedBy = 'user';
    }
  } catch { seatedBy = null; }
  return {
    ...card,
    // 121-K3:两个持久字段随卡片一起下发(切片上有,卡片上没有 —— 消费者读的是卡片)。
    origin: String(slice.origin || 'user'),
    watched: slice.watched === true,
    liveTail,
    seatedBy,
    activeTurn,
    asksYou,
    runCount: Math.max(Number(card.runCount) || 0, liveRuns.length),
    lastRun: latestLive ? missionRunDigest(latestLive, true) : card.lastRun,
    freshness: {
      persistentRevision: slice.cardRevision || slice.missionRevision,
      indexedAt: slice.indexedAt,
      liveOverlay: activeTurn || liveRuns.length > 0,
      overlayAt: nowIso(),
    },
  };
}
