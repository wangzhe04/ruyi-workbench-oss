# P3 开发与逐包验收

**当前状态为P3已完成用户指定Mac范围最终验收。** 2026-11-07用户明确只验收Mac端，最新结论与适用环境见[最终Mac验收](final-mac-acceptance/README.md)。下列执行进度按发生时间保留。

2026-11-06 开始。用户要求按工作包推进，每包单独验收，并授权各包使用独立 agent 复核。

| 工作包 | 当前结果 | 证据 |
|---|---|---|
| P3-01 平台依赖与注册 | Mac 开发与单独本地验收完成；Mac最终验收通过，Windows排除本轮 | [交付与验收](acc-shared/README.md) |
| P3-02 文档与图表 | Mac 开发与单独本地验收完成；Mac最终验收通过，Windows排除本轮 | [交付与验收](office/README.md) |
| P3-03 浏览器运行时 | Mac 开发与单独本地验收完成；Mac最终验收通过，Windows排除本轮 | [交付与验收](browser/README.md) |
| P3-04 模板与说明 | Mac 开发与单独本地验收完成；Mac最终验收通过，Windows排除本轮 | [交付与验收](templates/README.md) |

P3 整体保持进行中。Windows 回归没有沿用 P1/P2 的阶段豁免；macOS 14、正式签名及离线发行继续按原阶段交接。未执行项目不计通过。

2026-11-07补验：已创建fork内 [草稿PR #1](https://github.com/Sonata17inD/ruyi-workbench-mac/pull/1)，首轮e844候选的Linux static和Windows release dry-run通过；Windows ACC、credential IPC与平台基线失败，待日志归因，未验收Windows。最低系统静态声明审计及仅Chromium真实测试通过，仍未在macOS14执行。当前状态与后续步骤见 [阶段交接](acceptance/HANDOFF.md)和 [部署审计](acceptance/minimum/README.md)。

2026-11-07：四个工作包的Mac本地开发、逐包独立复核与单独验收完成。P3整体仍进行中，不登记M1；Windows同候选实际回归未执行且未豁免。macOS14、签名/干净机离线发行与默认有界面浏览器用户交互保持未验证。P3-04实现 `2f45aba4`，其余实现/证据见各包记录。
