async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const command = argv._[0] || 'serve';
  if (command === 'serve') return startServer(argv);
  if (command === 'mcp') return startMcp();
  if (command === 'install') return installIntegration();
  if (command === 'doctor') return doctor();
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
  // 105c: 摘要实体确定性抽检 — exposed for e2e 白盒契约(抽取/检查/开关唯一判定点)。
  summaryEntityCheckEnabled,
  extractSummaryEntities,
  checkSummaryEntities,
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
  detectDanglingTurn,
  repairProviderHistoryPairing, // 配对铁律自愈(孤儿 tool_calls 补合成 tool 回复) — exposed for e2e 直测
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
  buildProviderSystemPrompt,
  PROMPT_PACK_VERSION, // 52d: 提示词包版本(语义化版本检查)
  buildStableSystemPrompt, // 51d C1a:稳定层(prefix-cache 友好)
  buildVolatileParts, // 51d C1a:易变层(C1b 移 user 侧)
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
};
