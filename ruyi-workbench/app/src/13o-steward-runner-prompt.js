// ============================================================================
// 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家回合的提示词装配与输出契约解析。
//
// 落点(transport 层,manifest 中位于 13n-steward-arbiter.js 之后、13p-steward-runner-actions.js 之前)。
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
// ────────────────────────────────────────────────────────────────────────────
// 提示词装配(§11.2 分层):稳定层 = 06b steward.stable;易变层 = 记忆块 + 线程总览 + 尾句。
// ────────────────────────────────────────────────────────────────────────────

// 记忆块:直接用 116c 的门控工具实现(同一份读取与同一道门),按 kind 分组,整块 ≤3000 字符。
async function stewardMemoryBlock(session, config, pack) {
  let entries = [];
  try {
    const found = await StewardHooks.memorySearch({ limit: STEWARD_MEMORY_LIMITS.searchLimit }, { session, config });
    entries = (found && Array.isArray(found.entries)) ? found.entries : [];
  } catch { entries = []; }
  if (!entries.length) return pack.steward.memoryHeader + '\n' + pack.steward.memoryEmpty;
  const lines = [];
  for (const kind of STEWARD_MEMORY_KINDS) {
    const rows = entries.filter(e => e && e.kind === kind && e.state !== 'vetoed');
    for (const row of rows) {
      const source = row.sourceSessionId ? `来源 ${stewardSanitizeText(row.sourceSessionId)}` : '来源未记';
      // 126-M01(44 号文 §7 ④ 的拍板):管家**不在**任何一个项目里 —— 它是跨项目的看护者,
      // 所以这里【不按作用域过滤】,而是把项目条目**标出来**。把它们整个藏掉是信息损失;
      // 把它们当成到处成立才是今天的 bug。标出项目名,两头都不占。
      const scopeNote = stewardMemoryScopeLabel(row.scope, config);
      lines.push(`- [${kind}#${stewardSanitizeText(row.id)}] ${stewardSanitizeText(row.text)}(${source},用过 ${Math.max(0, Number(row.useCount) || 0)} 次${scopeNote})`);
    }
  }
  if (!lines.length) return pack.steward.memoryHeader + '\n' + pack.steward.memoryEmpty;
  const out = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > STEWARD_MEMORY_BLOCK_CHARS) break;
    out.push(line);
    used += line.length + 1;
  }
  return pack.steward.memoryHeader + '\n' + out.join('\n');
}

// 线程总览行的数据装配。事实源与 116c 的 steward_thread_status 完全相同(13e 投影 + 会话头 +
// 06i 的五态判据),只是按「一行一条」的口径取字段 —— 13g 不能复用本函数(那会是前向边),
// 故这里是同一批原语的第二个调用方,不是第二个事实源。
//   · lastSay 取会话头的 summary:那就是上一回合助手最终文本的前 160 字(09 收尾处写的),
//     不经模型改写,符合 §11.2「诚实:最后一句取原话」;
//   · 只列「未收工」或「24 小时内收工」的线程,管家会话自己永远不列。
async function stewardThreadDigestRows(config) {
  const index = await getPretenderProjectionIndex().catch(() => null);
  // 116g:事项标题只在【真有事项文件】时填。「未归类」事项(missionId === sessionId、无事项文件)的
  // 标题就是线程标题,填了等于把同一句话在总览行里重复一次(见下方 missionTitle 处的原注释)。
  // 按需读、按 missionId 记忆:总览一次最多读【出现过的事项】那么多个文件,不扫整个 missions 目录
  // (事项数上限 2000,全扫会让每次到访多出上千次文件读)。
  const missionTitles = new Map();
  const missionTitleOf = async missionId => {
    if (!missionTitles.has(missionId)) {
      const container = await readMissionContainer(missionId).catch(() => null);
      missionTitles.set(missionId, container ? container.title : '');
    }
    return missionTitles.get(missionId);
  };
  const rows = [];
  const now = Date.now();
  for (const slice of (index && Array.isArray(index.sessions) ? index.sessions : [])) {
    const sid = slice && safeSessionId(slice.sessionId);
    if (!sid || sid === STEWARD_SESSION_ID) continue;
    const head = await stewardReadSessionHead(sid);
    if (!head || !head.id) continue;
    const rawKind = stewardRawKind(head);
    if (rawKind === 'steward') continue;   // 排除面:按会话头【原始】 kind 判,不经 sessionKind()
    // 116-2e(§11.1 第 2 项):已收工的速查线程不占总览的注意力预算(判据单点在 13g 的
    // stewardQuickClosed,与 steward_threads_search 逐字同源;经 StewardHooks 调,同一条延迟绑定纪律)。
    if (typeof StewardHooks.quickClosed === 'function' && StewardHooks.quickClosed(head)) continue;
    const card = slice.card ? overlayMissionCard(slice) : null;
    const derived = card
      ? stewardThreadStateFromCard(card)
      : deriveStewardThreadState({
        // 116-3 P1-5:只有【管家自己用 steward_quick_ask 开的】速查线程才是 quick_ask。
        // 判据与 13g 的 threads_search / thread_status 同一个函数(13h -> 13g 是后向边),
        // 不再用「非 mission 即 quick_ask」那个把普通对话也一并打上标签的兜底。
        kind: stewardQuickThread(head) ? 'quick_ask' : 'mission',
        autoMode: head.mission && head.mission.autoMode,
        resultStatus: (head.mission && head.mission.result && head.mission.result.status) || '',
        activeTurn: activeChildren.has(sid),
        turnSeq: head.turnSeq,
        // 117p-S2:与 13g thread_status / 13d 事项聚合同一个喂法 —— 无账本判据只认
        // 「头上没有 mission 容器」,与卡片侧 card.status === 'none' 同义。
        ledgerless: !head.mission,
        lastTurnFailed: !!(head.stewardLastTurn && (head.stewardLastTurn.ok === false || head.stewardLastTurn.aborted === true)),
      });
    const updatedMs = Date.parse(String(head.updatedAt || ''));
    const settled = derived.state === 'done' || derived.state === 'stopped';
    const recent = Number.isFinite(updatedMs) && (now - updatedMs) <= 24 * 60 * 60 * 1000;
    if (settled && !recent) continue;      // 收工超过 24 小时的线程不占总览预算
    const lastRun = card && card.lastRun ? card.lastRun : null;
    const pendingCount = card && card.pending
      ? (Number(card.pending.permissions) || 0) + (Number(card.pending.questions) || 0) + (Number(card.pending.plans) || 0) + (Number(card.pending.pool) || 0)
      : 0;
    const usage = slice.usage || null;
    const costs = usage && usage.costsByCurrency ? Object.values(usage.costsByCurrency) : [];
    // 116h(§8.10「排队可解释」):总览行的等待原因也走 06i 的 waitReasonFor 单点 —— 管家在提示词里
    // 读到的那句话,与 steward_thread_status / 看板 / steward_missions 逐字相同。
    const wait = waitReasonFor({ pending: pendingCount }, stewardArbiterWait(sid));
    // 121-K3(§4.5):这条线程此刻有没有人坐着。判据单点在 13k 的 stewardSeatedByUser(工具门读的
    // 是同一份在场快照),这里只是把同一个事实带进提示词 —— 硬拦在工具层,软告知在总览行:
    // 光有硬拦,模型会反复去试然后反复被拒,一个回合的预算就烧在互相打架上。
    const seatedBy = stewardSeatedByUser(sid) ? 'user' : null;
    rows.push({
      sessionId: sid,
      seatedBy,
      // 116-pre(§8.12/§11.3):递话预判的 index 行要 missionId——3.0 里等于 sessionId(见下方注释),
      // 加在这里而不是 digest 里,因为 buildStewardDigestLine 的 lead 段只吃 id/missionTitle/title 三键,
      // 多一个 missionId 键对总览行的拼装零影响(新增只加不改)。
      missionId: sessionMissionId(head) || sid,
      // 116-5b(§11.8.5):这条线程的【显示名】(人起的 > 生成的 > 原话,判据单点在 02 的
      // sessionDisplayTitle)。与 missionId 同一条理由放在行的顶层而不是 digest 里:
      // buildStewardDigestLine 的 lead 段只吃 id/missionTitle/title 三键,多一个顶层键对总览行的
      // 拼装零影响。**digest.title 仍是原话** —— 管家读到的是用户当时怎么说的,那比一个名字信息更全;
      // 需要显示名的是壳层(「现在这一件」、递送候选),它们读这个字段。
      displayTitle: sessionDisplayTitle(head),
      updatedAt: String(head.updatedAt || ''),
      state: derived.state,
      wait,   // 116h:结构化形状(与另外三个展示面同形),给 117 壳层与旁路消费者读
      digest: {
        id: sid,
        seatedBy,   // 121-K3:buildStewardDigestLine 读它,拼出「你正坐在这条线程里」那一段
        // 事项标题:116g 起,归入了【真事项】(有事项文件)的线程在总览行里带上事项自己的标题,
        // 「未归类」线程仍恒为空 —— 那种情况下事项标题就是线程标题,写两遍等于把同一句话在总览里
        // 重复一次(buildStewardDigestLine 对空段整段跳过)。
        missionTitle: (await missionTitleOf(sessionMissionId(head) || sid)) || '',
        title: head.title || '',
        state: derived.state,
        action: activeChildren.has(sid) ? '回合进行中' : (lastRun ? `班组 ${lastRun.status || ''}` : ''),
        lastSay: head.summary || '',
        // 116h:人话取 waitReasonFor 的 label(pendingCount > 0 时逐字仍是「等你(N 条待决)」,
        // 与 116f 的原措辞一致;新增的是等锁/等预算/等并发位三种)。
        waitReason: wait ? wait.label : '',
        permissionMode: stewardThreadPermissionMode(head, config),
        cost: costs.length ? costs.reduce((a, b) => a + (Number(b) || 0), 0) : null,
      },
    });
  }
  // 排序:等你 > 进行中 > 其余,同档按最近更新在前(总览被裁时先保住最该看的那几条)。
  const rank = state => (state === 'needs_you' ? 0 : state === 'running' ? 1 : state === 'dispatching' ? 2 : 3);
  rows.sort((a, b) => rank(a.state) - rank(b.state) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return rows;
}

// ────────────────────────────────────────────────────────────────────────────
// 第 116 波 116-pre(27 号文 §8.12「递话：交给线程的交互」/ §11.1 第 3 项/ §11.3):递话预判端点。
//
// 装配纪律:index 的事实源与上面 stewardThreadDigestRows 完全相同(13e 投影 + 会话头 + 06i 五态判据),
// 本节【复用同一个函数】而不是另起一份 —— 116c 交付记录已经写明「13g 不能复用 13h 的函数(前向边)」,
// 但 preroute 端点本来就住在 13h 里,同文件内调用零边可言,是最省心的复用方式。
//
// 缓存(§11.3 交付物「按 13e 投影的 changeSeq 总和或最近会话 updatedAt 作为缓存键,命中则不重装配」):
// getPretenderProjectionIndex() 内部已经是增量维护的运行时缓存(source stamp 没变就不重扫会话),
// 它的整体 revision 已经是「本次投影所有 changeSeq 与卡片状态」的一个哈希摘要 —— 拿它当缓存键的一半,
// 比自己重新求和一遍 changeSeq 更省一次遍历。(116-5b 补上另一半 builtAt:revision 只覆盖【有卡片的】
// 会话,速查线程的会话头改了它不会变 —— 详见下面 stewardPrerouteIndexRows 里那段注释。)
// 命中时跳过的是【每会话一次 stewardReadSessionHead 文件读】那一段(§11.3 的目标 p50 ≤50ms 主要靠它)。
// 只在内存,不写盘;开关关时这段代码根本不会被调到(见路由分支)。
const _stewardPrerouteCache = { revision: '', rows: [] };
async function stewardPrerouteIndexRows(config) {
  const index = await getPretenderProjectionIndex().catch(() => null);
  // 116-5b:缓存键从「只看 revision」改成「revision + builtAt」。revision 只由【事项卡片】与待决行
  // 算出(见 13e finalizePretenderIndex:missionRows 过滤掉了 card 为 null 的会话),所以一条
  // 【速查线程】的会话头改了 —— 比如本波的摘要刚落盘 —— revision 一个字节都不会变,这里就会一直
  // 回一份旧行,递送候选列表于是永远显示那条速查线程的原话。而速查线程恰恰是本波最需要起名字的那种
  // (13g 建完显式清了 titleSource 就是为了让它拿到摘要)。builtAt 只在投影【真的重建过】时才变
  // (getPretenderProjectionIndex 没有脏会话时直接返回同一个对象),所以连续敲字那段快路径一次没丢,
  // 多出来的只是「投影确实重建了一次」时多装配一次行。ETag 那一侧完全不受影响:这是 13h 自己的
  // 进程内 memo 键,不是 revision 的定义。
  const revision = String((index && index.revision) || '') + '|' + String((index && index.builtAt) || '');
  if (index && revision === _stewardPrerouteCache.revision) return _stewardPrerouteCache.rows;
  const digestRows = await stewardThreadDigestRows(config);
  const rows = digestRows.map(row => ({
    sessionId: row.sessionId,
    missionId: row.missionId || row.sessionId,
    missionTitle: (row.digest && row.digest.missionTitle) || '',
    title: (row.digest && row.digest.title) || '',
    // 116-5b:显示名单独一个键。**不覆盖 title** —— prerouteText 的词法打分吃的就是 title,
    // 把它换成压过的名字等于把用户当时打的那些词从索引里抹掉(见 06i stewardPrerouteHit 处的原注释)。
    displayTitle: row.displayTitle || (row.digest && row.digest.title) || '',
    // 116-pre 交付物口径:「summary(lastAssistantText 或摘要,≤400 字)」——digest.lastSay 就是
    // head.summary(诚实纪律:原话,不经模型改写),这里只做 400 字截断,不重新中和(stewardSanitizeText
    // 在 prerouteText 内部拼 reason/title 时才需要,summary 只参与打分不进返回值)。
    summary: String((row.digest && row.digest.lastSay) || '').slice(0, 400),
    state: row.state,
    updatedAt: row.updatedAt,
  }));
  if (revision) { _stewardPrerouteCache.revision = revision; _stewardPrerouteCache.rows = rows; }
  return rows;
}

// StewardHooks.preroute 的实现(§11.3「把 preroute(q) 挂到 StewardHooks,117 与 116f 都可能用」)。
// config 可选:路由处已经 readConfig() 过,直接传进来省一次重读;其余调用方(117 壳层)不传时自己读一遍。
// 128h-J03:extra.focus —— 输入区右栏那条(现在这一件)。只进纯函数的 focusSessionId,不进提示词;不在索引里的 id 在纯函数里自然作废。
async function stewardPreroute(q, configArg, extra) {
  const config = (configArg && typeof configArg === 'object') ? configArg : await readConfig();
  const [index, memoryStore] = await Promise.all([
    stewardPrerouteIndexRows(config).catch(() => []),
    stewardReadMemoryStore().catch(() => ({ entries: [] })),
  ]);
  const nowMs = Date.now();
  const memory = (memoryStore.entries || [])
    .filter(e => e && e.state !== 'vetoed' && (e.kind === 'focus' || e.kind === 'habit'))
    // 107-M1:【过期条目不参与预判打分】。本函数是 stewardReadMemoryStore 的第二个读取口 ——
    // 44 号文 §1.2 当时写的「提示词块(13o)走的就是 13l 那一口,不必散到调用方」漏了它:上面的
    // stewardMemoryBlock 确实走 StewardHooks.memorySearch(已滤过期),但**本函数直接读库**,
    // 于是早该过期的 focus 会一直给某条线程 +memoryBonus(06i 的 stewardPrerouteScoreThread)。
    // 判据仍然只有一处:06d 的 memoryIsExpired —— 静态锁 ⑫ 明文禁止别处自己算
    // (dev-harness/steward-tools.static.e2e.js),⑫b 另外要求每个读取口都表态。
    // 同一个 nowMs 喂给整批:一次调用里两条条目不该用两个不同的「现在」。
    .filter(e => !memoryIsExpired(e, nowMs))
    // 107-M1【作用域:这里**故意**不按作用域过滤,不是漏改】。三条理由,来「修」它之前请先读:
    //   ① 管家不在任何一个项目里(126-M01 的拍板,见本文件 stewardMemoryBlock 处那段注释),
    //      而 preroute 连 cwd 都拿不到 —— 入参只有 q 与 config。要过滤就得凭空指定一个「当前
    //      项目」,而出厂 defaultWorkspace 就是主目录(见 stewardWorkspaceTableBlock 的头注),
    //      拿它当当前项目等于把几乎所有项目级记忆静默丢掉。
    //   ② 预判用记忆的方式与提示词块不同:它只把记忆文本当【词法针的来源】(06i 的
    //      stewardPrerouteMemoryHit 判的是「线程标题出现在记忆文本里」),不把记忆当成断言。
    //      项目 A 的记忆里提到某个标题,说明用户在意那件事;把这句话递给那条线程仍然是对的。
    //      而过期不同:「这两周在赶 A」两周后连「用户在意」都不成立了,所以那一条必须滤。
    //   ③ 真正更准的做法是「项目级记忆只给【同项目的线程】加分」,但那不是加一道过滤:索引行
    //      (stewardPrerouteIndexRows)今天不带 cwd,而打分在 06i,06i 够不着 13j 的
    //      stewardMemoryScopeMatches(前向边;静态锁 ⑬ 的头注记了同一个坑)。那是一刀设计改动,
    //      不在本刀内。steward-preroute.e2e 的 (F5) 把「项目级记忆照常加分」钉成了行为断言,
    //      哪天改主意要连它一起改。
    .map(e => ({ kind: e.kind, text: e.text }));
  const focus = safeSessionId(extra && extra.focus) || '';
  return prerouteText(q, index, memory, { focusSessionId: focus });
}

function stewardOverviewBlock(rows, pack) {
  // 尾句(「更多细节用 steward_thread_read,读取有预算」)在空总览时也要在:管家随时可能被问到
  // 一条刚建起来的线程,它必须知道深读这条路存在,而不是因为「上一秒没有线程」就以为没有工具可用。
  if (!rows.length) return [pack.steward.overviewHeader, pack.steward.overviewEmpty, pack.steward.overviewMore].join('\n');
  const lines = [];
  let used = 0;
  let folded = 0;
  for (const row of rows) {
    if (lines.length >= STEWARD_DIGEST_LIMITS.maxThreads) { folded += 1; continue; }
    // 117l D5:总览行的名字用【显示名】。修前这里是原话 title —— 用户机器上十几条还没起名的线程
    // 于是被管家一律叫成「New session」。**digest.title 本身不动**:preroute 的词法打分吃的就是它
    // (见 stewardPrerouteIndexRows 处的原注释),把索引里的原话换掉等于把用户当时打的词抹了。
    const line = buildStewardDigestLine({ ...row.digest, title: row.displayTitle || row.digest.title });
    if (used + line.length + 1 > STEWARD_DIGEST_LIMITS.totalChars) { folded += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  const out = [pack.steward.overviewHeader, ...lines];
  if (folded > 0) out.push(pack.steward.overviewFolded({ threads: folded }));
  out.push(pack.steward.overviewMore);
  return out.join('\n');
}

// 117w-W1 提交③(27 号文 §11.19.2):工作区候选表的【只读投影】。
//
// 为什么它必须存在:workspaces 在 06i 的 forbidden 清册里,管家从来读不到有哪些工作区,于是它从不
// 传 cwd,一切落到默认工作区 —— 而出厂 defaultWorkspace 就是主目录。用户看到的「同一个文件夹被
// 占着」是这么来的。提交① 装了门(表外一律拒),提交② 给了省略时的出路(派生),这一段给的是
// 「有得可选」:没有它,管家永远不知道表里有什么,门与出路都用不上。
//
// 为什么它只能是投影:看得见 ≠ 改得了。三个键(workspaces / stewardWorkspaceRoot / defaultWorkspace)
// 仍然全是 forbidden,steward_config_set 一个都改不了。两道闸不合成一道。
//
// 三条硬纪律(与 06b 那几行的头注同一份,谁改都要一起守):
//   ① 只投影【末段名 + note + 只读标】。全路径不进(围栏信息),更不许出现 allowOutsideWorkspace /
//      additionalDirectories 这类围栏字段 —— 管家看得见围栏开关就等于知道往哪推。
//   ② 数据源只有 config.workspaces。recentWorkspaces 【不进表】:打开过 ≠ 授权过。
//   ③ 预算与线程总览同一套写法:超出 STEWARD_WORKSPACE_TABLE_MAX 折叠成一句「另有 N 个未列出」,
//      不截断 —— 截断会让模型以为表就那么长,折叠句让它知道「还有,问用户要」。
//   ④「只读」标来自 write === false(§11.19.7 裁决:校验层先不拒,但要让管家看得见,免得它把
//      写活派进一个只能读的文件夹)。判据写死 `=== false`:缺字段的老配置默认可写,不能反过来。
function stewardWorkspaceTableBlock(stewardWorkspaceRows, pack) {
  const rows = Array.isArray(stewardWorkspaceRows) ? stewardWorkspaceRows : [];
  const lines = [];
  let folded = 0;
  for (const row of rows) {
    const raw = String((row && row.path) || '').trim();
    if (!raw) continue;
    if (lines.length >= STEWARD_WORKSPACE_TABLE_MAX) { folded += 1; continue; }
    // 末段名:先剥尾部斜杠(`C:\work\` 的 basename 是 'work',但 `C:\` 的是空)—— 剥完为空就退回
    // 原样(盘符根这类没有末段名的路径,写 `C:\` 比写空字符串诚实)。
    const name = path.basename(raw.replace(/[\\/]+$/, '')) || raw;
    lines.push(pack.steward.workspaceRow({
      name: stewardSanitizeText(name),
      note: stewardSanitizeText((row && row.note) || ''),
      readOnly: !!(row && row.write === false),
    }));
  }
  const out = [pack.steward.workspaceHeader, ...(lines.length ? lines : [pack.steward.workspaceEmpty])];
  if (folded > 0) out.push(pack.steward.workspaceFolded({ workspaces: folded }));
  out.push(pack.steward.workspaceMore);
  return out.join('\n');
}

// 09 的提示词分叉入口(经 StewardHooks.buildSystemPrompt 调)。返回 {stable, volatile}:
// stable 进 system(版本级常量,前缀缓存完整命中),volatile 进第一条 user 消息前缀(与普通会话
// 的 turnVolatile 同一投放位置),易变内容后置。
async function buildStewardSystemPrompt(session, config, ctx) {
  const pack = getPromptPack(config && config.locale);
  const parts = [];
  // 117l:本波三条纪律(见 06b 的 rules 头注:英文稳定层已到 2453/2500,塞不下)。恒在,零条件。
  parts.push(pack.steward.rules);
  // 117l D1:输入区预判只是【提示】。它随这一回合的用户消息一起来(POST /api/steward/message 的
  // routeHint),挂在回合登记项上 —— 管家并发恒为 1,故「当前在途的那个 entry」就是本回合,不会串。
  // 无 hint 时这一段整段不输出:老载荷逐字节零变化(prompt-snapshot 据此只看 steward 段)。
  const hint = stewardRunnerRuntime.inflight && stewardRunnerRuntime.inflight.routeHint;
  if (hint && Array.isArray(hint.rows) && hint.rows.length) parts.push(pack.steward.routeHintBlock({ rows: hint.rows }));
  try { parts.push(await stewardMemoryBlock(session, config, pack)); } catch { /* 记忆是旁路增强,缺了照常开工 */ }
  // 117w-W1 提交③:工作区候选表。与总览【同一投放位置】(易变层,拼在第一条 user 消息前缀里),
  // 排在总览之前 —— 它是「你能把活派到哪」,总览是「活现在在哪」,选目录这一步在看进度之前。
  // 纯同步、纯投影,数据就是刚读到的 config.workspaces,不发一次 IO。
  try { parts.push(stewardWorkspaceTableBlock(config && config.workspaces, pack)); } catch { /* 同上 */ }
  try { parts.push(stewardOverviewBlock(await stewardThreadDigestRows(config), pack)); } catch { /* 同上 */ }
  return { stable: pack.steward.stable, volatile: parts.filter(Boolean).join('\n\n') };
}

// 10 的预算分叉入口(经 StewardHooks.contextBudget 调)。§11.2:预算 = min(stewardContextBudgetTokens,
// 该模型 conversationWindow);到 60% 触发既有 L2。返回的是【触发线】,maybeAutoCompact 直接拿它比。
function stewardContextBudget(session, config, window) {
  const configured = Math.max(1, Math.round(Number(config && config.stewardContextBudgetTokens) || 200000));
  const modelWindow = Math.max(0, Math.round(Number(window) || 0));
  const cap = modelWindow > 0 ? Math.min(configured, modelWindow) : configured;
  return Math.max(1, Math.round(cap * 0.6));
}
function stewardVisitNotesPrompt(config) {
  return getPromptPack(config && config.locale).steward.visitNotes;
}

// ────────────────────────────────────────────────────────────────────────────
// 输出契约解析(§11.3 116f 行)。复用 08 的 json-repair(parseStructuredAgentOutput:多候选 + 两级
// 解析,合法 JSON 永远走原文 parse 分支)。解析失败不是错误:say 取原文、acts/actions 空、记一条
// logEvent —— 模型没按契约说话时,把它的话原样端给用户,好过丢掉。
// ────────────────────────────────────────────────────────────────────────────
// 107-S1 ④(46 号文 §5 ⑦b H1):confirm 族的值渲染。两道掩码,一个都不能少:
//   ① tier === 'forbidden' 的键(06i 那道 apiKey|token|secret|password 兜底正则命中的全在内)
//      连值都不渲染,直接出 `••••` —— 这一族的值恒被 steward_config_set 整份拒绝,把它打在按钮上
//      没有任何收益,却多一处明文下发面;
//   ② 其余值过一次 04 的 redact(与 B1 立的「命令原文先 redact」同一张表、同一个单点),再裁 40 字。
// 【永不把密钥写进标签】:标签会进对话流 DOM、行动流水与落盘回执三处,那是三份长期留存的明文面。
const STEWARD_ACT_CONFIRM_MASK = '••••';
function stewardActConfirmValueText(item) {
  if (item && item.tier === 'forbidden') return STEWARD_ACT_CONFIRM_MASK;
  const value = item ? item.value : undefined;
  let text;
  if (value === undefined) text = '(没给值)';
  else if (typeof value === 'string') text = value;
  else { try { text = JSON.stringify(value); } catch { text = String(value); } }
  const shown = redact(stewardSanitizeText(text)).slice(0, STEWARD_ACT_CONFIRM_VALUE_CHARS).trim();
  return shown || '(空)';
}
// 确认面板逐条要显示的纯文本行(前端只负责 textContent,不拼字、不解析)。
function stewardActConfirmLines(spec) {
  const items = (spec && Array.isArray(spec.items)) ? spec.items : [];
  return items.map(item => `${stewardSanitizeText(item && item.key)} = ${stewardActConfirmValueText(item)}`);
}
function stewardActLabel(tool, args) {
  const a = (args && typeof args === 'object') ? args : {};
  if (tool === 'steward_decide') {
    const action = String(a.action || '');
    return (STEWARD_DECIDE_LABELS[action] || action || '决定').slice(0, STEWARD_ACT_LABEL_MAX);
  }
  if (tool === 'steward_run_action') {
    const action = String(a.action || '');
    return (STEWARD_RUN_ACTION_LABELS[action] || action || '执行').slice(0, STEWARD_ACT_LABEL_MAX);
  }
  // 117z-E2b 提交①(27 号文 §11.21.7 债 ①):线程权限也按 args 给人话 —— 与 decide / run_action 同一条
  // 理由(按【动作】不按工具名,且降级成按钮与行动流水用的是同一个函数,一处口径)。会降级成按钮的
  // 只有 capabilities.desktop === true 那一支(13k 恒 propose_required),按钮上写用户要做的那件事:
  // 「给它开桌面」;其余(收紧档位 / 关桌面)不出按钮,回落到 STEWARD_TOOL_LABELS 的总称「改线程权限」。
  if (tool === 'steward_thread_permission') {
    const permCaps = (a.capabilities && typeof a.capabilities === 'object' && !Array.isArray(a.capabilities)) ? a.capabilities : null;
    // 这一支本来就是服务端按 args 派生的、且已经写清了用户要做的那件事,107-S1 ④ 一个字不改
    // (steward-guardrails Q2c/Q2d 逐字钉着它);它要补的只是确认清单,见 stewardNormalizeAct。
    if (permCaps && permCaps.desktop === true) return '给它开桌面'.slice(0, STEWARD_ACT_LABEL_MAX);
  }
  // 107-S1 ④:改设置 / 改技能这两支的标签必须写清【要改哪个键、改成什么】——「改设置」三个字
  // 谁也看不出按下去会注册一个任意 stdio MCP 命令。键与值由 06i 的 stewardActConfirmSpec 从
  // args 派生(config_set 的判据就是那张 confirm 分档表),不读模型写的任何一个字。
  {
    const confirmSpec = stewardActConfirmSpec(tool, args);
    if (confirmSpec && (tool === 'steward_config_set' || tool === 'steward_skill_toggle')) {
      const base = STEWARD_TOOL_LABELS[tool] || '去做';
      const first = confirmSpec.items.find(item => item.key === confirmSpec.keys[0]) || confirmSpec.items[0] || null;
      const more = confirmSpec.items.length > 1 ? ` 等 ${confirmSpec.items.length} 项` : '';
      if (first) return `${base}:${stewardSanitizeText(first.key)}=${stewardActConfirmValueText(first)}${more}`.slice(0, STEWARD_ACT_CONFIRM_LABEL_MAX);
    }
  }
  return (STEWARD_TOOL_LABELS[tool] || '去做').slice(0, STEWARD_ACT_LABEL_MAX);
}

function stewardNormalizeAct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tool = String(raw.tool || '');
  const kindRaw = String(raw.kind || '');
  const kind = (kindRaw === 'tool' || kindRaw === 'open_thread' || kindRaw === 'dismiss')
    ? kindRaw
    : (tool ? 'tool' : 'dismiss');
  if (kind === 'tool' && !isStewardToolName(tool)) return null;  // 只认 steward_*(动世界的工具永远进不来)
  // 107-S1 ④(46 号文 §5 ⑦b H1):**confirm 档的按钮不许由模型命名**。修前这一行 label 优先用
  // `raw.label` —— 模型写「好,我知道了」,args 里是 steward_config_set{externalMcpServers:[…]},
  // 用户按下去就是用户「亲手按了」(13q 据此置那一位),而 args 一个字都没被校验过。
  // 于是这一族:① 丢掉模型的标签,恒用服务端按 args 派生的说明(写清键与新值);
  //             ② 把整份清单随 act 带给前端(confirmItems,纯文本),前端 POST 之前弹确认面板逐条列出。
  // 其余 act 一个字节不变(仍然是模型标签优先)——「知道了」这种表态按钮没有二次确认的必要。
  const confirmSpec = kind === 'tool' ? stewardActConfirmSpec(tool, raw.args) : null;
  const label = confirmSpec
    ? stewardActLabel(tool, raw.args)
    : (stewardSanitizeText(raw.label).slice(0, STEWARD_ACT_LABEL_MAX)
      || (kind === 'tool' ? stewardActLabel(tool, raw.args) : (kind === 'open_thread' ? '打开' : '知道了')));
  const act = { label, kind };
  if (kind === 'tool') {
    act.tool = tool;
    act.args = (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) ? raw.args : {};
    if (confirmSpec) act.confirmItems = stewardActConfirmLines(confirmSpec);
  }
  const sessionId = raw.sessionId ? safeSessionId(raw.sessionId) : '';
  if (sessionId) act.sessionId = sessionId;
  if (raw.primary === true) act.primary = true;
  return act;
}

// acts 归一:≤3 个、主动作只有一个(第一个 primary 胜出,其余降为安静按钮)。
function stewardNormalizeActs(list) {
  const out = [];
  let primaryTaken = false;
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (out.length >= STEWARD_ACTS_MAX) break;
    const act = stewardNormalizeAct(raw);
    if (!act) continue;
    if (act.primary) {
      if (primaryTaken) delete act.primary;
      else primaryTaken = true;
    }
    out.push(act);
  }
  return out;
}

function stewardParseReply(text) {
  const raw = String(text == null ? '' : text);
  const parsed = parseStructuredAgentOutput(raw);
  const value = parsed && parsed.ok ? parsed.value : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    logEvent({ kind: 'steward_contract_unparsed', chars: raw.length });
    // 117y-S1(§11.18.2):这条兜底灌进来的是【整份原始模型输出】,所以它比解析成功那一路更需要
    // 天花板;但同样【不许裸切】—— 与下面 say 那一处走的是同一个函数、同一个天花板,不许只改一处。
    return { parsed: false, say: stewardTrimSayAtSentence(raw.trim(), STEWARD_SAY_CEILING), why: '', acts: [], actions: [], contractIncomplete: false, contractKeys: [] };
  }
  // 123-P1 ①(38 号文;用户 2026-09-14 真机取证):**契约完整性**。
  // 现象:用户对管家说「下周一整周大A该怎么操作」,管家回「我把你这句话原样递给『下周A股走势分析』
  // 那条线程了」「按钮就在这条消息下面,点『打开线程』」—— 界面上没有任何按钮,线程也从没收到那句话。
  // 病根:真机 sessions/steward.provider.ndjson 里模型的原始输出【只有 say 一个键】,七轮无一例外
  // (stewardProviderId=deepseek / stewardModel=deepseek-v4-flash 这个快档);落盘的七条 assistant
  // 消息 acts=0 actions=0 parsed=true。模型一个工具都没调,却在 say 里把动作说成已完成 —— 违反
  // 06b 稳定层纪律 6「不编造进度、不把没做的事说成做了」,而系统这一侧此前【完全没有兜底】。
  // 判据【不猜 say 的文本】:关键词匹配「已经递了/按钮在下面」这类完成时陈述既脆弱又要维护中英
  // 词表;契约完整性是机器可判的硬事实 —— 06b 的输出契约把 why 写成必填的「依据一句话」,连这个
  // 键都没给就是没按契约输出。
  // **只看键在不在,不看值空不空**:`why:''` 是「按契约给了这个键、这一轮没依据可写」(既有剧本
  // 与线上老回合大量这么写),缺键才是「压根没按契约走」。
  // **acts / actions 一律不当判据**:纯答问回合本来就不需要它们,拿空当判据等于给每一句寒暄都盖
  // 一个红戳。
  const contractIncomplete = !Object.prototype.hasOwnProperty.call(value, 'why');
  const actions = [];
  for (const item of (Array.isArray(value.actions) ? value.actions : [])) {
    if (!item || typeof item !== 'object') continue;
    const tool = String(item.tool || '');
    if (!isStewardToolName(tool)) continue;
    actions.push({ tool, args: (item.args && typeof item.args === 'object' && !Array.isArray(item.args)) ? item.args : {} });
    if (actions.length >= STEWARD_ACTIONS_MAX) break;
  }
  return {
    parsed: true,
    // 117y-S1(§11.18.2):修前这里是按那个 600 的常量直接裸 slice —— 601 字的回复在第 600 字处
    // 无声断掉,可能断在半个句子、半个词中间。现在 600 只是提示词目标(STEWARD_SAY_TARGET),
    // 运行期只剩 4000 的病态载荷天花板,且触顶也在句末标点处切并明说。
    say: stewardTrimSayAtSentence(value.say, STEWARD_SAY_CEILING),
    why: String(value.why == null ? '' : value.why).slice(0, STEWARD_WHY_MAX),
    acts: stewardNormalizeActs(value.acts),
    actions,
    contractIncomplete,
    // 审计要写的是「模型到底给了哪些键」,不是「我们最后解析出了什么」—— 所以取【原始对象】的
    // 顶层键。8 个封顶:病态输出(几十个键)不该把一行审计撑成一屏。
    contractKeys: Object.keys(value).slice(0, 8),
  };
}
