# 路由清册(第 103 波 103a · 机器生成)

> 由 `dev-harness/route-inventory.js` 生成,`route-inventory.static.e2e.js` 重算比对;手改无效。
> 判定点 154(精确 131 / 前缀 11 / 正则 12),ROUTE_AUTH 140 条,生成于 2026-10-05T17:41:06.251Z。

鉴权级别:`open` 低敏读 · `origin` 同源 · `token` 始终 token · `token-browser` 浏览器须 token/loopback 须同源 · `body-token` handler 自查 body token · `host-gate` 顶层 host 门(非 /api)。`self` = handler 内另有 tokenOk 纵深自查。

## agent-run(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/agent-runs` | exact | token self | 13d-core-domain-routes.js · `handleAgentRunApiRoutes` | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-node-wrapup.e2e.js 等 36 件 |
| GET | `/api/agent-runs/…/events` | prefix | token self | 13d-core-domain-routes.js · `handleAgentRunApiRoutes` | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-resource-wait-stop.e2e.js 等 20 件 |
| POST | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js · `handleAgentRunApiRoutes` | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-resource-wait-stop.e2e.js 等 20 件 |
| DELETE | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js · `handleAgentRunApiRoutes` | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-resource-wait-stop.e2e.js 等 20 件 |
| GET | `/api/agent-runs/` | prefix | token self | 13d-core-domain-routes.js · `handleAgentRunApiRoutes` | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-resource-wait-stop.e2e.js 等 20 件 |

## checkpoint-storage(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/storage/policy` | exact | token | 13b-api-domain-routes.js · `handleCheckpointApiRoutes` | config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| POST | `/api/storage/clean` | exact | token | 13b-api-domain-routes.js · `handleCheckpointApiRoutes` | frontend-domains.static.e2e.js, session-storage-v2.e2e.js, storage-steward.e2e.js |
| POST | `/api/checkpoints/rollback` | exact | token | 13b-api-domain-routes.js · `handleCheckpointApiRoutes` | action-feedback.static.e2e.js, artifacts.e2e.js, checkpoint-coverage.e2e.js 等 8 件 |
| POST | `/api/session/rewind` | exact | token | 13b-api-domain-routes.js · `handleCheckpointApiRoutes` | action-feedback.static.e2e.js, checkpoint-visibility.e2e.js, rewind.e2e.js 等 10 件 |

## core-inline(69)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/bootstrap` | exact | open | 13-http-router.js · `handleApi` | checkpoint-visibility.e2e.js, context-compact-v2.e2e.js, dom-smoke.e2e.js 等 14 件 |
| GET | `/api/status` | exact | open | 13-http-router.js · `handleApi` | acc-capability-gates.e2e.js, agent-deadlock-watchdog.e2e.js, asr-transcribe.e2e.js 等 69 件 |
| GET | `/api/capabilities` | exact | open | 13-http-router.js · `handleApi` | capabilities.e2e.js, playbooks.e2e.js, service-match.browser.e2e.js |
| GET | `/api/playbooks` | exact | token-browser | 13-http-router.js · `handleApi` | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 6 件 |
| POST | `/api/playbooks/service-match` | exact | token-browser | 13-http-router.js · `handleApi` | playbooks.e2e.js |
| POST | `/api/playbooks/draft` | exact | token | 13-http-router.js · `handleApi` | playbooks.e2e.js |
| POST | `/api/playbooks` | exact | token | 13-http-router.js · `handleApi` | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 6 件 |
| DELETE/POST | `/api/playbooks/` | prefix | token | 13-http-router.js · `handleApi` | auth-deny-default.e2e.js, playbooks.e2e.js |
| POST | `/api/workspace/resolve` | exact | token | 13-http-router.js · `handleApi` | workspace-resolve.e2e.js |
| POST | `/api/pick-folder` | exact | token | 13-http-router.js · `handleApi` | onboarding-workspace.browser.e2e.js, settings-wave1.browser.e2e.js, workspace-resolve.e2e.js |
| POST | `/api/workspace/dedicated` | exact | token | 13-http-router.js · `handleApi` | onboarding-workspace.browser.e2e.js |
| POST | `/api/pick-file` | exact | token | 13-http-router.js · `handleApi` | overlay-update-gui.static.e2e.js, settings-wave1.browser.e2e.js |
| GET | `/api/models` | exact | open | 13-http-router.js · `handleApi` | asr-config-ui.static.e2e.js, claude-models-cache.e2e.js, context-window.e2e.js 等 7 件 |
| POST | `/api/config` | exact | token | 13-http-router.js · `handleApi` | agent-team-mode.e2e.js, agent-wake.e2e.js, agent-workflow-claude-engine.e2e.js 等 56 件 |
| GET | `/api/agent-roles` | exact | token-browser | 13-http-router.js · `handleApi` | auth-deny-default.e2e.js, config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js 等 5 件 |
| POST | `/api/agent-roles` | exact | token | 13-http-router.js · `handleApi` | auth-deny-default.e2e.js, config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js 等 5 件 |
| GET | `/api/agent-workflows` | exact | token-browser | 13-http-router.js · `handleApi` | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 5 件 |
| POST | `/api/agent-workflows` | exact | token | 13-http-router.js · `handleApi` | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 5 件 |
| DELETE/POST | `/api/agent-workflows/` | prefix | token | 13-http-router.js · `handleApi` | auth-deny-default.e2e.js |
| POST | `/api/provider/test` | exact | token | 13-http-router.js · `handleApi` | audit-w23.e2e.js, config-providers-guard.e2e.js, meta-guard.e2e.js 等 6 件 |
| GET | `/api/skills` | exact | token-browser | 13-http-router.js · `handleApi` | audit-w23.e2e.js, meta-guard.e2e.js, migration-center.browser.e2e.js 等 7 件 |
| POST | `/api/session/skills` | exact | token-browser | 13-http-router.js · `handleApi` | claude-cmdline-guard.e2e.js, index-dedup.e2e.js, session-id-path-guard.e2e.js 等 6 件 |
| DELETE | `/api/skills` | exact | token | 13-http-router.js · `handleApi` | audit-w23.e2e.js, meta-guard.e2e.js, migration-center.browser.e2e.js 等 7 件 |
| POST | `/api/session/memories` | exact | token-browser | 13-http-router.js · `handleApi` | session-id-path-guard.e2e.js, workbench-memory.e2e.js |
| GET | `/api/memory` | exact | token self | 13-http-router.js · `handleApi` | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 9 件 |
| GET | `/api/memory/item` | exact | token self | 13-http-router.js · `handleApi` | workbench-memory.e2e.js |
| POST | `/api/memory/proposal` | exact | token-browser | 13-http-router.js · `handleApi` | action-feedback.static.e2e.js, memory-auto-proposal-api.e2e.js, memory-batch-proposal.e2e.js 等 4 件 |
| POST | `/api/memory/proposal/decision` | exact | token-browser | 13-http-router.js · `handleApi` | memory-auto-proposal-api.e2e.js, memory-batch-proposal.e2e.js, frontend-failure-paths.test.js |
| POST | `/api/memory/proposal/apply` | exact | token-browser | 13-http-router.js · `handleApi` | action-feedback.static.e2e.js, memory-batch-proposal.e2e.js, frontend-failure-paths.test.js |
| POST | `/api/memory/draft` | exact | token-browser | 13-http-router.js · `handleApi` | workbench-memory.e2e.js |
| POST | `/api/memory/migrate` | exact | token-browser | 13-http-router.js · `handleApi` | workbench-memory.e2e.js |
| POST | `/api/memory/metadata` | exact | token-browser | 13-http-router.js · `handleApi` | http-input-hardening.test.js |
| POST | `/api/memory` | exact | token-browser | 13-http-router.js · `handleApi` | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 9 件 |
| GET | `/api/memory/relations` | exact | token self | 13-http-router.js · `handleApi` | agent-quality-workflow.e2e.js, workbench-memory.e2e.js |
| GET | `/api/memory/maintenance` | exact | token self | 13-http-router.js · `handleApi` | workbench-memory.e2e.js |
| POST | `/api/memory/relations/propose` | exact | token-browser | 13-http-router.js · `handleApi` | workbench-memory.e2e.js |
| POST | `/api/memory/relations/confirm` | exact | token-browser | 13-http-router.js · `handleApi` | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/relations/` | prefix | token-browser | 13-http-router.js · `handleApi` | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/` | prefix | token-browser | 13-http-router.js · `handleApi` | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 8 件 |
| POST | `/api/stop` | exact | token-browser | 13-http-router.js · `handleApi` | agent-resource-wait-stop.e2e.js, agent-run-lifecycle.e2e.js, focus-rail.browser.e2e.js 等 16 件 |
| POST | `/api/provider/compact` | exact | token-browser | 13-http-router.js · `handleApi` | context-compact-v2.e2e.js, provider-compact-recall.e2e.js, provider-compact.e2e.js 等 6 件 |
| POST | `/api/agent/compact` | exact | token-browser | 13-http-router.js · `handleApi` | agent-cli-registry.test.js |
| GET | `/api/kimi/status` | exact | token-browser | 13-http-router.js · `handleApi` | kimi-agent-cli.e2e.js |
| POST | `/api/todo` | exact | body-token | 13-http-router.js · `handleApi` | event-stream.e2e.js, todo-loopback.e2e.js, http-input-hardening.test.js |
| GET/POST | `/api/mission` | exact | body-token self | 13-http-router.js · `handleApi` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 61 件 |
| * | `/api/autonomy/grants` | exact | token self | 13-http-router.js · `handleApi` | autonomy-grant.e2e.js |
| POST | `/api/autonomy/grant` | exact | token self | 13-http-router.js · `handleApi` | autonomy-grant.e2e.js |
| POST | `/api/autonomy/revoke` | exact | token self | 13-http-router.js · `handleApi` | autonomy-grant.e2e.js |
| POST | `/api/agent-workflow/launch` | exact | body-token | 13-http-router.js · `handleApi` | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 34 件 |
| POST | `/api/agent-workflow/wait` | exact | body-token self | 13-http-router.js · `handleApi` | — |
| POST | `/api/agent-workflow/result` | exact | body-token self | 13-http-router.js · `handleApi` | — |
| GET | `/api/usage/summary` | exact | token self | 13-http-router.js · `handleApi` | model-menu-no-shift.browser.e2e.js, settings-wave1.browser.e2e.js, steward-drawer.e2e.js 等 11 件 |
| GET | `/api/ops/metrics` | exact | token self | 13-http-router.js · `handleApi` | monitor-incremental.e2e.js |
| GET | `/api/checkpoints` | exact | token self | 13-http-router.js · `handleApi` | action-feedback.static.e2e.js, artifacts.e2e.js, changes-diff.e2e.js 等 14 件 |
| POST | `/api/checkpoints/open-external` | exact | token | 13-http-router.js · `handleApi` | external-code-diff.e2e.js |
| GET | `/api/checkpoints/diff` | exact | token self | 13-http-router.js · `handleApi` | changes-diff.e2e.js, frontend-domains.static.e2e.js, i18n.e2e.js |
| GET | `/api/help/doc` | exact | token self | 13-http-router.js · `handleApi` | help-viewer.e2e.js, onboarding.static.e2e.js |
| POST | `/api/open-path` | exact | token self | 13-http-router.js · `handleApi` | copy-path-guard.static.e2e.js, help-menu.e2e.js |
| GET | `/api/logs/tail` | exact | token self | 13-http-router.js · `handleApi` | help-menu.e2e.js |
| GET | `/api/file/preview` | exact | token self | 13-http-router.js · `handleApi` | artifacts.e2e.js, audit-w23.e2e.js, frontend-domains.static.e2e.js 等 7 件 |
| POST | `/api/file/reveal` | exact | token | 13-http-router.js · `handleApi` | artifacts.e2e.js, copy-path-guard.static.e2e.js, help-menu.e2e.js 等 4 件 |
| GET | `/api/audit` | exact | token self | 13-http-router.js · `handleApi` | audit-desktop-records.e2e.js, audit.e2e.js, auth-deny-default.e2e.js 等 7 件 |
| GET | `/api/storage/summary` | exact | token self | 13-http-router.js · `handleApi` | frontend-domains.static.e2e.js, metrics-panel.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| GET | `/api/metrics` | exact | token self | 13-http-router.js · `handleApi` | frontend-domains.static.e2e.js, metrics-panel.e2e.js |
| POST | `/api/upload` | exact | token-browser | 13-http-router.js · `handleApi` | steward-conversation.static.e2e.js, tool-result-render.browser.e2e.js, tool-result-shrink.test.js 等 4 件 |
| GET | `/api/upload/content` | exact | token self | 13-http-router.js · `handleApi` | tool-result-render.browser.e2e.js, tool-result-shrink.test.js, vision-loop.e2e.js |
| POST | `/api/chat/stream` | exact | token-browser | 13-http-router.js · `handleApi` | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, acc-capability-gates.e2e.js 等 177 件 |
| POST | `/api/tools/` | prefix | token | 13-http-router.js · `handleApi` | audit-w23.e2e.js, autonomy-shell-sandbox.e2e.js, background-completion.e2e.js 等 17 件 |
| * | `/health` | exact | host-gate | 13-http-router.js · `startServerInner` | — |

## event-stream(1)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/events/stream` | exact | token-browser | 13r-event-stream.js · `handleEventStreamApiRoutes` | action-feedback.browser.e2e.js, background-completion.e2e.js, boot-failure-kind.browser.e2e.js 等 18 件 |

## intervention(11)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/_test/pretender-maintenance` | exact | token | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | mission-index-scale.e2e.js |
| POST | `/api/missions/:missionId/interventions/:interventionId/decision` | regex | token | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 26 件 |
| GET | `/api/interventions` | exact | token-browser self | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, event-stream-client.browser.e2e.js 等 24 件 |
| GET | `/api/interventions/:sessionId` | regex | token-browser self | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | interventions-persist.e2e.js, mission-index-scale.e2e.js, session-id-path-guard.e2e.js 等 5 件 |
| POST | `/api/chat/answer` | exact | token-browser | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | event-stream-client.browser.e2e.js, event-stream-replay.browser.e2e.js, event-stream.e2e.js 等 17 件 |
| POST | `/api/question/heartbeat` | exact | token-browser | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | — |
| POST | `/api/question/request` | exact | body-token | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | — |
| POST | `/api/permission/request` | exact | body-token | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | acc-capability-gates.e2e.js, claude-cli-bridged-read-guard.e2e.js, claude-permission-bridge-mode.e2e.js |
| POST | `/api/permission/decision` | exact | token-browser | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | acc-capability-gates.e2e.js, autonomy-pause.e2e.js, claude-binary-live.e2e.js 等 14 件 |
| POST | `/api/plan/decision` | exact | token | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | intervention-mission-gate.e2e.js, interventions-snapshot.e2e.js, plan-mode.e2e.js 等 7 件 |
| POST | `/api/_test/intervention-cas` | exact | token self | 13d-core-domain-routes.js · `handleInterventionApiRoutes` | interventions-cas.e2e.js, interventions-changeseq.e2e.js |

## mcp(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/mcp/import-folder` | exact | token | 13b-api-domain-routes.js · `handleMcpApiRoutes` | mcp-config.e2e.js |
| POST | `/api/mcp/import-config/scan` | exact | token | 13b-api-domain-routes.js · `handleMcpApiRoutes` | mcp-import-config.e2e.js |
| POST | `/api/mcp/import-config/apply` | exact | token | 13b-api-domain-routes.js · `handleMcpApiRoutes` | action-feedback.static.e2e.js, copy-path-guard.static.e2e.js, mcp-import-config.e2e.js 等 4 件 |
| GET | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js · `handleMcpApiRoutes` | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 5 件 |
| POST | `/api/mcp/connectors/health` | exact | token | 13b-api-domain-routes.js · `handleMcpApiRoutes` | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js, repo-hygiene.e2e.js |
| POST | `/api/mcp/connectors/toggle` | exact | token | 13b-api-domain-routes.js · `handleMcpApiRoutes` | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 4 件 |
| DELETE | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js · `handleMcpApiRoutes` | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 5 件 |

## mcp/checkpoint-storage/steer(14)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/migration/scan` | exact | token | 13b-api-domain-routes.js · `handleMigrationApiRoutes` | migration-center.browser.e2e.js, migration-center.e2e.js |
| POST | `/api/migration/apply` | exact | token | 13b-api-domain-routes.js · `handleMigrationApiRoutes` | migration-center.e2e.js |
| POST | `/api/migration/undo` | exact | token | 13b-api-domain-routes.js · `handleMigrationApiRoutes` | migration-center.e2e.js |
| POST | `/api/migration/recycle` | exact | token | 13b-api-domain-routes.js · `handleMigrationApiRoutes` | migration-center.e2e.js |
| POST | `/api/migration/skills/copy` | exact | token | 13b-api-domain-routes.js · `handleMigrationApiRoutes` | migration-center.e2e.js |
| POST | `/api/audio/transcribe` | exact | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | asr-transcribe.e2e.js, asr-warmup.e2e.js, composer-voice-stream.browser.e2e.js 等 7 件 |
| POST | `/api/audio/stream/sessions` | exact | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | composer-voice-stream.browser.e2e.js, composer-voice-warmup.browser.e2e.js, toolbox-discovery.e2e.js 等 4 件 |
| POST | `/api/audio/stream/sessions/` | prefix | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | toolbox-discovery.e2e.js, voice-lexicon.e2e.js |
| DELETE | `/api/audio/stream/sessions/` | prefix | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | toolbox-discovery.e2e.js, voice-lexicon.e2e.js |
| POST | `/api/audio/correct` | exact | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | asr-config-ui.static.e2e.js, composer-voice-stream.browser.e2e.js, voice-lexicon.e2e.js |
| POST | `/api/audio/warmup` | exact | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | asr-warmup.e2e.js, composer-voice-warmup.browser.e2e.js |
| GET | `/api/audio/lexicon` | exact | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | voice-learn-front.test.js, voice-learn.browser.e2e.js, voice-learn.e2e.js 等 4 件 |
| POST | `/api/audio/lexicon` | exact | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | voice-learn-front.test.js, voice-learn.browser.e2e.js, voice-learn.e2e.js 等 4 件 |
| POST | `/api/audio/lexicon/observe` | exact | token | 13b-api-domain-routes.js · `handleAudioApiRoutes` | voice-learn-front.test.js, voice-learn.browser.e2e.js, voice-learn.e2e.js |

## mission(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/missions` | exact | token-browser self | 13d-core-domain-routes.js · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 47 件 |
| POST | `/api/missions` | exact | token self | 13d-core-domain-routes.js · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 47 件 |
| PATCH/POST | `/api/missions/:missionId` | regex | token self | 13d-core-domain-routes.js · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 26 件 |
| POST | `/api/missions/:missionId/threads` | regex | token self | 13d-core-domain-routes.js · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 26 件 |
| POST | `/api/missions/:missionId/merge` | regex | token self | 13d-core-domain-routes.js · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 26 件 |
| POST | `/api/missions/:missionId/split` | regex | token self | 13d-core-domain-routes.js · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 26 件 |
| GET | `/api/missions/:missionId` | regex | token-browser self | 13d-core-domain-routes.js · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 26 件 |

## overlay(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/overlay/precheck` | exact | token | 13c-overlay-routes.js · `handleOverlayApiRoutes` | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/apply` | exact | token | 13c-overlay-routes.js · `handleOverlayApiRoutes` | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| GET | `/api/overlay/status` | exact | token self | 13c-overlay-routes.js · `handleOverlayApiRoutes` | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/rollback` | exact | token | 13c-overlay-routes.js · `handleOverlayApiRoutes` | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js, settings-wave1.browser.e2e.js |

## scheduler(6)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/scheduler/tasks` | exact | token | 13s-scheduler.js · `handleSchedulerApiRoutes` | quiet-card-snooze.browser.e2e.js, rail-pocket.browser.e2e.js, scheduler-api.e2e.js 等 14 件 |
| POST | `/api/scheduler/tasks` | exact | token | 13s-scheduler.js · `handleSchedulerApiRoutes` | quiet-card-snooze.browser.e2e.js, rail-pocket.browser.e2e.js, scheduler-api.e2e.js 等 14 件 |
| * | `/api/scheduler/tasks/:taskId` | regex | token | 13s-scheduler.js · `handleSchedulerApiRoutes` | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 9 件 |
| * | `/api/scheduler/tasks/:taskId` | regex | token | 13s-scheduler.js · `handleSchedulerApiRoutes` | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 9 件 |
| POST | `/api/scheduler/tasks/:taskId/run-now` | regex | token | 13s-scheduler.js · `handleSchedulerApiRoutes` | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 9 件 |
| GET | `/api/scheduler/tasks/:taskId/runs` | regex | token | 13s-scheduler.js · `handleSchedulerApiRoutes` | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 9 件 |

## session(6)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js · `handleSessionApiRoutes` | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, acc-capability-gates.e2e.js 等 214 件 |
| GET | `/api/sessions/search` | exact | token self | 13d-core-domain-routes.js · `handleSessionApiRoutes` | session-id-path-guard.e2e.js, session-search.e2e.js, steward-runner.e2e.js |
| POST | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js · `handleSessionApiRoutes` | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, acc-capability-gates.e2e.js 等 214 件 |
| POST | `/api/sessions/bulk-delete` | exact | token-browser | 13d-core-domain-routes.js · `handleSessionApiRoutes` | session-bulk-cleanup.e2e.js |
| GET | `/api/sessions/background-counts` | exact | token-browser self | 13d-core-domain-routes.js · `handleSessionApiRoutes` | — |
| DELETE/GET/PATCH/POST | `/api/sessions/:id` | regex | token-browser | 13d-core-domain-routes.js · `handleSessionApiRoutes` | acc-capability-gates.e2e.js, action-feedback.browser.e2e.js, agent-mode-v2.e2e.js 等 119 件 |

## steer(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steer` | exact | token | 13b-api-domain-routes.js · `handleSteerApiRoute` | agent-steer-node.e2e.js, classic-window-live-steer.e2e.js, kimi-agent-cli.e2e.js 等 11 件 |
| DELETE | `/api/steer` | exact | token | 13b-api-domain-routes.js · `handleSteerApiRoute` | agent-steer-node.e2e.js, classic-window-live-steer.e2e.js, kimi-agent-cli.e2e.js 等 11 件 |

## steward(18)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steward/start` | exact | token self | 13g-steward.js · `handleStewardApiRoutes` | steward-continue-unfinished.e2e.js, steward-events.static.e2e.js, steward-inbox.e2e.js 等 6 件 |
| POST | `/api/steward/stop` | exact | token self | 13g-steward.js · `handleStewardApiRoutes` | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-preroute.e2e.js 等 5 件 |
| GET | `/api/steward/state` | exact | token self | 13g-steward.js · `handleStewardApiRoutes` | mission-index-late-materialize.e2e.js, rail-pocket.browser.e2e.js, steward-deliverable.e2e.js 等 10 件 |
| GET | `/api/steward/inbox` | exact | token self | 13g-steward.js · `handleStewardApiRoutes` | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-presence-gate.e2e.js 等 5 件 |
| GET | `/api/steward/preroute` | exact | token self | 13g-steward.js · `handleStewardApiRoutes` | keyboard-walkthrough.browser.e2e.js, steward-conversation.e2e.js, steward-conversation.static.e2e.js 等 5 件 |
| GET | `/api/steward/memory` | exact | token | 13g-steward.js · `handleStewardApiRoutes` | action-feedback.static.e2e.js, rail-pocket.browser.e2e.js, steward-memory.e2e.js 等 6 件 |
| GET | `/api/steward/memory/export` | exact | token | 13g-steward.js · `handleStewardApiRoutes` | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/edit` | exact | token | 13g-steward.js · `handleStewardApiRoutes` | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/veto` | exact | token | 13g-steward.js · `handleStewardApiRoutes` | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/restore` | exact | token | 13g-steward.js · `handleStewardApiRoutes` | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/clear` | exact | token | 13g-steward.js · `handleStewardApiRoutes` | action-feedback.static.e2e.js, steward-memory.e2e.js, steward-settings.static.e2e.js |
| GET | `/api/steward/decisions` | exact | token | 13g-steward.js · `handleStewardApiRoutes` | steward-decisions.e2e.js, steward-settings.e2e.js, steward-settings.static.e2e.js 等 5 件 |
| GET | `/api/steward/arbiter` | exact | token self | 13h-steward-runner.js · `handleStewardRunnerApiRoutes` | focus-rail.browser.e2e.js, net-token-replay.static.e2e.js, steward-board.e2e.js 等 9 件 |
| POST | `/api/steward/arbiter/prioritize` | exact | token self | 13h-steward-runner.js · `handleStewardRunnerApiRoutes` | steward-board.static.e2e.js, steward-drawer.static.e2e.js, thread-arbiter.e2e.js |
| POST | `/api/steward/visit` | exact | token self | 13h-steward-runner.js · `handleStewardRunnerApiRoutes` | steward-conversation.e2e.js, steward-conversation.static.e2e.js, steward-runner.e2e.js 等 4 件 |
| POST | `/api/steward/act` | exact | token self | 13h-steward-runner.js · `handleStewardRunnerApiRoutes` | classic-window-live-steer.e2e.js, event-stream-client.browser.e2e.js, event-stream-pageshow.browser.e2e.js 等 23 件 |
| POST | `/api/steward/relay` | exact | token self | 13h-steward-runner.js · `handleStewardRunnerApiRoutes` | foreign-turn-busy-guard.e2e.js, new-thread-engine-default.e2e.js, steward-board.static.e2e.js 等 9 件 |
| POST | `/api/steward/message` | exact | token self | 13h-steward-runner.js · `handleStewardRunnerApiRoutes` | classic-window-live-steer.e2e.js, event-stream.e2e.js, foreign-turn-busy-guard.e2e.js 等 16 件 |

## 域路由委派(handleApi → 域 handler)

- 13-http-router.js · `handleApi` → `handleSessionApiRoutes`
- 13-http-router.js · `handleApi` → `handleMissionsApiRoutes`
- 13-http-router.js · `handleApi` → `handleInterventionApiRoutes`
- 13-http-router.js · `handleApi` → `handleAgentRunApiRoutes`
- 13-http-router.js · `handleApi` → `handleMcpApiRoutes`
- 13-http-router.js · `handleApi` → `handleCheckpointApiRoutes`
- 13-http-router.js · `handleApi` → `handleSteerApiRoute`
- 13-http-router.js · `handleApi` → `handleAudioApiRoutes`
- 13-http-router.js · `handleApi` → `handleOverlayApiRoutes`
- 13-http-router.js · `handleApi` → `handleSchedulerApiRoutes`
- 13b-api-domain-routes.js · `handleMcpApiRoutes` → `handleMigrationApiRoutes`
