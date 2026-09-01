# 后端模块依赖图（第 103b／104 波）

> 本文件由 `node dev-harness/module-dependency-graph.js --write` 从 `app/src/manifest.json` 与源码生成。请勿手改。
> `provides/requires` 是构建期拼接作用域的显式契约；运行时仍执行单文件 `app/server.js`。

## 摘要

| 模块 | 顶层符号 | 跨模块符号引用 | 模块边 | 前向边 | 重复导出 | 强连通分量 |
|---:|---:|---:|---:|---:|---:|---:|
| 30 | 1419 | 1578 | 240 | 65 | 0 | 1 |

“前向边”表示较早拼接的模块引用较晚模块，依赖函数提升或延迟执行；它不是自动判错，但已由债务上限锁住，禁止无评审增加。

## 模块清单

| # | 模块 | 层 | provides | requires | 直接依赖 |
|---:|---|---|---:|---:|---:|
| 0 | `00-boot.js` | bootstrap | 49 | 5 | 4 |
| 1 | `01-config.js` | foundation | 99 | 34 | 7 |
| 2 | `02-session-store.js` | foundation | 175 | 40 | 12 |
| 3 | `03-bridge-guard.js` | foundation | 71 | 20 | 5 |
| 4 | `04-visual-pipeline.js` | foundation | 1 | 2 | 1 |
| 5 | `04-permission-runtime.js` | foundation | 88 | 28 | 7 |
| 6 | `04-desktop-shell.js` | foundation | 1 | 7 | 3 |
| 7 | `05-claude-engine.js` | engine | 23 | 93 | 14 |
| 8 | `05b-kimi-bridge.js` | engine | 119 | 62 | 12 |
| 9 | `05c-kimi-search-policy.js` | engine | 42 | 11 | 2 |
| 10 | `05d-kimi-prompt-parts.js` | engine | 15 | 4 | 2 |
| 11 | `06-provider-engine.js` | engine | 94 | 40 | 11 |
| 12 | `06b-prompt-registry.js` | engine | 4 | 1 | 1 |
| 13 | `06c-agent-loop-hooks.js` | engine | 1 | 3 | 2 |
| 14 | `06d-memory-domain.js` | engine | 93 | 23 | 8 |
| 15 | `06e-mission-domain.js` | engine | 3 | 11 | 5 |
| 16 | `06f-autonomy-grants.js` | engine | 25 | 11 | 5 |
| 17 | `06g-resource-leases.js` | engine | 16 | 5 | 3 |
| 18 | `07-autonomy.js` | orchestration | 85 | 53 | 11 |
| 19 | `08-agent-runs.js` | orchestration | 87 | 79 | 14 |
| 20 | `09-workflow.js` | orchestration | 26 | 176 | 17 |
| 21 | `10-context-governance.js` | orchestration | 95 | 57 | 11 |
| 22 | `11-native-tools.js` | tools | 85 | 22 | 5 |
| 23 | `12-tool-dispatch.js` | tools | 19 | 69 | 10 |
| 24 | `13-http-router.js` | transport | 34 | 197 | 20 |
| 25 | `13b-api-domain-routes.js` | transport | 4 | 37 | 7 |
| 26 | `13c-overlay-routes.js` | transport | 11 | 12 | 3 |
| 27 | `13d-core-domain-routes.js` | transport | 17 | 80 | 10 |
| 28 | `13e-pretender-index.js` | transport | 36 | 24 | 7 |
| 29 | `14-main.js` | entrypoint | 1 | 372 | 21 |

## 模块边

| 调用方 | 提供方 | 方向 | 符号 |
|---|---|---|---|
| `00-boot.js` | `01-config.js` | forward | `readConfig` |
| `00-boot.js` | `02-session-store.js` | forward | `bumpMissionChangeSeq`, `readSessionIndex` |
| `00-boot.js` | `05-claude-engine.js` | forward | `CLAUDE_ENDPOINT_PRESETS` |
| `00-boot.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `01-config.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `DEFAULT_PORT`, `MAX_BODY_BYTES`, `SKILL_ID_RE`, `URL`, `VERSION`, `apiFailure`, `cp`, `crypto`, `ensureDirs`, `externalRoot`, `fs`, `fsp`, `isPkg`, `normalizePricing`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `01-config.js` | `03-bridge-guard.js` | forward | `existsExecutable`, `pathWithinRoot` |
| `01-config.js` | `04-desktop-shell.js` | forward | `DesktopShell` |
| `01-config.js` | `04-permission-runtime.js` | forward | `activeChildren`, `logEvent`, `resolveExternalMcpServers`, `scanMcpSources` |
| `01-config.js` | `05-claude-engine.js` | forward | `sanitizeExternalMcpServer`, `sanitizeProvider` |
| `01-config.js` | `06-provider-engine.js` | forward | `normalizeStoragePolicy` |
| `01-config.js` | `07-autonomy.js` | forward | `TOOL_PACK_DESCRIPTIONS`, `claudePermissionMode`, `getAgentRoleLibrary`, `nativeToolTier` |
| `02-session-store.js` | `00-boot.js` | backward | `SESSION_SCHEMA`, `SKILL_ID_RE`, `crypto`, `ensureDirs`, `fs`, `fsp`, `makeId`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text`, `zlib` |
| `02-session-store.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath`, `sessionWriteChains` |
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
| `04-permission-runtime.js` | `01-config.js` | backward | `batchSafeSpawn`, `detectDesktopMcp`, `readConfig`, `selectedAgentCli`, `writeConfig` |
| `04-permission-runtime.js` | `02-session-store.js` | backward | `registerIntervention`, `settleIntervention` |
| `04-permission-runtime.js` | `05-claude-engine.js` | forward | `maskKey`, `sanitizeExternalMcpServer` |
| `04-permission-runtime.js` | `06d-memory-domain.js` | forward | `legacyAccMemoryMigrationComplete` |
| `04-permission-runtime.js` | `13-http-router.js` | forward | `MCP_TOOLS` |
| `04-permission-runtime.js` | `13d-core-domain-routes.js` | forward | `decideIntervention` |
| `04-visual-pipeline.js` | `00-boot.js` | backward | `fsp`, `path` |
| `05-claude-engine.js` | `00-boot.js` | backward | `URL`, `appendUsageLedger`, `claudeCostFields`, `cp`, `crypto`, `fsp`, `normalizePricing`, `nowIso`, `path`, `paths`, `safeJsonParse` |
| `05-claude-engine.js` | `01-config.js` | backward | `CLAUDE_PERMISSION_MODE_MAP`, `CMD_EXE_LINE_LIMIT`, `CMD_LINE_QUOTE_MARGIN`, `RUNTIME`, `buildUserEnvelope`, `cmdLineBudgetFor`, `cmdLineBudgetSeam`, `decodeClaudeCliText`, `effectiveAnthropicEnv`, `generateSessionMcpConfig`, `isAskUserTool`, `isBatchLauncher`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `quoteWinArg`, `readConfig`, `selectedAgentCli`, `spawnCmdLineLength`, `syncMcpServersToKimi`, `writeToChild` |
| `05-claude-engine.js` | `02-session-store.js` | backward | `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `createTurnSegmentBuilder`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `reconcileWorkspaceTurnBaseline`, `saveSession` |
| `05-claude-engine.js` | `03-bridge-guard.js` | backward | `buildAttachmentPrompt`, `cwdWarning`, `normalizeCwd` |
| `05-claude-engine.js` | `04-permission-runtime.js` | backward | `activeChildren`, `buildClaudeRecoveryHistory`, `claudeProviderTailSince`, `claudeResumeRouteKey`, `clearPendingPermissions`, `clearPendingQuestions`, `formatQuestionGuidance`, `hasPendingQuestionForSession`, `isClaudeResumeMissingError`, `killChildTree`, `lastAssistantEngine`, `lastSuccessfulClaudeModel`, `logEvent`, `nativeClaudeAgentResultInfo`, `parseAgentCliEvent`, `redact`, `registerUserQuestion`, `sameClaudeResumeCwd`, `stopSession` |
| `05-claude-engine.js` | `05b-kimi-bridge.js` | forward | `maybeAutoCompactAgentSession`, `runKimiAcpTurnPrepared`, `syncKimiSessionUsage`, `syncKimiTurnPreferences`, `watchKimiWire` |
| `05-claude-engine.js` | `06-provider-engine.js` | forward | `appendMemorySection`, `appendTurnPolicies`, `buildBrowserAutomationHint`, `buildPromptTaskContext`, `buildSkillsPromptSection`, `buildToolCustomizationHint`, `engineTranscriptCwd`, `fenceSafeSlice`, `getCapabilities`, `softwareEngineeringTaskProfile` |
| `05-claude-engine.js` | `06b-prompt-registry.js` | forward | `PROMPT_PACK_VERSION`, `getPromptPack` |
| `05-claude-engine.js` | `06c-agent-loop-hooks.js` | forward | `AgentLoopHooks` |
| `05-claude-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `memoryGlobalDir`, `memoryProjectDir`, `resolveMemoryPreflight` |
| `05-claude-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `05-claude-engine.js` | `07-autonomy.js` | forward | `buildClaudeAgentDefinitions`, `classifyToolPacks` |
| `05-claude-engine.js` | `08-agent-runs.js` | forward | `buildOrchestrateHint`, `getAgentWorkflows` |
| `05-claude-engine.js` | `13-http-router.js` | forward | `buildModelHint` |
| `05b-kimi-bridge.js` | `00-boot.js` | backward | `MAX_BODY_BYTES`, `StringDecoder`, `URL`, `cp`, `dataRoot`, `externalRoot`, `fs`, `fsp`, `http`, `makeId`, `nowIso`, `os`, `path`, `pathToFileURL`, `paths`, `safeJsonParse`, `text` |
| `05b-kimi-bridge.js` | `01-config.js` | backward | `RUNTIME`, `decodeClaudeCliText`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `readConfig`, `selectedAgentCli`, `syncMcpServersToKimi` |
| `05b-kimi-bridge.js` | `02-session-store.js` | backward | `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `normalizeTodoItems`, `reconcileWorkspaceTurnBaseline`, `saveSession` |
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
| `06-provider-engine.js` | `00-boot.js` | backward | `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `cp`, `crypto`, `externalRoot`, `fs`, `fsp`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text`, `zlib` |
| `06-provider-engine.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06-provider-engine.js` | `02-session-store.js` | backward | `SESSION_INDEX_FILE`, `loadSession` |
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
| `06d-memory-domain.js` | `00-boot.js` | backward | `SKILL_ID_RE`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fs`, `fsp`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `06d-memory-domain.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06d-memory-domain.js` | `02-session-store.js` | backward | `loadSession` |
| `06d-memory-domain.js` | `03-bridge-guard.js` | backward | `normalizeCwd` |
| `06d-memory-domain.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent` |
| `06d-memory-domain.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider` |
| `06d-memory-domain.js` | `06-provider-engine.js` | backward | `providerRawCompletion` |
| `06d-memory-domain.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `06e-mission-domain.js` | `00-boot.js` | backward | `nowIso`, `text` |
| `06e-mission-domain.js` | `02-session-store.js` | backward | `MISSION_MAX_TEXT`, `MISSION_STALL_LIMIT`, `evaluateMissionCheck`, `maybeFinalizeMission`, `missionProgressDigest`, `saveSession` |
| `06e-mission-domain.js` | `03-bridge-guard.js` | backward | `normalizeCwd` |
| `06e-mission-domain.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `06e-mission-domain.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `06f-autonomy-grants.js` | `00-boot.js` | backward | `crypto`, `fsp`, `makeId`, `path` |
| `06f-autonomy-grants.js` | `03-bridge-guard.js` | backward | `isSensitiveDataPath`, `normalizeCwd`, `pathWithinRoot` |
| `06f-autonomy-grants.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `06f-autonomy-grants.js` | `07-autonomy.js` | forward | `NATIVE_TOOL_TIER`, `nativeToolTier` |
| `06f-autonomy-grants.js` | `11-native-tools.js` | forward | `globToRegExp` |
| `06g-resource-leases.js` | `00-boot.js` | backward | `makeId`, `nowIso`, `path` |
| `06g-resource-leases.js` | `02-session-store.js` | backward | `collectBridgedWriteTargets` |
| `06g-resource-leases.js` | `03-bridge-guard.js` | backward | `pathWithinRoot` |
| `07-autonomy.js` | `00-boot.js` | backward | `URL`, `appendUsageLedger`, `claudeCostFields`, `cp`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `07-autonomy.js` | `01-config.js` | backward | `BUILTIN_AGENT_ROLES`, `CLAUDE_PERMISSION_MODE_MAP`, `atomicWriteJson`, `batchSafeSpawn`, `buildUserEnvelope`, `cmdLineBudgetFor`, `decodeClaudeCliText`, `detectClaudePath`, `effectiveAnthropicEnv`, `generateAgentNodeMcpConfig`, `mergeAgentRole`, `normalizeAgentRole`, `observationRecallEnabled`, `safeSessionId`, `spawnCmdLineLength` |
| `07-autonomy.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `registerIntervention`, `repairProviderHistoryPairing`, `saveSession`, `settleIntervention`, `unprefixedBridgedName` |
| `07-autonomy.js` | `03-bridge-guard.js` | backward | `existsExecutable`, `normalizeCwd`, `pathWithinRoot` |
| `07-autonomy.js` | `04-permission-runtime.js` | backward | `killChildTree`, `parseClaudeEvent`, `pendingPermissions`, `pendingPlans`, `redact`, `resolveBridge`, `runAutomaticInterventionDecision` |
| `07-autonomy.js` | `05-claude-engine.js` | backward | `providerBaseWithV1` |
| `07-autonomy.js` | `06-provider-engine.js` | backward | `appendResponseLanguagePolicy`, `toolRequirementsMet` |
| `07-autonomy.js` | `08-agent-runs.js` | forward | `saveAgentRun` |
| `07-autonomy.js` | `09-workflow.js` | forward | `estimateTextTokens` |
| `07-autonomy.js` | `10-context-governance.js` | forward | `CONTEXT_OVERFLOW_PATTERNS`, `cacheContextLength`, `extractContextLength`, `isContextOverflowError` |
| `07-autonomy.js` | `13-http-router.js` | forward | `MCP_TOOLS` |
| `08-agent-runs.js` | `00-boot.js` | backward | `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text`, `zlib` |
| `08-agent-runs.js` | `01-config.js` | backward | `atomicWriteJson`, `estimateBucketsEnabled`, `readConfig`, `safeSessionId` |
| `08-agent-runs.js` | `02-session-store.js` | backward | `bridgedWriteRelativePathArg`, `loadSession`, `readInterventions`, `registerIntervention`, `saveSession`, `settleIntervention` |
| `08-agent-runs.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `guardWorkspacePath`, `journalBridgedWrite`, `normalizeCwd` |
| `08-agent-runs.js` | `04-permission-runtime.js` | backward | `collectBridgedTools`, `getBridgedClient`, `logEvent`, `redact`, `resolveBridge` |
| `08-agent-runs.js` | `05-claude-engine.js` | backward | `applyProviderReasoningEffort`, `providerBaseWithV1`, `providerResponsesBase`, `resolveProvider` |
| `08-agent-runs.js` | `06-provider-engine.js` | backward | `TOOL_ITERATION_BUDGETS`, `appendResponseLanguagePolicy`, `buildProviderSystemPrompt`, `getCapabilities`, `readProjectMemory`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget` |
| `08-agent-runs.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease` |
| `08-agent-runs.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `agentRunDir`, `agentRunFile`, `agentRunWriteChains`, `bridgedToolTier`, `buildOpenAiTools`, `classifyToolPacks`, `fetchOpenAiModels`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `nativeToolTier`, `neutralizeInjectedPrefixes`, `openAiStreamOnce`, `runClaudeSubAgentOnce`, `toResponsesTools`, `toolPackForName` |
| `08-agent-runs.js` | `09-workflow.js` | forward | `estimateContentTokens`, `estimateHistoryTokens`, `launchPersistedAgentRun`, `setEstimateBucketsV1` |
| `08-agent-runs.js` | `10-context-governance.js` | forward | `CompactionPlan`, `evaporateHistory`, `isContextOverflowError`, `maybeCompactSubHistory`, `noteWindowOvershoot`, `providerSummaryCall`, `recordCompactUsage`, `truncateToolResult` |
| `08-agent-runs.js` | `11-native-tools.js` | forward | `httpGetGuarded`, `ssrfCheck` |
| `08-agent-runs.js` | `13-http-router.js` | forward | `resolveNodeModel` |
| `08-agent-runs.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `09-workflow.js` | `00-boot.js` | backward | `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `makeId`, `nowIso`, `safeJsonParse`, `text` |
| `09-workflow.js` | `01-config.js` | backward | `estimateBucketsEnabled`, `readConfig`, `safeSessionId`, `sessionNotesInjectEnabled` |
| `09-workflow.js` | `02-session-store.js` | backward | `applyMissionUpdate`, `bridgedWriteRelativePathArg`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `createTurnSegmentBuilder`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `normalizeTodoItems`, `readSessionNotes`, `reconcileWorkspaceTurnBaseline`, `registerIntervention`, `repairProviderHistoryPairing`, `saveSession`, `settleIntervention` |
| `09-workflow.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `buildAttachmentPrompt`, `cwdWarning`, `journalBridgedWrite`, `normalizeCwd` |
| `09-workflow.js` | `04-permission-runtime.js` | backward | `activeChildren`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `collectBridgedTools`, `getBridgedClient`, `hasPendingQuestionForSession`, `lastAssistantEngine`, `logEvent`, `redact`, `requestUserQuestion`, `resolveBridge`, `stopSession` |
| `09-workflow.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `09-workflow.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `applyProviderReasoningEffort`, `providerBaseWithV1`, `providerResponsesBase`, `resolveProvider`, `stripUrlUserinfo` |
| `09-workflow.js` | `06-provider-engine.js` | backward | `appendTurnPolicies`, `buildPromptTaskContext`, `buildStableSystemPrompt`, `buildVolatileParts`, `getCapabilities`, `readProjectMemory`, `repairNodeJsonViaProvider`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget`, `softwareEngineeringTaskProfile` |
| `09-workflow.js` | `06b-prompt-registry.js` | backward | `PROMPT_PACK_VERSION`, `getPromptPack` |
| `09-workflow.js` | `06c-agent-loop-hooks.js` | backward | `AgentLoopHooks` |
| `09-workflow.js` | `06d-memory-domain.js` | backward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `extractMemoryRelationProposals`, `proposeMemoryRelation`, `resolveMemoryPreflight` |
| `09-workflow.js` | `06f-autonomy-grants.js` | backward | `consumeGrant` |
| `09-workflow.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources` |
| `09-workflow.js` | `07-autonomy.js` | backward | `ACTION_VIEW_MIN_CHARS`, `ACTION_VIEW_TOOLS`, `MAIL_GLOBAL_MAX`, `MAIL_PER_SENDER_MAX`, `MAIL_QUEUE_MAX`, `MAIL_TEXT_MAX`, `POOL_CHAIN_MAX`, `POOL_GRACE_MS`, `POOL_MAX_TOTAL`, `actionTargetMeta`, `activeAgentRuns`, `agentRunFile`, `bridgedToolTier`, `buildOpenAiTools`, `classifyRuntimeToolFailure`, `cleanupAgentWorktree`, `compareToolRetrievalShadow`, `createAgentWorktree`, `createToolLoadingState`, `drainSteerQueue`, `estimateToolSchemaTokens`, `failoverStickyBase`, `finalizeAgentWorktree`, `getAgentRoleLibrary`, `looksLikePlan`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `nativeToolTier`, `openAiStreamOnce`, `projectActionModelView`, `requestNativePermission`, `requestPlanApproval`, `resumeInFlight`, `toResponsesTools` |
| `09-workflow.js` | `08-agent-runs.js` | backward | `accumulateRunUsage`, `agentRunSaveFailures`, `aggregateAgentVote`, `aggregateCoverage`, `appendAgentRunEvent`, `buildOrchestrateHint`, `buildUpstreamContext`, `bumpRunIntervention`, `classifyNodeErrorText`, `computeSchedulerStep`, `dedupeAgentFindings`, `deriveNodeOutputs`, `evalWaitCondition`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `formatNodeEvidencePrompt`, `getAgentWorkflows`, `indexNodeEvidence`, `materializePoolItem`, `nodeDeliveryEligibility`, `normalizeAgentGate`, `normalizeWaitSpec`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `parseStructuredAgentOutput`, `poolChainDepth`, `propagateAssignments`, `purgeNodeEvidence`, `recordAgentNodeProgress`, `resolveAgentTeamRoute`, `resolveOrchestrateNodes`, `runSubAgent`, `sanitizeAgentOutputSchema`, `saveAgentRun`, `summarizeAgentWorkflowRun`, `syncRunEventSeq`, `validateAgentJsonSchema`, `verdictPasses`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `09-workflow.js` | `10-context-governance.js` | forward | `CompactionPlan`, `ESTIMATION_RULES`, `appendPromptToLastUserMessage`, `buildObservationRecallPrompt`, `buildSessionNotesInjectPrompt`, `contextWindowFromTable`, `evaporateHistory`, `historyStartsWithCompactionSummary`, `isContextOverflowError`, `maybeAutoCompact`, `measureObservationReductionShadow`, `noteEstimateSample`, `noteWindowOvershoot`, `providerContextWindow`, `providerSummaryCall`, `recordCompactUsage`, `truncateToolResult`, `upsertCompactMarker`, `writeHistorySnapshot` |
| `09-workflow.js` | `13-http-router.js` | forward | `buildModelHint`, `resolveNodeModel` |
| `10-context-governance.js` | `00-boot.js` | backward | `URL`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fs`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `text`, `zlib` |
| `10-context-governance.js` | `01-config.js` | backward | `DurableJsonStore`, `PERMISSION_MODES`, `observationRecallEnabled`, `readConfig`, `readJsonBody`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `summaryEntityCheckEnabled` |
| `10-context-governance.js` | `02-session-store.js` | backward | `configForSessionEngineRoute`, `createSession`, `inferSessionEngineRoute`, `journalBytesAdjust`, `journalDir`, `journalGc`, `loadSession`, `readSessionNotes`, `saveSession`, `withJournalWriteLock`, `writeSessionNotes` |
| `10-context-governance.js` | `04-permission-runtime.js` | backward | `driverAutoSessions`, `logEvent`, `redact`, `stopSession`, `turnSettlers` |
| `10-context-governance.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `applyProviderReasoningEffort`, `providerBaseWithV1`, `providerResponsesBase`, `runClaudeTurn` |
| `10-context-governance.js` | `05b-kimi-bridge.js` | backward | `kimiContextWindow` |
| `10-context-governance.js` | `06-provider-engine.js` | backward | `buildProviderSystemPrompt` |
| `10-context-governance.js` | `06e-mission-domain.js` | backward | `runMissionDriver` |
| `10-context-governance.js` | `06f-autonomy-grants.js` | backward | `activeDriverRuns`, `bindDriverRun`, `revokeGrantsForRun` |
| `10-context-governance.js` | `07-autonomy.js` | backward | `buildResponsesInputItems`, `fetchOpenAiModels` |
| `10-context-governance.js` | `09-workflow.js` | backward | `CONTEXT_WINDOW_FALLBACK`, `EVAPORATED_PREFIX`, `estimateContentTokens`, `estimateHistoryTokens`, `fmtTokensServer`, `runOpenAiTurn` |
| `11-native-tools.js` | `00-boot.js` | backward | `URL`, `appRoot`, `cp`, `crypto`, `fs`, `fsp`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text`, `zlib` |
| `11-native-tools.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig` |
| `11-native-tools.js` | `03-bridge-guard.js` | backward | `ensureDataRootReal`, `existsExecutable`, `isSensitiveDataPath` |
| `11-native-tools.js` | `04-permission-runtime.js` | backward | `killChildTree` |
| `11-native-tools.js` | `06-provider-engine.js` | backward | `markNetworkOnline`, `networkAnchors`, `probeAny` |
| `12-tool-dispatch.js` | `00-boot.js` | backward | `OVERLAY_ID`, `SKILL_ID_RE`, `cp`, `crypto`, `externalRoot`, `fs`, `fsp`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `12-tool-dispatch.js` | `01-config.js` | backward | `RUNTIME`, `commandForSelfMcp`, `defaultConfig`, `externalServerJs`, `observationRecallEnabled`, `probeAgentCliLauncher`, `readConfig`, `selectedAgentCli`, `staticBase` |
| `12-tool-dispatch.js` | `02-session-store.js` | backward | `bridgedWriteRelativePathArg`, `journalDropEntries`, `journalRecord`, `journalSessionCtx`, `loadSession`, `normalizeTodoItems` |
| `12-tool-dispatch.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `buildOpenSpawn`, `guardFileToolPath`, `isSensitiveDataPath`, `journalBridgedWrite`, `normalizeCwd`, `pathWithinRoot`, `realpathForContainment` |
| `12-tool-dispatch.js` | `04-permission-runtime.js` | backward | `configureMcpFromTool`, `getBridgedClient`, `logEvent`, `resolveBridge`, `safeMcpInventory` |
| `12-tool-dispatch.js` | `06-provider-engine.js` | backward | `PLAYBOOK_REQUIRES`, `evalPlaybookAvailability`, `getCapabilities`, `loadAllPlaybooks` |
| `12-tool-dispatch.js` | `06d-memory-domain.js` | backward | `listWorkbenchMemories`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `readWorkbenchMemory` |
| `12-tool-dispatch.js` | `07-autonomy.js` | backward | `bridgedToolTier`, `compareToolRetrievalShadow`, `listCompactTools`, `searchToolCatalog` |
| `12-tool-dispatch.js` | `10-context-governance.js` | backward | `rehydrateObservation` |
| `12-tool-dispatch.js` | `11-native-tools.js` | backward | `ZIP_MAX_SINGLE_FILE`, `ZIP_MAX_TOTAL`, `globToRegExp`, `httpGetGuarded`, `httpRequest`, `isBinaryReadPath`, `levenshtein`, `readIfExists`, `searchFileContent`, `ssrfCheck`, `walkFiles`, `webFetch`, `webSearch`, `zipCollectEntries` |
| `13-http-router.js` | `00-boot.js` | backward | `APP_NAME`, `CONFIG_SCHEMA`, `DEFAULT_PORT`, `OVERLAY_ID`, `SKILL_ID_RE`, `URL`, `VERSION`, `apiFailure`, `appendUsageLedger`, `buildUsageSummary`, `cp`, `crypto`, `ensureDirs`, `exePath`, `externalRoot`, `fs`, `fsp`, `http`, `isPkg`, `json`, `makeId`, `nowIso`, `os`, `path`, `paths`, `readline`, `safeJsonParse`, `text`, `zlib` |
| `13-http-router.js` | `01-config.js` | backward | `AGENT_CLI_TYPES`, `BUILTIN_AGENT_ROLES`, `PERMISSION_MODES`, `RUNTIME`, `atomicWriteJson`, `authorizeRoute`, `autoImportClaudeCodeMcp`, `contentTypeFor`, `decodeClaudeCliText`, `detectClaudePath`, `detectDesktopMcp`, `detectKimiPath`, `effectiveAnthropicEnv`, `externalServerJs`, `generateMcpConfig`, `hostAllowed`, `invalidateAgentCliPathCaches`, `normalizeAgentRole`, `observationRecallEnabled`, `prepareAgentCliSpawn`, `readConfig`, `readJsonBody`, `safeSessionId`, `selectedAgentCli`, `send`, `sendError`, `serveStatic`, `syncAgentRolesToClaude`, `syncClaudeCliSettings`, `syncMcpServersToClaude`, `syncMcpServersToKimi`, `tokenOk`, `writeConfig` |
| `13-http-router.js` | `02-session-store.js` | backward | `MISSION_MAX_TEXT`, `applyMissionUpdate`, `bumpMissionChangeSeq`, `configForSessionEngineRoute`, `evaluateMissionCheck`, `flushSessionIndexSync`, `invalidateSessionIndex`, `journalDir`, `journalReadIndex`, `loadSession`, `markInterruptedInterventions`, `maybeFinalizeMission`, `missionControlCommand`, `normalizeMission`, `normalizeTodoItems`, `saveSession`, `workspaceBaselineIsCodePath`, `workspaceBaselinePathKey` |
| `13-http-router.js` | `03-bridge-guard.js` | backward | `PREVIEW_TEXT_EXTS`, `buildCodeEditorSpawn`, `buildRevealSpawn`, `ensureDataRootReal`, `existsExecutable`, `fileAllowedRoots`, `guardWorkspacePath`, `isSensitiveDataPath`, `launchCodeEditor`, `materializeCheckpointEditorDiff`, `normalizeCwd`, `pathWithinAnyRoot`, `pathWithinRoot`, `readFilePreview`, `resolvePreferredCodeEditor`, `resolveWorkspace` |
| `13-http-router.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `13-http-router.js` | `04-permission-runtime.js` | backward | `activeChildren`, `killAllMcpClients`, `logEvent`, `makeAttachmentRecord`, `redact`, `resolveExternalMcpServers`, `stopSession` |
| `13-http-router.js` | `05-claude-engine.js` | backward | `CLAUDE_ENDPOINT_PRESETS`, `PROVIDER_PRESETS`, `activeOpenAiProvider`, `maskProviders`, `resolveProvider`, `sanitizeProvider`, `unmaskProviders`, `unmaskSecrets` |
| `13-http-router.js` | `05b-kimi-bridge.js` | backward | `applyKimiStatusToSession`, `kimiSessionStatus`, `runKimiCompact` |
| `13-http-router.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES`, `buildMetricsPayload`, `buildOpsMetrics`, `collectAudit`, `collectStorageStats`, `deleteUserPlaybook`, `draftPlaybookFromSession`, `getCapabilities`, `listPlaybooksWithAvailability`, `maybeRecordStorageTrend`, `normalizePlaybook`, `recordRequestMetric`, `saveUserPlaybook`, `storageSweep` |
| `13-http-router.js` | `06d-memory-domain.js` | backward | `CORE_MEMORY_CHAR_CAP`, `CORE_MEMORY_MAX`, `MEMORY_EXCLUSION_MAX`, `MEMORY_MAX`, `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `confirmMemoryRelation`, `decideMemoryProposal`, `deleteMemory`, `deleteMemoryRelation`, `draftMemoryFromSession`, `listMemoryProjectGroups`, `listMemoryRelations`, `loadMemoryRegistry`, `migrateLegacyAccMemory`, `migrateMemory`, `projectKeyForCwd`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `readMemoryItem`, `resolveCoreMemoryState`, `saveMemory`, `validateMemoryProposalSave` |
| `13-http-router.js` | `06f-autonomy-grants.js` | backward | `activeDriverRuns`, `autonomyGrants`, `dryRunGrantFiles`, `listGrantsView`, `normalizeGrant`, `revokeAllGrants`, `revokeGrant` |
| `13-http-router.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `buildClaudeAgentDefinitions`, `fetchOpenAiModels`, `getAgentRoleLibrary`, `projectAgentRoleFile`, `readClaudeProjectAgentRoles`, `readProjectAgentRoles`, `saveProjectAgentRoles`, `toolPackForName` |
| `13-http-router.js` | `08-agent-runs.js` | backward | `appendAgentWorkflowSummaryToSession`, `autoResumeInterruptedRuns`, `deleteAgentWorkflow`, `getAgentWorkflows`, `markInterruptedAgentRuns`, `resolveOrchestrateNodes`, `saveAgentRun`, `saveAgentWorkflow` |
| `13-http-router.js` | `09-workflow.js` | backward | `runAgentWorkflow` |
| `13-http-router.js` | `10-context-governance.js` | backward | `agentConversationContextMeta`, `cachedContextLength`, `configuredConversationWindow`, `learnedWindowCap`, `resolveContextWindow`, `runAgentExternalCompact`, `runProviderCompact`, `streamChat`, `truncateToolResult` |
| `13-http-router.js` | `11-native-tools.js` | backward | `hasRg`, `killAllShellSessions` |
| `13-http-router.js` | `13b-api-domain-routes.js` | forward | `handleCheckpointApiRoutes`, `handleMcpApiRoutes`, `handleSteerApiRoute` |
| `13-http-router.js` | `13c-overlay-routes.js` | forward | `handleOverlayApiRoutes` |
| `13-http-router.js` | `13d-core-domain-routes.js` | forward | `handleAgentRunApiRoutes`, `handleInterventionApiRoutes`, `handleMissionsApiRoutes`, `handleSessionApiRoutes` |
| `13-http-router.js` | `13e-pretender-index.js` | forward | `warmPretenderProjectionIndex` |
| `13b-api-domain-routes.js` | `00-boot.js` | backward | `URL`, `apiFailure`, `fsp`, `json`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `13b-api-domain-routes.js` | `01-config.js` | backward | `buildUserEnvelope`, `generateMcpConfig`, `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `writeConfig`, `writeToChild` |
| `13b-api-domain-routes.js` | `02-session-store.js` | backward | `bumpMissionChangeSeq`, `journalRollback`, `rewindSession`, `saveSession` |
| `13b-api-domain-routes.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `activeChildren`, `buildMcpConnectorInventory`, `hasPendingQuestionForSession`, `invalidateMcpRuntime`, `logEvent`, `probeMcpConnector`, `resolveExternalMcpServers`, `scanMcpDropIns`, `scanMcpSources` |
| `13b-api-domain-routes.js` | `05-claude-engine.js` | backward | `maskKey`, `sanitizeExternalMcpServer` |
| `13b-api-domain-routes.js` | `06-provider-engine.js` | backward | `normalizeStoragePolicy`, `storageSweep` |
| `13b-api-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX` |
| `13c-overlay-routes.js` | `00-boot.js` | backward | `cp`, `crypto`, `dataRoot`, `externalRoot`, `fs`, `fsp`, `json`, `path` |
| `13c-overlay-routes.js` | `01-config.js` | backward | `readJsonBody`, `send`, `tokenOk` |
| `13c-overlay-routes.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13d-core-domain-routes.js` | `00-boot.js` | backward | `URL`, `apiFailure`, `crypto`, `fsp`, `json`, `makeId`, `nowIso`, `path`, `safeJsonParse`, `text` |
| `13d-core-domain-routes.js` | `01-config.js` | backward | `RUNTIME`, `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `sessionPath`, `tokenOk` |
| `13d-core-domain-routes.js` | `02-session-store.js` | backward | `bulkDeleteUnpinnedSessions`, `bumpMissionChangeSeq`, `compactInterventionJournal`, `createSession`, `deleteSession`, `detectDanglingTurn`, `foldTurnSummaries`, `journalReadIndex`, `listSessions`, `loadSession`, `missionControlCommand`, `missionControlView`, `readInterventions`, `readMissionChangesWithMeta`, `registerIntervention`, `saveSession`, `sessionKind`, `sessionMissionId`, `settleIntervention`, `transitionInterventionState`, `updateSessionMeta` |
| `13d-core-domain-routes.js` | `03-bridge-guard.js` | backward | `normalizeCwd` |
| `13d-core-domain-routes.js` | `04-permission-runtime.js` | backward | `activeChildren`, `driverAutoSessions`, `extendUserQuestion`, `logEvent`, `normalizeQuestionAnswer`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `requestUserQuestion`, `runAutomaticInterventionDecision` |
| `13d-core-domain-routes.js` | `06f-autonomy-grants.js` | backward | `consumeGrant` |
| `13d-core-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX`, `activeAgentRuns`, `agentRunFile`, `applyAgentWorktree`, `cleanupAgentWorktree`, `getAgentRoleLibrary`, `nativeToolGate`, `nativeToolTier`, `toolIsRevertible` |
| `13d-core-domain-routes.js` | `08-agent-runs.js` | backward | `agentRunEventsFile`, `appendAgentRunEvent`, `bumpRunIntervention`, `computeWaveSeq`, `listAgentRuns`, `materializePoolItem`, `nodeDeliveryEligibility`, `readAgentRunEvents`, `saveAgentRun` |
| `13d-core-domain-routes.js` | `09-workflow.js` | backward | `applyReplanPatch`, `launchPersistedAgentRun` |
| `13d-core-domain-routes.js` | `13e-pretender-index.js` | forward | `emptyMissionUsage`, `getPretenderProjectionIndex`, `overlayMissionCard`, `paginatePretenderProjection`, `pretenderEtag`, `pretenderHash`, `pretenderIndexMeta`, `pretenderIndexRuntime`, `pretenderLiveOverlayRevision`, `pretenderNotModified` |
| `13e-pretender-index.js` | `00-boot.js` | backward | `URL`, `apiFailure`, `crypto`, `fs`, `fsp`, `nowIso`, `path`, `paths`, `readUsageRows`, `safeJsonParse` |
| `13e-pretender-index.js` | `01-config.js` | backward | `atomicWriteJson`, `safeSessionId`, `sessionPath` |
| `13e-pretender-index.js` | `02-session-store.js` | backward | `compactInterventionJournal`, `interventionFilePath`, `readInterventionsWithMeta`, `sessionKind`, `sessionMissionId` |
| `13e-pretender-index.js` | `04-permission-runtime.js` | backward | `activeChildren` |
| `13e-pretender-index.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `agentRunDir` |
| `13e-pretender-index.js` | `08-agent-runs.js` | backward | `listAgentRuns` |
| `13e-pretender-index.js` | `13d-core-domain-routes.js` | backward | `buildMissionCard`, `missionRunDigest` |
| `14-main.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `SESSION_SCHEMA` |
| `14-main.js` | `01-config.js` | backward | `AGENT_CLI_TYPES`, `BUILTIN_AGENT_ROLES`, `DurableJsonStore`, `PERMISSION_MODES`, `ROUTE_AUTH`, `autoImportClaudeCodeMcp`, `batchSafeSpawn`, `buildClaudeCliEnv`, `cmdLineBudgetFor`, `decodeClaudeCliText`, `defaultConfig`, `desktopMcpFromInstalledRoot`, `desktopPythonCandidates`, `detectDesktopMcp`, `detectKimiPath`, `estimateBucketsEnabled`, `generateMcpConfig`, `generateSessionMcpConfig`, `invalidateAgentCliPathCaches`, `invalidateClaudePathCache`, `normalizeAgentRole`, `normalizeConfig`, `pickPython`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `quoteWinArg`, `resolveClaudeLauncher`, `selectedAgentCli`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `spawnCmdLineLength`, `summaryEntityCheckEnabled`, `syncMcpServersToKimi` |
| `14-main.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `collectBridgedWriteTarget`, `collectBridgedWriteTargets`, `compactInterventionJournal`, `configForSessionEngineRoute`, `createSession`, `createTurnSegmentBuilder`, `deleteSession`, `detectDanglingTurn`, `foldMissionChangeJournalText`, `inferSessionEngineRoute`, `isBridgedWriteTool`, `isUntitledSessionTitle`, `journalGc`, `journalGcProbe`, `journalRecord`, `kindForPath`, `listSessions`, `loadSession`, `missionChangeFilePath`, `normalizeSession`, `normalizeSessionEngineRoute`, `readInterventionsWithMeta`, `readMissionChangesWithMeta`, `readSessionNotes`, `reconcileWorkspaceTurnBaseline`, `repairProviderHistoryPairing`, `saveSession`, `sessionBodyPaths`, `sessionEngineRouteFromConfig`, `sessionNotesPath`, `unprefixedBridgedName`, `updateSessionMeta`, `workspaceBaselineIsCodePath`, `writeSessionNotes` |
| `14-main.js` | `03-bridge-guard.js` | backward | `AUTOEXEC_DENYLIST`, `BRIDGED_WRITE_AUDIT_EXEMPT`, `auditBridgedWriteCoverage`, `bridgedOfficeScriptGate`, `buildBrowserOpenSpawn`, `buildCodeEditorSpawn`, `buildOpenSpawn`, `buildRevealSpawn`, `classifyCodeEditorExecutable`, `cwdWarning`, `executableFromAssociationCommand`, `fileAllowedRoots`, `guardFileToolPath`, `guardWorkspaceExecute`, `guardWorkspacePath`, `normalizeAutoexecPath`, `pathWithinAnyRoot`, `pathWithinRoot`, `providerIsLocal`, `readFilePreview`, `resolvePreferredCodeEditor`, `resolveWorkspace`, `workspaceWriteRoots` |
| `14-main.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `14-main.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `McpHttpClient`, `McpStdioClient`, `buildMcpConnectorInventory`, `classifyMcpError`, `collectBridgedTools`, `configureMcpFromTool`, `invalidateMcpDropInCache`, `killAllMcpClients`, `nativeClaudeAgentResultInfo`, `parseAgentCliEvent`, `parseClaudeTaskNotification`, `parseMcpConfigFile`, `probeMcpConnector`, `resolveBridge`, `resolveExternalMcpServers`, `safeMcpInventory`, `safeUrlForDisplay`, `scanMcpDropIns`, `scanMcpSources` |
| `14-main.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `14-main.js` | `05-claude-engine.js` | backward | `applyProviderReasoningEffort`, `maskSecrets`, `providerReasoningEffort`, `sanitizeExternalMcpServer`, `unmaskProviders`, `unmaskSecrets` |
| `14-main.js` | `05b-kimi-bridge.js` | backward | `compactKimiNative`, `consumeKimiAcpApproval`, `isKimiAcpPlanFilePath`, `kimiAcpConcreteEditGuard`, `kimiAcpFreshActualForOperation`, `kimiAcpInferConcreteToolInput`, `kimiAcpModeOptionFromActivated`, `kimiAcpNativeBashWrapperCandidate`, `kimiAcpNativeBashWrapperTexts`, `kimiAcpNativeShellQuote`, `kimiAcpNativeWindowsPathToPosixPath`, `kimiAcpPermissionToolCall`, `kimiAcpSessionRestoreMethods`, `kimiAcpSuccessfulEnterPlanMode`, `kimiAcpToolTier`, `kimiAcpToolUpdateSucceeded`, `kimiAcpUnknownSessionError`, `kimiSessionStatus`, `parseKimiWireAgentEvents`, `parseKimiWireCompaction`, `prepareKimiAcpSpawn`, `readKimiWireRuntime`, `resolveKimiAcpPlanFilePath`, `runKimiCompact`, `stopKimiServer`, `watchKimiWire` |
| `14-main.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES`, `NETWORK_ANCHORS`, `TOOL_ITERATION_BUDGETS`, `TOOL_REQUIRES`, `appendResponseLanguagePolicy`, `appendTurnPolicies`, `auditSummaryFor`, `buildAgentTeamHint`, `buildBrowserAutomationHint`, `buildClaudeNativeAgentPolicy`, `buildMetricsPayload`, `buildPromptTaskContext`, `buildProviderSystemPrompt`, `buildResponseLanguagePolicy`, `buildSoftwareEngineeringPolicy`, `buildStableSystemPrompt`, `buildToolCustomizationHint`, `buildVolatileParts`, `clampAppendWithSkills`, `claudeProjectDirKey`, `claudeProjectsRoot`, `collectAudit`, `collectStorageStats`, `evalPlaybookAvailability`, `fenceSafeSlice`, `getCapabilities`, `invalidateCapabilityCache`, `isLongToolTask`, `loadAllPlaybooks`, `maybeRecordStorageTrend`, `networkAnchors`, `normalizeMetricsPath`, `normalizePlaybook`, `normalizeStoragePolicy`, `parsePlaybookDraft`, `probeAny`, `readProjectMemory`, `readStorageTrend`, `recordEngineTranscript`, `recordRequestMetric`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget`, `shrinkFencedSection`, `softwareEngineeringTaskProfile`, `storageSweep`, `toolRequirementsMet` |
| `14-main.js` | `06b-prompt-registry.js` | backward | `PROMPT_PACK_VERSION` |
| `14-main.js` | `06c-agent-loop-hooks.js` | backward | `AgentLoopHooks` |
| `14-main.js` | `06d-memory-domain.js` | backward | `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `buildCoreMemoryPromptSection`, `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `confirmMemoryRelation`, `deleteMemoryRelation`, `effectiveMemorySelection`, `extractMemoryRelationProposals`, `legacyAccMemoryMigrationComplete`, `listMemoryRelations`, `listWorkbenchMemories`, `loadMemoryRegistry`, `memoryProposalIsDuplicate`, `memoryProposalPrefilter`, `memoryProposalSimilarity`, `memorySearchTerms`, `migrateLegacyAccMemory`, `parseMemoryProposalDecision`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `rankRelevantMemories`, `readWorkbenchMemory`, `resolveCoreMemoryState`, `resolveMemoryPreflight`, `saveMemory` |
| `14-main.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `agentResourcesConflict`, `inferToolResources`, `normalizeAgentResource`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources`, `resourceBlockers` |
| `14-main.js` | `07-autonomy.js` | backward | `NATIVE_TOOL_PACKS`, `NATIVE_TOOL_TIER`, `adaptiveMetaToolSchemas`, `applyAgentWorktree`, `bridgedToolTier`, `buildClaudeAgentDefinitions`, `buildOpenAiTools`, `buildResponsesInputItems`, `buildToolCatalog`, `classifyClaudeSubagentFailure`, `classifyRuntimeToolFailure`, `classifyToolPacks`, `compareToolRetrievalShadow`, `createAgentWorktree`, `createToolLoadingState`, `estimateToolSchemaTokens`, `fetchOpenAiModels`, `finalizeAgentWorktree`, `getAgentRoleLibrary`, `readClaudeProjectAgentRoles`, `readProjectAgentRoles`, `responsesHistoryWithCompleteToolPairs`, `saveProjectAgentRoles`, `searchToolCatalog`, `toolPackForName` |
| `14-main.js` | `08-agent-runs.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `QUALITY_GATE_OUTPUT_SCHEMA`, `aggregateAgentVote`, `aggregateCoverage`, `autoResumeInterruptedRuns`, `buildNodeEvidenceCatalog`, `dedupeAgentFindings`, `deleteAgentWorkflow`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `formatNodeEvidencePrompt`, `getAgentWorkflows`, `indexNodeEvidence`, `mapPool`, `markInterruptedAgentRuns`, `normalizeAgentGate`, `normalizeAgentWorkflow`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `parseStructuredAgentOutput`, `propagateAssignments`, `purgeNodeEvidence`, `readAgentRunEvents`, `repairJson`, `resolveAgentTeamRoute`, `runWorkspaceHash`, `sanitizeAgentOutputSchema`, `saveAgentWorkflow`, `syncRunEventSeq`, `validateAgentJsonSchema`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `14-main.js` | `09-workflow.js` | backward | `CONTEXT_WINDOW_FALLBACK`, `applyReplanPatch`, `classifyTextForEstimate`, `estimateHistoryTokens`, `fmtTokensServer`, `planDiscoveryToolBatchAllowed`, `proposeReplanPatch`, `rollbackReplanPatch`, `setEstimateBucketsV1`, `validateReplanPatch` |
| `14-main.js` | `10-context-governance.js` | backward | `COMPACT_MARKER_MIN_SAVED_TOKENS`, `COMPACT_RESEED_TAIL_MAX_TOKENS`, `CompactionPlan`, `MODEL_CONTEXT_TABLE`, `agentConversationContextMeta`, `appendPromptToLastUserMessage`, `buildObservationRecallPrompt`, `buildSessionNotesInjectPrompt`, `calibratedEstimate`, `checkSummaryEntities`, `chunkHistoryByBudget`, `compactHistoryFromSession`, `configuredConversationWindow`, `contextWindowFromTable`, `contextWindowOverrideKey`, `estimateFactor`, `extractContextLength`, `extractSessionNotes`, `extractSummaryEntities`, `fitHistoryForSummary`, `historyStartsWithCompactionSummary`, `isContextOverflowError`, `learnedWindowCap`, `maybeWriteSessionNotes`, `measureObservationReductionShadow`, `mergeSessionNotes`, `noteEstimateSample`, `noteWindowOvershoot`, `openCompactMarker`, `parseSessionNotesMarkdown`, `providerContextWindow`, `providerConversationContextWindow`, `providerSummaryCall`, `recentTurnsBoundary`, `reduceObservationContent`, `rehydrateObservation`, `renderSessionNotesMarkdown`, `resolveCompactionProvider`, `resolveContextWindow`, `upsertCompactMarker`, `validateStructuredSummary`, `writeHistorySnapshot` |
| `14-main.js` | `11-native-tools.js` | backward | `builtinSearch`, `classifyFetchError`, `crc32`, `embeddedIpv4FromV6`, `extractMainText`, `httpGetGuarded`, `isPrivateIpv4`, `parseBaiduHtml`, `parseBingHtml`, `readWebCache`, `ssrfCheck`, `webCachePath`, `webFetch`, `webFetchFailMessage`, `webSearch`, `writeWebCache`, `zipCollectEntries` |
| `14-main.js` | `13-http-router.js` | backward | `doctor`, `installIntegration`, `parseArgs`, `startMcp`, `startServer` |
| `14-main.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `pretenderIndexPath`, `warmPretenderProjectionIndex` |

## 强连通分量

1. `00-boot.js` ↔ `01-config.js` ↔ `02-session-store.js` ↔ `03-bridge-guard.js` ↔ `04-desktop-shell.js` ↔ `04-permission-runtime.js` ↔ `04-visual-pipeline.js` ↔ `05-claude-engine.js` ↔ `05b-kimi-bridge.js` ↔ `05c-kimi-search-policy.js` ↔ `05d-kimi-prompt-parts.js` ↔ `06-provider-engine.js` ↔ `06b-prompt-registry.js` ↔ `06c-agent-loop-hooks.js` ↔ `06d-memory-domain.js` ↔ `06e-mission-domain.js` ↔ `06f-autonomy-grants.js` ↔ `06g-resource-leases.js` ↔ `07-autonomy.js` ↔ `08-agent-runs.js` ↔ `09-workflow.js` ↔ `10-context-governance.js` ↔ `11-native-tools.js` ↔ `13-http-router.js` ↔ `13b-api-domain-routes.js` ↔ `13c-overlay-routes.js` ↔ `13d-core-domain-routes.js` ↔ `13e-pretender-index.js`

## 维护规则

- 源码新增或删除跨模块引用时，契约与本图必须同步更新；`--check`/CI 会拒绝漂移。
- 重复顶层导出名始终拒绝。循环边和前向边只能减少；若确需增加，必须显式修改 `module-dependency-policy.json` 并说明理由。
- 隔离批次优先把内部符号收进命名空间，只暴露真实公共面；每批保持拼接顺序和运行语义。
