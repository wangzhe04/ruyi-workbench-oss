# 路由清册(第 103 波 103a · 机器生成)

> 由 `dev-harness/route-inventory.js` 生成,`route-inventory.static.e2e.js` 重算比对;手改无效。
> 判定点 128(精确 111 / 前缀 12 / 正则 5),ROUTE_AUTH 116 条,生成于 2026-09-07T12:27:42.600Z。

鉴权级别:`open` 低敏读 · `origin` 同源 · `token` 始终 token · `token-browser` 浏览器须 token/loopback 须同源 · `body-token` handler 自查 body token · `host-gate` 顶层 host 门(非 /api)。`self` = handler 内另有 tokenOk 纵深自查。

## agent-run(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/agent-runs` | exact | token self | 13d-core-domain-routes.js:1762 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 32 件 |
| GET | `/api/agent-runs/…/events` | prefix | token self | 13d-core-domain-routes.js:1801 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 21 件 |
| POST | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:1812 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 21 件 |
| DELETE | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:1870 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 21 件 |
| GET | `/api/agent-runs/` | prefix | token self | 13d-core-domain-routes.js:1890 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 21 件 |

## checkpoint-storage(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/storage/policy` | exact | token | 13b-api-domain-routes.js:189 | frontend-domains.static.e2e.js, session-storage-v2.e2e.js, storage-steward.e2e.js |
| POST | `/api/storage/clean` | exact | token | 13b-api-domain-routes.js:199 | frontend-domains.static.e2e.js, session-storage-v2.e2e.js, storage-steward.e2e.js |
| POST | `/api/checkpoints/rollback` | exact | token | 13b-api-domain-routes.js:214 | artifacts.e2e.js, checkpoint-coverage.e2e.js, checkpoint.e2e.js 等 10 件 |
| POST | `/api/session/rewind` | exact | token | 13b-api-domain-routes.js:245 | rewind.e2e.js, steward-conversation.e2e.js, steward-conversation.static.e2e.js 等 5 件 |

## core-inline(65)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/bootstrap` | exact | open | 13-http-router.js:256 | context-compact-v2.e2e.js, dom-smoke.e2e.js, external-code-diff.e2e.js 等 11 件 |
| GET | `/api/status` | exact | open | 13-http-router.js:262 | audit-w23.e2e.js, auth-deny-default.e2e.js, capabilities.e2e.js 等 31 件 |
| GET | `/api/capabilities` | exact | open | 13-http-router.js:339 | capabilities.e2e.js, playbooks.e2e.js |
| GET | `/api/playbooks` | exact | token-browser | 13-http-router.js:348 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 5 件 |
| POST | `/api/playbooks/draft` | exact | token | 13-http-router.js:355 | playbooks.e2e.js |
| POST | `/api/playbooks` | exact | token | 13-http-router.js:362 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 5 件 |
| DELETE/POST | `/api/playbooks/` | prefix | token | 13-http-router.js:371 | auth-deny-default.e2e.js, playbooks.e2e.js |
| POST | `/api/workspace/resolve` | exact | token | 13-http-router.js:380 | workspace-resolve.e2e.js |
| POST | `/api/pick-folder` | exact | token | 13-http-router.js:391 | workspace-resolve.e2e.js |
| POST | `/api/pick-file` | exact | token | 13-http-router.js:395 | overlay-update-gui.static.e2e.js |
| GET | `/api/models` | exact | open | 13-http-router.js:399 | claude-models-cache.e2e.js, context-window.e2e.js, kimi-agent-cli.e2e.js 等 4 件 |
| POST | `/api/config` | exact | token | 13-http-router.js:427 | agent-team-mode.e2e.js, claude-models-cache.e2e.js, config-providers-guard.e2e.js 等 30 件 |
| GET | `/api/agent-roles` | exact | token-browser | 13-http-router.js:442 | auth-deny-default.e2e.js, frontend-domains.static.e2e.js, meta-guard.e2e.js |
| POST | `/api/agent-roles` | exact | token | 13-http-router.js:455 | auth-deny-default.e2e.js, frontend-domains.static.e2e.js, meta-guard.e2e.js |
| GET | `/api/agent-workflows` | exact | token-browser | 13-http-router.js:469 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| POST | `/api/agent-workflows` | exact | token | 13-http-router.js:474 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| DELETE/POST | `/api/agent-workflows/` | prefix | token | 13-http-router.js:481 | auth-deny-default.e2e.js |
| POST | `/api/provider/test` | exact | token | 13-http-router.js:486 | audit-w23.e2e.js, meta-guard.e2e.js, onboarding.e2e.js 等 4 件 |
| GET | `/api/skills` | exact | token-browser | 13-http-router.js:516 | audit-w23.e2e.js, meta-guard.e2e.js, skills-registry.e2e.js |
| POST | `/api/session/skills` | exact | token-browser | 13-http-router.js:541 | claude-cmdline-guard.e2e.js, index-dedup.e2e.js, skills-registry.e2e.js 等 5 件 |
| DELETE | `/api/skills` | exact | token | 13-http-router.js:551 | audit-w23.e2e.js, meta-guard.e2e.js, skills-registry.e2e.js |
| POST | `/api/session/memories` | exact | token-browser | 13-http-router.js:572 | workbench-memory.e2e.js |
| GET | `/api/memory` | exact | token self | 13-http-router.js:622 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 5 件 |
| GET | `/api/memory/item` | exact | token self | 13-http-router.js:636 | workbench-memory.e2e.js |
| POST | `/api/memory/proposal` | exact | token-browser | 13-http-router.js:649 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/decision` | exact | token-browser | 13-http-router.js:656 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/apply` | exact | token-browser | 13-http-router.js:665 | — |
| POST | `/api/memory/draft` | exact | token-browser | 13-http-router.js:676 | workbench-memory.e2e.js |
| POST | `/api/memory/migrate` | exact | token-browser | 13-http-router.js:683 | workbench-memory.e2e.js |
| POST | `/api/memory/metadata` | exact | token-browser | 13-http-router.js:694 | — |
| POST | `/api/memory` | exact | token-browser | 13-http-router.js:712 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 5 件 |
| GET | `/api/memory/relations` | exact | token self | 13-http-router.js:734 | agent-quality-workflow.e2e.js, workbench-memory.e2e.js |
| GET | `/api/memory/maintenance` | exact | token self | 13-http-router.js:747 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/propose` | exact | token-browser | 13-http-router.js:760 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/confirm` | exact | token-browser | 13-http-router.js:769 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/relations/` | prefix | token-browser | 13-http-router.js:777 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/` | prefix | token-browser | 13-http-router.js:786 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 4 件 |
| POST | `/api/stop` | exact | token-browser | 13-http-router.js:796 | kimi-agent-cli.e2e.js, steward-conversation.e2e.js, steward-conversation.static.e2e.js 等 6 件 |
| POST | `/api/provider/compact` | exact | token-browser | 13-http-router.js:811 | context-compact-v2.e2e.js, provider-compact.e2e.js, summary-entity-check.e2e.js 等 4 件 |
| POST | `/api/agent/compact` | exact | token-browser | 13-http-router.js:820 | — |
| GET | `/api/kimi/status` | exact | token-browser | 13-http-router.js:837 | — |
| POST | `/api/todo` | exact | body-token | 13-http-router.js:853 | todo-loopback.e2e.js |
| GET/POST | `/api/mission` | exact | body-token self | 13-http-router.js:873 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, auth-deny-default.e2e.js 等 42 件 |
| * | `/api/autonomy/grants` | exact | token self | 13-http-router.js:978 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/grant` | exact | token self | 13-http-router.js:985 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/revoke` | exact | token self | 13-http-router.js:1013 | autonomy-grant.e2e.js |
| POST | `/api/agent-workflow/launch` | exact | body-token | 13-http-router.js:1026 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 28 件 |
| GET | `/api/usage/summary` | exact | token self | 13-http-router.js:1080 | usage-dashboard.e2e.js, usage-ledger.e2e.js, usage-subagent-ledger.e2e.js |
| GET | `/api/ops/metrics` | exact | token self | 13-http-router.js:1092 | monitor-incremental.e2e.js |
| GET | `/api/checkpoints` | exact | token self | 13-http-router.js:1101 | artifacts.e2e.js, changes-diff.e2e.js, checkpoint-coverage.e2e.js 等 16 件 |
| POST | `/api/checkpoints/open-external` | exact | token | 13-http-router.js:1122 | external-code-diff.e2e.js |
| GET | `/api/checkpoints/diff` | exact | token self | 13-http-router.js:1193 | changes-diff.e2e.js, frontend-domains.static.e2e.js, i18n.e2e.js |
| GET | `/api/help/doc` | exact | token self | 13-http-router.js:1235 | help-viewer.e2e.js, onboarding.static.e2e.js |
| POST | `/api/open-path` | exact | token self | 13-http-router.js:1265 | copy-path-guard.static.e2e.js, help-menu.e2e.js |
| GET | `/api/logs/tail` | exact | token self | 13-http-router.js:1292 | help-menu.e2e.js |
| GET | `/api/file/preview` | exact | token self | 13-http-router.js:1325 | artifacts.e2e.js, audit-w23.e2e.js, frontend-domains.static.e2e.js 等 7 件 |
| POST | `/api/file/reveal` | exact | token | 13-http-router.js:1362 | artifacts.e2e.js, copy-path-guard.static.e2e.js, help-menu.e2e.js 等 5 件 |
| GET | `/api/audit` | exact | token self | 13-http-router.js:1393 | audit.e2e.js, auth-deny-default.e2e.js, autonomy-grant.e2e.js 等 6 件 |
| GET | `/api/storage/summary` | exact | token self | 13-http-router.js:1410 | frontend-domains.static.e2e.js, metrics-panel.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| GET | `/api/metrics` | exact | token self | 13-http-router.js:1422 | frontend-domains.static.e2e.js, metrics-panel.e2e.js |
| POST | `/api/upload` | exact | token-browser | 13-http-router.js:1441 | pretender-dispatch-home.static.e2e.js, vision-loop.e2e.js |
| GET | `/api/upload/content` | exact | token self | 13-http-router.js:1449 | — |
| POST | `/api/chat/stream` | exact | token-browser | 13-http-router.js:1469 | action-model-view.e2e.js, adaptive-budget.e2e.js, agent-loop.e2e.js 等 111 件 |
| POST | `/api/tools/` | prefix | token | 13-http-router.js:1481 | audit-w23.e2e.js, autonomy-shell-sandbox.e2e.js, checkpoint.e2e.js 等 13 件 |
| * | `/health` | exact | host-gate | 13-http-router.js:1753 | — |

## intervention(11)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/_test/pretender-maintenance` | exact | token | 13d-core-domain-routes.js:1356 | pretender-index-scale.e2e.js |
| POST | `/api/missions/:missionId/interventions/:interventionId/decision` | regex | token | 13d-core-domain-routes.js:1370 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| GET | `/api/interventions` | exact | token-browser self | 13d-core-domain-routes.js:1395 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, interventions-persist.e2e.js 等 13 件 |
| GET | `/api/interventions/` | prefix | token-browser self | 13d-core-domain-routes.js:1448 | interventions-persist.e2e.js, pretender-index-scale.e2e.js, pretender-needs-drawer.e2e.js |
| POST | `/api/chat/answer` | exact | token-browser | 13d-core-domain-routes.js:1484 | interactive-question.e2e.js, intervention-mission-gate.e2e.js, interventions-c4.e2e.js 等 12 件 |
| POST | `/api/question/heartbeat` | exact | token-browser | 13d-core-domain-routes.js:1504 | — |
| POST | `/api/question/request` | exact | body-token | 13d-core-domain-routes.js:1514 | — |
| POST | `/api/permission/request` | exact | body-token | 13d-core-domain-routes.js:1529 | — |
| POST | `/api/permission/decision` | exact | token-browser | 13d-core-domain-routes.js:1615 | autonomy-pause.e2e.js, claude-binary-live.e2e.js, intervention-mission-gate.e2e.js 等 8 件 |
| POST | `/api/plan/decision` | exact | token | 13d-core-domain-routes.js:1634 | intervention-mission-gate.e2e.js, interventions-snapshot.e2e.js, plan-mode.e2e.js 等 5 件 |
| POST | `/api/_test/intervention-cas` | exact | token self | 13d-core-domain-routes.js:1655 | interventions-cas.e2e.js, interventions-changeseq.e2e.js |

## mcp(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/mcp/import-folder` | exact | token | 13b-api-domain-routes.js:12 | mcp-config.e2e.js |
| POST | `/api/mcp/import-config/scan` | exact | token | 13b-api-domain-routes.js:55 | mcp-import-config.e2e.js |
| POST | `/api/mcp/import-config/apply` | exact | token | 13b-api-domain-routes.js:67 | copy-path-guard.static.e2e.js, mcp-import-config.e2e.js |
| GET | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js:100 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| POST | `/api/mcp/connectors/health` | exact | token | 13b-api-domain-routes.js:110 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| POST | `/api/mcp/connectors/toggle` | exact | token | 13b-api-domain-routes.js:128 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| DELETE | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js:151 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |

## mission(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/missions` | exact | token-browser self | 13d-core-domain-routes.js:695 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 31 件 |
| POST | `/api/missions` | exact | token self | 13d-core-domain-routes.js:721 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 31 件 |
| PATCH/POST | `/api/missions/:missionId` | regex | token self | 13d-core-domain-routes.js:728 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/threads` | regex | token self | 13d-core-domain-routes.js:738 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/merge` | regex | token self | 13d-core-domain-routes.js:753 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/split` | regex | token self | 13d-core-domain-routes.js:762 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| GET | `/api/missions/` | prefix | token-browser self | 13d-core-domain-routes.js:812 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |

## overlay(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/overlay/precheck` | exact | token | 13c-overlay-routes.js:127 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/apply` | exact | token | 13c-overlay-routes.js:147 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| GET | `/api/overlay/status` | exact | token self | 13c-overlay-routes.js:168 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/rollback` | exact | token | 13c-overlay-routes.js:179 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |

## session(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:210 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-parent-heartbeat.e2e.js 等 131 件 |
| GET | `/api/sessions/search` | exact | token self | 13d-core-domain-routes.js:216 | session-search.e2e.js, steward-runner.e2e.js |
| POST | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:228 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-parent-heartbeat.e2e.js 等 131 件 |
| POST | `/api/sessions/bulk-delete` | exact | token-browser | 13d-core-domain-routes.js:234 | session-bulk-cleanup.e2e.js |
| DELETE/GET/PATCH/POST | `/api/sessions/` | prefix | token-browser | 13d-core-domain-routes.js:241 | agent-roles.e2e.js, artifacts.e2e.js, audit-w23.e2e.js 等 59 件 |

## steer(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steer` | exact | token | 13b-api-domain-routes.js:328 | agent-steer-node.e2e.js, kimi-agent-cli.e2e.js, long-tool-liveness-steer.e2e.js 等 7 件 |
| DELETE | `/api/steer` | exact | token | 13b-api-domain-routes.js:337 | agent-steer-node.e2e.js, kimi-agent-cli.e2e.js, long-tool-liveness-steer.e2e.js 等 7 件 |

## steward(18)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steward/start` | exact | token self | 13g-steward.js:42 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-settings.static.e2e.js 等 4 件 |
| POST | `/api/steward/stop` | exact | token self | 13g-steward.js:52 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-preroute.e2e.js 等 4 件 |
| GET | `/api/steward/state` | exact | token self | 13g-steward.js:58 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-runner.e2e.js 等 6 件 |
| GET | `/api/steward/inbox` | exact | token self | 13g-steward.js:70 | steward-events.static.e2e.js, steward-inbox.e2e.js |
| GET | `/api/steward/preroute` | exact | token self | 13g-steward.js:81 | steward-conversation.static.e2e.js, steward-preroute.e2e.js |
| GET | `/api/steward/memory` | exact | token | 13g-steward.js:103 | steward-memory.e2e.js, steward-settings.e2e.js, steward-settings.static.e2e.js |
| GET | `/api/steward/memory/export` | exact | token | 13g-steward.js:109 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/edit` | exact | token | 13g-steward.js:114 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/veto` | exact | token | 13g-steward.js:120 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/restore` | exact | token | 13g-steward.js:127 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/clear` | exact | token | 13g-steward.js:134 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| GET | `/api/steward/decisions` | exact | token | 13g-steward.js:144 | steward-decisions.e2e.js, steward-settings.e2e.js, steward-settings.static.e2e.js |
| GET | `/api/steward/arbiter` | exact | token self | 13h-steward-runner.js:2127 | steward-board.e2e.js, steward-board.static.e2e.js, steward-config-tools.e2e.js 等 5 件 |
| POST | `/api/steward/arbiter/prioritize` | exact | token self | 13h-steward-runner.js:2136 | steward-board.static.e2e.js, thread-arbiter.e2e.js |
| POST | `/api/steward/visit` | exact | token self | 13h-steward-runner.js:2158 | steward-conversation.e2e.js, steward-conversation.static.e2e.js, steward-runner.e2e.js 等 4 件 |
| POST | `/api/steward/act` | exact | token self | 13h-steward-runner.js:2170 | steward-conversation.e2e.js, steward-conversation.static.e2e.js, steward-relay-channels.e2e.js 等 7 件 |
| POST | `/api/steward/relay` | exact | token self | 13h-steward-runner.js:2187 | steward-relay-channels.e2e.js |
| POST | `/api/steward/message` | exact | token self | 13h-steward-runner.js:2216 | steward-conversation.static.e2e.js, steward-guardrails.e2e.js, steward-relay-channels.e2e.js 等 5 件 |

## 域路由委派(handleApi → 域 handler)

- 13-http-router.js:510 → `handleSessionApiRoutes`
- 13-http-router.js:512 → `handleMissionsApiRoutes`
- 13-http-router.js:852 → `handleInterventionApiRoutes`
- 13-http-router.js:1100 → `handleAgentRunApiRoutes`
- 13-http-router.js:1388 → `handleMcpApiRoutes`
- 13-http-router.js:1432 → `handleCheckpointApiRoutes`
- 13-http-router.js:1434 → `handleSteerApiRoute`
- 13-http-router.js:1436 → `handleOverlayApiRoutes`
