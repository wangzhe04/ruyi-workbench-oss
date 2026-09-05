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

// 延迟绑定命名空间(先例:06c-agent-loop-hooks.js 的 AgentLoopHooks)。本切片(116a)只声明空对象与
// 契约注释,不实现——填充者是后续切片的 13g-steward.js(transport 层,加载时 Object.assign(StewardHooks,
// {...})),消费者是 12-tool-dispatch.js 里 session.kind==='steward' 才 offer 的管家工具 handler。
// 这样 06i(engine,拼接顺序更早)与 13g(transport,拼接顺序更晚)之间不产生编译期循环引用——06i 从不
// import/require 13g,13g 单向往 06i 已声明的对象上挂方法。
//
// 预留键名契约(按族分组,签名与返回形状由填充它们的切片各自文档化):
//   观察族: threadStatus(threadId)、threadRead(threadId, {tail, maxChars})、
//           threadsSearch(query)、runsStatus()、inboxRead({since, limit})
//   线程族: threadNew(brief)、threadContinue(threadId, message)
//   决策族: decide(threadId, decision)、runAction(threadId, action)
//   记忆族: memoryWrite(entry)、memoryVeto(id)、memorySearch(query)
const StewardHooks = {};
