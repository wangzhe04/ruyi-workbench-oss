# 后端模块依赖图（第 103b／104 波）

> 本文件由 `node dev-harness/module-dependency-graph.js --write` 从 `app/src/manifest.json` 与源码生成。请勿手改。
> `provides/requires` 是构建期拼接作用域的显式契约；运行时仍执行单文件 `app/server.js`。

## 摘要

| 模块 | 顶层符号 | 跨模块符号引用 | 模块边 | 前向边 | 重复导出 | 强连通分量 |
|---:|---:|---:|---:|---:|---:|---:|
| 53 | 2307 | 2471 | 420 | 68 | 0 | 1 |

“前向边”表示较早拼接的模块引用较晚模块，依赖函数提升或延迟执行；它不是自动判错，但已由债务上限锁住，禁止无评审增加。

## 模块清单

| # | 模块 | 层 | provides | requires | 直接依赖 |
|---:|---|---|---:|---:|---:|
| 0 | `00-boot.js` | bootstrap | 56 | 5 | 4 |
| 1 | `01b-route-auth.js` | foundation | 1 | 0 | 0 |
| 2 | `01c-runtime-flags.js` | foundation | 35 | 0 | 0 |
| 3 | `01-config.js` | foundation | 133 | 35 | 8 |
| 4 | `02c-turn-segments.js` | foundation | 1 | 0 | 0 |
| 5 | `02-session-store.js` | foundation | 246 | 46 | 12 |
| 6 | `03-bridge-guard.js` | foundation | 71 | 20 | 5 |
| 7 | `04-visual-pipeline.js` | foundation | 1 | 2 | 1 |
| 8 | `04-permission-runtime.js` | foundation | 100 | 30 | 7 |
| 9 | `04-desktop-shell.js` | foundation | 1 | 7 | 3 |
| 10 | `05-claude-engine.js` | engine | 23 | 102 | 15 |
| 11 | `05b-kimi-bridge.js` | engine | 119 | 65 | 12 |
| 12 | `05c-kimi-search-policy.js` | engine | 42 | 11 | 2 |
| 13 | `05d-kimi-prompt-parts.js` | engine | 15 | 4 | 2 |
| 14 | `06-provider-engine.js` | engine | 114 | 49 | 11 |
| 15 | `06b-prompt-registry.js` | engine | 4 | 1 | 1 |
| 16 | `06c-agent-loop-hooks.js` | engine | 1 | 3 | 2 |
| 17 | `06h-retrieval-index.js` | engine | 14 | 0 | 0 |
| 18 | `06i-steward-core.js` | engine | 95 | 0 | 0 |
| 19 | `06d-memory-domain.js` | engine | 102 | 34 | 10 |
| 20 | `06e-mission-domain.js` | engine | 3 | 13 | 5 |
| 21 | `06f-autonomy-grants.js` | engine | 25 | 12 | 5 |
| 22 | `06g-resource-leases.js` | engine | 16 | 5 | 3 |
| 23 | `06j-scheduler-core.js` | engine | 42 | 0 | 0 |
| 24 | `07-autonomy.js` | orchestration | 90 | 60 | 13 |
| 25 | `08-agent-runs.js` | orchestration | 89 | 87 | 16 |
| 26 | `09b-replan-ledger.js` | orchestration | 8 | 4 | 1 |
| 27 | `09d-token-estimation.js` | orchestration | 10 | 2 | 2 |
| 28 | `09-workflow.js` | orchestration | 10 | 210 | 22 |
| 29 | `10-context-governance.js` | orchestration | 133 | 74 | 14 |
| 30 | `11-native-tools.js` | tools | 85 | 22 | 5 |
| 31 | `12-tool-dispatch.js` | tools | 33 | 79 | 14 |
| 32 | `13f-native-tool-schemas.js` | transport | 1 | 1 | 1 |
| 33 | `13-http-router.js` | transport | 64 | 209 | 24 |
| 34 | `13b-api-domain-routes.js` | transport | 6 | 37 | 7 |
| 35 | `13c-overlay-routes.js` | transport | 11 | 12 | 3 |
| 36 | `13d-core-domain-routes.js` | transport | 43 | 115 | 14 |
| 37 | `13e-pretender-index.js` | transport | 41 | 33 | 8 |
| 38 | `13i-steward-inbox.js` | transport | 68 | 24 | 7 |
| 39 | `13j-steward-tool-base.js` | transport | 66 | 20 | 6 |
| 40 | `13k-steward-threads.js` | transport | 31 | 86 | 11 |
| 41 | `13l-steward-ops.js` | transport | 26 | 67 | 16 |
| 42 | `13g-steward.js` | transport | 11 | 57 | 9 |
| 43 | `13m-steward-runner-base.js` | transport | 38 | 14 | 5 |
| 44 | `13n-steward-arbiter.js` | transport | 35 | 15 | 6 |
| 45 | `13o-steward-runner-prompt.js` | transport | 14 | 45 | 12 |
| 46 | `13p-steward-runner-actions.js` | transport | 23 | 39 | 10 |
| 47 | `13q-steward-runner-turn.js` | transport | 20 | 59 | 16 |
| 48 | `13h-steward-runner.js` | transport | 6 | 46 | 12 |
| 49 | `13r-event-stream.js` | transport | 20 | 14 | 6 |
| 50 | `13s-scheduler.js` | transport | 46 | 33 | 7 |
| 51 | `13t-steward-schedule.js` | transport | 18 | 30 | 9 |
| 52 | `14-main.js` | entrypoint | 1 | 533 | 36 |

## 模块边

| 调用方 | 提供方 | 方向 | 符号 |
|---|---|---|---|
| `00-boot.js` | `01-config.js` | forward | `readConfig` |
| `00-boot.js` | `02-session-store.js` | forward | `bumpMissionChangeSeq`, `readSessionIndex` |
| `00-boot.js` | `05-claude-engine.js` | forward | `CLAUDE_ENDPOINT_PRESETS` |
| `00-boot.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `01-config.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `DEFAULT_PORT`, `MAX_BODY_BYTES`, `SKILL_ID_RE`, `URL`, `VERSION`, `apiFailure`, `cp`, `crypto`, `ensureDirs`, `externalRoot`, `fs`, `fsp`, `isPkg`, `normalizePricing`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `01-config.js` | `01b-route-auth.js` | backward | `ROUTE_AUTH` |
| `01-config.js` | `03-bridge-guard.js` | forward | `existsExecutable`, `pathWithinRoot` |
| `01-config.js` | `04-desktop-shell.js` | forward | `DesktopShell` |
| `01-config.js` | `04-permission-runtime.js` | forward | `activeChildren`, `logEvent`, `resolveExternalMcpServers`, `scanMcpSources` |
| `01-config.js` | `05-claude-engine.js` | forward | `sanitizeExternalMcpServer`, `sanitizeProvider` |
| `01-config.js` | `06-provider-engine.js` | forward | `normalizeStoragePolicy` |
| `01-config.js` | `07-autonomy.js` | forward | `TOOL_PACK_DESCRIPTIONS`, `claudePermissionMode`, `getAgentRoleLibrary`, `nativeToolTier` |
| `02-session-store.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `SESSION_SCHEMA`, `SKILL_ID_RE`, `crypto`, `ensureDirs`, `fs`, `fsp`, `makeId`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text`, `zlib` |
| `02-session-store.js` | `01-config.js` | backward | `PERMISSION_MODES`, `atomicWriteJson`, `mutateConfig`, `readConfig`, `readFileTail`, `resolvePermissionMode`, `safeSessionId`, `selectedAgentCli`, `sessionPath`, `sessionWriteChains` |
| `02-session-store.js` | `03-bridge-guard.js` | forward | `pathWithinRoot`, `realpathForContainment` |
| `02-session-store.js` | `04-desktop-shell.js` | forward | `DesktopShell` |
| `02-session-store.js` | `04-permission-runtime.js` | forward | `activeChildren`, `logEvent`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `stopSession`, `turnSettlers` |
| `02-session-store.js` | `06-provider-engine.js` | forward | `recordEngineTranscript` |
| `02-session-store.js` | `06b-prompt-registry.js` | forward | `PROMPT_PACK_VERSION` |
| `02-session-store.js` | `06f-autonomy-grants.js` | forward | `revokeAllGrants` |
| `02-session-store.js` | `07-autonomy.js` | forward | `activeAgentRuns`, `agentRunDir` |
| `02-session-store.js` | `08-agent-runs.js` | forward | `appendAgentRunEvent`, `bumpRunIntervention`, `listAgentRuns`, `saveAgentRun` |
| `02-session-store.js` | `11-native-tools.js` | forward | `runGit` |
| `02-session-store.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `03-bridge-guard.js` | `00-boot.js` | backward | `URL`, `cp`, `crypto`, `dataRoot`, `fs`, `fsp`, `os`, `path`, `zlib` |
| `03-bridge-guard.js` | `01-config.js` | backward | `batchSafeSpawn`, `readConfig` |
| `03-bridge-guard.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `collectBridgedWriteTargets`, `journalDir`, `journalRecord`, `journalSessionCtx`, `kindForPath`, `unprefixedBridgedName` |
| `03-bridge-guard.js` | `04-permission-runtime.js` | forward | `logEvent` |
| `03-bridge-guard.js` | `05-claude-engine.js` | forward | `activeOpenAiProvider` |
| `04-desktop-shell.js` | `00-boot.js` | backward | `cp`, `fs`, `fsp`, `os`, `path` |
| `04-desktop-shell.js` | `01-config.js` | backward | `batchSafeSpawn` |
| `04-desktop-shell.js` | `04-permission-runtime.js` | backward | `killChildTree` |
| `04-permission-runtime.js` | `00-boot.js` | backward | `URL`, `VERSION`, `cp`, `crypto`, `dataRoot`, `ensureDirs`, `externalRoot`, `fs`, `fsp`, `http`, `makeId`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `04-permission-runtime.js` | `01-config.js` | backward | `batchSafeSpawn`, `detectDesktopMcp`, `ensureDesktopMcpWarm`, `generateMcpConfig`, `mutateConfig`, `readConfig`, `selectedAgentCli` |
| `04-permission-runtime.js` | `02-session-store.js` | backward | `registerIntervention`, `settleIntervention` |
| `04-permission-runtime.js` | `05-claude-engine.js` | forward | `maskKey`, `sanitizeExternalMcpServer` |
| `04-permission-runtime.js` | `06d-memory-domain.js` | forward | `legacyAccMemoryMigrationComplete` |
| `04-permission-runtime.js` | `13d-core-domain-routes.js` | forward | `decideIntervention` |
| `04-permission-runtime.js` | `13f-native-tool-schemas.js` | forward | `MCP_TOOLS` |
| `04-visual-pipeline.js` | `00-boot.js` | backward | `fsp`, `path` |
| `05-claude-engine.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `URL`, `appendUsageLedger`, `claudeCostFields`, `cp`, `createNdjsonLineFeeder`, `crypto`, `fsp`, `normalizePricing`, `nowIso`, `path`, `paths`, `safeJsonParse` |
| `05-claude-engine.js` | `01-config.js` | backward | `CLAUDE_PERMISSION_MODE_MAP`, `CMD_EXE_LINE_LIMIT`, `CMD_LINE_QUOTE_MARGIN`, `RUNTIME`, `buildUserEnvelope`, `cmdLineBudgetFor`, `cmdLineBudgetSeam`, `decodeClaudeCliText`, `effectiveAnthropicEnv`, `generateSessionMcpConfig`, `isAskUserTool`, `isBatchLauncher`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `quoteWinArg`, `readConfig`, `selectedAgentCli`, `spawnCmdLineLength`, `syncMcpServersToKimi`, `writeToChild` |
| `05-claude-engine.js` | `02-session-store.js` | backward | `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `reconcileWorkspaceTurnBaseline`, `saveSession` |
| `05-claude-engine.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `05-claude-engine.js` | `03-bridge-guard.js` | backward | `buildAttachmentPrompt`, `cwdWarning`, `normalizeCwd` |
| `05-claude-engine.js` | `04-permission-runtime.js` | backward | `activeChildren`, `appendLiveTail`, `buildClaudeRecoveryHistory`, `claudeProviderTailSince`, `claudeResumeRouteKey`, `clearPendingPermissions`, `clearPendingQuestions`, `formatQuestionGuidance`, `hasPendingQuestionForSession`, `installActiveChildEventFanout`, `isClaudeResumeMissingError`, `killChildTree`, `lastAssistantEngine`, `lastSuccessfulClaudeModel`, `logEvent`, `nativeClaudeAgentResultInfo`, `parseAgentCliEvent`, `redact`, `registerUserQuestion`, `sameClaudeResumeCwd`, `stopSession` |
| `05-claude-engine.js` | `05b-kimi-bridge.js` | forward | `maybeAutoCompactAgentSession`, `runKimiAcpTurnPrepared`, `syncKimiSessionUsage`, `syncKimiTurnPreferences`, `watchKimiWire` |
| `05-claude-engine.js` | `06-provider-engine.js` | forward | `appendMemorySection`, `appendTurnPolicies`, `buildBrowserAutomationHint`, `buildPlaybookIndexSection`, `buildPromptTaskContext`, `buildSkillsPromptSection`, `buildToolCustomizationHint`, `engineTranscriptCwd`, `evalPlaybookAvailability`, `fenceSafeSlice`, `getCapabilities`, `loadAllPlaybooks`, `peekCapabilities`, `softwareEngineeringTaskProfile` |
| `05-claude-engine.js` | `06b-prompt-registry.js` | forward | `PROMPT_PACK_VERSION`, `getPromptPack` |
| `05-claude-engine.js` | `06c-agent-loop-hooks.js` | forward | `AgentLoopHooks` |
| `05-claude-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `memoryGlobalDir`, `memoryProjectDir`, `resolveMemoryPreflight` |
| `05-claude-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `05-claude-engine.js` | `07-autonomy.js` | forward | `buildClaudeAgentDefinitions`, `classifyToolPacks` |
| `05-claude-engine.js` | `08-agent-runs.js` | forward | `buildOrchestrateHint`, `getAgentWorkflows` |
| `05-claude-engine.js` | `13-http-router.js` | forward | `buildModelHint` |
| `05b-kimi-bridge.js` | `00-boot.js` | backward | `MAX_BODY_BYTES`, `RUYI_EVENTS`, `StringDecoder`, `URL`, `cp`, `createNdjsonLineFeeder`, `dataRoot`, `externalRoot`, `fs`, `fsp`, `http`, `makeId`, `nowIso`, `os`, `path`, `pathToFileURL`, `paths`, `safeJsonParse`, `text` |
| `05b-kimi-bridge.js` | `01-config.js` | backward | `RUNTIME`, `decodeClaudeCliText`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `readConfig`, `selectedAgentCli`, `syncMcpServersToKimi` |
| `05b-kimi-bridge.js` | `02-session-store.js` | backward | `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `normalizeTodoItems`, `reconcileWorkspaceTurnBaseline`, `saveSession` |
| `05b-kimi-bridge.js` | `03-bridge-guard.js` | backward | `buildOpenSpawn`, `cwdWarning`, `fileAllowedRoots`, `guardFileToolPath`, `guardWorkspaceExecute`, `normalizeCwd`, `pathWithinRoot`, `realpathForContainment`, `workspaceWriteRoots` |
| `05b-kimi-bridge.js` | `04-permission-runtime.js` | backward | `activeChildren`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `killChildTree`, `logEvent`, `redact`, `requestUserQuestion` |
| `05b-kimi-bridge.js` | `05c-kimi-search-policy.js` | forward | `KIMI_ACP_SEARCH_BLOCKED_ENV_RE`, `classifyKimiAcpReadonlySearch` |
| `05b-kimi-bridge.js` | `05d-kimi-prompt-parts.js` | forward | `buildKimiAcpPromptParts` |
| `05b-kimi-bridge.js` | `06-provider-engine.js` | forward | `softwareEngineeringTaskProfile` |
| `05b-kimi-bridge.js` | `06c-agent-loop-hooks.js` | forward | `AgentLoopHooks` |
| `05b-kimi-bridge.js` | `07-autonomy.js` | forward | `requestNativePermission` |
| `05b-kimi-bridge.js` | `10-context-governance.js` | forward | `agentConversationContextMeta`, `lastSessionContextTokens`, `runAgentExternalCompact`, `upsertCompactMarker` |
| `05b-kimi-bridge.js` | `13-http-router.js` | forward | `discoverKimiModels` |
| `05c-kimi-search-policy.js` | `00-boot.js` | backward | `appRoot`, `dataRoot`, `fsp`, `os`, `path`, `text` |
| `05c-kimi-search-policy.js` | `03-bridge-guard.js` | backward | `fileAllowedRoots`, `guardFileToolPath`, `isSensitiveDataPath`, `pathWithinRoot`, `realpathForContainment` |
| `05d-kimi-prompt-parts.js` | `00-boot.js` | backward | `fsp`, `path` |
| `05d-kimi-prompt-parts.js` | `03-bridge-guard.js` | backward | `guardFileToolPath`, `realpathForContainment` |
| `06-provider-engine.js` | `00-boot.js` | backward | `APP_NAME`, `DEFAULT_PORT`, `OVERLAY_ID`, `VERSION`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `cp`, `crypto`, `dataRoot`, `externalRoot`, `fs`, `fsp`, `isPkg`, `neutralizeFenceTag`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text`, `zlib` |
| `06-provider-engine.js` | `01-config.js` | backward | `RUNTIME`, `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06-provider-engine.js` | `02-session-store.js` | backward | `SESSION_INDEX_FILE`, `loadSession`, `updateSessionMeta` |
| `06-provider-engine.js` | `03-bridge-guard.js` | backward | `existsExecutable`, `probeGitCli` |
| `06-provider-engine.js` | `04-permission-runtime.js` | backward | `activeChildren`, `collectBridgedTools`, `logEvent`, `mcpClients`, `redact`, `resolveExternalMcpServers`, `sanitizeServerId` |
| `06-provider-engine.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `applyProviderReasoningEffort`, `providerBaseWithV1`, `providerResponsesBase` |
| `06-provider-engine.js` | `06b-prompt-registry.js` | forward | `getPromptPack` |
| `06-provider-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryPromptSection` |
| `06-provider-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `06-provider-engine.js` | `07-autonomy.js` | forward | `buildResponsesInputItems`, `toolPackForName` |
| `06-provider-engine.js` | `11-native-tools.js` | forward | `hasRg` |
| `06b-prompt-registry.js` | `00-boot.js` | backward | `text` |
| `06c-agent-loop-hooks.js` | `00-boot.js` | backward | `makeId` |
| `06c-agent-loop-hooks.js` | `04-permission-runtime.js` | backward | `logEvent`, `redact` |
| `06d-memory-domain.js` | `00-boot.js` | backward | `SKILL_ID_RE`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fs`, `fsp`, `makeId`, `neutralizeFenceTag`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `06d-memory-domain.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06d-memory-domain.js` | `01c-runtime-flags.js` | backward | `coreMemoryCharBudget`, `coreMemoryMaxItems`, `memoryFixedSelectionMax`, `memoryIndexCharCap`, `memoryRelevanceMax`, `memoryVectorRecallEnabled` |
| `06d-memory-domain.js` | `02-session-store.js` | backward | `loadSession` |
| `06d-memory-domain.js` | `03-bridge-guard.js` | backward | `normalizeCwd` |
| `06d-memory-domain.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent` |
| `06d-memory-domain.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider` |
| `06d-memory-domain.js` | `06-provider-engine.js` | backward | `providerRawCompletion` |
| `06d-memory-domain.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `06d-memory-domain.js` | `06h-retrieval-index.js` | backward | `buildRetrievalCorpus`, `rankRetrievalCorpus`, `reciprocalRankFusion` |
| `06e-mission-domain.js` | `00-boot.js` | backward | `neutralizeFenceTag`, `nowIso`, `text` |
| `06e-mission-domain.js` | `02-session-store.js` | backward | `MISSION_MAX_TEXT`, `MISSION_STALL_LIMIT`, `evaluateMissionCheck`, `maybeFinalizeMission`, `missionProgressDigest`, `recordMissionCheckResult`, `saveSession` |
| `06e-mission-domain.js` | `03-bridge-guard.js` | backward | `normalizeCwd` |
| `06e-mission-domain.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `06e-mission-domain.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `06f-autonomy-grants.js` | `00-boot.js` | backward | `fsp`, `hashArgs`, `makeId`, `path` |
| `06f-autonomy-grants.js` | `03-bridge-guard.js` | backward | `AUTOEXEC_DENYLIST`, `isSensitiveDataPath`, `normalizeCwd`, `pathWithinRoot` |
| `06f-autonomy-grants.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `06f-autonomy-grants.js` | `07-autonomy.js` | forward | `NATIVE_TOOL_TIER`, `nativeToolTier` |
| `06f-autonomy-grants.js` | `11-native-tools.js` | forward | `globToRegExp` |
| `06g-resource-leases.js` | `00-boot.js` | backward | `makeId`, `nowIso`, `path` |
| `06g-resource-leases.js` | `02-session-store.js` | backward | `collectBridgedWriteTargets` |
| `06g-resource-leases.js` | `03-bridge-guard.js` | backward | `pathWithinRoot` |
| `07-autonomy.js` | `00-boot.js` | backward | `TOOL_TIER_RANK`, `URL`, `appendUsageLedger`, `claudeCostFields`, `cp`, `createNdjsonLineFeeder`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `07-autonomy.js` | `01-config.js` | backward | `BUILTIN_AGENT_ROLES`, `CLAUDE_PERMISSION_MODE_MAP`, `atomicWriteJson`, `batchSafeSpawn`, `buildUserEnvelope`, `cmdLineBudgetFor`, `decodeClaudeCliText`, `detectClaudePath`, `effectiveAnthropicEnv`, `generateAgentNodeMcpConfig`, `mergeAgentRole`, `normalizeAgentRole`, `safeSessionId`, `spawnCmdLineLength` |
| `07-autonomy.js` | `01c-runtime-flags.js` | backward | `appendOnlyToolSchemasEnabled`, `observationRecallEnabled` |
| `07-autonomy.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `registerIntervention`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveSession`, `settleIntervention`, `unprefixedBridgedName` |
| `07-autonomy.js` | `03-bridge-guard.js` | backward | `existsExecutable`, `normalizeCwd`, `pathWithinRoot` |
| `07-autonomy.js` | `04-permission-runtime.js` | backward | `killChildTree`, `logEvent`, `parseClaudeEvent`, `pendingPermissions`, `pendingPlans`, `redact`, `resolveBridge`, `runAutomaticInterventionDecision` |
| `07-autonomy.js` | `05-claude-engine.js` | backward | `providerBaseWithV1` |
| `07-autonomy.js` | `06-provider-engine.js` | backward | `appendResponseLanguagePolicy`, `toolRequirementsMet` |
| `07-autonomy.js` | `06i-steward-core.js` | backward | `isStewardToolName`, `stewardToolPermanentlyExempt` |
| `07-autonomy.js` | `08-agent-runs.js` | forward | `saveAgentRun` |
| `07-autonomy.js` | `09d-token-estimation.js` | forward | `estimateTextTokens` |
| `07-autonomy.js` | `10-context-governance.js` | forward | `CONTEXT_OVERFLOW_PATTERNS`, `cacheContextLength`, `extractContextLength`, `isContextOverflowError` |
| `07-autonomy.js` | `13f-native-tool-schemas.js` | forward | `MCP_TOOLS` |
| `08-agent-runs.js` | `00-boot.js` | backward | `TOOL_TIER_RANK`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text`, `zlib` |
| `08-agent-runs.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `readFileTail`, `safeSessionId` |
| `08-agent-runs.js` | `01c-runtime-flags.js` | backward | `estimateBucketsEnabled` |
| `08-agent-runs.js` | `02-session-store.js` | backward | `MISSION_STALL_SIGNAL_WINDOW_MS`, `bridgedWriteRelativePathArg`, `liveSessionPermissionMode`, `loadSession`, `missionSignalThrottleAllow`, `providerHistoryToolCalls`, `readInterventions`, `registerIntervention`, `saveSession`, `settleIntervention` |
| `08-agent-runs.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `guardWorkspacePath`, `journalBridgedWrite`, `normalizeCwd` |
| `08-agent-runs.js` | `04-permission-runtime.js` | backward | `collectBridgedTools`, `getBridgedClient`, `logEvent`, `redact`, `resolveBridge` |
| `08-agent-runs.js` | `05-claude-engine.js` | backward | `applyProviderReasoningEffort`, `providerBaseWithV1`, `providerResponsesBase`, `resolveProvider` |
| `08-agent-runs.js` | `06-provider-engine.js` | backward | `TOOL_ITERATION_BUDGETS`, `appendResponseLanguagePolicy`, `buildProviderSystemPrompt`, `getCapabilities`, `readProjectMemory`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget` |
| `08-agent-runs.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease` |
| `08-agent-runs.js` | `07-autonomy.js` | backward | `LOOP_GUARD_LIMITS`, `activeAgentRuns`, `agentRunDir`, `agentRunFile`, `agentRunWriteChains`, `bridgedToolTier`, `buildOpenAiTools`, `buildResponsesInputItems`, `classifyToolPacks`, `fetchOpenAiModels`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `nativeToolTier`, `neutralizeInjectedPrefixes`, `openAiStreamOnce`, `runClaudeSubAgentOnce`, `toResponsesTools`, `toolPackForName` |
| `08-agent-runs.js` | `09-workflow.js` | forward | `launchPersistedAgentRun` |
| `08-agent-runs.js` | `09d-token-estimation.js` | forward | `estimateContentTokens`, `estimateHistoryTokens`, `setEstimateBucketsV1` |
| `08-agent-runs.js` | `10-context-governance.js` | forward | `CompactionPlan`, `evaporateHistory`, `isContextOverflowError`, `maybeCompactSubHistory`, `noteWindowOvershoot`, `providerSummaryCall`, `recordCompactUsage`, `truncateToolResult` |
| `08-agent-runs.js` | `11-native-tools.js` | forward | `httpGetGuarded`, `ssrfCheck` |
| `08-agent-runs.js` | `13-http-router.js` | forward | `resolveNodeModel` |
| `08-agent-runs.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `09-workflow.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `makeId`, `neutralizeFenceTag`, `nowIso`, `safeJsonParse`, `text` |
| `09-workflow.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `09-workflow.js` | `01c-runtime-flags.js` | backward | `budgetGuardDecision`, `budgetGuardEnabled`, `budgetGuardTurnTokens`, `budgetGuardWarnRatio`, `estimateBucketsEnabled`, `sessionNotesInjectEnabled`, `toolByteBudgetShadowBytes`, `toolTimeBudgetEnabled`, `toolTimeBudgetHardMs`, `toolTimeBudgetShadowEnabled`, `toolTimeBudgetWarnMs`, `volatileTailLayoutEnabled` |
| `09-workflow.js` | `02-session-store.js` | backward | `applyMissionUpdate`, `bridgedWriteRelativePathArg`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `liveSessionPermissionMode`, `loadSession`, `mergeMissionBeforeSave`, `normalizeTodoItems`, `providerHistoryToolCalls`, `readSessionNotes`, `reconcileWorkspaceTurnBaseline`, `recordMissionBudgetTrippedChange`, `recordMissionStalledChange`, `registerIntervention`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveSession`, `sessionDesktopToolsOf`, `settleIntervention` |
| `09-workflow.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `09-workflow.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `buildAttachmentPrompt`, `cwdWarning`, `journalBridgedWrite`, `normalizeCwd` |
| `09-workflow.js` | `04-permission-runtime.js` | backward | `activeChildren`, `appendLiveTail`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `collectBridgedTools`, `getBridgedClient`, `hasPendingQuestionForSession`, `installActiveChildEventFanout`, `lastAssistantEngine`, `logEvent`, `redact`, `requestUserQuestion`, `resolveBridge`, `stopSession` |
| `09-workflow.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `09-workflow.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `applyProviderReasoningEffort`, `providerBaseWithV1`, `providerResponsesBase`, `resolveProvider`, `stripUrlUserinfo` |
| `09-workflow.js` | `06-provider-engine.js` | backward | `appendTurnPolicies`, `buildPromptTaskContext`, `buildStableSystemPrompt`, `buildVolatileParts`, `evalPlaybookAvailability`, `getCapabilities`, `loadAllPlaybooks`, `readProjectMemory`, `repairNodeJsonViaProvider`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget`, `softwareEngineeringTaskProfile` |
| `09-workflow.js` | `06b-prompt-registry.js` | backward | `PROMPT_PACK_VERSION`, `getPromptPack` |
| `09-workflow.js` | `06c-agent-loop-hooks.js` | backward | `AgentLoopHooks` |
| `09-workflow.js` | `06d-memory-domain.js` | backward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `extractMemoryRelationProposals`, `proposeMemoryRelation`, `resolveMemoryPreflight` |
| `09-workflow.js` | `06f-autonomy-grants.js` | backward | `consumeGrant` |
| `09-workflow.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources` |
| `09-workflow.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `09-workflow.js` | `07-autonomy.js` | backward | `ACTION_VIEW_MIN_CHARS`, `ACTION_VIEW_TOOLS`, `LOOP_GUARD_LIMITS`, `MAIL_GLOBAL_MAX`, `MAIL_PER_SENDER_MAX`, `MAIL_QUEUE_MAX`, `MAIL_TEXT_MAX`, `POOL_CHAIN_MAX`, `POOL_GRACE_MS`, `POOL_MAX_TOTAL`, `actionTargetMeta`, `activeAgentRuns`, `agentRunFile`, `bridgedToolTier`, `buildOpenAiTools`, `buildResponsesInputItems`, `classifyRuntimeToolFailure`, `cleanupAgentWorktree`, `compareToolRetrievalShadow`, `createAgentWorktree`, `createToolLoadingState`, `drainSteerQueue`, `estimateToolSchemaTokens`, `failoverStickyBase`, `finalizeAgentWorktree`, `getAgentRoleLibrary`, `looksLikePlan`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `nativeToolTier`, `openAiStreamOnce`, `projectActionModelView`, `requestNativePermission`, `requestPlanApproval`, `resumeInFlight`, `toResponsesTools` |
| `09-workflow.js` | `08-agent-runs.js` | backward | `accumulateRunUsage`, `agentRunSaveFailures`, `aggregateAgentVote`, `aggregateCoverage`, `appendAgentRunEvent`, `buildOrchestrateHint`, `buildUpstreamContext`, `bumpRunIntervention`, `classifyNodeErrorText`, `computeSchedulerStep`, `dedupeAgentFindings`, `deriveNodeOutputs`, `evalWaitCondition`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `formatNodeEvidencePrompt`, `getAgentWorkflows`, `indexNodeEvidence`, `materializePoolItem`, `nodeDeliveryEligibility`, `normalizeAgentGate`, `normalizeWaitSpec`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `parseStructuredAgentOutput`, `poolChainDepth`, `propagateAssignments`, `purgeNodeEvidence`, `recordAgentNodeProgress`, `recordRunBudgetTrippedEvent`, `recordRunStalledEvent`, `resolveAgentTeamRoute`, `resolveOrchestrateNodes`, `runSubAgent`, `sanitizeAgentOutputSchema`, `saveAgentRun`, `summarizeAgentWorkflowRun`, `syncRunEventSeq`, `validateAgentJsonSchema`, `verdictPasses`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `09-workflow.js` | `09b-replan-ledger.js` | backward | `proposeReplanPatch`, `recordNodeContinuation`, `validateReplanPatch` |
| `09-workflow.js` | `09d-token-estimation.js` | backward | `estimateContentTokens`, `estimateHistoryTokens`, `setEstimateBucketsV1` |
| `09-workflow.js` | `10-context-governance.js` | forward | `CompactionPlan`, `appendPromptToLastUserMessage`, `buildObservationRecallPrompt`, `buildSessionNotesInjectPrompt`, `contextWindowFromTable`, `evaporateHistory`, `historyStartsWithCompactionSummary`, `isContextOverflowError`, `maybeAutoCompact`, `measureObservationReductionShadow`, `noteEstimateSample`, `noteWindowOvershoot`, `providerContextWindow`, `providerSummaryCall`, `recordCompactUsage`, `truncateToolResult`, `upsertCompactMarker`, `writeHistorySnapshot` |
| `09-workflow.js` | `13-http-router.js` | forward | `buildModelHint`, `resolveNodeModel` |
| `09b-replan-ledger.js` | `00-boot.js` | backward | `TOOL_TIER_RANK`, `hashArgs`, `makeId`, `nowIso` |
| `09d-token-estimation.js` | `07-autonomy.js` | backward | `estimateToolSchemaTokens` |
| `09d-token-estimation.js` | `10-context-governance.js` | forward | `ESTIMATION_RULES` |
| `10-context-governance.js` | `00-boot.js` | backward | `URL`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fs`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `text`, `zlib` |
| `10-context-governance.js` | `01-config.js` | backward | `DurableJsonStore`, `permissionModeFrom`, `readConfig`, `readJsonBody`, `resolvePermissionMode` |
| `10-context-governance.js` | `01c-runtime-flags.js` | backward | `evaporateBudgetBoundaryEnabled`, `historyReadDedupEnabled`, `observationRecallEnabled`, `reseedTailUnitsEnabled`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `summaryEntityCheckEnabled`, `summaryFactTableCap`, `summaryFactTableEnabled`, `summaryPromptI18nEnabled`, `summaryRefineEnabled`, `summarySingleShotEnabled` |
| `10-context-governance.js` | `02-session-store.js` | backward | `configForSessionEngineRoute`, `createSession`, `inferSessionEngineRoute`, `journalBytesAdjust`, `journalDir`, `journalGc`, `loadSession`, `normalizeSessionEngineRoute`, `readSessionNotes`, `rememberLastUsedEngineRoute`, `repairProviderHistoryPairing`, `saveSession`, `sessionEngineRouteFromConfig`, `withJournalWriteLock`, `writeSessionNotes` |
| `10-context-governance.js` | `04-permission-runtime.js` | backward | `activeChildren`, `driverAutoSessions`, `logEvent`, `redact`, `stopSession`, `turnSettlers` |
| `10-context-governance.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `providerBaseWithV1`, `providerResponsesBase`, `runClaudeTurn` |
| `10-context-governance.js` | `05b-kimi-bridge.js` | backward | `kimiContextWindow` |
| `10-context-governance.js` | `06-provider-engine.js` | backward | `buildProviderSystemPrompt`, `maybeWriteThreadBrief`, `settleThreadBrief` |
| `10-context-governance.js` | `06e-mission-domain.js` | backward | `runMissionDriver` |
| `10-context-governance.js` | `06f-autonomy-grants.js` | backward | `activeDriverRuns`, `bindDriverRun`, `revokeGrantsForRun` |
| `10-context-governance.js` | `06i-steward-core.js` | backward | `StewardHooks` |
| `10-context-governance.js` | `07-autonomy.js` | backward | `buildResponsesInputItems`, `fetchOpenAiModels` |
| `10-context-governance.js` | `09-workflow.js` | backward | `runOpenAiTurn` |
| `10-context-governance.js` | `09d-token-estimation.js` | backward | `CONTEXT_WINDOW_FALLBACK`, `EVAPORATED_PREFIX`, `estimateContentTokens`, `estimateHistoryTokens`, `estimateTextTokens`, `fmtTokensServer` |
| `11-native-tools.js` | `00-boot.js` | backward | `URL`, `appRoot`, `cp`, `crypto`, `fs`, `fsp`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text`, `zlib` |
| `11-native-tools.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig` |
| `11-native-tools.js` | `03-bridge-guard.js` | backward | `ensureDataRootReal`, `existsExecutable`, `isSensitiveDataPath` |
| `11-native-tools.js` | `04-permission-runtime.js` | backward | `killChildTree` |
| `11-native-tools.js` | `06-provider-engine.js` | backward | `markNetworkOnline`, `networkAnchors`, `probeAny` |
| `12-tool-dispatch.js` | `00-boot.js` | backward | `OVERLAY_ID`, `SKILL_ID_RE`, `cp`, `crypto`, `externalRoot`, `fs`, `fsp`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `12-tool-dispatch.js` | `01-config.js` | backward | `RUNTIME`, `commandForSelfMcp`, `defaultConfig`, `ensureDesktopMcpWarm`, `externalServerJs`, `probeAgentCliLauncher`, `readConfig`, `selectedAgentCli`, `staticBase` |
| `12-tool-dispatch.js` | `01c-runtime-flags.js` | backward | `execResultCacheEnabled`, `execResultCacheMaxEntries`, `observationRecallEnabled` |
| `12-tool-dispatch.js` | `02-session-store.js` | backward | `bridgedWriteRelativePathArg`, `journalDropEntries`, `journalRecord`, `journalSessionCtx`, `loadSession`, `normalizeTodoItems` |
| `12-tool-dispatch.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `buildOpenSpawn`, `guardFileToolPath`, `isSensitiveDataPath`, `journalBridgedWrite`, `normalizeCwd`, `pathWithinRoot`, `realpathForContainment` |
| `12-tool-dispatch.js` | `04-permission-runtime.js` | backward | `configureMcpFromTool`, `getBridgedClient`, `logEvent`, `resolveBridge`, `resolveExternalMcpServers`, `safeMcpInventory` |
| `12-tool-dispatch.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider` |
| `12-tool-dispatch.js` | `06-provider-engine.js` | backward | `PLAYBOOK_REQUIRES`, `buildRuntimeIdentityFacts`, `evalPlaybookAvailability`, `getCapabilities`, `loadAllPlaybooks`, `peekCapabilities` |
| `12-tool-dispatch.js` | `06d-memory-domain.js` | backward | `listWorkbenchMemories`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `readWorkbenchMemory` |
| `12-tool-dispatch.js` | `06i-steward-core.js` | backward | `StewardHooks` |
| `12-tool-dispatch.js` | `07-autonomy.js` | backward | `bridgedToolTier`, `compareToolRetrievalShadow`, `listCompactTools`, `searchToolCatalog` |
| `12-tool-dispatch.js` | `08-agent-runs.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `getAgentWorkflows` |
| `12-tool-dispatch.js` | `10-context-governance.js` | backward | `rehydrateObservation` |
| `12-tool-dispatch.js` | `11-native-tools.js` | backward | `ZIP_MAX_SINGLE_FILE`, `ZIP_MAX_TOTAL`, `globToRegExp`, `httpGetGuarded`, `httpRequest`, `isBinaryReadPath`, `levenshtein`, `readIfExists`, `searchFileContent`, `ssrfCheck`, `walkFiles`, `webFetch`, `webSearch`, `zipCollectEntries` |
| `13-http-router.js` | `00-boot.js` | backward | `APP_NAME`, `CONFIG_SCHEMA`, `DEFAULT_PORT`, `EventStreamHooks`, `OVERLAY_ID`, `SKILL_ID_RE`, `URL`, `VERSION`, `apiFailure`, `buildUsageSummary`, `cp`, `crypto`, `ensureDirs`, `exePath`, `externalRoot`, `fs`, `fsp`, `http`, `isPkg`, `json`, `makeId`, `nowIso`, `os`, `path`, `paths`, `readline`, `safeJsonParse`, `text`, `zlib` |
| `13-http-router.js` | `01-config.js` | backward | `AGENT_CLI_TYPES`, `BUILTIN_AGENT_ROLES`, `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `RUNTIME`, `atomicWriteJson`, `authorizeRoute`, `autoImportClaudeCodeMcp`, `contentTypeFor`, `decodeClaudeCliText`, `detectClaudePath`, `detectDesktopMcp`, `detectKimiPath`, `effectiveAnthropicEnv`, `ensureDesktopMcpWarm`, `externalServerJs`, `generateMcpConfig`, `hostAllowed`, `invalidateAgentCliPathCaches`, `mutateConfig`, `normalizeAgentRole`, `prepareAgentCliSpawn`, `readConfig`, `readJsonBody`, `safeSessionId`, `selectedAgentCli`, `send`, `sendError`, `serveStatic`, `syncAgentRolesToClaude`, `syncClaudeCliSettings`, `syncMcpServersToClaude`, `syncMcpServersToKimi`, `tokenOk` |
| `13-http-router.js` | `01c-runtime-flags.js` | backward | `coreMemoryCharBudget`, `coreMemoryMaxItems`, `memoryFixedSelectionMax`, `observationRecallEnabled` |
| `13-http-router.js` | `02-session-store.js` | backward | `MISSION_MAX_TEXT`, `applyMissionUpdate`, `bumpMissionChangeSeq`, `configForSessionEngineRoute`, `evaluateMissionCheck`, `flushSessionIndexSync`, `invalidateSessionIndex`, `journalDir`, `journalReadIndex`, `loadSession`, `markInterruptedInterventions`, `maybeFinalizeMission`, `missionControlCommand`, `normalizeMission`, `normalizeTodoItems`, `recordMissionCheckResult`, `rememberLastUsedEngineRoute`, `saveSession`, `sessionEngineRouteFromConfig`, `workspaceBaselineIsCodePath`, `workspaceBaselinePathKey` |
| `13-http-router.js` | `03-bridge-guard.js` | backward | `PREVIEW_TEXT_EXTS`, `buildCodeEditorSpawn`, `buildRevealSpawn`, `ensureDataRootReal`, `existsExecutable`, `fileAllowedRoots`, `guardWorkspacePath`, `isSensitiveDataPath`, `launchCodeEditor`, `materializeCheckpointEditorDiff`, `normalizeCwd`, `pathWithinAnyRoot`, `pathWithinRoot`, `readFilePreview`, `resolvePreferredCodeEditor`, `resolveWorkspace` |
| `13-http-router.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `13-http-router.js` | `04-permission-runtime.js` | backward | `activeChildren`, `killAllMcpClients`, `logEvent`, `makeAttachmentRecord`, `redact`, `resolveExternalMcpServers`, `stopSession` |
| `13-http-router.js` | `05-claude-engine.js` | backward | `CLAUDE_ENDPOINT_PRESETS`, `PROVIDER_PRESETS`, `activeOpenAiProvider`, `maskProviders`, `resolveProvider`, `sanitizeProvider`, `unmaskProviders`, `unmaskSecrets` |
| `13-http-router.js` | `05b-kimi-bridge.js` | backward | `applyKimiStatusToSession`, `kimiSessionStatus`, `runKimiCompact` |
| `13-http-router.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES`, `buildMetricsPayload`, `buildOpsMetrics`, `collectAudit`, `collectStorageStats`, `deleteUserPlaybook`, `draftPlaybookFromSession`, `getCapabilities`, `listPlaybooksWithAvailability`, `maybeRecordStorageTrend`, `normalizePlaybook`, `recordRequestMetric`, `saveUserPlaybook`, `storageSweep` |
| `13-http-router.js` | `06d-memory-domain.js` | backward | `MEMORY_EXCLUSION_MAX`, `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `confirmMemoryRelation`, `decideMemoryProposal`, `deleteMemory`, `deleteMemoryRelation`, `draftMemoryFromSession`, `listMemoryProjectGroups`, `listMemoryRelations`, `loadMemoryRegistry`, `migrateLegacyAccMemory`, `migrateMemory`, `projectKeyForCwd`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `readMemoryItem`, `resolveCoreMemoryState`, `saveMemory`, `validateMemoryProposalSave` |
| `13-http-router.js` | `06f-autonomy-grants.js` | backward | `activeDriverRuns`, `autonomyGrants`, `dryRunGrantFiles`, `listGrantsView`, `normalizeGrant`, `revokeAllGrants`, `revokeGrant` |
| `13-http-router.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `13-http-router.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `buildClaudeAgentDefinitions`, `fetchOpenAiModels`, `getAgentRoleLibrary`, `projectAgentRoleFile`, `readClaudeProjectAgentRoles`, `readProjectAgentRoles`, `saveProjectAgentRoles`, `toolPackForName` |
| `13-http-router.js` | `08-agent-runs.js` | backward | `appendAgentWorkflowSummaryToSession`, `autoResumeInterruptedRuns`, `deleteAgentWorkflow`, `getAgentWorkflows`, `markInterruptedAgentRuns`, `resolveOrchestrateNodes`, `saveAgentRun`, `saveAgentWorkflow` |
| `13-http-router.js` | `09-workflow.js` | backward | `runAgentWorkflow` |
| `13-http-router.js` | `10-context-governance.js` | backward | `agentConversationContextMeta`, `cachedContextLength`, `configuredConversationWindow`, `contextWindowFromTable`, `learnedWindowCap`, `resolveContextWindow`, `runAgentExternalCompact`, `runProviderCompact`, `streamChat`, `truncateToolResult` |
| `13-http-router.js` | `11-native-tools.js` | backward | `hasRg`, `killAllShellSessions` |
| `13-http-router.js` | `13b-api-domain-routes.js` | forward | `handleCheckpointApiRoutes`, `handleMcpApiRoutes`, `handleSteerApiRoute` |
| `13-http-router.js` | `13c-overlay-routes.js` | forward | `handleOverlayApiRoutes` |
| `13-http-router.js` | `13d-core-domain-routes.js` | forward | `handleAgentRunApiRoutes`, `handleInterventionApiRoutes`, `handleMissionsApiRoutes`, `handleSessionApiRoutes` |
| `13-http-router.js` | `13e-pretender-index.js` | forward | `warmPretenderProjectionIndex` |
| `13-http-router.js` | `13f-native-tool-schemas.js` | backward | `MCP_TOOLS` |
| `13-http-router.js` | `13s-scheduler.js` | forward | `handleSchedulerApiRoutes`, `startScheduler`, `stopScheduler` |
| `13b-api-domain-routes.js` | `00-boot.js` | backward | `URL`, `apiFailure`, `fsp`, `json`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `13b-api-domain-routes.js` | `01-config.js` | backward | `buildUserEnvelope`, `generateMcpConfig`, `mutateConfig`, `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `writeToChild` |
| `13b-api-domain-routes.js` | `02-session-store.js` | backward | `bumpMissionChangeSeq`, `journalRollback`, `rewindSession`, `saveSession` |
| `13b-api-domain-routes.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `activeChildren`, `buildMcpConnectorInventory`, `hasPendingQuestionForSession`, `logEvent`, `mutateMcpConnector`, `probeMcpConnector`, `resolveExternalMcpServers`, `scanMcpSources` |
| `13b-api-domain-routes.js` | `05-claude-engine.js` | backward | `maskKey`, `sanitizeExternalMcpServer` |
| `13b-api-domain-routes.js` | `06-provider-engine.js` | backward | `normalizeStoragePolicy`, `storageSweep` |
| `13b-api-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX`, `activeAgentRuns` |
| `13c-overlay-routes.js` | `00-boot.js` | backward | `cp`, `crypto`, `dataRoot`, `externalRoot`, `fs`, `fsp`, `json`, `path` |
| `13c-overlay-routes.js` | `01-config.js` | backward | `readJsonBody`, `send`, `tokenOk` |
| `13c-overlay-routes.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13d-core-domain-routes.js` | `00-boot.js` | backward | `URL`, `apiFailure`, `crypto`, `fsp`, `json`, `makeId`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `13d-core-domain-routes.js` | `01-config.js` | backward | `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `RUNTIME`, `atomicWriteJson`, `readConfig`, `readJsonBody`, `resolvePermissionMode`, `safeSessionId`, `send`, `tokenOk` |
| `13d-core-domain-routes.js` | `01c-runtime-flags.js` | backward | `sessionSearchIndexEnabled` |
| `13d-core-domain-routes.js` | `02-session-store.js` | backward | `buildMissionAcceptanceProjection`, `bulkDeleteUnpinnedSessions`, `bumpMissionChangeSeq`, `compactInterventionJournal`, `createMissionContainer`, `createSession`, `deleteSession`, `detectDanglingTurn`, `foldTurnSummaries`, `journalReadIndex`, `listMissionContainers`, `listSessions`, `loadSession`, `missionAttachThread`, `missionContainerAcceptanceStamp`, `missionControlCommand`, `missionControlView`, `missionDetachThread`, `missionMergeInto`, `missionSplitThreads`, `patchMissionContainer`, `readInterventions`, `readMissionChangesWithMeta`, `readMissionContainer`, `readMissionSessionHead`, `readSessionHeadResilient`, `registerIntervention`, `saveSession`, `sessionBodyPaths`, `sessionBriefOf`, `sessionDesktopToolsOf`, `sessionDisplayTitle`, `sessionKind`, `sessionMeta`, `sessionMissionId`, `settleIntervention`, `transitionInterventionState`, `updateSessionMeta` |
| `13d-core-domain-routes.js` | `03-bridge-guard.js` | backward | `normalizeCwd` |
| `13d-core-domain-routes.js` | `04-permission-runtime.js` | backward | `activeChildren`, `driverAutoSessions`, `extendUserQuestion`, `logEvent`, `normalizeQuestionAnswer`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `redact`, `requestUserQuestion`, `runAutomaticInterventionDecision` |
| `13d-core-domain-routes.js` | `06f-autonomy-grants.js` | backward | `consumeGrant` |
| `13d-core-domain-routes.js` | `06h-retrieval-index.js` | backward | `buildRetrievalCorpus`, `rankRetrievalCorpus`, `reciprocalRankFusion`, `retrievalTerms` |
| `13d-core-domain-routes.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `aggregateMissionState`, `deriveStewardThreadState`, `stewardSanitizeText`, `stewardThreadStateFromCard`, `stewardThreadStateRank`, `waitReasonFor` |
| `13d-core-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX`, `activeAgentRuns`, `agentRunFile`, `applyAgentWorktree`, `cleanupAgentWorktree`, `getAgentRoleLibrary`, `nativeToolGate`, `nativeToolTier`, `toolIsRevertible` |
| `13d-core-domain-routes.js` | `08-agent-runs.js` | backward | `agentRunEventsFile`, `appendAgentRunEvent`, `bumpRunIntervention`, `computeWaveSeq`, `listAgentRuns`, `materializePoolItem`, `nodeDeliveryEligibility`, `readAgentRunEvents`, `saveAgentRun` |
| `13d-core-domain-routes.js` | `09-workflow.js` | backward | `launchPersistedAgentRun` |
| `13d-core-domain-routes.js` | `09b-replan-ledger.js` | backward | `applyReplanPatch` |
| `13d-core-domain-routes.js` | `13e-pretender-index.js` | forward | `emptyMissionUsage`, `getPretenderProjectionIndex`, `overlayMissionCard`, `paginatePretenderProjection`, `pretenderEtag`, `pretenderHash`, `pretenderIndexMeta`, `pretenderIndexRuntime`, `pretenderLiveOverlayRevision`, `pretenderNotModified` |
| `13e-pretender-index.js` | `00-boot.js` | backward | `EventStreamHooks`, `URL`, `apiFailure`, `crypto`, `fs`, `fsp`, `nowIso`, `path`, `paths`, `readUsageRows`, `safeJsonParse` |
| `13e-pretender-index.js` | `01-config.js` | backward | `THREAD_INDEX_RECENT_DEFAULT`, `THREAD_INDEX_RECENT_MAX`, `THREAD_INDEX_RECENT_MIN`, `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath` |
| `13e-pretender-index.js` | `02-session-store.js` | backward | `compactInterventionJournal`, `interventionFilePath`, `readInterventionsWithMeta`, `sessionKind`, `sessionMissionId` |
| `13e-pretender-index.js` | `04-permission-runtime.js` | backward | `activeChildren` |
| `13e-pretender-index.js` | `06i-steward-core.js` | backward | `stewardAsksYouForThread`, `stewardWatchedThread`, `threadOriginOf`, `threadVisible` |
| `13e-pretender-index.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `agentRunDir` |
| `13e-pretender-index.js` | `08-agent-runs.js` | backward | `listAgentRuns` |
| `13e-pretender-index.js` | `13d-core-domain-routes.js` | backward | `buildMissionCard`, `missionRunDigest` |
| `13f-native-tool-schemas.js` | `07-autonomy.js` | backward | `adaptiveMetaToolSchemas` |
| `13g-steward.js` | `00-boot.js` | backward | `URL`, `apiFailure`, `json`, `nowIso`, `text` |
| `13g-steward.js` | `01-config.js` | backward | `readConfig`, `readJsonBody`, `send`, `tokenOk` |
| `13g-steward.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13g-steward.js` | `06d-memory-domain.js` | backward | `memoryIsExpired`, `memoryProposalLooksSensitive` |
| `13g-steward.js` | `06i-steward-core.js` | backward | `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_PREROUTE_QUERY_MAX`, `StewardHooks`, `stewardSanitizeText` |
| `13g-steward.js` | `13i-steward-inbox.js` | backward | `startStewardInbox`, `stewardInboxRead`, `stewardInboxState`, `stopStewardInbox` |
| `13g-steward.js` | `13j-steward-tool-base.js` | backward | `STEWARD_MEMORY_NEW_WINDOW_MS`, `STEWARD_MEMORY_SCHEMA`, `stewardAppendDecision`, `stewardDecisionsRead`, `stewardFail`, `stewardMemoryScopeLabel`, `stewardMutateMemory`, `stewardQuickClosed`, `stewardReadMemoryStore` |
| `13g-steward.js` | `13k-steward-threads.js` | backward | `stewardEnrichInboxRows`, `stewardImplQuickAsk`, `stewardImplThreadContinue`, `stewardImplThreadNew`, `stewardImplThreadNote`, `stewardImplThreadPermission`, `stewardImplThreadRead`, `stewardImplThreadRename`, `stewardImplThreadStatus`, `stewardImplThreadsSearch`, `stewardQuickClose` |
| `13g-steward.js` | `13l-steward-ops.js` | backward | `stewardImplAuditTail`, `stewardImplConfigGet`, `stewardImplConfigSet`, `stewardImplDecide`, `stewardImplHealth`, `stewardImplInboxRead`, `stewardImplMemorySearch`, `stewardImplMemoryVeto`, `stewardImplMemoryWrite`, `stewardImplMissions`, `stewardImplPlaybookDraft`, `stewardImplRunAction`, `stewardImplRunsStatus`, `stewardImplSelfStatus`, `stewardImplSkillToggle`, `stewardImplUsage` |
| `13h-steward-runner.js` | `00-boot.js` | backward | `apiFailure`, `json`, `nowIso` |
| `13h-steward-runner.js` | `01-config.js` | backward | `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `tokenOk` |
| `13h-steward-runner.js` | `04-permission-runtime.js` | backward | `activeChildren`, `stopSession` |
| `13h-steward-runner.js` | `06f-autonomy-grants.js` | backward | `revokeAllGrants` |
| `13h-steward-runner.js` | `06i-steward-core.js` | backward | `StewardHooks`, `stewardSanitizeText`, `waitReasonFor` |
| `13h-steward-runner.js` | `13g-steward.js` | backward | `stewardToolHandler` |
| `13h-steward-runner.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardBasisOf`, `stewardFail`, `stewardRawKind`, `stewardReadSessionHead`, `stewardThreadPermissionMode` |
| `13h-steward-runner.js` | `13m-steward-runner-base.js` | backward | `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS`, `ensureStewardSession`, `stewardResumeRunner`, `stewardRunnerRuntime`, `stewardStopRunner` |
| `13h-steward-runner.js` | `13n-steward-arbiter.js` | backward | `stewardAcquireTurnSlot`, `stewardArbiterPrioritize`, `stewardArbiterRefresh`, `stewardArbiterState`, `stewardArbiterWait`, `stewardCancelQueuedTurn` |
| `13h-steward-runner.js` | `13o-steward-runner-prompt.js` | backward | `buildStewardSystemPrompt`, `stewardContextBudget`, `stewardPreroute`, `stewardVisitNotesPrompt` |
| `13h-steward-runner.js` | `13p-steward-runner-actions.js` | backward | `stewardDayCost`, `stewardTurnsInWindow` |
| `13h-steward-runner.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn`, `stewardApplyThreadTier`, `stewardOnInboxBatch`, `stewardRelayChannelFor`, `stewardRelayDeliver`, `stewardRunAct`, `stewardVisit` |
| `13i-steward-inbox.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `fsp`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `13i-steward-inbox.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath` |
| `13i-steward-inbox.js` | `02-session-store.js` | backward | `readMissionChangesWithMeta`, `repairMissionChangeTornTail` |
| `13i-steward-inbox.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent` |
| `13i-steward-inbox.js` | `06i-steward-core.js` | backward | `STEWARD_EVENT_KINDS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardSanitizeText`, `stewardWatchedThread` |
| `13i-steward-inbox.js` | `08-agent-runs.js` | backward | `listAgentRuns`, `readAgentRunEvents` |
| `13i-steward-inbox.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13j-steward-tool-base.js` | `00-boot.js` | backward | `fsp`, `nowIso`, `path`, `safeJsonParse`, `text` |
| `13j-steward-tool-base.js` | `01-config.js` | backward | `atomicWriteJson`, `readFileTail`, `resolvePermissionMode`, `safeSessionId`, `sessionPath` |
| `13j-steward-tool-base.js` | `02-session-store.js` | backward | `applySessionPermissionModeOverride`, `foldTurnSummaries`, `repairMissionChangeTornTail` |
| `13j-steward-tool-base.js` | `06d-memory-domain.js` | backward | `cleanMemoryDate`, `projectKeyForCwd` |
| `13j-steward-tool-base.js` | `06i-steward-core.js` | backward | `STEWARD_CONFIG_SECRET_PATTERN`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `stewardSanitizeText` |
| `13j-steward-tool-base.js` | `13i-steward-inbox.js` | backward | `stewardDir` |
| `13k-steward-threads.js` | `00-boot.js` | backward | `EventStreamHooks`, `fsp`, `nowIso`, `path`, `text` |
| `13k-steward-threads.js` | `01-config.js` | backward | `PERMISSION_MODES`, `WORKSPACE_TABLE_CAP`, `mutateConfig`, `normalizeWorkspacePathString`, `safeSessionId` |
| `13k-steward-threads.js` | `01c-runtime-flags.js` | backward | `sessionSearchIndexEnabled` |
| `13k-steward-threads.js` | `02-session-store.js` | backward | `createSession`, `listSessions`, `loadSession`, `missionIndexAdd`, `readInterventions`, `readMissionContainer`, `saveSession`, `sessionBriefOf`, `sessionDesktopToolsOf`, `sessionDisplayTitle`, `sessionMissionId`, `sessionPermissionModeOf`, `updateSessionMeta` |
| `13k-steward-threads.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent`, `sanitizeFsSegmentName` |
| `13k-steward-threads.js` | `06i-steward-core.js` | backward | `STEWARD_DELIVERABLE_CHARS`, `STEWARD_QUICK_ANSWER_CHARS`, `STEWARD_QUICK_KIND`, `STEWARD_QUICK_QUESTION_CHARS`, `STEWARD_WORKSPACE_TABLE_MAX`, `StewardHooks`, `buildStewardBrief`, `deriveStewardThreadState`, `stewardAsksYouForThread`, `stewardClipSay`, `stewardMayAct`, `stewardMayTightenTo`, `stewardPendingOneLine`, `stewardPermissionLabel`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardThreadStateFromCard`, `stewardWatchedThread`, `waitReasonFor` |
| `13k-steward-threads.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13k-steward-threads.js` | `13b-api-domain-routes.js` | backward | `steerSessionCore` |
| `13k-steward-threads.js` | `13d-core-domain-routes.js` | backward | `buildMissionAggregateRows`, `missionPendingCounts`, `searchSessionsByContent` |
| `13k-steward-threads.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `overlayMissionCard` |
| `13k-steward-threads.js` | `13j-steward-tool-base.js` | backward | `STEWARD_NOTE_PREFIX`, `STEWARD_NOTE_TEXT_MAX`, `STEWARD_PENDING_SUMMARY_MAX`, `STEWARD_QUICK_ASKS_PER_TURN`, `STEWARD_READ_CALLS_PER_TURN`, `STEWARD_READ_CHARS_DEFAULT`, `STEWARD_READ_CHARS_MAX`, `STEWARD_READ_CHARS_MIN`, `STEWARD_READ_CLIP_MARK`, `STEWARD_READ_ROW_OVERHEAD`, `STEWARD_READ_TAIL_DEFAULT`, `STEWARD_READ_TAIL_MAX`, `STEWARD_SEARCH_LIMIT_DEFAULT`, `STEWARD_SEARCH_LIMIT_MAX`, `STEWARD_TITLE_MAX`, `stewardAppendDecision`, `stewardBasisOf`, `stewardClampInt`, `stewardEngineOf`, `stewardFail`, `stewardLastAssistantText`, `stewardQuickClosed`, `stewardQuickThread`, `stewardRawKind`, `stewardReadBucket`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnAssistantText`, `stewardTurnFiles`, `stewardTurnKeyOf`, `stewardTurnQuotaTake` |
| `13l-steward-ops.js` | `00-boot.js` | backward | `fsp`, `makeId`, `nowIso`, `readUsageRows`, `safeJsonParse`, `text`, `usageDayKey` |
| `13l-steward-ops.js` | `01-config.js` | backward | `PERMISSION_MODES_REQUIRING_CONFIRM`, `normalizeConfig`, `safeSessionId` |
| `13l-steward-ops.js` | `02-session-store.js` | backward | `loadSession`, `readInterventions` |
| `13l-steward-ops.js` | `05-claude-engine.js` | backward | `maskProviders` |
| `13l-steward-ops.js` | `06-provider-engine.js` | backward | `collectAudit`, `draftPlaybookFromSession` |
| `13l-steward-ops.js` | `06d-memory-domain.js` | backward | `cleanMemoryDate`, `memoryIsExpired`, `memoryProposalLooksSensitive` |
| `13l-steward-ops.js` | `06i-steward-core.js` | backward | `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_SESSION_ID`, `stewardConfigTierFor`, `stewardMayAct`, `stewardMemoryTerms`, `stewardPermissionLabel`, `stewardSanitizeText`, `stewardStateLabel`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardTermJaccard`, `stewardToolPermanentlyExempt` |
| `13l-steward-ops.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `agentRunFile` |
| `13l-steward-ops.js` | `08-agent-runs.js` | backward | `classifyRunResumeTier`, `listAgentRuns` |
| `13l-steward-ops.js` | `12-tool-dispatch.js` | backward | `buildWorkbenchSelfStatus` |
| `13l-steward-ops.js` | `13-http-router.js` | backward | `applyConfigPatch`, `setSessionSkillsCore` |
| `13l-steward-ops.js` | `13d-core-domain-routes.js` | backward | `agentRunActionCommand`, `buildMissionAggregateRows`, `decideIntervention`, `missionRunDigest` |
| `13l-steward-ops.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13l-steward-ops.js` | `13i-steward-inbox.js` | backward | `stewardInboxRead`, `stewardInboxState` |
| `13l-steward-ops.js` | `13j-steward-tool-base.js` | backward | `STEWARD_AUDIT_LIMIT_DEFAULT`, `STEWARD_AUDIT_LIMIT_MAX`, `STEWARD_MEMORY_MERGED_FROM_MAX`, `STEWARD_PLAYBOOK_DRAFTS_PER_TURN`, `STEWARD_RUNS_MAX`, `STEWARD_STEER_TEXT_MAX`, `stewardAppendDecision`, `stewardBasisOf`, `stewardClampInt`, `stewardFail`, `stewardMemoryScopeMatches`, `stewardMemoryScopeOf`, `stewardMutateMemory`, `stewardNormalizeMemoryScope`, `stewardRawKind`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnQuotaTake` |
| `13l-steward-ops.js` | `13k-steward-threads.js` | backward | `stewardSeatedByUser`, `stewardSeatedFail`, `stewardTriggerOf` |
| `13m-steward-runner-base.js` | `00-boot.js` | backward | `SESSION_SCHEMA`, `nowIso`, `paths` |
| `13m-steward-runner-base.js` | `02-session-store.js` | backward | `loadSession`, `normalizeSessionEngineRoute`, `saveSession`, `sessionEngineRouteFromConfig` |
| `13m-steward-runner-base.js` | `04-permission-runtime.js` | backward | `logEvent`, `stopSession` |
| `13m-steward-runner-base.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES` |
| `13m-steward-runner-base.js` | `06i-steward-core.js` | backward | `STEWARD_PERMISSION_MODE`, `STEWARD_SESSION_ID`, `STEWARD_SESSION_TITLE`, `stewardSanitizeText` |
| `13n-steward-arbiter.js` | `00-boot.js` | backward | `crypto`, `fs`, `path`, `readUsageRows`, `usageDayKey` |
| `13n-steward-arbiter.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13n-steward-arbiter.js` | `02-session-store.js` | backward | `readInterventions`, `recordMissionBudgetTrippedChange` |
| `13n-steward-arbiter.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13n-steward-arbiter.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `stewardSanitizeText`, `waitReasonFor` |
| `13n-steward-arbiter.js` | `13m-steward-runner-base.js` | backward | `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS` |
| `13o-steward-runner-prompt.js` | `00-boot.js` | backward | `path`, `text` |
| `13o-steward-runner-prompt.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13o-steward-runner-prompt.js` | `02-session-store.js` | backward | `readMissionContainer`, `sessionDisplayTitle`, `sessionMissionId` |
| `13o-steward-runner-prompt.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent` |
| `13o-steward-runner-prompt.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13o-steward-runner-prompt.js` | `06i-steward-core.js` | backward | `STEWARD_DIGEST_LIMITS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_SESSION_ID`, `STEWARD_WORKSPACE_TABLE_MAX`, `StewardHooks`, `buildStewardDigestLine`, `deriveStewardThreadState`, `isStewardToolName`, `prerouteText`, `stewardSanitizeText`, `stewardThreadStateFromCard`, `stewardTrimSayAtSentence`, `waitReasonFor` |
| `13o-steward-runner-prompt.js` | `08-agent-runs.js` | backward | `parseStructuredAgentOutput` |
| `13o-steward-runner-prompt.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `overlayMissionCard` |
| `13o-steward-runner-prompt.js` | `13j-steward-tool-base.js` | backward | `stewardMemoryScopeLabel`, `stewardQuickThread`, `stewardRawKind`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode` |
| `13o-steward-runner-prompt.js` | `13k-steward-threads.js` | backward | `stewardSeatedByUser` |
| `13o-steward-runner-prompt.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTIONS_MAX`, `STEWARD_ACTS_MAX`, `STEWARD_ACT_LABEL_MAX`, `STEWARD_DECIDE_LABELS`, `STEWARD_MEMORY_BLOCK_CHARS`, `STEWARD_RUN_ACTION_LABELS`, `STEWARD_SAY_CEILING`, `STEWARD_TOOL_LABELS`, `STEWARD_WHY_MAX`, `stewardRunnerRuntime` |
| `13o-steward-runner-prompt.js` | `13n-steward-arbiter.js` | backward | `stewardArbiterWait` |
| `13p-steward-runner-actions.js` | `00-boot.js` | backward | `readUsageRows`, `text`, `usageDayKey` |
| `13p-steward-runner-actions.js` | `01-config.js` | backward | `safeSessionId` |
| `13p-steward-runner-actions.js` | `02-session-store.js` | backward | `loadSession`, `saveSession`, `sessionDisplayTitle` |
| `13p-steward-runner-actions.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13p-steward-runner-actions.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13p-steward-runner-actions.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardHumanizeIds`, `stewardMayAct`, `stewardPermissionLabel`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStoppedRefusal`, `stewardStoppedTarget` |
| `13p-steward-runner-actions.js` | `13j-steward-tool-base.js` | backward | `stewardFail`, `stewardReadSessionHead`, `stewardThreadPermissionMode` |
| `13p-steward-runner-actions.js` | `13l-steward-ops.js` | backward | `stewardReadRunSnapshot`, `stewardRunResumeTier` |
| `13p-steward-runner-actions.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_ACT_LABEL_MAX`, `STEWARD_INBOX_DELIVERABLE_CHARS`, `STEWARD_INBOX_EVENTS_PER_TURN`, `STEWARD_INBOX_EVENT_CHARS`, `STEWARD_INBOX_MESSAGE_CHARS`, `STEWARD_NO_PROGRESS_MAX`, `STEWARD_SELF_SERVE_ATTEMPT_MAX`, `STEWARD_SELF_SERVE_PER_TURN_MAX`, `STEWARD_SELF_SERVE_RETRY_WINDOW_MS`, `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS`, `stewardFailureExplain`, `stewardRunnerRuntime` |
| `13p-steward-runner-actions.js` | `13o-steward-runner-prompt.js` | backward | `stewardActLabel` |
| `13q-steward-runner-turn.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `fsp`, `nowIso`, `path` |
| `13q-steward-runner-turn.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `13q-steward-runner-turn.js` | `02-session-store.js` | backward | `loadSession`, `normalizeSessionEngineRoute`, `saveSession` |
| `13q-steward-runner-turn.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent`, `normalizeQuestionAnswer`, `pendingPermissions`, `pendingQuestions` |
| `13q-steward-runner-turn.js` | `06i-steward-core.js` | backward | `STEWARD_DIGEST_LIMITS`, `STEWARD_EVENT_KINDS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardPendingOneLine`, `stewardSanitizeText`, `stewardThreadEngineRoute`, `waitReasonFor` |
| `13q-steward-runner-turn.js` | `06j-scheduler-core.js` | backward | `SchedulerHooks` |
| `13q-steward-runner-turn.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13q-steward-runner-turn.js` | `13b-api-domain-routes.js` | backward | `steerSessionCore` |
| `13q-steward-runner-turn.js` | `13d-core-domain-routes.js` | backward | `decideIntervention` |
| `13q-steward-runner-turn.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13q-steward-runner-turn.js` | `13i-steward-inbox.js` | backward | `stewardDir`, `stewardInboxRead` |
| `13q-steward-runner-turn.js` | `13j-steward-tool-base.js` | backward | `_stewardReadBudget`, `stewardFail` |
| `13q-steward-runner-turn.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_DEBOUNCE_MS`, `STEWARD_DIGEST_KIND_TEXT`, `STEWARD_INBOX_EVENTS_PER_TURN`, `STEWARD_PENDING_LIST_MAX`, `STEWARD_PREEMPT_WAIT_MS`, `STEWARD_USER_QUEUE_WAIT_MS`, `STEWARD_VISITS_DIR`, `STEWARD_VISITS_KEEP`, `STEWARD_VISIT_DIGEST_MAX`, `STEWARD_VISIT_SCHEMA`, `ensureStewardSession`, `stewardAbortInflight`, `stewardRunnerRuntime` |
| `13q-steward-runner-turn.js` | `13n-steward-arbiter.js` | backward | `stewardArbiterWait` |
| `13q-steward-runner-turn.js` | `13o-steward-runner-prompt.js` | backward | `stewardParseReply`, `stewardThreadDigestRows` |
| `13q-steward-runner-turn.js` | `13p-steward-runner-actions.js` | backward | `stewardCircuitCheck`, `stewardDowngradeActions`, `stewardExecuteActions`, `stewardHumanizeSay`, `stewardInboxMessage`, `stewardLastAssistantContent`, `stewardNormalizeRouteHint`, `stewardSelfServeInbox`, `stewardStampReply`, `stewardTriggerStamp` |
| `13r-event-stream.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `URL`, `nowIso` |
| `13r-event-stream.js` | `01-config.js` | backward | `safeSessionId` |
| `13r-event-stream.js` | `02-session-store.js` | backward | `readMissionSessionHead`, `sessionMissionId` |
| `13r-event-stream.js` | `04-permission-runtime.js` | backward | `activeChildren`, `subscribeActiveChildEvents` |
| `13r-event-stream.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `deriveStewardThreadState`, `stewardWatchedThread`, `threadOriginOf` |
| `13r-event-stream.js` | `13d-core-domain-routes.js` | backward | `missionPendingCounts` |
| `13s-scheduler.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `URL`, `apiFailure`, `fs`, `fsp`, `json`, `makeId`, `nowIso`, `path`, `paths`, `text` |
| `13s-scheduler.js` | `01-config.js` | backward | `PERMISSION_MODES`, `atomicWriteJson`, `readConfig`, `readJsonBody`, `send` |
| `13s-scheduler.js` | `02-session-store.js` | backward | `createSession`, `loadSession`, `repairMissionChangeTornTail`, `saveSession`, `updateSessionMeta` |
| `13s-scheduler.js` | `04-permission-runtime.js` | backward | `logEvent`, `stopSession` |
| `13s-scheduler.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_LIMITS`, `SCHEDULER_PHASES`, `SchedulerHooks`, `describeSchedule`, `missedOccurrence`, `nextFireAt`, `normalizeSchedulerTask`, `occurrenceKey` |
| `13s-scheduler.js` | `07-autonomy.js` | backward | `schedulerAskWaitSessions` |
| `13s-scheduler.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13t-steward-schedule.js` | `00-boot.js` | backward | `makeId`, `nowIso`, `text` |
| `13t-steward-schedule.js` | `01-config.js` | backward | `readConfig` |
| `13t-steward-schedule.js` | `06i-steward-core.js` | backward | `StewardHooks`, `stewardSanitizeText` |
| `13t-steward-schedule.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_LIMITS`, `SchedulerHooks`, `describeSchedule`, `normalizeSchedulerTask`, `occurrenceKey` |
| `13t-steward-schedule.js` | `13g-steward.js` | backward | `stewardToolHandler` |
| `13t-steward-schedule.js` | `13i-steward-inbox.js` | backward | `stewardAppendInboxRows`, `stewardClipSummary`, `stewardInboxRowDedupeKeys`, `stewardIsoAt`, `stewardLoadState`, `stewardRuntime` |
| `13t-steward-schedule.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardFail` |
| `13t-steward-schedule.js` | `13k-steward-threads.js` | backward | `stewardUnattendedByModel` |
| `13t-steward-schedule.js` | `13s-scheduler.js` | backward | `schedulerClockNow`, `schedulerEmitChanged`, `schedulerEnabled`, `schedulerEnsureTimer`, `schedulerFireOnce`, `schedulerLoad`, `schedulerReadFireRows`, `schedulerRuntime`, `schedulerSaveTasks` |
| `14-main.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `SESSION_SCHEMA`, `createNdjsonLineFeeder`, `hashArgs`, `neutralizeFenceTag` |
| `14-main.js` | `01-config.js` | backward | `AGENT_CLI_TYPES`, `BUILTIN_AGENT_ROLES`, `DurableJsonStore`, `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `autoImportClaudeCodeMcp`, `batchSafeSpawn`, `buildClaudeCliEnv`, `cmdLineBudgetFor`, `decodeClaudeCliText`, `defaultConfig`, `desktopMcpFromInstalledRoot`, `desktopPythonCandidates`, `detectDesktopMcp`, `detectDesktopMcpAsync`, `detectKimiPath`, `ensureDesktopMcpWarm`, `generateMcpConfig`, `generateSessionMcpConfig`, `invalidateAgentCliPathCaches`, `invalidateClaudePathCache`, `normalizeAgentRole`, `normalizeConfig`, `pickPython`, `pickPythonAsync`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `quoteWinArg`, `readConfig`, `readFileTail`, `resolveClaudeLauncher`, `resolvePermissionMode`, `selectedAgentCli`, `spawnCmdLineLength`, `syncMcpServersToKimi` |
| `14-main.js` | `01b-route-auth.js` | backward | `ROUTE_AUTH` |
| `14-main.js` | `01c-runtime-flags.js` | backward | `appendOnlyToolSchemasEnabled`, `budgetGuardDecision`, `budgetGuardEnabled`, `budgetGuardTurnTokens`, `budgetGuardWarnRatio`, `estimateBucketsEnabled`, `evaporateBudgetBoundaryEnabled`, `execResultCacheEnabled`, `execResultCacheMaxEntries`, `historyReadDedupEnabled`, `reseedTailUnitsEnabled`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `summaryEntityCheckEnabled`, `summaryFactTableCap`, `summaryFactTableEnabled`, `summaryPromptI18nEnabled`, `summaryRefineEnabled`, `summarySingleShotEnabled`, `toolByteBudgetShadowBytes`, `toolTimeBudgetEnabled`, `toolTimeBudgetHardMs`, `toolTimeBudgetShadowEnabled`, `toolTimeBudgetWarnMs`, `volatileTailLayoutEnabled` |
| `14-main.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `MISSION_CONTAINER_MAX_FILES`, `MISSION_CONTAINER_SCHEMA`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `collectBridgedWriteTarget`, `collectBridgedWriteTargets`, `compactInterventionJournal`, `configForSessionEngineRoute`, `createMissionContainer`, `createSession`, `deleteSession`, `detectDanglingTurn`, `foldMissionChangeJournalText`, `inferSessionEngineRoute`, `isBridgedWriteTool`, `isUntitledSessionTitle`, `journalGc`, `journalGcProbe`, `journalRecord`, `kindForPath`, `listMissionContainers`, `listSessions`, `liveSessionPermissionMode`, `loadSession`, `missionAttachThread`, `missionChangeFilePath`, `missionDetachThread`, `missionMergeInto`, `missionSplitThreads`, `normalizeSession`, `normalizeSessionEngineRoute`, `patchMissionContainer`, `readInterventionsWithMeta`, `readMissionChangesWithMeta`, `readMissionContainer`, `readSessionHeadResilient`, `readSessionNotes`, `reconcileWorkspaceTurnBaseline`, `repairMissionChangeTornTail`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveSession`, `sessionBodyPaths`, `sessionDisplayTitle`, `sessionEngineRouteFromConfig`, `sessionMeta`, `sessionNotesPath`, `unprefixedBridgedName`, `updateSessionMeta`, `workspaceBaselineIsCodePath`, `writeSessionNotes` |
| `14-main.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `14-main.js` | `03-bridge-guard.js` | backward | `AUTOEXEC_DENYLIST`, `BRIDGED_WRITE_AUDIT_EXEMPT`, `auditBridgedWriteCoverage`, `bridgedOfficeScriptGate`, `buildBrowserOpenSpawn`, `buildCodeEditorSpawn`, `buildOpenSpawn`, `buildRevealSpawn`, `classifyCodeEditorExecutable`, `cwdWarning`, `executableFromAssociationCommand`, `fileAllowedRoots`, `guardFileToolPath`, `guardWorkspaceExecute`, `guardWorkspacePath`, `normalizeAutoexecPath`, `pathWithinAnyRoot`, `pathWithinRoot`, `providerIsLocal`, `readFilePreview`, `resolvePreferredCodeEditor`, `resolveWorkspace`, `workspaceWriteRoots` |
| `14-main.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `14-main.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `McpHttpClient`, `McpStdioClient`, `buildMcpConnectorInventory`, `classifyMcpError`, `collectBridgedTools`, `configureMcpFromTool`, `invalidateMcpDropInCache`, `killAllMcpClients`, `nativeClaudeAgentResultInfo`, `parseAgentCliEvent`, `parseClaudeTaskNotification`, `parseMcpConfigFile`, `probeMcpConnector`, `resolveBridge`, `resolveExternalMcpServers`, `safeMcpInventory`, `safeUrlForDisplay`, `scanMcpDropIns`, `scanMcpSources` |
| `14-main.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `14-main.js` | `05-claude-engine.js` | backward | `applyProviderReasoningEffort`, `maskSecrets`, `providerReasoningEffort`, `sanitizeExternalMcpServer`, `unmaskProviders`, `unmaskSecrets` |
| `14-main.js` | `05b-kimi-bridge.js` | backward | `compactKimiNative`, `consumeKimiAcpApproval`, `isKimiAcpPlanFilePath`, `kimiAcpConcreteEditGuard`, `kimiAcpFreshActualForOperation`, `kimiAcpInferConcreteToolInput`, `kimiAcpModeOptionFromActivated`, `kimiAcpNativeBashWrapperCandidate`, `kimiAcpNativeBashWrapperTexts`, `kimiAcpNativeShellQuote`, `kimiAcpNativeWindowsPathToPosixPath`, `kimiAcpPermissionToolCall`, `kimiAcpSessionRestoreMethods`, `kimiAcpSuccessfulEnterPlanMode`, `kimiAcpToolTier`, `kimiAcpToolUpdateSucceeded`, `kimiAcpUnknownSessionError`, `kimiSessionStatus`, `parseKimiWireAgentEvents`, `parseKimiWireCompaction`, `prepareKimiAcpSpawn`, `readKimiWireRuntime`, `resolveKimiAcpPlanFilePath`, `runKimiCompact`, `stopKimiServer`, `watchKimiWire` |
| `14-main.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES`, `NETWORK_ANCHORS`, `TOOL_ITERATION_BUDGETS`, `TOOL_REQUIRES`, `appendResponseLanguagePolicy`, `appendTurnPolicies`, `auditSummaryFor`, `buildAgentTeamHint`, `buildBrowserAutomationHint`, `buildClaudeNativeAgentPolicy`, `buildMetricsPayload`, `buildPlaybookIndexSection`, `buildPromptTaskContext`, `buildProviderSystemPrompt`, `buildResponseLanguagePolicy`, `buildRuntimeIdentityFacts`, `buildSoftwareEngineeringPolicy`, `buildStableSystemPrompt`, `buildToolCustomizationHint`, `buildVolatileParts`, `clampAppendWithSkills`, `claudeProjectDirKey`, `claudeProjectsRoot`, `collectAudit`, `collectStorageStats`, `evalPlaybookAvailability`, `fenceSafeSlice`, `getCapabilities`, `invalidateCapabilityCache`, `isLongToolTask`, `loadAllPlaybooks`, `maybeRecordStorageTrend`, `maybeWriteThreadBrief`, `networkAnchors`, `normalizeMetricsPath`, `normalizePlaybook`, `normalizeStoragePolicy`, `parsePlaybookDraft`, `parseThreadBrief`, `peekCapabilities`, `probeAny`, `readProjectMemory`, `readStorageTrend`, `recordEngineTranscript`, `recordRequestMetric`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget`, `shrinkFencedSection`, `softwareEngineeringTaskProfile`, `storageSweep`, `toolRequirementsMet` |
| `14-main.js` | `06b-prompt-registry.js` | backward | `PROMPT_PACK_VERSION`, `getPromptPack` |
| `14-main.js` | `06c-agent-loop-hooks.js` | backward | `AgentLoopHooks` |
| `14-main.js` | `06d-memory-domain.js` | backward | `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `buildCoreMemoryPromptSection`, `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `confirmMemoryRelation`, `deleteMemoryRelation`, `effectiveMemorySelection`, `extractMemoryRelationProposals`, `legacyAccMemoryMigrationComplete`, `listMemoryRelations`, `listWorkbenchMemories`, `loadMemoryRegistry`, `memoryProposalIsDuplicate`, `memoryProposalPrefilter`, `memoryProposalSimilarity`, `memorySearchTerms`, `migrateLegacyAccMemory`, `parseMemoryProposalDecision`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `rankRelevantMemories`, `readWorkbenchMemory`, `resolveCoreMemoryState`, `resolveMemoryPreflight`, `saveMemory` |
| `14-main.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `agentResourcesConflict`, `inferToolResources`, `normalizeAgentResource`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources`, `resourceBlockers` |
| `14-main.js` | `06i-steward-core.js` | backward | `STEWARD_BRIEF_LIMITS`, `STEWARD_CONFIG_TIERS`, `STEWARD_DELIVERABLE_CHARS`, `STEWARD_DIGEST_LIMITS`, `STEWARD_EVENT_KINDS`, `STEWARD_EXEMPT_TOOL_PATTERNS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_PERMISSION_MODE`, `STEWARD_PERMISSION_RANK`, `STEWARD_PREROUTE_DEFAULTS`, `STEWARD_QUICK_ANSWER_CHARS`, `STEWARD_QUICK_KIND`, `STEWARD_SESSION_ID`, `STEWARD_SESSION_TITLE`, `STEWARD_THREAD_STATES`, `STEWARD_WAIT_LABELS`, `STEWARD_WAIT_REASONS`, `StewardHooks`, `aggregateMissionState`, `buildStewardBrief`, `buildStewardDigestLine`, `deriveStewardThreadState`, `isStewardToolName`, `prerouteText`, `stewardAsksYou`, `stewardClipSay`, `stewardConfigTierFor`, `stewardHumanizeIds`, `stewardMayAct`, `stewardMayTightenTo`, `stewardMemoryTerms`, `stewardPermissionRank`, `stewardSanitizeBlock`, `stewardStoppedTarget`, `stewardTermJaccard`, `stewardThreadEngineRoute`, `stewardThreadStateFromCard`, `stewardThreadStateRank`, `stewardToolPermanentlyExempt`, `stewardTrimSayAtSentence`, `waitReasonFor` |
| `14-main.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_DEFAULT_POLICY`, `SCHEDULER_DESCRIBE_KEYS`, `SCHEDULER_DOW_KEYS`, `SCHEDULER_FIRE_MODES`, `SCHEDULER_FORBIDDEN_PAYLOAD_KEYS`, `SCHEDULER_LIMITS`, `SCHEDULER_ON_FAILURE`, `SCHEDULER_ON_MISSED`, `SCHEDULER_OUTCOMES`, `SCHEDULER_PAYLOAD_KINDS`, `SCHEDULER_PHASES`, `SCHEDULER_SCHEDULE_KINDS`, `SCHEDULER_TARGET_MODES`, `SchedulerHooks`, `describeSchedule`, `missedOccurrence`, `nextFireAt`, `normalizeSchedulerTask`, `occurrenceKey`, `parseCronExpr` |
| `14-main.js` | `07-autonomy.js` | backward | `NATIVE_TOOL_PACKS`, `NATIVE_TOOL_TIER`, `adaptiveMetaToolSchemas`, `applyAgentWorktree`, `bridgedToolTier`, `buildClaudeAgentDefinitions`, `buildOpenAiTools`, `buildResponsesInputItems`, `buildToolCatalog`, `classifyClaudeSubagentFailure`, `classifyRuntimeToolFailure`, `classifyToolPacks`, `compareToolRetrievalShadow`, `createAgentWorktree`, `createToolLoadingState`, `estimateToolSchemaTokens`, `fetchOpenAiModels`, `finalizeAgentWorktree`, `getAgentRoleLibrary`, `nativeToolGate`, `readClaudeProjectAgentRoles`, `readProjectAgentRoles`, `responsesHistoryWithCompleteToolPairs`, `saveProjectAgentRoles`, `searchToolCatalog`, `toolPackForName` |
| `14-main.js` | `08-agent-runs.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `QUALITY_GATE_OUTPUT_SCHEMA`, `aggregateAgentVote`, `aggregateCoverage`, `autoResumeInterruptedRuns`, `buildNodeEvidenceCatalog`, `dedupeAgentFindings`, `deleteAgentWorkflow`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `formatNodeEvidencePrompt`, `getAgentWorkflows`, `indexNodeEvidence`, `mapPool`, `markInterruptedAgentRuns`, `normalizeAgentGate`, `normalizeAgentWorkflow`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `parseStructuredAgentOutput`, `propagateAssignments`, `purgeNodeEvidence`, `readAgentRunEvents`, `repairJson`, `resolveAgentTeamRoute`, `runWorkspaceHash`, `sanitizeAgentOutputSchema`, `saveAgentWorkflow`, `syncRunEventSeq`, `validateAgentJsonSchema`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `14-main.js` | `09-workflow.js` | backward | `planDiscoveryToolBatchAllowed` |
| `14-main.js` | `09b-replan-ledger.js` | backward | `applyReplanPatch`, `proposeReplanPatch`, `rollbackReplanPatch`, `validateReplanPatch` |
| `14-main.js` | `09d-token-estimation.js` | backward | `CONTEXT_WINDOW_FALLBACK`, `classifyTextForEstimate`, `estimateHistoryTokens`, `fmtTokensServer`, `setEstimateBucketsV1` |
| `14-main.js` | `10-context-governance.js` | backward | `COMPACT_MARKER_MIN_SAVED_TOKENS`, `COMPACT_RESEED_TAIL_MAX_TOKENS`, `CompactionPlan`, `MODEL_CONTEXT_TABLE`, `agentConversationContextMeta`, `appendPromptToLastUserMessage`, `applySummaryCallPolicy`, `buildObservationRecallPrompt`, `buildSessionNotesInjectPrompt`, `buildSummaryFactTableMessages`, `buildSummaryRefineMessages`, `calibratedEstimate`, `checkSummaryEntities`, `chunkHistoryByBudget`, `compactHistoryFromSession`, `configuredConversationWindow`, `contextWindowFromTable`, `contextWindowOverrideKey`, `dedupeRepeatedReads`, `estimateFactor`, `evaporateBudgetBoundary`, `evaporateHistory`, `extractContextLength`, `extractSessionNotes`, `extractSummaryEntities`, `fileReadDedupKey`, `fitHistoryForSummary`, `historyStartsWithCompactionSummary`, `historyUnitStarts`, `isContextOverflowError`, `learnedWindowCap`, `mapSummaryWithLimit`, `maybeWriteSessionNotes`, `measureObservationReductionShadow`, `mergeSessionNotes`, `noteEstimateSample`, `noteWindowOvershoot`, `openCompactMarker`, `parseSessionNotesMarkdown`, `providerContextWindow`, `providerConversationContextWindow`, `providerSummaryCall`, `recentTurnsBoundary`, `reduceObservationContent`, `rehydrateObservation`, `renderSessionNotesMarkdown`, `resolveCompactionProvider`, `resolveContextWindow`, `resolveSummaryCallPolicy`, `runSessionTurn`, `summaryMaxConcurrent`, `summaryPromptWithGuidance`, `summarySingleShotCap`, `summarySingleShotReserveTokens`, `upsertCompactMarker`, `validateStructuredSummary`, `writeHistorySnapshot` |
| `14-main.js` | `11-native-tools.js` | backward | `builtinSearch`, `classifyFetchError`, `crc32`, `embeddedIpv4FromV6`, `extractMainText`, `httpGetGuarded`, `isPrivateIpv4`, `parseBaiduHtml`, `parseBingHtml`, `readWebCache`, `ssrfCheck`, `webCachePath`, `webFetch`, `webFetchFailMessage`, `webSearch`, `writeWebCache`, `zipCollectEntries` |
| `14-main.js` | `12-tool-dispatch.js` | backward | `buildWorkbenchSelfStatus` |
| `14-main.js` | `13-http-router.js` | backward | `doctor`, `installIntegration`, `parseArgs`, `startMcp`, `startServer` |
| `14-main.js` | `13d-core-domain-routes.js` | backward | `agentRunActionCommand` |
| `14-main.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `pretenderIndexPath`, `warmPretenderProjectionIndex` |
| `14-main.js` | `13i-steward-inbox.js` | backward | `STEWARD_SOURCE_EVENT_MAP`, `startStewardInbox`, `stewardEventDedupeKey`, `stewardInboxRowDedupeKeys`, `stewardMergeInboxEvents`, `stewardNormalizeBudgetExhausted`, `stewardNormalizeMissionChange`, `stewardNormalizePendingIntervention`, `stewardNormalizeRunEvent`, `stopStewardInbox` |
| `14-main.js` | `13m-steward-runner-base.js` | backward | `STEWARD_INBOX_DELIVERABLE_CHARS`, `STEWARD_INBOX_MESSAGE_CHARS`, `STEWARD_SAY_CEILING`, `STEWARD_SAY_TARGET`, `ensureStewardSession`, `stewardFailureExplain`, `stewardResolveRoute` |
| `14-main.js` | `13o-steward-runner-prompt.js` | backward | `buildStewardSystemPrompt`, `stewardContextBudget`, `stewardParseReply`, `stewardPreroute` |
| `14-main.js` | `13p-steward-runner-actions.js` | backward | `stewardCircuitCheck` |
| `14-main.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn`, `stewardVisit`, `stewardVisitDigest` |
| `14-main.js` | `13s-scheduler.js` | backward | `schedulerRuntimeSnapshot`, `startScheduler`, `stopScheduler` |

## 强连通分量

1. `00-boot.js` ↔ `01-config.js` ↔ `02-session-store.js` ↔ `03-bridge-guard.js` ↔ `04-desktop-shell.js` ↔ `04-permission-runtime.js` ↔ `04-visual-pipeline.js` ↔ `05-claude-engine.js` ↔ `05b-kimi-bridge.js` ↔ `05c-kimi-search-policy.js` ↔ `05d-kimi-prompt-parts.js` ↔ `06-provider-engine.js` ↔ `06b-prompt-registry.js` ↔ `06c-agent-loop-hooks.js` ↔ `06d-memory-domain.js` ↔ `06e-mission-domain.js` ↔ `06f-autonomy-grants.js` ↔ `06g-resource-leases.js` ↔ `07-autonomy.js` ↔ `08-agent-runs.js` ↔ `09-workflow.js` ↔ `09b-replan-ledger.js` ↔ `09d-token-estimation.js` ↔ `10-context-governance.js` ↔ `11-native-tools.js` ↔ `13-http-router.js` ↔ `13b-api-domain-routes.js` ↔ `13c-overlay-routes.js` ↔ `13d-core-domain-routes.js` ↔ `13e-pretender-index.js` ↔ `13f-native-tool-schemas.js` ↔ `13s-scheduler.js`

## 维护规则

- 源码新增或删除跨模块引用时，契约与本图必须同步更新；`--check`/CI 会拒绝漂移。
- 重复顶层导出名始终拒绝。循环边和前向边只能减少；若确需增加，必须显式修改 `module-dependency-policy.json` 并说明理由。
- 隔离批次优先把内部符号收进命名空间，只暴露真实公共面；每批保持拼接顺序和运行语义。
