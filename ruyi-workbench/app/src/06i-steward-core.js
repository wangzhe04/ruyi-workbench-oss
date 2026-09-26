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
// 121-K3(34 号文 §4.4「交接」):第六类 adopted —— 用户把一条线程【交给管家盯】(写 stewardWatch:true)。
// 它不是「出事了」,而是一次交接:管家下一拍要回一句「好,『X』我盯着」。排在表尾,前五类的
// 顺序与语义一个字不动(到访摘要按本表顺序归纳,插在中间会改既有摘要的行序)。
// 123-M2(37 号文 §3.5):第七类 reminder —— 定时任务的三件事(到点提醒、错过跳过、连败熔断)。
// 它与前六类的区别是【不需要回答】:那六类都在说「某条线程怎么样了」,而这一类是「你自己排的
// 那件事到点了」。所以它不进 needs_you 那一行的计数,也不该起一个管家回合(reminder 是事实,
// 不是问题;13t 写这类行时故意不敲 StewardHooks.onInboxBatch)。同样排在表尾,前六类的顺序
// 与语义一个字不动(到访摘要按本表顺序归纳)。
const STEWARD_EVENT_KINDS = Object.freeze(['needs_you', 'failed', 'done', 'stalled', 'budget', 'adopted', 'reminder']);

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

// 117w-W1 提交③(27 号文 §11.19.2 与 §11.19.7 的裁决「两处读同一个常量」):工作区候选表的行数上限。
// 【一处定义、两处读】:
//   · 13o 的候选表投影按它折叠(超出写「…另有 N 个未列出」,不截断);
//   · 13k 的 cwd 拒绝文案按它列候选末段名(同样带「另有 N 个未列出」)。
// 提交① 落地时这两处一个 20 一个 8,是一条会咬人的分叉:模型在上下文里看得见 20 行,被拒时只被
// 提醒其中 8 个,它会合理地推断「另外那 12 个不能用」,然后去编一个新路径。数字必须是同一个。
// 117w-W1④:这个 20 【保持不动】,动的是 01-config 的 WORKSPACE_TABLE_CAP(20 → 64)。两个数
// 治的是两件事:64 是「表能存多少行」(工作台自己会往里追加派生行,表必须能长),20 是「一次给
// 管家看多少行」(到访层的字数预算)。分开之后 21..64 行的表在【生产形状】下真的会折叠,13o 那句
// 「…另有 N 个工作区未列出」从此可达、可测 —— 在此之前表最多 20 行,那句话永远印不出来。
const STEWARD_WORKSPACE_TABLE_MAX = 20;
// W7(用户 2026-09-24「管家需要把工作区和任务联系起来」):到访层的「已知工作区」清单的预算。行数上限
// 仍读 STEWARD_WORKSPACE_TABLE_MAX(与 13k 的拒绝文案同一个数);每行最多带 3 条最近的线程,线程名截
// 24 字;整块另有 2400 字的总预算(与总览同一套写法:超出折叠成一句,不截断)。
const STEWARD_KNOWN_WORKSPACE_LIMITS = Object.freeze({ threadsPerRow: 3, threadTitleChars: 24, lineChars: 260, totalChars: 2400 });

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
// auto 的措辞必须与 locale 的 permission.mode.auto.short 同词(「智能自动」):修前 auto 与 bypass 都印
// 「全自动」,界面上分不出自己在哪一档(locale 早已把 auto 改成「智能自动」,只有这里还留着旧词)。
// bypass 仍叫「全自动」—— 它的 locale 键 permission.mode.bypass.short 就是这四个字,别顺手一起改。
const STEWARD_PERMISSION_LABELS = Object.freeze({
  default: '每步都问',
  acceptEdits: '改文件不问',
  plan: '只做计划',
  auto: '智能自动',
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

// 把任意文本变成总览行安全可放的单行文本:折叠换行为空格、把尖括号中和成全角尖括号(总览最终会经既有
// UI 渲染管线,提前中和比信任下游转义更省心——先例见 03-bridge-guard.js 的同类中和纪律)。
// 128f(Brief §4.2 第 7 条后半):修前中和成方括号 —— `2>&1` 变成 `2]&1`、`a < b` 变成 `a [ b`,管家读命令摘录时
// 意思就变了(代批判风险看的正是那段摘录)。换成全角 ＜＞(U+FF1C／U+FF1E):照样拼不出管家提示词里 ASCII 的
// <围栏> 标记,人和模型都还读得出是「小于／大于／重定向」。
const STEWARD_NEUTRAL_LT = '＜';
const STEWARD_NEUTRAL_GT = '＞';
function stewardSanitizeText(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n]+/g, ' ').replace(/</g, STEWARD_NEUTRAL_LT).replace(/>/g, STEWARD_NEUTRAL_GT);
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

// ── 125-P0(42 号文 §1 ①):被【停】下来的目标,管家不自动重开 ──────────────────────────────
// 用户按停一条线程或一个班组之后,收件箱里常常还会迟到一条 failed ——在飞节点带着中断错误落定、
// 结果章 stopped 带错误、run_end partial 都会走到那一格。而 116-2b 确定性自理拿到 failed 的默认
// 处置就是【重开】(班组 retry_node、线程一句「继续」),它那几道闸问的是「勾没勾、够不够权限、
// 这小时做过几次」,没有一道问「这东西是不是刚被停下来的」—— 于是用户按下的停,被管家撤销了。
//
// 判据只读两处【既有】落盘事实,不加任何字段:
//   · 班组快照的终态 status === 'stopped'(09-workflow 收尾时写;班组被重新拉起时它自然翻新);
//   · 会话头上 stewardLastTurn.aborted === true(13k 在回合 settle 之后落的账)。**并且这条账要
//     盖得住当前回合**(last.seq >= head.turnSeq)—— 与 13i 收集第四源时「账没盖到当前回合就当它
//     还没结束」同一条纪律:账过期了就不算数,否则一条很久以前被停过的线程会被永久挡住。
//
// 「被停」不等于「用户按的停」:superseded / disconnected / steward-stop / scheduler_timeout 都会
// 落 aborted。这是刻意的 —— 本判据要分的是【自己挂了】与【被停下来】:前者可以自理重试,后者一律
// 只提议。谁停的都一样,停是一次明确的意思表示,管家不该替任何人撤销它。
//
// 返回 '' | 'run' | 'thread'(当布尔用也成立)。三处调用点(13k 递话、13l 班组动作、13p 自理预闸)
// 都只在【用户不在跟前】时判,拿到结果一律转成 propose_required —— 降级成一枚按钮,用户自己按仍然
// 照做。这一刀是「不自动重开」,不是「不许重开」。
function stewardStoppedTarget(head, run) {
  if (run && typeof run === 'object' && String(run.status || '') === 'stopped') return 'run';
  const h = (head && typeof head === 'object') ? head : null;
  const last = (h && h.stewardLastTurn && typeof h.stewardLastTurn === 'object') ? h.stewardLastTurn : null;
  if (!last || last.aborted !== true) return '';
  const covered = Math.max(0, Number(last.seq) || 0) >= Math.max(0, Number(h.turnSeq) || 0);
  return covered ? 'thread' : '';
}
// 三处调用点共用的两句话(表唯一:别处不许再写第三句)。拒绝理由要自己说清「按钮还在」,
// 因为用户看见的就是这一句 —— propose_required 的 message 会原样进降级后的那枚按钮旁边。
const STEWARD_STOPPED_SAY = Object.freeze({
  run: '这条班组是被停下来的,管家不会自动把它重新拉起来;要接着跑,按这枚按钮',
  thread: '这条线程上一回合是被停下来的,管家不会自动往里递话;要接着做,按这枚按钮',
});
function stewardStoppedRefusal(which) {
  const key = String(which || '');
  return Object.prototype.hasOwnProperty.call(STEWARD_STOPPED_SAY, key) ? STEWARD_STOPPED_SAY[key] : '';
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
  // 121-K3(§4.5「管家对你正坐着的线程」):用户此刻就坐在这条线程前面(在场快照说 lens=classic 且
  // sessionId 命中)。总览行上直说一句,管家读提示词那一眼就知道这条不该动手 —— 工具门(13k 的
  // seated_by_user)是硬拦,这一句是软告知:光有硬拦,模型会反复去试然后反复被拒。
  if (String(t.seatedBy || '') === 'user') segments.push('你正坐在这条线程里');
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
// 127 波 2-bis(45 号文 §2-bis,用户真机走查):上面那条正则是裸子串,工作台自己的两个本机工具只因名字里有
// send 就被当成「对外发送」进了永久豁免 —— 于是全自动线程每递一行 shell_send 都得用户亲手按,而同族的
// powershell_run/run_command 名字不命中、走的是下面的命令文本扫描。方向是反的。这里只放出【精确全名】,
// 正则本身一个字不动:外部 MCP 的 slack_send/send_message 之类照样按名字拦(宁可误判成「要人按」)。
//   · shell_send —— 往本进程已起的 PowerShell 会话递一行字。危险全在那行字里,与 powershell_run 同族,
//     交给命令文本扫描判。前提已用真夹具证过:两条路径(原生闸门 / steward_decide)都把它的 input 交到了
//     扫描手里(dev-harness/steward-exempt-shell-send.e2e.js H2/P1)。
//   · keyboard_send_keys —— 用户 2026-09-17 拍板放出(「放出来吧，估计有很多操作也是要按键盘的」)。
//     【接受的代价】它往当前前台窗口敲键:聊天软件里一个 {ENTER} 就是真的发出去了,而命令文本扫描判不了
//     「前台是什么窗口」;扫描仍然作用于它的 keys 入参(敲的是 rm -rf / git push 照样拦)。
// 为什么只认精确全名、大小写敏感:原生引擎里外部 MCP 工具恒为 `<serverId>__<工具名>`(04 collectBridgedTools),
// 且 resolveBridge 内建名优先(裸名 shell_send 永远落到内建实现);CLI 引擎恒为 `mcp__<server>__<工具名>`。
// 所以裸名只可能是工作台自己的那两个工具。前缀形态【不】放 —— 判据拿不到引擎上下文,而
// `mcp__win-claude-workbench__shell_send` 在原生引擎里能被一个 id 为 mcp 的外部服务器凑出来
// (serverId=mcp + 工具名 win-claude-workbench__shell_send);CLI 那两条路上 shell 族在 MCP 子进程里本就是
// 引导性报错(12 shellMcpChildGuard),放它没有收益。
const STEWARD_EXEMPT_NAME_CARVEOUTS = Object.freeze(['shell_send', 'keyboard_send_keys']);

// 116-3 P0-1(对抗审查):只匹配 toolName 字面量的判据在【通用执行工具】面前形同虚设 ——
// `Bash`/`PowerShell`/`run_command`/`delete_file`/`kill_process`/`git_push` 一个都不命中上面那条正则,
// 于是「全自动」线程里一条 `rm -rf <工作夹外路径>` / `winget uninstall X` / `curl -X POST` / `git push`
// 都会被 steward_decide 自动放行。修法:对【不是 read/edit 档】的待决,除了工具名之外还要看命令文本
// (调用方按 tier 决定传不传 input,见 13g stewardImplDecide),命中任一条即降级为提议。
// 纪律与上面那条正则同源:宁可误判成「要人按」,不可漏判成「自动执行」—— 这五类动作没有 checkpoint 可回滚。
// 127 波 2-bis ③:命中时要说得出【是哪一类】—— 用户真机上管家只能说「命令原文我这边看不到」,讲不出是哪条
// 规则咬的。于是五组按类别分桶:类别键给机器(steward_decide 的 exemptCategory),人话在下面的标签表。
// 组内正则逐字未动,只是分了桶;组序即报告优先级(一条命令同时命中两类时,报排在前面的那一类)。
// 127 波 2-quater B1 ②(45 号文 §2-quater.2):每组再拆成「非底线 / 底线(floor:true)」两个子组,子组【沿用同一个
// 类别键、紧挨着排】—— 于是 stewardExemptReason 的「首中报类」、五个标签与布尔判据逐字节不变(find 找到的
// 仍是同一个类别键),只有 stewardExemptHits 能看出「命中的是不是底线项」。底线 = 任何条件下都只能由用户亲自按
// 的动作(拍板 1):format/diskpart/mkfs、改系统整组、sendmail/mailx/mail -s;另有「灾难性删除目标」一张
// 独立的表(见下),它只给删数据那一条命中加底线标记,不改变什么算豁免。
const STEWARD_EXEMPT_CATEGORY_LABELS = Object.freeze({
  delete_data: '删数据', system_change: '改系统', install: '装卸载', outbound_send: '对外发送', push_remote: '推送远端',
});
const STEWARD_EXEMPT_CONTENT_GROUPS = Object.freeze([
  // ① 删除数据 / 格式化(不判「在不在工作夹里」:开始跑之前判不准,一律按最坏情况算)
  Object.freeze({ category: 'delete_data', floor: false, patterns: Object.freeze([
    /\brm\s+-[a-z]*r/i, /\brmdir\b/i, /\bdel\s+\/[sq]/i,
    /\bremove-item\b[^\n]{0,200}?-(recurse|force)/i,
  ]) }),
  Object.freeze({ category: 'delete_data', floor: true, patterns: Object.freeze([
    /\bformat\s+[a-z]:/i, /\bdiskpart\b/i, /\bmkfs\b/i,
  ]) }),
  // ② 修改系统设置 / 注册表 / 关机(整组是底线)
  Object.freeze({ category: 'system_change', floor: true, patterns: Object.freeze([
    /\breg\s+(add|delete)\b/i, /\bregedit\b/i,
    /\b(set|new|remove)-itemproperty\b[^\n]{0,200}?hk(lm|cu)/i,
    /\bnetsh\b/i, /\bshutdown\b/i, /\bbcdedit\b/i,
    /\b(restart|stop)-computer\b/i,
  ]) }),
  // ③ 安装卸载软件
  Object.freeze({ category: 'install', floor: false, patterns: Object.freeze([
    /\b(apt|apt-get|yum|dnf|pacman|brew|choco|winget|scoop)\s+(install|remove|uninstall|purge)\b/i,
    /\bpacman\s+-[SR]/,                       // pacman 用短选项装/卸,不写 install/remove(大小写敏感:-S/-R 是它自己的语法)
    /\bpip3?\s+(install|uninstall)\b/i,
    /\bnpm\s+(install|uninstall|i)\b[^\n]{0,200}?(-g\b|--global\b)/i,
    /\bmsiexec\b/i, /\b(install|uninstall)-(package|module)\b/i,
  ]) }),
  // ④ 对外发送(带请求体的外联写、邮件;邮件那两条是底线)
  Object.freeze({ category: 'outbound_send', floor: false, patterns: Object.freeze([
    /\bcurl\b[^\n]{0,300}?(-x\s*(post|put|patch|delete)\b|--data\b|\s-d\s)/i,
    /\bwget\b[^\n]{0,300}?--post/i,
    /\binvoke-(webrequest|restmethod)\b[^\n]{0,300}?(-method\s*(post|put|patch|delete)\b|-body\b)/i,
  ]) }),
  Object.freeze({ category: 'outbound_send', floor: true, patterns: Object.freeze([
    /\b(sendmail|mailx)\b/i, /\bmail\s+-s\b/i,
  ]) }),
  // ⑤ 把改动推出去(git push 不可撤销地外溢到远端)
  Object.freeze({ category: 'push_remote', floor: false, patterns: Object.freeze([
    /\bgit\s+push\b/i,
  ]) }),
]);
// 127 波 2-quater B1 ②:灾难性删除目标(主会话在拍板 1 之外另加的底线项)。`rm -rf ./build` 与 `rm -rf /`
// 在上面那组里是同一条命中,可后者删的是整个盘 / 整个家目录 —— 它不该和「清一下构建目录」落在同一格。
// 这张表【只加底线标记、不改变什么算豁免】:它只在删数据那一类已经命中时才被问,问中了就把那条命中升成底线。
// 判定按「一段简单命令」来(按换行、; & | 切段):同一段里既有递归删除的动词+开关,删除动词之后又出现
// 目标 `/`、`\`、`X:\`、`~`、`$HOME`、`$env:USERPROFILE`、`%USERPROFILE%`(可带引号、可带尾随 `*`)。
// 目标必须是整段路径 —— `/tmp/x`、`C:\build`、`~/proj` 都不算(它们后面还跟着路径字符)。
const STEWARD_EXEMPT_FLOOR_DELETE_VERBS = Object.freeze([
  // rm -r / -rf / -fr / --recursive(前面可以先摆几个别的开关,如 --no-preserve-root)
  /\brm\s+(?:-{1,2}[a-z-]+\s+)*(?:-[a-z]*r[a-z]*|--recursive)(?=\s|$)/i,
  // PowerShell Remove-Item 及其别名的 -Recurse(含前缀缩写与 -Recurse:$true 写法)
  /\b(?:remove-item|ri|rm|rmdir|rd|del|erase)\b[^\n]*?\s-(?:r|re|rec|recu|recur|recurs|recurse)(?=[\s:]|$)/i,
  // cmd 的 rmdir /s、del /s
  /\b(?:rmdir|rd|del|erase)\b[^\n]*?\s\/s(?=\s|$)/i,
]);
const STEWARD_EXEMPT_FLOOR_DELETE_TARGET = /(?:^|\s)["']?(?:[\\/]|[a-z]:[\\/]|~[\\/]?|\$home[\\/]?|\$env:userprofile[\\/]?|%userprofile%[\\/]?)\*?["']?(?=\s|$)/i;
function stewardExemptCatastrophicDelete(scanText) {
  for (const segment of String(scanText == null ? '' : scanText).split(/[\r\n;&|]+/)) {
    for (const verb of STEWARD_EXEMPT_FLOOR_DELETE_VERBS) {
      const found = verb.exec(segment);
      if (found && STEWARD_EXEMPT_FLOOR_DELETE_TARGET.test(segment.slice(found.index))) return true;
    }
  }
  return false;
}
// 107-S1 ②(46 号文 §5 ⑦b H2 实验 E2):**间接构造一律不代批**。
// 实测 `& ('shut' + 'down') /s /t 0` 一条判据都不命中(关机那条正则找的是字面 `shutdown`),
// 与 `rm -rf ./build` 混在一起时 `delegable:true` —— 也就是说只要把关键词拆开拼,代批闸的四、六两道
// 就都绕过去了。字面正则治不了这一类(要治就得实现一个 shell 求值器),所以反过来判【构造手法本身】:
// 命令里出现拼接 / 求值 / 编码这些「字面量不等于真正要跑的东西」的形状,就不代批。
// 【只拦代批,不改什么算豁免】:本表不进 STEWARD_EXEMPT_CONTENT_GROUPS —— stewardExemptReason 与
// stewardToolPermanentlyExempt 的输出逐字节不变(单测按样本钉住),它只让 stewardExemptDelegationVerdict
// 多报一个 blockedBy:'indirect_command'。理由:豁免命中 = 「这条命令属于那五类动作」,而间接构造说的是
// 「我判不出它属于哪一类」—— 把后者塞进前者会让「命中类别」这个概念失真(用户会看到「删数据」的帽子
// 扣在一条其实要关机的命令上),而且会连带改变原生闸门(07 nativeToolGate)对所有档位的停问行为。
// 误判方向:拼接、`-join`、`[char]` 这些在正常脚本里也出现 —— 代价是那种线程的这一条要用户亲自按。
const STEWARD_EXEMPT_INDIRECT_PATTERNS = Object.freeze([
  /\biex\b/i, /\binvoke-expression\b/i,                // PowerShell 求值:iex 是 Invoke-Expression 的别名
  /(?:^|[^&])&(?!&)[ \t]*\(/,                          // & (…) 调用运算符作用在括号表达式上(`&& (…)` 是管道链,不算)
  /(?:^|[\s;(])\.[ \t]*\(/,                            // . (…) 点源运算符(`.\tmp`、`x.map(` 都不是这个形状)
  /\(\s*(['"])[^'"\n]*\1\s*\+/,                        // 括号里以字符串拼接开头:('shut' + 'down')
  /(['"])[^'"\n]*\1[ \t]*\+[ \t]*(?:['"]|\$)/,         // 字符串 + 字符串 / 字符串 + 变量(拼在括号外也算)
  /\bfrombase64string\b/i,                             // base64 解码后执行
  /\[\s*char\s*\]/i, /-join\b/i,                       // [char]0x72 / -join 逐字拼装
  /\bcmd\b[^\n]{0,40}?\/c[^\n]{0,200}?\^/i,            // cmd /c 里用 ^ 转义把关键词打断
  /-e(?:nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{16,}/i,    // powershell -enc <base64>
]);
// 局部量【不叫 text】:依赖图扫描器按顶层符号名认引用,00-boot 提供一个叫 text 的符号 ——
// 叫它 text 会给 06i 凭空造出一条 06i -> 00 的边,而 06i 的红线正是「零 require、零外部符号、零出边」。
function stewardExemptIndirectConstruction(scanText) {
  const scanBody = String(scanText == null ? '' : scanText);
  if (!scanBody) return false;
  return STEWARD_EXEMPT_INDIRECT_PATTERNS.some(pattern => pattern.test(scanBody));
}
// 107-S1 ③(46 号文 §5 ⑦b H2 实验 E1):**删数据类只在目标是相对路径时才可代批**。
// 实测 `Remove-Item C:\Users -Recurse -Force`、`rm -rf /home/me/notes`、
// `Remove-Item $env:USERPROFILE\Documents -Recurse` 全是 `delete_data / floor:false` 且可代批 ——
// 修前那八道闸里没有一道看路径,而灾难性删除那张表只认【整段就是根】的目标(`C:\`、`~`、`/`),
// `C:\Users` 后面还跟着路径字符,所以它一条都不咬。
// 这条判据【是词法的、保守的】:06i 零 require,拿不到 path 模块、拿不到会话 cwd、拿不到工作区表,
// 所以它【证不出「删的东西在工作夹里」】—— 它只能证「这条命令没有写出任何绝对或家目录起点的目标」。
// 相对路径仍可能经 `..` 爬出工作夹,那一层由执行闸(03 guardWorkspaceExecute)兜;这里要的只是
// 「管家不准替用户批一条把绝对路径写在脸上的删除」。
// 【按叶子判,不按摊平后的整段判】:摊平文本把 input 的【所有】字符串值用空格接起来,而
// `powershell_run{command:'Remove-Item .\tmp -Recurse', cwd:'C:\…\work'}` 是常态 —— 拿整段判会把
// 每一条「线程清自己临时目录」都误判成绝对目标(B2 的主用例),那是把判据做成了「谁传 cwd 谁不许代批」。
// 所以:逐个叶子串看,只有【自己就命中删数据正则】的那个叶子里的绝对形态才算目标。
// 一个叶子都没能复现删数据命中(命中是跨叶子拼出来的 argv 形态,如 ['Remove-Item','C:\Users','-Recurse'])
// → 判不出目标在哪个词上,按最坏情况算(fail-closed)。
const STEWARD_EXEMPT_ABSOLUTE_TARGET = /(?:[a-z]:[\\/]|\\\\[a-z0-9._$-]|(?:^|[\s"'(=;|])\/(?:[a-z0-9._-]{2,}|[a-z0-9._-]*\/)|(?:^|[\s"'(=;|])~(?:[\\/]|$)|\$env:|\$home\b|%[a-z_][a-z0-9_]*%)/i;
function stewardExemptAbsoluteDeleteTarget(scanParts) {
  const parts = (Array.isArray(scanParts) ? scanParts : []).filter(part => typeof part === 'string' && part !== '');
  const deletes = part => STEWARD_EXEMPT_CONTENT_GROUPS
    .some(group => group.category === 'delete_data' && group.patterns.some(pattern => pattern.test(part)));
  let located = false;
  for (const part of parts) {
    if (!deletes(part)) continue;
    located = true;
    if (STEWARD_EXEMPT_ABSOLUTE_TARGET.test(part)) return true;
  }
  return !located;
}
const STEWARD_EXEMPT_INPUT_CHARS = 4000;   // 命令文本扫描的硬顶(超长 input 不该让判据变慢)
const STEWARD_EXEMPT_INPUT_DEPTH = 4;
// 把待决 input 里的【全部字符串值】摊平成一段文本。不按键名白名单取:命令可能藏在 command/script/args/
// argv/input 任何一个键下(不同 MCP 服务器命名不一),漏一个键就是漏一整类绕过。
// 127 波 2-quater B1 ②:第三个参数 scanNote 是可选的「截断回执」—— 传一个对象进来,凡是触发过字数 break
// 或深度截断(超过深度的非空字符串 / 对象被静默跳过),就在它上面置 truncated:true。返回的文本一个字不变;
// 不传就与修前逐字节相同。深度截断按保守口径记:超深的那一层哪怕是空对象也算「没扫全」。
// 107-S1 ③:第四个参数 scanParts 是可选的【叶子收集器】—— 传一个数组进来,摊平时经过的每一个非空字符串值
// 原样推进去(顺序即遍历顺序)。返回的文本仍然一个字不变;不传就与修前逐字节相同。给
// stewardExemptAbsoluteDeleteTarget 用:它要判「绝对目标写在哪个词上」,而摊平后的整段分不出
// `command` 与 `cwd` 的边界(头注里那条误判)。
function stewardExemptInputText(input, depth = 0, scanNote = null, scanParts = null) {
  if (input == null) return '';
  if (depth > STEWARD_EXEMPT_INPUT_DEPTH) {
    if (scanNote && (typeof input === 'string' ? input !== '' : typeof input === 'object')) scanNote.truncated = true;
    return '';
  }
  if (typeof input === 'string') {
    if (scanParts && input !== '') scanParts.push(input);
    return input;
  }
  if (typeof input === 'number' || typeof input === 'boolean') return '';
  if (Array.isArray(input)) {
    const parts = [];
    for (const item of input) {
      parts.push(stewardExemptInputText(item, depth + 1, scanNote, scanParts));
      if (parts.join(' ').length > STEWARD_EXEMPT_INPUT_CHARS) { if (scanNote) scanNote.truncated = true; break; }
    }
    return parts.join(' ');
  }
  if (typeof input === 'object') {
    const parts = [];
    for (const value of Object.values(input)) {
      parts.push(stewardExemptInputText(value, depth + 1, scanNote, scanParts));
      if (parts.join(' ').length > STEWARD_EXEMPT_INPUT_CHARS) { if (scanNote) scanNote.truncated = true; break; }
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
// 127 波 2-bis ③:永久豁免的【唯一】判据。返回 null(不豁免)或 { by, category }:
//   by       —— 'tool_name'(名字就在清单里)/ 'structured_write'(结构化入参里的写型 HTTP 方法)/
//               'command_text'(命令文本命中上面五组之一);
//   category —— STEWARD_EXEMPT_CATEGORY_LABELS 的键;工具名命中时为 null(名字本身就说明了是什么动作,
//               消息里直接点名工具)。结构化对外写归「对外发送」。
// stewardToolPermanentlyExempt 由它派生:07 nativeToolGate 只要布尔,13l steward_decide 还要说清原因 ——
// 布尔与原因各写一份判据必然漂移,所以布尔只是「原因非空」。
function stewardExemptReason(toolName, input) {
  const name = String(toolName == null ? '' : toolName);
  if (name !== '' && STEWARD_EXEMPT_TOOL_PATTERNS.test(name) && !STEWARD_EXEMPT_NAME_CARVEOUTS.includes(name)) {
    return { by: 'tool_name', category: null };
  }
  if (input == null) return null;
  if (stewardExemptStructuredWrite(input)) return { by: 'structured_write', category: 'outbound_send' };
  const composed = stewardExemptInputText(input).slice(0, STEWARD_EXEMPT_INPUT_CHARS);
  if (!composed) return null;
  const hitGroup = STEWARD_EXEMPT_CONTENT_GROUPS.find(group => group.patterns.some(pattern => pattern.test(composed)));
  return hitGroup ? { by: 'command_text', category: hitGroup.category } : null;
}
function stewardToolPermanentlyExempt(toolName, input) {
  return stewardExemptReason(toolName, input) !== null;
}
// 127 波 2-quater B1 ②(45 号文 §2-quater.1 取证 4/5):【全部】命中 + 底线标记 + 扫没扫全。
// stewardExemptReason 是首中即返 —— `rm -rf x && shutdown /s` 只报「删数据」,藏在后面的关机(底线项)看不见;
// 输入过 4000 字 / 嵌套过 4 层的部分又是静默不扫。代批(B2)要看的恰恰是这两样,所以另立一个【只读】的全量视图:
//   hits        —— [{by, category, floor}],顺序与 stewardExemptReason 的判定顺序一致(工具名 → 结构化对外写 →
//                  五组按组序),所以 hits[0] 永远等于 stewardExemptReason 的返回(单测逐样本钉住);同一类别的
//                  底线 / 非底线子组合并成一条,floor 取「任一命中的子组是底线」;工具名命中恒为底线;
//                  删数据那一条再经 stewardExemptCatastrophicDelete 判一次,删的是整个盘 / 家目录就升成底线。
//   scannedFully —— 摊平时没有触发截断,且摊平后的文本没有超过 STEWARD_EXEMPT_INPUT_CHARS(超出的那截判据看不到);
//   textLength   —— 摊平后文本的全长(截断之前);
//   indirect     —— 107-S1 ②:命令里有间接构造(拼接 / 求值 / 编码),判不出真正要跑的是什么;
//   absoluteDeleteTarget —— 107-S1 ③:删数据命中,且那个叶子里写着绝对 / 家目录起点的目标(或命中是跨叶子拼的)。
// 后两个【只给代批闸看】,不进 hits、不影响 floor。
// 判定口径与 stewardExemptReason 完全同源(同一组正则、同一个 4000 字切片、同一条结构化判据),它不改变任何
// 「算不算豁免」的结论:hits 非空 ⇔ stewardExemptReason 非 null。
function stewardExemptHits(toolName, input) {
  const name = String(toolName == null ? '' : toolName);
  const hits = [];
  if (name !== '' && STEWARD_EXEMPT_TOOL_PATTERNS.test(name) && !STEWARD_EXEMPT_NAME_CARVEOUTS.includes(name)) {
    hits.push({ by: 'tool_name', category: null, floor: true });
  }
  if (input == null) return { hits, scannedFully: true, textLength: 0 };
  if (stewardExemptStructuredWrite(input)) hits.push({ by: 'structured_write', category: 'outbound_send', floor: false });
  const scanNote = { truncated: false };
  const scanParts = [];
  const full = stewardExemptInputText(input, 0, scanNote, scanParts);
  const composed = full.slice(0, STEWARD_EXEMPT_INPUT_CHARS);
  let indirect = false;
  let absoluteDeleteTarget = false;
  if (composed) {
    const byCategory = new Map();
    for (const group of STEWARD_EXEMPT_CONTENT_GROUPS) {
      if (!group.patterns.some(pattern => pattern.test(composed))) continue;
      const seen = byCategory.get(group.category);
      if (seen) { seen.floor = seen.floor || group.floor === true; continue; }
      const hit = { by: 'command_text', category: group.category, floor: group.floor === true };
      byCategory.set(group.category, hit);
      hits.push(hit);
    }
    const deleting = byCategory.get('delete_data');
    if (deleting && !deleting.floor && stewardExemptCatastrophicDelete(composed)) deleting.floor = true;
    // 107-S1 ②③:两条【只给代批闸看】的形状判据。算在这里是因为摊平文本与叶子表只在本函数里有;
    // 它们不进 hits、不改 floor —— 什么算豁免逐字节不变(上面那几行就是全部判据)。
    indirect = stewardExemptIndirectConstruction(composed);
    absoluteDeleteTarget = !!deleting && stewardExemptAbsoluteDeleteTarget(scanParts);
  }
  return {
    hits, scannedFully: !scanNote.truncated && full.length <= STEWARD_EXEMPT_INPUT_CHARS, textLength: full.length,
    indirect, absoluteDeleteTarget,
  };
}
// 127 波 2-quater B1 ③:「按 tier 决定把不把 input 交给判据」的唯一一处。read/edit 档只看工具名(那两档本来就
// 不碰系统面;而且 file_write 的 input 是整份文件正文,拿它去扫命令正则只会误伤);其余(exec 与档位缺失)连
// 命令文本一起看。13l steward_decide 与 13k 收件箱摘录 / steward_thread_status 读同一个函数 —— 修前这行判断
// 只在 13l 里写过一次,摘录那边再抄一份,两边迟早各判各的。
function stewardExemptScanInput(tier, input) {
  const t = String(tier == null ? '' : tier);
  return (t === 'read' || t === 'edit') ? null : input;
}
// 127 波 2-quater B1 ③:给管家看的命令摘录。管道固定为「脱敏 → 尖括号中和 → 以命中处为中心截 300 字」,
// 本函数接的是【已经脱敏】的文本(脱敏表 REDACT_PATTERNS 住在 04,06i 零外部引用,不能在这里调)——
// 调用方(13k stewardExemptPendingSummary)负责先脱敏,这里只做后两步。
// 中心点:在中和后的文本里按 hits 的类别顺序重扫一遍,取第一条命中的位置(脱敏会改变长度,不能沿用原文的下标);
// 重扫不到(比如命中只是工具名 / 结构化写)就从头截。两端被截掉时各补一个「…」,补上之后全长仍 ≤ maxChars。
const STEWARD_EXEMPT_EXCERPT_CHARS = 300;
function stewardExemptExcerpt(redactedText, hits, maxChars = STEWARD_EXEMPT_EXCERPT_CHARS) {
  const body = stewardSanitizeBlock(redactedText);
  const limit = Math.max(8, Math.floor(Number(maxChars) || STEWARD_EXEMPT_EXCERPT_CHARS));
  if (body.length <= limit) return body;
  let center = -1;
  for (const hit of (Array.isArray(hits) ? hits : [])) {
    if (!hit || hit.by !== 'command_text') continue;
    for (const group of STEWARD_EXEMPT_CONTENT_GROUPS) {
      if (group.category !== hit.category) continue;
      for (const pattern of group.patterns) {
        const found = pattern.exec(body);
        if (found && (center < 0 || found.index < center)) center = found.index;
      }
    }
    if (center >= 0) break;
  }
  if (center < 0) center = 0;
  // 先按「两头都截」留出两个「…」的位置;窗口贴到开头或结尾时只截一头,正文多拿回一个字。
  const middle = limit - 2;
  const start = Math.max(0, center - Math.floor(middle / 2));
  if (start === 0) return body.slice(0, limit - 1) + '…';
  if (start + middle >= body.length) return '…' + body.slice(body.length - (limit - 1));
  return '…' + body.slice(start, start + middle) + '…';
}

// ─────────────────────────────────────────────────────────────────────────────
// 127 波 2-quater B2(45 号文 §2-quater.2 B2 / §2-quater.3 三件拍板):管家代批。
// 用户原话「停下来问的话,管家如果判断风险不高或者合理,应该要能带我批准」。「智能自动」档里线程停下来问的,
// 只剩命令正文命中永久豁免的那一类(07 nativeToolGate 只对命中才问),本节是「这一条管家能不能替用户批」的
// 【纯判据】:十道闸按固定顺序判,第一道不过就报它的名字(blockedBy),13l steward_decide 据此决定是照旧回
// propose_required,还是进 decideIntervention。事实由调用方喂(活回合档位、线程看管、污染、窗口计数都在
// 06i 看不见的层),本节只负责把它们按顺序合成一个结论 —— 与本文件其余判据同一条纪律:零 require、零外部符号。
// ─────────────────────────────────────────────────────────────────────────────
// 闸 5:命令全文上限。代批只给【管家真看得完】的命令。
// 107-S1 ①(46 号文 §5 ⑦b H2 实验 E3):修前这里是 1000,而管家拿到的摘录恒为 STEWARD_EXEMPT_EXCERPT_CHARS
// = 300 字(以首个命中为中心截)—— 927 字的命令实测 `scannedFully:true`、`delegable:true`,尾部 627 字
// 【没有任何可达路径】(13i 归一化 needs_you 恒不带 iv.input;13k 的 thread_read 只读已落盘的 toolCalls,
// 停在待决上的这一条还没落盘)。于是常量直接绑到摘录长度上:两个数字只许有一份,将来改摘录长度闸 5 跟着走,
// 不会再漂移出「看得见 300、批得了 1000」这个缺口。
// 【为什么还不够,于是闸 5 多一个合取】:textLength 量的是【脱敏前】的摊平全长,而摘录是
// `redact() → 中和 → 截 300` 的产物 —— redact 把命中的值换成 `«redacted»`(10 字)并留下标签,
// 短值上会把文本【撑长】(`PGPASSWORD=pgsecret` 19 字 → 21 字)。于是 300 字以内的原文仍可能在摘录里被截。
// 调用方(13l)把它实际交给管家的那段摘录的长度一并喂进来(excerptChars),等于摘录长度上限即视为「截过了」——
// 恰好 300 字的摘录可能一个字没丢,这一格【宁可误判成要人按】,与本文件其余判据同一条纪律。
// 报的仍是 scan_limit:两者说的是同一件事(管家没看全),blockedBy 多一个名字只会让 13f 的工具描述与
// 用户手册多一条用户分不清的分支。
const STEWARD_EXEMPT_DELEGATION_TEXT_MAX = STEWARD_EXEMPT_EXCERPT_CHARS;
// 闸 9:riskNote(管家写给用户看的代批理由)的硬顶。中和后只进决策日志与回执,不进审计日志。
const STEWARD_EXEMPT_RISK_NOTE_CHARS = 200;
// 闸 10:每小时代批上限。计数窗口住在 13j(内存,重启归零 —— 与 13m 自理动作账同一立场),数字只住这里。
const STEWARD_EXEMPT_DELEGATIONS_PER_HOUR = 6;
const STEWARD_EXEMPT_DELEGATION_WINDOW_MS = 60 * 60 * 1000;
// 闸 8 只对这两类生效(拍板 3):线程读过外部内容时,「对外发送」「推送远端」不代批;删文件、装卸软件仍可。
const STEWARD_EXEMPT_TAINT_CATEGORIES = Object.freeze(['outbound_send', 'push_remote']);
// 「读过外部内容」的工具名(拍板 3 的机器判据)。另有两条形状规则写在 stewardTaintToolName 里:
// `browser_` 前缀整族、名字里带 `__` 的一律算(原生引擎的桥接 MCP 恒为 `<serverId>__<工具名>`,CLI 恒为
// `mcp__<server>__<工具名>` —— 外部服务器返回什么内容工作台管不着,按最坏情况算)。
const STEWARD_TAINT_TOOL_NAMES = Object.freeze([
  'web_fetch', 'web_search', 'http_request', 'http_download', 'WebFetch', 'WebSearch', 'audio_transcribe',
]);
// 十道闸的机器名,顺序即判定顺序(信封 details.blockedBy 取其一;单测按这张表逐条造反例)。
// 107-S1 ②③ 新增的两道【排在 scan_limit 之后】:它们判的是摊平后的命令文本,而「扫没扫全」正是
// 「这段文本能不能代表整条命令」的前提 —— 反过来排的话,尾部藏着拼接的那种命令会被报成
// indirect_command(听起来像是判过了),或者更糟:没扫到的那半里的拼接根本没被看过。
const STEWARD_EXEMPT_DELEGATION_GATES = Object.freeze([
  'switch_off', 'mode', 'not_watched', 'floor', 'scan_limit', 'indirect_command', 'absolute_target',
  'tainted', 'risk_note', 'hourly_cap',
]);
function stewardTaintToolName(taintToolName) {
  const name = String(taintToolName == null ? '' : taintToolName);
  if (!name) return false;
  return STEWARD_TAINT_TOOL_NAMES.includes(name) || name.startsWith('browser_') || name.includes('__');
}
// 一次【工具调用】算不算「读外部内容」,返回算污染的那个工具名(不算就是空串)。比只看名字多认一层代理:
// 自适应工具装载下模型可以经 `tool_invoke_read/edit/exec {name, arguments}` 调任意目录里的工具
// (12 invokeAdaptiveMcpTool),事件上的名字是 tool_invoke_read,真正跑的是 input.name —— 只看名字,
// 一次代理调的 web_fetch 就从污染判据下面漏过去了。代理的目标读不出来(缺 name / 不是字符串)一律算污染。
// 10 的粘性污染位写入点用它:tool_use 时按它记下「这条调用会带外部内容回来」,同一条调用的 tool_result
// 到了才置位(不在 tool_use 就置 —— 原生回合先发 tool_use 再过权限闸,一条停在待决上的写型 http_request
// 否则会先把自己写进粘性位,管家判它时恒为污染)。回合段表上没有 input,只能按名字判;代理调用那一半由
// 粘性位兜住(代理调用的结果一回来就在同一个会话对象上置位,下一条待决出现之前已经生效)。
function stewardTaintToolCall(taintToolName, taintToolInput) {
  const name = String(taintToolName == null ? '' : taintToolName);
  if (stewardTaintToolName(name)) return name;
  if (!name.startsWith('tool_invoke_')) return '';
  const target = (taintToolInput && typeof taintToolInput === 'object' && typeof taintToolInput.name === 'string') ? taintToolInput.name : '';
  if (!target) return name;
  return stewardTaintToolName(target) ? target : '';
}
// 闸 8 的回合内那一半(a)＋粘性那一半(b)。入参是活回合 liveSegments.snapshot() 的段表、这条待决的 id
// (= 原生回合 permission_request 的 requestId)、会话级粘性污染位(没有就传 null)。
// 判不出一律算污染(c):段表不是数组、找不到这条待决对应的权限段 —— 看不见它之前发生过什么,就按最坏情况算。
// 只看【这条权限段之前】的段:它之后才发生的读网页不可能影响它要执行的命令。
// 例外只有一条:这条权限【自己】的那个工具段(原生回合先发 tool_use 再过闸,09 的 tool_use 早于
// requestNativePermission)—— 否则一条待决的写型 http_request 会被它自己的名字判成「读过外部内容」。
// 认「自己」的口径取最保守的:权限段之前【最近的】一个同名、且仍是 running(还没出结果)的工具段;
// 已经出过结果的同名调用是真读过东西的那一次,照算污染。粘性位那一半(taintSticky)不需要这条例外:
// 10 只在工具结果回来时置位,停在待决上的那一条调用还没有结果,写不进去。
// 返回 { tainted, taintBy }:taintBy ∈ 'no_live_segments' / 'no_permission_segment' / 'turn:<工具名>' /
// 'turn:subagent' / 'turn:workflow' / 'sticky:<工具名>' / null。工具名经中和并截 80 字(它会进信封与决策日志)。
function stewardTurnTaint(taintSegments, taintRequestId, taintSticky) {
  if (!Array.isArray(taintSegments)) return { tainted: true, taintBy: 'no_live_segments' };
  const wanted = String(taintRequestId == null ? '' : taintRequestId);
  const at = wanted ? taintSegments.findIndex(seg => seg && seg.type === 'permission' && String(seg.requestId || '') === wanted) : -1;
  if (at < 0) return { tainted: true, taintBy: 'no_permission_segment' };
  const ownName = String(taintSegments[at].toolName || '');
  let own = -1;
  for (let j = at - 1; j >= 0; j--) {
    const seg = taintSegments[j];
    if (seg && seg.type === 'tool' && seg.status === 'running' && String(seg.name || '') === ownName) { own = j; break; }
  }
  for (let i = 0; i < at; i++) {
    const seg = taintSegments[i];
    if (i === own || !seg || typeof seg !== 'object') continue;
    if (seg.type === 'subagent') return { tainted: true, taintBy: 'turn:subagent' };
    if (seg.type === 'workflow') return { tainted: true, taintBy: 'turn:workflow' };
    if (seg.type === 'tool' && stewardTaintToolName(seg.name)) {
      return { tainted: true, taintBy: 'turn:' + stewardSanitizeText(seg.name).slice(0, 80) };
    }
  }
  if (taintSticky && typeof taintSticky === 'object') {
    return { tainted: true, taintBy: 'sticky:' + (stewardSanitizeText(taintSticky.by).slice(0, 80) || 'unknown') };
  }
  return { tainted: false, taintBy: null };
}
// 闸 9 的清洗:折行、中和尖括号、首尾去空白、截 200 字。结果为空串即「没写理由」。
function stewardExemptRiskNote(riskNoteRaw) {
  if (typeof riskNoteRaw !== 'string') return '';
  return stewardSanitizeText(riskNoteRaw).trim().slice(0, STEWARD_EXEMPT_RISK_NOTE_CHARS).trim();
}
// 十道闸的合成。delegationFacts:
//   enabled      —— config.stewardExemptDelegationV1 === true(闸 1);
//   liveMode     —— 【活回合】此刻的实效档位(闸 2;没有活回合 / 读不到就是空串)。**不是会话头的档位**:
//                   会话头与回合实效档可以不一致(定时任务与请求级 permissionMode 走请求级,45 号文 §2-quater.1
//                   取证 2),判「能不能代批」必须看线程此刻真正按哪一档在跑。只认 'auto'(智能自动);
//                   bypass 从来不停下来问,也就没有东西可代批。
//   watched / origin / explicitUnwatch —— 闸 3:管家看管(stewardWatchedThread)或定时任务开的线程
//                   (threadOriginOf === 'schedule');但用户显式按过「别盯了」(stewardWatch === false)
//                   一律不过 —— 那是用户说「这条我自己看着」,出身是定时任务也一样。
//   scan         —— stewardExemptHits 的完整返回(闸 4 看【全部】命中有没有底线,闸 5 看扫没扫全与全文长度);
//   taint        —— stewardTurnTaint 的返回(或调用方就地给的「判不出」);只在命中含两类外联时才问(闸 8);
//   riskNote     —— stewardExemptRiskNote 之后的串(闸 9);
//   recentCount  —— 滚动一小时窗口里已经代批过的次数(闸 10)。
// 返回 { delegable, blockedBy, categories, taintBy }:categories 是去重保序的类别键;taintBy 只在闸 8 拦下时非空。
function stewardExemptDelegationVerdict(delegationFacts) {
  const f = (delegationFacts && typeof delegationFacts === 'object') ? delegationFacts : {};
  const scanned = (f.scan && typeof f.scan === 'object') ? f.scan : { hits: [], scannedFully: false, textLength: 0 };
  const hitList = Array.isArray(scanned.hits) ? scanned.hits : [];
  const categories = [...new Set(hitList.map(hit => hit && hit.category).filter(Boolean))];
  const blocked = gate => ({ delegable: false, blockedBy: gate, categories, taintBy: null });
  if (f.enabled !== true) return blocked('switch_off');
  if (String(f.liveMode == null ? '' : f.liveMode) !== 'auto') return blocked('mode');
  if (f.explicitUnwatch === true || !(f.watched === true || String(f.origin || '') === 'schedule')) return blocked('not_watched');
  if (!hitList.length || hitList.some(hit => !hit || hit.floor !== false)) return blocked('floor');
  // 闸 5(107-S1 ①):扫全了、全文不超过摘录长度、且真正交给管家的那段摘录没有被截。
  // excerptChars 缺席(老调用方 / 纯函数单测)时 Number(undefined) = NaN,NaN >= 300 为 false —— 行为与修前一致。
  if (scanned.scannedFully !== true || !(Number(scanned.textLength) <= STEWARD_EXEMPT_DELEGATION_TEXT_MAX)
    || Number(f.excerptChars) >= STEWARD_EXEMPT_EXCERPT_CHARS) return blocked('scan_limit');
  // 闸 6/7(107-S1 ②③,排在 scan_limit 之后):间接构造一律不代批;删数据类的目标必须是相对路径。
  if (scanned.indirect === true) return blocked('indirect_command');
  if (scanned.absoluteDeleteTarget === true) return blocked('absolute_target');
  if (categories.some(key => STEWARD_EXEMPT_TAINT_CATEGORIES.includes(key))) {
    const taint = (f.taint && typeof f.taint === 'object') ? f.taint : { tainted: true, taintBy: 'unknown' };
    if (taint.tainted !== false) return { ...blocked('tainted'), taintBy: String(taint.taintBy || 'unknown') };
  }
  if (!stewardHasText(f.riskNote)) return blocked('risk_note');
  if (!(Number(f.recentCount) < STEWARD_EXEMPT_DELEGATIONS_PER_HOUR)) return blocked('hourly_cap');
  return { delegable: true, blockedBy: null, categories, taintBy: null };
}

// 委托书(§3.5「委派」/§11.1 第 9 项)。中和与 stewardSanitizeText 同源,区别只有一条:保留换行
// (委托书补充是多行结构化文本,折行会毁掉可读性)。尖括号 -> 全角尖括号,防伪造围栏标记(128f 起不再是方括号,理由见上)。
function stewardSanitizeBlock(value) {
  if (value == null) return '';
  return String(value).replace(/\r\n?/g, '\n').replace(/</g, STEWARD_NEUTRAL_LT).replace(/>/g, STEWARD_NEUTRAL_GT);
}

const STEWARD_BRIEF_LIMITS = Object.freeze({ supplementChars: 1200, sectionItems: 12, itemChars: 300 });
const STEWARD_BRIEF_OPEN = '<steward-brief added-by="steward">';
const STEWARD_BRIEF_CLOSE = '</steward-brief>';
const STEWARD_BRIEF_TRUNCATED = '\n[管家补充已截断:超过 ' + STEWARD_BRIEF_LIMITS.supplementChars + ' 字]';
// ── 129h playbook 正文(31 号文 §2.7 放①)──────────────────────────────────────────────────
// 它【不能】走「管家补充」那条路:supplement 的预算是 1200 字,而 promptTemplate 上限 20000 字
// (06 的 normalizePlaybook 就钳在那里)—— 塞进去会被静默截断,线程拿到半条指令还照办,
// 那是最坏的一种错。所以单独成块、单独预算,而且【不裁剪】:与前端「开始」按钮把组装结果原样
// 发出去逐字同一口径(session-experience.js 的 assemblePlaybookPrompt + sendPrompt)。
// 围栏也另起一对:这段正文是**用户自己写的(或内置的)模板**,不是管家的补充 ——
// 用 added-by="steward" 那个壳去套它,是把作者说成管家,线程会按不同的信任度读它。
const STEWARD_PLAYBOOK_OPEN = '<playbook id="{id}" title="{title}">';
const STEWARD_PLAYBOOK_CLOSE = '</playbook>';

// 占位替换。**与前端 assemblePlaybookPrompt 逐字同义**:只替换 playbook 自己声明过的 key,
// 模板里冒出来的野 {foo} 原样留着(它不是参数,是正文)。两处各有一份实现(服务端产物是单文件
// 拼接,拉不进浏览器模块),由 unit/steward-playbook-run.test.js 用同一组样例把两边钉在一起 ——
// 与 06i 抄 mission-state.js 那份五态判据同一个模具。
function stewardAssemblePlaybookPrompt(pb, values) {
  let out = String((pb && pb.promptTemplate) || '');
  const v = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};
  for (const inp of ((pb && Array.isArray(pb.inputs)) ? pb.inputs : [])) {
    const key = String((inp && inp.key) || '');
    if (!key) continue;
    const val = v[key] == null ? '' : String(v[key]);
    out = out.split('{' + key + '}').join(val);
  }
  return out;
}

// 哪些声明过的参数【没给值】。返回的是参数本身(key/label/type),不是一句话 —— 管家要拿它去问用户。
// 为什么比前端严:前端那个弹窗前面坐着用户,他把某一格留空是**他的选择**;管家填空是猜。
// 猜出来的 {folder} 是空串,模板照跑,线程在错的地方动手 —— 宁可退回来问一句。
function stewardPlaybookMissingInputs(pb, values) {
  const v = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};
  return ((pb && Array.isArray(pb.inputs)) ? pb.inputs : [])
    .filter(inp => inp && inp.key && !String(v[inp.key] == null ? '' : v[inp.key]).trim())
    .map(inp => ({ key: String(inp.key), label: String(inp.label || inp.key), type: String(inp.type || 'text') }));
}

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
  // 129h:playbook 正文挂在【最后】,自成一块、不裁剪(理由见 STEWARD_PLAYBOOK_OPEN 的头注)。
  // 位置在管家补充之后:先是用户原话,再是管家为这一单补的上下文,最后才是「照这个流程办」——
  // 顺序即优先级,与 §3.5 那条铁律(原话永远在最前)一致。
  // playbookText 由调用方(13k)组装好再传进来:装配要读 playbook 库与可用性,那是 06 的事,
  // 06i 只做纯拼接,不去碰 I/O。
  const playbookText = b.playbookText == null ? '' : String(b.playbookText);
  const withPlaybook = playbookText
    ? composedText + '\n\n'
      + STEWARD_PLAYBOOK_OPEN.replace('{id}', stewardSanitizeText(b.playbookId || '')).replace('{title}', stewardSanitizeText(b.playbookTitle || ''))
      + '\n' + playbookText + '\n' + STEWARD_PLAYBOOK_CLOSE
    : composedText;
  // 132a(53 号文 §1.2):裁剪后的【分字段】版本一并回出,13k 存进 session.brief.fields —— 界面按字段画列表,
  // 不必去拆 supplement 那段人话(124-P2「零二次解析」的纪律照旧;结构从源头来)。与 lines 用同一把裁剪尺。
  const fields = {
    goal: clipItem(b.goal),
    acceptance: (Array.isArray(b.acceptance) ? b.acceptance : []).map(clipItem).filter(Boolean).slice(0, STEWARD_BRIEF_LIMITS.sectionItems),
    context: (Array.isArray(b.context) ? b.context : []).map(clipItem).filter(Boolean).slice(0, STEWARD_BRIEF_LIMITS.sectionItems),
    preferences: (Array.isArray(b.preferences) ? b.preferences : []).map(clipItem).filter(Boolean).slice(0, STEWARD_BRIEF_LIMITS.sectionItems),
    constraints: (Array.isArray(b.constraints) ? b.constraints : []).map(clipItem).filter(Boolean).slice(0, STEWARD_BRIEF_LIMITS.sectionItems),
  };
  return { text: withPlaybook, userText, supplement, truncated, memoryIds, playbookText, fields };
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
    // 117r-D5:kind 自此【只是证据】,不再参与判定 —— 「这条线程是什么」(kind)和「它在干什么」
    // (state)是两回事,把前者塞进五态正是 ①②③ 三条毛病的同一个根因。默认值留着不动:它对
    // state 已经完全无害(下面的守卫不读它),动它反而会改掉 sources 里那条已被消费的证据形状。
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
    // 117p-S2(30 号文 §8.3):无账本线程的两个新证据键。ledgerless 的唯一判据是卡片
    // status === 'none'(13d missionCardStatus(null) 的返回值)/ 会话头没有 mission 容器 ——
    // 不许用 milestonesTotal === 0 之类的近似,那会把还没定里程碑的 2.0 任务单误判成无账本线程。
    ledgerless: input.ledgerless === true,
    lastTurnFailed: input.lastTurnFailed === true,
    // 117r-D5(用户第八轮走查③的三条子症状):守卫从「是不是速查」换成「调用方手上有没有这条
    // 线程的事实」。默认【有事实】—— 只有明说 factsUnknown:true 的调用面才短路(全仓唯一一处:
    // 13d buildMissionAggregateRows 那条「没卡片、也不是 mission 会话」的 else 支,它刻意不读
    // 会话头以省 I/O,注释就写在那里)。于是 'quick_ask' 退回它唯一诚实的语义:【事实未知】,
    // 而不是「这是一条速查线程」。速查这个身份仍然在,它活在 kind 上(看板行上的徽标读它)。
    factsUnknown: input.factsUnknown === true,
  };
  let state;
  if (src.factsUnknown) state = 'quick_ask';
  else if (src.pendingTotal > 0) state = 'needs_you';
  else if (src.resultStatus === 'complete') state = 'done';
  else if (src.activeTurn || src.autoMode === 'until-done' || src.liveRuns > 0) state = 'running';
  else if (src.runCount === 0 && src.turnSeq === 0 && src.milestonesDone === 0 && src.resultStatus !== 'stopped') state = 'dispatching';
  // 117p-S2:无账本线程(没有里程碑、没有结果章、没有班组)跑过回合且此刻没在跑 -> 已收工;
  // 末回合 ok:false 或 aborted -> 已停工;账缺席(lastTurn 为 null)按成功算,与 13i 的
  // @sessionTurn 解析器「账缺席一律 done」同口径。有账本的 2.0 任务单语义一个字不变。
  else if (src.ledgerless && src.turnSeq > 0) state = src.lastTurnFailed ? 'stopped' : 'done';
  else state = 'stopped';
  return { state, label: stewardStateLabel(state), sources: src };
}
// 投影卡片(13e overlayMissionCard 的输出,与 /api/missions 下发的 card 同形)适配器 —— 逐条对应
// mission-state.js 的 fromCard。card 为 null(非 mission 会话)时由调用方走 head 派生分支。
function stewardThreadStateFromCard(card) {
  const m = (card && card.mission) || {};
  const lr = (card && card.lastRun) || null;
  return deriveStewardThreadState({
    // 121-K3:身份取卡片的 `quick` 格,不再取 `kind`。两条路径必须给同一条线程同一个答案 ——
    // 会话头那条路(13g thread_status / 13o 总览的 else 支)写的就是
    // `stewardQuickThread(head) ? 'quick_ask' : 'mission'`,而卡片这条路修前抄的是 sessionKind 的
    // 【档位】。K3 把普通会话也放进索引之后,档位与身份分了家(见 13d buildMissionCard 的 quick 注释):
    // 再抄 kind,同一条普通会话走卡片支说自己是速查、走会话头支说自己不是,两支当场打架。
    kind: (card && card.quick === true) ? 'quick_ask' : 'mission',
    autoMode: m.autoMode,
    budgetExhausted: m.budgetExhausted === true,
    resultStatus: (m.result && m.result.status) || '',
    pending: card && card.pending,
    activeTurn: card && card.activeTurn === true,
    liveRuns: lr && lr.live && !lr.paused ? 1 : 0,
    runCount: card && card.runCount,
    // 117p-S2:卡片自 13e schema 4 起带 turnSeq / lastTurn(13d buildMissionCard 的会话头投影)。
    // 旧索引里的存量卡片没有这两个键 -> turnSeq 归一成 0、lastTurnFailed false,行为退回修前,
    // 升号强制整份重建正是为了让它们刷新(见 13e PRETENDER_INDEX_SCHEMA 注释)。
    turnSeq: card && card.turnSeq,
    ledgerless: !!(card && card.status === 'none'),
    lastTurnFailed: !!(card && card.lastTurn && (card.lastTurn.ok === false || card.lastTurn.aborted === true)),
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
// 这是刻意的,但 117r-D5 之后它适用的范围窄了一圈,注释跟着代码改:
//   · 仍然适用:'quick_ask' 现在【只】由「调用方明说没有这条线程的事实」产出(deriveStewardThreadState
//     的 factsUnknown 守卫;全仓唯一产出点是 13d 那条不读会话头的 else 支 = 用户自己在 2.0 里聊的
//     普通会话)。事实未知的线程不构成事项的推进,落 stopped 就是诚实的说法。
//   · 不再适用:管家 steward_quick_ask 开的速查线程(D1 之后它有卡片)走的是完整五态 ——
//     在跑就是 running、有待决就是 needs_you、跑完就是 done。它【不会】再以 'quick_ask' 进到这里,
//     于是「一条在跑的速查线程」的事项聚合态如实是 running,不再被这条注释里的旧假设按成 stopped。
function aggregateMissionState(threadStates) {
  const states = (Array.isArray(threadStates) ? threadStates : []).map(s => String(s == null ? '' : s));
  if (!states.length) return 'dispatching';
  if (states.includes('needs_you')) return 'needs_you';
  if (states.every(s => s === 'done')) return 'done';
  if (states.includes('running')) return 'running';
  if (states.includes('dispatching')) return 'dispatching';
  return 'stopped';
}

// ── 117s-A D1(27 号文 §11.13 ③;用户第九轮走查「在运行中的线程,最好能自动排到最前面」)──────
// 行序的【状态秩】。这【不是】第二个状态机:入参已经是 deriveStewardThreadState /
// aggregateMissionState 算出来的那一个字符串,本函数只回答「同一屏上谁该排在谁前面」。
// 秩:needs_you(等你按) > running(在跑) > dispatching(刚交办、还没动静) > 其余(done/stopped)。
// 理由是「哪一条最需要你现在看它」,不是「哪一条更新」——修前 13d 只按 updatedAt 排,一条刚收工的
// 线程只要 updatedAt 新一秒就压在一条在跑的线程上面(用户截图 1 正是如此)。
// 'quick_ask' 落在「其余」档:117r-D5 之后它只由「调用方明说没有这条线程的事实」产出(factsUnknown),
// 事实未知的线程不该抢在等你/在跑的前面。
const STEWARD_THREAD_STATE_ORDER = Object.freeze(['needs_you', 'running', 'dispatching']);
function stewardThreadStateRank(state) {
  const i = STEWARD_THREAD_STATE_ORDER.indexOf(String(state == null ? '' : state));
  return i < 0 ? STEWARD_THREAD_STATE_ORDER.length : i;
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
// ②b 133d(用户 2026-09-21:「管家新开的线程,默认只能走如意的 OpenAI 兼容端点,走 Claude CLI 和 Kimi CLI 似乎会有问题;
// 这两个第三方 CLI 只作为能在工作台使用的兼容存在」):那一档没配(或端点已删)时,管家线程【不】回落到 createSession 的
// 全局缺省 —— 全局可能是 Agent CLI —— 而是按固定顺序挑一个 OpenAI 兼容端点:
//   ① 管家自己在用的端点(stewardProviderId)> ② 全局主端点(activeProvider,是 OpenAI 端点时)>
//   ③ 用户上次用的(lastUsedEngineRoute,是 OpenAI 路由且端点还在)> ④ 端点清单里第一个能对话的。
// 「能对话」= 不是 claude-cli、不是 toolbox- 自动接入的、且不是只做语音的(models 全带 asr 标记)。一个都没有 → null,
// 调用方留全局缺省并记审计(不拒绝开线程:没端点不该把事儿卡死,但要留痕)。纯函数、不构造 engineRoute(同上一函数的理由)。
function stewardChatCapableProvider(p) {
  if (!p || typeof p !== 'object') return false;
  const id = String(p.id || '');
  if (!id || id === 'claude-cli' || id.startsWith('toolbox-')) return false;
  const models = Array.isArray(p.models) ? p.models : [];
  const speechOnly = models.length > 0 && models.every(m => m && typeof m === 'object' && Array.isArray(m.caps) && (m.caps.includes('asr') || m.caps.includes('asr-stream')));
  return !speechOnly;
}
function stewardOpenAiFallback(config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  const byId = id => providers.find(p => p && p.id === id && stewardChatCapableProvider(p)) || null;
  const pick = (p, model, source) => ({ providerId: String(p.id), model: String(model || '').trim() || String(p.model || ''), source });
  // 局部名带 fb 前缀:103b 的依赖扫描按标识符认模块间引用,裸的 main/last/first 会被当成读了 14-main 的顶层符号。
  const fbOwn = byId(String(cfg.stewardProviderId || '').trim());
  if (fbOwn) return pick(fbOwn, cfg.stewardModel, 'steward');
  const fbGlobal = byId(String(cfg.activeProvider || '').trim());
  if (fbGlobal) return pick(fbGlobal, '', 'global');
  const fbRoute = (cfg.lastUsedEngineRoute && typeof cfg.lastUsedEngineRoute === 'object') ? cfg.lastUsedEngineRoute : null;
  const fbLast = fbRoute && fbRoute.engine === 'openai' ? byId(String(fbRoute.providerId || '').trim()) : null;
  if (fbLast) return pick(fbLast, fbRoute.model, 'last');
  const fbFirst = providers.find(stewardChatCapableProvider) || null;
  if (fbFirst) return pick(fbFirst, '', 'first');
  return null;
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
// 走查 #12:权限待决的一句人话(管家的「等你」行、抽屉、总览都读 stewardPendingOneLine 这一个来源)。
// 常用工具说清要对哪个文件做什么;认不出的工具才退回工具名 —— 总比「edit 级」这种档位黑话好懂。
const STEWARD_PERMISSION_VERBS = Object.freeze({
  file_write: '写入文件', file_edit: '修改文件', file_delete: '删除文件', file_move: '移动文件', file_copy: '复制文件',
  powershell_run: '运行一条命令', script_run: '运行一段脚本', http_download: '下载文件',
});
function stewardPermissionPlain(iv) {
  const tool = String((iv && iv.toolName) || '');
  const input = iv && iv.input && typeof iv.input === 'object' && !Array.isArray(iv.input) ? iv.input : {};
  const target = input.path || input.from || input.dest || '';
  const name = target ? stewardSanitizeText(String(target).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '') : '';   // 不借 00-boot 的 path(会多一条循环边)
  const verb = STEWARD_PERMISSION_VERBS[tool];
  if (verb) return name ? `${verb}「${name}」` : verb;
  return name ? `用「${stewardSanitizeText(tool || '?')}」处理「${name}」` : `使用工具「${stewardSanitizeText(tool || '?')}」`;
}
function stewardPendingOneLine(iv) {
  const type = String((iv && iv.type) || '');
  if (type === 'permission') return '等你放行:' + stewardPermissionPlain(iv);   // 走查 #12:不再印「工具 file_write(edit 级)」
  if (type === 'question') {
    const first = (Array.isArray(iv && iv.questions) ? iv.questions : [])[0];
    return stewardClipSay((first && (first.question || first.title)) || '等待你回答');
  }
  if (type === 'plan') return stewardClipSay(iv.planSummary || '计划等待批准');
  if (type === 'pool') return stewardClipSay(iv.task || '任务池提案等待批准');
  if (type === 'replan') return stewardClipSay(iv.summary || '重规划提案等待批准');
  return stewardClipSay(type || '未知待决');
}

// ── 117y-S1(27 号文 §11.18.2):管家【正文】的天花板裁剪。────────────────────────────────
// **与上面的 stewardClipSay 不是一回事,两者永远不要合并**:
//   · stewardClipSay 喂的是【总览行与待决一行话】—— 那是列表里的一行摘要,200 字加省略号正是
//     对的做法,一行摘要本来就不该说完整;
//   · 这个函数喂的是管家在对话里说的【那段话本身】。它不是「让它少说」的手段(少说是提示词的事,
//     见 06b steward.rules 第 7 条与输出契约里的 ≤600 字目标),只是一道防病态载荷的天花板 ——
//     尤其 13o 那条 JSON 解析失败的兜底会把【整份原始模型输出】灌进来。
// 判据:天花板之前的【最后一个句末标点】处切(中文句号与全角叹号问号 + 三个半角同形字,共六个);
// 一个都找不到才退回裸切。切了就明说:末尾缀一句诚实的话,不许假装这就是它说完了(§11.18.2)。
// 表里第二、三个是【全角】叹号 U+FF01 与问号 U+FF1F,不是半角的 U+0021/U+003F(本刀写这行时
// 被静默归一成半角一次)。改这张表之后必须逐字节核码位:归一成半角的话表就只剩半角三个,
// 中文回复触顶时会全部退回裸切 —— 而那是肉眼看不出来的。
const STEWARD_SAY_SENTENCE_ENDS = Object.freeze(['。', '！', '？', '.', '!', '?']);
const STEWARD_SAY_TRIMMED_NOTE = '\n(话太长,先说到这里;后面还有,是工作台截断的,不是我说完了。)';
function stewardTrimSayAtSentence(value, ceiling) {
  const raw = String(value == null ? '' : value);
  const limit = Math.floor(Number(ceiling));
  if (!Number.isFinite(limit) || limit <= 0 || raw.length <= limit) return raw;
  const head = raw.slice(0, limit);
  let cut = -1;
  for (const mark of STEWARD_SAY_SENTENCE_ENDS) {
    const at = head.lastIndexOf(mark);
    if (at > cut) cut = at;
  }
  return (cut >= 0 ? head.slice(0, cut + 1) : head) + STEWARD_SAY_TRIMMED_NOTE;
}

// ── 管家记忆层(§4)。kind 白名单与容量硬上限;词项 Jaccard 用于同义去重(113a 向量化落地前的口径)。
const STEWARD_MEMORY_KINDS = Object.freeze(['profile', 'preference', 'habit', 'focus', 'policy']);

const STEWARD_MEMORY_LIMITS = Object.freeze({ textChars: 300, maxEntries: 200, dedupeJaccard: 0.8, searchLimit: 50 });
// 129b:三张只读清单(技能 / 端点与模型 / playbook)的行数与描述预算。一个数管三处 —— 它们是
// 同一类东西(「有哪些可选」的目录),没有理由各有各的上限。40 行按今天的真实规模定:技能四源
// 合起来几十条、端点个位数、playbook 十几条,够列全;真超了模型可以带 q 再问一次。
// 落在 06i 而不是 13m:13m 排在 13l【之后】,13l 的实现引用它会造前向边(§11.3 不得新增)。
const STEWARD_CATALOG_ROWS = 40;
const STEWARD_CATALOG_DESC_CHARS = 120;

// ── 129d「眼睛」四件的纯判据(31 号文 §2.2)──────────────────────────────────────────────
// 单次取回的字符上限。与深读的单次上限同量级 —— 「管家一次能吞多少」不该因为来源是网页
// 还是线程而有两个数。总量另受 stewardReadBudgetChars 管(那是一趟到访的总预算)。
const STEWARD_EYES_CHARS = 12000;
// ── 129f「嘴」(31 号文 §2.4「叫得到你」):管家主动叫人 ──────────────────────────────────────
// 只在这三类事上叫(原文口径):等你拿主意 / 出错了 / 收工了。**不许扩到别的类** —— 能叫人的
// 理由一多,通知就变成噪音,用户第一件事就是把它整个关掉,那时真要紧的那条也叫不到他。
const STEWARD_NOTIFY_KINDS = Object.freeze(['needs_you', 'failed', 'done']);
const STEWARD_NOTIFY_TEXT_CHARS = 120;          // 一条通知的正文上限(系统通知本来也印不下更多)
const STEWARD_NOTIFY_WINDOW_MS = 60 * 60 * 1000; // 熔断窗口:滚动一小时
// ── 129g 代答的依据(31 号文 §2.5「答案在记忆或委托书里有依据时才代答」)────────────────────
// 为什么有这一族常量:代答是管家唯一一个【替用户说话】的动作 —— 递话时那句话是用户的原话,
// 代答时那句话是管家自己编的,而线程分不出来(两者走同一条 decideIntervention)。所以依据必须是
// **机械可核**的,不能是模型自己说「我有依据」。两种依据各有各的核法:
//   · 记忆:给条目 id,服务端回库里查 —— 必须真的存在、仍是 active、没过期。伪造的 id 当场穿帮。
//   · 委托书:给**原文片段**,服务端按 indexOf 逐字核对 —— 不做相似度。J12 那一轮已经用实测
//     证伪过「中段相似度能分辨改述与反话」(改述 0.176 < 反话 0.556),这里不再走回同一条路。
// 引号片段的下限 8 个字符:短于这个的片段(「是」「均价」)在任何一份委托书里都能碰巧命中,
// 那样的「依据」等于没有依据。上限 200 只是别让它把决策账本撑爆。
// shownChars:代答被驳回、降级成按钮时,确认面板那两行(「它问你:…」「我要替你答:…」)的裁剪长度。
// **有意比 13m 的 STEWARD_ACT_CONFIRM_VALUE_CHARS(40)宽得多**:那个数是给配置项的值用的
// (键=值,40 字够看);而这里第二行就是用户要拍板的【那句答案本身】,截在 40 字等于让他批一段
// 自己没看全的话 —— 那正是这一刀要治的毛病。
// 住在 06i 而不是 13m(确认面板那族常量的老家)是因为**依赖方向**:13k 要用它,而 13m 排在 13k
// 之后 —— 直引就是一条新的前向边(实测当场把 68 顶成 69)。06i 对两边都是后向边。
const STEWARD_ANSWER_BASIS = Object.freeze({ quoteMin: 8, quoteChars: 200, maxMemoryIds: 4, shownChars: 200 });
// 路径同一性:Windows 不分大小写、分隔符两种写法都有。判据单点在这里,四处消费不许各写一遍。
function stewardSamePath(a, b) {
  const norm = v => String(v == null ? '' : v).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const x = norm(a), y = norm(b);
  return Boolean(x) && x === y;
}
// 这个路径落在哪个【已登记工作区】里?返回那个根;不在任何一个里返回空串(fail-closed)。
// 判据只认 config.workspaces —— **recentWorkspaces 不算**(打开过 ≠ 授权过,31 号文红线 2 的原话)。
// W7:「已登记」= 用户的常用工作区 ∪ 如意自己为任务开的文件夹(config.stewardManagedWorkspaces)。
// 后者从这一刀起不再追加进 workspaces[](那张表就是界面上的常用工作区),但它们仍是工作台自己建、
// 自己登记过的目录 —— 管家照样能读里面的交付(steward_file_read)、能把线程挪进去(thread_workspace)。
function stewardWorkspaceRootFor(rawPath, config) {
  const norm = v => String(v == null ? '' : v).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = norm(rawPath);
  if (!target) return '';
  const rows = [
    ...(Array.isArray(config && config.workspaces) ? config.workspaces : []),
    ...(Array.isArray(config && config.stewardManagedWorkspaces) ? config.stewardManagedWorkspaces : []),
  ];
  for (const row of rows) {
    const root = String((row && row.path) || '');
    const key = norm(root);
    // 「在这个根里」= 恰好是它,或以它加一个分隔符开头。少了那个分隔符,`C:/work` 会把
    // `C:/work-secrets` 也算进来 —— 这是路径前缀判据的经典错法。
    if (key && (target === key || target.startsWith(key + '/'))) return root;
  }
  return '';
}
// ── W7:工作区的【名字】与【出身】(两个纯函数,管家清单 / cwd 校验 / 事项读模型三处共用)────────────
// 名字:给管家看、也收管家回填的那个短名。默认取末段名;两个工作区末段名撞了(大小写不计)就往上多带
// 一段(`客户A/报告` 与 `客户B/报告`),还撞就再多带,直到分开或用完整路径。全路径不进管家上下文
// (117w-W1 ③ 的纪律:它是围栏信息),而末段名撞车时模型分不清 —— 修前两处都是只给末段名、回填又
// 只收绝对路径,于是模型【根本填不对】任何一个 cwd,只能省掉、让工作台再开一个新文件夹。
// 入参是路径数组,返回同长度的名字数组(顺序对齐)。纯字符串运算,不碰文件系统。
function stewardWorkspaceLabels(stewardLabelPaths) {
  const list = Array.isArray(stewardLabelPaths) ? stewardLabelPaths.map(p => String(p == null ? '' : p)) : [];
  const segs = list.map(p => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').split('/').filter(Boolean));
  const depth = list.map(() => 1);
  const labelOf = i => (segs[i].length ? segs[i].slice(-depth[i]).join('/') : list[i]) || list[i];
  for (let round = 0; round < 64; round++) {
    const groups = new Map();
    list.forEach((_, i) => { const k = labelOf(i).toLowerCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    let grew = false;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      for (const i of members) if (depth[i] < segs[i].length) { depth[i] += 1; grew = true; }
    }
    if (!grew) break;
  }
  return list.map((_, i) => labelOf(i));
}
// 出身:这个目录是不是【如意自己的】—— 落在数据根里(管家会话自己的 cwd、子代理 worktree、上传与临时
// 目录全在那儿),或者是如意为任务开的、用户还没收编(adopted)的那种。用户亲手加进常用的一律不算。
// dataRootPath 由调用方给(06i 不引用任何外部符号)。
function stewardRuyiOwnedPath(rawPath, config, dataRootPath) {
  const norm = v => String(v == null ? '' : v).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = norm(rawPath);
  if (!target) return false;
  const root = norm(dataRootPath);
  if (root && (target === root || target.startsWith(root + '/'))) return true;
  const rows = Array.isArray(config && config.stewardManagedWorkspaces) ? config.stewardManagedWorkspaces : [];
  return rows.some(row => row && row.adopted !== true && norm(row.path) === target);
}
// 一条线程【自己在交付里列出来的】文件清单(02 的 mission.result.artifacts,封顶 50 条)。
// 不是「它 cwd 里的任何文件」—— 那等于把线程的工作目录整个开给管家看。
function stewardThreadArtifactFiles(head) {
  const rows = (head && head.mission && head.mission.result && Array.isArray(head.mission.result.artifacts))
    ? head.mission.result.artifacts : [];
  return rows.map(a => String((a && a.path) || '')).filter(Boolean).slice(0, 50);
}
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
// 132b(53 号文 §2;用户 2026-09-21「希望能尽量改如意更多的选项」):从「新增键默认最保守、只登记 40 个」改成
// 逐键判过的三张表 —— 136 起 free 33 / confirm 95(此前 31/93;forbidden 数量随默认表总长浮动,以
// unit/steward-config-tier.test.js 的 EXPECTED 为准)。判据只有三条(§2.2):
//   free      改错了一眼看得见、一键改回,不花钱、不改权限、不扩大能动世界的范围;
//   confirm   会花钱、换执行主体、改「谁能不问就做什么」的边界,或影响用户多久看得见一件事 —— 用户按一下按钮;
//   forbidden 密钥、数据根与围栏、命令／桌面／工具放行、提示词注入面、自我扩权开关、簿记与用户行为记录。
// 兜底正则(apiKey|token|secret|password)仍在最前判:含 Tokens 的三个键(stewardContextBudgetTokens /
// summarySingleShotMaxTokensV1 / budgetGuardTurnTokensV1)因此不进表 —— 不给正则开例外,代价是它们只能在设置页改。
const STEWARD_CONFIG_TIER_FREE = Object.freeze([
  'locale', 'outputStyle', 'theme', 'uiMode',
  // 管家自身设置(§3.5「管家自身设置除默认权限与自理清单外」)。stewardEnabledV1 与 stewardAutoActions 不在这里:
  // 前者是总开关、后者是「管家可以自己做的事」清单,两个都属于「管家扩自己的权」,一律 confirm。
  'stewardProviderId', 'stewardModel', 'stewardPollMs', 'stewardMaxTurnsPerHour', 'stewardMaxCostPerDay',
  'stewardReadBudgetChars', 'stewardVisitIdleMinutes', 'stewardNotifyPerHour',
  'stewardConversationRetention', 'stewardMaxParallelThreads', 'stewardGlobalMaxTurnsPerHour', 'stewardGlobalMaxCostPerDay',
  // 136:管家人设两键 —— 纯装饰(自称与口吻),改错了一眼看得见、一键清空,与 locale/theme 同类。
  'stewardPersonaName', 'stewardPersonaStyle',
  // 132b:等待时长 —— 变短只会更早拒／更早算卡住,变长只是多等,不放行任何东西(用户实报「线程提问的等待时长」改不了)。
  'permissionTimeoutMs', 'questionTimeoutMs', 'turnIdleTimeoutMs', 'autonomyPauseOnTimeout', 'autonomyPauseTtlMs',
  // 132b:显示粒度、启停整洁度、本地开销 —— 都是「看一眼就发现、一键改回」那一类。
  'dismissedMcpIds', 'monitorIncremental', 'includePartialMessages', 'storagePolicy', 'killOnDisconnect', 'killPortOnStart',
  'toolCatalogCacheTtlMs', 'enableToolRequiresProbe', 'sessionSearchIndexV1', 'runtimeFailureTelemetryV1',
]);

// confirm:改动会花钱、换执行主体、改变「谁能不问就做什么」的边界,或决定用户多久看得见一件事 —— 用户亲手按一下才算数。
const STEWARD_CONFIG_TIER_CONFIRM = Object.freeze([
  // 主端点与模型选择
  'agentCliType', 'engineMode', 'activeProvider', 'model', 'compactProviderId', 'compactModel', 'modelsApiBase',
  // 子代理端点(§3.5 逐字列出的 subagentPreferred*)
  'subagentPreferredProvider', 'subagentPreferredModel',
  // MCP 连接器启停与浏览器目标(§3.5:经 mcp_configure 同款审批)
  'externalMcpServers', 'enableMcpDropIn', 'includeWorkbenchMcp', 'browserAutomation',
  // 新线程默认权限、管家总开关与自理清单
  'permissionMode', 'stewardEnabledV1', 'stewardAutoActions',
  // 116-5a:线程自动摘要开关 —— 开着就在每一条新线程上花一次钱,且记 aux 不进 stewardMaxCostPerDay。
  'stewardThreadBriefV1',
  // 114a／130／131b:语音识别的三对键 —— 用户的声音／转写文字送去哪个端点、每句花钱。
  'asrProviderId', 'asrModel', 'asrStreamProviderId', 'asrStreamModel', 'asrFixMode', 'asrFixProviderId', 'asrFixModel',
  // 132b:引擎与上下文旋钮 —— 改的是「模型看得见什么、压缩怎么做、一回合多长」,直接影响花费与质量。
  'runtimeOptimizationShadowV1', 'runtimeToolRetrievalV1', 'runtimeObservationReducerV1', 'runtimeObservationRecallV1',
  'runtimeEvaporateBudgetBoundaryV1', 'runtimeHistoryReadDedupV1', 'runtimeSummaryPromptI18nV1', 'runtimeReseedTailUnitsV1',
  'runtimeReseedReattachFilesV1', 'runtimeSessionNotesV1', 'runtimeSessionNotesInjectV1', 'runtimeSessionNotesMergeV1',
  'runtimeSummaryEntityCheckV1', 'runtimeEstimateBucketsV1', 'runtimeSummarySingleShotV1', 'summarySingleShotMaxOverridesV1',
  'runtimeSummaryFactTableV1', 'summaryFactTableMaxSamplesV1', 'runtimeSummaryRefineV1', 'runtimeBudgetGuardV1', 'budgetGuardWarnRatioV1',
  'runtimeToolTimeBudgetShadowV1', 'runtimeToolTimeBudgetV1', 'toolTimeBudgetWarnMsV1', 'toolTimeBudgetHardMsV1', 'toolByteBudgetShadowBytesV1',
  'runtimeVolatileTailLayoutV1', 'runtimeAppendOnlyToolSchemasV1', 'runtimeExecResultCacheV1', 'execResultCacheMaxEntriesV1',
  'runtimeMemoryVectorRecallV1', 'coreMemoryMaxItemsV1', 'coreMemoryCharBudgetV1', 'memoryRelevanceMaxV1', 'memoryFixedSelectionMaxV1', 'memoryIndexCharCapV1',
  'toolEconomicsShadowV1', 'boundedReadSchedulerV1', 'boundedReadConcurrencyV1', 'metaToolHintsV1', 'actionArgumentModelViewV1', 'toolLoadingMode',
  'autoCompactThreshold', 'contextWindowOverrides', 'thinkingBudget', 'claudeThinkingEffort', 'betaInterleavedThinking', 'maxTurns', 'openaiMaxToolIterations',
  // 136:管家压缩触发线系数 —— 调高 = 管家每回合更贵,归「会花钱」那一类;管家只能递按钮。
  // 它的姊妹键 stewardContextBudgetTokens 撞密钥正则(Tokens)仍 forbidden,两个键有意不同档:
  // 正则不开例外(06i 头注),系数没撞正则,按判据落在 confirm。
  'stewardContextBudgetRatio',
  // 132b:并发与班组 —— 同时跑几个就是同时花几份钱。
  'subagentMaxConcurrent', 'subagentMaxPerTurn', 'agentWorkflowMaxNodes', 'agentNodeWrapUpMs', 'agentTaskPoolPolicy', 'agentTaskPoolAutoCap',
  'agentAutoModelTiering', 'shellSessionMax',
  // 132b:模型清单(改了它,下一条线程可能跑在另一个模型上)。
  'knownModels', 'extraModels', 'discoverModelsFromProxy',
  // 132b:调度器与安静卡 —— 123 波原本留在 forbidden(「让模型决定用户多久看见」);按用户新拍板改成 confirm:
  // 管家仍不能自己动,只能递按钮。schedulerEnabledV1 同理(它关掉 = 用户答应过的定时承诺一起停)。
  'schedulerEnabledV1', 'schedulerAskWaitMinutes', 'quietCardSnoozeMinutes',
  // 132b:管家自己的注意力面与执行主体 —— 117l D7／121-K3／123-N2 原本 forbidden;同上,改 confirm(用户按钮)。
  'threadIndexRecent', 'stewardThreadModels', 'newThreadEngine',
  // 132b:钱与账。
  'usageBudget', 'claudePricing',
  'autoResumeClaudeSessions',
]);

// forbidden 的【说明性】清册:不是判据(判据是 fail-closed 的「不在上面两张表里」),而是把
// 那几类在源码里留一份可读的账,免得日后有人以为漏判了。
const STEWARD_CONFIG_TIER_FORBIDDEN_NOTE = Object.freeze([
  'providers', 'searchBackend', 'modelsApiKey', 'claudeAuthMode',      // 密钥/token 值与认证(另有正则兜底)
  'defaultWorkspace', 'workspaces', 'recentWorkspaces', 'additionalDirectories', 'allowOutsideWorkspace', 'stewardWorkspaceRoot',
  'stewardManagedWorkspaces',                                            // W7:如意自己开的文件夹那张表(进已知工作区与可读根)
  'claudePath', 'kimiPath', 'extraClaudeArgs', 'appendSystemPrompt', 'agentRoleOverrides', 'residentSkills',   // 命令行与提示词注入面
  'allowCommandTools', 'allowDesktopTools', 'desktopMcp', 'toolAllowRules', 'bridgedToolTiers',
  'mcpCommandMode', 'permissionBridge', 'autonomyAutoResume', 'bridgeExternalToolsToProvider', 'toolbox', 'autoImportClaudeCodeMcp',
  'capabilityProbeUrl',                                                  // 出网探针地址(SSRF 面)
  // 127 波 2-quater B2(拍板 2「默认开,设置可关,管家自己改不了」):代批开关。**不是 confirm** —— confirm 档
  // 管家提一枚按钮、用户随手一按就翻了,等于管家能劝用户替它扩权。
  'stewardExemptDelegationV1',
  // 簿记与用户行为记录:能改它们 = 能伪造「用户上次选的是我」/ 把任意键去显式化。
  'configSchema', 'version', 'configExplicitKeysV1', 'onboarding', 'lastUsedEngineRoute', 'subagentBudgetMigrated', 'searchBackendMigrated',
]);

// 132b(53 号文 §2.4):每个 free／confirm 键一句人话 [zh, en] —— 单位、范围、改了会怎样。steward_config_get 随值回 help。
// 判据由 unit/steward-config-tier ⑤ 看着:两张表里的每一个键都必须有中英两句,一条不漏。
// 写成 [键, zh, en] 三元组而不是 {键: …}:runtime-optimization.static 用「<键名>:」全仓计数钉每个开关的默认点恰好一处,对象字面量会撞上。
const STEWARD_CONFIG_HELP = Object.freeze(Object.fromEntries([
  ['locale', '界面语言:auto / zh-CN / en-US', 'UI language: auto / zh-CN / en-US'],
  ['outputStyle', '回答风格:detailed(详细)/ concise(简洁)', 'Answer style: detailed / concise'],
  ['theme', '界面主题:dark / light / system', 'UI theme: dark / light / system'],
  ['uiMode', '界面模式:simple(简洁)/ pro(专家,露出高级设置)', 'UI mode: simple / pro (shows advanced settings)'],
  ['stewardProviderId', '管家自己用哪个端点;空 = 跟随对话主端点', 'Endpoint the steward itself uses; empty = follow the main endpoint'],
  ['stewardModel', '管家自己用哪个模型;空 = 该端点缺省', 'Model the steward itself uses; empty = the endpoint default'],
  ['stewardPollMs', '管家多久看一眼收件箱,毫秒(5000–600000)', 'How often the steward checks its inbox, ms (5000–600000)'],
  ['stewardMaxTurnsPerHour', '管家每小时最多跑几个回合(1–200)', 'Max steward turns per hour (1–200)'],
  ['stewardMaxCostPerDay', '管家每天最多花多少钱(按端点货币)', 'Max steward spend per day (in the endpoint currency)'],
  ['stewardReadBudgetChars', '管家一次深读线程最多读多少字', 'Max characters the steward reads per thread deep-read'],
  ['stewardVisitIdleMinutes', '用户离开多少分钟后算「不在」', 'Minutes of user inactivity before counted as away'],
  ['stewardNotifyPerHour', '管家一小时最多主动叫你几次', 'Max proactive notifications per hour'],
  ['stewardConversationRetention', '管家对话保留:visit(本次)/ 24h / forever', 'Steward conversation retention: visit / 24h / forever'],
  ['stewardPersonaName', '管家自称的名字(≤20 字);空 = 默认「如意」', 'Name the steward calls itself (<=20 chars); empty = default "Ruyi"'],
  ['stewardPersonaStyle', '管家口吻偏好,如「更活泼、偶尔用 emoji」(≤200 字);空 = 默认口吻', 'Tone preference for the steward, e.g. "livelier, occasional emoji" (<=200 chars); empty = default voice'],
  ['stewardContextBudgetRatio', '管家上下文用到几成触发压缩(0.3–0.95);调高 = 每回合更贵、压缩更少触发', 'Share of the steward context budget that triggers compaction (0.3-0.95); higher = pricier turns, rarer compaction'],
  ['stewardMaxParallelThreads', '管家同时最多盯几条线程', 'Max threads the steward runs in parallel'],
  ['stewardGlobalMaxTurnsPerHour', '全部线程每小时合计最多跑几个回合', 'Global cap on thread turns per hour'],
  ['stewardGlobalMaxCostPerDay', '全部线程每天合计最多花多少钱', 'Global cap on daily spend across threads'],
  ['permissionTimeoutMs', '线程等你批权限等多久,毫秒;0 = 不限时(默认),一直等到有人处理;设了上限则到时按拒绝处理', 'How long a thread waits for a permission answer, ms; 0 = no limit (default); with a limit it is denied on timeout'],
  ['questionTimeoutMs', '线程等你回答提问等多久,毫秒;0 = 不限时(默认)', 'How long a thread waits for an answer to its question, ms; 0 = no limit (default)'],
  ['turnIdleTimeoutMs', '一回合多久没动静算卡住,毫秒', 'Idle time before a turn counts as stalled, ms'],
  ['autonomyPauseOnTimeout', '等超时后是否把线程暂停(而不是直接失败)', 'Pause the thread on timeout instead of failing it'],
  ['autonomyPauseTtlMs', '暂停多久后自动作废,毫秒', 'How long a paused thread stays resumable, ms'],
  ['dismissedMcpIds', '已忽略的 MCP 推荐清单(不再提示这些)', 'MCP suggestions the user dismissed (not shown again)'],
  ['monitorIncremental', '监视面板增量刷新(关了就整页重画)', 'Incremental refresh of the monitor panel'],
  ['includePartialMessages', '流式时显示部分消息(关了只显示整段)', 'Show partial messages while streaming'],
  ['storagePolicy', '本地数据保留策略:日志保留天数等', 'Local data retention policy (log keep days, etc.)'],
  ['killOnDisconnect', '浏览器断开时结束正在跑的引擎进程', 'Kill the running engine process when the browser disconnects'],
  ['killPortOnStart', '启动时清掉占着端口的旧进程', 'Kill a stale process holding the port on start'],
  ['toolCatalogCacheTtlMs', '工具目录缓存多久,毫秒', 'Tool catalog cache lifetime, ms'],
  ['enableToolRequiresProbe', '启用工具前先探测依赖是否齐', 'Probe dependencies before enabling a tool'],
  ['sessionSearchIndexV1', '本地会话搜索索引开关', 'Local session search index'],
  ['runtimeFailureTelemetryV1', '本地失败遥测(只记本机,不出网)', 'Local failure telemetry (never leaves the machine)'],
  ['agentCliType', 'CLI 引擎:claude / kimi', 'CLI engine: claude / kimi'],
  ['engineMode', '引擎模式:interactive / headless', 'Engine mode: interactive / headless'],
  ['activeProvider', '对话主端点:空或 claude-cli = CLI,否则 providers[].id', 'Main endpoint: empty or claude-cli = the CLI, else a providers[].id'],
  ['model', '对话主模型名;空 = 端点缺省', 'Main model; empty = endpoint default'],
  ['compactProviderId', '上下文压缩用哪个端点;空 = 跟随主端点', 'Endpoint used for context compaction; empty = main'],
  ['compactModel', '上下文压缩用哪个模型', 'Model used for context compaction'],
  ['modelsApiBase', '模型清单 API 地址(可留空)', 'Model list API base (may be empty)'],
  ['subagentPreferredProvider', '子代理优先用哪个端点', 'Preferred endpoint for sub-agents'],
  ['subagentPreferredModel', '子代理优先用哪个模型', 'Preferred model for sub-agents'],
  ['externalMcpServers', '外部 MCP 连接器清单(密钥已掩码)', 'External MCP connectors (secrets masked)'],
  ['enableMcpDropIn', '允许工作区内的 MCP 配置文件自动生效', 'Allow drop-in MCP config files in the workspace'],
  ['includeWorkbenchMcp', '把如意自带的工具作为 MCP 提供给引擎', 'Expose the built-in workbench tools to the engine as MCP'],
  ['browserAutomation', '浏览器自动化目标:system / 指定可执行文件 / CDP 地址', 'Browser automation target: system / executable / CDP URL'],
  ['permissionMode', '新线程默认权限:default / acceptEdits / plan / bypass / auto', 'Default permission for new threads: default / acceptEdits / plan / bypass / auto'],
  ['stewardEnabledV1', '管家总开关', 'Steward master switch'],
  ['stewardAutoActions', '管家可以自己做的事:重试／续跑／递话／开线程／代答', 'Things the steward may do on its own: retry / resume / relay / newThread / answer'],
  ['stewardThreadBriefV1', '自动给每条新线程起名与一句概括(每条花一次钱)', 'Auto-name each new thread with a one-line gist (costs one call each)'],
  ['asrProviderId', '整段语音识别用哪个端点', 'Endpoint for full-clip speech recognition'],
  ['asrModel', '整段语音识别用哪个模型', 'Model for full-clip speech recognition'],
  ['asrStreamProviderId', '实时识别(边说边出字)用哪个端点', 'Endpoint for live (streaming) recognition'],
  ['asrStreamModel', '实时识别用哪个模型', 'Model for live recognition'],
  ['asrFixMode', '句尾改错方式:auto / audio(只重听)/ llm(只改字)/ off', 'Sentence correction: auto / audio / llm / off'],
  ['asrFixProviderId', '改字用哪个大模型端点;空 = 跟随主端点', 'LLM endpoint for text fixing; empty = main'],
  ['asrFixModel', '改字用哪个模型;空 = 端点缺省', 'Model for text fixing; empty = endpoint default'],
  ['runtimeOptimizationShadowV1', '运行时优化的影子模式(只观察不生效)', 'Shadow mode for runtime optimizations (observe only)'],
  ['runtimeToolRetrievalV1', '按需检索工具定义(减少提示词体积)', 'Retrieve tool definitions on demand (smaller prompt)'],
  ['runtimeObservationReducerV1', '压缩工具观测结果', 'Reduce tool observation payloads'],
  ['runtimeObservationRecallV1', '允许模型回看被压缩的观测', 'Let the model recall reduced observations'],
  ['runtimeEvaporateBudgetBoundaryV1', '按 token 预算蒸发早期历史', 'Evaporate early history by token budget'],
  ['runtimeHistoryReadDedupV1', '历史里重复读取的文件只留最新一份', 'Deduplicate repeated file reads in history'],
  ['runtimeSummaryPromptI18nV1', '摘要提示词跟随界面语言', 'Summary prompt follows the UI language'],
  ['runtimeReseedTailUnitsV1', '压缩后按整回合保留尾部', 'Keep whole trailing turns after compaction'],
  ['runtimeReseedReattachFilesV1', '压缩后重附最近读过的文件', 'Re-attach recently read files after compaction'],
  ['runtimeSessionNotesV1', '会话笔记(session-notes.md)开关', 'Session notes (session-notes.md)'],
  ['runtimeSessionNotesInjectV1', '把会话笔记注入提示词', 'Inject session notes into the prompt'],
  ['runtimeSessionNotesMergeV1', '压缩时合并会话笔记', 'Merge session notes during compaction'],
  ['runtimeSummaryEntityCheckV1', '摘要后校验实体没丢', 'Verify entities survive summarization'],
  ['runtimeEstimateBucketsV1', 'token 估算分桶', 'Bucketed token estimation'],
  ['runtimeSummarySingleShotV1', '一次性摘要(不分段)', 'Single-shot summarization'],
  ['summarySingleShotMaxOverridesV1', '按模型覆盖一次性摘要的上限', 'Per-model overrides for single-shot summary cap'],
  ['runtimeSummaryFactTableV1', '摘要附事实表', 'Attach a fact table to summaries'],
  ['summaryFactTableMaxSamplesV1', '事实表最多多少条', 'Max rows in the fact table'],
  ['runtimeSummaryRefineV1', '摘要二次精炼(多花一次调用)', 'Refine summaries with a second call'],
  ['runtimeBudgetGuardV1', '回合 token 预算守卫', 'Per-turn token budget guard'],
  ['budgetGuardWarnRatioV1', '预算用到多少比例就提醒(0–1)', 'Warn ratio of the budget (0–1)'],
  ['runtimeToolTimeBudgetShadowV1', '工具耗时预算的影子模式', 'Shadow mode for tool time budgets'],
  ['runtimeToolTimeBudgetV1', '工具耗时预算开关', 'Tool time budget'],
  ['toolTimeBudgetWarnMsV1', '工具耗时提醒阈值,毫秒(0 = 关)', 'Tool time warn threshold, ms (0 = off)'],
  ['toolTimeBudgetHardMsV1', '工具耗时硬上限,毫秒(0 = 关)', 'Tool time hard cap, ms (0 = off)'],
  ['toolByteBudgetShadowBytesV1', '工具输出字节预算(影子),0 = 关', 'Tool output byte budget (shadow), 0 = off'],
  ['runtimeVolatileTailLayoutV1', '易变尾部布局(缓存友好)', 'Volatile-tail prompt layout (cache friendly)'],
  ['runtimeAppendOnlyToolSchemasV1', '工具定义只追加不重排', 'Append-only tool schema ordering'],
  ['runtimeExecResultCacheV1', '命令结果缓存', 'Cache exec results'],
  ['execResultCacheMaxEntriesV1', '命令结果缓存最多多少条', 'Max exec cache entries'],
  ['runtimeMemoryVectorRecallV1', '记忆向量召回', 'Vector recall for memory'],
  ['coreMemoryMaxItemsV1', '核心记忆最多多少条', 'Max core memory items'],
  ['coreMemoryCharBudgetV1', '核心记忆总字数预算', 'Core memory character budget'],
  ['memoryRelevanceMaxV1', '每轮按相关性带几条记忆', 'Memories recalled by relevance per turn'],
  ['memoryFixedSelectionMaxV1', '固定带几条记忆', 'Fixed memories per turn'],
  ['memoryIndexCharCapV1', '记忆索引字数上限', 'Memory index character cap'],
  ['toolEconomicsShadowV1', '工具经济学统计(影子)', 'Tool economics statistics (shadow)'],
  ['boundedReadSchedulerV1', '受限读取调度器', 'Bounded read scheduler'],
  ['boundedReadConcurrencyV1', '受限读取并发数', 'Bounded read concurrency'],
  ['metaToolHintsV1', '元工具提示', 'Meta tool hints'],
  ['actionArgumentModelViewV1', '动作参数的模型视图', 'Model view of action arguments'],
  ['toolLoadingMode', '工具装载:auto / full / minimal', 'Tool loading: auto / full / minimal'],
  ['autoCompactThreshold', '上下文用到多少比例自动压缩(0–1)', 'Auto-compact when context reaches this ratio (0–1)'],
  ['contextWindowOverrides', '按模型覆盖上下文窗口大小', 'Per-model context window overrides'],
  ['thinkingBudget', '思考预算(CLI 引擎)', 'Thinking budget (CLI engine)'],
  ['claudeThinkingEffort', 'Claude 思考强度', 'Claude thinking effort'],
  ['betaInterleavedThinking', '交错思考(beta)', 'Interleaved thinking (beta)'],
  ['maxTurns', '一次任务最多多少回合;空 = 不限', 'Max turns per task; empty = unlimited'],
  ['openaiMaxToolIterations', 'OpenAI 兼容引擎一回合最多调几次工具(1–200)', 'Max tool iterations per turn on OpenAI-compatible engines (1–200)'],
  ['subagentMaxConcurrent', '子代理同时最多几个', 'Max concurrent sub-agents'],
  ['subagentMaxPerTurn', '一回合最多派几个子代理', 'Max sub-agents per turn'],
  ['agentWorkflowMaxNodes', '工作流最多多少个节点', 'Max workflow nodes'],
  ['agentNodeWrapUpMs', '节点收尾宽限,毫秒', 'Node wrap-up grace, ms'],
  ['agentTaskPoolPolicy', '任务池策略:manual / auto', 'Task pool policy: manual / auto'],
  ['agentTaskPoolAutoCap', '自动任务池上限', 'Auto task pool cap'],
  ['agentAutoModelTiering', '按节点自动分档模型', 'Automatic model tiering per node'],
  ['shellSessionMax', '最多同时开几个 shell 会话', 'Max concurrent shell sessions'],
  ['knownModels', '已知模型清单', 'Known model list'],
  ['extraModels', '手动补充的模型', 'Manually added models'],
  ['discoverModelsFromProxy', '从端点自动发现模型清单', 'Discover models from the endpoint'],
  ['schedulerEnabledV1', '定时任务调度器总开关(关了所有定时承诺一起停)', 'Scheduler master switch (off stops every scheduled promise)'],
  ['schedulerAskWaitMinutes', '无人值守遇到提问等多少分钟再拒', 'Minutes an unattended run waits on a question before refusing'],
  ['quietCardSnoozeMinutes', '安静卡「稍后」推迟多少分钟', 'Quiet-card snooze minutes'],
  ['threadIndexRecent', '管家总览里看最近多少条线程', 'How many recent threads the steward overview shows'],
  ['stewardThreadModels', '管家新开线程按档用的端点/模型(strong/fast)', 'Endpoint/model per tier for steward-opened threads (strong/fast)'],
  ['newThreadEngine', '新线程引擎来源:last(跟上次)/ global(跟全局)', 'New-thread engine: last / global'],
  ['usageBudget', '用量预算与提醒阈值', 'Usage budget and warning thresholds'],
  ['claudePricing', 'Claude 计价表(只影响费用显示)', 'Claude price table (affects cost display only)'],
  ['autoResumeClaudeSessions', '自动续接 Claude CLI 会话', 'Auto-resume Claude CLI sessions'],
].map(([k, zh, en]) => [k, Object.freeze([zh, en])])));
function stewardConfigHelpFor(key, lang) {
  const row = STEWARD_CONFIG_HELP[typeof key === 'string' ? key.trim() : ''];
  if (!row) return '';
  return String(lang || '').toLowerCase().startsWith('en') ? row[1] : row[0];
}

const STEWARD_CONFIG_TIERS = Object.freeze({
  free: STEWARD_CONFIG_TIER_FREE,
  confirm: STEWARD_CONFIG_TIER_CONFIRM,
  forbiddenNote: STEWARD_CONFIG_TIER_FORBIDDEN_NOTE,
  secretPattern: STEWARD_CONFIG_SECRET_PATTERN.source,
  help: STEWARD_CONFIG_HELP,
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
// 107-S1 ④(46 号文 §5 ⑦b H1):**confirm 档的 act 不许是「模型自己命名的那枚按钮」**。
// 主会话逐点核实过的链:13o stewardNormalizeAct 对模型自造的 act 只校验 kind 与 steward_ 前缀,
// args 原样保留、label【优先用模型自己写的那句】;前端 runAct 把整个 act 原样 POST 给
// /api/steward/act;13q 据此置 userPressed:true,而 steward_config_set 就在 STEWARD_ACTION_HOOKS 里、
// confirm 档的唯一判据正是这一位。于是一枚写着「好,我知道了」的按钮可以是
// steward_config_set{externalMcpServers:[…任意 stdio 命令…]}。
// 本函数是这一族的【唯一判据】,给两侧共用:13o 用它决定「丢掉模型的标签、改用服务端派生的说明」,
// 前端用它(经 act.confirmItems)决定「按下去之前先弹确认面板逐条列出要改什么」。
// **不另立一张工具名单**:三支各自【照抄那一支实现自己的那道门】,门在哪儿变了这里就该跟着变 ——
//   · steward_config_set    —— 13l:`keys.filter(k => stewardConfigTierFor(k) === 'confirm')` 非空;
//                              判据就是上面那张 confirm 分档表本身,新增 confirm 键自动进本族;
//   · steward_skill_toggle  —— 13l 无条件要求用户亲手按,所以恒进本族;
//   · steward_thread_permission —— 13k 只在 capabilities.desktop === true(放宽方向)那一支上要求,
//                              收紧档位那几支不进本族(它们本来就不出按钮)。
// 返回 { keys, items }:keys 是「哪些键触发了确认」(config_set 才可能多于一个),
// items 是给用户逐条看的 [{key, value, tier}] —— config_set 给【整份 patch】(那个工具是整份原子:
// 半份生效的配置最难解释,用户按下去时看到的必须是整份),其余两支给它们自己那一件事。
// 纯函数:值原样带出,不在这里拼人话、不脱敏(脱敏表住 04,本文件零外部引用)—— 渲染与掩码由 13o 做。
function stewardActConfirmSpec(tool, args) {
  const name = String(tool == null ? '' : tool);
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  if (name === 'steward_config_set') {
    const patch = (a.patch && typeof a.patch === 'object' && !Array.isArray(a.patch)) ? a.patch : null;
    if (!patch) return null;
    const items = Object.keys(patch).slice(0, 32).map(key => ({ key, value: patch[key], tier: stewardConfigTierFor(key) }));
    const keys = items.filter(item => item.tier === 'confirm').map(item => item.key);
    return keys.length ? { keys, items } : null;
  }
  if (name === 'steward_skill_toggle') {
    const skills = Array.isArray(a.skills) ? a.skills : null;
    if (!skills) return null;
    const ids = skills.map(one => String((one && typeof one === 'object' ? one.id : one) || '')).filter(Boolean).slice(0, 8);
    return { keys: ['skills'], items: [{ key: 'skills', value: ids, tier: 'confirm' }] };
  }
  if (name === 'steward_thread_permission') {
    const caps = (a.capabilities && typeof a.capabilities === 'object' && !Array.isArray(a.capabilities)) ? a.capabilities : null;
    if (!caps || caps.desktop !== true) return null;
    return { keys: ['capabilities.desktop'], items: [{ key: 'capabilities.desktop', value: true, tier: 'confirm' }] };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 116 波 116-2e(§11.1 第 2 项「速查线程」):速查会话的头字段形状与答案硬顶。
// 速查线程 = 管家为了回答一个「要读文件/联网/动手才能答」的问题临时开的线程:不进事项、答完即收工,
// 收工后从总览与线程搜索里消失(数据还在,经典壳照常能看见 —— 它只是不再占管家的注意力预算)。
const STEWARD_QUICK_KIND = 'quick_ask';
const STEWARD_QUICK_ANSWER_CHARS = 1200;
const STEWARD_QUICK_QUESTION_CHARS = 1000;

// 117s-H1(27 号文 §11.13.3「交付进箱」):一条 done 事件随身带的【交付正文】上限。
// 与上面那个 1200 的速查答案是两回事:速查答案是「一句话答案」,交付是线程这一回合真正产出的东西
// (真机上「A股每日分析」那一回合 2687 字),4000 字才装得下一份带小标题与清单的交付。
// 放在这里而不是 13g:它与 STEWARD_QUICK_ANSWER_CHARS 是同一族预算,数字只许有一份。
const STEWARD_DELIVERABLE_CHARS = 4000;

// 「管家关心这条会话吗」的唯一判据(§11.7):速查线程 / 管家发起过回合的线程 / 别人事项里的线程。
// 用户自己在经典壳里聊的普通会话【不】入箱 —— 他就坐在那条线程前面,不需要管家再通知他一次。
//
// 117r-D1:原地从 13i-steward-inbox.js 搬来,一个字节没改,13i 改成直接调这一份(不留第二份实现)。
// 为什么搬:13e 的卡片产生条件要的正是同一条线 —— 管家开的线程要在看板上看得见,用户自己在 2.0 里
// 聊的几百条普通会话一律不进(那正是 `filter(row => row.card)` 当初存在的理由)。而 13e 引用 13i 是
// 前向边(13e 拼在 13i 之前),引用 06i 是后向边;13i->06i 与 13e->06i 两条边在依赖图里本来就存在
// (docs/architecture/module-dependency-graph.json,direction backward),故本次搬家零新增边、
// forwardEdges 不变。落点教训见 30 号文 §8.9(117q-B7:TOOL_TIER_RANK 放进 07 造出净新增环边)。
//
// 121-K3(34 号文 §4.1「两个判据取代一个」):本函数【保留原语义】,只多认一个显式开关 —— 用户在
// 界面上按的那枚「交给管家盯」写 head.stewardWatch(PATCH /api/sessions/:id,白名单在 02)。
//   · true  -> 恒 watched(哪怕它是用户自己在 2.0 里开的普通会话);
//   · false -> 恒不 watched,【对管家自己开的线程也生效】= 用户接手,别再盯了(§4.4 反向那一半)。
//   · 没写这个字段 -> 原来那三条判据,一个字不变。
// 显式开关排在三条判据之前:它是人刚刚按下的意愿,凭什么被「这条线程当初是谁开的」盖掉。
function stewardWatchedThread(head, sessionId, missionId) {
  if (!head || typeof head !== 'object') return false;
  if (head.stewardWatch === true) return true;
  if (head.stewardWatch === false) return false;
  if (head.stewardQuick && typeof head.stewardQuick === 'object') return true;
  if (head.launchedBy === 'steward') return true;
  return String(missionId || '') !== String(sessionId || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// 121-K3(34 号文 §4.1):线程【来源】三值与线程【可见】判据。两者与上面那条 watched 各管各的:
//   · origin   = 这条线程是谁开的(出身,终身不变)—— 界面上只画图形(环/人形/钟);
//   · watched  = 管家要不要为它动手(状态,用户随时可改);
//   · visible  = 它要不要出现在任务索引里(窗口,治噪音用的)。
// 修前索引只有 watched 一条线,于是「用户在 2.0 里开的普通会话永远不上看板」(§1.3 的病根)。
// ─────────────────────────────────────────────────────────────────────────────
const THREAD_ORIGINS = Object.freeze(['steward', 'user', 'schedule']);
// 「今天有动静」的窗口。24 小时而不是自然日:跨零点那一刻不该让半个索引凭空消失。
const THREAD_VISIBLE_TODAY_MS = 24 * 60 * 60 * 1000;
// 「最近 N 条」那一条的 N 【不在这里】:threadVisible 只收一个算好的 recent 布尔,N 是配置项
// (config.threadIndexRecent),它的缺省与钳位区间住在 01-config(THREAD_INDEX_RECENT_*)——
// 01 拼在 06i 之前,数字放这里会让 01 反向引用 06i,那是一条净新增前向边。

// 存量会话头上没有 origin 字段(121-K3 之前建的),读侧现场派生、**不回写**:
// 出身标 createdBy === 'steward' 是 117z-E2 立的、终身不变的那一个;launchedBy 会被递话污染
// (管家往用户自己的会话里递一句话也会打上它),所以它只作次级证据 —— 两个都没有就是用户自己开的。
// 定时任务(119 波)落地后由它自己在建会话时写 origin:'schedule';派生侧不猜,猜不出来就是 'user'。
function threadOriginOf(head) {
  if (!head || typeof head !== 'object') return 'user';
  const declared = String(head.origin || '');
  if (THREAD_ORIGINS.includes(declared)) return declared;
  if (String(head.createdBy || '') === 'steward') return 'steward';
  if (String(head.launchedBy || '') === 'steward') return 'steward';
  return 'user';
}

// 「这条线程要不要进任务索引」。四条【并集】(§4.1):在途 ∪ 今天有动静 ∪ 最近 N 条 ∪ watched。
// 纯函数:在途与最近 N 条这两条靠调用方喂事实(活回合表与目录时序都在 06i 看不见的层),
// 本函数只负责把四条合成一条,不另立第二套判据。
//   input = { now, watched, inFlight, recent }
//     · watched  —— stewardWatchedThread 的结果(调用方已经算过一次,不在这里重算);
//     · inFlight —— 此刻有活回合 或 有未决(= 五态非 done/stopped 的那一半机器事实);
//     · recent   —— 这条线程在「最近 N 条」窗口内(N = config.threadIndexRecent)。
// 参数名用 head/input(与本文件既有两个纯函数同名):32 号文 §4 纪律 12 —— 裸参数名会被依赖图
// 当跨模块符号,起个没在更早模块出现过的名字比省几个字符重要。
function threadVisible(head, input) {
  if (!head || typeof head !== 'object') return false;
  const src = (input && typeof input === 'object') ? input : {};
  if (src.watched === true) return true;
  if (src.inFlight === true) return true;
  if (src.recent === true) return true;
  const stamp = Date.parse(String(head.updatedAt || ''));
  const now = Number.isFinite(Number(src.now)) ? Number(src.now) : Date.now();
  return Number.isFinite(stamp) && (now - stamp) <= THREAD_VISIBLE_TODAY_MS;
}

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
//   opts:    { now, minScore, unsureRatio, focusSessionId }均可选,不传则用 STEWARD_PREROUTE_DEFAULTS。
//            focusSessionId(128h-J03):用户此刻看着的那条线程(输入区右栏「现在这一件」),只在下面 ②b 与 ⑤b 两处用。
//
// 五种 kind 的判定顺序(§8.12 第 1 条「输入即预判」逐条落实):
//   ① q 去空白后为空 -> 'steward'(默认收件人「如意」本身,不用词法判定)。
//   ② 命中定时意图(isSchedule)-> 'schedule',优先于线程词法命中(「明天 9 点提醒我交周报」不能
//      因为「周报」命中一条线程就被当成递话——用户是要建提醒,不是要跟那条线程说话)。
//   ②b 128h-J03(41 号文 J03「两个近似任务,用户说『继续那个』」):纯指代(「继续」「接着做」「继续那个」「continue」……
//      句子里除了指代没有任何可打分的词)不走词法 —— 词法对它恒为 0 分,修前落 'new',管家据此可能另开一条。
//      焦点在索引里 -> 'thread'(那一条,理由「指代：当前焦点」);没有焦点、≥2 条 -> 'unsure'(最近更新的两条,
//      「只问必要区别」);恰 1 条 -> 'thread'(没有可区别的);0 条 -> 'steward'(没有能接着的,交给如意答)。
//   ③ 词法打分:见 stewardPrerouteScoreThread;候选按分降序、同分按 sessionId 升序(确定性)取前 3。
//   ④ 最高分 < minScore(默认 2):isQuestion(q) -> 'question',否则 -> 'new'。
//   ⑤ 最高分 ≥ minScore 且次高分 ≥ 最高分 × unsureRatio(默认 0.85)-> 'unsure'(hits 给前两名,
//      §8.12 第 5 条「只在真分不出时才问」)。
//   ⑤b 128h-J03:⑤ 判成 'unsure' 而并列的两名里有一条就是焦点 -> 'thread'(焦点那一条,理由后缀「当前焦点」)——
//      「通过当前焦点确定」;焦点不在并列里不越权,照旧 'unsure'。
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

// 128h-J03:纯指代 ——「继续」「接着做」「继续那个」「那个接着」「continue that」……句子里除了指代词与语气词没有别的。
// 只认【整句】:「继续那个报告」有可打分的词,走词法(焦点只在并列时当裁判,见 ⑤b)。宁可漏认(落回词法、再落回
// 'new'／'question',管家照样看得到原话)也不多认 —— 多认会把一句新话当成接着焦点那条的话。
const STEWARD_DEICTIC_ZH_RE = /^(?:请)?(?:(?:继续|接着)(?:做|干|办|弄|来|推进|跑)?(?:那个|这个|那件|这件|那条|这条|刚才(?:那个|那件|那条|的)?|上一个|上一件|它)?|(?:那个|这个|那件|这件|那条|这条|刚才那个|就那个|还是那个)(?:继续|接着(?:做|干|办|弄|来)?)?)(?:吧|啊|呀|一下)?$/;
const STEWARD_DEICTIC_EN_RE = /^(?:please\s+)?(?:continue|resume|keep going|carry on|go on)(?:\s+(?:with\s+)?(?:that|this|it|that one|this one))?(?:\s+please)?$/i;
function stewardPrerouteIsDeictic(input) {
  const s = String(input || '').normalize('NFKC').trim().replace(/[\s。．.!！~～…]+$/u, '').trim();
  if (!s || s.length > 24) return false;
  return STEWARD_DEICTIC_ZH_RE.test(s) || STEWARD_DEICTIC_EN_RE.test(s);
}
// 指代命中时的候选行(不经词法打分,理由直说「指代」)。
function stewardPrerouteDeicticHit(row, reason) {
  return stewardPrerouteHit({ row, score: 0, titleHits: new Set(), missionHits: new Set(), summaryHits: new Set(),
    phraseHit: false, memoryHit: false, recent: false, stateWeighted: false, deicticReason: reason });
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
  if (candidate.deicticReason) return stewardSanitizeText(candidate.deicticReason);   // 128h-J03
  const parts = [];
  const words = new Set([...candidate.titleHits, ...candidate.missionHits, ...candidate.summaryHits]);
  if (words.size) parts.push('命中词：' + Array.from(words).slice(0, 6).join('、'));
  if (candidate.phraseHit) parts.push('短语命中');
  if (candidate.memoryHit) parts.push('记忆加权');
  if (candidate.recent) parts.push('近期更新');
  if (candidate.stateWeighted) parts.push('它在等你或已停');
  if (candidate.focusTieBreak) parts.push('当前焦点');   // 128h-J03 ⑤b
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

  // 128h-J03 ②b:纯指代(见头注)。
  const focusId = options.focusSessionId == null ? '' : String(options.focusSessionId);
  const liveRows = (Array.isArray(index) ? index : []).filter(row => row && row.sessionId);
  if (stewardPrerouteIsDeictic(trimmed)) {
    const focusRow = focusId ? liveRows.find(row => String(row.sessionId) === focusId) : null;
    if (focusRow) return { kind: 'thread', hits: [stewardPrerouteDeicticHit(focusRow, '指代：当前焦点')] };
    if (!liveRows.length) return { kind: 'steward', hits: [] };
    if (liveRows.length === 1) return { kind: 'thread', hits: [stewardPrerouteDeicticHit(liveRows[0], '指代：唯一在办的线程')] };
    const byRecent = liveRows.slice().sort((a, b) =>
      (Date.parse(String(b.updatedAt || '')) || 0) - (Date.parse(String(a.updatedAt || '')) || 0)
      || String(a.sessionId).localeCompare(String(b.sessionId)));
    return { kind: 'unsure', hits: byRecent.slice(0, 2).map(row => stewardPrerouteDeicticHit(row, '指代：最近更新，没有焦点可依')) };
  }

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
    // 128h-J03 ⑤b:并列的两名里有一条就是焦点 -> 焦点来裁;焦点不在并列里不越权。
    const tied = [top[0], top[1]];
    const byFocus = focusId ? tied.find(c => String(c.row.sessionId) === focusId) : null;
    if (byFocus) return { kind: 'thread', hits: [stewardPrerouteHit({ ...byFocus, focusTieBreak: true })] };
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
//   定时任务族(123-M2,37 号文 §3.5;归「如意设置」族,list 是 tier read、其余五个 edit):
//           scheduleCreate(args,ctx)、scheduleList(args,ctx)、schedulePause(args,ctx)、
//           scheduleResume(args,ctx)、scheduleRunNow(args,ctx)、scheduleDelete(args,ctx)
//           —— 实现住 13t-steward-schedule.js(它排在 13s 之后才够得着调度器原语),门控壳仍是
//           13g 的 stewardToolHandler;无人值守(stewardUnattendedByModel)时 create/delete 只提议。
// 全部工具实现键的签名统一为 (args, ctx) 并返回稳定信封(见 13g 的 stewardToolHandler)。
//
// ── ctx.userPressed 的规矩(116-2e,静态锁 steward-tools.static ⑦ 机械看住)──────────────
// `ctx.userPressed === true` 的唯一来源是 13h 的 `POST /api/steward/act` 执行路径 —— 用户在界面上
// 【亲手按下】了那个按钮,13h 在构造 ctx 时置 true。模型回合里的工具调用 ctx 【永远】没有它,
// 13g 的 stewardToolHandler 在进实现前把 args 里任何同名字段剥掉(模型自称「用户按了」不算数)。
// 读它的地方只有三处(117z-E2 之前是两处):
//   ① steward_config_set 的「须确认」判定(13l);
//   ② steward_skill_toggle 的「须确认」判定(13l);
//   ③ 117z-E2(§11.21.3):steward_thread_permission 的 `capabilities.desktop === true` ——
//      给一条线程【开】桌面权限是这个工具上唯一的放宽方向,它恒 propose_required(含 auto 档),
//      只有用户亲手按下那枚按钮的那一次能穿过去。收紧方向(desktop:false)与档位轴的收紧一样
//      不读它。这一处【不是】把按钮变成扩权能力的口子:它开的是【会话级】覆盖,全局
//      allowDesktopTools 仍在下面的 forbidden 清册里,管家一个字都改不了。
// `stewardMayAct`、永久豁免清单、线程【档位】判定一概【不读】它 ——
// 用户按下一个按钮 ≠ 管家从此获得放宽权限的能力(§3.3 永久豁免第 2 条)。
// 【只降不升的机械规则在新那条轴上原样成立】:能自动的只有降,升永远要人按。
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
//           appendUserStop(sessionId,{stopped,queuedStopped}) -> Promise<boolean>
//             (121-K5,34 号文 §4.4 末条 / 33 号文 §0:用户在界面上手按的停止也记一行决策日志。
//              消费者是 13 的 POST /api/stop —— 它拼在 13h 之前,直接调 13j 的 stewardAppendDecision
//              是前向边,所以与 cancelQueuedTurn 同款走这个命名空间。开关关时实现直接返回 false。)
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
//           relayChannel(sessionId) -> { channel, wait?, questionId?, pendingId? }(同步只读,零文件读)
//             (117s-G:通道判定本身也上命名空间 —— 13d 的 GET /api/sessions/:id 要把 channel 投影成
//              信封上的 relay 键,经典壳据此决定「发送 / 插话 / 先别发」。递话判据全仓仍只有这一份)
//           currentTurnTrigger() -> 'user' | 'inbox' | ''(同步只读,零文件读)
//             (129g:此刻正在跑的那个管家回合是谁触发的。消费者是 13g 的 stewardToolHandler ——
//              09-workflow 造的工具循环 ctx 里【没有】trigger,不补的话所有按 trigger 分档的闸
//              在「模型直接调工具」这条调用面上整个失灵。13g -> 13h 是前向边,故走这里)
//   116-pre(由 13h-steward-runner.js 填充,GET /api/steward/preroute 与 117 壳层都经这个键调):
//           preroute(q,config?,extra?) -> { kind, hits }(装配 index/memory 后调纯函数 prerouteText;
//           extra.focus = 用户此刻看着的那条线程,128h-J03,可缺;
//           零模型、缓存命中不重装配)
const StewardHooks = {};
