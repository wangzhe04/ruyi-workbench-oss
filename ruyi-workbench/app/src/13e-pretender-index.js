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
const PRETENDER_INDEX_SCHEMA = 5;
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
};

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

async function buildPretenderSessionSlice(sessionId, sourceStamp, usage) {
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
  // 117r-D1(用户第八轮走查③「管家开的速查线程在看板上根本不存在」):看板正文的唯一数据源是
  // GET /api/missions,而那条路由的行集就是 `index.sessions.filter(row => row.card)` —— 卡片只给
  // kind==='mission' 造,于是 steward_quick_ask 开的线程(显式 kind='quick_ask')恒无卡片、恒不进
  // 看板;而顶部那两个数字来自仲裁器(它照常给速查回合占并发位),同一块面板上两个数字互相打脸。
  // 判据【不新造】:用 06i 的 stewardWatchedThread —— 与收件箱第四源逐字同一份实现。它正好画出
  // 这条线:管家的线程要进,用户自己在 2.0 里聊的几百条普通会话(missionId === sessionId、无
  // stewardQuick、无 launchedBy)一律不进,不会把看板淹掉。
  // 注:orphan(只有 Intervention journal、没有会话头)天然为 false —— stewardWatchedThread 第一行
  // 就挡住 head 为空的情况,不必在这里再写一道。
  const carded = kind === 'mission' || stewardWatchedThread(head, sid, missionId);
  const runs = carded ? await listAgentRuns(sid).catch(() => []) : [];
  const card = carded
    ? await buildMissionCard(head, runs, { interventions: ivMeta.interventions, persistent: true })
    : null;
  const usageFact = usage || emptyMissionUsage();
  const changeSeq = Math.max(0, Number(head && head.mission && head.mission.changeSeq) || 0);
  const cardRevision = pretenderHash({ missionId, changeSeq, card });
  const missionRevision = pretenderHash({ cardRevision, usage: usageFact });
  // Health is part of the semantic projection, but physical row/byte counts are not (compaction must keep
  // revision stable). A newly corrupt authority line therefore invalidates ETags even when valid facts match.
  const interventionRevision = pretenderHash({ interventions: ivMeta.interventions, degraded: ivMeta.degraded, corruptLines: ivMeta.corruptLines });
  return {
    sessionId: sid,
    missionId,
    kind,
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
  let ids = Object.keys(sources).sort(), cursor = 0;
  const sessions = [];
  const workers = Array.from({ length: Math.min(12, Math.max(1, ids.length)) }, async () => {
    while (cursor < ids.length) {
      const sid = ids[cursor++];
      const slice = await buildPretenderSessionSlice(sid, sources[sid], usageMap.get(sid));
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
  for (const sid of dirtyIds) {
    const stamp = await pretenderSessionSourceStamp(sid);
    if (!fs.existsSync(sessionPath(sid)) && !fs.existsSync(interventionFilePath(sid))) { delete sources[sid]; rows.delete(sid); continue; }
    sources[sid] = stamp;
    const previous = rows.get(sid);
    const usage = usageIds.has(sid) ? usageMap.get(sid) : (previous && previous.usage);
    const slice = await buildPretenderSessionSlice(sid, stamp, usage);
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

  let value = pretenderIndexRuntime.value;
  if (!value) {
    const disk = await readPretenderIndexDisk();
    const sources = await scanPretenderSessionSources();
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
  for (const [id] of activeChildren) if (!sid || id === sid) rows.push(['turn', id]);
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
  return {
    ...card,
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
