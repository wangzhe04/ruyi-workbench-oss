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
    process.exitCode = 1;
  });
}

module.exports = {
  McpStdioClient,
  McpHttpClient, // 49c: 远程 MCP transport(sse/streamable-http) — exposed for e2e 直连契约断言。
  estimateHistoryTokens, // v0.8-S5: exposed for e2e direct unit testing (parts-aware token estimate v2)
  // 第45波(压缩 v2):摘要内核 + 45a 预算适配/map-reduce 分组 — exposed for e2e(死锁角回归)。
  providerSummaryCall,
  fitHistoryForSummary,
  chunkHistoryByBudget,
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
  resolveBridge, // v1.4.1: bridged-name prefix-tolerant routing (models that drop the serverId__ prefix)
  normalizeConfig,
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
  saveSession,
  deleteSession,
  listSessions,
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
  nativeClaudeAgentResultInfo,
  BUILTIN_AGENT_ROLES,
  normalizeSession,
  isUntitledSessionTitle, // 50-fix: 未命名标题判定(双引擎自动命名共用) — exposed for e2e
  detectDanglingTurn,
  bridgedToolTier,
  cwdWarning,
  defaultConfig,
  sanitizeExternalMcpServer,
  // 48c: MCP 配置导入器解析器(e2e 直测 TOML/JSON 边角)。
  parseMcpConfigFile,
  scanMcpSources,
  // v0.8-S6: capability matrix + layered prompt + error枚举 (exposed for e2e + UI).
  getCapabilities,
  invalidateCapabilityCache,
  buildProviderSystemPrompt,
  buildResponseLanguagePolicy,
  buildAgentTeamHint,
  appendTurnPolicies,
  appendResponseLanguagePolicy,
  isLongToolTask,
  resolveToolIterationBudget,
  shouldExtendToolIterationBudget,
  TOOL_ITERATION_BUDGETS,
  buildOpenAiTools,
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
  pathWithinRoot,
  pathWithinAnyRoot,
  readFilePreview,
  // v1.0.2-S3: reveal-in-explorer path guard + spawn-argv builder — exposed for e2e 单测护栏逻辑。
  guardWorkspacePath,
  buildRevealSpawn,
  // v1.4.6-S2/S3: shell-free open-spawn argv builders + native file-tool workspace boundary guard + local
  // provider detection — exposed for e2e (pure argv / containment assertions).
  buildOpenSpawn,
  buildBrowserOpenSpawn,
  guardFileToolPath,
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
  QUALITY_GATE_OUTPUT_SCHEMA,
  BUILTIN_AGENT_WORKFLOWS,
  normalizeWorkflowCondition,
  normalizeWorkflowLoop,
  workflowProgressFingerprint,
  evaluateNodeToolEvidence,
  normalizeAgentWorkflow,
  getAgentWorkflows,
  saveAgentWorkflow,
  deleteAgentWorkflow,
  evaluateWorkflowCondition,
  createAgentWorktree,
  finalizeAgentWorktree,
  applyAgentWorktree,
  maskSecrets,
  unmaskSecrets,
  invalidateClaudePathCache, // v1.0-S7 (perf): force a fresh claude-CLI probe after an install/settings save
};
