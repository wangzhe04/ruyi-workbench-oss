# 路由清册(第 103 波 103a · 机器生成)

> 由 `dev-harness/route-inventory.js` 生成,`route-inventory.static.e2e.js` 重算比对;手改无效。
> 判定点 135(精确 114 / 前缀 12 / 正则 9),ROUTE_AUTH 123 条,生成于 2026-09-15T02:28:25.406Z。

鉴权级别:`open` 低敏读 · `origin` 同源 · `token` 始终 token · `token-browser` 浏览器须 token/loopback 须同源 · `body-token` handler 自查 body token · `host-gate` 顶层 host 门(非 /api)。`self` = handler 内另有 tokenOk 纵深自查。

## agent-run(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/agent-runs` | exact | token self | 13d-core-domain-routes.js:1950 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 27 件 |
| GET | `/api/agent-runs/…/events` | prefix | token self | 13d-core-domain-routes.js:1989 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 16 件 |
| POST | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:2000 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 16 件 |
| DELETE | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:2058 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 16 件 |
| GET | `/api/agent-runs/` | prefix | token self | 13d-core-domain-routes.js:2078 | agent-deadlock-watchdog.e2e.js, agent-steer-node.e2e.js, autonomy-durability.e2e.js 等 16 件 |

## checkpoint-storage(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/storage/policy` | exact | token | 13b-api-domain-routes.js:169 | config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| POST | `/api/storage/clean` | exact | token | 13b-api-domain-routes.js:181 | frontend-domains.static.e2e.js, session-storage-v2.e2e.js, storage-steward.e2e.js |
| POST | `/api/checkpoints/rollback` | exact | token | 13b-api-domain-routes.js:196 | artifacts.e2e.js, checkpoint-coverage.e2e.js, checkpoint.e2e.js 等 6 件 |
| POST | `/api/session/rewind` | exact | token | 13b-api-domain-routes.js:227 | rewind.e2e.js, steward-conversation.e2e.js, steward-conversation.static.e2e.js 等 6 件 |

## core-inline(65)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/bootstrap` | exact | open | 13-http-router.js:271 | context-compact-v2.e2e.js, dom-smoke.e2e.js, external-code-diff.e2e.js 等 12 件 |
| GET | `/api/status` | exact | open | 13-http-router.js:277 | audit-w23.e2e.js, auth-deny-default.e2e.js, boot-listen-budget.e2e.js 等 40 件 |
| GET | `/api/capabilities` | exact | open | 13-http-router.js:357 | capabilities.e2e.js, playbooks.e2e.js |
| GET | `/api/playbooks` | exact | token-browser | 13-http-router.js:366 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 4 件 |
| POST | `/api/playbooks/draft` | exact | token | 13-http-router.js:373 | playbooks.e2e.js |
| POST | `/api/playbooks` | exact | token | 13-http-router.js:380 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 4 件 |
| DELETE/POST | `/api/playbooks/` | prefix | token | 13-http-router.js:389 | auth-deny-default.e2e.js, playbooks.e2e.js |
| POST | `/api/workspace/resolve` | exact | token | 13-http-router.js:398 | workspace-resolve.e2e.js |
| POST | `/api/pick-folder` | exact | token | 13-http-router.js:409 | workspace-resolve.e2e.js |
| POST | `/api/pick-file` | exact | token | 13-http-router.js:413 | overlay-update-gui.static.e2e.js |
| GET | `/api/models` | exact | open | 13-http-router.js:417 | claude-models-cache.e2e.js, context-window.e2e.js, kimi-agent-cli.e2e.js 等 4 件 |
| POST | `/api/config` | exact | token | 13-http-router.js:467 | agent-team-mode.e2e.js, claude-models-cache.e2e.js, config-providers-guard.e2e.js 等 36 件 |
| GET | `/api/agent-roles` | exact | token-browser | 13-http-router.js:482 | auth-deny-default.e2e.js, config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js 等 4 件 |
| POST | `/api/agent-roles` | exact | token | 13-http-router.js:495 | auth-deny-default.e2e.js, config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js 等 4 件 |
| GET | `/api/agent-workflows` | exact | token-browser | 13-http-router.js:510 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| POST | `/api/agent-workflows` | exact | token | 13-http-router.js:515 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| DELETE/POST | `/api/agent-workflows/` | prefix | token | 13-http-router.js:522 | auth-deny-default.e2e.js |
| POST | `/api/provider/test` | exact | token | 13-http-router.js:527 | audit-w23.e2e.js, meta-guard.e2e.js, onboarding.e2e.js 等 4 件 |
| GET | `/api/skills` | exact | token-browser | 13-http-router.js:557 | audit-w23.e2e.js, meta-guard.e2e.js, skills-registry.e2e.js |
| POST | `/api/session/skills` | exact | token-browser | 13-http-router.js:582 | claude-cmdline-guard.e2e.js, index-dedup.e2e.js, skills-registry.e2e.js 等 5 件 |
| DELETE | `/api/skills` | exact | token | 13-http-router.js:592 | audit-w23.e2e.js, meta-guard.e2e.js, skills-registry.e2e.js |
| POST | `/api/session/memories` | exact | token-browser | 13-http-router.js:613 | workbench-memory.e2e.js |
| GET | `/api/memory` | exact | token self | 13-http-router.js:663 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 5 件 |
| GET | `/api/memory/item` | exact | token self | 13-http-router.js:677 | workbench-memory.e2e.js |
| POST | `/api/memory/proposal` | exact | token-browser | 13-http-router.js:690 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/decision` | exact | token-browser | 13-http-router.js:697 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/apply` | exact | token-browser | 13-http-router.js:706 | — |
| POST | `/api/memory/draft` | exact | token-browser | 13-http-router.js:717 | workbench-memory.e2e.js |
| POST | `/api/memory/migrate` | exact | token-browser | 13-http-router.js:724 | workbench-memory.e2e.js |
| POST | `/api/memory/metadata` | exact | token-browser | 13-http-router.js:735 | — |
| POST | `/api/memory` | exact | token-browser | 13-http-router.js:753 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 5 件 |
| GET | `/api/memory/relations` | exact | token self | 13-http-router.js:775 | agent-quality-workflow.e2e.js, workbench-memory.e2e.js |
| GET | `/api/memory/maintenance` | exact | token self | 13-http-router.js:788 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/propose` | exact | token-browser | 13-http-router.js:801 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/confirm` | exact | token-browser | 13-http-router.js:810 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/relations/` | prefix | token-browser | 13-http-router.js:818 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/` | prefix | token-browser | 13-http-router.js:827 | agent-quality-workflow.e2e.js, auth-deny-default.e2e.js, memory-auto-proposal-api.e2e.js 等 4 件 |
| POST | `/api/stop` | exact | token-browser | 13-http-router.js:837 | focus-rail.browser.e2e.js, kimi-agent-cli.e2e.js, live-full-text.static.e2e.js 等 10 件 |
| POST | `/api/provider/compact` | exact | token-browser | 13-http-router.js:861 | context-compact-v2.e2e.js, provider-compact.e2e.js, summary-entity-check.e2e.js 等 4 件 |
| POST | `/api/agent/compact` | exact | token-browser | 13-http-router.js:870 | — |
| GET | `/api/kimi/status` | exact | token-browser | 13-http-router.js:887 | — |
| POST | `/api/todo` | exact | body-token | 13-http-router.js:903 | todo-loopback.e2e.js |
| GET/POST | `/api/mission` | exact | body-token self | 13-http-router.js:923 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 53 件 |
| * | `/api/autonomy/grants` | exact | token self | 13-http-router.js:1029 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/grant` | exact | token self | 13-http-router.js:1036 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/revoke` | exact | token self | 13-http-router.js:1064 | autonomy-grant.e2e.js |
| POST | `/api/agent-workflow/launch` | exact | body-token | 13-http-router.js:1077 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 28 件 |
| GET | `/api/usage/summary` | exact | token self | 13-http-router.js:1131 | steward-drawer.e2e.js, steward-drawer.static.e2e.js, steward-model-menu.test.js 等 7 件 |
| GET | `/api/ops/metrics` | exact | token self | 13-http-router.js:1146 | monitor-incremental.e2e.js |
| GET | `/api/checkpoints` | exact | token self | 13-http-router.js:1155 | artifacts.e2e.js, changes-diff.e2e.js, checkpoint-coverage.e2e.js 等 12 件 |
| POST | `/api/checkpoints/open-external` | exact | token | 13-http-router.js:1176 | external-code-diff.e2e.js |
| GET | `/api/checkpoints/diff` | exact | token self | 13-http-router.js:1247 | changes-diff.e2e.js, frontend-domains.static.e2e.js, i18n.e2e.js |
| GET | `/api/help/doc` | exact | token self | 13-http-router.js:1289 | help-viewer.e2e.js, onboarding.static.e2e.js |
| POST | `/api/open-path` | exact | token self | 13-http-router.js:1319 | copy-path-guard.static.e2e.js, help-menu.e2e.js |
| GET | `/api/logs/tail` | exact | token self | 13-http-router.js:1346 | help-menu.e2e.js |
| GET | `/api/file/preview` | exact | token self | 13-http-router.js:1379 | artifacts.e2e.js, audit-w23.e2e.js, frontend-domains.static.e2e.js 等 7 件 |
| POST | `/api/file/reveal` | exact | token | 13-http-router.js:1416 | artifacts.e2e.js, copy-path-guard.static.e2e.js, help-menu.e2e.js 等 4 件 |
| GET | `/api/audit` | exact | token self | 13-http-router.js:1447 | audit.e2e.js, auth-deny-default.e2e.js, autonomy-grant.e2e.js 等 6 件 |
| GET | `/api/storage/summary` | exact | token self | 13-http-router.js:1464 | frontend-domains.static.e2e.js, metrics-panel.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| GET | `/api/metrics` | exact | token self | 13-http-router.js:1476 | frontend-domains.static.e2e.js, metrics-panel.e2e.js |
| POST | `/api/upload` | exact | token-browser | 13-http-router.js:1506 | vision-loop.e2e.js |
| GET | `/api/upload/content` | exact | token self | 13-http-router.js:1514 | — |
| POST | `/api/chat/stream` | exact | token-browser | 13-http-router.js:1534 | a11y-walkthrough.browser.e2e.js, action-model-view.e2e.js, adaptive-budget.e2e.js 等 130 件 |
| POST | `/api/tools/` | prefix | token | 13-http-router.js:1552 | audit-w23.e2e.js, autonomy-shell-sandbox.e2e.js, checkpoint.e2e.js 等 13 件 |
| * | `/health` | exact | host-gate | 13-http-router.js:1827 | — |

## event-stream(1)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/events/stream` | exact | token-browser | 13r-event-stream.js:257 | event-stream-client.browser.e2e.js, event-stream-pageshow.browser.e2e.js, event-stream-replay.browser.e2e.js 等 8 件 |

## intervention(11)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/_test/pretender-maintenance` | exact | token | 13d-core-domain-routes.js:1536 | mission-index-scale.e2e.js |
| POST | `/api/missions/:missionId/interventions/:interventionId/decision` | regex | token | 13d-core-domain-routes.js:1550 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 23 件 |
| GET | `/api/interventions` | exact | token-browser self | 13d-core-domain-routes.js:1575 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, event-stream-client.browser.e2e.js 等 20 件 |
| GET | `/api/interventions/` | prefix | token-browser self | 13d-core-domain-routes.js:1628 | interventions-persist.e2e.js, mission-index-scale.e2e.js, steward-presence-gate.e2e.js |
| POST | `/api/chat/answer` | exact | token-browser | 13d-core-domain-routes.js:1664 | event-stream-client.browser.e2e.js, event-stream-replay.browser.e2e.js, event-stream.e2e.js 等 15 件 |
| POST | `/api/question/heartbeat` | exact | token-browser | 13d-core-domain-routes.js:1684 | — |
| POST | `/api/question/request` | exact | body-token | 13d-core-domain-routes.js:1694 | — |
| POST | `/api/permission/request` | exact | body-token | 13d-core-domain-routes.js:1709 | — |
| POST | `/api/permission/decision` | exact | token-browser | 13d-core-domain-routes.js:1803 | autonomy-pause.e2e.js, claude-binary-live.e2e.js, intervention-mission-gate.e2e.js 等 7 件 |
| POST | `/api/plan/decision` | exact | token | 13d-core-domain-routes.js:1822 | intervention-mission-gate.e2e.js, interventions-snapshot.e2e.js, plan-mode.e2e.js 等 5 件 |
| POST | `/api/_test/intervention-cas` | exact | token self | 13d-core-domain-routes.js:1843 | interventions-cas.e2e.js, interventions-changeseq.e2e.js |

## mcp(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/mcp/import-folder` | exact | token | 13b-api-domain-routes.js:12 | mcp-config.e2e.js |
| POST | `/api/mcp/import-config/scan` | exact | token | 13b-api-domain-routes.js:61 | mcp-import-config.e2e.js |
| POST | `/api/mcp/import-config/apply` | exact | token | 13b-api-domain-routes.js:73 | copy-path-guard.static.e2e.js, mcp-import-config.e2e.js, mcp-import-origin.e2e.js |
| GET | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js:111 | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| POST | `/api/mcp/connectors/health` | exact | token | 13b-api-domain-routes.js:121 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| POST | `/api/mcp/connectors/toggle` | exact | token | 13b-api-domain-routes.js:141 | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |
| DELETE | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js:154 | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js |

## mission(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/missions` | exact | token-browser self | 13d-core-domain-routes.js:827 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 40 件 |
| POST | `/api/missions` | exact | token self | 13d-core-domain-routes.js:882 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 40 件 |
| PATCH/POST | `/api/missions/:missionId` | regex | token self | 13d-core-domain-routes.js:889 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 23 件 |
| POST | `/api/missions/:missionId/threads` | regex | token self | 13d-core-domain-routes.js:899 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 23 件 |
| POST | `/api/missions/:missionId/merge` | regex | token self | 13d-core-domain-routes.js:914 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 23 件 |
| POST | `/api/missions/:missionId/split` | regex | token self | 13d-core-domain-routes.js:923 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 23 件 |
| GET | `/api/missions/` | prefix | token-browser self | 13d-core-domain-routes.js:985 | acceptance-provenance.e2e.js, agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js 等 23 件 |

## overlay(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/overlay/precheck` | exact | token | 13c-overlay-routes.js:127 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/apply` | exact | token | 13c-overlay-routes.js:147 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| GET | `/api/overlay/status` | exact | token self | 13c-overlay-routes.js:168 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/rollback` | exact | token | 13c-overlay-routes.js:179 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |

## scheduler(6)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/scheduler/tasks` | exact | token | 13s-scheduler.js:736 | quiet-card-snooze.browser.e2e.js, rail-pocket.browser.e2e.js, scheduler-api.e2e.js 等 7 件 |
| POST | `/api/scheduler/tasks` | exact | token | 13s-scheduler.js:745 | quiet-card-snooze.browser.e2e.js, rail-pocket.browser.e2e.js, scheduler-api.e2e.js 等 7 件 |
| * | `/api/scheduler/tasks/:taskId` | regex | token | 13s-scheduler.js:764 | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler.e2e.js |
| * | `/api/scheduler/tasks/:taskId` | regex | token | 13s-scheduler.js:805 | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler.e2e.js |
| POST | `/api/scheduler/tasks/:taskId/run-now` | regex | token | 13s-scheduler.js:819 | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler.e2e.js |
| GET | `/api/scheduler/tasks/:taskId/runs` | regex | token | 13s-scheduler.js:843 | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler.e2e.js |

## session(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:210 | a11y-walkthrough.browser.e2e.js, acceptance-provenance.e2e.js, agent-deadlock-watchdog.e2e.js 等 155 件 |
| GET | `/api/sessions/search` | exact | token self | 13d-core-domain-routes.js:216 | session-search.e2e.js, steward-runner.e2e.js |
| POST | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:228 | a11y-walkthrough.browser.e2e.js, acceptance-provenance.e2e.js, agent-deadlock-watchdog.e2e.js 等 155 件 |
| POST | `/api/sessions/bulk-delete` | exact | token-browser | 13d-core-domain-routes.js:238 | session-bulk-cleanup.e2e.js |
| DELETE/GET/PATCH/POST | `/api/sessions/` | prefix | token-browser | 13d-core-domain-routes.js:245 | agent-roles.e2e.js, artifacts.e2e.js, audit-w23.e2e.js 等 79 件 |

## steer(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steer` | exact | token | 13b-api-domain-routes.js:310 | agent-steer-node.e2e.js, kimi-agent-cli.e2e.js, long-tool-liveness-steer.e2e.js 等 8 件 |
| DELETE | `/api/steer` | exact | token | 13b-api-domain-routes.js:319 | agent-steer-node.e2e.js, kimi-agent-cli.e2e.js, long-tool-liveness-steer.e2e.js 等 8 件 |

## steward(18)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steward/start` | exact | token self | 13g-steward.js:49 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-runner.e2e.js 等 5 件 |
| POST | `/api/steward/stop` | exact | token self | 13g-steward.js:59 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-preroute.e2e.js 等 5 件 |
| GET | `/api/steward/state` | exact | token self | 13g-steward.js:65 | mission-index-late-materialize.e2e.js, steward-deliverable.e2e.js, steward-events.static.e2e.js 等 8 件 |
| GET | `/api/steward/inbox` | exact | token self | 13g-steward.js:77 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-presence-gate.e2e.js 等 4 件 |
| GET | `/api/steward/preroute` | exact | token self | 13g-steward.js:88 | steward-conversation.e2e.js, steward-conversation.static.e2e.js, steward-preroute.e2e.js |
| GET | `/api/steward/memory` | exact | token | 13g-steward.js:110 | rail-pocket.browser.e2e.js, steward-memory.e2e.js, steward-settings.e2e.js 等 4 件 |
| GET | `/api/steward/memory/export` | exact | token | 13g-steward.js:116 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/edit` | exact | token | 13g-steward.js:121 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/veto` | exact | token | 13g-steward.js:127 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/restore` | exact | token | 13g-steward.js:134 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/clear` | exact | token | 13g-steward.js:141 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| GET | `/api/steward/decisions` | exact | token | 13g-steward.js:151 | steward-decisions.e2e.js, steward-settings.e2e.js, steward-settings.static.e2e.js 等 4 件 |
| GET | `/api/steward/arbiter` | exact | token self | 13h-steward-runner.js:193 | focus-rail.browser.e2e.js, net-token-replay.static.e2e.js, steward-board.e2e.js 等 9 件 |
| POST | `/api/steward/arbiter/prioritize` | exact | token self | 13h-steward-runner.js:202 | steward-board.static.e2e.js, steward-drawer.static.e2e.js, thread-arbiter.e2e.js |
| POST | `/api/steward/visit` | exact | token self | 13h-steward-runner.js:224 | steward-conversation.e2e.js, steward-conversation.static.e2e.js, steward-runner.e2e.js 等 4 件 |
| POST | `/api/steward/act` | exact | token self | 13h-steward-runner.js:236 | classic-window-live-steer.e2e.js, event-stream-client.browser.e2e.js, event-stream-pageshow.browser.e2e.js 等 17 件 |
| POST | `/api/steward/relay` | exact | token self | 13h-steward-runner.js:253 | foreign-turn-busy-guard.e2e.js, new-thread-engine-default.e2e.js, steward-board.static.e2e.js 等 7 件 |
| POST | `/api/steward/message` | exact | token self | 13h-steward-runner.js:285 | classic-window-live-steer.e2e.js, event-stream.e2e.js, foreign-turn-busy-guard.e2e.js 等 12 件 |

## 域路由委派(handleApi → 域 handler)

- 13-http-router.js:551 → `handleSessionApiRoutes`
- 13-http-router.js:553 → `handleMissionsApiRoutes`
- 13-http-router.js:902 → `handleInterventionApiRoutes`
- 13-http-router.js:1154 → `handleAgentRunApiRoutes`
- 13-http-router.js:1442 → `handleMcpApiRoutes`
- 13-http-router.js:1486 → `handleCheckpointApiRoutes`
- 13-http-router.js:1488 → `handleSteerApiRoute`
- 13-http-router.js:1490 → `handleOverlayApiRoutes`
- 13-http-router.js:1505 → `handleSchedulerApiRoutes`
