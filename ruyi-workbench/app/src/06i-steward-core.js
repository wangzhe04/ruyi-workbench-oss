// ============================================================================
// 第 116 波 116a(27 号文 §11.3):工作台管家(Steward)引擎侧核心——纯函数与延迟绑定命名空间。
//
// 本文件只装两类东西:
//   ① 纯函数(stewardMayAct/buildStewardDigestLine)与冻结常量——不读配置、不碰磁盘、不发网络,
//      入参之外零副作用,方便单测穷举真值表;
//   ② StewardHooks——延迟绑定命名空间(先例 06c-agent-loop-hooks.js 的 AgentLoopHooks):本切片只声明
//      空对象与契约注释,后续 116c/116f 切片的 13g-steward.js 用 Object.assign(StewardHooks, {...}) 填充
//      真实实现;12-tool-dispatch 的管家工具 handler 全程只调用 StewardHooks.*,从不直接依赖 13g,
//      从而让 06i(engine 层)与 13g(transport 层)之间不产生编译期循环引用。
//
// 依赖纪律:本文件只允许引用 00-boot/01-config 的顶层符号(拼接顺序在它们之后,属于后向边);绝不引用
// 07 及之后的编排/工具/传输层模块。当前实现零外部符号引用(见下方各函数),保持这条纪律最简单的满足方式。
// 放置位置:manifest 中紧跟 06h-retrieval-index.js 之后、06d-memory-domain.js 之前(engine 层内部顺序,
// 不隐含新依赖方向)。
// ============================================================================

// 管家收件箱事件五类白名单(116b 起启用):等你(needs_you)/失败(failed)/收工(done)/停滞(stalled)/
// 预算(budget)。心跳与其余事件一律不入箱。本切片只声明常量,轮询器实现在 116b。
const STEWARD_EVENT_KINDS = Object.freeze(['needs_you', 'failed', 'done', 'stalled', 'budget']);

// 116f:管家会话的固定 id 与标题。定在这里(engine 层最早)而不是 13h,是因为 13g(收件箱轮询器)也要
// 用它把管家会话排除在事件源之外 —— 13g 引用 13h 会是前向边,引用 06i 是后向边。
// 为什么不叫 sess_*:13e 的投影扫描器只认 /^sess_[A-Za-z0-9_-]+\.json$/,取名 'steward' 就天然不进
// 投影(进而不进 /api/missions、不进收件箱三源);safeSessionId 的字符集允许它,会话存储照常收编。
// 排除面一律按会话头【原始】 kind === 'steward' 判定(sessionKind() 会把它归一成 quick_ask,不能用),
// 只有拿不到会话头的地方(收件箱轮询的投影行)才按这个固定 id 判定。
const STEWARD_SESSION_ID = 'steward';
const STEWARD_SESSION_TITLE = '如意管家';
// 管家会话的权限模式:独立值,【不】进 PERMISSION_MODES(那张表是线程权限四档,管家自身不设档)。
// nativeToolGate 对管家会话不适用 —— steward_* 一律 allow,真正的边界由 13g 工具内部的 stewardMayAct /
// 永久豁免 / 自理清单执行;非管家工具在管家会话里根本不会被 offer(07 的 stewardSession 分支)。
const STEWARD_PERMISSION_MODE = 'steward';

// 到访总览摘要行的硬性上限(§11.2 到访层预算的一部分)。lastSayChars/lineChars 由
// buildStewardDigestLine 自身强制执行;maxThreads/totalChars 是 116f 组装整块总览时的上限,
// 本切片只声明常量供后续切片复用同一份数字,不在这里做多线程拼装。
const STEWARD_DIGEST_LIMITS = Object.freeze({ lastSayChars: 200, lineChars: 320, maxThreads: 40, totalChars: 12000 });

// 线程权限档位 -> 五态/权限的人话映射(§11.2「诚实」与看板行人话展示共用同一套措辞)。
const STEWARD_STATE_LABELS = Object.freeze({
  dispatching: '交办中',
  running: '进行中',
  needs_you: '需要你',
  done: '已收工',
  stopped: '已停工',
  // 116c 补齐:速问是五态之外的显式逃生舱(mission-state.js 的第六个取值)。116a 只装了任务五态,
  // 到 deriveStewardThreadState 落地时才需要它 —— 缺了会让 quick_ask 线程的人话标签退化成英文枚举值。
  quick_ask: '速问',
});
const STEWARD_PERMISSION_LABELS = Object.freeze({
  default: '每步都问',
  acceptEdits: '改文件不问',
  plan: '只做计划',
  auto: '全自动',
  bypass: '全自动',
  bypassPermissions: '全自动',
});

// 把任意文本变成总览行安全可放的单行文本:折叠换行为空格、把尖括号中和成方括号(总览最终会经既有
// UI 渲染管线,提前中和比信任下游转义更省心——先例见 03-bridge-guard.js 的同类中和纪律)。
function stewardSanitizeText(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n]+/g, ' ').replace(/</g, '[').replace(/>/g, ']');
}

function stewardHasText(value) {
  return value != null && String(value).trim() !== '';
}

function stewardStateLabel(state) {
  const s = stewardSanitizeText(state);
  return Object.prototype.hasOwnProperty.call(STEWARD_STATE_LABELS, s) ? STEWARD_STATE_LABELS[s] : s;
}

function stewardPermissionLabel(mode) {
  const m = stewardSanitizeText(mode);
  return Object.prototype.hasOwnProperty.call(STEWARD_PERMISSION_LABELS, m) ? STEWARD_PERMISSION_LABELS[m] : m;
}

// 116e/§3.3 线程权限真值表的纯函数化:回答「按目标线程的权限档位,管家能否不问用户直接处置这类事件」。
// 只看 permissionMode + eventKind + toolTier 三个入参,不看 stewardAutoActions(自理清单开关由调用方
// 在拿到 'auto' 之后另行叠加判断,见 §3.3「管家的主动行为不再是档位」)。
//
// 真值表(2026-09-05 用户拍板,§3.3):
//   auto / bypass / bypassPermissions(全自动):
//     permission(任意 tier)、question、plan、pool、failed、relay -> 'auto';其它(done/stalled/budget/
//     未知)-> 'propose'。
//   acceptEdits(改文件不问):
//     permission 且 tier ∈ {read, edit} -> 'auto';permission 且 tier 为 exec 或缺失 -> 'propose';
//     question/plan/pool -> 'propose';failed/relay -> 'auto';其它 -> 'propose'。
//   default / plan / dontAsk / 空 / 未知 -> 一律 'propose'。
//
// 入参一律 String() 归一,大小写按原样保留(PERMISSION_MODES 用小驼峰,如 'acceptEdits')。
function stewardMayAct(permissionMode, eventKind, toolTier) {
  const mode = permissionMode == null ? '' : String(permissionMode);
  const kind = eventKind == null ? '' : String(eventKind);
  const tier = toolTier == null ? '' : String(toolTier);
  const isPermission = kind === 'permission';

  if (mode === 'auto' || mode === 'bypass' || mode === 'bypassPermissions') {
    if (isPermission) return 'auto';
    if (kind === 'question' || kind === 'plan' || kind === 'pool' || kind === 'failed' || kind === 'relay') return 'auto';
    return 'propose';
  }
  if (mode === 'acceptEdits') {
    if (isPermission) return (tier === 'read' || tier === 'edit') ? 'auto' : 'propose';
    if (kind === 'question' || kind === 'plan' || kind === 'pool') return 'propose';
    if (kind === 'failed' || kind === 'relay') return 'auto';
    return 'propose';
  }
  // default / plan / dontAsk / 空 / 未知模式:一律只提议。
  return 'propose';
}

// 到访总览一行摘要(§11.2 到访层):纯文本拼装,不做模型改写(「诚实」纪律要求 lastSay 是原话)。
// 入参 thread: { id, missionTitle, title, state, action, lastSay, waitReason, permissionMode, cost }。
// 缺字段的段整段跳过,不留孤立分隔符;lastSay 截到 STEWARD_DIGEST_LIMITS.lastSayChars(超出加「…」);
// 整行硬顶 STEWARD_DIGEST_LIMITS.lineChars(纯截断,不加省略号——「硬顶」与 lastSay 的「截断加省略号」
// 是两条不同的纪律)。
function buildStewardDigestLine(thread) {
  const t = (thread && typeof thread === 'object') ? thread : {};
  const clip = (value, limit) => {
    const raw = stewardSanitizeText(value);
    return raw.length > limit ? raw.slice(0, limit) + '…' : raw;
  };

  const segments = [];

  // 前导段:「[id] 事项标题 / 线程标题」——id 与标题合成一块,内部用空格/斜杠连接,不用外层的 ' · ' 分隔。
  {
    const idText = stewardHasText(t.id) ? `[${stewardSanitizeText(t.id)}]` : '';
    const titleBits = [];
    if (stewardHasText(t.missionTitle)) titleBits.push(stewardSanitizeText(t.missionTitle));
    if (stewardHasText(t.title)) titleBits.push(stewardSanitizeText(t.title));
    const lead = [idText, titleBits.join(' / ')].filter(Boolean).join(' ');
    if (lead) segments.push(lead);
  }
  if (stewardHasText(t.state)) segments.push(stewardStateLabel(t.state));
  if (stewardHasText(t.action)) segments.push(stewardSanitizeText(t.action));
  if (stewardHasText(t.waitReason)) segments.push(stewardSanitizeText(t.waitReason));
  if (stewardHasText(t.permissionMode)) segments.push(stewardPermissionLabel(t.permissionMode));
  {
    const cost = Number(t.cost);
    if (Number.isFinite(cost)) segments.push('$' + cost.toFixed(2));
  }
  if (stewardHasText(t.lastSay)) segments.push('它最后说：' + clip(t.lastSay, STEWARD_DIGEST_LIMITS.lastSayChars));

  let line = segments.join(' · ');
  if (line.length > STEWARD_DIGEST_LIMITS.lineChars) line = line.slice(0, STEWARD_DIGEST_LIMITS.lineChars);
  return line;
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 116 波 116c(27 号文 §3.3 永久豁免 / §3.5 委派 / §4 记忆层):管家工具集所需的纯函数与常量。
// 与本文件上半部同一条纪律:零 require、零外部符号引用、入参之外零副作用。
// ─────────────────────────────────────────────────────────────────────────────

// 管家工具名前缀。四个 offer 面(buildOpenAiTools / MCP tools/list 桥 / adaptive 目录 / /api/status
// 工具清单)与 handler 的 fail-closed 二次校验全部按这个前缀判定,不各自维护名单。
const STEWARD_TOOL_PREFIX = 'steward_';
function isStewardToolName(name) {
  return String(name == null ? '' : name).startsWith(STEWARD_TOOL_PREFIX);
}

// §3.3 永久豁免清单的机器判据(保守正则):待决工具名命中即【任何权限档都不自动放行】,
// steward_decide 一律返回 propose_required 交回用户按。覆盖「不可撤销且外溢」的五类动作:
// 对外发送(send/mail/sms/post_message)、支付与交易(pay/purchase/transfer)、安装卸载
// (install/uninstall)、系统设置与注册表(registry/system_setting)、关机与格式化(shutdown/format)。
// 宁可误判成「要人按」,不可漏判成「自动执行」—— 这条清单的失守没有 checkpoint 可回滚。
const STEWARD_EXEMPT_TOOL_PATTERNS = /send|mail|sms|post_message|pay|purchase|transfer|uninstall|install|registry|system_setting|shutdown|format/i;
function stewardToolPermanentlyExempt(toolName) {
  const name = String(toolName == null ? '' : toolName);
  return name !== '' && STEWARD_EXEMPT_TOOL_PATTERNS.test(name);
}

// 委托书(§3.5「委派」/§11.1 第 9 项)。中和与 stewardSanitizeText 同源,区别只有一条:保留换行
// (委托书补充是多行结构化文本,折行会毁掉可读性)。尖括号 -> 方括号,防伪造围栏标记。
function stewardSanitizeBlock(value) {
  if (value == null) return '';
  return String(value).replace(/\r\n?/g, '\n').replace(/</g, '[').replace(/>/g, ']');
}

const STEWARD_BRIEF_LIMITS = Object.freeze({ supplementChars: 1200, sectionItems: 12, itemChars: 300 });
const STEWARD_BRIEF_OPEN = '<steward-brief added-by="steward">';
const STEWARD_BRIEF_CLOSE = '</steward-brief>';
const STEWARD_BRIEF_TRUNCATED = '\n[管家补充已截断:超过 ' + STEWARD_BRIEF_LIMITS.supplementChars + ' 字]';

// 组装交给线程的首条消息。铁律(§3.5):
//   ① 用户原话【逐字】放最前 —— 不改写、不裁剪、不中和(它是用户自己的话,进的是普通会话的正常管线);
//   ② 管家补充经 stewardSanitizeBlock 中和后放在其后的 [steward-brief added-by="steward"] 围栏里;
//   ③ 补充整体 ≤1200 字,超出截断并就地标注;
//   ④ 没有任何补充时不吐围栏(原话逐字 === 整条消息)。
// 返回 { text, userText, supplement, truncated, memoryIds } —— supplement 供 sessionMeta.brief 分开落盘。
function buildStewardBrief(brief) {
  const b = (brief && typeof brief === 'object') ? brief : {};
  const userText = b.userText == null ? '' : String(b.userText);
  const clipItem = value => stewardSanitizeBlock(value).replace(/\n+/g, ' ').trim().slice(0, STEWARD_BRIEF_LIMITS.itemChars);
  const lines = [];
  const pushOne = (label, value) => {
    const v = clipItem(value);
    if (v) lines.push(label + '：' + v);
  };
  const pushList = (label, value) => {
    const rows = (Array.isArray(value) ? value : []).map(clipItem).filter(Boolean).slice(0, STEWARD_BRIEF_LIMITS.sectionItems);
    if (rows.length) lines.push(label + '：\n' + rows.map(r => '- ' + r).join('\n'));
  };
  pushOne('目标', b.goal);
  pushList('验收项', b.acceptance);
  pushList('相关文件与上下文', b.context);
  pushList('偏好', b.preferences);
  pushList('约束', b.constraints);
  pushOne('参考 playbook', b.playbookId);
  const memoryIds = (Array.isArray(b.memoryIds) ? b.memoryIds : [])
    .map(id => clipItem(id)).filter(Boolean).slice(0, STEWARD_BRIEF_LIMITS.sectionItems);
  if (memoryIds.length) lines.push('引用的管家记忆条目：' + memoryIds.join('、'));

  let supplement = lines.join('\n');
  let truncated = false;
  if (supplement.length > STEWARD_BRIEF_LIMITS.supplementChars) {
    truncated = true;
    supplement = supplement.slice(0, Math.max(0, STEWARD_BRIEF_LIMITS.supplementChars - STEWARD_BRIEF_TRUNCATED.length)) + STEWARD_BRIEF_TRUNCATED;
  }
  // 局部名【不能】叫 text:00-boot.js 顶层有一个 text() 响应助手,同名局部绑定会被依赖图扫描器判成
  // 「06i 引用了 00-boot 的 text」——凭空多出一条 06i->00-boot 的边,进而把 06i 拖进既有 SCC,
  // 让 07/13 指向 06i 的两条后向边一起变成环边。命名避让比放宽 policy 便宜得多。
  const composedText = supplement
    ? (userText + '\n\n' + STEWARD_BRIEF_OPEN + '\n' + supplement + '\n' + STEWARD_BRIEF_CLOSE)
    : userText;
  return { text: composedText, userText, supplement, truncated, memoryIds };
}

// ── 线程五态(§3.3/§11.2)。来源:ruyi-workbench/app/public/js/mission-state.js 的 deriveMissionState /
// fromCard —— 那是浏览器端唯一权威判据,服务端不得另起状态机。此处是【判据逐条抄写】的服务端纯函数
// 副本(前端文件是 UMD 模块,服务端产物是单文件拼接,拉不进来;抄写后由 steward-tools.static.e2e.js
// 机械对账两边的分支顺序与关键字面量)。改判据必须两边同改。
const STEWARD_THREAD_STATES = Object.freeze(['dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask']);
function stewardPendingTotal(p) {
  const o = (p && typeof p === 'object') ? p : {};
  return (Number(o.permissions) || 0) + (Number(o.questions) || 0) + (Number(o.plans) || 0) + (Number(o.pool) || 0);
}
function deriveStewardThreadState(n) {
  const input = (n && typeof n === 'object') ? n : {};
  const src = {
    kind: input.kind || 'quick_ask',
    autoMode: input.autoMode || 'off',
    budgetExhausted: input.budgetExhausted === true,
    resultStatus: input.resultStatus || '',
    pendingTotal: stewardPendingTotal(input.pending),
    activeTurn: input.activeTurn === true,
    liveRuns: Math.max(0, Number(input.liveRuns) || 0),
    runCount: Math.max(0, Number(input.runCount) || 0),
    turnSeq: Math.max(0, Number(input.turnSeq) || 0),
    milestonesTotal: Math.max(0, Number(input.milestonesTotal) || 0),
    milestonesDone: Math.max(0, Number(input.milestonesDone) || 0),
  };
  let state;
  if (src.kind === 'quick_ask') state = 'quick_ask';
  else if (src.pendingTotal > 0) state = 'needs_you';
  else if (src.resultStatus === 'complete') state = 'done';
  else if (src.activeTurn || src.autoMode === 'until-done' || src.liveRuns > 0) state = 'running';
  else if (src.runCount === 0 && src.turnSeq === 0 && src.milestonesDone === 0 && src.resultStatus !== 'stopped') state = 'dispatching';
  else state = 'stopped';
  return { state, label: stewardStateLabel(state), sources: src };
}
// 投影卡片(13e overlayMissionCard 的输出,与 /api/missions 下发的 card 同形)适配器 —— 逐条对应
// mission-state.js 的 fromCard。card 为 null(非 mission 会话)时由调用方走 head 派生分支。
function stewardThreadStateFromCard(card) {
  const m = (card && card.mission) || {};
  const lr = (card && card.lastRun) || null;
  return deriveStewardThreadState({
    kind: (card && card.kind) || 'mission',
    autoMode: m.autoMode,
    budgetExhausted: m.budgetExhausted === true,
    resultStatus: (m.result && m.result.status) || '',
    pending: card && card.pending,
    activeTurn: card && card.activeTurn === true,
    liveRuns: lr && lr.live && !lr.paused ? 1 : 0,
    runCount: card && card.runCount,
    turnSeq: 0,
    milestonesTotal: m.milestonesTotal,
    milestonesDone: m.done,
  });
}

// ── 管家记忆层(§4)。kind 白名单与容量硬上限;词项 Jaccard 用于同义去重(113a 向量化落地前的口径)。
const STEWARD_MEMORY_KINDS = Object.freeze(['profile', 'preference', 'habit', 'focus', 'policy']);
const STEWARD_MEMORY_LIMITS = Object.freeze({ textChars: 300, maxEntries: 200, dedupeJaccard: 0.8, searchLimit: 50 });
// 分词:拉丁按词切,中日韩按 2-gram 切(与 07-autonomy 的 tokenizeToolSearchText 同一思路,但这里必须
// 自足 —— 06i 不引用任何外部符号)。
function stewardMemoryTerms(value) {
  const normalized = String(value == null ? '' : value).normalize('NFKC').toLowerCase();
  const out = new Set();
  for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) continue; // CJK 走下面的 2-gram
    if (word.length > 1 || /^\d+$/.test(word)) out.add(word);
  }
  for (const segment of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || []) {
    if (segment.length === 1) { out.add(segment); continue; }
    for (let i = 0; i + 2 <= segment.length; i++) out.add(segment.slice(i, i + 2));
  }
  return out;
}
function stewardTermJaccard(a, b) {
  const setA = a instanceof Set ? a : stewardMemoryTerms(a);
  const setB = b instanceof Set ? b : stewardMemoryTerms(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const term of setA) if (setB.has(term)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

// 延迟绑定命名空间(先例:06c-agent-loop-hooks.js 的 AgentLoopHooks)。本切片(116a)只声明空对象与
// 契约注释,不实现——填充者是后续切片的 13g-steward.js(transport 层,加载时 Object.assign(StewardHooks,
// {...})),消费者是 12-tool-dispatch.js 里 session.kind==='steward' 才 offer 的管家工具 handler。
// 这样 06i(engine,拼接顺序更早)与 13g(transport,拼接顺序更晚)之间不产生编译期循环引用——06i 从不
// import/require 13g,13g 单向往 06i 已声明的对象上挂方法。
//
// 预留键名契约(116c 起 = 17 个管家工具的实现键 + 116b 的三个基础设施键;13g 加载时必须填满,
// 由 steward-tools.static.e2e.js 机械对账「13g 填充键集 ⊇ 本清单」):
//   基础设施(116b): handleApiRoutes(req,res,pathname)、stopInbox()、inboxState(config)、
//           inboxRead(opts) —— 【原始读取器】,签名与门控都与工具层不同,116b 契约原样保留
//   观察族(tier read): selfStatus(args,ctx)、threadsSearch(args,ctx)、threadStatus(args,ctx)、
//           threadRead(args,ctx)、runsStatus(args,ctx)、inboxReadTool(args,ctx)(它是 steward_inbox_read
//           的门控壳,内部委托上面那个原始 inboxRead)、usage(args,ctx)、health(args,ctx)、auditTail(args,ctx)
//   线程族(tier edit): threadNew(args,ctx)、threadContinue(args,ctx)、threadRename(args,ctx)
//   决策族(tier exec): decide(args,ctx)、runAction(args,ctx)
//   记忆族(tier edit): memoryWrite(args,ctx)、memoryVeto(args,ctx)、memorySearch(args,ctx)
// 全部工具实现键的签名统一为 (args, ctx) 并返回稳定信封(见 13g 的 stewardToolHandler)。
//   回合运行器(116f,由 13h-steward-runner.js 填充;消费者是 06/09/10 的提示词与预算分叉、13g 的
//   轮询器出口与 state 路由 —— 它们全都只看 StewardHooks,不认识 13h,故 13h 无任何入边):
//           buildSystemPrompt(session,config,ctx) -> {stable, volatile}(管家会话整段换掉普通提示词包)
//           contextBudget(session,config,window) -> number(§11.2 预算 = min(配置, 模型窗口) 的触发线)
//           visitNotesPrompt(config) -> string(到访内 L2 压缩用的摘要 prompt)
//           onInboxBatch(rows)(116b 每轮写完箱子后调,13h 去抖后起一个收件箱回合)
//           runnerState(config) -> object(并进 GET /api/steward/state 的响应)
//           handleRunnerApiRoutes(req,res,pathname)(/api/steward/{visit,message,act})
//           stopRunner()/resumeRunner()(一键停机同时停回合队列;start 恢复)
const StewardHooks = {};
