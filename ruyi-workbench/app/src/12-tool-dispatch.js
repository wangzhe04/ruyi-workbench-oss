async function invokeAdaptiveMcpTool(proxyTier, targetName, targetArgs) {
  const config = await readConfig();
  const { bridged, catalog } = await adaptiveCatalogForMcp(config);
  const item = catalog.find(x => x.name === targetName);
  if (!item) return { ok: false, error: `tool not found: ${targetName}. Call tool_search first.` };
  if (item.name === 'permission_prompt' || item.name === 'tool_search' || item.name.startsWith('tool_invoke_')) return { ok: false, error: 'control-plane tools cannot be invoked through a proxy' };
  if (item.tier !== proxyTier) return { ok: false, error: `risk tier mismatch: ${targetName} is '${item.tier}', not '${proxyTier}'` };
  const bridge = resolveBridge(bridged.route, targetName);
  if (!bridge) return toolCall(targetName, targetArgs || {});
  const client = await getBridgedClient(bridge.serverId, config); // 47b:死/缺自动重连(超时杀后自愈)
  if (!client) return { ok: false, error: `bridged MCP server '${bridge.serverId}' is not available` };
  const gateRefusal = bridgedOfficeScriptGate(targetName, targetArgs || {});
  if (gateRefusal) return gateRefusal;
  const relArg = bridgedWriteRelativePathArg(targetName, targetArgs || {});
  if (relArg) return { ok: false, error: `desktop/document writes require an absolute path; '${relArg}' is relative` };
  try {
    const sid = process.env.WCW_SESSION_ID || '';
    const session = sid ? await loadSession(sid).catch(() => null) : null;
    if (session) await journalBridgedWrite(targetName, targetArgs || {}, session, config, { sessionId: sid, turnSeq: session.turnSeq });
    return await client.callTool(bridge.toolName, targetArgs || {});
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// 第41波(V2.0「立柱」41a): toolCall() 50 分支 switch → 分组表驱动注册表。
// 每个工具声明 { paths, guardNote, handler }:
//   paths: 'read'|'write'|'both' → handler 内必须对模型给定路径过 guardFileToolPath(read=读闸/write=写闸/both=双闸);
//          'conditional' → 仅当模型给定路径参数时过闸(缺省落应用自选目录,录在案);
//          null → 不触文件路径,guardNote 必须录理由(exec 权限门/纯网络/loopback/设计豁免)。
// 41b 行为锁(dev-harness/tool-dispatch.e2e.js): edit/exec 级且 paths 非 null 的条目,handler 源必须含 guard
// 调用;paths:null 必须有非空 guardNote;注册表键集 === NATIVE_TOOL_PACKS 键集(目录漂移=锁红)。
// 新工具忘了声明 = 锁红 —— archive 漏 guard(第27波)、desktop_screenshot 越界写(第36波)这类漏审整类收口。
const CORE_TOOL_HANDLERS = {
  tool_search: { paths: null, guardNote: "目录检索控制面,不触文件路径", handler: async (args, ctx) => {
      const config = await readConfig();
      const { catalog } = await adaptiveCatalogForMcp(config);
      const words = String(args.query || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
      const matches = catalog.map(x => ({ x, score: words.reduce((n, w) => n + (`${x.name} ${x.pack} ${x.description}`.toLowerCase().includes(w) ? 1 : 0), 0) }))
        .filter(r => !words.length || r.score > 0).sort((a, b) => b.score - a.score || a.x.name.localeCompare(b.x.name)).slice(0, limit)
        .map(({ x }) => ({ name: x.name, pack: x.pack, tier: x.tier, description: x.description }));
      return { ok: true, query: String(args.query || ''), matches, packs: TOOL_PACK_DESCRIPTIONS, next: 'Call the concrete tool if visible; otherwise use tool_invoke_read/edit/exec with the matching tier.' };
  } },
  tool_load: { paths: null, guardNote: "元工具提示,不触文件路径", handler: async (args, ctx) => {
      return { ok: true, note: 'Claude CLI schemas are fixed for this process. Use tool_search then tool_invoke_read/edit/exec. OpenAI-compatible turns load concrete schemas on the next iteration.' };
  } },
  tool_invoke_read: { paths: null, guardNote: "代理分发:桥接工具经 bridgedWriteRelativePathArg/journalBridgedWrite;原生目标递归回本注册表走各自 guard", handler: async (args, ctx) => {
      return invokeAdaptiveMcpTool('read', String(args.name || ''), args.arguments || {});
  } },
  tool_invoke_edit: { paths: null, guardNote: "代理分发:同 tool_invoke_read", handler: async (args, ctx) => {
      return invokeAdaptiveMcpTool('edit', String(args.name || ''), args.arguments || {});
  } },
  tool_invoke_exec: { paths: null, guardNote: "代理分发:同 tool_invoke_read", handler: async (args, ctx) => {
      return invokeAdaptiveMcpTool('exec', String(args.name || ''), args.arguments || {});
  } },
  permission_prompt: { paths: null, guardNote: "CLI 权限桥 loopback,不触文件路径(fail-closed)", handler: async (args, ctx) => {
      // Bridge: the CLI (via --permission-prompt-tool) asks us to approve a tool call. We run inside
      // the MCP child, so we call back to the web server's loopback, which prompts the UI.
      const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
      const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
      // Fail CLOSED: without the per-session bridge env we cannot prompt the user, so deny.
      if (!port || !token) return { behavior: 'deny', message: 'permission bridge not configured' };
      // Arg names from the CLI are underdocumented — accept the common variants.
      const toolName = args.tool_name || args.toolName || args.name || 'unknown';
      const input = args.input || args.tool_input || args.arguments || {};
      const budget = Number(process.env.WCW_PERMISSION_TIMEOUT_MS || 120000) + 10000; // outlive the server auto-deny
      try {
        const resp = await httpRequest({
          url: `http://${host}:${port}/api/permission/request`, method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, sessionId, toolName, input }), timeoutMs: budget,
        });
        return safeJsonParse(resp.body, { behavior: 'deny', message: 'invalid bridge response' });
      } catch (e) {
        return { behavior: 'deny', message: `permission bridge error: ${e.message}` };
      }
  } },
  request_user_input: { paths: null, guardNote: "loopback 提问,不触文件路径", handler: async (args, ctx) => {
      // Provider turns intercept this in their live closure. Claude reaches it through the per-session MCP
      // child, which loops back to the serve process so the visible chat stream owns the modal and answer.
      if (RUNTIME.isMcpChild) {
        const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
        const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
        if (!port || !token || !sessionId) return { ok: false, error: 'request_user_input requires a live workbench session' };
        const timeoutMs = Math.max(5000, Number(process.env.WCW_PERMISSION_TIMEOUT_MS) || 120000);
        try {
          const resp = await httpRequest({
            url: `http://${host}:${port}/api/question/request`, method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, sessionId, questions: args.questions }), timeoutMs: timeoutMs + 10000,
          });
          return safeJsonParse(resp.body, { ok: false, error: 'invalid /api/question/request response' });
        } catch (e) { return { ok: false, error: `question loopback error: ${(e && e.message) || String(e)}` }; }
      }
      return { ok: false, error: 'request_user_input requires a live turn' };
  } },
  todo_write: { paths: null, guardNote: "任务清单经 loopback /api/todo 落会话,不触任意文件路径", handler: async (args, ctx) => {
      // v0.8-S3: FULL-REPLACE task list. Two execution contexts:
      //  - serve process (provider engine): the runOpenAiTurn tool loop special-cases todo_write BEFORE
      //    dispatching here (it holds the session + onEvent to persist session.todos and emit the `todo`
      //    event). This generic branch is the fallback used by /api/tools/todo_write and any caller that
      //    lacks that turn context — it only validates + returns {ok,count}, touching no session file.
      //  - MCP child (Claude engine): the child must NOT write session files (races the serve process's
      //    saveSession). Detect isMcpChild and loop back to POST /api/todo with the injected session env.
      const items = normalizeTodoItems(args.items);
      if (RUNTIME.isMcpChild) {
        const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
        const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
        if (!port || !token || !sessionId) {
          return { ok: false, error: 'todo 需要工作台会话上下文', hint: '独立 MCP 模式不支持' };
        }
        try {
          const resp = await httpRequest({
            url: `http://${host}:${port}/api/todo`, method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, sessionId, items }), timeoutMs: 5000,
          });
          return safeJsonParse(resp.body, { ok: false, error: 'invalid /api/todo response' });
        } catch (e) {
          return { ok: false, error: `todo loopback error: ${(e && e.message) || String(e)}` };
        }
      }
      return { ok: true, count: items.length };
  } },
  mission_update: { paths: null, guardNote: "任务账本经 loopback /api/mission 落会话,不触任意文件路径", handler: async (args, ctx) => {
      // 第26波b: 与 todo_write 同款双路径。serve 进程(provider)由 runOpenAiTurn 特例拦截(持 session);
      // 此处是 MCP 子进程(Claude)与无回合上下文的兜底:子进程 loopback POST /api/mission(不写会话文件)。
      if (RUNTIME.isMcpChild) {
        const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
        const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
        if (!port || !token || !sessionId) return { ok: false, error: 'mission 需要工作台会话上下文', hint: '独立 MCP 模式不支持' };
        try {
          const resp = await httpRequest({
            url: `http://${host}:${port}/api/mission`, method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, sessionId, action: 'update', milestones: args.milestones, goal: args.goal }), timeoutMs: 5000,
          });
          const r = safeJsonParse(resp.body, { ok: false, error: 'invalid /api/mission response' });
          return r && r.ok ? { ok: true, mission: r.mission } : r;
        } catch (e) { return { ok: false, error: `mission loopback error: ${(e && e.message) || String(e)}` }; }
      }
      return { ok: true, note: '账本更新需在工作台会话上下文中生效(独立调用仅校验)' };
  } },
};

const FILE_TOOL_HANDLERS = {
  file_read: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      const p = path.resolve(String(args.path || ''));
      { const g = await guardFileToolPath(p, ctx, { tool: 'file_read', write: false }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
      // v0.8-S1: image/binary suffixes are refused — the model should route these to the vision channel.
      if (isBinaryReadPath(p)) {
        return { ok: false, error: 'binary or image file', hint: '图片请作为附件走视觉通道(v0.9)或用 desktop_screenshot 相关工具' };
      }
      const encoding = args.encoding || 'utf8';
      // v0.8-S7 error guidance: a missing file is the most common failure — return a structured hint
      // instead of letting the raw ENOENT bubble up as a bare error string (the model can't self-correct
      // from "ENOENT" alone). Other read errors (EACCES etc.) still throw and surface verbatim.
      let raw;
      try { raw = String(await fsp.readFile(p, encoding)); }
      catch (e) {
        if (e && e.code === 'ENOENT') return { ok: false, error: '文件不存在', path: p, hint: '文件不存在;先用 glob 或 file_list 确认路径' };
        throw e;
      }
      const size = Buffer.byteLength(raw);
      // v0.8-S1: line mode — triggered by lineOffset (1-based) or lineLimit. Returns cat -n style content
      // (right-aligned line number + tab + text) plus totalLines and the effective lineOffset/lineLimit.
      // Out-of-range → empty content + totalLines (NOT an error). Takes priority over the char slice
      // when both parameter groups are given (mode:'lines' is then noted).
      const hasLineParams = args.lineOffset !== undefined || args.lineLimit !== undefined;
      if (hasLineParams) {
        const lines = raw.split(/\r?\n/);
        const totalLines = lines.length;
        const lineOffset = Math.max(1, Number(args.lineOffset || 1) || 1);
        const lineLimit = Math.max(0, Number(args.lineLimit != null ? args.lineLimit : totalLines) || 0);
        const startIdx = lineOffset - 1;
        const slice = startIdx >= totalLines ? [] : lines.slice(startIdx, startIdx + lineLimit);
        const width = String(startIdx + slice.length).length;
        const content = slice.map((t, k) => String(startIdx + k + 1).padStart(width, ' ') + '\t' + t).join('\n');
        return { ok: true, path: p, mode: 'lines', content, size, totalLines, lineOffset, lineLimit };
      }
      const start = Math.max(0, Number(args.offset || 0));
      const limit = Number(args.limit || 100000);
      return { ok: true, path: p, content: raw.slice(start, start + limit), size };
  } },
  file_write: { paths: "write", guardNote: '', handler: async (args, ctx) => {
      const p = path.resolve(String(args.path || ''));
      { const g = await guardFileToolPath(p, ctx, { tool: 'file_write', write: true }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
      // v0.8-S4a: checkpoint BEFORE writing. op = create when the file doesn't yet exist (no before to
      // store), else modify (snapshot the existing bytes). Reading the old content can't block the write.
      let before = null, exists = false;
      try { before = await fsp.readFile(p); exists = true; } catch { before = null; exists = false; }
      // 第25波 25.5(AUTONOMY-PLAN):幂等写 —— 目标已存在且落盘字节将完全相同 → 跳过(不记检查点、不重写)。
      // 断点续跑重放同内容写不再产生新检查点条目/mtime 扰动;「touch」语义不受支持是有意的。
      // 按 writeFile 将实际落盘的字节比较(尊重 encoding 参数),而非字符串比较,避免编码歧义。
      const _payload = (() => { try { return Buffer.from(String(args.content || ''), args.encoding || 'utf8'); } catch { return null; } })();
      if (exists && _payload && before.equals(_payload)) {
        return { ok: true, path: p, op: 'skip', unchanged: true, bytes: _payload.length, note: '目标内容已与要写入的内容一致,幂等跳过(未产生新检查点)' };
      }
      const jctx = await journalSessionCtx(ctx);
      await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_write', p, exists ? 'modify' : 'create', exists ? before : null);
      if (args.createDirs !== false) await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, String(args.content || ''), args.encoding || 'utf8');
      return { ok: true, path: p, op: exists ? 'modify' : 'create', bytes: Buffer.byteLength(String(args.content || '')) };
  } },
  file_edit: { paths: "write", guardNote: '', handler: async (args, ctx) => {
      const p = path.resolve(String(args.path || ''));
      { const g = await guardFileToolPath(p, ctx, { tool: 'file_edit', write: true }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
      // v0.8-S7 error guidance: distinguish "file doesn't exist" (structured hint) from other read errors.
      let raw;
      try { raw = await fsp.readFile(p, 'utf8'); }
      catch (e) {
        if (e && e.code === 'ENOENT') return { ok: false, error: '文件不存在', path: p, hint: '文件不存在;先用 glob 或 file_list 确认路径' };
        throw e;
      }
      const oldText = String(args.oldText || '');
      const newText = String(args.newText || '');
      if (!oldText) throw new Error('oldText is required');
      const count = raw.split(oldText).length - 1;
      if (count === 0) {
        // v0.8-S1: not found → offer the closest line as an editing aid (no automatic fuzzy replace).
        // Rank file lines against oldText's FIRST line by Levenshtein distance (lines truncated to
        // 500 chars); return the best line plus a ±3-line snippet window around it under `closest`.
        // Guardrails (this runs as a SYNCHRONOUS loop on the single-process server — an unbounded
        // Levenshtein sweep over a huge file would freeze every API for seconds):
        //  1. length-difference lower bound: |len(a)-len(b)| <= levenshtein(a,b), so any line whose
        //     (capped) length differs from the needle's by >= bestDist can be skipped safely;
        //  2. hard scan cap of 20000 lines; the remainder is not scanned and `scannedLines` reports
        //     how far we actually looked so the model knows the hint may be partial.
        const fileLines = raw.split(/\r?\n/);
        const needle = oldText.split(/\r?\n/)[0] || '';
        const MAX_CLOSEST_SCAN_LINES = 20000;
        const scanLimit = Math.min(fileLines.length, MAX_CLOSEST_SCAN_LINES);
        const lb = Math.min(needle.length, 500);
        let best = -1, bestDist = Infinity;
        for (let i = 0; i < scanLimit; i += 1) {
          const la = Math.min(fileLines[i].length, 500);
          if (Math.abs(la - lb) >= bestDist) continue; // length diff is a lower bound on edit distance
          const d = levenshtein(needle, fileLines[i]);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        const closest = best < 0 ? null : {
          line: best + 1,
          distance: bestDist,
          snippet: fileLines
            .slice(Math.max(0, best - 3), Math.min(fileLines.length, best + 4))
            .map((t, k) => `${Math.max(0, best - 3) + k + 1}\t${t.slice(0, 500)}`)
            .join('\n'),
          scannedLines: scanLimit,
        };
        return { ok: false, error: 'oldText was not found', closest };
      }
      if (count > 1 && !args.replaceAll) throw new Error(`oldText appears ${count} times; set replaceAll=true`);
      const updated = args.replaceAll ? raw.split(oldText).join(newText) : raw.replace(oldText, newText);
      // v0.8-S4a: checkpoint the original bytes (op modify) BEFORE overwriting. `raw` is the pre-edit
      // content already read above; only reached once we know the edit will apply (not the not-found path).
      const jctx = await journalSessionCtx(ctx);
      await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_edit', p, 'modify', raw);
      await fsp.writeFile(p, updated, 'utf8');
      return { ok: true, path: p, op: 'modify', replacements: args.replaceAll ? count : 1 };
  } },
  file_delete: { paths: "write", guardNote: '', handler: async (args, ctx) => {
      // v0.8-S4a (moved in from S1 — a not-undoable delete could not ship before the journal existed).
      // Checkpoint the file's bytes (op delete) BEFORE unlinking so a rollback can resurrect it. Refuse
      // directories (only files are journaled/deletable here).
      const p = path.resolve(String(args.path || ''));
      { const g = await guardFileToolPath(p, ctx, { tool: 'file_delete', write: true }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
      const st = await fsp.stat(p).catch(() => null);
      // v0.8-S7 error guidance: same ENOENT hint as file_read/file_edit so the model confirms the path first.
      if (!st) return { ok: false, error: '文件不存在', path: p, hint: '文件不存在;先用 glob 或 file_list 确认路径' };
      if (st.isDirectory()) return { ok: false, error: 'is a directory', hint: '仅支持删除文件' };
      const before = await fsp.readFile(p);
      const jctx = await journalSessionCtx(ctx);
      await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_delete', p, 'delete', before);
      await fsp.unlink(p);
      return { ok: true, path: p, op: 'delete' };
  } },
  file_move: { paths: "both", guardNote: '', handler: async (args, ctx) => {
    // v1.1-W2 (T1) file_move(from, to, overwrite=false): 移动/重命名。检查点两条各自逆操作（见下注释）。
    // 逆操作语义表（把关人可据此审）：
    //   ① from 存 op:delete（before=from 原内容）→ 回滚 = 把内容写回 from。
    //   ② to 已存在则存 op:modify（before=to 原内容）→ 回滚 = 把内容写回 to；
    //      to 不存在则存 op:create（before=null）→ 回滚 = 删除 to。
    //   两条按 entrySeq 逆序回滚（先撤 to 再撤 from）→ 净效果 = 文件回到 from、to 恢复原状/消失。
      const from = path.resolve(String(args.from || ''));
      const to = path.resolve(String(args.to || ''));
      if (!args.from || !args.to) return { ok: false, error: 'from 与 to 都不能为空' };
      const fromSt = await fsp.stat(from).catch(() => null);
      if (!fromSt) return { ok: false, error: '源文件不存在', path: from, hint: '先用 glob 或 file_list 确认路径' };
      if (fromSt.isDirectory()) return { ok: false, error: '暂不支持移动文件夹', hint: '仅支持移动单个文件' };
      // v1.4.6-S3: a move both reads+deletes `from` and writes `to` — guard both as writes (out-of-bounds → deny).
      { const gf = await guardFileToolPath(from, ctx, { tool: 'file_move', write: true }); if (!gf.ok) return { ok: false, error: gf.error, code: gf.code, path: from }; }
      { const gt = await guardFileToolPath(to, ctx, { tool: 'file_move', write: true }); if (!gt.ok) return { ok: false, error: gt.error, code: gt.code, path: to }; }
      const toExists = await fsp.stat(to).then(() => true).catch(() => false);
      if (toExists && !args.overwrite) return { ok: false, error: '目标已存在', path: to, hint: '若要覆盖请设置 overwrite=true' };
      const fromBefore = await fsp.readFile(from);
      const toBefore = toExists ? await fsp.readFile(to) : null;
      const jctx = await journalSessionCtx(ctx);
      // ① from 侧：op:delete（回滚=写回 from）。
      await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_move', from, 'delete', fromBefore);
      // ② to 侧：已存在=modify（回滚=写回原 to）；不存在=create（回滚=删 to）。
      await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_move', to, toExists ? 'modify' : 'create', toExists ? toBefore : null);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      try {
        await fsp.rename(from, to);
      } catch (e) {
        // 跨盘（EXDEV）退化：copy + delete。fs.rename 不能跨卷。
        if (e && e.code === 'EXDEV') {
          await fsp.copyFile(from, to);
          await fsp.unlink(from);
        } else throw e;
      }
      return { ok: true, from, to, op: 'move', overwritten: toExists };
  } },
  file_copy: { paths: "both", guardNote: '', handler: async (args, ctx) => {
    // v1.1-W2 (T1) file_copy(from, to, overwrite=false)。逆操作：仅 to 一条。
    //   to 已存在 → op:modify（回滚=写回原 to）；不存在 → op:create（回滚=删 to）。from 不动，无需检查点。
      const from = path.resolve(String(args.from || ''));
      const to = path.resolve(String(args.to || ''));
      if (!args.from || !args.to) return { ok: false, error: 'from 与 to 都不能为空' };
      const fromSt = await fsp.stat(from).catch(() => null);
      if (!fromSt) return { ok: false, error: '源文件不存在', path: from, hint: '先用 glob 或 file_list 确认路径' };
      if (fromSt.isDirectory()) return { ok: false, error: '暂不支持复制文件夹', hint: '仅支持复制单个文件' };
      // v1.4.6-S3: copy READS `from` (exfil vector if out of bounds) and WRITES `to` — guard each accordingly.
      { const gf = await guardFileToolPath(from, ctx, { tool: 'file_copy', write: false }); if (!gf.ok) return { ok: false, error: gf.error, code: gf.code, path: from }; }
      { const gt = await guardFileToolPath(to, ctx, { tool: 'file_copy', write: true }); if (!gt.ok) return { ok: false, error: gt.error, code: gt.code, path: to }; }
      const toExists = await fsp.stat(to).then(() => true).catch(() => false);
      if (toExists && !args.overwrite) return { ok: false, error: '目标已存在', path: to, hint: '若要覆盖请设置 overwrite=true' };
      const toBefore = toExists ? await fsp.readFile(to) : null;
      const jctx = await journalSessionCtx(ctx);
      await journalRecord(jctx.sessionId, jctx.turnSeq, 'file_copy', to, toExists ? 'modify' : 'create', toExists ? toBefore : null);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      return { ok: true, from, to, op: 'copy', overwritten: toExists };
  } },
  file_list: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      const root = path.resolve(args.root || process.cwd());
      const g = await guardFileToolPath(root, ctx, { tool: 'file_list', write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
      return { ok: true, root, files: await walkFiles(root, args) };
  } },
  file_search: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      const root = path.resolve(args.root || process.cwd());
      const g = await guardFileToolPath(root, ctx, { tool: 'file_search', write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
      let matches = await searchFileContent(root, String(args.pattern || ''), args);
      // 审计 P1(对抗轮补漏): JS 扫描路径已在 walkFiles 跳过敏感子树;rg 路径不经 walkFiles,这里补一道结果层过滤
      // (对 flat 与 group:true 两种形态,项内都带 .path)。ensureDataRootReal 已由上游 guardFileToolPath(root) 预热。
      if (Array.isArray(matches)) { const pn = matches.patternNote; matches = matches.filter(m => !isSensitiveDataPath(m && m.path)); if (pn) matches.patternNote = pn; }
      const resp = { ok: true, root, matches };
      // F2: literal-fallback marker (invalid regex was searched as escaped literal text) — additive field.
      if (matches && matches.patternNote) resp.patternNote = matches.patternNote;
      return resp;
  } },
  glob: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      // v0.8-S1: glob file matcher. Self-written `**`/`*`/`?` → RegExp; reuses walkFiles for traversal
      // (its default ignoreDirs: node_modules/.git/.venv). Returns files sorted by mtime DESC, capped
      // at maxResults (default 500) with a `truncated` flag.
      const root = path.resolve(args.root || process.cwd());
      const g = await guardFileToolPath(root, ctx, { tool: 'glob', write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
      const pattern = String(args.pattern || '');
      if (!pattern) throw new Error('pattern is required');
      const maxResults = Math.max(1, Number(args.maxResults || 500) || 500);
      const globRe = globToRegExp(pattern);
      // Walk generously (no relative-path pre-filter), then match rel path against the glob.
      const all = await walkFiles(root, { recursive: true, maxFiles: Math.max(maxResults * 4, 4000), maxDepth: Number(args.maxDepth || 12) });
      const matched = [];
      for (const f of all) {
        if (f.type !== 'file') continue;
        if (!globRe.test(f.relativePath)) continue;
        const stat = await fsp.stat(f.path).catch(() => null);
        matched.push({ path: f.path, relativePath: f.relativePath, mtime: stat ? stat.mtimeMs : 0 });
      }
      matched.sort((a, b) => b.mtime - a.mtime);
      const truncated = matched.length > maxResults;
      return { ok: true, root, files: matched.slice(0, maxResults).map(m => ({ path: m.path, relativePath: m.relativePath, mtime: m.mtime })), truncated };
  } },
  project_snapshot: { paths: "read", guardNote: '', handler: async (args, ctx) => {
      const root = path.resolve(args.root || process.cwd());
      // 第41波(41a 表驱动首擒):file_list/file_search/glob 都有读闸,唯独本工具没有 —— 远端模型可越界列目录。
      // 注册表声明让这条不对称现形,补上同族读闸(本地模型越界读仍放行,与 file_list 完全同闸,行为只收不松)。
      const g = await guardFileToolPath(root, ctx, { tool: 'project_snapshot', write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
      const files = await walkFiles(root, { recursive: true, maxFiles: args.maxFiles || 300, maxDepth: args.maxDepth || 4 });
      return { ok: true, root, files };
  } },
};

const ARCHIVE_TOOL_HANDLERS = {
  archive_zip: { paths: "both", guardNote: '', handler: async (args, ctx) => {
    // v1.1-W2 (T1) archive_zip(paths[], dest): 打包工作区内文件/文件夹为 .zip（deflate，零 npm）。
    //   dest 已存在 → 存 before（op:modify，回滚=写回原 dest）；否则 op:create（回滚=删 dest）。
    //   单文件 100MB / 总量 500MB 上限（zipCollectEntries 内卡，超限人话拒绝）。
      const inputs = Array.isArray(args.paths) ? args.paths.filter(p => typeof p === 'string' && p.trim()) : [];
      const dest = path.resolve(String(args.dest || ''));
      if (!inputs.length) return { ok: false, error: 'paths 不能为空', hint: '给出要打包的文件或文件夹路径数组' };
      if (!args.dest) return { ok: false, error: 'dest 不能为空' };
      // 第27波对抗轮 P2(Gap B):打包【源】与【目标】都过工作区护栏 —— 此前 archive_zip/zipCollectEntries 对 paths[] 无任何
      // 边界检查(与 file_copy 的 from 侧护栏不对称),模型可 archive_zip({paths:['~/.ssh/id_rsa', dataRoot/config.json,
      // dataRoot/runtime.json], dest:工作区/a.zip})把敏感控制面/越界文件静默打包 → 解压 → file_read 出明文密钥+token。
      // 源按【读】判(敏感 denylist 恒拒 + 远端模型越界读拒);dest 按【写】判(越界写恒拒)。与 guardFileToolPath 同 sink。
      for (const raw of inputs) {
        const gp = await guardFileToolPath(path.resolve(String(raw)), ctx, { tool: 'archive_zip', write: false });
        if (!gp.ok) return { ok: false, error: gp.error, code: gp.code, path: raw };
      }
      { const gd = await guardFileToolPath(dest, ctx, { tool: 'archive_zip', write: true }); if (!gd.ok) return { ok: false, error: gd.error, code: gd.code, path: dest }; }
      let entries;
      try { entries = await zipCollectEntries(inputs); }
      catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
      if (!entries.length) return { ok: false, error: '没有可打包的文件（源为空或全是符号链接）' };
      const zipBuf = zipWrite(entries);
      const destExists = await fsp.stat(dest).then(() => true).catch(() => false);
      const destBefore = destExists ? await fsp.readFile(dest) : null;
      const jctx = await journalSessionCtx(ctx);
      await journalRecord(jctx.sessionId, jctx.turnSeq, 'archive_zip', dest, destExists ? 'modify' : 'create', destExists ? destBefore : null);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, zipBuf);
      const fileCount = entries.filter(e => !e.isDir).length;
      return { ok: true, dest, op: destExists ? 'modify' : 'create', entries: entries.length, files: fileCount, bytes: zipBuf.length };
  } },
  archive_unzip: { paths: "both", guardNote: '', handler: async (args, ctx) => {
    // v1.1-W2 (T1) archive_unzip(src, destDir, overwrite=false): 解 .zip 到 destDir（stored/deflate）。
    //   【Zip Slip 防御·安全命门】每个条目 resolve 后必须仍在 destDir 内，任一 '..' 越界 → 整包拒绝（不解压任何文件）。
    //   符号链接条目跳过。条目数 ≤2000、解压累计 ≤500MB（zip 炸弹，超限中止）。
    //   覆盖到已存在文件时逐个 before 快照（op:modify，回滚=写回）；新建文件 op:create（回滚=删）。
      const src = path.resolve(String(args.src || ''));
      const destDir = path.resolve(String(args.destDir || ''));
      if (!args.src || !args.destDir) return { ok: false, error: 'src 与 destDir 都不能为空' };
      // 第27波对抗轮 P2(Gap B):src 读、destDir 写都过工作区护栏(此前缺失)。src 敏感/越界 → 拒;destDir 越界 → 拒。
      // Zip Slip 逐条防御(下方)仍在,二者叠加:destDir 受限 + 每个解出的条目再验落在 destDir 内。
      { const gs = await guardFileToolPath(src, ctx, { tool: 'archive_unzip', write: false }); if (!gs.ok) return { ok: false, error: gs.error, code: gs.code, path: src }; }
      { const gdd = await guardFileToolPath(destDir, ctx, { tool: 'archive_unzip', write: true }); if (!gdd.ok) return { ok: false, error: gdd.error, code: gdd.code, path: destDir }; }
      const srcSt = await fsp.stat(src).catch(() => null);
      if (!srcSt) return { ok: false, error: '压缩包不存在', path: src, hint: '先用 file_list 确认路径' };
      if (srcSt.size > ZIP_MAX_TOTAL) return { ok: false, error: `压缩包超过大小上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB）` };
      let buf, records;
      try { buf = await fsp.readFile(src); records = zipReadCentralDir(buf); }
      catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
      if (records.length > ZIP_MAX_ENTRIES) return { ok: false, error: `压缩包条目数超过上限（${ZIP_MAX_ENTRIES}）`, hint: '疑似 zip 炸弹，已拒绝' };
      // ---- 第一遍：安全校验（Zip Slip + 符号链接）。任一越界 → 整包拒绝，不落任何盘 ----
      const destReal = path.resolve(destDir);
      const plan = []; // {rec, absPath}
      for (const rec of records) {
        if (rec.isSymlink) continue; // 符号链接条目跳过（不解，安全）
        // 归一化条目名（'/' → 平台分隔），resolve 到 destDir 下，再验证仍在 destDir 内。
        const cleanName = String(rec.name).replace(/\\/g, '/').replace(/^\/+/, '');
        const target = path.resolve(destReal, cleanName);
        if (!pathWithinRoot(target, destReal)) {
          return { ok: false, error: '压缩包含越界路径（Zip Slip），已整包拒绝', entry: rec.name, hint: '该压缩包可能是恶意构造的，未解压任何文件' };
        }
        plan.push({ rec, absPath: target });
      }
      // ---- 第二遍：逐条解压 + 检查点。累计字节卡 500MB（zip 炸弹二次防御，inflate 后累加）----
      const jctx = await journalSessionCtx(ctx);
      const written = [];
      let extractedBytes = 0;
      for (const { rec, absPath } of plan) {
        if (rec.isDir || rec.name.endsWith('/')) { await fsp.mkdir(absPath, { recursive: true }); continue; }
        let data;
        try { data = zipReadEntryData(buf, rec); }
        catch (e) { return { ok: false, error: (e && e.message) || String(e), entry: rec.name }; }
        extractedBytes += data.length;
        if (extractedBytes > ZIP_MAX_TOTAL) return { ok: false, error: `解压总大小超过上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB）`, hint: '疑似 zip 炸弹，已中止' };
        const exists = await fsp.stat(absPath).then(() => true).catch(() => false);
        if (exists && !args.overwrite) return { ok: false, error: '目标文件已存在', path: absPath, hint: '若要覆盖请设置 overwrite=true' };
        const before = exists ? await fsp.readFile(absPath) : null;
        await journalRecord(jctx.sessionId, jctx.turnSeq, 'archive_unzip', absPath, exists ? 'modify' : 'create', exists ? before : null);
        await fsp.mkdir(path.dirname(absPath), { recursive: true });
        await fsp.writeFile(absPath, data);
        written.push(absPath);
      }
      return { ok: true, src, destDir, files: written.length, bytes: extractedBytes };
  } },
};

const SHELL_TOOL_HANDLERS = {
  powershell_run: { paths: null, guardNote: "任意 shell 命令,exec tier+权限弹窗/授权书把守;路径闸对自由命令不可施", handler: async (args, ctx) => {
      return runPowerShell(String(args.command || ''), args.cwd, args.timeoutMs);
  } },
  script_run: { paths: null, guardNote: "任意脚本执行(落 generated/scripts 应用自选目录),exec tier+权限链把守;Office 手写软闸内置", handler: async (args, ctx) => {
      // v1.2 返修(用户实测证明:Office 产出规程提示词在续聊/惯性场景拦不住)——脚本手写 Office 的
      // 【工具层】软闸。现成 Office 工具走统一模板且进检查点可撤销;脚本现场发挥二者皆失。检测到
      // Office 写意图 → 拒绝并给配方;确有现成工具覆盖不了的特殊需求时,模型加 force:true 重调即放行
      // (并应向用户说明该产出不可自动撤销)。提示词是软约束,这里是硬闸(带 force 泄压阀,不锁死能力)。
      {
        const codeStr = String(args.code || '');
        const officeLib = OFFICE_WRITER_LIB_RE.test(codeStr);   // v1.4.1 (audit #7):与 bridged 软闸共用强化正则
        const officeFile = /\.(xlsx|xlsm|docx|pptx|pdf)\b/i.test(codeStr);
        if (args.force !== true && officeLib && officeFile) {
          return {
            ok: false,
            error: '检测到脚本在手写 Office 文件。请改用现成工具:Excel = write_excel → excel_beautify →(需图表)excel_chart;PPT = write_pptx;Word = write_document;PDF = write_pdf——统一模板、可一键撤销。若现成工具确实覆盖不了(特殊格式需求),重新调用 script_run 并加参数 force:true,同时向用户说明该产出不可自动撤销。',
            hint: 'Office 产出规程(工具层强制,v1.2)',
          };
        }
      }
      const language = String(args.language || 'powershell').toLowerCase();
      const id = makeId('script');
      const dir = path.join(paths.generated, 'scripts');
      await fsp.mkdir(dir, { recursive: true });
      if (language === 'python') {
        const p = path.join(dir, `${id}.py`);
        await fsp.writeFile(p, String(args.code || ''), 'utf8');
        return runProcess('python', [p], { cwd: args.cwd || os.homedir(), timeoutMs: args.timeoutMs || 60000 });
      }
      if (language === 'node' || language === 'javascript') {
        const p = path.join(dir, `${id}.js`);
        await fsp.writeFile(p, String(args.code || ''), 'utf8');
        return runProcess(process.execPath, [p], { cwd: args.cwd || os.homedir(), timeoutMs: args.timeoutMs || 60000 });
      }
      const p = path.join(dir, `${id}.ps1`);
      await fsp.writeFile(p, String(args.code || ''), 'utf8');
      return runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p], {
        cwd: args.cwd || os.homedir(),
        timeoutMs: args.timeoutMs || 60000,
      });
  } },
  shell_start: { paths: null, guardNote: "持久 shell 会话状态面,exec tier 门+MCP 子进程拒;不直接触文件路径", handler: async (args, ctx) => {
    // v0.8-S2 shell session族 — provider-engine only. In the one-shot MCP child (Claude CLI engine) the
    // session Map cannot persist across turns, so return a guiding error rather than fake a session.
      if (RUNTIME.isMcpChild) return shellMcpChildGuard();
      const cfg = await readConfig().catch(() => ({ shellSessionMax: 3 }));
      return shellStart(args, cfg);
  } },
  shell_send: { paths: null, guardNote: "同 shell_start", handler: async (args, ctx) => {
      if (RUNTIME.isMcpChild) return shellMcpChildGuard();
      return shellSend(args);
  } },
  shell_poll: { paths: null, guardNote: "同 shell_start", handler: async (args, ctx) => {
      if (RUNTIME.isMcpChild) return shellMcpChildGuard();
      return shellPoll(args);
  } },
  shell_kill: { paths: null, guardNote: "同 shell_start", handler: async (args, ctx) => {
      if (RUNTIME.isMcpChild) return shellMcpChildGuard();
      return shellKill(args);
  } },
  shell_list: { paths: null, guardNote: "会话清单只读,不触文件路径", handler: async (args, ctx) => {
      if (RUNTIME.isMcpChild) return shellMcpChildGuard();
      return shellList();
  } },
};

const DESKTOP_TOOL_HANDLERS = {
  desktop_screenshot: { paths: "conditional", guardNote: '', handler: async (args, ctx) => {
      const outPathRaw = path.resolve(args.outputPath || path.join(paths.generated, `screenshot-${Date.now()}.png`));
      // 第36波(v1.7): 模型【给定】的 outputPath 过工作区写闸(越界写恒拒,与 file_write 同闸;bypass 模式下这是
      // 唯一防线)。缺省落 generated/ 是应用自选路径,不过此闸 —— generated 属 isSensitiveDataPath 敏感名单
      // (内含带 token 的会话 MCP 配置),文件工具闸会连缺省路径一起误拒;应用自身写自己的产物目录本就合法。
      let outPath = outPathRaw;
      if (args.outputPath) {
        const gShot = await guardFileToolPath(outPathRaw, ctx, { tool: 'desktop_screenshot', write: true });
        if (!gShot.ok) return { ok: false, error: gShot.error, code: gShot.code, path: outPathRaw };
        outPath = gShot.absPath;
      }
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
Write-Output '${outPath.replace(/'/g, "''")}'
`;
      const result = await runPowerShell(ps, os.homedir(), args.timeoutMs || 15000);
      return { ...result, path: outPath };
  } },
  keyboard_send_keys: { paths: null, guardNote: "键盘注入,不触文件路径", handler: async (args, ctx) => {
      const keys = String(args.keys || '');
      if (!keys) throw new Error('keys is required');
      const ps = `$wshell = New-Object -ComObject wscript.shell; Start-Sleep -Milliseconds ${Number(args.delayMs || 200)}; $wshell.SendKeys('${keys.replace(/'/g, "''")}')`;
      return runPowerShell(ps, os.homedir(), args.timeoutMs || 10000);
  } },
  office_open: { paths: null, guardNote: "第36波录在案:不加读闸(打开不回流模型;exec tier 权限门);v1.4.6-S2 无 shell spawn", handler: async (args, ctx) => {
      const target = path.resolve(String(args.path || ''));
      // 第36波(v1.7) 评审结论:本工具【不】加工作区读闸,理由记录在案防复报 —— 打开的文件内容不回流模型
      // (无 S3 外传通道),"打开桌面/下载里的文档"正是非程序员用户的正当主流程,读闸会误杀;模型可控路径
      // 的风险面是命令注入(S2 已修)与关联程序执行,后者由 exec tier 权限弹窗/授权书把守,与其它 exec 工具同级。
      // v1.4.6-S2: same cmd.exe injection fix as browser_open — direct explorer.exe spawn, no shell.
      const s = buildOpenSpawn(target);
      cp.spawn(s.command, s.args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      return { ok: true, opened: target };
  } },
};

const NETWORK_TOOL_HANDLERS = {
  web_search: { paths: null, guardNote: "纯网络读;searchBackend 为管理端可信端点(SSRF 豁免录在案 v0.9-S9)", handler: async (args, ctx) => {
    // v0.9-S9 (D6): web_search reads searchBackend from config (baseUrl is the admin's TRUSTED endpoint →
    // exempt from SSRF; see the web section header). web_fetch's url is UNTRUSTED → SSRF-guarded inside.
      const cfg = await readConfig().catch(() => ({ searchBackend: { type: 'none' } }));
      return webSearch(args, cfg);
  } },
  web_fetch: { paths: null, guardNote: "纯网络读,SSRF 全套护栏内置(ssrfCheck/dnsResolvesToPrivate 逐跳)", handler: async (args, ctx) => {
      return webFetch(args);
  } },
  http_request: { paths: null, guardNote: "纯网络调用,不触文件路径", handler: async (args, ctx) => {
      return httpRequest(args);
  } },
  http_download: { paths: "write", guardNote: '', handler: async (args, ctx) => {
    // v1.1-W2 (T1) http_download(url, dest, maxBytes=100MB): 下载文件到工作区。复用 web_fetch 的 SSRF 全套护栏
    //   （httpGetGuarded：逐跳 ssrfCheck + dnsResolvesToPrivate）。dest 过工作区路径护栏（guardDownloadDest）。
    //   dest 已存在 → before 快照（op:modify，回滚=写回）；新建 op:create（回滚=删）。Content-Length 与实收都卡 maxBytes。
      const url = String(args.url || '').trim();
      if (!url) return { ok: false, error: 'url 不能为空' };
      if (!args.dest) return { ok: false, error: 'dest 不能为空' };
      const maxBytes = Math.min(ZIP_MAX_SINGLE_FILE, Math.max(1, Number(args.maxBytes) || 100 * 1024 * 1024));
      // ① SSRF 前置拒绝（与 webFetch 同：内网/回环/非 http(s) 一律不发包）。
      const pre = ssrfCheck(url);
      if (!pre.allowed) return { ok: false, error: pre.reason, blocked: pre.host };
      // ② 落盘目标护栏（工作区内）。
      const guard = await guardDownloadDest(args.dest, ctx);
      if (!guard.ok) return { ok: false, error: guard.error };
      const dest = guard.absPath;
      // ③ 下载（httpGetGuarded 逐跳 SSRF + DNS 重绑定防御 + Content-Length 预拒 + maxBytes 实收截断）。
      const got = await httpGetGuarded(url, { maxBytes, timeoutMs: Number(args.timeoutMs) || 30000, rejectOverMaxBytes: true });
      if (got.blocked) return { ok: false, error: got.error, blocked: got.blocked };
      if (got.failClass === 'too-big') return { ok: false, error: `文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`, contentLength: got.contentLength, hint: '增大 maxBytes 或改用其它方式下载' };
      if (!got.ok || !got.body) {
        const mapped = webFetchFailMessage(got);
        return { ok: false, error: mapped.error, failClass: got.failClass || 'other', statusCode: got.statusCode, hint: mapped.hint };
      }
      // 实收字节卡上限：httpGetGuarded 在 maxBytes 处截断并置 truncated → 视为超限拒绝（不落半截文件）。
      if (got.truncated) return { ok: false, error: `文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`, hint: '增大 maxBytes 或改用其它方式下载' };
      // ④ 检查点 + 落盘。
      const exists = await fsp.stat(dest).then(() => true).catch(() => false);
      const before = exists ? await fsp.readFile(dest) : null;
      const jctx = await journalSessionCtx(ctx);
      await journalRecord(jctx.sessionId, jctx.turnSeq, 'http_download', path.resolve(String(args.dest)), exists ? 'modify' : 'create', exists ? before : null);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, got.body);
      markNetworkOnline(); // 成功下载 = 在线证据，顺手刷新能力缓存
      return { ok: true, path: dest, bytes: got.body.length, contentType: (got.contentType || null), op: exists ? 'modify' : 'create' };
  } },
  browser_open: { paths: null, guardNote: "spawn 默认浏览器(buildBrowserOpenSpawn 无 shell);exec tier 门,不触文件路径", handler: async (args, ctx) => {
      const target = String(args.url || '');
      if (!target) throw new Error('url is required');
      // Shell-free and non-destructive: URLs/local HTML open in an explicit new browser tab where the
      // default-browser executable is available; folders keep the safe Explorer handoff behavior.
      const s = buildBrowserOpenSpawn(target);
      cp.spawn(s.command, s.args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      return { ok: true, opened: target, browserMode: s.mode, preservedWorkbench: true };
  } },
};

const CODE_TOOL_HANDLERS = {
  git_status: { paths: null, guardNote: "git 子进程 execFile 无 shell;cwd 经 resolveGitCwd(存在的目录才用);只读检查", handler: async (args, ctx) => {
    // v1.0-S4 git 工具族 — 无状态 execFile('git',…),两个引擎路径都命中(同 file_read)。
      return gitStatus(args);
  } },
  git_diff: { paths: null, guardNote: "同 git_status;另 --no-ext-diff/--no-textconv 关外部执行面", handler: async (args, ctx) => {
      return gitDiff(args);
  } },
  git_log: { paths: null, guardNote: "同 git_status", handler: async (args, ctx) => {
      return gitLog(args);
  } },
  git_commit: { paths: null, guardNote: "git 子进程 execFile 无 shell;exec tier(commit 触发 hooks)录在案;cwd 经 resolveGitCwd", handler: async (args, ctx) => {
      return gitCommit(args);
  } },
  dependency_inventory: { paths: null, guardNote: "只读盘点,walkFiles 自带敏感子树跳过", handler: async (args, ctx) => {
      return dependencyInventory(args.root || process.cwd());
  } },
  code_review_scan: { paths: null, guardNote: "只读扫描,walkFiles 自带敏感子树跳过", handler: async (args, ctx) => {
      return codeReviewScan(args.root || process.cwd(), args);
  } },
  frontend_audit: { paths: null, guardNote: "只读扫描,walkFiles 自带敏感子树跳过", handler: async (args, ctx) => {
      return frontendAudit(args.root || process.cwd(), args);
  } },
  claude_md_audit: { paths: null, guardNote: "只读扫描,walkFiles 自带敏感子树跳过", handler: async (args, ctx) => {
      return claudeMdAudit(args.root || process.cwd());
  } },
  docs_search: { paths: null, guardNote: "只读搜索,walkFiles 自带敏感子树跳过", handler: async (args, ctx) => {
      return docsSearch(args.root || process.cwd(), String(args.query || ''), args);
  } },
};

const AGENT_TOOL_HANDLERS = {
  spawn_agent: { paths: null, guardNote: "无回合上下文一律拒绝(特例闭包在 runOpenAiTurn)", handler: async (args, ctx) => {
    // v0.9-S6: spawn_agent needs the live provider/session/journal/onEvent closure, so it is handled ONLY
    // inside runOpenAiTurn's tool loop (special-cased like todo_write/bridge). If it ever reaches the
    // context-free toolCall() — a direct /api/tools/spawn_agent, or a call inside the one-shot MCP child —
    // there is no turn context to run a sub-turn against, so refuse cleanly (never throw / fake a run).
      return { ok: false, error: 'spawn_agent 仅在 provider 引擎的对话回合内可用' };
  } },
  orchestrate_agents: { paths: null, guardNote: "MCP 子进程 loopback /api/agent-workflow/launch;无会话上下文拒绝", handler: async (args, ctx) => {
      if (RUNTIME.isMcpChild) {
        const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
        const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
        if (!port || !token || !sessionId) return { ok: false, error: 'Agent DAG 需要工作台会话上下文' };
        try {
          // v1.4.4: forward workflowId/context too — the model choosing a saved template BY REFERENCE
          // (instead of always having to author a full inline `nodes` DAG itself) only works if this
          // loopback actually passes those fields through to the one place that resolves them.
          const resp = await httpRequest({ url: `http://${host}:${port}/api/agent-workflow/launch`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, sessionId, nodes: args.nodes, workflowId: args.workflowId, context: args.context, providerId: args.providerId }), timeoutMs: 900000, maxBodyChars: 200000 });
          return safeJsonParse(resp.body, { ok: false, error: 'invalid agent workflow response' });
        } catch (e) { return { ok: false, error: `Agent DAG loopback error: ${(e && e.message) || String(e)}` }; }
      }
      return { ok: false, error: 'orchestrate_agents 需要在 OpenAI 对话回合或 Claude CLI 工作台会话中调用' };
  } },
};

const INTEGRATION_TOOL_HANDLERS = {
  skill_read: { paths: null, guardNote: "技能目录内自守:注册表 dir 解析+path.relative 双保险防穿越(非工作区闸,设计录在案)", handler: async (args, ctx) => {
      // v1 技能体系: 读取当前会话【已启用】技能的 SKILL.md 全文 + 目录内文件清单(深度≤2,数量≤50)。
      // 白名单: 只认 ctx.session.skills 里的 id;dir 从统一注册表解析(与优先级/校验单一真源一致)。
      // 路径安全: 遍历时每个文件解析后必须仍在该技能目录内(path.relative 不得以 .. 开头/绝对),防符号链接穿越。
      const session = ctx && ctx.session;
      const cfg = (ctx && ctx.config) || await readConfig().catch(() => null);
      const enabled = effectiveSkillSelection(session, cfg);
      const id = String(args.id || '').trim();
      // P2-2: enabled 元素为 {id, source}(或旧裸字符串)。白名单按 id 匹配;source 非空则下方再校验注册表来源一致。
      const enabledEntry = enabled.find(x => (typeof x === 'string' ? x : (x && x.id)) === id);
      if (!id || !enabledEntry) return { ok: false, error: '技能未启用或不存在(只能读取当前会话已启用的技能)', id };
      const wantSource = typeof enabledEntry === 'string' ? '' : String((enabledEntry && enabledEntry.source) || '');
      // P3-4: cwd 单一真源 —— 优先用回合传入的 workingDir(ctx.workingDir),缺省再退 session.cwd,与注入路径一致。
      const cwd = normalizeCwd((ctx && ctx.workingDir) || (session && session.cwd), cfg && cfg.defaultWorkspace);
      let registry = [];
      try { registry = await loadSkillRegistry(cwd, cfg); } catch { registry = []; }
      const entry = registry.find(e => e && e.id === id && e.kind === 'skill');
      if (!entry || !entry.dir) return { ok: false, error: '技能不存在或无内容目录', id };
      // P2-2: 来源锁定 —— 启用时记录了 source,若注册表现解析出的来源不一致(换 cwd 后被项目技能顶替等)→ 明确拒绝。
      if (wantSource && entry.source !== wantSource) {
        return { ok: false, id, error: `技能 ${id} 来源已变化(启用时为 ${wantSource},现为 ${entry.source || '未知'}),已暂停;请在技能库重新启用该技能。` };
      }
      const dir = path.resolve(entry.dir);
      const dirReal = await realpathForContainment(dir);
      // P3-1: 传了 file(相对路径)→ 返回该文件内容(截 20000)而非清单;复用同款目录内守卫(path.relative 不得越界)。
      const fileArg = String(args.file || '').trim();
      if (fileArg) {
        const fabs = path.resolve(dir, fileArg);
        const frel = path.relative(dir, fabs);
        if (frel.startsWith('..') || path.isAbsolute(frel)) return { ok: false, id, file: fileArg, error: '文件路径越界(只能读取该技能目录内的文件)' };
        const freal = await fsp.realpath(fabs).catch(() => fabs); // 解析符号链接后再判一次,防穿越
        const frelReal = path.relative(dirReal, freal);
        if (frelReal.startsWith('..') || path.isAbsolute(frelReal)) return { ok: false, id, file: fileArg, error: '文件路径越界(只能读取该技能目录内的文件)' };
        let fileContent = '';
        try { const st = await fsp.stat(freal); if (!st.isFile()) return { ok: false, id, file: fileArg, error: '不是文件' }; fileContent = String(await fsp.readFile(freal, 'utf8')); }
        catch { return { ok: false, id, file: fileArg, error: '文件不存在或无法读取' }; }
        const fileTruncated = fileContent.length > 20000;
        if (fileTruncated) fileContent = fileContent.slice(0, 20000);
        return { ok: true, id, name: entry.name, dir, file: frel.split(path.sep).join('/'), content: fileContent, truncated: fileTruncated };
      }
      let content = '';
      try { content = String(await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8')); } catch { content = ''; }
      const truncated = content.length > 20000;
      if (truncated) content = content.slice(0, 20000);
      const files = [];
      const walk = async (d, depth) => {
        if (depth > 2 || files.length >= 50) return;
        let ents = [];
        try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const ent of ents) {
          if (files.length >= 50) break;
          const abs = path.resolve(d, ent.name);
          const rel = path.relative(dir, abs);
          if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // 越界(符号链接等)→ 跳过
          if (ent.isDirectory()) await walk(abs, depth + 1);
          else if (ent.isFile()) files.push(rel.split(path.sep).join('/'));
        }
      };
      try { await walk(dir, 1); } catch { /* 清单尽力而为 */ }
      return {
        ok: true, id, name: entry.name, dir, content, truncated, files,
        note: '需要读取清单中的某个文件时,再次调用 skill_read 并额外传 file 参数(相对该技能目录的路径),即返回该文件内容。',
      };
  } },
  mcp_list: { paths: null, guardNote: "配置盘点(env 脱敏),不触文件路径", handler: async (args, ctx) => {
      const cfg = (ctx && ctx.config) || await readConfig();
      return { ok: true, servers: safeMcpInventory(cfg), browserAutomation: cfg.browserAutomation || defaultConfig().browserAutomation,
        note: 'env 仅返回键名，不返回可能含密钥的值。' };
  } },
  mcp_configure: { paths: null, guardNote: "写应用配置(exec tier 门),不触任意文件路径", handler: async (args, ctx) => {
      const cfg = await readConfig(); // use latest disk config, not the turn-start snapshot
      return configureMcpFromTool(args, cfg);
  } },
};

const TOOL_HANDLERS = Object.freeze(Object.assign({},
  CORE_TOOL_HANDLERS, FILE_TOOL_HANDLERS, ARCHIVE_TOOL_HANDLERS, SHELL_TOOL_HANDLERS,
  DESKTOP_TOOL_HANDLERS, NETWORK_TOOL_HANDLERS, CODE_TOOL_HANDLERS, AGENT_TOOL_HANDLERS,
  INTEGRATION_TOOL_HANDLERS));
// 装时机断言:组间重名会被 Object.assign 静默覆盖 —— 启动即炸,不允许带病运行(行为锁另有 e2e)。
{
  const declared = [CORE_TOOL_HANDLERS, FILE_TOOL_HANDLERS, ARCHIVE_TOOL_HANDLERS, SHELL_TOOL_HANDLERS,
    DESKTOP_TOOL_HANDLERS, NETWORK_TOOL_HANDLERS, CODE_TOOL_HANDLERS, AGENT_TOOL_HANDLERS, INTEGRATION_TOOL_HANDLERS]
    .reduce((n, g) => n + Object.keys(g).length, 0);
  if (declared !== Object.keys(TOOL_HANDLERS).length) throw new Error('TOOL_HANDLERS: 组间存在重名工具,注册表被静默覆盖');
}

async function toolCall(name, args = {}, ctx = null) {
  const entry = TOOL_HANDLERS[name];
  if (!entry) throw new Error(`Unknown tool: ${name}`);
  return entry.handler(args, ctx);
}

let LAUNCH_MODE = 'unknown';

// 48b(P2):overlay 清单校验缓存。verifyManifest 经 computeHealth -> /api/status 被前端轮询,旧实现每轮全文件
// SHA-256 是纯浪费。mtime+size 快路径:文件未变则复用上次算的 sha,跳过读盘+hash;60s 强制全量校验防
// mtime 伪造/同 mtime 异内容边角。缓存按 manifest.version 失效(新 overlay 落地即重算)。
let _maniCache = null; // { version, files: Map(full->{sha,mtime,size}), lastFullAt, result }
const MANIFEST_FULL_VERIFY_MS = 60000;
async function verifyManifest() {
  const manifestPath = path.join(externalRoot(), 'update-manifest.json');
  if (!fs.existsSync(manifestPath)) { _maniCache = null; return { present: false }; }
  try {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    const base = path.normalize(externalRoot());
    const mismatches = [];
    const newFiles = new Map();
    const forceFull = !_maniCache || _maniCache.version !== manifest.version
      || (Date.now() - (_maniCache.lastFullAt || 0)) > MANIFEST_FULL_VERIFY_MS;
    for (const entry of manifest.files || []) {
      const full = path.normalize(path.join(base, entry.path));
      if (!full.startsWith(base)) { mismatches.push({ path: entry.path, reason: 'path-escape' }); continue; }
      try {
        const st = await fsp.stat(full);
        const prev = _maniCache && _maniCache.files.get(full);
        // 快路径:非强制全量 + 文件 mtime/size 未变 + 缓存 sha 存在 -> 复用,跳过读盘+hash。
        const canSkip = !forceFull && prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.sha;
        const sha = canSkip ? prev.sha : crypto.createHash('sha256').update(await fsp.readFile(full)).digest('hex');
        newFiles.set(full, { sha, mtime: st.mtimeMs, size: st.size });
        if (sha !== entry.sha256) mismatches.push({ path: entry.path, reason: 'hash' });
      } catch {
        mismatches.push({ path: entry.path, reason: 'missing' });
      }
    }
    const result = { present: true, version: manifest.version, overlay: manifest.overlay, ok: mismatches.length === 0, mismatches };
    _maniCache = { version: manifest.version, files: newFiles, lastFullAt: Date.now(), result };
    return result;
  } catch (e) {
    _maniCache = null;
    return { present: true, ok: false, error: e.message };
  }
}

async function computeHealth(config) {
  const health = [];
  const push = (id, ok, detail) => health.push({ id, ok, detail });

  push('claude-cli', Boolean(config.claudePath && existsExecutable(config.claudePath)),
    config.claudePath || detectClaudePath() || '(not found — open Settings)');

  // Real write-probe (not fsp.access, which lies on Windows).
  let writable = false; let writeDetail = paths.data;
  try {
    const probe = path.join(paths.data, `.write-probe-${OVERLAY_ID}`);
    await fsp.writeFile(probe, 'ok'); await fsp.unlink(probe); writable = true;
  } catch (e) { writeDetail = e.message; }
  push('data-writable', writable, writeDetail);

  push('server-source', Boolean(externalServerJs()), externalServerJs() || '(running from baked exe)');
  const mcpCmd = commandForSelfMcp(config.mcpCommandMode || 'auto');
  push('mcp-target', true, `${mcpCmd.via}: ${path.basename(mcpCmd.command)} ${mcpCmd.args.join(' ')}`);
  const vendorOk = fs.existsSync(path.join(staticBase(), 'vendor', 'marked.min.js'));
  push('vendor-libs', vendorOk, vendorOk ? 'marked + highlight.js present' : 'vendor/ missing (markdown will fall back to plain text)');

  const mani = await verifyManifest();
  if (mani.present) push('overlay-integrity', Boolean(mani.ok), mani.ok ? `v${mani.version || '?'} verified` : `mismatches: ${(mani.mismatches || []).map(m => m.path).join(', ') || mani.error}`);

  return { health, manifest: mani };
}

function parseFrontmatter(raw) {
  const fm = {};
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(raw || '');
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (mm) fm[mm[1].toLowerCase()] = mm[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return fm;
}

// First real paragraph of a doc (skipping frontmatter + the # title) — used as a description when the
// toolkit files have no YAML frontmatter.
function firstParaDesc(raw) {
  const body = String(raw || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('---')) continue;
    return t.replace(/^[*_>\-]+\s*/, '').slice(0, 180);
  }
  return '';
}
function docMeta(raw) {
  const fm = parseFrontmatter(raw);
  return { name: fm.name || '', description: fm.description || firstParaDesc(raw) };
}

// Remove machine-facing frontmatter while keeping the useful workflow body for the skill detail view and
// provider-compatible command templates. The result is still treated as authored/untrusted content.
function docBody(raw, max = 12000) {
  return String(raw || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '').trim().slice(0, max);
}
function commandPrompt(raw) {
  return docBody(raw, 8000).replace(/^#\s+[^\r\n]+\r?\n+/, '').trim();
}

// v1 技能体系: 解析 SKILL.md frontmatter 的 requires 字段为能力键数组(取值同 PLAYBOOK_REQUIRES)。
// parseFrontmatter 把整行值当字符串,故支持「requires: network, vision」与「requires: [network, vision]」两写法。
function parseSkillRequires(val) {
  if (val == null) return [];
  const s = String(val).trim().replace(/^\[|\]$/g, '');
  return [...new Set(s.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(r => PLAYBOOK_REQUIRES.includes(r)))];
}

// v1 技能体系: 扫描一个 base 目录下的 <id>/SKILL.md,解析成技能条目 Map<id, entry>。用户/项目技能共用。
// frontmatter 范式仿 readClaudeProjectAgentRoles(name/description/requires);id=目录名,须过 SKILL_ID_RE(防穿越)。
// 无 frontmatter 时 name 回退目录名、description 回退首个正文段(firstParaDesc)——与内置技能同回退策略。
async function readSkillDir(baseDir, source, caps) {
  const out = new Map();
  let ents = [];
  try { ents = await fsp.readdir(baseDir, { withFileTypes: true }); } catch { return out; } // 目录不存在 → 空
  for (const d of ents) {
    if (!d.isDirectory()) continue;
    const id = d.name;
    if (!SKILL_ID_RE.test(id)) continue; // 非法/穿越名跳过
    const dir = path.join(baseDir, id);
    const file = path.join(dir, 'SKILL.md');
    let raw = '';
    try { const st = await fsp.stat(file); if (!st.isFile() || st.size > 256 * 1024) continue; raw = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const meta = docMeta(raw); // { name, description(含 firstParaDesc 回退) }
    const requires = parseSkillRequires(parseFrontmatter(raw).requires);
    const avail = evalPlaybookAvailability({ requires }, caps); // 复用 playbook 能力矩阵门控
    out.set(id, {
      id, name: (meta.name || id).slice(0, 120), description: (meta.description || '').slice(0, 400), detail: docBody(raw),
      kind: 'skill', source, dir, insert: '/' + id, requires,
      available: avail.available, unavailableReason: avail.unavailableReason,
    });
  }
  return out;
}

// v1 技能体系: 统一技能注册表。合并四源为一个数组,每项:
//   { id, name, description, kind:'skill'|'command'|'playbook', source:'builtin'|'user'|'project',
//     dir(kind=skill: SKILL.md 所在目录绝对路径,否则 ''), insert(kind=command: '/'+name),
//     requires:[], available:bool, unavailableReason:string }
// 技能同 id 优先级 project > user > builtin;命令/Playbook 各自命名空间(Playbook id 加 'pb:' 前缀防撞)。
// requires 门控复用 evalPlaybookAvailability 的能力矩阵逻辑(getCapabilities 60s 缓存)。caps 可预传避免重复探测。
async function loadSkillRegistry(cwd, config, caps) {
  if (caps === undefined) caps = await getCapabilities(config).catch(() => null);
  const out = [];
  const tk = path.join(externalRoot(), 'resources', 'plugins', 'win-workbench-offline', 'offline-toolkit');
  // ---- 技能: builtin(toolkit)→ user(dataRoot/skills)→ project(<cwd>/.ruyi/skills),后写覆盖同 id ----
  const skillMap = new Map();
  {
    const skillDir = path.join(tk, 'skills');
    for (const d of (await fsp.readdir(skillDir, { withFileTypes: true }).catch(() => []))) {
      if (!d.isDirectory() || !SKILL_ID_RE.test(d.name)) continue;
      const dir = path.join(skillDir, d.name);
      const raw = await readIfExists(path.join(dir, 'SKILL.md'), 16000);
      const meta = docMeta(raw);
      const requires = parseSkillRequires(parseFrontmatter(raw).requires);
      const avail = evalPlaybookAvailability({ requires }, caps);
      skillMap.set(d.name, {
        id: d.name, name: (meta.name || d.name).slice(0, 120), description: (meta.description || '').slice(0, 400), detail: docBody(raw),
        kind: 'skill', source: 'builtin', dir, insert: '/' + d.name, requires,
        available: avail.available, unavailableReason: avail.unavailableReason,
      });
    }
  }
  for (const [id, e] of await readSkillDir(paths.skills, 'user', caps)) skillMap.set(id, e);
  if (cwd) for (const [id, e] of await readSkillDir(path.join(path.resolve(String(cwd)), '.ruyi', 'skills'), 'project', caps)) skillMap.set(id, e);
  for (const e of skillMap.values()) out.push(e);

  // ---- 命令: builtin(toolkit commands)+ user(~/.claude/commands),沿用旧 scanSkills 的 '/'+name 语义 ----
  const seenCmd = new Set();
  const addCmd = (name, raw, src) => {
    if (!name || seenCmd.has(name)) return; seenCmd.add(name);
    const meta = docMeta(raw);
    out.push({ id: name, name: meta.name || name, description: meta.description || '', detail: docBody(raw), prompt: commandPrompt(raw), kind: 'command', source: src, dir: '', insert: '/' + name, requires: [], available: true, unavailableReason: '' });
  };
  const cmdDir = path.join(tk, 'commands');
  for (const f of (await fsp.readdir(cmdDir).catch(() => [])).filter(x => x.endsWith('.md'))) addCmd(path.basename(f, '.md'), await readIfExists(path.join(cmdDir, f), 12000), 'builtin');
  const userCmd = path.join(os.homedir(), '.claude', 'commands');
  for (const f of (await fsp.readdir(userCmd).catch(() => [])).filter(x => x.endsWith('.md'))) addCmd(path.basename(f, '.md'), await readIfExists(path.join(userCmd, f), 12000), 'user');

  // ---- Playbook: loadAllPlaybooks + evalPlaybookAvailability 映射(id 加 'pb:' 前缀防与技能/命令撞) ----
  for (const pb of (await loadAllPlaybooks().catch(() => []))) {
    const avail = evalPlaybookAvailability(pb, caps);
    out.push({
      id: 'pb:' + pb.id, name: pb.title || pb.id, description: pb.desc || '', kind: 'playbook',
      source: pb.builtin ? 'builtin' : 'user', dir: '', insert: '', requires: Array.isArray(pb.requires) ? pb.requires : [],
      available: avail.available, unavailableReason: avail.unavailableReason, playbook: pb,
    });
  }
  // 稳定排序: kind(skill<command<playbook) 再 name,供 UI 与断言确定性。
  const kindRank = { skill: 0, command: 1, playbook: 2 };
  out.sort((a, b) => (kindRank[a.kind] - kindRank[b.kind]) || String(a.name).localeCompare(String(b.name)));
  return out;
}

// v1 技能体系: 把会话启用的技能条目解析成注册表条目(仅 kind==='skill' 且 available)。供两个引擎注入用。
// P2-2: session.skills 元素为 {id, source}(或旧裸字符串)。source 非空时要求注册表条目 source 一致 —— 换 cwd
// 后同 id 项目技能顶替已启用的内置/用户技能(调包)会被此校验拦下:跳过注入,并通过 onSourceMismatch 通知一次。
function effectiveSkillSelection(session, config) {
  const resident = Array.isArray(config && config.residentSkills) ? config.residentSkills : [];
  const sessionOnly = Array.isArray(session && session.skills) ? session.skills : [];
  const out = [], seen = new Set();
  // Session selection wins on duplicate ids: it reflects the workspace in which the user most recently
  // enabled the skill, while the resident copy remains available in other sessions/workspaces.
  for (const raw of [...sessionOnly, ...resident]) {
    const id = String(typeof raw === 'string' ? raw : (raw && raw.id) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(raw);
  }
  return out;
}

async function resolveEnabledSkillEntries(session, config, cwd, caps, onSourceMismatch) {
  const enabled = effectiveSkillSelection(session, config);
  if (!enabled.length) return [];
  let registry = [];
  try { registry = await loadSkillRegistry(cwd, config, caps); } catch { return []; }
  const byId = new Map(registry.filter(e => e.kind === 'skill').map(e => [e.id, e]));
  const out = [];
  for (const raw of enabled) {
    const id = typeof raw === 'string' ? raw : String((raw && raw.id) || '');
    const source = typeof raw === 'string' ? '' : String((raw && raw.source) || '');
    const e = byId.get(id);
    if (!e || e.available === false) continue; // 缺失/不可用 → 不注入
    if (source && e.source !== source) { // 来源被调包 → 跳过注入 + 通知一次(该回合)
      if (typeof onSourceMismatch === 'function') { try { onSourceMismatch(id, source, e.source); } catch { /* 通知失败不阻断 */ } }
      continue;
    }
    out.push(e);
  }
  return out;
}

// v1 技能体系: 旧 scanSkills(仅命令/技能字面量 + '/'+name)已被 loadSkillRegistry 取代(四源统一 + dir + 能力
// 门控 + Playbook)。GET /api/skills 现走 loadSkillRegistry;命令扫描逻辑照搬进了 loadSkillRegistry 的命令段。
