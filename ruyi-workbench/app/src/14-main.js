async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const command = argv._[0] || 'serve';
  if (command === 'serve') {
    const served = await startServer(argv);
    // 第116波116b(27号文§11.3): 服务就绪(已 listen、runtime.json 已落)之后才起管家收件箱轮询。
    // stewardEnabledV1 !== true 时 startStewardInbox 立即返回,不建目录、不起 interval、零写入。
    // 失败绝不阻断已经开起来的服务(管家是旁路,不是主链路)。
    await startStewardInbox(await readConfig()).catch(() => {});
    return served;
  }
  if (command === 'mcp') return startMcp();
  if (command === 'install') return installIntegration();
  if (command === 'doctor') return doctor(argv); // 118b: --human 走人话体检,默认仍只打 JSON
  if (command === 'mcp-config') {
    console.log(await generateMcpConfig());
    return;
  }
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

// Run the CLI only when executed directly; when require()'d (e.g. by an offline self-test) just export
// the internals so tests can exercise McpStdioClient / detectDesktopMcp without spawning a full server.
if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message || String(err));
    // Startup can create watchers/timers before listen() discovers a non-Ruyi port occupant. Merely setting
    // exitCode leaves those handles alive and makes the failed CLI look hung; a direct invocation must fail fast.
    process.exit(1);
  });
}

module.exports = {
  McpStdioClient,
  McpHttpClient, // 49c: 远程 MCP transport(sse/streamable-http) — exposed for e2e 直连契约断言。
  estimateHistoryTokens, // v0.8-S5: exposed for e2e direct unit testing (parts-aware token estimate v2)
  // 第45波(压缩 v2):摘要内核 + 45a 预算适配/map-reduce 分组 — exposed for e2e(死锁角回归)。
  providerSummaryCall,
  validateStructuredSummary,
  fitHistoryForSummary,
  chunkHistoryByBudget,
  recentTurnsBoundary,
  CompactionPlan,
  // 126-111a: L1 蒸发与它的两个新原语 — exposed for e2e 白盒契约(开关关时逐字节等价老边界、
  // 开关开时按 token 预算护住尾部、边界永不落在 tool 上)。
  evaporateHistory,
  evaporateBudgetBoundary,
  historyUnitStarts,
  evaporateBudgetBoundaryEnabled,
  // 126-111e: 历史内重复读取去重 — exposed for e2e 白盒契约(键零误报/最新一次留全文/幂等)。
  dedupeRepeatedReads,
  fileReadDedupKey,
  historyReadDedupEnabled,
  // 126-111d: 摘要 prompt 双语 — exposed for e2e(开关判定/语言选择/标题容错)。
  summaryPromptI18nEnabled,
  summaryPromptWithGuidance,
  // 126-111b/111c: L2 尾部按单元保留 ＋ 重附最近读过的文件 — exposed for e2e 白盒契约。
  reseedTailUnitsEnabled,
  recentFileReads,
  reseedReattachFilesEnabled,
  COMPACT_RESEED_TAIL_MAX_TOKENS,
  resolveCompactionProvider,
  // 105b: session-notes.md 状态外置 — exposed for e2e 白盒契约(确定性切节/写读回环/显式关闭门)。
  sessionNotesEnabled,
  extractSessionNotes,
  renderSessionNotesMarkdown,
  sessionNotesPath,
  writeSessionNotes,
  readSessionNotes,
  maybeWriteSessionNotes,
  // 105d: session notes 回注 + 增量合并 — exposed for e2e 白盒契约(开关判定/有界 prompt/解析/合并)。
  sessionNotesInjectEnabled,
  sessionNotesMergeEnabled,
  buildSessionNotesInjectPrompt,
  parseSessionNotesMarkdown,
  mergeSessionNotes,
  historyStartsWithCompactionSummary,
  appendPromptToLastUserMessage,
  // 105c: 摘要实体确定性抽检 — exposed for e2e 白盒契约(抽取/检查/开关唯一判定点)。
  summaryEntityCheckEnabled,
  extractSummaryEntities,
  checkSummaryEntities,
  // 105e: 估算因子分桶 — exposed for e2e 白盒契约(开关唯一判定点/镜像 setter/三桶分类器)。
  estimateBucketsEnabled,
  setEstimateBucketsV1,
  classifyTextForEstimate,
  // 105f: 摘要单发优先 — exposed for e2e 白盒契约(开关唯一判定点/上限解析/reserve 预算)。
  summarySingleShotEnabled,
  summarySingleShotCap,
  summarySingleShotReserveTokens,
  resolveSummaryCallPolicy,
  applySummaryCallPolicy,
  // 105g(4.3 首项): map-reduce 全局事实表 — exposed for e2e 白盒契约(开关唯一判定点/注入消息构建)。
  summaryFactTableEnabled,
  summaryFactTableCap,
  buildSummaryFactTableMessages,
  // 105h(4.3 第二项): <=4 块顺序 refine — exposed for e2e 白盒契约。
  summaryRefineEnabled,
  buildSummaryRefineMessages,
  // 105i: map-reduce 有界并发 + fail-fast 取消 — exposed for e2e 白盒契约(上限解析/并发助手)。
  summaryMaxConcurrent,
  mapSummaryWithLimit,
  // 106 #13a/13a-t: 预算保护基础层 + 长命令时间预算 — exposed for e2e 白盒契约(开关唯一判定点/阈值解析)。
  budgetGuardEnabled,
  budgetGuardTurnTokens,
  budgetGuardWarnRatio,
  budgetGuardDecision,
  toolTimeBudgetEnabled,
  toolTimeBudgetShadowEnabled,
  toolTimeBudgetWarnMs,
  toolTimeBudgetHardMs,
  toolByteBudgetShadowBytes,
  // 106 #1 G1/G2: 前缀缓存布局开关 — exposed for e2e 白盒契约(开关唯一判定点)。
  volatileTailLayoutEnabled,
  appendOnlyToolSchemasEnabled,
  execResultCacheEnabled,
  execResultCacheMaxEntries,
  contextWindowOverrideKey,
  configuredConversationWindow,
  providerConversationContextWindow,
  agentConversationContextMeta,
  compactHistoryFromSession,
  parseKimiWireCompaction,
  parseKimiWireAgentEvents,
  isKimiAcpPlanFilePath,
  resolveKimiAcpPlanFilePath,
  kimiAcpSessionRestoreMethods,
  kimiAcpUnknownSessionError,
  kimiAcpModeOptionFromActivated,
  kimiAcpFreshActualForOperation,
  kimiAcpInferConcreteToolInput,
  kimiAcpToolTier,
  consumeKimiAcpApproval,
  kimiAcpToolUpdateSucceeded,
  kimiAcpSuccessfulEnterPlanMode,
  kimiAcpNativeShellQuote,
  kimiAcpNativeWindowsPathToPosixPath,
  kimiAcpNativeBashWrapperTexts,
  kimiAcpNativeBashWrapperCandidate,
  kimiAcpPermissionToolCall,
  kimiAcpConcreteEditGuard,
  prepareKimiAcpSpawn,
  createTurnSegmentBuilder,
  watchKimiWire,
  kimiSessionStatus,
  runKimiCompact,
  compactKimiNative,
  readKimiWireRuntime,
  stopKimiServer,
  // 20-T1/20-C1/20-F1 runtime optimization pure primitives. Exported for offline replay/e2e; the master
  // shadow switch only measures candidates, while production behavior remains behind strict active flags.
  searchToolCatalog,
  compareToolRetrievalShadow,
  reduceObservationContent,
  buildObservationRecallPrompt,
  measureObservationReductionShadow,
  rehydrateObservation,
  classifyRuntimeToolFailure,
  // 第45波 45b/45d:context-400 判定 + 估算自校准/窗口学习 — exposed for e2e(校准 EMA/只降不升/超窗重试)。
  isContextOverflowError,
  noteEstimateSample,
  estimateFactor,
  noteWindowOvershoot,
  learnedWindowCap,
  calibratedEstimate,
  // v1.0.2-S2: context-window three-level resolution — exposed for e2e direct units.
  resolveContextWindow,
  providerContextWindow,
  contextWindowFromTable,
  extractContextLength,
  fetchOpenAiModels,
  MODEL_CONTEXT_TABLE,
  CONTEXT_WINDOW_FALLBACK,
  VisualPipeline,
  DesktopShell,
  // v2.6.2 压缩标记合并 + token 读数 — exposed for e2e direct units(合并/门槛/滞回/尾零回归)。
  fmtTokensServer,
  openCompactMarker,
  upsertCompactMarker,
  COMPACT_MARKER_MIN_SAVED_TOKENS,
  detectDesktopMcp,
  pickPython,
  desktopPythonCandidates,
  desktopMcpFromInstalledRoot,
  // 39 号文:异步孪生与预热闸门 — 单测直接拿它们量「探针不占事件循环」与「预热之后同步那支零探针」。
  detectDesktopMcpAsync,
  pickPythonAsync,
  ensureDesktopMcpWarm,
  resolveExternalMcpServers,
  safeMcpInventory,
  configureMcpFromTool,
  buildBrowserAutomationHint,
  buildToolCustomizationHint,
  // v1.1-W2 (T2): MCP drop-in scan — exposed for mcp-config e2e (invalidate cache after fixturing folders).
  scanMcpDropIns,
  invalidateMcpDropInCache,
  collectBridgedTools,
  adaptiveCatalogForMcp, // 105a: exposed for e2e 直测(observation_recall 目录门)
  resolveBridge, // v1.4.1: bridged-name prefix-tolerant routing (models that drop the serverId__ prefix)
  // 第55波 EC-C(55a): MCP 运维闭环 -- 统一读模型 + 健康探针 + 错误归类 + 兼容矩阵 - exposed for e2e 直测。
  MCP_COMPAT_MATRIX,
  classifyMcpError,
  probeMcpConnector,
  buildMcpConnectorInventory,
  safeUrlForDisplay, // 55a:远程 URL 展示脱敏 - exposed for e2e 直测
  killAllMcpClients, // 55a:e2e 直测探针后清理 spawn 的 fake-mcp 子进程(避免 unref 子进程泄漏)
  normalizeConfig,
  AGENT_CLI_TYPES,
  selectedAgentCli,
  detectKimiPath,
  probeAgentCliLauncher,
  prepareAgentCliSpawn,
  invalidateAgentCliPathCaches,
  syncMcpServersToKimi,
  parseAgentCliEvent,
  providerReasoningEffort,
  applyProviderReasoningEffort,
  buildClaudeCliEnv,
  decodeClaudeCliText,
  // cmd8191 防线 — exposed for e2e unit assertions (长度核算与 batchSafeSpawn 同构性、围栏安全截断、降级阶梯)。
  quoteWinArg,
  batchSafeSpawn,
  spawnCmdLineLength,
  cmdLineBudgetFor,
  resolveClaudeLauncher, // P1: npm shim → 真身 claude.exe 解析 — exposed for e2e unit assertions
  // v1.9 数据管家 — exposed for e2e direct unit assertions(保留策略归一/统计/sweep/归档读取回退)。
  normalizeStoragePolicy,
  collectStorageStats,
  storageSweep,
  readAgentRunEvents,
  // 第40波:boot 恢复并发化 + syncRunEventSeq 尾窗化 — exposed for e2e(尾窗/全读回落/池语义直测)。
  syncRunEventSeq,
  mapPool,
  autoResumeInterruptedRuns,
  markInterruptedAgentRuns,
  // 第40波:性能观测面 — exposed for e2e(路径归一化/直方图分桶/趋势节流直测)。
  recordRequestMetric,
  normalizeMetricsPath,
  maybeRecordStorageTrend,
  readStorageTrend,
  buildMetricsPayload,
  // v1.9 会话存储 v2 + 引擎转录 GC — exposed for e2e(迁移/快路径/撕裂容忍/白名单账本/保留期清理)。
  loadSession,
  createSession,
  updateSessionMeta,
  sessionMeta, // 116-2a: 侧栏/索引同源的元数据读形(含会话级 permissionMode 与派生 effectivePermissionMode)
  normalizeSessionEngineRoute,
  sessionEngineRouteFromConfig,
  inferSessionEngineRoute,
  configForSessionEngineRoute,
  saveSession,
  deleteSession,
  listSessions,
  // 第75c波:可重建 Mission/Intervention 索引与无损 journal 压缩原语。
  getPretenderProjectionIndex,
  warmPretenderProjectionIndex,
  pretenderIndexPath,
  compactInterventionJournal,
  readInterventionsWithMeta,
  missionChangeFilePath,
  foldMissionChangeJournalText,
  readMissionChangesWithMeta,
  bumpMissionChangeSeq,
  sessionBodyPaths,
  // 117q-B6(30 号文 P2-10/P2-11):尾窗读原语 + 撕裂尾修复合一 — exposed for e2e 字节级直测
  // (造真撕裂尾文件、跑修复、断言截断后字节逐字节等于预期;不经 HTTP,直接函数调用可控)。
  readFileTail,
  repairMissionChangeTornTail,
  recordEngineTranscript,
  claudeProjectsRoot,
  claudeProjectDirKey,
  fenceSafeSlice,
  shrinkFencedSection,
  clampAppendWithSkills,
  normalizeAgentRole,
  getAgentRoleLibrary,
  readProjectAgentRoles,
  readClaudeProjectAgentRoles,
  saveProjectAgentRoles,
  buildClaudeAgentDefinitions,
  classifyClaudeSubagentFailure, // cmd8191: 「命令行太长。」→ definitive 签名 — exposed for e2e unit assertions
  parseClaudeTaskNotification,
  nativeClaudeAgentResultInfo,
  BUILTIN_AGENT_ROLES,
  normalizeSession,
  isUntitledSessionTitle, // 50-fix: 未命名标题判定(双引擎自动命名共用) — exposed for e2e
  // 第 116 波 116-5a(27 号文 §11.8「线程自动摘要」):线程的名字与一句概括。
  //   sessionDisplayTitle —— 「这条线程该显示什么名字」的唯一判据(人起的 > 生成的 > 原话),
  //     服务端一处装配、多处消费,前端不许各算一遍;
  //   maybeWriteThreadBrief / parseThreadBrief —— exposed for e2e 与单测直测(生成与解析各自可判定)。
  sessionDisplayTitle,
  // 117j 收尾:会话头的【带瞬时重试】读取。Windows 的 rename 替换会开一个 ENOENT 窗口,
  // 单发 readFile 会把「正在被原子替换」误判成「不存在」。exposed for unit/session-head-read.test.js。
  readSessionHeadResilient,
  maybeWriteThreadBrief,
  parseThreadBrief,
  detectDanglingTurn,
  repairProviderHistoryPairing, // 配对铁律自愈(孤儿 tool_calls 补合成 tool 回复) — exposed for e2e 直测
  repairProviderHistoryToolArgs, // 参数铁律自愈(arguments 不是 JSON 对象 -> 改写成实际执行用的 '{}') — exposed for e2e 直测
  bridgedToolTier,
  cwdWarning,
  defaultConfig,
  DurableJsonStore,
  sanitizeExternalMcpServer,
  // 启动时把本机 Claude Code(~/.claude.json)的 MCP 自动映射进 Ruyi(e2e 直测:幂等/上限/dismissed 跳过)。
  autoImportClaudeCodeMcp,
  // 48c: MCP 配置导入器解析器(e2e 直测 TOML/JSON 边角)。
  parseMcpConfigFile,
  scanMcpSources,
  // v0.8-S6: capability matrix + layered prompt + error枚举 (exposed for e2e + UI).
  getCapabilities,
  invalidateCapabilityCache,
  peekCapabilities, // 108b-fix2:非阻塞能力缓存读取(不触发探测)
  buildProviderSystemPrompt,
  PROMPT_PACK_VERSION, // 52d: 提示词包版本(语义化版本检查)
  getPromptPack, // 116f: 提示词包选择器(locale 感知) — exposed for 静态锁直读 steward 段的分层预算
  buildStableSystemPrompt, // 51d C1a:稳定层(prefix-cache 友好)
  buildRuntimeIdentityFacts, // 108a:运行时身份事实(进程内恒定量,e2e 直测)
  buildVolatileParts, // 51d C1a:易变层(C1b 移 user 侧)
  buildPlaybookIndexSection, // 108b:Playbook 精简索引段(e2e 直测围栏/上限/尾行)
  buildResponseLanguagePolicy,
  buildAgentTeamHint,
  buildClaudeNativeAgentPolicy,
  softwareEngineeringTaskProfile,
  buildPromptTaskContext,
  buildSoftwareEngineeringPolicy,
  planDiscoveryToolBatchAllowed,
  appendTurnPolicies,
  appendResponseLanguagePolicy,
  isLongToolTask,
  resolveToolIterationBudget,
  shouldExtendToolIterationBudget,
  TOOL_ITERATION_BUDGETS,
  buildOpenAiTools,
  AGENT_LOOP_HOOK_PHASES: AgentLoopHooks.AGENT_LOOP_HOOK_PHASES,
  registerAgentLoopHook: AgentLoopHooks.registerAgentLoopHook,
  unregisterAgentLoopHook: AgentLoopHooks.unregisterAgentLoopHook,
  listAgentLoopHooks: AgentLoopHooks.listAgentLoopHooks,
  dispatchAgentLoopHooks: AgentLoopHooks.dispatchAgentLoopHooks,
  makeAgentLoopTraceId: AgentLoopHooks.makeAgentLoopTraceId,
  summarizeAgentLoopToolResult: AgentLoopHooks.summarizeAgentLoopToolResult,
  // 第116波116a(27号文§11.3): 管家(Steward)引擎侧纯函数与延迟绑定命名空间 — exposed for e2e/单测。
  StewardHooks,
  STEWARD_EVENT_KINDS,
  STEWARD_DIGEST_LIMITS,
  stewardMayAct,
  // 125-P0/P1:被停下来的目标判据(06i)与失败类别的取话口(13m)—— exposed for 单测
  //   (unit/steward-inbox-core.test.js 直测两者的真值表与「未知类别」诚实回退)。
  stewardStoppedTarget,
  stewardFailureExplain,
  buildStewardDigestLine,
  // 第117波117y-S1(27号文§11.18.2): 管家正文的天花板裁剪(句界 + 诚实标记)与它【绝不能被误伤】的
  // 那个同名邻居 stewardClipSay(总览行/待决一行话的 200 字 + 省略号)—— 两个都 exposed for
  // unit/steward-core.test.js:一个正测句界裁剪,一个做反向保护断言。
  stewardTrimSayAtSentence,
  stewardClipSay,
  STEWARD_SAY_TARGET,
  STEWARD_SAY_CEILING,
  // 第116波116-2a(27号文§3.3/§8.6): 线程级权限 — 三层解析纯函数(请求级>会话级>全局)与
  // 「管家只能收紧」的序表。exposed for 单测(permission-resolve.test.js)与 e2e 直测。
  resolvePermissionMode,
  // 第117波117m-A1(27号文§3.3/§8.6): 原生引擎权限闸门本体(mode,tier,toolName,input)与「活回合此刻
  // 的会话级档」只读访问器 — exposed for e2e 直测(auto 档的高风险判据、中途改档立刻生效两条)。
  nativeToolGate,
  liveSessionPermissionMode,
  PERMISSION_MODES_REQUIRING_CONFIRM,
  STEWARD_PERMISSION_RANK,
  stewardPermissionRank,
  stewardMayTightenTo,
  // 第116波116-pre(27号文§8.12/§11.3): 递话预判纯函数 — exposed for 单测(steward-preroute.test.js)。
  STEWARD_PREROUTE_DEFAULTS,
  prerouteText,
  // 第116波116h(27号文§3.1 116h 行/§8.10): 等待原因的唯一判定点(等你>等锁>等预算>等并发位)
  //   与它的两张常量表 — exposed for 单测(steward-wait-reason.test.js)与 e2e 直测形状对账。
  STEWARD_WAIT_REASONS,
  STEWARD_WAIT_LABELS,
  waitReasonFor,
  // 第117波117l-A1(27号文§11.9 D5/D7/D4): id 人话化、新线程模型分档、「它在问你」三态 —— 三个纯
  //   函数(只吃入参、无 IO),exposed for 单测(unit/steward-humanize.test.js)与 e2e 直测。
  stewardHumanizeIds,
  stewardThreadEngineRoute,
  stewardAsksYou,
  // 第117波117q-B5(30号文§3 总表 P2-8): 中和伪造围栏标签 —— 纯函数(只吃入参、无 IO),六个调用点(06d/06e/06/09)
  //   的单一事实源。exposed for 单测(unit/neutralize-fence-tag.test.js)。
  neutralizeFenceTag,
  // 第117波117q-B7(30号文§3 总表 P2-16): argsHash 指纹算法 —— 纯函数(只吃入参、无 IO),06f-autonomy-grants.js
  //   ::consumeGrant 与 09b-replan-ledger.js::recordNodeContinuation 两个调用点的单一事实源。
  //   exposed for 单测(unit/hash-args.test.js)。
  hashArgs,
  // 第116波116c-0(27号文§1/§3.5): 会话回合核心 —— 进程内(不经 HTTP)在任意会话上发起一个完整回合,
  //   自带 sink;HTTP 的 /api/chat/stream 现在也只是它的一层壳。exposed for e2e 等价性直测与后续切片调用。
  runSessionTurn,
  // 第116波116b(27号文§11.3): 管家收件箱 — 生命周期 + 归一化/合并/去重纯函数(exposed for 单测/e2e)。
  startStewardInbox,
  stopStewardInbox,
  STEWARD_SOURCE_EVENT_MAP,
  stewardNormalizeMissionChange,
  stewardNormalizeRunEvent,
  stewardNormalizePendingIntervention,
  stewardNormalizeBudgetExhausted,
  stewardMergeInboxEvents,
  stewardEventDedupeKey,
  stewardInboxRowDedupeKeys,
  // 第116波116c(27号文§3.3/§3.5/§4): 管家工具集 — 06i 纯函数(委托书/五态判据/豁免正则/记忆去重)
  // exposed for 单测与 e2e 直测;工具实现本身经 StewardHooks 与 TOOL_HANDLERS 触达,不另开导出面。
  STEWARD_EXEMPT_TOOL_PATTERNS,
  stewardToolPermanentlyExempt,
  // 127 波 2-bis:豁免原因(单点判据,布尔由它派生)/ 精确名出口 / 类别人话表 —— 单测与 e2e 直测。
  stewardExemptReason,
  STEWARD_EXEMPT_NAME_CARVEOUTS,
  STEWARD_EXEMPT_CATEGORY_LABELS,
  // 127 波 2-quater B1:全部命中 + 底线 + 扫没扫全 / tier 口径单点 / 命令摘录(中和 + 截 300)/ 摘录上游的脱敏,
  // 以及收件箱消息装配与降级按钮 —— 单测与 e2e 直测(13k 的摘要生产者经 StewardHooks.enrichInboxRows 与
  // steward_thread_status 触达,不另开导出面:14-main -> 13k 会是一条新边)。
  stewardExemptHits,
  stewardExemptScanInput,
  stewardExemptExcerpt,
  redact,
  stewardInboxMessage,
  stewardDowngradeActions,
  isStewardToolName,
  stewardSanitizeBlock,
  buildStewardBrief,
  STEWARD_BRIEF_LIMITS,
  STEWARD_THREAD_STATES,
  deriveStewardThreadState,
  stewardThreadStateFromCard,
  // 第116波116g(§3.1 事项跨会话升格): 事项级聚合状态的唯一定义(纯函数,unit 穷举真值表)。
  aggregateMissionState,
  // 117s-A D1(§11.13 ③):行序的状态秩(纯函数,单测/e2e 直测)。
  stewardThreadStateRank,
  STEWARD_MEMORY_KINDS,
  STEWARD_MEMORY_LIMITS,
  stewardMemoryTerms,
  stewardTermJaccard,
  // 第116波116-2e(27号文§3.5「如意设置」行): steward_config_* 的三级分级(allowlist + fail-closed)。
  //   exposed for 单测 unit/steward-config-tier.test.js —— 它拿 Object.keys(normalizeConfig({}).config)
  //   遍历默认表的每一个键,要求逐个落到 free/confirm/forbidden 三级之一,不许漏。
  STEWARD_CONFIG_TIERS,
  stewardConfigTierFor,
  STEWARD_QUICK_KIND,
  STEWARD_QUICK_ANSWER_CHARS,
  // 117s-H1(27 号文 §11.13.3「交付进箱」): 交付正文的三个预算 —— e2e 直接拿它们断言,
  //   数字只许有一份(06i 一份、13h 两份),测试不再自带字面量。
  STEWARD_DELIVERABLE_CHARS,
  STEWARD_INBOX_DELIVERABLE_CHARS,
  STEWARD_INBOX_MESSAGE_CHARS,
  // 第116波116g: 事项容器(02 持久化面)—— e2e 直测反向索引、损坏隔离与四个归属操作的幂等。
  readMissionContainer,
  listMissionContainers,
  createMissionContainer,
  patchMissionContainer,
  missionAttachThread,
  missionDetachThread,
  missionMergeInto,
  missionSplitThreads,
  MISSION_CONTAINER_MAX_FILES,
  MISSION_CONTAINER_SCHEMA,
  // 第116波116f(27号文§11.3): 管家回合运行器与到访 — 会话单例常量、回合入口、到访、输出契约解析器
  // 与两个分叉入口(提示词/预算)。exposed for e2e 直测;09/10/13g 侧一律经 StewardHooks 触达。
  STEWARD_SESSION_ID,
  STEWARD_SESSION_TITLE,
  STEWARD_PERMISSION_MODE,
  runStewardTurn,
  // 第117波117m-A1: 熔断判据本体 — exposed for e2e 直测(小时窗只节流 trigger!=='user' 的自主回合)。
  stewardCircuitCheck,
  stewardVisit,
  stewardParseReply,
  stewardResolveRoute,
  ensureStewardSession,
  buildStewardSystemPrompt,
  stewardContextBudget,
  // 116-pre(27号文§8.12/§11.3): 递话预判端点的装配层 — exposed for e2e 直测(缓存命中/未命中两路径)。
  stewardPreroute,
  // 116c: 班组动作核心(从 POST /api/agent-runs/:id 路由零行为抽出)与 108c 自状态装配 — e2e 直测等价性。
  agentRunActionCommand,
  buildWorkbenchSelfStatus,
  // 第41波(41a/41b): 表驱动工具注册表 — exposed for e2e(guard 声明化行为锁内省 + 分发行为直测)。
  TOOL_HANDLERS,
  NATIVE_TOOL_TIER,
  NATIVE_TOOL_PACKS,
  toolCall,
  classifyToolPacks,
  toolPackForName,
  buildToolCatalog,
  createToolLoadingState,
  estimateToolSchemaTokens,
  adaptiveMetaToolSchemas,
  generateSessionMcpConfig,
  readProjectMemory,
  toolRequirementsMet,
  TOOL_REQUIRES,
  ERROR_CLASSES,
  CONFIG_SCHEMA,
  SESSION_SCHEMA,
  PERMISSION_MODES,
  ROUTE_AUTH,
  // v0.9-S2: playbooks — exposed for e2e direct unit testing (normalize / availability / draft-parse).
  normalizePlaybook,
  evalPlaybookAvailability,
  parsePlaybookDraft,
  loadAllPlaybooks,
  // v0.9-S3 (C3): workspace-by-fingerprint — exposed for e2e direct unit testing of the resolver.
  resolveWorkspace,
  // PF1: checkpoint GC size-cap cache — exposed for e2e (assert no per-write full sweep + still purges over-cap).
  journalRecord,
  journalGc,
  journalGcProbe,
  writeHistorySnapshot, // PF1 fix: history snapshots also grow the cap-governed tree — exposed so the e2e can
                        // assert repeated snapshots move the cache AND auto-trigger a purge (bug: neither happened).
  // v0.9-S4 (C4): artifacts kind classifier + preview path-safety + summary builder — exposed for e2e units.
  kindForPath,
  buildTurnSummary,
  // v1.5-W1.5: ACC 写族收割判定 — exposed for e2e 直接单测(工具名前缀 + 去前缀逻辑)。
  isBridgedWriteTool,
  unprefixedBridgedName,
  // v1.5-W1.5 (T3): bridged 写族路径提取 — exposed for e2e 直接单测(args→目标路径+op)。
  collectBridgedWriteTarget,
  // v1.2-B: 多目标路径提取(move/copy 两条式)+ 机制性防漏审计 — exposed for checkpoint-coverage e2e 直测。
  collectBridgedWriteTargets,
  auditBridgedWriteCoverage,
  BRIDGED_WRITE_PATH_ARGS,
  // v1.2: 终端命令内联手写 Office 的桥接分发软闸 — exposed for e2e 直接单测。
  bridgedOfficeScriptGate,
  BRIDGED_WRITE_AUDIT_EXEMPT,
  fileAllowedRoots,
  workspaceWriteRoots,
  pathWithinRoot,
  pathWithinAnyRoot,
  readFilePreview,
  // v1.0.2-S3: reveal-in-explorer path guard + spawn-argv builder — exposed for e2e 单测护栏逻辑。
  guardWorkspacePath,
  buildRevealSpawn,
  // Native code-editor handoff + exact turn baselines — exposed for offline regression tests.
  executableFromAssociationCommand,
  classifyCodeEditorExecutable,
  resolvePreferredCodeEditor,
  buildCodeEditorSpawn,
  workspaceBaselineIsCodePath,
  captureWorkspaceTurnBaseline,
  reconcileWorkspaceTurnBaseline,
  // v1.4.6-S2/S3: shell-free open-spawn argv builders + native file-tool workspace boundary guard + local
  // provider detection — exposed for e2e (pure argv / containment assertions).
  buildOpenSpawn,
  buildBrowserOpenSpawn,
  guardFileToolPath,
  guardWorkspaceExecute,
  providerIsLocal,
  // 第31波B(L1): autoexec denylist + 路径归一 — exposed for shell-sandbox e2e 直接单测。
  AUTOEXEC_DENYLIST,
  normalizeAutoexecPath,
  // v0.9-S8: audit-center aggregation — exposed for e2e direct unit testing.
  collectAudit,
  auditSummaryFor,
  // v0.9-S9: web_search / web_fetch — SSRF guard + main-text extraction + cache (exposed for e2e direct units).
  ssrfCheck,
  embeddedIpv4FromV6, // v0.9 F1: IPv4-mapped IPv6 extraction — exposed for the ssrf-hardening e2e direct unit.
  isPrivateIpv4,      // v0.9 F1/F2: exposed so the e2e can assert range judgments directly.
  extractMainText,
  webCachePath,
  readWebCache,
  writeWebCache,
  webFetch,
  webSearch,
  // v1.1-W1a (T1/T2/T3): fetch error classification + multi-target probe + builtin HTML search — exposed for e2e units.
  classifyFetchError,
  httpGetGuarded,
  webFetchFailMessage,
  // v1.1-W2 (T1): zero-dep ZIP codec + download dest guard — exposed for tools-v3 e2e direct units.
  crc32,
  zipWrite,
  zipReadCentralDir,
  zipReadEntryData,
  zipCollectEntries,
  guardDownloadDest,
  probeAny,
  networkAnchors,
  NETWORK_ANCHORS,
  builtinSearch,
  parseBingHtml,
  parseBaiduHtml,
  // Resource-aware DAG scheduler primitives (pure normalization/conflict checks plus lease integration tests).
  normalizeAgentResource,
  normalizeAgentResources,
  remapAgentResources,
  agentResourcesConflict,
  inferToolResources,
  acquireResourceLease,
  releaseResourceLease,
  resourceBlockers,
  sanitizeAgentOutputSchema,
  parseStructuredAgentOutput,
  repairJson, // v1.5 (Judge JSON 修复): 零依赖修复器 — exposed for judge-json-repair e2e 直接单测。
  validateAgentJsonSchema,
  normalizeAgentGate,
  aggregateAgentVote,
  dedupeAgentFindings,
  aggregateCoverage,
  propagateAssignments,
  QUALITY_GATE_OUTPUT_SCHEMA,
  BUILTIN_AGENT_WORKFLOWS,
  normalizeWorkflowCondition,
  normalizeWorkflowLoop,
  workflowProgressFingerprint,
  evaluateNodeToolEvidence,
  // R1(13-r1-evidence-graph.md): evidence 索引 + claim 引用校验 - exposed for e2e 直测(四态:verified/unverified/跨工作区/无refs)。
  indexNodeEvidence,
  verifyNodeClaims,
  purgeNodeEvidence,
  runWorkspaceHash,
  buildNodeEvidenceCatalog,
  formatNodeEvidencePrompt,
  // R4(15-r4-memory-graph.md): 记忆关系边 + 冲突感知检索 - exposed for e2e 直测(propose/confirm/scope隔离/conflict)。
  saveMemory,
  loadMemoryRegistry,
  listWorkbenchMemories,
  readWorkbenchMemory,
  proposeWorkbenchMemory,
  proposeMemoryFromSession,
  migrateLegacyAccMemory,
  legacyAccMemoryMigrationComplete,
  buildMemoryPromptSection,
  buildCoreMemoryPromptSection,
  buildMemoryCheckPrompt,
  memorySearchTerms,
  rankRelevantMemories,
  effectiveMemorySelection,
  resolveMemoryPreflight,
  resolveCoreMemoryState,
  listMemoryRelations,
  proposeMemoryRelation,
  confirmMemoryRelation,
  deleteMemoryRelation,
  buildMemoryConflictMap,
  extractMemoryRelationProposals,
  analyzeMemoryMaintenance,
  proposeMemoryRelationTool,
  proposeMemoryRevision,
  proposeMemoryRelationRevoke,
  applyMemoryRelationProposal,
  memoryProposalPrefilter,
  parseMemoryProposalDecision,
  memoryProposalSimilarity,
  memoryProposalIsDuplicate,
  normalizeAgentWorkflow,
  resolveAgentTeamRoute,
  getAgentWorkflows,
  saveAgentWorkflow,
  deleteAgentWorkflow,
  evaluateWorkflowCondition,
  createAgentWorktree,
  finalizeAgentWorktree,
  applyAgentWorktree,
  maskSecrets,
  unmaskSecrets,
  unmaskProviders,
  invalidateClaudePathCache, // v1.0-S7 (perf): force a fresh claude-CLI probe after an install/settings save
  // R5(16-r5-replan-ledger.md): 可审查重规划提案 - exposed for e2e 直测(机器校验/生成)。
  validateReplanPatch,
  proposeReplanPatch,
  applyReplanPatch,
  rollbackReplanPatch,
  // Responses strict pairing adapter — exposed for e2e: shallow-copy repair must not mutate persisted history.
  responsesHistoryWithCompleteToolPairs,
  buildResponsesInputItems,
  // 117q-B1(30 号文 §4.1): 子进程 NDJSON 逐行喂入器 — exposed for unit 直测(chunk 边界切开 CJK 字节不得产生 U+FFFD)。
  createNdjsonLineFeeder,
  // 第 123 波 M1 §3.1(37 号文):定时任务纯函数内核 —— 零 I/O、时间全由入参喂,
  //   exposed for 单测 unit/scheduler-core.test.js 与三件 scheduler*.e2e.js 的直测。
  normalizeSchedulerTask,
  nextFireAt,
  parseCronExpr,
  describeSchedule,
  occurrenceKey,
  missedOccurrence,
  SCHEDULER_SCHEDULE_KINDS,
  SCHEDULER_PAYLOAD_KINDS,
  SCHEDULER_TARGET_MODES,
  SCHEDULER_ON_MISSED,
  SCHEDULER_ON_FAILURE,
  SCHEDULER_FIRE_MODES,
  SCHEDULER_PHASES,
  SCHEDULER_OUTCOMES,
  SCHEDULER_FORBIDDEN_PAYLOAD_KEYS,
  SCHEDULER_LIMITS,
  SCHEDULER_DEFAULT_POLICY,
  SCHEDULER_DESCRIBE_KEYS,
  SCHEDULER_DOW_KEYS,
  // 第 123 波 M1 §3.2/§3.4:调度器生命周期与假时钟 —— exposed for e2e 直测与 14 的 boot 起停。
  startScheduler,
  stopScheduler,
  schedulerRuntimeSnapshot,
  // 第 123 波 M2 §3.5:管家面的两个观测口 —— 定时任务回调/承诺读口的延迟绑定命名空间,
  //   与「回来摘要」那一支(七类事件 + 承诺三项) exposed for scheduler-steward.e2e.js 的直测。
  SchedulerHooks,
  stewardVisitDigest,
};
