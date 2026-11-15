# 当前回归：逐项未通过与跳过

实际覆盖 594/594；进程成功 558、失败 36；3 件重试后成功。27件含内部SKIP，另14件live未执行。全套不记为通过。

原轮因创建fixture HOME时ENOSPC中断一个车道，已单独补齐50件。逐case证据取自两轮attempt，不能使用原轮selected分母冒充完整执行。

| 文件 | 分类 | 当前日志 |
|---|---|---|
| `agent-mode-v2.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/agent-mode-v2.e2e.js.attempt-2.txt) |
| `artifacts.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/artifacts.e2e.js.attempt-2.txt) |
| `audit-w23.e2e.js` | stale_inventory_or_source_contract | [原始输出](regression-attempts/audit-w23.e2e.js.attempt-2.txt) |
| `autonomy-benchmark.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/autonomy-benchmark.e2e.js.attempt-2.txt) |
| `background-completion.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/background-completion.e2e.js.attempt-2.txt) |
| `bridge-cancel-timeout.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/bridge-cancel-timeout.e2e.js.attempt-2.txt) |
| `budget-guard.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/budget-guard.e2e.js.attempt-2.txt) |
| `claude-cmdline-guard.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/claude-cmdline-guard.e2e.js.attempt-2.txt) |
| `claude-exe-resolve.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/claude-exe-resolve.e2e.js.attempt-2.txt) |
| `cli-probe-stall.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/cli-probe-stall.e2e.js.attempt-2.txt) |
| `desktop-mcp-smoke.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/desktop-mcp-smoke.e2e.js.attempt-2.txt) |
| `engine-env-runtime.e2e.js` | missing_development_rg_and_windows_fixture | [原始输出](regression-attempts/engine-env-runtime.e2e.js.attempt-2.txt) |
| `harness-friction.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/harness-friction.e2e.js.attempt-2.txt) |
| `macos-capture-host.e2e.js` | mac_gui_qualification_environment | [原始输出](regression-attempts/macos-capture-host.e2e.js.attempt-2.txt) |
| `macos-input-host.e2e.js` | mac_gui_qualification_environment | [原始输出](regression-attempts/macos-input-host.e2e.js.attempt-2.txt) |
| `mcp-import-origin.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/mcp-import-origin.e2e.js.attempt-2.txt) |
| `mission-driver.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/mission-driver.e2e.js.attempt-2.txt) |
| `overlay-update-core.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/overlay-update-core.e2e.js.attempt-2.txt) |
| `permission-plain.browser.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/permission-plain.browser.e2e.js.attempt-2.txt) |
| `privacy-gateway.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/privacy-gateway.e2e.js.attempt-2.txt) |
| `repo-hygiene.e2e.js` | other_fixture_contract | [原始输出](regression-recovery-attempts/repo-hygiene.e2e.js.attempt-2.txt) |
| `settings-wave1.browser.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-recovery-attempts/settings-wave1.browser.e2e.js.attempt-2.txt) |
| `shell-mcp-guard.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/shell-mcp-guard.e2e.js.attempt-2.txt) |
| `shell-session.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/shell-session.e2e.js.attempt-2.txt) |
| `steward-decisions.browser.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/steward-decisions.browser.e2e.js.attempt-2.txt) |
| `steward-deferred-permission.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/steward-deferred-permission.e2e.js.attempt-2.txt) |
| `steward-exempt-delegation.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-recovery-attempts/steward-exempt-delegation.e2e.js.attempt-2.txt) |
| `steward-exempt-no-swap.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/steward-exempt-no-swap.e2e.js.attempt-2.txt) |
| `steward-exempt-shell-send.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/steward-exempt-shell-send.e2e.js.attempt-2.txt) |
| `steward-guardrails.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/steward-guardrails.e2e.js.attempt-2.txt) |
| `steward-tools.e2e.js` | other_fixture_contract | [原始输出](regression-attempts/steward-tools.e2e.js.attempt-2.txt) |
| `tool-audit-fixes.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-recovery-attempts/tool-audit-fixes.e2e.js.attempt-2.txt) |
| `tool-audit-r2-meta.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/tool-audit-r2-meta.e2e.js.attempt-2.txt) |
| `tool-audit-r2-netexec.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-recovery-attempts/tool-audit-r2-netexec.e2e.js.attempt-2.txt) |
| `tool-invoke-promote.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-recovery-attempts/tool-invoke-promote.e2e.js.attempt-2.txt) |
| `vision-loop.e2e.js` | windows_fixture_or_platform_contract | [原始输出](regression-attempts/vision-loop.e2e.js.attempt-2.txt) |

两个旧dist App的截图/输入专项等待报告超时，原因未确证；不推断权限被拒绝。冻结DMG的基础启动验收不替代这些P5功能资格。

完整来源与跳过原因见 [结构化对账](regression-applicability-final.json) 和 [594件attempt汇总](regression-coverage.json)。
