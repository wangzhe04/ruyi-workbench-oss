// ============================================================================
// v2 跨会话记忆(团队模式 v2 Phase 3, 设计稿 C0-C5)。文件型记忆库 + 起草-确认写入 + 围栏式渐进注入。
// 与 <project-memory>(CLAUDE.md,作者=仓库)分工(C0):本库作者=用户+AI 经确认,随工作台走。注入标签
// <workbench-memory>、UI 一律称「工作台记忆」。存储:dataRoot()/memory/{global,project/<projectKey>}/<id>.md。
// ============================================================================
const MEMORY_TYPES = new Set(['convention', 'lesson', 'reference']);
const MEMORY_INDEX_CAP = 2000; // 注入索引整段字符上限(C3)
const MEMORY_MAX = 8;          // 会话启用上限(C3)
const MEMORY_RELEVANCE_MAX = 3; // 默认检索每轮最多注入 3 条，避免记忆库增长后线性抬高输入 token
const MEMORY_EXCLUSION_MAX = 256; // 默认检索模式下的会话级排除项上限
const MEMORY_METADATA_READ_CAP = 16 * 1024; // 注册表只读文件头；命中后才由模型按需读取完整正文

// frontmatter 单行值消毒:去换行(parseFrontmatter 按行 key: value 解析,值里的换行会破坏结构)。
function fmVal(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim(); }

function memoryGlobalDir() { return path.join(paths.memory, 'global'); }
// projectKey(C1 评审修订)= sha256(path.resolve 后、win32 再 toLowerCase 的 cwd)截 16 hex。沿用资源键大小写
// 规范化先例(fileAllowedRoots 的 win 去重),防 C:\\Foo 与 c:\\foo 分裂成两个项目组。
function projectKeyForCwd(cwd) {
  let p = path.resolve(String(cwd || ''));
  if (process.platform === 'win32') p = p.toLowerCase();
  return crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16);
}
function memoryProjectDir(cwd) { return path.join(paths.memory, 'project', projectKeyForCwd(cwd)); }

// 组目录内写 meta.json(明文 path+label+createdAt),面板反查不依赖 recentWorkspaces(LRU 会逐出)。原子写。
async function writeMemoryMeta(dir, cwd) {
  try {
    const metaPath = path.join(dir, 'meta.json');
    const abs = path.resolve(String(cwd || ''));
    let createdAt = nowIso();
    try { const prev = safeJsonParse(await fsp.readFile(metaPath, 'utf8'), null); if (prev && prev.createdAt) createdAt = prev.createdAt; } catch { /* 无旧 meta */ }
    const meta = { path: abs, label: path.basename(abs) || abs, createdAt };
    await atomicWriteJson(metaPath, meta);   // 25.1 收编
  } catch { /* meta 失败不阻断写入 */ }
}

// 读一个 memory 目录下所有 <id>.md → Map<id, entry>。id 须过 SKILL_ID_RE(防穿越);frontmatter 复用
// parseFrontmatter(键已小写:createdAt→createdat 等)。description 回退首个正文段(firstParaDesc)。
async function readMemoryDir(dir, scope) {
  const out = new Map();
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return out; } // 目录不存在 → 空(零开销短路)
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    const id = f.slice(0, -3);
    if (!SKILL_ID_RE.test(id)) continue;
    const file = path.join(dir, f);
    let raw = '';
    // 260KB 是与写侧一致的文件准入上限，避免“保存后从列表消失”；注册表检索本身只读前 16KB，
    // 足够覆盖工作台生成的受限 frontmatter + 首段说明，完整正文留到命中后按需读取。
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > 260 * 1024) continue;
      const fh = await fsp.open(file, 'r');
      try {
        const buf = Buffer.allocUnsafe(Math.min(st.size, MEMORY_METADATA_READ_CAP));
        const read = await fh.read(buf, 0, buf.length, 0);
        raw = buf.subarray(0, read.bytesRead).toString('utf8');
      } finally { await fh.close().catch(() => {}); }
    } catch { continue; }
    const fm = parseFrontmatter(raw);
    const type = MEMORY_TYPES.has(fm.type) ? fm.type : 'reference';
    out.set(id, {
      id, scope,
      name: (fm.name || id).slice(0, 120),
      description: (fm.description || firstParaDesc(raw)).slice(0, 400),
      type, file,
      createdAt: fm.createdat || '',
      sourceSessionId: fm.sourcesessionid || '',
      sourceRunId: fm.sourcerunid || '',
    });
  }
  return out;
}

// loadMemoryRegistry(cwd) → [{id, scope, name, description, type, file(绝对路径), createdAt, ...}]。global +
// 当前 cwd 的 projectKey 组;按 createdAt 倒序(C4,无自动过期)。
async function loadMemoryRegistry(cwd) {
  const out = [];
  for (const [, e] of await readMemoryDir(memoryGlobalDir(), 'global')) out.push(e);
  if (cwd) for (const [, e] of await readMemoryDir(memoryProjectDir(cwd), 'project')) out.push(e);
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.name).localeCompare(String(b.name)));
  return out;
}

// 扫描 project/ 下各组(除当前组)的 meta.json + 记忆条目,供面板「迁移到当前项目」列出旧项目组(C1)。
async function listMemoryProjectGroups(excludeKey) {
  const base = path.join(paths.memory, 'project');
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === excludeKey) continue;
    const entries = [...(await readMemoryDir(path.join(base, d.name), 'project')).values()];
    if (!entries.length) continue;
    let meta = null; try { meta = safeJsonParse(await fsp.readFile(path.join(base, d.name, 'meta.json'), 'utf8'), null); } catch { meta = null; }
    out.push({ projectKey: d.name, path: (meta && meta.path) || '', label: (meta && meta.label) || d.name, count: entries.length, items: entries.map(e => ({ id: e.id, name: e.name })) });
  }
  return out;
}

// 读单条记忆全文(含正文,供编辑弹窗回填)。
async function readMemoryItem(id, scope, cwd) {
  const safe = String(id || '');
  if (!SKILL_ID_RE.test(safe)) return { ok: false, error: 'invalid memory id' };
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  const file = path.join(dir, safe + '.md');
  let raw = '';
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return { ok: false, error: 'memory not found' }; }
  const fm = parseFrontmatter(raw);
  const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
  const type = MEMORY_TYPES.has(fm.type) ? fm.type : 'reference';
  return { ok: true, memory: { id: safe, scope, name: fm.name || safe, description: fm.description || '', type, body, createdAt: fm.createdat || '', file } };
}

// 保存一条记忆(原子写 tmp+rename)。id 缺省合成;scope=global|project;正文 + frontmatter。返回 {ok, memory}。
async function saveMemory(mem, cwd) {
  const m = (mem && typeof mem === 'object') ? mem : {};
  let id = String(m.id || '').trim();
  if (!id) id = 'mem-' + crypto.randomBytes(4).toString('hex');
  if (!SKILL_ID_RE.test(id)) return { ok: false, error: '无效的记忆 id(仅限字母/数字/_-,长度 1..64)' };
  const scope = m.scope === 'global' ? 'global' : 'project';
  const name = fmVal(m.name).slice(0, 120);
  const description = fmVal(m.description).slice(0, 400);
  const type = MEMORY_TYPES.has(m.type) ? m.type : 'reference';
  const bodyText = String(m.body || '').trim();
  if (!name || !bodyText) return { ok: false, error: '记忆的名称与正文不能为空' };
  // P3-1: 正文上限 256KB(与 readMemoryDir 的读上限对齐)—— 超限直接拒绝,杜绝「保存成功却因超读上限从列表消失」的幽灵。
  if (bodyText.length > 256 * 1024) return { ok: false, error: '记忆正文超过 256KB 上限' };
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
  if (scope === 'project') await writeMemoryMeta(dir, cwd);
  const dest = path.join(dir, id + '.md');
  let createdAt = nowIso();
  try { const prev = await fsp.readFile(dest, 'utf8'); const pfm = parseFrontmatter(prev); if (pfm.createdat) createdAt = pfm.createdat; } catch { /* 新建 */ }
  const fmLines = ['---', 'name: ' + name, 'description: ' + description, 'type: ' + type, 'createdAt: ' + createdAt];
  if (m.sourceSessionId) fmLines.push('sourceSessionId: ' + fmVal(String(m.sourceSessionId)).slice(0, 120));
  if (m.sourceRunId) fmLines.push('sourceRunId: ' + fmVal(String(m.sourceRunId)).slice(0, 120));
  fmLines.push('---', '', bodyText, '');
  const content = fmLines.join('\n');
  // 对抗轮 P2: 上限须与 readMemoryDir 的读上限(st.size,UTF-8 字节)同量纲——上面的 bodyText.length 是 UTF-16 字符数,
  // 中文正文每字落盘 3 字节,9 万字中文会"保存成功却超读上限从列表消失"。按最终落盘内容字节数复核(含 frontmatter)。
  if (Buffer.byteLength(content, 'utf8') > 260 * 1024) return { ok: false, error: '记忆正文超过 256KB 上限(按 UTF-8 字节计,中文约 8 万字)' };   // 260KB=正文上限+frontmatter 余量,与读侧一致
  // 第25波 25.1: 收编 atomicWriteJson(载荷是 markdown 字符串,直接透传;获得 rename 重试 + 失败清 tmp)。
  await atomicWriteJson(dest, content);
  return { ok: true, memory: { id, scope, name, description, type, file: dest, createdAt } };
}

async function deleteMemory(id, scope, cwd) {
  const safe = String(id || '');
  if (!SKILL_ID_RE.test(safe)) return { ok: false, error: 'invalid memory id' };
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  const file = path.join(dir, safe + '.md');
  try { await fsp.access(file); } catch { return { ok: false, error: 'memory not found' }; }
  await fsp.unlink(file).catch(() => {});
  return { ok: true, deleted: safe, scope };
}

// 迁移一条项目记忆到当前 cwd 的项目组(C1:项目移动/改名后 projectKey 变,旧组记忆搬到新组)。移动文件。
async function migrateMemory(id, fromKey, targetCwd) {
  const safe = String(id || '');
  if (!SKILL_ID_RE.test(safe)) return { ok: false, error: 'invalid memory id' };
  if (!/^[a-f0-9]{16}$/.test(String(fromKey || ''))) return { ok: false, error: 'invalid source project key' };
  const targetKey = projectKeyForCwd(targetCwd);
  if (targetKey === fromKey) return { ok: false, error: '该记忆已在当前项目组' };
  const srcFile = path.join(paths.memory, 'project', fromKey, safe + '.md');
  let content = '';
  try { content = await fsp.readFile(srcFile, 'utf8'); } catch { return { ok: false, error: 'source memory not found' }; }
  const destDir = memoryProjectDir(targetCwd);
  const dest = path.join(destDir, safe + '.md');
  // P2-4: 目标项目组已存在同名记忆 → 拒绝迁移(不覆盖、不删源),让用户先重命名或删除。探测在建目录前做,避免为
  // 注定失败的迁移建空目录/写 meta。conflict:true 让上层映射 409(与 400 一般失败区分)。
  try { await fsp.access(dest); return { ok: false, conflict: true, error: '目标项目组已存在同名记忆(' + safe + '),请先重命名或删除' }; } catch { /* dest 不存在 → 可迁移 */ }
  try { await fsp.mkdir(destDir, { recursive: true }); } catch { /* 已存在 */ }
  await writeMemoryMeta(destDir, targetCwd);
  await atomicWriteJson(dest, content);   // 第25波 25.1: 收编(同 saveMemory)
  await fsp.unlink(srcFile).catch(() => {});
  return { ok: true, id: safe, scope: 'project' };
}

// draftMemoryFromSession(sessionId): 镜像 draftPlaybookFromSession —— 仅 provider 引擎,取会话近况让模型起草
// {name, description, type, body};providerRawCompletion + aux 台账 note:'memory-draft'。解析容错仿 parsePlaybookDraft。
async function draftMemoryFromSession(sessionId) {
  const config = await readConfig();
  const provider = activeOpenAiProvider(config);
  if (!provider) return { ok: false, error: '存为记忆需要 provider 引擎(Claude 引擎请用手写表单直接保存)' };
  let session;
  try { session = await loadSession(String(sessionId || '')); } catch { return { ok: false, error: 'session not found' }; }
  if (!session) return { ok: false, error: 'session not found' };
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  const recent = msgs.slice(-8).map(m => {
    const role = m && m.role === 'assistant' ? 'AI' : (m && m.role === 'user' ? '用户' : '');
    if (!role) return '';
    return role + ': ' + String((m && m.content) || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  }).filter(Boolean).join('\n');
  if (!recent.trim()) return { ok: false, error: '本会话没有可参考的对话内容' };
  const instruction = [
    '你是一个把「一次会话里沉淀出来的、值得长期记住的经验/项目惯例/教训」抽象成一条可复用记忆的助手。',
    '根据下面这次会话的近况,产出一条「工作台记忆」的 JSON。要求:',
    '1. 只提炼真正值得跨会话复用的内容(项目惯例、踩过的坑与规避办法、稳定的参考事实);琐碎与一次性内容不要。',
    '2. 输出 JSON 字段:{ "name","description","type","body" }。',
    '   - name: 简短标题(不超过 40 字);description: 一句话说明何时有用(不超过 120 字);',
    '   - type 从 ["convention"(项目惯例),"lesson"(教训),"reference"(参考资料)] 里选一个;',
    '   - body: markdown 正文,写清「结论 + 适用场景 + 具体做法」,给未来的 AI 助手看。',
    '3. 只输出 JSON,不要任何解释、不要 markdown 代码围栏。',
    '',
    '这次会话近况:',
    recent.slice(0, 4000),
  ].join('\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    const userMsg = attempt === 0 ? instruction : (instruction + '\n\n上一次输出不是合法 JSON。请只输出一个合法的 JSON 对象,不要任何多余字符。');
    const sc = await providerRawCompletion(provider, [{ role: 'user', content: userMsg }]);
    try {
      const u = sc && sc.usage;
      const inTok = u ? (Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0) : 0;
      const outTok = u ? (Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0) : 0;
      const cachedInTok = cachedInputTokensFromUsage(u);
      if (inTok > 0 || outTok > 0) {
        const ledgerModel = sc.model || provider.model || '';
        const { cost, currency } = computeProviderCost(provider, inTok, outTok, cachedInTok, ledgerModel);
        appendUsageLedger({ sessionId: session.id, engine: 'openai', provider: provider.id, model: ledgerModel, inTok, outTok, cachedInTok, cost, currency, estimated: false, turnSeq: session.turnSeq, kind: 'aux', note: 'memory-draft' });
      }
    } catch { /* 记账绝不可影响起草 */ }
    if (!sc.ok) { if (attempt === 1) return { ok: false, error: sc.error }; continue; }
    const draft = parseMemoryDraft(sc.content);
    if (draft) return { ok: true, draft: { ...draft, sourceSessionId: session.id } };
  }
  return { ok: false, error: '模型未能产出合法的记忆 JSON,请稍后再试或手动编辑' };
}

// 容错解析模型的记忆 JSON:剥 markdown 围栏、取最外层 {…}、JSON.parse、字段消毒。返回 {name,description,type,body} 或 null。
function parseMemoryDraft(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  const raw = safeJsonParse(s, null);
  if (!raw || typeof raw !== 'object') return null;
  const name = fmVal(raw.name).slice(0, 120);
  const body = String(raw.body || '').trim();
  if (!name || !body) return null;
  const type = MEMORY_TYPES.has(raw.type) ? raw.type : 'reference';
  const description = fmVal(raw.description).slice(0, 400);
  return { name, description, type, body };
}

// buildMemoryPromptSection(entries, engine): <workbench-memory> 围栏 + 「参考资料,不得覆盖以上守则」声明 +
// 每行 name/描述/文件绝对路径(两引擎都给路径:provider 用 file_read、Claude 用 Read;dataRoot 在允许根内,
// Claude 侧靠 --add-dir 可达)。伪造围栏标记中和(尖括号→方括号,同 skill/project-memory fence)。整段 ≤2000 截断保闭合。
function buildMemoryPromptSection(entries, engine, config, conflicts) {
  const mems = (Array.isArray(entries) ? entries : []).filter(m => m && m.file);
  if (!mems.length) return '';
  const fence = t => String(t).replace(/<(\/?)workbench-memory/gi, '[$1workbench-memory');
  const tool = engine === 'claude' ? 'Read' : 'file_read';
  const header = getPromptPack(config && config.locale).memoryHeader(tool);
  // R4: conflicts=Map<memoryId,Set<conflictId>>(仅 confirmed contradicts,由 buildMemoryConflictMap 产出)。
  // 处于冲突的记忆追加 [冲突:见 id] 标记,两条都注入,不由模型静默择一(设计稿 §4 红线)。undefined -> 无标记,向后兼容。
  const conflictMap = (conflicts && typeof conflicts.has === 'function') ? conflicts : null;
  const body = [];
  for (const m of mems) {
    const desc = fence(String(m.description || '').replace(/\s+/g, ' ').trim().slice(0, 160));
    const name = fence(String(m.name || m.id));
    let line = '- ' + name + ' [' + m.id + '](' + m.file + '):' + desc;
    if (conflictMap && conflictMap.has(m.id)) {
      const peers = [...conflictMap.get(m.id)].slice(0, 4).join(',');
      line += ' [冲突:见 ' + peers + ']';
    }
    body.push(line);
  }
  const OPEN = '\n<workbench-memory>\n', CLOSE = '\n</workbench-memory>', TRUNC = '\n' + getPromptPack(config && config.locale).memoryTruncated;
  let text = body.join('\n');
  const budget = MEMORY_INDEX_CAP - header.length - OPEN.length - CLOSE.length;
  if (text.length > budget) text = text.slice(0, Math.max(0, budget - TRUNC.length)) + TRUNC;
  return header + OPEN + text + CLOSE;
}

// 每轮都注入一个很小的机器可读检索回执。即使零命中也存在，避免模型把“本轮无匹配”误说成
// “工作台没有记忆机制”；同时明确记忆只是参考信息，不会扩大用户授权。
function buildMemoryCheckPrompt(status, config) {
  if (!status || typeof status !== 'object') return '';
  const pack = getPromptPack(config && config.locale);
  const safe = n => Math.max(0, Math.floor(Number(n) || 0));
  const mode = ['default', 'fixed', 'disabled', 'unavailable'].includes(status.mode) ? status.mode : 'default';
  return pack.memoryCheck({
    mode,
    enabled: status.enabled !== false,
    checked: status.checked === true,
    candidates: safe(status.candidateCount),
    matches: safe(status.matchCount),
    projectMatches: safe(status.projectMatches),
    globalMatches: safe(status.globalMatches),
    excluded: safe(status.excludedCount),
  });
}

// ============================================================================
// R4 Local Memory Graph(设计稿 docs/optimization-plan/15-r4-memory-graph.md)。
// 给已确认工作台记忆加 supports/contradicts/supersedes/derived_from 关系边。模型只 propose(confirmed:false),
// 用户 confirm/delete。边按 scope+projectKey 隔离;pending 不进检索;confirmed contradicts 在注入时双向标记。
// 不建全局跨项目索引(evidenceRef 只存 eventId 不存原文,与 R1 同纪律)。
// ============================================================================
const MEMORY_RELATION_TYPES = new Set(['supports', 'contradicts', 'supersedes', 'derived_from']);
const MEMORY_RELATION_CAP = 512; // per-scope 边数硬上限(威胁 4:防膨胀)

function memoryRelationsFile(scope, cwd) {
  return scope === 'global'
    ? path.join(memoryGlobalDir(), '_relations.json')
    : path.join(memoryProjectDir(cwd), '_relations.json');
}

// 读一个 scope 的关系数组(空文件/不存在 -> [])。不做过滤,过滤由 listMemoryRelations 按 confirmed 分桶。
async function readMemoryRelations(scope, cwd) {
  const file = memoryRelationsFile(scope, cwd);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const arr = safeJsonParse(raw, null);
    if (!Array.isArray(arr)) return [];
    return arr.filter(r => r && typeof r === 'object' && SKILL_ID_RE.test(r.id)
      && MEMORY_RELATION_TYPES.has(r.type) && SKILL_ID_RE.test(String(r.from)) && SKILL_ID_RE.test(String(r.to)));
  } catch { return []; }
}

async function writeMemoryRelations(scope, cwd, arr) {
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
  if (scope === 'project') await writeMemoryMeta(dir, cwd);
  await atomicWriteJson(memoryRelationsFile(scope, cwd), arr);
}

// listMemoryRelations(cwd, scope, opts) -> {ok, relations, pending, confirmed}。opts.includePending=false 时
// relations 仅含 confirmed(默认,供检索/UI);true 时含全部(供提议者复核)。scope 缺省读 project。
async function listMemoryRelations(cwd, scope, opts = {}) {
  const sc = scope === 'global' ? 'global' : 'project';
  const all = await readMemoryRelations(sc, cwd);
  const confirmed = all.filter(r => r.confirmed === true);
  const pending = all.filter(r => r.confirmed !== true);
  const relations = opts.includePending ? all : confirmed;
  return { ok: true, scope: sc, relations, pending, confirmed };
}

// proposeMemoryRelation(rel, cwd) -> 创建 confirmed:false 边(模型可调)。校验:type 合法、from!=to、
// from/to 同 scope 内已存在、未超 per-scope 上限、无重复(from+to+type 已存在的 confirmed 不再重复提议)。
async function proposeMemoryRelation(rel, cwd, opts = {}) {
  const r = (rel && typeof rel === 'object') ? rel : {};
  const type = String(r.type || '');
  if (!MEMORY_RELATION_TYPES.has(type)) return { ok: false, error: '无效的关系类型(仅 supports/contradicts/supersedes/derived_from)' };
  const from = String(r.from || '').trim();
  const to = String(r.to || '').trim();
  if (!SKILL_ID_RE.test(from) || !SKILL_ID_RE.test(to)) return { ok: false, error: 'from/to 须为合法记忆 id(字母/数字/_-,1..64)' };
  if (from === to) return { ok: false, error: 'from 与 to 不能相同' };
  const scope = r.scope === 'global' ? 'global' : 'project';
  // 隔离红线(威胁 1):from/to 必须都在该 scope 内已存在,杜绝跨 scope/幽灵 id 建边。
  const dir = scope === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  const reg = await readMemoryDir(dir, scope);
  if (!reg.has(from) || !reg.has(to)) return { ok: false, error: 'from 或 to 在目标 scope 内不存在(拒绝跨 scope 建边)' };
  const all = await readMemoryRelations(scope, cwd);
  if (all.length >= MEMORY_RELATION_CAP) return { ok: false, error: '该 scope 关系边已达上限 ' + MEMORY_RELATION_CAP + '(清理 pending 后重试)' };
  const dup = all.find(x => x.from === from && x.to === to && x.type === type);
  if (dup) return { ok: false, error: dup.confirmed ? '同形关系已确认,无需重复' : '同形关系已处于 pending', relation: dup };
  const id = 'rel-' + crypto.randomBytes(4).toString('hex');
  const evidenceRefRaw = SKILL_ID_RE.test(String(r.evidenceRef || '')) ? String(r.evidenceRef).slice(0, 256) : '';
  // R4-S2: 自动提议路径传 opts.evidenceCatalog(= run.evidence)时,校验 evidenceRef 是否为该 run 真实 eventId。
  // API 手动提议无 catalog -> evidenceRefVerified=false(仅存档,见设计稿 §9)。
  const evidenceRefVerified = evidenceRefRaw && Array.isArray(opts && opts.evidenceCatalog)
    ? opts.evidenceCatalog.some(e => e && e.eventId === evidenceRefRaw)
    : false;
  const entry = {
    id, type, from, to, scope,
    evidenceRef: evidenceRefRaw,
    evidenceRefVerified,
    confirmed: false,
    createdAt: nowIso(),
    sourceRunId: fmVal(String(r.sourceRunId || '')).slice(0, 120),
    note: fmVal(String(r.note || '')).slice(0, 200),
  };
  all.push(entry);
  await writeMemoryRelations(scope, cwd, all);
  try { appendUsageLedger({ engine: 'openai', kind: 'aux', note: 'memory-relation-propose', meta: { id, type, from, to, scope } }); } catch { /* 审计失败不阻断 */ }
  return { ok: true, relation: entry };
}

// confirmMemoryRelation(id, cwd) -> confirmed:false->true(仅用户调)。只置标志,不改 from/to/type/scope(威胁 7)。
// 跨 scope 查找:project 找不到再查 global(用户确认时不必区分 scope,但改写仍落回原 scope 文件)。
async function confirmMemoryRelation(id, cwd) {
  if (!SKILL_ID_RE.test(String(id || ''))) return { ok: false, error: '无效的关系 id' };
  for (const scope of ['project', 'global']) {
    const all = await readMemoryRelations(scope, cwd);
    const idx = all.findIndex(x => x.id === id);
    if (idx < 0) continue;
    if (all[idx].confirmed === true) return { ok: false, error: '该关系已确认', relation: all[idx] };
    all[idx].confirmed = true; // 仅此一字段;其余忽略(防偷换)
    await writeMemoryRelations(scope, cwd, all);
    try { appendUsageLedger({ engine: 'openai', kind: 'aux', note: 'memory-relation-confirm', meta: { id, scope } }); } catch { /* 审计失败不阻断 */ }
    return { ok: true, relation: all[idx] };
  }
  return { ok: false, error: '关系不存在' };
}

// deleteMemoryRelation(id, cwd) -> 删边(仅用户调)。跨 scope 查找同 confirm。
async function deleteMemoryRelation(id, cwd) {
  if (!SKILL_ID_RE.test(String(id || ''))) return { ok: false, error: '无效的关系 id' };
  for (const scope of ['project', 'global']) {
    const all = await readMemoryRelations(scope, cwd);
    const idx = all.findIndex(x => x.id === id);
    if (idx < 0) continue;
    const removed = all.splice(idx, 1)[0];
    await writeMemoryRelations(scope, cwd, all);
    try { appendUsageLedger({ engine: 'openai', kind: 'aux', note: 'memory-relation-delete', meta: { id, scope, type: removed.type } }); } catch { /* 审计失败不阻断 */ }
    return { ok: true, relation: removed };
  }
  return { ok: false, error: '关系不存在' };
}

// buildMemoryConflictMap(cwd) -> Map<memoryId, Set<conflictId>>。仅 confirmed contradicts;pending 不计入(威胁 6)。
// 两端记忆都进入 map(双向),供 buildMemoryPromptSection 标记。global 与 project 分别读后合并。
async function buildMemoryConflictMap(cwd) {
  const map = new Map();
  const add = (a, b) => { if (!map.has(a)) map.set(a, new Set()); map.get(a).add(b); };
  for (const scope of ['project', 'global']) {
    const all = await readMemoryRelations(scope, cwd);
    for (const r of all) {
      if (r.confirmed === true && r.type === 'contradicts') { add(r.from, r.to); add(r.to, r.from); }
    }
  }
  return map;
}

// extractMemoryRelationProposals(structuredResult, run) -> 纯函数:从 gate 节点结构化输出提取记忆关系提议。
// 只做提取+基础过滤(type 合法、from/to 合法 id、from!=to);不落盘、不校验记忆是否存在(由 proposeMemoryRelation 负责)。
// 返回 [{type, from, to, evidenceRef, note, sourceRunId, scope}](scope 默认 project;sourceRunId 取 run.id)。
// 09-workflow 节点收尾时调用,逐项 proposeMemoryRelation(confirmed:false),用户后续确认。
function extractMemoryRelationProposals(structuredResult, run) {
  const sr = (structuredResult && typeof structuredResult === 'object') ? structuredResult : null;
  const raw = Array.isArray(sr && sr.memoryRelations) ? sr.memoryRelations : [];
  const runId = (run && typeof run.id === 'string') ? run.id : '';
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    if (!MEMORY_RELATION_TYPES.has(type)) continue;
    const from = String(item.from || '').trim();
    const to = String(item.to || '').trim();
    if (!SKILL_ID_RE.test(from) || !SKILL_ID_RE.test(to) || from === to) continue;
    const evidenceRef = SKILL_ID_RE.test(String(item.evidenceRef || '')) ? String(item.evidenceRef).slice(0, 256) : '';
    out.push({
      type, from, to, evidenceRef,
      note: fmVal(String(item.note || '')).slice(0, 200),
      sourceRunId: runId,
      scope: 'project',
    });
  }
  return out.slice(0, 20); // schema maxItems=20 兜底
}

// R4-S3:按单一 scope 的 confirmed 关系做确定性连通分量聚类，并给出「复核建议」而非自动过期。
// 高优先级：confirmed `A supersedes B` -> 建议复核 B；低优先级：创建已久且没有任何 confirmed
// 关系的孤立记忆 -> 建议复核。createdAt 年龄不等价于“未使用”，故绝不据此自动删/禁用。
// opts.now 仅供确定性测试；staleDays 默认 180，边界 30..3650。
async function analyzeMemoryMaintenance(cwd, scope, opts = {}) {
  const sc = scope === 'global' ? 'global' : 'project';
  const staleDays = Math.min(3650, Math.max(30, Math.round(Number(opts.staleDays) || 180)));
  const parsedNow = opts.now instanceof Date ? opts.now.getTime() : Date.parse(String(opts.now || ''));
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const dir = sc === 'global' ? memoryGlobalDir() : memoryProjectDir(cwd);
  const memories = await readMemoryDir(dir, sc);
  const allRelations = await readMemoryRelations(sc, cwd);
  const confirmed = allRelations.filter(r => r.confirmed === true);
  const valid = confirmed.filter(r => memories.has(r.from) && memories.has(r.to));
  const orphanedRelations = allRelations
    .filter(r => !memories.has(r.from) || !memories.has(r.to))
    .map(r => ({ id: r.id, type: r.type, from: r.from, to: r.to, confirmed: r.confirmed === true,
      missing: [!memories.has(r.from) ? r.from : '', !memories.has(r.to) ? r.to : ''].filter(Boolean) }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // 聚类把 4 种 confirmed 关系都视为“相关”无向边；方向与语义仍保留在 relationTypes/关系存储中。
  // pending 不参与，防模型自提议边改变聚类/过期判断。
  const adjacency = new Map();
  const edgeIdsByMemory = new Map();
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  for (const r of valid) {
    add(adjacency, r.from, r.to); add(adjacency, r.to, r.from);
    add(edgeIdsByMemory, r.from, r.id); add(edgeIdsByMemory, r.to, r.id);
  }
  const visited = new Set();
  const clusters = [];
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    const stack = [start], ids = [], relationIds = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id); ids.push(id);
      for (const relId of (edgeIdsByMemory.get(id) || [])) relationIds.add(relId);
      for (const peer of (adjacency.get(id) || [])) if (!visited.has(peer)) stack.push(peer);
    }
    ids.sort();
    if (ids.length < 2) continue;
    const rels = valid.filter(r => relationIds.has(r.id));
    const dates = ids.map(id => Date.parse(String(memories.get(id).createdAt || ''))).filter(Number.isFinite).sort((a, b) => a - b);
    clusters.push({
      id: 'cluster-' + crypto.createHash('sha256').update(sc + '\0' + ids.join('\0')).digest('hex').slice(0, 12),
      memoryIds: ids,
      relationIds: [...relationIds].sort(),
      relationTypes: [...new Set(rels.map(r => r.type))].sort(),
      size: ids.length,
      conflictCount: rels.filter(r => r.type === 'contradicts').length,
      oldestAt: dates.length ? new Date(dates[0]).toISOString() : '',
      newestAt: dates.length ? new Date(dates[dates.length - 1]).toISOString() : '',
    });
  }
  clusters.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));

  const replacementByTarget = new Map();
  const supersedeRelationsByTarget = new Map();
  for (const r of valid) if (r.type === 'supersedes') {
    add(replacementByTarget, r.to, r.from);
    add(supersedeRelationsByTarget, r.to, r.id);
  }
  const ageDaysOf = memory => {
    const created = Date.parse(String(memory && memory.createdAt || ''));
    return Number.isFinite(created) ? Math.max(0, Math.floor((nowMs - created) / 86400000)) : null;
  };
  const expirySuggestions = [];
  for (const [id, memory] of [...memories.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ageDays = ageDaysOf(memory);
    let reason = '', priority = '', replacements = [], relationIds = [];
    if (replacementByTarget.has(id)) {
      reason = 'superseded'; priority = 'high';
      replacements = [...replacementByTarget.get(id)].sort();
      relationIds = [...supersedeRelationsByTarget.get(id)].sort();
    } else if (ageDays != null && ageDays >= staleDays && !adjacency.has(id)) {
      reason = 'stale_isolated'; priority = 'low';
    } else continue;
    expirySuggestions.push({
      id: 'suggestion-' + crypto.createHash('sha256').update(sc + '\0' + id + '\0' + reason + '\0' + replacements.join('\0')).digest('hex').slice(0, 12),
      memoryId: id, name: memory.name, reason, priority, action: 'review', ageDays,
      replacementMemoryIds: replacements, relationIds, autoApplied: false,
    });
  }
  expirySuggestions.sort((a, b) => (a.priority === b.priority ? a.memoryId.localeCompare(b.memoryId) : (a.priority === 'high' ? -1 : 1)));
  return {
    ok: true, scope: sc, staleDays, generatedAt: new Date(nowMs).toISOString(),
    stats: { memories: memories.size, confirmedRelations: confirmed.length, pendingRelations: allRelations.length - confirmed.length,
      clusters: clusters.length, expirySuggestions: expirySuggestions.length, orphanedRelations: orphanedRelations.length },
    clusters, expirySuggestions, orphanedRelations,
  };
}

// 第26波b: buildMissionPromptSection(mission, engine) —— <mission-ledger> 围栏,注入目标/里程碑进度/约束,
// 让模型每回合都知道「整体目标是什么、还差哪几步」。fits-or-drop 语义(≤1200,超则整段丢,防截断毁闭合围栏);
// 伪造围栏中和(同 memory/skill fence);内容为「当前任务状态」参考,不得覆盖守则。两引擎共用(对称)。
const MISSION_DIGEST_CAP = 1200;
function buildMissionPromptSection(mission, engine, config) {
  if (!mission || !mission.goal || !Array.isArray(mission.milestones) || !mission.milestones.length) return '';
  const fence = t => String(t == null ? '' : t).replace(/<(\/?)mission-ledger/gi, '[$1mission-ledger').replace(/\s+/g, ' ').trim();
  const tool = engine === 'claude' ? 'mission_update' : 'mission_update';
  const doneN = mission.milestones.filter(m => m.status === 'done').length;
  const lines = [];
  lines.push(getPromptPack(config && config.locale).mission.header);
  lines.push(getPromptPack(config && config.locale).mission.goal(fence(mission.goal).slice(0, 400)));
  lines.push(getPromptPack(config && config.locale).mission.progress(doneN, mission.milestones.length));
  for (const m of mission.milestones) {
    const mark = m.status === 'done' ? '✓' : m.status === 'blocked' ? '✗' : '·';
    lines.push(getPromptPack(config && config.locale).mission.milestone(mark, fence(m.id), fence(m.desc).slice(0, 160), m.status === 'blocked'));
  }
  if (mission.constraints && mission.constraints.length) lines.push(getPromptPack(config && config.locale).mission.constraints(mission.constraints.map(c => fence(c).slice(0, 120)).join(';').slice(0, 300)));
  lines.push(getPromptPack(config && config.locale).mission.guide(tool));
  const OPEN = '\n<mission-ledger>\n', CLOSE = '\n</mission-ledger>';
  let text = lines.join('\n');
  const budget = MISSION_DIGEST_CAP - OPEN.length - CLOSE.length;
  if (text.length > budget) return ''; // fits-or-drop:超预算整段丢,绝不中途截断(毁闭合围栏)
  return OPEN + text + CLOSE;
}

// 默认检索的轻量词项抽取：ASCII 单词 + 中文二元组。这里只扫描 registry 的 name/description/id，
// 不读取正文，故每轮成本与文件大小无关；正文仍由模型在确认相关后按需读取。
const MEMORY_QUERY_STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'please', 'help', 'look', 'check', 'today',
  '用户', '帮我', '看下', '看看', '这个', '那个', '今天', '现在', '可以', '直接', '继续', '推进', '一下', '相关',
]);
function memorySearchTerms(text) {
  const src = String(text || '').normalize('NFKC').toLowerCase();
  const out = new Set();
  for (const m of src.matchAll(/[a-z0-9][a-z0-9_.-]{1,63}/g)) {
    const term = m[0].replace(/^[_.-]+|[_.-]+$/g, '');
    if (term.length >= 2 && !MEMORY_QUERY_STOP.has(term)) out.add(term);
    // snake_case / kebab-case id 既保留全词也拆分，确保任务里的模块名能命中记忆 id 的稳定片段。
    for (const part of term.split(/[_.-]+/)) if (part.length >= 2 && !MEMORY_QUERY_STOP.has(part)) out.add(part);
  }
  for (const m of src.matchAll(/[\u3400-\u9fff]{2,32}/g)) {
    const run = m[0];
    if (run.length <= 6 && !MEMORY_QUERY_STOP.has(run)) out.add(run);
    for (let i = 0; i < run.length - 1; i++) {
      const pair = run.slice(i, i + 2);
      if (!MEMORY_QUERY_STOP.has(pair)) out.add(pair);
    }
  }
  return [...out].slice(0, 96);
}

function rankRelevantMemories(registry, query, limit = MEMORY_RELEVANCE_MAX) {
  const queryTerms = memorySearchTerms(query);
  const ranked = [];
  for (const entry of (Array.isArray(registry) ? registry : [])) {
    if (!entry || !entry.id) continue;
    const hay = [entry.id, entry.name, entry.description, entry.type].filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
    let shared = 0;
    for (const term of queryTerms) if (hay.includes(term)) shared += Math.min(12, Math.max(2, term.length));
    // convention 是默认应遵守的稳定约定，即使用户没复述关键词也参与候选；lesson/reference 必须有词项命中。
    if (!shared && entry.type !== 'convention') continue;
    const score = shared * 10 + (entry.scope === 'project' ? 4 : 0) + (entry.type === 'convention' ? 2 : 0);
    ranked.push({ entry, score });
  }
  ranked.sort((a, b) => b.score - a.score
    || String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || ''))
    || String(a.entry.id).localeCompare(String(b.entry.id)));
  return ranked.slice(0, Math.max(0, Number(limit) || MEMORY_RELEVANCE_MAX)).map(x => x.entry);
}

function memoryExclusionSet(session, cwd) {
  const curKey = projectKeyForCwd(cwd);
  const out = new Set();
  for (const raw of (Array.isArray(session && session.memoryExclusions) ? session.memoryExclusions : []).slice(0, MEMORY_EXCLUSION_MAX)) {
    const id = String((raw && raw.id) || '').trim();
    if (!id) continue;
    const scope = raw && raw.scope === 'global' ? 'global' : 'project';
    if (scope === 'project' && raw.projectKey && String(raw.projectKey) !== curKey) continue;
    out.add(scope + ':' + id);
  }
  return out;
}

// 会话启用选择:显式设置过(memoriesExplicit)→ 固定使用 session.memories(≤8)；否则项目 + 全局均默认
// 进入元数据相关性检索，memoryExclusions 仅排除当前会话明确关闭的条目。
function effectiveMemorySelection(session, registry, cwd) {
  if (session && session.memoriesExplicit === true) {
    return (Array.isArray(session.memories) ? session.memories : [])
      .map(m => {
        const id = String((m && m.id) || '').trim();
        const scope = (m && m.scope === 'global') ? 'global' : 'project';
        const o = { id, scope };
        // P3-3: 透传 project 条目锁定的 projectKey(供 resolveEnabledMemoryEntries 换 cwd 失配校验);global 无此概念。
        if (scope === 'project' && m && m.projectKey) o.projectKey = String(m.projectKey);
        return o;
      })
      .filter(m => m.id);
  }
  const excluded = memoryExclusionSet(session, cwd);
  return (Array.isArray(registry) ? registry : [])
    .filter(e => e && e.id && !excluded.has(e.scope + ':' + e.id))
    .map(e => ({ id: e.id, scope: e.scope === 'global' ? 'global' : 'project' }));
}

// resolveMemoryPreflight:每条用户消息的工作台记忆预检。默认模式只扫描 global + 当前项目的元数据并取 Top-3；
// 显式模式沿用固定选择，显式空数组表示本会话关闭。无匹配也返回 checked=true 的状态供提示/UI 展示。
// {id,scope} 锁定:scope 不匹配(启用时 project、现只剩 global 同 id)→ 跳过;文件消失(幽灵)→ 跳过。P3-3:project
// 条目再按 projectKey 锁定,换 cwd 失配 → 跳过并经 onSourceMismatch(id,was,now) 通知一次。
async function resolveMemoryPreflight(session, cwd, query, onSourceMismatch) {
  let registry = [];
  try { registry = await loadMemoryRegistry(cwd); } catch {
    return { entries: [], status: { mode: 'unavailable', enabled: true, checked: false, candidateCount: 0, matchCount: 0, projectMatches: 0, globalMatches: 0, excludedCount: 0 } };
  }
  const explicit = !!(session && session.memoriesExplicit === true);
  const exclusions = explicit ? new Set() : memoryExclusionSet(session, cwd);
  const sel = effectiveMemorySelection(session, registry, cwd);
  if (explicit && !sel.length) {
    return { entries: [], status: { mode: 'disabled', enabled: false, checked: false, candidateCount: 0, matchCount: 0, projectMatches: 0, globalMatches: 0, excludedCount: 0 } };
  }
  const curKey = projectKeyForCwd(cwd);
  const byKey = new Map(registry.map(e => [e.scope + ':' + e.id, e]));
  const eligible = [];
  const seen = new Set();
  for (const s of sel) {
    const key = s.scope + ':' + s.id;
    if (seen.has(key)) continue;
    // P3-3: project 条目锁定「启用当时的 projectKey」。换了项目目录(当前 cwd 的 projectKey 与之不符)→ 跳过注入并
    // 通知一次(即便当前项目恰有同 id 记忆也不顶替,防调包)。空 projectKey = 旧数据宽松匹配(下次保存固化)。
    if (s.scope === 'project' && s.projectKey && s.projectKey !== curKey) {
      seen.add(key);
      if (typeof onSourceMismatch === 'function') { try { onSourceMismatch(s.id, s.projectKey, curKey); } catch { /* 通知失败不阻断 */ } }
      continue;
    }
    const e = byKey.get(key);
    if (!e) continue; // 幽灵 / scope 不匹配 → 跳过注入
    seen.add(key);
    eligible.push(e);
    if (explicit && eligible.length >= MEMORY_MAX) break;
  }
  const entries = explicit ? eligible : rankRelevantMemories(eligible, query, MEMORY_RELEVANCE_MAX);
  return {
    entries,
    status: {
      mode: explicit ? 'fixed' : 'default', enabled: true, checked: true,
      candidateCount: eligible.length, matchCount: entries.length,
      projectMatches: entries.filter(e => e.scope === 'project').length,
      globalMatches: entries.filter(e => e.scope === 'global').length,
      excludedCount: exclusions.size,
    },
  };
}

// 兼容旧调用方/测试：未提供 query 时仍走默认元数据检索，返回条目数组。
async function resolveEnabledMemoryEntries(session, cwd, onSourceMismatch, query) {
  const result = await resolveMemoryPreflight(session, cwd, query || '', onSourceMismatch);
  return result.entries;
}

// Best-effort model list from a provider's OpenAI-style GET /models. Never throws.
async function fetchOpenAiModels(provider, timeoutMs = 4000) {
  const base = providerBaseWithV1(provider && provider.baseUrl);
  if (!base || typeof fetch !== 'function') return { ok: false, error: base ? 'fetch unavailable' : 'no base URL', models: [] };
  const key = String((provider && provider.apiKey) || '').trim();
  const headers = { 'content-type': 'application/json' };
  if (key) headers['authorization'] = 'Bearer ' + key;
  if (provider && provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
  try {
    const res = await fetch(base + '/models', { headers, signal: ctrl ? ctrl.signal : undefined });
    if (!res || !res.ok) return { ok: false, error: 'HTTP ' + (res ? res.status : '?'), models: [] };
    const body = await res.json();
    const data = Array.isArray(body && body.data) ? body.data : (Array.isArray(body) ? body : []);
    // v1.0.2-S2: 同时保留上游条目里的 context_length 类字段(取第一个正数), 存为 contextLength,
    // 并按 provider+model 写入探测缓存(TTL 10 分钟), 供 providerContextWindow 解析激活模型时查用。
    const models = data
      .map(m => {
        if (typeof m === 'string') return { id: m, label: m };
        const id = String(m.id || m.model || '').trim();
        const out = { id, label: id };
        const ctx = extractContextLength(m);
        if (ctx) out.contextLength = ctx;
        return out;
      })
      .filter(m => m.id);
    const providerId = provider && provider.id;
    for (const m of models) if (m.contextLength) cacheContextLength(providerId, m.id, m.contextLength);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'fetch failed'), models: [] };
  } finally { if (timer) clearTimeout(timer); }
}

// v0.6: expose the workbench's own tools to a native provider as OpenAI function-calling schema.
// Same tools the MCP server exposes (minus the internal permission bridge), filtered by the
// command/desktop toggles. The native agent loop executes them in-process via toolCall().
// v0.9-S6: `opts` gates the two sub-agent-specific behaviors (all optional; the top-level provider turn
// passes none, preserving prior behavior):
//   opts.tierFilter : 'read' | 'edit' | 'exec' — keep only tools at or below this native tier (used by
//     runSubAgent to enforce toolTier: read=only read-tier, edit=read+edit, exec=all). Absent → no filter.
//   opts.noSpawnAgent : true → never include spawn_agent (禁嵌套: sub-turns pass this). The top-level turn
//     omits it and instead lets the subagentMaxPerTurn>0 check below decide.
function adaptiveMetaToolSchemas(includeInvoke = false) {
  const tools = [
    {
      name: 'list_tools',
      description: 'List the compact Ruyi tool directory when you are unsure what capability or tool name to search for. Returns names grouped by pack, without descriptions or schemas; use tool_search next for details and risk tier.',
      inputSchema: { type: 'object', properties: { pack: { type: 'string', description: 'Optional exact pack id to list.' }, cursor: { type: 'number', description: 'Optional zero-based cursor from a previous response.' }, limit: { type: 'number', description: 'Maximum names, 1..200. Defaults to 200 (normally the complete catalog).' } } },
    },
    {
      name: 'tool_search',
      description: 'Search the compact Ruyi tool catalog when the currently loaded tools do not cover the task. Returns matching names, packs, risk tiers, and short descriptions without injecting every schema.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Capability or operation to find, e.g. Excel chart, screenshot, git commit.' }, limit: { type: 'number', description: 'Maximum matches, 1..20.' } }, required: ['query'] },
    },
    {
      name: 'tool_load',
      description: 'Load one or more tool packs or exact tool names into the next model call. Use tool_search first when unsure; after this succeeds, call the newly available concrete tool.',
      inputSchema: { type: 'object', properties: { packs: { type: 'array', items: { type: 'string' }, description: 'Pack ids returned by tool_search.' }, tools: { type: 'array', items: { type: 'string' }, description: 'Exact tool names returned by tool_search.' } } },
    },
  ];
  if (includeInvoke) {
    for (const tier of ['read', 'edit', 'exec']) tools.push({
      name: `tool_invoke_${tier}`,
      description: `Invoke one discovered ${tier}-tier Ruyi tool by exact name. The workbench independently verifies the target risk tier and rejects mismatches.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Exact tool name from tool_search.' }, arguments: { type: 'object', description: 'Arguments matching that tool schema.' } }, required: ['name'] },
    });
  }
  return tools;
}

function buildOpenAiTools(config, caps, opts) {
  const allowCmd = config.allowCommandTools !== false;
  const allowDesk = config.allowDesktopTools !== false;
  const out = [];
  const SHELL_TOOLS = new Set(['shell_start', 'shell_send', 'shell_poll', 'shell_kill', 'shell_list']);
  const tierRank = { read: 0, edit: 1, exec: 2 };
  const tierFilter = opts && opts.tierFilter;
  const maxRank = (tierFilter && tierFilter in tierRank) ? tierRank[tierFilter] : null; // null → no tier filter
  const noSpawnAgent = !!(opts && opts.noSpawnAgent);
  // v0.9-S6: spawn_agent is offered only when the feature is enabled (subagentMaxPerTurn>0) AND not
  // explicitly suppressed (sub-turns pass noSpawnAgent → 禁嵌套). 0 = feature off → tool never registered.
  const spawnAgentEnabled = !noSpawnAgent && Number(config.subagentMaxPerTurn) > 0;
  // v0.8-S6: gate tools whose runtime requirements (TOOL_REQUIRES) are unmet by the capability matrix. The
  // testOnly entry only fires when config.enableToolRequiresProbe is set (see TOOL_REQUIRES note), so this
  // is inert in production until v0.9 populates the table. buildProviderSystemPrompt lists the filtered
  // tools under 「当前不可用」 so the model is told why they're absent.
  const toolRequiresEnabled = !!(config && config.enableToolRequiresProbe);
  for (const t of MCP_TOOLS) {
    if (t.name === 'list_tools' || t.name === 'tool_search' || t.name === 'tool_load' || t.name.startsWith('tool_invoke_')) continue;
    if (t.name === 'permission_prompt') continue;
    if (t.name === 'request_user_input' && noSpawnAgent) continue;
    if ((t.name === 'spawn_agent' || t.name === 'orchestrate_agents') && !spawnAgentEnabled) continue;
    if (!allowCmd && (t.name === 'powershell_run' || t.name === 'script_run' || SHELL_TOOLS.has(t.name))) continue;
    if (!allowDesk && (t.name === 'desktop_screenshot' || t.name === 'keyboard_send_keys')) continue;
    // v0.9-S6: toolTier filter for sub-turns — drop any tool above the requested tier. spawn_agent (exec)
    // is already suppressed for sub-turns via noSpawnAgent, so it never survives an 'exec' sub-turn either.
    if (maxRank !== null && (tierRank[nativeToolTier(t.name)] ?? 2) > maxRank) continue;
    if (caps && !toolRequirementsMet(t.name, caps, toolRequiresEnabled, config).met) continue; // requirement unmet → drop
    out.push({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } } });
  }
  // Provider-turn control plane for background spawn_agent runs. It is intentionally not part of MCP_TOOLS:
  // the one-shot MCP child has no parent-turn closure, while persisted orchestrate_agents already owns its
  // separate synchronous/async launch route. Top-level Provider turns can collect by explicit runId or, more
  // conveniently, omit runIds to wait for the background agents launched earlier in the same turn.
  if (spawnAgentEnabled) {
    out.push({ type: 'function', function: {
      name: 'wait_agents',
      description: 'Collect results from background spawn_agent runs. Omit runIds to wait for every background Agent launched in the current chat turn, or pass launch-receipt runIds (including from an earlier turn). Waits at most timeoutMs and returns current persisted DAG state if work is still running.',
      parameters: { type: 'object', properties: {
        runIds: { type: 'array', items: { type: 'string' }, description: 'Optional spawn_agent runIds returned by background launch receipts (up to 16).' },
        timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds, 0..60000 (default 30000).' },
      } },
    } });
  }
  // v1 技能体系: skill_read(provider 引擎, read tier)—— 仅在本会话有启用技能时注册(offer 条件由调用方传
  // opts.skillsEnabled 决定,仿 spawn_agent 的 enable 门)。不入 MCP_TOOLS(否则会泄漏给 Claude CLI 且恒开)。
  // 子代理不传 skillsEnabled → 不注册。dispatch 在 toolCall 的 'skill_read' 分支;tier 在 NATIVE_TOOL_TIER。
  if (opts && opts.skillsEnabled) {
    out.push({ type: 'function', function: {
      name: 'skill_read',
      description: '读取一个已启用技能的说明与目录。默认(仅传 id)返回 SKILL.md 全文 + 该技能目录内的文件清单;需要读取清单中的某个文件时,再次调用本工具并额外传 file(相对该技能目录的路径),返回该文件内容。仅能读取当前会话已启用的技能;id 为系统提示技能索引里方括号内的技能 id。',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: '技能 id(见系统提示的技能索引)' },
        file: { type: 'string', description: '可选。技能目录内的相对路径(见清单)。提供后返回该文件内容而非清单;仅限该技能目录内。' },
      }, required: ['id'] },
    } });
  }
  // 团队模式 v2 (A1): propose_task —— 子代理提案追加节点(元工具,provider 引擎,read tier)。仅在工作流子回合且池
  // 策略非 off 时注册(offer 由调用方 opts.proposeTaskEnabled 门控,仿 skill_read/spawn_agent 的 enable 门)。不进
  // MCP_TOOLS(否则泄漏给 Claude CLI 且恒开)。dispatch 在 runSubAgentCore 的专用闭包分支,不走全局 toolCall。
  if (opts && opts.proposeTaskEnabled) {
    out.push({ type: 'function', function: {
      name: 'propose_task',
      description: '当你发现需要一个新的协作节点来完成某个子任务时,提交一个任务提案到本次运行的共享任务池,等待编排者审批。审批通过后它会作为一个新的工作流节点自动执行(走完整的资源/预算/记账管线)。这不会阻塞你——提交后立刻返回,你应继续完成自己当前的任务,不要等待它。',
      parameters: { type: 'object', properties: {
        task: { type: 'string', description: '新节点要完成的具体任务描述(必填)。' },
        roleId: { type: 'string', description: '可选。为新节点指定一个已有的 Agent 角色 id。' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '可选。新节点依赖的现有节点 id 列表;缺省依赖你自己(提案者)。' },
        resources: { type: 'array', items: { type: 'string' }, description: '可选。新节点声明的资源(用于并发排他/只读,格式同工作流节点)。' },
        toolTier: { type: 'string', enum: ['read', 'edit', 'exec'], description: '可选。新节点的工具级别,不得高于你自己的级别。' },
        model: { type: 'string', description: '可选。为新节点按任务难易指定模型 id(从系统提示里列出的、与新节点引擎匹配的可选模型中选;简单/大批量→快、复杂推理→强、其余→均衡;填错会让节点失败)。省略则继承你(提案者)的模型。' },
        reason: { type: 'string', description: '可选。给编排者看的一句话理由。' },
      }, required: ['task'] },
    } });
  }
  // 团队模式 v2 (B1): send_to_agent —— 单向异步节点间消息(元工具,provider 引擎,read tier)。offer 由
  // opts.sendToAgentEnabled 门控(工作流子回合注册)。不阻塞、不等回执;目标下一次调用前投递,投不了则丢弃。
  if (opts && opts.sendToAgentEnabled) {
    out.push({ type: 'function', function: {
      name: 'send_to_agent',
      description: '给同一次运行中的另一个节点发一条单向消息(异步、不阻塞、不等回执)。消息会在目标节点下一次模型调用前作为一条提示注入;若目标已结束/被跳过/是单发节点则被丢弃。用于把你发现的关键事实及时同步给并行的其他节点。',
      parameters: { type: 'object', properties: {
        targetNodeKey: { type: 'string', description: '目标节点的 id(必填)。' },
        message: { type: 'string', description: '要发送的消息内容(必填,最长约 2000 字符)。' },
      }, required: ['targetNodeKey', 'message'] },
    } });
  }
  if ((!opts || !opts.noAdaptiveMeta) && config && config.toolLoadingMode === 'auto') {
    // O1 (hb360): 注入含 tool_invoke_* 的完整 adaptive 元工具集 -- bridged 工具不自动注入 schema 后,
    // 模型需 tool_invoke_read/edit/exec 代理调用(按 tool_search 返回的 tier 选),否则 onDemand 引导的
    // 代理路径无工具可用。原 false 仅注入 list/search/load,OpenAI 引擎主回合缺 tool_invoke_*。
    for (const t of adaptiveMetaToolSchemas(true)) out.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } });
  }
  return out;
}
// Risk tier per tool → drives permission gating in the native loop (read = auto-allow).
const NATIVE_TOOL_TIER = {
  permission_prompt: 'exec', // CLI 权限桥(由 --permission-prompt-tool 触达);原靠 unknown→exec 兜底,第41波显式化
  list_tools: 'read', tool_search: 'read', tool_load: 'read', tool_invoke_read: 'read', tool_invoke_edit: 'edit', tool_invoke_exec: 'exec',
  propose_task: 'read', send_to_agent: 'read', // 团队模式 v2 (A1/B1) 编排元工具 → read tier(纯元数据/入队,不落盘)
  request_user_input: 'read', // waits for an explicit UI answer; no filesystem/exec side effect
  file_read: 'read', file_list: 'read', file_search: 'read', glob: 'read', project_snapshot: 'read', git_status: 'read',
  git_diff: 'read', git_log: 'read', // v1.0-S4: read-only git inspection → auto-allow
  git_commit: 'exec', // v1.0-S4: commit triggers .git/hooks (arbitrary code) → must be exec (never lower)
  dependency_inventory: 'read', code_review_scan: 'read', frontend_audit: 'read', claude_md_audit: 'read', docs_search: 'read',
  mcp_list: 'read', mcp_configure: 'exec',
  todo_write: 'read', // v0.8-S3: writing the task list is a planning act, not a filesystem/exec mutation → auto-allow
  mission_update: 'read', // 第26波b: 更新任务账本是规划/元数据写,非文件/exec 变更 → auto-allow
  skill_read: 'read', // v1 技能体系: 只读已启用技能的 SKILL.md + 目录清单(路径受限该技能目录内)→ auto-allow
  web_search: 'read', web_fetch: 'read', // v0.9-S9: read-only network reads (no local mutation) → auto-allow (SSRF-guarded)
  file_write: 'edit', file_edit: 'edit', file_delete: 'edit', // v0.8-S4a: delete is journaled (revertible) → edit tier
  // v1.1-W2 (T1): 移动/复制/压缩/解压/下载 —— 均落盘且经检查点(可撤销) → edit tier。
  file_move: 'edit', file_copy: 'edit', archive_zip: 'edit', archive_unzip: 'edit', http_download: 'edit',
  powershell_run: 'exec', script_run: 'exec', keyboard_send_keys: 'exec', browser_open: 'exec', office_open: 'exec',
  desktop_screenshot: 'exec', http_request: 'exec',
  spawn_agent: 'exec', // v0.9-S6: delegating a sub-turn is the highest-privilege native act → exec tier
  orchestrate_agents: 'exec',
  wait_agents: 'read',
  // v0.8-S2 shell session族: listing is read-only; start/send/poll/kill mutate state → exec.
  shell_list: 'read', shell_start: 'exec', shell_send: 'exec', shell_poll: 'exec', shell_kill: 'exec',
};
function nativeToolTier(name) { return NATIVE_TOOL_TIER[name] || 'exec'; } // unknown → safest (treat as exec)

// v0.8-S0: risk tiers for BRIDGED (external/desktop MCP) tools, keyed by the UNPREFIXED tool name
// (the bridged name is `serverId__tool`; look up bridge.toolName). Replaces the old flat 'exec' so ACC's
// read-only family (screenshot/OCR/find/inspect/diagnostics/waits/reads) doesn't prompt in 'default' mode.
// Exact-name set below; a few prefix rules follow it. Anything unmatched defaults to 'exec'.
const BRIDGED_READ_TOOLS = new Set([
  'screenshot', 'screenshot_region', 'screenshot_full', 'window_screenshot',
  'ocr_image', 'ocr_screen',
  // 审计 P1: 'ocr_find_text' 有意【不在】read 级 —— 它带 click 参数(click=True 即 pyautogui.click 物理点击,见
  // ocr.py:227/253),被判 read 后 read 子代理可无人值守点击桌面,且 nativeToolGate 对 read 无条件 allow(任何模式
  // 不弹窗)。它落回默认 'exec':read/edit 子代理拿不到,非 bypass 模式点击前弹窗。纯只读文本定位仍可用 ocr_screen/
  // ocr_image(返回全部词+坐标)或 find_on_screen/find_template(模板匹配,无 click、均无 audit → 仍是 read)。
  'find_template', 'find_all_templates', 'find_on_screen',
  'ui_inspect', 'ui_find', 'diagnostics', 'version_info', 'safety_info', 'audit_tail',
  'read_file', 'file_info', 'clipboard_get', 'clipboard_read', 'get_clipboard',
]);
// Prefix rules for read-only families that share a common verb (e.g. get_windows, list_processes,
// wait_for_window_idle). Kept narrow so an 'exec'-shaped verb can't sneak in under a broad prefix.
const BRIDGED_READ_PREFIXES = ['get_', 'list_', 'wait_for_'];
// Resolve a bridged tool's tier: user override (config.bridgedToolTiers) wins, then the built-in table,
// then default 'exec'. `unprefixedName` is bridge.toolName (never the serverId__tool form).
function bridgedToolTier(unprefixedName, config) {
  const overrides = (config && config.bridgedToolTiers && typeof config.bridgedToolTiers === 'object') ? config.bridgedToolTiers : {};
  const ov = overrides[unprefixedName];
  if (ov === 'read' || ov === 'edit' || ov === 'exec') return ov;
  if (BRIDGED_READ_TOOLS.has(unprefixedName)) return 'read';
  if (BRIDGED_READ_PREFIXES.some(p => unprefixedName.startsWith(p))) return 'read';
  return 'exec';
}

const TOOL_PACK_DESCRIPTIONS = Object.freeze({
  core: 'planning, user questions, mission metadata and tool discovery',
  files_read: 'read, list, search and inspect workspace files',
  files_write: 'write, edit, delete, copy and move files',
  code: 'project inspection, code review and git operations',
  shell: 'PowerShell, scripts and persistent shell sessions',
  web: 'web search, fetch, HTTP requests and downloads',
  desktop: 'screenshots, UI inspection and desktop control',
  office: 'Excel, Word, PowerPoint and PDF document operations',
  archive: 'zip and unzip archives',
  agents: 'sub-agents and workflow orchestration',
  skills: 'read enabled skill instructions',
  integrations: 'inspect and configure MCP connectors and browser targets',
  memory: 'cross-session memory read/write/search (memory_save/read/list/delete)',
  thinking: 'step-by-step reasoning chains and sequential thinking',
});
const NATIVE_TOOL_PACKS = Object.freeze({
  permission_prompt: 'core', request_user_input: 'core', todo_write: 'core', mission_update: 'core',
  list_tools: 'core', tool_search: 'core', tool_load: 'core', tool_invoke_read: 'core', tool_invoke_edit: 'core', tool_invoke_exec: 'core',
  file_read: 'files_read', file_list: 'files_read', file_search: 'files_read', glob: 'files_read', project_snapshot: 'files_read',
  file_write: 'files_write', file_edit: 'files_write', file_delete: 'files_write', file_move: 'files_write', file_copy: 'files_write',
  dependency_inventory: 'code', code_review_scan: 'code', frontend_audit: 'code', claude_md_audit: 'code', docs_search: 'code',
  git_status: 'code', git_diff: 'code', git_log: 'code', git_commit: 'code',
  powershell_run: 'shell', script_run: 'shell', shell_start: 'shell', shell_send: 'shell', shell_poll: 'shell', shell_kill: 'shell', shell_list: 'shell',
  web_search: 'web', web_fetch: 'web', http_request: 'web', http_download: 'web', browser_open: 'web',
  desktop_screenshot: 'desktop', keyboard_send_keys: 'desktop', office_open: 'office',
  archive_zip: 'archive', archive_unzip: 'archive', spawn_agent: 'agents', orchestrate_agents: 'agents', wait_agents: 'agents', skill_read: 'skills',
  mcp_list: 'integrations', mcp_configure: 'integrations',
});

function toolPackForName(name, bridgedRoute) {
  if (NATIVE_TOOL_PACKS[name]) return NATIVE_TOOL_PACKS[name];
  const bridge = resolveBridge(bridgedRoute || {}, name);
  const raw = String(bridge ? bridge.toolName : name || '').toLowerCase();
  if (/(excel|spreadsheet|workbook|worksheet|word|docx|document|ppt|powerpoint|slide|pdf|chart_image)/.test(raw)) return 'office';
  if (/(screen|window|mouse|keyboard|click|clipboard|ocr|ui_|desktop|hotkey|type_text|scroll|drag)/.test(raw)) return 'desktop';
  if (/(archive|zip|unzip|compress|extract)/.test(raw)) return 'archive';
  if (/(search|fetch|http|url|browser|download|web)/.test(raw)) return 'web';
  if (/^memory_(save|read|list|delete)$/.test(raw)) return 'memory';
  if (/sequential_thinking/.test(raw)) return 'thinking';
  if (/(read|list|get_|find|inspect|status|info|diagnostic|wait_for_)/.test(raw)) return 'files_read';
  if (/(write|edit|delete|move|copy|create|save|upload)/.test(raw)) return 'files_write';
  return 'desktop'; // unknown external tools are conservative opt-in, never part of simple chat
}

function classifyToolPacks(message, attachments) {
  const s = String(message || '').toLowerCase();
  const packs = new Set(['core']);
  const add = (...xs) => xs.forEach(x => packs.add(x));
  if (Array.isArray(attachments) && attachments.length) add('files_read');
  if (/(文件|目录|路径|源码|代码|项目|repo|repository|file|folder|directory|source|workspace|read|读取|查看|搜索|查找|分析|审查)/i.test(s)) add('files_read');
  if (/(实现|修改|编辑|写入|创建|删除|移动|复制|修复|重构|更新|落盘|implement|modify|edit|write|create|delete|move|copy|fix|refactor|update)/i.test(s)) add('files_read', 'files_write', 'code');
  if (/(代码|编码|编程|bug|测试|构建|依赖|git|commit|push|pull request|typescript|javascript|python|java|rust|go\b|npm|pnpm|yarn|编译)/i.test(s)) add('files_read', 'code');
  if (/(运行|执行|命令|终端|shell|powershell|脚本|测试|构建|安装|启动|重启|部署|run|execute|command|terminal|script|test|build|install|start|restart|deploy)/i.test(s)) add('shell');
  if (/(联网|网页|网站|搜索网络|查新闻|最新|url|https?:|web|internet|online|search the web|fetch)/i.test(s)) add('web');
  if (/(excel|word|powerpoint|pptx?|docx?|pdf|表格|电子表格|工作簿|幻灯片|演示文稿|文档排版)/i.test(s)) add('office', 'files_read', 'files_write');
  if (/(截图|桌面|窗口|鼠标|键盘|点击|屏幕|ocr|screenshot|desktop|window|mouse|keyboard|click)/i.test(s)) add('desktop');
  if (/(压缩|解压|zip|archive|unzip)/i.test(s)) add('archive', 'files_read', 'files_write');
  if (/(子代理|多代理|工作流|并行|agent|orchestrat|delegate)/i.test(s)) add('agents');
  if (/(技能|skill)/i.test(s)) add('skills');
  if (/(mcp|连接器|工具配置|浏览器目标|browser target|connector|tool config)/i.test(s)) add('integrations');
  if (/(记住|记忆|偏好|以后别忘|remember|memorize|preference|recall)/i.test(s)) add('memory');
  if (/(思考|推理|分析|对比|决策|规划|方案|权衡|think|reason|analy|compare|decide|plan|strateg)/i.test(s)) add('thinking');
  return [...packs];
}

function buildToolCatalog(tools, bridgedRoute, config) {
  return (tools || []).map(t => {
    const fn = t && t.function || {};
    const bridge = resolveBridge(bridgedRoute || {}, fn.name);
    return {
      name: fn.name || '', pack: toolPackForName(fn.name, bridgedRoute),
      tier: bridge ? bridgedToolTier(bridge.toolName, config) : nativeToolTier(fn.name),
      bridged: !!bridge,
      description: String(fn.description || '').replace(/\s+/g, ' ').slice(0, 220), tool: t,
    };
  }).filter(x => x.name);
}

function listCompactTools(catalog, args) {
  const pack = String(args && args.pack || '').trim();
  const cursor = Math.max(0, Math.floor(Number(args && args.cursor) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(args && args.limit) || 200)));
  const available = (catalog || []).filter(x => !pack || x.pack === pack)
    .slice().sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
  const page = available.slice(cursor, cursor + limit);
  const groups = {};
  for (const item of page) {
    if (!groups[item.pack]) groups[item.pack] = [];
    groups[item.pack].push(item.name);
  }
  const nextCursor = cursor + page.length < available.length ? cursor + page.length : null;
  return {
    ok: true, pack: pack || null, total: available.length, cursor, count: page.length, nextCursor,
    groups, availablePacks: Object.keys(TOOL_PACK_DESCRIPTIONS),
    next: nextCursor === null ? 'Use tool_search with a capability or exact name for descriptions and risk tiers.' : `Call list_tools again with cursor ${nextCursor}.`,
  };
}

function createToolLoadingState(config, message, attachments, tools, bridgedRoute) {
  const catalog = buildToolCatalog(tools, bridgedRoute, config);
  const full = config && config.toolLoadingMode === 'full';
  const activePacks = new Set(full ? Object.keys(TOOL_PACK_DESCRIPTIONS) : classifyToolPacks(message, attachments));
  const activeNames = new Set();
  const metaNames = new Set(['list_tools', 'tool_search', 'tool_load']);
  // O1 (hb360): auto 模式下桥接工具不按包自动注入 schema（走 tool_invoke_* 代理或 tool_load 显式拉入），
  // 避免单任务注入 100-280 个桥接 schema 导致 input 膨胀（实测均值 303K tokens）。full 模式与元工具/显式拉入不受影响。
  // O4 (hb360) 对抗验证回退: 高频白名单(file_read 始终注入)破坏 adaptive loading 的"按需注入"语义
  // (tool-loading e2e 断言 file_read 在 tool_load 前不注入);且真实任务 classifyToolPacks 已激活 files_read,
  // 白名单仅对纯闲聊任务有用(而闲聊不需要 file_read),收益不抵语义破坏,故回退。
  const current = () => catalog.filter(x => full || metaNames.has(x.name) || activeNames.has(x.name) || (!x.bridged && activePacks.has(x.pack))).map(x => x.tool);
  const search = (query, limit) => {
    const words = String(query || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
    const max = Math.min(20, Math.max(1, Number(limit) || 8));
    const scored = catalog.map(x => {
      const hay = `${x.name} ${x.pack} ${x.description}`.toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? (x.name.toLowerCase().includes(w) ? 3 : 1) : 0), 0);
      return { x, score };
    }).filter(r => !words.length || r.score > 0).sort((a, b) => b.score - a.score || a.x.name.localeCompare(b.x.name)).slice(0, max);
    return { ok: true, query: String(query || ''), matches: scored.map(({ x }) => ({ name: x.name, pack: x.pack, tier: x.tier, description: x.description })), packs: TOOL_PACK_DESCRIPTIONS };
  };
  const load = args => {
    const before = new Set(current().map(t => t.function.name));
    for (const p of Array.isArray(args && args.packs) ? args.packs : []) if (TOOL_PACK_DESCRIPTIONS[p]) activePacks.add(p);
    for (const n of Array.isArray(args && args.tools) ? args.tools : []) if (catalog.some(x => x.name === n)) activeNames.add(n);
    const after = current().map(t => t.function.name);
    return { ok: true, loaded: after.filter(n => !before.has(n)), activePacks: [...activePacks], toolCount: after.length };
  };
  const list = args => listCompactTools(catalog, args);
  return { catalog, activePacks, current, list, search, load, fullCount: catalog.length };
}

function estimateToolSchemaTokens(tools) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  return Math.round(estimateTextTokens(JSON.stringify(tools)));
}

// Decide gate for a tool call given the permission mode. Returns 'allow' | 'ask' | 'block'.
function nativeToolGate(mode, tier) {
  // v1.4.3: accept both 'bypass' (internal) and 'bypassPermissions' (CLI-native) as full-bypass
  if (mode === 'bypass' || mode === 'bypassPermissions') return 'allow';
  if (tier === 'read') return 'allow';
  if (mode === 'plan' || mode === 'dontAsk') return 'block';
  // v1.4.3: 'auto' mode — AI risk-classifier decides. In the native engine we approximate:
  // allow edit-tier (low-risk, reversible) and prompt for exec-tier.
  if (mode === 'auto' && tier === 'edit') return 'allow';
  if (mode === 'acceptEdits' && tier === 'edit') return 'allow';
  return 'ask';
}
// v0.8-S4b B3: which tools produce a change that the checkpoint journal can undo? Exactly the journaled
// file mutations (file_write/file_edit/file_delete → create/modify/delete `before` snapshots). Everything
// else (exec, desktop, network) leaves no journal entry → not auto-revertible. The permission popup shows
// this at the DECISION moment (「✓ 此操作可一键撤销」/「⚠ 此操作无法自动撤销」) — an after-the-fact undo
// card can't reassure a user who was scared off before allowing. Kept as a small set so the UI needn't
// duplicate the tier table; the event carries the boolean directly.
// v1.1-W2 (T1): move/copy/zip/unzip/download 全部走 journalRecord 存 before 快照 → 可撤销，进 REVERTIBLE。
// 名字级承诺(与内建文件工具同保真度):实际快照仍可能因越界/超限被跳过,届时该条在「本轮变更」卡上回落为不可撤销。
const REVERTIBLE_TOOLS = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download']);
function toolIsRevertible(toolName) {
  const n = String(toolName || '');
  if (REVERTIBLE_TOOLS.has(n)) return true;
  // v1.0.2-W1.5 把关补:bridged 写族(ACC write_docx/write_excel/write_pdf/write_file/delete_file)现已由
  // journalBridgedWrite 在分发前存 before 快照 → 权限弹窗的可撤销徽章与「本轮变更」卡(journal 驱动)对齐。
  // 与内建工具同保真度:名字级承诺(实际快照仍可能因越界/超限被跳过,届时该条在变更卡上回落为不可撤销)。
  return Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, unprefixedBridgedName(n));
}
// Ask the UI to approve a native tool call — reuses the pendingPermissions + /api/permission/decision bridge.
// v0.8-S4b: the permission_request event now also carries `tier` (read|edit|exec) and `revertible` (bool)
// so the popup can render a risk badge + a plain-language revertibility line without re-deriving them.
// 第27f波:pause = { enabled, ttlMs, onPause(requestId) } —— 无人值守回合的权限超时【存档暂停】。基础超时到点后不立即拒杀,
// 而是打检查点(onPause)+ 发 permission_paused 事件 + 把决定窗口延长到 ttlMs;窗口内仍可经 /api/permission/decision 决定,
// 到 ttlMs 无人应答则回落 deny(fail-closed)。entry.timer 在 Map 里被重赋为 TTL 定时器,故 clearPendingPermissions/decision 照常清对。
function requestNativePermission(sessionId, toolName, input, onEvent, timeoutMs, tier, pause) {
  return new Promise(resolve => {
    const requestId = makeId('perm');
    onEvent({ type: 'permission_request', requestId, toolName, input, tier: tier || 'exec', revertible: toolIsRevertible(toolName) });
    registerIntervention(sessionId, 'permission', requestId, {
      toolName: String(toolName || ''), tier: tier || 'exec', revertible: toolIsRevertible(toolName),
      // Wave 81: persist the concrete scope shown by the classic prompt so a cross-session
      // decision never degrades into a context-free approval.
      input: input && typeof input === 'object' && !Array.isArray(input) ? input : {},
    });
    let settled = false;
    const settle = (decision, opts = {}) => {
      if (settled) return;
      settled = true;
      // 75b command-core callers persist the CAS terminal row themselves. Automatic timeout/teardown
      // callers omit this flag and keep the legacy self-settling behavior.
      if (opts.skipInterventionSettle !== true) {
        settleIntervention(sessionId, requestId, decision && decision.behavior === 'allow' ? 'allowed' : 'denied', { decidedBy: decision && decision.behavior === 'allow' ? 'user' : 'auto', note: decision && decision.message ? String(decision.message).slice(0, 500) : '' });
      }
      try { onEvent({ type: 'permission_decision', requestId, behavior: decision && decision.behavior === 'allow' ? 'allow' : 'deny', message: decision && decision.message }); } catch { /* stream gone */ }
      resolve(decision);
    };
    const entry = { resolve: settle, sessionId, timer: null };
    const baseMs = Math.max(5000, Number(timeoutMs) || 120000);
    if (pause && pause.enabled) {
      entry.timer = setTimeout(() => {
        try { if (pause.onPause) pause.onPause(requestId); } catch { /* 检查点失败不阻断 */ }
        try { onEvent({ type: 'permission_paused', requestId, toolName, tier: tier || 'exec', ttlMs: pause.ttlMs }); } catch { /* stream gone */ }
        entry.timer = setTimeout(() => {
          const message = '权限已存档暂停但在时限内无人决定,已回落拒绝';
          runAutomaticInterventionDecision({
            missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
            idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
          }, () => {
            if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
            pendingPermissions.delete(requestId);
            settle({ behavior: 'deny', message, pausedTimeout: true });
          });
        }, Math.max(60000, Number(pause.ttlMs) || 2700000));
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
          settle({ behavior: 'deny', message });
        });
      }, baseMs);
    }
    pendingPermissions.set(requestId, entry);
  });
}

// v0.9-S5: does a first assistant message look like a PLAN? Tolerant: strip leading whitespace, then accept
// `PLAN:` (any case) or the Chinese 「计划:」/「计划：」. Returns true so the caller enters the plan pause; a
// non-matching first answer falls back to the legacy hard-block plan behavior (backward compatible).
function looksLikePlan(text) {
  const t = String(text || '').replace(/^\s+/, '');
  return /^plan\s*[:：]/i.test(t) || /^计划\s*[:：]/.test(t);
}
// v0.9-S5: emit a `plan` event and PAUSE the turn until the UI decides (or the timeout auto-rejects). Mirrors
// requestNativePermission but on the plan channel. Resolves { decision:'approve'|'reject', note? }. The
// timeout is REJECT (per spec: 超时=permissionTimeoutMs → 视为 reject). clearPendingPlans (abort/stop/turn-end)
// also settles the promise as reject so the awaiting loop can never hang.
function requestPlanApproval(sessionId, markdown, onEvent, timeoutMs) {
  return new Promise(resolve => {
    const planId = makeId('plan');
    onEvent({ type: 'plan', planId, markdown: String(markdown || '') });
    registerIntervention(sessionId, 'plan', planId, { planSummary: String(markdown || '').slice(0, 500) });
    let settled = false;
    const settle = (decision, opts = {}) => {
      if (settled) return;
      settled = true;
      if (opts.skipInterventionSettle !== true) {
        settleIntervention(sessionId, planId, decision && decision.decision === 'approve' ? 'approved' : 'rejected', { decidedBy: decision && decision.decision === 'approve' ? 'user' : 'auto', note: decision && decision.note ? String(decision.note).slice(0, 500) : '' });
      }
      try { onEvent({ type: 'plan_decision', planId, decision: decision && decision.decision === 'approve' ? 'approve' : 'reject', note: decision && decision.note }); } catch { /* stream gone */ }
      resolve(decision);
    };
    const timer = setTimeout(() => {
      const note = 'plan approval timed out';
      const entry = pendingPlans.get(planId);
      runAutomaticInterventionDecision({
        missionId: sessionId, interventionId: planId, source: 'timeout_plan', decidedBy: 'timeout',
        idempotencyKey: `timeout:${planId}`, payload: { action: 'reject', feedback: note },
      }, () => {
        if (pendingPlans.get(planId) !== entry || (entry && entry.commandApplying)) return;
        pendingPlans.delete(planId);
        settle({ decision: 'reject', note });
      });
    }, Math.max(5000, Number(timeoutMs) || 120000));
    pendingPlans.set(planId, { resolve: settle, sessionId, timer });
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 第27波(AUTONOMY-PLAN §27):自主性授权书(Autonomy Grant)—— 现有权限系统的严格【子集缓存】,不是新权限来源。
// 只做一件事:在用户【预先经 UI header token 明示】的「工具 × 路径 × 命令 × 次数 × 时长」笼子内,把工具决策点
// 本会弹出的 gate:'ask' 就地降为 'allow' 并计数;范围外一切照旧弹窗。解决第25/26波痛点:until-done 长任务一遇
// exec 弹窗(120s 超时自动拒)就死。三条硬不变式(写死在码):
//   ① 子集律:只 ask→allow,【永不】 block→allow。plan 的 block、越界写 DENY、敏感路径 denylist 全在其上,授权书
//      一律不触碰(consumeGrant 只在 gate==='ask' 分支被调用,结构上够不到 block)。permissionMode 恒为天花板。
//   ② 签发主权律:签发/撤销唯一入口 = UI header token(tokenOk / trusted)。body-token(MCP child loopback,模型
//      可间接触达)【永无签发能力】—— 路由层就把 /api/autonomy/* 放进 header-token 白名单,且 handler 自查 tokenOk
//      且【绝不】带 bodyToken 兜底(沿用第26波b check.cmd 门教训)。
//   ③ exec 永不全局持久:授权书【纯模块级 Map】,不挂 session(避 saveSession 全量落盘)、不进 config.toolAllowRules、
//      无侧车文件。进程重启即全清 —— 这本身是安全属性。
// 授权书只绕【弹窗】,不绕 guardFileToolPath / SSRF / 敏感路径 denylist / 检查点 journal —— 那些 sink 在工具执行体内
// 照常拦(纵深防御:即便 consumeGrant 误命中,真正的写仍被工作区护栏挡在外面 + 照常快照可回撤)。
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const autonomyGrants = new Map();   // sessionId -> Grant[](纯内存,进程退出即清)
const activeDriverRuns = new Map(); // sessionId -> runId(当前 until-done 驱动器运行标识;scope:'run' 授权绑定它)

const GRANT_MAX_USES = 200, GRANT_EXEC_MAX_USES = 5;           // 次数上限(exec 档更紧)
const GRANT_MIN_TTL_MS = 60 * 1000;                            // 最短 60s
const GRANT_MAX_TTL_MS = 6 * 60 * 60 * 1000;                   // 最长 6h(read/edit)
const GRANT_EXEC_MAX_TTL_MS = 30 * 60 * 1000;                  // exec 档最长 30min
// exec cmdAllow 命中即【拒】的 shell 元字符黑名单:含任一即失配回落弹窗(挡 `^npm run build; curl|iex` 夹带)。
const GRANT_EXEC_METACHARS = /[;|&$`\n\r><(){}]/;
// 默认禁网:命令含这些网络特征即不匹配(即便 env token 泄露也断外传信道;复用 SSRF 判定思路)。
const GRANT_NET_PATTERN = /(^|[\s"'`])(curl|wget|iwr|invoke-webrequest|invoke-restmethod|nc|ncat|telnet|ssh|scp|sftp|ftp)([\s"'`]|$)|https?:\/\/|\bstart-bitstransfer\b/i;
// edit 档【工作区内】二级 denylist:命中即回落弹窗(工作区内但会被自动执行的文件 = 潜伏 RCE,不需 exec 授权,R-P2-1)。
// package.json/pyproject 未纳入(合法编辑高频),其间接提权已在「诚实结论」交代:根治需 shell 沙箱化,授权书层无解。
const GRANT_EDIT_AUTOEXEC_DENY = [
  /(^|[\\/])\.git[\\/]/i, /(^|[\\/])\.githooks[\\/]/i, /(^|[\\/])\.husky[\\/]/i,
  /(^|[\\/])\.vscode[\\/]tasks\.json$/i, /(^|[\\/])\.vscode[\\/]launch\.json$/i,
];
// Claude CLI 桥的工具名 → 档位(CLI 弹窗以 Claude 名 Edit/Write/Bash 显示;签发卡片以同名列出,口径一致)。
// 与 NATIVE_TOOL_TIER(工作台原生名)【不重叠】——故一张 grant 的 entrypoint 由其 tool 名唯一确定,消耗点重算 tier 必一致。
const CLI_TOOL_TIER = {
  Read: 'read', Glob: 'read', Grep: 'read', LS: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'exec',
};
// 对抗轮 P1(field-shadow)防线:可签 exec 授权的工具白名单 + 各自【真正被执行的命令字段】。powershell_run 执行 args.command
//(runPowerShell(args.command));Claude Bash 执行 args.command。二者命令可前缀化且校验字段=执行字段。script_run 执行 args.code
//(整段脚本体)、shell_*/git_commit/http_request/office_open/browser_open/keyboard_send_keys/desktop_screenshot 等语义不符 → 不入表。
const GRANT_EXEC_TOOLS = new Set(['powershell_run', 'Bash']);
const GRANT_EXEC_CMD_FIELD = { powershell_run: 'command', Bash: 'command' };
// 签发时推断 entrypoint + tier(不信任调用方传入的 tier;消耗点再按 entrypoint 重算)。未知工具 → null(拒绝签发,
// 无法精确 gate 的工具不给授权)。禁 spawn_agent/orchestrate_agents(红线#4:防子代理递归放大授权)。
function grantIssueTierInfo(tool) {
  const t = String(tool || '');
  if (t === 'spawn_agent' || t === 'orchestrate_agents' || t === '*' || !t) return null;
  let info = null;
  if (Object.prototype.hasOwnProperty.call(NATIVE_TOOL_TIER, t)) info = { entrypoint: 'native', tier: NATIVE_TOOL_TIER[t] };
  else if (Object.prototype.hasOwnProperty.call(CLI_TOOL_TIER, t)) info = { entrypoint: 'cli', tier: CLI_TOOL_TIER[t] };
  if (!info) return null;
  // 对抗轮 P1(field-shadow):exec 授权只允许【命令可前缀化 且 校验字段=执行字段】的工具。script_run 执行 args.code
  // (整段脚本体,非可前缀化命令)、shell_*/git_commit/http_request 等执行字段与 cmdAllow 语义不符 → 一律不可签 exec 授权
  //(否则「校验 command、执行 code」= 绕过 cmdAllow 的任意 RCE)。仅 powershell_run(native)/Bash(cli)执行 args.command,可签。
  if (info.tier === 'exec' && !GRANT_EXEC_TOOLS.has(t)) return null;
  return info;
}
// 统一上下文解析器(红队 R-P1-2 核心):按 entrypoint 感知【参数形状】抽 {tier, fileFamily, pathArgs[], cmdArg, cwdArg}。
// 绝不跨形状复用键(native 用 path/source/dest,CLI 用 file_path/command)——否则文件族授权抽不到路径 → pathGlob 真空
// 满足 → 越界放行。文件族无法解析出任一受控路径 → 由 consumeGrant fail-closed 回落弹窗,【绝不真空放行】。纯字符串,无 I/O。
const NATIVE_FILE_FAMILY = new Set(['file_read', 'file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download', 'file_list', 'file_search', 'glob', 'project_snapshot']);
const CLI_FILE_FAMILY = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'LS', 'Glob', 'Grep']);
function resolveToolPermissionContext(name, args, entrypoint) {
  const input = (args && typeof args === 'object') ? args : {};
  const tool = String(name || '');
  const pathArgs = [];
  let cmdArg = null, cwdArg = null, tier = 'exec', fileFamily = false;
  const pushPath = v => { if (typeof v === 'string' && v.trim()) pathArgs.push(v.trim()); };
  if (entrypoint === 'cli') {
    tier = CLI_TOOL_TIER[tool] || 'exec';
    fileFamily = CLI_FILE_FAMILY.has(tool);
    // Claude CLI 形状:Edit/Write/Read → file_path;NotebookEdit → notebook_path;LS → path;Bash → command。
    for (const k of ['file_path', 'notebook_path', 'path']) pushPath(input[k]);
    if (tool === 'Bash') cmdArg = typeof input.command === 'string' ? input.command : '';
  } else { // 'native'
    tier = nativeToolTier(tool);
    fileFamily = NATIVE_FILE_FAMILY.has(tool);
    // 对抗轮 P2-GapA/P3:按【所有工具的真实形参名】取【全部触及路径】—— file_move/file_copy 用 from/to、archive_unzip 用
    // src/destDir、archive_zip 的源是【数组】paths[]。缺任一 → 该工具的授权书要么真空放行(源不受控)要么永不可消耗(fail-closed)。
    // 补齐后:consumeGrant 对每条路径(含数组源)都验 grantRoot/denylist/glob → 授权书对这些工具既生效又受约束。
    for (const k of ['path', 'source', 'destination', 'dest', 'output', 'output_path', 'root', 'from', 'to', 'src', 'destDir']) pushPath(input[k]);
    if (Array.isArray(input.paths)) for (const p of input.paths) pushPath(p);
    // 对抗轮 P1(field-shadow):按【真正被执行的字段】取命令,绝不 OR-merge 多字段 —— powershell_run 只执行 args.command
    //(见 case 'powershell_run')。未在 GRANT_EXEC_CMD_FIELD 映射的 exec 工具 → cmdArg=null → consumeGrant 恒不命中(fail-closed)。
    if (tier === 'exec') { const f = GRANT_EXEC_CMD_FIELD[tool]; cmdArg = f ? String(input[f] || '') : null; }
    if (typeof input.cwd === 'string' && input.cwd.trim()) cwdArg = input.cwd.trim();
  }
  return { tool, tier, fileFamily, pathArgs, cmdArg, cwdArg };
}
// 规范化签发请求 → 冻结的 Grant(纯函数,无 I/O)。返回 {ok, grant?, error?, dropped:[{glob,reason}]}。
// grantRoot 签发时冻结(glob 相对它解析);pathGlob 逐条:禁 '..'、须落 grantRoot 内、不撞敏感 denylist,越界丢弃并记因。
function normalizeGrant(raw, session, config, now) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const info = grantIssueTierInfo(r.tool);
  if (!info) return { ok: false, error: '未知或禁止授权的工具名(不可对 spawn_agent/orchestrate_agents 或通配符签发)' };
  const { entrypoint, tier } = info;
  const grantRoot = normalizeCwd(session && session.cwd, config && config.defaultWorkspace);
  if (!grantRoot || !path.isAbsolute(grantRoot)) return { ok: false, error: '无法确定授权工作区根' };
  // pathGlob 规范化(文件族才有意义):禁 '..'、绝对路径条目须落 grantRoot 内,否则裁剪。
  const dropped = [];
  const pathGlob = [];
  for (const raw0 of (Array.isArray(r.pathGlob) ? r.pathGlob : [])) {
    const g0 = String(raw0 || '').trim().replace(/\\/g, '/');
    if (!g0) continue;
    if (g0.split('/').some(seg => seg === '..')) { dropped.push({ glob: g0, reason: '含 .. 上跳,已裁剪' }); continue; }
    if (path.isAbsolute(g0)) {
      // 绝对 glob:其静态前缀须落在 grantRoot 内(带 * 的部分之前的目录段)。
      const staticPrefix = g0.split(/[*?]/)[0];
      const absPrefix = path.resolve(staticPrefix);
      if (!pathWithinRoot(absPrefix, grantRoot)) { dropped.push({ glob: g0, reason: '绝对路径越出授权工作区根,已裁剪' }); continue; }
      pathGlob.push(path.relative(grantRoot, absPrefix).replace(/\\/g, '/') + g0.slice(staticPrefix.length));
    } else {
      pathGlob.push(g0);
    }
  }
  // 文件族但没给任何 pathGlob → 默认 '**'(整个 grantRoot);但敏感 denylist/越界仍在 consume 逐路径兜底。
  if ((tier === 'read' || tier === 'edit') && pathGlob.length === 0) pathGlob.push('**');
  // cmdAllow(exec 必填):逐条锚定前缀(存去 '^' 的字面前缀);含元字符的前缀本身拒收(防 `npm; curl` 混入)。
  const cmdAllow = [];
  for (const raw1 of (Array.isArray(r.cmdAllow) ? r.cmdAllow : [])) {
    let p0 = String(raw1 || '').trim();
    if (p0.startsWith('^')) p0 = p0.slice(1);
    if (!p0) continue;
    if (GRANT_EXEC_METACHARS.test(p0)) { dropped.push({ glob: p0, reason: 'cmdAllow 前缀含 shell 元字符,已剔除' }); continue; }
    cmdAllow.push(p0);
  }
  if (tier === 'exec' && cmdAllow.length === 0) return { ok: false, error: 'exec 类授权必须提供至少一条合法的 cmdAllow 命令前缀' };
  const isExec = tier === 'exec';
  const maxUsesCap = isExec ? GRANT_EXEC_MAX_USES : GRANT_MAX_USES;
  const maxUses = Math.max(1, Math.min(maxUsesCap, Math.floor(Number(r.maxUses) || (isExec ? 3 : 20))));
  const ttlCap = isExec ? GRANT_EXEC_MAX_TTL_MS : GRANT_MAX_TTL_MS;
  const ttlMs = Math.max(GRANT_MIN_TTL_MS, Math.min(ttlCap, Math.floor(Number(r.ttlMs) || (isExec ? 15 * 60 * 1000 : 60 * 60 * 1000))));
  const scope = r.scope === 'session' ? 'session' : 'run';
  // scope:'run' 绑当前活动驱动器 run;无活动 run 时 runId='' 且 bindNextRun=true(驱动器启动时补绑,支持 run 启动前预承诺)。
  const curRun = (session && activeDriverRuns.get(session.id)) || '';
  const grant = {
    grantId: makeId('grant'),
    sessionId: session && session.id,
    entrypoint, tool: String(r.tool), tier,
    scope, runId: scope === 'run' ? curRun : '', bindNextRun: scope === 'run' && !curRun,
    grantRoot, pathGlob,
    cmdAllow, netAllowed: isExec ? Boolean(r.netAllowed) : false,
    maxUses, usedCount: 0,
    issuedAt: now, expiresAt: now + ttlMs, ttlMs,
    issuedBy: 'ui-token', revoked: false, revokedAt: 0,
  };
  return { ok: true, grant, dropped };
}
// 唯一收口:校验 + 计数消耗。【全程同步无 await】→ Node 单线程读改写不可分割(并发原子性根基)。命中 → usedCount++
// (不退还,工具失败不回补,杜绝失败重试刷额度)+ 审计 + 返回 {grantId, remaining, tool, tier};未命中 → null(回落弹窗)。
function consumeGrant(session, toolName, args, entrypoint, workingDir) {
  if (!session || !session.id) return null;
  const list = autonomyGrants.get(session.id);
  if (!list || !list.length) return null;
  const ctx = resolveToolPermissionContext(toolName, args, entrypoint);
  const now = Date.now();
  const curRun = activeDriverRuns.get(session.id) || '';
  for (const g of list) {
    if (g.revoked) continue;
    if (g.tool !== toolName) continue;                       // 精确工具名(禁通配)
    if (g.entrypoint !== entrypoint) continue;               // native grant 绝不被 CLI 调用命中,反之亦然
    if (now >= g.expiresAt) continue;                        // TTL 过期
    if (g.usedCount >= g.maxUses) continue;                  // 次数耗尽
    if (g.scope === 'run' && (!curRun || g.runId !== curRun)) continue; // scope 隔离(无活动 run 或 runId 不符/未绑定 → 不命中)
    if (ctx.tier !== g.tier) continue;                       // F5 自防御:tier 消耗点重算,不信签发快照
    if (g.tier === 'exec') {
      const cmd = String(ctx.cmdArg || '');
      if (!cmd) continue;                                    // exec 无命令 → 不命中
      if (GRANT_EXEC_METACHARS.test(cmd)) continue;          // 元字符 → 失配(挡夹带)
      if (!g.netAllowed && GRANT_NET_PATTERN.test(cmd)) continue; // 默认禁网 → 失配
      const trimmed = cmd.replace(/^\s+/, '');
      const okCmd = g.cmdAllow.some(p => {
        if (trimmed.toLowerCase().indexOf(p.toLowerCase()) !== 0) return false;  // 锚定前缀
        const after = trimmed.slice(p.length);
        return after === '' || /^\s/.test(after);            // 前缀后须 EOL 或空白(挡 `build`→`buildEVIL`)
      });
      if (!okCmd) continue;
      if (ctx.cwdArg) {                                       // 若显式给了 cwd,须落 grantRoot 内(禁工作区外)
        const absCwd = path.isAbsolute(ctx.cwdArg) ? path.resolve(ctx.cwdArg) : path.resolve(g.grantRoot, ctx.cwdArg);
        if (!pathWithinRoot(absCwd, g.grantRoot)) continue;
      }
    } else {
      if (ctx.fileFamily && ctx.pathArgs.length === 0) continue; // 文件族抽不到路径 → fail-closed(R-P1-2)
      let allOk = ctx.pathArgs.length > 0;
      for (const p of ctx.pathArgs) {
        const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(g.grantRoot, p);
        if (isSensitiveDataPath(abs)) { allOk = false; break; }          // 敏感 denylist 无条件先行
        if (!pathWithinRoot(abs, g.grantRoot)) { allOk = false; break; } // 须落授权根内
        const rel = path.relative(g.grantRoot, abs).replace(/\\/g, '/');
        // 对抗轮 P3:先对每个组件去尾点/尾空格再匹配 —— Win32 语义下 '.git.'/'.git ' 等价于 '.git',词法保留会绕过 denylist。
        const relN = rel.split('/').map(s => s.replace(/[. ]+$/, '')).join('/');
        if (g.tier === 'edit' && GRANT_EDIT_AUTOEXEC_DENY.some(re => re.test(relN) || re.test(rel) || re.test(abs))) { allOk = false; break; } // 工作区内自动执行文件
        if (g.pathGlob.length && !g.pathGlob.some(gl => globToRegExp(gl).test(rel))) { allOk = false; break; } // glob 匹配
      }
      if (!allOk) continue;
    }
    // ── 命中:同步消耗(读改写不可分割)──
    g.usedCount += 1;
    const remaining = g.maxUses - g.usedCount;
    let argsHash = '';
    try { argsHash = crypto.createHash('sha1').update(JSON.stringify(args || {})).digest('hex').slice(0, 12); } catch { /* best-effort */ }
    logEvent({ kind: 'autonomy_grant_consume', grantId: g.grantId, sessionId: session.id, tool: g.tool, tier: g.tier, scope: g.scope, usedCount: g.usedCount, maxUses: g.maxUses, remaining, argsHash });
    return { grantId: g.grantId, remaining, tool: g.tool, tier: g.tier };
  }
  return null;
}
// 撤销即时生效(consumeGrant 每次现读 Map、无飞行中缓存 → 下一次调用立即失配;进行中的单次调用不追溯)。
function revokeGrant(sessionId, grantId) {
  const list = autonomyGrants.get(sessionId);
  if (!list) return false;
  const g = list.find(x => x.grantId === grantId && !x.revoked);
  if (!g) return false;
  g.revoked = true; g.revokedAt = Date.now();
  logEvent({ kind: 'autonomy_grant_revoked', grantId: g.grantId, sessionId, tool: g.tool, tier: g.tier });
  return true;
}
function revokeAllGrants(sessionId, reason) {
  const list = autonomyGrants.get(sessionId);
  if (!list) return 0;
  let n = 0;
  for (const g of list) if (!g.revoked) { g.revoked = true; g.revokedAt = Date.now(); n++; }
  autonomyGrants.delete(sessionId);
  if (n) logEvent({ kind: 'autonomy_grant_revoked', sessionId, count: n, reason: reason || 'revoke-all' });
  return n;
}
// scope:'run' 授权在驱动器 run 结束/中止时蒸发(遍历删 runId 匹配项)。
function revokeGrantsForRun(sessionId, runId) {
  const list = autonomyGrants.get(sessionId);
  if (!list || !runId) return 0;
  let n = 0;
  for (const g of list) if (!g.revoked && g.scope === 'run' && g.runId === runId) { g.revoked = true; g.revokedAt = Date.now(); n++; }
  const live = list.filter(g => !g.revoked);
  if (live.length) autonomyGrants.set(sessionId, live); else autonomyGrants.delete(sessionId);
  if (n) logEvent({ kind: 'autonomy_grant_revoked', sessionId, runId, count: n, reason: 'run-ended' });
  return n;
}
// 驱动器 run 启动:登记活动 runId,并把该会话所有 bindNextRun 的 scope:'run' 授权补绑到本 run(支持 run 启动前预承诺)。
function bindDriverRun(sessionId, runId) {
  activeDriverRuns.set(sessionId, runId);
  const list = autonomyGrants.get(sessionId);
  if (list) for (const g of list) if (!g.revoked && g.scope === 'run' && g.bindNextRun && !g.runId) { g.runId = runId; g.bindNextRun = false; }
}
// UI 只读快照(不含可重建授权面的敏感细节顺序,但 UI 需要 glob/cmd 展示 → 给足;审计仍走 logEvent NDJSON)。
function listGrantsView(sessionId) {
  const now = Date.now();
  const list = autonomyGrants.get(sessionId) || [];
  return list.filter(g => !g.revoked && now < g.expiresAt && g.usedCount < g.maxUses).map(g => ({
    grantId: g.grantId, tool: g.tool, tier: g.tier, scope: g.scope,
    pathGlob: g.pathGlob, cmdAllow: g.cmdAllow, netAllowed: g.netAllowed,
    usedCount: g.usedCount, maxUses: g.maxUses, expiresAt: g.expiresAt, remainingMs: Math.max(0, g.expiresAt - now),
  }));
}
// 签发瞬间的 dry-run:有界遍历 grantRoot,统计将命中 pathGlob 的文件(所见即所授)。硬上限防病态目录:最多扫 SCAN_CAP
// 个条目,返回前 `limit` 个样本。跳过敏感 denylist / edit 自动执行 denylist(与 consume 同口径)。永不抛。
async function dryRunGrantFiles(grant, limit) {
  const root = grant.grantRoot;
  const globs = (grant.pathGlob || []).map(g => globToRegExp(g));
  const out = []; let count = 0, scanned = 0; const SCAN_CAP = 4000;
  const stack = [root];
  while (stack.length) {
    if (scanned >= SCAN_CAP) return { count, sample: out, truncated: true };
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (scanned >= SCAN_CAP) return { count, sample: out, truncated: true };
      scanned++;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue; // 剪枝(不进 VCS/依赖树)
        stack.push(abs); continue;
      }
      if (!ent.isFile()) continue;
      if (isSensitiveDataPath(abs)) continue;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      const relN = rel.split('/').map(s => s.replace(/[. ]+$/, '')).join('/'); // 对抗轮 P3:组件去尾点/尾空格再匹配
      if (grant.tier === 'edit' && GRANT_EDIT_AUTOEXEC_DENY.some(re => re.test(relN) || re.test(rel) || re.test(abs))) continue;
      if (globs.length && !globs.some(re => re.test(rel))) continue;
      count++;
      if (out.length < limit) out.push(rel);
    }
  }
  return { count, sample: out, truncated: false };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// v1.0-S6 (B): provider endpoint FAILOVER (备用端点故障转移). Strict boundary — we switch endpoints ONLY on a
// PRE-FIRST-BYTE failure, because a mid-stream re-issue would REPLAY already-emitted content (duplication).
//   • connect-class transport failure (the socket never delivered a usable response): ECONNREFUSED /
//     ETIMEDOUT / ENOTFOUND / EHOSTUNREACH / EAI_AGAIN / ECONNRESET / TLS handshake failure / a generic
//     "fetch failed" the runtime raised before any body byte;
//   • HTTP 502 / 503 / 504 observed at the RESPONSE-HEADER stage (upstream gateway unavailable).
// NOT a failover trigger (换端点无益 or would mask a real error): 400/401/403/404/422/429 (auth/request/
// rate-limit — see the caller), and ANY failure once the SSE body has begun streaming (handled by the
// caller's existing error path, never here).
const FAILOVER_HTTP_STATUSES = new Set([502, 503, 504]);
// Connect-class Node error codes worth failing over on (a fresh endpoint may succeed).
const FAILOVER_CONNECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'ECONNRESET']);
// Classify a caught fetch throw (pre-first-byte). Returns a short reason token when it is failover-eligible
// connect-class, else null. Inspects the error's `code` (Node/undici surfaces the syscall code on `.cause`
// too), plus TLS/"fetch failed" message fragments the runtime uses when no `code` is attached.
function failoverConnectReason(err) {
  if (!err) return null;
  const code = String((err && err.code) || (err && err.cause && err.cause.code) || '').toUpperCase();
  if (code && FAILOVER_CONNECT_CODES.has(code)) return 'connect';
  const msg = String((err && err.message) || '');
  if (/certificate|tls|ssl|self[- ]signed|handshake|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) return 'tls';
  // undici raises a bare "fetch failed" (with the real cause nested) for connect refusals/DNS — treat as connect.
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|network|socket hang up/i.test(msg)) return 'connect';
  return null;
}
// Session-scoped sticky endpoint memory: provider.id → last base that STREAMED successfully this serve
// process. Not persisted (in-memory only, per spec). Cleared implicitly on process exit.
const failoverStickyBase = new Map();

// v1.7 — OpenAI Responses API request shaping (DeepSeek /v1/responses, Codex/agent oriented).
// Ruyi's provider engine keeps ONE normalized chat-shaped providerHistory (roles user/assistant/tool +
// assistant.tool_calls). The Responses protocol wants `input` ITEMS instead of `messages`, so we translate
// at request time (never mutating the stored history — multi-round tool loops keep working identically):
//   user        → { type:'message', role:'user', content:[{type:'input_text', text}] }
//   assistant   → { type:'message', role:'assistant', content:[{type:'output_text', text}] } (+ function_call items)
//   tool        → { type:'function_call_output', call_id, output }
//   system      → folded into `instructions` (the Responses equivalent of a leading system message)
// function tools are ALSO flattened: Responses uses { type:'function', name, description, parameters }
// (chat's nested { type:'function', function:{...} } shape is NOT accepted there).
function toResponsesContent(content) {
  // String → single input_text block. Parts array (vision) → text parts only (Responses/DeepSeek has no image
  // input; image_url parts degrade to a visible placeholder instead of erroring the request).
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
      else if (part.type === 'input_text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
      else if (part.type === 'image_url' || part.type === 'input_image') parts.push({ type: 'input_text', text: '[图片输入：Responses API 不支持图像，已替换为占位文本]' });
    }
    return parts.length ? parts : [{ type: 'input_text', text: '' }];
  }
  return [{ type: 'input_text', text: String(content || '') }];
}
// Translate a chat-shaped providerHistory into Responses `input` items (see header note).
function buildResponsesInputItems(history) {
  const items = [];
  for (const m of (Array.isArray(history) ? history : [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') continue; // folded into instructions by the caller
    if (m.role === 'user') { items.push({ type: 'message', role: 'user', content: toResponsesContent(m.content) }); continue; }
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || tc.id == null) continue;
          items.push({ type: 'function_call', call_id: String(tc.id), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) || '' });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      if (m.tool_call_id != null) {
        items.push({ type: 'function_call_output', call_id: String(m.tool_call_id), output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '') });
      }
      continue;
    }
    items.push({ type: 'message', role: 'user', content: toResponsesContent(m.content) }); // unknown role → user
  }
  return items;
}
// Flatten chat-shaped function tools ({type:'function', function:{...}}) into Responses' flat shape.
// v1.8: Ruyi's local `web_search` function tool is MAPPED to the Responses SERVER-SIDE tool
// {type:'web_search'} (DeepSeek executes it; events web_search_call.* + output_item web_search_call) —
// but ONLY when the provider opts in via serverWebSearch:true (the DeepSeek preset ships it). This keeps
// the built-in LOCAL web_search (builtin/searxng/bing/brave/tavily/bocha/custom backends) as the FALLBACK
// for every other provider and for Responses endpoints that ignore server-side tool types (DeepSeek
// silently drops unsupported tools — an unconditional mapping would silently remove web_search there).
// DeepSeek ignores unknown builtin tool types, so only web_search is ever mapped; everything else keeps
// its historical flatten/passthrough behavior.
function toResponsesTools(tools, serverWebSearch) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const flatName = t.type === 'function' ? (t.name || (t.function && t.function.name) || '') : '';
    if (serverWebSearch === true && flatName === 'web_search') {
      out.push({ type: 'web_search' });
      continue;
    }
    if (t.type === 'function' && t.function && typeof t.function === 'object') {
      out.push({ type: 'function', name: t.function.name || '', description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } });
    } else if (t.type === 'function') {
      out.push({ type: 'function', name: t.name || '', description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } });
    } else {
      out.push(t); // web_search etc. pass through verbatim
    }
  }
  return out;
}

// One streaming chat/completions call. Emits assistant_delta / thinking_delta / raw_line live; returns
// { text, reasoning, toolCalls:[{id,name,rawArgs}], finishReason, httpError, toolsRejected }.
// v1.0-S6 (B): pre-first-byte failures are surfaced structurally so the caller can decide failover:
//   • a caught fetch throw BEFORE any body byte → { transportError, transportReason:<'connect'|'tls'>, ... }
//     (only when failover-eligible; a non-eligible throw — e.g. an AbortError — is re-thrown to the caller);
//   • a non-ok response whose status is 502/503/504 → the returned httpError object also carries
//     { failoverStatus:<502|503|504> } so the caller can advance. A throw that happens AFTER streaming has
//     started still propagates normally (caller's error path; no failover — 防重放).
// v1.7: ALSO speaks the OpenAI Responses API protocol when the request body carries `input` (not `messages`).
// DeepSeek added /v1/responses for Codex/agent loops (v4-flash now, v4-pro from 2026-08). The two protocols
// differ end-to-end (request shape, SSE event types, terminal condition), so `isResponses` selects a parallel
// parser inside — chat keeps its battle-tested path byte-for-byte; responses handles
// response.output_text.delta / response.reasoning_text.delta / response.function_call_arguments.delta /
// response.output_item.added / response.completed|incomplete|failed (NO `data: [DONE]` terminator).
async function openAiStreamOnce({ chatUrl, headers, body, ctrl, onEvent, markUsage, rawSeqRef, touch }) {
  const isResponses = !!(body && Array.isArray(body.input)); // Responses body uses `input` items, chat uses `messages`
  const doFetch = b => fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(b), signal: ctrl ? ctrl.signal : undefined });
  let res;
  try {
    res = await doFetch(body);
  } catch (e) {
    // Pre-first-byte throw. An abort (user Stop / watchdog) is NOT a failover case — re-throw so the caller's
    // AbortError handling runs. A connect/TLS-class failure is surfaced structurally for the failover decision;
    // anything else is re-thrown to preserve the existing error path & attribution.
    if (e && e.name === 'AbortError') throw e;
    const reason = failoverConnectReason(e);
    if (reason) return { transportError: (e && e.message) ? e.message : String(e), transportReason: reason, text: '', reasoning: '', toolCalls: [] };
    throw e;
  }
  touch();
  // v0.9-S0 400 attribution (§0.9-S0): tighten the order in which we classify a 400.
  // The old code sniffed stream_options FIRST. But a provider that rejects a tools-bearing request
  // often phrases it as "tools are not supported here" / "function calling is not supported" — the
  // "not support" fragment matched the stream_options regex, so we stripped stream_options and RETRIED
  // WITH TOOLS, hitting the same 400 forever (v0.8-S6 收官遗留误判案例; caught while wiring FAKE_REJECT_TOOLS).
  // Fix: when the request CARRIES tools AND the error text has tool/function semantics, attribute it to
  // tools-rejected FIRST (caller retries once without tools). Only if it is NOT a tools/function 400 do we
  // fall back to the stream_options sniff. For requests WITHOUT tools the behavior is unchanged — the
  // requestHasTools guard means the tools-first branch never fires, so the stream_options path is preserved.
  const requestHasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (res && res.status === 400) {
    let t = ''; try { t = await res.text(); } catch { /* ignore */ }
    const toolsSemantics = /tool|function/i.test(t);
    // tools-rejected 仍最先(45f 对抗轮 P1-1 恢复既有存活路径):真实超窗报文一般不含 tool/function 字样,
    // 而 tools 拒绝报文可能带 "in this context" —— 顺序反了会把非超窗错误吸进破坏性压缩。
    if (requestHasTools && toolsSemantics) {
      // tools-rejected takes priority over the stream_options retry (§0.9-S0).
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, toolsRejected: true, text: '', reasoning: '', toolCalls: [] };
    }
    // 第45波:context-overflow 先于 stream_options 误判 —— "invalid_request_error" 是 OpenAI 系 400
    // 的标准 type(真实 DeepSeek 超限报文正是它),而 stream_options 嗅探的正则含裸 /invalid/,会把上下文
    // 超限误吸进「剥 stream_options 静默重试」(剥了也照样超窗,纯浪费一次调用还掩盖 45b 的强压入口)。
    // (45f P1-1:判定器已收紧为「上下文×长度共现」,裸 invalid/context 字样不再命中。)
    if (isContextOverflowError('HTTP 400: ' + t)) {
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, contextOverflow: true, text: '', reasoning: '', toolCalls: [] };
    }
    // Some servers reject stream_options — retry once without it before failing.
    if (body.stream_options && /stream_options|unsupported|unknown|invalid|not\s*support/i.test(t)) {
      const b2 = Object.assign({}, body); delete b2.stream_options; res = await doFetch(b2);
    } else {
      return { httpError: `HTTP 400${t ? ': ' + redact(t.slice(0, 500)) : ''}`, toolsRejected: toolsSemantics, text: '', reasoning: '', toolCalls: [] };
    }
  }
  if (!res || !res.ok) {
    let d = ''; if (res) { try { d = await res.text(); } catch { /* ignore */ } }
    // v1.0-S6 (B): tag a gateway-unavailable status (502/503/504) so the caller can fail over to a backup
    // endpoint. This is still a pre-first-byte failure (we только read the error body, not an SSE stream).
    // Auth/request/rate-limit statuses (401/403/400/404/422/429) carry NO failoverStatus → caller won't switch.
    const failoverStatus = (res && FAILOVER_HTTP_STATUSES.has(res.status)) ? res.status : undefined;
    return { httpError: `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 500)) : ''}`, toolsRejected: /tool|function/i.test(d), failoverStatus, text: '', reasoning: '', toolCalls: [] };
  }
  // Non-streaming fallback: single JSON body.
  if (!res.body || typeof res.body.getReader !== 'function') {
    const j = await res.json().catch(() => null);
    // v1.7 (Responses API): a non-streamed response body is a `response` object with an `output` item list
    // (message / function_call / reasoning…), NOT chat's {choices:[{message}]}. Normalize it to the same
    // { text, reasoning, toolCalls } shape so every caller is protocol-agnostic.
    if (isResponses) {
      const out = Array.isArray(j && j.output) ? j.output : [];
      let respText = '', respReasoning = '';
      const tcs = [];
      for (const item of out) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'function_call') {
          tcs.push({ id: item.call_id || makeId('call'), name: item.name, rawArgs: (typeof item.arguments === 'string' && item.arguments) ? item.arguments : '{}' });
          continue;
        }
        if (item.type === 'reasoning') {
          const parts = Array.isArray(item.content) ? item.content : [];
          for (const part of parts) { if (part && part.type === 'reasoning_text' && typeof part.text === 'string') respReasoning += part.text; }
          continue;
        }
        if (item.type === 'message') {
          const parts = Array.isArray(item.content) ? item.content : [];
          for (const part of parts) { if (part && (part.type === 'output_text' || part.type === 'input_text') && typeof part.text === 'string') respText += part.text; }
        }
      }
      // E6 parity: surface reasoning before content, matching the streaming order.
      if (respReasoning) onEvent({ type: 'thinking_delta', text: respReasoning });
      if (respText) onEvent({ type: 'assistant_delta', text: respText });
      if (j && j.usage) markUsage(j.usage);
      return { text: respText, reasoning: respReasoning, toolCalls: tcs.filter(t => t.name), finishReason: (j && j.status === 'incomplete') ? 'length' : ((j && j.status === 'failed') ? 'error' : 'stop') };
    }
    const ch = j && j.choices && j.choices[0];
    const msg = ch && ch.message;
    // E6: this branch previously returned reasoning_content but never surfaced it as a thinking_delta, so a
    // non-streaming endpoint's reasoning chain was invisible in the UI. Emit it here (before the content, to
    // match the streaming order) whether the provider spells it reasoning_content or reasoning.
    const reasoningText = (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content) || (msg && typeof msg.reasoning === 'string' && msg.reasoning) || '';
    if (reasoningText) onEvent({ type: 'thinking_delta', text: reasoningText });
    if (msg && typeof msg.content === 'string' && msg.content) onEvent({ type: 'assistant_delta', text: msg.content });
    if (j && j.usage) markUsage(j.usage);
    const tcs = Array.isArray(msg && msg.tool_calls) ? msg.tool_calls.map(tc => ({ id: tc.id || makeId('call'), name: tc.function && tc.function.name, rawArgs: (tc.function && tc.function.arguments) || '{}' })).filter(t => t.name) : [];
    return { text: (msg && msg.content) || '', reasoning: reasoningText, toolCalls: tcs, finishReason: ch && ch.finish_reason };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', text = '', reasoning = '', finishReason = null, done = false, responsesFailedError = '';
  // E1: accumulate streamed tool_calls into SLOTS keyed primarily by tool_call id. A delta carrying a
  // non-empty id opens (or re-selects) that call's slot; a delta with only an index selects/creates the slot
  // for that index; a delta with neither keeps writing to the CURRENT slot. This "non-empty id => open/select
  // a slot, otherwise keep writing the current slot" state machine keeps multiple PARALLEL tool_calls
  // independent even when the provider omits `index` on the delta fragments (some vLLM/Ollama/self-hosted
  // endpoints do). The old code forced every index-less delta into acc[0], splicing distinct calls' names
  // ("file_readfile_write") and arguments into one corrupt, unparseable blob.
  const slots = []; // { id, index, name, args } in first-seen order
  let curSlot = null;
  const selectSlot = tc => {
    // Priority 1: an explicit, non-empty id is the authoritative call identity -> find-or-create by id
    // (idempotent whether the provider sends the id once at the start or repeats it on every fragment).
    if (typeof tc.id === 'string' && tc.id) {
      let s = slots.find(x => x.id === tc.id);
      if (!s) {
        // Adopt a slot previously opened for this same index that has not yet been assigned an id.
        if (tc.index != null) s = slots.find(x => !x.id && x.index === tc.index);
        if (s) s.id = tc.id;
        else { s = { id: tc.id, index: (tc.index != null ? tc.index : null), name: '', args: '' }; slots.push(s); }
      }
      curSlot = s; return s;
    }
    // Priority 2: no id but an explicit index -> find-or-create by index (the standard OpenAI shape where
    // continuation fragments carry only the index).
    if (tc.index != null) {
      let s = slots.find(x => x.index === tc.index);
      if (!s) { s = { id: '', index: tc.index, name: '', args: '' }; slots.push(s); }
      curSlot = s; return s;
    }
    // Priority 3: neither id nor index -> keep writing to the current slot (open a first default slot if this
    // is the very first fragment).
    if (!curSlot) { curSlot = { id: '', index: null, name: '', args: '' }; slots.push(curSlot); }
    return curSlot;
  };
  // Process ONE decoded SSE event object (already JSON-parsed). Mutates text/reasoning/finishReason/slots.
  // Returns true when this event terminates the stream (responses' completed/incomplete/failed; chat keeps
  // relying on the `[DONE]` sentinel inside handleEventBlock). v1.7: `isResponses` selects the Responses-API
  // event grammar — the two protocols share nothing structurally, so they get separate handlers.
  const processEvt = (evt, rawStr) => {
    onEvent({ type: 'raw_line', line: rawStr, seq: rawSeqRef.n++ });
    if (isResponses) {
      // ── OpenAI Responses API stream (DeepSeek /v1/responses) ────────────────────────────────────────
      // Events: response.created | response.in_progress | response.output_item.added/done |
      // response.content_part.added/done | response.reasoning_text.delta/done | response.output_text.delta/done |
      // response.function_call_arguments.delta/done | response.completed | response.incomplete | response.failed.
      // No `data: [DONE]` — the stream ends on response.completed/incomplete/failed.
      if (evt && evt.usage) markUsage(evt.usage); // some events carry usage directly
      const t = evt && evt.type;
      if (t === 'response.output_item.added' && evt.item && evt.item.type === 'function_call') {
        // A function_call output item opens/selects its slot (call_id + name), arguments stream separately.
        // 对抗轮(P1-2):以 call_id 为主键选槽 —— 并行 function_call 是常态(官方文档 parallel_tool_calls 忽略
        // = 始终开启),delta 事件自带 item_id,必须按 item_id 路由参数,不能依赖"最后 added 的槽"(交错事件序会错配)。
        const fc = evt.item;
        const id = fc.call_id || makeId('call');
        let s = slots.find(x => x.id === id);
        if (!s) { s = { id, index: null, name: fc.name || '', args: '', itemId: evt.item && evt.item.id || '' }; slots.push(s); }
        else if (fc.name) s.name += fc.name;
        curSlot = s;
        return false;
      }
      // v1.8: a web_search_call output item is a SERVER-SIDE tool invocation (DeepSeek /responses executes
      // the search itself). Surface it as a toolCall named 'web_search' with serverSide:true so the tool
      // loop knows NOT to execute it locally; the raw item is carried back to the next request's `input`
      // (DeepSeek restores the search results server-side). status/output arrive on the .done event.
      if (t === 'response.output_item.added' && evt.item && evt.item.type === 'web_search_call') {
        const ws = evt.item;
        const id = ws.id || makeId('call');
        let s = slots.find(x => x.id === id);
        if (!s) { s = { id, index: null, name: 'web_search', args: '', itemId: id, serverSide: true, item: ws }; slots.push(s); }
        curSlot = s;
        return false;
      }
      if (t === 'response.output_item.done' && evt.item && evt.item.type === 'web_search_call') {
        const ws = evt.item;
        const id = ws.id || '';
        let s = id ? slots.find(x => x.id === id) : curSlot;
        if (s) {
          s.item = ws; // keep the FULL item so it can be echoed back verbatim (server restores the results)
          // v1.8.1: DeepSeek's web_search_call carries the query under `action` (NOT the OpenAI-doc shape
          // `output.query`/`output.search_terms` — the real item has NO `output` field at all):
          //   { type:'web_search_call', id, status, action:{ type:'search', queries:[...] } }
          //   { type:'web_search_call', id, status, action:{ type:'open_page', url } }
          // Parse both so the UI shows the REAL search terms / opened URL instead of an empty placeholder.
          const action = ws.action && typeof ws.action === 'object' ? ws.action : null;
          let q = '';
          if (action) {
            if (Array.isArray(action.queries)) q = action.queries.filter(Boolean).join(' | ');
            else if (typeof action.url === 'string') q = action.url;
          }
          s.args = JSON.stringify({ status: ws.status || '', actionType: (action && action.type) || '', query: q });
        }
        return false;
      }
      if (t === 'response.function_call_arguments.delta' && typeof evt.delta === 'string' && evt.delta) {
        // 对抗轮(P1-2):优先按事件的 item_id 精确定位槽(并行时 arguments delta 按 item_id 路由,绝不串写);
        // item_id 缺失/未命中才回退到"最近 added 的槽"(串行单调用场景,与旧行为一致)。
        let target = null;
        const itemId = evt && evt.item_id;
        if (typeof itemId === 'string' && itemId) target = slots.find(x => x.itemId === itemId);
        if (!target) target = curSlot;
        if (!target) { target = { id: makeId('call'), index: null, name: '', args: '', itemId: '' }; slots.push(target); }
        target.args += evt.delta;
        curSlot = target;
        return false;
      }
      if (t === 'response.reasoning_text.delta' && typeof evt.delta === 'string' && evt.delta) {
        reasoning += evt.delta; onEvent({ type: 'thinking_delta', text: evt.delta }); return false;
      }
      if (t === 'response.output_text.delta' && typeof evt.delta === 'string' && evt.delta) {
        text += evt.delta; onEvent({ type: 'assistant_delta', text: evt.delta }); return false;
      }
      if (t === 'response.completed') {
        // Final event: the full response object (with usage) rides on the event.
        if (evt.response && evt.response.usage) markUsage(evt.response.usage);
        finishReason = 'stop';
        return true;
      }
      if (t === 'response.incomplete') { finishReason = 'length'; return true; } // truncated (e.g. max_output_tokens)
      if (t === 'response.failed') {
        // Terminal failure — surface the error detail to the caller's existing httpError path.
        // 对抗轮(P1-3/P2-1/P2-3):
        //  • 无 error 详情也置错误(否则 finishReason 无人消费 → 静默空转,见 P2-1);
        //  • 文本过 redact() 防恶意服务商在 error 里回显密钥(P2-3);
        //  • 错误含 context/length 语义时置 contextOverflow,让 45b 强压重试能识别(P1-3)。
        const err = evt.response && (evt.response.error || evt.response.last_error);
        const em = (err && (err.message || err.code)) || (err && typeof err === 'object' ? JSON.stringify(err) : String(err || ''));
        responsesFailedError = 'Responses failed' + (em ? ': ' + redact(String(em).slice(0, 400)) : ' (no error detail)');
        if (/context|length|token/i.test(responsesFailedError)) responsesFailedError = 'HTTP 400: ' + responsesFailedError;
        finishReason = 'error';
        return true;
      }
      return false; // created / in_progress / content_part.* / output_item.done / reasoning_text.done / output_text.done / … — non-terminal
    }
    // ── Chat Completions stream (classic path) ─────────────────────────────────────────────────────────
    if (evt.usage) markUsage(evt.usage);
    const ch = evt.choices && evt.choices[0];
    if (!ch) return false;
    if (ch.finish_reason) finishReason = ch.finish_reason;
    const delta = ch.delta;
    if (!delta) return false;
    const reason = (typeof delta.reasoning_content === 'string' && delta.reasoning_content) || (typeof delta.reasoning === 'string' && delta.reasoning) || '';
    if (reason) { reasoning += reason; onEvent({ type: 'thinking_delta', text: reason }); }
    if (typeof delta.content === 'string' && delta.content) { text += delta.content; onEvent({ type: 'assistant_delta', text: delta.content }); }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const slot = selectSlot(tc);
        if (tc.function) { if (tc.function.name) slot.name += tc.function.name; if (typeof tc.function.arguments === 'string') slot.args += tc.function.arguments; }
      }
    }
    return false;
  };
  // E5: standard SSE framing. Events are separated by a BLANK line; within one event, multiple `data:` field
  // lines concatenate (joined by '\n') into a single payload before parsing (per the WHATWG SSE spec). The
  // old parser split on every '\n' and JSON.parsed each `data:` line alone, so an endpoint that spread one
  // JSON object across several `data:` lines (some intranet proxies / self-hosted gateways do) lost the whole
  // frame. To stay backward compatible with the overwhelmingly common one-JSON-per-line shape, when a
  // multi-line event's combined payload does not parse we fall back to parsing each data line on its own.
  const handleEventBlock = block => {
    const dataLines = [];
    for (let rawLine of block.split('\n')) {
      rawLine = rawLine.replace(/\r$/, '');
      if (!rawLine || rawLine.startsWith(':')) continue;   // blank line or comment
      if (!rawLine.startsWith('data:')) continue;          // ignore event:/id:/retry: fields
      dataLines.push(rawLine.slice(5).replace(/^ /, ''));  // strip 'data:' + one optional leading space (SSE)
    }
    if (!dataLines.length) return false;
    const joined = dataLines.join('\n').trim();
    if (joined === '') return false;
    if (joined === '[DONE]') return true;
    const combined = safeJsonParse(joined);
    if (combined) return processEvt(combined, joined); // true = terminal event (responses completed/incomplete/failed)
    // Combined payload did not parse -> treat each data line as its own complete JSON (classic shape).
    for (const dl of dataLines) {
      const d = dl.trim();
      if (!d) continue;
      if (d === '[DONE]') return true;
      const evt = safeJsonParse(d);
      if (evt && processEvt(evt, d)) return true;
    }
    return false;
  };
  while (!done) {
    const r = await reader.read();
    if (r.done) break;
    touch();
    buf += decoder.decode(r.value, { stream: true });
    let m;
    // Consume every COMPLETE event (terminated by a blank line); leave any trailing partial in buf.
    while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
      const block = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (handleEventBlock(block)) { done = true; break; }
    }
  }
  // Flush a trailing event that arrived without a terminating blank line (some servers omit the final one).
  if (!done && buf.trim()) handleEventBlock(buf);
  // v1.8: serverSide toolCalls (web_search_call items) carry the raw item so the tool loop can echo it
  // back into the next request's `input` without executing anything locally.
  const toolCalls = slots.filter(t => t.name).map(t => {
    const base = { id: t.id || makeId('call'), name: t.name, rawArgs: t.args || '{}' };
    if (t.serverSide) { base.serverSide = true; if (t.item) base.item = t.item; }
    return base;
  });
  // v1.7 (Responses): a `response.failed` terminal event is a protocol-level failure with no HTTP error
  // status — surface it through the caller's existing httpError path so attribution/retry behaves uniformly.
  if (responsesFailedError) return { text, reasoning, finishReason, toolCalls, httpError: responsesFailedError };
  return { text, reasoning, finishReason, toolCalls };
}

// v0.8-S7: drain the steering queue at a SAFE injection point (§4 A3). Called ONLY at the iteration
// boundary (loop top, before the next API call). A steer is a plain user string queued by /api/steer
// while this turn is live. For each queued item we:
//   • push a `[用户插话] <text>` user message into providerHistory — this is legal ONLY at a boundary
//     where the previous assistant/tool block is COMPLETE AND CONTIGUOUS (an assistant.tool_calls message
//     followed immediately by all its role:'tool' replies, nothing wedged between). The loop top satisfies
//     that: it runs after `continue`, which followed the full tool batch + its tool messages. Draining
//     between tools of one batch would break contiguity (assistant → tool₁ → user → tool₂ = 400 on strict
//     providers) and buys nothing — a steer is only consumed by the NEXT API call anyway;
//   • mirror it into session.messages with steered:true (additive marker) so the UI + a reload show it;
//   • emit a `steered` event (§7.3) so a live UI can render/dedup it;
//   • saveSession so a crash mid-turn doesn't lose the injected instruction.
// Returns the number of items injected (0 when the queue was empty).
async function drainSteerQueue(reg, session, onEvent) {
  if (!reg || !Array.isArray(reg.steerQueue) || reg.steerQueue.length === 0) return 0;
  const items = reg.steerQueue.splice(0, reg.steerQueue.length);
  for (const text of items) {
    const t = String(text || '');
    session.providerHistory.push({ role: 'user', content: '[用户插话] ' + t });
    session.messages.push({ role: 'user', content: t, turnSeq: session.turnSeq, steered: true, createdAt: nowIso() });
    try { onEvent({ type: 'steered', text: t }); } catch { /* stream gone */ }
  }
  await saveSession(session);
  return items.length;
}

// v0.9-S6 (子代理): run a self-contained SUB-TURN for spawn_agent. It is a miniature of runOpenAiTurn's tool
// loop, deliberately WITHOUT: plan mode, auto-compaction, steering, session.messages/providerHistory writes,
// and (禁嵌套) spawn_agent in its own tool set. Key isolation properties:
//   • independent `subHistory` — the sub-turn NEVER reads or writes the parent's session.providerHistory, so
//     the parent's pairing铁律 is untouched (the parent sees exactly one spawn_agent tool_call ↔ one tool_result);
//   • system prompt = a sub-agent identity variant + the SAME capability layers (reuse buildProviderSystemPrompt),
//     with the first user message = the delegated task;
//   • tool set filtered by toolTier (read/edit/exec) AND with spawn_agent suppressed (noSpawnAgent) — a
//     sub-agent can therefore never spawn another sub-agent (double guard: the tool isn't offered here AND
//     the loop below refuses a spawn_agent call if the model somehow emits one);
//   • independent iteration budget maxIters (clamped 1..300); model = model || provider.subagentModel || main model;
//   • file tools run through the SAME journal ctx {sessionId, turnSeq} as the parent (the sub-turn is part of
//     the parent turn), so a sub-agent's file_write is journaled under the parent's turnSeq — naturally;
//   • events: a `subagent` start/end pair is forwarded; the sub-loop's tool_use/tool_result are forwarded too
//     but TAGGED with `subagentId` so the UI nests them (protocol semantics unchanged — additive field).
//     assistant_delta is deliberately NOT forwarded (keeps the parent bubble clean; the conclusion returns as
//     the tool_result to the parent).
// Returns { ok, result, iters, toolCalls } — result is the sub-turn's final assistant text. Errors/over-budget
// return { ok:false, error } but NEVER throw into the parent loop.
// v0.9 F4: `permModeOverride` lets the caller pass a per-turn effective permission mode. When the parent turn
// is in provider plan mode AND the user has approved the plan THIS turn, the parent passes 'default' so the
// sub-agents it spawns can actually do the approved work — instead of being hard-blocked by a stale 'plan'
// mode. It is a TURN-LOCAL override only; global config.permissionMode is never mutated. When absent (or the
// plan is not yet approved, in which case the parent still passes 'plan'), the gate falls back to
// config.permissionMode, so an UN-approved plan-mode turn still hard-blocks its sub-agents' edit/exec tools.
function agentRunDir(sessionId) { return path.join(paths.agentRuns, safeSessionId(sessionId)); }
function agentRunFile(sessionId, runId) { return path.join(agentRunDir(sessionId), `${safeSessionId(runId)}.json`); }
const agentRunWriteChains = new Map();
const activeAgentRuns = new Map(); // runId -> { run, ctrl, paused, stopRequested, resumeWaiters, steerQueues }
// 第46波46e(双冷 resume 窄窗修复):resume「在飞」标记。activeAgentRuns 只在 runtime 构造好才注册,
// 而 existingRun 分支从校验到注册之间有 await(getAgentRoleLibrary/cleanupAgentWorktree)——两个近同时
// 的 resume 会都穿过 activeAgentRuns.has 守卫。此集合在分支【入口同步】占位,成功注册或早退/异常即释,
// 把窄窗从「await 全程」关到「零」。只在 runAgentWorkflow 内使用(09-workflow.js)。
const resumeInFlight = new Set();
// v1 定向插话（steer 到指定运行中子代理节点）: per-node steer queue cap. Reused BOTH by the workflow node
// steer action and by /api/steer's per-turn cap so the two steering surfaces stay symmetric.
const STEER_QUEUE_MAX = 3;
// 团队模式 v2 (A/B): 任务池与 Agent 邮箱的硬上限。全部防御式——任何越限只拒绝该次调用,绝不 crash 调度循环。
const POOL_MAX_TOTAL = 8;      // 每 run 提案总数上限(防提案洪水)
const POOL_CHAIN_MAX = 2;      // proposedBy 链深上限(池生池只允许一层)
const MAIL_QUEUE_MAX = 3;      // 每目标邮箱队列 cap(与 steerQueues 分池,用户插话优先)
const MAIL_TEXT_MAX = 2000;    // 单条消息截断
const MAIL_PER_SENDER_MAX = 8; // 每发送者每 run 消息上限
const MAIL_GLOBAL_MAX = 24;    // 每 run 全局消息上限
// 收尾宽限窗:全节点终态但任务池有待批提案时,manual 策略延迟收尾的时长(env WCW_POOL_GRACE_MS 可缩短供测试)。
const POOL_GRACE_MS = Math.max(500, Number(process.env.WCW_POOL_GRACE_MS) || 60000);
// 团队模式 v2 (P2-2 消息围栏,原则4): 来自其它节点/提案的文本进入提示词前,把行首伪造的 [编排者插话] / [节点 …]
// 前缀中和为全角括号版本,阻断子代理冒充编排者(用户)或冒充别的节点消息。仅改行首匹配,正文其余内容原样保留;
// 任何异常都回退原文(围栏失败绝不阻断投递/执行)。调用点:邮箱注入(runSubAgentCore)与提案物化(materializePoolItem)。
function neutralizeInjectedPrefixes(s) {
  try {
    return String(s == null ? '' : s)
      .replace(/^([ \t]*)\[编排者插话\]/gm, '$1［编排者插话］')
      .replace(/^([ \t]*)\[节点 /gm, '$1［节点 ');
  } catch { return String(s == null ? '' : s); }
}

// Resource-aware agent scheduling. A lease is scoped to an agent group: the node-level declaration and
// its individual tool calls may overlap each other, while other agents still see the resource as busy.
// Resource strings are intentionally portable/persistable: desktop, browser:<profile>, file:<path>,
// office:<path>, workspace:<path>. Prefix a declaration with "read:" for a shared/read lease.
const resourceLeases = new Map(); // token -> { group, resources, acquiredAt }
const resourceWaiters = [];
// v1.x (B1) deadlock backstop: a lease that cannot be acquired within this window is abandoned with a clear
// error instead of waiting forever. This bounds the nested-lease deadlock a DAG can hit — two concurrent
// nodes each hold their node-level lease, then each blocks on a tool-level lease over the other's resource;
// drainResourceWaiters can NEVER satisfy that cycle, so Promise.all (and the whole run) would hang. 0 = wait
// forever (the pre-fix semantics). WCW_RESOURCE_LEASE_TIMEOUT_MS is a test seam (fast deadlock e2e).
// v1.x (B1 hardening): the PRIMARY deadlock signal is now wait-for-graph cycle detection (wouldDeadlock),
// which rejects a real cycle instantly. This timeout is demoted to a LONG safety backstop that only guards the
// extreme "cycle detection missed it AND the holder never releases" case; the global idle watchdog is the final
// stop. 0 = wait forever. The old 60s default false-failed legitimate long holds (builds / large downloads /
// Office generation > 60s), so the default is now generous.
const DEFAULT_RESOURCE_LEASE_TIMEOUT_MS = 1800000; // 30min long backstop (was 60s)
// Blemish fix: `Number(env) || default` swallowed an explicit 0 (0 is falsy) into the default, contradicting
// the "0 = wait forever" contract the deadlock e2e seeds. Only fall back to the default when env is unset/blank;
// honor an explicit 0 (and any other finite >= 0 value, e.g. the test seam WCW_RESOURCE_LEASE_TIMEOUT_MS=1500).
const RESOURCE_LEASE_TIMEOUT_MS = (() => {
  const raw = process.env.WCW_RESOURCE_LEASE_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_RESOURCE_LEASE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESOURCE_LEASE_TIMEOUT_MS;
})();
function canonicalResourcePath(value, cwd) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.normalize(path.isAbsolute(raw) ? raw : path.resolve(cwd || process.cwd(), raw));
}
function normalizeAgentResource(value, cwd) {
  let raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return null;
  let mode = 'write';
  if (raw.startsWith('read:')) { mode = 'read'; raw = raw.slice(5); }
  let type = '', target = '';
  const colon = raw.indexOf(':');
  if (colon < 0) { type = raw.toLowerCase(); }
  else { type = raw.slice(0, colon).toLowerCase(); target = raw.slice(colon + 1); }
  if (type === 'desktop') return { type, target: 'global', mode, key: 'desktop', label: 'desktop' };
  if (type === 'browser') {
    target = String(target || 'default').trim().toLowerCase() || 'default';
    return { type, target, mode, key: `browser:${target}`, label: `browser:${target}` };
  }
  if (!['file', 'office', 'workspace'].includes(type)) return null;
  target = canonicalResourcePath(target || cwd, cwd);
  if (!target) return null;
  const folded = process.platform === 'win32' ? target.toLowerCase() : target;
  return { type, target, folded, mode, key: `${type}:${folded}`, label: `${type}:${target}` };
}
function normalizeAgentResources(values, cwd) {
  const out = [], seen = new Set();
  for (const value of (Array.isArray(values) ? values : [])) {
    const spec = normalizeAgentResource(value, cwd);
    if (!spec) continue;
    const id = `${spec.mode}:${spec.key}`;
    if (!seen.has(id)) { seen.add(id); out.push(spec); }
  }
  return out.slice(0, 32);
}
function remapAgentResources(values, sourceRoot, targetRoot) {
  const specs = normalizeAgentResources(values, sourceRoot);
  return specs.map(spec => {
    let label = spec.label;
    if (spec.target && ['file', 'office', 'workspace'].includes(spec.type) && pathWithinRoot(spec.target, sourceRoot)) {
      label = `${spec.type}:${path.resolve(targetRoot, path.relative(sourceRoot, spec.target))}`;
    }
    return (spec.mode === 'read' ? 'read:' : '') + label;
  });
}
function resourcePathContains(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function agentResourcesConflict(a, b) {
  if (!a || !b || (a.mode === 'read' && b.mode === 'read')) return false;
  if (a.type === 'desktop' || b.type === 'desktop') return a.type === 'desktop' && b.type === 'desktop';
  if (a.type === 'browser' || b.type === 'browser') return a.type === 'browser' && b.type === 'browser' && a.target === b.target;
  const pathTypes = new Set(['file', 'office', 'workspace']);
  if (!pathTypes.has(a.type) || !pathTypes.has(b.type)) return a.key === b.key;
  if (a.type === 'workspace' || b.type === 'workspace') {
    const workspace = a.type === 'workspace' ? a : b;
    const other = workspace === a ? b : a;
    return resourcePathContains(workspace.target, other.target) || resourcePathContains(other.target, workspace.target);
  }
  return a.folded === b.folded; // file and office aliases for the same document conflict
}
function resourceBlockers(group, resources) {
  const blockers = [];
  for (const [token, lease] of resourceLeases) {
    if (lease.group === group) continue;
    if (resources.some(a => lease.resources.some(b => agentResourcesConflict(a, b)))) blockers.push({ token, group: lease.group, resources: lease.resources.map(r => r.label) });
  }
  return blockers;
}
function drainResourceWaiters() {
  for (let i = 0; i < resourceWaiters.length;) {
    const waiter = resourceWaiters[i];
    if (waiter.signal && waiter.signal.aborted) { resourceWaiters.splice(i, 1); waiter.reject(Object.assign(new Error('resource wait aborted'), { name: 'AbortError' })); continue; }
    const earlierConflict = resourceWaiters.slice(0, i).some(earlier => waiter.resources.some(a => earlier.resources.some(b => agentResourcesConflict(a, b))));
    if (earlierConflict || resourceBlockers(waiter.group, waiter.resources).length) { i += 1; continue; }
    resourceWaiters.splice(i, 1);
    const token = makeId('lease');
    resourceLeases.set(token, { group: waiter.group, resources: waiter.resources, acquiredAt: nowIso() });
    waiter.resolve(token);
  }
}
// v1.x (B1 hardening): wait-for-graph cycle detection - the PRIMARY deadlock signal, replacing the crude
// timeout. Groups are graph nodes; a (waiting) group G that wants a resource currently HELD by a different
// group H implies an edge G->H. We add the tentative edge for THIS request (group wanting specs) plus the
// edges already implied by every parked waiter, then ask: starting from `group`, can we get back to `group`?
// Because the only NEW edges are outgoing from `group`, any newly-created cycle must pass through `group`, so
// reachability-back-to-self is sufficient. Complexity is O(V+E) over resourceLeases x resourceWaiters (a
// visited set prevents revisits / self-edge infinite recursion). A block that is NOT a cycle (a peer holding
// the resource for a legitimately long time) returns false and is left to wait for the eventual release.
function wouldDeadlock(group, specs) {
  const edges = new Map(); // waiterGroup -> Set(holderGroup)
  const addEdges = (from, resources) => {
    for (const [, lease] of resourceLeases) {
      if (lease.group === from) continue; // a group never waits on resources it already holds
      if (resources.some(a => lease.resources.some(b => agentResourcesConflict(a, b)))) {
        if (!edges.has(from)) edges.set(from, new Set());
        edges.get(from).add(lease.group);
      }
    }
  };
  addEdges(group, specs); // the tentative new wait edge for this request
  for (const w of resourceWaiters) addEdges(w.group, w.resources); // edges implied by already-parked waiters
  const visited = new Set();
  const stack = [...(edges.get(group) || [])];
  while (stack.length) {
    const g = stack.pop();
    if (g === group) return true; // reached the start again -> the new edge closes a wait cycle -> real deadlock
    if (visited.has(g)) continue;
    visited.add(g);
    for (const next of (edges.get(g) || [])) stack.push(next);
  }
  return false;
}
async function acquireResourceLease(group, resources, signal, onWait, timeoutMs) {
  const specs = Array.isArray(resources) ? resources : [];
  if (!specs.length) return '';
  const blockers = resourceBlockers(group, specs);
  const queuedAhead = resourceWaiters.filter(waiter => specs.some(a => waiter.resources.some(b => agentResourcesConflict(a, b))));
  if (!blockers.length && !queuedAhead.length) {
    const token = makeId('lease'); resourceLeases.set(token, { group, resources: specs, acquiredAt: nowIso() }); return token;
  }
  // v1.x (B1 hardening): before parking a BLOCKED waiter, detect a real wait-for cycle. A cycle can NEVER be
  // drained (drainResourceWaiters would loop forever), so reject at once instead of waiting out the long
  // backstop timeout. This is the primary mechanism; the timeout below is only the extreme-case backstop.
  if (wouldDeadlock(group, specs)) {
    throw Object.assign(new Error('资源死锁(检测到等待环)，已放弃该资源'), { name: 'ResourceDeadlockError', code: 'RESOURCE_DEADLOCK' });
  }
  if (typeof onWait === 'function') onWait(blockers.concat(queuedAhead.map(waiter => ({ group: waiter.group, resources: waiter.resources.map(r => r.label), queued: true }))));
  // v1.x (B1): arm a deadlock backstop timer unless the caller opts out (timeoutMs <= 0). resolve/reject are
  // wrapped so EVERY settle path (drainResourceWaiters, abort, timeout) clears the timer — no dangling timers.
  const limit = timeoutMs == null ? RESOURCE_LEASE_TIMEOUT_MS : Number(timeoutMs);
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const waiter = { group, resources: specs, signal, resolve: token => { cleanup(); resolve(token); }, reject: err => { cleanup(); reject(err); } };
    resourceWaiters.push(waiter);
    if (Number.isFinite(limit) && limit > 0) {
      timer = setTimeout(() => {
        const i = resourceWaiters.indexOf(waiter); if (i >= 0) resourceWaiters.splice(i, 1);
        waiter.reject(Object.assign(new Error('资源等待超时(疑似死锁)，已放弃该资源'), { name: 'ResourceTimeoutError', code: 'RESOURCE_TIMEOUT' }));
      }, limit);
      if (timer && timer.unref) timer.unref();
    }
    if (signal) signal.addEventListener('abort', () => { const i = resourceWaiters.indexOf(waiter); if (i >= 0) resourceWaiters.splice(i, 1); waiter.reject(Object.assign(new Error('resource wait aborted'), { name: 'AbortError' })); }, { once: true });
  });
}
function releaseResourceLease(token) { if (token && resourceLeases.delete(token)) drainResourceWaiters(); }
function inferToolResources(name, args, bridge, cwd, tier) {
  const bare = String(bridge ? bridge.toolName : name || '').toLowerCase();
  const input = args && typeof args === 'object' ? args : {};
  const specs = [];
  const add = (raw, mode) => { const s = normalizeAgentResource((mode === 'read' ? 'read:' : '') + raw, cwd); if (s) specs.push(s); };
  const exactReadNames = new Set(['file_read', 'docs_search']);
  const treeReadNames = new Set(['file_list', 'file_search', 'glob', 'project_snapshot', 'git_status', 'git_diff', 'git_log', 'dependency_inventory', 'code_review_scan', 'frontend_audit', 'claude_md_audit']);
  const writeNames = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download']);
  if (exactReadNames.has(name)) add(`file:${input.path || input.root || input.cwd || cwd}`, 'read');
  if (treeReadNames.has(name)) add(`workspace:${input.path || input.root || input.cwd || cwd}`, 'read');
  if (writeNames.has(name)) {
    for (const key of ['path', 'source', 'destination', 'dest', 'output', 'output_path']) if (input[key]) add(`file:${input[key]}`, 'write');
  }
  if (name === 'shell_start' || name === 'git_commit') add(`workspace:${input.cwd || cwd}`, 'write');
  if (name === 'browser_open' || /browser|chrom(e|ium)|playwright/.test(bare)) add(`browser:${input.profile || input.profileName || 'default'}`, 'write');
  if (name === 'office_open' || /excel|word|powerpoint|office|docx|xlsx|pptx|pdf/.test(bare)) {
    const p = input.path || input.file || input.input_path || input.output_path;
    if (p) add(`office:${p}`, tier === 'read' ? 'read' : 'write');
  }
  if (name === 'desktop_screenshot' || bridge && /click|mouse|keyboard|hotkey|ocr|screen|window|desktop|type|press|scroll|drag/.test(bare)) add('desktop', 'write');
  if (bridge) {
    for (const target of collectBridgedWriteTargets(bridge.toolName, input)) add(`file:${target.path}`, 'write');
  }
  const seen = new Set(); return specs.filter(s => !seen.has(`${s.mode}:${s.key}`) && seen.add(`${s.mode}:${s.key}`));
}
function gitExec(cwd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.gitStderr = String(stderr || '').trim(); reject(err); }
      else resolve(String(stdout || '').trim());
    });
  });
}
async function createAgentWorktree(cwd, runId, nodeId, attempt) {
  const repoRoot = await gitExec(cwd, ['rev-parse', '--show-toplevel']);
  const dirty = await gitExec(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) throw new Error('原工作区有未提交改动，无法从一致快照创建隔离节点；请先提交或移走这些改动');
  const baseCommit = await gitExec(repoRoot, ['rev-parse', 'HEAD']);
  const folder = `${safeSessionId(runId)}-${safeSessionId(nodeId)}-a${Math.max(1, Number(attempt) || 1)}`;
  const worktreePath = path.resolve(paths.agentWorktrees, folder);
  if (!pathWithinRoot(worktreePath, path.resolve(paths.agentWorktrees))) throw new Error('invalid agent worktree path');
  await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
  await gitExec(repoRoot, ['worktree', 'add', '--detach', worktreePath, baseCommit], 60000);
  return { mode: 'worktree', status: 'running', path: worktreePath, repoRoot: path.resolve(repoRoot), baseCommit, createdAt: nowIso() };
}
async function finalizeAgentWorktree(isolation, runId, nodeId) {
  if (!isolation || isolation.mode !== 'worktree') return isolation;
  const changes = await gitExec(isolation.path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!changes) {
    isolation.status = 'clean'; isolation.completedAt = nowIso();
    try { await gitExec(isolation.repoRoot, ['worktree', 'remove', '--force', isolation.path], 60000); } catch {}
    isolation.path = ''; return isolation;
  }
  await gitExec(isolation.path, ['add', '-A']);
  await gitExec(isolation.path, ['-c', 'user.name=Ruyi Agent', '-c', 'user.email=agent@ruyi.local', 'commit', '-m', `agent(${nodeId}): isolated result for ${runId}`], 60000);
  isolation.commit = await gitExec(isolation.path, ['rev-parse', 'HEAD']);
  isolation.status = 'ready'; isolation.completedAt = nowIso(); isolation.changeSummary = changes.split(/\r?\n/).slice(0, 100);
  return isolation;
}
async function applyAgentWorktree(run, nodeId) {
  const node = (run.nodes || []).find(n => n.id === nodeId);
  if (!node || !node.isolation || node.isolation.mode !== 'worktree' || !node.isolation.commit) return { ok: false, error: '该节点没有可应用的隔离提交' };
  if (node.isolation.status === 'applied') return { ok: true, alreadyApplied: true, commit: node.isolation.commit };
  const iso = node.isolation;
  const repoRoot = path.resolve(iso.repoRoot || '');
  const currentRoot = await gitExec(normalizeCwd(repoRoot), ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!currentRoot || path.resolve(currentRoot) !== repoRoot) return { ok: false, error: '原工作区已不可用' };
  const dirty = await gitExec(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) return { ok: false, error: '当前工作区有未提交改动；为避免覆盖，请先提交或移走这些改动' };
  try {
    await gitExec(repoRoot, ['cherry-pick', iso.commit], 120000);
  } catch (e) {
    try { await gitExec(repoRoot, ['cherry-pick', '--abort'], 30000); } catch {}
    return { ok: false, error: `隔离提交无法安全应用：${e.gitStderr || e.message || e}` };
  }
  iso.status = 'applied'; iso.appliedAt = nowIso();
  if (iso.path && pathWithinRoot(path.resolve(iso.path), path.resolve(paths.agentWorktrees))) {
    try { await gitExec(repoRoot, ['worktree', 'remove', '--force', iso.path], 60000); iso.path = ''; } catch {}
  }
  await saveAgentRun(run);
  return { ok: true, commit: iso.commit };
}
async function cleanupAgentWorktree(isolation) {
  if (!isolation || !isolation.path) return;
  const worktreePath = path.resolve(isolation.path);
  if (!pathWithinRoot(worktreePath, path.resolve(paths.agentWorktrees))) return;
  try { await gitExec(path.resolve(isolation.repoRoot), ['worktree', 'remove', '--force', worktreePath], 60000); }
  catch {
    try { await fsp.rm(worktreePath, { recursive: true, force: true }); } catch {}
    try { await gitExec(path.resolve(isolation.repoRoot), ['worktree', 'prune'], 30000); } catch {}
  }
  isolation.path = '';
}

function projectAgentRoleFile(cwd) { return path.join(path.resolve(cwd), '.ruyi', 'agents.json'); }
async function readProjectAgentRoles(cwd) {
  const file = projectAgentRoleFile(cwd);
  try {
    const st = await fsp.stat(file); if (!st.isFile() || st.size > 512 * 1024) return [];
    const parsed = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
    const rawRoles = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.roles) ? parsed.roles : []);
    return rawRoles.map(r => normalizeAgentRole(r, { source: 'project' })).filter(Boolean).slice(0, 32);
  } catch { return []; }
}
function parseSimpleYamlValue(value) {
  const s = String(value || '').trim();
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^\d+$/.test(s)) return Number(s);
  return s.replace(/^['"]|['"]$/g, '');
}
async function readClaudeProjectAgentRoles(cwd) {
  const dir = path.join(path.resolve(cwd), '.claude', 'agents');
  let files = []; try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const file of files.filter(f => /\.md$/i.test(f)).slice(0, 32)) {
    try {
      const raw = await fsp.readFile(path.join(dir, file), 'utf8'); if (raw.length > 128 * 1024) continue;
      const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/m.exec(raw); if (!m) continue;
      const fm = {};
      for (const line of m[1].split(/\r?\n/)) { const hit = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line); if (hit) fm[hit[1]] = parseSimpleYamlValue(hit[2]); }
      const role = normalizeAgentRole({
        id: fm.name || path.basename(file, '.md'), label: fm.name || path.basename(file, '.md'), description: fm.description || '', prompt: m[2].trim(),
        claudeModel: fm.model || 'inherit', claudeTools: Array.isArray(fm.tools) ? fm.tools : (typeof fm.tools === 'string' ? fm.tools.split(',').map(s => s.trim()) : []),
        permissionMode: fm.permissionMode === 'bypassPermissions' ? 'bypass' : fm.permissionMode, maxTurns: fm.maxTurns, mcpServers: Array.isArray(fm.mcpServers) ? fm.mcpServers : [], isolation: fm.isolation,
      }, { source: 'claude-project' });
      if (role) { role.nativeClaude = true; role.file = path.join(dir, file); out.push(role); }
    } catch { /* malformed native agent stays Claude's concern */ }
  }
  return out;
}
async function getAgentRoleLibrary(cwd, config) {
  const merged = new Map();
  for (const raw of BUILTIN_AGENT_ROLES) { const role = normalizeAgentRole(raw, { source: 'builtin', builtin: true }); merged.set(role.id, role); }
  for (const role of (Array.isArray(config.agentRoleOverrides) ? config.agentRoleOverrides : [])) {
    const current = merged.get(role.id); merged.set(role.id, current ? mergeAgentRole(current, role, 'global') : normalizeAgentRole(role, { source: 'global' }));
  }
  for (const role of await readProjectAgentRoles(cwd)) {
    const current = merged.get(role.id); merged.set(role.id, current ? mergeAgentRole(current, role, 'project') : role);
  }
  const claudeNative = await readClaudeProjectAgentRoles(cwd);
  for (const role of claudeNative) if (!merged.has(role.id)) merged.set(role.id, role);
  return [...merged.values()].filter(Boolean);
}
async function saveProjectAgentRoles(cwd, roles) {
  const file = projectAgentRoleFile(cwd), dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const payload = { schemaVersion: 1, roles: roles.map(r => normalizeAgentRole(r, { source: 'project' })).filter(Boolean).slice(0, 32) };
  await atomicWriteJson(file, payload);   // 25.1 收编
  return payload.roles;
}
function claudePermissionMode(mode) {
  // v1.4.3: use the unified CLAUDE_PERMISSION_MODE_MAP; 'inherit' maps to undefined (omit from agent JSON)
  if (mode === 'inherit') return undefined;
  return CLAUDE_PERMISSION_MODE_MAP[mode] || mode;
}
async function buildClaudeAgentDefinitions(cwd, config, jsonBudget = 6000) {
  const roles = (await getAgentRoleLibrary(cwd, config)).filter(r => !r.nativeClaude);
  const definitions = {};
  for (const role of roles) {
    const d = { description: role.description || role.label, prompt: role.prompt || role.description || role.label };
    if (role.claudeTools && role.claudeTools.length) d.tools = role.claudeTools;
    if (role.models && role.models.claude && role.models.claude !== 'inherit') d.model = role.models.claude;
    const pm = claudePermissionMode(role.permissionMode); if (pm) d.permissionMode = pm;
    if (role.mcpServers && role.mcpServers.length) d.mcpServers = role.mcpServers;
    if (role.budgets && role.budgets.claude) d.maxTurns = role.budgets.claude;
    if (role.isolation === 'worktree') d.isolation = 'worktree';
    if (role.color) d.color = role.color;
    definitions[role.id] = d;
  }
  // Windows .cmd launchers go through cmd.exe, whose command-line limit is small. Keep definitions
  // deterministic and bounded; project-native .claude/agents remain available independently.
  // cmd8191 防线: jsonBudget 由调用方按整行剩余预算动态给出(默认 6000 维持原契约);预算收紧时按角色
  // 库顺序确定性取舍,放不下的进 omitted(meta 事件上报,用户可见)。
  const budget = Math.max(0, Math.min(6000, Math.floor(Number(jsonBudget) || 0)));
  const selected = {}, omitted = [];
  for (const [id, def] of Object.entries(definitions)) {
    const candidate = { ...selected, [id]: def };
    if (JSON.stringify(candidate).length <= budget) selected[id] = def; else omitted.push(id);
  }
  return { definitions: selected, omitted, roles };
}

// Tool-tier → Claude native tool allowlist for a DAG node with no explicit role (or a role that leaves
// claudeTools empty), mirroring the OpenAI subagent's tierFilter hard cap (buildOpenAiTools): 'read' can
// never mutate, 'edit' adds file writes, 'exec' is intentionally unrestricted — the same shape as the
// built-in 'worker'/'verifier' roles, which leave claudeTools empty for their exec tier.
// 第22波(开放子代理工具面): read/edit 补 WebSearch/WebFetch——联网只读不落盘,与 OpenAI 侧 NATIVE_TOOL_TIER 把
// web_search/web_fetch 定为 read 级的既有裁定对齐(此前 Claude 引擎的研究/审查类 read 节点连检索都不行,两引擎
// 能力面不对称)。落盘/执行面(Write/Edit/Bash/MCP)分级不变。
const CLAUDE_SUBAGENT_TIER_TOOLS = { read: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], edit: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Write', 'Edit'], exec: [] };
// Permission modes that resolve without a human/bridge to answer a prompt: 'bypass' skips all asking,
// 'auto' is the CLI's own built-in risk classifier (v1.4.3, documented above at runClaudeTurn's
// usePermissionBridge computation), 'dontAsk' skips by name, and 'plan' never executes a mutating tool in
// the first place. Anything else ('default', 'acceptEdits') can still block on Bash/exec-tier calls with
// no one to answer — a one-shot unattended DAG node would hang forever, so those get coerced below.
const CLAUDE_SUBAGENT_SAFE_MODES = new Set(['bypass', 'auto', 'dontAsk', 'plan']);

// One-shot, session-free Claude CLI turn for a single DAG node: spawns `claude -p` with the node/role's
// own model + tool restriction, feeds stdout through the same parseClaudeEvent normalizer runClaudeTurn
// uses, and resolves once the CLI's own internal tool loop finishes. Unlike runClaudeTurn this owns no
// session state (no activeChildren/claudeSessionId/resume) — a DAG node is a bounded, addressable call, so
// runAgentWorkflow can gate/retry/loop on its return value exactly like it already does for the OpenAI
// HTTP path (runSubAgentCore), giving the DAG a real second (Claude-native) execution engine instead of
// always requiring an OpenAI-compatible Provider.
// v1.4.5: classify a Claude-engine sub-agent failure so runClaudeSubAgentOnce's bounded retry loop can
// decide whether to try again. The Claude CLI is a black box that does its OWN internal retry for
// 429/overload/network, but it still SURFACES a failure to us when its retry budget is exhausted or the
// process itself blips (startup/connect crash, OOM kill). Previously that single non-zero exit killed the
// node - and with the default failurePolicy 'block', the whole workflow (the "分发出去的子agent经常性失败"
// symptom). This classifier mirrors the OpenAI sub-agent path's transient set (transportError / 429 /
// 502/503/504 via failoverStatus, expressed here as CLI stderr text) plus the CLI-specific "died before
// producing anything" startup-crash case. Definitive errors (auth / model-not-found / context overflow /
// a clean error result the CLI emitted on exit 0) are NOT retried - retrying them only burns time.
function classifyClaudeSubagentFailure({ killed, exitCode, stderrText, assistantText, toolCallCount, gotResult, resultOk, resultText }) {
  if (killed) return { retry: false, reason: 'aborted' };
  // 防重放: the CLI already emitted assistant text or executed tools before failing. Re-running would
  // replay those side effects (file writes etc.), so never retry - matches runSubAgentCore's "mid-stream
  // errors are NOT retried" rule.
  if ((assistantText && String(assistantText).trim()) || toolCallCount > 0) return { retry: false, reason: 'progress_made' };
  // 第45波 45c:context overflow 从 definitive 拆出 —— 允许一次【缩载新鲜重试】。检查顺序保证安全:
  // progress_made 已先判(有 tool 调用/文本即不可重试),走到这里 = 零进展 → 无重放面。
  // 45f 对抗轮 P1-2:判定必须【先于】clean_error_result(CLI 执行期 API 错误常以 result 帧
  // subtype:error_during_execution 收尾,落不到 stderr),且扫描 stderr+result 合并文本;
  // 正则用 CONTEXT_OVERFLOW_PATTERNS(含真实 Anthropic 形态 "prompt is too long: N tokens > M maximum",
  // 作者假想形态 prompt_too_long 曾让整条分支成为死代码)。
  const combined = String(stderrText || '') + '\n' + String(resultText || '');
  if (CONTEXT_OVERFLOW_PATTERNS.test(combined) || /prompt_too_long/i.test(combined)) {
    return { retry: true, reason: 'over_window' };
  }
  // The CLI ran to a clean `result` event but reported is_error / subtype:error (e.g. an in-CLI tool
  // execution error). That is deterministic, not transient - retrying won't change it.
  if (gotResult && resultOk === false) return { retry: false, reason: 'clean_error_result' };
  const s = String(stderrText || '');
  // Definitive non-transient signatures (auth / model / bad request / cmd.exe 命令行超长——
  // 参数决定的确定性失败,重试同样的 args 只会原样再败;cmd8191 防线的预算哨兵应已拦截,此为兜底)。
  if (/invalid_api_key|authentication_error|auth.*fail|unauthor|\b401\b|permission_denied|\b403\b|model_not_found|not_found_error|\b404\b|invalid_request_error|命令行太长|command line is too long/i.test(s)) {
    return { retry: false, reason: 'definitive' };
  }
  // Transient signatures: rate limit / overload / 5xx / network / connect / TLS - the same set the OpenAI
  // path retries (transportError + 429 + 502/503/504), expressed as CLI stderr text.
  if (/rate_limit|rate.?limit|\b429\b|too many requests|overloaded|overloaded_error|\b5\d{2}\b|api_error|internal server|bad gateway|service unavailable|gateway timeout|fetch failed|failed to fetch|etimedout|econnreset|econnrefused|enotfound|eaddr|socket hang up|network error|connection (?:error|reset|refused|timeout)|und_err_|certificate|self-signed|tls error|getaddrinfo|timed out/i.test(s)) {
    return { retry: true, reason: 'transient' };
  }
  // Non-zero exit with no result event and no assistant text: the CLI died before doing any work (a
  // startup/connect blip its own retry budget couldn't ride out, or a process crash). Cautiously retry -
  // cheap, and a fresh process often succeeds; bounded by MAX_ATTEMPTS so a hard outage still fails fast.
  if (exitCode !== 0 && !gotResult) return { retry: true, reason: 'no_output_crash' };
  return { retry: false, reason: 'unknown' };
}
// v1.4.6 (C): a read/analysis Claude node emits almost no tool_use events, so its whole execution window
// looked frozen to the polling UI. Every N chars of streamed assistant text we fire a lightweight
// subagent_progress milestone (recordAgentNodeProgress folds it into node.progressLog as "生成中 · N 字").
const CLAUDE_PROGRESS_CHAR_STEP = 400;
async function runClaudeSubAgentOnce({ config, parentSession, task, displayTask, agentKey, dependsOn, toolTier, maxIters, model, onEvent, subagentId, ctrl, permModeOverride, roleDefinition, cwd, getSteer, steerReminder }) {
  const started = Date.now();
  const claude = config.claudePath || detectClaudePath();
  const fakeClaude = process.env.WCW_FAKE_CLAUDE || ''; // off-by-default test seam — see runClaudeTurn
  if (!fakeClaude && (!claude || !existsExecutable(claude))) {
    return { ok: false, error: 'Claude CLI 未找到，无法以 Claude 引擎运行该节点', iters: 0, toolCalls: 0 };
  }
  const role = roleDefinition || null;
  const tier = (toolTier === 'edit' || toolTier === 'exec') ? toolTier : 'read';
  const subModel = String(model || (role && role.models && role.models.claude !== 'inherit' && role.models.claude) || '').trim();

  const roleMode = role && role.permissionMode && role.permissionMode !== 'inherit' ? role.permissionMode : '';
  const requestedMode = roleMode || permModeOverride || config.permissionMode || 'bypass';
  const effMode = CLAUDE_SUBAGENT_SAFE_MODES.has(requestedMode) ? requestedMode : (tier === 'read' ? 'plan' : 'bypass');

  // Keep the print-mode process input channel open. Claude's documented stream-json input accepts additional
  // user envelopes while a turn is running, which lets the workflow orchestrator steer a long Claude node
  // directly instead of storing a note that only downstream nodes could see after it was already too late.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  const pm = claudePermissionMode(effMode); if (pm) args.push('--permission-mode', pm);
  if (subModel && subModel !== 'inherit') args.push('--model', subModel);
  if (config.claudeThinkingEffort) args.push('--effort', config.claudeThinkingEffort);
  const allowedTools = (role && role.claudeTools && role.claudeTools.length) ? role.claudeTools : CLAUDE_SUBAGENT_TIER_TOOLS[tier];
  if (allowedTools && allowedTools.length) args.push('--allowed-tools', allowedTools.join(','));
  const turnBudget = Number(maxIters) || (role && role.budgets && role.budgets.claude) || 0;
  if (turnBudget > 0) args.push('--max-turns', String(Math.min(300, Math.round(turnBudget))));
  // DAG subagents do not inherit the main turn's append prompt, so give them the same final language rule.
  args.push('--append-system-prompt', appendResponseLanguagePolicy('', config, 0, task));
  if (cwd) args.push('--add-dir', cwd);
  // 第28波(§28a):Claude 引擎【不适用】服务端子代理压缩(maybeCompactSubHistory)—— claude CLI 自管上下文窗口与压缩,
  // 服务端一次性 spawn 后只累积 assistantText/resultText 求聚合结果,不持有可压缩的 history 数组。与上文桥接分级不对称同源
  // (两引擎有意不对称)。故此函数【不】引入 subHistory/maybeCompactSubHistory —— 有意为之,非遗漏(e2e 源锁断言之)。
  // Bridged (external/desktop MCP) servers attach ONLY at 'exec' tier on the Claude path — 有意与 OpenAI 路径
  // 的分级开放**不对称**(第22波安全裁定): CLI 的 --allowed-tools 在 bypass 许可模式下不是硬限制(bypass 跳过一切
  // 许可),挂上 mcp-config 即意味着子进程可调用该服务器的任意工具(含桌面全控),无法像 runSubAgentCore 那样按
  // bridgedToolTier 逐工具硬过滤。在 CLI 提供逐工具硬白名单语义前,read/edit 维持不挂桥接面。An explicit
  // role.mcpServers narrows an exec-tier node to just those servers; empty/absent means everything the
  // workbench has configured (generateAgentNodeMcpConfig mirrors generateSessionMcpConfig, keyed by subagentId).
  const roleMcpServers = (role && role.mcpServers) || [];
  const mcpConfigPath = tier === 'exec' ? await generateAgentNodeMcpConfig(subagentId, config.mcpCommandMode, roleMcpServers) : '';
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);

  // cmd8191 防线(子代理): 子代理 args 小(无技能索引),但自定义 role.claudeTools/超长路径仍可能顶爆 cmd 上限。
  // 降级阶梯: ① 丢 --append-system-prompt(仅语言政策,可恢复性最低) ② 非 plan 模式丢 --allowed-tools
  // (bypass/auto 下它不是硬安全边界——bypass 跳过一切许可,见上方分级注释;plan 模式下它有意义,不丢)
  // ③ 仍超 → 明确报错(分类器把「命令行太长。」列为 definitive,不会无谓重试 3 次)。
  {
    const guardCmd = fakeClaude ? process.execPath : claude;
    const guardBudget = cmdLineBudgetFor(guardCmd);
    if (guardBudget > 0 && spawnCmdLineLength(guardCmd, args) > guardBudget) {
      const pi = args.indexOf('--append-system-prompt');
      if (pi >= 0) args.splice(pi, 2);
      if (spawnCmdLineLength(guardCmd, args) > guardBudget && effMode !== 'plan') {
        const ti = args.indexOf('--allowed-tools');
        if (ti >= 0) args.splice(ti, 2);
      }
      if (spawnCmdLineLength(guardCmd, args) > guardBudget) {
        return { ok: false, error: `Claude CLI 命令行超预算(${guardBudget} 字符):角色工具清单/路径过长,请精简该角色的 claudeTools 或缩短工作目录路径`, iters: 0, toolCalls: 0 };
      }
    }
  }

  const spawn = fakeClaude ? { command: process.execPath, args: [fakeClaude, ...args], opts: {} } : batchSafeSpawn(claude, args);
  const env = effectiveAnthropicEnv(config);
  if (fakeClaude) env.WCW_FAKE_INTERACTIVE = '1';

  onEvent({ type: 'subagent', id: subagentId, state: 'start', task: String(displayTask != null ? displayTask : task || ''), toolTier: tier, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', permissionMode: role && role.permissionMode || 'inherit', mcpServers: roleMcpServers, engine: 'claude' });

  const workingDir = cwd || process.cwd();
  await fsp.mkdir(workingDir, { recursive: true }).catch(() => {});
  const idleLimitMs = Math.min(Number(config.turnIdleTimeoutMs) || 600000, 600000);

  // v1.4.5: transient-error resilience parity with runSubAgentCore (OpenAI path) + streamWithFailover
  // (parent turn). The CLI is retried inline a bounded number of times when a failure is classified
  // transient by classifyClaudeSubagentFailure AND made no progress (防重放). One shared abort handler
  // kills whichever child is current; the watchdog is per-attempt.
  let killed = false;
  let currentChild = null;
  const onAbort = () => { killed = true; if (currentChild) { try { currentChild.stdin.end(); } catch { /* ignore */ } killChildTree(currentChild.pid); } };
  if (ctrl && ctrl.signal) { if (ctrl.signal.aborted) killed = true; else ctrl.signal.addEventListener('abort', onAbort, { once: true }); }

  // 45c:over_window 重试时的可变任务(缩载);初值 = 原任务。
  let taskForAttempt = task, overWindowShrunk = false;
  // One CLI spawn attempt -> collected exit/output state. Does NOT decide retry; the loop below does.
  const runOnce = () => new Promise(resolve => {
    const child = cp.spawn(spawn.command, spawn.args, { cwd: workingDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...spawn.opts });
    currentChild = child;
    let lastEventAt = Date.now();
    // Idle watchdog - a wedged CLI must not hang the whole DAG run forever (per-attempt).
    const watchdog = setInterval(() => { if (!killed && Date.now() - lastEventAt > idleLimitMs) onAbort(); }, 5000);
    child.stdin.on('error', () => {}); // ignore EPIPE if the child exits first
    let stdinClosed = false;
    const closeStdin = () => {
      if (stdinClosed) return;
      stdinClosed = true;
      try { child.stdin.end(); } catch { /* already closed */ }
    };
    const drainSteers = () => {
      if (stdinClosed || killed || typeof getSteer !== 'function') return 0;
      let steers = [];
      try { steers = getSteer() || []; } catch { steers = []; }
      let delivered = 0;
      for (const raw of steers) {
        const text = String(raw || '').trim();
        if (!text) continue;
        try {
          child.stdin.write(JSON.stringify(buildUserEnvelope('[编排者插话] ' + text + (steerReminder || ''))) + '\n', 'utf8');
          delivered += 1;
          lastEventAt = Date.now();
          onEvent({ type: 'subagent_steered', subagentId, text });
        } catch { /* the process may have completed between the queue drain and write */ }
      }
      return delivered;
    };
    try { child.stdin.write(JSON.stringify(buildUserEnvelope(String(taskForAttempt || ''))) + '\n', 'utf8'); } catch { /* ignore */ }
    // Polling is intentionally local to this child attempt. It supports both a user steering a live node and
    // the scheduler's automatic wrap-up instruction; queued messages are consumed in order and acknowledged
    // through the same subagent_steered event as Provider nodes.
    const steerTimer = setInterval(drainSteers, 250);
    if (steerTimer && steerTimer.unref) steerTimer.unref();
    let stderrText = '';
    child.stderr.on('data', chunk => { stderrText += decodeClaudeCliText(chunk); lastEventAt = Date.now(); });

    let assistantText = '';
    let progressChars = 0; // v1.4.6 (C): high-water mark of chars already reported via subagent_progress (resets per attempt)
    let toolCallCount = 0;
    let resultOk = true, resultText = '', gotResult = false;
    let stdoutRemainder = '';
    // v1.4-OSS 用量看板(补): per-attempt token accounting. The result frame's usage is the turn's CUMULATIVE
    // total — preferred when a field is populated. Absent it (an attempt that died before the result frame),
    // fall back to this attempt's msg_usage. The real CLI splits one multi-content-block assistant message into
    // several msg_usage events REPEATING the same usage, so summing虚计 2-3x; we take Math.max instead (帧内
    // 重复被 max 天然去重). Across API calls this max is a deliberate CONSERVATIVE lower bound (取最大一次调用) —
    // mirrors the main turn's maxCtxInput semantics.
    let resultUsage = null, resultCostUsd = NaN;
    let msgBillInMax = 0, msgBillOutMax = 0;
    // No --include-partial-messages here (a DAG node's aggregated result is all runAgentWorkflow consumes),
    // so parseClaudeEvent only ever emits whole (non-partial) text - no delta/whole dedup needed.
    const consumeLine = line => {
      if (!line.trim()) return;
      lastEventAt = Date.now();
      const evt = safeJsonParse(line);
      if (!evt) return;
      for (const ev of parseClaudeEvent(evt)) {
        if (ev.kind === 'text') {
          assistantText += ev.text;
          // v1.4.6 (C): emit a progress milestone each time streamed text crosses another
          // CLAUDE_PROGRESS_CHAR_STEP boundary so a long, tool-less generation shows live activity.
          if (assistantText.length - progressChars >= CLAUDE_PROGRESS_CHAR_STEP) {
            progressChars = assistantText.length;
            onEvent({ type: 'subagent_progress', subagentId, chars: assistantText.length, note: `生成中 · ${assistantText.length} 字` });
          }
        }
        else if (ev.kind === 'tool_use') { toolCallCount += 1; onEvent({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input, subagentId }); }
        else if (ev.kind === 'tool_result') onEvent({ type: 'tool_result', id: ev.id, content: ev.content, isError: ev.isError, subagentId });
        else if (ev.kind === 'result') {
          gotResult = true; resultOk = ev.ok !== false; if (ev.result) resultText = ev.result;
          if (ev.usage && typeof ev.usage === 'object') resultUsage = ev.usage;
          const c = Number(ev.costUsd); if (Number.isFinite(c)) resultCostUsd = c;
          // Drain a steer that raced the result frame before signalling EOF. Any already-written envelope
          // remains ahead of EOF and Claude processes it as the final turn; with no steer this closes normally.
          drainSteers();
          closeStdin();
        }
        else if (ev.kind === 'msg_usage' && ev.usage && typeof ev.usage === 'object') { msgBillInMax = Math.max(msgBillInMax, Number(ev.usage.input_tokens) || 0); const mo = Number(ev.usage.output_tokens) || 0; msgBillOutMax = Math.max(msgBillOutMax, mo > 0 ? mo : 0); }
      }
    };
    child.stdout.on('data', chunk => {
      stdoutRemainder += chunk.toString('utf8');
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    });
    let settled = false;
    const finish = exitCode => { if (settled) return; settled = true; clearInterval(watchdog); clearInterval(steerTimer); closeStdin(); if (stdoutRemainder.trim()) consumeLine(stdoutRemainder); currentChild = null; resolve({ exitCode, stderrText, assistantText, toolCallCount, resultOk, resultText, gotResult, resultUsage, resultCostUsd, msgBillInMax, msgBillOutMax }); };
    child.on('error', () => finish(-1));
    child.on('close', code => finish(code == null ? -1 : code));
  });

  const MAX_ATTEMPTS = 3;
  let lastFinalText = '', lastErr = '', lastToolCalls = 0;
  // v1.4-OSS 用量看板(补): accumulate token/cost across ALL attempts (a failed attempt still burned real tokens).
  // Written ONCE at every exit path via the finally below. Accounting is fully defensive — it can never change
  // the sub-agent's return value or throw (appendUsageLedger is itself fire-and-forget and skips zero-token rows).
  // ledgerCostUsd starts NaN, not 0: "no CLI cost frame ever seen" must reach claudeCostFields as non-finite
  // so it yields cost:null (unknown), never a false trusted-$0 row (mirrors the main turn's Number(undefined)).
  // ledgerEstimated flips true whenever an attempt fell back to the msg_usage max (保守下限, not the exact
  // cumulative result usage) so the row is honestly badged 估算.
  let ledgerIn = 0, ledgerOut = 0, ledgerCostUsd = NaN, ledgerEstimated = false;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (killed) break;
      const res = await runOnce();
      try {
        // FIELD-LEVEL source select (保守语义): trust the result frame's usage only when a field is actually
        // populated (>0). A result frame carrying an empty usage:{} must NOT record a bogus 0 — fall back to
        // this attempt's msg_usage max (帧内已去重) and flag the row estimated. Zero on both sides = nothing
        // billable this attempt.
        const ru = res.resultUsage;
        const ruIn = ru ? (Number(ru.input_tokens) || 0) : 0, ruOut = ru ? (Number(ru.output_tokens) || 0) : 0;
        if (ruIn > 0 || ruOut > 0) { ledgerIn += ruIn; ledgerOut += ruOut; }
        else if ((Number(res.msgBillInMax) || 0) > 0 || (Number(res.msgBillOutMax) || 0) > 0) {
          ledgerIn += Number(res.msgBillInMax) || 0; ledgerOut += Number(res.msgBillOutMax) || 0; ledgerEstimated = true;
        }
        if (Number.isFinite(res.resultCostUsd)) ledgerCostUsd = (Number.isFinite(ledgerCostUsd) ? ledgerCostUsd : 0) + res.resultCostUsd;
      } catch { /* never let accounting break the attempt */ }
      const finalText = (res.resultText || res.assistantText).trim();
      const ok = !killed && res.exitCode === 0 && res.resultOk && !!finalText;
      if (ok) {
        onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, resultChars: finalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
        return { ok: true, result: finalText, iters: 1, toolCalls: res.toolCallCount };
      }
      lastFinalText = finalText; lastToolCalls = res.toolCallCount;
      lastErr = killed ? '节点已中止或空闲超时' : (String(res.stderrText || '').trim().slice(0, 2000) || finalText || `claude 退出码 ${res.exitCode}`);
      const cls = classifyClaudeSubagentFailure({ killed, exitCode: res.exitCode, stderrText: res.stderrText, assistantText: res.assistantText, toolCallCount: res.toolCallCount, gotResult: res.gotResult, resultOk: res.resultOk, resultText: res.resultText });
      if (killed || !cls.retry || attempt >= MAX_ATTEMPTS) break;
      // 45c:over_window → 缩载后新鲜重试(一次性 spawn 无 resume,超窗 = 任务载荷本身过大;cap 60K 字符)。
      // 45f P3-7:任务本就不超 60K 时缩无可缩(超窗根因是系统提示/schema),重试必败 —— 不再白烧一次 spawn。
      if (cls.reason === 'over_window') {
        const raw = String(task || '');
        if (overWindowShrunk || raw.length <= 60000) break;
        overWindowShrunk = true;
        taskForAttempt = raw.slice(0, 60000) + `\n\n…(原任务 ${raw.length} 字符,上次因上下文超限失败已截断;请聚焦完成可达部分)`;
      }
      onEvent({ type: 'subagent', id: subagentId, state: 'retry', attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, reason: cls.reason, error: String(res.stderrText || '').trim().slice(0, 500) || `claude 退出码 ${res.exitCode}` });
      // Bounded backoff an abort can cut short (mirrors runSubAgentCore's transient-retry sleep).
      await new Promise(r => {
        const t = setTimeout(r, Math.min(2000, 300 * attempt));
        if (ctrl && ctrl.signal) ctrl.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
    }
    if (!killed && lastFinalText.trim().length >= 80 && lastToolCalls > 0) {
      onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: true, degraded: true, resultChars: lastFinalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
      return { ok: true, degraded: true, warning: lastErr || 'Claude CLI exited after producing usable output', result: lastFinalText, iters: 1, toolCalls: lastToolCalls };
    }
    onEvent({ type: 'subagent', id: subagentId, state: 'end', ok: false, resultChars: lastFinalText.length, task: String(displayTask != null ? displayTask : task || ''), tookMs: Date.now() - started, agentKey, dependsOn: dependsOn || [], roleId: role && role.id || '', roleLabel: role && role.label || '', model: subModel || 'inherit', engine: 'claude' });
    return { ok: false, error: lastErr || '子代理未产出结论', result: lastFinalText, iters: 1, toolCalls: lastToolCalls };
  } finally {
    // v1.4-OSS 用量看板(补): ONE ledger row for the whole node (accumulated across attempts). Billing fields via
    // claudeCostFields (与主回合同源). No parentSession → nothing to anchor a row to; skip. Zero-token rows are
    // dropped inside appendUsageLedger, so the 'CLI 未找到' early-return above (never reaches here anyway) needs
    // no special case, and a purely-aborted node with no usage records nothing.
    try {
      if (parentSession) {
        const { provider: claudeProvider, cost, currency, costTrusted } = claudeCostFields(config, ledgerIn, ledgerOut, ledgerCostUsd);
        appendUsageLedger({
          sessionId: parentSession.id, engine: 'claude', provider: claudeProvider,
          // A workflow node can pass model:'inherit' straight through (subModel === 'inherit'); the model that
          // actually ran is then config.model — record that, never the literal 'inherit'.
          model: (subModel && subModel !== 'inherit') ? subModel : (config.model || ''), inTok: ledgerIn, outTok: ledgerOut,
          cost, currency, costTrusted, estimated: ledgerEstimated, turnSeq: parentSession.turnSeq,
          kind: 'subagent', agentKey, subagentId,
        });
        // 29c: 用量随事件上抛 —— DAG 节点的 nodeEvent 借此把 token/成本累进 run.usageTotals(前端画布迷你条
        // 与运行卡 chip 早已防御性读这些字段,"后端并行落地中"说的就是这里)。与 ledger 同源同值。
        onEvent({ type: 'subagent_usage', id: subagentId, agentKey, inTok: ledgerIn, outTok: ledgerOut, cost, currency, estimated: ledgerEstimated });
      }
    } catch { /* accounting must never break the sub-agent */ }
  }
}
