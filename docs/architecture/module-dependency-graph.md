# 后端模块依赖图（第 103b／104 波）

> 本文件由 `node dev-harness/module-dependency-graph.js --write` 从 `app/src/manifest.json` 与源码生成。请勿手改。
> `provides/requires` 是构建期拼接作用域的显式契约；运行时仍执行单文件 `app/server.js`。

## 摘要

| 模块 | 顶层符号 | 跨模块符号引用 | 模块边 | 前向边 | 重复导出 | 强连通分量 |
|---:|---:|---:|---:|---:|---:|---:|
| 104 | 4093 | 3760 | 723 | 67 | 0 | 1 |

“前向边”表示较早拼接的模块引用较晚模块，依赖函数提升或延迟执行；它不是自动判错，但已由债务上限锁住，禁止无评审增加。

## 模块清单

| # | 模块 | 层 | provides | requires | 直接依赖 |
|---:|---|---|---:|---:|---:|
| 0 | `00-boot.js` | bootstrap | 147 | 7 | 4 |
| 1 | `00b-ruyi-names.js` | bootstrap | 5 | 0 | 0 |
| 2 | `01b-route-auth.js` | foundation | 1 | 0 | 0 |
| 3 | `01c-runtime-flags.js` | foundation | 37 | 0 | 0 |
| 4 | `01d-win-cmdline.js` | foundation | 13 | 0 | 0 |
| 5 | `01e-permission-modes.js` | foundation | 18 | 1 | 1 |
| 6 | `01f-agent-cli-types.js` | foundation | 4 | 1 | 1 |
| 7 | `01g-server-ownership.js` | foundation | 1 | 0 | 0 |
| 8 | `01i-privacy-rules.js` | foundation | 1 | 0 | 0 |
| 9 | `01h-privacy-core.js` | foundation | 1 | 1 | 1 |
| 10 | `01m-privacy-regex.js` | foundation | 1 | 1 | 1 |
| 11 | `01j-local-crypto.js` | foundation | 1 | 0 | 0 |
| 12 | `01-config.js` | foundation | 202 | 62 | 13 |
| 13 | `01k-credential-vault.js` | foundation | 1 | 8 | 4 |
| 14 | `01l-credential-recovery.js` | foundation | 2 | 13 | 3 |
| 15 | `01n-work-data-crypto.js` | foundation | 1 | 1 | 1 |
| 16 | `01o-work-data-keys.js` | foundation | 1 | 0 | 0 |
| 17 | `01r-work-data-chunks.js` | foundation | 1 | 1 | 1 |
| 18 | `01p-work-data-store.js` | foundation | 1 | 2 | 2 |
| 19 | `01q-work-data-records.js` | foundation | 1 | 2 | 2 |
| 20 | `01s-work-data-journals.js` | foundation | 1 | 3 | 3 |
| 21 | `01t-work-data-recovery.js` | foundation | 1 | 2 | 1 |
| 22 | `01u-work-data-transition.js` | foundation | 1 | 0 | 0 |
| 23 | `01v-work-data-manifest.js` | foundation | 1 | 0 | 0 |
| 24 | `01w-work-data-native-publish.js` | foundation | 1 | 1 | 1 |
| 25 | `01x-work-data-migration-codecs.js` | foundation | 1 | 3 | 3 |
| 26 | `01z-work-data-root-authority.js` | foundation | 1 | 8 | 3 |
| 27 | `02c-turn-segments.js` | foundation | 1 | 0 | 0 |
| 28 | `02d-session-overrides.js` | foundation | 11 | 1 | 1 |
| 29 | `02e-session-engine-route.js` | foundation | 4 | 1 | 1 |
| 30 | `02f-turn-effect-kinds.js` | foundation | 19 | 0 | 0 |
| 31 | `02-session-store.js` | foundation | 388 | 81 | 21 |
| 32 | `03-bridge-guard.js` | foundation | 122 | 30 | 7 |
| 33 | `03a-privacy-gateway.js` | foundation | 1 | 2 | 2 |
| 34 | `03b-privacy-local-drive.js` | foundation | 1 | 0 | 0 |
| 35 | `04-visual-pipeline.js` | foundation | 1 | 0 | 0 |
| 36 | `04-permission-runtime.js` | foundation | 190 | 51 | 12 |
| 37 | `04-desktop-shell.js` | foundation | 1 | 11 | 3 |
| 38 | `04f-toolbox-services.js` | foundation | 26 | 14 | 3 |
| 39 | `04h-provider-http.js` | foundation | 16 | 1 | 1 |
| 40 | `04i-provider-anthropic.js` | foundation | 59 | 1 | 1 |
| 41 | `04i-provider-wire.js` | foundation | 37 | 17 | 2 |
| 42 | `04j-hanzi-pinyin.js` | foundation | 1 | 0 | 0 |
| 43 | `04j-voice-lexicon.js` | foundation | 1 | 0 | 0 |
| 44 | `04j-voice-learn.js` | foundation | 1 | 2 | 2 |
| 45 | `05-claude-engine.js` | engine | 78 | 146 | 26 |
| 46 | `05b-kimi-bridge.js` | engine | 128 | 78 | 13 |
| 47 | `05c-kimi-search-policy.js` | engine | 42 | 12 | 2 |
| 48 | `05d-kimi-prompt-parts.js` | engine | 15 | 4 | 2 |
| 49 | `06-provider-engine.js` | engine | 145 | 68 | 18 |
| 50 | `06b-prompt-registry.js` | engine | 10 | 1 | 1 |
| 51 | `06c-agent-loop-hooks.js` | engine | 1 | 3 | 2 |
| 52 | `06h-retrieval-index.js` | engine | 15 | 0 | 0 |
| 53 | `06i-steward-core.js` | engine | 167 | 1 | 1 |
| 54 | `06d-memory-domain.js` | engine | 187 | 41 | 11 |
| 55 | `06e-mission-domain.js` | engine | 3 | 14 | 5 |
| 56 | `06f-autonomy-grants.js` | engine | 25 | 12 | 5 |
| 57 | `06g-resource-leases.js` | engine | 21 | 5 | 3 |
| 58 | `06j-scheduler-core.js` | engine | 44 | 0 | 0 |
| 59 | `06k-config-patch.js` | engine | 1 | 21 | 8 |
| 60 | `07-autonomy.js` | orchestration | 156 | 87 | 21 |
| 61 | `08-agent-runs.js` | orchestration | 133 | 127 | 25 |
| 62 | `09b-replan-ledger.js` | orchestration | 8 | 4 | 1 |
| 63 | `09d-token-estimation.js` | orchestration | 25 | 2 | 2 |
| 64 | `09-workflow.js` | orchestration | 32 | 275 | 28 |
| 65 | `10-context-governance.js` | orchestration | 228 | 109 | 20 |
| 66 | `11-native-tools.js` | tools | 144 | 51 | 9 |
| 67 | `11b-file-text-io.js` | tools | 1 | 2 | 1 |
| 68 | `11c-file-visual-io.js` | tools | 1 | 2 | 1 |
| 69 | `11d-media-inspection.js` | tools | 1 | 0 | 0 |
| 70 | `12-tool-dispatch.js` | tools | 78 | 146 | 23 |
| 71 | `13f-native-tool-schemas.js` | transport | 2 | 1 | 1 |
| 72 | `13-http-router.js` | transport | 70 | 255 | 33 |
| 73 | `13b-api-domain-routes.js` | transport | 41 | 68 | 11 |
| 74 | `13c-overlay-routes.js` | transport | 11 | 13 | 3 |
| 75 | `13d-core-domain-routes.js` | transport | 69 | 137 | 18 |
| 76 | `13e-pretender-index.js` | transport | 61 | 43 | 9 |
| 77 | `13i-steward-inbox.js` | transport | 93 | 32 | 10 |
| 78 | `13j-steward-tool-base.js` | transport | 85 | 31 | 12 |
| 79 | `13aa-steward-delivery.js` | unclassified | 10 | 31 | 7 |
| 80 | `13k-steward-threads.js` | transport | 60 | 126 | 17 |
| 81 | `13l-steward-ops.js` | transport | 54 | 126 | 21 |
| 82 | `13g-steward.js` | transport | 20 | 76 | 12 |
| 83 | `13m-steward-runner-base.js` | transport | 44 | 16 | 7 |
| 84 | `13n-steward-arbiter.js` | transport | 42 | 21 | 6 |
| 85 | `13o-steward-runner-prompt.js` | transport | 22 | 67 | 17 |
| 86 | `13p-steward-runner-actions.js` | transport | 37 | 67 | 13 |
| 87 | `13q-steward-runner-turn.js` | transport | 48 | 88 | 21 |
| 88 | `13h-steward-runner.js` | transport | 7 | 51 | 13 |
| 89 | `13r-event-stream.js` | transport | 25 | 18 | 6 |
| 90 | `13s-scheduler.js` | transport | 68 | 39 | 11 |
| 91 | `13t-steward-schedule.js` | transport | 23 | 43 | 10 |
| 92 | `13u-migration-center.js` | transport | 98 | 36 | 7 |
| 93 | `13v-external-channel-protocols.js` | transport | 1 | 3 | 1 |
| 94 | `13x-external-channel-delivery.js` | transport | 1 | 2 | 1 |
| 95 | `13y-external-bot-credentials.js` | transport | 1 | 7 | 3 |
| 96 | `13z-external-bot-discovery.js` | transport | 1 | 0 | 0 |
| 97 | `13ab-privacy-api.js` | unclassified | 2 | 37 | 16 |
| 98 | `13w-external-bots.js` | transport | 69 | 26 | 10 |
| 99 | `13ac-mcp-consumer.js` | unclassified | 2 | 39 | 12 |
| 100 | `13ad-memory-cli-relay.js` | unclassified | 1 | 26 | 9 |
| 101 | `13ae-cli-business-services.js` | unclassified | 6 | 60 | 13 |
| 102 | `13af-internal-mcp-relay.js` | unclassified | 1 | 38 | 14 |
| 103 | `14-main.js` | entrypoint | 2 | 597 | 50 |

## 模块边

| 调用方 | 提供方 | 方向 | 符号 |
|---|---|---|---|
| `00-boot.js` | `01-config.js` | forward | `atomicWriteJson`, `readConfig` |
| `00-boot.js` | `02-session-store.js` | forward | `bumpMissionChangeSeq`, `overlayUnflushedSessionIndex`, `readSessionIndex` |
| `00-boot.js` | `05-claude-engine.js` | forward | `CLAUDE_ENDPOINT_PRESETS` |
| `00-boot.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `01-config.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `DEFAULT_PORT`, `InternalMcpHooks`, `MAX_BODY_BYTES`, `RUYI_EVENTS`, `SKILL_ID_RE`, `StringDecoder`, `URL`, `VERSION`, `WorkDataRootHooks`, `agentCliHomes`, `apiFailure`, `cp`, `crypto`, `dataRoot`, `ensureDirs`, `externalRoot`, `findRuyiPackageRootFor`, `fs`, `fsp`, `isPkg`, `normalizePricing`, `os`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `text` |
| `01-config.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_SERVER_ID`, `canonicalRuyiMcpServerId`, `isRuyiMcpServerId` |
| `01-config.js` | `01b-route-auth.js` | backward | `ROUTE_AUTH` |
| `01-config.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn`, `isBatchLauncher` |
| `01-config.js` | `01e-permission-modes.js` | backward | `CLAUDE_PERMISSION_MODE_MAP`, `PERMISSION_MODES`, `PERMISSION_MODE_ALIASES`, `agentRoleIsUntrusted`, `normalizeAgentRole` |
| `01-config.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_DEFAULT_TYPE`, `AGENT_CLI_TYPES`, `isAgentCliType`, `normalizeAgentCliType` |
| `01-config.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `01-config.js` | `03-bridge-guard.js` | forward | `existsExecutableAsync`, `pathWithinRoot` |
| `01-config.js` | `04-desktop-shell.js` | forward | `DesktopShell` |
| `01-config.js` | `04-permission-runtime.js` | forward | `activeChildren`, `logEvent`, `resolveExternalMcpServers`, `scanMcpSources` |
| `01-config.js` | `05-claude-engine.js` | forward | `configSecretValueOrCleared`, `configUrlOrCleared`, `sanitizeExternalMcpServer`, `sanitizeProvider` |
| `01-config.js` | `06-provider-engine.js` | forward | `normalizeStoragePolicy` |
| `01-config.js` | `07-autonomy.js` | forward | `DESKTOP_MCP_SERVER_ID`, `TOOL_PACK_DESCRIPTIONS`, `accPolicyHiddenToolNames`, `claudePermissionMode`, `getAgentRoleLibrary`, `nativeToolTier` |
| `01e-permission-modes.js` | `00b-ruyi-names.js` | backward | `canonicalRuyiMcpServerId` |
| `01f-agent-cli-types.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn` |
| `01h-privacy-core.js` | `01i-privacy-rules.js` | backward | `PrivacyRuleCatalog` |
| `01k-credential-vault.js` | `00-boot.js` | backward | `URL`, `fsp`, `path`, `paths` |
| `01k-credential-vault.js` | `01-config.js` | backward | `DurableJsonStore`, `atomicWriteJson` |
| `01k-credential-vault.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `01k-credential-vault.js` | `01j-local-crypto.js` | backward | `LocalSecretCrypto` |
| `01l-credential-recovery.js` | `00-boot.js` | backward | `URL`, `fsp`, `path`, `paths` |
| `01l-credential-recovery.js` | `01-config.js` | backward | `DurableJsonStore`, `atomicWriteJson`, `configEmitWritten`, `invalidateConfigReads`, `lastGoodConfig`, `mutateConfig`, `normalizeConfig`, `readConfig` |
| `01l-credential-recovery.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `01m-privacy-regex.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `01n-work-data-crypto.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `01p-work-data-store.js` | `01n-work-data-crypto.js` | backward | `WorkDataCrypto` |
| `01p-work-data-store.js` | `01r-work-data-chunks.js` | backward | `WorkDataChunks` |
| `01q-work-data-records.js` | `01n-work-data-crypto.js` | backward | `WorkDataCrypto` |
| `01q-work-data-records.js` | `01r-work-data-chunks.js` | backward | `WorkDataChunks` |
| `01r-work-data-chunks.js` | `01n-work-data-crypto.js` | backward | `WorkDataCrypto` |
| `01s-work-data-journals.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `01s-work-data-journals.js` | `01q-work-data-records.js` | backward | `WorkDataRecords` |
| `01s-work-data-journals.js` | `01r-work-data-chunks.js` | backward | `WorkDataChunks` |
| `01t-work-data-recovery.js` | `00-boot.js` | backward | `VERSION`, `text` |
| `01w-work-data-native-publish.js` | `01v-work-data-manifest.js` | backward | `WorkDataManifest` |
| `01x-work-data-migration-codecs.js` | `00-boot.js` | backward | `text` |
| `01x-work-data-migration-codecs.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `01x-work-data-migration-codecs.js` | `01q-work-data-records.js` | backward | `WorkDataRecords` |
| `01z-work-data-root-authority.js` | `00-boot.js` | backward | `WorkDataRootHooks`, `_workDataStableAliases`, `_workDataStableBase`, `dataRoot`, `dataRootAliases`, `paths` |
| `01z-work-data-root-authority.js` | `01g-server-ownership.js` | backward | `ServerOwnership` |
| `01z-work-data-root-authority.js` | `01v-work-data-manifest.js` | backward | `WorkDataManifest` |
| `02-session-store.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `SESSION_SCHEMA`, `SKILL_ID_RE`, `SessionExecutionHooks`, `WorkDataRootHooks`, `crypto`, `ensureDirs`, `fs`, `fsp`, `makeId`, `nowIso`, `os`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `text`, `zlib` |
| `02-session-store.js` | `01-config.js` | backward | `DurableJsonStore`, `assertSessionIdForPath`, `atomicWriteJson`, `mutateConfig`, `noteSessionsDirOwnWrite`, `readConfig`, `readFileTail`, `safeSessionId`, `selectedAgentCli`, `sessionPath`, `sessionWriteChains` |
| `02-session-store.js` | `01c-runtime-flags.js` | backward | `MEMORY_FIXED_SELECTION_HARD_MAX` |
| `02-session-store.js` | `01e-permission-modes.js` | backward | `resolvePermissionMode` |
| `02-session-store.js` | `01j-local-crypto.js` | backward | `LocalSecretCrypto` |
| `02-session-store.js` | `01o-work-data-keys.js` | backward | `WorkDataKeys` |
| `02-session-store.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `02-session-store.js` | `01q-work-data-records.js` | backward | `WorkDataRecords` |
| `02-session-store.js` | `02d-session-overrides.js` | backward | `applySessionDesktopToolsOverride`, `applySessionPermissionModeOverride`, `normalizeSessionDesktopTools`, `normalizeSessionPermissionMode`, `sessionDesktopToolsOverrides`, `sessionEngineRouteOverrides`, `sessionEngineRouteScopeOverrides`, `sessionPermissionModeOf`, `sessionPermissionModeOverrides` |
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
| `03-bridge-guard.js` | `00-boot.js` | backward | `URL`, `WorkDataRootHooks`, `agentCliHomes`, `cp`, `crypto`, `dataRoot`, `dataRootAliases`, `decodeTextFileBytes`, `fs`, `fsp`, `os`, `path`, `spawnDetachedChecked` |
| `03-bridge-guard.js` | `01-config.js` | backward | `readConfig`, `spawnProbeAsync` |
| `03-bridge-guard.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn`, `isBatchLauncher` |
| `03-bridge-guard.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `collectBridgedWriteTargets`, `journalDir`, `journalReadBefore`, `journalRecord`, `journalSessionCtx`, `kindForPath`, `sessionHeadIsWorkDataError` |
| `03-bridge-guard.js` | `02f-turn-effect-kinds.js` | backward | `unprefixedBridgedName` |
| `03-bridge-guard.js` | `04-permission-runtime.js` | forward | `logEvent`, `mcpDropInDirs`, `toolboxComponentsDir` |
| `03-bridge-guard.js` | `05-claude-engine.js` | forward | `activeOpenAiProvider` |
| `03a-privacy-gateway.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `03a-privacy-gateway.js` | `01m-privacy-regex.js` | backward | `PrivacyRegex` |
| `04-desktop-shell.js` | `00-boot.js` | backward | `PS_UTF8_OUTPUT_PREAMBLE`, `cp`, `decodeConsoleText`, `fs`, `fsp`, `os`, `path`, `spawnDetachedChecked`, `text` |
| `04-desktop-shell.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn` |
| `04-desktop-shell.js` | `04-permission-runtime.js` | backward | `killChildTree` |
| `04-permission-runtime.js` | `00-boot.js` | backward | `OVERLAY_ID`, `SessionExecutionHooks`, `URL`, `VERSION`, `WorkDataRootHooks`, `cp`, `crypto`, `dataRoot`, `decodeTextFileBytes`, `ensureDirs`, `externalRoot`, `fs`, `fsp`, `http`, `makeId`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `04-permission-runtime.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_SERVER_ID`, `isRuyiMcpServerId` |
| `04-permission-runtime.js` | `01-config.js` | backward | `BROWSER_AUTOMATION_MODES`, `atomicWriteJson`, `bridgedEnvKeyStripped`, `configDegraded`, `configMutateChain`, `configReadGeneration`, `configWriteChain`, `detectDesktopMcp`, `ensureDesktopMcpWarm`, `generateMcpConfig`, `mutateConfig`, `normalizeConfig`, `readConfig`, `selectedAgentCli` |
| `04-permission-runtime.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn` |
| `04-permission-runtime.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `04-permission-runtime.js` | `01s-work-data-journals.js` | backward | `WorkDataJournals` |
| `04-permission-runtime.js` | `02-session-store.js` | backward | `registerIntervention`, `settleIntervention` |
| `04-permission-runtime.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `04-permission-runtime.js` | `05-claude-engine.js` | forward | `collectDisplayUrlRestores`, `maskKey`, `mcpArgsForDisplay`, `restoreExternalMcpServerSecrets`, `sanitizeExternalMcpServer` |
| `04-permission-runtime.js` | `06d-memory-domain.js` | forward | `legacyAccMemoryMigrationComplete` |
| `04-permission-runtime.js` | `13d-core-domain-routes.js` | forward | `decideIntervention` |
| `04-permission-runtime.js` | `13f-native-tool-schemas.js` | forward | `MCP_TOOLS` |
| `04f-toolbox-services.js` | `00-boot.js` | backward | `cp`, `http`, `path`, `safeJsonParse`, `text` |
| `04f-toolbox-services.js` | `01-config.js` | backward | `mutateConfig`, `readConfig` |
| `04f-toolbox-services.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `enabledToolboxComponents`, `invalidateToolboxCache`, `killChildTree`, `logEvent`, `redact`, `scanToolboxComponents` |
| `04h-provider-http.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `04i-provider-anthropic.js` | `04h-provider-http.js` | backward | `providerBaseWithV1` |
| `04i-provider-wire.js` | `04h-provider-http.js` | backward | `providerApiBase`, `providerBaseWithV1`, `providerCompletionUrl`, `providerRequestHeaders` |
| `04i-provider-wire.js` | `04i-provider-anthropic.js` | backward | `anthropicApiBase`, `anthropicMessagesUrl`, `anthropicModelsUrl`, `anthropicRequestHeaders`, `anthropicRetryBodyOn400`, `applyAnthropicEffort`, `applyAnthropicTemperature`, `applyAnthropicTools`, `createAnthropicStreamDecoder`, `decodeAnthropicCompletion`, `encodeAnthropicMessages`, `encodeAnthropicQuick`, `normalizeAnthropicUsage` |
| `04j-voice-learn.js` | `04j-hanzi-pinyin.js` | backward | `HanziPinyin` |
| `04j-voice-learn.js` | `04j-voice-lexicon.js` | backward | `VoiceLexicon` |
| `05-claude-engine.js` | `00-boot.js` | backward | `DeliveryHooks`, `EventStreamHooks`, `InternalMcpHooks`, `MemoryCliHooks`, `RUYI_EVENTS`, `URL`, `WorkDataRootHooks`, `appendUsageLedger`, `claudeCostFields`, `computeProviderCost`, `cp`, `createCappedDiagnosticText`, `createNdjsonLineFeeder`, `crypto`, `dataRoot`, `fsp`, `normalizePricing`, `nowIso`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `text` |
| `05-claude-engine.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_CLI_TOOL_PREFIX` |
| `05-claude-engine.js` | `01-config.js` | backward | `agentCliLauncherUsable`, `atomicWriteJson`, `buildUserEnvelope`, `decodeClaudeCliText`, `effectiveAnthropicEnv`, `generateSessionMcpConfig`, `isAskUserTool`, `prepareAgentCliSpawn`, `readConfig`, `selectedAgentCli`, `syncMcpServersToKimi`, `writeToChild` |
| `05-claude-engine.js` | `01d-win-cmdline.js` | backward | `CMD_EXE_LINE_LIMIT`, `CMD_LINE_QUOTE_MARGIN`, `cmdLineBudgetFor`, `cmdLineBudgetSeam`, `isBatchLauncher`, `quoteWinArg`, `spawnCmdLineLength` |
| `05-claude-engine.js` | `01e-permission-modes.js` | backward | `CLAUDE_PERMISSION_MODE_MAP` |
| `05-claude-engine.js` | `01f-agent-cli-types.js` | backward | `normalizeAgentCliType` |
| `05-claude-engine.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `05-claude-engine.js` | `02-session-store.js` | backward | `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `reconcileWorkspaceTurnBaseline`, `saveSession`, `saveTurnFinalSession` |
| `05-claude-engine.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `05-claude-engine.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf` |
| `05-claude-engine.js` | `03-bridge-guard.js` | backward | `buildAttachmentPrompt`, `buildDeliveryRevisionPrompt`, `cwdWarning`, `normalizeCwd` |
| `05-claude-engine.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `05-claude-engine.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `activeChildren`, `appendLiveTail`, `assertSessionExecutionOwner`, `buildClaudeRecoveryHistory`, `claudeProviderTailSince`, `claudeResumeRouteKey`, `clearPendingPermissions`, `clearPendingQuestions`, `formatQuestionGuidance`, `hasPendingPermissionForSession`, `hasPendingQuestionForSession`, `installActiveChildEventFanout`, `isClaudeResumeMissingError`, `killChildTree`, `lastAssistantEngine`, `lastSuccessfulClaudeModel`, `logEvent`, `nativeClaudeAgentResultInfo`, `parseClaudeEvent`, `parseKimiStreamJsonEvent`, `permissionWaitMs`, `redact`, `registerSessionExecutionChild`, `registerUserQuestion`, `safeUrlForDisplay`, `sameClaudeResumeCwd`, `stopSession` |
| `05-claude-engine.js` | `04h-provider-http.js` | backward | `providerBaseWithV1`, `providerPostJsonOnce` |
| `05-claude-engine.js` | `04i-provider-anthropic.js` | backward | `normalizeAnthropicAuth`, `normalizeAnthropicFallbacks`, `normalizeAnthropicThinking` |
| `05-claude-engine.js` | `04i-provider-wire.js` | backward | `normalizeProviderApiStyle`, `providerReasoningEffort`, `providerWireProtocol` |
| `05-claude-engine.js` | `04j-voice-lexicon.js` | backward | `VoiceLexicon` |
| `05-claude-engine.js` | `05b-kimi-bridge.js` | forward | `applyKimiStatusToSession`, `kimiContextWindow`, `kimiSessionStatus`, `kimiUsageFromStatus`, `maybeAutoCompactAgentSession`, `runKimiAcpTurnPrepared`, `runKimiCompact`, `syncKimiSessionUsage`, `syncKimiTurnPreferences`, `watchKimiWire` |
| `05-claude-engine.js` | `06-provider-engine.js` | forward | `appendMemorySection`, `appendTurnPolicies`, `buildBrowserAutomationHint`, `buildPlaybookIndexSection`, `buildPromptTaskContext`, `buildSkillsPromptSection`, `buildToolCustomizationHint`, `engineTranscriptCwd`, `evalPlaybookAvailability`, `fenceSafeSlice`, `getCapabilities`, `loadAllPlaybooks`, `peekCapabilities`, `resolveEngineEnvBrief`, `softwareEngineeringTaskProfile` |
| `05-claude-engine.js` | `06b-prompt-registry.js` | forward | `PROMPT_PACK_VERSION`, `getPromptPack` |
| `05-claude-engine.js` | `06c-agent-loop-hooks.js` | forward | `AgentLoopHooks` |
| `05-claude-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `filterMemoryForNativeCli`, `memoryGlobalDir`, `memoryProjectDir`, `resolveMemoryPreflight` |
| `05-claude-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `05-claude-engine.js` | `07-autonomy.js` | forward | `buildClaudeAgentDefinitions`, `classifyToolPacks` |
| `05-claude-engine.js` | `08-agent-runs.js` | forward | `buildOrchestrateHint`, `getAgentWorkflows` |
| `05-claude-engine.js` | `13-http-router.js` | forward | `buildModelHint`, `discoverKimiModels`, `discoverModels`, `kimiModelList`, `offlineModelList` |
| `05b-kimi-bridge.js` | `00-boot.js` | backward | `InternalMcpHooks`, `MAX_BODY_BYTES`, `MemoryCliHooks`, `RUYI_EVENTS`, `StringDecoder`, `URL`, `cp`, `createCappedDiagnosticText`, `createNdjsonLineFeeder`, `dataRoot`, `externalRoot`, `fs`, `fsp`, `http`, `makeId`, `nowIso`, `os`, `path`, `pathToFileURL`, `paths`, `safeJsonParse`, `spawnDetachedChecked`, `text` |
| `05b-kimi-bridge.js` | `01-config.js` | backward | `RUNTIME`, `agentCliLauncherUsable`, `decodeClaudeCliText`, `prepareAgentCliSpawn`, `readConfig`, `selectedAgentCli`, `syncMcpServersToKimi` |
| `05b-kimi-bridge.js` | `02-session-store.js` | backward | `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `mutateSession`, `normalizeTodoItems`, `reconcileWorkspaceTurnBaseline`, `saveSession`, `saveTurnFinalSession` |
| `05b-kimi-bridge.js` | `03-bridge-guard.js` | backward | `buildOpenSpawn`, `cwdWarning`, `fileAllowedRoots`, `guardFileToolPath`, `guardWorkspaceExecute`, `normalizeCwd`, `pathWithinRoot`, `realpathForContainment`, `workspaceWriteRoots` |
| `05b-kimi-bridge.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `05b-kimi-bridge.js` | `04-permission-runtime.js` | backward | `activeChildren`, `assertSessionExecutionOwner`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `hasPendingPermissionForSession`, `killChildTree`, `logEvent`, `permissionWaitMs`, `redact`, `registerSessionExecutionChild`, `requestUserQuestion`, `runAutomaticInterventionDecision`, `stopSession` |
| `05b-kimi-bridge.js` | `05c-kimi-search-policy.js` | forward | `KIMI_ACP_SEARCH_BLOCKED_ENV_RE`, `classifyKimiAcpReadonlySearch` |
| `05b-kimi-bridge.js` | `05d-kimi-prompt-parts.js` | forward | `buildKimiAcpPromptParts` |
| `05b-kimi-bridge.js` | `06-provider-engine.js` | forward | `softwareEngineeringTaskProfile` |
| `05b-kimi-bridge.js` | `06c-agent-loop-hooks.js` | forward | `AgentLoopHooks` |
| `05b-kimi-bridge.js` | `07-autonomy.js` | forward | `requestNativePermission` |
| `05b-kimi-bridge.js` | `10-context-governance.js` | forward | `agentConversationContextMeta`, `lastSessionContextTokens`, `runAgentExternalCompact`, `upsertCompactMarker` |
| `05b-kimi-bridge.js` | `13-http-router.js` | forward | `discoverKimiModels` |
| `05c-kimi-search-policy.js` | `00-boot.js` | backward | `WorkDataRootHooks`, `appRoot`, `dataRoot`, `fsp`, `os`, `path`, `text` |
| `05c-kimi-search-policy.js` | `03-bridge-guard.js` | backward | `fileAllowedRoots`, `guardFileToolPath`, `isSensitiveDataPath`, `pathWithinRoot`, `realpathForContainment` |
| `05d-kimi-prompt-parts.js` | `00-boot.js` | backward | `fsp`, `path` |
| `05d-kimi-prompt-parts.js` | `03-bridge-guard.js` | backward | `guardFileToolPath`, `realpathForContainment` |
| `06-provider-engine.js` | `00-boot.js` | backward | `APP_NAME`, `DEFAULT_PORT`, `EventStreamHooks`, `OVERLAY_ID`, `RUYI_EVENTS`, `VERSION`, `WorkDataRootHooks`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `cp`, `crypto`, `dataRoot`, `externalRoot`, `fsp`, `isPkg`, `neutralizeFenceTag`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `06-provider-engine.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_CLI_TOOL_PREFIX` |
| `06-provider-engine.js` | `01-config.js` | backward | `RUNTIME`, `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06-provider-engine.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `06-provider-engine.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_DEFAULT_TYPE`, `isAgentCliType` |
| `06-provider-engine.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `06-provider-engine.js` | `02-session-store.js` | backward | `SESSION_BRIEF_GIST_CHARS`, `SESSION_BRIEF_TITLE_CHARS`, `SESSION_INDEX_FILE`, `loadSession`, `readSessionHeadResilient`, `sessionTitleOverrides`, `updateSessionMeta` |
| `06-provider-engine.js` | `03-bridge-guard.js` | backward | `existsExecutableAsync`, `probeGitCliAsync` |
| `06-provider-engine.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `06-provider-engine.js` | `04-permission-runtime.js` | backward | `activeChildren`, `auditLogError`, `collectBridgedTools`, `flushWorkbenchLogs`, `logEvent`, `mcpClients`, `readWorkbenchLogFile`, `redact`, `resolveExternalMcpServers`, `sanitizeServerId`, `workbenchAuditJournal` |
| `06-provider-engine.js` | `04h-provider-http.js` | backward | `providerBaseIsLocalOrLan`, `providerBaseWithV1`, `providerPostJsonOnce` |
| `06-provider-engine.js` | `04i-provider-wire.js` | backward | `applyProviderReasoningEffort`, `normalizeProviderApiStyle`, `providerWireProtocol` |
| `06-provider-engine.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `agentCliAdapter` |
| `06-provider-engine.js` | `06b-prompt-registry.js` | forward | `PROMPT_EN`, `getPromptPack` |
| `06-provider-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryPromptSection` |
| `06-provider-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `06-provider-engine.js` | `07-autonomy.js` | forward | `toolPackForName` |
| `06-provider-engine.js` | `11-native-tools.js` | forward | `probeRgAsync` |
| `06b-prompt-registry.js` | `00-boot.js` | backward | `text` |
| `06c-agent-loop-hooks.js` | `00-boot.js` | backward | `makeId` |
| `06c-agent-loop-hooks.js` | `04-permission-runtime.js` | backward | `logEvent`, `redact` |
| `06d-memory-domain.js` | `00-boot.js` | backward | `SKILL_ID_RE`, `WorkDataRootHooks`, `agentCliHomes`, `apiFailure`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `json`, `makeId`, `neutralizeFenceTag`, `nowIso`, `os`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `text`, `tildePath` |
| `06d-memory-domain.js` | `01-config.js` | backward | `DurableJsonStore`, `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06d-memory-domain.js` | `01c-runtime-flags.js` | backward | `coreMemoryCharBudget`, `coreMemoryMaxItems`, `memoryFixedSelectionMax`, `memoryIndexCharCap`, `memoryRelevanceMax`, `memoryVectorRecallEnabled` |
| `06d-memory-domain.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
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
| `06i-steward-core.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `06k-config-patch.js` | `00-boot.js` | backward | `fsp`, `os`, `path`, `paths` |
| `06k-config-patch.js` | `01-config.js` | backward | `ConfigPatchHooks`, `invalidateAgentCliPathCaches`, `mutateConfig`, `syncAgentCliMcpManifests`, `syncAgentRolesToClaude`, `syncClaudeCliSettings`, `syncMcpServersToClaude` |
| `06k-config-patch.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES_REQUIRING_CONFIRM` |
| `06k-config-patch.js` | `02-session-store.js` | backward | `rememberLastUsedEngineRoute` |
| `06k-config-patch.js` | `02e-session-engine-route.js` | backward | `sessionEngineRouteFromConfig` |
| `06k-config-patch.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `invalidateMcpRuntime`, `logEvent` |
| `06k-config-patch.js` | `05-claude-engine.js` | backward | `maskedSecretConflictMessage`, `maskedSecretConflicts`, `unmaskSecrets` |
| `06k-config-patch.js` | `06i-steward-core.js` | backward | `StewardHooks` |
| `07-autonomy.js` | `00-boot.js` | backward | `EventStreamHooks`, `InternalMcpHooks`, `MemoryCliHooks`, `TOOL_TIER_RANK`, `URL`, `apiFailure`, `appendUsageLedger`, `claudeCostFields`, `cp`, `createNdjsonLineFeeder`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `07-autonomy.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_SERVER_ID` |
| `07-autonomy.js` | `01-config.js` | backward | `atomicWriteJson`, `buildUserEnvelope`, `decodeClaudeCliText`, `detectClaudePath`, `effectiveAnthropicEnv`, `generateAgentNodeMcpConfig`, `readConfig`, `safeSessionId` |
| `07-autonomy.js` | `01c-runtime-flags.js` | backward | `appendOnlyToolSchemasEnabled`, `observationRecallEnabled` |
| `07-autonomy.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn`, `cmdLineBudgetFor`, `spawnCmdLineLength` |
| `07-autonomy.js` | `01e-permission-modes.js` | backward | `BUILTIN_AGENT_ROLES`, `CLAUDE_PERMISSION_MODE_MAP`, `annotateAgentRoleEffective`, `clampAgentRoleToParent`, `mergeAgentRole`, `normalizeAgentRole` |
| `07-autonomy.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `07-autonomy.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `registerIntervention`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveSession`, `settleIntervention` |
| `07-autonomy.js` | `02f-turn-effect-kinds.js` | backward | `unprefixedBridgedName` |
| `07-autonomy.js` | `03-bridge-guard.js` | backward | `buildAttachmentPrompt`, `existsExecutableAsync`, `normalizeCwd`, `pathWithinRoot` |
| `07-autonomy.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `07-autonomy.js` | `04-permission-runtime.js` | backward | `ManagedMcp`, `PermissionWaitHooks`, `killChildTree`, `logEvent`, `parseClaudeEvent`, `pendingPermissions`, `pendingPlans`, `promptWaitMs`, `redact`, `resolveBridge`, `runAutomaticInterventionDecision` |
| `07-autonomy.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `07-autonomy.js` | `04h-provider-http.js` | backward | `providerBaseIsLocalOrLan`, `providerModelPostOnce`, `providerRetryAfterMs`, `providerScrubSecrets`, `providerThrownErrorText`, `withTransientRetry` |
| `07-autonomy.js` | `04i-provider-wire.js` | backward | `ProviderWireHooks`, `providerWireProtocol`, `providerWireProtocolForBody` |
| `07-autonomy.js` | `06-provider-engine.js` | backward | `appendResponseLanguagePolicy`, `toolRequirementsMet` |
| `07-autonomy.js` | `06i-steward-core.js` | backward | `isStewardToolName`, `stewardAutoAskIndirect`, `stewardAutoAskScanIncomplete`, `stewardAutoAskSensitiveKind`, `stewardToolPermanentlyExempt` |
| `07-autonomy.js` | `08-agent-runs.js` | forward | `saveAgentRun` |
| `07-autonomy.js` | `09d-token-estimation.js` | forward | `estimateTextTokensMemo` |
| `07-autonomy.js` | `10-context-governance.js` | forward | `CONTEXT_OVERFLOW_PATTERNS`, `cacheContextLength`, `extractContextLength`, `isContextOverflowError` |
| `07-autonomy.js` | `13f-native-tool-schemas.js` | forward | `MCP_TOOLS`, `PROVIDER_SESSION_TOOL_SCHEMAS` |
| `08-agent-runs.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `SubAgentMemoryHooks`, `TOOL_TIER_RANK`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `samePathKey`, `text`, `zlib` |
| `08-agent-runs.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `readFileTail`, `safeSessionId` |
| `08-agent-runs.js` | `01c-runtime-flags.js` | backward | `estimateBucketsEnabled` |
| `08-agent-runs.js` | `01e-permission-modes.js` | backward | `clampAgentRoleToParent`, `resolvePermissionMode` |
| `08-agent-runs.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `08-agent-runs.js` | `01q-work-data-records.js` | backward | `WorkDataRecords` |
| `08-agent-runs.js` | `01s-work-data-journals.js` | backward | `WorkDataJournals` |
| `08-agent-runs.js` | `02-session-store.js` | backward | `MISSION_STALL_SIGNAL_WINDOW_MS`, `bridgedWriteRelativePathArg`, `isProviderToolArgsObject`, `missionSignalThrottleAllow`, `mutateSession`, `providerHistoryToolCalls`, `readInterventions`, `readSessionHeadResilient`, `registerIntervention`, `sessionAssociatedSaveIsTombstoned`, `settleIntervention` |
| `08-agent-runs.js` | `02d-session-overrides.js` | backward | `applySessionPermissionModeOverride`, `liveSessionPermissionMode`, `sessionDesktopToolsOf` |
| `08-agent-runs.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `guardWorkspacePath`, `journalBridgedWrite`, `normalizeCwd`, `preflightWriteBoundary`, `privacyMapBounded` |
| `08-agent-runs.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `08-agent-runs.js` | `04-permission-runtime.js` | backward | `ManagedMcp`, `bridgedServerUnavailableMessage`, `collectBridgedTools`, `getBridgedClient`, `logEvent`, `pendingPermissions`, `permissionWaitMs`, `redact`, `resolveBridge`, `runAutomaticInterventionDecision` |
| `08-agent-runs.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `08-agent-runs.js` | `04h-provider-http.js` | backward | `providerBaseWithV1`, `providerCallIsTransient`, `withTransientRetry` |
| `08-agent-runs.js` | `04i-provider-wire.js` | backward | `applyProviderReasoningEffort`, `providerServerSearchCard`, `providerWireOutputLimited`, `providerWireProtocol` |
| `08-agent-runs.js` | `05-claude-engine.js` | backward | `resolveProvider` |
| `08-agent-runs.js` | `06-provider-engine.js` | backward | `TOOL_ITERATION_BUDGETS`, `appendResponseLanguagePolicy`, `buildModelExecutionFacts`, `buildProviderSystemPrompt`, `getCapabilities`, `readProjectMemory`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget` |
| `08-agent-runs.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease` |
| `08-agent-runs.js` | `06i-steward-core.js` | backward | `stewardAutoAskReason` |
| `08-agent-runs.js` | `07-autonomy.js` | backward | `LOOP_GUARD_LIMITS`, `MAIL_QUEUE_MAX`, `MEMORY_WRITE_TOOL_NAMES`, `activeAgentRuns`, `agentRunDir`, `agentRunFile`, `agentRunSnapshotStamp`, `agentRunSnapshotStore`, `agentRunWriteChains`, `bridgedToolTier`, `buildOpenAiTools`, `classifyToolPacks`, `dropPolicyDisabledBridgedTools`, `fetchOpenAiModels`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `nativeToolTier`, `neutralizeInjectedPrefixes`, `openAiStreamOnce`, `readAgentRunSnapshot`, `requestNativePermission`, `runClaudeSubAgentOnce`, `toolDisabledByPolicy`, `toolDisabledResult`, `toolPackForName`, `webPayloadReason` |
| `08-agent-runs.js` | `09-workflow.js` | forward | `launchPersistedAgentRun` |
| `08-agent-runs.js` | `09d-token-estimation.js` | forward | `estimateContentTokens`, `estimateHistoryTokens`, `setEstimateBucketsV1` |
| `08-agent-runs.js` | `10-context-governance.js` | forward | `boundToolResultForDisplay`, `compactionRefetchRefusal`, `compactionRefetchWarning`, `createCompactionRefetchGuard`, `encodeModelToolResult`, `estimateFactor`, `isContextOverflowError`, `maybeCompactSubHistory`, `noteWindowOvershoot`, `recordCompactUsage`, `runForcedOverflowCompaction`, `writeHistorySnapshot` |
| `08-agent-runs.js` | `13-http-router.js` | forward | `resolveNodeModel` |
| `08-agent-runs.js` | `13e-pretender-index.js` | forward | `markPretenderIndexDirty` |
| `09-workflow.js` | `00-boot.js` | backward | `DeliveryHooks`, `EventStreamHooks`, `MemoryCliHooks`, `RUYI_EVENTS`, `SubAgentMemoryHooks`, `TOOL_TIER_RANK`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `localTurnTimeParts`, `makeId`, `neutralizeFenceTag`, `nowIso`, `text` |
| `09-workflow.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `09-workflow.js` | `01c-runtime-flags.js` | backward | `budgetGuardDecision`, `budgetGuardEnabled`, `budgetGuardTurnTokens`, `budgetGuardWarnRatio`, `estimateBucketsEnabled`, `sessionNotesInjectEnabled`, `toolByteBudgetShadowBytes`, `toolTimeBudgetEnabled`, `toolTimeBudgetHardMs`, `toolTimeBudgetShadowEnabled`, `toolTimeBudgetWarnMs`, `volatileTailLayoutEnabled` |
| `09-workflow.js` | `01e-permission-modes.js` | backward | `agentRoleIsUntrusted`, `clampAgentRoleToParent`, `resolvePermissionMode` |
| `09-workflow.js` | `02-session-store.js` | backward | `applyMissionUpdate`, `bridgedWriteRelativePathArg`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isProviderToolArgsObject`, `isUntitledSessionTitle`, `journalReadIndex`, `journalRevertNoticesAck`, `journalRevertNoticesPeek`, `loadSession`, `mergeMissionBeforeSave`, `mutateSession`, `normalizeMetaToolArgs`, `normalizeTodoItems`, `providerHistoryToolCalls`, `readSessionNotes`, `readSessionScratchpad`, `reconcileWorkspaceTurnBaseline`, `recordMissionBudgetTrippedChange`, `recordMissionStalledChange`, `registerIntervention`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveSession`, `saveTurnFinalSession`, `sessionHeadIsWorkDataError`, `sessionSaveIsTombstoned`, `settleIntervention` |
| `09-workflow.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `09-workflow.js` | `02d-session-overrides.js` | backward | `liveSessionPermissionMode`, `sessionDesktopToolsOf` |
| `09-workflow.js` | `02f-turn-effect-kinds.js` | backward | `normalizeToolInvokeArgs`, `toolInvokeEnvelopeRepair` |
| `09-workflow.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `buildAttachmentPrompt`, `buildDeliveryRevisionPrompt`, `cwdWarning`, `journalBridgedWrite`, `normalizeCwd`, `preflightWriteBoundary`, `privacyMapBounded` |
| `09-workflow.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `09-workflow.js` | `04-permission-runtime.js` | backward | `ManagedMcp`, `activeChildren`, `appendLiveTail`, `assertSessionExecutionOwner`, `bridgedServerUnavailableMessage`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `collectBridgedTools`, `getBridgedClient`, `hasPendingPermissionForSession`, `hasPendingQuestionForSession`, `installActiveChildEventFanout`, `lastAssistantEngine`, `logEvent`, `permissionWaitMs`, `redact`, `registerSessionExecutionChild`, `requestUserQuestion`, `resolveBridge`, `stopSession` |
| `09-workflow.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `09-workflow.js` | `04h-provider-http.js` | backward | `providerCallIsTransient`, `providerThrownErrorText`, `withTransientRetry` |
| `09-workflow.js` | `04i-provider-wire.js` | backward | `applyProviderReasoningEffort`, `providerServerSearchCard`, `providerWireContentFiltered`, `providerWireContextExceeded`, `providerWireOutputLimited`, `providerWireProtocol` |
| `09-workflow.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `resolveProvider`, `stripUrlUserinfo` |
| `09-workflow.js` | `06-provider-engine.js` | backward | `appendTurnPolicies`, `buildModelExecutionFacts`, `buildPromptTaskContext`, `buildStableSystemPrompt`, `buildVolatileParts`, `evalPlaybookAvailability`, `getCapabilities`, `loadAllPlaybooks`, `neutralizeAuthoredText`, `readProjectMemory`, `repairNodeJsonViaProvider`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget`, `softwareEngineeringTaskProfile` |
| `09-workflow.js` | `06b-prompt-registry.js` | backward | `PROMPT_EN`, `PROMPT_PACK_VERSION`, `getPromptPack`, `revertNoticeTurns` |
| `09-workflow.js` | `06c-agent-loop-hooks.js` | backward | `AgentLoopHooks` |
| `09-workflow.js` | `06d-memory-domain.js` | backward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `buildMemoryTurnSection`, `extractMemoryRelationProposals`, `filterMemoryForNativeCli`, `memoryExclusionSet`, `memoryIsExpired`, `memorySelectionSignature`, `proposeMemoryRelation`, `readConfirmedSupersedeEdges`, `resolveMemoryPreflight` |
| `09-workflow.js` | `06f-autonomy-grants.js` | backward | `consumeGrant` |
| `09-workflow.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources` |
| `09-workflow.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `09-workflow.js` | `07-autonomy.js` | backward | `ACTION_VIEW_MIN_CHARS`, `ACTION_VIEW_TOOLS`, `LOOP_GUARD_LIMITS`, `MAIL_GLOBAL_MAX`, `MAIL_PER_SENDER_MAX`, `MAIL_QUEUE_MAX`, `MAIL_TEXT_MAX`, `POOL_CHAIN_MAX`, `POOL_GRACE_MS`, `POOL_MAX_TOTAL`, `actionTargetMeta`, `activeAgentRuns`, `bridgedToolTier`, `buildOpenAiTools`, `classifyRuntimeToolFailure`, `claudeSubAgentTurnBudget`, `cleanupAgentWorktree`, `compareToolRetrievalShadow`, `createAgentWorktree`, `createToolLoadingState`, `drainSteerQueue`, `dropPolicyDisabledBridgedTools`, `estimateToolSchemaTokens`, `failoverStickyBase`, `finalizeAgentWorktree`, `getAgentRoleLibrary`, `hasInterruptingSteer`, `looksLikePlan`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `nativeToolTier`, `openAiStreamOnce`, `projectActionModelView`, `readAgentRunSnapshot`, `requestNativePermission`, `requestPlanApproval`, `resumeInFlight`, `toolDisabledByPolicy`, `toolDisabledResult`, `webPayloadReason` |
| `09-workflow.js` | `08-agent-runs.js` | backward | `accumulateRunUsage`, `agentRunCapabilities`, `agentRunEventsJournal`, `agentRunResultSlice`, `agentRunRoster`, `agentRunSaveFailures`, `aggregateAgentVote`, `aggregateCoverage`, `appendAgentRunEvent`, `buildAgentRunEnvelope`, `buildOrchestrateHint`, `buildUpstreamContext`, `bumpRunIntervention`, `classifyNodeErrorText`, `computeSchedulerStep`, `dedupeAgentFindings`, `deriveNodeOutputs`, `evalWaitCondition`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `flushAgentRunEvents`, `formatNodeEvidencePrompt`, `getAgentWorkflows`, `indexNodeEvidence`, `materializePoolItem`, `nodeDeliveryEligibility`, `normalizeAgentGate`, `normalizeWaitSpec`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `orchestrateArgsProblem`, `orchestrateModelNotes`, `ownAgentMessageReceipt`, `parseStructuredAgentOutput`, `poolChainDepth`, `propagateAssignments`, `purgeNodeEvidence`, `readAgentRunRecord`, `recordAgentNodeProgress`, `recordRunBudgetTrippedEvent`, `recordRunStalledEvent`, `resolveAgentTeamRoute`, `resolveOrchestrateFollowup`, `resolveOrchestrateNodes`, `runSubAgent`, `sanitizeAgentOutputSchema`, `saveAgentRun`, `summarizeAgentWorkflowRun`, `syncRunEventSeq`, `validateAgentJsonSchema`, `verdictPasses`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `09-workflow.js` | `09b-replan-ledger.js` | backward | `proposeReplanPatch`, `recordNodeContinuation`, `validateReplanPatch` |
| `09-workflow.js` | `09d-token-estimation.js` | backward | `estimateContentTokens`, `estimateHistoryTokens`, `setEstimateBucketsV1` |
| `09-workflow.js` | `10-context-governance.js` | forward | `agentNodeContextWindow`, `appendPromptToLastUserMessage`, `boundToolResultForDisplay`, `buildObservationRecallPrompt`, `buildSessionNotesInjectPrompt`, `buildSessionScratchpadInjectPrompt`, `compactionRefetchRefusal`, `compactionRefetchWarning`, `createCompactionRefetchGuard`, `encodeModelToolResult`, `estimateFactor`, `isContextOverflowError`, `maybeAutoCompact`, `maybeWriteSessionNotes`, `noteEstimateSample`, `noteWindowOvershoot`, `providerContextWindow`, `recordCompactUsage`, `runForcedOverflowCompaction`, `upsertCompactMarker`, `writeHistorySnapshot` |
| `09-workflow.js` | `13-http-router.js` | forward | `buildModelHint`, `getProxyModelsCache`, `resolveNodeModel` |
| `09b-replan-ledger.js` | `00-boot.js` | backward | `TOOL_TIER_RANK`, `hashArgs`, `makeId`, `nowIso` |
| `09d-token-estimation.js` | `07-autonomy.js` | backward | `estimateToolSchemaTokens` |
| `09d-token-estimation.js` | `10-context-governance.js` | forward | `ESTIMATION_RULES` |
| `10-context-governance.js` | `00-boot.js` | backward | `EventStreamHooks`, `SessionExecutionHooks`, `URL`, `apiSessionIdInvalid`, `appendUsageLedger`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fs`, `fsp`, `makeId`, `nowIso`, `path`, `paths`, `text`, `zlib` |
| `10-context-governance.js` | `01-config.js` | backward | `DurableJsonStore`, `readConfig`, `readJsonBody`, `safeSessionId`, `send` |
| `10-context-governance.js` | `01c-runtime-flags.js` | backward | `evaporateBudgetBoundaryEnabled`, `historyReadDedupEnabled`, `observationRecallEnabled`, `reseedReattachFilesEnabled`, `reseedTailUnitsEnabled`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `summaryEntityCheckEnabled`, `summaryFactTableCap`, `summaryFactTableEnabled`, `summaryPromptI18nEnabled`, `summaryRefineEnabled`, `summarySingleShotEnabled` |
| `10-context-governance.js` | `01e-permission-modes.js` | backward | `permissionModeFrom`, `resolvePermissionMode` |
| `10-context-governance.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `10-context-governance.js` | `02-session-store.js` | backward | `createSession`, `journalBytesAdjust`, `journalDir`, `journalGc`, `journalGzipStore`, `journalReadHistory`, `loadSession`, `mutateSession`, `readSessionNotes`, `rememberLastUsedEngineRoute`, `repairProviderHistoryPairing`, `saveSession`, `sessionMessagesDelta`, `sessionMessagesStamp`, `sessionMissionId`, `sessionObjectIsStale`, `sessionTodosSignature`, `toolImageSessionTag`, `updateSessionMeta`, `withJournalWriteLock`, `writeSessionNotes` |
| `10-context-governance.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf`, `sessionEngineRouteScopeOverrides` |
| `10-context-governance.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute`, `inferSessionEngineRoute`, `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `10-context-governance.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `10-context-governance.js` | `04-permission-runtime.js` | backward | `ManagedMcp`, `activeChildren`, `assertSessionExecutionOwner`, `driverAutoSessions`, `logEvent`, `recordSessionExecutionOwner`, `redact`, `requestSessionExecutionStop`, `sessionExecutionSnapshot`, `stopSession`, `turnOutcomePending`, `turnSettlers` |
| `10-context-governance.js` | `04h-provider-http.js` | backward | `providerBaseWithV1`, `providerModelPostOnce` |
| `10-context-governance.js` | `04i-provider-wire.js` | backward | `normalizeProviderApiStyle`, `providerWireProtocol` |
| `10-context-governance.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `agentCliAdapter`, `runClaudeTurn` |
| `10-context-governance.js` | `06-provider-engine.js` | backward | `buildProviderSystemPrompt`, `buildStableSystemPrompt`, `maybeWriteThreadBrief`, `settleThreadBrief` |
| `10-context-governance.js` | `06e-mission-domain.js` | backward | `runMissionDriver` |
| `10-context-governance.js` | `06f-autonomy-grants.js` | backward | `activeDriverRuns`, `bindDriverRun`, `revokeGrantsForRun` |
| `10-context-governance.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardTaintToolCall`, `stewardWatchedThread` |
| `10-context-governance.js` | `07-autonomy.js` | backward | `buildOpenAiTools`, `fetchOpenAiModels`, `nativeToolTier` |
| `10-context-governance.js` | `09-workflow.js` | backward | `runOpenAiTurn` |
| `10-context-governance.js` | `09d-token-estimation.js` | backward | `CONTEXT_WINDOW_FALLBACK`, `EVAPORATED_PREFIX`, `countCjkCodeUnits`, `estimateContentTokens`, `estimateHistoryTokens`, `estimateTextTokens`, `fmtTokensServer`, `tokensFromTextCounts` |
| `11-native-tools.js` | `00-boot.js` | backward | `EventStreamHooks`, `PS_UTF8_OUTPUT_PREAMBLE`, `RUYI_EVENTS`, `RUYI_PATH_BEFORE_VENDOR`, `URL`, `WorkDataRootHooks`, `cp`, `createConsoleLineDecoder`, `crypto`, `dataRoot`, `dataRootAliases`, `decodeConsoleText`, `fs`, `fsp`, `nowIso`, `os`, `path`, `paths`, `runKeyedChain`, `ruyiVendorBinDir`, `safeJsonParse`, `samePathEntry`, `text`, `zlib` |
| `11-native-tools.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath` |
| `11-native-tools.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `11-native-tools.js` | `02-session-store.js` | backward | `sessionDeleteTombstones` |
| `11-native-tools.js` | `03-bridge-guard.js` | backward | `_dataRootReal`, `ensureDataRootReal`, `existsExecutable`, `existsExecutableAsync`, `isSensitiveDataPath`, `isSensitiveHardlinkAlias`, `pathWithinRoot`, `privacyLocalIo`, `realpathForContainment`, `sensitiveFileIdentities` |
| `11-native-tools.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `11-native-tools.js` | `04-permission-runtime.js` | backward | `activeChildren`, `killChildTree`, `logEvent`, `redact` |
| `11-native-tools.js` | `06-provider-engine.js` | backward | `markNetworkOnline`, `networkAnchors`, `probeAny` |
| `11-native-tools.js` | `07-autonomy.js` | backward | `MAIL_TEXT_MAX`, `activeAgentRuns`, `neutralizeInjectedPrefixes` |
| `11b-file-text-io.js` | `00-boot.js` | backward | `cp`, `text` |
| `11c-file-visual-io.js` | `00-boot.js` | backward | `cp`, `paths` |
| `12-tool-dispatch.js` | `00-boot.js` | backward | `ASR_MAX_BODY_BYTES`, `InternalMcpHooks`, `MigrationHooks`, `OVERLAY_ID`, `SKILL_ID_RE`, `TOOL_TIER_RANK`, `URL`, `agentCliHomes`, `cp`, `crypto`, `externalRoot`, `fs`, `fsp`, `nowIso`, `os`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `spawnDetachedChecked`, `text` |
| `12-tool-dispatch.js` | `01-config.js` | backward | `RUNTIME`, `agentCliLauncherOk`, `atomicWriteJson`, `commandForSelfMcp`, `defaultConfig`, `ensureDesktopMcpWarm`, `externalServerJs`, `normalizeConfig`, `readConfig`, `safeSessionId`, `selectedAgentCli`, `staticBase` |
| `12-tool-dispatch.js` | `01c-runtime-flags.js` | backward | `execResultCacheEnabled`, `execResultCacheMaxEntries`, `observationRecallEnabled` |
| `12-tool-dispatch.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `12-tool-dispatch.js` | `02-session-store.js` | backward | `JOURNAL_KEEP_TURNS`, `JOURNAL_MAX_BEFORE_BYTES`, `SESSION_SCRATCHPAD_LIMITS`, `bridgedWriteRelativePathArg`, `journalDropEntries`, `journalReadIndex`, `journalRecord`, `journalRecordMany`, `journalRevertLogRead`, `journalSessionCtx`, `loadSession`, `normalizeMetaToolArgs`, `normalizeScratchpadKey`, `normalizeScratchpadText`, `normalizeTodoItems`, `readSessionScratchpad`, `scratchpadTotalChars`, `updateSessionScratchpad` |
| `12-tool-dispatch.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf` |
| `12-tool-dispatch.js` | `02f-turn-effect-kinds.js` | backward | `normalizeToolInvokeArgs` |
| `12-tool-dispatch.js` | `03-bridge-guard.js` | backward | `PrivacyRecipientHooks`, `REVEAL_OPEN_SAFE_EXTS`, `UNC_DENIED_ERROR`, `WriteBoundaryHooks`, `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `buildBrowserOpenSpawn`, `buildOpenSpawn`, `buildRevealSpawn`, `guardFileToolPath`, `isBrowserDocumentTarget`, `journalBridgedWrite`, `normalizeCwd`, `pathWithinRoot`, `privacyInspectLocalPath`, `privacyInspectionSegment`, `privacyLocalIo`, `realpathForContainment`, `remoteUncDenialResolved` |
| `12-tool-dispatch.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `12-tool-dispatch.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `12-tool-dispatch.js` | `04-permission-runtime.js` | backward | `ManagedMcp`, `bridgedServerUnavailableMessage`, `configureMcpFromTool`, `getBridgedClient`, `logEvent`, `resolveBridge`, `resolveExternalMcpServers`, `safeMcpInventory` |
| `12-tool-dispatch.js` | `04i-provider-wire.js` | backward | `providerWireProtocol` |
| `12-tool-dispatch.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `resolveAsrProvider`, `transcribeAudioViaProvider`, `voiceLexiconAsrPromptFor` |
| `12-tool-dispatch.js` | `06-provider-engine.js` | backward | `PLAYBOOK_REQUIRES`, `buildRuntimeIdentityFacts`, `evalPlaybookAvailability`, `getCapabilities`, `listPlaybooksWithAvailability`, `loadAllPlaybooks`, `markNetworkOnline`, `neutralizeAuthoredText`, `peekCapabilities`, `updateAutomaticThreadTitle` |
| `12-tool-dispatch.js` | `06d-memory-domain.js` | backward | `listWorkbenchMemories`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `readWorkbenchMemory` |
| `12-tool-dispatch.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName`, `stewardAssemblePlaybookPrompt`, `stewardPlaybookMissingInputs` |
| `12-tool-dispatch.js` | `07-autonomy.js` | backward | `NATIVE_COMMAND_TOOL_NAMES`, `NATIVE_DESKTOP_TOOL_NAMES`, `bridgedToolTier`, `compareToolRetrievalShadow`, `listCompactTools`, `nativeToolAvailableInContext`, `nativeToolDisabledByPolicy`, `nativeToolSchema`, `nativeToolsAcceptingArgKeys`, `searchToolCatalog`, `toolArgsSkeleton`, `toolDisabledByPolicy`, `toolDisabledResult` |
| `12-tool-dispatch.js` | `08-agent-runs.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `getAgentWorkflows` |
| `12-tool-dispatch.js` | `10-context-governance.js` | backward | `providerTurnQuotaKey`, `rehydrateObservation` |
| `12-tool-dispatch.js` | `11-native-tools.js` | backward | `NativeSourceHooks`, `binaryReadHint`, `gitDiff`, `gitStatus`, `isBinaryReadPath`, `levenshtein`, `powershellMissingOr`, `privacyReadTextWindow`, `privacySourceActive`, `privacySourceLine`, `privacySourceLineOffsets`, `privacySourceMark`, `privacySourceViews`, `probeRgAsync`, `readIfExists` |
| `12-tool-dispatch.js` | `11b-file-text-io.js` | backward | `FileTextIo` |
| `12-tool-dispatch.js` | `11c-file-visual-io.js` | backward | `FileVisualIo` |
| `12-tool-dispatch.js` | `11d-media-inspection.js` | backward | `MediaInspection` |
| `13-http-router.js` | `00-boot.js` | backward | `APP_NAME`, `CONFIG_SCHEMA`, `CliBusinessHooks`, `DATA_ROOT_MIGRATION`, `DEFAULT_PORT`, `EventStreamHooks`, `ExternalBotHooks`, `InternalMcpHooks`, `MemoryCliHooks`, `MigrationHooks`, `OVERLAY_ID`, `ProxyModelHooks`, `SKILL_ID_RE`, `URL`, `VERSION`, `WorkDataRootHooks`, `apiFailure`, `apiSessionIdInvalid`, `apiSessionNotFound`, `buildUsageSummary`, `cp`, `crypto`, `dataRoot`, `dataRootAliases`, `decodeConsoleText`, `defaultDataRoots`, `ensureDirs`, `exePath`, `externalRoot`, `flushUsageLedgerSync`, `fs`, `fsp`, `http`, `isDirectServeInvocation`, `isPkg`, `json`, `lstatOrNull`, `migrateLegacyDataRoot`, `nowIso`, `os`, `path`, `paths`, `recordInstallLaunch`, `runKeyedChain`, `safeJsonParse`, `spawnDetachedChecked`, `text` |
| `13-http-router.js` | `00b-ruyi-names.js` | backward | `LEGACY_RUYI_MCP_SERVER_IDS`, `RUYI_MCP_SERVER_ID` |
| `13-http-router.js` | `01-config.js` | backward | `ConfigPatchHooks`, `RUNTIME`, `atomicWriteJson`, `authorizeRoute`, `autoImportClaudeCodeMcp`, `beginBootCliPathProbes`, `contentTypeFor`, `decodeClaudeCliText`, `desktopMcpDetectionPending`, `detectClaudePath`, `detectDesktopMcp`, `detectKimiPath`, `effectiveAnthropicEnv`, `ensureDesktopMcpWarm`, `externalServerJs`, `finishBootCliPathProbes`, `generateMcpConfig`, `hostAllowed`, `isLoopbackBindHost`, `mcpConfigFilePath`, `mutateConfig`, `prepareAgentCliSpawn`, `readConfig`, `readJsonBody`, `requestIsLoopback`, `safeSessionId`, `selectedAgentCli`, `send`, `sendError`, `serveStatic`, `sweepStaleScriptFiles`, `syncAgentCliMcpManifests`, `syncAgentRolesToClaude`, `syncClaudeCliSettings`, `syncMcpServersToClaude`, `tokenMatches`, `tokenOk`, `waitForBootCliPathProbes` |
| `13-http-router.js` | `01c-runtime-flags.js` | backward | `coreMemoryCharBudget`, `coreMemoryMaxItems`, `memoryFixedSelectionMax`, `memoryRelevanceMax`, `observationRecallEnabled` |
| `13-http-router.js` | `01e-permission-modes.js` | backward | `BUILTIN_AGENT_ROLES`, `PERMISSION_MODES`, `annotateAgentRoleEffective`, `normalizeAgentRole` |
| `13-http-router.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES` |
| `13-http-router.js` | `01g-server-ownership.js` | backward | `ServerOwnership` |
| `13-http-router.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `13-http-router.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13-http-router.js` | `02-session-store.js` | backward | `flushSessionIndexSync`, `invalidateSessionIndex`, `journalReadBefore`, `journalReadIndex`, `loadSession`, `markInterruptedInterventions`, `mutateSession`, `readSessionHeadText`, `readSessionRouteHead`, `sessionHeadIsWorkDataError`, `workspaceBaselineIsCodePath`, `workspaceBaselinePathKey` |
| `13-http-router.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute` |
| `13-http-router.js` | `03-bridge-guard.js` | backward | `PREVIEW_TEXT_EXTS`, `buildCodeEditorSpawn`, `buildRevealSpawn`, `ensureDataRootReal`, `existsExecutable`, `fileAllowedRoots`, `guardWorkspacePath`, `isSensitiveDataPath`, `isSensitiveHardlinkAlias`, `launchCodeEditor`, `materializeCheckpointEditorDiff`, `normalizeCwd`, `pathWithinAnyRoot`, `pathWithinRoot`, `readFilePreview`, `remoteUncDenialResolved`, `resolvePreferredCodeEditor`, `resolveWorkspace` |
| `13-http-router.js` | `03b-privacy-local-drive.js` | backward | `PrivacyLocalDriveProbe` |
| `13-http-router.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `13-http-router.js` | `04-permission-runtime.js` | backward | `LOG_TAIL_DEFAULT_LINES`, `LOG_TAIL_MAX_LINES`, `ToolboxHooks`, `activeChildren`, `killAllMcpClients`, `killOwnProcessTree`, `logEvent`, `makeAttachmentRecord`, `readLogTailSnapshot`, `redact`, `requestSessionExecutionStop`, `resolveExternalMcpServers`, `stopSession` |
| `13-http-router.js` | `04h-provider-http.js` | backward | `providerScrubSecrets` |
| `13-http-router.js` | `04i-provider-wire.js` | backward | `normalizeProviderApiStyle` |
| `13-http-router.js` | `05-claude-engine.js` | backward | `CLAUDE_ENDPOINT_PRESETS`, `PROVIDER_PRESETS`, `activeOpenAiProvider`, `agentCliAdapter`, `maskProviders`, `maskedSecretConflictMessage`, `maskedSecretConflicts`, `sanitizeProvider`, `unmaskProviders` |
| `13-http-router.js` | `05b-kimi-bridge.js` | backward | `applyKimiStatusToSession`, `kimiSessionStatus`, `kimiStatusFingerprint`, `kimiUsageFromStatus` |
| `13-http-router.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES`, `buildMetricsPayload`, `buildOpsMetrics`, `collectAudit`, `collectStorageStats`, `deleteUserPlaybook`, `draftPlaybookFromSession`, `getCapabilities`, `listPlaybooksWithAvailability`, `matchServiceEntry`, `maybeRecordStorageTrend`, `normalizePlaybook`, `playbookReuseSources`, `recordRequestMetric`, `saveUserPlaybook`, `storageSweep` |
| `13-http-router.js` | `06d-memory-domain.js` | backward | `MEMORY_EXCLUSION_MAX`, `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `confirmMemoryRelation`, `decideMemoryProposal`, `deleteMemory`, `deleteMemoryRelation`, `draftMemoryFromSession`, `listMemoryProjectGroups`, `listMemoryRelations`, `loadMemoryRegistry`, `memoryFailureResponse`, `migrateLegacyAccMemory`, `migrateMemory`, `moveMemoryScope`, `projectKeyForCwd`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `readMemoryItem`, `replayPendingMemoryProposal`, `resolveCoreMemoryState`, `saveMemory`, `syncAgentInstructionImports`, `validateMemoryProposalSave` |
| `13-http-router.js` | `06f-autonomy-grants.js` | backward | `activeDriverRuns`, `autonomyGrants`, `dryRunGrantFiles`, `listGrantsView`, `normalizeGrant`, `revokeAllGrants`, `revokeGrant` |
| `13-http-router.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `13-http-router.js` | `07-autonomy.js` | backward | `buildClaudeAgentDefinitions`, `fetchOpenAiModels`, `getAgentRoleLibrary`, `probeProviderCompletion`, `projectAgentRoleFile`, `projectCwdDirectoryFailure`, `readClaudeProjectAgentRoles`, `readProjectAgentRoles`, `saveProjectAgentRoles` |
| `13-http-router.js` | `08-agent-runs.js` | backward | `agentWorkflowSaveProblem`, `autoResumeInterruptedRuns`, `deleteAgentWorkflow`, `getAgentWorkflows`, `markInterruptedAgentRuns`, `normalizeAgentWorkflow`, `saveAgentWorkflow` |
| `13-http-router.js` | `10-context-governance.js` | backward | `agentConversationContextMeta`, `cachedContextLength`, `configuredConversationWindow`, `contextWindowFromTable`, `learnedWindowCap`, `resolveContextWindow`, `runAgentExternalCompact`, `runProviderCompactTracked`, `scheduleAgentWakesAtBoot`, `streamChat` |
| `13-http-router.js` | `11-native-tools.js` | backward | `killAllShellSessions`, `probeRgAsync` |
| `13-http-router.js` | `13b-api-domain-routes.js` | forward | `handleAudioApiRoutes`, `handleCheckpointApiRoutes`, `handleMcpApiRoutes`, `handleSteerApiRoute`, `maybeCompressImageAttachment`, `maybeOcrImageAttachment`, `maybeTranscribeAudioAttachment` |
| `13-http-router.js` | `13c-overlay-routes.js` | forward | `handleOverlayApiRoutes` |
| `13-http-router.js` | `13d-core-domain-routes.js` | forward | `handleAgentRunApiRoutes`, `handleInterventionApiRoutes`, `handleMissionsApiRoutes`, `handleSessionApiRoutes` |
| `13-http-router.js` | `13e-pretender-index.js` | forward | `warmPretenderProjectionIndex` |
| `13-http-router.js` | `13f-native-tool-schemas.js` | backward | `MCP_TOOLS` |
| `13-http-router.js` | `13s-scheduler.js` | forward | `handleSchedulerApiRoutes`, `startScheduler`, `stopScheduler` |
| `13aa-steward-delivery.js` | `00-boot.js` | backward | `DeliveryHooks`, `URL`, `apiFailure`, `apiSessionNotFound`, `crypto`, `fsp`, `json`, `nowIso`, `path`, `text` |
| `13aa-steward-delivery.js` | `01-config.js` | backward | `readConfig`, `safeSessionId`, `send`, `tokenOk` |
| `13aa-steward-delivery.js` | `02-session-store.js` | backward | `buildMissionAcceptanceProjection`, `kindForPath`, `loadSession`, `readMissionContainer`, `sessionDisplayTitle`, `sessionMissionId` |
| `13aa-steward-delivery.js` | `03-bridge-guard.js` | backward | `ensureDataRootReal`, `fileAllowedRoots`, `isSensitiveDataPath`, `isSensitiveHardlinkAlias`, `pathWithinAnyRoot`, `readFilePreview`, `remoteUncDenialResolved` |
| `13aa-steward-delivery.js` | `04-permission-runtime.js` | backward | `sessionExecutionSnapshot` |
| `13aa-steward-delivery.js` | `06i-steward-core.js` | backward | `StewardHooks` |
| `13aa-steward-delivery.js` | `13j-steward-tool-base.js` | backward | `stewardFail`, `stewardRawKind` |
| `13ab-privacy-api.js` | `00-boot.js` | backward | `apiFailure`, `crypto`, `json`, `nowIso`, `paths` |
| `13ab-privacy-api.js` | `01-config.js` | backward | `DurableJsonStore`, `configReadCache`, `configReadGeneration`, `mutateConfig`, `readConfig`, `safeSessionId`, `send`, `sendError` |
| `13ab-privacy-api.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `13ab-privacy-api.js` | `01i-privacy-rules.js` | backward | `PrivacyRuleCatalog` |
| `13ab-privacy-api.js` | `01m-privacy-regex.js` | backward | `PrivacyRegex` |
| `13ab-privacy-api.js` | `02-session-store.js` | backward | `loadSession`, `sessionDiskWriteSeqOf` |
| `13ab-privacy-api.js` | `02e-session-engine-route.js` | backward | `sessionEngineRouteFromConfig` |
| `13ab-privacy-api.js` | `02f-turn-effect-kinds.js` | backward | `normalizeToolInvokeArgs` |
| `13ab-privacy-api.js` | `03-bridge-guard.js` | backward | `PrivacyFileIoHooks`, `PrivacyRecipientHooks` |
| `13ab-privacy-api.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13ab-privacy-api.js` | `03b-privacy-local-drive.js` | backward | `PrivacyLocalDriveProbe` |
| `13ab-privacy-api.js` | `04-permission-runtime.js` | backward | `activeChildren`, `readLogTailSnapshot`, `turnSettlers` |
| `13ab-privacy-api.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks` |
| `13ab-privacy-api.js` | `07-autonomy.js` | backward | `nativeToolSchema` |
| `13ab-privacy-api.js` | `12-tool-dispatch.js` | backward | `planPrivacyToolDisclosure` |
| `13ab-privacy-api.js` | `13j-steward-tool-base.js` | backward | `STEWARD_MEMORY_SCHEMA`, `stewardAppendDecision`, `stewardMemoryChain`, `stewardMemoryWriteEpoch`, `stewardPanelGate`, `stewardReadMemoryStore` |
| `13ac-mcp-consumer.js` | `00-boot.js` | backward | `SessionExecutionHooks`, `VERSION`, `crypto`, `dataRoot`, `fsp`, `json`, `makeId`, `path`, `paths`, `runKeyedChain` |
| `13ac-mcp-consumer.js` | `01-config.js` | backward | `DurableJsonStore`, `RUNTIME`, `atomicWriteJson`, `commandForSelfMcp`, `configReadGeneration`, `readConfig`, `requestIsLoopback`, `safeSessionId`, `send`, `sessionWriteChains`, `tokenOk` |
| `13ac-mcp-consumer.js` | `01e-permission-modes.js` | backward | `resolvePermissionMode` |
| `13ac-mcp-consumer.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `13ac-mcp-consumer.js` | `02-session-store.js` | backward | `createSession`, `loadSession`, `saveSession`, `sessionDiskWriteSeqOf` |
| `13ac-mcp-consumer.js` | `03-bridge-guard.js` | backward | `privacyInspectLocalPath`, `withFileAccessCeiling` |
| `13ac-mcp-consumer.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13ac-mcp-consumer.js` | `04-permission-runtime.js` | backward | `activeChildren`, `recordSessionExecutionOwner`, `turnSettlers` |
| `13ac-mcp-consumer.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `13ac-mcp-consumer.js` | `07-autonomy.js` | backward | `nativeToolDisabledByPolicy`, `nativeToolGate`, `nativeToolTier` |
| `13ac-mcp-consumer.js` | `10-context-governance.js` | backward | `truncateToolResult` |
| `13ac-mcp-consumer.js` | `13f-native-tool-schemas.js` | backward | `MCP_TOOLS` |
| `13ad-memory-cli-relay.js` | `00-boot.js` | backward | `MemoryCliHooks`, `VERSION`, `crypto`, `dataRoot`, `fsp`, `http`, `json`, `path`, `paths`, `text` |
| `13ad-memory-cli-relay.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_SERVER_ID` |
| `13ad-memory-cli-relay.js` | `01-config.js` | backward | `RUNTIME`, `atomicWriteJson`, `commandForSelfMcp`, `readConfig`, `requestIsLoopback`, `safeSessionId`, `send` |
| `13ad-memory-cli-relay.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13ad-memory-cli-relay.js` | `04-permission-runtime.js` | backward | `activeChildren`, `turnSettlers` |
| `13ad-memory-cli-relay.js` | `06d-memory-domain.js` | backward | `listWorkbenchMemories`, `readWorkbenchMemory` |
| `13ad-memory-cli-relay.js` | `07-autonomy.js` | backward | `activeAgentRuns` |
| `13ad-memory-cli-relay.js` | `09-workflow.js` | backward | `AGENT_RUN_TERMINAL` |
| `13ad-memory-cli-relay.js` | `13f-native-tool-schemas.js` | backward | `MCP_TOOLS` |
| `13ae-cli-business-services.js` | `00-boot.js` | backward | `CliBusinessHooks`, `EventStreamHooks`, `apiFailure`, `apiSessionIdInvalid`, `apiSessionNotFound`, `json`, `makeId`, `nowIso` |
| `13ae-cli-business-services.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_CLI_TOOL_PREFIX` |
| `13ae-cli-business-services.js` | `01-config.js` | backward | `detectClaudePath`, `readConfig`, `safeSessionId` |
| `13ae-cli-business-services.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES`, `resolvePermissionMode` |
| `13ae-cli-business-services.js` | `02-session-store.js` | backward | `MISSION_MAX_TEXT`, `applyMissionUpdate`, `bumpMissionChangeSeq`, `evaluateMissionCheck`, `loadSession`, `maybeFinalizeMission`, `missionControlCommand`, `mutateSession`, `normalizeMission`, `normalizeTodoItems`, `recordMissionCheckResult`, `registerIntervention`, `saveSession`, `settleIntervention` |
| `13ae-cli-business-services.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf` |
| `13ae-cli-business-services.js` | `03-bridge-guard.js` | backward | `bridgedReadPathGate`, `existsExecutableAsync`, `normalizeCwd` |
| `13ae-cli-business-services.js` | `04-permission-runtime.js` | backward | `activeChildren`, `driverAutoSessions`, `logEvent`, `pendingPermissions`, `permissionWaitMs`, `requestUserQuestion`, `runAutomaticInterventionDecision` |
| `13ae-cli-business-services.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `resolveProvider` |
| `13ae-cli-business-services.js` | `06f-autonomy-grants.js` | backward | `CLI_TOOL_TIER`, `consumeGrant` |
| `13ae-cli-business-services.js` | `07-autonomy.js` | backward | `DESKTOP_MCP_SERVER_ID`, `activeAgentRuns`, `nativeToolGate`, `nativeToolTier`, `toolDisabledByPolicy`, `toolDisabledResult`, `toolIsRevertible` |
| `13ae-cli-business-services.js` | `08-agent-runs.js` | backward | `agentRunResultSlice`, `buildAgentRunEnvelope`, `resolveOrchestrateNodes`, `saveAgentRun` |
| `13ae-cli-business-services.js` | `09-workflow.js` | backward | `AGENT_RUN_TERMINAL`, `deliverAgentRunEnvelope`, `resolveWaitAgentsMs`, `runAgentWorkflow`, `settleWaitEnvelopes`, `waitForAgentRunResults` |
| `13af-internal-mcp-relay.js` | `00-boot.js` | backward | `InternalMcpHooks`, `MAX_BODY_BYTES`, `VERSION`, `crypto`, `dataRoot`, `http`, `json`, `path`, `paths`, `text` |
| `13af-internal-mcp-relay.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_SERVER_ID` |
| `13af-internal-mcp-relay.js` | `01-config.js` | backward | `RUNTIME`, `commandForSelfMcp`, `readConfig`, `requestIsLoopback`, `safeSessionId`, `send` |
| `13af-internal-mcp-relay.js` | `01c-runtime-flags.js` | backward | `observationRecallEnabled` |
| `13af-internal-mcp-relay.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13af-internal-mcp-relay.js` | `04-permission-runtime.js` | backward | `ManagedMcp`, `activeChildren`, `turnSettlers` |
| `13af-internal-mcp-relay.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `13af-internal-mcp-relay.js` | `05-claude-engine.js` | backward | `maskProviders` |
| `13af-internal-mcp-relay.js` | `06i-steward-core.js` | backward | `isStewardToolName` |
| `13af-internal-mcp-relay.js` | `07-autonomy.js` | backward | `TOOL_PACK_DESCRIPTIONS`, `activeAgentRuns`, `nativeToolAvailableInContext`, `toolPackForName` |
| `13af-internal-mcp-relay.js` | `09-workflow.js` | backward | `AGENT_RUN_TERMINAL` |
| `13af-internal-mcp-relay.js` | `10-context-governance.js` | backward | `truncateToolResult` |
| `13af-internal-mcp-relay.js` | `13ae-cli-business-services.js` | backward | `cliAgentLaunchService`, `cliAgentResultService`, `cliMissionService`, `cliPermissionService`, `cliQuestionService`, `cliTodoService` |
| `13af-internal-mcp-relay.js` | `13f-native-tool-schemas.js` | backward | `MCP_TOOLS` |
| `13b-api-domain-routes.js` | `00-boot.js` | backward | `ASR_MAX_BODY_BYTES`, `MigrationHooks`, `URL`, `apiFailure`, `apiSessionIdInvalid`, `appendUsageLedger`, `computeProviderCost`, `crypto`, `fsp`, `json`, `nowIso`, `os`, `path`, `paths`, `safeJsonParse`, `text` |
| `13b-api-domain-routes.js` | `01-config.js` | backward | `buildUserEnvelope`, `generateMcpConfig`, `mutateConfig`, `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `writeToChild` |
| `13b-api-domain-routes.js` | `02-session-store.js` | backward | `bumpMissionChangeSeq`, `journalRevertLogRecord`, `journalRollback`, `mutateSession`, `rewindSession`, `saveSession` |
| `13b-api-domain-routes.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13b-api-domain-routes.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `ToolboxHooks`, `activeChildren`, `buildMcpConnectorInventory`, `collectBridgedTools`, `getBridgedClient`, `hasPendingQuestionForSession`, `invalidateMcpRuntime`, `logEvent`, `mutateMcpConnector`, `probeMcpConnector`, `redact`, `resolveBridge`, `resolveExternalMcpServers`, `sanitizeFsSegmentName`, `scanMcpSources` |
| `13b-api-domain-routes.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `13b-api-domain-routes.js` | `04j-voice-learn.js` | backward | `VoiceLearn` |
| `13b-api-domain-routes.js` | `04j-voice-lexicon.js` | backward | `VoiceLexicon` |
| `13b-api-domain-routes.js` | `05-claude-engine.js` | backward | `activeOpenAiProvider`, `asrFixMessages`, `asrFixModeOf`, `asrFixSanity`, `maskExternalMcpServerForDisplay`, `providerFixCompletion`, `resolveAsrFixProvider`, `resolveAsrProvider`, `resolveAsrStreamProvider`, `sanitizeExternalMcpServer`, `transcribeAudioViaProvider`, `voiceLexiconAsrPromptFor`, `voiceLexiconRead`, `voiceLexiconUpdate` |
| `13b-api-domain-routes.js` | `06-provider-engine.js` | backward | `normalizeStoragePolicy`, `storageSweep` |
| `13b-api-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX`, `activeAgentRuns` |
| `13c-overlay-routes.js` | `00-boot.js` | backward | `cp`, `crypto`, `dataRoot`, `decodeConsoleText`, `externalRoot`, `fs`, `fsp`, `json`, `path` |
| `13c-overlay-routes.js` | `01-config.js` | backward | `readJsonBody`, `send`, `tokenOk` |
| `13c-overlay-routes.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13d-core-domain-routes.js` | `00-boot.js` | backward | `CliBusinessHooks`, `EventStreamHooks`, `ProxyModelHooks`, `RUYI_EVENTS`, `URL`, `apiFailure`, `apiSessionIdInvalid`, `apiSessionNotFound`, `crypto`, `dataRootAliases`, `fsp`, `json`, `makeId`, `nowIso`, `os`, `path`, `paths`, `runKeyedChain`, `safeDecodeURIComponent`, `text` |
| `13d-core-domain-routes.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `tokenMatches`, `tokenOk` |
| `13d-core-domain-routes.js` | `01c-runtime-flags.js` | backward | `sessionSearchIndexEnabled` |
| `13d-core-domain-routes.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `resolvePermissionMode` |
| `13d-core-domain-routes.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13d-core-domain-routes.js` | `01q-work-data-records.js` | backward | `WorkDataRecords` |
| `13d-core-domain-routes.js` | `02-session-store.js` | backward | `buildMissionAcceptanceProjection`, `bulkDeleteUnpinnedSessions`, `bumpMissionChangeSeq`, `compactInterventionJournal`, `createMissionContainer`, `createSession`, `deleteSession`, `detectDanglingTurn`, `foldTurnSummaries`, `journalReadIndex`, `listMissionContainers`, `listSessions`, `loadSession`, `missionAttachThread`, `missionContainerAcceptanceStamp`, `missionControlCommand`, `missionControlView`, `missionDetachThread`, `missionMergeInto`, `missionSplitThreads`, `patchMissionContainer`, `readInterventions`, `readMissionChangesWithMeta`, `readMissionContainer`, `readMissionSessionHead`, `readSessionHeadResilient`, `readSessionHeadText`, `sessionBodyPaths`, `sessionBriefOf`, `sessionDisplayTitle`, `sessionHeadIsWorkDataError`, `sessionKind`, `sessionMessagesDelta`, `sessionMeta`, `sessionMissionId`, `sessionOmittedProviderHistory`, `sessionProviderHistoryLength`, `transitionInterventionState`, `updateSessionMeta` |
| `13d-core-domain-routes.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf`, `sessionDesktopToolsOverrides`, `sessionPermissionModeOverrides` |
| `13d-core-domain-routes.js` | `03-bridge-guard.js` | backward | `normalizeCwd`, `pathWithinRoot`, `resolveContainmentPath` |
| `13d-core-domain-routes.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13d-core-domain-routes.js` | `04-permission-runtime.js` | backward | `activeChildren`, `extendUserQuestion`, `logEvent`, `normalizeQuestionAnswer`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `redact`, `sessionExecutionObservation`, `sessionExecutionSnapshot`, `turnSettlers` |
| `13d-core-domain-routes.js` | `06h-retrieval-index.js` | backward | `createRetrievalCorpusCache`, `rankRetrievalCorpus`, `retrievalTerms` |
| `13d-core-domain-routes.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `aggregateMissionState`, `deriveStewardThreadState`, `stewardRuyiOwnedPath`, `stewardSanitizeText`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardThreadStateRank`, `stewardThreadTurnQueued`, `waitReasonFor` |
| `13d-core-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX`, `activeAgentRuns`, `agentRunFile`, `applyAgentWorktree`, `cleanupAgentWorktree`, `getAgentRoleLibrary`, `readAgentRunSnapshot` |
| `13d-core-domain-routes.js` | `08-agent-runs.js` | backward | `agentRunDigestCache`, `agentRunDigestRow`, `agentRunDigestWriteSeq`, `agentRunEventsFile`, `agentRunHealth`, `appendAgentRunEvent`, `bumpRunIntervention`, `computeWaveSeq`, `listAgentRunDigests`, `listAgentRuns`, `materializePoolItem`, `nodeDeliveryEligibility`, `readAgentRunEvents`, `saveAgentRun` |
| `13d-core-domain-routes.js` | `09-workflow.js` | backward | `launchPersistedAgentRun` |
| `13d-core-domain-routes.js` | `09b-replan-ledger.js` | backward | `applyReplanPatch` |
| `13d-core-domain-routes.js` | `13e-pretender-index.js` | forward | `emptyMissionUsage`, `getPretenderProjectionIndex`, `overlayMissionCard`, `paginatePretenderProjection`, `pretenderEtag`, `pretenderHash`, `pretenderIndexMeta`, `pretenderIndexRuntime`, `pretenderLiveOverlayRevision`, `pretenderNotModified` |
| `13e-pretender-index.js` | `00-boot.js` | backward | `EventStreamHooks`, `URL`, `apiFailure`, `crypto`, `forEachUsageRow`, `fs`, `fsp`, `nowIso`, `path`, `paths`, `safeJsonParse`, `usageLedgerChangesSince` |
| `13e-pretender-index.js` | `01-config.js` | backward | `THREAD_INDEX_RECENT_DEFAULT`, `THREAD_INDEX_RECENT_MAX`, `THREAD_INDEX_RECENT_MIN`, `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath`, `sessionsDirOwnWriteSeq` |
| `13e-pretender-index.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13e-pretender-index.js` | `02-session-store.js` | backward | `compactInterventionJournal`, `interventionFilePath`, `interventionJournalWorthCompacting`, `readInterventionsWithMeta`, `readSessionHeadText`, `sessionKind`, `sessionMissionId` |
| `13e-pretender-index.js` | `04-permission-runtime.js` | backward | `activeChildren`, `sessionExecutionSnapshot` |
| `13e-pretender-index.js` | `06i-steward-core.js` | backward | `stewardAsksYouForThread`, `stewardThreadTurnQueued`, `stewardWatchedThread`, `threadOriginOf`, `threadVisible` |
| `13e-pretender-index.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `agentRunDir`, `agentRunSnapshotStamp`, `readAgentRunSnapshot` |
| `13e-pretender-index.js` | `08-agent-runs.js` | backward | `agentRunHealth`, `listAgentRuns` |
| `13e-pretender-index.js` | `13d-core-domain-routes.js` | backward | `buildMissionCard`, `missionRunDigest` |
| `13f-native-tool-schemas.js` | `07-autonomy.js` | backward | `adaptiveMetaToolSchemas` |
| `13g-steward.js` | `00-boot.js` | backward | `ExternalBotHooks`, `URL`, `apiFailure`, `json`, `nowIso`, `text` |
| `13g-steward.js` | `01-config.js` | backward | `readConfig`, `readJsonBody`, `send`, `tokenOk` |
| `13g-steward.js` | `02-session-store.js` | backward | `loadSession` |
| `13g-steward.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13g-steward.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13g-steward.js` | `06d-memory-domain.js` | backward | `memoryIsExpired`, `memoryProposalLooksSensitive` |
| `13g-steward.js` | `06i-steward-core.js` | backward | `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_PREROUTE_QUERY_MAX`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardSanitizeText` |
| `13g-steward.js` | `07-autonomy.js` | backward | `nativeToolSchema` |
| `13g-steward.js` | `13i-steward-inbox.js` | backward | `startStewardInbox`, `stewardInboxRead`, `stewardInboxState`, `stopStewardInbox` |
| `13g-steward.js` | `13j-steward-tool-base.js` | backward | `STEWARD_MEMORY_NEW_WINDOW_MS`, `STEWARD_MEMORY_SCHEMA`, `stewardAppendDecision`, `stewardDecisionsRead`, `stewardFail`, `stewardMemoryScopeLabel`, `stewardMutateMemory`, `stewardPanelGate`, `stewardPreflightDecision`, `stewardQuickClosed`, `stewardReadMemoryStore`, `stewardTurnTaintedBy` |
| `13g-steward.js` | `13k-steward-threads.js` | backward | `stewardEnrichInboxRows`, `stewardImplQuickAsk`, `stewardImplThreadContinue`, `stewardImplThreadNew`, `stewardImplThreadNote`, `stewardImplThreadPermission`, `stewardImplThreadRead`, `stewardImplThreadRename`, `stewardImplThreadStatus`, `stewardImplThreadWorkspace`, `stewardImplThreadsSearch`, `stewardQuickClose`, `threadRelatedThreads`, `threadRelationsIndex` |
| `13g-steward.js` | `13l-steward-ops.js` | backward | `stewardImplAuditTail`, `stewardImplConfigGet`, `stewardImplConfigSet`, `stewardImplDecide`, `stewardImplFileRead`, `stewardImplHealth`, `stewardImplInboxRead`, `stewardImplMemorySearch`, `stewardImplMemoryVeto`, `stewardImplMemoryWrite`, `stewardImplMissions`, `stewardImplNotify`, `stewardImplPlaybookDraft`, `stewardImplPlaybooks`, `stewardImplProviders`, `stewardImplRunAction`, `stewardImplRunsStatus`, `stewardImplSelfStatus`, `stewardImplSkillToggle`, `stewardImplSkills`, `stewardImplThreadArtifactRead`, `stewardImplUsage`, `stewardImplWebFetch`, `stewardImplWebSearch` |
| `13h-steward-runner.js` | `00-boot.js` | backward | `SessionExecutionHooks`, `apiFailure`, `json`, `nowIso` |
| `13h-steward-runner.js` | `01-config.js` | backward | `readConfig`, `readJsonBody`, `safeSessionId`, `send`, `tokenOk` |
| `13h-steward-runner.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13h-steward-runner.js` | `04-permission-runtime.js` | backward | `requestSessionExecutionStop` |
| `13h-steward-runner.js` | `06f-autonomy-grants.js` | backward | `revokeAllGrants` |
| `13h-steward-runner.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardSanitizeText`, `waitReasonFor` |
| `13h-steward-runner.js` | `13g-steward.js` | backward | `stewardToolHandler` |
| `13h-steward-runner.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardBasisOf`, `stewardFail`, `stewardPreflightDecision`, `stewardRawKind`, `stewardReadSessionHead`, `stewardThreadPermissionMode` |
| `13h-steward-runner.js` | `13m-steward-runner-base.js` | backward | `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS`, `ensureStewardSession`, `stewardResumeRunner`, `stewardRunnerRuntime`, `stewardStopRunner` |
| `13h-steward-runner.js` | `13n-steward-arbiter.js` | backward | `stewardAcquireTurnSlot`, `stewardArbiterPrioritize`, `stewardArbiterRefresh`, `stewardArbiterState`, `stewardArbiterWait`, `stewardCancelQueuedTurn` |
| `13h-steward-runner.js` | `13o-steward-runner-prompt.js` | backward | `buildStewardSystemPrompt`, `stewardContextBudget`, `stewardPreroute`, `stewardVisitNotesPrompt` |
| `13h-steward-runner.js` | `13p-steward-runner-actions.js` | backward | `stewardDayCost`, `stewardRecoveryEvents`, `stewardTurnsInWindow` |
| `13h-steward-runner.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn`, `stewardApplyThreadTier`, `stewardOnInboxBatch`, `stewardRelayChannelFor`, `stewardRelayDeliver`, `stewardResetConversation`, `stewardRunAct`, `stewardVisit` |
| `13i-steward-inbox.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `WorkDataRootHooks`, `crypto`, `fsp`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `13i-steward-inbox.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `13i-steward-inbox.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13i-steward-inbox.js` | `01s-work-data-journals.js` | backward | `WorkDataJournals` |
| `13i-steward-inbox.js` | `02-session-store.js` | backward | `readMissionChangesWithMeta`, `readSessionHeadResilient`, `repairMissionChangeTornTail` |
| `13i-steward-inbox.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent`, `turnOutcomePending`, `turnSettlers` |
| `13i-steward-inbox.js` | `06i-steward-core.js` | backward | `STEWARD_EVENT_KINDS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardCoveringLastTurn`, `stewardSanitizeText`, `stewardWatchedThread` |
| `13i-steward-inbox.js` | `07-autonomy.js` | backward | `activeAgentRuns` |
| `13i-steward-inbox.js` | `08-agent-runs.js` | backward | `listAgentRuns`, `readAgentRunEvents` |
| `13i-steward-inbox.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13j-steward-tool-base.js` | `00-boot.js` | backward | `WorkDataRootHooks`, `apiFailure`, `fsp`, `nowIso`, `path`, `safeJsonParse`, `text` |
| `13j-steward-tool-base.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `readFileTail`, `safeSessionId`, `tokenOk` |
| `13j-steward-tool-base.js` | `01e-permission-modes.js` | backward | `resolvePermissionMode` |
| `13j-steward-tool-base.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13j-steward-tool-base.js` | `01s-work-data-journals.js` | backward | `WorkDataJournals` |
| `13j-steward-tool-base.js` | `02-session-store.js` | backward | `foldTurnSummaries`, `readSessionHeadResilient`, `repairMissionChangeTornTail` |
| `13j-steward-tool-base.js` | `02d-session-overrides.js` | backward | `applySessionPermissionModeOverride` |
| `13j-steward-tool-base.js` | `04-permission-runtime.js` | backward | `logEvent` |
| `13j-steward-tool-base.js` | `06d-memory-domain.js` | backward | `cleanMemoryDate`, `projectKeyForCwd` |
| `13j-steward-tool-base.js` | `06i-steward-core.js` | backward | `STEWARD_CONFIG_SECRET_PATTERN`, `STEWARD_EXEMPT_DELEGATION_WINDOW_MS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_NOTIFY_WINDOW_MS`, `StewardHooks`, `stewardSanitizeText` |
| `13j-steward-tool-base.js` | `10-context-governance.js` | backward | `providerTurnQuotaKey` |
| `13j-steward-tool-base.js` | `13i-steward-inbox.js` | backward | `stewardDir` |
| `13k-steward-threads.js` | `00-boot.js` | backward | `EventStreamHooks`, `ExternalBotHooks`, `dataRoot`, `dataRootAliases`, `decodeTextFileBytes`, `fsp`, `nowIso`, `path`, `paths`, `text` |
| `13k-steward-threads.js` | `01-config.js` | backward | `mutateConfig`, `normalizeWorkspacePathString`, `safeSessionId` |
| `13k-steward-threads.js` | `01c-runtime-flags.js` | backward | `sessionSearchIndexEnabled` |
| `13k-steward-threads.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `13k-steward-threads.js` | `02-session-store.js` | backward | `SESSION_BRIEF_TITLE_CHARS`, `createSession`, `isUntitledSessionTitle`, `listSessions`, `loadSession`, `missionIndexAdd`, `readInterventions`, `readMissionContainer`, `saveSession`, `sessionBriefOf`, `sessionDisplayTitle`, `sessionMeta`, `sessionMetaIsSteward`, `sessionMissionId`, `updateSessionMeta`, `withMissionContainerLock`, `writeMissionContainer` |
| `13k-steward-threads.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf`, `sessionPermissionModeOf` |
| `13k-steward-threads.js` | `03-bridge-guard.js` | backward | `pathWithinRoot`, `realpathForContainment` |
| `13k-steward-threads.js` | `04-permission-runtime.js` | backward | `PermissionWaitHooks`, `activeChildren`, `logEvent`, `redact`, `sanitizeFsSegmentName`, `sessionExecutionSnapshot` |
| `13k-steward-threads.js` | `06-provider-engine.js` | backward | `listPlaybooksWithAvailability` |
| `13k-steward-threads.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13k-steward-threads.js` | `06d-memory-domain.js` | backward | `memoryIsExpired` |
| `13k-steward-threads.js` | `06i-steward-core.js` | backward | `STEWARD_ANSWER_BASIS`, `STEWARD_DELIVERABLE_CHARS`, `STEWARD_EXEMPT_INPUT_CHARS`, `STEWARD_QUICK_ANSWER_CHARS`, `STEWARD_QUICK_KIND`, `STEWARD_QUICK_QUESTION_CHARS`, `STEWARD_SESSION_ID`, `STEWARD_WORKSPACE_TABLE_MAX`, `StewardHooks`, `buildStewardBrief`, `deriveStewardThreadState`, `stewardAsksYouForThread`, `stewardAssemblePlaybookPrompt`, `stewardClipSay`, `stewardExemptExcerpt`, `stewardExemptHits`, `stewardExemptInputText`, `stewardExemptScanInput`, `stewardForeignProjection`, `stewardMayAct`, `stewardMayTightenTo`, `stewardOpenAiFallback`, `stewardPendingOneLine`, `stewardPermissionLabel`, `stewardPlaybookMissingInputs`, `stewardRuyiOwnedPath`, `stewardSamePath`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardTurnTaint`, `stewardWatchedThread`, `stewardWorkspaceLabels`, `stewardWorkspaceRootFor`, `threadOriginOf`, `waitReasonFor` |
| `13k-steward-threads.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13k-steward-threads.js` | `13b-api-domain-routes.js` | backward | `steerSessionCore` |
| `13k-steward-threads.js` | `13d-core-domain-routes.js` | backward | `SESSION_SEARCH_MIN_QUERY`, `buildMissionAggregateRows`, `missionPendingCounts`, `searchSessionsByContent`, `sessionSearchScope` |
| `13k-steward-threads.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `overlayMissionCard` |
| `13k-steward-threads.js` | `13j-steward-tool-base.js` | backward | `STEWARD_NOTE_PREFIX`, `STEWARD_NOTE_TEXT_MAX`, `STEWARD_PENDING_SUMMARY_MAX`, `STEWARD_QUICK_ASKS_PER_TURN`, `STEWARD_READ_CHARS_DEFAULT`, `STEWARD_READ_CHARS_MAX`, `STEWARD_READ_CHARS_MIN`, `STEWARD_READ_CLIP_MARK`, `STEWARD_READ_ROW_OVERHEAD`, `STEWARD_READ_TAIL_DEFAULT`, `STEWARD_READ_TAIL_MAX`, `STEWARD_SEARCH_LIMIT_DEFAULT`, `STEWARD_SEARCH_LIMIT_MAX`, `STEWARD_TITLE_MAX`, `stewardAppendDecision`, `stewardBasisOf`, `stewardClampInt`, `stewardDisplayKind`, `stewardEngineOf`, `stewardFail`, `stewardLastAssistantText`, `stewardQuickClosed`, `stewardQuickThread`, `stewardRawKind`, `stewardReadBucket`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnAssistantText`, `stewardTurnFiles`, `stewardTurnKeyOf`, `stewardTurnQuotaTake`, `stewardTurnTaintedBy` |
| `13l-steward-ops.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `forEachUsageRow`, `makeId`, `nowIso`, `path`, `text`, `usageDayKey`, `usageDayKeyMemo` |
| `13l-steward-ops.js` | `01-config.js` | backward | `ConfigPatchHooks`, `normalizeConfig`, `safeSessionId` |
| `13l-steward-ops.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES_REQUIRING_CONFIRM` |
| `13l-steward-ops.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `13l-steward-ops.js` | `02-session-store.js` | backward | `loadSession`, `readInterventions` |
| `13l-steward-ops.js` | `03-bridge-guard.js` | backward | `pathWithinRoot`, `realpathForContainment` |
| `13l-steward-ops.js` | `04-permission-runtime.js` | backward | `redact` |
| `13l-steward-ops.js` | `05-claude-engine.js` | backward | `KEY_MASK_PREFIX`, `maskProviders`, `maskedSecretConflictMessage`, `maskedSecretConflicts`, `unmaskSecrets` |
| `13l-steward-ops.js` | `06-provider-engine.js` | backward | `collectAudit`, `draftPlaybookFromSession`, `listPlaybooksWithAvailability`, `playbookReuseSources` |
| `13l-steward-ops.js` | `06d-memory-domain.js` | backward | `cleanMemoryDate`, `memoryIsExpired`, `memoryProposalLooksSensitive` |
| `13l-steward-ops.js` | `06i-steward-core.js` | backward | `STEWARD_CATALOG_DESC_CHARS`, `STEWARD_CATALOG_ROWS`, `STEWARD_EXEMPT_CATEGORY_LABELS`, `STEWARD_EYES_CHARS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_NOTIFY_KINDS`, `STEWARD_NOTIFY_TEXT_CHARS`, `STEWARD_SESSION_ID`, `isStewardToolName`, `stewardAutoAskIndirect`, `stewardAutoAskScanIncomplete`, `stewardAutoAskSensitiveKind`, `stewardConfigHelpFor`, `stewardConfigTierFor`, `stewardExemptDelegationVerdict`, `stewardExemptHits`, `stewardExemptReason`, `stewardExemptRiskNote`, `stewardExemptScanInput`, `stewardForeignProjection`, `stewardMayAct`, `stewardMemoryTerms`, `stewardPermissionLabel`, `stewardPermissionRank`, `stewardSamePath`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStateLabel`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardTermJaccard`, `stewardThreadArtifactFiles`, `stewardWatchedThread`, `stewardWorkspaceRootFor`, `threadOriginOf` |
| `13l-steward-ops.js` | `07-autonomy.js` | backward | `activeAgentRuns`, `httpRequestInternalTargetReason`, `readAgentRunSnapshot`, `webPayloadReason` |
| `13l-steward-ops.js` | `08-agent-runs.js` | backward | `agentRunPermissionMode`, `classifyRunResumeTier`, `listAgentRuns` |
| `13l-steward-ops.js` | `11-native-tools.js` | backward | `privacySourceMark`, `privacySourceViews` |
| `13l-steward-ops.js` | `12-tool-dispatch.js` | backward | `buildWorkbenchSelfStatus` |
| `13l-steward-ops.js` | `13-http-router.js` | backward | `setSessionSkillsCore` |
| `13l-steward-ops.js` | `13d-core-domain-routes.js` | backward | `agentRunActionCommand`, `buildMissionAggregateRows`, `decideIntervention`, `missionRunDigest` |
| `13l-steward-ops.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13l-steward-ops.js` | `13i-steward-inbox.js` | backward | `stewardInboxPendingState`, `stewardInboxRead`, `stewardInboxState` |
| `13l-steward-ops.js` | `13j-steward-tool-base.js` | backward | `STEWARD_AUDIT_LIMIT_DEFAULT`, `STEWARD_AUDIT_LIMIT_MAX`, `STEWARD_MEMORY_MERGED_FROM_MAX`, `STEWARD_MISSIONS_LIMIT_DEFAULT`, `STEWARD_MISSIONS_LIMIT_MAX`, `STEWARD_PLAYBOOK_DRAFTS_PER_TURN`, `STEWARD_RUNS_MAX`, `STEWARD_STEER_TEXT_MAX`, `stewardAppendDecision`, `stewardBasisOf`, `stewardClampInt`, `stewardExemptDelegationRecord`, `stewardExemptDelegationsInWindow`, `stewardFail`, `stewardMarkTurnTainted`, `stewardMemoryScopeMatches`, `stewardMemoryScopeOf`, `stewardMutateMemory`, `stewardNormalizeMemoryScope`, `stewardNotifiesInWindow`, `stewardNotifyRecord`, `stewardRawKind`, `stewardReadBucket`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnKeyOf`, `stewardTurnQuotaRefund`, `stewardTurnQuotaTake`, `stewardTurnTaintedBy` |
| `13l-steward-ops.js` | `13k-steward-threads.js` | backward | `stewardExemptDelegatedLog`, `stewardExemptLiveTurn`, `stewardExemptPendingSummary`, `stewardKnownWorkspaces`, `stewardLiveTurnPermissionMode`, `stewardSeatedByUser`, `stewardSeatedFail`, `stewardToolCallLine`, `stewardToolCallVerdict`, `stewardUserDirected`, `stewardWorkspaceNameOf` |
| `13m-steward-runner-base.js` | `00-boot.js` | backward | `SESSION_SCHEMA`, `nowIso`, `paths` |
| `13m-steward-runner-base.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES`, `normalizeAgentCliType` |
| `13m-steward-runner-base.js` | `02-session-store.js` | backward | `loadSession`, `saveSession` |
| `13m-steward-runner-base.js` | `02e-session-engine-route.js` | backward | `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `13m-steward-runner-base.js` | `04-permission-runtime.js` | backward | `logEvent`, `stopSession` |
| `13m-steward-runner-base.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES` |
| `13m-steward-runner-base.js` | `06i-steward-core.js` | backward | `STEWARD_PERMISSION_MODE`, `STEWARD_SESSION_ID`, `STEWARD_SESSION_TITLE`, `stewardSanitizeText` |
| `13n-steward-arbiter.js` | `00-boot.js` | backward | `OVERLAY_ID`, `RUYI_EVENTS`, `crypto`, `forEachUsageRow`, `fs`, `path`, `usageDayKey`, `usageDayKeyMemo`, `usageRangeLowerMs` |
| `13n-steward-arbiter.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13n-steward-arbiter.js` | `02-session-store.js` | backward | `readInterventions`, `recordMissionBudgetTrippedChange` |
| `13n-steward-arbiter.js` | `04-permission-runtime.js` | backward | `assertSessionExecutionOwner`, `logEvent`, `turnSettlers` |
| `13n-steward-arbiter.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `stewardSanitizeText`, `waitReasonFor` |
| `13n-steward-arbiter.js` | `13m-steward-runner-base.js` | backward | `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS` |
| `13o-steward-runner-prompt.js` | `00-boot.js` | backward | `fsp`, `path`, `text` |
| `13o-steward-runner-prompt.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13o-steward-runner-prompt.js` | `02-session-store.js` | backward | `listSessions`, `readMissionContainer`, `sessionDisplayTitle`, `sessionMeta`, `sessionMetaIsSteward`, `sessionMissionId` |
| `13o-steward-runner-prompt.js` | `02d-session-overrides.js` | backward | `applySessionPermissionModeOverride` |
| `13o-steward-runner-prompt.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent`, `redact` |
| `13o-steward-runner-prompt.js` | `06-provider-engine.js` | backward | `buildModelIdentityPrompt` |
| `13o-steward-runner-prompt.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13o-steward-runner-prompt.js` | `06d-memory-domain.js` | backward | `memoryIsExpired` |
| `13o-steward-runner-prompt.js` | `06i-steward-core.js` | backward | `STEWARD_DIGEST_LIMITS`, `STEWARD_KNOWN_WORKSPACE_LIMITS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_SESSION_ID`, `STEWARD_WORKSPACE_TABLE_MAX`, `StewardHooks`, `buildStewardDigestLine`, `isStewardToolName`, `prerouteText`, `stewardActConfirmSpec`, `stewardForeignProjection`, `stewardSanitizeText`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardTrimSayAtSentence`, `stewardWatchedThread`, `waitReasonFor` |
| `13o-steward-runner-prompt.js` | `06j-scheduler-core.js` | backward | `normalizeSchedulerTask` |
| `13o-steward-runner-prompt.js` | `07-autonomy.js` | backward | `nativeToolSchema` |
| `13o-steward-runner-prompt.js` | `08-agent-runs.js` | backward | `parseStructuredAgentOutput` |
| `13o-steward-runner-prompt.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `overlayMissionCard` |
| `13o-steward-runner-prompt.js` | `13j-steward-tool-base.js` | backward | `stewardMemoryScopeLabel`, `stewardQuickThread`, `stewardRawKind`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode` |
| `13o-steward-runner-prompt.js` | `13k-steward-threads.js` | backward | `stewardCanonWorkspacePath`, `stewardFoldWorkspacePath`, `stewardKnownWorkspaces`, `stewardSeatedByUser`, `stewardThreadDisplayTitle` |
| `13o-steward-runner-prompt.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_ACT_CONFIRM_LABEL_MAX`, `STEWARD_ACT_CONFIRM_VALUE_CHARS`, `STEWARD_ACT_LABEL_MAX`, `STEWARD_DECIDE_LABELS`, `STEWARD_MEMORY_BLOCK_CHARS`, `STEWARD_MEMORY_VETOED_BLOCK_CHARS`, `STEWARD_MEMORY_VETOED_MAX`, `STEWARD_RUN_ACTION_LABELS`, `STEWARD_SAY_CEILING`, `STEWARD_TOOL_LABELS`, `STEWARD_WHY_MAX`, `stewardRunnerRuntime` |
| `13o-steward-runner-prompt.js` | `13n-steward-arbiter.js` | backward | `stewardArbiterWait` |
| `13p-steward-runner-actions.js` | `00-boot.js` | backward | `crypto`, `forEachUsageRow`, `nowIso`, `text`, `usageDayKey`, `usageDayKeyMemo`, `usageRangeLowerMs` |
| `13p-steward-runner-actions.js` | `01-config.js` | backward | `configValueEquals`, `safeSessionId` |
| `13p-steward-runner-actions.js` | `02-session-store.js` | backward | `SESSION_LOAD_OMIT_PROVIDER`, `detectDanglingTurn`, `loadSession`, `mutateSession`, `readInterventions`, `sessionDisplayTitle`, `sessionTodosSignature` |
| `13p-steward-runner-actions.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent`, `turnOutcomePending`, `turnSettlers` |
| `13p-steward-runner-actions.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13p-steward-runner-actions.js` | `06i-steward-core.js` | backward | `STEWARD_ANSWER_BASIS`, `STEWARD_EXEMPT_CATEGORY_LABELS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardActConfirmSpec`, `stewardAsksYouForThread`, `stewardForeignProjection`, `stewardHumanizeIds`, `stewardMayAct`, `stewardPermissionLabel`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardWatchedThread` |
| `13p-steward-runner-actions.js` | `13g-steward.js` | backward | `stewardAuthorizeExternalContext`, `stewardExternalOwnerDirected` |
| `13p-steward-runner-actions.js` | `13i-steward-inbox.js` | backward | `stewardThreadBackgroundBusy` |
| `13p-steward-runner-actions.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardFail`, `stewardLastAssistantText`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnTaintedBy` |
| `13p-steward-runner-actions.js` | `13k-steward-threads.js` | backward | `stewardSeatedByUser` |
| `13p-steward-runner-actions.js` | `13l-steward-ops.js` | backward | `stewardReadRunSnapshot`, `stewardRunResumeTier` |
| `13p-steward-runner-actions.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_ACT_LABEL_MAX`, `STEWARD_CONTINUE_FRESH_MS`, `STEWARD_CONTINUE_PROMPT`, `STEWARD_INBOX_DELIVERABLE_CHARS`, `STEWARD_INBOX_EVENTS_PER_TURN`, `STEWARD_INBOX_EVENT_CHARS`, `STEWARD_INBOX_MESSAGE_CHARS`, `STEWARD_SELF_SERVE_ATTEMPT_MAX`, `STEWARD_SELF_SERVE_RETRY_WINDOW_MS`, `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS`, `stewardFailureExplain`, `stewardRunnerRuntime` |
| `13p-steward-runner-actions.js` | `13o-steward-runner-prompt.js` | backward | `stewardActConfirmLines`, `stewardActLabel`, `stewardNormalizeAct`, `stewardThreadDigestRows` |
| `13q-steward-runner-turn.js` | `00-boot.js` | backward | `OVERLAY_ID`, `RUYI_EVENTS`, `crypto`, `fsp`, `makeId`, `nowIso`, `path`, `runKeyedChain` |
| `13q-steward-runner-turn.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `13q-steward-runner-turn.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13q-steward-runner-turn.js` | `02-session-store.js` | backward | `loadSession`, `mutateSession`, `readSessionNotes`, `waitMissionTurnSettled`, `writeSessionNotes` |
| `13q-steward-runner-turn.js` | `02e-session-engine-route.js` | backward | `normalizeSessionEngineRoute` |
| `13q-steward-runner-turn.js` | `04-permission-runtime.js` | backward | `activeChildren`, `logEvent`, `normalizeQuestionAnswer`, `pendingPermissions`, `pendingQuestions`, `promptDeadlineIsReal`, `stopSession`, `turnSettlers` |
| `13q-steward-runner-turn.js` | `06i-steward-core.js` | backward | `STEWARD_DIGEST_LIMITS`, `STEWARD_EVENT_KINDS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardOpenAiFallback`, `stewardPendingOneLine`, `stewardSanitizeText`, `stewardThreadEngineRoute`, `waitReasonFor` |
| `13q-steward-runner-turn.js` | `06j-scheduler-core.js` | backward | `SchedulerHooks` |
| `13q-steward-runner-turn.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13q-steward-runner-turn.js` | `13b-api-domain-routes.js` | backward | `steerSessionCore` |
| `13q-steward-runner-turn.js` | `13d-core-domain-routes.js` | backward | `decideIntervention` |
| `13q-steward-runner-turn.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13q-steward-runner-turn.js` | `13g-steward.js` | backward | `stewardAuthorizeExternalContext` |
| `13q-steward-runner-turn.js` | `13i-steward-inbox.js` | backward | `stewardDir`, `stewardInboxRead`, `stewardPendingKeyOf`, `stewardPendingStillOpen`, `stewardPresenceRows`, `stewardViewingSessionIds` |
| `13q-steward-runner-turn.js` | `13j-steward-tool-base.js` | backward | `_stewardReadBudget`, `stewardFail`, `stewardReadSessionHead` |
| `13q-steward-runner-turn.js` | `13k-steward-threads.js` | backward | `stewardErrorDetail`, `stewardLaunchingTurns`, `stewardMediatesPermissions` |
| `13q-steward-runner-turn.js` | `13l-steward-ops.js` | backward | `stewardDecideAttempted` |
| `13q-steward-runner-turn.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_BLOCKING_DEBOUNCE_MS`, `STEWARD_DEBOUNCE_MS`, `STEWARD_DIGEST_KIND_TEXT`, `STEWARD_INBOX_EVENTS_PER_TURN`, `STEWARD_PENDING_LIST_MAX`, `STEWARD_PREEMPT_WAIT_MS`, `STEWARD_QUICK_DEBOUNCE_MS`, `STEWARD_TOOL_LABELS`, `STEWARD_USER_QUEUE_WAIT_MS`, `STEWARD_VIEW_HELD_MAX`, `STEWARD_VIEW_RECHECK_MS`, `STEWARD_VISITS_DIR`, `STEWARD_VISITS_KEEP`, `STEWARD_VISIT_DIGEST_MAX`, `STEWARD_VISIT_SCHEMA`, `ensureStewardSession`, `stewardAbortInflight`, `stewardRunnerRuntime` |
| `13q-steward-runner-turn.js` | `13n-steward-arbiter.js` | backward | `stewardArbiterWait` |
| `13q-steward-runner-turn.js` | `13o-steward-runner-prompt.js` | backward | `stewardParseReply`, `stewardThreadDigestRows` |
| `13q-steward-runner-turn.js` | `13p-steward-runner-actions.js` | backward | `stewardCircuitCheck`, `stewardDowngradeActions`, `stewardExecuteActions`, `stewardHumanizeSay`, `stewardInboxMessage`, `stewardLastAssistantContent`, `stewardLastAssistantFinalSegment`, `stewardNormalizeRouteHint`, `stewardSelfServeInbox`, `stewardStampReply`, `stewardTriggerStamp` |
| `13r-event-stream.js` | `00-boot.js` | backward | `EventStreamHooks`, `OVERLAY_ID`, `RUYI_EVENTS`, `URL`, `apiFailure`, `nowIso` |
| `13r-event-stream.js` | `01-config.js` | backward | `safeSessionId`, `send` |
| `13r-event-stream.js` | `02-session-store.js` | backward | `readMissionSessionHead`, `sessionDisplayTitle`, `sessionMissionId` |
| `13r-event-stream.js` | `04-permission-runtime.js` | backward | `activeChildren`, `subscribeActiveChildEvents` |
| `13r-event-stream.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `stewardThreadStateFromHead`, `stewardWatchedThread`, `threadOriginOf` |
| `13r-event-stream.js` | `13d-core-domain-routes.js` | backward | `missionPendingCounts` |
| `13s-scheduler.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `URL`, `apiFailure`, `fs`, `fsp`, `json`, `makeId`, `nowIso`, `path`, `paths`, `safeDecodeURIComponent`, `text` |
| `13s-scheduler.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `readJsonBody`, `send` |
| `13s-scheduler.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `13s-scheduler.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13s-scheduler.js` | `01s-work-data-journals.js` | backward | `WorkDataJournals` |
| `13s-scheduler.js` | `02-session-store.js` | backward | `createSession`, `loadSession`, `repairMissionChangeTornTail`, `saveSession`, `updateSessionMeta` |
| `13s-scheduler.js` | `04-permission-runtime.js` | backward | `logEvent`, `stopSession` |
| `13s-scheduler.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardPermissionRank` |
| `13s-scheduler.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_LIMITS`, `SCHEDULER_PHASES`, `SchedulerHooks`, `describeSchedule`, `missedOccurrence`, `nextFireAt`, `normalizeSchedulerTask`, `occurrenceKey` |
| `13s-scheduler.js` | `07-autonomy.js` | backward | `schedulerAskWaitSessions` |
| `13s-scheduler.js` | `10-context-governance.js` | backward | `runSessionTurn` |
| `13t-steward-schedule.js` | `00-boot.js` | backward | `fsp`, `makeId`, `nowIso`, `text` |
| `13t-steward-schedule.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13t-steward-schedule.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardSanitizeText` |
| `13t-steward-schedule.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_LIMITS`, `SchedulerHooks`, `describeSchedule`, `nextFireAt`, `normalizeSchedulerTask` |
| `13t-steward-schedule.js` | `13g-steward.js` | backward | `stewardToolHandler` |
| `13t-steward-schedule.js` | `13i-steward-inbox.js` | backward | `stewardAppendInboxRows`, `stewardClipSummary`, `stewardInboxRowDedupeKeys`, `stewardIsoAt`, `stewardLoadState`, `stewardRuntime` |
| `13t-steward-schedule.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardFail`, `stewardRawKind`, `stewardReadSessionHead` |
| `13t-steward-schedule.js` | `13k-steward-threads.js` | backward | `stewardCanonWorkspacePath`, `stewardDeriveThreadCwd`, `stewardUnattendedByModel`, `stewardValidateCwd` |
| `13t-steward-schedule.js` | `13q-steward-runner-turn.js` | backward | `stewardEnsureOpenAiRoute` |
| `13t-steward-schedule.js` | `13s-scheduler.js` | backward | `schedulerClockNow`, `schedulerEmitChanged`, `schedulerEnabled`, `schedulerEnsureTimer`, `schedulerLoad`, `schedulerReadFireRows`, `schedulerRunNow`, `schedulerRuntime`, `schedulerSaveTasks`, `schedulerStorageFailure`, `schedulerTaskAdmission`, `schedulerTaskEncodingPreflight`, `schedulerTaskPayload` |
| `13u-migration-center.js` | `00-boot.js` | backward | `MigrationHooks`, `SKILL_ID_RE`, `VERSION`, `agentCliHomes`, `crypto`, `externalRoot`, `findRuyiPackageRootFor`, `fs`, `fsp`, `installRegistryPath`, `nowIso`, `os`, `path`, `paths`, `readInstallRegistry`, `ruyiPackageInfo`, `safeJsonParse`, `samePathKey`, `text`, `tildePath` |
| `13u-migration-center.js` | `01-config.js` | backward | `agentMcpImportSources`, `atomicWriteJson`, `classifyAgentMcpCandidate`, `generateMcpConfig`, `kimiMcpManagedIds`, `mutateConfig`, `readConfig` |
| `13u-migration-center.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13u-migration-center.js` | `04-desktop-shell.js` | backward | `DesktopShell` |
| `13u-migration-center.js` | `04-permission-runtime.js` | backward | `_parseTomlMcpServers`, `_tomlKeyPath`, `logEvent`, `parseMcpConfigFile`, `safeUrlForDisplay` |
| `13u-migration-center.js` | `05-claude-engine.js` | backward | `sanitizeExternalMcpServer` |
| `13u-migration-center.js` | `06d-memory-domain.js` | backward | `syncAgentInstructionImports` |
| `13v-external-channel-protocols.js` | `00-boot.js` | backward | `crypto`, `json`, `text` |
| `13w-external-bots.js` | `00-boot.js` | backward | `ExternalBotHooks`, `OVERLAY_ID`, `URL`, `apiFailure`, `crypto`, `fsp`, `json`, `makeId`, `nowIso`, `path`, `paths`, `runKeyedChain`, `text` |
| `13w-external-bots.js` | `01-config.js` | backward | `atomicWriteJson`, `originOk`, `readConfig`, `send`, `tokenOk` |
| `13w-external-bots.js` | `01p-work-data-store.js` | backward | `WorkDataStore` |
| `13w-external-bots.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13w-external-bots.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID` |
| `13w-external-bots.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn` |
| `13w-external-bots.js` | `13v-external-channel-protocols.js` | backward | `ExternalChannelProtocols` |
| `13w-external-bots.js` | `13x-external-channel-delivery.js` | backward | `ExternalChannelDelivery` |
| `13w-external-bots.js` | `13y-external-bot-credentials.js` | backward | `ExternalBotCredentials` |
| `13w-external-bots.js` | `13z-external-bot-discovery.js` | backward | `ExternalBotDiscovery` |
| `13x-external-channel-delivery.js` | `00-boot.js` | backward | `path`, `text` |
| `13y-external-bot-credentials.js` | `00-boot.js` | backward | `crypto`, `fsp`, `path`, `paths`, `runKeyedChain` |
| `13y-external-bot-credentials.js` | `01-config.js` | backward | `DurableJsonStore` |
| `13y-external-bot-credentials.js` | `01j-local-crypto.js` | backward | `LocalSecretCrypto` |
| `14-main.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `EventStreamHooks`, `RUYI_EVENTS`, `WorkDataRootHooks`, `apiSessionIdInvalid`, `apiSessionNotFound`, `appendUsageLedger`, `buildUsageSummary`, `createNdjsonLineFeeder`, `dataRoot`, `flushUsageLedgerSync`, `forEachUsageRow`, `hashArgs`, `neutralizeFenceTag`, `readUsageRows`, `runKeyedChain`, `spawnDetachedChecked`, `usageLedgerCacheStats` |
| `14-main.js` | `01-config.js` | backward | `CONFIG_MIGRATIONS`, `DurableJsonStore`, `autoImportClaudeCodeMcp`, `buildClaudeCliEnv`, `configMutateChain`, `configWriteChain`, `decodeClaudeCliText`, `defaultConfig`, `desktopMcpFromInstalledRoot`, `desktopPythonCandidates`, `detectDesktopMcp`, `detectDesktopMcpAsync`, `ensureDesktopMcpWarm`, `generateMcpConfig`, `generateSessionMcpConfig`, `mutateConfig`, `normalizeConfig`, `pickPython`, `pickPythonAsync`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `readConfig`, `readFileTail`, `resolveClaudeLauncher`, `sweepStaleScriptFiles`, `syncAgentCliMcpManifests`, `syncMcpServersToKimi` |
| `14-main.js` | `01b-route-auth.js` | backward | `ROUTE_AUTH` |
| `14-main.js` | `01c-runtime-flags.js` | backward | `appendOnlyToolSchemasEnabled`, `budgetGuardDecision`, `budgetGuardEnabled`, `budgetGuardTurnTokens`, `budgetGuardWarnRatio`, `estimateBucketsEnabled`, `evaporateBudgetBoundaryEnabled`, `execResultCacheEnabled`, `execResultCacheMaxEntries`, `historyReadDedupEnabled`, `reseedReattachFilesEnabled`, `reseedTailUnitsEnabled`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `summaryEntityCheckEnabled`, `summaryFactTableCap`, `summaryFactTableEnabled`, `summaryPromptI18nEnabled`, `summaryRefineEnabled`, `summarySingleShotEnabled`, `toolByteBudgetShadowBytes`, `toolTimeBudgetEnabled`, `toolTimeBudgetHardMs`, `toolTimeBudgetShadowEnabled`, `toolTimeBudgetWarnMs`, `volatileTailLayoutEnabled` |
| `14-main.js` | `01d-win-cmdline.js` | backward | `batchSafeSpawn`, `cmdLineBudgetFor`, `quoteWinArg`, `spawnCmdLineLength` |
| `14-main.js` | `01e-permission-modes.js` | backward | `BUILTIN_AGENT_ROLES`, `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `normalizeAgentRole`, `resolvePermissionMode` |
| `14-main.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES`, `normalizeAgentCliType` |
| `14-main.js` | `01g-server-ownership.js` | backward | `ServerOwnership` |
| `14-main.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `14-main.js` | `02-session-store.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `MISSION_CONTAINER_MAX_FILES`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `collectBridgedWriteTarget`, `collectBridgedWriteTargets`, `compactInterventionJournal`, `createMissionContainer`, `createSession`, `deleteSession`, `detectDanglingTurn`, `flushSessionIndex`, `flushSessionIndexSync`, `invalidateSessionIndex`, `isUntitledSessionTitle`, `journalGc`, `journalGcProbe`, `journalRecord`, `kindForPath`, `listMissionContainers`, `listSessions`, `loadSession`, `missionAttachThread`, `missionMergeInto`, `missionSplitThreads`, `mutateSession`, `normalizeSession`, `patchMissionContainer`, `readInterventions`, `readMissionContainer`, `readSessionHeadResilient`, `readSessionNotes`, `reconcileWorkspaceTurnBaseline`, `registerIntervention`, `repairMissionChangeTornTail`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `rewindSession`, `saveSession`, `sessionBodyPaths`, `sessionBodyPerfStats`, `sessionDisplayTitle`, `sessionMessagesDelta`, `sessionMeta`, `sessionNotesPath`, `sessionObjectIsStale`, `setSessionIndexRebuildScanHookForTest`, `transitionInterventionState`, `updateSessionMeta`, `writeSessionNotes` |
| `14-main.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `14-main.js` | `02d-session-overrides.js` | backward | `liveSessionPermissionMode` |
| `14-main.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute`, `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `14-main.js` | `02f-turn-effect-kinds.js` | backward | `IRREVERSIBLE_NATIVE_KIND`, `TURN_SUMMARY_COMMAND_TOOLS`, `TURN_SUMMARY_FILE_TOOLS`, `toolInvokeEnvelopeRepair`, `unwrapToolInvokeCall` |
| `14-main.js` | `03-bridge-guard.js` | backward | `AUTOEXEC_DENYLIST`, `auditBridgedWriteCoverage`, `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `buildBrowserOpenSpawn`, `buildCodeEditorSpawn`, `buildOpenSpawn`, `buildRevealSpawn`, `classifyCodeEditorExecutable`, `cwdWarning`, `executableFromAssociationCommand`, `guardFileToolPath`, `guardWorkspacePath`, `pathWithinAnyRoot`, `pathWithinRoot`, `providerIsLocal`, `resolveWorkspace` |
| `14-main.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `McpHttpClient`, `McpStdioClient`, `activeChildren`, `bridgedServerUnavailableMessage`, `buildMcpConnectorInventory`, `classifyMcpError`, `clearPendingPermissions`, `collectBridgedTools`, `configureMcpFromTool`, `flushWorkbenchLogs`, `hasPendingPermissionForSession`, `invalidateMcpDropInCache`, `killAllMcpClients`, `killChildTree`, `killOwnProcessTree`, `makeAttachmentRecord`, `mcpChildExitResult`, `nativeClaudeAgentResultInfo`, `normalizeMcpToolResult`, `parseAgentCliEvent`, `parseClaudeTaskNotification`, `parseMcpConfigFile`, `permissionWaitMs`, `probeMcpConnector`, `redact`, `resolveBridge`, `resolveExternalMcpServers`, `safeMcpInventory`, `safeUrlForDisplay`, `scanMcpSources` |
| `14-main.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `14-main.js` | `04h-provider-http.js` | backward | `abortableDelay`, `providerApiBase`, `providerBaseWithV1`, `providerCallIsTransient`, `providerCompletionUrl`, `providerRequestHeaders`, `providerResponsesBase`, `withTransientRetry` |
| `14-main.js` | `04i-provider-wire.js` | backward | `PROVIDER_WIRE_PROTOCOLS`, `applyProviderReasoningEffort`, `buildResponsesInputItems`, `normalizeProviderApiStyle`, `providerReasoningEffort`, `providerWireProtocol`, `responsesHistoryWithCompleteToolPairs` |
| `14-main.js` | `04j-voice-learn.js` | backward | `VoiceLearn` |
| `14-main.js` | `04j-voice-lexicon.js` | backward | `VoiceLexicon` |
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
| `14-main.js` | `07-autonomy.js` | backward | `ACC_POLICY_TOOL_FAMILIES`, `NATIVE_TOOL_PACKS`, `NATIVE_TOOL_TIER`, `accPolicyHiddenToolNames`, `adaptiveMetaToolSchemas`, `applyAgentWorktree`, `bridgedToolTier`, `buildClaudeAgentDefinitions`, `buildOpenAiTools`, `buildToolCatalog`, `classifyClaudeSubagentFailure`, `classifyRuntimeToolFailure`, `classifyToolPacks`, `compareToolRetrievalShadow`, `createAgentWorktree`, `createToolLoadingState`, `dropPolicyDisabledBridgedTools`, `fetchOpenAiModels`, `finalizeAgentWorktree`, `getAgentRoleLibrary`, `nativeToolDisabledByPolicy`, `nativeToolGate`, `nativeToolSchema`, `openAiStreamOnce`, `readClaudeProjectAgentRoles`, `requestNativePermission`, `saveProjectAgentRoles`, `schedulerAskWaitSessions`, `searchToolCatalog`, `toolArgsSkeleton`, `toolDisabledByPolicy`, `toolPackForName` |
| `14-main.js` | `08-agent-runs.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `QUALITY_GATE_OUTPUT_SCHEMA`, `agentRunDigestStats`, `aggregateAgentVote`, `aggregateCoverage`, `appendAgentRunEvent`, `autoResumeInterruptedRuns`, `buildAgentRunEnvelope`, `buildNodeEvidenceCatalog`, `cutAtSentence`, `dedupeAgentFindings`, `deleteAgentWorkflow`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `flushAgentRunEvents`, `formatNodeEvidencePrompt`, `getAgentWorkflows`, `indexNodeEvidence`, `listAgentRunDigests`, `mapPool`, `markInterruptedAgentRuns`, `normalizeAgentGate`, `normalizeAgentWorkflow`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `parseStructuredAgentOutput`, `propagateAssignments`, `purgeNodeEvidence`, `readAgentRunEvents`, `repairJson`, `resolveAgentTeamRoute`, `runSubAgentCore`, `runWorkspaceHash`, `saveAgentRun`, `saveAgentWorkflow`, `singleAgentShorthandNode`, `syncRunEventSeq`, `validateAgentJsonSchema`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `14-main.js` | `09-workflow.js` | backward | `legacySpawnToOrchestrateArgs`, `planDiscoveryToolBatchAllowed`, `waitForAgentRunResults` |
| `14-main.js` | `09d-token-estimation.js` | backward | `CONTEXT_WINDOW_FALLBACK`, `classifyTextForEstimate`, `estimateHistoryTokens`, `estimateTextTokens`, `fmtTokensServer`, `setEstimateBucketsV1` |
| `14-main.js` | `10-context-governance.js` | backward | `COMPACT_MARKER_MIN_SAVED_TOKENS`, `COMPACT_RESEED_TAIL_MAX_TOKENS`, `CompactionPlan`, `agentConversationContextMeta`, `agentNodeContextWindow`, `appendPromptToLastUserMessage`, `buildObservationRecallPrompt`, `buildSessionNotesInjectPrompt`, `buildSummaryFactTableMessages`, `buildSummaryRefineMessages`, `calibratedEstimate`, `checkSummaryEntities`, `chunkHistoryByBudget`, `configuredConversationWindow`, `contextWindowFromTable`, `contextWindowOverrideKey`, `dedupeRepeatedReads`, `estimateFactor`, `evaporateBudgetBoundary`, `evaporateHistory`, `extractContextLength`, `extractSessionNotes`, `extractSummaryEntities`, `fileReadDedupKey`, `fitHistoryForSummary`, `historyStartsWithCompactionSummary`, `historyUnitStarts`, `isContextOverflowError`, `learnedWindowCap`, `mapSummaryWithLimit`, `maybeWriteSessionNotes`, `measureObservationReductionShadow`, `mergeSessionNotes`, `noteEstimateSample`, `noteWindowOvershoot`, `openCompactMarker`, `parseSessionNotesMarkdown`, `providerContextWindow`, `providerConversationContextWindow`, `providerSummaryCall`, `recentFileReads`, `recentTurnsBoundary`, `reduceObservationContent`, `rehydrateObservation`, `renderSessionNotesMarkdown`, `resolveCompactionProvider`, `resolveContextWindow`, `resolveSummaryCallPolicy`, `runSessionTurn`, `summaryMaxConcurrent`, `summaryPromptWithGuidance`, `summarySingleShotCap`, `summarySingleShotReserveTokens`, `upsertCompactMarker`, `validateStructuredSummary`, `writeHistorySnapshot` |
| `14-main.js` | `11-native-tools.js` | backward | `peekRgProbe`, `probeRgAsync` |
| `14-main.js` | `11d-media-inspection.js` | backward | `MediaInspection` |
| `14-main.js` | `12-tool-dispatch.js` | backward | `toolArgsMissingRequired`, `withToolArgsGuide` |
| `14-main.js` | `13-http-router.js` | backward | `doctor`, `installIntegration`, `parseArgs`, `startMcp`, `startServer` |
| `14-main.js` | `13d-core-domain-routes.js` | backward | `buildMissionAggregateRows`, `missionAggregateStats` |
| `14-main.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `pretenderIndexTestHooks`, `warmPretenderProjectionIndex` |
| `14-main.js` | `13i-steward-inbox.js` | backward | `STEWARD_SOURCE_EVENT_MAP`, `startStewardInbox`, `stewardEventDedupeKey`, `stewardInboxRowDedupeKeys`, `stewardMergeInboxEvents`, `stewardNormalizeBudgetExhausted`, `stewardNormalizeMissionChange`, `stewardNormalizePendingIntervention`, `stewardNormalizeRunEvent`, `stopStewardInbox` |
| `14-main.js` | `13j-steward-tool-base.js` | backward | `stewardTurnTaintedBy` |
| `14-main.js` | `13k-steward-threads.js` | backward | `stewardMediatedPermissionWaitMs` |
| `14-main.js` | `13m-steward-runner-base.js` | backward | `STEWARD_INBOX_MESSAGE_CHARS`, `STEWARD_SAY_CEILING`, `STEWARD_SAY_TARGET`, `ensureStewardSession`, `stewardFailureExplain`, `stewardResolveRoute` |
| `14-main.js` | `13o-steward-runner-prompt.js` | backward | `buildStewardSystemPrompt`, `stewardActLabel`, `stewardContextBudget`, `stewardNormalizeAct`, `stewardParseReply`, `stewardPreroute` |
| `14-main.js` | `13p-steward-runner-actions.js` | backward | `stewardCircuitCheck`, `stewardDowngradeActions`, `stewardInboxMessage`, `stewardSelfServeAllows` |
| `14-main.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn`, `stewardMergeDelegationReceipts`, `stewardResetConversation`, `stewardVisit`, `stewardVisitDigest` |
| `14-main.js` | `13s-scheduler.js` | backward | `handleSchedulerApiRoutes`, `schedulerPermissionModeFor`, `schedulerRuntimeSnapshot`, `startScheduler`, `stopScheduler` |

## 强连通分量

1. `00-boot.js` ↔ `01-config.js` ↔ `02-session-store.js` ↔ `03-bridge-guard.js` ↔ `04-desktop-shell.js` ↔ `04-permission-runtime.js` ↔ `05-claude-engine.js` ↔ `05b-kimi-bridge.js` ↔ `05c-kimi-search-policy.js` ↔ `05d-kimi-prompt-parts.js` ↔ `06-provider-engine.js` ↔ `06b-prompt-registry.js` ↔ `06c-agent-loop-hooks.js` ↔ `06d-memory-domain.js` ↔ `06e-mission-domain.js` ↔ `06f-autonomy-grants.js` ↔ `06g-resource-leases.js` ↔ `07-autonomy.js` ↔ `08-agent-runs.js` ↔ `09-workflow.js` ↔ `09b-replan-ledger.js` ↔ `09d-token-estimation.js` ↔ `10-context-governance.js` ↔ `11-native-tools.js` ↔ `13-http-router.js` ↔ `13b-api-domain-routes.js` ↔ `13c-overlay-routes.js` ↔ `13d-core-domain-routes.js` ↔ `13e-pretender-index.js` ↔ `13f-native-tool-schemas.js` ↔ `13s-scheduler.js`

## 维护规则

- 源码新增或删除跨模块引用时，契约与本图必须同步更新；`--check`/CI 会拒绝漂移。
- 重复顶层导出名始终拒绝。循环边和前向边只能减少；若确需增加，必须显式修改 `module-dependency-policy.json` 并说明理由。
- 隔离批次优先把内部符号收进命名空间，只暴露真实公共面；每批保持拼接顺序和运行语义。
