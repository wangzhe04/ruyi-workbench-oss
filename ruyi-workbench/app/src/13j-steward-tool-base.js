// ============================================================================
// 第 117 波 T1(32 号文 §2.1「拆 13g-steward.js」):管家工具面的共享底座。
//
// 落点(transport 层,manifest 中位于 13i-steward-inbox.js 之后、13k-steward-threads.js 之前)。
// T1 拆分:原 13g-steward.js 已 2088 行,`steward-runner.static.e2e.js` ①「13g 不超过 SPEC 目标
// 2000 行」在 HEAD 上长期是红的,而 31 号文七轴还要往管家里加 8-12 个工具。按「谁被谁引用」把它
// 拆成四个文件,拼接顺序即依赖方向,零新增前向边:
//   · 13j-steward-tool-base.js(本文件)—— 两个工具族都要用的共享面:常量、稳定信封、门控壳用的
//     失败信封、会话头读取与线程小工具、决策日志(写与只读)、记忆存储、深读预算、每回合配额桶、
//     速查线程的两条判据。它被下面三个文件引用,故排在最前;
//   · 13k-steward-threads.js —— 线程族(tier edit):派活原语 + thread_* / quick_ask /
//     threads_search / 收件箱行增强;
//   · 13l-steward-ops.js —— 观察族 / 决策族 / 记忆族 / 设置族 / 内容管理族;
//   · 13g-steward.js —— 管家域路由、记忆面板、工具门控壳与 StewardHooks 注册表(排在最后,
//     因为注册表要引用上面两个文件里的 stewardImpl*,排在后面才是后向边)。
// 本次拆分是【纯搬家】:所有函数体逐字节不变,新写的只有各文件的头部注释。
//
// 依赖纪律(§11.3「不得新增前向边」):本文件只引用拼接顺序在它之前的模块符号
// (00/01/02/04/06i/13i …),全部后向边;它自己的符号只被 13k/13l/13g/13h 引用,同样是后向边。
//
// 下面这段 116c 的横幅逐字节原样保留。其中「真实实现全在这里」如今指的是
// 13j/13k/13l/13g 这四个文件合起来的「13g 族」,不再只是一个文件;四条铁律一字未改,
// 对整个族同样成立。
// ============================================================================

// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116c(27 号文 §3.5 工具面 / §4 记忆层 / §11.2 读预算):管家工具集实现。
//
// 定位:12-tool-dispatch.js 里的 17 个 steward_* handler 只写一行 `StewardHooks.xxx(args, ctx)`,
// 真实实现全在这里。这样 12(工具层)→ 06i(引擎层命名空间)是后向边,13g(传输层)单向往 06i 挂方法,
// 全程零新增前向边。
//
// 铁律(§3.4 红线 + §3.3):
//   ① 管家「动如意」,不「动世界」—— 本文件不提供任何文件读写/shell/桌面/浏览器/联网/git 写能力;
//      要动手就 steward_thread_new / steward_thread_continue 委派给线程,由线程按自己的权限档执行。
//   ② 双重 fail-closed:stewardEnabledV1 !== true -> steward.disabled(零写入);
//      ctx.session.kind !== 'steward' -> steward.forbidden(普通会话即使拿到工具名也调不动)。
//   ③ 管家只能收紧,不能放宽:放行范围一律经 06i 的 stewardMayAct(目标线程 permissionMode, ...);
//      永久豁免清单(stewardToolPermanentlyExempt)在任何权限档都返回 propose_required。
//   ④ 每个写动作追加一行决策日志 `<data>/steward/decisions-v1.ndjson`,带 undoRef 与依据。
// ════════════════════════════════════════════════════════════════════════════

// ── 落盘常量(两个新面,已登记进 durable-state-inventory)────────────────────────────────────
const STEWARD_DECISIONS_FILE = 'decisions-v1.ndjson';
const STEWARD_MEMORY_FILE = 'memory-v1.json';
const STEWARD_MEMORY_SCHEMA = 1;

// ── 工具面数值口径 ──────────────────────────────────────────────────────────────────────
const STEWARD_SEARCH_LIMIT_DEFAULT = 10, STEWARD_SEARCH_LIMIT_MAX = 50;
const STEWARD_READ_TAIL_DEFAULT = 6, STEWARD_READ_TAIL_MAX = 20;
const STEWARD_READ_CHARS_DEFAULT = 12000, STEWARD_READ_CHARS_MIN = 1000, STEWARD_READ_CHARS_MAX = 12000;
const STEWARD_READ_CALLS_PER_TURN = 6;      // §11.2:每回合 ≤6 次深读
const STEWARD_READ_ROW_OVERHEAD = 16;       // 每行的行首开销(角色/回合号那一截),算预算时按行计
const STEWARD_READ_CLIP_MARK = '…';         // 117s-H3:被截了头的那一行的行首标记
const STEWARD_AUDIT_LIMIT_DEFAULT = 20, STEWARD_AUDIT_LIMIT_MAX = 100;
const STEWARD_TITLE_MAX = 80;
const STEWARD_STEER_TEXT_MAX = 2000;
// 116-2b steward_thread_note:管家给【已在跑】的线程补一句上下文。600 字上限比 steer_node 的 2000
// 紧得多 —— 它是"补一句",不是"改任务";前缀由服务端加,与 [用户插话] 的前缀纪律同精神(用户一眼
// 就能分清哪句是自己说的、哪句是管家加的)。
const STEWARD_NOTE_TEXT_MAX = 600;
const STEWARD_NOTE_PREFIX = '（管家补充）';
const STEWARD_PENDING_SUMMARY_MAX = 12;     // thread_status 里最多列几条待决摘要
const STEWARD_RUNS_MAX = 20;                // runs_status 单次最多返回几个 run digest
// 116-2e:同义合并时保留的来源 ref 上限(§4 ⑥「mergedFrom 最多 5 个来源 ref」)。
const STEWARD_MEMORY_MERGED_FROM_MAX = 5;
const STEWARD_MEMORY_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;  // §4 ⑤「新写入 24 小时内带『新』标记」
const STEWARD_PLAYBOOK_DRAFTS_PER_TURN = 1;                // §3.5 内容管理:起草要调模型,每回合一次
const STEWARD_QUICK_ASKS_PER_TURN = 2;                     // §11.1 第 2 项:速查线程每回合最多两条

// ── 稳定信封 ────────────────────────────────────────────────────────────────────────────
// 形状与 105a observation_recall 同源:{ ok:false, error:<稳定码>, message:<人话> }。error 是模型要
// 分支的机器码,message 只给人看;调用方(模型)对 propose_required / quota_exceeded / steward.busy
// 一律不重试 —— schema description 里写明了。
function stewardFail(code, message, extra) {
  return { ok: false, error: String(code), message: String(message || code), ...(extra && typeof extra === 'object' ? extra : {}) };
}

// ── 小工具 ──────────────────────────────────────────────────────────────────────────────
function stewardClampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
// 会话头的原始 kind(未经 sessionKind 归一)。管家会话过滤与目标合法性判定都靠它。
async function stewardReadSessionHead(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return null;
  try {
    const head = safeJsonParse(await fsp.readFile(sessionPath(sid), 'utf8'), null);
    // 116-2a: 这条读路径绕过 loadSession(只要头,不装正文),所以要自己盖一次会话级权限档的内存
    // 覆盖表 —— 否则用户刚在活回合期间切了档、还没落盘,管家读到的就是旧档(见 02 的覆盖表头注)。
    return head && typeof head === 'object' ? applySessionPermissionModeOverride(head) : head;
  } catch { return null; }
}
function stewardRawKind(head) {
  const k = head && head.kind;
  return (typeof k === 'string' && k) ? k : (head && head.mission ? 'mission' : 'quick_ask');
}
// 线程的【生效】权限档 = resolvePermissionMode 的会话级 > 全局两层(§3.3「新线程用全局默认权限」)。
// 116-2a:改为直调 01-config 的解析器,与回合执行侧(runSessionTurn)用的是同一个函数、同一张白名单 ——
// 管家判「我能不能替它答」与线程实际按哪档执行,从此不可能各算各的。请求级那一层是回合内临时值,
// 不在会话头上,管家看不到也不该看到(它只对那一单当前执行链有效)。
function stewardThreadPermissionMode(head, config) {
  return resolvePermissionMode({ session: head, config });
}
function stewardLastAssistantText(session) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && String(m.content || '').trim()) return String(m.content);
  }
  return String((session && session.summary) || '');
}
// 117s-H1:这一回合的交付正文 = turnSeq 对得上的【最后一条】助手话(09-workflow.js:3079 落盘时每条
// 助手消息都带 turnSeq);不知道回合号、或那一回合没有非空正文时退到整份会话的最后一条非空助手话
// (与 stewardLastAssistantText 同一口径,但【不】退到 session.summary —— 摘要不是交付)。
function stewardTurnAssistantText(session, turnSeq) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  const want = Math.max(0, Number(turnSeq) || 0);
  let matched = '', last = '';
  for (const m of messages) {
    if (!m || m.role !== 'assistant') continue;
    const text = String(m.content == null ? '' : m.content);
    if (!text.trim()) continue;
    last = text;
    if (want > 0 && Number(m.turnSeq) === want) matched = text;
  }
  return matched || last;
}

// 117s-H1:这一回合写过的文件。事实源是【既有的】改动账 —— 02-session-store.js:1513 foldTurnSummaries,
// 也就是 13d:986 给 /api/missions 详情(「看改动」面板)算 filesChanged 的那一份,不新造任何跟踪器。
// fold 按 path 后写胜去重,故同一路径被后面的回合又改过时它归属那个更新的回合 —— 本函数只在
// 【刚跑完的那一回合】上调用,是 fold 里最新的那一层,不受这条影响。
const STEWARD_DELIVERABLE_FILES_MAX = 20;
function stewardTurnFiles(session, turnSeq) {
  const want = Math.max(0, Number(turnSeq) || 0);
  if (!want) return [];
  let folded = null;
  try { folded = foldTurnSummaries(session); } catch { return []; }
  const files = [];
  for (const f of ((folded && folded.filesChanged) || [])) {
    if (!f || !f.path || Number(f.turnSeq) !== want) continue;
    const p = stewardSanitizeText(f.path);
    if (p && !files.includes(p)) files.push(p);
    if (files.length >= STEWARD_DELIVERABLE_FILES_MAX) break;
  }
  return files;
}

function stewardEngineOf(head) {
  const route = (head && head.engineRoute && typeof head.engineRoute === 'object') ? head.engineRoute : null;
  if (!route) return { engine: '', model: '' };
  return {
    engine: route.engine === 'openai' ? 'openai' : (route.agentCliType || 'claude'),
    model: String(route.model || ''),
    providerId: String(route.providerId || ''),
  };
}

// ── 决策日志(§3.5「所有写工具返回 undoRef,决策日志记录」)───────────────────────────────
// 与 inbox 同款 append-only 纪律:先 repairMissionChangeTornTail 把尾部半行截干净,再整行 appendFile,
// 全部经一条 per-process 串行链。开关关时根本走不到这里(门控壳先返回 steward.disabled)。
const stewardDecisionsPath = () => path.join(stewardDir(), STEWARD_DECISIONS_FILE);
let stewardDecisionChain = Promise.resolve();
let stewardDecisionSeq = 0;
// 116-2b:自理动作的溯源基底。13h 在【工具入参】上挂一个内部字段 stewardBasis({inboxSeq,auto,origin}),
// 由下面两个实现并进决策日志的 basis —— 事后能分清「这一次重试是管家自理做的、由第 N 条收件箱
// 事件触发」。它不在工具 schema 里(additionalProperties:false),模型即使编造出来也只影响日志注解,
// 不影响任何判定;args 照旧只记摘要字段,这一坨不进 args。
function stewardBasisOf(args, extra) {
  const raw = (args && typeof args.stewardBasis === 'object' && args.stewardBasis) ? args.stewardBasis : null;
  const base = (extra && typeof extra === 'object') ? { ...extra } : {};
  if (!raw) return base;
  if (raw.inboxSeq != null) base.inboxSeq = Number(raw.inboxSeq) || 0;
  if (raw.auto != null) base.auto = raw.auto === true;
  if (raw.origin) base.origin = String(raw.origin).slice(0, 40);
  return base;
}

function stewardAppendDecision(row) {
  const record = {
    seq: ++stewardDecisionSeq,
    at: nowIso(),
    tool: String((row && row.tool) || ''),
    args: (row && row.args && typeof row.args === 'object') ? row.args : {},
    targetSessionId: String((row && row.targetSessionId) || ''),
    permissionMode: String((row && row.permissionMode) || ''),
    mayAct: String((row && row.mayAct) || ''),
    undoRef: (row && row.undoRef) || null,
    basis: (row && row.basis && typeof row.basis === 'object') ? row.basis : {},
  };
  const line = JSON.stringify(record) + '\n';
  stewardDecisionChain = stewardDecisionChain.then(async () => {
    await fsp.mkdir(stewardDir(), { recursive: true });
    const file = stewardDecisionsPath();
    await repairMissionChangeTornTail(file);
    await fsp.appendFile(file, line, 'utf8');
  }).catch(() => {}); // 记账失败绝不回滚已经做完的动作(与 usage ledger 同款 fire-and-forget 纪律)
  return record;
}

// ── 决策日志的只读面(117e 第 0 步 · §8.6「行动流水」)────────────────────────────────────
// 在 117e 之前决策日志【只有】工具 `steward_audit_tail` 能读 —— 也就是说,只有模型看得见管家做过
// 什么,用户看不见。§8.6 明写「行动流水页按时间列出管家做过的每件事(依据、线程权限、undoRef、
// 费用),支持按线程与按日期过滤」,那需要一条 HTTP 只读面。
//
// 纪律与 inbox 尾窗读取同源(13i stewardReadInboxText/ParseInboxText 的形状):小文件整读、大文件只读
// 尾窗并丢首个半行、坏行整行跳过、文件不存在 = 空(绝不 mkdir —— 开关关时零持久化写入的红线)。
const STEWARD_DECISIONS_LIMIT_DEFAULT = 50;
const STEWARD_DECISIONS_LIMIT_MAX = 200;
const STEWARD_DECISIONS_FULL_READ_BYTES = 8 * 1024 * 1024;
const STEWARD_DECISIONS_TAIL_BYTES = 1024 * 1024;
const STEWARD_DECISIONS_MASK = '••••';

// args 里像密钥的值一律掩码。**判据复用 116-2e 的那一条**(06i 的 STEWARD_CONFIG_SECRET_PATTERN,
// `/apiKey|token|secret|password/i`)—— 不另写第二份正则:两份正则迟早会漂移,而漂移的方向永远是
// 「新面漏掉了旧面拦住的东西」。按【键名】判定(值本身可能是任意串,按值猜是猜不准的),对象递归,
// 深度与宽度都有硬顶(决策日志的 args 本就只记摘要字段,超了说明写日志的地方出了别的问题)。
function stewardMaskDecisionArgs(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => stewardMaskDecisionArgs(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (STEWARD_CONFIG_SECRET_PATTERN.test(key)) { out[key] = STEWARD_DECISIONS_MASK; continue; }
    out[key] = stewardMaskDecisionArgs(item, depth + 1);
  }
  return out;
}

async function stewardReadDecisionsText() {
  const file = stewardDecisionsPath();
  let size = -1;
  try { size = (await fsp.stat(file)).size; } catch { return { text: '', droppedHead: false }; }
  if (size <= STEWARD_DECISIONS_FULL_READ_BYTES) {
    try { return { text: await fsp.readFile(file, 'utf8'), droppedHead: false }; } catch { return { text: '', droppedHead: false }; }
  }
  // 117q-B6(30 号文 P2-10):open/alloc/read/close 收编进 01-config.js 的 readFileTail —— 本处早已按
  // bytesRead 定界(无 bug),这里只是把手写的四步换成共用原语,行为不变。
  try {
    const { buf, bytesRead } = await readFileTail(file, STEWARD_DECISIONS_TAIL_BYTES);
    return { text: buf.toString('utf8', 0, bytesRead), droppedHead: true };
  } catch { return { text: '', droppedHead: false }; }
}

// { limit, sessionId, since } -> { ok, rows, total, limit }
//   · rows 按时间【倒序】(最近的在最前),这是行动流水页的自然阅读序;
//   · since 认 ISO 时间串(比 seq 稳:seq 是 per-process 计数器,重启即从 1 重来),给了就只回
//     `at > since` 的行;非法值当没给(不是报错 —— 只读面对坏参数一律降级为「不过滤」);
//   · total = 尾窗内命中过滤的总行数(不是全量文件行数,尾窗外的行本来就读不到)。
async function stewardDecisionsRead(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const rawLimit = Number(o.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(STEWARD_DECISIONS_LIMIT_MAX, Math.max(1, Math.round(rawLimit)))
    : STEWARD_DECISIONS_LIMIT_DEFAULT;
  const sessionId = safeSessionId(String(o.sessionId || ''));
  const sinceRaw = String(o.since || '').trim().slice(0, 40);
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? sinceRaw : '';
  const { text, droppedHead } = await stewardReadDecisionsText();
  const lines = String(text || '').split('\n');
  const matched = [];
  for (let i = droppedHead ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = safeJsonParse(line, null);
    if (!row || typeof row !== 'object' || Array.isArray(row) || !row.tool) continue;  // 坏行整行跳过
    const at = String(row.at || '');
    if (sessionId && String(row.targetSessionId || '') !== sessionId) continue;
    if (since && !(at > since)) continue;
    matched.push({
      seq: Number(row.seq) || 0,
      at,
      tool: String(row.tool || ''),
      args: stewardMaskDecisionArgs((row.args && typeof row.args === 'object') ? row.args : {}),
      targetSessionId: String(row.targetSessionId || ''),
      permissionMode: String(row.permissionMode || ''),
      mayAct: String(row.mayAct || ''),
      undoRef: (row.undoRef && typeof row.undoRef === 'object') ? row.undoRef : null,
      basis: (row.basis && typeof row.basis === 'object') ? stewardMaskDecisionArgs(row.basis) : {},
      ...(row.cost != null ? { cost: Number(row.cost) || 0 } : {}),
    });
  }
  matched.reverse();
  return { ok: true, rows: matched.slice(0, limit), total: matched.length, limit };
}

// **住在 13j 不住在 06i**:实测 manifest 里 06i@18 排在 06d@19 【之前】—— 06i 引用 06d 的
// projectKeyForCwd 是前向边,而且会连带造出 7 条循环边(依赖图 --check 当场报)。这与 125-P1
// 「06i 读 06 会造 7 条循环边」是同一个坑、同一个文件:**06i 之后的 06 系模块,06i 一律够不着。**
// 13j@39 在 06d 之后、在 13l/13g/13o 之前,是这组函数唯一站得住的落点。
// ── 126-M01(44 号文 §1.2 / §6 ①):记忆的作用域 ──────────────────────────────────────
// 取值两态:空串 = 全局;`project:<16 位十六进制>` = 只在那个项目里成立。键复用工作台库的
// projectKeyForCwd(06d,后向边)—— **两库同一口径**,与 M02 复用 memoryIsExpired 是同一条理由。
//
// **键永远由服务端从一条真实会话的 cwd 推出来,模型只说「这条是不是项目级的」**。这一条是故意的:
// 31 号文 §2.6 的红线要的是「用户自己说的稳定事实」,让模型自己填一个项目键 = 让它推断
// 「这条管得着谁」,正是那条红线禁止的事。
//
// 非法值一律回落全局 —— **绝不静默当成某个项目**(那会让一条本该到处成立的偏好凭空消失一半)。
const STEWARD_SCOPE_PROJECT_PREFIX = 'project:';
function stewardMemoryScopeOf(cwd) {
  const key = cwd ? projectKeyForCwd(cwd) : '';
  return key ? STEWARD_SCOPE_PROJECT_PREFIX + key : '';
}
function stewardNormalizeMemoryScope(raw) {
  const value = String(raw || '');
  if (!value.startsWith(STEWARD_SCOPE_PROJECT_PREFIX)) return '';
  const key = value.slice(STEWARD_SCOPE_PROJECT_PREFIX.length);
  return /^[0-9a-f]{16}$/.test(key) ? value : '';
}
// 「这条记忆在这个作用域里算不算数」的**唯一判据口**。全局条目到处算数;项目条目只在同一个
// 项目里算数。scope 传空 = 不按作用域筛(管家本来就是跨项目的看护者,见 §7 ④ 的拍板)。
function stewardMemoryScopeMatches(entry, scope) {
  const own = stewardNormalizeMemoryScope(entry && entry.scope);
  if (!own) return true;
  const want = stewardNormalizeMemoryScope(scope);
  return !want ? true : own === want;
}
// **住在 06i 不住在 13o**:拼接序是 06i -> 13f -> 13j -> 13k -> 13l -> 13g -> 13m -> 13o,
// 13g 的面板行也要用它 —— 放 13o 就成了 13g 引用它后面的符号(前向边),steward-runner.static ②
// 当场把这条逮了出来。这类「新函数该住哪一层」的判断,机械锁比直觉靠谱。
// 126-M01:把作用域键翻成人看得懂的项目名。**纯展示派生,不是第二套判据** —— 判据在 06i 的
// stewardMemoryScopeMatches,本函数只负责「这一条该怎么说出来」。配置里的工作区表能对上就报名字,
// 对不上就报键的前 8 位(绝不编一个名字出来)。
function stewardMemoryScopeLabel(scope, config) {
  const normalized = stewardNormalizeMemoryScope(scope);
  if (!normalized) return '';
  const rows = [...(Array.isArray(config && config.workspaces) ? config.workspaces : []),
    ...(Array.isArray(config && config.recentWorkspaces) ? config.recentWorkspaces : [])];
  for (const row of rows) {
    const cwd = typeof row === 'string' ? row : String((row && row.cwd) || '');
    if (cwd && stewardMemoryScopeOf(cwd) === normalized) {
      return `,只在「${stewardSanitizeText(cwd.split(/[\\/]/).filter(Boolean).pop() || cwd)}」里成立`;
    }
  }
  return `,只在某个项目里成立(${normalized.slice('project:'.length, 'project:'.length + 8)})`;
}

// ── 管家记忆存储(§4)────────────────────────────────────────────────────────────────────
const stewardMemoryPath = () => path.join(stewardDir(), STEWARD_MEMORY_FILE);
let stewardMemoryChain = Promise.resolve();
function stewardEmptyMemoryStore() { return { schema: STEWARD_MEMORY_SCHEMA, updatedAt: '', entries: [] }; }
function stewardNormalizeMemoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const kind = String(raw.kind || '');
  const text = String(raw.text || '');
  if (!id || !STEWARD_MEMORY_KINDS.includes(kind) || !text) return null;
  const confidence = Number(raw.confidence);
  return {
    id,
    kind,
    text: text.slice(0, STEWARD_MEMORY_LIMITS.textChars),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
    sourceSessionId: String(raw.sourceSessionId || ''),
    sourceSeq: Math.max(0, Number(raw.sourceSeq) || 0),
    createdAt: String(raw.createdAt || ''),
    updatedAt: String(raw.updatedAt || ''),
    lastUsedAt: String(raw.lastUsedAt || ''),
    useCount: Math.max(0, Number(raw.useCount) || 0),
    state: raw.state === 'vetoed' ? 'vetoed' : 'active',
    // 126-M02(44 号文 §1.2):条目的时效。清洗与判据【都不在这儿】—— 复用工作台库
    // (06d)已有的 cleanMemoryDate / memoryIsExpired,那两个原语只读 .expiresAt,与条目形状无关。
    // 这就是本波说的「两库职责划分」:两套存储,一套「什么叫过期」的判据。
    // 老条目没有这个字段 -> 读成空串 -> 永不过期,与今天逐字节同义(存量零迁移,同 mergedFrom 的模具)。
    expiresAt: cleanMemoryDate(raw.expiresAt),
    // 126-M01:作用域。空串 = 全局;非法值一律回落全局(绝不静默当成某个项目)。判据与归一都在 06i,
    // 本文件不自己解析 —— 与 expiresAt 同一条纪律。老条目没有这个字段 -> 读成空串 = 全局,存量零迁移。
    scope: stewardNormalizeMemoryScope(raw.scope),
    // 128h-J12:这条曾被用户否决、又经用户在某个回合里明说而复活(steward_memory_write 带
    // supersedesVetoed)。只留一个标记,面板与决策日志据此能说清「它回来过」。空串 = 没发生过,
    // 老条目读成空串 —— 存量零迁移,与 mergedFrom / expiresAt 同一个模具。
    revivedFrom: raw.revivedFrom === 'vetoed' ? 'vetoed' : '',
    // 116-2e(§4 ⑥ 去重合并):被并进本条的来源 ref,最多 5 个(先进先出)。老条目没有这个字段,
    // 读成空数组 —— 存量零迁移。
    mergedFrom: Array.isArray(raw.mergedFrom)
      ? raw.mergedFrom
        .filter(r => r && typeof r === 'object')
        .slice(-STEWARD_MEMORY_MERGED_FROM_MAX)
        .map(r => ({ sessionId: String(r.sessionId || ''), turnSeq: Math.max(0, Number(r.turnSeq) || 0), at: String(r.at || '') }))
      : [],
  };
}
async function stewardReadMemoryStore() {
  let raw = null;
  try { raw = safeJsonParse(await fsp.readFile(stewardMemoryPath(), 'utf8'), null); } catch { raw = null; }
  // 损坏/缺失/错 schema = 空库(不抢救、不 mkdir):记忆是旁路增强,坏了不该拖住任何回合。
  if (!raw || raw.schema !== STEWARD_MEMORY_SCHEMA || !Array.isArray(raw.entries)) return stewardEmptyMemoryStore();
  const entries = [];
  for (const item of raw.entries) {
    const entry = stewardNormalizeMemoryEntry(item);
    if (entry) entries.push(entry);
    if (entries.length >= STEWARD_MEMORY_LIMITS.maxEntries) break;
  }
  return { schema: STEWARD_MEMORY_SCHEMA, updatedAt: String(raw.updatedAt || ''), entries };
}
// 读-改-写全程串在一条 per-process 链上(同 usage/inbox 纪律),两次并发写不会互相盖掉。
function stewardMutateMemory(mutator) {
  const next = stewardMemoryChain.then(async () => {
    const store = await stewardReadMemoryStore();
    const outcome = await mutator(store);
    if (outcome && outcome.persist) {
      store.updatedAt = nowIso();
      await fsp.mkdir(stewardDir(), { recursive: true });
      await atomicWriteJson(stewardMemoryPath(), store);
    }
    return outcome ? outcome.result : null;
  });
  stewardMemoryChain = next.catch(() => {});
  return next;
}

// ── §11.2 深读预算:每回合 ≤6 次、累计字符 ≤ stewardReadBudgetChars ─────────────────────────
// 桶键与 105a observation_recall 同款:会话 id + 回合序号(= providerHistory 里 user 消息条数,回合内
// 稳定、下回合自增,不需要新管线)。每会话保留最近 4 个桶,全局最多 64 个会话,先进先出。
const _stewardReadBudget = new Map(); // sessionId -> Map(turnKey -> { calls, chars })
function stewardReadBucket(sessionId, turnKey) {
  let buckets = _stewardReadBudget.get(sessionId);
  if (!buckets) { buckets = new Map(); _stewardReadBudget.set(sessionId, buckets); }
  while (_stewardReadBudget.size > 64) _stewardReadBudget.delete(_stewardReadBudget.keys().next().value);
  if (!buckets.has(turnKey)) {
    buckets.set(turnKey, { calls: 0, chars: 0 });
    while (buckets.size > 4) buckets.delete(buckets.keys().next().value);
  }
  return buckets.get(turnKey);
}
function stewardTurnKeyOf(ctx) {
  const session = ctx && ctx.session;
  const history = Array.isArray(session && session.providerHistory) ? session.providerHistory : [];
  return history.reduce((n, m) => n + (m && m.role === 'user' ? 1 : 0), 0);
}

// 每回合配额桶:复用 116c 的 stewardReadBucket 形状(会话 id + 回合序号),但各族一张自己的表 ——
// 深读预算与起草/速查次数是三件不同的事,合在一个桶里会互相饿死。
const _stewardTurnQuota = new Map(); // bucket -> Map(`${sessionId} ${turnKey}` -> count)
function stewardTurnQuotaTake(bucket, ctx, max) {
  const key = String(ctx && ctx.sessionId ? ctx.sessionId : '') + ' ' + stewardTurnKeyOf(ctx);
  let table = _stewardTurnQuota.get(bucket);
  if (!table) { table = new Map(); _stewardTurnQuota.set(bucket, table); }
  const used = Number(table.get(key)) || 0;
  if (used >= max) return false;
  table.set(key, used + 1);
  while (table.size > 64) table.delete(table.keys().next().value);
  return true;
}

// 127 波 2-quater B2(45 号文 §2-quater.2 闸 10):代批的滚动一小时窗口。上限数字住 06i
// (STEWARD_EXEMPT_DELEGATIONS_PER_HOUR),窗口住这里 —— 13l 的 steward_decide 要读它,而 13m 的
// stewardRunnerRuntime 对 13l 是前向边。只在内存:进程重启 = 重新开始数,与 13m 自理动作账
// (stewardRunnerRuntime.selfServe)同一立场。**只记十道闸全过的那一次**(被拦下的不占名额);
// 记在进核心之前 —— 过了闸就算用掉一次,哪怕随后 decideIntervention 回 version_conflict(宁可少代批)。
const stewardExemptDelegationTimes = [];
function stewardExemptDelegationsInWindow(windowNowMs) {
  const now = Number(windowNowMs) || Date.now();
  while (stewardExemptDelegationTimes.length && now - stewardExemptDelegationTimes[0] >= STEWARD_EXEMPT_DELEGATION_WINDOW_MS) {
    stewardExemptDelegationTimes.shift();
  }
  return stewardExemptDelegationTimes.length;
}
function stewardExemptDelegationRecord(windowNowMs) {
  stewardExemptDelegationTimes.push(Number(windowNowMs) || Date.now());
  while (stewardExemptDelegationTimes.length > 64) stewardExemptDelegationTimes.shift();
}

// 已收工的速查会话:总览与线程搜索默认把它排除(includeClosed 可要回来)。判据单点在这里,
// 13g 的 threads_search 与 13h 的 stewardThreadDigestRows 都调它。
//
// 116-3 P1-6:closedAt 【不是】终态。用户完全可能在经典 2.0 视窗里把这条速查线程继续聊下去
// (§11.1 第 2 项只说「答完即收工」,没说「从此不许再用」);修前 closedAt 一旦写入就永久生效,
// 管家的总览与线程搜索从此把它当成历史,彻底跟丢用户的后续对话。判据用 turnSeq 而不是 updatedAt:
// updateSessionMeta 自己就会推 updatedAt,拿它比会在收工的下一刻把线程又「重开」一次。
function stewardQuickClosed(head) {
  const quick = head && head.stewardQuick;
  if (!quick || typeof quick !== 'object' || !quick.closedAt) return false;
  const closedTurnSeq = Number(quick.closedTurnSeq);
  if (!Number.isFinite(closedTurnSeq)) return true;   // 116-3 之前落盘的旧速查线程:没有这个字段,维持原语义
  return Math.max(0, Number(head && head.turnSeq) || 0) <= closedTurnSeq;
}

// 116-3 P1-5:「这条线程是不是管家自己开的速查线程」的唯一判据。
// 【不能】拿 sessionKind() / head.kind === 'quick_ask' 当判据 —— 那是第 70 波遗留的「纯问答默认档」,
// 用户自己发起的普通对话绝大多数都落在它上面;真正的速查线程由 steward_quick_ask 创建,
// 头上带 stewardQuick 这个字段,那才是 116 波「速查线程」这个概念的机器痕迹。
function stewardQuickThread(head) {
  const quick = head && head.stewardQuick;
  return !!(quick && typeof quick === 'object');
}
