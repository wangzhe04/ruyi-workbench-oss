// ── 113b: 会话内容搜索 ────────────────────────────────────────────────────────────────────────
// 摸底口径:侧栏搜索此前是纯前端子串过滤,只看 title/summary/cwd 三个字段(session-experience.js),
// 会话正文一个字都不查;`sessions/index.json` 也只是元数据缓存。用户「我上周让它改过那个文件」这类
// 回忆式查找完全做不到,而这恰恰是本地工作台最该会的事 —— 历史全在本机。
//
// 为什么这里要落盘索引,而记忆召回那边不落:记忆的检索单元就是注册表已经读进来的头部字段,重算是
// 微秒级;会话的检索单元要从可能几 MB 的 NDJSON 正文里抽,不缓存就是每次搜索把整个历史读一遍。
//
// 索引单元 = 标题 + 摘要 + 首条 user 消息 + 末尾若干条消息摘录,每会话 ≤ 4KB。失效键 =
// updatedAt + messageCount(两者都在 listSessions 的元数据里,判断失效零额外 IO)。
// 正文读取只取文件头尾两段,不整体读入 —— 一条几 MB 的会话不会因为被搜索而把内存顶起来。
const SESSION_SEARCH_INDEX_FILE = '_search-index-v1.json';
const SESSION_SEARCH_INDEX_VERSION = 1;
const SESSION_SEARCH_UNIT_CAP = 4096;      // 每会话进索引的字符上限
const SESSION_SEARCH_TAIL_MESSAGES = 6;    // 末尾取几条
const SESSION_SEARCH_HEAD_BYTES = 24 * 1024;
const SESSION_SEARCH_TAIL_BYTES = 96 * 1024;
const SESSION_SEARCH_SNIPPET_RADIUS = 60;
const SESSION_SEARCH_MAX_LIMIT = 50;
const SESSION_SEARCH_MIN_QUERY = 2;

function sessionSearchIndexPath() { return path.join(paths.sessions, SESSION_SEARCH_INDEX_FILE); }

// 只读文件的头尾两段,中间跳过。NDJSON 一行一条,所以头段丢尾巴、尾段丢头都只损失一条不完整的行。
async function readNdjsonEdges(file, headBytes, tailBytes) {
  let fh = null;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size === 0) return { head: '', tail: '' };
    fh = await fsp.open(file, 'r');
    const headLen = Math.min(st.size, headBytes);
    const headBuf = Buffer.allocUnsafe(headLen);
    await fh.read(headBuf, 0, headLen, 0);
    let tail = '';
    if (st.size > headLen) {
      const tailLen = Math.min(st.size - headLen, tailBytes);
      const tailBuf = Buffer.allocUnsafe(tailLen);
      await fh.read(tailBuf, 0, tailLen, st.size - tailLen);
      tail = tailBuf.toString('utf8');
    }
    return { head: headBuf.toString('utf8'), tail };
  } catch {
    return { head: '', tail: '' };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function parseNdjsonRows(text, { dropFirstPartial = false } = {}) {
  const lines = String(text || '').split('\n');
  if (dropFirstPartial) lines.shift();
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* 半条/坏行跳过,与会话读取侧同口径 */ }
  }
  return rows;
}

function sessionMessageText(row) {
  if (!row || typeof row !== 'object') return '';
  const content = typeof row.content === 'string' ? row.content : '';
  if (content) return content;
  // segments 型 assistant 消息:只取文本段与工具名,不展开工具结果(那是噪声,而且可能很大)。
  const segments = Array.isArray(row.segments) ? row.segments : [];
  const parts = [];
  for (const segment of segments) {
    if (!segment) continue;
    if (typeof segment.text === 'string' && segment.text) parts.push(segment.text);
    else if (segment.type === 'tool' && segment.name) parts.push(String(segment.name));
  }
  return parts.join(' ');
}

// 检索单元:标题/摘要/工作目录 + 首条 user 消息 + 末尾若干条消息。首条 user 消息是「这轮会话
// 到底要干什么」的最强信号,末尾几条是「最后落到哪」——中间的过程留给全文,不进索引。
async function buildSessionSearchUnit(meta) {
  const body = sessionBodyPaths(meta.id);
  const { head, tail } = await readNdjsonEdges(body.messages, SESSION_SEARCH_HEAD_BYTES, SESSION_SEARCH_TAIL_BYTES);
  const headRows = parseNdjsonRows(head);
  const tailRows = parseNdjsonRows(tail, { dropFirstPartial: true });
  const firstUser = headRows.find(row => row && row.role === 'user');
  const lastRows = (tailRows.length ? tailRows : headRows).slice(-SESSION_SEARCH_TAIL_MESSAGES);
  // 116-5b:线程的名字与那句概括也进检索单元。它们是模型对「这条线程到底要干什么」的概括,
  // 常常用了用户原话里没打出来的词(原话「帮我分析一下AMD」/ 概括「拉 AMD 最新行情与新闻」)——
  // 顺带提召回,而不只是显示。缺席时这两段是空串,被下面的 filter(Boolean) 丢掉,检索单元逐字节不变。
  // 索引指纹是 updatedAt|messageCount:摘要落盘走 saveSession(它会推 updatedAt),所以指纹自然会变、
  // 单元自然会重抽,不需要在这里另加一条失效判据。
  const briefUnit = sessionBriefOf(meta);
  const parts = [meta.title || '', (briefUnit && briefUnit.title) || '', (briefUnit && briefUnit.gist) || '', meta.summary || '', meta.cwd || ''];
  const seen = new Set();
  const push = value => {
    const trimmed = String(value || '').trim();
    // 短会话里“首条 user”往往也在尾部那几条里，不去重的话它会在检索单元里出现两遍，
    // 既白白抬高 tf，也让摘录看上去像复制错了。
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    parts.push(trimmed);
  };
  if (firstUser) push(sessionMessageText(firstUser));
  for (const row of lastRows) push(sessionMessageText(row));
  return parts.filter(Boolean).join('\n').replace(/\s+/g, ' ').slice(0, SESSION_SEARCH_UNIT_CAP);
}

async function readSessionSearchIndex() {
  try {
    const raw = JSON.parse(await fsp.readFile(sessionSearchIndexPath(), 'utf8'));
    if (!raw || raw.version !== SESSION_SEARCH_INDEX_VERSION || !raw.entries || typeof raw.entries !== 'object') return null;
    return raw;
  } catch {
    return null; // 缺失/损坏 = 全量重建。索引是纯派生物,没有需要抢救的权威数据。
  }
}

// 增量刷新:只为「新会话」或「updatedAt/messageCount 变了的会话」重抽单元;删掉的会话顺带清出去。
async function refreshSessionSearchIndex(metas) {
  const existing = (await readSessionSearchIndex()) || { version: SESSION_SEARCH_INDEX_VERSION, entries: {} };
  const entries = {};
  let changed = false;
  for (const meta of metas) {
    const prior = existing.entries[meta.id];
    const stamp = `${meta.updatedAt || ''}|${Number(meta.messageCount) || 0}`;
    if (prior && prior.stamp === stamp && typeof prior.unit === 'string') { entries[meta.id] = prior; continue; }
    entries[meta.id] = { stamp, unit: await buildSessionSearchUnit(meta) };
    changed = true;
  }
  if (!changed && Object.keys(existing.entries).length === Object.keys(entries).length) return entries;
  const payload = { version: SESSION_SEARCH_INDEX_VERSION, builtAt: nowIso(), entries };
  // 写失败不影响本次搜索结果(内存里的 entries 已经算好了),下次再试。
  await atomicWriteJson(sessionSearchIndexPath(), payload).catch(() => {});
  return entries;
}

// 摘录:定位第一个命中的查询词,取前后各若干字符。出服务端前过 redact() —— 与 /api/audit 同一条
// 脱敏路径,会话正文里粘过的 key/token 不会因为「搜了一下」就漏到响应里。
function sessionSearchSnippet(unit, terms) {
  const source = String(unit || '');
  const lower = source.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = at < 0 ? 0 : Math.max(0, at - SESSION_SEARCH_SNIPPET_RADIUS);
  const end = Math.min(source.length, start + SESSION_SEARCH_SNIPPET_RADIUS * 3);
  const slice = source.slice(start, end);
  return redact((start > 0 ? '…' : '') + slice + (end < source.length ? '…' : ''));
}

async function searchSessionsByContent(query, limit) {
  const q = String(query || '').trim();
  if (q.length < SESSION_SEARCH_MIN_QUERY) return { ok: true, query: q, results: [], indexed: 0, reason: 'query_too_short' };
  const metas = await listSessions();
  const entries = await refreshSessionSearchIndex(metas);
  const byId = new Map(metas.map(meta => [meta.id, meta]));

  const documents = metas
    .filter(meta => entries[meta.id])
    .map(meta => ({ id: meta.id, text: entries[meta.id].unit }));
  if (!documents.length) return { ok: true, query: q, results: [], indexed: 0 };

  // L0 词法:子串命中(保住今天的直觉 —— 打出完整词就该排最前);L1 向量:同义/拼写漂移兜底。
  const terms = [...new Set(retrievalTerms(q).filter(term => !term.startsWith('#')))];
  const lexical = [];
  for (const doc of documents) {
    const hay = doc.text.toLowerCase();
    let hits = 0;
    for (const term of terms) if (hay.includes(term)) hits += Math.min(12, Math.max(2, term.length));
    if (hits > 0) lexical.push({ id: doc.id, hits });
  }
  lexical.sort((a, b) => b.hits - a.hits || String(a.id).localeCompare(String(b.id)));

  const corpus = buildRetrievalCorpus(documents);
  const vector = rankRetrievalCorpus(corpus, q);

  const fused = reciprocalRankFusion([lexical.map(row => row.id), vector.map(row => row.id)]);
  const ranked = [...fused.entries()]
    .map(([id, score]) => ({ id, score, meta: byId.get(id) }))
    .filter(row => row.meta)
    // 同分时按最近更新排前:搜索历史时「最近的那次」几乎总是想要的那次。
    .sort((a, b) => b.score - a.score
      || String(b.meta.updatedAt || '').localeCompare(String(a.meta.updatedAt || ''))
      || String(a.id).localeCompare(String(b.id)));

  const cap = Math.min(SESSION_SEARCH_MAX_LIMIT, Math.max(1, Number(limit) || 20));
  return {
    ok: true,
    query: q,
    indexed: documents.length,
    results: ranked.slice(0, cap).map(row => ({
      id: row.id,
      title: row.meta.title || '',
      // 116-5b(§11.8.5):线程的名字与一句概括。**缺席时这两个键不出现** —— 存量会话的
      // /api/sessions/search 载荷逐字节不变。title 仍是原话(它是权威,也是 hover 全文与回退)。
      // 加在这里而不是让调用方自己去 /api/sessions 里 join:这条响应从此自足,
      // 只拿到搜索结果的消费者(经典壳搜索、将来的任何面)不必再取一次会话列表。
      ...(sessionBriefOf(row.meta) ? { briefTitle: sessionBriefOf(row.meta).title, briefGist: sessionBriefOf(row.meta).gist } : {}),
      cwd: row.meta.cwd || '',
      updatedAt: row.meta.updatedAt || '',
      pinned: Boolean(row.meta.pinned),
      messageCount: Number(row.meta.messageCount) || 0,
      score: Number(row.score.toFixed(6)),
      snippet: sessionSearchSnippet(entries[row.id].unit, terms),
    })),
  };
}

async function handleSessionApiRoutes(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/sessions') {
    return send(res, json({ ok: true, sessions: await listSessions() }));
  }
  // 113b: 会话内容搜索。GET /api/sessions/search?q=&limit=
  // 必须排在下面那条 pathname.startsWith('/api/sessions/') 的通配分支【之前】，
  // 否则 'search' 会被当成会话 id 拿去查。
  if (req.method === 'GET' && pathname === '/api/sessions/search') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (!sessionSearchIndexEnabled(config)) {
      // 走 apiFailure 而不是裸字符串 error：后者会被 normalizeApiErrorPayload 归结成
      // api.request_failed，真正的 code 降级成 message，调用方就分不出“关了”和“坏了”。
      // 118 波在 help.doc_missing 上栓过同一个坑。状态码给 200：它不是错误，只是能力关着。
      return send(res, apiFailure('session_search.disabled', {}, 'session search index is disabled', 200));
    }
    const params = new URL(req.url, 'http://x').searchParams;
    return send(res, json(await searchSessionsByContent(params.get('q') || '', params.get('limit'))));
  }
  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readJsonBody(req);
    return send(res, json({ ok: true, session: await createSession(body) }));
  }
  // Bulk history cleanup is intentionally narrower than the single-session DELETE endpoint: it only
  // clears unpinned sessions and can preserve the currently open session supplied by the UI.
  if (req.method === 'POST' && pathname === '/api/sessions/bulk-delete') {
    const body = await readJsonBody(req);
    return send(res, json(await bulkDeleteUnpinnedSessions({
      preserveSessionId: body && body.preserveSessionId,
      purgeAssociated: Boolean(body && body.purgeAssociated),
    })));
  }
  if (pathname.startsWith('/api/sessions/')) {
    const id = path.basename(pathname); // guards traversal
    if (req.method === 'GET') {
      const session = await loadSession(id);
      if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
      // v0.8-S0 A6: surface whether the last turn dangles (arrested mid-flight) so the UI can offer resume.
      // 运行中豁免:活回合/活 agent run 在跑时,providerHistory 尾部恰好就是 detectDanglingTurn
      // 判悬挂的形状(user 尾/tool 尾/未答 tool_calls)——切到还在正常跑的会话不能弹「未正常结束」
      // 横幅,故 live 会话直接返回不悬挂。
      let live = activeChildren.has(id);
      if (!live) {
        for (const runtime of activeAgentRuns.values()) {
          if (runtime && runtime.run && runtime.run.sessionId === id) { live = true; break; }
        }
      }
      // 117l-A1-fix2(§11.9;B1 实现抽屉时发现,主会话核对源码):抽屉 steward-drawer.js 的
      // isLive() 第一判据是 `resumable && resumable.live === true`,而这个活回合分支修前没有
      // `live` 键,那条判据从没走通过,一直静默回落到「事项行五态 === 'running'」——挂在
      // request_user_input 上等答案的回合五态是 needs_you,于是被判成不在跑,抽屉的轮询节拍
      // (活 5s／闲 15s)与 activitySnapshot 都跟着错。只加这一个键;detectDanglingTurn 那一支
      // (真正判悬挂的形状)一个字不动。
      const resumable = live
        ? { dangling: false, kind: null, turnSeq: Math.max(0, Number(session.turnSeq) || 0), historyLength: Array.isArray(session.providerHistory) ? session.providerHistory.length : 0, live: true }
        : detectDanglingTurn(session);
      // 117l D4(§11.9;用户第四轮走查第 3 条):活回合的尾巴。只在【真有一个活回合】时出现
      // (回合一结束这个键就不在了 —— 抽屉据此把「它正在说」换回「它刚说」),不落盘、不进任何投影。
      // 放在【信封】上而不往 session 里塞:与下面 displayTitle 同一条纪律(路由不改写会话头本身)。
      // 117m-A5(用户第六轮走查①「点开线程的看全文,还是啥也看不到」):同一个信封上再多带四个键 ——
      // full(本回合从头累加的正文,04 里硬顶 12000 字、超顶砍头)、truncated、tools(最近 ≤20 条工具名
      // 与起止,**不含参数与结果**)、startedAt/iterations。经典壳据此在会话末尾画一张临时气泡,
      // 让「在别处起的回合」也看得到它现在在说什么。仍然是【条件展开】:回合一结束这个键就不在了。
      // 白名单式逐字段搬运,不 spread reg 上那份对象 —— 累加器上还有 batchMark/lastKind 这类内部游标,
      // tools 里还有工具调用 id,都不该出现在信封上。
      const liveReg = activeChildren.get(id);
      const liveTail = liveReg && liveReg.liveTail && typeof liveReg.liveTail === 'object'
        ? {
          text: String(liveReg.liveTail.text || ''), tool: String(liveReg.liveTail.tool || ''), updatedAt: String(liveReg.liveTail.updatedAt || ''),
          full: String(liveReg.liveTail.full || ''),
          truncated: Boolean(liveReg.liveTail.truncated),
          startedAt: String(liveReg.liveTail.startedAt || ''),
          iterations: Math.max(0, Number(liveReg.liveTail.iterations) || 0),
          tools: (Array.isArray(liveReg.liveTail.tools) ? liveReg.liveTail.tools : []).slice(-20).map(row => ({
            name: String((row && row.name) || '').slice(0, 80),
            status: String((row && row.status) || ''),
            startedAt: String((row && row.startedAt) || ''),
            endedAt: String((row && row.endedAt) || ''),
          })),
        }
        : null;
      // 117o-A7(用户第七轮走查,两张截图对照:「为啥这个查看全文,不能像 2.0 那样显示呢」):
      // 同一个信封上【再加一个新键】liveTurn —— 在途回合的有序叙事账本(02c 的 createTurnSegmentBuilder,
      // 回合落盘之后经典壳重建叙事靠的就是它)。A5 的 liveTail 只是一段拼好的纯文本,渲染层再怎么写
      // 也画不出思考块 / 过程记录 / 工具卡,差距的根子是数据形状。前端拿到它以后组装成一条与落盘助手
      // 消息同形的对象,交给【渲染落盘助手消息的同一个入口】去画,不写第二套简版渲染器。
      // 三条纪律:① 上面 liveTail 那几个键一个字不动(抽屉的「它正在说」在读它,117l/117m 的断言看着它),
      // 新键是【加】不是改;② 有界与截断方向都在 02c 的 liveSnapshot() 里(段数/单段/总文本三重硬顶,
      // 超顶从头部丢弃并置 truncated:true);③ **工具结果一律不下发** —— 只送 name 与那一行参数摘要,
      // 结果可能是整份文件、可能含密钥;回合一结束真消息落盘,经典壳照常拿到全部(e2e 的 E 段钉着这条)。
      const liveNarrative = liveReg && liveReg.liveSegments && typeof liveReg.liveSegments.liveSnapshot === 'function'
        ? liveReg.liveSegments.liveSnapshot()
        : null;
      const liveTurn = liveNarrative
        ? {
          segments: Array.isArray(liveNarrative.segments) ? liveNarrative.segments : [],
          toolCalls: Array.isArray(liveNarrative.toolCalls) ? liveNarrative.toolCalls : [],
          truncated: Boolean(liveNarrative.truncated),
          startedAt: liveTail ? liveTail.startedAt : '',
          iterations: liveTail ? liveTail.iterations : 0,
        }
        : null;
      // 116-4（27 号文 §11.7 第 3 项「唤醒链诚实」）：GET /api/sessions/steward?since=<ISO> 只回
      // 该时刻【之后】的消息。117b 的轮询发现 state.lastReply.at 变了（trigger:'inbox'）之后要把新
      // 回合追加进对话流，整份拉一遍管家会话在长会话上是几百 KB 的重复载荷。
      // 纪律：① 只对管家会话生效 —— 别的会话有自己的分页语义，不在本波范围；② 不带 since 的旧调用
      // 逐字节不变（没有这个参数就走原路，一行都不改）；③ 只切 messages 的尾巴，其余字段原样带出，
      // 前端拿到的仍是同一个形状；④ 不改会话对象本身（浅拷贝），loadSession 的返回值不许被路由改写。
      const sinceRaw = id === STEWARD_SESSION_ID ? new URL(req.url, 'http://x').searchParams.get('since') : null;
      const sinceMs = sinceRaw ? Date.parse(String(sinceRaw)) : NaN;
      if (Number.isFinite(sinceMs)) {
        const all = Array.isArray(session.messages) ? session.messages : [];
        const tail = all.filter(m => {
          const at = Date.parse(String((m && m.createdAt) || ''));
          return Number.isFinite(at) && at > sinceMs;
        });
        return send(res, json({ ok: true, session: { ...session, messages: tail }, resumable, since: String(sinceRaw), messageCount: all.length, ...(liveTail ? { liveTail } : {}), ...(liveTurn ? { liveTurn } : {}) }));
      }
      // 116-5b(§11.8.5):这条线程该显示什么名字,由 02 的 sessionDisplayTitle 一处判定。
      // 放在【信封】上而不是往 session 里塞:session 就是会话头本身,路由不许改写它的形状
      // (上面 since 分支那条「不改会话对象本身」是同一条纪律);抽屉/「现在这一件」的标题读这个键。
      return send(res, json({ ok: true, session, resumable, displayTitle: sessionDisplayTitle(session), ...(liveTail ? { liveTail } : {}), ...(liveTurn ? { liveTurn } : {}) }));
    }
    if (req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'PATCH')) {
      const body = await readJsonBody(req);
      // 116-3 A2:管家会话不是线程 —— 它没有权限档、没有标题重命名语义,元数据一律不许经这条通用
      // 路由改(GET 保留:117c 的历史渲染要读它)。与 10 的回合入口那道门同一条纪律:管家会话的写面
      // 只有管家运行器自己。
      if (id === STEWARD_SESSION_ID) {
        return send(res, apiFailure('steward.forbidden', {}, 'the steward session cannot be patched through /api/sessions', 403));
      }
      // 116-2a(27 号文 §3.3/§8.6「每条线程一个权限 chip、点开即换、立即生效」):线程级权限就地快切。
      // 与 engineRoute 同端点、同风格(它是会话级字段的既有先例)。两道门:
      //   ① 白名单 —— 非 PERMISSION_MODES 的值 400,绝不悄悄回落(用户按了一个档,系统却按另一个档跑,
      //      是第 78 波注释里点名的那类事故);null/'' 是【合法】的,意思是「清除会话级设置,回落全局」。
      //   ② 二次确认 —— 切到全自动必须显式 confirm:true,否则 409。这是 §8.6 那条弹窗要求的服务端一半:
      //      服务端不能只信 UI 弹过窗,任何调用方(脚本/117 壳/未来的管家 UI)都得过这道门。
      //      收紧与清除不需要确认。
      if (body && Object.prototype.hasOwnProperty.call(body, 'permissionMode')) {
        const requested = body.permissionMode == null ? '' : String(body.permissionMode);
        if (requested !== '' && !PERMISSION_MODES.includes(requested)) {
          return send(res, apiFailure('session.invalid_permission_mode', { permissionMode: requested, allowed: PERMISSION_MODES },
            `permissionMode must be one of ${PERMISSION_MODES.join('/')}, or null/"" to follow the global default`, 400));
        }
        if (PERMISSION_MODES_REQUIRING_CONFIRM.includes(requested) && body.confirm !== true) {
          return send(res, apiFailure('permission.confirm_required', { permissionMode: requested },
            'switching a thread to full-auto requires an explicit confirm:true (it can change files and run commands while you are away)', 409));
        }
      }
      const session = await updateSessionMeta(id, body);
      if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
      const patchedConfig = await readConfig();
      // 审计:权限档是安全面,每一次改动都要能事后对账(谁、哪条线程、从哪档到哪档、生效档是什么)。
      if (body && Object.prototype.hasOwnProperty.call(body, 'permissionMode')) {
        logEvent({
          kind: 'session', source: 'permission_mode', sessionId: id,
          permissionMode: sessionMeta(session).permissionMode,
          effectivePermissionMode: resolvePermissionMode({ session, config: patchedConfig }),
          confirmed: body.confirm === true,
        });
      }
      // 既有形状只加不改:`session` 原样保留(既有断言与前端都读它),额外带一份 sessionMeta —— 它是
      // 权限 chip 要的两个字段(会话级 permissionMode / 派生 effectivePermissionMode)的唯一读形。
      return send(res, json({ ok: true, session, sessionMeta: sessionMeta(session, patchedConfig) }));
    }
    if (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE')) {
      return send(res, json(await deleteSession(id)));
    }
  }
  return false;
}

// ============================================================================
// 第70波(EC-E Mission Ready 首切片):/api/missions 聚合只读投影。
// 纪律:①纯读模型 —— 不复制第二套执行状态机,快照全部从既有权威源(mission 账本 / run 快照 /
// checkpoint journal / usage 月度账本 / 内存 pending 注册表)现算;②旧会话适配只读派生(sessionKind),
// 绝不回写磁盘;③列表只读会话头文件(<id>.json 含 mission,不触 messages/provider 正文),详情才全量加载。
// ============================================================================

// 卡片/快照共用的状态派生:complete(全部里程碑 done) > active(until-done 驱动中) > paused(supervised =
// 预算耗尽/停滞/用户接管后的待命态) > idle(off 且未完成)。mission 缺失时不应出现在任务列表('none')。
function missionCardStatus(m) {
  if (!m) return 'none';
  const ms = Array.isArray(m.milestones) ? m.milestones : [];
  if (ms.length > 0 && ms.every(x => x && x.status === 'done')) return 'complete';
  if (m.autoMode === 'until-done') return 'active';
  if (m.autoMode === 'supervised') return 'paused';
  return 'idle';
}

// 未决事项统一读形(第71b:四源统一 —— permission/question/plan/pool 全部从 session.interventions NDJSON 现算)。
// 前三者此前是纯内存 Map(04-permission-runtime:191/194/199),重启即归零;71 波旁路持久化为 Intervention(02
// append-only NDJSON),重启终态化(markInterruptedInterventions)后 pending 标 cancelled_restart -> 计数归零。
// 71b 池提案统一进来:paused run 的提案恢复后仍可审批,boot 对账补登记 + markInterruptedInterventions 按 run
// 状态分流保留 pending(见 02/08);run 快照扫描仅作并集兜底(append 落盘延迟 + 对账前存量),按 id 去重不双计。
async function missionPendingCounts(sessionId, runs, interventions) {
  const ivs = Array.isArray(interventions) ? interventions : await readInterventions(sessionId).catch(() => []);
  let permissions = 0, questions = 0, plans = 0, pool = 0;
  const poolPendingIds = new Set();
  for (const iv of ivs) {
    if (!iv || iv.status !== 'pending') continue;
    if (iv.type === 'permission') permissions++;
    else if (iv.type === 'question') questions++;
    else if (iv.type === 'plan') plans++;
    else if (iv.type === 'pool') { pool++; poolPendingIds.add(String(iv.id)); }
  }
  for (const r of (runs || [])) for (const item of ((r && r.taskPool) || [])) {
    if (item && item.status === 'proposed' && !poolPendingIds.has(String(item.id))) { pool++; poolPendingIds.add(String(item.id)); }
  }
  return { permissions, questions, plans, pool };
}

function clipMissionRunText(value, max = 360) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function lastMissionRunProgress(node) {
  const rows = Array.isArray(node && node.progressLog) ? node.progressLog : [];
  for (let index = rows.length - 1; index >= 0; index--) if (rows[index]) return rows[index];
  return null;
}

// 第82波班组图只消费这份精简节点投影。节点结果、角色快照、工具证据等大字段仍留在 Agent Run
// 权威文件；Mission 详情只带画图和递话资格所需事实，避免复制运行状态机或把 24KB result 带进任务单。
function missionRunGraph(src, live) {
  const nodes = Array.isArray(src && src.nodes) ? src.nodes : [];
  // 第98波(P5-A):真实调度波次 -- 按并发上限+wait 模拟派发,下发给前端班组图分列(替代纯拓扑层)。
  const waveSeq = computeWaveSeq(nodes, {
    concurrency: Number(src && src.concurrency) || 1,
    isWaitNode: n => !!(n && n.wait),
  });
  return {
    nodes: nodes.map(node => {
      // Read backwards instead of cloning/filtering a potentially long progress history on every Preview poll.
      const progress = lastMissionRunProgress(node);
      const eligibility = live
        ? nodeDeliveryEligibility(src, String(node && node.id || ''), { allowClaude: true })
        : { ok: false, reason: 'not_live' };
      return {
        id: String(node && node.id || ''),
        status: String(node && node.status || ''),
        roleId: String(node && (node.roleId || node.role) || ''),
        roleLabel: clipMissionRunText(node && node.roleLabel, 80),
        task: clipMissionRunText(node && node.task, 520),
        dependsOn: Array.isArray(node && node.dependsOn) ? node.dependsOn.map(value => String(value || '')).filter(Boolean).slice(0, 16) : [],
        engine: String(node && node.engine || ''), model: clipMissionRunText(node && node.model, 100),
        progress: clipMissionRunText(progress && progress.text, 220),
        startedAt: String(node && node.startedAt || ''), completedAt: String(node && node.completedAt || ''),
        fromPool: node && node.fromPool === true, proposedBy: String(node && node.proposedBy || ''),
        deterministic: Boolean(node && node.gate && ['vote', 'dedupe', 'coverage', 'propagate'].includes(node.gate.mode)),
        steerable: eligibility.ok === true, steerReason: String(eligibility.reason || ''),
        ...(waveSeq.has(String(node && node.id || '')) ? { wave: waveSeq.get(String(node && node.id || '')) } : {}),
      };
    }),
    proposals: (Array.isArray(src && src.taskPool) ? src.taskPool : [])
      .filter(item => item && item.status === 'proposed')
      .map(item => ({
        id: String(item.id || ''), status: 'proposed', proposedBy: String(item.proposedBy || ''),
        task: clipMissionRunText(item.task, 520), reason: clipMissionRunText(item.reason, 220),
        roleId: String(item.roleId || ''),
        dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(value => String(value || '')).filter(Boolean).slice(0, 16) : [],
      })),
  };
}

// run 摘要投影(对齐 /api/agent-runs?view=digest 的标量集 + 用量字段;live run 以内存为准)。
// includeGraph 仅供单 Mission 详情使用；300 Mission 列表和 75c 索引继续保持标量热路。
function missionRunDigest(r, includeLive = true, includeGraph = false) {
  const live = includeLive ? activeAgentRuns.get(r.id) : null;
  const mem = live && live.run ? live.run : null;
  const src = mem || r;
  const digest = {
    id: src.id, status: src.status, eventSeq: Number(src.eventSeq) || 0,
    createdAt: src.createdAt || '', updatedAt: src.updatedAt || '', completedAt: src.completedAt || '',
    nodeCount: Array.isArray(src.nodes) ? src.nodes.length : 0,
    poolPending: ((src.taskPool) || []).filter(p => p && p.status === 'proposed').length,
    live: !!live, paused: !!(live && live.paused), resumeTier: src.resumeTier || '',
    totalTokens: Number(src.totalTokens) || 0, costUsd: Number(src.costUsd) || 0,
  };
  if (includeGraph) Object.assign(digest, missionRunGraph(src, live));
  return digest;
}

// 列表卡片:从会话头文件投影(头含 mission,见 saveSession 头/正文拆分)。
async function buildMissionCard(head, runs, opts = {}) {
  // 116-4 第 0 步（复现出来的根因）：kind 是 'mission' 但头上【没有】mission 容器的会话是
  // 真实形状 —— steward_thread_new 建线程时显式写 kind='mission'，mission 容器要等
  // /api/mission start 才有。修前这里 m.goal 直接读 null，而 buildPretenderSessionSlice 没有
  // try，rebuildPretenderIndexFull 的 Promise.all 整份 reject：GET /api/missions、/api/missions/<id>、
  // GET /api/interventions 全部 500，收件箱每轮 tick 抛 "Cannot read properties of null (reading 'goal')"
  // 三个源一起停摆 —— 这正是「线程跑完管家没被唤醒」的第一层根因。
  // missionCardStatus(null) 早就返回 'none'（故它仍收 m 而不是 mm，否则 {} 会变成 'idle'）——
  // 本函数其余部分本来就是按「可能没有 mission」写的，只有下面那一段漏了守卫。
  const m = head.mission;
  const mm = (m && typeof m === 'object') ? m : {};
  const ms = Array.isArray(mm.milestones) ? mm.milestones : [];
  return {
    sessionId: head.id, missionId: sessionMissionId(head), title: head.title || '', cwd: head.cwd || '', kind: 'mission',
    // 116-5b(§11.8.5):这条线程该显示什么名字,由 02 的 sessionDisplayTitle 一处判定(人起的 >
    // 生成的 > 原话),前端只读结果不再算一遍 —— 与本行已有的 stateLabel / missionTitle / wait.label
    // 同一条纪律(读模型里本来就有一批服务端算好的显示串)。title 保持原话不动。
    // brief 单独带出是为了那句 gist(名字之外还要一句人话概括,抽屉与搜索结果要用);缺席时不出现。
    displayTitle: sessionDisplayTitle(head),
    // 117l D4(§11.9):最后一句助手原话的头部(= head.summary,09 收尾处写的前 160 字,不经模型改写)。
    // 看板行的「它在问你」要判「末句是不是问号」,而 13e 的活叠加层只拿得到卡片 —— 没这一个字段就只能
    // 每行再读一次会话头。只是会话头已有字段的投影,不新增任何持久化来源。
    // **注意截断**:summary 只有 160 字,长回复的末句问号会被截掉 —— 漏报是安全的(不会把不是问句
    // 的说成问句),完整判定在 steward_thread_status(那里会话正文已装载)。
    lastSay: String(head.summary || ''),
    ...(sessionBriefOf(head) ? { brief: sessionBriefOf(head) } : {}),
    createdAt: head.createdAt || '', updatedAt: head.updatedAt || '',
    status: missionCardStatus(m),
    // 117p-S2(30 号文 §8.3):五态判据需要的两个卡片字段 —— 都只是会话头已有字段的投影,不新增
    // 持久化来源(与 lastSay / displayTitle 同一条纪律)。缺了它们,两份五态抄写件只能把 turnSeq
    // 硬编码成 0,于是「跑过回合但头上没有 mission 账本」的管家线程永远落不进 done/stopped。
    turnSeq: Math.max(0, Number(head.turnSeq) || 0),
    lastTurn: head.stewardLastTurn && typeof head.stewardLastTurn === 'object'
      ? { seq: Math.max(0, Number(head.stewardLastTurn.seq) || 0), ok: head.stewardLastTurn.ok !== false, aborted: head.stewardLastTurn.aborted === true }
      : null,
    activeTurn: opts.persistent ? false : activeChildren.has(head.id), // 75c:live overlay 不写进可重建持久索引
    mission: {
      goal: mm.goal || '', createdAt: mm.createdAt || '', updatedAt: mm.updatedAt || '',
      autoMode: mm.autoMode || 'off',
      milestonesTotal: ms.length,
      done: ms.filter(x => x && x.status === 'done').length,
      blocked: ms.filter(x => x && x.status === 'blocked').length,
      pending: ms.filter(x => !x || x.status === 'pending').length,
      budget: mm.budget || { maxAutoTurns: 0, maxTokens: 0 },
      spent: mm.spent || { autoTurns: 0, tokens: 0 },
      budgetExhausted: Boolean(mm.budgetExhaustedAt),
      // 第72波:结果章存根(列表卡片只带状态+时间,明细走详情快照 result)
      result: (mm.result && typeof mm.result === 'object') ? { status: mm.result.status || '', finishedAt: mm.result.finishedAt || '' } : null,
    },
    pending: await missionPendingCounts(head.id, runs, opts.interventions),
    runCount: (runs || []).length,
    lastRun: runs && runs.length ? missionRunDigest(runs[runs.length - 1], !opts.persistent) : null,
  };
}

// ── 第 116 波 116g(27 号文 §3.1 / §8.10):事项级聚合读模型 ─────────────────────
// 一处装配,两处消费(GET /api/missions 的只加字段、13g 的 steward_missions 工具)。纪律与 70 波
// /api/missions 同源:**纯读模型** —— 线程五态取投影 card(与看板逐字节同源),事项级状态只经 06i 的
// `aggregateMissionState` 纯函数,绝不在这里另写一份判据;没有事项文件的 missionId 按需派生
// (`derived:true`,标题取会话标题),不落盘、不回写、不迁移。

// 02 事项容器的稳定信封 error -> HTTP 状态。事项/线程找不到是 404,容量满是 409(可重试的资源
// 约束,不是请求写错了),其余一律 400。表在这里而不在域侧:域函数不认识 HTTP。
function missionContainerHttpStatus(error) {
  if (error === 'not_found' || error === 'session_not_found') return 404;
  if (error === 'capacity_exceeded') return 409;
  return 400;
}
// 失败信封统一走 P2 的 apiFailure(code/params/message)—— 直接把 { ok:false, error:'字符串' } 送进
// json() 会被 normalizeApiErrorPayload 归一成 code:'api.request_failed',错误码就丢了。
const MISSION_FAILURE_PARAM_KEYS = ['limit', 'count', 'missionId', 'sessionId'];
function missionContainerFailure(result) {
  const params = {};
  for (const key of MISSION_FAILURE_PARAM_KEYS) if (result && result[key] !== undefined) params[key] = result[key];
  return apiFailure('mission.' + String((result && result.error) || 'failed'), params,
    String((result && result.message) || ''), missionContainerHttpStatus(result && result.error));
}

function emptyMissionCostBucket() {
  return { turns: 0, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} };
}
function addMissionCostBucket(bucket, usage) {
  if (!usage || typeof usage !== 'object') return bucket;
  bucket.turns += Number(usage.turns) || 0;
  bucket.inTok += Number(usage.inTok) || 0;
  bucket.outTok += Number(usage.outTok) || 0;
  bucket.cachedInTok += Number(usage.cachedInTok) || 0;
  for (const [currency, amount] of Object.entries(usage.costsByCurrency || {})) {
    if (!Number.isFinite(Number(amount))) continue;
    bucket.costsByCurrency[currency] = Math.round(((bucket.costsByCurrency[currency] || 0) + Number(amount)) * 1e6) / 1e6;
  }
  return bucket;
}

async function buildMissionAggregateRows(options = {}) {
  const includeArchived = options.includeArchived === true;
  const index = await getPretenderProjectionIndex().catch(() => null);
  const slices = new Map(((index && index.sessions) || []).map(row => [row.sessionId, row]));
  const metas = await listSessions().catch(() => []);          // 管家会话已在 listSessions 里滤掉
  const containers = await listMissionContainers().catch(() => []);
  const containerById = new Map(containers.map(row => [row.missionId, row]));
  const byMissionId = new Map();

  const ensure = (missionId, container) => {
    let group = byMissionId.get(missionId);
    if (!group) byMissionId.set(missionId, group = { missionId, container: null, threads: [], cost: emptyMissionCostBucket() });
    if (container && !group.container) group.container = container;
    return group;
  };
  for (const container of containers) {
    if (container.archivedAt && !includeArchived) continue;
    ensure(container.missionId, container);
  }
  for (const meta of metas) {
    const missionId = meta.missionId || meta.id;
    const container = containerById.get(missionId) || null;
    if (container && container.archivedAt && !includeArchived) continue;
    const group = ensure(missionId, container);
    const slice = slices.get(meta.id) || null;
    const card = slice ? overlayMissionCard(slice) : null;
    // 五态的三条取值路径,与 13g steward_thread_status 逐字一致(同一条线程在看板与管家里必须同色):
    //   ① 有投影卡片 -> fromCard(与 /api/missions 的卡片同源);
    //   ② 没卡片但是 mission 会话(投影还没赶上这条新会话)-> 按会话头现算,入参与 thread_status 相同
    //      —— 少喂 turnSeq 会把一条跑过回合的线程说成「交办中」,和 thread_status 的「已停工」打架;
    //   ③ 速问会话 -> kind 一个字段就短路(mission-state.js 第一条分支),不必读头文件。
    let derived;
    if (card) derived = stewardThreadStateFromCard(card);
    else if (meta.kind === 'mission') {
      const head = await readMissionSessionHead(meta.id);
      derived = deriveStewardThreadState({
        kind: 'mission',
        autoMode: head && head.mission && head.mission.autoMode,
        resultStatus: (head && head.mission && head.mission.result && head.mission.result.status) || '',
        pending: await missionPendingCounts(meta.id, [], null).catch(() => null),
        activeTurn: activeChildren.has(meta.id),
        runCount: 0,
        turnSeq: head && head.turnSeq,
        // 117p-S2:与 13g thread_status / 13h 总览同一条投影 —— 无账本判据只认「头上没有 mission 容器」,
        // 与卡片侧 card.status === 'none' 同义;不许拿 milestonesTotal === 0 之类的近似顶替。
        ledgerless: !(head && head.mission),
        lastTurnFailed: !!(head && head.stewardLastTurn && (head.stewardLastTurn.ok === false || head.stewardLastTurn.aborted === true)),
      });
    } else derived = deriveStewardThreadState({ kind: 'quick_ask' });
    group.threads.push({
      sessionId: meta.id,
      title: stewardSanitizeText(meta.title || ''),
      // 116-5b:同 buildMissionCard —— title 仍是原话,显示名另给一个键(steward_missions 的线程清单、
      // 抽屉页签、看板行都读它)。meta 是索引条目形态(brief/titleSource),sessionDisplayTitle 两形态都认。
      displayTitle: stewardSanitizeText(sessionDisplayTitle(meta)),
      ...(sessionBriefOf(meta) ? { brief: sessionBriefOf(meta) } : {}),
      kind: meta.kind || 'quick_ask',
      state: derived.state,
      stateLabel: derived.label,
      permissionMode: meta.permissionMode || null,
      lastAssistantText: stewardSanitizeText(meta.summary || '').slice(0, 120),
      updatedAt: String(meta.updatedAt || ''),
      // 116h(§8.10「排队可解释」):等待原因由 06i 的 waitReasonFor 单点判定,与 steward_thread_status /
      // 总览行 / steward_missions 同一函数同一形状。pending 用上面五态判据已经算好的那一份(少喂一次
      // 就会出现 116g 那种「看板与 thread_status 各说各话」);仲裁器一侧同步只读,开关关时恒为 null。
      wait: waitReasonFor(
        { pending: (derived.sources && derived.sources.pendingTotal) || 0 },
        typeof StewardHooks.arbiterWait === 'function' ? StewardHooks.arbiterWait(meta.id) : null,
      ),
    });
    addMissionCostBucket(group.cost, slice && slice.usage);
  }

  const rows = [];
  const rowBySessionId = new Map();
  for (const group of byMissionId.values()) {
    const container = group.container;
    const acceptanceItems = container ? container.acceptance : [];
    group.threads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const row = {
      missionId: group.missionId,
      // 未归类事项没有事项文件,标题只能从它唯一那条线程的会话标题派生(§3.1「不改写历史」)。
      // 116-5b:派生用的是那条线程的【显示名】而不是原话 —— 这个字段本来就是一个派生出来的显示串
      // (真事项走 container.title),不是权威数据;线程的原话仍在 threads[].title 里原样躺着。
      title: container ? container.title : ((group.threads[0] && (group.threads[0].displayTitle || group.threads[0].title)) || group.missionId),
      goal: container ? container.goal : '',
      derived: !container,
      archivedAt: (container && container.archivedAt) || '',
      cwd: container ? container.cwd : '',
      aggregateState: aggregateMissionState(group.threads.map(thread => thread.state)),
      threadCount: group.threads.length,
      threads: group.threads,
      acceptance: {
        done: acceptanceItems.filter(item => item.done).length,
        total: acceptanceItems.length,
        items: acceptanceItems,
      },
      budget: container ? container.budget : {},
      cost: group.cost,
      createdAt: container ? container.createdAt : ((group.threads[group.threads.length - 1] && group.threads[group.threads.length - 1].updatedAt) || ''),
      updatedAt: container ? container.updatedAt : ((group.threads[0] && group.threads[0].updatedAt) || ''),
    };
    rows.push(row);
    for (const thread of group.threads) rowBySessionId.set(thread.sessionId, row);
  }
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  // 事项文件不在 75c 物化索引的 sourceStamp 覆盖面内(它们不是会话文件),所以 ETag 必须自己带上
  // 它们的指纹 —— 否则 PATCH 完验收项、再带 If-None-Match 来读会拿到 304 + 陈旧的 acceptance。
  // 117h 第 0 步:行上新增的 missionTitle / goal / acceptanceItems 都由容器字段直出,所以指纹要把
  // 它们一并纳入 —— 光靠 updatedAt 依赖「每次改都会动 updatedAt」这条隐含约定,写进指纹才是自证的。
  const stamp = pretenderHash(containers.map(row => [
    row.missionId, row.updatedAt, row.archivedAt || '', row.title || '', row.goal || '',
  ]));
  return { rows, rowBySessionId, stamp };
}

// /api/missions 的行是【线程行】(每个 mission 会话一张卡,70 波起如此,前端静态锁按它冻结)。
// 116g 只在每行【追加】它所属事项的聚合事实,既有字段与顺序一个不动。
function overlayMissionAggregateFields(card, row) {
  if (!card) return card;
  // row 缺失 = 这张卡片的会话在 listSessions 的元数据里没有对应行(索引与投影之间的瞬时偏斜)。
  // 退化成「只有它自己一条线程的未归类事项」,聚合态仍然只经 aggregateMissionState —— 绝不在这里
  // 按 card.status 另编一套判据(那就是第二个状态机)。
  // 116h(§8.10「排队可解释」):看板每一行都要能说出「它在等什么」。这一行就是那条线程自己的行,
  // 所以取聚合行里【它自己】那条线程的 wait(与 steward_missions / steward_thread_status 同源同形);
  // row 缺失的退化分支里现算一次,仍然只经 06i 的 waitReasonFor(不另编第二套判据)。
  const threadWait = row ? ((row.threads || []).find(thread => thread.sessionId === card.sessionId) || {}).wait || null : null;
  if (!row) {
    const derived = stewardThreadStateFromCard(card);
    return Object.assign(card, {
      aggregateState: aggregateMissionState([derived.state]),
      threadCount: 1, acceptance: { done: 0, total: 0 }, budget: {}, cost: emptyMissionCostBucket(), derived: true,
      // 117h 第 0 步:没有聚合行 = 没有容器,事项标题就是这条线程自己的标题,目标与验收项如实为空。
      missionTitle: String(card.displayTitle || card.title || ''), goal: '', acceptanceItems: [],
      wait: waitReasonFor(
        { pending: (derived.sources && derived.sources.pendingTotal) || 0 },
        typeof StewardHooks.arbiterWait === 'function' ? StewardHooks.arbiterWait(card.sessionId) : null,
      ),
    });
  }
  return Object.assign(card, {
    aggregateState: row.aggregateState,
    threadCount: row.threadCount,
    acceptance: { done: row.acceptance.done, total: row.acceptance.total },
    budget: row.budget,
    cost: row.cost,
    derived: row.derived,
    // ── 117h 第 0 步(27 号文 §5 117h 行 / 117d 拍板①):看板要按【事项】分组显示,而事项容器的
    // 标题 / 目标 / 验收项此前只有 steward_missions 工具面拿得到 —— 117d 抽屉只能按确定性顺序
    // 回落到线程标题。这里【只加三个字段】,不加新路由、不动既有字段与顺序:
    //   · missionTitle:有容器就是容器标题;没有容器(derived 行,`未归类事项`)就是本行自己的标题;
    //   · goal        :容器目标,无容器为空串(不猜、不拿线程摘要冒充);
    //   · acceptanceItems:容器验收项整表(既有 acceptance 只有 done/total 两个数,画不出条目)。
    // 116-5b:derived 行的事项标题 = 这条线程自己的【显示名】(见 buildMissionAggregateRows 同款注释)。
    missionTitle: row.derived ? String(card.displayTitle || card.title || '') : String(row.title || ''),
    goal: String(row.goal || ''),
    acceptanceItems: Array.isArray(row.acceptance.items) ? row.acceptance.items : [],
    wait: threadWait,
  });
}

async function handleMissionsApiRoutes(req, res, pathname) {
  // 75c:列表走可删物化索引。冷读验证/重建权威源，热读只叠加 live overlay；cursor 携带 revision，
  // 跨页期间事实变化返回 409 snapshot_changed，绝不静默漏项/重复。
  if (req.method === 'GET' && pathname === '/api/missions') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const index = await getPretenderProjectionIndex();
    // 116g:只加字段 —— 行仍然是【线程行】(每个 mission 会话一张卡),既有字段与顺序逐字节不变,
    // 追加的是这条线程所属【事项】的聚合事实(aggregateState/threadCount/acceptance/cost/budget/derived)。
    const aggregate = await buildMissionAggregateRows();
    const missions = index.sessions.filter(row => row.card)
      .map(row => overlayMissionAggregateFields(overlayMissionCard(row), aggregate.rowBySessionId.get(row.sessionId)));
    missions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const paged = paginatePretenderProjection(req, 'missions', index.missionsRevision, missions);
    if (paged.response) return send(res, paged.response);
    const etag = pretenderEtag('missions', index.missionsRevision + '-' + pretenderLiveOverlayRevision() + '-' + aggregate.stamp, paged.page);
    if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    return send(res, json({
      ok: true,
      missions: paged.items,
      page: paged.page,
      nextCursor: paged.page.nextCursor,
      projectionRevision: index.missionsRevision,
      index: pretenderIndexMeta(index),
    }, 200, { etag }));
  }
  // ── 第 116 波 116g(27 号文 §3.1):事项容器的写面。五条路由,全部 token 门(01b 的
  // `POST /api/missions` 与 `PATCH /api/missions/` 两条新登记 + 既有 `POST /api/missions/` 前缀条)。
  // 幂等一律靠子操作本身幂等(attach/detach/去重/归档),不靠"是否做过"的标记位 —— 标记位会在
  // 崩溃窗口里说谎,幂等的子操作不会。
  if (req.method === 'POST' && pathname === '/api/missions') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const body = await readJsonBody(req);
    const result = await createMissionContainer(body || {});
    return send(res, result.ok ? json(result, 201) : missionContainerFailure(result));
  }
  // 事项级字段(title/goal/acceptance/budget)的【唯一】写入口。会话头里的 head.mission 不受影响。
  if ((req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'PATCH')) && pathname.match(/^\/api\/missions\/([^/]+)$/)) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const missionId = safeSessionId(pathname.split('/')[3]);
    if (!missionId) return send(res, missionContainerFailure({ error: 'invalid_request', message: 'invalid missionId' }));
    const body = await readJsonBody(req);
    const result = await patchMissionContainer(missionId, body || {});
    return send(res, result.ok ? json(result) : missionContainerFailure(result));
  }
  // 线程加入 / 移出。attach 把会话头 missionId 改为目标事项(经 updateSessionMeta,享受 116-2a 的
  // 活回合竞态防护)并写反向索引;detach 恢复 missionId === sessionId(未归类)。
  if (req.method === 'POST' && pathname.match(/^\/api\/missions\/([^/]+)\/threads$/)) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const missionId = safeSessionId(pathname.split('/')[3]);
    if (!missionId) return send(res, missionContainerFailure({ error: 'invalid_request', message: 'invalid missionId' }));
    const body = await readJsonBody(req);
    const action = String((body && body.action) || '');
    if (action !== 'attach' && action !== 'detach') {
      return send(res, missionContainerFailure({ error: 'invalid_request', message: "action must be 'attach' or 'detach'" }));
    }
    const result = action === 'attach'
      ? await missionAttachThread(missionId, body && body.sessionId)
      : await missionDetachThread(missionId, body && body.sessionId);
    return send(res, result.ok ? json(result) : missionContainerFailure(result));
  }
  // 合并:from 的全部线程搬到目标、验收项按文本去重并入、from 标 archivedAt。再合一次零变化。
  if (req.method === 'POST' && pathname.match(/^\/api\/missions\/([^/]+)\/merge$/)) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const missionId = safeSessionId(pathname.split('/')[3]);
    if (!missionId) return send(res, missionContainerFailure({ error: 'invalid_request', message: 'invalid missionId' }));
    const body = await readJsonBody(req);
    const result = await missionMergeInto(missionId, body && body.from);
    return send(res, result.ok ? json(result) : missionContainerFailure(result));
  }
  // 拆分:把指定线程拆到一个新事项。幂等键 = 同一组 sessionIds 已完整落在同名未归档事项里。
  if (req.method === 'POST' && pathname.match(/^\/api\/missions\/([^/]+)\/split$/)) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const missionId = safeSessionId(pathname.split('/')[3]);
    if (!missionId) return send(res, missionContainerFailure({ error: 'invalid_request', message: 'invalid missionId' }));
    const body = await readJsonBody(req);
    const result = await missionSplitThreads(missionId, body && body.sessionIds, body && body.title);
    return send(res, result.ok ? json(result) : missionContainerFailure(result));
  }
  // 第79波:确定性回来摘要数据面。只返回严格位于 (after,currentRevision] 的原始变更记录；
  // migration prefix、损坏行、内部/尾部缺号都以 degraded+gap 明示，客户端不得推进 lastSeen。
  if (req.method === 'GET' && /^\/api\/missions\/[^/]+\/changes$/.test(pathname)) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(pathname.split('/')[3]);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const query = new URL(req.url, 'http://x').searchParams;
    const after = Number(query.get('after'));
    if (!Number.isSafeInteger(after) || after < 0) return send(res, json({ ok: false, error: 'after must be a non-negative integer' }, 400));
    const session = await loadSession(sessionId);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    // 117m-A3(用户第六轮走查④「交办台点开,显示报错」):线程 kind:'mission' 而 mission:null 是【合法状态】
    // —— 管家刚开的线程还没有任何变更账本。修前这里 404 'mission not found',而交办台详情是一个
    // Promise.all(详情 + 两次 changes),一挂就把整块面板换成错误卡(用户截图里那张)。把「还没有变更」
    // 说成「找不到事项」是判据错位:找不到的是账本,不是事项,而空账本本来就该回一份空清单。
    // 只放宽这一种情形(会话在、账本空);会话不存在仍旧 404。
    if (!session.mission) {
      return send(res, json({
        ok: true, missionId: sessionMissionId(session), sessionId,
        fromRevision: after, currentRevision: 0, baseRevision: 0,
        changes: [], degraded: false, gap: null,
        integrity: { corruptLines: 0, lastRevision: 0 },
      }));
    }
    const currentRevision = Math.max(0, Number(session.mission.changeSeq) || 0);
    const folded = await readMissionChangesWithMeta(sessionId, currentRevision);
    let gap = folded.gap;
    if (!gap && after < folded.baseRevision) gap = { expected: after + 1, actual: folded.baseRevision + 1, prefix: true };
    if (!gap && after > currentRevision) gap = { expected: currentRevision, actual: after, ahead: true };
    const degraded = folded.degraded || Boolean(gap);
    return send(res, json({
      ok: true,
      missionId: sessionMissionId(session),
      sessionId,
      fromRevision: after,
      currentRevision,
      baseRevision: folded.baseRevision,
      changes: folded.records.filter(record => Number(record.seq) > after && Number(record.seq) <= currentRevision),
      degraded,
      gap: gap || null,
      integrity: { corruptLines: folded.corruptLines, lastRevision: folded.lastRevision },
    }));
  }
  // 第84波:Mission 控制面。动作作用域由 missionControlCommand 单一核心冻结；本路由只做
  // missionId/sessionId 解析与 HTTP 适配，经典 /api/mission stop 也复用同一核心。
  if (req.method === 'POST' && /^\/api\/missions\/[^/]+\/control$/.test(pathname)) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(pathname.split('/')[3]);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const body = await readJsonBody(req);
    const result = await missionControlCommand(sessionId, body && body.action, body && body.prompt);
    return send(res, json(result.body, result.status));
  }
  // 详情:单会话稳定任务快照(EC-E:mission + Agent Run + 产物 + 变更 + 检查点 + 用量 + 游标)。
  if (req.method === 'GET' && pathname.startsWith('/api/missions/')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(path.basename(pathname)); // basename 挡穿越
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const index = await getPretenderProjectionIndex();
    const indexed = index.sessions.find(row => row.sessionId === sessionId) || null;
    const etag = indexed ? pretenderEtag('mission', indexed.revision + '-' + pretenderLiveOverlayRevision(sessionId)) : '';
    if (etag && pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    const session = await loadSession(sessionId);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    const runs = await listAgentRuns(sessionId).catch(() => []);

    // 验收投影:里程碑计数 + 逐项状态(机器验收证据随行)。
    const ms = (session.mission && Array.isArray(session.mission.milestones)) ? session.mission.milestones : [];
    const acceptance = {
      total: ms.length,
      done: ms.filter(x => x && x.status === 'done').length,
      blocked: ms.filter(x => x && x.status === 'blocked').length,
      pending: ms.filter(x => !x || x.status === 'pending').length,
      items: ms.map(x => ({ id: x && x.id, desc: x && x.desc, status: (x && x.status) || 'pending', checkType: (x && x.check && x.check.type) || 'none', evidence: (x && x.evidence) || '' })),
    };

    // 变更/产物聚合:跨回合 turnSummary 折叠(02 foldTurnSummaries 单一实现,与 buildMissionResult 共用) ——
    // filesChanged 按 path 后写胜(最新 op/revertible 为当前态),artifacts 按 path 先去重(首次产出记回合)。
    // revertible=false 即不可逆显式标注(journal skipped 或天生不在账内)。
    // 第72波顺手修:旧内联折叠 `commands += (ts.commands || []).length` 把数字当数组,commands>0 即 NaN
    // (JSON 序列化为 null)——统一走 fold 后该 bug 消失;irreversible 正向账随行,旧回合(无该字段)的
    // commands 诚实单列 legacyCommands,不混进新账假装有据。
    const fold = foldTurnSummaries(session);
    const filesChangedList = fold.filesChanged, artifactsList = fold.artifacts, commands = fold.commands;

    // 检查点引用(真实回滚能力的入口:POST /api/checkpoints/rollback {sessionId, turnSeq, entrySeq?})。
    const cpEntries = await journalReadIndex(sessionId).catch(() => []);
    const cpTurnSeqs = [...new Set(cpEntries.map(e => e && e.turnSeq).filter(Number.isFinite))].sort((a, b) => a - b);
    const checkpoints = {
      entries: cpEntries.length,
      turnSeqs: cpTurnSeqs,
      totalBytes: cpEntries.reduce((s, e) => s + (Number(e && e.bytes) || 0), 0),
      rollbackAvailable: cpEntries.length > 0,
    };
    // 第84波台账时间轴:直接投影 checkpoint journal，不从摘要猜「可回退」。被跳过的大文件与不在
    // journal 中的变更诚实列入不可回退区；最多下发最近 200 条，长任务的详情响应保持有界。
    const checkpointKeys = new Set(cpEntries.map(entry => `${Number(entry && entry.turnSeq)}:${Number(entry && entry.entrySeq)}:${String(entry && entry.path || '')}`));
    // skipped:true 已在 checkpoint row 自身标成不可回退；这里只补「摘要里有、journal 里没有」的变更，
    // 避免同一大文件既算 skipped row 又算 nonRevertibleFile 而把不可退计数翻倍。
    const nonRevertibleFiles = filesChangedList.filter(file => file
      && !checkpointKeys.has(`${Number(file.turnSeq)}:${Number(file.entrySeq)}:${String(file.path || '')}`));
    const ledgerEntries = cpEntries.slice(-200).map(entry => ({
      turnSeq: Number(entry && entry.turnSeq) || 0,
      entrySeq: Number(entry && entry.entrySeq) || 0,
      path: String(entry && entry.path || ''),
      op: String(entry && entry.op || ''),
      tool: String(entry && entry.tool || ''),
      bytes: Math.max(0, Number(entry && entry.bytes) || 0),
      ts: String(entry && entry.ts || ''),
      revertible: !(entry && entry.skipped),
      reason: entry && entry.skipped ? 'content_too_large' : '',
    }));
    const reversibleEntries = ledgerEntries.filter(entry => entry.revertible).length;
    const recoveryBlockers = ledgerEntries.filter(entry => !entry.revertible).length + nonRevertibleFiles.length
      + fold.irreversible.total + fold.irreversible.legacyCommands;
    const controls = missionControlView(session, { checkpointEntries: cpEntries, runs });
    const ledger = {
      entries: ledgerEntries,
      truncated: cpEntries.length > ledgerEntries.length,
      totalEntries: cpEntries.length,
      nonRevertibleFiles: nonRevertibleFiles.slice(-80),
      irreversible: { items: fold.irreversible.items.slice(-80), legacyCommands: fold.irreversible.legacyCommands },
      rollbackTargetTurnSeq: controls.rollbackTargetTurnSeq,
      recoverability: reversibleEntries === 0 ? 'none' : (recoveryBlockers > 0 ? 'partial' : 'full'),
      reversibleEntries,
      nonRevertibleEntries: recoveryBlockers,
    };

    // 用量切片:append-only 月度账本按 sessionId 过滤(权威存储,session 对象上无聚合字段)。
    const usage = indexed && indexed.usage ? indexed.usage : emptyMissionUsage();

    // 游标:增量消费的位置令牌 —— 会话 turnSeq(单调不回绕)+ 各 run 事件流 eventSeq(严格单调,afterSeq 补播)。
    const cursor = {
      turnSeq: Number(session.turnSeq) || 0,
      runs: Object.fromEntries(runs.map(r => [r.id, Number(r && r.eventSeq) || 0])),
      projectionRevision: indexed ? indexed.revision : '',
      snapshotAt: nowIso(),
    };
    const pendingCounts = await missionPendingCounts(sessionId, runs, indexed && indexed.interventions);

    return send(res, json({
      ok: true,
      snapshot: {
        sessionId, missionId: sessionMissionId(session), kind: sessionKind(session), title: session.title || '', summary: session.summary || '',
        cwd: session.cwd || '', createdAt: session.createdAt || '', updatedAt: session.updatedAt || '',
        status: missionCardStatus(session.mission),
        activeTurn: activeChildren.has(sessionId), // 第56波:活回合标志(五态派生的「进行中」权威信号之一,与 run.live 同型内存叠加)
        mission: session.mission || null,
        acceptance,
        // 班组图只需最近 6 轮；更旧历史仍保留标量 digest，可在经典工作台查看完整节点。
        runs: runs.map((run, index) => missionRunDigest(run, true, index < 6)),
        changes: { filesChanged: filesChangedList, artifacts: artifactsList, commands },
        // 第72波:不可逆操作正向账(活任务也随快照下发;终态任务以 mission.result 盖章版为准)
        irreversible: { total: fold.irreversible.total, byKind: fold.irreversible.byKind, items: fold.irreversible.items.slice(-30), legacyCommands: fold.irreversible.legacyCommands },
        // 第72波:任务结果快照(终态盖章;active/paused 为 null,看 acceptance/changes/irreversible 实时投影)
        result: (session.mission && session.mission.result) || null,
        // 历史轮次验收报告(next_turn/retry/rollback/再武装前归档的旧 result,有界 last 10)
        resultHistory: Array.isArray(session.mission && session.mission.resultHistory) ? session.mission.resultHistory : [],
        checkpoints,
        controls,
        ledger,
        usage,
        pending: pendingCounts,
        cursor,
        projectionRevision: indexed ? indexed.revision : '',
        freshness: {
          persistentRevision: indexed ? indexed.revision : '',
          indexedAt: indexed ? indexed.indexedAt : '',
          liveOverlay: activeChildren.has(sessionId) || runs.some(r => activeAgentRuns.has(r.id)),
          overlayAt: nowIso(),
        },
      },
      index: pretenderIndexMeta(index),
    }, 200, etag ? { etag } : {}));
  }
  return false;
}

// ============================================================================
// 第75b波(Pretender P1):Intervention 单一 command core。
// 新契约与经典四端点都只做参数/响应适配;权威 CAS、可送达检查、实际动作、审计与幂等响应持久化均在这里。
// ============================================================================
function canonicalDecisionValue(value, depth = 0) {
  if (depth > 24 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => canonicalDecisionValue(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalDecisionValue(value[key], depth + 1);
  return out;
}

function interventionDecisionFingerprint(missionId, interventionId, payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalDecisionValue({ missionId, interventionId, payload })), 'utf8')
    .digest('hex');
}

function interventionCommandFailure(reason, status, params = {}, message = '') {
  return {
    status,
    body: {
      ok: false,
      reason,
      error: {
        code: `intervention.${reason}`,
        params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
        ...(message ? { message } : {}),
      },
    },
  };
}

function normalizeContractQuestionDecision(payload, questions) {
  const rows = payload && payload.answer && Array.isArray(payload.answer.answers)
    ? payload.answer.answers
    : null;
  const known = Array.isArray(questions) ? questions : [];
  if (!rows || rows.length !== known.length || rows.length < 1 || rows.length > 3) {
    return { ok: false, message: 'answer.answers must contain exactly one answer for each question' };
  }
  const byId = new Map(known.map(q => [String(q && q.id || ''), q]));
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') return { ok: false, message: 'each answer must be an object' };
    if (Object.keys(row).some(key => !['questionId', 'selectedOptionIds', 'otherText'].includes(key))) {
      return { ok: false, message: 'answer contains fields outside the typed question contract' };
    }
    const questionId = String(row.questionId || '');
    const question = byId.get(questionId);
    if (!question || seen.has(questionId)) return { ok: false, message: 'questionId is unknown or duplicated' };
    seen.add(questionId);
    if (!Array.isArray(row.selectedOptionIds)) return { ok: false, message: 'selectedOptionIds must be an array' };
    if (row.selectedOptionIds.some(id => typeof id !== 'string')) return { ok: false, message: 'selectedOptionIds must contain strings' };
    if (row.otherText !== undefined && typeof row.otherText !== 'string') return { ok: false, message: 'otherText must be a string' };
    const selected = row.selectedOptionIds.map(x => String(x || '')).filter(Boolean);
    if (selected.length !== new Set(selected).size || selected.length > 12) return { ok: false, message: 'selectedOptionIds contains duplicates or too many values' };
    const optionIds = new Set((Array.isArray(question.options) ? question.options : []).map(o => String(o && o.id || '')));
    if (selected.some(id => !optionIds.has(id))) return { ok: false, message: 'selectedOptionIds contains an option outside this question' };
    const otherText = String(row.otherText || '').trim();
    const mode = String(question.answerMode || (question.multiSelect ? 'multiple' : 'single'));
    if (mode === 'single' && selected.length > 1) return { ok: false, message: 'single-choice question accepts at most one option' };
    if (mode === 'text' && selected.length) return { ok: false, message: 'text question does not accept selectedOptionIds' };
    if (otherText && mode !== 'text' && question.allowOther !== true) return { ok: false, message: 'otherText is not allowed for this question' };
    if (!selected.length && !otherText) return { ok: false, message: 'each question requires an answer' };
  }
  return { ok: true, answer: normalizeQuestionAnswer({ answers: rows }, known) };
}

function mapInterventionTransitionFailure(result) {
  const reason = String(result && result.reason || 'decision_failed');
  if (reason === 'not_found') return interventionCommandFailure(reason, 404, {}, 'mission or intervention not found');
  if (reason === 'expired') return interventionCommandFailure(reason, 410, { status: result.status || '' }, 'intervention has expired');
  if (reason === 'version_conflict') {
    return interventionCommandFailure(reason, 409, {
      expectedVersion: result.expectedVersion,
      actualVersion: result.actualVersion,
    }, 'intervention version does not match');
  }
  if (reason === 'idempotency_conflict') {
    return interventionCommandFailure(reason, 409, {}, 'idempotencyKey was already used for a different request');
  }
  if (reason === 'already_terminal') {
    return interventionCommandFailure(reason, 409, {
      status: result.status || '',
      interventionVersion: Number(result.interventionVersion) || 0,
    }, 'intervention is already terminal');
  }
  if (reason === 'not_pending') {
    return interventionCommandFailure(reason, 409, { status: result.status || '' }, 'intervention is already being applied');
  }
  return interventionCommandFailure(reason, 409, {
    ...(result && result.runId ? { runId: result.runId } : {}),
  }, String(result && result.message || 'intervention cannot be delivered'));
}

async function decideIntervention(command = {}) {
  const rawMissionId = String(command.missionId || '');
  const missionId = safeSessionId(rawMissionId);
  const interventionId = String(command.interventionId || '');
  const source = String(command.source || 'contract').slice(0, 64);
  const contractRequest = command.contractRequest !== false;
  const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
    ? command.payload
    : {};
  if (!missionId || missionId !== rawMissionId || !/^[A-Za-z0-9_-]{1,160}$/.test(interventionId)) {
    return interventionCommandFailure('invalid_request', 400, {}, 'invalid missionId or interventionId');
  }
  // 117j 收尾：这一发读【必须】走带瞬时重试的那一个。它是用户动作的判定入口 —— 读空一次就等于
  // 把「允许／回答」当场判成 404「会话不存在」，而真相只是回合正好在写头（见 02 的头注）。
  const head = await readSessionHeadResilient(missionId);
  // 117e 第 0 步(116g 引入的真 bug):这道门在 116g 之前是恒等式 —— 会话没挂进显式事项容器时
  // sessionMissionId(head) 就回落成 head.id,而 head 正是按 `sessionPath(missionId)` 读出来的。
  // 116g 的 missionAttachThread 把 session.missionId 改写成【容器 id】之后,同一条会话再按自己的
  // id 来答待决就恒判 not_found —— /api/chat/answer、/api/permission/decision、/api/plan/decision
  // 三条兼容适配器与 steward_decide 传的都是 sessionId,于是「凡是进了多线程事项的线程,问题/权限/
  // 计划都答不进去」(经典壳同样受影响)。
  // 修法:把「missionId 等于该会话自身 id」显式认作合法别名(容器 id 仍照旧受理,只是那个 id 上
  // 没有会话文件,读不出 head 就仍然 404)。**不放宽**「跨会话答别人的待决」:待决本体在下面按
  // `readInterventions(missionId)` 从这条会话自己的旁路账里取,并再核一次 `current.sessionId ===
  // missionId`;拿会话 A 的 id 去答会话 B 的待决,那两道判定照旧拦下。
  const headSelfId = String((head && head.id) || '');
  if (!head || (sessionMissionId(head) !== missionId && headSelfId !== missionId)) {
    return interventionCommandFailure('not_found', 404, {}, 'mission or intervention not found');
  }

  if (contractRequest) {
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) {
      return interventionCommandFailure('invalid_request', 400, { field: 'expectedVersion' }, 'expectedVersion must be a non-negative integer');
    }
    const key = String(command.idempotencyKey || '');
    if (!key || key.length > 128) {
      return interventionCommandFailure('invalid_request', 400, { field: 'idempotencyKey' }, 'idempotencyKey must contain 1-128 characters');
    }
  }

  const current = (await readInterventions(missionId).catch(() => []))
    .find(iv => iv && String(iv.id) === interventionId);
  if (!current || String(current.sessionId || missionId) !== missionId) {
    return interventionCommandFailure('not_found', 404, {}, 'mission or intervention not found');
  }

  const type = String(current.type || '');
  const action = String(payload.action || '');
  if (contractRequest) {
    const commonFields = new Set(['expectedVersion', 'idempotencyKey', 'action']);
    const typeFields = type === 'permission' ? ['updatedInput', 'scope']
      : type === 'question' ? ['answer']
        : type === 'plan' ? ['feedback']
          : [];
    const allowed = new Set([...commonFields, ...typeFields]);
    const unknown = Object.keys(payload).filter(key => !allowed.has(key));
    if (unknown.length) return interventionCommandFailure('payload_invalid', 400, { fields: unknown }, 'request contains fields outside the type/action contract');
  }
  let toStatus = '';
  let normalizedAnswer = null;
  if (type === 'permission') {
    if (action !== 'allow' && action !== 'deny') return interventionCommandFailure('action_invalid', 400, { type }, 'permission action must be allow or deny');
    if (action === 'allow' && payload.updatedInput !== undefined && (!payload.updatedInput || typeof payload.updatedInput !== 'object' || Array.isArray(payload.updatedInput))) {
      return interventionCommandFailure('payload_invalid', 400, { field: 'updatedInput' }, 'updatedInput must be an object');
    }
    if (payload.scope !== undefined && payload.scope !== 'session') {
      return interventionCommandFailure('payload_invalid', 400, { field: 'scope' }, 'scope must be session when provided');
    }
    toStatus = action === 'allow' ? 'allowed' : 'denied';
  } else if (type === 'question') {
    if (action !== 'answer') return interventionCommandFailure('action_invalid', 400, { type }, 'question action must be answer');
    if (contractRequest) {
      const normalized = normalizeContractQuestionDecision(payload, current.questions);
      if (!normalized.ok) return interventionCommandFailure('payload_invalid', 400, { type }, normalized.message);
      normalizedAnswer = normalized.answer;
    } else {
      normalizedAnswer = payload.normalizedAnswer;
      if (!normalizedAnswer || typeof normalizedAnswer !== 'object') return interventionCommandFailure('payload_invalid', 400, { type }, 'question answer is required');
    }
    toStatus = normalizedAnswer.ok === false ? 'cancelled' : 'answered';
  } else if (type === 'plan') {
    if (action !== 'approve' && action !== 'reject') return interventionCommandFailure('action_invalid', 400, { type }, 'plan action must be approve or reject');
    if (contractRequest && payload.feedback !== undefined && typeof payload.feedback !== 'string') {
      return interventionCommandFailure('payload_invalid', 400, { field: 'feedback' }, 'feedback must be a string');
    }
    toStatus = action === 'approve' ? 'approved' : 'rejected';
  } else if (type === 'pool') {
    if (action !== 'approve' && action !== 'reject') return interventionCommandFailure('action_invalid', 400, { type }, 'pool action must be approve or reject');
    toStatus = action === 'approve' ? 'approved' : 'rejected';
  } else if (type === 'replan') {
    if (action !== 'approve' && action !== 'reject') return interventionCommandFailure('action_invalid', 400, { type }, 'replan action must be approve or reject');
    toStatus = action === 'approve' ? 'approved' : 'rejected';
  } else {
    return interventionCommandFailure('type_unsupported', 409, { type }, 'intervention type is not supported by this release');
  }

  const idempotencyKey = String(command.idempotencyKey || makeId('legacy')).slice(0, 128);
  const decisionPayload = type === 'question'
    ? { action, answer: normalizedAnswer }
    : type === 'permission'
      ? { action, ...(action === 'allow' && payload.updatedInput !== undefined ? { updatedInput: payload.updatedInput } : {}), ...(action === 'allow' && payload.scope === 'session' ? { scope: 'session' } : {}) }
      : type === 'plan'
        ? { action, ...(payload.feedback !== undefined ? { feedback: String(payload.feedback) } : {}) }
        : { action };
  const decisionFingerprint = interventionDecisionFingerprint(missionId, interventionId, decisionPayload);
  let runtimeEntry = null;
  let poolContext = null;
  let replanContext = null;

  const preflight = async authoritative => {
    if (!authoritative || String(authoritative.type || '') !== type) return { ok: false, reason: 'not_found' };
    if (type === 'permission') {
      runtimeEntry = pendingPermissions.get(interventionId);
      if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'permission consumer is not live' };
      return { ok: true };
    }
    if (type === 'question') {
      runtimeEntry = pendingQuestions.get(interventionId);
      if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'question consumer is not live' };
      return { ok: true };
    }
    if (type === 'plan') {
      runtimeEntry = pendingPlans.get(interventionId);
      if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'plan consumer is not live' };
      return { ok: true };
    }
    if (type === 'replan') {
      const runId = String(authoritative.runId || '');
      if (command.requestRunId && String(command.requestRunId) !== runId) return { ok: false, reason: 'not_found' };
      // R5: patch 审批不要求 run live —— 节点终态后 run 通常已收尾离开 activeAgentRuns。
      // 优先用 live 内存态(最新),否则读 persisted run JSON(已收尾仍可审批)。
      const live = activeAgentRuns.get(runId);
      let runObj = null;
      if (live && live.run && !live.closing) {
        if (live.run.sessionId !== missionId) return { ok: false, reason: 'not_found' };
        runObj = live.run;
      } else {
        try { runObj = safeJsonParse(await fsp.readFile(agentRunFile(missionId, runId), 'utf8'), null); } catch {}
        if (!runObj || runObj.sessionId !== missionId) return { ok: false, reason: 'run_not_found', runId, message: 'run is not found' };
      }
      const patch = (Array.isArray(runObj.replanPatches) ? runObj.replanPatches : []).find(p => p && String(p.id) === interventionId);
      if (!patch || patch.status !== 'pending') return { ok: false, reason: 'replan_patch_unavailable', runId, message: 'replan patch is no longer pending' };
      replanContext = { runId, runObj, patch };
      return { ok: true };
    }

    const runId = String(authoritative.runId || '');
    if (command.requestRunId && String(command.requestRunId) !== runId) return { ok: false, reason: 'not_found' };
    const live = activeAgentRuns.get(runId);
    if (!live || !live.run || live.closing) {
      let persisted = null;
      try { persisted = safeJsonParse(await fsp.readFile(agentRunFile(missionId, runId), 'utf8'), null); } catch {}
      const reason = persisted && persisted.status === 'paused' ? 'run_paused' : 'run_not_live';
      return { ok: false, reason, runId, message: reason === 'run_paused' ? 'run is paused; resume it before deciding' : 'run is not live' };
    }
    if (live.run.sessionId !== missionId) return { ok: false, reason: 'not_found' };
    if (live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted)) {
      return { ok: false, reason: 'run_stopping', runId, message: 'run is stopping' };
    }
    const item = (Array.isArray(live.run.taskPool) ? live.run.taskPool : []).find(p => p && String(p.id) === interventionId);
    if (!item || item.status !== 'proposed') return { ok: false, reason: 'pool_item_unavailable', runId, message: 'pool item is no longer proposed' };
    let config = null, cwd = '', roleLibrary = new Map();
    if (action === 'approve') {
      try {
        config = await readConfig();
        const session = await loadSession(missionId);
        cwd = normalizeCwd(session && session.cwd, config.defaultWorkspace);
        roleLibrary = new Map((await getAgentRoleLibrary(cwd, config)).map(role => [role.id, role]));
      } catch { /* preserve the existing empty-role-library fallback */ }
      const dryRun = { ...live.run, nodes: Array.isArray(live.run.nodes) ? [...live.run.nodes] : [] };
      const dry = materializePoolItem(dryRun, { ...item }, { roleLibrary, cwd, config });
      if (!dry.ok) return { ok: false, reason: 'pool_materialize_rejected', runId, message: dry.error || 'pool item cannot be materialized' };
    }
    poolContext = { runId, live, item, config, cwd, roleLibrary };
    return { ok: true };
  };

  const execute = () => {
    if (type === 'permission') {
      runtimeEntry.commandApplying = true;
      clearTimeout(runtimeEntry.timer);
      const decision = action === 'allow'
        ? { behavior: 'allow', updatedInput: payload.updatedInput, ...(payload.scope === 'session' ? { scope: 'session' } : {}) }
        : { behavior: 'deny', message: String(payload.message || 'denied by user') };
      runtimeEntry.resolve(decision, { skipInterventionSettle: true });
      return { ok: true, delivered: true };
    }
    if (type === 'question') {
      runtimeEntry.commandApplying = true;
      clearTimeout(runtimeEntry.timer);
      const delivered = runtimeEntry.deliver(normalizedAnswer, { skipInterventionSettle: true, preserveRegistry: true });
      return { ok: delivered !== false, delivered: delivered !== false, reason: delivered === false ? 'delivery_failed' : '' };
    }
    if (type === 'plan') {
      runtimeEntry.commandApplying = true;
      clearTimeout(runtimeEntry.timer);
      runtimeEntry.resolve({
        decision: action,
        note: payload.feedback != null ? String(payload.feedback).slice(0, 2000) : '',
      }, { skipInterventionSettle: true });
      return { ok: true, delivered: true };
    }
    if (type === 'replan') {
      return (async () => {
        const { runObj, patch } = replanContext;
        if (patch.status !== 'pending') return { ok: false, reason: 'run_state_changed' };
        if (action === 'reject') {
          patch.status = 'rejected'; patch.decidedAt = nowIso();
          bumpRunIntervention(runObj, 'replan_reject');
          appendAgentRunEvent(runObj, { type: 'run_replan', data: { action: 'rejected', patchId: interventionId, by: String(command.decidedBy || 'user') } });
          await saveAgentRun(runObj);
          return { ok: true, patchId: interventionId };
        }
        if (!Array.isArray(patch.changes) || patch.changes.length === 0) return { ok: false, reason: 'replan_changes_pending', message: '重规划提案尚未补充 changes，暂不能应用；请先由 review 角色填充变更项，或拒绝该提案' };
        const ap = applyReplanPatch(runObj, interventionId);
        if (!ap.ok) return { ok: false, reason: 'replan_apply_failed', message: ap.error || '' };
        patch.decidedAt = nowIso();
        bumpRunIntervention(runObj, 'replan_approve');
        appendAgentRunEvent(runObj, { type: 'run_replan', data: { action: 'applied', patchId: interventionId, by: String(command.decidedBy || 'user'), applied: ap.applied } });
        await saveAgentRun(runObj);
        return { ok: true, patchId: interventionId, applied: ap.applied };
      })();
    }
    return (async () => {
      const { runId, live, item, config, cwd, roleLibrary } = poolContext;
      if (activeAgentRuns.get(runId) !== live || live.closing || live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted) || item.status !== 'proposed') {
        return { ok: false, reason: 'run_state_changed' };
      }
      if (action === 'reject') {
        item.status = 'rejected'; item.decidedBy = String(command.decidedBy || 'user'); item.decidedAt = nowIso();
        bumpRunIntervention(live.run, 'pool_reject');
        appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'rejected', poolId: interventionId, by: String(command.decidedBy || 'user') } });
        await saveAgentRun(live.run);
        return { ok: true, poolId: interventionId };
      }
      const mat = materializePoolItem(live.run, item, { roleLibrary, cwd, config });
      if (!mat.ok) return { ok: false, reason: 'pool_materialize_failed', message: mat.error || '' };
      item.status = 'materialized'; item.decidedBy = String(command.decidedBy || 'user'); item.decidedAt = nowIso(); item.resultNodeId = mat.node.id;
      bumpRunIntervention(live.run, 'pool_approve');
      appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'materialized', poolId: interventionId, by: String(command.decidedBy || 'user'), nodeId: mat.node.id } });
      try { live.poolGraceArmed = true; } catch {}
      if (live.inPoolGrace && Array.isArray(live.resumeWaiters)) {
        const waiters = live.resumeWaiters.splice(0);
        for (const wake of waiters) wake();
      }
      await saveAgentRun(live.run);
      return { ok: true, poolId: interventionId, nodeId: mat.node.id };
    })();
  };

  let transition;
  try {
    transition = await transitionInterventionState(
      missionId,
      interventionId,
      contractRequest ? command.expectedVersion : undefined,
      toStatus,
      {
        source,
        decidedBy: String(command.decidedBy || 'user'),
        idempotencyKey,
        decisionFingerprint,
        preflight,
        action: execute,
        resolveStatus: result => result && result.ok === false ? 'indeterminate' : toStatus,
        extra: result => ({
          action,
          ...(type === 'question' ? { answer: normalizedAnswer } : {}),
          ...(type === 'plan' && payload.feedback != null ? { feedback: String(payload.feedback).slice(0, 2000) } : {}),
          ...(result && result.nodeId ? { nodeId: result.nodeId } : {}),
        }),
        buildResponse: (result, meta) => result && result.ok === false
          ? interventionCommandFailure(result.reason || 'delivery_failed', 409, { type }, result.message || 'decision could not be delivered').body
          : {
              ok: true,
              missionId,
              interventionId,
              type,
              action,
              status: meta.status,
              interventionVersion: meta.interventionVersion,
              ...(result && result.delivered !== undefined ? { delivered: result.delivered } : {}),
              ...(result && result.nodeId ? { nodeId: result.nodeId } : {}),
            },
        audit: command.audit === false ? undefined : (_result, terminal) => {
          const auditSource = source === 'legacy_question' ? 'question_answer'
            : source === 'legacy_permission' ? 'permission_decision'
              : source === 'legacy_plan' ? 'plan_decision'
                : source === 'legacy_pool' ? `pool_${action}`
                  // 116c(27 号文 §11.3):管家代答的决定在审计流里必须一眼可辨,不能混进通用标签 ——
                  // 「谁按的这个批准」是事后解释与撤销的第一现场。
                  : source === 'steward' ? 'steward_decision'
                    : 'intervention_decision';
          logEvent({ kind: 'intervention', source: auditSource, sessionId: missionId, interventionId, type, action, interventionVersion: terminal.interventionVersion });
        },
        afterTerminal: () => {
          if (!runtimeEntry) return;
          runtimeEntry.commandApplying = false;
          if (type === 'permission' && pendingPermissions.get(interventionId) === runtimeEntry) pendingPermissions.delete(interventionId);
          else if (type === 'question' && pendingQuestions.get(interventionId) === runtimeEntry) pendingQuestions.delete(interventionId);
          else if (type === 'plan' && pendingPlans.get(interventionId) === runtimeEntry) pendingPlans.delete(interventionId);
        },
      },
    );
  } catch (error) {
    const message = String(error && error.message || error);
    return interventionCommandFailure('execution_failed', 500, {}, message);
  }
  if (!transition || !transition.ok) return mapInterventionTransitionFailure(transition);
  const response = transition.response && typeof transition.response === 'object'
    ? transition.response
    : {
        ok: true,
        missionId,
        interventionId,
        type,
        action,
        status: transition.status,
        interventionVersion: transition.interventionVersion,
      };
  return { status: response.ok === false ? 409 : 200, body: response };
}

async function handleInterventionApiRoutes(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/_test/pretender-maintenance') {
    if (process.env.RUYI_TEST_HOOKS !== '1') return send(res, json({ ok: false, error: 'not found' }, 404));
    const body = await readJsonBody(req);
    if (body.action === 'compact') {
      const sessionId = safeSessionId(body.sessionId);
      if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
      return send(res, json(await compactInterventionJournal(sessionId, { force: true })));
    }
    if (body.action === 'rebuild') {
      pretenderIndexRuntime.fullDirty = true;
      return send(res, json({ ok: true, index: pretenderIndexMeta(await getPretenderProjectionIndex()) }));
    }
    return send(res, json({ ok: false, error: 'invalid maintenance action' }, 400));
  }
  const contractMatch = pathname.match(/^\/api\/missions\/([^/]+)\/interventions\/([^/]+)\/decision$/);
  if (req.method === 'POST' && contractMatch) {
    let missionId = '', interventionId = '';
    try {
      missionId = decodeURIComponent(contractMatch[1]);
      interventionId = decodeURIComponent(contractMatch[2]);
    } catch {
      return send(res, json(interventionCommandFailure('invalid_request', 400, {}, 'malformed route encoding').body, 400));
    }
    const body = await readJsonBody(req);
    const result = await decideIntervention({
      missionId,
      interventionId,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
      payload: body,
      source: 'contract',
      contractRequest: true,
    });
    return send(res, json(result.body, result.status));
  }
  // 第56波(Pretender 立项门 / EC-E 363):全局「需要你」最小聚合入口 —— 跨会话 pending Intervention 收件箱。
  // 只读派生:扫 *.interventions.ndjson 折叠取 pending(注册/决策/超时/清理/重启终态化全在旁路账里);
  // pool 型由 71b 注册 + boot 对账覆盖,append 落盘延迟窗为最终一致(与 13d missionPendingCounts 同立场)。
  // 按 requestedAt 升序(FIFO 收件箱:最先等你的在最前)。
  if (req.method === 'GET' && pathname === '/api/interventions') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const index = await getPretenderProjectionIndex();
    const pending = [];
    const counts = { permission: 0, question: 0, plan: 0, pool: 0, replan: 0, total: 0 };
    for (const slice of index.sessions) {
      const sessionId = slice.sessionId;
      for (const iv of slice.interventions || []) {
        if (!iv || iv.status !== 'pending') continue;
        pending.push({
          id: iv.id, type: iv.type || '', sessionId, missionId: slice.missionId || sessionId,
          requestedAt: iv.requestedAt || '', interventionVersion: Math.max(0, Number(iv.interventionVersion) || 0),
          toolName: iv.toolName || '', tier: iv.tier || '', revertible: iv.revertible === true,
          runId: iv.runId || '', proposedBy: iv.proposedBy || '', task: iv.task || '',
          input: iv.type === 'permission' && iv.input && typeof iv.input === 'object' && !Array.isArray(iv.input) ? iv.input : undefined,
          questionSummary: iv.type === 'question' ? String(iv.questionSummary || '') : '',
          questions: iv.type === 'question' && Array.isArray(iv.questions) ? iv.questions : [],
          context: iv.type === 'question' ? String(iv.context || '').slice(0, 6000) : '',
          planSummary: iv.type === 'plan' ? String(iv.planSummary || '') : '',
          replanSummary: iv.type === 'replan' ? String(iv.summary || '') : '',
          replanTriggerType: iv.type === 'replan' ? String(iv.triggerType || '') : '',
          replanNodeId: iv.type === 'replan' ? String(iv.nodeId || '') : '',
          deliverable: iv.type === 'permission' ? pendingPermissions.has(String(iv.id))
            : iv.type === 'question' ? pendingQuestions.has(String(iv.id))
              : iv.type === 'plan' ? pendingPlans.has(String(iv.id))
                : iv.type === 'pool' ? activeAgentRuns.has(String(iv.runId || ''))
                  : activeChildren.has(sessionId),
          live: activeChildren.has(sessionId), // 决策可送达性提示:活回合在,决策才能立刻被消费
        });
        counts.total++;
        if (iv.type === 'permission') counts.permission++;
        else if (iv.type === 'question') counts.question++;
        else if (iv.type === 'plan') counts.plan++;
        else if (iv.type === 'pool') counts.pool++;
        else if (iv.type === 'replan') counts.replan++;
      }
    }
    pending.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
    const paged = paginatePretenderProjection(req, 'interventions', index.interventionsRevision, pending);
    if (paged.response) return send(res, paged.response);
    const etag = pretenderEtag('interventions', index.interventionsRevision + '-' + pretenderLiveOverlayRevision(), paged.page);
    if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    return send(res, json({
      ok: true,
      pending: paged.items,
      counts,
      page: paged.page,
      nextCursor: paged.page.nextCursor,
      projectionRevision: index.interventionsRevision,
      index: pretenderIndexMeta(index),
    }, 200, { etag }));
  }
  // 第71波:会话的持久化 Intervention 只读派生(注册/决策/超时/清理/重启终态化的旁路记录,02 NDJSON)。
  if (req.method === 'GET' && pathname.startsWith('/api/interventions/')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(path.basename(pathname)); // basename 挡穿越
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const index = await getPretenderProjectionIndex();
    const slice = index.sessions.find(row => row.sessionId === sessionId) || null;
    const interventions = slice ? slice.interventions : [];
    const counts = { permission: 0, question: 0, plan: 0, pool: 0, replan: 0, pending: 0, resolved: 0 };
    for (const iv of interventions) {
      if (!iv) continue;
      if (iv.status === 'pending') {
        counts.pending++;
        if (iv.type === 'permission') counts.permission++;
        else if (iv.type === 'question') counts.question++;
        else if (iv.type === 'plan') counts.plan++;
        else if (iv.type === 'pool') counts.pool++;
        else if (iv.type === 'replan') counts.replan++;
      } else counts.resolved++;
    }
    const revision = slice ? slice.interventionRevision : pretenderHash([]);
    const paged = paginatePretenderProjection(req, 'session-interventions:' + sessionId, revision, interventions);
    if (paged.response) return send(res, paged.response);
    const etag = pretenderEtag('session-interventions', revision, paged.page);
    if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    return send(res, json({
      ok: true,
      sessionId,
      missionId: slice ? slice.missionId : sessionId,
      interventions: paged.items,
      counts,
      page: paged.page,
      nextCursor: paged.page.nextCursor,
      projectionRevision: revision,
      integrity: slice ? slice.integrity : { degraded: false, corruptLines: 0, journalRows: 0, journalBytes: 0 },
    }, 200, { etag }));
  }
  if (req.method === 'POST' && pathname === '/api/chat/answer') {
    // 75b compatibility adapter: normalize the classic answer[] shape, then hand the actual decision to
    // the same command core used by the Mission contract.
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || '');
    const questionId = String(body.questionId || body.toolUseId || '');
    const entry = pendingQuestions.get(questionId);
    if (!entry || entry.sessionId !== sessionId) {
      return send(res, apiFailure('question.not_pending', {}, 'question is no longer pending', 409));
    }
    const result = await decideIntervention({
      missionId: sessionId,
      interventionId: questionId,
      payload: { action: 'answer', normalizedAnswer: normalizeQuestionAnswer(body, entry.questions) },
      source: 'legacy_question',
      contractRequest: false,
    });
    if (result.status !== 200) return send(res, apiFailure('question.delivery_failed', {}, 'answer could not be delivered; the question is still pending', 409));
    return send(res, json({ ok: true, delivered: true, questionId }));
  }
  if (req.method === 'POST' && pathname === '/api/question/heartbeat') {
    // Keep-alive from the open question modal: re-arms the pending question's timeout so a user typing a
    // long answer is never cut off at a fixed deadline. No heartbeat (modal closed / app gone) means the
    // original timeout fires as the backstop. Returns the fresh deadline for the UI countdown.
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || '');
    const extension = extendUserQuestion(sessionId, String(body.questionId || ''));
    if (!extension) return send(res, apiFailure('question.not_pending', {}, 'question is no longer pending', 409));
    return send(res, json({ ok: true, deadlineAt: extension.deadlineAt, timeoutMs: extension.timeoutMs }));
  }
  if (req.method === 'POST' && pathname === '/api/question/request') {
    // Called by request_user_input in the per-session Claude MCP child. Hold the tool call until the UI
    // answers, then return a normal MCP tool result. Provider turns use the same registry in-process.
    const body = await readJsonBody(req);
    if (!RUNTIME.token || body.token !== RUNTIME.token) return send(res, apiFailure('auth.token_invalid', {}, 'bad token', 403));
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    const reg = activeChildren.get(sessionId);
    if (!reg || !reg.onEvent) return send(res, apiFailure('question.no_active_turn', {}, 'no active UI stream to prompt', 409));
    const config = await readConfig();
    const answer = await requestUserQuestion(sessionId, makeId('question'), body.questions, reg.onEvent, config.questionTimeoutMs, reg.questionContext || '');
    return send(res, json(answer && answer.ok
      ? { ok: true, answers: answer.answers, content: answer.content }
      : { ok: false, error: (answer && (answer.error || answer.content)) || 'question cancelled' }));
  }
  if (req.method === 'POST' && pathname === '/api/permission/request') {
    // Called by the permission-bridge MCP tool (loopback). Holds until the UI decides or times out.
    const body = await readJsonBody(req);
    if (!RUNTIME.token || body.token !== RUNTIME.token) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const config = await readConfig();
    const sessionId = String(body.sessionId || '');
    const reg = activeChildren.get(sessionId);
    const requestId = makeId('perm');
    if (!reg || !reg.onEvent) {
      // No live UI stream to ask — fail closed.
      return send(res, json({ behavior: 'deny', message: 'no active UI to prompt', requestId }));
    }
    // v0.8-S4b: mirror the native path — carry tier + revertible so the popup renders the badge + the
    // revertibility line for CLI-bridge permission prompts too. The CLI reports its own tool names (Edit/
    // Write/Bash/…); toolIsRevertible only matches the workbench file_* set, so a native CLI Edit shows
    // 「无法自动撤销」(correct: CLI-native edits don't pass through toolCall → aren't journaled).
    // 第27波:CLI 桥授权书消耗点。命中直接 allow —— 连 permission_request 事件都不发(免弹窗静默放行)。工具名按 CLI
    // 弹窗实际显示的 Claude 名(Bash/Edit/Write)匹配,与签发卡片同名口径。范围外回落到下方正常弹窗。session 仅需 .id。
    const bridgeTier = nativeToolTier(String(body.toolName || ''));
    // 117m-A3(配 A1 的 D1):高风险判据要吃到工具名与入参,否则 CLI 桥这一侧的 auto 档还是老口径。
    const bridgeMode = String(config.permissionMode || '');
    const bridgeGate = nativeToolGate(bridgeMode, bridgeTier, String(body.toolName || ''), body.input || {});
    // auto 档的低风险动作在原生引擎里已经不弹窗了,CLI 桥必须同口径 —— 否则同一个「全自动」在两个引擎
    // 下行为不一致。只对 auto 档短路(其余档位一行不变:read/bypass 的既有落点仍走下面那条路)。
    if (bridgeMode === 'auto' && bridgeGate === 'allow') {
      return send(res, json({ behavior: 'allow', updatedInput: body.input || {} }));
    }
    // 对抗轮 P3(天花板对称):与 native 主 gate 对齐 —— 仅当工作台自身权限模式对该档判定为 'ask' 时才允许授权书降级。
    // 工作台若处于 plan 模式(该档判 'block'),即便 CLI 发来请求也不放行(子集律:授权书永不把 block 提升为 allow),
    // 回落到下方正常弹窗由人定夺。default→'ask' 授权书生效;bypass→'allow' 本就免弹窗,无需授权书。
    if (bridgeGate === 'ask') {
      const grantHit = consumeGrant({ id: sessionId }, String(body.toolName || ''), body.input || {}, 'cli', null);
      // 第42b波(live 冒烟擒获):CLI ≥2.1 的 zod union 要求 allow 变体【必须】带 updatedInput record,
      // 裸 {behavior:'allow'} 会被 CLI 判 invalid_union 拒掉 → 回显原始输入。
      if (grantHit) return send(res, json({ behavior: 'allow', updatedInput: body.input || {} }));
    }
    reg.onEvent({ type: 'permission_request', requestId, toolName: body.toolName, input: body.input, tier: bridgeTier, revertible: toolIsRevertible(body.toolName) });
    registerIntervention(sessionId, 'permission', requestId, {
      toolName: String(body.toolName || ''), tier: bridgeTier, revertible: toolIsRevertible(body.toolName),
      input: body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {},
    });
    // 第27f波:CLI 桥超时→存档暂停(与 provider 路径对称)。仅【opt-in + 本会话处于无人值守 driverAuto 回合】才启用;
    // 否则维持"超时即拒杀"安全默认。两段定时:基础超时→检查点(logEvent+saveSession)+ permission_paused 事件 + 延长到 TTL;
    // TTL 内无决定则回落 deny(fail-closed)。entry.timer 重赋为 TTL 定时器,/api/permission/decision 与 clearPendingPermissions 照常清对。
    const cliPause = config.autonomyPauseOnTimeout && driverAutoSessions.has(sessionId);
    const decision = await new Promise(resolve => {
      const entry = { resolve, sessionId, timer: null };
      const baseMs = Number(config.permissionTimeoutMs || 120000);
      if (cliPause) {
        entry.timer = setTimeout(() => {
          if (reg) reg.pausePending = true; // 第27f波:存档暂停期间豁免子进程 idle 看门狗(否则 TTL 内先杀子,窗口被截断)
          try { logEvent({ kind: 'permission_paused', sessionId, tool: String(body.toolName || ''), tier: bridgeTier, requestId, engine: 'claude' }); } catch { /* ignore */ }
          loadSession(sessionId).then(s => s && saveSession(s)).catch(() => {}); // 检查点:会话已在磁盘,重写一遍固化
          try { reg.onEvent({ type: 'permission_paused', requestId, toolName: body.toolName, tier: bridgeTier, ttlMs: config.autonomyPauseTtlMs }); } catch { /* stream gone */ }
          entry.timer = setTimeout(() => {
            const message = '权限已存档暂停但在时限内无人决定,已回落拒绝';
            runAutomaticInterventionDecision({
              missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
              idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
            }, () => {
              if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
              pendingPermissions.delete(requestId);
              resolve({ behavior: 'deny', message, pausedTimeout: true });
              settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'timeout', note: 'paused ttl timeout' });
            });
          }, Math.max(60000, Number(config.autonomyPauseTtlMs) || 2700000));
        }, baseMs);
      } else {
        entry.timer = setTimeout(() => {
          const message = 'permission prompt timed out';
          runAutomaticInterventionDecision({
            missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
            idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
          }, () => {
            if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
            pendingPermissions.delete(requestId);
            resolve({ behavior: 'deny', message });
            settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'timeout', note: message });
          });
        }, baseMs);
      }
      pendingPermissions.set(requestId, entry);
    });
    try { reg.onEvent({ type: 'permission_decision', requestId, behavior: decision && decision.behavior === 'allow' ? 'allow' : 'deny', message: decision && decision.message }); } catch { /* stream gone */ }
    if (reg) { reg.pausePending = false; reg.lastEventAt = Date.now(); } // 解除暂停豁免 + 重置看门狗时钟(暂停不算子进程空闲)
    if (res.writableEnded || res.destroyed) return; // request already gone (e.g. child died)
    // 第42b波(live 冒烟擒获):CLI ≥2.1 的 --permission-prompt-tool 响应是 zod union —— allow 变体必须
    // 带 updatedInput record;UI 纯「允许」(未改输入)时 decision.updatedInput 为 undefined,JSON 序列化
    // 掉键后被 CLI 拒(invalid_union: expected record, received undefined)→ 回合必败。回填原始输入。
    if (decision && decision.behavior === 'allow' && (typeof decision.updatedInput !== 'object' || decision.updatedInput === null || Array.isArray(decision.updatedInput))) {
      decision.updatedInput = body.input || {};
    }
    return send(res, json(decision));
  }
  if (req.method === 'POST' && pathname === '/api/permission/decision') {
    // 75b compatibility adapter. The entry lookup only recovers the mission partition; execution is core-owned.
    const body = await readJsonBody(req);
    const requestId = String(body.requestId || '');
    const entry = pendingPermissions.get(requestId);
    if (!entry) return send(res, json({ ok: false, error: 'unknown or expired request' }, 404));
    const behavior = body.behavior === 'allow' ? 'allow' : 'deny';
    const result = await decideIntervention({
      missionId: entry.sessionId,
      interventionId: requestId,
      payload: behavior === 'allow'
        ? { action: 'allow', updatedInput: body.updatedInput, ...(body.scope === 'session' ? { scope: 'session' } : {}) }
        : { action: 'deny', message: body.message || 'denied by user' },
      source: 'legacy_permission',
      contractRequest: false,
    });
    if (result.status !== 200) return send(res, json({ ok: false, error: 'unknown or expired request' }, 404));
    return send(res, json({ ok: true }));
  }
  if (req.method === 'POST' && pathname === '/api/plan/decision') {
    // 75b compatibility adapter for the classic plan-mode pause.
    const body = await readJsonBody(req);
    const planId = String(body.planId || '');
    const sessionId = String(body.sessionId || '');
    const entry = pendingPlans.get(planId);
    if (!entry || entry.sessionId !== sessionId) return send(res, json({ ok: false, error: 'no pending plan' }));
    const decision = body.decision === 'approve' ? 'approve' : 'reject';
    const result = await decideIntervention({
      missionId: sessionId,
      interventionId: planId,
      payload: { action: decision, feedback: body.note != null ? String(body.note) : '' },
      source: 'legacy_plan',
      contractRequest: false,
    });
    if (result.status !== 200) return send(res, json({ ok: false, error: 'no pending plan' }));
    return send(res, json({ ok: true }));
  }
  // 75a-2: test-only CAS primitive probe (failure-injection matrix, SCHEMA §7 六窗口). Env-gated
  // (RUYI_TEST_HOOKS=1) + token; production returns 404. Not a user-facing route -- 75b 的统一契约端点
  // POST /api/missions/:missionId/interventions/:id/decision 才是对外入口。
  if (req.method === 'POST' && pathname === '/api/_test/intervention-cas') {
    if (process.env.RUYI_TEST_HOOKS !== '1') return send(res, json({ ok: false, error: 'not found' }, 404));
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const body = await readJsonBody(req);
    let result;
    try {
      // 116c: source 可由请求指定(默认仍是 'test',既有用例逐字节不变)——让 CAS 矩阵能直接验证
      // source:'steward' 的成功/版本冲突/越权三条路径在命令核心里走的是同一套判定与同一条落盘格式。
      result = await transitionInterventionState(body.sessionId, body.ivId, body.expectedVersion, body.toStatus || 'allowed', {
        crashAt: body.crashAt, decidedBy: body.decidedBy, source: String(body.source || 'test').slice(0, 64),
        action: body.actionMs ? () => new Promise(r => setTimeout(r, Number(body.actionMs) || 0)) : undefined,
      });
    } catch (e) {
      const m = String((e && e.message) || '');
      if (m.startsWith('__cas_crash:')) return send(res, json({ ok: false, reason: 'crash', at: m.slice('__cas_crash:'.length) }));
      throw e;
    }
    return send(res, json(result));
  }
  return false;
}

// ── 116c(27 号文 §11.3「116c ... steward_run_action ... 如果动作逻辑内联在路由里,先把它零行为抽成
// 可调用函数(同模块),路由改为调用它」)────────────────────────────────────────────────────────
// 五个班组动作(pause/resume/stop/retry_node/steer_node)的实现从 POST /api/agent-runs/:runId 路由体里
// 零行为搬出:每个分支原来的 `send(res, json(BODY, STATUS))` 逐个换成 `return { status, body }`,判定
// 顺序、措辞、计数(bumpRunIntervention)、事件(appendAgentRunEvent)与落盘时机一字未改。
// 不在本函数内处理的动作(apply_isolation / pool_approve / pool_reject / 未知动作)返回 null,由路由
// 沿用原有分支继续处理 —— 这样搬家对 HTTP 面是逐字节等价的。
// 归属校验(live.run.sessionId !== sessionId -> 404)在函数内【再做一次】:进程内调用方(管家)不经过
// 路由体那道闸,fail-closed 的重复判定比信任调用方便宜得多。
async function agentRunActionCommand(input) {
  const o = (input && typeof input === 'object') ? input : {};
  const sessionId = safeSessionId(o.sessionId);
  const runId = safeSessionId(o.runId);
  const action = String(o.action || '');
  if (!sessionId || !runId) return { status: 400, body: { ok: false, error: 'sessionId/runId required' } };
  const live = activeAgentRuns.get(runId);
  if (live && live.run && live.run.sessionId && live.run.sessionId !== sessionId) return { status: 404, body: { ok: false, error: 'agent run not found' } };
  if (action === 'pause') {
    if (!live) return { status: 409, body: { ok: false, error: '工作流当前未运行' } };
    // 对抗轮 P3(#8): 计数按【状态迁移】幂等 —— 对已暂停 run 重复 POST(UI 按钮态滞后期双击/双面板)端点行为
    // 无害但计数器会被 UI 时延系统性抬高。只在真正 running→paused 时计一次干预(与本文件 pool_approve 先查
    // status!=='proposed' 的"无效重复不计干预"模式一致)。
    const wasPaused = live.paused === true;
    live.paused = true; live.run.pauseRequestedAt = nowIso();
    if (!wasPaused) bumpRunIntervention(live.run, 'pause'); // 29c(状态迁移才计)
    appendAgentRunEvent(live.run, { type: 'run_paused', data: { reason: 'user' } }); // 25.3
    await saveAgentRun(live.run);
    return { status: 200, body: { ok: true, state: 'pausing' } };
  }
  if (action === 'resume') {
    if (live) {
      // Reset the idle clock ATOMICALLY with clearing paused: the watchdog reads live.lastActivityAt, so by the
      // time it observes paused=false the clock is already fresh -> no false idle-abort right after a long pause.
      const wasPaused = live.paused === true; // 对抗轮 P3(#8): 仅 paused→running 计一次(对运行中 run resume 是 no-op,不计)
      live.paused = false; live.lastActivityAt = Date.now(); const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake();
      if (wasPaused) bumpRunIntervention(live.run, 'resume'); // 29c
      appendAgentRunEvent(live.run, { type: 'run_resume_requested', data: { mode: 'warm' } }); // 25.3
      saveAgentRun(live.run).catch(() => {}); // 对抗轮修: 追写快照,让 eventSeq 尽快落盘(缩小崩溃重号窗口)
      return { status: 200, body: { ok: true, state: 'running' } };
    }
    return { status: 200, body: await launchPersistedAgentRun({ sessionId, runId, interventionKind: 'resume' }) };
  }
  if (action === 'stop') {
    if (!live) return { status: 409, body: { ok: false, error: '工作流当前未运行' } };
    const wasStopping = live.stopRequested === true; // 对抗轮 P3(#8): 重复 stop 不重复计
    live.stopRequested = true; live.paused = false; try { if (live.ctrl) live.ctrl.abort(); } catch {}
    const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake();
    if (!wasStopping) bumpRunIntervention(live.run, 'stop'); // 29c
    appendAgentRunEvent(live.run, { type: 'run_stop_requested' }); // 25.3
    saveAgentRun(live.run).catch(() => {}); // 对抗轮修: 同 resume —— 追写快照缩小 eventSeq 崩溃重号窗口
    return { status: 200, body: { ok: true, state: 'stopping' } };
  }
  if (action === 'retry_node') {
    if (live) return { status: 409, body: { ok: false, error: '请先等待或停止当前运行' } };
    const nodeId = String(o.nodeId || '').trim();
    return { status: 200, body: await launchPersistedAgentRun({ sessionId, runId, retryNodeId: nodeId, retryCascade: o.cascade === true, interventionKind: 'retry_node' }) };
  }
  // Directional node steering. Provider nodes consume at their next iteration boundary; Claude nodes consume
  // through the live stream-json stdin channel. Queued nodes keep the message until their model starts.
  if (action === 'steer_node') {
    if (!live) return { status: 409, body: { ok: false, error: '工作流当前未运行，无法插话' } };
    // 停止收尾窗口：stop 已经请求（或 ctrl 已中止）之后，节点即将被标记 cancelled，不会再有下一次迭代边界来
    // 消费插话队列；此时接受插话只会让用户误以为它会生效，直接拒绝更诚实。
    if (live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted)) return { status: 409, body: { ok: false, error: '工作流正在停止，无法插话' } };
    const nodeId = String(o.nodeId || '').trim();
    if (!nodeId) return { status: 400, body: { ok: false, error: 'nodeId required' } };
    // 团队模式 v2 (B1): 投递资格判定与 send_to_agent 共用同一小函数(不复制两份),reason 各自映射为本处既有措辞。
    const elig = nodeDeliveryEligibility(live.run, nodeId, { allowClaude: true });
    if (elig.reason === 'not_found') return { status: 404, body: { ok: false, error: '节点不存在' } };
    if (elig.reason === 'deterministic_gate') return { status: 409, body: { ok: false, error: '确定性质量门节点不经过模型，无法插话' } };
    if (elig.reason === 'terminal') return { status: 409, body: { ok: false, error: '节点已结束，无法插话' } };
    const text = String(o.text || '').trim().slice(0, 2000);
    if (!text) return { status: 400, body: { ok: false, error: '插话内容不能为空' } };
    if (!live.steerQueues) live.steerQueues = new Map();
    let q = live.steerQueues.get(nodeId);
    if (!q) { q = []; live.steerQueues.set(nodeId, q); }
    if (q.length >= STEER_QUEUE_MAX) return { status: 409, body: { ok: false, error: '该节点插话队列已满' } };
    q.push(text);
    bumpRunIntervention(live.run, 'steer_node'); // 29c(队列在内存,计数随下一次快照落盘即可,不额外写盘)
    return { status: 200, body: { ok: true, queued: q.length, live: elig.node.status === 'running' } };
  }
  return null; // 本函数不认识的动作(apply_isolation / pool_* / 未知)——由路由沿用原分支
}

async function handleAgentRunApiRoutes(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/agent-runs') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const listUrl = new URL(req.url, 'http://x');
    const sessionId = safeSessionId(listUrl.searchParams.get('sessionId'));
    if (!sessionId) return send(res, json({ ok: false, error: 'sessionId required' }, 400));
    const runs = await listAgentRuns(sessionId);
    // A live run's in-memory state is newer than its throttled crash-recovery snapshot. Return a detached
    // copy of that state for the full polling view, otherwise short nodes can finish before their intermediate
    // progressLog snapshot is ever observable and the UI falsely looks frozen.
    for (let i = 0; i < runs.length; i += 1) {
      const live = activeAgentRuns.get(runs[i].id);
      if (!live || !live.run) continue;
      runs[i] = { ...JSON.parse(JSON.stringify(live.run)), live: true, paused: !!live.paused };
    }
    // 第29波(§29a): digest 轻量视图 —— 增量客户端每 tick 只拉这份 run 级标量做变更探测(eventSeq/status/
    // updatedAt),不再每 2s 重传全部节点(单节点 result≤24KB + roleSnapshot 8KB prompt,历史终态 run 每 tick
    // 白传)。live run 的 eventSeq/status/updatedAt 以【内存】为准(快照节流 1.5s,磁盘恒旧);快照仍是唯一
    // 权威状态源,digest 只是"该不该去拉"的信号。
    if (listUrl.searchParams.get('view') === 'digest') {
      const digest = runs.map(r => {
        const live = activeAgentRuns.get(r.id);
        const mem = live && live.run ? live.run : null;
        return {
          id: r.id, status: mem ? mem.status : r.status, eventSeq: Number((mem || r).eventSeq) || 0,
          updatedAt: (mem || r).updatedAt || '', createdAt: r.createdAt || '', completedAt: (mem || r).completedAt || '',
          nodeCount: Array.isArray((mem || r).nodes) ? (mem || r).nodes.length : 0,
          poolPending: ((mem || r).taskPool || []).filter(p => p && p.status === 'proposed').length,
          live: !!live, paused: !!(live && live.paused), persistenceDegraded: !!(mem && mem.persistenceDegraded) || r.persistenceDegraded === true,
          resumeTier: (mem || r).resumeTier || '', pendingReview: !!(mem || r).pendingReview,
          anyRunning: Array.isArray((mem || r).nodes) && (mem || r).nodes.some(n => n && (n.status === 'running' || n.status === 'waiting_resource')),
        };
      });
      return send(res, json({ ok: true, view: 'digest', runs: digest }));
    }
    return send(res, json({ ok: true, runs }));
  }
  // 第29波(§29a): 增量事件消费 —— 客户端记住 lastSeq,断线/重开后 afterSeq=lastSeq 重发即天然补播;
  // seq 严格单调(25.3)保证补播无重无漏。必须排在文件底部 GET /api/agent-runs/:id 通配前缀分支之前,
  // 否则被吞。跨会话防护与快照端点同源:事件文件按 sessionId 分目录,错 session 只会 404→空数组。
  if (req.method === 'GET' && pathname.startsWith('/api/agent-runs/') && pathname.endsWith('/events')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const evUrl = new URL(req.url, 'http://x');
    const sessionId = safeSessionId(evUrl.searchParams.get('sessionId'));
    const evParts = pathname.split('/').filter(Boolean); // ['api','agent-runs',runId,'events']
    const runId = evParts.length === 4 ? safeSessionId(evParts[2]) : null;
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    const afterSeq = Number(evUrl.searchParams.get('afterSeq')) || 0;
    const { events, hasMore } = await readAgentRunEvents(sessionId, runId, afterSeq, Number(evUrl.searchParams.get('limit')) || 0);
    return send(res, json({ ok: true, runId, afterSeq, events, hasMore }));
  }
  if (req.method === 'POST' && pathname.startsWith('/api/agent-runs/')) {
    const parts = pathname.split('/').filter(Boolean);
    const runId = safeSessionId(parts[2]);
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId);
    const action = String(body.action || '');
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    const live = activeAgentRuns.get(runId);
    // runId 是全局命名空间（不像持久化文件那样按 sessionId 分目录），live runtime 挂在内存 Map 里也不天然按
    // sessionId 隔离——不加这层校验，一个知道/猜到 runId 的会话就能 pause/resume/stop/steer 另一个会话正在跑的
    // 工作流。对齐 apply_isolation 从文件读到 run 后做的 run.sessionId !== sessionId 校验语义，统一在这里拦截，
    // 对 pause/resume/stop/steer_node 全部生效；resume 的冷启动分支（live 为空）走 launchPersistedAgentRun，
    // 本来就按 sessionId 找持久化文件，不受影响。
    if (live && live.run && live.run.sessionId && live.run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
    // 116c: pause/resume/stop/retry_node/steer_node 五个动作的实现搬到 agentRunActionCommand(同模块,
    // 零行为);本路由只做 HTTP 适配。其余动作(apply_isolation / pool_*)返回 null,继续走下面的原分支。
    {
      const cmd = await agentRunActionCommand({ sessionId, runId, action, nodeId: body.nodeId, text: body.text, cascade: body.cascade === true });
      if (cmd) return send(res, json(cmd.body, cmd.status));
    }
    if (action === 'apply_isolation') {
      if (live) return send(res, json({ ok: false, error: '请先等待当前运行结束' }, 409));
      const nodeId = String(body.nodeId || '').trim();
      const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8').catch(() => ''), null);
      if (!run || run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
      const applied = await applyAgentWorktree(run, nodeId).catch(e => ({ ok: false, error: String(e && (e.gitStderr || e.message) || e) }));
      return send(res, json(applied, applied.ok ? 200 : 409));
    }
    // 75b compatibility adapter: pool approval/rejection shares decideIntervention with the Mission contract.
    if (action === 'pool_approve' || action === 'pool_reject') {
      const poolId = String(body.poolId || '').trim();
      if (!poolId) return send(res, json({ ok: false, error: 'poolId required' }, 400));
      const result = await decideIntervention({
        missionId: sessionId,
        interventionId: poolId,
        requestRunId: runId,
        payload: { action: action === 'pool_approve' ? 'approve' : 'reject' },
        source: 'legacy_pool',
        contractRequest: false,
      });
      if (result.status !== 200) {
        const reason = String(result.body && result.body.reason || '');
        if (!live || live.closing) return send(res, json({ ok: false, error: '运行已结束;可在新运行中执行该任务' }, 409));
        if (reason === 'not_found') return send(res, json({ ok: false, error: '提案不存在' }, 404));
        const item = (Array.isArray(live.run.taskPool) ? live.run.taskPool : []).find(p => p && String(p.id) === poolId);
        if (item && item.status !== 'proposed') return send(res, json({ ok: false, error: `该提案已处理(${item.status})` }, 409));
        const message = result.body && result.body.error && result.body.error.message;
        return send(res, json({ ok: false, error: message || '运行已结束或提案已处理' }, result.status === 404 ? 404 : 409));
      }
      return send(res, json({
        ok: true,
        status: action === 'pool_approve' ? 'materialized' : 'rejected',
        poolId,
        ...(result.body.nodeId ? { nodeId: result.body.nodeId } : {}),
      }));
    }
    return send(res, json({ ok: false, error: 'unknown action' }, 400));
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/agent-runs/')) {
    const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));
    const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    if (activeAgentRuns.has(runId)) return send(res, json({ ok: false, error: '运行中的工作流不能删除' }, 409));
    try {
      const file = agentRunFile(sessionId, runId);
      const run = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
      for (const node of (run && run.nodes || [])) if (node.isolation) await cleanupAgentWorktree(node.isolation);
      await fsp.unlink(file);
      // 对抗轮修(第25波): 删除快照必须连带删姊妹事件日志 —— 用户删「运行记录」的心智模型是数据消失,
      // 取证 ndjson(含时间线/错误切片)不该在删除后无限期残留。
      await fsp.unlink(agentRunEventsFile(sessionId, runId)).catch(() => {});
      await fsp.unlink(agentRunEventsFile(sessionId, runId) + '.gz').catch(() => {}); // v1.9 数据管家: 归档压缩变体一并删
    } catch { return send(res, json({ ok: false, error: 'agent run not found' }, 404)); }
    await bumpMissionChangeSeq(sessionId, {
      type: 'run_deleted', cursor: { runId }, detail: { runId },
    });
    return send(res, json({ ok: true }));
  }
  if (req.method === 'GET' && pathname.startsWith('/api/agent-runs/')) {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
    const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));
    if (!sessionId || !runId) return send(res, apiFailure('agent_run.id_required', {}, 'sessionId/runId required', 400));
    // 第29波(§29a): live run 以【内存】对象下发 —— 增量客户端在 settle 类事件后靠本端点刷新单 run 状态,
    // 磁盘快照节流 1.5s 恒旧,读盘会让客户端 lastSeq 与状态错位(拿旧状态配新 seq)。JSON.stringify 同步
    // 执行,事件循环内原子,无撕裂读。归属校验与 POST action 的 live 分支同源(sessionId 不符 = 404)。
    const liveOne = activeAgentRuns.get(runId);
    if (liveOne && liveOne.run) {
      if (liveOne.run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
      return send(res, json({ ok: true, run: { ...liveOne.run, live: true, paused: !!liveOne.paused } }));
    }
    try {
      const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8'), null);
      if (!run) throw new Error('invalid run');
      return send(res, json({ ok: true, run }));
    } catch { return send(res, json({ ok: false, error: 'agent run not found' }, 404)); }
  }
  return false;
}
