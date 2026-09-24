# 路由清册(第 103 波 103a · 机器生成)

> 由 `dev-harness/route-inventory.js` 生成,`route-inventory.static.e2e.js` 重算比对;手改无效。
> 判定点 149(精确 126 / 前缀 14 / 正则 9),ROUTE_AUTH 135 条,生成于 2026-09-24T20:06:56.452Z。

鉴权级别:`open` 低敏读 · `origin` 同源 · `token` 始终 token · `token-browser` 浏览器须 token/loopback 须同源 · `body-token` handler 自查 body token · `host-gate` 顶层 host 门(非 /api)。`self` = handler 内另有 tokenOk 纵深自查。

## agent-run(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/agent-runs` | exact | token self | 13d-core-domain-routes.js:2107 | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-node-wrapup.e2e.js 等 28 件 |
| GET | `/api/agent-runs/…/events` | prefix | token self | 13d-core-domain-routes.js:2146 | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-steer-node.e2e.js 等 17 件 |
| POST | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:2157 | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-steer-node.e2e.js 等 17 件 |
| DELETE | `/api/agent-runs/` | prefix | token | 13d-core-domain-routes.js:2215 | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-steer-node.e2e.js 等 17 件 |
| GET | `/api/agent-runs/` | prefix | token self | 13d-core-domain-routes.js:2236 | agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js, agent-steer-node.e2e.js 等 17 件 |

## checkpoint-storage(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/storage/policy` | exact | token | 13b-api-domain-routes.js:204 | config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| POST | `/api/storage/clean` | exact | token | 13b-api-domain-routes.js:216 | frontend-domains.static.e2e.js, session-storage-v2.e2e.js, storage-steward.e2e.js |
| POST | `/api/checkpoints/rollback` | exact | token | 13b-api-domain-routes.js:231 | action-feedback.static.e2e.js, artifacts.e2e.js, checkpoint-coverage.e2e.js 等 7 件 |
| POST | `/api/session/rewind` | exact | token | 13b-api-domain-routes.js:262 | action-feedback.static.e2e.js, rewind.e2e.js, steward-conversation.e2e.js 等 7 件 |

## core-inline(68)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/bootstrap` | exact | open | 13-http-router.js:348 | context-compact-v2.e2e.js, dom-smoke.e2e.js, external-code-diff.e2e.js 等 12 件 |
| GET | `/api/status` | exact | open | 13-http-router.js:354 | agent-deadlock-watchdog.e2e.js, asr-transcribe.e2e.js, asr-warmup.e2e.js 等 56 件 |
| GET | `/api/capabilities` | exact | open | 13-http-router.js:442 | capabilities.e2e.js, playbooks.e2e.js, service-match.browser.e2e.js |
| GET | `/api/playbooks` | exact | token-browser | 13-http-router.js:451 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 5 件 |
| POST | `/api/playbooks/service-match` | exact | token-browser | 13-http-router.js:458 | playbooks.e2e.js |
| POST | `/api/playbooks/draft` | exact | token | 13-http-router.js:466 | playbooks.e2e.js |
| POST | `/api/playbooks` | exact | token | 13-http-router.js:473 | auth-deny-default.e2e.js, meta-guard.e2e.js, playbooks.e2e.js 等 5 件 |
| DELETE/POST | `/api/playbooks/` | prefix | token | 13-http-router.js:482 | auth-deny-default.e2e.js, playbooks.e2e.js |
| POST | `/api/workspace/resolve` | exact | token | 13-http-router.js:491 | workspace-resolve.e2e.js |
| POST | `/api/pick-folder` | exact | token | 13-http-router.js:502 | workspace-resolve.e2e.js |
| POST | `/api/pick-file` | exact | token | 13-http-router.js:506 | overlay-update-gui.static.e2e.js |
| GET | `/api/models` | exact | open | 13-http-router.js:510 | asr-config-ui.static.e2e.js, claude-models-cache.e2e.js, context-window.e2e.js 等 5 件 |
| POST | `/api/config` | exact | token | 13-http-router.js:564 | agent-team-mode.e2e.js, asr-transcribe.e2e.js, asr-warmup.e2e.js 等 44 件 |
| GET | `/api/agent-roles` | exact | token-browser | 13-http-router.js:588 | auth-deny-default.e2e.js, config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js 等 4 件 |
| POST | `/api/agent-roles` | exact | token | 13-http-router.js:601 | auth-deny-default.e2e.js, config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js 等 4 件 |
| GET | `/api/agent-workflows` | exact | token-browser | 13-http-router.js:616 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| POST | `/api/agent-workflows` | exact | token | 13-http-router.js:621 | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 4 件 |
| DELETE/POST | `/api/agent-workflows/` | prefix | token | 13-http-router.js:628 | auth-deny-default.e2e.js |
| POST | `/api/provider/test` | exact | token | 13-http-router.js:633 | audit-w23.e2e.js, config-providers-guard.e2e.js, meta-guard.e2e.js 等 6 件 |
| GET | `/api/skills` | exact | token-browser | 13-http-router.js:674 | audit-w23.e2e.js, meta-guard.e2e.js, migration-center.e2e.js 等 5 件 |
| POST | `/api/session/skills` | exact | token-browser | 13-http-router.js:701 | claude-cmdline-guard.e2e.js, index-dedup.e2e.js, skills-registry.e2e.js 等 5 件 |
| DELETE | `/api/skills` | exact | token | 13-http-router.js:712 | audit-w23.e2e.js, meta-guard.e2e.js, migration-center.e2e.js 等 5 件 |
| POST | `/api/session/memories` | exact | token-browser | 13-http-router.js:733 | workbench-memory.e2e.js |
| GET | `/api/memory` | exact | token self | 13-http-router.js:788 | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 6 件 |
| GET | `/api/memory/item` | exact | token self | 13-http-router.js:802 | workbench-memory.e2e.js |
| POST | `/api/memory/proposal` | exact | token-browser | 13-http-router.js:815 | action-feedback.static.e2e.js, memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/decision` | exact | token-browser | 13-http-router.js:822 | memory-auto-proposal-api.e2e.js |
| POST | `/api/memory/proposal/apply` | exact | token-browser | 13-http-router.js:831 | action-feedback.static.e2e.js |
| POST | `/api/memory/draft` | exact | token-browser | 13-http-router.js:842 | workbench-memory.e2e.js |
| POST | `/api/memory/migrate` | exact | token-browser | 13-http-router.js:849 | workbench-memory.e2e.js |
| POST | `/api/memory/metadata` | exact | token-browser | 13-http-router.js:860 | — |
| POST | `/api/memory` | exact | token-browser | 13-http-router.js:878 | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 6 件 |
| GET | `/api/memory/relations` | exact | token self | 13-http-router.js:900 | agent-quality-workflow.e2e.js, workbench-memory.e2e.js |
| GET | `/api/memory/maintenance` | exact | token self | 13-http-router.js:913 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/propose` | exact | token-browser | 13-http-router.js:926 | workbench-memory.e2e.js |
| POST | `/api/memory/relations/confirm` | exact | token-browser | 13-http-router.js:935 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/relations/` | prefix | token-browser | 13-http-router.js:943 | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/` | prefix | token-browser | 13-http-router.js:952 | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 5 件 |
| POST | `/api/stop` | exact | token-browser | 13-http-router.js:962 | focus-rail.browser.e2e.js, kimi-agent-cli.e2e.js, live-full-text.static.e2e.js 等 11 件 |
| POST | `/api/provider/compact` | exact | token-browser | 13-http-router.js:986 | context-compact-v2.e2e.js, provider-compact.e2e.js, summary-entity-check.e2e.js 等 4 件 |
| POST | `/api/agent/compact` | exact | token-browser | 13-http-router.js:995 | — |
| GET | `/api/kimi/status` | exact | token-browser | 13-http-router.js:1012 | — |
| POST | `/api/todo` | exact | body-token | 13-http-router.js:1028 | event-stream.e2e.js, todo-loopback.e2e.js |
| GET/POST | `/api/mission` | exact | body-token self | 13-http-router.js:1052 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 55 件 |
| * | `/api/autonomy/grants` | exact | token self | 13-http-router.js:1188 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/grant` | exact | token self | 13-http-router.js:1195 | autonomy-grant.e2e.js |
| POST | `/api/autonomy/revoke` | exact | token self | 13-http-router.js:1223 | autonomy-grant.e2e.js |
| POST | `/api/agent-workflow/launch` | exact | body-token | 13-http-router.js:1236 | agent-deadlock-watchdog.e2e.js, agent-node-wrapup.e2e.js, agent-quality-workflow.e2e.js 等 28 件 |
| POST | `/api/agent-workflow/wait` | exact | body-token self | 13-http-router.js:1308 | — |
| POST | `/api/agent-workflow/result` | exact | body-token self | 13-http-router.js:1309 | — |
| GET | `/api/usage/summary` | exact | token self | 13-http-router.js:1312 | model-menu-no-shift.browser.e2e.js, steward-drawer.e2e.js, steward-drawer.static.e2e.js 等 9 件 |
| GET | `/api/ops/metrics` | exact | token self | 13-http-router.js:1327 | monitor-incremental.e2e.js |
| GET | `/api/checkpoints` | exact | token self | 13-http-router.js:1336 | action-feedback.static.e2e.js, artifacts.e2e.js, changes-diff.e2e.js 等 13 件 |
| POST | `/api/checkpoints/open-external` | exact | token | 13-http-router.js:1357 | external-code-diff.e2e.js |
| GET | `/api/checkpoints/diff` | exact | token self | 13-http-router.js:1428 | changes-diff.e2e.js, frontend-domains.static.e2e.js, i18n.e2e.js |
| GET | `/api/help/doc` | exact | token self | 13-http-router.js:1470 | help-viewer.e2e.js, onboarding.static.e2e.js |
| POST | `/api/open-path` | exact | token self | 13-http-router.js:1500 | copy-path-guard.static.e2e.js, help-menu.e2e.js |
| GET | `/api/logs/tail` | exact | token self | 13-http-router.js:1527 | help-menu.e2e.js |
| GET | `/api/file/preview` | exact | token self | 13-http-router.js:1560 | artifacts.e2e.js, audit-w23.e2e.js, frontend-domains.static.e2e.js 等 7 件 |
| POST | `/api/file/reveal` | exact | token | 13-http-router.js:1597 | artifacts.e2e.js, copy-path-guard.static.e2e.js, help-menu.e2e.js 等 4 件 |
| GET | `/api/audit` | exact | token self | 13-http-router.js:1628 | audit.e2e.js, auth-deny-default.e2e.js, autonomy-grant.e2e.js 等 6 件 |
| GET | `/api/storage/summary` | exact | token self | 13-http-router.js:1645 | frontend-domains.static.e2e.js, metrics-panel.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| GET | `/api/metrics` | exact | token self | 13-http-router.js:1657 | frontend-domains.static.e2e.js, metrics-panel.e2e.js |
| POST | `/api/upload` | exact | token-browser | 13-http-router.js:1689 | steward-conversation.static.e2e.js, vision-loop.e2e.js |
| GET | `/api/upload/content` | exact | token self | 13-http-router.js:1703 | vision-loop.e2e.js |
| POST | `/api/chat/stream` | exact | token-browser | 13-http-router.js:1723 | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, action-feedback.browser.e2e.js 等 145 件 |
| POST | `/api/tools/` | prefix | token | 13-http-router.js:1741 | audit-w23.e2e.js, autonomy-shell-sandbox.e2e.js, background-completion.e2e.js 等 15 件 |
| * | `/health` | exact | host-gate | 13-http-router.js:2021 | — |

## event-stream(1)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/events/stream` | exact | token-browser | 13r-event-stream.js:336 | action-feedback.browser.e2e.js, background-completion.e2e.js, boot-failure-kind.browser.e2e.js 等 14 件 |

## intervention(11)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/_test/pretender-maintenance` | exact | token | 13d-core-domain-routes.js:1645 | mission-index-scale.e2e.js |
| POST | `/api/missions/:missionId/interventions/:interventionId/decision` | regex | token | 13d-core-domain-routes.js:1659 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 24 件 |
| GET | `/api/interventions` | exact | token-browser self | 13d-core-domain-routes.js:1684 | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, event-stream-client.browser.e2e.js 等 20 件 |
| GET | `/api/interventions/` | prefix | token-browser self | 13d-core-domain-routes.js:1749 | interventions-persist.e2e.js, mission-index-scale.e2e.js, steward-presence-gate.e2e.js |
| POST | `/api/chat/answer` | exact | token-browser | 13d-core-domain-routes.js:1785 | event-stream-client.browser.e2e.js, event-stream-replay.browser.e2e.js, event-stream.e2e.js 等 15 件 |
| POST | `/api/question/heartbeat` | exact | token-browser | 13d-core-domain-routes.js:1805 | — |
| POST | `/api/question/request` | exact | body-token | 13d-core-domain-routes.js:1815 | — |
| POST | `/api/permission/request` | exact | body-token | 13d-core-domain-routes.js:1830 | — |
| POST | `/api/permission/decision` | exact | token-browser | 13d-core-domain-routes.js:1926 | autonomy-pause.e2e.js, claude-binary-live.e2e.js, intervention-mission-gate.e2e.js 等 10 件 |
| POST | `/api/plan/decision` | exact | token | 13d-core-domain-routes.js:1945 | intervention-mission-gate.e2e.js, interventions-snapshot.e2e.js, plan-mode.e2e.js 等 5 件 |
| POST | `/api/_test/intervention-cas` | exact | token self | 13d-core-domain-routes.js:1966 | interventions-cas.e2e.js, interventions-changeseq.e2e.js |

## mcp(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/mcp/import-folder` | exact | token | 13b-api-domain-routes.js:48 | mcp-config.e2e.js |
| POST | `/api/mcp/import-config/scan` | exact | token | 13b-api-domain-routes.js:96 | mcp-import-config.e2e.js |
| POST | `/api/mcp/import-config/apply` | exact | token | 13b-api-domain-routes.js:108 | action-feedback.static.e2e.js, copy-path-guard.static.e2e.js, mcp-import-config.e2e.js 等 4 件 |
| GET | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js:146 | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 5 件 |
| POST | `/api/mcp/connectors/health` | exact | token | 13b-api-domain-routes.js:156 | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js, repo-hygiene.e2e.js |
| POST | `/api/mcp/connectors/toggle` | exact | token | 13b-api-domain-routes.js:176 | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 4 件 |
| DELETE | `/api/mcp/connectors` | exact | token | 13b-api-domain-routes.js:189 | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 5 件 |

## mcp/checkpoint-storage/steer(10)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/migration/scan` | exact | token | 13b-api-domain-routes.js:22 | migration-center.browser.e2e.js, migration-center.e2e.js |
| POST | `/api/migration/apply` | exact | token | 13b-api-domain-routes.js:26 | migration-center.e2e.js |
| POST | `/api/migration/undo` | exact | token | 13b-api-domain-routes.js:30 | migration-center.e2e.js |
| POST | `/api/migration/recycle` | exact | token | 13b-api-domain-routes.js:34 | migration-center.e2e.js |
| POST | `/api/audio/transcribe` | exact | token | 13b-api-domain-routes.js:436 | asr-transcribe.e2e.js, asr-warmup.e2e.js, composer-voice-stream.browser.e2e.js 等 6 件 |
| POST | `/api/audio/stream/sessions` | exact | token | 13b-api-domain-routes.js:440 | composer-voice-stream.browser.e2e.js, composer-voice-warmup.browser.e2e.js, toolbox-discovery.e2e.js |
| POST | `/api/audio/stream/sessions/` | prefix | token | 13b-api-domain-routes.js:443 | toolbox-discovery.e2e.js |
| DELETE | `/api/audio/stream/sessions/` | prefix | token | 13b-api-domain-routes.js:446 | toolbox-discovery.e2e.js |
| POST | `/api/audio/correct` | exact | token | 13b-api-domain-routes.js:450 | asr-config-ui.static.e2e.js, composer-voice-stream.browser.e2e.js |
| POST | `/api/audio/warmup` | exact | token | 13b-api-domain-routes.js:454 | asr-warmup.e2e.js, composer-voice-warmup.browser.e2e.js |

## mission(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/missions` | exact | token-browser self | 13d-core-domain-routes.js:936 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 43 件 |
| POST | `/api/missions` | exact | token self | 13d-core-domain-routes.js:991 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 43 件 |
| PATCH/POST | `/api/missions/:missionId` | regex | token self | 13d-core-domain-routes.js:998 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/threads` | regex | token self | 13d-core-domain-routes.js:1008 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/merge` | regex | token self | 13d-core-domain-routes.js:1023 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 24 件 |
| POST | `/api/missions/:missionId/split` | regex | token self | 13d-core-domain-routes.js:1032 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 24 件 |
| GET | `/api/missions/` | prefix | token-browser self | 13d-core-domain-routes.js:1094 | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 24 件 |

## overlay(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/overlay/precheck` | exact | token | 13c-overlay-routes.js:131 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/apply` | exact | token | 13c-overlay-routes.js:151 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| GET | `/api/overlay/status` | exact | token self | 13c-overlay-routes.js:172 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |
| POST | `/api/overlay/rollback` | exact | token | 13c-overlay-routes.js:183 | overlay-update-core.e2e.js, overlay-update-gui.static.e2e.js |

## scheduler(6)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/scheduler/tasks` | exact | token | 13s-scheduler.js:759 | quiet-card-snooze.browser.e2e.js, rail-pocket.browser.e2e.js, scheduler-api.e2e.js 等 9 件 |
| POST | `/api/scheduler/tasks` | exact | token | 13s-scheduler.js:768 | quiet-card-snooze.browser.e2e.js, rail-pocket.browser.e2e.js, scheduler-api.e2e.js 等 9 件 |
| * | `/api/scheduler/tasks/:taskId` | regex | token | 13s-scheduler.js:788 | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 5 件 |
| * | `/api/scheduler/tasks/:taskId` | regex | token | 13s-scheduler.js:832 | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 5 件 |
| POST | `/api/scheduler/tasks/:taskId/run-now` | regex | token | 13s-scheduler.js:846 | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 5 件 |
| GET | `/api/scheduler/tasks/:taskId/runs` | regex | token | 13s-scheduler.js:870 | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 5 件 |

## session(6)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:210 | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, acceptance-provenance.e2e.js 等 178 件 |
| GET | `/api/sessions/search` | exact | token self | 13d-core-domain-routes.js:216 | session-search.e2e.js, steward-runner.e2e.js |
| POST | `/api/sessions` | exact | token-browser | 13d-core-domain-routes.js:228 | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, acceptance-provenance.e2e.js 等 178 件 |
| POST | `/api/sessions/bulk-delete` | exact | token-browser | 13d-core-domain-routes.js:238 | session-bulk-cleanup.e2e.js |
| GET | `/api/sessions/background-counts` | exact | token-browser self | 13d-core-domain-routes.js:252 | — |
| DELETE/GET/PATCH/POST | `/api/sessions/` | prefix | token-browser | 13d-core-domain-routes.js:297 | action-feedback.browser.e2e.js, agent-mode-v2.e2e.js, agent-roles.e2e.js 等 92 件 |

## steer(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steer` | exact | token | 13b-api-domain-routes.js:368 | agent-steer-node.e2e.js, classic-window-live-steer.e2e.js, kimi-agent-cli.e2e.js 等 9 件 |
| DELETE | `/api/steer` | exact | token | 13b-api-domain-routes.js:377 | agent-steer-node.e2e.js, classic-window-live-steer.e2e.js, kimi-agent-cli.e2e.js 等 9 件 |

## steward(18)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steward/start` | exact | token self | 13g-steward.js:49 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-runner.e2e.js 等 5 件 |
| POST | `/api/steward/stop` | exact | token self | 13g-steward.js:59 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-preroute.e2e.js 等 5 件 |
| GET | `/api/steward/state` | exact | token self | 13g-steward.js:65 | mission-index-late-materialize.e2e.js, steward-deliverable.e2e.js, steward-events.static.e2e.js 等 8 件 |
| GET | `/api/steward/inbox` | exact | token self | 13g-steward.js:77 | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-presence-gate.e2e.js 等 4 件 |
| GET | `/api/steward/preroute` | exact | token self | 13g-steward.js:88 | keyboard-walkthrough.browser.e2e.js, steward-conversation.e2e.js, steward-conversation.static.e2e.js 等 5 件 |
| GET | `/api/steward/memory` | exact | token | 13g-steward.js:111 | action-feedback.static.e2e.js, rail-pocket.browser.e2e.js, steward-memory.e2e.js 等 5 件 |
| GET | `/api/steward/memory/export` | exact | token | 13g-steward.js:117 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/edit` | exact | token | 13g-steward.js:122 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/veto` | exact | token | 13g-steward.js:128 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/restore` | exact | token | 13g-steward.js:135 | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/clear` | exact | token | 13g-steward.js:142 | action-feedback.static.e2e.js, steward-memory.e2e.js, steward-settings.static.e2e.js |
| GET | `/api/steward/decisions` | exact | token | 13g-steward.js:152 | steward-decisions.e2e.js, steward-settings.e2e.js, steward-settings.static.e2e.js 等 4 件 |
| GET | `/api/steward/arbiter` | exact | token self | 13h-steward-runner.js:193 | focus-rail.browser.e2e.js, net-token-replay.static.e2e.js, steward-board.e2e.js 等 9 件 |
| POST | `/api/steward/arbiter/prioritize` | exact | token self | 13h-steward-runner.js:202 | steward-board.static.e2e.js, steward-drawer.static.e2e.js, thread-arbiter.e2e.js |
| POST | `/api/steward/visit` | exact | token self | 13h-steward-runner.js:224 | steward-conversation.e2e.js, steward-conversation.static.e2e.js, steward-runner.e2e.js 等 4 件 |
| POST | `/api/steward/act` | exact | token self | 13h-steward-runner.js:236 | classic-window-live-steer.e2e.js, event-stream-client.browser.e2e.js, event-stream-pageshow.browser.e2e.js 等 22 件 |
| POST | `/api/steward/relay` | exact | token self | 13h-steward-runner.js:253 | foreign-turn-busy-guard.e2e.js, new-thread-engine-default.e2e.js, steward-board.static.e2e.js 等 8 件 |
| POST | `/api/steward/message` | exact | token self | 13h-steward-runner.js:285 | classic-window-live-steer.e2e.js, event-stream.e2e.js, foreign-turn-busy-guard.e2e.js 等 14 件 |

## 域路由委派(handleApi → 域 handler)

- 13-http-router.js:668 → `handleSessionApiRoutes`
- 13-http-router.js:670 → `handleMissionsApiRoutes`
- 13-http-router.js:1027 → `handleInterventionApiRoutes`
- 13-http-router.js:1335 → `handleAgentRunApiRoutes`
- 13-http-router.js:1623 → `handleMcpApiRoutes`
- 13-http-router.js:1667 → `handleCheckpointApiRoutes`
- 13-http-router.js:1669 → `handleSteerApiRoute`
- 13-http-router.js:1671 → `handleAudioApiRoutes`
- 13-http-router.js:1673 → `handleOverlayApiRoutes`
- 13-http-router.js:1688 → `handleSchedulerApiRoutes`
- 13b-api-domain-routes.js:43 → `handleMigrationApiRoutes`
