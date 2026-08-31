# 路由清册(第 103 波 103a · 机器生成)

> 由 `dev-harness/route-inventory.js` 生成,`route-inventory.static.e2e.js` 重算比对;手改无效。
> 判定点 101(精确 88 / 前缀 12 / 正则 1),ROUTE_AUTH 92 条,生成于 2026-08-31T03:32:55.335Z。

鉴权级别:`open` 低敏读 · `origin` 同源 · `token` 始终 token · `token-browser` 浏览器须 token/loopback 须同源 · `body-token` handler 自查 body token · `host-gate` 顶层 host 门(非 /api)。`self` = handler 内另有 tokenOk 纵深自查。

## agent-run(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/agent-runs` | exact | token self | 13d-core-domain-routes.js:1102 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 31 件 |
| GET | `/api/agent-runs/…/events` | prefix | token self | 13d-core-domain-routes.js:1141 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 20 件 |
| POST | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:1152 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 20 件 |
| DELETE | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:1268 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 20 件 |
| GET | `/api/agent-runs/` | prefix | token self | 13d-core-domain-routes.js:1288 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 20 件 |

## checkpoint-storage(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/storage/policy` | exact | token | 13b-api-domain-routes.js:189 | frontend-domains.static.e2e.js, session-storage-v2.e2e.js, storage-steward.e2e.js |
| POST | `/api/storage/clean` | exact | token | 13b-api-domain-routes.js:199 | frontend-domains.static.e2e.js, session-storage-v2.e2e.js, storage-steward.e2e.js |
| POST | `/api/checkpoints/rollback` | exact | token | 13b-api-domain-routes.js:214 | artifacts.e2e.js, checkpoint-coverage.e2e.js, checkpoint.e2e.js 等 10 件 |
| POST | `/api/session/rewind` | exact | token | 13b-api-domain-routes.js:245 | rewind.e2e.js |

## core-inline(62)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/bootstrap` | exact | open | 13-http-router.js:16 | context-compact-v2.e2e.js, dom-smoke.e2e.js, external-code-diff.e2e.js 等 7 件 |
| GET | `/api/status` | exact | open | 13-http-router.js:22 | audit-w23.e2e.js, auth-deny-default.e2e.js, capabilities.e2e.js 等 21 件 |
| GET | `/api/capabilities` | exact | open | 13-http-router.js:94 | capabilities.e2e.js, playbooks.e2e.js |
| GET | `/api/playbooks` | exact | token-browser | 13-http-router.js:103 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 4 件 |
| POST | `/api/playbooks/draft` | exact | token | 13-http-router.js:110 | playbooks.e2e.js |
| POST | `/api/playbooks` | exact | token | 13-http-router.js:117 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 4 件 |
| DELETE/POST | `/api/playbooks/` | prefix | token | 13-http-router.js:126 | auth-deny-default.e2e.js, playbooks.e2e.js |
| POST | `/api/workspace/resolve` | exact | token | 13-http-router.js:135 | workspace-resolve.e2e.js |
| POST | `/api/pick-folder` | exact | token | 13-http-router.js:146 | workspace-resolve.e2e.js |
| POST | `/api/pick-file` | exact | token | 13-http-router.js:150 | overlay-update-gui.static.e2e.js |
| GET | `/api/models` | exact | open | 13-http-router.js:154 | claude-models-cache.e2e.js, context-window.e2e.js, kimi-agent-cli.e2e.js 等 4 件 |
| POST | `/api/config` | exact | token | 13-http-router.js:180 | agent-team-mode.e2e.js, claude-models-cache.e2e.js, context-compact-v2.e2e.js 等 19 件 |
| GET | `/api/agent-roles` | exact | token-browser | 13-http-router.js:218 | auth-deny-default.e2e.js, frontend-domains.static.e2e.js, meta-guard.e2e.js |
| POST | `/api/agent-roles` | exact | token | 13-http-router.js:231 | auth-deny-default.e2e.js, frontend-domains.static.e2e.js, meta-guard.e2e.js |
| GET | `/api/agent-workflows` | exact | token-browser | 13-http-router.js:245 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| POST | `/api/agent-workflows` | exact | token | 13-http-router.js:250 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| DELETE/POST | `/api/agent-workflows/` | prefix | token | 13-http-router.js:257 | auth-deny-default.e2e.js |
| POST | `/api/provider/test` | exact | token | 13-http-router.js:262 | audit-w23.e2e.js, meta-guard.e2e.js |
| GET | `/api/skills` | exact | token-browser | 13-http-router.js:292 | audit-w23.e2e.js, meta-guard.e2e.js, skills-registry.e2e.js |
| POST | `/api/session/skills` | exact | token-browser | 13-http-router.js:317 | claude-cmdline-guard.e2e.js, index-dedup.e2e.js, skills-registry.e2e.js 等 4 件 |
| DELETE | `/api/skills` | exact | token | 13-http-router.js:346 | audit-w23.e2e.js, meta-guard.e2e.js, skills-registry.e2e.js |
| POST | `/api/session/memories` | exact | token-browser | 13-http-router.js:367 | workbench-memory.e2e.js |
| GET | `/api/memory` | exact | token self | 13-http-router.js:417 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 5 件 |
| GET | `/api/memory/item` | exact | token self | 13-http-router.js:431 | workbench-memory.e2e.js |
| POST | `/api/memory/proposal` | exact | token-browser | 13-http-router.js:444 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/decision` | exact | token-browser | 13-http-router.js:451 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/apply` | exact | token-browser | 13-http-router.js:460 | — |
| POST | `/api/memory/draft` | exact | token-browser | 13-http-router.js:471 | workbench-memory.e2e.js |
| POST | `/api/memory/migrate` | exact | token-browser | 13-http-router.js:478 | workbench-memory.e2e.js |
| POST | `/api/memory/metadata` | exact | token-browser | 13-http-router.js:489 | — |
| POST | `/api/memory` | exact | token-browser | 13-http-router.js:507 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 5 件 |
| GET | `/api/memory/relations` | exact | token self | 13-http-router.js:529 | agent-quality-workflow.e2e.js, workbench-memory.e2e.js |
| GET | `/api/memory/maintenance` | exact | token self | 13-http-router.js:542 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/propose` | exact | token-browser | 13-http-router.js:555 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/confirm` | exact | token-browser | 13-http-router.js:564 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/relations/` | prefix | token-browser | 13-http-router.js:572 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/` | prefix | token-browser | 13-http-router.js:581 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 4 件 |
| POST | `/api/stop` | exact | token-browser | 13-http-router.js:591 | kimi-agent-cli.e2e.js |
| POST | `/api/provider/compact` | exact | token-browser | 13-http-router.js:600 | context-compact-v2.e2e.js, provider-compact.e2e.js, usage-subagent-ledger.e2e.js |
| POST | `/api/agent/compact` | exact | token-browser | 13-http-router.js:609 | — |
| GET | `/api/kimi/status` | exact | token-browser | 13-http-router.js:626 | — |
| POST | `/api/todo` | exact | body-token | 13-http-router.js:642 | todo-loopback.e2e.js |
| GET/POST | `/api/mission` | exact | body-token self | 13-http-router.js:662 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, auth-deny-default.e2e.js 等 27 件 |
| * | `/api/autonomy/grants` | exact | token self | 13-http-router.js:767 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/grant` | exact | token self | 13-http-router.js:774 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/revoke` | exact | token self | 13-http-router.js:802 | autonomy-grant.e2e.js |
| POST | `/api/agent-workflow/launch` | exact | body-token | 13-http-router.js:815 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 27 件 |
| GET | `/api/usage/summary` | exact | token self | 13-http-router.js:869 | usage-dashboard.e2e.js, usage-ledger.e2e.js, usage-subagent-ledger.e2e.js |
| GET | `/api/ops/metrics` | exact | token self | 13-http-router.js:881 | monitor-incremental.e2e.js |
| GET | `/api/checkpoints` | exact | token self | 13-http-router.js:890 | artifacts.e2e.js, changes-diff.e2e.js, checkpoint-coverage.e2e.js 等 16 件 |
| POST | `/api/checkpoints/open-external` | exact | token | 13-http-router.js:911 | external-code-diff.e2e.js |
| GET | `/api/checkpoints/diff` | exact | token self | 13-http-router.js:982 | changes-diff.e2e.js, frontend-domains.static.e2e.js, i18n.e2e.js |
| GET | `/api/file/preview` | exact | token self | 13-http-router.js:1022 | artifacts.e2e.js, audit-w23.e2e.js, frontend-domains.static.e2e.js 等 6 件 |
| POST | `/api/file/reveal` | exact | token | 13-http-router.js:1059 | artifacts.e2e.js, meta-guard.e2e.js, pretender-task-sheet.static.e2e.js |
| GET | `/api/audit` | exact | token self | 13-http-router.js:1090 | audit.e2e.js, auth-deny-default.e2e.js, autonomy-grant.e2e.js 等 5 件 |
| GET | `/api/storage/summary` | exact | token self | 13-http-router.js:1107 | frontend-domains.static.e2e.js, metrics-panel.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| GET | `/api/metrics` | exact | token self | 13-http-router.js:1119 | frontend-domains.static.e2e.js, metrics-panel.e2e.js |
| POST | `/api/upload` | exact | token-browser | 13-http-router.js:1134 | pretender-dispatch-home.static.e2e.js, vision-loop.e2e.js |
| GET | `/api/upload/content` | exact | token self | 13-http-router.js:1142 | — |
| POST | `/api/chat/stream` | exact | token-browser | 13-http-router.js:1162 | action-model-view.e2e.js, adaptive-budget.e2e.js, agent-loop.e2e.js 等 91 件 |
| POST | `/api/tools/` | prefix | token | 13-http-router.js:1165 | audit-w23.e2e.js, autonomy-shell-sandbox.e2e.js, checkpoint.e2e.js 等 12 件 |
| * | `/health` | exact | host-gate | 13-http-router.js:1377 | — |

## intervention(11)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/_test/pretender-maintenance` | exact | token | 13d-core-domain-routes.js:782 | pretender-index-scale.e2e.js |
| POST | `/api/missions/:missionId/interventions/:interventionId/decision` | regex | token | 13d-core-domain-routes.js:796 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 18 件 |
| GET | `/api/interventions` | exact | token-browser self | 13d-core-domain-routes.js:821 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, interventions-persist.e2e.js 等 8 件 |
| GET | `/api/interventions/` | prefix | token-browser self | 13d-core-domain-routes.js:874 | interventions-persist.e2e.js, pretender-index-scale.e2e.js, pretender-needs-drawer.e2e.js |
| POST | `/api/chat/answer` | exact | token-browser | 13d-core-domain-routes.js:910 | interactive-question.e2e.js, interventions-c4.e2e.js, interventions-changeseq.e2e.js 等 9 件 |
| POST | `/api/question/heartbeat` | exact | token-browser | 13d-core-domain-routes.js:930 | — |
| POST | `/api/question/request` | exact | body-token | 13d-core-domain-routes.js:940 | — |
| POST | `/api/permission/request` | exact | body-token | 13d-core-domain-routes.js:955 | — |
| POST | `/api/permission/decision` | exact | token-browser | 13d-core-domain-routes.js:1041 | autonomy-pause.e2e.js, claude-binary-live.e2e.js, interventions-snapshot.e2e.js 等 5 件 |
| POST | `/api/plan/decision` | exact | token | 13d-core-domain-routes.js:1060 | interventions-snapshot.e2e.js, plan-mode.e2e.js, pretender-needs-drawer.static.e2e.js 等 4 件 |
| POST | `/api/_test/intervention-cas` | exact | token self | 13d-core-domain-routes.js:1081 | interventions-cas.e2e.js, interventions-changeseq.e2e.js |

## mcp(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/mcp/import-folder` | exact | token | 13b-api-domain-routes.js:12 | mcp-config.e2e.js |
| POST | `/api/mcp/import-config/scan` | exact | token | 13b-api-domain-routes.js:55 | mcp-import-config.e2e.js |
| POST | `/api/mcp/import-config/apply` | exact | token | 13b-api-domain-routes.js:67 | mcp-import-config.e2e.js |
| GET | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js:100 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| POST | `/api/mcp/connectors/health` | exact | token | 13b-api-domain-routes.js:110 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| POST | `/api/mcp/connectors/toggle` | exact | token | 13b-api-domain-routes.js:128 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| DELETE | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js:151 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |

## mission(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/missions` | exact | token-browser self | 13d-core-domain-routes.js:193 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 20 件 |
| GET | `/api/missions/` | prefix | token-browser self | 13d-core-domain-routes.js:253 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 18 件 |

## overlay(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/overlay/precheck` | exact | token | 13c-overlay-routes.js:127 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/apply` | exact | token | 13c-overlay-routes.js:147 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| GET | `/api/overlay/status` | exact | token self | 13c-overlay-routes.js:168 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/rollback` | exact | token | 13c-overlay-routes.js:179 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |

## session(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:2 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-parent-heartbeat.e2e.js 等 105 件 |
| POST | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:5 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-parent-heartbeat.e2e.js 等 105 件 |
| POST | `/api/sessions/bulk-delete` | exact | token-browser | 13d-core-domain-routes.js:11 | session-bulk-cleanup.e2e.js |
| DELETE/GET/PATCH/POST | `/api/sessions/` | prefix | token-browser | 13d-core-domain-routes.js:18 | agent-roles.e2e.js, artifacts.e2e.js, audit-w23.e2e.js 等 40 件 |

## steer(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steer` | exact | token | 13b-api-domain-routes.js:262 | agent-steer-node.e2e.js, kimi-agent-cli.e2e.js, long-tool-liveness-steer.e2e.js 等 6 件 |
| DELETE | `/api/steer` | exact | token | 13b-api-domain-routes.js:316 | agent-steer-node.e2e.js, kimi-agent-cli.e2e.js, long-tool-liveness-steer.e2e.js 等 6 件 |

## 域路由委派(handleApi → 域 handler)

- 13-http-router.js:286 → `handleSessionApiRoutes`
- 13-http-router.js:288 → `handleMissionsApiRoutes`
- 13-http-router.js:641 → `handleInterventionApiRoutes`
- 13-http-router.js:889 → `handleAgentRunApiRoutes`
- 13-http-router.js:1085 → `handleMcpApiRoutes`
- 13-http-router.js:1129 → `handleCheckpointApiRoutes`
- 13-http-router.js:1131 → `handleSteerApiRoute`
- 13-http-router.js:1133 → `handleOverlayApiRoutes`
