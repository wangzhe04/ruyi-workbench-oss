// ============================================================================
// 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家回合运行器的共享底座。
//
// 落点(transport 层,manifest 中位于 13g-steward.js 之后、13n-steward-arbiter.js 之前)。
// T2 拆分:原 13h-steward-runner.js 已 2522 行 —— 比 T1 拆之前的 13g 还长,而 31 号文七轴的
// 回合层改动(污染打标、代答/代批、通知)全要往它里面加。按「谁被谁引用」把它拆成六个
// 文件,拼接顺序即依赖方向,零新增前向边:
//   · 13m-steward-runner-base.js —— 六个文件都要用的共享面:落盘面常量、回合层数值口径、
//     自理动作与到访摘要的文本表、可由 actions 执行的写工具白名单、运行时内存态
//     stewardRunnerRuntime、停机/唤醒/中止,以及管家会话单例(引擎解析 + 懒创建);
//   · 13n-steward-arbiter.js —— 116h 线程间仲裁(并发位 / 同 cwd 写锁 / 预算 / 可解释的排队 / 饥饿提升)。
//     它排在提示词之前,因为总览行与递话通道都要读它的等待原因(stewardArbiterWait);
//   · 13o-steward-runner-prompt.js —— 提示词装配(记忆块 / 线程摘要 / 递话预判 / 总览 /
//     两个分叉入口)与 {say,acts,actions,why} 输出契约解析;
//   · 13p-steward-runner-actions.js —— actions 执行与降级、116-2b 确定性自理动作、id 人话化、
//     熔断、收件箱消息装配、输入区预判归一;
//   · 13q-steward-runner-turn.js —— 回合入口 runStewardTurn、收件箱去抖驱动、到访与归档、
//     117l D2 递话通道、117l D7 线程分档落盘、acts 落定;
//   · 13h-steward-runner.js —— 两个「够不着才落在这里」的工具实现(thread_prioritize /
//     thread_stop)、三条路由、运行器状态与 StewardHooks 注册表(排在最后:注册表要引用
//     上面五个文件里的实现,排在后面才是后向边)。
// 本次拆分是【纯搬家】:所有函数体逐字节不变,新写的只有各文件的头部注释。
//
// 依赖纪律(§11.3「不得新增前向边」):本文件只引用拼接顺序在它之前的模块符号
// (00/01/02/04/06b/06i/08/09/10/13e/13g 族 …),全部后向边;它自己的符号只被排在它之后的
// 管家运行器族文件与 14-main.js 的 e2e 导出面引用,同样是后向边。
// ============================================================================
// ── 落盘面(唯一新增:到访归档;已登记进 durable-state-inventory)────────────────────────────────
const STEWARD_VISITS_DIR = 'visits';
const STEWARD_VISIT_SCHEMA = 1;
const STEWARD_VISITS_KEEP = 200;              // 归档文件保留个数(超出从最旧删起)

// ── 回合层数值口径(§11.2)────────────────────────────────────────────────────────────────────
const STEWARD_INBOX_EVENTS_PER_TURN = 30;     // 一个收件箱回合最多带 30 条事件
const STEWARD_INBOX_EVENT_CHARS = 400;        // 每条事件 ≤400 字
// 117s-H1(27 号文 §11.13.3):事件行仍是那 400 字的标题行,交付正文另起一个【受预算的引用块】
// 跟在它后面 —— 于是模型不必再花一次 steward_thread_read 配额去读它自己刚被通知的那份交付。
const STEWARD_INBOX_DELIVERABLE_CHARS = 4000; // 单条交付正文在收件箱消息里的上限
const STEWARD_INBOX_MESSAGE_CHARS = 12000;    // 一条收件箱消息的总预算(标题行永不丢,正文从最旧的丢起)
const STEWARD_MEMORY_BLOCK_CHARS = 3000;      // 记忆块 ≤3000 字符
// 117y-S1(27 号文 §11.18.2):原来这里只有一个 say 上限常量(600),它同时扮演两个角色 ——
// 06b 输出契约里写给模型看的「≤600 字」,和 13o 解析时那把裸 slice。用户第十一轮拍板:
// 「得保证话能说全,不要硬截…通过提示词去约束说的话长度」。于是两个角色拆开:
//   · TARGET  = 600  —— 只说给模型听的目标(06b 输出契约那一行)。**运行期不再据此裁剪。**
//   · CEILING = 4000 —— 只防病态载荷(尤其 13o 那条 JSON 解析失败的兜底会把整份原始模型输出
//     灌进来)。约为目标的 6.7 倍,守规矩的回复永远碰不到;触到了也走 06i 的
//     stewardTrimSayAtSentence 在句末标点处切并明说,不裸切。
// 旧名直接删掉而不留别名:全仓消费方只有 13o 的那两处(其余命中全是生成物
// module-contracts.json / module-dependency-graph 与 27 号文的病灶描述),不存在被静默改语义的第三方。
const STEWARD_SAY_TARGET = 600;               // say 的提示词目标(不是运行期上限)
const STEWARD_SAY_CEILING = 4000;             // say 的病态载荷天花板(触顶按句界裁剪并明说)
const STEWARD_WHY_MAX = 400;
const STEWARD_ACT_LABEL_MAX = 12;             // 按钮文字 ≤12 字
const STEWARD_ACTS_MAX = 3;                   // 一次回合按钮 ≤3 个
const STEWARD_ACTIONS_MAX = 5;                // 一次回合最多执行 5 条 action(其余丢弃并如实标注)
const STEWARD_DEBOUNCE_MS = 5000;             // 收件箱去抖窗口
// 116-4(27 号文 §11.7 第 2 项「速查闭环」):速查线程的答案是【用户正在等的那一句】。让它也压满
// 5 秒去抖,用户的体感就是「问一次要等两趟」。带 quick:true 的 done 行把本次去抖压到 0,其余事件
// 仍走 5 秒 —— 它们是通知,不是有人正等着的答案。
const STEWARD_QUICK_DEBOUNCE_MS = 0;          // 速查答案:不去抖,立刻起回合
const STEWARD_NO_PROGRESS_MAX = 5;            // 连续 5 次收件箱回合零 acts 零 actions -> 退避
const STEWARD_VISIT_DIGEST_MAX = 5;           // 到访摘要 ≤5 条人话
const STEWARD_PENDING_LIST_MAX = 20;          // 到访返回的待决列表上限
const STEWARD_TURN_WINDOW_MS = 60 * 60 * 1000; // 每小时回合上限的滑动窗口
const STEWARD_TURN_DAY_MS = 24 * 60 * 60 * 1000; // 回合时间戳表只保留 24 小时(state 的 day 口径同源)
const STEWARD_PREEMPT_WAIT_MS = 15000;        // 抢占后等在途回合收尾的上限
// 117l D3(§11.9;用户第四轮走查第 6 条「为啥输出完了还显示『在忙上一件』;要能让用户连续发消息」):
// 用户回合撞用户回合时【真】排队等前一个收尾的上限。修前是一发 Promise.race(15s) 之后【不复查】,
// 超时就带着一个还在写正文的回合再开一个 —— 两个回合同时写管家会话正文,后一条把前一条盖掉。
const STEWARD_USER_QUEUE_WAIT_MS = 5 * 60 * 1000;
// ── 116-2b 自理动作(§3.3 自理清单的【真实执行】)──────────────────────────────────────────
const STEWARD_SELF_SERVE_ATTEMPT_MAX = 2;    // 同一目标连续 2 次自理动作后仍失败 -> 停自动、只提议
const STEWARD_SELF_SERVE_RETRY_WINDOW_MS = 60 * 60 * 1000; // 同一目标本小时只自动重试一次
const STEWARD_SELF_SERVE_PER_TURN_MAX = 3;   // 一个收件箱回合最多自理 3 个目标(其余进回合层)

// ── 到访摘要的五类人话(确定性归纳,不调模型;§8.9「每次打开只汇报」)──────────────────────────
const STEWARD_DIGEST_KIND_TEXT = Object.freeze({
  needs_you: n => `${n} 条线程在等你拿主意`,
  failed: n => `${n} 条线程出错了`,
  done: n => `${n} 条线程收工了`,
  stalled: n => `${n} 条线程停住了`,
  budget: n => `${n} 条线程用完了预算`,
  // 121-K3(34 号文 §4.4「交接」):第六类。措辞用「交给你盯」而不是「交给你」—— 交接的是注意力,
  // 不是所有权:用户随时可以再坐回那条线程,那时 §4.5 的在场门会让管家自动松手。
  adopted: n => `${n} 条线程刚交给你盯`,
  // 123-M2(37 号文 §3.5):第七类。措辞是「到点了」而不是「有 N 条提醒」—— 这一类不需要用户
  // 回答任何东西,它只是把「你自己排的那件事发生了」说一遍(到点提醒、错过跳过、连败熔断三件
  // 都走它,共同点就是「一句事实」)。
  reminder: n => `${n} 件定时任务到点了`,
});

// ── 可由 actions 执行的写工具 -> StewardHooks 实现键。白名单即闸门:不在表里的工具名一律拒绝
//    (读类工具没有出现在这里的理由 —— 模型要读就自己在回合里调工具,不该经 actions 绕一圈)。
const STEWARD_ACTION_HOOKS = Object.freeze({
  steward_thread_new: 'threadNew',
  steward_thread_continue: 'threadContinue',
  steward_thread_rename: 'threadRename',
  steward_thread_prioritize: 'threadPrioritize',   // 116h:§8.10 看板每行的「提升优先级」按钮
  steward_decide: 'decide',
  steward_run_action: 'runAction',
  steward_thread_stop: 'threadStop',               // 117m-A4:线程级停止(不在表里 = 按钮按下去 4xx)
  steward_memory_write: 'memoryWrite',
  steward_memory_veto: 'memoryVeto',
  // 116-2e:两个「须确认」的写工具。它们在模型回合里一定回 propose_required(ctx 里没有
  // userPressed),被 stewardDowngradeActions 降级成一个按钮;用户按下那个按钮走
  // POST /api/steward/act,那条路径才置 ctx.userPressed = true。
  steward_config_set: 'configSet',
  steward_skill_toggle: 'skillToggle',
  // 117z-E2b 提交①(27 号文 §11.21.7 债 ①):线程权限。E-手① 时它只降档、从不 propose_required,
  // 不进表没关系;E-手② 给它加了 capabilities.desktop,desktop:true 在【任何】档位都回 propose_required
  // -> 被降级成按钮 -> 用户按下去经这张表找实现;不在表里 = 13q 查不到 -> not_allowed 4xx,
  // 生产形状是「管家说要开桌面,按钮出来,按了报错」。与 config_set / skill_toggle 同一个「须确认」
  // 模具:只有 13q 那条路置 ctx.userPressed = true,13k 只在 desktop:true 那一支上读它。
  steward_thread_permission: 'threadPermission',
});

// 降级成按钮时的人话标签(§8.4「话＋一行按钮」:按钮上写用户要做的那件事,不写工具名)。
const STEWARD_DECIDE_LABELS = Object.freeze({ allow: '允许', deny: '拒绝', approve: '批准', reject: '驳回', answer: '回答' });
const STEWARD_RUN_ACTION_LABELS = Object.freeze({ pause: '暂停', resume: '继续', stop: '停止', retry_node: '重试', steer_node: '插话' });
const STEWARD_TOOL_LABELS = Object.freeze({
  steward_thread_new: '新开线程', steward_thread_continue: '接着办', steward_thread_rename: '改标题',
  steward_memory_write: '记下', steward_memory_veto: '别记',
  steward_thread_prioritize: '插到最前',
  steward_thread_stop: '暂停这条线程',                            // 117m-A4
  steward_config_set: '改设置', steward_skill_toggle: '改技能',   // 116-2e
  // 117z-E2b 提交①:这是行动流水与兜底用的总称;真正降级成按钮的只有 capabilities.desktop === true
  // 那一支,13o 的 stewardActLabel 按 args 把它写成「给它开桌面」(按钮上写用户要做的那件事,§8.4)。
  steward_thread_permission: '改线程权限',
});

// ────────────────────────────────────────────────────────────────────────────
// 运行时状态。全部【只在内存】—— 管家的持久化面只有 13g 登记的四个 + 本切片的 visits 归档,
// 到访状态本身不落盘(进程重启 = 新到访,与 §11.1 第 7 项「一次到访 = 页面重开或静默 60 分钟」一致)。
// ────────────────────────────────────────────────────────────────────────────
const stewardRunnerRuntime = {
  // 123-M2:fireSeq 是【承诺三项】的第二个水位。为什么不能复用 inboxSeq:fires-v1.ndjson 有它
  // 自己的一条单调 seq(13s 的账本),与收件箱那条各走各的 —— 拿收件箱的行号去筛 fires 的行
  // 会漏掉/重复算「上次到访以来跳过或结果未知的那几次」。
  visit: { startedAt: '', lastActivityAt: '', inboxSeq: 0, fireSeq: 0, previousStartedAt: '' },
  turns: [],            // 已跑回合的时间戳(ms),滑动窗口用
  noProgress: 0,        // 连续零进展的收件箱回合数
  inflight: null,       // { kind:'user'|'inbox', promise, controller, cancelled, events }
  queue: [],            // 待处理的收件箱事件(抢占时回排在这里)
  debounceTimer: null,
  debounceMs: -1,       // 116-4:当前那个定时器排的是多久(用来判「该不该重排成更快的」)
  lastReply: null,      // 最近一次 steward_reply 的精简副本(供 /api/steward/state)
  circuit: null,        // 最近一次触发的熔断 { kind, at, detail }
  stopped: false,       // 一键停机:停轮询的同时停回合队列
  // 116-2b:自理动作的每目标账。targetKey = sessionId|runId。只在内存(进程重启 = 重新开始数;
  // 与 §11.1 第 7 项「重启即新到访」同一立场:重启后第一次仍值得试一次,连着失败才该停手)。
  selfServe: new Map(),  // targetKey -> { attempts, lastRetryAt, lastActionAt }
};

function stewardStopRunner() {
  stewardRunnerRuntime.stopped = true;
  if (stewardRunnerRuntime.debounceTimer) { clearTimeout(stewardRunnerRuntime.debounceTimer); stewardRunnerRuntime.debounceTimer = null; }
  stewardRunnerRuntime.queue = [];
  const inflight = stewardRunnerRuntime.inflight;
  if (inflight) {
    inflight.cancelled = 'stopped';
    stewardAbortInflight(inflight);
  }
  return { ok: true, stopped: true };
}
function stewardResumeRunner() {
  stewardRunnerRuntime.stopped = false;
  return { ok: true, stopped: false };
}

// 停一个在途管家回合:先 stopSession(既有停止原语 —— 它拿到 activeChildren 里的 abort 句柄直接掐
// 在途 fetch,不依赖 killOnDisconnect 配置),再 abort 我们自己的 signal(双保险;runSessionTurn 的
// 断线语义走的是这条)。线程自己的回合不受影响 —— 这里停的只有管家会话。
function stewardAbortInflight(inflight) {
  try { stopSession(STEWARD_SESSION_ID, 'steward-preempt'); } catch { /* 没有在途子进程即无操作 */ }
  try { if (inflight && inflight.controller) inflight.controller.abort(); } catch { /* 无 AbortController 环境 */ }
}

// ────────────────────────────────────────────────────────────────────────────
// 管家会话(单例)。
// ────────────────────────────────────────────────────────────────────────────

// 引擎解析:stewardProviderId/stewardModel 为空则跟随主端点(§11.1 第 5 项)。
// 返回 { ok:true, route } 或 { ok:false, error:'steward.unsupported_engine', engine }。
function stewardResolveRoute(config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const explicitId = String(cfg.stewardProviderId || '').trim();
  if (explicitId) {
    const provider = (cfg.providers || []).find(p => p && p.id === explicitId);
    if (!provider) {
      return { ok: false, error: 'steward.unsupported_engine', engine: explicitId, message: `管家端点 ${explicitId} 不在 Provider 列表里,请到设置里改` };
    }
    const route = normalizeSessionEngineRoute({ engine: 'openai', providerId: explicitId, model: String(cfg.stewardModel || '').trim() || provider.model || '' });
    return route ? { ok: true, route } : { ok: false, error: 'steward.unsupported_engine', engine: explicitId, message: `管家端点 ${explicitId} 无法解析成 OpenAI 兼容路由` };
  }
  // 跟随主端点。CLI 引擎(Claude / Kimi)在本切片不支持:管家回合的事件流与工具协议要另接一套,
  // 属 116-2。fail-closed 返回稳定信封,而不是悄悄换成别的端点跑起来。
  const route = sessionEngineRouteFromConfig(cfg);
  if (!route || route.engine !== 'openai') {
    const engine = route ? (route.agentCliType || 'claude') : 'none';
    return { ok: false, error: 'steward.unsupported_engine', engine, message: `管家本版只支持 OpenAI 兼容端点,当前主端点是 ${engine};请在设置里为管家单独指定一个 OpenAI 兼容端点(stewardProviderId)` };
  }
  const model = String(cfg.stewardModel || '').trim();
  return { ok: true, route: model ? { ...route, model } : route };
}

// 懒创建管家会话。不用 createSession(它生成 sess_* 随机 id;管家要的是固定 id,见 06i 的注释),
// 但字段形状与 createSession 逐条对齐,以便所有既有会话原语(load/save/rewind/压缩)照常可用。
async function ensureStewardSession(config) {
  const resolved = stewardResolveRoute(config);
  if (!resolved.ok) return resolved;
  const existing = await loadSession(STEWARD_SESSION_ID).catch(() => null);
  if (existing && existing.id === STEWARD_SESSION_ID) {
    // 引擎/模型可能在设置里被改过 —— 每次唤醒对齐一次(会话头是路由的权威源,configForSessionEngineRoute
    // 读它)。kind 一旦被外部改坏就纠回来:身份判据全靠它。
    let dirty = false;
    if (existing.kind !== 'steward') { existing.kind = 'steward'; dirty = true; }
    if (JSON.stringify(existing.engineRoute || null) !== JSON.stringify(resolved.route)) { existing.engineRoute = resolved.route; dirty = true; }
    if (dirty) await saveSession(existing).catch(() => {});
    return { ok: true, session: existing, route: resolved.route };
  }
  const now = nowIso();
  const session = {
    id: STEWARD_SESSION_ID,
    schemaVersion: SESSION_SCHEMA,
    turnSeq: 0,
    title: STEWARD_SESSION_TITLE,
    summary: '',
    pinned: false,
    // cwd = 数据根:管家没有工作目录的概念(它不动文件),但回合机器要一个存在的目录做 workingDir。
    cwd: paths.data,
    createdAt: now,
    updatedAt: now,
    claudeSessionId: null,
    messages: [],
    providerHistory: [],
    providerHistoryCursor: 0,
    attachments: [],
    engineRoute: resolved.route,
    mission: null,
    missionId: STEWARD_SESSION_ID,
    kind: 'steward',                 // 身份:所有排除面按【这个原始值】判定
    permissionMode: STEWARD_PERMISSION_MODE, // 独立模式,不进 PERMISSION_MODES
  };
  await saveSession(session);
  logEvent({ kind: 'steward_session_created', sessionId: STEWARD_SESSION_ID, providerId: resolved.route.providerId, model: resolved.route.model });
  return { ok: true, session, route: resolved.route };
}
