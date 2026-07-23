// 第49波49f (A1): handleApi 域分组拆分第一批 —— MCP / checkpoint·storage / steer 三组域路由
// 从 13-http-router.js 的 handleApi 原样抽出(共享作用域拼接,零 import 接线,行为不变)。
// 每个函数:命中自己域的路由则处理并 return true,否则 return false(调用处 fallthrough)。
// 顺序与语义与原 handleApi 内联块完全一致;e2e 全量即回归网。

// ── MCP 域:/api/mcp/import-folder、/api/mcp/import-config/scan|apply ─────────────────────────
async function handleMcpApiRoutes(req, res, pathname) {
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
    const config = await readConfig();
    const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
    const existingIdx = list.findIndex(s => s && s.id === cleaned.id);
    let updated = false;
    if (existingIdx >= 0) { list[existingIdx] = cleaned; updated = true; }
    else {
      if (list.length >= 10) return send(res, json({ ok: false, error: '外部 MCP 数量已达上限(最多 10 个),请先移除一个再导入' }));
      list.push(cleaned);
    }
    const next = await writeConfig({ ...config, externalMcpServers: list });
    await generateMcpConfig(next.mcpCommandMode).catch(() => {}); // 再生成 .mcp.json(缺失时不阻断导入)
    logEvent({ kind: 'mcp_import', id: cleaned.id, updated, source: folder });
    // 响应附清洗后的条目, env 值掩码(参考 apiKey 掩码模式, 防泄漏 token 类环境变量)。
    const maskedEnv = {};
    for (const [k, v] of Object.entries(cleaned.env || {})) maskedEnv[k] = maskKey(String(v));
    const serverEcho = { ...cleaned, env: maskedEnv };
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
    const config = await readConfig();
    const incoming = Array.isArray(body && body.servers) ? body.servers : [];
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
    if (!added.length && !updated.length) return send(res, json({ ok: false, error: '没有可导入的条目', skipped }));
    const next = await writeConfig({ ...config, externalMcpServers: list });
    await generateMcpConfig(next.mcpCommandMode).catch(() => {});
    logEvent({ kind: 'mcp_import', ids: [...added, ...updated], added: added.length, updated: updated.length, source: 'import-config' });
    return send(res, json({ ok: true, added, updated, skipped }));
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
    const config = await readConfig();
    config.storagePolicy = { ...(config.storagePolicy || {}), ...src };
    const saved = await writeConfig(config);
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
    return send(res, json(await journalRollback(sessionId, body.turnSeq, body.entrySeq)));
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

// ── steer 域:/api/steer ────────────────────────────────────────────────────────────────────
async function handleSteerApiRoute(req, res, pathname) {
  // v0.8-S7: mid-turn STEERING (§4 A3). UI-only, header-token (needsToken whitelist above). 第47波47a 起双引擎:
  // provider 走既有 steerQueue(下一次迭代边界 drain 注入);Claude(interactive)经 stdin user envelope【即时注入】
  // —— 与 AskUser 应答同通道,故有两条分流纪律:①提问挂起(hasPendingQuestionForSession)时拒绝插话(防被误收为
  // 答案);②[用户插话] 前缀只能由服务端加,入参里的同名前缀先剥(伪造前缀中和,与 07 工具结果中和同精神)。
  // Rejects (never crashes) when: no live turn / Claude 为 print 模式(无 stdin 通道)/ 提问挂起 / 队列(计数)满 3。
  if (req.method === 'POST' && pathname === '/api/steer') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId); // F4
    const text = String(body.text || '').trim().slice(0, 2000).replace(/^(\s*\[用户插话\]\s*)+/, '').trim(); // 与 steer_node 上限对齐 + 前缀中和
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    if (!text) return send(res, apiFailure('request.field_required', { field: 'text' }, 'text is required', 400));
    const reg = activeChildren.get(sessionId);
    if (!reg) return send(res, json({ ok: false, error: '当前没有进行中的回合' }));
    if (reg.kind === 'claude') {
      // 47a Phase A:Claude interactive 引擎 —— stdin 即时注入,无迭代边界队列。
      if (!reg.interactive) return send(res, json({ ok: false, error: 'Claude 引擎当前为 print 模式,不支持插话;设置 → Claude CLI → 引擎模式改为 interactive 后可用' }));
      if (hasPendingQuestionForSession(sessionId)) return send(res, json({ ok: false, error: '请先回答当前提问,再插话(避免插话被误收为答案)' }));
      reg.claudeSteerCount = Number(reg.claudeSteerCount) || 0;
      if (reg.claudeSteerCount >= STEER_QUEUE_MAX) return send(res, json({ ok: false, error: '本回合插话已达上限(3 条)' }));
      const injected = writeToChild(sessionId, buildUserEnvelope('[用户插话] ' + text));
      if (!injected) return send(res, json({ ok: false, error: '注入失败:子进程输入通道已关闭' }));
      reg.claudeSteerCount += 1;
      // 持久呈现(与 provider drain 同形):插话入会话正文 + steered 事件,静态重渲染可见、刷新不丢。
      if (reg.session) {
        reg.session.messages.push({ role: 'user', content: text, turnSeq: reg.session.turnSeq, steered: true, createdAt: nowIso() });
        try { await saveSession(reg.session); } catch { /* best-effort(回合末还会保存) */ }
      }
      try { if (reg.onEvent) reg.onEvent({ type: 'steered', text }); } catch { /* stream gone */ }
      logEvent({ kind: 'intervention', source: 'steer', sessionId }); // 29c
      return send(res, json({ ok: true, injected: true }));
    }
    if (reg.kind !== 'openai') return send(res, json({ ok: false, error: '仅 provider 引擎支持插话' }));
    if (!Array.isArray(reg.steerQueue)) reg.steerQueue = [];
    if (reg.steerQueue.length >= STEER_QUEUE_MAX) return send(res, json({ ok: false, error: '插话队列已满' }));
    reg.steerQueue.push(text);
    logEvent({ kind: 'intervention', source: 'steer', sessionId }); // 29c
    return send(res, json({ ok: true, queued: reg.steerQueue.length }));
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
    const idx = reg.steerQueue.indexOf(text);
    if (idx < 0) return send(res, json({ ok: false, error: '未找到该插话内容' }));
    reg.steerQueue.splice(idx, 1);
    return send(res, json({ ok: true, remaining: reg.steerQueue.length }));
  }
  return false;
}
