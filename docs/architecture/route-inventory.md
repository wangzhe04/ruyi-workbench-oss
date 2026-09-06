# 路由清册(第 103 波 103a · 机器生成)

> 由 `dev-harness/route-inventory.js` 生成,`route-inventory.static.e2e.js` 重算比对;手改无效。
> 判定点 127(精确 110 / 前缀 12 / 正则 5),ROUTE_AUTH 115 条,生成于 2026-09-06T12:07:13.265Z。

鉴权级别:`open` 低敏读 · `origin` 同源 · `token` 始终 token · `token-browser` 浏览器须 token/loopback 须同源 · `body-token` handler 自查 body token · `host-gate` 顶层 host 门(非 /api)。`self` = handler 内另有 tokenOk 纵深自查。

## agent-run(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/agent-runs` | exact | token self | 13d-core-domain-routes.js:1690 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 32 件 |
| GET | `/api/agent-runs/…/events` | prefix | token self | 13d-core-domain-routes.js:1729 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 21 件 |
| POST | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:1740 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 21 件 |
| DELETE | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:1798 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 21 件 |
| GET | `/api/agent-runs/` | prefix | token self | 13d-core-domain-routes.js:1818 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 21 件 |

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
| POST | `/api/bootstrap` | exact | open | 13-http-router.js:234 | context-compact-v2.e2e.js, dom-smoke.e2e.js, external-code-diff.e2e.js 等 11 件 |
| GET | `/api/status` | exact | open | 13-http-router.js:240 | audit-w23.e2e.js, auth-deny-default.e2e.js, capabilities.e2e.js 等 31 件 |
| GET | `/api/capabilities` | exact | open | 13-http-router.js:317 | capabilities.e2e.js, playbooks.e2e.js |
| GET | `/api/playbooks` | exact | token-browser | 13-http-router.js:326 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 5 件 |
| POST | `/api/playbooks/draft` | exact | token | 13-http-router.js:333 | playbooks.e2e.js |
| POST | `/api/playbooks` | exact | token | 13-http-router.js:340 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 5 件 |
| DELETE/POST | `/api/playbooks/` | prefix | token | 13-http-router.js:349 | auth-deny-default.e2e.js, playbooks.e2e.js |
| POST | `/api/workspace/resolve` | exact | token | 13-http-router.js:358 | workspace-resolve.e2e.js |
| POST | `/api/pick-folder` | exact | token | 13-http-router.js:369 | workspace-resolve.e2e.js |
| POST | `/api/pick-file` | exact | token | 13-http-router.js:373 | overlay-update-gui.static.e2e.js |
| GET | `/api/models` | exact | open | 13-http-router.js:377 | claude-models-cache.e2e.js, context-window.e2e.js, kimi-agent-cli.e2e.js 等 4 件 |
| POST | `/api/config` | exact | token | 13-http-router.js:405 | agent-team-mode.e2e.js, claude-models-cache.e2e.js, config-providers-guard.e2e.js 等 27 件 |
| GET | `/api/agent-roles` | exact | token-browser | 13-http-router.js:410 | auth-deny-default.e2e.js, frontend-domains.static.e2e.js, meta-guard.e2e.js |
| POST | `/api/agent-roles` | exact | token | 13-http-router.js:423 | auth-deny-default.e2e.js, frontend-domains.static.e2e.js, meta-guard.e2e.js |
| GET | `/api/agent-workflows` | exact | token-browser | 13-http-router.js:437 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| POST | `/api/agent-workflows` | exact | token | 13-http-router.js:442 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| DELETE/POST | `/api/agent-workflows/` | prefix | token | 13-http-router.js:449 | auth-deny-default.e2e.js |
| POST | `/api/provider/test` | exact | token | 13-http-router.js:454 | audit-w23.e2e.js, meta-guard.e2e.js, onboarding.e2e.js 等 4 件 |
| GET | `/api/skills` | exact | token-browser | 13-http-router.js:484 | audit-w23.e2e.js, meta-guard.e2e.js, skills-registry.e2e.js |
| POST | `/api/session/skills` | exact | token-browser | 13-http-router.js:509 | claude-cmdline-guard.e2e.js, index-dedup.e2e.js, skills-registry.e2e.js 等 5 件 |
| DELETE | `/api/skills` | exact | token | 13-http-router.js:519 | audit-w23.e2e.js, meta-guard.e2e.js, skills-registry.e2e.js |
| POST | `/api/session/memories` | exact | token-browser | 13-http-router.js:540 | workbench-memory.e2e.js |
| GET | `/api/memory` | exact | token self | 13-http-router.js:590 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 5 件 |
| GET | `/api/memory/item` | exact | token self | 13-http-router.js:604 | workbench-memory.e2e.js |
| POST | `/api/memory/proposal` | exact | token-browser | 13-http-router.js:617 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/decision` | exact | token-browser | 13-http-router.js:624 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/apply` | exact | token-browser | 13-http-router.js:633 | — |
| POST | `/api/memory/draft` | exact | token-browser | 13-http-router.js:644 | workbench-memory.e2e.js |
| POST | `/api/memory/migrate` | exact | token-browser | 13-http-router.js:651 | workbench-memory.e2e.js |
| POST | `/api/memory/metadata` | exact | token-browser | 13-http-router.js:662 | — |
| POST | `/api/memory` | exact | token-browser | 13-http-router.js:680 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 5 件 |
| GET | `/api/memory/relations` | exact | token self | 13-http-router.js:702 | agent-quality-workflow.e2e.js, workbench-memory.e2e.js |
| GET | `/api/memory/maintenance` | exact | token self | 13-http-router.js:715 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/propose` | exact | token-browser | 13-http-router.js:728 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/confirm` | exact | token-browser | 13-http-router.js:737 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/relations/` | prefix | token-browser | 13-http-router.js:745 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/` | prefix | token-browser | 13-http-router.js:754 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 4 件 |
| POST | `/api/stop` | exact | token-browser | 13-http-router.js:764 | kimi-agent-cli.e2e.js, steward-conversation.e2e.js, steward-conversation.static.e2e.js 等 6 件 |
| POST | `/api/provider/compact` | exact | token-browser | 13-http-router.js:779 | context-compact-v2.e2e.js, provider-compact.e2e.js, summary-entity-check.e2e.js 等 4 件 |
| POST | `/api/agent/compact` | exact | token-browser | 13-http-router.js:788 | — |
| GET | `/api/kimi/status` | exact | token-browser | 13-http-router.js:805 | — |
| POST | `/api/todo` | exact | body-token | 13-http-router.js:821 | todo-loopback.e2e.js |
| GET/POST | `/api/mission` | exact | body-token self | 13-http-router.js:841 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, auth-deny-default.e2e.js 等 40 件 |
| * | `/api/autonomy/grants` | exact | token self | 13-http-router.js:946 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/grant` | exact | token self | 13-http-router.js:953 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/revoke` | exact | token self | 13-http-router.js:981 | autonomy-grant.e2e.js |
| POST | `/api/agent-workflow/launch` | exact | body-token | 13-http-router.js:994 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 28 件 |
| GET | `/api/usage/summary` | exact | token self | 13-http-router.js:1048 | usage-dashboard.e2e.js, usage-ledger.e2e.js, usage-subagent-ledger.e2e.js |
| GET | `/api/ops/metrics` | exact | token self | 13-http-router.js:1060 | monitor-incremental.e2e.js |
| GET | `/api/checkpoints` | exact | token self | 13-http-router.js:1069 | artifacts.e2e.js, changes-diff.e2e.js, checkpoint-coverage.e2e.js 等 16 件 |
| POST | `/api/checkpoints/open-external` | exact | token | 13-http-router.js:1090 | external-code-diff.e2e.js |
| GET | `/api/checkpoints/diff` | exact | token self | 13-http-router.js:1161 | changes-diff.e2e.js, frontend-domains.static.e2e.js, i18n.e2e.js |
| GET | `/api/help/doc` | exact | token self | 13-http-router.js:1203 | help-viewer.e2e.js, onboarding.static.e2e.js |
| POST | `/api/open-path` | exact | token self | 13-http-router.js:1233 | copy-path-guard.static.e2e.js, help-menu.e2e.js |
| GET | `/api/logs/tail` | exact | token self | 13-http-router.js:1260 | help-menu.e2e.js |
| GET | `/api/file/preview` | exact | token self | 13-http-router.js:1293 | artifacts.e2e.js, audit-w23.e2e.js, frontend-domains.static.e2e.js 等 7 件 |
| POST | `/api/file/reveal` | exact | token | 13-http-router.js:1330 | artifacts.e2e.js, copy-path-guard.static.e2e.js, help-menu.e2e.js 等 5 件 |
| GET | `/api/audit` | exact | token self | 13-http-router.js:1361 | audit.e2e.js, auth-deny-default.e2e.js, autonomy-grant.e2e.js 等 6 件 |
| GET | `/api/storage/summary` | exact | token self | 13-http-router.js:1378 | frontend-domains.static.e2e.js, metrics-panel.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| GET | `/api/metrics` | exact | token self | 13-http-router.js:1390 | frontend-domains.static.e2e.js, metrics-panel.e2e.js |
| POST | `/api/upload` | exact | token-browser | 13-http-router.js:1409 | pretender-dispatch-home.static.e2e.js, vision-loop.e2e.js |
| GET | `/api/upload/content` | exact | token self | 13-http-router.js:1417 | — |
| POST | `/api/chat/stream` | exact | token-browser | 13-http-router.js:1437 | action-model-view.e2e.js, adaptive-budget.e2e.js, agent-loop.e2e.js 等 109 件 |
| POST | `/api/tools/` | prefix | token | 13-http-router.js:1440 | audit-w23.e2e.js, autonomy-shell-sandbox.e2e.js, checkpoint.e2e.js 等 13 件 |
| * | `/health` | exact | host-gate | 13-http-router.js:1712 | — |

## intervention(11)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/_test/pretender-maintenance` | exact | token | 13d-core-domain-routes.js:1284 | pretender-index-scale.e2e.js |
| POST | `/api/missions/:missionId/interventions/:interventionId/decision` | regex | token | 13d-core-domain-routes.js:1298 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| GET | `/api/interventions` | exact | token-browser self | 13d-core-domain-routes.js:1323 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, interventions-persist.e2e.js 等 11 件 |
| GET | `/api/interventions/` | prefix | token-browser self | 13d-core-domain-routes.js:1376 | interventions-persist.e2e.js, pretender-index-scale.e2e.js, pretender-needs-drawer.e2e.js |
| POST | `/api/chat/answer` | exact | token-browser | 13d-core-domain-routes.js:1412 | interactive-question.e2e.js, intervention-mission-gate.e2e.js, interventions-c4.e2e.js 等 12 件 |
| POST | `/api/question/heartbeat` | exact | token-browser | 13d-core-domain-routes.js:1432 | — |
| POST | `/api/question/request` | exact | body-token | 13d-core-domain-routes.js:1442 | — |
| POST | `/api/permission/request` | exact | body-token | 13d-core-domain-routes.js:1457 | — |
| POST | `/api/permission/decision` | exact | token-browser | 13d-core-domain-routes.js:1543 | autonomy-pause.e2e.js, claude-binary-live.e2e.js, intervention-mission-gate.e2e.js 等 8 件 |
| POST | `/api/plan/decision` | exact | token | 13d-core-domain-routes.js:1562 | intervention-mission-gate.e2e.js, interventions-snapshot.e2e.js, plan-mode.e2e.js 等 5 件 |
| POST | `/api/_test/intervention-cas` | exact | token self | 13d-core-domain-routes.js:1583 | interventions-cas.e2e.js, interventions-changeseq.e2e.js |

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
| GET | `/api/missions` | exact | token-browser self | 13d-core-domain-routes.js:624 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 29 件 |
| POST | `/api/missions` | exact | token self | 13d-core-domain-routes.js:650 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 29 件 |
| PATCH/POST | `/api/missions/:missionId` | regex | token self | 13d-core-domain-routes.js:657 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/threads` | regex | token self | 13d-core-domain-routes.js:667 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/merge` | regex | token self | 13d-core-domain-routes.js:682 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/split` | regex | token self | 13d-core-domain-routes.js:691 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |
| GET | `/api/missions/` | prefix | token-browser self | 13d-core-domain-routes.js:741 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, bridged-read-noprompt.e2e.js 等 24 件 |

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
| GET | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:199 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-parent-heartbeat.e2e.js 等 127 件 |
| GET | `/api/sessions/search` | exact | token self | 13d-core-domain-routes.js:205 | session-search.e2e.js, steward-runner.e2e.js |
| POST | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:217 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-parent-heartbeat.e2e.js 等 127 件 |
| POST | `/api/sessions/bulk-delete` | exact | token-browser | 13d-core-domain-routes.js:223 | session-bulk-cleanup.e2e.js |
| DELETE/GET/PATCH/POST | `/api/sessions/` | prefix | token-browser | 13d-core-domain-routes.js:230 | agent-roles.e2e.js, artifacts.e2e.js, audit-w23.e2e.js 等 56 件 |

## steer(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steer` | exact | token | 13b-api-domain-routes.js:328 | agent-steer-node.e2e.js, kimi-agent-cli.e2e.js, long-tool-liveness-steer.e2e.js 等 7 件 |
| DELETE | `/api/steer` | exact | token | 13b-api-domain-routes.js:337 | agent-steer-node.e2e.js, kimi-agent-cli.e2e.js, long-tool-liveness-steer.e2e.js 等 7 件 |

## steward(17)

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
| GET | `/api/steward/arbiter` | exact | token self | 13h-steward-runner.js:1702 | steward-board.e2e.js, steward-board.static.e2e.js, steward-config-tools.e2e.js 等 5 件 |
| POST | `/api/steward/arbiter/prioritize` | exact | token self | 13h-steward-runner.js:1711 | steward-board.static.e2e.js, thread-arbiter.e2e.js |
| POST | `/api/steward/visit` | exact | token self | 13h-steward-runner.js:1725 | steward-conversation.e2e.js, steward-conversation.static.e2e.js, steward-runner.e2e.js 等 4 件 |
| POST | `/api/steward/act` | exact | token self | 13h-steward-runner.js:1737 | steward-conversation.e2e.js, steward-conversation.static.e2e.js, steward-runner.e2e.js 等 6 件 |
| POST | `/api/steward/message` | exact | token self | 13h-steward-runner.js:1749 | steward-conversation.static.e2e.js, steward-runner.e2e.js, steward-runner.static.e2e.js |

## 域路由委派(handleApi → 域 handler)

- 13-http-router.js:478 → `handleSessionApiRoutes`
- 13-http-router.js:480 → `handleMissionsApiRoutes`
- 13-http-router.js:820 → `handleInterventionApiRoutes`
- 13-http-router.js:1068 → `handleAgentRunApiRoutes`
- 13-http-router.js:1356 → `handleMcpApiRoutes`
- 13-http-router.js:1400 → `handleCheckpointApiRoutes`
- 13-http-router.js:1402 → `handleSteerApiRoute`
- 13-http-router.js:1404 → `handleOverlayApiRoutes`
