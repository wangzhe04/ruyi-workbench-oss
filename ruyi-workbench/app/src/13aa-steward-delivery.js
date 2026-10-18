// 3.x 第四轮：只读交付投影。证据随既有 turnSummary 保存，不另建成果或验收账本。
// 引擎及工具通过 StewardHooks 迟绑定，避免给既有依赖环增加成员。
const STEWARD_DELIVERY_LIMITS = Object.freeze({ files: 20, checks: 50, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
function stewardDeliveryRows(session, turnSeq) {
  return (Array.isArray(session.messages) ? session.messages : []).filter(row => Number(row && row.turnSeq) === turnSeq);
}
function stewardDeliveryFiles(summary, cwd) {
  const pathsByKey = new Map();
  for (const row of [...(Array.isArray(summary.artifacts) ? summary.artifacts : []), ...(Array.isArray(summary.filesChanged) ? summary.filesChanged : [])]) {
    if (!row || typeof row.path !== 'string' || !row.path.trim()) continue;
    const absolute = path.resolve(cwd || '', row.path);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    pathsByKey.set(key, { path: absolute, name: path.win32.basename(absolute), kind: kindForPath(absolute) });
  }
  return [...pathsByKey.values()];
}
async function stewardDeliveryInspect(file, session, config, budget, keepBytes = false) {
  const target = file.path;
  try {
    if (await remoteUncDenialResolved([target], session, config)) return { ...file, status: 'blocked' };
    const real = await fsp.realpath(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!real) return { ...file, status: 'missing' };
    await ensureDataRootReal();
    const roots = await Promise.all(fileAllowedRoots(session, config).map(root => fsp.realpath(root).catch(() => root)));
    if (!pathWithinAnyRoot(real, roots) || isSensitiveDataPath(target) || isSensitiveDataPath(real) || await isSensitiveHardlinkAlias(real)) return { ...file, status: 'blocked' };
    const handle = await fsp.open(real, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) return { ...file, status: 'unavailable' };
      if (before.size > STEWARD_DELIVERY_LIMITS.fileBytes || budget.bytes + before.size > STEWARD_DELIVERY_LIMITS.totalBytes) return { ...file, status: 'unverified', size: before.size };
      budget.bytes += before.size;
      // 限额读取而不是 readFile：文件在 stat 之后增长也不能越过预算。
      const buffer = Buffer.alloc(before.size + 1);
      let read = 0;
      while (read < buffer.length) {
        const got = await handle.read(buffer, read, buffer.length - read, read);
        if (!got.bytesRead) break;
        read += got.bytesRead;
      }
      const after = await handle.stat();
      if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { ...file, status: 'unavailable' };
      return { ...file, status: 'available', size: read, fingerprint: crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('hex'), ...(keepBytes ? { bytes: buffer.subarray(0, read) } : {}) };
    } finally { await handle.close(); }
  } catch { return { ...file, status: 'unavailable' }; }
}
async function stewardCaptureDelivery(session, summary, options = {}) {
  if (stewardRawKind(session) === 'steward') return;
  const config = await readConfig();
  if (config.stewardEnabledV1 !== true) return;
  const all = stewardDeliveryFiles(summary, session.cwd);
  const budget = { bytes: 0 }, files = [];
  for (const file of all.slice(0, STEWARD_DELIVERY_LIMITS.files)) files.push(await stewardDeliveryInspect(file, session, config, budget));
  const missionId = sessionMissionId(session);
  const container = missionId && missionId !== session.id ? await readMissionContainer(missionId).catch(() => null) : null;
  const acceptance = buildMissionAcceptanceProjection(session.mission, container);
  const checks = acceptance.items.slice(0, STEWARD_DELIVERY_LIMITS.checks).map(item => {
    const humanAt = item.provenance === 'human' ? acceptance.container?.items.find(row => row.done && row.text.trim() === item.desc.trim())?.doneAt : '';
    const checkedAt = item.provenance === 'human' ? humanAt || '' : item.checkedAt || '';
    return { ...item, checkedAt, currentTurn: !!checkedAt && Date.parse(checkedAt) >= Number(options.startedAt || Infinity) };
  });
  if (!acceptance.ledger && acceptance.container) {
    for (const item of acceptance.container.items.slice(0, STEWARD_DELIVERY_LIMITS.checks)) checks.push({ id: item.id, desc: item.text,
      status: item.done ? 'done' : 'pending', provenance: item.done ? 'human' : 'open', checkState: 'none', checkedAt: item.doneAt,
      currentTurn: !!item.doneAt && Date.parse(item.doneAt) >= Number(options.startedAt || Infinity) });
  }
  summary.deliveryEvidence = { schema: 1, capturedAt: nowIso(), files, filesTruncated: all.length > files.length,
    checks: checks.slice(0, STEWARD_DELIVERY_LIMITS.checks), checksRecorded: acceptance.ledger || !!(acceptance.container && acceptance.container.total) };
}
function stewardDeliverySource(session, turnSeq) {
  const rows = stewardDeliveryRows(session, turnSeq);
  if (!rows.length) return null;
  const summaryRow = [...rows].reverse().find(row => row.role === 'assistant' && row.turnSummary && Number(row.turnSummary.turnSeq) === turnSeq);
  const summary = summaryRow ? summaryRow.turnSummary : { artifacts: [], filesChanged: [] };
  // 导入内容不是本机执行证据；旧回合没有快照时也不能借当前任务的检查充数。
  const evidence = summaryRow && !summaryRow.meta?.imported && summary.deliveryEvidence?.schema === 1 ? summary.deliveryEvidence : null;
  const stamp = crypto.createHash('sha256').update(JSON.stringify({ sessionId: session.id, cwd: session.cwd, rewindGen: session.rewindGen || 0,
    turnSeq, rows: rows.map(row => ({ role: row.role, content: row.content, segments: row.segments, turnSummary: row.turnSummary })) })).digest('hex');
  return { rows, summary, evidence, stamp };
}
async function stewardDeliveryProjection(sessionId, turnSeq, config) {
  const session = await loadSession(sessionId, { omitProviderHistory: true });
  if (!session || stewardRawKind(session) === 'steward') return stewardFail('not_found', '交付来源任务不存在');
  const source = stewardDeliverySource(session, turnSeq);
  if (!source) return stewardFail('delivery_not_found', '指定回合已不存在,没有使用其它回合代替');
  const recorded = source.evidence;
  const all = stewardDeliveryFiles(source.summary, session.cwd);
  const files = [], budget = { bytes: 0 };
  for (const file of all.slice(0, STEWARD_DELIVERY_LIMITS.files)) {
    const current = await stewardDeliveryInspect(file, session, config, budget);
    const previous = recorded && recorded.files.find(row => row.path === file.path);
    const version = current.status === 'available' ? (!previous?.fingerprint ? 'unverified' : current.fingerprint === previous.fingerprint ? 'same' : 'changed') : current.status;
    files.push({ ...current, status: version });
  }
  const allFilesSame = files.every(file => file.status === 'same') && !(recorded && recorded.filesTruncated);
  const inProgress = !!sessionExecutionSnapshot(sessionId);
  const fileStamp = crypto.createHash('sha256').update(JSON.stringify(files.map(file => [file.path, file.status, file.fingerprint || '', file.size]))).digest('hex');
  const checks = recorded ? recorded.checks.map(item => ({ ...item,
    applicable: item.currentTurn === true && allFilesSame && !inProgress && Number(session.turnSeq) === turnSeq })) : [];
  return { ok: true, sessionId, title: sessionDisplayTitle(session), turnSeq, latestTurnSeq: Number(session.turnSeq) || 0,
    sourceStamp: source.stamp, fileStamp, capturedAt: recorded?.capturedAt || '', evidenceRecorded: !!recorded,
    files, filesTruncated: all.length > files.length, checks, checksRecorded: recorded?.checksRecorded === true,
    unfinished: checks.filter(item => item.status !== 'done').map(item => ({ id: item.id, desc: item.desc, status: item.status })),
    outdated: Number(session.turnSeq) > turnSeq, inProgress };
}
async function stewardValidateDeliveryReference(sessionId, reference, config) {
  if (!reference || !Number.isSafeInteger(reference.turnSeq) || reference.turnSeq <= 0 || !/^[a-f0-9]{64}$/.test(reference.sourceStamp || '') || !Number.isSafeInteger(reference.latestTurnSeq)) return stewardFail('invalid_request', '修订来源无效,请重新打开交付卡');
  const current = await stewardDeliveryProjection(sessionId, reference.turnSeq, config);
  if (!current.ok) return current;
  if (current.sourceStamp !== reference.sourceStamp || current.fileStamp !== reference.fileStamp || current.latestTurnSeq !== reference.latestTurnSeq) return stewardFail('delivery_changed', '来源、文件或任务已有变化,请刷新交付卡并重新发起修订');
  return { ok: true, reference: { sessionId, turnSeq: reference.turnSeq, sourceStamp: reference.sourceStamp,
    latestTurnSeq: reference.latestTurnSeq, fileStamp: reference.fileStamp, files: current.files.map(file => file.path) } };
}
async function handleStewardDeliveryApiRoutes(req, res, pathname) {
  if (req.method !== 'GET' || pathname !== '/api/steward/delivery') return;
  if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
  res.setHeader('cache-control', 'no-store');
  const q = new URL(req.url, 'http://x').searchParams;
  const sid = safeSessionId(q.get('sessionId')), seq = Number(q.get('turnSeq'));
  if (!sid || !Number.isSafeInteger(seq) || seq <= 0) return send(res, apiFailure('delivery.invalid_source', {}, '需要明确任务与回合', 400));
  const config = await readConfig();
  const delivery = await stewardDeliveryProjection(sid, seq, config);
  if (!delivery.ok) return send(res, apiFailure(delivery.error, {}, delivery.message, 404));
  if (!q.has('file')) return send(res, json(delivery));
  const index = Number(q.get('file'));
  const file = Number.isSafeInteger(index) && index >= 0 ? delivery.files[index] : null;
  if (!file || !file.fingerprint || q.get('fingerprint') !== file.fingerprint || q.get('sourceStamp') !== delivery.sourceStamp) return send(res, apiFailure('delivery.file_changed', {}, '文件或来源已变化,请重新检查交付卡', 409));
  // 使用既有预览器；路径仅取本回合真实记录,客户端不能指定另一个同名文件。
  const session = await loadSession(sid, { omitProviderHistory: true });
  if (!session) return send(res, apiSessionNotFound());
  const snapshot = await stewardDeliveryInspect(file, session, config, { bytes: 0 }, true);
  if (!snapshot.bytes || snapshot.fingerprint !== q.get('fingerprint')) return send(res, apiFailure('delivery.file_changed', {}, '文件已变化,请刷新文件状态', 409));
  return send(res, json(await readFilePreview(file.path, snapshot.bytes)));
}
DeliveryHooks.capture = stewardCaptureDelivery;
StewardHooks.deliveryProjection = stewardDeliveryProjection;
StewardHooks.validateDeliveryReference = stewardValidateDeliveryReference;
StewardHooks.handleDeliveryApiRoutes = handleStewardDeliveryApiRoutes;
