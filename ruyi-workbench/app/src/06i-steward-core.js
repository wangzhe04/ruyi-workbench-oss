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
  // 116c 补齐:五态之外的显式逃生舱(mission-state.js 的第六个取值)。116a 只装了任务五态,
  // 到 deriveStewardThreadState 落地时才需要它 —— 缺了会让这类线程的人话标签退化成英文枚举值。
  // 116-3 P1-5:措辞从「速问」改成「速查中」。§8.1 第 7 条明令界面不出现「速问」这个系统标签;
  // 而且这个取值现在【只】给管家用 steward_quick_ask 开的速查线程用(判据见 13g/13h 的派生分支),
  // 不再是「所有没显式标 mission 的会话」的兜底 —— 那个兜底正是用户实测到的
  // 「管家把我的普通对话说成速查线程」的根因。
  quick_ask: '速查中',
});
const STEWARD_PERMISSION_LABELS = Object.freeze({
  default: '每步都问',
  acceptEdits: '改文件不问',
  plan: '只做计划',
  auto: '全自动',
  bypass: '全自动',
  bypassPermissions: '全自动',
});

// 116-2a(§3.3「管家只能收紧线程权限,不能放宽」/ 永久豁免第 2 条「管家不得自我扩权」):
// 收紧比较用的序。**这张表只用来做「目标档是不是比当前档更紧」这一个比较,不代表安全度线性可加**——
// plan 与 default 谁「更安全」在别的语境下可以争论(plan 不动手但也不问;default 每步都问),这里按
// §3.3 表格从上到下「线程自己能做的事」由少到多排定一个全序,仅供管家工具做单调性判定。
// bypass 与 bypassPermissions 是同一档的两个名字(CLI 原生内部名),同 rank。
const STEWARD_PERMISSION_RANK = Object.freeze({ plan: 0, default: 1, acceptEdits: 2, auto: 3, bypass: 4, bypassPermissions: 4 });
// 未知/空档 -> -1(比较方一律要求两边都 >= 0 才判定,未知档既不算「可收紧」也不算「已放宽」)。
function stewardPermissionRank(mode) {
  const m = mode == null ? '' : String(mode);
  return Object.prototype.hasOwnProperty.call(STEWARD_PERMISSION_RANK, m) ? STEWARD_PERMISSION_RANK[m] : -1;
}
// 「管家能否把 current 改成 target」= 两边都是已知档 且 target 严格更紧。相等也不行(改成同一档是空操作,
// 却会写一条决策日志与一次落盘,没有意义)。
function stewardMayTightenTo(current, target) {
  const a = stewardPermissionRank(current), b = stewardPermissionRank(target);
  return a >= 0 && b >= 0 && b < a;
}

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
const STEWARD_EXEMPT_TOOL_PATTERNS = /send|mail|sms|post_message|pay|purchase|transfer|uninstall|install|registry|system_setting|shutdown|format|mcp_configure/i;

// 116-3 P0-1(对抗审查):只匹配 toolName 字面量的判据在【通用执行工具】面前形同虚设 ——
// `Bash`/`PowerShell`/`run_command`/`delete_file`/`kill_process`/`git_push` 一个都不命中上面那条正则,
// 于是「全自动」线程里一条 `rm -rf <工作夹外路径>` / `winget uninstall X` / `curl -X POST` / `git push`
// 都会被 steward_decide 自动放行。修法:对【不是 read/edit 档】的待决,除了工具名之外还要看命令文本
// (调用方按 tier 决定传不传 input,见 13g stewardImplDecide),命中任一条即降级为提议。
// 纪律与上面那条正则同源:宁可误判成「要人按」,不可漏判成「自动执行」—— 这五类动作没有 checkpoint 可回滚。
const STEWARD_EXEMPT_CONTENT_PATTERNS = Object.freeze([
  // ① 删除数据 / 格式化(不判「在不在工作夹里」:开始跑之前判不准,一律按最坏情况算)
  /\brm\s+-[a-z]*r/i, /\brmdir\b/i, /\bdel\s+\/[sq]/i,
  /\bremove-item\b[^\n]{0,200}?-(recurse|force)/i,
  /\bformat\s+[a-z]:/i, /\bdiskpart\b/i, /\bmkfs\b/i,
  // ② 修改系统设置 / 注册表 / 关机
  /\breg\s+(add|delete)\b/i, /\bregedit\b/i,
  /\b(set|new|remove)-itemproperty\b[^\n]{0,200}?hk(lm|cu)/i,
  /\bnetsh\b/i, /\bshutdown\b/i, /\bbcdedit\b/i,
  /\b(restart|stop)-computer\b/i,
  // ③ 安装卸载软件
  /\b(apt|apt-get|yum|dnf|pacman|brew|choco|winget|scoop)\s+(install|remove|uninstall|purge)\b/i,
  /\bpacman\s+-[SR]/,                       // pacman 用短选项装/卸,不写 install/remove(大小写敏感:-S/-R 是它自己的语法)
  /\bpip3?\s+(install|uninstall)\b/i,
  /\bnpm\s+(install|uninstall|i)\b[^\n]{0,200}?(-g\b|--global\b)/i,
  /\bmsiexec\b/i, /\b(install|uninstall)-(package|module)\b/i,
  // ④ 对外发送(带请求体的外联写、邮件)
  /\bcurl\b[^\n]{0,300}?(-x\s*(post|put|patch|delete)\b|--data\b|\s-d\s)/i,
  /\bwget\b[^\n]{0,300}?--post/i,
  /\binvoke-(webrequest|restmethod)\b[^\n]{0,300}?(-method\s*(post|put|patch|delete)\b|-body\b)/i,
  /\b(sendmail|mailx)\b/i, /\bmail\s+-s\b/i,
  // ⑤ 把改动推出去(git push 不可撤销地外溢到远端)
  /\bgit\s+push\b/i,
]);
const STEWARD_EXEMPT_INPUT_CHARS = 4000;   // 命令文本扫描的硬顶(超长 input 不该让判据变慢)
const STEWARD_EXEMPT_INPUT_DEPTH = 4;
// 把待决 input 里的【全部字符串值】摊平成一段文本。不按键名白名单取:命令可能藏在 command/script/args/
// argv/input 任何一个键下(不同 MCP 服务器命名不一),漏一个键就是漏一整类绕过。
function stewardExemptInputText(input, depth = 0) {
  if (input == null || depth > STEWARD_EXEMPT_INPUT_DEPTH) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return '';
  if (Array.isArray(input)) {
    const parts = [];
    for (const item of input) {
      parts.push(stewardExemptInputText(item, depth + 1));
      if (parts.join(' ').length > STEWARD_EXEMPT_INPUT_CHARS) break;
    }
    return parts.join(' ');
  }
  if (typeof input === 'object') {
    const parts = [];
    for (const value of Object.values(input)) {
      parts.push(stewardExemptInputText(value, depth + 1));
      if (parts.join(' ').length > STEWARD_EXEMPT_INPUT_CHARS) break;
    }
    return parts.join(' ');
  }
  return '';
}
// 117m-A3（对抗审查：A1 把这条判据接成了【原生闸门】的高风险判据后暴露的缺口）：
// 上面那两道判据都只看【文本】—— 工具名字面量与命令行文本。可对外动作不一定长成命令行：
//   · `http_request{method:'POST', url, body}` —— 它就是 `curl -X POST`，只是参数是字段不是命令行；
//   · `mcp_configure` —— 注册一个任意 stdio MCP server 等于任意代码执行。
// 116-3 那一刀只补了命令文本一路，当时这条判据只给 steward_decide 用（漏判的后果是“管家替你按”）；
// 117m 起它同时是「全自动」档自己的免检线，漏判的后果变成“根本不问就发出去”—— 所以补上第三道：
// 结构化入参里的写型 HTTP 方法。只放行公认的读方法（GET/HEAD/OPTIONS）与没写 method 的调用（默认 GET）；
// 其余一律当对外写。宁可误判成「要人按」—— 与上两道同一条纪律。
const STEWARD_EXEMPT_READ_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);
function stewardExemptStructuredWrite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const method = String(input.method == null ? '' : input.method).trim().toUpperCase();
  if (!method) return false;
  return !STEWARD_EXEMPT_READ_METHODS.includes(method);
}
function stewardToolPermanentlyExempt(toolName, input) {
  const name = String(toolName == null ? '' : toolName);
  if (name !== '' && STEWARD_EXEMPT_TOOL_PATTERNS.test(name)) return true;
  if (input == null) return false;
  if (stewardExemptStructuredWrite(input)) return true;
  const composed = stewardExemptInputText(input).slice(0, STEWARD_EXEMPT_INPUT_CHARS);
  if (!composed) return false;
  return STEWARD_EXEMPT_CONTENT_PATTERNS.some(pattern => pattern.test(composed));
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

// 事项级聚合状态(§3.1)。**这是全仓唯一的事项状态定义** —— 入参是子线程五态字符串数组,规则:
//   任一 needs_you → needs_you;否则全部 done → done;否则任一 running → running;
//   否则任一 dispatching → dispatching;否则 stopped;空数组 → dispatching。
// 五态本身由 06i 的 deriveStewardThreadState / stewardThreadStateFromCard 产出(mission-state.js 的
// 服务端抄写件)。这里【不】认识 card、不读磁盘、不看配置:纯函数,可穷举。
// 注:'quick_ask'(五态之外的第六个取值)既不是 done 也不是 running/dispatching,按规则落到 stopped ——
// 这是刻意的:速问线程不构成事项的推进,一个只剩速问的事项对用户就是「没有在动」。
function aggregateMissionState(threadStates) {
  const states = (Array.isArray(threadStates) ? threadStates : []).map(s => String(s == null ? '' : s));
  if (!states.length) return 'dispatching';
  if (states.includes('needs_you')) return 'needs_you';
  if (states.every(s => s === 'done')) return 'done';
  if (states.includes('running')) return 'running';
  if (states.includes('dispatching')) return 'dispatching';
  return 'stopped';
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 116 波 116h(27 号文 §3.1 116h 行 / §8.10「排队可解释」):等待原因的【唯一】判定点。
//
// 铁律:每条等待中的线程有且只有一个原因,优先级从高到低取第一个成立的 ——
//   ① needs_you 等你   :这条线程有待决(它不是被仲裁器挡住的,是在等人;这种回合不占并发位);
//   ② lock     等锁    :同一个工作文件夹已有别的线程在跑写回合(回合级写互斥);
//   ③ budget   等预算  :全局小时回合数或当日费用触顶(排队而不是拒绝);
//   ④ slot     等并发位:并发已满,前面还有 ahead 条。
// 判定顺序不是「哪个更严重」而是「哪个更能让用户知道该干什么」:等你 → 你去按一下;等锁 → 等那条
// 线程;等预算 → 去调上限;等并发位 → 要么等要么插队。
//
// 这是纯函数:入参是两个普通对象,不读配置、不碰磁盘、不认识仲裁器的内部结构。
//   thread: { pending }      —— 该线程的待决条数(缺省 0)。
//   ctx:    { lock?, budget?, slot? } —— 仲裁器对这条线程的当前判定(13h stewardArbiterWait 的返回值);
//           lock:  { sessionId, title }  谁占着这个工作文件夹;
//           budget:{ axis, spent, limit } 哪条闸触顶;
//           slot:  { ahead }             队列里排在它前面还有几条。
// 返回 null(不在等)或 { reason, label, blockedBy?, ahead? } —— 四个调用面(steward_thread_status /
// 总览行 / GET /api/missions 的线程行 / steward_missions 的 threads)输出同一形状。
const STEWARD_WAIT_REASONS = Object.freeze(['needs_you', 'lock', 'budget', 'slot']);
const STEWARD_WAIT_LABELS = Object.freeze({ needs_you: '等你', lock: '等锁', budget: '等预算', slot: '等并发位' });
function waitReasonFor(thread, ctx) {
  const t = (thread && typeof thread === 'object') ? thread : {};
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  const pending = Math.max(0, Number(t.pending) || 0);
  if (pending > 0) return { reason: 'needs_you', label: `等你(${pending} 条待决)` };
  const lock = (c.lock && typeof c.lock === 'object') ? c.lock : null;
  if (lock) {
    // blockedBy 只说事实(title 缺就是空,不拿 id 冒充标题);人话另算一个 who,标题缺了退回 id。
    const title = stewardSanitizeText(lock.title || '');
    const sessionId = stewardSanitizeText(lock.sessionId || '');
    const who = title || sessionId;
    return {
      reason: 'lock',
      label: who ? `等锁：同一个文件夹被「${who}」占着` : '等锁：同一个文件夹被别的线程占着',
      blockedBy: { sessionId, title },
    };
  }
  const budget = (c.budget && typeof c.budget === 'object') ? c.budget : null;
  if (budget) {
    const axis = String(budget.axis || '');
    const limit = Number(budget.limit);
    const spent = Number(budget.spent);
    const detail = axis === 'cost_per_day'
      ? `今天全部线程已花 ${Number.isFinite(spent) ? spent : '?'}，到了上限 ${Number.isFinite(limit) ? limit : '?'}`
      : `本小时全部线程已开 ${Number.isFinite(spent) ? spent : '?'} 个回合，到了上限 ${Number.isFinite(limit) ? limit : '?'}`;
    return { reason: 'budget', label: `等预算：${stewardSanitizeText(detail)}` };
  }
  const slot = (c.slot && typeof c.slot === 'object') ? c.slot : null;
  if (slot) {
    const ahead = Math.max(0, Number(slot.ahead) || 0);
    return { reason: 'slot', label: ahead > 0 ? `等并发位：前面还有 ${ahead} 条` : '等并发位：下一个就是它', ahead };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 117 波 117l(27 号文 §11.9 D5「id 人话化」/ D7「新线程模型分档」/ D4「它在问你」)。
// 三个纯函数,住在 06i 是因为它们【只吃入参】:没有文件读、没有网络、没有全局状态,
// 因而单测可以直接对着真值表跑(dev-harness/unit/steward-humanize.test.js)。
// ─────────────────────────────────────────────────────────────────────────────

// ① 界面上永远不出现内部 id(§11.9 D5;公共纪律第 7 条)。
// 只作用于管家说给人听的两段文字(say / why):
//   · `sess_<16 位十六进制>` → `「显示名」`(titleOf 查不到就【原样保留】—— 宁可露一个 id,
//     也不能把一条线程说成另一条);
//   · 孤立出现的 `question_… / intv_… / run_… / iv_…` 这类纯机器把手 → 删掉,并收紧删除后
//     留下的多余空格与标点(「有待决 question_xx,」→「有待决,」→「有待决,」)。
// 机器字段(acts[].sessionId、actions[].args、决策日志)一概【不】过这个函数:那些 id 是给
// 前端点按钮用的,人话化会把它们变成点不开的字符串。
const STEWARD_ID_SESSION_RE = /\bsess_[0-9a-f]{16}\b/g;
const STEWARD_ID_OPAQUE_RE = /\b(?:question|intv|iv|run|call|req|perm|plan)_[0-9a-zA-Z]{6,64}\b/g;
function stewardHumanizeIds(rawText, titleOf) {
  const raw = String(rawText == null ? '' : rawText);
  if (!raw) return '';
  const lookup = typeof titleOf === 'function' ? titleOf : () => '';
  let out = raw.replace(STEWARD_ID_SESSION_RE, id => {
    let title = '';
    try { title = stewardSanitizeText(lookup(id) || ''); } catch { title = ''; }
    return title ? `「${title}」` : id;
  });
  out = out.replace(STEWARD_ID_OPAQUE_RE, '');
  // 删除后的收尾:成对标点之间的空洞、行首的孤立标点、重复标点、连续空格。
  // 全角标点一律写成 \uXXXX 转义:字符类里的“，”与“,”胉眼看不出差别,
  // 一次编辑器归一就会把整条规则静默地变成只处理 ASCII(本波真撞上过)。
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,\uff0c\u3002;\uff1b:\uff1a\u3001!\uff01?\uff1f])/g, '$1')
    .replace(/([(\uff08\[\u300c\u300e])\s*([)\uff09\]\u300d\u300f])/g, '')
    .replace(/([,\uff0c\u3001;\uff1b])\s*(?=[,\uff0c\u3002\u3001;\uff1b])/g, '')
    .replace(/^[ \t]*[,\uff0c\u3001;\uff1b]+[ \t]*/gm, '')
    // 中文字与开引号之间的那个空格:「线程 sess_x」换完会变成「线程 『名字』」。
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u300c\u300e])/g, '$1')
    .trim();
  return out;
}

// ② 新线程按 tier 选端点/模型(§11.9 D7)。纯判定:tier + config → 「这一档该用哪个端点、哪个模型」。
//   · found:true  —— 该档 providerId 非空且真的在 config.providers 里(model 空则用该 provider 自己的模型);
//   · found:false + fallback:false —— 该档没配,跟随全局(createSession 的既有缺省,不写会话级 engineRoute);
//   · found:false + fallback:true  —— 配了但那个端点已经不在了,回落全局,调用方据此记一条审计。
// **本函数不构造 engineRoute**:那要 02 的 normalizeSessionEngineRoute,而 06i 这一层【不向 00/02/04
// 伸手】(103b 的依赖债务上限机械看住:06i 一旦引用它们就会掉进强连通分量)。构造与落盘在 13h 的
// stewardApplyThreadTier,那里本来就够得到归一器与审计。
function stewardThreadEngineRoute(tier, config) {
  const key = tier === 'fast' ? 'fast' : 'strong';
  const cfg = (config && typeof config === 'object') ? config : {};
  const table = (cfg.stewardThreadModels && typeof cfg.stewardThreadModels === 'object') ? cfg.stewardThreadModels : {};
  const slot = (table[key] && typeof table[key] === 'object') ? table[key] : {};
  const providerId = String(slot.providerId || '').trim();
  if (!providerId) return { tier: key, providerId: '', model: '', found: false, fallback: false };
  const provider = (Array.isArray(cfg.providers) ? cfg.providers : []).find(p => p && p.id === providerId) || null;
  if (!provider) return { tier: key, providerId, model: '', found: false, fallback: true };
  return { tier: key, providerId, model: String(slot.model || '').trim() || String(provider.model || ''), found: true, fallback: false };
}

// ③ 「它在问你」(§11.9 D4)。三态,判定顺序固定:
//   正式待决 question > 活回合(在跑就不算在问你)> 软问句(最后一条助手消息以问号收尾)。
// question 是【机器可答】的(有 questionId,前端给选项按钮);soft 只是一句话,答它走递话通道。
const STEWARD_ASKS_YOU_CHARS = 300;
function stewardAsksYou(input) {
  const o = (input && typeof input === 'object') ? input : {};
  const q = (o.question && typeof o.question === 'object') ? o.question : null;
  if (q && q.questionId) {
    return { kind: 'question', text: stewardSanitizeText(q.text || '').slice(0, STEWARD_ASKS_YOU_CHARS), questionId: String(q.questionId) };
  }
  if (o.activeTurn === true) return null;
  const said = String(o.lastAssistantText == null ? '' : o.lastAssistantText).trim();
  // 半角 '?' 与全角 '\uff1f' 都算(同上一条理由,全角写转义)。
  if (!/[?\uff1f]$/.test(said)) return null;
  // 最后一段:按换行或句末标点切,取末尾那一截(≤300 字)。整段没有分隔时就是它自己。
  const tail = said.split(/\n+/).pop().split(/(?<=[\u3002!\uff01;\uff1b])/).pop().trim() || said;
  return { kind: 'soft', text: stewardSanitizeText(tail).slice(0, STEWARD_ASKS_YOU_CHARS) };
}

// ⑤ 线程行/线程详情的 asksYou:把【待决行】抽成 stewardAsksYou 要的 question 形状。
// 两个调用面(13g 的 steward_thread_status、13e 的看板行叠加层)各自抽一遍的话,
// 「问题原文取哪个字段」就会漂成两套。
// 117m-A2(用户第六轮走查⑤⑥「系统提示的需要我通知,在管家界面也点不开」/「需要我允许的也没在线程中」):
// 修前这一行只认 `iv.type === 'question'`,于是【四类待决】(§3.1 的 permission/question/plan/pool,
// 与 13i-steward-inbox 的 intervention 表同一口径)里只有一类能变成「它在问你」。真机
// sess_8bb0dd55d35045b0 的 14 条待决全是 permission(最后一条 02:34:57 请求、02:36:57 decidedBy
// 'timeout' 被拒),于是:看板行拿不到 asksYou -> 没有 pill;抽屉的问答卡整段不出 -> 右上说「需要你 1」
// 却什么都点不开。
// 修法:按【固定优先级】取第一条待决 question > permission > plan > pool;人话一律走下面那个单点
// stewardPendingOneLine(它对四类都已经有一句人话),本层不另写第二套措辞。
// 返回形状【只加不改】:question 一支逐字不变(既有断言看着 kind/questionId/text),只补一个与
// questionId 同值的 interventionId,让前端四类走同一个字段名去做决策。
function stewardAsksYouForThread(input) {
  const o = (input && typeof input === 'object') ? input : {};
  const list = Array.isArray(o.pending) ? o.pending : [];
  // 顺序即优先级:能【机器可答】的排前面(question 有候选项),再是「按一下就放行」的 permission,
  // 最后是两类「批准/驳回」。同一条线程同时挂多类时只报最靠前的那一条 —— 界面一次只让人做一件事。
  let pending = null;
  for (const type of ['question', 'permission', 'plan', 'pool']) {
    pending = list.find(iv => iv && iv.type === type) || null;
    if (pending) break;
  }
  if (pending && pending.type !== 'question') {
    // 活回合【不】压过正式待决:待决是「机器已经停在那儿等你按一下」,回合在不在跑都不改变这个事实
    // (question 一支的既有语义同此 —— stewardAsksYou 里 question 也判在 activeTurn 之前)。
    return {
      kind: String(pending.type),
      text: stewardSanitizeText(stewardPendingOneLine(pending)).slice(0, STEWARD_ASKS_YOU_CHARS),
      interventionId: String(pending.id || ''),
      // permission 一支多带三样,抽屉要用它们说「这一步要动什么、能不能撤回」(registerIntervention
      // 落盘时就有,不是这里现编的)。
      ...(pending.type === 'permission' ? {
        toolName: String(pending.toolName || ''),
        tier: String(pending.tier || ''),
        revertible: pending.revertible === true,
      } : {}),
    };
  }
  const first = pending ? (Array.isArray(pending.questions) ? pending.questions : [])[0] : null;
  const asks = stewardAsksYou({
    question: pending ? { questionId: String(pending.id), text: (first && (first.question || first.title)) || pending.questionSummary || '' } : null,
    activeTurn: o.activeTurn === true,
    lastAssistantText: o.lastAssistantText,
  });
  return (asks && asks.kind === 'question') ? { ...asks, interventionId: asks.questionId } : asks;
}

// ── 待决与原话的两个纯文本格式化函数(117l 从 13g 搬来,零行为变化)────────────────
// 它们零 IO、零全局状态,本来就属于 06i 这一层;留在 13g 只是历史。搬家的直接理由是
// steward-runner.static ①的「13g < 2000 行」—— 那条规矩是 116f 立的(新判定往 13h/06i 放,
// 不往 13g 堆),本波不放宽它。调用方全在 13g,跨模块方向是 13g -> 06i(后向边,合法)。
const STEWARD_LAST_SAY_CHARS = STEWARD_DIGEST_LIMITS.lastSayChars;   // 200,与总览行同一口径
function stewardClipSay(value) {
  const raw = stewardSanitizeText(value);
  return raw.length > STEWARD_LAST_SAY_CHARS ? raw.slice(0, STEWARD_LAST_SAY_CHARS) + '…' : raw;
}
function stewardPendingOneLine(iv) {
  const type = String((iv && iv.type) || '');
  if (type === 'permission') return `工具 ${stewardSanitizeText(iv.toolName || '?')}(${stewardSanitizeText(iv.tier || 'exec')} 级)等待放行`;
  if (type === 'question') {
    const first = (Array.isArray(iv && iv.questions) ? iv.questions : [])[0];
    return stewardClipSay((first && (first.question || first.title)) || '等待你回答');
  }
  if (type === 'plan') return stewardClipSay(iv.planSummary || '计划等待批准');
  if (type === 'pool') return stewardClipSay(iv.task || '任务池提案等待批准');
  if (type === 'replan') return stewardClipSay(iv.summary || '重规划提案等待批准');
  return stewardClipSay(type || '未知待决');
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

// ─────────────────────────────────────────────────────────────────────────────
// 第 116 波 116-2e(27 号文 §3.5「如意设置」行):`steward_config_get` / `steward_config_set` 的
// 三级分级。allowlist 语义、fail-closed —— 没有明确列进 free/confirm 的键一律 forbidden。
//
// 为什么是白名单而不是黑名单:黑名单的失败方向是「新加的配置键默认可写」。管家是常在用户不在场时
// 自主运行的角色,它的设置面必须让【新增键默认最保守】。于是:
//   free      —— 管家可以直接改(改错了用户一眼看得见、一键改回:语言、输出风格、主题、专家界面开关、
//                 管家自己的节流与预算参数);
//   confirm   —— 必须用户【亲手按下】才生效(ctx.userPressed === true):换主端点/模型、子代理端点、
//                 MCP 连接器与浏览器目标、新线程默认权限、管家开关与「管家可以自己做的事」清单;
//   forbidden —— 任何权限都不经管家改:密钥/token、数据根与工作目录围栏、命令与桌面工具放行、
//                 授权书与提示词注入面。§3.3 永久豁免第 2 条「管家不得自我扩权」的配置侧落地。
//
// 兜底正则在【最前】判:哪怕将来有人把某个含 apiKey/token/secret/password 的键错列进 free/confirm,
// 它仍然是 forbidden(两道闸,不是一道)。
const STEWARD_CONFIG_SECRET_PATTERN = /apiKey|token|secret|password/i;

// free:改错了代价 = 用户看一眼就发现、一键改回;不影响钱、不影响权限、不影响能动世界的范围。
const STEWARD_CONFIG_TIER_FREE = Object.freeze([
  'locale', 'outputStyle', 'theme', 'uiMode',
  // 管家自身设置(§3.5「管家自身设置除默认权限与自理清单外」)。stewardEnabledV1 与
  // stewardAutoActions 【不在这里】—— 前者是管家的总开关、后者是「管家可以自己做的事」清单,
  // 两个都属于「管家扩自己的权」,一律 confirm。
  'stewardProviderId', 'stewardModel', 'stewardPollMs', 'stewardMaxTurnsPerHour', 'stewardMaxCostPerDay',
  'stewardReadBudgetChars', 'stewardVisitIdleMinutes',
  'stewardConversationRetention', 'stewardMaxParallelThreads', 'stewardGlobalMaxTurnsPerHour',
  'stewardGlobalMaxCostPerDay',
  // 【不在这里】的还有 `stewardContextBudgetTokens`:它按设计本该是 free(管家自己的上下文预算),
  // 但键名含 "Tokens",被上面的密钥兜底正则命中 -> forbidden。不为它开正则的例外口子:一个「除了
  // 这一个键」的例外,就是下一次真有密钥键从例外里溜出去的入口。代价是管家改不了自己的上下文预算
  // (用户在设置页照常能改),这个代价比削弱兜底小得多。单测 unit/steward-config-tier.test.js 把
  // 这条判定钉成期望值,不是漏判。
]);

// confirm:改动会花钱、换执行主体、或改变「谁能不问就做什么」的边界 —— 用户亲手按一下才算数。
const STEWARD_CONFIG_TIER_CONFIRM = Object.freeze([
  // 主端点与模型选择
  'agentCliType', 'engineMode', 'activeProvider', 'model', 'compactProviderId', 'compactModel', 'modelsApiBase',
  // 子代理端点(§3.5 逐字列出的 subagentPreferred*)
  'subagentPreferredProvider', 'subagentPreferredModel',
  // MCP 连接器启停与浏览器目标(§3.5:经 mcp_configure 同款审批)
  'externalMcpServers', 'enableMcpDropIn', 'includeWorkbenchMcp', 'browserAutomation',
  // 新线程默认权限、管家总开关与自理清单
  'permissionMode', 'stewardEnabledV1', 'stewardAutoActions',
  // 116-5a:线程自动摘要开关。放 confirm 而不是 free —— 它开着就会在【每一条新线程】上花一次钱,
  // 而且按 §11.8.7 那条口径记的是 aux(note:'thread-brief'),**不进 stewardMaxCostPerDay**。
  // 也就是说管家把它打开等于给自己开了一条不受管家日预算约束的花钱通道,正落在本档「改动会花钱」
  // 那条判据上。它与同族的 stewardProviderId/stewardModel(free)不同:那两个只是换管家自己用哪个
  // 端点,花的还是管家自己那份预算。
  'stewardThreadBriefV1',
]);

// forbidden 的【说明性】清册:不是判据(判据是 fail-closed 的「不在上面两张表里」),而是把
// §3.5 逐字点名的那几类在源码里留一份可读的账,免得日后有人以为漏判了。
const STEWARD_CONFIG_TIER_FORBIDDEN_NOTE = Object.freeze([
  'providers', 'searchBackend', 'modelsApiKey', 'claudeAuthMode',      // 密钥/token 值(另有正则兜底)
  'defaultWorkspace', 'workspaces', 'recentWorkspaces', 'additionalDirectories', 'allowOutsideWorkspace',
  'claudePath', 'kimiPath', 'extraClaudeArgs', 'appendSystemPrompt',   // 数据根/围栏/命令行与提示词注入
  'allowCommandTools', 'allowDesktopTools', 'desktopMcp', 'toolAllowRules', 'bridgedToolTiers',
  'mcpCommandMode', 'permissionBridge', 'autonomyAutoResume', 'agentRoleOverrides', 'usageBudget',
]);

const STEWARD_CONFIG_TIERS = Object.freeze({
  free: STEWARD_CONFIG_TIER_FREE,
  confirm: STEWARD_CONFIG_TIER_CONFIRM,
  forbiddenNote: STEWARD_CONFIG_TIER_FORBIDDEN_NOTE,
  secretPattern: STEWARD_CONFIG_SECRET_PATTERN.source,
});

// 纯函数、零副作用:键名 -> 'free' | 'confirm' | 'forbidden'。非字符串/空串一律 forbidden。
function stewardConfigTierFor(key) {
  const name = typeof key === 'string' ? key.trim() : '';
  if (!name) return 'forbidden';
  if (STEWARD_CONFIG_SECRET_PATTERN.test(name)) return 'forbidden';   // 第一道闸,压过下面两张表
  if (STEWARD_CONFIG_TIER_FREE.includes(name)) return 'free';
  if (STEWARD_CONFIG_TIER_CONFIRM.includes(name)) return 'confirm';
  return 'forbidden';                                                  // fail-closed:未登记 = 禁止
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 116 波 116-2e(§11.1 第 2 项「速查线程」):速查会话的头字段形状与答案硬顶。
// 速查线程 = 管家为了回答一个「要读文件/联网/动手才能答」的问题临时开的线程:不进事项、答完即收工,
// 收工后从总览与线程搜索里消失(数据还在,经典壳照常能看见 —— 它只是不再占管家的注意力预算)。
const STEWARD_QUICK_KIND = 'quick_ask';
const STEWARD_QUICK_ANSWER_CHARS = 1200;
const STEWARD_QUICK_QUESTION_CHARS = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// 第 116 波 116-pre(27 号文 §8.12「递话：交给线程的交互」/ §11.1 第 3 项/ §11.3):
// 递话预判纯函数。零模型、零磁盘、零网络——入参之外零副作用,与本文件上方两段同一条纪律。
//
// prerouteText(q, index, memory, opts) -> { kind, hits }
//   q:       用户正在输入的原文(未提交)。
//   index:   活跃线程行数组(调用方已排除 done 与 steward),每行
//            { sessionId, missionId, missionTitle, title, summary, state, updatedAt }。
//   memory:  活跃管家记忆条目 [{ kind, text }](本函数只认 kind ∈ {focus, habit},其余整条忽略——
//            调用方即便传未过滤的全量记忆也不会误加权,双重保险比信任调用方过滤更省心)。
//   opts:    { now, minScore, unsureRatio }均可选,不传则用 STEWARD_PREROUTE_DEFAULTS。
//
// 五种 kind 的判定顺序(§8.12 第 1 条「输入即预判」逐条落实):
//   ① q 去空白后为空 -> 'steward'(默认收件人「如意」本身,不用词法判定)。
//   ② 命中定时意图(isSchedule)-> 'schedule',优先于线程词法命中(「明天 9 点提醒我交周报」不能
//      因为「周报」命中一条线程就被当成递话——用户是要建提醒,不是要跟那条线程说话)。
//   ③ 词法打分:见 stewardPrerouteScoreThread;候选按分降序、同分按 sessionId 升序(确定性)取前 3。
//   ④ 最高分 < minScore(默认 2):isQuestion(q) -> 'question',否则 -> 'new'。
//   ⑤ 最高分 ≥ minScore 且次高分 ≥ 最高分 × unsureRatio(默认 0.85)-> 'unsure'(hits 给前两名,
//      §8.12 第 5 条「只在真分不出时才问」)。
//   ⑥ 否则 -> 'thread'(hits 只给第一名)。
// ─────────────────────────────────────────────────────────────────────────────

const STEWARD_PREROUTE_DEFAULTS = Object.freeze({
  minScore: 2,
  unsureRatio: 0.85,
  recentMs: 24 * 60 * 60 * 1000,
  weights: Object.freeze({ title: 3, missionTitle: 2, summary: 1 }),
  phraseBonus: 3,
  memoryBonus: 2,
  recentBonus: 0.5,
  stateBonus: 0.5,
  maxHits: 3,
});
// q 的硬顶(§11.3 116-pre 行「不写盘,p50 ≤50ms」——端点侧也夹一遍,这里是纯函数自己的防线,
// 免得调用方漏夹时词法层要在一条超长字符串上跑分词)。
const STEWARD_PREROUTE_QUERY_MAX = 500;

// 定时意图(§8.12「命中定时意图显示『→ 如意 · 定时』」)。宁可误判成 schedule(用户随手改口说
// 「算了，还是接着聊」)也不可漏判成线程命中——递错线程比多问一句「这是要定时吗」代价更大。
const STEWARD_SCHEDULE_RE = /提醒|每天|每周|每月|定时|(明天|后天|大后天|今天|周[一二三四五六日天]|星期[一二三四五六日天])[^\n]{0,8}[点时]|[0-9１-９]{1,2}\s*[点时]/;
// 形参故意不叫 text(同上「记忆加权」处的避让理由——00-boot.js 顶层 text() 响应助手同名撞车,
// 依赖图扫描器不做真实作用域分析,任何叫这个名字的局部绑定——包括形参——都会被误判成引用它)。
function stewardPrerouteIsSchedule(input) {
  return STEWARD_SCHEDULE_RE.test(String(input || ''));
}

// 问句(§8.12「管家自己判断问句并直接作答」/本切片 opts 的 question 分支)。问号 || 含疑问词 ||
// 「吗/呢」收尾,三选一即算问句。疑问词不锚定串首——中文疑问句常见「现在哪条最烧钱」这类主语在前、
// 疑问代词居中的结构(交付物给的原例),锚 ^ 会漏判它,故按「词出现在句中」判定(§11.3 116-pre 行的
// 单测穷举以这条原例为准)。
const STEWARD_QUESTION_LEAD_RE = /(哪|谁|什么|多少|几|为什么|怎么|有没有|是不是|能不能)/;
const STEWARD_QUESTION_TAIL_RE = /(吗|呢)$/;
function stewardPrerouteIsQuestion(input) {
  const s = String(input || '').trim();
  if (!s) return false;
  if (/[?？]/.test(s)) return true;
  if (STEWARD_QUESTION_LEAD_RE.test(s)) return true;
  if (STEWARD_QUESTION_TAIL_RE.test(s)) return true;
  return false;
}

// 引号/书名号内的整段短语(§8.12 词法打分「短语整段命中额外 +3」)。「」直角引号与四种常见直/弯引号
// 都认,段内 1–120 字;同一个 q 里可以有多段。
const STEWARD_PHRASE_RE = /「([^」]{1,120})」|"([^"]{1,120})"|"([^"]{1,120})"|'([^']{1,120})'|'([^']{1,120})'/g;
function stewardPrerouteExtractPhrases(input) {
  const source = String(input || '');
  const phrases = [];
  let m;
  STEWARD_PHRASE_RE.lastIndex = 0;
  while ((m = STEWARD_PHRASE_RE.exec(source))) {
    const value = (m[1] || m[2] || m[3] || m[4] || m[5] || '').trim();
    if (value) phrases.push(value);
  }
  return phrases;
}
function stewardPrerouteContainsPhrase(fieldText, phrase) {
  if (!fieldText || !phrase) return false;
  const haystack = String(fieldText).normalize('NFKC').toLowerCase();
  const needle = String(phrase).normalize('NFKC').toLowerCase();
  return needle.length > 0 && haystack.includes(needle);
}

// 词项打分:与 stewardMemoryTerms 同一套分词口径(ASCII \w+ 小写 + CJK 二元组)——116 波已有的
// 记忆去重与本切片的递话预判没有理由用两套不同的分词规则,复用即省心又省一份要对账的口径。
function stewardPrerouteFieldMatch(fieldText, queryTerms) {
  const matched = new Set();
  if (!fieldText || !queryTerms || !queryTerms.size) return matched;
  const fieldTerms = stewardMemoryTerms(fieldText);
  for (const term of queryTerms) if (fieldTerms.has(term)) matched.add(term);
  return matched;
}

// 记忆加权(§8.12/116-pre 交付物「focus／habit 条目里出现的线程标题或事项标题,对应线程 +2」)。
// 方向是「线程标题出现在记忆条目文本里」(记忆是长文本、标题是短针,包含关系只有这一个方向成立)。
// 局部名故意不叫 text:00-boot.js 顶层有一个 text() 响应助手,同名局部绑定会被依赖图扫描器判成
// 「06i 引用了 00-boot 的 text」(先例见 buildStewardBrief 的 composedText 同款避让)。
function stewardPrerouteMemoryHit(row, memoryEntries) {
  if (!memoryEntries || !memoryEntries.length) return false;
  const needles = [row && row.title, row && row.missionTitle]
    .map(v => (v == null ? '' : String(v)).normalize('NFKC').toLowerCase().trim())
    .filter(v => v.length >= 2);
  if (!needles.length) return false;
  for (const entry of memoryEntries) {
    const entryText = String((entry && entry.text) || '').normalize('NFKC').toLowerCase();
    if (!entryText) continue;
    for (const needle of needles) if (entryText.includes(needle)) return true;
  }
  return false;
}

// 单条线程的分数与命中细节(供排序与 reason 拼装共用,避免算两遍)。
function stewardPrerouteScoreThread(row, terms, phrases, memoryEntries, now, defaults) {
  const titleHits = stewardPrerouteFieldMatch(row && row.title, terms);
  const missionHits = stewardPrerouteFieldMatch(row && row.missionTitle, terms);
  const summaryHits = stewardPrerouteFieldMatch(row && row.summary, terms);
  const phraseHit = phrases.some(p =>
    stewardPrerouteContainsPhrase(row && row.title, p) ||
    stewardPrerouteContainsPhrase(row && row.missionTitle, p) ||
    stewardPrerouteContainsPhrase(row && row.summary, p));
  const memoryHit = stewardPrerouteMemoryHit(row, memoryEntries);
  const updatedMs = Date.parse(String((row && row.updatedAt) || ''));
  const recent = Number.isFinite(updatedMs) && Math.abs(now - updatedMs) <= defaults.recentMs;
  const state = String((row && row.state) || '');
  const stateWeighted = state === 'needs_you' || state === 'stopped';

  let score = 0;
  score += titleHits.size * defaults.weights.title;
  score += missionHits.size * defaults.weights.missionTitle;
  score += summaryHits.size * defaults.weights.summary;
  if (phraseHit) score += defaults.phraseBonus;
  if (memoryHit) score += defaults.memoryBonus;
  if (recent) score += defaults.recentBonus;
  if (stateWeighted) score += defaults.stateBonus;

  return { row, score, titleHits, missionHits, summaryHits, phraseHit, memoryHit, recent, stateWeighted };
}

// reason:一句话说清楚「命中了哪些词、是否记忆加权、是否短语命中」(交付物原句)。尖括号中和同
// stewardSanitizeText。命中词最多列 6 个,防一条长 q 把 reason 撑爆。
function stewardPrerouteReason(candidate) {
  const parts = [];
  const words = new Set([...candidate.titleHits, ...candidate.missionHits, ...candidate.summaryHits]);
  if (words.size) parts.push('命中词：' + Array.from(words).slice(0, 6).join('、'));
  if (candidate.phraseHit) parts.push('短语命中');
  if (candidate.memoryHit) parts.push('记忆加权');
  if (candidate.recent) parts.push('近期更新');
  if (candidate.stateWeighted) parts.push('它在等你或已停');
  if (!parts.length) parts.push('弱匹配');
  return stewardSanitizeText(parts.join('；'));
}
function stewardPrerouteHit(candidate) {
  return {
    sessionId: stewardSanitizeText((candidate.row && candidate.row.sessionId) || ''),
    missionId: stewardSanitizeText((candidate.row && candidate.row.missionId) || ''),
    title: stewardSanitizeText((candidate.row && candidate.row.title) || ''),
    // 116-5b(§11.8.5):递送候选列表显示的名字(人起的 > 生成的 > 原话,判据单点在 02 的
    // sessionDisplayTitle,装配在 13h 的 stewardPrerouteIndexRows)。缺摘要时它逐字等于 title。
    // **打分不用它**:上面的 titleHits 仍然只吃原话 title —— 摘要出来的名字是压过的,拿它去做词法
    // 匹配会把用户当时打的那些词(「超威半导体」)从索引里抹掉,递送反而变笨。
    displayTitle: stewardSanitizeText((candidate.row && candidate.row.displayTitle) || (candidate.row && candidate.row.title) || ''),
    score: Math.round(candidate.score * 100) / 100,
    reason: stewardPrerouteReason(candidate),
  };
}

function prerouteText(q, index, memory, opts) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const defaults = STEWARD_PREROUTE_DEFAULTS;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : defaults.minScore;
  const unsureRatio = Number.isFinite(options.unsureRatio) ? options.unsureRatio : defaults.unsureRatio;
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const raw = q == null ? '' : String(q);
  // 局部名不叫 text(同上「记忆加权」注释里的避让理由——00-boot.js 的 text() 响应助手同名撞车)。
  const clipped = raw.slice(0, STEWARD_PREROUTE_QUERY_MAX);
  const trimmed = clipped.trim();
  if (!trimmed) return { kind: 'steward', hits: [] };
  if (stewardPrerouteIsSchedule(trimmed)) return { kind: 'schedule', hits: [] };

  const terms = stewardMemoryTerms(trimmed);
  const phrases = stewardPrerouteExtractPhrases(trimmed);
  const memoryEntries = (Array.isArray(memory) ? memory : [])
    .filter(e => e && (e.kind === 'focus' || e.kind === 'habit') && e.text);

  const rows = Array.isArray(index) ? index : [];
  const candidates = rows
    .filter(row => row && row.sessionId)
    .map(row => stewardPrerouteScoreThread(row, terms, phrases, memoryEntries, now, defaults))
    .sort((a, b) => b.score - a.score || String(a.row.sessionId).localeCompare(String(b.row.sessionId)));

  const top = candidates.slice(0, defaults.maxHits);
  if (!top.length || top[0].score < minScore) {
    return { kind: stewardPrerouteIsQuestion(trimmed) ? 'question' : 'new', hits: [] };
  }
  if (top.length >= 2 && top[1].score >= top[0].score * unsureRatio) {
    return { kind: 'unsure', hits: [stewardPrerouteHit(top[0]), stewardPrerouteHit(top[1])] };
  }
  return { kind: 'thread', hits: [stewardPrerouteHit(top[0])] };
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
//           的门控壳,内部委托上面那个原始 inboxRead)、usage(args,ctx)、health(args,ctx)、auditTail(args,ctx)、
//           missions(args,ctx)(116g:事项级只读视图 —— 聚合态、验收进度、费用/预算、子线程清单)
//   线程族(tier edit): threadNew(args,ctx)、threadContinue(args,ctx)、threadRename(args,ctx)、
//           threadPrioritize(args,ctx)(116h:把一条排队中的线程提到队首,下一个并发位归它)、
//           threadPermission(args,ctx)(116-2a:线程权限【只降不升】,放宽一律 steward.widen_forbidden)、
//           threadNote(args,ctx)(116-2b:给【已在跑】的线程以插话补一句上下文,走 /api/steer 同一通道)
//   决策族(tier exec): decide(args,ctx)、runAction(args,ctx)、
//           threadStop(args,ctx)(117m-A4:线程级停止 —— runAction 只对【班组】有效,普通线程回合
//           没有 runId;收紧类,任何权限档都放行,没在跑回 not_running。实现住 13h,理由同 threadPrioritize)
//   设置族(tier exec,116-2e): configGet(args,ctx)、configSet(args,ctx)
//           —— 按 stewardConfigTierFor 三级分档:free 直写、confirm 须 ctx.userPressed === true、
//           forbidden 整份拒绝(零写入)。落盘走与 POST /api/config 同一个核心。
//   内容族(116-2e): playbookDraft(args,ctx)(tier edit,只起草不保存,每回合 1 次)、
//           skillToggle(args,ctx)(tier exec,与 POST /api/session/skills 共用 setSessionSkillsCore,须确认)、
//           quickAsk(args,ctx)(tier exec,开一条 kind:'quick_ask' 速查线程,每回合 2 次)、
//           enrichInboxRows(rows)(基础设施:13i 每轮落盘前调,给速查会话的 done 行补 quick/answer)
//   记忆族(tier edit): memoryWrite(args,ctx)、memoryVeto(args,ctx)、memorySearch(args,ctx)
// 全部工具实现键的签名统一为 (args, ctx) 并返回稳定信封(见 13g 的 stewardToolHandler)。
//
// ── ctx.userPressed 的规矩(116-2e,静态锁 steward-tools.static ⑦ 机械看住)──────────────
// `ctx.userPressed === true` 的唯一来源是 13h 的 `POST /api/steward/act` 执行路径 —— 用户在界面上
// 【亲手按下】了那个按钮,13h 在构造 ctx 时置 true。模型回合里的工具调用 ctx 【永远】没有它,
// 13g 的 stewardToolHandler 在进实现前把 args 里任何同名字段剥掉(模型自称「用户按了」不算数)。
// 读它的地方只有两处:steward_config_set 与 steward_skill_toggle 的「须确认」判定。
// `stewardMayAct`、永久豁免清单、线程权限判定一概【不读】它 ——
// 用户按下一个按钮 ≠ 管家从此获得放宽权限的能力(§3.3 永久豁免第 2 条)。
//   回合运行器(116f,由 13h-steward-runner.js 填充;消费者是 06/09/10 的提示词与预算分叉、13g 的
//   轮询器出口与 state 路由 —— 它们全都只看 StewardHooks,不认识 13h,故 13h 无任何入边):
//           buildSystemPrompt(session,config,ctx) -> {stable, volatile}(管家会话整段换掉普通提示词包)
//           contextBudget(session,config,window) -> number(§11.2 预算 = min(配置, 模型窗口) 的触发线)
//           visitNotesPrompt(config) -> string(到访内 L2 压缩用的摘要 prompt)
//           onInboxBatch(rows)(116b 每轮写完箱子后调,13h 去抖后起一个收件箱回合)
//           runnerState(config) -> object(并进 GET /api/steward/state 的响应)
//           handleRunnerApiRoutes(req,res,pathname)(/api/steward/{visit,message,act})
//           stopRunner()/resumeRunner()(一键停机同时停回合队列;start 恢复)
//   116h 线程间仲裁(由 13h-steward-runner.js 填充;消费者是 10 的回合入口、13 的 /api/stop、
//   13d 的事项聚合行与 13g 的 thread_status/路由 —— 同样只看 StewardHooks,不认识 13h):
//           acquireTurnSlot({sessionId,title,cwd,config,signal,onEvent}) -> {granted, release}
//             (回合开始处申请;开关关或管家会话根本不调它)
//           arbiterWait(sessionId) -> {lock?}|{budget?}|{slot?}|null(喂给 06i 的 waitReasonFor,同步只读)
//           cancelQueuedTurn(sessionId) -> boolean(/api/stop 把【还在排队】的回合也停掉)
//           arbiterRefresh() -> boolean(POST /api/config 落盘后唤醒队列,让改上限即时生效)
//           (插队与仲裁器快照【不】进命名空间:它们的消费者全在 13h 内部 —— 两条
//            /api/steward/arbiter* 路由、steward_thread_prioritize 实现、并进 state 的 runnerState)
//   117l D2 递话通道(由 13h-steward-runner.js 填充;消费者是 13g 的 steward_thread_continue ——
//   同样只看 StewardHooks,不认识 13h):
//           applyThreadTier(session,tier,config) -> {tier, engine:{providerId,model}}
//             (117l D7:把 06i 判出来的那一档落成 session.engineRoute;端点已删时回落全局并记一条审计。
//              住 13h 是因为它要 02 的 normalizeSessionEngineRoute 与 04 的 logEvent —— 06i 够不着)
//           relayDeliver({sessionId,message,title,source,launch}) -> 稳定信封 { ok, channel, … }
//             (按目标状态选通道,顺序 答>批>插>新:answer 走 decideIntervention、
//              permission 不代答、steer 走 steerSessionCore、turn 走调用方给的 launch。
//              通道判定本身(stewardRelayChannelFor)只服务 13h 内部,故不上命名空间)
//   116-pre(由 13h-steward-runner.js 填充,GET /api/steward/preroute 与 117 壳层都经这个键调):
//           preroute(q,config?) -> { kind, hits }(装配 index/memory 后调纯函数 prerouteText;
//           零模型、缓存命中不重装配)
const StewardHooks = {};
