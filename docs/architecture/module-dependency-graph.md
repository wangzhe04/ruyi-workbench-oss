# 后端模块依赖图（第 103b／104 波）

> 本文件由 `node dev-harness/module-dependency-graph.js --write` 从 `app/src/manifest.json` 与源码生成。请勿手改。
> `provides/requires` 是构建期拼接作用域的显式契约；运行时仍执行单文件 `app/server.js`。

## 摘要

| 模块 | 顶层符号 | 跨模块符号引用 | 模块边 | 前向边 | 重复导出 | 强连通分量 |
|---:|---:|---:|---:|---:|---:|---:|
| 67 | 3240 | 3006 | 525 | 68 | 0 | 1 |

“前向边”表示较早拼接的模块引用较晚模块，依赖函数提升或延迟执行；它不是自动判错，但已由债务上限锁住，禁止无评审增加。

## 模块清单

| # | 模块 | 层 | provides | requires | 直接依赖 |
|---:|---|---|---:|---:|---:|
| 0 | `00-boot.js` | bootstrap | 133 | 7 | 4 |
| 1 | `00b-ruyi-names.js` | bootstrap | 5 | 0 | 0 |
| 2 | `01b-route-auth.js` | foundation | 1 | 0 | 0 |
| 3 | `01c-runtime-flags.js` | foundation | 36 | 0 | 0 |
| 4 | `01d-win-cmdline.js` | foundation | 10 | 0 | 0 |
| 5 | `01e-permission-modes.js` | foundation | 10 | 1 | 1 |
| 6 | `01f-agent-cli-types.js` | foundation | 4 | 1 | 1 |
| 7 | `01-config.js` | foundation | 178 | 55 | 12 |
| 8 | `02c-turn-segments.js` | foundation | 1 | 0 | 0 |
| 9 | `02d-session-overrides.js` | foundation | 10 | 1 | 1 |
| 10 | `02e-session-engine-route.js` | foundation | 4 | 1 | 1 |
| 11 | `02f-turn-effect-kinds.js` | foundation | 15 | 0 | 0 |
| 12 | `02-session-store.js` | foundation | 291 | 72 | 16 |
| 13 | `03-bridge-guard.js` | foundation | 87 | 25 | 7 |
| 14 | `04-visual-pipeline.js` | foundation | 1 | 3 | 1 |
| 15 | `04-permission-runtime.js` | foundation | 151 | 37 | 9 |
| 16 | `04-desktop-shell.js` | foundation | 1 | 10 | 3 |
| 17 | `04f-toolbox-services.js` | foundation | 26 | 13 | 3 |
| 18 | `04h-provider-http.js` | foundation | 10 | 0 | 0 |
| 19 | `04i-provider-anthropic.js` | foundation | 48 | 1 | 1 |
| 20 | `04i-provider-wire.js` | foundation | 32 | 15 | 2 |
| 21 | `05-claude-engine.js` | engine | 64 | 132 | 22 |
| 22 | `05b-kimi-bridge.js` | engine | 127 | 73 | 12 |
| 23 | `05c-kimi-search-policy.js` | engine | 42 | 11 | 2 |
| 24 | `05d-kimi-prompt-parts.js` | engine | 15 | 4 | 2 |
| 25 | `06-provider-engine.js` | engine | 131 | 55 | 16 |
| 26 | `06b-prompt-registry.js` | engine | 6 | 1 | 1 |
| 27 | `06c-agent-loop-hooks.js` | engine | 1 | 3 | 2 |
| 28 | `06h-retrieval-index.js` | engine | 15 | 0 | 0 |
| 29 | `06i-steward-core.js` | engine | 155 | 0 | 0 |
| 30 | `06d-memory-domain.js` | engine | 129 | 36 | 10 |
| 31 | `06e-mission-domain.js` | engine | 3 | 14 | 5 |
| 32 | `06f-autonomy-grants.js` | engine | 25 | 12 | 5 |
| 33 | `06g-resource-leases.js` | engine | 20 | 5 | 3 |
| 34 | `06j-scheduler-core.js` | engine | 44 | 0 | 0 |
| 35 | `06k-config-patch.js` | engine | 1 | 21 | 8 |
| 36 | `07-autonomy.js` | orchestration | 98 | 65 | 17 |
| 37 | `08-agent-runs.js` | orchestration | 112 | 94 | 18 |
| 38 | `09b-replan-ledger.js` | orchestration | 8 | 4 | 1 |
| 39 | `09d-token-estimation.js` | orchestration | 25 | 2 | 2 |
| 40 | `09-workflow.js` | orchestration | 19 | 229 | 25 |
| 41 | `10-context-governance.js` | orchestration | 175 | 86 | 17 |
| 42 | `11-native-tools.js` | tools | 107 | 45 | 10 |
| 43 | `11b-file-text-io.js` | tools | 1 | 2 | 1 |
| 44 | `12-tool-dispatch.js` | tools | 52 | 95 | 18 |
| 45 | `13f-native-tool-schemas.js` | transport | 1 | 1 | 1 |
| 46 | `13-http-router.js` | transport | 65 | 236 | 28 |
| 47 | `13b-api-domain-routes.js` | transport | 36 | 59 | 7 |
| 48 | `13c-overlay-routes.js` | transport | 11 | 13 | 3 |
| 49 | `13d-core-domain-routes.js` | transport | 58 | 138 | 17 |
| 50 | `13e-pretender-index.js` | transport | 57 | 36 | 8 |
| 51 | `13i-steward-inbox.js` | transport | 77 | 26 | 8 |
| 52 | `13j-steward-tool-base.js` | transport | 76 | 23 | 9 |
| 53 | `13k-steward-threads.js` | transport | 47 | 111 | 15 |
| 54 | `13l-steward-ops.js` | transport | 36 | 104 | 17 |
| 55 | `13g-steward.js` | transport | 12 | 66 | 9 |
| 56 | `13m-steward-runner-base.js` | transport | 46 | 16 | 7 |
| 57 | `13n-steward-arbiter.js` | transport | 42 | 18 | 6 |
| 58 | `13o-steward-runner-prompt.js` | transport | 22 | 62 | 15 |
| 59 | `13p-steward-runner-actions.js` | transport | 33 | 59 | 11 |
| 60 | `13q-steward-runner-turn.js` | transport | 31 | 65 | 18 |
| 61 | `13h-steward-runner.js` | transport | 7 | 46 | 12 |
| 62 | `13r-event-stream.js` | transport | 23 | 17 | 6 |
| 63 | `13s-scheduler.js` | transport | 51 | 35 | 9 |
| 64 | `13t-steward-schedule.js` | transport | 19 | 34 | 10 |
| 65 | `13u-migration-center.js` | transport | 60 | 34 | 6 |
| 66 | `14-main.js` | entrypoint | 1 | 576 | 44 |

## 模块边

| 调用方 | 提供方 | 方向 | 符号 |
|---|---|---|---|
| `00-boot.js` | `01-config.js` | forward | `atomicWriteJson`, `readConfig` |
| `00-boot.js` | `02-session-store.js` | forward | `bumpMissionChangeSeq`, `overlayUnflushedSessionIndex`, `readSessionIndex` |
| `00-boot.js` | `05-claude-engine.js` | forward | `CLAUDE_ENDPOINT_PRESETS` |
| `00-boot.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `01-config.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `DEFAULT_PORT`, `MAX_BODY_BYTES`, `RUYI_EVENTS`, `SKILL_ID_RE`, `StringDecoder`, `URL`, `VERSION`, `agentCliHomes`, `apiFailure`, `cp`, `crypto`, `ensureDirs`, `externalRoot`, `findRuyiPackageRootFor`, `fs`, `fsp`, `isPkg`, `normalizePricing`, `os`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `text` |
| `01-config.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_SERVER_ID`, `canonicalRuyiMcpServerId`, `isRuyiMcpServerId` |
| `01-config.js` | `01b-route-auth.js` | backward | `ROUTE_AUTH` |
| `01-config.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn`, `isBatchLauncher` |
| `01-config.js` | `01e-permission-modes.js` | backward | `CLAUDE_PERMISSION_MODE_MAP`, `PERMISSION_MODES`, `PERMISSION_MODE_ALIASES`, `normalizeAgentRole` |
| `01-config.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_DEFAULT_TYPE`, `AGENT_CLI_TYPES`, `isAgentCliType`, `normalizeAgentCliType` |
| `01-config.js` | `03-bridge-guard.js` | forward | `existsExecutableAsync`, `pathWithinRoot` |
| `01-config.js` | `04-desktop-shell.js` | forward | `DesktopShell` |
| `01-config.js` | `04-permission-runtime.js` | forward | `activeChildren`, `logEvent`, `resolveExternalMcpServers`, `scanMcpSources` |
| `01-config.js` | `05-claude-engine.js` | forward | `configSecretValueOrCleared`, `configUrlOrCleared`, `sanitizeExternalMcpServer`, `sanitizeProvider` |
| `01-config.js` | `06-provider-engine.js` | forward | `normalizeStoragePolicy` |
| `01-config.js` | `07-autonomy.js` | forward | `TOOL_PACK_DESCRIPTIONS`, `claudePermissionMode`, `getAgentRoleLibrary`, `nativeToolTier` |
| `01e-permission-modes.js` | `00b-ruyi-names.js` | backward | `canonicalRuyiMcpServerId` |
| `01f-agent-cli-types.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn` |
| `02-session-store.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `SESSION_SCHEMA`, `SKILL_ID_RE`, `crypto`, `ensureDirs`, `fs`, `fsp`, `makeId`, `nowIso`, `os`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `text`, `zlib` |
| `02-session-store.js` | `01-config.js` | backward | `assertSessionIdForPath`, `atomicWriteJson`, `mutateConfig`, `noteSessionsDirOwnWrite`, `readConfig`, `readFileTail`, `safeSessionId`, `selectedAgentCli`, `sessionPath`, `sessionWriteChains` |
| `02-session-store.js` | `01e-permission-modes.js` | backward | `resolvePermissionMode` |
| `02-session-store.js` | `02d-session-overrides.js` | backward | `applySessionDesktopToolsOverride`, `applySessionPermissionModeOverride`, `normalizeSessionDesktopTools`, `normalizeSessionPermissionMode`, `sessionDesktopToolsOverrides`, `sessionEngineRouteOverrides`, `sessionPermissionModeOf`, `sessionPermissionModeOverrides` |
| `02-session-store.js` | `02e-session-engine-route.js` | backward | `inferSessionEngineRoute`, `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `02-session-store.js` | `02f-turn-effect-kinds.js` | backward | `ARTIFACT_OUTPUT_PATH_KEYS`, `IRREVERSIBLE_LEDGER_MAX`, `TURN_SUMMARY_COMMAND_TOOLS`, `TURN_SUMMARY_FILE_TOOLS`, `TURN_SUMMARY_KNOWN_TOOLS`, `irreversibleDetail`, `irreversibleToolKind`, `isBridgedWriteTool`, `unprefixedBridgedName`, `unwrapToolInvokeCall` |
| `02-session-store.js` | `03-bridge-guard.js` | forward | `guardFileToolPath`, `pathWithinRoot`, `realpathForContainment` |
| `02-session-store.js` | `04-desktop-shell.js` | forward | `DesktopShell` |
| `02-session-store.js` | `04-permission-runtime.js` | forward | `activeChildren`, `logEvent`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `stopSession`, `turnSettlers` |
| `02-session-store.js` | `06-provider-engine.js` | forward | `recordEngineTranscript` |
| `02-session-store.js` | `06b-prompt-registry.js` | forward | `PROMPT_PACK_VERSION` |
| `02-session-store.js` | `06f-autonomy-grants.js` | forward | `revokeAllGrants` |
| `02-session-store.js` | `07-autonomy.js` | forward | `activeAgentRuns`, `agentRunDir` |
| `02-session-store.js` | `08-agent-runs.js` | forward | `appendAgentRunEvent`, `bumpRunIntervention`, `listAgentRuns`, `saveAgentRun` |
| `02-session-store.js` | `11-native-tools.js` | forward | `gitReadOnlyGuard`, `runGit` |
| `02-session-store.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `02d-session-overrides.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `02e-session-engine-route.js` | `01f-agent-cli-types.js` | backward | `normalizeAgentCliType` |
| `03-bridge-guard.js` | `00-boot.js` | backward | `URL`, `cp`, `crypto`, `dataRoot`, `dataRootAliases`, `fs`, `fsp`, `os`, `path`, `spawnDetachedChecked`, `zlib` |
| `03-bridge-guard.js` | `01-config.js` | backward | `readConfig`, `spawnProbeAsync` |
| `03-bridge-guard.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn` |
| `03-bridge-guard.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `collectBridgedWriteTargets`, `journalDir`, `journalRecord`, `journalSessionCtx`, `kindForPath` |
| `03-bridge-guard.js` | `02f-turn-effect-kinds.js` | backward | `unprefixedBridgedName` |
| `03-bridge-guard.js` | `04-permission-runtime.js` | forward | `logEvent`, `mcpDropInDirs`, `toolboxComponentsDir` |
| `03-bridge-guard.js` | `05-claude-engine.js` | forward | `activeOpenAiProvider` |
| `04-desktop-shell.js` | `00-boot.js` | backward | `cp`, `decodeConsoleText`, `fs`, `fsp`, `os`, `path`, `spawnDetachedChecked`, `text` |
| `04-desktop-shell.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn` |
| `04-desktop-shell.js` | `04-permission-runtime.js` | backward | `killChildTree` |
| `04-permission-runtime.js` | `00-boot.js` | backward | `URL`, `VERSION`, `cp`, `crypto`, `dataRoot`, `ensureDirs`, `externalRoot`, `fs`, `fsp`, `http`, `makeId`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `04-permission-runtime.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_SERVER_ID`, `isRuyiMcpServerId` |
| `04-permission-runtime.js` | `01-config.js` | backward | `bridgedEnvKeyStripped`, `detectDesktopMcp`, `ensureDesktopMcpWarm`, `generateMcpConfig`, `mutateConfig`, `readConfig`, `selectedAgentCli` |
| `04-permission-runtime.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn` |
| `04-permission-runtime.js` | `02-session-store.js` | backward | `registerIntervention`, `settleIntervention` |
| `04-permission-runtime.js` | `05-claude-engine.js` | forward | `collectDisplayUrlRestores`, `maskKey`, `mcpArgsForDisplay`, `restoreExternalMcpServerSecrets`, `sanitizeExternalMcpServer` |
| `04-permission-runtime.js` | `06d-memory-domain.js` | forward | `legacyAccMemoryMigrationComplete` |
| `04-permission-runtime.js` | `13d-core-domain-routes.js` | forward | `decideIntervention` |
| `04-permission-runtime.js` | `13f-native-tool-schemas.js` | forward | `MCP_TOOLS` |
| `04-visual-pipeline.js` | `00-boot.js` | backward | `fsp`, `path`, `text` |
| `04f-toolbox-services.js` | `00-boot.js` | backward | `cp`, `http`, `path`, `safeJsonParse`, `text` |
| `04f-toolbox-services.js` | `01-config.js` | backward | `mutateConfig`, `readConfig` |
| `04f-toolbox-services.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `enabledToolboxComponents`, `invalidateToolboxCache`, `logEvent`, `redact`, `scanToolboxComponents` |
| `04i-provider-anthropic.js` | `04h-provider-http.js` | backward | `providerBaseWithV1` |
| `04i-provider-wire.js` | `04h-provider-http.js` | backward | `providerApiBase`, `providerBaseWithV1`, `providerCompletionUrl`, `providerRequestHeaders` |
| `04i-provider-wire.js` | `04i-provider-anthropic.js` | backward | `anthropicMessagesUrl`, `anthropicRequestHeaders`, `anthropicRetryBodyOn400`, `applyAnthropicEffort`, `applyAnthropicTemperature`, `applyAnthropicTools`, `createAnthropicStreamDecoder`, `decodeAnthropicCompletion`, `encodeAnthropicMessages`, `encodeAnthropicQuick`, `normalizeAnthropicUsage` |
| `05-claude-engine.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `URL`, `appendUsageLedger`, `claudeCostFields`, `computeProviderCost`, `cp`, `createCappedDiagnosticText`, `createNdjsonLineFeeder`, `crypto`, `fsp`, `normalizePricing`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `05-claude-engine.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_CLI_TOOL_PREFIX` |
| `05-claude-engine.js` | `01-config.js` | backward | `buildUserEnvelope`, `decodeClaudeCliText`, `effectiveAnthropicEnv`, `generateSessionMcpConfig`, `isAskUserTool`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `readConfig`, `selectedAgentCli`, `syncMcpServersToKimi`, `writeToChild` |
| `05-claude-engine.js` | `01d-win-cmdline.js` | backward | `CMD_EXE_LINE_LIMIT`, `CMD_LINE_QUOTE_MARGIN`, `cmdLineBudgetFor`, `cmdLineBudgetSeam`, `isBatchLauncher`, `quoteWinArg`, `spawnCmdLineLength` |
| `05-claude-engine.js` | `01e-permission-modes.js` | backward | `CLAUDE_PERMISSION_MODE_MAP` |
| `05-claude-engine.js` | `01f-agent-cli-types.js` | backward | `normalizeAgentCliType` |
| `05-claude-engine.js` | `02-session-store.js` | backward | `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `reconcileWorkspaceTurnBaseline`, `saveSession`, `saveTurnFinalSession` |
| `05-claude-engine.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `05-claude-engine.js` | `03-bridge-guard.js` | backward | `buildAttachmentPrompt`, `cwdWarning`, `normalizeCwd` |
| `05-claude-engine.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `activeChildren`, `appendLiveTail`, `buildClaudeRecoveryHistory`, `claudeProviderTailSince`, `claudeResumeRouteKey`, `clearPendingPermissions`, `clearPendingQuestions`, `formatQuestionGuidance`, `hasPendingPermissionForSession`, `hasPendingQuestionForSession`, `installActiveChildEventFanout`, `isClaudeResumeMissingError`, `killChildTree`, `lastAssistantEngine`, `lastSuccessfulClaudeModel`, `logEvent`, `nativeClaudeAgentResultInfo`, `parseClaudeEvent`, `parseKimiStreamJsonEvent`, `permissionWaitMs`, `redact`, `registerUserQuestion`, `safeUrlForDisplay`, `sameClaudeResumeCwd`, `stopSession` |
| `05-claude-engine.js` | `04h-provider-http.js` | backward | `providerBaseWithV1`, `providerPostJsonOnce` |
| `05-claude-engine.js` | `04i-provider-anthropic.js` | backward | `normalizeAnthropicAuth`, `normalizeAnthropicFallbacks`, `normalizeAnthropicThinking` |
| `05-claude-engine.js` | `04i-provider-wire.js` | backward | `normalizeProviderApiStyle`, `providerReasoningEffort`, `providerWireProtocol` |
| `05-claude-engine.js` | `05b-kimi-bridge.js` | forward | `applyKimiStatusToSession`, `kimiContextWindow`, `kimiSessionStatus`, `kimiUsageFromStatus`, `maybeAutoCompactAgentSession`, `runKimiAcpTurnPrepared`, `runKimiCompact`, `syncKimiSessionUsage`, `syncKimiTurnPreferences`, `watchKimiWire` |
| `05-claude-engine.js` | `06-provider-engine.js` | forward | `appendMemorySection`, `appendTurnPolicies`, `buildBrowserAutomationHint`, `buildPlaybookIndexSection`, `buildPromptTaskContext`, `buildSkillsPromptSection`, `buildToolCustomizationHint`, `engineTranscriptCwd`, `evalPlaybookAvailability`, `fenceSafeSlice`, `getCapabilities`, `loadAllPlaybooks`, `peekCapabilities`, `resolveEngineEnvBrief`, `softwareEngineeringTaskProfile` |
| `05-claude-engine.js` | `06b-prompt-registry.js` | forward | `PROMPT_PACK_VERSION`, `getPromptPack` |
| `05-claude-engine.js` | `06c-agent-loop-hooks.js` | forward | `AgentLoopHooks` |
| `05-claude-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `filterMemoryForNativeCli`, `memoryGlobalDir`, `memoryProjectDir`, `resolveMemoryPreflight` |
| `05-claude-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `05-claude-engine.js` | `07-autonomy.js` | forward | `buildClaudeAgentDefinitions`, `classifyToolPacks` |
| `05-claude-engine.js` | `08-agent-runs.js` | forward | `buildOrchestrateHint`, `getAgentWorkflows` |
| `05-claude-engine.js` | `13-http-router.js` | forward | `buildModelHint`, `discoverKimiModels`, `discoverModels`, `kimiModelList`, `offlineModelList` |
| `05b-kimi-bridge.js` | `00-boot.js` | backward | `MAX_BODY_BYTES`, `RUYI_EVENTS`, `StringDecoder`, `URL`, `cp`, `createCappedDiagnosticText`, `createNdjsonLineFeeder`, `dataRoot`, `externalRoot`, `fs`, `fsp`, `http`, `makeId`, `nowIso`, `os`, `path`, `pathToFileURL`, `paths`, `safeJsonParse`, `spawnDetachedChecked`, `text` |
| `05b-kimi-bridge.js` | `01-config.js` | backward | `RUNTIME`, `decodeClaudeCliText`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `readConfig`, `selectedAgentCli`, `syncMcpServersToKimi` |
| `05b-kimi-bridge.js` | `02-session-store.js` | backward | `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `mutateSession`, `normalizeTodoItems`, `reconcileWorkspaceTurnBaseline`, `saveSession`, `saveTurnFinalSession` |
| `05b-kimi-bridge.js` | `03-bridge-guard.js` | backward | `buildOpenSpawn`, `cwdWarning`, `fileAllowedRoots`, `guardFileToolPath`, `guardWorkspaceExecute`, `normalizeCwd`, `pathWithinRoot`, `realpathForContainment`, `workspaceWriteRoots` |
| `05b-kimi-bridge.js` | `04-permission-runtime.js` | backward | `activeChildren`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `hasPendingPermissionForSession`, `killChildTree`, `logEvent`, `permissionWaitMs`, `redact`, `requestUserQuestion`, `runAutomaticInterventionDecision`, `stopSession` |
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
| `06-provider-engine.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_CLI_TOOL_PREFIX` |
| `06-provider-engine.js` | `01-config.js` | backward | `RUNTIME`, `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06-provider-engine.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `06-provider-engine.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_DEFAULT_TYPE`, `isAgentCliType` |
| `06-provider-engine.js` | `02-session-store.js` | backward | `SESSION_INDEX_FILE`, `loadSession`, `updateSessionMeta` |
| `06-provider-engine.js` | `03-bridge-guard.js` | backward | `existsExecutableAsync`, `probeGitCliAsync` |
| `06-provider-engine.js` | `04-permission-runtime.js` | backward | `activeChildren`, `collectBridgedTools`, `logEvent`, `mcpClients`, `redact`, `resolveExternalMcpServers`, `sanitizeServerId` |
| `06-provider-engine.js` | `04h-provider-http.js` | backward | `providerBaseWithV1`, `providerPostJsonOnce` |
| `06-provider-engine.js` | `04i-provider-wire.js` | backward | `applyProviderReasoningEffort`, `providerWireProtocol` |
| `06-provider-engine.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `agentCliAdapter` |
| `06-provider-engine.js` | `06b-prompt-registry.js` | forward | `PROMPT_EN`, `getPromptPack` |
| `06-provider-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryPromptSection` |
| `06-provider-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `06-provider-engine.js` | `07-autonomy.js` | forward | `toolPackForName` |
| `06-provider-engine.js` | `11-native-tools.js` | forward | `probeRgAsync` |
| `06b-prompt-registry.js` | `00-boot.js` | backward | `text` |
| `06c-agent-loop-hooks.js` | `00-boot.js` | backward | `makeId` |
| `06c-agent-loop-hooks.js` | `04-permission-runtime.js` | backward | `logEvent`, `redact` |
| `06d-memory-domain.js` | `00-boot.js` | backward | `SKILL_ID_RE`, `agentCliHomes`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `makeId`, `neutralizeFenceTag`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text`, `tildePath` |
| `06d-memory-domain.js` | `01-config.js` | backward | `DurableJsonStore`, `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06d-memory-domain.js` | `01c-runtime-flags.js` | backward | `coreMemoryCharBudget`, `coreMemoryMaxItems`, `memoryFixedSelectionMax`, `memoryIndexCharCap`, `memoryRelevanceMax`, `memoryVectorRecallEnabled` |
| `06d-memory-domain.js` | `02-session-store.js` | backward | `loadSession` |
| `06d-memory-domain.js` | `03-bridge-guard.js` | backward | `normalizeCwd` |
| `06d-memory-domain.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent` |
| `06d-memory-domain.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider` |
| `06d-memory-domain.js` | `06-provider-engine.js` | backward | `providerRawCompletion` |
| `06d-memory-domain.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `06d-memory-domain.js` | `06h-retrieval-index.js` | backward | `createRetrievalCorpusCache`, `rankRetrievalCorpus`, `reciprocalRankFusion` |
| `06e-mission-domain.js` | `00-boot.js` | backward | `neutralizeFenceTag`, `nowIso`, `text` |
| `06e-mission-domain.js` | `02-session-store.js` | backward | `MISSION_MAX_TEXT`, `MISSION_STALL_LIMIT`, `evaluateMissionCheck`, `maybeFinalizeMission`, `missionProgressDigest`, `recordMissionCheckResult`, `saveSession`, `sessionObjectIsStale` |
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
| `06k-config-patch.js` | `00-boot.js` | backward | `fsp`, `os`, `path`, `paths` |
| `06k-config-patch.js` | `01-config.js` | backward | `ConfigPatchHooks`, `invalidateAgentCliPathCaches`, `mutateConfig`, `syncAgentCliMcpManifests`, `syncAgentRolesToClaude`, `syncClaudeCliSettings`, `syncMcpServersToClaude` |
| `06k-config-patch.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES_REQUIRING_CONFIRM` |
| `06k-config-patch.js` | `02-session-store.js` | backward | `rememberLastUsedEngineRoute` |
| `06k-config-patch.js` | `02e-session-engine-route.js` | backward | `sessionEngineRouteFromConfig` |
| `06k-config-patch.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `invalidateMcpRuntime`, `logEvent` |
| `06k-config-patch.js` | `05-claude-engine.js` | backward | `maskedSecretConflictMessage`, `maskedSecretConflicts`, `unmaskSecrets` |
| `06k-config-patch.js` | `06i-steward-core.js` | backward | `StewardHooks` |
| `07-autonomy.js` | `00-boot.js` | backward | `TOOL_TIER_RANK`, `URL`, `appendUsageLedger`, `claudeCostFields`, `cp`, `createNdjsonLineFeeder`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `07-autonomy.js` | `01-config.js` | backward | `atomicWriteJson`, `buildUserEnvelope`, `decodeClaudeCliText`, `detectClaudePath`, `effectiveAnthropicEnv`, `generateAgentNodeMcpConfig`, `safeSessionId` |
| `07-autonomy.js` | `01c-runtime-flags.js` | backward | `appendOnlyToolSchemasEnabled`, `observationRecallEnabled` |
| `07-autonomy.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn`, `cmdLineBudgetFor`, `spawnCmdLineLength` |
| `07-autonomy.js` | `01e-permission-modes.js` | backward | `BUILTIN_AGENT_ROLES`, `CLAUDE_PERMISSION_MODE_MAP`, `mergeAgentRole`, `normalizeAgentRole` |
| `07-autonomy.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `registerIntervention`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveSession`, `settleIntervention` |
| `07-autonomy.js` | `02f-turn-effect-kinds.js` | backward | `unprefixedBridgedName` |
| `07-autonomy.js` | `03-bridge-guard.js` | backward | `existsExecutableAsync`, `normalizeCwd`, `pathWithinRoot` |
| `07-autonomy.js` | `04-permission-runtime.js` | backward | `PermissionWaitHooks`, `killChildTree`, `logEvent`, `parseClaudeEvent`, `pendingPermissions`, `pendingPlans`, `promptWaitMs`, `redact`, `resolveBridge`, `runAutomaticInterventionDecision` |
| `07-autonomy.js` | `04h-provider-http.js` | backward | `withTransientRetry` |
| `07-autonomy.js` | `04i-provider-wire.js` | backward | `ProviderWireHooks`, `providerWireProtocol`, `providerWireProtocolForBody` |
| `07-autonomy.js` | `06-provider-engine.js` | backward | `appendResponseLanguagePolicy`, `toolRequirementsMet` |
| `07-autonomy.js` | `06i-steward-core.js` | backward | `isStewardToolName`, `stewardToolPermanentlyExempt` |
| `07-autonomy.js` | `08-agent-runs.js` | forward | `saveAgentRun` |
| `07-autonomy.js` | `09d-token-estimation.js` | forward | `estimateTextTokensMemo` |
| `07-autonomy.js` | `10-context-governance.js` | forward | `CONTEXT_OVERFLOW_PATTERNS`, `cacheContextLength`, `extractContextLength`, `isContextOverflowError` |
| `07-autonomy.js` | `13f-native-tool-schemas.js` | forward | `MCP_TOOLS` |
| `08-agent-runs.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `TOOL_TIER_RANK`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `text`, `zlib` |
| `08-agent-runs.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `readFileTail`, `safeSessionId` |
| `08-agent-runs.js` | `01c-runtime-flags.js` | backward | `estimateBucketsEnabled` |
| `08-agent-runs.js` | `02-session-store.js` | backward | `MISSION_STALL_SIGNAL_WINDOW_MS`, `bridgedWriteRelativePathArg`, `isProviderToolArgsObject`, `missionSignalThrottleAllow`, `mutateSession`, `providerHistoryToolCalls`, `readInterventions`, `registerIntervention`, `settleIntervention` |
| `08-agent-runs.js` | `02d-session-overrides.js` | backward | `liveSessionPermissionMode` |
| `08-agent-runs.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `guardWorkspacePath`, `journalBridgedWrite`, `normalizeCwd` |
| `08-agent-runs.js` | `04-permission-runtime.js` | backward | `bridgedServerUnavailableMessage`, `collectBridgedTools`, `getBridgedClient`, `logEvent`, `redact`, `resolveBridge` |
| `08-agent-runs.js` | `04h-provider-http.js` | backward | `providerBaseWithV1`, `providerCallIsTransient`, `withTransientRetry` |
| `08-agent-runs.js` | `04i-provider-wire.js` | backward | `applyProviderReasoningEffort`, `providerWireOutputLimited`, `providerWireProtocol` |
| `08-agent-runs.js` | `05-claude-engine.js` | backward | `resolveProvider` |
| `08-agent-runs.js` | `06-provider-engine.js` | backward | `TOOL_ITERATION_BUDGETS`, `appendResponseLanguagePolicy`, `buildProviderSystemPrompt`, `getCapabilities`, `readProjectMemory`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget` |
| `08-agent-runs.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease` |
| `08-agent-runs.js` | `07-autonomy.js` | backward | `LOOP_GUARD_LIMITS`, `activeAgentRuns`, `agentRunDir`, `agentRunFile`, `agentRunWriteChains`, `bridgedToolTier`, `buildOpenAiTools`, `classifyToolPacks`, `fetchOpenAiModels`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `nativeToolTier`, `neutralizeInjectedPrefixes`, `openAiStreamOnce`, `runClaudeSubAgentOnce`, `toolPackForName` |
| `08-agent-runs.js` | `09-workflow.js` | forward | `launchPersistedAgentRun` |
| `08-agent-runs.js` | `09d-token-estimation.js` | forward | `estimateContentTokens`, `estimateHistoryTokens`, `setEstimateBucketsV1` |
| `08-agent-runs.js` | `10-context-governance.js` | forward | `boundToolResultForDisplay`, `compactionRefetchRefusal`, `compactionRefetchWarning`, `createCompactionRefetchGuard`, `estimateFactor`, `isContextOverflowError`, `maybeCompactSubHistory`, `noteWindowOvershoot`, `recordCompactUsage`, `runForcedOverflowCompaction`, `truncateToolResult`, `writeHistorySnapshot` |
| `08-agent-runs.js` | `13-http-router.js` | forward | `resolveNodeModel` |
| `08-agent-runs.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `09-workflow.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `makeId`, `neutralizeFenceTag`, `nowIso`, `safeJsonParse`, `text` |
| `09-workflow.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `09-workflow.js` | `01c-runtime-flags.js` | backward | `budgetGuardDecision`, `budgetGuardEnabled`, `budgetGuardTurnTokens`, `budgetGuardWarnRatio`, `estimateBucketsEnabled`, `sessionNotesInjectEnabled`, `toolByteBudgetShadowBytes`, `toolTimeBudgetEnabled`, `toolTimeBudgetHardMs`, `toolTimeBudgetShadowEnabled`, `toolTimeBudgetWarnMs`, `volatileTailLayoutEnabled` |
| `09-workflow.js` | `02-session-store.js` | backward | `applyMissionUpdate`, `bridgedWriteRelativePathArg`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isProviderToolArgsObject`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `mutateSession`, `normalizeTodoItems`, `providerHistoryToolCalls`, `readSessionNotes`, `reconcileWorkspaceTurnBaseline`, `recordMissionBudgetTrippedChange`, `recordMissionStalledChange`, `registerIntervention`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveSession`, `saveTurnFinalSession`, `settleIntervention` |
| `09-workflow.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `09-workflow.js` | `02d-session-overrides.js` | backward | `liveSessionPermissionMode`, `sessionDesktopToolsOf` |
| `09-workflow.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `buildAttachmentPrompt`, `cwdWarning`, `journalBridgedWrite`, `normalizeCwd`, `preflightWriteBoundary` |
| `09-workflow.js` | `04-permission-runtime.js` | backward | `activeChildren`, `appendLiveTail`, `bridgedServerUnavailableMessage`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `collectBridgedTools`, `getBridgedClient`, `hasPendingPermissionForSession`, `hasPendingQuestionForSession`, `installActiveChildEventFanout`, `lastAssistantEngine`, `logEvent`, `permissionWaitMs`, `redact`, `requestUserQuestion`, `resolveBridge`, `stopSession` |
| `09-workflow.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `09-workflow.js` | `04h-provider-http.js` | backward | `withTransientRetry` |
| `09-workflow.js` | `04i-provider-wire.js` | backward | `applyProviderReasoningEffort`, `providerWireOutputLimited`, `providerWireProtocol` |
| `09-workflow.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `resolveProvider`, `stripUrlUserinfo` |
| `09-workflow.js` | `06-provider-engine.js` | backward | `appendTurnPolicies`, `buildPromptTaskContext`, `buildStableSystemPrompt`, `buildVolatileParts`, `evalPlaybookAvailability`, `getCapabilities`, `loadAllPlaybooks`, `readProjectMemory`, `repairNodeJsonViaProvider`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget`, `softwareEngineeringTaskProfile` |
| `09-workflow.js` | `06b-prompt-registry.js` | backward | `PROMPT_EN`, `PROMPT_PACK_VERSION`, `getPromptPack` |
| `09-workflow.js` | `06c-agent-loop-hooks.js` | backward | `AgentLoopHooks` |
| `09-workflow.js` | `06d-memory-domain.js` | backward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `extractMemoryRelationProposals`, `filterMemoryForNativeCli`, `proposeMemoryRelation`, `resolveMemoryPreflight` |
| `09-workflow.js` | `06f-autonomy-grants.js` | backward | `consumeGrant` |
| `09-workflow.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources` |
| `09-workflow.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `09-workflow.js` | `07-autonomy.js` | backward | `ACTION_VIEW_MIN_CHARS`, `ACTION_VIEW_TOOLS`, `LOOP_GUARD_LIMITS`, `MAIL_GLOBAL_MAX`, `MAIL_PER_SENDER_MAX`, `MAIL_QUEUE_MAX`, `MAIL_TEXT_MAX`, `POOL_CHAIN_MAX`, `POOL_GRACE_MS`, `POOL_MAX_TOTAL`, `actionTargetMeta`, `activeAgentRuns`, `agentRunFile`, `bridgedToolTier`, `buildOpenAiTools`, `classifyRuntimeToolFailure`, `cleanupAgentWorktree`, `compareToolRetrievalShadow`, `createAgentWorktree`, `createToolLoadingState`, `drainSteerQueue`, `estimateToolSchemaTokens`, `failoverStickyBase`, `finalizeAgentWorktree`, `getAgentRoleLibrary`, `hasInterruptingSteer`, `looksLikePlan`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolDisabledByPolicy`, `nativeToolGate`, `nativeToolTier`, `openAiStreamOnce`, `projectActionModelView`, `requestNativePermission`, `requestPlanApproval`, `resumeInFlight`, `toolDisabledResult` |
| `09-workflow.js` | `08-agent-runs.js` | backward | `accumulateRunUsage`, `agentRunResultSlice`, `agentRunSaveFailures`, `aggregateAgentVote`, `aggregateCoverage`, `appendAgentRunEvent`, `buildAgentRunEnvelope`, `buildOrchestrateHint`, `buildUpstreamContext`, `bumpRunIntervention`, `classifyNodeErrorText`, `computeSchedulerStep`, `dedupeAgentFindings`, `deriveNodeOutputs`, `evalWaitCondition`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `flushAgentRunEvents`, `formatNodeEvidencePrompt`, `getAgentWorkflows`, `indexNodeEvidence`, `materializePoolItem`, `nodeDeliveryEligibility`, `normalizeAgentGate`, `normalizeWaitSpec`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `parseStructuredAgentOutput`, `poolChainDepth`, `propagateAssignments`, `purgeNodeEvidence`, `readAgentRunRecord`, `recordAgentNodeProgress`, `recordRunBudgetTrippedEvent`, `recordRunStalledEvent`, `resolveAgentTeamRoute`, `resolveOrchestrateNodes`, `runSubAgent`, `sanitizeAgentOutputSchema`, `saveAgentRun`, `summarizeAgentWorkflowRun`, `syncRunEventSeq`, `validateAgentJsonSchema`, `verdictPasses`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `09-workflow.js` | `09b-replan-ledger.js` | backward | `proposeReplanPatch`, `recordNodeContinuation`, `validateReplanPatch` |
| `09-workflow.js` | `09d-token-estimation.js` | backward | `estimateContentTokens`, `estimateHistoryTokens`, `setEstimateBucketsV1` |
| `09-workflow.js` | `10-context-governance.js` | forward | `agentNodeContextWindow`, `appendPromptToLastUserMessage`, `boundToolResultForDisplay`, `buildObservationRecallPrompt`, `buildSessionNotesInjectPrompt`, `compactionRefetchRefusal`, `compactionRefetchWarning`, `createCompactionRefetchGuard`, `estimateFactor`, `historyStartsWithCompactionSummary`, `isContextOverflowError`, `maybeAutoCompact`, `noteEstimateSample`, `noteWindowOvershoot`, `providerContextWindow`, `recordCompactUsage`, `runForcedOverflowCompaction`, `truncateToolResult`, `upsertCompactMarker`, `writeHistorySnapshot` |
| `09-workflow.js` | `13-http-router.js` | forward | `buildModelHint`, `resolveNodeModel` |
| `09b-replan-ledger.js` | `00-boot.js` | backward | `TOOL_TIER_RANK`, `hashArgs`, `makeId`, `nowIso` |
| `09d-token-estimation.js` | `07-autonomy.js` | backward | `estimateToolSchemaTokens` |
| `09d-token-estimation.js` | `10-context-governance.js` | forward | `ESTIMATION_RULES` |
| `10-context-governance.js` | `00-boot.js` | backward | `URL`, `apiSessionIdInvalid`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fs`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `text`, `zlib` |
| `10-context-governance.js` | `01-config.js` | backward | `DurableJsonStore`, `readConfig`, `readJsonBody`, `safeSessionId`, `send` |
| `10-context-governance.js` | `01c-runtime-flags.js` | backward | `evaporateBudgetBoundaryEnabled`, `historyReadDedupEnabled`, `observationRecallEnabled`, `reseedReattachFilesEnabled`, `reseedTailUnitsEnabled`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `summaryEntityCheckEnabled`, `summaryFactTableCap`, `summaryFactTableEnabled`, `summaryPromptI18nEnabled`, `summaryRefineEnabled`, `summarySingleShotEnabled` |
| `10-context-governance.js` | `01e-permission-modes.js` | backward | `permissionModeFrom`, `resolvePermissionMode` |
| `10-context-governance.js` | `02-session-store.js` | backward | `createSession`, `journalBytesAdjust`, `journalDir`, `journalGc`, `loadSession`, `mutateSession`, `readSessionNotes`, `rememberLastUsedEngineRoute`, `repairProviderHistoryPairing`, `saveSession`, `sessionMessagesDelta`, `sessionMessagesStamp`, `sessionObjectIsStale`, `toolImageSessionTag`, `withJournalWriteLock`, `writeSessionNotes` |
| `10-context-governance.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute`, `inferSessionEngineRoute`, `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `10-context-governance.js` | `04-permission-runtime.js` | backward | `driverAutoSessions`, `logEvent`, `redact`, `stopSession`, `turnSettlers` |
| `10-context-governance.js` | `04h-provider-http.js` | backward | `providerBaseWithV1` |
| `10-context-governance.js` | `04i-provider-wire.js` | backward | `normalizeProviderApiStyle`, `providerWireProtocol` |
| `10-context-governance.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `agentCliAdapter`, `runClaudeTurn` |
| `10-context-governance.js` | `06-provider-engine.js` | backward | `buildProviderSystemPrompt`, `maybeWriteThreadBrief`, `settleThreadBrief` |
| `10-context-governance.js` | `06e-mission-domain.js` | backward | `runMissionDriver` |
| `10-context-governance.js` | `06f-autonomy-grants.js` | backward | `activeDriverRuns`, `bindDriverRun`, `revokeGrantsForRun` |
| `10-context-governance.js` | `06i-steward-core.js` | backward | `StewardHooks`, `stewardTaintToolCall` |
| `10-context-governance.js` | `07-autonomy.js` | backward | `fetchOpenAiModels`, `nativeToolTier` |
| `10-context-governance.js` | `09-workflow.js` | backward | `runOpenAiTurn` |
| `10-context-governance.js` | `09d-token-estimation.js` | backward | `CONTEXT_WINDOW_FALLBACK`, `EVAPORATED_PREFIX`, `countCjkCodeUnits`, `estimateContentTokens`, `estimateHistoryTokens`, `estimateTextTokens`, `fmtTokensServer`, `tokensFromTextCounts` |
| `11-native-tools.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `RUYI_PATH_BEFORE_VENDOR`, `URL`, `cp`, `createConsoleLineDecoder`, `crypto`, `dataRoot`, `dataRootAliases`, `decodeConsoleText`, `fs`, `fsp`, `json`, `nowIso`, `os`, `path`, `paths`, `ruyiVendorBinDir`, `safeJsonParse`, `samePathEntry`, `text`, `zlib` |
| `11-native-tools.js` | `01-config.js` | backward | `RUNTIME`, `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath` |
| `11-native-tools.js` | `01c-runtime-flags.js` | backward | `observationRecallEnabled` |
| `11-native-tools.js` | `02-session-store.js` | backward | `loadSession` |
| `11-native-tools.js` | `03-bridge-guard.js` | backward | `ensureDataRootReal`, `existsExecutable`, `existsExecutableAsync`, `guardFileToolPath`, `isSensitiveDataPath` |
| `11-native-tools.js` | `04-permission-runtime.js` | backward | `activeChildren`, `collectBridgedTools`, `killChildTree`, `logEvent`, `redact` |
| `11-native-tools.js` | `06-provider-engine.js` | backward | `markNetworkOnline`, `networkAnchors`, `probeAny` |
| `11-native-tools.js` | `06i-steward-core.js` | backward | `isStewardToolName` |
| `11-native-tools.js` | `07-autonomy.js` | backward | `buildToolCatalog` |
| `11-native-tools.js` | `13f-native-tool-schemas.js` | forward | `MCP_TOOLS` |
| `11b-file-text-io.js` | `00-boot.js` | backward | `cp`, `text` |
| `12-tool-dispatch.js` | `00-boot.js` | backward | `OVERLAY_ID`, `SKILL_ID_RE`, `agentCliHomes`, `cp`, `crypto`, `externalRoot`, `fs`, `fsp`, `makeId`, `os`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `spawnDetachedChecked`, `text` |
| `12-tool-dispatch.js` | `01-config.js` | backward | `RUNTIME`, `agentCliLauncherOk`, `commandForSelfMcp`, `defaultConfig`, `ensureDesktopMcpWarm`, `externalServerJs`, `readConfig`, `selectedAgentCli`, `staticBase` |
| `12-tool-dispatch.js` | `01c-runtime-flags.js` | backward | `execResultCacheEnabled`, `execResultCacheMaxEntries`, `observationRecallEnabled` |
| `12-tool-dispatch.js` | `02-session-store.js` | backward | `JOURNAL_MAX_BEFORE_BYTES`, `bridgedWriteRelativePathArg`, `journalDropEntries`, `journalRecord`, `journalRecordMany`, `journalSessionCtx`, `loadSession`, `normalizeTodoItems` |
| `12-tool-dispatch.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf` |
| `12-tool-dispatch.js` | `03-bridge-guard.js` | backward | `OFFICE_WRITER_LIB_RE`, `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `buildOpenSpawn`, `guardFileToolPath`, `guardWorkspaceExecute`, `journalBridgedWrite`, `normalizeCwd`, `pathWithinRoot`, `realpathForContainment`, `resolveExecCwd` |
| `12-tool-dispatch.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `12-tool-dispatch.js` | `04-permission-runtime.js` | backward | `bridgedServerUnavailableMessage`, `configureMcpFromTool`, `getBridgedClient`, `logEvent`, `resolveBridge`, `resolveExternalMcpServers`, `safeMcpInventory` |
| `12-tool-dispatch.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `12-tool-dispatch.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider` |
| `12-tool-dispatch.js` | `06-provider-engine.js` | backward | `PLAYBOOK_REQUIRES`, `buildRuntimeIdentityFacts`, `evalPlaybookAvailability`, `getCapabilities`, `loadAllPlaybooks`, `peekCapabilities` |
| `12-tool-dispatch.js` | `06d-memory-domain.js` | backward | `listWorkbenchMemories`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `readWorkbenchMemory` |
| `12-tool-dispatch.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `12-tool-dispatch.js` | `07-autonomy.js` | backward | `bridgedToolTier`, `compareToolRetrievalShadow`, `listCompactTools`, `nativeToolDisabledByPolicy`, `nativeToolSchema`, `searchToolCatalog`, `toolDisabledResult` |
| `12-tool-dispatch.js` | `08-agent-runs.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `getAgentWorkflows` |
| `12-tool-dispatch.js` | `10-context-governance.js` | backward | `TOOL_RESULT_CAP`, `providerTurnQuotaKey`, `rehydrateObservation` |
| `12-tool-dispatch.js` | `11-native-tools.js` | backward | `isBinaryReadPath`, `levenshtein`, `probeRgAsync`, `readIfExists`, `shellKill`, `shellList`, `shellMcpChildGuard`, `shellPoll`, `shellSend`, `shellStart` |
| `12-tool-dispatch.js` | `11b-file-text-io.js` | backward | `FileTextIo` |
| `13-http-router.js` | `00-boot.js` | backward | `APP_NAME`, `CONFIG_SCHEMA`, `DATA_ROOT_MIGRATION`, `DEFAULT_PORT`, `EventStreamHooks`, `OVERLAY_ID`, `SKILL_ID_RE`, `URL`, `VERSION`, `apiFailure`, `apiSessionIdInvalid`, `apiSessionNotFound`, `buildUsageSummary`, `cp`, `crypto`, `dataRootAliases`, `decodeConsoleText`, `ensureDirs`, `exePath`, `externalRoot`, `flushUsageLedgerSync`, `fs`, `fsp`, `http`, `isPkg`, `json`, `makeId`, `nowIso`, `os`, `path`, `paths`, `readline`, `recordInstallLaunch`, `safeJsonParse`, `spawnDetachedChecked`, `text`, `zlib` |
| `13-http-router.js` | `00b-ruyi-names.js` | backward | `LEGACY_RUYI_MCP_SERVER_IDS`, `RUYI_MCP_SERVER_ID` |
| `13-http-router.js` | `01-config.js` | backward | `ConfigPatchHooks`, `RUNTIME`, `atomicWriteJson`, `authorizeRoute`, `autoImportClaudeCodeMcp`, `contentTypeFor`, `decodeClaudeCliText`, `desktopMcpDetectionPending`, `detectClaudePath`, `detectDesktopMcp`, `detectKimiPath`, `effectiveAnthropicEnv`, `ensureDesktopMcpWarm`, `externalServerJs`, `generateMcpConfig`, `hostAllowed`, `mcpConfigFilePath`, `mutateConfig`, `prepareAgentCliSpawn`, `readConfig`, `readJsonBody`, `safeSessionId`, `selectedAgentCli`, `send`, `sendError`, `serveStatic`, `syncAgentCliMcpManifests`, `syncAgentRolesToClaude`, `syncClaudeCliSettings`, `syncMcpServersToClaude`, `tokenMatches`, `tokenOk` |
| `13-http-router.js` | `01c-runtime-flags.js` | backward | `coreMemoryCharBudget`, `coreMemoryMaxItems`, `memoryFixedSelectionMax`, `observationRecallEnabled` |
| `13-http-router.js` | `01e-permission-modes.js` | backward | `BUILTIN_AGENT_ROLES`, `PERMISSION_MODES`, `normalizeAgentRole` |
| `13-http-router.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES` |
| `13-http-router.js` | `02-session-store.js` | backward | `MISSION_MAX_TEXT`, `applyMissionUpdate`, `bumpMissionChangeSeq`, `evaluateMissionCheck`, `flushSessionIndexSync`, `invalidateSessionIndex`, `journalDir`, `journalReadIndex`, `loadSession`, `markInterruptedInterventions`, `maybeFinalizeMission`, `missionControlCommand`, `mutateSession`, `normalizeMission`, `normalizeTodoItems`, `readSessionRouteHead`, `recordMissionCheckResult`, `saveSession`, `workspaceBaselineIsCodePath`, `workspaceBaselinePathKey` |
| `13-http-router.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute` |
| `13-http-router.js` | `03-bridge-guard.js` | backward | `PREVIEW_TEXT_EXTS`, `buildCodeEditorSpawn`, `buildRevealSpawn`, `ensureDataRootReal`, `existsExecutable`, `existsExecutableAsync`, `fileAllowedRoots`, `guardWorkspacePath`, `isSensitiveDataPath`, `launchCodeEditor`, `materializeCheckpointEditorDiff`, `normalizeCwd`, `pathWithinAnyRoot`, `pathWithinRoot`, `readFilePreview`, `resolvePreferredCodeEditor`, `resolveWorkspace` |
| `13-http-router.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `13-http-router.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `activeChildren`, `killAllMcpClients`, `killOwnProcessTree`, `logEvent`, `makeAttachmentRecord`, `redact`, `resolveExternalMcpServers`, `stopSession` |
| `13-http-router.js` | `05-claude-engine.js` | backward | `CLAUDE_ENDPOINT_PRESETS`, `PROVIDER_PRESETS`, `activeOpenAiProvider`, `agentCliAdapter`, `maskProviders`, `maskedSecretConflictMessage`, `maskedSecretConflicts`, `resolveProvider`, `sanitizeProvider`, `unmaskProviders` |
| `13-http-router.js` | `05b-kimi-bridge.js` | backward | `applyKimiStatusToSession`, `kimiSessionStatus` |
| `13-http-router.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES`, `buildMetricsPayload`, `buildOpsMetrics`, `collectAudit`, `collectStorageStats`, `deleteUserPlaybook`, `draftPlaybookFromSession`, `getCapabilities`, `listPlaybooksWithAvailability`, `matchServiceEntry`, `maybeRecordStorageTrend`, `normalizePlaybook`, `recordRequestMetric`, `saveUserPlaybook`, `storageSweep` |
| `13-http-router.js` | `06d-memory-domain.js` | backward | `MEMORY_EXCLUSION_MAX`, `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `confirmMemoryRelation`, `decideMemoryProposal`, `deleteMemory`, `deleteMemoryRelation`, `draftMemoryFromSession`, `listMemoryProjectGroups`, `listMemoryRelations`, `loadMemoryRegistry`, `migrateLegacyAccMemory`, `migrateMemory`, `projectKeyForCwd`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `readMemoryItem`, `resolveCoreMemoryState`, `saveMemory`, `syncAgentInstructionImports`, `validateMemoryProposalSave` |
| `13-http-router.js` | `06f-autonomy-grants.js` | backward | `activeDriverRuns`, `autonomyGrants`, `dryRunGrantFiles`, `listGrantsView`, `normalizeGrant`, `revokeAllGrants`, `revokeGrant` |
| `13-http-router.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `13-http-router.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `buildClaudeAgentDefinitions`, `fetchOpenAiModels`, `getAgentRoleLibrary`, `projectAgentRoleFile`, `readClaudeProjectAgentRoles`, `readProjectAgentRoles`, `saveProjectAgentRoles`, `toolPackForName` |
| `13-http-router.js` | `08-agent-runs.js` | backward | `agentRunResultSlice`, `autoResumeInterruptedRuns`, `buildAgentRunEnvelope`, `deleteAgentWorkflow`, `getAgentWorkflows`, `markInterruptedAgentRuns`, `resolveOrchestrateNodes`, `saveAgentRun`, `saveAgentWorkflow` |
| `13-http-router.js` | `09-workflow.js` | backward | `AGENT_RUN_TERMINAL`, `deliverAgentRunEnvelope`, `runAgentWorkflow`, `settleWaitEnvelopes`, `waitForAgentRunResults` |
| `13-http-router.js` | `10-context-governance.js` | backward | `agentConversationContextMeta`, `cachedContextLength`, `configuredConversationWindow`, `contextWindowFromTable`, `learnedWindowCap`, `resolveContextWindow`, `runAgentExternalCompact`, `runProviderCompact`, `streamChat`, `truncateToolResult` |
| `13-http-router.js` | `11-native-tools.js` | backward | `killAllShellSessions`, `probeRgAsync` |
| `13-http-router.js` | `13b-api-domain-routes.js` | forward | `handleAudioApiRoutes`, `handleCheckpointApiRoutes`, `handleMcpApiRoutes`, `handleSteerApiRoute`, `maybeCompressImageAttachment`, `maybeOcrImageAttachment`, `maybeTranscribeAudioAttachment` |
| `13-http-router.js` | `13c-overlay-routes.js` | forward | `handleOverlayApiRoutes` |
| `13-http-router.js` | `13d-core-domain-routes.js` | forward | `handleAgentRunApiRoutes`, `handleInterventionApiRoutes`, `handleMissionsApiRoutes`, `handleSessionApiRoutes` |
| `13-http-router.js` | `13e-pretender-index.js` | forward | `warmPretenderProjectionIndex` |
| `13-http-router.js` | `13f-native-tool-schemas.js` | backward | `MCP_TOOLS` |
| `13-http-router.js` | `13s-scheduler.js` | forward | `handleSchedulerApiRoutes`, `startScheduler`, `stopScheduler` |
| `13b-api-domain-routes.js` | `00-boot.js` | backward | `ASR_MAX_BODY_BYTES`, `MigrationHooks`, `URL`, `apiFailure`, `apiSessionIdInvalid`, `appendUsageLedger`, `computeProviderCost`, `crypto`, `fsp`, `json`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `13b-api-domain-routes.js` | `01-config.js` | backward | `buildUserEnvelope`, `generateMcpConfig`, `mutateConfig`, `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `writeToChild` |
| `13b-api-domain-routes.js` | `02-session-store.js` | backward | `bumpMissionChangeSeq`, `journalRollback`, `mutateSession`, `rewindSession`, `saveSession` |
| `13b-api-domain-routes.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `ToolboxHooks`, `activeChildren`, `buildMcpConnectorInventory`, `collectBridgedTools`, `getBridgedClient`, `hasPendingQuestionForSession`, `invalidateMcpRuntime`, `logEvent`, `mutateMcpConnector`, `probeMcpConnector`, `redact`, `resolveBridge`, `resolveExternalMcpServers`, `scanMcpSources` |
| `13b-api-domain-routes.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `asrFixMessages`, `asrFixModeOf`, `asrFixSanity`, `maskExternalMcpServerForDisplay`, `providerFixCompletion`, `resolveAsrFixProvider`, `resolveAsrProvider`, `resolveAsrStreamProvider`, `sanitizeExternalMcpServer`, `transcribeAudioViaProvider` |
| `13b-api-domain-routes.js` | `06-provider-engine.js` | backward | `normalizeStoragePolicy`, `storageSweep` |
| `13b-api-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX`, `activeAgentRuns` |
| `13c-overlay-routes.js` | `00-boot.js` | backward | `cp`, `crypto`, `dataRoot`, `decodeConsoleText`, `externalRoot`, `fs`, `fsp`, `json`, `path` |
| `13c-overlay-routes.js` | `01-config.js` | backward | `readJsonBody`, `send`, `tokenOk` |
| `13c-overlay-routes.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13d-core-domain-routes.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `URL`, `apiFailure`, `apiSessionIdInvalid`, `apiSessionNotFound`, `crypto`, `dataRootAliases`, `fsp`, `json`, `makeId`, `nowIso`, `path`, `paths`, `safeDecodeURIComponent`, `safeJsonParse`, `text` |
| `13d-core-domain-routes.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_CLI_TOOL_PREFIX` |
| `13d-core-domain-routes.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `sessionPath`, `tokenMatches`, `tokenOk` |
| `13d-core-domain-routes.js` | `01c-runtime-flags.js` | backward | `sessionSearchIndexEnabled` |
| `13d-core-domain-routes.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `resolvePermissionMode` |
| `13d-core-domain-routes.js` | `02-session-store.js` | backward | `buildMissionAcceptanceProjection`, `bulkDeleteUnpinnedSessions`, `bumpMissionChangeSeq`, `compactInterventionJournal`, `createMissionContainer`, `createSession`, `deleteSession`, `detectDanglingTurn`, `foldTurnSummaries`, `journalReadIndex`, `listMissionContainers`, `listSessions`, `loadSession`, `missionAttachThread`, `missionContainerAcceptanceStamp`, `missionControlCommand`, `missionControlView`, `missionDetachThread`, `missionMergeInto`, `missionSplitThreads`, `patchMissionContainer`, `readInterventions`, `readMissionChangesWithMeta`, `readMissionContainer`, `readMissionSessionHead`, `readSessionHeadResilient`, `registerIntervention`, `saveSession`, `sessionBodyPaths`, `sessionBriefOf`, `sessionDisplayTitle`, `sessionKind`, `sessionMessagesDelta`, `sessionMeta`, `sessionMissionId`, `sessionOmittedProviderHistory`, `sessionProviderHistoryLength`, `settleIntervention`, `transitionInterventionState`, `updateSessionMeta` |
| `13d-core-domain-routes.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf`, `sessionDesktopToolsOverrides`, `sessionPermissionModeOverrides` |
| `13d-core-domain-routes.js` | `03-bridge-guard.js` | backward | `bridgedReadPathGate`, `normalizeCwd` |
| `13d-core-domain-routes.js` | `04-permission-runtime.js` | backward | `activeChildren`, `driverAutoSessions`, `extendUserQuestion`, `logEvent`, `normalizeQuestionAnswer`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `permissionWaitMs`, `redact`, `requestUserQuestion`, `runAutomaticInterventionDecision`, `turnSettlers` |
| `13d-core-domain-routes.js` | `06f-autonomy-grants.js` | backward | `CLI_TOOL_TIER`, `consumeGrant` |
| `13d-core-domain-routes.js` | `06h-retrieval-index.js` | backward | `createRetrievalCorpusCache`, `rankRetrievalCorpus`, `retrievalTerms` |
| `13d-core-domain-routes.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `aggregateMissionState`, `deriveStewardThreadState`, `stewardRuyiOwnedPath`, `stewardSanitizeText`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardThreadStateRank`, `stewardThreadTurnQueued`, `waitReasonFor` |
| `13d-core-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX`, `activeAgentRuns`, `agentRunFile`, `applyAgentWorktree`, `cleanupAgentWorktree`, `getAgentRoleLibrary`, `nativeToolGate`, `nativeToolTier`, `toolIsRevertible` |
| `13d-core-domain-routes.js` | `08-agent-runs.js` | backward | `agentRunDigestCache`, `agentRunDigestRow`, `agentRunDigestWriteSeq`, `agentRunEventsFile`, `appendAgentRunEvent`, `bumpRunIntervention`, `computeWaveSeq`, `listAgentRunDigests`, `listAgentRuns`, `materializePoolItem`, `nodeDeliveryEligibility`, `readAgentRunEvents`, `saveAgentRun` |
| `13d-core-domain-routes.js` | `09-workflow.js` | backward | `launchPersistedAgentRun` |
| `13d-core-domain-routes.js` | `09b-replan-ledger.js` | backward | `applyReplanPatch` |
| `13d-core-domain-routes.js` | `13e-pretender-index.js` | forward | `emptyMissionUsage`, `getPretenderProjectionIndex`, `overlayMissionCard`, `paginatePretenderProjection`, `pretenderEtag`, `pretenderHash`, `pretenderIndexMeta`, `pretenderIndexRuntime`, `pretenderLiveOverlayRevision`, `pretenderNotModified` |
| `13e-pretender-index.js` | `00-boot.js` | backward | `EventStreamHooks`, `URL`, `apiFailure`, `crypto`, `forEachUsageRow`, `fs`, `fsp`, `nowIso`, `path`, `paths`, `safeJsonParse`, `usageLedgerChangesSince` |
| `13e-pretender-index.js` | `01-config.js` | backward | `THREAD_INDEX_RECENT_DEFAULT`, `THREAD_INDEX_RECENT_MAX`, `THREAD_INDEX_RECENT_MIN`, `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath`, `sessionsDirOwnWriteSeq` |
| `13e-pretender-index.js` | `02-session-store.js` | backward | `compactInterventionJournal`, `interventionFilePath`, `readInterventionsWithMeta`, `sessionKind`, `sessionMissionId` |
| `13e-pretender-index.js` | `04-permission-runtime.js` | backward | `activeChildren` |
| `13e-pretender-index.js` | `06i-steward-core.js` | backward | `stewardAsksYouForThread`, `stewardThreadTurnQueued`, `stewardWatchedThread`, `threadOriginOf`, `threadVisible` |
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
| `13g-steward.js` | `13k-steward-threads.js` | backward | `stewardEnrichInboxRows`, `stewardImplQuickAsk`, `stewardImplThreadContinue`, `stewardImplThreadNew`, `stewardImplThreadNote`, `stewardImplThreadPermission`, `stewardImplThreadRead`, `stewardImplThreadRename`, `stewardImplThreadStatus`, `stewardImplThreadWorkspace`, `stewardImplThreadsSearch`, `stewardQuickClose` |
| `13g-steward.js` | `13l-steward-ops.js` | backward | `stewardImplAuditTail`, `stewardImplConfigGet`, `stewardImplConfigSet`, `stewardImplDecide`, `stewardImplFileRead`, `stewardImplHealth`, `stewardImplInboxRead`, `stewardImplMemorySearch`, `stewardImplMemoryVeto`, `stewardImplMemoryWrite`, `stewardImplMissions`, `stewardImplNotify`, `stewardImplPlaybookDraft`, `stewardImplPlaybooks`, `stewardImplProviders`, `stewardImplRunAction`, `stewardImplRunsStatus`, `stewardImplSelfStatus`, `stewardImplSkillToggle`, `stewardImplSkills`, `stewardImplThreadArtifactRead`, `stewardImplUsage`, `stewardImplWebFetch`, `stewardImplWebSearch` |
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
| `13i-steward-inbox.js` | `06i-steward-core.js` | backward | `STEWARD_EVENT_KINDS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardCoveringLastTurn`, `stewardSanitizeText`, `stewardWatchedThread` |
| `13i-steward-inbox.js` | `07-autonomy.js` | backward | `activeAgentRuns` |
| `13i-steward-inbox.js` | `08-agent-runs.js` | backward | `listAgentRuns`, `readAgentRunEvents` |
| `13i-steward-inbox.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13j-steward-tool-base.js` | `00-boot.js` | backward | `fsp`, `nowIso`, `path`, `safeJsonParse`, `text` |
| `13j-steward-tool-base.js` | `01-config.js` | backward | `atomicWriteJson`, `readFileTail`, `safeSessionId`, `sessionPath` |
| `13j-steward-tool-base.js` | `01e-permission-modes.js` | backward | `resolvePermissionMode` |
| `13j-steward-tool-base.js` | `02-session-store.js` | backward | `foldTurnSummaries`, `repairMissionChangeTornTail` |
| `13j-steward-tool-base.js` | `02d-session-overrides.js` | backward | `applySessionPermissionModeOverride` |
| `13j-steward-tool-base.js` | `06d-memory-domain.js` | backward | `cleanMemoryDate`, `projectKeyForCwd` |
| `13j-steward-tool-base.js` | `06i-steward-core.js` | backward | `STEWARD_CONFIG_SECRET_PATTERN`, `STEWARD_EXEMPT_DELEGATION_WINDOW_MS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_NOTIFY_WINDOW_MS`, `stewardSanitizeText` |
| `13j-steward-tool-base.js` | `10-context-governance.js` | backward | `providerTurnQuotaKey` |
| `13j-steward-tool-base.js` | `13i-steward-inbox.js` | backward | `stewardDir` |
| `13k-steward-threads.js` | `00-boot.js` | backward | `EventStreamHooks`, `dataRoot`, `dataRootAliases`, `fsp`, `nowIso`, `path`, `text` |
| `13k-steward-threads.js` | `01-config.js` | backward | `mutateConfig`, `normalizeWorkspacePathString`, `safeSessionId` |
| `13k-steward-threads.js` | `01c-runtime-flags.js` | backward | `sessionSearchIndexEnabled` |
| `13k-steward-threads.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `13k-steward-threads.js` | `02-session-store.js` | backward | `createSession`, `listSessions`, `loadSession`, `missionIndexAdd`, `readInterventions`, `readMissionContainer`, `saveSession`, `sessionBriefOf`, `sessionDisplayTitle`, `sessionMetaIsSteward`, `sessionMissionId`, `updateSessionMeta`, `withMissionContainerLock`, `writeMissionContainer` |
| `13k-steward-threads.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf`, `sessionPermissionModeOf` |
| `13k-steward-threads.js` | `04-permission-runtime.js` | backward | `PermissionWaitHooks`, `activeChildren`, `logEvent`, `redact`, `sanitizeFsSegmentName` |
| `13k-steward-threads.js` | `06-provider-engine.js` | backward | `listPlaybooksWithAvailability` |
| `13k-steward-threads.js` | `06d-memory-domain.js` | backward | `memoryIsExpired` |
| `13k-steward-threads.js` | `06i-steward-core.js` | backward | `STEWARD_ANSWER_BASIS`, `STEWARD_DELIVERABLE_CHARS`, `STEWARD_EXEMPT_INPUT_CHARS`, `STEWARD_QUICK_ANSWER_CHARS`, `STEWARD_QUICK_KIND`, `STEWARD_QUICK_QUESTION_CHARS`, `STEWARD_SESSION_ID`, `STEWARD_WORKSPACE_TABLE_MAX`, `StewardHooks`, `buildStewardBrief`, `deriveStewardThreadState`, `stewardAsksYouForThread`, `stewardAssemblePlaybookPrompt`, `stewardClipSay`, `stewardExemptExcerpt`, `stewardExemptHits`, `stewardExemptInputText`, `stewardExemptScanInput`, `stewardMayAct`, `stewardMayTightenTo`, `stewardPendingOneLine`, `stewardPermissionLabel`, `stewardPlaybookMissingInputs`, `stewardRuyiOwnedPath`, `stewardSamePath`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardTurnTaint`, `stewardWatchedThread`, `stewardWorkspaceLabels`, `stewardWorkspaceRootFor`, `waitReasonFor` |
| `13k-steward-threads.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13k-steward-threads.js` | `13b-api-domain-routes.js` | backward | `steerSessionCore` |
| `13k-steward-threads.js` | `13d-core-domain-routes.js` | backward | `buildMissionAggregateRows`, `missionPendingCounts`, `searchSessionsByContent` |
| `13k-steward-threads.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `overlayMissionCard` |
| `13k-steward-threads.js` | `13j-steward-tool-base.js` | backward | `STEWARD_NOTE_PREFIX`, `STEWARD_NOTE_TEXT_MAX`, `STEWARD_PENDING_SUMMARY_MAX`, `STEWARD_QUICK_ASKS_PER_TURN`, `STEWARD_READ_CALLS_PER_TURN`, `STEWARD_READ_CHARS_DEFAULT`, `STEWARD_READ_CHARS_MAX`, `STEWARD_READ_CHARS_MIN`, `STEWARD_READ_CLIP_MARK`, `STEWARD_READ_ROW_OVERHEAD`, `STEWARD_READ_TAIL_DEFAULT`, `STEWARD_READ_TAIL_MAX`, `STEWARD_SEARCH_LIMIT_DEFAULT`, `STEWARD_SEARCH_LIMIT_MAX`, `STEWARD_TITLE_MAX`, `stewardAppendDecision`, `stewardBasisOf`, `stewardClampInt`, `stewardEngineOf`, `stewardFail`, `stewardLastAssistantText`, `stewardQuickClosed`, `stewardQuickThread`, `stewardRawKind`, `stewardReadBucket`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnAssistantText`, `stewardTurnFiles`, `stewardTurnKeyOf`, `stewardTurnQuotaTake`, `stewardTurnTaintedBy` |
| `13l-steward-ops.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `forEachUsageRow`, `fsp`, `makeId`, `nowIso`, `safeJsonParse`, `text`, `usageDayKeyMemo` |
| `13l-steward-ops.js` | `01-config.js` | backward | `ConfigPatchHooks`, `normalizeConfig`, `safeSessionId` |
| `13l-steward-ops.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES_REQUIRING_CONFIRM` |
| `13l-steward-ops.js` | `02-session-store.js` | backward | `loadSession`, `readInterventions` |
| `13l-steward-ops.js` | `05-claude-engine.js` | backward | `maskProviders`, `maskedSecretConflictMessage`, `maskedSecretConflicts`, `unmaskSecrets` |
| `13l-steward-ops.js` | `06-provider-engine.js` | backward | `collectAudit`, `draftPlaybookFromSession`, `listPlaybooksWithAvailability` |
| `13l-steward-ops.js` | `06d-memory-domain.js` | backward | `cleanMemoryDate`, `memoryIsExpired`, `memoryProposalLooksSensitive` |
| `13l-steward-ops.js` | `06i-steward-core.js` | backward | `STEWARD_CATALOG_DESC_CHARS`, `STEWARD_CATALOG_ROWS`, `STEWARD_EXEMPT_CATEGORY_LABELS`, `STEWARD_EYES_CHARS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_NOTIFY_KINDS`, `STEWARD_NOTIFY_TEXT_CHARS`, `STEWARD_SESSION_ID`, `stewardConfigHelpFor`, `stewardConfigTierFor`, `stewardExemptDelegationVerdict`, `stewardExemptHits`, `stewardExemptReason`, `stewardExemptRiskNote`, `stewardExemptScanInput`, `stewardMayAct`, `stewardMemoryTerms`, `stewardPermissionLabel`, `stewardPermissionRank`, `stewardSamePath`, `stewardSanitizeText`, `stewardStateLabel`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardTermJaccard`, `stewardThreadArtifactFiles`, `stewardWatchedThread`, `stewardWorkspaceRootFor`, `threadOriginOf` |
| `13l-steward-ops.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `agentRunFile` |
| `13l-steward-ops.js` | `08-agent-runs.js` | backward | `classifyRunResumeTier`, `listAgentRuns` |
| `13l-steward-ops.js` | `12-tool-dispatch.js` | backward | `buildWorkbenchSelfStatus` |
| `13l-steward-ops.js` | `13-http-router.js` | backward | `setSessionSkillsCore` |
| `13l-steward-ops.js` | `13d-core-domain-routes.js` | backward | `agentRunActionCommand`, `buildMissionAggregateRows`, `decideIntervention`, `missionRunDigest` |
| `13l-steward-ops.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13l-steward-ops.js` | `13i-steward-inbox.js` | backward | `stewardInboxRead`, `stewardInboxState` |
| `13l-steward-ops.js` | `13j-steward-tool-base.js` | backward | `STEWARD_AUDIT_LIMIT_DEFAULT`, `STEWARD_AUDIT_LIMIT_MAX`, `STEWARD_MEMORY_MERGED_FROM_MAX`, `STEWARD_PLAYBOOK_DRAFTS_PER_TURN`, `STEWARD_READ_CALLS_PER_TURN`, `STEWARD_RUNS_MAX`, `STEWARD_STEER_TEXT_MAX`, `stewardAppendDecision`, `stewardBasisOf`, `stewardClampInt`, `stewardExemptDelegationRecord`, `stewardExemptDelegationsInWindow`, `stewardFail`, `stewardMarkTurnTainted`, `stewardMemoryScopeMatches`, `stewardMemoryScopeOf`, `stewardMutateMemory`, `stewardNormalizeMemoryScope`, `stewardNotifiesInWindow`, `stewardNotifyRecord`, `stewardRawKind`, `stewardReadBucket`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnKeyOf`, `stewardTurnQuotaTake`, `stewardTurnTaintedBy` |
| `13l-steward-ops.js` | `13k-steward-threads.js` | backward | `stewardExemptDelegatedLog`, `stewardExemptLiveTurn`, `stewardExemptPendingSummary`, `stewardKnownWorkspaces`, `stewardLiveTurnPermissionMode`, `stewardSeatedByUser`, `stewardSeatedFail`, `stewardTriggerOf`, `stewardWorkspaceNameOf` |
| `13m-steward-runner-base.js` | `00-boot.js` | backward | `SESSION_SCHEMA`, `nowIso`, `paths` |
| `13m-steward-runner-base.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES`, `normalizeAgentCliType` |
| `13m-steward-runner-base.js` | `02-session-store.js` | backward | `loadSession`, `saveSession` |
| `13m-steward-runner-base.js` | `02e-session-engine-route.js` | backward | `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `13m-steward-runner-base.js` | `04-permission-runtime.js` | backward | `logEvent`, `stopSession` |
| `13m-steward-runner-base.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES` |
| `13m-steward-runner-base.js` | `06i-steward-core.js` | backward | `STEWARD_PERMISSION_MODE`, `STEWARD_SESSION_ID`, `STEWARD_SESSION_TITLE`, `stewardSanitizeText` |
| `13n-steward-arbiter.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `crypto`, `forEachUsageRow`, `fs`, `path`, `usageDayKey`, `usageDayKeyMemo`, `usageRangeLowerMs` |
| `13n-steward-arbiter.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13n-steward-arbiter.js` | `02-session-store.js` | backward | `readInterventions`, `recordMissionBudgetTrippedChange` |
| `13n-steward-arbiter.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13n-steward-arbiter.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `stewardSanitizeText`, `waitReasonFor` |
| `13n-steward-arbiter.js` | `13m-steward-runner-base.js` | backward | `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS` |
| `13o-steward-runner-prompt.js` | `00-boot.js` | backward | `fsp`, `path`, `text` |
| `13o-steward-runner-prompt.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13o-steward-runner-prompt.js` | `02-session-store.js` | backward | `listSessions`, `readMissionContainer`, `sessionDisplayTitle`, `sessionMetaIsSteward`, `sessionMissionId` |
| `13o-steward-runner-prompt.js` | `02d-session-overrides.js` | backward | `applySessionPermissionModeOverride` |
| `13o-steward-runner-prompt.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent`, `redact` |
| `13o-steward-runner-prompt.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13o-steward-runner-prompt.js` | `06d-memory-domain.js` | backward | `memoryIsExpired` |
| `13o-steward-runner-prompt.js` | `06i-steward-core.js` | backward | `STEWARD_DIGEST_LIMITS`, `STEWARD_KNOWN_WORKSPACE_LIMITS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_SESSION_ID`, `STEWARD_WORKSPACE_TABLE_MAX`, `StewardHooks`, `buildStewardDigestLine`, `isStewardToolName`, `prerouteText`, `stewardActConfirmSpec`, `stewardSanitizeText`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardTrimSayAtSentence`, `waitReasonFor` |
| `13o-steward-runner-prompt.js` | `06j-scheduler-core.js` | backward | `normalizeSchedulerTask` |
| `13o-steward-runner-prompt.js` | `08-agent-runs.js` | backward | `parseStructuredAgentOutput` |
| `13o-steward-runner-prompt.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `overlayMissionCard` |
| `13o-steward-runner-prompt.js` | `13j-steward-tool-base.js` | backward | `stewardMemoryScopeLabel`, `stewardQuickThread`, `stewardRawKind`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode` |
| `13o-steward-runner-prompt.js` | `13k-steward-threads.js` | backward | `stewardCanonWorkspacePath`, `stewardFoldWorkspacePath`, `stewardKnownWorkspaces`, `stewardSeatedByUser` |
| `13o-steward-runner-prompt.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTIONS_MAX`, `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_ACT_CONFIRM_LABEL_MAX`, `STEWARD_ACT_CONFIRM_VALUE_CHARS`, `STEWARD_ACT_LABEL_MAX`, `STEWARD_DECIDE_LABELS`, `STEWARD_MEMORY_BLOCK_CHARS`, `STEWARD_MEMORY_VETOED_BLOCK_CHARS`, `STEWARD_MEMORY_VETOED_MAX`, `STEWARD_RUN_ACTION_LABELS`, `STEWARD_SAY_CEILING`, `STEWARD_TOOL_LABELS`, `STEWARD_WHY_MAX`, `stewardRunnerRuntime` |
| `13o-steward-runner-prompt.js` | `13n-steward-arbiter.js` | backward | `stewardArbiterWait` |
| `13p-steward-runner-actions.js` | `00-boot.js` | backward | `forEachUsageRow`, `text`, `usageDayKey`, `usageDayKeyMemo`, `usageRangeLowerMs` |
| `13p-steward-runner-actions.js` | `01-config.js` | backward | `configValueEquals`, `safeSessionId` |
| `13p-steward-runner-actions.js` | `02-session-store.js` | backward | `SESSION_LOAD_OMIT_PROVIDER`, `detectDanglingTurn`, `loadSession`, `mutateSession`, `readInterventions`, `sessionDisplayTitle` |
| `13p-steward-runner-actions.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent` |
| `13p-steward-runner-actions.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13p-steward-runner-actions.js` | `06i-steward-core.js` | backward | `STEWARD_ANSWER_BASIS`, `STEWARD_EXEMPT_CATEGORY_LABELS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardActConfirmSpec`, `stewardAsksYouForThread`, `stewardHumanizeIds`, `stewardMayAct`, `stewardPermissionLabel`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStoppedRefusal`, `stewardStoppedTarget` |
| `13p-steward-runner-actions.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardFail`, `stewardLastAssistantText`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnTaintedBy` |
| `13p-steward-runner-actions.js` | `13k-steward-threads.js` | backward | `stewardSeatedByUser` |
| `13p-steward-runner-actions.js` | `13l-steward-ops.js` | backward | `stewardReadRunSnapshot`, `stewardRunResumeTier` |
| `13p-steward-runner-actions.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_ACT_LABEL_MAX`, `STEWARD_CONTINUE_FRESH_MS`, `STEWARD_CONTINUE_NOPLAN_MAX`, `STEWARD_CONTINUE_PROMPT`, `STEWARD_INBOX_DELIVERABLE_CHARS`, `STEWARD_INBOX_EVENTS_PER_TURN`, `STEWARD_INBOX_EVENT_CHARS`, `STEWARD_INBOX_MESSAGE_CHARS`, `STEWARD_NO_PROGRESS_MAX`, `STEWARD_SELF_SERVE_ATTEMPT_MAX`, `STEWARD_SELF_SERVE_PER_TURN_MAX`, `STEWARD_SELF_SERVE_RETRY_WINDOW_MS`, `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS`, `stewardFailureExplain`, `stewardRunnerRuntime` |
| `13p-steward-runner-actions.js` | `13o-steward-runner-prompt.js` | backward | `stewardActConfirmLines`, `stewardActLabel`, `stewardNormalizeAct` |
| `13q-steward-runner-turn.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `fsp`, `nowIso`, `path` |
| `13q-steward-runner-turn.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `13q-steward-runner-turn.js` | `02-session-store.js` | backward | `loadSession`, `mutateSession` |
| `13q-steward-runner-turn.js` | `02e-session-engine-route.js` | backward | `normalizeSessionEngineRoute` |
| `13q-steward-runner-turn.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent`, `normalizeQuestionAnswer`, `pendingPermissions`, `pendingQuestions`, `promptDeadlineIsReal`, `turnSettlers` |
| `13q-steward-runner-turn.js` | `06i-steward-core.js` | backward | `STEWARD_DIGEST_LIMITS`, `STEWARD_EVENT_KINDS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardOpenAiFallback`, `stewardPendingOneLine`, `stewardSanitizeText`, `stewardThreadEngineRoute`, `waitReasonFor` |
| `13q-steward-runner-turn.js` | `06j-scheduler-core.js` | backward | `SchedulerHooks` |
| `13q-steward-runner-turn.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13q-steward-runner-turn.js` | `13b-api-domain-routes.js` | backward | `steerSessionCore` |
| `13q-steward-runner-turn.js` | `13d-core-domain-routes.js` | backward | `decideIntervention` |
| `13q-steward-runner-turn.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13q-steward-runner-turn.js` | `13i-steward-inbox.js` | backward | `stewardDir`, `stewardInboxRead` |
| `13q-steward-runner-turn.js` | `13j-steward-tool-base.js` | backward | `_stewardReadBudget`, `stewardFail`, `stewardReadSessionHead` |
| `13q-steward-runner-turn.js` | `13k-steward-threads.js` | backward | `stewardMediatedPermissionWaitMs` |
| `13q-steward-runner-turn.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_DEBOUNCE_MS`, `STEWARD_DIGEST_KIND_TEXT`, `STEWARD_INBOX_EVENTS_PER_TURN`, `STEWARD_PENDING_LIST_MAX`, `STEWARD_PREEMPT_WAIT_MS`, `STEWARD_USER_QUEUE_WAIT_MS`, `STEWARD_VISITS_DIR`, `STEWARD_VISITS_KEEP`, `STEWARD_VISIT_DIGEST_MAX`, `STEWARD_VISIT_SCHEMA`, `ensureStewardSession`, `stewardAbortInflight`, `stewardRunnerRuntime` |
| `13q-steward-runner-turn.js` | `13n-steward-arbiter.js` | backward | `stewardArbiterWait` |
| `13q-steward-runner-turn.js` | `13o-steward-runner-prompt.js` | backward | `stewardParseReply`, `stewardThreadDigestRows` |
| `13q-steward-runner-turn.js` | `13p-steward-runner-actions.js` | backward | `stewardCircuitCheck`, `stewardDowngradeActions`, `stewardExecuteActions`, `stewardHumanizeSay`, `stewardInboxMessage`, `stewardLastAssistantContent`, `stewardLastAssistantFinalSegment`, `stewardNormalizeRouteHint`, `stewardSelfServeInbox`, `stewardStampReply`, `stewardTriggerStamp` |
| `13r-event-stream.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `URL`, `apiFailure`, `nowIso` |
| `13r-event-stream.js` | `01-config.js` | backward | `safeSessionId`, `send` |
| `13r-event-stream.js` | `02-session-store.js` | backward | `readMissionSessionHead`, `sessionDisplayTitle`, `sessionMissionId` |
| `13r-event-stream.js` | `04-permission-runtime.js` | backward | `activeChildren`, `subscribeActiveChildEvents` |
| `13r-event-stream.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `stewardThreadStateFromHead`, `stewardWatchedThread`, `threadOriginOf` |
| `13r-event-stream.js` | `13d-core-domain-routes.js` | backward | `missionPendingCounts` |
| `13s-scheduler.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `URL`, `apiFailure`, `fs`, `fsp`, `json`, `makeId`, `nowIso`, `path`, `paths`, `safeDecodeURIComponent`, `text` |
| `13s-scheduler.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `readJsonBody`, `send` |
| `13s-scheduler.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `13s-scheduler.js` | `02-session-store.js` | backward | `createSession`, `loadSession`, `repairMissionChangeTornTail`, `saveSession`, `updateSessionMeta` |
| `13s-scheduler.js` | `04-permission-runtime.js` | backward | `logEvent`, `stopSession` |
| `13s-scheduler.js` | `06i-steward-core.js` | backward | `stewardPermissionRank` |
| `13s-scheduler.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_LIMITS`, `SCHEDULER_PHASES`, `SchedulerHooks`, `describeSchedule`, `missedOccurrence`, `nextFireAt`, `normalizeSchedulerTask`, `occurrenceKey` |
| `13s-scheduler.js` | `07-autonomy.js` | backward | `schedulerAskWaitSessions` |
| `13s-scheduler.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13t-steward-schedule.js` | `00-boot.js` | backward | `fsp`, `makeId`, `nowIso`, `text` |
| `13t-steward-schedule.js` | `01-config.js` | backward | `readConfig` |
| `13t-steward-schedule.js` | `06i-steward-core.js` | backward | `StewardHooks`, `stewardSanitizeText` |
| `13t-steward-schedule.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_LIMITS`, `SchedulerHooks`, `describeSchedule`, `normalizeSchedulerTask` |
| `13t-steward-schedule.js` | `13g-steward.js` | backward | `stewardToolHandler` |
| `13t-steward-schedule.js` | `13i-steward-inbox.js` | backward | `stewardAppendInboxRows`, `stewardClipSummary`, `stewardInboxRowDedupeKeys`, `stewardIsoAt`, `stewardLoadState`, `stewardRuntime` |
| `13t-steward-schedule.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardFail` |
| `13t-steward-schedule.js` | `13k-steward-threads.js` | backward | `stewardCanonWorkspacePath`, `stewardDeriveThreadCwd`, `stewardUnattendedByModel`, `stewardValidateCwd` |
| `13t-steward-schedule.js` | `13q-steward-runner-turn.js` | backward | `stewardEnsureOpenAiRoute` |
| `13t-steward-schedule.js` | `13s-scheduler.js` | backward | `schedulerClockNow`, `schedulerEmitChanged`, `schedulerEnabled`, `schedulerEnsureTimer`, `schedulerLoad`, `schedulerReadFireRows`, `schedulerRunNow`, `schedulerRuntime`, `schedulerSaveTasks` |
| `13u-migration-center.js` | `00-boot.js` | backward | `MigrationHooks`, `SKILL_ID_RE`, `VERSION`, `agentCliHomes`, `crypto`, `externalRoot`, `findRuyiPackageRootFor`, `fs`, `fsp`, `installRegistryPath`, `nowIso`, `os`, `path`, `paths`, `readInstallRegistry`, `ruyiPackageInfo`, `safeJsonParse`, `samePathKey`, `text`, `tildePath` |
| `13u-migration-center.js` | `01-config.js` | backward | `agentMcpImportSources`, `atomicWriteJson`, `classifyAgentMcpCandidate`, `generateMcpConfig`, `kimiMcpManagedIds`, `mutateConfig`, `readConfig` |
| `13u-migration-center.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `13u-migration-center.js` | `04-permission-runtime.js` | backward | `_parseTomlMcpServers`, `logEvent`, `parseMcpConfigFile`, `safeUrlForDisplay` |
| `13u-migration-center.js` | `05-claude-engine.js` | backward | `sanitizeExternalMcpServer` |
| `13u-migration-center.js` | `06d-memory-domain.js` | backward | `syncAgentInstructionImports` |
| `14-main.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `EventStreamHooks`, `RUYI_EVENTS`, `apiSessionIdInvalid`, `apiSessionNotFound`, `appendUsageLedger`, `buildUsageSummary`, `createNdjsonLineFeeder`, `flushUsageLedgerSync`, `forEachUsageRow`, `hashArgs`, `neutralizeFenceTag`, `readUsageRows`, `runKeyedChain`, `spawnDetachedChecked`, `usageLedgerCacheStats` |
| `14-main.js` | `01-config.js` | backward | `CONFIG_MIGRATIONS`, `DurableJsonStore`, `autoImportClaudeCodeMcp`, `buildClaudeCliEnv`, `decodeClaudeCliText`, `defaultConfig`, `desktopMcpFromInstalledRoot`, `desktopPythonCandidates`, `detectDesktopMcp`, `detectDesktopMcpAsync`, `ensureDesktopMcpWarm`, `generateMcpConfig`, `generateSessionMcpConfig`, `mutateConfig`, `normalizeConfig`, `pickPython`, `pickPythonAsync`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `readConfig`, `readFileTail`, `resolveClaudeLauncher`, `syncAgentCliMcpManifests`, `syncMcpServersToKimi` |
| `14-main.js` | `01b-route-auth.js` | backward | `ROUTE_AUTH` |
| `14-main.js` | `01c-runtime-flags.js` | backward | `appendOnlyToolSchemasEnabled`, `budgetGuardDecision`, `budgetGuardEnabled`, `budgetGuardTurnTokens`, `budgetGuardWarnRatio`, `estimateBucketsEnabled`, `evaporateBudgetBoundaryEnabled`, `execResultCacheEnabled`, `execResultCacheMaxEntries`, `historyReadDedupEnabled`, `reseedReattachFilesEnabled`, `reseedTailUnitsEnabled`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `summaryEntityCheckEnabled`, `summaryFactTableCap`, `summaryFactTableEnabled`, `summaryPromptI18nEnabled`, `summaryRefineEnabled`, `summarySingleShotEnabled`, `toolByteBudgetShadowBytes`, `toolTimeBudgetEnabled`, `toolTimeBudgetHardMs`, `toolTimeBudgetShadowEnabled`, `toolTimeBudgetWarnMs`, `volatileTailLayoutEnabled` |
| `14-main.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn`, `cmdLineBudgetFor`, `quoteWinArg`, `spawnCmdLineLength` |
| `14-main.js` | `01e-permission-modes.js` | backward | `BUILTIN_AGENT_ROLES`, `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `normalizeAgentRole`, `resolvePermissionMode` |
| `14-main.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES`, `normalizeAgentCliType` |
| `14-main.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `MISSION_CONTAINER_MAX_FILES`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `collectBridgedWriteTarget`, `collectBridgedWriteTargets`, `compactInterventionJournal`, `createMissionContainer`, `createSession`, `deleteSession`, `detectDanglingTurn`, `flushSessionIndex`, `flushSessionIndexSync`, `invalidateSessionIndex`, `isUntitledSessionTitle`, `journalGc`, `journalGcProbe`, `journalRecord`, `kindForPath`, `listMissionContainers`, `listSessions`, `loadSession`, `missionAttachThread`, `missionMergeInto`, `missionSplitThreads`, `mutateSession`, `normalizeSession`, `patchMissionContainer`, `readInterventions`, `readMissionContainer`, `readSessionHeadResilient`, `readSessionNotes`, `reconcileWorkspaceTurnBaseline`, `registerIntervention`, `repairMissionChangeTornTail`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `rewindSession`, `saveSession`, `sessionBodyPaths`, `sessionBodyPerfStats`, `sessionDisplayTitle`, `sessionMessagesDelta`, `sessionMeta`, `sessionNotesPath`, `sessionObjectIsStale`, `setSessionIndexRebuildScanHookForTest`, `transitionInterventionState`, `updateSessionMeta`, `writeSessionNotes` |
| `14-main.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `14-main.js` | `02d-session-overrides.js` | backward | `liveSessionPermissionMode` |
| `14-main.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute`, `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `14-main.js` | `02f-turn-effect-kinds.js` | backward | `IRREVERSIBLE_NATIVE_KIND`, `TURN_SUMMARY_COMMAND_TOOLS`, `TURN_SUMMARY_FILE_TOOLS`, `unwrapToolInvokeCall` |
| `14-main.js` | `03-bridge-guard.js` | backward | `AUTOEXEC_DENYLIST`, `auditBridgedWriteCoverage`, `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `buildBrowserOpenSpawn`, `buildCodeEditorSpawn`, `buildOpenSpawn`, `buildRevealSpawn`, `classifyCodeEditorExecutable`, `cwdWarning`, `executableFromAssociationCommand`, `guardFileToolPath`, `guardWorkspacePath`, `pathWithinAnyRoot`, `pathWithinRoot`, `providerIsLocal`, `resolveWorkspace` |
| `14-main.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `McpHttpClient`, `McpStdioClient`, `activeChildren`, `bridgedServerUnavailableMessage`, `buildMcpConnectorInventory`, `classifyMcpError`, `clearPendingPermissions`, `collectBridgedTools`, `configureMcpFromTool`, `hasPendingPermissionForSession`, `invalidateMcpDropInCache`, `killAllMcpClients`, `killChildTree`, `killOwnProcessTree`, `makeAttachmentRecord`, `mcpChildExitResult`, `nativeClaudeAgentResultInfo`, `normalizeMcpToolResult`, `parseAgentCliEvent`, `parseClaudeTaskNotification`, `parseMcpConfigFile`, `permissionWaitMs`, `probeMcpConnector`, `redact`, `resolveBridge`, `resolveExternalMcpServers`, `safeMcpInventory`, `safeUrlForDisplay`, `scanMcpSources` |
| `14-main.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `14-main.js` | `04h-provider-http.js` | backward | `abortableDelay`, `providerApiBase`, `providerBaseWithV1`, `providerCallIsTransient`, `providerCompletionUrl`, `providerRequestHeaders`, `providerResponsesBase`, `withTransientRetry` |
| `14-main.js` | `04i-provider-wire.js` | backward | `PROVIDER_WIRE_PROTOCOLS`, `applyProviderReasoningEffort`, `buildResponsesInputItems`, `normalizeProviderApiStyle`, `providerReasoningEffort`, `providerWireProtocol`, `responsesHistoryWithCompleteToolPairs` |
| `14-main.js` | `05-claude-engine.js` | backward | `AGENT_CLI_ADAPTERS`, `agentCliAdapter`, `asrFixMessages`, `asrFixSanity`, `maskSecrets`, `maskedSecretConflicts`, `providerFixCompletion`, `providerLaunchVectorKey`, `resolveAsrFixProvider`, `sanitizeExternalMcpServer`, `unmaskProviders`, `unmaskSecrets` |
| `14-main.js` | `05b-kimi-bridge.js` | backward | `consumeKimiAcpApproval`, `isKimiAcpPlanFilePath`, `kimiAcpFreshActualForOperation`, `kimiAcpInferConcreteToolInput`, `kimiAcpModeOptionFromActivated`, `kimiAcpNativeBashWrapperCandidate`, `kimiAcpNativeBashWrapperTexts`, `kimiAcpNativeShellQuote`, `kimiAcpPermissionToolCall`, `kimiAcpSessionRestoreMethods`, `kimiAcpSuccessfulEnterPlanMode`, `kimiAcpUnknownSessionError`, `kimiSessionStatus`, `parseKimiWireAgentEvents`, `parseKimiWireCompaction`, `prepareKimiAcpSpawn`, `resolveKimiAcpPlanFilePath`, `runKimiCompact`, `watchKimiWire` |
| `14-main.js` | `06-provider-engine.js` | backward | `CAP_UNKNOWN_TTL_MS`, `ERROR_CLASSES`, `TOOL_ITERATION_BUDGETS`, `TOOL_REQUIRES`, `appendResponseLanguagePolicy`, `appendTurnPolicies`, `buildAgentTeamHint`, `buildBrowserAutomationHint`, `buildClaudeNativeAgentPolicy`, `buildEngineEnvBrief`, `buildMetricsPayload`, `buildPlaybookIndexSection`, `buildPromptTaskContext`, `buildProviderSystemPrompt`, `buildRuntimeIdentityFacts`, `buildSoftwareEngineeringPolicy`, `buildStableSystemPrompt`, `buildToolCustomizationHint`, `buildVolatileParts`, `clampAppendWithSkills`, `claudeProjectDirKey`, `claudeProjectsRoot`, `collectStorageStats`, `desktopAuditEntriesFromResult`, `evalPlaybookAvailability`, `fenceSafeSlice`, `getCapabilities`, `invalidateCapabilityCache`, `matchServiceEntry`, `maybeRecordStorageTrend`, `maybeWriteThreadBrief`, `networkAnchors`, `normalizeMetricsPath`, `normalizePlaybook`, `normalizeStoragePolicy`, `parsePlaybookDraft`, `parseThreadBrief`, `peekCapabilities`, `probeAny`, `providerRawCompletion`, `readStorageTrend`, `recordEngineTranscript`, `recordRequestMetric`, `resolveEngineEnvBrief`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget`, `shrinkFencedSection`, `softwareEngineeringTaskProfile`, `storageSweep`, `toolRequirementsMet` |
| `14-main.js` | `06b-prompt-registry.js` | backward | `PROMPT_PACK_VERSION`, `getPromptPack` |
| `14-main.js` | `06c-agent-loop-hooks.js` | backward | `AgentLoopHooks` |
| `14-main.js` | `06d-memory-domain.js` | backward | `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `buildCoreMemoryPromptSection`, `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `confirmMemoryRelation`, `deleteMemoryRelation`, `extractMemoryRelationProposals`, `legacyAccMemoryMigrationComplete`, `listMemoryRelations`, `listWorkbenchMemories`, `loadMemoryRegistry`, `memoryProposalIsDuplicate`, `memoryProposalPrefilter`, `memoryProposalSimilarity`, `migrateLegacyAccMemory`, `parseMemoryProposalDecision`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `rankRelevantMemories`, `readWorkbenchMemory`, `resolveCoreMemoryState`, `resolveMemoryPreflight`, `saveMemory` |
| `14-main.js` | `06e-mission-domain.js` | backward | `runMissionDriver` |
| `14-main.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `agentResourcesConflict`, `bridgedDesktopLeaseMode`, `inferToolResources`, `normalizeAgentResource`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources`, `resourceBlockers` |
| `14-main.js` | `06i-steward-core.js` | backward | `STEWARD_BRIEF_LIMITS`, `STEWARD_CONFIG_TIERS`, `STEWARD_DELIVERABLE_CHARS`, `STEWARD_DIGEST_LIMITS`, `STEWARD_EVENT_KINDS`, `STEWARD_EXEMPT_CATEGORY_LABELS`, `STEWARD_EXEMPT_DELEGATIONS_PER_HOUR`, `STEWARD_EXEMPT_DELEGATION_GATES`, `STEWARD_EXEMPT_DELEGATION_TEXT_MAX`, `STEWARD_EXEMPT_EXCERPT_CHARS`, `STEWARD_EXEMPT_NAME_CARVEOUTS`, `STEWARD_EXEMPT_TOOL_PATTERNS`, `STEWARD_MEMORY_KINDS`, `STEWARD_PERMISSION_RANK`, `STEWARD_PREROUTE_DEFAULTS`, `STEWARD_QUICK_ANSWER_CHARS`, `STEWARD_SESSION_ID`, `STEWARD_SESSION_TITLE`, `STEWARD_WAIT_LABELS`, `STEWARD_WAIT_REASONS`, `StewardHooks`, `aggregateMissionState`, `buildStewardBrief`, `buildStewardDigestLine`, `deriveStewardThreadState`, `isStewardToolName`, `prerouteText`, `stewardActConfirmSpec`, `stewardAsksYou`, `stewardAssemblePlaybookPrompt`, `stewardClipSay`, `stewardConfigTierFor`, `stewardExemptDelegationVerdict`, `stewardExemptExcerpt`, `stewardExemptHits`, `stewardExemptReason`, `stewardExemptRiskNote`, `stewardExemptScanInput`, `stewardHumanizeIds`, `stewardMayAct`, `stewardMayTightenTo`, `stewardOpenAiFallback`, `stewardPermissionRank`, `stewardPlaybookMissingInputs`, `stewardStoppedTarget`, `stewardTaintToolCall`, `stewardTaintToolName`, `stewardTermJaccard`, `stewardThreadEngineRoute`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardThreadStateRank`, `stewardToolPermanentlyExempt`, `stewardTrimSayAtSentence`, `stewardTurnTaint`, `threadVisible`, `waitReasonFor` |
| `14-main.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_DEFAULT_POLICY`, `SCHEDULER_DESCRIBE_KEYS`, `SCHEDULER_DOW_KEYS`, `SCHEDULER_FIRE_MODES`, `SCHEDULER_FORBIDDEN_PAYLOAD_KEYS`, `SCHEDULER_LIMITS`, `SCHEDULER_OUTCOMES`, `SCHEDULER_THREAD_TIERS`, `describeSchedule`, `missedOccurrence`, `nextFireAt`, `normalizeSchedulerTask`, `occurrenceKey`, `parseCronExpr` |
| `14-main.js` | `07-autonomy.js` | backward | `NATIVE_TOOL_PACKS`, `NATIVE_TOOL_TIER`, `adaptiveMetaToolSchemas`, `applyAgentWorktree`, `bridgedToolTier`, `buildClaudeAgentDefinitions`, `buildOpenAiTools`, `buildToolCatalog`, `classifyClaudeSubagentFailure`, `classifyRuntimeToolFailure`, `classifyToolPacks`, `compareToolRetrievalShadow`, `createAgentWorktree`, `createToolLoadingState`, `fetchOpenAiModels`, `finalizeAgentWorktree`, `getAgentRoleLibrary`, `nativeToolDisabledByPolicy`, `nativeToolGate`, `openAiStreamOnce`, `readClaudeProjectAgentRoles`, `requestNativePermission`, `saveProjectAgentRoles`, `schedulerAskWaitSessions`, `searchToolCatalog`, `toolPackForName` |
| `14-main.js` | `08-agent-runs.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `QUALITY_GATE_OUTPUT_SCHEMA`, `agentRunDigestStats`, `aggregateAgentVote`, `aggregateCoverage`, `appendAgentRunEvent`, `autoResumeInterruptedRuns`, `buildAgentRunEnvelope`, `buildNodeEvidenceCatalog`, `cutAtSentence`, `dedupeAgentFindings`, `deleteAgentWorkflow`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `flushAgentRunEvents`, `formatNodeEvidencePrompt`, `getAgentWorkflows`, `indexNodeEvidence`, `listAgentRunDigests`, `mapPool`, `markInterruptedAgentRuns`, `normalizeAgentGate`, `normalizeAgentWorkflow`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `parseStructuredAgentOutput`, `propagateAssignments`, `purgeNodeEvidence`, `readAgentRunEvents`, `repairJson`, `resolveAgentTeamRoute`, `runSubAgentCore`, `runWorkspaceHash`, `saveAgentRun`, `saveAgentWorkflow`, `singleAgentShorthandNode`, `syncRunEventSeq`, `validateAgentJsonSchema`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `14-main.js` | `09-workflow.js` | backward | `legacySpawnToOrchestrateArgs`, `planDiscoveryToolBatchAllowed`, `waitForAgentRunResults` |
| `14-main.js` | `09d-token-estimation.js` | backward | `CONTEXT_WINDOW_FALLBACK`, `classifyTextForEstimate`, `estimateHistoryTokens`, `estimateTextTokens`, `fmtTokensServer`, `setEstimateBucketsV1` |
| `14-main.js` | `10-context-governance.js` | backward | `COMPACT_MARKER_MIN_SAVED_TOKENS`, `COMPACT_RESEED_TAIL_MAX_TOKENS`, `CompactionPlan`, `agentConversationContextMeta`, `agentNodeContextWindow`, `appendPromptToLastUserMessage`, `buildObservationRecallPrompt`, `buildSessionNotesInjectPrompt`, `buildSummaryFactTableMessages`, `buildSummaryRefineMessages`, `calibratedEstimate`, `checkSummaryEntities`, `chunkHistoryByBudget`, `configuredConversationWindow`, `contextWindowFromTable`, `contextWindowOverrideKey`, `dedupeRepeatedReads`, `estimateFactor`, `evaporateBudgetBoundary`, `evaporateHistory`, `extractContextLength`, `extractSessionNotes`, `extractSummaryEntities`, `fileReadDedupKey`, `fitHistoryForSummary`, `historyStartsWithCompactionSummary`, `historyUnitStarts`, `isContextOverflowError`, `learnedWindowCap`, `mapSummaryWithLimit`, `maybeWriteSessionNotes`, `measureObservationReductionShadow`, `mergeSessionNotes`, `noteEstimateSample`, `noteWindowOvershoot`, `openCompactMarker`, `parseSessionNotesMarkdown`, `providerContextWindow`, `providerConversationContextWindow`, `providerSummaryCall`, `recentFileReads`, `recentTurnsBoundary`, `reduceObservationContent`, `rehydrateObservation`, `renderSessionNotesMarkdown`, `resolveCompactionProvider`, `resolveContextWindow`, `resolveSummaryCallPolicy`, `runSessionTurn`, `summaryMaxConcurrent`, `summaryPromptWithGuidance`, `summarySingleShotCap`, `summarySingleShotReserveTokens`, `upsertCompactMarker`, `validateStructuredSummary`, `writeHistorySnapshot` |
| `14-main.js` | `11-native-tools.js` | backward | `peekRgProbe`, `probeRgAsync` |
| `14-main.js` | `13-http-router.js` | backward | `doctor`, `installIntegration`, `parseArgs`, `startMcp`, `startServer` |
| `14-main.js` | `13d-core-domain-routes.js` | backward | `buildMissionAggregateRows`, `missionAggregateStats` |
| `14-main.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `pretenderIndexTestHooks`, `warmPretenderProjectionIndex` |
| `14-main.js` | `13i-steward-inbox.js` | backward | `STEWARD_SOURCE_EVENT_MAP`, `startStewardInbox`, `stewardEventDedupeKey`, `stewardInboxRowDedupeKeys`, `stewardMergeInboxEvents`, `stewardNormalizeBudgetExhausted`, `stewardNormalizeMissionChange`, `stewardNormalizePendingIntervention`, `stewardNormalizeRunEvent`, `stopStewardInbox` |
| `14-main.js` | `13j-steward-tool-base.js` | backward | `stewardTurnTaintedBy` |
| `14-main.js` | `13k-steward-threads.js` | backward | `stewardMediatedPermissionWaitMs` |
| `14-main.js` | `13m-steward-runner-base.js` | backward | `STEWARD_INBOX_MESSAGE_CHARS`, `STEWARD_SAY_CEILING`, `STEWARD_SAY_TARGET`, `ensureStewardSession`, `stewardFailureExplain`, `stewardResolveRoute` |
| `14-main.js` | `13o-steward-runner-prompt.js` | backward | `buildStewardSystemPrompt`, `stewardActLabel`, `stewardContextBudget`, `stewardNormalizeAct`, `stewardParseReply`, `stewardPreroute` |
| `14-main.js` | `13p-steward-runner-actions.js` | backward | `stewardCircuitCheck`, `stewardDowngradeActions`, `stewardInboxMessage`, `stewardSelfServeAllows` |
| `14-main.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn`, `stewardMergeDelegationReceipts`, `stewardVisit`, `stewardVisitDigest` |
| `14-main.js` | `13s-scheduler.js` | backward | `handleSchedulerApiRoutes`, `schedulerPermissionModeFor`, `schedulerRuntimeSnapshot`, `startScheduler`, `stopScheduler` |

## 强连通分量

1. `00-boot.js` ↔ `01-config.js` ↔ `02-session-store.js` ↔ `03-bridge-guard.js` ↔ `04-desktop-shell.js` ↔ `04-permission-runtime.js` ↔ `04-visual-pipeline.js` ↔ `05-claude-engine.js` ↔ `05b-kimi-bridge.js` ↔ `05c-kimi-search-policy.js` ↔ `05d-kimi-prompt-parts.js` ↔ `06-provider-engine.js` ↔ `06b-prompt-registry.js` ↔ `06c-agent-loop-hooks.js` ↔ `06d-memory-domain.js` ↔ `06e-mission-domain.js` ↔ `06f-autonomy-grants.js` ↔ `06g-resource-leases.js` ↔ `07-autonomy.js` ↔ `08-agent-runs.js` ↔ `09-workflow.js` ↔ `09b-replan-ledger.js` ↔ `09d-token-estimation.js` ↔ `10-context-governance.js` ↔ `11-native-tools.js` ↔ `13-http-router.js` ↔ `13b-api-domain-routes.js` ↔ `13c-overlay-routes.js` ↔ `13d-core-domain-routes.js` ↔ `13e-pretender-index.js` ↔ `13f-native-tool-schemas.js` ↔ `13s-scheduler.js`

## 维护规则

- 源码新增或删除跨模块引用时，契约与本图必须同步更新；`--check`/CI 会拒绝漂移。
- 重复顶层导出名始终拒绝。循环边和前向边只能减少；若确需增加，必须显式修改 `module-dependency-policy.json` 并说明理由。
- 隔离批次优先把内部符号收进命名空间，只暴露真实公共面；每批保持拼接顺序和运行语义。
