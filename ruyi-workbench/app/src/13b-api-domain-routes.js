// 第49波49f (A1): handleApi 域分组拆分第一批 —— MCP / checkpoint·storage / steer 三组域路由
// 从 13-http-router.js 的 handleApi 原样抽出(共享作用域拼接,零 import 接线,行为不变)。
// 每个函数:命中自己域的路由则处理并 return true,否则 return false(调用处 fallthrough)。
// 顺序与语义与原 handleApi 内联块完全一致;e2e 全量即回归网。

// ── W2 迁移中心:/api/migration/scan|apply|undo|recycle(W8 加 skills/copy)──────────────────────────────────────
// 实现在 13u-migration-center.js(零入边),经 00-boot 的 MigrationHooks 迟绑定调进去。五条都是 token 级
// (01b-route-auth):scan 回的是本机各处配置里的路径与指令文件摘要,apply/undo 会改写外部配置文件,
// recycle 会把一个目录移进回收站(另要 body.confirm === body.root),skills/copy 往 dataRoot/skills 写技能副本。命中返回 true,否则 false。
async function handleMigrationApiRoutes(req, res, pathname) {
  const reply = result => {
    const r = result && typeof result === 'object' ? { ...result } : { ok: false, error: 'no-result' };
    const status = Number.isInteger(r.status) ? r.status : (r.ok === false ? 400 : 200);
    delete r.status;
    // 失败一律给稳定码 migration.<原因>(与 apiFailure 同形 {code, params, message}),前端按码分支不按句子。
    if (r.ok === false && typeof r.error === 'string') r.error = { code: 'migration.' + r.error.replace(/-/g, '_'), params: {}, message: r.error };
    send(res, json(r, status));
    return true;
  };
  const hook = name => (typeof MigrationHooks[name] === 'function' ? MigrationHooks[name] : null);
  const unavailable = () => reply({ ok: false, error: 'migration center unavailable', status: 503 });
  if (req.method === 'GET' && pathname === '/api/migration/scan') {
    const fn = hook('scan'); if (!fn) return unavailable();
    return reply(await fn());
  }
  if (req.method === 'POST' && pathname === '/api/migration/apply') {
    const fn = hook('apply'); if (!fn) return unavailable();
    return reply(await fn((await readJsonBody(req)) || {}));
  }
  if (req.method === 'POST' && pathname === '/api/migration/undo') {
    const fn = hook('undo'); if (!fn) return unavailable();
    return reply(await fn((await readJsonBody(req)) || {}));
  }
  if (req.method === 'POST' && pathname === '/api/migration/recycle') {
    const fn = hook('recycle'); if (!fn) return unavailable();
    return reply(await fn((await readJsonBody(req)) || {}));
  }
  // W8:外部技能「复制到如意」(整目录拷进 dataRoot/skills/<id>/,附来源记录;撤销走上面的 /undo)。
  if (req.method === 'POST' && pathname === '/api/migration/skills/copy') {
    const fn = hook('copySkills'); if (!fn) return unavailable();
    return reply(await fn((await readJsonBody(req)) || {}));
  }
  return false;
}

// ── MCP 域:/api/mcp/import-folder、/api/mcp/import-config/scan|apply ─────────────────────────
async function handleMcpApiRoutes(req, res, pathname) {
  if (await handleMigrationApiRoutes(req, res, pathname)) return true;
  // v1.0.2-S5: 从文件夹导入外部 MCP。POST /api/mcp/import-folder {path}(用户经 /api/pick-folder 选好的绝对
  // 路径)。读该文件夹下 ruyi-mcp.json 清单(≤32KB), 经 sanitizeExternalMcpServer 清洗, 尊重 externalMcpServers
  // ≤10 上限, id 已存在则更新该条(否则追加), 持久化 config(writeConfig 原子写)并再生成 generateMcpConfig。
  // token 白名单已加; 审计 action 'mcp_import'; 响应附 server(env 值掩码防泄漏)。
  if (req.method === 'POST' && pathname === '/api/mcp/import-folder') {
    const body = await readJsonBody(req);
    const folder = body && typeof body.path === 'string' ? body.path.trim() : '';
    if (!folder || !path.isAbsolute(folder)) return send(res, json({ ok: false, error: '请提供文件夹的绝对路径' }, 400));
    const MANIFEST_TEMPLATE = { id: 'my-mcp', label: '我的 MCP 服务', command: './server.exe', args: [], env: {}, cwd: '', enabled: true };
    // 读清单(≤32KB)。缺失/超限/解析失败 → 统一「缺少有效清单」+ template(前端可据此提示用户如何写)。
    const manifestPath = path.join(folder, 'ruyi-mcp.json');
    let raw = null;
    try {
      const st = await fsp.stat(manifestPath);
      if (!st.isFile() || st.size > 32 * 1024) throw new Error('manifest too large or not a file');
      raw = safeJsonParse(await fsp.readFile(manifestPath, 'utf8'), null);
    } catch { raw = null; }
    if (!raw || typeof raw !== 'object') {
      return send(res, json({ ok: false, error: '该文件夹缺少有效的 ruyi-mcp.json 清单', template: MANIFEST_TEMPLATE }));
    }
    // cwd 缺省 = 该文件夹本身(相对 command 如 ./server.exe 由 cwd 保证; args 里的相对路径不改写)。
    const withCwd = { ...raw, cwd: (typeof raw.cwd === 'string' && raw.cwd.trim()) ? raw.cwd : folder };
    const cleaned = sanitizeExternalMcpServer(withCwd);
    if (!cleaned) return send(res, json({ ok: false, error: '清单无效:至少需要 id 与 command 两个字段', template: MANIFEST_TEMPLATE }));
    // 117n-M2:读-改-写整段进 mutateConfig 的临界区(此前裸 readConfig -> writeConfig,与并发的
    // 设置保存/启停互相吞字段)。上限判定也搬进锁内 —— 用锁外快照判 10 条上限本身就是竞态。
    const imp = await mutateConfig(async (config) => {
      const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
      const existingIdx = list.findIndex(s => s && s.id === cleaned.id);
      let updated = false;
      if (existingIdx >= 0) { list[existingIdx] = cleaned; updated = true; }
      else {
        if (list.length >= 10) return { abort: 'limit' };
        list.push(cleaned);
      }
      config.externalMcpServers = list;
      // 显式再导入覆盖撤销:把该 id 从 dismissedMcpIds 移除(与 import-config/apply 同语义)。
      config.dismissedMcpIds = (Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds : []).filter(x => x !== cleaned.id);
      return { value: updated };
    });
    if (!imp.ok) return send(res, json({ ok: false, error: '外部 MCP 数量已达上限(最多 10 个),请先移除一个再导入' }));
    const next = imp.config; const updated = imp.value;
    await generateMcpConfig(next.mcpCommandMode).catch(() => {}); // 再生成 .mcp.json(缺失时不阻断导入)
    logEvent({ kind: 'mcp_import', id: cleaned.id, updated, source: folder });
    // 响应附清洗后的条目, env 值掩码(参考 apiKey 掩码模式, 防泄漏 token 类环境变量)。
    // 107-S0b:改用与 GET /api/status 同一个 MCP 掩码 —— 修前只遮 env,远程清单的 headers 与 args 里的 `--token xyz` 原样回显。
    const serverEcho = maskExternalMcpServerForDisplay(cleaned);
    return send(res, json({ ok: true, ...(updated ? { updated: true } : { added: true }), server: serverEcho }));
  }
  // 48c: MCP 配置导入器 v1 -- 从 Claude Code / Codex 配置导入(03 §4.1)。两步:scan(发现+冲突检测) -> apply(勾选写回)。
  //   POST /api/mcp/import-config/scan { paths?: [...] }  -- paths 缺省自动发现 ~/.claude.json + ~/.codex/config.toml
  //   POST /api/mcp/import-config/apply { servers: [{id,label,command,args,env,cwd}] }  -- 只导 stdio(unsupported 跳过),id 撞名更新,≤10 上限
  if (req.method === 'POST' && pathname === '/api/mcp/import-config/scan') {
    const body = await readJsonBody(req);
    const config = await readConfig();
    let paths = Array.isArray(body && body.paths) ? body.paths.map(p => String(p || '').trim()).filter(Boolean) : null;
    if (!paths || !paths.length) {
      // 自动发现:用户级 ~/.claude.json(Claude Code 全局)+ ~/.codex/config.toml(Codex 全局)。项目级 .mcp.json 由用户显式传 path。
      paths = [path.join(os.homedir(), '.claude.json'), path.join(os.homedir(), '.codex', 'config.toml')];
    }
    const { servers, errors } = await scanMcpSources(paths, config);
    logEvent({ kind: 'mcp_import_scan', sources: paths.length, found: servers.length, errors: errors.length });
    return send(res, json({ ok: true, servers, errors, scanned: paths }));
  }
  if (req.method === 'POST' && pathname === '/api/mcp/import-config/apply') {
    const body = await readJsonBody(req);
    const incoming = Array.isArray(body && body.servers) ? body.servers : [];
    // 117n-M2:同 import-folder,合并 + 上限 + dismissed 记账整段进 mutateConfig 的临界区。
    const imp = await mutateConfig(async (config) => {
      const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
      const added = [], updated = [], skipped = [];
      for (const raw of incoming) {
        // 49c:sse/http 已落地(McpHttpClient)—— 远程条目与 stdio 同走 sanitize(缺 url 判无效);
        // 解析期 unsupported 标记(如远程缺 url)仍跳过。
        if (raw && raw.unsupported) { skipped.push({ id: String(raw && raw.id || ''), reason: String(raw.unsupported) }); continue; }
        const srv = sanitizeExternalMcpServer(raw); // 复用 import-folder 同款清洗(stdio:需 id+command;远程:需 id+http(s) url)
        if (!srv) { skipped.push({ id: String(raw && raw.id || ''), reason: '无效条目(缺 id/command/url)' }); continue; }
        const idx = list.findIndex(s => s && s.id === srv.id);
        if (idx >= 0) { list[idx] = srv; updated.push(srv.id); }
        else {
          if (list.length >= 10) { skipped.push({ id: srv.id, reason: '外部 MCP 数量已达上限(10)' }); continue; }
          list.push(srv); added.push(srv.id);
        }
      }
      if (!added.length && !updated.length) return { abort: { skipped } };
      config.externalMcpServers = list;
      // 显式再导入覆盖撤销:把本次导入的 id 从 dismissedMcpIds 移除(用户改变主意,要它回来了)。
      const reImported = new Set([...added, ...updated]);
      config.dismissedMcpIds = (Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds : []).filter(x => !reImported.has(x));
      return { value: { added, updated, skipped } };
    });
    if (!imp.ok) return send(res, json({ ok: false, error: '没有可导入的条目', skipped: imp.value.skipped }));
    const next = imp.config; const { added, updated, skipped } = imp.value;
    await generateMcpConfig(next.mcpCommandMode).catch(() => {});
    logEvent({ kind: 'mcp_import', ids: [...added, ...updated], added: added.length, updated: updated.length, source: 'import-config' });
    return send(res, json({ ok: true, added, updated, skipped }));
  }
  // ── 第55波 EC-C 55a: MCP 运维闭环 -- 统一连接器读模型 + 健康探针 ──
  // GET /api/mcp/connectors?probe=1  -> 统一清单(desktop/config/drop-in 三源 + source/transport/
  //   commandOrUrl/enabled/builtIn/capabilities;probe=1 时对 enabled 条目跑一次 probeMcpConnector 附
  //   health)。env 值掩码;不返回可执行命令串供前端拼写(配置变更走 import/toggle 路由 + token + 审计)。
  //   兼容矩阵随附(连接前说明各 transport 能力与局限,退出条件#4)。
  if (req.method === 'GET' && pathname === '/api/mcp/connectors') {
    const config = await readConfig();
    let probe = false;
    try { probe = new URL(req.url, 'http://127.0.0.1').searchParams.get('probe') === '1'; } catch { /* ignore */ }
    const connectors = await buildMcpConnectorInventory(config, { probe });
    logEvent({ kind: 'mcp_connectors_list', count: connectors.length, probe });
    return send(res, json({ ok: true, connectors, compat: MCP_COMPAT_MATRIX }));
  }
  // POST /api/mcp/connectors/health { id, timeoutMs? } -> 单连接器显式重测(用户「为什么不可用」排查)。
  //   id 必须在 resolveExternalMcpServers 的启用清单内;disabled/未配置 -> 404 人话。返回 {ok, health}。
  if (req.method === 'POST' && pathname === '/api/mcp/connectors/health') {
    const body = await readJsonBody(req);
    const id = String((body && body.id) || '').trim();
    if (!id) return send(res, json({ ok: false, error: 'id is required' }, 400));
    const config = await readConfig();
    const entry = resolveExternalMcpServers(config).find(e => e.id === id);
    if (!entry) return send(res, json({ ok: false, error: '连接器不在当前启用清单内(可能已禁用或未配置): ' + id }, 404));
    const health = await probeMcpConnector(entry, { timeoutMs: Math.max(2000, Number(body.timeoutMs) || 10000) });
    logEvent({ kind: 'mcp_connector_probe', id, status: health.status, category: health.category || null });
    return send(res, json({ ok: true, health }));
  }
  // ── 第55波 EC-C 55b: 启停/删除持久化 -- 仅 config 源(externalMcpServers)可操作 ──
  //   desktop(内置 ai-computer-control)与 drop-in(运行时目录合并)拒绝并给原因 -- 内置连接器与
  //   用户连接器必须有清楚边界(EC-C 退出条件)。启停/删除只动该 id:writeConfig 原子落盘(重启后
  //   状态与配置一致) + invalidateMcpRuntime(id) 杀活客户端/清失败冷却(停用后不再重连,启用后
  //   可立即重测) + 审计;无关连接器的客户端与配置不受影响。
  //   mcpConnectorMutateError(id, config):可 mutate 返回 null;否则 {status, error} 人话原因。
  //   117n-M2:守卫与整套副作用已下沉到 04 的 mutateMcpConnector(工具面 mcp_configure 与这两条路由
  //   共用同一个内核;04 -> 13b 是前向边,所以是函数下沉到 04,不是路由上提)。下面只剩 HTTP 形状。
  // POST /api/mcp/connectors/toggle {id, enabled:boolean} -> 启停用户连接器。
  if (req.method === 'POST' && pathname === '/api/mcp/connectors/toggle') {
    const body = await readJsonBody(req);
    const id = String((body && body.id) || '').trim();
    if (!id) return send(res, json({ ok: false, error: 'id is required' }, 400));
    if (typeof (body && body.enabled) !== 'boolean') return send(res, json({ ok: false, error: 'enabled 必须是布尔值(true=启用 / false=停用)' }, 400));
    const enabled = body.enabled;
    // 117n-M2:源守卫 / 改 list / 落盘 / invalidateMcpRuntime / 重生成 .mcp.json / drop-in 遮蔽警告 /
    // 审计,全部下沉进 mutateMcpConnector(04),与工具面 mcp_configure 共用同一条路径。这里只剩 HTTP 形状。
    const r = await mutateMcpConnector({ op: 'set-enabled', id, enabled });
    if (!r.ok) return send(res, json({ ok: false, error: r.error }, r.status));
    return send(res, json({ ok: true, id, enabled, ...(r.warning ? { warning: r.warning } : {}) }));
  }
  // DELETE /api/mcp/connectors {id} -> 删除用户连接器(持久化;删后即卸载,重启不复活)。
  if (req.method === 'DELETE' && pathname === '/api/mcp/connectors') {
    const body = await readJsonBody(req);
    const id = String((body && body.id) || '').trim();
    if (!id) return send(res, json({ ok: false, error: 'id is required' }, 400));
    // 117n-M2:同 toggle,整段下沉进 mutateMcpConnector(04)—— 含 dismissedMcpIds 记账与 drop-in
    // 遮蔽告知(55b 对抗审查那条:删除遮蔽同 id drop-in 的 config 条目后 drop-in 版本会静默接管)。
    const r = await mutateMcpConnector({ op: 'remove', id });
    if (!r.ok) return send(res, json({ ok: false, error: r.error }, r.status));
    return send(res, json({ ok: true, id, removed: true, ...(r.warning ? { warning: r.warning } : {}) }));
  }
  return false;
}

// ── checkpoint·storage 域:/api/storage/policy|clean、/api/checkpoints/rollback、/api/session/rewind ──
async function handleCheckpointApiRoutes(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/storage/policy') {
    const body = await readJsonBody(req);
    const src = (body && typeof body === 'object')
      ? (body.storagePolicy && typeof body.storagePolicy === 'object' ? body.storagePolicy : body)
      : {};
    // 117n-M2:走 mutateConfig 的临界区(此前裸 readConfig -> 改字段 -> writeConfig,与并发的
    // /api/config 保存互相吞:一次并发就能让刚存的存储策略或刚存的 Provider 其中一份凭空消失)。
    const saved = (await mutateConfig(async (config) => {
      config.storagePolicy = { ...(config.storagePolicy || {}), ...src };
    })).config;
    return send(res, json({ ok: true, policy: normalizeStoragePolicy(saved.storagePolicy) }));
  }
  if (req.method === 'POST' && pathname === '/api/storage/clean') {
    const body = await readJsonBody(req);
    const VALID = new Set(['logs', 'agent-runs', 'webcache', 'engine-transcripts']);
    let targets = null; // null = 全部
    if (body && body.target && body.target !== 'all') {
      const t = String(body.target);
      if (!VALID.has(t)) return send(res, json({ ok: false, error: 'unknown target' }, 400));
      targets = new Set([t]);
    }
    const config = await readConfig();
    return send(res, json(await storageSweep(config.storagePolicy, targets)));
  }
  // v0.8-S4a: checkpoint rollback (mutating; header-token — see needsToken whitelist above). entrySeq given
  // = single-entry rollback; omitted = whole turn (all entries for turnSeq, reverse order). Idempotent:
  // reverted entries are removed from the index, so re-rolling the same turn → {ok:false,error:'no entries'}.
  if (req.method === 'POST' && pathname === '/api/checkpoints/rollback') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId); // F4: consume only well-formed ids
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    if (body.turnSeq === undefined || body.turnSeq === null) return send(res, json({ ok: false, error: 'turnSeq is required' }, 400));
    // F1: refuse rollback while a turn is live for this session — same guard/wording as /api/session/rewind.
    // The three index.json writers (journalRecord / journalGc / journalRollback) all do an unlocked
    // read-modify-write; letting rollback through during an active turn races those writers and can drop
    // an update (lost-write on the shared index). rewindSession has this guard internally; the direct
    // rollback route did not, so add it here BEFORE calling journalRollback.
    if (activeChildren.has(sessionId)) return send(res, json({ ok: false, error: '回合进行中,请先停止' }, 409));
    if ([...activeAgentRuns.values()].some(live => live && live.run && live.run.sessionId === sessionId && !live.closing)) {
      return send(res, json({ ok: false, error: '班组 Run 进行中,请先停止' }, 409));
    }
    const rollback = await journalRollback(sessionId, body.turnSeq, body.entrySeq);
    if (rollback && rollback.ok) {
      await bumpMissionChangeSeq(sessionId, {
        type: 'rewind',
        cursor: { turnSeq: Number(body.turnSeq), ...(body.entrySeq == null ? {} : { entrySeq: Number(body.entrySeq) }) },
        detail: {
          rollbackScope: body.entrySeq == null ? 'turn' : 'entry',
          filesReverted: Array.isArray(rollback.reverted) ? rollback.reverted.length : 0,
          filesFailed: Array.isArray(rollback.failed) ? rollback.failed.length : 0,
        },
      });
    }
    return send(res, json(rollback));
  }
  // v0.8-S4b: conversation REWIND (mutating; header-token — see needsToken whitelist above). Truncates the
  // session to just before `targetTurnSeq`, clears providerHistory (lazy-reseed rebuilds it), optionally
  // rolls back the discarded turns' files. Returns {ok, removedTurns, lastUserText, filesReverted, filesFailed}.
  if (req.method === 'POST' && pathname === '/api/session/rewind') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId); // F4
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    if (body.targetTurnSeq === undefined || body.targetTurnSeq === null) return send(res, apiFailure('request.field_required', { field: 'targetTurnSeq' }, 'targetTurnSeq is required', 400));
    return send(res, json(await rewindSession(sessionId, body.targetTurnSeq, !!body.rollbackFiles)));
  }
  return false;
}

// ── 插话核心(116-2b 零行为抽出)────────────────────────────────────────────────────────────
// 原本整段内联在 POST /api/steer 的路由体里。116-2b 的 steward_thread_note 要走的是【同一条】
// 插话通道(而不是第二条注入路径),故把入参归一 → 引擎分流 → 注入/入队 → 持久呈现这一整段搬成
// 可调用函数,一个字未改:判定顺序、措辞、STEER_QUEUE_MAX 计数口径、[用户插话] 前缀中和、
// hasPendingQuestionForSession 拒绝、logEvent 的 kind/source、返回的 body 形状全部原样。
//
// 返回值是一个"怎么应答"的描述,而不是 HTTP 响应:
//   { kind: 'failure', code, detail, message, status }  → 路由 send(res, apiFailure(...))
//   { kind: 'json', body }                              → 路由 send(res, json(body))
// 这样路由的两种应答形态(apiFailure 与裸 json)都保住,调用方(13g)则只看 body.ok。
// 124 真机 bug（用户 2026-09-15）：插话的每一种拒绝理由都要有【稳定码】。
//
// 修前它们全是遗留字符串（{ok:false, error:'当前没有进行中的回合'}）。00-boot 的
// normalizeApiErrorPayload 对不在 LEGACY_API_ERROR_CODES 表里的字符串一律派兜底码
// api.request_failed，真话只剩在 message 里；而前端组合根的 apiErrText 是【码优先】的，
// 于是屏幕上只剩一句「请求失败。」—— 服务端明明说的是「当前 Kimi 回合正在收尾，请作为下一条
// 消息发送」，那句话把该怎么做都告诉用户了，却被抹掉。
//
// 有码之后两件事才立得住：① 前端能按码兜底（回合已经结束 → 当新回合发出去），而不是去匹配
// 中文句子（38 号文 §7 ④ 已经裁决过不许搞关键词表）；② 文案不再被归一吞掉。
// 形状用 {code, params, message}：与 apiFailure 的错误对象同形，且因为 error 不再是 string，
// normalizeApiErrorPayload 原样放行（既有消费者读 error.message，逐字不变）。
const STEER_REFUSAL = Object.freeze({
  noLiveTurn: { code: 'steer.no_live_turn', message: '当前没有进行中的回合' },
  kimiSettling: { code: 'steer.kimi_settling', message: '当前 Kimi 回合正在收尾，请作为下一条消息发送' },
  queueFull: { code: 'steer.queue_full', message: '插话队列已满' },
  turnLimit: { code: 'steer.queue_full', message: '本回合插话已达上限(3 条)' },
  answerPending: { code: 'steer.answer_pending', message: '请先回答当前提问,再插话(避免插话被误收为答案)' },
  engineUnsupported: { code: 'steer.engine_unsupported', message: '当前引擎不支持插话' },
  injectFailed: { code: 'steer.inject_failed', message: '注入失败:子进程输入通道已关闭' },
});
const steerRefusal = which => ({ kind: 'json', body: { ok: false, error: { ...STEER_REFUSAL[which], params: {} } } });
async function steerSessionCore(input) {
  const o = (input && typeof input === 'object') ? input : {};
  const sessionId = safeSessionId(o.sessionId); // F4
  const text = String(o.text || '').trim().slice(0, 2000).replace(/^(\s*\[用户插话\]\s*)+/, '').trim(); // 与 steer_node 上限对齐 + 前缀中和
  if (!sessionId) return { kind: 'failure', code: 'session.id_invalid', detail: {}, message: 'invalid sessionId', status: 400 };
  if (!text) return { kind: 'failure', code: 'request.field_required', detail: { field: 'text' }, message: 'text is required', status: 400 };
  const mode = o.mode == null ? 'queue' : o.mode;
  if (!['queue', 'interrupt'].includes(mode)) return { kind: 'failure', code: 'request.invalid', detail: {}, message: 'mode must be queue or interrupt', status: 400 };
  const reg = activeChildren.get(sessionId);
  if (!reg) return steerRefusal('noLiveTurn');
  if (reg.kind === 'kimi-acp') {
    // Kimi ACP 0.37.x has no native mid-prompt steering method. Keep the ACP process/session alive and
    // enqueue a follow-up session/prompt immediately after the active prompt settles. This preserves native
    // session continuity and is explicitly reported as queued (and therefore remains retractable).
    if (reg.acceptingSteer === false) return steerRefusal('kimiSettling');
    if (!Array.isArray(reg.steerQueue)) reg.steerQueue = [];
    if (reg.steerQueue.length >= STEER_QUEUE_MAX) return steerRefusal('queueFull');
    reg.steerQueue.push(text);
    logEvent({ kind: 'intervention', source: 'steer', protocol: 'kimi-acp-followup', sessionId });
    return { kind: 'json', body: { ok: true, queued: reg.steerQueue.length, immediate: false, protocol: 'kimi-acp-followup' } };
  }
  if (reg.kind === 'claude') {
    // 47a Phase A:Claude interactive 引擎 —— stdin 即时注入,无迭代边界队列。
    if (!reg.interactive) {
      return {
        kind: 'failure',
        code: 'steer.claude_requires_interactive',
        detail: {},
        message: '当前 Claude 回合使用 legacy/print 模式,无法插话;请在设置 → Claude CLI 中切换为 interactive,下一回合生效',
        status: 409,
      };
    }
    if (hasPendingQuestionForSession(sessionId)) return steerRefusal('answerPending');
    reg.claudeSteerCount = Number(reg.claudeSteerCount) || 0;
    if (reg.claudeSteerCount >= STEER_QUEUE_MAX) return steerRefusal('turnLimit');
    const injected = writeToChild(sessionId, buildUserEnvelope('[用户插话] ' + text));
    if (!injected) return steerRefusal('injectFailed');
    reg.claudeSteerCount += 1;
    // 持久呈现(与 provider drain 同形):插话入会话正文 + steered 事件,静态重渲染可见、刷新不丢。
    if (reg.session) {
      reg.session.messages.push({ role: 'user', content: text, turnSeq: reg.session.turnSeq, steered: true, createdAt: nowIso() });
      try { await saveSession(reg.session); } catch { /* best-effort(回合末还会保存) */ }
    }
    try { if (reg.onEvent) reg.onEvent({ type: 'steered', text }); } catch { /* stream gone */ }
    logEvent({ kind: 'intervention', source: 'steer', sessionId }); // 29c
    return { kind: 'json', body: { ok: true, injected: true } };
  }
  if (reg.kind !== 'openai') return steerRefusal('engineUnsupported');
  if (!Array.isArray(reg.steerQueue)) reg.steerQueue = [];
  if (reg.steerQueue.length >= STEER_QUEUE_MAX) return steerRefusal('queueFull');
  reg.steerQueue.push({ text, mode });
  // Ordinary additions preserve in-flight work. Only an explicit interrupt cancels a runner.
  try { if (mode === 'interrupt' && typeof reg.interruptToolWait === 'function') reg.interruptToolWait(); } catch { /* best-effort */ }
  logEvent({ kind: 'intervention', source: 'steer', sessionId }); // 29c
  return { kind: 'json', body: { ok: true, queued: reg.steerQueue.length, mode } };
}

// ── steer 域:/api/steer ────────────────────────────────────────────────────────────────────
async function handleSteerApiRoute(req, res, pathname) {
  // v0.8-S7: mid-turn STEERING (§4 A3). UI-only, header-token (needsToken whitelist above). 第47波47a 起双引擎:
  // provider 走既有 steerQueue(下一次迭代边界 drain 注入);Claude(interactive)经 stdin user envelope【即时注入】
  // —— 与 AskUser 应答同通道,故有两条分流纪律:①提问挂起(hasPendingQuestionForSession)时拒绝插话(防被误收为
  // 答案);②[用户插话] 前缀只能由服务端加,入参里的同名前缀先剥(伪造前缀中和,与 07 工具结果中和同精神)。
  // Rejects (never crashes) when: no live turn / Claude 为 print 模式(无 stdin 通道)/ 提问挂起 / 队列(计数)满 3。
  if (req.method === 'POST' && pathname === '/api/steer') {
    const body = await readJsonBody(req);
    // 116-2b:判定与副作用全在 steerSessionCore(见上);这里只剩 body 解析与两种应答形态的翻译。
    const outcome = await steerSessionCore({ sessionId: body.sessionId, text: body.text, mode: body.mode });
    if (outcome.kind === 'failure') return send(res, apiFailure(outcome.code, outcome.detail, outcome.message, outcome.status));
    return send(res, json(outcome.body));
  }
  // v1.9.0: DELETE /api/steer — 撤回(取消)一条已入队的插话。body: { sessionId, text }。
  // 找到 steerQueue 中第一个匹配 text 的条目并移除;返回剩余队列长度。
  if (req.method === 'DELETE' && pathname === '/api/steer') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId);
    // Mirror POST normalization: callers can cancel text that POST accepted after stripping a spoofed prefix.
    const text = String(body.text || '').trim().slice(0, 2000).replace(/^(\s*\[用户插话\]\s*)+/, '').trim();
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    if (!text) return send(res, apiFailure('request.field_required', { field: 'text' }, 'text is required', 400));
    const reg = activeChildren.get(sessionId);
    if (!reg) return send(res, json({ ok: false, error: '当前没有进行中的回合' }));
    // Claude 引擎走即时注入,不可撤回
    if (reg.kind === 'claude') return send(res, json({ ok: false, error: 'Claude 引擎的插话已即时注入,无法撤回' }));
    if (!Array.isArray(reg.steerQueue) || !reg.steerQueue.length) return send(res, json({ ok: false, error: '队列为空' }));
    const idx = reg.steerQueue.findIndex(item => (typeof item === 'string' ? item : item.text) === text);
    if (idx < 0) return send(res, json({ ok: false, error: '未找到该插话内容' }));
    reg.steerQueue.splice(idx, 1);
    return send(res, json({ ok: true, remaining: reg.steerQueue.length }));
  }
  return false;
}

// ── audio 域:/api/audio/transcribe(127-114b,26 号文 §3/§4 冻结边界,45 号文 §2 ②派单)──────────
// 全波【唯一出网面】:用户音频字节出网到所配 ASR 端点。ROUTE_AUTH token 级(不给 token-browser)。
// 判据(45 号文 §4 ②):未配置 409 / 非 audio/* 400 / 超 25 MB 413(早于 128 MB 总闸)/ 成功 200 /
// 上游 5xx 统一信封 502;记账 kind:'aux', note:'asr',上游无 usage 时 estimated:true。
// 威胁模型(26 号文 §4):目标 URL 只来自配置(providers[].audioBaseUrl || baseUrl),绝不接受请求体里的
// URL;filename/language/prompt 全部截断清洗;上游错误回显【先过 04 redact 再】裁到 1000 字符
// (107-S1 ⑦:会回显请求头的端点能把 Authorization 原样送回来 —— 脱敏落在生产者 05
// transcribeAudioViaProvider 那一处,本路由与 audio_transcribe 工具两个消费面一起生效)。
// apiKey 永不出本进程 —— Authorization 只往所配 provider 自己那里发。audioBaseUrl 与 baseUrl【同等对待】:45 号文 §1.6 实证
// baseUrl 今天没有任何 URL 准入校验,本刀不凭空发明一道(独立安全决定,两条出网面要收一起收,107 记档)。
// 25 MB 专用闸的读法:Content-Length 预检 + 流式累计双道,任一超 ASR_MAX_BODY_BYTES 即 413,
// 不经 readBody(那条是 128 MB 总闸)——「早于总闸」是可观测行为,不是注释(见 00-boot 该常量注释)。
async function readAudioBody(req, limit = ASR_MAX_BODY_BYTES) {
  // 吞掉「提前结束响应」之后 req 上可能再发的 error/aborted(25MB 处判 413 时客户端往往还在续传,
  // 服务端随即拆除这条连接)。挂上空接即可,读取语义不变。
  // 实测备注(127-114b e2e):413 之后新连接会有【瞬态】接受停顿(几百毫秒级,内核清理在途字节),
  // 服务本身不死 —— 客户端侧的正确姿势是等它回来(e2e 里有专门一条断言钉住「服务撑得住」)。
  // 130:limit 可传(流式音频块的闸是 1 MB,不是整段的 25 MB);缺省值与从前逐字节相同。
  req.on('error', () => {});
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) {
    const err = new Error('audio body too large'); err.statusCode = 413; err.code = 'asr.too_large';
    throw err;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error('audio body too large'); err.statusCode = 413; err.code = 'asr.too_large';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function handleAudioApiRoutes(req, res, pathname) {
  // 判定点必须是「方法 + pathname === '...'」肯定形 —— 路由清册扫描器只认这个形状(route-inventory.js
  // 扫 pathname ===),反向 guard(!== 提前 return)会被判成「ROUTE_AUTH 死行」;已实现路由分裂踩过一次。
  if (req.method === 'POST' && pathname === '/api/audio/transcribe') {
    return await handleAudioTranscribe(req, res);
  }
  // 130(51 号文 §2.3):实时识别的代理路由。开会话是裸路径;喂音频／收尾／关会话带会话 id,走前缀判定点。
  if (req.method === 'POST' && pathname === '/api/audio/stream/sessions') {
    return await handleAudioStreamOpen(req, res);
  }
  if (req.method === 'POST' && pathname.startsWith('/api/audio/stream/sessions/')) {
    return await handleAudioStreamSession(req, res, pathname);
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/audio/stream/sessions/')) {
    return await handleAudioStreamSession(req, res, pathname);
  }
  // 131b(52 号文 §5):句尾改错 —— 一句的第一遍文字(＋音频)→ 重听／大模型改字／两者合成。
  if (req.method === 'POST' && pathname === '/api/audio/correct') {
    return await handleAudioCorrect(req, res);
  }
  // 133f:开录之前的预热闸 —— 本地识别模型装着没有;没装就现在装,装好才回。
  if (req.method === 'POST' && pathname === '/api/audio/warmup') {
    return await handleAudioWarmup(req, res);
  }
  return false;
}
// ── 133f(用户 2026-09-21「标准/重度第一次又卡又不准」):预热 —— 语音识别的本地模型装好了没,没好就现在装 ─────────────
// 成因(日志实证,2026-09-21 asr_transcribe_ok):toolbox 的 asr-shim 空转时不 import torch(约定 §2.2「空转要轻」),第一发转写才加载 ——
// 新进程上首句 12–33 s(隔离实验:import+探设备 7–8 s、载权重 3–4 s、首次推理 2–2.5 s),同一时刻排队的几句全等它,期间屏上只有
// 第一遍小模型的字;轻度档(asr-stream 里常驻的 SenseVoice)没有这一段。前端在开录之前先 POST 这里:
//   · 组件的 /health 说这份模型已装着 → 秒回 {warm:true};
//   · 否则用 1 秒静音走【和真请求同一条】出站路径把它装好、内核热一遍(实验:预热后第一句真话就是稳态 ≈ 0.7 s,静音足够),等它返回才说好了。
// 只对 toolbox- 服务商有意义(云端没有「装」这回事 → skipped:'remote' 秒回)。同一份模型的并发预热合并成一发(用户取消再点、两个输入框
// 同时点都不会装两遍)。预热不是用户的一次转写:不记账(transcribeAudioViaProvider 的 warmup 开关),记 asr_warmup 审计(只有元数据)。
const AUDIO_WARMUP_SILENCE_MS = 1000;
const audioWarmups = new Map();   // 'providerId|model' → Promise<{ok,warm}|{failure}>:同一份模型同一时刻只装一次
function silentWav16k(ms) {
  const samples = Math.round(16000 * ms / 1000);
  const wav = Buffer.alloc(44 + samples * 2);   // 全零 = 静音
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}
// 组件报「已装着」且装的正是要用的这份:loaded 为真,并且 要的模型名 = 已装那份的真名(auto 挑中的)／组件缺省名／它内置的离线识别模型名。
// 拿不准(没有 loaded 字段、名字对不上)一律当没装 —— 多打一发静音的代价是几百毫秒,判错成「已装」的代价是用户又等半分钟。
function audioWarmupLoaded(body, model) {
  if (!body || body.loaded !== true) return false;
  const want = String(model || '').trim().toLowerCase();
  if (!want) return false;
  const names = [body.resolvedModel, body.model, body.offline && body.offline.model].map(x => String(x || '').trim().toLowerCase()).filter(Boolean);
  return names.includes(want);
}
async function runAudioWarmup(provider, asrModel) {
  const t0 = Date.now();
  await ToolboxHooks.ensureForProvider(provider.id);   // 组件这会儿没在跑(崩了／上次没起来)→ 就地再起,与转写同一条路
  const health = typeof ToolboxHooks.healthForProvider === 'function' ? await ToolboxHooks.healthForProvider(provider.id) : { running: false, body: null };
  if (audioWarmupLoaded(health.body, asrModel)) {
    logEvent({ kind: 'asr_warmup', provider: provider.id, model: asrModel, warm: true, durationMs: Date.now() - t0 });
    return { ok: true, warm: true };
  }
  const r = await transcribeAudioViaProvider(provider, asrModel, { audio: silentWav16k(AUDIO_WARMUP_SILENCE_MS), contentType: 'audio/wav', filename: 'warmup.wav', language: '', prompt: '', warmup: true });
  logEvent({ kind: 'asr_warmup', provider: provider.id, model: asrModel, warm: false, ok: !r.failure, ...(r.failure ? { code: r.failure.code } : {}), durationMs: Date.now() - t0 });
  return r.failure ? { failure: r.failure } : { ok: true, warm: false };
}
async function handleAudioWarmup(req, res) {
  try { await readAudioBody(req, 4096); } catch { /* 请求体没用(前端发 {}),读不读得完都不影响 */ }
  const t0 = Date.now();
  const resolved = resolveAsrProvider(await readConfig());
  if (resolved.failure) { const f = resolved.failure; return send(res, apiFailure(f.code, f.params, f.message, f.status)); }
  const { provider, asrModel } = resolved;
  if (!String(provider.id || '').startsWith('toolbox-')) return send(res, json({ ok: true, ready: true, skipped: 'remote', durationMs: 0 }));
  const key = provider.id + '|' + asrModel;
  let job = audioWarmups.get(key);
  if (!job) { job = runAudioWarmup(provider, asrModel).finally(() => { audioWarmups.delete(key); }); audioWarmups.set(key, job); }
  let r;
  try { r = await job; }
  catch (err) { return send(res, apiFailure('asr.warmup_failed', {}, '预热失败: ' + String(err && err.message || err).slice(0, 200), 502)); }
  if (r.failure) { const f = r.failure; return send(res, apiFailure(f.code, f.params, f.message, f.status)); }
  return send(res, json({ ok: true, ready: true, warm: r.warm, durationMs: Date.now() - t0 }));
}
// ── 131b(52 号文 §3/§5;用户 2026-09-21 拍板 2):句尾改错的编排 ────────────────────────────────────────────
// 输入 JSON {text: 第一遍文字, audio?: base64 WAV(这一句), contentType?};按 asrFixMode 决定走哪几条路:
//   auto  = 配了整段识别且带音频 → 重听;配了大模型 → 改字(有重听结果就给它两版合成);
//   audio = 只重听;llm = 只改字;off = 409。
// 结果优先级:大模型改出来的(过了合理性)> 重听的 > 空(两条路都没成 → 502,前端保留第一遍)。
// 上游地址只来自配置;音频只在内存;日志只记元数据(模式、两条路各自成没成、字数、耗时),不记文本。记账:大模型一发 aux/asr-fix。
const AUDIO_FIX_MAX_TEXT = 4000;
const AUDIO_FIX_MAX_AUDIO_B64 = 2 * 1024 * 1024;   // 一句 ≤ 20 s 的 16 kHz WAV 约 640 KB,base64 后约 860 KB
async function handleAudioCorrect(req, res) {
  const t0 = Date.now();
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, apiFailure('asr.fix_bad_request', {}, '请求体不是合法 JSON', 400)); }
  const text = String((body && body.text) || '').trim().slice(0, AUDIO_FIX_MAX_TEXT);
  // 133a:这句前面已经落到输入框里的字(只给大模型当参考,重听那一路用不上);服务端只取尾巴,前端多给也不多花
  const context = String((body && body.context) || '').slice(-AUDIO_FIX_MAX_TEXT);
  const audioB64 = body && typeof body.audio === 'string' ? body.audio : '';
  if (!text && !audioB64) return send(res, apiFailure('asr.fix_bad_request', {}, 'text 与 audio 至少给一个', 400));
  if (audioB64.length > AUDIO_FIX_MAX_AUDIO_B64) {
    return send(res, apiFailure('asr.fix_audio_too_large', { maxBytes: AUDIO_FIX_MAX_AUDIO_B64 }, '一句的音频超过上限', 413));
  }
  const config = await readConfig();
  const mode = asrFixModeOf(config);
  if (mode === 'off') return send(res, apiFailure('asr.fix_disabled', { mode }, '句尾改错已关闭', 409));
  const audioRes = (mode !== 'llm' && audioB64) ? resolveAsrProvider(config) : null;
  const llmRes = mode !== 'audio' ? resolveAsrFixProvider(config) : null;
  const canAudio = Boolean(audioRes && !audioRes.failure);
  const canLlm = Boolean(llmRes && !llmRes.failure);
  if (!canAudio && !canLlm) {
    return send(res, apiFailure('asr.fix_not_configured', { mode }, '句尾改错没有可用的端点(整段识别与大模型都没配)', 409));
  }
  let audioText = null, audioErr = '';
  if (canAudio) {
    let audio = null;
    try { audio = Buffer.from(audioB64, 'base64'); } catch { audio = null; }
    if (audio && audio.length) {
      const ct = String((body && body.contentType) || 'audio/wav').split(';')[0].trim().toLowerCase();
      const r = await transcribeAudioViaProvider(audioRes.provider, audioRes.asrModel, {
        audio, contentType: ct.startsWith('audio/') ? ct : 'audio/wav', filename: 'voice.wav', language: '', prompt: '',
      });
      if (r.failure) audioErr = String(r.failure.code || 'failed'); else audioText = String(r.text || '').trim();
    } else audioErr = 'asr.fix_bad_audio';
  }
  let llmText = null, llmErr = '';
  if (canLlm && (text || audioText)) {
    const r = await providerFixCompletion(llmRes.provider, llmRes.model, asrFixMessages(text, audioText, context));
    if (!r.ok) llmErr = String(r.error || 'failed').slice(0, 200);
    else {
      llmText = asrFixSanity((audioText && audioText.length > text.length) ? audioText : text, r.content) || null;
      if (!llmText) llmErr = 'sanity';
    }
    // 记账(aux/asr-fix):与 /api/audio/transcribe 同口径 —— 有 usage 记真数,没有就估算并标 estimated。正文为空那一发也花了钱,照记。
    if (r.usage || r.ok) {
      const u = r.usage && typeof r.usage === 'object' ? r.usage : null;
      const num = n => { const v = Number(u && u[n]); return Number.isFinite(v) && v > 0 ? Math.round(v) : 0; };
      const realIn = num('prompt_tokens') || num('input_tokens'), realOut = num('completion_tokens') || num('output_tokens');
      const hasUsage = (realIn + realOut) > 0;
      const inTok = hasUsage ? realIn : Math.max(1, Math.ceil((text.length + (audioText || '').length + 320) / 2));
      const outTok = hasUsage ? realOut : Math.max(1, Math.ceil(String((r.ok && r.content) || '').length / 2));
      const { cost, currency } = computeProviderCost(llmRes.provider, inTok, outTok, 0, llmRes.model);
      appendUsageLedger({
        sessionId: '', engine: 'openai', provider: llmRes.provider.id, model: llmRes.model,
        inTok, outTok, cachedInTok: 0, cost, currency, costTrusted: cost != null, estimated: !hasUsage, kind: 'aux', note: 'asr-fix',
      });
    }
  }
  const final = llmText || audioText || '';
  logEvent({
    kind: 'asr_fix', mode, audio: canAudio ? (audioText != null ? 'ok' : (audioErr || 'skip')) : 'off',
    llm: canLlm ? (llmText ? 'ok' : (llmErr || 'skip')) : 'off', inLen: text.length, ctxLen: context.length, outLen: final.length, durationMs: Date.now() - t0,
  });
  if (!final) return send(res, apiFailure('asr.fix_failed', { audio: audioErr, llm: llmErr }, '两条路都没改出结果', 502));
  return send(res, json({ ok: true, text: final, used: { audio: audioText != null, llm: Boolean(llmText) }, durationMs: Date.now() - t0 }));
}
// ── 130(51 号文 §2):实时识别代理 —— 浏览器每 250 ms 一块 PCM 打到这里,这里转给配置里那条 asr-stream 服务商 ─────
// 威胁模型与 /api/audio/transcribe 同:上游地址【只来自配置】(providers[].baseUrl),绝不收请求体里的 URL;
// 浏览器只拿到一个本进程发的会话 id,上游会话 id 不出本进程;单块 ≤ 1 MB;每进程 ≤ 4 个活会话;60 s 没音频服务端回收
// (浏览器页被关掉不会来 finish)。上游错误体先过 04 redact 再裁 500 字。不记账:本地组件不花钱(云端流式暂不支持)。
const AUDIO_STREAM_MAX_SESSIONS = 4;
const AUDIO_STREAM_IDLE_MS = 60000;
const AUDIO_STREAM_CHUNK_MAX_BYTES = 1024 * 1024;
const AUDIO_STREAM_UPSTREAM_TIMEOUT_MS = 15000;
const audioStreamSessions = new Map();   // 本进程会话 id → { upstream, upstreamId, providerId, at }
function audioStreamReap() {
  const now = Date.now();
  for (const [id, s] of audioStreamSessions) {
    if (now - s.at > AUDIO_STREAM_IDLE_MS) {
      audioStreamSessions.delete(id);
      logEvent({ kind: 'asr_stream', action: 'reap', provider: s.providerId });
      void audioStreamUpstream(s, 'DELETE', '/' + s.upstreamId).catch(() => {});
    }
  }
}
async function audioStreamUpstream(s, method, suffix, body, contentType) {
  const headers = body ? { 'content-type': contentType || 'application/json' } : {};
  const res = await fetch(s.upstream + '/stream/sessions' + suffix, { method, headers, body, signal: AbortSignal.timeout(AUDIO_STREAM_UPSTREAM_TIMEOUT_MS) });
  const text = await res.text();
  return { status: res.status, body: safeJsonParse(text, null), text };
}
function audioStreamFailure(up) {
  const message = redact(String((up && up.body && up.body.error && up.body.error.message) || (up && up.text) || '')).slice(0, 500);
  return apiFailure('asr.stream_upstream', { status: up ? up.status : 0 }, message || '实时识别服务报错', 502);
}
async function handleAudioStreamOpen(req, res) {
  const config = await readConfig();
  let resolved = resolveAsrStreamProvider(config);
  if (resolved.failure) { const f = resolved.failure; return send(res, apiFailure(f.code, f.params, f.message, f.status)); }
  // 指着 toolbox 组件而它这会儿没在跑 → 就地再起(与 transcribeAudioViaProvider 同一条路);端口若变了配置已改写,重取一次。
  if (String(resolved.provider.id || '').startsWith('toolbox-') && typeof ToolboxHooks.ensureForProvider === 'function') {
    await ToolboxHooks.ensureForProvider(resolved.provider.id);
    resolved = resolveAsrStreamProvider(await readConfig());
    if (resolved.failure) { const f = resolved.failure; return send(res, apiFailure(f.code, f.params, f.message, f.status)); }
  }
  let raw;
  try { raw = await readAudioBody(req, 64 * 1024); }
  catch (err) { if (err && err.statusCode === 413) return send(res, apiFailure('asr.stream_bad_request', {}, '请求体过大', 413)); throw err; }
  const parsed = raw.length ? safeJsonParse(raw.toString('utf8'), null) : {};
  if (raw.length && (!parsed || typeof parsed !== 'object')) return send(res, apiFailure('asr.stream_bad_request', {}, '请求体不是合法 JSON', 400));
  const hotwords = Array.isArray(parsed.hotwords) ? parsed.hotwords.filter(w => typeof w === 'string').map(w => w.trim().slice(0, 40)).filter(Boolean).slice(0, 200) : [];
  audioStreamReap();
  if (audioStreamSessions.size >= AUDIO_STREAM_MAX_SESSIONS) return send(res, apiFailure('asr.stream_busy', { max: AUDIO_STREAM_MAX_SESSIONS }, '实时识别会话太多,稍后再试', 429));
  const upstream = String(resolved.provider.baseUrl || '').replace(/\/+$/, '');
  const s = { upstream, upstreamId: '', providerId: resolved.provider.id, at: Date.now() };
  let up;
  try { up = await audioStreamUpstream(s, 'POST', '', JSON.stringify({ hotwords }), 'application/json'); }
  catch (err) {
    logEvent({ kind: 'asr_stream', action: 'open-failed', provider: s.providerId, error: String(err && err.message || err).slice(0, 200) });
    return send(res, apiFailure('asr.stream_unreachable', { providerId: s.providerId }, '连不上实时识别服务', 502));
  }
  if (up.status !== 200 || !up.body || !/^[0-9a-f]{32}$/.test(String(up.body.id || ''))) return send(res, audioStreamFailure(up));
  s.upstreamId = String(up.body.id);
  const id = crypto.randomBytes(16).toString('hex');
  audioStreamSessions.set(id, s);
  logEvent({ kind: 'asr_stream', action: 'open', provider: s.providerId, hotwords: hotwords.length, active: audioStreamSessions.size });
  return send(res, json({ ok: true, id, sampleRate: Number(up.body.sampleRate) || 16000 }));
}
async function handleAudioStreamSession(req, res, pathname) {
  // 只从上面的 POST／DELETE 前缀判定点进来;这里手工拆段(不用 pathname.match —— 路由清册扫描器会把它当成一条独立的正则路由)。
  const parts = pathname.slice('/api/audio/stream/sessions/'.length).split('/');
  const id = parts[0] || '';
  const action = parts.length === 2 ? parts[1] : '';
  if (!/^[0-9a-f]{32}$/.test(id) || parts.length > 2 || (action && action !== 'audio' && action !== 'finish')) return send(res, apiFailure('asr.stream_bad_request', {}, '没有这条路径', 404));
  const s = audioStreamSessions.get(id);
  if (!s) return send(res, apiFailure('asr.stream_session_missing', { id }, '没有这个实时识别会话(可能已超时)', 404));
  if (req.method === 'DELETE') {
    if (action) return send(res, apiFailure('asr.stream_bad_request', {}, '没有这条路径', 404));
    audioStreamSessions.delete(id);
    try { await audioStreamUpstream(s, 'DELETE', '/' + s.upstreamId); } catch { /* 上游没了也算关了 */ }
    logEvent({ kind: 'asr_stream', action: 'delete', provider: s.providerId });
    return send(res, json({ ok: true }));
  }
  if (action === 'audio') {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'audio/l16' && contentType !== 'application/octet-stream') {
      return send(res, apiFailure('asr.stream_bad_request', { contentType }, 'Content-Type 须是 audio/L16; rate=16000', 400));
    }
    let pcm;
    try { pcm = await readAudioBody(req, AUDIO_STREAM_CHUNK_MAX_BYTES); }
    catch (err) { if (err && err.statusCode === 413) return send(res, apiFailure('asr.stream_chunk_too_large', { maxBytes: AUDIO_STREAM_CHUNK_MAX_BYTES }, '音频块超过 1 MB', 413)); throw err; }
    if (pcm.length % 2) return send(res, apiFailure('asr.stream_bad_request', {}, 'PCM16 字节数必须是偶数', 400));
    s.at = Date.now();
    let up;
    try { up = await audioStreamUpstream(s, 'POST', '/' + s.upstreamId + '/audio', pcm, 'audio/L16; rate=16000'); }
    catch (err) {
      audioStreamSessions.delete(id);
      logEvent({ kind: 'asr_stream', action: 'audio-failed', provider: s.providerId, error: String(err && err.message || err).slice(0, 200) });
      return send(res, apiFailure('asr.stream_unreachable', { providerId: s.providerId }, '连不上实时识别服务', 502));
    }
    if (up.status === 404) { audioStreamSessions.delete(id); return send(res, apiFailure('asr.stream_session_missing', { id }, '实时识别会话已失效', 404)); }
    if (up.status !== 200 || !up.body || typeof up.body !== 'object') return send(res, audioStreamFailure(up));
    const finals = Array.isArray(up.body.finals) ? up.body.finals.filter(f => f && typeof f === 'object').map(f => ({ text: String(f.text || '').slice(0, 4000), startMs: Number(f.startMs) || 0, endMs: Number(f.endMs) || 0 })) : [];
    return send(res, json({ ok: true, partial: String(up.body.partial || '').slice(0, 4000), finals }));
  }
  if (action === 'finish') {
    audioStreamSessions.delete(id);
    let up;
    try { up = await audioStreamUpstream(s, 'POST', '/' + s.upstreamId + '/finish', '', 'application/octet-stream'); }
    catch (err) {
      logEvent({ kind: 'asr_stream', action: 'finish-failed', provider: s.providerId, error: String(err && err.message || err).slice(0, 200) });
      return send(res, apiFailure('asr.stream_unreachable', { providerId: s.providerId }, '连不上实时识别服务', 502));
    }
    if (up.status === 404) return send(res, apiFailure('asr.stream_session_missing', { id }, '实时识别会话已失效', 404));
    if (up.status !== 200 || !up.body || typeof up.body !== 'object') return send(res, audioStreamFailure(up));
    const finals = Array.isArray(up.body.finals) ? up.body.finals.filter(f => f && typeof f === 'object').map(f => ({ text: String(f.text || '').slice(0, 4000), startMs: Number(f.startMs) || 0, endMs: Number(f.endMs) || 0 })) : [];
    logEvent({ kind: 'asr_stream', action: 'finish', provider: s.providerId, finals: finals.length });
    return send(res, json({ ok: true, finals }));
  }
  return send(res, apiFailure('asr.stream_bad_request', {}, '没有这条路径', 404));
}
// 127-114c⑤:resolveAsrProvider 与 transcribeAudioViaProvider 已迁往 05-claude-engine.js ——
// ⑤ 的 audio_transcribe 原生工具派发在 12,12→13b 会是一条新增前向边;12/13b 到 05 都有既有边,
// 迁过去零新增模块边。本文件的 handleAudioTranscribe 与 maybeTranscribeAudioAttachment 经拼接共享
// 作用域照旧直调,调用行零变化。
// ④ 音频附件尽力转写:kind:'audio' 的上传件,ASR 已配置就出站转写并把文本挂上 record.transcript
// (裁 12000,同 textPreview 上限);未配置 = 零行为(连 transcribeError 都不落,与 ① 同口径);
// 超 25 MB / 配置缺腿 / 上游失败 → 只落 transcribeError 代码,绝不挡上传 —— 文件已落盘可下载,
// 转写是增量(26 号文 §3「原文件保留可下载」)。本函数绝不 throw:上传主路径不能被转写故障打翻。
async function maybeTranscribeAudioAttachment(file) {
  try {
    if (!file || file.kind !== 'audio' || !file.path) return;
    const config = await readConfig();
    const resolved = resolveAsrProvider(config);
    if (resolved.failure) {
      if (resolved.failure.code !== 'asr.not_configured') file.transcribeError = resolved.failure.code;
      return;
    }
    if (!(file.size > 0) || file.size > ASR_MAX_BODY_BYTES) { file.transcribeError = 'asr.too_large'; return; }
    const audio = await fsp.readFile(file.path);
    if (!audio.length) return;
    const ext = String(file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' }[(ext && ext[1]) || ''] || 'application/octet-stream';
    const result = await transcribeAudioViaProvider(resolved.provider, resolved.asrModel, { audio, contentType: mime, filename: file.name, language: '', prompt: '' });
    if (result.failure) { file.transcribeError = result.failure.code; return; }
    file.transcript = String(result.text || '').slice(0, 12000);
  } catch { file.transcribeError = 'asr.internal'; }
}
// v1.9 图片输入增强(与上面音频转写同模具:尽力而为、绝不 throw、未配置/缺席零行为):
//   ① maybeOcrImageAttachment —— OCR 文本兜底。当前主端点【不收图】(provider.vision !== true)时,上传即经
//      桥接的 ai_computer_control__ocr_image 把图里的文字落 record.ocrText;进提示词由 03 buildAttachmentPrompt
//      打 <attachment kind="image-ocr" untrusted> 围栏,纯文本模型也能拿到图内文字。端点收图(vision=true)时
//      不 OCR —— 像素随消息直达模型,OCR 是纯开销。
//   ② maybeCompressImageAttachment —— 超限压缩。图片 >5MB 且端点收图时,用桥接的 ai_computer_control__image_resize
//      重采样出 ≤5MB 的派生件 record.sendPath(uploads/<id>/send.jpg);04-visual-pipeline 发送时优先读它,
//      超限大图不再直接降级占位。两条都要求桥接 MCP 在场;缺席/失败 = 零行为(存量 record 形状零漂移)。
const IMAGE_OCR_MAX_CHARS = 12000;           // 与 textPreview 上限同值
const IMAGE_SEND_MAX_BYTES = 5 * 1024 * 1024; // 与 04-visual-pipeline 的 IMAGE_ATTACH_MAX 同值(那边是发送闸,这边是压缩目标)

async function bridgedToolClient(config, toolName) {
  const { route } = await collectBridgedTools(config);
  const bridge = resolveBridge(route, toolName);
  if (!bridge) return null;
  const client = await getBridgedClient(bridge.serverId, config);
  return client ? { client, toolName: bridge.toolName } : null;
}

async function maybeOcrImageAttachment(file) {
  try {
    if (!file || file.kind !== 'image' || !file.path) return;
    const config = await readConfig();
    const provider = activeOpenAiProvider(config);
    if (provider && provider.vision === true) return; // 收图端点:像素直达,不需要 OCR 文本
    const target = await bridgedToolClient(config, 'ai_computer_control__ocr_image');
    if (!target) return;
    const result = await target.client.callTool(target.toolName, { path: file.path, lang: 'zh' });
    if (!result || result.ok === false) return;
    const text = typeof result.text === 'string' ? result.text
      : (typeof result.content === 'string' ? result.content : '');
    if (text.trim()) file.ocrText = text.slice(0, IMAGE_OCR_MAX_CHARS);
  } catch { file.ocrError = 'ocr.internal'; }
}

async function maybeCompressImageAttachment(file) {
  try {
    if (!file || file.kind !== 'image' || !file.path) return;
    if (!(file.size > IMAGE_SEND_MAX_BYTES)) return;
    const config = await readConfig();
    const provider = activeOpenAiProvider(config);
    if (!provider || provider.vision !== true) return; // 不发像素的路径压缩了也没人看
    const target = await bridgedToolClient(config, 'ai_computer_control__image_resize');
    if (!target) return;
    const outPath = path.join(path.dirname(file.path), 'send.jpg');
    // 文件大小≈像素数:按面积开方缩一档再留 15% 余量给 JPEG 编码差;一轮不行再缩一次(共≤2 趴,
    // 仍超限就零行为 —— 发送侧的 5MB 闸会走原有占位降级,绝不发超限大包)。
    let scale = Math.min(1, Math.sqrt((IMAGE_SEND_MAX_BYTES * 0.85) / file.size));
    for (let i = 0; i < 2; i++) {
      const result = await target.client.callTool(target.toolName, { path: file.path, output_path: outPath, scale: Number(scale.toFixed(4)) });
      if (!result || result.ok === false || result.success === false) return;
      const st = await fsp.stat(outPath).catch(() => null);
      if (!st) return;
      if (st.size <= IMAGE_SEND_MAX_BYTES) { file.sendPath = outPath; file.sendSize = st.size; return; }
      scale *= 0.7;
    }
  } catch { file.compressError = 'image.compress_failed'; }
}
async function handleAudioTranscribe(req, res) {
  const config = await readConfig();
  const resolved = resolveAsrProvider(config);
  if (resolved.failure) {
    const f = resolved.failure;
    return send(res, apiFailure(f.code, f.params, f.message, f.status));
  }
  const { provider, asrModel } = resolved;
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('audio/')) {
    return send(res, apiFailure('asr.content_type', { contentType }, 'Content-Type 必须是 audio/*', 400));
  }
  const q = new URL(req.url, 'http://x').searchParams;
  // filename 只许纯 basename(与 /api/upload/content 同域),缺省按 content-type 给个正经扩展名。
  const rawName = String(q.get('filename') || '').trim();
  const filename = (rawName && rawName.length <= 255 && rawName === path.basename(rawName) && rawName !== '.' && rawName !== '..')
    ? rawName : ('audio' + ({ 'audio/webm': '.webm', 'audio/wav': '.wav', 'audio/wave': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/flac': '.flac' }[contentType] || '.bin'));
  const language = String(q.get('language') || '').trim().slice(0, 40);
  const hint = String(q.get('prompt') || '').slice(0, 4000);
  let audio;
  try {
    audio = await readAudioBody(req);
  } catch (err) {
    if (err && err.statusCode === 413) {
      return send(res, apiFailure('asr.too_large', { maxBytes: ASR_MAX_BODY_BYTES }, '音频超过 25 MB 上限', 413));
    }
    throw err;
  }
  if (!audio.length) return send(res, apiFailure('asr.empty', {}, '空音频体', 400));
  const result = await transcribeAudioViaProvider(provider, asrModel, { audio, contentType, filename, language, prompt: hint });
  if (result.failure) {
    const f = result.failure;
    return send(res, apiFailure(f.code, f.params, f.message, f.status));
  }
  return send(res, json({
    ok: true, text: result.text,
    ...(result.outLanguage ? { language: result.outLanguage } : {}),
    durationMs: result.durationMs, providerId: result.providerId, model: result.model, estimated: result.estimated,
  }));
}
